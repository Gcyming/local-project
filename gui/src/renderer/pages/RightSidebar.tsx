import React, { type JSX, type CSSProperties } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DownloadProgressInfo, WorkspaceEntry, WorkspaceReadFileResult, CtxBuckets, GitDiffFile,
} from "../../shared/ipc.js";
import { isBrowserSchemeUrl } from "../../shared/ipc.js";

import { phaseLabel } from "../../shared/downloadPhase.js";
import {
  ChevronIcon, TaskIcon, GlobeIcon,
  GitIcon, PlusIcon, DashboardIcon,
  CheckboxIcon, CirclePlusIcon, LoadingCircleIcon,
  TerminalIcon, FolderIcon, ArrowLeftIcon, SearchIcon,
  CloseIcon, RefreshIcon, CheckIcon, RepeatIcon, PaperclipIcon, EditIcon, WarningIcon,
  FileTypeIcon, DoneIcon, type IconProps,
} from "../components/Icon.js";
import { alertAsync, confirmAsync } from "../dialog.js";
import { SIDEBAR_OPEN_EVENT, requestSidebarOpen, type SidebarOpenPayload } from "./Markdown.js";

import { shouldRenderAsWeb, splitPath, baseNameOf, buildPreviewUrl } from "./webPreview.js";
import { readSessionCtxMeta, restoreUsed } from "./sessionCtxMeta.js";
import { contextRatio, contextPct, ringLevel, composeSegments, bucketsSegments, fmtTokens, usageComposition } from "./contextMath.js";
import { failTitle, failHint, failCodeName } from "./browserErrors.js";

import TopicRail, { type RailEntry } from "./TopicRail.js";
import { loadRailParams, onRailParams, type RailParams } from "./railParams.js";
import BrainstormPanel from "./BrainstormPanel.js";
import { onCtxUpdate, readAutoCompressCfg, AUTOCOMPRESS_CFG_EVENT, resolveToolLabel, readSessionProducts } from "./ChatPanel.js";

import { readLiveMonitor } from "./liveMonitor.js";

import { findSessionFileDiff, type SessionFileDiff } from "./chatProducts.js";
import { trackResizerGlint, clearResizerGlint } from "../resizerGlint.js";
import { setBrowserHost, registerWebview, unregisterWebview, executeBrowserCommand, isWebNavUrl, normalizeBrowserUrl } from "./browserBridge.js";

import { classifyFile } from "../../../../core-ts/src/office/fileKinds.js";


import { needsLibreOffice } from "../../../../core-ts/src/office/renderPlan.js";

import { buildDocView, docViewToHtml, DOC_CELL_MIN_EM } from "./docView.js";




import { parseAnsi, stripAnsi, type AnsiSpan } from "../../../../core-ts/src/terminal/ansi.js";


import { sidebarOpenMatchesSession } from "../../../../core-ts/src/sidebarOpen.js";
import type { TermProfile } from "../../shared/ipc.js";

import {
  getSearchPageDelivery, publishSidebarTab, connectSidebarSearch,
  type SearchPageDelivery, type SidebarTabView,
} from "./sidebarSearch.js";

type SidebarTabKind = SidebarTabView["kind"];

import { safeLoadURL, navAutoLoadAllowed, noteNavFailure, clearNavFailure, type NavFailureBook } from "./webviewNav.js";


import { pricingDisplayCurrency, formatUsdAs, type PriceCurrency } from "../../../../shared/gen/model-capabilities.js";

import { readLedgerCurrencyPref, resolveLedgerCurrency, LEDGER_CURRENCY_EVENT, type LedgerCurrencyPref } from "./ledgerCurrencyCfg.js";

type TabType = "tasks" | "terminal" | "browser" | "git" | "file";


const IMG_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
};
function imageDataUrl(name: string, base64: string): string {
  const ext = (name.split(/[\\/]/).pop() ?? "").toLowerCase().split(".").pop();
  const mime = ext ? IMG_MIME[`.${ext}`] ?? "image/png" : "image/png";
  return `data:${mime};base64,${base64}`;
}


function pdfDataUrl(base64: string): string {
  return `data:application/pdf;base64,${base64}`;
}


const OFFICE_ICONS: Record<string, string> = {
  ".doc": "📘", ".docx": "📘", ".xls": "📗", ".xlsx": "📗",
  ".ppt": "📙", ".pptx": "📙",
};

interface TabInstance {
  id: string;
  type: TabType;
  title: string;
  url?: string;
  fileRel?: string;
  
  fileAbs?: string;
  fileContent?: string;
  fileMime?: "text" | "docText" | "image" | "binary" | "pdf" | "office";
  fileError?: string;
  





  fileNotice?: string;
  
  termCmd?: string;
  

  termNonce?: number;
  

  browseRoot?: string;
  


  browseRel?: string;
  

  isDefault?: boolean;
}

interface TabTypeMeta {
  type: TabType;
  label: string;
  icon: (p: { size?: number }) => JSX.Element;
}

const TAB_TYPE_META: TabTypeMeta[] = [
  { type: "tasks", label: "待办任务", icon: TaskIcon },
  { type: "terminal", label: "终端", icon: TerminalIcon },
  { type: "browser", label: "浏览器", icon: GlobeIcon },
  { type: "git", label: "Git仓库", icon: GitIcon },
  { type: "file", label: "文件查看", icon: FileIcon },
];

function FileIcon(props: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" width={props.size} height={props.size} fill="currentColor" style={{ display: "inline-block", flexShrink: 0 }}>
      <path d="M768 128H320L192 256v640a64 64 0 0064 64h512a64 64 0 0064-64V192a64 64 0 00-64-64zm-416 64h224v128H352V192zM768 896H256V320h160v192h352v384z" />
    </svg>
  );
}

const uid = (): string => Math.random().toString(36).slice(2, 10);




let termOpenSeq = 0;

const createTab = (type: TabType, index?: number): TabInstance => {
  const meta = TAB_TYPE_META.find((m) => m.type === type)!;
  const title = index !== undefined ? `${meta.label} ${index + 1}` : meta.label;
  
  return { id: uid(), type, title, url: type === "browser" ? "" : undefined, isDefault: type === "tasks" };
};

const createFileTab = (_root: string, rel: string, name: string): TabInstance => ({
  id: uid(),
  type: "file",
  title: name,
  fileRel: rel,
});


interface TaskEvent {
  id: number;
  time: string;
  kind: "tool" | "thinking" | "progress" | "done" | "error";
  label: string;
  

  tool?: string;
}






































const WebviewTag = React.forwardRef<HTMLElement, { src: string; style: CSSProperties; partition?: string; allowpopups?: boolean | string; plugins?: boolean | string; preload?: string }>((props, ref) =>
  React.createElement("webview", {
    ...props,
    allowpopups: props.allowpopups ? "true" : undefined,
    plugins: props.plugins ? "true" : undefined,
    ref,
  }),
);
WebviewTag.displayName = "WebviewTag";






interface TermLine {
  kind: "cmd" | "out" | "err" | "info" | "notice";
  text: string;
  spans?: AnsiSpan[];
}


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


const STATUS_GLYPH: Record<string, { label: string; color: string }> = {
  M: { label: "M", color: "var(--diff-mod, #58a6ff)" },
  A: { label: "A", color: "var(--diff-add, #7ee787)" },
  D: { label: "D", color: "var(--diff-del, #f85149)" },
  R: { label: "R", color: "var(--diff-mod, #58a6ff)" },
  U: { label: "U", color: "#d29922" },
  "?": { label: "?", color: "#8b949e" },
};



