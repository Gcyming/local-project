/**
 * tests/core-ts/a1071-maxtokens.spec.ts — #229「主 Agent 400 / 子代理正常」的回归守卫。
 *
 * 三件事各有一条守卫，且都锁**行为**而非源码文本：
 *   ① `capMaxTokensForModel` —— 按实际模型封顶（agnes 实测 >65536 必 400）；
 *   ② `ModelRouter.withModel` —— **接线**：封顶必须真的发生在路由唯一收口上（否则等于没修）；
 *   ③ `isUnrecognizedParamError` —— 收窄判据：agnes 的越界 400 体不得再被误判成
 *      "思考参数不被识别"（那会白花一次剥参重试，还会把真正的病因埋进日志）。
 *
 * 一手证据（2026-09-23 对 `https://api.agnes-ai.cn/v1/chat/completions` 实测，模型 agnes-3.0-flash）：
 *   不传 → 200；65000 → 200；65536 → 200；1000000 → 400
 *   `{"error":{"message":"max_tokens 不能超过 65536 (request id: ...)","type":"AgnesAI_error","param":"","code":"invalid_request"}}`
 */
import { describe, it, expect } from "vitest";
import { capMaxTokensForModel, applyMaxTokensCap, maxOutputCeilingOf } from "../../core-ts/src/llm/maxTokens.js";
import { ModelRouter } from "../../core-ts/src/router.js";
import type { RouteEntry } from "../../core-ts/src/router.js";
import { ChatClient, isUnrecognizedParamError, UpstreamError } from "../../core-ts/src/llm/client.js";
import type { ChatRequest } from "../../shared/gen/schemas.js";

/** agnes 参数越界的**真实响应体**（原样，含 request id 之外的字段结构） */
const AGNES_MAX_TOKENS_400 = JSON.stringify({
  error: {
    message: "max_tokens 不能超过 65536 (request id: 20260923045854827194932KeRNdaKH)",
    type: "AgnesAI_error",
    param: "",
    code: "invalid_request",
  },
});

