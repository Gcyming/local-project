




























export const INHERIT_MODEL = "inherit";










export function toggleModelInPool(pool: readonly string[], value: string, checked: boolean): string[] {
  
  
  const cur = Array.isArray(pool)
    ? pool.filter((v) => typeof v === "string" && v !== "" && v !== INHERIT_MODEL)
    : [];
  if (typeof value !== "string" || value === "" || value === INHERIT_MODEL) { return [...cur]; }
  if (checked) {
    
    return cur.includes(value) ? [...cur] : [...cur, value];
  }
  return cur.filter((v) => v !== value);
}
