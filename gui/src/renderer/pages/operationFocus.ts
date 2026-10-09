





















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



/** A-1197：未保存改动提醒的「以后不再」键位。
 *
 *  ⚠️ 与 `OP_FOCUS_HINT_KEY` **刻意不共用同一个键**，但完全沿用同一套命名与存储形态
 *  （`slime.<域>.hintHidden`，值恒为 "1" / "0"）。
 *  不共键的理由：两类提示互不相干——共用后「关掉操作焦点提示」会顺带关掉
 *  「切 Agent 会丢改动」这条更重要的警告，反之亦然。
 *  读写函数与提示本体同放一处，是为了避免第二产地各写一套 localStorage 形态（键位漂移）。
 */
export const UNSAVED_HINT_KEY = "slime.unsavedChanges.hintHidden";



/** 读「以后不再提示未保存改动」。存储不可用（隐私模式 / preload 缺失）时**出声**后按"未隐藏"处理。 */
export function readUnsavedHintHidden(): boolean {
  try {
    return window.localStorage.getItem(UNSAVED_HINT_KEY) === "1";
  } catch (e) {
    console.error("[unsaved-hint] 读取失败，本次按「仍要提示」处理：", e);
    return false;
  }
}



/** 写「以后不再提示未保存改动」。写失败必须出声——否则用户以为关掉了，其实每次都被弹。 */
export function writeUnsavedHintHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(UNSAVED_HINT_KEY, hidden ? "1" : "0");
  } catch (e) {
    console.error("[unsaved-hint] 写入失败，「以后不再」未生效（下次仍会提示）：", e);
  }
}
