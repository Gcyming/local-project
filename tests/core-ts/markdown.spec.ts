/**
 * markdown.spec.ts — 轻量 Markdown 渲染器的「段落保形」判定回归锚点（A-906）。
 * preserveBreaks 决定段落是 pre-wrap 原样保留（示例/配置/对齐文本）还是折叠单换行为空格（流式散文）。
 * 锚定用户实际痛点：中文长文本/示例 的换行、缩进、空格不得被渲染层打散。
 */
import { describe, it, expect } from "vitest";
import { preserveBreaks, normalizeBrokenLines, tightenCjkSpacing, normalizeInlineTables, normalizeMarkdownBlocks } from "../../gui/src/renderer/pages/Markdown.js";

describe("Markdown preserveBreaks（段落保形判定）", () => {
  it("普通流式散文（每行短、无缩进、无对齐空格）→ 折叠，不保形", () => {
    expect(preserveBreaks("第一句很简单。\n第二句也很短。\n第三句收尾。")).toBe(false);
  });

  it("长行示例/配置文本（存在 ≥48 字符长行）→ 保形", () => {
    expect(
      preserveBreaks(
        "关于 agent.py：实现非常简单——react_chat 其实不是真 ReAct 循环，而是：1) 关键词匹配触发工具（只有搜索）2) 把工具结果塞给 LLM 让它总结。没有真正的多步推理循环。",
      ),
    ).toBe(true);
  });

  it("行首缩进（空格/制表符）→ 保形", () => {
    expect(preserveBreaks("  首行缩进\n  次行缩进")).toBe(true);
    expect(preserveBreaks("a\tb")).toBe(true);
  });

  it("内部连续多空格（对齐结构）→ 保形", () => {
    expect(preserveBreaks("name     value\nage      18")).toBe(true);
  });

  it("多行文本任一行带行首缩进 → 保形（示例中的代码/配置缩进）", () => {
    expect(preserveBreaks("config 说明\n  path: /data\n  level: 3")).toBe(true);
  });

  it("短行多段（无其他特征）→ 不保形，保持紧凑", () => {
    expect(preserveBreaks("第一段\n第二段\n第三段")).toBe(false);
  });

  it("空文本 → 不保形", () => {
    expect(preserveBreaks("")).toBe(false);
  });

  it("A-907：token 碎片化换行（逐词断行）→ 不保形，折叠拼接", () => {
    // 用户实拍形态：389\nk\nstars、（\n风\n铃\n）等碎片行占多数
    expect(preserveBreaks("重要\n发现\n：\n1\n)\nOpen\nCl\naw")).toBe(false);
    expect(preserveBreaks("389\nk\nstars\n、\n81\n.7\nk\nforks")).toBe(false);
  });

  it("A-907：碎片行 + 夹杂长句（曾误命中长行规则）→ 整体不保形", () => {
    const mixed =
      "OpenClaw\n（\n风\n铃\nconfig\n中\n也\n桥\n接\n了\nopen\ncl\naw\n）\n" +
      "现在是\n一个非常热门的项目：389k stars、81.7k forks（注意这些数字可能是被高估的或者是页面噪音）";
    expect(preserveBreaks(mixed)).toBe(false);
  });

  it("A-907：正常示例/配置（行不碎片化）→ 长行命中仍保形，不被误伤", () => {
    expect(
      preserveBreaks(
        "配置说明文字\n  path: /data/slime 这是对齐较长的一行配置说明文字用来命中保形阈值",
      ),
    ).toBe(true);
  });
});

