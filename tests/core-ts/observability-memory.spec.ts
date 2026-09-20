/**
 * observability-memory.spec.ts — D 可观测 trace 骨架 + C 记忆三层/实体图谱 骨架回归 + 存储层集成。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrace, beginSpan, endSpan, emitEvent, attachEval, summarize, traceToJSON, parseTrace } from "../../core-ts/src/observability/trace.js";
import { classifyLayer, createEntry, migrationTarget, pruneExpired, type MemoryEntry } from "../../core-ts/src/memory/three_layer.js";
import { createGraph, upsertEntity, addEdge, linkEntities, neighbors, byType, removeEntity, parseGraph, resolveEntityIds } from "../../core-ts/src/memory/graph.js";
import { MemoryStore } from "../../core-ts/src/memory/store.js";
import { retrieveFromStore, stageGraphRecall, stageLayerFilter } from "../../core-ts/src/memory/retrieve.js";

describe("trace（D：全链路可观测骨架）", () => {
  it("生命周期：route → tool_call 嵌套 → tool_result → done，summarize 统计正确", () => {
    let t = createTrace({ sessionId: "s1" });
    const { trace: t2, spanId } = beginSpan(t, { name: "route:engine", kind: "route_select" });
    const { trace: t3, spanId: toolId } = beginSpan(t2, { name: "tool:file_read", kind: "tool_call", parentId: spanId, data: { path: "a.py" } });
    const t4 = endSpan(t3, toolId, { ok: true });
    const t5 = attachEval(emitEvent(t4, "done", "turn:done"), "completion", true);
    const s = summarize(t5);
    expect(s.total).toBe(4);
    expect(s.ended).toBe(3); // tool + (attach)eval + done 均闭合；route span 尚未 endSpan
    expect(s.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.failed).toBe(false);
  });

  it("失败归因：eval failed 或 block 命中 → summarize.failed=true", () => {
    const t = attachEval(createTrace(), "tool", false, "幻觉疑似");
    expect(summarize(t).failed).toBe(true);
  });

  it("序列化往返", () => {
    const t1 = emitEvent(createTrace({ id: "tr-1" }), "reply_chunk", "chunk1");
    const back = parseTrace(traceToJSON(t1));
    expect(back!.id).toBe("tr-1");
    expect(back!.spans[0].kind).toBe("reply_chunk");
    expect(parseTrace("bad")).toBeNull();
  });
});

describe("三层记忆（C：TTL/迁移调度）", () => {
  const now = 1_700_000_000_000;
  it("来源分类：preference/fact → semantic；event → episodic；plan → working", () => {
    expect(classifyLayer({ source: "preference" })).toBe("semantic");
    expect(classifyLayer({ source: "fact" })).toBe("semantic");
    expect(classifyLayer({ source: "event" })).toBe("episodic");
    expect(classifyLayer({ source: "conversation" })).toBe("episodic");
    expect(classifyLayer({ source: "plan" })).toBe("working");
  });

  it("迁移：working 会话收尾 → episodic；episodic 30 天 + 高访问 → semantic", () => {
    const w = createEntry({ content: "临时上下文", source: "plan", createdAt: now }, "w1");
    expect(migrationTarget(w, now, { consolidateNow: true })).toEqual({ action: "down", target: "episodic" });
    const e = createEntry({ content: "30天前事件", source: "event", createdAt: now - 31 * 86400_000 }, "e1");
    const active: MemoryEntry = { ...e, accessCount: 3 };
    expect(migrationTarget(active, now, { minAccess: 2 })).toEqual({ action: "down", target: "semantic" });
    const cold = createEntry({ content: "冷事件", source: "event", createdAt: now - 31 * 86400_000 }, "e2");
    expect(migrationTarget(cold, now)).toEqual({ action: "prune" });
    const sem = createEntry({ content: "永久知识", source: "fact", createdAt: 0 }, "s1");
    expect(migrationTarget(sem, now)).toEqual({ action: "keep" });
  });

  it("pruneExpired：episodic 过期剔除、semantic/working 保留", () => {
    const old = createEntry({ content: "过期情景", source: "event", createdAt: now - 40 * 86400_000 }, "o1");
    const sem = createEntry({ content: "永久", source: "fact", createdAt: 0 }, "s1");
    const wk = createEntry({ content: "工作", source: "plan", createdAt: now }, "w1");
    const kept = pruneExpired([old, sem, wk], now);
    expect(kept.map((e) => e.id).sort()).toEqual(["s1", "w1"]);
  });
});

describe("实体图谱（C：graph CRUD）", () => {
  it("实体 + 双向边 + 邻居召回", () => {
    let g = createGraph();
    g = linkEntities(g,
      { id: "u1", type: "user", label: "用户A" },
      { id: "t1", type: "task", label: "重构鉴权" },
      { aToB: "提出", bToA: "属于" },
    );
    expect(byType(g, "task").map((e) => e.id)).toEqual(["t1"]);
    const rels = neighbors(g, "u1").map((n) => n.relation).sort();
    expect(rels).toEqual(["属于", "提出"]); // 双向边两个方向都在
  });

  it("同向边权重叠加；删除实体连带清边", () => {
    let g = createGraph();
    g = addEdge(g, { from: "a", to: "b", relation: "ref", weight: 1 });
    g = addEdge(g, { from: "a", to: "b", relation: "ref", weight: 2 });
    expect(g.edges[0].weight).toBe(3);
    g = removeEntity(g, "a");
    expect(g.edges).toHaveLength(0);
    expect(g.entities).toHaveLength(0);
  });

  it("upsert 幂等（同 id 更新 props 不新增）", () => {
    let g = upsertEntity(createGraph(), { id: "e1", type: "concept", label: "鉴权" });
    g = upsertEntity(g, { id: "e1", type: "concept", label: "鉴权", props: { x: 1 } });
    expect(g.entities).toHaveLength(1);
    expect(g.entities[0].props).toEqual({ x: 1 });
  });

  it("parseGraph 还原 + resolveEntityIds 反查", () => {
    let g = linkEntities(createGraph(),
      { id: "user:alice", type: "user", label: "Alice" },
      { id: "task:42", type: "task", label: "重构鉴权" },
      { aToB: "提出", bToA: "属于" },
    );
    const back = parseGraph(JSON.stringify(g));
    expect(back!.entities).toHaveLength(2);
    expect(resolveEntityIds(g, ["task:42", "不存在的key"])).toEqual(["task:42"]);
    expect(resolveEntityIds(g, [])).toEqual([]);
    expect(parseGraph("bad")).toBeNull();
  });
});

describe("三层记忆 → MemoryStore 集成（C：图层持久化 + consolidation + 图谱存储）", () => {
  let lastRoot = "";
  function makeStore(agentId = "t-ag"): MemoryStore {
    lastRoot = mkdtempSync(join(tmpdir(), "slime-mem-"));
    return new MemoryStore(agentId, { projectRoot: lastRoot, dataDir: "mem" });
  }
  const DAY = 86_400_000;

  it("写入即分层：plan→working / lesson→episodic / preference→semantic", () => {
    const s = makeStore();
    s.storeCategorized("plan", "临时计划：调研方案", []);
    s.storeCategorized("lesson", "上次数训：先编译再声称完成", []);
    s.storeCategorized("preference", "theme: dark", ["theme"]);
    expect(s.getByLayer("working").map((f) => f.category)).toEqual(["plan"]);
    expect(s.getByLayer("episodic").map((f) => f.category)).toEqual(["lesson"]);
    expect(s.getByLayer("semantic").map((f) => f.category)).toEqual(["preference"]);
  });

  it("consolidateLayers：working 会话收尾下迁 episodic；semantic 恒保留", () => {
    const s = makeStore();
    s.storeCategorized("plan", "临时计划：调研方案", []);
    s.storeCategorized("preference", "theme: dark", ["theme"]);
    const { moved, pruned } = s.consolidateLayers();
    expect(moved).toBe(1);
    expect(pruned).toBe(0);
    expect(s.getByLayer("working")).toHaveLength(0);
    expect(s.getByLayer("episodic").map((f) => f.category)).toEqual(["plan"]);
    expect(s.getByLayer("semantic")).toHaveLength(1); // preference 仍在
  });

  it("consolidateLayers：episodic 过期且无访问 → prune；过高访问 → 沉淀 semantic", () => {
    const root = mkdtempSync(join(tmpdir(), "slime-mem-old-"));
    const agentId = "t-old";
    const dir = join(root, "mem", agentId);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    // 注入 40 天前的两条 episodic（一条冷、一条被多次访问）
    const oldStr = (oldTs: number) => new Date(oldTs).toISOString();
    writeFileSync(join(dir, "memory.json"), JSON.stringify({
      facts: [
        { id: "c1", content: "冷事件", category: "event", tags: [], importance: 5, timestamp: oldStr(now - 40 * DAY), last_accessed: "", links: [], backlinks: [], repeated: 0, layer: "episodic", access_count: 0 },
        { id: "h1", content: "热事件", category: "event", tags: [], importance: 5, timestamp: oldStr(now - 40 * DAY), last_accessed: oldStr(now - 39 * DAY), links: [], backlinks: [], repeated: 0, layer: "episodic", access_count: 3 },
        { id: "p1", content: "fact: 永久知识", category: "preference", tags: ["k"], importance: 6, timestamp: oldStr(now - 400 * DAY), last_accessed: "", links: [], backlinks: [], repeated: 0, layer: "semantic" },
      ],
      skills_unlocked: [], created_at: oldStr(0), updated_at: null,
    }), "utf8");
    const s = new MemoryStore(agentId, { projectRoot: root, dataDir: "mem" });
    const { moved, pruned } = s.consolidateLayers(now);
    expect(pruned).toBe(1); // 冷事件剔除
    expect(moved).toBe(1);  // 热事件沉淀 semantic
    expect(s.getByLayer("semantic").map((f) => f.id).sort()).toEqual(["h1", "p1"]);
    expect(s.getByLayer("episodic")).toHaveLength(0);
  });

  it("图谱持久化：upsert/link 落盘 memory_graph.json；getGraph 还原", () => {
    const s = makeStore();
    s.upsertGraphEntity({ id: "user:alice", type: "user", label: "Alice" });
    s.linkGraphEntities(
      { id: "user:alice", type: "user", label: "Alice" },
      { id: "task:42", type: "task", label: "重构鉴权" },
      { aToB: "提出", bToA: "属于" },
    );
    const g = s.getGraph();
    expect(g.entities).toHaveLength(2);
    expect(neighbors(g, "user:alice")[0]?.entity.id).toBe("task:42");
    // 重建 store（新实例）→ 懒加载图谱还原
    const s2 = new MemoryStore("t-ag", { projectRoot: lastRoot, dataDir: "mem" });
    expect(s2.getGraph().edges).toHaveLength(2);
  });

  it("entity_keys 持久化 + factsByGraphNeighbors 旁路召回", () => {
    const s = makeStore();
    s.storeCategorized("fact", "任务A：重构鉴权模块", [], 6, { entity_keys: ["task:42"] });
    s.storeCategorized("fact", "Alice 的偏好：深色主题", [], 5, { entity_keys: ["user:alice"] });
    s.linkGraphEntities(
      { id: "user:alice", type: "user", label: "Alice" },
      { id: "task:42", type: "task", label: "重构鉴权" },
      { aToB: "提出", bToA: "属于" },
    );
    const factA = s.getFacts().find((f) => f.content.includes("任务A"));
    expect(factA?.entity_keys).toEqual(["task:42"]);
    const neighbors = s.factsByGraphNeighbors(["task:42"], new Set([factA!.id]));
    expect(neighbors.map((f) => f.content)).toEqual(["Alice 的偏好：深色主题"]);
  });
});

describe("多路召回集成（C：retrieveFromStore 图谱通道 + 分层过滤）", () => {
  it("stageGraphRecall：种子实体 → 邻居关联记忆", () => {
    const root = mkdtempSync(join(tmpdir(), "slime-mem-ret-"));
    const s = new MemoryStore("t-ret", { projectRoot: root, dataDir: "mem" });
    s.storeCategorized("fact", "任务A：重构鉴权模块", [], 6, { entity_keys: ["task:42"] });
    s.storeCategorized("fact", "Alice 的偏好：深色主题", [], 4, { entity_keys: ["user:alice"] });
    s.linkGraphEntities(
      { id: "user:alice", type: "user", label: "Alice" },
      { id: "task:42", type: "task", label: "重构鉴权" },
      { aToB: "提出", bToA: "属于" },
    );
    const seed = s.getFacts().find((f) => f.content.includes("任务A"));
    const got = stageGraphRecall(s, [seed!], { max: 5 });
    expect(got.map((f) => f.content)).toEqual(["Alice 的偏好：深色主题"]);
  });

  it("stageLayerFilter：限定层过滤（旧数据按 category 兜底）", () => {
    const facts = [
      { id: "a", content: "x", category: "lesson", tags: [], importance: 5, timestamp: "", last_accessed: "", links: [], backlinks: [], repeated: 0 },
      { id: "b", content: "y", category: "preference", tags: [], importance: 5, timestamp: "", last_accessed: "", links: [], backlinks: [], repeated: 0 },
    ];
    const filtered = stageLayerFilter(facts as never[], ["episodic"]);
    expect(filtered.map((f) => (f as { id: string }).id)).toEqual(["a"]);
  });

  it("retrieveFromStore：图谱通道汇流返回 item.layer；stages 带 graph_walked", async () => {
    const root = mkdtempSync(join(tmpdir(), "slime-mem-ret2-"));
    const s = new MemoryStore("t-ret2", { projectRoot: root, dataDir: "mem" });
    for (let i = 0; i < 5; i++) {
      s.storeCategorized("fact", `任务${i}: 普通记忆内容 ${"细节".repeat(2)}`, [], 4);
    }
    s.storeCategorized("fact", "任务A：重构鉴权模块", [], 6, { entity_keys: ["task:42"] });
    s.storeCategorized("fact", "Alice 的偏好：深色主题", [], 6, { entity_keys: ["user:alice"] });
    s.linkGraphEntities(
      { id: "user:alice", type: "user", label: "Alice" },
      { id: "task:42", type: "task", label: "重构鉴权" },
      { aToB: "提出", bToA: "属于" },
    );
    const res = await retrieveFromStore(s, { query: "重构鉴权", topK: 8 });
    expect(res.stages.graph_walked).toBeGreaterThanOrEqual(0);
    expect(res.items.length).toBeGreaterThan(0);
    for (const it of res.items) {
      expect(typeof it.layer).toBe("string");
    }
    // 分层过滤：限定 semantic（fact → semantic）仍能召回
    const sem = await retrieveFromStore(s, { query: "重构鉴权", topK: 8, layers: ["semantic"] });
    expect(sem.items.filter((i) => i.layer !== "semantic")).toHaveLength(0);
  });

  it("图谱文件不存在时 getGraph 返回空图，不抛错", () => {
    const root = mkdtempSync(join(tmpdir(), "slime-mem-empty-"));
    const s = new MemoryStore("t-empty", { projectRoot: root, dataDir: "mem" });
    expect(s.getGraph().entities).toEqual([]);
    expect(existsSync(join(root, "mem", "t-empty", "memory_graph.json"))).toBe(false);
  });
});