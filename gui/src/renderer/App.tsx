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
  const [sidebarWidth, setSidebarWidth] = React.useState(() => parseInt(localStorage.getItem('slime_sidebar_w') || '200'));
  /** 右侧栏（工作树/任务/终端/浏览器）展开状态 */
  const [rightOpen, setRightOpen] = React.useState(true);
  const [rightWidth, setRightWidth] = React.useState(() => parseInt(localStorage.getItem('slime_rightbar_w') || '320'));
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
  /** 行内重命名状态 */
  const [editingSession, setEditingSession] = React.useState<{ sessionId: string; draft: string } | null>(null);
  /** 依赖下载任务状态（全局常驻订阅：切走设置页进度不丢失） */
  const [dl, setDl] = React.useState<Record<string, DownloadProgressInfo>>({});
  /** 启动引导状态（A-C-C 式启动加载面板） */
  const [boot, setBoot] = React.useState<BootStatus | null>(null);
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

  /** 新建项目：选文件夹（①）+ 组长（②）+ 成员（③）→ 建团队/单人会话并切换（"以文件夹为主"模型） */
  async function startNewProject(agentId: string, memberIds: string[] = []): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.create({
      agentId,
      workspace: newDraftWorkspace === null ? null : (newDraftWorkspace || null),
      memberIds,
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
      await loadSessions();
    }
  }

  /** 团队会话成员更新（组长=会话当前 agentId；空数组=退回单人会话） */
  async function updateSessionMembers(memberIds: string[]): Promise<void> {
    if (!selectedSessionId) { return; }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.setMembers) { return; }
    await api.conversations.setMembers(selectedSessionId, memberIds).catch((e: unknown) => {
      console.error("[app] set session members failed:", e);
    });
    await loadSessions();
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
    setNewProjectOpen(true);
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
      {/* 启动加载面板（A-C-C 风格：等待后端等进程就绪后进入主界面） */}
      {boot && (boot.phase === "starting" || boot.phase === "backend") && (
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
              {boot.message ?? "正在初始化…"}
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
        {/* 左侧导航侧栏 */}
        <aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`} style={{ width: sidebarWidth }}>
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
                            {/* Agent 徽标（会话组长，可切换） */}
                            <span style={{
                              fontSize: 10, fontWeight: 700, flexShrink: 0,
                              padding: "1px 6px", borderRadius: 8,
                              background: "var(--accent-soft)", color: "var(--accent-hover)",
                              maxWidth: 64, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }} title={s.agentName}>{s.agentName}</span>
                            {/* 团队成员徽章（团队会话：一个会话 = 一个团队，成员各司其职） */}
                            {Array.isArray(s.memberNames) && s.memberNames.length > 0 && (
                              <span
                                title={`团队成员：${s.memberNames.join("、")}`}
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0,
                                  fontSize: 9.5, color: "var(--text-muted)",
                                  background: "var(--bg-input)", border: "1px solid var(--border)",
                                  borderRadius: 8, padding: "1px 5px",
                                  maxWidth: 84, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                }}>
                                成员 {s.memberNames.length}
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
              memberIds={selectedSession.memberIds ?? []}
              memberNames={selectedSession.memberNames ?? []}
              onMembersChanged={(ids) => { void updateSessionMembers(ids); }}
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
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(2, 6, 23, 0.66)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) { setNewProjectOpen(false); } }}>
          <div className="card" style={{ width: 480, maxWidth: "92vw", maxHeight: "76vh", display: "flex", flexDirection: "column" }}>
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
            {/* 第二步：选择组长 Agent（单选，点击选中；组长统筹规划、拆解派单） */}
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700 }}>
              ② 选择组长 Agent（统筹规划、拆解派单；会话内可随时切换）
            </div>
            <div style={{ maxHeight: 168, overflowY: "auto" }}>
              {agents.map((a) => {
                const isLeader = newDraftLeader === a.id;
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
                      border: isLeader ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                      background: isLeader ? "var(--accent-soft)" : "var(--bg-input)",
                      boxShadow: isLeader ? "0 0 0 1px var(--accent-soft)" : "none",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: isLeader ? "var(--accent-hover)" : "var(--text)" }}>{a.name}</span>
                      {isLeader && <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--accent-hover)", background: "var(--bg-input)", borderRadius: 8, padding: "0 6px" }}>组长</span>}
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
            {/* 第三步：选择团队成员（多选，可选；成员各司其职，由组长派单指挥 — 一个会话 = 一个团队） */}
            {newDraftLeader && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6, fontWeight: 700 }}>
                  ③ 选择团队成员（可多选，可选 — 成员各司其职，由组长派单指挥）
                </div>
                <div style={{ maxHeight: 128, overflowY: "auto", display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {agents.filter((a) => a.id !== newDraftLeader).map((a) => {
                    const sel = newDraftMemberIds.includes(a.id);
                    return (
                      <button key={a.id}
                        onClick={() => setNewDraftMemberIds((prev) =>
                          sel ? prev.filter((id) => id !== a.id) : [...prev, a.id])}
                        title={a.role || "无角色"}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          padding: "4px 10px", borderRadius: 12, cursor: "pointer",
                          border: sel ? "1px solid var(--accent)" : "1px solid var(--border)",
                          background: sel ? "var(--accent-soft)" : "var(--bg-input)",
                          color: sel ? "var(--accent-hover)" : "var(--text-muted)",
                          fontSize: 12, fontWeight: sel ? 700 : 600, whiteSpace: "nowrap",
                        }}>
                        <span style={{
                          width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                          background: sel ? "var(--accent)" : "transparent",
                          border: sel ? "none" : "1px solid var(--border)",
                        }} />
                        {a.name}
                      </button>
                    );
                  })}
                </div>
                {newDraftMemberIds.length > 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                    已选 {newDraftMemberIds.length} 名成员 — 组长会将任务拆解后派单给对应成员，成员答复在本会话内群聊展示
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
              {newDraftLeader && (
                <button
                  className="btn primary"
                  disabled={agents.length === 0}
                  style={{ fontSize: 13, padding: "6px 20px", whiteSpace: "nowrap" }}
                  onClick={() => void startNewProject(newDraftLeader, newDraftMemberIds)}
                  title={newDraftMemberIds.length > 0
                    ? `创建团队会话：组长 ${agents.find((a) => a.id === newDraftLeader)?.name} + ${newDraftMemberIds.length} 名成员`
                    : "创建单人会话"}
                >
                  {newDraftMemberIds.length > 0
                    ? `创建团队（组长 1 · 成员 ${newDraftMemberIds.length}）`
                    : "创建会话"}
                </button>
              )}
              {!newDraftLeader && (
                <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  选择组长后创建（同一文件夹可建多个团队/会话）
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
      lastW = Math.max(140, Math.min(500, ev.clientX - startX + startWidth));
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
      // 右栏：鼠标向左 → 变宽（范围 260–600 与 CSS/项目规格一致）
      lastW = Math.max(260, Math.min(600, startX - ev.clientX + startWidth));
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