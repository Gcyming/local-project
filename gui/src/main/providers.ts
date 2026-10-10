





import { decrypt, encrypt, PROJECT_ROOT } from "../../../core-ts/src/encryption.js";
/* A-1195（交接欠账 B6）：供应商探测请求也要报同一身份 —— 与模型请求指纹一致，
 * 避免「模型侧叫 slime、探测侧匿名」的自相矛盾（风控视角的身份存疑信号）。 */
import { identityHeaders } from "../../../core-ts/src/http-identity.js";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Agent as HttpKeepAliveAgent } from "node:http";
import { Agent as HttpsKeepAliveAgent } from "node:https";
import {
  inferModelCapabilities, resolveModelPriceTier, isAggregatorGateway, isLocalEndpoint, sortEfforts,
  resolveEffectivePricing,
  normalizePriceTiers, type ModelPriceTiers, type ModelPriceTier, type PriceCurrency,
} from "../../../shared/gen/model-capabilities.js";
import { probe, type ProbeObservation, type ProbeResult } from "../../../core-ts/src/probe.js";

import type { PriceResolver, UsagePrice } from "../../../core-ts/src/services/usage.js";




import { LOCAL_MODELS_KEY, localModelSpecs, normalizeThinkingMode, type LocalModelSpec } from "../../../core-ts/src/local_models.js";
export type { LocalModelSpec };


export type ApiFormat = "openai" | "anthropic" | "responses" | "google" | "auto";

export interface ModelSpec {
  id: string;
  
  context_window?: number;
  
  max_output?: number;
  
  vision?: boolean;
  
  thinking?: boolean;
  
  thinking_efforts?: string[];
  
  selected?: boolean;
  
  price_in_usd?: number;
  
  price_out_usd?: number;
  
  price_cache_read_usd?: number;
  
  price_cache_write_usd?: number;
  
  pricing_tiered?: boolean;
  
  pricing_formula?: string;
  
  pricing_mode?: string;
  





  pricing_time_tiers_candidate?: ModelPriceTiers;
  
  pricing_context_tiers?: UpstreamContextTier[];
  
  pricing_per_request?: { request?: number; image?: number; webSearch?: number; internalReasoning?: number; audio?: number };
  







  price_source?: "upstream" | "table" | "manual";
  







  price_tiers?: ModelPriceTiers;
  








  price_currency?: PriceCurrency;
  



  api_format?: ApiFormat;
  












  rpm?: number;
}

export interface ProviderRecord {
  api_base: string;
  api_key: string;
  
  model?: string;
  
  api_format?: ApiFormat;
  
  models?: ModelSpec[];
  



  rpm?: number;
  [key: string]: unknown;
}

export type ProvidersTable = Record<string, ProviderRecord>;


export interface ProviderSummary {
  key: string;
  api_base: string;
  has_key: boolean;
  key_hint: string;
  model: string | null;
  api_format: ApiFormat;
  models: ModelSpec[];
  
  rpm?: number;
}



const KEY_RE = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64}$/;
const MAX_MODELS = 200;
const MAX_MODEL_ID = 256;
const MAX_KEY_LEN = 512;
const MAX_BASE_URL = 2048;
const FETCH_TIMEOUT_MS = 15000;



const httpsKeepAliveAgent = new HttpsKeepAliveAgent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 8,
  maxFreeSockets: 4,
});
const httpKeepAliveAgent = new HttpKeepAliveAgent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 8,
  maxFreeSockets: 4,
});





function electronNet(): typeof import("electron").net | null {
  if (!process.versions.electron) { return null; }
  try {
    const { net, app } = require("electron") as typeof import("electron");
    if (!net || typeof net.fetch !== "function") { return null; }
    if (typeof app?.isReady === "function" && !app.isReady()) { return null; }
    return net;
  } catch {
    return null;
  }
}


let rootOverride: string | null = null;
export function setRootOverrideForTest(root: string | null): void {
  rootOverride = root;
}

function loadTable(): ProvidersTable {
  return (decrypt("config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {}) ?? {}) as ProvidersTable;
}

function maskKey(key: string): string {
  if (!key) { return ""; }
  if (key.length <= 8) { return "***"; }
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

function sanitizeModels(raw: unknown): ModelSpec[] | undefined {
  if (!Array.isArray(raw)) { return undefined; }
  return raw
    .filter((m): m is ModelSpec => typeof m === "object" && m !== null && typeof (m as ModelSpec).id === "string")
    .slice(0, MAX_MODELS)
    .map((rawM) => {
      
      
      let id = String((rawM as ModelSpec).id).slice(0, MAX_MODEL_ID);
      
      for (let i = 0; i < 2; i++) {
        const m1 = id.match(/^([a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64})::\/(.+)$/);
        if (m1) { id = m1[2]; continue; }
        const m2 = id.match(/^([a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64}):(.+)$/);
        if (m2) { id = m2[2]; continue; }
        break;
      }
      
      if (id.length > 4 && id.length % 2 === 0) {
        const half = id.length / 2;
        if (id.slice(0, half) === id.slice(half)) id = id.slice(0, half);
      }
      return {
        id,
        context_window: typeof (rawM as any).context_window === "number" && (rawM as any).context_window > 0 ? Math.floor((rawM as any).context_window) : undefined,
        max_output: typeof (rawM as any).max_output === "number" && (rawM as any).max_output > 0 ? Math.floor((rawM as any).max_output) : undefined,
        vision: (rawM as any).vision === true,
        
        thinking: (rawM as any).thinking === true,
        thinking_efforts: Array.isArray((rawM as any).thinking_efforts)
          ? ((rawM as any).thinking_efforts as string[]).filter((e: unknown) => typeof e === "string" && e) : undefined,
        price_in_usd: typeof (rawM as any).price_in_usd === "number" ? (rawM as any).price_in_usd : undefined,
        price_out_usd: typeof (rawM as any).price_out_usd === "number" ? (rawM as any).price_out_usd : undefined,
        
        
        
        
        
        
        price_cache_read_usd: typeof (rawM as any).price_cache_read_usd === "number"
          ? (rawM as any).price_cache_read_usd : undefined,
        price_cache_write_usd: typeof (rawM as any).price_cache_write_usd === "number"
          ? (rawM as any).price_cache_write_usd : undefined,
        pricing_tiered: (rawM as any).pricing_tiered === true,
        pricing_formula: typeof (rawM as any).pricing_formula === "string" && (rawM as any).pricing_formula
          ? (rawM as any).pricing_formula : undefined,
        pricing_mode: typeof (rawM as any).pricing_mode === "string" && (rawM as any).pricing_mode
          ? (rawM as any).pricing_mode : undefined,
        
        price_source: (rawM as any).price_source === "upstream" || (rawM as any).price_source === "table"
          || (rawM as any).price_source === "manual" ? (rawM as any).price_source : undefined,
        








        price_currency: (rawM as any).price_currency === "USD" || (rawM as any).price_currency === "CNY"
          ? (rawM as any).price_currency : undefined,
        
        
        
        
        price_tiers: normalizePriceTiers((rawM as any).price_tiers),
        
        pricing_time_tiers_candidate: normalizePriceTiers((rawM as any).pricing_time_tiers_candidate),
        pricing_context_tiers: Array.isArray((rawM as any).pricing_context_tiers)
          ? ((rawM as any).pricing_context_tiers as Array<Record<string, unknown>>)
              .filter((t) => t && typeof t === "object")
              .map((t) => ({
                ...(typeof t.fromInputTokens === "number" && t.fromInputTokens >= 0
                  ? { fromInputTokens: Math.floor(t.fromInputTokens) } : {}),
                ...(typeof t.prompt === "number" && t.prompt >= 0 ? { prompt: t.prompt } : {}),
                ...(typeof t.completion === "number" && t.completion >= 0 ? { completion: t.completion } : {}),
              }))
              .filter((t) => Object.keys(t).length > 0)
          : undefined,
        pricing_per_request: (rawM as any).pricing_per_request && typeof (rawM as any).pricing_per_request === "object"
          ? Object.fromEntries(Object.entries((rawM as any).pricing_per_request as Record<string, unknown>)
              .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0))
          : undefined,
        
        api_format: (rawM as any).api_format === "anthropic" || (rawM as any).api_format === "openai" || (rawM as any).api_format === "auto"
          ? (rawM as any).api_format : undefined,
        







        rpm: typeof (rawM as any).rpm === "number" && Number.isFinite((rawM as any).rpm) && (rawM as any).rpm >= 1
          ? Math.floor((rawM as any).rpm) : undefined,
        
        selected: (rawM as any).selected !== false,
      };
    });
}

export function listProviders(): ProviderSummary[] {
  const table = loadTable();
  return Object.entries(table)
    .filter(([key]) => key !== LOCAL_MODELS_KEY)
    .map(([key, rec]) => ({
      key,
      api_base: rec.api_base ?? "",
      has_key: Boolean(rec.api_key),
      key_hint: maskKey(rec.api_key ?? ""),
      model: rec.model ?? null,
      api_format: rec.api_format ?? "auto",
      models: sanitizeModels(rec.models) ?? [],
      
      
      rpm: typeof rec.rpm === "number" && Number.isFinite(rec.rpm as number) && (rec.rpm as number) >= 1
        ? Math.floor(rec.rpm as number) : undefined,
    }));
}

function normalizeBaseUrl(base: string): string {
  
  
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/, "");
}
















/** loopback 目标（`localhost` · `127.0.0.0/8` · `::1`）——**永远直连、不走系统代理**。
 *  为什么单独写、不复用 `isLocalEndpoint`：那个还含「私有网段 / 0.0.0.0 / 容器主机名」，
 *  对"该不该经代理"来说太宽（企业代理可以合法地转发内网流量）；这里只要 RFC 6761
 *  意义上的 loopback。 */
function isLoopbackTarget(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch { return false; }
}

/** 解析系统代理（环境变量优先，其次 Windows 注册表）。
 *  ⚠️ 2026-10-08 拍板：**loopback 目标直接返回 null（不走代理）**。两份依据：
 *    ① RFC 6761 —— 本机名不该经代理；
 *    ② 10-07 的现场诊断：直连失败 → 本函数兜底拿系统代理 → 代理对**本地端口**
 *       返回 **502** ⇒ `chromiumFetch` 如实 resolve 出一个 502 响应，把清晰的
 *       「连不上」翻译成含糊的「服务器答了 502」（a1195-chromiumfetch-bounds 曾在
 *       开代理的机器上因此稳定假红）。
 *  ——与 a1026「本地端点不吃兜底」（`isLocalEndpoint` 短路）同一设计哲学：
 *    本机流量要在**最早**的地方与代理路径分叉。
 *  另注（502 语义的本轮决策）：chromiumFetch 对**非 loopback** 目标经代理拿到的
 *  5xx（含 502）**保持 resolve**（fetch 契约：拿到响应即成功，HTTP 错误码由
 *  `res.ok/status` 表达）——上层（tryFetchModels / LLM 客户端）已按 `res.ok` 正确处理，
 *  不在本层把 5xx 重新翻译成 reject（那会破坏与全局 fetch 降级步的一致语义）。 */
function resolveSystemProxy(targetUrl: string): string | null {
  if (isLoopbackTarget(targetUrl)) { return null; }
  const env = process.env;
  const isHttps = targetUrl.toLowerCase().startsWith("https:");
  const fromEnv = (isHttps ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy) || env.ALL_PROXY || env.all_proxy;
  if (fromEnv && /^https?:\/\//i.test(fromEnv.trim())) {
    return fromEnv.trim().replace(/\/+$/, "");
  }
  
  try {
    const { execFileSync } = require("node:child_process");
    const reg = execFileSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyEnable",
    ], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const enabled = /0x1/i.test(reg);
    if (!enabled) { return null; }
    const proxyOut = execFileSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyServer",
    ], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const m = proxyOut.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    const raw = m?.[1]?.trim();
    if (!raw) { return null; }
    
    const schemeOf = (targetUrl.toLowerCase().startsWith("https:") ? "https" : "http");
    const perScheme = raw.match(new RegExp(`${schemeOf}=([^;\\s]+)`));
    const hostPort = perScheme?.[1] ?? (raw.includes("=") ? (raw.match(/https=([^;\\s]+)/)?.[1]) : raw);
    if (hostPort && !/^(https?|socks)\/\/|^[a-z]+=/i.test(hostPort)) {
      return `http://${hostPort}`;
    }
    if (/^https?:\/\//i.test(hostPort ?? "")) { return hostPort; }
  } catch {  }
  return null;
}








