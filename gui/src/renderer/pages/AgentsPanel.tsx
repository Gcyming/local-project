








import React, { type JSX } from "react";
import { CloseIcon } from "../components/Icon.js";
import { confirmAsync } from "../dialog.js";
import { readUnsavedHintHidden, writeUnsavedHintHidden } from "./operationFocus.js";

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



/** A-1197：把「可编辑字段」压成一个可比较的字符串，作为「有没有未保存改动」的判据。
 *
 *  刻意**只**覆盖 `saveDetail()` 真正会写回的那几项（见其 `patch` 构造）：
 *  role / mode / show_thinking / tool_profile / subagent_dispatch。
 *  多算一个字段（如 name、id）会让只读展示字段的差异也算成"脏" ⇒ 平白弹窗；
 *  少算一个字段 ⇒ 那种改动会静默丢掉，正是这次要修的病。
 *  tool_profile 的数组**排序后**再比：勾选顺序不同但集合相同，不该算改动。 */
function unsavedSnapshot(d: AgentDetail | null): string {
  if (!d) { return ""; }
  const tp = d.tool_profile ?? EMPTY_TOOL_PROFILE;
  return JSON.stringify({
    role: d.role,
    mode: d.mode,
    show_thinking: d.show_thinking,
    tool_profile: { mode: tp.mode, skills: [...tp.skills].sort(), mcp: [...tp.mcp].sort() },
    subagent_dispatch: d.subagent_dispatch,
  });
}











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

/** A-1197：设置外壳（`SettingsDialog`）注册进来的「离开闸门」。
 *
 *  ⚠️ **闸门的实现全部在面板内**（判脏 `unsavedSnapshot` / 弹窗 / `hintHidden` 只此一份），
 *  外壳只负责表达"我想离开、去哪" ⇒ 外壳里不会出现第二份判脏逻辑（否则两份判据必然漂移）。
 *  外壳拿到的是**能力**（gate），不是**状态快照**：状态随时可能变（用户还在改），
 *  快照要么过期、要么得额外做同步，两种都是静默失守的产地。 */
export interface AgentLeaveGate {
  /** 当前是否真有未保存改动（面板自己的判脏，供外壳在需要时读；不缓存）。 */
  isDirty: () => boolean;
  /** 是否正挂着「有未保存的改动」确认弹窗。挂起期间外壳的手势（如 Esc）必须让位，
   *  否则会在用户还没回答"要不要放弃"时先把整个设置弹窗关掉。 */
  isConfirming: () => boolean;
  /** 请求离开：无脏、或已勾「以后不再」⇒ 立即执行 `target.run()`；否则弹窗等用户确认。 */
  requestLeave: (target: AgentShellLeave) => void;
}

/** 外壳的一条离开请求。`label` 只进弹窗文案（说清"离开去干什么"），`run` 是真正要执行的动作。 */
export interface AgentShellLeave {
  label: string;
  run: () => void;
}

/** 挂起的离开动作（`null` = 没有待办，即正常态，由 `pendingLeave` state 表达）。
 *  三类：面板内切 Agent / 关掉设置弹窗 / 在设置里切页。 */
type PendingLeave =
  | { kind: "select"; agentId: string }
  | { kind: "shell"; label: string; run: () => void };

interface Props {
  selectedAgentId?: string;
  onSelectAgent: (agentId: string) => void;

  onAgentsChanged?: () => void;

  providerKeys: string[];

  localModels: Array<{ id: string; label: string; path: string }>;
  /** A-1197：挂载期间把离开闸门交给设置外壳（关弹窗 / 切设置页都要过它）。
   *  卸载时必须回传 `null` —— 否则外壳会拿着一个已随面板卸载的闸门去放行（= 没有闸门）。 */
  onRegisterLeaveGate?: (gate: AgentLeaveGate | null) => void;
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

