/**
 * core-ts/src/memory/store.ts — Agent 成长型记忆存储。
 * 语义移植自 core/memory.py（BUG-003/005/006/007/008/009/011/014、A-027、H3、N11-P2-8/9/10 对照）。
 *
 * - 只存"学到了什么"，不存原始对话（对话走 history，成长摘要走 memory.json）
 * - JSON 持久化 + LanceDB 可选向量层（spike 定案：@lancedb/lancedb）
 * - 去重（同 category 相似度 >75% 计 repeated）+ 双向链接（tags 重叠/内容相似自动关联）
 * - 艾宾浩斯遗忘因子（半衰期 5 天 × 重要性加权）
 * - 嵌入执行经 sidecar /embeddings（Python 优点面），失败回退哈希占位
 *
 * 线程模型：TS 单线程事件循环内同步段天然原子（对齐 Python per-agent 锁语义，注释标注）。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PROJECT_ROOT } from "../paths.js";
import { resolve, dirname } from "node:path";
import { connect as lanceConnect, type Table } from "@lancedb/lancedb";

export { PROJECT_ROOT };
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const KNOWLEDGE_MEMORY_DIR = resolve(PROJECT_ROOT, "Knowledge", "Agent Memory");

// A-112: agent_id 仅允许安全字符（防御路径遍历；空串放行 = global 语义）
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateAgentId(agentId: string): void {
  if (agentId && !AGENT_ID_RE.test(agentId)) {
    throw new Error(`[memory] 非法 agent_id: ${JSON.stringify(agentId)}`);
  }
}

// ── 辅助函数（对照 memory.py 辅助） ───────────────────────

/** 简单文本相似度（Jaccard 词级）。 */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/** 记忆稳定 ID（content 哈希，幂等，用于双向链接）。 */
export function memId(content: string): string {
  return "mem_" + createHash("md5").update(content, "utf8").digest("hex").slice(0, 8);
}

/** 艾宾浩斯遗忘因子：时间衰减 × 重要性加权。返回 [0,1]。 */
export const EBBINGHAUS_TAU = 5.0;

export function forgettingFactor(daysSinceAccess: number, importance: number): number {
  const imp = Number.isFinite(importance) ? importance : 5; // 容错：非法重要性按默认 5
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

/** 记忆有效权重 = 遗忘因子 × (1 + 相关性)。用于 summary/检索排序。 */
export function effectiveWeight(fact: MemoryFact, context = ""): number {
  const ts = fact.last_accessed ?? fact.timestamp ?? "";
  const ff = forgettingFactor(ageInDays(ts), fact.importance ?? 5);
  if (context) return ff * (1.0 + textSimilarity(context, fact.content ?? ""));
  return ff;
}

// ── 数据结构（对照 MEMORY_TEMPLATE / BUG-005 补填语义） ────

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
  [extra: string]: unknown;
}

export interface MemoryData {
  facts: MemoryFact[];
  skills_unlocked: string[];
  created_at: string | null;
  updated_at: string | null;
}

export function memoryTemplate(): MemoryData {
  return { facts: [], skills_unlocked: [], created_at: null, updated_at: null };
}

// ── 嵌入（对照 _embed/_hash_embed/_get_embed_dim） ─────────

export interface EmbedCaller {
  /** 嵌入执行：经 sidecar /embeddings；失败抛错由调用方降级哈希 */
  embed(text: string): Promise<number[]>;
}

let embedDim = 1024; // BGE-M3 默认；由 readEmbedDim() 从 slime.toml 覆盖

