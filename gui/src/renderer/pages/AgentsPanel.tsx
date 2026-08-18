/**
 * gui/src/renderer/pages/AgentsPanel.tsx — Agent 管理面板（P0 补齐版）。
 * - 列表展示（名称/角色/生命周期/父子关系）
 * - P0: 点击行选中 Agent（高亮），通知主进程切换
 * - 创建 Agent 入口
 * - 分裂（fork）入口
 */
import React, { type JSX } from "react";
import type { AgentInfo } from "../../shared/ipc.js";

interface AgentsPanelProps {
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
}

export default function AgentsPanel({
  selectedAgentId,
  onSelectAgent,
}: AgentsPanelProps): JSX.Element {
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newRole, setNewRole] = React.useState("");
  const [forkParent, setForkParent] = React.useState("");
  const [forkName, setForkName] = React.useState("");
  const [forkRole, setForkRole] = React.useState("");
  /** 身份移民协议 v1.2：导出/导入操作反馈（null=无消息） */
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  const api = React.useRef<any>(null);

  /** 显示操作反馈，5 秒后自动清除 */
  function showNotice(ok: boolean, text: string): void {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 5000);
  }

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!api.current) { return; }
    const list = (await api.current.agents.list()) as AgentInfo[];
    setAgents(list);
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current) { void refresh(); }
  }, [refresh]);

  async function createAgent(): Promise<void> {
    if (!api.current || !newName.trim()) { return; }
    setLoading(true);
    try {
      const a = await api.current.agents.create(newName, newRole || "assistant");
      await refresh();
      setShowCreate(false);
      setNewName("");
      setNewRole("");
      onSelectAgent?.(a.id);
    } finally {
      setLoading(false);
    }
  }

  async function forkAgent(): Promise<void> {
    if (!api.current || !forkParent) { return; }
    setLoading(true);
    try {
      const a = await api.current.agents.fork(forkParent, forkName || "child", forkRole || "worker");
      await refresh();
      setForkParent("");
      setForkName("");
      setForkRole("");
      onSelectAgent?.(a.id);
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(agentId: string): void {
    api.current?.agents.select(agentId).catch(console.error);
    onSelectAgent?.(agentId);
  }

  /** 身份移民协议 v1.2 §4：导出当前 Agent 为 .slimeagent 身份包 */
  async function exportAgent(agent: AgentInfo): Promise<void> {
    if (!api.current) { return; }
    setLoading(true);
    try {
      const res = await api.current.agents.exportAgent(agent.id);
      if (res.ok) {
        showNotice(true, `已导出「${agent.name}」→ ${res.path}`);
      } else if (res.error !== "已取消导出") {
        showNotice(false, `导出失败：${res.error}`);
      }
    } finally {
      setLoading(false);
    }
  }

  /** 身份移民协议 v1.2 §5：导入身份包（冲突时二次确认后走 overwrite） */
  async function importPack(): Promise<void> {
    if (!api.current) { return; }
    setLoading(true);
    try {
      let res = await api.current.agents.importPack("abort");
      if (!res.ok && typeof res.error === "string" && res.error.includes("已存在")) {
        const overwrite = window.confirm(`${res.error}\n\n是否覆盖导入？（旧身份将被替换）`);
        if (overwrite) {
          res = await api.current.agents.importPack("overwrite");
        }
      }
      if (res.ok) {
        showNotice(true, `已导入「${res.agentName ?? res.agentId}」${res.warnings?.length ? `（警告：${res.warnings.join("；")}）` : ""}`);
        await refresh();
        if (res.agentId) { onSelectAgent?.(res.agentId); }
      } else if (res.error !== "已取消导入") {
        showNotice(false, `导入失败：${res.error}`);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* 左侧 Agent 列表 */}
      <div style={{
        width: 220, borderRight: "1px solid #334155",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #334155", display: "flex", gap: 6 }}>
          <button onClick={() => setShowCreate(!showCreate)}
            style={{ flex: 1, padding: "6px 14px", borderRadius: 4, border: "none",
              background: "#10b981", color: "#fff", cursor: "pointer", fontSize: 13 }}>
            创建 Agent
          </button>
          <button onClick={importPack} disabled={loading}
            style={{ flex: 1, padding: "6px 14px", borderRadius: 4, border: "none",
              background: "#0ea5e9", color: "#fff", cursor: "pointer", fontSize: 13 }}>
            导入 Agent
          </button>
        </div>

        {notice && (
          <div style={{
            padding: "8px 12px", fontSize: 12, lineHeight: 1.5, wordBreak: "break-all",
            borderBottom: "1px solid #334155",
            background: notice.ok ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
            color: notice.ok ? "#34d399" : "#f87171",
          }}>
            {notice.text}
          </div>
        )}

        {showCreate && (
          <div style={{ padding: 8, borderBottom: "1px solid #334155", display: "flex", flexDirection: "column", gap: 4 }}>
            <input placeholder="名称" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={inputStyle()} />
            <input placeholder="角色（默认 assistant）" value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              style={inputStyle()} />
            <button onClick={createAgent} disabled={loading || !newName.trim()}
              style={btnStyle("#3b82f6")}>确认</button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto" }}>
          {agents.map((a) => {
            const isSelected = a.id === selectedAgentId;
            return (
              <div key={a.id}
                onClick={() => handleSelect(a.id)}
                style={{
                  padding: "8px 12px", cursor: "pointer",
                  background: isSelected ? "#1e3a5f" : "transparent",
                  borderBottom: "1px solid #1e293b",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "#1e293b"; }}
                onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <div style={{ fontSize: 14, fontWeight: isSelected ? 600 : 400, color: "#e2e8f0" }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 11, color: "#64748a" }}>
                  {a.role} · {a.lifecycle}
                </div>
              </div>
            );
          })}
          {agents.length === 0 && (
            <div style={{ padding: 16, color: "#475569", fontSize: 13, textAlign: "center" }}>
              暂无 Agent
            </div>
          )}
        </div>
      </div>

      {/* 右侧：分裂操作区 */}
      <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Agent 管理</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#94a388" }}>
              <th style={{ padding: 6 }}>名称</th>
              <th style={{ padding: 6 }}>角色</th>
              <th style={{ padding: 6 }}>生命周期</th>
              <th style={{ padding: 6 }}>孩子</th>
              <th style={{ padding: 6 }}>分裂</th>
              <th style={{ padding: 6 }}>移民</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} style={{ borderBottom: "1px solid #334155",
                background: a.id === selectedAgentId ? "#1e293b" : "transparent" }}>
                <td style={{ padding: 6, color: a.id === selectedAgentId ? "#93c5fd" : "#e2e8f0" }}>
                  {a.name}
                </td>
                <td style={{ padding: 6 }}>{a.role}</td>
                <td style={{ padding: 6 }}>{a.lifecycle}</td>
                <td style={{ padding: 6 }}>{a.children.length}</td>
                <td style={{ padding: 6 }}>
                  <input placeholder="子名称" value={forkName}
                    onChange={(e) => setForkName(e.target.value)}
                    style={{ width: 110, padding: 4, marginRight: 4, borderRadius: 3,
                      border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: 12 }}
                  />
                  <button onClick={async () => { setForkParent(a.id); await forkAgent(); }}
                    style={{ padding: "2px 8px", borderRadius: 3, border: "none",
                      background: "#f59e0b", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                    分裂
                  </button>
                </td>
                <td style={{ padding: 6 }}>
                  <button onClick={() => exportAgent(a)} disabled={loading}
                    style={{ padding: "2px 8px", borderRadius: 3, border: "none",
                      background: "#0ea5e9", color: "#fff", cursor: "pointer", fontSize: 12 }}>
                    导出
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {agents.length === 0 && (
          <p style={{ color: "#64748a", marginTop: 16 }}>暂无 Agent，点击"创建 Agent"添加。</p>
        )}
      </div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%", padding: 6, borderRadius: 4,
    border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", boxSizing: "border-box",
  };
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "6px 14px", borderRadius: 4, border: "none",
    background: bg, color: "#fff", cursor: "pointer", fontSize: 13,
  };
}
