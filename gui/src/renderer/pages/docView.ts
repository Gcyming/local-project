/**
 * gui/src/renderer/pages/docView.ts — 「抽取出来的文档文本 → 结构化块」的**唯一判据**（零依赖）。
 *
 * ## 背景（用户原话）
 * 「右侧边栏给我想办法显示正确内容，我记得网页是可以显示的吧？」
 * —— 对，业界主流就是**把 Office 转成 HTML 让浏览器画**（mammoth / docx-preview / SheetJS /
 * PPTXjs 都是这个思路：`blog.csdn.net/weixin_29229261` 那篇《纯前端实现 Office 文档在线预览》
 * 把两条路线写得很清楚：路线一 = 格式转换→HTML/SVG/Canvas；路线二 = 嵌微软在线预览）。
 *
 * ## 本模块为什么是"零依赖的结构化渲染"而不是直接上 mammoth/docx-preview
 * 1. 本仓是**零新依赖**纪律（打包体积 + 供应链），而 `doc_text.ts` 已经把 docx/xlsx/pptx/旧版 OLE
 *    **全部**抽成了带轻结构的文本 —— 再引一个解析器等于**同一事实两个产地**；
 * 2. 对"读内容"这个需求，结构（段落 / **真表格** / **分页**）比"原版面保真"重要得多；
 * 3. 版面保真（字体/颜色/图片/公式）是另一档需求，正解是 `docx-preview`(Apache-2.0) /
 *    PPTXjs，或本机 LibreOffice headless 转 PDF 再交给已有的 PDF 查看器 —— 见
 *    `docs/research/office-preview-2026-09-28.md`，**已列为可选升级路径**，不在本次实现内。
 *
 * ⚠️ 判据必须与 `core-ts/src/doc_text.ts` 的**实际输出形状**对齐（那是唯一产地）：
 *   · xlsx：`## 表：<sheetName>` → 一行列字母（`A | B`）→ 数据行（` | ` 分隔）
 *   · pptx：`--- 第 N 页 ---` 分段
 *   · docx / 旧版 OLE / pdf：一段一行（空行分段）
 *   形状一变，这里必须同步 —— 所以它有守卫与变异（`mut-a1133-docs.mjs`）。
 */
export type DocBlock =
  | { type: "page"; label: string; lines: string[] }
  | { type: "table"; title: string; header: string[]; rows: string[][] }
  | { type: "para"; text: string };

/** 表格单元格分隔符（`doc_text.ts` 用 ` | ` 输出网格，**docx 的表格也是这个形状**） */
const CELL_SEP = /\s+\|\s+/;

/**
 * 表格单元格的**列最小宽度**（单位 em = 当前字号倍数）—— **唯一产地**，两处渲染（网页版 + 右栏）
 * 都必须引用它，禁止各写一份（铁律 11）。
 *
 * ## 为什么必须有（2026-09-28 用户截图打回，几何取证）
 * 中文的 `min-content` 宽度 = **1 个汉字**（CJK 允许任意字间断行），于是 `table-layout: auto`
 * 在"某列内容极长"时会把它旁边那列压到底：
 *   · 实测那份读书报告（`20244222026-张裴文-《互联网思维》.docx`）第二张表：
 *     第二列 **3487 字符**，第一列只有 48 字符 ⇒ 实测列宽 **3.43 汉字**（用户窗口更窄 ⇒ 1 个字）
 *     ⇒ 屏幕上就是**一列竖排单字**。第一张表（各列长度相近）则完全正常（7.85 / 8.85 / 10.13）。
 * ⇒ 给一个下限，压缩就不会掉到单字。5em ≈ 5 个汉字，够放下"出版单位""承诺声明"这类行标题。
 * ⚠️ 判据是**几何**不是文本：`tests/gui/a1133-doc-table-geometry.spec.ts` 调用**本文件的真函数**
 *    生成页面，再用真实 Chromium 量每列宽度（零手抄 CSS —— 手抄副本必漂）。
 *    本文件的 `.tbl-wrap` 与上面那行 `min-width` 只是**漂移守卫**（弱），真判据在 spec 里。
 */