export default function RightSidebar(props: {
  open: boolean;

  
  providerModels?: Array<{ key?: string; models?: Array<{ id: string; context_window?: number }> }>;
  onToggle: () => void;
  agentId: string | null;
  agentName: string;
  sessionId?: string;
  workspace: string;
  dl: Record<string, DownloadProgressInfo>;
  width?: number;
  onResize?: (e: React.PointerEvent) => void;
  


  floatLayout?: boolean;
  
  sessionType?: "normal" | "brainstorm";
  
  memberIds?: string[];
  
  memberModels?: Record<string, string>;
  leaderModel?: string;
  
  memberEfforts?: Record<string, string>;
  leaderEffort?: string;
}): JSX.Element {
  
  const [tabs, setTabs] = React.useState<TabInstance[]>(() =>
    props.sessionType === "brainstorm" ? [] : [createTab("tasks")],
  );
  const [activeId, setActiveId] = React.useState<string | undefined>(() =>
    props.sessionType === "brainstorm" ? undefined : "tasks",
  );
  







  const [searchDelivery, setSearchDelivery] = React.useState<SearchPageDelivery | null>(null);
  React.useEffect(() => {
    let alive = true;
    void getSearchPageDelivery().then((d) => { if (alive) { setSearchDelivery(d); } });
    return () => { alive = false; };
  }, []);
  



  const searchHomeUrl = searchDelivery?.url ?? "";
  React.useEffect(() => {
    const t = tabs.find((x) => x.id === activeId) ?? null;
    const kind: SidebarTabKind = t?.type ?? "none";
    const raw = t?.type === "browser" ? (t.url ?? "").trim() : "";
    publishSidebarTab(
      { kind, url: raw || (kind === "browser" ? searchHomeUrl : ""), title: (t?.title ?? "").trim() },
      searchHomeUrl,
    );
  }, [tabs, activeId, searchHomeUrl]);
  
  React.useEffect(() => connectSidebarSearch(), []);
  
  
  const sidebarSnapRef = React.useRef<Record<string, { tabs: TabInstance[]; activeId?: string }>>({});
  const prevSidRef = React.useRef<string | null>(null);
  

  const pendingOpenRef = React.useRef<Record<string, SidebarOpenPayload[]>>({});
  

  const sessionIdRef = React.useRef<string>(props.sessionId ?? "");
  sessionIdRef.current = props.sessionId ?? "";
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
        
        
        const fresh = props.sessionType === "brainstorm" ? [] : [createTab("tasks")];
        setTabs(fresh);
        setActiveId(props.sessionType === "brainstorm" ? undefined : "tasks");
      }
      




      const pend = pendingOpenRef.current[sid] ?? [];
      if (pend.length > 0) {
        pendingOpenRef.current[sid] = [];
        setTimeout(() => {
          for (const p of pend) {
            requestSidebarOpen({ ...p, from: p.from === "site" ? "site" : "user" });
          }
        }, 0);
      }
    }
    prevSidRef.current = sid || null;
    
  }, [props.sessionId]);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  

  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number } | null>(null);
  const addBtnRef = React.useRef<HTMLButtonElement>(null);
  
  const menuHostRef = React.useRef<HTMLElement>(null);
  const workspaceRef = React.useRef(props.workspace);
  workspaceRef.current = props.workspace;

  

  const toggleAddMenu = React.useCallback((): void => {
    setMenuOpen((open) => {
      if (open) { return false; }
      const btn = addBtnRef.current;
      const host = menuHostRef.current;
      if (btn && host) {
        const b = btn.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        
        const MENU_W = 148;
        const rawLeft = b.left - h.left - host.clientLeft;
        setMenuPos({
          top: b.bottom - h.top - host.clientTop + 4,
          left: Math.max(2, Math.min(rawLeft, h.width - host.clientLeft * 2 - MENU_W - 2)),
        });
      }
      return true;
    });
  }, []);

  

  React.useEffect(() => {
    if (!menuOpen) { return; }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t && menuRef.current?.contains(t)) { return; }
      if (t && addBtnRef.current?.contains(t)) { return; } 
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { setMenuOpen(false); } };
    
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  
  const tabsRef = React.useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;

  
  React.useEffect(() => {
    setBrowserHost({
      listTabs: () => tabsRef.current
        .filter((t) => t.type === "browser")
        .map((t) => ({ id: t.id, title: t.title, url: t.url ?? "", active: t.id === activeIdRef.current })),
      openTab: (url, activate = true) => {
        
        const safeUrl = url && isWebNavUrl(url) ? url : undefined;
        const tab: TabInstance = { ...createTab("browser"), url: safeUrl, title: url ? url : "浏览器" };
        setTabs((prev) => [...prev, tab]);
        if (activate) { setActiveId(tab.id); }
        return tab.id;
      },
      closeTab: (tabId) => {
        const id = tabId ?? activeIdRef.current;
        if (!id) { return false; }
        const target = tabsRef.current.find((t) => t.id === id);
        if (!target || target.isDefault) { return false; }
        setTabs((prev) => prev.filter((t) => t.id !== id));
        return true;
      },
      activateTab: (tabId) => {
        const exists = tabsRef.current.some((t) => t.id === tabId);
        if (exists) { setActiveId(tabId); }
        return exists;
      },
      activeTabId: () => {
        const browsers = tabsRef.current.filter((t) => t.type === "browser");
        const act = browsers.find((t) => t.id === activeIdRef.current);
        return (act ?? browsers[0])?.id ?? null;
      },
    });
    return () => { setBrowserHost(null); };
  }, []);

  
  React.useEffect(() => {
    const w = window as unknown as {
      slimeAPI?: {
        browser?: {
          onCommand?: (cb: (c: { id: string; kind: string } & Record<string, unknown>) => void) => () => void;
          sendResult?: (p: { id: string; ok: boolean; data?: unknown; error?: string }) => void;
        };
      };
    };
    const api = w.slimeAPI?.browser;
    if (!api?.onCommand) { return; }
    const off = api.onCommand((cmd) => {
      void executeBrowserCommand(cmd)
        .then((res) => { try { api.sendResult?.({ id: cmd.id, ok: res.ok, data: res.data, error: res.error }); } catch {  } })
        .catch((e: unknown) => { try { api.sendResult?.({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) }); } catch {  } });
    });
    return () => { try { off(); } catch {  } };
  }, []);

  
  const [popupBanner, setPopupBanner] = React.useState<{ url: string; ts: number; kind?: string; scheme?: string; handler?: string } | null>(null);
  
  const recentPopupRef = React.useRef<number[]>([]);
  
  
  
  React.useEffect(() => {
    const w = window as unknown as {
      slimeAPI?: { browser?: { onPopupNotice?: (cb: (p: { url: string; ts: number; kind?: string; scheme?: string }) => void) => () => void } }
    };
    const api = w.slimeAPI?.browser;
    if (!api?.onPopupNotice) { return; }
    return api.onPopupNotice((p) => {
      try { window.dispatchEvent(new CustomEvent("slime-browser-popup-notice", { detail: { url: p.url, kind: p.kind ?? "popup-denied", scheme: p.scheme } })); } catch {  }
    });
  }, []);
  React.useEffect(() => {
    const onNotice = (e: Event): void => {
      const d = (e as CustomEvent<{ url?: string; kind?: string; scheme?: string; handler?: string }>).detail ?? {};
      if (d.url) { setPopupBanner({ url: d.url, ts: Date.now(), kind: d.kind, scheme: d.scheme, handler: d.handler }); }
    };
    window.addEventListener("slime-browser-popup-notice", onNotice);
    return () => window.removeEventListener("slime-browser-popup-notice", onNotice);
  }, []);
  
  React.useEffect(() => {
    if (!popupBanner) { return; }
    const t = setTimeout(() => setPopupBanner(null), 8000);
    return () => clearTimeout(t);
  }, [popupBanner]);

  
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

  








  const openFileAbs = (abs: string, name?: string, notice?: string): void => {
    const clean = (abs ?? "").trim().replace(/^["']|["']$/g, "");
    if (!clean) { return; }
    const fname = (name ?? clean.split(/[\\/]/).pop() ?? clean).trim();
    const isAbs = /^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith("\\\\") || clean.startsWith("/");
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const tab: TabInstance = {
      id: uid(), type: "file", title: fname,
      fileRel: clean, fileAbs: clean, 
      
      fileNotice: notice,
    };
    void (async () => {
      let lastErr = "";
      const triedAll: string[] = [];
      
      const resolved = await api?.workspace?.openTarget?.(clean, {
        root: (props.workspace ?? "").trim(),
        sessionId: props.sessionId ?? "",
      }).catch(() => null) as { ok?: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string } | null | undefined;
      if (resolved?.tried) { triedAll.push(...resolved.tried); }
      if (resolved?.ok && resolved.path) {
        if (resolved.isDir) {
          
          updateTab(tab.id, { fileAbs: undefined, fileContent: undefined, browseRoot: resolved.path, title: fname });
          return;
        }
        





        const kindInfo = classifyFile(resolved.path);
        




        if (kindInfo.office && kindInfo.kind !== "pdf") {
          const dr = await api?.docs?.read?.(resolved.path).catch(() => null) as
            { ok?: boolean; text?: string; error?: string; truncated?: boolean } | null | undefined;
          if (dr?.ok) {
            


            const loNote = needsLibreOffice(resolved.path)
              ? "（装好 LibreOffice 后可点上方「网页渲染」查看原版式）"
              : "";
            updateTab(tab.id, {
              fileContent: dr.text ?? "", fileMime: "docText", fileAbs: resolved.path, fileError: undefined,
              fileNotice: `已转成**结构化文本**预览（.${kindInfo.ext} 的原排版仍需系统程序）${dr.truncated ? "；内容较长已截断" : ""}。${loNote}`,
            });
            return;
          }
          

          updateTab(tab.id, {
            fileContent: undefined, fileMime: "office", fileAbs: resolved.path, fileError: undefined,
            fileNotice: `没能抽出文本：${dr?.error ?? "未知原因"}`,
          });
          return;
        }
        const res = await api?.workspace?.readFileAbs?.(resolved.path).catch(() => null) as WorkspaceReadFileResult | null | undefined;
        if (res?.ok) {
          updateTab(tab.id, { fileContent: res.content ?? "", fileMime: res.mime, fileAbs: res.path ?? resolved.path, fileError: undefined });
          return;
        }
        lastErr = res?.error ?? "";
        
      } else {
        lastErr = resolved?.error ?? "";
      }
      
      const tryRead = async (fn: (() => Promise<WorkspaceReadFileResult | null>) | undefined): Promise<boolean> => {
        if (!fn) { return false; }
        const res = await fn().catch(() => null);
        if (res?.ok) {
          updateTab(tab.id, { fileContent: res.content ?? "", fileMime: res.mime, fileAbs: res.path ?? clean, fileError: undefined });
          return true;
        }
        lastErr = res?.error ?? lastErr;
        return false;
      };
      if (isAbs) {
        if (await tryRead(() => api?.workspace?.readFileAbs?.(clean))) { return; }
      } else {
        const root = (props.workspace ?? "").trim();
        if (await tryRead(root ? () => api?.workspace?.readFile?.(root, clean) : undefined)) { return; }
        if (await tryRead(() => api?.workspace?.readFileAbs?.(clean))) { return; }
      }
      
      const hint = triedAll.length > 0
        ? `\n已尝试解析为：\n${triedAll.slice(0, 6).map((t) => `· ${t}`).join("\n")}`
        : "\n（已按工作目录 / 项目根 / 绝对路径逐一尝试）";
      updateTab(tab.id, { fileError: (lastErr || `找不到该路径：${clean}`) + hint });
    })();
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  







  const openBrowserTab = (url: string, title: string): void => {
    const browsers = tabs.filter((t) => t.type === "browser");
    const sameUrl = browsers.find((t) => t.url === url);
    if (sameUrl) { setActiveId(sameUrl.id); return; }
    const blank = browsers.find((t) => !t.url);
    if (blank) { updateTab(blank.id, { url, title }); setActiveId(blank.id); return; }
    const tab = createTab("browser");
    setTabs((prev) => [...prev, { ...tab, url, title }]);
    setActiveId(tab.id);
  };

  













  const openWebPreview = (rel: string, name?: string): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void (async () => {
      const resolved = await api?.workspace?.openTarget?.(rel, {
        root: (props.workspace ?? "").trim(),
        sessionId: props.sessionId ?? "",
      }).catch(() => null) as { ok?: boolean; path?: string; isDir?: boolean } | null | undefined;
      const abs = resolved?.ok && !resolved.isDir ? (resolved.path ?? "").trim() : "";
      if (!abs) {
        
        openFileAbs(rel, name, "这是网页产物，本想在浏览器里渲染它，但没能解析出它在磁盘上的绝对路径。");
        return;
      }
      const { dir, base } = splitPath(abs);
      if (!dir) {
        openFileAbs(rel, name, "这是网页产物，没能确定它所在的目录（无法起本地服务）。");
        return;
      }
      const served = await api?.http?.serve?.({ dir }).catch(() => null) as
        { ok?: boolean; urls?: string[]; error?: string } | null | undefined;
      if (!served?.ok) {
        openFileAbs(rel, name, `这是网页产物，但启动本地服务失败（${served?.error ?? "未知原因"}），已按源码显示。`);
        return;
      }
      const url = buildPreviewUrl(served.urls, base);
      if (!url) {
        openFileAbs(rel, name, "这是网页产物，本地服务没有返回可用地址，已按源码显示。");
        return;
      }
      openBrowserTab(url, (name ?? "").trim() || base);
    })();
  };

  












  const openDocPreviewPage = (path: string, name?: string): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void (async () => {
      const label = (name ?? "").trim() || path.split(/[\\/]/).pop() || "文档";

      




      const rp = await api?.docs?.renderPage?.({ path, name: label }).catch(() => null) as
        { ok?: boolean; dir?: string; name?: string; error?: string; degrade?: boolean;
          needs?: string; hint?: string; reason?: string; transient?: boolean } | null | undefined;
      






      let routeNote = "";
      if (rp?.ok && rp.dir) {
        const served = await api?.http?.serve?.({ dir: rp.dir }).catch(() => null) as
          { ok?: boolean; urls?: string[]; error?: string } | null | undefined;
        const url = served?.ok ? buildPreviewUrl(served.urls, rp.name ?? "index.html") : null;
        if (url) { openBrowserTab(url, label); return; }
        routeNote = `保真渲染页已生成，但本地服务没起来或没返回可用地址（${served?.error ?? "未知原因"}）。`
          + "当前按文本结构重排显示，不是原版式。";
      } else if (rp && rp.ok === false) {
        routeNote = (rp.needs === "libreoffice" && rp.reason === "no-libreoffice")
          ? `${rp.hint ?? "需要本机安装 LibreOffice。"}（当前按文本结构重排显示，不是原版式）`
          : (rp.needs === "libreoffice" && rp.reason === "failed")
            ? `LibreOffice 转换失败：${rp.error ?? "未知原因"}（当前按文本结构重排显示，不是原版式）`
            : `保真渲染不可用：${rp.error ?? "未知原因"}（当前按文本结构重排显示，不是原版式）`;
      } else {
        

        routeNote = "保真渲染通道没有响应（若应用刚更新过，请**重启应用**后再试）。"
          + "当前按文本结构重排显示，不是原版式。";
      }

      const dr = await api?.docs?.read?.(path).catch(() => null) as
        { ok?: boolean; text?: string; error?: string } | null | undefined;
      if (!dr?.ok) {
        openFileAbs(path, label, `${routeNote}\n（另外，文本提取也没成功：${dr?.error ?? "未知原因"}）`);
        return;
      }
      
      const html = docViewToHtml(
        buildDocView(classifyFile(path).kind, dr.text ?? ""),
        { title: label, source: path, notice: routeNote },
      );
      const written = await api?.docs?.htmlPreview?.({ name: label, html }).catch(() => null) as
        { ok?: boolean; dir?: string; name?: string; error?: string } | null | undefined;
      if (!written?.ok || !written.dir) { openFileAbs(path, label, `生成预览页失败：${written?.error ?? "未知原因"}`); return; }
      const served = await api?.http?.serve?.({ dir: written.dir }).catch(() => null) as
        { ok?: boolean; urls?: string[]; error?: string } | null | undefined;
      if (!served?.ok) { openFileAbs(path, label, `启动本地服务失败（${served?.error ?? "未知原因"}）。`); return; }
      const url = buildPreviewUrl(served.urls, written.name ?? label);
      if (!url) { openFileAbs(path, label, "本地服务没有返回可用地址，已按文本显示。"); return; }
      openBrowserTab(url, label);
    })();
  };

  




  const openTerminalTab = (cmd?: string, name?: string): void => {
    const prefill = (cmd ?? "").trim();
    const title = (name ?? "").trim();
    const patch = { termCmd: prefill, termNonce: (termOpenSeq += 1), ...(title ? { title } : {}) };
    const existing = tabs.find((t) => t.type === "terminal");
    if (existing) { updateTab(existing.id, patch); setActiveId(existing.id); return; }
    const tab = createTab("terminal");
    setTabs((prev) => [...prev, { ...tab, ...patch }]);
    setActiveId(tab.id);
  };

  




  const openFilesTab = (root?: string, rel?: string, name?: string): void => {
    const r = (root ?? "").trim();
    const rr = (rel ?? "").trim();
    const title = (name ?? "").trim() || (r ? baseNameOf(r) : "文件");
    const patch = {
      browseRoot: r || undefined, browseRel: rr || undefined, title,
      fileRel: undefined, fileError: undefined, fileNotice: undefined,
    };
    const existing = tabs.find((t) => t.type === "file" && !t.fileAbs && t.fileContent === undefined);
    if (existing) { updateTab(existing.id, patch); setActiveId(existing.id); return; }
    const tab: TabInstance = { id: uid(), type: "file", ...patch };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  
  React.useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<SidebarOpenPayload>).detail;
      if (!d) { return; }
      




      if (d.from === "site" && d.kind === "url") {
        const now = Date.now();
        const recent = recentPopupRef.current.filter((t) => now - t < 3000);
        const browserCount = tabs.filter((t) => t.type === "browser").length;
        if (recent.length >= 5 || (recent.length >= 1 && browserCount >= 16)) {
          recentPopupRef.current = recent;
          setPopupBanner({ url: d.url ?? "", ts: now, kind: "popup-denied" });
          return;
        }
        recentPopupRef.current = [...recent, now];
      }
      if (d.kind === "doc" && d.rel) {
        
        openDocPreviewPage(d.rel, d.name);
      } else if (d.kind === "file" && d.rel) {
        



        if (shouldRenderAsWeb(d.rel, d.name)) { openWebPreview(d.rel, d.name); }
        else { openFileAbs(d.rel, d.name); }
      } else if (d.kind === "terminal") {
        

        openTerminalTab(d.cmd, d.name);
      } else if (d.kind === "files") {
        
        openFilesTab(d.root, d.rel, d.name);
      } else if (d.kind === "url" && d.url) {
        
        
        const url = normalizeBrowserUrl(d.url);
        
        
        if (!isWebNavUrl(url)) { return; }
        
        const domainTitle = (): string => {
          try { return new URL(url).hostname.replace(/^www\./, "") || url; } catch { return url; }
        };
        
        
        const pageTitle = (): string => {
          const n = (d.name ?? "").trim();
          return n || domainTitle();
        };
        
        openBrowserTab(url, pageTitle());
      }
    };
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    
  }, [tabs]);

  




  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: { onSidebarOpen?: (cb: (p: SidebarOpenPayload) => void) => () => void } };
    const off = w.slimeAPI?.onSidebarOpen?.((p) => {
      if (!p) { return; }
      






      const owner = p.sessionId ?? "";
      if (!sidebarOpenMatchesSession(owner, sessionIdRef.current)) {
        const q = pendingOpenRef.current[owner] ?? [];
        q.push(p);
        pendingOpenRef.current[owner] = q;
        return;
      }
      
      
      requestSidebarOpen({
        ...p,
        from: p.from === "site" ? "site" : "user",
      });
    });
    return () => { off?.(); };
  }, []);

  const closeTab = (id: string): void => {
    setTabs((prev) => {
      const target = prev.find((t) => t.id === id);
      
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
    <aside ref={menuHostRef} className={`right-sidebar${props.open ? "" : " collapsed"}`} style={{ width: props.width }}>
      {






}
      {props.open && !props.floatLayout && (
        






        <div className="right-sidebar-resizer" onPointerDown={props.onResize}
          onMouseMove={trackResizerGlint} onMouseLeave={clearResizerGlint} />
      )}

      {}
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
                title={tab.isDefault ? `${tab.fileRel || tab.title}（默认页，常驻）` : (tab.fileRel || tab.title)}
              >
                <Icon size={14} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: "1", minWidth: 0 }}>{tab.title}</span>
                {

}
                {!tab.isDefault && (
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
            ref={addBtnRef}
            className="right-tab-add"
            title="新建标签页"
            onClick={toggleAddMenu}
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
        {

}
      </div>

      {



}
      <div
        ref={menuRef}
        className={`pop${menuOpen ? " is-open" : ""}`}
        style={{
          position: "absolute", zIndex: 9999,
          
          top: menuPos?.top ?? 34,
          left: menuPos?.left ?? 6,
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

      {}
      <div className="right-body" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {!activeTab && props.sessionType === "brainstorm" && (
          <BrainstormPanel
            sessionId={props.sessionId ?? ""}
            memberIds={props.memberIds ?? []}
            memberModels={props.memberModels ?? {}}
            leaderModel={props.leaderModel}
            memberEfforts={props.memberEfforts ?? {}}
            leaderEffort={props.leaderEffort}
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
        {
}
        <div style={{ display: activeTab?.type === "tasks" ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <TasksTab active={activeTab?.type === "tasks"} agentId={props.agentId ?? ""} sessionId={props.sessionId ?? ""} agentName={props.agentName} workspace={props.workspace} dl={props.dl} providerModels={props.providerModels} />
        </div>
        {activeTab && activeTab.type === "terminal" && (
          <TerminalTab workspace={props.workspace} initialCmd={activeTab.termCmd} nonce={activeTab.termNonce} />
        )}
        {



}
        {
}
        {activeTab?.type === "browser" && popupBanner && (() => {
          const kind = popupBanner.kind ?? "popup-denied";
          const needInstall = kind === "need-install";
          const opened = kind === "opened";
          
          
          const browserScheme = needInstall && isBrowserSchemeUrl(popupBanner.url);
          const tone = needInstall
            ? { bg: "rgba(240, 160, 48, 0.10)", border: "rgba(240, 160, 48, 0.32)", fg: "#e8c27a", icon: "⚠" }
            : opened
              ? { bg: "rgba(74, 222, 128, 0.10)", border: "rgba(74, 222, 128, 0.32)", fg: "#7fd9a0", icon: "✓" }
              : { bg: "var(--bg-input, #161b22)", border: "var(--border, rgba(255,255,255,0.08))", fg: "var(--text-secondary)", icon: "⛔" };
          const title = browserScheme
            ? `已拦截浏览器唤起链接（${popupBanner.scheme ?? ""}://）——未唤起外部浏览器`
            : needInstall
              ? `无法打开 ${popupBanner.scheme ?? ""}:// 链接——系统未注册该协议`
              : opened
                ? `已交给系统打开${popupBanner.handler ? `（${popupBanner.handler}）` : ""}`
                : "站点试图弹出新窗口，已自动拦截";
          const btnStyle = { flexShrink: 0, minWidth: 54, padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: tone.fg, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" } as const;
          return (
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10, minHeight: 34, margin: "0 8px 6px", padding: "6px 12px", borderRadius: 8, background: tone.bg, border: `1px solid ${tone.border}`, fontSize: 11 }}>
              <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, color: tone.fg }}>{tone.icon}</span>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ color: tone.fg, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
                <span style={{ color: "var(--text-muted, #8b949e)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left" }} title={popupBanner.url}>{popupBanner.url}</span>
              </div>
              {!needInstall && (
                <button style={btnStyle} onClick={() => {
                  const u = popupBanner.url;
                  setPopupBanner(null);
                  if (!u || kind !== "popup-denied") { return; }
                  
                  
                  const browsers = tabs.filter((t) => t.type === "browser");
                  const target = browsers.find((t) => t.url === u) ?? browsers.find((t) => !t.url);
                  if (target) {
                    updateTab(target.id, { url: u, title: u });
                    setActiveId(target.id);
                  } else {
                    const tab = createTab("browser");
                    setTabs((prev) => [...prev, { ...tab, url: u, title: u }]);
                    setActiveId(tab.id);
                  }
                }}>打开</button>
              )}
              {needInstall && (
                <button style={btnStyle} onClick={() => setPopupBanner(null)}>知道了</button>
              )}
            </div>
          );
        })()}
        {tabs.filter((t) => t.type === "browser").map((t) => {
          const isActive = t.id === activeTab?.id;
          
          
          
          
          
          
          
          
          if (searchDelivery === null) { return null; }
          return (
            <div
              key={t.id}
              style={{ display: isActive ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}
            >
              <BrowserTabInstance tabId={t.id} url={t.url ?? ""} active={isActive}
                

                preload={searchDelivery.preload}
                homeUrl={searchDelivery.url}
                homeError={searchDelivery.error}
                onUrlChange={(url) => updateTab(t.id, { url })}
                onTitleChange={(title) => updateTab(t.id, { title })} />
            </div>
          );
        })}
        {activeTab && activeTab.type === "git" && (
          <GitTab workspace={props.workspace} onFileClick={openFileTab} />
        )}
        {activeTab && activeTab.type === "file" && (
          <FileTab tab={activeTab} workspace={props.workspace}
            onBrowseRootChange={(root) => updateTab(activeTab.id, { browseRoot: root })}
            agentId={props.agentId}
            sessionId={props.sessionId}
            onBack={() => {
              const gitIdx = tabs.findIndex((t) => t.type === "git");
              if (gitIdx >= 0) { setActiveId(tabs[gitIdx].id); }
            }} />
        )}
      </div>
    </aside>
  );
}



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
  


  const [branchOpen, setBranchOpen] = React.useState(false);
  const [modal, setModal] = React.useState<null | "clone" | "manual">(null);
  const [manualInput, setManualInput] = React.useState("");
  
  const [diffFile, setDiffFile] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<GitDiffFile | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffError, setDiffError] = React.useState("");

  
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

  
  const [browseRoot, setBrowseRoot] = React.useState<string>(root);
  
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
    
  }, [props.workspace]);

  
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
    if (fileExpanded[rel] ?? false) { setFileExpanded((prev) => ({ ...prev, [rel]: false })); return; }
    if (fileCache[rel]) { setFileExpanded((prev) => ({ ...prev, [rel]: true })); return; }
    void (async () => {
      await loadDir(rel);
      setFileExpanded((prev) => ({ ...prev, [rel]: true }));
    })();
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
    try { await navigator.clipboard.writeText(rel); } catch {  }
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
    
  }, [browseRoot]);

  React.useEffect(() => {
    
    if (!browseRoot || !fileCache[""]?.length) { return; }
    const firstFile = fileCache[""].find((e) => !e.isDir);
    if (firstFile && !selectedFile) {
      setSelectedFile(firstFile.rel);
      setSelectedName(firstFile.name);
      void loadFile(firstFile.rel);
    }
    
  }, [fileCache[""]]);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ctxMenu && !(e.target as HTMLElement)?.closest?.(".ctx-menu")) setCtxMenu(null);
      if (newItemPrompt && !(e.target as HTMLElement)?.closest?.(".new-item-dialog")) setNewItemPrompt(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ctxMenu, newItemPrompt]);

  
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

  const branchWrapRef = React.useRef<HTMLSpanElement | null>(null);
  React.useEffect(() => {
    if (!branchOpen) { return; }
    const onDown = (e: MouseEvent): void => {
      if (!branchWrapRef.current) { return; }
      if (!branchWrapRef.current.contains(e.target as Node)) { setBranchOpen(false); }
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { setBranchOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [branchOpen]);

  
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

  






  const renderTreeRow = (entry: WorkspaceEntry, depth: number): JSX.Element => {
    const pad = 8 + depth * 14;
    if (entry.isDir) {
      const isOpen = fileExpanded[entry.rel] ?? false;
      return (
        <div key={entry.rel}>
          <div className="tree-row file-tree-row" style={{ paddingLeft: pad, cursor: "pointer" }}
            title={entry.rel || "/"} onClick={(e) => handleFileClick(e, entry.rel, entry.name, true)}
            onContextMenu={(e) => handleFileContextMenu(e, entry.rel, entry.name, true, 0)}>
            <ChevronIcon size={11} rotate={isOpen ? 90 : 0} />
            <FolderIcon size={13} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
            <span className="tree-name tree-dir">{entry.name}</span>
            {fileLoading === entry.rel && <span className="tree-hint" style={{ fontSize: 10, marginLeft: 4 }}>加载中…</span>}
          </div>
          <div className={`collapse${isOpen ? " is-open" : ""}`}>
            <div>
              {(fileCache[entry.rel] ?? []).map((e) => renderTreeRow(e, depth + 1))}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div key={entry.rel}
        className={`tree-row tree-file ${selectedFile === entry.rel ? "file-tree-row-selected" : ""}`}
        style={{ paddingLeft: pad + 14, cursor: "pointer" }}
        title={`${entry.rel}（${fmtSize(entry.size)}）`}
        onClick={(e) => handleFileClick(e, entry.rel, entry.name, false)}
        onContextMenu={(e) => handleFileContextMenu(e, entry.rel, entry.name, false, entry.size)}>
        <span className="tree-name">{entry.name}</span>
        <span className="tree-size">{fmtSize(entry.size)}</span>
      </div>
    );
  };

  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {}
      {ctxMenu && (
        <div className="ctx-menu" ref={ctxMenuRef}
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999, background: "rgba(14, 20, 42, 0.94)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.3)", minWidth: 160, padding: "4px 0" }}>
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

      {}
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

      {}
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
          {}
          <button className="right-mini-btn" title="仓库菜单" onClick={() => setMoreOpen((v) => !v)} style={{ fontWeight: 700 }}><ChevronIcon size={12} rotate={moreOpen ? 270 : 90} /></button>
          {


}
          <div className={`pop${moreOpen ? " is-open" : ""}`} style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 30, minWidth: 230, background: "var(--panel-bg, #1c2128)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 10px 24px rgba(0,0,0,0.35)", padding: 4, fontSize: 12 }}>
            <MenuItem label="切回工作目录" disabled={!hasWorkspace || loading} hint="（自动关联）" onClick={() => props.workspace && void bindWorkspace(props.workspace)} />
            <MenuItem label="手动指定路径…" disabled={loading} hint="（Ctrl+V 粘贴）" onClick={() => { setMoreOpen(false); setModal("manual"); setManualInput(""); }} />
            <MenuItem label="克隆远程仓库…" disabled={loading} onClick={() => { setMoreOpen(false); setModal("clone"); setCloneUrl(""); }} />
            {repoPath && <MenuItem label="在资源管理器中打开" disabled={!repoPath} onClick={() => { setMoreOpen(false); const shell = (window as unknown as { slimeAPI?: { os?: { openPath?: (p: string) => Promise<unknown> } } }).slimeAPI?.os; if (shell?.openPath) { void shell.openPath(repoPath); } }} />}
            {initialized && repoPath && <MenuItem label="切换为其他仓库…" disabled={loading} onClick={() => { setMoreOpen(false); setModal("manual"); setManualInput(repoPath); }} />}
          </div>
        </div>
      </div>

        {repoPath && !detecting && (
          <div className="right-pane-head-sub" title={repoPath} style={{ cursor: "default", display: "flex", alignItems: "center", gap: 4 }}><FolderIcon size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} /><span>{repoPath}</span></div>
        )}

      {error && (
        <div style={{ padding: "6px 10px", background: "var(--danger-soft, rgba(248,81,73,0.1))", color: "var(--danger, #f85149)", fontSize: 12, borderBottom: "1px solid var(--border)" }}>{error}</div>
      )}

      {}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        {}
        <div style={{ width: "40%", minWidth: 140, maxWidth: 340, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-secondary)", borderRight: "1px solid var(--border)" }}>
          {}
          <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <button className="right-mini-btn" title="上级目录" onClick={() => void handleGoParent()} disabled={!browseRoot} style={{ padding: "2px 7px", fontSize: 12, fontWeight: 700 }}>⬆</button>
            <button className="right-mini-btn" title="打开系统文件夹（可访问任意位置）" onClick={() => void handlePickBrowseRoot()} style={{ flex: 1, justifyContent: "center", fontSize: 11 }}><FolderIcon size={13} /> 打开文件夹…</button>
          </div>
          {}
          {browseRoot && (
            <div title={browseRoot} style={{ padding: "4px 8px", fontSize: 10, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}><FolderIcon size={11} style={{ flexShrink: 0 }} />{browseRoot}</div>
          )}
          {}
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
                {(fileCache[""] ?? []).map((e) => renderTreeRow(e, 0))}
              </div>
            )}
          </div>
        </div>

        {}
        <div style={{ flex: 1, minWidth: 180, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {}
          {selectedFile && (
            <div style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-hover)", flexShrink: 0 }}>
              {renderBreadcrumb(selectedFile)}
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            {}
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
                {}
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
                    <span ref={branchWrapRef} style={{ position: "relative", marginLeft: "auto", display: "inline-flex" }}>
                      {}
                      <button
                        onClick={() => setBranchOpen((v) => !v)}
                        disabled={loading}
                        title={`切换分支（共 ${branches.length} 个）`}
                        style={{ maxWidth: 118, padding: "2px 6px", background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-primary)", fontSize: 11, cursor: loading ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 84 }}>{branch}</span>
                        <ChevronIcon size={10} rotate={branchOpen ? 270 : 90} style={{ flexShrink: 0 }} />
                      </button>
                      <div
                        className={`pop${branchOpen ? " is-open" : ""}`}
                        style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 40, minWidth: 168, maxHeight: 240, overflowY: "auto", background: "var(--dropdown-bg, #252537)", border: "1px solid var(--border)", borderRadius: 6, boxShadow: "0 10px 24px rgba(0,0,0,0.35)", padding: 4, fontSize: 12 }}
                      >
                        {branches.map((b) => (
                          <div key={b} className="ctx-menu-item"
                            onClick={() => { setBranchOpen(false); if (b !== branch) { switchBranch(b); } }}
                            title={b}
                            style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 4, cursor: "pointer", color: b === branch ? "var(--accent, #58a6ff)" : "var(--text-secondary)" }}>
                            <span style={{ width: 10, flexShrink: 0 }}>{b === branch ? "✓" : ""}</span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b}</span>
                          </div>
                        ))}
                      </div>
                    </span>
                  )}
                </div>

                {}
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

                {}
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

                {}
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
                      


                      <div className="think-diff-body diff-rows-fit">
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

                {}
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

            {}
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

      {}
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




