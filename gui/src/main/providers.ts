/**
 * gui/src/main/providers.ts — Provider 管理（加密存储 + 模型探测）。
 * - 读写 config/providers.enc.json（与 Python core/encryption.py 双向兼容）
 * - 渲染层永不接触明文 api_key：list 只回脱敏摘要；fetch/save 由主进程执行
 * - fetchModels：OpenAI 兼容 {base}/models 探测（自动尝试 /v1 变体）
 */
import { decrypt, encrypt, PROJECT_ROOT } from "../../../core-ts/src/encryption.js";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Agent as HttpKeepAliveAgent } from "node:http";
import { Agent as HttpsKeepAliveAgent } from "node:https";

/** API 端点格式：OpenAI Chat Completions / Anthropic Messages / 自动检测 */
export type ApiFormat = "openai" | "anthropic" | "auto";

export interface ModelSpec {
  id: string;
  /** 上下文窗口（token） */
  context_window?: number;
  /** 最大输出（token） */
  max_output?: number;
  /** 是否支持图片输入 */
  vision?: boolean;
  /** 是否支持 thinking/reasoning 模式 */
  thinking?: boolean;
  /** thinking effort levels（如 ["low","medium","high"]） */
  thinking_efforts?: string[];
  /** 是否启用（聊天模型选择只列出启用项；旧记录无此字段视为启用） */
  selected?: boolean;
  /** 输入单价 USD/百万 token */
  price_in_usd?: number;
  /** 输出单价 USD/百万 token */
  price_out_usd?: number;
}

export interface ProviderRecord {
  api_base: string;
  api_key: string;
  /** 默认模型（agent model_choice=api:<key> 时使用） */
  model?: string;
  /** API 端点格式：openai=/v1/chat/completions, anthropic=/v1/messages, auto=自动检测 */
  api_format?: ApiFormat;
  /** 模型明细（扩展字段，engine 不读，供 UI 调试/展示） */
  models?: ModelSpec[];
  [key: string]: unknown;
}

export type ProvidersTable = Record<string, ProviderRecord>;

/** 渲染层可见的脱敏摘要（不含明文 key） */
export interface ProviderSummary {
  key: string;
  api_base: string;
  has_key: boolean;
  key_hint: string;
  model: string | null;
  api_format: ApiFormat;
  models: ModelSpec[];
}

/** 本地模型注册项（存 providers.enc.json 的 _local_models 特殊键） */
export interface LocalModelSpec {
  id: string;
  /** 模型文件绝对路径（.gguf） */
  path: string;
  label: string;
  /** 上下文长度（llama.cpp ctx_len） */
  ctx_len?: number;
  /** GPU 层数 */
  gpu_layers?: number;
  max_output?: number;
  vision?: boolean;
}

const LOCAL_MODELS_KEY = "_local_models";

const KEY_RE = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64}$/;
const MAX_MODELS = 200;
const MAX_MODEL_ID = 256;
const MAX_KEY_LEN = 512;
const MAX_BASE_URL = 2048;
const FETCH_TIMEOUT_MS = 15000;

/** 共享 keep-alive agent（A-156）：复用 TLS 连接，省去每次请求重新握手（约 100-200ms），
 *  并显著降低「每请求新建连接」在长流/高频探测场景下的连接中止率。 */
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

/** 惰性获取 Electron net 模块（A-156）：仅当运行在真实 Electron 主进程且 app 已 ready 时可用。
 *  Chromium 网络栈 = 浏览器 TLS 指纹（Cloudflare 不误拦）+ 自动系统代理/PAC（WinINET，
 *  根治中国大陆经 Clash/v2rayN 访问 OpenAI/Claude/DeepSeek 需代理的场景）+ 连接池。
 *  vitest / 非 Electron 环境返回 null，自动降级 Node https 路径（行为不变）。 */
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

/** 测试专用根覆盖（vitest 隔离；生产路径不受影响） */
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
      // 上游可能误存了 "<provider_key>::/<id>" 或 "<provider_key>:<id>" 全限定格式，
      // 导致下拉显示重复拼接。这里兜底剥离所有常见前缀形式，只保留真实模型 ID。
      let id = String((rawM as ModelSpec).id).slice(0, MAX_MODEL_ID);
      // 反复尝试 ::/ 和单冒号前缀（最多 2 轮，防嵌套脏数据），前缀字符集与 KEY_RE 一致
      for (let i = 0; i < 2; i++) {
        const m1 = id.match(/^([a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64})::\/(.+)$/);
        if (m1) { id = m1[2]; continue; }
        const m2 = id.match(/^([a-zA-Z0-9_\-\u4e00-\u9fa5]{1,64}):(.+)$/);
        if (m2) { id = m2[2]; continue; }
        break;
      }
      // 双重重复后缀（"公益模型公益模型" → 存储时 bug 的双写）
      if (id.length > 4 && id.length % 2 === 0) {
        const half = id.length / 2;
        if (id.slice(0, half) === id.slice(half)) id = id.slice(0, half);
      }
      return {
        id,
        context_window: typeof (rawM as any).context_window === "number" && (rawM as any).context_window > 0 ? Math.floor((rawM as any).context_window) : undefined,
        max_output: typeof (rawM as any).max_output === "number" && (rawM as any).max_output > 0 ? Math.floor((rawM as any).max_output) : undefined,
        vision: (rawM as any).vision === true,
        // 思考/推理能力（上游返回或推断）必须透传给渲染层，用于动态渲染推理等级与思考开关
        thinking: (rawM as any).thinking === true,
        thinking_efforts: Array.isArray((rawM as any).thinking_efforts)
          ? ((rawM as any).thinking_efforts as string[]).filter((e: unknown) => typeof e === "string" && e) : undefined,
        price_in_usd: typeof (rawM as any).price_in_usd === "number" ? (rawM as any).price_in_usd : undefined,
        price_out_usd: typeof (rawM as any).price_out_usd === "number" ? (rawM as any).price_out_usd : undefined,
        // 旧记录没有 selected 字段 → 视为启用（历史行为：保存的都是启用模型）
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
    }));
}

