











import { describe, expect, it, beforeEach } from "vitest";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { getRegistry, resetRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";


function roundsRouter(rounds: number, perRoundPrompt: number, finalPrompt: number): ModelRouter {
  let n = 0;
  return {
    chat: async () => {
      n += 1;
      const isFinal = n > rounds;
      return {
        response: {
          choices: [{
            index: 0,
            message: isFinal
              ? { role: "assistant", content: "完成" }
              : { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: { name: "ping", arguments: "{}" } }] },
          }],
          usage: {
            prompt_tokens: isFinal ? finalPrompt : perRoundPrompt,
            completion_tokens: 1,
            cache_read_tokens: isFinal ? finalPrompt : perRoundPrompt,
          },
        },
      };
    },
  } as unknown as ModelRouter;
}

function makeLoop(router: ModelRouter) {
  return new ToolLoop({ router, registry: getRegistry(), sandbox: null });
}

beforeEach(() => {
  resetRegistry();
  getRegistry().register(new Tool({
    name: "ping",
    description: "测试用空操作工具",
    parameters: { type: "object", properties: {} },
    executeFn: async () => "ok",
    permissions: ["read"],
  }));
});

describe("工具循环 usage 口径（A-974-R7）", () => {
  it("多轮：usage 累加（计费）而 lastUsage 只取最后一轮（窗口）", async () => {
    const perRound = 1000;
    const finalPrompt = 3000;
    const loop = makeLoop(roundsRouter(3, perRound, finalPrompt));
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "任务" }] as never,
      initialToolCalls: [],
    });

    
    expect(r.usage?.prompt_tokens).toBe(perRound * 3 + finalPrompt);
    
    expect(r.lastUsage?.prompt_tokens).toBe(finalPrompt);
    expect(r.lastUsage?.cache_read_tokens).toBe(finalPrompt);
    
    expect(r.lastUsage!.prompt_tokens!).toBeLessThan(r.usage!.prompt_tokens!);
  });

  it("单轮（无工具调用）：lastUsage 与 usage 一致（单请求无叠加）", async () => {
    const loop = makeLoop(roundsRouter(0, 0, 4200));
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "任务" }] as never,
      initialToolCalls: [],
    });
    expect(r.usage?.prompt_tokens).toBe(4200);
    expect(r.lastUsage?.prompt_tokens).toBe(4200);
  });

  it("轮次上限收束：lastUsage 仍为最后一轮的值（不因收束丢失窗口口径）", async () => {
    
    const loop = makeLoop(roundsRouter(Number.MAX_SAFE_INTEGER, 100, 100));
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "任务" }] as never,
      initialToolCalls: [],
      maxToolCalls: 3, 
    });
    expect(r.lastUsage?.prompt_tokens).toBe(100);
    expect(r.usage?.prompt_tokens).toBeGreaterThan(100);
  });

  it("预算耗尽收束：lastUsage 一并透传（窗口口径不丢）", async () => {
    const loop = makeLoop(roundsRouter(Number.MAX_SAFE_INTEGER, 1500, 1500));
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "任务" }] as never,
      initialToolCalls: [],
      maxTotalTokens: 100, 
    });
    expect(r.budgetExhausted).toBe(true);
    expect(r.lastUsage?.prompt_tokens).toBe(1500);
  });
});
