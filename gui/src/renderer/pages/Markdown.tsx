



import React, { type JSX } from "react";

import type { SidebarOpenRequest } from "../../shared/ipc.js";


export const SIDEBAR_OPEN_EVENT = "slime:open-in-sidebar";














export type SidebarOpenPayload =
  | SidebarOpenRequest
  


  | { kind: "file"; rel?: string; name?: string; from?: "site" | "user"; sessionId?: string }
  



  | { kind: "doc"; rel: string; name?: string; from?: "site" | "user"; sessionId?: string };
export function requestSidebarOpen(payload: SidebarOpenPayload): void {
  window.dispatchEvent(new CustomEvent<SidebarOpenPayload>(SIDEBAR_OPEN_EVENT, { detail: payload }));
}


function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  const inline = /(`+)([^`]+?)\1/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  inline.lastIndex = 0;
  while ((m = inline.exec(text)) !== null) {
    if (m.index > last) nodes.push(<React.Fragment key={`${keyPrefix}t${k++}`}>{renderBoldItalic(text.slice(last, m.index), `${keyPrefix}${k}`)}</React.Fragment>);
    nodes.push(<code key={`${keyPrefix}c${k++}`} style={codeStyle}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(<React.Fragment key={`${keyPrefix}t${k++}`}>{renderBoldItalic(text.slice(last), `${keyPrefix}${k}`)}</React.Fragment>);
  return nodes;
}


function renderBoldItalic(text: string, key: string): JSX.Element[] {
  
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  const out: JSX.Element[] = [];
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  linkRe.lastIndex = 0;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`${key}l${k}`}>{renderEm(text.slice(last, m.index), `${key}${k++}`)}</React.Fragment>);
    const href = m[2].startsWith("http") ? m[2] : "#";
    out.push(
      <a
        key={`${key}l${k++}`}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          
          if (/^https?:\/\//i.test(href)) {
            e.preventDefault();
            requestSidebarOpen({ kind: "url", url: href, name: m?.[1] ?? href });
          }
        }}
        style={{ color: "var(--accent-hover)", textDecoration: "underline" }}
      >
        {m[1]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${key}l${k}`}>{renderEm(text.slice(last), `${key}${k}`)}</React.Fragment>);
  return out;
}

function renderEm(text: string, key: string): JSX.Element[] {
  
  const parts: React.ReactNode[] = [];
  const strike = /~~([^~]+)~~/g;
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  strike.lastIndex = 0;
  while ((m = strike.exec(text)) !== null) {
    if (m.index > last) parts.push(<React.Fragment key={`${key}s${k}`}>{renderBold(text.slice(last, m.index), `${key}${k}`)}</React.Fragment>);
    parts.push(<del key={`${key}s${k++}`} style={{ color: "var(--text-dim)" }}>{m[1]}</del>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<React.Fragment key={`${key}s${k}`}>{renderBold(text.slice(last), `${key}${k}`)}</React.Fragment>);
  return parts.map((p, i) => <React.Fragment key={`${key}w${i}`}>{p}</React.Fragment>);
}

function renderBold(text: string, key: string): JSX.Element[] {
  const bold = /\*\*([^*]+)\*\*/g;
  const out: JSX.Element[] = [];
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  bold.lastIndex = 0;
  while ((m = bold.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`${key}b${k}`}>{renderItalic(text.slice(last, m.index), `${key}${k}`)}</React.Fragment>);
    out.push(<strong key={`${key}b${k++}`}>{renderItalic(m[1], `${key}${k}`)}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${key}b${k}`}>{renderItalic(text.slice(last), `${key}${k}`)}</React.Fragment>);
  return out;
}

