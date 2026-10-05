












import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { PROJECT_ROOT } from "../paths.js";
import { resolve, dirname, join } from "node:path";











type Table = import("@lancedb/lancedb").Table;


export interface LancedbModuleLike {
  connect: (uri: string) => Promise<unknown>;
}


let lancedbModuleLoader: (() => Promise<LancedbModuleLike>) | null = null;

export function setLancedbModuleLoader(fn: (() => Promise<LancedbModuleLike>) | null): void {
  lancedbModuleLoader = fn;
}

async function defaultLanceConnect(uri: string): Promise<LanceDbLike> {
  
  if (lancedbModuleLoader) {
    const mod = await lancedbModuleLoader();
    return (await mod.connect(uri)) as unknown as LanceDbLike;
  }
  
  
  
  
  const spec = "@lancedb/lancedb";
  const mod = (await import(/* @vite-ignore */ spec)) as unknown as LancedbModuleLike;
  return (await mod.connect(uri)) as unknown as LanceDbLike;
}
import { classifyLayer, migrationTarget, type MemoryLayer, type MemoryEntry, type MemoryInput } from "./three_layer.js";
import { createGraph, upsertEntity, linkEntities, addEdge, graphToJSON, parseGraph, type EntityGraph, type Entity } from "./graph.js";
import { embeddingCache, type EmbedCache } from "./embed_cache.js";
import {
  DEDUP_THRESHOLD, LINK_THRESHOLD, MERGE_THRESHOLD,
  tokens, textSimilarity, memId, findSimilar, mergedContent, linkTraversalRule,
} from "./similarity.js";
import { fulltextSearch } from "./fulltext.js";
import { getGlobalIndex, resolveIsolation, type GlobalHit } from "./global.js";

export { DEDUP_THRESHOLD, LINK_THRESHOLD, MERGE_THRESHOLD, tokens, textSimilarity, memId };
export { linkTraversalRule, LINK_TRAVERSAL_RULES } from "./similarity.js";
export { fulltextSearch, rrfFuse } from "./fulltext.js";
export { GlobalMemoryIndex, getGlobalIndex, globalIndexDir, entryKey } from "./global.js";
export type { GlobalHit, GlobalEntry, GlobalRecallItem } from "./global.js";

export { PROJECT_ROOT };
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const KNOWLEDGE_MEMORY_DIR = resolve(PROJECT_ROOT, "Knowledge", "Agent Memory");


















export function resolveMemoryPaths(
  agentId: string,
  opts: { dataDir?: string; projectRoot?: string } = {},
): { memoryJson: string; lanceDir: string } {
  const root = opts.projectRoot ?? PROJECT_ROOT;
  if (opts.dataDir) {
    const base = resolve(root, opts.dataDir);          
    return {
      memoryJson: resolve(base, agentId, "memory.json"),
      lanceDir: resolve(base, agentId, "lancedb"),
    };
  }
  return {
    memoryJson: resolve(root, "Knowledge", "Agent Memory", agentId, "memory.json"),
    lanceDir: resolve(root, "data", agentId, "lancedb"),
  };
}










function migrateDirIfNeeded(oldDir: string, newDir: string): void {
  if (resolve(oldDir) === resolve(newDir)) return;
  if (!existsSync(oldDir) || existsSync(newDir)) return;
  try {
    mkdirSync(dirname(newDir), { recursive: true });
    try {
      renameSync(oldDir, newDir);
      console.log(`[memory] 向量库已迁移: ${oldDir} → ${newDir}`);
      return;
    } catch {
      
    }
    cpSync(oldDir, newDir, { recursive: true });
    console.log(`[memory] 向量库已复制到新位置: ${newDir}（原目录 ${oldDir} 保留，未删除）`);
  } catch (e) {
    console.warn(`[memory] 向量库迁移失败 ${oldDir} → ${newDir}: ${e}（改用新位置，旧数据留在原处）`);
  }
}


const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateAgentId(agentId: string): void {
  if (agentId && !AGENT_ID_RE.test(agentId)) {
    throw new Error(`[memory] 非法 agent_id: ${JSON.stringify(agentId)}`);
  }
}






// A-1139：`textSimilarity` / `memId` / `tokens` 已移到 similarity.ts（与 global.ts 共用的单一产地，
// 避免 store ↔ global 循环 import），这里用 re-export 保持既有 import 路径不变。


export const EBBINGHAUS_TAU = 5.0;

export function forgettingFactor(daysSinceAccess: number, importance: number): number {
  const imp = Number.isFinite(importance) ? importance : 5; 
  const timeDecay = Math.exp(-daysSinceAccess / EBBINGHAUS_TAU);
  const importanceWeight = Math.max(1, Math.min(10, imp)) / 10.0;
  return timeDecay * importanceWeight;
}

function ageInDays(iso: string | undefined): number {
  if (!iso) return 0;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0;
  return (Date.now() - ts) / 86_400_000;
}


export function effectiveWeight(fact: MemoryFact, context = ""): number {
  const ts = fact.last_accessed ?? fact.timestamp ?? "";
  const ff = forgettingFactor(ageInDays(ts), fact.importance ?? 5);
  if (context) return ff * (1.0 + textSimilarity(context, fact.content ?? ""));
  return ff;
}

/**
 * 条目价值 = 有效权重 × 置信度 ×（1+重复命中次数）。上限触发时用它挑「被挤掉」的条目。
 * 复用 effectiveWeight（同一个排序信号），不另造一套打分，避免两套公式互相打架。
 * 与 Python 侧 `core/memory.py::_effective_value` 同式。
 */
export function effectiveValue(fact: MemoryFact): number {
  let v = effectiveWeight(fact);
  const conf = fact.confidence;
  if (typeof conf === "number" && Number.isFinite(conf)) v *= Math.max(0, Math.min(1, conf));
  return v * (1 + Math.max(0, fact.repeated ?? 0));
}

export const SUMMARY_TIME_UNKNOWN = "未知";
export const SUMMARY_SOURCE_UNKNOWN = "未标注";

export function summaryItemLine(
  fact: Partial<MemoryFact> | undefined,
  content: string,
  opts: { category?: string; channel?: string; note?: string } = {},
): string {
  const category = opts.category || fact?.category || "fact";
  const tag = opts.channel ? `[${category}@${opts.channel}]` : `[${category}]`;
  const time = fact?.timestamp || fact?.last_accessed || SUMMARY_TIME_UNKNOWN;
  const source = String(fact?.source ?? "").trim() || SUMMARY_SOURCE_UNKNOWN;
  const note = opts.note ?? (typeof fact?.success === "boolean" ? `结果: ${fact.success ? "成功" : "失败"}` : "");
  const suffix = note ? ` · ${note}` : "";
  return `- ${tag} 时间: ${time} · 来源: ${source}${suffix} · ${content}`;
}



export interface MemoryFact {
  id: string;
  content: string;
  category: string;
  tags: string[];
  importance: number;
  timestamp: string;
  last_accessed: string;
  links: string[];
  backlinks: string[];
  repeated: number;
  success?: boolean;
  
  layer?: MemoryLayer;
  
  access_count?: number;
  
  entity_keys?: string[];
  
  source?: MemoryInput["source"];
  
  confidence?: number;
  
