


























export interface HistoryGateInput {
  
  sessionsReady: boolean;
  
  sessionCount: number;
  





  selectionSettled: boolean;
  
  hasSelectedSession: boolean;
  
  hasAgentId: boolean;
}

export type HistoryGateDecision = "wait" | "self-finish";


export function decideHistoryGate(input: HistoryGateInput): HistoryGateDecision {
  if (!input.sessionsReady) { return "wait"; }
  if (input.sessionCount === 0) { return "self-finish"; }
  if (!input.selectionSettled) { return "wait"; }
  if (input.hasSelectedSession && input.hasAgentId) { return "wait"; }
  return "self-finish";
}












export const HISTORY_SETTLE_FRAMES = 2;


export const SETTLE_FALLBACK_MS = 120;












export function settleAfterFrames(
  frames: number,
  done: () => void,
  raf: (cb: () => void) => unknown = (cb) => window.requestAnimationFrame(cb),
  
  schedule: (cb: () => void, ms: number) => unknown = (cb, ms) => globalThis.setTimeout(cb, ms),
): void {
  let finished = false;
  const finish = (): void => { if (!finished) { finished = true; done(); } };
  if (frames <= 0) { finish(); return; }
  
  schedule(finish, SETTLE_FALLBACK_MS);
  const step = (left: number): void => {
    if (left <= 0) { finish(); return; }
    raf(() => step(left - 1));
  };
  step(frames);
}























export interface UiReadyInput {
  
  firstLoad: Record<string, boolean>;
  
  metadataGuard: boolean;
  
  contentGuard: boolean;
  
  metadataKeys: readonly string[];
  
  contentKey: string;
}

export type UiReadyForcedBy = "none" | "metadata-timeout" | "content-timeout" | "both-timeout";

export interface UiReadyDecision {
  ready: boolean;
  
  forcedBy: UiReadyForcedBy;
  
  missing: string[];
}


export function decideUiReady(i: UiReadyInput): UiReadyDecision {
  const metadataMissing = i.metadataKeys.filter((k) => !i.firstLoad[k]);
  const contentMissing = !i.firstLoad[i.contentKey];
  const metadataOk = metadataMissing.length === 0 || i.metadataGuard;
  const contentOk = !contentMissing || i.contentGuard;
  const missing = [...metadataMissing, ...(contentMissing ? [i.contentKey] : [])];
  let forcedBy: UiReadyForcedBy = "none";
  if (metadataOk && contentOk && missing.length > 0) {
    const mdForced = metadataMissing.length > 0;
    const ctForced = contentMissing;
    forcedBy = mdForced && ctForced ? "both-timeout" : mdForced ? "metadata-timeout" : "content-timeout";
  }
  return { ready: metadataOk && contentOk, forcedBy, missing };
}

