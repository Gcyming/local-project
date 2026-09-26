/**
 * gui/src/renderer/pages/Markdown.tsx — 轻量 Markdown 渲染（无第三方依赖、无 dangerouslySetInnerHTML）。
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 / 引用 / 无序·有序列表 / 分割线 / 表格。
 */
import React, { type JSX } from "react";
// A-1121（②）：payload 形状的唯一出处（主进程/工具层那份），这里只借类型
import type { SidebarOpenRequest } from "../../shared/ipc.js";

/** 全局事件：请求在右侧侧边栏新建页显示内容（A-173） */
export const SIDEBAR_OPEN_EVENT = "slime:open-in-sidebar";
/**
 * A-1121（②）：右栏是 **Agent 的工具栏**，不只是浏览器 —— 这个 payload 因此有多种承载：
 *   · `url`      → 浏览器页（链接 / http_create_app 起的应用）
 *   · `terminal` → 终端页（`cmd` 可预填命令）
 *   · `files`    → 文件页的**目录浏览**形态（`root` 为浏览根，`rel` 为要定位到的条目）
 *   · `file`     → 文件页（源码 / 图片 / md 预览；`.html` 由 A-1120 分流进浏览器页）
 *
 * 前三种的形状**直接取主进程那份唯一出处**（`core-ts/src/sidebarOpen.ts`，经 `shared/ipc` 转发），
 * 只有 `file` 是渲染层内部的（主进程不产生"打开某个文件"的请求，那是点击产物/链接才有的）。
 * 把它们合成一个大 interface 会让两边互相污染：主进程加一个 kind，渲染层这份就悄悄不认识了。
 *
 * ⚠️ 判断"某一种 kind 该建什么页"的代码**只有 `RightSidebar` 一处**（它才知道 tabs 现状与复用口径）；
 * 其它模块只允许"发请求"，不许自己建页 —— 否则会出现两套复用/EOL 判据（本仓已为两份口径付过账）。
 */