describe("normalizeBrokenLines（token 碎片化换行就地净化，A-922/A-927）", () => {
  it("碎片化换行（每词一行）→ 折叠为空格拼接", () => {
    expect(normalizeBrokenLines("用\n户\n的\n工\n作\n目\n录")).toBe("用户的工作目录");
    expect(normalizeBrokenLines("The\nuser\nis\nasking\nme")).toBe("The user is asking me");
  });
  it("碎片 + 长句混合（曾误命中保形）→ 整体折叠可读", () => {
    expect(normalizeBrokenLines("这\n是\n一\n段\n说明文字这里是较长的正常句子内容不少于四十八个字符用于触发阈值")).toBe(
      "这是一段说明文字这里是较长的正常句子内容不少于四十八个字符用于触发阈值",
    );
  });
  it("正常文本（含真段落）→ 原样放行", () => {
    expect(normalizeBrokenLines("第一段说明。\n\n第二段很长的一行说明文字内容长度足够避免误判。")).toContain("\n\n");
    expect(normalizeBrokenLines("")).toBe("");
  });
  it("A-918++：短列表项不误折叠（列表结构保留，防 markdown 退化）", () => {
    // 列表项天然短行（≤4 字符），不应被误判为 token 碎片折叠成一行
    const src = "优点：\n- 快\n- 稳\n- 省";
    expect(normalizeBrokenLines(src)).toBe(src);
    const ol = "步骤：\n1. 建\n2. 改\n3. 测";
    expect(normalizeBrokenLines(ol)).toBe(ol);
  });
});

describe("tightenCjkSpacing（中文标点紧贴，A-926/A-927）", () => {
  it("中文标点前空格移除、开括号后空格移除", () => {
    expect(tightenCjkSpacing("好的 ， 我 看到 。")).toBe("好的，我看到。");
    expect(tightenCjkSpacing("（ 这是 一段 ）")).toBe("（这是一段）");
  });
  it("英文单词间空格不受影响（不误伤）", () => {
    expect(tightenCjkSpacing("L M S tudio ( 9 + models )")).toBe("L M S tudio ( 9 + models )");
    expect(tightenCjkSpacing("hello world")).toBe("hello world");
  });
  it("空 → 原样", () => {
    expect(tightenCjkSpacing("")).toBe("");
  });
});

describe("normalizeInlineTables（单行内联表格 → 重建标准表格，A-928/A-930）", () => {
  it("单行挤排表格（含 --- 分隔）→ 重建为标准 markdown 表格", () => {
    expect(normalizeInlineTables("核心特性：| 特性 | 说明 | |------|------| | 多模型 | ✅ |")).toBe(
      "核心特性：\n| 特性 | 说明 |\n|---|---|\n| 多模型 | ✅ |",
    );
  });
  it("普通文本（无表格特征）→ 原样", () => {
    expect(normalizeInlineTables("这是一段普通说明。\n另一行正常内容。")).toBe("这是一段普通说明。\n另一行正常内容。");
    expect(normalizeInlineTables("")).toBe("");
  });
  it("单对 |…|（非表格，如强调文本）→ 不拆", () => {
    expect(normalizeInlineTables("强调内容：| 重要 | 反复确认 --- 下划线")).toBe("强调内容：| 重要 | 反复确认 --- 下划线");
  });
});

describe("normalizeMarkdownBlocks（块级标记规整，A-929）", () => {
  it("标题/横线前无空行 → 补空行", () => {
    expect(normalizeMarkdownBlocks("正文结束。\n---\n## 项目功能\n| 特性 | 说明 |")).toBe(
      "正文结束。\n\n---\n\n## 项目功能\n| 特性 | 说明 |",
    );
  });
  it("fence 代码块内文本不受影响", () => {
    expect(normalizeMarkdownBlocks("```\n- not a list\n- still code\n```")).toBe("```\n- not a list\n- still code\n```");
  });
  it("表格数据行不以块标记打断（表头+分隔连续成块）", () => {
    expect(normalizeMarkdownBlocks("| 特性 | 说明 |\n|------|------|\n| 本地 | ✅ |")).toBe(
      "| 特性 | 说明 |\n|------|------|\n| 本地 | ✅ |",
    );
  });
  it("空输入 → 原样", () => {
    expect(normalizeMarkdownBlocks("")).toBe("");
  });
});