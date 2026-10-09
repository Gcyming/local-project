






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
import { PluginThemeHost } from "./components/PluginThemeHost.js";
import { PluginCssHost } from "./components/PluginCssHost.js";

import OperationFocusOverlay from "./components/OperationFocusOverlay.js";

import teamSvg from "./assets/team.svg";

import currentSessionSvg from "./assets/current-session.svg";

import floatIconUrl from "./assets/icon.ico?url";

import appIconUrl from "../../build/icon.png";
import { getTheme, applyTheme, type ThemeName } from "./theme.js";
import { confirmAsync } from "./dialog.js";


import { readNetworkEnabled } from "./networkToggle.js";

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


interface ProviderModelBrief {
  key: string;
  models: Array<{
    id: string;
    selected?: boolean;
    
    thinking?: boolean;
    
    thinking_efforts?: string[];
    
    max_output?: number;
    
    context_window?: number;
    
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
  
  memberIds?: string[];
  
  memberNames?: string[];
  
  memberModels?: Record<string, string>;
  
  leaderModel?: string;
  
  memberEfforts?: Record<string, string>;
  
  leaderEffort?: string;
  
  type?: "normal" | "brainstorm";
  


  modelChoice?: string;
}

interface WelcomeChatProps {
  onSend: (text: string) => Promise<void>;
  agents: AgentBrief[];
  onChooseAgent: (agentId: string) => Promise<void>;
  onOpenAgents: () => void;
}


function WelcomeChat({ onSend, agents, onChooseAgent, onOpenAgents }: WelcomeChatProps): JSX.Element {
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [showAgents, setShowAgents] = React.useState(false);
  const [examples, setExamples] = React.useState<string[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  const aliveRef = React.useRef(true);
  const noticeTimerRef = React.useRef<number | null>(null);

  /* A-1197：欢迎页发送失败必须「可见」——沿用 GeneralPanel 的 showNotice 惯例
     （局部 notice state + 内联 div + 自动消失），不新造一套 toast。
     aliveRef 防组件卸载后 setState；卸载时清掉未触发的定时器。 */
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (noticeTimerRef.current !== null) { window.clearTimeout(noticeTimerRef.current); }
    };
  }, []);

  const showNotice = React.useCallback((ok: boolean, text: string): void => {
    if (!aliveRef.current) { return; }
    setNotice({ ok, text });
    if (noticeTimerRef.current !== null) { window.clearTimeout(noticeTimerRef.current); }
    noticeTimerRef.current = window.setTimeout(() => { if (aliveRef.current) { setNotice(null); } }, 5000);
  }, []);

  
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
      } catch {  }
      
      setExamples(shuffleAndPick(DEFAULT_EXAMPLES, 3));
    };
    void loadHistory();
    
    const off = api.chat?.onHistoryUpdate?.(updateExamples);
    return () => { off?.(); };
    
  }, []);

  
  const updateExamples = React.useCallback((histories: string[]): void => {
    if (histories.length === 0) { return; }
    
    const freq = new Map<string, number>();
    for (const h of histories) {
      const words = h.split(/\s+/).filter((w) => w.length > 2);
      for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }
    
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
    } catch (e: unknown) {
      /* A-1197：onSend（handleWelcomeSend）失败时用户此前完全看不到任何反馈
         （「点了没反应」的表面症状之一）——这里把它接成可见的 notice。 */
      console.error("[app] welcome send failed:", e);
      showNotice(false, e instanceof Error ? `发送失败：${e.message}` : "发送失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", minHeight: 0, gap: 18, overflow: "hidden", width: "100%", padding: "0 24px", boxSizing: "border-box" }}>
      {}
      <img src={appIconUrl} alt="Slime" style={{ width: 64, height: 64, borderRadius: 18, objectFit: "cover" }} />
      <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>Slime</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", textAlign: "center", maxWidth: 420, lineHeight: 1.6, wordBreak: "break-word", padding: "0 8px", boxSizing: "border-box" }}>
        直接在这里输入想做的事；无需手动选择 Agent——后端会自动为你的会话分配最合适的助手。
      </div>
      {notice && (
        <div style={{
          maxWidth: 680, width: "100%", padding: "8px 12px", boxSizing: "border-box",
          fontSize: 12.5, lineHeight: 1.5, borderRadius: 8, border: "1px solid var(--border)",
          background: notice.ok ? "var(--success-soft)" : "var(--danger-soft)",
          color: notice.ok ? "var(--success)" : "#f87171", textAlign: "center", wordBreak: "break-word",
        }}>
          {notice.text}
        </div>
      )}
      {}
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
      {}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 640, width: "100%", padding: "0 8px", boxSizing: "border-box" }}>
        {examples.map((s) => (
          <button key={s}
            onClick={() => { void handleSend(s); setDraft(""); setShowAgents(false); }}
            style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 14, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text-muted)", cursor: "pointer" }}>
            {s}
          </button>
        ))}
      </div>
      {}
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







const FIRST_LOAD_KEYS = ["agents", "sessions", "providers", "localModels", "chatHistory"] as const;








const METADATA_LOAD_KEYS = ["agents", "sessions", "providers", "localModels"] as const;
const CONTENT_LOAD_KEY = "chatHistory";

const CONTENT_GUARD_MS = 20000;







const GATE_KEYS_CONSISTENT =
  FIRST_LOAD_KEYS.length === METADATA_LOAD_KEYS.length + 1
  && METADATA_LOAD_KEYS.every((k) => (FIRST_LOAD_KEYS as readonly string[]).includes(k))
  && (FIRST_LOAD_KEYS as readonly string[]).includes(CONTENT_LOAD_KEY);
if (!GATE_KEYS_CONSISTENT) {
  console.warn("[startup] 启动门的分组与登记表不一致 —— 门会少等或多等一项（检查 METADATA_LOAD_KEYS / CONTENT_LOAD_KEY）");
}



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


function pathBase(p: string): string {
  const s = (p ?? "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}


const FLOAT_MIN_W = 340;
const FLOAT_MIN_H = 300;








const FLOAT_RATIO = { w: 0.5, h: 0.48 };
function clampFloatSize(w: number, h: number): { w: number; h: number } {
  const maxW = Math.max(FLOAT_MIN_W, window.innerWidth - 24);
  const maxH = Math.max(FLOAT_MIN_H, window.innerHeight - 70);
  return {
    w: Math.max(FLOAT_MIN_W, Math.min(w, maxW)),
    h: Math.max(FLOAT_MIN_H, Math.min(h, maxH)),
  };
}


function clampFloatPos(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(4, window.innerWidth - 160);
  const maxY = Math.max(4, window.innerHeight - 60);
  return {
    x: Math.max(4, Math.min(x, maxX)),
    y: Math.max(4, Math.min(y, maxY)),
  };
}


const FLOAT_ICON_SIZE = 44;


















export const FLOAT_TRANSITION_MS = 400;
const FLOAT_EASE = "cubic-bezier(0,0,0.2,1)";





const FLOAT_TRANSITION = `height ${FLOAT_TRANSITION_MS}ms ${FLOAT_EASE}, width ${FLOAT_TRANSITION_MS}ms ${FLOAT_EASE}`;

const FLOAT_TRANSITION_FULL = `top ${FLOAT_TRANSITION_MS}ms ${FLOAT_EASE}, left ${FLOAT_TRANSITION_MS}ms ${FLOAT_EASE}, ${FLOAT_TRANSITION}`;



function fitFloatRect(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, Math.max(4, window.innerWidth - w - 8))),
    y: Math.max(4, Math.min(y, Math.max(4, window.innerHeight - h - 8))),
  };
}





const SIDEBAR_RATIO = { left: 0.175, right: 0.215 };



const SIDEBAR_MIN_W = 240;
const SIDEBAR_MAX_W = 520;
















const FADE_VISIBLE_LO = 0.45;
const FADE_VISIBLE_HI = 0.90;










const LEFT_FADE_LO = 0.40;
const LEFT_FADE_HI = 0.95;
