function renderItalic(text: string, key: string): JSX.Element {
  const italic = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  const out: React.ReactNode[] = [];
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  italic.lastIndex = 0;
  while ((m = italic.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`${key}t${k}`}>{autoLink(text.slice(last, m.index), `${key}${k++}`)}</React.Fragment>);
    out.push(<em key={`${key}i${k++}`}>{autoLink(m[1], `${key}${k}`)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${key}t${k}`}>{autoLink(text.slice(last), `${key}${k}`)}</React.Fragment>);
  return <>{out}</>;
}



const BARE_URL_RE = /https?:\/\/[^\s<>()[\]"'，。；：、）】]+/g;
function autoLink(text: string, key: string): React.ReactNode {
  if (!/https?:\/\//i.test(text)) { return text; }
  const parts: React.ReactNode[] = [];
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  BARE_URL_RE.lastIndex = 0;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    if (m.index > last) { parts.push(text.slice(last, m.index)); }
    const url = m[0];
    parts.push(
      <a
        key={`${key}u${k++}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => { e.preventDefault(); requestSidebarOpen({ kind: "url", url, name: url }); }}
        style={{ color: "var(--accent-hover)", textDecoration: "underline" }}
      >
        {url}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) { parts.push(text.slice(last)); }
  return <>{parts}</>;
}


























function repairStreamingTablePre(text: string): string {
  if (!text.includes("|")) return text;
  let body = text;
  let trail = "";
  const m = /(\n+)$/.exec(body);
  if (m) { trail = m[1]; body = body.slice(0, body.length - trail.length); }
  const nl = body.lastIndexOf("\n");
  const t = body.slice(nl + 1).trim();
  
  if (!/^\|[\s:|-]*$/.test(t) || !/-/.test(t)) { return text; }
  const dashes = t.split("|").filter((s) => /^[:\-\s]+$/.test(s) && s.includes("-"));
  const cols = Math.max(1, dashes.length);
  const sep = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
  const head = nl >= 0 ? body.slice(0, nl + 1) : "";
  return head + sep + trail;
}







function repairStreamingTableAfter(text: string): string {
  if (!text.includes("|")) return text;
  let body = text;
  let trail = "";
  const m = /(\n+)$/.exec(body);
  if (m) { trail = m[1]; body = body.slice(0, body.length - trail.length); }
  const nl = body.lastIndexOf("\n");
  const last = body.slice(nl + 1);
  const prevText = nl >= 0 ? body.slice(0, nl) : "";
  const prevLines = prevText.length ? prevText.split("\n") : [];
  const prevLine = prevLines.length ? prevLines[prevLines.length - 1] : undefined;
  const t = last.trim();
  if (!t) return text;
  
  if (/^\|?[\s:|-]+\|?$/.test(t) && /-/.test(t) && /^\|.*\|$/.test(t)) { return text; }
  const pipes = (t.match(/\|/g) ?? []).length;
  if (pipes < 2) { return text; }
  
  if (prevLine && looksLikeTableSep(prevLine)) { return text; }
  const k = t.indexOf("|");
  const head = k >= 0 ? t.slice(k) : t;
  const cols = Math.max(1, head.split("|").filter((s) => s.trim() !== "").length);
  const sep = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
  return body + "\n" + sep + trail;
}






function repairStreamingMarkdown(src: string): string {
  if (!src) return src;
  let text = src;
  const fenceRe = /^```\s*([\w-]*)\s*$/;

  
  const fenceCount = text.split("\n").filter((l) => fenceRe.test(l.trim())).length;
  if (fenceCount % 2 === 1) {
    text += "\n```";
  }

  
  let inlineTick = 0;
  let bold = 0;
  let italic = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (fenceRe.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    let inCode = false;
    for (let i = 0; i < line.length; i++) {
      if (line.startsWith("```", i)) { i += 2; continue; }
      if (line[i] === "`") { inCode = !inCode; inlineTick++; continue; }
      if (inCode) continue;
      if (line[i] !== "*") continue;
      if (line[i + 1] === "*") {
        bold++;
        i++;
      } else {
        
        const isListMarker = i === 0 && /\s/.test(line[i + 1] ?? "");
        if (!isListMarker) italic++;
      }
    }
  }
  if (inlineTick % 2 === 1) text += "`";
  if (bold % 2 === 1) text += "**";
  if (italic % 2 === 1) text += "*";

  
  text = repairStreamingTablePre(text);

  return text;
}









