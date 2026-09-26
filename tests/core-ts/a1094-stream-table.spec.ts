/**
 * a1094-stream-table.spec.ts — 流式期**表格 markdown 裸露**回归（A-1094）。
 *
 * 用户实测（image#5）：正文里 `|---|------|`、`| 1 | cd /d "D:..." |` 等表格语法**原文直出**，
 * 常看到裸露的 `|`。根因（两处，都在"行还没写完 / 还没到齐"的瞬间）：
 *   ① `parseBlocks` 表格分支要求**分隔行已存在**（`i + 1 < n && 下一行是分隔行`）——
 *      流式期"表头行到了、分隔行还没到"的几十~几百毫秒，表头行退化成普通段落 → `|` 裸露；
 *   ② 分隔行打字到一半（`|---`、`|---|-`）：既不是完整分隔行，又会被「分割线」分支
 *      `/^(-{3,}…)$/` 抢去渲染成 `<hr>` → 表头裸露 + 多一条横线。更糟的是
 *      `normalizeMarkdownBlocks` 会把 `|---`（≥3 连字符命中块标记正则）拆成 `|` + 空行 + `---`。
 *
 * 修法（两段，时机不同，见 Markdown.tsx 的 repairStreamingTablePre / After）：
 *   · Pre（净化链**之前**）：把末尾"半成品分隔行"**替换**为完整分隔行；
 *   · After（净化链**之后**）：末尾是"表格首行"且真分隔行未到 → 补一行同列数占位分隔行。
 * 此 spec 端到端断言最终 HTML——**断言的是"不裸露"这个用户可见事实**，不锁内部实现。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../../gui/src/renderer/pages/Markdown.js";

function render(text: string, streaming = false): string {
  return renderToStaticMarkup(createElement(Markdown, { text, streaming }));
}

/** 表格单元格内联样式标记（真表格产出的判据，与既有 markdown-render.spec 同源） */
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
    // 数据行行首（上一行已是分隔行）**不许再补分隔行** —— 否则每行都多长出一截分隔行
    // 判据：整段里分隔行只出现一次（表格恰好 2 行 tr：表头 + 数据）
    const trCount = (html.match(/<tr/g) ?? []).length;
    expect(trCount, `行数不对（多补了分隔行）：${html}`).toBe(2);
  });

  it("非表格的孤立 `|` 文本不受影响（不许无差别吞管道）", () => {
    const html = render("a | b 是「或」的意思", true);
    expect(html).toContain("a | b 是");
  });

  it("列数下限：空表头（`||`）不许补出空分隔行 `||` 也不许裸露", () => {
    // `||` / `|||` 是"表头行但单元格全空"的形态：不设下限时 cols=0 → 补出 `||` 空分隔行
    // （解析出 0 列），表头行反而裸露。下限 Math.max(1, …) 保证至少 1 列。
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
    // 终态（streaming=false）若只有表头行、没有分隔行 → 不是表格，保持原文
    const html = render("| A | B |", false);
    expect(html).toContain("| A | B |");
  });
});