const LEFT_FADE_COLLAPSE_LO = 0;
const LEFT_FADE_COLLAPSE_HI = 0.27;








const CHAT_MIN_W = 380;





























export const GEOM_FADE_MS = 500;

















export const SIDEBAR_WIDTH_MS = 500;

















const CHAT_FADE_MS = SIDEBAR_WIDTH_MS;














const CHAT_FADE_DRAG_MS = 120;













const CHAT_SETTLE_MS = 40;































const CHAT_DIP_OUT_MS = Math.round(SIDEBAR_WIDTH_MS * (LEFT_FADE_COLLAPSE_HI - LEFT_FADE_COLLAPSE_LO));
const CHAT_DIP_IN_AT_MS = Math.round(SIDEBAR_WIDTH_MS * LEFT_FADE_LO);
const CHAT_DIP_IN_MS = Math.round(SIDEBAR_WIDTH_MS * (LEFT_FADE_HI - LEFT_FADE_LO));








const CHAT_GEOM_TAIL_MS = 60;






const SIDEBAR_SNAP_W = 8;





const RIGHT_SIDEBAR_MIN_RATIO = 0.15;




function rightSidebarMinW(): number {
  return Math.max(260, Math.round(window.innerWidth * RIGHT_SIDEBAR_MIN_RATIO));
}














const RIGHT_CONTENT_MAX_W = 1600;





















































































