/**
 * tests/core-ts/memory-tools.spec.ts — 记忆三件套（#3）回归：
 *  1. MemoryStore 溯源字段（source/confidence/created_at）+ search + forget；
 *  2. memory_insert / memory_search / memory_forget 工具链路（provider 注入 + _agent_id 定位）。
 * 隔离：dataDir 指向临时目录，不触碰生产 Knowledge/。
 */
import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../core-ts/src/memory/store.js";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setMemoryStoreProvider } from "../../core-ts/src/tools/builtin.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memtools-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("MemoryStore 溯源 + search + forget", () => {
  it("storeCategorized 写入 source/confidence/created_at 溯源字段", () => {
    const m = new MemoryStore("prov_agent", { dataDir: makeTmp() });
    m.storeCategorized("fact", "用户偏好深色主题", [], 7, { source: "preference", confidence: 0.9 });
    const f = m.getFacts()[0];
    expect(f.source).toBe("preference");
    expect(f.confidence).toBe(0.9);
    expect(typeof f.created_at).toBe("string");
    expect(Date.parse(f.created_at ?? "")).not.toBeNaN();
    // layer 由 source 派生：preference → semantic
    expect(f.layer).toBe("semantic");
  });

  it("confidence 非法值回退 undefined（缺省 1），数值夹到 [0,1]", () => {
    const m = new MemoryStore("conf_agent", { dataDir: makeTmp() });
    m.storeCategorized("fact", "a", [], 5, { confidence: 2.5 });
    m.storeCategorized("fact", "b", [], 5, { confidence: -1 });
    m.storeCategorized("fact", "c", [], 5, { confidence: "x" as unknown as number });
    const facts = m.getFacts();
    expect(facts[0].confidence).toBe(1);
    expect(facts[1].confidence).toBe(0);
    expect(facts[2].confidence).toBeUndefined();
  });

  it("search：按有效权重排序 + 分类过滤", () => {
    const m = new MemoryStore("search_agent", { dataDir: makeTmp() });
    m.addFact("用户喜欢 Python 语言");
    m.addPreference("editor", "vscode");
    m.addFact("用户喜欢 Rust 语言");
    // 相关词命中 → Python 排最前
    const all = m.search("python 语言", { limit: 3 });
    expect(all.split("\n")[0]).toContain("Python");
    // 分类过滤：只回 preference
    const prefs = m.search("", { category: "preference" });
    expect(prefs).toContain("editor");
    expect(prefs).not.toContain("Python");
  });

  it("forget：按 id / topic / before 删除并清理悬空引用", () => {
    const dir = makeTmp();
    const m = new MemoryStore("forget_agent", { dataDir: dir });
    m.storeCategorized("fact", "A 与 B 相关", ["x"]);
    m.storeCategorized("fact", "B 与 C 相关", ["x"]);
    m.storeCategorized("fact", "无关条目", ["y"]);
    expect(m.getFacts().length).toBe(3);

    // 按 topic 删除含 "相关" 的条目（两条命中，第三条"无关条目"不命中）
    const n = m.forget({ topic: "相关" });
    expect(n).toBe(2);
    expect(m.getFacts().length).toBe(1);
    // 剩余条目不应残留指向已删 id 的 links/backlinks
    for (const f of m.getFacts()) {
      expect(f.links?.length ?? 0).toBe(0);
      expect(f.backlinks?.length ?? 0).toBe(0);
    }
  });

  it("forget：before 按 created_at 时间过滤；无匹配返回 0 不落盘", () => {
    const m = new MemoryStore("before_agent", { dataDir: makeTmp() });
    m.addFact("旧记忆");
    const beforeAll = new Date(Date.now() + 1000).toISOString();
    const n = m.forget({ before: beforeAll });
    expect(n).toBe(1);
    expect(m.getFacts().length).toBe(0);
    expect(m.forget({ before: beforeAll })).toBe(0); // 已空，无匹配
  });
});

describe("memory_insert / search / forget 工具链路", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = makeTmp();
    store = new MemoryStore("tool_agent", { dataDir: dir });
    resetRegistry();
    setMemoryStoreProvider(null);
    registerBuiltinTools();
  });

  it("三工具已注册且 schema 对模型可见", () => {
    const reg = getRegistry();
    for (const name of ["memory_insert", "memory_search", "memory_forget"]) {
      expect(reg.get(name)).toBeDefined();
      expect(reg.listTools().some((s) => String((s as { function?: { name?: string } }).function?.name) === name)).toBe(true);
    }
  });

  it("provider 未注入 → 如实报错（不静默失败）", async () => {
    const insert = getRegistry().get("memory_insert")!;
    const out = await insert.executeFn({ _agent_id: "tool_agent", content: "x" });
    expect(out).toContain("未就绪");
  });

  it("注入 provider → insert 写记忆 / search 召回 / forget 删除", async () => {
    setMemoryStoreProvider((agentId: string) => (agentId === "tool_agent" ? store : null));

    const insert = getRegistry().get("memory_insert")!;
    const ins = await insert.executeFn({ _agent_id: "tool_agent", content: "用户偏好深色主题", category: "preference", tags: ["ui"], source: "preference", confidence: 0.8 });
    expect(ins).toContain("已记忆");

    // 真实落到了注入的 store
    expect(store.getFacts().length).toBe(1);
    expect(store.getFacts()[0].source).toBe("preference");

    const search = getRegistry().get("memory_search")!;
    const res = await search.executeFn({ _agent_id: "tool_agent", query: "深色" });
    expect(res).toContain("深色主题");

    const forget = getRegistry().get("memory_forget")!;
    const del = await forget.executeFn({ _agent_id: "tool_agent", topic: "深色" });
    expect(del).toContain("1");
    expect(store.getFacts().length).toBe(0);
  });

  it("forget 缺 ids/topic/before → 拒绝", async () => {
    setMemoryStoreProvider(() => store);
    const forget = getRegistry().get("memory_forget")!;
    const out = await forget.executeFn({ _agent_id: "tool_agent" });
    expect(out).toContain("至少提供");
  });

  it("insert 缺 content → 拒绝", async () => {
    setMemoryStoreProvider(() => store);
    const insert = getRegistry().get("memory_insert")!;
    const out = await insert.executeFn({ _agent_id: "tool_agent", content: "  " });
    expect(out).toContain("不能为空");
  });

  it("_agent_id 缺失 → 拒绝（防跨 Agent 误写）", async () => {
    setMemoryStoreProvider(() => store);
    const insert = getRegistry().get("memory_insert")!;
    const out = await insert.executeFn({ content: "x" });
    expect(out).toContain("未取得当前 Agent 标识");
  });
});
