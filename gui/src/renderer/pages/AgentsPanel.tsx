/**
 * gui/src/renderer/pages/AgentsPanel.tsx — Agent 管理（A-C-C 属性面板风格参考）。
 * - 左侧：Agent 卡片列表（单行：名称/状态点/生命周期/子代数量，简洁不展开描述）
 * - 右侧：选中 Agent 的属性面板（PropsPanel 模式）：
 *   - 身份卡片：name（身份铁律不可改）+ role（可编辑，界面文案「设定」）
 *   - 模型卡片：模式（inherit / api:<key> / local:<id>）+ 模型选择 + 保存
 *     （推理强度的选择已移出设置：由聊天输入框「推理配置」面板 + 供应商「参数文件调试」的推理等级模式控制）
 * - 顶部操作：创建 / 分裂 / 导出 / 导入
 */
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
  /** A-980-R22：工具面白名单（skill/MCP 差异化配置） */
  tool_profile?: ToolProfileLocal;
}

/** A-980-R22：工具面白名单（与 shared/ipc ToolProfileDTO / core-ts ToolProfile 同构） */
interface ToolProfileLocal {
  mode: "default" | "custom";
  skills: string[];
  mcp: string[];
}

/** 工具配置初始值（default=内置推荐集，由 core-ts 运行时解析；custom=用户勾选） */
const EMPTY_TOOL_PROFILE: ToolProfileLocal = { mode: "default", skills: [], mcp: [] };

interface ExtrasCatalog {
  skills: Array<{ name: string; description: string }>;
  mcpServers: Array<{ name: string; description?: string }>;
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

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "build", label: "build" },
  { value: "grow", label: "grow" },
  { value: "normal", label: "normal" },
];

/**
 * A-980-R23：单个工具集面板（技能 / MCP 共用）——**独立搜索 + 独立滚动**。
 *
 * 背景：旧的实现把全部条目平铺成一条无限换行的胶囊流，skill/MCP 一多（几十上百个）就会
 * 把设置面板撑到几屏高、且没法按名字找。现在每个集合各自成一个"窗口"：
 *   头（标题 + 可用数 + 已选数） / 工具条（搜索 + 全选 + 清空） / 标签区（固定高度、可滚动）
 */
function ToolSetBox(props: {
  title: string;
  items: Array<{ name: string; description?: string }>;
  selected: string[];
  onToggle: (name: string) => void;
  /** 整批替换（全选/清空/清除失效项用） */
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
  /** 已选但当前目录里已不存在（技能被删 / MCP 被移除）——照样显示，避免"配置被悄悄丢掉" */
  const missing = selected.filter((n) => !known.has(n));

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 10, background: "var(--card-surface)", overflow: "hidden" }}>
      {/* 头 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{items.length} 个可用</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 11.5, fontWeight: selected.length > 0 ? 700 : 400,
          color: selected.length > 0 ? "var(--accent-hover)" : "var(--text-dim)",
        }}>已选 {selected.length}</span>
      </div>

      {/* 工具条 */}
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

      {/* 标签区（固定高度、可滚动） */}
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

      {/* 失效项提示（技能/MCP 被移除后，配置里仍留着名字） */}
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

