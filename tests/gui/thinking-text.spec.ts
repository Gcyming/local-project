/**
 * tests/gui/thinking-text.spec.ts — 思考文本净化纯函数回归（thinkingText.ts）。
 *
 * 重点守住本轮线上 bug：sanitizeThinking 里一条过宽的正则
 * `/([A-Za-z0-9])\s+([A-Za-z0-9])/g` 会删掉任意两字母数字之间的空格，
 * 把 "The user is asking me" 粘成 "Theuserisaskingme"（思考区整段英文连成一坨）。
 * 现在只允许「单词首字母 + 小写词尾」的 token 断词拼合，词间空格必须原样保留。
 */
import { describe, it, expect } from "vitest";
import { sanitizeThinking, normalizeThinkingText, stripMarkdown } from "../../gui/src/renderer/pages/thinkingText.js";

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
