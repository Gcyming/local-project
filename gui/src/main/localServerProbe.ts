


























import { ModelServerManager, getModelServer, ServerState } from "../../../core-ts/src/model_server.js";
import {
  emptyCapability,
  type LocalServerCapability,
} from "../../../core-ts/src/model_introspect.js";



import {
  PROBE_TIMEOUT_MS,
  stripApiSuffix,
  propsUrlFor,
  modelsUrlFor,
  probeLocalEndpoint,
} from "../../../core-ts/src/local_server_io.js";

export { PROBE_TIMEOUT_MS, stripApiSuffix, propsUrlFor, modelsUrlFor, probeLocalEndpoint };



const CACHE_TTL_MS = 2000;

interface CacheEntry { at: number; cap: LocalServerCapability }
const cache = new Map<string, CacheEntry>();










export function clearLocalCapabilityCache(): void {
  cache.clear();
}




export function isLoopbackBaseUrl(base: string): boolean {
  const b = (base ?? "").trim().toLowerCase();
  if (!b) { return false; }
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/.test(b);
}


export async function getLocalCapability(base: string, opts: { timeoutMs?: number; alias?: string; bypassCache?: boolean } = {}): Promise<LocalServerCapability> {
  const key = `${stripApiSuffix(base)}|${opts.alias ?? ""}`;
  const now = Date.now();
  if (!opts.bypassCache) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) { return hit.cap; }
  }
  let cap: LocalServerCapability;
  try {
    cap = await probeLocalEndpoint(base, opts);
  } catch {
    
    cap = emptyCapability("down");
  }
  cache.set(key, { at: now, cap });
  return cap;
}








export function normalizeModelPath(p: string): string {
  return (p ?? "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}














export function capabilityMatchesModel(
  cap: LocalServerCapability,
  model: { path?: string | null; ids?: string[]; trustedEndpoint?: boolean },
): boolean {
  if (model.trustedEndpoint) { return true; }
  const wantPath = model.path ? normalizeModelPath(model.path) : "";
  const gotPath = cap.modelPath ? normalizeModelPath(cap.modelPath) : "";
  if (wantPath && gotPath) { return wantPath === gotPath; }
  const ids = (model.ids ?? []).filter(Boolean);
  if (ids.length > 0 && cap.alias) {
    const alias = normalizeModelPath(cap.alias);
    return ids.some((id) => normalizeModelPath(id) === alias || normalizeModelPath(id) === gotPath);
  }
  
  return false;
}










export function managedChatPorts(): number[] {
  const ports = new Set<number>();
  try {
    const mgr = getModelServer();
    if (mgr) {
      for (const it of mgr.status()) {
        if (it.role === "chat" && it.state === ServerState.READY && it.port > 0) { ports.add(it.port); }
      }
    }
  } catch {  }
  try {
    const reg = ModelServerManager.readRegistry();
    const chat = reg?.["chat"] as { port?: unknown; state?: unknown } | undefined;
    const port = Number(chat?.port ?? 0);
    if (port > 0 && (chat?.state === undefined || chat?.state === ServerState.READY)) {
      ports.add(port);
    }
  } catch {  }
  return [...ports];
}







export async function probeManagedChatCapability(
  expect: { path?: string | null; ids?: string[] } = {},
): Promise<LocalServerCapability | null> {
  const ports = managedChatPorts();
  if (ports.length === 0) { return null; }
  let last: LocalServerCapability | null = null;
  for (const port of ports) {
    const cap = await getLocalCapability(`http://127.0.0.1:${port}`);
    if (cap.state === "ready" && cap.effectiveCtx !== null && capabilityMatchesModel(cap, expect)) { return cap; }
    last ??= cap;
  }
  return last;
}
