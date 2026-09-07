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
import RightSidebar from "./pages/RightSidebar.js";
import { SIDEBAR_OPEN_EVENT } from "./pages/Markdown.js";
import type { DownloadProgressInfo, BootStatus } from "../shared/ipc.js";
import { ChevronIcon, EditIcon, MenuIcon, PlusIcon, SettingsIcon, SidebarLeftIcon, SidebarRightIcon } from "./components/Icon.js";
/** A-943 群聊头脑风暴图标（用户选定 D:\下载\团队.svg） */
import teamSvg from "./assets/team.svg";
/** A-945 会话列表图标（用户选定 D:\下载\当前会话.svg） */
import currentSessionSvg from "./assets/current-session.svg";
import { getTheme, applyTheme, type ThemeName } from "./theme.js";
import { confirmAsync } from "./dialog.js";

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

/** 供应商 → 已启用模型（聊天模型下拉展示 api:<key>:<model>） */
interface ProviderModelBrief {
  key: string;
  models: Array<{
    id: string;
    selected?: boolean;
    /** 是否支持思考过程（上游/推断） */
    thinking?: boolean;
    /** 上游/推断的推理强度等级（如 low/medium/high/xhigh/max），为空表示仅开/关无等级 */
    thinking_efforts?: string[];
    /** 上游最大输出 token（→ 发送时 max_tokens） */
    max_output?: number;
    /** 上游上下文窗口 token（→ 上下文消耗圆环 cap / 截断） */
    context_window?: number;
    /** 是否支持图片输入 */
    vision?: boolean;
  }>;
}

interface SessionItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  workspace?: string;
  title: string;
  count: number;
  lastTime: string;
  /** 团队会话成员 Agent id 列表（组长=agentId；空/缺省=单人会话） */
  memberIds?: string[];
  /** 团队会话成员 Agent 名称（与 memberIds 同序，渲染徽章用） */
  memberNames?: string[];
  /** A-954：成员入群模型（memberId → model_choice 串；群聊右栏成员卡与上下文 cap 用） */
  memberModels?: Record<string, string>;
  /** A-954：群聊组长（会话归属 Agent）入群模型 */
  leaderModel?: string;
  /** A-943：会话模式（brainstorm = 群聊头脑风暴，左侧特殊渲染） */
  type?: "normal" | "brainstorm";
}

interface WelcomeChatProps {
  onSend: (text: string) => Promise<void>;
  agents: AgentBrief[];
  onChooseAgent: (agentId: string) => Promise<void>;
  onOpenAgents: () => void;
}

