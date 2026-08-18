/**
 * tests/core-ts/memory.spec.ts — MemoryStore 语义测试。
 * 对照 tests/test_smoke.py（CRUD/preference 更新）+ test_infer_server.py（recall 惰性初始化）移植。
 * 隔离：dataDir 指向临时目录，不触碰生产 Knowledge/。
 */
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore, textSimilarity, memId, forgettingFactor,
  effectiveWeight, hashEmbed, type MemoryFact,
} from "../../core-ts/src/memory/store.js";
import { retrieveFromStore, stage2LinkWalk } from "../../core-ts/src/memory/retrieve.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mem-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("辅助函数", () => {
  it("textSimilarity Jaccard 词级", () => {
    expect(textSimilarity("", "x")).toBe(0);
    expect(textSimilarity("a b c", "a b d")).toBeCloseTo(2 / 4);
    expect(textSimilarity("完全相同的文本", "完全相同的文本")).toBe(1);
  });

  it("memId 稳定且幂等（md5 8 位）", () => {
    const id = memId("测试内容");
    expect(id).toMatch(/^mem_[0-9a-f]{8}$/);
    expect(memId("测试内容")).toBe(id);
    expect(memId("其他内容")).not.toBe(id);
  });

  it("forgettingFactor：时间衰减 × 重要性加权", () => {
    expect(forgettingFactor(0, 10)).toBeCloseTo(1);
    expect(forgettingFactor(0, 5)).toBeCloseTo(0.5);
    expect(forgettingFactor(5, 5)).toBeCloseTo(0.5 * Math.exp(-1));
    expect(forgettingFactor(100, 10)).toBeCloseTo(Math.exp(-20));
  });

  it("effectiveWeight：无时间戳回退 age=0；上下文相关性加成", () => {
    const f: MemoryFact = { id: "x", content: "python script batch", category: "fact", tags: [], importance: 5, timestamp: "", last_accessed: "", links: [], backlinks: [], repeated: 0 };
    const w0 = effectiveWeight(f);
    expect(w0).toBeCloseTo(0.5);
    const wCtx = effectiveWeight(f, "python");
    expect(wCtx).toBeGreaterThan(w0);
  });

  it("hashEmbed：dim 长度 + 确定性 + [0,1) 范围", () => {
    const v1 = hashEmbed("你好", 1024);
    const v2 = hashEmbed("你好", 1024);
    expect(v1.length).toBe(1024);
    expect(v2).toEqual(v1);
    expect(v1.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(hashEmbed("", 1024).length).toBe(1024);
  });
});

describe("MemoryStore CRUD（对照 test_memory_store_crud）", () => {
  it("add_fact / add_preference / add_skill / add_lesson 统一 facts 列表", () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_mem_agent", { dataDir: dir });
    m.addFact("用户喜欢 Python");
    m.addPreference("theme", "dark");
    m.addSkill("code_review");
    m.addLesson("要使用 async", true);

    expect(m.getFacts().length).toBe(3); // fact + preference + lesson
    expect(m.getPreferences().theme).toBe("dark");
    expect(m.getSkills()).toContain("code_review");
    expect(m.getLessons().length).toBe(1);
    expect(m.getLessons(true).length).toBe(1);
  });

  it("summary 包含事实/偏好/技能/教训段", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_sum_agent", { dataDir: dir });
    m.addFact("用户喜欢 Python");
    m.addPreference("theme", "dark");
    m.addSkill("code_review");
    const summary = await m.summary();
    expect(summary).toContain("Python");
    expect(summary).toContain("dark");
    expect(summary).toContain("code_review");
  });

  it("add_preference 按 key 精确更新（对照 test_memory_preference_update）", () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_pref_agent", { dataDir: dir });
    m.addPreference("lang", "Python");
    m.addPreference("lang", "Rust");
    expect(m.getPreferences().lang).toBe("Rust");
    expect(m.getFacts().length).toBe(1); // 不新增条目
  });

  it("去重：同 category 相似度 >75% → repeated 计数不新增", () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_dedup_agent", { dataDir: dir });
    m.addFact("用户非常喜欢使用 Python 语言");
    m.addFact("用户非常喜欢使用 Python 语言"); // 完全相同
    m.addFact("用户非常喜欢使用 python 语言"); // 仅大小写差异 → 仍 >75%（小写归一）
    expect(m.getFacts().length).toBe(1);
    expect(m.getFacts()[0].repeated).toBe(2);
  });

  it("双向链接：tags 重叠自动关联 + backlinks 维护 + last_accessed 刷新（BUG-003/014）", () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_link_agent", { dataDir: dir });
    m.storeCategorized("fact", "学习 Python 语法", ["编程"]);
    const first = m.getFacts()[0];
    m.storeCategorized("fact", "Python 项目经验", ["编程"]); // tags 重叠 → 关联
    const facts = m.getFacts();
    const second = facts[1];
    expect(second.links).toContain(first.id);
    expect(facts[0].backlinks).toContain(second.id);
    expect(facts[0].last_accessed).toBeTruthy();
  });

  it("touch：behavior_archive 标签按前缀刷新 last_accessed", () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_touch_agent", { dataDir: dir });
    m.storeCategorized("fact", "归档行为: 批量重命名", ["behavior_archive"]);
    m.addFact("普通记忆");
    const before = m.getFacts()[0].last_accessed;
    const n = m.touch("归档行为");
    expect(n).toBe(1);
    expect(m.getFacts()[0].last_accessed >= before).toBe(true);
    expect(m.touch("不存在的")).toBe(0);
  });

  it("持久化 roundtrip：重新加载数据保持", () => {
    const dir = makeTmp();
    const m1 = new MemoryStore("test_persist_agent", { dataDir: dir });
    m1.addFact("持久化事实");
    m1.addPreference("k", "v");
    const m2 = new MemoryStore("test_persist_agent", { dataDir: dir });
    expect(m2.getFacts().length).toBe(2);
    expect(m2.getPreferences().k).toBe("v");
  });

  it("toDict 深拷贝防篡改（N11-P2-9）", () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_copy_agent", { dataDir: dir });
    m.addFact("不可变");
    const d = m.toDict();
    d.facts[0].content = "被篡改";
    expect(m.getFacts()[0].content).toBe("不可变");
  });

  it("非法 agent_id 抛错（A-112 防路径遍历）", () => {
    expect(() => new MemoryStore("../../etc/passwd", { dataDir: makeTmp() })).toThrow();
    expect(() => new MemoryStore("", { dataDir: makeTmp() })).not.toThrow(); // 空串 = global 语义
  });
});

