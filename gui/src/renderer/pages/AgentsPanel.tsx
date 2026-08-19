/**
 * gui/src/renderer/pages/AgentsPanel.tsx — Agent 管理（A-C-C 属性面板风格参考）。
 * - 左侧：Agent 卡片列表（名称/角色/生命周期徽章/子代数量）
 * - 右侧：选中 Agent 的属性面板（PropsPanel 模式）：
 *   - 身份卡片：name（身份铁律不可改）+ role（可编辑）
 *   - 模型卡片：模式（inherit / api:<key> / local:<id>）+ 模型选择 + 推理强度 + 保存
 * - 顶部操作：创建 / 分裂 / 导出 / 导入
 */
import React, { type JSX } from "react";

interface AgentBrief {
  id: string;
  name: string;
  role: string;
  children: string[];
  parent_id: string | null;
  lifecycle: string;
}

interface AgentDetail {
  id: string;
  name: string;
  role: string;
  model_choice: string;
  mode: string;
  reasoning_effort: string;
  max_context?: number;
  max_output?: number;
  lifecycle: string;
}

interface Props {
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  /** 删除/变更后通知 App 刷新（选中回落由本组件处理） */
  onAgentsChanged?: () => void;
  /** 供应商 key 列表（model_choice = api:<key>） */
  providerKeys: string[];
  /** 本地模型列表（model_choice = local:<id>） */
  localModels: Array<{ id: string; label: string; path: string }>;
}

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "none", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "build", label: "build" },
  { value: "grow", label: "grow" },
  { value: "normal", label: "normal" },
];

