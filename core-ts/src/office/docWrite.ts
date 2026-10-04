/**
 * core-ts/src/office/docWrite.ts — 生成**真文件**（docx/xlsx/pptx/pdf/csv/md/txt）。
 *
 * **需求来源**（真实事故）：用户把办公文档拖进 Electron 应用被当成网页加载 ⇒ `ERR_FAILED`
 * 死循环。修复的第二半除了「能读」，还要「能写」—— 让模型/用户能把一段文本落成**真能打开的**
 * .docx/.xlsx/.pptx/.pdf，而不是一个改后缀名的 txt。
 *
 * 三条硬纪律：
 * 1. **零新依赖**：ZIP 容器自己打（`writeZip`），PDF 结构自己拼。多引入一个库就多一份
 *    打包期供应链与体积风险（A-1034 已有前车之鉴）。
 * 2. **结构必须自洽**：`[Content_Types].xml` 里声明的部件必须真实存在、rels 里的 Target
 *    必须真实存在，否则 Office 会弹「文件已损坏」。宁愿部件少，也不要声明了却没有。
 * 3. **写出的文件必须能被本模块的 `extractDocumentText` 读回来**（round-trip）。这不是
 *    「自己测自己」的假守卫：它保证写侧的转义（XML 实体、PDF 字面量）与读侧的反转义
 *    是同一套语义，任何一侧改了都会立刻红。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeZip, type ZipFile } from "../zip.js";

/** 支持的输出格式。 */
export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf" | "csv" | "md" | "txt";

/** 写文件请求：`title` 只对 docx/pptx 生效（作为 H1/封面标题），其余格式忽略。 */
export type WriteSpec = { path: string; format: DocFormat; title?: string; body: string };

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** XML 文本/属性转义。不做这一步，正文里的 `&` `<` 会让整个部件变成非法 XML —— 文件打不开。 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 → A、25 → Z、26 → AA。 */
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