describe("嵌入降级（对照 _embed 哈希回退）", () => {
  it("embed 注入失败 → 哈希占位", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_embed_fail", {
      dataDir: dir,
      embed: { embed: async () => { throw new Error("sidecar 不可用"); } },
    });
    const vec = await m.embedOrHash("测试");
    expect(vec.length).toBe(1024);
  });

  it("embed 注入成功 → 使用真实向量", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("test_embed_ok", {
      dataDir: dir,
      embed: { embed: async (t: string) => [0.1, 0.2, t.length] },
    });
    const vec = await m.embedOrHash("abc");
    expect(vec).toEqual([0.1, 0.2, 3]);
  });
});

describe("LanceDB 接口（对照 A-027 语义）", () => {
  it("未启用时不初始化（对照 test_recall_disabled_returns_empty_without_init）", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("t2", { dataDir: dir, lancedbEnabled: false });
    expect(await m.recall("q")).toEqual([]);
    expect(m.getFacts().length).toBe(0);
  });

  it("启用时惰性初始化 + store/recall 全链路（真实 LanceDB，对齐 A-027 修复语义）", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("t1", {
      dataDir: dir,
      lancedbEnabled: true,
      lancedbUri: join(dir, "lance"),
      embed: { embed: async (t: string) => hashEmbed(t) }, // 1024 维（BGE-M3 生产维度）
    });
    await m.store("fact", "用户喜欢批处理脚本", "batch");
    await m.store("fact", "上次用了 PowerShell 循环", "tooling");
    const r = await m.recall("批处理脚本", 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].content).toContain("批处理");
  }, 30000);
});

describe("Node 侧四阶段检索（对照 sidecar/retrieve_api.py 逐行）", () => {
  function buildStore(dir: string, hook: (m: MemoryStore) => void): MemoryStore {
    const m = new MemoryStore("retr_agent", { dataDir: dir });
    hook(m);
    return m;
  }

  it("全链路：种子 → 链接遍历 → 标签过滤 → 权重排序（stages 计数）", async () => {
    const dir = makeTmp();
    const m = buildStore(dir, (s) => {
      s.storeCategorized("fact", "用户喜欢批处理脚本", ["batch"]);
      s.storeCategorized("fact", "批量文件处理经验", ["batch"]);
      s.addFact("Python 语法知识");
      s.addLesson("批处理要先测试再跑", true);
    });
    const r = await retrieveFromStore(m, { query: "批处理脚本", topK: 10, maxHops: 2 });
    expect(r.stages.seeds).toBeGreaterThan(0);
    expect(r.stages.ranked).toBeGreaterThan(0);
    expect(r.items.every((i) => i.content)).toBe(true);
    expect(r.items[0].weight).toBeGreaterThan(0);
  });

  it("标签过滤：仅保留与过滤集有交集条目", async () => {
    const dir = makeTmp();
    const m = buildStore(dir, (s) => {
      s.storeCategorized("fact", "批处理知识", ["batch"]);
      s.storeCategorized("fact", "无关记忆", ["other"]);
    });
    const r = await retrieveFromStore(m, { query: "批处理", tags: ["batch"] });
    expect(r.items.every((i) => i.tags.includes("batch"))).toBe(true);
    expect(r.stages.tag_filtered).toBeGreaterThan(0);
  });

  it("链接遍历 BFS：种子 → links/backlinks 展开去重", async () => {
    const dir = makeTmp();
    const m = new MemoryStore("bfs_agent", { dataDir: dir });
    m.storeCategorized("fact", "核心知识 A", ["t"]);
    const a = m.getFacts()[0];
    m.storeCategorized("fact", "关联知识 B", ["t"]); // 自动关联到 A（backlinks）
    const facts = m.getFacts();
    const b = facts[1];
    const seeds = [facts[0]];
    const walked = await stage2LinkWalk(m, seeds, 2);
    expect(walked.map((f) => f.id)).toContain(b.id);
    expect(walked.map((f) => f.id)).toContain(a.id);
  });
});