/**
 * gui/src/renderer/pages/AgentsPanel.tsx — Agent 管理面板骨架。
 * - 列表展示（名称/角色/生命周期/父子关系）
 * - 创建 Agent 入口
 * - 分裂（fork）入口（inherit provider，复用 core-ts Swarm split 语义）
 */
import React, { type JSX } from "react";
import type { AgentInfo } from "../../shared/ipc.js";

export default function AgentsPanel(): JSX.Element {
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newRole, setNewRole] = React.useState("");
  const [forkParent, setForkParent] = React.useState("");
  const [forkName, setForkName] = React.useState("");
  const [forkRole, setForkRole] = React.useState("");

  const api = React.useRef<any>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!api.current) {
      return;
    }
    const list = (await api.current.agents.list()) as AgentInfo[];
    setAgents(list);
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current) {
      void refresh();
    }
  }, [refresh]);

  async function createAgent(): Promise<void> {
    if (!api.current || !newName.trim()) {
      return;
    }
    setLoading(true);
    try {
      await api.current.agents.create(newName, newRole || "assistant");
      await refresh();
      setShowCreate(false);
      setNewName("");
      setNewRole("");
    } finally {
      setLoading(false);
    }
  }

  async function forkAgent(): Promise<void> {
    if (!api.current || !forkParent) {
      return;
    }
    setLoading(true);
    try {
      await api.current.agents.fork(forkParent, forkName || "child", forkRole || "worker");
      await refresh();
      setForkParent("");
      setForkName("");
      setForkRole("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Agent 管理</h2>
      <button
        onClick={() => setShowCreate(!showCreate)}
        style={{ marginBottom: 12, padding: "6px 14px", borderRadius: 4, border: "none", background: "#10b981", color: "#fff", cursor: "pointer" }}
      >
        创建 Agent
      </button>

      {showCreate && (
        <div style={{ marginBottom: 16, padding: 12, border: "1px solid #334155", borderRadius: 6, background: "#1e293b" }}>
          <input
            placeholder="名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: "40%", marginRight: 8, padding: 6, borderRadius: 4, border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0" }}
          />
          <input
            placeholder="角色（默认 assistant）"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            style={{ width: "40%", marginRight: 8, padding: 6, borderRadius: 4, border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0" }}
          />
          <button onClick={createAgent} disabled={loading || !newName.trim()} style={{ padding: "6px 14px", borderRadius: 4, border: "none", background: "#3b82f6", color: "#fff", cursor: "pointer" }}>
            确认
          </button>
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#94a388" }}>
            <th style={{ padding: 6 }}>名称</th>
            <th style={{ padding: 6 }}>角色</th>
            <th style={{ padding: 6 }}>生命周期</th>
            <th style={{ padding: 6 }}>孩子</th>
            <th style={{ padding: 6 }}>分裂</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid #334155" }}>
              <td style={{ padding: 6 }}>{a.name}</td>
              <td style={{ padding: 6 }}>{a.role}</td>
              <td style={{ padding: 6 }}>{a.lifecycle}</td>
              <td style={{ padding: 6 }}>{a.children.length}</td>
              <td style={{ padding: 6 }}>
                <input
                  placeholder="子名称"
                  value={forkName}
                  onChange={(e) => setForkName(e.target.value)}
                  style={{ width: 110, padding: 4, marginRight: 4, borderRadius: 3, border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: 12 }}
                />
                <button
                  onClick={async () => {
                    setForkParent(a.id);
                    await forkAgent();
                  }}
                  style={{ padding: "2px 8px", borderRadius: 3, border: "none", background: "#f59e0b", color: "#fff", cursor: "pointer", fontSize: 12 }}
                >
                  分裂
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {agents.length === 0 && <p style={{ color: "#64748a", marginTop: 16 }}>暂无 Agent，点击“创建 Agent”添加。</p>}
    </div>
  );
}
