/**
 * gui/src/renderer/pages/ChatPanel.tsx — 会话面板（会话化重构 v3）。
 * - 项目（Agent）内独立会话：进入会话加载历史（sessions:load），消息按 session_id 落盘
 * - 会话内协作双入口：⑂ 自分裂（fork 新实例） / ⟳ A2A 传唤（<DELEGATE> 委派已有 Agent）
 * - "/" 指令面板（CLI 语义迁移）：/task /split /thinking /stats /agent /new ...
 * - 输入联想：≥1 字自动检索历史会话相似消息（点击填入）
 * - ＋ 展开栏：指令 / 技能 / MCP 工具 选择
 * - 会话级配置：💼 工作目录 + 审批模式；会话标题随时重命名
 */
import React, { type JSX } from "react";
import type { StreamChunk, ConversationMessage, SessionConfig, ApprovalMode, SuggestionItem, ExtrasList } from "../../shared/ipc.js";

interface Message {
  role: "user" | "assistant";
  content: string;
  time: string;
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
  providerKeys?: string[];
  localModels?: Array<{ id: string; label: string }>;
  onModelChange?: (val: string) => void;
  onModeChange?: (val: string) => void;
  onReasoningChange?: (val: string) => void;
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

export default function ChatPanel({
  sessionId,
  sessionTitle,
  agentId,
  agentName = "Agent",
  modelChoice = "inherit",
  mode = "build",
  reasoningEffort = "none",
  providerKeys = [],
  localModels = [],
  onModelChange,
  onModeChange,
  onReasoningChange,
  onConversationsChanged,
  onSessionRenamed,
  onNewSessionRequested,
  onNavigateSettings,
}: ChatPanelProps): JSX.Element {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  const [toolEvents, setToolEvents] = React.useState<ToolEvent[]>([]);
  const [lastTimings, setLastTimings] = React.useState<Record<string, number> | undefined>();
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
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const eventIdRef = React.useRef(0);

  /** 切换会话：加载历史 + 会话配置 + 已有 Agent 列表（A2A 传唤候选） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    setMessages([]);
    setPartial("");
    setToolEvents([]);
    setLastTimings(undefined);
    setSuggestions([]);
    void api.conversations.load(sessionId).then((msgs: ConversationMessage[]) => {
      setMessages(msgs.map((m) => ({ role: m.role, content: m.content, time: m.time ? new Date(m.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "" })));
    }).catch(console.error);
    void api.conversations.configGet(agentId).then(setSessionConfig).catch(() => undefined);
    void api.agents.list().then((list: Array<{ id: string; name: string; role: string }>) => {
      setAllAgents(list.filter((a) => a.id !== agentId));
    }).catch(console.error);
  }, [sessionId, agentId]);

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
      setPartial((prev) => prev + (c.data?.content ?? ""));
    });
    const off2 = api.chat.onDone((m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => {
      setMessages((prev) => [...prev, { role: "assistant", content: m.reply, time: nowTime() }]);
      setPartial("");
      setToolEvents([]);
      setLoading(false);
      if (m.timings) setLastTimings(m.timings);
      onConversationsChanged?.();
    });
    const off3 = api.chat.onError((e: { message: string }) => {
      console.error("[chat] error:", e.message);
      setLoading(false);
      setPartial("");
      setToolEvents([]);
    });
    return () => { off1(); off2(); off3(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  React.useEffect(() => {
    bottomRef.current?.scrollTo({ top: 100000, behavior: "smooth" });
  }, [messages, partial, toolEvents]);

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
    setPartial("");
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
    setMessages((prev) => [...prev, { role: "user", content: text, time: nowTime() }]);
    setInput("");
    setPartial("");
    setToolEvents([]);
    setSuggestions([]);
    setLoading(true);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.focus();
    }
    void api.chat.stream({ agentId, message: text, sessionId });
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
    setPartial("");
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
    setMessages((prev) => [...prev, { role: "user", content: `⟳ 传唤「${target.name}」：${task || "请协助完成当前任务"}`, time: nowTime() }]);
    setInput("");
    setPartial("");
    setToolEvents([]);
    setLoading(true);
    void api.chat.stream({ agentId, message: delegateMsg, sessionId });
  }

  const canRetry = messages.length > 0 && !loading;
  const filteredCmd = cmdList;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* 顶部工具栏：会话组 | 模型组 | 会话配置组 */}
      <div style={{
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
              ✎
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
        <button onClick={() => { setCoopTab("fork"); setCoopOpen(true); }} disabled={loading}
          className="btn" title="自分裂：创建子 Agent 实例多进程并行工作（fork 深度上限 2）">
          ⑂ 自分裂
        </button>
        <button onClick={() => { setCoopTab("delegate"); setCoopOpen(true); }} disabled={loading}
          className="btn" title="A2A 传唤：选择已有 Agent 委派任务（/task 语义），结果整合回本会话">
          ⟳ 传唤
        </button>
        <span style={{ color: "var(--text-dim)", margin: "0 4px" }}>|</span>
        <select value={modelChoice}
          onChange={(e) => onModelChange?.(e.target.value)}
          className="tool-select" title="切换 Provider/模型（供应商页可添加）">
          <option value="inherit">inherit</option>
          {providerKeys.map((k) => (
            <option key={k} value={`api:${k}`}>api:{k}</option>
          ))}
          {localModels.map((m) => (
            <option key={m.id} value={`local:${m.id}`}>local:{m.id}</option>
          ))}
        </select>
        <select value={mode}
          onChange={(e) => onModeChange?.(e.target.value)}
          className="tool-select" title="模式">
          <option value="build">build</option>
          <option value="plan">plan</option>
          <option value="grow">grow</option>
        </select>
        <select value={reasoningEffort}
          onChange={(e) => onReasoningChange?.(e.target.value)}
          className="tool-select" title="推理强度（none/low/medium/high）">
          <option value="none">推理: 关</option>
          <option value="low">推理: 低</option>
          <option value="medium">推理: 中</option>
          <option value="high">推理: 高</option>
        </select>
        <span style={{ color: "var(--text-dim)", margin: "0 4px" }}>|</span>
        <button onClick={handlePickFolder}
          className="btn" title={`工作目录：${sessionConfig.workspace || "未设置（不限制读写范围）"}`}
          style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          💼 {sessionConfig.workspace || "选择工作目录"}
        </button>
        <select value={sessionConfig.approval}
          onChange={(e) => void setSessionConfigField({ approval: e.target.value as ApprovalMode })}
          className="tool-select" title="Agent 操作审批模式（沙箱 L0-L5）">
          <option value="auto">审批: 自动批准</option>
          <option value="confirm">审批: 需确认</option>
          <option value="strict">审批: 严格</option>
        </select>
        {lastTimings && lastTimings.elapsedMs && (
          <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: "auto" }}>
            {lastTimings.elapsedMs}ms
            {lastTimings.promptTokens && ` · ${lastTimings.promptTokens}+${lastTimings.completionTokens ?? 0}tok`}
          </span>
        )}
      </div>

