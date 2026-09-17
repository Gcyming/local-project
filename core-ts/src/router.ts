/**
 * core-ts/src/router.ts — ModelRouter：统一路由 + OOM 降级链（阶段 3）。
 * 语义对齐：
 * - 原项目 model_choice 三选一（inherit / api:<key> / local:path）的"统一路由"抽象：
 *   本地（sidecar/llama-server）与云端（OpenAI 兼容）同表，按 priority 选路。
 * - 降级链（规划 §9 阶段 3）：请求首选失败且失败类型可降级 →
 *   按 priority 降序尝试下一候选；全部失败 → 聚合错误（如实报告，不虚报成功）。
 * - 诚实协议约束：流式一旦收到首个 chunk（onDelta 被调用）→ 不再降级，
 *   抛错给上层（避免静默切源造成内容重复/丢失）。
 */

import { ChatClient, AnthropicClient, ResponsesClient, GoogleClient, ChatStreamResult, UpstreamError, REASONING_PAYLOAD_KEYS } from "./llm/client.js";
import { ChatRequest, ChatResponse, ChatToolCallDelta } from "shared/schemas";

export type RouteKind = "local" | "cloud";
/**
 * API 端点格式（全平台适配）：
 *   - "openai"    ：OpenAI Chat Completions（/v1/chat/completions，绝大多数模型/网关）
 *   - "anthropic" ：Anthropic Messages（/v1/messages，Claude）
 *   - "responses" ：OpenAI Responses（/v1/responses，GPT-5 系列）
 *   - "google"    ：Google Gemini 原生（/v1beta/models/{model}:generateContent）
 *   - "auto"      ：按 baseUrl 推断（见 inferApiFormat）
 */
export type ApiFormat = "openai" | "anthropic" | "responses" | "google" | "auto";

export interface RouteEntry {
  name: string;
  baseUrl: string;
  apiKey?: string;
  kind: RouteKind;
  /** 数值越大优先级越高 */
  priority: number;
  roles: Array<"chat" | "embedding">;
  /** 请求体 model 名（云端必填；本地缺省时由上游决定） */
  model?: string;
  /** 路由级超时覆盖（默认走 ChatClient 120s） */
  timeoutMs?: number;
  /** API 端点格式：auto 时按 baseUrl 推断 */
  api_format?: ApiFormat;
}

/** 根据 base_url 推断默认 api_format */
export function inferApiFormat(baseUrl: string): ApiFormat {
  const url = (baseUrl ?? "").toLowerCase();
  if (url.includes("anthropic") || url.includes("/v1/messages")) { return "anthropic"; }
  if (url.includes("generativelanguage.googleapis.com") || url.includes("googleapis") || url.includes("/v1beta")) { return "google"; }
  return "openai";
}

export interface FallbackRecord {
  from: string;
  to: string;
  reason: string;
  ts: number;
}

export interface ChatResult {
  response: ChatResponse;
  routeName: string;
}

export interface ChatStreamResultRouted extends ChatStreamResult {
  routeName: string;
}

export type ClientFactory = (route: RouteEntry) => ChatClient | AnthropicClient | ResponsesClient | GoogleClient;

/** 根据 route 的 api_format 创建对应的客户端（全平台：openai/anthropic/responses/google） */
function createClient(route: RouteEntry): ChatClient | AnthropicClient | ResponsesClient | GoogleClient {
  const format = route.api_format === "anthropic" ? "anthropic"
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

/** 可降级失败：OOM（503/local_model_error）、网络不可达/超时、429 配额、以及「模型级错误」
 *  （A-157：RegionError 区域限制 / Model is unavailable / 404 模型不存在 —— 换同一供应商的
 *  另一个模型即可恢复，必须降级而非整链红字）。
 *  供应商级 4xx（401 认证 / 403 非区域权限）不降级（换模型不会成功）。 */
function isFallbackError(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) {
    return true; // 未知错误（网络层）→ 降级
  }
  // A-157：显式标注「该模型不可用」（换模型可恢复）→ 即使 4xx 也允许降级
  if (e.modelScope === "model") {
    return true;
  }
  if (e.modelScope === "provider") {
    return false;
  }
  if (e.status >= 400 && e.status < 500 && e.status !== 429) {
    return false;
  }
  return true;
}

