



























import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { normalizeMarkdownBlocks } from "../../gui/src/renderer/pages/Markdown.js";

const html = (t: string, streaming = false): string =>
  renderToStaticMarkup(createElement(Markdown, { text: t, streaming }));


const count = (h: string, tag: string): number => (h.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;

const heads = (h: string): number => (h.match(/font-weight:700/g) ?? []).length;
const hasTable = (h: string): boolean => h.includes("border-collapse:collapse");

describe("A-1105① 表格表头单元格里的 `#` 是内容，不是标题标记", () => {
  
  const CASES: Array<{ name: string; src: string; cols: number }> = [
    {
      name: "表头首列就是 `#`（用户截图那一张的形态）",
      src: "| # | 目标 | 结果 |\n|---|------|------|\n| 1 | `_debug_boot_home.html` | ❌ 无法删除（无删除工具） |",
      cols: 3,
    },
    { name: "表头 `# 序`", src: "| # 序 | 目标 |\n|---|------|\n| 1 | a |", cols: 2 },
    {
      
      
      
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
      
      expect(heads(h)).toBe(0);
      expect(h).not.toContain("|---|");
      expect(h).not.toContain("| 目标 |");
    });
  }

  it("`#` 的标题解塞能力不回归（A-9xx：行内 `## ` 仍要拆出来）", () => {
    expect(normalizeMarkdownBlocks("正文 ## 标题")).toBe("正文\n\n## 标题");
    expect(normalizeMarkdownBlocks("报告：--- ## 标题")).toBe("报告：\n\n---\n\n## 标题");
    expect(normalizeMarkdownBlocks("| V | --- ## 🔍 调研")).toBe("| V |\n\n---\n\n## 🔍 调研");
    
    expect(normalizeMarkdownBlocks("C# 语言 x# y")).toBe("C# 语言 x# y");
    
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
    expect(h).not.toContain("1. 目标文件 1"); 
  });

  it("`- ` 三项 → **一个** `<ul>` / 三个 `<li>`（此前是三个各含 1 项的 `<ul>`）", () => {
    const h = html(["- 只删上面这 10 项", "- 不许删除其他文件", "- 没有能力就如实返回"].join("\n"));
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "li")).toBe(3);
    expect(h).not.toContain("- 只删上面这 10 项"); 
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
    expect(h).toContain("边界（严格遵守）："); 
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
    expect(h).not.toContain("1. 第一项"); 
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
    
    expect(normalizeMarkdownBlocks("| # | 目标 | 结果 |\n|---|------|------|\n| 1 | a |")).toBe("| # | 目标 | 结果 |\n|---|------|------|\n| 1 | a |");
  });
});

describe("A-1105③ 判据自检（防「计数判据自己空转」的假守卫）", () => {
  it("喂已知形态：计数判据必须真的数得出来（恒 0 的假守卫会在这里红）", () => {
    const h = html("| 特性 | 说明 |\n|---|---|\n| 本地 | ✅ |\n\n## 标题\n\n- a\n- b\n");
    expect(count(h, "table")).toBe(1);
    expect(count(h, "td")).toBe(4);
    expect(heads(h)).toBe(1); 
    expect(count(h, "ul")).toBe(1);
    expect(count(h, "li")).toBe(2);
  });

  it("阴性样本：没有标题的表格，`heads` 必须为 0（证明它不是在瞎报）", () => {
    expect(heads(html("| 特性 | 说明 |\n|---|---|\n| 本地 | ✅ |"))).toBe(0);
    expect(heads(html("| # | 目标 |\n|---|------|\n| 1 | a |"))).toBe(0);
  });
});
