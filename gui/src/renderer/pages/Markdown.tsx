/**
 * gui/src/renderer/pages/Markdown.tsx — 轻量 Markdown 渲染（无第三方依赖、无 dangerouslySetInnerHTML）。
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 引用 / 无序·有序列表 / 分割线 / 表格。
 */
import React, { type JSX } from "react";

/** 全局事件：请求在右侧侧边栏新建页显示内容（A-173） */
export const SIDEBAR_OPEN_EVENT = "slime:open-in-sidebar";
export interface SidebarOpenPayload {
  kind: "url" | "file";
  url?: string;
  /** 文件相对工作目录路径（或绝对路径） */
  rel?: string;
  name?: string;
}
export function requestSidebarOpen(payload: SidebarOpenPayload): void {
  window.dispatchEvent(new CustomEvent<SidebarOpenPayload>(SIDEBAR_OPEN_EVENT, { detail: payload }));
}

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
    out.push(
      <a
        key={`${key}l${k++}`}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          // A-173：http(s) 链接仍在右侧侧边栏新建「浏览器」页打开（不跳系统浏览器）
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
      // 不去行首 trim：引用块 pre-wrap 保形渲染，缩进/对齐空格需原样保留
      blocks.push({ t: "quote", text: para.map((l) => l.replace(/^>\s?/, "")).join("\n") });
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
      const rows: string[][] = [header];
      i += 2;
      while (i < n && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      // A-9xx 列数规整：模型输出表头/分隔/数据行列数常不一致（如表头 2 列、分隔 5 列），
      // 以分隔行列数为准补齐/截断，避免 td 边框错位、表格质感怪异
      const colCount = Math.max(sep.length, ...rows.map((r) => r.length));
      const norm = rows.map((r) => {
        const row = r.slice(0, colCount);
        while (row.length < colCount) { row.push(""); }
        return row;
      });
      blocks.push({ t: "table", rows: norm });
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

/**
 * 段落「保形」判定：换行/缩进/对齐空格需要原样保留的文本（示例、配置、命令、多行数值对齐）——
 * 命中任一即 pre-wrap 渲染：
 *  1) 任一行长度 ≥ 48（长行通常是示例/配置/表格化文本，而非流式散文的短句分行）；
 *  2) 行首存在缩进（空格 / 制表符）；
 *  3) 行内存在连续 2+ 空格或制表符（对齐结构）。
 * 普通散文（每行短、无缩进）不命中 → 维持「单换行折叠为空格」，保持紧凑、避免流式几字一换行。
 *
 * A-907 否决规则：先做「token 碎片化换行」检测——上游/粘贴文本常见的畸形形态是
 * 「几乎每个短词/片段被单独断行」（如 `389\nk\nstars`、`（\n风\n铃\n）`），中间再夹一两条
 * 长句。此时长行规则会被误命中而整段 pre-wrap，把碎片行全部暴露成逐词断行（比折叠更差）。
 * 判定：行数 ≥3 且 **半数以上行 ≤4 字符**（碎片行）→ 一律不保形（折叠为空格拼接），
 * 保证该形态的文本在任何情况下都不会被逐词断行。
 */
export function preserveBreaks(text: string): boolean {
  if (!text) { return false; }
  const lines = text.split("\n");
  // token 碎片化换行否决（必须先于长行/缩进判定，防止被夹杂长句误拉入 pre-wrap）
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

/** 就地净化「token 碎片化换行」（A-922）：**内容行**行数 ≥3 且半数以上 ≤4 字符 → 判定为上游
 *  畸形换行（每词一行，如 `用\n户\n的`），把 \n 折叠为空格拼接成可读文本；否则原样返回。
 *  ⚠ A-9xx：碎片比例只统计「内容行」——**空行（段落分隔）与纯符号行（`---`/`### `/`|…|` 等
 *  markdown 结构）不计入**。此前把空行/`---` 当短行计数，`段落。\n\n---\n\n## 标题` 这类
 *  正常 markdown 极易 >50% 触发折叠，把刚解塞出的块结构整条碾平（长回复 markdown 失效元凶）。
 *  幂等、安全；供 Markdown 入口与各 pre-wrap 直渲染点（思考/工具结果/展开卡）统一兜底。 */
const STRUCTURAL_LINE_RE = /^[\s#>|*_\-`~:.]+$/; // 空 或 纯符号行（markdown 结构）
export function normalizeBrokenLines(text: string): string {
  if (!text) { return text; }
  const lines = text.split("\n");
  if (lines.length >= 3) {
    const contentLines = lines.filter((l) => l.trim().length > 0 && !STRUCTURAL_LINE_RE.test(l));
    if (contentLines.length >= 2) {
      const frags = contentLines.filter((l) => l.length <= 4).length;
      if (frags / contentLines.length >= 0.5) {
        const parts = lines.map((l) => l.trim()).filter(Boolean);
        // 全中文碎片 → 直接拼接（中文无语间空格约定）；含英文 → 空格拼接确保英语可读
        const allCjk = parts.every((p) => /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/.test(p));
        return allCjk ? parts.join("") : parts.join(" ");
      }
    }
  }
  return text;
}

/** 单行内联表格 → **重建标准 markdown 表格**（A-930）：模型/思考输出常见「整表挤成一行」
 *  （`核心特性：| 特性 | 说明 | |------|------| | 多模型 | ✅ |`），块级解析按行无法渲染。
 *  策略：仅当一行含 ≥6 个 `|` 且含 `---` 分隔段（表格特征强）时，按共享管道切出单元格，
 *  以 `---` 段数量为列数，重建为标准三行结构（表头行 / `|---|---|` 分隔行 / 数据行）
 *  ——渲染器从此可产出**真表格**（A-928 的"可读降级"仅作兜底：无法定位分隔段才保留原行）。 */
export function normalizeInlineTables(text: string): string {
  if (!text || !text.includes("---")) { return text; }
  return text
    .split("\n")
    .map((line) => {
      if ((line.match(/\|/g) ?? []).length < 6 || !line.includes("---")) { return line; }
      const k = line.search(/\|/);
      const head = k > 0 ? line.slice(0, k).trimEnd() : "";
      const rest = line.slice(k);
      // 共享管道分隔（`| A | B |` = 3 根 |）→ 按 | 切割
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

/* ────────────────────────── 行内块标记解塞（unjam）──────────────────────────
 * A-9xx 标本式根治：agnès 类模型输出「块级标记与正文/同行内容挤在同一行」——
 *   `报告：--- ## 📋 项目功能分析 ### Campanula …：| 特性 | 说明 |`
 *   `| … | --- ## 🔍 下节标题 ### 1. …`
 * 按行解析只看行首，这些标记全被并进段落 →「markdown 渲染不到位 + 实时流式只见原始符号」。
 * 这里保守地「在块标记前插入换行」把行内标记断为独立行（**保留全部原文符号**，仅改写
 * 渲染副本），还原标准多行 markdown。仅命中强特征，避免误伤正常散文/代码：
 *   1) 行内 `---`：3+ 连字符且后随空白/标题/行尾（em-dash 连写 `---` 前后无空白不拆）；
 *   2) 行内 `#… ` 标题：标记前一个字符不是 字母/数字/下划线/#（`C# 语言`、`x# ` 不拆）；
 *   3) 表格行尾巴嵌 `| --- ##`：从该管道断开（左半保留为完整表格行）；
 *   4) 正文粘表头：行内含 ≥2 管道 且（行内嵌 `| --- |` 分隔单元格 或 下一行是分隔行）。
 * 只有发生过拆分的行才会 trim——散文/缩进配置原样保留（防 pre-wrap 缩进被打散）。
 */
const INLINE_HR_RE_TARGET = /(^|[^\s`\-])(-{3,})(?=\s|#|$)/g;
const INLINE_HEADING_RE_TARGET = /([^A-Za-z0-9_#])(#{1,6})(?=\s+\S)/g;
const CELL_BLOCK_RE = /\|[ \t]*-{3,}[ \t]*#{1,6}\s/;

/** 表格行分隔判断（与 parseBlocks 表格分支同构） */
function looksLikeTableSep(l: string | undefined): boolean {
  if (!l) { return false; }
  const t = l.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && /-/.test(t);
}

/** 身材粘接表头（`正文：| A | B |`）：命中表格特征 → 在首个 `|` 前插入换行 */
function splitFusedTableHead(s: string, nextLine: string | undefined): string {
  if (s.startsWith("|")) { return s; }
  const first = s.indexOf("|");
  if (first < 1) { return s; }
  const rest = s.slice(first);
  if ((rest.match(/\|/g) ?? []).length < 2) { return s; } // 仅单对 |…|：非表格
  const hasSepCell = rest.split("|").some((c) => /^-{3,}$/.test(c.trim()));
  if (hasSepCell || looksLikeTableSep(nextLine)) {
    return `${s.slice(0, first)}\n${rest}`;
  }
  return s;
}

/** 单行解塞（fence 行原样返回；拆分过的行 → 各碎片 trim） */
function unjamOneLine(line: string, nextLine: string | undefined): string[] {
  if (/^```/.test(line.trim())) { return [line]; }
  // 0) 表格行尾巴嵌 `| --- ##`：从该管道断开（左半保留为完整表格行，含闭合管道），右半递归继续解塞
  const cell = CELL_BLOCK_RE.exec(line);
  if (cell && cell.index > 0) {
    const left = line.slice(0, cell.index + 1).replace(/[ \t]+$/, "");
    const right = line.slice(cell.index + 1).replace(/^[ \t]+/, "");
    return [left, ...unjamOneLine(right, nextLine)];
  }
  let s = line;
  // 1) 行内横线：在 `---` 前插入换行（保留 --- 符号）
  s = s.replace(INLINE_HR_RE_TARGET, "$1\n$2");
  // 2) 正文粘接表头：在首个 `|` 前插入换行
  s = splitFusedTableHead(s, nextLine);
  // 3) 行内标题：在 `#` 前插入换行
  s = s.replace(INLINE_HEADING_RE_TARGET, "$1\n$2");
  if (s === line) { return [line]; } // 未拆分：原样保留（缩进/对齐空格不被 trim 打散）
  return s.split("\n").map((f) => f.trim()).filter(Boolean);
}

/** 按行解塞（fence 内不处理） */
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

/** 块级 Markdown 规整（A-929 + A-9xx）：先「行内块标记解塞」把挤在一行的
 *  横线/标题/表格断为独立行，再对块级标记行（`#` 标题 / 无序列表 `- ` / 有序列表 `1. ` /
 *  引用 `> ` / 横线 `---`）前**补空行**；fence（```）内不受影响；表格数据行（以 `|` 开头）
 *  不打断——保证表格表头+分隔行连续成块。 */
export function normalizeMarkdownBlocks(text: string): string {
  if (!text) { return text; }
  const lines = unjamBlockMarkers(text.split("\n"));
  const out: string[] = [];
  let inFence = false;
  const BLOCK_RE = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|[-_*]{3,}\s*$)/;
  for (const l of lines) {
    if (/^```/.test(l.trim())) { inFence = !inFence; out.push(l); continue; }
    if (!inFence && BLOCK_RE.test(l)) {
      const prev = out[out.length - 1] ?? "";
      if (prev !== "") { out.push(""); }
    }
    out.push(l);
  }
  return out.join("\n");
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
      // 保形文本（示例/配置/对齐）：pre-wrap 原样保留换行/缩进/空格，杜绝「换行、缩进、空格被折叠打散」；
      // 普通散文：单换行 = 软换行（折叠为空格），双换行才分段（parseBlocks 已按空行切段）；
      // 不能一律 pre-wrap：模型流式输出常带单换行，pre-wrap 会把每个单换行变成硬断行 → 几字一换行、高度爆炸
      if (preserveBreaks(b.text)) {
        return <div key={key} style={{ margin: "2px 0", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>{renderInline(b.text, key)}</div>;
      }
      return <div key={key} style={{ margin: "2px 0" }}>{renderInline(b.text.replace(/\n/g, " "), key)}</div>;
  }
}

const LARGE_TEXT = 20000;
/** 极端超长兜底阈值（≥120k：文档正文级别，纯文本可读优先、不做 markdown，防渲染崩溃） */
const LARGE_TEXT_HARD = 120000;

/** 超长文本（>=20k 字符）：A-931 根因修复——此前仅「双换行分段 + renderInline」纯文本渲染，
 *  markdown 全部失效（长回复的表格/标题/横线原文直出，用户实测 133s 长回复整条退化）。
 *  现在同样走 parseBlocks + renderBlock（真 markdown 渲染），流式降频由调用方 useDeferredValue 承担；
 *  仅当 ≥LARGE_TEXT_HARD 才退回纯文本兜底（极端防崩）。 */
function renderLargeText(text: string): JSX.Element {
  // A-922：超大文本入口统一碎片净化，防 pre-wrap 直出"逐词断行"
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

/** 中文标点紧贴（A-926/A-927 防复发锚定）：仅移除中文标点两侧**水平空格**与开括号后空格，
 *  英文单词间空格完全不动——上游 token 级输出常见 `L M S tudio`、`好的 ， 我`，正文段落统一
 *  收敛中式空格观感。
 *  ⚠ A-9xx：**严禁用 `\s` 匹配**——`\s` 含换行，会把 `段落。\n\n---` 的块边界重新吞掉。
 *  只配 `[ \t\u3000]`（水平空格/全角空格），换行/块结构 100% 保留。 */
export function tightenCjkSpacing(text: string): string {
  return (text ?? "")
    .replace(/[ \t]+([，。；：！？、）》】）])/g, "$1")
    .replace(/([，。；：！？、）》】）])[ \t\u3000]+/g, "$1")
    .replace(/([（《【])[ \t\u3000]+/g, "$1")
    // A-927：中文（CJK）与中文之间的空格也收敛（`我 看到` → `我看到`），英文单词间不受影响
    .replace(/([\u4e00-\u9fff])[ \t\u3000]+([\u4e00-\u9fff])/g, "$1$2");
}

const Markdown = React.memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const raw = text ?? "";
  const pre = streaming ? repairStreamingMarkdown(raw) : raw;
  // A-929：统一净化管道（标本式）——块级规整（补空行）→ 碎片换行折叠 → 单行内联表格规整 → 中文标点/CJK 紧贴
  const src = tightenCjkSpacing(normalizeInlineTables(normalizeBrokenLines(normalizeMarkdownBlocks(pre))));
  if (src.length >= LARGE_TEXT) {
    return renderLargeText(src);
  }
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