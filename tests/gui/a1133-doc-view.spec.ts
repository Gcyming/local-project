/**
 * tests/gui/a1133-doc-view.spec.ts — 「文档文本 → 结构化块」的守卫（A-1133）。
 *
 * 用户原话：「右侧边栏给我想办法显示正确内容，我记得网页是可以显示的吧？」
 * —— 对：业界主流是"把 Office 转成 HTML 让浏览器画"（路线一）。本仓零依赖地做同一件事：
 * 把 `doc_text.ts` 抽出的**带轻结构文本**渲染成**真表格 / 分页卡片 / 段落**。
 *
 * ⚠️ 判据必须与 `doc_text.ts` 的**实际输出形状**对齐（唯一产地）—— 所以本文件的夹具
 * 用的就是它真实产出的形状（`## 表：Sheet1` + 列字母行 + ` | ` 网格；`--- 第 N 页 ---`）。
 */
import { describe, expect, it } from "vitest";
import { buildDocView, docViewToHtml } from "../../gui/src/renderer/pages/docView.js";

describe("A-1133-A excel：网格文本必须变成**真表格**", () => {
  it("识别 `## 表：<sheet>` 标题、列字母行作表头、其余作数据行", () => {
    /* 这是 `doc_text.ts` 的 xlsx 分支**实测产出**的形状（见 office-doc-write.spec.ts 的 round-trip）。 */
    const src = "## 表：Sheet1\nA | B\n城市 | 人口\n北京 | 2189\n上海 | 2487";
    const blocks = buildDocView("excel", src);
    expect(blocks).toHaveLength(1);
    const t = blocks[0];
    expect(t.type).toBe("table");
    if (t.type !== "table") { return; }
    expect(t.title).toBe("Sheet1");
    expect(t.header, "列字母行是坐标提示，要当表头而不是数据").toEqual(["A", "B"]);
    expect(t.rows, "数据行逐行还原（单元格别被 ` | ` 粘成一格）").toEqual([["城市", "人口"], ["北京", "2189"], ["上海", "2487"]]);
  });

  it("多个 sheet 各成一张表（不许把两张表并成一张）", () => {
    const src = "## 表：一月\nA\n1\n## 表：二月\nA\n2";
    const blocks = buildDocView("excel", src);
    expect(blocks.map((b) => (b.type === "table" ? b.title : b.type))).toEqual(["一月", "二月"]);
  });

  it("空表也保留（表存在这件事本身就是信息，不该被吞掉）", () => {
    const blocks = buildDocView("excel", "## 表：空表\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
  });

  it("单元格里的空格不被误当分隔符（只有 ` | ` 才是分隔）", () => {
    const blocks = buildDocView("excel", "## 表：t\nA | B\nhello world | x");
    const t = blocks[0];
    if (t.type !== "table") { throw new Error("应当解析成表"); }
    expect(t.rows[0]).toEqual(["hello world", "x"]);
  });
});

describe("A-1133-B powerpoint：必须按**页**分卡片（页边界是这一族唯一的结构）", () => {  it("`--- 第 N 页 ---` 分段，每段一块", () => {
    const src = "--- 第 1 页 ---\n封面\n要点一\n\n--- 第 2 页 ---\n正文段";
    const blocks = buildDocView("powerpoint", src);
    expect(blocks).toHaveLength(2);
    const [p1, p2] = blocks;
    expect(p1.type === "page" && p1.label).toBe("第 1 页");
    expect(p1.type === "page" && p1.lines).toEqual(["封面", "要点一"]);
    expect(p2.type === "page" && p2.lines).toEqual(["正文段"]);
  });

  it("没有分页标记时也要产出内容（不能因为没标记就显示空白）", () => {
    const blocks = buildDocView("powerpoint", "只有一段文字");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type === "page" && blocks[0].lines).toEqual(["只有一段文字"]);
  });
});

