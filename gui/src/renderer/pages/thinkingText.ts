













export function stripMarkdown(text: string): string {
  return text
    .replace(/`{1,4}/g, "")
    .replace(/[#*_>|~]{1,3}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}





export function normalizeThinkingText(text: string): string {
  
  return text
    .split(/\n\s*\n/)
    .map(seg => seg.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(seg => seg.length > 0)
    .join("\n\n");
}
























export function sanitizeThinking(text: string): string {
  const stripped = (text ?? "")
    .replace(/<\/?(?:parameter|function|tool_call|result|safety|safety_check|ban_message|reasoning|system)\b[^>]*>/gi, "");
  return normalizeThinkingText(stripped)
    
    .replace(/\s+([，。；：！？、）》】）])/g, "$1")
    .replace(/([（《【])\s+/g, "$1")
    
    
    
    
    
    
    
    
    .replace(/(?<!['\u2018\u2019])\b([b-hj-zB-HJ-Z])\s+([a-z]{2,})\b/g, "$1$2");
}


export const THINK_STEP_MAX = 24;






























export const TOOL_TRACE_HEADING = "### 工具调用记录";

export interface ToolTraceSplit {
  
  text: string;
  
  traces: string[];
}





export function splitToolTrace(text: string): ToolTraceSplit {
  const src = text ?? "";
  if (!src.includes(TOOL_TRACE_HEADING)) { return { text: src, traces: [] }; }
  const kept: string[] = [];
  const traces: string[] = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    if (line.trim() === TOOL_TRACE_HEADING) { inBlock = true; continue; }
    if (inBlock) {
      const m = /^\s*[-*]\s+(.*)$/.exec(line);
      if (m) {
        const entry = m[1].replace(/^⟳\s*/, "").trim();
        if (entry) { traces.push(entry); }
        continue;
      }
      if (line.trim() === "") { continue; }  
      
      
      inBlock = false;
      kept.push(line);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), traces };
}


export interface TracedToolStep {
  name?: string;
  label: string;
  






  result?: string;
  
  diffTrimmed?: boolean;
}


export const TRACE_DIFF_TRIMMED_MARKER = "[__slime_diff_trimmed__]";




const TRACE_MARKER_RE = /\[__slime_diff__\][A-Za-z0-9+/=]*\|[A-Za-z0-9+/=]*\[\/__slime_diff__\]|\[__slime_diff_trimmed__\]/;







export function splitTraceDiff(raw: string): { text: string; result?: string; diffTrimmed?: boolean } {
  const src = raw ?? "";
  const m = TRACE_MARKER_RE.exec(src);
  if (!m) { return { text: src.trim() }; }
  const text = src.replace(m[0], "").replace(/\s+/g, " ").trim();
  if (m[0] === TRACE_DIFF_TRIMMED_MARKER) { return { text, diffTrimmed: true }; }
  return { text, result: m[0] };
}








export function composeToolTrace(entries: string[]): string {
  const rows = (entries ?? []).map((e) => (e ?? "").trim()).filter((e) => e.length > 0);
  if (rows.length === 0) { return ""; }
  return `${TOOL_TRACE_HEADING}\n${rows.map((e) => `- ${e}`).join("\n")}`;
}



export interface ToolLabelTable {
  [name: string]: { label: string };
}















export function resolveToolEntry(
  entry: string,
  labels: ToolLabelTable,
): { name: string; label: string } | null {
  const t = (entry ?? "").trim();
  if (!t) { return null; }
  const table = labels ?? {};
  for (const [name, v] of Object.entries(table)) {
    if (v.label === t) { return { name, label: v.label }; }
  }
  
  
  const byKey = Object.prototype.hasOwnProperty.call(table, t) ? table[t] : undefined;
  if (byKey) { return { name: t, label: byKey.label }; }
  return null;
}









export function traceEntriesToToolSteps(
  entries: string[],
  lookup: (entry: string) => { name: string; label: string } | null,
  existing: Array<{ name?: string; label?: string }> = [],
): TracedToolStep[] {
  
  const pool = existing.map((t) => (t.label ?? t.name ?? "").replace(/^⟳\s*/, "").trim()).filter((s) => s.length > 0);
  const out: TracedToolStep[] = [];
  for (const raw of entries) {
    
    const { text: entry, result, diffTrimmed } = splitTraceDiff(raw ?? "");
    if (!entry) { continue; }
    const hit = pool.indexOf(entry);
    if (hit >= 0) { pool.splice(hit, 1); continue; }
    const mapped = lookup(entry);
    const base = mapped ? { name: mapped.name, label: mapped.label } : { label: entry };
    out.push(result || diffTrimmed ? { ...base, result, diffTrimmed } : base);
  }
  return out;
}























export function toolStatusLabel(result: unknown, isFail: boolean, running?: boolean): string {
  if (running === true) { return "执行中"; }
  if (typeof result !== "string") { return ""; }
  return isFail ? "失败" : "成功";
}


export type ToolStatusPhase =
  
  | "none"
  
  | "running"
  
  | "settled";












export function toolStatusPhase(result: unknown, running?: boolean): ToolStatusPhase {
  if (running === true) { return "running"; }
  if (typeof result !== "string") { return "none"; }
  return "settled";
}













export function stripToolTraceMark(label: string | undefined): string {
  return (label ?? "").replace(/^⟳\s*/, "");
}





















export function splitThinkingIntoSteps(text: string, maxSteps = THINK_STEP_MAX): string[] {
  const normalized = normalizeThinkingText(text ?? "");
  if (!normalized) { return []; }
  
  const segs = normalized.split("\n\n").filter(seg => seg.length > 0);
  
  if (maxSteps <= 1) { return [normalized]; }
  if (segs.length <= maxSteps) { return segs; }
  
  
  const total = segs.reduce((n, seg) => n + seg.length, 0);
  const groups: string[] = [];
  let buf: string[] = [];
  let taken = 0;
  let made = 0;
  for (const seg of segs) {
    buf.push(seg);
    taken += seg.length;
    if (made + 1 < maxSteps && taken >= (total * (made + 1)) / maxSteps) {
      groups.push(buf.join("\n\n"));
      buf = [];
      made += 1;
    }
  }
  if (buf.length > 0) { groups.push(buf.join("\n\n")); }
  return groups;
}
