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
import { isOle2, openCfb } from "./cfb.js";

export type DocKind = "docx" | "pptx" | "xlsx";

/** 旧版二进制格式（OLE2 复合文档）—— 与 DocKind 区分，因为解析路径完全不同 */
export type OleKind = "doc" | "xls" | "ppt";

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

/** 旧版格式的扩展名 → 解析种类 */
const OLE_KIND_BY_EXT: Record<string, OleKind> = { ".doc": "doc", ".xls": "xls", ".ppt": "ppt" };

/** 据扩展名判定旧版格式种类（A-1036：现在**能真解析**了，不再只是报错）。 */
export function oleKindFromExt(ext: string): OleKind | null {
  return OLE_KIND_BY_EXT[ext.toLowerCase()] ?? null;
}

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

// ── 旧版二进制（OLE2）：.doc / .xls / .ppt（A-1036）─────────

/** 单字节字符（旧版格式里"压缩"存储的文字就是这一档） */
function latin1(buf: Buffer): string {
  return buf.toString("latin1");
}

/**
 * Word 控制字符 → 可读形态。
 * Word 用 0x07 表示单元格/行结束、0x0D 段落、0x0B 软换行、0x0C 分页，
 * 13/14/15 是域标记（域代码不该出现在正文里）。
 */
function cleanWordText(s: string): string {
  return s
    .replace(/[\x13-\x15]/g, "")
    .replace(/[\x07\x0C\x0B\x0D]/g, (m) => (m === "\x07" ? "\t" : "\n"))
    .replace(/\x01/g, "￼")
    .replace(/[\x00-\x06\x08-\x0A\x0E-\x1F]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** 从 clx（piece table）还原 Word 正文 —— 这是 .doc 的**权威**文本来源 */
function wordTextFromClx(clx: Buffer, wd: Buffer): string {
  let p = 0;
  let plc: Buffer | null = null;
  while (p < clx.length) {
    const marker = clx[p];
    if (marker === 0x01) {                       // Prc：跳过
      if (p + 3 > clx.length) { break; }
      p += 3 + clx.readUInt16LE(p + 1);
      continue;
    }
    if (marker === 0x02) {                       // Pcdt：piece table 本体
      if (p + 5 > clx.length) { break; }
      const lcb = clx.readUInt32LE(p + 1);
      plc = clx.subarray(p + 5, p + 5 + lcb);
      break;
    }
    break;                                        // 未知标记 → 不猜
  }
  if (!plc || plc.length < 4) { return ""; }
  const n = Math.floor((plc.length - 4) / 12);    // 每条 PCD 8B + 一个 CP 4B
  if (n <= 0) { return ""; }
  const cps: number[] = [];
  for (let i = 0; i <= n && (i + 1) * 4 <= plc.length; i += 1) { cps.push(plc.readUInt32LE(i * 4)); }
  const pcdBase = (n + 1) * 4;
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const chars = cps[i + 1] - cps[i];
    if (!Number.isFinite(chars) || chars <= 0) { continue; }
    const fcRaw = plc.readUInt32LE(pcdBase + i * 8 + 2);
    const compressed = (fcRaw & 0x40000000) !== 0;
    if (compressed) {
      const off = (fcRaw & 0x3FFFFFFF) >>> 1;
      parts.push(latin1(wd.subarray(off, off + chars)));
    } else {
      const off = fcRaw & 0x3FFFFFFF;
      parts.push(wd.subarray(off, off + chars * 2).toString("utf16le"));
    }
  }
  return parts.join("");
}

/** 兜底：piece table 不可用时，扫出成串的可打印字符（宁可给一部分，也不给零） */
function salvagePrintable(wd: Buffer): string {
  const s = wd.toString("utf16le");
  const runs: string[] = [];
  let run = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const ok = code >= 0x20 && code !== 0x7f
      && !(code >= 0xd800 && code <= 0xdfff)
      && !(code >= 0xe000 && code <= 0xf8ff);
    if (ok) { run += ch; } else { if (run.length >= 4) { runs.push(run); } run = ""; }
  }
  if (run.length >= 4) { runs.push(run); }
  return runs.join("\n");
}

function extractWordBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const wd = cfb.readStream("WordDocument");
  if (!wd) { throw new Error("不是有效的 .doc：缺少 WordDocument 流"); }
  const info: string[] = [];
  let text = "";
  if (wd.length > 0x01AA) {
    const flags = wd.readUInt16LE(0x000A);
    const tableName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";
    const fcClx = wd.readUInt32LE(0x01A2);
    const lcbClx = wd.readUInt32LE(0x01A6);
    const table = cfb.readStream(tableName) ?? cfb.readStreamLike("Table");
    if (table && lcbClx > 0 && fcClx + lcbClx <= table.length) {
      text = wordTextFromClx(table.subarray(fcClx, fcClx + lcbClx), wd);
      if (text.trim()) { info.push("正文来源：piece table（clx）"); }
    }
  }
  if (!text.trim()) {
    text = salvagePrintable(wd);
    info.push("正文来源：兜底扫描（piece table 未命中，可能非 Word 97 格式）");
  }
  const body = cleanWordText(text);
  const words = body.split(/\s+/).filter(Boolean).length;
  info.unshift(`doc：约 ${words} 个字/词`);
  // ⚠️ 诚实边界（A-1036）：piece table 的 CP/fc 偏移是按 MS-DOC 规范解码的，结构已对着真实
  // 文件逐字段核对过（nFib=193 / fWhichTblStm → 1Table / CPs 与 fc 均合理）。但实测存在
  // **非标准写入器**（WPS / 第三方转换器）产出的 .doc：其 fcMin 起的一段区域并非正文文本，
  // 按 UTF-16 解会得到一串**常用汉字区**的无意义字（编码层面与真文本无法区分，做不了可靠的
  // 自动检测 —— 写了也是假防线）。这里如实标注来源，不假装干净。
  info.push("解析方式：piece table（clx）；若某些段落读起来无意义，多为非标准写入器所致，建议另存为 .docx 后重读");
  return clamp(body, maxChars, info);
}

function extractPptBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const stream = cfb.readStream("PowerPoint Document") ?? cfb.readStreamLike("PowerPoint Document");
  if (!stream) { throw new Error("不是有效的 .ppt：缺少 PowerPoint Document 流"); }
  const texts: string[] = [];
  // PPT 记录：recVer/recInstance(2) + recType(2) + recLen(4) + 数据，线性排布无对齐填充。
  // 文本只有两种原子：TextCharsAtom(UTF-16LE) / TextBytesAtom(单字节)。
  // 线性游走即可命中（容器记录只是"包住"子记录，不会跳过它们）。
  let p = 0;
  while (p + 8 <= stream.length) {
    const recVer = stream.readUInt16LE(p) & 0x000f;
    const recType = stream.readUInt16LE(p + 2);
    const recLen = stream.readUInt32LE(p + 4);
    const start = p + 8;
    if (recLen > stream.length - start) { break; }   // 截断 → 停止，不猜
    if (recType === 0x0fa0) {
      texts.push(stream.subarray(start, start + recLen).toString("utf16le"));
    } else if (recType === 0x0fa8) {
      texts.push(latin1(stream.subarray(start, start + recLen)));
    }
    // ⚠️ recVer=0xF 是**容器**记录：它的 recLen 覆盖全部子记录。
    // 容器必须"进入"（只前进 8 字节头）而不是连同 payload 一起跳过 ——
    // 否则第一个 Document 容器就把整份幻灯片的文本原子全跳掉了（实测 0 个文本块）。
    p = recVer === 0x0f ? start : start + recLen;
  }
  const body = texts
    .map((t) => t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim())
    .filter((t) => t.length > 0)
    .join("\n");
  const info = [`ppt：${texts.length} 个文本块`];
  if (!body) { info.push("未找到文本内容（可能是纯图片幻灯片）"); }
  return clamp(body, maxChars, info);
}

/**
 * BIFF8 记录遍历器（.xls 的单元格与字符串都在这些记录里）。
 * BOUNDSHEET(0x0085) 给工作表名；SST(0x00FC)+CONTINUE(0x003C) 给共享字符串表。
 */
function extractXlsBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const wb = cfb.readStream("Workbook") ?? cfb.readStream("Book") ?? cfb.readStreamLike("Workbook");
  if (!wb) { throw new Error("不是有效的 .xls：缺少 Workbook 流"); }

  const sheets: string[] = [];
  const records: Array<{ type: number; data: Buffer }> = [];
  let p = 0;
  while (p + 4 <= wb.length) {
    const type = wb.readUInt16LE(p);
    const len = wb.readUInt16LE(p + 2);
    const start = p + 4;
    if (len > wb.length - start) { break; }
    const data = wb.subarray(start, start + len);
    if (type === 0x0085 && len >= 8) {                 // BOUNDSHEET：1B 位置 + 1B 隐藏 + 1B 类型 + 名字
      const cch = data[6];
      const grbit = data[7];
      const nameBytes = data.subarray(8, 8 + (grbit & 0x01 ? cch * 2 : cch));
      sheets.push(grbit & 0x01 ? nameBytes.toString("utf16le") : latin1(nameBytes));
    }
    if (type === 0x00fc || type === 0x003c) { records.push({ type, data }); }
    p = start + len;
  }

  const texts: string[] = [];
  const sstBlocks: Buffer[] = [];
  for (const r of records) {
    if (r.type === 0x00fc && sstBlocks.length > 0) { break; }   // 第二张 SST 不再拼
    sstBlocks.push(r.data);
  }
  if (sstBlocks.length > 0) {
    texts.push(...readSstStrings(sstBlocks));
  }

  const info: string[] = [];
  if (sheets.length > 0) { info.push(`工作表：${sheets.join("、")}`); }
  info.push(`共享字符串表：${texts.length} 条`);
  const body = texts
    .map((t) => t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim())
    .filter((t) => t.length > 0)
    .join("\n");
  if (body) { info.push("说明：按字符串首次出现顺序输出，未重建单元格坐标"); }
  return clamp(body, maxChars, info);
}

