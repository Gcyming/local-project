/**
 * gui/src/renderer/pages/ChatPanel.tsx — 会话面板（会话化重构 v3）。
 * - 项目（Agent）内独立会话：进入会话加载历史（sessions:load），消息按 session_id 落盘
 * - 会话内协作双入口：⑂ 自分裂（fork 新实例） / ⟳ A2A 传唤（<DELEGATE> 委派已有 Agent）
 * - "/" 指令面板（CLI 语义迁移）：/task /split /thinking /stats /agent /new ...
 * - 输入联想：≥1 字自动检索历史会话相似消息（点击填入）
 * - ＋ 展开栏：指令 / 技能 / MCP 工具 选择
 * - 会话级配置：💼 工作目录 + 审批模式；会话标题随时重命名
 */
import React, { type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import type { StreamChunk, ConversationMessage, SessionConfig, ApprovalMode, SuggestionItem, ExtrasList, AgentDetail, PermissionRequestUI, PermissionDecision, AskUserRequestUI, AskUserDecision } from "../../shared/ipc.js";
import Markdown from "./Markdown.js";
import { SendIcon, EditIcon, ChevronIcon, ThinkingIcon, PlusIcon, ForkIcon, LinkIcon, InternetIcon } from "../components/Icon.js";

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  time: string;
  /** 该条回复的推理/思考过程（assistant，Markdown） */
  reasoning?: string;
  /** 该条回复的耗时（毫秒，assistant 消息） */
  elapsedMs?: number;
}

interface ToolEvent {
  id: number;
  label: string;
}

interface ChatPanelProps {
  sessionId: string;
  sessionTitle: string;
  agentId: string;
  agentName?: string;
  modelChoice?: string;
  mode?: string;
  reasoningEffort?: string;
  /** 是否显示思考过程（f6：思考模式开关） */
  showThinking?: boolean;
  providerKeys?: string[];
  /** 供应商 → 已启用模型明细（聊天模型下拉列出所有启用的模型：api:<key>:<model>） */
  providerModels?: Array<{ key: string; models: Array<{ id: string; selected?: boolean }> }>;
  localModels?: Array<{ id: string; label: string }>;
  onModelChange?: (val: string) => void;
  onModeChange?: (val: string) => void;
  onReasoningChange?: (val: string) => void;
  onThinkingChange?: (val: boolean) => void;
  /** 会话列表变更通知（新对话/发送后刷新侧栏） */
  onConversationsChanged?: () => void;
  /** 会话重命名（工具栏 ✎） */
  onSessionRenamed?: (title: string) => void;
  /** 项目内新建会话请求（App 创建并切换） */
  onNewSessionRequested?: () => void;
  /** 跳转设置页子页（命令面板用） */
  onNavigateSettings?: (tab: "agents" | "providers" | "status") => void;
}

/** GUI 指令表（CLI 语义迁移） */
const COMMANDS: Array<{ cmd: string; desc: string; group: string; action: "delegate" | "fork" | "thinking" | "nav:status" | "nav:agents" | "nav:providers" | "new" | "rename" | "clear" | "help" }> = [
  { cmd: "/task", desc: "A2A 传唤已有 Agent 委派任务（结果整合回本会话）", group: "协作", action: "delegate" },
  { cmd: "/split", desc: "自分裂：创建子 Agent 实例多进程并行", group: "协作", action: "fork" },
  { cmd: "/thinking", desc: "切换推理强度：none / low / medium / high", group: "配置", action: "thinking" },
  { cmd: "/stats", desc: "打开状态面板（图表 + 表格）", group: "导航", action: "nav:status" },
  { cmd: "/agent", desc: "打开 Agent 管理", group: "导航", action: "nav:agents" },
  { cmd: "/providers", desc: "打开供应商设置", group: "导航", action: "nav:providers" },
  { cmd: "/new", desc: "项目内新建会话", group: "会话", action: "new" },
  { cmd: "/rename", desc: "重命名当前会话", group: "会话", action: "rename" },
  { cmd: "/clear", desc: "清空当前会话历史", group: "会话", action: "clear" },
  { cmd: "/help", desc: "显示全部指令", group: "会话", action: "help" },
];

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** ISO 时间戳 → HH:MM（本地时区；历史消息显示用，解析失败回退当前时间） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return nowTime(); }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 耗时显示：<1s → ms；≥1s → s */
function fmtMs(ms: number): string {
  if (ms < 1000) { return `${Math.round(ms)}ms`; }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 上下文消耗圆环（参考 A-C-C ContextRing）：绿 <60% / 黄 60-85% / 红 >85%，中心显示百分比 */
function ContextRing({ used, cap, loading }: { used: number; cap: number; loading: boolean }): JSX.Element {
  const ratio = cap > 0 ? Math.max(0, Math.min(1, used / cap)) : 0;
  const pct = Math.round(ratio * 100);
  const color = ratio < 0.6 ? "var(--success)" : ratio < 0.85 ? "var(--warning)" : "var(--danger)";
  const R = 15;
  const C = 2 * Math.PI * R;
  const filled = C * ratio;
  return (
    <div
      title={`上下文消耗: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct}%)`}
      style={{ position: "relative", width: 40, height: 40, flexShrink: 0, marginLeft: "auto" }}
    >
      <svg width={40} height={40} viewBox="0 0 40 40" style={{ display: "block" }}>
        <circle cx={20} cy={20} r={R} fill="none" stroke="var(--border)" strokeWidth={3.5} />
        {ratio > 0 && (
          <circle
            cx={20} cy={20} r={R} fill="none"
            stroke={color} strokeWidth={3.5} strokeLinecap="round"
            strokeDasharray={`${filled} ${C - filled}`}
            transform="rotate(-90 20 20)"
          />
        )}
      </svg>
      <span style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center",
        justifyContent: "center", fontSize: 9, fontWeight: 700, color: "var(--text)",
        pointerEvents: "none",
      }}>
        {loading ? "…" : `${pct}%`}
      </span>
    </div>
  );
}

/** 无框下拉选择器：统一向上/向下展开、fixed 定位不抖动、深色主题下拉（替代原生 select） */
interface GhostSelectOption {
  value: string;
  label: string;
  group?: string;
  /** 自定义 tooltip（省略时用 label） */
  title?: string;
}

interface GhostSelectProps {
  value: string;
  options: GhostSelectOption[];
  onChange: (value: string) => void;
  title?: string;
  style?: CSSProperties;
  maxWidth?: number;
}

/** 格式化显示模型名：去掉 api:<key>/<key>::/ 等冗余前缀，避免下拉里显示又长又重复的字符串
 *  显示层兜底：label 最多 MAX_LABEL 字符，完整 ID 通过 tooltip 展示
 */
function prettyModelLabel(rawId: string, providerKey?: string, maxLabel = 64): string {
  const base = (rawId ?? "").trim();
  if (!base) return "";
  let s = base;
  // ① 拆 "provider::/real_model_id" 格式（保存时错误拼接的全限定残留）
  const m1 = s.match(/^([^\s:\/]{1,64})::\/(.+)$/);
  if (m1) {
    if (!providerKey || m1[1] === providerKey) s = m1[2]; // 同组前缀直接去掉
    else s = m1[2]; // 跨组也只要本体，前缀信息 tooltip 保留
  }
  // ② 去掉 "provider_key:" 前缀
  if (providerKey && s.startsWith(`${providerKey}:`) && s.length > providerKey.length + 1) {
    s = s.slice(providerKey.length + 1);
  }
  // ③ 去重复双前缀（"公益模型公益模型"这种脏数据）
  if (s.length > 4 && s.length % 2 === 0) {
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
  }
  // ④ 统一最多展示 maxLabel 字符，超长 …
  return s.length > maxLabel ? `${s.slice(0, maxLabel)}…` : s;
}

