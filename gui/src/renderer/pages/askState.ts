







import type { AskUserDecision, AskUserRequestUI } from "../../shared/ipc.js";

export const ASK_CUSTOM_CHOICE = "__custom";

export const ASK_CANCEL_MARKER = "[slime:ask-cancel]";

export function buildAskDecision(requestId: string, choice: string, custom?: string): AskUserDecision {
  const text = choice === ASK_CUSTOM_CHOICE ? (custom ?? "").trim() : choice;
  const picked = choice !== ASK_CUSTOM_CHOICE && choice !== "" ? choice : undefined;
  return {
    requestId,
    answer: text || "（未填写）",
    skipped: false,
    ...(picked ? { choice: picked } : {}),
  };
}

export function initialAskSelection(options: string[]): string {
  return options.length > 0 ? options[0] : ASK_CUSTOM_CHOICE;
}

export function enqueueAsk(queue: AskUserRequestUI[], req: AskUserRequestUI): AskUserRequestUI[] {
  if (queue.some((x) => x.requestId === req.requestId)) { return queue; }
  return [...queue, req];
}

export function dequeueAsk(queue: AskUserRequestUI[], requestId: string): AskUserRequestUI[] {
  const idx = queue.findIndex((x) => x.requestId === requestId);
  if (idx < 0) { return queue; }
  return [...queue.slice(0, idx), ...queue.slice(idx + 1)];
}

export function headAsk(queue: AskUserRequestUI[]): AskUserRequestUI | null {
  return queue.length > 0 ? queue[0] : null;
}


export function canSubmitAsk(submitting: boolean, selected: string, custom: string): boolean {
  if (submitting) { return false; }
  return !(selected === "__custom" && !custom.trim());
}


export function safeRecommendation(
  options: string[],
  recommendation: number | undefined,
): number | undefined {
  if (recommendation === undefined || options.length === 0) { return undefined; }
  if (Number.isInteger(recommendation) && recommendation >= 0 && recommendation < options.length) {
    return recommendation;
  }
  return undefined;
}


export function consequenceAt(consequences: string[] | undefined, index: number): string | undefined {
  return Array.isArray(consequences) ? consequences[index] : undefined;
}