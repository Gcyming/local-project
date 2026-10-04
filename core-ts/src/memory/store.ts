












import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  const mod = (await import( spec)) as unknown as LancedbModuleLike;
  return (await mod.connect(uri)) as unknown as LanceDbLike;
}
import { classifyLayer, migrationTarget, type MemoryLayer, type MemoryEntry, type MemoryInput } from "./three_layer.js";
import { createGraph, upsertEntity, linkEntities, addEdge, graphToJSON, parseGraph, type EntityGraph, type Entity } from "./graph.js";
import { embeddingCache, type EmbedCache } from "./embed_cache.js";

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




export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}


export function memId(content: string): string {
  return "mem_" + createHash("md5").update(content, "utf8").digest("hex").slice(0, 8);
}


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

export interface MemoryData {
  facts: MemoryFact[];
  skills_unlocked: string[];
  created_at: string | null;
  updated_at: string | null;
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
    this.load();
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
    
    const source = (extra as { source?: MemoryInput["source"] }).source;
    const layer = source ? classifyLayer({ source }) : layerForCategory(category);
    const entityKeys = Array.isArray(extra.entity_keys) ? (extra.entity_keys as string[]).filter((k) => typeof k === "string" && k.length > 0).slice(0, 16) : undefined;
    
    const confidence = typeof extra.confidence === "number" && Number.isFinite(extra.confidence)
      ? Math.max(0, Math.min(1, extra.confidence))
      : undefined;
    
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
        
        existing.last_accessed = now;
        existing.access_count = (existing.access_count ?? 0) + 1; 
      }
    }

    this.data.facts.push({
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
    });
    this.save();
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
    const selected = ranked.slice(0, maxItems);
    const now = new Date().toISOString();
    for (const f of selected) {
      f.last_accessed = now; 
      f.access_count = (f.access_count ?? 0) + 1; 
    }

    
    const contentToFact = new Map(facts.map((f) => [f.content, f]));
    const idToFact = new Map(facts.filter((f) => f.id).map((f) => [f.id, f]));
    const known = new Set(facts.map((f) => f.content));

    
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
    if (context) {
      
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
