import { beforeEach, describe, expect, it } from "vitest";
import { agentLoopBudget } from "../../core-ts/src/services/chat.js";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { getRegistry, resetRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";

/**
 * A-1196 L3（需求：高自由度创造模式「自己定义 Agent-Loop」的起点）：
 *   `agent.loop_config` → 本请求循环预算（maxRounds / maxToolCalls / maxTotalTokens / maxWallClockMs）。
 * 防的回归：配置写了不生效（透传断链）或非法值把轮数静默放大。
 */
describe("A-1196 L3：agentLoopBudget（loop_config 读取）", () => {
  it("未配置 / 非对象 ⇒ 全 undefined（不覆盖默认）", () => {
    expect(agentLoopBudget(undefined)).toEqual({});
    expect(agentLoopBudget(null)).toEqual({});
    expect(agentLoopBudget({})).toEqual({});
    expect(agentLoopBudget({ loop_config: "oops" })).toEqual({});
    expect(agentLoopBudget({ loop_config: [1, 2] })).toEqual({});
  });

  it("正常读取（数字与数字串都认）", () => {
    const b = agentLoopBudget({ loop_config: { maxRounds: 60, maxToolCalls: "500" } });
    expect(b.maxRounds).toBe(60);
    expect(b.maxToolCalls).toBe(500);
    expect(b.maxTotalTokens).toBeUndefined();
    expect(b.maxWallClockMs).toBeUndefined();
  });

  it("非法值丢弃、超上限封顶（不许静默放大）", () => {
    const b = agentLoopBudget({
      loop_config: { maxRounds: -3, maxToolCalls: 0, maxWallClockMs: 999 * 24 * 60 * 60 * 1000 },
    });
    expect(b.maxRounds).toBeUndefined();
    expect(b.maxToolCalls).toBeUndefined();
    expect(b.maxWallClockMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("A-1196 L3：ToolLoop.maxRounds 真的生效", () => {
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

  it("maxRounds=2：ping-forever 在第 2 轮收束，收束文本按实际上限（不是默认 500）", async () => {
    const loop = new ToolLoop({ router: pingForeverRouter(), registry: getRegistry(), sandbox: null });
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "开始" }] as never,
      initialToolCalls: [],
      maxRounds: 2,
    });
    expect(r.rounds).toBe(2);
    expect(r.text).toContain("上限（2 轮）");
  });

  it("maxRounds=1 边界：一轮即收束", async () => {
    const loop = new ToolLoop({ router: pingForeverRouter(), registry: getRegistry(), sandbox: null });
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "开始" }] as never,
      initialToolCalls: [],
      maxRounds: 1,
    });
    expect(r.rounds).toBe(1);
    expect(r.text).toContain("上限（1 轮）");
  });
});
