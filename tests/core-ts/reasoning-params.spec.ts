










import { describe, it, expect } from "vitest";
import { ModelRouter } from "../../core-ts/src/router.js";
import type { RouteEntry } from "../../core-ts/src/router.js";

import type { ChatRequest } from "../../shared/gen/schemas.js";


function makeRouter(): { router: ModelRouter; seen: Array<{ model?: string; body: Record<string, unknown> }> } {
  const seen: Array<{ model?: string; body: Record<string, unknown> }> = [];
  const router = new ModelRouter([], ((_route: RouteEntry) => ({
    
    chat: async (payload: ChatRequest) => {
      seen.push({ model: payload.model, body: payload as unknown as Record<string, unknown> });
      return { response: { choices: [{ message: { role: "assistant", content: "ok" } }] } };
    },
  })) as never);
  return { router, seen };
}

describe("ModelRouter — 思考参数按实际模型注入", () => {
  it("withModel 会给路由模型套上解析出的思考参数", async () => {
    const { router, seen } = makeRouter();
    router.setReasoningParamsResolver((modelId) =>
      modelId.includes("agnes") ? { chat_template_kwargs: { enable_thinking: true } } : { reasoning_effort: "medium" });
    router.add({ name: "AGNES:agnes-2.5-flash", baseUrl: "https://api.agnes-ai.cn", apiKey: "k", model: "agnes-2.5-flash", kind: "cloud", priority: 1, roles: ["chat"] });

    await router.chat({ messages: [{ role: "user", content: "hi" }] } as ChatRequest);
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe("agnes-2.5-flash");
    expect(seen[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("调用方预置的思考参数由路由层按模型覆写（不残留旧协议键）", async () => {
    const { router, seen } = makeRouter();
    
    router.setReasoningParamsResolver(() => ({ chat_template_kwargs: { enable_thinking: true } }));
    router.add({ name: "AGNES:agnes-2.5-flash", baseUrl: "https://api.agnes-ai.cn", apiKey: "k", model: "agnes-2.5-flash", kind: "cloud", priority: 1, roles: ["chat"] });

    await router.chat({
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "medium",
    } as unknown as ChatRequest);

    expect(seen[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
    
    expect("reasoning_effort" in seen[0].body).toBe(false);
  });

  it("不支持思考的模型：解析返回 {}，残留思考键被清除", async () => {
    const { router, seen } = makeRouter();
    router.setReasoningParamsResolver(() => ({}));
    router.add({ name: "plain:some-model", baseUrl: "https://x", apiKey: "k", model: "some-model", kind: "cloud", priority: 1, roles: ["chat"] });

    await router.chat({
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: true },
    } as unknown as ChatRequest);

    expect("reasoning_effort" in seen[0].body).toBe(false);
    expect("chat_template_kwargs" in seen[0].body).toBe(false);
  });

  it("解析钩子返回 null → 完全不改动 payload", async () => {
    const { router, seen } = makeRouter();
    router.setReasoningParamsResolver(() => null);
    router.add({ name: "r", baseUrl: "https://x", apiKey: "k", model: "m", kind: "cloud", priority: 1, roles: ["chat"] });

    await router.chat({
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    } as unknown as ChatRequest);

    expect(seen[0].body.reasoning_effort).toBe("high");
  });

  it("未注入钩子时行为不变（向后兼容）", async () => {
    const { router, seen } = makeRouter();
    router.add({ name: "r", baseUrl: "https://x", apiKey: "k", model: "m", kind: "cloud", priority: 1, roles: ["chat"] });
    await router.chat({ messages: [{ role: "user", content: "hi" }] } as ChatRequest);
    expect(seen[0].model).toBe("m");
    expect("chat_template_kwargs" in seen[0].body).toBe(false);
  });

  it("解析钩子抛异常不影响请求发出", async () => {
    const { router, seen } = makeRouter();
    router.setReasoningParamsResolver(() => { throw new Error("boom"); });
    router.add({ name: "r", baseUrl: "https://x", apiKey: "k", model: "m", kind: "cloud", priority: 1, roles: ["chat"] });
    await router.chat({ messages: [{ role: "user", content: "hi" }] } as ChatRequest);
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe("m");
  });

  it("降级换模型时思考参数随之切换（不同协议模型混池）", async () => {
    const seen: Array<{ model?: string; body: Record<string, unknown> }> = [];
    let call = 0;
    const router = new ModelRouter([], ((_route: RouteEntry) => ({
      chat: async (payload: ChatRequest) => {
        seen.push({ model: payload.model, body: payload as unknown as Record<string, unknown> });
        call++;
        if (call === 1) { throw Object.assign(new Error("429"), { status: 429 }); }
        return { response: { choices: [{ message: { role: "assistant", content: "ok" } }] } };
      },
      chatStream: async () => { throw new Error("n/a"); },
    })) as never);
    router.setReasoningParamsResolver((modelId) =>
      modelId.includes("agnes")
        ? { chat_template_kwargs: { enable_thinking: true } }
        : { reasoning_effort: "medium" });

    router.add({ name: "agnes", baseUrl: "https://a", apiKey: "k", model: "agnes-2.5-flash", kind: "cloud", priority: 1000, roles: ["chat"] });
    router.add({ name: "other", baseUrl: "https://b", apiKey: "k", model: "gpt-4o", kind: "cloud", priority: 900, roles: ["chat"] });

    try { await router.chat({ messages: [{ role: "user", content: "hi" }] } as ChatRequest); } catch {  }

    expect(seen.length).toBeGreaterThanOrEqual(1);
    
    expect(seen[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect("reasoning_effort" in seen[0].body).toBe(false);
    
    if (seen.length > 1 && seen[1].model === "gpt-4o") {
      expect(seen[1].body.reasoning_effort).toBe("medium");
      expect("chat_template_kwargs" in seen[1].body).toBe(false);
    }
  });
});
