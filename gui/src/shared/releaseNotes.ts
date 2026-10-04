
















export interface ReleaseNoteRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  
  href?: string;
}

export interface ReleaseNoteBlock {
  kind: "heading" | "paragraph" | "list" | "table" | "hr" | "code";
  
  level?: number;
  
  runs?: ReleaseNoteRun[];
  
  items?: ReleaseNoteRun[][];
  
  ordered?: boolean;
  
  header?: ReleaseNoteRun[][];
  
  rows?: ReleaseNoteRun[][][];
  
  text?: string;
}








const TABLE_SLOT = "\u0001";

const HARD_BREAK = "\u0000";


const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", times: "×", middot: "·",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      
      if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) { return whole; }
      try { return String.fromCodePoint(n); } catch { return whole; }
    }
    const v = ENTITIES[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}


function stripDangerous(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(iframe|object|embed|form|input|button|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(iframe|object|embed|form|input|button|link|meta|base)\b[^>]*>/gi, "");
}


function inlineHtmlToMarkdown(s: string): string {
  return s
    .replace(/<\s*(strong|b)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "**$2**")
    .replace(/<\s*(em|i)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "*$2*")
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, "`$1`")
    
    
    
    .replace(/<\s*a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
      (_all, href: string, text: string) => (safeHref(href) ? `[${text}](${href})` : text))
    
    .replace(/<[^>]*>/g, "");
}





function htmlToLines(html: string): { lines: string[]; tables: ParsedTable[] } {
  const tables: ParsedTable[] = [];
  const withoutTables = stripDangerous(html).replace(/<table\b[\s\S]*?<\/table\s*>/gi, (t) => {
    tables.push(parseHtmlTable(t));
    return `\n${TABLE_SLOT}${tables.length - 1}${TABLE_SLOT}\n`;
  });

  const withBreaks = withoutTables
    
    
    
    .replace(/<\s*ol\b[^>]*>[\s\S]*?<\s*\/\s*ol\s*>/gi, (block: string) => {
      let n = 0;
      return block.replace(/<\s*li\b[^>]*>/gi, () => `\n${(n += 1)}. `);
    })
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    
    
    .replace(/<\s*h([1-6])\b[^>]*>([\s\S]*?)<\s*\/\s*h\1\s*>/gi,
      (_all, lvl: string, body: string) => `\n${"#".repeat(Number(lvl))} ${body.trim()}\n`)
    .replace(/<\s*br\s*\/?\s*>/gi, HARD_BREAK)
    
    
    .replace(/<\s*hr\b[^>]*\/?\s*>/gi, "\n---\n")
    .replace(/<\s*\/(h[1-6]|p|div|li|tr|section|article|blockquote|pre)\s*>/gi, "\n")
    .replace(/<\s*(h[1-6]|p|div|li|tr|section|article|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n")
    .replace(/<\s*\/\s*(ul|ol|table|thead|tbody)\s*>/gi, "\n");

  const lines = withBreaks
    .split("\n")
    .map((l) => inlineHtmlToMarkdown(l).trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""));
  return { lines, tables };
}

interface ParsedTable { header: ReleaseNoteRun[][]; rows: ReleaseNoteRun[][][] }

function cellsFromHtml(rowHtml: string): ReleaseNoteRun[][] {
  const cells: ReleaseNoteRun[][] = [];
  const re = /<\s*(td|th)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) {
    cells.push(parseInline(decodeEntities(inlineHtmlToMarkdown(m[2]).trim())));
  }
  return cells;
}

function parseHtmlTable(tableHtml: string): ParsedTable {
  const rows: ReleaseNoteRun[][][] = [];
  const rowRe = /<\s*tr\b[^>]*>([\s\S]*?)<\s*\/\s*tr\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const cells = cellsFromHtml(m[1]);
    if (cells.length > 0) { rows.push(cells); }
  }
  const headerInThead = /<\s*thead\b[\s\S]*?<\s*tr\b[\s\S]*?<\/\s*tr\s*>/i.test(tableHtml);
  const header = headerInThead && rows.length > 0 ? rows.shift()! : [];
  return { header, rows };
}


export function parseInline(src: string): ReleaseNoteRun[] {
  const out: ReleaseNoteRun[] = [];
  parseInlineInto(src, {}, out, 0);
  return out;
}