/** A-980-R22/R23：工具面选择器（默认推荐集 / 自定义勾选 skill + MCP 服务器），创建与详情编辑共用 */
function ToolProfilePicker(props: {
  value: ToolProfileLocal;
  onChange: (v: ToolProfileLocal) => void;
  extras: ExtrasCatalog;
}): JSX.Element {
  const { value, onChange, extras } = props;
  const toggle = (list: string[], item: string): string[] =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12.5 }}>
        <input type="radio" checked={value.mode === "default"}
          onChange={() => onChange({ mode: "default", skills: [], mcp: [] })} />
        {/* A-980-R30：标签不折行（CJK 每字都是断行点，容器窄时"默认推荐集"的"集"会被拆到下一行） */}
        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>默认推荐集</span>
        <span style={{ color: "var(--text-muted)", flex: 1 }}>内置精选技能（搜索/网页抓取/提示词优化/市场调研/设计生成），不启用第三方 MCP</span>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12.5 }}>
        <input type="radio" checked={value.mode === "custom"}
          onChange={() => onChange({ mode: "custom", skills: [], mcp: [] })} />
        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>自定义</span>
        <span style={{ color: "var(--text-muted)", flex: 1 }}>自主勾选技能与 MCP 服务器（白名单启用）</span>
      </label>
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

  /* 创建弹窗 */
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newRole, setNewRole] = React.useState("");
  /** A-980-R22：创建时的工具面选择（默认推荐集 / 自定义勾选 skill+mcp） */
  const [newTools, setNewTools] = React.useState<ToolProfileLocal>({ ...EMPTY_TOOL_PROFILE });
  const [extras, setExtras] = React.useState<ExtrasCatalog>({ skills: [], mcpServers: [] });

  /**
   * 本组件内部选中态：设置是 Agent 配置的中枢，选中不再依赖会话（selectedAgentId 仅作初始值）。
   * 未配置模型的新 Agent 也能直接点击进入属性面板配置。
   */
  const [localId, setLocalId] = React.useState<string | null>(null);

  const selectedId = localId ?? props.selectedAgentId ?? null;

  /** 选中 Agent：内部态优先（设置中枢），并上抛给 App（加载会话等副作用） */
  const selectAgent = (id: string): void => {
    setLocalId(id);
    props.onSelectAgent(id);
  };

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

  /** A-980-R22：加载技能与 MCP 服务器目录（创建/详情工具配置勾选用） */
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

  /** 选中变化 → 拉取属性面板详情 */
  React.useEffect(() => {
    if (!selectedId || !api.current) { return; }
    api.current.agents.detail(selectedId).then((d: AgentDetail | null) => setDetail(d ? { ...d, tool_profile: d.tool_profile ?? { ...EMPTY_TOOL_PROFILE } } : null)).catch(() => setDetail(null));
    void loadExtras();
  }, [selectedId, agents]);

  /** 详情 → 同步 App 层 agentConfig（属性面板与 ChatPanel 头部一致） */
  React.useEffect(() => {
    if (!selectedId || !detail) { return; }
    const w = window as unknown as { __onAgentDetail?: (id: string, d: AgentDetail) => void };
    w.__onAgentDetail?.(selectedId, detail);
  }, [selectedId, detail]);

  const roleRef = React.useRef<HTMLTextAreaElement | null>(null);
  /** 切换 Agent 时重置「设定」输入框高度（避免上一个 Agent 的高度残留） */
  React.useEffect(() => {
    const el = roleRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }
  }, [detail?.id]);

  function patchLocal(patch: Record<string, string>): void {
    setDetail((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function saveDetail(): Promise<void> {
    if (!api.current || !detail) { return; }
    setBusy(true);
    try {
      // A-980-R23：**不再下发 model_choice**。本面板已撤掉模型选择入口，
      // 若继续把这里的陈旧快照写回去，会覆盖掉用户在聊天区刚选的模型（两处入口互相打架）。
      // 模型统一由聊天区头部下拉维护（App.updateAgentConfig / engine 的 "inherit" 分支）。
      const patch: Record<string, unknown> = { role: detail.role };
      if (detail.mode) { patch.mode = detail.mode; }
      if (detail.show_thinking !== undefined) { patch.show_thinking = detail.show_thinking; }
      // A-980-R22：工具面白名单随保存一并落库
      if (detail.tool_profile) { patch.tool_profile = detail.tool_profile; }
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
          // 选中回落：下一个或清空
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
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── 左：Agent 列表 ── */}
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
                {/* 单行简洁：名称 + 生命周期状态点 + 子代数量；描述内容只在右侧「设定」编辑区展示 */}
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
              <div style={{ marginBottom: 6, fontSize: 12, color: "var(--text-muted)" }}>设定（role）</div>
              <textarea className="input-field" value={detail.role} spellCheck={false} rows={2} ref={roleRef}
                placeholder="如：资深前端工程师"
                style={{ resize: "none", overflowY: "auto", minHeight: 56, maxHeight: 240, lineHeight: 1.5 }}
                onChange={(e) => {
                  patchLocal({ role: e.target.value });
                  // autoResize：内容增长自动增高，上限 240px 后内部滚动
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
                }} />
            </div>

            {/*
             * A-980-R23（用户要求）：**关闭「在 Agent 设置里指定模型」**。
             * 原因：① 实际没什么用——聊天区头部的模型下拉才是日常入口，且它同样写 model_choice，
             *          两处入口互相覆盖；② 容易报错——core-ts/services/engine.ts:686-719 对
             *          `api:<key>` / `local:<id>` 是硬校验，供应商 key 被改名/删除、或本地 GGUF 被移除后，
             *          这里存下的旧值会让整个 Agent 直接路由失败（报「未知的模型选择」），用户却以为是程序坏了。
             * 现在只保留「运行模式」（build/grow/normal，与模型无关），
             * 并且保存时**不再下发 model_choice**（避免用这里的陈旧快照覆盖聊天区刚选的模型）。
             */}
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

            {/* A-980-R22：工具能力（skill / MCP 白名单）——创建后可在此随时修改 */}
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
          <div className="card" style={{ width: 520, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
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
              {/* A-980-R22：工具能力（默认推荐集 / 自定义 skill+MCP 白名单） */}
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