  created_at?: string;
  /** 软归档状态（`archived:<挤入者的 category>` / `shared:<agent>:<memId>`）—— 非物理删除标记 */
  status?: string;
  /** 被挤出活跃集的时间与原因（进 `archived` 时写） */
  archived_at?: string;
  archived_reason?: string;
  /** 被合并的次数，以及每次被合并进来的**原文留痕**（合并有损，原文必须可查） */
  merged_from?: number;
  merge_trail?: Array<{ content: string; score: number; at: string }>;
  [extra: string]: unknown;
}


export function layerForCategory(category: string): MemoryLayer {
  switch (category) {
    case "preference":
    case "fact":
      return "semantic";
    case "lesson":
    case "event":
    case "conversation":
      return "episodic";
    default:
      return "working";
  }
}

export function linkWalk(facts: MemoryFact[], seeds: MemoryFact[], maxHops: number): MemoryFact[] {
  const idToFact = new Map(facts.filter((f) => f.id).map((f) => [f.id, f]));
  const visited = new Set<string>();
  const frontier: Array<[string, number]> = [];
  for (const seed of seeds) {
    const sid = seed.id ?? "";
    if (sid && !visited.has(sid)) {
      visited.add(sid);
      frontier.push([sid, 0]);
    }
  }
  while (frontier.length) {
    const [sid, depth] = frontier.shift()!;
    if (depth >= maxHops) continue;
    const fact = idToFact.get(sid);
    if (!fact) continue;
    for (const linkId of [...(fact.links ?? []), ...(fact.backlinks ?? [])]) {
      if (visited.has(linkId)) continue;
      const linked = idToFact.get(linkId);
      if (linked && (linked.content ?? "").trim()) {
        visited.add(linkId);
        frontier.push([linkId, depth + 1]);
      }
    }
  }
  return [...visited].map((sid) => idToFact.get(sid)).filter((f): f is MemoryFact => Boolean(f && (f.content ?? "").trim()));
}

export function fulltextFacts(facts: MemoryFact[], query: string, topK: number): MemoryFact[] {
  if (!query || topK <= 0 || !facts.length) return [];
  const out: MemoryFact[] = [];
  for (const hit of fulltextSearch(query, facts.map((f) => f.content ?? ""), topK)) {
    const f = facts[hit.index];
    if (f) out.push(f);
  }
  return out;
}

export interface SharedRef {
  from_agent: string;
  mem_id: string;
  score?: number;
  preview?: string;
  /** 命中条目的类别（跟着指针走；缺失时按 `fact` 兜底） */
  category?: string;
  hit_count?: number;
  timestamp?: string;
  last_hit_at?: string;
  status?: string;
  [extra: string]: unknown;
}

/**
 * 跨 agent 召回结果（`globalRecall` 的统一形状）：派生索引命中的**全文**条目，
 * 与本地 `shared_refs` 指针（preview 兜底）合并去重后的同一种东西。
 * `source` 恒为 `shared:<agent_id>` —— 用来标注「这是别人的记忆」。
 */
export interface SharedRecallItem {
  agent: string;
  memId: string;
  content: string;
  category: string;
  importance: number;
  timestamp: string;
  score: number;
  source: string;
}

export interface MemoryData {
  facts: MemoryFact[];
  skills_unlocked: string[];
  created_at: string | null;
  updated_at: string | null;
  /** 写入上限挤出的条目（**软归档，非删除**，getArchived() 可查回） */
  archived?: MemoryFact[];
  /** 跨 agent 去重命中时留下的指针（可查回，不静默丢失） */
  shared_refs?: SharedRef[];
}

export function memoryTemplate(): MemoryData {
  return { facts: [], skills_unlocked: [], created_at: null, updated_at: null };
}



export interface EmbedCaller {
  
  embed(text: string): Promise<number[]>;
}

let embedDim = 1024; 


export function readEmbedDim(projectRoot = PROJECT_ROOT): number {
  try {
    const tomlPath = resolve(projectRoot, "slime.toml");
    if (existsSync(tomlPath)) {
      const text = readFileSync(tomlPath, "utf8");
      
      let inModelServer = false;
      let inEmbedding = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (line === "[model_server]") { inModelServer = true; inEmbedding = false; continue; }
        if (line.startsWith("[") && line.endsWith("]")) { inModelServer = false; inEmbedding = false; continue; }
        if (!inModelServer) continue;
        if (line === "[embedding]") { inEmbedding = true; continue; }
        if (inEmbedding && line.startsWith("dim")) {
          const v = parseInt(line.split("=", 2)[1]?.trim() ?? "", 10);
          if (Number.isInteger(v) && v > 0) return v;
        }
      }
    }
  } catch {
    
  }
  return 1024;
}


export function hashEmbed(text: string, dim = embedDim): number[] {
  const out: number[] = [];
  const src = text.slice(0, dim).padEnd(dim, " ");
  for (let i = 0; i < dim; i++) {
    out.push((src.charCodeAt(i) % 256) / 256.0);
  }
  return out;
}



interface LanceRow {
  role: string;
  content: string;
  vector: number[];
  tags: string;
}

interface LanceDbLike {
  openTable: (name: string) => Promise<Table>;
  createTable: (name: string, data: LanceRow[]) => Promise<Table>;
  dropTable?: (name: string) => Promise<void>;
}

/**
 * 记忆写入治理参数（`slime.toml [memory]`，与 Python 侧 `core/memory.py::_memory_config` 同源）。
 * 阈值/上限都是**可配置**的：默认值只是合理缺省，不是写死的魔法数字。
 */
export interface MemoryConfig {
  /** 跨 agent 全局去重开关 */
  crossAgentDedup: boolean;
  /** 全局索引重新扫盘的间隔（秒） */
  globalIndexTtlS: number;
  /** 去重线。⚠️ 默认 0.75 是校准值，不要下调（不同工具模板条目约 0.74） */
  dedupThreshold: number;
  /** 建链线 */
  linkThreshold: number;
  /** 合并线（落在 [dedup-0.10, dedup-0.01]） */
  mergeThreshold: number;
  /** 单 agent 活跃条目上限；超出后新条目只能合并/替换进入 */
  maxEntries: number;
  /**
   * 软归档区容量。**`0` = 永不回收**（维护者裁决 / 设计 §5.2：忘记不做到期物理删除，
   * 物理删除不可逆，误删代价高于留存成本）。
   * ⚠️ 语义钉死：`0` **不是**「立即删光」也不是「无限制的另一种写法就随便解释」——
   * 它是本字段唯一的「不设上限」表示；只有 `> 0` 才是「容量上限，超出回收最旧的」。
   */
  archiveLimit: number;
  /**
   * 召回门控开关（Chroma《Context Rot》廉价判据）。缺省 **true**；
   * 显式置 `false` 时判据恒 True，恢复旧的「无条件召」行为。
   * 非法值 / 缺失一律回落 true —— 往「召」的方向兜底，配置写坏绝不静默丢失召回。
   */
  recallGateEnabled: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  crossAgentDedup: true,
  globalIndexTtlS: 30,
  dedupThreshold: DEDUP_THRESHOLD,
  linkThreshold: LINK_THRESHOLD,
  mergeThreshold: MERGE_THRESHOLD,
  maxEntries: 2000,
  /** 默认**永不回收**归档区（§5.2）；显式配置正整数才启用容量上限。 */
  archiveLimit: 0,
  recallGateEnabled: true,
};

