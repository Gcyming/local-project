/**
 * tests/core-ts/tool-loop-usage.spec.ts — A-974-R7：工具循环「计费口径 vs 窗口口径」回归。
 *
 * 背景（用户实测）：正文输出后 GUI 上下文环/右栏直接爆到 1.1M（实际窗口仅约 600K）。
 * 根因：工具循环**每一轮都全量重发历史**，`usage`（跨轮累计）被当成窗口占用 → N 轮叠加。
 * 修复：新增 `lastUsage`（仅最近一轮），窗口占用取它。
 *
 * 本测试锁死两条语义，防止未来把两者再次混用：
 *  1. `usage.prompt_tokens` = 各轮**累加**（计费用，各轮都付费）；
 *  2. `lastUsage.prompt_tokens` = **最后一轮**（窗口占用用，不随轮次膨胀）。
 * 全部走 fake router（零真实网络）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { getRegistry, resetRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";

/** 前 N 轮各要一次 ping 工具、且每轮上报增量 prompt；第 N+1 轮收尾（无工具调用） */
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

    // 3 轮工具轮（各 1000）+ 1 轮收尾（3000）→ 累计 6000
    expect(r.usage?.prompt_tokens).toBe(perRound * 3 + finalPrompt);
    // 窗口占用只能取最后一轮 3000（若误用累计值，轮次越多越爆表）
    expect(r.lastUsage?.prompt_tokens).toBe(finalPrompt);
    expect(r.lastUsage?.cache_read_tokens).toBe(finalPrompt);
    // 窗口值必须严格小于累计值（这正是此前爆表的根因）
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
    // 永远要工具 → 触发轮次上限收束
    const loop = makeLoop(roundsRouter(Number.MAX_SAFE_INTEGER, 100, 100));
    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "任务" }] as never,
      initialToolCalls: [],
      maxToolCalls: 3, // 3 次工具调用后收束
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
      maxTotalTokens: 100, // 第 2 轮即触发预算收束
    });
    expect(r.budgetExhausted).toBe(true);
    expect(r.lastUsage?.prompt_tokens).toBe(1500);
  });
});
