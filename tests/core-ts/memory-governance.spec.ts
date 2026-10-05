/**
 * A-1139 §3.2 配套两条的回归测试（TS 侧，与 Python `tests/test_memory_write_governance.py` 对称）。
 *
 * 覆盖：
 *   1. 跨 agent 全局去重 —— 同一内容已在别的 agent 记忆里 → 本地不新增内容（只留指针）
 *   2. 单 agent 写入上限 —— 达阈值后新条目只能「合并」或「替换」（软归档）进入
 *   3. 派生索引 —— `.global/index.json` 删掉/改坏都能从各 agent 的 memory.json 重建
 *   4. 降级 —— 索引坏了/关了都不影响写入
 *
 * ⚠️ 断言是**真的会咬**：把 `crossAgentScan` 调用删掉、把上限判断改成永不触发、
 * 或把软归档换成 `filter` 掉不入 archived，对应用例立刻红。
 */
import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore, resolveMemoryPaths, effectiveValue,
  getGlobalIndex, entryKey, readMemoryConfig,
} from "../../core-ts/src/memory/store.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memgov-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 在临时根目录写一份 slime.toml（配置走真实文件读取路径，不是直接注字段）。 */
function makeRoot(toml: string): string {
  const d = makeTmp();
  writeFileSync(join(d, "slime.toml"), toml, "utf8");
  return d;
}

/** 语义互不重叠的条目 —— 否则会被「合并档」正当吸收，测不到上限。 */
const DISJOINT = [
  "红烧肉需要小火慢炖两小时", "数据库连接池建议控制在 CPU 核数两倍",
  "今天的天气预报说有雷阵雨", "光合作用把光能转成化学能",
  "长城的砖块尺寸各地并不统一", "股票分红除权日会调整开盘参考价",
  "量子纠缠不能用来超光速通信", "核糖体负责把信使翻译成蛋白质",
  "钢琴调律一般按标准音高定音", "驼峰航线当年飞越喜马拉雅山脉",
  "青铜器的锡铅配比影响硬度", "潮汐锁定让月球始终同一面朝地球",
];

describe("跨 agent 全局去重（§3.2 配套第 1 条）", () => {
  it("第二个 agent 写入同一内容 → 本地不新增，只留可查回的指针", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\n");
    const a = new MemoryStore("gx_ts_a", { dataDir: root });
    const b = new MemoryStore("gx_ts_b", { dataDir: root });
    a.addFact("用户喜欢用 Python 写脚本");
    expect(a.getFacts().length).toBe(1);

    b.addFact("用户喜欢用 Python 写脚本");
    expect(b.getFacts().length).toBe(0);
    const refs = b.getSharedRefs();
    expect(refs.length).toBe(1);
    expect(refs[0].from_agent).toBe("gx_ts_a");
    expect(refs[0].preview).toBe("用户喜欢用 Python 写脚本");
    expect(Number(refs[0].score)).toBeGreaterThan(0.75);
  });

  it("重复命中累加 hit_count，不追加新指针；且不改动别人的记忆", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\n");
    const a = new MemoryStore("gx_ts_a", { dataDir: root });
    const b = new MemoryStore("gx_ts_b", { dataDir: root });
    a.addFact("用户喜欢用 Python 写脚本");
    for (let i = 0; i < 5; i++) b.addFact("用户喜欢用 Python 写脚本");
    expect(b.getFacts().length).toBe(0);
    expect(b.getSharedRefs().length).toBe(1);
    expect(b.getSharedRefs()[0].hit_count).toBe(5);
    expect(a.getFacts().length).toBe(1);
  });

  it("无关内容不受影响（不误判为跨 agent 重复）", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\n");
    const a = new MemoryStore("gx_ts_a", { dataDir: root });
    const b = new MemoryStore("gx_ts_b", { dataDir: root });
    a.addFact("用户喜欢用 Python 写脚本");
    b.addFact("数据库连接池的配置要点");
    expect(b.getFacts().length).toBe(1);
  });

  it("被去重掉的条目仍能跨 agent 召回（去重 ≠ 删除）", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\n");
    const a = new MemoryStore("gx_ts_a", { dataDir: root });
    const b = new MemoryStore("gx_ts_b", { dataDir: root });
    a.addFact("项目约定 用 TypeScript 写测试");
    b.addFact("项目约定 用 TypeScript 写测试");
    const hits = b.globalRecall("TypeScript 写测试", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].agent).toBe("gx_ts_a");
    expect(hits[0].content).toContain("TypeScript");
  });

  it("全局索引是派生件：删掉/改坏都能从 memory.json 重建", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\n");
    const a = new MemoryStore("gx_ts_a", { dataDir: root });
    a.addFact("可重建的事实条目");
    const idxPath = join(root, ".global", "index.json");
    expect(existsSync(idxPath)).toBe(true);

    rmSync(idxPath);
    let idx = getGlobalIndex(root, 0.001);
    idx.rebuild();
    expect(idx.lookup("可重建的事实条目")).not.toBeNull();

    writeFileSync(idxPath, "{ 这不是合法 JSON", "utf8");
    idx = getGlobalIndex(root, 0.001);
    idx.rebuild();
    expect(idx.lookup("可重建的事实条目")).not.toBeNull();
  });

  it("索引里只有摘要，没有 facts 的权威结构", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\n");
    const a = new MemoryStore("gx_ts_a", { dataDir: root });
    a.addFact("某条事实");
    const raw = JSON.parse(readFileSync(join(root, ".global", "index.json"), "utf8")) as {
      derived?: boolean; note?: string; entries: Record<string, Record<string, unknown>>;
    };
    expect(raw.derived).toBe(true);
    expect(raw.note).toContain("memory.json");
    const entry = Object.values(raw.entries)[0];
    expect(Object.keys(entry).sort()).toEqual(
      ["agent", "category", "content", "hits", "importance", "mem_id", "timestamp"]);
    expect(entry).not.toHaveProperty("links");
    expect(entry).not.toHaveProperty("backlinks");
  });

  it("Python / TS 两侧共用同一个索引文件（同判据单源）", () => {
    // 索引键必须是内容 md5 前 12 位 —— 与 core/memory_global.py::_entry_key 完全一致，
    // 否则两边各建一套索引，跨语言去重永不收敛。
    expect(entryKey("用户喜欢用 Python 写脚本")).toMatch(/^[0-9a-f]{12}$/);
    expect(entryKey("用户喜欢用 Python 写脚本")).toBe(entryKey("用户喜欢用 Python 写脚本"));
  });
});

