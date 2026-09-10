import React, { type JSX, type CSSProperties } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DownloadProgressInfo, WorkspaceEntry, WorkspaceReadFileResult, CtxBuckets, GitDiffFile,
} from "../../shared/ipc.js";
import {
  ChevronIcon, SidebarLeftIcon, TaskIcon, GlobeIcon,
  GitIcon, PlusIcon, TodoListIcon, DashboardIcon,
  CheckboxIcon, CheckboxCheckedIcon, CirclePlusIcon, LoadingCircleIcon,
  TerminalIcon, FolderIcon, ArrowLeftIcon, ArrowRightIcon2,
  CloseIcon, RefreshIcon, CheckIcon, RepeatIcon, PaperclipIcon, EditIcon,
} from "../components/Icon.js";
import { alertAsync, confirmAsync } from "../dialog.js";
import { SIDEBAR_OPEN_EVENT, requestSidebarOpen, type SidebarOpenPayload } from "./Markdown.js";
import { readSessionCtxMeta, restoreUsed } from "./sessionCtxMeta.js";
import { contextRatio, contextPct, ringLevel, composeSegments, bucketsSegments } from "./contextMath.js";
import BrainstormPanel from "./BrainstormPanel.js";
import { onCtxUpdate } from "./ChatPanel.js";
import { IDLE_PHRASES } from "../idlePhrases.js";

type TabType = "tasks" | "subagents" | "terminal" | "browser" | "git" | "file";

/** A-968：图片预览用真实 MIME（data:image/* 通配 MIME 在 Chromium 下不渲染，导致右栏看不了图） */
const IMG_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
};
function imageDataUrl(name: string, base64: string): string {
  const ext = (name.split(/[\\/]/).pop() ?? "").toLowerCase().split(".").pop();
  const mime = ext ? IMG_MIME[`.${ext}`] ?? "image/png" : "image/png";
  return `data:${mime};base64,${base64}`;
}

interface TabInstance {
  id: string;
  type: TabType;
  title: string;
  url?: string;
  fileRel?: string;
  /** A-173：绝对路径（聊天消息内打开的文件） */
  fileAbs?: string;
  fileContent?: string;
  fileMime?: "text" | "image" | "binary";
  fileError?: string;
  /** A-918++：默认页标记——任务页（tasks）设为默认页不可删除（类似群聊专属页常驻），
      其他页（浏览器/文件/Git/终端等）可删到 0，无需"至少保留1个"限制 */
  isDefault?: boolean;
}

interface TabTypeMeta {
  type: TabType;
  label: string;
  icon: (p: { size?: number }) => JSX.Element;
}

const TAB_TYPE_META: TabTypeMeta[] = [
  { type: "tasks", label: "任务", icon: TaskIcon },
  { type: "subagents", label: "子代理", icon: AgentIcon },
  { type: "terminal", label: "终端", icon: TerminalIcon },
  { type: "browser", label: "浏览器", icon: GlobeIcon },
  { type: "git", label: "Git仓库", icon: GitIcon },
  { type: "file", label: "文件查看", icon: FileIcon },
];

function AgentIcon(props: { size?: number; style?: React.CSSProperties }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 14} height={props.size ?? 14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" style={props.style ?? { display: "inline-block", flexShrink: 0 }}>
      <circle cx="12" cy="9" r="4" />
      <path d="M4 20c1.6-3.2 4.4-4.8 8-4.8s6.4 1.6 8 4.8" />
      <circle cx="18" cy="5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FileIcon(props: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" width={props.size} height={props.size} fill="currentColor" style={{ display: "inline-block", flexShrink: 0 }}>
      <path d="M768 128H320L192 256v640a64 64 0 0064 64h512a64 64 0 0064-64V192a64 64 0 00-64-64zm-416 64h224v128H352V192zM768 896H256V320h160v192h352v384z" />
    </svg>
  );
}

const uid = (): string => Math.random().toString(36).slice(2, 10);

const createTab = (type: TabType, index?: number): TabInstance => {
  const meta = TAB_TYPE_META.find((m) => m.type === type)!;
  const title = index !== undefined ? `${meta.label} ${index + 1}` : meta.label;
  // A-918++：任务页（tasks）设为默认页——常驻 mount 不可删除，类似群聊专属页
  return { id: uid(), type, title, url: type === "browser" ? "" : undefined, isDefault: type === "tasks" };
};

const createFileTab = (_root: string, rel: string, name: string): TabInstance => ({
  id: uid(),
  type: "file",
  title: name,
  fileRel: rel,
});

/* ── 任务事件 ── */
interface TaskEvent {
  id: number;
  time: string;
  kind: "tool" | "thinking" | "progress" | "done" | "error";
  label: string;
}

/* ── webview 标签 ── */
const WebviewTag = React.forwardRef<HTMLElement, { src: string; style: CSSProperties }>((props, ref) =>
  React.createElement("webview", { ...props, ref }),
);
WebviewTag.displayName = "WebviewTag";

/* ── 终端行 ── */
interface TermLine {
  kind: "cmd" | "out" | "err" | "info";
  text: string;
}

/* ── Git 数据类型 ── */
interface GitCommit {
  hash: string;
  message: string;
  time: string;
}

interface GitStatus {
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
}

/** 文件行状态字（VS Code 范式：绿=新增、蓝=修改、红=删除、黄=未跟踪、灰=未知） */
const STATUS_GLYPH: Record<string, { label: string; color: string }> = {
  M: { label: "M", color: "var(--diff-mod, #58a6ff)" },
  A: { label: "A", color: "var(--diff-add, #7ee787)" },
  D: { label: "D", color: "var(--diff-del, #f85149)" },
  R: { label: "R", color: "var(--diff-mod, #58a6ff)" },
  U: { label: "U", color: "#d29922" },
  "?": { label: "?", color: "#8b949e" },
};

/* ═══════════════ 主组件 ═══════════════ */