type Block =
  | { t: "code"; lang: string; text: string }
  | { t: "heading"; level: number; text: string }
  | { t: "hr" }
  | { t: "quote"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "table"; rows: string[][] }
  | { t: "p"; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const n = lines.length;
  
  const para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) { return; }
    const first = para[0].trim();
    const quote = first.startsWith(">");
    if (quote) {
      
      blocks.push({ t: "quote", text: para.map((l) => l.replace(/^>\s?/, "")).join("\n") });
      para.length = 0;
      return;
    }
    
    if (/^[-*+]\s+/.test(first) || /^\d+[.)]\s+/.test(first)) {
      const ordered = /^\d+[.)]\s+/.test(first);
      if (para.every((l) => /^[-*+]\s+/.test(l.trim()) || /^\d+[.)]\s+/.test(l.trim()))) {
        const items = para.map((l) => l.trim().replace(/^[-*+]\s+|\d+[.)]\s+/, ""));
        blocks.push({ t: ordered ? "ol" : "ul", items });
        para.length = 0;
        return;
      }
    }
    blocks.push({ t: "p", text: para.join("\n") });
    para.length = 0;
  };
  for (; i < n; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") { flushPara(); continue; }
    
    const fence = /^```\s*([\w-]*)\s*$/.exec(t);
    if (fence) {
      flushPara();
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < n && !/^```\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      blocks.push({ t: "code", lang, text: buf.join("\n") });
      continue;
    }
    
    if (t.startsWith("|") && i + 1 < n && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && /[-]/.test(lines[i + 1])) {
      flushPara();
      const header = splitRow(t);
      const sep = splitRow(lines[i + 1]);
      const rows: string[][] = [header];
      i += 2;
      while (i < n && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      
      
      const colCount = Math.max(sep.length, ...rows.map((r) => r.length));
      const norm = rows.map((r) => {
        const row = r.slice(0, colCount);
        while (row.length < colCount) { row.push(""); }
        return row;
      });
      blocks.push({ t: "table", rows: norm });
      continue;
    }
    
    const h = /^(#{1,6})\s+(.+)$/.exec(t);
    if (h) { flushPara(); blocks.push({ t: "heading", level: h[1].length, text: h[2] }); continue; }
    
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); blocks.push({ t: "hr" }); continue; }
    
    if (/^[#>*_\-]{1,6}$/.test(t)) continue;
    para.push(line);
  }
  flushPara();
  return blocks;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}















export function preserveBreaks(text: string): boolean {
  if (!text) { return false; }
  const lines = text.split("\n");
  
  if (lines.length >= 3) {
    const frags = lines.filter((l) => l.length <= 4).length;
    if (frags / lines.length >= 0.5) {
      return false;
    }
  }
  if (/[\t]/.test(text)) { return true; }
  if (/\n[ \t]/.test(text)) { return true; }
  if (/ {2,}/.test(text)) { return true; }
  const first = lines[0] ?? "";
  if (/^[ \t]/.test(first)) { return true; }
  return lines.some((l) => l.length >= 48);
}