const INLINE_RE = /(\*\*)([\s\S]+?)\1|`([^`]+?)`|\*([^*\n]+?)\*|\[([^\]\n]*?)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g;
const MAX_INLINE_DEPTH = 8;

function parseInlineInto(
  src: string,
  base: Omit<ReleaseNoteRun, "text">,
  out: ReleaseNoteRun[],
  depth: number,
): void {
  const push = (text: string, extra: Omit<ReleaseNoteRun, "text"> = {}): void => {
    const style = { ...base, ...extra };
    const decoded = decodeEntities(text);
    if (decoded === "") { return; }
    const last = out[out.length - 1];
    
    if (last && last.bold === style.bold && last.italic === style.italic
      && last.code === style.code && last.href === style.href) {
      last.text += decoded;
      return;
    }
    out.push({ text: decoded, ...style });
  };

  if (depth > MAX_INLINE_DEPTH) { push(src); return; }

  const RE = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(src)) !== null) {
    if (m.index > last) { push(src.slice(last, m.index)); }
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      
      parseInlineInto(m[2], { ...base, bold: true }, out, depth + 1);
    } else if (m[3] !== undefined) {
      
      push(m[3], { code: true });
    } else if (m[4] !== undefined) {
      parseInlineInto(m[4], { ...base, italic: true }, out, depth + 1);
    } else if (m[5] !== undefined) {
      const href = safeHref(m[6] ?? "");
      const before = out.length;
      parseInlineInto(m[5], base, out, depth + 1);
      if (href) {
        
        for (let i = before; i < out.length; i += 1) { out[i].href = href; }
      }
    }
  }
  if (last < src.length) { push(src.slice(last)); }
}


export function safeHref(url: string): string {
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : "";
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);
}

function splitMarkdownRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function isListLine(line: string, ordered: boolean): RegExpMatchArray | null {
  return ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(line) : /^\s*[-*+]\s+(.*)$/.exec(line);
}









export function normalizeReleaseNotes(raw: unknown): string {
  if (typeof raw === "string") { return raw; }
  if (Array.isArray(raw)) {
    return raw
      .map((it) => {
        if (typeof it === "string") { return it; }
        if (it && typeof it === "object" && typeof (it as { note?: unknown }).note === "string") {
          return (it as { note: string }).note;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}





export function parseReleaseNotes(raw: unknown): ReleaseNoteBlock[] {
  const src = normalizeReleaseNotes(raw);
  if (!src) { return []; }
  try {
    return parseBlocks(src);
  } catch {
    return plainTextBlocks(src);
  }
}


function plainTextBlocks(src: string): ReleaseNoteBlock[] {
  const text = decodeEntities(src.replace(/<[^>]*>/g, " ")).replace(/[ \t]+/g, " ");
  return text.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ kind: "paragraph" as const, runs: [{ text: l }] }));
}

function parseBlocks(src: string): ReleaseNoteBlock[] {
  const hasHtml = /<\s*[a-zA-Z][\w-]*(\s[^>]*)?\/?>/i.test(src);
  const { lines, tables } = hasHtml
    ? htmlToLines(src)
    : { lines: src.replace(/\r\n?/g, "\n").split("\n"), tables: [] as ParsedTable[] };

  const blocks: ReleaseNoteBlock[] = [];
  let i = 0;
  let fence = false;
  let codeBuf: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    
    if (/^\s*```/.test(line)) {
      if (fence) {
        blocks.push({ kind: "code", text: codeBuf.join("\n") });
        codeBuf = [];
        fence = false;
      } else {
        fence = true;
      }
      i += 1;
      continue;
    }
    if (fence) { codeBuf.push(line); i += 1; continue; }

    if (line === "") { i += 1; continue; }

    
    const slot = new RegExp(`^${TABLE_SLOT}(\\d+)${TABLE_SLOT}$`).exec(line);
    if (slot) {
      const t = tables[Number(slot[1])];
      if (t && (t.header.length > 0 || t.rows.length > 0)) {
        blocks.push({ kind: "table", header: t.header, rows: t.rows });
      }
      i += 1;
      continue;
    }

    
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitMarkdownRow(line).map((c) => parseInline(c));
      const rows: ReleaseNoteRun[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(splitMarkdownRow(lines[i]).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, runs: parseInline(h[2].trim()) });
      i += 1;
      continue;
    }

    
    const orderedFirst = isListLine(line, true);
    const bulletFirst = orderedFirst ? null : isListLine(line, false);
    if (orderedFirst || bulletFirst) {
      const ordered = orderedFirst !== null;
      const items: ReleaseNoteRun[][] = [];
      while (i < lines.length) {
        const m = isListLine(lines[i], ordered);
        if (!m) { break; }
        items.push(parseInline(m[1].trim()));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    
    const parts = line.split(HARD_BREAK).map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      blocks.push({ kind: "paragraph", runs: parseInline(p) });
    }
    i += 1;
  }
  if (fence && codeBuf.length > 0) { blocks.push({ kind: "code", text: codeBuf.join("\n") }); }
  return blocks;
}
