





import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    
    const all = m.search("python 语言", { limit: 3 });
    expect(all.split("\n")[0]).toContain("Python");
    
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

    
    const n = m.forget({ topic: "相关" });
    expect(n).toBe(2);
    expect(m.getFacts().length).toBe(1);
    
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
    expect(m.forget({ before: beforeAll })).toBe(0); 
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

describe("memory_recall / memory_write 工具（§2.2 主动查记忆）", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = makeTmp();
    store = new MemoryStore("tool_agent", { dataDir: dir });
    resetRegistry();
    setMemoryStoreProvider(null);
    registerBuiltinTools();
    setMemoryStoreProvider((agentId: string) => (agentId === "tool_agent" ? store : null));
  });

  // A-1139：种子内容必须**语义互不重叠**。此前用「测试条目 topic-N 关键词 内容」，
  // 在中文相似度修复（CJK unigram+bigram）后这批条目两两相似度 0.89~1.00 —— 它们
  // 按判据就是同一批重复记忆，会被去重/合并正常吸收，于是「30 条」根本不会成立
  // （k 上限用例测不到东西）。改成互不相关的条目，被测语义（k 上限 / 结构化输出）不变。
  const SEED_LINES = [
    "红烧肉需要小火慢炖两小时", "数据库连接池建议控制在 CPU 核数两倍",
    "今天的天气预报说有雷阵雨", "光合作用把光能转成化学能",
    "长城的砖块尺寸各地并不统一", "股票分红除权日会调整开盘参考价",
    "量子纠缠不能用来超光速通信", "核糖体负责把信使翻译成蛋白质",
    "钢琴调律一般按标准音高定音", "驼峰航线当年飞越喜马拉雅山脉",
    "青铜器的锡铅配比影响硬度", "潮汐锁定让月球始终同一面朝地球",
    "台风眼内反而风平浪静", "贝叶经多用梵文写在棕榈叶上",
    "深海热泉附近有化能合成生态", "莫高窟壁画颜料含青金石",
    "咖啡因的半衰期大约五小时", "候鸟靠地磁与星象双重导航",
    "榫卯结构不用一根钉子", "沙漠昼夜温差大的原因是比热容",
    "极光由太阳风粒子激发高层大气", "活字印刷先用胶泥后改用木与铜",
    "珊瑚白化是共生藻离开的结果", "湿地被称为地球之肾",
    "古琴的七弦对应五音加二变", "指南针最早用于堪舆后用于航海",
    "盐湖提锂靠蒸发结晶", "竹简编连的绳子断了叫韦编三绝",
    "陨石坑的直径通常远大于陨石", "鸟类没有牙齿靠砂囊研磨食物",
  ];

  function seedMany(n: number): void {
    for (let i = 0; i < n; i++) {
      store.storeCategorized("fact", SEED_LINES[i % SEED_LINES.length], [], 5 + (i % 4));
    }
  }

  it("① 两个工具都已注册且名字正确", () => {
    const reg = getRegistry();
    for (const name of ["memory_recall", "memory_write"]) {
      expect(reg.get(name), `${name} 未注册`).toBeDefined();
      expect(reg.listToolNames()).toContain(name);
      expect(reg.listTools().some((s) => String((s as { function?: { name?: string } }).function?.name) === name)).toBe(true);
    }
  });

  it("② permissions 声明正确：memory_recall=read / memory_write=write", () => {
    const recall = getRegistry().get("memory_recall")!;
    const write = getRegistry().get("memory_write")!;
    expect(recall.permissions).toEqual(["read"]);
    expect(write.permissions).toEqual(["write"]);
    expect(write.riskKind).toBe("write");
  });

  it("③ memory_recall 返回结构化分条（JSON 数组，每条有 content/category），不是散文", async () => {
    seedMany(30);
    const recall = getRegistry().get("memory_recall")!;
    const raw = await recall.executeFn({ _agent_id: "tool_agent", query: "测试条目", k: 5 });
    expect(raw.startsWith("[")).toBe(true);
    const items: Array<Record<string, unknown>> = JSON.parse(raw);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(5);
    for (const it of items) {
      expect(typeof it.content).toBe("string");
      expect(typeof it.category).toBe("string");
      expect(typeof it.importance).toBe("number");
      expect(typeof it.timestamp).toBe("string");
      expect("source" in it).toBe(true);
    }
  });

  it("④ memory_write 落盘后能被 memory_recall 查到（经 registry.callTool 全链路）", async () => {
    const reg = getRegistry();
    const out = await reg.callTool("memory_write", { _agent_id: "tool_agent", content: "项目约定 用 TypeScript 写测试", importance: 8 });
    expect(out).toContain("已记忆");
    expect(store.getFacts().length).toBe(1);
    expect(store.getFacts()[0].content).toBe("项目约定 用 TypeScript 写测试");
    expect(store.getFacts()[0].importance).toBe(8);

    const raw = await reg.callTool("memory_recall", { _agent_id: "tool_agent", query: "TypeScript 测试" });
    const items: Array<Record<string, unknown>> = JSON.parse(raw);
    expect(Array.isArray(items)).toBe(true);
    expect(items.some((it) => it.content === "项目约定 用 TypeScript 写测试")).toBe(true);

    const dupOut = await reg.callTool("memory_write", { _agent_id: "tool_agent", content: "项目约定 用 TypeScript 写测试" });
    expect(dupOut).toContain("去重");
    expect(store.getFacts().length).toBe(1);
  });

  it("⑤ k 上限 20 生效：传 k=100 不会返回超过 20 条", async () => {
    seedMany(30);
    const recall = getRegistry().get("memory_recall")!;
    const raw = await recall.executeFn({ _agent_id: "tool_agent", query: "测试条目", k: 100 });
    const items: Array<Record<string, unknown>> = JSON.parse(raw);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(20);
    expect(items.length).toBe(20);
  });

  it("空记忆库 → memory_recall 返回空数组 []（仍是结构化分条）", async () => {
    const recall = getRegistry().get("memory_recall")!;
    const raw = await recall.executeFn({ _agent_id: "tool_agent", query: "任意" });
    expect(JSON.parse(raw)).toEqual([]);
  });
});

