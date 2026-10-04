






















export type DocBlock =
  | { type: "page"; label: string; lines: string[] }
  | { type: "table"; title: string; header: string[]; rows: string[][] }
  | { type: "para"; text: string };


const CELL_SEP = /\s+\|\s+/;
















export const DOC_CELL_MIN_EM = 5;


const TABLE_HINT_RE = /^\[表格\s*\d+\s*个\]$/;

const PAGE_RE = /^-{2,}\s*(第\s*\d+\s*页)\s*-{2,}$/;

const SHEET_RE = /^#{1,6}\s*表[:：]\s*(.+?)\s*$/;

const COL_LETTERS_RE = /^[A-Z]{1,3}(\s*\|\s*[A-Z]{1,3})*$/;

const isTableRow = (line: string): boolean => CELL_SEP.test(line);





export function buildDocView(kind: string, text: string): DocBlock[] {
  const src = (text ?? "").replace(/\r\n?/g, "\n");
  if (!src.trim()) { return []; }

  if (kind === "excel") { return excelBlocks(src); }
  if (kind === "powerpoint") { return pageBlocks(src); }
  return paragraphBlocks(src);
}













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
      


      return `<div class="tbl-wrap"><table>${cap}${head}<tbody>${rows}</tbody></table></div>`;
    }
    

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



















function slideHtml(
  b: { label: string; lines: readonly string[] },
  esc: (s: string) => string,
): string {
  const no = (/第\s*(\d+)\s*页/.exec(b.label)?.[1] ?? "").trim();
  const content = b.lines.map((l) => l.trim()).filter(Boolean);

  








  const first = content[0] ?? "";
  const hasTitle = first.length > 0 && first.length <= 40 && !/[。；！？]$/.test(first);
  const heading = hasTitle ? first : "";
  const bodyLines = hasTitle ? content.slice(1) : content;
  
  const head = `<div class="slide-head">${no ? `<span class="slide-no">#${esc(no)}</span>` : ""}` +
    `<h2>${esc(b.label)}</h2></div>`;
  const bodyParts: string[] = [];
  if (heading) { bodyParts.push(`<h3>${esc(heading)}</h3>`); }
  for (const line of bodyLines) { bodyParts.push(`<p>${esc(line)}</p>`); }
  return `<section class="slide">${head}<div class="slide-body">${bodyParts.join("")}</div></section>`;
}
























function excelBlocks(src: string): DocBlock[] {
  const out: DocBlock[] = [];
  let cur: { type: "table"; title: string; header: string[]; rows: string[][] } | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const sheet = SHEET_RE.exec(line);
    if (sheet) {
      if (cur) { out.push(cur); }
      

      cur = { type: "table", title: sheet[1], header: [], rows: [] };
      continue;
    }
    if (!line) { continue; }
    const cells = line.split(CELL_SEP).map((c) => c.trim());
    if (!cur) {
      
      cur = { type: "table", title: "", header: [], rows: [] };
    }
    if (cur.header.length === 0 && cur.rows.length === 0 && line.split(CELL_SEP).every((c) => COL_LETTERS_RE.test(c.trim()))) {
      cur.header = cells;                    
      continue;
    }
    cur.rows.push(cells);
  }
  if (cur) { out.push(cur); }
  return out;
}


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
      i = j;                                   
      continue;
    }
    const line = lines[i];
    





    if (line.trim() && !TABLE_HINT_RE.test(line.trim())) {
      out.push({ type: "para", text: line });
    }
    i += 1;                                    
  }
  return out;
}