export const DOC_CELL_MIN_EM = 5;

/** `doc_text.ts` 的表格数量提示行（`[表格 1 个]`）—— 它是**结构提示**，不是正文 */
const TABLE_HINT_RE = /^\[表格\s*\d+\s*个\]$/;
/** 分页标记（`doc_text.ts` 的 pptx 分支输出 `--- 第 N 页 ---`） */
const PAGE_RE = /^-{2,}\s*(第\s*\d+\s*页)\s*-{2,}$/;
/** 工作表标题（`doc_text.ts` 的 xlsx 分支输出 `## 表：<name>`） */
const SHEET_RE = /^#{1,6}\s*表[:：]\s*(.+?)\s*$/;
/** 列字母行（`A | B | C`）—— 它只是坐标提示，进表头但**不当数据行** */
const COL_LETTERS_RE = /^[A-Z]{1,3}(\s*\|\s*[A-Z]{1,3})*$/;
/** 一行是否是"表格行"：含 ` | ` 分隔符 */
const isTableRow = (line: string): boolean => CELL_SEP.test(line);

/**
 * 把抽取文本切成块。
 * @param kind 文档种类（`doc_text.ts` 的 `DocKind`，含 `pdf`；旧版 OLE 已由调用方折成 word/excel/powerpoint）
 */
export function buildDocView(kind: string, text: string): DocBlock[] {
  const src = (text ?? "").replace(/\r\n?/g, "\n");
  if (!src.trim()) { return []; }

  if (kind === "excel") { return excelBlocks(src); }
  if (kind === "powerpoint") { return pageBlocks(src); }
  return paragraphBlocks(src);
}

/**
 * 把块渲染成**自包含的 HTML 文档**（零依赖、无外部资源）—— 「路线一」的落地：转成 HTML 让浏览器画。
 *
 * 为什么直接给字符串而不是引 `docx-preview` 之类：见文件头注释（零依赖纪律 + 抽取已存在）。
 * 这段 HTML 会被写进临时目录、经应用内静态服务在右栏浏览器页里打开 —— 于是用户拿到的是
 * **一个真正的网页**（可选中、可缩放、可 Ctrl+F、表格有边框），而不是"文件页里的一段文本"。
 *
 * ⚠️ 必须自包含：不引外网 CSS/字体（离线可用，也不违反 CSP）；用内联 `<style>` +
 *    `prefers-color-scheme` 同时适配深浅色（这个页面跑在 webview 里，跟主题走）。
 * ⚠️ 所有文本都要 HTML 转义 —— 文档正文里出现 `<` `&` 是**常态**（代码片段、公式），
 *    不转义会被浏览器当标签吃掉（内容静默丢失，属于"看得见但少了一截"的隐形 bug）。
 */
