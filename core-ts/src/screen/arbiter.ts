
































export const USER_ACTIVE_WINDOW_MS = 700;


export const USER_YIELD_MAX_WAIT_MS = 6000;


export const USER_YIELD_PROBE_MS = 250;

export interface YieldInput {
  




  idleMs: number | null;
  
  waitedMs: number;
  activeWindowMs: number;
  maxWaitMs: number;
  
  probeMs?: number;
}

export type YieldDecision =
  | { action: "proceed"; waitedMs: number; note: string }
  | { action: "wait"; waitMs: number }
  | { action: "abort"; waitedMs: number; reason: string };







export function decideUserYield(input: YieldInput): YieldDecision {
  const { idleMs, waitedMs, activeWindowMs, maxWaitMs } = input;
  const probeMs = Math.max(50, input.probeMs ?? USER_YIELD_PROBE_MS);

  
  if (idleMs === null || !Number.isFinite(idleMs)) {
    return {
      action: "proceed",
      waitedMs,
      note: "（未能读取系统空闲时间，本次未做「用户让位」检查）",
    };
  }

  const idle = Math.max(0, Math.round(idleMs));
  
  if (idle >= activeWindowMs) {
    return { action: "proceed", waitedMs, note: "" };
  }

  
  
  const need = activeWindowMs - idle;
  if (waitedMs + need <= maxWaitMs) {
    return { action: "wait", waitMs: Math.max(1, Math.min(need, probeMs)) };
  }

  
  return {
    action: "abort",
    waitedMs,
    reason:
      `用户正在操作这台电脑（系统空闲仅 ${idle}ms < ${activeWindowMs}ms），`
      + `Agent 已让位等待 ${Math.round(waitedMs)}ms 仍未等到空闲 → **本次动作未执行**。`
      + `这不是失败，是刻意不与你抢鼠标：请等用户停手后再重试（或让用户点一下「暂停 Agent 操作」）。`,
  };
}





export interface Region { x: number; y: number; width: number; height: number }


export const OPERATION_BOX_W = 300;
export const OPERATION_BOX_H = 220;








export function operationRegionBox(input: {
  targetRegion?: Region | null;
  point?: { x?: number; y?: number } | null;
  fallback?: Region | null;
}): Region | null {
  const usable = (r: Region | null | undefined): Region | null =>
    r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0 ? r : null;

  const win = usable(input.targetRegion);
  if (win) { return win; }

  const px = input.point?.x;
  const py = input.point?.y;
  if (typeof px === "number" && typeof py === "number" && Number.isFinite(px) && Number.isFinite(py)) {
    return {
      x: Math.round(px - OPERATION_BOX_W / 2),
      y: Math.round(py - OPERATION_BOX_H / 2),
      width: OPERATION_BOX_W,
      height: OPERATION_BOX_H,
    };
  }

  return usable(input.fallback);
}
