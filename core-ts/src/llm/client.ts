/**
 * core-ts/src/llm/client.ts — OpenAI 兼容客户端（流式 SSE + 429 退避）。
 * 语义移植自 core/llm.py：_RETRY_429_BACKOFF = (5.0, 15.0, 30.0, 60.0)，最多 3 次重试。
 * 仅依赖 Node 原生 fetch（undici），零额外 HTTP 依赖。
 */

import { ChatCompletionChunk, ChatRequest, ChatResponse, ChatToolCallDelta } from "shared/schemas";
// 上游错误正文特征表的唯一实现已移到 upstreamErrorScope.ts（A-157 收敛：三处同源实现合并到这里，
// client.ts / probe-live.ts 的 modelScope / isModelDeadError / nextAuthOnFailure 都改调它，避免再漂移）。
import { modelScopeFromUpstreamText } from "../upstreamErrorScope.js";

export const RETRY_429_BACKOFF = [5.0, 15.0, 30.0, 60.0];

/** A-157：SSE 流式空闲看门狗上限（ms）。距上次「有数据」超过该值判定上游僵死
 *  （连上但不出字 / 半路断流不报错 / 网关只发头不发体），抛 timeout 交给上层重连/切模型。
 * 行业调研共识：正常 chunk 间隔毫秒级，60s 无任何字节基本可断定连接已死。
 * 支持 SLIME_STREAM_IDLE_MS 环境变量覆盖（测试/极端场景调小；与项目
 * SLIME_TOOL_MAX_ROUNDS 覆盖惯例一致）。 */
export const IDLE_STREAM_MS = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_STREAM_IDLE_MS : undefined;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) { return Math.floor(n); }
  }
  // ⚠️ 2026-09-12：60s → 300s。推理型模型（AGNES / DeepSeek-R1 / o 系）在长思考阶段
  // 可能**长时间不吐任何 token**（上游把思考缓存在服务端再一次推送），60s 会被误判为"上游僵死"
  // → 抛"流式空闲超时" → Router 因"已收到部分内容不降级"直接中断 → 用户看到**莫名其妙的中途截断**。
  // 该看门狗的本意是兜底"连接真的死了"，而非惩罚"思考慢"，故放宽到 5 分钟；
  // 仍支持 SLIME_STREAM_IDLE_MS 环境变量覆盖（测试/极端场景调小）。
  return 300_000;
})();

/** A-980：LLM 请求级超时（从「请求发起」到「拿到响应头」）默认值。
 *  ⚠️ 2026-09-14：120s → 300s。此前默认 120s 对**思考型模型**过紧——上游（云端网关/本地推理服务）
 *  在模型长时间思考时会**长时间不返回任何字节**（服务端排队 + 首 token 前不 flush 响应头），
 *  120s 直接 abort → 上层判定"请求超时"→ 用户看到「模型明明在动、回复却直接截断」。
 *  放宽到 300s（5 分钟）；正文流式阶段另有**按空闲**的看门狗 IDLE_STREAM_MS（默认 300s 无字节才判僵死）兜底，
 *  "真死"（连接断开/无字节流）仍会被及时终止，不会无限挂起。
 *  支持 SLIME_LLM_TIMEOUT_MS 环境变量覆盖（与 SLIME_STREAM_IDLE_MS / SLIME_TOOL_MAX_ROUNDS 覆盖惯例一致）。 */
export const DEFAULT_LLM_TIMEOUT_MS = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_LLM_TIMEOUT_MS : undefined;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) { return Math.floor(n); }
  }
  return 300_000;
})();

/**
 * A-1008：base URL 的尾部 API 版本段。
 *
 * 为什么必须是通配而非只认 `/v1`：厂商官方 base 常自带自己的版本号，
 * 智谱的 base 就是 `https://open.bigmodel.cn/api/paas/v4`（chat 端点 = `{base}/chat/completions`）。
 * 旧逻辑只硬化了 `/v1`，于是拼出 `/api/paas/v4/v1/chat/completions` → 上游 404，
 * 表现为「某个群成员每一轮发言都失败」（用户实测 t2 绑 `glm-4.5-air:free`，报错原文
 * `"path":"/v4/v1/chat/completions"`）。
 *
 * 也覆盖 `/v1beta`（Gemini 风格）：字母后缀一并吃掉，避免只切到数字。
 */
const VERSION_TAIL_RE = /\/v\d+[a-z]*$/i;

/** `path` 里的版本段前缀（`/v1`、`/v1beta`…）——用于在 base 已带版本时把它摘掉。 */
const LEADING_VERSION_RE = /^\/v\d+[a-z]*/i;

/**
 * A-1008：**API 端点拼接的唯一实现**（ChatClient / AnthropicClient / ResponsesClient /
 * GeminiClient / thread_worker 宿主侧全部走这里）。
 *
 * 为什么不各写一份：这条规则已经出过一次线上事故 —— `ChatClient.endpoint` 只硬化了
 * `endsWith("/v1")`，而智谱官方 base 是 `…/api/paas/v4`，于是拼出
 * `/api/paas/v4/v1/chat/completions` → 上游 404，表现为「群里某个成员每一轮发言都失败」。
 * 四处客户端各有一份等价逻辑 = 改一处漏三处（本项目对"同一规则两处实现"已有多次事故记录）。
 *
 * 规则（按顺序）：
 *   1. base 已含完整 path → 原样返回（幂等，可重复调用）；
 *   2. base 已含 path 的功能段（无版本）→ 原样返回（极端自定义网关）；
 *   3. base 尾部是任意 API 版本段 → 只补版本段之后的功能路径；
 *   4. 否则 → base + path（补上 `/v1`）。
 *
 * @param baseUrl 厂商/网关 base（尾斜杠可有可无）
 * @param path    完整端点路径，必须带版本段（如 `/v1/chat/completions`）
 */
