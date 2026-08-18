/**
 * gui/src/renderer/App.tsx — MVP 三面板 + P0 补齐（selectedAgentId 状态提升）。
 * 面板：/ (Chat) /status (Status) /agents (Agent management)
 * P0: 选中 Agent 状态在 App 层管理，ChatPanel 和 AgentsPanel 通过 props 通信
 */
import React, { type JSX } from "react";
import ChatPanel from "./pages/ChatPanel.js";
import StatusPanel from "./pages/StatusPanel.js";
import AgentsPanel from "./pages/AgentsPanel.js";

export type Tab = "chat" | "status" | "agents";

interface AgentBrief {
  id: string;
  name: string;
  role: string;
}

export default function App(): JSX.Element {
  const [tab, setTab] = React.useState<Tab>("chat");
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [agentConfig, setAgentConfig] = React.useState<Record<string, { model_choice?: string; mode?: string; reasoning_effort?: string }>>({});

  // 加载 Agent 列表并默认选中第一个
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    api.agents.list().then((list: AgentBrief[]) => {
      setAgents(list);
      if (list.length > 0 && !selectedAgentId) {
        setSelectedAgentId(list[0].id);
      }
    }).catch(console.error);
    /** P0: 监听主进程推送的选中事件（创建/分裂后自动切换） */
    const off = api.agents.onAgentSelected((agentId: string) => {
      setSelectedAgentId(agentId);
      api.agents.list().then((list: AgentBrief[]) => setAgents(list)).catch(console.error);
    });
    return () => { off(); };
  }, []); // 仅挂载时执行一次

  function handleSelectAgent(agentId: string): void {
    setSelectedAgentId(agentId);
  }

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const currentModel = agentConfig[selectedAgentId ?? ""]?.model_choice ?? "inherit";
  const currentMode = agentConfig[selectedAgentId ?? ""]?.mode ?? "build";
  const currentReasoning = agentConfig[selectedAgentId ?? ""]?.reasoning_effort ?? "none";

  function updateAgentConfig(patch: Record<string, string>): void {
    if (!selectedAgentId) { return; }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (api) {
      void api.agents.update(selectedAgentId, patch).catch(console.error);
    }
    setAgentConfig((prev) => ({ ...prev, [selectedAgentId]: { ...((prev[selectedAgentId] ?? {}) as Record<string, string>), ...patch } }));
  }

  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <nav style={{ display: "flex", gap: 4, padding: 8, background: "#1e293b", borderBottom: "1px solid #334155" }}>
        {([
          { id: "chat" as Tab, label: "对话" },
          { id: "status" as Tab, label: "状态" },
          { id: "agents" as Tab, label: "Agent 管理" },
        ]).map((t) => (
          <button key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "8px 16px", borderRadius: 4, border: "none",
              cursor: "pointer",
              background: tab === t.id ? "#3b82f6" : "#334155",
              color: "#fff", fontSize: 14,
            }}>
            {t.label}
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, overflow: "hidden" }}>
        {tab === "chat" && selectedAgentId && (
          <ChatPanel
            agentId={selectedAgentId}
            agentName={selectedAgent?.name ?? "Agent"}
            modelChoice={currentModel}
            mode={currentMode}
            reasoningEffort={currentReasoning}
            onModelChange={(v) => updateAgentConfig({ model_choice: v })}
            onModeChange={(v) => updateAgentConfig({ mode: v })}
            onReasoningChange={(v) => updateAgentConfig({ reasoning_effort: v })}
          />
        )}
        {tab === "chat" && !selectedAgentId && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#475569" }}>
            请切换到"Agent 管理"创建或选择 Agent
          </div>
        )}
        {tab === "status" && <StatusPanel />}
        {tab === "agents" && (
          <AgentsPanel
            selectedAgentId={selectedAgentId ?? undefined}
            onSelectAgent={handleSelectAgent}
          />
        )}
      </main>
    </div>
  );
}
