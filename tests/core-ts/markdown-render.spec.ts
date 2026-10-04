






import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../../gui/src/renderer/pages/Markdown.js";


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
    
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("padding:4px 8px");
    
    expect(html).toContain("border-top:1px solid");
    
    expect(html).toContain("<blockquote");
    
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    
    expect(html).toContain("font-weight:700");
    
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