export type SidebarOpenPayload =
  | SidebarOpenRequest
  | { kind: "file"; rel?: string; name?: string; from?: "site" | "user" };
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
    if (m.index > last) out.push(<React.Fragment key={`${key}t${k}`}>{autoLink(text.slice(last, m.index), `${key}${k++}`)}</React.Fragment>);
    out.push(<em key={`${key}i${k++}`}>{autoLink(m[1], `${key}${k}`)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${key}t${k}`}>{autoLink(text.slice(last), `${key}${k}`)}</React.Fragment>);
  return <>{out}</>;
}

/** A-975：裸 URL 自动链接——Agent 生成的成品链接（如 http://127.0.0.1:8080）此前是纯文本不可点，
 *  用户必须自己开浏览器。现在自动链接化，点击即在**右侧边栏**打开（不跳系统浏览器）。 */
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

/**
 * 表格行的「流式半成品」判定（A-1094）。
 *
 * 用户实测（A-1094 image#5）：正文里 `|---|------|`、`| 1 | cd /d "D:..." |` 全部**原文直出**。
 * 根因有两处，都在"行还没写完/还没到齐"的瞬间：
 *   ① `parseBlocks` 的表格分支要求**分隔行已存在**（`i + 1 < n && 下一行是分隔行`）——
 *      流式期"表头行到了、分隔行还没到"的那几十~几百毫秒，表头行退化成普通段落 → `|` 裸露；
 *   ② 分隔行打字到一半（`|---`、`|---|-`）既不是完整分隔行（列数不够列数校验），
 *      又会被「分割线」分支 `/^(-{3,}…)$/` 抢去渲染成一条 `<hr>` → 表头裸露 + 多一条横线。
 * 修法与既有 `repairStreamingMarkdown` 一致：**只在流式渲染副本上补全**，不改原文。
 *   拆分点不同，执行时机也不同（两次调用，见 `Markdown`）：
 *   · `repairStreamingTablePre`（净化链**之前**）：末尾是"打字到一半的分隔行"（`|---`、`|---|-`）
 *     → 补足为完整分隔行。**必须前置**：净化链的 `normalizeMarkdownBlocks` 会把半截 `|---`
 *     拆成 `|` + 空行 + `---`（`---` 命中块标记正则），那时表格已被拆散成「段落 + 孤立 hr」。
 *   · `repairStreamingTableAfter`（净化链**之后**）：末尾是"表格首行"（≥2 个 `|`）、真分隔行未到
 *     → 补一行同列数占位分隔行。**必须后置**：若前置补，`normalizeMarkdownBlocks` 会在表头与
 *     它之间插空行 → 又散架。列数稳定，后续真分隔行到达时不变 → 不重排。
 */
/** 情况 ②（净化链**之前**）：末尾是打字到一半的分隔行 → **替换**为完整分隔行。
 *
 *  ⚠️ 这里用「替换」而不是「补一行」：`|---`（≥3 连字符）会命中 `normalizeMarkdownBlocks`
 *  的块标记正则（`[-_*]{3,}`）而被拆成 `|` + 空行 + `---` —— 若只是在其后追加一行完整分隔行，
 *  中间那截被拆散的 `|---` 仍会把表格劈成三段（表头段落 / 孤立 hr / 残余行）。直接替换掉它，
 *  净化链就无从拆起。列数取半成品里的 `-` 段数（`|---|--` → 2 列），至少 1。
 */
function repairStreamingTablePre(text: string): string {
  if (!text.includes("|")) return text;
  let body = text;
  let trail = "";
  const m = /(\n+)$/.exec(body);
  if (m) { trail = m[1]; body = body.slice(0, body.length - trail.length); }
  const nl = body.lastIndexOf("\n");
  const t = body.slice(nl + 1).trim();
  // 末尾不是"半成品分隔行"（以 | 开头、只含 | - : 空格、含 -）→ 不处理
  if (!/^\|[\s:|-]*$/.test(t) || !/-/.test(t)) { return text; }
  const dashes = t.split("|").filter((s) => /^[:\-\s]+$/.test(s) && s.includes("-"));
  const cols = Math.max(1, dashes.length);
  const sep = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
  const head = nl >= 0 ? body.slice(0, nl + 1) : "";
  return head + sep + trail;
}

/**
 * 情况 ①③（净化链**之后**）：末尾是"表格首行"、下一行（真分隔行）还没到 → 补占位分隔行。
 *
 * ⚠️ 末行判定必须**跳过末尾换行**：流式正文常以 `\n` 收尾（`| 表头 |\n`），
 * 若直接取 `lastIndexOf("\n")` 之后的空串，任何表格都判不出来（本函数首版即栽在这里）。
 */
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
  // 情况 ①：末尾已是完整分隔行 → 无事可做（真分隔行已到）
  if (/^\|?[\s:|-]+\|?$/.test(t) && /-/.test(t) && /^\|.*\|$/.test(t)) { return text; }
  const pipes = (t.match(/\|/g) ?? []).length;
  if (pipes < 2) { return text; }
  // 上一行已是真分隔行 → 当前行是数据行/表尾，无需补
  if (prevLine && looksLikeTableSep(prevLine)) { return text; }
  const k = t.indexOf("|");
  const head = k >= 0 ? t.slice(k) : t;
  const cols = Math.max(1, head.split("|").filter((s) => s.trim() !== "").length);
  const sep = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
  return body + "\n" + sep + trail;
}

/**
 * 流式补全：解析前对未闭合的 Markdown 语法做"最小补全"（代码围栏/行内反引号/粗体/斜体/表格），
 * 避免流式输出长文本时暴露原始符号（#、*、---、```、| 等）。仅在渲染副本上操作，不修改原始内容；
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

  // 3) 表格半成品（打字中的分隔行）补全 —— 必须在净化链**之前**（见 repairStreamingTablePre）
  text = repairStreamingTablePre(text);

  return text;
}

/**
 * 表格半成品补全须在**净化链之后**执行（A-1094）：
 * `normalizeMarkdownBlocks` 会在块标记（`#`/`-`/`|` 首行）**前插空行**——若先补分隔行，
 * 它会被插到表头与分隔行**中间**，表格当场散架（`| 表头 |` 变段落、补的 `|---|` 变孤立 `<hr>`）。
 * 故拆成两步：`repairStreamingMarkdown`（围栏/行内）→ 净化链 → `repairStreamingTable`（表格）。
 */

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
 *  ⚠ **A-1106：折叠范围 + 结构硬门**（修「短句 + 短标题被误判为碎片换行」）：
 *    ① **只折叠同一个「空行块」** —— 空行是 markdown 的块边界。旧实现一次性折叠**整段文本
 *       （含其中所有段落）**，于是 `正文\n\n## 标题` 被压成一行 `正文 ## 标题`（标题被碾平）；
 *    ② 块内出现任何 **markdown 结构标记**（标题 / 列表项 / 表格行 / 引用 / 围栏 / 缩进码块）
 *       就**绝不折叠** —— token 碎片流里不会含这些标记；旧实现只在统计比例时排除它们、
 *       折叠时却把它们一起拼进去 ⇒ `正文\n## 标题\n结束` 被碾成 `正文 ## 标题 结束`。
 *  ⚠ 取向：**宁可漏折叠（保持原样），也不误折叠（结构被抹平）** —— 漏折叠只是不够紧凑，
 *    误折叠是内容损坏，且不可逆（用户看到的原文已经没了）。
 *  幂等、安全；供 Markdown 入口与各 pre-wrap 直渲染点（思考/工具结果/展开卡）统一兜底。 */
const STRUCTURAL_LINE_RE = /^[\s#>|*_\-`~:.]+$/; // 空 或 纯符号行（markdown 结构）
/** A-1106：markdown **结构行**（行首标记形态）。token 碎片流里不会出现这些标记。 */
const MD_STRUCTURE_LINE_RE = /^(?:#{1,6}\s|[-*+]\s+|\d+[.)]\s+|\||>|```|~~~| {4,}\S)/;

/** A-1106：该行是否带 markdown 结构标记。
 *  ⚠️ 必须**两种形态都测**：缩进码块（` {4,}\S`）只能在**原始行**上匹配（trim 会把缩进吃掉），
 *  而标题/列表/表格等行首标记在**trim 后**才能匹配「有前导空白」的合法形态（如 `  - 项`）。 */
function isMdStructureLine(line: string): boolean {
  return MD_STRUCTURE_LINE_RE.test(line) || MD_STRUCTURE_LINE_RE.test(line.trim());
}

/** A-1106：单个「空行块」（一串相邻非空行）的碎片折叠判定 → 返回该块的行数组（折叠后只有 1 行）。 */
function foldTokenFragBlock(block: string[]): string[] {
  if (block.length < 3) { return block; }
  // 硬门：块内含任何 markdown 结构标记 ⇒ 这是「有结构的正文」，绝不折叠（先于比例判定）
  if (block.some(isMdStructureLine)) { return block; }
  const contentLines = block.filter((l) => {
    const t = l.trim();
    if (t.length === 0) { return false; }
    if (STRUCTURAL_LINE_RE.test(l)) { return false; }
    // A-918++：列表项（- / * / + / 1. 开头）是 markdown 结构，天然短行，**不算 token 碎片**。
    // 否则「优点：/- 快/- 稳」这类短列表会被误判为碎片换行 → 整段折叠成一行，列表退化为原始文本
    // （用户实测「Markdown 渲染时常失效、退化为原始文本」的根因）。
    if (/^[-*+]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) { return false; }
    return true;
  });
  if (contentLines.length < 2) { return block; }
  const frags = contentLines.filter((l) => l.length <= 4).length;
  if (frags / contentLines.length < 0.5) { return block; }
  const parts = block.map((l) => l.trim()).filter(Boolean);
  // 全中文碎片 → 直接拼接（中文无语间空格约定）；含英文 → 空格拼接确保英语可读
  const allCjk = parts.every((p) => /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/.test(p));
  return [allCjk ? parts.join("") : parts.join(" ")];
}

export function normalizeBrokenLines(text: string): string {
  if (!text) { return text; }
  const lines = text.split("\n");
  if (lines.length < 3) { return text; }
  // A-1106：**按空行分块**再逐块判定（见 docblock）。折叠只作用于判定命中的那一块，
  // 其余块（正常段落）原样保留 —— 旧实现把整段文本一起折叠，是「标题被碾平」的直接原因。
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
 *      ⚠ A-1105：还要求「最近的非空白字符不是 `|`」且「标记后不是 空白+`|`」——**表格里的 `#`
 *      是单元格内容，不是标题标记**。markdown 表头首列常写 `| # | 目标 |`、`| # 序 | 任务 |`，
 *      拆了会让表头行变标题、表格当场解体（管道符裸露），正是用户实测「表头整块纯文本」的元凶。
 *   3) 表格行尾巴嵌 `| --- ##`：从该管道断开（左半保留为完整表格行）；
 *   4) 正文粘表头：行内含 ≥2 管道 且（行内嵌 `| --- |` 分隔单元格 或 下一行是分隔行）。
 * 只有发生过拆分的行才会 trim——散文/缩进配置原样保留（防 pre-wrap 缩进被打散）。
 */
const INLINE_HR_RE_TARGET = /(^|[^\s`\-])(-{3,})(?=\s|#|$)/g;
const INLINE_HEADING_RE_TARGET = /([^A-Za-z0-9_#])(?<!\|[\s]*)(#{1,6})(?!\s*\|)(?=\s+\S)/g;
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
 *  不打断——保证表格表头+分隔行连续成块。A-1105：**列表是「块」不是「每行一块」** ——
 *  同类列表项之间不补空行（否则 10 项 = 10 个单元素 <ol>、每行都从「1.」重编号），
 *  列表块结束处（列表项后紧跟正文行）必须补空行（否则正文并进列表 para ⇒ 整块退化成段落）。 */
/** A-1105：列表项类型判定（有序 `ol` / 无序 `ul`），非列表项 → null。判据与 parseBlocks
 *  的列表分支同源（`- * +` 与 `N. N)`），保证「补空行」的取舍与「怎么解析」用的是同一把尺。 */
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
      // A-1105①：**同类列表项之间不补空行** —— 否则每个列表项都被空行切开，parseBlocks 的
      // 列表分支（para.every(是列表项)）永远只拿到 1 项 ⇒ 产出 N 个各含 1 项的 <ol>/<ul>，
      // 浏览器给每行都从「1.」重新编号（用户实测：子代理任务清单的编号/符号不成列表）。
      const sameListKind = kind !== null && kind === prevKind;
      // A-1105②：列表块**结束处**也要隔断 —— 列表项之后紧跟正文行（无空行）时，正文会被并进
      // 同一个 para，`para.every(是列表项)` 落空 ⇒ 整块退化成段落、`1.`/`-` 原文裸露。
      const listEnds = kind === null && prevKind !== null && l.trim() !== "";
      if (prev !== "" && !sameListKind && (BLOCK_RE.test(l) || listEnds)) { out.push(""); }
    }
    out.push(l);
  }
  return out.join("\n");
}

/** 代码块右上角「复制」按钮。
 *  业界惯例（GitHub / ChatGPT / Claude / Cursor 一致）：复制按钮放在代码块的**标题行右端**
 *  （不是浮动在代码上，避免遮挡首行），悬停显形、点击后短暂显示"已复制"。
 *  剪贴板不可用（非安全上下文 / 无权限）时静默降级——不弹错、不误导。 */
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
      if (p && typeof p.then === "function") { p.then(done).catch(() => { /* 无权限 → 无反馈 */ }); }
    } catch { /* ignore */ }
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

/**
 * A-980-R24：长文本流式期的**解析步进缓存**（只在 ≥LARGE_TEXT 时生效）。
 *
 * 问题：`Markdown` 是 `memo(text)`，但流式期每帧 text 都在变（新增几个字符）→ 每帧都要对**整段**
 * 重跑「正则净化链 + parseBlocks + renderBlock」。一段两万字的回答，每帧全量解析是几十毫秒级，
 * 渲染进程会被钉在 60fps 做同一件重活；它与流式 buffer 堆积叠加，是渲染进程卡死/OOM 的放大器。
 *
 * 做法：长文本流式时**按增长比例步进**——距上次解析不足 step 个字符就**复用上次的解析文本**
 * （只是显示落后一点点，内容永远是正确文本的前缀，不会错乱）。
 * 短/中文本完全不受影响（保持逐字平滑）；长文本本来就不可能逐字丝滑，用「少解析」换「不卡死」。
 *
 * 单槽缓存：多个 Markdown 实例同时复用时最多退化为「缓存不命中」，结果始终是各自文本的前缀，安全。
 */
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
  // A-929：统一净化管道（标本式）——块级规整（补空行）→ 碎片换行折叠 → 单行内联表格规整 → 中文标点/CJK 紧贴
  let src = tightenCjkSpacing(normalizeInlineTables(normalizeBrokenLines(normalizeMarkdownBlocks(pre))));
  // A-1094：表格首行已到、真分隔行未到 → 补占位分隔行（**必须在净化链之后**，否则被插空行拆散）
  if (streaming) { src = repairStreamingTableAfter(src); }
  // A-980-R24：长文本流式解析节流（见 throttleLongStreamParse 注释）
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