  /* ── A-1197：未保存改动的离开守卫 ──────────────────────────────────
   *
   *  用户原话：「Agent 修改不点保存保存不了」——`patchLocal()` 只改本地 state，
   *  只有 `saveDetail()` 才写回。切到别的 Agent / 关掉设置 / 被别的面板顶替时，
   *  `useEffect` 会用服务端值 `setDetail()` 覆盖，未保存的编辑就**静默消失**了。
   *
   *  `savedRef` 存"上次已落盘"的快照，于是脏判定 = 当前快照 ≠ 已落盘快照。
   *  用 ref 而不是 state：它只被事件处理器读，不需要触发重渲染。 */
  const savedRef = React.useRef<string>("");
  const [dirty, setDirty] = React.useState(false);
  /* ⚠️ 2026-10-08（用户实测报「不管是否修改都会弹窗」）：判脏改为**双条件** ——
     ① 用户**真的编辑过**（editedRef，只有 patchDetail 会置位）
     ② 当前快照与已落盘基线**不同**（savedRef）。
     单独用 ② 时，任何"归一化 / 竞态"类差异都会变成**永久假脏**（拦下每一次离开）；
     而实际拦截的价值只发生在"用户真改过、且真没存"的时候。任一条件不满足即**不拦**——
     宁可漏拦一次（用户手动救），也不要把每一次切页都变成误报。
     editedRef 的生命周期：patchDetail 置 true；markSavedFromServer（加载回填 / 保存成功）
     置 false —— 与基线的重置同拍。 */
  const editedRef = React.useRef(false);
  /* 「以后不再提示」的**面板内常驻开关**：既是勾选框的落点，也是唯一的恢复路径
   * （勾错了还能在这里改回来，不必去翻 localStorage）。 */
  const [hintHidden, setHintHidden] = React.useState<boolean>(() => readUnsavedHintHidden());
  /** 待确认的离开动作。null = 没有待办；确认弹窗期间用它存住"用户想去哪"。
   *  A-1197：`kind` 区分三类离开 —— 面板内切 Agent（select）/ 设置外壳请求的离开（shell）。 */
  const [pendingLeave, setPendingLeave] = React.useState<PendingLeave | null>(null);

  /** 当前是否真有未保存改动：**双条件**（真编辑过 + 快照与基线不同，见 editedRef 注释）。
   *  读快照，不依赖 state，避免闭包过期。 */
  function isDirtyNow(): boolean {
    return editedRef.current && unsavedSnapshot(detail) !== savedRef.current;
  }

  /** 详情从服务端加载完 ⇒ 此刻的内容就是"已落盘"，重置基线并清脏。 */
  function markSavedFromServer(d: AgentDetail | null): void {
    savedRef.current = unsavedSnapshot(d);
    editedRef.current = false;
    setDirty(false);
  }

  /** 真的执行离开（弹窗里点「放弃改动并离开」，或无需确认时的直接放行）。 */
  function commitLeave(next: { kind: "select"; agentId: string }): void {
    setPendingLeave(null);
    if (next.kind === "select") {
      setLocalId(next.agentId);
      props.onSelectAgent(next.agentId);
    }
  }

  /** 离开前的闸门：无脏、或用户勾过「以后不再」⇒ 直接放行；否则弹窗等确认。 */
  function requestLeave(next: { kind: "select"; agentId: string }): void {
    if (!isDirtyNow() || hintHidden) { commitLeave(next); return; }
    setPendingLeave(next);
  }

  /* ── A-1197：交给设置外壳的那一半闸门 ────────────────────────────────
   *
   *  离开路径一共三条，全部必须拦：① 面板内切 Agent（上面 requestLeave）
   *  ② 关掉整个设置弹窗（遮罩 / 关闭按钮 / Esc）③ 在设置弹窗里切到别的设置页。
   *  ②③ 的手势发生在**外壳**，可外壳看不到 `detail`；若让外壳自己判脏，就得把
   *  `unsavedSnapshot` 的字段清单复制一份 —— 两份判据迟早漂移（加字段只改一处 ⇒
   *  某一路径静默失守），而"只在一处失守"恰恰是这类守卫最难发现的形态。
   *  ⇒ 弹窗、判脏、`hintHidden` 三样**全部留在面板内**，外壳只送来"要去哪 + 干什么"。
   *
   *  放行条件与 `requestLeave` 逐字一致（同一对 `isDirtyNow()` / `hintHidden`），
   *  所以"勾了以后不再就真的三条都不弹"是结构性的，不靠人记得同步两处。 */
  function requestShellLeave(target: AgentShellLeave): void {
    if (!isDirtyNow() || hintHidden) { commitShellLeave(target); return; }
    setPendingLeave({ kind: "shell", label: target.label, run: target.run });
  }

  function commitShellLeave(target: AgentShellLeave): void {
    setPendingLeave(null);
    target.run();
  }

  /** 弹窗里那个「放弃改动并离开」的落点：按 kind 分派到对应的执行器。
   *  两类离开共用这一个按钮 ⇒ 不可能出现"弹窗在、但某个 kind 没有出口"的死锁。 */
  function commitPendingLeave(next: PendingLeave): void {
    if (next.kind === "select") { commitLeave({ kind: "select", agentId: next.agentId }); return; }
    commitShellLeave({ label: next.label, run: next.run });
  }

