











































import { inferModelCapabilities } from "shared/model-capabilities";


export function maxOutputCeilingOf(modelId: string): number | undefined {
  const cap = inferModelCapabilities(modelId ?? "").maxOut;
  return typeof cap === "number" && cap > 0 ? cap : undefined;
}







export function capMaxTokensForModel(modelId: string, requested: number | undefined | null): number | undefined {
  
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return undefined;
  }
  const ceiling = maxOutputCeilingOf(modelId);
  if (ceiling === undefined) { return requested; }
  return requested > ceiling ? ceiling : requested;
}








export function applyMaxTokensCap<T extends object>(payload: T, modelId: string): T {
  const p = payload as Record<string, unknown>;
  if (!("max_tokens" in p)) { return payload; }
  const requested = typeof p.max_tokens === "number" ? p.max_tokens : undefined;
  const capped = capMaxTokensForModel(modelId, requested);
  if (capped === p.max_tokens) { return payload; }
  return { ...payload, max_tokens: capped };
}