      {/* 消息区域：卡片化 + 事件行 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 0" }}>
        {messages.length === 0 && !loading && (
          <div style={{ color: "var(--text-dim)", textAlign: "center", marginTop: 48, fontSize: 13 }}>
            与 {agentName} 的会话「{sessionTitle}」
            {sessionConfig.workspace && (
              <div style={{ fontSize: 12, marginTop: 6 }}>
                💼 工作目录：{sessionConfig.workspace}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 14 }}>
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
          ) : (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
                background: "var(--accent-soft)", color: "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 15, fontWeight: 700,
              }}>
                {agentName.charAt(0)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{agentName}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.time}</span>
                </div>
                <div style={{
                  lineHeight: 1.6, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)",
                  background: "var(--bg-input)", border: "1px solid var(--border)",
                  borderRadius: "4px 16px 16px 16px", padding: "10px 14px",
                }}>
                  {m.content}
                </div>
              </div>
            </div>
          )
        )}
        {loading && (
          <div style={{ display: "flex", gap: 10, marginBottom: 14, opacity: 0.9 }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
              background: "var(--accent-soft)", color: "var(--accent)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 15, fontWeight: 700,
            }}>
              {agentName.charAt(0)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 3 }}>
                {agentName} · 思考中
              </div>
              {toolEvents.map((t) => (
                <div key={t.id} style={{
                  fontSize: 12, color: "var(--accent-hover)", marginBottom: 3,
                  background: "var(--accent-soft)", padding: "2px 10px",
                  borderRadius: 8, display: "inline-block",
                }}>
                  {t.label}
                </div>
              ))}
              <div style={{
                lineHeight: 1.6, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text)",
                background: "var(--bg-input)", border: "1px solid var(--border)",
                borderRadius: "4px 16px 16px 16px", padding: "10px 14px",
              }}>
                {partial || "⌛"}
                {partial && <span style={{ display: "inline-block", width: 8, height: 16, background: "var(--accent)", marginLeft: 2, verticalAlign: "text-bottom", animation: "blink 1s step-start infinite" }} />}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

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

        {/* 加号展开栏：指令 / 技能 / MCP */}
        {plusOpen && (
          <>
            <div style={{
              position: "absolute", bottom: "100%", left: 16, right: 16, marginBottom: 4,
              background: "var(--bg-input)", border: "1px solid var(--border-hover)",
              borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              zIndex: 40, maxHeight: 340, overflowY: "auto",
            }}>
              <div style={{ display: "flex", alignItems: "center", padding: "6px 12px" }}>
                <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>
                  选择使用（点击指令执行 / 技能、MCP 插入输入框）
                </span>
                <button className="titlebar-btn" onClick={() => setPlusOpen(false)}>✕</button>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                指令
              </div>
              {COMMANDS.map((c) => (
                <button key={c.cmd}
                  onClick={() => runCommand(c)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "5px 12px", border: "none", background: "transparent", cursor: "pointer",
                    fontSize: 12.5, color: "var(--text)",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ color: "var(--accent-hover)", fontWeight: 700, minWidth: 62 }}>{c.cmd}</span>
                  <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.desc}</span>
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                技能（{(extras?.skills ?? []).length}）
              </div>
              {(extras?.skills ?? []).length === 0 && (
                <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-dim)" }}>无已加载技能（config/skills/ 下可安装）</div>
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
                  <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.description || "（无描述）"}</span>
                </button>
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-hover)", padding: "4px 12px", borderTop: "1px solid var(--border)" }}>
                MCP 工具（{(extras?.mcpTools ?? []).length}）
              </div>
              {(extras?.mcpTools ?? []).length === 0 && (
                <div style={{ padding: "4px 12px 8px", fontSize: 12, color: "var(--text-dim)" }}>无已连接 MCP 工具（slime.toml 配置）</div>
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
                  <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.description || "（无描述）"}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div style={{
          borderRadius: 18, border: "1px solid var(--border-hover)",
          background: "var(--bg-input)", overflow: "hidden",
        }}>
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
          <div style={{ display: "flex", alignItems: "center", padding: "6px 10px 10px" }}>
            <button onClick={() => void openPlusPanel()}
              title="展开：指令 / 技能 / MCP 选择"
              style={{
                width: 30, height: 30, borderRadius: "50%",
                border: "1px solid var(--border)", background: "transparent",
                color: plusOpen ? "var(--accent-hover)" : "var(--text-muted)", fontSize: 16,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              ＋
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--text-dim)", marginRight: 8, display: loading ? "none" : "block" }}>
              {input ? `${input.length} 字` : ""}
            </span>
            <button disabled={loading || !input.trim()}
              onClick={() => void send()}
              title="发送"
              style={{
                width: 36, height: 36, borderRadius: "50%",
                border: "none",
                background: loading || !input.trim() ? "var(--bg-hover)" : "var(--accent)",
                color: loading || !input.trim() ? "var(--text-dim)" : "#fff",
                fontSize: 16, fontWeight: 700, cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.12s",
              }}>
              ↑
            </button>
          </div>
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
                ⑂ 自分裂
              </button>
              <button className={`btn${coopTab === "delegate" ? " primary" : ""}`} style={{ fontSize: 12.5 }}
                onClick={() => setCoopTab("delegate")}>
                ⟳ A2A 传唤
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