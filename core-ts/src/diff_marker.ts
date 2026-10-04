

















































export const DIFF_MARKER_RE = /\[__slime_diff__\]([A-Za-z0-9+/=]*)\|([A-Za-z0-9+/=]*)\[\/__slime_diff__\]/;


export const DIFF_TRIMMED_MARKER = "[__slime_diff_trimmed__]";


export interface DiffStat { add: number; del: number }












export function diffStatOf(oldText: string, newText: string): DiffStat {
  const oldLines = new Set(oldText.split("\n"));
  const newLines = new Set(newText.split("\n"));
  let add = 0;
  let del = 0;
  for (const l of newLines) { if (l && !oldLines.has(l)) { add += 1; } }
  for (const l of oldLines) { if (l && !newLines.has(l)) { del += 1; } }
  return { add, del };
}









export function hasVisibleDiff(stat: DiffStat | null | undefined): boolean {
  return !!stat && (stat.add > 0 || stat.del > 0);
}


export function b64ToTextCore(b64: string): string {
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch { return ""; }
}






export function buildDiffMarker(oldText: string, newText: string): string {
  if (oldText === newText) { return ""; }
  const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");
  return `\n[__slime_diff__]${b64(oldText)}|${b64(newText)}[/__slime_diff__]`;
}







export function parseDiffStatCore(result: string | undefined): DiffStat | null {
  if (!result) { return null; }
  const m = DIFF_MARKER_RE.exec(result);
  if (!m) { return null; }
  const oldTxt = b64ToTextCore(m[1]);
  const newTxt = b64ToTextCore(m[2]);
  if (!oldTxt && !newTxt) { return null; }
  const stat = diffStatOf(oldTxt, newTxt);
  return hasVisibleDiff(stat) ? stat : null;
}
