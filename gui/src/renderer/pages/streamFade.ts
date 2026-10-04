




































export const STREAM_FADE_TAIL_MAX = 48;








export interface StreamFadeUnit { text: string; at: number }

export interface StreamFadeSplit {
  







  settled: string;
  
  linePrefix: string;
  
  tail: string;
  
  units: StreamFadeUnit[];
}


function inUnclosedFence(s: string): boolean {
  return ((s.match(/```/g) ?? []).length % 2) === 1;
}


function inUnclosedInlineCode(line: string): boolean {
  return ((line.match(/`/g) ?? []).length % 2) === 1;
}






export function unitize(tail: string, base = 0): StreamFadeUnit[] {
  


  const re = /[A-Za-z0-9_.,;:!?'"()[\]{}<>/\\+\-*=@#$%^&|~`]+|\s+|[\s\S]/g;
  const out: StreamFadeUnit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    if (m[0] === "") { break; } 
    out.push({ text: m[0], at: base + m.index });
  }
  return out;
}

































export function splitStreamFade(shown: string, maxTail = STREAM_FADE_TAIL_MAX): StreamFadeSplit {
  const noFade: StreamFadeSplit = { settled: shown, linePrefix: "", tail: "", units: [] };
  if (!shown) { return { settled: "", linePrefix: "", tail: "", units: [] }; }
  if (inUnclosedFence(shown)) { return noFade; }
  const nl = shown.lastIndexOf("\n");
  const line = shown.slice(nl + 1);
  if (inUnclosedInlineCode(line)) { return noFade; }
  if (!line) { return noFade; }
  const lineUnits = unitize(line, nl + 1);
  
  let start = lineUnits.length;
  let acc = 0;
  for (let i = lineUnits.length - 1; i >= 0; i -= 1) {
    const len = lineUnits[i].text.length;
    if (acc + len > maxTail && start < lineUnits.length) { break; }
    acc += len;
    start = i;
    if (acc >= maxTail) { break; }
  }
  const units = lineUnits.slice(start);
  const tailStart = units.length > 0 ? units[0].at : shown.length;
  const tail = shown.slice(tailStart);
  if (!tail) { return noFade; }
  


  const lineStart = nl + 1;
  return {
    settled: shown.slice(0, lineStart),
    linePrefix: shown.slice(lineStart, tailStart),
    tail,
    units,
  };
}





const PURE_MARKER = /^[-+*>#`~_]+$/;

const ORDERED_MARKER = /^\d{1,2}\.$/;


const TABLE_SEP_MARKER = /^[|\-:\s]+$/;

























export function fadeUnitText(raw: string): string {
  if (!raw) { return raw; }
  if (/^\s+$/.test(raw)) { return raw; }
  if (PURE_MARKER.test(raw)) { return ""; }
  if (ORDERED_MARKER.test(raw)) { return ""; }
  
  if (TABLE_SEP_MARKER.test(raw) && /-/.test(raw)) { return ""; }
  
  return raw
    .replace(/\*\*|~~/g, "")
    .replace(/[*#|`]/g, "")
    .replace(/^[ \t]+(?=\S)/, "");
}











export function visibleTailText(units: readonly StreamFadeUnit[]): string {
  return units
    .map((u) => fadeUnitText(u.text))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "");
}


















export function visibleTailUnits(units: readonly StreamFadeUnit[]): StreamFadeUnit[] {
  const perUnit = units.map((u) => fadeUnitText(u.text));
  const joined = perUnit.join("");
  
  const visible = joined.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  


  const out: StreamFadeUnit[] = [];
  let vi = 0;
  for (let i = 0; i < perUnit.length; i++) {
    const t = perUnit[i];
    if (!t) { out.push({ text: "", at: units[i].at }); continue; }
    
    if (/^\s+$/.test(t)) {
      if (visible[vi] === " ") { out.push({ text: " ", at: units[i].at }); vi += 1; }
      else { out.push({ text: "", at: units[i].at }); }
      continue;
    }
    if (visible.startsWith(t, vi)) {
      out.push({ text: t, at: units[i].at });
      vi += t.length;
    } else {
      
      const chunk = visible.slice(vi, vi + t.length);
      out.push({ text: chunk, at: units[i].at });
      vi += chunk.length;
    }
  }
  return out;
}