/** 欢迎聊天区（Cursor/claude 风格：直接给输入框，按 Enter 即开聊；可选先选 Agent） */
function WelcomeChat({ onSend, agents, onChooseAgent, onOpenAgents }: WelcomeChatProps): JSX.Element {
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [showAgents, setShowAgents] = React.useState(false);
  const [examples, setExamples] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // 默认例句池
  const DEFAULT_EXAMPLES = [
    "帮我写一个 Python 脚本",
    "分析一下当前项目结构",
    "帮我写个 FastAPI 服务",
    "总结这段代码的逻辑",
    "帮我查找 bug",
    "解释这个架构设计",
    "生成单元测试",
    "优化这段代码性能",
    "帮我写个爬虫",
    "整理这份需求文档",
  ];

  // 从 localStorage 读取用户历史消息模式（用于个性化例句）
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const loadHistory = (): void => {
      try {
        const stored = localStorage.getItem("slime_welcome_examples");
        if (stored) {
          const parsed = JSON.parse(stored) as string[];
          if (parsed.length > 0) {
            setExamples(parsed);
            return;
          }
        }
      } catch { /* 忽略解析错误 */ }
      // 首次使用：随机选取 3 条默认例句
      setExamples(shuffleAndPick(DEFAULT_EXAMPLES, 3));
    };
    void loadHistory();
    // 监听用户发送的消息，用于个性化
    const off = api.chat?.onHistoryUpdate?.(updateExamples);
    return () => { off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 根据用户历史更新例句
  const updateExamples = React.useCallback((histories: string[]): void => {
    if (histories.length === 0) { return; }
    // 提取常见模式关键词
    const freq = new Map<string, number>();
    for (const h of histories) {
      const words = h.split(/\s+/).filter((w) => w.length > 2);
      for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }
    // 按频率排序，取前 3 个高频词作为例句候选
    const topWords = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
    if (topWords.length > 0) {
      const custom = DEFAULT_EXAMPLES.filter((ex) => topWords.some((tw) => ex.includes(tw)));
      if (custom.length >= 3) {
        setExamples(shuffleAndPick(custom, 3));
      } else {
        setExamples(shuffleAndPick(DEFAULT_EXAMPLES, 3));
      }
    }
  }, []);

  // 打乱并选取 n 条
  const shuffleAndPick = (arr: string[], n: number): string[] => {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  };

  async function handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy) { return; }
    setBusy(true);
    try {
      await onSend(trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 0, gap: 18, overflow: "hidden", width: "100%", padding: "0 24px", boxSizing: "border-box" }}>
      {/* Logo */}
      <div style={{
        width: 64, height: 64, borderRadius: 18,
        background: "linear-gradient(135deg, var(--accent), #6366f1)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 30, fontWeight: 900, color: "#fff",
      }}>S</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>slime</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", textAlign: "center", maxWidth: 420, lineHeight: 1.6, wordBreak: "break-word", padding: "0 8px", boxSizing: "border-box" }}>
        直接在这里输入想做的事；无需手动选择 Agent——后端会自动为你的会话分配最合适的助手。
      </div>
      {/* 输入框 */}
      <input
        ref={inputRef}
        className="input-field"
        placeholder="说点什么…（按 Enter 发送 / Shift+Enter 换行）"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSend(draft);
            setDraft("");
            setShowAgents(false);
          }
        }}
        style={{ width: "min(680px, 100%)", maxWidth: 680, fontSize: 14, padding: "10px 14px", boxSizing: "border-box" }}
      />
      {/* 快捷建议（随机轮换） */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 640, width: "100%", padding: "0 8px", boxSizing: "border-box" }}>
        {examples.map((s) => (
          <button key={s}
            onClick={() => { void handleSend(s); setDraft(""); setShowAgents(false); }}
            style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 14, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text-muted)", cursor: "pointer" }}>
            {s}
          </button>
        ))}
      </div>
      {/* Agent 选择下拉（默认收起，点击可展开） */}
      <div style={{ position: "relative" }}>
        <button className="btn" style={{ fontSize: 12 }}
          onClick={() => setShowAgents((v) => !v)}>
          {showAgents ? "收起 Agent 列表" : "或选择一个 Agent 开始"}
        </button>
        {showAgents && (
          <div style={{
            position: "absolute", top: "110%", left: 0, zIndex: 50,
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12,
            padding: 8, minWidth: 280, maxHeight: 360, overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
          }}>
            {agents.map((a) => (
              <button key={a.id}
                onClick={() => { setShowAgents(false); void onChooseAgent(a.id); }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "7px 10px", marginBottom: 4,
                  borderRadius: 8, border: "1px solid var(--border)",
                  background: "var(--bg-input)", cursor: "pointer",
                }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{a.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, wordBreak: "break-all" }}>{a.role || "（无角色）"}</div>
              </button>
            ))}
            {agents.length === 0 && (
              <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-muted)" }}>
                暂无 Agent；去设置里创建一个 →
                <button className="btn" style={{ marginLeft: 8, fontSize: 11, padding: "2px 8px" }}
                  onClick={() => { setShowAgents(false); onOpenAgents(); }}>去设置</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 模型加载等待秒数时钟（A-129）：自持 1s 计时器只重渲染自身秒数区域，
    避免整棵 App 树随秒表每秒重渲染（含 ChatPanel / 侧栏等大子树） */
function WaitSecClock(): JSX.Element {
  const [sec, setSec] = React.useState(0);
  React.useEffect(() => {
    setSec(0);
    const t = window.setInterval(() => setSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
        已等待 <b style={{ color: sec > 60 ? "var(--warning)" : "var(--text)" }}>{sec}</b> 秒
      </div>
      {sec > 60 && (
        <div style={{
          fontSize: 12, color: "var(--warning)", marginTop: 6, lineHeight: 1.6,
          padding: "8px 10px", borderRadius: 8, background: "rgba(251,191,36,0.08)",
          border: "1px solid rgba(251,191,36,0.25)",
        }}>
          加载已超过 60 秒，可能卡住（大模型 CPU 首载通常 1~2 分钟）。可点击下方「取消加载」后重试。
        </div>
      )}
    </>
  );
}

/** 路径 → 目录名（侧栏文件夹分组头显示用；Windows 反斜杠/正斜杠均处理） */
function pathBase(p: string): string {
  const s = (p ?? "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

export default function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("general");
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [sidebarWidth, setSidebarWidth] = React.useState(() => parseInt(localStorage.getItem('slime_sidebar_w') || '280'));
  /** 右侧栏（工作树/任务/终端/浏览器）展开状态 */
  const [rightOpen, setRightOpen] = React.useState(true);
  const [rightWidth, setRightWidth] = React.useState(() => parseInt(localStorage.getItem('slime_rightbar_w') || '360'));
  /** A-173：点击聊天消息里的文件/网址链接 → 自动展开右侧栏（由 RightSidebar 新建对应页） */
  React.useEffect(() => {
    const onOpen = (): void => setRightOpen(true);
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
  }, []);
  /** 右侧栏工作树：会话级工作目录（configGet） */
  const [sessionWorkspace, setSessionWorkspace] = React.useState("");
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  // A-921：右侧边栏与会话一体——开合/宽度按会话记忆（对齐 VS Code Copilot「side pane 尺寸/可见性随会话保持」
  // 与 OpenClaw「widths/collapsed 按 canonical session 持久化」）；配合 RightSidebar 内部 tabs/任务按会话隔离，
  // 切回任意会话其右侧栏（宽度、折叠、打开的页、任务、事件流）原样还原，多会话互不干扰
  const rightViewCacheRef = React.useRef<Record<string, { open: boolean; width: number }>>({});
  const prevRightSidRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const sid = selectedSessionId ?? "";
    if (prevRightSidRef.current !== null && prevRightSidRef.current !== sid) {
      rightViewCacheRef.current[prevRightSidRef.current] = { open: rightOpen, width: rightWidth };
    }
    if (sid) {
      const snap = rightViewCacheRef.current[sid];
      if (snap) {
        setRightOpen(snap.open);
        setRightWidth(snap.width);
      }
    }
    prevRightSidRef.current = sid || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [agentConfig, setAgentConfig] = React.useState<Record<string, { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string }>>({});
  /** 每个 Agent 配置的写入代次：任何用户交互写入（updateAgentConfig）都会递增。
   *  后台 detail 拉取在发起时记录代次，返回时若代次已前进 → 丢弃旧快照（避免迟到的
   *  后台数据覆盖刚做的编辑，导致推理按钮/思考开关"假死、怎么切都救不回来"） */
  const agentCfgEpochRef = React.useRef<Record<string, number>>({});
  const [providerKeys, setProviderKeys] = React.useState<string[]>([]);
  const [providerModels, setProviderModels] = React.useState<ProviderModelBrief[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelBrief[]>([]);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  /** 新建会话草稿：目标工作文件夹（null=尚未选择；""=显式跳过绑定） */
  const [newDraftWorkspace, setNewDraftWorkspace] = React.useState<string | null>(null);
  /** 新建会话草稿：组长 Agent id（②选择，点击选中不立即创建） */
  const [newDraftLeader, setNewDraftLeader] = React.useState<string | null>(null);
  /** 新建会话草稿：团队成员 Agent id 列表（③多选，可选；组长统筹指挥、成员各司其职） */
  const [newDraftMemberIds, setNewDraftMemberIds] = React.useState<string[]>([]);
  /** A-943：新建会话草稿聊天形式（normal 普通对话 / brainstorm 群聊头脑风暴） */
  const [newDraftType, setNewDraftType] = React.useState<"normal" | "brainstorm">("normal");
  /** A-954：群聊成员三步入群——{ id, name, model }（model 选定才正式入群） */
  const [draftMembers, setDraftMembers] = React.useState<Array<{ id: string; name: string; model: string }>>([]);
  /** A-954：群聊左列选中的待配置 agent（null=收起右侧配置面板） */
  const [draftCfgAgent, setDraftCfgAgent] = React.useState<string | null>(null);
  /** A-954：群聊右侧当前选中的供应商（下一步展开其模型） */
  const [draftCfgProvider, setDraftCfgProvider] = React.useState<string | null>(null);
  /** A-954：自研 SILAM 脑是否可用（sidecar 拉起成功才列入供应商） */
  const [silamOk, setSilamOk] = React.useState(false);
  /** A-954：群聊可配置供应商（API 供应商 + 本地 + SILAM）与各供应商标记 */
  const draftProviders = React.useMemo(() => {
    const list: Array<{ key: string; label: string; kind: "api" | "local" | "silam"; models: Array<{ id: string; label: string; ctx?: number }> }> = [];
    for (const p of providerModels ?? []) {
      if (!p.key || (p.models?.length ?? 0) === 0) { continue; }
      list.push({ key: p.key, label: p.key, kind: "api", models: (p.models ?? []).map((m) => ({ id: m.id, label: m.id, ctx: m.context_window })) });
    }
    for (const l of localModels ?? []) {
      const entry = { id: `local:${l.id}`, label: l.label || l.id };
      const hit = list.find((x) => x.key === "local");
      if (hit) { hit.models.push(entry); }
      else { list.push({ key: "local", label: "本地模型", kind: "local", models: [entry] }); }
    }
    if (silamOk) {
      list.push({ key: "silam", label: "SILAM 自研", kind: "silam", models: [{ id: "silam", label: "silam（离线情感脑+语言脑兑底）" }] });
    }
    return list;
  }, [providerModels, localModels, silamOk]);
  /** 行内重命名状态 */
  const [editingSession, setEditingSession] = React.useState<{ sessionId: string; draft: string } | null>(null);
  /** 依赖下载任务状态（全局常驻订阅：切走设置页进度不丢失） */
  const [dl, setDl] = React.useState<Record<string, DownloadProgressInfo>>({});
  /** 启动引导状态（A-C-C 式启动加载面板） */
  const [boot, setBoot] = React.useState<BootStatus | null>(null);
  /** A-966b：首屏数据（Agent/会话列表）是否就绪——启动面板要等到它完成才隐藏 */
  const [uiReady, setUiReady] = React.useState(false);
  /** 本地模型加载进度（slime 主题弹窗；llama-server 首次加载可能数十秒） */
  const [modelLoading, setModelLoading] = React.useState<{ loading: boolean; message?: string; key?: string }>({ loading: false });
  /** 主题（alpha=既有 / beta=毛玻璃黑里透蓝），localStorage 持久化 */
  const [theme, setTheme] = React.useState<ThemeName>(getTheme());

  const sidebarWidthRef = React.useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const rightWidthRef = React.useRef(rightWidth);
  rightWidthRef.current = rightWidth;

  React.useEffect(() => {
    applyTheme(theme);
    // 同步标题栏系统按钮 overlay 配色（alpha=slate / beta=黑里透蓝）
    const api = (window as unknown as { slimeAPI?: { theme?: { set: (t: string) => Promise<void> } } }).slimeAPI;
    void api?.theme?.set(theme).catch(console.error);
  }, [theme]);

  // 启动时从 localStorage 恢复 agent 配置（model_choice / reasoning_effort / show_thinking / mode）
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("slime_agent_config");
      if (raw) { setAgentConfig(JSON.parse(raw)); }
    } catch { /* ignore */ }
  }, []);

  // 模型加载计时已下沉到 WaitSecClock 组件内部（A-129），App 树不再每秒重渲染

  /** 合并 Agent 后端详情到 agentConfig（唯一写入口之一）：
   *  - 只接受非空字符串字段，null/undefined 一律不覆盖既有值（防止空值抹除用户选择）；
   *  - 应用时递增代次，使早于本次快照发起的更旧拉取自动失效。 */
  const applyAgentDetail = React.useCallback((id: string, d: { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string } | null): void => {
    if (!d) { return; }
    agentCfgEpochRef.current[id] = (agentCfgEpochRef.current[id] ?? 0) + 1;
    const clean: Record<string, string> = {};
    for (const k of ["model_choice", "mode", "reasoning_effort", "show_thinking"] as const) {
      const v = d[k];
      if (typeof v === "string" && v.length > 0) { clean[k] = v; }
    }
    setAgentConfig((prev) => (Object.keys(clean).length > 0
      ? { ...prev, [id]: { ...((prev[id] ?? {}) as Record<string, string>), ...clean } }
      : prev));
  }, []);

  const loadAgents = React.useCallback(async (): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const list = await api.agents.list().catch((e: unknown) => {
      console.error("[app] agents list failed:", e);
      return [];
    });
    setAgents(list);
    // 启动即从后端恢复各 Agent 配置（agents.json 是权威源；不依赖打开 AgentsPanel）。
    // 关键：发请求前快照该 Agent 的配置代次；返回时若代次已前进（用户刚编辑过）→ 丢弃，
    // 绝不拿旧快照覆盖用户的实时改动（推理按钮消失/思考开关点不动的不稳定根因）。
    for (const a of list) {
      const epoch0 = agentCfgEpochRef.current[a.id] ?? 0;
      api.agents.detail(a.id).then((d: { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string } | null) => {
        if ((agentCfgEpochRef.current[a.id] ?? 0) > epoch0) { return; }
        applyAgentDetail(a.id, d);
      }).catch(console.error);
    }
  }, [applyAgentDetail]);

  const loadSessions = React.useCallback(async (): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const items = await api.conversations.list().catch((e: unknown) => {
      console.error("[app] sessions list failed:", e);
      return [];
    });
    setSessions(items);
    setUiReady(true); // A-966b：会话首拉完成 → 允许启动面板隐藏
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

  /** 侧栏会话列表轮询（发送消息后标题/时间/计数更新；主链路已由 onConversationsChanged 事件驱动，此处仅 15s 兜底，A-129 降频减负） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    void loadSessions();
    const timer = window.setInterval(() => { void loadSessions(); }, 15000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  /** AgentsPanel 属性面板把完整详情回传 App 层（驱动 ChatPanel 头部模型显示） */
  React.useEffect(() => {
    const w = window as unknown as { __onAgentDetail?: (id: string, d: unknown) => void };
    w.__onAgentDetail = (id, d) => {
      const data = d as { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string } | null;
      // 面板打开/编辑都会 push 详情。但若该 Agent 已被用户在聊天区实时编辑过（epoch>0），
      // 面板此刻持有的旧快照不得回滚用户最新选择（"切会话也救不回来"的残留路径）：
      // 只补填本地缺失字段；从未编辑过（epoch=0）才整体应用，保证面板配置能同步到聊天区。
      if ((agentCfgEpochRef.current[id] ?? 0) > 0) {
        setAgentConfig((prev) => {
          const local = (prev[id] ?? {}) as Record<string, string>;
          const merged: Record<string, string> = {};
          for (const k of ["model_choice", "mode", "reasoning_effort", "show_thinking"] as const) {
            const v = data?.[k];
            if (typeof v === "string" && v.length > 0 && local[k] === undefined) { merged[k] = v; }
          }
          return Object.keys(merged).length > 0 ? { ...prev, [id]: { ...local, ...merged } } : prev;
        });
        return;
      }
      applyAgentDetail(id, data);
    };
    return () => { delete (w as { __onAgentDetail?: unknown }).__onAgentDetail; };
  }, [applyAgentDetail]);

  /** 加载 Provider 键列表 + 本地模型列表（模型下拉动态化） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const load = (): void => {
      api.providers.list().then((list: Array<{ key: string; models?: Array<{ id: string; selected?: boolean; thinking?: boolean; thinking_efforts?: string[]; max_output?: number; context_window?: number; vision?: boolean }> }>) => {
        setProviderKeys(list.map((p) => p.key));
        setProviderModels(list.map((p) => ({
          key: p.key,
          models: (p.models ?? []).map((m) => ({
            id: m.id,
            selected: m.selected !== false,
            thinking: m.thinking === true,
            thinking_efforts: Array.isArray(m.thinking_efforts) ? m.thinking_efforts : undefined,
            // A-1xx：透传上游能力元数据，不再截断丢弃（此前只留 id/selected/thinking/efforts，
            // max_output/context_window/vision 全丢 → 发送时无法应用 max_tokens、上下文环无 cap）
            max_output: typeof m.max_output === "number" ? m.max_output : undefined,
            context_window: typeof m.context_window === "number" ? m.context_window : undefined,
            vision: m.vision === true,
          })),
        })));
      }).catch(console.error);
      api.providers.localList().then((list: LocalModelBrief[]) => {
        setLocalModels(list);
      }).catch(console.error);
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, []);

  /** 依赖下载进度：常驻订阅（问题修复：MindHubPanel 切 tab 卸载会丢事件） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.mind) { return; }
    void api.mind.downloadSnapshot("llama").then((p: DownloadProgressInfo) => setDl((prev) => ({ ...prev, llama: p }))).catch(() => {});
    void api.mind.downloadSnapshot("bge").then((p: DownloadProgressInfo) => setDl((prev) => ({ ...prev, bge: p }))).catch(() => {});
    const off = api.mind.onDownloadProgress((p: DownloadProgressInfo) => {
      setDl((prev) => ({ ...prev, [p.target]: p }));
    });
    return () => { off(); };
  }, []);

  /** 下载中轮询兜底：推送事件偶发丢失时，1s 拉一次快照保证进度条实时刷新 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.mind?.downloadSnapshot) { return; }
    const active = (Object.values(dl) as DownloadProgressInfo[]).some((p) => p.state === "downloading" || p.state === "paused");
    if (!active) { return; }
    const timer = window.setInterval(() => {
      void api.mind.downloadSnapshot("llama").then((p: DownloadProgressInfo) => setDl((prev) => ({ ...prev, llama: p }))).catch(() => {});
      void api.mind.downloadSnapshot("bge").then((p: DownloadProgressInfo) => setDl((prev) => ({ ...prev, bge: p }))).catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dl.llama?.state, dl.bge?.state]);

  /** 启动引导：主进程推送后端就绪状态 → 启动加载面板淡出 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.boot) { return; }
    void api.boot.status().then((s: BootStatus) => setBoot(s)).catch(() => {});
    const off = api.boot.onEvent((s: BootStatus) => setBoot(s));
    return () => { off(); };
  }, []);

  /** 本地模型加载进度弹窗（主进程在本地模型对话时推送） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.model) { return; }
    const off = api.model.onLoading((s: { loading: boolean; message?: string }) => setModelLoading(s));
    return () => { off(); };
  }, []);

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId) ?? null;
  const selectedAgentId = selectedSession?.agentId ?? null;
  const hasNoSession = selectedSession === null;

  /** 欢迎区首条消息：自动建会话 + 发送首条消息（修复：之前只建会话不发送） */
  const handleWelcomeSend = React.useCallback(async (text: string): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !text.trim()) { return; }
    // 1. 创建会话
    const res = await api.conversations.create().catch((e: unknown) => {
      console.error("[app] welcome create failed:", e);
      return null;
    });
    if (!res?.ok || !res.session) { return; }
    const sessionId = res.session.sessionId;
    setSelectedSessionId(sessionId);
    void loadSessions();
    // 2. 发送首条消息（延迟一小段时间确保 session 已切换）
    setTimeout(() => {
      if (!res?.session || !selectedAgentId) { return; }
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      if (!api?.chat?.stream) { return; }
      let netOn = false;
      try { netOn = localStorage.getItem("slime_network_enabled") === "1"; } catch { /* ignore */ }
      void api.chat.stream({ agentId: selectedAgentId, message: text.trim(), sessionId, networkEnabled: netOn }).catch((e: unknown) => {
        console.error("[app] welcome stream failed:", e);
      });
    }, 100);
    // 3. 保存例句到历史（用于个性化）
    const histories: string[] = [];
    try {
      const stored = localStorage.getItem("slime_welcome_examples");
      if (stored) histories.push(...JSON.parse(stored) as string[]);
    } catch { /* 忽略 */ }
    histories.push(text.trim());
    try {
      localStorage.setItem("slime_welcome_examples", JSON.stringify(histories.slice(-20)));
    } catch { /* 忽略 */ }
  }, []);

  /** 右侧栏工作树：随选择会话加载会话级工作目录（"以文件夹为主"：会话 workspace 优先，回退 Agent 级旧配置） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.configGet || !selectedSessionId || !selectedAgentId) {
      setSessionWorkspace("");
      return;
    }
    void api.conversations.configGet({ agentId: selectedAgentId, sessionId: selectedSessionId }).then((cfg: { workspace?: string }) => {
      setSessionWorkspace(cfg?.workspace ?? "");
    }).catch(() => setSessionWorkspace(""));
  }, [selectedSessionId, selectedAgentId]);

  /** A-954：探活自研 SILAM 脑（sidecar 拉起成功才在供应商面板出现）——启动 + 每次打开新建会话弹窗时重查 */
  const refreshSilamStatus = React.useCallback((): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    api?.silam?.status?.().then((r: { enabled: boolean }) => setSilamOk(r.enabled === true)).catch(() => setSilamOk(false));
  }, []);
  React.useEffect(() => { refreshSilamStatus(); }, [refreshSilamStatus]);

  /** A-954：群聊成员入群/退群/换模特方（model 选定的瞬间即正式入群；第一个入群者 = 组长/会话归属） */
  const joinDraftMember = React.useCallback((a: { id: string; name: string }, model: string): void => {
    setDraftMembers((prev) => {
      const idx = prev.findIndex((m) => m.id === a.id);
      const entry = { id: a.id, name: a.name, model };
      return idx >= 0 ? prev.map((m, i) => (i === idx ? entry : m)) : [...prev, entry];
    });
  }, []);
  const leaveDraftMember = React.useCallback((id: string): void => {
    setDraftMembers((prev) => prev.filter((m) => m.id !== id));
    if (draftCfgAgent === id) { setDraftCfgAgent(null); setDraftCfgProvider(null); }
  }, [draftCfgAgent]);

  /** A-968：把成员「已保存的 model_choice」解析成 draftProviders 里可入群的具体模型值（null=无/不可解析）。
   *  群聊三步入群时直接沿用角色保存的供应商/模型，无需重复选择。 */
  const resolveSavedModel = React.useCallback((agentId: string): string | null => {
    const choice = agentConfig[agentId]?.model_choice;
    if (!choice) { return null; }
    if (choice === "silam" || choice.startsWith("silam:")) { return silamOk ? "silam" : null; }
    if (choice.startsWith("local:")) {
      const id = choice.slice(6);
      const local = draftProviders.find((p) => p.kind === "local")?.models.find((m) => m.id === `local:${id}`);
      return local ? local.id : null;
    }
    if (choice.startsWith("api:")) {
      const rest = choice.slice(4);
      const sep = rest.indexOf(":");
      const key = sep >= 0 ? rest.slice(0, sep) : rest;
      const modelId = sep >= 0 ? rest.slice(sep + 1) : "";
      const prov = draftProviders.find((p) => p.kind === "api" && p.key === key);
      if (!prov || prov.models.length === 0) { return null; }
      if (!modelId) { return `api:${key}:${prov.models[0].id}`; } // 只选了供应商 → 用其首个启用模型
      const m = prov.models.find((x) => x.id === modelId);
      return m ? `api:${key}:${modelId}` : null;
    }
    return null;
  }, [agentConfig, draftProviders, silamOk]);

  /** 新建项目：选文件夹（①）+ 群聊成员三步入群（②，各带模型）+ 聊天形式 → 建团队/单人会话并切换（"以文件夹为主"模型）
   *  A-954：入群必须选定模型——成员条目 { id, model } 持久化；组长模型经 leaderModel 单独下传 */
  async function startNewProject(
    agentId: string,
    memberIds: Array<string | { id: string; model?: string }> = [],
    type: "normal" | "brainstorm" = "normal",
    leaderModel?: string,
  ): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.create({
      agentId,
      workspace: newDraftWorkspace === null ? null : (newDraftWorkspace || null),
      memberIds,
      leaderModel,
      type,
    }).catch((e: unknown) => {
      console.error("[app] create session failed:", e);
      return null;
    });
    if (res?.ok && res.session) {
      setSelectedSessionId(res.session.sessionId);
      setNewProjectOpen(false);
      setNewDraftWorkspace(null);
      setNewDraftLeader(null);
      setNewDraftMemberIds([]);
      setDraftMembers([]);
      setDraftCfgAgent(null);
      setDraftCfgProvider(null);
      await loadSessions();
    }
  }

  /** 选择目标工作文件夹（新建会话第一步；以文件夹为主的会话模型） */
  async function pickNewFolder(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.pickFolder) { return; }
    const res = await api.conversations.pickFolder().catch((e: unknown) => {
      console.error("[app] pick folder failed:", e);
      return null;
    });
    if (res?.ok && res.path) {
      setNewDraftWorkspace(res.path);
    }
  }

  /** 会话内切换调用的 Agent（保留工作文件夹/标题/历史；同文件夹多 Agent 协作） */
  async function switchSessionAgent(agentId: string): Promise<void> {
    if (!selectedSessionId) { return; }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.setAgent) { return; }
    await api.conversations.setAgent(selectedSessionId, agentId).catch((e: unknown) => {
      console.error("[app] switch agent failed:", e);
    });
    await loadSessions();
  }

  /** 打开新建会话弹窗（可选预填工作文件夹：文件夹分组内点＋、或全局点＋留空） */
  function openNewSessionDialog(prefillWorkspace?: string | null): void {
    setNewDraftWorkspace(prefillWorkspace === undefined ? null : prefillWorkspace);
    setNewDraftLeader(null);
    setNewDraftMemberIds([]);
    setNewDraftType("normal");
    setDraftMembers([]); // A-954：弹窗重开清空入群草稿，避免残留上个群聊的成员/模型
    setDraftCfgAgent(null);
    setDraftCfgProvider(null);
    setNewProjectOpen(true);
    // A-955 epoll：弹窗打开时刷新 SILAM 可用性（sidecar 冷启动成功后再探），确保供应商面板及时出现
    refreshSilamStatus();
    // 弹窗打开时刷新 Agent 列表，避免创建 Agent 后弹窗仍显示"暂无"
    void loadAgents();
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

  /** 删除文件夹分组：移除该工作目录下全部会话与历史（文件夹本身不动） */
  async function removeWorkspaceGroup(groupName: string, workspace: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    if (!(await confirmAsync(`删除工作区「${groupName}」？`, "其下全部会话与历史将一并清除（文件夹与 Agent 保留）。"))) {
      return;
    }
    const groupSessions = sessions.filter((s) => (s.workspace ?? "") === workspace);
    // 批量删除：主进程一次清元数据 + 各会话历史（文件夹级语义，旧实现为逐会话循环）
    // 注意：旧会话 workspace 为 undefined，removeSessionsForWorkspace("") 匹配不到 → 空分组回退逐会话删除
    if (api.conversations?.removeWorkspace && workspace) {
      await api.conversations.removeWorkspace(workspace).catch(console.error);
    } else {
      for (const s of groupSessions) {
        await api.conversations.remove(s.sessionId).catch(console.error);
      }
    }
    // 若正在展示其中的会话，切到剩余会话
    if (groupSessions.some((s) => s.sessionId === selectedSessionId)) {
      const rest = sessions.filter((s) => !groupSessions.some((gs) => gs.sessionId === s.sessionId));
      setSelectedSessionId(rest.length > 0 ? rest[0].sessionId : null);
    }
    await loadSessions();
  }

  const currentModel = agentConfig[selectedAgentId ?? ""]?.model_choice ?? "inherit";
  const currentMode = agentConfig[selectedAgentId ?? ""]?.mode ?? "build";
  const currentReasoning = agentConfig[selectedAgentId ?? ""]?.reasoning_effort ?? "none";
  const currentThinking = agentConfig[selectedAgentId ?? ""]?.show_thinking !== "0";

  /** 更新 Agent 配置：本地乐观更新 + 等后端落库 + localStorage 持久化 */
  async function updateAgentConfig(patch: Record<string, string>): Promise<void> {
    if (!selectedAgentId) { return; }
    // 用户交互写入：递增代次，作废一切更早发起的后台 detail 快照
    agentCfgEpochRef.current[selectedAgentId] = (agentCfgEpochRef.current[selectedAgentId] ?? 0) + 1;
    setAgentConfig((prev) => ({ ...prev, [selectedAgentId]: { ...((prev[selectedAgentId] ?? {}) as Record<string, string>), ...patch } }));
    // 立即写 localStorage，确保关闭后重开不丢失
    try {
      const raw = localStorage.getItem("slime_agent_config");
      const store: Record<string, Record<string, string>> = raw ? JSON.parse(raw) : {};
      store[selectedAgentId] = { ...(store[selectedAgentId] ?? {}), ...patch };
      localStorage.setItem("slime_agent_config", JSON.stringify(store));
    } catch { /* ignore */ }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    try {
      await api.agents.update(selectedAgentId, patch);
    } catch (e) {
      console.error("[app] agent config update failed:", e);
    }
  }

  // 文件夹分组：目标工作文件夹 → 会话列表（旧数据无 workspace → "未绑定文件夹"；排序：更新时间降序）
  const groups = React.useMemo(() => {
    const byWs = new Map<string, SessionItem[]>();
    for (const s of sessions) {
      const ws = s.workspace ?? "";
      const list = byWs.get(ws) ?? [];
      list.push(s);
      byWs.set(ws, list);
    }
    const out: Array<{ workspace: string; displayName: string; items: SessionItem[] }> = [];
    for (const [ws, items] of byWs) {
      out.push({
        workspace: ws,
        displayName: ws ? pathBase(ws) : "未绑定文件夹",
        items: [...items].sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1)),
      });
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
      {/* 启动加载面板（A-C-C 风格）：backend / 首屏数据就绪前持续显示，加载动画不停 */}
      {boot && (boot.phase === "starting" || boot.phase === "backend" || (boot.phase === "ready" && !uiReady)) && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          background: "var(--bg)", display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{
              width: 64, height: 64, borderRadius: 16, margin: "0 auto 14px",
              background: "linear-gradient(135deg, var(--accent), #6366f1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 30, fontWeight: 900, color: "#fff",
            }}>S</div>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6, color: "var(--text)" }}>slime</div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 14 }}>
              {boot.phase === "ready" && !uiReady ? "正在加载工作区与会话…" : (boot.message ?? "正在初始化…")}
            </div>
            <div style={{
              width: 180, height: 5, borderRadius: 3, background: "var(--border)", margin: "0 auto",
              overflow: "hidden",
            }}>
              <div style={{
                width: "40%", height: "100%", borderRadius: 3,
                background: "var(--accent)",
                animation: "slime-boot-slide 1.1s ease-in-out infinite",
              }} />
            </div>
            <style>{`@keyframes slime-boot-slide { 0% { transform: translateX(-120%);} 100% { transform: translateX(320%);} }`}</style>
          </div>
        </div>
      )}

      {/* 本地模型加载进度弹窗（slime 主题；llama-server 首次加载可能数十秒~两分钟） */}
      {modelLoading.loading && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(2, 6, 23, 0.66)", backdropFilter: "blur(2px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            width: 360, borderRadius: 16, padding: "24px 26px",
            background: "var(--bg-input)", border: "1px solid var(--border)",
            textAlign: "center",
          }}>
            <div style={{
              width: 54, height: 54, borderRadius: 14, margin: "0 auto 14px",
              background: "linear-gradient(135deg, var(--accent), #6366f1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, fontWeight: 900, color: "#fff", boxShadow: "0 4px 18px rgba(56,189,248,0.35)",
            }}>L</div>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8, color: "var(--text)" }}>正在加载本地模型</div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 16 }}>
              {modelLoading.message ?? "首次加载可能需要数十秒，请稍候…"}
            </div>
            <div style={{
              width: "100%", height: 5, borderRadius: 3, background: "var(--border)",
              overflow: "hidden",
            }}>
              <div style={{
                width: "40%", height: "100%", borderRadius: 3, background: "var(--accent)",
                animation: "slime-boot-slide 1.1s ease-in-out infinite",
              }} />
            </div>
            {/* 等待秒数与 60s 卡住提醒：WaitSecClock 自计时，只重渲染自身（A-129） */}
            <WaitSecClock />
            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                className="btn"
                style={{ fontSize: 12.5, padding: "6px 18px", color: "var(--warning)" }}
                onClick={() => {
                  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
                  if (api?.chat?.cancel && modelLoading.key) {
                    void api.chat.cancel(modelLoading.key).catch(console.error);
                  }
                }}
              >
                取消加载
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12 }}>
              模型就绪后自动关闭，可继续对话
            </div>
          </div>
        </div>
      )}

      {/* 自绘标题栏（右侧为系统窗口按钮 overlay） */}
      <header className="titlebar">
        <button className="titlebar-btn" onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}>
          <MenuIcon size={16} />
        </button>
        <span className="titlebar-title">slime — Agent 管理面板</span>
        <span style={{ flex: 1 }} />
        {/* 右侧栏展开/收起（工作树 / 任务 / 终端 / 浏览器） */}
        <button className={`titlebar-btn${rightOpen ? " titlebar-btn-active" : ""}`}
          onClick={() => setRightOpen(!rightOpen)}
          title={rightOpen ? "收起右侧栏" : "展开右侧栏（工作树 / 任务 / 终端 / 浏览器）"}>
          {rightOpen ? <SidebarLeftIcon size={16} /> : <SidebarRightIcon size={16} />}
        </button>
      </header>

      <div className="body">
        {/* 左侧导航侧栏 —— A-946：侧栏不参与整体挤压（flexShrink:0），展开态最小 140px，防止变窄时按钮/文本被吞 */}
        <aside
          className={`sidebar${sidebarOpen ? "" : " collapsed"}`}
          style={{ width: sidebarWidth, flexShrink: 0, minWidth: sidebarOpen ? 280 : 0 }}
        >
          {sidebarOpen && <div className="sidebar-resizer" onMouseDown={handleSidebarResize} />}
          <div className="brand">
            <div className="brand-icon">S</div>
            <span className="brand-name">slime</span>
          </div>
          <div className="sidebar-sep" />

          {/* 对话区块：目标工作文件夹分组 + 会话（会话内指定调用 Agent） */}
          <div style={{ display: "flex", alignItems: "center", padding: "0 12px 6px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--text-muted)", flex: 1 }}>
              工作区
            </span>
            <button className="titlebar-btn" title="新建会话：先选目标工作文件夹，再选要调用的 Agent"
              onClick={() => openNewSessionDialog(null)}>
              <PlusIcon size={14} />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
            {groups.map((g) => {
              const isCollapsed = collapsed[g.workspace] ?? false;
              return (
                <div key={g.workspace || "__unbound__"} style={{ marginBottom: 4 }}>
                  {/* 文件夹头（目录名）：点击折叠/展开；右侧 ＋ 新建会话/删除工作区 */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "5px 8px", borderRadius: 8, cursor: "pointer",
                  }}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [g.workspace]: !(prev[g.workspace] ?? false) }))}>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", width: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", transition: "transform 0.12s" }}>
                      <ChevronIcon size={12} rotate={isCollapsed ? -90 : 90} />
                    </span>
                    <span style={{
                      flex: 1, fontSize: 12, fontWeight: 700,
                      color: g.workspace ? "var(--accent-hover)" : "var(--text-muted)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }} title={g.workspace || "未绑定文件夹的旧会话"}>
                      {g.displayName}
                    </span>
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{g.items.length}</span>
                    <button className="titlebar-btn" style={{ fontSize: 13 }}
                      title="在该文件夹内新建会话（再选调用的 Agent）"
                      onClick={(e) => { e.stopPropagation(); openNewSessionDialog(g.workspace || ""); }}>
                      <PlusIcon size={13} />
                    </button>
                    <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.65 }}
                      title="删除工作区（清空其下全部会话与历史，文件夹本身保留）"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeWorkspaceGroup(g.displayName, g.workspace);
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
                            {/* A-945：会话图标（用户选定）——群聊用团队图标、普通会话用当前会话图标 */}
                        <img
                          src={s.type === "brainstorm" ? teamSvg : currentSessionSvg}
                          alt=""
                          style={{
                            width: 14, height: 14, flexShrink: 0, borderRadius: 3,
                            opacity: active ? 1 : 0.72,
                          }}
                        />
                        {/* Agent 徽标：群聊显示「群聊」（组长是用户，不展示单一 Agent 名）；普通显示会话归属 Agent */}
                            <span style={{
                              fontSize: 10, fontWeight: 700, flexShrink: 0,
                              padding: "1px 6px", borderRadius: 8,
                              background: s.type === "brainstorm" ? "var(--bg-hover)" : "var(--accent-soft)",
                              color: s.type === "brainstorm" ? "var(--text-secondary)" : "var(--accent-hover)",
                              maxWidth: 64, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }} title={s.type === "brainstorm" ? "群聊（你收束讨论）" : s.agentName}>
                              {s.type === "brainstorm" ? "群聊" : s.agentName}
                            </span>
                            {/* 团队成员徽章：群聊=含归属 Agent 在内的全部参与数；普通旧团队会话=既有成员数 */}
                            {(s.type === "brainstorm" || (Array.isArray(s.memberNames) && s.memberNames.length > 0)) && (
                              <span
                                title={s.type === "brainstorm"
                                  ? `群聊共 ${(s.memberNames?.length ?? 0) + 1} 人（会话归属 Agent 仅内部路由，无领导）`
                                  : `团队成员：${s.memberNames!.join("、")}`}
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0,
                                  fontSize: 9.5, color: "var(--text-muted)",
                                  background: "var(--bg-input)", border: "1px solid var(--border)",
                                  borderRadius: 8, padding: "1px 5px",
                                  maxWidth: 84, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                }}>
                                {s.type === "brainstorm" ? `成员 ${(s.memberNames?.length ?? 0) + 1}` : `成员 ${s.memberNames!.length}`}
                              </span>
                            )}
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
                              <EditIcon size={14} />
                            </button>
                            <button className="titlebar-btn" style={{ fontSize: 11, opacity: 0.6 }}
                              title="删除会话"
                              onClick={(e) => {
                                e.stopPropagation();
                                void (async () => {
                                  if (await confirmAsync(`删除会话「${s.title}」？`, "其对话历史将一并清除。")) {
                                    await removeSession(s.sessionId);
                                  }
                                })();
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
                暂无会话 — 点击"＋"新建（先选工作文件夹，再选 Agent）
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
              <SettingsIcon size={18} />
            </button>
          </div>
        </aside>

        {/* 主内容区（对话面板常驻） */}
        <main className="main">
          {hasNoSession ? (
            <WelcomeChat
              onSend={handleWelcomeSend}
              agents={agents}
              onChooseAgent={(agentId) => { void startNewProject(agentId); return Promise.resolve(); }}
              onOpenAgents={() => { setSettingsTab("agents"); setSettingsOpen(true); }}
            />
          ) : selectedSession && selectedAgentId ? (
            <ChatPanel
              sessionId={selectedSession.sessionId}
              sessionTitle={selectedSession.title}
              sessionType={selectedSession.type}
              memberCount={selectedSession.type === "brainstorm" ? (selectedSession.memberIds?.length ?? 0) + 1 : 0}
              memberNames={selectedSession.memberNames ?? []}
              agentId={selectedAgentId}
              agentName={selectedSession.agentName}
              workspace={selectedSession.workspace}
              modelChoice={currentModel}
              mode={currentMode}
              reasoningEffort={currentReasoning}
              showThinking={currentThinking}
              providerKeys={providerKeys}
              providerModels={providerModels}
              localModels={localModels}
              agents={agents}
              onAgentSwitch={(agentId) => { void switchSessionAgent(agentId); }}
              onModelChange={(v) => updateAgentConfig({ model_choice: v })}
              onModeChange={(v) => updateAgentConfig({ mode: v })}
              onReasoningChange={(v) => updateAgentConfig({ reasoning_effort: v })}
              onThinkingChange={(v) => updateAgentConfig({ show_thinking: v ? "1" : "0" })}
              onConversationsChanged={() => void loadSessions()}
              onSessionRenamed={(title) => {
                if (selectedSession) {
                  void apiUpdateSessionTitle(selectedSession.sessionId, title);
                }
              }}
              onNewSessionRequested={() => {
                openNewSessionDialog(selectedSession?.workspace ?? "");
              }}
              onNavigateSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)" }}>
              请点击侧栏"＋"新建会话（先选工作文件夹，再选 Agent）
            </div>
          )}
        </main>

        {/* 右侧栏（工作树 / 任务 / 终端 / 浏览器） */}
        <RightSidebar
          open={rightOpen}
          onToggle={() => setRightOpen(!rightOpen)}
          agentId={selectedAgentId}
          agentName={selectedSession?.agentName ?? ""}
          sessionId={selectedSession?.sessionId}
          sessionType={selectedSession?.type}
          memberIds={selectedSession?.memberIds ?? []}
          memberModels={selectedSession?.memberModels ?? {}}
          leaderModel={selectedSession?.leaderModel}
          workspace={sessionWorkspace}
          providerModels={providerModels}
          dl={dl}
          width={rightWidth}
          onResize={handleRightbarResize}
        />
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
          dl={dl}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {/* ── 新建会话弹窗（以目标工作文件夹为主：先选文件夹 → 再选调用的 Agent） ── */}
      {newProjectOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100,
          // A-955：弹窗遮罩磨砂化——半透明基础上加 backdrop blur，中和过透观感
          background: "rgba(2, 6, 23, 0.74)",
          backdropFilter: "blur(14px) saturate(1.2)",
          WebkitBackdropFilter: "blur(14px) saturate(1.2)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setNewProjectOpen(false); } }}>
          <div className="card" style={{
            width: 480, maxWidth: "92vw", maxHeight: "76vh",
            display: "flex", flexDirection: "column",
            // 面板本体：更高不透明度 + 微 blur，磨砂面板观感
            background: "var(--bg-card, rgba(22, 30, 56, 0.9))",
            backdropFilter: "blur(18px) saturate(1.15)",
            WebkitBackdropFilter: "blur(18px) saturate(1.15)",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, flex: 1 }}>新建会话</h3>
              <button className="titlebar-btn" onClick={() => setNewProjectOpen(false)}></button>
            </div>
            {/* 第一步：选择目标工作文件夹 */}
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700 }}>
              ① 目标工作文件夹（Agent 的读写将限定在此目录内）
            </div>
            {newDraftWorkspace ? (
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                border: "1px solid var(--border)", borderRadius: 8,
                background: "var(--bg-input)", padding: "8px 10px", marginBottom: 8,
              }}>
                <span style={{
                  flex: 1, fontSize: 12.5, color: "var(--accent-hover)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl",
                }} title={newDraftWorkspace}>{newDraftWorkspace}</span>
                <button className="btn" style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
                  onClick={() => void pickNewFolder()}>更换</button>
                <button className="btn" style={{ fontSize: 12, padding: "3px 10px", whiteSpace: "nowrap" }}
                  onClick={() => setNewDraftWorkspace("")}>清除</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button className="btn primary" style={{ flex: 1, fontSize: 12.5 }}
                  onClick={() => void pickNewFolder()}>
                  📁 选择文件夹…
                </button>
                <button className="btn" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}
                  onClick={() => setNewDraftWorkspace("")}>
                  跳过（不绑定文件夹）
                </button>
              </div>
            )}
            {/* A-943：聊天形式选择（普通对话 ⇔ 群聊头脑风暴；群聊为独立聊天形式） */}
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700, marginTop: 10 }}>
              聊天形式
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <button
                onClick={() => setNewDraftType("normal")}
                style={{
                  display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                  padding: "9px 11px", borderRadius: 10, cursor: "pointer",
                  border: newDraftType === "normal" ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                  background: newDraftType === "normal" ? "var(--accent-soft)" : "var(--bg-input)",
                }}>
                {/* A-945：普通对话卡片图标 = 用户选定的「当前会话」图标（无背景，纯图标） */}
                <img src={currentSessionSvg} alt="普通对话" style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: newDraftType === "normal" ? "var(--accent-hover)" : "var(--text)" }}>普通对话</span>
                  <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>一对一；子任务自动委派子代理</span>
                </span>
              </button>
              <button
                onClick={() => setNewDraftType("brainstorm")}
                style={{
                  display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                  padding: "9px 11px", borderRadius: 10, cursor: "pointer",
                  border: newDraftType === "brainstorm" ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                  background: newDraftType === "brainstorm" ? "var(--accent-soft)" : "var(--bg-input)",
                }}>
                <img src={teamSvg} alt="群聊" style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: newDraftType === "brainstorm" ? "var(--bg-hover)" : "transparent",
                }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: newDraftType === "brainstorm" ? "var(--accent-hover)" : "var(--text)" }}>群聊头脑风暴</span>
                  <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>全员并行发言、互相纠错</span>
                </span>
              </button>
            </div>
            {/* 第二步：普通 = 选择对话 Agent（单聊，子代理自动委派）；群聊 = 成员三步入群（a 成员 → b 供应商 → c 模型，A-954） */}
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700 }}>
              {newDraftType === "brainstorm"
                ? "② 群成员三步入群（点成员 → 选供应商 → 选模型即入群，第一个入群者为组长；已入群 ≥2 可创建）"
                : "② 选择对话的 Agent（单击选中；子任务会自动委派子代理）"}
            </div>
            {newDraftType === "brainstorm" ? (
              <div style={{ display: "flex", gap: 10 }}>
                {/* 左列：成员候选（点击展开右侧配置面板；已入群显示模型徽章） */}
                <div style={{ flex: 1, minWidth: 0, maxHeight: 214, overflowY: "auto" }}>
                  {agents.map((a) => {
                    const joined = draftMembers.find((m) => m.id === a.id);
                    const cfg = draftCfgAgent === a.id;
                    return (
                      <button key={a.id}
                        onClick={() => {
                          if (cfg) { setDraftCfgAgent(null); setDraftCfgProvider(null); return; }
                          // A-968：该角色已保存过供应商/模型 → 直接沿用入群（无需重选）；无保存则保持手动两步
                          const saved = resolveSavedModel(a.id);
                          if (saved) {
                            joinDraftMember(a, saved);
                            const key = saved.startsWith("api:")
                              ? saved.split(":")[1]
                              : saved.startsWith("local:")
                                ? "local"
                                : saved === "silam"
                                  ? "silam"
                                  : undefined;
                            if (key) { setDraftCfgProvider(key); }
                          }
                          setDraftCfgAgent(a.id);
                          if (!saved) { setDraftCfgProvider(null); }
                        }}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "6px 10px", marginBottom: 4, borderRadius: 8, cursor: "pointer",
                          border: joined || cfg ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                          background: cfg ? "var(--bg-hover)" : joined ? "var(--accent-soft)" : "var(--bg-input)",
                        }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: joined || cfg ? "var(--accent-hover)" : "var(--text)", whiteSpace: "nowrap" }}>{a.name}</span>
                          {joined ? (
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: "var(--success)",
                              background: "var(--success-soft)", borderRadius: 8, padding: "0 6px",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120,
                              flexShrink: 1,
                            }}>
                              已入群 · {joined.model}
                            </span>
                          ) : cfg ? (
                            <span style={{ fontSize: 10, color: "var(--warning)", whiteSpace: "nowrap" }}>待选模型</span>
                          ) : null}
                        </div>
                        {a.role && (
                          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {a.role}
                          </div>
                        )}
                      </button>
                    );
                  })}
                  {agents.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "20px 14px" }}>
                      暂无可调用的 Agent，请先创建
                    </div>
                  )}
                </div>
                {/* 右列：供应商 → 模型 两步配置面板 */}
                <div style={{
                  flex: 1, minWidth: 0, maxHeight: 214, overflowY: "auto",
                  border: "1px solid var(--border)", borderRadius: 8, padding: 8, background: "var(--bg-input)",
                }}>
                  {!draftCfgAgent ? (
                    <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
                      点击左侧成员，为其选择入群模型：<br />① 供应商 → ② 模型（选定即入群）。<br />
                      <span style={{ color: "var(--accent-hover)" }}>已配置过供应商/模型的角色会直接沿用自动入群</span>。
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                        配置「{agents.find((a) => a.id === draftCfgAgent)?.name ?? ""}」· 供应商
                      </div>
                      {draftProviders.length === 0 ? (
                        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
                          暂无可用供应商/模型。<br />请到「管理 Agent →」的供应商设置中添加并启用模型。
                        </div>
                      ) : (
                        <>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                            {draftProviders.map((p) => {
                              const sel = draftCfgProvider === p.key;
                              const kindStyle = p.kind === "silam" ? { color: "var(--success)", background: "var(--success-soft)" } : p.kind === "local" ? { color: "var(--warning)", background: "var(--bg-hover)" } : { color: "var(--accent-hover)", background: "var(--accent-soft)" };
                              return (
                                <button key={p.key}
                                  onClick={() => setDraftCfgProvider(p.key)}
                                  style={{
                                    fontSize: 11, padding: "3px 9px", borderRadius: 8, cursor: "pointer",
                                    border: sel ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                                    ...(sel ? { color: "var(--accent-hover)", background: "var(--accent-soft)" } : kindStyle),
                                  }}>
                                  {p.label}
                                </button>
                              );
                            })}
                          </div>
                          {(() => {
                            const prov = draftCfgProvider ? draftProviders.find((p) => p.key === draftCfgProvider) : null;
                            if (!prov) {
                              return <div style={{ fontSize: 11, color: "var(--text-dim)" }}>选择供应商后展示其可选模型</div>;
                            }
                            return (
                              <>
                                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                                  模型（点击即入群）
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  {prov.models.map((m) => {
                                    const modelVal = prov.kind === "api" ? `api:${prov.key}:${m.id}` : m.id;
                                    const joined = draftMembers.find((x) => x.id === draftCfgAgent);
                                    const active = joined?.model === modelVal;
                                    const target = agents.find((a) => a.id === draftCfgAgent);
                                    return (
                                      <button key={m.id}
                                        onClick={() => target && joinDraftMember(target, modelVal)}
                                        style={{
                                          display: "flex", alignItems: "center", gap: 6, textAlign: "left",
                                          fontSize: 11.5, padding: "5px 9px", borderRadius: 7, cursor: "pointer",
                                          border: active ? "1.5px solid var(--success)" : "1px solid var(--border)",
                                          background: active ? "var(--success-soft)" : "transparent",
                                          color: "var(--text)",
                                        }}>
                                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
                                        {typeof m.ctx === "number" && m.ctx > 0 && (
                                          <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{m.ctx} ctx</span>
                                        )}
                                        {active && <span style={{ fontSize: 10.5, color: "var(--success)", marginLeft: "auto" }}>✓ 已选</span>}
                                      </button>
                                    );
                                  })}
                                </div>
                              </>
                            );
                          })()}
                        </>
                      )}
                      {(() => {
                        const joined = draftMembers.find((x) => x.id === draftCfgAgent);
                        if (!joined) { return null; }
                        return (
                          <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontSize: 11, color: "var(--success)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              已入群：{joined.model}
                            </span>
                            <button className="btn" style={{ fontSize: 11, padding: "2px 10px", whiteSpace: "nowrap", flexShrink: 0 }}
                              onClick={() => leaveDraftMember(joined.id)}>
                              退出群聊
                            </button>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              </div>
            ) : (
            <div style={{ maxHeight: 168, overflowY: "auto" }}>
              {agents.map((a) => {
                const isLeader = newDraftLeader === a.id;
                const selected = isLeader;
                return (
                  <button key={a.id}
                    onClick={() => {
                      setNewDraftLeader(a.id);
                      // 组长变更时，成员的候选池不变；已选成员若恰好是新的组长则自动剔除
                      setNewDraftMemberIds((prev) => prev.filter((id) => id !== a.id));
                    }}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "7px 12px", marginBottom: 4,
                      borderRadius: 8, cursor: "pointer",
                      border: selected ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                      background: selected ? "var(--accent-soft)" : "var(--bg-input)",
                      boxShadow: selected ? "0 0 0 1px var(--accent-soft)" : "none",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: selected ? "var(--accent-hover)" : "var(--text)" }}>{a.name}</span>
                      {selected && (
                        <span style={{
                          fontSize: 10.5, fontWeight: 700,
                          color: "var(--accent-hover)",
                          background: "var(--bg-input)", borderRadius: 8, padding: "0 6px",
                        }}>
                          已选
                        </span>
                      )}
                    </div>
                    {a.role && (
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.role}
                      </div>
                    )}
                  </button>
                );
              })}
              {agents.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "20px 14px" }}>
                  暂无可调用的 Agent，请先创建
                </div>
              )}
            </div>
            )}
            {/* 创建按钮 */}
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <button className="btn" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}
                onClick={() => { setNewProjectOpen(false); setSettingsTab("agents"); setSettingsOpen(true); }}>
                管理 Agent →
              </button>
              {(newDraftType === "brainstorm" ? draftMembers.length >= 2 : Boolean(newDraftLeader)) && (
                <button
                  className="btn primary"
                  disabled={agents.length === 0 || (newDraftType === "brainstorm" && draftMembers.length < 2)}
                  style={{ fontSize: 13, padding: "6px 20px", whiteSpace: "nowrap" }}
                  onClick={() => void (newDraftType === "brainstorm"
                    ? startNewProject(draftMembers[0].id, draftMembers.slice(1).map((m) => ({ id: m.id, model: m.model })), "brainstorm", draftMembers[0].model)
                    : startNewProject(newDraftLeader!, [], "normal"))}
                  title={newDraftType === "brainstorm"
                    ? `创建群聊（${draftMembers.length} 人已选模型入群，第一位为组长）`
                    : (newDraftMemberIds.length > 0
                      ? `创建团队会话：组长 ${agents.find((a) => a.id === newDraftLeader)?.name} + ${newDraftMemberIds.length} 名成员`
                      : "创建单人会话")}
                >
                  {newDraftType === "brainstorm"
                    ? `创建群聊（${draftMembers.length} 人 · 已选模型）`
                    : (newDraftMemberIds.length > 0
                      ? `创建团队（组长 1 · 成员 ${newDraftMemberIds.length}）`
                      : "创建会话")}
                </button>
              )}
              {newDraftType === "normal" && !newDraftLeader && (
                <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  选择组长后创建（同一文件夹可建多个团队/群聊/会话）
                </span>
              )}
              {newDraftType === "brainstorm" && draftMembers.length < 2 && (
                <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  {draftMembers.length === 0 ? "请先为至少 2 名成员选好模型入群" : "再入群 1 名成员即满 2 人，可创建"}
                </span>
              )}
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

  function handleSidebarResize(e: React.MouseEvent): void {
    e.preventDefault();
    document.body.classList.add("slime-resizing");
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    let lastW = startWidth;
    const onMove = (ev: MouseEvent): void => {
      // 左栏：鼠标向右 → 变宽
      lastW = Math.max(280, Math.min(520, ev.clientX - startX + startWidth));
      setSidebarWidth(lastW);
    };
    const onUp = (): void => {
      document.body.classList.remove("slime-resizing");
      localStorage.setItem('slime_sidebar_w', String(lastW));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // 拖动中窗口失焦（alt-tab 等）兜底结束拖拽，避免 slime-resizing 残留
    window.addEventListener('blur', onUp);
  }

  function handleRightbarResize(e: React.MouseEvent): void {
    e.preventDefault();
    document.body.classList.add("slime-resizing");
    const startX = e.clientX;
    const startWidth = rightWidthRef.current;
    let lastW = startWidth;
    const onMove = (ev: MouseEvent): void => {
      // 右栏：鼠标向左 → 变宽（范围 260–900；A-968 放宽上限以支撑 diff/图片/长文件完整观察）
      lastW = Math.max(260, Math.min(900, startX - ev.clientX + startWidth));
      setRightWidth(lastW);
    };
    const onUp = (): void => {
      document.body.classList.remove("slime-resizing");
      localStorage.setItem('slime_rightbar_w', String(lastW));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // 拖动中窗口失焦（alt-tab 等）兜底结束拖拽，避免 slime-resizing 残留
    window.addEventListener('blur', onUp);
  }
}