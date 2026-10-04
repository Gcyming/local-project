






export type MemoryLayer = "working" | "episodic" | "semantic";

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  createdAt: number;
  lastAccessAt?: number;
  
  accessCount?: number;
  
  entityKeys?: string[];
}

export const LAYER_TTL_MS: Record<Exclude<MemoryLayer, "semantic">, number> = {
  working: 0, 
  episodic: 30 * 24 * 3600 * 1000, 
};

export interface MemoryInput {
  content: string;
  source: "conversation" | "event" | "fact" | "preference" | "plan";
  createdAt: number;
  entityKeys?: string[];
}


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


export function createEntry(input: MemoryInput, id?: string): MemoryEntry {
  return {
    id: id ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    layer: classifyLayer(input),
    content: input.content,
    createdAt: input.createdAt,
    entityKeys: input.entityKeys,
  };
}







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
  
  if (now - entry.createdAt > LAYER_TTL_MS.episodic) {
    const access = entry.accessCount ?? (entry.lastAccessAt !== undefined ? 1 : 0);
    if (access >= (opts.minAccess ?? 2)) { return { action: "down", target: "semantic" }; }
    return { action: "prune" };
  }
  return { action: "keep" };
}


export function pruneExpired(entries: MemoryEntry[], now: number): MemoryEntry[] {
  return entries.filter((e) => {
    if (e.layer === "semantic") { return true; }
    if (e.layer === "working") { return true; } 
    return now - e.createdAt <= LAYER_TTL_MS.episodic;
  });
}