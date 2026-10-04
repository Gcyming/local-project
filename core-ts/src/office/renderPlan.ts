/**
 * core-ts/src/office/renderPlan.ts — 「这个文件该怎么**画出来**（给人看）」的**唯一判据**。
 *
 * ## 与 `fileKinds.ts` 的 `parser` 是两个正交维度（别合并）
 * - `parser`（在 `fileKinds.ts`）：**怎么读成文本**给 Agent 用（`zip-xml` / `ole` / `pdf` / `text`）。
 * - `renderPlan`（本文件）：**怎么画成全保真画面**给人看（`pptx-preview` / `docx-preview` / `sheetjs` / `pdf-viewer` / `none`）。
 * 一件文件可以「能被渲染」而「不能被解析」，也可以反过来 —— 混成一维就会写出"能看却读不了"或反之的洞。
 *
 * ## 用户原话（2026-09-29）
 * 「我要的是那种**类似以图片的形式**直接用 HTML 用 Web 预览的功能，**而非转成 md 文件阅读**」。
 * ⇒ 「保真渲染」= 字体/字号/颜色/位置/图片都按原样还原；不是"抽文字再重排版"。
 *
 * ## 为什么纯前端渲染器只覆盖新格式
 * `.pptx/.docx/.xlsx` 是 OOXML（ZIP + XML），浏览器端 JS 能直接解；
 * `.ppt/.doc/.xls` 是 OLE2 二进制，**纯 JS 普遍不可靠** ⇒ 走 LibreOffice headless 转 PDF（阶段 C，用户自选）。
 * 这条不是我拍的，是实测 + 业界共识（见 `docs/research/office-preview-2026-09-28.md`）。
 */

/** 给人看的渲染路线 */
export type RenderKind =
  | "pptx-preview"   // pptx-preview：保真还原幻灯片（绝对定位/颜色/图片）
  | "docx-preview"   // docx-preview：还原 Word 版式（分页/表格/页眉页脚）
  | "sheetjs"        // SheetJS：还原表格网格（列宽/合并单元格/数字格式）
  | "pdf-viewer"     // Chromium 内置 PDF 查看器（本就是"原生样貌"）
  | "html-native"    // HTML 文件**本身就是网页**：服务它所在目录、直接打开它（100% 原样，含兄弟资源）
  | "text-html"      // 退回 A-1135 的结构化 HTML（抽文本 → 纸张壳）：不是保真，但兜底可用
  | "none";          // 明确不渲染

export type RenderPlan = {
  render: RenderKind;
  /** 是否"保真渲染"（还原原版式）—— 与兜底的结构化重排版区分开，用于文案与埋点 */
  faithful: boolean;
  /** 需要哪种系统能力（阶段 C 才可能满足；用于给用户**可操作**的提示） */
  needs?: "libreoffice";
  /**
   * `needs` **不在位**时可以退到的**真渲染**路线（可选）。
   *
   * ⚠️ 只许登记**真能画出东西**的路线（如 `.xls → sheetjs` 直读 BIFF8，实测可行）。
   *    **不许**填 `"text-html"` —— 那条是"抽文本再重排版"，属于**另一条通道**
   *    （由渲染层显式降级），混进来会让"保真"这个字段失去意义。
   * ⚠️ 有 `fallback` ≠ 可以不去装 `needs`：它只是**没装时的兜底**，不是替代品。
   */
  fallback?: RenderKind;
};

/** 小写扩展名（不含点）。与 `fileKinds.ts::extOf` 同形，但本模块**不 import 那边**以免耦合。 */
function extOf(nameOrPath: string): string {
  const base = (nameOrPath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) { return ""; }
  return base.slice(dot + 1).toLowerCase();
}

const PPTX_OOXML = ["pptx", "pptm", "potx"];
const DOCX_OOXML = ["docx", "docm", "dotx"];
const XLSX_OOXML = ["xlsx", "xlsm", "xltx"];
/* 老版 OLE2：纯前端不可靠 ⇒ 需要 LibreOffice（阶段 C）。映射到 pdf-viewer + needs 提示。 */
const PPT_LEGACY = ["ppt", "pot", "pps"];
const DOC_LEGACY = ["doc", "dot"];
const XLS_LEGACY = ["xls", "xlt"];

