





import { ChatCompletionChunk, ChatRequest, ChatResponse, ChatToolCallDelta } from "shared/schemas";


import { modelScopeFromUpstreamText } from "../upstreamErrorScope.js";

import { noteUpstream, formatRetryNotice, formatPrefillNotice } from "./upstreamNotice.js";

import { getSharedRpmLimiter, parseRateLimitHeaders } from "./rpmLimiter.js";



export const RETRY_429_BACKOFF = [5.0, 15.0, 30.0, 60.0];







export const IDLE_STREAM_MS = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_STREAM_IDLE_MS : undefined;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) { return Math.floor(n); }
  }
  
  
  
  
  
  return 300_000;
})();








export const DEFAULT_LLM_TIMEOUT_MS = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_LLM_TIMEOUT_MS : undefined;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) { return Math.floor(n); }
  }
  return 300_000;
})();

























export const FIRST_BYTE_BASE_MS = envMs("SLIME_FIRST_BYTE_BASE_MS", 120_000);
export const FIRST_BYTE_PER_K_MS = envMs("SLIME_FIRST_BYTE_PER_K_MS", 4_000);
export const FIRST_BYTE_MAX_MS = envMs("SLIME_FIRST_BYTE_MAX_MS", 900_000);


function envMs(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env[name] : undefined;
  if (!raw) { return fallback; }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}











export function firstByteBudgetMs(inputTokens: number): number {
  const floor = IDLE_STREAM_MS;
  const max = Math.max(floor, FIRST_BYTE_MAX_MS);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) { return floor; }
  const perK = Math.max(0, FIRST_BYTE_PER_K_MS);
  const scaled = FIRST_BYTE_BASE_MS + Math.ceil(inputTokens / 1000) * perK;
  return Math.min(max, Math.max(floor, scaled));
}










export function roughInputTokens(payload: unknown): number {
  if (payload === null || payload === undefined) { return 0; }
  let text: string;
  try {
    text = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    return 0;
  }
  if (!text) { return 0; }
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}












const VERSION_TAIL_RE = /\/v\d+[a-z]*$/i;


const LEADING_VERSION_RE = /^\/v\d+[a-z]*/i;



















export function joinApiEndpoint(baseUrl: string, path: string): string {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  if (!base) { return path; }
  if (base.endsWith(path)) { return base; }
  const fnPath = path.replace(LEADING_VERSION_RE, "");
  if (fnPath && base.endsWith(fnPath)) { return base; }
  if (VERSION_TAIL_RE.test(base)) { return `${base}${fnPath}`; }
  return `${base}${path}`;
}



function raceIdleTimeout<T>(p: Promise<T>, idleMs: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new UpstreamError(`流式空闲超时（${idleMs}ms 无数据）`, 0, "timeout")), idleMs);
    }),
  ]).finally(() => { if (t !== undefined) { clearTimeout(t); } });
}







const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

const RETRY_TRANSIENT_BACKOFF = [1.0, 3.0, 7.0];




function jitteredDelay(maxMs: number): number {
  return Math.floor(Math.random() * maxMs) || 1;
}

const MAX_RETRY_AFTER_S = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}


function parseRetryAfterSeconds(headers: Headers): number | null {
  if (!headers) { return null; }
  const raw = headers.get("retry-after");
  if (!raw) { return null; }
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) { return Math.ceil(secs); }
  const t = Date.parse(raw);
  if (Number.isFinite(t)) {
    return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  }
  return null;
}


function retryDelayMs(resp: Response, attempt: number): number {
  const fromHeader = parseRetryAfterSeconds(resp.headers);
  if (fromHeader !== null) { return Math.min(fromHeader, MAX_RETRY_AFTER_S) * 1000; }
  const table = resp.status === 429 ? RETRY_429_BACKOFF : RETRY_TRANSIENT_BACKOFF;
  return (table[attempt] ?? 60) * 1000;
}


function combineAbortSignal(external?: AbortSignal, timeoutMs?: number): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      external.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => external.removeEventListener("abort", onAbort));
    }
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }
  return { controller, cleanup: () => cleanups.forEach((f) => f()) };
}



async function jsonWithTimeout<T>(resp: Response, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resp.json() as Promise<T>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamError(`上游响应正文读取超时（${timeoutMs}ms）`, 0, "timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
  }
}






export interface RateLimitIdentity {
  key: string;
  model?: string;
}

















async function fetchWithRetry(opts: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  maxAttempts: number;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
  
  rateLimit?: RateLimitIdentity;
}): Promise<Response> {
  const { fetchImpl, url, init, maxAttempts, timeoutMs, externalSignal, rateLimit } = opts;
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      throw new UpstreamError("请求已取消", 0, "protocol");
    }
    
    
    if (rateLimit) {
      
      
      
      await getSharedRpmLimiter().acquire(rateLimit.key, rateLimit.model, (ms) => {
        
        
        if (ms >= 1000) {
          noteUpstream(
            "retry",
            `上游每分钟请求额度已用满，需要等 ${Math.round(ms / 1000)}s 再发 —— 这是避免撞限流（429）的自我保护，不是故障。`,
          );
        }
      });
      if (externalSignal?.aborted) {
        throw new UpstreamError("请求已取消", 0, "protocol");
      }
    }
    const { controller, cleanup } = combineAbortSignal(externalSignal, timeoutMs);
    try {
      const resp = await fetchImpl(url, { ...init, signal: controller.signal });
      
      
      if (rateLimit) {
        try {
          getSharedRpmLimiter().observe(
            rateLimit.key,
            parseRateLimitHeaders((n) => resp.headers.get(n)),
            resp.status,
          );
        } catch {  }
      }
      if (!isTransientStatus(resp.status) || attempt === maxAttempts - 1) {
        return resp;
      }
      lastResp = resp;
      
      
      const waitMs = retryDelayMs(resp, attempt);
      noteUpstream("retry", formatRetryNotice({ attempt, maxAttempts, waitMs, status: resp.status }));
      await sleep(waitMs);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new UpstreamError("请求已取消", 0, "protocol");
        }
        if (timeoutMs === undefined) {
          throw e;
        }
        throw new UpstreamError(`请求超时（${timeoutMs}ms）`, 0, "timeout");
      }
      if (attempt === maxAttempts - 1) {
        throw e;
      }
      
      
      
      const netWaitMs = jitteredDelay((RETRY_TRANSIENT_BACKOFF[attempt] ?? 7) * 1000);
      
      noteUpstream("retry", formatRetryNotice({ attempt, maxAttempts, waitMs: netWaitMs }));
      await sleep(netWaitMs);
    } finally {
      cleanup();
    }
  }
  throw new UpstreamError(
    `上游瞬时错误重试次数耗尽（${maxAttempts - 1} 次）`,
    lastResp?.status ?? 429,
    lastResp?.status === 429 ? "rate_limited" : "upstream",
  );
}