/** 从 slime.toml [model_server.embedding].dim 读取向量维度（BUG-025：可配置，防维度硬编码丢表）。 */
export function readEmbedDim(projectRoot = PROJECT_ROOT): number {
  try {
    const tomlPath = resolve(projectRoot, "slime.toml");
    if (existsSync(tomlPath)) {
      const text = readFileSync(tomlPath, "utf8");
      // 简易 TOML 段解析（对齐 Python 3.11 前兼容语义）：只取 [model_server] 下 embedding.dim
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
    /* 读取失败回退默认 */
  }
  return 1024;
}

/** 字符级哈希占位向量（embedding 不可用时的降级方案）。 */
export function hashEmbed(text: string, dim = embedDim): number[] {
  const out: number[] = [];
  const src = text.slice(0, dim).padEnd(dim, " ");
  for (let i = 0; i < dim; i++) {
    out.push((src.charCodeAt(i) % 256) / 256.0);
  }
  return out;
}

// ── LanceDB 向量层（spike 定案：@lancedb/lancedb） ───────

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

export interface MemoryStoreOptions {
  lancedbEnabled?: boolean;
  lancedbUri?: string;
  dataDir?: string;
  projectRoot?: string;
  embed?: EmbedCaller;
  lance?: {
    connect?: (uri: string) => Promise<LanceDbLike>;
  };
}

/**
 * Agent 成长型记忆存储。
 * 线程模型：TS 同步段天然原子（对齐 Python per-agent 锁；LanceDB 原生异步不阻塞主循环）。
 */
export class MemoryStore {
  readonly agentId: string;
  private jsonPath: string;
  private data: MemoryData = memoryTemplate();
  private lancedbEnabled: boolean;
  private lancedbUri: string;
  private lanceTable: Table | null = null;
  private embed: EmbedCaller | null;
  private lanceConnect: (uri: string) => Promise<LanceDbLike>;
  private projectRoot: string;

  constructor(agentId: string, opts: MemoryStoreOptions = {}) {
    validateAgentId(agentId);
    this.agentId = agentId;
    this.projectRoot = opts.projectRoot ?? PROJECT_ROOT;
    const base = opts.dataDir ? resolve(this.projectRoot, opts.dataDir) : KNOWLEDGE_MEMORY_DIR;
    this.jsonPath = resolve(base, agentId, "memory.json");
    this.lancedbEnabled = opts.lancedbEnabled ?? false;
    this.lancedbUri = opts.lancedbUri ?? resolve(DATA_DIR, agentId, "lancedb"); // LanceDB 保持原位
    this.embed = opts.embed ?? null;
    this.lanceConnect = (opts.lance?.connect ?? (async (uri: string) => lanceConnect(uri) as unknown as LanceDbLike));
    this.load();
  }

  // ── JSON 存储 ──────────────────────────────────────────

  private load(): void {
    const newPath = this.jsonPath;
    const oldPath = resolve(DATA_DIR, this.agentId, "memory.json");
    // 迁移：旧位置有数据但新位置没有 → 移动（对齐 Python shutil.move）
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
    // BUG-005: 老数据补填 last_accessed（fallback 到 timestamp）
    for (const f of this.data.facts) {
      if (f && typeof f === "object" && !f.last_accessed) {
        f.last_accessed = f.timestamp ?? "";
      }
    }
    if (!this.data.created_at) {
      this.data.created_at = new Date().toISOString();
    }
  }

  /** 保存记忆到 JSON（原子写入） */
  private save(): void {
    this.data.updated_at = new Date().toISOString();
    mkdirSync(dirname(this.jsonPath), { recursive: true });
    const raw = JSON.stringify(this.data, null, 2);
    const tmp = `${this.jsonPath}.${randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`;
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, this.jsonPath);
  }

  // ── 读写接口 ───────────────────────────────────────────

  /** 统一分类存储：去重 + JSON + LanceDB。同步段天然原子（对齐 per-agent 锁）。 */
  storeCategorized(category: string, content: string, tags: string[] = [], importance = 5, extra: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    // 去重：检查同 category 内相似度 >75% 的事实（N11-P2-10）
    for (const existing of this.data.facts) {
      if (existing.category !== category) continue;
      if (textSimilarity(content.toLowerCase(), (existing.content ?? "").toLowerCase()) > 0.75) {
        existing.repeated = (existing.repeated ?? 0) + 1;
        this.save();
        return;
      }
    }

    const newId = memId(content);
    const tagSet = new Set(tags);
    const links: string[] = [];
    // 自动关联：tags 重叠 OR 内容相似（BUG-011: 无 tags 时用内容相似度兜底）
    for (const existing of this.data.facts) {
      if (existing.id === newId) continue;
      const existingTags = new Set(existing.tags ?? []);
      let linked = false;
      if (tagSet.size && [...tagSet].some((t) => existingTags.has(t))) {
        linked = true;
      } else if (!tagSet.size && textSimilarity(content.toLowerCase(), (existing.content ?? "").toLowerCase()) > 0.3) {
        linked = true;
      }
      if (linked) {
        links.push(existing.id);
        existing.backlinks = existing.backlinks ?? [];
        if (!existing.backlinks.includes(newId)) existing.backlinks.push(newId);
        // BUG-014: 关联访问刷新旧记忆 last_accessed（越用越熟）
        existing.last_accessed = now;
      }
    }

    this.data.facts.push({
      id: newId,
      content,
      category,
      tags,
      importance: Math.max(1, Math.min(10, importance)),
      timestamp: now,
      last_accessed: now, // 艾宾浩斯遗忘
      links, // 主动引用的记忆 ID（BUG-003）
      backlinks: [], // 被引用的记忆 ID（自动维护）
      repeated: 0,
      ...extra,
    });
    this.save();
    if (this.lancedbEnabled) {
      void this.syncLanceStore(category, content, tags);
    }
  }

  /** async 版本：await 化（对齐 _store_categorized_async；同步核心不阻塞事件循环） */
  async storeCategorizedAsync(category: string, content: string, tags: string[] = [], importance = 5, extra: Record<string, unknown> = {}): Promise<void> {
    this.storeCategorized(category, content, tags, importance, extra);
  }

  addFact(fact: string, importance = 5): void {
    this.storeCategorized("fact", fact, [], importance);
  }

  /** 添加/更新用户偏好（按 key 精确去重） */
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

  /** 获取用户偏好（从统一 facts 中过滤 category=preference） */
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

  /** 命中归档条目后刷新 last_accessed（Soul-Plan 修正条 5：越用越熟）。按 content 包含前缀匹配。 */
  touch(contentPrefix: string): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const f of this.data.facts) {
      if ((f.tags ?? []).includes("behavior_archive") && contentPrefix && f.content?.includes(contentPrefix)) {
        f.last_accessed = now;
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  /** 生成记忆摘要（JSON 关键词 + LanceDB 语义检索 + 图谱联想，合并去重） */
  async summary(context = "", maxItems = 10): Promise<string> {
    const parts: string[] = [];
    // 过滤脏数据：只保留含 content 的条目
    const facts = this.data.facts.filter((f) => typeof f.content === "string");

    // 艾宾浩斯：按有效权重排序（遗忘因子 × 相关性），沉睡记忆沉底但可唤醒
    const ranked = [...facts].sort((a, b) => effectiveWeight(b, context) - effectiveWeight(a, context));
    const selected = ranked.slice(0, maxItems);
    const now = new Date().toISOString();
    for (const f of selected) f.last_accessed = now; // 越用越熟

    // 索引（BUG-009: 用 dict 索引替代 O(N²) 遍历）
    const contentToFact = new Map(facts.map((f) => [f.content, f]));
    const idToFact = new Map(facts.filter((f) => f.id).map((f) => [f.id, f]));
    const known = new Set(facts.map((f) => f.content));

    // LanceDB 语义检索（可选，补充关键词遗漏的条目）
    let semanticItems: MemoryFact[] = [];
    let seeds: MemoryFact[] = [];
    if (context && this.lancedbEnabled) {
      try {
        const recalled = await this.recall(context, maxItems);
        semanticItems = recalled.filter((r) => !known.has(r.content ?? ""));
        seeds = recalled;
      } catch {
        /* LanceDB 不可用时静默跳过，不影响主流程 */
      }
    }

    // 图谱联想（BUG-006: 不依赖 LanceDB；种子优先向量召回，fallback 到 ranked 前 3）
    const graphItems: MemoryFact[] = [];
    if (context) {
      // BUG-012: 对 seeds 按 content 去重，避免重复 content 导致索引覆盖
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
      const seen = new Set<string>();
      for (const seedFact of seedFacts) {
        for (const linkId of [...(seedFact.links ?? []), ...(seedFact.backlinks ?? [])]) {
          const linked = idToFact.get(linkId);
          // BUG-007/008: content 非空且不在已知主 facts 中
          if (linked && !seen.has(linked.id ?? "") && !known.has(linked.content ?? "")) {
            seen.add(linked.id ?? "");
            graphItems.push(linked);
          }
        }
      }
    }

    if (selected.length || semanticItems.length || graphItems.length) {
      const lines = selected.map((f) => `- [${f.category ?? "fact"}] ${f.content}`);
      for (const gf of graphItems.slice(0, 3)) lines.push(`- [关联] ${gf.content}`);
      for (const item of semanticItems.slice(0, 3)) lines.push(`- ${item.content}`);
      parts.push("## 已知事实\n" + lines.join("\n"));
    }
    const prefs = this.getPreferences();
    if (Object.keys(prefs).length) {
      parts.push("## 用户偏好\n" + Object.entries(prefs).slice(0, maxItems).map(([k, v]) => `- ${k}: ${v}`).join("\n"));
    }
    const skills = this.getSkills();
    if (skills.length) {
      parts.push("## 已解锁技能\n" + skills.slice(0, maxItems).map((s) => `- ${s}`).join("\n"));
    }
    const lessons = this.getLessons(false, maxItems * 2);
    if (lessons.length) {
      const rankedLessons = [...lessons].sort((a, b) => effectiveWeight(b, context) - effectiveWeight(a, context));
      parts.push("## 经验教训\n" + rankedLessons.slice(0, maxItems).map((l) => `- [${l.success ? "成功" : "失败"}] ${l.content}`).join("\n"));
    }
    return parts.join("\n\n");
  }

  toDict(): MemoryData {
    return JSON.parse(JSON.stringify(this.data)) as MemoryData; // N11-P2-9: 深拷贝，防调用方篡改内部状态
  }

  // ── LanceDB 接口 ───────────────────────────────────────

  /** 初始化 LanceDB 连接（表已存在时 openTable，维度不匹配则重建）。返回是否可用。 */
  async initLancedb(): Promise<void> {
    if (!this.lancedbEnabled) return;
    try {
      const uri = this.lancedbUri || resolve(DATA_DIR, this.agentId, "lancedb");
      const db = await this.lanceConnect(uri);
      const tableName = `memory_${this.agentId}`;
      try {
        this.lanceTable = await db.openTable(tableName);
        // H3: 检查已有表的向量维度是否匹配当前嵌入维度（查首行探测；空表视为匹配）
        const rows = await this.lanceTable.query().limit(1).toArray();
        if (rows.length) {
          const vec = (rows[0] as Record<string, unknown>).vec as number[] | Float32Array | undefined;
          const dim = vec ? Array.from(vec).length : 0;
          if (dim !== embedDim) {
            console.warn(`[memory] 向量维度不匹配（表: ${dim}, 当前: ${embedDim}），重建表（记忆可再生，丢失可接受）`);
            await db.dropTable?.(tableName);
            this.lanceTable = await db.createTable(tableName, [{ role: "", content: "", vector: new Array(embedDim).fill(0), tags: "" }]);
            return;
          }
        }
        // V1: 检查已有表是否缺 tags 字段（旧 schema 无此列）
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

  /** 写入向量（storeCategorized 内部同步调用；异步执行不阻塞主循环） */
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

  /** 经 sidecar /embeddings 嵌入；失败回退哈希（对照 _embed 降级链） */
  async embedOrHash(text: string): Promise<number[]> {
    if (this.embed) {
      try {
        return await this.embed.embed(text);
      } catch {
        /* 降级哈希 */
      }
    }
    return hashEmbed(text);
  }

  /** LanceDB 存储（role=category, tags=逗号分隔标签） */
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

  /** LanceDB 语义检索（可选 category 过滤）。A-027: 新加载的 store 惰性初始化表。 */
  async recall(query: string, topK = 5, categories?: string[]): Promise<MemoryFact[]> {
    if (!this.lancedbEnabled) return [];
    if (!this.lanceTable) await this.initLancedb(); // A-027: 惰性初始化，防全链路静默失效
    if (!this.lanceTable) return [];
    try {
      const vec = await this.embedOrHash(query);
      let q = this.lanceTable.query().nearestTo(vec);
      if (categories?.length) {
        // 单引号转义防注入（对齐 Python .replace("'", "''")）
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
        .filter((r) => r.content.trim()); // 过滤种子行
    } catch (e) {
      console.warn(`[memory] LanceDB recall 失败: ${e}`);
      return [];
    }
  }

  /** 将晋升产物（rule/skill/review）向量化存入 LanceDB（对照 vectorize_knowledge） */
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

/** 便捷函数：加载指定 Agent 的记忆存储 */
export function loadMemory(agentId: string, opts: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(agentId, opts);
}