/** 401 诊断：附上可操作的排查建议（API Key 无效/缺失/过期、Base URL 指向错误） */
function diag401(route: RouteEntry, reason: string): string {
  return (
    `${route.name}: ${reason}（401 认证失败：请到 设置 → 模型供应商 核对「${route.name}」的 API Key 是否有效/未过期，` +
    `并确认 Base URL 指向正确（当前 ${route.baseUrl || "（空）"}）；部分网关同一 Key 仅对特定模型生效）`
  );
}

/** A-918++：opencode 中转站特判——给准确指引（官方 Zen 端点 + key 获取方式）
 *  根因：用户手填 baseUrl 常错（如 opencode-zen-1 内部名），官方是 https://opencode.ai/zen/v1，
 *  key 在 opencode.ai/auth 登录获取；免费 -free 模型限流较严，付费/自带 key 更稳 */
function diagOpencodeFreeTier(route: RouteEntry, reason: string): string {
  const isOpencode = /opencode/i.test(route.name) || /opencode/i.test(route.baseUrl ?? "");
  if (!isOpencode) { return `${route.name}: ${reason}`; }
  return (
    `${route.name}: ${reason}（OpenCode Zen 官方端点 https://opencode.ai/zen/v1，key 到 opencode.ai/auth 登录获取；` +
    `免费 -free 模型限流较严，建议用付费/自带 key。可在 设置 → 模型供应商 选「OpenCode Zen」预设自动填充）`
  );
}

/** 将单条路由失败格式化为诊断行（401 特判 + opencode 免费池 400 特判） */
function routeErrorLine(route: RouteEntry, e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  if (e instanceof UpstreamError && e.status === 401) {
    return diag401(route, reason);
  }
  if (e instanceof UpstreamError && e.status === 400) {
    return diagOpencodeFreeTier(route, reason);
  }
  return `${route.name}: ${reason}`;
}

export class ModelRouter {
  private routes: RouteEntry[] = [];
  private createClient: ClientFactory;
  private fallbacks: FallbackRecord[] = [];
  /** A-158：路由熔断冷却（route.name → 冷却截止 epoch ms）。可降级失败的路由短期
   *  冷却，fallbackChain 跳过冷却中的候选——防止「同池 8 个模型连环超时/429」的
   *  无效串联等待（免费池整体限流时尤其致命）。冷却到期自动恢复。 */
  private cooldowns = new Map<string, number>();
  /** A-968：全局熔断器（provider 维度）。连续 N 次失败时熔断 provider 级别所有路由
   *  T 秒——避免单 provider 整体不可用（如 API key 失效/区域限制）时仍逐个模型重试。
   *  key = provider.name（不是 route.name，粒度更粗，一次熔断路由全部） */
  private circuitBreakers = new Map<string, { failures: number; until: number }>();
  /**
   * 按「实际发出的模型」解析思考/推理参数的钩子（由引擎注入）。
   * 为什么必须挂在路由层：同一次请求可能因降级链在不同模型间切换，而各模型的思考开关
   * 协议不同（OpenAI o 系 `reasoning_effort` / llama.cpp-agnès 系 `chat_template_kwargs.enable_thinking`
   * / Anthropic `thinking.budget_tokens`）。若在构造 payload 时按「首选模型」写死，降级后
   * 参数与实际模型不匹配——典型症状就是「开了思考却没有思考内容」。
   * 返回 null = 不改动 payload。
   */
  private reasoningParamsFor: ((modelId: string, kind: string, baseUrl: string) => Record<string, unknown> | null) | null = null;
  /**
   * 探针层第 2 层接线：「已知失效模型」前置剔除钩子（由引擎注入，读共享 LiveProbeCache）。
   * 返回 true = 该 provider:model 已被实时探测判定为模型级失效（404/下线/区域），
   * fallbackChain 直接跳过它，避免再为已知失效模型浪费一次请求。
   * 仅对「带具体 model 的路由」生效；无 model 的单路由（上游任模型）不剔除（无法定位具体模型）。
   */
  private deadModelCheck: ((providerKey: string, modelId: string) => boolean) | null = null;

