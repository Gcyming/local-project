/**
 * gui/src/renderer/pages/SettingsDialog.tsx — 设置弹窗（左侧栏目 + 顶部搜索 + 右侧内容）。
 * 点击齿轮弹出（不再切换主区）；栏目：心智中枢 / Agent 管理 / 供应商 / 状态。
 */
import React, { type JSX } from "react";
import AgentsPanel from "./AgentsPanel.js";
import ProvidersPanel from "./ProvidersPanel.js";
import StatusPanel from "./StatusPanel.js";
import MindHubPanel from "./MindHubPanel.js";
import SkillsPanel from "./SkillsPanel.js";
import McpPanel from "./McpPanel.js";
import PermissionsPanel from "./PermissionsPanel.js";
import GeneralPanel from "./GeneralPanel.js";
import ResidentPanel from "./ResidentPanel.js";
import type { DownloadProgressInfo } from "../../shared/ipc.js";
import { SearchIcon, SettingsIcon, CloseIcon } from "../components/Icon.js";
import type { ThemeName } from "../theme.js";

export type SettingsTab = "mind" | "agents" | "providers" | "status" | "skills" | "mcp" | "permissions" | "general" | "resident";

const SECTIONS: Array<{ id: SettingsTab; label: string; keywords: string[] }> = [
  { id: "general", label: "通用", keywords: ["自启", "开机", "卸载", "启动", "general", "uninstall"] },
  { id: "mind", label: "心智中枢", keywords: ["记忆", "学习", "进化", "情绪", "向量", "embedding", "bge", "mind"] },
  { id: "agents", label: "Agent 管理", keywords: ["代理", "分裂", "身份", "agents", "agent"] },
  { id: "resident", label: "后台任务", keywords: ["定时", "cron", "子代理", "subagent", "后台", "resident", "常驻", "schedule"] },
  { id: "skills", label: "技能库", keywords: ["技能", "skills", "skill"] },
  { id: "mcp", label: "MCP 接入", keywords: ["mcp", "工具", "服务器", "连接"] },
  { id: "permissions", label: "权限", keywords: ["权限", "授权", "审批", "沙箱", "sandbox", "全局"] },
  { id: "providers", label: "供应商", keywords: ["模型", "密钥", "api", "provider", "本地模型", "llama"] },
  { id: "status", label: "状态", keywords: ["统计", "监控", "显存", "服务器", "告警", "stats", "status"] },
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
  theme?: ThemeName;
  onThemeChange?: (t: ThemeName) => void;
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
        // A-911：设置弹窗可读性修复——磨砂玻璃（近实色底 + 背景模糊），避免半透明内容透出看不清
        background: "rgba(10, 16, 32, 0.9)",
        backdropFilter: "blur(20px) saturate(160%)",
        WebkitBackdropFilter: "blur(20px) saturate(160%)",
      }} className="card">
        <div style={{ display: "flex", alignItems: "center", padding: "4px 16px", borderBottom: "1px solid var(--border)", minHeight: 44 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 7 }}>
            <SettingsIcon size={18} /> 设置
          </span>
          <span style={{ flex: 1 }} />
          <button className="titlebar-btn" title="关闭设置" onClick={props.onClose}><CloseIcon size={14} /></button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <aside style={{
            width: 224, minWidth: 224, borderRight: "1px solid var(--border)",
            display: "flex", flexDirection: "column", padding: "10px 8px",
          }}>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <SearchIcon size={16} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", opacity: 0.55, pointerEvents: "none" }} />
              <input
                className="input-field" autoFocus
                style={{ width: "100%", fontSize: 12.5, paddingLeft: 28 }}
                placeholder="搜索设置（如：记忆 / 模型 / 状态）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
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

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 2 }}>
            {activeTab === "general" && <GeneralPanel theme={props.theme} onThemeChange={props.onThemeChange} />}
            {activeTab === "resident" && <ResidentPanel />}
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
            {activeTab === "skills" && <SkillsPanel />}
            {activeTab === "mcp" && <McpPanel />}
            {activeTab === "permissions" && <PermissionsPanel />}
            {activeTab === "providers" && <ProvidersPanel />}
            {activeTab === "status" && <StatusPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