const STRUCTURAL_LINE_RE = /^[\s#>|*_\-`~:.]+$/; 

const MD_STRUCTURE_LINE_RE = /^(?:#{1,6}\s|[-*+]\s+|\d+[.)]\s+|\||>|```|~~~| {4,}\S)/;




function isMdStructureLine(line: string): boolean {
  return MD_STRUCTURE_LINE_RE.test(line) || MD_STRUCTURE_LINE_RE.test(line.trim());
}


function foldTokenFragBlock(block: string[]): string[] {
  if (block.length < 3) { return block; }
  
  if (block.some(isMdStructureLine)) { return block; }
  const contentLines = block.filter((l) => {
    const t = l.trim();
    if (t.length === 0) { return false; }
    if (STRUCTURAL_LINE_RE.test(l)) { return false; }
    
    
    
    if (/^[-*+]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) { return false; }
    return true;
  });
  if (contentLines.length < 2) { return block; }
  const frags = contentLines.filter((l) => l.length <= 4).length;
  if (frags / contentLines.length < 0.5) { return block; }
  const parts = block.map((l) => l.trim()).filter(Boolean);
  
  const allCjk = parts.every((p) => /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/.test(p));
  return [allCjk ? parts.join("") : parts.join(" ")];
}

export function normalizeBrokenLines(text: string): string {
  if (!text) { return text; }
  const lines = text.split("\n");
  if (lines.length < 3) { return text; }
  
  
  const out: string[] = [];
  let block: string[] = [];
  const flush = (): void => {
    if (block.length > 0) { out.push(...foldTokenFragBlock(block)); block = []; }
  };
  for (const l of lines) {
    if (l.trim() === "") { flush(); out.push(l); } else { block.push(l); }
  }
  flush();
  return out.join("\n");
}






export function normalizeInlineTables(text: string): string {
  if (!text || !text.includes("---")) { return text; }
  return text
    .split("\n")
    .map((line) => {
      if ((line.match(/\|/g) ?? []).length < 6 || !line.includes("---")) { return line; }
      const k = line.search(/\|/);
      const head = k > 0 ? line.slice(0, k).trimEnd() : "";
      const rest = line.slice(k);
      
      const segs = rest.split("|").map((s) => s.trim()).filter((s) => s !== "");
      const sepIdx = segs.findIndex((s) => /^-+$/.test(s));
      if (sepIdx < 0) { return line; }
      const cols = segs.slice(sepIdx).filter((s) => /^-+$/.test(s)).length;
      if (cols < 1) { return line; }
      const headCells = segs.slice(0, sepIdx);
      const dataCells = segs.slice(sepIdx + cols);
      if (headCells.length < 1) { return line; }
      const headerLine = `| ${headCells.join(" | ")} |`;
      const sepLine = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
      const dataRows: string[] = [];
      for (let i = 0; i < dataCells.length; i += cols) {
        const row = dataCells.slice(i, i + cols);
        dataRows.push(`| ${[...row, ...Array(cols - row.length).fill("")].join(" | ")} |`);
      }
      const table = [headerLine, sepLine, ...dataRows].join("\n");
      return head ? `${head}\n${table}` : table;
    })
    .join("\n");
}

















const INLINE_HR_RE_TARGET = /(^|[^\s`\-])(-{3,})(?=\s|#|$)/g;
const INLINE_HEADING_RE_TARGET = /([^A-Za-z0-9_#])(?<!\|[\s]*)(#{1,6})(?!\s*\|)(?=\s+\S)/g;
const CELL_BLOCK_RE = /\|[ \t]*-{3,}[ \t]*#{1,6}\s/;


function looksLikeTableSep(l: string | undefined): boolean {
  if (!l) { return false; }
  const t = l.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && /-/.test(t);
}


function splitFusedTableHead(s: string, nextLine: string | undefined): string {
  if (s.startsWith("|")) { return s; }
  const first = s.indexOf("|");
  if (first < 1) { return s; }
  const rest = s.slice(first);
  if ((rest.match(/\|/g) ?? []).length < 2) { return s; } 
  const hasSepCell = rest.split("|").some((c) => /^-{3,}$/.test(c.trim()));
  if (hasSepCell || looksLikeTableSep(nextLine)) {
    return `${s.slice(0, first)}\n${rest}`;
  }
  return s;
}


function unjamOneLine(line: string, nextLine: string | undefined): string[] {
  if (/^```/.test(line.trim())) { return [line]; }
  
  const cell = CELL_BLOCK_RE.exec(line);
  if (cell && cell.index > 0) {
    const left = line.slice(0, cell.index + 1).replace(/[ \t]+$/, "");
    const right = line.slice(cell.index + 1).replace(/^[ \t]+/, "");
    return [left, ...unjamOneLine(right, nextLine)];
  }
  let s = line;
  
  s = s.replace(INLINE_HR_RE_TARGET, "$1\n$2");
  
  s = splitFusedTableHead(s, nextLine);
  
  s = s.replace(INLINE_HEADING_RE_TARGET, "$1\n$2");
  if (s === line) { return [line]; } 
  return s.split("\n").map((f) => f.trim()).filter(Boolean);
}


function unjamBlockMarkers(lines: string[]): string[] {
  const res: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) { inFence = !inFence; res.push(line); continue; }
    if (inFence) { res.push(line); continue; }
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
    res.push(...unjamOneLine(line, nextLine));
  }
  return res;
}









