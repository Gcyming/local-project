/**
 * core-ts/src/office/fileKinds.ts — 「文件类型 → 该怎么处理」的**唯一产地**。
 *
 * ## 为什么需要它（真实事故，2026-09-28）
 * 用户把 `.docx / .pdf / .xlsx` 拖进应用后，**Chromium 的默认行为**是把当前页面导航到
 * `file:///…docx`（拖放落在页面上 = 导航到该文件，这是浏览器原生行为，**不是我们写的代码**）。
 * 而 `.docx` 不是 Chromium 能渲染的类型 ⇒ 导航失败 `ERR_FAILED (-2)` ⇒ 重试逻辑反复重发
 * ⇒ 控制台无休止刷 `GUEST_VIEW_MANAGER_CALL`、界面疯狂闪烁、目标文件夹被下载出来的
 * 半成品文件塞满。
 *
 * 修法的第一层就是这里：**先把"这个路径能不能交给 Chromium 渲染"变成一条可判定的规则**，
 * 再让每个入口（主进程导航守卫 / 渲染层拖放闸门 / 右栏浏览器地址栏 / Agent 工具）都用它，
 * 而不是各自判断扩展名 —— 「同一事实写在 N 个地方」必然漂（铁律 11）。
 *
 * ## 判定原则（不是"常见类型列表"，而是能力边界）
 * - `navigable`：**Chromium 能自己画出来吗**？能画才允许进 webview/iframe。
 *   只有三类能画：图片、PDF（Chromium 内置 PDF 查看器）、HTML。
 *   ⚠️ `.txt/.csv/.json` 虽然 Chromium 也会当纯文本显示，但**刻意判为不可导航** ——
 *   它们要走应用自己的文档通道（可预览、可喂给模型、可搜索），
 *   一律塞进浏览器页只会多出"file:// 到处跑"的第二产地。
 * - `office`：属于"工作文档族"（Word / Excel / PowerPoint / PDF），需要专门处理才能读或预览。
 * - `parser`：读文本时用哪种解析器（`zip-xml` = OOXML 压缩包 + XML；`ole` = 老版 OLE2 复合文档
 *   （`.doc/.xls/.ppt`，**仓库的 `cfb.ts` + `doc_text.ts::extractOleText` 能真读**）；
 *   `pdf` = PDF 内容流；`text` = 纯文本直读；`none` = **明确不支持**，不许硬读成乱码）。
 * - `legacy`：老版格式（`.doc/.xls/.ppt`）。⚠️ **它的含义是"格式老"，不是"不能读"** ——
 *   2026-09-28 我一度据此把它们判成"不可读 + 直接拒绝"，而本仓的 `doc_text.ts` 注释写着
 *   「A-1036：现在**能真解析**了，不再只是报错」，且 `extractOleText` 一直在被 `file_read` 用。
 *   ⇒ **断言"做不到"之前先 grep**（这正是本仓铁律；这次我自己踩了）。现在它们照常进文档通道。
 *
 * ⚠️ 判据只看**扩展名**，不读文件内容：拖放/导航守卫都是在"还没开始读文件"的时刻做决定，
 * 那时拿不到内容；读内容再判断会把"拒绝"推迟到加载失败之后（正是本次事故的形状）。
 */
export type DocKind = "image" | "pdf" | "word" | "excel" | "powerpoint" | "text" | "html" | "unknown";

/** 读文本用哪种解析器 */
export type DocParser = "text" | "zip-xml" | "ole" | "pdf" | "none";

export type FileKindInfo = {
  kind: DocKind;
  /** 小写、不含点；无扩展名时为空串 */
  ext: string;
  /** Chromium 能否自己渲染（决定"能不能进 webview"） */
  navigable: boolean;
  /** 是否"工作文档族"（Word/Excel/PPT/PDF）：需要专门通道才能读或预览 */
  office: boolean;
  parser: DocParser;
  /** 老版二进制格式（.doc/.xls/.ppt）：只提示"另存为"，不解析 */
  legacy: boolean;
};

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"];
const HTML_EXTS = ["html", "htm", "xhtml"];
const WORD_OOXML = ["docx", "docm", "dotx"];
const EXCEL_OOXML = ["xlsx", "xlsm", "xltx"];
const PPT_OOXML = ["pptx", "pptm", "potx"];
/* A-1133：老版 OLE2 三兄弟 + 同容器同流名的**模板 / 放映**变体。
   用户要求「所有 Office 办公文件全给我做一遍适配」—— 这几类与 doc/xls/ppt 是**同一批流名**
   （WordDocument / Workbook / PowerPoint Document），仓库的 `cfb.ts` 直接能读，
   ⇒ 一起登记，成套支持；漏掉它们会被判 unknown 而**在拖入时被拒**（正是这次事故的形状）。
   判据与 `core-ts/src/doc_text.ts` 的 `OLE_KIND_BY_EXT` 必须一致（那边是解析归属的产地）。 */
const WORD_LEGACY = ["doc", "dot"];
const EXCEL_LEGACY = ["xls", "xlt"];
const PPT_LEGACY = ["ppt", "pot", "pps"];
const TEXT_EXTS = ["txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "ini", "conf", "env", "cfg", "toml"];

/** 取小写扩展名（不含点）。路径里带查询串/多后缀时取最后一段。 */
export function extOf(nameOrPath: string): string {
  const base = (nameOrPath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) { return ""; }
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 分类一个文件名或路径。
 * ⚠️ 传路径进来时只看**文件名部分**：目录名里的点（`D:/a.b/c`）不该被当成扩展名。
 */
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

/** 该路径能否交给 Chromium 渲染（= 能否进 webview/iframe）。 */
export function isNavigableLocalFile(nameOrPath: string): boolean {
  return classifyFile(nameOrPath).navigable;
}

/** 是否"工作文档族"（Word/Excel/PPT/PDF）。 */
export function isOfficeFile(nameOrPath: string): boolean {
  return classifyFile(nameOrPath).office;
}

/**
 * 不可导航时给用户看的一句话（**可操作**，不是"不支持"三个字）。
 * 判据：每一种拒绝都必须给出下一步怎么做 —— 否则用户只会看到"拖进来没反应"。
 */
export function nonNavigableReason(nameOrPath: string): string {
  const info = classifyFile(nameOrPath);
  if (info.legacy) {
    return `老版格式（.${info.ext}）不在浏览器页里打开，已交给文档通道按文本读取（原版式请用系统程序打开）。`;
  }
  if (info.office) { return `工作文档（.${info.ext}）不在浏览器页里打开，已交给文档通道处理。`; }
  if (info.kind === "text") { return `纯文本（.${info.ext}）由应用自己的文档通道显示，不再走浏览器页。`; }
  return `未知类型（.${info.ext || "无扩展名"}）不交给浏览器页加载。`;}