  constructor(routes: RouteEntry[] = [], createClientFn?: ClientFactory) {
    this.routes = [...routes];
    this.createClient = createClientFn ?? createClient;
  }

  /** 注入「已知失效模型」判定钩子（引擎在创建 router 后调用，读实时探测共享缓存）。
   *  传 null 复位（不做前置剔除，回到纯 priority 降级链）。 */
  setDeadModelCheck(fn: ((providerKey: string, modelId: string) => boolean) | null): void {
    this.deadModelCheck = fn;
  }

  /** 路由的 provider 键（name 形如 provider:model，取冒号前；与 providerKeyOf 语义一致但面向模型快照） */
  private static nameProviderKey(route: RouteEntry): string {
    return route.name.split(":")[0];
  }

  /** 注入「按模型解析思考参数」的钩子（引擎在创建 router 后立即调用）。
   *  baseUrl 传入以感知访问路径——同一模型名在中转站 vs 官方端点下协议不同（见 isAggregatorGateway）。 */
  setReasoningParamsResolver(fn: ((modelId: string, kind: string, baseUrl: string) => Record<string, unknown> | null) | null): void {
    this.reasoningParamsFor = fn;
  }

  add(route: RouteEntry): void {
    this.routes.push(route);
  }

  /** 设置某路由冷却（ms），然后清理过期项 */
  markCooldown(routeName: string, ms: number): void {
    this.cooldowns.set(routeName, Date.now() + ms);
  }

  /** A-968：provider 维度标识——同一 baseUrl 视为同一供应商（route 无独立 provider 字段） */
  private static providerKeyOf(route: RouteEntry): string {
    return route.baseUrl || route.name;
  }

  /** A-968：全局熔断器——同一 provider 连续失败达到阈值时熔断 T 秒。
   *  reset 时累计次数清零（成功恢复），每次失败 +1。 */
  recordProviderFailure(providerName: string, ms: number): void {
    const now = Date.now();
    const cur = this.circuitBreakers.get(providerName) ?? { failures: 0, until: 0 };
    const next = { failures: cur.failures + 1, until: now + ms };
    this.circuitBreakers.set(providerName, next);
    console.warn(`[router] 熔断：provider=${providerName} 连续失败 ${next.failures} 次，熔断 ${ms}ms`);
  }

  /** 重置某 provider 的熔断计数（成功调用后调用，消除累计失败数） */
  resetProviderCircuit(providerName: string): void {
    this.circuitBreakers.delete(providerName);
  }

  /** 清理已超期的熔断记录 */
  private _flushCircuitBreakers(): void {
    const now = Date.now();
    for (const [name, v] of this.circuitBreakers) {
      if (v.until <= now) { this.circuitBreakers.delete(name); }
    }
  }

  /** 冷却中的路由名（诊断/测试用） */
  cooldownList(): string[] {
    const now = Date.now();
    return [...this.cooldowns.entries()]
      .filter(([, until]) => until > now)
      .map(([name]) => name);
  }

  /** 取指定角色的当前首选路由（按 priority 降序，稳定排序） */
  select(role: "chat" | "embedding"): RouteEntry | undefined {
    return this.fallbackChain(role)[0];
  }

  /** 降级链：按优先级降序的可用候选（A-158：跳过冷却中的路由；
   *  A-968：跳过全局熔断的 provider（同一 baseUrl 视为同一供应商）；若全部冷却则回退全量，
   *  避免「所有候选都被冷却」时直接空链报死） */
  fallbackChain(role: "chat" | "embedding"): RouteEntry[] {
    const now = Date.now();
    // 顺带清理过期冷却（防 Map 无限增长）
    for (const [name, until] of this.cooldowns) {
      if (until <= now) { this.cooldowns.delete(name); }
    }
    this._flushCircuitBreakers();
    const all = [...this.routes]
      .filter((r) => r.roles.includes(role))
      .sort((a, b) => b.priority - a.priority);
    const cooled = new Set([...this.cooldowns.keys()].filter((n) => (this.cooldowns.get(n) ?? 0) > now));
    // A-968：熔断维度在 provider 级别
    const circuited = new Set(
      [...this.circuitBreakers.entries()]
        .filter(([, v]) => v.until > now)
        .map(([name]) => name),
    );
    const hot = all.filter((r) => {
      if (cooled.has(r.name)) { return false; }
      if (circuited.has(ModelRouter.providerKeyOf(r))) { return false; }
      // 探针层第 2 层：剔除已被实时探测判定为「模型级失效」的路由（404/下线/区域），
      // 避免再为已知失效模型浪费一次请求。仅对带具体 model 的路由生效。
      if (this.deadModelCheck && r.model && this.deadModelCheck(ModelRouter.nameProviderKey(r), r.model)) { return false; }
      return true;
    });
    // 全部候选都被冷却/熔断/判失效 → 回退全量（避免空链直接报死，仍让上游给真实错误）
    return hot.length > 0 ? hot : all;
  }

