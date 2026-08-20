/**
 * gui/src/main/providers.ts — Provider 管理（加密存储 + 模型探测）。
 * - 读写 config/providers.enc.json（与 Python core/encryption.py 双向兼容）
 * - 渲染层永不接触明文 api_key：list 只回脱敏摘要；fetch/save 由主进程执行
 * - fetchModels：OpenAI 兼容 {base}/models 探测（自动尝试 /v1 变体）
 */
import { decrypt, encrypt, PROJECT_ROOT } from "../../../core-ts/src/encryption.js";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface ModelSpec {
  id: string;
  /** 上下文窗口（token） */
  context_window?: number;
  /** 最大输出（token） */
  max_output?: number;
  /** 是否支持图片输入 */
  vision?: boolean;
}

export interface ProviderRecord {
  api_base: string;
  api_key: string;
  /** 默认模型（agent model_choice=api:<key> 时使用） */
  model?: string;
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
    .map((m) => ({
      id: (m.id as string).slice(0, MAX_MODEL_ID),
      context_window: typeof m.context_window === "number" && m.context_window > 0 ? Math.floor(m.context_window) : undefined,
      max_output: typeof m.max_output === "number" && m.max_output > 0 ? Math.floor(m.max_output) : undefined,
      vision: m.vision === true,
    }));
}

export function listProviders(): ProviderSummary[] {
  const table = loadTable();
  return Object.entries(table).map(([key, rec]) => ({
    key,
    api_base: rec.api_base ?? "",
    has_key: Boolean(rec.api_key),
    key_hint: maskKey(rec.api_key ?? ""),
    model: rec.model ?? null,
    models: sanitizeModels(rec.models) ?? [],
  }));
}

function normalizeBaseUrl(base: string): string {
  return (base ?? "").trim().replace(/\/+$/, "");
}

async function tryFetchModels(base: string, apiKey: string): Promise<ModelSpec[]> {
  const url = `${base}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) {
    throw new Error("响应缺少 data 数组（非 OpenAI 兼容接口）");
  }
  const ids = body.data
    .filter((m): m is { id: unknown } => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string")
    .map((m) => m.id as string)
    .filter(Boolean)
    .slice(0, MAX_MODELS);
  if (ids.length === 0) {
    throw new Error("响应中无有效模型 id");
  }
  return ids.map((id) => ({ id }));
}

/** 拉取模型列表：优先 {base}/models，失败尝试 /v1 变体 */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }> {
  if (typeof baseUrl !== "string" || !normalizeBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL 不能为空" };
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "API Key 不能为空" };
  }
  const base = normalizeBaseUrl(baseUrl).slice(0, MAX_BASE_URL);
  const candidates = base.endsWith("/v1") ? [base, base.slice(0, -3)] : [base, `${base}/v1`];
  const attempts: string[] = [];
  for (const cand of candidates) {
    try {
      const models = await tryFetchModels(cand, apiKey.trim());
      return { ok: true, models };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push(`${cand} → ${msg}`);
      if (msg.startsWith("HTTP 4")) { break; } // 4xx 换地址无意义
    }
  }
  return { ok: false, error: `模型列表获取失败：${attempts.join("；")}` };
}

export interface SaveProviderInput {
  key: string;
  api_base: string;
  /** 不传则保留已有 key */
  api_key?: string;
  model?: string | null;
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

export function saveProvider(input: SaveProviderInput): SaveProviderResult {
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
  table[key] = {
    api_base: base,
    api_key: input.api_key !== undefined ? input.api_key.trim() : (prev.api_key ?? ""),
    model: input.model !== undefined && input.model !== null ? input.model : (prev.model ?? undefined),
    models: input.models !== undefined ? sanitizeModels(input.models) : sanitizeModels(prev.models),
  };
  try {
    const encoded = encrypt(table, "config/providers.enc.json", rootOverride ? { projectRoot: rootOverride } : {});
    return { ok: true, path: resolveConfigPathForReport(), size: encoded.length };
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