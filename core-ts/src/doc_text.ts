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
/* A-1133：PDF 抽取与 OOXML **不是同一族**（既不是 ZIP 也不是 OLE），按"一类格式一个解析器"
   放在同级模块里；本文件只负责**派发**（唯一产地：`docKindFromExt` 决定走哪条）。 */
import { extractPdfText } from "./pdf_text.js";

/** 可读文档的种类。`pdf` 与 OOXML 的解析路径完全不同（见 `pdf_text.ts` 的上限说明）。 */
export type DocKind = "docx" | "pptx" | "xlsx" | "pdf";

/** 旧版二进制格式（OLE2 复合文档）—— 与 DocKind 区分，因为解析路径完全不同 */
export type OleKind = "doc" | "xls" | "ppt";

const KIND_BY_EXT: Record<string, DocKind> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  /* A-1133：PDF 走独立解析器（`pdf_text.ts`）。放在这里是为了让**所有调用方**
     （`file_read` 工具、主进程文档通道）自动获得 PDF 读取能力，而不必各自再判一次扩展名。 */
  ".pdf": "pdf",
  // 宏/模板变体：容器结构相同，直接复用同一套读取
  ".docm": "docx",
  ".dotx": "docx",
  ".pptm": "pptx",
  ".potx": "pptx",
  ".xlsm": "xlsx",
  ".xltx": "xlsx",
};

/** 旧版二进制 Office 格式（OLE2 复合文档）：容器结构相同，**同一套 OLE 解析器全都能读**。 */
const LEGACY_BINARY: Record<string, string> = {
  ".doc": "Word 97-2003",
  ".xls": "Excel 97-2003",
  ".ppt": "PowerPoint 97-2003",
  /* A-1133：同族的**模板 / 放映**变体。用户要求「所有 Office 办公文件全给我做一遍适配」，
     它们与上三个是同一个 OLE2 容器、同一批流名（WordDocument / Workbook / PowerPoint Document）
     ⇒ 复用同一解析器即可，**不需要**新代码；但**必须**在这里登记，否则会被当成未知类型拒收。 */
  ".dot": "Word 97-2003 模板",
  ".xlt": "Excel 97-2003 模板",
  ".pot": "PowerPoint 97-2003 模板",
  ".pps": "PowerPoint 97-2003 放映",
};

/** 旧版格式的扩展名 → 解析种类（同容器同流名的变体一律复用同一解析路径） */
const OLE_KIND_BY_EXT: Record<string, OleKind> = {
  ".doc": "doc", ".dot": "doc",
  ".xls": "xls", ".xlt": "xls",
  ".ppt": "ppt", ".pot": "ppt", ".pps": "ppt",
};

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
    parts.push(`${pptPageMarker(n)}\n${lines.join("\n")}`);
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
 *
 * ⚠️ **导出是为了能单测**（`tests/core-ts/a1036-guards.spec.ts`）—— 这里的正则顺序**很容易写坏**
 *    而且坏了之后**看起来完全正常**（见下），只能靠用例钉死。
 *
 * ## 2026-09-28 实测的 bug：换行被**自己的下一句**抹掉
 * 旧第 4 行写的是 `[\x00-\x06\x08-\x0A\x0E-\x1F]` —— 那个 `\x08-\x0A` **含 `\x09`(Tab) 与 `\x0A`(LF)**，
 * 而 `\t` / `\n` 正是**上一行刚刚生成**的（`\x07`→`\t`、`\x0D`→`\n`）。
 * ⇒ 段落标记先被翻译成换行、紧接着又被当"控制字符"清掉。
 * 症状（真实文件 `EDA第九组实验一报告.doc` 实测）：全篇 `\n = 0`、`\r = 0`，
 * **3623 字挤成一块**，网页上是一大坨没有换行的文字（= 用户说的「连正常换行都不会」）。
 * ⚠️ 危险之处：它**不报错、不吐乱码**（文本一个字都没少），只是结构静默消失。
 * ⇒ 判据必须断言"**换行真的在**"，不能只断言"含某个词"。
 */
