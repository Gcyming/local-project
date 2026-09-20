/**
 * gateway-ts/src/llmGateway.ts — slime 专属 LLM 网关（OpenAI 兼容入口 + 多上游转发 + 4 类格式互转）。
 *
 * 定位与边界（v1 定案）：
 * - 复用 slime 自有的 4 类 client（ChatClient / AnthropicClient / ResponsesClient / GoogleClient）
 *   —— 这些是 slime 自己实现，已内置 OpenAI↔Anthropic↔Gemini/Responses 的请求体与响应体互转，
 *   不依赖、不借鉴 new-api（AGPL 独立实现）。
 * - 对外暴露 OpenAI 兼容端点（POST /v1/chat/completions、GET /v1/models），
 *   第三方客户端可像调 OpenAI 一样调 slime 网关。
 * - 网关是「精确转发」：客户端显式指定 model，网关按 model 解析到唯一上游并转发，
 *   **不做跨模型降级链**（降级是 slime 引擎内部能力，网关语义是"客户端指定谁就转发给谁"）。
 *
 * 模型寻址规则：
 * - `provider:model` 语法（如 `openai:gpt-4o`）→ 精确匹配该 provider 的该模型路由。
 * - 纯模型名（如 `gpt-4o`）→ 在所有 provider 中按「模型 id 精确匹配」，命中多个时取
 *   provider 键名字典序最小的（稳定、可预期）。
 * - 都未命中 → 404 + 可用模型清单。
 */

import { RouteEntry, ApiFormat, inferApiFormat } from "../../core-ts/src/router.js";
import { decrypt } from "../../core-ts/src/encryption.js";
import { isChatCapableModel, ProviderConfig } from "../../core-ts/src/services/engine.js";
// A-1024 ②：本地模型清单的键名唯一产地。这里曾是第 2 个硬编码产地
//（`k !== "_local_models"`）—— 键名一改，网关会静默把清单当成真供应商去建路由。
import { LOCAL_MODELS_KEY } from "../../core-ts/src/local_models.js";
import { ChatClient, AnthropicClient, ResponsesClient, GoogleClient, UpstreamError } from "../../core-ts/src/llm/client.js";
import {
  LiveProbeCache,
  extractSnapshot,
  nextAuthOnFailure,
  nextEndpointOnFailure,
  CapabilitySnapshot,
  RetryDecision,
} from "../../core-ts/src/probe-live.js";
import { ChatRequest, ChatResponse, ChatCompletionChunk } from "shared/schemas";

/** 4 类上游 client 的统一接口（LLM 网关按 route.api_format 构造对应 client） */
export type GatewayClient = ChatClient | AnthropicClient | ResponsesClient | GoogleClient;

/** client 工厂（测试注入 mock；生产缺省按 api_format 构造真实 client） */
export type GatewayClientFactory = (route: RouteEntry) => GatewayClient;

/** LLM 网关配置（projectRoot 用于解密 providers.enc.json；可注入 fake 便于测试） */
export interface LlmGatewayOptions {
  /** slime 项目根目录（providers.enc.json 所在目录） */
  projectRoot?: string;
  /** 每 provider 最多注入的候选模型数（防候选爆炸） */
  maxModelsPerProvider?: number;
  /** 测试注入：直接提供解密后的 providers 表，跳过 decrypt（生产不用） */
  providers?: Record<string, ProviderConfig>;
  /** 测试注入：自定义 client 工厂（mock 上游，不发真实 HTTP） */
  clientFactory?: GatewayClientFactory;
  /** 探针层第 2 层：注入实时探测缓存；不传则网关不记录实时能力快照（转发行为不变） */
  liveProbe?: LiveProbeCache;
}

/** 模型寻址结果 */
export interface ResolvedModel {
  route: RouteEntry;
  /** 返回给客户端的 model 名（回显客户端原始请求名） */
  displayModel: string;
}