function normalizeBaseUrl(base: string): string {
  // 去掉末尾斜杠；如果末尾是 /v1（不管前面还有什么路径），去掉它——
  // 因为后续拼接层会统一加 /v1/models、/v1/messages，保留末尾 /v1 会导致双 v1
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/, "");
}

/**
 * 用 Node https/http 发请求（Schannel TLS，Windows 原生，Cloudflare 不误拦）。
 * 修复：此前的转发器把请求方法硬编码为 GET、抛弃 body、且不提供可读流 body——
 * 导致被当作 fetchImpl 的 POST 聊天请求全部变成 GET /v1/chat/completions → 上游 404
 * （Invalid URL (GET /v1/chat/completions)），流式 SSE 也因无 body 而"上游无响应体"。
 * 现在尊重 init.method / init.body / init.signal，并把 node IncomingMessage 包装成
 * 带 web ReadableStream 的 fetch-like Response，聊天 POST 与流式读取才能真正工作。
 */
/**
 * 系统代理解析（A-155）：DeepSeek/OpenAI/Claude 等海外 API 在中国大陆需经代理才可达。
 * Node 的 https.request 默认【忽略系统代理】（需显式 Agent）——这正是"deepseek 接不上"
 * 的关键盲区（Electron 官方文档证实：Node 栈不走 WinINET 代理，Chromium net 栈才会）。
 * 优先级：环境变量 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY > Windows 注册表 WinINET 代理。
 * 返回 null 表示无代理可用（直连）。
 */
function resolveSystemProxy(targetUrl: string): string | null {
  const env = process.env;
  const isHttps = targetUrl.toLowerCase().startsWith("https:");
  const fromEnv = (isHttps ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy) || env.ALL_PROXY || env.all_proxy;
  if (fromEnv && /^https?:\/\//i.test(fromEnv.trim())) {
    return fromEnv.trim().replace(/\/+$/, "");
  }
  // Windows 注册表 WinINET 代理（Clash/v2rayN 等常写这里但不开系统代理）
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
    // 形如 "127.0.0.1:7890" 或 "http=127.0.0.1:7890;https=127.0.0.1:7890"
    const schemeOf = (targetUrl.toLowerCase().startsWith("https:") ? "https" : "http");
    const perScheme = raw.match(new RegExp(`${schemeOf}=([^;\\s]+)`));
    const hostPort = perScheme?.[1] ?? (raw.includes("=") ? (raw.match(/https=([^;\\s]+)/)?.[1]) : raw);
    if (hostPort && !/^(https?|socks)\/\/|^[a-z]+=/i.test(hostPort)) {
      return `http://${hostPort}`;
    }
    if (/^https?:\/\//i.test(hostPort ?? "")) { return hostPort; }
  } catch { /* 读取失败 → 直连 */ }
  return null;
}

