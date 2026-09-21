/**
 * core-ts/src/screen/arbiter.ts — A-1044：**用户与 Agent 的输入仲裁**（纯逻辑，vitest 直测）。
 *
 * ## 用户报的问题（原话）
 * 「当 agent 操作我这里或者操作 slime 内的一些地方的时候，我点击 slime 内的一些地方时，
 *   操作点击的地方会失效，要重新点击。」
 *
 * ## 根因（两条路径，都不能靠"隔离"解决）
 *
 * **① 宿主桌面路径**（`backends/desktop.ts`）：用 `SetCursorPos` + `mouse_event` 注入输入 ——
 * 这是**全局唯一物理指针**与**前台窗口**这两个共享资源。用户与 Agent 同时在用同一个指针：
 *    - 用户 mousedown 在 A 点、Agent 在两者之间把指针 `SetCursorPos` 搬到 B 点 →
 *      mouseup 落在 B → 浏览器判定为「A→B 的拖拽/另一处点击」，**A 点这一击不成立**（要重按）；
 *    - 动作前的 `SetForegroundWindow` 把 slime 挤成非前台 → 用户下一次点击只用于**激活窗口**，
 *      这一击同样被吞（Windows 的经典"第一次点击白点"现象）。
 *   行业同源证据：headed 浏览器里 CDP `Input.dispatchMouseEvent` 会走**原生输入管线**移动真实指针
 *   （"CDP 永远隔离"这条保证**只在 headless 成立**），Windows/Win32 输入管线是同一个根因。
 *
 * **② 应用内右栏浏览器路径**（`browserBridge.ts`）：点击/输入/拖拽前无条件 `wv.focus()` ——
 *   把应用内焦点从用户手上抢走；且聚焦会触发**滚动 into view**（`focus()` 不带 `preventScroll`
 *   时浏览器必然滚动到该元素），用户正要点的目标在光标下被移走 → 点击落空。作用域在应用内，机制同源。
 *
 * ## 结论：不做"完全隔离"，做「让位 + 串行 + 可见」（这是本模块存在的理由）
 * Windows 没有任何合法通道让一个第三方进程"不抢焦点地把输入送进别人的窗口"
 * （`PostMessage` 发 `WM_*` 对 Chromium/UWP/受保护进程基本无效，且丢失真实输入语义）。
 * 因此正确的工程答案是：**人优先** —— 检测到用户正在操作就让 Agent 停手等待，
 * 等不到就让路并**如实汇报**（绝不"硬点上去"跟用户抢指针）。
 *
 * 判据只在这里实现一处（`decideUserYield`），调用方（`ScreenController`）只负责
 * 「问空闲时间 → 问本函数 → 执行 wait / 执行 / 中止」。
 */

/** 「用户正在操作」的判定窗口：系统空闲时间小于它 ⇒ 认为用户手正在键鼠上。 */
export const USER_ACTIVE_WINDOW_MS = 700;

/** Agent 让位最多等多久（超过就中止本次动作，把选择权交还用户）。 */
export const USER_YIELD_MAX_WAIT_MS = 6000;

/** 两次空闲探测之间的间隔（也是每次 wait 的粒度）。 */
export const USER_YIELD_PROBE_MS = 250;

export interface YieldInput {
  /**
   * 系统级「距上次用户输入」的毫秒数（Win32 `GetLastInputInfo`）。
   * `null` = **探测不可用**（非 Windows / 宿主未就绪 / 调用失败）——
   * 注意这**不等于**"用户没在操作"：探测失败时按「不阻塞」处理，但必须留痕（见 note）。
   */
  idleMs: number | null;
  /** 为了等用户停手，本次动作已经等了多少毫秒 */
  waitedMs: number;
  activeWindowMs: number;
  maxWaitMs: number;
  /** 探测间隔（仅用于决定下次 wait 的粒度） */
  probeMs?: number;
}

export type YieldDecision =
  | { action: "proceed"; waitedMs: number; note: string }
  | { action: "wait"; waitMs: number }
  | { action: "abort"; waitedMs: number; reason: string };

/**
 * 让位裁决。**三条语义缺一不可**：
 *   ① 用户在操作 → 等（分段重探，不傻等一整段）；
 *   ② 等超时就**中止**并说清原因 —— 绝不在用户手底下抢指针；
 *   ③ 探测不可用 → 放行，但带上留痕文案（失败 ≠ 用户忙，也**不许**静默当成"空闲"）。
 */
export function decideUserYield(input: YieldInput): YieldDecision {
  const { idleMs, waitedMs, activeWindowMs, maxWaitMs } = input;
  const probeMs = Math.max(50, input.probeMs ?? USER_YIELD_PROBE_MS);

  // ③ 探测不可用：放行 + 留痕（绝不静默）
  if (idleMs === null || !Number.isFinite(idleMs)) {
    return {
      action: "proceed",
      waitedMs,
      note: "（未能读取系统空闲时间，本次未做「用户让位」检查）",
    };
  }

  const idle = Math.max(0, Math.round(idleMs));
  // 用户已停手够久 → 直接执行
  if (idle >= activeWindowMs) {
    return { action: "proceed", waitedMs, note: "" };
  }

  // ① 用户正在操作 → 让位。等「还差多久用户才停手」，但**分段**等待（粒度 probeMs）：
  //    用户可能刚停手又立刻继续敲，分段重探能更早发现，代价只是宿主内一次毫秒级往返。
  const need = activeWindowMs - idle;
  if (waitedMs + need <= maxWaitMs) {
    return { action: "wait", waitMs: Math.max(1, Math.min(need, probeMs)) };
  }

  // ② 等超时 → 中止（把选择权交还用户；模型可稍后重试）
  return {
    action: "abort",
    waitedMs,
    reason:
      `用户正在操作这台电脑（系统空闲仅 ${idle}ms < ${activeWindowMs}ms），`
      + `Agent 已让位等待 ${Math.round(waitedMs)}ms 仍未等到空闲 → **本次动作未执行**。`
      + `这不是失败，是刻意不与你抢鼠标：请等用户停手后再重试（或让用户点一下「暂停 Agent 操作」）。`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 「正在操作的是哪一块区域」—— 呼吸灯边框的**唯一几何判据**
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface Region { x: number; y: number; width: number; height: number }

/** 没有窗口目标时，围绕动作点画多大的框（呼吸灯边框的最小可读尺寸） */
export const OPERATION_BOX_W = 300;
export const OPERATION_BOX_H = 220;

/**
 * 决定「这次操作的可视化区域」。三档，按可信度降序：
 *   ① `targetRegion`（按窗口操作/截图时已知的窗口矩形）—— 最准确，窗口本身就是被操作的对象；
 *   ② 动作点为中心的固定框 —— 裸坐标点击/移动的常态（点在哪，框就在哪）；
 *   ③ `fallback`（最近一次截图覆盖的区域）—— 键盘类动作没有坐标，用"当前视野"兜底；
 *   ④ 三者都无 → `null`（**不猜**，界面就不画框，而不是画一个假位置）。
 */
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