/** 默认 client 工厂：按 api_format 构造 slime 自有 client（4 类格式互转在此层） */
export function defaultClientFactory(route: RouteEntry): GatewayClient {
  const format: ApiFormat = route.api_format === "anthropic" ? "anthropic"
    : route.api_format === "responses" ? "responses"
    : route.api_format === "google" ? "google"
    : route.api_format === "openai" ? "openai"
    : inferApiFormat(route.baseUrl);
  const opts = { baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs };
  if (format === "anthropic") { return new AnthropicClient(opts); }
  if (format === "responses") { return new ResponsesClient(opts); }
  if (format === "google") { return new GoogleClient(opts); }
  return new ChatClient(opts);
}

/** 网关主体：持有全量路由表（所有 provider 的启用模型），按 model 精确转发 */
export class LlmGateway {
  private routes: RouteEntry[] = [];
  /** 纯模型名 → 候选路由列表（按 provider 键名排序，稳定） */
  private byModel = new Map<string, RouteEntry[]>();
  /** route.name（provider:model）→ 路由 */
  private byName = new Map<string, RouteEntry>();
  private clientFactory: GatewayClientFactory;
  private projectRoot: string;
  /** 探针层第 2 层：实时响应探测缓存（上游响应过网关后刷新，TTL 过期自动重探） */
  private liveProbe?: LiveProbeCache;

  constructor(opts: LlmGatewayOptions = {}) {
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.liveProbe = opts.liveProbe;
    this.loadProviders(opts.maxModelsPerProvider ?? 8, opts.providers);
  }

  /** 探针层第 2 层 TTL 可配置（缺省 5min；传入 0/负数表示关闭实时探测） */
  setLiveProbe(cache: LiveProbeCache | undefined): void {
    this.liveProbe = cache;
  }

