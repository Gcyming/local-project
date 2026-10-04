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
import { decideHistoryGate, decideUiReady } from "./pages/startupGate.js";
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
import { trackResizerGlint, clearResizerGlint } from "./resizerGlint.js";
import { installFloatTrace } from "./float-trace.js";

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
  /** A-1131：**本会话的模型选择**（覆盖该 Agent 的默认值；缺省 = 跟随 Agent）。
   *  用户原话：「同一个 Agent 似乎不能在不同会话使用不同模型……」——模型选择住在会话上，
   *  同 Agent 的其他会话不再被连带改掉（详见 core-ts/services/sessions.ts 的 SessionMeta.modelChoice）。 */
  modelChoice?: string;
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

/**
 * A-1061 修正：把登记表**分成两组**，因为它们的兜底策略必须不同（见 startupGate.decideUiReady）。
 *
 * - **元数据组**：慢/失败的代价是"界面能用但某些面板不全" → 8s 兜底放行可接受。
 * - **内容组**（chatHistory）：用户一进来就要看的东西 → 独立且更长的兜底，
 *   且**不许被元数据组的兜底顺带绕过**（这正是"加载界面在会话内容没就绪时就结束"的成因）。
 */
const METADATA_LOAD_KEYS = ["agents", "sessions", "providers", "localModels"] as const;
const CONTENT_LOAD_KEY = "chatHistory";
/** 内容组的兜底上限（用户原话："加载时间稍微长一点也没什么"） */
const CONTENT_GUARD_MS = 20000;

/**
 * 契约自检：登记表全集必须**恰好**由「元数据组 + 内容组」构成。
 *
 * 漏一个键不会有任何报错 —— 只是门少等一项（而"少等一项"正是本次事故的形态），
 * 所以在这里显式做一次一致性检查，让"分组漂移"至少留下一条警告。
 */
const GATE_KEYS_CONSISTENT =
  FIRST_LOAD_KEYS.length === METADATA_LOAD_KEYS.length + 1
  && METADATA_LOAD_KEYS.every((k) => (FIRST_LOAD_KEYS as readonly string[]).includes(k))
  && (FIRST_LOAD_KEYS as readonly string[]).includes(CONTENT_LOAD_KEY);
