














import { isZip, listZip, readZipText, type ZipEntry } from "./zip.js";
import { isOle2, openCfb } from "./cfb.js";


import { extractPdfText } from "./pdf_text.js";


export type DocKind = "docx" | "pptx" | "xlsx" | "pdf";


export type OleKind = "doc" | "xls" | "ppt";

const KIND_BY_EXT: Record<string, DocKind> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  

  ".pdf": "pdf",
  
  ".docm": "docx",
  ".dotx": "docx",
  ".pptm": "pptx",
  ".potx": "pptx",
  ".xlsm": "xlsx",
  ".xltx": "xlsx",
};


const LEGACY_BINARY: Record<string, string> = {
  ".doc": "Word 97-2003",
  ".xls": "Excel 97-2003",
  ".ppt": "PowerPoint 97-2003",
  


  ".dot": "Word 97-2003 模板",
  ".xlt": "Excel 97-2003 模板",
  ".pot": "PowerPoint 97-2003 模板",
  ".pps": "PowerPoint 97-2003 放映",
};


const OLE_KIND_BY_EXT: Record<string, OleKind> = {
  ".doc": "doc", ".dot": "doc",
  ".xls": "xls", ".xlt": "xls",
  ".ppt": "ppt", ".pot": "ppt", ".pps": "ppt",
};


export function oleKindFromExt(ext: string): OleKind | null {
  return OLE_KIND_BY_EXT[ext.toLowerCase()] ?? null;
}


export function docKindFromExt(ext: string): DocKind | null {
  return KIND_BY_EXT[ext.toLowerCase()] ?? null;
}


export function legacyBinaryName(ext: string): string | null {
  return LEGACY_BINARY[ext.toLowerCase()] ?? null;
}

export interface DocExtractResult {
  text: string;
  
  info: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 200_000;



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


function textOfRuns(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const runs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    runs.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")));
  }
  return runs.join("");
}


function applyBreaks(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<w:cr\b[^>]*\/>/g, "\n");
}


function paragraphText(paraXml: string, tag = "w:t"): string {
  const withBreaks = applyBreaks(paraXml);
  return textOfRuns(withBreaks, tag);
}



