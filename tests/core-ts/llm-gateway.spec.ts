/**
 * tests/core-ts/llm-gateway.spec.ts — LLM 网关（gateway-ts/src/llmGateway.ts）测试。
 * 不真发 HTTP：注入 mock providers 表 + mock clientFactory，验证：
 * - 路由构建（全量 provider → byModel/byName/listModels）
 * - resolveModel 的 provider:model 语法 + 纯模型名匹配 + 未命中
 * - chat 非流式：model 覆盖 + OpenAI 响应回显
 * - chatStream：OpenAI SSE chunk 格式 + reasoning_content + usage 收尾
 */
import { describe, expect, it } from "vitest";
import { LlmGateway, LlmGatewayError } from "../../gateway-ts/src/llmGateway.js";
import { UpstreamError } from "../../core-ts/src/llm/client.js";
import { LiveProbeCache } from "../../core-ts/src/probe-live.js";
import type { ProviderConfig } from "../../core-ts/src/services/engine.js";
import type { ChatMessage, ChatResponse } from "../../shared/gen/schemas.js";

/**
 * 取首个 choice 的 message。
 *
 * `ChatChoice.message` 在 `shared/gen/schemas.ts` 里声明为 **optional**（wire 上确实可能没有它，
 * 例如只带 finish_reason 的响应），所以 `resp.choices[0].message.content` 是潜在的 undefined
 * 解引用 —— 这正是 tsc 常年报的 TS2532。
 *
 * 这里用**显式抛错**而不是 `?.`：用例要断言具体文本，message 缺失本身就是失败。
 * 写成 `resp.choices[0].message?.content` 的话，失败信息会退化成
 * `expected undefined to be 'hi'`，看不出"其实整个 message 没了"。
 */
function firstMessage(r: ChatResponse): ChatMessage {
  const m = r.choices[0]?.message;
  if (!m) { throw new Error("响应缺少 choices[0].message（schema 里该字段可选，但本用例要求它存在）"); }
  return m;
}

/** 构造测试 providers 表（模拟 providers.enc.json 解密结果） */
function makeProviders(): Record<string, ProviderConfig> {
  return {
    openai: {
      api_base: "https://api.openai.com/v1",
      api_key: "sk-openai",
      model: "gpt-4o",
      api_format: "openai",
      models: [
        { id: "gpt-4o", selected: true, price_in_usd: 2.5, price_out_usd: 10 },
        { id: "gpt-4o-mini", selected: true, price_in_usd: 0.15, price_out_usd: 0.6 },
        { id: "dall-e-3", selected: true }, // 非对话，应被 isChatCapableModel 过滤
      ],
    },
    anthropic: {
      api_base: "https://api.anthropic.com",
      api_key: "sk-ant",
      model: "claude-sonnet-4-20250514",
      api_format: "anthropic",
      models: [
        { id: "claude-sonnet-4-20250514", selected: true, price_in_usd: 3, price_out_usd: 15 },
      ],
    },
    deepseek: {
      api_base: "https://api.deepseek.com/v1",
      api_key: "sk-ds",
      // `model` 是 ProviderConfig 的**必填**字段（默认模型）。此处原先漏了它 ——
      // tsc 一直报 TS2741，但门禁常年是红的，于是"这个 fixture 其实构造不出合法配置"
      // 这件事一直没人发现。补上，让 fixture 与真实配置同形。
      model: "deepseek-chat",
      api_format: "openai",
      models: [
        { id: "deepseek-chat", selected: true, price_in_usd: 0.27, price_out_usd: 1.1 },
        { id: "deepseek-chat", selected: false }, // 重复且未启用，应被去重/过滤
      ],
    },
    _local_models: {} as unknown as ProviderConfig, // 应被排除
  };
}

