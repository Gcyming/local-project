/**
 * gui/src/renderer/App.tsx — slime GUI 主框架（Campanula 布局参考 + 会话化重构）。
 * - 自绘标题栏（frameless + titleBarOverlay 系统窗口按钮）
 * - 侧边栏：「对话」= 项目（Agent 名）下的独立会话列表（不直接罗列所有 Agent）；
 *   会话可随时重命名/删除；项目内可新建多个会话
 * - 主区：对话面板常驻；设置改为弹窗（SettingsDialog：左侧栏目 + 搜索 + 右侧内容）
 */
import React, { type JSX } from "react";
import ChatPanel from "./pages/ChatPanel.js";
import SplashScreen, { type SplashStep } from "./pages/SplashScreen.js";
import NewProjectDialog from "./pages/NewProjectDialog.js";
import SettingsDialog, { type SettingsTab } from "./pages/SettingsDialog.js";
import RightSidebar from "./pages/RightSidebar.js";
import { SIDEBAR_OPEN_EVENT } from "./pages/Markdown.js";
import type { DownloadProgressInfo, BootStatus } from "../shared/ipc.js";
import { ChevronIcon, EditIcon, MenuIcon, PlusIcon, SettingsIcon, SidebarLeftIcon, SidebarRightIcon } from "./components/Icon.js";
import { ThemeDialogHost } from "./components/ThemeDialog.js";
/** A-1044：图形操作可视化浮层（呼吸灯边框 + 可隐藏的悬浮提示）——常驻挂载在最外层 */
import OperationFocusOverlay from "./components/OperationFocusOverlay.js";
/** A-943 群聊头脑风暴图标（用户选定 D:\下载\团队.svg） */
import teamSvg from "./assets/team.svg";
/** A-945 会话列表图标（用户选定 D:\下载\当前会话.svg） */
import currentSessionSvg from "./assets/current-session.svg";
/** A-980-R17：悬浮窗最小化后的可拖动图标（用户选定 D:\pilot project\gui\dist-v9\.icon-ico\icon.ico） */
import floatIconUrl from "./assets/icon.ico?url";
/** A-1049：欢迎页中央使用应用真实图标，替代原来的字母 S */
import appIconUrl from "../../build/icon.png";
import { getTheme, applyTheme, type ThemeName } from "./theme.js";
import { confirmAsync } from "./dialog.js";
// A-1008：「联网搜索」开关的唯一读写入口（此前这里用 `=== "1"`、ChatPanel 用 `!== "0"`，
// 同一份偏好两个默认值 → 没点过开关时欢迎语那条流把 web_search/web_fetch 静默拒掉）
import { readNetworkEnabled } from "./networkToggle.js";
// A-980-R26：自定义通知提示音播放端（主进程没有音频能力，只发"该响了"的信号）
import { subscribeNotifySound } from "./notifySound.js";

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
  /** A-1011：群聊成员思考推理强度覆盖（memberId → effort；缺省 = 群聊默认 high） */
  memberEfforts?: Record<string, string>;
  /** A-1011：群聊组长思考推理强度覆盖（缺省 = 群聊默认 high） */
  leaderEffort?: string;
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
      <img src={appIconUrl} alt="Slime" style={{ width: 64, height: 64, borderRadius: 18, objectFit: "cover" }} />
      <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>Slime</div>
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

/**
 * A-1039：首屏必须到齐的数据项（模块级常量，避免每次渲染重建）。
 *
 * 每一项都对应一个**首屏就要用、且拉取不快**的数据源。它们此前不在启动门的判据里：
 * 门只等「会话列表」，而 provider / 本地模型还在冷态加载 → 用户点开界面就撞上未就绪的重活。
 */
const FIRST_LOAD_KEYS = ["agents", "sessions", "providers", "localModels", "chatHistory"] as const;

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

/** A-980-R16：悬浮窗尺寸下限与窗口内可见上限（尺寸按当前窗口钳制，避免越界） */
const FLOAT_MIN_W = 340;
const FLOAT_MIN_H = 300;
function clampFloatSize(w: number, h: number): { w: number; h: number } {
  const maxW = Math.max(FLOAT_MIN_W, window.innerWidth - 24);
  const maxH = Math.max(FLOAT_MIN_H, window.innerHeight - 70);
  return {
    w: Math.max(FLOAT_MIN_W, Math.min(w, maxW)),
    h: Math.max(FLOAT_MIN_H, Math.min(h, maxH)),
  };
}

/** A-980-R16：悬浮窗位置钳制在窗口内（至少留出标题栏一部分可拖回） */
function clampFloatPos(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(4, window.innerWidth - 160);
  const maxY = Math.max(4, window.innerHeight - 60);
  return {
    x: Math.max(4, Math.min(x, maxX)),
    y: Math.max(4, Math.min(y, maxY)),
  };
}

/** A-980-R17：悬浮窗最小化后的图标尺寸（正方形，显示 app 图标） */
const FLOAT_ICON_SIZE = 44;

/** A-980-R19：悬浮窗宽高过渡基线（拖拽调尺寸期间临时禁用，见 startFloatResize）
 *  A-980-R30：0.3s → 0.4s——与侧栏放慢同一诉求：凸显几何同步的渐隐渐显
 *  A-980-R34：0.4s → 0.5s——用户"展开跟收起的动画再长一点"，与侧栏同节奏放缓
 *  A-980-R35：0.5s → 0.4s（用户"又太长了"）；缓动改 decelerate cubic-bezier(0,0,0.2,1)——由快到慢 */
const FLOAT_TRANSITION = "height 0.4s cubic-bezier(0,0,0.2,1), width 0.4s cubic-bezier(0,0,0.2,1)";
/** A-980-R19：还原展开时的完整过渡（含 top/left——展开方向自适应需要位置与尺寸同步动） */
const FLOAT_TRANSITION_FULL = `top 0.4s cubic-bezier(0,0,0.2,1), left 0.4s cubic-bezier(0,0,0.2,1), ${FLOAT_TRANSITION}`;

/** A-980-R19：悬浮窗整体（尺寸 + 位置）钳制在窗口内——哪里有位置往哪里去，
 *  空间不足时整体上移/左移，保证完整可见不跑出界面（clampFloatPos 只保证能拖回，不保证不越界） */
function fitFloatRect(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, Math.max(4, window.innerWidth - w - 8))),
    y: Math.max(4, Math.min(y, Math.max(4, window.innerHeight - h - 8))),
  };
}

/** A-980-R24：初始布局比例（用户给定版式，实测自目标截图）——
 *  左栏 17.5% / 聊天主区 60.9% / 右栏 21.6%（三者之和 100%，窗口宽为基准）。
 *  ⚠️ 用**比例**而非固定像素：任何分辨率下三栏占比一致（这才是"内部初始侧栏占比"的准确含义），
 *  只有在用户手动拖动过之后才落成像素值并被记住。 */
const SIDEBAR_RATIO = { left: 0.175, right: 0.215 };
/** 左栏宽度硬约束（与 index.css 的 .sidebar min/max-width 必须一致）。
 *  A-980-R24：下限 280 → 240——280 会在 1080p 上顶掉 17.5% 的比例（17.5%×1498≈262），
 *  导致"按比例算出来却显示成 280"，小屏上左栏显得偏宽。 */
const SIDEBAR_MIN_W = 240;
const SIDEBAR_MAX_W = 520;

/**
 * A-980-R25：渐隐渐显的「可见性窗口」比例（相对展开宽度）——
 * 宽度 ≤ full×LO 时内容全透明，≥ full×HI 才全可见，中间做 smoothstep。
 *
 * A-980-R33（用户五连，明确方向）：**[0.45, 0.90]——渐出更早、渐入更晚，且纯几何自适应**。
 * R32 的 [0.30,0.80] 渐出还不够早（内容撑到 30% 宽才完全消失）、渐入也不够晚。
 * 用户要求"渐出再早一点，渐入再晚一点，不要单纯看时间控制，界面自适应调节也很重要"：
 *   - HI = 0.90：淡出从面板还有 90% 宽就开始（渐出更早）、淡入到 90% 才完成（渐入更晚）；
 *   - LO = 0.45：内容在面板 45% 宽以下已完全透明（渐出更早完成 / 渐入更晚开始）。
 * 变化区间 45% 宽度 ≈ 0.45s×0.45 ≈ 200ms，动画仍全程可辨。
 * 这两个数作为**全局默认**作用于右栏/悬浮窗/聊天区（聊天区也用比例换算，见 startInlineChatRevealFade）；
 * 左栏由 LEFT_FADE_LO/HI 单独覆盖（A-980-R34，时机更早）。任何分辨率下都是同一套
 * "45% 前不可见、90% 才全显示"——纯几何、无时间量、随界面自适应。
 * 若仍觉得太快/太慢，**只调这几个数**，不要退回按时间控制。
 */
const FADE_VISIBLE_LO = 0.45;
const FADE_VISIBLE_HI = 0.90;

/**
 * A-980-R34：左栏专用渐隐渐显窗口——比全局/右栏 [0.45,0.90] **更早**：
 *   - 淡出（收起）：从面板还有 95% 宽就开始（右栏 90% 才开始）→ 左栏先淡出；
 *   - 淡入（展开）：从 40% 宽就启动（右栏 45% 才启动）→ 左栏先淡入。
 * 带宽 55%（> 右栏 45%）：窄栏（下限 240px）下渐变带 [96,228]px 依然明显，
 * 配合 0.6s 宽度过渡，淡入淡出约 330ms，全程可辨——这就是"随栏宽自适应"：
 * 出现时机永远按面板自身展开宽度的 40%/95% 换算，不依赖固定像素/固定时长。
 * 右栏 / 悬浮窗 / 聊天区继续用全局 FADE_VISIBLE_LO/HI。
 */
const LEFT_FADE_LO = 0.40;
const LEFT_FADE_HI = 0.95;

/** A-980-R33：内联聊天区淡入不再用固定像素窗口——改为与侧栏/悬浮窗同一套**比例窗口**
 *  （FADE_VISIBLE_LO/HI，见 startInlineChatRevealFade 的 full 参数：full=主区目标宽度）。
 *  此前 [140,380]/[320,560] 是绝对像素，窗口大小一变就"过窄/过宽"，不符合
 *  "界面自适应调节"的要求。 */

/** A-980-R27：主区（聊天栏）最小宽度——必须与 index.css 的 `.main { min-width: 380px }` 一致。
 *  右栏拖拽上限要减掉它，否则整行溢出会转嫁给可收缩的左栏（用户实测"拖右栏会拽动左栏"）。 */
const CHAT_MIN_W = 380;

/** A-980-R27：几何同步动画的结束判据之一——实测宽度连续这么多帧不再变化。
 *  A-980-R30：**"稳定"判定必须发生在"净位移已发生"之后**（见 GEOM_SYNC_MIN_SHIFT）。
 *  R27 直接把"稳定 3 帧"当结束，但 CSS 过渡**刚开始**时每帧宽度变化 < 0.5px（React 未提交、
 *  或 cubic-bezier 起步段），会被误判成"已稳定"→ 动画第一帧就 done → opacity 提前清空回 1 →
 *  「点击按钮看不见渐入渐出」+「收/展后内容一路可见被挤压（观感闪烁）」。 */
const GEOM_SYNC_STABLE_FRAMES = 3;

/** A-980-R35：**无位移快速收工**判据的稳定帧数（仅"宽度从未动过"的重复触发场景用）。
 *  必须明显大于过渡起步段/高刷屏的"每帧 <0.5px"帧数——120Hz 下 cubic-bezier 起步段
 *  前 2-3 帧位移都 <0.5px，若用 3 帧会把「正在动的收起/展开」误判成"没在动"而提前 done，
 *  opacity 被清空 → 点击顶部导航栏按钮时渐入渐出"有时候看得到有时候看不到"（拖拽是
 *  指针直接驱动、每帧位移大，不受此坑影响，所以拖拽时动画总是明显）。取 8 帧（60Hz≈133ms、
 *  120Hz≈67ms）：任何真实过渡在这么长里必然已动起来（位移 >0.5px 重置稳定计数），
 *  只有宽度真的从头到尾没变（重复触发 no-op）才会走到 done。 */
