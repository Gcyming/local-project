





























import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import { LOCAL_MODELS_KEY } from "../local_models.js";
import type { ApiFormat } from "../router.js";


export interface FallbackPoolEntry {
  
  provider: string;
  
  model: string;
}

export interface FallbackPoolConfig {
  
  entries: FallbackPoolEntry[];
}


export const FALLBACK_POOL_MAX = 12;


export const FALLBACK_POOL_FILE = "fallback-pool.json";


export const EMPTY_FALLBACK_POOL: FallbackPoolConfig = { entries: [] };


export function fallbackPoolPath(root: string = PROJECT_ROOT): string {
  return join(root, "config", FALLBACK_POOL_FILE);
}








export function sanitizeFallbackPool(raw: unknown): FallbackPoolConfig {
  const src = raw && typeof raw === "object" ? (raw as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(src)) { return { entries: [] }; }
  const out: FallbackPoolEntry[] = [];
  const seen = new Set<string>();
  for (const it of src) {
    if (!it || typeof it !== "object") { continue; }
    const p = (it as { provider?: unknown }).provider;
    const m = (it as { model?: unknown }).model;
    const provider = typeof p === "string" ? p.trim() : "";
    const model = typeof m === "string" ? m.trim() : "";
    if (!provider || !model) { continue; }
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push({ provider, model });
    if (out.length >= FALLBACK_POOL_MAX) { break; }
  }
  return { entries: out };
}


export function readFallbackPool(root: string = PROJECT_ROOT): FallbackPoolConfig {
  try {
    return sanitizeFallbackPool(JSON.parse(readFileSync(fallbackPoolPath(root), "utf8")));
  } catch {
    return { entries: [] };
  }
}





export function writeFallbackPool(
  patch: { entries?: unknown },
  root: string = PROJECT_ROOT,
): FallbackPoolConfig {
  const next = sanitizeFallbackPool(patch);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(fallbackPoolPath(root), JSON.stringify(next, null, 2), "utf8");
  return next;
}







export interface FallbackProviderLike {
  api_base?: unknown;
  api_key?: unknown;
  api_format?: unknown;
  models?: unknown;
  [k: string]: unknown;
}


export interface FallbackTarget {
  provider: string;
  model: string;
  
  base: string;
  apiKey: string | undefined;
  
  apiFormat: ApiFormat | undefined;
}

export interface ResolveFallbackOptions {
  
  isChatCapable: (id: string) => boolean;
  
  limit?: number;
}

function asApiFormat(v: unknown): ApiFormat | undefined {
  if (typeof v !== "string") { return undefined; }
  
  
  return /^[a-z][a-z0-9_-]*$/.test(v) ? (v as ApiFormat) : undefined;
}


function normalizeBase(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return s.endsWith("/v1") ? s.slice(0, -3) : s;
}


function modelEntries(cfg: FallbackProviderLike): Array<{ id: string; selected: unknown; api_format: unknown }> {
  const arr = cfg.models;
  if (!Array.isArray(arr)) { return []; }
  const out: Array<{ id: string; selected: unknown; api_format: unknown }> = [];
  for (const m of arr) {
    if (!m || typeof m !== "object") { continue; }
    const id = (m as { id?: unknown }).id;
    if (typeof id !== "string" || !id) { continue; }
    out.push({ id, selected: (m as { selected?: unknown }).selected, api_format: (m as { api_format?: unknown }).api_format });
  }
  return out;
}




















export function resolveFallbackTargets(
  cfg: FallbackPoolConfig | null | undefined,
  providers: Record<string, FallbackProviderLike> | null | undefined,
  primaryKey: string,
  opts: ResolveFallbackOptions,
): FallbackTarget[] {
  const entries = Array.isArray(cfg?.entries) ? cfg.entries : [];
  if (entries.length === 0 || !providers) { return []; }
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : FALLBACK_POOL_MAX;
  const out: FallbackTarget[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (out.length >= limit) { break; }
    const provider = typeof e?.provider === "string" ? e.provider.trim() : "";
    const model = typeof e?.model === "string" ? e.model.trim() : "";
    if (!provider || !model) { continue; }
    if (provider === primaryKey || provider === LOCAL_MODELS_KEY) { continue; }
    const cfgP = providers[provider];
    if (!cfgP || typeof cfgP !== "object") { continue; }
    if (!opts.isChatCapable(model)) { continue; }
    const base = normalizeBase(cfgP.api_base);
    if (!base || !/^https?:\/\//i.test(base)) { continue; }
    const listed = modelEntries(cfgP).find((m) => m.id === model);
    if (listed && listed.selected === false) { continue; }
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    const apiKey = typeof cfgP.api_key === "string" && cfgP.api_key ? cfgP.api_key : undefined;
    out.push({
      provider,
      model,
      base,
      apiKey,
      apiFormat: asApiFormat(listed?.api_format) ?? asApiFormat(cfgP.api_format),
    });
  }
  return out;
}
