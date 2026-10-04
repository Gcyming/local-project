



import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import ErrorBoundary from "./ErrorBoundary.js";
import "./index.css";
import { getTheme, applyTheme } from "./theme.js";
import { isFileDrag } from "./pages/dropGuard.js";


applyTheme(getTheme());














for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e: DragEvent): void => {
    const dt = e.dataTransfer;
    if (!dt) { return; }
    try {
      if (isFileDrag(Array.from(dt.types ?? []))) { e.preventDefault(); }
    } catch {  }
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