export function joinApiEndpoint(baseUrl: string, path: string): string {
  const base = (baseUrl ?? "").replace(/\/+$/, "");
  if (!base) { return path; }
  if (base.endsWith(path)) { return base; }
  const fnPath = path.replace(LEADING_VERSION_RE, "");
  if (fnPath && base.endsWith(fnPath)) { return base; }
  if (VERSION_TAIL_RE.test(base)) { return `${base}${fnPath}`; }
  return `${base}${path}`;
}

/** A-157：把一次读取与「空闲超时」竞速——timer 触发时 reject 一个 timeout UpstreamError
 * （复用 jsonWithTimeout 同型思路，但基准是「距上次数据」而非「请求开始」）。 */
function raceIdleTimeout<T>(p: Promise<T>, idleMs: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new UpstreamError(`流式空闲超时（${idleMs}ms 无数据）`, 0, "timeout")), idleMs);
    }),
  ]).finally(() => { if (t !== undefined) { clearTimeout(t); } });
}

/** 瞬时错误状态码（A-156 扩展为 A-175：值得原地重试且不会引入语义副作用）：
 *  408 请求超时 / 429 限流 / 500 服务器内部错误 / 502 网关错误 / 503 服务过载 /
 *  504 网关超时 / 529 服务重载（Anthropic 特指）。
 *  其余 4xx（语义错误，重试不会成功）不重试。
 *  A-175：加入 500/502——OpenAI / Anthropic 官方 SDK 对 5xx 均默认指数退避自动重试两次；
 *  且 chat_completions 无状态，工具在客户端收到响应后才执行，无重复副作用风险。 */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);
/** 非 429 瞬时错误退避（秒）。429 固定走 RETRY_429_BACKOFF（与 core/llm.py 语义一致）。 */
const RETRY_TRANSIENT_BACKOFF = [1.0, 3.0, 7.0];

/** 全抖动退避（行业标准）：在 [0, maxMs] 内均匀采样（下限 1ms 兜底 setTimeout 0）。
 *  固定退避在多个客户端/多次重试同时触发时形成惊群（thundering herd），抖散后整体恢复率显著提高；
 *  仅用于瞬时/网络级退避，429 表（确定性审计）与 Retry-After（RFC 精确采纳）不抖动。 */
function jitteredDelay(maxMs: number): number {
  return Math.floor(Math.random() * maxMs) || 1;
}
/** Retry-After 采纳上限（秒）：封顶避免上游返回超长等待（如 4294967295）把请求永久挂起。 */
const MAX_RETRY_AFTER_S = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

/** 解析 RFC 7231 Retry-After（秒数或 HTTP-date）；解析失败返回 null（走默认退避表）。 */
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

/** 计算本次重试等待（ms）：Retry-After 头优先（封顶），否则 429 走 429 表、其余瞬态走瞬态表。 */
function retryDelayMs(resp: Response, attempt: number): number {
  const fromHeader = parseRetryAfterSeconds(resp.headers);
  if (fromHeader !== null) { return Math.min(fromHeader, MAX_RETRY_AFTER_S) * 1000; }
  const table = resp.status === 429 ? RETRY_429_BACKOFF : RETRY_TRANSIENT_BACKOFF;
  return (table[attempt] ?? 60) * 1000;
}

/** 合并外部取消信号与超时控制器：外部信号先到则整体中止。 */
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

/** json() 正文读取超时（A-156，OpenAI SDK #1825 同型：headers 到达即清超时后正文读取可能永久挂起）。
 *  将 resp.json() 与 deadline 竞速，超时抛 UpstreamError(timeout)，杜绝上游「只发头不发体」卡死调用方。 */
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

/**
 * 网络级重试（A-153 扩展为 A-156，A-175 对齐厂商 SDK 默认）：
 * - 429 固定走 RETRY_429_BACKOFF（沿用语义，测试锚定 5,15,30,60 不变）；
 * - 408/500/502/503/504/529 走 RETRY_TRANSIENT_BACKOFF（1/3/7s，全抖动）；
 * - 优先采纳 Retry-After 头（封顶 MAX_RETRY_AFTER_S，精确采纳不抖动）；
 * - 网络瞬时错误（undici "fetch failed" / ECONNRESET / 连接重置）同样退避重试，仅最后一次尝试抛出；
 * - 其余 4xx（语义错误，重试不会成功）不重试。
 * A-175：500/502 此前被排除（担心结果已产生→重复计费）。但 chat_completions 是无状态请求，
 * 工具/写操作都在客户端收到响应后才执行，重试不会引入重复副作用；对齐 OpenAI/Anthropic
 * 官方 SDK「5xx 自动指数退避重试」的默认行为，换回的是连接抖动自愈（500 常见于网关瞬时故障）。
 */
