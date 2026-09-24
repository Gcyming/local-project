/**
 * tests/core-ts/context-compress.spec.ts — 上下文自动压缩纯函数单测（A-969 落地 / A-1082 修正）。
 *
 * ## 本文件锁住的「压缩并非真压缩」（用户原话）四条根因
 *
 * ① `estimateHistoryTokens` 曾为 `总字符 / 4` —— 1 个汉字 ≈ 1 token，于是中文长会话的占用
 *    被算成真实的 1/4 ⇒ **阈值形同虚设**、该压的时候永远不压。
 * ② 摘要轮输入超 `SUMMARIZE_INPUT_CAP` 就 `return null`（放弃摘要）⇒ 调用方降级。
 * ③ 而那条降级路径当时**什么都没裁**（界面却报「已压缩 N 轮」）—— 由 `truncateTurnAligned`
 *    与 `summaryCount` 独立生效兜住（主进程侧的守卫见 `tests/gui/context-compress-ui.spec.ts`）。
 * ④ 切口按**条数**硬切可能落在半轮上 ⇒ `user, user` 连续同角色（Anthropic 系直接 400）。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPRESS_RATIO, DEFAULT_TAIL_KEEP, SUMMARIZE_INPUT_CAP, MESSAGE_OVERHEAD_TOKENS,
  estimateTokensLocal, estimateHistoryTokens, needsCompress, buildCompressSummaryPrompt,
  messagesToPlainText, buildSummaryInput, buildCompactedHistory, truncateTurnAligned,
  planCompactedCut,
} from "../../core-ts/src/services/context_compress.js";
import { validateHistory } from "../../core-ts/src/services/context_loop.js";

/** 生成 n 轮消息（每轮 user+assistant 各一段中文，长度可控） */
function turns(n: number, chars = 80): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `第${i}轮问题：` + "问".repeat(chars) });
    out.push({ role: "assistant", content: `第${i}轮回答：` + "答".repeat(chars) });
  }
  return out;
}