  /** 解密 providers.enc.json 并注入全量路由（遍历所有 provider，排除 _local_models 与本地 base） */
  private loadProviders(maxModelsPerProvider: number, injected?: Record<string, ProviderConfig>): void {
    const providers = injected ?? (decrypt("config/providers.enc.json", { projectRoot: this.projectRoot }) ?? {}) as Record<string, ProviderConfig>;

    // 按 provider 键名稳定排序（同名模型的候选顺序可预期）
    const entries = Object.entries(providers)
      .filter(([k]) => k !== LOCAL_MODELS_KEY)
      .sort(([a], [b]) => a.localeCompare(b));

    let priority = 10000;
    for (const [key, cfg] of entries) {
      if (!cfg || typeof cfg !== "object") { continue; }
      const base = (cfg.api_base ?? "").trim().replace(/\/+$/, "");
      if (!base || !/^https?:\/\//i.test(base)) { continue; }
      // ⚠️ A-1008：只剥 `/v1`，**故意不同于** joinApiEndpoint 的版本段通配 —— 别"顺手统一"。
      // 这是「剥版本段」，与「拼端点」是两种操作：若把厂商自带版本段（智谱 `…/api/paas/v4`）
      // 也剥掉，下游 ChatClient → joinApiEndpoint 看不到版本段 → 补 `/v1` → 404 回归。
      // 端点拼接唯一实现：core-ts/src/llm/client.ts 的 joinApiEndpoint。
      const primaryBase = base.endsWith("/v1") ? base.slice(0, -3) : base;

      // 启用模型（id 字符串 + selected !== false + 对话能力过滤）
      const enabled: string[] = [];
      const formats = new Map<string, ApiFormat>();
      if (Array.isArray(cfg.models)) {
        for (const m of cfg.models) {
          const id = m?.id;
          if (typeof id !== "string" || !id || m?.selected === false || !isChatCapableModel(id)) { continue; }
          enabled.push(id);
          const f = m?.api_format;
          if (f === "openai" || f === "anthropic" || f === "responses" || f === "google") {
            formats.set(id, f as ApiFormat);
          }
        }
      }

      const list = enabled.slice(0, maxModelsPerProvider);
      if (list.length === 0) {
        // 无模型列表也注入单路由（上游任模型；name 即 provider key）
        this.addRoute(key, primaryBase, cfg.api_key, undefined, priority--, cfg.api_format);
        continue;
      }
      for (let i = 0; i < list.length; i++) {
        const model = list[i];
        const fmt = formats.get(model) ?? cfg.api_format;
        this.addRoute(key, primaryBase, cfg.api_key, model, priority - i, fmt);
      }
      priority -= list.length;
    }
  }

  private addRoute(key: string, baseUrl: string, apiKey: string | undefined, model: string | undefined, priority: number, apiFormat?: ApiFormat): void {
    const route: RouteEntry = {
      name: model ? `${key}:${model}` : key,
      baseUrl,
      apiKey: apiKey || undefined,
      model,
      kind: "cloud",
      priority,
      roles: ["chat", "embedding"],
      api_format: apiFormat,
    };
    this.routes.push(route);
    this.byName.set(route.name, route);
    if (model) {
      const arr = this.byModel.get(model) ?? [];
      arr.push(route);
      this.byModel.set(model, arr);
    }
  }

  /** 列出可用模型（OpenAI /v1/models 兼容格式） */
  listModels(): Array<{ id: string; object: string; created: number; owned_by: string }> {
    const seen = new Set<string>();
    const out: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
    const created = Math.floor(Date.now() / 1000);
    for (const route of this.routes) {
      if (!route.model) { continue; }
      if (seen.has(route.model)) { continue; }
      seen.add(route.model);
      out.push({ id: route.model, object: "model", created, owned_by: route.name.split(":")[0] });
    }
    return out;
  }

  /** 解析客户端 model 字段 → 路由（provider:model 语法优先，纯名兜底） */
  resolveModel(requestedModel: string): ResolvedModel | null {
    const m = (requestedModel ?? "").trim();
    if (!m) { return null; }
    // 1) provider:model 语法
    const byName = this.byName.get(m);
    if (byName) { return { route: byName, displayModel: m }; }
    // 2) 纯模型名精确匹配
    const candidates = this.byModel.get(m);
    if (candidates && candidates.length > 0) { return { route: candidates[0], displayModel: m }; }
    return null;
  }

  /** 该网关是否为空（无任何可用模型） */
  get isEmpty(): boolean {
    return this.routes.length === 0;
  }

  /** 可用模型名清单（错误提示用） */
  get availableModelNames(): string[] {
    return [...this.byModel.keys()].sort();
  }

  /** 路由列表（诊断/测试用） */
  get routeList(): RouteEntry[] {
    return [...this.routes];
  }

  /** 非流式 chat：按 model 精确转发到上游，返回 OpenAI 兼容响应 */
  async chat(payload: ChatRequest, requestedModel: string): Promise<ChatResponse> {
    const resolved = this.resolveModel(requestedModel);
    if (!resolved) {
      throw new LlmGatewayError(404, `模型「${requestedModel}」未找到。可用模型：${this.availableModelNames.slice(0, 20).join(", ") || "（空）"}`);
    }
    const client = this.clientFactory(resolved.route);
    // 覆盖 model 为路由的精确模型 id（provider:model 语法时 route.model 才是真 id）
    const final = resolved.route.model ? { ...payload, model: resolved.route.model } : payload;
    const t0 = Date.now();
    let response: ChatResponse;
    try {
      response = await client.chat(final);
    } catch (e) {
      // 探针层：上游失败也过网关检测——记录错误类型 + 计算降级决策（供 slime 引擎读表规避）
      this.recordFailure(resolved.route, requestedModel, e, Date.now() - t0);
      throw e;
    }
    // 探针层：成功响应过网关检测后刷新实时能力快照（context/工具/reasoning/延迟）
    this.recordSuccess(resolved.route, requestedModel, response, Date.now() - t0);
    // 回显客户端请求名（而非内部 route 名）
    return { ...response, model: resolved.displayModel };
  }

  /** 流式 chat：按 model 精确转发，转 OpenAI SSE 格式逐帧回调 */
  async chatStream(
    payload: ChatRequest,
    requestedModel: string,
    callbacks: {
      onChunk: (chunk: ChatCompletionChunk) => void;
      onDone?: (usage?: { prompt_tokens?: number; completion_tokens?: number }) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const resolved = this.resolveModel(requestedModel);
    if (!resolved) {
      throw new LlmGatewayError(404, `模型「${requestedModel}」未找到。可用模型：${this.availableModelNames.slice(0, 20).join(", ") || "（空）"}`);
    }
    const client = this.clientFactory(resolved.route);
    const final = resolved.route.model ? { ...payload, model: resolved.route.model } : payload;
    const id = `chatcmpl-${randomId()}`;
    const created = Math.floor(Date.now() / 1000);
    const baseChunk = { id, object: "chat.completion.chunk" as const, created, model: resolved.displayModel };

    // 探针层：流式过程中记录能力位（是否出现 reasoning / tool_calls）
    let sawReasoning = false;
    let sawToolCalls = false;
    let result: import("../../core-ts/src/llm/client.js").ChatStreamResult;
    let index = 0;
    const t0 = Date.now();
    try {
      result = await client.chatStream(
        final,
        (delta) => {
          if (delta.length === 0) { return; }
          callbacks.onChunk({
            ...baseChunk,
            choices: [{ index, delta: { content: delta }, finish_reason: null }],
          });
        },
        signal,
        (reasoning) => {
          if (!reasoning) { return; }
          sawReasoning = true;
          callbacks.onChunk({
            ...baseChunk,
            choices: [{
              index,
              delta: { role: "assistant", reasoning_content: reasoning } as unknown as ChatCompletionChunk["choices"][number]["delta"],
              finish_reason: null,
            }],
          });
        },
        (toolCalls) => {
          sawToolCalls = toolCalls.length > 0;
          callbacks.onChunk({
            ...baseChunk,
            choices: [{ index, delta: { tool_calls: toolCalls }, finish_reason: null }],
          });
        },
      );
    } catch (e) {
      this.recordFailure(resolved.route, requestedModel, e, Date.now() - t0);
      throw e;
    }
    // 终止帧：finish_reason=stop
    callbacks.onChunk({
      ...baseChunk,
      choices: [{ index, delta: {}, finish_reason: "stop" }],
    });
    callbacks.onDone?.(result.usage);
    // 探针层：流式成功 → 刷新实时能力快照（streaming 必为 true + 实测 reasoning/tool/usage）
    this.recordStreamSuccess(resolved.route, requestedModel, result, sawReasoning, sawToolCalls, Date.now() - t0);
  }

  // ── 探针层第 2 层：实时响应探测（上游响应过网关后刷新能力快照 / 记录失败降级）──────────
  // 纯记录，不改变转发行为；未注入 liveProbe 时全部为 no-op（网关保持"精确转发"语义）。

  /** provider 键（route.name 形如 provider:model 或纯 provider，取冒号前） */
  private providerKey(route: RouteEntry): string {
    return route.name.split(":")[0];
  }

  /** 成功转发 → 刷新该 provider:model 的实时能力快照 */
  private recordSuccess(route: RouteEntry, requestedModel: string, resp: ChatResponse, latencyMs: number): void {
    if (!this.liveProbe) { return; }
    // 从 OpenAI 兼容响应里读能力位（reasoning_content / tool_calls）
    let hasReasoning = false;
    let hasToolCalls = false;
    for (const c of resp.choices ?? []) {
      const msg = c.message;
      if (!msg) { continue; }
      if (msg.reasoning_content) { hasReasoning = true; }
      if (msg.tool_calls && msg.tool_calls.length > 0) { hasToolCalls = true; }
    }
    const snap = extractSnapshot(this.providerKey(route), route.model ?? requestedModel, {
      ok: true,
      usage: resp.usage,
      hasReasoning,
      hasToolCalls,
      streamed: false,
      latencyMs,
      model: route.model ?? requestedModel,
    });
    this.liveProbe.put(snap);
  }

  /** 流式成功 → 刷新快照（streaming 必为 true；reasoning/tool 来自流内实测） */
  private recordStreamSuccess(
    route: RouteEntry,
    requestedModel: string,
    result: import("../../core-ts/src/llm/client.js").ChatStreamResult,
    sawReasoning: boolean,
    sawToolCalls: boolean,
    latencyMs: number,
  ): void {
    if (!this.liveProbe) { return; }
    const snap = extractSnapshot(this.providerKey(route), route.model ?? requestedModel, {
      ok: true,
      usage: result.usage,
      hasReasoning: sawReasoning,
      hasToolCalls: sawToolCalls,
      streamed: true,
      latencyMs,
      model: result.model || route.model || requestedModel,
    });
    this.liveProbe.put(snap);
  }

  /** 上游失败 → 记录错误类型 + 计算鉴权/端点降级决策（写进快照供引擎读表规避） */
  private recordFailure(route: RouteEntry, requestedModel: string, e: unknown, latencyMs: number): void {
    if (!this.liveProbe) { return; }
    const ue = e instanceof UpstreamError ? e : undefined;
    const status = ue?.status;
    // 合并粗类（kind/modelScope）+ 上游正文（含 "Model is unavailable"/"RegionError" 等信号），
    // 让 extractSnapshot → isModelDeadError 能精确判定「模型级失效」（404/下线/区域）vs「供应商级」。
    const errType = ue
      ? `${ue.kind === "rate_limited" ? "rate_limited" : ue.kind}${ue.modelScope ? `|${ue.modelScope}` : ""}|${ue.message}`
      : (e instanceof Error ? e.message : undefined);
    const snap = extractSnapshot(this.providerKey(route), route.model ?? requestedModel, {
      ok: false,
      errorStatus: status,
      errorType: errType,
      latencyMs,
    });
    // 决策可经 getRetryDecision 读取；这里落错误快照（保留最后成功能力位由缓存 TTL 决定）
    this.liveProbe.put(snap);
  }

  /** 读取某 provider:model 的最新实时能力快照（未过期） */
  getCapabilitySnapshot(provider: string, model: string): CapabilitySnapshot | null {
    return this.liveProbe?.get(provider, model) ?? null;
  }

  /** 给定失败现场，返回该路由的下一轮降级决策（鉴权/端点/放弃） */
  getRetryDecision(route: RouteEntry, errorType?: string, errorStatus?: number): RetryDecision {
    const auth = nextAuthOnFailure(route.api_format ?? "openai", errorType, errorStatus);
    const endpointSwap = nextEndpointOnFailure(route.baseUrl, errorStatus, errorType);
    const d: RetryDecision = { ...auth, reason: auth.reason };
    if (endpointSwap) { d.endpointSwap = endpointSwap; d.reason += `；端点可降级试 ${endpointSwap}`; }
    return d;
  }

  /** 全部实时能力快照（诊断/审计用） */
  allCapabilitySnapshots(): CapabilitySnapshot[] {
    return this.liveProbe?.all() ?? [];
  }
}

/** 网关错误（HTTP 层据此映射状态码） */
export class LlmGatewayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 生成随机 chunk id（chatcmpl- 前缀 + 28 位随机） */
function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 28; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

/** 便捷工厂：从 providers.enc.json 构建网关 */
export function createLlmGateway(opts: LlmGatewayOptions = {}): LlmGateway {
  return new LlmGateway(opts);
}