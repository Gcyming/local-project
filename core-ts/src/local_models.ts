



















export const LOCAL_MODELS_KEY = "_local_models";








export interface LocalModelSpec {
  id: string;
  
  path: string;
  label?: string;
  
  ctx_len?: number;
  
  gpu_layers?: number;
  max_output?: number;
  vision?: boolean;
}









export function findLocalModelSpec(
  table: Record<string, unknown> | undefined | null,
  id: string,
): LocalModelSpec | undefined {
  const raw = table?.[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return undefined; }
  return (raw as LocalModelSpec[]).find(
    (m) => m && typeof m === "object" && m.id === id,
  );
}







export function localModelSpecs(
  table: Record<string, unknown> | undefined | null,
): LocalModelSpec[] {
  const raw = table?.[LOCAL_MODELS_KEY];
  if (!Array.isArray(raw)) { return []; }
  return raw.filter((m): m is LocalModelSpec =>
    typeof m === "object" && m !== null &&
    typeof (m as LocalModelSpec).id === "string" &&
    typeof (m as LocalModelSpec).path === "string");
}
