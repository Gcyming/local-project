/**
 * 跨 agent 全局去重索引（设计 docs/slime-agent-loop-design.md §3.2 配套第 1 条）。
 *
 * 与 Python 侧 `core/memory_global.py` **同判据、同文件、同语义**：
 * 两边读写同一个 `<记忆根目录>/.global/index.json`，所以一个 agent 用 Python 链路写、
 * 另一个用 TS 链路写，去重仍然收敛。
 *
 * 背景：写入去重此前是 per-agent 的 —— 每个 subagent 有自己的 memory.json，
 * 跨 agent 永不收敛。实测（设计 §3.1）：9799 个 agent 目录 / 11796 条记忆，
 * 11658 条 lesson 里只有 25 条不同内容（99.8% 是重复）。
 *
 * ## 这不是第二个真相源
 * 真相源永远是各 agent 的 memory.json。本模块只维护一个**派生索引**：
 *   · 结构上只存摘要（agent / content / tokens），不存权威状态；
 *   · `rebuild()` 可从各 agent 的 memory.json 完整重建；
 *   · 索引坏了/丢了只意味着「重复又多写了几条」，不会让任何记忆消失 ——
 *     `check()` 拿不到索引时直接返回 null，写入照常走 per-agent 去重。
 *
 * ## 避免每次写入全量扫盘
 *   · 进程内单例缓存 + 落盘文件；
 *   · 只有「TTL 到期」或「顶层 agent 目录集合变化」才重新扫盘；
 *   · 扫描只对 (mtime,size) 变了的文件真正 `readFileSync`（快路径只是一堆 stat）；
 *   · 期间的本地写入用 `upsert()` 增量维护，不触发扫盘。
 *
 * ## 并发
 * Node 单线程，没有锁的问题；跨进程靠「写前若发现文件 mtime 比自己上次落盘的新，
 * 就重新载入再合并」+ 原子改名（tmp → rename）避免互相覆盖。
 *
 * ## 隔离（与 Python 侧 `core/memory_global.py` 同判据，**模块自身的保证**）
 * `.global/index.json` 是这台机器上共享的一份文件。隔离场景（测试夹具、评测运行、
 * 沙箱子进程、临时记忆根）拿到它就能读走生产条目、把隔离内容写进生产索引，甚至
 * `rebuild()` 把整份索引按一个不该扫的目录重写掉。所以隔离判定收进本模块：
 * 每个公开入口自己先过一遍 `isolationGate()`，再谈业务逻辑。
 * 判定的唯一产地是 `resolveIsolation()`：显式入参 > 进程级闩锁（`setIsolation`）
 * > 环境变量 `SLIME_MEMORY_ISOLATED` > 记忆根目录里的标记文件 `.memory-isolated`；
 * 全不命中 → 不隔离（生产默认，跨 agent 去重照常全速跑）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tokens as memTokens, textSimilarity as memSimilarity } from "./similarity.js";

export const GLOBAL_DIR_NAME = ".global";
export const GLOBAL_INDEX_FILE = "index.json";
export const GLOBAL_INDEX_VERSION = 1;
export const DEFAULT_GLOBAL_INDEX_TTL_S = 30;
export const ISOLATION_ENV_VAR = "SLIME_MEMORY_ISOLATED";
export const ISOLATION_MARKER_NAME = ".memory-isolated";
const TRUTHY_ISOLATION = new Set(["1", "true", "yes", "on"]);

const RETIRED_PREFIX = "retired:";
const SHARED_PREFIX = "shared:";

export interface GlobalEntry {
  key: string;
  agent: string;
  memId: string;
  content: string;
  category: string;
  importance: number;
  timestamp: string;
  hits: number;
  lastHit?: string;
  status?: string;
}

export interface GlobalHit {
  agent: string;
  memId: string;
  content: string;
  /** 命中条目的类别（跟着指针走：共享指针要如实标出「这是别人的哪类记忆」） */
  category: string;
  score: number;
  key: string;
}

export interface GlobalRecallItem {
  agent: string;
  memId: string;
  content: string;
  category: string;
  /**
   * 索引摘要里的 importance / timestamp —— 都是**派生索引自己**的摘要字段，
   * 不是别人 memory.json 的权威结构（links/backlinks/tags 从不进索引）。
   * 供「共享指针」对外投影时保持与本地条目同一套结构化形状。
   */
  importance: number;
  timestamp: string;
  score: number;
}

