/**
 * gui/src/renderer/index.tsx — React 渲染入口（纯本地内容）。
 * CSP 下仅加载自身 bundle，无外部脚本/样式。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import ErrorBoundary from "./ErrorBoundary.js";
import "./index.css";
import { getTheme, applyTheme } from "./theme.js";
import { isFileDrag } from "./pages/dropGuard.js";

// React 挂载前先应用持久化主题，避免首帧闪回默认 Alpha 配色
applyTheme(getTheme());

/* ══ A-1133：**拖放闸门**（唯一产地，装在入口而不是各个 drop 目标上） ══════════════════════
   事故（2026-09-28）：把 `.docx/.pdf/.xlsx` 拖进窗口 ⇒ 控制台无休止刷
   `GUEST_VIEW_MANAGER_CALL: Error: ERR_FAILED (-2) loading 'file:///…docx'`、
   界面疯狂闪烁、目标文件夹被反复写出的半成品文件塞满（用户定性为"重大事故"）。

   根因的第一层就在这里：**Chromium 的默认行为是"文件被拖到页面上 = 导航到该文件的 `file://` URL"**
   （浏览器原生行为；全仓 `grep` 不到任何 `file:///` 字符串，所以别去代码里找"谁打开了它"）。
   旧代码只在聊天输入区的 `onDrop` 里对**图片**调了 `preventDefault()` ⇒ 非图片直接落到默认导航。

   ⇒ 判据：**有文件被拖进来，一律取消默认动作**。放在 `window` 级（而非某个组件的 onDrop）是因为
     "哪些组件实现了 onDrop"是一份会漂的清单 —— 漏一处就多一个入口（铁律 11 的同物异形）。
     真正的处理仍由各目标的 onDrop 自己负责：事件先到目标、再冒泡到这里，所以"目标先处理、
     入口再统一取消默认动作"两者不冲突（文档级 preventDefault **不会**取消已发生的目标处理）。 */
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e: DragEvent): void => {
    const dt = e.dataTransfer;
    if (!dt) { return; }
    try {
      if (isFileDrag(Array.from(dt.types ?? []))) { e.preventDefault(); }
    } catch { /* types 取不到时宁可不拦，也不要因为这里抛错把整个 drop 链路弄断 */ }
  }, false);
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
