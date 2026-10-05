import { describe, expect, it, vi } from "vitest";
import { Tool, ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";
import { AskCoordinator, releaseAsksOnAbort } from "../../gui/src/main/askCoordinator.js";
import { buildAskDecision, dequeueAsk, enqueueAsk, headAsk } from "../../gui/src/renderer/pages/askState.js";
import type { AskUserRequestUI } from "../../gui/src/shared/ipc.js";

function makeRouter(sequence: Array<{ content?: string | null }>) {
  let idx = 0;
  const fetchImpl = vi.fn(async () => {
    const seq = sequence[Math.min(idx, sequence.length - 1)];
    idx++;
    return new Response(JSON.stringify({
      id: "x", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: seq.content ?? null }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return new ModelRouter(
    [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
    () => new ChatClient({ baseUrl: "http://x", fetchImpl }),
  );
}

function askRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new Tool({ name: "ask_user", description: "", parameters: {}, executeFn: async () => "[提示] 需要用户交互" }));
  return reg;
}

function askCall(id: string, question: string) {
  return { id, name: "ask_user", arguments: JSON.stringify({ question, options: ["方案A", "方案B"] }) };
}

function fakeClock() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const cleared: number[] = [];
  return {
    clock: {
      setTimer: (fn: () => void, _ms: number) => {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      },
      clearTimer: (handle: unknown) => {
        const id = handle as number;
        if (pending.delete(id)) { cleared.push(id); }
      },
    },
    cleared,
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) { fn(); }
    },
    pendingCount: () => pending.size,
  };
}

function ui(requestId: string, question: string): AskUserRequestUI {
  return { requestId, agentId: "a1", agentName: "测试Agent", question, options: ["方案A", "方案B"] };
}

describe("ask_user 契约（D5：用户点的选项要能被模型区分）", () => {
  it("渲染层点选项 → 主进程回填 → 模型看到「用户选择：方案A（方案A）」", async () => {
    const decision = buildAskDecision("req-1", "方案A");
    expect(decision.choice, "点选项必须带上 choice，否则模型分不清『点选』与『自填』").toBe("方案A");

    const coordinator = new AskCoordinator();
    const settled: string[] = [];
    coordinator.open({ requestId: "req-1", ownerKey: "s1", agentId: "a1", settle: (d) => { settled.push(d.choice ?? "<no-choice>"); } });
    expect(coordinator.resolve("req-1", decision)).toBe(true);
    expect(settled).toEqual(["方案A"]);

    const loop = new ToolLoop({
      router: makeRouter([{ content: "好" }]),
      registry: askRegistry(),
      onAskUser: async () => decision,
    });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [askCall("t1", "方向？")] });
    expect(r.roundLog[0].result).toBe("用户选择：方案A（方案A）");
    expect(r.roundLog[0].result, "点选项不得退化成『用户回答』").not.toContain("用户回答：");
  });

  it("自填文字（__custom）走另一支：choice 缺席 → 「用户回答：…」，与点选项形状可区分", async () => {
    const decision = buildAskDecision("req-2", "__custom", "我自己想的做法");
    expect(decision.answer).toBe("我自己想的做法");
    expect(decision.choice).toBeUndefined();

    const loop = new ToolLoop({
      router: makeRouter([{ content: "好" }]),
      registry: askRegistry(),
      onAskUser: async () => decision,
    });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [askCall("t1", "方向？")] });
    expect(r.roundLog[0].result).toBe("用户回答：我自己想的做法");
  });

  it("跳过：既不是「用户选择」也不是「用户回答」，且不说成取消", async () => {
    const loop = new ToolLoop({
      router: makeRouter([{ content: "好" }]),
      registry: askRegistry(),
      onAskUser: async () => ({ answer: "", skipped: true }),
    });
    const r = await loop.run({ agentId: "a1", messages: [], initialToolCalls: [askCall("t1", "方向？")] });
    expect(r.roundLog[0].result).toContain("用户未作答（跳过）");
    expect(r.roundLog[0].result).not.toContain("已取消");
  });
});