export function docViewToHtml(blocks: readonly DocBlock[], opts: { title: string; source?: string; notice?: string }): string {
  const esc = (s: string): string => s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const body = blocks.map((b) => {
    if (b.type === "page") {
      return slideHtml(b, esc);
    }
    if (b.type === "table") {
      const head = b.header.length > 0
        ? `<thead><tr>${b.header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`
        : "";
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
      const cap = b.title ? `<caption>${esc(b.title)}</caption>` : "";
      /* ⚠️ 必须套一层滚动容器：`DOC_CELL_MIN_EM` 是**绝对下限**，列一多（或用户把右栏拖窄）
         总宽就会超过容器。没有这层 ⇒ 表格撑破页面（body 横向滚动、右边被切掉）。
         有了它 ⇒ 表格自己滚，页面版式不受影响。 */
      return `<div class="tbl-wrap"><table>${cap}${head}<tbody>${rows}</tbody></table></div>`;
    }
    /* 「正文段」判定：只给真正的正文行加首行缩进 —— 短行（标题、字段名、编号项）不缩进，
       否则会缩进到莫名其妙的位置。它是**结构提示**，不做版面保证。 */
    const prose = b.text.trim().length >= 24 && !/^[\d（(一二三四五六七八九十]+[、.)）]/.test(b.text.trim());
    return `<p${prose ? ' class="is-prose"' : ""}>${esc(b.text)}</p>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<title>${esc(opts.title)}</title>
<style>
  /* A-1135：「原生样貌」—— 不追求像素级保真，但必须**像一份文档**：
     纸张、衬线标题、正文首行缩进、页码/母版占位符降级为脚注、表格按内容宽度不被压扁。 */
  :root { color-scheme: light dark; --ink: #1f2430; --ink2: #444c5e; --faint: #6b7280;
          --line: #d8dde6; --head: #eef1f6; --paper: #ffffff; --bg: #eef1f5; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 26px 22px 70px; background: var(--bg); color: var(--ink);
         font: 15px/1.9 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif; }
  .page-shell { max-width: 860px; margin: 0 auto; background: var(--paper); border: 1px solid var(--line);
                border-radius: 4px; padding: 46px 54px 60px;
                box-shadow: 0 1px 3px rgba(16,24,40,.06), 0 10px 28px rgba(16,24,40,.07); }
  h1.doc-title { font: 700 21px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
                 margin: 0 0 6px; letter-spacing: .2px; }
  .meta { color: var(--faint); font-size: 11.5px; margin-bottom: 26px;
          padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  /* 降级提示条（2026-09-30）：老格式没装 LibreOffice 时，这里是**结构化重排**而非原版式 ——
     必须**看得见**，否则用户会以为"这文件就长这样"（A-1133 的教训：静默降级 = 以为功能没做）。 */
  .notice { margin: 0 0 24px; padding: 10px 14px; border: 1px solid #f0d79a; background: #fdf6e3;
            color: #7a5c12; border-radius: 6px; font-size: 13px; line-height: 1.65; }
  .notice b { font-weight: 600; }
  p { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  /* ⚠️ 模板字符串内**绝对不能出现反引号**（会提前闭合模板，tsc 报一堆莫名其妙的
     「Property 'is' does not exist on type 'string'」）。CSS 注释里描述类名时不要用反引号包裹。 */
  /* 正文段落：中文文档的首行缩进两字（类名 is-prose 由渲染端按内容判定加上） */
  .page-shell > p.is-prose { text-indent: 2em; }
  .page-shell > p.is-prose + p.is-prose { margin-top: -4px; }
  /* 表格：给内容宽度一个下限，避免自动布局把某一列压成竖排单字 */
  .tbl-wrap { overflow-x: auto; margin: 8px 0 22px; }
  table { border-collapse: collapse; margin: 0; font: 14px/1.7 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
          table-layout: auto; min-width: max-content; }
  caption { text-align: left; color: var(--faint); font-size: 12px; padding-bottom: 6px; }
  th, td { border: 1px solid var(--line); padding: 6px 12px; text-align: left; vertical-align: top;
           min-width: ${DOC_CELL_MIN_EM}em; max-width: 28em;
           white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  th { background: var(--head); font-weight: 600; }
  /* PPT：**模拟一页幻灯片**（16:9 纸面），而不是"带标题的代码块" */
  .deck { display: flex; flex-direction: column; gap: 22px; }
  section.slide { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--paper); }
  .slide-head { display: flex; align-items: center; gap: 8px; padding: 6px 14px;
                background: var(--head); border-bottom: 1px solid var(--line); }
  .slide-no { font-size: 11px; font-weight: 700; letter-spacing: .4px; color: var(--accent); }
  .slide-head h2 { margin: 0; font-size: 11.5px; font-weight: 600; color: var(--faint); }
  .slide-body { aspect-ratio: 16 / 9; padding: 30px 38px; overflow: auto; }
  .slide-body h3 { margin: 0 0 18px; font: 700 19px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .slide-body p { font-size: 14.5px; line-height: 2; margin: 0 0 8px; }
  /* ⚠️ 这里曾有一套「占位符脚注」样式（.ph 系列），随「关键词过滤」一起**整块删除**（2026-09-29 实测推翻）：
     过滤本身从未生效、且会误杀真实正文 ⇒ 样式留着只会误引后来人以为还有这个分支。详见 slideHtml 上方长注释。 */
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e5e9f0; --ink2: #b8c2d4; --faint: #8b98ad; --line: #263148;
            --head: #182034; --paper: #0f1523; --bg: #0b111c; --accent: #6ea8fe; }
    .page-shell { box-shadow: 0 1px 3px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.35); }
  }
</style></head>
<body>
<div class="page-shell">
<h1 class="doc-title">${esc(opts.title)}</h1>
<div class="meta">由 slime 从原始文档抽取并转成 HTML 渲染${opts.source ? ` · 源文件：${esc(opts.source)}` : ""}</div>
${opts.notice ? `<div class="notice">${esc(opts.notice)}</div>` : ""}
${body}
</div>
</body></html>`;
}
/**
 * 一页幻灯片 → HTML（**模拟幻灯片**，不是"带标题的文本框"）。
 *
 * ## 为什么必须分级（2026-09-28 用户截图打回）
 * 用户原话：「我要的是那种类似以图片的形式直接用 HTML 用 Web 预览的功能，而非转成 md 文件阅读」
 * —— 旧实现把一整页渲染成一个 `<pre>`，视觉上就是「一段长文本套个框」，
 *    和 Markdown 阅读没有任何区别（这正是被拍的原因）。
 *
 * ## PPT 的「原生样貌」由三件事构成（实测自 `jeny_第二章.ppt`，165 页 / 841 行）
 * 1. **一页 = 一块纸面**（16:9），页与页之间有真实间距；
 * 2. **首行是标题**（大字号 + 加粗）—— PPT 的第一行几乎总是标题框；
 * 3. **母版/版式提示文字在抽取层已被排除**（`collectPptSlides` 只收祖先链含 `Slide` 的记录），
 *    所以这里**不再做任何关键词过滤** —— 渲染层做主过滤会误杀真实正文（见上方长注释）。
 *    万一还有漏进来的（不同版本的 PPT），仍然**如实显示**而不是丢掉：宁可用户看到一行怪文字，
 *    也不要让他以为自己的内容丢了。
 *
 * ⚠️ 这是**启发式**，不是像素级保真：真正的保真是 `docx-preview` / LibreOffice→PDF
 *    （见文件头注释的升级路径），本函数只在"零依赖 + 结构"这一档里做到"看起来像那一页"。
 */
function slideHtml(
  b: { label: string; lines: readonly string[] },
  esc: (s: string) => string,
): string {
  const no = (/第\s*(\d+)\s*页/.exec(b.label)?.[1] ?? "").trim();
  const content = b.lines.map((l) => l.trim()).filter(Boolean);

  /* 标题：页面里第一行（PPT 的标题框通常在最前）。
     ⚠️ 阈值是**实测**定的，不是拍的（两份真课件 / 204 页）：
       · `jeny_第二章.ppt`（157 页）首行长度 **中位数 12、最大 32**，>40 字 **0 条**；
       · `第1次课 EDA技术概述.pptx`（47 页）中位数 13、最大 78 —— 那 78 字的是"该页没有标题、
         首行就是正文"的情况。
     ⇒ 取 **40 字** 为界：`ppt` 那份 0 条被误当标题；`pptx` 那份最多只有 3 条长正文进了 h3
       （失败方向是"少加一个标题"，可接受；而反过来"把正文变成大标题"更糟）。
     ⚠️ 再加一条**句末标点**判据：标题几乎不带「。；！？」——
        「…之间的关系。」这种带句号的无论多长都该是正文。 */
  const first = content[0] ?? "";
  const hasTitle = first.length > 0 && first.length <= 40 && !/[。；！？]$/.test(first);
  const heading = hasTitle ? first : "";
  const bodyLines = hasTitle ? content.slice(1) : content;
  /* 没有可识别的标题、也没有正文（整页空）⇒ 仍画一张空纸面，让页序完整（不许静默少一页） */
  const head = `<div class="slide-head">${no ? `<span class="slide-no">#${esc(no)}</span>` : ""}` +
    `<h2>${esc(b.label)}</h2></div>`;
  const bodyParts: string[] = [];
  if (heading) { bodyParts.push(`<h3>${esc(heading)}</h3>`); }
  for (const line of bodyLines) { bodyParts.push(`<p>${esc(line)}</p>`); }
  return `<section class="slide">${head}<div class="slide-body">${bodyParts.join("")}</div></section>`;
}

/** xlsx：一张表一个块；`## 表：x` 起新表，随后**第一行是列字母**（作表头），其余是数据行 */

/**
 * ⚠️ **这里刻意不做"占位符关键词判定"**（2026-09-29 实测推翻）。
 *
 * 我最初写了一套 `isSlidePlaceholder`（「单击此处 / 在此输入 / 点击此处」…），想给那些
 * 母版提示文字降级成脚注。实测发现**两头都不对**：
 *
 * 1. **它根本不会生效**：实测 `jeny_第二章.ppt` 抽取出来的 841 行里，
 *    「单击此处」出现 **0 次** —— `doc_text.ts::collectPptSlides` **只收祖先链含 `Slide` 的记录**，
 *    `Notes`(备注) / `MainMaster`(母版) 在**抽取层**就被排除了（A-1133 的修复成果）。
 *    ⇒ 渲染层的判据是**无用的防御代码**。
 * 2. **它还会误杀真实内容**（这才是关键）：按"含关键词"判定时，
 *    `实验步骤：点击此处开始采集数据` / `在此键入搜索关键字后回车` / `在本页请输入你的课程设计题目`
 *    这些**真实正文**会被降级成小字脚注 —— **用户的内容被藏起来，比不降级更坏**。
 *    收紧成"前缀 + 剩余长度"仍然脆（实测「在此输入」开头的正文正好卡在边界）。
 *
 * ⇒ 结论：**同一件事不要在两个产地各判一次**（铁律 11）。抽取层负责"哪些是内容"，
 *   渲染层只管"怎么画内容"。这里只保留一个**如实的提示入口**：
 *   块里真带着 `placeholder` 标记时才渲染脚注（见 `DocBlock` 的 page 分支）。
 */

/** xlsx：一张表一个块；`## 表：x` 起新表，随后**第一行是列字母**（作表头），其余是数据行 */
function excelBlocks(src: string): DocBlock[] {
  const out: DocBlock[] = [];
  let cur: { type: "table"; title: string; header: string[]; rows: string[][] } | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const sheet = SHEET_RE.exec(line);
    if (sheet) {
      if (cur) { out.push(cur); }
      /* ⚠️ 表头先占位成空数组：真实表头要等"下一行"才知道有几个列；
         若表里没有任何数据行，依然保留这张表（空表也是事实，不该被吞掉）。 */
      cur = { type: "table", title: sheet[1], header: [], rows: [] };
      continue;
    }
    if (!line) { continue; }
    const cells = line.split(CELL_SEP).map((c) => c.trim());
    if (!cur) {
      /* 没有 `## 表：` 前缀（别的抽取路径）⇒ 也当表，标题留空 */
      cur = { type: "table", title: "", header: [], rows: [] };
    }
    if (cur.header.length === 0 && cur.rows.length === 0 && line.split(CELL_SEP).every((c) => COL_LETTERS_RE.test(c.trim()))) {
      cur.header = cells;                    // 列字母行 = 表头（不进数据）
      continue;
    }
    cur.rows.push(cells);
  }
  if (cur) { out.push(cur); }
  return out;
}

/** pptx：`--- 第 N 页 ---` 之间是这一页的内容 */
function pageBlocks(src: string): DocBlock[] {
  const out: DocBlock[] = [];
  let cur: { type: "page"; label: string; lines: string[] } | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = PAGE_RE.exec(line.trim());
    if (m) {
      if (cur) { out.push(cur); }
      cur = { type: "page", label: m[1], lines: [] };
      continue;
    }
    if (!line.trim()) { continue; }
    if (!cur) { cur = { type: "page", label: "（未分页内容）", lines: [] }; }
    cur.lines.push(line.trim());
  }
  if (cur) { out.push(cur); }
  return out;
}

