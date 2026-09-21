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
import {
  inferModelCapabilities, resolveModelPriceTier, isAggregatorGateway, isLocalEndpoint, sortEfforts,
  resolveEffectivePricing,
  normalizePriceTiers, type ModelPriceTiers, type ModelPriceTier, type PriceCurrency,
} from "../../../shared/gen/model-capabilities.js";
import { probe, type ProbeObservation, type ProbeResult } from "../../../core-ts/src/probe.js";
// 仅类型导入（编译期擦除，不产生运行时循环依赖）：历史成本回填的解析器签名
import type { PriceResolver, UsagePrice } from "../../../core-ts/src/services/usage.js";
// S3：本地模型的类型与清单键名来自 core-ts 的**唯一来源** —— 此前本文件另有一份
// `LocalModelSpec` 定义与 `LOCAL_MODELS_KEY` 常量，与 engine.ts / shared/ipc.ts 三份并存
// 且已经漂移（engine 那份缺 `vision`；本文件把 `label` 写成必填，而 `localModelsOf()`
// 实际只校验 `id`/`path`，属类型谎言）。现在改键名只需改一处，三方必然同步。
import { LOCAL_MODELS_KEY, localModelSpecs, type LocalModelSpec } from "../../../core-ts/src/local_models.js";
export type { LocalModelSpec };

/** API 端点格式：OpenAI Chat Completions / Anthropic Messages / 自动检测 */
export type ApiFormat = "openai" | "anthropic" | "responses" | "google" | "auto";

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
  /** 缓存读取单价 USD/百万 token（cache 命中场景，相对 prompt 通常 < 1） */
  price_cache_read_usd?: number;
  /** 缓存写入/创建单价 USD/百万 token（通常 ≥ prompt） */
  price_cache_write_usd?: number;
  /** 该模型是否启用分档计费（上游声明 billing_expr 且含条件分支） */
  pricing_tiered?: boolean;
  /** 上游分档计费原始公式字符串（供 UI 展示/告警，不在 slime 端 eval） */
  pricing_formula?: string;
  /** 上游分档计费模式标记（如 "tiered_expr"） */
  pricing_mode?: string;
  /**
   * A-988d：上游声明的**时段价目**（OpenRouter `pricing.overrides`，UTC 口径）转成的分时规格。
   *
   * ⚠️ 这是**候选**，不参与取价 —— 取价只用 `price_tiers`（用户确认过的）。
   * 名字里带 `candidate` 就是为了让任何一个读到它的人不会误以为它在生效。
   */
  pricing_time_tiers_candidate?: ModelPriceTiers;
  /** A-988d：上游声明的上下文长度分档（LiteLLM `*_above_200k_tokens` / one-api `tiers[]`），纯展示 */
  pricing_context_tiers?: UpstreamContextTier[];
  /** A-988d：上游按次/按张计费单价（`pricing.request` / `image` / `web_search` / `audio`…），纯展示 */
  pricing_per_request?: { request?: number; image?: number; webSearch?: number; internalReasoning?: number; audio?: number };
  /**
   * 定价来源 —— 决定「一键刷新」时新探测到的价格能否覆盖旧值，以及 UI 如何标注可信度：
   *   - `"upstream"`：本次探测从上游 /models 或网关 /api/pricing 拿到（最权威）
   *   - `"table"`   ：来自内置家族价目表（离线兜底，可能滞后于官方调价）
   *   - `"manual"`  ：**用户手填** —— 永不被自动探测覆盖。用户可能拿到的是议价/合同价，
   *                   或想按瞬时峰谷档精确计账，自动覆盖会抹掉这个信息。
   * 缺省 `undefined` = 历史数据（无来源信息），按"可被覆盖"处理。
   */
  price_source?: "upstream" | "table" | "manual";
  /**
   * A-988c：用户自定义的分时（峰谷）档位。
   *
   * 为什么存在模型条目里而不是单独一张表：它必须**跟着"哪个供应商的哪个模型"走** ——
   * 同一个 deepseek-flash 在不同中转站可能一套议价时段一套官方时段，放全局表就没法区分。
   *
   * ⚠️ 这份数据**永不被自动探测覆盖**（与手填价同级），见 mergeModelPrice。
   */
  price_tiers?: ModelPriceTiers;
  /**
   * A-990：用户为该模型手选的计价币种（"手动调整币种填入"）。
   *
   * ⚠️ **绝不改变这四个价格字段的单位** —— `price_in_usd` 等恒存 USD，用户选 ¥ 只影响
   * 面板输入框与价格行的**显示/录入单位**（录入时经 `toUsdAmount` 折算一次）。
   * 若让存储值随币种变，`usage.jsonl` 的账目、历史成本回填、引擎取价会同时错 7.2 倍
   * 且**没有任何报错** —— 这正是本项目"表里只有一个数字看不出币种"那类事故的翻版。
   * 缺省（undefined）= 按归属地推断，见 `pricingDisplayCurrency`。
   */
  price_currency?: PriceCurrency;
  /**
   * 该模型的端点格式覆盖（per-model）。聚合网关下不同模型可能走不同端点
   * （如 claude→anthropic/messages、gpt→openai/chat、其余→openai）。缺省 = 跟随供应商级 api_format。
   */
  api_format?: ApiFormat;
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

/* S3：清单键名与条目类型已上移到 core-ts/src/local_models.ts（见文件顶部 import）。 */

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
        // ⚠️ 这里**不能**像上面 context_window 那样加 `> 0` 过滤。
        //    价格字段的 `0` 是**合法且有含义**的（"缓存命中免费"是真实存在的计费口径），
        //    而 `undefined` 才表示"未定价"。`sanitizeModels` 是**每次读盘都跑**的，
        //    一旦在这里把 0 过滤掉，用户手填的 0 会在下一次读配置时被静默销毁 →
        //    落回 resolveCacheRates 的倍率推导（0.1× 输入价）→ 明明是免费的被记成收费。
        //    同一行的 price_in_usd / price_out_usd 也没有这个判断，保持四者对称。
        price_cache_read_usd: typeof (rawM as any).price_cache_read_usd === "number"
          ? (rawM as any).price_cache_read_usd : undefined,
        price_cache_write_usd: typeof (rawM as any).price_cache_write_usd === "number"
          ? (rawM as any).price_cache_write_usd : undefined,
        pricing_tiered: (rawM as any).pricing_tiered === true,
        pricing_formula: typeof (rawM as any).pricing_formula === "string" && (rawM as any).pricing_formula
          ? (rawM as any).pricing_formula : undefined,
        pricing_mode: typeof (rawM as any).pricing_mode === "string" && (rawM as any).pricing_mode
          ? (rawM as any).pricing_mode : undefined,
        // 定价来源（manual 标记必须落库，否则"一键刷新"会抹掉用户手填的价格）
        price_source: (rawM as any).price_source === "upstream" || (rawM as any).price_source === "table"
          || (rawM as any).price_source === "manual" ? (rawM as any).price_source : undefined,
        /*
         * A-990：用户手选的计价币种。
         *
         * ⚠️ 本函数是**白名单重建**（逐个字段拷出来），漏掉一个字段它就会在**每次读盘**时
         * 被静默抹掉 —— 表现是"我选了 ¥，重启/刷新后又变回 $"，
         * 而因为没有任何报错，排查会从 UI 一层层往下怀疑，最后才发现是这里少了一行。
         * （`price_tiers` 当初踩的就是同一个坑，注释已写明。）
         * 只接受两个合法值：数据来自磁盘 JSON，可能被手改成任意字符串。
         */
        price_currency: (rawM as any).price_currency === "USD" || (rawM as any).price_currency === "CNY"
          ? (rawM as any).price_currency : undefined,
        // A-988c：用户自定义分时档。这份数据来自磁盘 JSON（可被手改、也可能被旧版本写坏），
        // 必须过一遍校验再进内存 —— 一个 NaN 的 startMin 会让时段判定全部落空（静默按兜底档
        // 计费，用户永远查不出原因），一个非数字 priceIn 会把成本写成 NaN 污染整张账目表。
        // 校验不过 = 当成"没有自定义分时"，退回内置表/手填价，**不会**半途而废地用半个坏档位。
        price_tiers: normalizePriceTiers((rawM as any).price_tiers),
        // A-988d：上游采集到的候选分时档（同样来自磁盘，同样要校验）
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
        // 端点格式透传（per-model 覆盖，聚合网关多端点用）
        api_format: (rawM as any).api_format === "anthropic" || (rawM as any).api_format === "openai" || (rawM as any).api_format === "auto"
          ? (rawM as any).api_format : undefined,
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