let cachedMemoryConfig: { path: string; mtimeMs: number; value: MemoryConfig } | null = null;

/** 读 `slime.toml [memory]`（只认简单标量行，与 `readEmbedDim` 同一套轻量解析）。 */
export function readMemoryConfig(projectRoot = PROJECT_ROOT): MemoryConfig {
  try {
    const tomlPath = resolve(projectRoot, "slime.toml");
    if (existsSync(tomlPath)) {
      // 缓存按「路径 + mtime」判活，而不是把 mtime 拼进 key ——
      // 同一毫秒内改写的两份配置会撞成同一个 key，缓存就会串味。
      const mtimeMs = statSync(tomlPath).mtimeMs;
      if (cachedMemoryConfig && cachedMemoryConfig.path === tomlPath
          && cachedMemoryConfig.mtimeMs === mtimeMs) {
        return cachedMemoryConfig.value;
      }
      const text = readFileSync(tomlPath, "utf8");
      const out: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };
      let inMemory = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("[") && line.endsWith("]")) { inMemory = line === "[memory]"; continue; }
        if (!inMemory) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const name = line.slice(0, eq).trim();
        const rawVal = line.slice(eq + 1).split("#")[0]?.trim() ?? "";
        const bool = rawVal === "true" ? true : rawVal === "false" ? false : null;
        const num = Number(rawVal);
        if (name === "cross_agent_dedup" && bool !== null) out.crossAgentDedup = bool;
        else if (name === "global_index_ttl_s" && Number.isFinite(num) && num > 0) out.globalIndexTtlS = num;
        else if (name === "dedup_threshold" && Number.isFinite(num) && num > 0) out.dedupThreshold = num;
        else if (name === "link_threshold" && Number.isFinite(num) && num > 0) out.linkThreshold = num;
        else if (name === "merge_threshold" && Number.isFinite(num) && num > 0) out.mergeThreshold = num;
        else if (name === "max_entries" && Number.isFinite(num) && num > 0) out.maxEntries = Math.floor(num);
        // ⚠️ 这里收 `num >= 0`：0 是**合法且有意义**的值（= 归档区永不回收，§5.2）。
        // 若沿用 `num > 0`，配置里的 0 会被当成非法值悄悄回落 —— 语义就糊了。
        else if (name === "archive_limit" && Number.isFinite(num) && num >= 0) out.archiveLimit = Math.floor(num);
        else if (name === "recall_gate_enabled" && bool !== null) out.recallGateEnabled = bool;
      }
      // 合并线必须落在去重线之下（否则「合并」会抢在「去重」前面把不同条目并掉）。
      out.mergeThreshold = Math.min(out.mergeThreshold, Math.max(0, out.dedupThreshold - 0.01));
      // 归档区容量只有一个下限规则：**显式给了正整数容量**时不得小于活跃上限
      // （否则归档区比活跃区还小，刚归档就被回收 = 变相物理删除）。0 = 永不回收，原样保留。
      out.archiveLimit = out.archiveLimit > 0 ? Math.max(out.archiveLimit, out.maxEntries) : 0;
      cachedMemoryConfig = { path: tomlPath, mtimeMs, value: out };
      return out;
    }
  } catch {
    // 配置读不动就用默认值 —— 配置坏了不能让记忆写入停摆
  }
  return { ...DEFAULT_MEMORY_CONFIG };
}

export interface MemoryStoreOptions {
  lancedbEnabled?: boolean;
  lancedbUri?: string;
  dataDir?: string;
  projectRoot?: string;
  embed?: EmbedCaller;
  
  embedCache?: EmbedCache;
  lance?: {
    connect?: (uri: string) => Promise<LanceDbLike>;
  };
  /** 写入治理参数覆盖（测试隔离用；缺省读 slime.toml） */
  memory?: Partial<MemoryConfig>;
  /** false = 关掉跨 agent 全局去重（完全退回 per-agent 行为） */
  globalIndex?: boolean;
}





export class MemoryStore {
  readonly agentId: string;
  private jsonPath: string;
  private data: MemoryData = memoryTemplate();
  private lancedbEnabled: boolean;
  private lancedbUri: string;
  
  private defaultLanceUri: string;
  private lanceTable: Table | null = null;
  private embed: EmbedCaller | null;
  private embedCache: EmbedCache;
  private lanceConnect: (uri: string) => Promise<LanceDbLike>;
  private projectRoot: string;
  private memoryConfig: MemoryConfig;
  private globalIndexEnabled: boolean;
  private baseDir: string;
  private globalIndex: import("./global.js").GlobalMemoryIndex | null = null;
  /** 显式 `dataDir`（测试 / 隔离运行）；等价于 Python 侧 `MemoryStore._explicit_data_dir`。 */
  private explicitDataDir: boolean;

  constructor(agentId: string, opts: MemoryStoreOptions = {}) {
    validateAgentId(agentId);
    this.agentId = agentId;
    this.projectRoot = opts.projectRoot ?? PROJECT_ROOT;
    
    const paths = resolveMemoryPaths(agentId, { dataDir: opts.dataDir, projectRoot: this.projectRoot });
    this.jsonPath = paths.memoryJson;
    this.lancedbEnabled = opts.lancedbEnabled ?? false;
    this.lancedbUri = opts.lancedbUri ?? paths.lanceDir;
    
    
    this.defaultLanceUri = resolveMemoryPaths(agentId, { projectRoot: this.projectRoot }).lanceDir;
    this.embed = opts.embed ?? null;
    this.embedCache = opts.embedCache ?? embeddingCache;
    this.lanceConnect = (opts.lance?.connect ?? defaultLanceConnect);
    // A-1139（§3.2 配套两条）：写入治理参数 + 跨 agent 全局去重索引的根目录。
    // 索引根目录 = 该 store 的 agent 目录的父目录 —— 显式 dataDir（测试/隔离）与
    // 生产布局（Knowledge/Agent Memory/）都自动对得上。
    this.baseDir = dirname(dirname(paths.memoryJson));
    // 配置从**记忆根目录**读（slime.toml 里 `[memory].dir` 指的就是这个目录，
    // 生产下它就等于 PROJECT_ROOT）；显式 dataDir 的隔离运行再回落到 projectRoot
    // （项目根通常没有 slime.toml，不会被误当成配置源）。
    this.memoryConfig = {
      ...readMemoryConfig(existsSync(resolve(this.baseDir, "slime.toml")) ? this.baseDir : this.projectRoot),
      ...(opts.memory ?? {}),
    };
    this.globalIndexEnabled = (opts.globalIndex ?? true) && this.memoryConfig.crossAgentDedup;
    this.explicitDataDir = Boolean(opts.dataDir);
    this.load();
  }

  /** 写入治理参数（只读副本，便于测试断言与调用方展示）。 */
  getMemoryConfig(): MemoryConfig {
    return { ...this.memoryConfig };
  }