function GhostSelect({ value, options, onChange, title, style, maxWidth = 260 }: GhostSelectProps): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  const grouped = React.useMemo(() => {
    const map = new Map<string, GhostSelectOption[]>();
    for (const o of options) {
      const g = o.group ?? "";
      if (!map.has(g)) { map.set(g, []); }
      map.get(g)!.push(o);
    }
    return Array.from(map.entries());
  }, [options]);

  // 先渲染菜单（visibility:hidden 防闪），useLayoutEffect 测实际宽高后按视口边界定位
  React.useLayoutEffect(() => {
    if (!open) { return; }
    const el = btnRef.current;
    const menu = menuRef.current;
    if (!el || !menu) { return; }
    const r = el.getBoundingClientRect();
    const mh = Math.min(menu.offsetHeight, 320); // 菜单最高 320px
    const mw = Math.max(r.width + 40, Math.min(menu.scrollWidth + 16, Math.max(maxWidth, 360)));
    const up = r.top >= mh + 8 || r.bottom + mh + 8 > window.innerHeight;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - mw - 8);
    }
    setPos(up
      ? { top: Math.max(8, r.top - mh + 4), left, width: mw, up: true }
      : { top: r.bottom + 4, left, width: mw, up: false });
  }, [open, maxWidth]);

  React.useEffect(() => {
    if (!open) { return; }
    const onDocDown = (e: MouseEvent): void => {
      if (btnRef.current?.contains(e.target as Node)) { return; }
      if (menuRef.current?.contains(e.target as Node)) { return; }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { setOpen(false); }
    };
    // 记录按钮初始位置，只有按钮位置明显变化时才关闭（position:fixed 下拉不受父容器滚动影响）
    const btnRect = btnRef.current?.getBoundingClientRect();
    const btnTop0 = btnRect?.top ?? 0;
    const btnLeft0 = btnRect?.left ?? 0;

    const onScroll = (e: Event): void => {
      // 滚动发生在下拉菜单内部 → 不关闭
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target)) { return; }
      // 按钮位置未明显变化（父容器滚动但 fixed 定位不受影响）→ 不关闭
      const cur = btnRef.current?.getBoundingClientRect();
      if (cur && Math.abs(cur.top - btnTop0) < 2 && Math.abs(cur.left - btnLeft0) < 2) { return; }
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="tool-select-ghost"
        title={title ?? current?.label ?? value}
        style={style}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="ghost-dropdown"
          data-up={pos?.up}
          style={pos
            ? { top: pos.top, left: pos.left, width: pos.width }
            : { visibility: "hidden", top: 0, left: 0 }}
        >
          {grouped.map(([group, items]) => (
            <React.Fragment key={group || "__ungrouped__"}>
              {group && <div className="ghost-dropdown-group-label">{group}</div>}
              {items.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  title={o.title ?? o.label}
                  className={`ghost-dropdown-item${o.value === value ? " active" : ""}`}
                  style={{ display: "block", width: "100%", textAlign: "left", boxSizing: "border-box" }}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  {o.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 用户消息（memo：流式输出时历史消息不重渲染） */
const UserMessage = React.memo(function UserMessage({ m }: { m: Message }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 14 }}>
      <div style={{
        maxWidth: "78%", padding: "10px 14px",
        borderRadius: "16px 16px 4px 16px",
        background: "var(--accent)", color: "#fff",
        lineHeight: 1.55, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {m.content}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{m.time}</div>
    </div>
  );
});

/** Agent 消息（memo：流式输出时历史消息不重渲染；折叠态变化时按需重渲染） */
const AssistantMessage = React.memo(function AssistantMessage({ m, agentName, showThinking, collapsed, onToggle }: {
  m: Message; agentName: string; showThinking: boolean; collapsed: boolean; onToggle: (id: number) => void;
}): JSX.Element {
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
      <div style={{
        width: 32, height: 32, borderRadius: "50%", flexShrink: 0, marginTop: 2,
        background: "var(--accent-soft)", color: "var(--accent)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 15, fontWeight: 700,
      }}>
        {agentName.charAt(0)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>{agentName}</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.time}</span>
        </div>
        {/* 回复耗时 + 思考展开符号（同一行；> 展开后旋转朝下） */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>
          <span>{m.elapsedMs != null ? `⏱ 回复耗时 ${fmtMs(m.elapsedMs)}` : "…"}</span>
          {showThinking && m.reasoning && (
            <button onClick={() => onToggle(m.id)}
              title={collapsed ? "展开思考过程" : "收起思考过程"}
              style={{
                background: "transparent", border: "none", cursor: "pointer", padding: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, borderRadius: "50%", color: "var(--accent-hover)",
              }}>
              <ChevronIcon size={14} rotate={collapsed ? 0 : 90} />
            </button>
          )}
        </div>
        {/* 思考内容：展开时纯文本（无气泡，与正文同风格） */}
        {showThinking && m.reasoning && !collapsed && (
          <div style={{ margin: "6px 0 2px", fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)", wordBreak: "break-word" }}>
            <Markdown text={m.reasoning} />
          </div>
        )}
        <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0 10px" }} />
        <div style={{ lineHeight: 1.7, fontSize: 14, color: "var(--text)", wordBreak: "break-word" }}>
          {m.content ? <Markdown text={m.content} /> : null}
        </div>
      </div>
    </div>
  );
});

export default function ChatPanel({
  sessionId,
  sessionTitle,
  agentId,
  agentName = "Agent",
  modelChoice = "inherit",
  mode = "build",
  reasoningEffort = "none",
  showThinking = true,
  providerKeys = [],
  providerModels = [],
  localModels = [],
  onModelChange,
  onModeChange,
  onReasoningChange,
  onThinkingChange,
  onConversationsChanged,
  onSessionRenamed,
  onNewSessionRequested,
  onNavigateSettings,
}: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  /** 流式正文渲染节流：数据实时累积到 ref，渲染按 50ms 批量，避免每 chunk 全量重解析 markdown 导致卡顿 */
  const partialRef = React.useRef("");
  const partialTimerRef = React.useRef<number | null>(null);
  const schedulePartialRender = React.useCallback(() => {
    if (partialTimerRef.current !== null) { return; }
    partialTimerRef.current = window.setTimeout(() => {
      partialTimerRef.current = null;
      setPartial(partialRef.current);
    }, 50);
  }, []);
  const resetPartial = React.useCallback(() => {
    if (partialTimerRef.current !== null) {
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    partialRef.current = "";
    setPartial("");
  }, []);
  /** f6：推理/思考过程内容（独立于正文字，输出中实时流式、完成后可主动展开查看） */
  const [reasoningTmp, setReasoningTmp] = React.useState("");
  const [reasoningOpen, setReasoningOpen] = React.useState(true);
  /** 推理过程读写走 ref，避免订阅 effect 因 chunk 高频重订阅 */
  const reasoningTmpRef = React.useRef("");
  const reasoningManuallyToggledRef = React.useRef(false);
  const [toolEvents, setToolEvents] = React.useState<ToolEvent[]>([]);
  const [lastTimings, setLastTimings] = React.useState<Record<string, number> | undefined>();
  /** 上下文消耗圆环：已用（done 的 promptTokens）/ 上限（Agent max_context） */
  const [ctxUsed, setCtxUsed] = React.useState(0);
  const [ctxCap, setCtxCap] = React.useState(0);
  const [sessionConfig, setSessionConfig] = React.useState<SessionConfig>({ approval: "auto", workspace: "" });
  const [renaming, setRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [coopOpen, setCoopOpen] = React.useState(false);
  const [coopTab, setCoopTab] = React.useState<"fork" | "delegate">("fork");
  const [splitName, setSplitName] = React.useState("");
  const [splitRole, setSplitRole] = React.useState("");
  const [splitBusy, setSplitBusy] = React.useState(false);
  const [delegateAgentId, setDelegateAgentId] = React.useState("");
  const [delegateTask, setDelegateTask] = React.useState("");
  const [allAgents, setAllAgents] = React.useState<Array<{ id: string; name: string; role: string }>>([]);
  // 指令面板 + 联想 + 加号栏
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [cmdFilter, setCmdFilter] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<SuggestionItem[]>([]);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [extras, setExtras] = React.useState<ExtrasList | null>(null);
  /** 联网搜索开关：默认关（灰色），勾选后变绿色，未启用时 web_search/web_fetch 被静默拒绝 */
  const [networkEnabled, setNetworkEnabled] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const eventIdRef = React.useRef(0);
  /** 消息自增 id（稳定键 + 折叠态索引） */
  const msgIdRef = React.useRef(0);
  /** 已完成消息的推理块折叠态：true=折叠（默认） */
  const [collapsedReasoning, setCollapsedReasoning] = React.useState<Record<number, boolean>>({});

  /** ── 输入框内嵌权限请求（替代系统弹窗）：请求到达时输入框切换为选择题 UI ── */
  const [pendingPerm, setPendingPerm] = React.useState<PermissionRequestUI | null>(null);
  /** 实时同步当前请求 id（超时监听闭包只建一次，靠 ref 拿到最新值） */
  const pendingPermRef = React.useRef<PermissionRequestUI | null>(null);
  React.useEffect(() => { pendingPermRef.current = pendingPerm; }, [pendingPerm]);
  /** 用户已选中的选项 id（"custom" 时显示自填输入框） */
  const [permOption, setPermOption] = React.useState<string>("allow-once");
  /** "custom" 选项的自填内容 */
  const [permCustom, setPermCustom] = React.useState("");
  /** 决策提交中（防重复点击） */
  const [permSubmitting, setPermSubmitting] = React.useState(false);

  /** ── 输入框内嵌 ask_user 提问（方向分歧 / 关键决策；与权限请求同形态）── */
  const [pendingAsk, setPendingAsk] = React.useState<AskUserRequestUI | null>(null);
  const pendingAskRef = React.useRef<AskUserRequestUI | null>(null);
  React.useEffect(() => { pendingAskRef.current = pendingAsk; }, [pendingAsk]);
  /** 用户选中的选项文本（"__custom" 时显示自填输入框） */
  const [askOption, setAskOption] = React.useState<string>("__custom");
  /** 自填内容 */
  const [askCustom, setAskCustom] = React.useState("");
  /** 回答提交中（防重复点击） */
  const [askSubmitting, setAskSubmitting] = React.useState(false);

  /** 订阅主进程权限请求：输入框位置弹出选择题，请求结束自动恢复输入框 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.perm?.onRequest) { return; }
    const off = api.perm.onRequest((req: PermissionRequestUI) => {
      setPendingPerm(req);
      setPermOption(req.options[0]?.id ?? "allow-once");
      setPermCustom("");
      setPermSubmitting(false);
    });
    // 主进程超时兜底（未收到决策已按拒绝处理）→ 收起选择题 UI，避免一直挂着
    const offTimeout = api.perm.onTimeout?.((req: { requestId: string }) => {
      if (pendingPermRef.current && pendingPermRef.current.requestId === req.requestId) {
        setPendingPerm(null);
        setPermSubmitting(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    });
    return () => { off(); offTimeout?.(); };
  }, []);

  /** 提交用户对权限请求的决策（选择题选项 → PermissionDecision） */
  async function resolvePerm(opt: string, custom?: string): Promise<void> {
    if (!pendingPerm || permSubmitting) { return; }
    setPermSubmitting(true);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    let decision: PermissionDecision;
    if (opt === "deny") {
      decision = { requestId: pendingPerm.requestId, approved: false, reason: "用户拒绝授权", alwaysAllow: false };
    } else if (opt === "custom") {
      const text = (custom ?? "").trim();
      // 自填指示：非空且不以"拒绝"开头视为批准（附指示），以"拒绝"开头视为拒绝（附原因）
      decision = {
        requestId: pendingPerm.requestId,
        approved: !/^拒绝/.test(text),
        reason: text || "用户自定义指示",
        alwaysAllow: false,
      };
    } else {
      decision = {
        requestId: pendingPerm.requestId,
        approved: true,
        reason: opt === "allow-session" ? "本次会话总是允许" : "用户允许本次",
        alwaysAllow: opt === "allow-session",
      };
    }
    try {
      await api.perm.resolve(decision);
    } finally {
      setPendingPerm(null);
      setPermSubmitting(false);
      // 权限申请结束，焦点还给输入框
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  /** 订阅主进程 ask_user 提问：输入框位置弹出选择题，回答后自动恢复输入框 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.askUser?.onRequest) { return; }
    const off = api.askUser.onRequest((req: AskUserRequestUI) => {
      setPendingAsk(req);
      setAskOption(req.options.length > 0 ? req.options[0] : "__custom");
      setAskCustom("");
      setAskSubmitting(false);
    });
    // 主进程超时兜底（未收到回答已按「跳过」处理）→ 收起提问 UI
    const offTimeout = api.askUser.onTimeout?.((req: { requestId: string }) => {
      if (pendingAskRef.current && pendingAskRef.current.requestId === req.requestId) {
        setPendingAsk(null);
        setAskSubmitting(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    });
    return () => { off(); offTimeout?.(); };
  }, []);

  /** 提交用户对 ask_user 的回答（选项/自填 → AskUserDecision） */
  async function resolveAsk(choice: string, custom?: string): Promise<void> {
    if (!pendingAsk || askSubmitting) { return; }
    setAskSubmitting(true);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const text = choice === "__custom" ? (custom ?? "").trim() : choice;
    const decision: AskUserDecision = {
      requestId: pendingAsk.requestId,
      answer: text || "（未填写）",
      skipped: false,
    };
    try {
      await api.askUser.resolve(decision);
    } finally {
      setPendingAsk(null);
      setAskSubmitting(false);
      // 提问结束，焦点还给输入框
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  const makeMessage = React.useCallback((role: "user" | "assistant", content: string, extra?: Partial<Message>): Message => ({
    id: ++msgIdRef.current,
    role,
    content,
    time: nowTime(),
    ...extra,
  }), []);

  /** 切换会话：加载历史 + 会话配置 + 已有 Agent 列表（A2A 传唤候选） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    setMessages([]);
    resetPartial();
    setReasoningTmp("");
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    setCollapsedReasoning({});
    setToolEvents([]);
    setLastTimings(undefined);
    setSuggestions([]);
    setAtBottom(true);
    // 切会话：上下文 token 占用重置（历史消息的 token 无法精确估算，
    // 所以环上只累计"当前会话窗口内发送消息后得到的实际 tokens"，每次 done 累加）
    setCtxUsed(0);
    void api.conversations.load(sessionId).then((msgs: ConversationMessage[]) => {
      setMessages(msgs.map((m) => makeMessage(m.role, m.content, { time: fmtTime(m.time), reasoning: m.reasoning, elapsedMs: m.elapsedMs })));
    }).catch(console.error);
    void api.conversations.configGet(agentId).then(setSessionConfig).catch(() => undefined);
    void api.agents.list().then((list: Array<{ id: string; name: string; role: string }>) => {
      setAllAgents(list.filter((a) => a.id !== agentId));
    }).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentId, makeMessage]);

  /** 上下文圆环上限：随 agentId 拉取 Agent 的 max_context（无配置时 cap=0 → 圆环仅显示 0%） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.agents?.detail) { return; }
    void api.agents.detail(agentId).then((d: AgentDetail | null) => {
      setCtxCap(d?.max_context ?? 0);
    }).catch(() => setCtxCap(0));
  }, [agentId]);

  /** P0: 随 agentId 重新订阅（切会话时切换事件源） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const off1 = api.chat.onChunk((c: StreamChunk) => {
      if (c.type === "tool" && c.data?.name) {
        const label = c.data.name.startsWith("delegate:")
          ? `⟳ 传唤子 Agent「${c.data.name.slice(9)}」`
          : `⟳ ${c.data.name}`;
        setToolEvents((prev) => [...prev, { id: ++eventIdRef.current, label }]);
        return;
      }
      if (c.type === "reasoning") {
        reasoningTmpRef.current += c.data?.content ?? "";
        setReasoningTmp(reasoningTmpRef.current);
        return;
      }
      partialRef.current += c.data?.content ?? "";
      schedulePartialRender();
    });
    const off2 = api.chat.onDone((m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean }) => {
      const reasoning = reasoningTmpRef.current;
      const manuallyToggled = reasoningManuallyToggledRef.current;
      setMessages((prev) => [
        ...prev,
        makeMessage(
          "assistant",
          m.interrupted && !/\n\[已中断\]\s*$/.test(m.reply) ? `${m.reply}\n\n> ⏹ 已中断（停止生成）` : m.reply,
          { reasoning: reasoning || undefined, elapsedMs: m.elapsedMs },
        ),
      ]);
      // 完成后思考自动折叠（用户手动展开过则不覆盖）
      if (reasoning && !manuallyToggled) {
        setCollapsedReasoning((prev) => ({ ...prev, [msgIdRef.current]: true }));
      }
      resetPartial();
      setReasoningTmp("");
      reasoningTmpRef.current = "";
      setReasoningOpen(false);
      reasoningManuallyToggledRef.current = false;
      setToolEvents([]);
      setLoading(false);
      setStopping(false);
      if (m.timings) setLastTimings(m.timings);
      // ContextRing：累计当前会话内所有 done 事件的 prompt + completion + reasoning + cache-read
      // （之前只取最后一次的 promptTokens，导致环几乎不动；现在每次累加就会随着聊天稳步增长）
      if (typeof m.timings?.promptTokens === "number" || typeof m.timings?.completionTokens === "number" || typeof m.timings?.reasoningTokens === "number" || typeof m.timings?.cacheReadTokens === "number") {
        const delta =
          (typeof m.timings!.promptTokens === "number" ? m.timings!.promptTokens : 0) +
          (typeof m.timings!.completionTokens === "number" ? m.timings!.completionTokens : 0) +
          (typeof m.timings!.reasoningTokens === "number" ? m.timings!.reasoningTokens : 0) +
          (typeof m.timings!.cacheReadTokens === "number" ? m.timings!.cacheReadTokens : 0);
        if (delta > 0) {
          setCtxUsed((prev) => prev + delta);
        }
      }
      onConversationsChanged?.();
    });
    const off3 = api.chat.onError((e: { message: string }) => {
      console.error("[chat] error:", e.message);
      setLoading(false);
      setStopping(false);
      resetPartial();
      setReasoningTmp("");
      reasoningTmpRef.current = "";
      setToolEvents([]);
    });
    return () => { off1(); off2(); off3(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, makeMessage]);

  /** 判断是否处于底部（阈值 48px 内视为底部） */
  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) { return; }
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }

  /** 准星回底：跳回最新消息并恢复自动追踪 */
  function jumpToLatest(): void {
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; }
    setAtBottom(true);
  }

  /** 自动追踪：仅在用户位于底部时跟随最新输出（上滑即暂停，回底自动恢复） */
  React.useEffect(() => {
    if (!atBottom) { return; }
    const el = scrollRef.current;
    if (el) { el.scrollTop = el.scrollHeight; }
  }, [messages, partial, toolEvents, reasoningTmp, atBottom]);

  /** 自动增高输入框（上限 120px） */
  function autoResize(): void {
    const ta = inputRef.current;
    if (!ta) { return; }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }

  /** 输入联想：≥1 字防抖检索历史会话 */
  React.useEffect(() => {
    if (!input.trim() || input.startsWith("/") || loading) {
      setSuggestions([]);
      return;
    }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const timer = window.setTimeout(() => {
      void api.suggest(input.trim()).then((items: SuggestionItem[]) => {
        setSuggestions(items);
      }).catch(() => setSuggestions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [input, loading]);

  /** 指令面板："/" 开头时过滤显示 */
  const cmdList = React.useMemo(() => {
    if (!cmdOpen) { return []; }
    const q = cmdFilter.trim();
    if (!q) { return COMMANDS; }
    return COMMANDS.filter((c) => c.cmd.startsWith(q.toLowerCase()));
  }, [cmdOpen, cmdFilter]);

  function runCommand(c: (typeof COMMANDS)[number]): void {
    setCmdOpen(false);
    setInput("");
    setCmdFilter("");
    switch (c.action) {
      case "delegate":
        setCoopTab("delegate");
        setCoopOpen(true);
        break;
      case "fork":
        setCoopTab("fork");
        setCoopOpen(true);
        break;
      case "thinking": {
        const order = ["none", "low", "medium", "high"];
        const next = order[(order.indexOf(reasoningEffort) + 1) % order.length];
        onReasoningChange?.(next);
        break;
      }
      case "nav:status":
        onNavigateSettings?.("status");
        break;
      case "nav:agents":
        onNavigateSettings?.("agents");
        break;
      case "nav:providers":
        onNavigateSettings?.("providers");
        break;
      case "new":
        onNewSessionRequested?.();
        break;
      case "rename":
        setRenameDraft(sessionTitle);
        setRenaming(true);
        break;
      case "clear":
        void handleClearConversation();
        break;
      case "help":
        setCmdOpen(true);
        setCmdFilter("");
        break;
    }
  }

  /** 清空当前会话历史 */
  async function handleClearConversation(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    if (!window.confirm(`清空会话「${sessionTitle}」的历史？会话本身保留。`)) { return; }
    await api.conversations.clear(sessionId).catch(console.error);
    setMessages([]);
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setToolEvents([]);
    onConversationsChanged?.();
  }

  /** ＋ 栏：拉取技能/MCP 列表 */
  async function openPlusPanel(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    setPlusOpen((prev) => {
      const next = !prev;
      if (next && !extras) {
        void api.extras.list().then((e: ExtrasList) => setExtras(e)).catch(console.error);
      }
      return next;
    });
  }

  async function send(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !input.trim()) { return; }
    const text = input.trim();
    setMessages((prev) => [...prev, makeMessage("user", text)]);
    setInput("");
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    reasoningManuallyToggledRef.current = false;
    setToolEvents([]);
    setSuggestions([]);
    setLoading(true);
    setStopping(false);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.focus();
    }
    void api.chat.stream({ agentId, message: text, sessionId, networkEnabled });
  }

  /** 主动中断当前 Agent 输出（底层 abort + 保留已生成部分） */
  async function stopGeneration(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !loading || stopping) { return; }
    setStopping(true);
    const res = await api.chat.cancel(sessionId).catch((e: unknown) => {
      console.error("[chat] cancel failed:", e);
      return { ok: false };
    });
    // 底层中断后仍会流入 onDone 收尾；这里兜底：若取消失败则直接复位 UI
    if (!res?.ok) {
      setLoading(false);
      setStopping(false);
    }
  }

  async function handleRetry(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || messages.length === 0) { return; }
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") { lastAiIdx = i; break; }
    }
    if (lastAiIdx < 0) { return; }
    const before = messages.slice(0, lastAiIdx);
    setMessages(before);
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    reasoningManuallyToggledRef.current = false;
    setLoading(true);
    const result = await api.chat.retryLast(agentId, sessionId);
    if (result.error) {
      console.error("[chat] retry failed:", result.error);
      setLoading(false);
    }
  }

  /** 会话级配置：工作目录 / 审批模式（项目 = Agent 级设定） */
  async function setSessionConfigField(patch: { approval?: ApprovalMode; workspace?: string | null }): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.config({ agentId, ...patch }).catch((e: unknown) => {
      console.error("[chat] session config failed:", e);
      return null;
    });
    if (res?.ok) {
      setSessionConfig({ approval: res.approval, workspace: res.workspace });
    }
  }

  async function handlePickFolder(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.pickFolder();
    if (res.ok && res.path) {
      await setSessionConfigField({ workspace: res.path });
    }
  }

  async function handleFork(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !splitName.trim()) { return; }
    setSplitBusy(true);
    try {
      const child = await api.agents.fork(agentId, splitName.trim(), splitRole.trim());
      console.info(`[chat] 自分裂完成：新实例「${child.name}」可并行工作（fork 深度上限 2）`);
      setCoopOpen(false);
      setSplitName("");
      setSplitRole("");
      onConversationsChanged?.();
    } catch (e) {
      console.error("[chat] fork failed:", e);
    } finally {
      setSplitBusy(false);
    }
  }

  /** 刷新传唤候选 Agent 列表（新建/导入 Agent 后无需重开会话也能被检测到） */
  function refreshDelegates(): void {
    const w = window as unknown as { slimeAPI?: any };
    const api = w.slimeAPI;
    if (!api?.agents) { return; }
    void api.agents.list().then((list: Array<{ id: string; name: string; role: string }>) => {
      setAllAgents(list.filter((a) => a.id !== agentId));
    }).catch(console.error);
  }

  /** 打开协作面板：先刷新传唤候选（此前只在切会话时加载，新建 Agent 检测不到） */
  function openCoop(): void {
    setCoopTab("fork");
    setCoopOpen(true);
    refreshDelegates();
  }

  /** A2A 传唤：注入 <DELEGATE> 消息发送（主 Agent 路由委派给已有 Agent，/task 语义） */
  function handleDelegate(): void {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !delegateAgentId) { return; }
    const target = allAgents.find((a) => a.id === delegateAgentId);
    if (!target) { return; }
    const task = delegateTask.trim();
    const delegateMsg = `<DELEGATE name="${target.name}">${task || "请协助完成当前任务"}</DELEGATE>`;
    setCoopOpen(false);
    setDelegateTask("");
    setDelegateAgentId("");
    setMessages((prev) => [...prev, makeMessage("user", `⟳ 传唤「${target.name}」：${task || "请协助完成当前任务"}`)]);
    setInput("");
    resetPartial();
    setReasoningTmp("");
    reasoningTmpRef.current = "";
    setReasoningOpen(true);
    reasoningManuallyToggledRef.current = false;
    reasoningManuallyToggledRef.current = false;
    setToolEvents([]);
    setLoading(true);
    void api.chat.stream({ agentId, message: delegateMsg, sessionId, networkEnabled });
  }

  /** 展开/折叠某条已完成消息的思考块（默认折叠） */
  function toggleReasoning(id: number): void {
    setCollapsedReasoning((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  }

  /** ＋ 气泡：选择文件 → 以附件占位注入输入框（图片/文档路径引用，待补充指令后发送） */
  async function handleImportFile(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.files) { return; }
    const res = await api.files.pick().catch((e: unknown) => {
      console.error("[chat] pick file failed:", e);
      return null;
    });
    if (!res?.ok || !res.path) { return; }
    const name = res.path.split(/[\\/]/).pop() ?? res.path;
    setInput((prev) => {
      const base = prev.trimEnd();
      return `${base ? base + " " : ""}📎[${name}]`;
    });
    setPlusOpen(false);
    setSuggestions([]);
    inputRef.current?.focus();
  }

  const canRetry = messages.length > 0 && !loading;
  const filteredCmd = cmdList;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative", overflow: "hidden" }}>
      {/* 顶部工具栏：会话组 | 思考开关 | 工作目录 | 计时 | 上下文圆环（模型/模式/审批/推理已移入输入框） */}
      <div className="glass-bar" style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "8px 12px", background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border)", flexWrap: "wrap",
      }}>
        {renaming ? (
          <input
            className="input-field" autoFocus
            style={{ fontSize: 12.5, padding: "3px 10px", width: 200 }}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSessionRenamed?.(renameDraft.trim());
                setRenaming(false);
              }
              if (e.key === "Escape") { setRenaming(false); }
            }}
            onBlur={() => {
              onSessionRenamed?.(renameDraft.trim());
              setRenaming(false);
            }}
          />
        ) : (
          <span style={{
            color: "var(--text)", fontSize: 13, fontWeight: 600,
            padding: "4px 12px", borderRadius: "12px",
            background: "var(--accent-soft)",
            display: "flex", alignItems: "center", gap: 6, maxWidth: 260,
          }}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {agentName} / {sessionTitle}
            </span>
            <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.7 }}
              title="重命名会话"
              onClick={() => { setRenameDraft(sessionTitle); setRenaming(true); }}>
              <EditIcon size={14} />
            </button>
          </span>
        )}
        <button onClick={() => onNewSessionRequested?.()} disabled={loading}
          className="btn" title="项目内新建会话">
          新会话
        </button>
        <button onClick={handleRetry} disabled={!canRetry}
          className="btn primary" title="重试上一条（重发最后一条用户消息）">
          重试
        </button>
        <button onClick={openCoop} disabled={loading}
          className="btn" title="自分裂：创建子 Agent 实例多进程并行工作（fork 深度上限 2）">
          <ForkIcon size={14} /> 自分裂
        </button>
        <button onClick={() => { setCoopTab("delegate"); setCoopOpen(true); refreshDelegates(); }} disabled={loading}
          className="btn" title="A2A 传唤：选择已有 Agent 委派任务（/task 语义），结果整合回本会话">
          <LinkIcon size={14} /> 传唤
        </button>
        <button onClick={() => {
          const nextThinking = !showThinking;
          onThinkingChange?.(nextThinking);
          // 开启思考显示且当前推理强度为 none 时，自动抬升到 low，确保模型真的产出思考内容
          if (nextThinking && (!reasoningEffort || reasoningEffort === "none")) {
            onReasoningChange?.("low");
          }
        }}
          title="思考显示：开启时请求并展示 Agent 的思考过程（未开启推理时自动设为低，输出时展开、完成后自动折叠，可手动展开/折叠）"
          style={{
            height: 26, padding: "0 10px", borderRadius: 13,
            border: `1px solid ${showThinking ? "var(--accent)" : "var(--border)"}`,
            background: showThinking ? "var(--accent-soft)" : "transparent",
            color: showThinking ? "var(--accent-hover)" : "var(--text-muted)",
            fontSize: 12, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 5,
          }}>
          <ThinkingIcon size={16} />
          思考: {showThinking ? "开" : "关"}
        </button>
        <span style={{ color: "var(--text-dim)", margin: "0 4px" }}>|</span>
        <button onClick={handlePickFolder}
          className="btn" title={`工作目录：${sessionConfig.workspace || "未设置（不限制读写范围）"}`}
          style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sessionConfig.workspace || "选择工作目录"}
        </button>
        {lastTimings && lastTimings.elapsedMs && (
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {lastTimings.elapsedMs}ms
            {lastTimings.promptTokens && ` · ${lastTimings.promptTokens}+${lastTimings.completionTokens ?? 0}tok`}
          </span>
        )}
        <ContextRing used={ctxUsed} cap={ctxCap} loading={loading} />
      </div>

      {/* 消息区域：卡片化 + 事件行 */}
      <div ref={scrollRef} onScroll={handleScroll}
        style={{ flex: 1, overflowY: "auto", padding: "14px 16px 0", position: "relative" }}>
        {messages.length === 0 && !loading && (
          <div style={{ color: "var(--text-dim)", textAlign: "center", marginTop: 48, fontSize: 13 }}>
            与 {agentName} 的会话「{sessionTitle}」
            {sessionConfig.workspace && (
              <div style={{ fontSize: 12, marginTop: 6 }}>
                工作目录：{sessionConfig.workspace}
              </div>
            )}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user"
            ? <UserMessage key={m.id} m={m} />
            : (
              <AssistantMessage
                key={m.id}
                m={m}
                agentName={agentName}
                showThinking={showThinking}
                collapsed={collapsedReasoning[m.id] ?? true}
                onToggle={toggleReasoning}
              />
            )
        )}
        {loading && (
          <div style={{ display: "flex", gap: 10, marginBottom: 14, opacity: 0.95 }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
              background: "var(--accent-soft)", color: "var(--accent)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 15, fontWeight: 700,
            }}>
              {agentName.charAt(0)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* 状态行：Agent 名称 + 活动指示 */}
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span>{agentName}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--text-dim)" }}>
                  <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: "pulse 1.5s ease-in-out infinite" }} />
                  {toolEvents.length > 0 ? "调用工具中" : "思考中"}
                </span>
              </div>

              {/* 工具调用卡片：可折叠，显示摘要和列表 */}
              {toolEvents.length > 0 && (
                <div style={{
                  background: "var(--surface-hover, rgba(255,255,255,0.04))",
                  border: "1px solid var(--border, rgba(255,255,255,0.08))",
                  borderRadius: 8, marginBottom: 6, overflow: "hidden",
                }}>
                  {/* 卡片头部：摘要 + 展开/收起 */}
                  <button
                    onClick={() => setReasoningOpen((v) => !v)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "6px 10px", background: "transparent", border: "none", cursor: "pointer",
                      color: "var(--text-secondary)", fontSize: 12, textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13 }}>🔧</span>
                      <span>调用了 {toolEvents.length} 个工具</span>
                    </span>
                    <ChevronIcon size={14} rotate={reasoningOpen ? 90 : 0} />
                  </button>
                  {/* 工具列表：展开时显示 */}
                  {reasoningOpen && (
                    <div style={{ padding: "4px 10px 8px", display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {toolEvents.map((t) => (
                        <span key={t.id} style={{
                          fontSize: 11, color: "var(--accent-hover)",
                          background: "var(--accent-soft, rgba(99,179,237,0.15))",
                          border: "1px solid var(--accent-border, rgba(99,179,237,0.3))",
                          padding: "2px 8px", borderRadius: 10,
                          display: "inline-flex", alignItems: "center", gap: 4,
                        }}>
                          <span style={{ opacity: 0.7 }}>⟳</span>
                          {t.label.replace(/^⟳\s*/, "")}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 思考过程卡片：可折叠，显示预览 */}
              {showThinking && reasoningTmp && (
                <div style={{
                  background: "var(--surface-hover, rgba(255,255,255,0.04))",
                  border: "1px solid var(--border, rgba(255,255,255,0.08))",
                  borderRadius: 8, marginBottom: 6, overflow: "hidden",
                }}>
                  <button
                    onClick={() => setReasoningOpen((v) => !v)}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "6px 10px", background: "transparent", border: "none", cursor: "pointer",
                      color: "var(--text-secondary)", fontSize: 12, textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13 }}>🧠</span>
                      <span>思考过程</span>
                      {!reasoningOpen && (
                        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 4 }}>
                          · {reasoningTmp.slice(0, 60)}{reasoningTmp.length > 60 ? "…" : ""}
                        </span>
                      )}
                    </span>
                    <ChevronIcon size={14} rotate={reasoningOpen ? 90 : 0} />
                  </button>
                  {reasoningOpen && (
                    <div style={{
                      padding: "6px 10px 10px", fontSize: 13, lineHeight: 1.6,
                      color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>
                      {reasoningTmp}
                      <span style={{ display: "inline-block", width: 8, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "text-bottom", animation: "blink 1s step-start infinite" }} />
                    </div>
                  )}
                </div>
              )}

              <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0 10px" }} />
              {/* 部分输出：流式 Markdown 渲染（补全未闭合语法，避免暴露原始符号） */}
              <div style={{ lineHeight: 1.7, fontSize: 14, color: "var(--text)", wordBreak: "break-word" }}>
                {partial ? <Markdown text={partial} streaming /> : "⌛"}
                {partial && <span style={{ display: "inline-block", width: 8, height: 16, background: "var(--accent)", marginLeft: 2, verticalAlign: "text-bottom", animation: "blink 1s step-start infinite" }} />}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 回到最新按钮：不在最新处时固定显示在输入框上方居中（醒目，不随滚动移动） */}
      {!atBottom && (
        <button onClick={jumpToLatest}
          title="回到最新消息（恢复自动追踪）"
          style={{
            position: "absolute", left: "50%", transform: "translateX(-50%)",
            bottom: 74, zIndex: 40,
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 20px", borderRadius: 24,
            border: "1px solid var(--accent)",
            background: "linear-gradient(135deg, var(--accent), #6366f1)",
            color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
            boxShadow: "0 6px 22px rgba(56,189,248,0.45)",
            transition: "transform 0.15s ease, box-shadow 0.15s ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = "translateX(-50%) scale(1.06)"; e.currentTarget.style.boxShadow = "0 8px 28px rgba(56,189,248,0.6)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = "translateX(-50%)"; e.currentTarget.style.boxShadow = "0 6px 22px rgba(56,189,248,0.45)"; }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>⌖</span>
          回到最新
        </button>
      )}

      {/* 输入区：圆角容器 + 自动增高 + 联想 + 指令面板 + 加号栏 */}
      <div style={{ padding: "10px 16px 12px", borderTop: "1px solid var(--border)", background: "var(--bg)", position: "relative", zIndex: 30 }}>
        {/* 输入联想（历史会话相似消息） */}
        {suggestions.length > 0 && !loading && (
          <div style={{
            position: "absolute", bottom: "100%", left: 16, right: 16, marginBottom: 4,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 40,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "6px 12px 2px" }}>
              历史会话联想
            </div>
            {suggestions.map((s, i) => (
              <button key={i}
                onClick={() => { setInput(s.content); setSuggestions([]); inputRef.current?.focus(); }}
                style={{
                  display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                  padding: "6px 12px", border: "none", background: "transparent",
                  fontSize: 12.5, color: "var(--text)", lineHeight: 1.5,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ color: "var(--accent-hover)", fontWeight: 600, marginRight: 6 }}>{s.agentName}</span>
                {s.content}
              </button>
            ))}
          </div>
        )}

        {/* 指令面板（"/" 开头） */}
        {cmdOpen && filteredCmd.length > 0 && (
          <div style={{
            position: "absolute", bottom: "100%", left: 16, right: 16, marginBottom: 4,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            zIndex: 40, maxHeight: 300, overflowY: "auto",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "6px 12px 2px" }}>
              指令（{filteredCmd.length}）— 输入 / 继续过滤，点击执行
            </div>
            {filteredCmd.map((c) => (
              <button key={c.cmd}
                onClick={() => runCommand(c)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  padding: "6px 12px", border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 12.5, color: "var(--text)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ color: "var(--accent-hover)", fontWeight: 700, minWidth: 62 }}>{c.cmd}</span>
                <span style={{ color: "var(--text-muted)", fontSize: 11, minWidth: 34 }}>{c.group}</span>
                <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ＋ 弹窗气泡：指向左侧 ＋ 按钮，选技能 / MCP / 导入文件 */}
        {plusOpen && (
          <div style={{
            position: "absolute", bottom: "100%", left: 14, marginBottom: 10, width: 312,
            background: "var(--bg-input)", border: "1px solid var(--border-hover)",
            borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,0.42)",
            zIndex: 50, overflow: "hidden",
          }}>
            {/* 指向 ＋ 的小三角 */}
            <div style={{
              position: "absolute", bottom: -6, left: 18, width: 12, height: 12,
              background: "var(--bg-input)",
              borderLeft: "1px solid var(--border-hover)", borderBottom: "1px solid var(--border-hover)",
              transform: "rotate(-45deg)",
            }} />
            <div style={{ display: "flex", alignItems: "center", padding: "8px 12px" }}>
              <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)" }}>
                添加内容
              </span>
              <button className="titlebar-btn" onClick={() => setPlusOpen(false)}>✕</button>
            </div>
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                技能（{(extras?.skills ?? []).length}）
              </div>
              {(extras?.skills ?? []).length === 0 && (
                <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-dim)" }}>无已加载技能（设置 → 技能库可管理）</div>
              )}
              {(extras?.skills ?? []).map((s) => (
                <button key={s.name}
                  onClick={() => { setInput(`请使用技能「${s.name}」：`); setPlusOpen(false); inputRef.current?.focus(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "5px 12px", border: "none", background: "transparent", cursor: "pointer",
                    fontSize: 12.5, color: "var(--text)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ color: "var(--success)", fontWeight: 700, minWidth: 62, overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                  <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.description || "（无描述）"}</span>
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                MCP 工具（{(extras?.mcpTools ?? []).length}）
              </div>
              {(extras?.mcpTools ?? []).length === 0 && (
                <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-dim)" }}>无已连接 MCP 工具（设置 → MCP 接入可管理）</div>
              )}
              {(extras?.mcpTools ?? []).map((t) => (
                <button key={t.name}
                  onClick={() => { setInput(`请使用 MCP 工具「${t.name}」：`); setPlusOpen(false); inputRef.current?.focus(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "5px 12px", border: "none", background: "transparent", cursor: "pointer",
                    fontSize: 12.5, color: "var(--text)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ color: "var(--warning)", fontWeight: 700, minWidth: 62, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                  <span style={{ flex: 1, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.description || "（无描述）"}</span>
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                文件
              </div>
              <button onClick={() => void handleImportFile()}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  padding: "7px 12px", border: "none", background: "transparent", cursor: "pointer",
                  fontSize: 12.5, color: "var(--text)",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <span style={{ flex: 1 }}>导入图片 / 文档</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>本地文件</span>
              </button>
            </div>
          </div>
        )}

        <div className="glass-input" style={{
          borderRadius: 18, border: "1px solid var(--border-hover)",
          background: "var(--bg-input)", overflow: "hidden",
        }}>
          {pendingAsk ? (
            /* ── ask_user 提问：方向分歧 / 关键决策 → 输入框位置选择题（含「其他」自填）── */
            <div style={{ padding: "14px 16px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--accent-hover)" }}>❓ Agent 提问</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent-hover)" }}>{pendingAsk.agentName || "Agent"}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>需要你做出抉择</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => void resolveAsk("", "（跳过）")}
                  disabled={askSubmitting}
                  title="跳过本次提问（让 Agent 自行判断）"
                  style={{
                    width: 26, height: 26, borderRadius: "50%", border: "1px solid var(--border)",
                    background: "transparent", color: "var(--text-muted)", fontSize: 13,
                    cursor: askSubmitting ? "not-allowed" : "pointer", lineHeight: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.12s, color 0.12s, transform 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--danger)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.9)"; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>✕</button>
              </div>
              {/* 问题正文 */}
              <div style={{
                fontSize: 12.5, color: "var(--text)", background: "var(--bg-hover)",
                borderRadius: 10, padding: "8px 12px", marginBottom: 10, whiteSpace: "pre-wrap",
              }}>
                {pendingAsk.question}
              </div>
              {/* 建议选项（点击即选择；选中后高亮） */}
              {pendingAsk.options.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                  {pendingAsk.options.map((o, i) => (
                    <button
                      key={`${o}-${i}`}
                      onClick={() => setAskOption(o)}
                      disabled={askSubmitting}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 6,
                        textAlign: "left", padding: "8px 12px", borderRadius: 10, width: "100%",
                        border: askOption === o ? "1px solid var(--accent)" : "1px solid var(--border)",
                        background: askOption === o ? "var(--bg-hover)" : "transparent",
                        cursor: askSubmitting ? "not-allowed" : "pointer",
                        transition: "border-color 0.12s, background 0.12s, transform 0.08s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = askOption === o ? "var(--bg-hover)" : "transparent"; }}
                      onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
                      onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
                        {askOption === o ? "◉ " : "○ "}{o}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {/* 其他：自填需求 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  onClick={() => setAskOption("__custom")}
                  disabled={askSubmitting}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 6,
                    textAlign: "left", padding: "8px 12px", borderRadius: 10, width: "100%",
                    border: askOption === "__custom" ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: askOption === "__custom" ? "var(--bg-hover)" : "transparent",
                    cursor: askSubmitting ? "not-allowed" : "pointer",
                    transition: "border-color 0.12s, background 0.12s, transform 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = askOption === "__custom" ? "var(--bg-hover)" : "transparent"; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
                    {askOption === "__custom" ? "◉ " : "○ "}其他（自定义）
                  </span>
                </button>
                {askOption === "__custom" && (
                  <input
                    autoFocus
                    value={askCustom}
                    onChange={(e) => setAskCustom(e.target.value)}
                    placeholder="输入你的需求…"
                    onKeyDown={(e) => { if (e.key === "Enter") { void resolveAsk("__custom", askCustom); } }}
                    style={{
                      width: "100%", padding: "8px 12px", borderRadius: 10,
                      border: "1px solid var(--border)", background: "var(--bg-input)",
                      color: "var(--text)", fontSize: 12.5, outline: "none",
                    }}
                  />
                )}
              </div>
              {/* 底部：确认 + 说明 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <button
                  className="btn primary"
                  style={{ fontSize: 12.5 }}
                  disabled={askSubmitting || (askOption === "__custom" && !askCustom.trim())}
                  onClick={() => void resolveAsk(askOption, askCustom)}>
                  {askSubmitting ? "提交中…" : "确认"}
                </button>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Agent 提问期间暂停输入，回答后自动恢复输入框
                </span>
              </div>
            </div>
          ) : pendingPerm ? (
            /* ── 权限请求：输入框位置切换为选择题（参考 Claude Code/Cursor 授权交互）── */
            <div style={{ padding: "14px 16px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--warning)" }}>⚠ 权限请求</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent-hover)" }}>{pendingPerm.agentName}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>请选择处理方式</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => void resolvePerm("deny")}
                  disabled={permSubmitting}
                  title="拒绝本次权限请求"
                  style={{
                    width: 26, height: 26, borderRadius: "50%", border: "1px solid var(--border)",
                    background: "transparent", color: "var(--text-muted)", fontSize: 13,
                    cursor: permSubmitting ? "not-allowed" : "pointer", lineHeight: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.12s, color 0.12s, transform 0.08s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--danger)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
                  onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.9)"; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>✕</button>
              </div>
              {/* 任务/风险说明 */}
              <div style={{
                fontSize: 12.5, color: "var(--text)", background: "var(--bg-hover)",
                borderRadius: 10, padding: "8px 12px", marginBottom: 10, whiteSpace: "pre-wrap",
              }}>
                {pendingPerm.taskDescription || "Agent 请求执行以下操作："}
              </div>
              {/* 待授权动作列表 */}
              <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {pendingPerm.actions.map((a, i) => (
                  <div key={`${a.action}-${i}`} style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ color: "var(--text-muted)", minWidth: 22 }}>#{i + 1}</span>
                    <code style={{
                      background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 6,
                      fontSize: 11.5, color: "var(--accent-hover)", fontFamily: "monospace",
                    }}>{a.action}</code>
                    <span style={{ color: "var(--text-muted)" }}>→</span>
                    <span style={{ wordBreak: "break-all" }}>{a.target || "—"}</span>
                  </div>
                ))}
              </div>
              {/* 选择题选项：列出每个选项的结果 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pendingPerm.options.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setPermOption(o.id)}
                    disabled={permSubmitting}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                      textAlign: "left", padding: "8px 12px", borderRadius: 10, width: "100%",
                      border: permOption === o.id ? "1px solid var(--accent)" : "1px solid var(--border)",
                      background: permOption === o.id ? "var(--bg-hover)" : "transparent",
                      cursor: permSubmitting ? "not-allowed" : "pointer",
                      transition: "border-color 0.12s, background 0.12s, transform 0.08s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = permOption === o.id ? "var(--bg-hover)" : "transparent"; }}
                    onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
                    onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
                      {permOption === o.id ? "◉ " : "○ "}{o.label}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5 }}>{o.hint}</span>
                  </button>
                ))}
              </div>
              {/* 其他/自定义：自填输入框 */}
              {permOption === "custom" && (
                <input
                  autoFocus
                  value={permCustom}
                  onChange={(e) => setPermCustom(e.target.value)}
                  placeholder={pendingPerm.options.find((o) => o.id === "custom")?.customPlaceholder ?? "输入你的指示…"}
                  onKeyDown={(e) => { if (e.key === "Enter") { void resolvePerm("custom", permCustom); } }}
                  style={{
                    width: "100%", marginTop: 8, padding: "8px 12px", borderRadius: 10,
                    border: "1px solid var(--border)", background: "var(--bg-input)",
                    color: "var(--text)", fontSize: 12.5, outline: "none",
                  }}
                />
              )}
              {/* 底部：确认 + 说明 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <button
                  className="btn primary"
                  style={{ fontSize: 12.5 }}
                  disabled={permSubmitting || (permOption === "custom" && !permCustom.trim())}
                  onClick={() => void resolvePerm(permOption, permCustom)}>
                  {permSubmitting ? "提交中…" : "确认选择"}
                </button>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  权限请求期间暂停输入，选择后自动恢复输入框
                </span>
              </div>
            </div>
          ) : (
          <>
          <textarea ref={inputRef} value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize();
              if (e.target.value.startsWith("/")) {
                setCmdOpen(true);
                setCmdFilter(e.target.value);
                setPlusOpen(false);
              } else {
                setCmdOpen(false);
                setCmdFilter("");
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (cmdOpen && filteredCmd.length === 1) {
                  runCommand(filteredCmd[0]);
                } else {
                  void send();
                }
              }
              if (e.key === "Escape") {
                setCmdOpen(false);
                setSuggestions([]);
                setPlusOpen(false);
              }
            }}
            placeholder="输入消息（Enter 发送，/ 展开指令，Shift+Enter 换行）"
            rows={1}
            disabled={loading}
            style={{
              display: "block", width: "100%", padding: "12px 14px 2px",
              border: "none", background: "transparent", color: "var(--text)",
              fontSize: 14, outline: "none", resize: "none",
              fontFamily: "inherit", lineHeight: 1.5, maxHeight: 120,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 10px" }}>
            <button onClick={() => void openPlusPanel()}
              title="展开：指令 / 技能 / MCP 选择"
              style={{
                width: 30, height: 30, borderRadius: "50%",
                border: "1px solid var(--border)", background: "transparent",
                color: plusOpen ? "var(--accent-hover)" : "var(--text-muted)", fontSize: 16,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.12s, color 0.12s, transform 0.08s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.9)"; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
              <PlusIcon size={16} />
            </button>
            {/* 操作审批 */}
            <GhostSelect
              value={sessionConfig.approval}
              onChange={(v) => void setSessionConfigField({ approval: v as ApprovalMode })}
              title="Agent 操作审批模式（沙箱 L0-L5）"
              style={{ fontSize: 11.5, padding: "3px 6px" }}
              options={[
                { value: "auto", label: "审批: 自动" },
                { value: "confirm", label: "审批: 需确认" },
                { value: "strict", label: "审批: 严格" },
              ]}
            />
            {/* 模式选择 */}
            <GhostSelect
              value={mode}
              onChange={(v) => onModeChange?.(v)}
              title="模式"
              style={{ fontSize: 11.5, padding: "3px 6px" }}
              options={[
                { value: "build", label: "build" },
                { value: "plan", label: "plan" },
                { value: "grow", label: "grow" },
              ]}
            />
            {/* 模型切换：列出所有已启用的模型（api:<key>:<model>）；供应商默认入口保留 api:<key>；按供应商分组
                 *  label 走 prettyModelLabel 美化：去掉 provider::/ 冗余前缀、去双拼、超长截断，
                 *  完整 ID 通过 tooltip(title) 暴露，避免显示层乱码/重叠
                 */}
            <GhostSelect
              value={modelChoice}
              onChange={(v) => onModelChange?.(v)}
              title={`切换 Provider/模型（当前：${modelChoice ?? "inherit"}）——供应商页可添加`}
              style={{ fontSize: 11.5, padding: "3px 6px", maxWidth: 150 }}
              maxWidth={420}
              options={[
                { value: "inherit", label: "无模型", group: "默认", title: "inherit（跟随 Agent 默认配置）" },
                ...(providerModels ?? []).flatMap((p) => {
                  const enabled = (p.models ?? []).filter((m) => m.selected !== false);
                  return enabled.map((m) => {
                    const label = prettyModelLabel(m.id, p.key);
                    return {
                      value: `api:${p.key}:${m.id}`,
                      label: label || m.id || "（未命名）",
                      group: p.key,
                      title: `${p.key} :: ${m.id}`,
                    };
                  }) as GhostSelectOption[];
                }),
                ...providerKeys
                  .filter((k) => !(providerModels ?? []).some((pm) => pm.key === k))
                  .map((k) => ({ value: `api:${k}`, label: `${k}（无可用模型）`, group: "供应商", title: `供应商（无已启用模型）：${k}` })),
                ...localModels.map((m) => ({
                  value: `local:${m.id}`,
                  label: prettyModelLabel(m.label || m.id),
                  group: "本地模型",
                  title: `本地模型：${m.label || m.id}`,
                })),
              ]}
            />
            {/* 推理强度 */}
            <GhostSelect
              value={reasoningEffort}
              onChange={(v) => onReasoningChange?.(v)}
              title="推理强度（none/low/medium/high）"
              style={{ fontSize: 11.5, padding: "3px 6px" }}
              options={[
                { value: "none", label: "推理: 关" },
                { value: "low", label: "推理: 低" },
                { value: "medium", label: "推理: 中" },
                { value: "high", label: "推理: 高" },
              ]}
            />
            {/* 联网搜索开关：灰色（关）→ 绿色（开），点击切换；关闭时 web_search/web_fetch 被静默拒绝 */}
            <button
              onClick={() => setNetworkEnabled((v) => !v)}
              title={networkEnabled ? "联网搜索：已启用" : "联网搜索：未启用（点击开启）"}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "3px 8px", borderRadius: 12,
                border: `1px solid ${networkEnabled ? "#22c55e" : "var(--border)"}`,
                background: networkEnabled ? "rgba(34,197,94,0.15)" : "var(--bg-hover)",
                color: networkEnabled ? "#22c55e" : "var(--text-dim)",
                fontSize: 11.5, cursor: "pointer",
                transition: "background 0.15s, border-color 0.15s, color 0.15s",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (!networkEnabled) { e.currentTarget.style.background = "var(--bg)"; }
              }}
              onMouseLeave={(e) => {
                if (!networkEnabled) { e.currentTarget.style.background = "var(--bg-hover)"; }
              }}>
              <InternetIcon size={14} style={{ color: networkEnabled ? "#22c55e" : "var(--text-dim)" }} />
              联网搜索
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--text-dim)", marginRight: 8, display: loading ? "none" : "block" }}>
              {input ? `${input.length} 字` : ""}
            </span>
            {loading ? (
              <button onClick={() => void stopGeneration()}
                disabled={stopping}
                title="中断当前 Agent 输出（保留已生成内容）"
                style={{
                  width: 36, height: 36, borderRadius: "50%",
                  border: "none",
                  background: stopping ? "var(--bg-hover)" : "var(--danger)",
                  color: stopping ? "var(--text-dim)" : "#fff",
                  fontSize: 13, fontWeight: 700, cursor: stopping ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "background 0.12s, transform 0.08s",
                }}
                onMouseEnter={(e) => { if (!stopping) { e.currentTarget.style.background = "#f87171"; } }}
                onMouseLeave={(e) => { if (!stopping) { e.currentTarget.style.background = "var(--danger)"; } }}
                onMouseDown={(e) => { if (!stopping) { e.currentTarget.style.transform = "scale(0.9)"; } }}
                onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                {stopping ? "…" : "■"}
              </button>
            ) : (
              <button disabled={loading || !input.trim()}
                onClick={() => void send()}
                title="发送"
                style={{
                  width: 38, height: 38, borderRadius: "50%",
                  border: "none",
                  background: input.trim() ? "#fff" : "var(--bg-hover)",
                  color: input.trim() ? "#1e293b" : "var(--text-muted)",
                  cursor: input.trim() ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "background 0.12s, box-shadow 0.12s, transform 0.08s",
                  boxShadow: input.trim() ? "0 2px 10px rgba(140,246,251,0.35)" : "none",
                }}
                onMouseEnter={(e) => { if (input.trim()) { e.currentTarget.style.boxShadow = "0 4px 16px rgba(140,246,251,0.55)"; } }}
                onMouseLeave={(e) => { if (input.trim()) { e.currentTarget.style.boxShadow = "0 2px 10px rgba(140,246,251,0.35)"; } }}
                onMouseDown={(e) => { if (input.trim()) { e.currentTarget.style.transform = "scale(0.9)"; } }}
                onMouseUp={(e) => { e.currentTarget.style.transform = "scale(1)"; }}>
                <SendIcon size={20} style={{ opacity: input.trim() ? 1 : 0.4 }} />
              </button>
            )}
          </div>
          </>
          )}
        </div>
      </div>

      {/* ── 协作弹窗：自分裂 / A2A 传唤 双 Tab ── */}
      {coopOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setCoopOpen(false); } }}>
          <div className="card" style={{ width: 460, maxWidth: "92vw" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>会话内协作</h3>
              <button className="titlebar-btn" onClick={() => setCoopOpen(false)}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <button className={`btn${coopTab === "fork" ? " primary" : ""}`} style={{ fontSize: 12.5 }}
                onClick={() => setCoopTab("fork")}>
                <ForkIcon size={14} /> 自分裂
              </button>
              <button className={`btn${coopTab === "delegate" ? " primary" : ""}`} style={{ fontSize: 12.5 }}
                onClick={() => { setCoopTab("delegate"); refreshDelegates(); }}>
                <LinkIcon size={14} /> A2A 传唤
              </button>
            </div>

            {coopTab === "fork" ? (
              <>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
                  {agentName} 自分裂出一个新实例（同模型、独立进程并行工作），子实例可用
                  <b style={{ color: "var(--accent-hover)" }}> &lt;DELEGATE&gt;</b> 传唤协作，结果整合回本会话。分裂深度上限 2。
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>子 Agent 名称</div>
                <input className="input-field" value={splitName} spellCheck={false}
                  placeholder="如：research-helper" style={{ marginBottom: 10 }}
                  onChange={(e) => setSplitName(e.target.value)} />
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>角色（可选）</div>
                <input className="input-field" value={splitRole} spellCheck={false}
                  placeholder="如：负责资料检索与总结" style={{ marginBottom: 14 }}
                  onChange={(e) => setSplitRole(e.target.value)} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn success" onClick={handleFork} disabled={splitBusy || !splitName.trim()}>
                    {splitBusy ? "分裂中…" : "创建子实例"}
                  </button>
                  <button className="btn" onClick={() => setCoopOpen(false)}>取消</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
                  选择已添加的 Agent 委派任务（对应 CLI <b style={{ color: "var(--accent-hover)" }}>/task</b>）：
                  任务将注入 <b style={{ color: "var(--accent-hover)" }}>&lt;DELEGATE&gt;</b> 消息，
                  {agentName} 路由委派给子 Agent 执行，结果自动整合回本会话（委派以事件行显示）。
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>选择子 Agent</div>
                <select className="tool-select" style={{ width: "100%", marginBottom: 10 }}
                  value={delegateAgentId}
                  onChange={(e) => setDelegateAgentId(e.target.value)}>
                  <option value="">— 选择 Agent —</option>
                  {allAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}{a.role ? `（${a.role}）` : ""}</option>
                  ))}
                </select>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>任务描述（可选）</div>
                <textarea className="input-field" style={{ marginBottom: 14, resize: "none", height: 64 }}
                  value={delegateTask}
                  placeholder="如：帮我检索最近的 MCP 文档并总结要点"
                  onChange={(e) => setDelegateTask(e.target.value)} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn success" onClick={handleDelegate} disabled={!delegateAgentId}>
                    传唤并执行
                  </button>
                  <button className="btn" onClick={() => setCoopOpen(false)}>取消</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}