function runGeometrySyncFade(
  measure: () => HTMLElement | null,
  onFrame: (p: number, done: boolean) => void,
  opts: { min?: number; full: number; lo?: number; hi?: number; loRatio?: number; hiRatio?: number; duration?: number },
): () => void {
  const min = opts.min ?? 0;
  const span = Math.max(1, opts.full - min);
  
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
    
    const w = min + span * u;
    const raw = Math.max(0, Math.min(1, (w - lo) / band));
    const p = raw * raw * (3 - 2 * raw); 
    









    void measure; 
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
  





  React.useEffect(() => installFloatTrace(), []);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab>("general");
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  

  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    const v = parseInt(localStorage.getItem('slime_sidebar_w') ?? "", 10);
    if (Number.isFinite(v)) { return Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, v)); }
    return Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Math.round(window.innerWidth * SIDEBAR_RATIO.left)));
  });
  





  const [sidebarCustom, setSidebarCustom] = React.useState(() => Number.isFinite(parseInt(localStorage.getItem('slime_sidebar_w') ?? "", 10)));
  
  const [rightOpen, setRightOpen] = React.useState(true);
  const [rightWidth, setRightWidth] = React.useState(() => {
    const v = parseInt(localStorage.getItem('slime_rightbar_w') ?? "", 10);
    const max = Math.max(600, window.innerWidth - 48);
    const minW = rightSidebarMinW();
    
    
    if (Number.isFinite(v)) { return Math.max(minW, Math.min(max, v)); }
    
    return Math.min(max, Math.max(minW, Math.round(window.innerWidth * SIDEBAR_RATIO.right)));
  });
  

  const [rightCustom, setRightCustom] = React.useState(() => Number.isFinite(parseInt(localStorage.getItem('slime_rightbar_w') ?? "", 10)));
  





  


  const [floatState, setFloatState] = React.useState<"none" | "float" | "min">("none");
  



  const [floatAnim, setFloatAnim] = React.useState<"idle" | "out" | "in" | "closing">("idle");
  







  


  const inlineChatRef = React.useRef<HTMLDivElement | null>(null);
  


  const chatHostRef = React.useRef<HTMLDivElement | null>(null);
  const chatFadeCancelRef = React.useRef<(() => void) | null>(null);
  



  const floatClosingRef = React.useRef(false);
  

  const leftFadeCancelRef = React.useRef<(() => void) | null>(null);
  const rightFadeCancelRef = React.useRef<(() => void) | null>(null);
  const floatFadeCancelRef = React.useRef<(() => void) | null>(null);
  











  const floatFadeGenRef = React.useRef(0);
  

  const chatFreezeFallbackRef = React.useRef(0);
  





  const chatSettleTimerRef = React.useRef(0);
  









  const chatGeomAnimRef = React.useRef(false);
  
  const chatGeomTimerRef = React.useRef(0);
  




  const chatDipActiveRef = React.useRef(false);
  
  const chatDipInTimerRef = React.useRef(0);
  
  const chatDipEndTimerRef = React.useRef(0);
  



















  const dragPhaseTimerRef = React.useRef(0);
  
  const leftSidebarRef = React.useRef<HTMLElement | null>(null);
  const rightWrapperRef = React.useRef<HTMLDivElement | null>(null);
  



  const [leftMin0, setLeftMin0] = React.useState(false);
  const [rightMin0, setRightMin0] = React.useState(false);
  

















  React.useEffect(() => {
    if (rightMin0) { return; }
    const rw = rightWrapperRef.current;
    if (!rw) { return; }
    rw.style.removeProperty("--right-target-w");
    

    rw.style.removeProperty("--right-body-pin");
  }, [rightMin0]);
  








  const [rightExitAnim, setRightExitAnim] = React.useState(false);
  
  const floatDragMovedRef = React.useRef(false);
  






  const leftDraggingRef = React.useRef(false);
  
  











  const [floatSize, setFloatSize] = React.useState<{ w: number; h: number }>(() => clampFloatSize(
    Math.round(window.innerWidth * FLOAT_RATIO.w),
    Math.round(window.innerHeight * FLOAT_RATIO.h),
  ));
  const [floatPos, setFloatPos] = React.useState<{ x: number; y: number } | null>(null);
  const floatRef = React.useRef<HTMLDivElement | null>(null);
  const floatSizeRef = React.useRef(floatSize);
  floatSizeRef.current = floatSize;
  






  React.useEffect(() => {
    if (floatState === "none") { return; }
    





    let rafId = 0;
    const onWinResize = (): void => {
      if (rafId) { return; }
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        const cur = floatSizeRef.current;
        







        const ratioW = Math.round(window.innerWidth * FLOAT_RATIO.w);
        const ratioH = Math.round(window.innerHeight * FLOAT_RATIO.h);
        const next = clampFloatSize(
          cur.w < ratioW ? ratioW : cur.w,
          cur.h < ratioH ? ratioH : cur.h,
        );
        if (next.w !== cur.w || next.h !== cur.h) { setFloatSize(next); }
        setFloatPos((p) => { const q = clampFloatPos(p?.x ?? 0, p?.y ?? 0); return (p && p.x === q.x && p.y === q.y) ? p : q; });
        




        if (floatStateRef.current !== "none") {
          const lw = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
          rightWrapperRef.current?.style.setProperty("--left-w", `${Math.round(lw)}px`);
        }
      });
    };
    window.addEventListener("resize", onWinResize);
    return () => { window.removeEventListener("resize", onWinResize); if (rafId) { window.cancelAnimationFrame(rafId); } };
    




  }, [floatState]);

  
























  const leftWidthObserverRef = React.useRef<ResizeObserver | null>(null);
  const attachLeftWidthObserver = React.useCallback((el: HTMLElement | null): void => {
    leftSidebarRef.current = el;
    leftWidthObserverRef.current?.disconnect();
    leftWidthObserverRef.current = null;
    if (!el || typeof ResizeObserver === "undefined") { return; }
    const sync = (): void => {
      if (floatStateRef.current === "none") { return; }
      








      if (leftDraggingRef.current) { return; }
      


















      rightWrapperRef.current?.style.setProperty("--left-w", `${Math.round(sidebarOpenRef.current ? sidebarWidthRef.current : 0)}px`);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    leftWidthObserverRef.current = ro;
  }, []);

  













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
    
    onWinResize();
    return () => { window.removeEventListener("resize", onWinResize); if (rafId) { window.cancelAnimationFrame(rafId); } };
  }, [rightCustom]);

  

















































  React.useEffect(() => {
    

    let lastW = -1;
    let lastOutDur = 0;
    let lastInDur = 0;
    const mark = (): void => {
      










      if (chatDipActiveRef.current) { return; }
      if (chatGeomAnimRef.current) { startChatDip(); return; }
      










      const outDur = document.body.classList.contains("slime-dragging") ? CHAT_FADE_DRAG_MS : CHAT_FADE_MS;
      if (outDur !== lastOutDur) {
        lastOutDur = outDur;
        document.body.style.setProperty("--chat-fade-out-dur", `${outDur}ms`);
      }
      if (lastInDur !== CHAT_FADE_MS) {
        lastInDur = CHAT_FADE_MS;
        document.body.style.setProperty("--chat-fade-in-dur", `${CHAT_FADE_MS}ms`);
      }
      document.body.classList.add("slime-fading");
      




      if (dragPhaseTimerRef.current === 0 && !document.body.classList.contains("slime-resizing")) {
        dragPhaseTimerRef.current = window.setTimeout(() => {
          dragPhaseTimerRef.current = 0;
          


          if (!document.body.classList.contains("slime-fading")) { return; }
          document.body.classList.add("slime-resizing");
        }, outDur);
      }
      





      window.clearTimeout(chatSettleTimerRef.current);
      chatSettleTimerRef.current = window.setTimeout(() => {
        chatSettleTimerRef.current = 0;
        if (document.body.classList.contains("slime-dragging")) { return; }
        endChatFreeze();
      }, CHAT_SETTLE_MS);
    };
    const host = chatHostRef.current;
    const target = host?.parentElement ?? host;
    if (!target || typeof ResizeObserver === "undefined") {
      
      window.addEventListener("resize", mark);
      return () => {
        window.removeEventListener("resize", mark);
        window.clearTimeout(dragPhaseTimerRef.current);
        window.clearTimeout(chatSettleTimerRef.current);
        endChatFreeze();
      };
    }
    const ro = new ResizeObserver(() => {
      const w = Math.round(target.getBoundingClientRect().width);
      

      if (w === lastW) { return; }
      const first = lastW < 0;
      lastW = w;
      if (first) { return; }   
      mark();
    });
    ro.observe(target);
    lastW = Math.round(target.getBoundingClientRect().width);
    return () => {
      ro.disconnect();
      window.clearTimeout(dragPhaseTimerRef.current);
      window.clearTimeout(chatSettleTimerRef.current);
      endChatFreeze();
    };
    



  }, [floatState]);
  const floatPosRef = React.useRef(floatPos);
  floatPosRef.current = floatPos;
  
  const floatInnerRef = React.useRef<HTMLDivElement | null>(null);
  
  React.useEffect(() => {
    const onOpen = (): void => setRightOpen(true);
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
  }, []);
  
  const [sessionWorkspace, setSessionWorkspace] = React.useState("");
  

  const [workspaceTick, setWorkspaceTick] = React.useState(0);
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  



  const [selectionSettled, setSelectionSettled] = React.useState(false);
  
  
  
  const rightViewCacheRef = React.useRef<Record<string, { open: boolean; width: number; float?: "float" | "min"; size?: { w: number; h: number }; pos?: { x: number; y: number } | null; iconPos?: { x: number; y: number } | null }>>({});
  const prevRightSidRef = React.useRef<string | null>(null);
  const floatStateRef = React.useRef(floatState);
  floatStateRef.current = floatState;
  



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
        
        
        leftFadeCancelRef.current?.();
        leftFadeCancelRef.current = null;
        rightFadeCancelRef.current?.();
        rightFadeCancelRef.current = null;
        floatFadeCancelRef.current?.();
        floatFadeCancelRef.current = null;
        

        floatFadeGenRef.current++;
        


        document.body.classList.remove("slime-freezing");
        document.body.style.removeProperty("--slime-freeze-w");
        
        chatFadeCancelRef.current?.();
        chatFadeCancelRef.current = null;
        floatClosingRef.current = false;
        
        
        
        setRightWebviewPin(null);
        const le = leftSidebarRef.current;
        if (le) { le.style.transition = ""; le.style.opacity = ""; }
        const rw = rightWrapperRef.current;
        if (rw) {
          rw.style.transition = ""; rw.style.opacity = "";
          


          rw.style.removeProperty("--right-target-w");
          rw.style.removeProperty("--right-body-pin");
          




          const rsReset = rw.querySelector<HTMLElement>(".right-sidebar");
          if (rsReset) { rsReset.style.removeProperty("opacity"); }
        }
        const fi = floatInnerRef.current;
        if (fi) { fi.style.opacity = ""; }
        const ic = inlineChatRef.current;
        if (ic) { ic.style.opacity = ""; }
        setRightOpen(snap.open);
        
        
        setRightWidth(Math.max(rightSidebarMinW(), Math.min(Math.max(600, window.innerWidth - 48), snap.width)));
        const sf = snap.float;
        setFloatState(sf === "float" || sf === "min" ? sf : "none");
        setFloatAnim("idle");
        
        const sz = clampFloatSize(snap.size?.w ?? 480, snap.size?.h ?? 540);
        setFloatSize(sz);
        setFloatPos(snap.pos ? fitFloatRect(snap.pos.x, snap.pos.y, sz.w, sz.h) : null);
        
        floatIconHomeRef.current = snap.iconPos ?? null;
      }
    }
    prevRightSidRef.current = sid || null;
    
  }, [selectedSessionId]);
  const [agents, setAgents] = React.useState<AgentBrief[]>([]);
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  
  const sessionsKeyRef = React.useRef("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [agentConfig, setAgentConfig] = React.useState<Record<string, { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string }>>({});
  


  const agentCfgEpochRef = React.useRef<Record<string, number>>({});
  const [providerKeys, setProviderKeys] = React.useState<string[]>([]);
  const [providerModels, setProviderModels] = React.useState<ProviderModelBrief[]>([]);
  const [localModels, setLocalModels] = React.useState<LocalModelBrief[]>([]);
  const [newProjectOpen, setNewProjectOpen] = React.useState(false);
  
  const [newProjectPrefill, setNewProjectPrefill] = React.useState<string | null>(null);
  
  const [silamOk, setSilamOk] = React.useState(false);
  
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
      /* A-1197：silam 自研模型下线（slime.toml [silam] enabled=false）⇒ silamOk 恒为 false，
       * 这个条目当前**不会**出现。代码与门控都保留作占位：自研模型接回来后，
       * 只要 sidecar 的 status 如实返回 enabled，文案随之恢复即可。
       * warning 文案必须如实：不再写「离线情感脑+语言脑兜底」——
       * 那正是本轮下线的「无模型时拿它当兑底」这条路径，读起来像它能替你答。 */
      list.push({ key: "silam", label: "SILAM 自研（实验中）", kind: "silam", models: [{ id: "silam", label: "silam（离线自研大脑，当前未启用）" }] });
    }
    return list;
  }, [providerModels, localModels, silamOk]);
  
  const [editingSession, setEditingSession] = React.useState<{ sessionId: string; draft: string } | null>(null);
  
  const [dl, setDl] = React.useState<Record<string, DownloadProgressInfo>>({});
  
  const [boot, setBoot] = React.useState<BootStatus | null>(null);
  










  const [firstLoad, setFirstLoad] = React.useState<Record<string, boolean>>({});
  const markFirstLoad = React.useCallback((key: string): void => {
    setFirstLoad((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  






  const markChatHistoryLoaded = React.useCallback((): void => { markFirstLoad("chatHistory"); }, [markFirstLoad]);
  
  const [firstLoadGuard, setFirstLoadGuard] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setFirstLoadGuard(true), 8000);
    return () => window.clearTimeout(t);
  }, []);
  







  const [contentGuard, setContentGuard] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setContentGuard(true), CONTENT_GUARD_MS);
    return () => window.clearTimeout(t);
  }, []);
  




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
  
  const [splashMinDone, setSplashMinDone] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setSplashMinDone(true), 700);
    return () => window.clearTimeout(t);
  }, []);
  





  
  const [appVersion, setAppVersion] = React.useState("");
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void api?.boot?.version?.().then((v: string) => setAppVersion(v)).catch(() => {  });
  }, []);
  
  const [modelLoading, setModelLoading] = React.useState<{ loading: boolean; message?: string; key?: string }>({ loading: false });
  
  const [theme, setTheme] = React.useState<ThemeName>(getTheme());

  const sidebarWidthRef = React.useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  









  const sidebarOpenRef = React.useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  const rightWidthRef = React.useRef(rightWidth);
  rightWidthRef.current = rightWidth;

  React.useEffect(() => {
    applyTheme(theme);
    
    const api = (window as unknown as { slimeAPI?: { theme?: { set: (t: string) => Promise<void> } } }).slimeAPI;
    void api?.theme?.set(theme).catch(console.error);
  }, [theme]);

  
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("slime_agent_config");
      if (raw) { setAgentConfig(JSON.parse(raw)); }
    } catch {  }
  }, []);

  

  


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
    markFirstLoad("agents"); 
    
    
    
    for (const a of list) {
      const epoch0 = agentCfgEpochRef.current[a.id] ?? 0;
      api.agents.detail(a.id).then((d: { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string } | null) => {
        if ((agentCfgEpochRef.current[a.id] ?? 0) > epoch0) { return; }
        applyAgentDetail(a.id, d);
      }).catch(console.error);
    }
  }, [applyAgentDetail, markFirstLoad]);

  






  const loadSessions = React.useCallback(async (): Promise<SessionItem[]> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return []; }
    const items: SessionItem[] = await api.conversations.list().catch((e: unknown) => {
      console.error("[app] sessions list failed:", e);
      return [] as SessionItem[];
    });
    
    const key = JSON.stringify(items.map((s) => [s.sessionId, s.title, s.count, s.lastTime]));
    if (key === sessionsKeyRef.current) { return items; }
    sessionsKeyRef.current = key;
    setSessions(items);
    markFirstLoad("sessions"); 
    return items;
  }, [markFirstLoad]);

  
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    
    void Promise.all([loadAgents(), loadSessions()]).then(([, items]) => {
      
      
      
      if (items.length > 0) {
        
        setSelectedSessionId((cur) => (cur && items.some((s) => s.sessionId === cur) ? cur : items[0].sessionId));
      }
      
      setSelectionSettled(true);
    });
    
    const off = api.agents.onAgentSelected(() => {
      void loadAgents();
      void loadSessions();
    });
    return () => { off(); };
    
  }, []);

  
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    void loadSessions();
    const timer = window.setInterval(() => { void loadSessions(); }, 15000);
    return () => window.clearInterval(timer);
  }, [loadSessions]);

  
  React.useEffect(() => {
    const w = window as unknown as { __onAgentDetail?: (id: string, d: unknown) => void };
    w.__onAgentDetail = (id, d) => {
      const data = d as { model_choice?: string; mode?: string; reasoning_effort?: string; show_thinking?: string } | null;
      
      
      
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
            
            
            max_output: typeof m.max_output === "number" ? m.max_output : undefined,
            context_window: typeof m.context_window === "number" ? m.context_window : undefined,
            vision: m.vision === true,
          })),
        })));
        markFirstLoad("providers"); 
      }).catch((e: unknown) => {
        console.error(e);
        markFirstLoad("providers"); 
      });
      api.providers.localList().then((list: LocalModelBrief[]) => {
        setLocalModels(list);
        markFirstLoad("localModels"); 
      }).catch((e: unknown) => {
        console.error(e);
        markFirstLoad("localModels"); 
      });
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [markFirstLoad]);

  
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
    
  }, [dl.llama?.state, dl.bge?.state]);

  
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.boot) { return; }
    void api.boot.status().then((s: BootStatus) => setBoot(s)).catch(() => {});
    const off = api.boot.onEvent((s: BootStatus) => setBoot(s));
    return () => { off(); };
  }, []);

  
  React.useEffect(() => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.model) { return; }
    const off = api.model.onLoading((s: { loading: boolean; message?: string }) => setModelLoading(s));
    return () => { off(); };
  }, []);

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId) ?? null;
  const selectedAgentId = selectedSession?.agentId ?? null;
  const hasNoSession = selectedSession === null;

  








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

  


  const handleWelcomeSend = React.useCallback(async (text: string): Promise<void> => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    // A-1197 根因 B：api 缺失时不再静默返回——抛出由 WelcomeChat.handleSend 接成可见 notice。
    if (!api) { throw new Error("后端接口未就绪，无法创建会话"); }
    if (!text.trim()) { return; }

    const res = await api.conversations.create().catch((e: unknown) => {
      console.error("[app] welcome create failed:", e);
      throw new Error("会话创建失败，请稍后重试");
    });
    if (!res?.ok || !res.session) {
      // 主进程返回失败（ok 为 false）也走这里（此前是「静默 return」⇒ 用户点了没任何反应）
      console.error("[app] welcome create returned not-ok:", res);
      throw new Error("会话创建未成功，请稍后重试");
    }
    const sessionId = res.session.sessionId;
    const agentId = res.session.agentId;
    // A-1197 根因 A：会话其实创建成功了，但 selectedSession = sessions.find(...) 要等
    // loadSessions（全量 list + 历史聚合）回来才非空，期间渲染分支仍判 hasNoSession →
    // 界面「点了没反应」。乐观插入 create 返回的完整 session，让 ChatPanel 立刻挂载并
    // 订阅流（onChunk 在 ChatPanel 挂载的 effect 里才建立，早挂载 = 不丢首包）。
    // loadSessions 随后到达会用服务端数据整体替换（含去重），不影响正确性。
    setSessions((prev) => (prev.some((s) => s.sessionId === sessionId) ? prev : [res.session, ...prev]));
    setSelectedSessionId(sessionId);
    void loadSessions();

    if (api?.chat?.stream && agentId) {
      const netOn = readNetworkEnabled();
      const sres = await api.chat.stream({ agentId, message: text.trim(), sessionId, networkEnabled: netOn }).catch((e: unknown) => {
        console.error("[app] welcome stream failed:", e);
        return null;
      });
      // 启动失败（ok:false）时主进程已另发 slime:chat:error，ChatPanel 错误横幅会呈现；此处仅留痕，不重复造提示。
      if (!sres?.ok) { console.error("[app] welcome stream not started:", sres); }
    }

    const histories: string[] = [];
    try {
      const stored = localStorage.getItem("slime_welcome_examples");
      if (stored) histories.push(...JSON.parse(stored) as string[]);
    } catch {  }
    histories.push(text.trim());
    try {
      localStorage.setItem("slime_welcome_examples", JSON.stringify(histories.slice(-20)));
    } catch {  }
  }, [loadSessions]);

  
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

  
  /* A-1197：silam 自研模型已下线（slime.toml [silam] enabled=false），
   * 所以 status 现在稳定返回 { enabled: false } ⇒ siliamOk 恒false，
   * 依赖它的入口（供应商列表的 siliam 分组、新建项目的 siliam 选项、
   * ChatPanel 的模型下拉条目）都自动不可见。
   * 这个查询本身**保留**：它是「自研模型是否可用」的唯一如实产地，
   * 自研模型接回来后无需改调用方，只要 sidecar 真的起来就自动恢复显示。 */
  const refreshSilamStatus = React.useCallback((): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    api?.silam?.status?.().then((r: { enabled: boolean }) => setSilamOk(r.enabled === true)).catch(() => setSilamOk(false));
  }, []);
  React.useEffect(() => { refreshSilamStatus(); }, [refreshSilamStatus]);

  




  React.useEffect(() => subscribeNotifySound(), []);

  
  async function switchSessionAgent(agentId: string): Promise<void> {
    if (!selectedSessionId) { return; }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.setAgent) { return; }
    await api.conversations.setAgent(selectedSessionId, agentId).catch((e: unknown) => {
      console.error("[app] switch agent failed:", e);
    });
    await loadSessions();
  }

  
  function openNewSessionDialog(prefillWorkspace?: string | null): void {
    setNewProjectPrefill(prefillWorkspace === undefined ? null : prefillWorkspace);
    setNewProjectOpen(true);
    
    refreshSilamStatus();
    
    void loadAgents();
  }

  
  const handleSessionCreated = React.useCallback(async (sessionId: string): Promise<void> => {
    setSelectedSessionId(sessionId);
    setNewProjectOpen(false);
    await loadSessions();
  }, [loadSessions]);

  
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

  
  async function removeWorkspaceGroup(groupName: string, workspace: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    if (!(await confirmAsync(`删除工作区「${groupName}」？`, "其下全部会话与历史将一并清除（文件夹与 Agent 保留）。"))) {
      return;
    }
    const groupSessions = sessions.filter((s) => (s.workspace ?? "") === workspace);
    
    
    if (api.conversations?.removeWorkspace && workspace) {
      await api.conversations.removeWorkspace(workspace).catch(console.error);
    } else {
      for (const s of groupSessions) {
        await api.conversations.remove(s.sessionId).catch(console.error);
      }
    }
    
    if (groupSessions.some((s) => s.sessionId === selectedSessionId)) {
      const rest = sessions.filter((s) => !groupSessions.some((gs) => gs.sessionId === s.sessionId));
      setSelectedSessionId(rest.length > 0 ? rest[0].sessionId : null);
    }
    await loadSessions();
  }

  


  const currentModel = (selectedSession?.modelChoice ?? "").trim()
    || (agentConfig[selectedAgentId ?? ""]?.model_choice ?? "inherit");
  const currentMode = agentConfig[selectedAgentId ?? ""]?.mode ?? "build";
  const currentReasoning = agentConfig[selectedAgentId ?? ""]?.reasoning_effort ?? "none";
  const currentThinking = agentConfig[selectedAgentId ?? ""]?.show_thinking !== "0";

  
  async function updateAgentConfig(patch: Record<string, string>): Promise<void> {
    if (!selectedAgentId) { return; }
    
    agentCfgEpochRef.current[selectedAgentId] = (agentCfgEpochRef.current[selectedAgentId] ?? 0) + 1;
    setAgentConfig((prev) => ({ ...prev, [selectedAgentId]: { ...((prev[selectedAgentId] ?? {}) as Record<string, string>), ...patch } }));
    
    try {
      const raw = localStorage.getItem("slime_agent_config");
      const store: Record<string, Record<string, string>> = raw ? JSON.parse(raw) : {};
      store[selectedAgentId] = { ...(store[selectedAgentId] ?? {}), ...patch };
      localStorage.setItem("slime_agent_config", JSON.stringify(store));
    } catch {  }
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api) { return; }
    try {
      await api.agents.update(selectedAgentId, patch);
    } catch (e) {
      console.error("[app] agent config update failed:", e);
    }
  }

  
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

  









  const mainIsFloatLayout = rightOpen && floatState !== "none"
  








  






  ;

  






  React.useEffect(() => {
    if (mainIsFloatLayout) { document.body.classList.add("float-layout"); }
    else { document.body.classList.remove("float-layout"); }
    return () => { document.body.classList.remove("float-layout"); };
  }, [mainIsFloatLayout]);

  React.useEffect(() => {
    if (floatState !== "none" && !rightOpen) { setFloatState("none"); }
  }, [rightOpen, floatState]);

  











  const floatMinIcon = floatState === "min";
  const floatAnimOut = floatAnim === "out";
  const floatClosing = floatAnim === "closing";
  
















  const floatWasMinRef = React.useRef(false);
  if (floatMinIcon) { floatWasMinRef.current = true; }
  if (floatState === "float") { floatWasMinRef.current = false; }
  const floatIconLike = floatMinIcon || floatAnimOut || floatWasMinRef.current;
  










  const hostIsFloat = mainIsFloatLayout || floatClosing || floatAnimOut || floatAnim === "in";
  const floatBoxW = floatClosing ? 0 : (floatIconLike ? FLOAT_ICON_SIZE : floatSize.w);
  const floatBoxH = floatClosing ? 0 : (floatIconLike ? FLOAT_ICON_SIZE : floatSize.h);
  const floatBoxDefaultPos = fitFloatRect((sidebarOpen ? sidebarWidth : 0) + 12, 42, floatSize.w, floatSize.h);
  
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
  
  const inlineChatHostStyle: React.CSSProperties = {
    flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
    


  };

  







  const splashVisible = !splashMinDone || !uiReady;

  
  const splashSteps: SplashStep[] = [
    { label: "本地后端服务", done: boot?.backendReady === true || boot?.phase === "degraded" },
    { label: "Agent 与会话列表", done: Boolean(firstLoad.agents && firstLoad.sessions) },
    { label: "模型与供应商配置", done: Boolean(firstLoad.providers && firstLoad.localModels) },
    
    
    
    { label: "会话内容", done: Boolean(firstLoad.chatHistory) },
  ];
  
  const splashStatus = boot?.phase === "degraded"
    ? (boot.message ?? "后端不可用，正在加载界面…")
    : (!uiReady ? "正在加载首屏数据…" : (boot?.message ?? "正在初始化…"));

  return (
    <div className="app">
      {

}
      <SplashScreen visible={splashVisible} status={splashStatus} steps={splashSteps} subtitle={`v${appVersion}`} />

      {
}
      <ThemeDialogHost />

      {/* A-1198：扩展皮肤宿主（渲染 null）——把插件声明的设计令牌落到全局 CSS 变量；
          停用/卸载即自动回落默认（「可开可关、卸下即恢复」的落点）。 */}
      <PluginThemeHost />
      {/* A-1198 · 续：扩展 CSS 外观（@layer slime-plugin + .slime-plugin-scope；不退出、不重载）。 */}
      <PluginCssHost />

      {
}
      <OperationFocusOverlay />

      {}
      {modelLoading.loading && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(2, 6, 23, 0.66)", backdropFilter: "blur(2px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {
}
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
            {}
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

      {}
      <header className="titlebar">
        <button className="titlebar-btn" onClick={toggleLeftSidebar}
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}>
          <MenuIcon size={16} />
        </button>
        <span className="titlebar-title">Slime</span>
        <span style={{ flex: 1 }} />
        {}
        <button className={`titlebar-btn${rightOpen ? " titlebar-btn-active" : ""}`}
          onClick={() => animateRightSidebar(!rightOpen)}
          title={rightOpen ? "收起右侧栏" : "展开右侧栏（工作树 / 任务 / 终端 / 浏览器）"}>
          {rightOpen ? <SidebarLeftIcon size={16} /> : <SidebarRightIcon size={16} />}
        </button>
      </header>

      <div className="body">
        {
}
        <aside
          




          ref={attachLeftWidthObserver}
          className={`sidebar${sidebarOpen ? "" : " collapsed"}${leftMin0 ? " sidebar-no-min" : ""}`}
          

          


















          style={{ width: sidebarCustom ? sidebarWidth : undefined, flexShrink: 0, minWidth: sidebarOpen ? SIDEBAR_MIN_W : 0 }}
        >
          {

}
          {sidebarOpen && (
            <div className="sidebar-resizer" onPointerDown={handleSidebarResize}
              onMouseMove={trackResizerGlint} onMouseLeave={clearResizerGlint} />
          )}
          <div className="brand">
            {



}
            <img className="brand-icon" src={appIconUrl} alt="slime" draggable={false} />
            <span className="brand-name">slime</span>
          </div>
          <div className="sidebar-sep" />

          {}
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
                  {}
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
                            {}
                        <img
                          src={s.type === "brainstorm" ? teamSvg : currentSessionSvg}
                          alt=""
                          style={{
                            width: 14, height: 14, flexShrink: 0, borderRadius: 3,
                            opacity: active ? 1 : 0.72,
                          }}
                        />
                        {}
                            <span style={{
                              fontSize: 10, fontWeight: 700, flexShrink: 0,
                              padding: "1px 6px", borderRadius: 8,
                              background: s.type === "brainstorm" ? "var(--bg-hover)" : "var(--accent-soft)",
                              color: s.type === "brainstorm" ? "var(--text-secondary)" : "var(--accent-hover)",
                              maxWidth: 64, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }} title={s.type === "brainstorm" ? "群聊（你收束讨论）" : s.agentName}>
                              {s.type === "brainstorm" ? "群聊" : s.agentName}
                            </span>
                            {}
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

          {}
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

        {

}
        {






















}
        <main className={`main${mainIsFloatLayout ? " main-float" : ""}`}>
          <div
            




            ref={(el) => {
              chatHostRef.current = el;
              floatRef.current = el;
              inlineChatRef.current = el;
            }}
            





            className={hostIsFloat ? "float-window" : "inline-chat-host"}
            
















            style={hostIsFloat ? floatBoxStyle : inlineChatHostStyle}
          >
            {







}
            <div ref={floatInnerRef} style={{
              flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
              opacity: floatMinIcon ? 0 : 1,
              pointerEvents: floatMinIcon ? "none" : "auto",
            }}>
            {}
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
              {

}
              <div onMouseDown={(e) => startFloatResize(e, "e")} title="拖动调整宽度"
                style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 4, cursor: "ew-resize", zIndex: 200, userSelect: "none", display: mainIsFloatLayout ? "block" : "none" }} />
              <div onMouseDown={(e) => startFloatResize(e, "s")} title="拖动调整高度"
                style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, cursor: "ns-resize", zIndex: 200, userSelect: "none", display: mainIsFloatLayout ? "block" : "none" }} />
              <div onMouseDown={(e) => startFloatResize(e, "se")} title="拖动调整大小"
                style={{ position: "absolute", right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize", zIndex: 201, userSelect: "none", display: mainIsFloatLayout ? "block" : "none" }} />
            </div>
            </div>
            {}
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



        {




}
        {
}
        <div
          ref={rightWrapperRef}
          
































          className={`right-wrapper${rightMin0 ? " right-wrapper-no-min" : ""}${rightMin0 ? " right-wrapper-anim" : ""}${rightExitAnim ? " right-wrapper-exit" : ""}`}
          













          

















          style={{ display: "flex", flexShrink: 1, minWidth: 0, marginLeft: "auto", alignSelf: "stretch",
            











































            width: (mainIsFloatLayout && !rightMin0) ? "calc(100% - var(--left-w, 0px))"
              






















              : (mainIsFloatLayout ? (rightExitAnim ? "var(--right-target-w)" : undefined) : "auto") }}
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
          


          floatLayout={mainIsFloatLayout}
        />
        </div>
      </div>

      {}
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

      {}
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

  








  async function apiSetSessionModel(sessionId: string, modelChoice: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.conversations?.setModelChoice) { return; }
    try {
      await api.conversations.setModelChoice(sessionId, modelChoice);
    } catch (e) {
      console.error("[slime] 会话模型落盘失败:", e);
      await loadSessions(); 
    }
  }

  
  async function apiUpdateSessionTitle(sessionId: string, title: string): Promise<void> {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (api) {
      await api.conversations.rename(sessionId, title).catch(console.error);
      await loadSessions();
    }
  }

  





  













  function beginChatGeomFade(): void {
    cancelChatDip(); 
    chatGeomAnimRef.current = true;
    window.clearTimeout(chatGeomTimerRef.current);
    chatGeomTimerRef.current = window.setTimeout(() => {
      chatGeomTimerRef.current = 0;
      chatGeomAnimRef.current = false;
    }, SIDEBAR_WIDTH_MS + CHAT_GEOM_TAIL_MS);
  }

  function cancelChatDip(): void {
    window.clearTimeout(chatDipInTimerRef.current);
    chatDipInTimerRef.current = 0;
    window.clearTimeout(chatDipEndTimerRef.current);
    chatDipEndTimerRef.current = 0;
    window.clearTimeout(chatGeomTimerRef.current);
    chatGeomTimerRef.current = 0;
    chatDipActiveRef.current = false;
    chatGeomAnimRef.current = false;
    



  }

  function startChatDip(): void {
    


    if (chatDipActiveRef.current) { return; }
    chatDipActiveRef.current = true;
    


    window.clearTimeout(dragPhaseTimerRef.current);
    dragPhaseTimerRef.current = 0;
    window.clearTimeout(chatSettleTimerRef.current);
    chatSettleTimerRef.current = 0;
    window.clearTimeout(chatFreezeFallbackRef.current);
    chatFreezeFallbackRef.current = 0;
    

    document.body.style.setProperty("--chat-fade-out-dur", `${CHAT_DIP_OUT_MS}ms`);
    document.body.style.setProperty("--chat-fade-in-dur", `${CHAT_DIP_IN_MS}ms`);
    document.body.classList.add("slime-fading");
    window.clearTimeout(chatDipInTimerRef.current);
    window.clearTimeout(chatDipEndTimerRef.current);
    


    chatDipInTimerRef.current = window.setTimeout(() => {
      chatDipInTimerRef.current = 0;
      document.body.classList.remove("slime-fading");
    }, CHAT_DIP_IN_AT_MS);
    

    chatDipEndTimerRef.current = window.setTimeout(() => {
      chatDipEndTimerRef.current = 0;
      chatDipActiveRef.current = false;
    }, SIDEBAR_WIDTH_MS);
  }

  





  







  function endChatFreeze(): void {
    document.body.classList.remove("slime-resizing");
    
    document.body.classList.remove("slime-dragging");
    


    window.clearTimeout(dragPhaseTimerRef.current);
    dragPhaseTimerRef.current = 0;
    
    window.clearTimeout(chatSettleTimerRef.current);
    chatSettleTimerRef.current = 0;
    requestAnimationFrame(() => {
      document.body.classList.remove("slime-fading");
    });
    
    window.clearTimeout(chatFreezeFallbackRef.current);
    chatFreezeFallbackRef.current = window.setTimeout(() => {
      document.body.classList.remove("slime-fading");
    }, 200);
    






    cancelChatDip();
  }

  function handleSidebarResize(e: React.PointerEvent): void {
    e.preventDefault();
    setSidebarCustom(true); 
    


    leftDraggingRef.current = true;
    







    document.body.classList.add("slime-dragging");
    




    cancelChatDip();
    const captureEl = e.currentTarget as HTMLElement;
    try { captureEl.setPointerCapture(e.pointerId); } catch {  }
    











    const startX = e.clientX;
    


    const asideEl = leftSidebarRef.current;
    




    if (asideEl) { asideEl.style.removeProperty("opacity"); }
    const startWidth = asideEl ? asideEl.getBoundingClientRect().width : sidebarWidthRef.current;
    let lastW = startWidth;
    












    const onMove = (ev: PointerEvent): void => {
      
      lastW = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, ev.clientX - startX + startWidth));
      if (asideEl) { asideEl.style.width = `${lastW}px`; }
      










      if (floatStateRef.current !== "none") {
        rightWrapperRef.current?.style.setProperty("--left-w", `${lastW}px`);
      }
    };
    const onUp = (): void => {
      leftDraggingRef.current = false; 
      endChatFreeze();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      try { captureEl.releasePointerCapture(e.pointerId); } catch {  }
      
      
      
      if (lastW <= SIDEBAR_MIN_W + SIDEBAR_SNAP_W) {
        
        if (asideEl) { asideEl.style.width = ""; }
        
        
        
        const fallback = Math.round(window.innerWidth * SIDEBAR_RATIO.left);
        const restoreW = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W,
          startWidth > SIDEBAR_MIN_W + SIDEBAR_SNAP_W ? startWidth : fallback)));
        setSidebarWidth(restoreW);
        localStorage.setItem('slime_sidebar_w', String(restoreW));
        
        animateLeftSidebar(false);
        return;
      }
      const w = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, lastW)));
      








      if (asideEl) { asideEl.style.width = `${w}px`; }
      if (floatStateRef.current !== "none") {
        rightWrapperRef.current?.style.setProperty("--left-w", `${w}px`);
      }
      setSidebarWidth(w);
      localStorage.setItem('slime_sidebar_w', String(w));
    };
    const onCancel = (): void => {
      leftDraggingRef.current = false; 
      endChatFreeze();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      
      




      const wCancel = Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, lastW)));
      if (asideEl) { asideEl.style.width = `${wCancel}px`; }
      if (floatStateRef.current !== "none") {
        rightWrapperRef.current?.style.setProperty("--left-w", `${wCancel}px`);
      }
      setSidebarWidth(Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, lastW))));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    
    window.addEventListener('blur', onCancel);
  }

  function handleRightbarResize(e: React.PointerEvent): void {
    e.preventDefault();
    setRightCustom(true); 
    

    document.body.classList.add("slime-dragging");
    cancelChatDip(); 
    const captureEl = e.currentTarget as HTMLElement;
    
    
    try { captureEl.setPointerCapture(e.pointerId); } catch {  }
    






    const startX = e.clientX;
    











    const asideEl = document.querySelector<HTMLElement>(".right-sidebar");
    const startWidth = asideEl ? asideEl.getBoundingClientRect().width : rightWidthRef.current;
    



    if (asideEl) { asideEl.style.removeProperty("opacity"); }
    let lastW = startWidth;
    
    
    
    
    
    
    
    
    const maxW = rightSidebarMaxW();
    
    
    
    
    const minW = rightSidebarMinW();
    const onMove = (ev: PointerEvent): void => {
      
      



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
      try { captureEl.releasePointerCapture(e.pointerId); } catch {  }
      
      if (lastW === startWidth) { return; }
      
      
      if (lastW <= minW + SIDEBAR_SNAP_W) {
        
        
        
        
        if (asideEl) { asideEl.style.width = ""; }
        
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
      
      setRightWidth(w);
    };
    const onCancel = (): void => {
      endChatFreeze();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      
      
      if (asideEl) { asideEl.style.width = ""; }
      setRightWidth(Math.round(Math.max(minW, Math.min(maxW, lastW))));
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    
    window.addEventListener("blur", onCancel);
  }

  






  function animateLeftSidebar(nextOpen: boolean): void {
    leftFadeCancelRef.current?.();
    leftFadeCancelRef.current = null;
    





    beginChatGeomFade();
    const el = leftSidebarRef.current;
    
    if (nextOpen && el) {
      el.style.opacity = "0";
      
      
      setLeftMin0(true);
    }
    setSidebarOpen(nextOpen);
    leftFadeCancelRef.current = runGeometrySyncFade(
      () => leftSidebarRef.current,
      (p, done) => {
        if (done) { setLeftMin0(false); }
        const node = leftSidebarRef.current;
        if (!node) { return; }
        
















        if (done) {
          if (nextOpen) { node.style.removeProperty("opacity"); } else { node.style.opacity = "0"; }
        } else {
          node.style.opacity = String(nextOpen ? p : 1 - p);
        }
        







        if (floatStateRef.current !== "none") {
          










          rightWrapperRef.current?.style.setProperty("--left-w", `${Math.round(sidebarOpenRef.current ? sidebarWidthRef.current : 0)}px`);
        }
      },
      
      
      









      nextOpen
        ? { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_LO, hiRatio: LEFT_FADE_HI, duration: SIDEBAR_WIDTH_MS }
        : { min: 0, full: sidebarWidthRef.current, loRatio: LEFT_FADE_COLLAPSE_LO, hiRatio: LEFT_FADE_COLLAPSE_HI, duration: SIDEBAR_WIDTH_MS },
    );
  }

  function toggleLeftSidebar(): void {
    animateLeftSidebar(!sidebarOpen);
  }

  

















  








  function rightSidebarMaxW(): number {
    const leftEl = leftSidebarRef.current;
    const leftW = leftEl ? leftEl.getBoundingClientRect().width : 0;
    const floatActive = floatStateRef.current !== "none";
    return Math.max(360, floatActive
      
      ? window.innerWidth
      : Math.min(window.innerWidth - 48, window.innerWidth - leftW - CHAT_MIN_W));
  }

  










  function setRightWebviewPin(px: number | null): void {
    const el = rightWrapperRef.current;
    if (!el) { return; }
    
    
    const hasGuest = px !== null && !!document.querySelector(".right-sidebar webview");
    if (px === null || !(px > 1) || !hasGuest) {
      el.classList.remove("right-wrapper-pin");
      el.style.removeProperty("--right-pin-w");
      return;
    }
    el.style.setProperty("--right-pin-w", `${Math.round(px)}px`);
    el.classList.add("right-wrapper-pin");
  }

  










  function animateRightSidebar(nextOpen: boolean, nextWidth?: number, isFloat?: boolean): void {
    rightFadeCancelRef.current?.();
    rightFadeCancelRef.current = null;
    



    beginChatGeomFade();
    










    setRightMin0(false);
    const rwReset = rightWrapperRef.current;
    if (rwReset) {
      rwReset.style.removeProperty("--right-body-pin");
      rwReset.style.removeProperty("--right-target-w");
      


      if (!isFloat) { rwReset.style.removeProperty("--left-w"); }
    }
    
    setRightWebviewPin(null);
    const el = rightWrapperRef.current;
    
    
    
    
    const pinTarget = nextOpen
      ? Math.min(nextWidth ?? rightWidth, rightSidebarMaxW())
      : (document.querySelector<HTMLElement>(".right-sidebar")?.getBoundingClientRect().width ?? 0);
    if (pinTarget > 1) { setRightWebviewPin(pinTarget); }
    if (nextOpen) {
      







      







      const isFloatExpand = isFloat !== undefined
        ? isFloat
        : (nextWidth !== undefined && nextWidth > window.innerWidth * 0.8);
      if (nextWidth !== undefined && !isFloatExpand) { setRightWidth(nextWidth); }
      if (el && isFloatExpand) { el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`); }
      

























      const rsEnter = el?.querySelector<HTMLElement>(".right-sidebar") ?? null;
      if (rsEnter) { rsEnter.style.opacity = "0"; }
      
      
      
      setRightOpen(true);
      setRightMin0(true);
      




      










      if (isFloatExpand) {
        document.body.classList.add("float-layout");
      } else {
        document.body.classList.remove("float-layout");
      }
      


      if (el) {
        








        const targetW = isFloatExpand
          ? (nextWidth ?? rightWidth)
          : Math.min(nextWidth ?? rightWidth, rightSidebarMaxW());
        el.style.setProperty("--right-body-pin", `${Math.round(Math.min(RIGHT_CONTENT_MAX_W, targetW))}px`);
      }
      rightFadeCancelRef.current = runGeometrySyncFade(
        








        () => rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null,
        (p, done) => {
          if (done) {
            setRightMin0(false);
            setRightWebviewPin(null);
            













          }
          







          const node = rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null;
          if (!node) { return; }
          if (done) {
            


            if (nextOpen) { node.style.removeProperty("opacity"); } else { node.style.opacity = "0"; }
          } else {
            

            node.style.opacity = String(nextOpen ? p : 1 - p);
          }
        },
        











        nextOpen
          ? { min: 0, full: nextWidth ?? rightWidth, loRatio: LEFT_FADE_LO, hiRatio: LEFT_FADE_HI }
          : { min: 0, full: rightWidth, loRatio: LEFT_FADE_COLLAPSE_LO, hiRatio: LEFT_FADE_COLLAPSE_HI },
      );
    } else {
      
      
      dismissFloat();
      setRightOpen(false);
      
















      setRightMin0(false);
      const rwEl0 = rightWrapperRef.current;
      if (rwEl0) {
        rwEl0.style.removeProperty("--right-body-pin");
        rwEl0.style.removeProperty("--right-target-w");
      }
      rightFadeCancelRef.current = runGeometrySyncFade(
        
        () => rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null,
        (p, done) => {
          if (done) {
            setRightWebviewPin(null);
            




          }
          





          const node = rightWrapperRef.current?.querySelector<HTMLElement>(".right-sidebar") ?? null;
          if (!node) { return; }
          if (done) {
            if (nextOpen) { node.style.removeProperty("opacity"); } else { node.style.opacity = "0"; }
          } else {
            node.style.opacity = String(nextOpen ? p : 1 - p);
          }
        },
        

        { min: 0, full: rightWidth, loRatio: LEFT_FADE_COLLAPSE_LO, hiRatio: LEFT_FADE_COLLAPSE_HI },
      );
    }
  }

  




  function handleToggleFloat(): void {
    if (floatStateRef.current === "min") { restoreFloat(); return; }
    if (floatStateRef.current === "float") { dismissFloat(); return; }
    








    






    if (!rightOpen) { setRightOpen(true); }
    


    setRightExitAnim(false);
    






    {
      const fiEnter = floatInnerRef.current;
      if (fiEnter) { fiEnter.style.opacity = ""; }
    }
    













    
    
    












    const leftWNow = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
    const floatTargetW = Math.max(560, Math.round(window.innerWidth - leftWNow));
    





    const rwFloat = rightWrapperRef.current;
    if (rwFloat) { rwFloat.style.setProperty("--left-w", `${Math.round(leftWNow)}px`); }
    






    animateRightSidebar(true, floatTargetW, true);
    












    




















    const hostEnter = chatHostRef.current;
    if (hostEnter) { hostEnter.style.visibility = "hidden"; }
    













    const mainEnter = document.querySelector<HTMLElement>(".main");
    if (mainEnter) { mainEnter.style.visibility = "hidden"; }
    React.startTransition(() => {
      setFloatState("float");
    });
    window.setTimeout(() => {
      const n = chatHostRef.current;
      if (n && n.style.visibility === "hidden") { n.style.visibility = ""; }
      const m = document.querySelector<HTMLElement>(".main");
      if (m && m.style.visibility === "hidden") { m.style.visibility = ""; }
    }, 32);
  }

  













  function dismissFloat(): void {
    if (floatStateRef.current === "none" || floatClosingRef.current) { return; }
    floatClosingRef.current = true;
    const el = floatRef.current;
    if (el) {
      
      




      const isIcon = el.offsetWidth <= FLOAT_ICON_SIZE + 2;
      const cx = isIcon ? el.offsetLeft : Math.round(el.offsetLeft + el.offsetWidth / 2);
      const cy = isIcon ? el.offsetTop : Math.round(el.offsetTop + el.offsetHeight / 2);
      el.style.transition = FLOAT_TRANSITION_FULL;
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
    }
    setFloatAnim("closing");
    























    setRightMin0(false);
    










    







    const rwExitPre = rightWrapperRef.current;
    const rsExit = rwExitPre?.querySelector(".right-sidebar") ?? null;
    






    if (rsExit instanceof HTMLElement) { rsExit.style.width = ""; }
    setRightExitAnim(true);
    const rwExit = rwExitPre;
    if (rwExit) {
      rwExit.style.removeProperty("--right-body-pin");
      rwExit.style.removeProperty("--right-target-w");
      


      rwExit.style.removeProperty("--left-w");
      






      const rsExitDup = rwExit.querySelector(".right-sidebar");
      

      if (rsExitDup instanceof HTMLElement) { rsExitDup.style.width = ""; }
    }
    
    startFloatGeometryFade(0, (genOk) => {
      





      setFloatAnim("idle");
      
      if (!floatClosingRef.current || !genOk) { return; }
      














      const hostExit = chatHostRef.current;
      if (hostExit) { hostExit.style.opacity = "0"; }
      floatClosingRef.current = false;
      setFloatState("none");
      


      setRightMin0(false);
      



      setRightExitAnim(false);
      









      const fiExit = floatInnerRef.current;
      if (fiExit) { fiExit.style.opacity = ""; }
      


      const rsDone = rightWrapperRef.current?.querySelector(".right-sidebar");
      if (rsDone instanceof HTMLElement) { rsDone.style.width = ""; }
      rightWrapperRef.current?.style.removeProperty("--right-body-pin");
      rightWrapperRef.current?.style.removeProperty("--right-target-w");
      rightWrapperRef.current?.style.removeProperty("--left-w");
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; }
      



      
      
      const leftW = leftSidebarRef.current?.getBoundingClientRect().width ?? 0;
      const targetRight = rightWidthRef.current;
      const mainW = Math.max(CHAT_MIN_W, window.innerWidth - leftW - targetRight);
      
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => startInlineChatRevealFade(mainW)));
    });
  }

  








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

  







  function startFloatDrag(e: React.PointerEvent<HTMLDivElement>, onTap?: () => void): void {
    if (e.button !== 0) { return; }
    if ((e.target as HTMLElement).closest?.("button")) { return; } 
    floatDragMovedRef.current = false;
    e.preventDefault();
    const el = floatRef.current;
    if (!el) { return; }
    const pid = e.pointerId;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = el.offsetLeft, startTop = el.offsetTop;
    
    const prevTransition = el.style.transition;
    el.style.transition = "none";
    el.style.willChange = "left, top";
    try { el.setPointerCapture(pid); } catch {  }
    const onMove = (ev: PointerEvent): void => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
        floatDragMovedRef.current = true;
      }
      
      const p = clampFloatPos(startLeft + ev.clientX - startX, startTop + ev.clientY - startY);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    };
    
    const finish = (tap: boolean): void => {
      try { el.releasePointerCapture(pid); } catch {  }
      el.style.transition = prevTransition || FLOAT_TRANSITION;
      el.style.willChange = "";
      const landed = clampFloatPos(el.offsetLeft, el.offsetTop);
      setFloatPos(landed);
      
      
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

  


  function minimizeFloat(): void {
    floatClosingRef.current = false; 
    const el = floatRef.current;
    if (el) {
      
      
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
      el.style.transition = FLOAT_TRANSITION_FULL; 
      el.style.left = `${fitted.x}px`;
      el.style.top = `${fitted.y}px`;
      setFloatPos(fitted);
    }
    
    setFloatAnim("out");
    
    
    
    startFloatGeometryFade(FLOAT_ICON_SIZE, (genOk) => {
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; } 
      
      setFloatAnim("idle");
      if (!genOk) { return; }
      setFloatState("min");
    });
  }

  

  function restoreFloat(): void {
    floatClosingRef.current = false; 
    const el = floatRef.current;
    const targetW = floatSizeRef.current.w;
    const targetH = floatSizeRef.current.h;
    if (el) {
      const fitted = fitFloatRect(el.offsetLeft, el.offsetTop, targetW, targetH);
      if (fitted.x !== el.offsetLeft || fitted.y !== el.offsetTop) {
        
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
    
    
    
    const fi = floatInnerRef.current;
    if (fi) { fi.style.opacity = "0"; }
    
    
    
    startFloatGeometryFade(FLOAT_ICON_SIZE, (genOk) => {
      
      setFloatAnim("idle");
      if (!genOk) { return; }
      const e2 = floatRef.current;
      if (e2) { e2.style.transition = FLOAT_TRANSITION; }
    });
  }

  










  function startFloatGeometryFade(minW: number = FLOAT_ICON_SIZE, onDone?: (genOk: boolean) => void): void {
    floatFadeCancelRef.current?.();
    floatFadeCancelRef.current = null;
    

    const gen = ++floatFadeGenRef.current;
    






    document.body.classList.remove("slime-freezing");
    document.body.style.removeProperty("--slime-freeze-w");
    







    document.body.classList.add("slime-freezing");
    







    {
      


      const targetW = Math.round(floatSizeRef.current.w);
      if (targetW > 1) { document.body.style.setProperty("--slime-freeze-w", `${targetW}px`); }
    }
    
    
    floatFadeCancelRef.current = runGeometrySyncFade(
      () => floatRef.current,
      (p, done) => {
        const node = floatInnerRef.current;
        if (node) {
          
          
          
          node.style.opacity = String(done ? (p < 0.5 ? 0 : 1) : p);
        }
        if (done) {
          





          document.body.classList.remove("slime-freezing");
          




          document.body.style.removeProperty("--slime-freeze-w");
          


          onDone?.(gen === floatFadeGenRef.current);
        }
      },
      






      { min: minW, full: floatSizeRef.current.w, duration: FLOAT_TRANSITION_MS },
    );
  }

  







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
      el.style.transition = "none"; 
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
      el.style.transition = FLOAT_TRANSITION; 
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