/**
 * 判据：这个文件该怎么画。
 *
 * ⚠️ 只看扩展名，**不读内容**：调用发生在"还没打开文件"的时刻（与 `fileKinds.ts` 同一约束）。
 */
export function planRender(nameOrPath: string): RenderPlan {
  const ext = extOf(nameOrPath);
  if (ext === "pdf") { return { render: "pdf-viewer", faithful: true }; }
  if (PPTX_OOXML.includes(ext)) { return { render: "pptx-preview", faithful: true }; }
  if (DOCX_OOXML.includes(ext)) { return { render: "docx-preview", faithful: true }; }
  if (XLSX_OOXML.includes(ext)) { return { render: "sheetjs", faithful: true }; }
  if (XLS_LEGACY.includes(ext)) {
    /* `.xls` 有**兜底路线**：SheetJS 直接读 BIFF8（2026-09-30 实测 —— 用 LibreOffice 转出的真
       `.xls` 喂给已 vendored 的 `xlsx.full.min.js`，读出 2 张表、中文与数字全对）。
       ⇒ 装了 LibreOffice 就用它转 PDF（原版式最保真）；**没装也能画出一张真表格**，
         而不是干巴巴一句"去下载"。用户口径：「LibreOffice 优先 + SheetJS 兜底」。 */
    return { render: "pdf-viewer", faithful: true, needs: "libreoffice", fallback: "sheetjs" };
  }
  if (PPT_LEGACY.includes(ext) || DOC_LEGACY.includes(ext)) {
    /* `.doc` / `.ppt` **没有**纯 JS 兜底（业界普遍不可靠）⇒ 不登记 `fallback`，
       没装 LibreOffice 时由渲染层退回"结构化文本重排"（另一条通道）并**如实告知**。 */
    return { render: "pdf-viewer", faithful: true, needs: "libreoffice" };
  }
  /* ⚠️⚠️ **HTML 文件是"保真"的**（2026-09-30 用户实测「HTML 文件怎么反倒无法显示」）：
     它**本身就是网页** —— 之前被归成 `text-html`（抽文本重排），于是用户看到的是**源码**（`<!doctype html>` …），
     而 `openWebPreview` 那条本来正确的路只有"拖入"才走得到 ⇒ 换个入口（附件卡/文件浏览器）就退化成源码。
     ⇒ 归成 `html-native`：由主进程**服务它所在目录并打开它本身**，相对引用的 css/js/图片全都在 ⇒ 100% 原样。 */
  if (ext === "html" || ext === "htm" || ext === "xhtml") { return { render: "html-native", faithful: true }; }
  if (ext) { return { render: "text-html", faithful: false }; }
  return { render: "none", faithful: false };
}

/** 是不是"要经过 LibreOffice 才能保真"的老格式（`needs === "libreoffice"`）。 */
export function needsLibreOffice(nameOrPath: string): boolean {
  return planRender(nameOrPath).needs === "libreoffice";
}

/**
 * `needs` 不在位时能退到的**真渲染**路线；没有则 `null`（只能走渲染层的结构化文本降级）。
 * ⚠️ 与 `canFaithfullyRender` 的分工：那个问"现在能不能保真"，这个问"退而求其次能画成什么"。
 */
export function fallbackRender(nameOrPath: string): RenderKind | null {
  return planRender(nameOrPath).fallback ?? null;
}

/**
 * 该文件能否**保真渲染**（不含需要外部依赖的老格式 —— 那条要调用方先确认依赖在位）。
 * ⚠️ 老格式返回 `false`：`needs` 未满足前它**不可**保真，调用方不许据此假装能画。
 */
export function canFaithfullyRender(nameOrPath: string): boolean {
  const p = planRender(nameOrPath);
  return p.faithful && !p.needs;
}
