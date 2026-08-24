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
import type { DownloadProgressInfo, BootStatus } from "../shared/ipc.js";
import { ChevronIcon, EditIcon, MenuIcon, PlusIcon, SettingsIcon, SidebarLeftIcon, SidebarRightIcon } from "./components/Icon.js";
import { getTheme, applyTheme, type ThemeName } from "./theme.js";

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
  models: Array<{ id: string; selected?: boolean }>;
}

interface SessionItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string;
  count: number;
  lastTime: string;
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

export default function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("general");
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [sidebarWidth, setSidebarWidth] = React.useState(() => parseInt(localStorage.getItem('slime_sidebar_w') || '200'));
  /** 右侧栏（工作树/任务/终端/浏览器）展开状态 */
  const [rightOpen, setRightOpen] = React.useState(true);
  const [rightWidth, setRightWidth] = React.useState(() => parseInt(localStorage.getItem('slime_rightbar_w') || '320'));
  /** 右侧栏工作树：会话级工作目录（configGet） */
  const [sessionWorkspace, setSessionWorkspace] = React.useState("");
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [agentConfig, setAgentConfig] = React.useState<Record<string, { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string }>>({});
  const [providerKeys, setProviderKeys] = React.useState<string[]>([]);
  const [providerModels, setProviderModels] = React.useState<ProviderModelBrief[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelBrief[]>([]);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  /** 行内重命名状态 */
  const [editingSession, setEditingSession] = React.useState<{ sessionId: string; draft: string } | null>(null);
  /** 依赖下载任务状态（全局常驻订阅：切走设置页进度不丢失） */
  const [dl, setDl] = React.useState<Record<string, DownloadProgressInfo>>({});
  /** 启动引导状态（A-C-C 式启动加载面板） */
  const [boot, setBoot] = React.useState<BootStatus | null>(null);
  /** 本地模型加载进度（slime 主题弹窗；llama-server 首次加载可能数十秒） */
  const [modelLoading, setModelLoading] = React.useState<{ loading: boolean; message?: string; key?: string }>({ loading: false });
  /** 模型加载已等待秒数（计时反馈：区分"加载中"与"卡住"） */
  const [modelWaitSec, setModelWaitSec] = React.useState(0);
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

  // 模型加载计时：loading 期间每秒递增，超 60s 提示可能卡住
  React.useEffect(() => {
    if (!modelLoading.loading) { setModelWaitSec(0); return; }
    setModelWaitSec(0);
    const t = window.setInterval(() => setModelWaitSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [modelLoading.loading]);

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
      const det = d as { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string };
      setAgentConfig((prev) => ({ ...prev, [id]: { ...((prev[id] ?? {}) as Record<string, string>), ...(det ?? {}) } }));
    };
    return () => { delete (w as { __onAgentDetail?: unknown }).__onAgentDetail; };
  }, []);

  /** 加载 Provider 键列表 + 本地模型列表（模型下拉动态化） */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const load = (): void => {
      api.providers.list().then((list: Array<{ key: string; models?: Array<{ id: string; selected?: boolean }> }>) => {
        setProviderKeys(list.map((p) => p.key));
        setProviderModels(list.map((p) => ({
          key: p.key,
          models: (p.models ?? []).map((m) => ({ id: m.id, selected: m.selected !== false })),
        })));
      }).catch(console.error);
      api.providers.localList().then((list: LocalModelBrief[]) => {
        setLocalModels(list);
      }).catch(console.error);
    };
    load();
    const timer = window.setInterval(load, 3000);
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
      void api.chat.send(sessionId, text.trim()).catch((e: unknown) => {
        console.error("[app] welcome send failed:", e);
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

  /** 右侧栏工作树：随选中 Agent 加载会话级工作目录 */
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.configGet || !selectedAgentId) {
      setSessionWorkspace("");
      return;
    }
    void api.conversations.configGet(selectedAgentId).then((cfg: { workspace?: string }) => {
      setSessionWorkspace(cfg?.workspace ?? "");
    }).catch(() => setSessionWorkspace(""));
  }, [selectedAgentId]);

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

  /** 直接新建会话（不要求前端传 agentId；后端自动选默认/首个 Agent，兜底会自创默认助手） */
  async function startNewSessionDirect(): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const res = await api.conversations.create().catch((e: unknown) => {
      console.error("[app] create session (direct) failed:", e);
      return null;
    });
    if (res?.ok && res.session) {
      setSelectedSessionId(res.session.sessionId);
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
  const currentThinking = agentConfig[selectedAgentId ?? ""]?.show_thinking !== "0";

  /** 更新 Agent 配置：本地乐观更新 + 等后端落库（避免切换模型后立刻发消息读到旧 model_choice 的竞态） */
  async function updateAgentConfig(patch: Record<string, string>): Promise<void> {
    if (!selectedAgentId) { return; }
    setAgentConfig((prev) => ({ ...prev, [selectedAgentId]: { ...((prev[selectedAgentId] ?? {}) as Record<string, string>), ...patch } }));
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    try {
      await api.agents.update(selectedAgentId, patch);
    } catch (e) {
      console.error("[app] agent config update failed:", e);
    }
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
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
              已等待 <b style={{ color: modelWaitSec > 60 ? "var(--warning)" : "var(--text)" }}>{modelWaitSec}</b> 秒
            </div>
            {modelWaitSec > 60 && (
              <div style={{
                fontSize: 12, color: "var(--warning)", marginTop: 6, lineHeight: 1.6,
                padding: "8px 10px", borderRadius: 8, background: "rgba(251,191,36,0.08)",
                border: "1px solid rgba(251,191,36,0.25)",
              }}>
                加载已超过 60 秒，可能卡住（大模型 CPU 首载通常 1~2 分钟）。可点击下方「取消加载」后重试。
              </div>
            )}
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

          {/* 对话区块：项目（Agent）分组 + 会话 */}
          <div style={{ display: "flex", alignItems: "center", padding: "0 12px 6px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--text-muted)", flex: 1 }}>
              对话
            </span>
            <button className="titlebar-btn" title="新建会话（无需选 Agent；后端自动分配默认 Agent）"
              onClick={() => void startNewSessionDirect()}>
              <PlusIcon size={14} />
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
                    <span style={{ fontSize: 10, color: "var(--text-dim)", width: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", transition: "transform 0.12s" }}>
                      <ChevronIcon size={12} rotate={isCollapsed ? -90 : 90} />
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
                      <PlusIcon size={13} />
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
                              <EditIcon size={14} />
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
              modelChoice={currentModel}
              mode={currentMode}
              reasoningEffort={currentReasoning}
              showThinking={currentThinking}
              providerKeys={providerKeys}
              providerModels={providerModels}
              localModels={localModels}
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

        {/* 右侧栏（工作树 / 任务 / 终端 / 浏览器） */}
        <RightSidebar
          open={rightOpen}
          onToggle={() => setRightOpen(!rightOpen)}
          agentId={selectedAgentId}
          agentName={selectedSession?.agentName ?? ""}
          workspace={sessionWorkspace}
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