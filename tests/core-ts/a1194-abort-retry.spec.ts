import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatClient, UpstreamError, abortableWait } from "../../core-ts/src/llm/client.js";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import { getRegistry, resetRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";

const ROOT = resolve(__dirname, "../..");
const readText = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * A-1194 终止按钮响应性（P1）：重试退避期间 abort 必须立即生效。
 *
 * 病根：fetchWithRetry 的两次退避 `await sleep(...)` 原先不响应 AbortSignal。
 * 429（Retry-After 最长 60s，退避表 [5,15,30,60]s）期间用户点「停止」：
 * abort 已发出但 sleep 要等满 → 下一轮循环开头才检查 → 用户看到按钮一直转圈
 * （ChatPanel 的 stopping 状态要等流真正结束才复位）=「停不下来」。
 *
 * 判据：abort 后必须在很短时间（<1.5s）内 settle 为「已取消」，
 * 且不再发起后续尝试（fetch 只调 1 次）。
 * 未修复时：要等满退避（5s / 60s）→ 超时判红。
 */

const FAST_ABORT_BUDGET_MS = 1500;

describe("A-1194 P1：429 重试退避可被 abort 打断", () => {
  it("Retry-After: 60 退避期间 abort → 立即 reject 为已取消（不等满 60s）", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } }),
    ) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });

    const p = client
      .chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {}, controller.signal)
      .then(() => null)
      .catch((e: unknown) => e);

    // 等第一个响应处理完、进入退避 sleep
    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    controller.abort();
    const out = await p;
    const waited = Date.now() - t0;

    expect(waited).toBeLessThan(FAST_ABORT_BUDGET_MS);
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).message).toContain("取消");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 无 Retry-After（退避表首项 5s）期间 abort → 立即 reject 且不重发", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("limited", { status: 429 })) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });

    const p = client
      .chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {}, controller.signal)
      .then(() => null)
      .catch((e: unknown) => e);

    await new Promise((r) => setTimeout(r, 60));
    const t0 = Date.now();
    controller.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(FAST_ABORT_BUDGET_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("网络错误退避（第二次 0~3s）期间 abort → 立即 reject，不等满退避", async () => {
    // 固定 jitter：第一次退避 330ms、第二次 990ms（可确定性区分「修/未修」）
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.33);
    try {
      const controller = new AbortController();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls >= 2) {
          // 第二次失败后即进入 ~990ms 退避，30ms 后假装用户点了「停止」
          setTimeout(() => controller.abort(), 30);
        }
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });

      const t0 = Date.now();
      const out = await client
        .chatStream({ messages: [{ role: "user", content: "hi" }] }, () => {}, controller.signal)
        .then(() => null)
        .catch((e: unknown) => e);
      const waited = Date.now() - t0;

      expect(calls).toBe(2);
      // 修后 ≈360ms（330 退避 + 30 触发）；未修 ≈1320ms（等满 990ms 剩余退避）
      expect(waited).toBeLessThan(800);
      expect(out).toBeInstanceOf(UpstreamError);
      expect((out as UpstreamError).message).toContain("取消");
    } finally {
      rand.mockRestore();
    }
  });

  it("abortableWait：abort 立即 reject；未 abort 随内部 promise 正常 resolve", async () => {
    const ac = new AbortController();
    const never = new Promise<void>(() => {});
    const p = abortableWait(never, ac.signal).then(() => null).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const out = await p;
    expect(out).toBeInstanceOf(UpstreamError);
    expect((out as UpstreamError).message).toContain("取消");

    const ok = await abortableWait(Promise.resolve(42));
    expect(ok).toBe(42);
  });
});

