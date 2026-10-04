



























export const BLANK_RUN_KEEP = 2;











export function collapseBlankRuns(text: string, keep: number = BLANK_RUN_KEEP): string {
  if (!text) { return text; }
  const n = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : BLANK_RUN_KEEP;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]+$/gm, "")
    .replace(new RegExp(`\\n{${n + 1},}`, "g"), "\n".repeat(n))
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}