function listKindOf(line: string): "ol" | "ul" | null {
  if (/^\d+[.)]\s/.test(line)) { return "ol"; }
  if (/^[-*+]\s/.test(line)) { return "ul"; }
  return null;
}

export function normalizeMarkdownBlocks(text: string): string {
  if (!text) { return text; }
  const lines = unjamBlockMarkers(text.split("\n"));
  const out: string[] = [];
  let inFence = false;
  const BLOCK_RE = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|[-_*]{3,}\s*$)/;
  for (const l of lines) {
    if (/^```/.test(l.trim())) { inFence = !inFence; out.push(l); continue; }
    if (!inFence) {
      const prev = out[out.length - 1] ?? "";
      const kind = listKindOf(l);
      const prevKind = listKindOf(prev);
      
      
      
      const sameListKind = kind !== null && kind === prevKind;
      
      
      const listEnds = kind === null && prevKind !== null && l.trim() !== "";
      if (prev !== "" && !sameListKind && (BLOCK_RE.test(l) || listEnds)) { out.push(""); }
    }
    out.push(l);
  }
  return out.join("\n");
}





function CopyCodeButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timerRef.current) { clearTimeout(timerRef.current); } }, []);
  const onCopy = React.useCallback((): void => {
    const done = (): void => {
      setCopied(true);
      if (timerRef.current) { clearTimeout(timerRef.current); }
      timerRef.current = setTimeout(() => setCopied(false), 1400);
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p && typeof p.then === "function") { p.then(done).catch(() => {  }); }
    } catch {  }
  }, [text]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "已复制" : "复制代码"}
      style={{
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: 6,
        color: copied ? "var(--success)" : "var(--text-muted)",
        fontSize: 11, lineHeight: 1, padding: "3px 8px",
        cursor: "pointer", flexShrink: 0,
        transition: "color 0.15s, border-color 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-hover)";
        e.currentTarget.style.color = copied ? "var(--success)" : "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.color = copied ? "var(--success)" : "var(--text-muted)";
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function renderBlock(b: Block, key: string): JSX.Element {
  switch (b.t) {
    case "code":
      return (
        <div key={key} style={codeBlockWrapStyle}>
          <div style={{ ...codeBlockHeaderStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.3 }}>
              {b.lang ? b.lang.toUpperCase() : "CODE"}
            </span>
            <CopyCodeButton text={b.text} />
          </div>
          <pre style={codeBlockStyle}>
            <code>{b.text}</code>
          </pre>
        </div>
      );
    case "heading":
      return <div key={key} style={{ fontWeight: 700, margin: "12px 0 6px", color: "var(--text)" }}>{renderInline(b.text, key)}</div>;
    case "hr":
      return <div key={key} style={{ borderTop: "1px solid var(--border)", margin: "10px 0" }} />;
    case "quote":
      return (
        <blockquote key={key} style={{ margin: "8px 0", padding: "2px 12px", borderLeft: "3px solid var(--accent-soft)", color: "var(--text-muted)", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>
          <div>{renderInline(b.text, key)}</div>
        </blockquote>
      );
    case "ul":
      return (
        <ul key={key} style={{ margin: "6px 0", paddingLeft: 20 }}>
          {b.items.map((it, j) => <li key={`${key}${j}`} style={{ margin: "2px 0" }}>{renderInline(it, `${key}${j}`)}</li>)}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} style={{ margin: "6px 0", paddingLeft: 20 }}>
          {b.items.map((it, j) => <li key={`${key}${j}`} style={{ margin: "2px 0" }}>{renderInline(it, `${key}${j}`)}</li>)}
        </ol>
      );
    case "table":
      return (
        <table key={key} style={{ borderCollapse: "collapse", width: "100%", margin: "8px 0", fontSize: 13 }}>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={`${key}r${r}`}>
                {row.map((cell, c) => (
                  <td key={`${key}c${c}`} style={{
                    border: "1px solid var(--border)", padding: "4px 8px",
                    background: r === 0 ? "var(--accent-soft)" : "var(--bg-input)",
                    fontWeight: r === 0 ? 600 : 400,
                  }}>
                    {renderInline(cell, `${key}r${r}c${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "p":
    default:
      
      
      
      if (preserveBreaks(b.text)) {
        return <div key={key} style={{ margin: "2px 0", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>{renderInline(b.text, key)}</div>;
      }
      return <div key={key} style={{ margin: "2px 0" }}>{renderInline(b.text.replace(/\n/g, " "), key)}</div>;
  }
}

const LARGE_TEXT = 20000;

const LARGE_TEXT_HARD = 120000;





function renderLargeText(text: string): JSX.Element {
  
  const src = tightenCjkSpacing(normalizeInlineTables(normalizeBrokenLines(normalizeMarkdownBlocks(text))));
  if (src.length >= LARGE_TEXT_HARD) {
    return (
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>
        {src.split(/\n{2,}/).map((para, i) => (
          <div key={`lg${i}`} style={{ margin: "2px 0" }}>
            {renderInline(para, `lg${i}`)}
          </div>
        ))}
      </div>
    );
  }
  const blocks = parseBlocks(src);
  return <>{blocks.map((b, i) => renderBlock(b, `lgm${i}`))}</>;
}






export function tightenCjkSpacing(text: string): string {
  return (text ?? "")
    .replace(/[ \t]+([，。；：！？、）》】）])/g, "$1")
    .replace(/([，。；：！？、）》】）])[ \t\u3000]+/g, "$1")
    .replace(/([（《【])[ \t\u3000]+/g, "$1")
    
    .replace(/([\u4e00-\u9fff])[ \t\u3000]+([\u4e00-\u9fff])/g, "$1$2");
}














const longStreamParseCache = { src: "", out: "" };
function throttleLongStreamParse(src: string, streaming: boolean): string {
  if (!streaming || src.length < LARGE_TEXT) {
    longStreamParseCache.src = src;
    longStreamParseCache.out = src;
    return src;
  }
  const step = Math.max(160, Math.floor(src.length / 120));
  const prev = longStreamParseCache.src;
  if (prev && src !== prev && src.startsWith(prev) && src.length - prev.length < step) {
    return longStreamParseCache.out;
  }
  longStreamParseCache.src = src;
  longStreamParseCache.out = src;
  return src;
}

const Markdown = React.memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const raw = text ?? "";
  const pre = streaming ? repairStreamingMarkdown(raw) : raw;
  
  let src = tightenCjkSpacing(normalizeInlineTables(normalizeBrokenLines(normalizeMarkdownBlocks(pre))));
  
  if (streaming) { src = repairStreamingTableAfter(src); }
  
  const parsed = throttleLongStreamParse(src, !!streaming);
  if (parsed.length >= LARGE_TEXT) {
    return renderLargeText(parsed);
  }
  const blocks = parseBlocks(parsed);
  return <>{blocks.map((b, i) => renderBlock(b, `md${i}`))}</>;
});

export default Markdown;

const codeStyle: React.CSSProperties = {
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 12.5,
  background: "var(--bg-hover)",
  padding: "1px 5px",
  borderRadius: 5,
  color: "var(--accent-hover)",
};
const codeBlockWrapStyle: React.CSSProperties = {
  margin: "10px 0",
  borderRadius: 10,
  overflow: "hidden",
  border: "1px solid var(--border)",
  background: "var(--bg-input)",
};
const codeBlockHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "4px 12px",
  background: "var(--bg-hover)",
  borderBottom: "1px solid var(--border)",
};
const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  fontSize: 12.5,
  lineHeight: 1.6,
  overflowX: "auto",
  fontFamily: "Consolas, 'Courier New', monospace",
  whiteSpace: "pre",
  color: "var(--text)",
  background: "transparent",
};