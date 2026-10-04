







import type { AskUserDecision } from "../../shared/ipc.js";


export function buildAskDecision(requestId: string, choice: string, custom?: string): AskUserDecision {
  const text = choice === "__custom" ? (custom ?? "").trim() : choice;
  return { requestId, answer: text || "（未填写）", skipped: false };
}


export function initialAskSelection(options: string[]): string {
  return options.length > 0 ? options[0] : "__custom";
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