describe("单 agent 写入上限（§3.2 配套第 2 条）", () => {
  it("活跃条目永不突破上限", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 5\n");
    const m = new MemoryStore("cap_ts", { dataDir: root });
    for (const text of DISJOINT) m.addFact(text);
    expect(m.getFacts().length).toBe(3);
    expect(m.getFacts()[2].content).toBe(DISJOINT[DISJOINT.length - 1]);
  });

  it("被挤掉的条目进 archived（软归档），盘上也能查回 —— 不是物理删除", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 5\n");
    const m = new MemoryStore("cap_ts", { dataDir: root });
    for (const text of DISJOINT.slice(0, 4)) m.addFact(text);
    const archived = m.getArchived();
    expect(archived.length).toBe(1);
    expect(archived[0].content).toBe(DISJOINT[0]);
    expect(archived[0].status).toBe("archived:fact");
    expect(archived[0].archived_reason).toBeTruthy();
    expect(archived[0].archived_at).toBeTruthy();

    const raw = JSON.parse(readFileSync(resolveMemoryPaths("cap_ts", { dataDir: root }).memoryJson, "utf8")) as {
      archived: Array<{ content: string }>;
    };
    expect(raw.archived.map((x) => x.content)).toContain(DISJOINT[0]);
  });

  it("先挤掉**价值最低**的条目（价值 = 权重 × 置信度 × 重复次数）", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 5\n");
    const m = new MemoryStore("cap_ts", { dataDir: root });
    m.addFact(DISJOINT[0], 1);
    m.addFact(DISJOINT[1], 5);
    m.addFact(DISJOINT[2], 10);
    m.addFact(DISJOINT[3], 9);
    expect(m.getFacts().map((f) => f.content)).toEqual([DISJOINT[1], DISJOINT[2], DISJOINT[3]]);
    expect(m.getArchived().map((f) => f.content)).toEqual([DISJOINT[0]]);
  });

  it("effectiveValue：重复命中与置信度都会抬高条目价值（决定谁被挤掉）", () => {
    const base = { id: "x", content: "c", category: "fact", tags: [], importance: 5, timestamp: "", last_accessed: "", links: [], backlinks: [], repeated: 0 };
    const plain = effectiveValue(base as never);
    expect(effectiveValue({ ...base, repeated: 3 } as never)).toBeCloseTo(plain * 4);
    expect(effectiveValue({ ...base, confidence: 0.5 } as never)).toBeCloseTo(plain * 0.5);
  });

  it("合并档：相似但不达去重线 → 并进旧条目（原文留痕），活跃集不增长", () => {
    const root = makeRoot("[memory]\nmax_entries = 50\n");
    const m = new MemoryStore("merge_ts", { dataDir: root });
    m.addLesson("用 file_read 处理路径参数时报错，原因是相对路径基准不对", true);
    const before = m.getFacts().length;
    m.addLesson("用 file_read 处理路径参数时报错，原因是相对路径的基准目录不对", true);
    expect(m.getFacts().length).toBe(before);
    const merged = m.getFacts()[0];
    expect(merged.merged_from).toBe(1);
    expect(merged.merge_trail?.[0].content).toContain("基准目录不对");
    expect(merged.content).toContain("补充:");
  });

  it("精确重复仍在去重档被吸收（不触发归档）", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 5\n");
    const m = new MemoryStore("cap_ts", { dataDir: root });
    m.addFact("同一条内容");
    m.addFact("同一条内容");
    expect(m.getFacts().length).toBe(1);
    expect(m.getFacts()[0].repeated).toBe(1);
    expect(m.getArchived().length).toBe(0);
  });

  it("归档区有上限（不是把无限增长挪个地方）", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 5\n");
    const m = new MemoryStore("cap_ts", { dataDir: root });
    for (const text of DISJOINT) m.addFact(text);
    for (let i = DISJOINT.length; i < 30; i++) m.addFact(`probe${i} ref${i * 7919}`);
    expect(m.getFacts().length).toBe(3);
    expect(m.getArchived().length).toBeLessThanOrEqual(5);
  });
});

