





















import type { OperationFocusUI } from "../../shared/ipc.js";


export const OP_FOCUS_EVENT = "slime-operation-focus";







export type OperationFocusTarget = "browser" | "desktop" | "device";

export interface OpFocusRect { x: number; y: number; width: number; height: number }

export interface OperationFocusPayload {
  phase: "begin" | "end";
  target: OperationFocusTarget;
  
  label: string;
  
  rect?: OpFocusRect | null;
  
  waitingUser?: boolean;
}

export interface OperationFocusState {
  active: boolean;
  target: OperationFocusTarget | null;
  label: string;
  rect: OpFocusRect | null;
  waitingUser: boolean;
  
  ts: number;
}

export const OP_FOCUS_IDLE: OperationFocusState = {
  active: false, target: null, label: "", rect: null, waitingUser: false, ts: 0,
};






export const OP_FOCUS_MAX_HOLD_MS = 90_000;


export const OP_FOCUS_HINT_KEY = "slime.opFocus.hintHidden";









export function reduceOperationFocus(
  prev: OperationFocusState,
  p: OperationFocusPayload,
  now: number,
): OperationFocusState {
  if (p.phase === "end") {
    
    if (prev.active && prev.target && p.target && prev.target !== p.target) { return prev; }
    return {
      active: false,
      target: p.target || prev.target,
      label: p.label || prev.label,
      rect: p.rect ?? prev.rect,
      waitingUser: false,
      ts: now,
    };
  }
  return {
    active: true,
    target: p.target || prev.target,
    label: p.label || prev.label,
    rect: p.rect ?? null,
    waitingUser: p.waitingUser === true,
    ts: now,
  };
}


export function isOpFocusStale(s: OperationFocusState, now: number): boolean {
  return s.active && now - s.ts > OP_FOCUS_MAX_HOLD_MS;
}


export function fromOperationFocusUI(e: OperationFocusUI): OperationFocusPayload {
  return {
    phase: e?.phase === "end" ? "end" : "begin",
    target: e?.backend === "android" ? "device" : "desktop",
    label: String(e?.label ?? ""),
    
    rect: null,
    waitingUser: e?.waitingUser === true,
  };
}


export function describeOpFocusTarget(t: OperationFocusTarget | null): string {
  if (t === "browser") { return "右栏浏览器"; }
  if (t === "device") { return "安卓设备"; }
  if (t === "desktop") { return "你的主机屏幕"; }
  return "目标界面";
}


export function publishOperationFocus(p: OperationFocusPayload): void {
  try {
    window.dispatchEvent(new CustomEvent<OperationFocusPayload>(OP_FOCUS_EVENT, { detail: p }));
  } catch {  }
}


export function readOpFocusHintHidden(): boolean {
  try { return window.localStorage.getItem(OP_FOCUS_HINT_KEY) === "1"; } catch { return false; }
}

export function writeOpFocusHintHidden(hidden: boolean): void {
  try { window.localStorage.setItem(OP_FOCUS_HINT_KEY, hidden ? "1" : "0"); } catch {  }
}
