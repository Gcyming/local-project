


















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


const WATCHDOG_TICK_MS = 5_000;

export default function OperationFocusOverlay(): JSX.Element {
  const [st, setSt] = React.useState<OperationFocusState>(OP_FOCUS_IDLE);
  const [hintHidden, setHintHidden] = React.useState<boolean>(() => readOpFocusHintHidden());

  
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
    } catch {  }
    return () => {
      window.removeEventListener(OP_FOCUS_EVENT, onLocal);
      try { off?.(); } catch {  }
    };
  }, []);

  
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

  
  const inner = st.target === "browser" && st.rect;
  const frameStyle: React.CSSProperties = inner
    ? { left: st.rect!.x, top: st.rect!.y, width: st.rect!.width, height: st.rect!.height }
    : {};
  const frameCls = `op-focus-frame${inner ? "" : " is-sys"}${st.active ? " is-on" : ""}`;

  return (
    <>
      {}
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