export interface ChatStreamResult {
  
  text: string;
  
  chunks: number;
  
  model: string;
  




  finishReason?: string;
  

  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    

    reasoning_tokens?: number;
    






    cache_read_in_prompt?: boolean;
  };
}






function openAICacheTokens(usage: unknown): { cache_read_tokens?: number; cache_creation_tokens?: number } {
  const u = usage as {
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | undefined;
  const dt = u?.prompt_tokens_details;
  const cached = typeof dt?.cached_tokens === "number" ? dt.cached_tokens : undefined;
  const deepseekHit = typeof u?.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : undefined;
  const read = typeof cached === "number" ? cached : deepseekHit;
  const write = typeof dt?.cache_write_tokens === "number" ? dt.cache_write_tokens : undefined;
  return { cache_read_tokens: read, cache_creation_tokens: write };
}



function openAIReasoningTokens(usage: unknown): number | undefined {
  const dt = (usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)?.completion_tokens_details;
  const nested = typeof dt?.reasoning_tokens === "number" ? dt.reasoning_tokens : undefined;
  const top = (usage as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
  const raw = typeof nested === "number" ? nested : top;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : undefined;
}


function normalizeUsage(usage: unknown): NonNullable<ChatStreamResult["usage"]> | undefined {
  if (!usage || typeof usage !== "object") { return undefined; }
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number; reasoning_tokens?: number };
  const cache = openAICacheTokens(usage);
  const out: NonNullable<ChatStreamResult["usage"]> = {};
  if (typeof u.prompt_tokens === "number") { out.prompt_tokens = u.prompt_tokens; }
  if (typeof u.completion_tokens === "number") { out.completion_tokens = u.completion_tokens; }
  if (typeof u.cache_read_tokens === "number") { out.cache_read_tokens = u.cache_read_tokens; }
  if (typeof u.cache_creation_tokens === "number") { out.cache_creation_tokens = u.cache_creation_tokens; }
  if (typeof u.reasoning_tokens === "number") { out.reasoning_tokens = u.reasoning_tokens; }
  if (cache.cache_read_tokens !== undefined) { out.cache_read_tokens = cache.cache_read_tokens; }
  if (cache.cache_creation_tokens !== undefined) { out.cache_creation_tokens = cache.cache_creation_tokens; }
  
  const rt = openAIReasoningTokens(usage);
  if (rt !== undefined) { out.reasoning_tokens = rt; }
  
  out.cache_read_in_prompt = true;
  return Object.keys(out).length ? out : undefined;
}


function mergeUsage(
  base: NonNullable<ChatStreamResult["usage"]> | undefined,
  u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): NonNullable<ChatStreamResult["usage"]> {
  const out = { ...(base ?? {}) } as NonNullable<ChatStreamResult["usage"]>;
  if (typeof u.input_tokens === "number") { out.prompt_tokens = u.input_tokens; }
  if (typeof u.output_tokens === "number") { out.completion_tokens = u.output_tokens; }
  if (typeof u.cache_read_input_tokens === "number") { out.cache_read_tokens = u.cache_read_input_tokens; }
  if (typeof u.cache_creation_input_tokens === "number") { out.cache_creation_tokens = u.cache_creation_input_tokens; }
  
  out.cache_read_in_prompt = false;
  return out;
}



interface NonStreamMessage {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  model?: string;
}




function extractNonStreamMessage(raw: string): NonStreamMessage | null {
  const s = raw.trim();
  if (!s) { return null; }
  const parseOne = (t: string): NonStreamMessage | null => {
    try {
      const obj = JSON.parse(t) as { choices?: Array<{ message?: NonStreamMessage }>; model?: unknown };
      const m = obj.choices?.[0]?.message;
      if (!m) { return null; }
      const out: NonStreamMessage = { ...m };
      if (typeof obj.model === "string") {
        out.model = obj.model;
      }
      return out;
    } catch {
      return null;
    }
  };
  const direct = parseOne(s);
  if (direct) { return direct; }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return parseOne(s.slice(start, end + 1));
  }
  return null;
}





function recoverAnswerFromReasoning(reasoning: string): string {
  const blocks = reasoning
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) { return ""; }
  let idx = blocks.length - 1;
  if (/^[\s*#\-_、，。!！?？:：~～…]*$/.test(blocks[idx]) && idx > 0) {
    idx -= 1;
  }
  return blocks[idx] ?? "";
}



function toToolCallDeltas(
  calls: Array<{ id?: string; function?: { name?: string; arguments?: string } }>,
): ChatToolCallDelta[] {
  return calls.map((c, i) => {
    const fnObj: { name?: string; arguments?: string } = {};
    if (c.function?.name !== undefined) { fnObj.name = c.function.name; }
    if (c.function?.arguments !== undefined) { fnObj.arguments = c.function.arguments; }
    const d: ChatToolCallDelta = { index: i, type: "function", function: fnObj };
    if (c.id) { d.id = c.id; }
    return d;
  });
}






interface ChunkFields {
  content?: unknown;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: unknown;
}


