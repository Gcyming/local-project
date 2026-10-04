

































export type FlowKind = "thinking" | "idea";

export interface FlowEntry {
  

  id: number;
  name: string;
  text: string;
  kind: FlowKind;
}

export interface FlowState {
  entries: FlowEntry[];
  
  dropped: number;
  
  nextId: number;
  
  updatedAt: number;
}






export const FLOW_MAX_ENTRIES = 400;


export const FLOW_THINKING_COALESCE_CHARS = 600;


export const FLOW_STORE_PREFIX = "slime_bsflow_";


export const FLOW_MAX_SESSIONS = 30;

export function emptyFlowState(): FlowState {
  return { entries: [], dropped: 0, nextId: 1, updatedAt: 0 };
}




export interface FlowEvent {
  kind: FlowKind;
  name: string;
  text: string;
}











export function applyFlowEvent(state: FlowState, ev: FlowEvent): FlowState {
  const text = typeof ev.text === "string" ? ev.text : "";
  if (!text.trim()) { return state; } 

  const entries = state.entries;
  const last = entries[entries.length - 1];
  if (ev.kind === "thinking" && last && last.kind === "thinking" && last.name === ev.name) {
    const room = FLOW_THINKING_COALESCE_CHARS - last.text.length;
    if (room > 0) {
      const filled = { ...last, text: last.text + text.slice(0, room) };
      const rest = text.slice(room);
      if (!rest) {
        const next = entries.slice();
        next[next.length - 1] = filled;
        return { ...state, entries: next };
      }
      
      return pushEntry({ ...state, entries: [...entries.slice(0, -1), filled] }, ev.kind, ev.name, rest);
    }
  }
  return pushEntry(state, ev.kind, ev.name, text);
}








function pushEntry(state: FlowState, kind: FlowKind, name: string, text: string): FlowState {
  const added: FlowEntry[] = [];
  for (let off = 0; off < text.length; off += FLOW_THINKING_COALESCE_CHARS) {
    added.push({
      id: state.nextId + added.length,
      name,
      text: text.slice(off, off + FLOW_THINKING_COALESCE_CHARS),
      kind,
    });
  }
  let next = [...state.entries, ...added];
  let dropped = state.dropped;
  if (next.length > FLOW_MAX_ENTRIES) {
    const cut = next.length - FLOW_MAX_ENTRIES;
    next = next.slice(cut);
    dropped += cut;
  }
  return { entries: next, dropped, nextId: state.nextId + added.length, updatedAt: state.updatedAt };
}


export function appendFlowEvents(state: FlowState, evs: readonly FlowEvent[]): FlowState {
  let next = state;
  for (const ev of evs) { next = applyFlowEvent(next, ev); }
  return next;
}



export function flowStorageKey(sessionId: string): string {
  return `${FLOW_STORE_PREFIX}${sessionId}`;
}





export function readFlowState(sessionId: string): FlowState | null {
  if (!sessionId) { return null; }
  try {
    const raw = localStorage.getItem(flowStorageKey(sessionId));
    if (!raw) { return null; }
    const p = JSON.parse(raw) as Partial<FlowState>;
    if (!p || typeof p !== "object" || !Array.isArray(p.entries)) { return null; }
    const entries: FlowEntry[] = [];
    for (const raw2 of p.entries) {
      const e = raw2 as Partial<FlowEntry>;
      if (!e || typeof e.text !== "string" || typeof e.name !== "string") { continue; }
      if (e.kind !== "thinking" && e.kind !== "idea") { continue; }
      if (typeof e.id !== "number" || !Number.isFinite(e.id)) { continue; }
      entries.push({ id: e.id, name: e.name, text: e.text, kind: e.kind });
    }
    if (entries.length === 0) { return null; }
    const maxId = entries.reduce((m, e) => (e.id > m ? e.id : m), 0);
    const nextId = typeof p.nextId === "number" && p.nextId > maxId ? p.nextId : maxId + 1;
    return {
      entries,
      dropped: typeof p.dropped === "number" && p.dropped > 0 ? Math.floor(p.dropped) : 0,
      nextId,
      updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
    };
  } catch { return null; }
}


export function writeFlowState(sessionId: string, state: FlowState, now: number = Date.now()): void {
  if (!sessionId) { return; }
  const payload: FlowState = { ...state, updatedAt: now };
  try {
    localStorage.setItem(flowStorageKey(sessionId), JSON.stringify(payload));
  } catch {  }
  pruneFlowStorage(FLOW_MAX_SESSIONS, sessionId);
}

export function clearFlowState(sessionId: string): void {
  if (!sessionId) { return; }
  try { localStorage.removeItem(flowStorageKey(sessionId)); } catch {  }
}







export function pruneFlowStorage(maxSessions: number = FLOW_MAX_SESSIONS, keepSessionId?: string): number {
  try {
    const found: Array<{ key: string; updatedAt: number }> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(FLOW_STORE_PREFIX)) { continue; }
      if (keepSessionId && k === flowStorageKey(keepSessionId)) { continue; }
      let updatedAt = 0;
      try {
        const p = JSON.parse(localStorage.getItem(k) ?? "") as { updatedAt?: unknown };
        if (typeof p?.updatedAt === "number") { updatedAt = p.updatedAt; }
      } catch {  }
      found.push({ key: k, updatedAt });
    }
    
    const allowed = Math.max(0, maxSessions - (keepSessionId ? 1 : 0));
    if (found.length <= allowed) { return 0; }
    found.sort((a, b) => a.updatedAt - b.updatedAt);
    const victims = found.slice(0, found.length - allowed);
    for (const v of victims) { localStorage.removeItem(v.key); }
    return victims.length;
  } catch { return 0; }
}