describe("ask_user 取消（D6：停止必须释放挂起的提问）", () => {
  it("AbortController.abort() 立即 resolve 挂起提问（cancelled=true），无需等超时", async () => {
    const clock = fakeClock();
    const coordinator = new AskCoordinator({ timeoutMs: 300_000, clock: clock.clock });
    let resolveAsk: ((d: { answer: string; skipped?: boolean; cancelled?: boolean }) => void) | null = null;
    coordinator.open({
      requestId: "req-9",
      ownerKey: "s9",
      agentId: "a9",
      settle: (d) => { resolveAsk?.(d); },
    });
    expect(coordinator.size).toBe(1);

    const pending = new Promise<{ answer: string; skipped?: boolean; cancelled?: boolean }>((res) => { resolveAsk = res; });
    const controller = new AbortController();
    const released: string[][] = [];
    releaseAsksOnAbort(controller.signal, "s9", coordinator, (ids) => released.push(ids));

    controller.abort();
    const settled = await Promise.race([
      pending,
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);

    expect(settled, "取消后 100ms 内提问必须被释放（不能挂着等超时）").not.toBeNull();
    expect(settled?.cancelled, "取消形状必须与『用户未作答』可区分").toBe(true);
    expect(settled?.skipped).toBe(true);
    expect(coordinator.size, "取消后不得残留挂起项（否则仍要等超时）").toBe(0);
    expect(released).toEqual([["req-9"]]);
    expect(clock.pendingCount(), "取消必须清掉超时定时器（否则定时器泄漏到 300s）").toBe(0);

    clock.fireAll();
    expect(settled.answer).toBe("");
  });

  it("模型看到的取消形状：作废，不是『用户未作答』", async () => {
    const clock = fakeClock();
    const coordinator = new AskCoordinator({ clock: clock.clock });
    const loop = new ToolLoop({
      router: makeRouter([{ content: "好" }]),
      registry: askRegistry(),
      onAskUser: () => new Promise((resolve) => {
        coordinator.open({ requestId: "req-c", ownerKey: "s1", agentId: "a1", settle: resolve });
      }),
    });
    const running = loop.run({ agentId: "a1", messages: [], initialToolCalls: [askCall("t1", "方向？")] });
    coordinator.cancelByKey("s1");
    const r = await running;
    expect(r.roundLog[0].result).toContain("[已取消]");
    expect(r.roundLog[0].result).not.toContain("用户未作答（跳过）");
  });

  it("非本会话的提问不受影响（按 key 精确释放）", () => {
    const clock = fakeClock();
    const coordinator = new AskCoordinator({ clock: clock.clock });
    const hits: string[] = [];
    coordinator.open({ requestId: "r1", ownerKey: "s1", agentId: "a1", settle: () => hits.push("r1") });
    coordinator.open({ requestId: "r2", ownerKey: "s2", agentId: "a2", settle: () => hits.push("r2") });
    expect(coordinator.cancelByKey("s1")).toEqual(["r1"]);
    expect(hits).toEqual(["r1"]);
    expect(coordinator.size).toBe(1);
  });

  it("超时兜底仍生效，且说清是超时未答（不冒充取消）", () => {
    const clock = fakeClock();
    const coordinator = new AskCoordinator({ timeoutMs: 180_000, clock: clock.clock });
    const got: Array<{ answer: string; skipped?: boolean; cancelled?: boolean }> = [];
    let timedOut = 0;
    coordinator.open({ requestId: "r3", ownerKey: "s3", agentId: "a3", settle: (d) => got.push(d), onTimeout: () => { timedOut++; } });
    clock.fireAll();
    expect(timedOut).toBe(1);
    expect(got).toEqual([{ requestId: "r3", answer: "", skipped: true }]);
    expect(got[0].cancelled).toBeUndefined();
    expect(coordinator.size).toBe(0);
  });

  it("超时上限收敛到 3 分钟（不再 5 分钟）", () => {
    expect(new AskCoordinator().timeout).toBe(180_000);
  });
});

describe("ask_user 并发（D7：两次提问都要能被回答，不孤儿化）", () => {
  it("同一轮两个 ask_user：队列逐条显示，两条 resolver 都被回填", async () => {
    const clock = fakeClock();
    const coordinator = new AskCoordinator({ clock: clock.clock });
    let queue: AskUserRequestUI[] = [];

    queue = enqueueAsk(queue, ui("req-a", "第一个问题？"));
    queue = enqueueAsk(queue, ui("req-b", "第二个问题？"));
    expect(queue).toHaveLength(2);
    for (const req of queue) {
      coordinator.open({ requestId: req.requestId, ownerKey: "s1", agentId: "a1", settle: () => { } });
    }

    const first = headAsk(queue)!;
    expect(first.requestId, "先到的必须先显示，不能被覆盖").toBe("req-a");
    expect(coordinator.resolve(first.requestId, buildAskDecision(first.requestId, "方案A"))).toBe(true);
    queue = dequeueAsk(queue, first.requestId);

    const second = headAsk(queue)!;
    expect(second.requestId, "第二个提问必须仍在队列里等回答").toBe("req-b");
    expect(coordinator.resolve(second.requestId, buildAskDecision(second.requestId, "方案B"))).toBe(true);
    queue = dequeueAsk(queue, second.requestId);

    expect(coordinator.size, "两条都被回答后不得残留").toBe(0);
    expect(queue).toEqual([]);
  });

  it("tool_loop 同轮并发两个 ask_user：两个 onAskUser 都被各自回答，无孤儿", async () => {
    const clock = fakeClock();
    const coordinator = new AskCoordinator({ clock: clock.clock });
    const opened: string[] = [];
    const loop = new ToolLoop({
      router: makeRouter([{ content: "两个都答完了" }]),
      registry: askRegistry(),
      onAskUser: (req) => new Promise((resolve) => {
        const requestId = `req-${req.question}`;
        opened.push(requestId);
        coordinator.open({ requestId, ownerKey: "s1", agentId: req.agentId, settle: resolve });
      }),
    });

    const running = loop.run({
      agentId: "a1",
      messages: [],
      initialToolCalls: [askCall("t1", "第一问"), askCall("t2", "第二问")],
    });
    await vi.waitFor(() => expect(opened).toHaveLength(2));

    for (const id of [...opened]) {
      expect(coordinator.resolve(id, buildAskDecision(id, "方案A")), `${id} 必须能被回答`).toBe(true);
    }
    const r = await running;
    expect(r.roundLog).toHaveLength(2);
    for (const d of r.roundLog) {
      expect(d.result).toContain("用户选择：方案A");
    }
    expect(coordinator.size).toBe(0);
  });

  it("重复投递同一 requestId 不入队两次（不产生第二个幽灵问题）", () => {
    const q = enqueueAsk([], ui("req-x", "q"));
    const q2 = enqueueAsk(q, ui("req-x", "q"));
    expect(q2).toHaveLength(1);
    expect(q2[0].requestId).toBe("req-x");
  });

  it("超时/取消按 requestId 精确出队，不会误弹出下一题", () => {
    let q = enqueueAsk(enqueueAsk([], ui("req-1", "a")), ui("req-2", "b"));
    expect(dequeueAsk(q, "req-unknown")).toBe(q);
    q = dequeueAsk(q, "req-1");
    expect(headAsk(q)?.requestId).toBe("req-2");
    q = dequeueAsk(q, "req-2");
    expect(headAsk(q)).toBeNull();
  });
});