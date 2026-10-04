




















export interface AnsiSpan {
  text: string;
  
  fg?: string;
  
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}





export const ANSI_16: readonly string[] = [
  "#3b4048", 
  "#e5534b", 
  "#57ab5a", 
  "#c69026", 
  "#539bf5", 
  "#b083f0", 
  "#39c5cf", 
  "#b3bac5", 
  "#545d68", 
  "#ff7b72", 
  "#7ee787", 
  "#e3b341", 
  "#79c0ff", 
  "#d2a8ff", 
  "#56d4dd", 
  "#e6edf3", 
];


export function color256(n: number): string {
  const i = Math.max(0, Math.min(255, Math.floor(n)));
  if (i < 16) { return ANSI_16[i]!; }
  if (i < 232) {
    const c = i - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const v = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const v = 8 + (i - 232) * 10;
  return `rgb(${v},${v},${v})`;
}


const ESC_RE = /\u001b\[([0-9;?]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;


export function stripAnsi(s: string): string {
  return String(s ?? "").replace(ESC_RE, "");
}


function applySgr(style: AnsiSpan, params: number[]): void {
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]!;
    if (p === 0) {
      delete style.fg; delete style.bg;
      delete style.bold; delete style.dim; delete style.italic; delete style.underline;
    } else if (p === 1) { style.bold = true; delete style.dim; }
    else if (p === 2) { style.dim = true; delete style.bold; }
    else if (p === 3) { style.italic = true; }
    else if (p === 4) { style.underline = true; }
    else if (p === 22) { delete style.bold; delete style.dim; }
    else if (p === 23) { delete style.italic; }
    else if (p === 24) { delete style.underline; }
    else if (p >= 30 && p <= 37) { style.fg = ANSI_16[p - 30]; }
    else if (p === 39) { delete style.fg; }
    else if (p >= 40 && p <= 47) { style.bg = ANSI_16[p - 40]; }
    else if (p === 49) { delete style.bg; }
    else if (p >= 90 && p <= 97) { style.fg = ANSI_16[p - 90 + 8]; }
    else if (p >= 100 && p <= 107) { style.bg = ANSI_16[p - 100 + 8]; }
    else if (p === 38 || p === 48) {
      

      const isFg = p === 38;
      const mode = params[i + 1];
      if (mode === 5) {
        const c = color256(params[i + 2] ?? 0);
        if (isFg) { style.fg = c; } else { style.bg = c; }
        i += 2;
      } else if (mode === 2) {
        const r = params[i + 2] ?? 0; const g = params[i + 3] ?? 0; const b = params[i + 4] ?? 0;
        const c = `rgb(${r},${g},${b})`;
        if (isFg) { style.fg = c; } else { style.bg = c; }
        i += 4;
      }
    }
  }
}








export function parseAnsi(line: string): AnsiSpan[] {
  const s = String(line ?? "");
  const out: AnsiSpan[] = [];
  const style: AnsiSpan = { text: "" };
  let plain = "";

  ESC_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  

  const flush = (): void => {
    if (plain.length === 0) { return; }
    const span: AnsiSpan = { text: plain };
    if (style.fg !== undefined) { span.fg = style.fg; }
    if (style.bg !== undefined) { span.bg = style.bg; }
    if (style.bold) { span.bold = true; }
    if (style.dim) { span.dim = true; }
    if (style.italic) { span.italic = true; }
    if (style.underline) { span.underline = true; }
    out.push(span);
    plain = "";
  };
  while ((m = ESC_RE.exec(s)) !== null) {
    plain += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[3] === "m") {
      flush(); 
      const params = (m[1] ?? "").split(";").map((x) => (x === "" ? 0 : Number(x)));
      applySgr(style, params.filter((n) => Number.isFinite(n)));
    }
    
  }
  plain += s.slice(last);
  flush();
  

  return out;
}


export function hasAnsi(s: string): boolean {
  ESC_RE.lastIndex = 0;
  return ESC_RE.test(String(s ?? ""));
}
