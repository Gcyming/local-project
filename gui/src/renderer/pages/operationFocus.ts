/**
 * gui/src/renderer/pages/operationFocus.ts — A-1044：**图形操作可视化**的判据与事件总线（纯逻辑）。
 *
 * ## 用户报的问题（原话）
 * 「当 agent 操作我这里或者操作 slime 内的一些地方的时候，我点击 slime 内的一些地方时，
 *   操作点击的地方会失效，要重新点击 —— 你是不是设置的时候没设好，Agent 的操作与用户操作未作隔离？」
 *
 * ## 为什么"隔离"做不到、只能"可见化 + 让位"
 * Windows 没有合法通道让第三方进程「不抢焦点地把输入送进别人的窗口」：宿主桌面后端用
 * `SetCursorPos` + `mouse_event` 注入，用的是**全局唯一物理指针**与**前台窗口**这两个共享资源；
 * 应用内右栏浏览器则用 `wv.focus()` 抢应用内焦点。两边都是"共享资源竞争"，不是配置问题。
 * 行业同源证据：headed 浏览器里 CDP `Input.dispatchMouseEvent` 同样走原生输入管线移动真实指针
 * （「CDP 永远隔离」只在 headless 成立）。所以正确的工程答案是**人优先**：
 *   ① 检测到用户在用键鼠 → Agent 让位等待（判据唯一实现 `core-ts/src/screen/arbiter.ts`）；
 *   ② 等不到就让路并如实汇报，**绝不硬点上去抢指针**；
 *   ③ 让"Agent 正在操作哪一块"**看得见** —— 就是本模块 + `OperationFocusOverlay`。
 *
 * ## 本模块的职责边界
 * 「当前有没有正在进行的操作、操作的是哪里」**只在这里推导一处**（`reduceOperationFocus`），
 * 组件只负责把状态映射成样式（与 A-1029 的 `diffNoticeKind` / A-1028 的 `toolStatusLabel` 同范式：
 * 判据不许散进 `.tsx` 的条件表达式，否则守卫只能锁措辞而不是锁行为）。
 */
import type { OperationFocusUI } from "../../shared/ipc.js";

/** 应用内（渲染层）派发的事件名 —— browserBridge 用它上报「正在操作右栏浏览器」。 */
export const OP_FOCUS_EVENT = "slime-operation-focus";

/**
 * 被操作对象的类别（决定边框画在哪）：
 *  · `browser` —— 右栏内嵌浏览器（应用**内**坐标，有精确矩形）；
 *  · `desktop` —— 整机屏幕（宿主桌面后端，虚拟桌面坐标，画不到宿主窗口上 → 画在应用边缘）；
 *  · `device`  —— 安卓设备（adb input，设备坐标，同理）。
 */
export type OperationFocusTarget = "browser" | "desktop" | "device";

export interface OpFocusRect { x: number; y: number; width: number; height: number }

export interface OperationFocusPayload {
  phase: "begin" | "end";
  target: OperationFocusTarget;
  /** 人话标签（悬浮提示直接显示，如「点击 (812, 431)」） */
  label: string;
  /** `browser` 目标：webview 在**应用视口**里的矩形；其余目标为 null */
  rect?: OpFocusRect | null;
  /** 本次是否需要让位给用户（true → 提示里说明"正在等你停手"） */
  waitingUser?: boolean;
}

export interface OperationFocusState {
  active: boolean;
  target: OperationFocusTarget | null;
  label: string;
  rect: OpFocusRect | null;
  waitingUser: boolean;
  /** 最近一次事件时刻（看门狗判据用） */
  ts: number;
}

export const OP_FOCUS_IDLE: OperationFocusState = {
  active: false, target: null, label: "", rect: null, waitingUser: false, ts: 0,
};

/**
 * 看门狗上限：这么久没收到 `end` 就当作已结束。
 * 为什么需要：`end` 由 `finally` 保证发出，但主进程被强杀 / 渲染层重载会丢掉它 ——
 * 边框会永远转下去（且用户以为 Agent 还在动）。宁可早停，也不许留下一个假的活动指示。
 */
export const OP_FOCUS_MAX_HOLD_MS = 90_000;

/** 「不再自动弹悬浮提示」的持久化键（用户主动隐藏后跨会话生效）。 */
export const OP_FOCUS_HINT_KEY = "slime.opFocus.hintHidden";

/**
 * 状态机（唯一实现）。三条不变量：
 *   ① `begin` → 立刻可见（`active:true`）；
 *   ② `end` → 熄灭，但**保留 label/rect**（淡出那一帧还要用；清空会让末帧闪成空框）；
 *   ③ **别人的 `end` 不许熄灭我的边框** —— 两条路径（右栏浏览器 / 宿主屏幕）可能交错：
 *      浏览器操作开始时桌面操作还没 `end`，此时到来的 `end` 若被无条件接受，
 *      正在进行的那个操作指示会凭空消失（"Agent 还在动，框却没了"）。
 */
export function reduceOperationFocus(
  prev: OperationFocusState,
  p: OperationFocusPayload,
  now: number,
): OperationFocusState {
  if (p.phase === "end") {
    // ③ 目标不一致 → 这是另一条路径的收尾，不动当前状态
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

/** 看门狗：活动状态但太久没有新事件 → 视为已结束（渲染层重载/进程被杀后的兜底）。 */
export function isOpFocusStale(s: OperationFocusState, now: number): boolean {
  return s.active && now - s.ts > OP_FOCUS_MAX_HOLD_MS;
}

/** 把主进程 `OperationFocusUI` 归一到本模块的载荷（跨进程字段名只在这一处翻译）。 */
export function fromOperationFocusUI(e: OperationFocusUI): OperationFocusPayload {
  return {
    phase: e?.phase === "end" ? "end" : "begin",
    target: e?.backend === "android" ? "device" : "desktop",
    label: String(e?.label ?? ""),
    // 宿主坐标（虚拟桌面/设备像素）与应用内坐标**不是同一个空间**，绝不拿来画应用内的框
    rect: null,
    waitingUser: e?.waitingUser === true,
  };
}

/** 目标类别 → 悬浮提示里的人话（判据唯一实现，组件不写 if/else 拼词）。 */
export function describeOpFocusTarget(t: OperationFocusTarget | null): string {
  if (t === "browser") { return "右栏浏览器"; }
  if (t === "device") { return "安卓设备"; }
  if (t === "desktop") { return "你的主机屏幕"; }
  return "目标界面";
}

/** 派发一次可视化事件（应用内路径：右栏浏览器的操作）。非浏览器环境静默忽略。 */
export function publishOperationFocus(p: OperationFocusPayload): void {
  try {
    window.dispatchEvent(new CustomEvent<OperationFocusPayload>(OP_FOCUS_EVENT, { detail: p }));
  } catch { /* 单测/SSR 环境无 window */ }
}

/** 读取「悬浮提示是否已被用户手动隐藏」。localStorage 不可用时按"未隐藏"处理。 */
export function readOpFocusHintHidden(): boolean {
  try { return window.localStorage.getItem(OP_FOCUS_HINT_KEY) === "1"; } catch { return false; }
}

export function writeOpFocusHintHidden(hidden: boolean): void {
  try { window.localStorage.setItem(OP_FOCUS_HINT_KEY, hidden ? "1" : "0"); } catch { /* 忽略 */ }
}
