/**
 * tests/gui/a1135-native-preview.spec.ts — 「HTML 网页预览」的**原生样貌**判据（A-1135）。
 *
 * ## 用户原话（2026-09-28 截图打回）
 * 「我要的是那种类似以图片的形式直接用 HTML 用 Web 预览的功能，**而非转成 md 文件阅读**」
 * 「你看这是原生内容吗？」
 *
 * 被拍的两个形态（都在截图上）：
 *   ① PPT 页 = 「一段长文本套个框」，和 Markdown 阅读没区别；
 *   ② docx 第二张表的第一列被压成**竖排单字**（`中文 min-content = 1 个汉字`）。
 *
 * ## 本文件守什么（**结构**判据；几何判据在 `a1133-doc-table-geometry.spec.ts`）
 *   ① 页面有**纸张壳**（`.page-shell`）—— 不是"白底平铺的一坨文字"；
 *   ② PPT 页 = `.slide` + `.slide-head`(页码徽标) + `.slide-body`，**首行升级成 `<h3>` 标题**；
 *   ③ 表格有**滚动容器** `.tbl-wrap`，单元格有 `min-width` 下限（几何真判据在 1133 那条）；
 *   ④ **不许有**"关键词过滤"把真实正文降级 —— 这是本轮**实测推翻**的一版设计（见下）。
 *
 * ⚠️ ④ 为什么必须写成判据：我最初加了一套 `isSlidePlaceholder`（含「单击此处/在此输入」就降级），
 *    实测两头都不对：**(a)** 实测 `jeny_第二章.ppt` 抽出的 841 行里「单击此处」出现 **0 次**
 *    （抽取层 `collectPptSlides` 已按 `Slide` 容器排除）⇒ 那套代码**从未生效**；
 *    **(b)** 它会把 `实验步骤：点击此处开始采集数据` 这类**真实正文**降级成小字脚注
 *    —— **用户的内容被藏起来**，比不降级更坏。
 *    ⇒ 判据锁死"渲染层不做关键词过滤"这件事，防止有人再"好心"加回来。
 *
 * ⚠️ 不锚"文件里第 N 处"（铁律 §3）：用 `docViewToHtml` 的**真函数**产出 HTML 再断言结构，
 *    零手抄 CSS —— 手抄副本必漂（铁律 10）。
 */
import { describe, expect, it } from "vitest";
import { buildDocView, docViewToHtml, DOC_CELL_MIN_EM, type DocBlock } from "../../gui/src/renderer/pages/docView.js";

const html = (blocks: readonly DocBlock[], title = "t.docx"): string =>
  docViewToHtml(blocks, { title, source: "C:/x/" + title });

describe("A-1135 ① 纸张壳：像一份文档，不是白底平铺", () => {
  it("有 .page-shell 容器，且正文都在它里面", () => {
    const h = html([{ type: "para", text: "正文一段" }]);
    expect(h).toContain('class="page-shell"');
    const shellAt = h.indexOf('class="page-shell"');
    const pAt = h.indexOf("<p>正文一段</p>");
    expect(pAt).toBeGreaterThan(shellAt);
  });

  it("页面背景与纸面**不同色**（有「纸」的层次，不是一片白）", () => {
    const h = html([{ type: "para", text: "x" }]);
    /* 断言的是"两处背景声明都存在且引用了不同的变量"——不是断言具体色值（色值会调） */
    expect(h).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
    expect(h).toMatch(/\.page-shell\s*\{[^}]*background:\s*var\(--paper\)/);
  });
});

describe("A-1135 ② PPT：一页 = 一块纸面 + 首行升级为标题", () => {
  const page = (lines: string[], label = "第 1 页"): DocBlock => ({ type: "page", label, lines });

  it("页容器 / 页头 / 页体 / 页码徽标 四件套齐全", () => {
    const h = html([page(["数字信号处理", "学院：人工智能学院", "授课人：李月贞"])]);
    expect(h).toContain('class="slide"');
    expect(h).toContain('class="slide-head"');
    expect(h).toContain('class="slide-no"');
    expect(h).toContain('class="slide-body"');
    expect(h).toContain("#1");                       // 页码徽标里的数字
  });

  it("**首行是标题**（<h3>），其余是正文（<p>）—— 不是一整块 <pre>", () => {
    const h = html([page(["数字信号处理", "学院：人工智能学院"])]);
    expect(h).toContain("<h3>数字信号处理</h3>");     // ← 旧实现这里是个大 pre
    expect(h).toContain("<p>学院：人工智能学院</p>");
    expect(h).not.toContain("<pre");                  // ← 旧实现的形态，不许回来
  });

  it("首行超长 / 带句末标点时**不**当标题（正文行会误判）", () => {
    /* 阈值 40 与句末标点都是**实测**定的（204 页真课件，见 docView.ts 注释）：
       · ppt 那份首行中位数 12、最大 32 ⇒ 40 字不会误伤真标题；
       · pptx 那份有一条 78 字的正文行当了首行 ⇒ 必须靠长度挡住。 */
    const long = "EDA工具应用：以Quartus II为该课程的开发软件，完整的介绍整个EDA开发设计的流程，包括项目建立、程序输入与编译、仿真测试、引脚锁定与硬件测试等。";
    expect(long.length).toBeGreaterThan(40);              // 夹具自查：别自己数错
    const h = html([page([long, "2-1 傅里叶变换的定义"])]);
    expect(h).not.toContain("<h3>");
    expect(h).toContain(`<p>${long}</p>`);
  });

  it("首行短但**带句末标点** → 也不当标题", () => {
    const h = html([page(["这句话有句号所以是正文。", "下一行"])]);
    expect(h).not.toContain("<h3>");
    expect(h).toContain("<p>这句话有句号所以是正文。</p>");
  });

  it("空页也画一张纸面（页序完整 —— 不许静默少一页）", () => {
    const h = html([page([]), page(["标题"], "第 2 页")]);
    expect(h.match(/class="slide"/g) ?? []).toHaveLength(2);
  });
});

