/**
 * gui/src/renderer/App.tsx — MVP 三面板 + 简易路由（HashRouter 以沙箱友好）。
 * 面板：/ (Chat) /status (Status) /agents (Agent management)
 */
import React, { type JSX } from "react";
import ChatPanel from "./pages/ChatPanel.js";
import StatusPanel from "./pages/StatusPanel.js";
import AgentsPanel from "./pages/AgentsPanel.js";

export type Tab = "chat" | "status" | "agents";

export default function App(): JSX.Element {
  const [tab, setTab] = React.useState<Tab>("chat");
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "chat", label: "对话" },
    { id: "status", label: "状态" },
    { id: "agents", label: "Agent 管理" },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <nav style={{ display: "flex", gap: 4, padding: 8, background: "#1e293b", borderBottom: "1px solid #334155" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "8px 16px",
              borderRadius: 4,
              border: "none",
              cursor: "pointer",
              background: tab === t.id ? "#3b82f6" : "#334155",
              color: "#fff",
              fontSize: 14,
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, overflow: "hidden" }}>
        {tab === "chat" && <ChatPanel />}
        {tab === "status" && <StatusPanel />}
        {tab === "agents" && <AgentsPanel />}
      </main>
    </div>
  );
}