const ARCHIVE_EXT = new Set([".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".tar.gz"]);


const BINARY_EXT = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
  ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
  ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node", ".lock",
]);


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
  mime: "text" | "docText" | "image" | "binary" | "pdf" | "office";
  content: string;   
  size: number;
  truncated?: boolean;
  error?: string;
}

function FileTab(props: { tab: TabInstance; workspace: string; onBack: () => void; onBrowseRootChange?: (root: string) => void;
  
  agentId?: string | null; sessionId?: string }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const workspaceRoot = props.workspace?.trim() || "";

  
  const openInSystem = React.useCallback(async (f: FSActionState): Promise<void> => {
    const abs = f.rel && !props.tab.fileAbs ? undefined : props.tab.fileAbs;
    const api2 = (window as unknown as { slimeAPI?: { workspace?: { openPath?: (p: string) => Promise<{ ok?: boolean; error?: string }> } } }).slimeAPI;
    if (!api2?.workspace?.openPath) { return; }
    try {
      
      const base = (props.tab.browseRoot || workspaceRoot || "").trim();
      const target = abs ?? (base ? `${base}/${f.rel}`.replace(/\\/g, "/") : f.rel);
      const r = await api2.workspace.openPath(target);
      if (r && r.ok === false && r.error) {
        console.warn("[slime] 系统打开失败:", r.error);
      }
    } catch (e) { console.warn("[slime] 系统打开异常:", e); }
  }, [props.tab.fileAbs, props.tab.browseRoot, workspaceRoot]);

  
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

  
  const extOf = (name: string): string => {
    const m = /\.([a-z0-9]+)$/i.exec(name.trim());
    return m ? `.${m[1].toLowerCase()}` : "";
  };

  
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

  
  

  const [browseRoot, setBrowseRoot] = React.useState<string>(props.tab.browseRoot ?? workspaceRoot);
  
  const [dirStack, setDirStack] = React.useState<string[]>([]);
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([]);
  const [loadingDir, setLoadingDir] = React.useState(false);
  const [dirError, setDirError] = React.useState("");
  const [pickingFolder, setPickingFolder] = React.useState(false);
  const curRel = dirStack.join("/");

  
  const [preview, setPreview] = React.useState<FSActionState | null>(null);
  const [copied, setCopied] = React.useState(false);
  
  const [mdMode, setMdMode] = React.useState<"preview" | "source">("preview");
  
  const mdScrollRef = React.useRef<HTMLDivElement | null>(null);
  const [railParamsMd, setRailParamsMd] = React.useState<RailParams>(() => loadRailParams("ticks"));
  React.useEffect(() => onRailParams((m, p) => { if (m === "ticks") { setRailParamsMd(p); } }), []);
  const mdScroller = React.useCallback((): HTMLElement | null => mdScrollRef.current, []);
  const collectMdEntries = React.useCallback((): RailEntry[] => {
    const sc = mdScrollRef.current;
    if (!sc) { return []; }
    const scTop = sc.getBoundingClientRect().top;
    
    return Array.from(sc.querySelectorAll<HTMLElement>("h1,h2,h3")).map((el) => {
      const lv = el.tagName.toLowerCase();
      return {
        top: el.getBoundingClientRect().top - scTop + sc.scrollTop,
        label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34) || "（无标题）",
        level: (lv === "h1" ? "h1" : lv === "h2" ? "h2" : "h3") as "h1" | "h2" | "h3",
      };
    });
  }, []);
  
  const [diffMode, setDiffMode] = React.useState(false);
  const [diffHead, setDiffHead] = React.useState<string | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffError, setDiffError] = React.useState("");
  





  const [diffErrorCode, setDiffErrorCode] = React.useState<"" | "not-repo" | "no-head" | "not-found">("");
  




  const [sessionDiff, setSessionDiff] = React.useState<SessionFileDiff | null>(null);
  const [diffSource, setDiffSource] = React.useState<"session" | "git">("git");
  
  React.useEffect(() => { setDiffMode(false); setDiffHead(null); setDiffError(""); setDiffErrorCode(""); }, [preview?.rel]);
  
  const [split, setSplit] = React.useState(40);
  const splitRef = React.useRef<HTMLDivElement>(null);
  







  const [listCollapsed, setListCollapsed] = React.useState<boolean>(() => {
    try { return localStorage.getItem("slime.fileTab.listCollapsed") === "1"; } catch { return false; }
  });
  const toggleListCollapsed = React.useCallback((): void => {
    setListCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("slime.fileTab.listCollapsed", next ? "1" : "0"); } catch {  }
      return next;
    });
  }, []);

  
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

  


  React.useEffect(() => {
    if (!workspaceRoot) { return; }
    if (props.tab.browseRoot) {
      if (props.tab.browseRoot !== browseRoot) { setBrowseRoot(props.tab.browseRoot); }
      return;
    }
    setBrowseRoot(workspaceRoot);
    setDirStack([]);
    
  }, [props.workspace, props.tab.browseRoot]);

  





  React.useEffect(() => {
    if (!browseRoot) { return; }
    if (props.tab.fileAbs) { return; } 
    


    const want = (props.tab.browseRel ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (want) {
      setDirStack(want.split(/[\\/]+/).filter((s) => s.length > 0));
      void listDir(browseRoot, want);
      return;
    }
    void listDir(browseRoot, "");
    
  }, [browseRoot, props.tab.fileAbs, props.tab.browseRel]);

  
  React.useEffect(() => {
    if (!props.tab.fileAbs) { return; }
    
    if (props.tab.fileContent !== undefined) {
      setPreview({
        rel: props.tab.fileAbs, name: props.tab.title ?? props.tab.fileAbs.split(/[\\/]/).pop() ?? props.tab.fileAbs,
        mime: props.tab.fileMime ?? "text", content: props.tab.fileContent, size: 0, truncated: false,
      });
    } else if (props.tab.fileError) {
      setPreview({ rel: props.tab.fileAbs, name: props.tab.title ?? "", mime: "text", content: "", size: 0, error: props.tab.fileError });
    }
    
    
    
  }, [props.tab.fileContent, props.tab.fileError]);

  

  const handlePickFolder = React.useCallback(async (): Promise<void> => {
    if (!api?.workspace?.pickBrowseRoot) { return; }
    setPickingFolder(true);
    try {
      const res = await api.workspace.pickBrowseRoot();
      if (res?.ok && res.path) {
        setBrowseRoot(res.path);
        props.onBrowseRootChange?.(res.path);
        setDirStack([]);
        setPreview(null);
        void listDir(res.path, "");
      }
    } catch {  }
    finally { setPickingFolder(false); }
  }, [api, listDir, props.tab.id, props.onBrowseRootChange]);

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
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {  }
  };

  const crumbPath = curRel ? curRel : browseRoot ? browseRoot : "（尚未选择文件夹）";
  const inBrowse = !!browseRoot;
  
  const isChatOpenedFile = !!props.tab.fileAbs;

  
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

  
  const renderPreviewBody = (): JSX.Element => {
    if (!preview) {
      
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
    
    if (preview.mime === "pdf") {
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, flexShrink: 0 }}>
            <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>📄 PDF 预览</span>
            <span style={{ color: "var(--text-dim)" }}>{preview.name} · {fmtSize(preview.size)}</span>
            <span style={{ flex: 1 }} />
            <button className="btn" style={{ padding: "3px 12px", fontSize: 11 }} onClick={() => void openInSystem(preview)}>用系统应用打开</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
            <embed src={pdfDataUrl(preview.content)} type="application/pdf" style={{ width: "100%", height: "100%", border: "none", minHeight: 420 }} />
          </div>
        </div>
      );
    }
    






    if (preview.mime === "docText") {
      const blocks = buildDocView(classifyFile(preview.name).kind, preview.content);
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, flexShrink: 0 }}>
            <FileTypeIcon filename={preview.name} size={14} />
            <span style={{ color: "var(--text-secondary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>{preview.name}</span>
            <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>文档文本</span>
            <span style={{ flex: 1 }} />
            {}
            <span style={{ color: "var(--text-dim)", fontSize: 10.5, flexShrink: 0 }}>当前窗口仅供浏览，如需修改请在系统程序中打开</span>
            {

}
            <button className="btn primary" title="转成 HTML 并用网页方式打开（可选中 / 缩放 / 查找）"
              style={{ padding: "3px 12px", fontSize: 11, flexShrink: 0 }}
              onClick={() => requestSidebarOpen({ kind: "doc", rel: preview.rel ?? "", name: preview.name, from: "user" })}>网页渲染</button>
            <button className="btn" title="用系统默认程序打开（可编辑）" style={{ padding: "3px 14px", fontSize: 11, flexShrink: 0 }} onClick={() => void openInSystem(preview)}>跳转</button>
          </div>
          <div className="doc-text-view" style={{
            flex: 1, minHeight: 0, overflow: "auto", padding: "12px 16px",
            fontSize: 12.5, lineHeight: 1.8, color: "var(--text)",
          }}>
            {blocks.length === 0
              ? <div style={{ color: "var(--text-dim)" }}>（该文档没有可显示的文本内容）</div>
              : blocks.map((b, i) => (b.type === "page" ? (
                
                <section key={i} style={{ marginBottom: 14, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ padding: "5px 10px", background: "var(--bg-secondary)", fontSize: 11, color: "var(--text-dim)", fontWeight: 600 }}>{b.label}</div>
                  <div style={{ padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{b.lines.join("\n")}</div>
                </section>
              ) : b.type === "table" ? (
                
                <div key={i} style={{ marginBottom: 16 }}>
                  {b.title && <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 4, fontWeight: 600 }}>{b.title}</div>}
                  <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                      {b.header.length > 0 && (
                        <thead><tr>{b.header.map((h, j) => (
                          <th key={j} style={{ border: "1px solid var(--border)", padding: "4px 10px", background: "var(--bg-secondary)", color: "var(--text-muted)", fontWeight: 600, textAlign: "left", whiteSpace: "nowrap", minWidth: `${DOC_CELL_MIN_EM}em` }}>{h}</th>
                        ))}</tr></thead>
                      )}
                      <tbody>{b.rows.map((r, ri) => (
                        <tr key={ri}>{r.map((c, ci) => (
                          


                          <td key={ci} style={{ border: "1px solid var(--border)", padding: "4px 10px", minWidth: `${DOC_CELL_MIN_EM}em`, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{c}</td>
                        ))}</tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              ) : (
                
                <p key={i} style={{ margin: "0 0 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{b.text}</p>
              )))}
          </div>
        </div>
      );
    }
    
    if (preview.mime === "office") {
      const officeIcon = OFFICE_ICONS[lowExt];
      return (
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, textAlign: "center" }}>
          <div style={{ fontSize: 40, lineHeight: 1 }}>{officeIcon ?? "🗎"}</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{preview.name}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
            Office 文档不在右侧栏内预览（格式复杂）。<br />
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>大小：{fmtSize(preview.size)}</span><br />
            当前窗口仅供浏览，如需修改请在系统程序中打开。
          </div>
          <button className="btn" title="用系统默认程序打开（可编辑）" style={{ marginTop: 4, padding: "7px 22px", fontSize: 12, fontWeight: 600 }} onClick={() => void openInSystem(preview)}>跳转</button>
        </div>
      );
    }
    
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
            {}
            <button className="btn" style={{ marginTop: 4, padding: "7px 18px", fontSize: 12, fontWeight: 600 }} onClick={() => void openInSystem(preview)}>用系统应用打开</button>
          </div>
        );
      }
      const view = base64ToHexView(preview.content, 512);
      return (
        <div style={{ flex: 1, overflow: "auto", padding: "10px 14px" }}>
          <div style={{ fontSize: 11, color: "var(--warning)", padding: "4px 2px 8px" }}>{BINARY_EXT.has(lowExt) ? "不可直接预览（二进制）" : "二进制文件（十六进制预览）"} · 共 {view.byteLen} 字节{view.truncated ? `，仅显示前 ${512} 字节` : ""}：</div>
          <pre style={{ fontSize: 11, fontFamily: "Consolas, monospace", color: "var(--text-secondary)", padding: 10, background: "var(--bg-hover)", borderRadius: 6, overflow: "auto", whiteSpace: "pre", margin: 0, lineHeight: 1.5 }}>{view.hex || "（无法解析）"}</pre>
          <button className="btn" style={{ marginTop: 8, padding: "6px 14px", fontSize: 12 }} onClick={() => void openInSystem(preview)}>用系统应用打开</button>
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
    
    if (!diffMode && isMd && mdMode === "preview") {
      return (
        

        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <div ref={mdScrollRef} className="rail-host"
            style={{ position: "absolute", inset: 0, overflow: "auto", padding: "12px 30px 12px 16px" }}>
            {preview.content?.trim() ? (
              <div className="markdown-body">
                <Markdown remarkPlugins={[remarkGfm]}>{preview.content}</Markdown>
              </div>
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: 12 }}>（空的 Markdown 文件）</div>
            )}
          </div>
          <TopicRail mode="ticks" scroller={mdScroller} collect={collectMdEntries} params={railParamsMd} />
        </div>
      );
    }
    const lang = langOf(preview.name);
    
    if (diffMode) {
      if (diffLoading) {
        return <div style={{ flex: 1, padding: 16, color: "var(--text-dim)", fontSize: 12 }}>读取 Git HEAD 版本…</div>;
      }
      

      const sd = diffSource === "session" ? sessionDiff : null;
      const useSession = !!sd && !sd.trimmed;
      if (!useSession && diffHead === null) {
        



        const infoOnly = diffErrorCode === "not-repo" || diffErrorCode === "no-head";
        return (
          <div style={{ flex: 1, padding: 16, fontSize: 12, color: infoOnly ? "var(--text-muted)" : diffError ? "var(--danger)" : "var(--text-dim)", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              {infoOnly && <WarningIcon size={13} style={{ flexShrink: 0, marginTop: 2, color: "#fbbf24" }} />}
              <span style={{ flex: 1 }}>{diffError || "（此文件未纳入 Git / HEAD 无此版本）"}</span>
            </div>
            <div>
              {
}
              {sessionDiff?.trimmed && (
                <div style={{ color: "var(--text-dim)" }}>提示：本次会话确实改过这个文件，但改动过大，详情未随会话记录保存（可在对话产物卡里看完整版）。</div>
              )}
              <button className="btn" style={{ padding: "4px 12px", fontSize: 12 }} onClick={() => void toggleDiff()}>返回原文件</button>
            </div>
          </div>
        );
      }
      const dRows = diffLinesFn(useSession && sd ? sd.old : (diffHead ?? ""), useSession && sd ? sd.new : preview.content);
      let addN = 0, delN = 0;
      for (const r of dRows) { if (r.op === "+") addN++; else if (r.op === "-") delN++; }
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, flexShrink: 0 }}>
            <span style={{ color: "var(--success)", fontWeight: 600 }}>+{addN}</span>
            <span style={{ color: "var(--danger)", fontWeight: 600 }}>−{delN}</span>
            <span style={{ color: "var(--text-dim)" }}>{useSession && sd ? `本次会话的改动（${sd.name}）` : "Git HEAD → 当前"}</span>
            <span style={{ flex: 1 }} />
            <button className="btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => void toggleDiff()}>返回原文件</button>
          </div>
          {

}
          <div className="diff-rows-fit" style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: "Consolas, 'Courier New', monospace", fontSize: 11.5, lineHeight: 1.6, background: "var(--bg)" }}>
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
      


      <pre style={{ flex: 1, margin: 0, padding: "12px 14px", fontSize: 13, fontFamily: "Consolas, 'Courier New', monospace", lineHeight: 1.6, color: "var(--text)", overflow: "auto", whiteSpace: lang ? "pre" : "pre-wrap", wordBreak: lang ? "normal" : "break-word", overflowWrap: lang ? "normal" : "anywhere", tabSize: 2 }}>
        {lang ? highlightCode(preview.content, lang) : preview.content}
      </pre>
    );
  };

  const selectedIsMd = !!preview && preview.mime === "text" && extOf(preview.name) === ".md";
  const canGoUp = dirStack.length > 0;

  
  const toggleDiff = async (): Promise<void> => {
    if (!preview || preview.mime !== "text") { return; }
    if (diffMode) { setDiffMode(false); return; }
    

    const sid = props.sessionId ?? "";
    const aid = props.agentId ?? "";
    const hit = aid && sid
      ? findSessionFileDiff(readSessionProducts(aid, sid), preview.rel || preview.name || "")
      : null;
    if (hit && !hit.trimmed) {
      setSessionDiff(hit); setDiffSource("session");
      setDiffMode(true); setDiffLoading(false); setDiffError(""); setDiffErrorCode("");
      return;
    }
    setSessionDiff(hit); setDiffSource("git");
    if (!workspaceRoot) { setDiffMode(true); setDiffError("未设置工作目录，无法对比 Git HEAD"); setDiffErrorCode("not-repo"); setDiffHead(null); return; }
    setDiffMode(true); setDiffLoading(true); setDiffError(""); setDiffErrorCode(""); setDiffHead(null);
    try {
      const rel = preview.rel ?? "";
      if (!rel) { setDiffError("文件不在工作区内，无法对比 Git"); setDiffErrorCode("not-found"); }
      else {
        const res = await api?.git?.showFile?.(rel, workspaceRoot);
        if (res?.ok) { setDiffHead(res.content ?? ""); }
        else {
          
          
          setDiffError(res?.error ?? "读取 Git 版本失败");
          setDiffErrorCode((res?.code as typeof diffErrorCode) ?? "");
        }
      }
    } catch (e) {
      setDiffError(`对比失败：${e instanceof Error ? e.message : String(e)}`);
      setDiffErrorCode("");
    } finally {
      setDiffLoading(false);
    }
  };

  
  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button onClick={goBack} title={canGoUp ? "返回上一级" : "返回 Git 仓库"} disabled={!canGoUp} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", cursor: canGoUp ? "pointer" : "not-allowed", color: canGoUp ? "var(--text-secondary)" : "var(--text-dim)", fontSize: 12, opacity: canGoUp ? 1 : 0.5 }}><ArrowLeftIcon size={14} /></button>
        {}
        <button onClick={toggleListCollapsed}
          title={listCollapsed ? "展开左侧文件列表" : "收起左侧文件列表（让内容占满宽度）"}
          style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", cursor: "pointer", color: listCollapsed ? "var(--accent-hover)" : "var(--text-secondary)", fontSize: 12, flexShrink: 0, display: "inline-flex", alignItems: "center" }}>
          <ChevronIcon size={13} rotate={listCollapsed ? 0 : 180} />
        </button>
        <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 3 }} title={crumbPath}><FolderIcon size={11} style={{ flexShrink: 0 }} />{crumbPath}</span>
        <button onClick={() => void handlePickFolder()} disabled={pickingFolder} title="打开系统文件夹（可访问任意位置）" style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 11, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3 }}>{pickingFolder ? "选择中…" : <><FolderIcon size={12} /> 打开文件夹</>}</button>
        {preview && preview.mime === "text" && preview.rel && (
          <button onClick={() => void toggleDiff()} title="对比改动：优先看**本次会话**对这个文件的改动，没有再对比 Git HEAD（红绿 diff）" style={{ background: "transparent", border: `1px solid ${diffMode ? "var(--accent)" : "var(--border)"}`, borderRadius: 4, padding: "2px 7px", cursor: "pointer", color: diffMode ? "var(--accent-hover)" : "var(--text-secondary)", fontSize: 11, flexShrink: 0 }}>{diffMode ? "✓ 对比中" : "对比改动"}</button>
        )}
      </div>

      {}
      <div ref={splitRef} style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
        {}
        <div style={{ width: listCollapsed ? 0 : `${split}%`, minWidth: listCollapsed ? 0 : 120, maxWidth: listCollapsed ? 0 : "75%", display: "flex", flexDirection: "column", overflow: "hidden", borderRight: listCollapsed ? "none" : "1px solid var(--border)" }}>
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
            {}
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

        {}
        <div onMouseDown={startResize} title="拖动调整分栏宽度" style={{ width: 4, flexShrink: 0, cursor: "col-resize", position: "relative", zIndex: 1, alignSelf: "stretch" }} />

        {}
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
          {}
          {props.tab.fileNotice && (
            <div className="file-notice" style={{
              flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 12px",
              fontSize: 11, lineHeight: 1.6, color: "var(--warning, #fbbf24)",
              background: "rgba(251, 191, 36, 0.10)", borderBottom: "1px solid var(--border)",
            }}>
              <WarningIcon size={12} style={{ flexShrink: 0, marginTop: 3 }} />
              <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{props.tab.fileNotice}</span>
            </div>
          )}
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



   interface AccumUsage {
  requests: number;
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  









  costUsdFromCn: number;
  

  reasoningEstimated?: boolean;
  








  cacheReadInPrompt?: boolean;
}

