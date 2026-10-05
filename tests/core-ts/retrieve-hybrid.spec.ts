import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retrieveFromStore } from "../../core-ts/src/memory/retrieve.js";
import { MemoryStore } from "../../core-ts/src/memory/store.js";
import { linkTraversalRule, LINK_TRAVERSAL_RULES } from "../../core-ts/src/memory/similarity.js";
import { fulltextSearch, rrfFuse, RRF_K } from "../../core-ts/src/memory/fulltext.js";

const tmpDirs: string[] = [];
function makeStore(agentId: string, seed: (s: MemoryStore) => void): MemoryStore {
  const d = mkdtempSync(join(tmpdir(), "slime-hyb-"));
  tmpDirs.push(d);
  const store = new MemoryStore(agentId, { dataDir: d });
  seed(store);
  return store;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const SEEDS = [
  "Zephyr 项目的部署流水线在周一完成了首轮压测",
  "Zephyr 项目的灰度开关昨天被运维手动关闭",
  "Zephyr 项目的日志采集链路换了新的采样频率",
  "Zephyr 项目的缓存穿透报警连着响了三个夜晚",
  "Zephyr 项目的依赖镜像仓库迁移到了新机房",
  "Zephyr 项目的回滚脚本删掉了手工确认步骤",
  "Zephyr 项目的鉴权令牌轮换周期改成十四天",
  "Zephyr 项目的灰度名单剔除了三个内网账号",
  "Zephyr 项目的构建产物体积瘦了十二兆",
  "Zephyr 项目的告警阈值上调后误报明显减少",
  "Zephyr 项目的只读副本延迟稳定在三秒以内",
  "Zephyr 项目的连接池上限调低到两百",
];
const ORPHAN = "宇航站的咖啡机滤芯需要更换";

function linkedStore(agentId: string): MemoryStore {
  return makeStore(agentId, (s) => {
    for (const c of SEEDS) s.storeCategorized("fact", c, ["zephyr"], 5);
    s.storeCategorized("fact", ORPHAN, ["zephyr"], 5);
  });
}

const MULTIHOP = "和 Zephyr 相关的一切部署记录";
const PLAIN = "Zephyr 的部署流水线";

describe("§4.1-P2 多跳判据（纯规则，可判定，不依赖 LLM）", () => {
  it("多跳查询命中具名规则；普通查询一律不命中（默认关闭遍历）", () => {
    expect(linkTraversalRule(MULTIHOP)).toBe("relation_exhaustive");
    expect(linkTraversalRule(PLAIN)).toBeNull();
  });

  it("三条规则各自可独立触发，且空/非字符串查询安全返回 null", () => {
    expect(linkTraversalRule("多跳关联链路是什么")).toBe("explicit_multihop");
    expect(linkTraversalRule("everything connected to the deployment")).toBe("exhaustive_related_en");
    expect(linkTraversalRule("")).toBeNull();
    expect(linkTraversalRule("   ")).toBeNull();
    expect(linkTraversalRule(undefined as unknown as string)).toBeNull();
  });

  it("规则表非空且每条都是可测的正则（判据本身有测试面）", () => {
    expect(LINK_TRAVERSAL_RULES.length).toBeGreaterThan(0);
    for (const [, pattern] of LINK_TRAVERSAL_RULES) expect(pattern).toBeInstanceOf(RegExp);
  });

  it("单跳/近义但不含穷举或链路词的查询不得误触发", () => {
    for (const q of ["Zephyr 部署", "用户喜欢什么颜色", "上次的批处理脚本在哪", "记住我的偏好"]) {
      expect(linkTraversalRule(q)).toBeNull();
    }
  });
});

describe("§4.1-P2 BFS 遍历降级为可插拔层（默认不跑）", () => {
  it("普通查询：link_walked=0 且 link_rule=null（图层完全未启用）", async () => {
    const store = linkedStore("p2_off_agent");
    const res = await retrieveFromStore(store, { query: PLAIN, topK: 10 });
    expect(res.stages.link_rule).toBeNull();
    expect(res.stages.link_walked).toBe(0);
    expect(res.stages.graph_walked).toBe(0);
  });

  it("多跳查询：link_rule=relation_exhaustive 且 link_walked>0（图层启用）", async () => {
    const store = linkedStore("p2_on_agent");
    const res = await retrieveFromStore(store, { query: MULTIHOP, topK: 10 });
    expect(res.stages.link_rule).toBe("relation_exhaustive");
    expect(res.stages.link_walked).toBeGreaterThan(0);
  });

  it("显式开关可强制开/关，覆盖规则判据（真·可插拔）", async () => {
    const store = linkedStore("p2_override_agent");
    const forcedOff = await retrieveFromStore(store, { query: MULTIHOP, topK: 10, linkTraversal: false });
    expect(forcedOff.stages.link_walked).toBe(0);
    expect(forcedOff.stages.link_rule).toBeNull();

    const forcedOn = await retrieveFromStore(store, { query: PLAIN, topK: 10, linkTraversal: true });
    expect(forcedOn.stages.link_walked).toBeGreaterThan(0);
  });

  it("关闭遍历时结果条数不因图遍历变多（降级是真降级，不是隐藏）", async () => {
    const store = linkedStore("p2_shape_agent");
    const off = await retrieveFromStore(store, { query: PLAIN, topK: 10 });
    const on = await retrieveFromStore(store, { query: PLAIN, topK: 10, linkTraversal: true });
    expect(off.items.length).toBe(on.items.length);
  });
});

describe("§4.1-P1 summary() 图关联行不是死分支", () => {
  it("多跳查询下 summary() 真的会输出 [category@关联] 行", async () => {
    const store = linkedStore("p1_live_agent");
    const text = await store.summary(MULTIHOP, 10);
    const lines = text.split("\n").filter((l) => l.includes("@关联]"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(line).toMatch(/^- \[[^\]]+@关联\] 时间: \S+ · 来源: \S+ · .+$/);
  });

  it("普通查询下不输出关联行（图层默认关闭，两侧一致）", async () => {
    const store = linkedStore("p1_quiet_agent");
    const text = await store.summary(PLAIN, 10);
    expect(text).not.toContain("@关联]");
    expect(text).toContain("## 已知事实");
  });

  it("关联行必须带真实事实字段（时间/来源），不是占位空行", async () => {
    const store = linkedStore("p1_fields_agent");
    const text = await store.summary(MULTIHOP, 10);
    const lines = text.split("\n").filter((l) => l.includes("@关联]"));
    const known = new Set(store.getFacts().map((f) => f.content));
    for (const line of lines) {
      const body = line.split(" · ").slice(2).join(" · ");
      expect(known.has(body)).toBe(true);
    }
  });
});

describe("§4.1-P3 默认链路 = 向量 + 全文混合", () => {
  it("BM25 全文通道在默认检索链路里真实参与种子生成（LanceDB 缺席时由全文兜底）", async () => {
    const store = makeStore("p3_fts_agent", (s) => {
      s.storeCategorized("fact", "部署流水线的压测报告已归档", ["ops"], 5);
      s.storeCategorized("fact", "宇航站的咖啡机滤芯需要更换", ["ship"], 5);
    });
    const res = await retrieveFromStore(store, { query: "压测报告", topK: 5 });
    expect(res.items.map((i) => i.content)).toContain("部署流水线的压测报告已归档");
    expect(res.items.map((i) => i.content)).not.toContain("宇航站的咖啡机滤芯需要更换");
  });

  it("fulltextSearch 按 BM25 排序且只返回真正命中文档", () => {
    const docs = ["压测报告压测报告归档", "无关内容", "压测"];
    const hits = fulltextSearch("压测报告", docs, 5);
    expect(hits.map((h) => docs[h.index])).toEqual(["压测报告压测报告归档", "压测"]);
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  it("fulltextSearch 对空查询/空语料/非正 topK 一律返回空", () => {
    expect(fulltextSearch("", ["a"], 5)).toEqual([]);
    expect(fulltextSearch("q", [], 5)).toEqual([]);
    expect(fulltextSearch("q", ["a"], 0)).toEqual([]);
  });

  it("rrfFuse 按名次倒数加权融合两路，且各路共同命中的条目排在单路命中之前", () => {
    const fused = rrfFuse([["a", "b"], ["b", "c"]]);
    expect(fused.map((f) => f.key)).toEqual(["b", "a", "c"]);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
  });

  it("rrfFuse 忽略空 key，空输入返回空", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([["", "a"], []]).map((f) => f.key)).toEqual(["a"]);
  });
});