describe("归档区永不回收（维护者裁决 / 设计 §5.2）", () => {
  /**
   * 语义钻死的回归测试：`archive_limit = 0` = **永不回收**（不是「立即删光」）。
   * 归档区是全链路唯一一处物理删除，默认必须关掉它 —— 只有显式正整数才是容量上限。
   *
   * ⚠️ 断言真的会咬：把 `spillToArchive` 的 `limit > 0` 判断去掉、把 0 回落到
   * maxEntries、或把 readMemoryConfig 的 `num >= 0` 改回 `num > 0`（0 被当非法值），
   * 下面的「一条都不许丢」立刻红。
   */
  const SPILL_SEEDS = [...DISJOINT, ...Array.from({ length: 40 }, (_, i) => `probe${i} ref${i * 7919}`)];

  /** 超限写入 n 条（语义互不重叠 → 每条都真的写进去，每次溢出一条归档）。 */
  function overflow(root: string, agent: string, seeds: string[]): MemoryStore {
    const m = new MemoryStore(agent, { dataDir: root });
    for (const s of seeds) m.addFact(s);
    return m;
  }

  it("默认（不写 archive_limit）= 永不回收：反复超限写入，归档区一条都不丢", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\n");
    expect(readMemoryConfig(root).archiveLimit, "代码默认值必须就是「永不回收」").toBe(0);

    const m = overflow(root, "keep_ts", SPILL_SEEDS);
    expect(m.getFacts().length).toBe(3);
    const archived = m.getArchived();
    expect(archived.length, "归档区丢了条目（= 物理删除回归）").toBe(SPILL_SEEDS.length - 3);

    const kept = new Set([...m.getFacts(), ...archived].map((f) => f.content));
    for (const s of SPILL_SEEDS) expect(kept.has(s), `条目 ${s} 既不在活跃集也不在归档区`).toBe(true);

    // 盘上同样一条不少（归档不是纯内存假象）
    const raw = JSON.parse(readFileSync(resolveMemoryPaths("keep_ts", { dataDir: root }).memoryJson, "utf8")) as {
      archived: Array<{ content: string }>;
    };
    expect(raw.archived.length).toBe(SPILL_SEEDS.length - 3);
  });

  it("显式 archive_limit = 0 同样 = 永不回收（0 不是非法值、也不是「立即删光」）", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 0\n");
    expect(readMemoryConfig(root).archiveLimit).toBe(0);

    const m = overflow(root, "zero_ts", SPILL_SEEDS);
    expect(m.getArchived().length).toBe(SPILL_SEEDS.length - 3);
    expect(m.getArchived()[0].content).toBe(SPILL_SEEDS[0]);
  });

  it("配置写坏（负数 / 非数字）往「不删」方向兜底 —— 绝不因配置错误而物理删除", () => {
    // `-5` / `abc` 都是「语义非法」：`Number("-5")` 合法但被 `num >= 0` 挡掉，
    // `Number("abc")` = NaN 也被挡掉 —— 两条路径都必须落回 0（永不回收），
    // 而不是悄悄回落到某个「有上限」的旧默认值。
    for (const bad of ["-5", "abc"]) {
      const root = makeRoot(`[memory]\nmax_entries = 3\narchive_limit = ${bad}\n`);
      expect(readMemoryConfig(root).archiveLimit, `archive_limit=${bad} 时默认值应回落到 0`).toBe(0);
      const m = overflow(root, "bad_ts", SPILL_SEEDS.slice(0, 10));
      expect(m.getArchived().length).toBe(7);
    }
  });

  it("显式正整数才算容量上限（老行为不变：超出回收最旧的）", () => {
    const root = makeRoot("[memory]\nmax_entries = 3\narchive_limit = 6\n");
    expect(readMemoryConfig(root).archiveLimit).toBe(6);
    const m = overflow(root, "cap2_ts", SPILL_SEEDS.slice(0, 12));
    expect(m.getArchived().length).toBe(6);
    // 回收的是**最旧的**：最早被挤掉的没了，最新被挤掉的必须还在
    const kept = m.getArchived().map((f) => f.content);
    expect(kept).not.toContain(SPILL_SEEDS[0]);
    expect(kept).toContain(SPILL_SEEDS[8]);
  });
});

