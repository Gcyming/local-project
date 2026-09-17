/**
 * core-ts/src/memory/three_layer.ts — 记忆三层架构（MemGPT working/episodic/semantic 对标）。
 *
 * 纯函数调度：每条记忆依来源与新鲜度归档到 working/episodic/semantic 层；
 * 到期自动下调一层（working → episodic → semantic），语义层永久保留。
 * 写入时机（consolidation）由装配方（演化引擎/会话收尾）调用。
 */
export type MemoryLayer = "working" | "episodic" | "semantic";

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  createdAt: number;
  lastAccessAt?: number;
  /** 访问次数（沉淀判据：episodic 到期且被多次访问 → 语义化） */
  accessCount?: number;
  /** 关联实体 key（图谱桥） */
  entityKeys?: string[];
}

export const LAYER_TTL_MS: Record<Exclude<MemoryLayer, "semantic">, number> = {
  working: 0, // 工作记忆随会话生命周期；由会话收尾触发下迁，不存在绝对 TTL
  episodic: 30 * 24 * 3600 * 1000, // 情景记忆 30 天
};

export interface MemoryInput {
  content: string;
  source: "conversation" | "event" | "fact" | "preference" | "plan";
  createdAt: number;
  entityKeys?: string[];
}

/** 层分类依据来源（事实/偏好 → 语义；事件/交互 → 情景；计划/即时上下文 → 工作）。 */
export function classifyLayer(input: { source: MemoryInput["source"] }): MemoryLayer {
  switch (input.source) {
    case "fact":
    case "preference":
      return "semantic";
    case "conversation":
    case "event":
      return "episodic";
    default:
      return "working";
  }
}

/** 建条目（层由来源决定）。 */
export function createEntry(input: MemoryInput, id?: string): MemoryEntry {
  return {
    id: id ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    layer: classifyLayer(input),
    content: input.content,
    createdAt: input.createdAt,
    entityKeys: input.entityKeys,
  };
}

/**
 * 到期迁移建议：返回目标层。
 *   working → 会话收尾（consolidateNow=true）或超过 episodic 上限时 → episodic；
 *   episodic → 超过 30 天且被多次访问（>= minAccess）→ semantic（沉淀）；否则建议 prune。
 * 语义层恒返回自身（不迁移）。
 */
export function migrationTarget(
  entry: MemoryEntry,
  now: number,
  opts: { consolidateNow?: boolean; minAccess?: number } = {},
): { action: "keep" | "down" | "prune"; target?: MemoryLayer } {
  if (entry.layer === "semantic") { return { action: "keep" }; }
  if (entry.layer === "working") {
    if (opts.consolidateNow) { return { action: "down", target: "episodic" }; }
    if (now - entry.createdAt > LAYER_TTL_MS.episodic) { return { action: "down", target: "episodic" }; }
    return { action: "keep" };
  }
  // episodic
  if (now - entry.createdAt > LAYER_TTL_MS.episodic) {
    const access = entry.accessCount ?? (entry.lastAccessAt !== undefined ? 1 : 0);
    if (access >= (opts.minAccess ?? 2)) { return { action: "down", target: "semantic" }; }
    return { action: "prune" };
  }
  return { action: "keep" };
}

/** 按 TTL 过滤过期条目（值语义：返回新数组，不修改入参）。 */
export function pruneExpired(entries: MemoryEntry[], now: number): MemoryEntry[] {
  return entries.filter((e) => {
    if (e.layer === "semantic") { return true; }
    if (e.layer === "working") { return true; } // 工作记忆由会话生命周期管理
    return now - e.createdAt <= LAYER_TTL_MS.episodic;
  });
}