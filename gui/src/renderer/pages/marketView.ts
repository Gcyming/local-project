























import { expandMarketQuery } from "../../../../core-ts/src/services/marketLocalize.js";

export type MarketSource = "registry" | "builtin";














export function onlineSourceActive(requested: boolean, onlineCount: number): boolean {
  return requested && onlineCount > 0;
}







export function marketSource(registryQuery: string, registryCount: number): MarketSource {
  return onlineSourceActive(registryQuery.trim() !== "", registryCount) ? "registry" : "builtin";
}





















export function marketNeedles(input: string): string[] {
  const e = expandMarketQuery(input);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [e.raw, ...e.terms]) {
    const k = (t ?? "").toLowerCase();
    if (k === "" || seen.has(k)) { continue; }
    seen.add(k);
    out.push(k);
  }
  return out;
}








export function filterMarketItems<T extends { name: string; description: string; tags?: string[] }>(
  list: readonly T[],
  needles: readonly string[],
): T[] {
  const ns = (needles ?? []).map((n) => (n ?? "").trim().toLowerCase()).filter((n) => n !== "");
  if (ns.length === 0) { return [...list]; }
  return list.filter((it) => {
    const hay = `${it.name} ${it.description} ${(it.tags ?? []).join(" ")}`.toLowerCase();
    return ns.some((n) => hay.includes(n));
  });
}
