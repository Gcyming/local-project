/**
 * tests/gui/request-owner.spec.ts — 请求归属判定与「丢弃留痕」（A-1047 / Task #156）。
 *
 * 锁三类事实：
 *   ① 判定表：与改写前那行 `sessionId !== undefined ? sessionId : streamSid` **逐档一致**
 *      （`null` 必须按"已标注"处理 —— 放行它就会让旧会话的选择题占住输入框，A-151 前科）。
 *   ② 丢弃决策：`skipped: true` / `approved: false`，且**绝不** `alwaysAllow`。
 *   ③ 接线：ChatPanel 的**两个**订阅点（权限 + ask_user）都走了这个判据，
 *      且丢弃时**真的回了一个决策**（只写 console.warn 而不回决策 = 半修，主进程照样干等 300s）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REQUEST_DROP_MARKER,
  buildAskDismissDecision,
  buildPermDismissDecision,
  classifyRequestOwner,
  describeRequestDrop,
  type RequestDropReason,
} from "../../gui/src/renderer/pages/requestOwner.js";

const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const src = readFileSync(resolve(__dirname, "../..", PANEL), "utf8");

const CUR = "s_cur";

describe("A-1047 ① 归属判定表（与改写前逐档一致）", () => {
  it("已标注且匹配 → 放行", () => {
    expect(classifyRequestOwner(CUR, "s_other", CUR)).toEqual({ ok: true });
  });

  it("已标注但属于别的会话 → stale-session（正常丢弃）", () => {
    const r = classifyRequestOwner("s_old", "s_other", CUR);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("stale-session");
  });

  it("⚠️ sessionId 为 null 按**已标注**处理 → 丢弃（放行会让旧会话选择题占住输入框）", () => {
    const r = classifyRequestOwner(null, CUR, CUR);
    expect(r.ok, "标了空 sessionId 却因为流匹配被放行 = 回归 A-151").toBe(false);
    expect(r.ok === false && r.reason).toBe("labeled-empty");
  });

  it("未标注 + 当前无活跃流 → unlabeled-no-active-stream", () => {
    const r = classifyRequestOwner(undefined, null, CUR);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("unlabeled-no-active-stream");
  });

  it("未标注 + 活跃流属于当前会话 → 放行", () => {
    expect(classifyRequestOwner(undefined, CUR, CUR)).toEqual({ ok: true });
  });

  it("未标注 + 活跃流属于别的会话 → unlabeled-other-session", () => {
    const r = classifyRequestOwner(undefined, "s_stream", CUR);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("unlabeled-other-session");
  });

  it("每种原因都能说成人话（进日志/回传文本，不许只剩一个枚举名）", () => {
    const reasons: RequestDropReason[] = [
      "stale-session",
      "labeled-empty",
      "unlabeled-no-active-stream",
      "unlabeled-other-session",
    ];
    for (const reason of reasons) {
      const text = describeRequestDrop({ ok: false, reason, detail: "d" });
      expect(text.length, `${reason} 没有可读描述`).toBeGreaterThan(6);
      expect(text).toContain("d");
    }
  });
});

describe("A-1047 ② 丢弃决策（用既有字段，不新增协议）", () => {
  it("ask_user：skipped=true，且原因真的写进 answer（Agent 不会干等）", () => {
    const d = buildAskDismissDecision("r1", "旧会话的迟到请求（x）");
    expect(d.requestId).toBe("r1");
    expect(d.skipped).toBe(true);
    expect(d.answer).toContain("已丢弃");
    expect(d.answer).toContain("旧会话的迟到请求");
  });

  it("权限：不批准 + 原因完整 + **绝不** alwaysAllow（丢弃不能变成永久放行）", () => {
    const d = buildPermDismissDecision("r2", "无法判定归属：x");
    expect(d.requestId).toBe("r2");
    expect(d.approved).toBe(false);
    expect(d.alwaysAllow, "丢弃绝不能顺手开成 alwaysAllow").toBe(false);
    expect(d.reason).toContain("已丢弃");
  });
});

describe("A-1047 ③ 接线：两个订阅点都走判据，且丢弃时真的回了决策", () => {
  it("权限与 ask_user **两处**都调用 classifyRequestOwner（修一个不够）", () => {
    const n = (src.match(/classifyRequestOwner\(/g) ?? []).length;
    expect(n, "两个同形订阅点必须都用上同一份判据").toBeGreaterThanOrEqual(2);
  });

  it("没有残留裸的 `reqSid !== sessionRef.current` 判定（判据必须唯一）", () => {
    expect(src, "发现了散落的旧判定 —— 判据会分成两份各自漂移").not.toMatch(/reqSid\s*!==\s*sessionRef\.current/);
  });

  it("丢弃分支留了可 grep 的痕（REQUEST_DROP_MARKER）", () => {
    expect(REQUEST_DROP_MARKER, "前缀本身要稳定（它是全站翻丢弃记录的 grep 锚）").toBe("[slime:req-drop]");
    // 源码里是模板插值 `${REQUEST_DROP_MARKER}`，两处丢弃都必须带上它
    const uses = (src.match(/\$\{REQUEST_DROP_MARKER\}/g) ?? []).length;
    expect(uses, "两处丢弃都要带统一前缀（写死字符串会与常量漂移）").toBe(2);
  });

  it("丢弃后**真的回传决策**（只 console.warn 不回决策 = 主进程照样干等 300s）", () => {
    // ask_user 分支
    const askBranch = src.slice(src.indexOf("ask_user 提问 ${req.requestId} 被丢弃") - 400, src.indexOf("ask_user 提问 ${req.requestId} 被丢弃") + 300);
    expect(askBranch).toMatch(/askUser\?\.resolve\?\.\(buildAskDismissDecision\(/);
    // 权限分支
    const permBranch = src.slice(src.indexOf("权限请求 ${req.requestId} 被丢弃") - 400, src.indexOf("权限请求 ${req.requestId} 被丢弃") + 300);
    expect(permBranch).toMatch(/perm\?\.resolve\?\.\(buildPermDismissDecision\(/);
  });
});