function httpRequestViaProxy(
  url: string,
  proxyBase: string,
  init: RequestInit = {},
  fallbackTimeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const proxy = new URL(proxyBase);
      const isHttps = url.startsWith("https");
      const httpMod = require("http");
      const method = (init.method ?? "GET").toUpperCase();
      const bodyStr = init.body == null ? null : typeof init.body === "string" ? init.body : String(init.body);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) {
        headers[k.toLowerCase()] = String(v);
      }
      if (bodyStr != null && headers["content-length"] == null) {
        headers["content-length"] = String(Buffer.byteLength(bodyStr));
      }
      const signal = (init as { signal?: AbortSignal }).signal;
      const targetHost = parsed.hostname;
      const targetPort = parsed.port || (isHttps ? 443 : 80);
      const fail = (e: unknown) => { if (signal?.aborted) { reject(new Error("aborted")); } else { reject(e instanceof Error ? e : new Error(String(e))); } };
      
      let connectReqRef: { destroy: (e: Error) => void } | null = null;
      const onAbort = (): void => {
        
        try { connectReqRef?.destroy(new Error("aborted")); } catch {}
      };
      const cleanupSig = () => { if (signal) { try { signal.removeEventListener("abort", onAbort); } catch {} } };
      const doHttp = () => {
        
        const req = httpMod.request({
          hostname: proxy.hostname,
          port: Number(proxy.port) || 7890,
          path: url,
          method,
          headers: { ...headers, host: `${targetHost}:${targetPort}` },
          timeout: signal ? 0 : fallbackTimeoutMs,
        }, (res: any) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer | string) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); chunks.push(b); size += b.length; });
          res.on("end", () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500, status: res.statusCode ?? 0, statusText: res.statusMessage || "", headers: res.headers as Record<string, string>, text: async () => Buffer.concat(chunks, size).toString("utf8"), json: async () => JSON.parse(Buffer.concat(chunks, size).toString("utf8")) } as unknown as Response));
        });
        req.on("error", fail);
        req.on("timeout", () => req.destroy(new Error("代理请求超时")));
        if (bodyStr != null) { req.write(bodyStr); }
        if (signal) {
          if (signal.aborted) { req.destroy(new Error("aborted")); } else { signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true }); }
        }
        req.end();
      };
      const doHttps = () => {
        
        const connectReq = httpMod.request({
          hostname: proxy.hostname,
          port: Number(proxy.port) || 7890,
          path: `${targetHost}:${targetPort}`,
          method: "CONNECT",
          timeout: 15000,
        });
        connectReq.on("connect", (_res: any, socket: unknown) => {
          cleanupSig();
          const httpsMod = require("https");
          const req = httpsMod.request({
            hostname: targetHost,
            port: targetPort,
            path: parsed.pathname + parsed.search,
            method,
            headers,
            timeout: signal ? 0 : fallbackTimeoutMs,
            createConnection: () => socket as any,
          }, (res: any) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer | string) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); chunks.push(b); size += b.length; });
            res.on("end", () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500, status: res.statusCode ?? 0, statusText: res.statusMessage || "", headers: res.headers as Record<string, string>, text: async () => Buffer.concat(chunks, size).toString("utf8"), json: async () => JSON.parse(Buffer.concat(chunks, size).toString("utf8")) } as unknown as Response));
          });
          req.on("error", fail);
          req.on("timeout", () => req.destroy(new Error("代理请求超时")));
          if (bodyStr != null) { req.write(bodyStr); }
          if (signal) {
            if (signal.aborted) { req.destroy(new Error("aborted")); } else { signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true }); }
          }
          req.end();
        });
        connectReq.on("error", fail);
        connectReq.on("timeout", () => connectReq.destroy(new Error("代理 CONNECT 超时")));
        
        connectReqRef = connectReq;
        if (signal) {
          if (signal.aborted) { connectReq.destroy(new Error("aborted")); }
          else { signal.addEventListener("abort", onAbort, { once: true }); }
        }
        connectReq.end();
      };
      if (isHttps) { doHttps(); } else { doHttp(); }
    } catch (e) { reject(e); }
  });
}