/** `stats()` / `rebuild()` 的统一返回形状（与 Python 侧同字段）。 */
export interface GlobalIndexStats {
  entries: number;
  agents: number;
  indexPath: string;
  ttlS: number;
  isolated: boolean;
  /** `rebuild()` 专用：是否真的重建了、被哪条守卫挡下（空串 = 未被挡） */
  rebuilt?: boolean;
  refused?: string;
}

export function entryKey(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex").slice(0, 12);
}

export function globalIndexDir(baseDir: string): string {
  return join(baseDir, GLOBAL_DIR_NAME);
}

function entryStatus(item: Record<string, unknown>): string {
  return String(item.status ?? "");
}

let isolationLatched = false;
let isolationLatchReason = "";

/**
 * 进程级隔离开闩。合上后本进程内**任何**记忆根目录都拿不到全局索引。
 * 闩锁只能由 `resetIsolation()` 打开 —— 隔离是「加严」方向的单向门。
 */
export function setIsolation(enabled: boolean, reason = ""): void {
  isolationLatched = !!enabled;
  isolationLatchReason = String(reason ?? "");
}

export function resetIsolation(): void {
  setIsolation(false);
}

/**
 * 隔离判定的**唯一产地**（与 Python 侧 `_resolve_isolation` 同优先级）。
 *
 * **单向棘轮**：显式参数只能把判定推向「隔离」，**不能**把已经在生效的隔离顶掉。
 * 也就是说 `explicit=false` 不是「解除隔离」，只是「声明默认」——
 * 否则调用方传一个 `false` 就能把闩锁 / 环境变量 / 标记文件全部作废，
 * 「模块自身的保证」当场退化成「调用方自觉」。
 */
export function resolveIsolation(baseDir: string, explicit?: boolean): { isolated: boolean; reason: string } {
  if (isolationLatched) return { isolated: true, reason: isolationLatchReason || "process-latch" };
  if (TRUTHY_ISOLATION.has(String(process.env[ISOLATION_ENV_VAR] ?? "").trim().toLowerCase())) {
    return { isolated: true, reason: `env:${ISOLATION_ENV_VAR}` };
  }
  try {
    if (baseDir && existsSync(join(baseDir, ISOLATION_MARKER_NAME))) {
      return { isolated: true, reason: `marker:${ISOLATION_MARKER_NAME}` };
    }
  } catch { /* 探测失败一律按「不隔离」兜底 —— 探测不了不等于隔离 */ }
  if (explicit) return { isolated: true, reason: "explicit" };
  return { isolated: false, reason: "" };
}

export function isolationState(baseDir: string): { isolated: boolean; reason: string } {
  return resolveIsolation(baseDir);
}

/** 顶层 agent 目录 → memory.json 的 (mtime,size) 指纹（只 stat，不读内容）。 */
function scanMemoryFiles(baseDir: string): Map<string, { path: string; mtime: number; size: number }> {
  const out = new Map<string, { path: string; mtime: number; size: number }>();
  let names: string[] = [];
  try {
    names = readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(baseDir, name, "memory.json");
    try {
      const st = statSync(p);
      out.set(name, { path: p, mtime: st.mtimeMs, size: st.size });
    } catch {
      continue;
    }
  }
  return out;
}

export class GlobalMemoryIndex {
  readonly baseDir: string;
  readonly indexDir: string;
  readonly path: string;
  private ttlMs: number;
  private entries = new Map<string, GlobalEntry>();
  private tokenOf = new Map<string, Set<string>>();
  private inverted = new Map<string, string[]>();
  private files = new Map<string, { mtime: number; size: number }>();
  private lastScan = 0;
  private lastWriteMtime = 0;
  private loaded = false;
  private forcedIsolated: boolean | undefined;

  constructor(baseDir: string, ttlS = DEFAULT_GLOBAL_INDEX_TTL_S, isolated?: boolean) {
    this.baseDir = baseDir;
    this.indexDir = globalIndexDir(baseDir);
    this.path = join(this.indexDir, GLOBAL_INDEX_FILE);
    this.ttlMs = Math.max(1, ttlS) * 1000;
    this.forcedIsolated = isolated;
  }

  /** 实时判定（闩锁 / 环境变量 / 标记文件任一变化立刻生效，不靠重启进程）。 */
  get isolated(): boolean {
    return resolveIsolation(this.baseDir, this.forcedIsolated).isolated;
  }

