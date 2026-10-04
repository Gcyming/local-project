








import React, { type JSX } from "react";
import { CloseIcon } from "../components/Icon.js";
import { confirmAsync } from "../dialog.js";

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
  show_thinking?: string;
  max_context?: number;
  max_output?: number;
  lifecycle: string;
  
  tool_profile?: ToolProfileLocal;
  




  subagent_dispatch?: boolean;
}



interface ToolProfileLocal {
  mode: "default" | "creator" | "custom";
  skills: string[];
  mcp: string[];
}


const EMPTY_TOOL_PROFILE: ToolProfileLocal = { mode: "default", skills: [], mcp: [] };











const CAPABILITY_MODES: Array<{ value: ToolProfileLocal["mode"]; label: string; desc: string }> = [
  {
    value: "default", label: "标准模式",
    desc: "开箱即用：内置精选技能（搜索 / 网页抓取 / 提示词优化 / 市场调研 / 设计生成），不启用第三方 MCP。覆盖通用场景，各方面均衡。",
  },
  {
    value: "creator", label: "创造模式",
    desc: "在标准模式之上，授权 Agent 在现有技能不够用时**给自己造技能**并立即使用。自建技能会声明 origin: agent，可在「插件」页查看与停用。",
  },
  {
    value: "custom", label: "自定义模式",
    desc: "纯自搭工作区：自主勾选技能与 MCP 服务器，按白名单启用。",
  },
];

interface ExtrasCatalog {
  skills: Array<{ name: string; description: string }>;
  mcpServers: Array<{ name: string; description?: string }>;
}

interface Props {
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  
  onAgentsChanged?: () => void;
  
  providerKeys: string[];
  
  localModels: Array<{ id: string; label: string; path: string }>;
}

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "build", label: "build" },
  { value: "grow", label: "grow" },
  { value: "normal", label: "normal" },
];








function ToolSetBox(props: {
  title: string;
  items: Array<{ name: string; description?: string }>;
  selected: string[];
  onToggle: (name: string) => void;
  
  onReplace: (names: string[]) => void;
  emptyText: string;
}): JSX.Element {
  const { title, items, selected, onToggle, onReplace, emptyText } = props;
  const [q, setQ] = React.useState("");
  const query = q.trim().toLowerCase();
  const shown = React.useMemo(() => {
    if (!query) { return items; }
    return items.filter((it) =>
      it.name.toLowerCase().includes(query) || (it.description ?? "").toLowerCase().includes(query));
  }, [items, query]);
  const shownNames = React.useMemo(() => shown.map((it) => it.name), [shown]);
  const allShownSelected = shownNames.length > 0 && shownNames.every((n) => selected.includes(n));
  const known = React.useMemo(() => new Set(items.map((i) => i.name)), [items]);
  
  const missing = selected.filter((n) => !known.has(n));

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 10, background: "var(--card-surface)", overflow: "hidden" }}>
      {}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{items.length} 个可用</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 11.5, fontWeight: selected.length > 0 ? 700 : 400,
          color: selected.length > 0 ? "var(--accent-hover)" : "var(--text-dim)",
        }}>已选 {selected.length}</span>
      </div>

      {}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px 6px" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <input className="input-field" value={q} spellCheck={false} placeholder={`搜索${title}…`}
            style={{ padding: "4px 24px 4px 8px", fontSize: 12 }}
            onChange={(e) => setQ(e.target.value)} />
          {q !== "" && (
            <button type="button" title="清空搜索" onClick={() => setQ("")}
              style={{
                position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                border: "none", background: "transparent", color: "var(--text-dim)",
                cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 2,
              }}>✕</button>
          )}
        </div>
        <button type="button" className="btn" disabled={shownNames.length === 0}
          style={{ fontSize: 11.5, padding: "3px 8px", flexShrink: 0 }}
          onClick={() => onReplace(
            allShownSelected
              ? selected.filter((n) => !shownNames.includes(n))
              : [...selected, ...shownNames.filter((n) => !selected.includes(n))],
          )}>
          {allShownSelected ? "取消" : "全选"}{query ? "结果" : ""}
        </button>
        <button type="button" className="btn" disabled={selected.length === 0}
          style={{ fontSize: 11.5, padding: "3px 8px", flexShrink: 0 }}
          onClick={() => onReplace([])}>清空</button>
      </div>

      {}
      <div style={{
        maxHeight: 190, overflowY: "auto", padding: "0 10px 10px",
        display: "flex", flexWrap: "wrap", gap: 6, alignContent: "flex-start",
      }}>
        {shown.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--text-dim)", padding: "6px 2px" }}>
            {items.length === 0 ? emptyText : `没有匹配「${q.trim()}」的项`}
          </span>
        )}
        {shown.map((it) => {
          const on = selected.includes(it.name);
          return (
            <button key={it.name} type="button" title={it.description || it.name}
              onClick={() => onToggle(it.name)}
              style={{
                padding: "3px 10px", borderRadius: 999, fontSize: 12, cursor: "pointer",
                maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                border: on ? "1px solid var(--accent)" : "1px solid var(--border-hover)",
                background: on ? "var(--accent-soft)" : "transparent",
                color: on ? "var(--accent-hover)" : "var(--text-secondary)",
                fontWeight: on ? 700 : 400,
              }}>{on ? "✓ " : ""}{it.name}</button>
          );
        })}
      </div>

      {}
      {missing.length > 0 && (
        <div style={{
          borderTop: "1px solid var(--border)", padding: "6px 10px", fontSize: 11.5,
          color: "#f59e0b", display: "flex", gap: 6, alignItems: "center",
        }}>
          <span title={missing.join("、")}
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            已选但当前不可用：{missing.join("、")}
          </span>
          <button type="button" className="btn" style={{ fontSize: 11, padding: "1px 6px", flexShrink: 0 }}
            onClick={() => onReplace(selected.filter((n) => known.has(n)))}>清除</button>
        </div>
      )}
    </div>
  );
}


