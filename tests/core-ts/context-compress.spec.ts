/**
 * tests/core-ts/context-compress.spec.ts — A-969 上下文自动压缩纯函数单测。
 * 对齐 Anthropic Compaction / Claude Code autoCompact 语义：触发判定、摘要提示词、硬裁剪降级、压缩后注入拼装。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPRESS_RATIO, SUMMARIZE_INPUT_CAP,
  estimateHistoryTokens, needsCompress, buildCompressSummaryPrompt,
  messagesToPlainText, hardTruncate, buildCompactedHistory,
} from "../../core-ts/src/services/context_compress.js";

/** 生成 n 轮消息（每轮 user+assistant 各一段中文，长度可控） */
function turns(n: number, chars = 80): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `第${i}轮问题：` + "问".repeat(chars) });
    out.push({ role: "assistant", content: `第${i}轮回答：` + "答".repeat(chars) });
  }
  return out;
}

describe("estimateHistoryTokens", () => {
  it("估算随条数与长度增长", () => {
    const small = estimateHistoryTokens(turns(5, 20));
    const big = estimateHistoryTokens(turns(50, 200));
    expect(big).toBeGreaterThan(small * 2);
    expect(estimateHistoryTokens([])).toBe(0);
  });
});

describe("needsCompress（触发判定）", () => {
  it("占用达到 cap×ratio 且轮次足够 → 触发", () => {
    const used = Math.round(10000 * DEFAULT_COMPRESS_RATIO);
    expect(needsCompress(used, 10000, DEFAULT_COMPRESS_RATIO, 10)).toBe(true);
  });
  it("未达占比 → 不触发", () => {
    expect(needsCompress(5000, 10000, 0.85, 10)).toBe(false);
  });
  it("轮次太少（<6）→ 不压（对齐 Claude Code 最小轮次门槛）", () => {
    expect(needsCompress(9000, 10000, 0.85, 4)).toBe(false);
  });
  it("cap/used 非法 → 不触发", () => {
    expect(needsCompress(0, 10000, 0.85, 10)).toBe(false);
    expect(needsCompress(9000, 0, 0.85, 10)).toBe(false);
  });
  it("ratio 越界被夹紧（0.5~0.97）", () => {
    expect(needsCompress(4000, 10000, 0.1, 10)).toBe(false); // 0.1→0.5 也 >0.4 → false
    expect(needsCompress(5000, 10000, 0.1, 10)).toBe(true);   // 0.5×10000 ≤ 5000 → true
  });
});

describe("buildCompressSummaryPrompt", () => {
  it("包含续接要素（任务/决策/下一步）与对话内容", () => {
    const p = buildCompressSummaryPrompt("<history>\nabc\n</history>");
    expect(p).toContain("下一步");
    expect(p).toContain("关键决策");
    expect(p).toContain("<history>");
    expect(p).toContain("abc");
  });
});

describe("messagesToPlainText / hardTruncate / buildCompactedHistory（降级与注入）", () => {
  it("文本化：普通文本 + 图片 content-blocks 缩为占位", () => {
    const text = messagesToPlainText([
      { role: "user", content: "你好" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } }] },
    ]);
    expect(text).toContain("USER: 你好");
    expect(text).not.toContain("AAA="); // dataURL 不参与摘要轮（防携带几 MB base64）
    expect(text).toContain("[图片内容]");
  });

  it("硬裁剪：保留头 1 条 + 尾部 K 条", () => {
    const msgs = turns(20);
    const out = hardTruncate(msgs, 6);
    expect(out.length).toBe(7); // 头条 + 尾 6
    expect(out[0].content).toBe(msgs[0].content);
    expect(out[out.length - 1].content).toBe(msgs[msgs.length - 1].content);
  });

  it("压缩后注入：摘要头 + assistant 垫脚 + 最近 K 条（角色交替完整，消息数正确）", () => {
    const msgs = turns(20);
    const out = buildCompactedHistory("摘要：完成 X；下一步 Y", msgs, 8);
    expect(out.length).toBe(10); // 摘要头 + 垫脚 + 尾 8
    expect(out[0].role).toBe("user");
    expect(out[0].content).toContain("摘要：完成 X；下一步 Y");
    expect(out[0].content).toContain("32"); // 20 轮 messages = 40 条记录，压掉 40-8=32 条
    expect(out[1].role).toBe("assistant"); // 垫脚：保证 user→assistant 交替（Anthropic 拒绝连续同角色）
    // 全文交替校验：无连续相同角色
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role).not.toBe(out[i - 1].role);
    }
  });

  it("SUMMARIZE_INPUT_CAP 存在且为正", () => {
    expect(SUMMARIZE_INPUT_CAP).toBeGreaterThan(0);
  });
});