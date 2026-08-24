/**
 * gui/src/renderer/pages/Markdown.tsx — 轻量 Markdown 渲染（无第三方依赖、无 dangerouslySetInnerHTML）。
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 引用 / 无序·有序列表 / 分割线 / 表格。
 */
import React, { type JSX } from "react";

/** 解析行内排版 → React 节点数组 */
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

/** 粗体 / 斜体 / 删除线 / 链接 */
function renderBoldItalic(text: string, key: string): JSX.Element[] {
  // 链接 [text](url)
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  const out: JSX.Element[] = [];
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  linkRe.lastIndex = 0;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`${key}l${k}`}>{renderEm(text.slice(last, m.index), `${key}${k++}`)}</React.Fragment>);
    const href = m[2].startsWith("http") ? m[2] : "#";
    out.push(<a key={`${key}l${k++}`} href={href} target="_blank" rel="noreferrer" style={{ color: "var(--accent-hover)", textDecoration: "underline" }}>{m[1]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${key}l${k}`}>{renderEm(text.slice(last), `${key}${k}`)}</React.Fragment>);
  return out;
}

function renderEm(text: string, key: string): JSX.Element[] {
  // 先处理程删除线 ~~..~~，再粗体 **..**，最后斜体 *..*
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
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<em key={`${key}i${k++}`}>{m[1]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/**
 * 流式补全：解析前对未闭合的 Markdown 语法做"最小补全"（代码围栏/行内反引号/粗体/斜体），
 * 避免流式输出长文本时暴露原始符号（#、*、---、``` 等）。仅在渲染副本上操作，不修改原始内容；
 * 文本完整时各计数为偶数，补全为无操作。
 */
function repairStreamingMarkdown(src: string): string {
  if (!src) return src;
  let text = src;
  const fenceRe = /^```\s*([\w-]*)\s*$/;

  // 1) 代码围栏：行首 ``` 数量为奇数 → 补结束围栏（最先处理，影响后续上下文判断）
  const fenceCount = text.split("\n").filter((l) => fenceRe.test(l.trim())).length;
  if (fenceCount % 2 === 1) {
    text += "\n```";
  }

  // 2) 行内反引号 / 粗体 / 斜体：仅统计代码块与行内代码外的未闭合标记
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
        // 行首 * 后跟空白 → 列表标记，不算斜体
        const isListMarker = i === 0 && /\s/.test(line[i + 1] ?? "");
        if (!isListMarker) italic++;
      }
    }
  }
  if (inlineTick % 2 === 1) text += "`";
  if (bold % 2 === 1) text += "**";
  if (italic % 2 === 1) text += "*";

  return text;
}

/* 块级解析：行 → 类型 */
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
  // 累积非空段
  const para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) { return; }
    const first = para[0].trim();
    const quote = first.startsWith(">");
    if (quote) {
      blocks.push({ t: "quote", text: para.map((l) => l.trim().replace(/^>\s?/, "")).join("\n") });
      para.length = 0;
      return;
    }
    // 列表
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
    // 代码块
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
    // 表格行
    if (t.startsWith("|") && i + 1 < n && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && /[-]/.test(lines[i + 1])) {
      flushPara();
      const header = splitRow(t);
      const sep = splitRow(lines[i + 1]);
      void sep;
      const rows: string[][] = [header];
      i += 2;
      while (i < n && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      if (rows.length >= 1) { blocks.push({ t: "table", rows }); }
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.+)$/.exec(t);
    if (h) { flushPara(); blocks.push({ t: "heading", level: h[1].length, text: h[2] }); continue; }
    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); blocks.push({ t: "hr" }); continue; }
    // 纯符号行（未闭合的标题/分割线/引用/列表标记）：跳过，避免流式时暴露原始符号
    if (/^[#>*_\-]{1,6}$/.test(t)) continue;
    para.push(line);
  }
  flushPara();
  return blocks;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function renderBlock(b: Block, key: string): JSX.Element {
  switch (b.t) {
    case "code":
      return (
        <div key={key} style={codeBlockWrapStyle}>
          <div style={codeBlockHeaderStyle}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.3 }}>
              {b.lang ? b.lang.toUpperCase() : "CODE"}
            </span>
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
        <blockquote key={key} style={{ margin: "8px 0", padding: "2px 12px", borderLeft: "3px solid var(--accent-soft)", color: "var(--text-muted)" }}>
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
      return <div key={key} style={{ margin: "2px 0", whiteSpace: "pre-wrap" }}>{renderInline(b.text, key)}</div>;
  }
}

const Markdown = React.memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const src = streaming ? repairStreamingMarkdown(text ?? "") : (text ?? "");
  const blocks = parseBlocks(src);
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