/**
 * core-ts/src/doc_text.ts — Office 文档纯文本提取（docx / pptx / xlsx）。
 *
 * **为什么需要**（A-1034）：这三种格式本质都是 ZIP + XML，`file_read` 直接按 UTF-8 解码
 * 只能吐出一堆 PK 开头的二进制乱码 —— 用户实测「无法阅读 PPT / WORD / EXCEL」，
 * Agent 只能反过来求用户"你把内容贴给我"。这里按容器结构把文本抽出来。
 *
 * 设计取舍：
 * - **带轻结构**，不只是倒文本：docx 保留段落与表格行、pptx 按页分节、xlsx 按表输出网格。
 *   失去结构的信息（"这段属于第几页/第几行"）恰恰是模型最需要用来定位的。
 * - **纯函数 + 只依赖 `./zip.js`**，无外部进程、无原生模块（同 A-1034 的 ZIP 教训）。
 * - 旧版二进制 `.doc/.xls/.ppt` 是 OLE2 复合文档，**不是 ZIP**，这里明确返回"不支持"，
 *   不假装能读、也不吐乱码。
 */

import { isZip, listZip, readZipText, type ZipEntry } from "./zip.js";

export type DocKind = "docx" | "pptx" | "xlsx";

const KIND_BY_EXT: Record<string, DocKind> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  // 宏/模板变体：容器结构相同，直接复用同一套读取
  ".docm": "docx",
  ".dotx": "docx",
  ".pptm": "pptx",
  ".potx": "pptx",
  ".xlsm": "xlsx",
  ".xltx": "xlsx",
};

/** 旧版二进制 Office 格式（OLE2 复合文档）：读不了，必须**说清楚**而不是吐乱码。 */
const LEGACY_BINARY: Record<string, string> = {
  ".doc": "Word 97-2003",
  ".xls": "Excel 97-2003",
  ".ppt": "PowerPoint 97-2003",
};

/** 据扩展名判定文档类型；不是可读文档则返回 null。 */
export function docKindFromExt(ext: string): DocKind | null {
  return KIND_BY_EXT[ext.toLowerCase()] ?? null;
}

/** 旧版二进制格式的显示名（用于给出准确提示）；非旧格式返回 null。 */
export function legacyBinaryName(ext: string): string | null {
  return LEGACY_BINARY[ext.toLowerCase()] ?? null;
}

export interface DocExtractResult {
  text: string;
  /** 结构摘要（页数/表数/尺寸），供调用方拼给模型看 */
  info: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 200_000;

// ── XML 基础 ─────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 取某标签的全部直接文本（含嵌套 run），保留 tab/换行语义。 */
function textOfRuns(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const runs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    runs.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")));
  }
  return runs.join("");
}

/** 把一段 XML 里的软换行/制表符标记还原成字符。 */
function applyBreaks(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<w:cr\b[^>]*\/>/g, "\n");
}

/** 段落块 → 文本（含 run 与软换行）。 */
function paragraphText(paraXml: string, tag = "w:t"): string {
  const withBreaks = applyBreaks(paraXml);
  return textOfRuns(withBreaks, tag);
}

// ── docx ─────────────────────────────────────────────────

function extractDocx(buf: Buffer, entries: ZipEntry[], maxChars: number): DocExtractResult {
  const xml = readZipText(buf, "word/document.xml", entries);
  if (!xml) {
    throw new Error("不是有效的 docx：缺少 word/document.xml");
  }
  const info: string[] = [];

  // 表格先单独渲染成 "a | b | c" 行，并从正文里摘掉，避免被后面的 <w:p> 再处理一遍
  const tables: string[] = [];
  const body = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows: string[] = [];
    const rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tbl)) !== null) {
      const cells: string[] = [];
      const cellRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const paras = [...cm[0].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
          .map((p) => paragraphText(p[1]))
          .filter((t) => t.trim().length > 0);
        cells.push(paras.join(" ").trim());
      }
      rows.push(cells.join(" | "));
    }
    if (rows.length > 0) { tables.push(rows.join("\n")); }
    return "\n";
  });

  const paras = [...body.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((p) => paragraphText(p[1]));

  const paragraphs = paras.filter((t, i) => t.trim().length > 0 || (i > 0 && paras[i - 1].trim().length > 0));
  const chunks: string[] = [];
  if (paragraphs.length > 0) { chunks.push(paragraphs.join("\n")); }
  if (tables.length > 0) { chunks.push(`\n[表格 ${tables.length} 个]\n${tables.join("\n\n")}`); }
  info.push(`docx：${paragraphs.length} 段`, `表格 ${tables.length} 个`);

  return clamp(chunks.join("\n\n"), maxChars, info);
}

// ── pptx ─────────────────────────────────────────────────

function extractPptx(buf: Buffer, entries: ZipEntry[], maxChars: number): DocExtractResult {
  const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/;
  const slides = entries
    .map((e) => ({ e, n: Number(slideRe.exec(e.name)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);
  if (slides.length === 0) {
    throw new Error("不是有效的 pptx：找不到 ppt/slides/slideN.xml");
  }
  const parts: string[] = [];
  for (const { e, n } of slides) {
    const xml = readZipText(buf, e.name, entries);
    if (!xml) { continue; }
    const lines = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((p) => textOfRuns(p[1], "a:t").trim())
      .filter((t) => t.length > 0);
    parts.push(`--- 第 ${n} 页 ---\n${lines.join("\n")}`);
  }
  const notes = entries.filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.name)).length;
  const info = [`pptx：${slides.length} 页`];
  if (notes > 0) { info.push(`含备注页 ${notes} 个（未展开）`); }
  return clamp(parts.join("\n\n"), maxChars, info);
}

// ── xlsx ─────────────────────────────────────────────────

/** A1 → { col: 0, row: 0 }（列号十进制解析，AA=26）。 */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) { return null; }
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function colName(idx: number): string {
  let s = "";
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** sharedStrings.xml → 字符串表（`<si>` 可能含多个 `<t>` 组成富文本）。 */
function parseSharedStrings(buf: Buffer, entries: ZipEntry[]): string[] {
  const xml = readZipText(buf, "xl/sharedStrings.xml", entries);
  if (!xml) { return []; }
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    out.push(textOfRuns(m[1], "t"));
  }
  return out;
}

