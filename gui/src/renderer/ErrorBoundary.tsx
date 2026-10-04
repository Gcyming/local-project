





import React, { type JSX, type ReactNode } from "react";

interface EBState {
  error: Error | null;
  crashCount: number;
}

const EB_KEY = "slime_eb_crash";
const EB_MAX = 3;
const EB_WINDOW_MS = 5000;




export const selfHealState = { paused: false };

export default class ErrorBoundary extends React.Component<{ children: ReactNode }, EBState> {
  override state: EBState = { error: null, crashCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<EBState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[renderer] ErrorBoundary caught:", error, info?.componentStack ?? "");
    try {
      const prev = Number(localStorage.getItem(EB_KEY) ?? "0");
      const count = Number.isFinite(prev) && prev > 0 ? prev + 1 : 1;
      
      const last = Number(localStorage.getItem(`${EB_KEY}_t`) ?? "0");
      const reset = Date.now() - last > EB_WINDOW_MS ? 1 : count;
      localStorage.setItem(EB_KEY, String(reset));
      localStorage.setItem(`${EB_KEY}_t`, String(Date.now()));
      if (reset >= EB_MAX && !selfHealState.paused) {
        localStorage.setItem(EB_KEY, "0");
        location.reload(); 
        return;
      }
      this.setState({ crashCount: reset });
    } catch {  }
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
          <div style={{ fontSize: 18, fontWeight: 700 }}>界面渲染出错{this.state.crashCount > 0 ? `（第 ${this.state.crashCount}/${EB_MAX} 次）` : ""}</div>
          <div style={{ fontSize: 13, color: "#e5e7eb", maxWidth: 640, wordBreak: "break-all" }}>
            {this.state.error.message}
          </div>
          <pre style={{ margin: 0, padding: 12, maxHeight: 180, overflow: "auto", fontSize: 11, color: "#94a3b8", background: "rgba(255,255,255,0.05)", borderRadius: 8, textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error.stack ?? ""}
          </pre>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => { this.setState({ error: null }); }}
              style={{ padding: "8px 20px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              尝试恢复
            </button>
            <button
              onClick={() => { try { localStorage.setItem(EB_KEY, "0"); } catch {  } location.reload(); }}
              style={{ padding: "8px 20px", background: "#334155", color: "#e2e8f0", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              重启界面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children as JSX.Element;
  }
}