interface ModelPriceInfo {
  price_in_usd?: number;
  price_out_usd?: number;
  




  price_currency?: PriceCurrency;
}

const EMPTY_USAGE: AccumUsage = { requests: 0, elapsedMs: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 0, costUsdFromCn: 0 };

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TaskStatus;
  blockedBy?: string[];
  blocks?: string[];
  
  completedAt?: string;
}






function toTodoItems(raw: Array<{ id?: string; content?: string; status?: string; completedAt?: string }>): TodoItem[] {
  return raw.map((t) => ({
    id: t.id ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content: String(t.content ?? ""),
    status: (t.status as TaskStatus) ?? "pending",
    completedAt: t.completedAt,
  }));
}











function TodoCheck({ size = 15, animate }: { size?: number; animate?: boolean }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0, display: "block" }}>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="var(--success)" />
      <path
        className={animate ? "todo-check-path" : undefined}
        d="M7 12.4l3.3 3.3L17 8.6"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        style={animate ? undefined : { strokeDasharray: 100, strokeDashoffset: 0 }}
      />
    </svg>
  );
}





function TodoGroupLabel({ text, count, tone }: { text: string; count: number; tone: "accent" | "muted" | "success" }): JSX.Element {
  const color = tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : "var(--text-dim)";
  
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 5px 0", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, color }}>
      <span>{text}</span>
      <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}










function TodoCountChip({ text, tone }: { text: string; tone: "accent" | "success" }): JSX.Element {
  const success = tone === "success";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      height: 16, minWidth: 28, padding: "0 6px", borderRadius: 999,
      background: success ? "var(--success-soft)" : "var(--accent-soft)",
      color: success ? "var(--success)" : "var(--accent)",
      fontSize: 10, fontWeight: 700, lineHeight: 1,
      fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", flexShrink: 0,
    }}>{text}</span>
  );
}


function fmtDoneAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return ""; }
  const p = (n: number): string => String(n).padStart(2, "0");
  const now = new Date();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}



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
            
            const parts = choice.split(":");
            





            const isApiForm = parts[0] === "api";
            const modelId = isApiForm ? (parts[parts.length - 1] ?? "") : choice;
            const key = isApiForm && parts.length >= 3 ? parts[1] : null;
            const providers = await api.providers.list().catch(() => [] as Array<{ key: string; models?: Array<{ id: string; context_window?: number }> }>);
            if (key) {
              const prov = providers.find((p: { key: string }) => p.key === key);
              const hit = prov?.models?.find((x: { id: string; context_window?: number }) => x.id === modelId);
              
              ctx = hit?.context_window;
            } else {
              for (const p of providers) {
                const m = p.models?.find((x: { id: string; context_window?: number }) => x.id === modelId);
                if (m?.context_window && m.context_window > 0) { ctx = m.context_window; break; }
              }
            }
          }
          if (ctx && ctx > 0) { setCap(ctx); return; }
          
          const fbId = choice.includes(":") ? choice.split(":").pop()! : choice;
          const fallbackHit = fallback.find((m) => m.id === fbId);
          if (fallbackHit?.context_window && fallbackHit.context_window > 0) { setCap(fallbackHit.context_window); return; }
        } catch {  }
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
  
  const [modelChoice, setModelChoice] = React.useState<string | undefined>(undefined);
  const active = props.active !== false;
  
  const [isStreaming, setIsStreaming] = React.useState(false);
  React.useEffect(() => {
    





    const off1 = api?.chat?.onChunk?.(() => setIsStreaming(true));
    const off2 = api?.chat?.onDone?.(() => setIsStreaming(false));
    const off3 = api?.chat?.onError?.(() => setIsStreaming(false));
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [api]);
  
  const [acRatio, setAcRatio] = React.useState<number>(() => readAutoCompressCfg().ratio);
  React.useEffect(() => {
    const sync = (): void => setAcRatio(readAutoCompressCfg().ratio);
    window.addEventListener(AUTOCOMPRESS_CFG_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AUTOCOMPRESS_CFG_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  





  const [ledgerPref, setLedgerPref] = React.useState<LedgerCurrencyPref>(() => readLedgerCurrencyPref());
  React.useEffect(() => {
    const sync = (): void => setLedgerPref(readLedgerCurrencyPref());
    const onEvent = (e: Event): void => {
      const d = (e as CustomEvent<LedgerCurrencyPref>).detail;
      setLedgerPref(d === "USD" || d === "CNY" || d === "auto" ? d : readLedgerCurrencyPref());
    };
    window.addEventListener(LEDGER_CURRENCY_EVENT, onEvent);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(LEDGER_CURRENCY_EVENT, onEvent);
      window.removeEventListener("storage", sync);
    };
  }, []);
  React.useEffect(() => {
    if (!active) { return; }
    let cancelled = false;
    const refreshModel = async (): Promise<void> => {
      try {
        const list = await api?.agents?.list?.();
        if (cancelled || !list) { return; }
        const hit = (list as Array<{ id: string; name: string }>).find((a) => a.name === props.agentName) || (list as Array<{ id: string }>)[0];
        if (!hit) { return; }
        const d = await api?.agents?.detail?.(hit.id) as { model_choice?: string } | null;
        if (cancelled) { return; }
        if (d?.model_choice !== undefined) { setModelChoice(d.model_choice); }
      } catch {  }
    };
    void refreshModel();
    const timer = setInterval(() => { void refreshModel(); }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.agentName, active]);
  



  const pricesRefreshRef = React.useRef<(() => void) | null>(null);
  
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const ps = await api?.providers?.list?.();
        if (cancelled) { return; }
        const m = new Map<string, ModelPriceInfo>();
        for (const p of ps) {
          for (const mod of (p.models ?? [])) {
            if (mod.price_in_usd || mod.price_out_usd) {
              m.set(mod.id, {
                price_in_usd: mod.price_in_usd,
                price_out_usd: mod.price_out_usd,
                
                price_currency: mod.price_currency,
              });
            }
          }
        }
        modelPricesRef.current = m;
      } catch {  }
    };
    void refresh();
    pricesRefreshRef.current = () => { void refresh(); }; 
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (pricesRefreshRef.current) { pricesRefreshRef.current = null; }
    };
  }, [modelChoice]);
  const [events, setEvents] = React.useState<TaskEvent[]>([]);
  const [running, setRunning] = React.useState(false);
  const idRef = React.useRef(0);
  

  const loadPersisted = React.useCallback(() => {
    
    
    
    if (!props.agentId || !props.sessionId) { return null; }
    try {
      const raw = localStorage.getItem(`slime_tasks_${props.agentId}_${props.sessionId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { usage: AccumUsage; todos: TodoItem[] };
        return parsed;
      }
    } catch {  }
    return null;
  }, [props.agentId, props.sessionId]);
  const persisted = loadPersisted();
  const [usage, setUsage] = React.useState<AccumUsage>(persisted?.usage ?? EMPTY_USAGE);
  


  const [liveUsed, setLiveUsed] = React.useState(0);
  const [liveCap, setLiveCap] = React.useState(0);
  
  const [liveTurn, setLiveTurn] = React.useState<{ reply: number; reason: number }>({ reply: 0, reason: 0 });
  const liveTurnRef = React.useRef<{ reply: number; reason: number }>({ reply: 0, reason: 0 });
  
  const [liveElapsed, setLiveElapsed] = React.useState(0);
  
  const resetLiveTurn = React.useCallback((): void => {
    liveTurnRef.current = { reply: 0, reason: 0 };
    setLiveTurn({ reply: 0, reason: 0 });
    
    
    
    pendingCtxRef.current.reply = 0;
    pendingCtxRef.current.reason = 0;
    pendingCtxRef.current.elapsedMs = 0;
  }, []);
  
  const [liveBuckets, setLiveBuckets] = React.useState<CtxBuckets | undefined>(undefined);
  

  const sessionIdRef = React.useRef(props.sessionId);
  React.useEffect(() => { sessionIdRef.current = props.sessionId; }, [props.sessionId]);
  










  const LIVE_APPLY_MS = 1000;
  const pendingCtxRef = React.useRef<{
    used?: number; cap?: number; buckets?: CtxBuckets; reply?: number; reason?: number; elapsedMs?: number;
  }>({});
  const appliedCtxOnceRef = React.useRef(false);
  
  const ctxApplyTimerRef = React.useRef<number | null>(null);
  
  const applyPendingCtx = React.useCallback((): void => {
    const q = pendingCtxRef.current;
    if (typeof q.used === "number" && q.used > 0) { setLiveUsed(q.used); }
    if (typeof q.cap === "number" && q.cap > 0) { setLiveCap(q.cap); }
    if (q.buckets) { setLiveBuckets(q.buckets); }
    const turn = { reply: q.reply ?? 0, reason: q.reason ?? 0 };
    liveTurnRef.current = turn;
    setLiveTurn(turn);
    setLiveElapsed(typeof q.elapsedMs === "number" && q.elapsedMs > 0 ? q.elapsedMs : 0);
    appliedCtxOnceRef.current = true;
  }, []);
  
  const scheduleApply = React.useCallback((): void => {
    if (ctxApplyTimerRef.current !== null) { return; }
    ctxApplyTimerRef.current = window.setTimeout(() => {
      ctxApplyTimerRef.current = null;
      applyPendingCtx();
    }, LIVE_APPLY_MS);
  }, [applyPendingCtx]);
  
  React.useEffect(() => () => {
    if (ctxApplyTimerRef.current !== null) {
      window.clearTimeout(ctxApplyTimerRef.current);
      ctxApplyTimerRef.current = null;
    }
  }, []);
  
  React.useEffect(() => {
    const off = onCtxUpdate((p) => {
      if (p.sessionId !== sessionIdRef.current) { return; }
      
      const q = pendingCtxRef.current;
      if (p.used > 0) { q.used = p.used; }
      if (p.cap > 0) { q.cap = p.cap; }
      if (p.buckets) { q.buckets = p.buckets; }
      q.reply = typeof p.liveReplyTokens === "number" ? p.liveReplyTokens : 0;
      q.reason = typeof p.liveReasonTokens === "number" ? p.liveReasonTokens : 0;
      q.elapsedMs = typeof p.liveElapsedMs === "number" ? p.liveElapsedMs : 0;
      
      
      if (!appliedCtxOnceRef.current) { applyPendingCtx(); } else { scheduleApply(); }
    });
    return off;
  }, [applyPendingCtx, scheduleApply]);
  
  React.useEffect(() => {
    const iv = window.setInterval(() => { applyPendingCtx(); }, 10_000);
    return () => window.clearInterval(iv);
  }, [applyPendingCtx]);

  









  const LIVE_POLL_MS = 250;
  React.useEffect(() => {
    const iv = window.setInterval(() => {
      const s = readLiveMonitor(props.sessionId ?? "");
      if (!s) { return; }
      if (s.used > 0) { setLiveUsed(s.used); }
      if (s.cap > 0) { setLiveCap(s.cap); }
      const turn = { reply: s.replyTokens, reason: s.reasonTokens };
      liveTurnRef.current = turn;
      setLiveTurn((prev) => (prev.reply === turn.reply && prev.reason === turn.reason ? prev : turn));
      setLiveElapsed((prev) => (prev === s.elapsedMs ? prev : s.elapsedMs));
    }, LIVE_POLL_MS);
    return () => window.clearInterval(iv);
  }, [props.sessionId]);
  

  React.useEffect(() => {
    const meta = readSessionCtxMeta(props.agentId, props.sessionId);
    setLiveUsed(restoreUsed(meta));
    if (meta?.cap && meta.cap > 0) { setLiveCap(meta.cap); }
    resetLiveTurn(); 
    
    pendingCtxRef.current = {};
    appliedCtxOnceRef.current = false;
    setLiveElapsed(0);
    
  }, [props.agentId, props.sessionId]);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const flatFallback = React.useMemo(
    () => (props.providerModels ?? []).flatMap((p) => (p.models ?? []).map((m) => ({ id: m.id, context_window: m.context_window }))),
    [props.providerModels],
  );
  const maxCtx = useAgentMaxContext(props.agentName, modelChoice, flatFallback);
  const [todos, setTodos] = React.useState<TodoItem[]>(persisted?.todos ?? []);
  const [collapsedTodos, setCollapsedTodos] = React.useState(false);
  
  const [logTab, setLogTab] = React.useState<"activity" | "files">("activity");
  const [todoInput, setTodoInput] = React.useState("");
    
    const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushPersist = React.useCallback(() => {
      
      
      if (!props.agentId || !props.sessionId) { return; }
      if (persistTimerRef.current !== null) { clearTimeout(persistTimerRef.current); }
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        try { localStorage.setItem(`slime_tasks_${props.agentId}_${props.sessionId}`, JSON.stringify({ usage, todos })); } catch {  }
      }, 300);
    }, [props.agentId, props.sessionId, usage, todos]);
    React.useEffect(() => { void flushPersist(); }, [flushPersist]);
    
    
    React.useEffect(() => {
      
      
      
      if (!props.agentId || !props.sessionId) {
        setTodos([]);
        setUsage(EMPTY_USAGE);
        return;
      }
      const p = loadPersisted();
      if (p) { setTodos(p.todos); setUsage(p.usage); } else { setTodos([]); setUsage(EMPTY_USAGE); }
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      
      
      
      
      
      
      
      
      
      
      let alive = true;
      void api?.tasks?.loadTodos?.(props.sessionId)
        .then((r: { todos?: Array<{ id?: string; content?: string; status?: string; completedAt?: string }> } | undefined) => {
          if (!alive || !r || !Array.isArray(r.todos)) { return; }
          setTodos(toTodoItems(r.todos));
        })
        .catch(() => {  });
      return () => { alive = false; };
      
    }, [props.agentId, props.sessionId]);
    
    React.useEffect(() => {
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      if (!api?.tasks?.onTodos) { return; }
      const off = api.tasks.onTodos((data: { sessionId: string; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }) => {
        
        
        
        if (!props.sessionId || !data.sessionId || data.sessionId !== props.sessionId) { return; }
        setTodos(toTodoItems(data.todos));
      });
      return () => { off(); };
    }, [props.sessionId]);

  












  const persistTodos = React.useCallback((next: TodoItem[]): void => {
    setTodos(next);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!props.sessionId) { return; }
    void api?.tasks?.saveTodos?.(props.sessionId, next).catch(() => {  });
  }, [props.sessionId]);

  
  const clearAllTodos = React.useCallback(async (): Promise<void> => {
    if (!props.sessionId || todos.length === 0) { return; }
    const ok = await confirmAsync(
      `清空待办清单？将删除本会话的全部 ${todos.length} 项（含已完成记录）并删除落盘文件。`,
      "此操作不可撤销。若非本会话的任务，请先确认当前会话是否正确。",
    );
    if (!ok) { return; }
    setTodos([]);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void api?.tasks?.clearTodos?.(props.sessionId).catch(() => {  });
  }, [props.sessionId, todos.length]);

  const toggleTodoCollapse = React.useCallback(() => setCollapsedTodos((v) => !v), []);

  const addTodo = React.useCallback(() => {
    
    
    if (!props.agentId || !props.sessionId) { return; }
    const content = todoInput.trim();
    if (!content) { return; }
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    persistTodos([...todos, { id, content, status: "pending" }]);
    setTodoInput("");
  }, [todoInput, todos, props.agentId, props.sessionId, persistTodos]);

  const toggleTodo = React.useCallback((id: string) => {
    if (!props.sessionId) { return; }
    persistTodos(todos.map((t) => {
      if (t.id !== id) { return t; }
      
      if (t.status === "completed") { return { ...t, status: "pending", completedAt: undefined }; }
      return { ...t, status: "completed", completedAt: t.completedAt ?? new Date().toISOString() };
    }));
  }, [todos, props.sessionId, persistTodos]);

  const advanceTodo = React.useCallback((id: string) => {
    if (!props.sessionId) { return; }
    
    persistTodos(todos.map((t) => {
      if (t.id === id) { return t.status === "completed" ? t : { ...t, status: "in_progress" }; }
      return t.status === "in_progress" ? { ...t, status: "pending" } : t;
    }));
  }, [todos, props.sessionId, persistTodos]);

  










  










  const [justDoneIds, setJustDoneIds] = React.useState<string[]>([]);
  const prevStatusRef = React.useRef<{ sid: string; map: Map<string, TaskStatus> } | null>(null);
  React.useEffect(() => {
    const sid = props.sessionId ?? "";
    const prev = prevStatusRef.current;
    prevStatusRef.current = { sid, map: new Map(todos.map((t) => [t.id, t.status])) };
    if (!prev || prev.sid !== sid) { setJustDoneIds([]); return; }
    const flipped = todos.filter((t) => t.status === "completed" && prev.map.get(t.id) && prev.map.get(t.id) !== "completed").map((t) => t.id);
    if (flipped.length === 0) { return; }
    setJustDoneIds(flipped);
    const timer = window.setTimeout(() => setJustDoneIds([]), 900);
    return () => window.clearTimeout(timer);
  }, [todos, props.sessionId]);

  




  const todoGroups = React.useMemo(() => {
    const active = todos.filter((t) => t.status === "in_progress");
    const pending = todos.filter((t) => t.status === "pending");
    const done = todos.filter((t) => t.status === "completed");
    return { active, pending, done };
  }, [todos]);

  




  const sessionReady = Boolean(props.sessionId);
  
  const multiGroup = [todoGroups.active, todoGroups.pending, todoGroups.done].filter((g) => g.length > 0).length > 1;

  const pushEvent = React.useCallback((kind: TaskEvent["kind"], label: string, tool?: string): void => {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    setEvents((prev) => [{ id: ++idRef.current, time, kind, label, ...(tool ? { tool } : {}) }, ...prev].slice(0, 200));
  }, []);

  React.useEffect(() => {
    if (!api?.chat) { return; }
    const off1 = api.chat.onChunk((c: { type?: string; data?: any }) => {
      const t = c?.type;
      if (t === "tool") {
        const name = c.data?.name ?? "";
        
        
        let detail = "";
        try {
          const args = typeof c.data?.args === "string" ? JSON.parse(c.data.args) : (c.data?.args ?? {});
          if (args.path && typeof args.path === "string") { detail = args.path; }
          else if (args.file && typeof args.file === "string") { detail = args.file; }
          else if (args.url && typeof args.url === "string") { detail = args.url; }
          else if (args.query && typeof args.query === "string") { detail = args.query; }
        } catch {  }
        
        
        
        const label = name.startsWith("delegate:")
          ? `传唤子 Agent「${name.slice(9)}」`
          : `${resolveToolLabel(name).label}${detail ? ` ${detail}` : ""}`;
        pushEvent("tool", label, name);
      } else if (t === "reasoning") { setRunning(true); }
      else if (t === "progress") { pushEvent("progress", c.data?.progress ?? c.data?.content ?? "子任务进行中…"); }
      else if (t === "chunk") { setRunning(true); }
    });
    const off2 = api.chat.onDone((m: { interrupted?: boolean; timings?: Record<string, number>; model?: string; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }) => {
      
      if (m.sessionId != null && m.sessionId !== sessionIdRef.current) { return; }
      setRunning(false);
      pushEvent("done", m?.interrupted ? "⏹ 已中断" : "回复完成");
      pricesRefreshRef.current?.(); 
      const t = m?.timings ?? {};
      const pt = typeof t.promptTokens === "number" ? t.promptTokens : 0;
      const ct = typeof t.completionTokens === "number" ? t.completionTokens : 0;
      const rtReal = typeof t.reasoningTokens === "number" ? t.reasoningTokens : 0;
      const cr = typeof t.cacheReadTokens === "number" ? t.cacheReadTokens : 0;
      
      
      
      const cri = t.cacheReadInPrompt === 1 ? true : t.cacheReadInPrompt === 0 ? false : undefined;
      const em = typeof t.elapsedMs === "number" ? t.elapsedMs : 0;
      
      
      
      const turnLive = liveTurnRef.current;
      const reasonEst = Math.round(turnLive.reason);
      const rt = rtReal > 0 ? rtReal : reasonEst;
      const markingEstimated = rtReal <= 0 && reasonEst > 0;
      
      const cost = computeModelCost(m?.model ?? "", pt, ct, modelPricesRef.current);
      
      
      
      
      const modelForCost = m?.model ?? "";
      const costCur = pricingDisplayCurrency(modelForCost, modelPricesRef.current.get(modelForCost)?.price_currency);
      const costFromCn = costCur === "CNY" ? cost : 0;
      setUsage((prev) => ({
        requests: prev.requests + 1, elapsedMs: prev.elapsedMs + em,
        promptTokens: prev.promptTokens + pt, completionTokens: prev.completionTokens + ct,
        reasoningTokens: prev.reasoningTokens + rt, cacheReadTokens: prev.cacheReadTokens + cr,
        costUsd: prev.costUsd + cost,
        costUsdFromCn: prev.costUsdFromCn + costFromCn,
        ...(prev.reasoningEstimated || markingEstimated ? { reasoningEstimated: true } : {}),
        ...(cri === undefined ? {} : { cacheReadInPrompt: cri }),
      }));
      resetLiveTurn(); 
      
      
      applyPendingCtx();
    });
    const off3 = api.chat.onError((e: { message?: string }) => {
      setRunning(false);
      resetLiveTurn(); 
      pushEvent("error", `✕ ${e?.message ?? "出错"}`);
    });
    let off4: (() => void) | undefined;
    if (api.chat.onNewConversation) {
      off4 = api.chat.onNewConversation(() => { setEvents([]); setUsage(EMPTY_USAGE); setTodos([]); });
    }
    
    const off5 = api.conversations?.onChanged?.(() => {
      
      
      
    });
    return () => { off1(); off2(); off3(); off4?.(); off5?.(); };
  }, [api, pushEvent, modelPricesRef]);

  



  const badge = (k: TaskEvent["kind"]): { color: string; bg: string; text: string; Icon?: (p: IconProps) => JSX.Element } => {
    switch (k) {
      case "tool": return { color: "var(--accent)", bg: "var(--accent-soft)", text: "工具" };
      case "thinking": return { color: "var(--accent-hover)", bg: "var(--accent-soft)", text: "思考" };
      case "progress": return { color: "var(--warning)", bg: "rgba(251,191,36,0.12)", text: "进度" };
      
      
      case "done": return { color: "var(--success)", bg: "var(--success-soft)", text: "完成", Icon: DoneIcon };
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

  




  const renderTodoRow = (todo: TodoItem): JSX.Element => {
    const done = todo.status === "completed";
    const justDone = justDoneIds.includes(todo.id);
    const label = done ? "已完成" : todo.status === "in_progress" ? "进行中" : "待办";
    return (
      <div
        key={todo.id}
        role="listitem"
        className="todo-row"
        data-status={todo.status}
        data-just-done={justDone ? "1" : undefined}
        aria-label={`${todo.content}（${label}${done && todo.completedAt ? `，完成于 ${fmtDoneAt(todo.completedAt)}` : ""}）`}
        style={{
          display: "flex", alignItems: "center", gap: 5, padding: "3px 5px", borderRadius: 5,
          background: todo.status === "in_progress" ? "var(--accent-soft)" : "transparent",
          borderLeft: `2px solid ${todoBadge(todo.status).dot}`,
        }}
      >
        <button onClick={() => toggleTodo(todo.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", flexShrink: 0 }} title={done ? "标记为未完成" : "标记为已完成"}>
          {done ? <TodoCheck size={14} animate={justDone} /> : <CheckboxIcon size={14} style={{ color: "var(--text-muted)" }} />}
        </button>
        {}
        {todo.status === "in_progress"
          ? <LoadingCircleIcon size={12} className="icon-spin" style={{ color: "var(--accent)", flexShrink: 0 }} />
          : todo.status === "pending"
            ? <button onClick={() => advanceTodo(todo.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, width: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }} title="标记为进行中"><span className="todo-play">▶</span></button>
            : <span style={{ width: 13, flexShrink: 0 }} />}
        {




}
        <span className="todo-text" style={{ flex: 1, minWidth: 0, overflow: "hidden", fontSize: 11.5, color: done ? "var(--text-muted)" : "var(--text-primary)" }}>
          <span className="todo-text-inner">
            {todo.content}
            <span className="todo-text-veil" aria-hidden="true">{todo.content}</span>
          </span>
        </span>
        {done && todo.completedAt && (
          <span title={`完成于 ${new Date(todo.completedAt).toLocaleString()}`} style={{ flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{fmtDoneAt(todo.completedAt)}</span>
        )}
      </div>
    );
  };

  



  const capNow = liveCap > 0 ? liveCap : maxCtx;

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
                {
}
                <span>{d.target === "llama" ? "llama.cpp" : "BGE-M3"}{" · "}{d.state === "paused" ? "已暂停" : phaseLabel(d.phase)}</span>
                <span>{Math.round(d.percent)}%</span>
              </div>
              <div className="dl-bar"><div className="dl-bar-inner" style={{ width: `${Math.min(100, d.percent)}%` }} /></div>
              {d.detail && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{d.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="right-scroll" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {

}
        <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
            <span>会话指标</span>
            {isStreaming && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", animation: "thinkGlow 1.4s ease-in-out infinite", flexShrink: 0 }} />}
          </div>
          <MetricsGrid usage={usage} pref={ledgerPref} cap={capNow} live={{ reply: liveTurn.reply, reason: liveTurn.reason, elapsedMs: liveElapsed }} />
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5, display: "flex", alignItems: "center", gap: 5 }}>
            {isStreaming
              ? "流式中 · 指标随本轮输出实时刷新"
              : "累计值 · 发起对话后实时刷新；展开「明细」看四项构成"}
          </div>
        </div>

        <div style={{ borderBottom: "1px solid var(--border)", padding: "6px 10px 7px", flexShrink: 0 }}>
          {
}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <button onClick={toggleTodoCollapse} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: 0 }}
              title={collapsedTodos ? "展开待办列表" : "收起待办列表"}>
              {


}
              <ChevronIcon rotate={collapsedTodos ? 0 : 90} size={12} style={{ color: "var(--text-muted)" }} />
              <TaskIcon size={13} style={{ color: "var(--text-muted)" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>待办任务</span>
              {sessionReady && todos.length > 0 && (
                todoPct === 100
                  ? <TodoCountChip text="全部完成 ✓" tone="success" />
                  : <TodoCountChip text={`${todoDone}/${todos.length}`} tone="accent" />
              )}
            </button>
            {



}
            {sessionReady && todos.length > 0 && (
              <button
                onClick={() => { void clearAllTodos(); }}
                title="清空本会话的整张待办清单（删除落盘文件，需确认）"
                style={{
                  marginLeft: "auto", background: "transparent", border: "1px solid var(--border)",
                  cursor: "pointer", borderRadius: 6, padding: "1px 7px",
                  fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0,
                }}>清空</button>
            )}
          </div>
          {sessionReady && todos.length > 0 && (
            <div style={{ height: 3, borderRadius: 999, background: "var(--input-bg)", overflow: "hidden", marginBottom: 4 }}>
              <div style={{ width: `${todoPct}%`, height: "100%", background: todoPct === 100 ? "var(--success)" : "var(--accent)", borderRadius: 999, transition: "width .3s ease, background-color .3s ease" }} />
            </div>
          )}
          {

}
          <div className={`collapse${collapsedTodos ? "" : " is-open"}`}>
            <div>
              <div role="list" style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 220, overflowY: "auto", marginBottom: 5 }}>
                {}
                {!sessionReady && <div className="tree-hint" style={{ padding: "4px 0", fontSize: 11.5 }}>正在加载会话…</div>}
                {sessionReady && todos.length === 0 && <div className="tree-hint" style={{ padding: "4px 0", fontSize: 11.5 }}>暂无任务 — Agent 规划后会自动显示，也可手动添加</div>}
                {
}
                {sessionReady && multiGroup && todoGroups.active.length > 0 && <TodoGroupLabel text="进行中" count={todoGroups.active.length} tone="accent" />}
                {sessionReady && todoGroups.active.map(renderTodoRow)}
                {sessionReady && multiGroup && todoGroups.pending.length > 0 && <TodoGroupLabel text="待办" count={todoGroups.pending.length} tone="muted" />}
                {sessionReady && todoGroups.pending.map(renderTodoRow)}
                {sessionReady && multiGroup && todoGroups.done.length > 0 && <TodoGroupLabel text="已完成" count={todoGroups.done.length} tone="success" />}
                {sessionReady && todoGroups.done.map(renderTodoRow)}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <input value={todoInput} disabled={!sessionReady} onChange={(e) => setTodoInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { addTodo(); } }}
              placeholder={sessionReady ? "添加任务…" : "会话加载中…"}
              style={{ flex: 1, minWidth: 0, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 8px", fontSize: 11.5, color: "var(--text-primary)", outline: "none", opacity: sessionReady ? 1 : 0.5 }} />
            <button onClick={addTodo} disabled={!sessionReady} style={{ background: "var(--accent-soft)", border: "none", borderRadius: 4, cursor: sessionReady ? "pointer" : "default", display: "flex", alignItems: "center", padding: "3px 6px", opacity: sessionReady ? 1 : 0.5 }} title="添加任务">
              <CirclePlusIcon size={13} style={{ color: "var(--accent)" }} />
            </button>
          </div>
        </div>

        {}
        <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          <ContextWindowBar
            used={liveUsed}
            cap={capNow}
            
            compressCount={(() => {
              if (capNow <= 0 || liveUsed <= 0) { return 0; }
              const thr = capNow * acRatio;
              return Math.max(0, Math.round(thr - liveUsed));
            })()}
            
            thresholdPct={Math.round(acRatio * 100)}
            compose={{
              promptTokens: usage.promptTokens,
              
              completionTokens: usage.completionTokens + liveTurn.reply,
              reasoningTokens: usage.reasoningTokens + liveTurn.reason,
              cacheReadTokens: usage.cacheReadTokens,
              
              cacheReadInPrompt: usage.cacheReadInPrompt,
            }}
            buckets={liveBuckets}
            detailOpen={detailOpen}
            onToggleDetail={() => setDetailOpen((v) => !v)}
          />
          {

}
          <div className={`collapse${detailOpen ? " is-open" : ""}`}>
            <div>
              <UsageBreakdown usage={usage} live={liveTurn} detailOpen={detailOpen} cap={capNow} onToggleDetail={() => setDetailOpen((v) => !v)} />
            </div>
          </div>
        </div>

        {

}
        <div style={{ borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", gap: 2, padding: "6px 10px 0", flexShrink: 0 }}>
            {(["activity", "files"] as const).map((t) => (
              <button key={t} onClick={() => setLogTab(t)} style={{ padding: "5px 12px", fontSize: 11.5, borderRadius: "6px 6px 0 0", border: "none", cursor: "pointer", background: "none", color: logTab === t ? "var(--accent)" : "var(--text-muted)", borderBottom: logTab === t ? "2px solid var(--accent)" : "2px solid transparent", fontWeight: logTab === t ? 700 : 500 }}>
                {t === "activity" ? "活动记录" : "会话文件"}
                {t === "activity" && <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.8 }}>{events.length}</span>}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px 16px" }}>
            {logTab === "activity" ? (
              <>
                {events.length === 0 && <div className="tree-hint">暂无活动 — Agent 开始工作后，工具调用 / 思考 / 进度会实时显示在这里</div>}
                {events.map((ev) => {
                  const b = badge(ev.kind);
                  





                  const RowIcon = (ev.tool ? resolveToolLabel(ev.tool).Icon : null) ?? b.Icon ?? null;
                  const rowTitle = ev.tool ? resolveToolLabel(ev.tool).label : b.text;
                  return (
                    <div key={ev.id} className="task-row">
                      <span className="task-time">{ev.time}</span>
                      {RowIcon ? (
                        <span className="task-badge task-badge-icon" title={rowTitle}
                          style={{ color: b.color, background: b.bg }}>
                          <RowIcon size={11} />
                        </span>
                      ) : (
                        <span className="task-badge" style={{ color: b.color, background: b.bg }}>{b.text}</span>
                      )}
                      <span className="task-label" title={ev.label}>{ev.label}</span>
                    </div>
                  );
                })}
              </>
            ) : (
              (() => {
                
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
  const CP = "#60a5fa";  
  const CR = "#34d399";  
  const CM = "#f472b6";  
  const CW = "#fbbf24";  
  const CPL = "#a78bfa"; 
  const CT = "#fb923c"; 
  const CH = "#94a3b8"; 
  const CMSG = "#38bdf8"; 
  const palette = [CP, CR, CM, CW, CPL, CT, CH, CMSG];
  
  const { segments } = bucketsSegments(B.map((x) => ({ key: x.label, tokens: x.n })));
  return B.map((x, i) => {
    const s = segments.find((q) => q.key === x.label);
    return { ...x, pct: s?.pct ?? 0, color: palette[i] };
  });
}

function ContextWindowBar({ used, cap, compressCount, compose, buckets, detailOpen, onToggleDetail, thresholdPct = 80 }: {
  used: number; cap: number; compressCount: number;
  
  compose?: { promptTokens: number; completionTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheReadInPrompt?: boolean };
  
  buckets?: CtxBuckets;
  detailOpen?: boolean; onToggleDetail?: () => void;
  

  thresholdPct?: number;
}): JSX.Element {
  const pct = contextRatio(used, cap);
  const pctLabel = contextPct(pct);
  const status = cap === 0
    ? { txt: "上限未配置", cls: "var(--text-muted)", bg: "rgba(139,148,158,0.14)" }
    : pct < 0.6 ? { txt: "上下文充足", cls: "#2ea043", bg: "rgba(46,160,67,0.15)" }
      : pct < 0.85 ? { txt: "接近上限", cls: "#d29922", bg: "rgba(210,153,34,0.15)" }
        : { txt: "逼近硬阈值", cls: "#f85149", bg: "rgba(248,81,73,0.16)" };
  const color = ringLevel(pct).color;
  
  const { segments: comps, any: hasCompose } = composeSegments({
    promptTokens: compose?.promptTokens ?? 0,
    cacheReadTokens: compose?.cacheReadTokens ?? 0,
    completionTokens: compose?.completionTokens ?? 0,
    reasoningTokens: compose?.reasoningTokens ?? 0,
    cacheReadInPrompt: compose?.cacheReadInPrompt,
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 9px", borderRadius: 999, fontWeight: 700, fontSize: 11, color: status.cls, background: status.bg }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: status.cls }} />
          {status.txt}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{fmtTokens(used, cap)}/{cap > 0 ? fmtTokens(cap, cap) : "-"}</span>
      </div>
      <div style={{ position: "relative", margin: "2px 0 10px", height: 8, borderRadius: 999, background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", overflow: "hidden" }}>
        {}
        <div aria-hidden style={{ position: "absolute", left: `${Math.max(0, Math.min(100, thresholdPct))}%`, top: 0, bottom: 0, width: 1, background: "rgba(139,148,158,0.75)" }} />
        <div style={{ position: "absolute", left: 2, top: -18, fontSize: 10.5, color: color, fontWeight: 700 }}>{pctLabel}%</div>
        <div style={{ position: "absolute", right: 4, top: -18, fontSize: 10.5, color: "var(--text-muted)", fontWeight: 600 }} title="自动压缩触发阈值（设置 → 通用 → 上下文自动压缩）">{thresholdPct}% 压缩</div>
        {pct > 0 && <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 999, transition: "width .25s ease" }} />}
      </div>
      {}
      {hasCompose && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>构成</span>
          <div style={{ flex: 1, display: "flex", height: 4, borderRadius: 999, overflow: "hidden", background: "var(--input-bg)" }}>
            {comps.map((c) => c.pct > 0 && <div key={c.label} title={`${c.label} ${fmtTokens(c.n, cap)}`} style={{ width: `${c.pct}%`, background: c.color }} />)}
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
      {}
      {buckets && (buckets.system + buckets.rules + buckets.memory + buckets.workspace + buckets.planning + buckets.tools + buckets.history + buckets.message) > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4, marginTop: 2 }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>来源</span>
          <div style={{ flex: 1, display: "flex", height: 4, borderRadius: 999, overflow: "hidden", background: "var(--input-bg)" }}>
            {bucketComps(buckets).map((c) => c.pct > 0 && <div key={c.label} title={c.label + " " + fmtTokens(c.n, cap)} style={{ width: c.pct + "%", background: c.color }} />)}
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
          {
}
          <ChevronIcon size={10} rotate={detailOpen ? 90 : 0} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          明细 {detailOpen ? "收起" : "展开"}
        </button>
        <span>{compressCount > 0 ? `距压缩 ${fmtTokens(compressCount, cap)}` : "距压缩 已达阈值"}</span>
      </div>
    </div>
  );
}

function MetricsGrid({ usage, live, pref = "auto", cap = 0 }: {
  usage: AccumUsage;
  

  live?: { reply: number; reason: number; elapsedMs: number };
  
  pref?: LedgerCurrencyPref;
  

  cap?: number;
}): JSX.Element {
  const liveReply = live?.reply ?? 0;
  const liveReason = live?.reason ?? 0;
  const liveElapsed = live?.elapsedMs ?? 0;
  const inFlight = liveReply > 0 || liveReason > 0 || liveElapsed > 0;
  
  
  const cum = usageComposition({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens + liveReply,
    reasoningTokens: usage.reasoningTokens + liveReason,
    cacheReadTokens: usage.cacheReadTokens,
    cacheReadInPrompt: usage.cacheReadInPrompt,
  });
  
  const cacheHit = cum.inputSide > 0 ? (cum.cacheRead / cum.inputSide) * 100 : 0;
  











  const ledgerCurrency: PriceCurrency = resolveLedgerCurrency(pref,
    usage.costUsd > 0 && usage.costUsdFromCn > usage.costUsd - usage.costUsdFromCn ? "CNY" : "USD");
  const items: Array<[string, string, boolean?]> = [
    ["平均命中", usage.requests === 0 && !inFlight ? "—" : `${cacheHit.toFixed(cacheHit === 0 ? 0 : cacheHit < 0.95 ? 1 : 0)}%`],
    ["运行时间", fmtMsSmart(usage.elapsedMs + liveElapsed)],
    ["累计 tokens", fmtTokens(cum.total, cap)],
    ["会话费用", usage.requests === 0 ? "—（未配置单价）" : usage.costUsd === 0 ? "—" : formatUsdAs(usage.costUsd, ledgerCurrency)],
    ["请求数", String(usage.requests)],
    ["", inFlight ? "含本轮在途" : "—"],
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

function UsageBreakdown({ usage, live, detailOpen, onToggleDetail, cap = 0 }: {
  usage: AccumUsage;
  
  live?: { reply: number; reason: number };
  detailOpen: boolean; onToggleDetail: () => void;
  
  cap?: number;
}): JSX.Element {
  const liveReply = live?.reply ?? 0;
  const liveReason = live?.reason ?? 0;
  
  
  
  
  const c = usageComposition({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens + liveReply,
    reasoningTokens: usage.reasoningTokens + liveReason,
    cacheReadTokens: usage.cacheReadTokens,
    cacheReadInPrompt: usage.cacheReadInPrompt,
  });
  
  const missInput = Math.max(0, c.inputSide - c.cacheRead);
  
  const visibleOut = Math.max(0, c.outputSide - c.reasoning);

  const C_PROMPT = "#56d4dd";
  const C_REPLY = "#a371f7";
  const C_REASON = "#d29922";
  const C_CACHE = "#3fb950";

  const pctOf = (n: number): number => (c.total > 0 ? (n / c.total) * 100 : 0);
  const pct = (n: number): string => `${n.toFixed(0)}%`;
  const dashOr = (n: number): string => (n === 0 ? "—" : fmtTokens(n, cap));
  
  const subRow: React.CSSProperties = { paddingLeft: 12, color: "var(--text-muted)" };
  const numStyle: React.CSSProperties = { fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 600 };

  return (
    <div>
      <div style={{ borderRadius: 6, background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", padding: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8 }}>Token 构成</div>
        {
}
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: "rgba(139,148,158,0.14)", marginBottom: 10 }}>
          {missInput > 0 && <div style={{ width: `${pctOf(missInput)}%`, background: C_PROMPT }} title={`提示词（未命中） ${pct(pctOf(missInput))}`} />}
          {c.cacheRead > 0 && <div style={{ width: `${pctOf(c.cacheRead)}%`, background: C_CACHE }} title={`缓存读（命中） ${pct(pctOf(c.cacheRead))}`} />}
          {visibleOut > 0 && <div style={{ width: `${pctOf(visibleOut)}%`, background: C_REPLY }} title={`回复（可见） ${pct(pctOf(visibleOut))}`} />}
          {c.reasoning > 0 && <div style={{ width: `${pctOf(c.reasoning)}%`, background: C_REASON }} title={`推理（思考） ${pct(pctOf(c.reasoning))}`} />}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 10.5 }}>
          <LegendDot color={C_PROMPT} label="提示词" value={dashOr(missInput)} pct={pctOf(missInput)} />
          <LegendDot color={C_CACHE} label="缓存读" value={dashOr(c.cacheRead)} pct={pctOf(c.cacheRead)} />
          <LegendDot color={C_REPLY} label="回复" value={dashOr(visibleOut)} pct={pctOf(visibleOut)} />
          <LegendDot color={C_REASON} label="推理" value={dashOr(c.reasoning)} pct={pctOf(c.reasoning)} />
        </div>
      </div>
      <div onClick={onToggleDetail} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", userSelect: "none" }}>
        <ChevronIcon size={10} rotate={detailOpen ? 90 : 0} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span style={{ fontWeight: 600 }}>明细</span>
      </div>
      {

}
      <div style={{ marginTop: 6, borderRadius: 4, background: "rgba(139,148,158,0.06)", border: "1px solid var(--border)", padding: "8px 10px", fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.65 }}>
        {
}
        <div
          title={`${c.cacheInPrompt
            ? "本会话上游为 OpenAI 兼容语义：prompt_tokens 已含缓存命中"
            : "本会话上游为 Anthropic 语义：缓存读与 input 并列，已并入本行"}`}
          style={{ display: "flex", justifyContent: "space-between" }}>
          <span>输入 Tokens（提示词）</span><span style={numStyle}>{c.inputSide.toLocaleString()}</span>
        </div>
        <div title="已计入上方「输入」，不重复计入合计" style={{ display: "flex", justifyContent: "space-between", ...subRow }}>
          <span>└ 其中 缓存读（命中）</span><span style={numStyle}>{c.cacheRead.toLocaleString()}</span>
        </div>
        <div
          title={liveReply > 0 ? `累计 ${usage.completionTokens.toLocaleString()} + 本轮在途 ≈${liveReply.toLocaleString()}` : undefined}
          style={{ display: "flex", justifyContent: "space-between" }}>
          <span>输出 Tokens（回复）</span><span style={numStyle}>{c.outputSide.toLocaleString()}</span>
        </div>
        <div
          title={[liveReason > 0 ? `累计 ${usage.reasoningTokens.toLocaleString()} + 本轮在途 ≈${liveReason.toLocaleString()}` : "",
            usage.reasoningEstimated ? "上游 usage 未回传 reasoning_tokens，其中含按实收思考文本 ≈4 字符/token 折算的估算值（上游一旦回传真实值即以其为准）" : "",
            "已计入上方「输出」，不重复计入合计"].filter(Boolean).join("；")}
          style={{ display: "flex", justifyContent: "space-between", ...subRow }}>
          <span>└ 其中 推理（思考）{usage.reasoningEstimated && <span style={{ fontWeight: 400 }}> · 估算</span>}</span>
          <span style={numStyle}>{c.reasoning.toLocaleString()}</span>
        </div>
        <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
        <div title="输入侧 + 输出侧（缓存命中 ⊂ 输入、思考 ⊂ 输出，子集不重复计）" style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 700, color: "var(--text-primary)" }}>合计（输入 + 输出）</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: "var(--text-primary)" }}>{c.total.toLocaleString()}</span>
        </div>
      </div>
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

function fmtMsSmart(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}






























function termOutputLines(raw: string, kind: "out" | "err"): TermLine[] {
  const parts = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  
  if (parts.length > 0 && parts[parts.length - 1] === "") { parts.pop(); }
  const out: TermLine[] = [];
  for (const line of parts) {
    const spans = parseAnsi(line);
    


    if (spans.length === 0 && line.length > 0) { continue; }
    out.push({ kind, text: stripAnsi(line), spans });
  }
  return out;
}


function ansiSpanStyle(s: AnsiSpan): CSSProperties {
  const st: CSSProperties = {};
  if (s.fg) { st.color = s.fg; }
  if (s.bg) { st.background = s.bg; }
  if (s.bold) { st.fontWeight = 700; }
  if (s.dim) { st.opacity = 0.62; }
  if (s.italic) { st.fontStyle = "italic"; }
  if (s.underline) { st.textDecoration = "underline"; }
  return st;
}

const TERM_PROFILE_KEY = "slime.term.profileId";

function TerminalTab(props: { workspace: string; initialCmd?: string; nonce?: number }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const [lines, setLines] = React.useState<TermLine[]>([
    { kind: "info", text: "slime 终端 —— 直接跑在主机本地的 shell 上；↑/↓ 历史、Ctrl+L 清屏。" },
  ]);
  const [input, setInput] = React.useState("");
  const [history, setHistory] = React.useState<string[]>([]);
  const [histIdx, setHistIdx] = React.useState(-1);
  const [running, setRunning] = React.useState(false);
  
  const [profiles, setProfiles] = React.useState<TermProfile[]>([]);
  const [profilesErr, setProfilesErr] = React.useState("");
  const [profileId, setProfileId] = React.useState("");
  
  const [cwd, setCwd] = React.useState(props.workspace ?? "");
  
  const [encHint, setEncHint] = React.useState<{ encoding: string; loose: boolean } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => { const el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; } }, [lines]);

  
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      let res: { ok?: boolean; profiles?: TermProfile[]; defaultId?: string | null; error?: string } | undefined;
      try { res = await api?.term?.profiles?.(); } catch (e) {
        if (alive) { setProfilesErr(`终端配置探测失败：${e instanceof Error ? e.message : String(e)}`); }
        return;
      }
      if (!alive) { return; }
      if (!res || res.ok !== true) {
        
        setProfilesErr(res?.error || "无法获取终端配置（终端桥不可用）");
        return;
      }
      const list = res.profiles ?? [];
      setProfiles(list);
      setProfilesErr("");
      let saved = "";
      try { saved = localStorage.getItem(TERM_PROFILE_KEY) ?? ""; } catch {  }
      

      const hit = list.some((p) => p.id === saved);
      const id = hit ? saved : (res.defaultId ?? list[0]?.id ?? "");
      setProfileId(id);
      const cur = list.find((p) => p.id === id);
      if (cur) {
        const extra = list.length > 1 ? `（可用 ${list.length} 个）` : "";
        setLines((prev) => [...prev, { kind: "info", text: `当前 shell：${cur.label}${extra}` }]);
      }
    })();
    return () => { alive = false; };
  }, []);

  


  const profileInitRef = React.useRef(true);
  React.useEffect(() => {
    if (!profileId) { return; }
    try { localStorage.setItem(TERM_PROFILE_KEY, profileId); } catch {  }
    if (profileInitRef.current) { profileInitRef.current = false; return; }
    const p = profiles.find((x) => x.id === profileId);
    if (!p) { return; }
    setLines((prev) => [...prev, { kind: "info", text: `已切换到 ${p.label}${p.detail ? "（" + p.detail + "）" : ""}` }]);
  }, [profileId, profiles]);

  
  const wsRef = React.useRef(props.workspace ?? "");
  React.useEffect(() => {
    const ws = props.workspace ?? "";
    if (ws === wsRef.current) { return; }
    wsRef.current = ws;
    setCwd(ws);
  }, [props.workspace]);

  


  const lastNonceRef = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (props.nonce === undefined || props.nonce === lastNonceRef.current) { return; }
    lastNonceRef.current = props.nonce;
    const cmd = (props.initialCmd ?? "").trim();
    if (!cmd) { return; }
    setInput(cmd);
    inputRef.current?.focus();
  }, [props.nonce, props.initialCmd]);

  const run = async (raw: string): Promise<void> => {
    const cmd = raw.trim();
    if (!cmd) { return; }
    setLines((prev) => [...prev, { kind: "cmd", text: `$ ${cmd}` }]);
    setInput("");
    setHistory((prev) => [cmd, ...prev.filter((h) => h !== cmd)].slice(0, 50));
    setHistIdx(-1);
    setRunning(true);
    try {
      const res = await api?.term?.exec(cmd, cwd?.trim() || undefined, profileId || undefined);
      if (!res) {
        setLines((prev) => [...prev, { kind: "err", text: "终端桥不可用，命令未执行。" }]);
        return;
      }
      const outLines = termOutputLines(res.stdout ?? "", "out");
      const errLines = termOutputLines(res.stderr ?? "", "err");
      const extra: TermLine[] = [];
      if (res.error) { extra.push({ kind: "err", text: `错误：${res.error}` }); }
      
      if (res.notice) { extra.push({ kind: "notice", text: res.notice }); }
      if (typeof res.code === "number" && res.code !== 0) { extra.push({ kind: "info", text: `退出码 ${res.code}` }); }
      if (outLines.length === 0 && errLines.length === 0 && extra.length === 0) {
        extra.push({ kind: "info", text: `（无输出，退出码 ${res.code ?? "?"}）` });
      }
      setLines((prev) => [...prev, ...outLines, ...errLines, ...extra]);
      
      setCwd(res.cwd ?? (props.workspace ?? ""));
      if (res.encoding && res.encoding !== "utf-8") {
        setEncHint({ encoding: res.encoding, loose: res.looseEncoding === true });
      } else {
        setEncHint(null);
      }
    } catch (e) {
      setLines((prev) => [...prev, { kind: "err", text: `执行异常：${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") { void run(input); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (history.length === 0) { return; } const next = Math.min(histIdx + 1, history.length - 1); setHistIdx(next); setInput(history[next] ?? ""); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (histIdx <= 0) { setHistIdx(-1); setInput(""); return; } const next = histIdx - 1; setHistIdx(next); setInput(history[next] ?? ""); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); setLines([]); }
  };

  const activeProfile = profiles.find((p) => p.id === profileId);
  const lineColor = (k: TermLine["kind"]): string =>
    k === "err" ? "#f85149" : k === "cmd" ? "#7ee787" : k === "notice" ? "#d29922" : k === "info" ? "#8b949e" : "#c9d1d9";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0d1117", color: "#c9d1d9", fontFamily: "Consolas, 'Courier New', monospace", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "5px 10px", borderBottom: "1px solid #30363d", background: "#161b22", fontSize: 12, color: "#8b949e", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: "#58a6ff", fontWeight: 600 }}>终端</span>
        {}
        {profiles.length > 0 ? (
          <select
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            title="选择在哪一个本地 shell 里运行命令"
            style={{ background: "#0d1117", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: 4, fontSize: 12, padding: "1px 4px", maxWidth: 210 }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.detail ? " · " + p.detail : ""}</option>
            ))}
          </select>
        ) : (
          <span style={{ color: profilesErr ? "#f85149" : "#8b949e" }} title={profilesErr || "正在探测主机本地终端组件"}>
            {profilesErr ? "终端配置不可用" : "正在探测…"}
          </span>
        )}
        <span style={{ color: "#30363d" }}>|</span>
        <span
          style={{ opacity: 0.75, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={cwd || "（未设置工作目录）"}
        >cwd: {cwd || "（默认）"}</span>
        {encHint && (
          <span
            title={encHint.loose
              ? `输出编码未能确认，已按 ${encHint.encoding} 兜底解码（如需精确，请让命令自身输出 UTF-8，例如 PowerShell 的 [Console]::OutputEncoding）`
              : `输出按 ${encHint.encoding} 解码`}
            style={{ color: "#d29922", border: "1px solid #3d3117", background: "#2a2413", borderRadius: 4, padding: "0 5px", cursor: "help" }}
          >{encHint.encoding}{encHint.loose ? "（兜底）" : ""}</span>
        )}
        <span style={{ flex: 1 }} />
        <button title="清屏（Ctrl+L）" onClick={() => setLines([])} style={{ background: "transparent", border: "none", color: "#8b949e", cursor: "pointer", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#30363d"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>清空</button>
      </div>
      {}
      {profilesErr && (
        <div style={{ padding: "5px 10px", background: "#2d1618", color: "#f85149", fontSize: 12, borderBottom: "1px solid #30363d" }}>{profilesErr}</div>
      )}
      {!profilesErr && profiles.length === 0 && (
        <div style={{ padding: "5px 10px", background: "#2a2413", color: "#d29922", fontSize: 12, borderBottom: "1px solid #30363d" }}>
          未探测到任何本地 shell（需要 cmd / PowerShell / bash 之一）。
        </div>
      )}
      <div ref={scrollRef} className="term-scroll" style={{ flex: 1, overflowY: "auto", padding: "8px 12px", lineHeight: 1.5 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: lineColor(l.kind), minHeight: "1.35em" }}>
            {l.spans && l.spans.length > 0
              ? l.spans.map((s, j) => (<span key={j} style={ansiSpanStyle(s)}>{s.text}</span>))
              : l.text}
          </div>
        ))}
        {running && <div style={{ color: "#8b949e", fontStyle: "italic", opacity: 0.7 }}>… 执行中</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", padding: "6px 12px", borderTop: "1px solid #30363d", background: "#0d1117" }}>
        <span style={{ color: "#7ee787", marginRight: 6, fontWeight: "bold" }} title={activeProfile ? `在 ${activeProfile.label} 里运行` : undefined}>
          {activeProfile?.kind === "cmd" || activeProfile?.kind === "vsdevcmd" ? ">" : "$"}
        </span>
        <input ref={inputRef} value={input} disabled={running}
          placeholder={running ? "命令执行中…" : `输入命令，回车执行（${activeProfile ? activeProfile.label : "默认 shell"}）`}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#c9d1d9", fontFamily: "inherit", fontSize: "inherit", caretColor: "#58a6ff" }} autoFocus />
        <button title="执行" disabled={running} onClick={() => void run(input)} style={{ background: running ? "#21262d" : "#238636", border: "none", color: "#fff", cursor: running ? "not-allowed" : "pointer", padding: "3px 10px", borderRadius: 4, fontSize: 12, marginLeft: 6 }}>▶</button>
      </div>
    </div>
  );
}




















function BrowserTabInstance(props: {
  tabId: string;
  url: string;
  active?: boolean;
  




  homeUrl?: string;
  
  preload?: string;
  
  homeError?: string;
  onUrlChange: (url: string) => void;
  onTitleChange?: (title: string) => void;
}): JSX.Element {
  const webviewRef = React.useRef<HTMLElement | null>(null);
  
  const goneHandledRef = React.useRef(false);
  
  const titleRef = React.useRef("");
  const [inputUrl, setInputUrl] = React.useState(props.url ?? "");
  const [navUrl, setNavUrl] = React.useState("");
  const [canBack, setCanBack] = React.useState(false);
  const [canFwd, setCanFwd] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(false);
  
  const [failInfo, setFailInfo] = React.useState<{ url: string; code: number } | null>(null);
  





  const homeFailed = !!props.homeError && !(props.url ?? "").trim();

  
  
  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    if (!wv) { return; }
    
    const throttle = (wv as unknown as { setBackgroundThrottling?: (v: boolean) => void }).setBackgroundThrottling;
    if (typeof throttle !== "function") { return; }
    try { throttle.call(wv, props.active !== true); } catch {  }
  }, [props.active]);

  
  
  
  


  const effectiveUrl = (props.url ?? "").trim() || (props.homeUrl ?? "").trim();
  React.useEffect(() => {
    
    const next = normalizeBrowserUrl(effectiveUrl);
    
    
    if (!next || next === "about:blank") { return; }
    
    if (!isWebNavUrl(next)) { return; }
    if (next === navUrl) { return; }
    setInputUrl(next);
    setNavUrl(next);
    
  }, [effectiveUrl]);

  






  const navUrlRef = React.useRef("");
  React.useEffect(() => { navUrlRef.current = navUrl; }, [navUrl]);
  

  const navFailBookRef = React.useRef<NavFailureBook>(new Map());
  const wvAttachedRef = React.useRef(false);
  const forceNav = React.useCallback((): void => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    const next = navUrlRef.current;
    if (!wv || !next) { return; }
    try {
      
      const cur = typeof wv.getURL === "function" ? wv.getURL() : "";
      if (cur === next) { return; }
      
      if (!navAutoLoadAllowed(navFailBookRef.current, next, "url-change", wvAttachedRef.current)) { return; }
      

      safeLoadURL(wv, next);
    } catch {  }
  }, []);
  
  React.useEffect(() => { forceNav(); }, [forceNav, navUrl]);

  








  const setWvRef = React.useCallback((el: HTMLElement | null) => {
    const prev = webviewRef.current;
    if (prev && prev !== el) {
      try { (prev as unknown as Electron.WebviewTag).removeEventListener?.("did-attach", forceNav); } catch {  }
    }
    webviewRef.current = el;
    if (!el) { return; }
    
    try { el.setAttribute("allowpopups", "true"); } catch {  }
    try { (el as unknown as Electron.WebviewTag).addEventListener?.("did-attach", forceNav); } catch {  }
    forceNav();
  }, [forceNav]);

  
  
  
  
  
  
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
      const next = navUrlRef.current;
      if (!wv || !next) { return; }
      try {
        const cur = typeof wv.getURL === "function" ? wv.getURL() : "";
        if (cur && cur !== "about:blank") { return; }
        


        if (!navAutoLoadAllowed(navFailBookRef.current, next, "net", wvAttachedRef.current)) { return; }
        
        safeLoadURL(wv, next);
      } catch {  }
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    
    
    if (!wv) { return; }
    registerWebview(props.tabId, wv);
    return () => { unregisterWebview(props.tabId); };
  }, [props.tabId]);

  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    if (!wv) { return; }
    
    
    const onNav = (e: Electron.DidNavigateEvent): void => {
      if (!e.url || e.url === "about:blank") { return; }
      setInputUrl(e.url); setActive(true); props.onUrlChange(e.url);
    };
    
    
    
    const onAttach = (): void => { wvAttachedRef.current = true; forceNav(); };
    const onInPage = (e: Electron.DidNavigateInPageEvent): void => {
      if (!e.url || e.url === "about:blank") { return; }
      setInputUrl(e.url);
    };
    const onStart = (): void => { setLoading(true); setFailInfo(null); };
    

    const onTitle = (e: { title?: string }): void => {
      const t = (e?.title ?? "").trim();
      if (!t || t === titleRef.current) { return; }
      titleRef.current = t;
      props.onTitleChange?.(t.length > 28 ? `${t.slice(0, 28)}…` : t);
    };
    


    const onGone = (): void => {
      const cur = navUrlRef.current;
      setLoading(false);
      if (!cur || goneHandledRef.current) { return; }
      goneHandledRef.current = true;
      try {
        window.setTimeout(() => { try { (webviewRef.current as unknown as Electron.WebviewTag | null)?.reload(); } catch {  } }, 400);
      } catch {  }
    };
    const onStop = (): void => {
      setLoading(false); setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward());
      
      
    };
    
    






    const onFail = (e: Electron.DidFailLoadEvent): void => {
      const url = e?.validatedURL ?? "";
      
      if (!url || url === "about:blank" || e?.errorCode === -3) { return; }
      


      noteNavFailure(navFailBookRef.current, navUrlRef.current || url, e?.errorCode ?? 0);
      setFailInfo({ url, code: e?.errorCode ?? 0 });
      setLoading(false);
      setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward());
    };
    
    
    
    
    const onWillNav = (e: Electron.WillNavigateEvent | { url: string; preventDefault: () => void }): void => {
      try {
        const url = (e as { url?: string }).url ?? "";
        if (!url) { return; }
        const scheme = url.split(":")[0].toLowerCase();
        if (scheme === "http" || scheme === "https" || scheme === "about" || scheme === "file" || scheme === "data" || scheme === "blob" || url === "about:blank") { return; }
        e.preventDefault();
        
        if (scheme === "slime") {
          try {
            const u = new URL(url).searchParams.get("u");
            if (u && /^https?:\/\//i.test(u)) {
              requestSidebarOpen({ kind: "url", url: u, name: "" });
              return;
            }
          } catch {  }
          
          props.onUrlChange(url);
          return;
        }
        
        
        void (async () => {
          try {
            const agree = await confirmAsync(
              `是否允许打开外部应用（${scheme}://）？`,
              `链接：${url}\n\n该链接需要系统已注册的「${scheme}」应用才能打开。\n「允许」→ 交给对应应用打开；「拒绝」→ 本次不打开。`,
            );
            if (!agree) {
              window.dispatchEvent(new CustomEvent("slime-browser-popup-notice", { detail: { url, kind: "popup-denied", scheme } }));
              return;
            }
            const api = (window as unknown as {
              slimeAPI?: { protocol?: { open?: (u: string) => Promise<{ ok?: boolean; scheme?: string; handler?: string; reason?: string }> } }
            }).slimeAPI?.protocol;
            const r = await api?.open?.(url);
            if (r?.ok) {
              window.dispatchEvent(new CustomEvent("slime-browser-popup-notice", { detail: { url, kind: "opened", scheme, handler: r.handler } }));
            } else {
              window.dispatchEvent(new CustomEvent("slime-browser-popup-notice", { detail: { url, kind: "need-install", scheme: r?.scheme ?? scheme } }));
            }
          } catch {  }
        })();
      } catch {  }
    };
    
    
    
    const onWillNavEvent = (e: unknown): void => onWillNav(e as Electron.WillNavigateEvent);
    const onWillRedirect = (e: unknown): void => onWillNav(e as Electron.WillNavigateEvent);
    
    
    
    
    
    const onNewWindow = (e: unknown, url?: string): void => {
      try {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          requestSidebarOpen({ kind: "url", url, name: "", from: "site" });
          return;
        }
        if (typeof url === "string" && url) {
          onWillNav({ url, preventDefault: () => { try { (e as { preventDefault?: () => void }).preventDefault?.(); } catch {  } } } as Electron.WillNavigateEvent);
        } else {
          onWillNav(e as Electron.WillNavigateEvent);
        }
      } catch {  }
    };
    try { (wv as any).addEventListener?.("will-navigate", onWillNavEvent); } catch {  }
    try { (wv as any).addEventListener?.("will-redirect", onWillRedirect); } catch {  }
    try { (wv as any).addEventListener?.("new-window", onNewWindow); } catch {  }
    try { (wv as any).addEventListener?.("did-attach", onAttach); } catch {  }
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onInPage);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-fail-load", onFail);
    try { (wv as any).addEventListener?.("page-title-updated", onTitle); } catch {  }
    
    try { (wv as any).addEventListener?.("render-process-gone", onGone); } catch {  }
    try { (wv as any).addEventListener?.("crashed", onGone); } catch {  }
    return () => {
      try { (wv as any).removeEventListener?.("will-navigate", onWillNavEvent); } catch {  }
      try { (wv as any).removeEventListener?.("will-redirect", onWillRedirect); } catch {  }
      try { (wv as any).removeEventListener?.("new-window", onNewWindow); } catch {  }
      try { (wv as any).removeEventListener?.("did-attach", onAttach); } catch {  }
      try { (wv as any).removeEventListener?.("page-title-updated", onTitle); } catch {  }
      try { (wv as any).removeEventListener?.("render-process-gone", onGone); } catch {  }
      try { (wv as any).removeEventListener?.("crashed", onGone); } catch {  }
      wv.removeEventListener("did-navigate", onNav); wv.removeEventListener("did-navigate-in-page", onInPage); wv.removeEventListener("did-start-loading", onStart); wv.removeEventListener("did-stop-loading", onStop); wv.removeEventListener("did-fail-load", onFail);
    };
  }, []);

  const go = (): void => {
    const targetRaw = inputUrl.trim();
    if (!targetRaw) { return; }
    
    if (!isWebNavUrl(targetRaw)) {
      setInputUrl("");
      return;
    }
    
    
    let target = normalizeBrowserUrl(targetRaw);
    setNavUrl(target);
  };

  const wv = webviewRef.current as unknown as Electron.WebviewTag | null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%", background: "var(--bg, #fff)" }}>
      <div className="right-pane-head browser-bar" style={{ flexShrink: 0 }}>
        <button className="right-mini-btn" title="后退" disabled={!canBack} onClick={() => { wv?.goBack(); }}>‹</button>
        {
}
        <button className="right-mini-btn" title="前进" disabled={!canFwd} onClick={() => { wv?.goForward(); }}><ChevronIcon size={12} rotate={0} /></button>
        <button className="right-mini-btn" title="刷新" disabled={!active} onClick={() => { wv?.reload(); }}><RefreshIcon size={12} /></button>
        <input className="term-input browser-url" value={inputUrl} placeholder="输入网址，回车访问" onChange={(e) => setInputUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { go(); } }} />
        {
}
        <button className="right-mini-btn" title="访问" onClick={go}><SearchIcon size={13} /></button>
      </div>
      <div className="browser-stage">
        {loading && active && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--accent, #58a6ff)", zIndex: 10 }} />}
        {







}
        {!active && !failInfo && (
          <div className="browser-blank">
            <div className="browser-blank-mark"><GlobeIcon size={34} /></div>
            <div className="browser-blank-title">{homeFailed ? "搜索页没能交付" : "在上方输入网址开始浏览"}</div>
            <div className="browser-blank-hint">
              {homeFailed
                ? `${props.homeError}（可以直接在上方输入网址继续浏览）`
                : "也可以直接在对话里让 slime 打开网页，它会在这个面板内操作；操作期间面板边框会呼吸提示。"}
            </div>
          </div>
        )}
        {



}
        {failInfo && (
          <div className="browser-error-page">
            <div className="browser-error-icon"><WarningIcon size={40} /></div>
            <div className="browser-error-title">{failTitle(failInfo.code)}</div>
            <div className="browser-error-url" title={failInfo.url}>{failInfo.url}</div>
            <div className="browser-error-code">
              {failCodeName(failInfo.code) ? `${failCodeName(failInfo.code)} · ` : ""}错误码 {failInfo.code}
            </div>
            <div className="browser-error-hint">{failHint(failInfo.code)}</div>
            <div className="browser-error-actions">
              <button className="btn primary" onClick={() => {  clearNavFailure(navFailBookRef.current, navUrlRef.current); setFailInfo(null); try { (webviewRef.current as unknown as Electron.WebviewTag | null)?.reload(); } catch {  } }}>重试</button>
              <button className="btn" onClick={() => { void navigator.clipboard?.writeText(failInfo.url).catch(() => undefined); }}>复制网址</button>
            </div>
          </div>
        )}
        {


}
        <WebviewTag
          ref={setWvRef}
          src="about:blank"
          partition="persist:slime-browser"
          allowpopups
          

          plugins
          


          preload={props.preload || undefined}
          

          style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
        />
      </div>
    </div>
  );
}



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



function ChangeGroup(props: { title: string; files: string[]; glyph: string; collapsed: boolean; onToggle: () => void; onFileClick?: (f: string) => void }): JSX.Element | null {
  if (props.files.length === 0) { return null; }
  const g = STATUS_GLYPH[props.glyph] ?? STATUS_GLYPH.M;
  return (
    <div style={{ marginBottom: 6 }}>
      <div onClick={props.onToggle} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 4, cursor: "pointer", userSelect: "none", fontSize: 12, color: "var(--text-secondary)" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hover-bg, rgba(255,255,255,0.05))"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
        title={props.collapsed ? "展开" : "折叠"}>
        {

}
        <ChevronIcon size={10} rotate={props.collapsed ? 0 : 90} style={{ opacity: 0.7, flexShrink: 0 }} />
        <span style={{ fontWeight: 500 }}>{props.title}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--input-bg, #161b22)", borderRadius: 8, padding: "0 6px" }}>{props.files.length}</span>
      </div>
      {}
      <div className={`collapse${props.collapsed ? "" : " is-open"}`}>
        <div>
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
        </div>
      </div>
    </div>
  );
}