/**
 * 解析 SST（共享字符串表）。可以跨 CONTINUE 记录，且**跨记录后的字符数据带一个 grbit 字节**
 * （BIFF8 的规定：续块的第一个字节重新声明该串剩余部分的编码）—— 少读这个字节会让后面全串错位。
 * 任何越界一律停止并返回已解析出的部分，不返回半截乱码。
 */
function readSstStrings(blocks: Buffer[]): string[] {
  let bi = 0;
  let off = 0;
  const out: string[] = [];
  const atEnd = (): boolean => bi >= blocks.length;
  const ensure = (n: number): boolean => {
    while (!atEnd() && off >= blocks[bi].length) { bi += 1; off = 0; }
    return !atEnd() && off + n <= blocks[bi].length;
  };
  const u8 = (): number => blocks[bi][off++];
  const u16 = (): number => { const v = blocks[bi].readUInt16LE(off); off += 2; return v; };
  const u32 = (): number => { const v = blocks[bi].readUInt32LE(off); off += 4; return v; };

  if (!ensure(8)) { return out; }
  u32();                                     // cstTotal
  let unique = u32();                        // cstUnique
  if (unique > 100_000) { unique = 100_000; } // 防损坏文件把内存撑爆

  for (let i = 0; i < unique; i += 1) {
    if (!ensure(3)) { break; }
    const cch = u16();
    let grbit = u8();
    let richRuns = 0;
    let extSize = 0;
    if (grbit & 0x08) { if (!ensure(2)) { break; } richRuns = u16(); }
    if (grbit & 0x04) { if (!ensure(4)) { break; } extSize = u32(); }

    let chars = "";
    let remaining = cch;
    while (remaining > 0) {
      const wide = (grbit & 0x01) !== 0;
      const need = wide ? 2 : 1;
      if (!ensure(need)) { remaining = 0; break; }
      const take = Math.min(remaining, Math.floor((blocks[bi].length - off) / need));
      const bytes = blocks[bi].subarray(off, off + take * need);
      off += take * need;
      chars += wide ? bytes.toString("utf16le") : latin1(bytes);
      remaining -= take;
      if (remaining > 0) {
        // 换块：续块首字节是新的 grbit
        bi += 1; off = 0;
        if (atEnd()) { break; }
        grbit = blocks[bi][off];
        off += 1;
      }
    }
    out.push(chars);
    if (richRuns || extSize) {
      // 跳过富文本格式块与扩展块（可能也跨块）
      let skip = richRuns * 4 + extSize;
      while (skip > 0 && !atEnd()) {
        const avail = blocks[bi].length - off;
        if (avail <= 0) { bi += 1; off = 0; continue; }
        const take = Math.min(skip, avail);
        off += take; skip -= take;
      }
    }
  }
  return out;
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
 * 从旧版二进制（OLE2）Office 文档提取文本：.doc / .xls / .ppt（A-1036）。
 *
 * @throws 不是 OLE2 / 缺关键流 / 结构损坏时抛错 —— 由调用方转成给模型看的说明
 */
export function extractOleText(buf: Buffer, kind: OleKind, opts: { maxChars?: number } = {}): DocExtractResult {
  if (!isOle2(buf)) {
    throw new Error(
      "文件不是 OLE2 复合文档（缺少 D0CF11E0 头）。"
      + "若它是新格式，请按 .docx/.xlsx/.pptx 读取；若是 RTF/HTML 等文本格式，请直接当文本读。",
    );
  }
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  switch (kind) {
    case "doc": return extractWordBinary(buf, maxChars);
    case "ppt": return extractPptBinary(buf, maxChars);
    case "xls": return extractXlsBinary(buf, maxChars);
    default: throw new Error(`不支持的旧版格式：${String(kind)}`);
  }
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
