










































export const MODEL_LEVEL_ERROR_RE =
  /regionerror|not available in your (country|region)|model (is |not )?unavailable|model_not_found|model not found|freeusagelimit|endpoint is unavailable|invalid model|no such model|unknown model|unsupported model|does not exist|模型不存在|模型不可用|不存在(的)?模型|无效(的)?模型|模型已下线|模型下线|请检查模型代码/i;






const ZHIPU_MODEL_NOT_FOUND_CODE_RE = /"code"\s*:\s*"?1211"?\b/;






export function isModelLevelErrorText(text: string | undefined | null): boolean {
  if (!text) { return false; }
  const t = String(text);
  return MODEL_LEVEL_ERROR_RE.test(t) || ZHIPU_MODEL_NOT_FOUND_CODE_RE.test(t);
}












export function modelScopeFromUpstreamText(text: string, status: number): "model" | "provider" | undefined {
  if (!text) { return undefined; }
  if (status === 401) { return "provider"; }
  if (isModelLevelErrorText(text)) { return "model"; }
  if (status === 403) { return "provider"; }
  return undefined;
}
