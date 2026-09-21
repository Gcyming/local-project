/**
 * gui/src/shared/releaseNotes.ts — GitHub Release 正文（releaseNotes）→ 结构化块。
 *
 * **为什么要有这个文件**（A-1037）：
 * `electron-updater` 把 GitHub Release 的**正文原文**塞进 `releaseNotes`。本项目发布时
 * 写的是 **HTML**（`<h3>`/`<table>`/`<code>`…），而渲染层此前是
 * `{releaseNotes}` 塞进一个 `whiteSpace: pre-wrap` 的 `<span>` —— **源码裸露**，
 * 用户看到的是 `<h2>本版重点修复</h2>` 这种标签字面量（v0.0.3 实测）。
 *
 * 这里只做一件事：**把「远程拿来的字符串」变成结构化块**，让渲染层用 React 元素画出来，
 * 而不是把远程字符串当 HTML 注入。**绝不使用 `dangerouslySetInnerHTML`** ——
 * 那是把远端内容当代码执行（渲染进程还挂着 preload API，等于开门）。
 *
 * 输入两种都认：**HTML**（本项目现状）与 **Markdown**（手写 release note 的常见形态）。
 * 输出是纯数据，可被测试直接断言（不渲染也能验）。
 */

export interface ReleaseNoteRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** 链接目标（已过滤协议，仅保留 http/https） */
  href?: string;
}

export interface ReleaseNoteBlock {
  kind: "heading" | "paragraph" | "list" | "table" | "hr" | "code";
  /** heading：1..6 */
  level?: number;
  /** heading / paragraph / list 项共用的行内片段 */
  runs?: ReleaseNoteRun[];
  /** list：每个元素是一行的行内片段 */
  items?: ReleaseNoteRun[][];
  /** list：有序列表 */
  ordered?: boolean;
  /** table：表头行 */
  header?: ReleaseNoteRun[][];
  /** table：数据行 */
  rows?: ReleaseNoteRun[][][];
  /** code：整段原文 */
  text?: string;
}

/**
 * 表格区域占位符（避免 `|` 与正文里的竖线混淆）
 *
 * ⚠️ A-1039 清理：这里原本还有一个 `BLOCK_BREAK` 块级标签集合，**从未被读取**
 * （结构转换实际靠下面的逐标签正则做）。留着一个不参与任何计算的"规则表"是纯负债 ——
 * 它会让人以为改这里能影响块级切分，实际毫无作用。已删除。
 */
const TABLE_SLOT = "\u0001";
/** HTML `<br>` 转换出的硬换行哨兵 */
const HARD_BREAK = "\u0000";

/** HTML 实体解码（只认确定安全的那些；未知原样保留，不猜） */
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
      // 控制字符与非法码点原样保留（不要造出奇怪字符）
      if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) { return whole; }
      try { return String.fromCodePoint(n); } catch { return whole; }
    }
    const v = ENTITIES[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

/** 去掉脚本/样式/注释——它们不该出现在更新说明里，且是注入的高危载体 */
function stripDangerous(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(iframe|object|embed|form|input|button|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(iframe|object|embed|form|input|button|link|meta|base)\b[^>]*>/gi, "");
}

/** 行内标签 → Markdown 记号（此后只有一条行内解析路径） */
function inlineHtmlToMarkdown(s: string): string {
  return s
    .replace(/<\s*(strong|b)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "**$2**")
    .replace(/<\s*(em|i)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, "*$2*")
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, "`$1`")
    // ⚠️ 只在 href **通过白名单**时才转成 Markdown 链接；否则只留文字。
    // 否则 `javascript:xxx(1)` 会先被转成 `[文字](javascript:xxx(1))`，
    // 解析阶段再把不可信 href 丢掉，却把括号尾巴留成字面量（实测漏出 `)`）。
    .replace(/<\s*a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
      (_all, href: string, text: string) => (safeHref(href) ? `[${text}](${href})` : text))
    // 残余标签一律剥掉（不认识的一律当不存在，绝不原样输出）
    .replace(/<[^>]*>/g, "");
}

/**
 * 把 HTML 压成「一行一个块」的中间文本。
 * 表格被整体摘成占位符，交由 `parseTable` 单独处理（竖线不会被正文污染）。
 */