  list(): RouteEntry[] {
    return [...this.routes];
  }

  reset(): void {
    this.routes = [];
    this.fallbacks = [];
  }

  /** 降级记录（观察用；/stats 或日志消费） */
  fallbackLog(): FallbackRecord[] {
    return [...this.fallbacks];
  }

  get fallbackCount(): number {
    return this.fallbacks.length;
  }

  /** 请求注入路由 model（A-157 修正语义：路由 model 优先，模型池降级链才能真正换模型）。
   *  此前「payload 已显式 model 时不覆盖」——多重路由（同供应商多候选模型）降级时
   *  首选失败后 payload 仍钉在首选 model，次选/三选路由发出同样的模型名 → 换模型永不生效。
   *  路由是降级链的「该候选模型的最终表述」，即使调用方预置了 model 也应被路由覆盖。
   *
   *  同时按「本条路由实际使用的模型」重算思考参数（见 reasoningParamsFor 注释）：
   *  先清除 payload 上可能残留的思考键，再合并该模型专属的参数——保证降级换模型后
   *  思考开关仍然与模型协议一致。 */
  private withModel(payload: ChatRequest, route: RouteEntry): ChatRequest {
    const modelId = route.model ?? route.name ?? "";
    const base: ChatRequest = route.model ? { ...payload, model: route.model } : payload;
    return ModelRouter.applyReasoningParams(base, modelId, route.kind, route.baseUrl, this.reasoningParamsFor);
  }

  /** 会被「思考参数解析」覆写的键：换模型时必须先剔除，避免把 A 模型的协议参数发给 B 模型。
   *  清单与 llm/client.ts 的 REASONING_PAYLOAD_KEYS 同源（client 用它做 400 容错剥除）。 */
  private static readonly REASONING_KEYS = REASONING_PAYLOAD_KEYS;

  private static applyReasoningParams(
    payload: ChatRequest,
    modelId: string,
    kind: string,
    baseUrl: string,
    resolver: ((modelId: string, kind: string, baseUrl: string) => Record<string, unknown> | null) | null,
  ): ChatRequest {
    if (!resolver) { return payload; }
    let resolved: Record<string, unknown> | null = null;
    try {
      resolved = resolver(modelId, kind, baseUrl);
    } catch {
      return payload; // 解析钩子异常不影响请求
    }
    if (resolved === null) { return payload; }
    const out = { ...payload } as Record<string, unknown>;
    for (const k of ModelRouter.REASONING_KEYS) {
      if (k in out) { delete out[k]; }
    }
    for (const [k, v] of Object.entries(resolved)) {
      out[k] = v;
    }
    return out as unknown as ChatRequest;
  }

  /** A-980-R24：降级记录**环形上限**。此前是纯数组只 push（仅 `reset()` 时清空），
   *  长会话里反复降级会让它无限增长；虽然每条很小，但它是常驻主进程生命周期的对象，
   *  且 `fallbackCount` / `recentFallbacks` 会周期性被 IPC 拉取序列化 → 越用越大。
   *  保留最近 N 条足够归因（面板最多也就展示十几条）。 */
  private static readonly FALLBACK_KEEP = 50;

  private recordFallback(from: string, to: string | null, reason: string): void {
    this.fallbacks.push({ from, to: to ?? "", reason, ts: Date.now() });
    if (this.fallbacks.length > ModelRouter.FALLBACK_KEEP) {
      this.fallbacks.splice(0, this.fallbacks.length - ModelRouter.FALLBACK_KEEP);
    }
  }