describe("LlmGateway 路由构建", () => {
  it("遍历所有 provider 注入路由，排除 _local_models 与非对话模型", () => {
    const g = new LlmGateway({ providers: makeProviders() });
    const names = g.routeList.map((r) => r.name).sort();
    expect(names).toEqual([
      "anthropic:claude-sonnet-4-20250514",
      "deepseek:deepseek-chat",
      "openai:gpt-4o",
      "openai:gpt-4o-mini",
    ]);
    // dall-e-3 被 isChatCapableModel 过滤
    expect(names.some((n) => n.includes("dall-e"))).toBe(false);
    // _local_models 被排除
    expect(names.some((n) => n.includes("_local_models"))).toBe(false);
  });

  it("listModels 返回 OpenAI 兼容格式（去重 + owned_by=provider）", () => {
    const g = new LlmGateway({ providers: makeProviders() });
    const models = g.listModels();
    expect(models.map((m) => m.id).sort()).toEqual([
      "claude-sonnet-4-20250514",
      "deepseek-chat",
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    expect(models.find((m) => m.id === "gpt-4o")?.owned_by).toBe("openai");
    expect(models[0].object).toBe("model");
  });

  it("空 providers 时 isEmpty=true 且 listModels 为空", () => {
    const g = new LlmGateway({ providers: {} });
    expect(g.isEmpty).toBe(true);
    expect(g.listModels()).toEqual([]);
  });
});

describe("LlmGateway resolveModel", () => {
  const g = new LlmGateway({ providers: makeProviders() });

  it("provider:model 语法精确命中", () => {
    const r = g.resolveModel("anthropic:claude-sonnet-4-20250514");
    expect(r?.route.name).toBe("anthropic:claude-sonnet-4-20250514");
    expect(r?.route.api_format).toBe("anthropic");
    expect(r?.displayModel).toBe("anthropic:claude-sonnet-4-20250514");
  });

  it("纯模型名精确匹配（多 provider 时取键名最小）", () => {
    const r = g.resolveModel("gpt-4o");
    expect(r?.route.name).toBe("openai:gpt-4o");
    expect(r?.displayModel).toBe("gpt-4o");
  });

  it("未命中返回 null", () => {
    expect(g.resolveModel("nonexistent-model")).toBeNull();
    expect(g.resolveModel("")).toBeNull();
  });
});

describe("LlmGateway chat 非流式", () => {
  it("model 覆盖为路由真实 id，响应回显客户端请求名", async () => {
    // mock client：捕获 payload 并返回固定响应
    let capturedModel = "";
    const mockClient = {
      chat: async (payload: { model?: string; messages?: unknown[] }) => {
        capturedModel = payload.model ?? "";
        return {
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 123,
          model: payload.model ?? "",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        };
      },
      chatStream: async () => ({ text: "", chunks: 0, model: "" }),
    };
    const g = new LlmGateway({
      providers: makeProviders(),
      clientFactory: () => mockClient as never,
    });
    const resp = await g.chat(
      { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] } as never,
      "gpt-4o",
    );
    expect(capturedModel).toBe("gpt-4o");
    // 回显客户端请求名（而非内部 route 名）
    expect(resp.model).toBe("gpt-4o");
    expect(firstMessage(resp).content).toBe("hi");
  });

  it("未命中模型抛 404 LlmGatewayError", async () => {
    const g = new LlmGateway({ providers: makeProviders(), clientFactory: () => ({} as never) });
    await expect(g.chat({ model: "nope", messages: [] } as never, "nope")).rejects.toThrow(LlmGatewayError);
    await expect(g.chat({ model: "nope", messages: [] } as never, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("LlmGateway chatStream 流式", () => {
  it("输出 OpenAI chunk 格式 + reasoning_content + finish 收尾", async () => {
    const mockClient = {
      chat: async () => ({}),
      chatStream: async (
        _payload: unknown,
        onDelta: (d: string) => void,
        _signal?: unknown,
        onReasoning?: (r: string) => void,
        _onToolDelta?: unknown,
      ) => {
        onReasoning?.("思考中...");
        onDelta("hello");
        onDelta(" world");
        return { text: "hello world", chunks: 2, model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 2 } };
      },
    };
    const g = new LlmGateway({
      providers: makeProviders(),
      clientFactory: () => mockClient as never,
    });
    const chunks: Array<Record<string, unknown>> = [];
    let doneUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    await g.chatStream(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] } as never,
      "gpt-4o",
      {
        onChunk: (c) => chunks.push(c as unknown as Record<string, unknown>),
        onDone: (u) => { doneUsage = u; },
      },
    );
    // 至少包含：reasoning + 2 个 content + 1 个 finish
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    // 有 reasoning_content
    const reasoning = chunks.find((c) => {
      const ch = c.choices as Array<{ delta?: { reasoning_content?: string } }>;
      return ch?.[0]?.delta?.reasoning_content === "思考中...";
    });
    expect(reasoning).toBeTruthy();
    // 有 finish_reason=stop
    const finish = chunks.find((c) => {
      const ch = c.choices as Array<{ finish_reason?: string }>;
      return ch?.[0]?.finish_reason === "stop";
    });
    expect(finish).toBeTruthy();
    // usage 收尾
    expect(doneUsage?.prompt_tokens).toBe(10);
    expect(doneUsage?.completion_tokens).toBe(2);
  });
});

describe("LlmGateway api_format 透传", () => {
  it("Anthropic provider 路由带 api_format=anthropic", () => {
    const g = new LlmGateway({ providers: makeProviders() });
    const r = g.resolveModel("claude-sonnet-4-20250514");
    expect(r?.route.api_format).toBe("anthropic");
  });
  it("per-model api_format 覆盖 provider 级", () => {
    const providers = {
      agg: {
        api_base: "https://agg.example.com/v1",
        api_key: "sk",
        api_format: "openai",
        models: [
          { id: "claude-x", selected: true, api_format: "anthropic" },
          { id: "gpt-x", selected: true },
        ],
      },
    } as unknown as Record<string, ProviderConfig>;
    const g = new LlmGateway({ providers });
    expect(g.resolveModel("agg:claude-x")?.route.api_format).toBe("anthropic");
    expect(g.resolveModel("agg:gpt-x")?.route.api_format).toBe("openai");
  });
});

describe("LlmGateway 探针层第 2 层（实时响应探测）", () => {
  it("注入 liveProbe 后：成功转发刷新能力快照（context/工具/reasoning/延迟）", async () => {
    let t = 1_000_000;
    const cache = new LiveProbeCache({ ttlMs: 60_000, now: () => t });
    const mockClient = {
      chat: async (payload: { model?: string }) => ({
        id: "chatcmpl-p",
        object: "chat.completion",
        created: 1,
        model: payload.model ?? "",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "hi", reasoning_content: "想了下", tool_calls: [{ id: "tc1", type: "function", function: { name: "f", arguments: "{}" } }] },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 500, completion_tokens: 20 },
      }),
      chatStream: async () => ({ text: "", chunks: 0, model: "" }),
    };
    const g = new LlmGateway({
      providers: makeProviders(),
      clientFactory: () => mockClient as never,
      liveProbe: cache,
    });
    await g.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] } as never, "gpt-4o");
    const snap = cache.get("openai", "gpt-4o");
    expect(snap).not.toBeNull();
    expect(snap?.toolCalls).toBe(true);
    expect(snap?.reasoning).toBe(true);
    expect(snap?.contextWindow).toBe(1000); // 500*2
    expect(snap?.streaming).toBe(false);
    expect(snap?.lastErrorType).toBeUndefined();
  });

  it("未注入 liveProbe 时：转发行为不变、不报空", async () => {
    const g = new LlmGateway({
      providers: makeProviders(),
      clientFactory: () => ({
        chat: async (p: { model?: string }) => ({
          id: "c", object: "chat.completion", created: 1, model: p.model ?? "",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
        chatStream: async () => ({ text: "", chunks: 0, model: "" }),
      } as never),
    });
    // 无 liveProbe 不应抛
    const resp = await g.chat({ model: "gpt-4o", messages: [] } as never, "gpt-4o");
    expect(firstMessage(resp).content).toBe("ok");
    expect(g.allCapabilitySnapshots()).toEqual([]);
  });

  it("上游 401 失败：记录 lastErrorType 且 getRetryDecision 给出鉴权降级", async () => {
    const cache = new LiveProbeCache({ now: () => 0 });
    const boom = () => {
      const c = {
        chat: async () => {
          throw new UpstreamError("unauthorized: invalid key", 401, "upstream", "provider");
        },
        chatStream: async () => ({ text: "", chunks: 0, model: "" }),
      };
      return c as never;
    };
    const g = new LlmGateway({ providers: makeProviders(), clientFactory: boom, liveProbe: cache });
    await expect(g.chat({ model: "gpt-4o", messages: [] } as never, "gpt-4o")).rejects.toThrow(UpstreamError);
    const snap = cache.get("openai", "gpt-4o");
    // 失败快照的 lastErrorType = kind|modelScope|正文（401 属供应商级 → modelDead=false）
    expect(snap?.lastErrorType).toContain("upstream");
    expect(snap?.lastErrorType).toContain("provider");
    expect(snap?.modelDead).toBe(false); // 401 认证失败是账号级，非模型级
    // getRetryDecision：401 openai → 换 x-api-key
    const route = g.resolveModel("openai:gpt-4o")!.route;
    const d = g.getRetryDecision(route, "upstream", 401);
    expect(d.authSwap).toBe("x-api-key");
  });

  it("上游 404 模型级失效：modelDead=true（引擎前置剔除该模型）", async () => {
    const cache = new LiveProbeCache({ now: () => 0 });
    const boom = () => {
      const c = {
        chat: async () => {
          throw new UpstreamError("Model is unavailable", 404, "upstream", "model");
        },
        chatStream: async () => ({ text: "", chunks: 0, model: "" }),
      };
      return c as never;
    };
    const g = new LlmGateway({ providers: makeProviders(), clientFactory: boom, liveProbe: cache });
    await expect(g.chat({ model: "gpt-4o", messages: [] } as never, "gpt-4o")).rejects.toThrow(UpstreamError);
    const snap = cache.get("openai", "gpt-4o");
    expect(snap?.modelDead).toBe(true); // 404 模型级 → 引擎 setDeadModelCheck 会剔除它
    expect(cache.isDead("openai", "gpt-4o")).toBe(true);
  });

  it("404 端点降级：/v1/models 类 baseUrl 可经 getRetryDecision 给出 endpointSwap", () => {
    const cache = new LiveProbeCache();
    const g = new LlmGateway({ providers: makeProviders(), clientFactory: () => ({} as never), liveProbe: cache });
    // 构造一条 /v1/models 型路由直接测决策
    const route = g.resolveModel("openai:gpt-4o")!.route;
    const d = g.getRetryDecision(route, "not_found", 404);
    // baseUrl 形如 https://api.openai.com/v1（去掉 /v1 后），不含 /v1/models → 无端点降级
    expect(d.abandon).toBe(true); // 404 模型不存在 → 放弃切下一个
  });
});