function httpRequest(
  url: string,
  init: RequestInit = {},
  fallbackTimeoutMs: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const isHttps = url.startsWith("https");
      const mod = isHttps ? require("https") : require("http");
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body;
      const bodyStr = body == null ? null : typeof body === "string" ? body : String(body);

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) {
        headers[k.toLowerCase()] = String(v);
      }
      
      
      if (bodyStr != null && headers["content-length"] == null) {
        headers["content-length"] = String(Buffer.byteLength(bodyStr));
      }

      
      
      const signal = (init as { signal?: AbortSignal }).signal;
      const nodeTimeout = signal ? 0 : fallbackTimeoutMs;

      const options: any = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: nodeTimeout,
        agent: isHttps ? httpsKeepAliveAgent : httpKeepAliveAgent,
      };
      const req = mod.request(options, (res: any) => {
        const status = res.statusCode ?? 0;
        
        
        
        
        
        
        
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        let endWaiters: Array<() => void> = [];
        const onEnded = () => {
          if (ended) { return; }
          ended = true;
          for (const w of endWaiters) { w(); }
          endWaiters = [];
        };
        let controllerRef: ReadableStreamDefaultController | null = null;
        const realStream: ReadableStream = new ReadableStream({
          start(controller) { controllerRef = controller; },
          cancel() { res.destroy(); },
        });
        res.on("data", (c: Buffer | string) => {
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          chunks.push(buf);
          size += buf.length;
          try { controllerRef?.enqueue(buf); } catch {  }
        });
        res.on("end", () => {
          onEnded();
          try { controllerRef?.close(); } catch {  }
        });
        res.on("error", (e: Error) => {
          onEnded();
          try { controllerRef?.error(e); } catch {  }
          reject(e);
        });
        const textDone: Promise<Buffer> = new Promise((resolveBuf) => {
          if (ended) { resolveBuf(Buffer.concat(chunks, size)); }
          else { endWaiters.push(() => resolveBuf(Buffer.concat(chunks, size))); }
        });
        resolve({
          ok: status >= 200 && status < 500,
          status,
          statusText: res.statusMessage || "",
          headers: res.headers as Record<string, string>,
          get body() { return realStream; },
          text: async () => (await textDone).toString("utf8"),
          json: async () => JSON.parse((await textDone).toString("utf8")),
        } as unknown as Response);
      });

      if (bodyStr != null) {
        req.write(bodyStr);
      }
      if (nodeTimeout > 0) {
        req.on("timeout", () => req.destroy(new Error(`请求超时（${fallbackTimeoutMs}ms）`)));
      }
      req.on("error", (e: Error) => reject(e));

      if (signal) {
        const onAbort = () => req.destroy(new Error("aborted"));
        if (signal.aborted) {
          req.destroy(new Error("aborted"));
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          req.on("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}










/** A-1195（交接欠账 B7）叠加分析——内层重试 × 外层 429 表**不是简单相乘**：
 *   · HTTP 状态类错误（429/5xx）由外层（llm/client.ts 的退避表）处理，内层只是 resolve 返回，不重试；
 *   · 连接/网络层错误由内层兜底（250/600/1200ms 短退避）；
 *   · 仅当「网络层持续失败」时两者才叠乘（最坏 12 次连接尝试）——但内层每次尝试与外层共享
 *     同一个超时窗口（combineAbortSignal 的 signal 一路传进 httpRequest），
 *     总时长有界于外层 timeoutMs，不因次数叠乘而放大；
 *   · 连接失败时服务器不可见（无风控暴露面）。
 *  结论：保留内层 3 次（对网络抖动的容错）；有界性由 a1195-chromiumfetch-bounds 守卫钉住。 */
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = [250, 600, 1200];

/** A-1194：abort 时统一抛 AbortError（与 DOM/undici 命名一致）。
 *  上层 llm/client.ts 按 name === "AbortError" 识别为「已取消」而非网络故障，
 *  绝不能被本文件的降级链当作「普通失败」继续重试/改走代理/重发。 */
function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** A-1194：可被 AbortSignal 打断的退避睡眠（本文件局部实现，不跨包引 core-ts）。 */
function abortableFetchSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) { return new Promise((r) => setTimeout(r, ms)); }
  if (signal.aborted) { return Promise.reject(abortError()); }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { cleanup(); reject(abortError()); };
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A-1194：把 net.fetch 与 abort 信号赛跑——即使某版本 Electron 的 net.fetch
 *  不理会 init.signal（历史 bug），用户点「停止」也必须能立刻脱身（底层请求自行收尾）。 */
function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) { return p; }
  if (signal.aborted) { return Promise.reject(abortError()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(abortError()); };
    const cleanup = (): void => { signal.removeEventListener("abort", onAbort); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}

export async function chromiumFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const urlString = String(url);
  const signal = (init as { signal?: AbortSignal }).signal;
  if (urlString.startsWith("http://") || urlString.startsWith("https://")) {
    
    
    
    if (urlString.startsWith("https://")) {
      const net = electronNet();
      if (net) {
        try {
          return await raceWithAbort(net.fetch(urlString, init), signal);
        } catch (e) {
          
          
          if (e instanceof Error && e.name === "AbortError") { throw e; }
          if (signal?.aborted) { throw abortError(); }
          console.warn(`[chromiumFetch] net.fetch 失败（降级 https.request）：${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
        }
      }
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < FETCH_RETRY_ATTEMPTS; attempt++) {
      if (signal?.aborted) { throw abortError(); }
      try {
        return await httpRequest(urlString, init, FETCH_TIMEOUT_MS);
      } catch (e) {
        
        if (signal?.aborted) { throw abortError(); }
        lastErr = e;
        if (attempt < FETCH_RETRY_ATTEMPTS - 1) {
          
          const delay = FETCH_RETRY_DELAY_MS[attempt] ?? 800;
          await abortableFetchSleep(delay, signal);
        }
      }
    }
    
    
    
    if (signal?.aborted) { throw abortError(); }
    const proxy = resolveSystemProxy(urlString);
    if (proxy) {
      try {
        console.info(`[chromiumFetch] 直连失败，尝试经系统代理 ${proxy} 访问 ${urlString.slice(0, 60)}`);
        return await httpRequestViaProxy(urlString, proxy, init, Math.max(FETCH_TIMEOUT_MS, 20000));
      } catch (e) {
        
        if (signal?.aborted) { throw abortError(); }
        lastErr = e;
        console.warn(`[chromiumFetch] 代理路径失败：${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
      }
    }
    if (signal?.aborted) { throw abortError(); }
    console.warn(`[chromiumFetch] https.request failed after ${FETCH_RETRY_ATTEMPTS} attempts for ${urlString.slice(0, 60)}: ${String(lastErr)} — falling back to global fetch`);
  }
  return fetch(url, init);
}


function parseModelIds(body: unknown): string[] {
  let items: Array<Record<string, unknown>> | null = null;
  const b = (body ?? {}) as Record<string, unknown>;
  
  
  
  
  if (Array.isArray(b.data)) {
    items = b.data as Array<Record<string, unknown>>;
  } else if (Array.isArray(b.models)) {
    items = b.models as Array<Record<string, unknown>>;
  } else if (Array.isArray(b.model_list)) {
    items = b.model_list as Array<Record<string, unknown>>;
  } else if (b.models && typeof b.models === "object") {
    items = Object.values(b.models).filter(Boolean) as Array<Record<string, unknown>>;
  } else if (Array.isArray(body)) {
    items = body as Array<Record<string, unknown>>;
  }
  if (!items || items.length === 0) { return []; }
  return items
    .filter((m): m is { id: unknown } => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string")
    .map((m) => m.id as string)
    .filter(Boolean)
    .slice(0, MAX_MODELS);
}

async function tryFetchModels(url: string, apiKey: string, format: ApiFormat): Promise<ModelSpec[]> {
  
  
  
  const headerSets: Array<Record<string, string>> = [];
  if (format === "anthropic") {
    headerSets.push({ "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" });
  } else if (format === "google") {
    headerSets.push({ "x-goog-api-key": apiKey, Accept: "application/json" });
  } else if (format === "openai" || format === "responses") {
    headerSets.push({ Authorization: `Bearer ${apiKey}`, Accept: "application/json" });
  } else {
    headerSets.push({ Authorization: `Bearer ${apiKey}`, Accept: "application/json" });
    headerSets.push({ "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" });
  }
  let lastAuthErr: unknown;
  for (const headers of headerSets) {
    try {
      const res = await chromiumFetch(url, {
        headers: identityHeaders(headers),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const body: unknown = await res.json();
      const ids = parseModelIds(body);
      if (ids.length === 0) {
        throw new Error("响应中无有效模型 id");
      }
      return ids.map((id) => ({ id }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      
      
      if (/^HTTP (401|403)\b/.test(msg)) {
        lastAuthErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastAuthErr instanceof Error ? lastAuthErr : new Error(String(lastAuthErr));
}
























type PriceUnit = "per_token" | "per_million" | "auto";









function parseUsdPerMillion(v: unknown, unit: PriceUnit = "auto"): number | undefined {
  let n: number;
  if (typeof v === "number") { n = v; }
  else if (typeof v === "string" && v.trim() !== "") {
    
    const cleaned = v.trim().replace(/^\$/, "").replace(/\s*(usd|USD|\/1m|\/1M)\s*$/, "");
    n = Number(cleaned);
  } else { return undefined; }
  if (!Number.isFinite(n) || n < 0) { return undefined; }
  if (n === 0) { return 0; } 
  const perToken = unit === "per_token" || (unit === "auto" && n < 1e-3);
  return perToken ? n * 1_000_000 : n;
}


function pickPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") { return undefined; }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}












const UPSTREAM_PRICE_FIELDS: Array<{
  slot: "prompt" | "completion" | "cacheRead" | "cacheWrite" | "cacheWrite1h";
  paths: Array<[string, PriceUnit]>;
}> = [
  {
    slot: "prompt",
    paths: [
      ["pricing.prompt", "auto"],              
      ["input_cost_per_token", "per_token"],   
      ["input_cost_per_1m_tokens", "per_million"],
      ["input_cost_per_million_tokens", "per_million"],
      ["prompt_price", "auto"],                
      ["input_price", "auto"],
      ["prompt", "auto"],                      
    ],
  },
  {
    slot: "completion",
    paths: [
      ["pricing.completion", "auto"],
      ["output_cost_per_token", "per_token"],
      ["output_cost_per_1m_tokens", "per_million"],
      ["output_cost_per_million_tokens", "per_million"],
      ["completion_price", "auto"],
      ["output_price", "auto"],
      ["completion", "auto"],
    ],
  },
  {
    
    slot: "cacheRead",
    paths: [
      ["pricing.input_cache_read", "auto"],          
      ["pricing.cache_read", "auto"],                
      ["cache_read_input_token_cost", "per_token"],  
      ["cache_read_input_token_cost_per_1m", "per_million"],
      ["cached_input_cost", "per_token"],            
      ["input_cache_read_cost", "auto"],
      ["cache_read_price", "auto"],
      ["cached_input_price", "auto"],
      ["cache_read", "auto"],
    ],
  },
  {
    
    slot: "cacheWrite",
    paths: [
      ["pricing.input_cache_write", "auto"],              
      ["pricing.cache_creation", "auto"],                 
      ["cache_creation_input_token_cost", "per_token"],   
      ["cache_creation_input_token_cost_per_1m", "per_million"],
      ["cache_write_5m_cost", "auto"],                    
      ["cache_creation_price", "auto"],
      ["input_cache_write_cost", "auto"],
      ["cache_creation", "auto"],
      ["cache_write", "auto"],
    ],
  },
  {
    
    
    slot: "cacheWrite1h",
    paths: [
      ["pricing.input_cache_write_1h", "auto"],
      ["cache_write_1h_cost", "auto"],
      ["cache_write_1h_ratio", "auto"],
    ],
  },
];





const CACHE_RATIO_FIELDS: Array<{ slot: "cacheRead" | "cacheWrite" | "cacheWrite1h"; names: string[] }> = [
  { slot: "cacheRead", names: ["cache_ratio", "cached_input_ratio", "cache_read_ratio"] },
  { slot: "cacheWrite", names: ["create_cache_ratio", "cache_write_5m_ratio", "cache_creation_ratio", "cache_write_ratio"] },
  { slot: "cacheWrite1h", names: ["cache_write_1h_ratio"] },
];


export interface UpstreamTimeOverride {
  
  minPromptTokens?: number;
  
  utcStart?: number;
  utcEnd?: number;
  
  utcDays?: number[];
  prompt?: number;
  completion?: number;
  cacheRead?: number;
}


export interface UpstreamContextTier {
  
  fromInputTokens?: number;
  prompt?: number;
  completion?: number;
}

const UTC_DAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};


function hhmmToMinute(v: unknown): number | undefined {
  let h: number;
  let m: number;
  if (typeof v === "number" && Number.isFinite(v)) {
    h = Math.floor(v / 100); m = v % 100;
  } else if (typeof v === "string" && /^\d{1,2}:?\d{2}$/.test(v.trim())) {
    const s = v.trim();
    const parts = s.includes(":") ? s.split(":") : [s.slice(0, s.length - 2), s.slice(-2)];
    h = Number(parts[0]); m = Number(parts[1]);
  } else { return undefined; }
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) { return undefined; }
  return h * 60 + m;
}










export function parsePricingOverrides(raw: unknown): UpstreamTimeOverride[] | undefined {
  if (!Array.isArray(raw)) { return undefined; }
  const out: UpstreamTimeOverride[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") { continue; }
    const r = o as Record<string, unknown>;
    const prompt = parseUsdPerMillion(r.prompt, "auto");
    const completion = parseUsdPerMillion(r.completion, "auto");
    const cacheRead = parseUsdPerMillion(r.input_cache_read ?? r.cache_read, "auto");
    if (prompt === undefined && completion === undefined && cacheRead === undefined) { continue; }
    const days = Array.isArray(r.utc_days)
      ? [...new Set(r.utc_days
          .map((d) => (typeof d === "string" ? UTC_DAY_INDEX[d.trim().toLowerCase()] : d))
          .filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))]
        .sort((a, b) => a - b)
      : undefined;
    const minPrompt = typeof r.min_prompt_tokens === "number" && r.min_prompt_tokens > 0
      ? Math.floor(r.min_prompt_tokens) : undefined;
    const utcStart = hhmmToMinute(r.utc_start);
    const utcEnd = hhmmToMinute(r.utc_end);
    
    if (utcStart === undefined && utcEnd === undefined && minPrompt === undefined) { continue; }
    
    
    if (utcStart !== undefined && utcEnd !== undefined && utcStart === utcEnd) { continue; }
    out.push({
      ...(minPrompt !== undefined ? { minPromptTokens: minPrompt } : {}),
      ...(utcStart !== undefined ? { utcStart } : {}),
      ...(utcEnd !== undefined ? { utcEnd } : {}),
      ...(days && days.length > 0 ? { utcDays: days } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(completion !== undefined ? { completion } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}








export function overridesToPriceTiers(overrides: UpstreamTimeOverride[], baseIn: number, baseOut: number): ModelPriceTiers | undefined {
  const tiers: ModelPriceTier[] = [];
  for (const [i, o] of overrides.entries()) {
    if (o.utcStart === undefined && o.utcEnd === undefined) { continue; }
    const startMin = o.utcStart ?? 0;
    const endMin = o.utcEnd ?? 1439;
    if (startMin === endMin) { continue; } 
    tiers.push({
      id: `upstream${tiers.length + 1}`,
      label: `上游档位 ${i + 1}（UTC）`,
      windows: [{ ...(o.utcDays ? { days: o.utcDays } : {}), startMin, endMin }],
      priceIn: o.prompt ?? baseIn,
      priceOut: o.completion ?? o.prompt ?? baseOut,
      ...(o.cacheRead !== undefined ? { priceCacheRead: o.cacheRead } : {}),
    });
  }
  if (tiers.length === 0) { return undefined; }
  
  
  tiers.push({ id: "base", label: "其余时段（基准价）", windows: [], priceIn: baseIn, priceOut: baseOut });
  return { timezone: "UTC", tiers };
}








export function parseContextTiers(item: Record<string, unknown>): UpstreamContextTier[] | undefined {
  const out: UpstreamContextTier[] = [];
  
  for (const [k, v] of Object.entries(item)) {
    const m = /^input_cost_per_(?:token|1m_tokens)_above_(\d+)(k?)_tokens$/.exec(k);
    if (!m) { continue; }
    const prompt = parseUsdPerMillion(v, k.includes("per_token") ? "per_token" : "auto");
    if (prompt === undefined) { continue; }
    const threshold = Number(m[1]) * (m[2] === "k" ? 1000 : 1);
    const completionKey = k.replace("input_cost", "output_cost");
    out.push({
      fromInputTokens: threshold,
      prompt,
      ...(typeof item[completionKey] !== "undefined"
        ? { completion: parseUsdPerMillion(item[completionKey], k.includes("per_token") ? "per_token" : "auto") } : {}),
    });
  }
  
  if (Array.isArray(item.tiers)) {
    for (const t of item.tiers) {
      if (!t || typeof t !== "object") { continue; }
      const r = t as Record<string, unknown>;
      const threshold = typeof r.input_token_threshold === "number" ? r.input_token_threshold : undefined;
      const prompt = parseUsdPerMillion(
        r.input_cost_per_million_tokens ?? r.input_cost_per_token ?? r.input_price, "auto");
      const completion = parseUsdPerMillion(
        r.output_cost_per_million_tokens ?? r.output_cost_per_token ?? r.output_price, "auto");
      if (prompt === undefined && completion === undefined) { continue; }
      out.push({
        ...(threshold !== undefined ? { fromInputTokens: threshold } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(completion !== undefined ? { completion } : {}),
      });
    }
  }
  return out.length > 0 ? out.sort((a, b) => (a.fromInputTokens ?? 0) - (b.fromInputTokens ?? 0)) : undefined;
}





































export interface TierMultipliers {
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  cacheCreate?: number;
}
export interface ParsedBillingTier {
  
  label: string;
  
  multipliers?: TierMultipliers;
}
export interface ParsedBillingExpr {
  
  raw: string;
  
  mode?: string;
  
  boundary?: number;
  
  tiers: ParsedBillingTier[];
  
  tiered: boolean;
}


function parseTierExpression(expr: string): ParsedBillingTier | null {
  const m = expr.match(/^\s*tier\(\s*"([^"]*)"\s*,\s*(.+?)\s*\)\s*$/);
  if (!m) { return null; }
  const label = m[1];
  const body = m[2];
  
  const get = (key: string): number | undefined => {
    const re = new RegExp(`\\b${key}\\b\\s*\\*\\s*(\\d+(?:\\.\\d+)?)`);
    const mm = body.match(re);
    if (!mm) { return undefined; }
    const n = Number(mm[1]);
    return Number.isFinite(n) ? n : undefined;
  };
  const prompt = get("p");
  const completion = get("c");
  const cacheRead = get("cr");
  const cacheCreate = get("cc");
  const multipliers = (prompt !== undefined || completion !== undefined
    || cacheRead !== undefined || cacheCreate !== undefined)
    ? { prompt, completion, cacheRead, cacheCreate } : undefined;
  return { label, multipliers };
}


export function parseBillingExpr(formula: unknown, mode?: unknown): ParsedBillingExpr | undefined {
  if (typeof formula !== "string") { return undefined; }
  const raw = formula.trim();
  if (!raw) { return undefined; }
  
  const condMatch = raw.match(/^len\s*<=\s*(\d+)\s*\?\s*(.+?)\s*:\s*(.+)$/);
  let boundary: number | undefined;
  let exprs: string[];
  if (condMatch) {
    const n = Number(condMatch[1]);
    boundary = Number.isFinite(n) && n > 0 ? n : undefined;
    exprs = [condMatch[2].trim(), condMatch[3].trim()];
  } else {
    boundary = undefined;
    exprs = [raw];
  }
  const tiers: ParsedBillingTier[] = [];
  for (const e of exprs) {
    const t = parseTierExpression(e);
    if (t) { tiers.push(t); }
  }
  return {
    raw,
    mode: typeof mode === "string" && mode ? mode : undefined,
    boundary,
    tiers,
    tiered: boundary !== undefined && tiers.length > 1,
  };
}

export type NewApiPricing = {
  prompt?: number;
  completion?: number;
  
  promptCacheRead?: number;
  
  promptCacheCreate?: number;
  



  promptCacheWrite1h?: number;
  
  discount?: number;
  
  billingMode?: string;
  
  tiered?: ParsedBillingExpr;
  



  timeOverrides?: UpstreamTimeOverride[];
  
  contextTiers?: UpstreamContextTier[];
  
  perRequest?: { request?: number; image?: number; webSearch?: number; internalReasoning?: number; audio?: number };
};

export function newApiConfigMap(data: unknown): Map<string, { pricing?: NewApiPricing }> {
  const out = new Map<string, { pricing?: NewApiPricing }>();
  if (!data || typeof data !== "object") { return out; }
  const d = data as Record<string, unknown>;
  const ratioMap = d.model_ratio;
  const compMap = d.completion_ratio;
  
  
  const pickMap = (names: string[]): Record<string, unknown> | undefined => {
    for (const n of names) {
      const v = d[n];
      if (v && typeof v === "object") { return v as Record<string, unknown>; }
    }
    return undefined;
  };
  const cacheMap = pickMap(["cache_ratio", "cached_input_ratio", "cache_read_ratio"]);
  const cacheCreateMap = pickMap(["create_cache_ratio", "cache_creation_ratio", "cache_write_ratio", "cache_write_5m_ratio"]);
  const cacheWrite1hMap = pickMap(["cache_write_1h_ratio"]);
  const billingExprMap = d.billing_expr;
  const billingModeMap = d.billing_mode;
  if (!ratioMap || typeof ratioMap !== "object") { return out; }
  for (const [id, r] of Object.entries(ratioMap as Record<string, unknown>)) {
    












    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) { continue; }
    const cr = (compMap && typeof compMap === "object")
      ? (compMap as Record<string, unknown>)[id] : undefined;
    const completionRatio = typeof cr === "number" && cr > 0 ? cr : 1;
    const perMillion = r * 2; 
    
    
    const rel = (map: Record<string, unknown> | undefined): number | undefined => {
      const v = map?.[id];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const cacheR = rel(cacheMap);
    const cacheC = rel(cacheCreateMap);
    const cache1h = rel(cacheWrite1hMap);
    
    
    const exprStr = (billingExprMap && typeof billingExprMap === "object")
      ? (billingExprMap as Record<string, unknown>)[id] : undefined;
    const modeStr = (billingModeMap && typeof billingModeMap === "object")
      ? (billingModeMap as Record<string, unknown>)[id] : undefined;
    const tiered = exprStr !== undefined ? parseBillingExpr(exprStr, modeStr) : undefined;
    const billingMode = typeof modeStr === "string" && modeStr ? modeStr : undefined;
    out.set(id, {
      pricing: {
        prompt: perMillion,
        completion: perMillion * completionRatio,
        promptCacheRead: cacheR !== undefined ? perMillion * cacheR : undefined,
        promptCacheCreate: cacheC !== undefined ? perMillion * cacheC : undefined,
        promptCacheWrite1h: cache1h !== undefined ? perMillion * cache1h : undefined,
        billingMode,
        tiered,
      },
    });
  }
  return out;
}


export interface UpstreamModelDetail {
  context_length?: number;
  max_output?: number;
  pricing?: NewApiPricing;
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] };
  architecture?: { input_modalities?: string[] };
}


export type UpstreamJsonFetcher = (url: string) => Promise<{ data?: unknown } | null>;


export function parseUpstreamModelItems(items: Array<Record<string, unknown>>): Map<string, UpstreamModelDetail> {
  return new Map(items.map((d) => {
    
    
    const rawMax = (d as any).max_completion_tokens
      ?? (d as any).top_provider?.max_completion_tokens
      ?? (d as any).max_output_tokens
      ?? (d as any).max_tokens;
    
    const id = String((d as any).id ?? (d as any).model_name ?? (d as any).model ?? "");
    
    
    
    const quotaType = typeof (d as any).quota_type === "number" ? (d as any).quota_type : 0;
    const newApiRatioRaw = typeof (d as any).model_ratio === "number" ? (d as any).model_ratio : undefined;
    const newApiRatio = quotaType === 0 && newApiRatioRaw !== undefined && newApiRatioRaw > 0
      ? newApiRatioRaw : undefined;
    const newApiComp = typeof (d as any).completion_ratio === "number" && (d as any).completion_ratio > 0
      ? (d as any).completion_ratio : 1;

    
    const bySlot: Record<string, number | undefined> = {};
    for (const f of UPSTREAM_PRICE_FIELDS) {
      for (const [path, unit] of f.paths) {
        const v = parseUsdPerMillion(pickPath(d, path), unit);
        if (v !== undefined) { bySlot[f.slot] = v; break; }
      }
    }
    
    const prompt = bySlot.prompt ?? (newApiRatio !== undefined ? newApiRatio * 2 : undefined);
    const completion = bySlot.completion
      ?? (prompt !== undefined && (newApiRatio !== undefined || bySlot.prompt !== undefined)
        ? prompt * newApiComp : undefined);

    
    const ratioOf = (names: string[]): number | undefined => {
      for (const n of names) {
        const v = (d as any)[n];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) { return v; }
      }
      return undefined;
    };
    const fromRatio: Record<string, number | undefined> = {};
    for (const f of CACHE_RATIO_FIELDS) {
      const r = ratioOf(f.names);
      if (r !== undefined && prompt !== undefined) { fromRatio[f.slot] = prompt * r; }
    }

    
    const billingExprStr = typeof (d as any).billing_expr === "string" ? (d as any).billing_expr : undefined;
    const billingModeStr = typeof (d as any).billing_mode === "string" && (d as any).billing_mode
      ? (d as any).billing_mode : undefined;
    const tieredParsed = billingExprStr !== undefined ? parseBillingExpr(billingExprStr, billingModeStr) : undefined;

    
    const timeOverrides = parsePricingOverrides((d as any).pricing?.overrides ?? (d as any).overrides);
    const contextTiers = parseContextTiers(d);
    
    const perRequest = {
      request: parseUsdPerMillion((d as any).pricing?.request, "per_million"),
      image: parseUsdPerMillion((d as any).pricing?.image, "per_million"),
      webSearch: parseUsdPerMillion((d as any).pricing?.web_search, "per_million"),
      internalReasoning: parseUsdPerMillion((d as any).pricing?.internal_reasoning, "per_million"),
      audio: parseUsdPerMillion((d as any).pricing?.audio, "per_million"),
    };
    const hasPerRequest = Object.values(perRequest).some((v) => v !== undefined);

    const pricing: NewApiPricing | undefined = prompt !== undefined
      ? {
          prompt,
          completion,
          promptCacheRead: bySlot.cacheRead ?? fromRatio.cacheRead,
          promptCacheCreate: bySlot.cacheWrite ?? fromRatio.cacheWrite,
          promptCacheWrite1h: bySlot.cacheWrite1h ?? fromRatio.cacheWrite1h,
          
          discount: typeof (d as any).pricing?.discount === "string"
            ? parseFloat((d as any).pricing.discount) : undefined,
          billingMode: billingModeStr,
          tiered: tieredParsed,
          timeOverrides,
          contextTiers,
          ...(hasPerRequest ? { perRequest } : {}),
        }
      : undefined;
    
    
    
    const rawCtx = (d as any).context_length
      ?? (d as any).context_window
      ?? (d as any).max_context_length
      ?? (d as any).context_size
      ?? (d as any).max_input_tokens
      ?? (d as any).top_provider?.context_length
      ?? (d as any).model_info?.context_length;
    return [
      id,
      {
        context_length: typeof rawCtx === "number" && rawCtx > 0 ? Math.floor(rawCtx) : undefined,
        max_output: typeof rawMax === "number" && rawMax > 0 ? Math.floor(rawMax) : undefined,
        pricing,
        reasoning: d.reasoning && typeof d.reasoning === "object"
          ? {
              mandatory: Boolean((d.reasoning as any).mandatory),
              supported_efforts: Array.isArray((d.reasoning as any).supported_efforts)
                ? ((d.reasoning as any).supported_efforts as string[]) : undefined,
            }
          : undefined,
        architecture: d.architecture && typeof d.architecture === "object"
          ? { input_modalities: Array.isArray((d.architecture as any).input_modalities)
              ? ((d.architecture as any).input_modalities as string[]) : undefined }
          : undefined,
      },
    ] as const;
  }));
}


async function fetchUpstreamDetails(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<Map<string, UpstreamModelDetail>> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return new Map(); }
  const isAnthropic = format === "anthropic";
  const headers: Record<string, string> = isAnthropic
    ? { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", Accept: "application/json" }
    : { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };

  const getJson: UpstreamJsonFetcher = async (url) => {
    try {
      const res = await chromiumFetch(url, { headers: identityHeaders(headers), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) { return null; }
      return await res.json() as { data?: unknown };
    } catch {
      return null;
    }
  };

  return probeUpstreamTwoPhase(base, getJson);
}


















export async function probeUpstreamTwoPhase(
  base: string,
  getJson: UpstreamJsonFetcher,
): Promise<Map<string, UpstreamModelDetail>> {
  const details = new Map<string, UpstreamModelDetail>();

  
  for (const url of [`${base}/v1/models`, `${base}/models`, `${base}/api/v1/models`, `${base}/openapi.json`]) {
    const body = await getJson(url);
    if (!body || !Array.isArray(body.data)) { continue; }
    for (const [id, d] of parseUpstreamModelItems(body.data as Array<Record<string, unknown>>)) {
      if (id) { details.set(id, d); }
    }
    if (details.size > 0) { break; } 
  }

  
  for (const url of [`${base}/api/pricing`, `${base}/api/ratio_config`]) {
    const body = await getJson(url);
    if (!body || body.data === undefined || body.data === null) { continue; }
    
    
    const entries = Array.isArray(body.data)
      ? parseUpstreamModelItems(body.data as Array<Record<string, unknown>>)
      : newApiConfigMap(body.data);
    let merged = 0;
    for (const [id, cfg] of entries) {
      if (!cfg.pricing) { continue; }
      const cur = details.get(id) ?? {};
      
      details.set(id, { ...cur, pricing: cur.pricing ?? cfg.pricing });
      merged += 1;
    }
    if (merged > 0) { break; }
  }

  return details;
}




















export function providerCtxWindow(input: {
  baseUrl: string;
  modelId: string;
  upstreamCtx?: number;
  savedCtx?: number;
}): number | undefined {
  const up = input.upstreamCtx;
  if (typeof up === "number" && up > 0) { return Math.floor(up); }
  if (isLocalEndpoint(input.baseUrl)) { return undefined; }
  const family = inferModelCapabilities(input.modelId).context;
  if (typeof family === "number" && family > 0) { return family; }
  const saved = input.savedCtx;
  if (typeof saved === "number" && saved > 0) { return saved; }
  const inferred = inferModelDefaults(input.modelId).context_window;
  return typeof inferred === "number" && inferred > 0 ? inferred : undefined;
}


function inferModelDefaults(modelId: string): Partial<ModelSpec> {
  
  
  const caps = inferModelCapabilities(modelId);
  const id = modelId.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");

  
  let context_window: number | undefined = caps.context;
  
  if (context_window === undefined) {
    if (/gpt[-_]4o[-_]/.test(id)) { context_window = 128000; }
    else if (/gpt[-_]4[-_turbo]?/.test(id)) {
      context_window = id.includes("preview") ? 128000 : 8192;
    }
    else if (/claude[-_][3-9]/.test(id) || /claude[-_]/.test(id)) {
      context_window = id.includes("opus") || id.includes("sonnet") ? 200000 : 200000;
    }
    else if (/deepseek[-_](chat|reasoner)/.test(id)) { context_window = 64000; }
    else if (/deepseek[-_]v[23]/.test(id)) { context_window = 64000; }
    else if (/gemini[-_](2\.0|1\.5|1\.0|pro|flash|ultra)/.test(id)) { context_window = 1048576; }
    else if (/qwen[-_]/.test(id) || /qwen2?[-_]/.test(id)) { context_window = 131072; }
    else if (/llama[-_]/.test(id) || /llama3?[-_]/.test(id)) { context_window = 131072; }
    else if (/mixtral[-_]/.test(id)) { context_window = 32768; }
    else if (/mistral[-_]/.test(id)) { context_window = 131072; }
    else if (/command[-_]/.test(id)) { context_window = 4096; }
    else if (/yi[-_]/.test(id)) { context_window = 40960; }
    else if (/GLM[-_]/.test(id) || /glm[-_]/.test(id)) { context_window = 128000; }
    else if (/intern[-_]/.test(id)) { context_window = 131072; }
    else if (/doubao|ep-/.test(id)) { context_window = 131072; } 
    else if (/step[-_]?l?2?[-_]/.test(id)) { context_window = 131072; } 
    












    else if (/agnes[-_]/.test(id)) { context_window = 512000; }
    else if (/seedance|seed[-_]/.test(id)) { context_window = 131072; } 
    else if (/sonic[-_]|ep-.*sonic/.test(id)) { context_window = 131072; } 
    else if (/flux[-_]/.test(id)) { context_window = 4096; } 
  }


  
  const hasVision = /vision|vl|iv|image|gpt[-_]4o[-_]image|claude[-_][^-]*op?us[-_]|gemini[-_].*flash|agnes[-_].*flash|doubao[-_].*vision|glm[-_].*vision/.test(id);

  
  let max_output: number | undefined = caps.maxOut;
  if (max_output === undefined) {
    if (/o1[-_]/.test(id) || /o3[-_]/.test(id)) { max_output = 100000; }
    else if (/claude[-_]/.test(id)) { max_output = 8192; }
    else if (/gpt[-_]/.test(id)) { max_output = 16384; }
    else if (/deepseek[-_]/.test(id)) { max_output = 8192; }
    else if (/agnes[-_]/.test(id)) { max_output = 65536; } 
    else if (/gemini[-_]/.test(id)) { max_output = 8192; }
  }

  return { context_window, vision: hasVision, max_output };
}

















export function mergeModelPrice(
  prev: Pick<ModelSpec, "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd" | "price_source" | "price_tiers" | "price_currency"> | undefined,
  next: Pick<ModelSpec, "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd" | "price_source" | "price_tiers" | "price_currency">,
): Pick<ModelSpec, "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd" | "price_source" | "price_tiers" | "price_currency"> {
  
  
  
  const keepTiers = prev?.price_tiers;
  
  
  
  const keepCurrency = prev?.price_currency;
  if (prev?.price_source === "manual") {
    return {
      price_in_usd: prev.price_in_usd,
      price_out_usd: prev.price_out_usd,
      price_cache_read_usd: prev.price_cache_read_usd,
      price_cache_write_usd: prev.price_cache_write_usd,
      price_source: "manual",
      price_tiers: keepTiers,
      price_currency: next.price_currency ?? keepCurrency,
    };
  }
  return {
    price_in_usd: next.price_in_usd !== undefined ? next.price_in_usd : prev?.price_in_usd,
    price_out_usd: next.price_out_usd !== undefined ? next.price_out_usd : prev?.price_out_usd,
    price_cache_read_usd: next.price_cache_read_usd !== undefined ? next.price_cache_read_usd : prev?.price_cache_read_usd,
    price_cache_write_usd: next.price_cache_write_usd !== undefined ? next.price_cache_write_usd : prev?.price_cache_write_usd,
    price_source: next.price_source ?? prev?.price_source,
    price_tiers: next.price_tiers ?? keepTiers,
    price_currency: next.price_currency ?? keepCurrency,
  };
}


























export function inferPricingFromUrl(baseUrl: string, modelId: string, at?: Date | string | number): {
  price_in_usd?: number;
  price_out_usd?: number;
  price_cache_read_usd?: number;
  
  tier_id?: string;
} {
  const base = (baseUrl ?? "").toLowerCase();
  
  
  
  if (isLocalEndpoint(base)) {
    return { price_in_usd: 0, price_out_usd: 0, price_cache_read_usd: 0 };
  }
  
  const r = resolveModelPriceTier(modelId, at);
  return {
    price_in_usd: r.pricing.priceIn,
    price_out_usd: r.pricing.priceOut,
    price_cache_read_usd: r.pricing.priceCacheRead,
    tier_id: r.tiered ? r.tierId : undefined,
  };
}































export function resolvePrice(
  saved: number | undefined,
  savedIsManual: boolean,
  upstream: number | undefined,
  table: number | undefined,
): { value?: number; source?: "upstream" | "table" | "manual" } {
  if (savedIsManual && typeof saved === "number") { return { value: saved, source: "manual" }; }
  
  if (typeof upstream === "number") { return { value: upstream, source: "upstream" }; }
  if (typeof table === "number") { return { value: table, source: "table" }; }
  if (typeof saved === "number") { return { value: saved, source: undefined }; }
  return {};
}




















export function makePriceResolver(table: ProvidersTable): PriceResolver {
  
  const index = new Map<string, ProviderRecord>();
  for (const [key, rec] of Object.entries(table ?? {})) {
    if (key.startsWith("_")) { continue; } 
    index.set(key, rec);
  }

  return (providerKey: string, model: string, ts?: string): UsagePrice | undefined => {
    const rec = index.get(providerKey);
    const specs = Array.isArray(rec?.models) ? rec.models : [];
    const hit = specs.find((m) => m.id === model);
    








    const eff = resolveEffectivePricing(model, String(rec?.api_base ?? ""), hit, ts);
    if (eff.origin === "none") { return undefined; }
    return {
      priceIn: eff.priceIn,
      priceOut: eff.priceOut,
      priceCacheRead: eff.priceCacheRead,
      priceCacheWrite: eff.priceCacheWrite,
      tierId: eff.tierId,
    };
  };
}


export function buildPriceResolver(): PriceResolver {
  return makePriceResolver(loadTable());
}







function inferThinkingSupport(modelId: string): { supported: boolean; efforts?: string[] } {
  const cap = inferModelCapabilities(modelId);
  return { supported: cap.supported, efforts: cap.efforts };
}

export async function enrichModels(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<{ ok: boolean; models?: ModelSpec[]; api_format?: ApiFormat; error?: string }> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base) { return { ok: false, error: "Base URL 不能为空" }; }
  if (!apiKey.trim()) { return { ok: false, error: "API Key 不能为空" }; }

  
  
  
  
  let effectiveFormat: ApiFormat = format;
  if (format === "auto") {
    const p = await probeProvider(baseUrl, apiKey);
    if (p.ok && p.result && p.result.confidence >= 0.6 && p.result.apiFormat) {
      effectiveFormat = p.result.apiFormat;
    } else {
      effectiveFormat = await detectApiFormat(baseUrl, apiKey);
    }
  }

  
  const fetchRes = await fetchModels(baseUrl, apiKey, effectiveFormat);
  if (!fetchRes.ok || !fetchRes.models) {
    return { ok: false, error: fetchRes.error };
  }
  const baseModels = fetchRes.models;

  
  const upstreamDetails = await fetchUpstreamDetails(baseUrl, apiKey.trim(), effectiveFormat);

  
  
  const models = baseModels.map((m) => {
    const upstream = upstreamDetails.get(m.id);

    
    
    
    
    
    const ctxWindow = providerCtxWindow({
      baseUrl,
      modelId: m.id,
      upstreamCtx: upstream?.context_length,
      savedCtx: typeof m.context_window === "number" ? m.context_window : undefined,
    });

    
    
    
    
    
    
    
    const fallbackPricing = inferPricingFromUrl(baseUrl, m.id);
    const rIn = resolvePrice(m.price_in_usd, false, upstream?.pricing?.prompt, fallbackPricing.price_in_usd);
    const rOut = resolvePrice(m.price_out_usd, false, upstream?.pricing?.completion, fallbackPricing.price_out_usd);
    const rCacheRead = resolvePrice(m.price_cache_read_usd, false, upstream?.pricing?.promptCacheRead, fallbackPricing.price_cache_read_usd);
    const rCacheWrite = resolvePrice(m.price_cache_write_usd, false, upstream?.pricing?.promptCacheCreate, undefined);

    
    
    const tieredUpstream = upstream?.pricing?.tiered;
    const pricingTiered = tieredUpstream?.tiered ?? (m.pricing_tiered === true);
    const pricingFormula = tieredUpstream?.raw ?? m.pricing_formula;
    const pricingMode = upstream?.pricing?.billingMode ?? m.pricing_mode;

    







    const timeOv = upstream?.pricing?.timeOverrides;
    const timeTiersCandidate = timeOv && timeOv.length > 0
      ? overridesToPriceTiers(timeOv, rIn.value ?? 0, rOut.value ?? 0)
      : undefined;
    const contextTiers = upstream?.pricing?.contextTiers;
    const perRequest = upstream?.pricing?.perRequest;

    
    const vision = upstream?.architecture?.input_modalities
      ? upstream.architecture.input_modalities.some((m) => m.includes("image"))
      : (typeof m.vision === "boolean" ? m.vision
        : (inferModelDefaults(m.id).vision ?? false));

    
    
    const maxOutUpstream = upstream?.max_output;
    const maxOutput = maxOutUpstream && maxOutUpstream > 0 ? maxOutUpstream
      : (typeof m.max_output === "number" ? m.max_output
        : (inferModelDefaults(m.id).max_output ?? undefined));

    
    
    
    const upstreamReasoning = upstream?.reasoning;
    const inferredThinking = inferThinkingSupport(m.id);
    const upstreamHasEfforts =
      Array.isArray(upstreamReasoning?.supported_efforts) && upstreamReasoning!.supported_efforts.length > 0;
    const upstreamDeclared =
      upstreamReasoning !== undefined
      && (upstreamReasoning.mandatory !== undefined || Array.isArray(upstreamReasoning.supported_efforts));
    
    const thinkingSupported = upstreamDeclared
      ? (upstreamReasoning!.mandatory === true || upstreamHasEfforts)
      : (typeof m.thinking === "boolean" ? m.thinking : inferredThinking.supported);
    
    let thinkingEfforts: string[] | undefined;
    if (upstreamHasEfforts) {
      const upstreamEfforts = upstreamReasoning!.supported_efforts!;
      const seen = new Set<string>();
      for (const e of upstreamEfforts) {
        if (typeof e === "string" && e && !seen.has(e)) { seen.add(e); }
      }
      const filteredUpstream = Array.from(seen);
      thinkingEfforts = filteredUpstream.length > 0 ? sortEfforts(filteredUpstream) : inferredThinking.efforts;
    } else {
      thinkingEfforts = inferredThinking.efforts;
    }

    
    
    const cap = inferModelCapabilities(m.id);
    const modelEndpoint: ApiFormat = isAggregatorGateway(baseUrl)
      ? "openai"
      : (cap.endpoint && cap.endpoint !== "openai" ? cap.endpoint : effectiveFormat);

    return {
      ...m,
      id: m.id,
      context_window: ctxWindow,
      max_output: maxOutput,
      vision,
      thinking: thinkingSupported,
      thinking_efforts: thinkingEfforts,
      price_in_usd: rIn.value,
      price_out_usd: rOut.value,
      price_cache_read_usd: rCacheRead.value,
      price_cache_write_usd: rCacheWrite.value,
      price_source: rIn.source,
      pricing_tiered: pricingTiered === true,
      pricing_formula: pricingFormula,
      pricing_mode: pricingMode,
      
      pricing_time_tiers_candidate: timeTiersCandidate ?? m.pricing_time_tiers_candidate,
      pricing_context_tiers: contextTiers ?? m.pricing_context_tiers,
      pricing_per_request: perRequest ?? m.pricing_per_request,
      selected: m.selected !== false,
      api_format: modelEndpoint,
    };
  });

  return { ok: true, models, api_format: effectiveFormat };
}








export async function detectApiFormat(baseUrl: string, apiKey: string): Promise<ApiFormat> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return "auto"; }
  
  if (/generativelanguage\.googleapis\.com|googleapis\.com/i.test(base)) { return "google"; }
  const urls = [`${base}/v1/models`, `${base}/models`];
  
  const headerSets: Array<{ openai: boolean; headers: Record<string, string> }> = [
    { openai: true, headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" } },
    { openai: false, headers: { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", Accept: "application/json" } },
  ];
  for (const { openai, headers } of headerSets) {
    for (const url of urls) {
      try {
        const res = await chromiumFetch(url, { headers: identityHeaders(headers), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) { return openai ? "openai" : "anthropic"; }
      } catch {  }
    }
  }
  return "auto";
}









export async function probeProvider(baseUrl: string, apiKey: string): Promise<{
  ok: boolean;
  result?: ProbeResult;
  error?: string;
}> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return { ok: false, error: "Base URL / API Key 不能为空" }; }

  const key = apiKey.trim();
  
  const headerSets: Array<{ auth: ProbeObservation["auth"]; headers: Record<string, string> }> = [
    { auth: "bearer", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    { auth: "x-api-key", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", Accept: "application/json" } },
    { auth: "x-goog-api-key", headers: { "x-goog-api-key": key, Accept: "application/json" } },
  ];
  
  const endpoints: string[] = [
    `${base}/v1/models`,
    `${base}/models`,
    `${base}/api/v1/models`,
    `${base}/v1beta/models`,
  ];

  
  let observed: ProbeObservation | null = null;
  let pricingSeen = false;
  for (const hs of headerSets) {
    for (const url of endpoints) {
      const t0 = Date.now();
      try {
        const res = await chromiumFetch(url, { headers: identityHeaders(hs.headers), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) { continue; }
        const body = (await res.json()) as Record<string, unknown>;
        const items = (Array.isArray(body.data) ? body.data
          : Array.isArray(body.models) ? body.models
          : Array.isArray(body.model_list) ? body.model_list
          : Array.isArray(body) ? body
          : null) as Array<Record<string, unknown>> | null;
        if (items === null || items.length === 0) { continue; }
        observed = {
          endpoint: url,
          auth: hs.auth,
          modelItems: items,
          modelCount: items.length,
          latencyMs: Date.now() - t0,
          hasPricing: pricingSeen,
        };
        break;
      } catch {  }
    }
    if (observed) { break; }
  }

  
  try {
    const pres = await chromiumFetch(`${base}/api/pricing`, {
      headers: identityHeaders(headerSets[0].headers),
      signal: AbortSignal.timeout(5000),
    });
    pricingSeen = pres.ok;
    if (observed) { observed.hasPricing = pricingSeen; }
  } catch {  }

  if (!observed) {
    
    const fallback: ProbeObservation = { endpoint: base, auth: "none", modelCount: 0 };
    const result = probe(fallback, base);
    return { ok: true, result };
  }
  const result = probe(observed, base);
  return { ok: true, result };
}


export async function fetchModels(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }> {
  if (typeof baseUrl !== "string" || !normalizeBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL 不能为空" };
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "API Key 不能为空" };
  }
  
  
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  const candidates: string[] = [];
  
  if (format === "openai" || format === "responses" || format === "auto") {
    candidates.push(`${base}/v1/models`);
    candidates.push(`${base}/models`);
    candidates.push(`${base}/api/v1/models`);
  }
  if (format === "anthropic" || format === "auto") {
    
    candidates.push(`${base}/v1/models`);
    candidates.push(`${base}/models`);
  }
  if (format === "google") {
    
    candidates.push(`${base}/v1beta/models`);
  }
  
  const uniq = Array.from(new Set(candidates));
  const attempts: string[] = [];
  for (const cand of uniq) {
    try {
      const models = await tryFetchModels(cand, apiKey.trim(), format);
      return { ok: true, models };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push(`${cand} → ${msg}`);
      
      
      
      if (/^HTTP (401|403)\b/.test(msg)) { break; }
    }
  }
  return { ok: false, error: `模型列表获取失败：${attempts.slice(0, 4).join("；")}` };
}

export interface SaveProviderInput {
  key: string;
  api_base: string;
  
  api_key?: string;
  model?: string | null;
  
  api_format?: ApiFormat;
  
  models?: unknown[];
  



  rpm?: number | null;
}

export interface SaveProviderResult {
  ok: boolean;
  error?: string;
  
  path?: string;
  size?: number;
}

export async function saveProvider(input: SaveProviderInput): Promise<SaveProviderResult> {
  const key = (input.key ?? "").trim();
  if (!KEY_RE.test(key)) {
    return { ok: false, error: "Provider 名称仅限字母/数字/_/-（1-64 字符），且将作为 api:<名称> 使用" };
  }
  const base = normalizeBaseUrl(input.api_base);
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: "Base URL 必须以 http(s):// 开头" };
  }
  if (base.length > MAX_BASE_URL) {
    return { ok: false, error: "Base URL 过长" };
  }
  if (input.api_key !== undefined && (typeof input.api_key !== "string" || !input.api_key.trim())) {
    return { ok: false, error: "API Key 不能为空" };
  }
  if (input.api_key !== undefined && input.api_key.length > MAX_KEY_LEN) {
    return { ok: false, error: "API Key 过长" };
  }

  const table = loadTable();
  const prev = table[key] ?? {};
  let models = input.models !== undefined ? sanitizeModels(input.models) : sanitizeModels(prev.models);
  
  let detectedFormat: ApiFormat | undefined;
  
  if (models === undefined && input.api_key !== undefined && base && input.api_key.trim()) {
    const enriched = await enrichModels(base, input.api_key.trim(), input.api_format ?? "auto");
    if (enriched.ok && enriched.models) {
      detectedFormat = enriched.api_format && enriched.api_format !== "auto" ? enriched.api_format : undefined;
      
      const prevModels = sanitizeModels(prev.models) ?? [];
      models = enriched.models.map((m) => {
        const prev = prevModels.find((p) => p.id === m.id);
            return prev
          ? {
              ...m,
              
              
              context_window: m.context_window && m.context_window > 0 ? m.context_window : prev.context_window,
              max_output: m.max_output && m.max_output > 0 ? m.max_output : prev.max_output,
              selected: prev.selected, vision: prev.vision,
              
              
              rpm: prev.rpm,
              
              ...mergeModelPrice(prev, m),
            }
          : m;
      });
    }
  }
  
  
  
  
  let nextRpm: number | undefined;
  if (input.rpm === undefined) {
    nextRpm = typeof prev.rpm === "number" && Number.isFinite(prev.rpm) && prev.rpm >= 1 ? Math.floor(prev.rpm) : undefined;
  } else if (input.rpm === null) {
    nextRpm = undefined;
  } else {
    nextRpm = typeof input.rpm === "number" && Number.isFinite(input.rpm) && input.rpm >= 1 ? Math.floor(input.rpm) : undefined;
  }
  table[key] = {
    api_base: base,
    api_key: input.api_key !== undefined ? input.api_key.trim() : (prev.api_key ?? ""),
    model: input.model !== undefined && input.model !== null ? input.model : (prev.model ?? undefined),
    api_format: input.api_format !== undefined ? input.api_format : (detectedFormat ?? prev.api_format ?? "auto"),
    models,
    ...(nextRpm !== undefined ? { rpm: nextRpm } : {}),
  };
  try {
    const encoded = encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true, path: resolveConfigPathForReport(), size: encoded.length };
  } catch (e) {
    return { ok: false, error: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  }
}


export interface RefreshProviderResult {
  ok: boolean;
  total?: number;
  added?: number;
  removed?: number;
  error?: string;
}








export async function refreshProviderModels(key: string): Promise<RefreshProviderResult> {
  const k = (key ?? "").trim();
  const table = loadTable();
  const rec = table[k];
  if (!rec) {
    return { ok: false, error: `供应商「${k}」不存在` };
  }
  const apiKey = rec.api_key ?? "";
  if (!apiKey.trim()) {
    return { ok: false, error: `供应商「${k}」未配置 API Key，无法刷新（请先在编辑中填写）` };
  }
  const enriched = await enrichModels(rec.api_base, apiKey, rec.api_format ?? "auto");
  if (!enriched.ok || !enriched.models) {
    return { ok: false, error: enriched.error };
  }
  const prevModels = sanitizeModels(rec.models) ?? [];
  const prevSelected = new Set(prevModels.filter((m) => m.selected !== false).map((m) => m.id));
  const seen = new Set<string>();
  const nextModels = enriched.models.map((m) => {
    seen.add(m.id);
    const prev = prevModels.find((p) => p.id === m.id);
    
    
    
    
    
    
    return { ...m, selected: prevSelected.has(m.id), rpm: prev?.rpm, ...(prev ? mergeModelPrice(prev, m) : {}) };
  });
  const added = nextModels.filter((m) => !prevModels.some((p) => p.id === m.id)).length;
  const removed = prevModels.filter((p) => !seen.has(p.id)).length;
  
  const nextFormat: ApiFormat = enriched.api_format && enriched.api_format !== "auto"
    ? enriched.api_format
    : (rec.api_format ?? "auto");
  table[k] = { ...rec, models: nextModels, api_format: nextFormat };
  try {
    encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true, total: nextModels.length, added, removed };
  } catch (e) {
    return { ok: false, error: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  }
}


function resolveConfigPathForReport(): string {
  return join(
    rootOverride ?? PROJECT_ROOT,
    "config",
    "providers.enc.json",
  );
}

export function removeProvider(key: string): { ok: boolean; error?: string } {
  const table = loadTable();
  if (!(key in table)) {
    return { ok: true }; 
  }
  delete table[key];
  try {
    encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `删除失败：${e instanceof Error ? e.message : String(e)}` };
  }
}


export function clearAllProviders(): { ok: boolean; error?: string } {
  try {
    encrypt({}, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `清空失败：${e instanceof Error ? e.message : String(e)}` };
  }
}



const GGUF_EXTS = [".gguf", ".ggml"];




export function listLocalModels(): LocalModelSpec[] {
  return localModelSpecs(loadTable());
}

function persistTable(table: ProvidersTable): { ok: boolean; error?: string } {
  try {
    encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}


/** A-1201：本地模型 id 的合法字符 —— **比 API 供应商宽松一档：允许小数点**。
 *  为什么必须放宽：模型文件的天然名字带小数点（`qwen3-1.7b-q8_0.gguf`），
 *  用户照抄文件名就会撞上旧校验 `KEY_RE`（不含 `.`）⇒ 直接被拒。
 *  实测证据：`qwen3-1.7b` / `qwen3.1.7b` 在旧规则下均返回「名称仅限字母/数字/中文/_/-」，
 *  而 `qwen3-17b`（去点）才通过 —— 用户侧表现就是"加不进模型"（记档：`_local_models` 为空）。
 *  为什么 API 供应商那边不放宽：那些 key 参与 `api:<key>:<model>` 的**冒号分段解析**，
 *  字符集收紧是有原因的；本地模型走 `local:<id>` 整体取值，没有这个约束。 */
const LOCAL_MODEL_ID_RE = /^[a-zA-Z0-9_.\-\u4e00-\u9fa5]{1,64}$/;

function validateLocalId(id: string, table: ProvidersTable): string | null {
  if (!LOCAL_MODEL_ID_RE.test(id)) {
    return "本地模型名称仅限字母/数字/中文/_/-/.（1-64 字符）";
  }
  if (id in table && id !== LOCAL_MODELS_KEY) {
    return `「${id}」已被 API 供应商占用`;
  }
  return null;
}

export function saveLocalModel(input: { id: string; path: string; label?: string; ctx_len?: number; gpu_layers?: number; max_output?: number; vision?: boolean; thinking?: string }): { ok: boolean; error?: string } {
  const id = (input.id ?? "").trim();
  const path = (input.path ?? "").trim();
  const table = loadTable();
  const err = validateLocalId(id, table);
  if (err) { return { ok: false, error: err }; }
  if (!isAbsolute(path)) {
    return { ok: false, error: "模型路径必须为绝对路径（Windows 如 D:\\models\\qwen.gguf；Linux 如 /home/user/models/qwen.gguf）" };
  }
  if (!existsSync(path)) {
    return { ok: false, error: `模型文件不存在：${path}` };
  }
  const existing = localModelSpecs(table);
  const next: LocalModelSpec[] = [
    ...existing.filter((m) => m.id !== id),
    {
      id,
      path,
      label: (input.label ?? "").trim() || id,
      ctx_len: typeof input.ctx_len === "number" && input.ctx_len > 0 ? Math.floor(input.ctx_len) : undefined,
      gpu_layers: typeof input.gpu_layers === "number" && input.gpu_layers >= 0 ? Math.floor(input.gpu_layers) : undefined,
      max_output: typeof input.max_output === "number" && input.max_output > 0 ? Math.floor(input.max_output) : undefined,
      vision: input.vision === true,
      /* A-1201：思考模式。归一后落盘 ⇒ 脏值不会写进配置（读侧还会再归一次）。 */
      thinking: normalizeThinkingMode(input.thinking),
    },
  ];
  (table as unknown as Record<string, unknown>)[LOCAL_MODELS_KEY] = next;
  return persistTable(table);
}

export function removeLocalModel(id: string): { ok: boolean; error?: string } {
  const table = loadTable();
  const next = localModelSpecs(table).filter((m) => m.id !== id);
  if (next.length === localModelSpecs(table).length) {
    return { ok: true };
  }
  (table as unknown as Record<string, unknown>)[LOCAL_MODELS_KEY] = next;
  return persistTable(table);
}


export function scanLocalModels(dir: string): { ok: boolean; models?: Array<{ path: string; label: string }>; error?: string } {
  if (typeof dir !== "string" || !dir.trim()) {
    return { ok: false, error: "目录不能为空" };
  }
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const models = entries
      .filter((e) => e.isFile() && GGUF_EXTS.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .map((e) => ({ path: join(dir, e.name), label: e.name }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: `目录读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}