  /** A-158：按错误类型决定冷却时长（ms）——429/503/网络瞬时 → 短冷（避免连试同池）；
   *  模型下线/区域限制（换模型可恢复但同一模型短时间内必再失败）→ 中冷；
   *  401 供应商级 → 1 分钟（换 Key 前再试无意义，但留给用户处理时间）。 */
  private static cooldownMsFor(e: unknown): number {
    if (e instanceof UpstreamError) {
      if (e.modelScope === "provider") { return 60_000; }
      if (e.status === 429 || e.status === 503 || e.status === 504 || e.status === 529) { return 30_000; }
      if (e.modelScope === "model") { return 300_000; }
    }
    return 15_000; // 网络级瞬时错误（非 UpstreamError）→ 短冷
  }

  /**
   * 非流式 chat：逐级降级尝试。
   * 4xx（除 429）不降级；全部失败抛聚合错误。
   * A-158：可降级失败的路由自动熔断冷却，本轮跳过、后续请求优先避开。
   */
  async chat(payload: ChatRequest): Promise<ChatResult> {
    const chain = this.fallbackChain("chat");
    if (chain.length === 0) {
      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);
    }
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const route = chain[i];
      try {
        const response = await this.createClient(route).chat(this.withModel(payload, route));
        this.resetProviderCircuit(ModelRouter.providerKeyOf(route)); // A-968：成功调用重置 provider 熔断计数
        return { response, routeName: route.name };
      } catch (e) {
        const reason = routeErrorLine(route, e);
        errors.push(reason);
        if (i < chain.length - 1) {
          this.markCooldown(route.name, ModelRouter.cooldownMsFor(e));
          // A-968：单 provider 连续失败 → 熔断整个 provider（避免同池 8 个模型连环超时/429）
          this.recordProviderFailure(ModelRouter.providerKeyOf(route), ModelRouter.cooldownMsFor(e));
        }
        if (!isFallbackError(e) || i === chain.length - 1) {
          break; // 请求语义错误或已到链尾：不降级也不记 fallback
        }
        this.recordFallback(route.name, chain[i + 1].name, reason);
      }
    }
    throw new Error(`chat 全部路由失败: ${errors.join(" | ")}`);
  }

  /**
   * 流式 chat：仅"请求建立前"失败可降级；首个 chunk 之后抛错不降级。
   * onReasoning：透传上游 reasoning_content（思考模式展示）。
   * onToolDelta：透传 delta.tool_calls 增量（真流式工具循环用）。
   */
  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onToolDelta?: (toolCalls: ChatToolCallDelta[]) => void,
  ): Promise<ChatStreamResultRouted> {
    const chain = this.fallbackChain("chat");
    if (chain.length === 0) {
      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);
    }
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const route = chain[i];
      let started = false;
      try {
        const result = await this.createClient(route).chatStream(this.withModel(payload, route), (d) => {
          started = true;
          onDelta(d);
        }, signal, onReasoning, onToolDelta);
        this.resetProviderCircuit(ModelRouter.providerKeyOf(route)); // A-968
        return { ...result, routeName: route.name };
      } catch (e) {
        if (signal?.aborted) {
          // 用户主动中断：如实上抛，不降级、不记录 fallback
          throw e;
        }
        const reason = routeErrorLine(route, e);
        errors.push(reason);
        if (started) {
          // 诚实协议：已开流则如实失败，不静默切源
          throw new Error(`流式中断（${route.name}，已收到部分内容，不降级）: ${reason}`);
        }
        if (i < chain.length - 1) {
          this.markCooldown(route.name, ModelRouter.cooldownMsFor(e));
          // A-968：单 provider 连续失败 → 熔断整个 provider
          this.recordProviderFailure(ModelRouter.providerKeyOf(route), ModelRouter.cooldownMsFor(e));
        }
        if (!isFallbackError(e) || i === chain.length - 1) {
          break;
        }
        this.recordFallback(route.name, chain[i + 1].name, reason);
      }
    }
    throw new Error(`chatStream 全部路由失败: ${errors.join(" | ")}`);
  }
}