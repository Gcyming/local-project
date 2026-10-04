















import type { ApiFormat } from "./router.js";

import { isModelLevelErrorText } from "./upstreamErrorScope.js";


export interface CapabilitySnapshot {
  
  provider: string;
  
  model: string;
  
  contextWindow?: number;
  
  streaming?: boolean;
  
  toolCalls?: boolean;
  
  reasoning?: boolean;
  
  latencyMs?: number;
  
  lastErrorType?: string;
  





  modelDead?: boolean;
  
  ts: number;
}


type NowFn = () => number;


export class LiveProbeCache {
  private cache = new Map<string, CapabilitySnapshot>();
  private readonly ttlMs: number;
  private readonly now: NowFn;

  constructor(opts?: { ttlMs?: number; now?: NowFn }) {
    this.ttlMs = opts?.ttlMs ?? 5 * 60_000; 
    this.now = opts?.now ?? Date.now;
  }

  private key(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  
  put(snap: CapabilitySnapshot): void {
    this.cache.set(this.key(snap.provider, snap.model), snap);
  }

  
  get(provider: string, model: string): CapabilitySnapshot | null {
    const s = this.cache.get(this.key(provider, model));
    if (!s) { return null; }
    if (this.now() - s.ts >= this.ttlMs) { return null; }
    return s;
  }

  
  isStale(provider: string, model: string): boolean {
    return this.get(provider, model) === null;
  }

  


  isDead(provider: string, model: string): boolean {
    return this.get(provider, model)?.modelDead === true;
  }

  
  all(): CapabilitySnapshot[] {
    return [...this.cache.values()];
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  
  toJSON(): CapabilitySnapshot[] {
    return [...this.cache.values()];
  }

  
  hydrate(snapshots: CapabilitySnapshot[]): void {
    const now = this.now();
    for (const s of snapshots) {
      if (!s || typeof s.provider !== "string" || typeof s.model !== "string" || typeof s.ts !== "number") {
        continue;
      }
      if (now - s.ts >= this.ttlMs) { continue; } 
      this.cache.set(this.key(s.provider, s.model), s);
    }
  }
}


export interface UpstreamResponseSignal {
  ok: boolean;
  
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  
  hasToolCalls?: boolean;
  
  hasReasoning?: boolean;
  
  streamed?: boolean;
  
  latencyMs?: number;
  
  errorType?: string;
  errorStatus?: number;
  
  model?: string;
}











export function isModelDeadError(errorType: string | undefined, errorStatus?: number): boolean {
  const err = (errorType ?? "").toLowerCase();
  
  if (errorStatus === 404 || /not.*found|no.*model|model_dead/.test(err)) {
    return true;
  }
  
  
  return isModelLevelErrorText(err);
}





export function extractSnapshot(provider: string, model: string, sig: UpstreamResponseSignal, now?: NowFn): CapabilitySnapshot {
  const ts = (now ?? Date.now)();
  if (sig.ok) {
    const ctx = sig.usage?.prompt_tokens;
    return {
      provider,
      model: sig.model ?? model,
      contextWindow: ctx && ctx > 0 ? ctx * 2 : undefined, 
      streaming: sig.streamed === true,
      toolCalls: sig.hasToolCalls === true,
      reasoning: sig.hasReasoning === true,
      latencyMs: sig.latencyMs,
      ts,
    };
  }
  
  const modelDead = isModelDeadError(sig.errorType, sig.errorStatus);
  return {
    provider,
    model,
    lastErrorType: sig.errorType ?? (sig.errorStatus ? `HTTP ${sig.errorStatus}` : "unknown"),
    modelDead, 
    ts,
  };
}





export interface RetryDecision {
  
  authSwap?: "bearer" | "x-api-key" | "x-goog-api-key";
  
  endpointSwap?: string;
  
  abandon?: boolean;
  
  reason: string;
}

export function nextAuthOnFailure(format: ApiFormat, errorType: string | undefined, errorStatus?: number): RetryDecision {
  const err = (errorType ?? "").toLowerCase();
  
  if (errorStatus === 401 || errorStatus === 403 || /unauthor|forbidden|invalid.*key/.test(err)) {
    const swap: RetryDecision["authSwap"] = format === "openai" || format === "responses" ? "x-api-key" : "bearer";
    return { authSwap: swap, reason: `鉴权失败（${errorStatus ?? err}），换 ${swap} 重试` };
  }
  
  
  
  
  if (errorStatus === 404 || isModelLevelErrorText(err) || /not.*found|no.*model|model.*unavailable/.test(err)) {
    return { abandon: true, reason: "模型不可用，切换下一候选" };
  }
  
  if (errorStatus === 429 || /quota|rate|too.*many/.test(err)) {
    return { reason: "配额/限流，等待或换 provider（不换模型）" };
  }
  
  if ((errorStatus && errorStatus >= 500) || /region|unavailable|timeout|ECONN/.test(err)) {
    return { abandon: true, reason: `上游错误（${errorStatus ?? err}），降级到同供应商另一模型` };
  }
  return { reason: `未知错误（${errorStatus ?? err}），保持现状重试一次` };
}


export function nextEndpointOnFailure(current: string, errorStatus?: number, errorType?: string): string | undefined {
  const u = current.toLowerCase();
  
  if (u.endsWith("/api/v1/models")) {
    return errorStatus === 404 ? current.replace("/api/v1/models", "/models") : undefined;
  }
  
  if (u.endsWith("/v1/models")) {
    return errorStatus === 404 || /not.*found/.test(errorType ?? "") ? current.replace("/v1/models", "/api/v1/models") : undefined;
  }
  if (u.endsWith("/models") && !u.includes("/v1/")) {
    return undefined; 
  }
  return undefined;
}




let sharedLiveProbe: LiveProbeCache | null = null;


export function getSharedLiveProbe(opts?: { ttlMs?: number; now?: NowFn }): LiveProbeCache {
  if (!sharedLiveProbe) {
    sharedLiveProbe = new LiveProbeCache(opts);
  }
  return sharedLiveProbe;
}


export function setSharedLiveProbe(cache: LiveProbeCache | null): void {
  sharedLiveProbe = cache;
}

