/**
 * tests/core-ts/resume-outcome.spec.ts — 「切换会话后永久停在（恢复中…）」的收尾判定守卫（A-1051）。
 *
 * 盯的病：**用户切回会话，气泡永远停在「（恢复中…）」，且此前刚输出的回复"凭空消失"**。
 * 两个都不是崩溃、都没有报错，都是判据错配：
 *   ① `isActive` 查询失败（方法缺失 / IPC 抖动）被 `.catch(() => null)` 吞成 `null`，
 *      与"仍在活跃"走同一分支**直接 return** → 没有重试、没有兜底 → loading 永久保持。
 *   ② "结束 loading"被绑在**粘性** `stoppingRef` 上（其语义是"别自动重连"），而 `onDone`
 *      的切走早退分支漏复位它 → 残留 `true` 让此后每次切回都跳过 `setLoading(false)`。
 *
 * 这一族守卫锁两个层次，缺一层就会重演：
 *  A. **语义层**（`decideResumeOutcome`）：四支判定的优先级与取舍，尤其"重试耗尽 → 结束 loading
 *     但保留气泡、且**不**打判死标记"这条刻意取舍。
 *  B. **契约层**（ChatPanel 源码静态不变式）：判定必须真的被调用；老判据必须绝迹；
 *     早退分支必须补齐复位 —— 少任何一环都静默。
 *
 * ⚠️ 验收标准是**变异测试**：写完必须逐条把源码改坏、确认它变红。
 *    "通过但锁错对象"比没有守卫更糟。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideResumeOutcome,
  RESUME_MAX_ATTEMPTS,
  RESUME_QUERY_RETRY_MS,
} from "../../gui/src/renderer/pages/resumeOutcome.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHAT_PANEL = join(ROOT, "gui", "src", "renderer", "pages", "ChatPanel.tsx");

/**
 * 剥掉块注释与行注释。
 * 必须剥：本文件的契约断言里，"老写法"与"resetStreamUI(); return;" 这类字样会**出现在
 * ChatPanel 的讲解注释里**，直接在原文上匹配会自伤（把正确的代码判成回归）。
 * 行注释正则用 `[^:]` 前缀避开 `http://` 这类 URL。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const chatSrc = stripComments(readFileSync(CHAT_PANEL, "utf8"));

/** 默认入参：查询失败、未重试过、无正文 —— 各用例只覆盖自己关心的字段。 */
const base = {
  query: undefined as { active: boolean } | null | undefined,
  attempts: 0,
  maxAttempts: RESUME_MAX_ATTEMPTS,
  partial: "",
  hasTailError: false,
};