  get isolationReason(): string {
    return resolveIsolation(this.baseDir, this.forcedIsolated).reason;
  }

  /**
   * 隔离态 → true。**每个**公开入口的第一行都必须是它。
   *
   * 放在模块内部而不是只在 `getGlobalIndex` 里判，是因为后者只是众多入口之一：
   * 审计脚本、运维工具、任何直接 `new GlobalMemoryIndex(...)` 的代码都必须被
   * 同一道门挡住，而不是靠调用方记得传参。
   */
  private isolationGate(): boolean {
    return this.isolated;
  }

  private tokensFor(content: string): Set<string> {
    let t = this.tokenOf.get(content);
    if (!t) {
      t = memTokens(content);
      this.tokenOf.set(content, t);
    }
    return t;
  }

  private reindex(): void {
    const inv = new Map<string, string[]>();
    for (const [key, entry] of this.entries) {
      for (const tok of this.tokensFor(entry.content)) {
        const list = inv.get(tok);
        if (list) list.push(key);
        else inv.set(tok, [key]);
      }
    }
    this.inverted = inv;
  }

  /**
   * 载入落盘的索引；坏文件/缺文件都只记 warning，返回 false（不是致命错误）。
   * ⚠️ 失败时**不动** `this.entries` —— 由调用方决定是清空重建还是保留现状，
   * 否则「落盘前重新载入」这条路径会把刚算好的内存态清成空。
   */
  private loadFile(): boolean {
    if (!existsSync(this.path)) return false;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      console.warn(`[memory] 全局索引不可读（将从各 agent memory.json 重建）: ${e}`);
      return false;
    }
    if (!raw || typeof raw !== "object") return false;
    const obj = raw as { version?: number; entries?: Record<string, Record<string, unknown>> };
    if (obj.version !== GLOBAL_INDEX_VERSION || !obj.entries || typeof obj.entries !== "object") return false;
    const loaded = new Map<string, GlobalEntry>();
    for (const [key, value] of Object.entries(obj.entries)) {
      if (!value || typeof value.content !== "string") continue;
      loaded.set(key, {
        key,
        agent: String(value.agent ?? ""),
        memId: String(value.mem_id ?? value.memId ?? ""),
        content: value.content,
        category: String(value.category ?? "fact"),
        importance: Number(value.importance ?? 5),
        timestamp: String(value.timestamp ?? ""),
        hits: Number(value.hits ?? 0),
        lastHit: value.last_hit ? String(value.last_hit) : undefined,
        status: value.status ? String(value.status) : undefined,
      });
    }
    this.entries = loaded;
    try { this.lastWriteMtime = statSync(this.path).mtimeMs; } catch { this.lastWriteMtime = 0; }
    this.reindex();
    return true;
  }

  /**
   * 磁盘上的索引比自己上次写的更新 → 重新载入（避免覆盖别的进程刚写的条目）。
   * 载入失败（文件损坏）时清掉指纹缓存，让下一次 `refresh()` 从各 agent 的
   * memory.json 重扫 —— 这就是「派生索引坏掉要能自愈」的那一步。
   */
  private reloadIfChanged(): void {
    let diskMtime = 0;
    try { diskMtime = statSync(this.path).mtimeMs; } catch { return; }
    if (diskMtime <= this.lastWriteMtime) return;
    if (!this.loadFile()) this.files = new Map();
  }

  private ingestAgent(agentId: string, mtime: number, size: number, path: string): void {
    const stamp = this.files.get(agentId);
    if (stamp && stamp.mtime === mtime && stamp.size === size) return;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[memory] 全局索引跳过 ${path}（读不动）: ${e}`);
      return;
    }
    if (!raw || typeof raw !== "object") return;

    for (const [key, entry] of [...this.entries]) {
      if (entry.agent === agentId) this.entries.delete(key);
    }

    const facts = Array.isArray(raw.facts) ? (raw.facts as Array<Record<string, unknown>>) : [];
    for (const item of facts) {
      if (!item || typeof item !== "object") continue;
      const content = item.content;
      if (typeof content !== "string" || !content.trim()) continue;
      const status = entryStatus(item);
      if (status.startsWith(RETIRED_PREFIX) || status.startsWith(SHARED_PREFIX)) continue;
      const key = entryKey(content);
      const prev = this.entries.get(key);
      if (prev) { prev.hits += 1; continue; }
      this.entries.set(key, {
        key,
        agent: agentId,
        memId: String(item.id ?? ""),
        content,
        category: String(item.category ?? "fact"),
        importance: Number(item.importance ?? 5),
        timestamp: String(item.timestamp ?? ""),
        hits: Number(item.repeated ?? 0) || 0,
      });
    }
    this.files.set(agentId, { mtime, size });
  }

  private refresh(force = false): void {
    if (this.isolationGate()) return;
    const now = Date.now();
    if (!force && this.loaded && now - this.lastScan < this.ttlMs) return;
    if (!this.loaded) { this.loadFile(); this.loaded = true; }

    const files = scanMemoryFiles(this.baseDir);
    const changedSet = files.size !== this.files.size
      || [...files.keys()].some((k) => !this.files.has(k));
    if (changedSet) {
      for (const agentId of [...this.files.keys()]) {
        if (!files.has(agentId)) {
          for (const [key, entry] of [...this.entries]) {
            if (entry.agent === agentId) this.entries.delete(key);
          }
          this.files.delete(agentId);
        }
      }
    }
    for (const [agentId, info] of files) this.ingestAgent(agentId, info.mtime, info.size, info.path);
    this.reindex();
    this.lastScan = now;
  }

  private persist(): boolean {
    if (this.isolationGate()) return false;
    this.reloadIfChanged();
    const entries: Record<string, Record<string, unknown>> = {};
    for (const [key, entry] of this.entries) {
      const row: Record<string, unknown> = {
        agent: entry.agent,
        mem_id: entry.memId,
        content: entry.content,
        category: entry.category,
        importance: entry.importance,
        timestamp: entry.timestamp,
        hits: entry.hits,
      };
      if (entry.lastHit) row.last_hit = entry.lastHit;
      if (entry.status) row.status = entry.status;
      entries[key] = row;
    }
    const payload = {
      version: GLOBAL_INDEX_VERSION,
      updated_at: new Date().toISOString(),
      derived: true,
      note: "派生索引，真相源是各 agent 的 memory.json；删掉本文件可自动重建。",
      entries,
    };
    try {
      mkdirSync(this.indexDir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 1), "utf8");
      renameSync(tmp, this.path);
    } catch (e) {
      console.warn(`[memory] 全局索引落盘失败（不影响写入，下次重建）: ${e}`);
      return false;
    }
    try { this.lastWriteMtime = statSync(this.path).mtimeMs; } catch { this.lastWriteMtime = 0; }
    return true;
  }

  /**
   * 跨 agent 查重：命中返回归属信息，否则 null。
   *
   * 剪枝依据：Jaccard = |A∩B|/|A∪B| ≥ t 蕴含 |A∩B| ≥ t·|A|（因 |A∪B| ≥ |A|），
   * 所以只比较「与候选共享 token 数 ≥ t·|A|」的条目 —— **充分**剪枝，不漏真命中。
   *
   * 隔离态直接返回 null（不去读那份共享索引）—— 调用方拿不到命中就自然退回
   * per-agent 去重，写入照常成功，只是「多写几条重复」，绝不会读串生产数据。
   */
  check(content: string, opts: { excludeAgent?: string; threshold?: number } = {}): GlobalHit | null {
    if (this.isolationGate()) return null;
    const threshold = opts.threshold ?? 0.75;
    if (!content || !content.trim()) return null;
    const cand = this.tokensFor(content);
    if (!cand.size) return null;
    const need = Math.floor(cand.size * threshold);

    this.refresh();
    const counter = new Map<string, number>();
    for (const tok of cand) {
      for (const key of this.inverted.get(tok) ?? []) {
        counter.set(key, (counter.get(key) ?? 0) + 1);
      }
    }
    let best: GlobalHit | null = null;
    for (const [key, hits] of counter) {
      if (hits < need) continue;
      const entry = this.entries.get(key);
      if (!entry || entry.agent === (opts.excludeAgent ?? "")) continue;
      const other = this.tokensFor(entry.content);
      if (!other.size) continue;
      let inter = 0;
      for (const tok of cand) if (other.has(tok)) inter++;
      if (inter < need) continue;
      const union = cand.size + other.size - inter;
      if (union <= 0) continue;
      const score = inter / union;
      if (score > threshold && (!best || score > best.score)) {
        best = {
          agent: entry.agent, memId: entry.memId, content: entry.content,
          category: entry.category || "fact", score, key,
        };
      }
    }
    if (best) {
      const entry = this.entries.get(best.key);
      if (entry) {
        entry.hits += 1;
        entry.lastHit = new Date().toISOString();
        this.persist();
      }
    }
    return best;
  }

  /** 本地新写入的条目立即登记（不等下一次扫盘，否则同进程连续写会互相看不见）。 */
  upsert(content: string, agentId: string, memId = "", category = "fact", importance = 5, timestamp = ""): void {
    if (this.isolationGate()) return;
    if (!content || !content.trim()) return;
    const key = entryKey(content);
    const existing = this.entries.get(key);
    if (existing) {
      existing.agent = agentId;
      if (memId) existing.memId = memId;
    } else {
      const entry: GlobalEntry = {
        key, agent: agentId, memId, content, category, importance,
        timestamp: timestamp || new Date().toISOString(), hits: 0,
      };
      this.entries.set(key, entry);
    }
    this.reindex();
    this.persist();
  }

  /** 条目被软归档（挤到 archived，仍可查）→ 从活跃索引摘掉，避免自己历史条目误判跨 agent 重复。 */
  noteRetired(content: string, agentId: string): void {
    if (this.isolationGate()) return;
    const key = entryKey(content);
    const entry = this.entries.get(key);
    if (!entry || entry.agent !== agentId) return;
    if (entry.hits > 0) {
      entry.status = RETIRED_PREFIX + agentId;
    } else {
      this.entries.delete(key);
      this.reindex();
    }
    this.persist();
  }

  lookup(content: string): { agent: string; memId: string; content: string } | null {
    if (this.isolationGate()) return null;
    this.refresh();
    const entry = this.entries.get(entryKey(content));
    if (!entry) return null;
    return { agent: entry.agent, memId: entry.memId, content: entry.content };
  }

  /** 跨 agent 召回 —— 让「因为别处已有而没写进本 agent」的内容仍然可达。 */
  recall(query: string, topK = 5, excludeAgent = ""): GlobalRecallItem[] {
    if (this.isolationGate()) return [];
    if (!query || !query.trim()) return [];
    this.refresh();
    const scored: Array<{ score: number; entry: GlobalEntry }> = [];
    for (const entry of this.entries.values()) {
      if (entry.agent === excludeAgent) continue;
      if ((entry.status ?? "").startsWith(RETIRED_PREFIX)) continue;
      scored.push({ score: memSimilarityChecked(query, entry.content), entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, topK)).filter((s) => s.score > 0).map((s) => ({
      agent: s.entry.agent, memId: s.entry.memId, content: s.entry.content,
      category: s.entry.category, importance: s.entry.importance,
      timestamp: s.entry.timestamp, score: s.score,
    }));
  }

  stats(): GlobalIndexStats {
    if (this.isolationGate()) {
      return { entries: 0, agents: 0, indexPath: this.path, ttlS: this.ttlMs / 1000, isolated: true };
    }
    this.refresh();
    const agents = new Set<string>();
    for (const e of this.entries.values()) agents.add(e.agent);
    return {
      entries: this.entries.size, agents: agents.size,
      indexPath: this.path, ttlS: this.ttlMs / 1000, isolated: false,
    };
  }

  /** 只读地数盘上索引有多少条目（不碰进程内任何状态）—— rebuild 守卫要用。 */
  private diskEntryCount(): number {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!raw || typeof raw !== "object") return 0;
      const obj = raw as { version?: number; entries?: Record<string, unknown> };
      if (obj.version !== GLOBAL_INDEX_VERSION) return 0;
      const entries = obj.entries;
      return entries && typeof entries === "object" ? Object.keys(entries).length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * `rebuild()` 的守卫：返回非空字符串 = 拒绝执行（空串 = 放行）。
   *
   * 为什么 `rebuild()` 必须有守卫：它是**唯一**会整体重写索引的入口 —— 清空内存态、
   * 扫全 baseDir、把结果整份盖回 `.global/index.json`。扫错目录（拼错的路径、没挂上的盘、
   * 权限被拒的目录）在 `scanMemoryFiles` 里都表现为「一个目录都没有」，于是一份好好的
   * 索引会被**静默覆盖成空**。索引自愈的下一步是「再扫一次」，扫不到就永远回不来 ——
   * 所以宁可拒绝，不猜。
   *   ① isolated —— 隔离场景压根不该碰这台机器的共享索引；
   *   ② base-dir-missing —— baseDir 不是现成的目录（拼错/没建），不许顺手建出一棵
   *      假的记忆根再往里写索引；
   *   ③ empty-scan-would-wipe-index —— 扫不到任何 agent，但盘上索引本来是有条目的。
   *      这是「扫错地方」的典型指纹，不是「记忆真的被删干净了」。真要清空请显式
   *      `rebuild(true)`（那是有意为之，不再是意外）。
   */
  private rebuildRefusal(force = false): string {
    if (this.isolationGate()) return "isolated";
    if (!this.baseDir || !existsSync(this.baseDir)) return "base-dir-missing";
    if (force) return "";
    if (scanMemoryFiles(this.baseDir).size > 0) return "";
    if (this.diskEntryCount() > 0) return "empty-scan-would-wipe-index";
    return "";
  }

  /**
   * 从各 agent 的 memory.json 完整重建（派生索引的自愈路径）。
   *
   * `force=true` 只放宽守卫 ③（明知扫不到还要按扫到的结果重写），①② 永远不放宽 ——
   * 隔离就是隔离，目录不存在就是不存在。
   * 返回值在原 `stats()` 形状上追加 `rebuilt` / `refused`：被守卫挡下时 `rebuilt=false`，
   * `refused` 是原因串，调用方能**观察到**拒绝而不是以为重建过了。
   */
  rebuild(force = false): GlobalIndexStats {
    const refusal = this.rebuildRefusal(force);
    if (refusal) return { ...this.stats(), rebuilt: false, refused: refusal };
    this.entries = new Map();
    this.inverted = new Map();
    this.files = new Map();
    this.tokenOf = new Map();
    this.loaded = true;
    // 索引文件读不出来（损坏/被删）时指纹也作废，否则「指纹没变」会让 refresh 跳过重新读盘。
    if (!this.loadFile()) this.files = new Map();
    this.refresh(true);
    this.persist();
    return { ...this.stats(), rebuilt: true, refused: "" };
  }
}

let _similarity: ((a: string, b: string) => number) | null = null;
function memSimilarityChecked(a: string, b: string): number {
  return (_similarity ?? memSimilarity)(a, b);
}

/** 兼容注入点：默认就用 similarity.ts 的 textSimilarity（同判据单源）。 */
export function setSimilarityFn(fn: (a: string, b: string) => number): void {
  _similarity = fn;
}

const instances = new Map<string, GlobalMemoryIndex>();

export function globalIndexKey(baseDir: string): string {
  if (!baseDir) return "";
  const abs = resolve(baseDir);
  if (process.platform !== "win32") return abs;
  return abs.replace(
    /^((?:\\\\\?\\)?)([a-z]):/,
    (_m, prefix: string, drive: string) => `${prefix}${drive.toUpperCase()}:`,
  );
}

/**
 * 按记忆根目录取索引单例（进程内）。
 *
 * 隔离根目录返回的是一个**惰性实例**（`isolated === true`）而不是 `null` ——
 * 这样「拿不到索引」在类型上就不可能变成 `undefined` 崩溃，而调用方要真正跳过
 * 跨 agent 去重时读 `idx.isolated` 即可，护栏对读代码的人一眼可见。
 *
 * 单例 key 仍是 `globalIndexKey(baseDir)`（与 Python 侧 `str(Path(base_dir).resolve())`
 * 逐字节相同）；隔离不参与 key，因为隔离实例本身在**每次调用时**重新判定 ——
 * 闩锁一合，之前取到的那个单例立刻变惰性，不存在「拿着隔离前的旧内存态继续跑」这条缝。
 * （显式隔离只走 `new GlobalMemoryIndex(dir, ttl, true)`，不进单例池 ——
 * 否则一个带显式覆盖的单例会被缓存下来，反过来把闩锁顶掉。）
 */
export function getGlobalIndex(baseDir: string, ttlS = DEFAULT_GLOBAL_INDEX_TTL_S): GlobalMemoryIndex {
  const key = globalIndexKey(baseDir);
  let inst = instances.get(key);
  if (!inst) {
    inst = new GlobalMemoryIndex(baseDir, ttlS);
    instances.set(key, inst);
  }
  return inst;
}

export function resetGlobalIndex(): void {
  instances.clear();
}