  /* 闸门对象每次渲染都刷新（闭包里的 `detail` / `hintHidden` / `pendingLeave` 才不过期），
   * 而**注册只做一次**：外壳拿到的是这个 ref 指向的实现，不是一份会过期的快照。 */
  const shellGateRef = React.useRef<AgentLeaveGate | null>(null);
  React.useEffect(() => {
    shellGateRef.current = {
      isDirty: () => isDirtyNow(),
      isConfirming: () => pendingLeave !== null,
      requestLeave: (target: AgentShellLeave) => { requestShellLeave(target); },
    };
  });
  React.useEffect(() => {
    const register = props.onRegisterLeaveGate;
    if (!register) { return; }
    register(shellGateRef.current);
    /* 卸载必须注销：否则外壳握着一个已随面板卸载的闸门去放行 = 闸门静默失效。 */
    return () => { register(null); };
  }, []);

  /** 勾选「以后不再」：立刻持久化；取消勾选同样立刻写回（这就是恢复路径）。 */
  function onHintHiddenChange(v: boolean): void {
    setHintHidden(v);
    writeUnsavedHintHidden(v);
  }

  /** 编辑动作统一从这里走 ⇒ 改完立刻把「有未保存改动」显示出来。 */
  function patchDetail(patch: Partial<AgentDetail>): void {
    editedRef.current = true;
    setDetail((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }

  
  const selectAgent = (id: string): void => {
    if (id === selectedId) { return; }
    requestLeave({ kind: "select", agentId: id });
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
    api.current.agents.detail(selectedId).then((d: AgentDetail | null) => {
      const next = d ? { ...d, tool_profile: d.tool_profile ?? { ...EMPTY_TOOL_PROFILE } } : null;
      setDetail(next);
      /* A-1197：服务端回填的这份就是「已落盘」的样子，把它设为基线，
       * 否则切换 Agent 时新内容会被拿去和**上一个** Agent 的快照比较 ⇒ 满屏误报。 */
      markSavedFromServer(next);
    }).catch(() => { setDetail(null); markSavedFromServer(null); });
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
    patchDetail(patch);
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
        /* A-1197：**只有落盘成功**才能把当前内容当成新基线。
         * 失败时保持 dirty，否则用户以为存好了、离开时也不再被拦。 */
        markSavedFromServer(detail);
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
                {dirty && (
                  <span style={{ fontSize: 12, color: "var(--warning)", marginLeft: 8 }}>有未保存改动</span>
                )}
                <span style={{ flex: 1 }} />
                <button className="btn success" onClick={saveDetail} disabled={busy} style={{ fontSize: 13 }}>
                  {busy ? "保存中…" : "保存配置"}
                </button>
              </div>
              {/* A-1197：常驻开关 = 勾选框的落点 **兼**唯一的恢复路径。
                  勾错的人在这里能改回来，不必去翻 localStorage。 */}
              <label style={{
                display: "flex", alignItems: "center", gap: 6, marginBottom: 10,
                fontSize: 11.5, color: "var(--text-dim)", cursor: "pointer", userSelect: "none",
              }}>
                <input type="checkbox" checked={hintHidden} style={{ accentColor: "var(--accent)" }}
                  onChange={(e) => onHintHiddenChange(e.target.checked)} />
                <span>以后不再提示未保存改动（关掉后，切 Agent / 离开本页将直接放行）</span>
              </label>
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
                onChange={(v) => patchDetail({ tool_profile: v })}
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
      {pendingLeave && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.72)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div className="modal-card" style={{ width: 440, maxWidth: "92vw" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>有未保存的改动</h3>
              <button className="titlebar-btn" title="留在此页继续编辑"
                onClick={() => setPendingLeave(null)}><CloseIcon size={12} /></button>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.65, marginBottom: 12 }}>
              你在「<b>{detail?.name ?? ""}</b>」的配置里改了东西但还没点
              <b style={{ color: "var(--warning)" }}> 保存配置 </b>。
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                现在{pendingLeave.kind === "shell" ? <>（{pendingLeave.label}）</> : null}离开会<b>直接丢掉</b>这些改动（设定 / 运行模式 / 子代理派发 / 工具能力），不会自动保留。
              </div>
            </div>
            <label style={{
              display: "flex", alignItems: "center", gap: 6, marginBottom: 14,
              fontSize: 12, color: "var(--text-muted)", cursor: "pointer", userSelect: "none",
            }}>
              <input type="checkbox" checked={hintHidden} style={{ accentColor: "var(--accent)" }}
                onChange={(e) => onHintHiddenChange(e.target.checked)} />
              <span>以后不再出现此提示</span>
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setPendingLeave(null)}>取消，留在此页保存</button>
              <button className="btn danger" onClick={() => { commitPendingLeave(pendingLeave); }}>放弃改动并离开</button>
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