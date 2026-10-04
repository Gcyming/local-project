















import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../../gui/src/renderer/pages/Markdown.js";

function render(text: string, streaming = false): string {
  return renderToStaticMarkup(createElement(Markdown, { text, streaming }));
}


const TABLE_MARK = "border-collapse:collapse";

describe("A-1094 流式期表格裸露", () => {
  it("表头行已到、分隔行未到 → 立刻渲染为真表格（不裸露 `|`）", () => {
    const html = render("说明如下：\n\n| 被拦命令（原样） | 等效落地脚本 |\n", true);
    expect(html).toContain(TABLE_MARK);
    expect(html).not.toContain("| 被拦命令");
  });

  it("表头行打字中（无换行收尾）→ 渲染为真表格", () => {
    const html = render("| A | B", true);
    expect(html).toContain(TABLE_MARK);
    expect(html).not.toContain("| A | B");
  });

  it("分隔行打字到一半 `|---` → 表格成立，且不产出孤立横线", () => {
    const html = render("| A | B |\n|---", true);
    expect(html).toContain(TABLE_MARK);
    expect(html).not.toContain("| A | B |");
    expect(html).not.toContain("border-top:1px solid");
  });

  it("分隔行半截 `|--` / `|-` 同样不裸露", () => {
    for (const tail of ["|--", "|-", "|---|--"]) {
      const html = render(`| A | B |\n${tail}`, true);
      expect(html, `tail=${tail}`).toContain(TABLE_MARK);
      expect(html, `tail=${tail}`).not.toContain("| A | B |");
    }
  });

  it("表格数据行正在流入 → 仍为真表格（数据行不被误当新表头）", () => {
    const html = render("| A | B |\n|---|---|\n| 1 | 2 |", true);
    expect(html).toContain(TABLE_MARK);
    expect(html).not.toContain("|---|---|");
    
    
    const trCount = (html.match(/<tr/g) ?? []).length;
    expect(trCount, `行数不对（多补了分隔行）：${html}`).toBe(2);
  });

  it("非表格的孤立 `|` 文本不受影响（不许无差别吞管道）", () => {
    const html = render("a | b 是「或」的意思", true);
    expect(html).toContain("a | b 是");
  });

  it("列数下限：空表头（`||`）不许补出空分隔行 `||` 也不许裸露", () => {
    
    
    for (const head of ["||", "|||"]) {
      const html = render(head, true);
      expect(html, `head=${head} 裸露了管道`).not.toContain(head);
      expect(html, `head=${head} 补出了空分隔行`).not.toContain("||");
    }
  });

  it("非流式完整表格路径行为不变", () => {
    const html = render("| A | B |\n|---|---|\n| 1 | 2 |", false);
    expect(html).toContain(TABLE_MARK);
    expect(html).not.toContain("|---|---|");
  });

  it("非流式也**不做**表格补全（未完成的表格不该在终态被伪造）", () => {
    
    const html = render("| A | B |", false);
    expect(html).toContain("| A | B |");
  });
});
