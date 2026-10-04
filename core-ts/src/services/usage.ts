










import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";


export function resolveUsagePath(): string {
  const env = typeof process !== "undefined" ? process.env.SLIME_USAGE_PATH : undefined;
  if (env) { return env; }
  return join(PROJECT_ROOT, "config", "usage.jsonl");
}

const MAX_USAGE_BYTES = 10 * 1024 * 1024;
const KEEP_RECORDS = 10000;


export interface UsageRecord {
  
  ts: string;
  
  agent_id: string;
  
  session_id: string;
  
  model: string;
  
  provider_key: string;
  
  prompt_tokens: number;
  
  completion_tokens: number;
  
  reasoning_tokens: number;
  
  cache_read_tokens: number;
  
  cache_creation_tokens: number;
  







  cache_read_in_prompt?: boolean;
  






  price_tier?: string;
  
  elapsed_ms: number;
  
  cost_usd: number;
  
  success: boolean;
  
  error?: string;
}

function nowIso(): string { return new Date().toISOString(); }

async function ensureParent(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(resolveUsagePath()), { recursive: true });
}


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
      
    }
  }
  out.reverse(); 
  return out;
}


export async function clearUsage(): Promise<void> {
  const path = resolveUsagePath();
  await withWriteLock(async () => {
    await ensureParent();
    await writeFile(path, "", "utf8");
  });
  invalidateUsageCache();
}




export interface DailyBucket {
  
  date: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  elapsed_ms: number;
  
  cache_hit_rate: number;
}


export interface ModelBucket {
  model: string;
  provider_key: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
  
  avg_elapsed_ms: number;
  
  unused?: boolean;
}


export interface AgentBucket {
  agent_id: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
}


export interface TokenComposition {
  prompt: number;
  completion: number;
  reasoning: number;
  cache_read: number;
  cache_creation: number;
}


export interface HeatmapCell {
  date: string;
  hour: number;
  requests: number;
  cost_usd: number;
}


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
  
  cache_hit_rate: number;
  
  avg_elapsed_ms: number;
  
  unique_models_used: number;
  
  unique_agents: number;
  
  earliest_ts: string | null;
  
  latest_ts: string | null;
}



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
  
  tzOffsetMin?: number;
  
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
  
  for (const b of map.values()) {
    b.cache_hit_rate = b.prompt_tokens > 0 ? b.cache_read_tokens / b.prompt_tokens : 0;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}


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
  
  const allowed = new Set<string>();
  for (const c of configured) {
    allowed.add(`${c.provider_key}::${c.model_id}`);
  }
  
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










export function defaultCacheReadInPrompt(providerKey: string, model: string): boolean {
  return !/anthropic|claude/i.test(`${providerKey} ${model}`);
}


















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
  
  const billableInput = cacheReadInPrompt
    ? Math.max(0, promptTokens - cacheReadTokens) 
    : promptTokens;                               
  cost += billableInput * priceInUsd;
  
  cost += Math.max(completionTokens, reasoningTokens) * priceOutUsd;
  
  
  if (cacheReadTokens > 0) { cost += cacheReadTokens * (priceCacheReadUsd ?? priceInUsd); }
  if (cacheCreationTokens > 0 && priceCacheWriteUsd !== undefined) { cost += cacheCreationTokens * priceCacheWriteUsd; }
  return cost / 1_000_000;
}




export interface UsagePrice {
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
  priceCacheWrite?: number;
  
  tierId?: string;
}






export type PriceResolver = (providerKey: string, model: string, ts?: string) => UsagePrice | undefined;



















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
    
    rec.cache_read_in_prompt ?? defaultCacheReadInPrompt(rec.provider_key, rec.model),
  );
  
  if (!(cost > 0)) { return { rec, changed: false }; }
  const next: UsageRecord = { ...rec, cost_usd: cost };
  if (price.tierId) { next.price_tier = price.tierId; }
  return { rec: next, changed: true };
}


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











export async function rewriteUsageCosts(resolve: PriceResolver): Promise<{
  updated: number;
  scanned: number;
  totalCostUsd: number;
  unpriced: number;
  
  unpricedModels: string[];
  




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
      return line; 
    }
    scanned += 1;
    const next = recomputeOne(rec, resolve);
    if (next.changed) {
      updated += 1;
      if (next.rec.price_tier) { tiered += 1; }
    }
    
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
    .sort((a, b) => b[1] - a[1])   
    .slice(0, 5)
    .map(([m]) => m);
  return { updated, scanned, totalCostUsd, unpriced, unpricedModels, tiered };
}