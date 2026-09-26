/**
 * core-ts/src/services/fallbackPool.ts — **全局降级池**的用户配置（唯一判据出处）。
 *
 * ── 为什么要这个模块（A-1108，用户点名）────────────────────────────────────
 * 用户原话：「我比较关注的是那个全局降级池，我都没设置，是哪来的？如果是编码的时候默认
 * 写入的话，请改一下，改成用户自定义编辑降级池，默认无降级池，放在通用设置里面。」
 *
 * 他的推断是对的：那份池**不是**哪个配置文件写进去的，而是 `engine.ts`
 * `resolveRouteInternal` 里一段硬编码 —— 把「**其它所有已配置供应商**的启用模型」
 * 自动塞进降级链（旧代码 `const others = Object.entries(this.providers).filter(...)`，
 * 日志里那句 `[engine] 注入全局降级池（N 个候选）`）。用户视角因此是「我没设过，它自己冒出来的」。
 *
 * ── 为什么那个默认值必须拿掉（不是审美问题）──────────────────────────────
 * ① **跨供应商花钱 / 泄数据**：降级会把当前对话（含工具输出、文件片段、长期记忆）
 *    发到**另一家**供应商去 —— 用户从没同意过这件事；
 * ② **候选爆炸**：N 家供应商 × 每家 M 个模型，首选一挂就要顺序把整池试一遍，
 *    表现为「卡很久，然后回了另一个模型的话」；
 * ③ **不可解释**：用户答不出「为什么最后是 agnes 在答我的话」。
 *
 * ── 新语义（本模块 = 唯一判据出处）────────────────────────────────────────
 * - **条目为空 = 关闭**（默认）。首选供应商全挂就如实报错，不偷偷换家。
 * - 用户在 设置 → 通用 → 全局降级池 里自己加条目；**列表顺序 = 优先级**（先加的先试）。
 * - 落盘 `config/fallback-pool.json`（与 notifications.json 同源，随 SLIME_ROOT 走；
 *   `config/` 被 .gitignore 整目录忽略 ⇒ 这是**用户本机**配置，不会进仓库）。
 * - ⚠️ **不设独立的 enabled 开关**：条目为空 ⇔ 关闭。多一个开关就会产生
 *   「开关开着但没有条目」这种无法向用户解释的态（两个真相源迟早互相矛盾）。
 *
 * ⚠️ 首选供应商**自身**的启用模型（同一家换模型）**不经过本模块** —— 那不属于
 *    「跨供应商降级」，仍由 engine 的 ① 段注入。本模块只管 ② 段。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";
import { LOCAL_MODELS_KEY } from "../local_models.js";
import type { ApiFormat } from "../router.js";

/** 一条降级池条目 = 「某供应商的某个模型」 */
export interface FallbackPoolEntry {
  /** providers 表里的 key（与 Agent 的 `api:<key>` 命名空间一致） */
  provider: string;
  /** 模型 id（空串非法，会被 sanitize 丢弃） */
  model: string;
}

export interface FallbackPoolConfig {
  /** 空数组 = 无降级池（默认语义）；顺序 = 尝试顺序 */
  entries: FallbackPoolEntry[];
}

/** 条目上限：降级池是「兜底」，不是第二条主链。超出的截断（保序、保前）。 */
export const FALLBACK_POOL_MAX = 12;

/** 落盘文件名（config/ 下） */
export const FALLBACK_POOL_FILE = "fallback-pool.json";

/** 默认 = 空池 = 不降级（**唯一默认值出处**，读到坏文件时也回它） */
export const EMPTY_FALLBACK_POOL: FallbackPoolConfig = { entries: [] };

/** 配置文件绝对路径（`root` 缺省 PROJECT_ROOT；测试注入 tmp） */
export function fallbackPoolPath(root: string = PROJECT_ROOT): string {
  return join(root, "config", FALLBACK_POOL_FILE);
}

/**
 * 白名单重建（解析的唯一实现）。
 *
 * 坏数据一律**丢弃该条**而不是整份配置 —— 一条手写错的条目绝不该让整条路由链炸掉。
 * 只接受「provider 与 model 都是非空字符串」的条目；按 `provider\0model` 去重（保前）；
 * 截断到 FALLBACK_POOL_MAX。
 */
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

