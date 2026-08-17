import { describe, expect, it, vi } from "vitest";
import { Session, NOOP_HOOKS, type InjectionHooks } from "../../core-ts/src/session.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ModelRouter } from "../../core-ts/src/router.js";

const AGENT = { name: "小蓝", role: "资深助手" };

function makeSession(overrides: {
  streamChunks?: string[];
  nonStreamContent?: string;
  onDelta?: (d: string) => void;
  hooks?: InjectionHooks;
  clientFactory?: (route: { name: string }) => ChatClient;
} = {}) {
  const streamChunks = overrides.streamChunks ?? [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.stream) {
      const lines = streamChunks.map((c) => `data: ${JSON.stringify({
        id: "s1", object: "chat.completion.chunk", created: 1, model: "qwen2.5-3b",
        choices: [{ index: 0, delta: { content: c } }],
      })}`);
      return new Response([...lines, "data: [DONE]"].join("\n") + "\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({
      id: "x1", object: "chat.completion", created: 1, model: "qwen2.5-3b",
      choices: [{ index: 0, message: { role: "assistant", content: overrides.nonStreamContent ?? "ok" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new ChatClient({ baseUrl: "http://127.0.0.1:19100", fetchImpl });
  const router = new ModelRouter(
    [{ name: "sidecar", baseUrl: "http://127.0.0.1:19100", kind: "local", priority: 100, roles: ["chat"] }],
    overrides.clientFactory ?? (() => client),
  );
  const session = new Session({
    router,
    hooks: overrides.hooks ?? NOOP_HOOKS,
  });
  return { session, fetchImpl };
}

describe("Session（会话最小闭环）", () => {
  it("system prompt 含身份铁律区（我是{name}，不暴露模型名）", async () => {
    const { session } = makeSession();
    const sp = await session.buildSystemPrompt(AGENT, "agent_x");
    expect(sp).toContain("你是 小蓝");
    expect(sp).toContain("你的角色是：资深助手");
    expect(sp).toContain("绝不自称");
    expect(sp).toContain("诚实与验证铁律");
  });

  it("非流式：回复经身份铁律过滤（模型名不进入用户可见文本）", async () => {
    const { session } = makeSession({ nonStreamContent: "我是 Qwen 模型，你好" });
    const r = await session.chat({ agent: AGENT, agentId: "agent_x", history: [], stream: false });
    expect(r.text).toContain("slime 平台");
    expect(r.text).not.toContain("Qwen");
    expect(r.violations).toBeGreaterThan(0);
  });

  it("流式：跨 chunk 过滤 + onDelta 回调输出", async () => {
    const deltas: string[] = [];
    const { session } = makeSession({
      streamChunks: ["我是 ", "Qwen 3B 模型", "，你好"],
      onDelta: (d) => deltas.push(d),
    });
    const r = await session.chat({ agent: AGENT, agentId: "agent_x", history: [], onDelta: (d) => deltas.push(d) });
    expect(r.text).toContain("Qwen"); // 原始文本保留（过滤只作用于对外输出）
    expect(r.violations).toBeGreaterThan(0);
    const visible = deltas.join("");
    expect(visible).not.toContain("Qwen");
    expect(visible).toContain("slime 平台");
  });

  it("hooks.fixedSegments 注入 L2 固定段（双路径注入骨架）", async () => {
    const hooks: InjectionHooks = {
      ...NOOP_HOOKS,
      fixedSegments: (agent) => [`[L2 心智] 当前 Agent: ${agent.name}`],
    };
    const { session } = makeSession({ hooks });
    const sp = await session.buildSystemPrompt(AGENT, "agent_x");
    expect(sp).toContain("[L2 心智] 当前 Agent: 小蓝");
  });

  it("hooks.retrieveSegments 注入 L3 检索段（阶段 4 接入 sidecar）", async () => {
    const hooks: InjectionHooks = {
      ...NOOP_HOOKS,
      retrieveSegments: async (_id, q) => [`[L3 记忆] 检索: ${q}`, "[L3 记忆] 相关事实: {test-fact}"],
    };
    const { session } = makeSession({ hooks });
    const sp = await session.buildSystemPrompt(AGENT, "agent_x");
    expect(sp).toContain("[L3 记忆] 相关事实: {test-fact}");
  });

  it("无可用 chat 路由时抛出明确错误（不静默失败）", async () => {
    const session = new Session({ router: new ModelRouter() });
    await expect(session.chat({ agent: AGENT, agentId: "agent_x", history: [] })).rejects.toThrow("无可用 chat 路由");
  });

  it("历史消息原样透传（消息组装）", async () => {
    const sent: unknown[] = [];
    const fetchImpl2 = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const s2 = new Session({
      router: new ModelRouter(
        [{ name: "s", baseUrl: "http://x", kind: "local", priority: 1, roles: ["chat"] }],
        () => new ChatClient({ baseUrl: "http://x", fetchImpl: fetchImpl2 }),
      ),
    });
    await s2.chat({
      agent: AGENT, agentId: "a1",
      history: [{ role: "user", content: "第一轮" }, { role: "assistant", content: "回复" }],
      stream: false,
    });
    const payload = sent[0] as { messages: Array<{ role: string; content: string }> };
    expect(payload.messages.length).toBe(3);
    expect(payload.messages[0].role).toBe("system");
    expect(payload.messages[1].content).toBe("第一轮");
    expect(payload.messages[2].content).toBe("回复");
  });

  it("结果携带 routeName（路由可观测，不向用户暴露）", async () => {
    const { session } = makeSession({ nonStreamContent: "你好" });
    const r = await session.chat({ agent: AGENT, agentId: "agent_x", history: [], stream: false });
    expect(r.routeName).toBe("sidecar");
  });
});
