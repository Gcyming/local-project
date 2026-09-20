/**
 * tests/core-ts/todo-tasks.spec.ts — 待办任务（todo_write）回归测试。
 *
 * 背景（A-980-R27）：用户实测右侧栏「待办任务」**永远是空的**，"几乎成了摆设"。
 * 排查发现磁盘上躺着一个 `data/todos_.json`，里面是 Agent 真实规划过的三步计划——
 * 即 Agent 一直在正确调用 todo_write，只是 sessionId 从没被注入（工具读 `args.sessionId` 恒为 ""），
 * 而主进程与界面读的都是 `todos_<sessionId>.json`，两边文件名对不上。
 *
 * 本文件锁住三类东西：
 *  ① 根因回归：缺 sessionId 必须**如实报错且不落盘**，绝不生成界面看不见的"幽灵待办"；
 *  ② 状态纪律：任意时刻最多一个 in_progress；completedAt 打戳/撤销的时机；
 *  ③ 合并语义：add 按 id 合并（未提及项保留），replace 整表重写，clear 清空。
 *
 * ⚠️ 隔离策略：PROJECT_ROOT 是 core-ts 的模块级常量，测试里改不动，因此本文件
 * 用**带测试标记的 sessionId** 把文件写进真实 data/ 目录，并在 beforeEach/afterAll
 * 无条件清理自己造的文件（不依赖"测试通过"这个前提）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools } from "../../core-ts/src/tools/builtin.js";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";

const DATA_DIR = join(PROJECT_ROOT, "data");
/** 测试专用文件名标记：用于精确识别并清理本测试造出的文件 */
const MARK = "__spec_todo_";
let sid = "";

function pathOf(sessionId: string): string {
  return join(DATA_DIR, `todos_${sessionId}.json`);
}

/** 载入待办项（测试侧直接读盘，不经过工具，确保断言的是落盘结果） */
function readItems(sessionId: string): Array<{ id: string; content: string; status: string; completedAt?: string }> {
  return (JSON.parse(readFileSync(pathOf(sessionId), "utf8")) as { items: Array<{ id: string; content: string; status: string; completedAt?: string }> }).items;
}

/** 清理所有本测试造出的文件（含可能残留的空名/畸形名） */
function cleanMarked(): void {
  let names: string[] = [];
  try { names = readdirSync(DATA_DIR); } catch { return; }
  for (const n of names) {
    if (n.includes(MARK)) {
      try { rmSync(join(DATA_DIR, n), { force: true }); } catch { /* 清理失败不阻断 */ }
    }
  }
}

let reg: ToolRegistry;
/**
 * 调用 todo_write，**模拟工具循环的行为**：把受信 sessionId 注入 args。
 * 真实链路上这一步在 `core-ts/src/tool_loop.ts` 的 runOneTool 里做（模型自己不传）。
 */
async function call(args: Record<string, unknown>): Promise<string> {
  const t = reg.get("todo_write");
  if (!t) { throw new Error("todo_write 未注册"); }
  return t.executeFn({ ...args, sessionId: sid });
}