function ToolProfilePicker(props: {
  value: ToolProfileLocal;
  onChange: (v: ToolProfileLocal) => void;
  extras: ExtrasCatalog;
}): JSX.Element {
  const { value, onChange, extras } = props;
  const toggle = (list: string[], item: string): string[] =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  
  const pick = (mode: ToolProfileLocal["mode"]): void =>
    onChange(mode === "custom"
      ? { mode: "custom", skills: value.skills, mcp: value.mcp }
      : { mode, skills: [], mcp: [] });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {CAPABILITY_MODES.map((m) => {
        const on = value.mode === m.value;
        return (
          <label key={m.value}
            style={{
              display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer",
              fontSize: 12.5, padding: "9px 11px", borderRadius: 9,
              border: on ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: on ? "var(--accent-soft)" : "transparent",
            }}>
            <input type="radio" name="capability-mode" checked={on}
              style={{ marginTop: 2, flexShrink: 0 }}
              onChange={() => pick(m.value)} />
            {}
            <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{m.label}</span>
              <span style={{ color: "var(--text-muted)" }}>{m.desc}</span>
            </span>
          </label>
        );
      })}
      {value.mode === "custom" && (
        <>
          <ToolSetBox title="技能（Skill）" items={extras.skills} selected={value.skills}
            onToggle={(n) => onChange({ ...value, skills: toggle(value.skills, n) })}
            onReplace={(names) => onChange({ ...value, skills: names })}
            emptyText="暂无可用技能" />
          <ToolSetBox title="MCP 服务器" items={extras.mcpServers} selected={value.mcp}
            onToggle={(n) => onChange({ ...value, mcp: toggle(value.mcp, n) })}
            onReplace={(names) => onChange({ ...value, mcp: names })}
            emptyText="暂无已配置的 MCP 服务器（到「设置 → MCP 接入」添加）" />
        </>
      )}
    </div>
  );
}

