/**
 * tests/core-ts/engine.spec.ts — SlimeEngine 真执行器测试（5A.4 遗留接线闭环）。
 * 覆盖：provider 解析（api:key / inherit 链式 / 未配置默认回复）/
 * A-090 raw 与过滤文分离 / 无工具流式（SSE → EngineChunk 流 + done 单收尾）/
 * 工具场景 toolsOnly 过滤 + ToolLoop 非流式执行。全部走注入 clientFactory（fake fetch），零真实网络。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SlimeEngine, estimateTokens, sanitizeImages, SlimeEngineOptions, persistSilamAffect, buildSilamTraitSignals } from "../../core-ts/src/services/engine.js";
import { loadSlimeMemories, type SilamAffectState } from "../../core-ts/src/services/silam_brain.js";
import { computeRecordCost } from "../../core-ts/src/services/usage.js";
import { resolveModelPriceTier } from "../../shared/gen/model-capabilities.js";
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

  it("buildSystem：配置工作目录时预注入目录内容清单（无需模型再调 file_list）", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { resetRegistry, getRegistry } = await import("../../core-ts/src/tools/registry.js");
    const { registerBuiltinTools } = await import("../../core-ts/src/tools/builtin.js");
    resetRegistry();
    registerBuiltinTools();

    const ws = await mkdtemp(join(tmpdir(), "ws-eng-"));
    const ws2 = await mkdtemp(join(tmpdir(), "ws-eng2-"));
    await writeFile(join(ws, "start.exe"), "MZ", "utf8");
    try {
      const eng = new SlimeEngine({
        registry: reg,
        providers: PROVIDERS,
        logger: quietLogger(),
        tools: getRegistry(),
        clientFactory: () => new ChatClient({ baseUrl: "http://mock/v1", apiKey: "k", fetchImpl: async () => jsonResponse({}) as Response }),
      });
      const agent = makeAgent({ sandbox_override: { approval: "auto", workspace: ws } });
      const sys = await eng.buildSystem(agent);
      expect(sys).toContain("start.exe"); // 清单已注入
      expect(sys).toContain("工作目录（workspace）已设置");
      // 有工作目录时绝不再要求"请告诉我路径"
      expect(sys.toLowerCase()).not.toContain("请告诉我路径");
      // 失败场景优雅降级（不存在/不可读的目录不 crash）
      const badAgent = makeAgent({ id: "agent_eng2", name: "Bad", role: "r", sandbox_override: { approval: "auto", workspace: join(ws2, "nope-nofolder") } });
      const sys2 = await eng.buildSystem(badAgent);
      expect(sys2).toContain("工作目录（workspace）已设置");
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(ws2, { recursive: true, force: true });
    }
  });

  it("refreshProviders：重载加密配置实现热更新（隔离 passFile/root）", async () => {
    const { tmpdir } = await import("node:os");
    const { mkdtemp } = await import("node:fs/promises");
    const tmp = await mkdtemp(tmpdir() + "/slime-engine-");
    const passFile = `${tmp}/pass`;
    const encPath = "config/providers.enc.json";
    const { encrypt } = await import("../../core-ts/src/encryption.js");
    encrypt(
      { fresh: { api_base: "http://fresh.local/v1", api_key: "k", model: "fresh-m" } },
      encPath,
      { projectRoot: tmp, passFile },
    );
    const engine = new SlimeEngine({ registry: reg, providers: { old: { api_base: "http://old.local/v1", api_key: "k", model: "m" } }, logger: quietLogger() });
    expect(engine.providersCount).toBe(1);
    engine.refreshProviders({ projectRoot: tmp, passFile });
    expect(engine.providersCount).toBe(1);
    expect(engine.providerKeys[0]).toBe("fresh");
    const router = await engine.routerFor(makeAgent({ id: "ref", model_choice: "api:fresh" }));
    expect(router).not.toBeNull();
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

  it("api:key 模型池（A-157）：provider 配置 models 列表 → 首选模型失败自动降级到下一候选", async () => {
    // 请求按路线依次发出：m1（默认）→ 400 Model unavailable（模型级 → 可降级）→ m2 区域 403 → m3 成功
    const callModels: string[] = [];
    const poolProviders = {
      "test-key": {
        api_base: "http://mock.local/v1",
        api_key: "k",
        model: "m1",
        models: [
          { id: "m1", selected: true },
          { id: "m2", selected: true },
          { id: "m3", selected: true },
          { id: "m4", selected: false }, // 未启用 → 不入池
        ],
      },
    };
    const engine = new SlimeEngine({
      registry: reg,
      providers: poolProviders,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          callModels.push(body.model ?? "");
          void url;
          if (body.model === "m1") {
            return new Response(JSON.stringify({ error: { type: "server_error", message: "Model is unavailable" } }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (body.model === "m2") {
            return new Response(JSON.stringify({ error: { type: "RegionError", message: "This model is not available in your country." } }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            });
          }
          return chatReply("降级成功", { model: body.model ?? "m3" });
        }) as unknown as typeof fetch,
      }),
    });
    const r = await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] });
    expect(callModels).toEqual(["m1", "m2", "m3"]);
    expect(r.reply).toBe("降级成功");
    expect(callModels).not.toContain("m4"); // 未启用模型绝不入池
  });

  it("api:key 模型池全挂：聚合错误列出每个候选（不静默、不虚报成功）", async () => {
    const failProviders = {
      "test-key": {
        api_base: "http://mock.local/v1",
        api_key: "k",
        model: "m1",
        models: [
          { id: "m1", selected: true },
          { id: "m2", selected: true },
        ],
      },
    };
    const engine = new SlimeEngine({
      registry: reg,
      providers: failProviders,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async () => {
          return new Response(JSON.stringify({ error: { type: "RegionError", message: "not available in your country" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      }),
    });
    await expect(engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] }))
      .rejects.toThrow(/chat 全部路由失败/);
  });

  it("跨供应商降级（A-1108）：按**用户配置的降级池**转移 —— 首选整池 429 时落到备用供应商", async () => {
    // A-158 立的是「跨供应商转移」这个**能力**，当时的实现是自动把其他所有已配置供应商的
    // 启用模型全量注入。用户实测反馈「我都没设置过降级池，它哪来的？」（A-1108）
    // ⇒ 能力保留、默认改为空池，必须有用户显式配置的条目才会转移。
    // 本用例是**迁移后**的形态：意图（首选整池挂掉 → 落到 agnes 那类备用供应商）一字未改，
    // 只是触发条件从「自动」变成「用户配置」。
    const callLog: string[] = [];
    const multiProviders = {
      "primary": {
        api_base: "http://mock.primary/v1",
        api_key: "p",
        model: "free-a",
        models: [
          { id: "free-a", selected: true },
          { id: "free-b", selected: true },
        ],
      },
      "backup": {
        api_base: "http://mock.backup/v1",
        api_key: "b",
        model: "stable-x",
        models: [
          { id: "stable-x", selected: true },
          { id: "stable-y", selected: true },
        ],
      },
    };
    const engine = new SlimeEngine({
      registry: reg,
      providers: multiProviders,
      logger: quietLogger(),
      // A-1108：跨供应商降级**不再是默认行为** —— 这一条就是用户自己加的降级池条目
      fallbackPool: { entries: [{ provider: "backup", model: "stable-x" }] },
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          callLog.push(`${String(url)}:${body.model ?? ""}`);
          void url;
          if (String(url).includes("primary")) {
            return new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "0" },
            });
          }
          return chatReply("备用供应商救场", { model: body.model ?? "stable-x" });
        }) as unknown as typeof fetch,
      }),
    });
    const r = await engine.chat({ agent: makeAgent({ model_choice: "api:primary" }), message: "hi", history: [], systemPrompt: "", toolsOnly: [] });
    expect(r.reply).toBe("备用供应商救场");
    // 首选全挂后确实落到了 backup（至少一次请求打到 mock.backup）
    expect(callLog.some((c) => c.includes("mock.backup"))).toBe(true);
  });

  /** A-1108 的两个「不许再自己造一个池」入口共用的夹具：备用供应商**存在且完全可用** ——
   *  它仍不该被用，这才是反证（如果只是「备用不可用所以没转移」，那证明不了任何事）。 */
  const noPoolFixture = (): { providers: Record<string, unknown>; callLog: string[] } => {
    const callLog: string[] = [];
    return {
      callLog,
      providers: {
        "primary": {
          api_base: "http://mock.primary/v1",
          api_key: "p",
          model: "free-a",
          models: [{ id: "free-a", selected: true }],
        },
        "backup": {
          api_base: "http://mock.backup/v1",
          api_key: "b",
          model: "stable-x",
          models: [{ id: "stable-x", selected: true }],
        },
      },
    };
  };

  it("默认无降级池（A-1108）：空池 ⇒ 首选全挂如实报错，**不**偷偷换到其他已配置供应商", async () => {
    // 用户原话：「我都没设置（降级池），是哪来的？」—— 这就是本次要根除的行为。
    const { providers, callLog } = noPoolFixture();
    const engine = new SlimeEngine({
      registry: reg,
      providers: providers as never,
      logger: quietLogger(),
      fallbackPool: { entries: [] },
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          callLog.push(`${String(url)}:${body.model ?? ""}`);
          if (String(url).includes("primary")) {
            return new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "rate limit" } }), {
              status: 429, headers: { "Content-Type": "application/json", "Retry-After": "0" },
            });
          }
          return chatReply("本不该被调用");
        }) as unknown as typeof fetch,
      }),
    });
    await expect(engine.chat({ agent: makeAgent({ model_choice: "api:primary" }), message: "hi", history: [], systemPrompt: "", toolsOnly: [] }))
      .rejects.toThrow(/chat 全部路由失败/);
    // 关键反证：备用的 base 一次都没被请求过（旧实现会打过去）
    expect(callLog.some((c) => c.includes("mock.backup"))).toBe(false);
  });

  it("默认无降级池（A-1108）：磁盘上没有 config/fallback-pool.json ⇒ 同样是空池", async () => {
    // 「没配置过」在真实机器上就是这个形态：文件不存在。绝不允许"读不到就补一个默认池"。
    const { providers, callLog } = noPoolFixture();
    const engine = new SlimeEngine({
      registry: reg,
      providers: providers as never,
      logger: quietLogger(),
      // 指向一个**不存在**的根 ⇒ readFallbackPool 必然回空池（无需写盘，确定性）
      fallbackPoolRoot: join(tmpdir(), "slime-a1108-no-such-root"),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          callLog.push(`${String(url)}:${body.model ?? ""}`);
          if (String(url).includes("primary")) {
            return new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "rate limit" } }), {
              status: 429, headers: { "Content-Type": "application/json", "Retry-After": "0" },
            });
          }
          return chatReply("本不该被调用");
        }) as unknown as typeof fetch,
      }),
    });
    await expect(engine.chat({ agent: makeAgent({ model_choice: "api:primary" }), message: "hi", history: [], systemPrompt: "", toolsOnly: [] }))
      .rejects.toThrow(/chat 全部路由失败/);
    expect(callLog.some((c) => c.includes("mock.backup"))).toBe(false);
  });

  it("显式引用不存在的 Provider key → 明确报错（不静默切到其他供应商）", async () => {
    const multiProviders = {
      "exists": {
        api_base: "http://mock.exists/v1",
        api_key: "e",
        model: "em-1",
        models: [{ id: "em-1", selected: true }],
      },
    };
    const engine = new SlimeEngine({
      registry: reg,
      providers: multiProviders,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async () => chatReply("可用")) as unknown as typeof fetch,
      }),
    });
    // model_choice 引用不存在的 key；engine 应回到「未找到 Provider」明确文案（不静默）
    const r = await engine.chat({ agent: makeAgent({ model_choice: "api:nope" }), message: "hi", history: [], systemPrompt: "", toolsOnly: [] });
    expect(r.reply).toContain("未找到已配置的 Provider");
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

  it("inherit 无 provider 目标 → 具体报错（不抛错，透出缺失 Provider 名）", async () => {
    const parent = makeAgent({ id: "parent1", model_choice: "api:missing-key" });
    const child = makeAgent({ id: "child1", model_choice: "inherit", parent_id: "parent1" });
    reg = await makeRegistry(dir, [parent, child]);
    const engine = new SlimeEngine({ registry: reg, providers: {}, logger: quietLogger() });
    const r = await engine.chat({ agent: child, message: "hi", history: [], systemPrompt: "" });
    expect(r.reply).toContain("未找到已配置的 Provider「missing-key」");
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

  it("A-966 群聊联网：toolsOnly 注入 web_search/web_fetch（networkEnabled=true 时可用）", async () => {
    let seenTools: unknown[] | null = null;
    const tools = new ToolRegistry();
    // 只注册内置（含 web_search/web_fetch）以免干扰
    const { registerBuiltinTools } = await import("../../core-ts/src/tools/builtin.js");
    registerBuiltinTools(tools);
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const engine = new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      tools,
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
          return chatReply("联网完成");
        }) as unknown as typeof fetch,
      }),
    });
    await engine.chat({
      agent: reg.loadedAgents[0], message: "查资料", history: [], systemPrompt: "",
      toolsOnly: ["web_search", "web_fetch"], networkEnabled: true,
    });
    expect(seen.length).toBeGreaterThan(0);
    seenTools = (seen[0].body.tools as unknown[] | undefined) ?? null;
    const names = (seenTools as unknown as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    // web 工具授 network 权限（sandbox network gate 放行的前提）
    const ws = tools.get("web_search");
    expect(ws?.permissions).toContain("network");
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

  it("无路由（缺少 Provider）→ 直接 done 具体报错", async () => {
    const engine = new SlimeEngine({ registry: reg, providers: {}, logger: quietLogger() });
    const evs = await collect(engine.stream({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] }));
    expect(evs).toHaveLength(1);
    expect((evs[0] as { reply: string }).reply).toContain("未找到已配置的 Provider");
  });

  it("工具场景流式：tool 事件先行 + 文本分块 + done（真流式工具循环）", async () => {
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
            return sseResponse([
              { id: "x", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "test_echo", arguments: "{}" } }] } }] },
            ]);
          }
          return sseResponse([
            { id: "x", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: { content: "工具完成：echo:{}" } }] },
          ]);
        }) as unknown as typeof fetch,
      }),
    });
    const evs = await collect(engine.stream({ agent: reg.loadedAgents[0], message: "查一下", history: [], systemPrompt: "" }));
    const types = evs.map((e) => e.type);
    // A-1061② 迁移：工具**开始**事件先行（界面据此立刻显示「执行中…」），随后才是完成事件。
    // 原断言锁的是 `types[0] === "tool"` —— 契约为"开始 → 完成"两段后，它必然要跟着搬到新位置。
    expect(types[0]).toBe("tool-start");
    expect(types).toContain("tool");
    expect(types[types.length - 1]).toBe("done");
    expect(types.filter((t) => t === "chunk").length).toBeGreaterThan(0);
    const done = evs[evs.length - 1] as { reply: string; reply_raw: string };
    expect(done.reply).toContain("工具完成");
  });
});