  /**
   * 跨 agent 全局去重索引（惰性创建；关掉时返回 null，写入退回 per-agent 语义）。
   *
   * `globalIndexEnabled` 只是**功能**开关，与**隔离**是两回事：本函数在「隔离」成立时
   * 仍然会把索引对象拿在手里（它是惰性的，自己不碰盘），`crossAgentScan` 再读
   * `idx.isolated` 决定跳不跳过 —— 护栏对读代码的人一眼可见，而不是藏在工厂函数里。
   */
  private globalIdx(): import("./global.js").GlobalMemoryIndex | null {
    if (!this.globalIndexEnabled) return null;
    if (this.globalIndex) return this.globalIndex;
    try {
      this.globalIndex = getGlobalIndex(this.baseDir, this.memoryConfig.globalIndexTtlS);
    } catch (e) {
      console.warn(`[memory] 全局去重索引不可用（退回 per-agent 去重）: ${e}`);
      this.globalIndex = null;
    }
    return this.globalIndex;
  }

  /**
   * 跨 agent 查重。与 Python 侧 `MemoryStore._cross_agent_scan` 同决策树：
   *
   *   ⓪ **隔离成立 → 直接放行 per-agent**，不再往下问。判据是 `global.ts` 的
   *      `resolveIsolation` 唯一产地（闩锁 / 环境变量 / `.memory-isolated` 标记），
   *      与 Python 侧 `_isolation_gate()` 同一条：它是入口级、单向加严的，
   *      两条分支（索引 / 逐目录回退）因此都在它后面，护栏不会被绕过。
   *   ① 索引缺席（功能开关关 / 构造抛错）→ 走 ③；
   *   ② 索引在场 → `idx.check()`；
   *   ③ 功能开关**开着**、但索引构造失败，且显式 `dataDir`（测试 / 隔离运行）
   *      → 退回逐目录精确读另一个 agent 的 facts。生产是 9799 个 agent 目录，
   *      每次写入都全量扫盘正是全局索引要消灭的东西，所以这一支**只**在显式
   *      dataDir 下启用。
   *
   * ⚠️ `globalIndexEnabled` 在 ③ 里也要判：功能开关关 = **完全**退回 per-agent
   * （`slime.toml` 的 `cross_agent_dedup=false` 与 `opts.globalIndex=false` 同义）。
   * 以前 ③ 只看「索引不在场」，于是开关一关反而从回退扫描里漏出跨 agent 去重 ——
   * 那是「关掉的功能」，与隔离护栏无关，必须由开关自己关。
   */
  private crossAgentScan(content: string, category: string): GlobalHit | null {
    if (resolveIsolation(this.baseDir).isolated) return null;
    const idx = this.globalIdx();
    if (idx) {
      if (idx.isolated) return null;
      try {
        return idx.check(content, { excludeAgent: this.agentId, threshold: this.memoryConfig.dedupThreshold });
      } catch (e) {
        console.warn(`[memory] 全局去重查询失败（本轮退回 per-agent）: ${e}`);
        return null;
      }
    }
    if (!this.globalIndexEnabled || !this.explicitDataDir) return null;
    return this.scanOtherAgents(content, category);
  }