/** docx / PDF / 纯文本：空行分段；**表格式的行块要变成真表格**。
 *
 * ⚠️ **本函数曾被我自己写出死循环**（实测把 vitest worker 卡死 8 分钟）：
 *    旧写法先用"含 `|` 的连续行"找表格，找不到（例如**只有一行**含 `|`）就落到段落分支，
 *    而段落分支的内层 while 又因为"这一行是表行"立刻退出 ⇒ `i` 原地不动 ⇒ 永远转圈。
 *    ⇒ 现在改成**显式保证每轮前进**：要么吃掉一张表（`i = j > i`），要么吃掉一行（`i += 1`）。
 *    「单行含竖线」这条用例就是当时用来复现它的（在 spec 里）。
 *
 * 表格判据（**只认这两条，不猜**）：
 *   · 当前行含 ` | `，且**下一行也含、且列数相同** ⇒ 这里开始一张表（首行作表头）；
 *   · 连续同列数行全部并入该表。
 *   为什么要求"列数一致"：正文里恰好出现竖线的两行（`标题 | 副标题`）不能变成表。
 */

function startsTable(lines: readonly string[], i: number): boolean {
  if (i >= lines.length || !isTableRow(lines[i])) { return false; }
  const cols = lines[i].split(CELL_SEP).length;
  return i + 1 < lines.length && isTableRow(lines[i + 1]) && lines[i + 1].split(CELL_SEP).length === cols;
}