beforeEach(() => {
  cleanMarked();
  sid = `${MARK}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  reg = new ToolRegistry();
  registerBuiltinTools(reg);
});

afterAll(() => { cleanMarked(); });

describe("todo_write — 根因回归：sessionId 必须由循环注入", () => {
  it("缺 sessionId → 如实报错，且不产生任何落盘文件", async () => {
    const ghost = pathOf(""); // 即 data/todos_.json —— 正是事故现场的文件名
    const hadGhost = existsSync(ghost);
    // 故意绕过 call() 的注入，直接调工具：模拟"循环没注入 sessionId"的历史故障状态
    const out = await reg.get("todo_write")!.executeFn({ action: "add", items: [{ content: "会被丢弃的任务" }] });
    expect(out).toContain("[错误]");
    expect(out).toContain("sessionId");
    // 关键断言：即使用户目录本来没有 todos_.json，这次调用也绝不能把它造出来
    if (!hadGhost) { expect(existsSync(ghost)).toBe(false); }
    expect(readdirSync(DATA_DIR).filter((n) => n.includes(MARK))).toEqual([]);
  });

  it("有 sessionId → 落到 todos_<sessionId>.json（界面读的就是这个文件）", async () => {
    await call({ action: "add", items: [{ content: "任务甲" }] });
    expect(existsSync(pathOf(sid))).toBe(true);
    expect(readItems(sid)).toHaveLength(1);
  });
});

describe("todo_write — 状态纪律", () => {
  it("多个 in_progress 只保留第一个，其余降级 pending", async () => {
    await call({
      action: "add",
      items: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "in_progress" },
      ],
    });
    const items = readItems(sid);
    expect(items.filter((i) => i.status === "in_progress")).toHaveLength(1);
    expect(items[0]!.status).toBe("in_progress");
    expect(items[1]!.status).toBe("pending");
    expect(items[2]!.status).toBe("pending");
  });

  it("转入 completed 自动打戳 completedAt；退回非完成态则撤销", async () => {
    await call({ action: "add", items: [{ id: "t1", content: "任务", status: "pending" }] });
    expect(readItems(sid)[0]!.completedAt).toBeUndefined();

    await call({ action: "add", items: [{ id: "t1", status: "completed" }] });
    const stamped = readItems(sid)[0]!.completedAt;
    expect(typeof stamped).toBe("string");
    expect(Number.isNaN(Date.parse(stamped!))).toBe(false);

    await call({ action: "add", items: [{ id: "t1", status: "pending" }] });
    expect(readItems(sid)[0]!.completedAt).toBeUndefined();
  });

  it("重复更新已完成项不会刷新原有时间戳（否则界面时间会一直跳）", async () => {
    await call({ action: "add", items: [{ id: "t1", content: "任务", status: "completed" }] });
    const first = readItems(sid)[0]!.completedAt;
    await new Promise((r) => setTimeout(r, 5));
    await call({ action: "add", items: [{ id: "t1", content: "任务（改了个错字）" }] });
    expect(readItems(sid)[0]!.completedAt).toBe(first);
    expect(readItems(sid)[0]!.content).toBe("任务（改了个错字）");
  });
});

describe("todo_write — action 语义", () => {
  it("add 按 id 合并：未提及的旧项保留，同 id 就地更新", async () => {
    await call({ action: "add", items: [{ id: "a", content: "第一步" }, { id: "b", content: "第二步" }] });
    await call({ action: "add", items: [{ id: "b", status: "in_progress" }] });
    const items = readItems(sid);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.id === "a")!.content).toBe("第一步");
    expect(items.find((i) => i.id === "b")!.status).toBe("in_progress");
  });

  it("replace 整表重写：未提及的旧项被移除", async () => {
    await call({ action: "add", items: [{ id: "a", content: "旧计划" }, { id: "b", content: "旧计划二" }] });
    await call({ action: "replace", items: [{ content: "新计划一" }, { content: "新计划二" }] });
    const items = readItems(sid);
    expect(items.map((i) => i.content)).toEqual(["新计划一", "新计划二"]);
  });

  it("clear 清空（items 可省略）", async () => {
    await call({ action: "add", items: [{ content: "甲" }, { content: "乙" }] });
    const out = await call({ action: "clear" });
    expect(out).toContain("[成功]");
    expect(readItems(sid)).toEqual([]);
  });

  it("action=update 作为历史名兼容为合并语义", async () => {
    await call({ action: "add", items: [{ id: "a", content: "甲" }] });
    await call({ action: "update", items: [{ id: "a", status: "completed" }] });
    expect(readItems(sid)[0]!.status).toBe("completed");
  });

  it("未知 action → 报错且不改动既有列表", async () => {
    await call({ action: "add", items: [{ content: "甲" }] });
    const out = await call({ action: "explode", items: [{ content: "乙" }] });
    expect(out).toContain("[错误]");
    expect(readItems(sid).map((i) => i.content)).toEqual(["甲"]);
  });

  it("空 content 被过滤；全空则提示且不动列表", async () => {
    await call({ action: "add", items: [{ content: "有效" }] });
    const out = await call({ action: "add", items: [{ content: "   " }, { content: "" }] });
    expect(out).toContain("[提示]");
    expect(readItems(sid).map((i) => i.content)).toEqual(["有效"]);
  });
});

describe("todo_write — 返回值即「目标复述」", () => {
  it("返回值带进度与完整清单（长任务里把计划顶回上下文末尾）", async () => {
    await call({
      action: "add",
      items: [
        { id: "1", content: "读代码", status: "completed" },
        { id: "2", content: "改逻辑", status: "in_progress" },
        { id: "3", content: "跑测试", status: "pending" },
      ],
    });
    const out = await call({ action: "add", items: [{ id: "3", status: "pending" }] });
    expect(out).toContain("进度 1/3");
    expect(out).toContain("当前进行中：改逻辑");
    expect(out).toContain("- [x] 读代码");
    expect(out).toContain("- [ ] 改逻辑");
    expect(out).toContain("← 进行中");
    expect(out).toContain("- [ ] 跑测试");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   工具循环：sessionId 必须由循环注入（A-980-R27 根因的**直接**回归）
   前面那些用例手写注入了 sessionId；这一组走真实 ToolLoop，验证注入确实发生在循环里，
   且模型伪造的 sessionId 会被覆盖。
   ───────────────────────────────────────────────────────────────────────── */

function makeRouter(sequence: Array<{ content?: string | null; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>): ModelRouter {
  let idx = 0;
  const fetchImpl = vi.fn(async () => {
    const seq = sequence[Math.min(idx, sequence.length - 1)];
    idx++;
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "m",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: seq.content ?? null,
          tool_calls: seq.toolCalls
            ? seq.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
            : undefined,
        },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return new ModelRouter(
    [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
    () => new ChatClient({ baseUrl: "http://x", fetchImpl }),
  );
}

describe("ToolLoop — todo_write 的 sessionId 由循环注入", () => {
  it("模型不传 sessionId，也能落到 todos_<会话id>.json", async () => {
    const router = makeRouter([
      { toolCalls: [{ id: "t1", name: "todo_write", arguments: '{"action":"add","items":[{"id":"1","content":"循环注入的任务"}]}' }] },
      { content: "完成" },
    ]);
    const loop = new ToolLoop({ router, registry: reg });
    await loop.run({
      agentId: "a1",
      sessionId: sid,
      messages: [{ role: "user" as const, content: "做点事" }],
      initialToolCalls: [{ id: "t1", name: "todo_write", arguments: '{"action":"add","items":[{"id":"1","content":"循环注入的任务"}]}' }],
    });
    // 注入生效 → 文件出现在界面读取的那个路径上
    expect(existsSync(pathOf(sid))).toBe(true);
    expect(readItems(sid).map((i) => i.content)).toEqual(["循环注入的任务"]);
  });

  it("模型伪造 sessionId 会被覆盖（不能跨会话写别人的待办）", async () => {
    const forged = `${MARK}forged`;
    const router = makeRouter([{ content: "完成" }]);
    const loop = new ToolLoop({ router, registry: reg });
    await loop.run({
      agentId: "a1",
      sessionId: sid,
      messages: [{ role: "user" as const, content: "x" }],
      initialToolCalls: [{ id: "t1", name: "todo_write", arguments: `{"action":"add","sessionId":"${forged}","items":[{"id":"1","content":"越权尝试"}]}` }],
    });
    expect(existsSync(pathOf(forged))).toBe(false); // 伪造的会话没被写入
    expect(readItems(sid)).toHaveLength(1);         // 真身会话拿到了这条
  });

  it("循环无 sessionId（CLI/测试环境）→ 工具如实报错，不生成幽灵文件", async () => {
    const ghost = pathOf("");
    const hadGhost = existsSync(ghost);
    const router = makeRouter([{ content: "完成" }]);
    const loop = new ToolLoop({ router, registry: reg });
    const r = await loop.run({
      agentId: "a1",
      messages: [{ role: "user" as const, content: "x" }],
      initialToolCalls: [{ id: "t1", name: "todo_write", arguments: '{"action":"add","items":[{"id":"1","content":"无处安放"}]}' }],
    });
    expect(r.roundLog[0]!.result).toContain("sessionId");
    if (!hadGhost) { expect(existsSync(ghost)).toBe(false); }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   待办面板源码约定守卫（A-980-R28）
   这一组不看运行时行为，只看源码里的两处**约定**——它们都属于"写反了不报错、
   只有肉眼在界面上才发现"的类型，靠 tsc / 常规断言都抓不到：
   ① ChevronIcon 基准朝右，全仓约定 `open ? 90 : 0`（展开朝下 ▾ / 收起朝右 ▸）；
   ② 会话未就绪（sessionId 为空）时不得读/写/订阅待办 —— 空串会命中 `data/todos_.json`。
   ───────────────────────────────────────────────────────────────────────── */

describe("待办面板源码约定（防回归）", () => {
  const SRC_RAW = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/RightSidebar.tsx"), "utf8");
  const MAIN = readFileSync(join(PROJECT_ROOT, "gui/src/main/index.ts"), "utf8");
  /** 去掉注释行后的可执行源码。
   *  必要性：修复说明的注释里会**引用旧写法**做对照（"此前写成 xxx"），
   *  直接全文 not.toContain 会被自己的注释判失败。 */
  const SRC = SRC_RAW.split("\n")
    .filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n");

  it("展开箭头方向：展开 90°（朝下）/ 收起 0°（朝右）", () => {
    expect(SRC).toContain("rotate={collapsedTodos ? 0 : 90}");
    expect(SRC).not.toContain("rotate={collapsedTodos ? 90 : 0}");
  });

  it("会话未就绪不得读待办（loadPersisted / flushPersist / 拉取三处都要有守卫）", () => {
    expect(SRC).toContain("const sessionReady = Boolean(props.sessionId)");
    // 三处守卫都要求 agentId 与 sessionId 同时存在
    expect((SRC.match(/if \(!props\.agentId \|\| !props\.sessionId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("订阅过滤必须两侧严格匹配（此前 props.sessionId 为空时会跳过整条守卫）", () => {
    expect(SRC).toContain("if (!props.sessionId || !data.sessionId || data.sessionId !== props.sessionId)");
    expect(SRC).not.toContain("if (props.sessionId && data.sessionId !== props.sessionId)");
  });

  it("主进程兜底：空 sessionId 直接拒绝，且读取统一走 todoStore（不再手搓路径）", () => {
    expect(MAIN).toContain("loadTodos 收到空 sessionId，已拒绝");
    // A-980-R29：主进程不再自己拼路径/解析，统一委托给 store（store 对空 id 返回 null）
    expect(MAIN).toContain("readTodos(sid)");
    expect(MAIN).not.toContain("`todos_${sid}.json`");
  });

  it("A-980-R29：会话/Agent/工作区删除时必须清 Plan + 待办文件（此前只增不减）", () => {
    expect(MAIN).toContain("function purgeSessionPlanning(");
    expect(MAIN).toContain("planStore.delete(sessionId)");
    expect(MAIN).toContain("removeTodos(sessionId)");
    // 三个删除入口都要调（会话 / Agent / 工作文件夹）
    expect((MAIN.match(/purgeSessionPlanning\(/g) ?? []).length).toBeGreaterThanOrEqual(4); // 1 定义 + 3 调用
    // Agent 删除必须先取会话 id —— removeSessionsForAgent 只返回数量，删完就查不到了
    expect(MAIN).toMatch(/filter\(\(s\) => s\.agentId === agentId\)/);
  });

  it("A-980-R29：plan_create 真 Plan 不被 todo 派生镜像顶掉", () => {
    expect(MAIN).toContain("function putPlan(");
    expect(MAIN).toContain('plan.source === "todo" && prev?.source === "plan"');
    expect(MAIN).toContain("PLAN_STORE_MAX"); // planStore 有上限，不再无限驻留
  });

  it("「刚完成」动画基线必须带会话标识（跨会话 id 撞车会误闪）", () => {
    expect(SRC).toContain("useRef<{ sid: string; map: Map<string, TaskStatus> } | null>(null)");
    expect(SRC).toContain("if (!prev || prev.sid !== sid) { setJustDoneIds([]); return; }");
  });
});