  /** 索引不在场时的精确回退：逐目录读别的 agent 的 facts，同判据找跨 agent 重复。 */
  private scanOtherAgents(content: string, category: string): GlobalHit | null {
    let others: string[] = [];
    try {
      others = readdirSync(this.baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      return null;
    }
    const threshold = this.memoryConfig.dedupThreshold;
    for (const other of others) {
      if (other === this.agentId) continue;
      let raw: { facts?: unknown };
      try {
        raw = JSON.parse(readFileSync(join(this.baseDir, other, "memory.json"), "utf8")) as { facts?: unknown };
      } catch {
        continue;
      }
      const facts = Array.isArray(raw?.facts) ? (raw.facts as Array<{ content?: string; id?: string; category?: string }>) : [];
      const hit = findSimilar(facts, content, category, threshold, {
        categoryOf: (f) => f.category, contentOf: (f) => f.content ?? "",
      });
      if (hit.hit) {
        return {
          agent: other, memId: hit.hit.id ?? "", content: hit.hit.content ?? "",
          category: hit.hit.category || "fact", score: hit.score, key: "",
        };
      }
    }
    return null;
  }

  /**
   * 写入上限：把**价值最低**的条目软归档（替换），返回被挤掉的条目。
   *
   * 设计 §5.2：「不要把遗忘做成到期物理删除」—— 这里是**移动**不是删除：
   * 条目进 `archived`，保留 content / 原始时间 / 归档原因，`getArchived()` 可查回。
   * 归档区本身默认`archiveLimit = 0` = **永不回收**（两处语义一致，详见 MemoryConfig）。
   */
  private spillToArchive(category: string): MemoryFact | null {
    const facts = this.data.facts;
    if (!facts.length) return null;
    let victim: MemoryFact | null = null;
    let victimValue = 0;
    for (const f of facts) {
      const value = effectiveValue(f);
      if (!victim || value < victimValue) { victim = f; victimValue = value; }
    }
    if (!victim) return null;
    this.data.facts = facts.filter((f) => f !== victim);
    victim.status = `archived:${category}`;
    victim.archived_at = new Date().toISOString();
    victim.archived_reason = `超出单 agent 上限 ${this.memoryConfig.maxEntries} 条，按最低有效价值替换`;
    this.data.archived = this.data.archived ?? [];
    this.data.archived.push(victim);
    const limit = this.memoryConfig.archiveLimit;
    if (limit > 0 && this.data.archived.length > limit) {
      // 全链路唯一一处真删：**归档区**的超额部分（活跃区永不物理删除）。
      // ⚠️ `limit === 0`（默认，§5.2 维护者裁决）= **永不回收**，本分支不进入：
      // 归档区只增不减，被挤掉的条目永远可查回。
      const freed = this.data.archived.length - limit;
      this.data.archived.splice(0, freed);
      console.log(`[memory] 归档区超出 ${limit} 条，回收最旧的 ${freed} 条`);
    }
    this.globalIdx()?.noteRetired(victim.content ?? "", this.agentId);
    return victim;
  }

  /** 跨 agent 去重命中 → 本地不新增内容，只留一条**指针**（去重不等于丢知识）。 */
  private addSharedRef(hit: GlobalHit, originalContent: string): void {
    const refs = this.data.shared_refs ?? [];
    this.data.shared_refs = refs;
    for (const ref of refs) {
      if (ref.mem_id === hit.memId && ref.from_agent === hit.agent) {
        ref.hit_count = (ref.hit_count ?? 0) + 1;
        ref.last_hit_at = new Date().toISOString();
        this.save();
        return;
      }
    }
    refs.push({
      from_agent: hit.agent,
      mem_id: hit.memId,
      score: Math.round(hit.score * 10000) / 10000,
      preview: (hit.content || originalContent).slice(0, 120),
      // 类别跟着指针走：索引不在场时投影仍能如实标出「这是别人的哪类记忆」。
      category: hit.category || "fact",
      hit_count: 1,
      timestamp: new Date().toISOString(),
      status: `shared:${hit.agent}:${hit.memId}`,
    });
    this.save();
  }

  /** 跨 agent 去重被我方「让位」的条目指针（可查回，不静默丢失）。 */
  getSharedRefs(): Array<Record<string, unknown>> {
    return this.data.shared_refs ?? [];
  }

  /** 被写入上限挤出的条目（**软归档，非删除**）。 */
  getArchived(): MemoryFact[] {
    return this.data.archived ?? [];
  }

  /**
   * 跨 agent 召回：把「因为别处已有而没写进本 agent」的内容找回来（去重 ≠ 删除）。
   *
   * 两条来源合并，按 (agent, memId) 去重（索引命中优先 —— 它是**全文**，
   * 本地指针只有 120 字 preview）：
   *   ① 派生索引里别的 agent 的条目（`globalRecall` 的原有语义）；
   *   ② 本地 `shared_refs` 指针 —— 索引关掉/坏掉/条目已被对方软归档时，
   *      指针仍然记得「这条内容曾经在谁那里」，是索引之外的兜底来源。
   *
   * 每条都带 `source = "shared:<agent_id>"`：这是**别人的**记忆，不是本 agent 的。
   * 空 query → 返回空（与索引召回一致）：别人条目的 `last_accessed`/热度是本 agent
   * 读不到的内部字段，无法给出与本地条目可比的「最近最常用」排序。
   */
  globalRecall(query: string, topK = 5): SharedRecallItem[] {
    const k = Math.max(0, Math.floor(topK));
    if (!query || !query.trim() || k === 0) return [];
    const out = new Map<string, SharedRecallItem>();
    const idx = this.globalIdx();
    if (idx) {
      try {
        for (const r of idx.recall(query, k, this.agentId)) {
          out.set(`${r.agent}\u0000${r.memId || r.content}`, {
            agent: r.agent, memId: r.memId, content: r.content, category: r.category || "fact",
            importance: typeof r.importance === "number" ? r.importance : 5,
            timestamp: r.timestamp || "", score: r.score, source: `shared:${r.agent}`,
          });
        }
      } catch (e) {
        console.warn(`[memory] 跨 agent 召回失败: ${e}`);
      }
    }
    for (const ref of this.sharedRefsRanked(query, k)) {
      const key = `${ref.agent}\u0000${ref.memId || ref.content}`;
      if (out.has(key)) continue;   // 索引命中已是全文，别用 preview 覆盖它
      out.set(key, ref);
    }
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  /**
   * 本地 `shared_refs` 指针按 query 相关性排序（**不发散**：score ≤ 0 的丢掉）。
   * `content` 用指针里的 preview（写入时截断 120 字）—— 索引能在场就由索引补全文。
   */
  private sharedRefsRanked(query: string, topK: number): SharedRecallItem[] {
    const q = query.trim();
    if (!q) return [];
    const ranked: SharedRecallItem[] = [];
    for (const ref of this.getSharedRefs()) {
      const content = typeof ref.preview === "string" ? ref.preview : "";
      const agent = typeof ref.from_agent === "string" ? ref.from_agent : "";
      if (!content || !agent) continue;
      const score = textSimilarity(q, content);
      if (score <= 0) continue;
      ranked.push({
        agent, memId: typeof ref.mem_id === "string" ? ref.mem_id : "", content,
        category: typeof ref.category === "string" && ref.category ? ref.category : "fact",
        importance: 5,
        timestamp: typeof ref.timestamp === "string" ? ref.timestamp : "",
        score, source: `shared:${agent}`,
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, Math.max(0, topK));
  }

  /**
   * 共享指针的**对外投影**（模型看的 `memory_recall` 输出 / 需要暴露给调用方的形状）。
   *
   * 隐私边界（维护者裁决：「允许可见，但标注来源」）：只给**内容 + 来源标识**，
   * 别人的 links / backlinks / tags / system 等内部字段一律不出现。据此：
   *   · `source` = `shared:<agent_id>` —— 唯一且明确区分的来源标注；
   *   · `id` 恒为空串：**本 agent 的 id 空间里不存在这条**，给上别人的 mem_id 会让
   *     模型以为可以用 memory_forget 去删（那是对别人真相源的越权幻想）；
   *   · `category` / `importance` / `timestamp` 取自派生索引的摘要（索引本来就只有摘要）。
   */
  sharedPointerItems(query: string, topK = 5): Array<{
    id: string; content: string; category: string; importance: number; timestamp: string; source: string;
  }> {
    return this.globalRecall(query, topK).map((r) => ({
      id: "",
      content: r.content,
      category: r.category || "fact",
      importance: typeof r.importance === "number" ? r.importance : 5,
      timestamp: r.timestamp || "",
      source: r.source,
    }));
  }

  

  private load(): void {
    const newPath = this.jsonPath;
    const oldPath = resolve(DATA_DIR, this.agentId, "memory.json");
    
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        mkdirSync(dirname(newPath), { recursive: true });
        const raw = readFileSync(oldPath, "utf8");
        writeFileSync(newPath, raw, "utf8");
        renameSync(oldPath, newPath);
        console.log(`[memory] 已从 ${oldPath} 迁移到 ${newPath}`);
      } catch (e) {
        console.warn(`[memory] 迁移失败: ${e}`);
      }
    }
    if (existsSync(newPath)) {
      try {
        const parsed = JSON.parse(readFileSync(newPath, "utf8")) as Partial<MemoryData>;
        this.data = { ...memoryTemplate(), ...parsed, facts: parsed.facts ?? [], skills_unlocked: parsed.skills_unlocked ?? [] };
      } catch (e) {
        console.warn(`[memory] 加载 ${newPath} 失败: ${e}，使用空记忆`);
        this.data = memoryTemplate();
      }
    } else {
      this.data = memoryTemplate();
    }
    
    for (const f of this.data.facts) {
      if (f && typeof f === "object") {
        if (!f.last_accessed) f.last_accessed = f.timestamp ?? "";
        
        if (!f.created_at) f.created_at = f.timestamp ?? "";
        if (typeof f.confidence !== "number" || !Number.isFinite(f.confidence)) f.confidence = undefined;
      }
    }
    if (!this.data.created_at) {
      this.data.created_at = new Date().toISOString();
    }
  }

  
  private save(): void {
    this.data.updated_at = new Date().toISOString();
    mkdirSync(dirname(this.jsonPath), { recursive: true });
    const raw = JSON.stringify(this.data, null, 2);
    const tmp = `${this.jsonPath}.${randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`;
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, this.jsonPath);
  }

  

  
  storeCategorized(category: string, content: string, tags: string[] = [], importance = 5, extra: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    const cfg = this.memoryConfig;

    // ---- ① per-agent 去重（原有语义；判据抽到 similarity.ts 的 findSimilar 以复用剪枝） ----
    const dup = findSimilar(this.data.facts, content, category, cfg.dedupThreshold, {
      categoryOf: (f) => f.category, contentOf: (f) => f.content ?? "",
    });
    if (dup.hit) {
      dup.hit.repeated = (dup.hit.repeated ?? 0) + 1;
      this.save();
      return;
    }

    // ---- ② 跨 agent 全局去重（§3.2 配套第 1 条）：命中则本地只留指针，不新增内容 ----
    const shared = this.crossAgentScan(content, category);
    if (shared) {
      this.addSharedRef(shared, content);
      console.log(`[memory] 跨 agent 去重命中（agent=${this.agentId} ← ${shared.agent} score=${shared.score.toFixed(3)}），本地不新增：${content.slice(0, 60)}`);
      return;
    }

    const newId = memId(content);
    const tagSet = new Set(tags);
    const links: string[] = [];
    
    const source = (extra as { source?: MemoryInput["source"] }).source;
    const layer = source ? classifyLayer({ source }) : layerForCategory(category);
    const entityKeys = Array.isArray(extra.entity_keys) ? (extra.entity_keys as string[]).filter((k) => typeof k === "string" && k.length > 0).slice(0, 16) : undefined;
    
    const confidence = typeof extra.confidence === "number" && Number.isFinite(extra.confidence)
      ? Math.max(0, Math.min(1, extra.confidence))
      : undefined;

    // ---- ③ 合并档：高相似但不达去重线 → 并进旧条目，不新增（合并有损，原文进 merge_trail） ----
    // ⚠️ 带 tags 的条目**不参与合并**：tags 是调用方显式的「同族」信号，同族但内容不同
    // 的条目（如「A 与 B 相关」/「B 与 C 相关」）应当各自留着并靠 links 关联，
    // 合并会把不同事实揉成一条 —— 那是信息损失，不是去重。
    const merge = tagSet.size ? { hit: null, score: 0 } : findSimilar(this.data.facts, content, category, cfg.mergeThreshold, {
      categoryOf: (f) => f.category, contentOf: (f) => f.content ?? "",
    });
    if (merge.hit) {
      const target = merge.hit;
      target.merge_trail = target.merge_trail ?? [];
      target.merge_trail.push({ content, score: Math.round(merge.score * 10000) / 10000, at: now });
      target.content = mergedContent(target.content ?? "", content);
      target.importance = Math.max(target.importance ?? 5, Math.max(1, Math.min(10, importance)));
      target.timestamp = now;
      target.repeated = (target.repeated ?? 0) + 1;
      target.merged_from = (target.merged_from ?? 0) + 1;
      this.save();
      return;
    }

    for (const existing of this.data.facts) {
      if (existing.id === newId) continue;
      const existingTags = new Set(existing.tags ?? []);
      let linked = false;
      if (tagSet.size && [...tagSet].some((t) => existingTags.has(t))) {
        linked = true;
      } else if (!tagSet.size && textSimilarity(content.toLowerCase(), (existing.content ?? "").toLowerCase()) > cfg.linkThreshold) {
        linked = true;
      }
      if (linked) {
        links.push(existing.id);
        existing.backlinks = existing.backlinks ?? [];
        if (!existing.backlinks.includes(newId)) existing.backlinks.push(newId);
        
        existing.last_accessed = now;
        existing.access_count = (existing.access_count ?? 0) + 1; 
      }
    }

    // ---- ④ 上限：满了先「替换」腾位置（软归档价值最低的旧条目），新条目才进得来 ----
    let replaced: string | undefined;
    if (this.data.facts.length >= cfg.maxEntries) {
      const freed = this.spillToArchive(category);
      if (!freed) {
        console.warn(`[memory] ${this.agentId} 已达上限 ${cfg.maxEntries} 条且无可替换条目，本次写入丢弃`);
        return;
      }
      replaced = freed.id;
    }

    const item: MemoryFact = {
      ...extra,
      id: newId,
      content,
      category,
      tags,
      importance: Math.max(1, Math.min(10, importance)),
      timestamp: now,
      last_accessed: now, 
      links, 
      backlinks: [], 
      repeated: 0,
      layer, 
      entity_keys: entityKeys, 
      source, 
      confidence, 
      created_at: now, 
    };
    if (replaced) item.replaced = replaced;
    this.data.facts.push(item);
    this.save();
    this.globalIdx()?.upsert(item.content, this.agentId, item.id, item.category, item.importance, item.timestamp);
    if (this.lancedbEnabled) {
      void this.syncLanceStore(category, content, tags);
    }
  }

  
  async storeCategorizedAsync(category: string, content: string, tags: string[] = [], importance = 5, extra: Record<string, unknown> = {}): Promise<void> {
    this.storeCategorized(category, content, tags, importance, extra);
  }

  addFact(fact: string, importance = 5): void {
    this.storeCategorized("fact", fact, [], importance);
  }

  
  addPreference(key: string, value: string): void {
    const content = `${key}: ${value}`;
    for (const f of this.data.facts) {
      if (f.category === "preference" && f.tags?.length && f.tags[0] === key) {
        f.content = content;
        f.importance = Math.max(f.importance ?? 5, 6);
        f.timestamp = new Date().toISOString();
        this.save();
        return;
      }
    }
    this.storeCategorized("preference", content, [key], 6);
  }

  addSkill(skillName: string): void {
    if (!this.data.skills_unlocked.includes(skillName)) {
      this.data.skills_unlocked.push(skillName);
      this.save();
    }
  }

  addLesson(lesson: string, success: boolean, importance = 5): void {
    this.storeCategorized("lesson", lesson, [], importance, { success });
  }

  getFacts(): MemoryFact[] {
    return this.data.facts;
  }

  
  getPreferences(): Record<string, string> {
    const prefs: Record<string, string> = {};
    for (const f of this.data.facts) {
      if (f.category === "preference" && f.tags?.length) {
        const key = f.tags[0];
        const val = f.content.includes(":") ? f.content.slice(f.content.indexOf(":") + 1).trim() : f.content;
        prefs[key] = val;
      }
    }
    return prefs;
  }

  getSkills(): string[] {
    return this.data.skills_unlocked;
  }

  getLessons(successfulOnly = false, limit = 20): MemoryFact[] {
    let lessons = this.data.facts.filter((f) => f.category === "lesson");
    if (successfulOnly) lessons = lessons.filter((l) => l.success);
    return lessons.slice(-limit);
  }

  
  touch(contentPrefix: string): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const f of this.data.facts) {
      if ((f.tags ?? []).includes("behavior_archive") && contentPrefix && f.content?.includes(contentPrefix)) {
        f.last_accessed = now;
        f.access_count = (f.access_count ?? 0) + 1; 
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  
  getByLayer(layer: MemoryLayer): MemoryFact[] {
    return this.data.facts.filter((f) => (f.layer ?? layerForCategory(f.category)) === layer);
  }

  

  search(query = "", opts: { category?: string; limit?: number } = {}): string {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    let facts = this.data.facts.filter((f) => typeof f.content === "string");
    if (opts.category) { facts = facts.filter((f) => f.category === opts.category); }
    const ranked = [...facts].sort((a, b) => effectiveWeight(b, query) - effectiveWeight(a, query));
    const selected = ranked.slice(0, limit);
    const now = new Date().toISOString();
    for (const f of selected) {
      f.last_accessed = now;
      f.access_count = (f.access_count ?? 0) + 1; 
    }
    if (selected.length) this.save();
    if (!selected.length) { return "[空] 未检索到匹配的记忆"; }
    return selected.map((f, i) => `${i + 1}. [${f.category ?? "fact"}] ${f.content}`).join("\n");
  }

  

  forget(opts: { ids?: string[]; topic?: string; before?: string } = {}): number {
    const ids = new Set((opts.ids ?? []).filter((x): x is string => typeof x === "string" && x.length > 0));
    const topic = (opts.topic ?? "").trim().toLowerCase();
    const beforeTs = opts.before ? Date.parse(opts.before) : NaN;
    const toRemove = new Set<string>();
    for (const f of this.data.facts) {
      if (ids.has(f.id)) { toRemove.add(f.id); continue; }
      if (topic && (f.content?.toLowerCase().includes(topic) || (f.tags ?? []).some((t) => t.toLowerCase().includes(topic)))) {
        toRemove.add(f.id); continue;
      }
      if (!Number.isNaN(beforeTs)) {
        const created = Date.parse(f.created_at ?? f.timestamp ?? "");
        if (!Number.isNaN(created) && created < beforeTs) { toRemove.add(f.id); continue; }
      }
    }
    if (toRemove.size === 0) { return 0; }
    this.data.facts = this.data.facts.filter((f) => !toRemove.has(f.id));
    
    for (const f of this.data.facts) {
      f.links = (f.links ?? []).filter((id) => !toRemove.has(id));
      f.backlinks = (f.backlinks ?? []).filter((id) => !toRemove.has(id));
    }
    this.save();
    return toRemove.size;
  }

  




  consolidateLayers(now = Date.now()): { moved: number; pruned: number } {
    let moved = 0;
    let pruned = 0;
    const kept: MemoryFact[] = [];
    for (const f of this.data.facts) {
      const entry: MemoryEntry = {
        id: f.id ?? "",
        layer: f.layer ?? layerForCategory(f.category),
        content: f.content ?? "",
        createdAt: Date.parse(f.timestamp ?? "") || now,
        lastAccessAt: f.last_accessed ? Date.parse(f.last_accessed) : undefined,
        accessCount: f.access_count,
        entityKeys: f.entity_keys,
      };
      const act = migrationTarget(entry, now, { consolidateNow: true, minAccess: 2 });
      if (act.action === "prune") {
        pruned += 1;
        continue;
      }
      if (act.action === "down" && act.target) {
        moved += 1;
        f.layer = act.target;
        f.access_count = Math.max(1, f.access_count ?? 1);
      }
      kept.push(f);
    }
    if (moved || pruned) {
      this.data.facts = kept;
      this.save();
    }
    return { moved, pruned };
  }

  
  private graphCache: EntityGraph | null = null;

  private graphPath(): string {
    return join(dirname(this.jsonPath), "memory_graph.json");
  }

  private saveGraph(): void {
    try {
      mkdirSync(dirname(this.jsonPath), { recursive: true });
      writeFileSync(this.graphPath(), graphToJSON(this.getGraph()), "utf8");
    } catch (e) {
      console.warn(`[memory] 图谱保存失败: ${e}`);
    }
  }

  
  getGraph(): EntityGraph {
    if (this.graphCache) { return this.graphCache; }
    try {
      if (existsSync(this.graphPath())) {
        const g = parseGraph(readFileSync(this.graphPath(), "utf8"));
        if (g) { this.graphCache = g; return g; }
      }
    } catch {  }
    this.graphCache = createGraph();
    return this.graphCache;
  }

  
  upsertGraphEntity(e: Entity): void {
    this.graphCache = upsertEntity(this.getGraph(), e);
    this.saveGraph();
  }

  
  linkGraphEntities(a: Entity, b: Entity, relations: { aToB: string; bToA: string; weight?: number }): void {
    this.graphCache = linkEntities(this.getGraph(), a, b, relations);
    this.saveGraph();
  }

  
  addGraphEdge(edge: { from: string; to: string; relation: string; weight?: number }): void {
    this.graphCache = addEdge(this.getGraph(), { ...edge, weight: edge.weight ?? 1 });
    this.saveGraph();
  }

  

  factsByGraphNeighbors(seedEntityKeys: string[], excludeIds: Set<string>, max = 8): MemoryFact[] {
    const graph = this.getGraph();
    if (graph.entities.length === 0 || !seedEntityKeys?.length) { return []; }
    const seedIds = new Set(seedEntityKeys);
    const neighborEntityIds = new Set<string>();
    for (const e of graph.entities) {
      if (!seedIds.has(e.id)) { continue; }
      for (const ed of graph.edges) {
        if (ed.from === e.id && !seedIds.has(ed.to)) { neighborEntityIds.add(ed.to); }
        if (ed.to === e.id && !seedIds.has(ed.from)) { neighborEntityIds.add(ed.from); }
      }
    }
    if (neighborEntityIds.size === 0) { return []; }
    const out: MemoryFact[] = [];
    for (const f of this.data.facts) {
      const keys = new Set(f.entity_keys ?? []);
      if (keys.size === 0) { continue; }
      if (![...keys].some((k) => neighborEntityIds.has(k))) { continue; }
      if (excludeIds.has(f.id ?? "")) { continue; }
      out.push(f);
      if (out.length >= max) { break; }
    }
    return out;
  }

  
  async summary(context = "", maxItems = 10): Promise<string> {
    const parts: string[] = [];

    const facts = this.data.facts.filter((f) => typeof f.content === "string");

    const ranked = [...facts].sort((a, b) => effectiveWeight(b, context) - effectiveWeight(a, context));
    let selected = ranked.slice(0, maxItems);
    // 设计 §5.1（富者愈富 bug）：summary() 被调用 ≠ 记忆被访问。这里**不再**刷新
    // last_accessed / access_count —— 否则每轮对话都把当前 top-N 继续抬到榜首，排名外的
    // 沉睡记忆永远追不上，「沉睡但可唤醒」在实现上不成立。
    // 衰减（effectiveWeight）保留为排序信号；只有真正的检索命中（search() / touch()）才算访问。

    const contentToFact = new Map(facts.map((f) => [f.content, f]));
    const known = new Set(facts.map((f) => f.content));

    const fulltext = context ? fulltextFacts(facts, context, maxItems) : [];
    const hitContents: string[] = [];
    const hitSeen = new Set<string>();
    for (const f of fulltext) {
      if (f.content && !hitSeen.has(f.content)) {
        hitSeen.add(f.content);
        hitContents.push(f.content);
      }
    }
    if (hitContents.length) {
      const rest = ranked.filter((f) => !hitSeen.has(f.content));
      selected = [...fulltext, ...rest].slice(0, maxItems);
    }

    let semanticItems: MemoryFact[] = [];
    let seeds: MemoryFact[] = [];
    if (context && this.lancedbEnabled) {
      try {
        const recalled = await this.recall(context, maxItems);
        semanticItems = recalled.filter((r) => !known.has(r.content ?? ""));
        seeds = recalled;
      } catch {

      }
    }

    const graphItems: MemoryFact[] = [];
    if (context && linkTraversalRule(context)) {
      const uniqueSeeds: MemoryFact[] = [];
      const seenSeedContents = new Set<string>();
      for (const s of seeds) {
        const c = s.content ?? "";
        if (c && !seenSeedContents.has(c)) {
          seenSeedContents.add(c);
          uniqueSeeds.push(s);
        }
      }
      let seedFacts = uniqueSeeds.map((s) => contentToFact.get(s.content ?? "")).filter(Boolean) as MemoryFact[];
      if (!seedFacts.length) seedFacts = selected.slice(0, 3);
      const shown = new Set<string>(selected.map((f) => f.content));
      const seen = new Set<string>();
      for (const f of linkWalk(facts, seedFacts, 2)) {
        const cid = f.id ?? "";
        if (cid && seen.has(cid)) continue;
        if (shown.has(f.content ?? "")) continue;
        seen.add(cid);
        graphItems.push(f);
      }
    }

    if (selected.length || semanticItems.length || graphItems.length) {
      // 设计 §4.2：读取侧是一等公民 —— 每条都必须带 category / 时间 / 来源，不是一段散文。
      const lines = selected.map((f) => summaryItemLine(f, f.content));
      for (const gf of graphItems.slice(0, 3)) lines.push(summaryItemLine(gf, gf.content, { channel: "关联" }));
      for (const item of semanticItems.slice(0, 3)) lines.push(summaryItemLine(item, item.content, { channel: "语义" }));
      parts.push("## 已知事实\n" + lines.join("\n"));
    }
    const prefs = this.getPreferences();
    const prefFactByKey = new Map<string, MemoryFact>();
    for (const f of facts) {
      if (f.category === "preference" && f.tags?.length) prefFactByKey.set(f.tags[0], f);
    }
    const prefEntries = Object.entries(prefs).slice(0, maxItems);
    if (prefEntries.length) {
      parts.push("## 用户偏好\n" + prefEntries
        .map(([k, v]) => summaryItemLine(prefFactByKey.get(k), `${k}: ${v}`, { category: "preference" }))
        .join("\n"));
    }
    const skills = this.getSkills();
    if (skills.length) {
      // skills_unlocked 是纯字符串数组，数据模型里没有时间/来源字段（两侧一致）。
      parts.push("## 已解锁技能\n" + skills.slice(0, maxItems).map((s) => `- [skill] ${s}`).join("\n"));
    }
    const lessons = this.getLessons(false, maxItems * 2);
    if (lessons.length) {
      const rankedLessons = [...lessons].sort((a, b) => effectiveWeight(b, context) - effectiveWeight(a, context));
      parts.push("## 经验教训\n" + rankedLessons.slice(0, maxItems)
        .map((l) => summaryItemLine(l, l.content))
        .join("\n"));
    }
    return parts.join("\n\n");
  }

  toDict(): MemoryData {
    return JSON.parse(JSON.stringify(this.data)) as MemoryData; 
  }

  

  
  async initLancedb(): Promise<void> {
    if (!this.lancedbEnabled) return;
    try {
      const uri = this.lancedbUri || this.defaultLanceUri;
      
      
      migrateDirIfNeeded(this.defaultLanceUri, uri);
      const db = await this.lanceConnect(uri);
      const tableName = `memory_${this.agentId}`;
      try {
        this.lanceTable = await db.openTable(tableName);
        
        const rows = await this.lanceTable.query().limit(1).toArray();
        if (rows.length) {
          
          
          
          const raw = (rows[0] as Record<string, unknown>).vector;
          const dim = raw ? Array.from(raw as ArrayLike<number>).length : 0;
          if (dim !== embedDim) {
            console.warn(`[memory] 向量维度不匹配（表: ${dim}, 当前: ${embedDim}），重建表（记忆可再生，丢失可接受）`);
            await db.dropTable?.(tableName);
            this.lanceTable = await db.createTable(tableName, [{ role: "", content: "", vector: new Array(embedDim).fill(0), tags: "" }]);
            return;
          }
        }
        
        const schema = await this.lanceTable.schema();
        const fields: string[] = [];
        for (const f of (schema?.fields ?? [])) fields.push(f.name);
        if (!fields.includes("tags")) {
          console.warn("[memory] 旧表缺 tags 字段，重建表");
          await db.dropTable?.(tableName);
          this.lanceTable = await db.createTable(tableName, [{ role: "", content: "", vector: new Array(embedDim).fill(0), tags: "" }]);
        }
      } catch {
        this.lanceTable = await db.createTable(tableName, [{ role: "", content: "", vector: new Array(embedDim).fill(0), tags: "" }]);
      }
    } catch (e) {
      console.warn(`[memory] LanceDB 初始化失败，降级到 JSON: ${e}`);
      this.lancedbEnabled = false;
    }
  }

  
  private async syncLanceStore(category: string, content: string, tags: string[]): Promise<void> {
    try {
      if (!this.lanceTable) await this.initLancedb();
      if (!this.lanceTable) return;
      const vec = await this.embedOrHash(content);
      await this.lanceTable.add([{ role: category, content, vector: vec, tags: tags.join(",") }]);
    } catch (e) {
      console.warn(`[memory] LanceDB store 失败: ${e}`);
    }
  }

  


  async embedOrHash(text: string): Promise<number[]> {
    const cached = this.embedCache.get(text, embedDim);
    if (cached) return cached;
    if (this.embed) {
      try {
        const vec = await this.embed.embed(text);
        if (vec && vec.length > 0) this.embedCache.set(text, vec);
        return vec;
      } catch {
        
      }
    }
    return hashEmbed(text);
  }

  
  async store(role: string, content: string, tags = ""): Promise<boolean> {
    if (!this.lancedbEnabled) return false;
    if (!this.lanceTable) await this.initLancedb();
    if (!this.lanceTable) return false;
    try {
      const vec = await this.embedOrHash(content);
      await this.lanceTable.add([{ role, content, vector: vec, tags }]);
      return true;
    } catch (e) {
      console.warn(`[memory] LanceDB store 失败: ${e}`);
      return false;
    }
  }

  
  async recall(query: string, topK = 5, categories?: string[]): Promise<MemoryFact[]> {
    if (!this.lancedbEnabled) return [];
    if (!this.lanceTable) await this.initLancedb(); 
    if (!this.lanceTable) return [];
    try {
      const vec = await this.embedOrHash(query);
      let q = this.lanceTable.query().nearestTo(vec);
      if (categories?.length) {
        
        const safeCats = categories.map((c) => c.replace(/'/g, "''"));
        q = q.where(`role = '${safeCats.join("' OR role = '")}'`);
      }
      const results = await q.limit(topK).toArray();
      return results
        .map((r) => {
          const row = r as Record<string, unknown>;
          return {
            id: "",
            content: String(row.content ?? ""),
            category: String(row.role ?? "fact"),
            tags: String(row.tags ?? "").split(",").filter(Boolean),
            importance: 5,
            timestamp: "",
            last_accessed: "",
            links: [],
            backlinks: [],
            repeated: 0,
          };
        })
        .filter((r) => r.content.trim()); 
    } catch (e) {
      console.warn(`[memory] LanceDB recall 失败: ${e}`);
      return [];
    }
  }

  
  async vectorizeKnowledge(role: string, content: string, tags = ""): Promise<boolean> {
    if (!this.lancedbEnabled) return false;
    try {
      if (!this.lanceTable) await this.initLancedb();
      if (!this.lanceTable) return false;
      const vec = await this.embedOrHash(content);
      await this.lanceTable.add([{ role, content, vector: vec, tags }]);
      return true;
    } catch (e) {
      console.warn(`[memory] 知识向量化失败: ${e}`);
      return false;
    }
  }
}


export function loadMemory(agentId: string, opts: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(agentId, opts);
}





export function consolidateMemoryNow(
  agentId: string,
  opts: { dataDir?: string } = {},
): { moved: number; pruned: number } {
  try {
    const store = new MemoryStore(agentId, opts.dataDir ? { dataDir: opts.dataDir } : {});
    return store.consolidateLayers();
  } catch (e) {
    console.warn(`[memory] 分层巩固失败（agent=${agentId}）: ${e instanceof Error ? e.message : String(e)}`);
    return { moved: 0, pruned: 0 };
  }
}