describe("A-1071 ①：max_tokens 按**实际模型**封顶（纯判据）", () => {
  it("agnes：超过官方上限（65536）的额度被下压", () => {
    expect(maxOutputCeilingOf("agnes-3.0-flash")).toBe(65536);
    expect(capMaxTokensForModel("agnes-3.0-flash", 1_000_000)).toBe(65536);
    expect(capMaxTokensForModel("agnes-2.5-flash", 128000)).toBe(65536);
  });

  it("等号不下压（实测 65536 被上游接受，只有**超过**才 400）", () => {
    expect(capMaxTokensForModel("agnes-3.0-flash", 65536)).toBe(65536);
  });

  it("只下压不放大：低于上限的额度原样返回", () => {
    expect(capMaxTokensForModel("agnes-3.0-flash", 8000)).toBe(8000);
  });

  it("调用方没给 → 不发明值（「不传 max_tokens = 上游默认」是安全语义，不许被改写）", () => {
    expect(capMaxTokensForModel("agnes-3.0-flash", undefined)).toBeUndefined();
    expect(capMaxTokensForModel("agnes-3.0-flash", null)).toBeUndefined();
    // 子代理路径就是这样：toolLoop.run 不传 maxTokens → 请求体里根本没有这个字段
    expect("max_tokens" in applyMaxTokensCap({ messages: [] }, "agnes-3.0-flash")).toBe(false);
  });

  it("非法值（0 / 负数 / NaN / 非数字）→ undefined，不构造出可发送的越界值", () => {
    expect(capMaxTokensForModel("agnes-3.0-flash", 0)).toBeUndefined();
    expect(capMaxTokensForModel("agnes-3.0-flash", -1)).toBeUndefined();
    expect(capMaxTokensForModel("agnes-3.0-flash", Number.NaN)).toBeUndefined();
    expect(capMaxTokensForModel("agnes-3.0-flash", Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("能力表未收录的模型 → 不猜上限，原样放行", () => {
    expect(maxOutputCeilingOf("totally-unknown-model-xyz")).toBeUndefined();
    expect(capMaxTokensForModel("totally-unknown-model-xyz", 999_999)).toBe(999_999);
  });

  it("不改入参：降级链里 payload 会被逐条路由复用，就地改写会让上一条的额度泄漏给下一条", () => {
    const payload: { messages: unknown[]; max_tokens?: number } = { messages: [], max_tokens: 1_000_000 };
    const out = applyMaxTokensCap(payload, "agnes-3.0-flash");
    expect(payload.max_tokens).toBe(1_000_000);
    expect(out.max_tokens).toBe(65536);
    expect(out).not.toBe(payload);
  });
});

/** 记录每次实际发出的请求体（与 reasoning-params.spec 同一范式） */
function makeRouter(): { router: ModelRouter; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  const router = new ModelRouter([], ((_route: RouteEntry) => ({
    chat: async (payload: ChatRequest) => {
      seen.push(payload as unknown as Record<string, unknown>);
      return { response: { choices: [{ message: { role: "assistant", content: "ok" } }] } };
    },
  })) as never);
  return { router, seen };
}

describe("A-1071 ②：接线——封顶必须发生在路由唯一收口（否则等于没修）", () => {
  it("按 A 的额度要、落到 agnes 上 → 真正发出的请求体里 max_tokens 已被压到 65536", async () => {
    const { router, seen } = makeRouter();
    // 模拟真实场景：用户选中的模型给得起 12.8 万输出（如 dots / gpt），降级池落到 agnes
    router.add({ name: "AGNES:agnes-3.0-flash", baseUrl: "https://api.agnes-ai.cn", apiKey: "k", model: "agnes-3.0-flash", kind: "cloud", priority: 1, roles: ["chat"] });

    await router.chat({ messages: [{ role: "user", content: "hi" }], max_tokens: 128_000 } as ChatRequest);

    expect(seen).toHaveLength(1);
    expect(seen[0].max_tokens).toBe(65536);
  });

  it("反向守卫：模型给得起就不许动它的额度（不是「一律压成 65536」）", async () => {
    const { router, seen } = makeRouter();
    router.add({ name: "AGNES:agnes-3.0-flash", baseUrl: "https://api.agnes-ai.cn", apiKey: "k", model: "agnes-3.0-flash", kind: "cloud", priority: 1, roles: ["chat"] });

    await router.chat({ messages: [{ role: "user", content: "hi" }], max_tokens: 4096 } as ChatRequest);
    expect(seen[0].max_tokens).toBe(4096);
  });
});

describe("A-1071 ③：400 判据收窄——越界的 400 不再被误判成「思考参数不被识别」", () => {
  it("agnes 的 max_tokens 越界 400 体 → 不再命中（此前被 `\"param\":\"\"` + `invalid_request` 骗过）", () => {
    expect(isUnrecognizedParamError(AGNES_MAX_TOKENS_400)).toBe(false);
  });

  it("真正「参数不被识别」的上游措辞仍然命中（收窄不等于关掉）", () => {
    expect(isUnrecognizedParamError("Unsupported parameter: chat_template_kwargs")).toBe(true);
    expect(isUnrecognizedParamError("Unrecognized request argument supplied: reasoning_effort")).toBe(true);
    expect(isUnrecognizedParamError("该模型不支持 enable_thinking")).toBe(true);
    expect(isUnrecognizedParamError("无效的思考参数")).toBe(true);
  });

  it("其它 400（模型不可用 / 内容审查）本来就不该命中", () => {
    expect(isUnrecognizedParamError("Model is unavailable")).toBe(false);
    expect(isUnrecognizedParamError("content policy violation")).toBe(false);
    expect(isUnrecognizedParamError("")).toBe(false);
  });

  it("判据是**两段与**：光有思考字眼、没有「不认识」的字眼 → 不命中（否则凡 400 都被白剥一次）", () => {
    // 上游也用 thinking 字样描述**业务**错误（预算/限流），那不代表"它不认识这个参数"
    expect(isUnrecognizedParamError(JSON.stringify({
      error: { message: "thinking budget exceeded the model limit", type: "AgnesAI_error", code: "rate_limit_exceeded" },
    }))).toBe(false);
  });

  it("行为级：越界 400 只发**一次**请求（不再白花一次剥参重试）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(AGNES_MAX_TOKENS_400, { status: 400, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new ChatClient({ baseUrl: "https://api.agnes-ai.cn", apiKey: "k", fetchImpl });

    // 请求体带思考参数（agnes 走 chat_template_kwargs）——正是原先误触发剥参重试的形态
    await expect(client.chat({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1_000_000,
      chat_template_kwargs: { enable_thinking: true },
    } as unknown as ChatRequest)).rejects.toBeInstanceOf(UpstreamError);

    expect(calls).toBe(1);
  });
});