/**
 * 通过 HTTP 代理发起请求（A-155）：正确实现 HTTP(S) CONNECT 隧道。
 * - https 目标：向代理发 CONNECT 建立 TLS 隧道（node 不会自动做，需手工 CONNECT）；
 * - http 目标：代理直接转发，path 为完整 URL、Host 头指向目标。
 * 仅用于「直连失败后」的 fallback，避免代理无效时反向伤害国内可达服务。
 * 无法在无代理环境实测 → 保守：所有异常静默降级回直连（不抛出）。
 */
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
      const cleanupSig = () => { if (signal) { try { signal.removeEventListener("abort", onAbort); } catch {} } };
      const onAbort = () => { cleanupSig(); };
      const doHttp = () => {
        // http 目标：代理转发（Host 头指向目标，path 为完整 URL）
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
        // https 目标：先向代理发 CONNECT 建隧道
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
      // fetch 语义：显式补 Content-Length（客户端只设 Content-Type，node 缺省走 chunked，
      // 部分网关对 chunked POST 支持不稳）
      if (bodyStr != null && headers["content-length"] == null) {
        headers["content-length"] = String(Buffer.byteLength(bodyStr));
      }

      // 调用方自带 AbortSignal（ChatClient 按 timeoutMs / 停止按钮 abort）时放弃
      // node 层 socket 超时，避免长思考/停顿的流被 15s 空闲误截断。
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
        // 实时流式 + 规避流锁定（双通道）：
        //  - body：真实 ReadableStream，data 每到达一包就 enqueue，供 chatStream 的
        //    resp.body.getReader() 边收边解析 —— 保持实时逐 chunk 输出，不缓冲整包。
        //  - text()/json()：从独立 chunks 缓冲读取（end 后 concat），错误处理路径不碰
        //    实时流，从而避免 "ReadableStream is locked"。
        // 流在请求回调内预创建、data 监听无条件注册（无论是否有消费者），保证哪怕
        // 只调 json() 的探测路径 end 也一定触发、不会因 paused 而挂起。
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
          try { controllerRef?.enqueue(buf); } catch { /* 流已取消 */ }
        });
        res.on("end", () => {
          onEnded();
          try { controllerRef?.close(); } catch { /* 已关闭 */ }
        });
        res.on("error", (e: Error) => {
          onEnded();
          try { controllerRef?.error(e); } catch { /* 已结束 */ }
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

/** Electron 主进程网络请求，传输优先级（A-156）：
 * 1. HTTPS → Electron net.fetch（Chromium 栈：浏览器 TLS 指纹 + 自动系统代理/PAC + 连接池），
 *    这是海外 API（OpenAI/Claude/DeepSeek）在中国大陆经 Clash/v2rayN 场景下的根治通道；
 * 2. 降级 Node https.request（Schannel TLS，直接也通 Cloudflare）——带 keep-alive agent，
 *    A-152 稳定性：TLS 握手/连接级瞬时失败先原地重试（短退避），再 fallback；直连全败后
 *    尝试系统代理（resolveSystemProxy + CONNECT 隧道）；
 * 3. 最后降级全局 fetch（undici）——仅在非 http(s) 或以上全失败时兜底。
 *
 * 注：HTTP（本地模型服务 / loopback）不走 net.fetch——避免系统代理误劫本地流量。 */
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = [250, 600, 1200];

export async function chromiumFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const urlString = String(url);
  if (urlString.startsWith("http://") || urlString.startsWith("https://")) {
    // HTTPS 优先 Chromium 网络栈（真实 Electron 主进程 + app ready）：
    // 浏览器 TLS/IP 指纹 + 自动系统代理与 PAC + Chromium 连接管理。瞬时错误交给上层
    // （CallClient fetchWithRetry / 探测重试）统一处理，这里不做二次重试再降级，避免双重重试。
    if (urlString.startsWith("https://")) {
      const net = electronNet();
      if (net) {
        try {
          return await net.fetch(urlString, init);
        } catch (e) {
          // 用户主动取消（停止按钮 / AbortSignal.timeout）必须原样上抛，
          // 不能降级到 https.request 把「取消」变成「重试 3 次后失败」。
          if (e instanceof Error && e.name === "AbortError") { throw e; }
          console.warn(`[chromiumFetch] net.fetch 失败（降级 https.request）：${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
        }
      }
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < FETCH_RETRY_ATTEMPTS; attempt++) {
      try {
        return await httpRequest(urlString, init, FETCH_TIMEOUT_MS);
      } catch (e) {
        lastErr = e;
        if (attempt < FETCH_RETRY_ATTEMPTS - 1) {
          // 指数退避后原地重试（瞬时 TLS/连接错误绝大多数在第二次成功）
          const delay = FETCH_RETRY_DELAY_MS[attempt] ?? 800;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    // A-155 代理 fallback：直连（3 次）全部失败后，若本机配置了系统代理（海外 API 如
    // DeepSeek/OpenAI/Claude 在大陆需代理），下一次尝试经代理走 CONNECT 隧道。
    // 代理不可用也静默降级，不影响直连可达的服务（agnes/国内中转直连即通）。
    const proxy = resolveSystemProxy(urlString);
    if (proxy) {
      try {
        console.info(`[chromiumFetch] 直连失败，尝试经系统代理 ${proxy} 访问 ${urlString.slice(0, 60)}`);
        return await httpRequestViaProxy(urlString, proxy, init, Math.max(FETCH_TIMEOUT_MS, 20000));
      } catch (e) {
        lastErr = e;
        console.warn(`[chromiumFetch] 代理路径失败：${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
      }
    }
    console.warn(`[chromiumFetch] https.request failed after ${FETCH_RETRY_ATTEMPTS} attempts for ${urlString.slice(0, 60)}: ${String(lastErr)} — falling back to global fetch`);
  }
  return fetch(url, init);
}

async function tryFetchModels(url: string, apiKey: string, format: ApiFormat): Promise<ModelSpec[]> {
  // Anthropic 官方/网关用 x-api-key + anthropic-version（Bearer 会被 401）；OpenAI 兼容用 Bearer。
  const isAnthropic = format === "anthropic";
  const headers: Record<string, string> = isAnthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" }
    : { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const res = await chromiumFetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();

  // 模型列表的常见形态（全网枚举，A-156 覆盖面扩展）：
  // - OpenAI/OpenRouter/one-api 系：{ data: [...] }
  // - Anthropic：{ data: [...] }（真实 /v1/models）或 { models: { id: details } } / { models: [...] }
  // - 部分自建网关：{ model_list: [...] } 或顶层裸数组
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

  if (!items || items.length === 0) {
    throw new Error("响应结构无法解析模型列表");
  }

  const ids = items
    .filter((m): m is { id: unknown } => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string")
    .map((m) => m.id as string)
    .filter(Boolean)
    .slice(0, MAX_MODELS);
  if (ids.length === 0) {
    throw new Error("响应中无有效模型 id");
  }
  return ids.map((id) => ({ id }));
}

/**
 * 智能模型元数据推断：根据模型 ID 命名规律 + 供应商 base_url 自动填充
 * context_window / price_in_usd / price_out_usd / vision / max_output。
 *
 * 策略优先级：
 * 1. 上游 /models 完整元数据（OpenRouter 等中转站格式，含 context_length/pricing/reasoning）
 * 2. 模型 ID 命名规律启发式推断（覆盖 OpenAI/Anthropic/DeepSeek/Gemini/本地模型等）
 * 3. 用户手动填写（在 saveProvider 中合并）
 */

/** 从上游拉取完整模型元数据（OpenRouter 格式和常见变体） */
async function fetchUpstreamDetails(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<Map<string, {
  context_length?: number;
  max_output?: number;
  pricing?: { prompt?: string; completion?: string };
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] };
  architecture?: { input_modalities?: string[] };
}>> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return new Map(); }
  const isAnthropic = format === "anthropic";
  const headers: Record<string, string> = isAnthropic
    ? { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", Accept: "application/json" }
    : { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };
  // 尝试多种可能的端点路径
  const candidates = [
    `${base}/models`,
    `${base}/v1/models`,
    `${base}/api/v1/models`,
    `${base}/openapi.json`, // 部分平台用 OpenAPI spec 描述模型
  ];
  for (const url of candidates) {
    try {
      const res = await chromiumFetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) { continue; }
      const body = await res.json() as { data?: Array<Record<string, unknown>> };
      if (!Array.isArray(body?.data)) { continue; }
      return new Map(body.data.map((d) => {
        // 上游 max_output 常见字段：max_completion_tokens（OpenRouter/自建）或
        // top_provider.max_completion_tokens；部分平台用 output_tokens / max_output_tokens
        const rawMax = (d as any).max_completion_tokens
          ?? (d as any).top_provider?.max_completion_tokens
          ?? (d as any).max_output_tokens
          ?? (d as any).max_tokens;
        return [
          String(d.id ?? ""),
          {
            context_length: typeof d.context_length === "number" ? d.context_length : undefined,
            max_output: typeof rawMax === "number" && rawMax > 0 ? Math.floor(rawMax) : undefined,
            pricing: d.pricing && typeof d.pricing === "object"
              ? { prompt: String((d.pricing as any).prompt ?? ""), completion: String((d.pricing as any).completion ?? "") }
              : undefined,
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
        ];
      }));
    } catch { /* 下一个候选 */ }
  }
  return new Map();
}

/** 基于模型 ID 命名规律推断默认元数据（覆盖 OpenAI/Anthropic/DeepSeek/Gemini/自建等所有场景） */
function inferModelDefaults(modelId: string): Partial<ModelSpec> {
  const id = modelId.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");

  // ── 上下文长度推断 ──
  let context_window: number | undefined;
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
  else if (/doubao|ep-/.test(id)) { context_window = 131072; } // 字节豆包
  else if (/step[-_]?l?2?[-_]/.test(id)) { context_window = 131072; } // 阶跃星辰
  else if (/agnes[-_]/.test(id)) { context_window = 524288; } // Agnes: 512K
  else if (/seedance|seed[-_]/.test(id)) { context_window = 131072; } // Seedance
  else if (/sonic[-_]|ep-.*sonic/.test(id)) { context_window = 131072; } // 字节 Sonic
  else if (/flux[-_]/.test(id)) { context_window = 4096; } // FLUX 图像生成

  // ── 视觉支持推断（扩展模型覆盖面）──
  const hasVision = /vision|vl|iv|image|gpt[-_]4o[-_]image|claude[-_][^-]*op?us[-_]|gemini[-_].*flash|agnes[-_].*flash|doubao[-_].*vision|glm[-_].*vision/.test(id);

  // ── 最大输出推断（扩展模型覆盖面）──
  let max_output: number | undefined;
  if (/o1[-_]/.test(id) || /o3[-_]/.test(id)) { max_output = 100000; }
  else if (/claude[-_]/.test(id)) { max_output = 8192; }
  else if (/gpt[-_]/.test(id)) { max_output = 16384; }
  else if (/deepseek[-_]/.test(id)) { max_output = 8192; }
  else if (/agnes[-_]/.test(id)) { max_output = 65536; } // Agnes: 65.5K
  else if (/gemini[-_]/.test(id)) { max_output = 8192; }

  return { context_window, vision: hasVision, max_output };
}

/** 基于供应商 base_url + 模型 ID 推断定价（覆盖主流平台和自建中转） */
function inferPricingFromUrl(baseUrl: string, modelId: string): { price_in_usd?: number; price_out_usd?: number } {
  const base = (baseUrl ?? "").toLowerCase();
  const id = modelId.toLowerCase();

  // ── Agnes AI（中国，CNY）──
  if (base.includes("agnes") || base.includes("agnes-ai")) {
    return { price_in_usd: 0, price_out_usd: 0 }; // 当前免费
  }

  // ── DeepSeek（中国，CNY）──
  if (base.includes("deepseek")) {
    if (/chat/.test(id)) { return { price_in_usd: 0.14 / 7.25, price_out_usd: 0.28 / 7.25 }; }
    if (/reasoner/.test(id)) { return { price_in_usd: 0.27 / 7.25, price_out_usd: 1.1 / 7.25 }; }
    if (/v4/.test(id)) { return { price_in_usd: 0.14 / 7.25, price_out_usd: 0.28 / 7.25 }; }
  }

  // ── Moonshot / Kimi（中国，CNY）──
  if (base.includes("moonshot") || base.includes("kimi")) {
    return { price_in_usd: 0.06 / 7.25, price_out_usd: 0.17 / 7.25 };
  }

  // ── SiliconFlow / 硅基流动（中国，CNY）──
  if (base.includes("siliconflow") || base.includes("硅基")) {
    // 按模型自定义定价（不同模型价格不同），这里返回 0 让用户手动设置
    return { price_in_usd: 0, price_out_usd: 0 };
  }

  // ── Groq（美国，USD）──
  if (base.includes("groq")) {
    if (/llama[-_]/.test(id)) { return { price_in_usd: 0.20 / 7.25, price_out_usd: 0.80 / 7.25 }; }
    if (/mixtral/.test(id)) { return { price_in_usd: 0.25 / 7.25, price_out_usd: 1.0 / 7.25 }; }
    if (/deepseek/.test(id)) { return { price_in_usd: 0.14 / 7.25, price_out_usd: 0.28 / 7.25 }; }
    if (/whisper/.test(id)) { return { price_in_usd: 0, price_out_usd: 0 }; } // 音频按秒计费
  }

  // ── Together AI（美国，USD）──
  if (base.includes("together")) {
    if (/llama[-_]/.test(id)) { return { price_in_usd: 0.20 / 7.25, price_out_usd: 0.80 / 7.25 }; }
  }

  // ── OpenAI 官方（美国，USD）──
  if (base.includes("openai.com") || base.includes("api.openai")) {
    if (/gpt[-_]4o[-_]/.test(id)) { return { price_in_usd: 2.50, price_out_usd: 10.0 }; }
    if (/gpt[-_]4o[-_]mini/.test(id)) { return { price_in_usd: 0.15, price_out_usd: 0.60 }; }
    if (/gpt[-_]4[-_]turbo/.test(id)) { return { price_in_usd: 10.0, price_out_usd: 30.0 }; }
    if (/o1[-_]/.test(id)) { return { price_in_usd: 15.0, price_out_usd: 60.0 }; }
    if (/o3[-_]/.test(id)) { return { price_in_usd: 15.0, price_out_usd: 60.0 }; }
  }

  // ── Azure OpenAI ──
  if (base.includes("azure")) {
    if (/gpt[-_]4o[-_]/.test(id)) { return { price_in_usd: 2.50, price_out_usd: 10.0 }; }
    if (/gpt[-_]4o[-_]mini/.test(id)) { return { price_in_usd: 0.15, price_out_usd: 0.60 }; }
    if (/o1[-_]/.test(id)) { return { price_in_usd: 15.0, price_out_usd: 60.0 }; }
  }

  // ── Anthropic 官方（美国，USD）──
  if (base.includes("anthropic") || base.includes("claude")) {
    if (/claude[-_][3-9]/.test(id) && /sonnet/.test(id)) { return { price_in_usd: 3.0, price_out_usd: 15.0 }; }
    if (/claude[-_][3-9]/.test(id) && /haiku/.test(id)) { return { price_in_usd: 0.80, price_out_usd: 4.0 }; }
    if (/claude[-_][3-9]/.test(id) && /opus/.test(id)) { return { price_in_usd: 15.0, price_out_usd: 75.0 }; }
  }

  // ── Zhipu AI / GLM（中国，CNY）──
  if (base.includes("zhipu") || base.includes("glm-4") || base.includes("bigmodel")) {
    if (/glm[-_]4[-_]/.test(id)) { return { price_in_usd: 0.06, price_out_usd: 0.17 }; } // ¥0.6/M in, ¥1.7/M out
    if (/glm[-_]4[-_]flash/.test(id)) { return { price_in_usd: 0.01, price_out_usd: 0.02 }; } // 免费档位
  }

  // ── ByteDance / 豆包（中国，CNY）──
  if (base.includes("doubao") || base.includes("byte") || base.includes("ark")) {
    if (/doubao[-_]/.test(id) || /ep-/.test(id)) { return { price_in_usd: 0.01, price_out_usd: 0.03 }; }
  }

  // ── StepFun / 阶跃星辰（中国，CNY）──
  if (base.includes("step") || base.includes("jupyter")) {
    if (/step[-_]?l?2?[-_]/.test(id)) { return { price_in_usd: 0.02, price_out_usd: 0.06 }; }
  }

  // ── OpenRouter（聚合平台，USD，约 1.5x-2x 官方价）──
  if (base.includes("openrouter")) {
    // OpenRouter 有完整 pricing，上游会直接返回，这里兜底
    return { price_in_usd: 0, price_out_usd: 0 };
  }

  return {};
}

/**
 * 基于模型 ID 推断是否支持 Thinking 模式。推理等级为【兜底推断】——真正的等级
 * 必须以上游 /models 返回的 reasoning.supported_efforts 为准（enrichModels 里优先取上游）。
 * 等级按行业共识预制（2026）：
 *  - OpenAI o1/o3/o4：low/medium/high；gpt-5 系列：low/medium/high/xhigh/max
 *  - Claude Opus/Sonnet 4.6+：low/medium/high/xhigh/max；旧 Claude：low/medium/high
 *  - DeepSeek-R/GLM5/step-L2/Agnes/Gemini-thinking：low/medium/high
 */
/** 推理强度行业共识顺序（2026，全网调研）：none ≤ minimal ≤ low ≤ medium ≤ high ≤ xhigh ≤ max */
const EFFORT_RANK: Record<string, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, maximal: 7, adaptive: 8, auto: 9,
};
/** 按共识顺序稳定排序推理等级；未知等级排末尾，保证渲染稳定且以上游集合为准 */
function sortEfforts(levels: string[]): string[] {
  const known = levels.filter((l) => l in EFFORT_RANK).sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
  const unknown = levels.filter((l) => !(l in EFFORT_RANK));
  return [...known, ...unknown];
}

function inferThinkingSupport(modelId: string): { supported: boolean; efforts?: string[] } {
  const id = modelId.toLowerCase();
  // OpenAI reasoning（o1/o3/o4 固定仅 low/medium/high；gpt-5.x 支持 xhigh/max）
  if (/(^|[^a-z0-9])(o1|o3|o4)([^a-z0-9]|$)/.test(id)) {
    return { supported: true, efforts: ["low", "medium", "high"] };
  }
  if (/gpt[-_]?5\.(5|6)/.test(id) || /[-_]sol$|[-_]terra$|[-_]luna$/.test(id)) {
    return { supported: true, efforts: ["low", "medium", "high", "xhigh", "max"] };
  }
  // Claude：Opus/Sonnet 4.6+ / 5 / Fable 支持 xhigh/max；其余 Claude 仅 low/medium/high
  if (/claude[-_]/.test(id)) {
    if (/claude[-_](opus|sonnet)/.test(id) && /(4\.[678]|5|fable)/.test(id)) {
      return { supported: true, efforts: ["low", "medium", "high", "xhigh", "max"] };
    }
    return { supported: true, efforts: ["low", "medium", "high"] };
  }
  // DeepSeek / GLM / step / Agnes / Gemini thinking：开/关 + low/medium/high
  if (/deepseek[-_](reasoner|r1)/.test(id) || /glm[-_](5|4\.5)/.test(id) || /step[-_]l2/.test(id)
      || /agnes/.test(id) || /gemini[-_].*think/.test(id)) {
    return { supported: true, efforts: ["low", "medium", "high"] };
  }
  return { supported: false };
}

export async function enrichModels(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base) { return { ok: false, error: "Base URL 不能为空" }; }
  if (!apiKey.trim()) { return { ok: false, error: "API Key 不能为空" }; }

  // 第一步：拉取原始模型 ID 列表（按格式适配端点探测）
  const fetchRes = await fetchModels(baseUrl, apiKey, format);
  if (!fetchRes.ok || !fetchRes.models) {
    return { ok: false, error: fetchRes.error };
  }
  const baseModels = fetchRes.models;

  // 第二步：尝试从上游拉取完整元数据（OpenRouter 等中转站格式）
  const upstreamDetails = await fetchUpstreamDetails(baseUrl, apiKey.trim(), format);

  // 第三步：为每个模型填充元数据
  // 优先级：上游详情 > ID 启发式推断 > 用户已有值
  const models = baseModels.map((m) => {
    const upstream = upstreamDetails.get(m.id);

    // context_window：上游 > 启发式推断 > 已有值
    const ctxFromUpstream = upstream?.context_length;
    const ctxFromInference = inferModelDefaults(m.id).context_window;
    const ctxWindow = ctxFromUpstream && ctxFromUpstream > 0
      ? Math.floor(ctxFromUpstream)
      : (typeof m.context_window === "number" ? m.context_window
        : (ctxFromInference && ctxFromInference > 0 ? ctxFromInference : undefined));

    // pricing：上游 > URL 推断 > 已有值
    const priceInUpstream = upstream?.pricing?.prompt ? parseFloat(upstream.pricing.prompt) : undefined;
    const priceOutUpstream = upstream?.pricing?.completion ? parseFloat(upstream.pricing.completion) : undefined;
    const priceInInferred = inferPricingFromUrl(baseUrl, m.id).price_in_usd;
    const priceOutInferred = inferPricingFromUrl(baseUrl, m.id).price_out_usd;
    const priceIn = priceInUpstream && priceInUpstream > 0 ? priceInUpstream
      : (typeof m.price_in_usd === "number" ? m.price_in_usd : priceInInferred);
    const priceOut = priceOutUpstream && priceOutUpstream > 0 ? priceOutUpstream
      : (typeof m.price_out_usd === "number" ? m.price_out_usd : priceOutInferred);

    // vision：上游 > 启发式推断 > 已有值
    const vision = upstream?.architecture?.input_modalities
      ? upstream.architecture.input_modalities.some((m) => m.includes("image"))
      : (typeof m.vision === "boolean" ? m.vision
        : (inferModelDefaults(m.id).vision ?? false));

    // max_output：上游 > 已有值 > 启发式推断（A-1xx：此前漏用上游 max_completion_tokens，
    // 导致 max_output 只有启发式推断值，部分模型（如 DeepSeek 64k 输出）被低估或缺失）
    const maxOutUpstream = upstream?.max_output;
    const maxOutput = maxOutUpstream && maxOutUpstream > 0 ? maxOutUpstream
      : (typeof m.max_output === "number" ? m.max_output
        : (inferModelDefaults(m.id).max_output ?? undefined));

    // thinking: 上游详情 > 启发式推断 > 已有值
    // 推理等级【以上游返回的 supported_efforts 为准】——上游可能返回 max/xhigh/custom 等
    // 与本地预设不同的等级；上游未给等级则回落到 ID 推断的预制等级；再没有 → 仅开/关（无等级）。
    const upstreamReasoning = upstream?.reasoning;
    const inferredThinking = inferThinkingSupport(m.id);
    const upstreamHasEfforts =
      Array.isArray(upstreamReasoning?.supported_efforts) && upstreamReasoning!.supported_efforts.length > 0;
    const upstreamDeclared =
      upstreamReasoning !== undefined
      && (upstreamReasoning.mandatory !== undefined || Array.isArray(upstreamReasoning.supported_efforts));
    // 支持判定：上游明确声明（mandatory 强制开启 或 声明了等级）→ 以上游为准；否则以已有值/ID 推断兜底
    const thinkingSupported = upstreamDeclared
      ? (upstreamReasoning!.mandatory === true || upstreamHasEfforts)
      : (typeof m.thinking === "boolean" ? m.thinking : inferredThinking.supported);
    // 推理等级：上游返回的等级优先（按共识顺序稳定排列），其次 ID 推断；去重 + 过滤空值
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

    return {
      ...m,
      id: m.id,
      context_window: ctxWindow,
      max_output: maxOutput,
      vision,
      thinking: thinkingSupported,
      thinking_efforts: thinkingEfforts,
      price_in_usd: priceIn && priceIn > 0 ? priceIn : undefined,
      price_out_usd: priceOut && priceOut > 0 ? priceOut : undefined,
      selected: m.selected !== false,
    };
  });

  return { ok: true, models };
}

/** 拉取模型列表：全候选探测（/v1/models → /models → /api/v1/models），OpenAI 与 Anthropic 格式双支持 */
export async function fetchModels(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }> {
  if (typeof baseUrl !== "string" || !normalizeBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL 不能为空" };
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "API Key 不能为空" };
  }
  // auto 模式下同时尝试 OpenAI 和 Anthropic 格式的模型列表端点。候选全部探测
  // （A-156 修复：不再因首个候选 4xx 就放弃——OpenRouter 的 /api/v1/models 在末位）。
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  const candidates: string[] = [];
  if (format === "openai" || format === "auto") {
    candidates.push(`${base}/v1/models`);
    candidates.push(`${base}/models`);
    candidates.push(`${base}/api/v1/models`);
  }
  if (format === "anthropic" || format === "auto") {
    // Anthropic 官方/网关模型列表端点形态：/v1/models 与 /models
    candidates.push(`${base}/v1/models`);
    candidates.push(`${base}/models`);
  }
  // 去重（anthropic 分支与 openai 分支可能重复）
  const uniq = Array.from(new Set(candidates));
  const attempts: string[] = [];
  for (const cand of uniq) {
    try {
      const models = await tryFetchModels(cand, apiKey.trim(), format);
      return { ok: true, models };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push(`${cand} → ${msg}`);
      // A-156：不再因「首个候选 4xx」就 break 放弃其余候选——OpenRouter 等网关对
      // /v1/models 可能 404，但 /api/v1/models 或 /models 正常。只有 401/403（认证失败，
      // 与具体端点无关、换端点必然同样失败）才提前停止，其余候选全部探测后再聚合报错。
      if (/^HTTP (401|403)\b/.test(msg)) { break; }
    }
  }
  return { ok: false, error: `模型列表获取失败：${attempts.slice(0, 4).join("；")}` };
}

export interface SaveProviderInput {
  key: string;
  api_base: string;
  /** 不传则保留已有 key */
  api_key?: string;
  model?: string | null;
  /** API 端点格式：openai / anthropic / auto */
  api_format?: ApiFormat;
  /** 未经校验的原始模型列表（内部 sanitize） */
  models?: unknown[];
}

export interface SaveProviderResult {
  ok: boolean;
  error?: string;
  /** 实际写入路径（诊断展示） */
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
  // 若 models 未提供但 api_base 与 api_key 均已填写，自动 enrich 填充
  if (models === undefined && input.api_key !== undefined && base && input.api_key.trim()) {
    const enriched = await enrichModels(base, input.api_key.trim(), input.api_format ?? "auto");
    if (enriched.ok && enriched.models) {
      // 保留用户手动填写的 context_window / max_output（若有）
      const prevModels = sanitizeModels(prev.models) ?? [];
      models = enriched.models.map((m) => {
        const prev = prevModels.find((p) => p.id === m.id);
        return prev
          ? { ...m, context_window: prev.context_window ?? m.context_window, max_output: prev.max_output ?? m.max_output, selected: prev.selected, vision: prev.vision }
          : m;
      });
    }
  }
  table[key] = {
    api_base: base,
    api_key: input.api_key !== undefined ? input.api_key.trim() : (prev.api_key ?? ""),
    model: input.model !== undefined && input.model !== null ? input.model : (prev.model ?? undefined),
    api_format: input.api_format !== undefined ? input.api_format : (prev.api_format ?? "auto"),
    models,
  };
  try {
    const encoded = encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true, path: resolveConfigPathForReport(), size: encoded.length };
  } catch (e) {
    return { ok: false, error: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 刷新结果（供 UI 提示新增/移除数量） */
export interface RefreshProviderResult {
  ok: boolean;
  total?: number;
  added?: number;
  removed?: number;
  error?: string;
}

/**
 * 一键刷新供应商模型列表（上游更新同步）：
 * - 读取已保存的 Provider 记录（明文 api_key 仅主进程内使用，渲染层不接触）
 * - enrichModels 重新拉取上游最新模型与元数据（上下文/定价/视觉/推理等级）
 * - 合并策略：同名模型保留原 selected 启用状态；新增模型默认不启用（防静默增费）；
 *   上游已下线的旧模型移除（与上游保持同步）
 */
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
    return { ...m, selected: prevSelected.has(m.id) };
  });
  const added = nextModels.filter((m) => !prevModels.some((p) => p.id === m.id)).length;
  const removed = prevModels.filter((p) => !seen.has(p.id)).length;
  table[k] = { ...rec, models: nextModels };
  try {
    encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true, total: nextModels.length, added, removed };
  } catch (e) {
    return { ok: false, error: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 实际写入路径（供 UI 展示诊断；rootOverride 为测试沙箱） */
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
    return { ok: true }; // 不存在视为成功（幂等）
  }
  delete table[key];
  try {
    encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `删除失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 清空全部 Provider 与本地模型注册（数据重置用；写入空表） */
export function clearAllProviders(): { ok: boolean; error?: string } {
  try {
    encrypt({}, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `清空失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ── 本地模型管理 ── */

const GGUF_EXTS = [".gguf", ".ggml"];

function localModelsOf(table: Record<string, unknown>): LocalModelSpec[] {
  const raw = table[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((m): m is LocalModelSpec =>
    typeof m === "object" && m !== null &&
    typeof (m as LocalModelSpec).id === "string" &&
    typeof (m as LocalModelSpec).path === "string");
}

export function listLocalModels(): LocalModelSpec[] {
  return localModelsOf(loadTable());
}

function persistTable(table: ProvidersTable): { ok: boolean; error?: string } {
  try {
    encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 校验 id 合法且未与 API provider key 冲突（model_choice=local:<id> 语义） */
function validateLocalId(id: string, table: ProvidersTable): string | null {
  if (!KEY_RE.test(id)) {
    return "本地模型名称仅限字母/数字/中文/_/-（1-64 字符）";
  }
  if (id in table && id !== LOCAL_MODELS_KEY) {
    return `「${id}」已被 API 供应商占用`;
  }
  return null;
}

export function saveLocalModel(input: { id: string; path: string; label?: string; ctx_len?: number; gpu_layers?: number; max_output?: number; vision?: boolean }): { ok: boolean; error?: string } {
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
  const existing = localModelsOf(table);
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
    },
  ];
  (table as unknown as Record<string, unknown>)[LOCAL_MODELS_KEY] = next;
  return persistTable(table);
}

export function removeLocalModel(id: string): { ok: boolean; error?: string } {
  const table = loadTable();
  const next = localModelsOf(table).filter((m) => m.id !== id);
  if (next.length === localModelsOf(table).length) {
    return { ok: true };
  }
  (table as unknown as Record<string, unknown>)[LOCAL_MODELS_KEY] = next;
  return persistTable(table);
}

/** 扫描目录内的 GGUF 模型文件（单层） */
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