const GEOM_SYNC_NO_MOVE_FRAMES = 8;

/** A-980-R30：结束判据的"先决位移"——实测宽度从动画开始累计位移达到该值后，稳定判定才开始生效。
 *  纯几何量（与时长/刷新率无关）：过渡真的动过（而不是卡在未开始的初始宽度）才允许结束。 */
const GEOM_SYNC_MIN_SHIFT = 5;

/** A-980-R27：侧栏拖拽的「收起」吸附带——距**几何下限**多少像素以内算拖到底。
 *  必须是相对量，不能写死绝对像素：旧实现用 300px（左栏），而左栏下限是 240、
 *  默认宽又只有 `innerWidth × 17.5%`（1080p ≈ 262）——「刚比下限宽一点」整段区间
 *  都落在吸附带里，于是拖到最窄收起后重新拉宽，宽度一从下限起步就又被判成"拖到底"
 *  再次收起，用户看到的就是"左栏拉不开"。贴着下限取 8px 后这个死区就不存在了。 */
const SIDEBAR_SNAP_W = 8;

/** A-980-R29：右侧栏「最窄」宽度占窗口比例（用户截图实测：1920px 全屏下右栏 ~290px ≈ 15.1%）。
 *  拖拽下限 / 持久化钳制 / 会话恢复的宽度都按它走——右栏**展开时最窄只能到这个宽度**，
 *  贴到最窄（±吸附带）松手才触发「收起」（与 A-980-R14 拖窄收起语义一致）。
 *  取 0.15 而非截图的 0.16 上限：内容（待办/上下文记忆/活动记录）在 290px 下已可完整放下。 */
const RIGHT_SIDEBAR_MIN_RATIO = 0.15;

/** 右栏「最窄」宽度（像素）：按窗口比例算，绝对下限 260 对齐 index.css 的 `.right-sidebar { min-width:260px }`。
 *  与左侧栏不同的是右栏没有固定像素下限——旧实现写死 260，但截图比例在小屏（<1734px）时
 *  比 260 还小，用户希望"最窄 = 截图比例"，因此必须随窗口自适应。 */
function rightSidebarMinW(): number {
  return Math.max(260, Math.round(window.innerWidth * RIGHT_SIDEBAR_MIN_RATIO));
}

/**
 * A-980-R24：侧栏 / 悬浮窗「几何同步」渐隐渐显（左右栏与聊天悬浮窗共用）。
 *
 * 背景（用户反馈）：收起/展开时「内容淡出」与「面板收缩」是两套节拍——旧实现用**固定延时**
 * （收起 0.07s 置透明、展开 150ms 后才淡入），于是
 *   ① 面板刚一动内容就没了 → 观感"出现时机太早"、"生硬"；
 *   ② 时间轴与几何轴不对齐，在不同分辨率/不同过渡时长下表现不一致
 *      （用户明确要求"随界面大小变化自适应，而不是按时间设定"）。
 *
 * 现在：opacity 是**当前实测尺寸的纯函数**——不再用固定时间点，与屏幕大小、刷新率、过渡时长无关。
 *
 * A-980-R25（用户第二轮反馈）：上一版把整段宽度线性铺满（p = smoothstep(宽/展开宽)），
 * 结果**内容在整个收缩过程中一直半透明可见**——文字换行重排、图像被压扁的过程全程可辨
 * （用户："动画设计的慢了点，还是一直看见内部文本、图像等被挤压"）。
 * 现在改成**可见性窗口**：
 *   - 宽度 ≥ full×FADE_HI  → 完全可见（p = 1）
 *   - 宽度 ≤ full×FADE_LO  → 完全透明（p = 0）
 *   - 中间窄带做 smoothstep 过渡
 * 于是「内容消失」发生在面板还有 30% 宽度时——**挤压最难看的那一段是空面板，
 * 而不是正在重排的文本**；展开同理，等到面板长回 55% 内容才开始长出。
 * 这也让渐隐渐显读起来"跟手、很快"，而不是整段慢吞吞地半透明。
 *
 * A-980-R27（用户第三轮反馈）：**结束判定也必须纯几何**。上一版的 p 是几何的，但"动画结束"
 * 却混进了时间量——`performance.now() - t0 > 1000` 硬兜底、`frames >= 8` 起步门槛、
 * 取消时无条件 `onFrame(1, true)` 强制显形。这些量有三个后果：
 *   ① 结束时刻随刷新率/机器快慢漂移（低刷上 8 帧门槛就是 200ms+，与 0.25s 过渡错拍）；
 *   ② "取消即显形"会把**上一个动画的终态**硬扣在当前这次上——打断方向相反时（正在变小
 *      又立刻要恢复）就把"全透明"钉死了，这正是悬浮窗"只能变小、不能恢复"的来源之一；
 *   ③ 1s 兜底在元素测不到宽度时会把 opacity 锁在一个与几何无关的值。
 * 现在唯一的结束判据是 `GEOM_SYNC_STABLE_FRAMES` 帧内实测宽度不再变化：
 *   - 过渡跑完 → 宽度停住 → 收工；
 *   - 过渡被禁用 / 宽度本就没有变化空间 → 头几帧就满足 → 立即收工（不留半透明残留）；
 *   - 元素还没挂载（React 尚未提交）→ 跳过该帧（不计进度、不计稳定），等它出现。
 * 取消（cancel）只做"停表"，不写任何样式；终态由调用方在 callback 里自己决定。
 *
 * @param measure 提供几何的元素（悬浮窗：量外框；侧栏：量自身）
 * @param onFrame 每帧回调（p ∈ [0,1]；done=true 表示动画已结束，调用方自行复位内联样式）
 * @param opts `full` = 完全展开时的宽度（用于按比例换算可见性窗口）；`min` = 收缩下限；
 *             `lo`/`hi` 可显式覆盖窗口（绝对像素，默认按 full 的 LO/HI 比例算）
 * @returns cancel()——打断/卸载时清理（只停表，不复位样式）
 */
function runGeometrySyncFade(
  measure: () => HTMLElement | null,
  onFrame: (p: number, done: boolean) => void,
  opts: { min?: number; full: number; lo?: number; hi?: number; loRatio?: number; hiRatio?: number },
): () => void {
  const min = opts.min ?? 0;
  const span = Math.max(1, opts.full - min);
  // 可见性窗口：低于 lo 全透明、高于 hi 全不透明。
  // 默认取展开宽度的 FADE_VISIBLE_LO/HI 比例；loRatio/hiRatio 可显式覆盖比例
  // （左栏用它提前，见 LEFT_FADE_LO/HI）——始终随 full 换算，不依赖固定像素。
  const lo = opts.lo ?? min + span * (opts.loRatio ?? FADE_VISIBLE_LO);
  const hi = opts.hi ?? min + span * (opts.hiRatio ?? FADE_VISIBLE_HI);
  const band = Math.max(1, hi - lo);
  let raf = 0;
  let prevW = -1;
  let stable = 0;
  let netShift = 0;
  let lastP = 0;
  let seen = false;
  let everBelowHi = false;
  let cancelled = false;
  const step = (): void => {
    if (cancelled) { return; }
    const el = measure();
    if (!el) {
      // 还没挂载（React 还没提交）→ 本帧不写样式、不计进度，等它出现；
      // 曾经在、现在没了 = 动画对象已被卸载 → 收工，把终态交还调用方
      if (seen) { onFrame(lastP, true); return; }
      raf = window.requestAnimationFrame(step);
      return;
    }
    seen = true;
    const w = el.getBoundingClientRect().width;
    if (prevW >= 0) {
      const delta = Math.abs(w - prevW);
      // 累计"净位移"：过渡真的动过才算——否则 CSS 过渡刚开始（每帧 <0.5px）会被误判稳定而提前结束
      netShift += delta;
      stable = delta < 0.5 ? stable + 1 : 0;
    }
    prevW = w;
    // A-980-R35：一旦实测宽度进入过渐变带（< hi），就说明**确实在动**，
    // 永久关闭"无位移快速收工"判据②——否则过渡起步段/高刷屏的每帧 <0.5px
    // 会把正在进行的收起/展开误判成 done，opacity 提前清空、渐入渐出消失。
    if (w < hi) { everBelowHi = true; }
    const raw = Math.max(0, Math.min(1, (w - lo) / band));
    lastP = raw * raw * (3 - 2 * raw); // smoothstep：两端柔和，不生硬
    // A-980-R30/R35：结束判据（纯几何，无时间量）：
    //   ① 宽度累计位移 ≥ GEOM_SYNC_MIN_SHIFT（过渡真的动过）且随后连续 3 帧不再变化 → 收工；
    //   ② 或宽度**从未进入过渐变带**（everBelowHi=false，重复触发时真的没在动）
    //      且稳定 GEOM_SYNC_NO_MOVE_FRAMES(8) 帧 → 快速收工（防 rAF 循环泄漏）。
    const done = ((netShift >= GEOM_SYNC_MIN_SHIFT && stable >= GEOM_SYNC_STABLE_FRAMES)
      || (!everBelowHi && w >= hi - 0.5 && stable >= GEOM_SYNC_NO_MOVE_FRAMES));
    onFrame(lastP, done);
    if (done) { return; }
    raf = window.requestAnimationFrame(step);
  };
  raf = window.requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (raf) { window.cancelAnimationFrame(raf); }
  };
}

