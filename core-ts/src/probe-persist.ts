














import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { LiveProbeCache } from "./probe-live.js";


export interface ProbeSnapshotStore {
  
  version: 1;
  
  savedAt: number;
  
  snapshots: Array<{
    provider: string;
    model: string;
    ts: number;
    contextWindow?: number;
    streaming?: boolean;
    toolCalls?: boolean;
    reasoning?: boolean;
    latencyMs?: number;
    lastErrorType?: string;
    
    modelDead?: boolean;
  }>;
}

const DEFAULT_PATH = join(PROJECT_ROOT, "config", "live_probe.json");
const SCHEMA_VERSION: ProbeSnapshotStore["version"] = 1;


function sanitizeSnapshots(raw: unknown): ProbeSnapshotStore["snapshots"] {
  if (!Array.isArray(raw)) { return []; }
  const out: ProbeSnapshotStore["snapshots"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") { continue; }
    const r = item as Record<string, unknown>;
    if (typeof r.provider !== "string" || typeof r.model !== "string" || typeof r.ts !== "number") {
      continue;
    }
    const snap: ProbeSnapshotStore["snapshots"][number] = {
      provider: r.provider,
      model: r.model,
      ts: r.ts,
    };
    if (typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow)) { snap.contextWindow = r.contextWindow; }
    if (typeof r.streaming === "boolean") { snap.streaming = r.streaming; }
    if (typeof r.toolCalls === "boolean") { snap.toolCalls = r.toolCalls; }
    if (typeof r.reasoning === "boolean") { snap.reasoning = r.reasoning; }
    if (typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs)) { snap.latencyMs = r.latencyMs; }
    if (typeof r.lastErrorType === "string") { snap.lastErrorType = r.lastErrorType; }
    if (typeof r.modelDead === "boolean") { snap.modelDead = r.modelDead; }
    out.push(snap);
  }
  return out;
}


export function loadProbeSnapshots(path: string = DEFAULT_PATH): ProbeSnapshotStore["snapshots"] {
  try {
    if (!existsSync(path)) { return []; }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProbeSnapshotStore>;
    if (parsed.version !== SCHEMA_VERSION) { return []; } 
    return sanitizeSnapshots(parsed.snapshots);
  } catch {
    return []; 
  }
}


export function saveProbeSnapshots(snapshots: ProbeSnapshotStore["snapshots"], path: string = DEFAULT_PATH): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: ProbeSnapshotStore = { version: SCHEMA_VERSION, savedAt: Date.now(), snapshots };
    const tmp = `${path}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}


export function persistLiveProbeCache(cache: LiveProbeCache, path?: string): boolean {
  return saveProbeSnapshots(cache.toJSON(), path);
}


export function hydrateLiveProbeCache(cache: LiveProbeCache, path?: string): number {
  const snaps = loadProbeSnapshots(path);
  cache.hydrate(snaps);
  return cache.size();
}


export function defaultProbeSnapshotPath(): string {
  return DEFAULT_PATH;
}