describe("memory_recall 带上跨 agent 共享指针（维护者裁决：允许可见，但必须标注来源）", () => {
  let dir: string;
  let store: MemoryStore;
  let other: MemoryStore;

  /** 共享指针的形状（与本地条目**同一套键**，区别只在 source）。 */
  const ITEM_KEYS = ["id", "content", "category", "importance", "source", "timestamp"];

  /** 语义互不重叠的本地条目（拉丁 token 无交集，不会被去重/合并吸收）。 */
  const LOCAL_SEEDS = [
    "gamma1 delta1 local", "gamma2 delta2 local", "gamma3 delta3 local",
    "gamma4 delta4 local", "gamma5 delta5 local", "gamma6 delta6 local",
  ];

  beforeEach(() => {
    dir = makeTmp();
    store = new MemoryStore("tool_agent", { dataDir: dir });
    other = new MemoryStore("other_agent", { dataDir: dir });
    resetRegistry();
    setMemoryStoreProvider(null);
    registerBuiltinTools();
    setMemoryStoreProvider((agentId: string) => (agentId === "tool_agent" ? store : null));
  });

  /** 造一条「别的 agent 已经知道 → 本 agent 只留指针」的跨 agent 去重命中。 */
  function seedShared(content: string): void {
    const refsBefore = store.getSharedRefs().length;
    other.addFact(content);
    store.addFact(content);                       // 命中跨 agent 去重 → 本地只留 shared_refs
    expect(store.getFacts().some((f) => f.content === content)).toBe(false);
    expect(store.getSharedRefs().length).toBe(refsBefore + 1);
  }

  it("① 共享指针出现在 memory_recall 输出里，且 source = shared:<agent_id>", async () => {
    seedShared("项目约定 用 TypeScript 写测试");
    const raw = await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "TypeScript 写测试",
    });
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    const shared = items.filter((it) => String(it.source).startsWith("shared:"));
    expect(shared.length, "跨 agent 共享指针没有出现在 memory_recall 输出里").toBeGreaterThan(0);
    expect(shared[0].source).toBe("shared:other_agent");
    expect(shared[0].content).toBe("项目约定 用 TypeScript 写测试");
  });

  it("② 形状与本地条目一致（id/content/category/importance/timestamp/source），但 id 必须为空", async () => {
    seedShared("项目约定 用 TypeScript 写测试");
    store.addFact("本 agent 自己的一条独立事实");
    const raw = await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "TypeScript 写测试 独立事实", k: 5,
    });
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) expect(Object.keys(it).sort()).toEqual([...ITEM_KEYS].sort());
    const shared = items.find((it) => String(it.source).startsWith("shared:"))!;
    expect(shared.id, "别人的 mem_id 不能出现在本 agent 的 id 空间（会诱导 memory_forget 越权）").toBe("");
    const local = items.find((it) => !String(it.source).startsWith("shared:"))!;
    expect(local.id).not.toBe("");
  });

  it("③ 隐私边界：不暴露别的 agent 的 links/backlinks/tags/system", async () => {
    other.storeCategorized("fact", "用户偏好深色主题", ["ui"], 8, { source: "preference", confidence: 0.9 });
    store.addFact("用户偏好深色主题");
    const raw = await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "深色主题",
    });
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    const shared = items.filter((it) => String(it.source).startsWith("shared:"));
    expect(shared.length).toBe(1);
    for (const bad of ["links", "backlinks", "tags", "system", "merge_trail", "confidence", "layer", "mem_id"]) {
      expect(shared[0], `共享指针泄漏了别人的内部字段 ${bad}`).not.toHaveProperty(bad);
    }
  });

  it("④ 本 agent 条目在前、共享指针在后，且内容重复的不再给一遍", async () => {
    store.addFact("本 agent 自己的一条独立事实");
    seedShared("项目约定 用 TypeScript 写测试");
    const raw = await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "TypeScript 写测试 独立事实", k: 5,
    });
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    const firstShared = items.findIndex((it) => String(it.source).startsWith("shared:"));
    expect(firstShared).toBeGreaterThan(0);
    expect(items.slice(0, firstShared).every((it) => !String(it.source).startsWith("shared:"))).toBe(true);
    const contents = items.map((it) => it.content);
    expect(new Set(contents).size).toBe(contents.length);
  });

  it("⑤ 预算：本 agent 最多 k 条，共享指针最多再补 k 条（不被本地召回挤掉）", async () => {
    // ⚠️ 共享种子必须**语义互不重叠**（拉丁 token 无交集）：否则它们会在
    // other_agent 内部互相去重、或在 store 侧合并，指针数量根本涨不到 6 条。
    for (let i = 0; i < 6; i++) seedShared(`probe${i} alpha ref${i * 7919} beta`);
    for (let i = 0; i < 6; i++) store.addFact(LOCAL_SEEDS[i]);
    const raw = await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "alpha beta", k: 3,
    });
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    const sharedN = items.filter((it) => String(it.source).startsWith("shared:")).length;
    const localN = items.length - sharedN;
    expect(localN).toBeLessThanOrEqual(3);
    expect(sharedN, "本地召回占满 k 后共享指针被挤没了").toBeGreaterThan(0);
    expect(sharedN).toBeLessThanOrEqual(3);
  });

  it("⑥ cross_agent_dedup=false → 没有指针可给，输出仍只有本 agent 条目", async () => {
    const offDir = makeTmp();
    writeFileSync(join(offDir, "slime.toml"), "[memory]\ncross_agent_dedup = false\nmax_entries = 50\n", "utf8");
    const offStore = new MemoryStore("tool_agent", { dataDir: offDir });
    const offOther = new MemoryStore("other_agent", { dataDir: offDir });
    offOther.addFact("同一条内容");
    offStore.addFact("同一条内容");
    expect(offStore.getSharedRefs().length).toBe(0);

    setMemoryStoreProvider((agentId: string) => (agentId === "tool_agent" ? offStore : null));
    const raw = await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "同一条内容",
    });
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(items.some((it) => String(it.source).startsWith("shared:"))).toBe(false);
  });

  it("⑦ category 过滤对共享指针同样生效", async () => {
    other.storeCategorized("lesson", "用 file_read 处理路径参数要小心相对路径基准", [], 5);
    store.addLesson("用 file_read 处理路径参数要小心相对路径基准", true);
    expect(store.getSharedRefs().length).toBe(1);

    const onlyFact = JSON.parse(await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "file_read 相对路径", category: "fact",
    })) as Array<Record<string, unknown>>;
    expect(onlyFact.some((it) => String(it.source).startsWith("shared:"))).toBe(false);

    const onlyLesson = JSON.parse(await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "file_read 相对路径", category: "lesson",
    })) as Array<Record<string, unknown>>;
    const shared = onlyLesson.filter((it) => String(it.source).startsWith("shared:"));
    expect(shared.length, "共享指针的 category 过滤没生效").toBeGreaterThan(0);
  });

  it("⑧ 索引不在场（globalIndex=false）时，本地 shared_refs 兜底仍能给出共享指针", async () => {
    // 先走真实路径造出指针（此时索引在场）……
    seedShared("ghost 共享指针内容 alpha probe");
    // ……再关掉索引重新打开同一个 memory.json：索引召回拿不到东西，指针必须兜底。
    const noIdx = new MemoryStore("tool_agent", { dataDir: dir, globalIndex: false });
    expect(noIdx.getFacts().length).toBe(0);
    expect(noIdx.getSharedRefs().length).toBe(1);

    setMemoryStoreProvider((agentId: string) => (agentId === "tool_agent" ? noIdx : null));
    const items = JSON.parse(await getRegistry().get("memory_recall")!.executeFn({
      _agent_id: "tool_agent", query: "ghost 共享指针 alpha probe",
    })) as Array<Record<string, unknown>>;
    const shared = items.filter((it) => String(it.source).startsWith("shared:"));
    expect(shared.length, "索引关掉后 shared_refs 兜底没生效").toBe(1);
    expect(shared[0].source).toBe("shared:other_agent");
    expect(String(shared[0].content)).toContain("共享指针内容");
  });
});
