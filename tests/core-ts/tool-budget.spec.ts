





import { describe, expect, it, beforeEach } from "vitest";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { getRegistry, resetRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";


function pingForeverRouter(): ModelRouter {
  return {
    chat: async () => ({
      response: {
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: "{}" } }],
          },
        }],
      },
    }),
  } as unknown as ModelRouter;
}

function makeLoop(router: ModelRouter) {
  return new ToolLoop({ router, registry: getRegistry(), sandbox: null });
}

beforeEach(() => {
  resetRegistry();
  const reg = getRegistry();
  reg.register(new Tool({
    name: "ping",
    description: "测试用空操作工具",
    parameters: { type: "object", properties: {} },
    executeFn: async () => "ok",
    permissions: ["read"],
  }));
});

const MSGS = [{ role: "user", content: "开始任务" }] as const;

describe("任务预算护栏（ToolLoop.run）", () => {
  it("maxToolCalls：达到上限即收束，保留已产出内容并标注 budgetExhausted", async () => {
    const loop = makeLoop(pingForeverRouter());
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [...MSGS] as never,
      initialToolCalls: [],
      maxToolCalls: 2,
    });
    expect(r.budgetExhausted).toBe(true);
    expect(r.budgetReason).toContain("工具调用");
    expect(r.text).toContain("[预算提示]");
    
    expect(r.roundLog.length).toBe(2);
  });

  it("maxTotalTokens：token 预算耗尽即收束", async () => {
    const loop = makeLoop(pingForeverRouter());
    
    const big = "a".repeat(1000);
    const r = await loop.run({
      agentId: "a1",
      messages: [{ role: "user", content: big }] as never,
      initialToolCalls: [],
      maxTotalTokens: 400,
    });
    expect(r.budgetExhausted).toBe(true);
    expect(r.budgetReason).toContain("token");
  });

  it("maxWallClockMs：时长超限即收束", async () => {
    const loop = makeLoop(pingForeverRouter());
    const r = await loop.run({
      agentId: "a1",
      messages: [...MSGS] as never,
      initialToolCalls: [],
      maxWallClockMs: 1,
    });
    expect(r.budgetExhausted).toBe(true);
    expect(r.budgetReason).toContain("时长");
  });

  it("未设预算（缺省）：不触发 budgetExhausted（正常收敛到无工具调用）", async () => {
    const router: ModelRouter = {
      chat: async () => ({
        response: { choices: [{ index: 0, message: { role: "assistant", content: "完成" } }] },
      }),
    } as unknown as ModelRouter;
    const loop = makeLoop(router);
    const r = await loop.run({ agentId: "a1", messages: [...MSGS] as never, initialToolCalls: [] });
    expect(r.budgetExhausted).toBeFalsy();
    expect(r.text).toBe("完成");
  });
});
