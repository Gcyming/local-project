/**
 * gui/src/renderer/App.tsx — slime GUI 主框架（Campanula 布局参考 + 会话化重构）。
 * - 自绘标题栏（frameless + titleBarOverlay 系统窗口按钮）
 * - 侧边栏：「对话」= 项目（Agent 名）下的独立会话列表（不直接罗列所有 Agent）；
 *   会话可随时重命名/删除；项目内可新建多个会话
 * - 主区：对话面板常驻；设置改为弹窗（SettingsDialog：左侧栏目 + 搜索 + 右侧内容）
 */
import React, { type JSX } from "react";
import ChatPanel from "./pages/ChatPanel.js";
import SettingsDialog, { type SettingsTab } from "./pages/SettingsDialog.js";

interface AgentBrief {
  id: string;
  name: string;
  role: string;
}

interface LocalModelBrief {
  id: string;
  label: string;
  path: string;
}

interface SessionItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string;
  count: number;
  lastTime: string;
}

export default function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("mind");
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [agentConfig, setAgentConfig] = React.useState<Record<string, { model_choice?: string; mode?: string; reasoning_effort?: string }>>({});
  const [providerKeys, setProviderKeys] = React.useState<string[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelBrief[]>([]);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  /** 行内重命名状态 */
  const [editingSession, setEditingSession] = React.useState<{ sessionId: string; draft: string } | null>(null);

  const loadAgents = React.useCallback(async (): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const list = await api.agents.list().catch((e: unknown) => {
      console.error("[app] agents list failed:", e);
      return [];
    });
    setAgents(list);
  }, []);

  const loadSessions = React.useCallback(async (): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const items = await api.conversations.list().catch((e: unknown) => {
      console.error("[app] sessions list failed:", e);
      return [];
    });
    setSessions(items);
  }, []);

  // 初始化：Agent 列表 + 会话列表 + 默认选中第一个会话
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    void loadAgents().then(async () => {
      await loadSessions();
      const items = await api.conversations.list().catch(() => []);
      if (items.length > 0) {
        setSelectedSessionId(items[0].sessionId);
      }
    });
    /** 创建/分裂后主进程推送 → 刷新列表并切换 */
    const off = api.agents.onAgentSelected(() => {
      void loadAgents();
      void loadSessions();
    });
    return () => { off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 侧栏会话列表轮询（发送消息后标题/时间/计数更新） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    void loadSessions();
    const timer = window.setInterval(() => { void loadSessions(); }, 4000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  /** AgentsPanel 属性面板把完整详情回传 App 层（驱动 ChatPanel 头部模型显示） */
  React.useEffect(() => {
    const w = window as unknown as { __onAgentDetail?: (id: string, d: unknown) => void };
    w.__onAgentDetail = (id, d) => {
      const det = d as { model_choice?: string; mode?: string; reasoning_effort?: string };
      setAgentConfig((prev) => ({ ...prev, [id]: { ...((prev[id] ?? {}) as Record<string, string>), ...(det ?? {}) } }));
    };
    return () => { delete (w as { __onAgentDetail?: unknown }).__onAgentDetail; };
  }, []);

  /** 加载 Provider 键列表 + 本地模型列表（模型下拉动态化） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const load = (): void => {
      api.providers.list().then((list: Array<{ key: string }>) => {
        setProviderKeys(list.map((p) => p.key));
      }).catch(console.error);
      api.providers.localList().then((list: LocalModelBrief[]) => {
        setLocalModels(list);
      }).catch(console.error);
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId) ?? null;
  const selectedAgentId = selectedSession?.agentId ?? null;

  /** 新建项目：选 Agent → 建独立会话并切换 */
  async function startNewProject(agentId: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.create(agentId).catch((e: unknown) => {
      console.error("[app] create session failed:", e);
      return null;
    });
    if (res?.ok && res.session) {
      setSelectedSessionId(res.session.sessionId);
      setNewProjectOpen(false);
      await loadSessions();
    }
  }

  /** 项目内新建会话 */
  async function startNewSessionInProject(agentId: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.create(agentId).catch((e: unknown) => {
      console.error("[app] create session failed:", e);
      return null;
    });
    if (res?.ok && res.session) {
      setSelectedSessionId(res.session.sessionId);
      await loadSessions();
    }
  }

  async function commitRename(): Promise<void> {
    if (!editingSession) { return; }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const title = editingSession.draft.trim();
    if (api && title) {
      await api.conversations.rename(editingSession.sessionId, title).catch(console.error);
      await loadSessions();
    } else if (!title) {
      await loadSessions();
    }
    setEditingSession(null);
  }

  async function removeSession(sessionId: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    await api.conversations.remove(sessionId).catch(console.error);
    if (selectedSessionId === sessionId) {
      const rest = sessions.filter((s) => s.sessionId !== sessionId);
      setSelectedSessionId(rest.length > 0 ? rest[0].sessionId : null);
    }
    await loadSessions();
  }

  /** 删除项目组：清空该 Agent 全部会话与历史（Agent 本身保留） */
  async function removeProject(agentId: string, agentName: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    if (!window.confirm(`删除项目「${agentName}」？其下全部会话与历史将一并清除（Agent 身份保留）。`)) {
      return;
    }
    await api.conversations.removeAgent(agentId).catch(console.error);
    if (selectedAgentId === agentId) {
      const rest = sessions.filter((s) => s.agentId !== agentId);
      setSelectedSessionId(rest.length > 0 ? rest[0].sessionId : null);
    }
    await loadSessions();
  }

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

  // 项目分组：Agent → 会话列表（排序：更新时间降序）
  const groups = React.useMemo(() => {
    const byAgent = new Map<string, SessionItem[]>();
    for (const s of sessions) {
      const list = byAgent.get(s.agentId) ?? [];
      list.push(s);
      byAgent.set(s.agentId, list);
    }
    const out: Array<{ agentId: string; agentName: string; items: SessionItem[] }> = [];
    for (const [agentId, items] of byAgent) {
      out.push({ agentId, agentName: items[0].agentName, items: [...items].sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1)) });
    }
    out.sort((a, b) => {
      const la = a.items[0]?.lastTime ?? "";
      const lb = b.items[0]?.lastTime ?? "";
      return la < lb ? 1 : -1;
    });
    return out;
  }, [sessions]);

  return (
    <div className="app">
      {/* 自绘标题栏（右侧为系统窗口按钮 overlay） */}
      <header className="titlebar">
        <button className="titlebar-btn" onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}>
          ☰
        </button>
        <span className="titlebar-title">slime — Agent 管理面板</span>
      </header>

      <div className="body">
        {/* 左侧导航侧栏 */}
        <aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
          <div className="brand">
            <div className="brand-icon">S</div>
            <span className="brand-name">slime</span>
          </div>
          <div className="sidebar-sep" />

          {/* 对话区块：项目（Agent）分组 + 会话 */}
          <div style={{ display: "flex", alignItems: "center", padding: "0 12px 6px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--text-muted)", flex: 1 }}>
              对话
            </span>
            <button className="titlebar-btn" title="新建项目（选择 Agent 建立会话）"
              onClick={() => setNewProjectOpen(true)}>
              ＋
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
            {groups.map((g) => {
              const isCollapsed = collapsed[g.agentId] ?? false;
              return (
                <div key={g.agentId} style={{ marginBottom: 4 }}>
                  {/* 项目头（Agent 名）：点击折叠/展开；右侧 ＋ 新建会话 */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "5px 8px", borderRadius: 8, cursor: "pointer",
                  }}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [g.agentId]: !(prev[g.agentId] ?? false) }))}>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", width: 12, display: "inline-block", transition: "transform 0.12s", transform: isCollapsed ? "rotate(-90deg)" : "none" }}>
                      ▼
                    </span>
                    <span style={{
                      flex: 1, fontSize: 12, fontWeight: 700,
                      color: "var(--text-muted)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {g.agentName}
                    </span>
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{g.items.length}</span>
                    <button className="titlebar-btn" style={{ fontSize: 13 }}
                      title="项目内新建会话"
                      onClick={(e) => { e.stopPropagation(); void startNewSessionInProject(g.agentId); }}>
                      ＋
                    </button>
                    <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.65 }}
                      title="删除项目（清空其下全部会话与历史）"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeProject(g.agentId, g.agentName);
                      }}>
                      ✕
                    </button>
                  </div>
                  {!isCollapsed && g.items.map((s) => {
                    const active = s.sessionId === selectedSessionId;
                    const isEditing = editingSession?.sessionId === s.sessionId;
                    return (
                      <div key={s.sessionId}
                        onClick={() => { if (!isEditing) { setSelectedSessionId(s.sessionId); } }}
                        style={{
                          display: "flex", alignItems: "center", gap: 4,
                          padding: "5px 8px 5px 24px", marginBottom: 1,
                          borderRadius: 8, cursor: "pointer",
                          background: active ? "var(--accent-soft)" : "transparent",
                        }}>
                        {isEditing ? (
                          <input
                            className="input-field" autoFocus
                            style={{ flex: 1, fontSize: 12, padding: "2px 8px", minWidth: 0 }}
                            value={editingSession.draft}
                            onChange={(e) => setEditingSession({ sessionId: s.sessionId, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { void commitRename(); }
                              if (e.key === "Escape") { setEditingSession(null); }
                            }}
                            onBlur={() => void commitRename()}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <span style={{
                              flex: 1, fontSize: 12.5, fontWeight: active ? 700 : 600,
                              color: active ? "var(--accent-hover)" : "var(--text)",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }} title={s.title}>
                              {s.title || "新对话"}
                            </span>
                            <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.6 }}
                              title="重命名会话"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingSession({ sessionId: s.sessionId, draft: s.title });
                              }}>
                              ✎
                            </button>
                            <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.6 }}
                              title="删除会话"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (window.confirm(`删除会话「${s.title}」？其对话历史将一并清除。`)) {
                                  void removeSession(s.sessionId);
                                }
                              }}>
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {groups.length === 0 && (
              <div style={{ color: "var(--text-dim)", fontSize: 12, textAlign: "center", padding: 16 }}>
                暂无会话 — 点击"＋"新建项目
              </div>
            )}
          </div>

          <div className="sidebar-sep" />

          {/* 底部：设置齿轮（弹窗形式） */}
          <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", gap: 8 }}>
            <span style={{ flex: 1, fontSize: 12, color: "var(--text-dim)" }}>
              slime
            </span>
            <button className="titlebar-btn" title="设置（心智中枢 / Agent / 供应商 / 状态）"
              onClick={() => setSettingsOpen(true)}
              style={{ fontSize: 16 }}>
              ⚙
            </button>
          </div>
        </aside>

        {/* 主内容区（对话面板常驻） */}
        <main className="main">
          {selectedSession && selectedAgentId ? (
            <ChatPanel
              sessionId={selectedSession.sessionId}
              sessionTitle={selectedSession.title}
              agentId={selectedAgentId}
              agentName={selectedSession.agentName}
              modelChoice={currentModel}
              mode={currentMode}
              reasoningEffort={currentReasoning}
              providerKeys={providerKeys}
              localModels={localModels}
              onModelChange={(v) => updateAgentConfig({ model_choice: v })}
              onModeChange={(v) => updateAgentConfig({ mode: v })}
              onReasoningChange={(v) => updateAgentConfig({ reasoning_effort: v })}
              onConversationsChanged={() => void loadSessions()}
              onSessionRenamed={(title) => {
                if (selectedSession) {
                  void apiUpdateSessionTitle(selectedSession.sessionId, title);
                }
              }}
              onNewSessionRequested={() => {
                if (selectedAgentId) { void startNewSessionInProject(selectedAgentId); }
              }}
              onNavigateSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)" }}>
              请点击侧栏"＋"新建项目
            </div>
          )}
        </main>
      </div>

      {/* ── 设置弹窗（左侧栏目 + 搜索 + 右侧内容） ── */}
      {settingsOpen && (
        <SettingsDialog
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
          selectedAgentId={selectedAgentId ?? undefined}
          onSelectAgent={() => { void loadSessions(); }}
          onAgentsChanged={() => { void loadAgents(); void loadSessions(); }}
          providerKeys={providerKeys}
          localModels={localModels}
        />
      )}

      {/* ── 新建项目弹窗（选 Agent） ── */}
      {newProjectOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setNewProjectOpen(false); } }}>
          <div className="card" style={{ width: 460, maxWidth: "92vw", maxHeight: "70vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>新建项目</h3>
              <button className="titlebar-btn" onClick={() => setNewProjectOpen(false)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
              选择一个 Agent 建立项目（项目名 = Agent 名），项目内可创建多个独立会话；会话命名可随时修改。
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {agents.map((a) => {
                const hasProject = groups.some((g) => g.agentId === a.id);
                return (
                  <button key={a.id}
                    onClick={() => void startNewProject(a.id)}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "9px 12px", marginBottom: 4,
                      borderRadius: 8, border: "1px solid var(--border)",
                      background: "var(--bg-input)", cursor: "pointer",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{a.name}</span>
                      {hasProject && <span style={{ fontSize: 11, color: "var(--warning)" }}>已有项目</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-all" }}>
                      {a.role || "（无角色）"}
                    </div>
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn" style={{ fontSize: 12.5 }}
                onClick={() => { setNewProjectOpen(false); setSettingsTab("agents"); setSettingsOpen(true); }}>
                或创建新 Agent →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  /** 会话重命名（ChatPanel 工具栏触发） */
  async function apiUpdateSessionTitle(sessionId: string, title: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (api) {
      await api.conversations.rename(sessionId, title).catch(console.error);
      await loadSessions();
    }
  }
}