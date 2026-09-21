/**
 * gui/src/renderer/components/OperationFocusOverlay.tsx — A-1044：**操作可视化浮层**。
 *
 * 用户要求（原话）：「加一点操作效果，如在被操作的界面边界加上呼吸灯效果，并可主动选择隐藏的悬浮提示。」
 *
 * 它订阅两条来源，**同一套显示实现**（判据全在 `pages/operationFocus.ts`，本文件只做样式映射）：
 *   · 应用内 `slime-operation-focus` 事件 —— 右栏内嵌浏览器的点击/输入/拖拽/滚动（`browserBridge` 派发，
 *     带 webview 的应用内矩形 → 呼吸灯精确贴在被操作的那一块上）；
 *   · 主进程 `slime:screen:opFocus` —— `screen_*` 操作整机屏幕 / 安卓设备（宿主坐标**无法**映射进
 *     应用窗口，所以画在应用内容区边缘，并在提示里写明"正在操作你的主机屏幕"，不假装框在窗口上）。
 *
 * 三条硬约束（都有前科，勿破）：
 *   ① **绝不吞点击**：除"隐藏"按钮外全部 `pointer-events:none`。项目里任何吃点击的覆盖层都曾导致
 *      "Agent 点不动页面 / 用户点不动界面"（A-976、A-1018）；本浮层常驻在应用最上层，风险更高。
 *   ② **常驻挂载 + 切类名**：进出场靠类名（`is-on`）驱动 CSS 动画，不用 `{active && <div>}` ——
 *      条件渲染 = 结构上不可能有动画（A-1015 的既有结论，静态守卫 ⑬ 也盯这条）。
 *   ③ 呼吸灯必须能被关掉：`prefers-reduced-motion` 下退化为静态描边（无障碍），
 *      提示文案可被用户永久隐藏（`localStorage`，见 `OP_FOCUS_HINT_KEY`）。
 */
import React, { type JSX } from "react";
import { CloseIcon } from "./Icon.js";
import {
  OP_FOCUS_EVENT,
  OP_FOCUS_IDLE,
  describeOpFocusTarget,
  fromOperationFocusUI,
  isOpFocusStale,
  readOpFocusHintHidden,
  reduceOperationFocus,
  writeOpFocusHintHidden,
  type OperationFocusPayload,
  type OperationFocusState,
} from "../pages/operationFocus.js";
import type { OperationFocusUI } from "../../shared/ipc.js";

/** 看门狗轮询间隔（粗粒度即可；只是"进程没了别让框永远转"的兜底）。 */
const WATCHDOG_TICK_MS = 5_000;

export default function OperationFocusOverlay(): JSX.Element {
  const [st, setSt] = React.useState<OperationFocusState>(OP_FOCUS_IDLE);
  const [hintHidden, setHintHidden] = React.useState<boolean>(() => readOpFocusHintHidden());

  // 订阅：应用内（右栏浏览器） + 主进程（screen_* 整机/设备）
  React.useEffect(() => {
    const apply = (p: OperationFocusPayload): void => {
      setSt((prev) => reduceOperationFocus(prev, p, Date.now()));
    };
    const onLocal = (e: Event): void => {
      const d = (e as CustomEvent<OperationFocusPayload>).detail;
      if (d && typeof d.phase === "string") { apply(d); }
    };
    window.addEventListener(OP_FOCUS_EVENT, onLocal);
    let off: (() => void) | undefined;
    try {
      const api = (window as unknown as {
        slimeAPI?: { screen?: { onOperationFocus?: (cb: (e: OperationFocusUI) => void) => () => void } };
      }).slimeAPI?.screen;
      off = api?.onOperationFocus?.((e) => apply(fromOperationFocusUI(e)));
    } catch { /* 未注入 preload（单测）→ 只保留应用内来源 */ }
    return () => {
      window.removeEventListener(OP_FOCUS_EVENT, onLocal);
      try { off?.(); } catch { /* 忽略 */ }
    };
  }, []);

  // 看门狗：`end` 丢失（主进程被强杀 / 渲染层重载）时不让边框永远转下去
  React.useEffect(() => {
    if (!st.active) { return; }
    const t = window.setInterval(() => {
      setSt((prev) => (isOpFocusStale(prev, Date.now()) ? { ...prev, active: false } : prev));
    }, WATCHDOG_TICK_MS);
    return () => window.clearInterval(t);
  }, [st.active]);

  const hideHint = (): void => {
    setHintHidden(true);
    writeOpFocusHintHidden(true);
  };

  // 应用内目标（右栏浏览器）：边框精确贴在 webview 矩形上；宿主/设备目标：边框画在内容区边缘。
  const inner = st.target === "browser" && st.rect;
  const frameStyle: React.CSSProperties = inner
    ? { left: st.rect!.x, top: st.rect!.y, width: st.rect!.width, height: st.rect!.height }
    : {};
  const frameCls = `op-focus-frame${inner ? "" : " is-sys"}${st.active ? " is-on" : ""}`;

  return (
    <>
      {/* 常驻挂载 + 类名切换（约束②） */}
      <div className={frameCls} style={frameStyle} aria-hidden="true">
        <span className="op-focus-tag">{st.label}</span>
      </div>
      <div className={`op-focus-hint${st.active && !hintHidden ? " is-on" : ""}`} role="status" aria-live="polite">
        <span className="op-focus-dot" aria-hidden="true" />
        <span className="op-focus-text">
          slime 正在操作<b>{describeOpFocusTarget(st.target)}</b>
          {st.label ? `：${st.label}` : ""}
          {st.waitingUser ? "（正在等你停手，人优先）" : ""}
        </span>
        <button className="op-focus-hide" title="不再自动显示这类提示" onClick={hideHint}><CloseIcon size={10} /></button>
      </div>
    </>
  );
}
