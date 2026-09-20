/**
 * core-ts/src/services/usage.ts — 使用统计持久化与聚合（Settings「使用统计」面板数据源）。
 *
 * 设计要点：
 * - 持久化：JSONL 追加 config/usage.jsonl（与 history.jsonl 同一目录、同一种范式；不引 SQLite 等额外依赖）
 * - 范式对齐 history.ts：进程内写锁 / mtime+size 读缓存 / 原子重写 / 超 10MB 仅保留最近 10000 条
 * - 聚合：在主进程一次性读完，做内存聚合（day/model/agent/token 构成/热力图），通过 IPC 传给渲染层
 * - 不存明文 user/ai 文本（不侵犯隐私），仅存元数据（token/费用/时长/模型/Agent/会话 ID）
 * - 模型维度包含「用户已配置」与「实际调用」并集（未调用也展示为 0 桶），让用户一眼看出哪些模型闲置
 */

import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

/** 运行时解析路径（支持 SLIME_USAGE_PATH 覆盖——测试隔离注入）。 */
export function resolveUsagePath(): string {
  const env = typeof process !== "undefined" ? process.env.SLIME_USAGE_PATH : undefined;
  if (env) { return env; }
  return join(PROJECT_ROOT, "config", "usage.jsonl");
}

const MAX_USAGE_BYTES = 10 * 1024 * 1024;
const KEEP_RECORDS = 10000;

/** 单次请求的使用记录（一行 JSONL） */
export interface UsageRecord {
  /** ISO 时间戳（UTC） */
  ts: string;
  /** Agent ID */
  agent_id: string;
  /** 会话 ID（同 Agent 多次会话分开计） */
  session_id: string;
  /** 使用的模型 ID（如 "gpt-4o"、"claude-sonnet-4-20250514"） */
  model: string;
  /** 供应商 key（providers.enc.json 的键，如 "openai"/"anthropic"/"deepseek"） */
  provider_key: string;
  /** 输入 token 数（含缓存读取语义由各上游定义；Anthropic/OpenAI 的 input_tokens 已包含 cache_read） */
  prompt_tokens: number;
  /** 输出 token 数（含 reasoning_tokens 视具体上游） */
  completion_tokens: number;
  /** 推理/思考 token（qwen3/deepseek-r1 等思考模型独立计费时使用；未单独上报时为 0） */
  reasoning_tokens: number;
  /** 缓存读取命中 token（cache hit 时不再二次计 input 价） */
  cache_read_tokens: number;
  /** 缓存写入/创建 token（写 cache 通常比 input 贵） */
  cache_creation_tokens: number;
  /**
   * A-971：该上游的 `prompt_tokens` **是否已包含** `cache_read_tokens`。
   *   - true  → OpenAI / DeepSeek / 各类 OpenAI 兼容网关（`prompt_tokens` 是总量）
   *   - false → Anthropic / Claude（`input_tokens` 不含 cache_read）
   * 缺省（历史行没有该字段）时按 `defaultCacheReadInPrompt(provider_key, model)` 推断。
   * 计费时必须据此决定「命中部分是否从输入里剔除」，否则同一批 token 会被收两次费
   * （实测整体虚高 5.02×，见 computeRecordCost 注释）。
   */
  cache_read_in_prompt?: boolean;
  /**
   * 分时（峰谷）定价命中的**档位 id**（如 "peak" / "offpeak"；模型无分时规格时缺省）。
   *
   * 为什么要落盘而不是每次重算：成本对账时最常见的问题是"这条为什么这么贵/这么便宜"。
   * 只有 token 数和 cost 是猜不出档位的；把当时命中的档位写下来，事后一眼可核对
   * （也便于发现"规则写错时区导致整段账单错档"这类系统性偏差）。
   */
  price_tier?: string;
  /** 该次请求耗时（毫秒） */
  elapsed_ms: number;
  /** 估算花费 USD（按上游单价 × token 数 / 1e6）；无单价则为 0 */
  cost_usd: number;
  /** 成功标记（false 表示上游报错/被 abort，token/cost 可能为 0） */
  success: boolean;
  /** 上游错误信息（成功时为空） */
  error?: string;
}

function nowIso(): string { return new Date().toISOString(); }

async function ensureParent(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(resolveUsagePath()), { recursive: true });
}

