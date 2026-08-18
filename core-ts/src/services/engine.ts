/**
 * core-ts/src/services/engine.ts — SlimeEngine：ChatEngine 真实现（5A.4 遗留接线点闭环）。
 * 语义对照 core/llm.py：
 * - model_choice 三选一：api:<key> → providers.enc.json 解密后按 key 取 {api_base, api_key, model}；
 *   local:<path> → ModelServerManager 的 chat 实例端口（registry state=ready，缺省 127.0.0.1:19100）；
 *   inherit → 沿 parent 链向上追溯 api:<key>（visited 防环，对照 _resolve_provider_key）。
 * - 无可用路由 → _default_reply 文案（如实告知未配置，不虚报）。
 * - A-090：replyRaw = 模型原文（过滤前），reply = 身份铁律过滤后展示文本。
 * - 工具：经 ToolLoop 非流式执行（registry + 沙箱 L0-L5）；stream 场景工具轮暂为非流式
 *   重放（chunk 一次性吐出）——真流式工具循环（增量 tool_calls 累积）属 5B.3。
 */
import { ModelRouter, RouteEntry } from "../router.js";
import { ChatClient } from "../llm/client.js";
import { ChatMessage, ChatRequest } from "shared/schemas";
import { OutputFilter, StreamFilter } from "../filter.js";
import { ToolLoop, sandboxGateFrom } from "../tool_loop.js";
import { ToolRegistry, getRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/builtin.js";
import { SandboxManager } from "../sandbox.js";
import { AgentRegistry, AgentState } from "./agents.js";
import {
  ChatEngine,
  ChatEngineCall,
  ChatEngineResult,
  EngineChunk,
} from "./chat.js";
import { IDENTITY_CONSTRAINT, HONESTY_PROTOCOL, InjectionHooks, NOOP_HOOKS } from "../session.js";
import { decrypt } from "../encryption.js";
import { getModelServer } from "../model_server.js";

export interface ProviderConfig {
  api_base: string;
  api_key: string;
  model: string;
  [key: string]: unknown;
}

export interface SlimeEngineOptions {
  registry: AgentRegistry;
  /** 解密后的 providers 表（缺省读 config/providers.enc.json；测试注入） */
  providers?: Record<string, ProviderConfig>;
  /** local:<path> 路由兜底 baseUrl（缺省 127.0.0.1:19100） */
  localBaseUrl?: string;
  hooks?: InjectionHooks;
  tools?: ToolRegistry;
  sandbox?: SandboxManager;
  /** 路由客户端工厂（测试注入 fake fetch；缺省 ChatClient） */
  clientFactory?: (route: RouteEntry) => ChatClient;
  /** 无可用路由时的默认回复（缺省对齐 _default_reply 文案） */
  defaultReply?: (agent: AgentState) => string;
  logger?: Pick<Console, "warn" | "info" | "debug">;
}

const DEFAULT_LOCAL_BASE = "http://127.0.0.1:19100";

function defaultReplyText(agent: AgentState): string {
  return (
    `你好，我是 ${agent.name}，${agent.role}。\n\n` +
    `当前未配置 API Provider，请先通过 CLI 向导或 API 配置模型服务。\n` +
    `使用 \`py slime_cli.py wizard\` 或 \`POST /providers\` 添加 Provider。`
  );
}

/** 估计 token 数（对齐 Python _estimate_tokens 的量级语义：~0.6×字符数） */
export function estimateTokens(text: string): number {
  return Math.round(text.length * 0.6);
}

/** 路由注入 model（请求未显式指定时；对齐 router.withModel 语义） */
function withModel(payload: ChatRequest, route: RouteEntry): ChatRequest {
  if (payload.model || !route.model) {
    return payload;
  }
  return { ...payload, model: route.model };
}

export class SlimeEngine implements ChatEngine {
  private registry: AgentRegistry;
  private providers: Record<string, ProviderConfig>;
  private localBaseUrl: string;
  private hooks: InjectionHooks;
  private tools: ToolRegistry;
  private sandbox: SandboxManager | null;
  private clientFactory: (route: RouteEntry) => ChatClient;
  private defaultReply: (agent: AgentState) => string;
  private logger: Pick<Console, "warn" | "info" | "debug">;

  /** 已配置 Provider 数（Swarm 并发上限参考，对齐 Python max_workers 语义） */
  get providersCount(): number {
    return Object.keys(this.providers).length;
  }

  /** 工具注册表（SwarmExecutor 注入用） */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** 沙箱（未配置返回 null） */
  get sandboxManager(): SandboxManager | null {
    return this.sandbox;
  }

  constructor(opts: SlimeEngineOptions) {
    this.registry = opts.registry;
    this.providers = opts.providers ?? ((decrypt() ?? {}) as Record<string, ProviderConfig>);
    this.localBaseUrl = opts.localBaseUrl ?? DEFAULT_LOCAL_BASE;
    this.hooks = opts.hooks ?? NOOP_HOOKS;
    this.tools = opts.tools ?? getRegistry();
    this.sandbox = opts.sandbox ?? null;
    this.clientFactory =
      opts.clientFactory ?? ((route) => new ChatClient({ baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs }));
    this.defaultReply = opts.defaultReply ?? defaultReplyText;
    this.logger = opts.logger ?? console;
    registerBuiltinTools(this.tools);
  }

  /** inherit 沿 parent 链向上追溯 api:<key>（visited 防环；对照 _resolve_provider_key） */
  public async resolveProviderKey(agent: AgentState): Promise<string | null> {
    let current = agent;
    const visited = new Set<string>([agent.id]);
    while (current) {
      if (current.model_choice.startsWith("api:")) {
        return current.model_choice.slice(4);
      }
      if (current.parent_id && !visited.has(current.parent_id)) {
        visited.add(current.parent_id);
        const parent = await this.registry.findAgent(current.parent_id);
        if (!parent) {
          break;
        }
        current = parent;
      } else {
        break;
      }
    }
    return null;
  }

  /** local:<path> → ModelServerManager chat 实例端口（state=ready），不可用回退 localBaseUrl */
  private localChatBaseUrl(): string | null {
    const mgr = getModelServer();
    if (mgr) {
      try {
        const status = mgr.status() as unknown as Array<{ role?: string; port?: number; state?: string }>;
        const chat = status.find((s) => s.role === "chat" && s.state === "ready" && s.port);
        if (chat) {
          return `http://127.0.0.1:${chat.port}`;
        }
      } catch {
        // 状态查询失败 → 兜底
      }
    }
    return this.localBaseUrl;
  }

  /** 组装 ModelRouter：api:key → 云端单路由；local → 本地路由；无法解析 → null（默认回复） */
  public async routerFor(agent: AgentState): Promise<ModelRouter | null> {
    if (agent.model_choice.startsWith("api:")) {
      const key = agent.model_choice.slice(4);
      const cfg = this.providers[key];
      if (!cfg) {
        this.logger.warn(`provider_key '${key}' 不存在于已配置 Provider 中`);
        return null;
      }
      const base = (cfg.api_base ?? "").replace(/\/+$/, "");
      const router = new ModelRouter(undefined, this.clientFactory);
      router.add({
        name: key,
        baseUrl: base.endsWith("/v1") ? base.slice(0, -3) : base,
        apiKey: cfg.api_key || undefined,
        model: cfg.model || undefined,
        kind: "cloud",
        priority: 100,
        roles: ["chat", "embedding"],
      });
      return router;
    }
    if (agent.model_choice.startsWith("local:")) {
      const router = new ModelRouter(undefined, this.clientFactory);
      router.add({
        name: "local",
        baseUrl: this.localChatBaseUrl() ?? "",
        kind: "local",
        priority: 100,
        roles: ["chat", "embedding"],
      });
      return router;
    }
    if (agent.model_choice === "inherit") {
      const key = await this.resolveProviderKey(agent);
      if (key) {
        const inherit = { ...agent, model_choice: `api:${key}` };
        return this.routerFor(inherit);
      }
      return null;
    }
    return null;
  }

  /** 组装 system prompt：身份铁律区 + 诚实协议 + 人格段（custom 覆盖 identity_prompt）+ 心智/检索注入段 */
  async buildSystem(agent: AgentState, customSystemPrompt?: string): Promise<string> {
    const parts: string[] = [
      IDENTITY_CONSTRAINT(agent.name, agent.role),
      HONESTY_PROTOCOL,
      (customSystemPrompt?.trim() ? customSystemPrompt : agent.identity_prompt).trim() ||
        `你是 ${agent.name}，你的角色是：${agent.role}。`,
    ];
    parts.push(...this.hooks.fixedSegments(agent));
    parts.push(...(await this.hooks.retrieveSegments(agent.id, "用户最近的需求")));
    return parts.join("\n\n");
  }

  /** 工具 schema（toolsOnly 过滤；显式 [] 或过滤后为空 → undefined 不注入） */
  private toolSchemas(toolsOnly?: string[]): ChatRequest["tools"] {
    // 未传 toolsOnly → 全部已注册工具；显式传（含空数组）→ 按名过滤
    const names = toolsOnly === undefined
      ? this.tools.listToolNames()
      : toolsOnly.filter((n) => this.tools.listToolNames().includes(n));
    if (names.length === 0) {
      return undefined;
    }
    return this.tools.listTools().filter((t) =>
      (t as { function?: { name?: string } }).function?.name &&
      names.includes((t as { function: { name: string } }).function.name),
    ) as ChatRequest["tools"];
  }

  private buildMessages(call: ChatEngineCall, system: string): ChatMessage[] {
    return [
      { role: "system", content: system },
      ...call.history,
      { role: "user", content: call.message },
    ];
  }

  async chat(opts: ChatEngineCall): Promise<ChatEngineResult> {
    const started = Date.now();
    const router = await this.routerFor(opts.agent);
    if (!router) {
      return {
        reply: this.defaultReply(opts.agent),
        model: "none",
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: Date.now() - started,
      };
    }
    const system = await this.buildSystem(opts.agent, opts.systemPrompt);
    const messages = this.buildMessages(opts, system);
    const tools = this.toolSchemas(opts.toolsOnly);

    if (tools && tools.length > 0) {
      // 工具场景：非流式工具循环（5B.3 起升级真流式工具循环）
      const loop = new ToolLoop({
        router,
        registry: this.tools,
        sandbox: this.sandbox ? sandboxGateFrom(this.sandbox) : undefined,
      });
      const result = await loop.run({ agentId: opts.agent.id, messages, initialToolCalls: [], tools, maxTokens: opts.maxTokens });
      const filtered = new OutputFilter().filter(result.raw, opts.agent.name);
      return {
        reply: filtered.filtered || result.raw,
        replyRaw: result.raw,
        model: router.select("chat")?.model ?? router.select("chat")?.name ?? "none",
        promptTokens: estimateTokens(JSON.stringify(messages)),
        completionTokens: estimateTokens(result.raw),
        elapsedMs: Date.now() - started,
      };
    }

    const payload: ChatRequest = { messages, max_tokens: opts.maxTokens };
    const route = router.select("chat");
    const { response, routeName } = await router.chat(withModel(payload, route!));
    const raw = response.choices[0]?.message?.content ?? "";
    const filtered = new OutputFilter().filter(raw, opts.agent.name);
    const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return {
      reply: filtered.filtered || raw,
      replyRaw: raw,
      model: response.model ?? routeName,
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)),
      completionTokens: usage?.completion_tokens ?? estimateTokens(raw),
      elapsedMs: Date.now() - started,
    };
  }

  async *stream(opts: ChatEngineCall): AsyncGenerator<EngineChunk> {
    const started = Date.now();
    const router = await this.routerFor(opts.agent);
    if (!router) {
      const reply = this.defaultReply(opts.agent);
      yield { type: "done", reply, reply_raw: reply, model: "none", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started };
      return;
    }
    const system = await this.buildSystem(opts.agent, opts.systemPrompt);
    const messages = this.buildMessages(opts, system);
    const tools = this.toolSchemas(opts.toolsOnly);

    if (tools && tools.length > 0) {
      // 工具场景（非流式重放；TODO 5B.3：真流式工具循环）
      const loop = new ToolLoop({
        router,
        registry: this.tools,
        sandbox: this.sandbox ? sandboxGateFrom(this.sandbox) : undefined,
      });
      const result = await loop.run({ agentId: opts.agent.id, messages, initialToolCalls: [], tools, maxTokens: opts.maxTokens });
      const filtered = new OutputFilter().filter(result.raw, opts.agent.name);
      const display = filtered.filtered || result.raw;
      // 工具事件先出（ChatService 依赖 tool 事件做 A-049 判定），文本分块重放
      for (const d of result.roundLog) {
        yield { type: "tool", name: d.name, args: d.args, result: d.result };
      }
      const chunkSize = 24;
      for (let i = 0; i < display.length; i += chunkSize) {
        yield { type: "chunk", content: display.slice(i, i + chunkSize) };
      }
      yield {
        type: "done",
        reply: display,
        reply_raw: result.raw,
        model: router.select("chat")?.model ?? router.select("chat")?.name ?? "none",
        prompt_tokens: estimateTokens(JSON.stringify(messages)),
        completion_tokens: estimateTokens(result.raw),
        elapsed_ms: Date.now() - started,
      };
      return;
    }

    // 无工具：真流式 + StreamFilter 跨 chunk 身份铁律过滤
    const filter = new OutputFilter();
    const streamFilter = new StreamFilter();
    const payload: ChatRequest = { messages, max_tokens: opts.maxTokens };
    const route = router.select("chat");
    const raw = await router.chatStream(withModel(payload, route!), (delta) => {
      const emitted = streamFilter.push(delta, filter, opts.agent.name);
      if (emitted) {
        // 同步生成器内不能 await；事件立即上抛
        this.pushChunk(emitted);
      }
    });
    const tail = streamFilter.flush(filter, opts.agent.name);
    if (tail) {
      this.pushChunk(tail);
    }
    // 已过滤展示流逐 chunk 回放（回调期间缓冲，循环结束统一消费）
    yield* this.drainFiltered();
    yield {
      type: "done",
      reply: this.displayText,
      reply_raw: raw.text,
      model: raw.model,
      prompt_tokens: estimateTokens(JSON.stringify(messages)),
      completion_tokens: estimateTokens(raw.text),
      elapsed_ms: Date.now() - started,
    };
  }

  /** 流式回调缓冲（async generator 中不可在回调内 yield，先入队后统一消费） */
  private filteredQueue: EngineChunk[] = [];
  private displayText = "";

  private pushChunk(content: string): void {
    this.filteredQueue.push({ type: "chunk", content });
    this.displayText += content;
  }

  private async *drainFiltered(): AsyncGenerator<EngineChunk> {
    while (this.filteredQueue.length > 0) {
      yield this.filteredQueue.shift()!;
    }
    this.filteredQueue = [];
  }
}

/** 组装完整 SlimeEngine（Electron 主进程 / CLI 注入点） */
export function createEngine(opts: SlimeEngineOptions): SlimeEngine {
  return new SlimeEngine(opts);
}