export default function AgentsPanel(props: Props): JSX.Element {
  const api = React.useRef<any>(null);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [detail, setDetail] = React.useState<AgentDetail | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  /* 创建弹窗 */
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newRole, setNewRole] = React.useState("");

  const selectedId = props.selectedAgentId ?? null;

  /** 删除确认用（记录待删 id + 弹确认层） */
  const [pendingDelete, setPendingDelete] = React.useState<AgentBrief | null>(null);

  function showNotice(ok: boolean, text: string): void {
    setNotice({ ok, text });
    window.setTimeout(() => setNotice(null), 5000);
  }

  const loadAgents = React.useCallback(async (): Promise<void> => {
    if (!api.current) { return; }
    const list = await api.current.agents.list().catch((e: unknown) => {
      console.error("[agents] list failed:", e);
      return [];
    });
    setAgents(list);
  }, []);

  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    api.current = w.slimeAPI;
    if (api.current) {
      void loadAgents();
      const off = api.current.agents.onAgentSelected(() => { void loadAgents(); });
      return () => { off(); };
    }
  }, [loadAgents]);

  /** 选中变化 → 拉取属性面板详情 */
  React.useEffect(() => {
    if (!selectedId || !api.current) { return; }
    api.current.agents.detail(selectedId).then((d: AgentDetail | null) => setDetail(d)).catch(() => setDetail(null));
  }, [selectedId, agents]);

  /** 详情 → 同步 App 层 agentConfig（属性面板与 ChatPanel 头部一致） */
  React.useEffect(() => {
    if (!selectedId || !detail) { return; }
    const w = window as unknown as { __onAgentDetail?: (id: string, d: AgentDetail) => void };
    w.__onAgentDetail?.(selectedId, detail);
  }, [selectedId, detail]);

  function patchLocal(patch: Record<string, string>): void {
    setDetail((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function saveDetail(): Promise<void> {
    if (!api.current || !detail) { return; }
    setBusy(true);
    try {
      const patch: Record<string, unknown> = { role: detail.role, model_choice: detail.model_choice };
      if (detail.reasoning_effort !== "none") {
        patch.reasoning_effort = detail.reasoning_effort;
      } else {
        patch.reasoning_effort = "none";
      }
      if (detail.mode) { patch.mode = detail.mode; }
      const res = await api.current.agents.update(detail.id, patch);
      if (res.ok) {
        showNotice(true, `「${detail.name}」配置已保存`);
        await loadAgents();
      } else {
        showNotice(false, "保存失败");
      }
    } catch (e) {
      showNotice(false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(): Promise<void> {
    if (!api.current || !newName.trim()) { return; }
    setBusy(true);
    try {
      const a = await api.current.agents.create(newName.trim(), newRole.trim());
      showNotice(true, `已创建 Agent「${a.name}」`);
      setCreating(false);
      setNewName("");
      setNewRole("");
      await loadAgents();
      props.onSelectAgent(a.id);
    } catch (e) {
      showNotice(false, `创建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFork(): Promise<void> {
    if (!api.current || !selectedId) { return; }
    if (!window.confirm(`以「${detail?.name ?? ""}」为父分裂出新 Agent（fork，最大深度 2）？`)) { return; }
    setBusy(true);
    try {
      const a = await api.current.agents.fork(selectedId, `${detail?.name ?? "agent"}-子`, "");
      showNotice(true, `已分裂出「${a.name}」`);
      await loadAgents();
      props.onSelectAgent(a.id);
    } catch (e) {
      showNotice(false, `分裂失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(): Promise<void> {
    if (!api.current || !selectedId) { return; }
    const res = await api.current.agents.exportAgent(selectedId);
    showNotice(res.ok, res.ok ? `已导出：${res.path}` : (res.error ?? "导出失败"));
  }

  async function handleImport(): Promise<void> {
    if (!api.current) { return; }
    const res = await api.current.agents.importPack();
    if (res.ok) {
      showNotice(true, `已导入「${res.agentName ?? ""}」`);
      await loadAgents();
      if (res.agentId) { props.onSelectAgent(res.agentId); }
    } else if (res.error && !res.error.includes("取消")) {
      showNotice(false, res.error);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!api.current || !pendingDelete) { return; }
    setBusy(true);
    try {
      const res = await api.current.agents.remove(pendingDelete.id);
      if (res.ok) {
        showNotice(true, `已删除「${pendingDelete.name}」及其子树（${(res.deleted?.length ?? 1)} 个 Agent，历史已清理）`);
        setPendingDelete(null);
        await loadAgents();
        props.onAgentsChanged?.();
        if (selectedId === pendingDelete.id) {
          // 选中回落：下一个或清空
          const remaining = agents.filter((a) => a.id !== pendingDelete.id);
          props.onSelectAgent(remaining[0]?.id ?? "");
        }
      } else {
        showNotice(false, res.error ?? "删除失败");
        setPendingDelete(null);
      }
    } catch (e) {
      showNotice(false, `删除失败：${e instanceof Error ? e.message : String(e)}`);
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  }

  const mc = detail?.model_choice ?? "inherit";
  const mcMode = mc === "inherit" ? "inherit" : mc.startsWith("api:") ? "api" : mc.startsWith("local:") ? "local" : "inherit";
  const mcKey = mc.startsWith("api:") ? mc.slice(4) : "";
  const mcLocal = mc.startsWith("local:") ? mc.slice(6) : "";

  const lifecycleColor = (lifecycle: string): string => {
    switch (lifecycle) {
      case "active": return "var(--success)";
      case "evolving": return "#f59e0b";
      case "split": return "#8b5cf6";
      default: return "var(--text-dim)";
    }
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── 左：Agent 列表 ── */}
      <div style={{ width: 280, minWidth: 280, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 12px 8px", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>Agents（{agents.length}）</span>
          <button className="btn primary" style={{ padding: "2px 10px", fontSize: 12.5 }}
            onClick={() => setCreating(true)}>＋ 创建</button>
        </div>
        {notice && (
          <div style={{
            margin: "0 12px 8px", padding: "6px 10px", fontSize: 12, lineHeight: 1.4, wordBreak: "break-all",
            borderRadius: 6, border: "1px solid var(--border)",
            background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
            color: notice.ok ? "var(--success)" : "#f87171",
          }}>
            {notice.text}
          </div>
        )}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
          {agents.map((a) => {
            const active = a.id === selectedId;
            return (
              <button key={a.id}
                onClick={() => props.onSelectAgent(a.id)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "9px 10px", marginBottom: 4,
                  borderRadius: 8, border: active ? "1px solid var(--accent)" : "1px solid transparent",
                  background: active ? "var(--accent-soft)" : "transparent",
                  cursor: "pointer",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{a.name}</span>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: lifecycleColor(a.lifecycle), flexShrink: 0 }} />
                  <span style={{ flex: 1 }} />
                  {a.children.length > 0 && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{a.children.length} 子</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-all" }}>
                  {a.role || "（无角色）"}
                </div>
              </button>
            );
          })}
          {agents.length === 0 && (
            <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 24, fontSize: 12.5 }}>
              暂无 Agent — 点击"＋ 创建"
            </div>
          )}
        </div>
      </div>

      {/* ── 右：属性面板（A-C-C PropsPanel 风格） ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {!detail ? (
          <div style={{ color: "var(--text-dim)", textAlign: "center", paddingTop: 48, fontSize: 13 }}>
            选择左侧 Agent 查看与编辑属性
          </div>
        ) : (
          <>
            {/* 身份卡片 */}
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 18, fontWeight: 800 }}>{detail.name}</span>
                <span style={chip(lifecycleColor(detail.lifecycle))}>{detail.lifecycle}</span>
                <span style={{ flex: 1 }} />
                <button className="btn success" onClick={saveDetail} disabled={busy} style={{ fontSize: 13 }}>
                  {busy ? "保存中…" : "保存配置"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
                身份铁律：name 不可修改；回答始终自称「{detail.name}」
              </div>
              <div style={{ marginBottom: 6, fontSize: 12, color: "var(--text-muted)" }}>角色（role）</div>
              <input className="input-field" value={detail.role} spellCheck={false}
                placeholder="如：资深前端工程师"
                onChange={(e) => patchLocal({ role: e.target.value })} />
            </div>

            {/* 模型卡片 */}
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>模型配置</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                model_choice：{mc} {mcMode === "api" && `→ api:<${mcKey}>（取该供应商默认模型）`}
                {mcMode === "local" && `→ local:<${mcLocal}>（llama.cpp 本地模型）`}
              </div>

              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>模式</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {MODE_OPTIONS.map((o) => (
                  <button key={o.value}
                    className={`btn${detail.mode === o.value ? " primary" : ""}`}
                    style={{ fontSize: 12.5, padding: "3px 12px" }}
                    onClick={() => patchLocal({ mode: o.value })}>
                    {o.label}
                  </button>
                ))}
              </div>

              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>模型来源</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                {([
                  { v: "inherit", label: "继承父级" },
                  { v: "api", label: "API 供应商" },
                  { v: "local", label: "本地模型" },
                ] as const).map((o) => (
                  <button key={o.v}
                    className={`btn${mcMode === o.v ? " primary" : ""}`}
                    style={{ fontSize: 12.5, padding: "3px 12px" }}
                    onClick={() => {
                      if (o.v === "inherit") { patchLocal({ model_choice: "inherit" }); }
                      if (o.v === "api") {
                        patchLocal({ model_choice: props.providerKeys.length > 0 ? `api:${props.providerKeys[0]}` : "inherit" });
                      }
                      if (o.v === "local") {
                        patchLocal({ model_choice: props.localModels.length > 0 ? `local:${props.localModels[0].id}` : "inherit" });
                      }
                    }}>
                    {o.label}
                  </button>
                ))}
              </div>

              {mcMode === "api" && (
                <>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>供应商</div>
                  <select className="input-field" style={{ marginBottom: 10, padding: "5px 8px" }}
                    value={mcKey}
                    onChange={(e) => patchLocal({ model_choice: `api:${e.target.value}` })}>
                    {props.providerKeys.length === 0 && <option value="">（无供应商 — 请到"供应商"页添加）</option>}
                    {props.providerKeys.map((k) => <option key={k} value={k}>api:{k}</option>)}
                  </select>
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
                    模型选择在"供应商"页的编辑界面中维护（每个供应商可调默认模型与多模型参数）
                  </div>
                </>
              )}

              {mcMode === "local" && (
                <>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>本地模型</div>
                  <select className="input-field" style={{ marginBottom: 10, padding: "5px 8px" }}
                    value={mcLocal}
                    onChange={(e) => patchLocal({ model_choice: `local:${e.target.value}` })}>
                    {props.localModels.length === 0 && <option value="">（无本地模型 — 请到"供应商"页导入 GGUF）</option>}
                    {props.localModels.map((m) => <option key={m.id} value={m.id}>{m.label}（local:{m.id}）</option>)}
                  </select>
                </>
              )}

              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>推理强度</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {REASONING_OPTIONS.map((o) => (
                  <button key={o.value}
                    className={`btn${detail.reasoning_effort === o.value ? " primary" : ""}`}
                    style={{ fontSize: 12.5, padding: "3px 12px" }}
                    onClick={() => patchLocal({ reasoning_effort: o.value })}>
                    {o.label}
                  </button>
                ))}
              </div>

              {detail.max_context !== undefined || detail.max_output !== undefined ? (
                <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                  当前配置：{detail.max_context ? `上下文 ${detail.max_context}` : ""}
                  {detail.max_output ? ` · 输出上限 ${detail.max_output}` : ""}
                </div>
              ) : null}
            </div>

            {/* 管理操作 */}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={handleFork} disabled={busy} style={{ fontSize: 12.5 }}>
                ⑂ 分裂（fork）
              </button>
              <button className="btn" onClick={handleExport} disabled={busy} style={{ fontSize: 12.5 }}>
                ⤓ 导出身份
              </button>
              <button className="btn" onClick={handleImport} disabled={busy} style={{ fontSize: 12.5 }}>
                ⤒ 导入身份
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn danger" onClick={() => setPendingDelete({ id: detail.id, name: detail.name, role: detail.role, children: [], parent_id: null, lifecycle: detail.lifecycle })}
                disabled={busy} style={{ fontSize: 12.5 }}>
                删除 Agent
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── 创建弹窗 ── */}
      {creating && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setCreating(false); } }}>
          <div className="card" style={{ width: 420, maxWidth: "90vw" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, flex: 1 }}>创建 Agent</h3>
              <button className="titlebar-btn" onClick={() => setCreating(false)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>名称（唯一，不可修改）</div>
            <input className="input-field" value={newName} spellCheck={false}
              placeholder="如：research-agent" style={{ marginBottom: 10 }}
              onChange={(e) => setNewName(e.target.value)} />
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>角色（可后续修改）</div>
            <input className="input-field" value={newRole} spellCheck={false}
              placeholder="如：负责资料检索与总结" style={{ marginBottom: 14 }}
              onChange={(e) => setNewRole(e.target.value)} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn success" onClick={handleCreate} disabled={busy || !newName.trim()}>
                {busy ? "创建中…" : "创建"}
              </button>
              <button className="btn" onClick={() => setCreating(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 删除确认层 ── */}
      {pendingDelete && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setPendingDelete(null); } }}>
          <div className="card" style={{ width: 400, maxWidth: "90vw" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>删除 Agent</h3>
              <button className="titlebar-btn" onClick={() => setPendingDelete(null)}>✕</button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
              确定删除 <b style={{ color: "#f87171" }}>{pendingDelete.name}</b> 及其全部子 Agent？
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                将同时清理对话历史与孤立数据引用（悬空 children 自动修复）。此操作不可撤销。
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn danger" onClick={confirmDelete} disabled={busy}>
                {busy ? "删除中…" : "确认删除"}
              </button>
              <button className="btn" onClick={() => setPendingDelete(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function chip(color: string): React.CSSProperties {
  return {
    display: "inline-block", marginLeft: 8, padding: "1px 8px", borderRadius: 8,
    fontSize: 11, color, background: "var(--accent-soft)", border: `1px solid ${color}`,
  };
}