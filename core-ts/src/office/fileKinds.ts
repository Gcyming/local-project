































export type DocKind = "image" | "pdf" | "word" | "excel" | "powerpoint" | "text" | "html" | "unknown";


export type DocParser = "text" | "zip-xml" | "ole" | "pdf" | "none";

export type FileKindInfo = {
  kind: DocKind;
  
  ext: string;
  
  navigable: boolean;
  
  office: boolean;
  parser: DocParser;
  
  legacy: boolean;
};

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"];
const HTML_EXTS = ["html", "htm", "xhtml"];
const WORD_OOXML = ["docx", "docm", "dotx"];
const EXCEL_OOXML = ["xlsx", "xlsm", "xltx"];
const PPT_OOXML = ["pptx", "pptm", "potx"];





const WORD_LEGACY = ["doc", "dot"];
const EXCEL_LEGACY = ["xls", "xlt"];
const PPT_LEGACY = ["ppt", "pot", "pps"];
const TEXT_EXTS = ["txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "ini", "conf", "env", "cfg", "toml"];


export function extOf(nameOrPath: string): string {
  const base = (nameOrPath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) { return ""; }
  return base.slice(dot + 1).toLowerCase();
}





export function classifyFile(nameOrPath: string): FileKindInfo {
  const ext = extOf(nameOrPath);
  const at = (kind: DocKind, navigable: boolean, office: boolean, parser: DocParser, legacy = false): FileKindInfo =>
    ({ kind, ext, navigable, office, parser, legacy });

  if (ext === "pdf") { return at("pdf", true, true, "pdf"); }
  if (IMAGE_EXTS.includes(ext)) { return at("image", true, false, "none"); }
  if (HTML_EXTS.includes(ext)) { return at("html", true, false, "text"); }
  if (WORD_OOXML.includes(ext)) { return at("word", false, true, "zip-xml"); }
  if (EXCEL_OOXML.includes(ext)) { return at("excel", false, true, "zip-xml"); }
  if (PPT_OOXML.includes(ext)) { return at("powerpoint", false, true, "zip-xml"); }
  if (WORD_LEGACY.includes(ext) || EXCEL_LEGACY.includes(ext) || PPT_LEGACY.includes(ext)) {
    const kind: DocKind = WORD_LEGACY.includes(ext) ? "word" : EXCEL_LEGACY.includes(ext) ? "excel" : "powerpoint";
    return at(kind, false, true, "ole", true);
  }
  if (TEXT_EXTS.includes(ext)) { return at("text", false, false, "text"); }
  return at("unknown", false, false, "none");
}


export function isNavigableLocalFile(nameOrPath: string): boolean {
  return classifyFile(nameOrPath).navigable;
}


export function isOfficeFile(nameOrPath: string): boolean {
  return classifyFile(nameOrPath).office;
}





export function nonNavigableReason(nameOrPath: string): string {
  const info = classifyFile(nameOrPath);
  if (info.legacy) {
    return `老版格式（.${info.ext}）不在浏览器页里打开，已交给文档通道按文本读取（原版式请用系统程序打开）。`;
  }
  if (info.office) { return `工作文档（.${info.ext}）不在浏览器页里打开，已交给文档通道处理。`; }
  if (info.kind === "text") { return `纯文本（.${info.ext}）由应用自己的文档通道显示，不再走浏览器页。`; }
  return `未知类型（.${info.ext || "无扩展名"}）不交给浏览器页加载。`;}
