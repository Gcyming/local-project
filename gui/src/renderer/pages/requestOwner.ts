




















import type { AskUserDecision, PermissionDecision } from "../../shared/ipc.js";


export type RequestDropReason =
  
  | "stale-session"
  
  | "labeled-empty"
  
  | "unlabeled-no-active-stream"
  
  | "unlabeled-other-session";

export type RequestOwner =
  | { ok: true }
  | { ok: false; reason: RequestDropReason; detail: string };


export const REQUEST_DROP_MARKER = "[slime:req-drop]";








export function classifyRequestOwner(
  reqSid: string | null | undefined,
  streamSid: string | null,
  currentSid: string,
): RequestOwner {
  
  if (reqSid !== undefined) {
    if (reqSid === currentSid) { return { ok: true }; }
    if (reqSid === null) {
      return { ok: false, reason: "labeled-empty", detail: `请求带了空的 sessionId，当前会话 ${currentSid}` };
    }
    return { ok: false, reason: "stale-session", detail: `请求属于会话 ${reqSid}，当前在 ${currentSid}` };
  }
  
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


export function buildAskDismissDecision(requestId: string, why: string): AskUserDecision {
  return { requestId, answer: `（已丢弃：${why}）`, skipped: true };
}


export function buildPermDismissDecision(requestId: string, why: string): PermissionDecision {
  return { requestId, approved: false, reason: `（已丢弃：${why}）`, alwaysAllow: false };
}
