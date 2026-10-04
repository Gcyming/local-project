









export interface PlanItemLite {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}


export interface TimelineStepLite {
  kind: "think" | "body" | "tool" | "plan" | "todo" | "steer";
  




  text?: string;
  name?: string;
  label?: string;
  detail?: string;
  result?: string;
  


  items?: PlanItemLite[];
  
  state?: "start" | "done";
  









  running?: boolean;
}

export interface SessionCtxMeta {
  used: number;
  cap: number;
  







  capModel?: string;
  
  timelineByAssistantIdx: Record<number, TimelineStepLite[]>;
}




export function normalizeCapModel(modelChoice: string | undefined | null): string {
  const s = typeof modelChoice === "string" ? modelChoice.trim() : "";
  return s || "inherit";
}







export function capForModel(meta: SessionCtxMeta | null | undefined, modelChoice: string | undefined | null): number {
  if (!meta || !(meta.cap > 0)) { return 0; }
  return normalizeCapModel(meta.capModel) === normalizeCapModel(modelChoice) ? meta.cap : 0;
}

export function sessionCtxStorageKey(agentId: string, sessionId: string): string {
  return `slime_ctxmeta_${agentId}_${sessionId}`;
}

export function readSessionCtxMeta(agentId: string, sessionId: string): SessionCtxMeta | null {
  try {
    const raw = localStorage.getItem(sessionCtxStorageKey(agentId, sessionId));
    if (!raw) { return null; }
    const parsed = JSON.parse(raw) as SessionCtxMeta;
    if (typeof parsed !== "object" || parsed === null) { return null; }
    return parsed;
  } catch { return null; }
}

export function writeSessionCtxMeta(agentId: string, sessionId: string, meta: SessionCtxMeta): void {
  try { localStorage.setItem(sessionCtxStorageKey(agentId, sessionId), JSON.stringify(meta)); } catch {  }
}

export function clearSessionCtxMeta(agentId: string, sessionId: string): void {
  try { localStorage.removeItem(sessionCtxStorageKey(agentId, sessionId)); } catch {  }
}






export function updateSessionCtxMeta(
  agentId: string,
  sessionId: string,
  ordinal: number,
  payload: { used?: number; cap?: number; capModel?: string; timeline?: TimelineStepLite[] },
): SessionCtxMeta {
  const prev = readSessionCtxMeta(agentId, sessionId) ?? { used: 0, cap: 0, timelineByAssistantIdx: {} };
  if (payload.used && payload.used > 0) { prev.used = payload.used; }
  if (payload.cap && payload.cap > 0) {
    prev.cap = payload.cap;
    

    prev.capModel = normalizeCapModel(payload.capModel);
  }
  if (payload.timeline && payload.timeline.length > 0 && ordinal > 0) {
    prev.timelineByAssistantIdx[ordinal] = payload.timeline;
  }
  writeSessionCtxMeta(agentId, sessionId, prev);
  return prev;
}







export interface LooseTimelineStep {
  kind: string;
  text?: string;
  name?: string;
  label?: string;
  detail?: string;
  result?: string;
  items?: PlanItemLite[];
  state?: "start" | "done";
  


  running?: boolean;
}


function adoptRecordTimeline(tl: readonly LooseTimelineStep[] | undefined): TimelineStepLite[] | undefined {
  if (!tl || tl.length === 0) { return undefined; }
  return tl as unknown as TimelineStepLite[];
}


















export function settleRunning(steps: readonly TimelineStepLite[] | undefined): TimelineStepLite[] | undefined {
  if (!steps || steps.length === 0) { return steps as TimelineStepLite[] | undefined; }
  if (!steps.some((s) => s.running)) { return steps as TimelineStepLite[]; }
  return steps.map((s) => (s.running ? { ...s, running: false } : s));
}














export function attachTimelineToHistory(
  msgs: Array<{ role: string; reasoning?: string; content?: string; timeline?: readonly LooseTimelineStep[] }>,
  meta: SessionCtxMeta | null,
): Array<{ timeline?: TimelineStepLite[]; reasoning?: string; assistantOrdinal?: number }> {
  let aiOrd = 0;
  return msgs.map((m) => {
    if (m.role !== "assistant") { return { assistantOrdinal: undefined }; }
    aiOrd += 1;
    const stored = meta?.timelineByAssistantIdx?.[aiOrd];
    const fromMeta = stored && stored.length > 0 ? stored : undefined;
    return {
      



      timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),
      reasoning: m.reasoning,
      assistantOrdinal: aiOrd,
    };
  });
}



export function restoreUsed(meta: SessionCtxMeta | null): number {
  return meta && meta.used > 0 ? meta.used : 0;
}