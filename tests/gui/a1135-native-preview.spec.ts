


























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
    expect(h).toContain("#1");                       
  });

  it("**首行是标题**（<h3>），其余是正文（<p>）—— 不是一整块 <pre>", () => {
    const h = html([page(["数字信号处理", "学院：人工智能学院"])]);
    expect(h).toContain("<h3>数字信号处理</h3>");     
    expect(h).toContain("<p>学院：人工智能学院</p>");
    expect(h).not.toContain("<pre");                  
  });

  it("首行超长 / 带句末标点时**不**当标题（正文行会误判）", () => {
    


    const long = "EDA工具应用：以Quartus II为该课程的开发软件，完整的介绍整个EDA开发设计的流程，包括项目建立、程序输入与编译、仿真测试、引脚锁定与硬件测试等。";
    expect(long.length).toBeGreaterThan(40);              
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
