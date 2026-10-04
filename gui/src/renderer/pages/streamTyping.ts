






































export const TYPING_STEP_MS = 28;


export interface TypingTuning {
  stepMs: number;
  catchupChars: number;
  divisor: number;
}











export const BODY_TYPING: TypingTuning = { stepMs: TYPING_STEP_MS, catchupChars: 240, divisor: 12 };


export const THINK_TYPING: TypingTuning = { stepMs: TYPING_STEP_MS, catchupChars: 320, divisor: 40 };

export interface TypingAdvance {
  
  shown: string;
  
  lastAt: number;
  
  emitted: boolean;
}








export function advanceTypingShown(
  shown: string,
  full: string,
  lastAt: number,
  now: number,
  t: TypingTuning = BODY_TYPING,
): TypingAdvance {
  let s = typeof shown === "string" ? shown : "";
  let at = Number.isFinite(lastAt) ? lastAt : 0;
  if (!full || !full.startsWith(s)) { s = ""; at = 0; }
  if (s.length >= full.length) { return { shown: s, lastAt: at, emitted: false }; }
  const backlog = full.length - s.length;
  if (backlog > t.catchupChars) {
    s = full.slice(0, s.length + Math.max(4, Math.ceil(backlog / t.divisor)));
    at = now;
  } else if (now - at >= t.stepMs) {
    s = full.slice(0, s.length + 1);
    at = now;
  }
  return { shown: s, lastAt: at, emitted: s.length > shown.length };
}


export interface TypingTailStep { kind: string; text?: string }








export function tailTypingTarget(steps: readonly TypingTailStep[]): { key: string; text: string } | null {
  if (!Array.isArray(steps) || steps.length === 0) { return null; }
  const i = steps.length - 1;
  const last = steps[i];
  if (!last || (last.kind !== "think" && last.kind !== "body")) { return null; }
  return { key: `${i}:${last.kind}`, text: last.text ?? "" };
}


export interface TailTypingState { key: string; shown: string; lastAt: number }


export const IDLE_TAIL_TYPING: TailTypingState = { key: "", shown: "", lastAt: 0 };








export function advanceTailTyping(
  state: TailTypingState,
  target: { key: string; text: string } | null,
  now: number,
  t: TypingTuning = THINK_TYPING,
): TailTypingState {
  if (!target) { return IDLE_TAIL_TYPING; }
  const base = (state.key === target.key && target.text.startsWith(state.shown))
    ? state
    : { key: target.key, shown: "", lastAt: 0 };
  const next = advanceTypingShown(base.shown, target.text, base.lastAt, now, t);
  return { key: target.key, shown: next.shown, lastAt: next.lastAt };
}











export function tailTypingHasBacklog(state: TailTypingState, steps: readonly TypingTailStep[]): boolean {
  const t = tailTypingTarget(steps);
  if (!t) { return false; }
  if (state.key !== t.key) { return t.text.length > 0; }
  return state.shown.length < t.text.length;
}













export function trimTailToShown<T extends TypingTailStep>(steps: readonly T[], shown: string): readonly T[] {
  if (!Array.isArray(steps) || steps.length === 0) { return steps; }
  const i = steps.length - 1;
  const last = steps[i];
  if (!last || (last.kind !== "think" && last.kind !== "body")) { return steps; }
  const text = last.text ?? "";
  if (typeof shown !== "string" || text === shown || !text.startsWith(shown)) { return steps; }
  return [...steps.slice(0, i), { ...last, text: shown }];
}