export default function RightSidebar(props: {
  open: boolean;

  /** 运行时已探测的上游模型元数据（App 透传嵌套结构，含 context_window）——右栏上下文上限兜底用 */
  providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>;
  onToggle: () => void;
  agentId: string | null;
  agentName: string;
  sessionId?: string;
  workspace: string;
  dl: Record<string, DownloadProgressInfo>;
  width?: number;
  onResize?: (e: React.MouseEvent) => void;
  /** A-949：群聊（brainstorm）默认不新建「任务」页——配套侧页另行设计；仍可手动新建文件/终端等页 */
  sessionType?: "normal" | "brainstorm";
  /** A-954：群聊成员 id 列表（含组长=agentId；BrainstormPanel 建群即预填成员卡） */
  memberIds?: string[];
  /** A-954：成员入群模型（memberId → model 串）与组长入群模型 */
  memberModels?: Record<string, string>;
  leaderModel?: string;
}): JSX.Element {
  // 群聊下初始 tabs 为空（任务页不默认建）；普通会话初始仍默认「任务」
  const [tabs, setTabs] = React.useState<TabInstance[]>(() =>
    props.sessionType === "brainstorm" ? [] : [createTab("tasks")],
  );
  const [activeId, setActiveId] = React.useState<string | undefined>(() =>
    props.sessionType === "brainstorm" ? undefined : "tasks",
  );
  // A-920：每会话一套「完全独立」的右侧边栏——切换会话时把 tabs（已打开的浏览器/文件/Git 页）+ 活动页
  // 快照进 per-session 槽位，切回时原样还原；配合任务区按 sessionId 隔离（A-919），多会话绝不串联
  const sidebarSnapRef = React.useRef<Record<string, { tabs: TabInstance[]; activeId?: string }>>({});
  const prevSidRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const sid = props.sessionId ?? "";
    if (prevSidRef.current !== null && prevSidRef.current !== sid) {
      sidebarSnapRef.current[prevSidRef.current] = { tabs: [...tabs], activeId };
    }
    if (sid) {
      const snap = sidebarSnapRef.current[sid];
      if (snap) {
        setTabs(snap.tabs);
        setActiveId(snap.activeId);
      } else if (prevSidRef.current !== sid) {
        // A-952：新建会话无快照 → 按会话类型给默认页（群聊=tabs 空 → BrainstormPanel；
        // 普通=[任务]），否则会残留上一个会话的 tabs（群聊新会话显示成任务默认页）
        const fresh = props.sessionType === "brainstorm" ? [] : [createTab("tasks")];
        setTabs(fresh);
        setActiveId(props.sessionType === "brainstorm" ? undefined : "tasks");
      }
    }
    prevSidRef.current = sid || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const workspaceRef = React.useRef(props.workspace);
  workspaceRef.current = props.workspace;

  /* ── 拖拽重排状态 ── */
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const addTab = (type: TabType): void => {
    const sameTypeCount = tabs.filter((t) => t.type === type).length;
    const tab = createTab(type, sameTypeCount);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setMenuOpen(false);
  };

  const openFileTab = (rel: string, name: string): void => {
    const root = workspaceRef.current?.trim() || "";
    if (!root) { return; }
    const tab = createFileTab(root, rel, name);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void api?.workspace?.readFile(root, rel).then((res: WorkspaceReadFileResult) => {
      if (!res?.ok || !res.content) {
        updateTab(tab.id, { fileError: res?.error ?? "读取失败" });
        return;
      }
      updateTab(tab.id, { fileContent: res.content, fileMime: res.mime });
    }).catch((e: unknown) => {
      updateTab(tab.id, { fileError: e instanceof Error ? e.message : String(e) });
    });
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  /** A-173：按绝对路径打开文件到新标签页（聊天消息内点击文件链接） */
  const openFileAbs = (abs: string, name?: string): void => {
    const clean = (abs ?? "").trim().replace(/^["']|["']$/g, "");
    if (!clean) { return; }
    const fname = (name ?? clean.split(/[\\/]/).pop() ?? clean).trim();
    const tab: TabInstance = {
      id: uid(), type: "file", title: fname,
      fileRel: clean, fileAbs: clean,
    };
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void api?.workspace?.readFileAbs?.(clean).then((res: WorkspaceReadFileResult) => {
      if (!res?.ok || !res.content) {
        updateTab(tab.id, { fileError: res?.error ?? "读取失败" });
        return;
      }
      updateTab(tab.id, { fileContent: res.content, fileMime: res.mime });
    }).catch((e: unknown) => {
      updateTab(tab.id, { fileError: e instanceof Error ? e.message : String(e) });
    });
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  /** A-173：监听聊天消息里的「在右侧栏打开」事件（文件/网址） */
  React.useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<SidebarOpenPayload>).detail;
      if (!d) { return; }
      if (d.kind === "file" && d.rel) {
        openFileAbs(d.rel, d.name);
      } else if (d.kind === "url" && d.url) {
        // 在原浏览器标签直接改址；若还没有浏览器标签则新建一个
        const existing = tabs.find((t) => t.type === "browser");
        if (existing) {
          updateTab(existing.id, { url: d.url, title: d.name ?? d.url });
          setActiveId(existing.id);
        } else {
          const tab = createTab("browser");
          setTabs((prev) => [...prev, { ...tab, url: d.url, title: d.name ?? tab.title }]);
          setActiveId(tab.id);
        }
      }
    };
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  /** A-918++：订阅主进程「HTTP 生成的网页应用在侧边栏浏览器打开」事件（slime:sidebar:open），
      复用 SIDEBAR_OPEN_EVENT 已有逻辑把 URL 注入浏览器标签。Agent 工具 http_create_app 生成应用后触发。 */
  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: { onSidebarOpen?: (cb: (p: SidebarOpenPayload) => void) => () => void } };
    const off = w.slimeAPI?.onSidebarOpen?.((p) => {
      if (p && (p.kind === "url" || !p.kind) && p.url) {
        requestSidebarOpen({ kind: "url", url: p.url, name: p.name });
      }
    });
    return () => { off?.(); };
  }, []);

  const closeTab = (id: string): void => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === id);
      // A-918++：默认页（任务页 isDefault）不可删除；其他页可删到 0，去掉"至少保留1个"限制
      if (target?.isDefault) { return prev; }
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId && next.length > 0) {
        const nextActive = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveId(nextActive.id);
      }
      return next;
    });
  };

  const updateTab = (id: string, patch: Partial<TabInstance>): void => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  /* ─ 拖拽排序 ── */
  const handleDragStart = (id: string): void => {
    setDragId(id);
  };

  const handleDragOver = (e: React.DragEvent, id: string): void => {
    e.preventDefault();
    if (id !== dragId) {
      setDragOverId(id);
    }
  };

  const handleDrop = (targetId: string): void => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === dragId);
      const toIdx = prev.findIndex((t) => t.id === targetId);
      if (fromIdx < 0 || toIdx < 0) { return prev; }
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    setDragId(null);
    setDragOverId(null);
  };

  const handleDragEnd = (): void => {
    setDragId(null);
    setDragOverId(null);
  };

  return (
    <aside className={`right-sidebar${props.open ? "" : " collapsed"}`} style={{ width: props.width }}>
      {props.open && <div className="sidebar-resizer right-sidebar-resizer" onMouseDown={props.onResize} />}

      {/* ── 标签栏（可滚动 + 拖拽重排） ─ */}
      <div className="right-tabbar" style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", padding: "0 4px", background: "var(--sidebar-bg, #1e1e2e)" }}>
        <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden" }}>
          {tabs.map((tab) => {
            const meta = TAB_TYPE_META.find((m) => m.type === tab.type)!;
            const Icon = meta.icon;
            const isActive = tab.id === activeId;
            const isDragging = tab.id === dragId;
            const isDragOver = tab.id === dragOverId;
            return (
              <div
                key={tab.id}
                draggable
                onDragStart={() => handleDragStart(tab.id)}
                onDragOver={(e) => handleDragOver(e, tab.id)}
                onDrop={() => handleDrop(tab.id)}
                onDragEnd={handleDragEnd}
                className={`right-tab${isActive ? " active" : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 10px",
                  marginRight: 2,
                  borderRadius: "6px 6px 0 0",
                  background: isActive ? "var(--tab-active-bg, #2a2a3e)" : "var(--tab-inactive-bg, transparent)",
                  color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 12,
                  border: isActive ? "1px solid var(--border)" : "1px solid transparent",
                  borderBottom: isActive ? "none" : "none",
                  whiteSpace: "nowrap",
                  maxWidth: 160,
                  minWidth: 80,
                  flexShrink: 0,
                  transition: "background 0.15s, opacity 0.15s",
                  opacity: isDragging ? 0.4 : 1,
                  borderTop: isDragOver ? "2px solid var(--accent)" : "2px solid transparent",
                }}
                onClick={() => setActiveId(tab.id)}
                title={tab.fileRel || tab.title}
              >
                <Icon size={14} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: "1", minWidth: 0 }}>{tab.title}</span>
                {/* A-918++：默认页（任务页）显示「固定」徽标不可删；其他页可删到 0 */}
                {tab.isDefault ? (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", padding: "1px 6px", borderRadius: 5, background: "var(--bg-hover)", flexShrink: 0, fontWeight: 600 }}>固定</span>
                ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  title="关闭标签页"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 16, height: 16, borderRadius: 3, border: "none",
                    background: "transparent", color: "inherit",
                    cursor: "pointer",
                    opacity: 0.6,
                    fontSize: 12, lineHeight: 1, flexShrink: 0, padding: 0,
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <CloseIcon size={12} />
                </button>
                )}
              </div>
            );
          })}
          <button
            className="right-tab-add"
            title="新建标签页"
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, marginLeft: 2, borderRadius: 4,
              border: "none", background: "transparent",
              color: "var(--text-secondary)", cursor: "pointer", flexShrink: 0,
            }}
          >
            <PlusIcon size={14} />
          </button>
        </div>
        <button className="right-collapse" title="收起右侧栏" onClick={props.onToggle} style={{ flexShrink: 0 }}>
          <SidebarLeftIcon size={15} />
        </button>
      </div>

      {menuOpen && (
        <div
          ref={menuRef}
          style={{
            position: "absolute", zIndex: 9999,
            background: "var(--dropdown-bg, #252537)",
            border: "1px solid var(--border)", borderRadius: 6, padding: 4,
            minWidth: 140, boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {TAB_TYPE_META.map((m) => {
            const MIcon = m.icon;
            return (
              <button
                key={m.type}
                onClick={(e) => { e.stopPropagation(); addTab(m.type); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", padding: "6px 10px",
                  background: "transparent", border: "none", borderRadius: 4,
                  color: "var(--text-primary)", cursor: "pointer", fontSize: 13, textAlign: "left",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--hover-bg, rgba(255,255,255,0.08))"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <MIcon size={15} />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── 内容区 ── */}
      <div className="right-body" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {!activeTab && props.sessionType === "brainstorm" && (
          <BrainstormPanel
            sessionId={props.sessionId ?? ""}
            memberIds={props.memberIds ?? []}
            memberModels={props.memberModels ?? {}}
            leaderModel={props.leaderModel}
            leaderId={props.agentId ?? ""}
            providerModels={props.providerModels}
          />
        )}
        {!activeTab && props.sessionType !== "brainstorm" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
            <div style={{ fontSize: 26, opacity: 0.6 }}>🗩</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>右侧栏暂无打开的页面</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
              可用「新建」菜单打开任务、文件、终端、浏览器等页。
            </div>
          </div>
        )}
        {/* A-918++：任务页常驻 mount（display 控制显隐）——切换 tab 时 state 不丢，切回立即看到原数据；
            active=false 时轮询 useEffect 提前 return，不浪费资源 */}
        <div style={{ display: activeTab?.type === "tasks" ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <TasksTab active={activeTab?.type === "tasks"} agentId={props.agentId ?? ""} sessionId={props.sessionId ?? ""} agentName={props.agentName} workspace={props.workspace} dl={props.dl} providerModels={props.providerModels} />
        </div>
        {activeTab && activeTab.type === "subagents" && (
          <SubAgentsTab />
        )}
        {activeTab && activeTab.type === "terminal" && (
          <TerminalTab workspace={props.workspace} />
        )}
        {activeTab && activeTab.type === "browser" && (
          <BrowserTabInstance tabId={activeTab.id} url={activeTab.url ?? ""} onUrlChange={(url) => updateTab(activeTab.id, { url })} />
        )}
        {activeTab && activeTab.type === "git" && (
          <GitTab workspace={props.workspace} onFileClick={openFileTab} />
        )}
        {activeTab && activeTab.type === "file" && (
          <FileTab tab={activeTab} workspace={props.workspace} onBack={() => {
            const gitIdx = tabs.findIndex((t) => t.type === "git");
            if (gitIdx >= 0) { setActiveId(tabs[gitIdx].id); }
          }} />
        )}
      </div>
    </aside>
  );
}

/* ═══════════════ Git 仓库（整合文件资源管理器） ═══════════════ */

function GitTab(props: { workspace: string; onFileClick?: (rel: string, name: string) => void }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const [repoPath, setRepoPath] = React.useState("");
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [commits, setCommits] = React.useState<GitCommit[]>([]);
  const [status, setStatus] = React.useState<GitStatus>({ staged: [], modified: [], untracked: [], deleted: [] });
  const [branches, setBranches] = React.useState<string[]>([]);
  const [ahead, setAhead] = React.useState(0);
  const [behind, setBehind] = React.useState(0);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [commitMsg, setCommitMsg] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [initialized, setInitialized] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [notExists, setNotExists] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [modal, setModal] = React.useState<null | "clone" | "manual">(null);
  const [manualInput, setManualInput] = React.useState("");
  /** A-968：文件变更 diff（红绿标注）——点击变更文件时加载 */
  const [diffFile, setDiffFile] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<GitDiffFile | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffError, setDiffError] = React.useState("");

  /* ── 文件资源管理器状态 ── */
  const [fileCache, setFileCache] = React.useState<Record<string, WorkspaceEntry[]>>({});
  const [fileExpanded, setFileExpanded] = React.useState<Record<string, boolean>>({});
  const [fileLoading, setFileLoading] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState("");
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
  const [selectedName, setSelectedName] = React.useState("");
  const [selectedContent, setSelectedContent] = React.useState<WorkspaceReadFileResult | null>(null);
  const [selectedError, setSelectedError] = React.useState("");
  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number; rel: string; isDir: boolean; name: string; size: number } | null>(null);
  const [newItemPrompt, setNewItemPrompt] = React.useState<{ parentRel: string; isDir: boolean } | null>(null);
  const [newItemName, setNewItemName] = React.useState("");
  const ctxMenuRef = React.useRef<HTMLDivElement>(null);

  const root = props.workspace?.trim() || "";

  /** 文件资源管理器浏览根：默认工作目录，可用系统对话框切换任意位置（与系统资源管理器互通） */
  const [browseRoot, setBrowseRoot] = React.useState<string>(root);
  // 工作目录变化时，浏览根回退到工作目录
  React.useEffect(() => {
    setBrowseRoot(props.workspace?.trim() || "");
  }, [props.workspace]);

  const loadGitInfo = React.useCallback(async (path: string): Promise<void> => {
    if (!api?.git?.info) { return; }
    setLoading(true);
    setError("");
    try {
      const info = await api.git.info(path);
      if (!info?.ok) { setError(info?.error ?? "读取仓库信息失败"); return; }
      setBranch(info.branch || "main");
      setCommits(info.commits || []);
      setStatus(info.status || { staged: [], modified: [], untracked: [], deleted: [] });
      setBranches(info.branches || []);
      setAhead(info.ahead ?? 0);
      setBehind(info.behind ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  /** A-968：加载指定文件的变更 diff（红绿标注渲染）；切换文件/仓库时旧 diff 自动清空 */
  const loadDiff = React.useCallback(async (file: string): Promise<void> => {
    if (!repoPath || !api?.git?.diff) { return; }
    setDiffFile(file);
    setDiffLoading(true);
    setDiffError("");
    setDiff(null);
    try {
      const res = await api.git.diff(repoPath, file);
      if (res?.ok) {
        const df = res.files?.[0] ?? null;
        if (df) { setDiff(df); }
        else { setDiffError("该文件暂无可见的代码变更"); }
      } else {
        setDiffError(res?.error ?? "读取 diff 失败");
      }
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiffLoading(false);
    }
  }, [api, repoPath]);

  const bindWorkspace = React.useCallback(async (ws: string): Promise<void> => {
    const clean = (ws ?? "").trim().replace(/^['"\s]+|['"\s]+$/g, "");
    setRepoPath(clean);
    setModal(null);
    setMoreOpen(false);
    setDetecting(true);
    setError("");
    setNotExists(false);
    try {
      const res = await api?.git?.detect?.(clean);
      if (res?.isRepo) {
        const r = res.root || clean;
        setRepoPath(r);
        setInitialized(true);
        void loadGitInfo(r);
      } else {
        if (res?.notExists) { setNotExists(true); }
        setInitialized(false);
      }
    } catch (e) {
      setInitialized(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }, [api, loadGitInfo]);

  React.useEffect(() => {
    const ws = props.workspace?.trim() || "";
    if (!ws) { setRepoPath(""); setInitialized(false); setNotExists(false); return; }
    void bindWorkspace(ws);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspace]);

  /* ── 文件管理器加载 ── */
  const loadDir = React.useCallback(async (rel: string): Promise<void> => {
    if (!api?.workspace?.list || !browseRoot) { return; }
    setFileLoading(rel);
    try {
      const res = await api.workspace.list(browseRoot, rel);
      if (res?.ok) {
        setFileCache((prev) => ({ ...prev, [rel]: res.entries ?? [] }));
        setFileError("");
      } else {
        setFileError(res?.error ?? "读取失败");
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setFileLoading((l) => (l === rel ? null : l));
    }
  }, [api, browseRoot]);

  const loadFile = React.useCallback(async (rel: string): Promise<void> => {
    if (!api?.workspace?.readFile || !browseRoot) { return; }
    setSelectedError("");
    try {
      const res = await api.workspace.readFile(browseRoot, rel);
      if (res?.ok) { setSelectedContent(res); setSelectedError(""); }
      else { setSelectedContent(null); setSelectedError(res?.error ?? "读取失败"); }
    } catch (e) {
      setSelectedContent(null);
      setSelectedError(e instanceof Error ? e.message : String(e));
    }
  }, [api, browseRoot]);

  /** 打开系统对话框选择任意文件夹作为浏览根（与系统资源管理器互通） */
  const handlePickBrowseRoot = React.useCallback(async (): Promise<void> => {
    if (!api?.workspace?.pickBrowseRoot) { return; }
    try {
      const res = await api.workspace.pickBrowseRoot();
      if (res?.ok && res.path) {
        setBrowseRoot(res.path);
        setFileCache({});
        setFileExpanded({});
        setSelectedFile(null);
        setSelectedContent(null);
        setSelectedError("");
        setFileError("");
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  /** 向上浏览：提升浏览根为父级（逐级到磁盘根）；遇盘符根则禁用 */
  const handleGoParent = React.useCallback(async (): Promise<void> => {
    if (!api?.workspace?.getParent || !browseRoot) { return; }
    try {
      const res = await api.workspace.getParent(browseRoot);
      if (res?.ok && res.parent) {
        setBrowseRoot(res.parent);
        setFileCache({});
        setFileExpanded({});
        setSelectedFile(null);
        setSelectedContent(null);
        setSelectedError("");
        setFileError("");
      } else if (res?.ok && res.diskRoot) {
        setFileError("已经是磁盘根目录，无法继续向上");
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }, [api, browseRoot]);

  const toggleDir = (rel: string): void => {
    setFileExpanded((prev) => {
      const next = { ...prev, [rel]: !(prev[rel] ?? false) };
      if (next[rel] && !fileCache[rel]) { void loadDir(rel); }
      return next;
    });
  };

  const handleFileClick = (e: React.MouseEvent, rel: string, name: string, isDir: boolean): void => {
    e.stopPropagation();
    if (isDir) { toggleDir(rel); }
    else { setSelectedFile(rel); setSelectedName(name); void loadFile(rel); }
  };

  const handleFileContextMenu = (e: React.MouseEvent, rel: string, name: string, isDir: boolean, size: number): void => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, rel, isDir, name, size });
  };

  const handleCopyPath = async (rel: string): Promise<void> => {
    try { await navigator.clipboard.writeText(rel); } catch { /* */ }
  };

  const handleNewFileOrFolder = (isDir: boolean): void => {
    if (!ctxMenu) { return; }
    setCtxMenu(null);
    setNewItemPrompt({ parentRel: ctxMenu.rel, isDir });
    setNewItemName(isDir ? "新建文件夹" : "新建文件.txt");
  };

  const handleConfirmNew = async (): Promise<void> => {
    if (!newItemPrompt || !newItemName.trim()) { return; }
    try {
      const res = await api?.workspace?.create({ root: browseRoot, parentRel: newItemPrompt.parentRel, name: newItemName.trim(), isDir: newItemPrompt.isDir });
      if (res?.ok) {
        setNewItemPrompt(null);
        setNewItemName("");
        void loadDir(newItemPrompt.parentRel);
        if (!fileExpanded[newItemPrompt.parentRel]) {
          setFileExpanded((prev) => ({ ...prev, [newItemPrompt.parentRel]: true }));
        }
      } else {
        void alertAsync("创建失败：" + (res?.error ?? "未知错误"));
      }
    } catch (e) {
      void alertAsync("创建失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleRename = React.useCallback(async (): Promise<void> => {
    if (!ctxMenu) { return; }
    const oldName = prompt("重命名", ctxMenu.name);
    if (!oldName || oldName === ctxMenu.name) { setCtxMenu(null); return; }
    setCtxMenu(null);
    try {
      const res = await api?.workspace?.rename(browseRoot, ctxMenu.rel, oldName);
      if (!res?.ok) { void alertAsync("重命名失败：" + (res?.error ?? "未知错误")); }
      else { void loadDir(""); }
    } catch (e) { void alertAsync("重命名失败：" + (e instanceof Error ? e.message : String(e))); }
  }, [api, browseRoot, ctxMenu, loadDir]);

  React.useEffect(() => {
    if (browseRoot) { void loadDir(""); setSelectedError(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseRoot]);

  React.useEffect(() => {
    // 守卫必须覆盖「目录尚未加载」（fileCache[""] 为 undefined）——否则 line749 flexbox find 崩
    if (!browseRoot || !fileCache[""]?.length) { return; }
    const firstFile = fileCache[""].find((e) => !e.isDir);
    if (firstFile && !selectedFile) {
      setSelectedFile(firstFile.rel);
      setSelectedName(firstFile.name);
      void loadFile(firstFile.rel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCache[""]]);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ctxMenu && !(e.target as HTMLElement)?.closest?.(".ctx-menu")) setCtxMenu(null);
      if (newItemPrompt && !(e.target as HTMLElement)?.closest?.(".new-item-dialog")) setNewItemPrompt(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ctxMenu, newItemPrompt]);

  /* ── Git 操作 ── */
  const doInitRepo = async (): Promise<void> => {
    if (!repoPath || !api?.git?.init) { return; }
    setLoading(true);
    setError("");
    try {
      const res = await api.git.init(repoPath);
      if (res?.ok) { setNotExists(false); setInitialized(true); void loadGitInfo(repoPath); }
      else { setError(res?.error ?? "初始化失败"); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const openManualPath = (): void => {
    const path = (manualInput ?? "").trim().replace(/^['"\s]+|['"\s]+$/g, "");
    if (!path) { setError("请输入仓库路径"); return; }
    void bindWorkspace(path);
  };

  const initFromClone = (): void => {
    const url = cloneUrl.trim();
    if (!url) { setError("请输入仓库地址"); return; }
    if (!api?.git?.clone) { setError("Git clone 功能暂不可用"); return; }
    setLoading(true);
    setError("");
    api.git.clone(url).then((result: { path?: string; error?: string }) => {
      if (result?.error) { setError(result.error); }
      else if (result?.path) { setModal(null); setCloneUrl(""); void bindWorkspace(result.path); }
    }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); }).finally(() => setLoading(false));
  };

  const doCommit = (): void => {
    if (!repoPath || !api?.git?.commit) { return; }
    if (!commitMsg.trim()) { setError("请输入提交信息"); return; }
    setLoading(true);
    api.git.commit(repoPath, commitMsg.trim()).then((res: { ok?: boolean; error?: string }) => {
      if (res?.ok) { setCommitMsg(""); } else { setError(res?.error ?? "提交失败"); }
      void loadGitInfo(repoPath);
    }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); }).finally(() => setLoading(false));
  };

  const doPush = (): void => {
    if (!repoPath || !api?.git?.push) { return; }
    setLoading(true);
    api.git.push(repoPath).then((res: { ok?: boolean; error?: string }) => {
      if (!res?.ok) { setError(res?.error ?? "推送失败"); }
      void loadGitInfo(repoPath);
    }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); }).finally(() => setLoading(false));
  };

  const doPull = (): void => {
    if (!repoPath || !api?.git?.pull) { return; }
    setLoading(true);
    api.git.pull(repoPath).then((res: { ok?: boolean; error?: string }) => {
      if (!res?.ok) { setError(res?.error ?? "拉取失败"); }
      void loadGitInfo(repoPath);
    }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); }).finally(() => setLoading(false));
  };

  const doSync = (): void => {
    if (!repoPath || !api?.git?.pull || !api?.git?.push) { return; }
    setLoading(true);
    setError("");
    api.git.pull(repoPath).then((res: { ok?: boolean; error?: string }) => {
      if (!res?.ok) { setError(res?.error ?? "拉取失败"); return; }
      return api.git.push(repoPath);
    }).then((res: { ok?: boolean; error?: string } | undefined) => {
      if (res && !res.ok) { setError(res.error ?? "推送失败"); return; }
      void loadGitInfo(repoPath);
    }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); void loadGitInfo(repoPath); }).finally(() => setLoading(false));
  };

  const switchBranch = (name: string): void => {
    if (!repoPath || !api?.git?.checkout) { return; }
    setLoading(true);
    api.git.checkout(repoPath, name).then((res: { ok?: boolean; error?: string }) => {
      if (!res?.ok) { setError(res?.error ?? "切换分支失败"); }
      void loadGitInfo(repoPath);
    }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); }).finally(() => setLoading(false));
  };

  const totalChanges = status.staged.length + status.modified.length + status.untracked.length + status.deleted.length;
  const hasWorkspace = !!props.workspace?.trim();

  const moreWrapRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!moreOpen) { return; }
    const handler = (e: MouseEvent): void => {
      if (!moreWrapRef.current) { return; }
      if (!moreWrapRef.current.contains(e.target as Node)) { setMoreOpen(false); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  /* ─ 文件树渲染 ── */
  const getBreadcrumb = (rel: string): string[] => {
    if (!rel) return ["项目根"];
    return ["项目根", ...rel.split("/").filter(Boolean)];
  };

  const renderBreadcrumb = (path: string): JSX.Element => {
    const crumbs = getBreadcrumb(path);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, color: "var(--text-dim)", flexWrap: "wrap", padding: "2px 0" }}>
        {crumbs.map((crumb, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: "var(--text-dim)" }}>/</span>}
            <span
              style={{ cursor: i < crumbs.length - 1 ? "pointer" : "default", color: i < crumbs.length - 1 ? "var(--text-secondary)" : "var(--text)", whiteSpace: "nowrap" }}
              onClick={i < crumbs.length - 1 ? () => {
                const parts = crumbs.slice(1, i + 1);
                void loadDir(parts.join("/"));
                setSelectedFile(null);
                setSelectedContent(null);
              } : undefined}
              title={i < crumbs.length - 1 ? `进入${crumb}` : undefined}
            >{crumb}</span>
          </React.Fragment>
        ))}
      </div>
    );
  };

  const renderTreeRow = (entry: WorkspaceEntry, depth: number): JSX.Element[] => {
    const pad = 8 + depth * 14;
    if (entry.isDir) {
      const isOpen = fileExpanded[entry.rel] ?? false;
      return [
        <div key={entry.rel} className="tree-row file-tree-row" style={{ paddingLeft: pad, cursor: "pointer" }}
          title={entry.rel || "/"} onClick={(e) => handleFileClick(e, entry.rel, entry.name, true)}
          onContextMenu={(e) => handleFileContextMenu(e, entry.rel, entry.name, true, 0)}>
          <ChevronIcon size={11} rotate={isOpen ? 90 : 0} />
          <FolderIcon size={13} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
          <span className="tree-name tree-dir">{entry.name}</span>
          {isOpen && fileLoading === entry.rel && <span className="tree-hint" style={{ fontSize: 10, marginLeft: 4 }}>加载中…</span>}
        </div>,
        ...(isOpen ? renderDirChildren(entry.rel, depth + 1) : []),
      ];
    } else {
      return [
        <div key={entry.rel}
          className={`tree-row tree-file ${selectedFile === entry.rel ? "file-tree-row-selected" : ""}`}
          style={{ paddingLeft: pad + 14, cursor: "pointer" }}
          title={`${entry.rel}（${fmtSize(entry.size)}）`}
          onClick={(e) => handleFileClick(e, entry.rel, entry.name, false)}
          onContextMenu={(e) => handleFileContextMenu(e, entry.rel, entry.name, false, entry.size)}>
          <span className="tree-name">{entry.name}</span>
          <span className="tree-size">{fmtSize(entry.size)}</span>
        </div>,
      ];
    }
  };

  const renderDirChildren = (rel: string, depth: number): JSX.Element[] => {
    const entries = fileCache[rel] ?? [];
    const result: JSX.Element[] = [];
    for (const e of entries) { result.push(...renderTreeRow(e, depth)); }
    return result;
  };

  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ─ 右键菜单 ── */}
      {ctxMenu && (
        <div className="ctx-menu" ref={ctxMenuRef}
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.3)", minWidth: 160, padding: "4px 0" }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 12px 6px", borderBottom: "1px solid var(--border)", marginBottom: 4, wordBreak: "break-all" }}>{ctxMenu.name}</div>
          <div className="ctx-menu-item" onClick={() => { props.onFileClick?.(ctxMenu.rel, ctxMenu.name); setCtxMenu(null); }}>
            <span style={{ marginRight: 8 }}><FolderIcon size={13} /></span>在新标签打开
          </div>
          <div className="ctx-menu-item" onClick={() => { void handleCopyPath(ctxMenu.rel); setCtxMenu(null); }}>
            <span style={{ marginRight: 8 }}><PaperclipIcon size={13} /></span>复制路径
          </div>
          <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
          {ctxMenu.isDir && <>
            <div className="ctx-menu-item" onClick={() => void handleNewFileOrFolder(false)}>
              <span style={{ marginRight: 8 }}></span>新建文件…
            </div>
            <div className="ctx-menu-item" onClick={() => void handleNewFileOrFolder(true)}>
              <span style={{ marginRight: 8 }}><FolderIcon size={13} /></span>新建文件夹…
            </div>
          </>}
          <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
          <div className="ctx-menu-item" onClick={() => void handleRename()}>
            <span style={{ marginRight: 8 }}><EditIcon size={13} /></span>重命名…
          </div>
          <div className="ctx-menu-item" style={{ color: "var(--danger)" }} onClick={() => {
            void (async () => { if (await confirmAsync(`确定删除 ${ctxMenu.name}？`)) { void alertAsync("删除功能待实现"); setCtxMenu(null); } })();
          }}>
            <span style={{ marginRight: 8 }}>️</span>删除
          </div>
        </div>
      )}

      {/* ── 新建文件/文件夹对话框 ── */}
      {newItemPrompt && (
        <div className="new-item-dialog" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 20, minWidth: 300, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{newItemPrompt.isDir ? "新建文件夹" : "新建文件"}</div>
            <input type="text" value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleConfirmNew(); if (e.key === "Escape") setNewItemPrompt(null); }}
              autoFocus style={{ width: "100%", padding: "6px 10px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 13, outline: "none", marginBottom: 12 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setNewItemPrompt(null)} style={{ padding: "4px 12px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12 }}>取消</button>
              <button onClick={() => void handleConfirmNew()} style={{ padding: "4px 12px", background: "var(--accent)", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: 12 }}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 顶栏：Git 仓库 + 状态 + 文件搜索 ── */}
      <div className="right-pane-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="right-pane-title">Git 仓库</span>
        {initialized && (
          <span title="已打开 Git 仓库" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, color: "#7ee787", background: "rgba(126,231,135,0.1)", fontWeight: 600 }}>已连接</span>
        )}
        {!detecting && !initialized && hasWorkspace && repoPath && (
          <span title={notExists ? "目录不存在" : "还未初始化 Git 仓库"} style={{
            fontSize: 10, padding: "1px 6px", borderRadius: 8,
            color: notExists ? "var(--warning, #d29922)" : "var(--text-muted)",
            background: notExists ? "rgba(210,153,34,0.12)" : "var(--input-bg, #161b22)", fontWeight: 600,
          }}>{notExists ? "目录未创建" : "未初始化"}</span>
        )}
        {loading && !initialized && <span style={{ color: "var(--accent)", fontSize: 11, opacity: 0.8 }}>加载中…</span>}
        <div ref={moreWrapRef} style={{ marginLeft: "auto", position: "relative" }}>
          {initialized && (
            <button className="right-mini-btn" title="刷新" onClick={() => { if (repoPath) { void loadGitInfo(repoPath); } }} style={{ marginRight: 4 }}><RefreshIcon size={12} /></button>
          )}
          <button className="right-mini-btn" title="仓库菜单" onClick={() => setMoreOpen((v) => !v)} style={{ fontWeight: 700 }}><ChevronIcon size={12} rotate={90} /></button>
          {moreOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 30, minWidth: 230, background: "var(--panel-bg, #1c2128)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 10px 24px rgba(0,0,0,0.35)", padding: 4, fontSize: 12 }}>
              <MenuItem label="切回工作目录" disabled={!hasWorkspace || loading} hint="（自动关联）" onClick={() => props.workspace && void bindWorkspace(props.workspace)} />
              <MenuItem label="手动指定路径…" disabled={loading} hint="（Ctrl+V 粘贴）" onClick={() => { setMoreOpen(false); setModal("manual"); setManualInput(""); }} />
              <MenuItem label="克隆远程仓库…" disabled={loading} onClick={() => { setMoreOpen(false); setModal("clone"); setCloneUrl(""); }} />
              {repoPath && <MenuItem label="在资源管理器中打开" disabled={!repoPath} onClick={() => { setMoreOpen(false); const shell = (window as unknown as { slimeAPI?: { os?: { openPath?: (p: string) => Promise<unknown> } } }).slimeAPI?.os; if (shell?.openPath) { void shell.openPath(repoPath); } }} />}
              {initialized && repoPath && <MenuItem label="切换为其他仓库…" disabled={loading} onClick={() => { setMoreOpen(false); setModal("manual"); setManualInput(repoPath); }} />}
            </div>
          )}
        </div>
      </div>

        {repoPath && !detecting && (
          <div className="right-pane-head-sub" title={repoPath} style={{ cursor: "default", display: "flex", alignItems: "center", gap: 4 }}><FolderIcon size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} /><span>{repoPath}</span></div>
        )}

      {error && (
        <div style={{ padding: "6px 10px", background: "var(--danger-soft, rgba(248,81,73,0.1))", color: "var(--danger, #f85149)", fontSize: 12, borderBottom: "1px solid var(--border)" }}>{error}</div>
      )}

      {/* ── 内容区：左侧文件树 + 右侧预览/Git ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        {/* ── 左侧文件树（内嵌文件资源管理器，可切换任意浏览根） ── */}
        <div style={{ width: "40%", minWidth: 140, maxWidth: 340, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-secondary)", borderRight: "1px solid var(--border)" }}>
          {/* 工具条：上级 + 打开文件夹（系统对话框互通） */}
          <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <button className="right-mini-btn" title="上级目录" onClick={() => void handleGoParent()} disabled={!browseRoot} style={{ padding: "2px 7px", fontSize: 12, fontWeight: 700 }}>⬆</button>
            <button className="right-mini-btn" title="打开系统文件夹（可访问任意位置）" onClick={() => void handlePickBrowseRoot()} style={{ flex: 1, justifyContent: "center", fontSize: 11 }}><FolderIcon size={13} /> 打开文件夹…</button>
          </div>
          {/* 当前浏览根路径 */}
          {browseRoot && (
            <div title={browseRoot} style={{ padding: "4px 8px", fontSize: 10, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}><FolderIcon size={11} style={{ flexShrink: 0 }} />{browseRoot}</div>
          )}
          {/* 目录树滚动区 */}
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "4px 0" }}>
            {!browseRoot && !fileError && <div className="tree-hint" style={{ padding: "8px 10px" }}>未设置工作目录<br />点上方「打开文件夹…」选择任意位置</div>}
            {fileError && <div className="tree-error" style={{ padding: "4px 10px" }}>⚠ {fileError}</div>}
            {browseRoot && !fileError && fileCache[""] && fileCache[""].length === 0 && (
              <div className="tree-hint" style={{ padding: "8px 10px" }}>（空目录）</div>
            )}
            {browseRoot && !fileError && !fileCache[""] && fileLoading === "" && (
              <div className="tree-hint" style={{ padding: "8px 10px" }}>加载中…</div>
            )}
            {browseRoot && (
              <div>
                {(fileCache[""] ?? []).map((e) => renderTreeRow(e, 0)).flat()}
              </div>
            )}
          </div>
        </div>

        {/* ── 右侧：Git 操作 + 文件预览 ── */}
        <div style={{ flex: 1, minWidth: 180, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {/* 面包屑 */}
          {selectedFile && (
            <div style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-hover)", flexShrink: 0 }}>
              {renderBreadcrumb(selectedFile)}
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            {/* ── Git 状态 ── */}
            {detecting && (
              <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>正在检测工作目录 Git 状态…</div>
            )}

            {!detecting && !hasWorkspace && (
              <div style={{ padding: "36px 20px", textAlign: "center" }}>
                <div style={{ width: 64, height: 64, margin: "0 auto 16px", color: "var(--text-muted)", opacity: 0.8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <FolderEmptyGlyph />
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 500 }}>未设置工作目录</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, wordBreak: "break-word" }}>在 <b>项目设置</b> 中选择任务文件夹后，<br />Git 仓库会自动跟随该工作目录。</div>
                <div style={{ marginTop: 18 }}>
                  <button onClick={() => setModal("manual")} style={{ padding: "7px 14px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}>手动指定一个仓库路径</button>
                </div>
              </div>
            )}

            {!detecting && hasWorkspace && !initialized && (
              <div style={{ padding: "30px 20px", textAlign: "center" }}>
                <div style={{ width: 72, height: 72, margin: "0 auto 16px", color: "var(--text-muted)", opacity: 0.8, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <NoChangesGlyph />
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 600 }}>{notExists ? "工作目录还未创建" : "当前工作目录还不是 Git 仓库"}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{notExists ? "初始化仓库时会自动创建这个目录。" : "工作目录与 Git 仓库一一对应。"}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 18, wordBreak: "break-all" }}>{repoPath}</div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  <button onClick={() => void doInitRepo()} disabled={loading || !repoPath} style={{ padding: "8px 14px", background: "var(--accent, #238636)", color: "#fff", border: "none", borderRadius: 4, cursor: (loading || !repoPath) ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600 }}>{notExists ? "创建目录并初始化 Git" : "初始化 Git 仓库"}</button>
                  <button onClick={() => { setModal("clone"); setCloneUrl(""); }} disabled={loading} style={{ padding: "8px 14px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>克隆远程仓库</button>
                </div>
              </div>
            )}

            {initialized && (
              <div>
                {/* ── 分支栏 ── */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ padding: "2px 10px", background: "var(--accent-soft, rgba(56,139,253,0.15))", color: "var(--accent, #58a6ff)", borderRadius: 10, fontSize: 12, fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={branch}>{branch || "(无分支)"}</span>
                  {(ahead > 0 || behind > 0) && (
                    <span style={{ fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--text-secondary)", background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", borderRadius: 10, padding: "1px 8px" }} title={behind > 0 ? `落后远端 ${behind} 个提交，可拉取` : ahead > 0 ? `领先远端 ${ahead} 个提交，可推送` : ""}>
                      {behind > 0 && <span style={{ color: "var(--warning, #d29922)" }}>↓{behind}</span>}
                      {behind > 0 && ahead > 0 && <span style={{ opacity: 0.5 }}> · </span>}
                      {ahead > 0 && <span style={{ color: "var(--accent, #58a6ff)" }}>↑{ahead}</span>}
                    </span>
                  )}
                  {branches.length > 0 && (
                    <select value={branch} onChange={(e) => switchBranch(e.target.value)} disabled={loading} style={{ marginLeft: "auto", maxWidth: 110, padding: "2px 6px", background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-primary)", fontSize: 11 }} title="切换分支">
                      {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  )}
                </div>

                {/* ─ 提交区 ── */}
                <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--input-bg, #161b22)", padding: 8, marginBottom: 12 }}>
                  <textarea value={commitMsg} placeholder="提交信息（Ctrl+Enter 提交）" onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { doCommit(); } }}
                    rows={2} style={{ width: "100%", resize: "none", boxSizing: "border-box", padding: "5px 8px", background: "transparent", border: "none", outline: "none", color: "var(--text-primary)", fontSize: 12, fontFamily: "inherit", lineHeight: 1.5 }} />
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    <button onClick={doCommit} disabled={loading || !commitMsg.trim() || totalChanges === 0} title="提交全部更改（Ctrl+Enter）" style={{ flex: "1 1 auto", minWidth: 60, padding: "5px 12px", background: (loading || !commitMsg.trim() || totalChanges === 0) ? "var(--input-bg, #21262d)" : "var(--accent, #238636)", color: (loading || !commitMsg.trim() || totalChanges === 0) ? "var(--text-muted)" : "#fff", border: "none", borderRadius: 4, cursor: (loading || !commitMsg.trim() || totalChanges === 0) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}><CheckIcon size={12} />提交</button>
                    <button onClick={doSync} disabled={loading} title="拉取 + 推送" style={{ padding: "5px 12px", background: "var(--accent, #1f6feb)", color: "#fff", border: "none", borderRadius: 4, cursor: loading ? "not-allowed" : "pointer", fontSize: 12, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}><RepeatIcon size={12} />同步</button>
                    <button onClick={doPull} disabled={loading} title="拉取远端更改" style={{ padding: "5px 10px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: loading ? "not-allowed" : "pointer", fontSize: 12, whiteSpace: "nowrap" }}>拉取</button>
                    <button onClick={doPush} disabled={loading} title="推送到远端" style={{ padding: "5px 10px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: loading ? "not-allowed" : "pointer", fontSize: 12, whiteSpace: "nowrap" }}>推送</button>
                  </div>
                </div>

                {/* ── 变更分组 ── */}
                <div style={{ marginBottom: 16 }}>
                  {totalChanges === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--success, #7ee787)", padding: "8px 0", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 14 }}><CheckIcon size={14} /></span> 工作区干净，无需提交
                    </div>
                  ) : (
                    <div>
                      <ChangeGroup title="暂存的更改" files={status.staged} glyph="M" collapsed={!!collapsed.staged} onToggle={() => setCollapsed((p) => ({ ...p, staged: !p.staged }))} onFileClick={(f) => void loadDiff(f)} />
                      <ChangeGroup title="更改" files={status.modified} glyph="M" collapsed={!!collapsed.modified} onToggle={() => setCollapsed((p) => ({ ...p, modified: !p.modified }))} onFileClick={(f) => void loadDiff(f)} />
                      <ChangeGroup title="未跟踪" files={status.untracked} glyph="?" collapsed={!!collapsed.untracked} onToggle={() => setCollapsed((p) => ({ ...p, untracked: !p.untracked }))} onFileClick={(f) => void loadDiff(f)} />
                      <ChangeGroup title="已删除" files={status.deleted} glyph="D" collapsed={!!collapsed.deleted} onToggle={() => setCollapsed((p) => ({ ...p, deleted: !p.deleted }))} onFileClick={(f) => void loadDiff(f)} />
                    </div>
                  )}
                </div>

                {/* A-968：文件变更 diff（红绿标注）——点击「变更分组」里的文件后展示 */}
                {diffFile && (
                  <div style={{ marginBottom: 16, border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", background: "var(--bg-input, #161b22)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", fontSize: 12 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, fontFamily: "Consolas, 'Courier New', monospace" }} title={diffFile}>{diffFile}</span>
                      {diff && (
                        <>
                          <span style={{ color: "#7ee787", fontSize: 11, flexShrink: 0 }} title="新增行">+{diff.additions}</span>
                          <span style={{ color: "#ff7b72", fontSize: 11, flexShrink: 0 }} title="删除行">-{diff.deletions}</span>
                        </>
                      )}
                      <button onClick={() => setDiffFile(null)} title="关闭 diff" style={{ background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 14, lineHeight: 1, flexShrink: 0 }}>×</button>
                    </div>
                    {diffLoading && (
                      <div style={{ padding: "14px 12px", fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                        <LoadingCircleIcon size={12} className="icon-spin" /> 正在生成 diff…
                      </div>
                    )}
                    {diffError && (
                      <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--danger, #f85149)" }}>⚠ {diffError}</div>
                    )}
                    {diff && diff.hunks.length === 0 && (
                      <div style={{ padding: "12px", fontSize: 11.5, color: "var(--text-muted)" }}>
                        {diff.status === "untracked" ? "未跟踪文件 · 二进制内容未展示" : diff.status === "deleted" ? "文件已删除" : "该文件无可展示的代码变更"}
                      </div>
                    )}
                    {diff && diff.hunks.length > 0 && (
                      <div style={{ maxHeight: 280, overflow: "auto", background: "var(--bg)" }}>
                        {diff.hunks.map((h, i) => (
                          <div key={i}>
                            <div style={{ padding: "2px 10px", background: "rgba(56,139,253,0.12)", color: "var(--accent-hover, #58a6ff)", fontFamily: "Consolas, 'Courier New', monospace", fontSize: 11 }}>{h.header}</div>
                            {h.lines.map((l, j) => (
                              <div key={j} style={{
                                display: "flex",
                                fontFamily: "Consolas, 'Courier New', monospace",
                                fontSize: 11.5,
                                lineHeight: 1.6,
                                background: l.type === "add" ? "var(--diff-add-bg)" : l.type === "del" ? "var(--diff-del-bg)" : "transparent",
                                // 左侧状态条（VS Code gutter 范式）：绿=新增、红=删除，增强行级视觉辨识、降低纯色疲劳
                                boxShadow: l.type === "add" ? "inset 2px 0 0 var(--diff-add)" : l.type === "del" ? "inset 2px 0 0 var(--diff-del)" : "none",
                              }}>
                                <span style={{
                                  width: 22, flexShrink: 0, textAlign: "right", paddingRight: 6, userSelect: "none",
                                  color: l.type === "add" ? "var(--diff-add)" : l.type === "del" ? "var(--diff-del)" : "var(--text-dim)",
                                }}>{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>
                                <span style={{ flex: 1, whiteSpace: "pre", color: l.type === "add" ? "var(--diff-add)" : l.type === "del" ? "var(--diff-del)" : "var(--text-secondary)" }}>{l.text}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── 提交历史 ── */}
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 500 }}>提交历史</div>
                  {commits.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 0" }}>暂无提交记录</div>
                  ) : (
                    <div>
                      {commits.map((c) => (
                        <div key={c.hash} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 4, marginBottom: 2, fontSize: 12 }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hover-bg, rgba(255,255,255,0.05))"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}>
                          <code style={{ fontSize: 11, color: "var(--accent)", background: "var(--accent-soft, rgba(56,139,253,0.1))", padding: "1px 5px", borderRadius: 3, fontFamily: "Consolas, 'Courier New', monospace" }}>{c.hash.slice(0, 7)}</code>
                          <span style={{ flex: 1, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.message}>{c.message}</span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{c.time}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── 文件预览（选中文件时显示在 Git 操作下方） ── */}
            {selectedFile && selectedContent && !selectedError && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>📄 {selectedName}</div>
                {selectedContent.mime === "image" && selectedContent.content ? (
                  <img src={imageDataUrl(selectedName, selectedContent.content)} alt={selectedName} style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
                ) : (
                  <pre style={{ fontSize: 11, fontFamily: "Consolas, monospace", color: "var(--text-secondary)", padding: 10, background: "var(--bg-hover)", borderRadius: 6, overflow: "auto", maxHeight: 300, whiteSpace: "pre" }}>{(selectedContent.content ?? "").slice(0, 4096)}</pre>
                )}
              </div>
            )}
            {selectedFile && selectedError && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12, color: "var(--danger)", fontSize: 12 }}>⚠ {selectedError}</div>
            )}
            {selectedFile && !selectedContent && !selectedError && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, color: "var(--text-dim)" }}>
                <div style={{ fontSize: 24, opacity: 0.5 }}></div>
                <div style={{ fontSize: 11 }}>正在读取文件…</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 弹层：手动指定路径 / 克隆远程仓库 ── */}
      {modal && (
        <div style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px 16px" }} onClick={() => setModal(null)}>
          <div style={{ width: "100%", maxWidth: 420, background: "var(--panel-bg, #1c2128)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 18px 50px rgba(0,0,0,0.5)", padding: 16 }} onClick={(e) => e.stopPropagation()}>
            {modal === "manual" && (
              <>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10, fontWeight: 600 }}>指定仓库路径</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.55 }}>把 Git 仓库切换到其他本地文件夹。<br />若该目录还不是 Git 仓库，进入后可一键初始化。</div>
                <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                  <input autoFocus value={manualInput} placeholder="本地路径，例如 D:\projects\xyz" onChange={(e) => setManualInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { openManualPath(); } }}
                    style={{ flex: 1, padding: "7px 10px", background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }} />
                  <button onClick={openManualPath} disabled={loading} style={{ padding: "7px 14px", background: "var(--accent, #238636)", color: "#fff", border: "none", borderRadius: 4, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>打开</button>
                </div>
                {props.workspace?.trim() && (
                  <button onClick={() => void bindWorkspace(props.workspace.trim())} disabled={loading} style={{ width: "100%", padding: "7px 10px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: loading ? "not-allowed" : "pointer", fontSize: 12 }}>返回工作目录自动关联</button>
                )}
              </>
            )}
            {modal === "clone" && (
              <>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10, fontWeight: 600 }}>克隆远程仓库</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.55 }}>克隆完成后会自动切换到克隆下来的目录。</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input autoFocus value={cloneUrl} placeholder="https://github.com/user/repo.git" onChange={(e) => setCloneUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { initFromClone(); } }}
                    style={{ flex: 1, padding: "7px 10px", background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-primary)", fontSize: 13 }} />
                  <button onClick={initFromClone} disabled={loading} style={{ padding: "7px 14px", background: "var(--accent, #1f6feb)", color: "#fff", border: "none", borderRadius: 4, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}>克隆</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════ 文件查看器 ═══════════════ */

function detectLang(name: string): string {
  const ext = "." + (name.split(".").pop()?.toLowerCase() ?? "");
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".md": "markdown", ".html": "html", ".css": "css",
    ".sh": "bash", ".bat": "batch", ".ps1": "powershell",
    ".xml": "xml", ".svg": "xml", ".env": "plaintext",
  };
  return map[ext] ?? "plaintext";
}

/* ── 文件查看板块：内嵌文件资源管理器（浏览导航）+ 文件预览 ── */

/** 常见压缩包/归档格式（可在文件预览时提示无需按文本查看） */
const ARCHIVE_EXT = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".tar.gz"]);

/** 常见二进制扩展名（即便被读成了文本字符也不应按文本预览） */
const BINARY_EXT = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
  ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
  ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node", ".lock",
]);

/** 把 base64 解码为前 maxBytes 字节的十六进制视图（用于二进制文件预览，避免乱码） */
function base64ToHexView(b64: string, maxBytes = 512): { hex: string; byteLen: number; truncated: boolean } {
  try {
    const bin = atob(b64);
    const byteLen = bin.length;
    const n = Math.min(byteLen, maxBytes);
    let hex = "";
    for (let i = 0; i < n; i++) {
      if (i > 0 && i % 16 === 0) { hex += "\n"; }
      const c = (bin.charCodeAt(i) & 0xff).toString(16);
      hex += (c.length < 2 ? "0" : "") + c + " ";
    }
    return { hex: hex.trim(), byteLen, truncated: byteLen > maxBytes };
  } catch {
    return { hex: "", byteLen: 0, truncated: false };
  }
}

const ARCHIVE_NAMES = {
  ".zip": "ZIP 压缩包", ".tar": "TAR 归档", ".gz": "GZIP 压缩", ".tgz": "TGZ 压缩归档", ".tgz.gz": "TGZ 压缩归档",
  ".rar": "RAR 压缩包", ".7z": "7-Zip 压缩包", ".bz2": "BZIP2 压缩", ".xz": "XZ 压缩",
} as Record<string, string>;

interface FSActionState {
  rel: string;
  name: string;
  mime: "text" | "image" | "binary";
  content: string;   // 文本原义；图片/二进制为 base64
  size: number;
  truncated?: boolean;
  error?: string;
}

function FileTab(props: { tab: TabInstance; workspace: string; onBack: () => void }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const workspaceRoot = props.workspace?.trim() || "";

  /** A-918++：行级 diff（LCS）——供 FileTab diff 模式渲染 VS Code 风格行 */
  const diffLinesFn = (a: string, b: string): Array<{ op: "=" | "+" | "-"; text: string }> => {
    const aL = a.length ? a.split("\n") : [""];
    const bL = b.length ? b.split("\n") : [""];
    const n = aL.length, m = bL.length;
    if (n * m > 200000) {
      return [...aL.map((t) => ({ op: "-" as const, text: t })), ...bL.map((t) => ({ op: "+" as const, text: t }))];
    }
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) { for (let j = 1; j <= m; j++) { dp[i][j] = aL[i - 1] === bL[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]); } }
    const out: Array<{ op: "=" | "+" | "-"; text: string }> = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && aL[i - 1] === bL[j - 1]) { out.push({ op: "=", text: aL[i - 1] }); i--; j--; }
      else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.push({ op: "+", text: bL[j - 1] }); j--; }
      else { out.push({ op: "-", text: aL[i - 1] }); i--; }
    }
    return out.reverse();
  };

  /** 识别文件名中的扩展名（小写） */
  const extOf = (name: string): string => {
    const m = /\.([a-z0-9]+)$/i.exec(name.trim());
    return m ? `.${m[1].toLowerCase()}` : "";
  };

  /** A-918++：简易语法高亮（关键字/字符串/注释/数字，4 色 token；按扩展名选语言集） */
  const PY_KW = "def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|in|not|and|or|None|True|False|self|lambda|yield|raise|pass|break|continue|async|await|print|len|range|open|isinstance|hasattr|getattr|setattr";
  const JS_KW = "function|class|const|let|var|return|if|else|for|while|do|switch|case|break|continue|new|this|true|false|null|undefined|async|await|import|export|from|as|of|try|catch|finally|throw|interface|type|enum|public|private|protected|readonly|void|number|string|boolean|any|unknown|never";
  const langKw = (lang: string): string => {
    if (lang === "py" || lang === "python") return PY_KW;
    if (lang === "js" || lang === "ts" || lang === "jsx" || lang === "tsx") return JS_KW;
    return "";
  };
  const langOf = (name: string): string => {
    const e = extOf(name).slice(1);
    if (e === "py") return "py";
    if (e === "js" || e === "jsx") return "js";
    if (e === "ts" || e === "tsx") return "ts";
    return "";
  };
  const highlightCode = (text: string, lang: string): React.ReactNode[] => {
    const kw = langKw(lang);
    // 优先识别字符串/注释（避免字符串内的 # 被误判为注释）
    const re = new RegExp(
      "(#[^\\n]*|//[^\\n]*|/\\*[\\s\\S]*?\\*/|'[^'\\n]*(?:\\\\.[^'\\n]*)*'|\"(?:[^\"\\\\\\n]|\\\\.)*\"|\\b\\d+\\.?\\d*\\b" + (kw ? "|\\b(?:" + kw + ")\\b" : "") + ")",
      "g",
    );
    const lines = text.split("\n");
    const out: React.ReactNode[] = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const segs: React.ReactNode[] = [];
      let last = 0;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m.index > last) { segs.push(line.slice(last, m.index)); }
        const t = m[0];
        let cls = "";
        if (t.startsWith("#") || t.startsWith("//") || t.startsWith("/*")) cls = "hl-c";
        else if (t[0] === "'" || t[0] === "\"") cls = "hl-s";
        else if (/^\d/.test(t)) cls = "hl-n";
        else cls = "hl-k";
        segs.push(<span key={segs.length} className={cls}>{t}</span>);
        last = m.index + t.length;
      }
      if (last < line.length) { segs.push(line.slice(last)); }
      out.push(<div key={li} style={{ minHeight: "1.4em" }}>{segs.length ? segs : "\u00A0"}</div>);
      re.lastIndex = 0;
    }
    return out;
  };

  /* ── 文件浏览导航状态 ── */
  const [browseRoot, setBrowseRoot] = React.useState<string>(workspaceRoot);
  /** 相对目录栈：[] 为根，["a"] 为 /a，逐级 push/pop */
  const [dirStack, setDirStack] = React.useState<string[]>([]);
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([]);
  const [loadingDir, setLoadingDir] = React.useState(false);
  const [dirError, setDirError] = React.useState("");
  const [pickingFolder, setPickingFolder] = React.useState(false);
  const curRel = dirStack.join("/");

  /* ── 文件预览状态 ── */
  const [preview, setPreview] = React.useState<FSActionState | null>(null);
  const [copied, setCopied] = React.useState(false);
  /** Markdown 预览模式：preview=渲染预览（默认）/ source=源码 */
  const [mdMode, setMdMode] = React.useState<"preview" | "source">("preview");
  // A-918++：diff 模式（当前文件 vs Git HEAD，VS Code 风格红绿行）
  const [diffMode, setDiffMode] = React.useState(false);
  const [diffHead, setDiffHead] = React.useState<string | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffError, setDiffError] = React.useState("");
  // A-918++：切换查看的文件时重置 diff（避免把上一个文件的 HEAD 版本误贴到新文件）
  React.useEffect(() => { setDiffMode(false); setDiffHead(null); setDiffError(""); }, [preview?.rel]);
  /** 左右分栏：左侧文件列表宽度占比（%） */
  const [split, setSplit] = React.useState(40);
  const splitRef = React.useRef<HTMLDivElement>(null);

  /** 拖动分隔条，动态调整列表/预览分栏宽度 */
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const el = splitRef.current;
    if (!el) { return; }
    const onMove = (ev: MouseEvent): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) { return; }
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.min(72, Math.max(22, pct)));
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** 列出浏览根下（或某个子目录）的目录内容 */
  const listDir = React.useCallback(async (root: string, rel: string): Promise<void> => {
    if (!api?.workspace?.list) { setDirError("文件列表接口不可用"); return; }
    setLoadingDir(true);
    setDirError("");
    setPreview(null);
    try {
      const res = await api.workspace.list(root, rel);
      if (res?.ok) { setEntries(res.entries ?? []); }
      else { setDirError(res?.error ?? "读取失败"); setEntries([]); }
    } catch (e) {
      setDirError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoadingDir(false);
    }
  }, [api]);

  /** workspace 变化时，把浏览根切换到工作目录并列出根 */
  React.useEffect(() => {
    if (!workspaceRoot) { return; }
    setBrowseRoot(workspaceRoot);
    setDirStack([]);
    void listDir(workspaceRoot, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspace]);

  /** A-173：聊天消息内打开的文件（fileAbs/fileContent 异步预读完成）→ 内容回来即渲染预览 */
  React.useEffect(() => {
    if (!props.tab.fileAbs) { return; }
    if (props.tab.fileContent) {
      setPreview({
        rel: props.tab.fileAbs, name: props.tab.title ?? props.tab.fileAbs.split(/[\\/]/).pop() ?? props.tab.fileAbs,
        mime: props.tab.fileMime ?? "text", content: props.tab.fileContent, size: 0, truncated: false,
      });
    } else if (props.tab.fileError) {
      setPreview({ rel: props.tab.fileAbs, name: props.tab.title ?? "", mime: "text", content: "", size: 0, error: props.tab.fileError });
    }
    // A-174：依赖 fileContent/fileError——openFileAbs 是异步的，内容回来后 updateTab 才更新 tab 对象，
    // 必须监听这两个字段变化重新渲染预览，否则永远停在「尚未选择文件位置/打开文件夹」空态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tab.fileContent, props.tab.fileError]);

  /** 打开系统文件夹选择对话框，选择后展示所选目录的内容列表（进入文件资源管理器模式） */
  const handlePickFolder = React.useCallback(async (): Promise<void> => {
    if (!api?.workspace?.pickBrowseRoot) { return; }
    setPickingFolder(true);
    try {
      const res = await api.workspace.pickBrowseRoot();
      if (res?.ok && res.path) {
        setBrowseRoot(res.path);
        setDirStack([]);
        setPreview(null);
        void listDir(res.path, "");
      }
    } catch { /* 用户取消或失败，保持原状 */ }
    finally { setPickingFolder(false); }
  }, [api, listDir]);

  const enterDir = (node: WorkspaceEntry): void => {
    setDirStack((prev) => [...prev, node.name]);
    void listDir(browseRoot, curRel ? `${curRel}/${node.name}` : node.name);
  };

  const openFile = async (node: WorkspaceEntry): Promise<void> => {
    if (!api?.workspace?.readFile) { return; }
    try {
      const res = await api.workspace.readFile(browseRoot, node.rel);
      if (res?.ok) {
        setPreview({ rel: node.rel, name: node.name, mime: res.mime, content: res.content, size: node.size, truncated: !!res.truncated });
        setDirError("");
        return;
      }
      setPreview({ rel: node.rel, name: node.name, mime: "text", content: "", size: node.size, error: res?.error ?? "读取失败" });
    } catch (e) {
      setPreview({ rel: node.rel, name: node.name, mime: "text", content: "", size: node.size, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** ←：逐级返回上级目录；在根目录时回 Git 仓库 */
  const goBack = (): void => {
    setCopied(false);
    if (dirStack.length === 0) { props.onBack(); return; }
    const next = dirStack.slice(0, -1);
    setDirStack(next);
    setPreview(null);
    void listDir(browseRoot, next.join("/"));
  };

  const handleCopy = async (text: string): Promise<void> => {
    if (!text) { return; }
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  };

  const crumbPath = curRel ? curRel : browseRoot ? browseRoot : "（尚未选择文件夹）";
  const inBrowse = !!browseRoot;
  /** A-174：聊天消息打开的绝对路径文件（fileAbs 预读完成）→ 即使没有工作目录也要直接渲染预览，不落入"打开文件夹"空态 */
  const isChatOpenedFile = !!props.tab.fileAbs;

  /* ── 空状态：尚未选择任何文件夹（仅普通浏览 tab；聊天打开的文件直接显示内容） ── */
  if (!inBrowse && !isChatOpenedFile) {
    return (
      <div className="right-tab-pane" style={{ padding: "36px 20px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <div style={{ width: 56, height: 56, marginBottom: 16, color: "var(--text-muted)", opacity: 0.7, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg viewBox="0 0 1024 1024" width={48} height={48} fill="currentColor"><path d="M768 128H320L192 256v640a64 64 0 0064 64h512a64 64 0 0064-64V192a64 64 0 00-64-64zm-416 64h224v128H352V192zM768 896H256V320h160v192h352v384z" /></svg>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 500 }}>尚未选择文件位置</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, textAlign: "center", marginBottom: 18 }}>
          点击「打开文件夹」选择任意目录，即可在此浏览和查看文件
        </div>
        <button
          onClick={() => void handlePickFolder()}
          disabled={pickingFolder}
          style={{ padding: "8px 18px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, cursor: pickingFolder ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, opacity: pickingFolder ? 0.6 : 1 }}
        >
          {pickingFolder ? "选择中…" : <><FolderIcon size={13} /> 打开文件夹</>}
        </button>
      </div>
    );
  }

  /* ── 右侧内容预览（与左侧列表同屏分栏展示） ── */
  const renderPreviewBody = (): JSX.Element => {
    if (!preview) {
      // A-174：聊天打开的文件正在读取时给加载提示，而不是空态"从左侧选择文件"
      if (isChatOpenedFile && !props.tab.fileError) {
        return (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: 12, textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 24, opacity: 0.7 }}><LoadingCircleIcon size={24} className="icon-spin" /></div>
            <div>正在读取文件内容…</div>
          </div>
        );
      }
      return (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: 12, textAlign: "center", padding: 20 }}>
          <div style={{ fontSize: 26, opacity: 0.6 }}><ArrowLeftIcon size={26} /></div>
          <div>从左侧选择一个文件查看内容预览</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>压缩包 / 二进制文件会以安全方式展示，不会解析</div>
        </div>
      );
    }
    if (preview.error) {
      return (
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          <div style={{ color: "var(--danger)", fontSize: 13, padding: "10px 12px", background: "rgba(248,81,73,0.08)", borderRadius: 6, wordBreak: "break-all" }}>⚠ {preview.error}</div>
        </div>
      );
    }
    const lowExt = extOf(preview.name);
    // 压缩包 / 归档：友好提示，绝不尝试解析
    if (preview.mime === "binary") {
      const archName = ARCHIVE_NAMES[lowExt];
      const isArchive = !!archName || ARCHIVE_EXT.has(lowExt);
      if (isArchive) {
        return (
          <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center" }}>
            <div style={{ fontSize: 34, opacity: 0.8 }}>🗜️</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{archName ?? "压缩包/归档文件"}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              文件不可直接查看。请在系统资源管理器中解压后再浏览内容。<br />
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>大小：{fmtSize(preview.size)} · {preview.rel}</span>
            </div>
          </div>
        );
      }
      const view = base64ToHexView(preview.content, 512);
      return (
        <div style={{ flex: 1, overflow: "auto", padding: "10px 14px" }}>
          <div style={{ fontSize: 11, color: "var(--warning)", padding: "4px 2px 8px" }}>{BINARY_EXT.has(lowExt) ? "不可直接预览（二进制）" : "二进制文件（十六进制预览）"} · 共 {view.byteLen} 字节{view.truncated ? `，仅显示前 ${512} 字节` : ""}：</div>
          <pre style={{ fontSize: 11, fontFamily: "Consolas, monospace", color: "var(--text-secondary)", padding: 10, background: "var(--bg-hover)", borderRadius: 6, overflow: "auto", whiteSpace: "pre", margin: 0, lineHeight: 1.5 }}>{view.hex || "（无法解析）"}</pre>
        </div>
      );
    }
    const isImage = preview.mime === "image";
    const isMd = lowExt === ".md";
    if (isImage) {
      return (
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          <img src={imageDataUrl(preview.rel, preview.content)} alt={preview.rel} style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
        </div>
      );
    }
    // Markdown：默认渲染预览；可切到源码查看
    if (!diffMode && isMd && mdMode === "preview") {
      return (
        <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
          {preview.content?.trim() ? (
            <div className="markdown-body">
              <Markdown remarkPlugins={[remarkGfm]}>{preview.content}</Markdown>
            </div>
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>（空的 Markdown 文件）</div>
          )}
        </div>
      );
    }
    const lang = langOf(preview.name);
    // A-918++：diff 模式 → 当前文件 vs Git HEAD（VS Code 风格行）
    if (diffMode) {
      if (diffLoading) {
        return <div style={{ flex: 1, padding: 16, color: "var(--text-dim)", fontSize: 12 }}>读取 Git HEAD 版本…</div>;
      }
      if (diffHead === null) {
        return (
          <div style={{ flex: 1, padding: 16, fontSize: 12, color: diffError ? "var(--danger)" : "var(--text-dim)" }}>
            {diffError || "（此文件未纳入 Git / HEAD 无此版本）"}
            <div style={{ marginTop: 8 }}>
              <button className="btn" style={{ padding: "4px 12px", fontSize: 12 }} onClick={() => void toggleDiff()}>返回原文件</button>
            </div>
          </div>
        );
      }
      const dRows = diffLinesFn(diffHead, preview.content);
      let addN = 0, delN = 0;
      for (const r of dRows) { if (r.op === "+") addN++; else if (r.op === "-") delN++; }
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, flexShrink: 0 }}>
            <span style={{ color: "var(--success)", fontWeight: 600 }}>+{addN}</span>
            <span style={{ color: "var(--danger)", fontWeight: 600 }}>−{delN}</span>
            <span style={{ color: "var(--text-dim)" }}>Git HEAD → 当前</span>
            <span style={{ flex: 1 }} />
            <button className="btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => void toggleDiff()}>返回原文件</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: "Consolas, 'Courier New', monospace", fontSize: 11.5, lineHeight: 1.6, background: "var(--bg)" }}>
            {dRows.map((r, i) => (
              <div key={i} className={`think-diff-row diff-${r.op === "=" ? "eq" : r.op === "+" ? "add" : "del"}`} style={{ display: "flex", padding: "0 10px" }}>
                <span className="think-diff-mark" style={{ width: 18, flexShrink: 0, userSelect: "none", fontWeight: 700, color: r.op === "+" ? "var(--diff-add)" : r.op === "-" ? "var(--diff-del)" : "var(--text-dim)" }}>{r.op === "=" ? " " : r.op === "+" ? "+" : "−"}</span>
                <span style={{ whiteSpace: "pre", flex: 1, minWidth: 0, wordBreak: "break-all" }}>{r.text || "\u00A0"}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return (
      <pre style={{ flex: 1, margin: 0, padding: "12px 14px", fontSize: 13, fontFamily: "Consolas, 'Courier New', monospace", lineHeight: 1.6, color: "var(--text)", overflow: "auto", whiteSpace: "pre", tabSize: 2 }}>
        {lang ? highlightCode(preview.content, lang) : preview.content}
      </pre>
    );
  };

  const selectedIsMd = !!preview && preview.mime === "text" && extOf(preview.name) === ".md";
  const canGoUp = dirStack.length > 0;

  /** A-918++：对比改动切换（当前文件 vs Git HEAD）；仅文本文件可用 */
  const toggleDiff = async (): Promise<void> => {
    if (!preview || preview.mime !== "text") { return; }
    if (diffMode) { setDiffMode(false); return; }
    if (!workspaceRoot) { setDiffMode(true); setDiffError("未设置工作目录，无法对比 Git HEAD"); setDiffHead(null); return; }
    setDiffMode(true); setDiffLoading(true); setDiffError(""); setDiffHead(null);
    try {
      const rel = preview.rel ?? "";
      if (!rel) { setDiffError("文件不在工作区内，无法对比 Git"); }
      else {
        const res = await api?.git?.showFile?.(rel, workspaceRoot);
        if (res?.ok) { setDiffHead(res.content ?? ""); }
        else { setDiffError(res?.error ?? "git show 失败"); }
      }
    } catch (e) {
      setDiffError(`对比失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiffLoading(false);
    }
  };

  /* ── 统一布局：顶栏 + 左右分栏（左：文件列表 / 右：内容预览） ── */
  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶栏：← 返回上级 + 路径 + 打开文件夹 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button onClick={goBack} title={canGoUp ? "返回上一级" : "返回 Git 仓库"} disabled={!canGoUp} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", cursor: canGoUp ? "pointer" : "not-allowed", color: canGoUp ? "var(--text-secondary)" : "var(--text-dim)", fontSize: 12, opacity: canGoUp ? 1 : 0.5 }}><ArrowLeftIcon size={14} /></button>
        <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 3 }} title={crumbPath}><FolderIcon size={11} style={{ flexShrink: 0 }} />{crumbPath}</span>
        <button onClick={() => void handlePickFolder()} disabled={pickingFolder} title="打开系统文件夹（可访问任意位置）" style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 11, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3 }}>{pickingFolder ? "选择中…" : <><FolderIcon size={12} /> 打开文件夹</>}</button>
        {preview && preview.mime === "text" && preview.rel && (
          <button onClick={() => void toggleDiff()} title="对比当前文件与 Git HEAD 的改动（红绿 diff）" style={{ background: "transparent", border: `1px solid ${diffMode ? "var(--accent)" : "var(--border)"}`, borderRadius: 4, padding: "2px 7px", cursor: "pointer", color: diffMode ? "var(--accent-hover)" : "var(--text-secondary)", fontSize: 11, flexShrink: 0 }}>{diffMode ? "✓ 对比中" : "对比改动"}</button>
        )}
      </div>

      {/* 左右分栏容器 */}
      <div ref={splitRef} style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
        {/* 左：文件列表 */}
        <div style={{ width: `${split}%`, minWidth: 120, maxWidth: "75%", display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid var(--border)" }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {dirError && (
              <div style={{ padding: "8px 12px", color: "var(--danger)", fontSize: 12, background: "rgba(248,81,73,0.08)", borderBottom: "1px solid var(--border)" }}>⚠ {dirError}</div>
            )}
            {loadingDir && entries.length === 0 && (
              <div style={{ padding: "28px 16px", color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>正在读取…</div>
            )}
            {!loadingDir && entries.length === 0 && !dirError && (
              <div style={{ padding: "28px 16px", color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>（空目录）</div>
            )}
            {/* 文件夹在前，文件在后（保持与列表接口一致的排序） */}
            {entries.filter((e) => e.isDir).map((dir) => (
              <div key={dir.rel} className="file-view-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", cursor: "pointer", borderRadius: 4, margin: "0 6px" }}
                onMouseEnter={(e2) => { e2.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e2) => { e2.currentTarget.style.background = "transparent"; }}
                onClick={() => enterDir(dir)}>
                <FolderIcon size={15} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dir.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>文件夹</span>
              </div>
            ))}
            {entries.filter((e) => !e.isDir).map((file) => (
              <div key={file.rel} className="file-view-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", paddingLeft: 26, cursor: "pointer", borderRadius: 4, margin: "0 6px", background: preview && preview.rel === file.rel ? "var(--bg-hover)" : "transparent" }}
                onMouseEnter={(e2) => { if (!(preview && preview.rel === file.rel)) { e2.currentTarget.style.background = "var(--bg-hover)"; } }}
                onMouseLeave={(e2) => { if (!(preview && preview.rel === file.rel)) { e2.currentTarget.style.background = "transparent"; } }}
                onClick={() => void openFile(file)}>
                <span style={{ fontSize: 13, flexShrink: 0 }}>📄</span>
                <span style={{ fontSize: 12.5, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{fmtSize(file.size)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 分隔条（可拖拽调整分栏） */}
        <div onMouseDown={startResize} title="拖动调整分栏宽度" style={{ width: 4, flexShrink: 0, cursor: "col-resize", position: "relative", zIndex: 1, alignSelf: "stretch" }} />

        {/* 右：内容预览 */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border)", background: "var(--tab-active-bg, #26263a)", flexShrink: 0, minHeight: 28 }}>
            {preview ? (
              <>
                <span style={{ fontSize: 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={preview.rel}>{preview.rel}</span>
                {preview.mime === "text" && !selectedIsMd && (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{detectLang(preview.name)}</span>
                )}
                {selectedIsMd && (
                  <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
                    <button onClick={() => setMdMode("preview")} title="渲染预览" style={{ padding: "2px 8px", fontSize: 11, background: mdMode === "preview" ? "var(--accent)" : "transparent", color: mdMode === "preview" ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>预览</button>
                    <button onClick={() => setMdMode("source")} title="查看源码" style={{ padding: "2px 8px", fontSize: 11, background: mdMode === "source" ? "var(--accent)" : "transparent", color: mdMode === "source" ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>源码</button>
                  </div>
                )}
                {preview.mime === "text" && (
                  <button onClick={() => void handleCopy(preview.content)} title={copied ? "已复制" : "复制内容"} style={{ background: copied ? "rgba(34,197,94,0.15)" : "transparent", border: `1px solid ${copied ? "#22c55e" : "var(--border)"}`, borderRadius: 4, padding: "2px 7px", cursor: "pointer", color: copied ? "#22c55e" : "var(--text-secondary)", fontSize: 11, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3 }}>{copied ? <><CheckIcon size={11} /> 已复制</> : "复制"}</button>
                )}
                {preview.truncated && (
                  <span style={{ fontSize: 10, color: "var(--warning)", flexShrink: 0 }}>内容过长已截断</span>
                )}
              </>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>内容预览</span>
            )}
          </div>
          {renderPreviewBody()}
        </div>
      </div>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) { return `${n}B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)}K`; }
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

/* ══════════════ 任务进度 ══════════════ */

   interface AccumUsage {
  requests: number;
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface ModelPriceInfo {
  price_in_usd?: number;
  price_out_usd?: number;
}

const EMPTY_USAGE: AccumUsage = { requests: 0, elapsedMs: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 0 };

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TaskStatus;
  blockedBy?: string[];
  blocks?: string[];
}

/** 上下文上限：优先 Agent.max_context，其次 Provider 模型规格中的 context_window，最后运行时上游探测元数据。
 *  modelChoice 变化时重算（切模型不重置是 A-4b 修复点）。 */
function useAgentMaxContext(
  agentName: string,
  modelChoice: string | undefined,
  fallback: Array<{ id: string; context_window?: number }> = [],
): number {
  const [cap, setCap] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!api?.agents?.list || !api.agents.detail) { return; }
    api.agents.list()
      .then((list: Array<{ id: string; name: string; model_choice?: string }>) => {
        if (cancelled) { return; }
        const hit = list.find((a) => a.name === agentName) || list[0];
        if (!hit) { return; }
        return api.agents.detail(hit.id) as Promise<{ max_context?: number; model_choice?: string } | null>;
      })
      .then(async (d: { max_context?: number; model_choice?: string } | null) => {
        if (cancelled || !d) { return; }
        if (d.max_context && d.max_context > 0) { setCap(d.max_context); return; }
        // 优先用 caller 传入的 modelChoice（更即时的切模型信号），回退到 detail 返回值
        const choice = modelChoice || d.model_choice || "";
        if (!choice) { setCap(d.max_context ?? 0); return; }
        try {
          const isLocal = choice.startsWith("local:");
          let ctx: number | undefined;
          if (isLocal) {
            const id = choice.slice("local:".length);
            const list2 = await api.providers.localList().catch(() => [] as Array<{ id: string; ctx_len?: number }>);
            const m = list2.find((x: { id: string; ctx_len?: number }) => x.id === id);
            ctx = m?.ctx_len;
          } else {
            // api:<provider_key>[:model_id] 或纯粹 model_id
            const parts = choice.split(":");
            const modelId = parts[parts.length - 1];
            const key = parts.length >= 2 ? parts[0] : null;
            if (key && api.providers.list) {
               const providers = await api.providers.list().catch(() => [] as Array<{ key: string; models?: Array<{ id: string; context_window?: number }> }>);
               const prov = providers.find((p: { key: string; models?: Array<{ id: string; context_window?: number }> }) => p.key === key);
              const m = prov?.models?.find((x: { id: string; context_window?: number }) => x.id === modelId);
              ctx = m?.context_window;
            } else if (!key && api.providers.list) {
              // 无 key 时尝试在全部 provider 中查找
              const providers = await api.providers.list().catch(() => [] as Array<{ key: string; models?: Array<{ id: string; context_window?: number }> }>);
               for (const p of providers) {
                 const m = p.models?.find((x: { id: string; context_window?: number }) => x.id === modelId);
                if (m) { ctx = m.context_window; break; }
              }
            }
          }
          if (ctx && ctx > 0) { setCap(ctx); return; }
          // 运行时上游元数据兜底（App 已实时探测并透传，优先于未回写的存储规格）
          const fbId = choice.includes(":") ? choice.split(":").pop()! : choice;
          const fallbackHit = fallback.find((m) => m.id === fbId);
          if (fallbackHit?.context_window && fallbackHit.context_window > 0) { setCap(fallbackHit.context_window); return; }
        } catch { /* ignore */ }
        setCap(d.max_context ?? 0);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [agentName, modelChoice]);
  return cap;
}

function computeModelCost(modelId: string, promptTokens: number, completionTokens: number, cache: Map<string, ModelPriceInfo>): number {
  if (!modelId) { return 0; }
  const spec = cache.get(modelId);
  if (!spec?.price_in_usd || !spec.price_out_usd) { return 0; }
  return (promptTokens * spec.price_in_usd + completionTokens * spec.price_out_usd) / 1_000_000;
}

function TasksTab(props: { agentId: string; sessionId: string; agentName: string; workspace: string; dl: Record<string, DownloadProgressInfo>; providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>; active?: boolean }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const modelPricesRef = React.useRef<Map<string, ModelPriceInfo>>(new Map());
  /** 当前 Agent 的 model_choice（切模型时重算 ctx 上限 + 定价，A-4b 修复点） */
  const [modelChoice, setModelChoice] = React.useState<string | undefined>(undefined);
  const active = props.active !== false;
  // A-918++：流式输出监测——仅流式时显示"会话指标"，平时隐藏（订阅 chat onChunk/onDone/onError）
  const [isStreaming, setIsStreaming] = React.useState(false);
  React.useEffect(() => {
    const off1 = api.chat?.onChunk?.(() => setIsStreaming(true));
    const off2 = api.chat?.onDone?.(() => setIsStreaming(false));
    const off3 = api.chat?.onError?.(() => setIsStreaming(false));
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [api]);
  // A-918++：空闲态动态激励语（「会话指标」框内轮播，4s 一句；复用 idlePhrases 单一数据源）
  const [idlePhraseIdx, setIdlePhraseIdx] = React.useState(0);
  React.useEffect(() => {
    const iv = window.setInterval(() => { setIdlePhraseIdx((i) => (i + 1) % IDLE_PHRASES.length); }, 4000);
    return () => window.clearInterval(iv);
  }, []);
  React.useEffect(() => {
    if (!active) { return; }
    let cancelled = false;
    const refreshModel = async (): Promise<void> => {
      try {
        const list = await api.agents.list?.();
        if (cancelled || !list) { return; }
        const hit = (list as Array<{ id: string; name: string }>).find((a) => a.name === props.agentName) || (list as Array<{ id: string }>)[0];
        if (!hit) { return; }
        const d = await api.agents.detail(hit.id) as { model_choice?: string } | null;
        if (cancelled) { return; }
        if (d?.model_choice !== undefined) { setModelChoice(d.model_choice); }
      } catch { /* ignore */ }
    };
    void refreshModel();
    const timer = setInterval(() => { void refreshModel(); }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.agentName, active]);
  /** 定期刷新模型定价缓存；切模型时由 modelChoice 变化主动 refresh 一次（A-4b） */
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const ps = await api.providers.list();
        if (cancelled) { return; }
        const m = new Map<string, ModelPriceInfo>();
        for (const p of ps) {
          for (const mod of (p.models ?? [])) {
            if (mod.price_in_usd || mod.price_out_usd) {
              m.set(mod.id, { price_in_usd: mod.price_in_usd, price_out_usd: mod.price_out_usd });
            }
          }
        }
        modelPricesRef.current = m;
      } catch { /* ignore */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [modelChoice]);
  const [events, setEvents] = React.useState<TaskEvent[]>([]);
  const [running, setRunning] = React.useState(false);
  const idRef = React.useRef(0);
  /** 从 localStorage 持久化恢复：key 按「agentId + sessionId」聚合（会话级），
   *  会话切换时重新读取，避免多会话任务串联混淆（A-919） */
  const loadPersisted = React.useCallback(() => {
    try {
      const raw = localStorage.getItem(`slime_tasks_${props.agentId}_${props.sessionId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { usage: AccumUsage; todos: TodoItem[] };
        return parsed;
      }
    } catch { /* 忽略 */ }
    return null;
  }, [props.agentId, props.sessionId]);
  const persisted = loadPersisted();
  const [usage, setUsage] = React.useState<AccumUsage>(persisted?.usage ?? EMPTY_USAGE);
  /** A-933：窗口占用（右栏 ContextWindowBar）与右上角 ContextRing **同源**——最近一次 done 的
   *  输入侧 tokens（prompt + cache read）与权威 windowCap（主进程按 Agent/模型解析下发）。
   *  与 usage（四项累计，配 MetricsGrid 费用/消耗统计）语义分离，互不混用。 */
  const [liveUsed, setLiveUsed] = React.useState(0);
  const [liveCap, setLiveCap] = React.useState(0);
  // A-939：上下文分桶（随 done 事件/单一事件源传入；缺省 undefined 回退到 compose 的旧展示）
  const [liveBuckets, setLiveBuckets] = React.useState<CtxBuckets | undefined>(undefined);
  /** A-935：会话 ID 实时引用——订阅闭包读 ref 而非陈旧 props（根治切会话后 done/事件被旧值误过滤，
   *  导致右栏不更新/慢于圆环的根因）；组件随会话切换不重建本闭包也不受影响 */
  const sessionIdRef = React.useRef(props.sessionId);
  React.useEffect(() => { sessionIdRef.current = props.sessionId; }, [props.sessionId]);
  /** A-935：订阅上下文占用单一事件源（发送估算 / done 真实校准）——与右上角环严格同源同时变更 */
  React.useEffect(() => {
    const off = onCtxUpdate((p) => {
      if (p.sessionId !== sessionIdRef.current) { return; }
      if (p.used > 0) { setLiveUsed(p.used); }
      if (p.cap > 0) { setLiveCap(p.cap); }
      // A-939：单事件源里带分桶数据，同步落状态
      if (p.buckets) { setLiveBuckets(p.buckets); }
    });
    return off;
  }, []);
  /** A-934：重启恢复——右栏窗口占用随会话元数据还原（与右上角环同源读取同一 key）；
   *  无持久化占用 → 显式置 0，防残留上一会话数值（切会话不同步的根因） */
  React.useEffect(() => {
    const meta = readSessionCtxMeta(props.agentId, props.sessionId);
    setLiveUsed(restoreUsed(meta));
    if (meta?.cap && meta.cap > 0) { setLiveCap(meta.cap); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.agentId, props.sessionId]);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const flatFallback = React.useMemo(
    () => (props.providerModels ?? []).flatMap((p) => (p.models ?? []).map((m) => ({ id: m.id, context_window: m.context_window }))),
    [props.providerModels],
  );
  const maxCtx = useAgentMaxContext(props.agentName, modelChoice, flatFallback);
  const [todos, setTodos] = React.useState<TodoItem[]>(persisted?.todos ?? []);
  const [collapsedTodos, setCollapsedTodos] = React.useState(false);
  /** A-937：底部「活动记录 / 会话文件」双 tab */
  const [logTab, setLogTab] = React.useState<"activity" | "files">("activity");
  const [todoInput, setTodoInput] = React.useState("");
    // 变更时写回 localStorage（防抖：React state 更新周期内仅落盘一次）；key 会话级
    const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushPersist = React.useCallback(() => {
      if (persistTimerRef.current !== null) { clearTimeout(persistTimerRef.current); }
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        try { localStorage.setItem(`slime_tasks_${props.agentId}_${props.sessionId}`, JSON.stringify({ usage, todos })); } catch { /* 忽略 */ }
      }, 300);
    }, [props.agentId, props.sessionId, usage, todos]);
    React.useEffect(() => { void flushPersist(); }, [flushPersist]);
    // A-919：会话切换联动——切到新会话立即重读该会话任务并主动向主进程拉取
    // （todo_write 落盘 data/todos_<sessionId>.json；广播 slime:tasks:todos 双保险）
    React.useEffect(() => {
      const p = loadPersisted();
      if (p) { setTodos(p.todos); setUsage(p.usage); } else { setTodos([]); setUsage(EMPTY_USAGE); }
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      void api?.tasks?.loadTodos?.(props.sessionId).catch(() => {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.sessionId]);
    // 订阅主进程推送的任务列表（todo_write 工具写入后由主进程广播；按 sessionId 过滤）
    React.useEffect(() => {
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      if (!api?.tasks?.onTodos) { return; }
      const off = api.tasks.onTodos((data: { sessionId: string; todos: Array<{ id: string; content: string; status: string }> }) => {
        if (props.sessionId && data.sessionId !== props.sessionId) { return; }
        const mapped: TodoItem[] = data.todos.map((t) => ({
          id: t.id ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          content: t.content,
          status: (t.status as TaskStatus) ?? "pending",
        }));
        setTodos(mapped);
      });
      return () => { off(); };
    }, [props.sessionId]);

  const toggleTodoCollapse = React.useCallback(() => setCollapsedTodos((v) => !v), []);

  const addTodo = React.useCallback(() => {
    const content = todoInput.trim();
    if (!content) { return; }
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTodos((prev) => [...prev, { id, content, status: "pending" }]);
    setTodoInput("");
  }, [todoInput]);

  const toggleTodo = React.useCallback((id: string) => {
    setTodos((prev) => prev.map((t) => {
      if (t.id !== id) { return t; }
      return { ...t, status: t.status === "completed" ? "pending" : "completed" };
    }));
  }, []);

  const advanceTodo = React.useCallback((id: string) => {
    setTodos((prev) => prev.map((t) => {
      if (t.id !== id || t.status === "completed") { return t; }
      return { ...t, status: "in_progress" };
    }));
  }, []);

  const deleteTodo = React.useCallback((id: string) => {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushEvent = React.useCallback((kind: TaskEvent["kind"], label: string): void => {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    setEvents((prev) => [{ id: ++idRef.current, time, kind, label }, ...prev].slice(0, 200));
  }, []);

  React.useEffect(() => {
    if (!api?.chat) { return; }
    const off1 = api.chat.onChunk((c: { type?: string; data?: any }) => {
      const t = c?.type;
      if (t === "tool") {
        const name = c.data?.name ?? "";
        pushEvent("tool", name.startsWith("delegate:") ? ` 传唤子 Agent「${name.slice(9)}」` : `⟳ 调用工具 ${name}`);
      } else if (t === "reasoning") { setRunning(true); }
      else if (t === "progress") { pushEvent("progress", c.data?.progress ?? c.data?.content ?? "子任务进行中…"); }
      else if (t === "chunk") { setRunning(true); }
    });
    const off2 = api.chat.onDone((m: { interrupted?: boolean; timings?: Record<string, number>; model?: string; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }) => {
      // A-933 会话隔离：本面板只记账当前会话的流（用实时 ref，杜绝陈旧 props 误过滤）
      if (m.sessionId != null && m.sessionId !== sessionIdRef.current) { return; }
      setRunning(false);
      pushEvent("done", m?.interrupted ? "⏹ 已中断" : "✓ 回复完成");
      const t = m?.timings ?? {};
      const pt = typeof t.promptTokens === "number" ? t.promptTokens : 0;
      const ct = typeof t.completionTokens === "number" ? t.completionTokens : 0;
      const rt = typeof t.reasoningTokens === "number" ? t.reasoningTokens : 0;
      const cr = typeof t.cacheReadTokens === "number" ? t.cacheReadTokens : 0;
      const em = typeof t.elapsedMs === "number" ? t.elapsedMs : 0;
      // 费用计算：从模型缓存读取定价；无定价时 cost=0
      const cost = computeModelCost(m?.model ?? "", pt, ct, modelPricesRef.current);
      setUsage((prev) => ({
        requests: prev.requests + 1, elapsedMs: prev.elapsedMs + em,
        promptTokens: prev.promptTokens + pt, completionTokens: prev.completionTokens + ct,
        reasoningTokens: prev.reasoningTokens + rt, cacheReadTokens: prev.cacheReadTokens + cr,
        costUsd: prev.costUsd + cost,
      }));
    });
    const off3 = api.chat.onError((e: { message?: string }) => {
      setRunning(false);
      pushEvent("error", `✕ ${e?.message ?? "出错"}`);
    });
    let off4: (() => void) | undefined;
    if (api.chat.onNewConversation) {
      off4 = api.chat.onNewConversation(() => { setEvents([]); setUsage(EMPTY_USAGE); setTodos([]); });
    }
    // 会话切换时重置持久化（新会话从零开始）
    const off5 = api.conversations?.onChanged?.(() => {
      // 当前选中的 sessionId 通过 props 不可得，但 onNewConversation 已处理重置逻辑；
      // 切会话时 onNewConversation 会触发（ChatPanel 切换 sessionId）——若未触发，则切会话
      // 本身也会卸载本组件；卸载时 flushPersist 已保存旧值，新挂载会从 localStorage 加载。
    });
    return () => { off1(); off2(); off3(); off4?.(); off5?.(); };
  }, [api, pushEvent, modelPricesRef]);

  const badge = (k: TaskEvent["kind"]): { color: string; bg: string; text: string } => {
    switch (k) {
      case "tool": return { color: "var(--accent)", bg: "var(--accent-soft)", text: "工具" };
      case "thinking": return { color: "var(--accent-hover)", bg: "var(--accent-soft)", text: "思考" };
      case "progress": return { color: "var(--warning)", bg: "rgba(251,191,36,0.12)", text: "进度" };
      case "done": return { color: "var(--success)", bg: "var(--success-soft)", text: "完成" };
      case "error": return { color: "var(--danger)", bg: "var(--danger-soft)", text: "失败" };
    }
  };

  const todoBadge = (status: TaskStatus): { color: string; bg: string; dot: string } => {
    switch (status) {
      case "pending": return { color: "var(--text-muted)", bg: "transparent", dot: "var(--text-muted)" };
      case "in_progress": return { color: "var(--accent)", bg: "var(--accent-soft)", dot: "var(--accent)" };
      case "completed": return { color: "var(--success)", bg: "var(--success-soft)", dot: "var(--success)" };
    }
  };

  const dlActive = (Object.values(props.dl) as DownloadProgressInfo[]).filter((d) => d.state === "downloading" || d.state === "paused");
  const todoDone = todos.filter((t) => t.status === "completed").length;
  const todoPct = todos.length > 0 ? Math.round((todoDone / todos.length) * 100) : 0;

  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="right-pane-head">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <DashboardIcon size={13} style={{ color: "var(--text-muted)" }} />
          <span className="right-pane-title">会话概览</span>
        </span>
        <span className={`right-run-dot${running ? " on" : ""}`} title={running ? "Agent 工作中" : "空闲"} />
      </div>

      <div style={{ padding: "4px 10px", fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>Agent：{props.agentName || "（未选择）"}</div>

      {dlActive.length > 0 && (
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 4 }}>依赖下载</div>
          {dlActive.map((d) => (
            <div key={d.target} style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-secondary)" }}>
                <span>{d.target === "llama" ? "llama.cpp" : "BGE-M3"}</span>
                <span>{d.state === "paused" ? "已暂停" : `${Math.round(d.percent)}%`}</span>
              </div>
              <div className="dl-bar"><div className="dl-bar-inner" style={{ width: `${Math.min(100, d.percent)}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="right-scroll" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* A-918++：会话指标仅在流式输出时显示（用户要"输出监测时显示，不是平时显示"）；平时显示占位 */}
        <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
            <span>会话指标</span>
            {isStreaming && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", animation: "thinkGlow 1.4s ease-in-out infinite", flexShrink: 0 }} />}
          </div>
          {isStreaming ? (
            <MetricsGrid usage={usage} />
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "6px 0", lineHeight: 1.6, opacity: 0.9 }}>
              {IDLE_PHRASES[idlePhraseIdx]}
            </div>
          )}
        </div>

        <div style={{ borderBottom: "1px solid var(--border)", padding: "8px 10px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <button onClick={toggleTodoCollapse} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <ChevronIcon rotate={collapsedTodos ? 90 : 0} size={12} style={{ color: "var(--text-muted)" }} />
              <TodoListIcon size={13} style={{ color: "var(--text-muted)" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>待办任务</span>
              {todos.length > 0 && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontWeight: 700 }}>{todoDone}/{todos.length}</span>}
            </button>
            <button onClick={() => setTodos((prev) => prev.filter((t) => t.status !== "completed"))} style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", fontSize: 10, color: "var(--text-muted)" }} title="清除已完成">清完成</button>
          </div>
          {todos.length > 0 && (
            <div style={{ height: 3, borderRadius: 999, background: "var(--input-bg)", overflow: "hidden", marginBottom: 6 }}>
              <div style={{ width: `${todoPct}%`, height: "100%", background: "var(--success)", borderRadius: 999, transition: "width .3s ease" }} />
            </div>
          )}
          {!collapsedTodos && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 200, overflowY: "auto", marginBottom: 6 }}>
              {todos.length === 0 && <div className="tree-hint" style={{ padding: "12px 0", fontSize: 11.5 }}>暂无任务 — Agent 规划后会自动显示，也可手动添加</div>}
              {todos.map((todo) => {
                const b = todoBadge(todo.status);
                return (
                  <div key={todo.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 5, background: todo.status === "in_progress" ? "var(--accent-soft)" : "transparent", borderLeft: `2px solid ${b.dot}` }}>
                    <button onClick={() => toggleTodo(todo.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center" }} title={todo.status === "completed" ? "标记为未完成" : "标记为完成"}>
                      {todo.status === "completed" ? <CheckboxCheckedIcon size={15} style={{ color: "var(--success)" }} /> : <CheckboxIcon size={15} style={{ color: "var(--text-muted)" }} />}
                    </button>
                    <button onClick={() => advanceTodo(todo.id)} style={{ background: "none", border: "none", cursor: todo.status === "pending" ? "pointer" : "default", padding: 0, display: "flex", alignItems: "center", opacity: todo.status === "pending" ? 0.5 : 1 }} title="标记为进行中">
                      {todo.status === "in_progress" ? <LoadingCircleIcon size={13} className="icon-spin" style={{ color: "var(--accent)" }} /> : <span style={{ width: 13, height: 13, display: "inline-block" }} />}
                    </button>
                    <span style={{ flex: 1, fontSize: 11.5, color: todo.status === "completed" ? "var(--text-muted)" : "var(--text-primary)", textDecoration: todo.status === "completed" ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{todo.content}</span>
                    <button onClick={() => deleteTodo(todo.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: "1px 3px", fontSize: 10, color: "var(--text-muted)", lineHeight: 1 }} title="删除"><CloseIcon size={10} /></button>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", gap: 4 }}>
            <input value={todoInput} onChange={(e) => setTodoInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTodo(); }} placeholder="添加任务…" style={{ flex: 1, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", fontSize: 11.5, color: "var(--text-primary)", outline: "none" }} />
            <button onClick={addTodo} style={{ background: "var(--accent-soft)", border: "none", borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", padding: "4px 6px" }} title="添加任务">
              <CirclePlusIcon size={13} style={{ color: "var(--accent)" }} />
            </button>
          </div>
        </div>

        {/* A-937：上下文消耗进度条 + token 构成 + 明细折叠（取代原"Metrics 下明细 / 已用 标签位"） */}
        <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          <ContextWindowBar
            used={liveUsed}
            cap={liveCap > 0 ? liveCap : maxCtx}
            compressCount={0}
            compose={{ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, reasoningTokens: usage.reasoningTokens, cacheReadTokens: usage.cacheReadTokens }}
            buckets={liveBuckets}
            detailOpen={detailOpen}
            onToggleDetail={() => setDetailOpen((v) => !v)}
          />
          {detailOpen && <UsageBreakdown usage={usage} detailOpen={detailOpen} onToggleDetail={() => setDetailOpen((v) => !v)} />}
        </div>

        {/* A-937：分隔线 + 活动记录 / 会话文件 并列 tab（横向收纳） */}
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 2, padding: "6px 10px 0" }}>
            {(["activity", "files"] as const).map((t) => (
              <button key={t} onClick={() => setLogTab(t)} style={{ padding: "5px 12px", fontSize: 11.5, borderRadius: "6px 6px 0 0", border: "none", cursor: "pointer", background: "none", color: logTab === t ? "var(--accent)" : "var(--text-muted)", borderBottom: logTab === t ? "2px solid var(--accent)" : "2px solid transparent", fontWeight: logTab === t ? 700 : 500 }}>
                {t === "activity" ? "活动记录" : "会话文件"}
                {t === "activity" && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.8 }}>{events.length}</span>}
              </button>
            ))}
          </div>
          <div style={{ padding: "8px 10px 16px" }}>
            {logTab === "activity" ? (
              <>
                {events.length === 0 && <div className="tree-hint">暂无活动 — Agent 开始工作后，工具调用 / 思考 / 进度会实时显示在这里</div>}
                {events.map((ev) => {
                  const b = badge(ev.kind);
                  return (
                    <div key={ev.id} className="task-row">
                      <span className="task-time">{ev.time}</span>
                      <span className="task-badge" style={{ color: b.color, background: b.bg }}>{b.text}</span>
                      <span className="task-label" title={ev.label}>{ev.label}</span>
                    </div>
                  );
                })}
              </>
            ) : (
              (() => {
                // A-937：当前会话文件 = 事件流中真实访问过的文件（去重），替换原写死占位
                const seen = new Set<string>();
                const files: string[] = [];
                for (const ev of events) {
                  const m = ev.label?.match(/([\w./\-\\\u4e00-\u9fa5]+\.(?:tsx?|jsx?|py|json|md|ya?ml|toml|css|html|sh|rs|go|cpp|c|h|txt|log|ini|env))(?=$|[,\s;]|"|')/i);
                  if (m?.[1] && !seen.has(m[1])) { seen.add(m[1]); files.push(m[1]); }
                }
                return files.length > 0
                  ? files.map((f) => <div key={f} style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.8, wordBreak: "break-all" }}>{f}</div>)
                  : <div className="tree-hint">暂无文件记录 — 会话中访问文件后自动收集</div>;
              })()
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A-937：子代理工作台——并行派发的 subagent 目标/状态/摘要（对标 Claude Code Agent View，
 *  4s 轻轮询 slime:resident:state；每个 subagent 独立上下文，主会话只见摘要）。 */
function SubAgentsTab(): JSX.Element {
  const [runs, setRuns] = React.useState<Array<{ id?: string; name?: string; task?: string; status?: string; result?: string }>>([]);
  const [delegateInput, setDelegateInput] = React.useState("");
  const [delegating, setDelegating] = React.useState(false);
  const refreshRef = React.useRef<() => void>(() => {});
  if (!refreshRef.current) {
    refreshRef.current = (): void => {
      const w = window as unknown as { slimeAPI?: any };
      void w.slimeAPI?.resident?.state?.().then((s: { subagents?: Array<Record<string, unknown>> }) => {
        if (Array.isArray(s?.subagents)) { setRuns(s.subagents as Array<{ id?: string; name?: string; task?: string; status?: string; result?: string }>); }
      }).catch(() => {});
    };
  }
  React.useEffect(() => {
    refreshRef.current();
    // A-918++：订阅后台实时推送（subagent start/complete 立即触发，4s 轮询作兜底）
    const w = window as unknown as { slimeAPI?: any };
    const off = w.slimeAPI?.resident?.onUpdate?.(() => { refreshRef.current(); });
    const iv = window.setInterval(() => refreshRef.current(), 4000);
    return () => { off?.(); window.clearInterval(iv); };
  }, []);

  /** 取消运行中/排队中的子代理（A-938 preload 转发 slime:resident:subagent:cancel） */
  const handleCancel = (id: string | undefined): void => {
    if (!id) { return; }
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.subagentCancel?.(id).then(() => refreshRef.current()).catch(() => {});
  };
  /** 手动按 description 自动委派（命中 代码审查/调研/数据分析 专家） */
  const handleDelegate = (): void => {
    const task = delegateInput.trim();
    if (!task || delegating) { return; }
    setDelegating(true);
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.subagentDelegate?.({ task })
      .then(() => { setDelegateInput(""); refreshRef.current(); })
      .catch(() => {})
      .finally(() => setDelegating(false));
  };

  const stMeta: Record<string, { txt: string; c: string; bg: string }> = {
    pending: { txt: "排队中", c: "var(--text-muted)", bg: "rgba(139,148,158,0.14)" },
    running: { txt: "执行中", c: "#d29922", bg: "rgba(210,153,34,0.15)" },
    done: { txt: "已完成", c: "#2ea043", bg: "rgba(46,160,67,0.15)" },
    fail: { txt: "失败", c: "#f85149", bg: "rgba(248,81,73,0.16)" },
    timeout: { txt: "超时", c: "#d29922", bg: "rgba(210,153,34,0.15)" },
    cancelled: { txt: "已取消", c: "var(--text-muted)", bg: "rgba(139,148,158,0.14)" },
  };

  const active = (s: string | undefined): boolean => s === "pending" || s === "running";

  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="right-pane-head">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <AgentIcon size={13} style={{ color: "var(--text-muted)" }} />
          <span className="right-pane-title">子代理工作台</span>
        </span>
      </div>
      <div className="right-scroll" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, borderBottom: "1px solid var(--border)" }}>
          主 Agent 派发的子代理在此**并行执行**，每个子代理拥有独立上下文窗口——原始产出只以摘要回到主会话，主上下文不被污染。
        </div>
        {/* 手动按 description 自动委派（命中 代码审查/调研/数据分析 专家，A-938 preload 已转发 delegate IPC） */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 4 }}>
          <input
            value={delegateInput}
            onChange={(e) => setDelegateInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { handleDelegate(); } }}
            placeholder="委派任务描述…（自动匹配专家）"
            style={{ flex: 1, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", fontSize: 11.5, color: "var(--text-primary)", outline: "none" }}
          />
          <button
            onClick={handleDelegate}
            disabled={!delegateInput.trim() || delegating}
            style={{ background: "var(--accent-soft)", border: "none", borderRadius: 4, cursor: delegateInput.trim() && !delegating ? "pointer" : "default", padding: "4px 10px", fontSize: 11.5, fontWeight: 700, color: delegateInput.trim() && !delegating ? "var(--accent-hover)" : "var(--text-muted)", whiteSpace: "nowrap" }}
            title="按描述自动匹配专家子代理并后台执行"
          >
            {delegating ? "委派中…" : "委派"}
          </button>
        </div>
        {runs.length === 0 && (
          <div className="tree-hint" style={{ padding: "16px 12px", lineHeight: 1.6 }}>
            暂无子代理任务。<br />可到 [设置 → 后台任务] 手动/定时派发；对话中让 Agent 调用子代理工具时也会在此展示进度与目标。
          </div>
        )}
        {runs.map((r, i) => {
          const st = stMeta[r.status ?? ""] ?? stMeta.pending;
          return (
            <div key={r.id ?? i} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name || "子代理"}</span>
                <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, color: st.c, background: st.bg, fontWeight: 700 }}>{st.txt}</span>
                {r.status === "running" && <span className="icon-spin" style={{ fontSize: 11, color: "var(--accent)" }}>●</span>}
                {active(r.status) && (
                  <button
                    onClick={() => handleCancel(r.id)}
                    style={{ marginLeft: "auto", background: "none", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", padding: "1px 7px", fontSize: 10, color: "var(--text-muted)" }}
                    title="取消该子代理（运行中中断 / 排队中直接取消）"
                  >
                    取消
                  </button>
                )}
              </div>
              {r.task && <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.task}</div>}
              {r.status === "done" && r.result && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 6, borderLeft: "2px solid var(--border)", paddingLeft: 8, maxHeight: 96, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.result}</div>
              )}
              {r.status === "fail" && <div style={{ fontSize: 11, color: "#f85149", marginTop: 6 }}>任务失败，详见摘要/日志</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── 任务页辅助组件 ── */

/** A-939 上下文分桶构成（对齐引擎 computeContextBuckets 的 8 来源；色标取自 Cursor 3.3 Context Buckets 配色惯例） */
function bucketComps(b: CtxBuckets): Array<{ label: string; pct: number; color: string; n: number }> {
  const B = [
    { label: "身份", n: b.system },
    { label: "规则", n: b.rules },
    { label: "记忆", n: b.memory },
    { label: "工作区", n: b.workspace },
    { label: "规划", n: b.planning },
    { label: "工具", n: b.tools },
    { label: "历史", n: b.history },
    { label: "消息", n: b.message },
  ];
  const CP = "#60a5fa";  // system
  const CR = "#34d399";  // rules
  const CM = "#f472b6";  // memory
  const CW = "#fbbf24";  // workspace
  const CPL = "#a78bfa"; // planning
  const CT = "#fb923c"; // tools
  const CH = "#94a3b8"; // history
  const CMSG = "#38bdf8"; // message
  const palette = [CP, CR, CM, CW, CPL, CT, CH, CMSG];
  // 归一分桶占比由 contextMath.bucketsSegments 统一保证（F 单测锁定），此处取色板拼装
  const { segments } = bucketsSegments(B.map((x) => ({ key: x.label, tokens: x.n })));
  return B.map((x, i) => {
    const s = segments.find((q) => q.key === x.label);
    return { ...x, pct: s?.pct ?? 0, color: palette[i] };
  });
}

function ContextWindowBar({ used, cap, compressCount, compose, buckets, detailOpen, onToggleDetail }: {
  used: number; cap: number; compressCount: number;
  /** A-937：token 构成（四项累计）→ 进度条下方 4 色构成微条 + 图例，让"已用"不再是黑盒 */
  compose?: { promptTokens: number; completionTokens: number; reasoningTokens: number; cacheReadTokens: number };
  /** A-939：上下文分桶（按注入来源切分，对齐 Cursor Context Buckets 理念） */
  buckets?: CtxBuckets;
  detailOpen?: boolean; onToggleDetail?: () => void;
}): JSX.Element {
  const pct = contextRatio(used, cap);
  const pctLabel = contextPct(pct);
  const status = cap === 0
    ? { txt: "上限未配置", cls: "var(--text-muted)", bg: "rgba(139,148,158,0.14)" }
    : pct < 0.6 ? { txt: "上下文充足", cls: "#2ea043", bg: "rgba(46,160,67,0.15)" }
      : pct < 0.85 ? { txt: "接近上限", cls: "#d29922", bg: "rgba(210,153,34,0.15)" }
        : { txt: "逼近硬阈值", cls: "#f85149", bg: "rgba(248,81,73,0.16)" };
  const color = ringLevel(pct).color;
  // token 构成占比（经 contextMath 纯函数，F 单测锁定）
  const { segments: comps, any: hasCompose } = composeSegments({
    promptTokens: compose?.promptTokens ?? 0,
    cacheReadTokens: compose?.cacheReadTokens ?? 0,
    completionTokens: compose?.completionTokens ?? 0,
    reasoningTokens: compose?.reasoningTokens ?? 0,
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 9px", borderRadius: 999, fontWeight: 700, fontSize: 11, color: status.cls, background: status.bg }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: status.cls }} />
          {status.txt}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{fmtK(used)}/{cap > 0 ? fmtK(cap) : "-"}</span>
      </div>
      <div style={{ position: "relative", margin: "2px 0 10px", height: 8, borderRadius: 999, background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", overflow: "hidden" }}>
        <div aria-hidden style={{ position: "absolute", left: "80%", top: 0, bottom: 0, width: 1, background: "rgba(139,148,158,0.55)" }} />
        <div style={{ position: "absolute", left: 2, top: -18, fontSize: 10.5, color: color, fontWeight: 700 }}>{pctLabel}%</div>
        <div style={{ position: "absolute", right: 4, top: -18, fontSize: 10.5, color: "var(--text-muted)", fontWeight: 600 }}>80%</div>
        {pct > 0 && <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 999, transition: "width .25s ease" }} />}
      </div>
      {/* A-937：token 构成微条（四项占比）——"已用"不再是黑盒 */}
      {hasCompose && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>构成</span>
          <div style={{ flex: 1, display: "flex", height: 4, borderRadius: 999, overflow: "hidden", background: "var(--input-bg)" }}>
            {comps.map((c) => c.pct > 0 && <div key={c.label} title={`${c.label} ${fmtK(c.n)}`} style={{ width: `${c.pct}%`, background: c.color }} />)}
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {comps.filter((c) => c.n > 0).map((c) => (
              <span key={c.label} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "var(--text-muted)" }}>
                <span style={{ width: 6, height: 6, borderRadius: 2, background: c.color }} />{c.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* A-939：上下文分桶（按注入来源）——"已用"各来源细目，对齐 Cursor Context Buckets 理念 */}
      {buckets && (buckets.system + buckets.rules + buckets.memory + buckets.workspace + buckets.planning + buckets.tools + buckets.history + buckets.message) > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4, marginTop: 2 }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>来源</span>
          <div style={{ flex: 1, display: "flex", height: 4, borderRadius: 999, overflow: "hidden", background: "var(--input-bg)" }}>
            {bucketComps(buckets).map((c) => c.pct > 0 && <div key={c.label} title={c.label + " " + fmtK(c.n)} style={{ width: c.pct + "%", background: c.color }} />)}
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0, overflow: "hidden" }}>
            {bucketComps(buckets).filter((c) => c.n > 0).map((c) => (
              <span key={c.label} title={c.label + ": " + c.n.toLocaleString()} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                <span style={{ width: 5, height: 5, borderRadius: 2, background: c.color, flexShrink: 0 }} />{c.label}
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>
        <button onClick={onToggleDetail} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: "1px 4px", fontSize: 10.5, color: "var(--text-secondary)" }} title={detailOpen ? "收起明细" : "展开 token 明细"}>
          <span style={{ fontSize: 8, transform: detailOpen ? "rotate(90deg)" : "none", transition: "transform .2s", color: "var(--text-muted)" }}>▶</span>
          明细 {detailOpen ? "收起" : "展开"}
        </button>
        <span>距压缩 {compressCount}</span>
      </div>
    </div>
  );
}

function MetricsGrid({ usage }: { usage: AccumUsage }): JSX.Element {
  // 分母用 promptTokens 本身：Anthropic/OpenAI 的 input_tokens 已包含 cache_read 部分，
  // 避免「promptTokens + cacheReadTokens」重复计入导致命中率低估。
  const cacheHit = usage.promptTokens > 0 ? (usage.cacheReadTokens / usage.promptTokens) * 100 : 0;
  const items: Array<[string, string, boolean?]> = [
    ["平均命中", usage.requests === 0 ? "—" : `${cacheHit.toFixed(cacheHit === 0 ? 0 : cacheHit < 0.95 ? 1 : 0)}%`],
    ["运行时间", fmtMsSmart(usage.elapsedMs)],
    ["累计 tokens", fmtK(usage.promptTokens + usage.completionTokens + usage.reasoningTokens + usage.cacheReadTokens)],
    ["会话费用", usage.requests === 0 ? "—（未配置单价）" : usage.costUsd === 0 ? "—" : `¥${(usage.costUsd * 7.25).toFixed(4)}`],
    ["请求数", String(usage.requests)],
    ["", "—"],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
      {items.map(([k, v, bigRight], i) => (
        <div key={i} style={{ padding: "8px 10px", border: "1px solid var(--border)", marginBottom: -1, marginRight: i % 2 === 0 ? -1 : 0, marginTop: i > 1 ? -1 : 0, background: "var(--input-bg, #161b22)", borderRadius: 0, minHeight: 48, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)", letterSpacing: 0.3 }}>{k || "\u00A0"}</span>
          <span style={{ fontSize: bigRight ? 15 : 12.5, fontWeight: v === "费用不可估算" || v === "—" ? 500 : 700, color: v === "费用不可估算" ? "var(--text-primary)" : (v === "—" ? "var(--text-muted)" : "var(--text-primary)") }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function UsageBreakdown({ usage, detailOpen, onToggleDetail }: { usage: AccumUsage; detailOpen: boolean; onToggleDetail: () => void }): JSX.Element {
  const prompt = usage.promptTokens;
  const reply = usage.completionTokens;
  const reasoning = usage.reasoningTokens;
  const cache = usage.cacheReadTokens;
  const total = prompt + reply + reasoning + cache;

  const C_PROMPT = "#56d4dd";
  const C_REPLY = "#a371f7";
  const C_REASON = "#d29922";
  const C_OTHER = "#8b949e";
  const C_CACHE = "#3fb950";

  const pPrompt = total > 0 ? (prompt / total) * 100 : 0;
  const pReply = total > 0 ? (reply / total) * 100 : 0;
  const pReason = total > 0 ? (reasoning / total) * 100 : 0;
  const pOther = total > 0 ? Math.max(0, 100 - pPrompt - pReply - pReason) : 0;

  const pct = (n: number): string => `${n.toFixed(0)}%`;
  const dashOr = (n: number, unit = ""): string => n === 0 ? "—" : `${fmtK(n)}${unit}`;

  return (
    <div>
      <div style={{ borderRadius: 6, background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", padding: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8 }}>Token 构成</div>
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: "rgba(139,148,158,0.14)", marginBottom: 10 }}>
          {pPrompt > 0 && <div style={{ width: `${pPrompt}%`, background: C_PROMPT }} title={`提示词 ${pct(pPrompt)}`} />}
          {pReply > 0 && <div style={{ width: `${pReply}%`, background: C_REPLY }} title={`回复 ${pct(pReply)}`} />}
          {pReason > 0 && <div style={{ width: `${pReason}%`, background: C_REASON }} title={`推理 ${pct(pReason)}`} />}
          {pOther > 0 && <div style={{ width: `${pOther}%`, background: C_OTHER }} title={`其他 ${pct(pOther)}`} />}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 10.5 }}>
          <LegendDot color={C_PROMPT} label="提示词" value={dashOr(prompt)} pct={pPrompt} />
          <LegendDot color={C_REPLY} label="回复" value={dashOr(reply)} pct={pReply} />
          <LegendDot color={C_REASON} label="推理" value={dashOr(reasoning)} pct={pReason} />
          <LegendDot color={C_OTHER} label={`其他 ${pct(pOther)}`} value={dashOr(cache)} pct={pOther} hintDot={C_CACHE} />
        </div>
      </div>
      <div onClick={onToggleDetail} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", userSelect: "none" }}>
        <span style={{ display: "inline-block", transition: "transform .15s ease", transform: detailOpen ? "rotate(90deg)" : "rotate(0deg)", fontWeight: 700 }}>▶</span>
        <span style={{ fontWeight: 600 }}>明细</span>
      </div>
      {detailOpen && (
        <div style={{ marginTop: 6, borderRadius: 4, background: "rgba(139,148,158,0.06)", border: "1px solid var(--border)", padding: "8px 10px", fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.65 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>提示词 Tokens（输入）</span><span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 600 }}>{prompt.toLocaleString()}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>回复 Tokens（输出）</span><span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 600 }}>{reply.toLocaleString()}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>推理 Tokens（思考）</span><span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 600 }}>{reasoning.toLocaleString()}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span>缓存读 Tokens（命中）</span><span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 600 }}>{cache.toLocaleString()}</span></div>
          <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontWeight: 700, color: "var(--text-primary)" }}>合计</span><span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: "var(--text-primary)" }}>{total.toLocaleString()}</span></div>
        </div>
      )}
    </div>
  );
}

function LegendDot(props: { color: string; label: string; value: string; pct: number; hintDot?: string }): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: props.color, flexShrink: 0 }} />
        <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.label}
          {props.hintDot && <span style={{ marginLeft: 4, width: 6, height: 6, borderRadius: 999, background: props.hintDot, display: "inline-block", verticalAlign: 1 }} />}
        </span>
      </div>
      <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{props.value}{props.pct > 0 ? ` ${props.pct.toFixed(0)}%` : ""}</span>
    </div>
  );
}

function fmtK(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtMsSmart(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/* ═══════════════ 终端 ═══════════════ */

function TerminalTab(props: { workspace: string }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const [lines, setLines] = React.useState<TermLine[]>([{ kind: "info", text: "slime 终端（命令运行器）— 输出直接回显；↑/↓ 切换历史。cwd 默认工作目录。" }]);
  const [input, setInput] = React.useState("");
  const [history, setHistory] = React.useState<string[]>([]);
  const [histIdx, setHistIdx] = React.useState(-1);
  const [running, setRunning] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => { const el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; } }, [lines]);

  const run = async (raw: string): Promise<void> => {
    const cmd = raw.trim();
    if (!cmd) { return; }
    setLines((prev) => [...prev, { kind: "cmd", text: `$ ${cmd}` }]);
    setInput("");
    setHistory((prev) => [cmd, ...prev.filter((h) => h !== cmd)].slice(0, 50));
    setHistIdx(-1);
    setRunning(true);
    try {
      const res = await api?.term?.exec(cmd, props.workspace?.trim() || undefined);
      if (res?.stdout) { setLines((prev) => [...prev, ...res.stdout.replace(/\r\n/g, "\n").split("\n").filter((l: string) => l.length > 0 || res.stdout === "\n").map((l: string) => ({ kind: "out" as const, text: l }))]); }
      if (res?.stderr) { setLines((prev) => [...prev, ...res.stderr.replace(/\r\n/g, "\n").split("\n").filter((l: string) => l.length > 0).map((l: string) => ({ kind: "err" as const, text: l }))]); }
      if (res && res.stdout === "" && res.stderr === "") { setLines((prev) => [...prev, { kind: "info", text: `（无输出，退出码 ${res.code ?? "?"}）` }]); }
      if (res && res.error) { setLines((prev) => [...prev, { kind: "err", text: `错误：${res.error}` }]); }
    } catch (e) { setLines((prev) => [...prev, { kind: "err", text: `执行异常：${e instanceof Error ? e.message : String(e)}` }]); }
    finally { setRunning(false); inputRef.current?.focus(); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { void run(input); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (history.length === 0) { return; } const next = Math.min(histIdx + 1, history.length - 1); setHistIdx(next); setInput(history[next] ?? ""); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (histIdx <= 0) { setHistIdx(-1); setInput(""); return; } const next = histIdx - 1; setHistIdx(next); setInput(history[next] ?? ""); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); setLines([]); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0d1117", color: "#c9d1d9", fontFamily: "Consolas, 'Courier New', monospace", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "6px 10px", borderBottom: "1px solid #30363d", background: "#161b22", fontSize: 12, color: "#8b949e", gap: 8 }}>
        <span style={{ color: "#58a6ff", fontWeight: 600 }}>终端</span>
        <span style={{ color: "#30363d" }}>|</span>
        <span style={{ opacity: 0.7 }} title={props.workspace || "（未设置工作目录）"}>cwd: {props.workspace || "（未设置）"}</span>
        <span style={{ flex: 1 }} />
        <button title="清屏（Ctrl+L）" onClick={() => setLines([])} style={{ background: "transparent", border: "none", color: "#8b949e", cursor: "pointer", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#30363d"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>清空</button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "8px 12px", lineHeight: 1.5 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: l.kind === "err" ? "#f85149" : l.kind === "out" ? "#c9d1d9" : l.kind === "cmd" ? "#7ee787" : "#8b949e" }}>{l.text}</div>
        ))}
        {running && <div style={{ color: "#8b949e", fontStyle: "italic", opacity: 0.7 }}>… 执行中</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", padding: "6px 12px", borderTop: "1px solid #30363d", background: "#0d1117" }}>
        <span style={{ color: "#7ee787", marginRight: 6, fontWeight: "bold" }}>$</span>
        <input ref={inputRef} value={input} disabled={running} placeholder={running ? "命令执行中…" : "输入命令，回车执行（↑/↓ 历史）"} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#c9d1d9", fontFamily: "inherit", fontSize: "inherit", caretColor: "#58a6ff" }} autoFocus />
        <button title="执行" disabled={running} onClick={() => void run(input)} style={{ background: running ? "#21262d" : "#238636", border: "none", color: "#fff", cursor: running ? "not-allowed" : "pointer", padding: "3px 10px", borderRadius: 4, fontSize: 12, marginLeft: 6 }}>▶</button>
      </div>
    </div>
  );
}

/* ═══════════════ 浏览器（独立实例） ═══════════════ */

function BrowserTabInstance(props: { tabId: string; url: string; onUrlChange: (url: string) => void }): JSX.Element {
  const webviewRef = React.useRef<HTMLElement | null>(null);
  const [inputUrl, setInputUrl] = React.useState(props.url ?? "");
  const [navUrl, setNavUrl] = React.useState("");
  const [canBack, setCanBack] = React.useState(false);
  const [canFwd, setCanFwd] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(false);

  // A-173：外部（聊天消息链接点击）修改 url 后，自动导航到新地址
  React.useEffect(() => {
    if (props.url && props.url !== navUrl) {
      setInputUrl(props.url);
      setNavUrl(props.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url]);

  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    if (!wv) { return; }
    const onNav = (e: Electron.DidNavigateEvent): void => { setInputUrl(e.url); setActive(true); props.onUrlChange(e.url); };
    const onInPage = (e: Electron.DidNavigateInPageEvent): void => { setInputUrl(e.url); };
    const onStart = (): void => setLoading(true);
    const onStop = (): void => { setLoading(false); setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward()); };
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onInPage);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    return () => { wv.removeEventListener("did-navigate", onNav); wv.removeEventListener("did-navigate-in-page", onInPage); wv.removeEventListener("did-start-loading", onStart); wv.removeEventListener("did-stop-loading", onStop); };
  }, []);

  const go = (): void => {
    let target = inputUrl.trim();
    if (!target) { return; }
    if (!/^https?:\/\//i.test(target)) { target = `https://${target}`; }
    setNavUrl(target);
  };

  const wv = webviewRef.current as unknown as Electron.WebviewTag | null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%", background: "var(--bg, #fff)" }}>
      <div className="right-pane-head browser-bar" style={{ flexShrink: 0 }}>
        <button className="right-mini-btn" title="后退" disabled={!canBack} onClick={() => { wv?.goBack(); }}>‹</button>
        <button className="right-mini-btn" title="前进" disabled={!canFwd} onClick={() => { wv?.goForward(); }}><ChevronIcon size={12} rotate={90} /></button>
        <button className="right-mini-btn" title="刷新" disabled={!active} onClick={() => { wv?.reload(); }}><RefreshIcon size={12} /></button>
        <input className="term-input browser-url" value={inputUrl} placeholder="输入网址，回车访问" onChange={(e) => setInputUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { go(); } }} />
        <button className="right-mini-btn" title="访问" onClick={go}><ArrowRightIcon2 size={12} /></button>
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {!active && !navUrl && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted, #8b949e)", gap: 12 }}>
            <GlobeIcon size={36} />
            <div style={{ fontSize: 14, opacity: 0.7 }}>在上方输入网址开始浏览</div>
          </div>
        )}
        {loading && active && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--accent, #58a6ff)", zIndex: 10 }} />}
        {navUrl && <WebviewTag ref={webviewRef} src={navUrl} style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "#fff" }} />}
      </div>
    </div>
  );
}

/* ═══════════════ 菜单项 / 空态插画 ═══════════════ */

function MenuItem(props: { label: string; disabled?: boolean; hint?: string; onClick: () => void }): JSX.Element {
  return (
    <div onClick={() => !props.disabled && props.onClick()} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 8px", borderRadius: 4, cursor: props.disabled ? "not-allowed" : "pointer", color: props.disabled ? "var(--text-muted)" : "var(--text-primary)", opacity: props.disabled ? 0.55 : 1, fontSize: 12 }}
      onMouseEnter={(e) => { if (!props.disabled) { (e.currentTarget as HTMLDivElement).style.background = "var(--hover-bg, rgba(255,255,255,0.06))"; } }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}>
      <span>{props.label}</span>
      {props.hint && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{props.hint}</span>}
    </div>
  );
}

function FolderEmptyGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 20 C8 17.79 9.79 16 12 16 H26 L32 22 H52 C54.21 22 56 23.79 56 26 V48 C56 50.21 54.21 52 52 52 H12 C9.79 52 8 50.21 8 48 V20 Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity="0.8" />
      <path d="M14 40 H50" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.3" />
      <path d="M14 46 H42" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.18" />
    </svg>
  );
}

function NoChangesGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 72 72" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="26" y="20" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="1.6" opacity="0.7" />
      <path d="M36 20 V14 M36 52 V46 M20 30 H14 M58 30 H52" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}

/* ═══════════════ Git 变更分组 ═══════════════ */

function ChangeGroup(props: { title: string; files: string[]; glyph: string; collapsed: boolean; onToggle: () => void; onFileClick?: (f: string) => void }): JSX.Element | null {
  if (props.files.length === 0) { return null; }
  const g = STATUS_GLYPH[props.glyph] ?? STATUS_GLYPH.M;
  return (
    <div style={{ marginBottom: 6 }}>
      <div onClick={props.onToggle} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 4, cursor: "pointer", userSelect: "none", fontSize: 12, color: "var(--text-secondary)" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hover-bg, rgba(255,255,255,0.05))"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
        title={props.collapsed ? "展开" : "折叠"}>
        <span style={{ display: "inline-block", transition: "transform 0.15s", transform: props.collapsed ? "rotate(-90deg)" : "rotate(0deg)", fontSize: 10, opacity: 0.7 }}><ChevronIcon size={10} rotate={props.collapsed ? 0 : 90} /></span>
        <span style={{ fontWeight: 500 }}>{props.title}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--input-bg, #161b22)", borderRadius: 8, padding: "0 6px" }}>{props.files.length}</span>
      </div>
      {!props.collapsed && (
        <div style={{ paddingLeft: 6 }}>
          {props.files.map((f) => (
            <div key={f} onClick={() => props.onFileClick?.(f)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 6px", borderRadius: 4, fontSize: 11, cursor: props.onFileClick ? "pointer" : "default" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hover-bg, rgba(255,255,255,0.05))"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              title={"点击查看该文件的代码变更（红绿标注）"}>
              <span style={{ width: 16, textAlign: "center", fontFamily: "Consolas, monospace", fontSize: 11, fontWeight: 700, color: g.color, flexShrink: 0 }}>{g.label}</span>
              <span style={{ flex: 1, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "Consolas, 'Courier New', monospace" }} title={f}>{f}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, opacity: 0.7 }}>查看</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
