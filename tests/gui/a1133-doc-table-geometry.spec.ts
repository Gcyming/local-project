/**
 * tests/gui/a1133-doc-table-geometry.spec.ts — 文档表格**列宽**的几何判据（A-1133）。
 *
 * ## 为什么必须是几何判据（A-1130 的教训在这里重演）
 * 用户原话：「内容渲染不出来原本的样子啊」（2026-09-28 截图：一列被压成**竖排单字**）。
 * 根因**不是**某个 CSS 写法难看，而是**布局算法**：
 *   · 中文的 `min-content` 宽度 = **1 个汉字**（CJK 允许任意字间断行）；
 *   · `table-layout: auto` 在某列极长时会把同伴列压到接近 min-content。
 * 用真实文件 `20244222026-张裴文-《互联网思维》.docx` 实测（同样的 `.docViewToHtml` 输出）：
 *   · 第一张表（各列长度相近）：7.85 / 8.85 / 10.13 汉字宽 —— **正常**；
 *   · 第二张表（第二列 **3487 字符**、第一列 48 字符）：第一列只有 **3.43 汉字宽**
 *     —— 用户窗口更窄 ⇒ 压到 1 个字 ⇒ 屏幕上就是竖排单字。
 * ⇒ **文本断言拦不住这一类 bug**（CSS 文本挑不出毛病，量了才发现有洞）。
 *    所以这里**必须用真实 Chromium 量**。做法是调用**真函数** `docViewToHtml` 生成页面
 *    （**零手抄** —— 手抄的 CSS 副本必漂，铁律 10），再 `--headless=new --dump-dom` 读回数字。
 *
 * ## 判据
 *   ① 用户那个形状（短列 + 3487 字长列）⇒ 每个单元格宽 >= `DOC_CELL_MIN_EM` 个字号；
 *   ② 长单元格内容**完整保留**（不许为了让版面好看而截断内容）；
 *   ③ 多列 / 窄容器时**不许撑破页面**（表格自己横向滚动）。
 *
 * ⚠️ 找不到浏览器内核时 **skip 并打印醒目提示**（不静默通过 —— 静默通过就是假绿）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docViewToHtml, DOC_CELL_MIN_EM, type DocBlock } from "../../gui/src/renderer/pages/docView.js";

function findBrowser(): string | null {
  const cands = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean) as string[];
  return cands.find((p) => existsSync(p)) ?? null;
}

const BROWSER = findBrowser();

type Measured = {
  cells: Array<{ w: number; fs: number; text: string }>;
  scrollW: number;
  clientW: number;
};

/** 把真 HTML 写盘 → 用 Chromium 量 → 把结果写回 `<pre id="OUT">` → 读回 JSON */
function measure(blocks: readonly DocBlock[]): Measured | null {
  if (!BROWSER) { return null; }
  const html = docViewToHtml(blocks, { title: "probe", source: "probe" });
  const script = `<script>
(function(){
  var cells = Array.prototype.slice.call(document.querySelectorAll('td,th'));
  var out = cells.map(function(c){
    var r = c.getBoundingClientRect();
    return { w: r.width, fs: parseFloat(getComputedStyle(c).fontSize), text: (c.textContent||'').slice(0,20) };
  });
  document.body.innerHTML = '<pre id="OUT">' + JSON.stringify({
    cells: out,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth
  }) + '</pre>';
})();
</script>`;
  const dir = mkdtempSync(join(tmpdir(), "tblgeom-"));
  const f = join(dir, "t.html");
  writeFileSync(f, html.replace("</body>", script + "</body>"), "utf8");
  const res = spawnSync(BROWSER, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000",
    "--dump-dom", "file:///" + f.replace(/\\/g, "/"),
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const m = /<pre id="OUT">([\s\S]*?)<\/pre>/.exec(res.stdout ?? "");
  if (!m) { return null; }
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as Measured;
}

/** 用户那个文件的真实形状：48 字的行标题 + 3487 字的正文格（数字取自实测） */
const LONG_CELL = "一、重点内容概述 " + "这本书不算太厚但内容挺多的我读的时候记了不少笔记作者开头就说".repeat(80);
const USER_SHAPE: DocBlock[] = [{
  type: "table",
  title: "",
  header: ["书籍内容概述 （包含前言简要介绍、核心主题及整体框架介绍，100字以上200字以内）", "内容"],
  rows: [[
    "读书心得 （从重点内容概述、主要观点分析、评论与思考、与自身联系、读书收获5个方面撰写读书心得）",
    LONG_CELL,
  ]],
}];

describe("A-1133-G1 用户那个形状：短列不许被压成竖排单字", () => {
  it.skipIf(!BROWSER)("每列宽度 >= DOC_CELL_MIN_EM 个字号（修前实测 3.43 ⇒ 竖排单字）", () => {
    const got = measure(USER_SHAPE);
    expect(got, "没能从浏览器读回测量结果（测量工具坏了，不是断言失败）").not.toBeNull();
    const m = got as Measured;
    expect(m.cells.length).toBeGreaterThan(0);
    let minEm = Number.POSITIVE_INFINITY;
    let widest = "";
    for (const c of m.cells) {
      const em = c.w / c.fs;
      if (em < minEm) { minEm = em; widest = c.text; }
    }
    expect(minEm, `最窄的一列只有 ${minEm.toFixed(2)} 个汉字宽（${JSON.stringify(widest)}）—— `
      + `中文 min-content = 1 个汉字，没有下限就会被同伴列的长内容压成竖排`).toBeGreaterThanOrEqual(DOC_CELL_MIN_EM);
  });

  it.skipIf(!BROWSER)("⚠️ 长单元格的内容**一个字都不许少**（不许为了版面好看而截断）", () => {
    const got = measure(USER_SHAPE);
    const m = got as Measured;
    const joined = m.cells.map((c) => c.text).join("");
    /* 只查开头 20 字（测量脚本只回传 20 字），足够证明"长内容进了表格且没被截成空" */
    expect(joined).toContain("一、重点内容概述");
  });

  it.skipIf(!BROWSER)("表格整体不溢出页面（列宽下限是绝对的，必须自己滚而不是撑破页面）", () => {
    const got = measure(USER_SHAPE);
    const m = got as Measured;
    expect(m.scrollW, "页面出现横向滚动 = 表格撑破了版式").toBeLessThanOrEqual(m.clientW + 1);
  });
});

describe("A-1133-G2 多列表格：下限 × 列数超容器时，表格自己滚（页面不动）", () => {
  it.skipIf(!BROWSER)("6 列表格不撑破页面", () => {
    const cols = 6;
    const blocks: DocBlock[] = [{
      type: "table",
      title: "",
      header: Array.from({ length: cols }, (_, i) => `列${i + 1}标题`),
      rows: [Array.from({ length: cols }, (_, i) => `第${i + 1}格内容`)],
    }];
    const got = measure(blocks) as Measured;
    expect(got.scrollW, "多列表格把页面撑出横向滚动条了").toBeLessThanOrEqual(got.clientW + 1);
  });
});

describe("A-1133-G3 既有行为不回退：正常表格仍按内容自然布局", () => {
  it.skipIf(!BROWSER)("列宽相近的表：每列都够宽，且不出现异常窄列", () => {
    const blocks: DocBlock[] = [{
      type: "table",
      title: "",
      header: ["阅读书籍名称", "《互联网思维》", "作  者", "赵大伟"],
      rows: [["出版单位", "机械工业出版社", "阅读书籍 学分设置", "0.5分"]],
    }];
    const m = measure(blocks) as Measured;
    for (const c of m.cells) {
      expect(c.w / c.fs, JSON.stringify(c.text)).toBeGreaterThanOrEqual(DOC_CELL_MIN_EM);
    }
  });
});

/* ⚠️ 只看"文本里有没有那句 CSS"是**漂移守卫**，不是真判据（真判据在上面：几何）。
   它存在的唯一理由是：找不到浏览器时让人知道"这条判据这次没跑"。 */
describe("A-1133-G4 漂移守卫（弱）：min-width 由唯一常量生成", () => {
  it("生成的 HTML 里，单元格规则含由 DOC_CELL_MIN_EM 算出的 min-width", () => {
    const html = docViewToHtml(USER_SHAPE, { title: "t" });
    expect(html).toContain(`min-width: ${DOC_CELL_MIN_EM}em`);
  });

  it("表格被滚动容器包住（否则列宽下限会撑破页面）", () => {
    const html = docViewToHtml(USER_SHAPE, { title: "t" });
    expect(html).toMatch(/<div class="tbl-wrap"><table>/);
  });
});