/** 表格单元格引用：`A1`、`C7`。 */
function cellRef(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

// ── docx ─────────────────────────────────────────────────

/** 一行的结构前缀 → `w:pStyle`；`# `→Heading1、`## `→Heading2、`### `→Heading3、`- `→项目符号。 */
function docxParagraph(line: string): string {
  let style = "";
  let list = false;
  let text = line;
  if (line.startsWith("### ")) { style = "Heading3"; text = line.slice(4); }
  else if (line.startsWith("## ")) { style = "Heading2"; text = line.slice(3); }
  else if (line.startsWith("# ")) { style = "Heading1"; text = line.slice(2); }
  else if (line.startsWith("- ")) { list = true; text = line.slice(2); }

  let pPr = "";
  if (style) {
    pPr = `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  } else if (list) {
    pPr = `<w:pPr><w:pStyle w:val="ListParagraph"/>`
      + `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`;
  }
  const run = text.length > 0 ? `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : "";
  return `<w:p>${pPr}${run}</w:p>`;
}

function buildDocx(spec: WriteSpec): Buffer {
  const lines = spec.body.split(/\r?\n/);
  const body: string[] = [];
  if (spec.title) { body.push(docxParagraph(`# ${spec.title}`)); }
  for (const line of lines) { body.push(docxParagraph(line)); }
  const sectPr = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>';
  const documentXml = XML_DECL
    + `<w:document xmlns:w="${W_NS}"><w:body>${body.join("")}${sectPr}</w:body></w:document>`;

  const stylesXml = XML_DECL
    + `<w:styles xmlns:w="${W_NS}">`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
    + '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>'
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
    + '<w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>'
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
    + '<w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>'
    + '<w:basedOn w:val="Normal"/></w:style>'
    + "</w:styles>";

  const numberingXml = XML_DECL
    + `<w:numbering xmlns:w="${W_NS}">`
    + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/>'
    + '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
    + '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>'
    + "</w:abstractNum>"
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + "</w:numbering>";

  const contentTypes = XML_DECL
    + `<Types xmlns="${CT_NS}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + "</Types>";

  const rootRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/>`
    + "</Relationships>";

  const docRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId2" Type="${OFFICE_REL}/numbering" Target="numbering.xml"/>`
    + "</Relationships>";

  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    { name: "word/numbering.xml", data: Buffer.from(numberingXml, "utf8") },
  ];
  return writeZip(files);
}

// ── xlsx ─────────────────────────────────────────────────

/** body → 单元格网格：含 `\t` 按 TSV，否则按 CSV 分列（不做引号转义，保持可预期）。 */
function sheetGrid(body: string): string[][] {
  const sep = body.includes("\t") ? "\t" : ",";
  return body.split(/\r?\n/).map((line) => line.split(sep));
}

function buildXlsx(spec: WriteSpec): Buffer {
  const grid = sheetGrid(spec.body);
  const shared = new Map<string, number>();
  const rowsXml: string[] = [];
  let maxCol = 0;
  for (let r = 0; r < grid.length; r += 1) {
    if (grid[r].length > maxCol) { maxCol = grid[r].length; }
    const cells: string[] = [];
    for (let c = 0; c < grid[r].length; c += 1) {
      const value = grid[r][c];
      let idx = shared.get(value);
      if (idx === undefined) { idx = shared.size; shared.set(value, idx); }
      cells.push(`<c r="${cellRef(r, c)}" t="s"><v>${idx}</v></c>`);
    }
    rowsXml.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  }
  const lastRef = `A1:${cellRef(Math.max(0, grid.length - 1), Math.max(0, maxCol - 1))}`;

  const sheetXml = XML_DECL
    + `<worksheet xmlns="${S_NS}"><dimension ref="${lastRef}"/><sheetData>${rowsXml.join("")}</sheetData></worksheet>`;

  const sharedItems: string[] = [];
  for (const key of shared.keys()) {
    sharedItems.push(`<si><t xml:space="preserve">${esc(key)}</t></si>`);
  }
  const sharedXml = XML_DECL
    + `<sst xmlns="${S_NS}" count="${shared.size}" uniqueCount="${shared.size}">`
    + `${sharedItems.join("")}</sst>`;

  const workbookXml = XML_DECL
    + `<workbook xmlns="${S_NS}" xmlns:r="${R_NS}">`
    + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const contentTypes = XML_DECL
    + `<Types xmlns="${CT_NS}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + "</Types>";

  const rootRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>`
    + "</Relationships>";

  const wbRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
    + `<Relationship Id="rId2" Type="${OFFICE_REL}/sharedStrings" Target="sharedStrings.xml"/>`
    + "</Relationships>";

  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml, "utf8") },
    { name: "xl/sharedStrings.xml", data: Buffer.from(sharedXml, "utf8") },
  ];
  return writeZip(files);
}

// ── pptx ─────────────────────────────────────────────────

/** 一页幻灯片：标题 + 段落（bullet 决定是否项目符号）。 */
type PptPage = { title: string; paragraphs: Array<{ text: string; bullet: boolean }> };

/** body → 页：`# X` 开新页（X 为标题），`- Y` 项目符号，其余普通段落。 */
function pptPages(body: string, title?: string): PptPage[] {
  const pages: PptPage[] = [];
  let current: PptPage | null = null;
  const open = (t: string): PptPage => {
    const p: PptPage = { title: t, paragraphs: [] };
    pages.push(p);
    current = p;
    return p;
  };
  if (title) { open(title); }
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("# ")) { open(line.slice(2)); continue; }
    const c: PptPage = current ?? open("");
    if (line.startsWith("- ")) { c.paragraphs.push({ text: line.slice(2), bullet: true }); }
    else { c.paragraphs.push({ text: line, bullet: false }); }
  }
  if (pages.length === 0) { pages.push({ title: "", paragraphs: [{ text: "", bullet: false }] }); }
  return pages;
}

/** 段落 → `<a:p>`。bullet 段落带 `buChar`，读侧据此重建 `- `。 */
function pptParagraph(text: string, bullet: boolean): string {
  const pPr = bullet ? '<a:pPr lvl="0"><a:buChar char="\u2022"/></a:pPr>' : "";
  const run = text.length > 0 ? `<a:r><a:t>${esc(text)}</a:t></a:r>` : "";
  return `<a:p>${pPr}${run}</a:p>`;
}