describe("A-1051 A. decideResumeOutcome 语义", () => {
  it("流仍在跑（active=true）→ 保持 loading、气泡原样等待续长、不重试", () => {
    const out = decideResumeOutcome({ ...base, query: { active: true }, partial: "已经写了一部分" });
    expect(out).toEqual({ endLoading: false, bubble: "keep", retry: false, confirmedDead: false });
  });

  it("流仍在跑 → 即使已有正文也**不许**提前转结算气泡（否则正文会被冻结）", () => {
    const out = decideResumeOutcome({ ...base, query: { active: true }, partial: "半截回复" });
    expect(out.bubble).toBe("keep");
    expect(out.endLoading).toBe(false);
  });

  it("权威判死（active=false）且有正文 → 结束 loading + 转结算气泡 + 打判死标记", () => {
    const out = decideResumeOutcome({ ...base, query: { active: false }, partial: "  完整回复  " });
    expect(out).toEqual({ endLoading: true, bubble: "settle", retry: false, confirmedDead: true });
  });

  it("权威判死但无正文（纯思考后断流）→ 移除占位气泡，不留空壳", () => {
    const out = decideResumeOutcome({ ...base, query: { active: false }, partial: "   " });
    expect(out.endLoading).toBe(true);
    expect(out.bubble).toBe("drop");
    expect(out.confirmedDead).toBe(true);
  });

  it("权威判死 + 错误收尾（tailError）→ 不建结算气泡（落库文本会带 [截断] 后缀，会与历史双份）", () => {
    const out = decideResumeOutcome({ ...base, query: { active: false }, partial: "报错前的半截", hasTailError: true });
    expect(out.bubble).toBe("drop");
    expect(out.endLoading).toBe(true);
  });

  it("查询失败且未达上限 → 保持现状 + 请求重试（不改任何 UI，给瞬时抖动留机会）", () => {
    const out = decideResumeOutcome({ ...base, query: null, attempts: 0, partial: "在途正文" });
    expect(out).toEqual({ endLoading: false, bubble: "keep", retry: true, confirmedDead: false });
  });

  it("查询失败（undefined）与 null 同等对待 —— 都**不是**「不活跃」", () => {
    const a = decideResumeOutcome({ ...base, query: undefined, attempts: 0 });
    const b = decideResumeOutcome({ ...base, query: null, attempts: 0 });
    expect(a).toEqual(b);
    expect(a.endLoading).toBe(false);
  });

  it("查询失败且已达上限 → 结束 loading 但**保留气泡**、**不打**判死标记（核心取舍）", () => {
    const out = decideResumeOutcome({ ...base, query: null, attempts: RESUME_MAX_ATTEMPTS, partial: "在途正文" });
    // 没有证据支撑"流还活着"→ 不让用户无限期看着「恢复中」；
    // 也没有证据支撑"流已死"→ 不删气泡、不标记判死（万一流还活着，chunk 到了照样续长）。
    expect(out).toEqual({ endLoading: true, bubble: "keep", retry: false, confirmedDead: false });
  });

  it("重试次数用满即放弃等待：attempts 从 0 数到上限，恰好重试 maxAttempts 次", () => {
    let retries = 0;
    for (let attempts = 0; attempts <= RESUME_MAX_ATTEMPTS; attempts++) {
      if (decideResumeOutcome({ ...base, query: null, attempts }).retry) { retries++; }
    }
    expect(retries).toBe(RESUME_MAX_ATTEMPTS);
  });

  it("优先级：有效答复（active=false）胜过「重试已耗尽」—— 顺序即优先级", () => {
    const out = decideResumeOutcome({ ...base, query: { active: false }, attempts: 99, partial: "正文" });
    expect(out.confirmedDead).toBe(true);
    expect(out.bubble).toBe("settle");
  });

  it("优先级：有效答复（active=true）胜过「重试已耗尽」", () => {
    const out = decideResumeOutcome({ ...base, query: { active: true }, attempts: 99 });
    expect(out.endLoading).toBe(false);
  });

  it("常量取值成立（上限为 0 等于从不重试；间隔为 0 等于忙等）", () => {
    expect(RESUME_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(RESUME_QUERY_RETRY_MS).toBeGreaterThan(0);
  });
});

describe("A-1051 B. 契约层：ChatPanel 必须真的走这套判定", () => {
  it("恢复收尾调用纯函数判定（否则模块白建、老判据会悄悄回来）", () => {
    expect(chatSrc).toContain("decideResumeOutcome({");
    expect(chatSrc).toContain("RESUME_MAX_ATTEMPTS");
  });

  it("老判据绝迹：不再把「结束 loading」绑在粘性的 stoppingRef 上（永久「恢复中」根因）", () => {
    expect(chatSrc).not.toMatch(/streamActiveRef\.current\s*&&\s*!stoppingRef\.current/);
  });

  it("onDone 的「流在切走期间结束」早退分支必须复位 stoppingRef（A-982 只补了两个压缩闸门）", () => {
    const m = /\} else if \(streamSessionRef\.current !== sessionRef\.current\) \{([\s\S]*?)return;/.exec(chatSrc);
    expect(m, "onDone 里切走早退分支的结构变了，守卫需同步更新").toBeTruthy();
    expect(
      m?.[1],
      "早退分支没有复位 stoppingRef → 流式期间切走会让它永久为 true，污染后续流的自动重连",
    ).toContain("stoppingRef.current = false;");
  });

  it("判死标记只在拿到「流已死」证据时才置位（重试耗尽不得冒充证据）", () => {
    // 接入点必须是 `if (outcome.confirmedDead)` 守卫，而不是无条件 `streamConfirmedDead = true`
    const m = /if \(outcome\.confirmedDead\) \{([\s\S]*?)\}/.exec(chatSrc);
    expect(m, "接入点的 confirmedDead 守卫结构变了，守卫需同步更新").toBeTruthy();
    expect(m?.[1]).toContain("streamConfirmedDead = true;");
  });

  it("isActive 调用对「方法缺失」也安全：可选调用后直接 .catch 会抛 TypeError 且无人接", () => {
    // `api.chat?.isActive?.(sid)` 在方法缺失时求值为 undefined，紧随的 `.catch` **不被可选链保护**
    // → `undefined.catch` 抛 TypeError → async IIFE reject（无 catch）→ setLoading(false) 永不执行。
    // 这是与「被吞成 null」机制不同的**第二条独立卡死路径**，必须靠 Promise.resolve 包裹兜住。
    expect(
      chatSrc,
      "isActive 调用没有用 Promise.resolve 包裹 → 方法缺失时会抛 TypeError，永久「恢复中」",
    ).toMatch(/Promise\.resolve\(\s*api\.chat\?\.isActive\?\.\(/);
  });
});
