/**
 * tests/core-ts/engine.spec.ts — SlimeEngine 真执行器测试（5A.4 遗留接线闭环）。
 * 覆盖：provider 解析（api:key / inherit 链式 / 未配置默认回复）/
 * A-090 raw 与过滤文分离 / 无工具流式（SSE → EngineChunk 流 + done 单收尾）/
 * 工具场景 toolsOnly 过滤 + ToolLoop 非流式执行。全部走注入 clientFactory（fake fetch），零真实网络。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SlimeEngine, estimateTokens, SlimeEngineOptions } from "../../core-ts/src/services/engine.js";
import { AgentRegistry, AgentState, emptyPersona } from "../../core-ts/src/services/agents.js";
import { ChatClient } from "../../core-ts/src/llm/client.js";
import { ToolRegistry, Tool } from "../../core-ts/src/tools/registry.js";

function makeAgent(partial: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent_eng1",
    name: "EngineTest",
    role: "测试",
    identity_prompt: "你是{name}，{role}。",
    model_choice: "api:test-key",
    parent_id: null,
    persona: emptyPersona(),
    emotion: {},
    behavior: { patterns: [] },
    children: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

async function makeRegistry(dir: string, agents: AgentState[]): Promise<AgentRegistry> {
  await writeFile(join(dir, "agents.json"), JSON.stringify(agents), "utf8");
  const reg = new AgentRegistry(join(dir, "agents.json"));
  await reg.load();
  return reg;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function chatReply(content: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: "x", object: "chat.completion", created: 1, model: "m1",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...extra,
  });
}

function sseResponse(lines: Array<Record<string, unknown>>): Response {
  const body = lines
    .map((o) => `data: ${JSON.stringify(o)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200 });
}

function quietLogger(): Pick<Console, "warn" | "info" | "debug"> {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

const PROVIDERS = { "test-key": { api_base: "http://mock.local/v1", api_key: "k", model: "m1" } };

describe("SlimeEngine 非流式 chat", () => {
  let dir: string;
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-engine-"));
    reg = await makeRegistry(dir, [makeAgent()]);
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  });

  function makeEngine(
    responder: (url: string, init: RequestInit, callCount: number) => Response,
    opts: Partial<SlimeEngineOptions> = {},
  ): SlimeEngine {
    let calls = 0;
    return new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls++;
          return responder(String(url), init ?? {}, calls);
        }) as unknown as typeof fetch,
      }),
      ...opts,
    });
  }

  it("estimateTokens 量级合理", () => {
    expect(estimateTokens("你好")).toBe(1);
    expect(estimateTokens("a".repeat(100))).toBe(60);
  });

  it("api:key 解析：请求带正确 baseUrl/模型 + A-090 过滤文/原文分离", async () => {
    let seenUrl = "";
    const engine = makeEngine((url, _init) => {
      seenUrl = url;
      return chatReply("我是 EngineTest，你好");
    });
    const r = await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] });
    expect(seenUrl).toBe("http://mock.local/v1/chat/completions"); // /v1 去除 + 拼接
    expect(r.reply).toBe("我是 EngineTest，你好");
    expect(r.replyRaw).toBe("我是 EngineTest，你好");
    expect(r.model).toBe("m1");
    expect(r.promptTokens).toBe(5);
    expect(r.completionTokens).toBe(3);
  });

  it("身份铁律过滤：模型自称 → 展示文过滤、raw 保留原文", async () => {
    const engine = makeEngine(() => chatReply("我是 GPT-4o，很高兴。"));
    const r = await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "" });
    expect(r.replyRaw).toContain("GPT-4o");
    expect(r.reply).not.toContain("GPT-4o");
  });

  it("systemPrompt 覆盖人格段：委托子 Agent 场景", async () => {
    const engine = makeEngine((_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
      const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
      expect(sys).toContain("自定义人格");
      expect(sys).toContain("我是 EngineTest"); // 身份铁律区仍在
      return chatReply("ok");
    });
    const r = await engine.chat({
      agent: reg.loadedAgents[0], message: "hi", history: [],
      systemPrompt: "你是子 Agent 自定义人格。",
    });
    expect(r.reply).toBe("ok");
  });

  it("inherit 链式：子 Agent 继承父 provider key 并正确请求", async () => {
    const parent = makeAgent({ id: "parent1", model_choice: "api:parent-key" });
    const child = makeAgent({ id: "child1", model_choice: "inherit", parent_id: "parent1" });
    reg = await makeRegistry(dir, [parent, child]);
    let seenAuth = "";
    const engine = new SlimeEngine({
      registry: reg,
      providers: { "parent-key": { api_base: "http://mock.local", api_key: "parent-secret", model: "pm" } },
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
          void url;
          return chatReply("继承成功");
        }) as unknown as typeof fetch,
      }),
    });
    const r = await engine.chat({ agent: child, message: "hi", history: [], systemPrompt: "" });
    expect(seenAuth).toBe("Bearer parent-secret");
    expect(r.reply).toBe("继承成功");
  });

  it("inherit 无 provider 目标 → 默认回复（不抛错）", async () => {
    const parent = makeAgent({ id: "parent1", model_choice: "api:missing-key" });
    const child = makeAgent({ id: "child1", model_choice: "inherit", parent_id: "parent1" });
    reg = await makeRegistry(dir, [parent, child]);
    const engine = new SlimeEngine({ registry: reg, providers: {}, logger: quietLogger() });
    const r = await engine.chat({ agent: child, message: "hi", history: [], systemPrompt: "" });
    expect(r.reply).toContain("未配置 API Provider");
    expect(r.model).toBe("none");
  });

  it("工具场景：模型首轮调工具 → 执行 → 文本收尾（ToolLoop 非流式）", async () => {
    const tools = new ToolRegistry();
    tools.register(new Tool({
      name: "test_echo",
      description: "回声工具",
      parameters: { type: "object", properties: {}, required: [] },
      executeFn: async (args) => `echo:${JSON.stringify(args ?? {})}`,
      permissions: ["read"],
    }));
    let round = 0;
    const engine = makeEngine((_url, _init) => {
      round++;
      if (round === 1) {
        return jsonResponse({
          id: "x", object: "chat.completion", created: 1, model: "m1",
          choices: [{
            index: 0,
            message: {
              role: "assistant", content: null, finish_reason: "tool_calls",
              tool_calls: [{ id: "t1", type: "function", function: { name: "test_echo", arguments: "{}" } }],
            },
          }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      return chatReply("工具结果: echo:{}");
    }, { tools });
    const r = await engine.chat({ agent: reg.loadedAgents[0], message: "查一下", history: [], systemPrompt: "" });
    expect(r.reply).toBe("工具结果: echo:{}");
  });

  it("toolsOnly 过滤：只注入指定工具 schema", async () => {
    const tools = new ToolRegistry();
    tools.register(new Tool({
      name: "tool_a", description: "a", parameters: { type: "object", properties: {}, required: [] },
      executeFn: async () => "a", permissions: ["read"],
    }));
    tools.register(new Tool({
      name: "tool_b", description: "b", parameters: { type: "object", properties: {}, required: [] },
      executeFn: async () => "b", permissions: ["read"],
    }));
    let seenTools: unknown[] | null = null;
    const engine = makeEngine((_url, init) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      seenTools = body.tools ?? null;
      return chatReply("ok");
    }, { tools });
    await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: ["tool_b"] });
    expect(seenTools).not.toBeNull();
    const names = (seenTools as unknown as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toEqual(["tool_b"]);
  });

  it("toolsOnly 过滤后为空 → 请求体不带 tools", async () => {
    let seenTools: unknown = "unset";
    const engine = makeEngine((_url, init) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      seenTools = body.tools ?? undefined;
      return chatReply("ok");
    });
    await engine.chat({
      agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "",
      toolsOnly: ["no_such_tool"], // 过滤后为空 → 不注入
    });
    expect(seenTools).toBeUndefined();
  });
});

describe("SlimeEngine 流式 stream", () => {
  let dir: string;
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-engine-stream-"));
    reg = await makeRegistry(dir, [makeAgent()]);
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  });

  async function collect(g: AsyncGenerator<{ type: string; data?: unknown; reply?: string; reply_raw?: string; model?: string; content?: string }>) {
    const out: Array<{ type: string; data?: unknown; reply?: string; reply_raw?: string; model?: string; content?: string }> = [];
    for await (const ev of g) {
      out.push(ev);
    }
    return out;
  }

  it("无工具流式：SSE 逐 chunk → EngineChunk 流 + done 单收尾 + raw 原文", async () => {
    const engine = new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async () =>
          sseResponse([
            { id: "x", model: "m1", choices: [{ delta: { content: "你" } }] },
            { id: "x", model: "m1", choices: [{ delta: { content: "好" } }] },
            { id: "x", model: "m1", choices: [{ delta: {} }] },
          ])) as unknown as typeof fetch,
      }),
    });
    const evs = await collect(engine.stream({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] }));
    const types = evs.map((e) => e.type);
    // StreamFilter hold=32：短文本缓冲到 flush 一次性出（Python _StreamFilter 同语义）
    expect(types).toEqual(["chunk", "done"]);
    expect((evs[0] as unknown as { content: string }).content).toBe("你好");
    const done = evs[1] as unknown as { reply: string; reply_raw: string; model: string };
    expect(done.reply).toBe("你好");
    expect(done.reply_raw).toBe("你好");
    expect(done.model).toBe("m1");
  });

  it("流式身份铁律过滤：跨 chunk 拦截模型名", async () => {
    const engine = new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async () =>
          sseResponse([
            { id: "x", model: "m1", choices: [{ delta: { content: "我是 " } }] },
            { id: "x", model: "m1", choices: [{ delta: { content: "GPT-4o，" } }] },
            { id: "x", model: "m1", choices: [{ delta: { content: "很高兴" } }] },
          ])) as unknown as typeof fetch,
      }),
    });
    const evs = await collect(engine.stream({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] }));
    const full = evs.filter((e) => e.type === "chunk").map((e) => (e as unknown as { content: string }).content).join("");
    expect(full).not.toContain("GPT-4o");
    const done = evs[evs.length - 1] as { reply: string; reply_raw: string };
    expect(done.reply).not.toContain("GPT-4o");
    expect(done.reply_raw).toContain("GPT-4o"); // A-090: raw 保留原文
  });

  it("无路由（未配置 provider）→ 直接 done 默认回复", async () => {
    const engine = new SlimeEngine({ registry: reg, providers: {}, logger: quietLogger() });
    const evs = await collect(engine.stream({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] }));
    expect(evs).toHaveLength(1);
    expect((evs[0] as { reply: string }).reply).toContain("未配置 API Provider");
  });

  it("工具场景流式：tool 事件先行 + 文本分块 + done（非流式重放）", async () => {
    const tools = new ToolRegistry();
    tools.register(new Tool({
      name: "test_echo", description: "回声",
      parameters: { type: "object", properties: {}, required: [] },
      executeFn: async (args) => `echo:${JSON.stringify(args ?? {})}`,
      permissions: ["read"],
    }));
    let round = 0;
    const engine = new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      tools,
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async () => {
          round++;
          if (round === 1) {
            return jsonResponse({
              id: "x", object: "chat.completion", created: 1, model: "m1",
              choices: [{
                index: 0,
                message: {
                  role: "assistant", content: null, finish_reason: "tool_calls",
                  tool_calls: [{ id: "t1", type: "function", function: { name: "test_echo", arguments: "{}" } }],
                },
              }],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            });
          }
          return chatReply("工具完成：echo:{}");
        }) as unknown as typeof fetch,
      }),
    });
    const evs = await collect(engine.stream({ agent: reg.loadedAgents[0], message: "查一下", history: [], systemPrompt: "" }));
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe("tool");
    expect(types[types.length - 1]).toBe("done");
    expect(types.filter((t) => t === "chunk").length).toBeGreaterThan(0);
    const done = evs[evs.length - 1] as { reply: string; reply_raw: string };
    expect(done.reply).toContain("工具完成");
  });
});