function htmlToLines(html: string): { lines: string[]; tables: ParsedTable[] } {
  const tables: ParsedTable[] = [];
  const withoutTables = stripDangerous(html).replace(/<table\b[\s\S]*?<\/table\s*>/gi, (t) => {
    tables.push(parseHtmlTable(t));
    return `\n${TABLE_SLOT}${tables.length - 1}${TABLE_SLOT}\n`;
  });

  const withBreaks = withoutTables
    // ⚠️ `<li>` 必须显式转成列表标记。此前只把 `<li>` 当块级标签换成换行 ——
    // 列表项于是全变成**普通段落**，项目符号整批丢失（实测）。
    // `<ol>` 区域单独编号（有序语义不该被降级成无序）。
    .replace(/<\s*ol\b[^>]*>[\s\S]*?<\s*\/\s*ol\s*>/gi, (block: string) => {
      let n = 0;
      return block.replace(/<\s*li\b[^>]*>/gi, () => `\n${(n += 1)}. `);
    })
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    // ⚠️ HTML 标题必须先转成 `#` 行：若交给下面通用的「块级标签 → 换行」，
    // `<h2>本版重点修复</h2>` 会退化成**普通段落**（标题层级整段丢失，实测）。
    .replace(/<\s*h([1-6])\b[^>]*>([\s\S]*?)<\s*\/\s*h\1\s*>/gi,
      (_all, lvl: string, body: string) => `\n${"#".repeat(Number(lvl))} ${body.trim()}\n`)
    .replace(/<\s*br\s*\/?\s*>/gi, HARD_BREAK)
    // `<hr>` 是**自闭合**标签，走不到下面的「块级标签」规则（那些都要求闭合对），
    // 会被当成残余标签直接剥掉 → 分隔线整条消失（实测）。这里显式转成分隔线记号。
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

/** 行内解析：`**粗**` / `*斜*` / `` `码` `` / `[文字](链接)`（**递归**，支持 `**粗里有 `码`**`） */
export function parseInline(src: string): ReleaseNoteRun[] {
  const out: ReleaseNoteRun[] = [];
  parseInlineInto(src, {}, out, 0);
  return out;
}

/**
 * ⚠️ **不做 `_斜体_`**：本项目正文里全是 `llama_bin`、`n_ctx_train` 这种下划线标识符，
 * 一旦把 `_` 当斜体记号，`llama_bin 与 n_ctx` 会被吃成斜体片段 —— 反而制造新的显示错误。
 * 记号越少，误伤越少。
 */
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
    // 合并相邻同样式片段，渲染层少一层元素
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
      // 粗体内仍可有 `码`/链接 —— 必须递归，否则反引号会作为字面量漏进界面
      parseInlineInto(m[2], { ...base, bold: true }, out, depth + 1);
    } else if (m[3] !== undefined) {
      // 行内码内部**不再解析**（原文照搬，这是代码的语义）
      push(m[3], { code: true });
    } else if (m[4] !== undefined) {
      parseInlineInto(m[4], { ...base, italic: true }, out, depth + 1);
    } else if (m[5] !== undefined) {
      const href = safeHref(m[6] ?? "");
      const before = out.length;
      parseInlineInto(m[5], base, out, depth + 1);
      if (href) {
        // 只给链接文字挂 href（过滤后的），不可信协议已被 safeHref 丢成纯文本
        for (let i = before; i < out.length; i += 1) { out[i].href = href; }
      }
    }
  }
  if (last < src.length) { push(src.slice(last)); }
}

/** 只放行 http/https —— `javascript:` / `data:` / `file:` 一律丢弃（退化成纯文本） */
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

/**
 * 归一化 `electron-updater` 的 releaseNotes 字段 —— **唯一实现**。
 *
 * ⚠️ 官方类型是 `string | ReleaseNoteInfo[] | null`（`{ version, note }[]`）。
 * 此前主进程直接 `info.releaseNotes as string`：一旦上游给的是**数组**，
 * 渲染层拿到的就是对象 → `<span>{obj}</span>` 直接崩。
 * `as` 断言不会在运行时救你，所以这里显式收敛成 string。
 */
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

/**
 * 主入口：release 正文（HTML 或 Markdown）→ 结构化块。
 * 任何异常都降级成「纯文本段落」，**绝不抛错、绝不返回原始 HTML 源码**。
 */
export function parseReleaseNotes(raw: unknown): ReleaseNoteBlock[] {
  const src = normalizeReleaseNotes(raw);
  if (!src) { return []; }
  try {
    return parseBlocks(src);
  } catch {
    return plainTextBlocks(src);
  }
}

/** 兜底：剥标签 + 解实体 → 按行成段（保证用户至少看到可读文字，而不是标签） */
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

    // 代码围栏（Markdown / 从 <pre> 转来的内容）
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

    // 表格占位符
    const slot = new RegExp(`^${TABLE_SLOT}(\\d+)${TABLE_SLOT}$`).exec(line);
    if (slot) {
      const t = tables[Number(slot[1])];
      if (t && (t.header.length > 0 || t.rows.length > 0)) {
        blocks.push({ kind: "table", header: t.header, rows: t.rows });
      }
      i += 1;
      continue;
    }

    // Markdown 管道表：本行有竖线且下一行是分隔行
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

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // 标题
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, runs: parseInline(h[2].trim()) });
      i += 1;
      continue;
    }

    // 列表（连续同类项合成一块）
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

    // 段落（单行成段；`<br>` 转换出的哨兵在此切开）
    const parts = line.split(HARD_BREAK).map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      blocks.push({ kind: "paragraph", runs: parseInline(p) });
    }
    i += 1;
  }
  if (fence && codeBuf.length > 0) { blocks.push({ kind: "code", text: codeBuf.join("\n") }); }
  return blocks;
}