describe("A-1133-C word / pdf / 纯文本：空行分段", () => {
  it("docx 的「一段一行」不会粘成一大段", () => {
    const blocks = buildDocView("word", "第一段\n\n第二段");
    expect(blocks.map((b) => (b.type === "para" ? b.text : ""))).toEqual(["第一段", "第二段"]);
  });

  /* ⚠️ A-1133 迁移（用户实测「就连能渲染的 word 都连正常换行都不会」）：
     原先「按空行分段」会把整篇挤成**一个** `<p>`，换行只靠 `white-space: pre-wrap` 兜着。
     现在**一行一块** ⇒ 换行是结构，不依赖任何 CSS。判据因此从「合在一起」改成「逐行分开」。 */
  it("相邻非空行**各自成块**（换行是结构，不靠 CSS 的 pre-wrap 兜）", () => {
    const blocks = buildDocView("pdf", "第一行\n第二行\n\n下一段");
    expect(blocks.map((b) => (b.type === "para" ? b.text : ""))).toEqual(["第一行", "第二行", "下一段"]);
  });

  it("空输入 → 空块列表（渲染层据此显示「没有可显示的文本」而不是空白页）", () => {
    expect(buildDocView("word", "")).toEqual([]);
    expect(buildDocView("word", "   \n\n  ")).toEqual([]);
  });

  it("CRLF 归一（Windows 文档到处是 \\r\\n，不归一会把段落粘一起）", () => {
    const blocks = buildDocView("word", "第一段\r\n\r\n第二段");
    expect(blocks).toHaveLength(2);
  });
});

describe("A-1133-D docx 的表格（用户截图里没变成表格的那一处）", () => {
  it("`[表格 N 个]` 提示 + 含 ` | ` 的连续行 ⇒ **真表格**，提示行不进正文", () => {
    /* 这是 `doc_text.ts` 的 docx 分支**实测产出**的形状（用户截图里那一块）。 */
    const src = [
      "[表格 1 个]",
      "阅读书籍基本信息",
      "阅读书籍名称 | 《互联网思维》 | 作者 | 赵大伟",
      "出版单位 | 机械工业出版社 | 阅读书籍 学分设置 | 0.5分",
    ].join("\n");
    const blocks = buildDocView("word", src);
    const tables = blocks.filter((b) => b.type === "table");
    expect(tables, "含 ` | ` 的连续行必须变成表格，否则用户看到的还是行文本（被当场拍到）").toHaveLength(1);
    const t = tables[0];
    if (t.type !== "table") { return; }
    expect(t.header).toEqual(["阅读书籍名称", "《互联网思维》", "作者", "赵大伟"]);
    expect(t.rows).toEqual([["出版单位", "机械工业出版社", "阅读书籍 学分设置", "0.5分"]]);
    /* ⚠️ `[表格 N 个]` 是结构提示，不是正文：渲染成一行莫名其妙的文字会让人以为抽取坏了。 */
    expect(blocks.some((b) => b.type === "para" && b.text.includes("[表格")), "提示行不许当正文").toBe(false);
  });

  it("列数不一致的行**不**并进同一张表（避免把正文里恰好带竖线的两行误判成表）", () => {
    const src = "a | b\nc | d | e";
    const tables = buildDocView("word", src).filter((b) => b.type === "table");
    expect(tables, "单行/列数不一致 ⇒ 不成表").toHaveLength(0);
  });

  it("单独一行含竖线不成表（≥2 行才算）", () => {
    expect(buildDocView("word", "标题 | 副标题").filter((b) => b.type === "table")).toHaveLength(0);
  });
});

describe("A-1133-E docViewToHtml：转成自包含 HTML（路线一落地）", () => {
  const opts = { title: "报告.docx", source: "D:/x/报告.docx" };

  it("块 → HTML：段落/表格/页卡片都有对应标签，且表格有表头行", () => {
    const html = docViewToHtml([
      { type: "para", text: "第一段" },
      { type: "table", title: "表一", header: ["A", "B"], rows: [["1", "2"]] },
      { type: "page", label: "第 1 页", lines: ["要点"] },
    ], opts);
    expect(html).toContain("<p>第一段</p>");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<caption>表一</caption>");
    expect(html).toContain("第 1 页");
  });

  it("⚠️ 所有文本必须转义（正文里的 `<` `&` 是常态：代码片段/公式，不转义会被浏览器当标签吃掉）", () => {
    const html = docViewToHtml([{ type: "para", text: "if (a < b && c > d) { x(); }" }], opts);
    expect(html).toContain("a &lt; b &amp;&amp; c &gt; d");
    expect(html, "未转义的 `<` 会变成真标签 ⇒ 内容静默丢失").not.toContain("< b &&");
  });

  it("自包含：不引外网资源（离线可用 + 不违反 CSP）", () => {
    const html = docViewToHtml([{ type: "para", text: "x" }], opts);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).toContain("<style>");
  });

  it("标题也转义（文件名里出现 `&` 很常见）", () => {
    const html = docViewToHtml([], { title: "A & B <x>.docx" });
    expect(html).toContain("A &amp; B &lt;x&gt;.docx");
  });
});
