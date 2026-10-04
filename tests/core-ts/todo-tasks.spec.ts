
















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

const MARK = "__spec_todo_";
let sid = "";

function pathOf(sessionId: string): string {
  return join(DATA_DIR, `todos_${sessionId}.json`);
}


function readItems(sessionId: string): Array<{ id: string; content: string; status: string; completedAt?: string }> {
  return (JSON.parse(readFileSync(pathOf(sessionId), "utf8")) as { items: Array<{ id: string; content: string; status: string; completedAt?: string }> }).items;
}


function cleanMarked(): void {
  let names: string[] = [];
  try { names = readdirSync(DATA_DIR); } catch { return; }
  for (const n of names) {
    if (n.includes(MARK)) {
      try { rmSync(join(DATA_DIR, n), { force: true }); } catch {  }
    }
  }
}

let reg: ToolRegistry;




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
    const ghost = pathOf(""); 
    const hadGhost = existsSync(ghost);
    
    const out = await reg.get("todo_write")!.executeFn({ action: "add", items: [{ content: "会被丢弃的任务" }] });
    expect(out).toContain("[错误]");
    expect(out).toContain("sessionId");
    
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
    expect(existsSync(pathOf(forged))).toBe(false); 
    expect(readItems(sid)).toHaveLength(1);         
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









describe("待办面板源码约定（防回归）", () => {
  const SRC_RAW = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/pages/RightSidebar.tsx"), "utf8");
  const MAIN = readFileSync(join(PROJECT_ROOT, "gui/src/main/index.ts"), "utf8");
  


  const SRC = SRC_RAW.split("\n")
    .filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
    .join("\n");

  it("展开箭头方向：展开 90°（朝下）/ 收起 0°（朝右）", () => {
    expect(SRC).toContain("rotate={collapsedTodos ? 0 : 90}");
    expect(SRC).not.toContain("rotate={collapsedTodos ? 90 : 0}");
  });

  it("会话未就绪不得读待办（loadPersisted / flushPersist / 拉取三处都要有守卫）", () => {
    expect(SRC).toContain("const sessionReady = Boolean(props.sessionId)");
    
    expect((SRC.match(/if \(!props\.agentId \|\| !props\.sessionId\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("订阅过滤必须两侧严格匹配（此前 props.sessionId 为空时会跳过整条守卫）", () => {
    expect(SRC).toContain("if (!props.sessionId || !data.sessionId || data.sessionId !== props.sessionId)");
    expect(SRC).not.toContain("if (props.sessionId && data.sessionId !== props.sessionId)");
  });

  it("主进程兜底：空 sessionId 直接拒绝，且读取统一走 todoStore（不再手搓路径）", () => {
    expect(MAIN).toContain("loadTodos 收到空 sessionId，已拒绝");
    
    expect(MAIN).toContain("readTodos(sid)");
    expect(MAIN).not.toContain("`todos_${sid}.json`");
  });

  it("A-980-R29：会话/Agent/工作区删除时必须清 Plan + 待办文件（此前只增不减）", () => {
    expect(MAIN).toContain("function purgeSessionPlanning(");
    expect(MAIN).toContain("planStore.delete(sessionId)");
    expect(MAIN).toContain("removeTodos(sessionId)");
    
    expect((MAIN.match(/purgeSessionPlanning\(/g) ?? []).length).toBeGreaterThanOrEqual(4); 
    
    expect(MAIN).toMatch(/filter\(\(s\) => s\.agentId === agentId\)/);
  });

  it("A-980-R29：plan_create 真 Plan 不被 todo 派生镜像顶掉", () => {
    expect(MAIN).toContain("function putPlan(");
    expect(MAIN).toContain('plan.source === "todo" && prev?.source === "plan"');
    expect(MAIN).toContain("PLAN_STORE_MAX"); 
  });

  it("「刚完成」动画基线必须带会话标识（跨会话 id 撞车会误闪）", () => {
    expect(SRC).toContain("useRef<{ sid: string; map: Map<string, TaskStatus> } | null>(null)");
    expect(SRC).toContain("if (!prev || prev.sid !== sid) { setJustDoneIds([]); return; }");
  });
});