describe("SlimeEngine SILAM 兑底 reasoning 透传（A-124 正文/思考分离）", () => {
  const BRAIN_REPLY = "我是 引擎样例，测试员。\n我记得：先想清楚再动手。";
  const BRAIN_REASONING = "接下来：我会把这段经验存入长期记忆。\n这次交流我记下了一点新经验（记忆 6/50）。";

  let dir: string;
  let reg: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-silam-"));
    reg = await makeRegistry(dir, [makeAgent({ model_choice: "silam" })]);
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

  function fakeBrain(affect?: Partial<Omit<SilamAffectState, "langLoaded">> | null) {
    return {
      enabled: true,
      reply: vi.fn(async () => ({ reply: BRAIN_REPLY, reasoning: BRAIN_REASONING })),
      observe: vi.fn(),
      close: () => {},
      /** A-963 后向桥：fake 情感/成长态（缺省返回 null 模拟 sidecar 不可达） */
      getState: vi.fn(async (): Promise<SilamAffectState | null> => {
        if (!affect) {
          return null;
        }
        return {
          fear: affect.fear ?? 0,
          desire: affect.desire ?? 0,
          n_nodes: affect.n_nodes ?? 0,
          step: affect.step ?? 0,
          langLoaded: false,
        };
      }),
    };
  }

  function makeEngine(
    brain: ReturnType<typeof fakeBrain>,
    opts: Partial<SlimeEngineOptions> = {},
  ): SlimeEngine {
    return new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      silamBrain: brain,
      ...opts,
    });
  }

  async function collect(
    g: AsyncGenerator<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const evs: Array<Record<string, unknown>> = [];
    for await (const e of g) evs.push(e);
    return evs;
  }

  it("chat 显式 silam：result 携带正文 reply + 思考 reasoning", async () => {
    const brain = fakeBrain();
    const result = await makeEngine(brain).chat({
      agent: reg.loadedAgents[0],
      message: "你好",
      history: [],
      systemPrompt: "",
    });
    expect(result.reply).toBe(BRAIN_REPLY);
    expect(result.reasoning).toBe(BRAIN_REASONING);
    expect(result.model).toBe("silam");
    expect(brain.reply).toHaveBeenCalledTimes(1);
  });

  it("chat 无路由兜底兑底：model=silam-brain 且带 reasoning", async () => {
    await writeFile(
      join(dir, "agents.json"),
      JSON.stringify([makeAgent({ model_choice: "api:missing-key" })]),
      "utf8",
    );
    await reg.load();
    const brain = fakeBrain();
    const result = await makeEngine(brain).chat({
      agent: reg.loadedAgents[0],
      message: "你好",
      history: [],
      systemPrompt: "",
    });
    expect(result.model).toBe("silam-brain");
    expect(result.reply).toBe(BRAIN_REPLY);
    /* A-1018：兜底不再静默 —— 思考段**前置**失败原因（否则用户看不出这轮不是他选的模型答的，
     * 只能拿着截图问"为什么用不了选中的本地模型"）。所以这里断言"包含"而不是"等于"：
     * 原因前缀 + 大脑自己的思考。 */
    expect(result.reasoning).toContain("api:missing-key");
    expect(result.reasoning).toContain("SILAM 离线大脑兜底");
    expect(result.reasoning).toContain(BRAIN_REASONING);
    expect(result.reasoning?.startsWith("⚠️")).toBe(true);
  });

  it("stream 显式 silam：先 reasoning 事件，done 携带 reply + reasoning", async () => {
    const brain = fakeBrain();
    const evs = await collect(
      makeEngine(brain).stream({
        agent: reg.loadedAgents[0],
        message: "你好",
        history: [],
        systemPrompt: "",
      }) as AsyncGenerator<Record<string, unknown>>,
    );
    expect(evs[0].type).toBe("reasoning");
    expect(evs[0].content).toBe(BRAIN_REASONING);
    const done = evs[evs.length - 1];
    expect(done.type).toBe("done");
    expect(done.reply).toBe(BRAIN_REPLY);
    expect(done.reasoning).toBe(BRAIN_REASONING);
    expect(done.model).toBe("silam");
  });

  async function firstReplyArg(brain: ReturnType<typeof fakeBrain>): Promise<{ agentName?: string; slimeMemory?: string[] } | undefined> {
  const calls = (brain.reply as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls;
  return calls[0]?.[0] as { agentName?: string; slimeMemory?: string[] } | undefined;
}

it("A-963 前向桥：注入的 slime 长期记忆进入 silam reply 入参", async () => {
    const brain = fakeBrain();
    const loader = vi.fn(async () => ["用户偏好深色主题", "先想清楚再动手", "禁止编造路径"]);
    const engine = makeEngine(brain, { silamMemoryLoader: loader });
    await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    const arg = await firstReplyArg(brain);
    expect(loader).toHaveBeenCalledWith(reg.loadedAgents[0].id);
    expect(arg?.slimeMemory).toEqual(["用户偏好深色主题", "先想清楚再动手", "禁止编造路径"]);
    expect(arg?.agentName).toBe("EngineTest");
  });

  it("A-963 前向桥：无记忆源（loader 返回空）→ reply 不携带 slimeMemory", async () => {
    const brain = fakeBrain();
    const engine = makeEngine(brain, { silamMemoryLoader: async () => [] });
    await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    const arg = await firstReplyArg(brain);
    expect(arg?.slimeMemory).toBeUndefined(); // 空记忆不注入
    expect(arg?.agentName).toBe("EngineTest");
  });

  it("A-963 后向桥：chat 后 engine 缓存 SILAM 情感/成长态（供 GUI IPC 回读）", async () => {
    const brain = fakeBrain({ fear: 0.42, desire: 0.61, n_nodes: 27, step: 103 });
    const engine = makeEngine(brain);
    await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    // refreshSilamAffect 是 fire-and-forget：等一个微任务周期再断言缓存
    await new Promise((r) => setTimeout(r, 0));
    expect(brain.getState).toHaveBeenCalled();
    const st = engine.getSilamAffect(reg.loadedAgents[0].id);
    expect(st).toEqual({ fear: 0.42, desire: 0.61, n_nodes: 27, step: 103, langLoaded: false });
  });

  it("A-963 后向桥：sidecar 不可达（getState=null）→ 缓存保持未定义、对话不受影响", async () => {
    const brain = fakeBrain(null);
    const engine = makeEngine(brain);
    const r = await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.reply).toBe(BRAIN_REPLY);
    expect(engine.getSilamAffect(reg.loadedAgents[0].id)).toBeUndefined();
  });

  it("A-963 前向桥数据源 loadSlimeMemories：容错与排序", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    // t1: 目录缺失 → []
    expect(await loadSlimeMemories("ghost", 6, dir)).toEqual([]); // dir 无 Knowledge 子树

    const root = await mkdtemp(join(tmpdir(), "slime-mem-"));
    const base = join(root, "Knowledge", "Agent Memory", "agent_x");
    mkdirSync(base, { recursive: true });
    // t2: 损坏 JSON → 忽略，knowledge.json 正常返回
    writeFileSync(join(base, "memory.json"), "{broken json", "utf8");
    writeFileSync(join(base, "knowledge.json"), JSON.stringify({
      patterns: { "task.code.deploy": { description: "发布时先跑 QA" } },
      rules: [{ title: "安全规则", content: "危险操作前必须显式确认" }],
    }), "utf8");
    const mem = await loadSlimeMemories("agent_x", 6, root);
    expect(mem).toContain("危险操作前必须显式确认");
    expect(mem.some((t) => t.includes("发布时先跑"))).toBe(true);

    // t3: importance 排序 + 去重 + limit
    writeFileSync(join(base, "memory.json"), JSON.stringify({
      facts: [
        { content: "低权重记忆", importance: 1 },
        { content: "高权重记忆", importance: 9 },
        { content: "高权重记忆", importance: 9 }, // 去重
        { content: "中权重记忆" }, // 缺省 importance=1
      ],
    }), "utf8");
    const ranked = await loadSlimeMemories("agent_x", 2, root);
    expect(ranked).toEqual(["高权重记忆", "低权重记忆"]);
    expect(ranked).toHaveLength(2); // limit=2 生效
  });

  it("A-963b 演化回灌：SILAM 成长态沉淀到 slime 长期记忆（silam.json 可被前向桥回读）", async () => {
    const root = await mkdtemp(join(tmpdir(), "slime-persist-"));
    const state: SilamAffectState = { fear: 0.31, desire: 0.62, n_nodes: 27, step: 104, langLoaded: true };
    expect(persistSilamAffect("agent_p1", state, { root, now: 1_000 })).toBe(true);
    const { readFileSync, existsSync } = await import("node:fs");
    const p = join(root, "Knowledge", "Agent Memory", "agent_p1", "silam.json");
    expect(existsSync(p)).toBe(true);
    const doc = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    expect(doc.fear).toBe(0.31);
    expect(doc.n_nodes).toBe(27);
    expect(doc.step).toBe(104);
    expect(String(doc.content)).toContain("恐惧 0.31");
    expect(String(doc.content)).toContain("成长树节点 27");
    // 前向回读：loadSlimeMemories 能收集到该快照的 content → 闭环成立
    const mem = await loadSlimeMemories("agent_p1", 6, root);
    expect(mem.some((t) => t.includes("SILAM 成长快照"))).toBe(true);
  });

  it("A-963b 演化回灌：节流——同态 + 未到间隔 → 跳过（返回 false 不覆盖）", async () => {
    const root = await mkdtemp(join(tmpdir(), "slime-persist2-"));
    const { readFileSync } = await import("node:fs");
    const p = join(root, "Knowledge", "Agent Memory", "agent_p2", "silam.json");
    const state: SilamAffectState = { fear: 0.2, desire: 0.5, n_nodes: 1, step: 1, langLoaded: false };
    expect(persistSilamAffect("agent_p2", state, { root, now: 1_000 })).toBe(true);
    const firstUpdated = (JSON.parse(readFileSync(p, "utf8")) as { updated_at: number }).updated_at;
    // 相同状态 + 100s 后（<300s 节流窗口）→ 跳过
    expect(persistSilamAffect("agent_p2", state, { root, now: 1_100 })).toBe(false);
    expect((JSON.parse(readFileSync(p, "utf8")) as { updated_at: number }).updated_at).toBe(firstUpdated);
    // 显著情绪漂移（fear 0.2→0.7）→ 立即覆盖
    expect(persistSilamAffect("agent_p2", { ...state, fear: 0.7 }, { root, now: 1_200 })).toBe(true);
    expect((JSON.parse(readFileSync(p, "utf8")) as { fear: number }).fear).toBe(0.7);
    // 超过节流窗口 → 覆盖
    expect(persistSilamAffect("agent_p2", state, { root, now: firstUpdated + 400_000 })).toBe(true);
  });

  it("A-963b 演化回灌：既有文件损坏 → 覆盖重建（不抛错）", async () => {
    const root = await mkdtemp(join(tmpdir(), "slime-persist3-"));
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const p = join(root, "Knowledge", "Agent Memory", "agent_p3", "silam.json");
    mkdirSync(join(root, "Knowledge", "Agent Memory", "agent_p3"), { recursive: true });
    writeFileSync(p, "{broken", "utf8");
    const state: SilamAffectState = { fear: 0.5, desire: 0.5, n_nodes: 2, step: 2, langLoaded: false };
    expect(persistSilamAffect("agent_p3", state, { root, now: 1 })).toBe(true);
    expect(JSON.parse((await import("node:fs")).readFileSync(p, "utf8")).fear).toBe(0.5);
  });

  it("A-963b 演化回灌：engin 集成为 chat 后自动写盘（silamPersistRoot 注入 tmp）", async () => {
    const root = await mkdtemp(join(tmpdir(), "slime-persist4-"));
    const brain = fakeBrain({ fear: 0.9, desire: 0.1, n_nodes: 12, step: 7 });
    const engine = makeEngine(brain, { silamPersistRoot: root });
    await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    await new Promise((r) => setTimeout(r, 0)); // refreshSilamAffect fire-and-forget
    const p = join(root, "Knowledge", "Agent Memory", reg.loadedAgents[0].id, "silam.json");
    const { existsSync } = await import("node:fs");
    expect(existsSync(p)).toBe(true);
    const doc = JSON.parse((await import("node:fs")).readFileSync(p, "utf8")) as { fear: number };
    expect(doc.fear).toBe(0.9);
  });

  it("A-965 buildSilamTraitSignals：fear/desire 阈值 → 人格 trait 信号（确定性规则）", () => {
    expect(buildSilamTraitSignals({ fear: 0.8, desire: 0.5, n_nodes: 1, step: 1, langLoaded: false }))
      .toEqual([{ name: "谨慎", signal: 1 }]);
    expect(buildSilamTraitSignals({ fear: 0.3, desire: 0.9, n_nodes: 1, step: 1, langLoaded: false }))
      .toEqual([{ name: "进取", signal: 1 }]);
    expect(buildSilamTraitSignals({ fear: 0.1, desire: 0.1, n_nodes: 1, step: 1, langLoaded: false }))
      .toEqual([{ name: "谨慎", signal: -1 }, { name: "进取", signal: -1 }]);
    expect(buildSilamTraitSignals({ fear: 0.4, desire: 0.4, n_nodes: 1, step: 1, langLoaded: false }))
      .toEqual([]); // 无显著情绪 → 不通报
  });

  it("A-965 core-ts↔server 通报钩子：SILAM 状态刷新后触发且携带 agentId+state", async () => {
    const root = await mkdtemp(join(tmpdir(), "slime-evolve-"));
    const brain = fakeBrain({ fear: 0.9, desire: 0.1, n_nodes: 12, step: 7 });
    const evolve = vi.fn();
    const engine = makeEngine(brain, { silamPersistRoot: root, onSilamEvolve: (id, st) => evolve(id, st) });
    await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    await new Promise((r) => setTimeout(r, 0));
    expect(evolve).toHaveBeenCalledTimes(1);
    const [id, st] = evolve.mock.calls[0] as [string, SilamAffectState];
    expect(id).toBe(reg.loadedAgents[0].id);
    expect(st.fear).toBe(0.9);
    // 钩子异常不容错：engine 内部已包 try/catch，抛错不影响对话
    const throwing = makeEngine(brain, { onSilamEvolve: () => { throw new Error("boom"); } });
    const r = await throwing.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    expect(r.reply).toBe(BRAIN_REPLY); // 通报异常不中断兑底
  });
});

