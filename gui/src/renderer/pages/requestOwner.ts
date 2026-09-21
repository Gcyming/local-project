/**
 * gui/src/renderer/pages/requestOwner.ts — 请求（权限 / ask_user）**归属判定 + 丢弃留痕**（A-1047 / Task #156）。
 *
 * 为什么单独立一个纯模块：ChatPanel 里有两个**同形**的订阅点（权限请求 / ask_user 提问），
 * 各自写了一句 `if (reqSid !== sessionRef.current) { return; }`。这是**两个独立的产地**——
 * 修一个不够（群聊「总结复读」已经吃过一次这个亏），判据必须只有一份。
 *
 * 而且这句 `return` 是**静默**的：
 *   · 控制台一行不写、界面一点不动；
 *   · 主进程那边的请求还在等回答，要等满 300s 超时才放行；
 *   · 用户看到的是「Agent 卡住不说话」，而界面上连个提问都没有 —— 最难查的一类失效。
 *
 * 所以丢弃必须**留两次痕**：
 *   ① 控制台一条可 grep 的记录（`REQUEST_DROP_MARKER`）；
 *   ② **立刻回一个"跳过"决策**，让主进程马上放行，而不是干等超时。
 * （② 用的是既有协议字段：ask_user 走 `skipped: true`，权限走 `approved: false`，都不新增字段。）
 *
 * ⚠️ 判定语义必须与改写前的那行完全一致（`sessionId !== undefined ? sessionId : streamSid`）：
 *    连 `sessionId: null` 这种"标了但是空"的情况也要按**已标注**处理，
 *    否则会把原本该丢弃的请求放行 —— 输入框被旧会话的选择题占用（A-151 前科）。
 */
import type { AskUserDecision, PermissionDecision } from "../../shared/ipc.js";

/** 丢弃原因（可诊断，不是一句"不匹配"） */
export type RequestDropReason =
  /** 带了 sessionId，但属于别的会话（旧会话的迟到请求 —— 正常丢弃） */
  | "stale-session"
  /** 带了 sessionId，但它是空值（协议异常 —— 值得出声） */
  | "labeled-empty"
  /** 没带 sessionId，且当前没有活跃流（无从判定归属 —— 值得出声） */
  | "unlabeled-no-active-stream"
  /** 没带 sessionId，活跃流属于别的会话 */
  | "unlabeled-other-session";

export type RequestOwner =
  | { ok: true }
  | { ok: false; reason: RequestDropReason; detail: string };

/** 控制台留痕的统一前缀（grep 这个串就能把全站的丢弃翻出来） */
export const REQUEST_DROP_MARKER = "[slime:req-drop]";

/**
 * 请求是否属于当前会话。
 *
 * @param reqSid    请求自带的 sessionId（`undefined` = 未标注；`null` = 标了但为空）
 * @param streamSid 当前活跃流所属会话（无活跃流 = null）
 * @param currentSid 界面当前会话
 */
export function classifyRequestOwner(
  reqSid: string | null | undefined,
  streamSid: string | null,
  currentSid: string,
): RequestOwner {
  // ── 已标注：以标签为准（含 null —— 与改写前语义一致，标了空的按"不属于当前会话"处理） ──
  if (reqSid !== undefined) {
    if (reqSid === currentSid) { return { ok: true }; }
    if (reqSid === null) {
      return { ok: false, reason: "labeled-empty", detail: `请求带了空的 sessionId，当前会话 ${currentSid}` };
    }
    return { ok: false, reason: "stale-session", detail: `请求属于会话 ${reqSid}，当前在 ${currentSid}` };
  }
  // ── 未标注：退回「流归属」判定 ──
  if (!streamSid) {
    return {
      ok: false,
      reason: "unlabeled-no-active-stream",
      detail: "请求未带 sessionId，且当前没有活跃流（无从判定归属）",
    };
  }
  if (streamSid === currentSid) { return { ok: true }; }
  return {
    ok: false,
    reason: "unlabeled-other-session",
    detail: `请求未带 sessionId，活跃流属于会话 ${streamSid}，当前在 ${currentSid}`,
  };
}

/** 丢弃原因 → 人话（进日志，也进回给主进程的决策文本） */
export function describeRequestDrop(r: { ok: false; reason: RequestDropReason; detail: string }): string {
  switch (r.reason) {
    case "stale-session":
      return `旧会话的迟到请求（${r.detail}）`;
    case "labeled-empty":
      return `sessionId 为空（${r.detail}）`;
    case "unlabeled-no-active-stream":
      return `无法判定归属：${r.detail}`;
    case "unlabeled-other-session":
      return `无法判定归属：${r.detail}`;
    default:
      return r.detail;
  }
}

/** ask_user：丢弃时回给主进程的决策（skipped=true，语义与「跳过」一致，但带上原因） */
export function buildAskDismissDecision(requestId: string, why: string): AskUserDecision {
  return { requestId, answer: `（已丢弃：${why}）`, skipped: true };
}

/** 权限请求：丢弃时回给主进程的决策（不批准 + 带原因；绝不 alwaysAllow） */
export function buildPermDismissDecision(requestId: string, why: string): PermissionDecision {
  return { requestId, approved: false, reason: `（已丢弃：${why}）`, alwaysAllow: false };
}