export function cleanWordText(s: string): string {
  return s
    .replace(/[\x13-\x15]/g, "")
    .replace(/[\x07\x0C\x0B\x0D]/g, (m) => (m === "\x07" ? "\t" : "\n"))
    .replace(/\x01/g, "￼")
    /* ⚠️ 范围**必须**排除 `\x09`(Tab) 与 `\x0A`(LF)：它们是上一行的产物。
       清掉它们 = 把刚生成的换行/制表又抹掉（上面的 bug 就是这么来的）。 */
    .replace(/[\x00-\x06\x08\x0E-\x1F]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 一段文本像不像**真实的中文正文**（用于识别"piece table 指向了垃圾区"）。
 *
 * ## 为什么这个判据成立（2026-09-29 实测得出，不是拍脑袋）
 * 真实中文有极强的**用字集中性**：一篇几千字的文章通常只用到 300~800 个不同汉字，
 * 且大量字符落在高频区（`的是在不了和有我…`）。而"把随机/加密字节按 UTF-16 解"得到的
 * **伪汉字**恰好相反 —— 它均匀散落在 CJK 统一区的天文数字个码点上，几乎**每个字都不重复**。
 * ## 阈值从哪来（2026-09-29 实测，`_diag-doc-ratio.mjs` 逐段量出，两支分离清晰）
 * ```
 *   正常中文段   实验一 熟悉Quartus II… : n=9023  r=0.123   ← 最长、最典型
 *   （去重率低） EDA第九组实验一报告    : n=1024  r=0.390 / n=1004 r=0.319 / n=1758 r=0.298
 *                专题3总结（可读段）    : n=1711  r=0.357
 *   ───────────────────────────────── 0.40 ~ 0.65 空档 ─────────────────────────────
 *   损坏段       专题3总结（垃圾段）    : n=1984  r=0.661   ← 伪汉字
 * ```
 * ⇒ **阈值取 0.55**：距正常段上界 0.390 有 0.16 余量，距损坏段下界 0.661 有 0.11 余量，
 *   落在两支之间的空档中部。
 * ⚠️ **首版取 0.75 是错的**（依据只有一段 120 字的样本，代表性差 ⇒ 真实损坏段 0.661 打不穿它，
 *   守卫/探针在该报的时候**不报**）。教训：**阈值必须由"全体样本的实测分布"定，不能用单点样本**。
 *
 * ⚠️ 只对**足够长的**样本判定（< 80 字时统计无意义，宁可放行）：短句可以是任意组合。
 * ⚠️ 这是**启发式**，不是规范判据 —— 所以它的用途是「标出来、别让 Agent 当真」，
 *    **不是**丢数据（真实文本被误判也只是多一句提示，代价可控；反之代价是把垃圾喂给模型）。
 */
export const FAKE_TEXT_DEDUP_RATIO = 0.55;

export function looksLikeRealText(s: string): boolean {
  const chars = Array.from(s).filter((c) => {
    const v = c.codePointAt(0) ?? 0;
    /* 只统计"有信息量"的字符：CJK 统一区 + 常用标点/字母数字。空白与 ASCII 噪声不参与。 */
    return (v >= 0x4e00 && v <= 0x9fff) || (v >= 0x3040 && v <= 0x30ff) || (v >= 0xac00 && v <= 0xd7af);
  });
  if (chars.length < 80) { return true; }        // 太短 ⇒ 不下结论（放行）
  const unique = new Set(chars).size;
  return unique / chars.length < FAKE_TEXT_DEDUP_RATIO;   // 去重率 ≥ 阈值 ⇒ 判定为伪文本
}

/**
 * 从 clx（piece table）还原 Word 正文 —— 这是 .doc 的**权威**文本来源。
 *
 * ⚠️ 返回**逐段**结果（不是拼好的字符串）：piece table 的每一段可以各自损坏
 * （实测 `专题3总结_*.doc`：第 0 段 1984 字全是伪汉字、第 1 段 1711 字完全正常）。
 * 拼在一起会得到"看起来有 3695 字的正文"，其中 54% 是垃圾 —— **对 Agent 比读不到更坏**
 * （模型会把伪汉字当真去总结）。⇒ 由调用方按段判质、丢掉垃圾段并**如实报告**。
 */
function wordPiecesFromClx(clx: Buffer, wd: Buffer): { text: string; bad: number } {
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
  if (!plc || plc.length < 4) { return { text: "", bad: 0 }; }
  const n = Math.floor((plc.length - 4) / 12);    // 每条 PCD 8B + 一个 CP 4B
  if (n <= 0) { return { text: "", bad: 0 }; }
  const cps: number[] = [];
  for (let i = 0; i <= n && (i + 1) * 4 <= plc.length; i += 1) { cps.push(plc.readUInt32LE(i * 4)); }
  const pcdBase = (n + 1) * 4;
  const parts: string[] = [];
  let bad = 0;
  for (let i = 0; i < n; i += 1) {
    const chars = cps[i + 1] - cps[i];
    if (!Number.isFinite(chars) || chars <= 0) { continue; }
    const fcRaw = plc.readUInt32LE(pcdBase + i * 8 + 2);
    const compressed = (fcRaw & 0x40000000) !== 0;
    let seg: string;
    if (compressed) {
      const off = (fcRaw & 0x3FFFFFFF) >>> 1;
      seg = latin1(wd.subarray(off, off + chars));
    } else {
      const off = fcRaw & 0x3FFFFFFF;
      seg = wd.subarray(off, off + chars * 2).toString("utf16le");
    }
    /* ⚠️ 逐段判质：伪汉字段**丢掉**并计数（不许拼进去）。压缩段（latin1）不判 —— 那是单字节
       西文/ANSI，用字集中性判据不适用（它的"重复率"天然低），误杀风险大于收益。 */
    if (!compressed && !looksLikeRealText(seg)) { bad += 1; continue; }
    parts.push(seg);
  }
  return { text: parts.join(""), bad };
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

/** MS-DOC 2.5.1 `FibBase.wIdent` 的规范值 —— **唯一产地**（.doc 与 .dot 共用）。 */
export const DOC_WIDENT = 0xa5ec;

/**
 * 校验 `WordDocument` 流的 FIB 头（**纯函数**，从 `extractWordBinary` 里提出来以便**行为级**单测）。
 *
 * 为什么要单独提出：这条判据原先内联在 `extractWordBinary` 里，只能靠"源码里有没有那段文本"来守 ——
 * 而**文本断言对「改条件」是瞎的**（铁律 3）：把 `if ((flags & 0x0100) !== 0)` 改成 `if (false)`，
 * 那行注释与常量一字未动，`toContain` 照样绿。提成函数后，守卫可以直接喂合成 FIB 进去、断言它**抛错**。
 *
 * @param wd `WordDocument` 流的字节
 * @throws 结构不合法或加密时抛错（错误信息面向用户，含可操作出路）
 */
export function validateDocFib(wd: Buffer): void {
  /* ⚠️⚠️ **先验 `wIdent`（2026-09-29，A-1136 阶段 C 时定位）**：
     MS-DOC 2.5.1 规定 `FibBase.wIdent` **必须是 0xA5EC**；不是它 = 这个流根本不是 Word 的 FIB。
     为什么这条必须挡在最前面：真实样本 `专题3总结_*.doc` 的 `wIdent=0xCFD0`、`nFib=57361`（都是
     不可能的取值），**却恰好**在 0x01A2/0x01A6 处有"看起来合理"的 fcClx/lcbClx，于是旧代码按
     piece table 解出了一段**编码层面完全合法、语义上纯属垃圾**的常用汉字（"任悍牙箱颖抛吓垒桩…"）。
     这种失败**最坏**：不是报错，而是**给 Agent 一堆像模像样的假正文**（模型会当真去总结），
     而用户看到的是一份"读出来全是乱码"的文档 —— 两边都被误导。
     ⇒ 结构不合法就**明确报错**（下面 `salvagePrintable` 都不走），让它诚实失败。
     ⚠️ 这也解释了为什么"兜底扫描"不能作为常规路径：它对合法结构才成立，对伪造结构只会产垃圾。
     ⚠️ 相关位域（MS-DOC 2.5.1 `fibBase.flags`，权威来源 Microsoft Learn / PRONOM fmt/754）：
        `fComplex`=bit2(0x04)｜`fEncrypted`=bit8(0x0100)｜`fWhichTblStm`=bit9(0x0200)｜`fObfuscated`=bit15(0x8000)。 */
  if (wd.length < 32) { throw new Error("不是有效的 .doc：WordDocument 流过短（读不到 FIB 头）"); }
  const wIdent = wd.readUInt16LE(0x0000);
  if (wIdent !== DOC_WIDENT) {
    throw new Error(
      `不是有效的 .doc：FIB 标识 wIdent=0x${wIdent.toString(16).toUpperCase().padStart(4, "0")}`
      + `（应为 0x${DOC_WIDENT.toString(16).toUpperCase()}）。`
      + "这个文件的正文结构已损坏或不是 Word 文档（常见于第三方工具异常导出的 .doc）"
      + "——请用系统程序打开确认，或另存为 .docx 后重读。",
    );
  }
  const flags = wd.readUInt16LE(0x000A);
  /* ⚠️ 加密文档：正文在磁盘上是密文，按明文解只会得到垃圾 ⇒ 如实拒绝（并给可操作出路）。
     `fEncrypted`=bit8；`fObfuscated`=bit15 是 XOR 混淆（RC4 之外的旧式口令保护）。
     两者都为真时必须报错 —— 这是**规范明确**的判据，不是启发式。 */
  if ((flags & 0x0100) !== 0 || (flags & 0x8000) !== 0) {
    throw new Error(
      "这份 .doc 是**加密文档**（FIB 标记 fEncrypted=1），正文以密文存储，无法直接提取。"
      + "请先用 Word/WPS 打开并输入口令，再另存为 .docx 后重读。",
    );
  }
}

function extractWordBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const wd = cfb.readStream("WordDocument");
  if (!wd) { throw new Error("不是有效的 .doc：缺少 WordDocument 流"); }
  /* ⚠️ FIB 头的三道规范判据（wIdent / fEncrypted / fObfuscated）已提到 `validateDocFib`：
     既保证唯一产地，又让守卫能**喂合成字节直接验行为**（而不是断言"源码里有没有这段文本"）。 */
  validateDocFib(wd);
  const flags = wd.readUInt16LE(0x000A);
  const info: string[] = [];
  let text = "";
  let badPieces = 0;
  if (wd.length > 0x01AA) {
    const tableName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";
    const fcClx = wd.readUInt32LE(0x01A2);
    const lcbClx = wd.readUInt32LE(0x01A6);
    const table = cfb.readStream(tableName) ?? cfb.readStreamLike("Table");
    if (table && lcbClx > 0 && fcClx + lcbClx <= table.length) {
      const got = wordPiecesFromClx(table.subarray(fcClx, fcClx + lcbClx), wd);
      text = got.text;
      badPieces = got.bad;
      if (text.trim()) { info.push("正文来源：piece table（clx）"); }
      /* ⚠️ 有段被判为伪文本 ⇒ **必须说出来**（这是用户与 Agent 都会看到的"信息完整性"交代）。
         不说的话，用户会以为"这份文档本来就这么少内容"，Agent 会基于残缺内容给结论。 */
      if (badPieces > 0) {
        info.push(
          `⚠️ 有 ${badPieces} 段内容无法还原（该段在文件里已损坏，读出来是无意义字符），已**跳过**`
          + "以免把垃圾当成正文。建议用 Word/WPS 打开另存为 .docx 后重读，以取得完整内容。",
        );
      }
    }
  }
  if (!text.trim()) {
    text = salvagePrintable(wd);
    info.push("正文来源：兜底扫描（piece table 未命中，可能非 Word 97 格式）");
  }
  const body = cleanWordText(text);
  const words = body.split(/\s+/).filter(Boolean).length;
  info.unshift(`doc：约 ${words} 个字/词`);
  /* ⚠️ 诚实边界（A-1036；2026-09-29 A-1136 阶段 C 修正为**有判据**）：
     过去这里写的是"伪汉字没法自动检测，写了也是假防线"。**这个判断是错的** ——
     真实中文有极强的用字集中性（几千字只用几百个不同汉字），把随机字节按 UTF-16 解出来的
     伪汉字则几乎字字不同。判据 = **去重率**（`looksLikeRealText`），实测能把损坏段干净摘出来。
     ⇒ 现在三层防线，缺一不可：
        ① `wIdent === 0xA5EC`  —— 规范判据，挡"根本不是 Word 的流"；
        ② `fEncrypted`         —— 规范判据，挡"正文是密文"；
        ③ 逐段去重率           —— 启发式，挡"piece table 指向垃圾区"（把垃圾段丢掉并计数上报）。 */
  info.push("解析方式：piece table（clx）；若仍有段落读起来无意义，建议另存为 .docx 后重读");
  return clamp(body, maxChars, info);
}

/** PPT 记录类型（MS-PPT 2.1.2）：我们只关心"哪些容器算幻灯片正文" */
const PPT_RT_SLIDE = 0x03ee;          // Slide：真正的幻灯片页
const PPT_RT_NOTES = 0x03f0;          // Notes：备注页（讲稿）
const PPT_RT_TEXT_CHARS = 0x0fa0;     // TextCharsAtom（UTF-16LE）
const PPT_RT_TEXT_BYTES = 0x0fa8;     // TextBytesAtom（单字节）

/**
 * 页标记 —— **唯一产地**。`gui/renderer/pages/docView.ts` 的 `PAGE_RE` 就是认这个形状建页卡片的，
 * pptx（`ppt/slides/slideN.xml`，n 取文件名编号）与老版 .ppt（顺序号）**两族共用同一形状**。
 * ⚠️ 改这里的格式必须同步 `docView.ts::PAGE_RE`（有守卫：`tests/gui/a1133-doc-view.spec.ts`）。
 */
export function pptPageMarker(n: number): string {
  return `--- 第 ${n} 页 ---`;
}

export interface PptSlideScan {
  /** 每页的文本行；下标 = 页码 - 1。**空数组 = 该页没有文字**（纯图片页），页数照记 */
  pages: string[][];
  /** 进了正文的文本原子数 */
  slideAtoms: number;
  /** 被排除的原子数（母版 / 版式 / 备注 / 其他容器） */
  excludedAtoms: number;
  /** 备注页容器个数 */
  notesPages: number;
}

/**
 * 扫一遍 `PowerPoint Document` 流，**只**收 `Slide` 容器里的文本原子，并按 Slide 顺序分页。
 *
 * ## ⚠️ 2026-09-28 用户截图打回（"PPT 甚至连内容都没有"）—— 两个叠加的错
 * 旧实现**线性收集流里全部** TextCharsAtom/TextBytesAtom，**不区分容器**。用真实文件
 * `jeny_第二章.ppt`（6.1MB）实测 837 个文本原子，按祖先链分布是：
 *   · `Slide`  容器内 **618** 个 ← 真正的课程正文（「数字信号处理」「引言」「设 是以N为周期的…」）
 *   · `Notes`  容器内 **167** 个 ← 样例正是「单击此处编辑母版文本样式\r第二级\r第三级…」
 *   · `MainMaster` 容器内 **52** 个 ← 「单击此处编辑母版标题样式」
 * ⇒ 旧实现把 **219 个母版/备注占位符原子**掺进正文，而且按**流的物理顺序**拼 ⇒ 排在正文之前，
 *   用户看到的第一屏全是「单击此处编辑母版标题样式」——**真正的课程内容被淹没**。
 *
 * ## 修法（三条都是结构性的）
 * 1. **只取 `Slide` 容器内的原子**（母版是设计模板、备注是讲稿，都不是"幻灯片上的字"）；
 * 2. **按 Slide 出现顺序分页** ⇒ 顺带修掉"物理顺序 ≠ 页码顺序"这个真实的顺序错误；
 * 3. **不静默丢弃**：被排除的原子数如实返回（见 `PptSlideScan`）。
 *
 * ⚠️ 本函数是**纯函数**（吃流字节、吐结构），所以能用**手工拼的合成流**单测 ——
 *    不必依赖任何真实 .ppt 文件（`tests/core-ts/a1133-ppt-slides.spec.ts`）。
 */
export function collectPptSlides(stream: Buffer): PptSlideScan {
  const pages: string[][] = [];
  const stack: Array<{ type: number; end: number }> = [];
  let slideAtoms = 0;
  let excludedAtoms = 0;
  let notesPages = 0;

  let p = 0;
  while (p + 8 <= stream.length) {
    const recVer = stream.readUInt16LE(p) & 0x000f;
    const recType = stream.readUInt16LE(p + 2);
    const recLen = stream.readUInt32LE(p + 4);
    const start = p + 8;
    if (recLen > stream.length - start) { break; }   // 截断 → 停止，不猜
    while (stack.length > 0 && p >= stack[stack.length - 1].end) { stack.pop(); }
    if (recVer === 0x0f) {
      /* ⚠️ 容器记录：recLen 覆盖全部子记录 ⇒ 只前进 8 字节"进入"，不能连同 payload 跳过
         （否则第一个 `Document` 容器就把整份幻灯片的文本原子全跳掉 —— 实测 0 个文本块）。 */
      stack.push({ type: recType, end: start + recLen });
      if (recType === PPT_RT_SLIDE) { pages.push([]); }
      else if (recType === PPT_RT_NOTES) { notesPages += 1; }
    } else if (recType === PPT_RT_TEXT_CHARS || recType === PPT_RT_TEXT_BYTES) {
      const onSlide = stack.some((s) => s.type === PPT_RT_SLIDE);
      if (!onSlide) {
        /* ⚠️ 一律计数（不许静默丢弃）：用户发现少了内容时，这个数字是唯一的诊断线索。 */
        excludedAtoms += 1;
      } else {
        slideAtoms += 1;
        const raw = recType === PPT_RT_TEXT_CHARS
          ? stream.subarray(start, start + recLen).toString("utf16le")
          : latin1(stream.subarray(start, start + recLen));
        const t = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
        if (t) { pages[pages.length - 1].push(t); }
      }
    }
    p = recVer === 0x0f ? start : start + recLen;
  }
  return { pages, slideAtoms, excludedAtoms, notesPages };
}

/**
 * 老版 .ppt（OLE2）文本抽取 = 打开 CFB → 扫 `PowerPoint Document` 流 → 按页拼结构。
 * 判据全在 `collectPptSlides`（纯函数、可单测）；这里只做"取流 + 拼文本 + 报统计"。
 *
 * ⚠️ 边界：纯图片幻灯片（无任何文本原子）会产出一张**空页卡片** —— 这是**故意的**：
 *    "这一页存在但没有文字"本身就是信息（对齐 pptx 分支"页数照报"的口径）。
 */
function extractPptBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const stream = cfb.readStream("PowerPoint Document") ?? cfb.readStreamLike("PowerPoint Document");
  if (!stream) { throw new Error("不是有效的 .ppt：缺少 PowerPoint Document 流"); }
  const scan = collectPptSlides(stream);
  /* 页标记形状必须与 pptx 分支一致（`--- 第 N 页 ---`）—— 下游 `docView.buildDocView`
     就是认这个标记建页卡片的（一处判据，两族共用）。 */
  const body = scan.pages.map((lines, i) => `${pptPageMarker(i + 1)}\n${lines.join("\n")}`).join("\n\n");
  const info = [`ppt：${scan.pages.length} 页`, `正文文本块 ${scan.slideAtoms} 个`];
  if (scan.excludedAtoms > 0) { info.push(`已排除母版/备注占位符 ${scan.excludedAtoms} 个`); }
  if (scan.notesPages > 0) { info.push(`含备注页 ${scan.notesPages} 个（未展开）`); }   // 口径对齐 extractPptx
  if (scan.slideAtoms === 0) { info.push("未找到文本内容（可能是纯图片幻灯片）"); }
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

  // 一遍记录扫描：收 BOUNDSHEET（表名 + 该表在流中的起始偏移）与全部记录
  const recs: Array<{ type: number; data: Buffer; off: number }> = [];
  const bounds: Array<{ name: string; pos: number }> = [];
  const sstBlocks: Buffer[] = [];
  let p = 0;
  while (p + 4 <= wb.length) {
    const type = wb.readUInt16LE(p);
    const len = wb.readUInt16LE(p + 2);
    const start = p + 4;
    if (len > wb.length - start) { break; }
    const data = wb.subarray(start, start + len);
    recs.push({ type, data, off: p });
    if (type === 0x0085 && len >= 8) {
      // BOUNDSHEET：lbPlyPos(4) + grbit(2) + cch(1) + grbit(1) + 名字
      const cch = data[6];
      const nameGrbit = data[7];
      const nb = data.subarray(8, 8 + (nameGrbit & 0x01 ? cch * 2 : cch));
      bounds.push({
        name: nameGrbit & 0x01 ? nb.toString("utf16le") : latin1(nb),
        pos: data.readUInt32LE(0),
      });
    }
    if (type === 0x00fc || type === 0x003c) { sstBlocks.push(data); }
    p = start + len;
  }
  const sst = sstBlocks.length > 0 ? readSstStrings(sstBlocks) : [];

  // 每张表的记录区间：按 BOUNDSHEET 的流偏移升序切换（A-1036：数值单元格此前完全拿不到 ——
  // 只抽 SST 的话，一张全是数字的表读出来几乎是空的）
  const ordered = [...bounds].sort((a, b) => a.pos - b.pos);
  const sheetNameAt = (off: number): string => {
    let name = "";
    for (const b of ordered) { if (off >= b.pos) { name = b.name; } else { break; } }
    return name || "Sheet1";
  };
  const grids = new Map<string, Map<number, Map<number, string>>>();
  const put = (sheet: string, row: number, col: number, value: string): void => {
    if (value === "" || row >= XLSX_MAX_ROWS || col >= XLSX_MAX_COLS) { return; }
    let g = grids.get(sheet);
    if (!g) { g = new Map(); grids.set(sheet, g); }
    let r = g.get(row);
    if (!r) { r = new Map(); g.set(row, r); }
    r.set(col, value);
  };

  for (const rec of recs) {
    const d = rec.data;
    const sheet = sheetNameAt(rec.off);
    switch (rec.type) {
      case 0x00fd: {                       // LABELSST：指向共享字符串表
        if (d.length < 10) { break; }
        const isst = d.readUInt32LE(6);
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), sst[isst] ?? "");
        break;
      }
      case 0x0204: {                       // LABEL：内联字符串
        if (d.length < 8) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), biffString(d, 6));
        break;
      }
      case 0x0203: {                       // NUMBER：8 字节 IEEE 双精度
        if (d.length < 14) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(d.readDoubleLE(6)));
        break;
      }
      case 0x027e: {                       // RK：压缩数值
        if (d.length < 10) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(rkToNumber(d.readUInt32LE(6))));
        break;
      }
      case 0x00bd: {                       // MULRK：一行里连续多个 RK
        if (d.length < 6) { break; }
        const row = d.readUInt16LE(0);
        const colFirst = d.readUInt16LE(2);
        const n = Math.floor((d.length - 6) / 6);
        for (let k = 0; k < n; k += 1) {
          put(sheet, row, colFirst + k, fmtNum(rkToNumber(d.readUInt32LE(4 + k * 6 + 2))));
        }
        break;
      }
      case 0x0006: {                       // FORMULA：只取**数值型**缓存结果
        if (d.length < 14) { break; }
        // 结果字节 6..13；0xFFFF 开头的不是数字（字符串/布尔/错误/空）→ 跳过
        if (d[6] === 0xff && d[7] === 0xff) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(d.readDoubleLE(6)));
        break;
      }
      default:
        break;
    }
  }

  const info: string[] = [];
  const blocks: string[] = [];
  for (const [name, g] of grids) {
    if (g.size === 0) { continue; }
    const rows = [...g.keys()].sort((a, b) => a - b);
    let maxCol = 0;
    for (const r of g.values()) { for (const c of r.keys()) { if (c + 1 > maxCol) { maxCol = c + 1; } } }
    const header = Array.from({ length: maxCol }, (_, i) => colName(i)).join(" | ");
    const body = rows.map((ri) => {
      const r = g.get(ri) ?? new Map<number, string>();
      const cells = Array.from({ length: maxCol }, (_, ci) => r.get(ci) ?? "");
      return `${ri + 1}\t${cells.join(" | ")}`.trimEnd();
    });
    info.push(`「${name}」${rows.length} 行 × ${maxCol} 列`);
    blocks.push(`## 表：${name}\n行号\t${header}\n${body.join("\n")}`);
  }

  if (blocks.length > 0) {
    info.unshift(`xls：${[...grids.keys()].length} 张有内容的表`);
    if (blocks.length < bounds.length && bounds.length > 0) {
      info.push(`另有 ${bounds.length - blocks.length} 张空表未列出`);
    }
    return clamp(blocks.join("\n\n"), maxChars, info);
  }

  // 没有解析出任何单元格 → 退回共享字符串表（图表页等特殊结构仍能拿到文字）
  const texts = sst.map((t) => t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim()).filter(Boolean);
  const names = bounds.length > 0 ? `工作表：${bounds.map((b) => b.name).join("、")}` : "未取到工作表名";
  info.push(names, `回退：仅共享字符串表 ${texts.length} 条（未解析出单元格，可能是图表页）`);
  return clamp(texts.join("\n"), maxChars, info);
}