/** 识图：sanitizeImages 过滤 + engine.chat 带 images 时 payload 组装 OpenAI 兼容 content 数组
 *  （GUI 识图链路核心，对齐 core/llm.py _build_user_content / _sanitize_image_data_url 同规） */
describe("识图（images → content-blocks 数组）", () => {
  let dir: string;
  let reg: AgentRegistry;
  const DATA_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const MAX_BASE64 = "A".repeat(11 * 1024 * 1024); // base64 ≈11MB → 原始 ≈8.25MB 超 8MB 阈值

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-vision-"));
    reg = await makeRegistry(dir, [makeAgent({ id: "agent_vis", name: "Vis", role: "看图" })]);
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

  function makeVisionEngine(onBody: (body: Record<string, unknown>) => void): SlimeEngine {
    return new SlimeEngine({
      registry: reg,
      providers: PROVIDERS,
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          onBody(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return chatReply("我看到了图片内容");
        }) as unknown as typeof fetch,
      }),
    });
  }

  it("sanitizeImages：前缀/空 payload/大小/数量过滤（与 Python _sanitize_image_data_url 同规）", () => {
    // 非 data:image 前缀（URL、大小写错、file://）、非数组 → 全拒
    expect(sanitizeImages(undefined)).toEqual([]);
    expect(sanitizeImages(["https://a.com/b.png", "DATA:image/png;base64,x", "file:///tmp/a.png"])).toEqual([]);
    expect(sanitizeImages("data:image/png;base64,x" as unknown as string[])).toEqual([]); // 非数组字符串
    // 逗号后空 payload → 拒
    expect(sanitizeImages(["data:image/png;base64,"])).toEqual([]);
    // 合法保留，宽容逗号前参数（charset 等）
    expect(sanitizeImages(["data:image/png;charset=utf-8,abc"])).toEqual(["data:image/png;charset=utf-8,abc"]);
    // 上限 4 张
    expect(sanitizeImages(Array.from({ length: 5 }, () => DATA_PNG))).toHaveLength(4);
    // 超大（>8MB）拒
    expect(sanitizeImages([`data:image/png;base64,${MAX_BASE64}`])).toEqual([]);
  });

  it("chat 带 images：末条 user content 组装为 blocks 数组（text + image_url）", async () => {
    let body: Record<string, unknown> = {};
    const engine = makeVisionEngine((b) => { body = b; });
    const r = await engine.chat({
      agent: reg.loadedAgents[0], message: "描述这张图", history: [], systemPrompt: "", images: [DATA_PNG],
    });
    expect(r.reply).toBe("我看到了图片内容");
    const msgs = (body.messages as Array<{ role: string; content: unknown }>);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "描述这张图" });
    expect(blocks[1]).toEqual({ type: "image_url", image_url: { url: DATA_PNG } });
  });

  it("chat 无 images：保持纯字符串 content（旧路径零回归）", async () => {
    let body: Record<string, unknown> = {};
    const engine = makeVisionEngine((b) => { body = b; });
    await engine.chat({ agent: reg.loadedAgents[0], message: "你好", history: [], systemPrompt: "" });
    const msgs = (body.messages as Array<{ role: string; content: unknown }>);
    expect(typeof msgs[msgs.length - 1].content).toBe("string");
  });
});

