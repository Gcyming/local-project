/**
 * a1105-md-guards.spec.ts — A-1105：**子代理弹层（SubAgentModal）的 markdown 渲染失效**。
 *
 * ## 用户报障（截图 = 子代理详情弹层）
 *
 *   ① 「任务」气泡里 `1.` 十项编号与 `- ` 三项项目符号**不成列表**（浏览器每行都从「1.」重编号）；
 *   ② 「输出结果」气泡里那张表**整块纯文本显示、管道符裸露**。
 *
 * ## 根因（两处，都在 `normalizeMarkdownBlocks` 里 —— 截图读不出来，只有原文 + 真渲染器能答）
 *
 *  ① `unjamOneLine` 第 3 步「行内标题解塞」把**表格表头单元格里的 `#` 当成了标题标记**：
 *     `| # | 目标 | 结果 |` 被拆成 `| ` + `# | 目标 | 结果 |` ⇒ 表头行变标题、
 *     分隔行与数据行并成段落 ⇒ 表格当场解体（`has <table>? false`）。
 *     markdown 表头首列叫「#」（序号列）是**极常见写法**，故命中面很宽。
 *  ② `normalizeMarkdownBlocks` 给**每一个**块标记行前补空行 ⇒ 每个列表项都被空行切开 ⇒
 *     `parseBlocks` 的列表分支（`para.every(是列表项)`）永远只拿到 1 项 ⇒ 产出 N 个各含
 *     1 项的 `<ol>`/`<ul>`（实测 TASK 渲染出 **10 个 `<ol>` + 3 个 `<ul>`**）。
 *
 * ⚠️ 诊断纪律：我起初从**截图肉眼**读结构，得出「表格第一行就是分隔行、列数不齐」——**错**。
 *    磁盘原文证明表头存在且列数一致。**渲染结构只能从原文 + 真渲染器 dump 取。**
 *
 * ## 判据为什么是「计数」而不是「包含」
 *
 *   `toContain("<table")` 对**修好前也不疼**的样本照样绿（旧代码里 `| 序 |` 这类表头本来就对）。
 *   事故形态的特征是「**数量**不对」：0 个 table / N 个单元素列表 / 多出一个伪标题
 *   ⇒ 判据必须是**计数**，并配 ⑦ 的自检（喂已知阳/阴样本）证明计数判据本身有效 ——
 *   否则把 `count` 写成恒 0 的假守卫也会全绿（§15① 最危险的一种）。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { normalizeMarkdownBlocks } from "../../gui/src/renderer/pages/Markdown.js";

const html = (t: string, streaming = false): string =>
  renderToStaticMarkup(createElement(Markdown, { text: t, streaming }));

/** 计数判据：某个标签出现了几次（端到端 HTML 上的**结构**计数） */
const count = (h: string, tag: string): number => (h.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
/** 伪标题计数：`#` 被误当标题标记后的产物（`renderBlock` 的 heading 分支） */
const heads = (h: string): number => (h.match(/font-weight:700/g) ?? []).length;
const hasTable = (h: string): boolean => h.includes("border-collapse:collapse");

describe("A-1105① 表格表头单元格里的 `#` 是内容，不是标题标记", () => {
  /** 每一例：`cols` 列 × 2 行（表头 + 1 数据行） */
  const CASES: Array<{ name: string; src: string; cols: number }> = [
    {
      name: "表头首列就是 `#`（用户截图那一张的形态）",
      src: "| # | 目标 | 结果 |\n|---|------|------|\n| 1 | `_debug_boot_home.html` | ❌ 无法删除（无删除工具） |",
      cols: 3,
    },
    { name: "表头 `# 序`", src: "| # 序 | 目标 |\n|---|------|\n| 1 | a |", cols: 2 },
    {
      // ⚠️ 这一例是**右**边界（「标记后不是 空白+`|`」）唯一的承载者：左边界（「最近非空白不是 `|`」）
      //    在这里是**放行**的（`#` 前是 `号 `）—— 撤掉右边界，本例会退化成「表头变标题 + 表格解体」。
      //    首轮变异 M2（只抹右边界）逃逸，就是因为它当时没有样本 ⇒ 补上后 M2 才被捕获。
      name: "表头单元格**以 `#` 结尾**（`| 序号 # |`）",
      src: "| 序号 # | 目标 |\n|---|------|\n| 1 | a |",
      cols: 2,
    },
    { name: "表头 `#` 两侧多空格", src: "|   #   | 目标 |\n|---|------|\n| 1 | a |", cols: 2 },
    { name: "表头 `##`", src: "| ## | 任务 |\n|---|------|\n| 1 | a |", cols: 2 },
  ];

  for (const c of CASES) {
    it(`${c.name} → 仍是真表格（表头不解体）`, () => {
      const h = html(c.src);
      expect(hasTable(h)).toBe(true);
      expect(count(h, "table")).toBe(1);
      expect(count(h, "td")).toBe(c.cols * 2);
      // 表头行没被当成标题 ⇒ 不得出现伪标题块，管道符不得裸露
      expect(heads(h)).toBe(0);
      expect(h).not.toContain("|---|");
      expect(h).not.toContain("| 目标 |");
    });
  }

  it("`#` 的标题解塞能力不回归（A-9xx：行内 `## ` 仍要拆出来）", () => {
    expect(normalizeMarkdownBlocks("正文 ## 标题")).toBe("正文\n\n## 标题");
    expect(normalizeMarkdownBlocks("报告：--- ## 标题")).toBe("报告：\n\n---\n\n## 标题");
    expect(normalizeMarkdownBlocks("| V | --- ## 🔍 调研")).toBe("| V |\n\n---\n\n## 🔍 调研");
    // `C#` / `x#` 一直不拆（标记前是字母数字下划线 ⇒ 不是标题）
    expect(normalizeMarkdownBlocks("C# 语言 x# y")).toBe("C# 语言 x# y");
    // 右边界：`##` 被 `\s*|` 收口（粘着一根管道）⇒ 是表格片段而不是标题，不拆
    expect(normalizeMarkdownBlocks("正文 ## | 表格 |")).toBe("正文 ## | 表格 |");
  });

  it("完好的普通表格不受影响", () => {
    const h = html("| 特性 | 说明 |\n|---|---|\n| 本地 | ✅ |");
    expect(count(h, "table")).toBe(1);
    expect(count(h, "td")).toBe(4);
    expect(heads(h)).toBe(0);
  });
});

describe("A-1105② 连续列表项是「一个列表」，不是「每行一个列表」", () => {
  it("`1.` 十项 → **一个** `<ol>` / 十个 `<li>`（此前是十个各含 1 项的 `<ol>`）", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. 目标文件 ${i + 1}`);
    const h = html(items.join("\n"));
    expect(count(h, "ol")).toBe(1);
    expect(count(h, "li")).toBe(10);
    expect(h).not.toContain("1. 目标文件 1"); // 编号由 `<ol>` 出，不该出现在正文里
  });

  it("`- ` 三项 → **一个** `<ul>` / 三个 `<li>`（此前是三个各含 1 项的 `<ul>`）", () => {
    const h = html(["- 只删上面这 10 项", "- 不许删除其他文件", "- 没有能力就如实返回"].join("\n"));
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "li")).toBe(3);
    expect(h).not.toContain("- 只删上面这 10 项"); // 项目符号由 `<ul>` 出
  });

  it("用户实测形态（真实 TASK 结构）→ 1 个 `<ol>`(10 项) + 1 个 `<ul>`(3 项)", () => {
    const src = [
      "目标：在本地文件系统删除以下调试残留文件（位于 `D:\\试验场\\deepseek_gateway\\` 目录）：",
      ...Array.from({ length: 10 }, (_, i) => `${i + 1}. _debug_${i}.json`),
      "",
      "边界（严格遵守）：",
      "- 只删上面这 10 项，逐项尝试删除，不存在的跳过并记录「不存在」",
      "- 绝对不许删除或修改目录中的任何其他文件",
      "- 如果你没有删除文件的能力，直接如实返回「无法删除」",
      "",
      "输出格式：逐项列出每个文件的处理结果（已删除 / 不存在 / 无法删除及原因），最后给一行总结。",
    ].join("\n");
    const h = html(src);
    expect(count(h, "ol")).toBe(1);
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "li")).toBe(13);
    expect(h).toContain("边界（严格遵守）："); // 尾部正文仍是独立段落
    expect(h).toContain("输出格式：");
  });

  it("散文/标题之后接列表 → 仍被隔断（列表不会被并进段落）", () => {
    const h = html(["说明：", "- a", "- b"].join("\n"));
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "li")).toBe(2);
    expect(h).toContain("说明：");

    const h2 = html(["## 小节", "- a", "- b"].join("\n"));
    expect(count(h2, "ul")).toBe(1);
    expect(count(h2, "li")).toBe(2);
  });

  it("列表项之后紧跟正文行（无空行）→ 列表仍是列表、正文独立成段（防「整块退化成段落」）", () => {
    const h = html(["1. 第一项", "2. 第二项", "结束。"].join("\n"));
    expect(count(h, "ol")).toBe(1);
    expect(count(h, "li")).toBe(2);
    expect(h).toContain("结束。");
    expect(h).not.toContain("1. 第一项"); // 整块退化成段落时，编号会原文裸露
  });

  it("异类列表相邻（`- ` 紧跟 `1.`）→ 分成两个列表", () => {
    const h = html(["- a", "1. b"].join("\n"));
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "ol")).toBe(1);
    expect(count(h, "li")).toBe(2);
  });

  it("源码层面的真值矩阵（锁定 `normalizeMarkdownBlocks` 的输出）", () => {
    expect(normalizeMarkdownBlocks("1. a\n2. b\n3. c")).toBe("1. a\n2. b\n3. c");
    expect(normalizeMarkdownBlocks("- a\n- b\n- c")).toBe("- a\n- b\n- c");
    expect(normalizeMarkdownBlocks("说明：\n- a\n- b")).toBe("说明：\n\n- a\n- b");
    expect(normalizeMarkdownBlocks("- a\n1. b")).toBe("- a\n\n1. b");
    expect(normalizeMarkdownBlocks("1. a\n2. b\n结束。")).toBe("1. a\n2. b\n\n结束。");
    // 表格行原样（表头里的 `#` 不触发解塞）
    expect(normalizeMarkdownBlocks("| # | 目标 | 结果 |\n|---|------|------|\n| 1 | a |")).toBe("| # | 目标 | 结果 |\n|---|------|------|\n| 1 | a |");
  });
});

describe("A-1105③ 判据自检（防「计数判据自己空转」的假守卫）", () => {
  it("喂已知形态：计数判据必须真的数得出来（恒 0 的假守卫会在这里红）", () => {
    const h = html("| 特性 | 说明 |\n|---|---|\n| 本地 | ✅ |\n\n## 标题\n\n- a\n- b\n");
    expect(count(h, "table")).toBe(1);
    expect(count(h, "td")).toBe(4);
    expect(heads(h)).toBe(1); // 真有标题时必须是 1（否则 A-1105① 的 `heads(...)===0` 毫无意义）
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "li")).toBe(2);
  });

  it("阴性样本：没有标题的表格，`heads` 必须为 0（证明它不是在瞎报）", () => {
    expect(heads(html("| 特性 | 说明 |\n|---|---|\n| 本地 | ✅ |"))).toBe(0);
    expect(heads(html("| # | 目标 |\n|---|------|\n| 1 | a |"))).toBe(0);
  });
});