function chunkText(v: unknown): string {
  if (typeof v === "string") { return v; }
  if (Array.isArray(v)) {
    return v
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}


function pickChunkFields(choice: ChatCompletionChunk["choices"][number]): { d: ChunkFields | undefined; m: ChunkFields | undefined } {
  const d = choice.delta as ChunkFields | undefined;
  const c = choice as unknown as {
    message?: ChunkFields | undefined;
    messages?: ChunkFields[] | undefined;
  };
  return { d, m: c.message ?? c.messages?.slice(-1)[0] };
}







export const REASONING_PAYLOAD_KEYS = [
  "reasoning_effort",
  "chat_template_kwargs",
  "enable_thinking",
  "return_reasoning",
  "thinking",
] as const;


export function hasReasoningKeys(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") { return false; }
  const p = payload as Record<string, unknown>;
  return REASONING_PAYLOAD_KEYS.some((k) => k in p);
}


export function stripReasoningKeys<T>(payload: T): T {
  if (!payload || typeof payload !== "object") { return payload; }
  const out = { ...(payload as Record<string, unknown>) };
  for (const k of REASONING_PAYLOAD_KEYS) { delete out[k]; }
  return out as unknown as T;
}


















export function isUnrecognizedParamError(bodyText: string): boolean {
  const t = (bodyText ?? "").toLowerCase();
  if (!t) { return false; }
  const reject = /(unrecogni[sz]ed|unknown|unexpected|extra|invalid|unsupported|not supported|does not support|doesn't support|无法识别|不支持|无效|未知|不识别)/;
  if (!reject.test(t)) { return false; }
  return /(reasoning|thinking|effort|template|enable_thinking|思考|推理)/.test(t);
}


function anthropicBudget(effort: unknown): number {
  switch (String(effort ?? "").toLowerCase()) {
    case "minimal":
    case "low": return 1024;
    case "high": return 4096;
    case "xhigh": return 8192;
    case "max":
    case "maximal": return 16384;
    case "medium":
    default: return 2048;
  }
}







function toAnthropicThinking(p: Record<string, unknown>): Record<string, unknown> {
  const thinking = p.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking && typeof thinking === "object") { return { thinking }; }
  if (p.reasoning_effort) {
    return { thinking: { type: "enabled", budget_tokens: anthropicBudget(p.reasoning_effort) } };
  }
  return {};
}

export class UpstreamError extends Error {
  public readonly status: number;
  public readonly kind: "rate_limited" | "upstream" | "timeout" | "protocol";
  
  public readonly modelScope?: "model" | "provider";

  constructor(message: string, status: number, kind: "rate_limited" | "upstream" | "timeout" | "protocol", modelScope?: "model" | "provider") {
    super(message);
    this.status = status;
    this.kind = kind;
    this.modelScope = modelScope;
    this.name = "UpstreamError";
  }
}


export interface ChatClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  
  rateLimit?: RateLimitIdentity;
}