describe("配置入口与降级（两侧同源）", () => {
  it("阈值/上限来自 slime.toml [memory]（可配置，不是写死的魔法数字）", () => {
    const root = makeRoot("[memory]\nmax_entries = 7\narchive_limit = 9\ndedup_threshold = 0.8\nmerge_threshold = 0.7\ncross_agent_dedup = false\n");
    const cfg = readMemoryConfig(root);
    expect(cfg.maxEntries).toBe(7);
    expect(cfg.archiveLimit).toBe(9);
    expect(cfg.dedupThreshold).toBe(0.8);
    expect(cfg.crossAgentDedup).toBe(false);
    // 合并线必须落在去重线之下
    expect(cfg.mergeThreshold).toBeLessThanOrEqual(cfg.dedupThreshold - 0.01);
  });

  it("cross_agent_dedup=false → 完全退回 per-agent 行为", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = false\nmax_entries = 50\n");
    const a = new MemoryStore("off_ts_a", { dataDir: root });
    const b = new MemoryStore("off_ts_b", { dataDir: root });
    a.addFact("同一条内容");
    b.addFact("同一条内容");
    expect(a.getFacts().length).toBe(1);
    expect(b.getFacts().length).toBe(1);
    expect(b.getSharedRefs().length).toBe(0);
  });

  it("索引损坏 / 索引目录不可用 → 写入照常成功", () => {
    const root = makeRoot("[memory]\ncross_agent_dedup = true\nmax_entries = 50\n");
    // 目录位置被一个**文件**占住：索引无法创建/落盘
    writeFileSync(join(root, ".global"), "我不是目录", "utf8");
    const m = new MemoryStore("blocked_ts", { dataDir: root });
    m.addFact("索引不可用也要能写进去");
    expect(m.getFacts().length).toBe(1);
  });

  it("globalIndex=false 时单 agent 去重仍然生效", () => {
    const root = makeRoot("[memory]\nmax_entries = 50\n");
    const m = new MemoryStore("off_mode_ts", { dataDir: root, globalIndex: false });
    m.addFact("用户非常喜欢使用 Python 语言");
    m.addFact("用户非常喜欢使用 python 语言");
    expect(m.getFacts().length).toBe(1);
    expect(m.getFacts()[0].repeated).toBe(1);
  });

  it("TS 的 token 化与 Python 同判据（中文 unigram+bigram，不是空白分词）", () => {
    const root = makeRoot("[memory]\nmax_entries = 50\n");
    const m = new MemoryStore("tok_ts", { dataDir: root });
    // 旧实现（纯空白分词）下这两条中文的 Jaccard 只有 0.2 → 去重空转。
    m.addFact("用户喜欢用 Python 写脚本");
    m.addFact("用户喜欢用 Python 写脚本。");
    expect(m.getFacts().length).toBe(1);
    expect(m.getFacts()[0].repeated).toBe(1);
  });
});