/** 从模型列表响应体解析模型 id（OpenAI / Anthropic / 自建网关多种形态） */
function parseModelIds(body: unknown): string[] {
  let items: Array<Record<string, unknown>> | null = null;
  const b = (body ?? {}) as Record<string, unknown>;
  // 模型列表的常见形态（全网枚举，A-156 覆盖面扩展）：
  // - OpenAI/OpenRouter/one-api 系：{ data: [...] }
  // - Anthropic：{ data: [...] }（真实 /v1/models）或 { models: { id: details } } / { models: [...] }
  // - 部分自建网关：{ model_list: [...] } 或顶层裸数组
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
  // 鉴权头：OpenAI 兼容用 Bearer，Anthropic 官方/网关用 x-api-key + anthropic-version（Bearer 会被 401）。
  // format="auto" 时对同一端点依次尝试两种鉴权（Bearer 优先，x-api-key 兜底），适配聚合网关与
  // 原生 Anthropic 网关；显式 openai/anthropic 则只用对应头（避免误发、省一次往返）。
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
        headers,
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
      // 只有认证失败（401/403）才值得换下一组鉴权头；其它错误（404 端点不存在/解析失败/网络）
      // 换 headers 无意义，直接抛出让 fetchModels 聚合/继续下一候选。
      if (/^HTTP (401|403)\b/.test(msg)) {
        lastAuthErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastAuthErr instanceof Error ? lastAuthErr : new Error(String(lastAuthErr));
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

/**
 * 上游价格字段的**三套单位约定**（A-988d 调研结论，逐家核对官方文档/源码）：
 *   A. **per-token 美元**：OpenRouter `pricing.prompt`（字符串 "0.000003"）、
 *      LiteLLM `input_cost_per_token`（0.000003）→ 需 ×1e6 才是 slime 的 USD/1M。
 *   B. **per-1M 美元**：自建网关常见 `input_cost_per_1m_tokens`、`prompt_price`（2.5）→ 直接用。
 *   C. **无名乘数**：new-api `model_ratio`（0.1125）→ ×2（换算依据见 newApiConfigMap 注释）。
 * 单位判错会让成本整体错 100 万倍 —— 这正是 A-970 事故的两个根因之一（另一个是人民币二次换算）。
 * 所以**字段名优先**：带 `per_token`/`_cost_per_token` 的一律按 A；带 `per_1m`/`per_million` 的按 B；
 * 名字里没有单位信息时（如 `prompt`、`input_price`）才用值域判定。
 *
 * 值域判定的安全性：真实的 per-token 价必然 < 0.001（$1000/1M 是最贵模型的量级），
 * 而 per-1M 价几乎必然 ≥ 0.001。所以 `n < 1e-3 → 按 per-token` 不会误判两个方向上的真实数据。
 */
type PriceUnit = "per_token" | "per_million" | "auto";

/**
 * 把上游的某个金额字段解析成 **USD / 1M tokens**。
 *
 * ⚠️ 与旧版 `toPerMillion` 的关键差别：**`0` 被如实返回，而不是当成"没有值"**。
 * 旧版 `n > 0 ? n*1e6 : undefined` 会把官方"限时免费"报的 0 丢掉 → 上层回退到内置表的旧价
 * → 给免费模型凭空计费。这与 `mergeModelPrice` 注释里 ② 那条是同一个教训（`0` 也算"给了"）。
 * `undefined` 只表示"上游没给这个字段"。
 */
function parseUsdPerMillion(v: unknown, unit: PriceUnit = "auto"): number | undefined {
  let n: number;
  if (typeof v === "number") { n = v; }
  else if (typeof v === "string" && v.trim() !== "") {
    // 有些网关把价格塞进可读字符串（"$0.000003" / "0.000003 USD"）→ 剥掉非数字前后缀
    const cleaned = v.trim().replace(/^\$/, "").replace(/\s*(usd|USD|\/1m|\/1M)\s*$/, "");
    n = Number(cleaned);
  } else { return undefined; }
  if (!Number.isFinite(n) || n < 0) { return undefined; }
  if (n === 0) { return 0; } // 显式免费
  const perToken = unit === "per_token" || (unit === "auto" && n < 1e-3);
  return perToken ? n * 1_000_000 : n;
}

/** 从对象里按**点号路径**取值（`"pricing.prompt"`）；任一层缺失/非对象都返回 undefined */
function pickPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") { return undefined; }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * A-988d：**上游价格字段探针表**。这是"彻底覆盖各家厂商"的落点 —— 新增一家只需追加一行。
 *
 * 为什么必须做成表（而不是继续 `a ?? b ?? c` 手写）：
 *   - 漏读一个字段名 = 该家模型**整条链静默无价**（A-970 实测 1606 条记录 100% 成本为 0，
 *     根因之一就是只读 OpenRouter 风格的 `pricing.prompt`）；
 *   - 手写链里很容易出现"某一路忘了乘 1e6"的不对称（旧版 `toPerMillion` 就只在部分分支用）；
 *   - 表能一眼看出**哪些槽位是空的**，这正是"探针覆盖是否完整"的可审性。
 *
 * 顺序 = 优先级（先精确后模糊）：OpenRouter 命名 → LiteLLM 命名 → 通用命名。
 */
const UPSTREAM_PRICE_FIELDS: Array<{
  slot: "prompt" | "completion" | "cacheRead" | "cacheWrite" | "cacheWrite1h";
  paths: Array<[string, PriceUnit]>;
}> = [
  {
    slot: "prompt",
    paths: [
      ["pricing.prompt", "auto"],              // OpenRouter（per-token 字符串）
      ["input_cost_per_token", "per_token"],   // LiteLLM model cost map
      ["input_cost_per_1m_tokens", "per_million"],
      ["input_cost_per_million_tokens", "per_million"],
      ["prompt_price", "auto"],                // 部分自建网关
      ["input_price", "auto"],
      ["prompt", "auto"],                      // new-api 扁平形态
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
    // 缓存**命中**（= 缓存读取）。各家命名最混乱的一项，列出全部已知写法。
    slot: "cacheRead",
    paths: [
      ["pricing.input_cache_read", "auto"],          // OpenRouter
      ["pricing.cache_read", "auto"],                // 旧 OpenRouter / 自建
      ["cache_read_input_token_cost", "per_token"],  // LiteLLM
      ["cache_read_input_token_cost_per_1m", "per_million"],
      ["cached_input_cost", "per_token"],            // 部分网关
      ["input_cache_read_cost", "auto"],
      ["cache_read_price", "auto"],
      ["cached_input_price", "auto"],
      ["cache_read", "auto"],
    ],
  },
  {
    // 缓存**写入**（= cache creation / 缓存创建）。
    slot: "cacheWrite",
    paths: [
      ["pricing.input_cache_write", "auto"],              // OpenRouter
      ["pricing.cache_creation", "auto"],                 // 旧 OpenRouter
      ["cache_creation_input_token_cost", "per_token"],   // LiteLLM
      ["cache_creation_input_token_cost_per_1m", "per_million"],
      ["cache_write_5m_cost", "auto"],                    // one-api 5 分钟档
      ["cache_creation_price", "auto"],
      ["input_cache_write_cost", "auto"],
      ["cache_creation", "auto"],
      ["cache_write", "auto"],
    ],
  },
  {
    // Anthropic 的 **1 小时缓存写入档**（2× 输入价）。单独一个槽位：
    // 与 5 分钟档差 1.6 倍，合并成一个"写入价"会让长 TTL 缓存少记 37%。
    slot: "cacheWrite1h",
    paths: [
      ["pricing.input_cache_write_1h", "auto"],
      ["cache_write_1h_cost", "auto"],
      ["cache_write_1h_ratio", "auto"],
    ],
  },
];

/**
 * 相对 prompt 价的**乘数型**缓存字段（new-api / one-api 系用倍率而非绝对价）。
 * 语义：`缓存价 = 输入价 × 该字段值`。`0` 是合法值（显式表示"不收费"）。
 */
const CACHE_RATIO_FIELDS: Array<{ slot: "cacheRead" | "cacheWrite" | "cacheWrite1h"; names: string[] }> = [
  { slot: "cacheRead", names: ["cache_ratio", "cached_input_ratio", "cache_read_ratio"] },
  { slot: "cacheWrite", names: ["create_cache_ratio", "cache_write_5m_ratio", "cache_creation_ratio", "cache_write_ratio"] },
  { slot: "cacheWrite1h", names: ["cache_write_1h_ratio"] },
];

/** OpenRouter `pricing.overrides[]` 的一项：**按 UTC 时段**切换的价目（A-988c 分时定价的上游形态） */
export interface UpstreamTimeOverride {
  /** 该档适用的最小输入 token 数（配合上下文分档，缺省 = 无门槛） */
  minPromptTokens?: number;
  /** UTC 起/止，HHMM 整数（`1600` = 16:00 UTC）；`start > end` = **跨午夜** */
  utcStart?: number;
  utcEnd?: number;
  /** 生效星期（0=周日…6=周六）；缺省 = 每天 */
  utcDays?: number[];
  prompt?: number;
  completion?: number;
  cacheRead?: number;
}

/** 上游声明的**上下文长度分档**（LiteLLM `*_above_200k_tokens` / one-api `tiers[].input_token_threshold`） */
export interface UpstreamContextTier {
  /** 该档起始的输入 token 数（含） */
  fromInputTokens?: number;
  prompt?: number;
  completion?: number;
}

const UTC_DAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** HHMM 整数 → 当天分钟数；非法返回 undefined（`"16:00"` 与 `1600` 都接受） */
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

/**
 * 解析 OpenRouter 风格 `pricing.overrides[]` —— 上游自己声明的**时段价目**。
 *
 * ⚠️ 这里刻意**不直接生效**：它只是被采集下来作为"候选"，由用户在分时编辑器里显式导入。
 * 理由：上游 overrides 用的是 **UTC**（字段名就叫 `utc_start/utc_end/utc_days`），
 * 而 slime 的账单口径要按供应商计费时区解释；自动套用会把时区语义搞反 8 小时。
 * 用户点导入时我们把它整份按 `timezone: "UTC"` 落地（语义完全等价，无需换算），
 * 想改成别的时区由用户在界面上改 —— 全程可见、可核对。
 */
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
    // 既没有时段也没有 token 门槛 → 这不是"分档"，是整份覆盖，采集下来没有意义
    if (utcStart === undefined && utcEnd === undefined && minPrompt === undefined) { continue; }
    // 两侧都给了且相等 → 空窗口（`inAnyWindow` 会直接跳过，永不命中）。
    // 采集它只会让 UI 多出一条永远不生效的档位；与 overridesToPriceTiers 的跳过规则保持一致。
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

/**
 * 把上游的时段 override 转成 slime 的分时规格（`timezone: "UTC"`）。
 *
 * 只处理**有时段**的 override：只有 `min_prompt_tokens` 的那些属于"上下文长度分档"，
 * 不是分时，混进档位表会让"现在按哪个价"变得无法解释。
 * 边界处理：只有 start 没有 end（或反之）时补成"另一侧兜到边界"，避免生成半开窗口。
 */
export function overridesToPriceTiers(overrides: UpstreamTimeOverride[], baseIn: number, baseOut: number): ModelPriceTiers | undefined {
  const tiers: ModelPriceTier[] = [];
  for (const [i, o] of overrides.entries()) {
    if (o.utcStart === undefined && o.utcEnd === undefined) { continue; }
    const startMin = o.utcStart ?? 0;
    const endMin = o.utcEnd ?? 1439;
    if (startMin === endMin) { continue; } // 空窗口，跳过（语义见 inAnyWindow 注释）
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
  // 补兜底档：上游 overrides 只描述"例外时段"，其余时间仍走基准价；
  // 少了它，非命中时段会落到 tiers[0]（一个真实但错误的高价档）→ 凭空多收。
  tiers.push({ id: "base", label: "其余时段（基准价）", windows: [], priceIn: baseIn, priceOut: baseOut });
  return { timezone: "UTC", tiers };
}

/**
 * 解析「上下文长度分档」。
 *   - LiteLLM：`input_cost_per_token_above_200k_tokens` / `..._above_128k_tokens`
 *   - one-api：`tiers: [{ input_token_threshold, input_cost_per_million_tokens, ... }]`
 * 这些是**按输入长度加价**，与分时无关，因此只采集用于提示，不参与取价
 * （slime 的取价入口按 token 单价 + 时刻，没有"按上下文长度"这一维；强行套会算错）。
 */
export function parseContextTiers(item: Record<string, unknown>): UpstreamContextTier[] | undefined {
  const out: UpstreamContextTier[] = [];
  // ① LiteLLM 的后缀形态：字段名里自带门槛（above_200k_tokens）
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
  // ② one-api 的数组形态：tiers[].input_token_threshold
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


/**
 * new-api / one-api 的「倍率配置」端点（/api/ratio_config，部分网关公开无需鉴权）：
 * 返回 { success, data: { model_ratio: {模型: 倍率}, completion_ratio: {...}, model_price: {...} } }
 * ——data 是**对象映射**而非数组，需单独解析。
 *
 * 单位换算（已查 new-api 源码 setting/ratio_setting/model_ratio.go 定死）：
 *   源码常量 `USD = 500 // $0.002 = 1`，注释 `1 === $0.002 / 1K tokens`
 *   → **1 倍率 = $0.002/1K = $2/1M tokens，即 $/1M = model_ratio × 2**
 *   交叉验证（源码 defaultModelRatio 值 → 换算结果 → 官方定价，全部命中）：
 *     gpt-4o          1.25  → $2.5/1M  （源码注释即标 "$2.5 / 1M tokens"）
 *     gpt-4o-mini     0.075 → $0.15/1M
 *     deepseek-chat   0.135 → $0.27/1M
 *     claude-sonnet   1.5   → $3/1M
 *
 * ⚠️ **不要用 model_price 当 token 价格**：model_price 是图像/音乐/视频等「按次计费」
 *    模型的单价（源码默认表：dall-e-3=0.04/次、suno_music=0.1/次、sora-2=0.3/次），
 *    不是 per-token 价格。文本 token 价格只能由 model_ratio 换算得出。
 */

/**
 * new-api 的「分档计费公式」(billing_expr) 解析（A-970：上一轮 new-api 实测发现真实数据）。
 *
 * 公式形如：
 *   len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + cc * 12.5)
 *                       : tier("long_context", p * 20 + c * 75 + cr * 2 + cc * 25)
 *
 * 语义：
 *   - `len` = 输入 token 数；`p/c/cr/cc` = prompt/completion/cache-read/cache-create token 数
 *   - 每个乘数（10、50、1、12.5）已是 $/1M 绝对值（独立于 model_ratio）
 *   - 多档用 `len <= N ? tierA : tierB` 串联（理论可链式多档）
 *
 * slime 处理策略（**不 eval**）：
 *   公式可能含自定义算子/嵌套/未知变量，eval 是安全坑；上游才是真理。
 *   只解析"有没有分档 + 边界 + 标签 + 各档乘数"，够 UI 提示"该模型按上下文长度分档计费"。
 */
export interface TierMultipliers {
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  cacheCreate?: number;
}
export interface ParsedBillingTier {
  /** 上游 tier 名（"standard" / "long_context" / "thinking" 等） */
  label: string;
  /** 该 tier 各 token 类型的 $/1M 绝对乘数；任一缺失就 undefined（公式里没出现对应项） */
  multipliers?: TierMultipliers;
}
export interface ParsedBillingExpr {
  /** 原始公式字符串（供 UI 展示/审计） */
  raw: string;
  /** 上游标记的计费模式（如 "tiered_expr"）；undefined 表示上游未声明 */
  mode?: string;
  /** 分档切换边界（输入 token 数）；undefined = 单档或解析失败 */
  boundary?: number;
  /** 按公式顺序的所有 tier（条件成立先 left 后 right）；空数组 = 解析失败 */
  tiers: ParsedBillingTier[];
  /** 该公式是否含条件分档（true = boundary 存在且 ≥ 2 档） */
  tiered: boolean;
}

/** 解析单个 tier("label", p*N + c*M + ...) 表达式的乘数（不 eval，不做算术） */
function parseTierExpression(expr: string): ParsedBillingTier | null {
  const m = expr.match(/^\s*tier\(\s*"([^"]*)"\s*,\s*(.+?)\s*\)\s*$/);
  if (!m) { return null; }
  const label = m[1];
  const body = m[2];
  // 形如 `p * 10` / `cr * 1.25`：键名边界 + 数值（整数或小数）
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

/** 解析整个 billing_expr 字符串。返回 undefined = 输入非字符串/空。 */
export function parseBillingExpr(formula: unknown, mode?: unknown): ParsedBillingExpr | undefined {
  if (typeof formula !== "string") { return undefined; }
  const raw = formula.trim();
  if (!raw) { return undefined; }
  // 顶层条件：len <= N ? tierA : tierB（贪心，但 : 之前的 tierA 不应再含 : —— 真实公式不会出现）
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
  /** 缓存读取 $/1M（来自 cache_ratio × prompt，或上游直接给绝对值） */
  promptCacheRead?: number;
  /** 缓存写入/创建 $/1M（同上） */
  promptCacheCreate?: number;
  /**
   * 缓存写入的 **1 小时 TTL 档** $/1M（Anthropic 为 2× 输入价，5 分钟档是 1.25×）。
   * 单列一档而不是并进 `promptCacheCreate`：两档差 1.6 倍，混用会让长 TTL 缓存少记 37%。
   */
  promptCacheWrite1h?: number;
  /** OpenRouter `pricing.discount`：本周期折扣比例（非 token 单价，仅供 UI 提示） */
  discount?: number;
  /** 上游计费模式（如 "tiered_expr"） */
  billingMode?: string;
  /** 解析后的分档计费（上游声明 billing_expr 时存在） */
  tiered?: ParsedBillingExpr;
  /**
   * A-988d：上游自己声明的**时段价目**（OpenRouter `pricing.overrides`，UTC 口径）。
   * **采集但不自动生效** —— 由用户在分时编辑器里显式导入（见 overridesToPriceTiers）。
   */
  timeOverrides?: UpstreamTimeOverride[];
  /** A-988d：上游声明的**上下文长度分档**（LiteLLM `*_above_200k_tokens` / one-api `tiers[]`） */
  contextTiers?: UpstreamContextTier[];
  /** A-988d：按次/按张计费单价（`pricing.request` / `image` / `web_search` / `audio` …） */
  perRequest?: { request?: number; image?: number; webSearch?: number; internalReasoning?: number; audio?: number };
};

export function newApiConfigMap(data: unknown): Map<string, { pricing?: NewApiPricing }> {
  const out = new Map<string, { pricing?: NewApiPricing }>();
  if (!data || typeof data !== "object") { return out; }
  const d = data as Record<string, unknown>;
  const ratioMap = d.model_ratio;
  const compMap = d.completion_ratio;
  // 缓存倍率的**别名集合**（new-api 各版本 + one-api 的字段名都收进来）：
  // 只认一个名字 = 换一个网关版本就静默丢缓存价（用户看到的现象是"缓存价突然变未定价了"）。
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
    /*
     * `model_ratio`（**基数**倍率）必须 > 0，`0` 一律跳过。
     *
     * 这不与「`0` 也是合法价格」矛盾 —— 两者的字段语义不同：
     *   · `model_ratio` 是 token 单价本身。**new-api 自己的管理接口就拒绝存储 ≤ 0 的倍率**
     *     （输入非法时前端/后端会报"倍率必须大于 0"），所以在这里读到 0 只能是
     *     占位残留/半写坏的配置，把它当成"免费"会让整个供应商的账单静默变成 $0
     *     —— 正是 A-970「错的低价比没有价格危害大得多」。
     *   · `cache_ratio` / `create_cache_ratio` 是**相对 prompt 的乘数**，new-api 允许 0，
     *     语义明确就是"缓存不收费" → 那些一律用 `>= 0` 保留（见下面的 rel()）。
     *   · 另一条独立的声明路径（OpenRouter 式 `pricing.prompt: "0"`）是显式的绝对价，
     *     那里的 0 仍如实采信（见 parseUsdPerMillion）。
     */
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) { continue; }
    const cr = (compMap && typeof compMap === "object")
      ? (compMap as Record<string, unknown>)[id] : undefined;
    const completionRatio = typeof cr === "number" && cr > 0 ? cr : 1;
    const perMillion = r * 2; // 1 倍率 = $2/1M tokens
    // 缓存倍率是**相对 prompt 价的乘数**，`0` 合法（显式表示不收费）→ 用 `>= 0` 而不是 `> 0`。
    // 旧写法 `> 0` 会把官方的"缓存免费"当成"没有配置"，回退到别处的值 → 免费被记成收费。
    const rel = (map: Record<string, unknown> | undefined): number | undefined => {
      const v = map?.[id];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    const cacheR = rel(cacheMap);
    const cacheC = rel(cacheCreateMap);
    const cache1h = rel(cacheWrite1hMap);
    // billing_expr / billing_mode：分档计费（语义独立，**不**覆盖 flat prompt/completion 值——
    // slime 仍按 model_ratio 计费，遇到分档模型时 UI 应提示"上游实际按上下文长度加价"）
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

/** 上游单模型元数据（fetchUpstreamDetails 的值类型） */
export interface UpstreamModelDetail {
  context_length?: number;
  max_output?: number;
  pricing?: NewApiPricing;
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] };
  architecture?: { input_modalities?: string[] };
}

/** 上游模型元数据端点返回的 JSON 形态（`{ data: [...] }`）；失败返回 null */
export type UpstreamJsonFetcher = (url: string) => Promise<{ data?: unknown } | null>;

/** 解析上游「模型数组」形态的响应体（OpenRouter /models、new-api /api/pricing 都是数组） */
export function parseUpstreamModelItems(items: Array<Record<string, unknown>>): Map<string, UpstreamModelDetail> {
  return new Map(items.map((d) => {
    // 上游 max_output 常见字段：max_completion_tokens（OpenRouter/自建）或
    // top_provider.max_completion_tokens；部分平台用 output_tokens / max_output_tokens
    const rawMax = (d as any).max_completion_tokens
      ?? (d as any).top_provider?.max_completion_tokens
      ?? (d as any).max_output_tokens
      ?? (d as any).max_tokens;
    // new-api / one-api 系用 model_name 而非 id
    const id = String((d as any).id ?? (d as any).model_name ?? (d as any).model ?? "");
    // new-api /api/pricing：文本模型走 model_ratio（×2 = $/1M tokens，换算依据见 newApiConfigMap 注释）；
    // quota_type=1 是「按次计费」模型（图像/音乐/视频），其 model_price 是每次调用单价（如
    // dall-e-3=0.04/次），**不是 token 价格**，故不作 token 定价使用。
    const quotaType = typeof (d as any).quota_type === "number" ? (d as any).quota_type : 0;
    const newApiRatioRaw = typeof (d as any).model_ratio === "number" ? (d as any).model_ratio : undefined;
    const newApiRatio = quotaType === 0 && newApiRatioRaw !== undefined && newApiRatioRaw > 0
      ? newApiRatioRaw : undefined;
    const newApiComp = typeof (d as any).completion_ratio === "number" && (d as any).completion_ratio > 0
      ? (d as any).completion_ratio : 1;

    // ── A-988d：表驱动取价（覆盖 OpenRouter / LiteLLM / one-api / 自建网关的字段名）──
    const bySlot: Record<string, number | undefined> = {};
    for (const f of UPSTREAM_PRICE_FIELDS) {
      for (const [path, unit] of f.paths) {
        const v = parseUsdPerMillion(pickPath(d, path), unit);
        if (v !== undefined) { bySlot[f.slot] = v; break; }
      }
    }
    // new-api 的乘数口径兜底：pricing/model_price 都没给时才用 model_ratio 换算
    const prompt = bySlot.prompt ?? (newApiRatio !== undefined ? newApiRatio * 2 : undefined);
    const completion = bySlot.completion
      ?? (prompt !== undefined && (newApiRatio !== undefined || bySlot.prompt !== undefined)
        ? prompt * newApiComp : undefined);

    // 缓存价的**乘数型**来源（相对 prompt）：new-api / one-api 系大量使用
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

    // 分档计费（new-api billing_expr，独立字段，不影响 flat 值）
    const billingExprStr = typeof (d as any).billing_expr === "string" ? (d as any).billing_expr : undefined;
    const billingModeStr = typeof (d as any).billing_mode === "string" && (d as any).billing_mode
      ? (d as any).billing_mode : undefined;
    const tieredParsed = billingExprStr !== undefined ? parseBillingExpr(billingExprStr, billingModeStr) : undefined;

    // A-988d 新增采集：上游时段档（OpenRouter overrides）与上下文长度档（LiteLLM / one-api）
    const timeOverrides = parsePricingOverrides((d as any).pricing?.overrides ?? (d as any).overrides);
    const contextTiers = parseContextTiers(d);
    // 按次/按张计费的单价（不参与 token 计费，仅用于提示"这个模型不是按 token 计价"）
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
          /** OpenRouter `pricing.discount`：本周期的折扣比例（**不是** token 单价，原样带上供 UI 提示） */
          discount: typeof (d as any).pricing?.discount === "string"
            ? parseFloat((d as any).pricing.discount) : undefined,
          billingMode: billingModeStr,
          tiered: tieredParsed,
          timeOverrides,
          contextTiers,
          ...(hasPerRequest ? { perRequest } : {}),
        }
      : undefined;
    // 上游上下文窗口字段名各家不一（OpenRouter=context_length；new-api/one-api 系=context_window/
    // max_context_length；部分网关=context_size / max_input_tokens / top_provider 嵌套）——
    // 此前只读 context_length，网关用别的写法时探针等于白跑 → 回落到本地旧预设（512K 模型被锁成 128K）。
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

/** 从上游拉取完整模型元数据（OpenRouter 格式和常见变体） */
async function fetchUpstreamDetails(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<Map<string, UpstreamModelDetail>> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return new Map(); }
  const isAnthropic = format === "anthropic";
  const headers: Record<string, string> = isAnthropic
    ? { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", Accept: "application/json" }
    : { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };

  const getJson: UpstreamJsonFetcher = async (url) => {
    try {
      const res = await chromiumFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) { return null; }
      return await res.json() as { data?: unknown };
    } catch {
      return null;
    }
  };

  return probeUpstreamTwoPhase(base, getJson);
}

/**
 * **两阶段**上游探测（A-970 定价事故的关键修复；抽成纯函数以便单测）。
 *
 * 旧实现是"命中第一个返回 200 的候选就 return"，而 `${base}/v1/models` 在几乎所有网关上都
 * 返回 200、响应体里却**没有 pricing** → 排在它后面的 `/api/pricing`、`/api/ratio_config`
 * **永远执行不到**，new-api/one-api 公开的真实结算价就这么被整体跳过 —— 这是"一大堆模型没定价"
 * 最主要的根因（实测 1606 条 usage 记录 100% 成本为 0）。
 *
 * 现在拆成两阶段，**互不短路**：
 *   - 阶段 1：模型元数据端点（`/v1/models` → `/models` → `/api/v1/models` → `/openapi.json`），
 *     拿到第一份非空清单即止；
 *   - 阶段 2：定价端点（`/api/pricing`、`/api/ratio_config`）**独立地**再跑一轮，把价格合并进
 *     阶段 1 已收集的 details。模型端点自带的 pricing（OpenRouter 市场价，最贴合本网关）优先，
 *     定价端点只做补位。
 *
 * ⚠️ 改回"单循环 + 命中即 return"会让本 bug 复活。回归测试见 providers-pricing.spec.ts。
 */
export async function probeUpstreamTwoPhase(
  base: string,
  getJson: UpstreamJsonFetcher,
): Promise<Map<string, UpstreamModelDetail>> {
  const details = new Map<string, UpstreamModelDetail>();

  // 阶段 1：模型元数据端点（OpenRouter 风格数组）
  for (const url of [`${base}/v1/models`, `${base}/models`, `${base}/api/v1/models`, `${base}/openapi.json`]) {
    const body = await getJson(url);
    if (!body || !Array.isArray(body.data)) { continue; }
    for (const [id, d] of parseUpstreamModelItems(body.data as Array<Record<string, unknown>>)) {
      if (id) { details.set(id, d); }
    }
    if (details.size > 0) { break; } // 拿到模型清单即止；定价另走阶段 2，不受此 break 影响
  }

  // 阶段 2：定价端点（**刻意不放进上面的循环** —— 放进去就会被阶段 1 的 break 短路掉）
  for (const url of [`${base}/api/pricing`, `${base}/api/ratio_config`]) {
    const body = await getJson(url);
    if (!body || body.data === undefined || body.data === null) { continue; }
    // 形态 A：对象映射（/api/ratio_config → { model_ratio: {...}, completion_ratio: {...}, ... }）
    // 形态 B：数组（/api/pricing     → [{ model_name, model_ratio, completion_ratio, ... }]）
    const entries = Array.isArray(body.data)
      ? parseUpstreamModelItems(body.data as Array<Record<string, unknown>>)
      : newApiConfigMap(body.data);
    let merged = 0;
    for (const [id, cfg] of entries) {
      if (!cfg.pricing) { continue; }
      const cur = details.get(id) ?? {};
      // 模型端点自带的 pricing（OpenRouter 市场价，最贴合本网关）优先；定价端点只做补位
      details.set(id, { ...cur, pricing: cur.pricing ?? cfg.pricing });
      merged += 1;
    }
    if (merged > 0) { break; }
  }

  return details;
}

/**
 * 写进 provider 配置的 `context_window` 的**唯一决策点**。
 *
 * 优先级：上游服务回传 > 家族能力表（**仅远端**）> 已有保存值（**仅远端**）> 旧正则启发式（**仅远端**）
 *
 * ⚠️ S5（A-1018 ③）：**本地 / 内网端点在「上游回传」之后就到此为止**。
 * 家族表存的是模型**训练时**的窗口（qwen3 / dots = 524K），而本机 llama-server 的实际窗口
 * 只由启动参数 `-c` 决定 —— 并且**问得到**（`/props.n_ctx`，唯一决策点见 core-ts 的
 * `resolveWindowCap`）。在这里塞一个训练窗口，它会落进 provider 配置的 `context_window`，
 * 再被渲染层当成会话上限：环里显示"还剩 480K"，请求却被上游 400 顶回
 * `exceeds the available context size (8192 tokens)`。
 *
 * ⚠️ 为什么「已有保存值」对本地端点也要丢：这个字段的值**本来就是本函数自动填的**，
 * 不是用户手填的。留着它就等于把旧代码写坏的 524K 永久继承下去 ——
 * 正是注释里反复出现的「错值自杀锁」。丢掉之后 `resolveWindowCap` 会用探测到的真实值补上。
 *
 * ⚠️ 把规则收在这个函数里（而不是散在调用点）是为了它能被**直接测到**：
 * 一旦被改回"本地端点也吃家族兜底"，行为测试立刻红（见 tests/gui/…）。
 */
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

/** 基于模型 ID 命名规律推断默认元数据（覆盖 OpenAI/Anthropic/DeepSeek/Gemini/自建等所有场景） */
function inferModelDefaults(modelId: string): Partial<ModelSpec> {
  // ① 优先取能力表（单一真相源，含 2026 新模型如 gpt-6 / gemini-3.x 的兜底值）；
  //    此前仅靠下面的旧正则表（gpt-4 时代）导致新模型兜底为「无上下文」。
  const caps = inferModelCapabilities(modelId);
  const id = modelId.toLowerCase().replace(/[^a-z0-9\-_.]/g, "");

  // ── 上下文长度推断：能力表 > 旧启发式 ──
  let context_window: number | undefined = caps.context;
  // 能力表已给出兜底值时不再走旧正则（避免旧值覆盖新表）
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
    else if (/doubao|ep-/.test(id)) { context_window = 131072; } // 字节豆包
    else if (/step[-_]?l?2?[-_]/.test(id)) { context_window = 131072; } // 阶跃星辰
    /* Agnes：官方口径「512K」。
     *
     * ⚠️ 单位口径必须与全项目显示层一致（十进制 K，÷1000）——`fmtK` / ProvidersPanel / 右栏
     * 进度条**统一**按 ÷1000 渲染。此前这里写的是 `524288`（= 512×1024，二进制），于是同一份
     * 配置在界面上读作 **"524K"**，与注释、与厂商口径、与用户设置三处全对不上（用户实测
     * "配置 512K，首页显示 524K"）。
     *
     * 取 512000 而非 524288 的理由：本分支只是**能力表未命中时的兜底推断值**（不是探测到的真值），
     * 而同表其余头条模型的上下文都写成十进制整数（gpt-4o 128000 / claude 200000 / deepseek 64000）。
     * 让值与显示同口径，换来的是「配置、注释、界面」三处一致；代价是比 2^19 少报 2.3%（12288 token），
     * 对一个推断值而言无关紧要。**不要改回 524288**——那会让界面重新变成 "524K"。
     */
    else if (/agnes[-_]/.test(id)) { context_window = 512000; }
    else if (/seedance|seed[-_]/.test(id)) { context_window = 131072; } // Seedance
    else if (/sonic[-_]|ep-.*sonic/.test(id)) { context_window = 131072; } // 字节 Sonic
    else if (/flux[-_]/.test(id)) { context_window = 4096; } // FLUX 图像生成
  }


  // ── 视觉支持推断（扩展模型覆盖面）──
  const hasVision = /vision|vl|iv|image|gpt[-_]4o[-_]image|claude[-_][^-]*op?us[-_]|gemini[-_].*flash|agnes[-_].*flash|doubao[-_].*vision|glm[-_].*vision/.test(id);

  // ── 最大输出推断：能力表 > 旧启发式 ──
  let max_output: number | undefined = caps.maxOut;
  if (max_output === undefined) {
    if (/o1[-_]/.test(id) || /o3[-_]/.test(id)) { max_output = 100000; }
    else if (/claude[-_]/.test(id)) { max_output = 8192; }
    else if (/gpt[-_]/.test(id)) { max_output = 16384; }
    else if (/deepseek[-_]/.test(id)) { max_output = 8192; }
    else if (/agnes[-_]/.test(id)) { max_output = 65536; } // Agnes: 65.5K
    else if (/gemini[-_]/.test(id)) { max_output = 8192; }
  }

  return { context_window, vision: hasVision, max_output };
}

/**
 * 把「本次 enrich 探测结果」与「已保存值」合并（纯函数，可单测）。
 *
 * 优先级：**手填 > 本次探测 > 旧值**。
 *   ① **手填**（`price_source === "manual"`）永不被覆盖 —— 用户填的可能是议价/合同价，或按
 *      瞬时峰谷档精确记账的口径，自动覆盖会抹掉这个信息。要恢复自动：在面板清空单价输入框即可。
 *   ② **本次探测给了价就用它，`0` 也算「给了」** —— 这条很关键：官方"限时免费"会探测到 0，
 *      旧逻辑把 0 当"没有值"而回退到旧的非零价，等于**给免费模型凭空计费**。
 *   ③ 都没给 → 保留旧值（可能是历史遗留的错值，但至少不丢用户数据）。
 *
 * ⚠️ 为什么必须做这个合并：`saveProvider` / `refreshProviderModels` 都是拿 enrich 的全新结果
 * 覆盖 models 数组，若不合并，用户手填的价格会在"一键刷新"后**静默消失**。
 *
 * A-988c：`price_tiers`（用户自定义分时）**与手填价同级、永不被覆盖**（见下方 ⓪）。
 * 它的信号量级比单个数字更大 —— 用户为此填了一整张时段表，被抹掉是远比"丢一个价"严重的损失。
 */
export function mergeModelPrice(
  prev: Pick<ModelSpec, "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd" | "price_source" | "price_tiers" | "price_currency"> | undefined,
  next: Pick<ModelSpec, "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd" | "price_source" | "price_tiers" | "price_currency">,
): Pick<ModelSpec, "price_in_usd" | "price_out_usd" | "price_cache_read_usd" | "price_cache_write_usd" | "price_source" | "price_tiers" | "price_currency"> {
  // ⓪ 自定义分时是最强的用户意图表达（一整张时段表），无条件保留旧值。
  //    唯一能清掉它的入口是面板里的「关闭」按钮（那会显式把 price_tiers 置为 undefined，
  //    走的是用户主动保存路径，不经过本函数的新值分支）。
  const keepTiers = prev?.price_tiers;
  // A-990：用户手选的币种同理 —— 自动探测**永远不产出** price_currency，
  // 所以这个字段唯一的变化来源就是用户操作。不在这里保留，一键刷新就会把它抹掉，
  // 表现是"我明明选了 ¥，刷新一下自己变回 $"（用户会认为是随机行为，根本查不到原因）。
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

/**
 * 解析某模型应使用的兜底定价（USD / 1M tokens）。
 *
 * 演进说明（A-970 定价事故复盘）：本函数此前是一张**手工维护的 baseUrl→模型名→价格**表，
 * 与 shared/gen/model-capabilities.ts 的能力表构成**第二份真相源**，两者长期漂移，
 * 并叠加了两类硬伤（实测导致 1606 条 usage 记录 **100% 成本为 0**）：
 *   1. **单位错**：deepseek/moonshot/groq/glm 这些条目把"已经是美元"的刊例价又按人民币
 *      除了一次 7.25（`0.14 / 7.25`）→ 成本整体缩水 7.25 倍（且浮点常量读不出换算来源，极难发现）；
 *   2. **覆盖窄 + 漏匹配**：只认十几个域名，任意自建网关/中转站/新厂商一律 `return {}` → 无价；
 *      模型正则也漏（deepseek 只匹配 chat|reasoner|v4，`deepseek-flash` 完全不命中 → 直接无价）。
 *
 * 现在改为：**价格统一由家族能力表（resolveModelPriceTier / inferModelPricing）提供**，
 * 本函数只保留一件"必须知道 baseUrl 才能判断"的事 —— 本地推理端点（跑在自己机器上，没有 API 账单）。
 *
 * 返回值三态语义（**必须区分，不能合并**）：
 *   - `0`         → 免费（官方限时免费 / 本地推理）→ 成本恒为 0 是**正确结果**
 *   - `> 0`       → 有价
 *   - `undefined` → **未定价**：表里没有已核实的价 → 上层存 undefined → UI 显示"未定价 · 可填写"
 *                   （宁可留空让用户填，也不编造 —— 错的低价比没有价格危害大得多）
 *
 * 第三参 `at`（分时定价）：给了时刻就返回**该时刻的档位价**（DeepSeek 等峰谷计费），
 * 并通过 `tier_id` 回传命中的档位。不回传档位语义会造成一个很隐蔽的坑：
 * 同一个模型在高峰/空闲下算出两个不同的价，而调用方只看到"价变了"，无法判断是调价还是换档。
 * 不传 `at`（面板展示 / enrichModels 预填）→ 返回平铺价（高峰标准价），结果**确定不随时间跳动**。
 */
export function inferPricingFromUrl(baseUrl: string, modelId: string, at?: Date | string | number): {
  price_in_usd?: number;
  price_out_usd?: number;
  price_cache_read_usd?: number;
  /** 分时定价命中的档位 id（如 "peak"/"offpeak"）；无分时规格时 undefined */
  tier_id?: string;
} {
  const base = (baseUrl ?? "").toLowerCase();
  // 本地 / 内网推理端点：跑在自己的机器上，没有按 token 计费的账单 → 显式 0（"免费"而非"未定价"）
  // 判定统一走共享的 isLocalEndpoint（engine.recordUsage 用同一个函数决定"要不要套官方价"，
  // 两处必须给同一个答案，否则会出现"面板说免费、引擎按官方价记账"的分裂）
  if (isLocalEndpoint(base)) {
    return { price_in_usd: 0, price_out_usd: 0, price_cache_read_usd: 0 };
  }
  // 分时规格优先：有规格且给了时刻时，pricing 就是该时刻的档位价（否则等同平铺价）
  const r = resolveModelPriceTier(modelId, at);
  return {
    price_in_usd: r.pricing.priceIn,
    price_out_usd: r.pricing.priceOut,
    price_cache_read_usd: r.pricing.priceCacheRead,
    tier_id: r.tiered ? r.tierId : undefined,
  };
}

/**
 * 价格取值优先级（纯函数，可单测）：**手填 > 上游探测 > 内置价目表 > 历史残留值**。
 *
 * 为什么是这个顺序：
 *   - **手填最优先**：用户填的可能是议价/合同价，或想按瞬时峰谷档精确记账，机器不该覆盖它
 *     （面板里清空该输入框即可恢复自动取值）。
 *   - **上游次之**：网关 /api/pricing、/v1/models 回传的是**本网关的真实结算价**，比任何离线表都准。
 *   - **内置表再次**：离线兜底，可能滞后于官方调价，但远好过"没有价"。
 *   - **历史残留值垫底**：⚠️ 关键。旧配置里存着机器推断的错值（如 deepseek-v4-pro 的
 *     0.0193 = 把美元价又按人民币除了一次汇率），若让"已有值"压住新价目表，就形成
 *     **错值自杀锁** —— 刷新多少次都改不动（与 context_window 同款教训）。
 *
 * 返回 `source` 会写回 ModelSpec：UI 用它标注可信度，下次刷新用它保护手填值。
 * 注意 `value: 0` 是**有意义的**（官方限时免费 / 本地推理），与"没有值"完全不同。
 *
 * ⚠️ 2026-09-18 修正（原实现写成 `upstream > 0`，把上游显式声明的 0 也当成"没给"）：
 *   上游 `0` 是**权威的"免费"声明**，不是缺失。依据：
 *     - OpenRouter 官方模型列表文档：`pricing` 各字段 "**A value of `"0"` indicates the
 *       feature is free**"，字段不存在才用省略表达（"Price keys absent from an entry
 *       inherit the base price"）—— 即"0"与"缺失"是两种不同的信号；
 *     - Google AIP-149《Unset field values》：需要区分"有意义的默认值（0/false/空串）"与
 *       "未设置"时，**必须**做 presence tracking（TS 里就是 `number | undefined`）；
 *     - Google JSON Style Guide 同型先例：`"balance": 0` 必须保留，因为 0 是有意义的取值。
 *   本文件另外三处早就按这个语义写：`parseUsdPerMillion`（"`0` 被如实返回，而不是当成
 *   '没有值'"）、`mergeModelPrice`（"`0` 也算「给了」"）、`inferPricingFromUrl`（本地端点
 *   返回 0 = 免费）。**唯独这里残留 `> 0`，等于在最后一跳把上游免费声明丢掉**，
 *   然后回落到内置表非零价 → **给免费模型凭空计费**（与"免费档被付费档吃掉"同一族事故，
 *   方向是高估）。三条依据 + 三处同源实现一致，故统一为"上游给了就算给了（含 0）"。
 *   上游确实不打算声明价格时，走的是**字段缺失**（undefined）而不是填 0。
 */
export function resolvePrice(
  saved: number | undefined,
  savedIsManual: boolean,
  upstream: number | undefined,
  table: number | undefined,
): { value?: number; source?: "upstream" | "table" | "manual" } {
  if (savedIsManual && typeof saved === "number") { return { value: saved, source: "manual" }; }
  // `typeof upstream === "number"` 而非 `upstream > 0`：0 是"上游声明免费"，必须原样采纳
  if (typeof upstream === "number") { return { value: upstream, source: "upstream" }; }
  if (typeof table === "number") { return { value: table, source: "table" }; }
  if (typeof saved === "number") { return { value: saved, source: undefined }; }
  return {};
}

/**
 * 由「已保存的供应商表」构造**历史成本回填**用的价格解析器（纯函数，可单测）。
 *
 * `usage.jsonl` 的 `cost_usd` 是写入那一刻算好并固化的。实测 1606 条记录 **100% 为 0**
 * （总消耗 $0.0000），根因是写入时价格表全线失守 —— 修正价格表之后，历史记录不会自己变，
 * 必须用当前价格重算一遍（`rewriteUsageCosts` + `slime:usage:recompute`）。
 *
 * 取价规则（**刻意不完全等同于 `resolvePrice`**）：
 *   ① 手填（`price_source === "manual"`）→ 直接采信，用户可能是议价/合同价。
 *   ② 上游探测（`price_source === "upstream"`）→ 直接采信，那是本网关的真实结算价。
 *   ③ 其余（**含 `price_source === undefined` 的历史脏值**）→ 以**当前内置价目表**重新推断。
 *      这一步正是本函数存在的理由：旧配置里躺着 deepseek-v4-pro 的 `0.0193`（美元刊例价
 *      又被按人民币除了一次 7.25）、以及大量 `undefined`（`deepseek-flash` 正则漏匹配）。
 *      若沿用"已存值优先"，这些错值会被原样拿去算钱 → 错值自杀锁。表里查不到才退回存的值。
 *      分时定价（DeepSeek 峰谷）：③ 会传**该记录自己的 `ts`**，按当时档位取价。历史记录因此
 *      能精确到"那一条落在高峰还是空闲"，而不是按今天此刻的档位一刀切。
 *      ① ② 走的是单一数值（手填/上游只给了一个价），**不参与分时** —— 用户与网关说了算。
 *   ④ 供应商已从表里删除 → 仍按模型 ID 走价目表，保住历史账目的可读性。
 */
export function makePriceResolver(table: ProvidersTable): PriceResolver {
  // 预热索引：上千条记录 × 每供应商几十个模型，逐条线性 find 会退化成 O(n·m)
  const index = new Map<string, ProviderRecord>();
  for (const [key, rec] of Object.entries(table ?? {})) {
    if (key.startsWith("_")) { continue; } // _local_models 等元数据键，不是真供应商
    index.set(key, rec);
  }

  return (providerKey: string, model: string, ts?: string): UsagePrice | undefined => {
    const rec = index.get(providerKey);
    const specs = Array.isArray(rec?.models) ? rec.models : [];
    const hit = specs.find((m) => m.id === model);
    /*
     * A-988c：**本函数不再自建一套优先级**，直接调 `resolveEffectivePricing`。
     *
     * 旧实现手写了 ①手填/上游 ②本地 0 ③内置表 ④存值 四条分支 —— 是"三处各写一遍"里的第三处。
     * 它在 A-988c 之后立刻出了偏差：看不到 `price_tiers`（用户自定义分时档），
     * 于是"重算历史成本"算出来的口径与当时实际记账的口径不一致 ——
     * 用户点了重算，历史账单反而和实时账单对不上（比不算还糟）。
     * 供应商已被删除（rec 为 undefined）时仍按模型 ID + 内置表算，保住历史账目可读性。
     */
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

/** 生产入口：读盘取表后构造解析器（`makePriceResolver` 的 I/O 外壳） */
export function buildPriceResolver(): PriceResolver {
  return makePriceResolver(loadTable());
}

/**
 * 基于模型 ID 推断是否支持 Thinking 模式。推理等级为【兜底推断】——真正的等级
 * 必须以上游 /models 返回的 reasoning.supported_efforts 为准（enrichModels 里优先取上游）。
 * A-918+ 单源合并：能力预制表已收敛到 shared/model-capabilities.ts（MODEL_CAPABILITIES），
 * 本函数与 renderer 端 REASONING_PRESETS 共用同一来源，杜绝双份数据漂移。
 */
function inferThinkingSupport(modelId: string): { supported: boolean; efforts?: string[] } {
  const cap = inferModelCapabilities(modelId);
  return { supported: cap.supported, efforts: cap.efforts };
}

export async function enrichModels(baseUrl: string, apiKey: string, format: ApiFormat = "auto"): Promise<{ ok: boolean; models?: ModelSpec[]; api_format?: ApiFormat; error?: string }> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base) { return { ok: false, error: "Base URL 不能为空" }; }
  if (!apiKey.trim()) { return { ok: false, error: "API Key 不能为空" }; }

  // 第零步：端点格式自动探测（format=auto 时），比 baseUrl 字符串推断更可靠。
  // 探测结果写入每个 ModelSpec.api_format，供引擎按模型路由端点（聚合网关多端点场景）。
  // auto 模式优先用「真实响应探针」（probeProvider：发一次握手看真实响应定厂商+格式），
  // 置信度高则采用其 apiFormat；置信度不足（证据少/无模型列表）才回退纯 URL 推断 detectApiFormat。
  let effectiveFormat: ApiFormat = format;
  if (format === "auto") {
    const p = await probeProvider(baseUrl, apiKey);
    if (p.ok && p.result && p.result.confidence >= 0.6 && p.result.apiFormat) {
      effectiveFormat = p.result.apiFormat;
    } else {
      effectiveFormat = await detectApiFormat(baseUrl, apiKey);
    }
  }

  // 第一步：拉取原始模型 ID 列表（按探测到的格式适配端点探测）
  const fetchRes = await fetchModels(baseUrl, apiKey, effectiveFormat);
  if (!fetchRes.ok || !fetchRes.models) {
    return { ok: false, error: fetchRes.error };
  }
  const baseModels = fetchRes.models;

  // 第二步：尝试从上游拉取完整元数据（OpenRouter 等中转站格式）
  const upstreamDetails = await fetchUpstreamDetails(baseUrl, apiKey.trim(), effectiveFormat);

  // 第三步：为每个模型填充元数据
  // 优先级：上游详情 > ID 启发式推断 > 用户已有值
  const models = baseModels.map((m) => {
    const upstream = upstreamDetails.get(m.id);

    // context_window：**唯一决策点 = providerCtxWindow()**（优先级与"S5 本地端点不兜底"的理由
    // 全写在那个函数上方的注释里 —— 别再在这里就地拼一条并行链路）。
    // ⚠️ 为什么家族表要压过「已有保存值」：值一旦被写错（如小红书 dots 曾按 128K 落库），
    // 老逻辑「上游 > 已有 > 推断」在网关不回传窗口时会永远沿用错值 —— 用户反复点刷新也仍是 128K
    // （"一直刷新默认为128K"的根因）。家族表是人工核对的单一真相源，命中即纠正（仅远端）。
    const ctxWindow = providerCtxWindow({
      baseUrl,
      modelId: m.id,
      upstreamCtx: upstream?.context_length,
      savedCtx: typeof m.context_window === "number" ? m.context_window : undefined,
    });

    // ── pricing：优先级 = 上游探测 > 内置价目表 > 传入的已有值（见 resolvePrice 注释）──
    // 旧写法 `priceIn && priceIn > 0 ? ... : (m.price_in_usd ?? 推断)` 有两个致命问题：
    //   ① "已有值"压住价目表 → 历史错值永远纠正不了（错值自杀锁）；
    //   ② 0 被折叠成 undefined → "官方限时免费"与"完全不知道价格"混为一谈。
    // ⚠️ 「手填价保护」不在这里做：本函数由 fetchModels/refresh/save 调用，**传入的 models 只有
    //    `{id}`**（fetchModels 的产物），拿不到已保存的 price_source。手填保护统一在
    //    mergeModelPrice（saveProvider / refreshProviderModels 的合并点）完成。
    const fallbackPricing = inferPricingFromUrl(baseUrl, m.id);
    const rIn = resolvePrice(m.price_in_usd, false, upstream?.pricing?.prompt, fallbackPricing.price_in_usd);
    const rOut = resolvePrice(m.price_out_usd, false, upstream?.pricing?.completion, fallbackPricing.price_out_usd);
    const rCacheRead = resolvePrice(m.price_cache_read_usd, false, upstream?.pricing?.promptCacheRead, fallbackPricing.price_cache_read_usd);
    const rCacheWrite = resolvePrice(m.price_cache_write_usd, false, upstream?.pricing?.promptCacheCreate, undefined);

    // 分档计费：上游 > 已有值（isAggregatorGateway 的网关特别有意义——new-api/one-api 的
    // billing_expr 真实存在；UI 拿到后可提示"该模型按上下文长度加价"）
    const tieredUpstream = upstream?.pricing?.tiered;
    const pricingTiered = tieredUpstream?.tiered ?? (m.pricing_tiered === true);
    const pricingFormula = tieredUpstream?.raw ?? m.pricing_formula;
    const pricingMode = upstream?.pricing?.billingMode ?? m.pricing_mode;

    /*
     * A-988d：上游声明的**时段档**与**上下文长度档**，采集为"候选"而不是直接生效。
     *
     * 为什么只采集：上游 overrides 是 UTC 口径、且只描述"例外时段"，直接套用会把时区语义
     * 搞错 8 小时，还会丢掉非命中时段的基准价。所以它只落成 `pricing_time_tiers_candidate`，
     * 由用户在分时编辑器里点「导入上游时段」才变成生效的 `price_tiers`（那一步是显式意图）。
     * `pricing_context_tiers` 纯展示：slime 的取价没有"按上下文长度"这一维，套上去只会算错。
     */
    const timeOv = upstream?.pricing?.timeOverrides;
    const timeTiersCandidate = timeOv && timeOv.length > 0
      ? overridesToPriceTiers(timeOv, rIn.value ?? 0, rOut.value ?? 0)
      : undefined;
    const contextTiers = upstream?.pricing?.contextTiers;
    const perRequest = upstream?.pricing?.perRequest;

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

    // 端点：中转站统一 openai（chat/completions）；官方端点用能力表原生 endpoint
    // （gpt-5→responses、claude→anthropic、gemini→google），能力表未标（缺省 openai）则回退供应商级探测。
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
      // A-988d：上游分时/长度分档与按次价的**采集**（候选，不参与取价）
      pricing_time_tiers_candidate: timeTiersCandidate ?? m.pricing_time_tiers_candidate,
      pricing_context_tiers: contextTiers ?? m.pricing_context_tiers,
      pricing_per_request: perRequest ?? m.pricing_per_request,
      selected: m.selected !== false,
      api_format: modelEndpoint,
    };
  });

  return { ok: true, models, api_format: effectiveFormat };
}

/**
 * 自动探测 baseUrl 的端点格式（比 inferApiFormat 的字符串推断更可靠）：
 * 用 /v1/models 分别试 Bearer（OpenAI 兼容）与 x-api-key + anthropic-version（Anthropic Messages），
 * 哪个鉴权头能通过就判定为哪种格式。很多 Anthropic 兼容网关的 baseUrl 不含 "anthropic"，
 * 字符串推断会误判为 openai；实测 opencode 的 /v1/messages 用 Bearer 返回 401、x-api-key 才通过。
 * 返回 "auto" = 两种都未通过（交给调用方兜底 / 用户手动指定）。
 */
export async function detectApiFormat(baseUrl: string, apiKey: string): Promise<ApiFormat> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return "auto"; }
  // Google 原生端点：baseUrl 含 generativelanguage.googleapis.com / googleapis（x-goog-api-key 鉴权）
  if (/generativelanguage\.googleapis\.com|googleapis\.com/i.test(base)) { return "google"; }
  const urls = [`${base}/v1/models`, `${base}/models`];
  // 先 Bearer（OpenAI 兼容占多数，命中率高），后 x-api-key（Anthropic 网关）
  const headerSets: Array<{ openai: boolean; headers: Record<string, string> }> = [
    { openai: true, headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" } },
    { openai: false, headers: { "x-api-key": apiKey.trim(), "anthropic-version": "2023-06-01", Accept: "application/json" } },
  ];
  for (const { openai, headers } of headerSets) {
    for (const url of urls) {
      try {
        const res = await chromiumFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) { return openai ? "openai" : "anthropic"; }
      } catch { /* 下一个候选 */ }
    }
  }
  return "auto";
}

/**
 * 探针层第 1 层出口：对单个供应商做一次「厂商指纹识别」。
 * 复用现有鉴权头候选逻辑发一次握手（不实际扣费），记录命中端点 + 鉴权方式 + 模型数 + 是否有公开 pricing，
 * 喂给 core-ts 的 probe() 识别器，输出厂商类别 / 应使用的 ApiFormat / 能力字段方言 / 置信度。
 *
 * 与 detectApiFormat（只看 URL 猜）互补：本函数看真实响应定，覆盖官方/中转/自建 OpenAI 兼容网关。
 * 调用方（添加供应商流程）可用其结果自动补全 api_format + 能力字段，提升全平台适配面。
 */
export async function probeProvider(baseUrl: string, apiKey: string): Promise<{
  ok: boolean;
  result?: ProbeResult;
  error?: string;
}> {
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  if (!base || !apiKey.trim()) { return { ok: false, error: "Base URL / API Key 不能为空" }; }

  const key = apiKey.trim();
  // 鉴权头候选（命中哪套记录哪套）：OpenAI 兼容 / Anthropic / Google
  const headerSets: Array<{ auth: ProbeObservation["auth"]; headers: Record<string, string> }> = [
    { auth: "bearer", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    { auth: "x-api-key", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", Accept: "application/json" } },
    { auth: "x-goog-api-key", headers: { "x-goog-api-key": key, Accept: "application/json" } },
  ];
  // 模型列表端点候选（全平台，含聚合网关）
  const endpoints: string[] = [
    `${base}/v1/models`,
    `${base}/models`,
    `${base}/api/v1/models`,
    `${base}/v1beta/models`,
  ];

  // 发一次握手：找第一个「鉴权 + 端点」能拿到模型列表的组合
  let observed: ProbeObservation | null = null;
  let pricingSeen = false;
  for (const hs of headerSets) {
    for (const url of endpoints) {
      const t0 = Date.now();
      try {
        const res = await chromiumFetch(url, { headers: hs.headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
      } catch { /* 下一候选 */ }
    }
    if (observed) { break; }
  }

  // 顺手探一次 /api/pricing（聚合网关特征，new-api 系）
  try {
    const pres = await chromiumFetch(`${base}/api/pricing`, {
      headers: headerSets[0].headers,
      signal: AbortSignal.timeout(5000),
    });
    pricingSeen = pres.ok;
    if (observed) { observed.hasPricing = pricingSeen; }
  } catch { /* 忽略 */ }

  if (!observed) {
    // 没探到模型列表（可能是鉴权方式特殊或需手动指定端点）——退回按 URL 识别，仍给个结果
    const fallback: ProbeObservation = { endpoint: base, auth: "none", modelCount: 0 };
    const result = probe(fallback, base);
    return { ok: true, result };
  }
  const result = probe(observed, base);
  return { ok: true, result };
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
  // responses 与 openai 共用 OpenAI 风格的模型列表端点（/v1/models 等，Bearer 鉴权）
  if (format === "openai" || format === "responses" || format === "auto") {
    candidates.push(`${base}/v1/models`);
    candidates.push(`${base}/models`);
    candidates.push(`${base}/api/v1/models`);
  }
  if (format === "anthropic" || format === "auto") {
    // Anthropic 官方/网关模型列表端点形态：/v1/models 与 /models
    candidates.push(`${base}/v1/models`);
    candidates.push(`${base}/models`);
  }
  if (format === "google") {
    // Google Gemini 模型列表端点：/v1beta/models
    candidates.push(`${base}/v1beta/models`);
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
  // 端点格式：用户显式指定 > 自动探测 > 已有 > auto
  let detectedFormat: ApiFormat | undefined;
  // 若 models 未提供但 api_base 与 api_key 均已填写，自动 enrich 填充
  if (models === undefined && input.api_key !== undefined && base && input.api_key.trim()) {
    const enriched = await enrichModels(base, input.api_key.trim(), input.api_format ?? "auto");
    if (enriched.ok && enriched.models) {
      detectedFormat = enriched.api_format && enriched.api_format !== "auto" ? enriched.api_format : undefined;
      // 保留用户手动填写的 context_window / max_output（若有）
      const prevModels = sanitizeModels(prev.models) ?? [];
      models = enriched.models.map((m) => {
        const prev = prevModels.find((p) => p.id === m.id);
        return prev
          ? {
              ...m,
              // ⚠️ 只在本次 enrich **没给出值**时回填旧值。旧写法 `prev.context_window ?? m.context_window`
              // 会让历史错值（512K 被写成 128K）反过来压过刚探测出的正确值 → 刷新多少次都改不动。
              context_window: m.context_window && m.context_window > 0 ? m.context_window : prev.context_window,
              max_output: m.max_output && m.max_output > 0 ? m.max_output : prev.max_output,
              selected: prev.selected, vision: prev.vision,
              // 价格合并：手填价永不被覆盖（详见 mergeModelPrice）
              ...mergeModelPrice(prev, m),
            }
          : m;
      });
    }
  }
  table[key] = {
    api_base: base,
    api_key: input.api_key !== undefined ? input.api_key.trim() : (prev.api_key ?? ""),
    model: input.model !== undefined && input.model !== null ? input.model : (prev.model ?? undefined),
    api_format: input.api_format !== undefined ? input.api_format : (detectedFormat ?? prev.api_format ?? "auto"),
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
    const prev = prevModels.find((p) => p.id === m.id);
    // ⚠️ 必须过 mergeModelPrice：本函数此前直接 `{ ...m, selected }` 覆盖整条记录，
    //    于是「一键刷新」会**静默抹掉用户手填的单价**（而 mergeModelPrice 的注释一直声称
    //    saveProvider / refreshProviderModels 两处都用了它 —— 后者其实没有，是真的漏了）。
    //    影响面：议价/合同价被官方刊例价替换，且不报错、不可察觉。
    return { ...m, selected: prevSelected.has(m.id), ...(prev ? mergeModelPrice(prev, m) : {}) };
  });
  const added = nextModels.filter((m) => !prevModels.some((p) => p.id === m.id)).length;
  const removed = prevModels.filter((p) => !seen.has(p.id)).length;
  // 刷新时同步更新端点格式（探测到非 auto 时覆盖旧值，让引擎按正确端点路由）
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

/* S3：原 `localModelsOf(table)` 已删除 —— 它只是 `localModelSpecs` 的一层薄封装，
 * 而那层封装正是"过滤判据可以有第二份实现"的地方。调用点直接用 core-ts 的唯一实现。 */

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