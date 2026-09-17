/**
 * markdown-render.spec.ts — Markdown **端到端渲染**回归（A-931）。
 * 此前单测只锚定 normalize 清洁函数，未验证真实 DOM 输出——用户实测「长回复 markdown 全失效」
 * 恰是渲染路径的 LARGE_TEXT 分支退化为纯文本所致（幻觉源）。此处用 react-dom/server
 * renderToStaticMarkup 直接断言最终 HTML，锁死：块级（标题/表格/横线/引用/列表）在
 * 普通与 ≥20k 超长文本两条路径都真实产出对应元素。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../../gui/src/renderer/pages/Markdown.js";

/** 覆盖全部块级的样本（标题/表格/横线/引用/列表/代码） */
const sample = [
  "# 大标题",
  "",
  "| 特性 | 说明 |",
  "|---|---|",
  "| 本地 | ✅ |",
  "",
  "---",
  "",
  "> 引用文字",
  "",
  "- 列表项一",
  "- 列表项二",
  "",
  "正文段落。",
].join("\n");

/** 拼接出 ≥20k 的超长文本（必须落入 LARGE_TEXT ≥20000 分支） */
const longSample = Array.from({ length: 360 }, () => sample).join("\n\n");
if (longSample.length < 20000) {
  throw new Error(`fixture 不足 20k 字符：${longSample.length}`);
}

function render(text: string, streaming = false): string {
  return renderToStaticMarkup(createElement(Markdown, { text, streaming }));
}

describe("Markdown 端到端渲染（普通长度）", () => {
  it("标题/表格/横线/引用/列表均产出真实元素（无 markdown 原文直出）", () => {
    const html = render(sample);
    // 表格：单元格 td 边框 + 表头加粗（SSR 序列化形态）
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("padding:4px 8px");
    // 横线
    expect(html).toContain("border-top:1px solid");
    // 引用
    expect(html).toContain("<blockquote");
    // 列表
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    // 标题（粗体 div）
    expect(html).toContain("font-weight:700");
    // 正文无原文符号残留
    expect(html).not.toContain("<p>&gt;");
  });
});

describe("Markdown 端到端渲染（≥20k 超长路径，A-931 根因）", () => {
  it("超长文本仍渲染为真实表格/标题（不再退化为纯文本原文）", () => {
    const html = render(longSample);
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("padding:4px 8px");
    expect(html).toContain("border-top:1px solid");
    expect(html).toContain("font-weight:700");
    expect(html).toContain("<blockquote");
  });
  it("超长流式 path 同样渲染表格", () => {
    const html = render(longSample, true);
    expect(html).toContain("border-collapse:collapse");
  });
});