const AgentsPanel = React.memo(function AgentsPanel(props: Props): JSX.Element {
  const api = React.useRef<any>(null);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [detail, setDetail] = React.useState<AgentDetail | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newRole, setNewRole] = React.useState("");
  
  const [newTools, setNewTools] = React.useState<ToolProfileLocal>({ ...EMPTY_TOOL_PROFILE });
  const [extras, setExtras] = React.useState<ExtrasCatalog>({ skills: [], mcpServers: [] });

  



  const [localId, setLocalId] = React.useState<string | null>(null);

  const selectedId = localId ?? props.selectedAgentId ?? null;

  
  const selectAgent = (id: string): void => {
    setLocalId(id);
    props.onSelectAgent(id);
  };

  
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

  
  const loadExtras = React.useCallback(async (): Promise<void> => {
    if (!api.current?.extras) { return; }
    const [sk, mcp] = await Promise.all([
      api.current.extras.skillList().catch(() => []),
      api.current.extras.mcpList().catch(() => []),
    ]);
    const skills = Array.isArray(sk) ? sk.map((s: { name: string; description?: string }) => ({ name: String(s.name ?? ""), description: String(s.description ?? "") })).filter((s: { name: string }) => s.name) : [];
    const mcpServers = Array.isArray(mcp) ? mcp.map((m: { name: string }) => ({ name: String(m.name ?? "") })).filter((m: { name: string }) => m.name) : [];
    setExtras({ skills, mcpServers });
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

  
  React.useEffect(() => {
    if (!selectedId || !api.current) { return; }
    api.current.agents.detail(selectedId).then((d: AgentDetail | null) => setDetail(d ? { ...d, tool_profile: d.tool_profile ?? { ...EMPTY_TOOL_PROFILE } } : null)).catch(() => setDetail(null));
    void loadExtras();
  }, [selectedId, agents]);

  
  React.useEffect(() => {
    if (!selectedId || !detail) { return; }
    const w = window as unknown as { __onAgentDetail?: (id: string, d: AgentDetail) => void };
    w.__onAgentDetail?.(selectedId, detail);
  }, [selectedId, detail]);

  const roleRef = React.useRef<HTMLTextAreaElement | null>(null);
  
  React.useEffect(() => {
    const el = roleRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }
  }, [detail?.id]);

  

  function patchLocal(patch: Partial<AgentDetail>): void {
    setDetail((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function saveDetail(): Promise<void> {
    if (!api.current || !detail) { return; }
    setBusy(true);
    try {
      
      
      
      const patch: Record<string, unknown> = { role: detail.role };
      if (detail.mode) { patch.mode = detail.mode; }
      if (detail.show_thinking !== undefined) { patch.show_thinking = detail.show_thinking; }
      
      if (detail.tool_profile) { patch.tool_profile = detail.tool_profile; }
      
      
      
      if (detail.subagent_dispatch !== undefined) { patch.subagent_dispatch = detail.subagent_dispatch; }
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
      const a = await api.current.agents.create(newName.trim(), newRole.trim(), newTools);
      showNotice(true, `已创建 Agent「${a.name}」`);
      setCreating(false);
      setNewName("");
      setNewRole("");
      await loadAgents();
      selectAgent(a.id);
    } catch (e) {
      showNotice(false, `创建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFork(): Promise<void> {
    if (!api.current || !selectedId) { return; }
    if (!(await confirmAsync(`以「${detail?.name ?? ""}」为父分裂出新 Agent？`, "fork，最大深度 2"))) { return; }
    setBusy(true);
    try {
      const a = await api.current.agents.fork(selectedId, `${detail?.name ?? "agent"}-子`, "");
      showNotice(true, `已分裂出「${a.name}」`);
      await loadAgents();
      selectAgent(a.id);
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
      if (res.agentId) { selectAgent(res.agentId); }
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
          
          const remaining = agents.filter((a) => a.id !== pendingDelete.id);
          if (remaining[0]?.id) { selectAgent(remaining[0].id); } else { setLocalId(null); props.onSelectAgent(""); }
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

  const lifecycleColor = (lifecycle: string): string => {
    switch (lifecycle) {
      case "active": return "var(--success)";
      case "evolving": return "#f59e0b";
      case "split": return "#8b5cf6";
      default: return "var(--text-dim)";
    }
  };

  return (
    <div className="settings-pane" style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {}
      <div style={{ width: 280, minWidth: 280, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 12px 8px", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>Agents（{agents.length}）</span>
          <button className="btn primary" style={{ padding: "2px 10px", fontSize: 12.5 }}
            onClick={() => {
              setCreating(true);
              setNewTools({ ...EMPTY_TOOL_PROFILE });
              void loadExtras();
            }}>＋ 创建</button>
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
                onClick={() => selectAgent(a.id)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "9px 10px", marginBottom: 4,
                  borderRadius: 8, border: active ? "1px solid var(--accent)" : "1px solid transparent",
                  background: active ? "var(--accent-soft)" : "transparent",
                  cursor: "pointer",
                }}>
                {}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{a.name}</span>
                  <span title={a.lifecycle} style={{ width: 7, height: 7, borderRadius: "50%", background: lifecycleColor(a.lifecycle), flexShrink: 0 }} />
                  <span style={{ flex: 1 }} />
                  {a.children.length > 0 && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{a.children.length} 子</span>
                  )}
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

      {}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {!detail ? (
          <div style={{ color: "var(--text-dim)", textAlign: "center", paddingTop: 48, fontSize: 13 }}>
            选择左侧 Agent 查看与编辑属性
          </div>
        ) : (
          <>
            {}
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
              <div style={{ marginBottom: 6, fontSize: 12, color: "var(--text-muted)" }}>设定（role）</div>
              <textarea className="input-field" value={detail.role} spellCheck={false} rows={2} ref={roleRef}
                placeholder="如：资深前端工程师"
                style={{ resize: "none", overflowY: "auto", minHeight: 56, maxHeight: 240, lineHeight: 1.5 }}
                onChange={(e) => {
                  patchLocal({ role: e.target.value });
                  
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
                }} />
            </div>

            {







}
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>运行模式</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                模型由聊天区头部的模型下拉决定（{mc === "inherit" ? "当前：跟随会话/群聊所选模型" : `当前：${mc}`}）；
                Agent 设置不再单独指定模型，避免与聊天区选择冲突或引用到已失效的供应商。
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                {MODE_OPTIONS.map((o) => (
                  <button key={o.value}
                    className={`btn${detail.mode === o.value ? " primary" : ""}`}
                    style={{ fontSize: 12.5, padding: "3px 12px" }}
                    onClick={() => patchLocal({ mode: o.value })}>
                    {o.label}
                  </button>
                ))}
              </div>
              {detail.max_context !== undefined || detail.max_output !== undefined ? (
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
                  当前配置：{detail.max_context ? `上下文 ${detail.max_context}` : ""}
                  {detail.max_output ? ` · 输出上限 ${detail.max_output}` : ""}
                </div>
              ) : null}
            </div>

            {


}
            <div style={{ padding: "12px 14px", border: "1px solid var(--card-border)", borderRadius: 10, background: "var(--card-surface)", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>子代理派发</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.7 }}>
                同意后，主 Agent 可以把「独立、自包含」的子任务派发给这个 Agent 执行——
                它会在<b>自己的上下文</b>里跑（不污染主线），只把结论交回主线验收。
                不同意则它不会出现在「可用子代理」清单里，也不会被点名。
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {[{ v: true, label: "允许被派发" }, { v: false, label: "不派发" }].map((o) => {
                  
                  const allowed = detail.subagent_dispatch !== false;
                  return (
                    <button key={String(o.v)}
                      className={`btn${allowed === o.v ? " primary" : ""}`}
                      style={{ fontSize: 12.5, padding: "3px 12px" }}
                      onClick={() => patchLocal({ subagent_dispatch: o.v })}>
                      {o.label}
                    </button>
                  );
                })}
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                  {detail.subagent_dispatch === undefined
                    ? "当前：未设置（默认允许）"
                    : detail.subagent_dispatch ? "当前：已同意" : "当前：已拒绝"}
                </span>
              </div>
            </div>

            {}
            <div style={{ padding: "12px 14px", border: "1px solid var(--card-border)", borderRadius: 10, background: "var(--card-surface)", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>工具能力</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
                skill 与 MCP 按 Agent 白名单启用（默认推荐集 / 自定义），变更保存后对该 Agent 生效
              </div>
              <ToolProfilePicker
                value={detail.tool_profile ?? { ...EMPTY_TOOL_PROFILE }}
                onChange={(v) => setDetail({ ...detail, tool_profile: v })}
                extras={extras}
              />
            </div>

            {}
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

      {}
      {creating && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setCreating(false); } }}>
          <div className="modal-card" style={{ width: 520, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
              <h3 style={{ margin: 0, flex: 1 }}>创建 Agent</h3>
              <button className="titlebar-btn" onClick={() => setCreating(false)}><CloseIcon size={12} /></button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>名称（唯一，不可修改）</div>
              <input className="input-field" value={newName} spellCheck={false}
                placeholder="如：research-agent" style={{ marginBottom: 10 }}
                onChange={(e) => setNewName(e.target.value)} />
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>设定（可后续修改）</div>
              <input className="input-field" value={newRole} spellCheck={false}
                placeholder="如：负责资料检索与总结" style={{ marginBottom: 14 }}
                onChange={(e) => setNewRole(e.target.value)} />
              {}
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>工具能力（可在 Agent 管理中随时修改）</div>
              <div style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--card-border)", background: "var(--card-surface)", marginBottom: 14 }}>
                <ToolProfilePicker value={newTools} onChange={setNewTools} extras={extras} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0, paddingTop: 10 }}>
              <button className="btn success" onClick={handleCreate} disabled={busy || !newName.trim()}>
                {busy ? "创建中…" : "创建"}
              </button>
              <button className="btn" onClick={() => setCreating(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {}
      {pendingDelete && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setPendingDelete(null); } }}>
          <div className="modal-card" style={{ width: 400, maxWidth: "90vw" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>删除 Agent</h3>
              <button className="titlebar-btn" onClick={() => setPendingDelete(null)}><CloseIcon size={12} /></button>
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
});

const chip = (color: string): React.CSSProperties => {
  return {
    display: "inline-block", marginLeft: 8, padding: "1px 8px", borderRadius: 8,
    fontSize: 11, color, background: "var(--accent-soft)", border: `1px solid ${color}`,
  };
};

export default AgentsPanel;