/** A-968 同款：mtime+size 指纹缓存，避免每次聚合都全量读盘 + JSON.parse */
let cachedStat: { mtimeMs: number; size: number } | null = null;
let cachedLines: string[] | null = null;

function invalidateUsageCache(): void {
  cachedStat = null;
  cachedLines = null;
}

async function readLines(): Promise<string[]> {
  const path = resolveUsagePath();
  let s: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await stat(path);
    s = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // 文件不存在
  }
  if (cachedStat && cachedLines && s && cachedStat.mtimeMs === s.mtimeMs && cachedStat.size === s.size) {
    return cachedLines;
  }
  let lines: string[];
  try {
    const raw = await readFile(path, "utf8");
    lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    lines = [];
  }
  cachedStat = s;
  cachedLines = lines;
  return lines;
}

async function atomicRewrite(lines: string[]): Promise<void> {
  const path = resolveUsagePath();
  await ensureParent();
  const tmp = join(dirname(path), `${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(tmp, lines.join("\n") + "\n", "utf8");
  await rename(tmp, path);
  invalidateUsageCache();
}

let writeChain: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 追加单条 usage 记录（engine done 路径调用；fire-and-forget，不阻塞主流程） */
export async function appendUsage(rec: Omit<UsageRecord, "ts"> & { ts?: string }): Promise<void> {
  const full: UsageRecord = { ...rec, ts: rec.ts ?? nowIso() } as UsageRecord;
  const path = resolveUsagePath();
  await withWriteLock(async () => {
    await ensureParent();
    await appendFile(path, JSON.stringify(full) + "\n", "utf8");
    await rotateIfNeeded();
  });
  invalidateUsageCache();
}

/** 批量追加（启动回放/重试场景） */
export async function appendUsageBatch(records: Array<Omit<UsageRecord, "ts"> & { ts?: string }>): Promise<void> {
  if (records.length === 0) { return; }
  const path = resolveUsagePath();
  await withWriteLock(async () => {
    await ensureParent();
    const lines = records.map((r) => JSON.stringify({ ...r, ts: r.ts ?? nowIso() }) + "\n").join("");
    await appendFile(path, lines, "utf8");
    await rotateIfNeeded();
  });
  invalidateUsageCache();
}

/** 轮转（与 history.ts 同款：超 10MB 只保留最近 10000 条） */
export async function rotateIfNeeded(): Promise<void> {
  const path = resolveUsagePath();
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size <= MAX_USAGE_BYTES) {
    return;
  }
  const lines = await readLines();
  if (lines.length <= KEEP_RECORDS) {
    return;
  }
  await atomicRewrite(lines.slice(-KEEP_RECORDS));
}

/** 读取过滤后的 records（不做聚合，返回原始记录供聚合函数使用） */
export async function loadUsage(opts?: { sinceIso?: string; untilIso?: string; limit?: number }): Promise<UsageRecord[]> {
  const lines = await readLines();
  const out: UsageRecord[] = [];
  const since = opts?.sinceIso ? Date.parse(opts.sinceIso) : -Infinity;
  const until = opts?.untilIso ? Date.parse(opts.untilIso) : Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]) as UsageRecord;
      const t = Date.parse(r.ts);
      if (Number.isNaN(t) || t < since || t > until) { continue; }
      out.push(r);
      if (opts?.limit && out.length >= opts.limit) { break; }
    } catch {
      // 损坏行跳过
    }
  }
  out.reverse(); // 时间升序
  return out;
}

/** 清空全部 usage（设置面板「重置」按钮） */
export async function clearUsage(): Promise<void> {
  const path = resolveUsagePath();
  await withWriteLock(async () => {
    await ensureParent();
    await writeFile(path, "", "utf8");
  });
  invalidateUsageCache();
}

/* ═══════════════ 聚合 ═══════════════ */

/** 单日聚合（按本地日期分桶；本地日期由调用方 timezone 决定，缺省 UTC） */
export interface DailyBucket {
  /** yyyy-mm-dd（本地日期） */
  date: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  elapsed_ms: number;
  /** 缓存命中率（cache_read / max(prompt_tokens, 1)）；prompt=0 时为 0 */
  cache_hit_rate: number;
}

/** 按模型聚合 */
export interface ModelBucket {
  model: string;
  provider_key: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
  /** 平均每次请求耗时 */
  avg_elapsed_ms: number;
  /** 是否为「用户已配置但尚未使用」的模型（true=无 usage 记录） */
  unused?: boolean;
}

/** 按 Agent 聚合 */
export interface AgentBucket {
  agent_id: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
}

/** Token 构成（饼图用） */
export interface TokenComposition {
  prompt: number;
  completion: number;
  reasoning: number;
  cache_read: number;
  cache_creation: number;
}

/** 热力图单元（每日每小时聚合） */
export interface HeatmapCell {
  date: string;
  hour: number;
  requests: number;
  cost_usd: number;
}

/** 汇总快照（KPI 卡片用） */
export interface UsageSummary {
  total_requests: number;
  successful_requests: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  /** 缓存命中率（cache_read / max(prompt_tokens, 1)） */
  cache_hit_rate: number;
  /** 平均每次请求耗时 */
  avg_elapsed_ms: number;
  /** 唯一模型数（实际产生过请求的） */
  unique_models_used: number;
  /** 唯一 Agent 数 */
  unique_agents: number;
  /** 时间范围起点 */
  earliest_ts: string | null;
  /** 时间范围终点 */
  latest_ts: string | null;
}

/** 时间桶键（按 timezone 偏移的本地 yyyy-mm-dd）
 *  重要：本地时间 = UTC 时间戳 + tzOffsetMin*60000（东八区为 +480，使 UTC 时间提前 8 小时表现为本地） */
function dayKey(ts: number, tzOffsetMin: number): string {
  const local = new Date(ts + tzOffsetMin * 60_000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function hourOfDay(ts: number, tzOffsetMin: number): number {
  const local = new Date(ts + tzOffsetMin * 60_000);
  return local.getUTCHours();
}

export interface AggregateOpts {
  /** IANA tz offset（分钟；东八区=+480）；缺省=0（UTC） */
  tzOffsetMin?: number;
  /** 仅统计此时间区间（ISO；缺省=全部） */
  sinceIso?: string;
  untilIso?: string;
}

export async function summarizeUsage(opts: AggregateOpts = {}): Promise<UsageSummary> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return summarizeRecords(records);
}

export function summarizeRecords(records: UsageRecord[]): UsageSummary {
  let totalReq = 0, okReq = 0, totalTokens = 0, prompt = 0, completion = 0, reasoning = 0;
  let cacheRead = 0, cacheCreate = 0, cost = 0, elapsed = 0;
  const models = new Set<string>();
  const agents = new Set<string>();
  let earliest: string | null = null, latest: string | null = null;
  for (const r of records) {
    totalReq += 1;
    if (r.success) { okReq += 1; }
    prompt += r.prompt_tokens;
    completion += r.completion_tokens;
    reasoning += r.reasoning_tokens;
    cacheRead += r.cache_read_tokens;
    cacheCreate += r.cache_creation_tokens;
    cost += r.cost_usd;
    elapsed += r.elapsed_ms;
    totalTokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    models.add(r.model);
    agents.add(r.agent_id);
    if (!earliest || r.ts < earliest) { earliest = r.ts; }
    if (!latest || r.ts > latest) { latest = r.ts; }
  }
  return {
    total_requests: totalReq,
    successful_requests: okReq,
    total_tokens: totalTokens,
    prompt_tokens: prompt,
    completion_tokens: completion,
    reasoning_tokens: reasoning,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
    cost_usd: cost,
    cache_hit_rate: prompt > 0 ? cacheRead / prompt : 0,
    avg_elapsed_ms: totalReq > 0 ? elapsed / totalReq : 0,
    unique_models_used: models.size,
    unique_agents: agents.size,
    earliest_ts: earliest,
    latest_ts: latest,
  };
}

export async function dailyBuckets(opts: AggregateOpts = {}): Promise<DailyBucket[]> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return aggregateDaily(records, opts.tzOffsetMin ?? 0);
}

export function aggregateDaily(records: UsageRecord[], tzOffsetMin = 0): DailyBucket[] {
  const map = new Map<string, DailyBucket>();
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) { continue; }
    const k = dayKey(t, tzOffsetMin);
    let b = map.get(k);
    if (!b) {
      b = {
        date: k,
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0,
        elapsed_ms: 0,
        cache_hit_rate: 0,
      };
      map.set(k, b);
    }
    b.requests += 1;
    b.prompt_tokens += r.prompt_tokens;
    b.completion_tokens += r.completion_tokens;
    b.reasoning_tokens += r.reasoning_tokens;
    b.cache_read_tokens += r.cache_read_tokens;
    b.cache_creation_tokens += r.cache_creation_tokens;
    b.cost_usd += r.cost_usd;
    b.elapsed_ms += r.elapsed_ms;
  }
  // 二次扫描算命中率
  for (const b of map.values()) {
    b.cache_hit_rate = b.prompt_tokens > 0 ? b.cache_read_tokens / b.prompt_tokens : 0;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** 仅按实际使用过的模型聚合 */
export async function modelBuckets(opts: AggregateOpts = {}): Promise<ModelBucket[]> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return aggregateByModel(records);
}

export function aggregateByModel(records: UsageRecord[]): ModelBucket[] {
  const map = new Map<string, ModelBucket>();
  for (const r of records) {
    const k = `${r.provider_key}::${r.model}`;
    let b = map.get(k);
    if (!b) {
      b = { model: r.model, provider_key: r.provider_key, requests: 0, total_tokens: 0, cost_usd: 0, avg_elapsed_ms: 0 };
      map.set(k, b);
    }
    b.requests += 1;
    b.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    b.cost_usd += r.cost_usd;
    b.avg_elapsed_ms = (b.avg_elapsed_ms * (b.requests - 1) + r.elapsed_ms) / b.requests;
  }
  return Array.from(map.values()).sort((a, b) => b.cost_usd - a.cost_usd);
}

/** 用户已配置的模型清单（用于聚合时做白名单过滤）。
 *  配置清单来自 providers.enc.json：
 *    Array<{ provider_key: string; model_id: string; selected?: boolean; price_in_usd?: number; price_out_usd?: number }>
 * 语义：返回的 ModelBucket 列表 = 「用户已配置」∩「实际产生过 usage 记录」的交集。
 *  - 用了但用户已删/未配置的模型 → 不展示（避免"幽灵模型"误导用户）
 *  - 用户已配置但从未调用的模型 → 不展示（避免空桶污染排序）
 * 排序：按 cost_usd 降序。 */
export interface ConfiguredModel {
  provider_key: string;
  model_id: string;
  selected?: boolean;
  price_in_usd?: number;
  price_out_usd?: number;
}

export async function modelBucketsWithConfigured(
  configured: ConfiguredModel[],
  opts: AggregateOpts = {},
): Promise<ModelBucket[]> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return aggregateByConfiguredModels(records, configured);
}

export function aggregateByConfiguredModels(
  records: UsageRecord[],
  configured: ConfiguredModel[],
): ModelBucket[] {
  // 1) 建 configured 白名单 Set
  const allowed = new Set<string>();
  for (const c of configured) {
    allowed.add(`${c.provider_key}::${c.model_id}`);
  }
  // 2) 按 usage 聚合，过滤掉白名单外（用了但没配置的 → 丢弃）
  const map = new Map<string, ModelBucket>();
  for (const r of records) {
    const k = `${r.provider_key}::${r.model}`;
    if (!allowed.has(k)) { continue; }
    let b = map.get(k);
    if (!b) {
      b = { model: r.model, provider_key: r.provider_key, requests: 0, total_tokens: 0, cost_usd: 0, avg_elapsed_ms: 0 };
      map.set(k, b);
    }
    b.requests += 1;
    b.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    b.cost_usd += r.cost_usd;
    b.avg_elapsed_ms = (b.avg_elapsed_ms * (b.requests - 1) + r.elapsed_ms) / b.requests;
  }
  return Array.from(map.values()).sort((a, b) => b.cost_usd - a.cost_usd);
}

export async function agentBuckets(opts: AggregateOpts = {}): Promise<AgentBucket[]> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return aggregateByAgent(records);
}

export function aggregateByAgent(records: UsageRecord[]): AgentBucket[] {
  const map = new Map<string, AgentBucket>();
  for (const r of records) {
    let b = map.get(r.agent_id);
    if (!b) {
      b = { agent_id: r.agent_id, requests: 0, total_tokens: 0, cost_usd: 0 };
      map.set(r.agent_id, b);
    }
    b.requests += 1;
    b.total_tokens += r.prompt_tokens + r.completion_tokens + r.reasoning_tokens + r.cache_read_tokens + r.cache_creation_tokens;
    b.cost_usd += r.cost_usd;
  }
  return Array.from(map.values()).sort((a, b) => b.cost_usd - a.cost_usd);
}

export async function tokenComposition(opts: AggregateOpts = {}): Promise<TokenComposition> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return aggregateTokenComposition(records);
}

export function aggregateTokenComposition(records: UsageRecord[]): TokenComposition {
  const c: TokenComposition = { prompt: 0, completion: 0, reasoning: 0, cache_read: 0, cache_creation: 0 };
  for (const r of records) {
    c.prompt += r.prompt_tokens;
    c.completion += r.completion_tokens;
    c.reasoning += r.reasoning_tokens;
    c.cache_read += r.cache_read_tokens;
    c.cache_creation += r.cache_creation_tokens;
  }
  return c;
}

export async function heatmapCells(opts: AggregateOpts = {}): Promise<HeatmapCell[]> {
  const records = await loadUsage({ sinceIso: opts.sinceIso, untilIso: opts.untilIso });
  return aggregateHeatmap(records, opts.tzOffsetMin ?? 0);
}

export function aggregateHeatmap(records: UsageRecord[], tzOffsetMin = 0): HeatmapCell[] {
  const map = new Map<string, HeatmapCell>();
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) { continue; }
    const k = `${dayKey(t, tzOffsetMin)}::${hourOfDay(t, tzOffsetMin)}`;
    let c = map.get(k);
    if (!c) {
      c = { date: dayKey(t, tzOffsetMin), hour: hourOfDay(t, tzOffsetMin), requests: 0, cost_usd: 0 };
      map.set(k, c);
    }
    c.requests += 1;
    c.cost_usd += r.cost_usd;
  }
  return Array.from(map.values());
}

/**
 * A-971：按供应商家族推断「prompt_tokens 是否已含 cache_read」。
 *
 * 只在**上游没告诉我们的记录**（`cache_read_in_prompt` 缺省的历史行、或未经 client.ts 归一化的
 * 兜底路径）上使用；正常链路由 `client.ts` 精确置位，优先采用。
 * 判据是 Anthropic 系与 OpenAI 兼容系的语义差异（见 client.ts 同名注释）：
 *   - Anthropic / Claude：`input_tokens` **不含** `cache_read_input_tokens` → false
 *   - 其余（OpenAI / DeepSeek / 各类 OpenAI 兼容中转）：`prompt_tokens` 是总量、**含**命中 → true
 */
export function defaultCacheReadInPrompt(providerKey: string, model: string): boolean {
  return !/anthropic|claude/i.test(`${providerKey} ${model}`);
}

/**
 * 计算单次请求 cost USD（输入/输出/缓存/思考 × 单价 / 1e6）。
 *
 * ⚠️ A-971 定价虚高事故：此前本函数把**子集字段当成并列项**相加，实测整体虚高 5.02×（单条最坏 10.81×）：
 *   1. `prompt_tokens` 在 OpenAI/DeepSeek 语义下**已包含**缓存命中（`client.ts` 的
 *      `cache_read_in_prompt=true`），旧代码却在按全价收完 prompt 之后**又**收了一遍
 *      `cache_read × 缓存价` —— 同一批 token 收两次费。旧注释甚至写着"不重复计 input 价"，
 *      注释与代码互相矛盾，说明这是笔误级缺陷而非设计取舍。
 *      → 现按 `cacheReadInPrompt` 把命中部分从输入里**剔除**后再计价。
 *   2. `reasoning_tokens` 是 `completion_tokens` 的**子集**（嵌套在
 *      `completion_tokens_details` 里）。实测本机 1651 条记录中 47 条带推理 token，
 *      **47/47 全部 reasoning < completion**，无一例外。旧代码 `completion + reasoning`
 *      同样是重复计费 → 现取二者较大值，既不重复也不漏计。
 *
 * 两个参数（tokens 与单价）都保持位置参数风格以兼容既有调用点；`cacheReadInPrompt`
 * 追加在末尾且**缺省 true**（OpenAI 兼容系是绝对主流，且与旧注释声明的意图一致）。
 */
export function computeRecordCost(
  promptTokens: number,
  completionTokens: number,
  reasoningTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  priceInUsd: number,
  priceOutUsd: number,
  priceCacheReadUsd?: number,
  priceCacheWriteUsd?: number,
  cacheReadInPrompt = true,
): number {
  let cost = 0;
  // ① 输入侧：命中部分是子集还是并列项，取决于上游语义（见函数头注释）
  const billableInput = cacheReadInPrompt
    ? Math.max(0, promptTokens - cacheReadTokens) // 已含命中 → 只按未命中部分收输入价
    : promptTokens;                               // 不含命中 → 与缓存价并列相加
  cost += billableInput * priceInUsd;
  // ② 输出侧：reasoning 是 completion 的子集 → 取较大值，避免重复计费
  cost += Math.max(completionTokens, reasoningTokens) * priceOutUsd;
  // ③ 缓存命中/写入按各自的价；**没给缓存价就按输入价**（不知道有折扣就不假设折扣，
  //    数学上恰好退化成「全部输入按输入价」，既不高估优惠也不重复计费）
  if (cacheReadTokens > 0) { cost += cacheReadTokens * (priceCacheReadUsd ?? priceInUsd); }
  if (cacheCreationTokens > 0 && priceCacheWriteUsd !== undefined) { cost += cacheCreationTokens * priceCacheWriteUsd; }
  return cost / 1_000_000;
}

/* ═══════════════ 历史成本回填 ═══════════════ */

/** 某模型的单价（USD / 1M tokens） */
export interface UsagePrice {
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  /** 该时刻命中的分时档位 id（如 "peak"/"offpeak"）；无分时规格时缺省 */
  tierId?: string;
}

/**
 * 价格解析器：按「供应商 key + 模型 ID」查当前生效单价；查不到返回 undefined。
 * 第三参 `ts`（ISO 时间戳）用于**分时定价**：解析器据此返回该时刻的档位价。
 * 历史调用方（不关心分时）可以忽略它 —— 不传即退回平铺价。
 */
export type PriceResolver = (providerKey: string, model: string, ts?: string) => UsagePrice | undefined;

/**
 * 用**当前**价格重算单条记录的成本（纯函数）。
 *
 * 为什么需要重算：`cost_usd` 是在写记录那一刻算好、固化进 JSONL 的。之后即便价格表被修正
 * （或用户第一次填上单价），历史记录也不会自己变 —— 实测 1606 条记录 **100% 为 0**，
 * 全部是"写入时还没有价"造成的，与聚合逻辑无关（聚合只是朴素求和）。
 *
 * 安全规则（**只增不减，绝不篡改已有账目**）：
 *   - `cost_usd > 0` → 原样保留。那可能是当时按更高价/议价计费的真实账目，重算会篡改历史。
 *   - 无 token（失败请求）或解析不到价格 → 原样保留（不写 0、也不猜）。
 *   - 重算结果仍为 0（真·免费模型）→ 视为"无需改写"（`changed=false`），不产生无意义的写盘。
 *
 * 分时定价：把**记录自己的 `ts`** 传给解析器（第三参）。峰谷档位是按请求发生时刻定的，
 * 用"现在"去算半年前的深夜请求会把整段历史按错误档位重算 —— 这正是分时定价最易错的地方。
 * 解析器回传 `tierId` 时一并写进 `price_tier`，让对账时能直接看出当时命中哪一档。
 *
 * 返回 `changed=false` 表示该记录应原样写回。
 */
export function recomputeOne(rec: UsageRecord, resolve: PriceResolver): { rec: UsageRecord; changed: boolean } {
  if (rec.cost_usd > 0) { return { rec, changed: false }; }
  const tokens = rec.prompt_tokens + rec.completion_tokens + rec.reasoning_tokens
    + rec.cache_read_tokens + rec.cache_creation_tokens;
  if (tokens <= 0) { return { rec, changed: false }; }
  const price = resolve(rec.provider_key, rec.model, rec.ts);
  if (!price) { return { rec, changed: false }; }
  const cost = computeRecordCost(
    rec.prompt_tokens, rec.completion_tokens, rec.reasoning_tokens,
    rec.cache_read_tokens, rec.cache_creation_tokens,
    price.priceIn ?? 0, price.priceOut ?? 0, price.priceCacheRead, price.priceCacheWrite,
    // 历史行没有这个字段 → 按供应商家族推断（OpenAI 兼容系=true，Anthropic=false）
    rec.cache_read_in_prompt ?? defaultCacheReadInPrompt(rec.provider_key, rec.model),
  );
  // 仍为 0：模型确实免费（价格表显式 0）→ 不改写，避免每次重算都产生 diff
  if (!(cost > 0)) { return { rec, changed: false }; }
  const next: UsageRecord = { ...rec, cost_usd: cost };
  if (price.tierId) { next.price_tier = price.tierId; }
  return { rec: next, changed: true };
}

/** 批量重算（纯函数；不落盘，便于单测） */
export function recomputeCosts(
  records: UsageRecord[],
  resolve: PriceResolver,
): { records: UsageRecord[]; updated: number; totalCostUsd: number } {
  let updated = 0;
  let totalCostUsd = 0;
  const out = records.map((r) => {
    const { rec, changed } = recomputeOne(r, resolve);
    if (changed) { updated += 1; }
    totalCostUsd += rec.cost_usd;
    return rec;
  });
  return { records: out, updated, totalCostUsd };
}

/**
 * 回填 `config/usage.jsonl` 里的历史成本（**逐行改写**，损坏行原样保留）。
 * 只有真正"从 0 变成有价"的记录才会触发写盘；无需改写时完全不碰文件。
 *
 * `unpriced` / `unpricedModels` = 「有 token、但仍查不到任何价」的条数与模型清单。
 * **这组数字是给用户排障用的**：上一版只有 `updated`，于是"解析器一条价都没解析出来"与
 * "确实没有可回填项"两种情况在界面上长得一模一样（都显示"无可回填项"），把故障伪装成了成功。
 * 只给出条数还不够——`m1`/`free-a` 这类**本来就没进价目表**的自定义模型会让条数长期很大，
 * 报"解析失守"就变成狼来了；列出模型名才能让用户判断该手填还是该查链路。
 */
export async function rewriteUsageCosts(resolve: PriceResolver): Promise<{
  updated: number;
  scanned: number;
  totalCostUsd: number;
  unpriced: number;
  /** 未定价的模型 ID（按记录数降序，最多 5 个） */
  unpricedModels: string[];
  /**
   * 其中有 **多少条是按峰谷分时取档** 回填的（`price_tier` 非空）。
   * 给用户看的"这功能对我生效了吗"的证据：分时定价是看不见的计算逻辑，
   * 只报"回填 N 条"无法区分"按平均价一律算"与"逐条按时刻分档"。
   */
  tiered: number;
}> {
  const lines = await readLines();
  if (lines.length === 0) {
    return { updated: 0, scanned: 0, totalCostUsd: 0, unpriced: 0, unpricedModels: [], tiered: 0 };
  }
  let updated = 0;
  let scanned = 0;
  let totalCostUsd = 0;
  let unpriced = 0;
  let tiered = 0;
  const unpricedHits = new Map<string, number>();
  const out = lines.map((line) => {
    let rec: UsageRecord;
    try {
      rec = JSON.parse(line) as UsageRecord;
    } catch {
      return line; // 损坏行：不解析、不丢弃、不改写
    }
    scanned += 1;
    const next = recomputeOne(rec, resolve);
    if (next.changed) {
      updated += 1;
      if (next.rec.price_tier) { tiered += 1; }
    }
    // 未改写的记录里，哪些是"本想回填但查不到价"（有 token 却无价可查）
    const tokens = rec.prompt_tokens + rec.completion_tokens + rec.reasoning_tokens
      + rec.cache_read_tokens + rec.cache_creation_tokens;
    if (!next.changed && tokens > 0 && !resolve(rec.provider_key, rec.model)) {
      unpriced += 1;
      unpricedHits.set(rec.model, (unpricedHits.get(rec.model) ?? 0) + 1);
    }
    totalCostUsd += next.rec.cost_usd;
    return next.changed ? JSON.stringify(next.rec) : line;
  });
  if (updated > 0) {
    await withWriteLock(async () => { await atomicRewrite(out); });
  }
  const unpricedModels = Array.from(unpricedHits.entries())
    .sort((a, b) => b[1] - a[1])   // 记录数多的排前面，先看大头
    .slice(0, 5)
    .map(([m]) => m);
  return { updated, scanned, totalCostUsd, unpriced, unpricedModels, tiered };
}