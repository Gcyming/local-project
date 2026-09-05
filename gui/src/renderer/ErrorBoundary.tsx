/**
 * gui/src/renderer/ErrorBoundary.tsx — 全局渲染错误边界（A-175）。
 * 任何子组件渲染抛错时兜底显示错误信息，避免 React 树崩溃后整窗黑屏，
 * 同时把错误打印到控制台便于定位。
 */
import React, { type JSX, type ReactNode } from "react";

interface EBState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<{ children: ReactNode }, EBState> {
  override state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[renderer] ErrorBoundary caught:", error, info?.componentStack ?? "");
  }

  override render(): JSX.Element {
    if (this.state.error) {
      return (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999999,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 12, padding: 32, textAlign: "center",
          background: "#0b1020", color: "#f87171", fontFamily: "Segoe UI, system-ui, sans-serif",
        }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>界面渲染出错</div>
          <div style={{ fontSize: 13, color: "#e5e7eb", maxWidth: 640, wordBreak: "break-all" }}>
            {this.state.error.message}
          </div>
          <pre style={{ margin: 0, padding: 12, maxHeight: 180, overflow: "auto", fontSize: 11, color: "#94a3b8", background: "rgba(255,255,255,0.05)", borderRadius: 8, textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error.stack ?? ""}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); }}
            style={{ padding: "8px 20px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            尝试恢复
          </button>
        </div>
      );
    }
    return this.props.children as JSX.Element;
  }
}