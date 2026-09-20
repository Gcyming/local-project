/**
 * tests/gui/thinking-text.spec.ts — 思考文本净化纯函数回归（thinkingText.ts）。
 *
 * 重点守住本轮线上 bug：sanitizeThinking 里一条过宽的正则
 * `/([A-Za-z0-9])\s+([A-Za-z0-9])/g` 会删掉任意两字母数字之间的空格，
 * 把 "The user is asking me" 粘成 "Theuserisaskingme"（思考区整段英文连成一坨）。
 * 现在只允许「单词首字母 + 小写词尾」的 token 断词拼合，词间空格必须原样保留。
 */
import { describe, it, expect } from "vitest";
import { sanitizeThinking, normalizeThinkingText, stripMarkdown, splitThinkingIntoSteps, THINK_STEP_MAX } from "../../gui/src/renderer/pages/thinkingText.js";

describe("normalizeThinkingText（换行归一）", () => {
  it("逐 token 单换行 → 空格（不粘连）", () => {
    expect(normalizeThinkingText("The\nuser\nis\nasking")).toBe("The user is asking");
  });

  it("空行 → 保留段落分隔", () => {
    expect(normalizeThinkingText("first para\n\nsecond para")).toBe("first para\n\nsecond para");
  });

  it("多余空格收敛且去首尾空白", () => {
    expect(normalizeThinkingText("  a   b \n c  ")).toBe("a b c");
  });

  it("全空行 → 空串（不产生幽灵段落）", () => {
    expect(normalizeThinkingText("\n\n   \n\n")).toBe("");
  });
});

describe("sanitizeThinking —— 本轮 bug 回归（英文词间空格必须保留）", () => {
  it("普通英文句子不被粘连", () => {
    const src = "The user is asking me to create a gateway proxy program that can use DeepSeek's web interface";
    expect(sanitizeThinking(src)).toBe(src);
  });

  it("逐 token 换行的英文段落 → 空格分隔的可读文本（原 bug 会粘成一坨）", () => {
    // 复现截图里的输入形态：模型逐 token 输出，每个 token 后带换行
    const src = "The\nuser\nis\nasking\nme\nto\ncreate\na\ngateway";
    expect(sanitizeThinking(src)).toBe("The user is asking me to create a gateway");
  });

  it("冠词/代词不被吞并（a cat / I think / i am）", () => {
    expect(sanitizeThinking("a cat")).toBe("a cat");
    expect(sanitizeThinking("I think")).toBe("I think");
    expect(sanitizeThinking("i am here")).toBe("i am here");
  });

  it("数字与字母间的空格不被删除", () => {
    expect(sanitizeThinking("step 1 and step 2")).toBe("step 1 and step 2");
    expect(sanitizeThinking("GPT 5 is better")).toBe("GPT 5 is better");
  });

  it("真正的 token 断词仍然被拼合（B ing / S tudio）", () => {
    expect(sanitizeThinking("B ing")).toBe("Bing");
    expect(sanitizeThinking("S tudio")).toBe("Studio");
  });

  it("中文：标点前不留空格、开括号后不留空格（A-924 既有行为）", () => {
    // 注意：本函数只收敛「标点相邻」的空格，不做全量 CJK 去空格（保持既有行为不扩散）
    expect(sanitizeThinking("好的 ， 我来")).toBe("好的， 我来");
    expect(sanitizeThinking("（ 测试）")).toBe("（测试）");
  });

  it("所有格/缩写的撇号后字母不被误拼（DeepSeek's web 不能变 DeepSeek'sweb）", () => {
    expect(sanitizeThinking("DeepSeek's web")).toBe("DeepSeek's web");
    expect(sanitizeThinking("it's a test")).toBe("it's a test");
    expect(sanitizeThinking("Claude's thinking")).toBe("Claude's thinking");
  });

  it("剥离 XML 工具调用残留标签", () => {
    const out = sanitizeThinking('</parameter name="test_file.txt">继续推理');
    expect(out).not.toContain("parameter");
    expect(out).toContain("继续推理");
  });

  it("null/空输入不抛", () => {
    expect(sanitizeThinking("")).toBe("");
    expect(sanitizeThinking(undefined as unknown as string)).toBe("");
  });
});

describe("stripMarkdown（摘要行去符号）", () => {
  it("抹掉加粗/行内码/标题符号", () => {
    expect(stripMarkdown("**bold** and `code` and # head")).toBe("bold and code and head");
  });

  it("链接保留可见文字，丢掉 URL", () => {
    expect(stripMarkdown("see [docs](https://x.com/a)")).toBe("see docs");
  });

  it("图片保留 alt 文字", () => {
    expect(stripMarkdown("![图](https://x.com/i.png)")).toBe("图");
  });

  it("多空白收敛为单空格并 trim", () => {
    expect(stripMarkdown("  a   b  ")).toBe("a b");
  });
});