async function fetchWithRetry(opts: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  maxAttempts: number;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
}): Promise<Response> {
  const { fetchImpl, url, init, maxAttempts, timeoutMs, externalSignal } = opts;
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      throw new UpstreamError("请求已取消", 0, "protocol");
    }
    const { controller, cleanup } = combineAbortSignal(externalSignal, timeoutMs);
    try {
      const resp = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!isTransientStatus(resp.status) || attempt === maxAttempts - 1) {
        return resp;
      }
      lastResp = resp;
      await sleep(retryDelayMs(resp, attempt));
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
      // A-175：网络级瞬时错误（fetch failed / ECONNRESET / 连接重置）走 1/3/7s 秒级退避
      // （此前误用 429 表 5/15/30/60——一次 WiFi 抖动要干等 15-30s，观感等同卡死/直接判死），
      // 同样加全抖动避免多路重试同时发起形成惊群。
      await sleep(jitteredDelay((RETRY_TRANSIENT_BACKOFF[attempt] ?? 7) * 1000));
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
  /** 拼接的完整文本 */
  text: string;
  /** 收到的内容 chunk 数 */
  chunks: number;
  /** 上游返回的 model 名（过滤层消费，不向用户暴露） */
  model: string;
  /**
   * 上游结束原因（`stop` / `length` / `content_filter` / `tool_calls` …）。
   * ⚠️ 必须上浮到 UI：`length` = 触达输出上限被**截断**。此前一路丢弃 → 模型写半句话就静默结束，
   * 用户既看不到错也看不到提示（"老是中途莫名截断"的根因之一）。
   */
  finishReason?: string;
  /** 上游 usage（含缓存命中 token）。流式时经 include_usage（OpenAI）/ message_delta（Anthropic）采集；
   *  非流式兜底时来自完整响应。缓存命中率监测（缓存命中率 = cache_read_tokens / (prompt_tokens + cache_read_tokens)）据此还原真实值。 */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    /** 推理/思考 token（OpenAI 兼容的 `usage.completion_tokens_details.reasoning_tokens`；DeepSeek/Qwen3/o1 系）。
     *  Anthropic 无此字段。缺失时上游/调用方按 0 处理。 */
    reasoning_tokens?: number;
    /**
     * A-974-R8：该上游的 `prompt_tokens` **是否已包含**缓存命中（cached/命中部分）。
     * - OpenAI 官方语义：`prompt_tokens` 是总量，**含** `prompt_tokens_details.cached_tokens`（AGNES 实测铁证）
     *   → 窗口占用 = prompt（不再 +cache_read，否则重复计）。
     * - Anthropic 语义：`input_tokens` **不含** `cache_read_input_tokens` → 窗口占用 = prompt + cache_read。
     * 窗口占用公式必须按此标记决定是否相加，才能"全模型全平台兼容"不虚高。
     */
    cache_read_in_prompt?: boolean;
  };
}

/** OpenAI chat.completions usage 里提取缓存命中/写入 token。
 *  - OpenAI 系：`prompt_tokens_details.cached_tokens` / `cache_write_tokens`（GPT-5.x）
 *  - **DeepSeek 系：`prompt_cache_hit_tokens`（字段名不同！）**——此前只读 prompt_tokens_details，
 *    导致 DeepSeek 系网关（含各类中转）缓存命中恒 0、右栏「平均命中」恒 0%（A-974-R6 修复）。
 *  - `prompt_cache_miss_tokens` 不单独计入：未命中部分本就在 prompt_tokens 里，重复计会虚高。 */
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

/** OpenAI chat.completions usage 里提取推理 token（`completion_tokens_details.reasoning_tokens`；
 *  DeepSeek/Qwen3/o1 系放这里；部分网关直接顶层给 `reasoning_tokens`。Anthropic 无此字段）。 */
function openAIReasoningTokens(usage: unknown): number | undefined {
  const dt = (usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)?.completion_tokens_details;
  const nested = typeof dt?.reasoning_tokens === "number" ? dt.reasoning_tokens : undefined;
  const top = (usage as { reasoning_tokens?: number } | undefined)?.reasoning_tokens;
  const raw = typeof nested === "number" ? nested : top;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : undefined;
}

/** 归一化 usage 为统一形态（OpenAI 兼容字段 + 缓存命中/写入 token），供 done 事件透传。 */
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
  // 推理 token：优先嵌套 completion_tokens_details（OpenAI/DeepSeek/Qwen3），再回退顶层
  const rt = openAIReasoningTokens(usage);
  if (rt !== undefined) { out.reasoning_tokens = rt; }
  // A-974-R8：OpenAI 风格 `prompt_tokens` 是总量（含 cached/hit）→ 标记 cache_read_in_prompt=true
  out.cache_read_in_prompt = true;
  return Object.keys(out).length ? out : undefined;
}

/** 归并 Anthropic usage（message_start 的 input 侧 + message_delta 的 output 侧）为统一形态。 */
function mergeUsage(
  base: NonNullable<ChatStreamResult["usage"]> | undefined,
  u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): NonNullable<ChatStreamResult["usage"]> {
  const out = { ...(base ?? {}) } as NonNullable<ChatStreamResult["usage"]>;
  if (typeof u.input_tokens === "number") { out.prompt_tokens = u.input_tokens; }
  if (typeof u.output_tokens === "number") { out.completion_tokens = u.output_tokens; }
  if (typeof u.cache_read_input_tokens === "number") { out.cache_read_tokens = u.cache_read_input_tokens; }
  if (typeof u.cache_creation_input_tokens === "number") { out.cache_creation_tokens = u.cache_creation_input_tokens; }
  // A-974-R8：Anthropic 的 `input_tokens` 不含 cache → 窗口占用须 prompt + cache_read（标记 false）
  out.cache_read_in_prompt = false;
  return out;
}

/** 非流式完成对象中可被恢复的「消息形态」字段（choices[0].message）：
 *  正文 / 思考（reasoning_content）/ 工具调用（tool_calls）/ 顶层 model。 */
interface NonStreamMessage {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  model?: string;
}

/** 从累积的非 `data:` 行文本中提取消息形态对象（choices[0].message）。
 *  覆盖单行/多行 JSON、SSE 注释/空行混入：整体解析失败则截取首个 `{` 到末个 `}` 再试。
 *  A-149：部分网关忽略 stream:true 直接返回非流式完整 JSON（无 data: 前缀）。 */
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

/** 从 reasoning（思考）文本恢复「最终答案段」——仅当正文（content）全空时兜底（A-150）。
 *  部分上游（ling 系等）把含最终回答的整块输出放进 delta.reasoning 而非 content，
 *  流结束后若正文仍为空，从思考尾部取最后一段非空块作为正文，避免静默空回复。
 *  纯标记/标点片段（如 "*"、"-"）不算答案，回退上一个块。 */
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