function buildPptx(spec: WriteSpec): Buffer {
  const pages = pptPages(spec.body, spec.title);
  const n = pages.length;

  const slideXml = (i: number): string => {
    const page = pages[i];
    let spId = 2;
    const titlePara = pptParagraph(page.title, false);
    const titleShape = "<p:sp><p:nvSpPr>"
      + `<p:cNvPr id="${spId}" name="Title ${spId}"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr>`
      + "</p:nvSpPr><p:spPr/>"
      + `<p:txBody><a:bodyPr/><a:lstStyle/>${titlePara}</p:txBody></p:sp>`;
    spId += 1;
    const bodyParas = page.paragraphs.map((p) => pptParagraph(p.text, p.bullet)).join("");
    const bodyShape = "<p:sp><p:nvSpPr>"
      + `<p:cNvPr id="${spId}" name="Body ${spId}"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr>`
      + "</p:nvSpPr><p:spPr/>"
      + `<p:txBody><a:bodyPr/><a:lstStyle/>${bodyParas}</p:txBody></p:sp>`;
    return XML_DECL
      + `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">`
      + `<p:cSld><p:spTree>`
      + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + "<p:grpSpPr/>"
      + titleShape + bodyShape
      + "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
  };

  const spTree = (name: string): string =>
    "<p:cSld" + (name ? ` name="${name}"` : "") + "><p:spTree>"
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + "<p:grpSpPr/></p:spTree></p:cSld>";

  const slideLayout = XML_DECL
    + `<p:sldLayout xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}" type="blank" preserve="1">`
    + spTree("Blank")
    + "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

  const slideLayoutRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`
    + "</Relationships>";

  const slideMaster = XML_DECL
    + `<p:sldMaster xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">`
    + spTree("")
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
    + 'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" '
    + 'hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + "<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>";

  const slideMasterRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    + "</Relationships>";

  const slideIdLst: string[] = [];
  const presRels: string[] = [];
  for (let i = 0; i < n; i += 1) {
    slideIdLst.push(`<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`);
    presRels.push(`<Relationship Id="rId${i + 2}" Type="${OFFICE_REL}/slide" Target="slides/slide${i + 1}.xml"/>`);
  }
  const presentation = XML_DECL
    + `<p:presentation xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">`
    + `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + `<p:sldIdLst>${slideIdLst.join("")}</p:sldIdLst>`
    + '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>'
    + '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>';

  const presentationRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`
    + presRels.join("")
    + "</Relationships>";

  const slideRels = (): string => XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
    + "</Relationships>";

  const overrides: string[] = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
  ];
  for (let i = 0; i < n; i += 1) {
    overrides.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }
  const contentTypes = XML_DECL
    + `<Types xmlns="${CT_NS}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + overrides.join("")
    + "</Types>";

  const rootRels = XML_DECL
    + `<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/>`
    + "</Relationships>";

  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "ppt/presentation.xml", data: Buffer.from(presentation, "utf8") },
    { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from(presentationRels, "utf8") },
    { name: "ppt/slideMasters/slideMaster1.xml", data: Buffer.from(slideMaster, "utf8") },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: Buffer.from(slideMasterRels, "utf8") },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: Buffer.from(slideLayout, "utf8") },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: Buffer.from(slideLayoutRels, "utf8") },
  ];
  for (let i = 0; i < n; i += 1) {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: Buffer.from(slideXml(i), "utf8") });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: Buffer.from(slideRels(), "utf8") });
  }
  return writeZip(files);
}

// ── pdf ──────────────────────────────────────────────────

/**
 * 文本 → PDF 字面量字符串。
 *
 * 三条必须做对的事：
 * - `(` `)` `\` 必须转义，否则字符串提前闭合、内容流语法坏掉、PDF 打不开。
 * - **非 ASCII 字节一律写成八进制 `\ooo`**：PDF 标准字体 Helvetica 用单字节编码，
 *   直接塞 UTF-8 多字节会被解析器按单字节切开。写成八进制转义后，读侧（pdfUnescape）
 *   按字节还原、再按 UTF-8 解码，中英混排才能 round-trip。
 *   代价要说清楚：**中文字符在真正的 PDF 阅读器里仍会显示为乱码**（Helvetica 无 CJK 字形），
 *   要正确显示中文需要嵌 CJK 字体与 ToUnicode 表 —— 那是远超本次范围的工作。
 */
function pdfLiteral(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28) { out += "\\("; }
    else if (b === 0x29) { out += "\\)"; }
    else if (b === 0x5c) { out += "\\\\"; }
    else if (b < 0x20 || b > 0x7e) { out += `\\${b.toString(8).padStart(3, "0")}`; }
    else { out += String.fromCharCode(b); }
  }
  return `${out})`;
}

/** 一页的内容流：BT/ET 之间逐行 Tj，行间距 16pt。 */
function pdfPageContent(lines: readonly string[]): string {
  const ops = ["BT", "/F1 12 Tf", "72 720 Td"];
  let first = true;
  for (const line of lines) {
    if (!first) { ops.push("0 -16 Td"); }
    ops.push(`${pdfLiteral(line)} Tj`);
    first = false;
  }
  ops.push("ET");
  return `${ops.join("\n")}\n`;
}

const PDF_LINES_PER_PAGE = 46;

/**
 * 拼一个最小但**合规**的文本 PDF。
 *
 * 为什么 `xref` 偏移必须真实计算：`startxref` 与每条 xref 记录都是**字节偏移**，
 * 糊一个假值（比如全 0 或固定值）在宽松阅读器里可能侥幸打开，在严格阅读器（含浏览器
 * 内置的 pdf.js）里会报「文件损坏」。所以这里用「边拼边记 offset」的方式，
 * `/Length` 同理取内容流的真实字节数。
 */
function buildPdf(spec: WriteSpec): Buffer {
  const allLines = spec.body.split(/\r?\n/);
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += PDF_LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + PDF_LINES_PER_PAGE));
  }
  if (pages.length === 0) { pages.push([""]); }

  const n = pages.length;
  const fontNum = 3 + n * 2;
  const total = fontNum + 1;

  const chunks: Buffer[] = [];
  let len = 0;
  const offsets = new Map<number, number>();
  const emit = (s: string): void => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    len += b.length;
  };

  emit("%PDF-1.4\n");
  emit("%\u00e2\u00e3\u00cf\u00d3\n");

  offsets.set(1, len);
  emit("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  const kids: string[] = [];
  for (let i = 0; i < n; i += 1) { kids.push(`${3 + i * 2} 0 R`); }
  offsets.set(2, len);
  emit(`2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>\nendobj\n`);

  for (let i = 0; i < n; i += 1) {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    offsets.set(pageNum, len);
    emit(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`);
    const content = pdfPageContent(pages[i]);
    offsets.set(contentNum, len);
    emit(`${contentNum} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  }

  offsets.set(fontNum, len);
  emit(`${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);

  const xrefOffset = len;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i += 1) {
    xref += `${String(offsets.get(i) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  emit(xref);
  emit(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

// ── 统一入口 ──────────────────────────────────────────────

/** 建父目录并把字节落盘。ZIP/PDF 之外的格式走这里直写。 */
function bytesFor(spec: WriteSpec): Buffer {
  switch (spec.format) {
    case "docx": return buildDocx(spec);
    case "xlsx": return buildXlsx(spec);
    case "pptx": return buildPptx(spec);
    case "pdf": return buildPdf(spec);
    default: return Buffer.from(spec.body, "utf8");
  }
}

/**
 * 按 `format` 生成真文件并落盘。
 *
 * @returns 判别联合：成功给真实字节数；失败给原因（**不抛异常**，IPC 层可直接转提示）
 */
export async function writeDocument(
  spec: WriteSpec,
): Promise<{ ok: true; path: string; bytes: number } | { ok: false; path: string; error: string }> {
  try {
    const data = bytesFor(spec);
    await mkdir(dirname(spec.path), { recursive: true });
    await writeFile(spec.path, data);
    return { ok: true, path: spec.path, bytes: data.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, path: spec.path, error };
  }
}