/** workbook.xml + rels → sheet 名与目标文件的有序对应。 */
function parseSheetOrder(buf: Buffer, entries: ZipEntry[]): Array<{ name: string; target: string }> {
  const wb = readZipText(buf, "xl/workbook.xml", entries);
  const rels = readZipText(buf, "xl/_rels/workbook.xml.rels", entries);
  const out: Array<{ name: string; target: string }> = [];
  if (wb && rels) {
    const relMap = new Map<string, string>();
    const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(rels)) !== null) {
      relMap.set(rm[1], rm[2].replace(/^\/?(xl\/)?/, ""));
    }
    const shRe = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = shRe.exec(wb)) !== null) {
      const target = relMap.get(sm[2]);
      if (target) {
        const full = target.startsWith("worksheets/") ? `xl/${target}` : `xl/${target}`;
        out.push({ name: decodeEntities(sm[1]), target: full });
      }
    }
  }
  if (out.length > 0) { return out; }
  // 兜底：找不到 workbook/rels 就按 sheetN.xml 顺序来
  return entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((e, i) => ({ name: `Sheet${i + 1}`, target: e.name }));
}

const XLSX_MAX_COLS = 64;
const XLSX_MAX_ROWS = 2000;

function extractXlsx(buf: Buffer, entries: ZipEntry[], maxChars: number): DocExtractResult {
  const shared = parseSharedStrings(buf, entries);
  const sheets = parseSheetOrder(buf, entries);
  if (sheets.length === 0) {
    throw new Error("不是有效的 xlsx：找不到任何 xl/worksheets/sheetN.xml");
  }
  const info: string[] = [`xlsx：${sheets.length} 张表`];
  const blocks: string[] = [];

  for (const sheet of sheets) {
    const xml = readZipText(buf, sheet.target, entries);
    if (!xml) { continue; }
    const rows: string[][] = [];
    let maxCol = 0;
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(xml)) !== null && rows.length < XLSX_MAX_ROWS) {
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[0])) !== null) {
        const attrs = cm[1];
        const body = cm[2];
        const ref = /r="([A-Z]+\d+)"/i.exec(attrs)?.[1] ?? "";
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
        let value = "";
        if (type === "s") {
          const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
          value = shared[idx] ?? "";
        } else if (type === "inlineStr") {
          value = textOfRuns(body, "t");
        } else {
          value = decodeEntities((/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "").trim());
        }
        const pos = parseCellRef(ref);
        const col = pos ? pos.col : cells.length;
        if (col < XLSX_MAX_COLS) {
          while (cells.length < col) { cells.push(""); }
          cells[col] = value;
          if (col + 1 > maxCol) { maxCol = col + 1; }
        }
      }
      if (cells.some((c) => c.trim().length > 0)) { rows.push(cells); }
    }
    if (rows.length === 0) { continue; }
    const header = Array.from({ length: maxCol }, (_, i) => colName(i)).join(" | ");
    const body = rows.map((r) => {
      const padded = [...r];
      while (padded.length < maxCol) { padded.push(""); }
      return padded.join(" | ");
    });
    info.push(`「${sheet.name}」${rows.length} 行 × ${maxCol} 列`);
    blocks.push(`## 表：${sheet.name}\n${header}\n${body.join("\n")}`);
  }

  return clamp(blocks.join("\n\n"), maxChars, info);
}

// ── 统一入口 ──────────────────────────────────────────────

function clamp(text: string, maxChars: number, info: string[]): DocExtractResult {
  if (text.length <= maxChars) { return { text, info, truncated: false }; }
  return {
    text: `${text.slice(0, maxChars)}\n\n……[已截断：文档文本超过 ${maxChars} 字符，仅显示前一部分]……`,
    info,
    truncated: true,
  };
}

/**
 * 从 Office 文档字节提取文本。
 *
 * @param buf 文档原始字节（调用方负责读盘）
 * @param kind docKindFromExt 的结果
 * @throws 容器不是 ZIP / 缺关键部件 / 压缩方式不支持时抛错 —— 由调用方转成给模型看的说明
 */
export function extractDocText(buf: Buffer, kind: DocKind, opts: { maxChars?: number } = {}): DocExtractResult {
  if (!isZip(buf)) {
    throw new Error(
      "文件不是有效的 Office 2007+ 文档（缺少 ZIP 容器头）。"
      + "若它是 .doc/.xls/.ppt 另存为的新格式，请重新导出为 docx/xlsx/pptx。",
    );
  }
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const entries = listZip(buf);
  switch (kind) {
    case "docx": return extractDocx(buf, entries, maxChars);
    case "pptx": return extractPptx(buf, entries, maxChars);
    case "xlsx": return extractXlsx(buf, entries, maxChars);
    default: throw new Error(`不支持的文档类型：${String(kind)}`);
  }
}