/** BIFF 的 XLUnicodeString（cch + grbit + 字符） */
function biffString(d: Buffer, at: number): string {
  if (at + 3 > d.length) { return ""; }
  const cch = d.readUInt16LE(at);
  const wide = (d[at + 2] & 0x01) !== 0;
  const start = at + 3;
  const need = cch * (wide ? 2 : 1);
  if (start + need > d.length) { return ""; }
  return wide ? d.subarray(start, start + need).toString("utf16le") : latin1(d.subarray(start, start + need));
}

/**
 * BIFF 的 RK 数值编码（把 8 字节 double 压缩到 4 字节的常见情形）。
 * 位 0 = 是否除以 100；位 1 = 是否整数（30 位有符号）；否则低 30 位是 double 的高 4 字节。
 */
function rkToNumber(rk: number): number {
  let v: number;
  if ((rk & 0x02) !== 0) {
    v = rk >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(rk & 0xfffffffc, 4);
    v = b.readDoubleLE(0);
  }
  if ((rk & 0x01) !== 0) { v /= 100; }
  return v;
}

/** 数值显示：整数不带小数点，浮点去掉浮点噪声（12 位有效数字足够） */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) { return ""; }
  if (Number.isInteger(v)) { return String(v); }
  return String(Number(v.toPrecision(12)));
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
  /* ⚠️ PDF 必须在 `isZip` 检查**之前**分派：PDF 不是 ZIP 容器，走下面那条会撞
     "文件不是有效的 Office 2007+ 文档" 的误导性报错（用户看到的是"格式不对"，
     而真实情况是"走错了分支"）。 */
  if (kind === "pdf") {
    return extractPdfText(buf, opts);
  }
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