describe("A-1194 P3：限流冷却等待可被 abort 打断（接线形状）", () => {
  it("acquire 被 abortableWait 包裹（防回归为裸 await acquire）", () => {
    const src = readText("core-ts/src/llm/client.ts");
    expect(src).toMatch(/abortableWait\(\s*getSharedRpmLimiter\(\)\.acquire/);
  });
});

/**
 * P4：signal 全链穿透——GUI 停止按钮的 abort 必须能到达「传唤 / 强制工具轮 / 非流式 chat」
 * 这些内部调用。此前它们全程无 signal：模型卡住时点停止对这几条路径完全无效（只能等 5min 超时）。
 * 深层调用链无法轻量行为化 ⇒ 用接线形状断言钉住每个断点。
 */
describe("A-1194 P4：signal 穿透内部调用（接线形状）", () => {
  it("client.ts：四个 client.chat 都收 externalSignal 并透传给重试层", () => {
    const src = readText("core-ts/src/llm/client.ts");
    const hits = src.match(/async chat\(payload: ChatRequest, externalSignal\?: AbortSignal\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/this\.post\(this\.endpoint\("chat"\), payload, RETRY_429_BACKOFF\.length, externalSignal\)/);
    expect(src).toMatch(/this\.post\(this\.endpoint\(\), this\.toAnthropicPayload\(payload\), externalSignal\)/);
  });

  it("router.ts：chat 接受 signal、透传 client、abort 时不降级", () => {
    const src = readText("core-ts/src/router.ts");
    expect(src).toMatch(/async chat\(payload: ChatRequest, signal\?: AbortSignal\)/);
    expect(src).toMatch(/createClient\(route\)\.chat\(this\.withModel\(payload, route\), signal\)/);
    expect(src).toMatch(/if \(signal\?\.aborted\) \{ throw e; \}/);
  });

  it("engine.ts：chat 主路径带 signal（路由解析 / 工具轮 / 非流式调用）", () => {
    const src = readText("core-ts/src/services/engine.ts");
    expect(src).toMatch(/resolveRouteInternal\(opts\.agent, opts\.signal\)/);
    expect(src).toMatch(/loop\.run\(\{[^}]*signal: opts\.signal/);
    expect(src).toMatch(/router\.chat\(withModel\(payload, route!\), opts\.signal\)/);
  });

  it("tool_loop.ts：非流式 run 也收 signal（Options / 工具执行 / 模型轮）", () => {
    const src = readText("core-ts/src/tool_loop.ts");
    expect(src).toMatch(/executePendingTools\(opts\.messages, pending, opts\.agentId, dedup, agentName, opts\.sessionId, opts\.signal\)/);
    expect(src).toMatch(/this\.router\.chat\(payload, opts\.signal\)/);
  });

  it("chat.ts：传唤与强制工具轮都带 signal", () => {
    const src = readText("core-ts/src/services/chat.ts");
    expect(src).toMatch(/this\.engine\.chat\(\{[\s\S]{0,400}?signal,/);
    expect(src).toMatch(/runForcedRound\(agent, req\.message, req\.sessionId, signal\)/);
    expect(src).toMatch(/async runForcedRound\([\s\S]{0,120}?signal\?: AbortSignal/);
  });
});

/**
 * P5：工具执行中途 abort → 立即短路（不再干等飞行中的工具）。
 * 场景：模型发起一个 1.5s 的慢工具，用户 100ms 后点「停止」。
 * 修后：abortableToValue 立即以「已中断」占位 → Promise.all settle → 循环收束 interrupted。
 * 未修：整轮 Promise.all 要等慢工具跑完（≈1.5s）才走到 abort 检查 → 超预算判红。
 */
describe("A-1194 P5：飞行中工具被 abort 立即短路", () => {
  beforeEach(() => {
    resetRegistry();
  });

  it("1.5s 慢工具执行 100ms 后 abort → 循环 <500ms 内收束为 interrupted", async () => {
    const reg = getRegistry();
    const ac = new AbortController();
    let abortAt = 0;
    reg.register(new Tool({
      name: "slow_tool",
      description: "测试用慢工具",
      parameters: { type: "object", properties: {} },
      executeFn: async () => {
        setTimeout(() => { abortAt = Date.now(); ac.abort(); }, 100);
        await new Promise((r) => setTimeout(r, 1500));
        return "done";
      },
      permissions: ["read"],
    }));
    const router = {
      chat: async () => ({
        response: {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "t1", type: "function", function: { name: "slow_tool", arguments: "{}" } }],
            },
          }],
        },
      }),
      chatStream: async () => ({ text: "", chunks: 0, model: "m" }),
    } as unknown as ModelRouter;
    const loop = new ToolLoop({ router, registry: reg, sandbox: null });

    const r = await loop.run({
      agentId: "a1",
      agentName: "A",
      messages: [{ role: "user", content: "开始" }] as never,
      initialToolCalls: [],
      signal: ac.signal,
    });

    expect(abortAt).toBeGreaterThan(0);
    expect(Date.now() - abortAt).toBeLessThan(500);
    expect(r.interrupted).toBe(true);
  });
});