/** A-1021b：单节点塌陷 → 有界多节点。
 *
 *  线上症状（用户截图）：思考历程只剩**一个**折叠节点，展开后是一大坨可滚动的字，
 *  "时间线设计"整体消失。根因是两条"只剩推理文本"的路径都只建 1 个 think 节点。
 *  这里锁死重建后的三条不变量：**内容不丢**、**顺序不变**、**节点数有界**。 */
describe("splitThinkingIntoSteps（推理文本 → 有界多节点）", () => {
  /** 不变量：把切好的段重新拼回来，必须逐字等于归一化后的原文（切分只切、不改写） */
  const rejoined = (text: string, max?: number): string =>
    splitThinkingIntoSteps(text, max).join("\n\n");

  it("空输入 → 空数组（调用方据此不建节点）", () => {
    expect(splitThinkingIntoSteps("")).toEqual([]);
    expect(splitThinkingIntoSteps("   \n\n  ")).toEqual([]);
    expect(splitThinkingIntoSteps(undefined as unknown as string)).toEqual([]);
  });

  it("单段落 → 仍是 1 个节点（日常短思考零回归，不无中生有）", () => {
    expect(splitThinkingIntoSteps("先想一下再动手")).toEqual(["先想一下再动手"]);
  });

  it("段内单换行并成空格（逐 token 断行不产生假段落）", () => {
    expect(splitThinkingIntoSteps("The\nuser\nis\nasking")).toEqual(["The user is asking"]);
  });

  it("多段落 → 一段一节点，顺序与内容原样保留", () => {
    const text = "第一段想的是 A\n\n第二段想的是 B\n\n第三段想的是 C";
    const out = splitThinkingIntoSteps(text);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("第一段想的是 A");
    expect(out[2]).toBe("第三段想的是 C");
    expect(rejoined(text)).toBe(normalizeThinkingText(text));
  });

  it("段数未超上限时**不做**合并（尊重模型自己给的结构）", () => {
    const text = Array.from({ length: 24 }, (_, i) => `段${i}`).join("\n\n");
    expect(splitThinkingIntoSteps(text)).toHaveLength(24);
  });

  it("超上限 → 合并相邻段，节点数收敛到上限", () => {
    const text = Array.from({ length: 100 }, (_, i) => `段${i}-` + "x".repeat(20)).join("\n\n");
    const out = splitThinkingIntoSteps(text);
    expect(out.length).toBeLessThanOrEqual(THINK_STEP_MAX);
    expect(rejoined(text)).toBe(normalizeThinkingText(text));
  });

  it("实测最坏样本量级（2,993 段 / ~751KB）→ 不超过 24 节点且内容无损", () => {
    // 按 config/history.jsonl 最长那条的形态合成：2993 段；每段 ~250 字符 → 总量 ≈ 751K
    const segs = Array.from({ length: 2993 }, (_, i) => `思考片段${i} ` + "复盘内容".repeat(62));
    const text = segs.join("\n\n");
    expect(text.length).toBeGreaterThan(700_000);
    const out = splitThinkingIntoSteps(text);
    expect(out.length).toBeLessThanOrEqual(THINK_STEP_MAX);
    expect(rejoined(text)).toBe(normalizeThinkingText(text));
    // 每个节点都非空（不产出空节点让折叠行变成幽灵行）
    for (const step of out) { expect(step.length).toBeGreaterThan(0); }
  });

  it("极端不均衡（前一段极长）也不产出空组、不丢内容", () => {
    const text = ["x".repeat(5000), ...Array.from({ length: 30 }, (_, i) => `尾段${i}`)].join("\n\n");
    const out = splitThinkingIntoSteps(text, 4);
    expect(out.length).toBeLessThanOrEqual(4);
    for (const step of out) { expect(step.length).toBeGreaterThan(0); }
    expect(rejoined(text, 4)).toBe(normalizeThinkingText(text));
  });

  it("maxSteps=1 → 单节点承载全文（合法降级，不是崩溃）", () => {
    const text = "甲\n\n乙\n\n丙";
    expect(splitThinkingIntoSteps(text, 1)).toEqual([normalizeThinkingText(text)]);
  });

  it("切分稳定：对切分结果再切分，节点不漂移（同一输入永远同一结果）", () => {
    const text = Array.from({ length: 60 }, (_, i) => `段${i}-` + "y".repeat(40)).join("\n\n");
    const once = splitThinkingIntoSteps(text);
    expect(once.length).toBeLessThanOrEqual(THINK_STEP_MAX);
    // 把节点拼回去再切 → 必须得到同一组节点（切分是输入的纯函数，不是"越切越碎"）
    expect(splitThinkingIntoSteps(once.join("\n\n"))).toEqual(once);
  });
});
