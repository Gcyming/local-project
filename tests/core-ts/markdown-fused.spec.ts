/**
 * markdown-fused.spec.ts — 行内块标记解塞（unjam）回归（A-9xx）。
 * 用户实测：agnes 类模型输出「块级标记与正文/同行内容挤在同一行」的畸形 markdown——
 *   `报告：--- ## 📋 项目功能分析 ### Campanula …：| 特性 | 说明 |`
 *   `| … | --- ## 🔍 下节标题 ### 1. Ollama …`
 * 此前解析器按行首判定块，导致 `---`/`##`/`###`/`|` 全部原样落进段落（markdown 渲染失效、
 * 实时流式也只见原始符号）。此处端到端断言最终 HTML：横线/标题/表格必须真实产出。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { normalizeMarkdownBlocks, normalizeBrokenLines, tightenCjkSpacing } from "../../gui/src/renderer/pages/Markdown.js";

/** 用户实测缩样：块标记全挤行内 + 表格行尾巴嵌 `--- ##`（忠实还原原始形态） */
const fusedSample = [
  "我已经了解了项目的基本情况。现在让我进行全网调研，看看类似的研究方向：根据我对 Campanula 项目的深入分析以及全网调研，以下是详细报告：--- ## 📋 项目功能分析 ### Campanula 的核心定位这是一个本地多模型协作 AI 助手桌面应用，主要特点：| 特性 | 说明 |",
  "|---|---|---|---|---|",
  "| llama.cpp (GGUF) + PySide6 GUI + MCP 协议支持 | 智能路由 | 根据任务类型自动选择最合适的模型 | 协作编排 | 任务分解 → 多模型协作 → 结果汇总 | 显存自适应 | LTS 状态机管理 GPU 显存，动态切换 GPU/CPU 模式 | 外设支持 | 视觉模型、ASR、TTS 动态加载（互斥锁管控）| 声明式配置 |",
  "| V3.0 架构采用 YAML 配置文件，零硬编码 | --- ## 🔍 类似项目/研究方向调研 ### 1. Ollama (180k ⭐)",
  "",
  "| 特性 | 说明 |",
  "|---|---|",
  "| 本地 | ✅ |",
].join("\n");

function render(text: string, streaming = false): string {
  return renderToStaticMarkup(createElement(Markdown, { text, streaming }));
}

describe("行内块标记解塞（横线/标题/表格从行内还原）", () => {
  it("`--- ## 标题` 挤在段尾 → 分离为横线 + 标题，不再原文直出", () => {
    const html = render(fusedSample);
    expect(html).toContain("border-top:1px solid");          // --- 变为真横线
    expect(html).toContain("📋 项目功能分析");                // ## 标题内容渲染
    expect(html).toContain("font-weight:700");               // 标题粗体
    expect(html).not.toContain("--- ## 📋");                 // 原始拼缝残留消失
    expect(html).not.toContain("## 📋 项目功能分析");         // 未渲染成段落的原文不出现
    expect(html).not.toContain("| 特性 |");                  // 表头不原文直出
  });

  it("挤在一行的表格（表头粘正文 + 列数不一致）→ 渲染为真表格", () => {
    const html = render(fusedSample);
    expect(html).toContain("border-collapse:collapse");      // table
    expect(html).toContain("padding:4px 8px");               // td
    expect(html).toContain("智能路由");                        // 单元格内容入 td
    expect(html).toContain("显存自适应");                      // 多数据行同样入表
  });

  it("表格行尾巴嵌 `| --- ## 下节` → 行内横线+标题从行尾解出", () => {
    const html = render(fusedSample);
    expect(html).toContain("🔍 类似项目/研究方向调研");        // ## 下节标题渲染
    expect(html).toContain("1. Ollama (180k ⭐)");            // ### 条目渲染
    expect(html).not.toContain("--- ## 🔍");                 // 拼缝残留消失
  });

  it("完好的标准 markdown（表格/列表）不受影响", () => {
    const html = render(["| 特性 | 说明 |", "|---|---|", "| 本地 | ✅ |"].join("\n"));
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("本地");
  });

  it("流式路径同样解塞（补全后同行处理）", () => {
    const html = render(fusedSample, true);
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("📋 项目功能分析");
  });
});

describe("tightenCjkSpacing（A-9xx 换行零吞噬）", () => {
  it("标点后的换行/块标记不被 `\\s` 吞噬（横线标题在标点结尾后仍生效）", () => {
    expect(tightenCjkSpacing("正文结束。\n\n---\n\n## 标题")).toBe("正文结束。\n\n---\n\n## 标题");
    expect(tightenCjkSpacing("报告：\n--- 横线")).toBe("报告：\n--- 横线");
    expect(tightenCjkSpacing("第一行。\n第二行。")).toBe("第一行。\n第二行。");
  });
  it("水平空格仍收敛（原有行为不变）", () => {
    expect(tightenCjkSpacing("好的 ， 我 看到 。")).toBe("好的，我看到。");
    expect(tightenCjkSpacing("（ 这是 一段 ）")).toBe("（这是一段）");
    expect(tightenCjkSpacing("hello world")).toBe("hello world");
  });
});

describe("normalizeBrokenLines（A-9xx markdown 结构零误伤）", () => {
  it("段落+横线+标题（含空行/短行）→ 不折叠", () => {
    expect(normalizeBrokenLines("正文结束。\n\n---\n\n## 标题\n\n正文继续。")).toBe(
      "正文结束。\n\n---\n\n## 标题\n\n正文继续。",
    );
  });
  it("token 碎片化换行仍折叠（原有行为不变）", () => {
    expect(normalizeBrokenLines("用\n户\n的\n工\n作\n目\n录")).toBe("用户的工作目录");
    expect(normalizeBrokenLines("The\nuser\nis\nasking\nme")).toBe("The user is asking me");
    // 数字/短词夹杂的碎片行：内容行折叠时**不丢数字**
    expect(normalizeBrokenLines("389\nk\nstars\n、\n81\n.7\nk\nforks")).toBe("389 k stars 、 81 .7 k forks");
  });
});

describe("normalizeMarkdownBlocks（行内解塞单元）", () => {
  it("段尾 `--- ## 标题### 小标题` → 拆成多行块（无后续分隔行时 |…| 留在标题尾）", () => {
    expect(normalizeMarkdownBlocks("报告：--- ## 标题### 小标题，特点：| A | B |")).toBe(
      "报告：\n\n---\n\n## 标题\n\n### 小标题，特点：| A | B |",
    );
  });
  it("表格行尾巴 `| --- ## 下节` → 左半保留完整表格行", () => {
    expect(normalizeMarkdownBlocks("| V3.0 架构 … | --- ## 🔍 调研")).toBe(
      "| V3.0 架构 … |\n\n---\n\n## 🔍 调研",
    );
  });
  it("fence 代码块内不触发解塞", () => {
    expect(normalizeMarkdownBlocks("```\n报告：--- ## 标题\n```")).toBe("```\n报告：--- ## 标题\n```");
  });
  it("无块标记的散文原样（含行首缩进，不 trim）", () => {
    expect(normalizeMarkdownBlocks("配置说明\n  path: /data/slime\n  level: 3")).toBe(
      "配置说明\n  path: /data/slime\n  level: 3",
    );
  });
  it("空输入 → 原样", () => {
    expect(normalizeMarkdownBlocks("")).toBe("");
  });
});