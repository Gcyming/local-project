/**
 * gui/src/renderer/pages/SettingsDialog.tsx — 设置弹窗（左侧栏目 + 顶部搜索 + 右侧内容）。
 * 点击齿轮弹出（不再切换主区）；栏目：心智中枢 / Agent 管理 / 供应商 / 状态。
 */
import React, { type JSX } from "react";
import AgentsPanel from "./AgentsPanel.js";
import ProvidersPanel from "./ProvidersPanel.js";
import StatusPanel from "./StatusPanel.js";
import MindHubPanel from "./MindHubPanel.js";
import type { DownloadProgressInfo } from "../../shared/ipc.js";

export type SettingsTab = "mind" | "agents" | "providers" | "status";

const SECTIONS: Array<{ id: SettingsTab; icon: string; label: string; keywords: string[] }> = [
  { id: "mind", icon: "🧠", label: "心智中枢", keywords: ["记忆", "学习", "进化", "情绪", "向量", "embedding", "bge", "技能", "mind"] },
  { id: "agents", icon: "🤖", label: "Agent 管理", keywords: ["代理", "分裂", "身份", "agents", "agent"] },
  { id: "providers", icon: "🔑", label: "供应商", keywords: ["模型", "密钥", "api", "provider", "本地模型", "llama"] },
  { id: "status", icon: "📊", label: "状态", keywords: ["统计", "监控", "显存", "服务器", "告警", "stats", "status"] },
];

interface Props {
  initialTab: SettingsTab;
  onClose: () => void;
  selectedAgentId?: string;
  onSelectAgent: () => void;
  onAgentsChanged: () => void;
  providerKeys: string[];
  localModels: Array<{ id: string; label: string; path: string }>;
  dl?: Record<string, DownloadProgressInfo>;
}

export default function SettingsDialog(props: Props): JSX.Element {
  const [tab, setTab] = React.useState<SettingsTab>(props.initialTab);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    setTab(props.initialTab);
    setQuery("");
  }, [props.initialTab]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? SECTIONS.filter((s) => [s.id, s.label, ...s.keywords].some((k) => k.toLowerCase().includes(q)))
    : SECTIONS;
  const activeTab = filtered.some((s) => s.id === tab) ? tab : (filtered[0]?.id ?? tab);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 90, background: "rgba(2, 6, 23, 0.66)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
      onClick={(e) => { if (e.target === e.currentTarget) { props.onClose(); } }}>
      <div style={{
        width: 980, maxWidth: "94vw", height: "78vh", maxHeight: "86vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }} className="card">
        <div style={{ display: "flex", alignItems: "center", padding: "4px 16px", borderBottom: "1px solid var(--border)", minHeight: 44 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>⚙ 设置</span>
          <span style={{ flex: 1 }} />
          <button className="titlebar-btn" title="关闭设置" onClick={props.onClose} style={{ fontSize: 16 }}>✕</button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <aside style={{
            width: 224, minWidth: 224, borderRight: "1px solid var(--border)",
            display: "flex", flexDirection: "column", padding: "10px 8px",
          }}>
            <input
              className="input-field" autoFocus
              style={{ width: "100%", marginBottom: 10, fontSize: 12.5 }}
              placeholder="🔍 搜索设置（如：记忆 / 模型 / 状态）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filtered.map((s) => (
                <button key={s.id}
                  onClick={() => setTab(s.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    textAlign: "left", padding: "9px 12px", marginBottom: 3,
                    borderRadius: 8, cursor: "pointer", fontSize: 13,
                    background: activeTab === s.id ? "var(--accent-soft)" : "transparent",
                    border: "none", color: activeTab === s.id ? "var(--accent-hover)" : "var(--text)",
                    fontWeight: activeTab === s.id ? 700 : 600,
                  }}>
                  <span style={{ fontSize: 15 }}>{s.icon}</span>
                  {s.label}
                </button>
              ))}
              {filtered.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 12, textAlign: "center" }}>
                  无匹配设置项
                </div>
              )}
            </div>
          </aside>

          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            {activeTab === "mind" && <MindHubPanel selectedAgentId={props.selectedAgentId} dl={props.dl} />}
            {activeTab === "agents" && (
              <AgentsPanel
                selectedAgentId={props.selectedAgentId}
                onSelectAgent={props.onSelectAgent}
                onAgentsChanged={props.onAgentsChanged}
                providerKeys={props.providerKeys}
                localModels={props.localModels}
              />
            )}
            {activeTab === "providers" && <ProvidersPanel />}
            {activeTab === "status" && <StatusPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