describe("A-1135 ③ 表格：滚动容器 + 单元格下限", () => {
  it("表格被 .tbl-wrap 包住（窄容器时自己滚，不撑破页面）", () => {
    const h = html([{ type: "table", title: "", header: ["甲", "乙"], rows: [["1", "2"]] }]);
    expect(h).toContain('<div class="tbl-wrap"><table>');
  });

  it("单元格 min-width 引用唯一产地 DOC_CELL_MIN_EM（不许各写一份）", () => {
    const h = html([{ type: "table", title: "", header: ["甲"], rows: [["1"]] }]);
    expect(h).toContain(`min-width: ${DOC_CELL_MIN_EM}em`);
  });
});

describe("A-1135 ④ 渲染层**不做**关键词过滤（实测推翻的版本，锁死防回归）", () => {
  /**
   * ⚠️ 这条判据守的是"**不许再犯**"——我自己犯过一次（见文件头）。
   *    判据写法：把那些会触发旧关键词判据的文本喂进去，**必须原样出现在正文里**。
   */
  const looksLikePlaceholder = [
    "单击此处编辑母版标题样式",
    "在此键入搜索关键字后回车",
    "实验步骤：点击此处开始采集数据",
  ];

  it("这些文本**必须原样渲染**（旧实现会把它们降级/吃掉）", () => {
    const h = html([{ type: "page", label: "第 1 页", lines: ["标题", ...looksLikePlaceholder] }]);
    for (const t of looksLikePlaceholder) {
      expect(h, `被过滤掉了：${t}`).toContain(`<p>${t}</p>`);
    }
  });

  it("渲染层不再有 .ph 之类的「占位符脚注」产物", () => {
    const h = html([{ type: "page", label: "第 1 页", lines: looksLikePlaceholder }]);
    expect(h).not.toContain('class="ph"');
  });
});

describe("A-1135 ⑤ 转义与自包含（离线可用的前提）", () => {
  it("正文里的 < & \" 必须转义（不转义会被当标签吃掉，内容静默少一截）", () => {
    const h = html([{ type: "para", text: 'a < b & c "d" <script>' }]);
    expect(h).toContain("a &lt; b &amp; c &quot;d&quot; &lt;script&gt;");
    expect(h).not.toContain("<script>");
  });

  it("自包含：不引外网 CSS/字体（离线可用、不违 CSP）", () => {
    const h = html([{ type: "para", text: "x" }]);
    expect(h).not.toMatch(/<link[^>]+href=["']https?:/);
    expect(h).not.toMatch(/@import\s+url\(["']?https?:/);
  });
});

describe("A-1135 ⑥ 块化不回归（上几轮修过的形状）", () => {
  it("word：一行一块，换行是**结构**不是 CSS 兜的", () => {
    const blocks = buildDocView("word", "第一段\n第二段\n第三段");
    expect(blocks.filter((b) => b.type === "para")).toHaveLength(3);
  });

  it("word：连续同列数的 | 行 → 真表格", () => {
    const blocks = buildDocView("word", "甲 | 乙 | 丙\n1 | 2 | 3");
    const t = blocks.find((b) => b.type === "table");
    expect(t).toBeTruthy();
  });

  it("旧版/新版 PPT 的页标记形状一致（`pptPageMarker` 是唯一产地）", () => {
    const blocks = buildDocView("powerpoint", "--- 第 1 页 ---\n甲\n--- 第 2 页 ---\n乙");
    expect(blocks.filter((b) => b.type === "page")).toHaveLength(2);
  });
});