function extractDocx(buf: Buffer, entries: ZipEntry[], maxChars: number): DocExtractResult {
  const xml = readZipText(buf, "word/document.xml", entries);
  if (!xml) {
    throw new Error("不是有效的 docx：缺少 word/document.xml");
  }
  const info: string[] = [];

  
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




function latin1(buf: Buffer): string {
  return buf.toString("latin1");
}


















export function cleanWordText(s: string): string {
  return s
    .replace(/[\x13-\x15]/g, "")
    .replace(/[\x07\x0C\x0B\x0D]/g, (m) => (m === "\x07" ? "\t" : "\n"))
    .replace(/\x01/g, "￼")
    

    .replace(/[\x00-\x06\x08\x0E-\x1F]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

























export const FAKE_TEXT_DEDUP_RATIO = 0.55;

export function looksLikeRealText(s: string): boolean {
  const chars = Array.from(s).filter((c) => {
    const v = c.codePointAt(0) ?? 0;
    
    return (v >= 0x4e00 && v <= 0x9fff) || (v >= 0x3040 && v <= 0x30ff) || (v >= 0xac00 && v <= 0xd7af);
  });
  if (chars.length < 80) { return true; }        
  const unique = new Set(chars).size;
  return unique / chars.length < FAKE_TEXT_DEDUP_RATIO;   
}









function wordPiecesFromClx(clx: Buffer, wd: Buffer): { text: string; bad: number } {
  let p = 0;
  let plc: Buffer | null = null;
  while (p < clx.length) {
    const marker = clx[p];
    if (marker === 0x01) {                       
      if (p + 3 > clx.length) { break; }
      p += 3 + clx.readUInt16LE(p + 1);
      continue;
    }
    if (marker === 0x02) {                       
      if (p + 5 > clx.length) { break; }
      const lcb = clx.readUInt32LE(p + 1);
      plc = clx.subarray(p + 5, p + 5 + lcb);
      break;
    }
    break;                                        
  }
  if (!plc || plc.length < 4) { return { text: "", bad: 0 }; }
  const n = Math.floor((plc.length - 4) / 12);    
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
    

    if (!compressed && !looksLikeRealText(seg)) { bad += 1; continue; }
    parts.push(seg);
  }
  return { text: parts.join(""), bad };
}


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


export const DOC_WIDENT = 0xa5ec;











export function validateDocFib(wd: Buffer): void {
  










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
  







  info.push("解析方式：piece table（clx）；若仍有段落读起来无意义，建议另存为 .docx 后重读");
  return clamp(body, maxChars, info);
}


const PPT_RT_SLIDE = 0x03ee;          
const PPT_RT_NOTES = 0x03f0;          
const PPT_RT_TEXT_CHARS = 0x0fa0;     
const PPT_RT_TEXT_BYTES = 0x0fa8;     






export function pptPageMarker(n: number): string {
  return `--- 第 ${n} 页 ---`;
}

export interface PptSlideScan {
  
  pages: string[][];
  
  slideAtoms: number;
  
  excludedAtoms: number;
  
  notesPages: number;
}





















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
    if (recLen > stream.length - start) { break; }   
    while (stack.length > 0 && p >= stack[stack.length - 1].end) { stack.pop(); }
    if (recVer === 0x0f) {
      

      stack.push({ type: recType, end: start + recLen });
      if (recType === PPT_RT_SLIDE) { pages.push([]); }
      else if (recType === PPT_RT_NOTES) { notesPages += 1; }
    } else if (recType === PPT_RT_TEXT_CHARS || recType === PPT_RT_TEXT_BYTES) {
      const onSlide = stack.some((s) => s.type === PPT_RT_SLIDE);
      if (!onSlide) {
        
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








function extractPptBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const stream = cfb.readStream("PowerPoint Document") ?? cfb.readStreamLike("PowerPoint Document");
  if (!stream) { throw new Error("不是有效的 .ppt：缺少 PowerPoint Document 流"); }
  const scan = collectPptSlides(stream);
  

  const body = scan.pages.map((lines, i) => `${pptPageMarker(i + 1)}\n${lines.join("\n")}`).join("\n\n");
  const info = [`ppt：${scan.pages.length} 页`, `正文文本块 ${scan.slideAtoms} 个`];
  if (scan.excludedAtoms > 0) { info.push(`已排除母版/备注占位符 ${scan.excludedAtoms} 个`); }
  if (scan.notesPages > 0) { info.push(`含备注页 ${scan.notesPages} 个（未展开）`); }   
  if (scan.slideAtoms === 0) { info.push("未找到文本内容（可能是纯图片幻灯片）"); }
  return clamp(body, maxChars, info);
}





function extractXlsBinary(buf: Buffer, maxChars: number): DocExtractResult {
  const cfb = openCfb(buf);
  const wb = cfb.readStream("Workbook") ?? cfb.readStream("Book") ?? cfb.readStreamLike("Workbook");
  if (!wb) { throw new Error("不是有效的 .xls：缺少 Workbook 流"); }

  
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
      case 0x00fd: {                       
        if (d.length < 10) { break; }
        const isst = d.readUInt32LE(6);
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), sst[isst] ?? "");
        break;
      }
      case 0x0204: {                       
        if (d.length < 8) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), biffString(d, 6));
        break;
      }
      case 0x0203: {                       
        if (d.length < 14) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(d.readDoubleLE(6)));
        break;
      }
      case 0x027e: {                       
        if (d.length < 10) { break; }
        put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), fmtNum(rkToNumber(d.readUInt32LE(6))));
        break;
      }
      case 0x00bd: {                       
        if (d.length < 6) { break; }
        const row = d.readUInt16LE(0);
        const colFirst = d.readUInt16LE(2);
        const n = Math.floor((d.length - 6) / 6);
        for (let k = 0; k < n; k += 1) {
          put(sheet, row, colFirst + k, fmtNum(rkToNumber(d.readUInt32LE(4 + k * 6 + 2))));
        }
        break;
      }
      case 0x0006: {                       
        if (d.length < 14) { break; }
        
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

  
  const texts = sst.map((t) => t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim()).filter(Boolean);
  const names = bounds.length > 0 ? `工作表：${bounds.map((b) => b.name).join("、")}` : "未取到工作表名";
  info.push(names, `回退：仅共享字符串表 ${texts.length} 条（未解析出单元格，可能是图表页）`);
  return clamp(texts.join("\n"), maxChars, info);
}


function biffString(d: Buffer, at: number): string {
  if (at + 3 > d.length) { return ""; }
  const cch = d.readUInt16LE(at);
  const wide = (d[at + 2] & 0x01) !== 0;
  const start = at + 3;
  const need = cch * (wide ? 2 : 1);
  if (start + need > d.length) { return ""; }
  return wide ? d.subarray(start, start + need).toString("utf16le") : latin1(d.subarray(start, start + need));
}





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


function fmtNum(v: number): string {
  if (!Number.isFinite(v)) { return ""; }
  if (Number.isInteger(v)) { return String(v); }
  return String(Number(v.toPrecision(12)));
}






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
  u32();                                     
  let unique = u32();                        
  if (unique > 100_000) { unique = 100_000; } 

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
        
        bi += 1; off = 0;
        if (atEnd()) { break; }
        grbit = blocks[bi][off];
        off += 1;
      }
    }
    out.push(chars);
    if (richRuns || extSize) {
      
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



function clamp(text: string, maxChars: number, info: string[]): DocExtractResult {
  if (text.length <= maxChars) { return { text, info, truncated: false }; }
  return {
    text: `${text.slice(0, maxChars)}\n\n……[已截断：文档文本超过 ${maxChars} 字符，仅显示前一部分]……`,
    info,
    truncated: true,
  };
}






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








export function extractDocText(buf: Buffer, kind: DocKind, opts: { maxChars?: number } = {}): DocExtractResult {
  


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