function paragraphBlocks(src: string): DocBlock[] {
  const out: DocBlock[] = [];
  const lines = src.split("\n").map((l) => l.replace(/\s+$/, ""));

  let i = 0;
  while (i < lines.length) {
    if (startsTable(lines, i)) {
      const cols = lines[i].split(CELL_SEP).length;
      let j = i;
      while (j < lines.length && isTableRow(lines[j]) && lines[j].split(CELL_SEP).length === cols) { j += 1; }
      out.push({
        type: "table",
        title: "",
        header: lines[i].split(CELL_SEP).map((c) => c.trim()),
        rows: lines.slice(i + 1, j).map((r) => r.split(CELL_SEP).map((c) => c.trim())),
      });
      i = j;                                   // ← 前进（吃掉整张表）
      continue;
    }
    const line = lines[i];
    /* ⚠️ **一行一块**（不是"空行分段"）：`doc_text.ts` 的 docx 分支是"一段一行、用 `\n` 分隔"，
       原先按空行合并 ⇒ 整篇挤成**一个** `<p>`，换行全靠 `white-space: pre-wrap` 兜着 ——
       用户实测「就连能渲染的 word 都连正常换行都不会」。
       ⇒ 现在换行是**结构**（每行一个块），不依赖任何 CSS 属性，也不怕段落文本里混进长行。
       ⚠️ `[表格 N 个]` 是 doc_text.ts 的结构提示，**不是正文**（渲染成一行莫名其妙的文字
       会让人以为抽取坏了）。 */
    if (line.trim() && !TABLE_HINT_RE.test(line.trim())) {
      out.push({ type: "para", text: line });
    }
    i += 1;                                    // ← 前进（吃掉一行）
  }
  return out;
}