describe("estimateHistoryTokens · A-1082 改成 CJK 感知口径", () => {
  it("🐛 1000 个汉字必须落在 900–1600（旧实现 `字符/4` 只有 ~250，4 倍低估 ⇒ 阈值永不触发）", () => {
    const msgs = [
      { role: "user", content: "汉".repeat(500) },
      { role: "assistant", content: "汉".repeat(500) },
    ];
    const n = estimateHistoryTokens(msgs);
    expect(n, `1000 汉字估成 ${n}，低于字数的 0.9 倍 ⇒ 又回到 CJK 低估`).toBeGreaterThanOrEqual(900);
    expect(n, `1000 汉字估成 ${n}，高于字数的 1.6 倍 ⇒ 会误触发压缩`).toBeLessThanOrEqual(1600);
  });

  it("🐛 与旧口径的对照：长中文历史下新口径必须显著更大（旧口径对**正文**是 4 倍低估）", () => {
    // ⚠️ 必须用**长**中文轮次：旧口径的每轮 300 字符固定开销在短消息里会掩盖 4 倍低估，
    //    而真实的长会话恰恰是"每轮都很长"——那正是该触发压缩却永远不触发的场景。
    const msgs = turns(10, 1000);
    const chars = msgs.reduce((s, m) => s + m.content.length, 0);
    const legacy = Math.round((chars + msgs.length * 300) / 4);
    const now = estimateHistoryTokens(msgs);
    expect(now, `新口径 ${now} 未显著大于旧口径 ${legacy} ⇒ 这次修正没生效`).toBeGreaterThan(legacy * 2);
  });

  it("英文按 4 字符 ≈ 1 token（与 estimateTokensLocal 同口径）", () => {
    expect(estimateHistoryTokens([{ role: "user", content: "a".repeat(400) }]))
      .toBe(MESSAGE_OVERHEAD_TOKENS + 100);
  });

  it("估算随条数与长度增长；空列表为 0", () => {
    const small = estimateHistoryTokens(turns(5, 20));
    const big = estimateHistoryTokens(turns(50, 200));
    expect(big).toBeGreaterThan(small * 2);
    expect(estimateHistoryTokens([])).toBe(0);
  });

  it("图片 content-block 只按占位计，绝不把 base64 算进去（否则环直接爆满）", () => {
    const withImg = estimateHistoryTokens([
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(500000)}` } }] },
    ]);
    expect(withImg, "base64 被算进去了").toBeLessThan(5000);
    expect(withImg).toBeGreaterThan(0);
  });

  it("estimateTokensLocal 本身：汉字 1 字 1 token、英文 4 字符 1 token", () => {
    expect(estimateTokensLocal("汉".repeat(100))).toBe(100);
    expect(estimateTokensLocal("a".repeat(400))).toBe(100);
    expect(estimateTokensLocal("")).toBe(0);
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

  it("🐛 §8.2：模板必须**禁止命令式句子**（摘要里的命令句会被下游模型当成用户指令）", () => {
    const p = buildCompressSummaryPrompt("x");
    expect(p, "没写「禁止命令句」⇒ 摘要可能污染下一步决策").toMatch(/禁止.*命令句|被动陈述/);
  });

  it("A-1082 递进式：有 priorSummary 时必须要求「在既有摘要基础上扩充且完整保留要点」", () => {
    const p = buildCompressSummaryPrompt("x", "旧摘要要点：已完成 A、B");
    expect(p, "没带旧摘要原文 ⇒ 无法递进").toContain("旧摘要要点：已完成 A、B");
    expect(p, "没要求保留旧要点 ⇒ 信息会逐轮衰减（I5 违反）").toMatch(/完整保留|扩充/);
    expect(p).toContain("<prior_summary>");
  });

  it("无 priorSummary 时不出现递进段落（别把「首次压缩」写成「扩充」）", () => {
    expect(buildCompressSummaryPrompt("x")).not.toContain("<prior_summary>");
  });
});

describe("messagesToPlainText（摘要轮输入）", () => {
  it("文本化：普通文本 + 图片 content-blocks 缩为占位", () => {
    const text = messagesToPlainText([
      { role: "user", content: "你好" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } }] },
    ]);
    expect(text).toContain("USER: 你好");
    expect(text).not.toContain("AAA="); // dataURL 不参与摘要轮（防携带几 MB base64）
    expect(text).toContain("[图片内容]");
  });
});

describe("buildSummaryInput · A-1082：超预算**摘录**而不是放弃摘要", () => {
  it("放得下 → 整段给（不摘录）", () => {
    const msgs = turns(3, 20);
    const r = buildSummaryInput(msgs, 100000);
    expect(r.elided).toBe(0);
    expect(r.text).toContain("第0轮问题");
    expect(r.text).toContain("第2轮回答");
  });

  it("🐛 放不下 → 取头 30% + 尾 70%，且**中间有省略说明**（旧实现直接 return null 放弃摘要）", () => {
    const msgs = turns(200, 200); // 约 4 万汉字
    const r = buildSummaryInput(msgs, 4000);
    expect(r.elided, "一条都没摘录 ⇒ 预算判定失效").toBeGreaterThan(0);
    expect(r.text, "没有省略说明 ⇒ 摘要模型不知道中间缺了内容").toMatch(/省略 \d+ 条/);
    expect(r.text, "头部丢失（最早的话题锚没了）").toContain("第0轮问题");
    expect(r.text, "尾部丢失（最新工作现场没了 ⇒ 摘要没有续接价值）").toContain("第199轮回答");
    // 预算约束：产出不得超出预算太多（允许多出「省略说明」那一行）
    expect(estimateTokensLocal(r.text)).toBeLessThan(4000 * 1.2);
  });

  it("预算极小也**至少保留尾部 1 条**（否则摘要轮看到空内容）", () => {
    const msgs = turns(50, 200);
    const r = buildSummaryInput(msgs, 256);
    expect(r.text.length, "预算太小导致摘要轮拿到空输入").toBeGreaterThan(0);
    expect(r.text).toContain("第49轮回答");
  });

  it("预算非法（NaN/0）时退回默认上限，不抛", () => {
    const msgs = turns(2, 10);
    expect(() => buildSummaryInput(msgs, Number.NaN)).not.toThrow();
    expect(() => buildSummaryInput(msgs, 0)).not.toThrow();
  });

  it("SUMMARIZE_INPUT_CAP 存在且**足够大**（旧的 9000 在 CJK 下只够 ~9k 汉字 ⇒ 真实会话必然放弃摘要）", () => {
    expect(SUMMARIZE_INPUT_CAP).toBeGreaterThanOrEqual(16000);
  });
});

describe("truncateTurnAligned · 降级裁剪必须 turn 对齐（I2）", () => {
  it("保留最后 K **整轮**，切口落在 user 上", () => {
    const msgs = turns(20);
    const out = truncateTurnAligned(msgs, 6);
    expect(out.length).toBe(12); // 6 轮 = 12 条
    expect(out[0].role, "切口没落在 user 上 ⇒ 半轮被切开").toBe("user");
    expect(out[out.length - 1].content).toBe(msgs[msgs.length - 1].content);
  });

  it("🐛 旧 `hardTruncate` 的 `[首条, ...末K]` 会产出 `user, user` 连续同角色（Anthropic 系直接 400）", () => {
    const msgs = turns(20);
    const out = truncateTurnAligned(msgs, 6);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role, `第 ${i} 条与上一条同为 ${out[i].role} ⇒ 连续同角色`).not.toBe(out[i - 1].role);
    }
    expect(validateHistory(out).ok, "裁剪产物没过硬不变量").toBe(true);
  });

  it("轮数不足 → 原样返回（宁可不动，也不切半轮）", () => {
    const msgs = turns(2);
    expect(truncateTurnAligned(msgs, 6)).toBe(msgs);
    expect(planCompactedCut(msgs, 6)).toBe(0);
  });

  it("空数组 / 非法输入不抛", () => {
    expect(truncateTurnAligned([], 6)).toEqual([]);
    expect(planCompactedCut([], 6)).toBe(0);
  });
});

describe("buildCompactedHistory · 摘要头 + 垫脚 + 最近 K 整轮", () => {
  it("角色交替完整、切口 turn 对齐、摘要文本带过去", () => {
    const msgs = turns(20);
    const out = buildCompactedHistory("摘要：完成 X；下一步 Y", msgs, 8);
    expect(out.length).toBe(18); // 摘要头 + 垫脚 + 8 轮(16 条)
    expect(out[0].role).toBe("user");
    expect(out[0].content).toContain("摘要：完成 X；下一步 Y");
    expect(out[0].content).toContain("24"); // 40 条记录，裁掉 24 条
    expect(out[1].role).toBe("assistant"); // 垫脚：保证 user→assistant 交替
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role).not.toBe(out[i - 1].role);
    }
    expect(validateHistory(out).ok, "压缩产物没过硬不变量").toBe(true);
  });

  it("🐛 结构必须**原样保留**：tool_calls / tool_call_id 不许被丢、`tool` 角色不许塌成 user", () => {
    const msgs: Array<{ role: string; content: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> = [
      { role: "user", content: "老问题" },
      { role: "assistant", content: "" },
      { role: "user", content: "读一下文件" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1" }],
      },
      { role: "tool", content: "文件内容", tool_call_id: "call_1" },
      { role: "assistant", content: "读完了" },
    ];
    const out = buildCompactedHistory("摘要", msgs, 2);
    // 保留最近 2 轮：user(读一下文件) + assistant(tool_calls) + tool + assistant
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg, "`tool` 角色被塌成了 user ⇒ 工具配对被破坏（I1）").toBeDefined();
    expect(toolMsg?.tool_call_id, "tool_call_id 丢了 ⇒ 配对不上").toBe("call_1");
    const callMsg = out.find((m) => Array.isArray(m.tool_calls));
    expect(callMsg, "assistant.tool_calls 丢了 ⇒ 配对被单边删除（I1）").toBeDefined();
    expect(validateHistory(out).ok, "含工具调用的序列压缩后必须仍然合法").toBe(true);
  });

  it("A-1082：「理解总结」环的续接认知并入摘要头（同一条 user，不破坏角色交替）", () => {
    const out = buildCompactedHistory("摘要正文", turns(10), 3, { comprehend: "目标：X\n已完成：Y\n失败：无\n未决：Z\n下一步：W" });
    expect(out[0].content).toContain("摘要正文");
    expect(out[0].content).toContain("续接认知");
    expect(out[0].content).toContain("下一步：W");
    expect(out[1].role, "续接认知另起了一条 ⇒ 角色交替被破坏").toBe("assistant");
    expect(validateHistory(out).ok).toBe(true);
  });

  it("摘要头必须写明「不是待执行的新任务」（防 Build→Compact 无限循环）", () => {
    const out = buildCompactedHistory("摘要", turns(10), 3);
    expect(out[0].content).toMatch(/不是待执行的新任务|仅作延续上下文/);
  });

  it("首条即 assistant 的病态输入 → 丢弃开头非 user 的消息，绝不产出连续同角色", () => {
    const msgs = [
      { role: "assistant", content: "孤儿回复" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const out = buildCompactedHistory("摘要", msgs, 1);
    expect(validateHistory(out).ok, "病态输入下仍必须合法").toBe(true);
  });

  it("DEFAULT_TAIL_KEEP 语义是**轮**（6 轮 ≡ 持久化历史的 12 条消息，与旧行为体积等价）", () => {
    expect(DEFAULT_TAIL_KEEP).toBe(6);
    expect(truncateTurnAligned(turns(20), DEFAULT_TAIL_KEEP).length).toBe(12);
  });
});