/** 读取配置（文件缺失 / 损坏 / 权限失败 ⇒ 一律回**空池**，绝不抛、绝不静默沿用旧值） */
export function readFallbackPool(root: string = PROJECT_ROOT): FallbackPoolConfig {
  try {
    return sanitizeFallbackPool(JSON.parse(readFileSync(fallbackPoolPath(root), "utf8")));
  } catch {
    return { entries: [] };
  }
}

/**
 * 写入配置（**整体替换**语义：`entries` 给全量，不做局部合并 ——
 * 局部合并 + 去重会让「用户删掉一条，另一条同名的又被并回来」这种鬼故事出现）。
 */
export function writeFallbackPool(
  patch: { entries?: unknown },
  root: string = PROJECT_ROOT,
): FallbackPoolConfig {
  const next = sanitizeFallbackPool(patch);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(fallbackPoolPath(root), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* ────────────────────────── 解析为可注入的路由目标 ────────────────────────── */

/**
 * providers 表的**最小结构约束**（engine 的 `ProviderConfig` 结构上满足它；
 * 单测可以传裸对象，不必构造完整 ProviderConfig）。
 */
export interface FallbackProviderLike {
  api_base?: unknown;
  api_key?: unknown;
  api_format?: unknown;
  models?: unknown;
  [k: string]: unknown;
}

/** 一条已解析的降级目标（engine 直接拿去 pushGroup） */
export interface FallbackTarget {
  provider: string;
  model: string;
  /** 已归一化：去尾斜杠 + 剥末尾 `/v1` —— 与 engine 既有口径逐字一致（见 resolveRouteInternal 注释） */
  base: string;
  apiKey: string | undefined;
  /** 模型级 `api_format` 覆盖 > 供应商级 */
  apiFormat: ApiFormat | undefined;
}

export interface ResolveFallbackOptions {
  /** 对话能力判据（engine 传 `isChatCapableModel`）—— 图片/视频/embedding 类不许进降级链 */
  isChatCapable: (id: string) => boolean;
  /** 上限（缺省 FALLBACK_POOL_MAX） */
  limit?: number;
}

function asApiFormat(v: unknown): ApiFormat | undefined {
  if (typeof v !== "string") { return undefined; }
  // ApiFormat 的可能取值随 router 演进 —— 这里只透传「看起来像格式名」的字符串，
  // 不认识的一律不传（让 createClient 按 baseUrl 推断），避免把 typo 当格式用。
  return /^[a-z][a-z0-9_-]*$/.test(v) ? (v as ApiFormat) : undefined;
}

/** 归一化 baseUrl（**与 engine 的 primaryBase/oBase 同一条规则**：去尾斜杠 + 剥末尾 /v1） */
function normalizeBase(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return s.endsWith("/v1") ? s.slice(0, -3) : s;
}

/** 该供应商的模型条目列表（只取形状正确的那些） */
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

/**
 * 把用户配置的降级池解析成**可注入的路由目标**（纯函数，无 fs）。
 *
 * 丢弃规则（每一条都对应一种「用户配了但没法用」的真实处境）：
 *  - `entries` 为空 ⇒ 返回 `[]`（**默认空池 ⇒ 不降级**，这是 A-1108 的核心）
 *  - 条目 provider 就是首选 provider ⇒ 丢弃（首选自身的多模型由 ① 段注入，重复注入 = 两个产地）
 *  - 条目 provider 是本地模型伪供应商（`LOCAL_MODELS_KEY`）⇒ 丢弃（那是 local: 分支的事）
 *  - providers 表里没有这个 key ⇒ 丢弃（用户删了供应商，池里留了残骸）
 *  - baseUrl 不是 http(s) ⇒ 丢弃
 *  - 模型名不像对话模型（`isChatCapable` 为假）⇒ 丢弃
 *  - 模型在供应商列表里被**显式关掉**（`selected === false`）⇒ 丢弃
 *    （用户在供应商面板里关掉它 = 明确不想用它；⚠️ 只在列表**确实提到它**时判，
 *     列表里没有它的一律放行 —— 否则「没探测过模型列表的供应商」永远当不了降级目标）
 *  - 重复的 provider+model ⇒ 保前
 *
 * ⚠️ 与旧 A-158 自动池的**故意差异**：旧代码还会剔除 `127.0.0.1` / `localhost` 的供应商。
 *    这里不剔 —— 用户**显式点名**了它，就该按他说的发（那条目也真实出现在设置界面里，
 *    不会出现「配了却被静默丢弃」）。自动猜的那套才需要保守。
 */
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