if (!GATE_KEYS_CONSISTENT) {
  console.warn("[startup] 启动门的分组与登记表不一致 —— 门会少等或多等一项（检查 METADATA_LOAD_KEYS / CONTENT_LOAD_KEY）");
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

/** A-980-R16：悬浮窗尺寸下限与窗口内可见上限（尺寸按当前窗口钳制，避免越界） */
const FLOAT_MIN_W = 340;
const FLOAT_MIN_H = 300;
/** A-1152：浮窗初始尺寸占窗口的**比例**（此前是写死的 480×540 绝对值 ——窗口一大就相对变小，
 *  内容被 `overflow: hidden` 裁掉右缘，用户实测"界面缩放不等比自适应"就是这个）。
 *  ⚠️ 与主进程的 `WIN_DEFAULT_RATIO {width:0.78,height:0.90}` 是**不同**的东西：那是整窗，
 *   这是浮窗在整窗里的占比。
 * ⚠️⚠️ **宽度 0.92 / 高度 0.92**（用户实测「窗口化后…中间空白强行拉开」截图里，
 *   浮窗只占 62%×72% ⇒ 右侧与下方各留一大片空白，浮层态的语义就是"聊天接管整窗"，
 *   留那么大余量既不好看、也让"拖右栏"这件事变得诱人（用户要求直接删掉那个手柄）。
 *   ⇒ 改为**接近铺满**（四周各留一点边距便于拖动与看到窗口边界）。 */
const FLOAT_RATIO = { w: 0.5, h: 0.48 };
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

/** ⚠️⚠️⚠️ A-1162：几何过渡的**时长**——本文件里唯一的真相源。
 *  必须与 `index.css` 里 `.right-sidebar` / `.sidebar` 的 `transition: width` 时长**逐字相等**。
 *
 *  ## 这条常量为什么能取代原先那五条启发式魔数
 *
 *  原先 `runGeometrySyncFade` 靠**测量** CSS 过渡的真实宽度来反推进度，并用五条魔数决定
 *  何时收工（净位移 5px / 稳定 3 帧 / 无位移 8 帧 / 绝对上界 90 帧 / 未挂载 6 帧）。
 *  它们逐条都是为"**宽度是外部量、我不知道它什么时候停**"打的补丁 ——
 *  于是收工时刻取决于**当帧的帧率与布局耗时**，每次点击都不一样。
 *  用户实测三轮：「抖动、抽搐异常明显」「边界剧烈左右抖动」「依旧抖动严重」，
 *  而探针逐帧测出的几何**单调、零反转、p95=6ms、无慢帧、无 LoAF** ——
 *  **测都对、看就是抖**，因为被测的那条曲线**本身不确定**。
 *
 *  A-1162 起进度改由 `u = 已过时长 / 本常量` 决定：**纯时间、与帧率无关**，
 *  收工判据只剩 `u >= 1` 一条。魔数全部作废（不是调参，是**结构性地不再需要**）。
 *
 *  ⚠️ 若改了本常量，**必须同步改** `index.css` 里对应的 `transition: width` 时长，
 *     否则"几何还在滑、透明度已经到位"（或反之），又是一种半拍错位。 */
export const GEOM_FADE_MS = 280;

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

/** ⚠️⚠️ A-1156：浮层态右栏**内容列**的舒适上限（像素）。
 *
 *  取值与 index.css 里
 *  `body.float-layout .right-sidebar:not(:has(webview)) .right-body { max-width }`
 *  的 `min(1600px, 100%)` 是**同一处事实**：过渡期 JS 写 `--right-body-pin`，
 *  稳态由这条 CSS 接管，两者必须同式，否则过渡结束那一帧内容宽度会突跳一下。
 *  守卫：`tests/core-ts/a1156-right-content-fill.spec.ts`（断言 CSS 字面量 === 本常量）。
 *
 *  ⚠️ 为什么从 A-1152 的 `min(620px, 62%)` 改掉（真 App CDP 实测 + 截图 `s1-float-settled.png`）：
 *  1332px 窗口、左栏 240px 时右栏铺满 1092px，而内容列被 620px 封顶 ⇒
 *  `fillRatio = 620/1092 = 0.568`，左右各空 236px —— 用户原话「右侧边栏内容**一直是只有一段**」。
 *  窗口越宽比例越夸张（2143px 窗口下内容列仍只有 620px，两侧共空 ~700px）。
 *  ⇒ 改成"高上限 + 铺满"：常规窗口下内容列 = 右栏整宽，只有超宽屏（>1600px）才留边。 */
const RIGHT_CONTENT_MAX_W = 1600;

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

/**
 * A-1162：**时间驱动**的几何淡入淡出（旧版是"测量驱动"，已整体重写）。
 *
 * ## 为什么重写（用户实测三轮 + 架构复查）
 *
 * 用户连续三轮报「窗口化时各个栏目的衔接动画抖动、抽搐异常明显」「边界剧烈左右抖动」，
 * 而探针逐帧测出来的一切都是**正常的**：各栏几何单调、零方向反转、帧间隔 p95=6ms、
 * 无慢帧、无 LoAF、两个 opacity 恒为 1。**测都对，看就是抖** —— 这只有一种解释：
 * 被测的那条曲线**本身不确定**。
 *
 * 旧版确实是这么写的：**它不驱动动画，只测量动画**。
 *   · 真正的几何由 CSS `transition: width` 跑；
 *   · 本函数每帧 `getBoundingClientRect()` 把那个**由合成器驱动、随时可被中断**的宽度读回来；
 *   · 由读数反推进度 `p`，再写透明度；
 *   · 收工时刻由**四条启发式判据**决定：
 *       ① 净位移 ≥ 5px 且连续 3 帧不动
 *       ② 从未进过渐变带 且 连续 8 帧不动
 *       ③ 帧数 ≥ 90 的绝对上界
 *       ④ 对象连续 6 帧没挂上
 *
 * 三个后果，正好对上用户看到的：
 *   1. **进度不是时间的函数** —— 掉一帧，`p` 就停一下；过渡被打断，`p` 会跳。
 *   2. **收工时刻每次都不同** —— 四条判据命中哪条取决于当帧的帧率与布局耗时，
 *      于是每次点击的"什么时候算完"都不一样 ⇒ 观感就是忽快忽慢、忽左忽右。
 *   3. **观测扰动被观测** —— 每帧 `getBoundingClientRect()` 是**强制同步布局**
 *      （实测 7~11ms），本函数自己在拖慢它要测的那次布局。
 *
 * ## 重写后的不变量
 *
 * · `u = clamp(已过时长 / GEOM_FADE_MS, 0, 1)`，**纯时间**，与帧率、布局耗时无关；
 * · 用**时间合成**的虚拟宽度 `w = min + (full - min) × u` 代入**原来那条渐变带公式**
 *   （`lo`/`hi`/`band`/`smoothstep` 一律不动）⇒ **曲线形状与淡入带语义完全保持**，
 *   变的只有 w 的来源：实测值 → 时间值；
 * · 收工判据只剩一条：`u >= 1`。**没有启发式，没有魔数，没有"再等几帧"**；
 * · 不再逐帧读 `getBoundingClientRect()`（只有挂载检测还要一次，且**不参与进度**）。
 *
 * ⚠️ 为什么保留 `measure` 形参（但**不参与**进度与收工）：调用点的契约不变，
 *   而"对象被卸载后别再往空引用上写样式"由各调用点自己的 null 检查兜住。
 *   ⚠️ **不要**把它改回收工判据的一部分：React 重渲会瞬时替换对象，那一帧
 *   `measure()` 返回 null ⇒ 立刻收工 ⇒ 收工时刻重新随帧率漂（A-1162 要消灭的正是它）。
 * ⚠️ `opts.duration` 允许个别调用点覆盖时长；不给就用 `GEOM_FADE_MS`。
 */
function runGeometrySyncFade(
  measure: () => HTMLElement | null,
  onFrame: (p: number, done: boolean) => void,
  opts: { min?: number; full: number; lo?: number; hi?: number; loRatio?: number; hiRatio?: number; duration?: number },
): () => void {
  const min = opts.min ?? 0;
  const span = Math.max(1, opts.full - min);
  /* 可见性窗口：低于 lo 全透明、高于 hi 全不透明。语义与旧版逐字相同（铁律 11）。 */
  const lo = opts.lo ?? min + span * (opts.loRatio ?? FADE_VISIBLE_LO);
  const hi = opts.hi ?? min + span * (opts.hiRatio ?? FADE_VISIBLE_HI);
  const band = Math.max(1, hi - lo);
  const duration = Math.max(1, opts.duration ?? GEOM_FADE_MS);
  let raf = 0;
  let cancelled = false;
  const t0 = performance.now();
  const step = (): void => {
    if (cancelled) { return; }
    const u = Math.max(0, Math.min(1, (performance.now() - t0) / duration));
    /* 时间合成的虚拟宽度，代入与旧版同一条渐变带公式。 */
    const w = min + span * u;
    const raw = Math.max(0, Math.min(1, (w - lo) / band));
    const p = raw * raw * (3 - 2 * raw); // smoothstep：两端柔和，不生硬
    /* ⚠️⚠️ 收工判据**只有** `u >= 1`。
       曾经的候选是 `gone || u >= 1`（`gone` = 测量对象为 null）—— **已删**：
       对象在 React 重渲时会被**瞬时替换**，那一帧 `measure()` 就返回 null
       ⇒ 立刻收工 ⇒ 又一次"收工时刻随帧率漂"，正好是 A-1162 要消灭的东西。
       ⇒ `measure()` 只剩一个用途：**对象彻底没了就别再往空引用上写样式**
         （那属于"提前收工"之外的另一种收工：由调用点的 null 检查兜住，
           见下面 `gone` 的调用方式 —— 它不再影响 done）。
       时间上界对"对象从未挂载"同样成立（`u` 与对象在不在无关），所以不需要任何
       帧数等待 —— 这也正是 A-1154 ④ / A-1155 ⑥ 两条旧守卫所守护的风险，
       在新结构下由 `u >= 1` 结构性覆盖。 */
    void measure; // 对象是否存在不影响进度（见上）；保留形参只为调用点契约不变
    const done = u >= 1;
    onFrame(p, done);
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
  /* ⚠️ A-1165：装上窗口化过渡的**页内自检录制器**（`Ctrl+Shift+D` 开关）。
     为什么在 App 里常驻：这条抖动我在隔离 root + 空会话 + 1332px 里**复现了五轮都没测到**
     （A-1159/1160/1161/1162/1164 全被用户推翻），而用户那边是真实长会话 + 最大化窗口 ——
     空会话挂载是瞬时的、长会话要好几帧，**测量环境本身就是错的**。
     ⇒ 把尺子搬到用户机器上：真实数据、真实窗口、真实 60fps 逐帧记录。
     ⚠️ 空闲时只有一个 keydown 监听器，**零运行时开销**；录制期才有逐帧采样。 */
  React.useEffect(() => installFloatTrace(), []);
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
  /* ⚠️⚠️ A-1153：这里曾有 `preFloatRightWidthRef`（"唤出前右栏宽度，退出浮层时归还"）。已删除。
     原因：`归还`这套机制本身就是缺陷来源——
       · 浮层铺满当时靠 `setRightWidth(innerWidth)` 实现 ⇒ 这是**持久污染**，
         必须再靠一次**异步动画回调**把它改回来；
       · 而那条回调挂在浮层几何 done 上，浮层若先被卸载，done 走的是"对象没了"的短路分支
         ⇒ 「归还」到底有没有发生取决于时序 ⇒ 右栏时好时坏（用户实测"要左右多次拖拽才恢复"）。
     ⇒ 现在浮层铺满**不再改写 `rightWidth`**（只由 CSS 状态类 + 过渡期变量驱动），
       退出时右栏自然回到它本来该有的宽度 ⇒ 无需归还，这个 ref 也就不需要了。 */
  /** A-980-R25：内联聊天区（浮层退场后回到普通布局时，按主区实测宽度几何淡入）
   *  ⚠️ A-1158：它与 `floatRef` 现在指向**同一个元素**（聊天面板的唯一宿主）——
   *     两条路径的测量对象合为一个，几何参数仍各按各的语义取，不复用数值。 */
  const inlineChatRef = React.useRef<HTMLDivElement | null>(null);
  /** A-1158：唯一宿主的**主** ref（`floatRef` / `inlineChatRef` 是它的两个别名）。
   *  ⚠️ 之所以要一个主 ref：JSX 的 `ref` 只能接一个回调，回调里要把同一个节点
   *     分发给三个 ref，否则只能靠"三处各自 querySelector"（同一事实多个产地，铁律 11）。 */
  const chatHostRef = React.useRef<HTMLDivElement | null>(null);
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
  /** ⚠️⚠️ A-1154：浮窗几何动画的**世代号**——用来让"过期回调"失效。
   *
   *  真 App CDP 实测复现的 bug 链：某轮浮窗几何动画（如「收起右栏」触发的 `dismissFloat`）
   *  的 done 因为对象已卸载而**迟迟不触发**（甚至永不触发）；此后用户又点了「窗口化」，
   *  `handleToggleFloat` 刚 `setFloatState("float")` —— 那一轮**迟到的 done** 这时才跑完，
   *  它无条件执行 `setFloatState("none")` ⇒ **把刚进浮层的新状态打回 none**
   *  ⇒ 用户原话「窗口出现一次**抽搐抖动**，但对话页**不会窗口化**」；
   *  再点一次才成功（迟到回调这次已被消耗掉）—— 实测 S4a 零响应 / S4b 才生效，完全吻合。
   *
   *  ⇒ 每起一轮动画自增一次世代号，回调只在"自己那一代仍是当前代"时才允许写 state。
   *  用法：`const gen = ++floatFadeGenRef.current;` 然后在 done 里判 `gen === floatFadeGenRef.current`。
   *  ⚠️ cancel 时也必须自增（否则"取消后迟到触发的回调"仍会被当成当前代）。 */
  const floatFadeGenRef = React.useRef(0);
  /** A-1153：`endChatFreeze` 的一次性兜底定时器句柄。
   *  ⚠️ 必须**存句柄并可被清**——见 endChatFreeze 的说明（那里曾是无限递归）。 */
  const chatFreezeFallbackRef = React.useRef(0);
  /** ⚠️⚠️ A-1154：拖动"两阶段"里那个 **140ms 定时器**（`slime-fading` → `slime-resizing`）的句柄。
   *
   *  此前它是**裸 `window.setTimeout`、不存句柄** ⇒ `endChatFreeze()` 无法取消它。
   *  真机 CDP 实测到的闪烁机制（用户原话「一拖拽，对话页就会出现闪烁问题」）：
   *  ```
   *    down0   : cls=slime-dragging slime-fading   opacity=0.85  visible
   *    moving0 : cls=slime-dragging slime-fading   opacity=0.29  visible
   *    up0     : cls=""                            opacity=0.45  visible  ← 松手已开始淡回
   *    settle0 : cls=slime-resizing                opacity=0     hidden   ← 定时器**迟到**才挂上
   *  ```
   *  ⇒ 用户**短促拖拽**（< 140ms）时：松手已把类摘了、opacity 正往回涨，
   *    而那条 140ms 定时器到点后又把 `slime-resizing`（`opacity:0` + `content-visibility:hidden`）
   *    **重新挂上** —— 且**没有任何人会再摘它**（`endChatFreeze` 已经跑过了）
   *    ⇒ 观感 = 聊天区 `1 → 0.29 →(涨)→ 0 → 隐藏` 来回抖动 = **闪烁**；
   *      并且松手后聊天区**残留隐藏**（这正是"手在前面、后面的内容才跟上"的观感来源）。
   *  ⇒ 句柄必须存下来，`endChatFreeze()` 里 `clearTimeout`，绝不越过"拖动结束"这条边界。 */
  const dragPhaseTimerRef = React.useRef(0);
  /** A-980-R21：直接操纵 aside / 右栏 wrapper 的 DOM style 控制透明度过渡 */
  const leftSidebarRef = React.useRef<HTMLElement | null>(null);
  const rightWrapperRef = React.useRef<HTMLDivElement | null>(null);
  /** A-980-R34：展开动画期间临时解除 min-width 的标志（true 时 className 挂 sidebar-no-min /
   *  right-wrapper-no-min → CSS 把 min-width 归零，宽度从 0 真过渡到展开宽、渐变带才走得完整）。
   *  窄栏（左 240 / 右 260 下限）下若不放行，展开宽度被钳在下限、实测宽度跳变到渐变带之外，
   *  渐入永远看不到。动画 done 后复位。 */
  const [leftMin0, setLeftMin0] = React.useState(false);
  const [rightMin0, setRightMin0] = React.useState(false);
  /* ⚠️⚠️ A-1157-R2：**退场专用**过渡标志 `right-wrapper-exit`（只排除铺满规则）。
     为什么必须另立一个类、而不能复用 `right-wrapper-anim`（实测走了两轮弯路）：
       `right-wrapper-anim` 那条声明是 `width: var(--right-target-w) !important`，
       退场刻意**不写**该变量 ⇒ `var()` 按 **IACVT** 处理 ⇒ `width` 取**初始值 `auto`**
       （不是"回落到下一条声明"），而 `!important` 仍然压过内联样式
       ⇒ 实测：内联起点宽 `1092px` 明明写进去了、还跨了两帧，计算宽度**当场就是 431**
       ⇒ `transition: width` 没有旧计算值可插值 ⇒ 退场全程（实测 400+ms）纹丝不动。
     ⇒ 退场只需要"别铺满"，不需要过渡期宽度通道 ⇒ 另立一个只做这件事的类。
     ⚠️ 摘除点在 `dismissFloat` 的几何 done（与 `setRightMin0(false)` 并排）；铁律 11：谁挂谁摘。 */
  const [rightExitAnim, setRightExitAnim] = React.useState(false);
  /** A-980-R17：最小化图标「拖动 vs 点击」区分——拖动超过阈值后松手的 click 不触发还原 */
  const floatDragMovedRef = React.useRef(false);
  /** A-980-R15：悬浮窗尺寸/位置（标题栏可拖动、右下角可调大小；按会话记忆） */
  /* ⚠️⚠️ A-1152：初始浮窗尺寸必须**跟着窗口算**，不能硬编码。
   用户实测（并给了正确方向）：「界面缩放时各个页面似乎不会等比自适应保持大小比例，
   而是会固定一定的大小」—— **属实**，就在这里：
   ·窗口默认宽 = `workArea.width × 0.78`（下限 1040 ⇒ 1080p 上约 1560，大屏可到 2560）；
   · 而浮窗初始是**写死的 480×540**（`clampFloatSize(480, 540)`）。
   ⇒ 窗口越大，浮窗占比越小；里面的内容（消息 + 产物卡 + 输入框）需要更宽
   ⇒ 被浮窗的 `overflow: hidden` **裁掉右缘**（用户图2 里那道竖直切痕）。
   ⇒ 改成按窗口比例给（并走 `clampFloatSize` 夹取，规则仍在同一处）。
   ⚠️ 只改**初始值**，且**顺带纠正一个不存在的说法**：我原以为"用户拖过的浮窗尺寸由会话记忆恢复，
      改了会覆盖它"—— 查证后发现**根本没有这个持久化**（`floatSize` 全仓无 localStorage /
      session 存取点），所以这条改动是**纯改进**，不存在"覆盖用户已记住尺寸"的副作用。
      （A-980-R16 只做了拖动中改DOM + 松手落 state，state 不跨会话。） */
  const [floatSize, setFloatSize] = React.useState<{ w: number; h: number }>(() => clampFloatSize(
    Math.round(window.innerWidth * FLOAT_RATIO.w),
    Math.round(window.innerHeight * FLOAT_RATIO.h),
  ));
  const [floatPos, setFloatPos] = React.useState<{ x: number; y: number } | null>(null);
  const floatRef = React.useRef<HTMLDivElement | null>(null);
  const floatSizeRef = React.useRef(floatSize);
  floatSizeRef.current = floatSize;
  /* A-1152：**窗口尺寸变化时把浮层重新夹回窗口内**。
     用户实测的一串问题都源于此：`clampFloatSize` 只在**初始化**跑一次 ⇒ 窗口从"小"变成"大"时
     浮层还是那个旧尺寸（不算 bug），但反过来（**大 → 小**，例如窗口化后把 slime 最大化/还原、
     或拖拽右栏）就可能**超出窗口** ⇒ 你看到的"折叠的对话窗口被强行展开、里面暂时显示空白"。
     ⚠️ 必须**同时**夹位置（`clampFloatPos`）—— 只夹尺寸的话，浮层可能停在窗口外，
     拖右栏时被挤出来的空白就在视口里，看着像"窗口内有空白"。
     ⚠️ 只在浮层态夹：普通态没有浮层，白改 state 会引起无谓重渲染。 */
  React.useEffect(() => {
    if (floatState === "none") { return; }
    /* ⚠️⚠️ A-1152：**必须 rAF 节流**。窗口最大化/还原会连发几十次 `resize`，
       而 `setFloatPos`（函数式 setState）**每次返回新对象就触发一次整棵长会话重渲染**
       ⇒ 用户报「窗口化那一下卡顿依旧严重」。同一窗口拖动边沿时同理。
       ⇒ 只保留**每个动画帧最多一次**；并且位置没变时**返回原对象**（identity 相同 ⇒
         React 直接 bail out，一次重渲染都不发生）。
       ⚠️ 尺寸与位置要**一起**算完再写 state：分两次 setState 会产生两次渲染。 */
    let rafId = 0;
    const onWinResize = (): void => {
      if (rafId) { return; }
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        const cur = floatSizeRef.current;
        /* A-1152：窗口缩放时，浮窗**按比例同步**（而不是只在超出边界时夹一次）。
           此前只做 `clampFloatSize(cur)` —— 那是"越界才夹"，窗口**变大**时浮窗**原地不动**
           ⇒ 用户实测「窗口最大化后对话页被强行拉开 / 浮窗内被裁切」：
           内容按新窗口排版、浮窗还是旧尺寸 ⇒ 不匹配。
           ⚠️ 什么时候该按比例、什么时候该夹边界：
             · 窗口变大 ⇒ 按比例**一起长**（用户看到的是"浮窗随窗口等比放大"）；
             · 窗口变小 ⇒ 夹到边界（`clampFloatSize` 内部对上下限负责）。
           实现上"变大就按比例、变小就夹"都落在下面这一句：取 `min(按比例值, 上限)`。 */
        const ratioW = Math.round(window.innerWidth * FLOAT_RATIO.w);
        const ratioH = Math.round(window.innerHeight * FLOAT_RATIO.h);
        const next = clampFloatSize(
          cur.w < ratioW ? ratioW : cur.w,
          cur.h < ratioH ? ratioH : cur.h,
        );
        if (next.w !== cur.w || next.h !== cur.h) { setFloatSize(next); }
        setFloatPos((p) => { const q = clampFloatPos(p?.x ?? 0, p?.y ?? 0); return (p && p.x === q.x && p.y === q.y) ? p : q; });
        /* ⚠️⚠️ A-1155-R7：**浮层态下把 `--left-w` 同步到左栏的新实宽**。
           左栏宽是 `vw×17.5%`（`index.css` 的 `--sidebar-w`）⇒ 窗口 resize 它就变；
           而浮层稳态 wrapper 宽 = `calc(100% - var(--left-w))` ⇒ 变量不同步的话，
           窗口一变宽/变窄，右栏就会**又越窗或又留空**（＝用户现象 ①④ 在新分辨率下复发）。
           ⚠️ 判据用 `floatStateRef`（真状态），不用 `mainIsFloatLayout` 派生量（铁律 11）。 */
        if (floatStateRef.current !== "none") {
          const lw = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
          rightWrapperRef.current?.style.setProperty("--left-w", `${Math.round(lw)}px`);
        }
      });
    };
    window.addEventListener("resize", onWinResize);
    return () => { window.removeEventListener("resize", onWinResize); if (rafId) { window.cancelAnimationFrame(rafId); } };
    /* ⚠️ 窗口缩放期间（几百 ms 到几秒）聊天区也在**每帧重排**（容器宽度每帧都变）——
       与"窗口化过渡"同源。但这里**不能**挂 `slime-freezing` 的钉宽：那套钉的是 `floatSize`，
       而缩放期间我们恰恰要让它跟着窗口变。所以用**另一个**类：过渡期间内容让位，
       缩放结束（150ms 无 resize）自动摘掉。
       ⚠️ 用"连续无事件 150ms"判定结束，比固定时长可靠（拖边沿时事件持续不断）。 */
  }, [floatState]);

  /* ⚠️⚠️⚠️ A-1156：浮层稳态 wrapper 宽 = `calc(100% - var(--left-w))`，
     而 `--left-w` **必须始终**等于左栏实宽 —— 它失同步时用户看到的正是
     「右栏部分位置被挤压到屏幕外」（现象④）。
     此前它只有**三个主动写点**（唤出 / 窗口 resize / 左栏动画逐帧），本轮实测证明**不够**：
     真 App CDP 轨迹（`probe-a1155-cdp.mjs` 的 `--left-w` 逐帧轨迹，1332px 窗口）：
       点「展开左侧边栏」后 —— 0/134/258/382/507ms 左栏实测都是 **1px**（React 尚未提交
       `.collapsed` 摘除的那一段），**631ms 才真的跳到 240px**；
       而左栏动画的逐帧同步在 1px 上就判定「宽度稳定」并收工 ⇒ `--left-w` 永久停在 **1px**
       ⇒ 浮层稳态 wrapper 宽 = `calc(100% - 1px)` = 1331、左缘 x=240
       ⇒ `rw.r = 1571 > vw = 1332`，**越窗 239px**（真机实测 `overflowRight=[1571]`）。
     ⇒ 这不是"动画还没跑完"，而是**拿动画的节奏去同步一个它无权保证的事实**
       （提交时机、过渡是否触发，都不由这段代码决定）。
     ⇒ 改由 `ResizeObserver` 观察左栏**实测宽度**：浏览器在宽度**真的**变了的那一刻通知，
       覆盖全部来源（动画 / 拖拽 / 窗口缩放 / React 提交后的补跳），且不依赖任何收尾回调。
     ⚠️ 这是**兜底**而不是"第四个产地"：上面三处主动写点保留（它们让"浮层第一帧就正确"，
        不必等 RO 的首次通知），RO 保证的是"此后每一次宽度变化都不会漏"。
     ⚠️ 判据用 `floatStateRef`（真状态），不用 `mainIsFloatLayout` 派生量（铁律 11）。

     ⚠️⚠️ **必须用「回调 ref」而不是 `useEffect(..., [])`** —— 这一条是实测踩出来的：
       App 首帧可能还停在**启动门**里（`splashVisible` 门，此时 `.sidebar` 尚未挂载），
       于是空依赖 effect 跑的时候 `leftSidebarRef.current === null` ⇒ 直接 return
       ⇒ **观察器永远装不上**（第一版就是这么写的，实测 `--left-w` 仍然停在 1px、越窗照旧）。
       回调 ref 在**节点真正挂上的那一刻**装，无论那一刻是第几帧。
     ⚠️ 必须 `useCallback([])`：身份每次渲染都变的话，React 会在每次渲染时
       先 detach 再 attach（观察者反复重建，且回调里那句 disconnect 会打断正在进行的同步）。 */
  const leftWidthObserverRef = React.useRef<ResizeObserver | null>(null);
  const attachLeftWidthObserver = React.useCallback((el: HTMLElement | null): void => {
    leftSidebarRef.current = el;
    leftWidthObserverRef.current?.disconnect();
    leftWidthObserverRef.current = null;
    if (!el || typeof ResizeObserver === "undefined") { return; }
    const sync = (): void => {
      if (floatStateRef.current === "none") { return; }
      rightWrapperRef.current?.style.setProperty("--left-w", `${Math.round(el.getBoundingClientRect().width)}px`);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    leftWidthObserverRef.current = ro;
  }, []);

  /* ⚠️⚠️ A-1154：**窗口尺寸变化时把持久化的右栏 px 宽度钳回当前合法上限**。
     背景（真机 CDP 实测 `probe-drag-robust.mjs` 抓到的第 1 轮 `宽 712 → 712` 无响应）：
       `localStorage.slime_rightbar_w` 记的是**上次窗口尺寸下**用户拖出来的 px 值
       （实测 712 = 当时 `min(innerWidth-48, innerWidth-左栏-380)` 的上限）。
       窗口尺寸一变，那个 px 值就可能**超出新的合法上限**：
         · 窗口**变窄** → 712 超过新上限 ⇒ 右栏被布局压到上限，而 `rightWidth` state 仍是 712
           ⇒ `startWidth`（当时读 state）与 DOM 实宽错位 ⇒ 拖动基准错、向右拖无响应
             （用户原话「要尝试左右多次拖拽才会恢复正常」）；
         · 窗口**变宽** → 712 远低于新上限 ⇒ 右栏显得很窄且**不再随窗口比例自适应**
           （用户原话「对话页自适应窗口调整失效」）。
     ⇒ 正解：resize 时把 state 钳到 `[minW, maxW]`——`rightCustom` 的语义（"按 px 记住"）
       因此只在**合法区间内**保留用户偏好，越界部分自动收敛到边界（既不溢出、也不失配）。
     ⚠️ 只钳**越界值**（相等则返回原对象 ⇒ React bail out，长会话零重渲染）。
     ⚠️ 必须覆盖**所有**宽度来源：`rightCustom` 为真才走 px（为假时右栏走 CSS 比例，不受影响）。 */
  React.useEffect(() => {
    if (!rightCustom) { return; }
    let rafId = 0;
    const onWinResize = (): void => {
      if (rafId) { return; }
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        const minW = rightSidebarMinW();
        const maxW = rightSidebarMaxW();
        const clamped = Math.round(Math.max(minW, Math.min(maxW, rightWidthRef.current)));
        if (clamped !== rightWidthRef.current) {
          setRightWidth(clamped);
          localStorage.setItem('slime_rightbar_w', String(clamped));
        }
      });
    };
    window.addEventListener("resize", onWinResize);
    // 挂载时也跑一次：上次会话遗留的越界值应在首帧就收敛（否则用户一起手就撞上错位）
    onWinResize();
    return () => { window.removeEventListener("resize", onWinResize); if (rafId) { window.cancelAnimationFrame(rafId); } };
  }, [rightCustom]);

  /* A-1152：窗口缩放期间让聊天区让位（结束后自动恢复）。 */
  React.useEffect(() => {
    if (floatState === "none") { return; }
    let t = 0;
    /* A-1152：淡出 → 跳过布局 → 恢复，三段各自的定时器（t=淡出，t2=恢复） */
    let t2 = 0;
    const mark = (): void => {
      /* ⚠️ A-1152：**同样必须两阶段**（与拖动路径同一个坑）。
         缩放期间容器宽度每帧都在变 ⇒ 聊天区每帧重排 ⇒ 要`content-visibility: hidden`；
         但**不能与淡出同帧挂** —— 那会让元素立刻跳过渲染 ⇒ 过渡永不播放（用户实测
         「我要的渐出消失衔接动画没有」）。
         ⇒ 先只挂 fading，等淡出走完（或150ms 兜底）再挂 resizing。 */
      window.clearTimeout(t);
      if (!document.body.classList.contains("slime-resizing")) {
        document.body.classList.add("slime-fading");
      }
      t = window.setTimeout(() => {
        document.body.classList.remove("slime-fading");
        document.body.classList.add("slime-resizing");
        clearTimeout(t2);
        t2 = window.setTimeout(() => {
          document.body.classList.remove("slime-resizing");
        }, 160);
      }, 150);
    };
    window.addEventListener("resize", mark);
    return () => {
      window.removeEventListener("resize", mark);
      window.clearTimeout(t);
      window.clearTimeout(t2);
      endChatFreeze();
    };
  }, [floatState]);
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
  /**
   * A-1059②：「默认选中哪个会话」的决定是否已落定。
   * 语义是"**已经决定过了**"，不是"已经选中了" —— 详见 startupGate.ts 的文件头。
   */
  const [selectionSettled, setSelectionSettled] = React.useState(false);
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
        /* A-1154：取消后自增世代 ⇒ 那轮的任何迟到回调失效（否则它会用**旧会话的**收尾
           去写新会话的 floatState，第 843 行那段注释描述的"旧动画覆盖新会话状态"的残余路径）。 */
        floatFadeGenRef.current++;
        /* A-1152：几何动画被取消时**必须**摘掉 `slime-freezing` —— 它是"过渡期间"的临时类，
           残留会让聊天区长期停在"跳过屏幕外渲染"的降级形态（长会话里滚出去的消息不渲染）。
           这就是"能用几何 done 就不用固定时长"的另一个理由：done 里有地方摘类。 */
        document.body.classList.remove("slime-freezing");
        document.body.style.removeProperty("--slime-freeze-w");
        // A-980-R25：内联聊天区的几何淡入也要取消（否则切会话后它还在给新会话写 opacity）
        chatFadeCancelRef.current?.();
        chatFadeCancelRef.current = null;
        floatClosingRef.current = false;
        // 还原侧栏 DOM opacity/transition（切会话时侧栏不动画，防残留态）
        // A-1016-F3：一并摘掉宽度动画期间的 webview 钉子——这条取消路径**不会**重启动画，
        // 漏了就会让 guest 永远停在旧宽度（窗口再变宽时它仍是钉住的那个值）。
        setRightWebviewPin(null);
        const le = leftSidebarRef.current;
        if (le) { le.style.transition = ""; le.style.opacity = ""; }
        const rw = rightWrapperRef.current;
        if (rw) {
          rw.style.transition = ""; rw.style.opacity = "";
          /* A-1153：**取消路径也要成对清过渡期变量** —— 上面那句 `rightFadeCancelRef.current?.()`
             只停表、不触发几何 done，所以 done 里的 removeProperty 走不到。
             不清就会把上一次的超宽目标留给下一次展开（过渡方向错乱）。 */
          rw.style.removeProperty("--right-target-w");
          rw.style.removeProperty("--right-body-pin");
        }
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
  /**
   * A-1061：**内容组的独立兜底**（20s）。
   *
   * 为什么必须与元数据组的 8s 分开：原先 `uiReady = firstLoadGuard || 全部到齐` 里的那个 `||`
   * 会让 8s 兜底**直接绕过"会话内容"这一步** —— 会话内容一个字都没到，门照样开，
   * 用户看到的就是"加载界面结束了、中间那栏还在加载"（用户原话）。
   * 内容组是用户一进来就要看的东西，给它自己更长的窗口（用户也说"加载时间稍微长一点也没什么"）。
   */
  const [contentGuard, setContentGuard] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setContentGuard(true), CONTENT_GUARD_MS);
    return () => window.clearTimeout(t);
  }, []);
  /**
   * 首屏就绪判据（细则与"为什么拆两组"见 `startupGate.decideUiReady`）。
   * ⚠️ `forcedBy` / `missing` 必须**打日志**：门被兜底"强行放行"时不许静默 ——
   * 否则事后又只能靠猜"当时到底在等什么"（本次排查就是被这一点拖住的）。
   */
  const uiReadyDecision = decideUiReady({
    firstLoad,
    metadataGuard: firstLoadGuard,
    contentGuard,
    metadataKeys: METADATA_LOAD_KEYS,
    contentKey: CONTENT_LOAD_KEY,
  });
  const uiReady = uiReadyDecision.ready;
  React.useEffect(() => {
    if (!uiReady) { return; }
    if (uiReadyDecision.forcedBy === "none") {
      console.info("[startup] 首屏数据全部到齐，收门");
      return;
    }
    console.warn(
      `[startup] 启动门被超时兜底放行（${uiReadyDecision.forcedBy}）—— 仍未到齐：` +
      `${uiReadyDecision.missing.join(", ") || "（无）"}`,
    );
  }, [uiReady, uiReadyDecision.forcedBy, uiReadyDecision.missing]);
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

  /**
   * A-1059②：返回值改为**刚拉到的列表**。
   *
   * 此前调用方（初始化 effect）为了拿列表又单独走了一趟 `conversations.list()` ——
   * 首屏为此多一次 IPC 往返，而且"默认选中"因此**晚于** `markFirstLoad("sessions")` 发生，
   * 正是启动门被提前放行的成因（见 startupGate.ts 文件头）。
   */
  const loadSessions = React.useCallback(async (): Promise<SessionItem[]> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return []; }
    const items: SessionItem[] = await api.conversations.list().catch((e: unknown) => {
      console.error("[app] sessions list failed:", e);
      return [] as SessionItem[];
    });
    // A-918+：无变化则跳过 setState，避免 15s 轮询整棵侧栏树无谓重渲（启动/事件驱动的关键调用不受影响）
    const key = JSON.stringify(items.map((s) => [s.sessionId, s.title, s.count, s.lastTime]));
    if (key === sessionsKeyRef.current) { return items; }
    sessionsKeyRef.current = key;
    setSessions(items);
    markFirstLoad("sessions"); // A-1039：首拉完成 → 记入启动门
    return items;
  }, [markFirstLoad]);

  // 初始化：Agent 列表 + 会话列表 + 默认选中第一个会话
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    // A-918+：loadAgents 与 loadSessions 并行拉取（此前串行，启动首屏等待翻倍）
    void Promise.all([loadAgents(), loadSessions()]).then(([, items]) => {
      // A-1059②：直接用手上这份列表定选中，**不再多走一趟 `conversations.list()`**。
      // 那一趟既让首屏多一次 IPC 往返，又让"默认选中"晚于 `markFirstLoad("sessions")` 发生
      // → 启动门在"还没决定选哪个会话"时就放行（用户报"加载完了中间还要空一会儿"）。
      if (items.length > 0) {
        // 保留仍然有效的当前选中（切回来时不要抢），否则回落第一个
        setSelectedSessionId((cur) => (cur && items.some((s) => s.sessionId === cur) ? cur : items[0].sessionId));
      }
      // 无论有没有选中：**决定已经做过了**，门可以据此判「有内容要等」还是「确实没有」。
      setSelectionSettled(true);
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
   * A-1058① / A-1059②：**没有"会话内容"可等的情形要立刻登记**，否则门只能干等到 8s 总超时。
   *
   * 判据本身搬到了纯模块 `startupGate.ts`（可单测、过变异）—— 这里只做装配。
   * 之所以要搬：此前它是"`hasNoSession || !selectedAgentId` → 登记"一条内联判断，
   * 把「**还没决定**选哪个会话」与「**已决定**但拿不到 agentId」并成了一支，
   * 于是 `selectedSessionId` 仍是 null 的那一刻就把门放行了（用户报"加载完了中间还要空一会儿"）。
   * 现在的五条顺序见模块头注释；`selectionSettled` 是关键的新输入。
   */
  React.useEffect(() => {
    const decision = decideHistoryGate({
      sessionsReady: Boolean(firstLoad.sessions),
      sessionCount: sessions.length,
      selectionSettled,
      hasSelectedSession: selectedSession !== null,
      hasAgentId: Boolean(selectedAgentId),
    });
    if (decision === "self-finish") { markChatHistoryLoaded(); }
  }, [
    firstLoad.sessions, sessions.length, selectionSettled,
    selectedSession, selectedAgentId, markChatHistoryLoaded,
  ]);

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

  /* A-1131：**本会话的模型选择优先于 Agent 默认值**（口径与主进程 `effectiveModelChoice` 一致：
     会话显式选过就用它，否则跟随 Agent）。此前这里只读 Agent ⇒ 切了会话看到的还是同一个模型，
     而写下去又会把 Agent 的记录改掉（就是用户报的"改一个会话、另一个会话跟着变"）。 */
  const currentModel = (selectedSession?.modelChoice ?? "").trim()
    || (agentConfig[selectedAgentId ?? ""]?.model_choice ?? "inherit");
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
      /* A-1131：切模型 = **改本会话** + 把 Agent 上的值更新为"最近选择"（供新建会话继承）。
         ⚠️ 两件事都必须做：
           · 只写会话 ⇒ 新建的会话会继承一个**很久以前的**陈旧模型；
           · 只写 Agent ⇒ 就回到了用户报的那个 bug（同 Agent 全会话共用）。
         已有会话各自的覆盖不受影响 ⇒ 「在不同会话用不同模型」成立。 */
      onModelChange={(v) => {
        setSessions((prev) => prev.map((s) => (s.sessionId === selectedSession.sessionId ? { ...s, modelChoice: v } : s)));
        void apiSetSessionModel(selectedSession.sessionId, v);
        void updateAgentConfig({ model_choice: v });
      }}
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
  /* A-1152：**右栏被收起 ⇒ 浮层无处挂载 ⇒ 让状态自愈**。
     用户实测：「窗口化之后…拖拽拉大对话窗口占比后，窗口化的对话窗就会消失，还原为中间页面的窗口，
     但是**对话页面窗口化的按钮就会失效**，怎么点击都没有用，而且对话页会变得极其不稳定」。
     根因就是这个布尔式：`rightOpen` 一旦变 false（拖右栏到最窄会自动收起，见 A-980-R29），
     `mainIsFloatLayout` 变假 ⇒ `<main>`换回**内联渲染** ⇒ 浮层凭空消失，
     **但 `floatState` 仍是 `float`** ⇒ 按钮永远走 `dismissFloat()` 分支（"点了没反应"），
     同时布局在两种模式间反复重建 ⇒ 各种不稳定。
     ⇒ 右栏收起时把 `floatState` 一起复位成 `none`（用户已经看得见聊天区了，语义正确），
       按钮下一次点击就是"唤出"，回到可预期的那条路。 */
  /* ⚠️ 这一段原本还有一个 `&& rightWidth >= Math.max(560, window.innerWidth - 340)`（A-980-R29 加的
     "浮层期间右栏别掉到 innerWidth-340 以下，否则浮层被卸载"）。**已删除**（A-1152）：
     它是**用"布局推导"来保护浮层**，反而制造了用户实测的那串问题 ——
     窗口从"小"变"大"时 `innerWidth` 跟着涨，这个阈值**自动变假** ⇒ 浮层被静默卸载、
     而 `floatState` 还停在 `float` ⇒ 按钮"点了没反应" + 布局在两种模式间反复重建。
     现在浮层的存活**只**取决于 `rightOpen`（真状态，见上面的自愈 effect），
     窗口尺寸变化不再能把它拽下来。 */
  ;

  /* A-1152：浮层态给 `body` 挂 `float-layout` ⇒ 右栏 `width:100%` 铺满整窗。
     ⚠️ 这是**状态类**（不是 `slime-resizing` / `slime-freezing` 那种"过渡期间"的临时类），
       所以判据取**唯一真状态** `mainIsFloatLayout`，与 `<main>` 的卸载、浮层的挂载同源。
     ⚠️ 用户截图实测的1400px 空白根因：`.right-sidebar { width: var(--right-sidebar-w) }`
       而该变量是 `clamp(260px, 21.5vw, 720px)` ⇒ 宽窗口下右栏永远只有 720px。
     ⚠️ 挂body 而不是给右栏加类：右栏在 `RightSidebar.tsx` 里，多穿一层 prop 会多一份
       需要同步的判据；body 类由这一处真状态统一驱动。 */
  React.useEffect(() => {
    if (mainIsFloatLayout) { document.body.classList.add("float-layout"); }
    else { document.body.classList.remove("float-layout"); }
    return () => { document.body.classList.remove("float-layout"); };
  }, [mainIsFloatLayout]);

  React.useEffect(() => {
    if (floatState !== "none" && !rightOpen) { setFloatState("none"); }
  }, [rightOpen, floatState]);

  /* ⚠️⚠️ A-1158：浮窗外框的**几何与外观**，从 JSX 里**提出来**算。
     为什么必须提到渲染主体之外：唯一宿主在两种模式下是**同一个元素**，
     而它的 style/子元素的 display 都要读这些值 ⇒ 放在 JSX 里就得在两处重复算一遍
     （标题栏一次、浮层浮层块一次）—— 同一事实两个产地，必漂（铁律 11）。
     ⚠️⚠️ `closing` 必须同时认 `"closing"`（A-1154）：
        真 App CDP 实测复现：`dismissFloat()` 设的是 `setFloatAnim("closing")`（退场，窗口收到 0），
        而此前这里曾写成 `const closing = animOut`（只认 `"out"`，最小化态）⇒
        `closing` 恒为 false ⇒ `w/h` 取 `floatSize`（实测 666，**根本没在收**）⇒
        `startFloatGeometryFade` 量到的宽度全程不变 ⇒ 几何 done 永不触发 ⇒
        `slime-freezing` / `--slime-freeze-w` 永久残留 + rAF 泄漏
        ⇒ 后续「窗口化」被脏状态打回（用户原话「窗口出现一次抽搐抖动，但对话页不会窗口化」）。
     ⚠️ 两个方向的目标尺寸**不同**，不能合并成一个布尔：最小化收到图标（44），退场收到 0。 */
  const floatMinIcon = floatState === "min";
  const floatAnimOut = floatAnim === "out";
  const floatClosing = floatAnim === "closing";
  const floatBoxW = floatClosing ? 0 : (floatMinIcon || floatAnimOut ? FLOAT_ICON_SIZE : floatSize.w);
  const floatBoxH = floatClosing ? 0 : (floatMinIcon || floatAnimOut ? FLOAT_ICON_SIZE : floatSize.h);
  const floatBoxDefaultPos = fitFloatRect((sidebarOpen ? sidebarWidth : 0) + 12, 42, floatSize.w, floatSize.h);
  /** 唯一宿主在**浮层态**下的外框样式（普通态用 `.inline-chat-host` 类，见 index.css）。 */
  const floatBoxStyle: React.CSSProperties = {
    position: "fixed",
    left: floatPos ? floatPos.x : floatBoxDefaultPos.x,
    top: floatPos ? floatPos.y : floatBoxDefaultPos.y,
    width: floatBoxW,
    height: floatBoxH,
    zIndex: 1000, display: "flex", flexDirection: "column",
    borderRadius: 10,
    border: floatClosing ? "none" : "1px solid var(--border)",
    background: "var(--bg)",
    boxShadow: floatClosing ? "none" : "0 10px 40px rgba(0,0,0,0.4)",
    overflow: "hidden",
    pointerEvents: floatClosing ? "none" : "auto",
    transition: FLOAT_TRANSITION,
  };
  /** 唯一宿主在**普通态**下的样式：`flex:1` + 竖排 flex 容器（与改造前 `inlineChatRef` 那层一致）。 */
  const inlineChatHostStyle: React.CSSProperties = {
    flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
    /* ⚠️ 普通态**不**给 `position/left/top/width/height`：浮层态那些内联值必须被清掉，
       否则退出浮层后这个元素会**残留** `position:fixed` 与旧坐标（React 只写它给过的属性，
       不写就不会清）—— 那是"从浮窗拽不回来"的经典成因。 */
  };

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
          {/* A-1098：浮层实底用 `modal-card`（原 `var(--bg-input)` 在 beta 主题是 rgba(10,15,30,0.55)，
              模态窗浮在正文上会透字）。padding/圆角由 inline 覆盖，无布局位移。 */}
          <div className="modal-card" style={{
            width: 360, borderRadius: 16, padding: "24px 26px",
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
          /* ⚠️⚠️ A-1156：这里是**回调 ref**而不是 `ref={leftSidebarRef}` ——
             它同时做两件事：① 仍然把节点交给 `leftSidebarRef`（拖拽/动画全靠它实测）；
             ② 顺带装上「左栏宽度变化」的 ResizeObserver（现象④ 的自愈同步，
             详见 attachLeftWidthObserver 的说明：为什么不能用 useEffect + 空依赖）。
             ⚠️ 两者别拆成两个 ref：拆了就多一份"谁在维护 leftSidebarRef.current"的判断。 */
          ref={attachLeftWidthObserver}
          className={`sidebar${sidebarOpen ? "" : " collapsed"}${leftMin0 ? " sidebar-no-min" : ""}`}
          /* A-1018：未手动拖过时**不下发内联宽度** → 由 CSS 的
             `--sidebar-w: clamp(240px, 17.5%, 520px)` 随窗口比例自适应（拖动过则用 px 覆盖） */
          style={{ width: sidebarCustom ? sidebarWidth : undefined, flexShrink: 1, minWidth: sidebarOpen ? SIDEBAR_MIN_W : 0 }}
        >
          {/* A-1106（问题 4）→ A-1109：分隔条 —— 命中区与流光的**唯一出处是 index.css**
              （`.sidebar-resizer` 的 width）。此处**不再重复数值** —— 上一版这里写「10px」、
              CSS 里却是 8px，两处漂移成假陈述，正是用户「加宽了怎么反而更窄」的观感来源之一。 */}
          {sidebarOpen && (
            <div className="sidebar-resizer" onPointerDown={handleSidebarResize}
              onMouseMove={trackResizerGlint} onMouseLeave={clearResizerGlint} />
          )}
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
        {/* ⚠️⚠️⚠️ A-1158：聊天面板的**唯一宿主**（single host）——本轮结构性改造。
            实测依据（真 App CDP + LoAF 归因，1332px 窗口）：切换浮层态会让 React
            **卸载整棵 `<main>`（含 ChatPanel）、再在浮窗里挂载另一棵**（换父 ⇒ 整树重建，
            两棵树都不复用），实测把过渡的第 3 帧拖成 **80ms 的一帧**
            （`LoAF{start:35ms dur:80ms renderStart:77ms scripts:[]}`、`longtask=[]`
             ⇒ 卡在"帧开始 → 浏览器开始渲染"之间）；并发提交后降到 55ms，**没消除**。

            ⇒ 改造：让**同一个 DOM 元素**在两种模式下只是**换样式**：
              · 普通态：`<main>` 里的 flex 容器（`flex:1`，占满主区）
              · 浮层态：它自己变成 `position: fixed` 的浮窗外框
                        （`<main>` 仍收成 0×0 占位，靠 `.main.main-float` 那组规则）
            React **不卸载、不重建** ChatPanel ⇒ 55ms 那一下从根上消失。

            ⚠️⚠️⚠️ **为什么必须放在 `<main>` 里面、而不是把 `position:fixed` 写在 `<main>` 上**：
              ① `.main.main-float` 有 `width:0 !important / height:0 !important`
                 （A-1149/A-1152 立的"浮层态 `.main` 必须零宽"），
                 它会**压过**我们想给的浮窗宽高 —— **A-1152 当年的"左栏收起异常 / 右栏不铺满"
                 就是这么来的**（把 fixed 写在 `<main>` 上，与它自己的折叠规则对打）。
              ② `<main>` 的 `position: relative` / `overflow: hidden`
                 **不会**裁剪 `position: fixed` 子元素
                 （只有 transform / filter / contain / will-change / backdrop-filter 才会
                  建立包含块并裁剪 —— 这条链上已逐个确认没有）⇒ 内层宿主安全出流。
              ⇒ 现在 `<main>` 几何与改造前**逐字相同**（仍是 0×0 占位），所以
                 右栏铺满 / 左栏收起那套几何**一行都不用动**。 */}
        <main className={`main${mainIsFloatLayout ? " main-float" : ""}`}>
          <div
            /* ⚠️ 三个 ref 指向**同一个元素**：它既是浮窗外框（`floatRef`）、
               又是内联聊天区容器（`inlineChatRef`）。
               ⚠️ 用 callback ref 而不是 `ref={a}` 形式：React 的 `ref` 属性只能接一个对象，
               要让三个 ref 都拿到同一个节点就只能走回调（项目里 `attachLeftWidthObserver`
               已是同一手法）。 */
            ref={(el) => {
              chatHostRef.current = el;
              floatRef.current = el;
              inlineChatRef.current = el;
            }}
            className={mainIsFloatLayout ? "float-window" : "inline-chat-host"}
            style={mainIsFloatLayout ? floatBoxStyle : inlineChatHostStyle}
          >
            {/* ⚠️⚠️ **子元素结构在两种模式下必须逐字相同**（下面三层都常驻，
               只按模式切 display/opacity）。
               一旦按下标增删，React 会因"位置对不上"**重建整棵 ChatPanel**，
               这次改造的收益（那 55ms）就全部还回去了 —— 这是本条最容易踩的坑。
               ⚠️ 这层内包裹**不是多余的**：它是 `floatInnerRef` 的落点，
                 最小化/还原的几何渐隐（`startFloatGeometryFade` 的 onFrame）
                 写的就是它的 `opacity`；删掉它 ⇒ 最小化不再淡出、渐隐直接失效。
                 ⚠️ 它也**不能**和宿主合并成一个元素：`inlineChatRef`（退浮层后内联淡入）
                 写的是**宿主**的 opacity，两条淡入淡出写同一个节点会互相覆盖。 */}
            <div ref={floatInnerRef} style={{
              flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
              opacity: floatMinIcon ? 0 : 1,
              pointerEvents: floatMinIcon ? "none" : "auto",
            }}>
            {/* 浮窗标题栏：普通态隐藏 */}
            <div style={{
              display: mainIsFloatLayout ? "flex" : "none",
              alignItems: "center", gap: 4, flexShrink: 0,
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
              {/* ⚠️ A-1152：浮窗 resize 手柄（右缘 e / 底缘 s / 右下角 se）。用户要求恢复：
                  「我要求窗口化的聊天页面的自主拖拽控制大小的功能可以恢复一下」。
                  ⚠️ 普通态必须 `display:none` —— 否则这三条热区会盖在聊天区右缘上。 */}
              <div onMouseDown={(e) => startFloatResize(e, "e")} title="拖动调整宽度"
                style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 4, cursor: "ew-resize", zIndex: 200, userSelect: "none", display: mainIsFloatLayout ? "block" : "none" }} />
              <div onMouseDown={(e) => startFloatResize(e, "s")} title="拖动调整高度"
                style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, cursor: "ns-resize", zIndex: 200, userSelect: "none", display: mainIsFloatLayout ? "block" : "none" }} />
              <div onMouseDown={(e) => startFloatResize(e, "se")} title="拖动调整大小"
                style={{ position: "absolute", right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize", zIndex: 201, userSelect: "none", display: mainIsFloatLayout ? "block" : "none" }} />
            </div>
            </div>
            {/* 最小化浮层（图标）：普通态隐藏 */}
            <div onPointerDown={(e) => startFloatDrag(e, restoreFloat)}
              title="点击还原悬浮窗（可拖动）"
              style={{ position: "absolute", inset: 0, display: mainIsFloatLayout ? "flex" : "none", alignItems: "center", justifyContent: "center",
                background: "var(--bg-secondary)", borderRadius: 10, cursor: "grab",
                opacity: floatMinIcon || floatAnimOut ? 1 : 0,
                pointerEvents: floatMinIcon ? "auto" : "none",
                transition: "opacity 0.18s ease 0.12s" }}>
              <img src={floatIconUrl} alt="slime" draggable={false} style={{ width: 26, height: 26 }} />
            </div>
          </div>
        </main>



        {/* 右侧栏（工作树 / 任务 / 终端 / 浏览器）——A-980-R24：外层 wrapper 承载几何同步渐隐渐显
            （opacity 逐帧 = smoothstep(实测宽/展开宽)，与 .right-sidebar 的 width 过渡同拍；无固定时间点）。
            ⚠️ 该 wrapper 是 `<webview>` 的祖先：opacity 只在过渡期间存在，结束即清空，切勿改为常驻值 */}
        {/* A-975-R4：wrapper 允许被收缩（flexShrink: 1）——右栏内部 min-width:260 兜底，
            这样窗口变窄时右栏会先让位，而不是把聊天区挤没 */}
        <div
          ref={rightWrapperRef}
          /* ⚠️ A-1152：`right-wrapper-anim` 与 `right-wrapper-no-min` **同时**挂（同一条件）。
             过渡期间用它解除"浮层态铺满整窗"的 `width:100% !important`
             —— 否则 `rightWidth` 的逐帧变化被 CSS 吃掉 ⇒ 过渡无对象；
             且旧宽度会先闪一下 ⇒ 用户看到「右栏跑到左边然后往右合」（探针实测 wrap.w恒 431）。
             ⚠️ 两个类共用一个条件，不要拆成两个 state（同铁律 11）。
             ⚠️⚠️ **A-1157-R2 例外：`right-wrapper-anim` 现在多一个来源 `rightExitAnim`**，
             这是**实测逼出来的**，不是图省事：
               退浮层（`dismissFloat`）此前在**起点**就把 `rightMin0` 置回 false ⇒
               `anim` 立刻消失 ⇒ 那条铺满规则
               「`body.float-layout .right-wrapper:not(.right-wrapper-anim) .right-sidebar`
                 的 `width:100% !important`」**重新生效**，
               把右栏**钉死在 1092px** 直到浮层类被摘。
               真 App CDP 逐帧实测（1332px 窗口）退场轨迹：
                 `1ms 右栏=1092@240..1332` → `412ms 右栏=431@901..1332` → `…339@901..1240`
               ⇒ **整整 411ms 右栏纹丝不动**（用户观感＝"点了没反应"），
                 随后**整块向右跳**（左缘 240→901），再**右缘开始向左退**（1332→1240，
                 右边空出 92px）＝ 用户本轮报的「右边突然出现空白，然后侧边栏向右合上」。
               ⇒ 根因就是那条铺满声明**在退场期仍然生效**，
                 右栏拿不到自己的目标宽度、`transition: width` 也就没有插值对象。
               ⇒ 修：退场期间**保持 `anim` 类**（但 `rightMin0` 必须仍为 false ——
                 它还管着 wrapper 的宽度分支与 `no-min`，混在一起会让 wrapper 跟着跳）。
                 所以只能给 `anim` 单独一个来源 `rightExitAnim`；这是**第二个产地**，
                 故此处明确记下唯一产地与摘除点（铁律 11：谁挂谁摘）。
               ⚠️ 退出时**不写** `--right-target-w`：不写 → `var()` 按 IACVT 让那条声明失效
                 ⇒ 右栏回落到它的正常宽度（`var(--right-sidebar-w)`，CSS 单源，不在 JS 里复刻公式），
                 而 `.right-sidebar` 常驻的 `transition: width .5s` 这时**才有插值对象**
                 ⇒ 1092 平滑收到 286，右缘由 `margin-left:auto` 钉在窗口右缘不动。
             ⚠️ 本注释是 **JSX 属性位置**的裸块注释（不是花括号包裹的 JSX 表达式注释）：
               ① 所以里面可以出现 `{}`；② 但**结尾不许多写一个右花括号** ——
               写这条注释时在结尾手滑留了一个，`tsc` 立刻在标签闭合处报
               TS1382/TS1005/TS1128 连成一串，指着离真凶十万八千里的地方；
               ③ 同理**正文里也不能出现块注释的结束符**，否则注释提前结束、
               后半段全被当成代码解析（这次连报四个错，根因只有这一个）。 */
          className={`right-wrapper${rightMin0 ? " right-wrapper-no-min" : ""}${rightMin0 ? " right-wrapper-anim" : ""}${rightExitAnim ? " right-wrapper-exit" : ""}`}
          /* ⚠️⚠️ A-1152：`marginLeft: "auto"` —— **把右栏顶到窗口右缘**。
             用户实测：「右侧边栏的最右侧又出现空白区域了」（截图里右缘一条空带）。
             根因：`.body` 是 `[.sidebar][.main][.right-wrapper]` 一行 flex，而本wrapper 是
             `flexShrink: 1`（可收缩）⇒ 窗口宽度**大于** `rightWidth`（写死的 px）时，
             余量留在**右边** ⇒ 右栏停在 `right.r = 1201` 而窗口是 1601 ⇒ 空 400px。
             ⚠️ 为什么不用 `flex: 1`：那会把右栏**拉宽**（内容被拉伸，不是"贴边"），
             而右栏内部的子面板都是固定宽 ⇒ 拉宽只会在最右侧留一条空带（正是用户看到的）。
             ⚠️ 为什么不用 `width: 100%`：同上，会与内部固定宽冲突。
             ⇒ `margin-left: auto` 是**唯一**"贴边但不变宽"的办法（auto margin 吃掉全部余量）。
             ⚠️ 动之前的后果：`.main` 归零后（上一轮）**再没有别的盒子吃余量**了，
             所以这条空白才会露出来 —— 两处改动是配套的。
             ⚠️ `alignSelf: "stretch"`（A-1152）：右栏**必须撑满整高**。用户选定方案是
             「右栏铺满整窗、浮窗叠在上面」⇒ 浮窗下方那片区域由右栏的底色承担；
             若 wrapper 高度不足，下方会露出 `.app` 根底色 = 用户截图里那条"空白"。 */
          /* ⚠️⚠️ A-1157：**`flexShrink` 改回「可收缩」（恒 1）** —— A-1155 的 `? 0 : 1` 是本轮实测出的回归源。
             A-1155 当初设成 0 的理由是「wrapper 请求了超过可用空间的宽度（`innerWidth`），
             收缩权会落到左栏头上」—— 而那个前提在 A-1155-R7 之后**已经不成立**
             （`--right-target-w` 现在是 `整窗 − 左栏实宽`，需求恰好等于可用空间）。
             在这个前提下继续禁收缩，会造成一个**自锁**（真 App CDP 逐帧实测，1332px 窗口）：
               点「展开左侧边栏」后，左栏的宽度过渡从 0 往 240 走，而 wrapper 仍按
               `--left-w`（上一帧的值，滞后一帧）占着 `100% − 1px` ⇒ **总需求超出容器**
               ⇒ 因为 wrapper `flex-shrink:0`、左栏 basis≈0 ⇒ **收缩量全落在左栏身上**
               ⇒ 左栏被压回 ~1px ⇒ RO 读到 ~1px ⇒ `--left-w` 保持 ~1px ⇒ **死循环**
               ⇒ 实测 `3ms 宽=1 不透明=0% → 654ms 宽=240 不透明=100%`：
                  整整 654ms 里侧栏**既不动也看不见** —— 用户原话「展开要等半天，
                  我经常以为它是没有展开，点半天没反应」（本轮实测，非推断）。
               非浮层态同一操作**完全正常**（4ms 起逐帧 12/23/32/41/49…，85ms 开始淡入）
               ⇒ 差异只来自浮层态 wrapper 那条 `calc(100% - var(--left-w))`。
             ⇒ 放开收缩后，超出量按 `shrink × basis` 加权：左栏 basis≈0 权重≈0，
               **让位的是 wrapper**（差值只有一帧的量，肉眼不可见，且 RO 下一帧就纠正）。
             ⚠️ 守卫：`tests/core-ts/a1152-float-stability.spec.ts` ⑮（原断言要求
               `flexShrink: mainIsFloatLayout ? 0 : 1`）已随本条改判据。 */
          style={{ display: "flex", flexShrink: 1, minWidth: 0, marginLeft: "auto", alignSelf: "stretch",
            /* ⚠️⚠️ A-1152：浮层态**宽度给到 wrapper**（`100%`）—— 上一轮我错把`width:100%`
               写在 `.right-sidebar` 上，而 wrapper 的宽度是 `auto`（=0）⇒ 百分比参照 0
               ⇒ **右栏整个塌成 0、用户报「右侧边栏直接没了」**（用户截图实测）。
               ⇒ 正确分工：**wrapper 给宽度、右栏填满 wrapper**（下面的 CSS）。
               ⚠️ 非浮层态不给宽度：保持 `auto`，右栏自己用 `--right-sidebar-w`（含 720px 上限）。
               ⚠️⚠️ **`&& !rightMin0`**（A-1152）：**过渡期间不给宽度**。
                 探针实测（`probe-float-transition.cjs`）浮层态下`wrap.w`恒为 431、
                 8 帧宽度请求完全无响应 ⇒ 过渡没有过渡对象；且 `rightWidth` 的旧内联值
                 会先闪一下 ⇒ 用户看到「右栏跑到左边然后往右合」。
                 ⚠️ 关键：这条是**内联**样式，CSS 的 `!important` 盖不住它
                 ⇒ 必须在内联这一层就让位（`right-wrapper-anim` 那条 CSS 是必要的另一半）。
               ⚠️⚠️ 同期还必须把 `flexShrink` 放开（见 style）：浮层态 `<main>` 已卸载
                 （`display:none`，对布局零贡献）⇒ 唯一在 flex 行里的兄弟就是 wrapper，
                 `flex-shrink: 1` 会让它**收缩到内容宽度**（探针实测恒 431px），
                 宽度请求完全无效 ⇒ 「过渡无对象 + 旧值先闪」。
               ⚠️⚠️⚠️ A-1155：**过渡期不能真的"不给宽度"——要给 `--right-target-w`**。
                 上面那条 `&& !rightMin0 ⇒ undefined` 造出一个**死锁**（真 App CDP 实测）：
                   `rightMin0=true` ⇒ 内联 width=undefined ⇒ wrapper 回 `auto`
                   ⇒ 宽度 = 内容宽（`.right-sidebar` 被 `max-width:100%` 压到 wrapper 的
                     收缩结果 287px）⇒ **宽度从头到尾不变**
                   ⇒ `runGeometrySyncFade` 两条几何判据同时失效（`netShift` 不达标；
                     `hi = 0.42×1332 ≈ 559 > 287` ⇒ `everBelowHi=true` 关掉判据②）
                   ⇒ done 永不触发 ⇒ `rightMin0` **摘不掉** ⇒ 死锁自锁。
                 实测症状：`bodyCls="float-layout"` 且 `rwCls` 带 `right-wrapper-anim`
                 ⇒ 铺满规则 `:not(.right-wrapper-anim)` 被永久排除
                 ⇒ 右栏算不出整窗宽（287px ≠ 1332px）= 用户截图「内容自适应失效、只有一段」。
                 ⇒ 正解：过渡期**同样给宽度**，但来源换成 `--right-target-w`
                   （App 在过渡起点写、几何 done 时摘）。这与"不锁死 rightWidth"并不冲突：
                   浮层支本来就不走 rightWidth 逐帧，它只有一个目标值。
                 ⚠️ `var()` 故意**不写 fallback**：变量未定义 ⇒ 该声明 IACVT ⇒ 回落 `auto`
                   ⇒ **普通展开的行为逐字不变**（普通展开不写这个变量，宽度仍由 rightWidth 驱动）。
               ⚠️⚠️⚠️ A-1155-R7：**稳态宽度不是 `100%`，是 `100% − 左栏实宽`**。
                 真 App CDP 实测（本轮，最关键的一条）：
                   `.body` 是 `[.sidebar 240][main 0][wrapper]`，而 **`.body` 自身宽 = 1332 = 整窗**；
                   wrapper 给 `100%` ⇒ 参照 `.body` = 1332 ⇒ 而它左缘在 x=240
                   ⇒ **右缘 = 240 + 1332 = 1572，越窗 240px**（实测 `overflowRight=[1572]`，
                     且 `.right-body` 右缘 1216 是安全的 ⇒ 越窗的是 wrapper 的空白底，
                     但用户看到的正是「右侧边栏部分位置被挤压到屏幕外」）。
                 ⇒ 浮层要铺满的是「**`.body` 减左栏**」，不是「`.body`」。
                   用 `calc(100% - var(--left-w))`（`--left-w` 由 App 在浮层存续期写入左栏实宽）。
                 ⚠️ 为什么不直接写死 px：窗口 resize 时左栏是 `vw×17.5%` 会变
                   ⇒ 必须由**变量**驱动，与 `--right-target-w` 同源同寿命（成对写、成对摘）。
                 ⚠️ `var(--left-w)` 未定义 ⇒ 整条 `calc` IACVT ⇒ 回落 `auto`
                   ⇒ 与上面 `--right-target-w` 同一套"未定义即让位"语义，普通展开不受影响。 */
            width: (mainIsFloatLayout && !rightMin0) ? "calc(100% - var(--left-w, 0px))"
              : (mainIsFloatLayout ? "var(--right-target-w)" : "auto") }}
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
          /* A-1152：浮层态（右栏接管整宽、中间页已卸载）⇒ 右栏**不挂拖拽手柄**，
             宽度只由「窗口化」往返与 `rightSidebarMaxW()` 决定（用户要求：
             「改成只能点窗口化收起」）。传的是 `mainIsFloatLayout` —— 与"中间页是否卸载"同一份真状态。 */
          floatLayout={mainIsFloatLayout}
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

  /**
   * A-1131：会话级模型落盘（切模型下拉触发）。
   *
   * ⚠️ 走 `conversations.setModelChoice`（只改本会话），**不是** `agents.update`。
   *    用户原话：「同一个 Agent 似乎不能在不同会话使用不同模型……之前那个会话里面的 agent
   *    模型直接变成 deepseek 模型了」——写 Agent 就会连坐同 Agent 的所有会话。
   * ⚠️ 落盘失败**不吞**：主进程已 console 出声；这里再 alert 会让"切个模型弹个框"变噪音，
   *    所以只在失败时把已写入的乐观值回滚为落盘真值（下次切会话自然以盘为准）。
   */
  async function apiSetSessionModel(sessionId: string, modelChoice: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.setModelChoice) { return; }
    try {
      await api.conversations.setModelChoice(sessionId, modelChoice);
    } catch (e) {
      console.error("[slime] 会话模型落盘失败:", e);
      await loadSessions(); // 回滚乐观值：以落盘为准
    }
  }

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

  /* A-1152：**渐入恢复** —— 拖动/缩放结束时不能硬摘类（内容会瞬间跳回 100% 不透明）。
     ⚠️ 三段时序：摘 `slime-resizing`（恢复渲染 + 允许 opacity 过渡）→ 下一帧摘 `slime-fading`
     （触发 opacity 0→1 的过渡）⇒ 内容**淡入**回来。
     ⚠️ 必须"下一帧"：`slime-resizing` 挂着时CSS 写死 `opacity: 0`（见 index.css），
       同一帧摘两个类 ⇒ 浏览器看不到 opacity 从 0 变化 ⇒ 过渡不播（又是白跳）。
     ⚠️ 兜底 200ms：若 rAF 没来（页面隐藏等），至少保证类被摘干净、不残留。 */
  /* ⚠️⚠️ A-1153：这里**曾是一个无限递归** —— 末尾写着
     `window.setTimeout(() => { endChatFreeze(); }, 200);`（无条件调自己）。
     后果：每次拖动结束都排一条**永不停止**的 200ms 定时器链，每 200ms 摘一次
     `slime-fading` —— 与随后任何一次"挂类淡出"互相踩
     ⇒ 用户实测「一拖拽，对话页就会出现闪烁」；拖几次就有几条链并发，抖动加剧。
     ⚠️ 守卫当时只断言"含 setTimeout("（形状），没断言"定时器里不许再调自己"
     ⇒ 纵容了这个 bug。**已同步改守卫**（a1152 ⑫）锚这条不变量。
     ⇒ 现在：兜底定时器是**一次性的**、句柄存 ref 可被下一次调用清掉（不叠加）。 */
  function endChatFreeze(): void {
    document.body.classList.remove("slime-resizing");
    // A-1153：拖动期的"禁宽度过渡"标志也在这里摘（它与 resizing 同生命周期）
    document.body.classList.remove("slime-dragging");
    /* ⚠️⚠️ A-1154：**必须先取消那条 140ms 的阶段定时器**，否则它在松手后才把
       `slime-resizing` 挂上（且再没人摘）⇒ 聊天区闪烁 + 残留隐藏（见 dragPhaseTimerRef 注释）。
       取消之后本函数自己按"已是拖动结束"的语义摘两类 —— 顺序不变。 */
    window.clearTimeout(dragPhaseTimerRef.current);
    dragPhaseTimerRef.current = 0;
    requestAnimationFrame(() => {
      document.body.classList.remove("slime-fading");
    });
    // 兜底：rAF 不来时（页面隐藏等）保证 fading 也被摘掉，绝不把类留在 body 上
    window.clearTimeout(chatFreezeFallbackRef.current);
    chatFreezeFallbackRef.current = window.setTimeout(() => {
      document.body.classList.remove("slime-fading");
    }, 200);
  }

  function handleSidebarResize(e: React.PointerEvent): void {
    e.preventDefault();
    setSidebarCustom(true); // A-1018：一旦用户手动拖过，就按 px 记住（不再走 CSS 比例自适应）
    /* ⚠️⚠️ A-1153：**拖动第一帧就禁掉宽度过渡**，否则不跟手。
       此前 `transition: none` 只由 `slime-resizing` 提供，而那个类是 **140ms 之后**才挂的
       （两阶段设计要求"先 fading 后 resizing"，见下面注释）⇒ **拖动头 140ms 内**
       宽度仍然走 `.sidebar` 的 `transition: width 0.5s` —— 鼠标已经走了、面板还在慢慢追
       ⇒ 用户实测「拖拽极其不跟手，手在前面，后面的拖拽内容才跟上」。
       ⇒ 新增 `slime-dragging`：只管"拖动期禁宽度过渡"，与淡出的两阶段**互不干扰**
         （它只作用于 `.sidebar` / `.right-sidebar` 的 width，不碰 `.chat-scroll` 的 opacity 过渡）。
       ⚠️ 摘除统一在 `endChatFreeze()`（松手/取消/失焦三条路都走它）。 */
    document.body.classList.add("slime-dragging");
    const captureEl = e.currentTarget as HTMLElement;
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* 指针 id 已失效则忽略 */ }
    /* A-1152：聊天区淡出**必须分两阶段**（用户实测「我要的对话文本渐出消失衔接动画没有」）。
       ⚠️⚠️ 上一轮写错了时序：`slime-resizing` 与 `slime-fading` **同一帧**挂上，
         而 `slime-resizing` 带 `content-visibility: hidden` ⇒ **元素立刻跳过渲染**
         ⇒ opacity 过渡**根本不会执行**（没有任何一帧被绘制）⇒ 观感就是"啪地消失"。
       ⇒ 正确顺序：**先只挂 fading**（此时 `content-visibility` 仍为 visible，过渡能播）
         → 过渡结束后**再挂 resizing**（跳过布局；此时已看不见，跳过不改变观感）。
       ⚠️ `slime-resizing` 里还有拖动期必需的 `transition: none`（跟手），
         所以它不能提前挂—— 提前挂会把淡出过渡也一起关掉。 */
    document.body.classList.add("slime-fading");
    /* 兜底：transitionend 可能不来（元素被 display 影响 / 用户极快松手）。
       140ms 后无论如何进入第二阶段，绝不卡在"半透明 + 还在重排"的中间态。
       ⚠️⚠️ A-1154：句柄必须存进 ref 并在 `endChatFreeze()` 里取消 —— 否则**短促拖拽**
         松手后它才到点，把 `slime-resizing` 挂上且再没人摘 ⇒ 闪烁 + 聊天区残留隐藏。 */
    window.clearTimeout(dragPhaseTimerRef.current);
    dragPhaseTimerRef.current = window.setTimeout(() => {
      dragPhaseTimerRef.current = 0;
      /* ⚠️ 到点时若这一轮拖动已经结束（`slime-dragging` 已被 endChatFreeze 摘掉）⇒ 本阶段作废。
         这条是"定时器与结束边界竞争"的守卫：没有它，上面那个 clearTimeout 一旦被
         某条未覆盖的路径绕过（如 renderer 卡顿导致的延迟回调），延迟回调仍会污染。 */
      if (!document.body.classList.contains("slime-dragging")) { return; }
      document.body.classList.remove("slime-fading");
      document.body.classList.add("slime-resizing");
    }, 140);
    const startX = e.clientX;
    /* ⚠️⚠️ A-1154：与右栏同一处修复 —— 基准取 **DOM 实测宽度**，不取 `sidebarWidthRef.current`（state）。
       `.sidebar` 有 `max-width: 520px` 与 `min-width: 240px`，且窗口变窄时会被 flex 压缩
       ⇒ state 与实宽的错位会和右栏一样表现为"不跟手 / 到上限后完全无响应"。 */
    const asideEl = leftSidebarRef.current;
    const startWidth = asideEl ? asideEl.getBoundingClientRect().width : sidebarWidthRef.current;
    let lastW = startWidth;
    /* A-1152：**拖动期间直接改 DOM 的 style.width，零 React 重渲染**；松手才 setSidebarWidth 落 state。
       为什么必须这样（实测，用户报「左侧边栏拖拽依旧卡顿严重」）：
         · 此前每个 `pointermove` 都 `setSidebarWidth(lastW)` ⇒ **每个鼠标移动触发一次
           整个长会话的 React 重渲染**（ChatPanel 全文 + 右栏 + 工具栏全重渲）⇒
           在 166Hz（帧预算 6ms）下必然掉帧；
         · 纯 CSS 手段（`content-visibility` 跳过布局）**只压掉了"重排"这一半**，
           压不掉 React 本身的工作量 ⇒ 用户体感"依旧卡"（这条是被实测否掉的中间方案，见
           `.chat-scroll` 那节的更正注释）。
       ⚠️ 这套做法在**右栏拖动上早已存在**（见 `handleRightSidebarResize` 的同名注释：
       "零 React 重渲染…松开才 setRightWidth 落 state"）—— 左栏现在与它对齐，
       两个 resizer 的行为口径一致。
       ⚠️ 收尾必须清掉内联 width：否则 React 认为 prop 未变而不再写回，会留下脏内联值
       （与右栏 `onUp`/`onCancel` 里那两处 `asideEl.style.width = ""` 同理）。 */
    const onMove = (ev: PointerEvent): void => {
      // 左栏：鼠标向右 → 变宽（范围 240–520，**不给占满全屏**）
      lastW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, ev.clientX - startX + startWidth));
      if (asideEl) { asideEl.style.width = `${lastW}px`; }
    };
    const onUp = (): void => {
      endChatFreeze();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      try { captureEl.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      // 清掉拖动期写下的内联 width：否则 React 认为 prop 未变而不再写回，会留下脏内联值
      if (asideEl) { asideEl.style.width = ""; }
      // A-980-R27：只有**真拖到几何下限**（240 + 吸附带）才收起。旧的 `<= 300` 是绝对像素，
      // 把「刚比下限宽一点」的整段区间都算成"拖到底"——左栏默认宽才 262，于是收起后重新
      // 拉宽，宽度一从下限起步就又触发收起，观感就是"左栏拉不开"。
      if (lastW <= SIDEBAR_MIN_W + SIDEBAR_SNAP_W) {
        // 下次展开用的宽度 = **这次拖拽开始前的宽度**（用户真正想要的那个宽度）。
        // 若拖之前本来就贴着下限（没有可留念的宽度），回落到按屏幕比例算的默认宽——
        // 保证下次展开出来的宽度一定在吸附带之外，不会一展开就又被自己"拖到底"。
        const fallback = Math.round(window.innerWidth * SIDEBAR_RATIO.left);
        const restoreW = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W,
          startWidth > SIDEBAR_MIN_W + SIDEBAR_SNAP_W ? startWidth : fallback)));
        setSidebarWidth(restoreW);
        localStorage.setItem('slime_sidebar_w', String(restoreW));
        // 走与按钮完全同一条几何同步淡出（此前是 setSidebarOpen(false) 裸切状态，内容直接消失）
        animateLeftSidebar(false);
        return;
      }
      const w = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, lastW)));
      setSidebarWidth(w);
      localStorage.setItem('slime_sidebar_w', String(w));
    };
    const onCancel = (): void => {
      endChatFreeze();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      // 失焦/指针作废：用户并没有"松手"，不判吸附收起；但当前几何必须落 state 并清掉内联 width
      if (asideEl) { asideEl.style.width = ""; }
      setSidebarWidth(Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, lastW))));
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
    /* ⚠️⚠️ A-1153：与左栏同一处修复 —— 拖动第一帧就禁宽度过渡（见 handleSidebarResize 的说明）。
       右栏同样把 `transition: none` 延迟到 140ms 后的 `slime-resizing`，导致拖动头段不跟手。 */
    document.body.classList.add("slime-dragging");
    const captureEl = e.currentTarget as HTMLElement;
    // A-980-R27：与左栏同一套——指针捕获，避免指针划过 `<webview>`（OOPIF）时
    // mousemove/mouseup 被 guest 进程吃掉 → 拖拽卡死且 slime-resizing 残留
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* 指针 id 已失效则忽略 */ }
    /* A-1152：聊天区淡出**必须分两阶段**（用户实测「我要的对话文本渐出消失衔接动画没有」）。
       ⚠️⚠️ 上一轮写错了时序：`slime-resizing` 与 `slime-fading` **同一帧**挂上，
         而 `slime-resizing` 带 `content-visibility: hidden` ⇒ **元素立刻跳过渲染**
         ⇒ opacity 过渡**根本不会执行**（没有任何一帧被绘制）⇒ 观感就是"啪地消失"。
       ⇒ 正确顺序：**先只挂 fading**（此时 `content-visibility` 仍为 visible，过渡能播）
         → 过渡结束后**再挂 resizing**（跳过布局；此时已看不见，跳过不改变观感）。
       ⚠️ `slime-resizing` 里还有拖动期必需的 `transition: none`（跟手），
         所以它不能提前挂—— 提前挂会把淡出过渡也一起关掉。 */
    document.body.classList.add("slime-fading");
    /* 兜底：transitionend 可能不来（元素被 display 影响 / 用户极快松手）。
       140ms 后无论如何进入第二阶段，绝不卡在"半透明 + 还在重排"的中间态。
       ⚠️⚠️ A-1154：与左栏同一处修复 —— 句柄存 ref、`endChatFreeze()` 里取消，
         并在到点时校验"本轮拖动是否已结束"（见 dragPhaseTimerRef 的详细说明）。 */
    window.clearTimeout(dragPhaseTimerRef.current);
    dragPhaseTimerRef.current = window.setTimeout(() => {
      dragPhaseTimerRef.current = 0;
      if (!document.body.classList.contains("slime-dragging")) { return; }
      document.body.classList.remove("slime-fading");
      document.body.classList.add("slime-resizing");
    }, 140);
    const startX = e.clientX;
    /* ⚠️⚠️ A-1154：`startWidth` 必须取 **DOM 实测宽度**，不能取 `rightWidthRef.current`（state）。
       真机 CDP 实测（`probe-drag-robust.mjs`，可见窗口 + 真实输入）抓到一条确定性失败：
         第 1 轮拖动 `宽 712 → 712`（**完全无响应**），而同页第 2 轮起全部正常。
       根因：`rightWidth` state 是**请求值**，而右栏实宽还会被两层几何压缩：
         · `.right-sidebar { max-width: 100% }`（wrapper 被 flex 压窄时跟随收缩）；
         · `.right-sidebar { min-width: 260px }` 与 `rightSidebarMaxW()` 的夹取。
       ⇒ state 与实宽可能相差几百 px。此时 `lastW = startX - clientX + startWidth` 从**错的基准**起算：
         · 实宽 > state：鼠标已移动很多，实宽还没到 state ⇒ 观感"手在前面、面板在后面"；
         · 实宽 == maxW（如本次 712 == `min(1284, 712)`）：向右拖算出 >maxW ⇒ 被钳回原值
           ⇒ **完全无响应**，用户实测「要尝试左右多次拖拽才会恢复正常」
（先向左拖一次把宽度降到上限以下，才腾出拖动空间）。
       ⇒ 基准取实测宽后，"鼠标位移 → 宽度变化"在**任何** state/实宽错位下都严格 1:1。 */
    const asideEl = document.querySelector<HTMLElement>(".right-sidebar");
    const startWidth = asideEl ? asideEl.getBoundingClientRect().width : rightWidthRef.current;
    let lastW = startWidth;
    // A-918++ 修复「拖动卡死 + 宽度不更新」：此前 onMove → rAF → setRightWidth 每帧触发 App 整树
    // 重渲染（ChatPanel/RightSidebar/设置面板全重渲）→ 主线程阻塞 → 鼠标卡死、宽度跟不上。
    // 现在拖动期间直接改右栏 DOM 的 style.width（零 React 重渲染），松开才 setRightWidth 落 state。
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
      /* ⚠️ A-1154：`startWidth` 现在是 `getBoundingClientRect().width`（浮点，如 286.375）
         ⇒ `lastW` 也是浮点。拖动中的**内联 width 保留浮点**（比取整更跟手，
         且与实测基准同精度，不会累积 0.5px 的漂移）；
         落 state / localStorage 时再 `Math.round`（见 onUp / onCancel）。 */
      lastW = Math.max(minW, Math.min(maxW, startX - ev.clientX + startWidth));
      if (asideEl) { asideEl.style.width = `${lastW}px`; }
    };
    const onUp = (): void => {
      endChatFreeze();
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener('blur', onCancel);
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
        const restoreW = Math.max(minW, Math.min(maxW, Math.round(startWidth)));
        setRightWidth(restoreW);
        localStorage.setItem('slime_rightbar_w', String(restoreW));
        animateRightSidebar(false);
        return;
      }
      let w = Math.max(minW, Math.min(maxW, lastW));
      if (w >= maxW - 80) {
        w = maxW;
      }
      w = Math.round(w);
      localStorage.setItem('slime_rightbar_w', String(w));
      // 松开才触发一次 React 重渲染，最终宽度落 state（供下次拖动起点 + 持久化一致）
      setRightWidth(w);
    };
    const onCancel = (): void => {
      endChatFreeze();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      // 失焦/指针作废：用户并没有"松手"，所以不判吸附收起；但当前几何必须落成 state 并清掉
      // 拖拽期的内联 width，否则 React 认为 prop 未变而不再写回，会留下脏内联值
      if (asideEl) { asideEl.style.width = ""; }
      setRightWidth(Math.round(Math.max(minW, Math.min(maxW, lastW))));
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
        /* ⚠️⚠️ A-1155-R7：**浮层态下左栏宽度变化必须同步给 `--left-w`**。
           用户明确要求「浮层时左栏保持可见，但不影响用户能手动折叠」——
           左栏一折（240→0 或 0→240），浮层稳态的 `calc(100% - var(--left-w))` 就得跟着变，
           否则折叠后右栏**少铺满 240px**（右侧留一条空白）、展开后又**多出 240px**（右缘越窗）。
           ⚠️ 逐帧写（不是在 done 里写）：左栏宽度是**动画量**，
              只在 done 写会让整个过渡期间 `calc` 用旧值 ⇒ 右栏与左栏**不同步**（观感是抽搐）。
              `--left-w` 只喂宽度计算、不触发额外合成（wrapper 自己的 width 过渡负责平滑）。
           ⚠️ `node.style.opacity` 的 done 复位仍走原路，这里只多写一个变量。 */
        if (floatStateRef.current !== "none") {
          const lw = node.getBoundingClientRect().width;
          rightWrapperRef.current?.style.setProperty("--left-w", `${Math.round(lw)}px`);
        }
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
  /* ⚠️⚠️ A-1149（用户实测"左栏收起后左边缘多出一小块空白"）：**浮层态的上限必须是整窗宽**，
   *   不能再减 48。原因是**几何**的：`.body` 是 `[.sidebar][.main][.right-wrapper]` 一行 flex，
   *   浮层态 `.main` 的内容是 `position:fixed`（对布局零贡献）却带着 `flex:1 1 0%` +
   *   `min-width:0` ⇒ **行内剩余空间全部被 `.main` 吸收**。右栏一请求 `innerWidth - 48`，
   *   那 48px 立刻变成 `.main` 的**实宽**，落在右栏左侧 —— 正好是收起后的左栏位置，
   *   观感就是"折叠的左栏又露出来了"（离屏实测：`main.w=48 right.l=48`，守卫见
   *   `gui/scripts/assert-float-gap.cjs`，它同时锁 App 侧取值与 CSS 上限）。
   *   整窗宽请求 + CSS 放开 `100vw - 48` 上限之后，行内不存在剩余空间 ⇒ 两个边缘都没有空白。
   *   （左栏展开时仍由 `.right-wrapper` 的 flex-shrink 让位，实测不溢出。） */
  function rightSidebarMaxW(): number {
    const leftEl = leftSidebarRef.current;
    const leftW = leftEl ? leftEl.getBoundingClientRect().width : 0;
    const floatActive = floatStateRef.current !== "none";
    return Math.max(360, floatActive
      // A-1149：浮层态按整窗宽（余量不能"留给 .main"——它会把余量变成实宽）
      ? window.innerWidth
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
  function animateRightSidebar(nextOpen: boolean, nextWidth?: number, isFloat?: boolean): void {
    rightFadeCancelRef.current?.();
    rightFadeCancelRef.current = null;
    /* ⚠️⚠️ A-1155：**取消上一次过渡 = 它的 done 回调永远不会跑** ⇒ 必须在这里补做清理**。
       `runGeometrySyncFade` 的 `onFrame(_, true)` 是**上一次过渡结束时**才执行清理的唯一时机；
       而本行刚把上一次 cancel 掉（切会话/连点/普通展开都会走到）⇒ 那次 done 被丢掉
       ⇒ `right-wrapper-anim` / `right-wrapper-no-min`（`rightMin0`）与
       `--right-body-pin` / `--right-target-w` **永久残留**。
       实测（真 App CDP 探针）：点窗口化 → 切页 → 恢复窗口化后，
       `rwAnim=true rwNoMin=true --right-body-pin=441px` 一直挂到稳态，
       叠加出「右栏不铺满（`:not(.right-wrapper-anim)` 把它排除）+ `.right-body` 被钉在 441px
       冲出窗口（`rb.r=1487 > vw=1332`）」——正是用户截图里的那条窄带。
       ⇒ **清理的责任归"过渡起点"**，不再赌上一次的 done 会不会跑到（铁律 11：写/摘必须成对）。
       ⚠️ 这里只做"复位到干净起点"，本轮该挂的类/变量由下面按 `nextOpen` 重新决定。 */
    setRightMin0(false);
    const rwReset = rightWrapperRef.current;
    if (rwReset) {
      rwReset.style.removeProperty("--right-body-pin");
      rwReset.style.removeProperty("--right-target-w");
      /* ⚠️ A-1155-R7：`--left-w` 只在**浮层稳态**有意义（喂 `calc(100% - var(--left-w))`）。
         本轮若不是浮层，它必须被摘掉 —— 否则「浮层态残留的数学」会跟到普通展开里。
         （普通展开的 width 走 `auto` 不吃它，但留着就是铁律 11 意义上的"写/摘不成对"。） */
      if (!isFloat) { rwReset.style.removeProperty("--left-w"); }
    }
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
      /* ⚠️⚠️ A-1153：**浮层铺满（`nextWidth` 接近整窗）不许落 `rightWidth` state**。
         它是持久副作用：退出浮层后右栏会一直按这个 px 值渲染 ⇒ 挤压 `.main`
         （用户实测「对话内容被挤压到屏幕外」）；而且它**只能靠一次异步动画回调归还**，
         归还与否取决于时序 ⇒ 时好时坏。
         ⇒ 铺满宽度只写进**过渡期专用变量** `--right-target-w`（CSS 在
           `body.float-layout .right-wrapper-anim .right-sidebar` 里读它驱动过渡），
           稳定态由 `width: 100% !important` 接管、`rightWidth` 保持原值不动。
         ⚠️ 非铺满的显式宽度请求（目前无调用点）仍走 state —— 语义不变。 */
      /* ⚠️⚠️ A-1155：浮层支的判据从「宽度 > 0.8 × innerWidth」**改成显式入参 `isFloatExpand`**。
         旧阈值是"猜"：它假设浮层目标宽必然接近整窗。而 A-1155 把目标改成
         `innerWidth − 左栏实宽` 后，在**极宽窗口**（左栏满档 520px）下会
         `innerWidth − 520 < 0.8 × innerWidth`（解得 `innerWidth > 2600`）
         ⇒ 浮层被**误判成普通展开** ⇒ 走 `setRightWidth`（持久副作用回来了）+ 不挂 `float-layout`
         ⇒ 又一轮"右栏不铺满 + 挤压 .main"的回归。
         ⇒ 判据必须与**真状态**同源，不再用派生猜测量（铁律 11：同一事实一个产地）。
         默认值 `undefined` ⇒ 走旧阈值（保持对历史调用点的行为不变）。 */
      const isFloatExpand = isFloat !== undefined
        ? isFloat
        : (nextWidth !== undefined && nextWidth > window.innerWidth * 0.8);
      if (nextWidth !== undefined && !isFloatExpand) { setRightWidth(nextWidth); }
      if (el && isFloatExpand) { el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`); }
      /* ⚠️⚠️⚠️ A-1164：**删掉**原本这里的 `el.style.opacity = "0"`。
         它把整个右栏砸成全透明，再由几何进度拉回来 ⇒ 实拍录像里过渡中右栏内容区
         p95 只有 10.0（静止态是 133.0）⇒ 一整块面板在平移的同时由黑变亮 = "抽搐"。
         ⚠️ 必须**连同 onFrame 里的 opacity 写入一起删**：只删这一处的话，收工时
         没有任何代码去恢复，**右栏会永久停在 opacity 0**（比抽搐更糟）。
         两处成对删除，正是铁律 11 的"写/摘成对"反过来用：此处原本就是一处**只写不摘**。 */
      // A-980-R34：展开期间临时解除内部 .right-sidebar 的 min-width（CSS: .right-wrapper-no-min .right-sidebar
      // { min-width: 0 }）——否则 260px 下限把展开钳在下限之上，渐变带 [0.45,0.90]×full 进不去，
      // 窄栏展开看不到渐入。done 后复位。
      setRightOpen(true);
      setRightMin0(true);
      /* A-1152：过渡**开始**时同帧挂 `float-layout`（不等 useEffect）——
         否则它要等下一次 render/effect 才生效 ⇒ 展开的第一帧仍按"非浮层"算宽度
         ⇒ 右栏从旧宽硬跳到整窗宽（用户反馈「过渡帧直接没了」）。
         ⚠️ 与上面那个 useEffect **不冲突**：那边负责"稳定态持续挂着"，
            这里负责"过渡起点立刻生效"，摘除交给 useEffect 的 cleanup。 */
      /* ⚠️⚠️ A-1152 **回归修复**：只在"窗口化"这一支同帧挂 `float-layout`；
         其余情况（普通展开右栏）**必须摘掉**。
         原因：`body.float-layout .right-sidebar { width: 100% !important }` 是给浮层态的，
         而这里此前**无条件**挂类 ⇒ 普通展开也挂上，且 React 那个 useEffect 的依赖是
         `mainIsFloatLayout`（不变就不重跑）⇒ **类永久残留**
         ⇒ 用户实测「**右侧**边栏的收起出故障了，自适应功能更是没有了」
            （收不起来 = `width:100%!important` 盖过收起宽度；不自适应 = 同样盖过按比例的宽度）。
         ⇒ 判据用"本次请求宽是否接近整窗"（与透明度带那一支同一个条件，不另造状态）。
         ⚠️ A-1155：改为复用上面算好的 `isFloatExpand`（显式入参优先）——
         这里**原本又算了一遍同一个阈值**，两处必须同源，否则"类挂了但变量没写"这类半挂状态
         会再次出现（铁律 11）。 */
      if (isFloatExpand) {
        document.body.classList.add("float-layout");
      } else {
        document.body.classList.remove("float-layout");
      }
      /* ⚠️⚠️ A-1152：过渡期**钉住右栏内容宽度**（消灭逐帧重排 = 用户的"很卡顿"）。
         必须在这里一次性算好写入 —— 不能交给 CSS 用百分比：百分比会跟着正在动画的
         `.right-sidebar` 一起变 ⇒ 又变成每帧重排。（A-1156：钉的**值**见下。） */
      if (el) {
        /* ⚠️⚠️ A-1156：目标宽与**稳态规则**同源。
         *  · 浮层支：直接用 `nextWidth`（= 整窗 − 左栏实宽，由 handleToggleFloat 算出）。
         *    此前还要过一道 `rightSidebarMaxW()`，但此刻 `floatStateRef.current` 仍是 "none"
         *    （handleToggleFloat 是「先调本函数、后 setFloatState("float")」）⇒ 它走**非浮层**分支
         *    = `min(innerWidth−48, innerWidth−左栏−380)`，实测把 1092 夹回 712 ——
         *    用**派生猜测**代替真状态，正是 A-1155 修掉的同一类错（铁律 11）。
         *  · 钉宽必须与稳态 `max-width` 同式（`min(RIGHT_CONTENT_MAX_W, 目标宽)`），
         *    否则过渡结束那一帧内容宽度会从 pin 值突跳到稳态值（用户可见的一跳）。
         *    旧式 `min(620, targetW × 0.62)` 随 A-1156 的封顶调整一并作废。 */
        const targetW = isFloatExpand
          ? (nextWidth ?? rightWidth)
          : Math.min(nextWidth ?? rightWidth, rightSidebarMaxW());
        el.style.setProperty("--right-body-pin", `${Math.round(Math.min(RIGHT_CONTENT_MAX_W, targetW))}px`);
      }
      rightFadeCancelRef.current = runGeometrySyncFade(
        /* ⚠️⚠️ A-1157：**量 `.right-sidebar`，不是 wrapper**（两条支都一样）。
           wrapper 的宽度是**内联**的（`var(--right-target-w)` / `calc(100% - var(--left-w))`），
           而它的旧值是 `auto` —— **`auto` 不能参与插值** ⇒ wrapper 宽度永远是**硬跳**的
           （实测：点击后第一帧就已经是 1092）。
           ⇒ 量它等于量一个"不动的东西"：几何淡入淡出 ~50ms 内就判 done，
             而真正在滑的是 `.right-sidebar`（`transition: width`）—— 观感上右栏
             **全程满不透明**地滑过去，A-1152 特意调过的"更早的淡入带"等于白调。
           ⇒ 改量真正在动的那个盒子：淡入淡出重新跟随真实的宽度运动。
           ⚠️ `querySelector` 每次一帧跑一次，开销可忽略（单层子树、无通配符）。 */
        () => rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null,
        (_p, done) => {
          if (done) {
            setRightMin0(false);
            setRightWebviewPin(null);
            /* A-1152：钉宽变量只在过渡期有意义 ⇒ 与 `right-wrapper-anim` 同时摘掉，
               否则稳定态会一直钉着旧值（窗口 resize 后内容不跟随）。
               A-1153：`--right-target-w` 同理（成对写/摘，铁律 11）——残留会让下一次
               普通展开误用上一次的超宽目标 ⇒ 过渡方向错乱。 */
            const rw = rightWrapperRef.current;
            rw?.style.removeProperty("--right-body-pin");
            rw?.style.removeProperty("--right-target-w");
          }
          const node = rightWrapperRef.current;
          if (!node) { return; }
          /* ⚠️⚠️⚠️ A-1164：**右栏不再有进场淡入淡出** —— 全程保持不透明。
             证据（用户实拍录像逐帧取证，2560×1600）：
               · 静止态   右栏内容区 mean=28.6 / p95=133.0
               · 过渡中   右栏内容区 mean=10.9 / p95=**10.0**
             p95 从 133 掉到 10 ⇒ 不是"变暗"，是**亮字整个消失** ⇒ 过渡期间整个右栏
             几乎是全黑的，收工瞬间又变亮。
             源头是本回调里原本那句 `node.style.opacity = done ? "" : String(p)`，
             配合 `animateRightSidebar` 里的 `el.style.opacity = "0"`：
             把**整个右栏**压到全透明，再用几何进度拉回来。
             ⚠️ 为什么当初写错了：那段注释自己就记着「绝大部分过渡时间右栏都是半透明
                ⇒ 观感乱七八糟」，却把它当成**要往前调的参数**（把可见窗口提前），
                而没有质疑"右栏**根本不该淡**"。
                右栏有**不透明背景**，它是在自己家的矩形里平移，不存在"淡入才不突兀"；
                淡入只会让一整块面板**在滑动的同时由黑变亮** —— 而这正是"抽搐/闪烁"。
             ⚠️ 为什么我的探针四轮都没发现：`opacity` 0→1 是**单调**的，
                "方向反转"检测完全看不到它 —— 我测到的"单调"恰恰是它看起来正常的原因。 */
          if (done) { node.style.removeProperty("opacity"); }
        },
        /* ⚠️⚠️ A-1152：**窗口化（大幅展开）时透明度带要更早**（用户反馈「衔接动画也做得
           乱七八糟」）。默认带是 `[0.45, 0.90] × full`，而窗口化时 `full = 整窗宽`
           ⇒ 要涨到 90%×1388≈1250px 才完全不透明 ⇒ **绝大部分过渡时间右栏都是半透明的**
           ⇒ 观感"乱七八糟"（内容半透明地漂着进来）。
           ⇒ 与左栏 A-980-R34 同一个思路：**变化幅度越大，可见窗口越靠近起点**
             （loRatio/hiRatio 收窄到 0.06/0.42：宽度到 42%×目标宽就完全显示）。
           ⚠️ 只对"浮层态展开"这一支生效；普通展开（右栏回到 720px 档）仍用默认带，
             否则普通展开会"刚动一下就全显示"，失去渐入感。
           ⚠️ A-1155：判据同源改为 `isFloatExpand`（上面那处已算好，不再重复阈值判断）。 */
        isFloatExpand
          ? { min: 0, full: nextWidth ?? rightWidth, loRatio: 0.06, hiRatio: 0.42 }
          : { min: 0, full: nextWidth ?? rightWidth },
      );
    } else {
      // 右栏占满时聊天悬浮窗一并退出浮层（恢复普通布局）
      // A-980-R25：必须走退场动画（此前 setFloatState("none") 直接卸载 → 聊天瞬间消失/瞬间出现）
      dismissFloat();
      setRightOpen(false);
      /* ⚠️⚠️ A-1155：**与展开支严格对称地清理过渡期状态**。
         此前这个 else 支只摘了 `--right-target-w`，漏掉三样 ⇒ 它们**永久残留**：
           · `setRightMin0(false)` —— 摘 `right-wrapper-anim` / `right-wrapper-no-min`；
           · `--right-body-pin` —— 钉住 `.right-body` 的内容宽；
           · `opacity` 的收尾。
         实测（真 App CDP 探针 `probe-a1155-cdp.mjs`，点窗口化→切页→恢复窗口化）：
         恢复后 `body.float-layout` 已摘，但 `rwAnim=true rwNoMin=true --right-body-pin=441px`
         **一直挂到稳态**，三者叠加出的可见故障：
           ① `.right-sidebar` 的铺满规则是
              `body.float-layout .right-wrapper:not(.right-wrapper-anim) .right-sidebar`
              —— `anim` 残留 ⇒ **`:not()` 永久把它排除** ⇒ 右栏算不出整窗宽（实测 287px ≠ 1332px）；
           ② `--right-body-pin:441px` 把 `.right-body` 钉在 441px，而 wrapper 只有 287px
              ⇒ 内容右缘冲到 `rb.r=1487 > vw=1332`（**越窗 155px**，用户截图「内容只有一段」/「被挤压到屏幕外」）。
         为什么"点几次会好"：残留只在下一次**展开支**的 done 回调里被清（那里有三样里的两样），
         而 done 的触发取决于那一次过渡是否被 cancel —— 时序赌博，所以时好时坏。
         ⇒ 修法：**清理由"过渡起点"无条件负责，而不是靠上一次的 done 回调**（铁律 11：写/摘成对）。
         ⚠️ 与展开支同帧、同在 `runGeometrySyncFade` 之前：先复位到干净态，再让本轮过渡重新钉值。 */
      setRightMin0(false);
      const rwEl0 = rightWrapperRef.current;
      if (rwEl0) {
        rwEl0.style.removeProperty("--right-body-pin");
        rwEl0.style.removeProperty("--right-target-w");
      }
      rightFadeCancelRef.current = runGeometrySyncFade(
        /* A-1157：与展开支同源 —— 量真正在动的 `.right-sidebar`（wrapper 是硬跳的）。 */
        () => rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null,
        (_p, done) => {
          if (done) {
            setRightWebviewPin(null);
            // A-1153：与上面展开支对称 —— 过渡期变量成对摘除，绝不留残值
            rightWrapperRef.current?.style.removeProperty("--right-target-w");
            /* ⚠️ A-1155：done 时**再摘一次** `--right-body-pin`。
               起点那次摘是为了"本轮不被上一次的残值污染"；这次摘是为了"本轮自己钉的值
               在过渡结束后也归零"（否则本次 runGeometrySyncFade 期间若有人写它就会残留）。 */
            rightWrapperRef.current?.style.removeProperty("--right-body-pin");
          }
          const node = rightWrapperRef.current;
          if (!node) { return; }
          /* ⚠️ A-1164：收起方向**同样**不淡出（与展开方向同一条理由、同一条证据：
             实拍录像里过渡中的右栏内容区 p95=10.0，而静止态是 133.0 —— 整块面板
             在滑动的同时由黑变亮/由亮变黑，观感就是"抽搐"。右栏有不透明背景，
             平移本身不需要淡入淡出。） */
          if (done) { node.style.removeProperty("opacity"); }
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
    /* A-1152：**进浮层态前先确保右栏是打开的**。
       用户实测的一串问题（按钮"怎么点都没用" + 极不稳定）根因在
       `mainIsFloatLayout = rightOpen && floatState !== "none"`（App.tsx:1426）：
       浮层**只在这个条件为真时才真正挂载**。若此刻右栏是收的（`rightOpen === false`，
       例如先前拖右栏把它拖到最窄触发了自动收起），点按钮会 `setFloatState("float")`——
       **状态变了但什么都没挂载**，用户看到的就是"点了没反应"；再点又走 `dismissFloat()`
       ⇒ 彻底错乱（这正是"怎么点击都没有用"）。
       ⇒ 唤出时先 `setRightOpen(true)`（并走右栏展开动画），保证浮层真的有地方挂。
       ⚠️ 只在 `none → float` 这一支做；`min`/`float` 两支各自的语义不动（A-980-R30）。 */
    /* ⚠️⚠️ A-1153：唤出前只确保右栏"是开的"，**动画只由下面那一次调用承担**。
       此前这里先调用了一次**无参数**的 `animateRightSidebar(true)`，紧接着（同一事件里）
       又调用 `animateRightSidebar(true, 整窗宽)` —— 第二次开头 `rightFadeCancelRef.current?.()`
       会把第一次的几何动画 cancel 掉，而 cancel **只停表、不复位样式**
       ⇒ 两次动画的副作用叠加（opacity / min0 / pin 各写一遍）⇒
       用户实测「再次点击窗口化，窗口出现一次**抽搐抖动**，但对话页没有窗口化」。
       ⇒ 合并为一次（下面这次调用自己会 `setRightOpen(true)`）。 */
    if (!rightOpen) { setRightOpen(true); }
    /* ⚠️ A-1157-R2：唤出前复位退场标志（对称于 `dismissFloat` 摘除点）。
       正常路径它已在退场 done 摘干净；这里防的是"退场被打断、done 没跑到"的残留
       —— 残留会让唤出时 `anim` 一开始就挂着，A-1153 的过渡期宽度声明立刻生效。 */
    setRightExitAnim(false);
    /* ⚠️⚠️ A-1158-R：唤出前同样**复位内层包裹层的 opacity**（与退场 done 摘除点对称）。
       A-1158 把"浮窗外框"和"内联聊天区"合并成同一个宿主之后，这层**常驻**了 ——
       而它的 `opacity` 会被几何渐隐（最小化 / 退场）命令式写成 0。
       若上一次退场被打断、done 没跑到，残留的 0 会让**唤出后的浮窗内容也全透明**
       （与「恢复后中间一片黑」同一个病根，只是发生在另一侧）。
       ⚠️ JSX 里的 `opacity: floatMinIcon ? 0 : 1` 救不了：React 只在该 prop **变化**时
          重写 style，而 inline/常规浮层态它恒为 1 ⇒ 不重写 ⇒ 命令式的 0 会留存。 */
    {
      const fiEnter = floatInnerRef.current;
      if (fiEnter) { fiEnter.style.opacity = ""; }
    }
    /* ⚠️⚠️ A-1153：**不再写 `setRightCustom(true)` / `setRightWidth(innerWidth)`**。
       旧实现用"把右栏宽度设成整窗宽"来实现浮层铺满，代价有两个（都是用户实测到的）：
         · `rightCustom` 一旦置真就**再没有复位点**（全仓只有 3 处 `set(true)`、0 处 `set(false)`）
           ⇒ 右栏永久失去 CSS 的比例自适应（用户原话「对话页自适应窗口调整失效」）；
         · `rightWidth` 被写成整窗宽，且**只能靠一次异步动画回调归还**
           ⇒ 未归还时"展开右栏"会把 `.main` 压到 `min-width: 380px`
             = 用户截图里的「对话内容被挤压到屏幕外、被切割」，
             而"左右拖几次就恢复"正是因为拖拽会 `setRightWidth(真实值)`。
       ⇒ 铺满改由**两条纯 CSS 通道**承担（`rightWidth` / `rightCustom` 一概不碰）：
         · **稳定态**：`body.float-layout .right-wrapper:not(.right-wrapper-anim) .right-sidebar
                       { width: 100% !important }`（已有，见 index.css）；
         · **过渡期**：`--right-target-w`（由 animateRightSidebar 在过渡起点写入，done 时摘除）。
       这样退出浮层时右栏自然回到它本来的宽度（`.right-sidebar` 自带 `transition: width 0.5s`，
       回退是平滑的），不再需要任何"归还"。 */
    // A-1149：唤出即请求**整窗宽**（该值现在只作**过渡几何驱动**，不再落 rightWidth state；
    // 原 `innerWidth - 48` 会让那 48px 变成 .main 的实宽 —— 见 rightSidebarMaxW 的几何说明）
    /* ⚠️⚠️ A-1155：**目标宽 = `.body` 宽 − 左栏实宽**，不是 `innerWidth`。
       用户明确（本轮确认）：「左栏保持可见，但不影响用户能手动折叠」。
       而 `.body` 是 `[.sidebar][.main][.right-wrapper]` 一行 flex ——
       浮层态 `<main>` 已不占位（`width:0`），所以右栏能用的宽度就是 `.body` 减左栏。
       此前传 `innerWidth` ⇒ 目标 1332 + 左栏 240 = 1572 > 1332 ⇒
       **结构性超窗 240px**：wrapper 被压到 287px，`.right-sidebar` 的 `max-width:100%`
       跟着被压 ⇒ 宽度不动 ⇒ `runGeometrySyncFade` 两条判据同时失效 ⇒ done 死锁
       ⇒ `right-wrapper-anim` 摘不掉 ⇒ 铺满规则被 `:not()` 永久排除
       ⇒ 用户截图「右栏内容自适应失效、只有一段」+「部分位置被挤压到屏幕外」。
       实测（真 App CDP）：`rw.w=287`，而 `rb.r=1487 > vw=1332`（越窗 155px）。
       ⇒ 取左栏**实测宽**（`getBoundingClientRect`，与 A-1154 拖拽基准同源），
         左栏收起时自然为 0 ⇒ 右栏铺满整窗（语义与"左栏可手动折叠"自洽）。
       ⚠️ 下限仍保 `560`（避免极窄窗口下目标小于可用宽度导致过渡方向反向）。 */
    const leftWNow = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
    const floatTargetW = Math.max(560, Math.round(window.innerWidth - leftWNow));
    /* ⚠️⚠️⚠️ A-1155-R7：**稳态宽度变量** `--left-w`（`calc(100% - var(--left-w))` 的另一半）。
       为什么需要它：浮层稳态的 wrapper 宽度必须是「`.body` 减左栏」，
       而左栏是 `vw×17.5%`（窗口 resize 会变）⇒ 只能由变量驱动、不能写死 px。
       寿命完全与浮层对齐：这里（唤出）写，`dismissFloat`（退出）摘。
       ⚠️ 与 `--right-target-w` 的区别：那条是**过渡期**（done 即摘），
          这条是**稳态**（整个浮层存续期都在）。两者都由几何 done 之后的稳态读值兜底。 */
    const rwFloat = rightWrapperRef.current;
    if (rwFloat) { rwFloat.style.setProperty("--left-w", `${Math.round(leftWNow)}px`); }
    /* ⚠️⚠️ A-1155-R6：第三参 `isFloat` **必须显式传 true**。
       `animateRightSidebar` 的浮层判据原本靠 `nextWidth > innerWidth × 0.8` 猜，
       而现在 `floatTargetW = innerWidth − 左栏实宽` **恰好落在 0.8 倍边界下游**
       （左栏 240px 时 1332−240=1092 < 1066? 不 —— 1092 > 1332×0.8=1065.6，仅高 26px）
       ⇒ 左栏一旦变宽（或窗口变窄），阈值立刻判假 ⇒ 浮层被误判成**普通展开**
       ⇒ 走 `setRightWidth`（持久副作用回来了）+ 不挂 `float-layout` ⇒ 右栏不铺满、挤压 .main
       （铁律 11：同一事实一个产地 —— 判据必须与**真状态**同源，不用派生猜测量）。 */
    animateRightSidebar(true, floatTargetW, true);
    /* ⚠️⚠️ A-1157：**这一次状态翻转很重** —— 它让 React **卸载整棵 `<main>`（含 ChatPanel）、
       再在浮窗里挂载另一棵 ChatPanel**（换父 ⇒ React 整棵重建，两棵树都没有复用）。
       实测（真 App CDP + LoAF 归因，1332px 窗口）：
         `慢帧 [[112, 80]]`、`longtask=[]`、`LoAF{start:35ms dur:80ms renderStart:77ms scripts:[]}`
       ⇒ 掉帧**不在脚本里**（longtask 为空）、也不在渲染里（renderStart 已到 77ms），
         卡在"这一帧开始 → 浏览器开始渲染"之间的那 77ms —— 与换父重建的规模吻合。
         用户本轮原话：「窗口化时…界面会**抽搐**，而非线性平滑的左拉」。
       ⚠️ 对照实验（探针**不读任何几何 API**）量到的仍是 80ms（读几何时 87~91ms）
         ⇒ 这 80ms 不是探针自己制造的，别再往"测量误差"上推。
       ⇒ 修法：让这次更新走**并发渲染**（`startTransition`），React 得以把大块工作切开、
         在帧间让出主线程 ⇒ 右栏的宽度过渡能跑完它自己的 280ms，而不是被一帧冻住。
       ⚠️ 只包这一处：它对应的正是"一次性大重建"；其余状态（`rightMin0` 等）是在**驱动**动画，
         必须同步提交，包进来反而会延迟动画起点。 */
    React.startTransition(() => {
      setFloatState("float");
    });
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
    /* ⚠️⚠️ A-1155：**退浮层必须对称摘掉"唤出"那一支挂上的全部过渡期状态**。
       唤出走 `animateRightSidebar(true, 整窗宽)`（展开支），它挂了四样：
         · `rightMin0 = true` ⇒ `right-wrapper-anim` + `right-wrapper-no-min` 两个类；
         · `--right-target-w`（过渡期目标宽）；
         · `--right-body-pin`（钉住 `.right-body` 的内容宽）；
         · wrapper 的 `opacity`。
       而**退出这条路由 `dismissFloat` 独占**（窗口化按钮的 `floatState === "float"` 分支），
       **根本不经过 `animateRightSidebar` 的 else 支** —— 那条只服务标题栏的右栏开关。
       ⇒ 此前退出浮层时四样**一个都没摘**（我曾在 else 支补过清理，对这条路径完全无效）。
       实测（真 App CDP 探针 `probe-a1155-cdp.mjs`）点窗口化→切页→恢复窗口化后，
       `rwAnim=true rwNoMin=true --right-body-pin=441px --right-target-w=1332px`
       **一直挂到稳态**，三者叠加出的可见故障：
         ① 铺满规则 `body.float-layout .right-wrapper:not(.right-wrapper-anim) .right-sidebar`
            因 `anim` 残留被 `:not()` **永久排除** ⇒ 右栏算不出整窗宽（实测 287px ≠ 1332px）
            = 用户截图「右侧边栏内容自适应失效、只有一段」；
         ② `--right-body-pin:441px` 把 `.right-body` 钉在 441px，而 wrapper 只有 287px
            ⇒ 内容右缘冲到 `rb.r=1487 > vw=1332`（**越窗 155px**）
            = 用户截图「右侧边栏部分位置被挤压到屏幕外」；
         ③ 残留只在下一次**展开支的 done 回调**里被清（那里只清了两样），
            而 done 是否跑到取决于那次过渡有没有被 cancel ⇒ **时序赌博**，
            这正是"切几次页/点几次就恢复正常"的机制。
       ⇒ 修法：**清理归"退场的起点"无条件负责**，不赌任何异步回调（铁律 11：写/摘必须成对）。
       ⚠️ 放在 `setFloatAnim("closing")` 之后、几何淡出之前：先复位到干净起点，
          让下面按**真实 `rightWidth`** 重新走退场几何（右栏平滑滑回自己的宽度）。 */
    setRightMin0(false);
    /* ⚠️⚠️ A-1157-R2：退场**保持** `right-wrapper-anim`（本行的 `setRightMin0(false)` 摘的是
       `no-min` 与"宽度分支"，不能顺带把 `anim` 也摘掉）。
       实测（真 App CDP 逐帧，1332px 窗口）摘掉 `anim` 之后退场变成：
         `1ms 右栏=1092@240..1332` →（**411ms 完全不动**）→ `412ms 右栏=431@901..1332` → `…339@901..1240`
       根因：`anim` 一摘，`body.float-layout .right-wrapper:not(.right-wrapper-anim) .right-sidebar
       { width:100% !important }` 立刻重新生效，把右栏**钉死在浮层满宽**直到浮层类被摘
       ⇒ 右栏没有目标宽度、`transition: width` 没有插值对象 ⇒ 先冻结、再整块右跳、
       最后右缘向左退（右边空 92px）＝ 用户本轮报的「右边突然出现空白，然后侧边栏向右合上」。
       ⚠️ 这里**不写** `--right-target-w`：不写才会让那条 `var()` 声明按 IACVT 失效，
         右栏回落到 `var(--right-sidebar-w)`（CSS 单源）并被 `.right-sidebar` 的常驻过渡接住。
       ⚠️ 摘除点在下面的几何 done（与 `setRightMin0(false)` 并排），不在这里。 */
    /* ⚠️⚠️⚠️ A-1157-R2：**先量后写、再挂 `anim`，顺序不能换**。
       退场要��右栏一个**显式的过渡起点**（浮层满宽），下一帧再放开 ⇒ 满宽平滑收到自然宽。
       为什么必须"先量"：`setRightExitAnim(true)` 是**离散事件的同步 flush** ——
       它一执行，铺满规则就失效、右栏**当刻**掉到自然宽（实测退场第一帧就是 431px）
       ⇒ 再去量就量到错的起点。这正是第一版"延后一帧清理"仍然失败的原因：
       `6ms 右栏=431px @901..1332`，`transition` 没有起点 ⇒ 退场全程（400+ms）纹丝不动。
       为什么"延后清理"本身也不够：此时 `.right-sidebar` 的内联宽是**上一次普通展开的残值**
       （A-1155-R8 记过，实测 287px），**不是**浮层满宽 ⇒ 留着也只是留了个错的起点。 */
    const rwExitPre = rightWrapperRef.current;
    const rsExit = rwExitPre?.querySelector(".right-sidebar") ?? null;
    /* ⚠️⚠️ A-1157-R2：**先清残值、再挂 `exit` 类**，顺序不能换。
       · 先清：此刻铺满规则仍在生效（内联残值被它压住），所以清除**没有视觉变化**；
         而如果留到挂类之后才清，内联残值会**突然生效**（实测上一次普通展开留的是 287px）
         ⇒ 右栏直接跳到 287，而不是从浮层满宽过渡下来。
       · 再挂：铺满规则失效 ⇒ 右栏的计算宽度由 `1092`（满宽）变成自然宽
         ⇒ `.right-sidebar` 常驻的 `transition: width .5s` **有旧计算值可插值**
         ⇒ 平滑收窄，右缘由 `margin-left:auto` 钉在窗口右缘不动。 */
    if (rsExit instanceof HTMLElement) { rsExit.style.width = ""; }
    setRightExitAnim(true);
    const rwExit = rwExitPre;
    if (rwExit) {
      rwExit.style.removeProperty("--right-body-pin");
      rwExit.style.removeProperty("--right-target-w");
      /* ⚠️ A-1155-R7：`--left-w` 是**稳态**变量（浮层存续期用于 `calc(100% - var(--left-w))`），
         退场同样必须摘 —— 否则下次**普通展开**时它还在，虽然普通支的 width 走 `auto`
         不受影响，但留着脏变量会让"谁在写谁在摘"不可审计（铁律 11）。 */
      rwExit.style.removeProperty("--left-w");
      /* ⚠️⚠️ A-1155-R8：**顺手摘掉 `.right-sidebar` 的内联宽残留**。
         真 App CDP 实测：浮层稳态下 `rsInlineW="287px"` —— 那是**上一轮普通展开**
         （`animateRightSidebar(_, nextWidth)` 的 `setRightWidth`）写下的内联宽，
         浮层支不写它、但**也没有任何地方摘它** ⇒ 越窗排查时它会持续误导判读
         （`.right-sidebar` 的 CSS `!important` 在浮层态盖过它，所以暂时不显形；
          一旦某条路径摘掉那个 `!important`，287px 就会立刻显形 = 静默地雷）。
         ⇒ 退浮层时一并清成 CSS 常态（普通展开路径自己会在展开起点重写）。 */
      const rsExitDup = rwExit.querySelector(".right-sidebar");
      /* ⚠️ A-1157-R2：残值已在上面清过；这里保留一次兜底摘除
         （退场被打断、几何 done 没能跑到时的最后一道）。 */
      if (rsExitDup instanceof HTMLElement) { rsExitDup.style.width = ""; }
    }
    // 内容淡出：量外框宽度、min=0（窗口收到 0 宽）；退场收尾挂在几何 done 上
    startFloatGeometryFade(0, (genOk) => {
      /* ⚠️⚠️ A-1154：**先复位动画态，再判世代**。
         `setFloatAnim("idle")` 必须无条件执行：渲染层的 `closing` 由它决定，
         卡在 `"closing"` 会让浮窗 `w/h=0`（真机实测「进了浮层但浮窗不可见」）。
         而 `setFloatState("none")` 是**业务状态回写**，只在"本轮退场仍是当前那一轮"时才允许 ——
         否则一个**迟到的 done** 会把用户刚点出来的新浮层打回 none
         （用户原话「窗口出现一次抽搐抖动，但对话页不会窗口化」，实测 S4a 零响应 / S4b 才生效）。 */
      setFloatAnim("idle");
      // 期间被最小化/还原打断（那两条路会复位本标记）→ 这次退场作废，别把 state 落成 none
      if (!floatClosingRef.current || !genOk) { return; }
      floatClosingRef.current = false;
      setFloatState("none");
      /* ⚠️ A-1155：done 时**再确认一次**过渡期状态已清（与上面起点那次构成"起点 + 收尾"双保险）。
         若本轮期间有别的路径（如标题栏先把右栏展开动画起了）又写回这些值，这里兜住。
         成对摘除是铁律 11 的硬要求：写的地方每多一处，摘的地方必须跟上。 */
      setRightMin0(false);
      /* ⚠️ A-1157-R2：退场过渡的 `anim` 标志**成对摘除**（挂在 `dismissFloat` 起点）。
         ⚠️ 必须与 `setFloatState("none")` 同一个 done：几何收敛早于浮层类被摘，
         若提前摘 `anim`，铺满规则会在"右栏已收窄、浮层类还在"的窗口里重新生效
         ⇒ 又变成一次"钉死 → 跳变"。 */
      setRightExitAnim(false);
      /* ⚠️⚠️ A-1158-R：**必须清掉内层包裹层的 opacity 残留**（用户实测回归：
         「恢复窗口化之后中间一片黑」）。
         机制：几何渐隐（`startFloatGeometryFade` 的 onFrame）在退场终点把
         `floatInnerRef.current.style.opacity` 写成 ≈0（窗口收到 0 宽 ⇒ 比例 p→0）。
         **改造前**这层住在浮窗里、随浮层卸载 ⇒ 残留无害；
         **改造后（A-1158 唯一宿主）它常驻** ⇒ 那句 `opacity: 0` 就一直作用在
         **普通布局的聊天区**上 ⇒ 中间整块透明（探针实测 `innerOpacity: "0"`）。
         ⚠️ 为什么 JSX 里的 `opacity: floatMinIcon ? 0 : 1` 救不了：React 只在**该属性
            的 prop 变化**时重写 style，inline 模式下它恒为 1 ⇒ 不重写 ⇒ 命令式的 0 留存。
         ⇒ 清除点必须与「浮层态结束」同处（铁律 11：谁写谁摘）。 */
      const fiExit = floatInnerRef.current;
      if (fiExit) { fiExit.style.opacity = ""; }
      /* ⚠️ A-1157-R2：退场起点写进去的**过渡起点宽**，在这里成对摘掉
         （起点的 rAF 只负责"放开"过渡，正常路径它早就跑完了；
         这里再摘一次是兜底：退场被打断时那一行可能没执行到）。 */
      const rsDone = rightWrapperRef.current?.querySelector(".right-sidebar");
      if (rsDone instanceof HTMLElement) { rsDone.style.width = ""; }
      rightWrapperRef.current?.style.removeProperty("--right-body-pin");
      rightWrapperRef.current?.style.removeProperty("--right-target-w");
      rightWrapperRef.current?.style.removeProperty("--left-w");
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; }
      /* ⚠️ A-1153：这里原本"归还右栏宽度"（`setRightWidth(back)`）——已删除。
         浮层铺满现在**不改写 `rightWidth`** ⇒ 退出浮层时右栏本来就还是它自己的宽度
         （`.right-sidebar` 常驻 `transition: width 0.5s`，`float-layout` 一摘就平滑滑回）。
         ⚠️ 主区目标宽度改用**当前** `rightWidth`（= 退出后右栏将要占的宽，语义等价且无需归还）。 */
      // A-980-R33：主区目标宽度 = 窗口宽 − 实测左栏宽 − 右栏宽——
      // 聊天区淡入窗口按它换算成比例（与侧栏/悬浮窗同一套 FADE_VISIBLE_LO/HI），自适应界面。
      const leftW = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
      const targetRight = rightWidthRef.current;
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
    startFloatGeometryFade(FLOAT_ICON_SIZE, (genOk) => {
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; } // 动画结束：恢复基础过渡（拖拽跟手）
      /* A-1154：动画态无条件复位；`setFloatState` 是业务回写，只在仍是当前轮时写。 */
      setFloatAnim("idle");
      if (!genOk) { return; }
      setFloatState("min");
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
    startFloatGeometryFade(FLOAT_ICON_SIZE, (genOk) => {
      /* A-1154：动画态无条件复位（否则浮窗卡在 closing ⇒ 0×0 不可见）；业务回写判世代。 */
      setFloatAnim("idle");
      if (!genOk) { return; }
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
   *                "窗口真的缩到位/长到位了"才是下一阶段的开始，而不是"猜过了多久"。
   *                ⚠️ A-1154：入参多一个 `genOk`（本轮回调是否仍是**当前**那一轮）。
   *                   调用点里"业务状态回写"（`setFloatState`）必须先判 `genOk`，
   *                   而"动画态复位"（`setFloatAnim("idle")`）必须无条件执行 —— 两者责任不同，
   *                   见 `dismissFloat` 的详细说明。 */
  function startFloatGeometryFade(minW: number = FLOAT_ICON_SIZE, onDone?: (genOk: boolean) => void): void {
    floatFadeCancelRef.current?.();
    floatFadeCancelRef.current = null;
    /* A-1154：起新一轮 ⇒ 世代号自增 ⇒ 上一轮任何"迟到回调"立即过期（见 floatFadeGenRef 注释）。
       ⚠️ 必须在 cancel 之后自增：cancel 只是停 rAF，但**回调可能已经排进了当前帧的微任务**。 */
    const gen = ++floatFadeGenRef.current;
    /* ⚠️⚠️ A-1154：被打断的那一轮**必须自己把临时类与变量摘干净**。
       此前这里只 `?.()` cancel（rAF 停表），不摘 `slime-freezing` / `--slime-freeze-w` ——
       而摘除只写在**本轮的几何 done** 里 ⇒ 一旦本轮 done 永不触发（见
       `GEOM_SYNC_NEVER_MOUNT_FRAMES` 那节记录的"对象从未挂载"路径），
       类与变量就**永久残留**（真 App CDP 实测 > 3.7s），把聊天区钉死在旧宽。
       放这里（新周期开始**之前**）与 `animateRightSidebar` 的 cancel 分支同构 ——
       铁律 11：临时态成对写/摘，谁挂谁负责摘。 */
    document.body.classList.remove("slime-freezing");
    document.body.style.removeProperty("--slime-freeze-w");
    /* A-1152：过渡期间给 `body` 挂 `slime-freezing` ⇒ 聊天区切 `content-visibility: auto`
       （保留可见区、跳过屏幕外），并在几何 done 时摘掉。
       用户报「聊天页窗口化那一个瞬间，每次必然卡顿掉帧」—— 根因是外框宽高**每帧都在变**
       ⇒ 里面整段会话每帧重排（与拖动侧栏同一个根因，只是这里不能 `hidden`：
       浮层正要显示这段内容，藏起来用户会看到一片空白）。
       挂在这个函数里是因为它是**最小化 / 还原 / 退场三条路径的共同入口**
       （A-980-R27 已把三处的固定时长计时器都换成了几何 done）⇒ 一处覆盖全部。
       ⚠️ 摘类必须放在几何 done，不能用固定时长（过渡被打断时会残留）。 */
    document.body.classList.add("slime-freezing");
    /* A-1152：把**目标宽度**写进 CSS 变量，聊天区据此钉住宽度（`width: var(--slime-freeze-w) !important`
       + `flex: 0 0 auto`，见 index.css）⇒ 过渡期间内容**零重排**，只被祖先 `overflow: hidden` 裁切。
       与右栏 `.right-wrapper-pin`（A-1016-F3）**同构** —— 那套是"钉住 webview 的 guest 宽度"，
       这里是"钉住聊天区的宽度"，目的是同一个：**不让内容跟着容器宽度一起重排**。
       ⚠️ 必须写 `floatSizeRef.current.w`（**目标**宽）而不是当前实测宽：
       钉当前宽的话，还原方向上容器长大时内容仍要跟着重排 ⇒ 白钉。
       ⚠️ 变量与 class 必须**成对**写/清：只写 class 会让 `var()` 落空 → 声明退化为 `auto`
       → 等于没钉（右栏 pin 那节的注释已记过同一个坑）。 */
    {
      /* ⚠️ 读**最新**的 floatSize，不是 ref 的旧值：上面那个 resize effect 可能在同一时刻
         把尺寸夹小（窗口变小），此时若还钉旧宽，聊天区会比窗口还宽 ⇒ 视口里出现空白
         （用户实测："窗口化后…折叠的窗口内会暂时显示空白"）。 */
      const targetW = Math.round(floatSizeRef.current.w);
      if (targetW > 1) { document.body.style.setProperty("--slime-freeze-w", `${targetW}px`); }
    }
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
        if (done) {
          /* ⚠️ A-1154：这里**不**做世代校验 —— 世代校验必须放在**回调内部**、且只挡
             "业务状态回写"（`setFloatState`）。理由：`onDone` 里还承担**动画态复位**
             （`setFloatAnim("idle")`）。若在这里就 return，那么"本轮已被新一轮取代"时
             动画态就没人复位 ⇒ 渲染层 `closing` 恒真 ⇒ **浮窗永远 0×0 不可见**
             （真机实测：S4a 进了浮层但 `fw=[252,42,0,0]`）。
             ⇒ 拆开责任：本函数只负责"摘临时类/清变量"，世代判定交给各调用点的 onDone。 */
          document.body.classList.remove("slime-freezing");
          /* ⚠️⚠️ 变量必须**成对**清：只清class 会让下一轮过渡的第一帧就退回「没钉」
             （= 又开始逐帧重排）；更糟的是若两处都漏，变量会**长期残留**，
             聊天区一直被钉在某个旧宽度 ⇒ 用户看到「窗口内空白」（A-1152 实测）。
             ⚠️ 这行曾被我在改写本段时漏掉，被守卫 `a1152-float-stability` 的
             "两处都要 removeProperty" 抓到 —— 形状断言在这种静默失效上是有效的。 */
          document.body.style.removeProperty("--slime-freeze-w");
          /* ⚠️ A-1154：把"本轮回调是否仍是当前那一轮"作为**参数**交给调用点 ——
             各调用点自己决定"哪些写操作要挡、哪些必须无条件做"（见 dismissFloat 的说明）。
             `gen` 是本轮起动画时取的世代号，`floatFadeGenRef.current` 是最新世代。 */
          onDone?.(gen === floatFadeGenRef.current);
        }
      },
      { min: minW, full: floatSizeRef.current.w },
    );
  }

  /** A-980-R16：悬浮窗拖拽调尺寸（右缘 e=宽 / 底缘 s=高 / 右下角 se=两者；
   *  拖拽中直接改 DOM，松手落 state 按会话记忆；尺寸钳制在窗口内）。
   *  A-980-R17/R19：拖拽期间临时禁用宽高过渡（否则 0.3s 过渡让尺寸追不上鼠标），松手恢复基础过渡。
   *  ⚠️ A-1152：**当前无调用点** —— 浮窗那三个 resize 手柄已按用户要求删除
   *  （「不仅有空白，还能手动拖拽强行拉开」）。函数**故意保留**：删手柄只是不想让用户拖，
   *  实现本身没问题；若改主意要恢复手柄，直接接回即可。
   *  ⚠️ 无调用点会被 `noUnusedLocals` 报 TS6133 ⇒ 函数下方有一行 `void startFloatResize;`，
   *  那是「刻意保留」的可执行声明，删掉它 tsc 就红。 */
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