export class ChatClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  
  private rateLimit?: RateLimitIdentity;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rateLimit = opts.rateLimit;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  




  private endpoint(kind: "chat" | "embeddings"): string {
    return joinApiEndpoint(this.baseUrl, kind === "chat" ? "/v1/chat/completions" : "/v1/embeddings");
  }

  private async requestWithRetry(
    url: string,
    init: RequestInit,
    maxAttempts: number,
    externalSignal?: AbortSignal,
    


    timeoutMsOverride?: number,
  ): Promise<Response> {
    
    
    return fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url,
      init,
      maxAttempts,
      timeoutMs: Number.isFinite(timeoutMsOverride) && (timeoutMsOverride as number) > 0
        ? Math.max(this.timeoutMs, timeoutMsOverride as number)
        : this.timeoutMs,
      externalSignal,
      rateLimit: this.rateLimit,
    });
  }

  private async post(
    url: string,
    payload: unknown,
    maxAttempts: number,
    externalSignal?: AbortSignal,
    
    timeoutMsOverride?: number,
  ): Promise<Response> {
    const send = (body: unknown): Promise<Response> => this.requestWithRetry(
      url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      maxAttempts,
      externalSignal,
      timeoutMsOverride,
    );
    const resp = await send(payload);
    
    
    
    if (resp.status === 400 && hasReasoningKeys(payload)) {
      const originalText = await resp.text();
      if (!isUnrecognizedParamError(originalText)) {
        return new Response(originalText, { status: resp.status, headers: { "content-type": "application/json" } });
      }
      const retry = await send(stripReasoningKeys(payload));
      if (retry.status < 400) {
        console.warn("[llm] 上游拒绝思考参数（400），已自动剥除思考参数重试成功");
        return retry;
      }
      console.warn(`[llm] 剥除思考参数后仍失败（${retry.status}），保留原始错误`);
      return new Response(originalText, { status: resp.status, headers: { "content-type": "application/json" } });
    }
    return resp;
  }

  
  async chat(payload: ChatRequest): Promise<ChatResponse> {
    const resp = await this.post(this.endpoint("chat"), payload, RETRY_429_BACKOFF.length);
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(
        `上游错误 ${resp.status}: ${bodyText}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
        modelScopeFromUpstreamText(bodyText, resp.status),
      );
    }
    try {
      const data = await jsonWithTimeout<ChatResponse>(resp, this.timeoutMs);
      
      if (data.usage) {
        const cache = openAICacheTokens(data.usage);
        if (cache.cache_read_tokens !== undefined) { data.usage.cache_read_tokens = cache.cache_read_tokens; }
        if (cache.cache_creation_tokens !== undefined) { data.usage.cache_creation_tokens = cache.cache_creation_tokens; }
        
        data.usage.cache_read_in_prompt = true;
      }
      return data;
    } catch (e) {
      if (e instanceof UpstreamError) { throw e; }
      throw new UpstreamError("上游响应非 JSON", resp.status, "protocol");
    }
  }

  





  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    externalSignal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onToolDelta?: (toolCalls: ChatToolCallDelta[]) => void,
  ): Promise<ChatStreamResult> {
    


    const firstBudgetMs = firstByteBudgetMs(roughInputTokens(payload));
    if (firstBudgetMs > IDLE_STREAM_MS) {
      noteUpstream("prefill", formatPrefillNotice(roughInputTokens(payload), firstBudgetMs));
    }
    const resp = await this.post(
      this.endpoint("chat"),
      
      
      { ...payload, stream: true, stream_options: { include_usage: true } },
      RETRY_429_BACKOFF.length,
      externalSignal,
      
      firstBudgetMs,
    );
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(
        `上游错误 ${resp.status}: ${bodyText}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
        modelScopeFromUpstreamText(bodyText, resp.status),
      );
    }
    if (!resp.body) {
      throw new UpstreamError("上游无响应体", resp.status, "protocol");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunks = 0;
    let text = "";
    let model = "";
    let done = false;
    let finishReason: string | undefined;
    
    let sawToolDelta = false;
    

    let nonDataLines = "";
    
    let reasoningAcc = "";
    
    let streamUsage: NonNullable<ChatStreamResult["usage"]> | undefined;

    
    
    
    let cancelRead: (() => void) | null = null;
    const attachAbort = !!externalSignal && !externalSignal.aborted;
    const onExternalAbort = () => {
      cancelRead?.();
      void reader.cancel("aborted").catch(() => {});
    };
    if (attachAbort) {
      externalSignal!.addEventListener("abort", onExternalAbort, { once: true });
    }

    




    let firstRead = true;
    try {
      while (!done) {
        if (externalSignal?.aborted) {
          throw new UpstreamError("流式已取消", 0, "protocol");
        }
        let reject: (e: Error) => void = () => {};
        type ReadResult = Awaited<ReturnType<typeof reader.read>>;
        const p: Promise<ReadResult> = externalSignal
          ? new Promise((resolve, rej) => { reject = rej; reader.read().then(resolve, rej); })
          : reader.read();
        if (externalSignal) { cancelRead = () => { reject(new UpstreamError("流式已取消", 0, "protocol")); }; }
        let outcome: ReadResult;
        try {
          
          
          
          
          
          outcome = await raceIdleTimeout(p, firstRead ? firstBudgetMs : IDLE_STREAM_MS);
          firstRead = false;
          cancelRead = null;
        } catch (e) {
          if (externalSignal?.aborted || (e instanceof Error && e.name === "AbortError")) {
            throw new UpstreamError("流式已取消", 0, "protocol");
          }
          if (e instanceof UpstreamError && e.kind === "timeout") {
            
            throw e;
          }
          throw e;
        }
        if (outcome.done) {
          break;
        }
        buffer += decoder.decode(outcome.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) {
            
            nonDataLines += line + "\n";
            continue;
          }
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            done = true;
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; 
          }
          const chunk = parsed as ChatCompletionChunk;
          
          const chunkUsage = (chunk as unknown as { usage?: unknown }).usage;
          if (chunkUsage && typeof chunkUsage === "object") {
            streamUsage = normalizeUsage(chunkUsage) ?? streamUsage;
          }
          if (!chunk.choices || chunk.choices.length === 0) {
            continue;
          }
          if (chunk.model && !model) {
            model = chunk.model;
          }
          
          if (chunk.choices[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
          const { d, m } = pickChunkFields(chunk.choices[0]);
          
          
          const content = chunkText(d?.content ?? m?.content);
          if (content) {
            chunks++;
            text += content;
            onDelta(content);
          }
          
          const reasoning =
            d?.reasoning_content ?? d?.reasoning ?? m?.reasoning_content ?? m?.reasoning ?? "";
          if (reasoning) {
            reasoningAcc += reasoning;
            if (onReasoning) {
              onReasoning(reasoning);
            }
          }
          
          const deltaCalls = d?.tool_calls as ChatToolCallDelta[] | undefined;
          const msgCalls = m?.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }> | undefined;
          if (deltaCalls && deltaCalls.length > 0 && onToolDelta) {
            sawToolDelta = true;
            onToolDelta(deltaCalls);
          } else if (msgCalls && msgCalls.length > 0 && onToolDelta) {
            sawToolDelta = true;
            onToolDelta(toToolCallDeltas(msgCalls));
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new UpstreamError("流式已取消", 0, "protocol");
        }
        throw new UpstreamError("流式中断（上游超时）", 0, "timeout");
      }
      throw e;
    } finally {
      if (attachAbort && externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
      cancelRead = null;
      
      
      
      
      
      try { void reader.cancel().catch(() => {  }); } catch {  }
    }

    
    
    
    
    const receivedStreamEvent = model !== "" || sawToolDelta;
    const residue = nonDataLines + buffer;
    if (text === "" && !receivedStreamEvent) {
      if (residue.trim() !== "") {
        const recovered = extractNonStreamMessage(residue);
        if (!recovered) {
          throw new UpstreamError(
            `上游未按流式格式返回且响应无法解析为消息：${residue.trim().slice(0, 200)}`,
            resp.status,
            "protocol",
          );
        }
        if (typeof recovered.model === "string" && recovered.model && !model) {
          model = recovered.model;
        }
        const recoveredText = recovered.content ?? "";
        if (recoveredText) {
          text += recoveredText;
          chunks++;
          onDelta(recoveredText);
        }
        const reasoning = recovered.reasoning_content ?? "";
        if (reasoning) {
          reasoningAcc += reasoning;
          if (onReasoning) {
            onReasoning(reasoning);
          }
        }
        const recoveredCalls = recovered.tool_calls;
        if (recoveredCalls && recoveredCalls.length > 0 && onToolDelta) {
          sawToolDelta = true;
          onToolDelta(toToolCallDeltas(recoveredCalls));
        }
      } else {
        throw new UpstreamError("上游返回空响应（无流式 chunk 且无非流式内容）", resp.status, "protocol");
      }
    }

    
    
    
    
    
    
    if (text === "" && !sawToolDelta && reasoningAcc.trim() !== "") {
      const recovered = recoverAnswerFromReasoning(reasoningAcc);
      if (recovered) {
        text += recovered;
        chunks++;
        onDelta(recovered);
      }
    }

    return { text, chunks, model, usage: streamUsage, finishReason };
  }

  
  async embeddings(input: string | string[]): Promise<number[][]> {
    const resp = await this.post(
      this.endpoint("embeddings"),
      { model: "bge-m3", input },
      RETRY_429_BACKOFF.length,
    );
    if (resp.status >= 400) {
      throw new UpstreamError(
        `上游错误 ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
      );
    }
    const data = await jsonWithTimeout<{ data?: Array<{ embedding?: number[] }> }>(resp, this.timeoutMs);
    return (data.data ?? []).map((d) => d.embedding ?? []);
  }
}












function toAnthropicImageBlock(imageUrl: unknown): { type: string; source: Record<string, unknown> } {
  const url = (imageUrl as { url?: unknown } | undefined)?.url;
  if (typeof url === "string" && url.startsWith("data:image/")) {
    const comma = url.indexOf(",");
    if (comma > 0) {
      const mediaType = url.slice("data:".length, url.indexOf(";"));
      const data = url.slice(comma + 1);
      return { type: "image", source: { type: "base64", media_type: mediaType, data } };
    }
    return { type: "image", source: { type: "base64", media_type: "image/png", data: url.slice(url.indexOf(",") + 1) } };
  }
  return { type: "image", source: { type: "url", url: String(url ?? "") } };
}

export class AnthropicClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  
  private rateLimit?: RateLimitIdentity;

  constructor(opts: { baseUrl: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch; rateLimit?: RateLimitIdentity }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rateLimit = opts.rateLimit;
  }

  private endpoint(): string {
    
    return joinApiEndpoint(this.baseUrl, "/v1/messages");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  


  private async post(url: string, payload: unknown, signal?: AbortSignal, maxAttempts?: number): Promise<Response> {
    const send = (body: unknown): Promise<Response> => fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url,
      init: { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      maxAttempts: maxAttempts ?? RETRY_429_BACKOFF.length,
      timeoutMs: this.timeoutMs,
      externalSignal: signal,
      rateLimit: this.rateLimit,
    });
    const resp = await send(payload);
    
    
    if (resp.status === 400 && hasReasoningKeys(payload)) {
      const originalText = await resp.text();
      if (!isUnrecognizedParamError(originalText)) {
        return new Response(originalText, { status: resp.status, headers: { "content-type": "application/json" } });
      }
      const retry = await send(stripReasoningKeys(payload));
      if (retry.status < 400) {
        console.warn("[llm:anthropic] 上游拒绝思考参数（400），已自动剥除思考参数重试成功");
        return retry;
      }
      console.warn(`[llm:anthropic] 剥除思考参数后仍失败（${retry.status}），保留原始错误`);
      return new Response(originalText, { status: resp.status, headers: { "content-type": "application/json" } });
    }
    return resp;
  }

  
  async chat(payload: ChatRequest): Promise<ChatResponse> {
    const resp = await this.post(this.endpoint(), this.toAnthropicPayload(payload));
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(
        `Anthropic 上游错误 ${resp.status}: ${bodyText}`,
        resp.status,
        resp.status === 429 ? "rate_limited" : "upstream",
        modelScopeFromUpstreamText(bodyText, resp.status),
      );
    }
    const data = await jsonWithTimeout<AnthropicResponse>(resp, this.timeoutMs);
    const content = data.content?.find((b) => b.type === "text")?.text ?? "";
    return {
      id: data.id,
      object: "chat.completion" as const,
      model: data.model,
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, message: { role: "assistant" as const, content }, finish_reason: data.stop_reason ?? "stop" }],
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens ?? 0,
        completion_tokens: data.usage.output_tokens ?? 0,
        ...(typeof data.usage.cache_read_input_tokens === "number" ? { cache_read_tokens: data.usage.cache_read_input_tokens } : {}),
        ...(typeof data.usage.cache_creation_input_tokens === "number" ? { cache_creation_tokens: data.usage.cache_creation_input_tokens } : {}),
        
        cache_read_in_prompt: false,
      } : undefined,
    };
  }

  
  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    _onReasoning?: (reasoning: string) => void,
  ): Promise<ChatStreamResult> {
    
    const prefillBudget = firstByteBudgetMs(roughInputTokens(payload));
    if (prefillBudget > IDLE_STREAM_MS) {
      noteUpstream("prefill", formatPrefillNotice(roughInputTokens(payload), prefillBudget));
    }
    const resp = await this.post(this.endpoint(), { ...this.toAnthropicPayload(payload), stream: true }, signal);
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(`Anthropic 上游错误 ${resp.status}: ${bodyText}`, resp.status, resp.status === 429 ? "rate_limited" : "upstream", modelScopeFromUpstreamText(bodyText, resp.status));
    }
    if (!resp.body) { throw new UpstreamError("上游无响应体", resp.status, "protocol"); }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunks = 0;
    let text = "";
    let model = "";
    let done = false;
    
    let nonDataLines = "";
    
    let streamUsage: NonNullable<ChatStreamResult["usage"]> | undefined;

    
    
    
    let cancelRead: (() => void) | null = null;
    const attachAbort = !!signal && !signal.aborted;
    const onExternalAbort = () => {
      cancelRead?.();
      void reader.cancel("aborted").catch(() => {});
    };
    if (attachAbort) {
      signal!.addEventListener("abort", onExternalAbort, { once: true });
    }

    
    const firstBudgetMs = firstByteBudgetMs(roughInputTokens(payload));
    let firstRead = true;
    try {
      while (!done) {
        if (signal?.aborted) {
          throw new UpstreamError("流式已取消", 0, "protocol");
        }
        let reject: (e: Error) => void = () => {};
        type ReadResult = Awaited<ReturnType<typeof reader.read>>;
        const p: Promise<ReadResult> = signal
          ? new Promise((resolve, rej) => { reject = rej; reader.read().then(resolve, rej); })
          : reader.read();
        if (signal) { cancelRead = () => { reject(new UpstreamError("流式已取消", 0, "protocol")); }; }
        let outcome: ReadResult;
        try {
          
          
          outcome = await raceIdleTimeout(p, firstRead ? firstBudgetMs : IDLE_STREAM_MS);
          firstRead = false;
          cancelRead = null;
        } catch (e) {
          if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
            throw new UpstreamError("流式已取消", 0, "protocol");
          }
          if (e instanceof UpstreamError && e.kind === "timeout") {
            throw e;
          }
          throw e;
        }
        if (outcome.done) break;
        buffer += decoder.decode(outcome.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) { nonDataLines += line + "\n"; continue; }
          const data = line.slice(5).trim();
          if (!data) continue;
          let evt: AnthropicStreamEvent;
          try { evt = JSON.parse(data) as AnthropicStreamEvent; } catch { continue; }
          if (evt.type === "message_start") {
            if (evt.message?.model) { model = evt.message.model; }
            
            if (evt.message?.usage) { streamUsage = mergeUsage(streamUsage, evt.message.usage); }
          }
          if (evt.type === "content_block_delta" && evt.delta?.text) {
            chunks++;
            text += evt.delta.text;
            onDelta(evt.delta.text);
          }
          if (evt.type === "message_delta") {
            
            if (evt.usage) { streamUsage = mergeUsage(streamUsage, evt.usage); }
          }
          if (evt.type === "message_stop") { done = true; }
        }
      }
    } finally {
      if (attachAbort && signal) {
        signal.removeEventListener("abort", onExternalAbort);
      }
      cancelRead = null;
      try { reader.cancel().catch(() => {}); } catch {  }
    }

    
    
    
    const residue = nonDataLines + buffer;
    if (text === "" && model === "") {
      if (residue.trim() !== "") {
        const s = residue.trim();
        const start = s.indexOf("{");
        const end = s.lastIndexOf("}");
        const body = start >= 0 && end > start ? s.slice(start, end + 1) : s;
        try {
          const j = JSON.parse(body) as AnthropicResponse;
          const content = j.content?.find((b) => b.type === "text")?.text ?? "";
          if (j.model && !model) { model = j.model; }
          if (j.usage) { streamUsage = mergeUsage(streamUsage, j.usage); }
          if (content) {
            text += content;
            chunks++;
            onDelta(content);
          } else {
            throw new UpstreamError(
              `Anthropic 上游返回非流式响应但无正文：${s.slice(0, 200)}`,
              resp.status,
              "upstream",
            );
          }
        } catch (e) {
          if (e instanceof UpstreamError) { throw e; }
          throw new UpstreamError(
            `Anthropic 上游未按流式格式返回且响应无法解析：${s.slice(0, 200)}`,
            resp.status,
            "protocol",
          );
        }
      } else {
        throw new UpstreamError("Anthropic 上游返回空响应（无流式事件且无内容）", resp.status, "upstream");
      }
    }

    return { text, chunks, model, usage: streamUsage };
  }

  
  private toAnthropicPayload(payload: ChatRequest): Record<string, unknown> {
    const p = payload as any;
    
    
    const messages = payload.messages ?? [];
    const leadingSystem = messages[0]?.role === "system" && typeof messages[0].content === "string" ? messages[0].content : undefined;
    const systemText = (p.system as string | undefined) ?? leadingSystem;
    
    
    const system = systemText ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }] : undefined;
    const restMessages = leadingSystem !== undefined ? messages.slice(1) : messages;
    const toolsRaw = (p.tools as Array<Record<string, unknown>> | undefined)
      ?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters ?? t.input_schema }))
       ?.filter((t) => Boolean(t && typeof (t as any).name === "string"));
    const msgs = restMessages.map((m) => {
      const contentBlocks: unknown[] = m.content
        ? (typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content as unknown[]).map((b) => {
              if ((b as any).type === "image_url") {
                
                return toAnthropicImageBlock((b as any).image_url);
              }
              return b;
            }))
        : [];
      return {
        role: m.role === "user" ? "user" : "assistant",
        content: contentBlocks,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(p.tool_responses ? { content: p.tool_responses } : {}),
      };
    });
    
    
    
    let toolsArr: Array<Record<string, unknown>> | undefined;
    if (toolsRaw && toolsRaw.length > 0) {
      toolsArr = toolsRaw.map((t, i) => i === toolsRaw.length - 1
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t);
    }
    const msgsWithCache = msgs.map((m, i) => {
      
      if (i === 0 && m.role === "user" && Array.isArray(m.content)) {
        const cs = m.content as Array<Record<string, unknown>>;
        const content = cs.map((b, j) => (j === cs.length - 1 && b.type === "text")
          ? { ...b, cache_control: { type: "ephemeral" } }
          : b);
        return { ...m, content };
      }
      return m;
    });
    return {
      model: String(p.model ?? ""),
      max_tokens: Number(p.max_tokens ?? 4096),
      messages: msgsWithCache,
      ...(system ? { system } : {}),
      ...(toolsArr?.length ? { tools: toolsArr } : {}),
      
      
      ...(toAnthropicThinking(p)),
    };
  }
}

interface AnthropicResponse {
  id: string;
  type: string;
  model: string;
  content: Array<{ type: string; text?: string; id?: string }>;
  stop_reason: string | null;
  usage: AnthropicUsage;
}


interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicStreamEvent {
  type: string;
  message?: { model?: string; usage?: AnthropicUsage };
  delta?: { text?: string };
  usage?: AnthropicUsage;
}






async function readSSEStream(
  resp: Response,
  externalSignal: AbortSignal | undefined,
  


  firstBudgetMsRaw: number | undefined,
  onData: (data: unknown) => void,
): Promise<{ receivedData: boolean; nonData: string }> {
  if (!resp.body) { throw new UpstreamError("上游无响应体", resp.status, "protocol"); }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nonData = "";
  let receivedData = false;
  let done = false;
  let cancelRead: (() => void) | null = null;
  const firstBudgetMs = Number.isFinite(firstBudgetMsRaw) && (firstBudgetMsRaw as number) > 0 ? (firstBudgetMsRaw as number) : IDLE_STREAM_MS;
  let firstRead = true;
  const onExternalAbort = () => { cancelRead?.(); void reader.cancel("aborted").catch(() => {}); };
  const attachAbort = !!externalSignal && !externalSignal.aborted;
  if (attachAbort) { externalSignal!.addEventListener("abort", onExternalAbort, { once: true }); }
  try {
    while (!done) {
      if (externalSignal?.aborted) { throw new UpstreamError("流式已取消", 0, "protocol"); }
      let reject: (e: Error) => void = () => {};
      type ReadResult = Awaited<ReturnType<typeof reader.read>>;
      const p: Promise<ReadResult> = externalSignal
        ? new Promise((resolve, rej) => { reject = rej; reader.read().then(resolve, rej); })
        : reader.read();
      if (externalSignal) { cancelRead = () => { reject(new UpstreamError("流式已取消", 0, "protocol")); }; }
      let outcome: ReadResult;
      try {
        
        outcome = await raceIdleTimeout(p, firstRead ? firstBudgetMs : IDLE_STREAM_MS);
        firstRead = false;
        cancelRead = null;
      } catch (e) {
        if (externalSignal?.aborted || (e instanceof Error && e.name === "AbortError")) {
          throw new UpstreamError("流式已取消", 0, "protocol");
        }
        if (e instanceof UpstreamError && e.kind === "timeout") { throw e; }
        throw e;
      }
      if (outcome.done) { break; }
      buffer += decoder.decode(outcome.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) { nonData += line + "\n"; continue; }
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }
        receivedData = true;
        onData(parsed);
      }
    }
  } finally {
    if (attachAbort && externalSignal) { externalSignal.removeEventListener("abort", onExternalAbort); }
    cancelRead = null;
  }
  return { receivedData, nonData: nonData + buffer };
}








export class ResponsesClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  
  private rateLimit?: RateLimitIdentity;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rateLimit = opts.rateLimit;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) { h.Authorization = `Bearer ${this.apiKey}`; }
    return h;
  }

  private endpoint(): string {
    
    return joinApiEndpoint(this.baseUrl, "/v1/responses");
  }

  
  private toResponsesPayload(payload: ChatRequest): Record<string, unknown> {
    const p = payload as unknown as Record<string, unknown>;
    const systemTexts: string[] = [];
    const input: Array<Record<string, unknown>> = [];
    for (const m of payload.messages) {
      if (m.role === "system") {
        if (m.content) { systemTexts.push(m.content); }
        continue;
      }
      if (m.role === "tool") {
        
        input.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: m.content ?? "" });
        continue;
      }
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        
        for (const tc of m.tool_calls) {
          input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
        }
        if (m.content) { input.push({ role: "assistant", content: m.content }); }
        continue;
      }
      input.push({ role: m.role, content: m.content ?? "" });
    }
    const out: Record<string, unknown> = { model: payload.model ?? "", input };
    if (systemTexts.length > 0) { out.instructions = systemTexts.join("\n"); }
    if (payload.max_tokens) { out.max_output_tokens = payload.max_tokens; }
    
    const effort = (p.reasoning_effort ?? (p as { reasoning?: { effort?: string } }).reasoning?.effort) as string | undefined;
    if (effort) { out.reasoning = { effort }; }
    if (payload.tools && payload.tools.length > 0) {
      out.tools = payload.tools.map((t) => ({
        type: "function",
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
      }));
    }
    return out;
  }

  
  private toChatResponse(data: Record<string, unknown>, model: string): ChatResponse {
    const items = Array.isArray(data.output) ? data.output as Array<Record<string, unknown>> : [];
    let text = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    for (const item of items) {
      if (!item || typeof item !== "object") { continue; }
      if (item.type === "message" && item.role === "assistant") {
        for (const c of (item.content as Array<Record<string, unknown>>) ?? []) {
          if (c && c.type === "output_text" && typeof c.text === "string") { text += c.text; }
        }
      }
      
      if (item.type === "function_call") {
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ""),
          type: "function",
          function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") },
        });
      }
      
      if (item.type === "reasoning") {
        const s = item.summary;
        if (typeof s === "string") { reasoning += s; }
        else if (Array.isArray(s)) { reasoning += s.map((x) => (x as { text?: string })?.text ?? "").join(""); }
        else if (typeof item.content === "string") { reasoning += item.content; }
      }
    }
    const u = data.usage as Record<string, unknown> | undefined;
    return {
      id: String(data.id ?? ""),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: "stop",
      }],
      usage: u ? {
        prompt_tokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
        completion_tokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
        total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
      } : undefined,
    };
  }

  async chat(payload: ChatRequest): Promise<ChatResponse> {
    const resp = await fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url: this.endpoint(),
      init: { method: "POST", headers: this.headers(), body: JSON.stringify(this.toResponsesPayload(payload)) },
      maxAttempts: RETRY_429_BACKOFF.length,
      timeoutMs: this.timeoutMs,
      rateLimit: this.rateLimit,
    });
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(`上游错误 ${resp.status}: ${bodyText}`, resp.status, resp.status === 429 ? "rate_limited" : "upstream", modelScopeFromUpstreamText(bodyText, resp.status));
    }
    const data = await jsonWithTimeout<Record<string, unknown>>(resp, this.timeoutMs);
    return this.toChatResponse(data, payload.model ?? "");
  }

  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    externalSignal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onToolDelta?: (toolCalls: ChatToolCallDelta[]) => void,
  ): Promise<ChatStreamResult> {
    const resp = await fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url: this.endpoint(),
      init: { method: "POST", headers: this.headers(), body: JSON.stringify({ ...this.toResponsesPayload(payload), stream: true }) },
      maxAttempts: RETRY_429_BACKOFF.length,
      timeoutMs: this.timeoutMs,
      externalSignal,
      rateLimit: this.rateLimit,
    });
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(`上游错误 ${resp.status}: ${bodyText}`, resp.status, resp.status === 429 ? "rate_limited" : "upstream", modelScopeFromUpstreamText(bodyText, resp.status));
    }
    let text = "";
    let chunks = 0;
    let model = payload.model ?? "";
    let reasoningAcc = "";
    let streamUsage: NonNullable<ChatStreamResult["usage"]> | undefined;
    
    const itemNames = new Map<string, string>();

    const { receivedData, nonData } = await readSSEStream(resp, externalSignal, firstByteBudgetMs(roughInputTokens(payload)), (data) => {
      const ev = data as { type?: string; delta?: string; item?: Record<string, unknown>; item_id?: string; output_index?: number; response?: Record<string, unknown> };
      const t = ev.type;
      
      if (t === "response.output_item.added" && ev.item?.type === "function_call") {
        if (typeof ev.item.name === "string") { itemNames.set(String(ev.item.id ?? ""), ev.item.name); }
      }
      
      if (t === "response.output_text.delta" && typeof ev.delta === "string") {
        chunks++; text += ev.delta; onDelta(ev.delta);
      }
      
      if ((t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") && typeof ev.delta === "string") {
        reasoningAcc += ev.delta; onReasoning?.(ev.delta);
      }
      
      if (t === "response.function_call_arguments.delta" && typeof ev.delta === "string") {
        const fn: { name?: string; arguments?: string } = { arguments: ev.delta };
        const nm = itemNames.get(String(ev.item_id ?? ""));
        if (nm) { fn.name = nm; }
        onToolDelta?.([{ index: typeof ev.output_index === "number" ? ev.output_index : 0, id: String(ev.item_id ?? ""), type: "function", function: fn }]);
      }
      
      if (t === "response.completed" && ev.response) {
        const u = ev.response.usage as Record<string, unknown> | undefined;
        if (u) {
          streamUsage = {
            prompt_tokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
            completion_tokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
          };
        }
        if (typeof ev.response.model === "string" && ev.response.model) { model = ev.response.model; }
      }
    });

    
    if (text === "" && !receivedData && nonData.trim() !== "") {
      try {
        const full = this.toChatResponse(JSON.parse(nonData.trim()) as Record<string, unknown>, model);
        const msg = full.choices[0]?.message;
        if (msg?.content) { text = msg.content; chunks++; onDelta(msg.content); }
        if (msg?.reasoning_content) { reasoningAcc = msg.reasoning_content; onReasoning?.(msg.reasoning_content); }
        if (msg?.tool_calls && msg.tool_calls.length > 0) { onToolDelta?.(toToolCallDeltas(msg.tool_calls)); }
        if (full.usage) { streamUsage = full.usage; }
      } catch {  }
    }

    return { text, chunks, model, usage: streamUsage };
  }
}






export class GoogleClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  
  private rateLimit?: RateLimitIdentity;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.rateLimit = opts.rateLimit;
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "x-goog-api-key": this.apiKey };
  }

  private endpoint(model: string): string {
    
    if (this.baseUrl.replace(/\/+$/, "").endsWith(":generateContent")) { return this.baseUrl.replace(/\/+$/, ""); }
    
    return joinApiEndpoint(this.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
  }

  
  private static thinkingConfig(effortRaw: unknown): Record<string, unknown> | undefined {
    const effort = String(effortRaw ?? "").toLowerCase();
    const levelMap: Record<string, string> = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" };
    if (levelMap[effort]) { return { thinkingLevel: levelMap[effort] }; }
    const budgetMap: Record<string, number> = { minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 24576, max: 32768 };
    if (budgetMap[effort]) { return { thinkingBudget: budgetMap[effort] }; }
    return undefined;
  }

  
  private toGooglePayload(payload: ChatRequest): Record<string, unknown> {
    const p = payload as unknown as Record<string, unknown>;
    const contents: Array<Record<string, unknown>> = [];
    let systemText = "";
    for (const m of payload.messages) {
      if (m.role === "system") { if (m.content) { systemText += m.content + "\n"; } continue; }
      
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        if (m.content) { parts.push({ text: m.content }); }
        for (const tc of m.tool_calls) {
          let args: unknown = {};
          try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = { _raw: tc.function.arguments }; }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
        contents.push({ role: "model", parts });
        continue;
      }
      
      if (m.role === "tool") {
        contents.push({ role: "user", parts: [{ functionResponse: { name: m.name ?? m.tool_call_id ?? "", response: { result: m.content ?? "" } } }] });
        continue;
      }
      
      const role = m.role === "assistant" ? "model" : m.role;
      contents.push({ role, parts: [{ text: m.content ?? "" }] });
    }
    const genConfig: Record<string, unknown> = {};
    if (payload.max_tokens) { genConfig.maxOutputTokens = payload.max_tokens; }
    const think = GoogleClient.thinkingConfig(p.reasoning_effort);
    if (think) { genConfig.thinkingConfig = think; }
    const out: Record<string, unknown> = { contents };
    if (systemText.trim()) { out.systemInstruction = { parts: [{ text: systemText.trim() }] }; }
    if (Object.keys(genConfig).length > 0) { out.generationConfig = genConfig; }
    if (payload.tools && payload.tools.length > 0) {
      out.tools = payload.tools.map((t) => ({ functionDeclarations: [{ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), ...(t.function.parameters ? { parameters: t.function.parameters } : {}) }] }));
    }
    return out;
  }

  
  private toChatResponse(data: Record<string, unknown>, model: string): ChatResponse {
    const candidates = Array.isArray(data.candidates) ? data.candidates as Array<Record<string, unknown>> : [];
    const first = candidates[0];
    const parts = Array.isArray((first?.content as Record<string, unknown>)?.parts)
      ? (first.content as { parts: Array<Record<string, unknown>> }).parts : [];
    let text = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    for (const part of parts) {
      if (!part) { continue; }
      if (typeof part.text === "string") {
        
        if (part.thought === true) { reasoning += part.text; } else { text += part.text; }
      }
      
      if (part.functionCall && typeof part.functionCall === "object") {
        const fc = part.functionCall as { name?: string; args?: unknown };
        toolCalls.push({
          id: `fc-${toolCalls.length}`,
          type: "function",
          function: { name: String(fc.name ?? ""), arguments: JSON.stringify(fc.args ?? {}) },
        });
      }
    }
    const u = data.usageMetadata as Record<string, unknown> | undefined;
    return {
      id: String(model),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: typeof first?.finishReason === "string" ? first.finishReason : "stop",
      }],
      usage: u ? {
        prompt_tokens: typeof u.promptTokenCount === "number" ? u.promptTokenCount : undefined,
        completion_tokens: typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : undefined,
        total_tokens: typeof u.totalTokenCount === "number" ? u.totalTokenCount : undefined,
      } : undefined,
    };
  }

  async chat(payload: ChatRequest): Promise<ChatResponse> {
    const model = payload.model ?? "";
    const resp = await fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url: this.endpoint(model),
      init: { method: "POST", headers: this.headers(), body: JSON.stringify(this.toGooglePayload(payload)) },
      maxAttempts: RETRY_429_BACKOFF.length,
      timeoutMs: this.timeoutMs,
      rateLimit: this.rateLimit,
    });
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(`上游错误 ${resp.status}: ${bodyText}`, resp.status, resp.status === 429 ? "rate_limited" : "upstream", modelScopeFromUpstreamText(bodyText, resp.status));
    }
    const data = await jsonWithTimeout<Record<string, unknown>>(resp, this.timeoutMs);
    return this.toChatResponse(data, model);
  }

  private streamEndpoint(model: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    if (base.endsWith(":streamGenerateContent")) { return base; }
    const suffix = `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    
    
    
    return joinApiEndpoint(base, `/v1beta/${suffix}`);
  }

  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    externalSignal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onToolDelta?: (toolCalls: ChatToolCallDelta[]) => void,
  ): Promise<ChatStreamResult> {
    const model = payload.model ?? "";
    const resp = await fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url: this.streamEndpoint(model),
      init: { method: "POST", headers: this.headers(), body: JSON.stringify(this.toGooglePayload(payload)) },
      maxAttempts: RETRY_429_BACKOFF.length,
      timeoutMs: this.timeoutMs,
      externalSignal,
      rateLimit: this.rateLimit,
    });
    if (resp.status >= 400) {
      const bodyText = (await resp.text()).slice(0, 200);
      throw new UpstreamError(`上游错误 ${resp.status}: ${bodyText}`, resp.status, resp.status === 429 ? "rate_limited" : "upstream", modelScopeFromUpstreamText(bodyText, resp.status));
    }
    let text = "";
    let chunks = 0;
    let reasoningAcc = "";
    let streamUsage: NonNullable<ChatStreamResult["usage"]> | undefined;
    let toolIndex = 0;

    const { receivedData, nonData } = await readSSEStream(resp, externalSignal, firstByteBudgetMs(roughInputTokens(payload)), (data) => {
      const ev = data as { candidates?: Array<Record<string, unknown>>; usageMetadata?: Record<string, unknown> };
      const cand = ev.candidates?.[0];
      const parts = Array.isArray((cand?.content as { parts?: Array<Record<string, unknown>> })?.parts)
        ? (cand!.content as { parts: Array<Record<string, unknown>> }).parts : [];
      for (const part of parts) {
        if (!part) { continue; }
        if (typeof part.text === "string") {
          if (part.thought === true) { reasoningAcc += part.text; onReasoning?.(part.text); }
          else { chunks++; text += part.text; onDelta(part.text); }
        }
        if (part.functionCall && typeof part.functionCall === "object") {
          const fc = part.functionCall as { name?: string; args?: unknown };
          onToolDelta?.([{ index: toolIndex++, id: `fc-${toolIndex}`, type: "function", function: { name: String(fc.name ?? ""), arguments: JSON.stringify(fc.args ?? {}) } }]);
        }
      }
      if (ev.usageMetadata) {
        const u = ev.usageMetadata;
        streamUsage = {
          prompt_tokens: typeof u.promptTokenCount === "number" ? u.promptTokenCount : undefined,
          completion_tokens: typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : undefined,
        };
      }
    });

    
    if (text === "" && !receivedData && nonData.trim() !== "") {
      try {
        const full = this.toChatResponse(JSON.parse(nonData.trim()) as Record<string, unknown>, model);
        const msg = full.choices[0]?.message;
        if (msg?.content) { text = msg.content; chunks++; onDelta(msg.content); }
        if (msg?.reasoning_content) { reasoningAcc = msg.reasoning_content; onReasoning?.(msg.reasoning_content); }
        if (msg?.tool_calls && msg.tool_calls.length > 0) { onToolDelta?.(toToolCallDeltas(msg.tool_calls)); }
        if (full.usage) { streamUsage = full.usage; }
      } catch {  }
    }

    return { text, chunks, model, usage: streamUsage };
  }
}