
































export const SUBAGENT_PANEL_LIMIT = 5;








export function latestSubagentRuns<T>(runs: readonly T[], limit: number = SUBAGENT_PANEL_LIMIT): T[] {
  if (!Array.isArray(runs) || runs.length === 0) { return []; }
  if (!Number.isFinite(limit) || limit <= 0) { return []; }
  const n = Math.min(Math.floor(limit), runs.length);
  return runs.slice(runs.length - n).reverse();
}








export function subagentPanelCountLabel(total: number, shown: number): string {
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const s = Number.isFinite(shown) && shown > 0 ? Math.floor(shown) : 0;
  return s < t ? `子代理 (${s} / ${t})` : `子代理 (${t})`;
}