/** 完整 tool_calls（非流式 message 或 message 形态 SSE 块）→ 按 index 编号的增量列表。
 *  与 A-149 非流式兜底共用同一映射：name/arguments 整体作为单个 delta 下发（accumulator 按 index 拼接）。 */
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

/** SSE chunk 的「内容形态」：OpenAI 标准是 choices[0].delta；对不支持真流式的模型，
 *  网关（one-api/new-api 系）会缓冲后以 choices[0].message 单块返回；OpenAI 新 AsyncAPI
 *  则用 choices[0].messages 数组。三者逐字段回退，任何形态的正文/思考/工具调用都不会丢。
 *  注意：delta 形态的 tool_calls 是增量碎片（保留原 index 供调用方按 index 拼接），
 *  message 形态才是完整对象（按枚举编号整体下发）。 */
interface ChunkFields {
  content?: unknown;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: unknown;
}

/** 从 chunk 中提取正文：字符串原样、content-blocks 数组拼接 text 块。 */
function chunkText(v: unknown): string {
  if (typeof v === "string") { return v; }
  if (Array.isArray(v)) {
    return v
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** 取「最终内容源」：delta 优先，缺字段时回退 message/messages 末条（逐字段等价）。 */
function pickChunkFields(choice: ChatCompletionChunk["choices"][number]): { d: ChunkFields | undefined; m: ChunkFields | undefined } {
  const d = choice.delta as ChunkFields | undefined;
  const c = choice as unknown as {
    message?: ChunkFields | undefined;
    messages?: ChunkFields[] | undefined;
  };
  return { d, m: c.message ?? c.messages?.slice(-1)[0] };
}

/**
 * 请求体里「思考/推理」相关字段的**唯一清单**（router 与 client 共用同一份）。
 * 用途有两个：
 *   ① 换模型时先清除，避免把 A 模型的协议参数发给 B 模型（Agnes 的 chat_template_kwargs ≠ OpenAI 的 reasoning_effort）；
 *   ② 上游以 400 拒绝时，剥掉这些字段重试一次——把「整请求失败」降级为「本次无思考但可用」。
 */
export const REASONING_PAYLOAD_KEYS = [
  "reasoning_effort",
  "chat_template_kwargs",
  "enable_thinking",
  "return_reasoning",
  "thinking",
] as const;

/** 请求体是否携带了思考参数 */
export function hasReasoningKeys(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") { return false; }
  const p = payload as Record<string, unknown>;
  return REASONING_PAYLOAD_KEYS.some((k) => k in p);
}

/** 浅拷贝并剥除全部思考参数（其余字段原样保留） */
export function stripReasoningKeys<T>(payload: T): T {
  if (!payload || typeof payload !== "object") { return payload; }
  const out = { ...(payload as Record<string, unknown>) };
  for (const k of REASONING_PAYLOAD_KEYS) { delete out[k]; }
  return out as unknown as T;
}

/**
 * 判断 400 错误是否因「思考参数不被识别」——只有这类错误剥参重试才有意义。
 * 其它 400（模型不可用 / 区域限制 / 内容审查等）剥参重试也还是 400，纯浪费一次请求。
 * 判定：错误信息含「否定/无效」措辞，且同时含「参数/思考」相关词。
 */
export function isUnrecognizedParamError(bodyText: string): boolean {
  const t = (bodyText ?? "").toLowerCase();
  if (!t) { return false; }
  const reject = /(unrecogni[sz]ed|unknown|unexpected|extra|invalid|unsupported|not supported|does not support|doesn't support|无法识别|不支持|无效|未知|不识别)/;
  if (!reject.test(t)) { return false; }
  return /(param|argument|field|key|reasoning|thinking|effort|template|enable|参数)/.test(t);
}

/** reasoning_effort → Anthropic `thinking.budget_tokens`（Anthropic 要求 ≥1024） */
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

/**
 * 构造 Anthropic Messages 协议的思考开关：
 *   - 若上游（引擎/能力表）已给出 `thinking` 对象 → 原样转发；
 *   - 否则若给了 `reasoning_effort` → 归一为 `thinking:{type:"enabled", budget_tokens}`（Anthropic 不认 reasoning_effort）；
 *   - 都没有 → 返回空对象（不开思考）。
 */
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
  /** A-157：模型级"/"供应商级"错误作用域（router 降级判定用，"model" 可换模型恢复） */
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
}

export class ChatClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

  /**
   * 端点容错：上游网关 base URL 形态各异（无 /v1 / 含 /v1 / 含 /v4… / 已含完整路径 / 尾斜杠）。
   * 规则与实现统一在 `joinApiEndpoint`（见其注释：智谱 `…/api/paas/v4` 曾被拼成
   * `/v4/v1/chat/completions` → 上游 404）。
   */
  private endpoint(kind: "chat" | "embeddings"): string {
    return joinApiEndpoint(this.baseUrl, kind === "chat" ? "/v1/chat/completions" : "/v1/embeddings");
  }

  private async requestWithRetry(
    url: string,
    init: RequestInit,
    maxAttempts: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    // A-156：瞬态状态码重试 + Retry-After 头 + 网络级重试统一在 fetchWithRetry（模块级）实现，
    // ChatClient 与 AnthropicClient 共用同一策略，避免两套重试逻辑漂移。
    return fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url,
      init,
      maxAttempts,
      timeoutMs: this.timeoutMs,
      externalSignal,
    });
  }

  private async post(url: string, payload: unknown, maxAttempts: number, externalSignal?: AbortSignal): Promise<Response> {
    const send = (body: unknown): Promise<Response> => this.requestWithRetry(
      url,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      maxAttempts,
      externalSignal,
    );
    const resp = await send(payload);
    // 400 且请求体带思考参数：上游可能不认该参数（各家族开关协议不同：reasoning_effort /
    // chat_template_kwargs / enable_thinking / thinking）。仅当错误信息确认为「参数不被识别」时，
    // 剥掉思考参数重试一次——把「整请求失败」降级为「本次无思考但可用」；仍失败则还原原始错误语义。
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

  /** 非流式 chat/completions */
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
      // 缓存命中采集：把 OpenAI prompt_tokens_details.cached_tokens / cache_write_tokens 归一化进 usage
      if (data.usage) {
        const cache = openAICacheTokens(data.usage);
        if (cache.cache_read_tokens !== undefined) { data.usage.cache_read_tokens = cache.cache_read_tokens; }
        if (cache.cache_creation_tokens !== undefined) { data.usage.cache_creation_tokens = cache.cache_creation_tokens; }
        // A-974-R8：OpenAI 兼容系 prompt_tokens 是总量（已含 cached）→ 窗口占用不重复加 cache
        data.usage.cache_read_in_prompt = true;
      }
      return data;
    } catch (e) {
      if (e instanceof UpstreamError) { throw e; }
      throw new UpstreamError("上游响应非 JSON", resp.status, "protocol");
    }
  }

  /**
   * 流式 chat/completions：逐 chunk 回调，返回拼接结果。
   * SSE 行格式：`data: {json}`，终止于 `data: [DONE]`。
   * onReasoning：提取上游 reasoning_content（DeepSeek R1 / Qwen 思考模型等），供思考模式展示。
   * onToolDelta：透传 delta.tool_calls 增量（index 分片累积由调用方负责，真流式工具循环用）。
   */
  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    externalSignal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onToolDelta?: (toolCalls: ChatToolCallDelta[]) => void,
  ): Promise<ChatStreamResult> {
    const resp = await this.post(
      this.endpoint("chat"),
      // include_usage：让 OpenAI 兼容上游在流末尾回传 usage（含 prompt_tokens_details.cached_tokens），
      // 用于还原缓存命中率。老网关不支持该字段时静默忽略，不影响正文。
      { ...payload, stream: true, stream_options: { include_usage: true } },
      RETRY_429_BACKOFF.length,
      externalSignal,
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
    /** 收到过工具调用 delta → 真流式信号；与 model 一起用于区分「真流式零正文」与「非流式兜底」。 */
    let sawToolDelta = false;
    /** 非 `data:` 行累积：部分网关忽略 stream:true 直接返回非流式 JSON（无 data: 前缀）。
     *  流结束若零 delta 则按非流式 JSON 兜底解析出正文，避免静默返回空回复（A-149）。 */
    let nonDataLines = "";
    /** 思考（reasoning）跨 chunk 累积：与正文分离、供 A-150 末尾兜底恢复答案（不打断实时 onReasoning）。 */
    let reasoningAcc = "";
    /** 流末尾 usage（include_usage 回传），含缓存命中 token。 */
    let streamUsage: NonNullable<ChatStreamResult["usage"]> | undefined;

    // 流式读取取消桥：requestWithRetry 的 finally 已 cleanup 解除了「外部→fetch 内部」的
    // abort 链接，故此处需为挂起的 reader.read() 重建「外部 abort → 拒绝该次读取」，
    // 否则中途停止（流空闲等待下一 chunk）永远不会中断（GUI 停止按钮依赖它）。
    let cancelRead: (() => void) | null = null;
    const attachAbort = !!externalSignal && !externalSignal.aborted;
    const onExternalAbort = () => {
      cancelRead?.();
      void reader.cancel("aborted").catch(() => {});
    };
    if (attachAbort) {
      externalSignal!.addEventListener("abort", onExternalAbort, { once: true });
    }

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
          // A-157：空闲看门狗——每次 read() 全程无数据超过 IDLE_STREAM_MS 判定上游僵死，
          // 抛 timeout（上层重连/切模型）。正常 chunk 间隔毫秒级，60s 无字节基本可断定连接已死。
          outcome = await raceIdleTimeout(p, IDLE_STREAM_MS);
          cancelRead = null;
        } catch (e) {
          if (externalSignal?.aborted || (e instanceof Error && e.name === "AbortError")) {
            throw new UpstreamError("流式已取消", 0, "protocol");
          }
          if (e instanceof UpstreamError && e.kind === "timeout") {
            // 空闲超时（非用户取消、非请求级超时）→ 原样上抛，交由上层 9 次自动重连 / 模型池降级
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
            // 非 `data:` 行：正常 SSE 中是空行/注释行；忽略 stream:true 的网关会在此返回完整 JSON
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
            continue; // 半行 JSON（极端分块），丢弃等下一行
          }
          const chunk = parsed as ChatCompletionChunk;
          // 采集流末尾 usage（OpenAI include_usage：最后一块 choices 为空、usage 非空）
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
          // 结束原因采集：`length` = 触达输出上限被截断（必须上浮提示，否则静默半句话收尾）
          if (chunk.choices[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
          const { d, m } = pickChunkFields(chunk.choices[0]);
          // 正文：delta.content 优先（标准流式），网关缓冲的 message 形态次之；
          // content 可能是字符串或 content-blocks 数组（统一经 chunkText 展开）。
          const content = chunkText(d?.content ?? m?.content);
          if (content) {
            chunks++;
            text += content;
            onDelta(content);
          }
          // 思考：DeepSeek 系 reasoning_content；OpenAI o 系列 reasoning（message 形态同字段）。
          const reasoning =
            d?.reasoning_content ?? d?.reasoning ?? m?.reasoning_content ?? m?.reasoning ?? "";
          if (reasoning) {
            reasoningAcc += reasoning;
            if (onReasoning) {
              onReasoning(reasoning);
            }
          }
          // 工具调用：delta 形态是增量碎片（保留原 index）；message 形态是完整对象（枚举编号）。
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
      // A-980-R24：**主动释放响应体与连接**。此前 OpenAI 主路径的 finally 只摘监听器，
      // 遇到「用户点停止 / 上游超时 / 网络重置」时 reader 仍握着一条未读完的 fetch 响应流
      // → 连接与解码缓冲不回收。连续中断几次就会累积成内存与句柄泄漏（长会话"越用越卡"的来源之一）。
      // Anthropic 路径（:1102）与通用 SSE 路径（:1292）本来就有这一步，此处对齐。
      // reader.cancel() 是幂等的：正常读完再 cancel 不会报错，也不会影响已累积的 text/reasoning。
      try { void reader.cancel().catch(() => { /* 已结束/已取消：忽略 */ }); } catch { /* 忽略 */ }
    }

    // —— 流结束：非流式 JSON 兜底（A-149）——
    // 部分网关忽略 stream:true，整段响应一行 `data:` 都没有。此时 nonDataLines + buffer 残留
    // 就是完整的非流式 JSON。只要从未收到任何流式事件（无 model / 无 tool delta）且正文为空 →
    // 按 choices[0].message 恢复正文 / 思考 / 工具调用，避免静默返回空回复。
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

    // —— A-150: content 全空、答案藏在 reasoning（思考）——恢复正文兜底 ——
    // ling 系等上游把含最终回答的整块输出放进 delta.reasoning 而非 content（实时已过 onReasoning 展示，
    // 此处按思考累积做一次「正文兜底」），使 GUI/历史再也不会得到静默空回复（ai:""）。
    // 仅在「正文全空 且 无工具调用」时生效：工具循环中间轮（思考 + tool_calls 组合）模型尚未给出
    // 最终回答，此时把思考恢复成正文会污染跨轮正文累积（tools.spec 回归曾把第一轮"先分析"混入 reply）；
    // 模型下一轮可能继续产出正文，或由最终轮（无工具调用）恢复。有正文的模型完全不受影响。
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

  /** 嵌入（BGE-M3，OpenAI 格式） */
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

/**
 * Anthropic Messages API 客户端（/v1/messages 端点）。
 * 请求格式与 OpenAI 不同：
 * - 消息格式：{ role: "user"/"assistant", content: string | [...blocks...] }
 * - 响应：{ content: [...], stop_reason, model }
 * - 流式：SSE 格式不同（type: "content_block_delta", delta: { text }）
 */
/**
 * OpenAI image_url（{url: "data:image/png;base64,..." | 远端URL}）→ Anthropic image block。
 * Anthropic 规范：source 取 {type:"base64", media_type, data}（data URL）或 {type:"url", url}。
 */
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

  constructor(opts: { baseUrl: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private endpoint(): string {
    // A-1008：统一走 joinApiEndpoint（版本段不止 /v1，见其注释）
    return joinApiEndpoint(this.baseUrl, "/v1/messages");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  /** A-156：Anthropic 与 ChatClient 共用同一套重试策略（瞬态状态码 + Retry-After + 网络级重试），
   *  对齐 OpenAI 兼容客户端的行为——此前 /v1/messages 对上游 TLS/线路偶发抖动零重试，
   *  一次瞬时错误就直接红字"连接失败"，是「供应商经常断联」的主要来源之一。 */
  private async post(url: string, payload: unknown, signal?: AbortSignal, maxAttempts?: number): Promise<Response> {
    const send = (body: unknown): Promise<Response> => fetchWithRetry({
      fetchImpl: this.fetchImpl,
      url,
      init: { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      maxAttempts: maxAttempts ?? RETRY_429_BACKOFF.length,
      timeoutMs: this.timeoutMs,
      externalSignal: signal,
    });
    const resp = await send(payload);
    // 同 ChatClient：400 且带思考参数 → 仅当错误确认为「参数不被识别」时剥掉重试一次，
    // 避免因开关协议不被识别而整请求失败；其它 400 直接透传（剥参重试无意义）。
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

  /** 非流式 messages */
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
        // A-974-R8：Anthropic `input_tokens` 不含 cache → 窗口占用须 prompt+cache_read
        cache_read_in_prompt: false,
      } : undefined,
    };
  }

  /** 流式 messages */
  async chatStream(
    payload: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    _onReasoning?: (reasoning: string) => void,
  ): Promise<ChatStreamResult> {
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
    /** 非 `data:` 行累积：/v1/messages 网关忽略 stream:true 时整段返回非流式 JSON（A-149）。 */
    let nonDataLines = "";
    /** 流式 usage（message_start/message_delta 携带的缓存命中 token 归并） */
    let streamUsage: NonNullable<ChatStreamResult["usage"]> | undefined;

    // 流式读取取消桥（与 ChatClient 对齐）：post 阶段的重试 finally 已解除「外部 → fetch 内部」
    // 的 abort 链接，此处为挂起的 reader.read() 重建「外部 abort → 拒绝该次读取」，
    // 否则流空闲等待下一 chunk 时停止按钮永远无法中断 Anthropic 流。
    let cancelRead: (() => void) | null = null;
    const attachAbort = !!signal && !signal.aborted;
    const onExternalAbort = () => {
      cancelRead?.();
      void reader.cancel("aborted").catch(() => {});
    };
    if (attachAbort) {
      signal!.addEventListener("abort", onExternalAbort, { once: true });
    }

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
          // A-157：空闲看门狗（与 ChatClient 对齐）——每次 read() 无数据超过上限 → timeout 上抛
          outcome = await raceIdleTimeout(p, IDLE_STREAM_MS);
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
            // 首帧携带 input 侧 usage（含 cache_creation / cache_read）
            if (evt.message?.usage) { streamUsage = mergeUsage(streamUsage, evt.message.usage); }
          }
          if (evt.type === "content_block_delta" && evt.delta?.text) {
            chunks++;
            text += evt.delta.text;
            onDelta(evt.delta.text);
          }
          if (evt.type === "message_delta") {
            // 尾帧携带 output 侧 usage（含 cache_read_input_tokens）
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
      try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
    }

    // —— 流结束：非流式 JSON 兜底（A-149）——
    // 若从未收到任何 data: 事件（model 为空）且正文为空 → 累积的是完整非流式 response，
    // 按 content[0].text 恢复（Anthropic 消息形态与 OpenAI 不同：content 是块数组）。
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

  /** ChatRequest → Anthropic Messages API payload */
  private toAnthropicPayload(payload: ChatRequest): Record<string, unknown> {
    const p = payload as any;
    // 系统提示：优先顶层 system 字段；否则从 messages 首位 role=system 提取（引擎统一放 messages[0]）。
    // 抽到顶层 system 既修正 Anthropic 协议形态，又让稳定前缀可标记 cache_control 提升缓存命中。
    const messages = payload.messages ?? [];
    const leadingSystem = messages[0]?.role === "system" && typeof messages[0].content === "string" ? messages[0].content : undefined;
    const systemText = (p.system as string | undefined) ?? leadingSystem;
    // cache_control：标记稳定前缀（系统提示）为 ephemeral，供应商侧缓存 KV 前缀 → 后续请求命中、免 prefill。
    // 前缀 < 最小可缓存长度时供应商会静默忽略该标记（不报错），故无条件标记安全。
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
                // OpenAI image_url data URL → Anthropic image source（base64 data URL / 远端 URL 两态）
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
    // A-918++：多断点 prompt cache（命中率从 ~5% 推到 80%+）
    //  Anthropic 4 个 breakpoint 限额：system（已加） + tools + 早期 1 个 user 消息 + 最近 1 个 user 消息
    //  工具列表和早期对话滚轮稳定 → 标记后供应商侧 KV prefix 缓存命中、免 prefill
    let toolsArr: Array<Record<string, unknown>> | undefined;
    if (toolsRaw && toolsRaw.length > 0) {
      toolsArr = toolsRaw.map((t, i) => i === toolsRaw.length - 1
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t);
    }
    const msgsWithCache = msgs.map((m, i) => {
      // 早期 1 个 user 消息（index 0，且 role=user）末尾 text block 加 breakpoint
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
      // Anthropic Messages 协议只认 thinking:{type:"enabled", budget_tokens}，不认顶层 reasoning_effort。
      // 优先用能力表产出的 thinking；否则把 reasoning_effort 归一为 budget_tokens（防上游 400）。
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

/** Anthropic Messages API usage（含 prompt caching 的 cache_read/cache_creation 字段） */
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

/**
 * 通用 SSE 读取循环：逐行解析 `data: {...}` 并对每个 JSON 调用 onData。
 * 处理 abort 桥（外部取消 → 中断挂起的 read）与空闲看门狗（无数据超时判僵死），
 * 返回是否收到过 data 行 + 非 data 行累积（供非流式兜底判断）。
 */
async function readSSEStream(
  resp: Response,
  externalSignal: AbortSignal | undefined,
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
        outcome = await raceIdleTimeout(p, IDLE_STREAM_MS);
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

// ─────────────────────────────────────────────────────────────────────────
// OpenAI Responses API 客户端（/v1/responses，GPT-5 系列）
// 与 Chat Completions 的差异：
//   - 请求：{model, input, instructions, reasoning:{effort}, max_output_tokens}
//   - 响应：{output: [{type:"message", content:[{type:"output_text", text}]}], usage}
//   - 思考开关：reasoning:{effort}（非顶层 reasoning_effort）
// ─────────────────────────────────────────────────────────────────────────
export class ResponsesClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) { h.Authorization = `Bearer ${this.apiKey}`; }
    return h;
  }

  private endpoint(): string {
    // A-1008：统一走 joinApiEndpoint（版本段不止 /v1，见其注释）
    return joinApiEndpoint(this.baseUrl, "/v1/responses");
  }

  /** ChatRequest → Responses payload */
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
        // 工具结果 → function_call_output item（call_id 与 function_call 的 call_id 对应）
        input.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: m.content ?? "" });
        continue;
      }
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        // assistant 工具调用 → function_call items（保留 call_id/name/arguments 供多轮往返）
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
    // 思考：顶层 reasoning_effort → Responses 的 reasoning:{effort}
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

  /** Responses 响应 → ChatResponse（output 数组归一为 choices[].message） */
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
      // 工具调用：function_call item → tool_calls（id=call_id，多轮往返匹配用）
      if (item.type === "function_call") {
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ""),
          type: "function",
          function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") },
        });
      }
      // 思考：summary（文本数组）或 reasoning 文本
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
    // item_id → 函数名映射：output_item.added 先发 name，arguments delta 只带 item_id
    const itemNames = new Map<string, string>();

    const { receivedData, nonData } = await readSSEStream(resp, externalSignal, (data) => {
      const ev = data as { type?: string; delta?: string; item?: Record<string, unknown>; item_id?: string; output_index?: number; response?: Record<string, unknown> };
      const t = ev.type;
      // 新输出项：function_call 的 name 先于 arguments delta 到达，记录 item_id → name
      if (t === "response.output_item.added" && ev.item?.type === "function_call") {
        if (typeof ev.item.name === "string") { itemNames.set(String(ev.item.id ?? ""), ev.item.name); }
      }
      // 文本增量：response.output_text.delta
      if (t === "response.output_text.delta" && typeof ev.delta === "string") {
        chunks++; text += ev.delta; onDelta(ev.delta);
      }
      // 思考增量：reasoning_summary_text / reasoning_text
      if ((t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") && typeof ev.delta === "string") {
        reasoningAcc += ev.delta; onReasoning?.(ev.delta);
      }
      // 工具调用参数增量：透传（带 name，index 分片累积由调用方负责）
      if (t === "response.function_call_arguments.delta" && typeof ev.delta === "string") {
        const fn: { name?: string; arguments?: string } = { arguments: ev.delta };
        const nm = itemNames.get(String(ev.item_id ?? ""));
        if (nm) { fn.name = nm; }
        onToolDelta?.([{ index: typeof ev.output_index === "number" ? ev.output_index : 0, id: String(ev.item_id ?? ""), type: "function", function: fn }]);
      }
      // 完成事件 → usage / model
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

    // 非流式兜底：网关忽略 stream:true 直接返回完整 JSON（无 data: 行）
    if (text === "" && !receivedData && nonData.trim() !== "") {
      try {
        const full = this.toChatResponse(JSON.parse(nonData.trim()) as Record<string, unknown>, model);
        const msg = full.choices[0]?.message;
        if (msg?.content) { text = msg.content; chunks++; onDelta(msg.content); }
        if (msg?.reasoning_content) { reasoningAcc = msg.reasoning_content; onReasoning?.(msg.reasoning_content); }
        if (msg?.tool_calls && msg.tool_calls.length > 0) { onToolDelta?.(toToolCallDeltas(msg.tool_calls)); }
        if (full.usage) { streamUsage = full.usage; }
      } catch { /* 兜底失败按空处理 */ }
    }

    return { text, chunks, model, usage: streamUsage };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Google Gemini 原生客户端（/v1beta/models/{model}:generateContent）
// 差异：请求 {contents, systemInstruction, generationConfig:{thinkingConfig}}；
//      响应 {candidates:[{content:{parts:[{text}]}}], usageMetadata}；思考在 parts[].thought
// ─────────────────────────────────────────────────────────────────────────
export class GoogleClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: ChatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "x-goog-api-key": this.apiKey };
  }

  private endpoint(model: string): string {
    // base 已含某个 :generateContent 端点 → 原样使用（旧行为：允许直接把完整端点填进配置）
    if (this.baseUrl.replace(/\/+$/, "").endsWith(":generateContent")) { return this.baseUrl.replace(/\/+$/, ""); }
    // A-1008：其余统一走 joinApiEndpoint（版本段不止 /v1，见其注释）
    return joinApiEndpoint(this.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
  }

  /** reasoning_effort → Gemini thinkingLevel（Gemini 3）/ thinkingBudget（Gemini 2.5） */
  private static thinkingConfig(effortRaw: unknown): Record<string, unknown> | undefined {
    const effort = String(effortRaw ?? "").toLowerCase();
    const levelMap: Record<string, string> = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH" };
    if (levelMap[effort]) { return { thinkingLevel: levelMap[effort] }; }
    const budgetMap: Record<string, number> = { minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 24576, max: 32768 };
    if (budgetMap[effort]) { return { thinkingBudget: budgetMap[effort] }; }
    return undefined;
  }

  /** ChatRequest → Gemini generateContent payload */
  private toGooglePayload(payload: ChatRequest): Record<string, unknown> {
    const p = payload as unknown as Record<string, unknown>;
    const contents: Array<Record<string, unknown>> = [];
    let systemText = "";
    for (const m of payload.messages) {
      if (m.role === "system") { if (m.content) { systemText += m.content + "\n"; } continue; }
      // assistant 工具调用 → parts 里的 functionCall
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
      // 工具结果 → functionResponse（Gemini 按 name 匹配 functionCall；tool_loop 已在 tool 消息回填 name）
      if (m.role === "tool") {
        contents.push({ role: "user", parts: [{ functionResponse: { name: m.name ?? m.tool_call_id ?? "", response: { result: m.content ?? "" } } }] });
        continue;
      }
      // Gemini role：assistant → model
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

  /** Gemini 响应 → ChatResponse */
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
        // thought 布尔标记为 true 的 part 是思考内容（Gemini 3）
        if (part.thought === true) { reasoning += part.text; } else { text += part.text; }
      }
      // 工具调用：functionCall part → tool_calls（Gemini 无 call_id，用 name+序号兜底）
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
    // A-1008：统一走 joinApiEndpoint。此处原为**第二份**版本段实现
    // （`base.endsWith("/v1beta") || base.endsWith("/v1")`），与 ChatClient.endpoint 的
    // `/v1` 硬化同病：只认枚举到的版本号。交给唯一实现后，`/v4`、`/v1beta2` 等一并正确。
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

    const { receivedData, nonData } = await readSSEStream(resp, externalSignal, (data) => {
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

    // 非流式兜底：网关忽略 stream 直接返回完整 JSON（无 data: 行）
    if (text === "" && !receivedData && nonData.trim() !== "") {
      try {
        const full = this.toChatResponse(JSON.parse(nonData.trim()) as Record<string, unknown>, model);
        const msg = full.choices[0]?.message;
        if (msg?.content) { text = msg.content; chunks++; onDelta(msg.content); }
        if (msg?.reasoning_content) { reasoningAcc = msg.reasoning_content; onReasoning?.(msg.reasoning_content); }
        if (msg?.tool_calls && msg.tool_calls.length > 0) { onToolDelta?.(toToolCallDeltas(msg.tool_calls)); }
        if (full.usage) { streamUsage = full.usage; }
      } catch { /* 兜底失败按空处理 */ }
    }

    return { text, chunks, model, usage: streamUsage };
  }
}