export default function App(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("general");
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  /** A-980-R24：初始宽度钳制 + 首启按**屏幕比例**（左 17.5%）计算——本地存储坏值
   *  （被拖成 0/负/超限）不再污染启动布局；有用户拖动过的偏好则沿用其像素值。 */
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    const v = parseInt(localStorage.getItem('slime_sidebar_w') ?? "", 10);
    if (Number.isFinite(v)) { return Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, v)); }
    return Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Math.round(window.innerWidth * SIDEBAR_RATIO.left)));
  });
  /** A-1018：用户是否**手动拖过**左栏宽度。
   *  · false（首次运行/从未拖过）→ **不**下发内联宽度，交给 CSS 的
   *    `--sidebar-w: clamp(240px, 17.5%, 520px)` —— 随窗口自适应，并天然带最大/最小限制；
   *  · true → 用 px 内联覆盖（拖动是显式意图，不该被窗口缩放抹掉）。
   *  为什么不做成"JS 监听 resize 重算"：A-975-R4 踩过反馈环（布局宽度依赖 innerWidth，
   *  而布局变化又会改变 innerWidth），详见 index.css 里 `--sidebar-w` 的注释。 */
  const [sidebarCustom, setSidebarCustom] = React.useState(() => Number.isFinite(parseInt(localStorage.getItem('slime_sidebar_w') ?? "", 10)));
  /** 右侧栏（工作树/任务/终端/浏览器）展开状态 */
  const [rightOpen, setRightOpen] = React.useState(true);
  const [rightWidth, setRightWidth] = React.useState(() => {
    const v = parseInt(localStorage.getItem('slime_rightbar_w') ?? "", 10);
    const max = Math.max(600, window.innerWidth - 48);
    const minW = rightSidebarMinW();
    // A-980-R29：下限 = 截图比例的最窄宽度（不再是 260）——旧版本曾把右栏拖到 260 以下，
    // 启动时若本地存储还留着那个窄值，会被顶回 minW，不再出现"比最窄还窄"的布局。
    if (Number.isFinite(v)) { return Math.max(minW, Math.min(max, v)); }
    // A-980-R24：首启按屏幕比例（右 21.6%），与左栏同一套版式来源（用户给定截图实测）
    return Math.min(max, Math.max(minW, Math.round(window.innerWidth * SIDEBAR_RATIO.right)));
  });
  /** A-1018：右栏是否被**手动拖过**——语义同 `sidebarCustom`（false → 交给 CSS 的
   *  `--right-sidebar-w: clamp(260px, 21.5%, 720px)` 随窗口自适应）。 */
  const [rightCustom, setRightCustom] = React.useState(() => Number.isFinite(parseInt(localStorage.getItem('slime_rightbar_w') ?? "", 10)));
  /* ⚠️ A-975-R4 撤回：这里曾加过一套「按 window.innerWidth 状态算有效宽度」的响应式方案
   * （winW state + resize 监听 + effSidebarWidth/effRightWidth 派生）。
   * **踩坑**：布局宽度依赖 innerWidth、而布局变化又会改变 innerWidth（横向滚动条出现/消失）
   * → resize 反馈环 → 可无限重渲染 → 界面"什么都点不动"。
   * 改为**纯 CSS** 让侧栏可收缩（见 index.css 的 flex-shrink / min-width），
   * 无 JS 状态、无反馈环、也不覆盖用户拖出来的偏好宽度。 */
  /** A-980-R14：聊天悬浮窗状态（右栏占满窗口时聊天主区变为浮层）：
   *  none 普通布局 / float 悬浮 / min 最小化（缩成可拖动图标）
   *  与右侧栏一样**按会话记忆**，切会话互不串联。 */
  const [floatState, setFloatState] = React.useState<"none" | "float" | "min">("none");
  /** A-980-R17：悬浮窗最小化/还原的过渡阶段（out=内容渐出+窗口缩小；in=窗口复原）
   *  A-980-R25：新增 closing——悬浮窗「收起」的退场（内容按几何淡出 + 窗口收缩到 0）
   *  A-980-R27：阶段推进不再靠 setTimeout 计时（旧的 300ms / 320ms / 40ms+340ms 三段相位机
   *  已全部删除）——改由几何同步 rAF 的 done（窗口真的缩/长到位）来推进，见 startFloatGeometryFade。 */
  const [floatAnim, setFloatAnim] = React.useState<"idle" | "out" | "in" | "closing">("idle");
  /** A-980-R25：唤出悬浮窗前右栏的宽度——收起浮窗时归还，让右栏平滑滑回、
   *  中间聊天栏随之"长出来"（否则右栏固定在占满宽度，聊天一次性弹到 380px 很硬） */
  const preFloatRightWidthRef = React.useRef<number | null>(null);
  /** A-980-R25：内联聊天区（浮层退场后回到普通布局时，按主区实测宽度几何淡入） */
  const inlineChatRef = React.useRef<HTMLDivElement | null>(null);
  const chatFadeCancelRef = React.useRef<(() => void) | null>(null);
  /** A-980-R25：悬浮窗退场进行中标记——state 要等退场几何跑完才落 "none"，
   *  期间重复点收起（或右栏收起联动）不能二次启动退场动画
   *  A-980-R27：退场结束改由 startFloatGeometryFade 的 done 推进，本标记同时充当
   *  "这次退场是否仍然有效"的判断位（期间被最小化/还原打断则作废）。 */
  const floatClosingRef = React.useRef(false);
  /** A-980-R24：左右侧边栏 + 悬浮窗的「几何同步渐隐渐显」取消句柄（替代旧的固定延时定时器）。
   *  一次只允许一个在跑；再次切换时先 cancel 上一次（避免两段动画抢同一个 style.opacity）。 */
  const leftFadeCancelRef = React.useRef<(() => void) | null>(null);
  const rightFadeCancelRef = React.useRef<(() => void) | null>(null);
  const floatFadeCancelRef = React.useRef<(() => void) | null>(null);
  /** A-980-R21：直接操纵 aside / 右栏 wrapper 的 DOM style 控制透明度过渡 */
  const leftSidebarRef = React.useRef<HTMLElement | null>(null);
  const rightWrapperRef = React.useRef<HTMLDivElement | null>(null);
  /** A-980-R34：展开动画期间临时解除 min-width 的标志（true 时 className 挂 sidebar-no-min /
   *  right-wrapper-no-min → CSS 把 min-width 归零，宽度从 0 真过渡到展开宽、渐变带才走得完整）。
   *  窄栏（左 240 / 右 260 下限）下若不放行，展开宽度被钳在下限、实测宽度跳变到渐变带之外，
   *  渐入永远看不到。动画 done 后复位。 */
  const [leftMin0, setLeftMin0] = React.useState(false);
  const [rightMin0, setRightMin0] = React.useState(false);
  /** A-980-R17：最小化图标「拖动 vs 点击」区分——拖动超过阈值后松手的 click 不触发还原 */
  const floatDragMovedRef = React.useRef(false);
  /** A-980-R15：悬浮窗尺寸/位置（标题栏可拖动、右下角可调大小；按会话记忆） */
  const [floatSize, setFloatSize] = React.useState<{ w: number; h: number }>(() => clampFloatSize(480, 540));
  const [floatPos, setFloatPos] = React.useState<{ x: number; y: number } | null>(null);
  const floatRef = React.useRef<HTMLDivElement | null>(null);
  const floatSizeRef = React.useRef(floatSize);
  floatSizeRef.current = floatSize;
  const floatPosRef = React.useRef(floatPos);
  floatPosRef.current = floatPos;
  /** A-980-R24：悬浮窗内容层（渐隐渐显由几何同步 rAF 驱动，见 runGeometrySyncFade） */
  const floatInnerRef = React.useRef<HTMLDivElement | null>(null);
  /** A-173：点击聊天消息里的文件/网址链接 → 自动展开右侧栏（由 RightSidebar 新建对应页） */
  React.useEffect(() => {
    const onOpen = (): void => setRightOpen(true);
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
  }, []);
  /** 右侧栏工作树：会话级工作目录（configGet） */
  const [sessionWorkspace, setSessionWorkspace] = React.useState("");
  /** A-975：工作目录变更信号——ChatPanel 改完目录 +1，触发下面 configGet 重读（右栏工作树根随即跟上，
   *  此前只在切会话时才重读 → 改完目录右栏还挂着旧文件夹） */
  const [workspaceTick, setWorkspaceTick] = React.useState(0);
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  // A-921：右侧边栏与会话一体——开合/宽度按会话记忆（对齐 VS Code Copilot「side pane 尺寸/可见性随会话保持」
  // 与 OpenClaw「widths/collapsed 按 canonical session 持久化」）；配合 RightSidebar 内部 tabs/任务按会话隔离，
  // 切回任意会话其右侧栏（宽度、折叠、打开的页、任务、事件流）原样还原，多会话互不干扰
  const rightViewCacheRef = React.useRef<Record<string, { open: boolean; width: number; float?: "float" | "min"; size?: { w: number; h: number }; pos?: { x: number; y: number } | null; iconPos?: { x: number; y: number } | null }>>({});
  const prevRightSidRef = React.useRef<string | null>(null);
  const floatStateRef = React.useRef(floatState);
  floatStateRef.current = floatState;
  /** A-980-R36：最小化图标的「家」位置——用户**手动拖过**图标就记住这里，之后最小化一律回到这里
   *  （"哪个角收起就哪个角展开"）；从未摆过则保持"原位缩回"（图标中心=展开窗中心）。
   *  此前 minimizeFloat 每次都把图标位置重算成展开窗中心，用户把图标放到角落再
   *  展开→收起，图标就跑别处去了。 */
  const floatIconHomeRef = React.useRef<{ x: number; y: number } | null>(null);
  React.useEffect(() => {
    const sid = selectedSessionId ?? "";
    if (prevRightSidRef.current !== null && prevRightSidRef.current !== sid) {
      rightViewCacheRef.current[prevRightSidRef.current] = {
        open: rightOpen, width: rightWidth,
        float: floatStateRef.current === "none" ? undefined : floatStateRef.current,
        size: floatSizeRef.current, pos: floatPosRef.current,
        iconPos: floatIconHomeRef.current,
      };
    }
    if (sid) {
      const snap = rightViewCacheRef.current[sid];
      if (snap) {
        // 切换会话时先取消进行中的悬浮窗几何动画（rAF），避免旧动画覆盖新会话的悬浮窗状态
        // A-980-R24：同时取消在跑的几何同步渐隐渐显（rAF），并把 opacity 复位为常态
        leftFadeCancelRef.current?.();
        leftFadeCancelRef.current = null;
        rightFadeCancelRef.current?.();
        rightFadeCancelRef.current = null;
        floatFadeCancelRef.current?.();
        floatFadeCancelRef.current = null;
        // A-980-R25：内联聊天区的几何淡入也要取消（否则切会话后它还在给新会话写 opacity）
        chatFadeCancelRef.current?.();
        chatFadeCancelRef.current = null;
        preFloatRightWidthRef.current = null;
        floatClosingRef.current = false;
        // 还原侧栏 DOM opacity/transition（切会话时侧栏不动画，防残留态）
        // A-1016-F3：一并摘掉宽度动画期间的 webview 钉子——这条取消路径**不会**重启动画，
        // 漏了就会让 guest 永远停在旧宽度（窗口再变宽时它仍是钉住的那个值）。
        setRightWebviewPin(null);
        const le = leftSidebarRef.current;
        if (le) { le.style.transition = ""; le.style.opacity = ""; }
        const rw = rightWrapperRef.current;
        if (rw) { rw.style.transition = ""; rw.style.opacity = ""; }
        const fi = floatInnerRef.current;
        if (fi) { fi.style.opacity = ""; }
        const ic = inlineChatRef.current;
        if (ic) { ic.style.opacity = ""; }
        setRightOpen(snap.open);
        // A-980-R29：恢复宽度同样钳到 [minW, max]——快照可能来自旧版本（曾拖到 260 以下），
        // 不钳会恢复出"比最窄还窄"的右栏。
        setRightWidth(Math.max(rightSidebarMinW(), Math.min(Math.max(600, window.innerWidth - 48), snap.width)));
        const sf = snap.float;
        setFloatState(sf === "float" || sf === "min" ? sf : "none");
        setFloatAnim("idle");
        // A-980-R19：恢复尺寸后再按该尺寸钳制位置（保证完整可见，不越界）
        const sz = clampFloatSize(snap.size?.w ?? 480, snap.size?.h ?? 540);
        setFloatSize(sz);
        setFloatPos(snap.pos ? fitFloatRect(snap.pos.x, snap.pos.y, sz.w, sz.h) : null);
        // A-980-R36：恢复图标「家」位置（跨会话保持"哪个角收起就哪个角展开"）
        floatIconHomeRef.current = snap.iconPos ?? null;
      }
    }
    prevRightSidRef.current = sid || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  /** A-918+：会话列表指纹（id/title/count/lastTime 序列化），用于 15s 轮询时跳过无变化的重渲 */
  const sessionsKeyRef = React.useRef("");
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
  /** A-979：新建会话弹窗预填工作文件夹（弹窗打开时初始化；草稿状态已内聚 NewProjectDialog 组件） */
  const [newProjectPrefill, setNewProjectPrefill] = React.useState<string | null>(null);
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
  /**
   * A-1039：首屏关键数据登记表 —— 任何一项未到齐，启动面板都不得隐藏。
   *
   * **用户实测（v0.0.4 打包版）**：加载动画停了、界面出来了，但点什么都卡 —— 滚动卡、
   * 跳转卡、折叠展开也慢，重启一次就恢复正常。根因不是某个慢函数，而是**门的判据错了**：
   * 此前「就绪」只等于「会话列表拉到了」，而 provider 列表 / 本地模型 / 定价 / 探针快照
   * 都还在冷态加载中。首启（磁盘上什么都没缓存）撞上它们 → 全局迟滞；二次启动命中缓存 → 正常。
   *
   * 现在把首批必须品逐个登记，**全部到齐**才收门。失败也记为完成（不能因某个数据源拉不到
   * 就把用户永久关在加载页），另有 firstLoadGuard 总超时兜底 —— 门绝不能变成新的卡死源。
   */
  const [firstLoad, setFirstLoad] = React.useState<Record<string, boolean>>({});
  const markFirstLoad = React.useCallback((key: string): void => {
    setFirstLoad((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  /**
   * A-1058①：`chatHistory` 的**稳定**回执函数。
   *
   * 必须走 `useCallback`（而不是在 JSX 里写内联箭头）：ChatPanel 的会话恢复 effect 是
   * 「挂载 + 切换 sessionId」触发的，一旦这个 prop 每次渲染都换新身份、又被人顺手写进
   * effect 依赖表，就会变成**反复重拉历史**的自激循环。稳定引用=写进依赖表也安全。
   */
  const markChatHistoryLoaded = React.useCallback((): void => { markFirstLoad("chatHistory"); }, [markFirstLoad]);
  /** A-1039：门的总超时兜底（8s）——任何数据源挂掉都不得把用户关在加载页 */
  const [firstLoadGuard, setFirstLoadGuard] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setFirstLoadGuard(true), 8000);
    return () => window.clearTimeout(t);
  }, []);
  /** 首屏就绪 = 全部必须品到齐，或总超时兜底已触发 */
  const uiReady = firstLoadGuard || FIRST_LOAD_KEYS.every((k) => firstLoad[k]);
  /** A-980-R18：启动面板最小时长标记（避免加载太快时一闪而过；用户反馈"好久没看到加载动画"） */
  const [splashMinDone, setSplashMinDone] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setSplashMinDone(true), 700);
    return () => window.clearTimeout(t);
  }, []);
  /**
   * A-1039 废弃说明：原 `bootStallGuard`（4s 后不再因 boot===null 卡住启动面板）已移除。
   * 它存在的理由是"boot 事件可能永远不来，别把用户关在加载页" —— 这个诉求现在由
   * `firstLoadGuard`（8s 总超时）承担，且**覆盖面更宽**：不只兜 boot 事件，还兜每一个
   * 首屏数据源。留着它反而有害：它会让面板在首屏数据未就绪时就被放行（新的卡顿来源）。
   */
  /** 应用版本号（启动面板副标题；拿不到就不显示，不阻塞任何流程） */
  const [appVersion, setAppVersion] = React.useState("");
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void api?.boot?.version?.().then((v: string) => setAppVersion(v)).catch(() => { /* 忽略 */ });
  }, []);
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
    markFirstLoad("agents"); // A-1039：记入启动门（此前不在门内）
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
  }, [applyAgentDetail, markFirstLoad]);

  const loadSessions = React.useCallback(async (): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    const items: SessionItem[] = await api.conversations.list().catch((e: unknown) => {
      console.error("[app] sessions list failed:", e);
      return [] as SessionItem[];
    });
    // A-918+：无变化则跳过 setState，避免 15s 轮询整棵侧栏树无谓重渲（启动/事件驱动的关键调用不受影响）
    const key = JSON.stringify(items.map((s) => [s.sessionId, s.title, s.count, s.lastTime]));
    if (key === sessionsKeyRef.current) { return; }
    sessionsKeyRef.current = key;
    setSessions(items);
    markFirstLoad("sessions"); // A-1039：首拉完成 → 记入启动门
  }, [markFirstLoad]);

  // 初始化：Agent 列表 + 会话列表 + 默认选中第一个会话
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    // A-918+：loadAgents 与 loadSessions 并行拉取（此前串行，启动首屏等待翻倍）
    void Promise.all([loadAgents(), loadSessions()]).then(async () => {
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
        markFirstLoad("providers"); // A-1039：记入启动门
      }).catch((e: unknown) => {
        console.error(e);
        markFirstLoad("providers"); // 失败也放行（否则门被单个数据源卡住）
      });
      api.providers.localList().then((list: LocalModelBrief[]) => {
        setLocalModels(list);
        markFirstLoad("localModels"); // A-1039：记入启动门
      }).catch((e: unknown) => {
        console.error(e);
        markFirstLoad("localModels"); // 失败也放行
      });
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [markFirstLoad]);

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

  /**
   * A-1058①：**没有"会话内容"可等的情形要立刻登记**，否则门只能干等到 8s 总超时。
   *
   * 判据必须与 `chatPanelJsx` 的分支条件**逐字对应**：ChatPanel 只在
   * `selectedSession && selectedAgentId` 时挂载，只有它会回调 `markChatHistoryLoaded`。
   * 因此「欢迎页（无会话）」与「有会话但拿不到 agentId → 落到那句占位文案」两条路径
   * 都必须在这里自己收尾，不能指望一个永远不会挂载的组件来登记。
   *
   * ⚠️ 先等 `firstLoad.sessions`：会话列表还没回来时 `hasNoSession` 恒真，
   *    此刻登记等于把门提前放行（正是要修的那个洞）。
   */
  React.useEffect(() => {
    if (!firstLoad.sessions) { return; }
    if (hasNoSession || !selectedAgentId) { markChatHistoryLoaded(); }
  }, [firstLoad.sessions, hasNoSession, selectedAgentId, markChatHistoryLoaded]);

  /** 欢迎区首条消息：自动建会话 + 立即发送首条消息。
   *  此前用 setTimeout 闭包依赖外部 selectedAgentId，但新建会话前 selectedAgentId 必为 null，
   *  导致只建会话不发送；现在直接用创建返回的 session.agentId。 */
  const handleWelcomeSend = React.useCallback(async (text: string): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api || !text.trim()) { return; }
    // 1. 创建会话（无 Agent 时主进程会兜底创建默认「助手」Agent）
    const res = await api.conversations.create().catch((e: unknown) => {
      console.error("[app] welcome create failed:", e);
      return null;
    });
    if (!res?.ok || !res.session) { return; }
    const sessionId = res.session.sessionId;
    const agentId = res.session.agentId;
    setSelectedSessionId(sessionId);
    void loadSessions();
    // 2. 立即发送首条消息
    if (api?.chat?.stream && agentId) {
      const netOn = readNetworkEnabled();
      void api.chat.stream({ agentId, message: text.trim(), sessionId, networkEnabled: netOn }).catch((e: unknown) => {
        console.error("[app] welcome stream failed:", e);
      });
    }
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
  }, [selectedSessionId, selectedAgentId, workspaceTick]);

  /** A-954：探活自研 SILAM 脑（sidecar 拉起成功才在供应商面板出现）——启动 + 每次打开新建会话弹窗时重查 */
  const refreshSilamStatus = React.useCallback((): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    api?.silam?.status?.().then((r: { enabled: boolean }) => setSilamOk(r.enabled === true)).catch(() => setSilamOk(false));
  }, []);
  React.useEffect(() => { refreshSilamStatus(); }, [refreshSilamStatus]);

  /**
   * A-980-R26：挂一次「该响自定义提示音了」订阅。
   * 主进程弹系统通知时若配置了自定义音频，会发信号过来；渲染层负责真的 `<audio>.play()`。
   * 只挂一次、卸载时清理——重复挂会导致一次通知响多遍。
   */
  React.useEffect(() => subscribeNotifySound(), []);

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

  /** 打开新建会话弹窗（可选预填工作文件夹：文件夹分组内点＋、或全局点＋留空；草稿状态在 NewProjectDialog 内） */
  function openNewSessionDialog(prefillWorkspace?: string | null): void {
    setNewProjectPrefill(prefillWorkspace === undefined ? null : prefillWorkspace);
    setNewProjectOpen(true);
    // A-955 epoll：弹窗打开时刷新 SILAM 可用性（sidecar 冷启动成功后再探），确保供应商面板及时出现
    refreshSilamStatus();
    // 弹窗打开时刷新 Agent 列表，避免创建 Agent 后弹窗仍显示"暂无"
    void loadAgents();
  }

  /** A-979：弹窗创建成功回调（切换会话 + 关弹窗 + 刷新列表） */
  const handleSessionCreated = React.useCallback(async (sessionId: string): Promise<void> => {
    setSelectedSessionId(sessionId);
    setNewProjectOpen(false);
    await loadSessions();
  }, [loadSessions]);

  /** 快速创建单人会话（ChatPanel「选择 Agent」路径，不经弹窗，不绑定文件夹） */
  async function quickCreateSession(agentId: string): Promise<string | null> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return null; }
    const res = await api.conversations.create({ agentId, workspace: null, memberIds: [], type: "normal" })
      .catch((e: unknown) => { console.error("[app] quick create session failed:", e); return null; });
    if (res?.ok && res.session) {
      setSelectedSessionId(res.session.sessionId);
      await loadSessions();
      return res.session.sessionId;
    }
    return null;
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

  /** A-980-R14：聊天主区内容（普通布局与右栏占满时的悬浮窗共用，避免两处重复大段 props） */
  const chatPanelJsx = hasNoSession ? (
    <WelcomeChat
      onSend={handleWelcomeSend}
      agents={agents}
      onChooseAgent={(agentId) => { void quickCreateSession(agentId); return Promise.resolve(); }}
      onOpenAgents={() => { setSettingsTab("agents"); setSettingsOpen(true); }}
    />
  ) : selectedSession && selectedAgentId ? (
    <ChatPanel
      key={selectedSession.sessionId}
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
      onWorkspaceChanged={() => { setWorkspaceTick((t) => t + 1); void loadSessions(); }}
      onSessionRenamed={(title) => {
        if (selectedSession) {
          void apiUpdateSessionTitle(selectedSession.sessionId, title);
        }
      }}
      onNewSessionRequested={() => {
        openNewSessionDialog(selectedSession?.workspace ?? "");
      }}
      onNavigateSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true); }}
      onToggleFloat={handleToggleFloat}
      onHistoryLoaded={markChatHistoryLoaded}
    />
  ) : (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)" }}>
      请点击侧栏"＋"新建会话（先选工作文件夹，再选 Agent）
    </div>
  );

  /**
   * A-980-R25：主区是否处于「浮层布局」——即**悬浮窗真的在渲染**。
   *
   * ⚠️ 这里必须比旧的宽泛判定严格：旧代码一旦 `rightWidth` 达到阈值就给 `<main>` 加 `main-float`
   * （`min-width: 0`），但 A-980-R21 起悬浮窗**不再随右栏占满自动出现**（要用户手动唤出）。
   * 于是「右栏拉到最大 + 收起左栏」时：main 被允许收成 0 宽，而聊天仍内联渲染 →
   * 聊天被挤成一条竖线（用户截图：x≈15~30 的畸形窄条）。
   * 现在与下面渲染分支共用同一条件：**只有浮层确实渲染时才让主区让位**；
   * 否则 main 保留 380px 保底，右栏自动让位给聊天区。
   */
  const mainIsFloatLayout = rightOpen && floatState !== "none"
    && rightWidth >= Math.max(560, window.innerWidth - 340);

  /**
   * A-1039 启动门判据（**唯一出处**，守卫按此断言）。
   *
   * ⚠️ 旧判据漏了 `degraded`：后端缺失/超时时 `emitBoot({phase:"degraded"})`，
   * 而旧条件里 `degraded` **不匹配任何一项** → 门当场放行。可那一刻首屏数据一项都没到，
   * 用户点开的就是一个空壳界面（每个面板都会各自触发一轮重活）。
   * 现在判据只看**两件事**：首屏数据是否齐（uiReady）+ 最短展示时间，与后端 phases 解耦。
   */
  const splashVisible = !splashMinDone || !uiReady;

  /** 启动阶段清单：如实反映"在等什么"，替代纯转圈（用户反馈「纯干等」） */
  const splashSteps: SplashStep[] = [
    { label: "本地后端服务", done: boot?.backendReady === true || boot?.phase === "degraded" },
    { label: "Agent 与会话列表", done: Boolean(firstLoad.agents && firstLoad.sessions) },
    { label: "模型与供应商配置", done: Boolean(firstLoad.providers && firstLoad.localModels) },
    // A-1058①：中间那栏的**会话内容**也在门内 —— 用户原话"这个中间的界面加载要一段时间，
    // 我说话你是听不见吗？给我算在加载界面里面"。此前门只等到"列表"，中间栏仍会在
    // 历史到达前显示空态，看着像已就绪实则没接上数据。
    { label: "会话内容", done: Boolean(firstLoad.chatHistory) },
  ];
  /** 状态文案：优先用主进程上报的 message，再按门内进度推导 */
  const splashStatus = boot?.phase === "degraded"
    ? (boot.message ?? "后端不可用，正在加载界面…")
    : (!uiReady ? "正在加载首屏数据…" : (boot?.message ?? "正在初始化…"));

  return (
    <div className="app">
      {/* 启动加载面板（A-1039 重做）：首帧即显示（boot 未到达也遮住，杜绝闪现应用界面），
          **首屏数据真正到齐前不隐藏**（此前只等会话列表 → 用户点开就是未就绪界面，遍地卡顿），
          最短展示 700ms 保证动画可见。退场有淡出过渡，不再是硬切。 */}
      <SplashScreen visible={splashVisible} status={splashStatus} steps={splashSteps} subtitle={`v${appVersion}`} />

      {/* A-1018：slime 主题确认/提示弹窗宿主（confirmAsync/alertAsync 的渲染层实现）。
          常驻挂载（自己按需渲染），全仓 38 处调用点无需改动。 */}
      <ThemeDialogHost />

      {/* A-1044：图形操作可视化（呼吸灯边框 + 悬浮提示）。常驻挂载、除"隐藏"按钮外不吞点击；
          它订阅的应用内来源由右栏浏览器桥（browserBridge）派发，系统级来源经 preload 转发。 */}
      <OperationFocusOverlay />

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
        <button className="titlebar-btn" onClick={toggleLeftSidebar}
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}>
          <MenuIcon size={16} />
        </button>
        <span className="titlebar-title">Slime</span>
        <span style={{ flex: 1 }} />
        {/* 右侧栏展开/收起（工作树 / 任务 / 终端 / 浏览器）——收起走「内容先淡出→再收缩」动画 */}
        <button className={`titlebar-btn${rightOpen ? " titlebar-btn-active" : ""}`}
          onClick={() => animateRightSidebar(!rightOpen)}
          title={rightOpen ? "收起右侧栏" : "展开右侧栏（工作树 / 任务 / 终端 / 浏览器）"}>
          {rightOpen ? <SidebarLeftIcon size={16} /> : <SidebarRightIcon size={16} />}
        </button>
      </header>

      <div className="body">
        {/* 左侧导航侧栏 —— A-946：侧栏不参与整体挤压（flexShrink:0），展开态最小 140px，防止变窄时按钮/文本被吞；
            A-980-R21：opacity 过渡由 leftSidebarRef 的 DOM style 控制（收起先淡出/展开延后淡入，无残留闪烁） */}
        <aside
          ref={leftSidebarRef}
          className={`sidebar${sidebarOpen ? "" : " collapsed"}${leftMin0 ? " sidebar-no-min" : ""}`}
          /* A-1018：未手动拖过时**不下发内联宽度** → 由 CSS 的
             `--sidebar-w: clamp(240px, 17.5%, 520px)` 随窗口比例自适应（拖动过则用 px 覆盖） */
          style={{ width: sidebarCustom ? sidebarWidth : undefined, flexShrink: 1, minWidth: sidebarOpen ? SIDEBAR_MIN_W : 0 }}
        >
          {sidebarOpen && <div className="sidebar-resizer" onPointerDown={handleSidebarResize} />}
          <div className="brand">
            {/* A-1054：此前这里是字面量 `S`（一个蓝色圆角方块里写个字母），用户反复要求换成
                应用图标 —— 这正是 A-1049 在欢迎页修过的同一类残留（那次也只改了欢迎页，
                侧栏这处漏了，所以"怎么还是 S"）。现在与欢迎页共用**同一个** `appIconUrl`，
                图标只有一处产地，不会再出现"改了一处、另一处还是旧样子"。
                `alt="slime"` + `draggable={false}`：图标是装饰性的名称标记，不该被拖走。 */}
            <img className="brand-icon" src={appIconUrl} alt="slime" draggable={false} />
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

        {/* 主内容区（对话面板常驻）。A-980-R14：右栏占满窗口时聊天主区变**悬浮窗**——
            不参与挤压（fixed 浮层）；A-980-R17：最小化=内容渐出+窗口同步缩小为可拖动图标，
            标题栏只留 最小化 / 恢复窗口 两按钮，状态按会话记忆 */}
        <main className={`main${mainIsFloatLayout ? " main-float" : ""}`}>
          {(() => {
            // A-980-R25：与上面的 mainIsFloatLayout **同一条件**（浮层真在渲染才切浮层布局）
            const fs: "none" | "float" | "min" = mainIsFloatLayout ? floatState : "none";
            if (fs !== "none") {
              const minIcon = fs === "min";
              const animOut = floatAnim === "out";
              // A-980-R25：退场阶段窗口收缩到 0（内容已按几何淡完），边框/阴影一并去掉，
              // 否则 0×0 的盒子仍会留下一个 2px 的边框点
              const closing = floatAnim === "closing";
              const w = closing ? 0 : (minIcon || animOut ? FLOAT_ICON_SIZE : floatSize.w);
              const h = closing ? 0 : (minIcon || animOut ? FLOAT_ICON_SIZE : floatSize.h);
              // A-980-R24：内容区的渐隐渐显**改由几何同步 rAF 驱动**（startFloatGeometryFade），
              // 不再用固定延时的 opacity 过渡——旧实现 0.08s 就淡完，观感"刚点就没了"且与窗口
              // 收缩不同拍（用户反馈"出现时机太早、生硬"；且固定时长在不同分辨率下表现不一致）。
              // 内容区最小化期间**常驻挂载但隐藏**（不卸载 ChatPanel——保留会话现场、不打断进行中的流）
              // A-980-R19：默认出现位置也整体钳制在窗口内（不再可能出现即越界）
              const defaultPos = fitFloatRect((sidebarOpen ? sidebarWidth : 0) + 12, 42, floatSize.w, floatSize.h);
              return (
                <div ref={floatRef} style={{
                  position: "fixed",
                  // A-980-R15：定位在**左栏右侧**（不再依赖 rightWidth——右栏占满时 rightWidth+10 会把
                  // 悬浮窗推到屏幕外，用户实测"初始出现大小异常"）；标题栏可拖动后按记忆位置显示
                  left: floatPos ? floatPos.x : defaultPos.x,
                  top: floatPos ? floatPos.y : defaultPos.y,
                  width: w,
                  height: h,
                  zIndex: 1000, display: "flex", flexDirection: "column",
                  borderRadius: 10,
                  border: closing ? "none" : "1px solid var(--border)",
                  background: "var(--bg)",
                  boxShadow: closing ? "none" : "0 10px 40px rgba(0,0,0,0.4)",
                  overflow: "hidden",
                  // A-980-R25：退场期间不吃鼠标事件（窗口正在缩到 0，避免挡住下面的聊天区）
                  pointerEvents: closing ? "none" : "auto",
                  // A-980-R17：悬浮窗拖到与程序标题栏（-webkit-app-region: drag 区域）重叠时，
                  // 必须 no-drag 才能收到鼠标事件，否则按到的是整窗拖拽（用户实测"顶边框重叠后拖不动"）；
                  // no-drag 由 index.css .float-window 类提供（内联 WebkitAppRegion 有 TS 类型限制）。
                  // 宽高常驻过渡供最小化/还原动画使用；拖拽调大小期间由 startFloatResize 临时禁用
                  transition: FLOAT_TRANSITION,
                }} className="float-window">
                  {/* 内容区（标题栏 + 聊天）：最小化期间隐藏挂载；opacity 由 startFloatGeometryFade
                      的 rAF 按外框实测尺寸逐帧写入（结束态 0=最小化 / 1=还原，与 JSX 稳态一致） */}
                  <div ref={floatInnerRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
                    opacity: minIcon ? 0 : 1,
                    pointerEvents: minIcon ? "none" : "auto" }}>
                    {/* 悬浮窗标题栏：拖住空白处移动 + 会话标题 + 最小化 / 恢复窗口 */}
                    <div style={{
                      display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                      height: 36, padding: "0 6px 0 10px",
                      background: "var(--sidebar-bg, #1e1e2e)",
                      borderBottom: "1px solid var(--border)",
                      cursor: "grab",
                    }} onPointerDown={startFloatDrag}>
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {selectedSession?.title || "对话"}
                      </span>
                      <button className="titlebar-btn" title="最小化（缩小为图标）" onClick={(e) => { e.stopPropagation(); minimizeFloat(); }}>─</button>
                      <button className="titlebar-btn" title="收起悬浮窗（恢复普通布局：聊天回到中间）" onClick={(e) => { e.stopPropagation(); dismissFloat(); }}>▢</button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
                      {chatPanelJsx}
                      {/* A-980-R16：右缘/底缘/右下角三重调大小（zIndex 200+ 须高于 ChatPanel 输入区 zIndex 30，
                          否则手柄被输入区遮挡既看不见也点不到——A-980-R15 实测"无法调节尺寸"根因；
                          右缘条 4px/底缘条 6px 尽量不遮消息区滚动条与输入区按钮） */}
                      <div onMouseDown={(e) => startFloatResize(e, "e")} title="拖动调整宽度"
                        style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 4, cursor: "ew-resize", zIndex: 200, userSelect: "none" }} />
                      <div onMouseDown={(e) => startFloatResize(e, "s")} title="拖动调整高度"
                        style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, cursor: "ns-resize", zIndex: 200, userSelect: "none" }} />
                      <div onMouseDown={(e) => startFloatResize(e, "se")} title="拖动调整大小"
                        style={{ position: "absolute", right: 0, bottom: 0, width: 24, height: 24, cursor: "nwse-resize", zIndex: 201, display: "flex", alignItems: "flex-end", justifyContent: "flex-end", color: "var(--text-dim)", fontSize: 12, userSelect: "none" }}>⤡</div>
                    </div>
                  </div>
                  {/* A-980-R17：最小化图标层——动画末尾渐入；最小化后覆盖全窗，可点击还原、可拖动
                      A-980-R27：还原走 startFloatDrag 的 onTap（原地松手=点击），不再用 onClick——
                      pointerdown 的 preventDefault 会掐掉 click，导致"只能变小、不能恢复" */}
                  <div onPointerDown={(e) => startFloatDrag(e, restoreFloat)}
                    title="点击还原悬浮窗（可拖动）"
                    style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      background: "var(--bg-secondary)", borderRadius: 10, cursor: "grab",
                      opacity: minIcon || animOut ? 1 : 0,
                      pointerEvents: minIcon ? "auto" : "none",
                      transition: "opacity 0.18s ease 0.12s" }}>
                    <img src={floatIconUrl} alt="slime" draggable={false} style={{ width: 26, height: 26 }} />
                  </div>
                </div>
              );
            }
            return (
              <div ref={inlineChatRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {chatPanelJsx}
              </div>
            );
          })()}
        </main>

        {/* 右侧栏（工作树 / 任务 / 终端 / 浏览器）——A-980-R24：外层 wrapper 承载几何同步渐隐渐显
            （opacity 逐帧 = smoothstep(实测宽/展开宽)，与 .right-sidebar 的 width 过渡同拍；无固定时间点）。
            ⚠️ 该 wrapper 是 `<webview>` 的祖先：opacity 只在过渡期间存在，结束即清空，切勿改为常驻值 */}
        {/* A-975-R4：wrapper 允许被收缩（flexShrink: 1）——右栏内部 min-width:260 兜底，
            这样窗口变窄时右栏会先让位，而不是把聊天区挤没 */}
        <div
          ref={rightWrapperRef}
          className={`right-wrapper${rightMin0 ? " right-wrapper-no-min" : ""}`}
          style={{ display: "flex", flexShrink: 1, minWidth: 0 }}
        >
        <RightSidebar
          open={rightOpen}
          onToggle={() => animateRightSidebar(!rightOpen)}
          agentId={selectedAgentId}
          agentName={selectedSession?.agentName ?? ""}
          sessionId={selectedSession?.sessionId}
          sessionType={selectedSession?.type}
          memberIds={selectedSession?.memberIds ?? []}
          memberModels={selectedSession?.memberModels ?? {}}
          leaderModel={selectedSession?.leaderModel}
          memberEfforts={selectedSession?.memberEfforts ?? {}}
          leaderEffort={selectedSession?.leaderEffort}
          workspace={sessionWorkspace}
          providerModels={providerModels}
          dl={dl}
          width={rightCustom ? rightWidth : undefined}
          onResize={handleRightbarResize}
        />
        </div>
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

      {/* ── A-979：新建会话弹窗——已抽为独立组件 NewProjectDialog（草稿状态内聚，弹窗交互不再触发整棵 App 树重渲染） ── */}
      <NewProjectDialog
        open={newProjectOpen}
        prefillWorkspace={newProjectPrefill}
        agents={agents}
        agentConfig={agentConfig}
        draftProviders={draftProviders}
        silamOk={silamOk}
        currentSessionSvg={currentSessionSvg}
        teamSvg={teamSvg}
        onClose={() => setNewProjectOpen(false)}
        onCreated={handleSessionCreated}
        onManageAgents={() => { setNewProjectOpen(false); setSettingsTab("agents"); setSettingsOpen(true); }}
        onOpen={() => { refreshSilamStatus(); void loadAgents(); }}
      />
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

  /** A-980-R27：左栏拖拽——改用 Pointer Events + setPointerCapture。
   *  旧实现是 document 级 mousemove/mouseup：指针一旦划过 `<webview>`（Chromium OOPIF），
   *  事件被送进 guest 进程，renderer 收不到 mouseup → onUp 不执行 → `body.slime-resizing`
   *  残留、拖拽脱离鼠标自己跟着走（用户实测"拖拽变窄卡住、强行拉动还会拽动左侧边栏"）。
   *  指针捕获后事件一律回到本元素，不再被 guest 截走；blur / pointercancel 仍是兜底。 */
  function handleSidebarResize(e: React.PointerEvent): void {
    e.preventDefault();
    setSidebarCustom(true); // A-1018：一旦用户手动拖过，就按 px 记住（不再走 CSS 比例自适应）
    const captureEl = e.currentTarget as HTMLElement;
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* 指针 id 已失效则忽略 */ }
    document.body.classList.add("slime-resizing");
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    let lastW = startWidth;
    const onMove = (ev: PointerEvent): void => {
      // 左栏：鼠标向右 → 变宽（范围 240–520，**不给占满全屏**）
      lastW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, ev.clientX - startX + startWidth));
      setSidebarWidth(lastW);
    };
    const onUp = (): void => {
      document.body.classList.remove("slime-resizing");
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      try { captureEl.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      // A-980-R27：只有**真拖到几何下限**（240 + 吸附带）才收起。旧的 `<= 300` 是绝对像素，
      // 把「刚比下限宽一点」的整段区间都算成"拖到底"——左栏默认宽才 262，于是收起后重新
      // 拉宽，宽度一从下限起步就又触发收起，观感就是"左栏拉不开"。
      if (lastW <= SIDEBAR_MIN_W + SIDEBAR_SNAP_W) {
        // 下次展开用的宽度 = **这次拖拽开始前的宽度**（用户真正想要的那个宽度）。
        // 若拖之前本来就贴着下限（没有可留念的宽度），回落到按屏幕比例算的默认宽——
        // 保证下次展开出来的宽度一定在吸附带之外，不会一展开就又被自己"拖到底"。
        const fallback = Math.round(window.innerWidth * SIDEBAR_RATIO.left);
        const restoreW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W,
          startWidth > SIDEBAR_MIN_W + SIDEBAR_SNAP_W ? startWidth : fallback));
        setSidebarWidth(restoreW);
        localStorage.setItem('slime_sidebar_w', String(restoreW));
        // 走与按钮完全同一条几何同步淡出（此前是 setSidebarOpen(false) 裸切状态，内容直接消失）
        animateLeftSidebar(false);
        return;
      }
      const w = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, lastW));
      setSidebarWidth(w);
      localStorage.setItem('slime_sidebar_w', String(w));
    };
    const onCancel = (): void => {
      document.body.classList.remove("slime-resizing");
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    // 拖动中窗口失焦（alt-tab 等）兜底结束拖拽，避免 slime-resizing 残留
    window.addEventListener('blur', onCancel);
  }

  function handleRightbarResize(e: React.PointerEvent): void {
    e.preventDefault();
    setRightCustom(true); // A-1018：同左栏——拖过就按 px 记住
    const captureEl = e.currentTarget as HTMLElement;
    // A-980-R27：与左栏同一套——指针捕获，避免指针划过 `<webview>`（OOPIF）时
    // mousemove/mouseup 被 guest 进程吃掉 → 拖拽卡死且 slime-resizing 残留
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* 指针 id 已失效则忽略 */ }
    document.body.classList.add("slime-resizing");
    const startX = e.clientX;
    const startWidth = rightWidthRef.current;
    let lastW = startWidth;
    // A-918++ 修复「拖动卡死 + 宽度不更新」：此前 onMove → rAF → setRightWidth 每帧触发 App 整树
    // 重渲染（ChatPanel/RightSidebar/设置面板全重渲）→ 主线程阻塞 → 鼠标卡死、宽度跟不上。
    // 现在拖动期间直接改右栏 DOM 的 style.width（零 React 重渲染），松开才 setRightWidth 落 state。
    const asideEl = document.querySelector<HTMLElement>(".right-sidebar");
    // A-1016-F3：上限收敛到 `rightSidebarMaxW()`——与展开动画的钉宽**共用同一份实现**，
    // 避免"同一约束两处各写一遍 → 两个默认值"（此前这里的公式是内联的）。
    // ⚠️ 浮层已唤出时例外：此时主区是 fixed 浮层（`.main-float` min-width:0），不需要给它留位，
    // 而且右栏宽度掉到 `innerWidth-340` 以下会让 mainIsFloatLayout 变假、浮层被瞬间卸载——
    // 所以浮层态沿用"可占满窗口"的旧上限，拖一下不会把浮层挤掉。
    const maxW = rightSidebarMaxW();
    // A-980-R29：右栏**最窄宽度** = 截图比例（minW），拖拽中下限就到此为止——
    // 不再解锁 CSS min-width（R27 为治"卡住"临时设过 minWidth:0 + 下限 0，副作用是右栏能无限拖窄，
    // 用户实测"右侧边栏的最小宽度限制没了"）。minW ≥ 260 ≥ CSS min-width，所以 CSS 也不会顶回宽度。
    // 贴到最窄（±吸附带）松手 → 收起，语义与 A-980-R14 一致。
    const minW = rightSidebarMinW();
    const onMove = (ev: PointerEvent): void => {
      // 右栏：鼠标向左 → 变宽。下限 = 最窄宽度（截图比例），拖拽中始终跟手、且不会比最窄更窄
      lastW = Math.max(minW, Math.min(maxW, startX - ev.clientX + startWidth));
      if (asideEl) { asideEl.style.width = `${lastW}px`; }
    };
    const onUp = (): void => {
      document.body.classList.remove("slime-resizing");
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      try { captureEl.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      // 原地点击（没拖动）＝什么都不做：别让"点一下手柄"把宽度按上限重新夹一次
      if (lastW === startWidth) { return; }
      // A-980-R29：吸附带贴着**最窄宽度**（minW + 8px）——拖拽下限就是 minW，
      // 所以"贴到最窄松手"必然命中此分支触发收起，不会再出现 R27 时期"能拖到 260 以下"的情况
      if (lastW <= minW + SIDEBAR_SNAP_W) {
        // A-980-R26：拖到最窄的「收起」走与按钮/悬浮窗**同一个** animateRightSidebar 退场：
        // 右栏内容几何同步淡出，浮窗（若在）一并退场，聊天栏再渐显（此前是 setRightOpen(false)
        // 裸切状态 → 内容被 overflow:hidden 一路挤压着消失）。
        // 清掉拖拽期写下的内联 width：否则 React 认为 prop 未变而不再写回，会留下脏内联值。
        if (asideEl) { asideEl.style.width = ""; }
        // 下次展开宽度 = 拖拽前的宽度（不低于最窄宽度），保证它落在吸附带之外
        const restoreW = Math.max(minW, Math.min(maxW, startWidth));
        setRightWidth(restoreW);
        localStorage.setItem('slime_rightbar_w', String(restoreW));
        animateRightSidebar(false);
        return;
      }
      let w = Math.max(minW, Math.min(maxW, lastW));
      if (w >= maxW - 80) {
        w = maxW;
      }
      localStorage.setItem('slime_rightbar_w', String(w));
      // 松开才触发一次 React 重渲染，最终宽度落 state（供下次拖动起点 + 持久化一致）
      setRightWidth(w);
    };
    const onCancel = (): void => {
      document.body.classList.remove("slime-resizing");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      // 失焦/指针作废：用户并没有"松手"，所以不判吸附收起；但当前几何必须落成 state 并清掉
      // 拖拽期的内联 width，否则 React 认为 prop 未变而不再写回，会留下脏内联值
      if (asideEl) { asideEl.style.width = ""; }
      setRightWidth(Math.max(minW, Math.min(maxW, lastW)));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    // 拖动中窗口失焦（alt-tab 等）兜底结束拖拽，避免 slime-resizing 残留
    window.addEventListener("blur", onCancel);
  }

  /** A-980-R24：左侧栏收起/展开。
   *  动画语言统一为「**几何同步**」：宽度由 CSS 过渡（0.25s），内容 opacity 由 rAF 按**实测宽度**
   *  逐帧求值（opacity = smoothstep(实测宽 / 展开宽)）——两者天然同拍，不再有"内容先消失、
   *  面板还在缩"的错位（旧实现 0.07s 置透明，用户反馈"出现时机太早、生硬"）。
   *  且该映射与屏幕/刷新率/过渡时长无关，任何分辨率下表现一致（用户明确要求）。
   *  A-980-R27：抽成带显式方向的函数，好让「拖到最窄的吸附收起」复用**同一条**退场
   *  （此前那条路是 setSidebarOpen(false) 裸切状态，内容直接消失、完全没有渐隐）。 */
  function animateLeftSidebar(nextOpen: boolean): void {
    leftFadeCancelRef.current?.();
    leftFadeCancelRef.current = null;
    const el = leftSidebarRef.current;
    // 展开：先把内容置 0（否则会先闪一帧全不透明），再交给几何同步逐帧放开
    if (nextOpen && el) {
      el.style.opacity = "0";
      // A-980-R34：展开期间临时解除 min-width——否则内联 minWidth:240 把宽度钳在下限之上，
      // 实测宽度从 0 起跳、渐变带 [0.40,0.95]×full 进不去，窄栏展开看不到渐入。done 后复位。
      setLeftMin0(true);
    }
    setSidebarOpen(nextOpen);
    leftFadeCancelRef.current = runGeometrySyncFade(
      () => leftSidebarRef.current,
      (p, done) => {
        if (done) { setLeftMin0(false); }
        const node = leftSidebarRef.current;
        if (!node) { return; }
        node.style.opacity = done ? "" : String(p);
      },
      // A-980-R34：左栏用专属提前窗 [0.40,0.95]——渐出从 95% 宽就开始、渐入从 40% 宽就启动，
      // 比右栏 [0.45,0.90] 时机更早（带宽 55% 也更宽，窄栏下依然明显）
      { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_LO, hiRatio: LEFT_FADE_HI },
    );
  }

  function toggleLeftSidebar(): void {
    animateLeftSidebar(!sidebarOpen);
  }

  /** A-1016-F3：右栏**实际可达**的最大宽度——拖拽与展开动画**共用这一份实现**。
   *
   *  实测模型（index.css）：`.main { flex: 1 1 0%; min-width: 380px }`（flex-basis 0）、
   *  左侧栏 `flexShrink:0`、右栏 wrapper `flexShrink:1`。于是当
   *  `左 + 右(请求) + 380 > innerWidth` 时，**全部收缩量都由右栏 wrapper 承担**
   *  （主区 basis 为 0 → 加权收缩量 0，只会停在 min-width:380），
   *  右栏实际宽度 = `innerWidth - 左 - CHAT_MIN_W`。
   *  实测对齐：1280 窗口请求 820 → 实际 640 = 1280-260-380。
   *
   *  ⚠️ 为什么不"强制布局实测最终宽度"：那样必须临时改元素样式再读布局，而**任何在改动态下的
   *  强制布局都会污染浏览器缓存的 computed style**——还原后若不额外 flush，下一帧的样式变化
   *  被判为"无变化"，**过渡根本不启动**（实测：aside 全程 316.96 一动不动）。
   *  要修就得再 flush 一次，等于每次展开前白做两次全量布局。公式法零布局、零 DOM 改动。
   *  ⚠️ 上限必须**减掉左栏与主区的最小占位**（A-980-R27）：旧实现只留 48px 缝隙，右栏一拖宽
   *  这一行就溢出，而左栏是可收缩的 → 溢出量被它吃掉，用户看到的是"拖右栏会拽动左侧边栏"；
   *  左栏被压窄后右栏左缘跟着左移，鼠标↔宽度映射随之漂移，越拖越不跟手（"卡住"）。
   *  左栏宽度取**实测值**（可能已被窗口挤过），不是 state。
   *  ⚠️ 浮层态例外：主区是 fixed 浮层（`.main-float` min-width:0），不占位 → 沿用"可占满窗口"上限。 */
  function rightSidebarMaxW(): number {
    const leftEl = leftSidebarRef.current;
    const leftW = leftEl ? leftEl.getBoundingClientRect().width : 0;
    const floatActive = floatStateRef.current !== "none";
    return Math.max(360, floatActive
      ? window.innerWidth - 48
      : Math.min(window.innerWidth - 48, window.innerWidth - leftW - CHAT_MIN_W));
  }

  /** A-1016-F3：右栏宽度过渡期间钉住 `<webview>` guest 的宽度（只裁切、不逐帧跨进程 resize）。
   *
   *  背景：右栏里嵌着 Chromium OOPIF（`<webview>`）。宽度过渡每帧都会改 guest 的布局宽度，
   *  触发**跨进程** reflow → 实测 7 帧掉帧 / dtP95 21.8ms、guest 宿主宽度跨度 560px；
   *  把 guest 钉在固定宽度、仅靠祖先 `overflow:hidden` 裁切 → 掉帧 ≤1、跨度 0px
   *  （内层加 `contain` 仍掉帧 → 成本在跨进程 resize 本身，不在 guest 内部重排）。
   *
   *  `px = null` 解除（动画结束/被打断）。只在**真的会动**时才挂：已经收起到 0 宽时再"收起"是
   *  空操作，钉住反而会让 guest 先撑宽再塌回，白做两次 resize。
   *  ⚠️ 与 `<webview>` 的合成铁律无关：这里动的是 guest **自身**的 width，
   *     没有给任何祖先加 opacity/filter/transform/backdrop-filter。 */
  function setRightWebviewPin(px: number | null): void {
    const el = rightWrapperRef.current;
    if (!el) { return; }
    // 右栏里没嵌任何 `<webview>`（没开浏览器页）→ 没有跨进程 resize 可省，直接走原路径，
    // 不挂类（省掉一次对整个 wrapper 子树的样式失效）。
    const hasGuest = px !== null && !!document.querySelector(".right-sidebar webview");
    if (px === null || !(px > 1) || !hasGuest) {
      el.classList.remove("right-wrapper-pin");
      el.style.removeProperty("--right-pin-w");
      return;
    }
    el.style.setProperty("--right-pin-w", `${Math.round(px)}px`);
    el.classList.add("right-wrapper-pin");
  }

  /** A-980-R24：右侧栏收起/展开（与左栏同一套几何同步动画）；nextWidth 可选——直达目标宽度。
   *
   *  ⚠️ 历史坑（务必保留此约束）：右栏 wrapper 里嵌着 `<webview>`（Chromium OOPIF），
   *  祖先一旦**永久**带着 opacity<1 / backdrop-filter / filter，guest 会被放进独立合成层，
   *  造成「页面能渲染、鼠标命中测试失效」= "能进网站但什么都点不动"。
   *  这里的 opacity 只在**过渡期间**存在（动画结束立刻清空为 CSS 常态 1），不构成永久合成条件。
   *  A-980-R27：原注释里的"1s 硬兜底保证复位"已随几何化内核删除——复位靠"宽度停住即 done"这条
   *  必然成立的判据（过渡跑完宽度一定停）；唯一的"取消但不重启"路径是切会话，那里会显式清空 opacity。 */
  function animateRightSidebar(nextOpen: boolean, nextWidth?: number): void {
    rightFadeCancelRef.current?.();
    rightFadeCancelRef.current = null;
    // A-1016-F3：上一轮被打断时钉子可能还挂着 → 先摘，再按本轮重新决定（避免脏 pin 叠加）
    setRightWebviewPin(null);
    const el = rightWrapperRef.current;
    // A-1016-F3：钉住宽度。**只在该次动画真的会改变宽度时**才挂：
    //   · 展开 → 请求宽可能超过实际可达（wrapper 会被窗口压窄，见 rightSidebarMaxW），
    //     按**可达值**钉，解除时才不会有"820 猛缩到 640"的落差；
    //   · 收起 → 钉在当前实测宽（guest 全程不缩、只被裁掉），已是 0 就是空操作，不挂。
    const pinTarget = nextOpen
      ? Math.min(nextWidth ?? rightWidth, rightSidebarMaxW())
      : (document.querySelector<HTMLElement>(".right-sidebar")?.getBoundingClientRect().width ?? 0);
    if (pinTarget > 1) { setRightWebviewPin(pinTarget); }
    if (nextOpen) {
      if (nextWidth !== undefined) { setRightWidth(nextWidth); }
      if (el) { el.style.opacity = "0"; }
      // A-980-R34：展开期间临时解除内部 .right-sidebar 的 min-width（CSS: .right-wrapper-no-min .right-sidebar
      // { min-width: 0 }）——否则 260px 下限把展开钳在下限之上，渐变带 [0.45,0.90]×full 进不去，
      // 窄栏展开看不到渐入。done 后复位。
      setRightOpen(true);
      setRightMin0(true);
      rightFadeCancelRef.current = runGeometrySyncFade(
        () => rightWrapperRef.current,
        (p, done) => {
          if (done) { setRightMin0(false); setRightWebviewPin(null); }
          const node = rightWrapperRef.current;
          if (!node) { return; }
          node.style.opacity = done ? "" : String(p);
        },
        { min: 0, full: nextWidth ?? rightWidth },
      );
    } else {
      // 右栏占满时聊天悬浮窗一并退出浮层（恢复普通布局）
      // A-980-R25：必须走退场动画（此前 setFloatState("none") 直接卸载 → 聊天瞬间消失/瞬间出现）
      dismissFloat();
      setRightOpen(false);
      rightFadeCancelRef.current = runGeometrySyncFade(
        () => rightWrapperRef.current,
        (p, done) => {
          if (done) { setRightWebviewPin(null); }
          const node = rightWrapperRef.current;
          if (!node) { return; }
          node.style.opacity = done ? "" : String(p);
        },
        { min: 0, full: rightWidth },
      );
    }
  }

  /** A-980-R21：悬浮窗手动唤出/收起（上下文圆环右侧按钮）——右栏**不再占满即自动出现**（A-980-R14 曾自动），
   *  需手动点按。
   *  A-980-R30：**哪里收起就哪里打开**——最小化态点按钮 = 从图标原位还原（restoreFloat，fitFloatRect
   *  保证展开不越界）；浮层态点按钮 = 收起；未唤出 = 右栏展开到最宽 + 浮层显示（记忆位置优先）。
   *  此前 min 态点按钮走 dismissFloat（整窗收起消失），用户觉得"打开的按钮行为不连贯"。 */
  function handleToggleFloat(): void {
    if (floatStateRef.current === "min") { restoreFloat(); return; }
    if (floatStateRef.current === "float") { dismissFloat(); return; }
    // A-980-R25：记住唤出前的右栏宽度——收起浮窗时归还，右栏平滑滑回原宽，
    // 中间聊天栏随之"长出来"（而不是一次性弹到最小宽度）
    preFloatRightWidthRef.current = rightWidth;
    animateRightSidebar(true, Math.max(560, window.innerWidth - 48));
    setFloatState("float");
  }

  /**
   * A-980-R25：悬浮窗「收起」（退场）——**必须带动画**。
   *
   * 背景（用户反馈）：不论是把浮窗手动拉到最小尺寸后收起，还是直接点悬浮窗的收起，
   * 都是 `setFloatState("none")` 瞬时卸载 → 聊天栏"啪"地消失、又"啪"地以整块出现，
   * 唯独这条路没有渐隐渐显（最小化/还原早就有）。
   *
   * 现在：置 closing 阶段 → 窗口向中心收拢到 0（宽高走 FLOAT_TRANSITION_FULL）
   * + 内容按**实测宽度**几何淡出（min=0，可见性窗口自动让内容在 30% 宽度处就淡完）；
   * 窗口真的收到位（几何 done）后才真正卸载浮层，并把右栏宽度还给唤出前的值，
   * 最后让内联聊天区几何淡入。
   * A-980-R27：这一步过去是 `setTimeout(…, 320)` 计时器——固定时长与真实过渡（0.3s 宽高 +
   * 布局让位）在高刷/低刷上并不对齐，收早了会截断退场、收晚了会让聊天区多空一拍。
   * 现在改由 startFloatGeometryFade 的 done 回调推进（见下），彻底去掉时间量。 */
  function dismissFloat(): void {
    if (floatStateRef.current === "none" || floatClosingRef.current) { return; }
    floatClosingRef.current = true;
    const el = floatRef.current;
    if (el) {
      // 向展开位置中心收拢（与最小化同一语言：观感是"在原位缩回"，不是"往左上角塌"）
      const cx = Math.round(el.offsetLeft + el.offsetWidth / 2);
      const cy = Math.round(el.offsetTop + el.offsetHeight / 2);
      el.style.transition = FLOAT_TRANSITION_FULL;
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
    }
    setFloatAnim("closing");
    // 内容淡出：量外框宽度、min=0（窗口收到 0 宽）；退场收尾挂在几何 done 上
    startFloatGeometryFade(0, () => {
      // 期间被最小化/还原打断（那两条路会复位本标记）→ 这次退场作废，别把 state 落成 none
      if (!floatClosingRef.current) { return; }
      floatClosingRef.current = false;
      setFloatAnim("idle");
      setFloatState("none");
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; }
      // 归还右栏宽度（若曾记录）：右栏 width 过渡 0.25s → 主区宽度逐步长开 →
      // 内联聊天区的几何淡入才有几何可依（否则会一次性弹满）
      const back = preFloatRightWidthRef.current;
      preFloatRightWidthRef.current = null;
      if (back !== null && Number.isFinite(back)) { setRightWidth(back); }
      // A-980-R33：主区目标宽度 = 窗口宽 − 实测左栏宽 − 归还后的右栏宽——
      // 聊天区淡入窗口按它换算成比例（与侧栏/悬浮窗同一套 FADE_VISIBLE_LO/HI），自适应界面。
      const leftW = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
      const targetRight = Number.isFinite(back) ? (back as number) : rightWidthRef.current;
      const mainW = Math.max(CHAT_MIN_W, window.innerWidth - leftW - targetRight);
      // 等 React 提交内联聊天区后再起几何淡入（两帧：避开 commit 边界）
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => startInlineChatRevealFade(mainW)));
    });
  }

  /**
   * A-980-R25：内联聊天区「长出来」时的几何淡入。
   *
   * A-980-R33：窗口改为**比例**（lo/hi 默认按 full 的 FADE_VISIBLE_LO/HI 换算），
   * full = 主区展开后的目标宽度（由 dismissFloat 实测计算）——任何分辨率/窗口大小下，
   * 聊天内容都是"主区 45% 宽前全透明、90% 宽才全显示"，与侧栏/悬浮窗观感一致，
   * 不再用固定像素（窗口一变就过窄/过宽）。
   * 结束即清空 opacity（回 CSS 常态 1）——稳态永不半透明，避免误伤"内容看不见"。
   */
  function startInlineChatRevealFade(full: number): void {
    chatFadeCancelRef.current?.();
    chatFadeCancelRef.current = null;
    const node = inlineChatRef.current;
    if (!node) { return; }
    node.style.opacity = "0";
    chatFadeCancelRef.current = runGeometrySyncFade(
      () => inlineChatRef.current,
      (p, done) => {
        const n = inlineChatRef.current;
        if (!n) { return; }
        n.style.opacity = done ? "" : String(p);
      },
      { min: 0, full },
    );
  }

  /** A-980-R15：悬浮窗标题栏拖动（拖拽中直接改 DOM，松手落 state 按会话记忆）。
   *  A-980-R17：同时承担最小化图标的拖动；移动超过阈值记录 moved，松手后的 click 不再触发还原
   *  A-980-R21：改 Pointer Events + setPointerCapture——鼠标快速移出元素/窗口不脱手；拖动期间
   *  禁宽高过渡 + will-change，杜绝"拖快了脱手/卡顿"
   *  A-980-R27：新增 onTap——**最小化图标的"点击还原"必须走这里，不能挂在 onClick 上**。
   *  本函数开头的 `e.preventDefault()` 会抑制 pointerdown 派生的兼容鼠标事件（含 click），
   *  于是图标点下去永远不触发还原，用户看到的就是"只能变小、不能恢复的按钮"。
   *  现在在同一个指针序列里判：移动没超过 3px 就算点击 → 调 onTap（拖动过则只落位置）。 */
  function startFloatDrag(e: React.PointerEvent<HTMLDivElement>, onTap?: () => void): void {
    if (e.button !== 0) { return; }
    if ((e.target as HTMLElement).closest?.("button")) { return; } // 按钮不触发拖动
    floatDragMovedRef.current = false;
    e.preventDefault();
    const el = floatRef.current;
    if (!el) { return; }
    const pid = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = el.offsetLeft, startTop = el.offsetTop;
    // 拖动期间禁用过渡（宽高过渡会追不上鼠标）+ 提示 GPU 合成，松手恢复
    const prevTransition = el.style.transition;
    el.style.transition = "none";
    el.style.willChange = "left, top";
    try { el.setPointerCapture(pid); } catch { /* 指针 id 已失效则忽略 */ }
    const onMove = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
        floatDragMovedRef.current = true;
      }
      // A-980-R16：拖动位置钳制在窗口内（避免拖出屏幕后无法拖回）
      const p = clampFloatPos(startLeft + ev.clientX - startX, startTop + ev.clientY - startY);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    };
    /** @param tap 是否是"原地松手"（pointerup）。pointercancel / blur 不算点击 */
    const finish = (tap: boolean): void => {
      try { el.releasePointerCapture(pid); } catch { /* 已释放 */ }
      el.style.transition = prevTransition || FLOAT_TRANSITION;
      el.style.willChange = "";
      const landed = clampFloatPos(el.offsetLeft, el.offsetTop);
      setFloatPos(landed);
      // A-980-R36：最小化态拖动图标 = 给图标"搬家"——记住这个位置作为图标之家，
      // 之后每次最小化都回到这里（哪个角收起就哪个角展开）。展开态拖的是窗口，不更新。
      if (floatStateRef.current === "min") { floatIconHomeRef.current = landed; }
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      if (tap && !floatDragMovedRef.current) { onTap?.(); }
    };
    const onPointerUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  }

  /** A-980-R17：悬浮窗最小化——内容渐出（远早于缩小）+ 窗口同步缩小为图标尺寸，动画结束进入 min 图标态。
   *  A-980-R21：**向展开位置收拢**——以当前（展开）位置中心为锚，窗口整体（top/left + 宽高）同步过渡到
   *  44×44 图标，观感是"在原位缩回"而非"固定左上角收缩"；位置经 fitFloatRect 钳制绝不越界 */
  function minimizeFloat(): void {
    floatClosingRef.current = false; // A-980-R25：被打断的退场标记要复位，否则后续收起被误判为"进行中"
    const el = floatRef.current;
    if (el) {
      // A-980-R36：图标若有"家"（用户手动摆过）→ 最小化回那里（哪个角收起就哪个角展开）；
      // 从未摆过 → 保持"原位缩回"（图标中心对齐展开窗中心）。
      const home = floatIconHomeRef.current;
      let tx: number;
      let ty: number;
      if (home) {
        tx = home.x;
        ty = home.y;
      } else {
        const cx = el.offsetLeft + el.offsetWidth / 2;
        const cy = el.offsetTop + el.offsetHeight / 2;
        tx = cx - FLOAT_ICON_SIZE / 2;
        ty = cy - FLOAT_ICON_SIZE / 2;
      }
      const fitted = fitFloatRect(tx, ty, FLOAT_ICON_SIZE, FLOAT_ICON_SIZE);
      el.style.transition = FLOAT_TRANSITION_FULL; // top/left 与宽高一起过渡（宽度/高度由 animOut 态切到 44）
      el.style.left = `${fitted.x}px`;
      el.style.top = `${fitted.y}px`;
      setFloatPos(fitted);
    }
    // 先切 out 态（窗口目标尺寸变 44）再起几何同步，避免首帧量到的还是"展开宽"
    setFloatAnim("out");
    // A-980-R24：内容透明度由**几何同步**驱动（量外框宽度，最小 = 图标 44px）——
    // 内容恰好在窗口缩到图标尺寸的同一帧消失，不再"刚点就没了"
    // A-980-R27：收尾（落 min 态）挂在几何 done 上，替代原来的 300ms 计时器
    startFloatGeometryFade(FLOAT_ICON_SIZE, () => {
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; } // 动画结束：恢复基础过渡（拖拽跟手）
      setFloatState("min");
      setFloatAnim("idle");
    });
  }

  /** A-980-R17/R19：悬浮窗还原——图标展开为窗口（**哪里有位置往哪里去**：展开前把位置钳到
   *  完整容纳目标尺寸，空间不足整体上移/左移，绝不跑出界面；top/left 与宽高同步过渡），随后内容延后渐入 */
  function restoreFloat(): void {
    floatClosingRef.current = false; // A-980-R25：复位被中断的退场标记
    const el = floatRef.current;
    const targetW = floatSizeRef.current.w;
    const targetH = floatSizeRef.current.h;
    if (el) {
      const fitted = fitFloatRect(el.offsetLeft, el.offsetTop, targetW, targetH);
      if (fitted.x !== el.offsetLeft || fitted.y !== el.offsetTop) {
        // 位置需调整（下方/右侧空间不足）→ top/left 与宽高一起过渡，观感为"向有空间的方向展开"
        el.style.transition = FLOAT_TRANSITION_FULL;
        el.style.left = `${fitted.x}px`;
        el.style.top = `${fitted.y}px`;
        setFloatPos(fitted);
      } else {
        el.style.transition = FLOAT_TRANSITION;
      }
    }
    setFloatState("float");
    setFloatAnim("in");
    // A-980-R30：还原方向（44 → 展开宽）首帧宽度在下限，几何 fade 从 0 淡入；
    // 显式预置 opacity=0（此前由 startFloatGeometryFade 内部统一置 0——但那只对"从窄变宽"
    // 的方向正确；最小化/退场方向首帧宽度是展开宽 p=1，被"立即置 0"后再写 1 会造成闪一下）。
    const fi = floatInnerRef.current;
    if (fi) { fi.style.opacity = "0"; }
    // A-980-R24：还原同样走几何同步——内容 opacity 从"窗口多大"长出来，与展开几何严格同步
    // A-980-R27：结束（落 idle、恢复基础过渡）挂在几何 done 上，替代原来的 40ms+340ms 两段计时器。
    // 那两段计时器只是"猜"窗口什么时候长完，猜错就会把内容 opacity 留在中途或让拖拽带着 top/left 过渡。
    startFloatGeometryFade(FLOAT_ICON_SIZE, () => {
      setFloatAnim("idle");
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; }
    });
  }

  /** A-980-R24：悬浮窗内容层「几何同步」渐隐渐显——量**外框**尺寸，把比例写到**内容层**的
   *  opacity 上（外框自身不透明，避免给 webview 造永久合成层）。
   *  路径：窗口尺寸由 CSS 过渡（0.3s），内容透明度按实测尺寸逐帧求值 → 两者天然同拍。
   *  @param minW 收缩下限：最小化/还原传图标尺寸；「收起」退场传 0（窗口收到 0 宽）
   *  @param onDone 几何动画跑完（外框宽度停住）时的收尾——A-980-R27 用它替掉了
   *                最小化/还原/退场三处的固定时长计时器（300ms / 320ms / 40+340ms）：
   *                "窗口真的缩到位/长到位了"才是下一阶段的开始，而不是"猜过了多久"。 */
  function startFloatGeometryFade(minW: number = FLOAT_ICON_SIZE, onDone?: () => void): void {
    floatFadeCancelRef.current?.();
    floatFadeCancelRef.current = null;
    // A-980-R30：不再无条件置 0——最小化/退场方向首帧宽度是展开宽（p=1），先置 0 再写 1
    // 会闪一下全显示；还原方向的预置 0 由 restoreFloat 自己负责（唯一需要"从透明起步"的方向）。
    floatFadeCancelRef.current = runGeometrySyncFade(
      () => floatRef.current,
      (p, done) => {
        const node = floatInnerRef.current;
        if (node) {
          // 结束值保留（最小化终态=0、还原终态=1），随后的 setFloatState 会写入同一值，无跳变。
          // A-980-R27：这里的 done 是"宽度真的停住了"，所以终态取值一定与窗口实际尺寸一致——
          // 旧实现混了时间兜底，还原方向可能在外框还很窄时就被判 done 而把 opacity 钉死在 0。
          node.style.opacity = String(done ? (p < 0.5 ? 0 : 1) : p);
        }
        if (done) { onDone?.(); }
      },
      { min: minW, full: floatSizeRef.current.w },
    );
  }

  /** A-980-R16：悬浮窗拖拽调尺寸（右缘 e=宽 / 底缘 s=高 / 右下角 se=两者；
   *  拖拽中直接改 DOM，松手落 state 按会话记忆；尺寸钳制在窗口内）。
   *  A-980-R17/R19：拖拽期间临时禁用宽高过渡（否则 0.3s 过渡让尺寸追不上鼠标），松手恢复基础过渡 */
  function startFloatResize(e: React.MouseEvent, dir: "se" | "e" | "s" = "se"): void {
    if (e.button !== 0) { return; }
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const el = floatRef.current;
    if (!el) { return; }
    const startW = floatSizeRef.current.w, startH = floatSizeRef.current.h;
    let lastW = startW, lastH = startH;
    const onMove = (ev: MouseEvent): void => {
      el.style.transition = "none"; // 幂等禁用过渡，防拖动中 React 重渲把过渡重新挂上
      if (dir === "e" || dir === "se") {
        lastW = Math.max(FLOAT_MIN_W, Math.min(window.innerWidth - 24, startW + ev.clientX - startX));
      }
      if (dir === "s" || dir === "se") {
        lastH = Math.max(FLOAT_MIN_H, Math.min(window.innerHeight - 70, startH + ev.clientY - startY));
      }
      el.style.width = `${lastW}px`;
      el.style.height = `${lastH}px`;
    };
    const onUp = (): void => {
      el.style.transition = FLOAT_TRANSITION; // 恢复基础过渡（供后续最小化/还原动画使用）
      setFloatSize(clampFloatSize(lastW, lastH));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  }
}