/**
 * A-970 定价事故回归：`config/usage.jsonl` 实测 1621 条记录 100% 成本为 0。
 * 根因是 `recordUsage` 只读 providers.enc.json 里的存值价，老配置里躺着 `undefined`
 * （尤其价目表正则漏匹配的新模型 ID）→ 每条都记 0，与聚合逻辑无关。
 * 这里锁住三条不变量：① 存值缺价 → 回退内置价目表；② 显式 0（免费）不被兜底绕过；
 * ③ 手填价优先于内置价目表。整条链路走真 chat() 落盘 → 真磁盘断言，不 mock usage。
 */
describe("recordUsage 定价兜底（A-970 定价事故回归）", () => {
  let dir: string;
  let reg: AgentRegistry;
  let usagePath: string;
  const prevUsageEnv = process.env.SLIME_USAGE_PATH;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slime-engine-usage-"));
    reg = await makeRegistry(dir, [makeAgent({ model_choice: "api:deepseek" })]);
    usagePath = join(dir, "usage.jsonl");
    process.env.SLIME_USAGE_PATH = usagePath; // usage.ts 的运行时路径覆盖（隔离真盘）
  });

  afterEach(async () => {
    if (prevUsageEnv === undefined) { delete process.env.SLIME_USAGE_PATH; }
    else { process.env.SLIME_USAGE_PATH = prevUsageEnv; }
    for (let i = 0; i < 5; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  });

  /** recordUsage 是 fire-and-forget，轮询等落盘（最多 1s），避免 flaky */
  async function readUsageRecords(): Promise<Array<Record<string, unknown>>> {
    for (let i = 0; i < 40; i++) {
      try {
        const raw = await readFile(usagePath, "utf8");
        const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length > 0) { return lines.map((l) => JSON.parse(l) as Record<string, unknown>); }
      } catch { /* 尚未落盘 */ }
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  /** 造一台引擎：provider 只给 id（可选带价），HTTP 一律返回固定 usage 的 chatReply */
  function engineWithDeepseek(
    models: Array<Record<string, unknown>>,
    apiBase = "https://api.deepseek.com/v1",
  ): SlimeEngine {
    return new SlimeEngine({
      registry: reg,
      providers: {
        deepseek: {
          api_base: apiBase,
          api_key: "k",
          model: "deepseek-flash",
          models: models as ProviderConfigLike["models"],
        },
      },
      logger: quietLogger(),
      clientFactory: (route) => new ChatClient({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        fetchImpl: (async () => chatReply("好的")) as unknown as typeof fetch,
      }),
    });
  }

  it("存值缺价（老配置 undefined）→ 回退内置价目表，成本不为 0", async () => {
    const engine = engineWithDeepseek([{ id: "deepseek-flash" }]); // 无 price_in_usd / price_out_usd
    const r = await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] });
    expect(r.reply).toBe("好的");

    const recs = await readUsageRecords();
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec.model).toBe("deepseek-flash");
    expect(rec.provider_key).toBe("deepseek");
    expect(rec.prompt_tokens).toBe(5); // chatReply 固定 usage
    expect(rec.completion_tokens).toBe(3);
    expect(rec.success).toBe(true);

    // 成本必须 > 0，且精确等于「**该记录时刻**命中档位的单价 × token / 1e6」
    // ⚠️ 这里**不能**用 inferModelPricing(modelId)（平铺价）断言：deepseek 是峰谷分时，
    //    引擎按记录 ts 取档，而测试跑在哪个时段是不确定的 —— 用平铺价会随运行时间随机失败。
    const tier = resolveModelPriceTier("deepseek-flash", String(rec.ts));
    expect(tier.tiered).toBe(true);
    const expected = computeRecordCost(5, 3, 0, 0, 0, tier.pricing.priceIn as number, tier.pricing.priceOut as number, tier.pricing.priceCacheRead, tier.pricing.priceCacheWrite);
    expect(expected).toBeGreaterThan(0);
    expect(Number(rec.cost_usd)).toBeCloseTo(expected, 12);
    // 档位落盘可对账；且单价必须是**真实存在的档位价**（0.15 空闲 / 0.3 高峰），
    // 不能是已废弃的峰谷均值 0.225（均值在任何真实时段都不存在）
    expect(rec.price_tier).toBe(tier.tierId);
    expect([0.15, 0.3]).toContain(tier.pricing.priceIn as number);
  });

  it("显式 0 价（手填 price_source=manual）= 免费 → 不被兜底/分时绕过，成本保持 0", async () => {
    const engine = engineWithDeepseek([
      { id: "deepseek-flash", price_in_usd: 0, price_out_usd: 0, price_source: "manual" },
    ]);
    await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] });

    const recs = await readUsageRecords();
    expect(recs).toHaveLength(1);
    expect(Number(recs[0].cost_usd)).toBe(0); // 0 是有效价（免费），必须原样保留
    // 手填价生效 → 不写分时档位（档位没参与计价，写上去会误导对账）
    expect(recs[0].price_tier).toBeUndefined();
  });

  it("本地端点托管 deepseek-flash → 分时价 / 官方价都不得覆盖（成本保持 0）", async () => {
    // 本地跑 llama.cpp 时模型 ID 可能就叫 deepseek-flash，但 API 账单为 0。
    // 若让分时规格按 ID 命中就收钱，等于给本地推理凭空记账 —— 这是本用例锁住的回归点。
    const engine = engineWithDeepseek(
      [{ id: "deepseek-flash", price_in_usd: 0, price_out_usd: 0, price_source: "table" }],
      "http://127.0.0.1:8080/v1",
    );
    await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] });

    const recs = await readUsageRecords();
    expect(recs).toHaveLength(1);
    expect(Number(recs[0].cost_usd)).toBe(0);
  });

  it("手填价（price_source=manual）优先于内置价目表（含分时价）", async () => {
    const engine = engineWithDeepseek([
      { id: "deepseek-flash", price_in_usd: 100, price_out_usd: 200, price_source: "manual" },
    ]);
    await engine.chat({ agent: reg.loadedAgents[0], message: "hi", history: [], systemPrompt: "", toolsOnly: [] });

    const recs = await readUsageRecords();
    expect(recs).toHaveLength(1);
    const expected = computeRecordCost(5, 3, 0, 0, 0, 100, 200);
    expect(Number(recs[0].cost_usd)).toBeCloseTo(expected, 12);
    expect(expected).toBeGreaterThan(0);
  });
});

/** 测试内联类型：仅取 ProviderConfig.models 的入参形态，避免为一个假数据导入生产类型 */
interface ProviderConfigLike {
  models?: Array<{ id?: unknown; selected?: unknown; [k: string]: unknown }>;
}