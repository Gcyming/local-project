










import { ChatClient, AnthropicClient, ResponsesClient, GoogleClient, ChatStreamResult, UpstreamError, REASONING_PAYLOAD_KEYS } from "./llm/client.js";

import { noteUpstream, formatFallbackNotice } from "./llm/upstreamNotice.js";

import { applyMaxTokensCap } from "./llm/maxTokens.js";


import { sanitizeWirePayload } from "./services/outgoingMessages.js";
import { ChatRequest, ChatResponse, ChatToolCallDelta } from "shared/schemas";

export type RouteKind = "local" | "cloud";








export type ApiFormat = "openai" | "anthropic" | "responses" | "google" | "auto";

export interface RouteEntry {
  name: string;
  baseUrl: string;
  apiKey?: string;
  kind: RouteKind;
  
  priority: number;
  roles: Array<"chat" | "embedding">;
  
  model?: string;
  
  timeoutMs?: number;
  
  api_format?: ApiFormat;
}


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







export function providerKeyOfRoute(route: RouteEntry): string {
  return route.baseUrl || route.name;
}












export function createRouteClient(route: RouteEntry, fetchImpl?: typeof fetch): ChatClient | AnthropicClient | ResponsesClient | GoogleClient {
  const format = route.api_format === "anthropic" ? "anthropic"
    : route.api_format === "responses" ? "responses"
    : route.api_format === "google" ? "google"
    : route.api_format === "openai" ? "openai"
    : inferApiFormat(route.baseUrl);
  
  
  
  const opts = {
    baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs,
    rateLimit: { key: providerKeyOfRoute(route), model: route.model },
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  if (format === "anthropic") { return new AnthropicClient(opts); }
  if (format === "responses") { return new ResponsesClient(opts); }
  if (format === "google") { return new GoogleClient(opts); }
  return new ChatClient(opts);
}





function isFallbackError(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) {
    return true; 
  }
  
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


function diag401(route: RouteEntry, reason: string): string {
  return (
    `${route.name}: ${reason}（401 认证失败：请到 设置 → 模型供应商 核对「${route.name}」的 API Key 是否有效/未过期，` +
    `并确认 Base URL 指向正确（当前 ${route.baseUrl || "（空）"}）；部分网关同一 Key 仅对特定模型生效）`
  );
}




function diagOpencodeFreeTier(route: RouteEntry, reason: string): string {
  const isOpencode = /opencode/i.test(route.name) || /opencode/i.test(route.baseUrl ?? "");
  if (!isOpencode) { return `${route.name}: ${reason}`; }
  return (
    `${route.name}: ${reason}（OpenCode Zen 官方端点 https://opencode.ai/zen/v1，key 到 opencode.ai/auth 登录获取；` +
    `免费 -free 模型限流较严，建议用付费/自带 key。可在 设置 → 模型供应商 选「OpenCode Zen」预设自动填充）`
  );
}


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
  


  private cooldowns = new Map<string, number>();
  


  private circuitBreakers = new Map<string, { failures: number; until: number }>();
  







  private reasoningParamsFor: ((modelId: string, kind: string, baseUrl: string) => Record<string, unknown> | null) | null = null;
  





  private deadModelCheck: ((providerKey: string, modelId: string) => boolean) | null = null;

  constructor(routes: RouteEntry[] = [], createClientFn?: ClientFactory) {
    this.routes = [...routes];
    
    
    
    this.createClient = createClientFn ?? createRouteClient;
  }

  

  setDeadModelCheck(fn: ((providerKey: string, modelId: string) => boolean) | null): void {
    this.deadModelCheck = fn;
  }

  
  private static nameProviderKey(route: RouteEntry): string {
    return route.name.split(":")[0];
  }

  

  setReasoningParamsResolver(fn: ((modelId: string, kind: string, baseUrl: string) => Record<string, unknown> | null) | null): void {
    this.reasoningParamsFor = fn;
  }

  add(route: RouteEntry): void {
    this.routes.push(route);
  }

  
  markCooldown(routeName: string, ms: number): void {
    this.cooldowns.set(routeName, Date.now() + ms);
  }

  
  private static providerKeyOf(route: RouteEntry): string {
    return providerKeyOfRoute(route);
  }

  

  recordProviderFailure(providerName: string, ms: number): void {
    const now = Date.now();
    const cur = this.circuitBreakers.get(providerName) ?? { failures: 0, until: 0 };
    const next = { failures: cur.failures + 1, until: now + ms };
    this.circuitBreakers.set(providerName, next);
    console.warn(`[router] 熔断：provider=${providerName} 连续失败 ${next.failures} 次，熔断 ${ms}ms`);
  }

  
  resetProviderCircuit(providerName: string): void {
    this.circuitBreakers.delete(providerName);
  }

  
  private _flushCircuitBreakers(): void {
    const now = Date.now();
    for (const [name, v] of this.circuitBreakers) {
      if (v.until <= now) { this.circuitBreakers.delete(name); }
    }
  }

  
  cooldownList(): string[] {
    const now = Date.now();
    return [...this.cooldowns.entries()]
      .filter(([, until]) => until > now)
      .map(([name]) => name);
  }

  
  select(role: "chat" | "embedding"): RouteEntry | undefined {
    return this.fallbackChain(role)[0];
  }

  


  fallbackChain(role: "chat" | "embedding"): RouteEntry[] {
    const now = Date.now();
    
    for (const [name, until] of this.cooldowns) {
      if (until <= now) { this.cooldowns.delete(name); }
    }
    this._flushCircuitBreakers();
    const all = [...this.routes]
      .filter((r) => r.roles.includes(role))
      .sort((a, b) => b.priority - a.priority);
    const cooled = new Set([...this.cooldowns.keys()].filter((n) => (this.cooldowns.get(n) ?? 0) > now));
    
    const circuited = new Set(
      [...this.circuitBreakers.entries()]
        .filter(([, v]) => v.until > now)
        .map(([name]) => name),
    );
    const hot = all.filter((r) => {
      if (cooled.has(r.name)) { return false; }
      if (circuited.has(ModelRouter.providerKeyOf(r))) { return false; }
      
      
      if (this.deadModelCheck && r.model && this.deadModelCheck(ModelRouter.nameProviderKey(r), r.model)) { return false; }
      return true;
    });
    
    return hot.length > 0 ? hot : all;
  }

  list(): RouteEntry[] {
    return [...this.routes];
  }

  reset(): void {
    this.routes = [];
    this.fallbacks = [];
  }

  
  fallbackLog(): FallbackRecord[] {
    return [...this.fallbacks];
  }

  get fallbackCount(): number {
    return this.fallbacks.length;
  }

  












  private withModel(payload: ChatRequest, route: RouteEntry): ChatRequest {
    const modelId = route.model ?? route.name ?? "";
    const base: ChatRequest = route.model ? { ...payload, model: route.model } : payload;
    const withReasoning = ModelRouter.applyReasoningParams(base, modelId, route.kind, route.baseUrl, this.reasoningParamsFor);
    return applyMaxTokensCap(withReasoning, modelId);
  }

  

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
      return payload; 
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

  



  private static readonly FALLBACK_KEEP = 50;

  private recordFallback(from: string, to: string | null, reason: string): void {
    this.fallbacks.push({ from, to: to ?? "", reason, ts: Date.now() });
    if (this.fallbacks.length > ModelRouter.FALLBACK_KEEP) {
      this.fallbacks.splice(0, this.fallbacks.length - ModelRouter.FALLBACK_KEEP);
    }
    


    noteUpstream("fallback", formatFallbackNotice(from, to ?? ""));
  }

  


  private static cooldownMsFor(e: unknown): number {
    if (e instanceof UpstreamError) {
      if (e.modelScope === "provider") { return 60_000; }
      if (e.status === 429 || e.status === 503 || e.status === 504 || e.status === 529) { return 30_000; }
      if (e.modelScope === "model") { return 300_000; }
    }
    return 15_000; 
  }

  




  async chat(payload: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    










    payload = sanitizeWirePayload(payload); 
    const chain = this.fallbackChain("chat");
    if (chain.length === 0) {
      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);
    }
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const route = chain[i];
      try {
        const response = await this.createClient(route).chat(this.withModel(payload, route), signal);
        this.resetProviderCircuit(ModelRouter.providerKeyOf(route)); 
        return { response, routeName: route.name };
      } catch (e) {
        
        if (signal?.aborted) { throw e; }
        const reason = routeErrorLine(route, e);
        errors.push(reason);
        if (i < chain.length - 1) {
          this.markCooldown(route.name, ModelRouter.cooldownMsFor(e));
          
          this.recordProviderFailure(ModelRouter.providerKeyOf(route), ModelRouter.cooldownMsFor(e));
        }
        if (!isFallbackError(e) || i === chain.length - 1) {
          break; 
        }
        this.recordFallback(route.name, chain[i + 1].name, reason);
      }
    }
    throw new Error(`chat 全部路由失败: ${errors.join(" | ")}`);
  }

  




  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onToolDelta?: (toolCalls: ChatToolCallDelta[]) => void,
  ): Promise<ChatStreamResultRouted> {
    

    payload = sanitizeWirePayload(payload); 
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
        this.resetProviderCircuit(ModelRouter.providerKeyOf(route)); 
        return { ...result, routeName: route.name };
      } catch (e) {
        if (signal?.aborted) {
          
          throw e;
        }
        const reason = routeErrorLine(route, e);
        errors.push(reason);
        if (started) {
          
          throw new Error(`流式中断（${route.name}，已收到部分内容，不降级）: ${reason}`);
        }
        if (i < chain.length - 1) {
          this.markCooldown(route.name, ModelRouter.cooldownMsFor(e));
          
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