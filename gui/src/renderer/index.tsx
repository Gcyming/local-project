/**
 * gui/src/renderer/index.tsx — React 渲染入口（纯本地内容）。
 * CSP 下仅加载自身 bundle，无外部脚本/样式。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
