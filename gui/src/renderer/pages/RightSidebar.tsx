import React, { type JSX, type CSSProperties } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DownloadProgressInfo, WorkspaceEntry, WorkspaceReadFileResult, CtxBuckets, GitDiffFile,
} from "../../shared/ipc.js";
import { isBrowserSchemeUrl } from "../../shared/ipc.js";
/** A-1038：下载/解压阶段文案（唯一实现，UI 不得自造同义词） */
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
// A-1120（①）：产物按类型分流的**唯一判据出处**（可被守卫直接断言，不必驱动整个组件）
import { shouldRenderAsWeb, splitPath, baseNameOf, buildPreviewUrl } from "./webPreview.js";
import { readSessionCtxMeta, restoreUsed } from "./sessionCtxMeta.js";
import { contextRatio, contextPct, ringLevel, composeSegments, bucketsSegments, fmtTokens, usageComposition } from "./contextMath.js";
import { failTitle, failHint, failCodeName } from "./browserErrors.js";
// A-1115：右栏 md 文档的「目录卷轴」（滚动条替代品，只保留刻度尺）
import TopicRail, { type RailEntry } from "./TopicRail.js";
import { loadRailParams, onRailParams, type RailParams } from "./railParams.js";
import BrainstormPanel from "./BrainstormPanel.js";
import { onCtxUpdate, readAutoCompressCfg, AUTOCOMPRESS_CFG_EVENT, resolveToolLabel, readSessionProducts } from "./ChatPanel.js";
// A-990：在途快照的读写已从 ChatPanel 拆到 liveMonitor.ts —— 纯内存取样不该依赖整个组件
import { readLiveMonitor } from "./liveMonitor.js";
/* A-1146：会话产物 diff 的查找（**纯函数**，可单测；数据源仍是 ChatPanel 那个唯一的 localStorage 产地）。 */
import { findSessionFileDiff, type SessionFileDiff } from "./chatProducts.js";
import { trackResizerGlint, clearResizerGlint } from "../resizerGlint.js";
import { setBrowserHost, registerWebview, unregisterWebview, executeBrowserCommand, isWebNavUrl, normalizeBrowserUrl } from "./browserBridge.js";
/* A-1133：工作文档判据（唯一产地）—— 决定「这个文件该抽文本还是直读」。 */
import { classifyFile } from "../../../../core-ts/src/office/fileKinds.js";
/* ⚠️ 阶段 C：判断"这个文件要经过 LibreOffice 才能保真预览"的**唯一产地**（与主进程 `planRender` 同一份）。
   渲染层**不许**自己按扩展名拼判断 —— 那会变成第二个产地，且必然与主进程漂。 */
import { needsLibreOffice } from "../../../../core-ts/src/office/renderPlan.js";
/* A-1133：文档文本 → 结构化块（真表格 / 分页卡片 / 段落）—— 零依赖的「路线一」。 */
import { buildDocView, docViewToHtml, DOC_CELL_MIN_EM } from "./docView.js";
/* A-1139：内置终端。
   · `ansi.js` = ANSI 转义解析（**零依赖**的纯叶子模块，与 ChatPanel 引 `context_compress` 同手法 ——
     它是叶子，不会把主进程图谱拖进浏览器包）；
   · shell 清单的类型只**借形状**（`import type`，编译后擦除）；判据全在主进程。 */
import { parseAnsi, stripAnsi, type AnsiSpan } from "../../../../core-ts/src/terminal/ansi.js";
/* A-1142：右栏请求的**会话归属判据**（唯一产地，纯函数）—— 挡住"上一个会话的 Agent 把页开到
   当前会话"。渲染层不许自己再写一个「要不要收」的判断。 */
import { sidebarOpenMatchesSession } from "../../../../core-ts/src/sidebarOpen.js";
import type { TermProfile } from "../../shared/ipc.js";
/* A-1137：右栏搜索页 —— 交付信息（URL + guest preload）+ 右栏视图的唯一产地（对话侧状态条读它）。 */
import {
  getSearchPageDelivery, publishSidebarTab, connectSidebarSearch,
  type SearchPageDelivery, type SidebarTabView,
} from "./sidebarSearch.js";
/** 右栏页签类型（`SidebarTabView["kind"]` 是它的**超集**：多一个 `none`＝"一个页签都没有"）。 */
type SidebarTabKind = SidebarTabView["kind"];
// A-1106b：webview 导航统一走唯一安全出口（接住 loadURL 的异步 reject，-3 不算错）
import { safeLoadURL, navAutoLoadAllowed, noteNavFailure, clearNavFailure, type NavFailureBook } from "./webviewNav.js";
// A-990：会话总账的币种与金额格式统一取共享层 —— 右栏不允许再出现硬编码汇率
// （旧实现是 `costUsd * 7.25`，与共享层 USD_CNY_RATE=7.2 不一致 → 同一笔账两处显示不同数）
import { pricingDisplayCurrency, formatUsdAs, type PriceCurrency } from "../../../../shared/gen/model-capabilities.js";
// A-990-D：主页实时监测的消费币种（「通用」设置里可手选；`auto` = 沿用上面的推断）
import { readLedgerCurrencyPref, resolveLedgerCurrency, LEDGER_CURRENCY_EVENT, type LedgerCurrencyPref } from "./ledgerCurrencyCfg.js";

type TabType = "tasks" | "terminal" | "browser" | "git" | "file";

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

/** A-980-R8：PDF 预览 data URL（pdf 文件由主进程按 base64 读回） */
function pdfDataUrl(base64: string): string {
  return `data:application/pdf;base64,${base64}`;
}

/** A-980-R8：Office 扩展名 → 预览占位图标 */
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
  /** A-173：绝对路径（聊天消息内打开的文件） */
  fileAbs?: string;
  fileContent?: string;
  fileMime?: "text" | "docText" | "image" | "binary" | "pdf" | "office";
  fileError?: string;
  /**
   * A-1120：**降级说明**（不是错误）—— 例如「本想用浏览器渲染这个 .html，但起服务失败，已按源码显示」。
   * 与 `fileError` 分开是因为二者对用户的意义完全不同：`fileError` = 这一页没有内容可看；
   * `fileNotice` = 内容在，但**不是用户点这一下所期望的那种形态**。合成一个字段会逼着代码二选一，
   * 于是必然有一类情况被静默（要么吞掉降级原因、要么把正常的源码页变成"错误页"）。
   */
  fileNotice?: string;
  /** A-1121：终端页被 Agent 打开时预填的命令（配 `termNonce` 使用，见 `TerminalTab`） */
  termCmd?: string;
  /** A-1121：预填命令的**序号**——同一个命令连续打开两次也要能重新填回输入框
   *  （只比字符串的话，用户清空输入框后再让 Agent 开一次，输入框会"没反应"） */
  termNonce?: number;
  /** A-975：该文件页当前的浏览根——用户在「打开文件夹」选的目录写回这里（可位于工作区之外），
   *  使浏览位置在 tab 生命周期内持久（不被 workspace 变化/重挂载顶回工作目录）。 */
  browseRoot?: string;
  /** A-1121（②）：Agent 打开文件树时要求**定位到**的子目录（相对 `browseRoot`）。
   *  与 `browseRoot` 分开是因为语义不同：前者是"看哪儿"，后者是"进到哪儿" ——
   *  合成一个字段就只能二选一，于是"打开到 apps/"必然表现为"只打开到根"。 */
  browseRel?: string;
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

/** A-1121：终端"预填命令"的单调序号（只增不减）。
 *  为什么要序号：只比命令字符串的话，"Agent 两次要求预填同一条命令、中间用户清空了输入框"
 *  会让第二次毫无反应 —— 而那正是用户期待它重新填上的时刻。 */
let termOpenSeq = 0;

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
  /** A-1018：工具事件携带**原始工具名**（如 web_search / browser_wait）——行首据此渲染
   *  该工具自己的图标，而不是「工具」两个字。同时让 label 用人类可读名，不再裸奔工具名。 */
  tool?: string;
}

/* ── webview 标签 ── */
/* ⚠️ A-975-R6：`allowpopups` 必须传**字符串** "true"，不能传 JSX 布尔 `allowpopups`。
 * React 对未知元素（webview 非标准标签、无短横线不算 custom element）会**丢弃值为 true 的未知布尔属性**
 * （只在控制台留一条 "Received `true` for a non-boolean attribute" 警告）→ 属性从没落到元素上 →
 * 站点 window.open / target=_blank 被 Chromium 直接丢弃，主进程 setWindowOpenHandler 连机会都没有
 * → "带跳转性质的按钮不会自动新建页"（用户实测）。这也正是历史上一度要注入脚本兜底的原因。 */
/* ⚠️⚠️ `plugins` 同理必须是**字符串** "true"（React 会丢弃值为 true 的未知布尔属性）。
 *
 * ## 这条是**防守性**的，**不是**某个 bug 的修复（2026-09-30 实测澄清）
 * 起因是我查到 Electron 官方 `<webview>` 文档原文：「**Plugins are disabled by default.**」，
 * 而 Chromium 的 PDF 查看器在 Electron 里是以插件形式实现的 ⇒ 推断"不开就空白"。
 * **但实测否掉了这个推断**：`gui/scripts/probe-pdf-webview.mjs` 用**两个独立 Electron 进程**
 * 做 A/B（开/不开 `plugins`），同一份真 PDF 的"白纸占比"**都是 0.641**（差 0.0 个百分点）
 * ⇒ **这版 Electron（35）开不开都能渲染 PDF**。
 * ⇒ 保留它的理由只有一条：官方文档明写默认关闭，**开着成本为零**、且能挡住"某些环境/某些
 *    直接打开 `.pdf` 的路径"上的差异。**但不要再声称它是"否则空白"的原因** —— 那已被证伪。
 * ⚠️ 查过文档确认：`plugins` **不在**那条"安全关键偏好"清单
 * （`contextIsolation` / `javascript` / `nodeIntegration` / `sandbox` / `nodeIntegrationInSubFrames` / `enableWebSQL`）里
 * ⇒ 放宽它**不会**让 guest 比宿主更不安全；且本 guest 仍保持 `sandbox:true` + `contextIsolation:true` + 无 nodeIntegration。
 * ⚠️ Electron 要求 webview 属性在**首次导航前**生效 ⇒ 这里**固定开启**，不做"按 URL 动态切换"
 * （动态切对已 attach 的 guest 无效，只会造成"有的 PDF 能看、有的不能"这种最难查的间歇故障）。 */
/* A-1137：guest preload —— 右栏浏览器页的「宿主桥」来源（`<webview preload="file://…">`）。
 *
 * ## 为什么必须有，且为什么**每个**浏览器页都要带
 * 用户自制搜索页把联网检索交给宿主，而右栏是 `<webview>`（独立顶层 frame）⇒ 页面里的
 * `window.parent === window` ⇒ 它原设计的 `postMessage` 通道**只能听到自己发的消息**（已实测证伪）。
 * 唯一通路就是 preload + `contextBridge`：让 guest 里出现 `window.SlimeBrowserHost`。
 *
 * ⚠️ **preload 的执行时机是「每次导航都会跑」，且它在文档创建那一刻自己判断要不要 expose**
 *   （`gui/src/preload/searchHost.cjs::isLocalDocument()`：只在本机文档里 expose）。
 *   ⇒ 所以挂在**所有**浏览器页上是**安全且必要**的：用户可能把搜索页开在任意一个页签里。
 *   ⚠️ 别在这里按 URL 动态决定"给不给 preload" —— Electron 要求 webview 属性在**首次导航前**生效，
 *   对已 attach 的 guest 改它无效（那会变成"有的页能搜有的不能"的间歇故障，同 `plugins` 那条注释）。
 *
 * ⚠️⚠️ **preload 必须在 webview 首次挂载时就是最终值**。所以渲染层**等交付信息回来才挂浏览器页**
 *   （见 `RightSidebar` 的 `searchDelivery`）：否则会先挂一个**没有桥**的页面 —— 用户能看见搜索页、
 *   却搜不动，而且**没有任何报错**（这类"能看但功能静默失效"是最坏的形态）。 */
const WebviewTag = React.forwardRef<HTMLElement, { src: string; style: CSSProperties; partition?: string; allowpopups?: boolean | string; plugins?: boolean | string; preload?: string }>((props, ref) =>
  React.createElement("webview", {
    ...props,
    allowpopups: props.allowpopups ? "true" : undefined,
    plugins: props.plugins ? "true" : undefined,
    ref,
  }),
);
WebviewTag.displayName = "WebviewTag";

/* ── 终端行 ──
   A-1139：`spans` = ANSI 解析后的带样式片段（由 `core-ts/src/terminal/ansi.ts` 的**纯函数**产出，
   渲染层不自己认转义序列 —— 那会变成第二个产地）。
   ⚠️ 只有 `out`/`err` 带 spans：`cmd`/`info`/`notice` 的样式由 UI 决定，不该被 shell 的
   转义序列影响（否则 `echo -e '\x1b[31m'` 能把我们的提示行染红）。`text` 保留 = 无 spans 时的回退。 */
interface TermLine {
  kind: "cmd" | "out" | "err" | "info" | "notice";
  text: string;
  spans?: AnsiSpan[];
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
  onResize?: (e: React.PointerEvent) => void;
  /** A-1152：**浮层态**（中间聊天页已卸载、右栏接管整宽）。
   *  此刻**不挂拖拽手柄** —— 浮层里唯一能改变宽度的方式是「窗口化」往返。
   *  ⚠️ 由 App 注入 `mainIsFloatLayout`，与"中间页是否卸载"是**同一份真状态**，不另造判据。 */
  floatLayout?: boolean;
  /** A-949：群聊（brainstorm）默认不新建「任务」页——配套侧页另行设计；仍可手动新建文件/终端等页 */
  sessionType?: "normal" | "brainstorm";
  /** A-954：群聊成员 id 列表（含组长=agentId；BrainstormPanel 建群即预填成员卡） */
  memberIds?: string[];
  /** A-954：成员入群模型（memberId → model 串）与组长入群模型 */
  memberModels?: Record<string, string>;
  leaderModel?: string;
  /** A-1011：群聊成员/组长思考推理强度覆盖（缺省 = 群聊默认 high；仅影响该群聊，不写 Agent 全局） */
  memberEfforts?: Record<string, string>;
  leaderEffort?: string;
}): JSX.Element {
  // 群聊下初始 tabs 为空（任务页不默认建）；普通会话初始仍默认「任务」
  const [tabs, setTabs] = React.useState<TabInstance[]>(() =>
    props.sessionType === "brainstorm" ? [] : [createTab("tasks")],
  );
  const [activeId, setActiveId] = React.useState<string | undefined>(() =>
    props.sessionType === "brainstorm" ? undefined : "tasks",
  );
  /* ══════════ A-1137：搜索页交付信息（右栏浏览器页的默认首页 + guest preload） ══════════
   * 用户要求「以后点击新建浏览器页就直接是这个搜索引擎」。
   *
   * ⚠️ 为什么要有 `null` 这一态（而不是直接给个空字符串默认值）：`preload` 只有在 webview
   *   **首次挂载**时生效，晚到的 preload 会得到一个「能看但搜不动」的页面（且无任何报错）。
   *   ⇒ 拿不准就先**别挂**（返回 `null` 表示"还没问到"），问回来了再挂。
   *   ⚠️ 失败（`error` 非空）**也要挂**（否则用户连普通浏览器都用不了）—— 但要把原因显示出来，
   *   不能让"新建浏览器页是空白"变成一件没有解释的事。 */
  const [searchDelivery, setSearchDelivery] = React.useState<SearchPageDelivery | null>(null);
  React.useEffect(() => {
    let alive = true;
    void getSearchPageDelivery().then((d) => { if (alive) { setSearchDelivery(d); } });
    return () => { alive = false; };
  }, []);
  /* 对话侧状态条的数据源在渲染层的一半：**右栏此刻开着什么**。
   * ⚠️ 只在这里发布（唯一产地）—— 别让 ChatPanel 自己去猜右栏状态（那是第二个产地，必然漂）。
   * ⚠️ 发布的是**有效 URL**（`tab.url || 搜索页地址`）：空白浏览器页显示搜索页时 `tab.url` 仍是空串
   *   （我们**故意不回写**，为了保住 `openBrowserTab` 里"复空白页"的三段兜底判据）。 */
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
  /* 订阅 guest 上报（经主进程转发的搜索视图）—— 与上面的本地页签状态汇合到同一份快照里。 */
  React.useEffect(() => connectSidebarSearch(), []);
  // A-920：每会话一套「完全独立」的右侧边栏——切换会话时把 tabs（已打开的浏览器/文件/Git 页）+ 活动页
  // 快照进 per-session 槽位，切回时原样还原；配合任务区按 sessionId 隔离（A-919），多会话绝不串联
  const sidebarSnapRef = React.useRef<Record<string, { tabs: TabInstance[]; activeId?: string }>>({});
  const prevSidRef = React.useRef<string | null>(null);
  /* A-1142：不归当前会话的右栏请求按**会话号**暂存（见下面主进程订阅处的注释）。
     键 = 请求自带的 `sessionId`（只有它非空时才会进这个表）。 */
  const pendingOpenRef = React.useRef<Record<string, SidebarOpenPayload[]>>({});
  /* ⚠️ 必须是 ref：主进程订阅那个 effect 的依赖是 `[]`，闭包里的 `props.sessionId`
     会永远停在首次挂载那一刻 —— 用它做归属判断等于没有隔离。 */
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
        // A-952：新建会话无快照 → 按会话类型给默认页（群聊=tabs 空 → BrainstormPanel；
        // 普通=[任务]），否则会残留上一个会话的 tabs（群聊新会话显示成任务默认页）
        const fresh = props.sessionType === "brainstorm" ? [] : [createTab("tasks")];
        setTabs(fresh);
        setActiveId(props.sessionType === "brainstorm" ? undefined : "tasks");
      }
      /* A-1142：**补投**这个会话"不在前台时"攒下的打开请求 —— 那个 Agent 早就把页开好了，
         只是当时界面显示的不是它的会话。不补投 = 工具回执说"已打开"而用户永远看不到。
         ⚠️ 必须**下一个宏任务**才发：本 effect 里 `setTabs` 刚排完队，同步派发的话
         接住事件的是**上一次渲染**注册的监听器（闭包里还是上一个会话的 tabs）⇒ 会复用到错的页签。
         等一个宏任务，React 已经重渲染并按新 tabs 重注册了监听器。 */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  /** A-980-R24：「新建标签页」菜单改为**锚定加号按钮**（此前是 position:absolute 无 top/left 的
   *  孤立元素 → 永远贴在侧栏最左边，跟按钮脱节）。这里记录按钮触发时的实测坐标。 */
  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number } | null>(null);
  const addBtnRef = React.useRef<HTMLButtonElement>(null);
  /** 菜单的定位参照物 = <aside class="right-sidebar">（position:relative） */
  const menuHostRef = React.useRef<HTMLElement>(null);
  const workspaceRef = React.useRef(props.workspace);
  workspaceRef.current = props.workspace;

  /** A-980-R24：打开/收起「新建标签页」菜单——坐标按加号按钮实时测量，
   *  并把右边界钳在侧栏内（窄侧栏也不会把菜单顶出可视区）。 */
  const toggleAddMenu = React.useCallback((): void => {
    setMenuOpen((open) => {
      if (open) { return false; }
      const btn = addBtnRef.current;
      const host = menuHostRef.current;
      if (btn && host) {
        const b = btn.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        // 绝对定位原点 = padding box（跳过 1px 左边框）
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

  /** A-980-R24：菜单的**非按钮关闭路径**——此前只能再点一次加号才能关（用户反馈），
   *  现在点菜单外任意处 / 按 Esc 都会关。 */
  React.useEffect(() => {
    if (!menuOpen) { return; }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t && menuRef.current?.contains(t)) { return; }
      if (t && addBtnRef.current?.contains(t)) { return; } // 加号自身由 onClick 切换
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { setMenuOpen(false); } };
    // 捕获阶段：早于站点/组件自身的 stopPropagation
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /** A-976：tabs / 活动页的 ref 镜像（供主进程浏览器指令读取最新值，避免闭包陈旧） */
  const tabsRef = React.useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;

  /** A-976：注册「浏览器宿主」——把 tabs 的增删激活能力暴露给指令执行桥（browserBridge） */
  React.useEffect(() => {
    setBrowserHost({
      listTabs: () => tabsRef.current
        .filter((t) => t.type === "browser")
        .map((t) => ({ id: t.id, title: t.title, url: t.url ?? "", active: t.id === activeIdRef.current })),
      openTab: (url, activate = true) => {
        // A-980：非 Web 协议不放进 tab 的 url（否则渲染 src=bitbrowser://… 触发系统弹窗，开空白页即可）
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

  /** A-976：订阅主进程下发的浏览器控制指令（navigate/click/type/read/snapshot/screenshot…）并回传结果 */
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
        .then((res) => { try { api.sendResult?.({ id: cmd.id, ok: res.ok, data: res.data, error: res.error }); } catch { /* 忽略 */ } })
        .catch((e: unknown) => { try { api.sendResult?.({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) }); } catch { /* 忽略 */ } });
    });
    return () => { try { off(); } catch { /* 忽略 */ } };
  }, []);

  /* ── A-980-R：弹窗被拒横幅（window.open 一律拦截，不再弹登录窗卡死 Agent；URL 供显式导航） ── */
  const [popupBanner, setPopupBanner] = React.useState<{ url: string; ts: number; kind?: string; scheme?: string; handler?: string } | null>(null);
  /** A-975-R4：站点弹窗**时间戳队列**（弹窗风暴保护用；只记最近 3s，见 onOpen） */
  const recentPopupRef = React.useRef<number[]>([]);
  // 单一事件源：window 事件 slime-browser-popup-notice（detail: {url, kind, scheme?, handler?}）。
  // 生产方：① 主进程 window.open 拒绝（kind="popup-denied"）② 本文件 onWillNav 深度链接真实打开
  // （kind="opened" 已交给系统 / "need-install" 未注册需装客户端）。消费者：根横幅 + browserBridge（Agent 注入）。
  React.useEffect(() => {
    const w = window as unknown as {
      slimeAPI?: { browser?: { onPopupNotice?: (cb: (p: { url: string; ts: number; kind?: string; scheme?: string }) => void) => () => void } }
    };
    const api = w.slimeAPI?.browser;
    if (!api?.onPopupNotice) { return; }
    return api.onPopupNotice((p) => {
      try { window.dispatchEvent(new CustomEvent("slime-browser-popup-notice", { detail: { url: p.url, kind: p.kind ?? "popup-denied", scheme: p.scheme } })); } catch { /* 忽略 */ }
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
  // 横幅 8s 自动消失（与 Agent 侧工具结果的 popupNotice 注入并存：一个给用户看，一个给模型看）
  React.useEffect(() => {
    if (!popupBanner) { return; }
    const t = setTimeout(() => setPopupBanner(null), 8000);
    return () => clearTimeout(t);
  }, [popupBanner]);

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

  /** A-173：按路径打开文件到新标签页（聊天消息内点击文件链接 / 产物卡 ↗）
   *  A-975 修复：**支持相对路径**。产物卡的 rel 常写成"相对工作目录"的样子（如 `apps/index-v3.html`），
   *  旧实现一律当绝对路径丢给 readFileAbs → existsSync 直接失败 → 用户体感"工作区外的文件打不开"。
   *  A-980-R32 修复（用户实测"很多文件都报不存在，但自己找却能打开"）：只试「工作目录相对 + 绝对」
   *  两种解析仍然不够——渲染层手里的 workspace 可能尚未加载完/压根没绑定，工具回传的也可能是
   *  「相对项目根」「带项目名前缀」「带 :行:列 后缀」的形态。
   *  现在第一步交给主进程 `openTarget`：它把**所有合理基准**列出来逐个试（会话工作目录 / 项目根 /
   *  传入的 root / 去首段重试），命中即回真实绝对路径；并且**目录也是合法目标**——
   *  点目录直接开一个浏览该目录的文件页，不再像以前那样被 readFile 判成"是目录"而失败。 */
  const openFileAbs = (abs: string, name?: string, notice?: string): void => {
    const clean = (abs ?? "").trim().replace(/^["']|["']$/g, "");
    if (!clean) { return; }
    const fname = (name ?? clean.split(/[\\/]/).pop() ?? clean).trim();
    const isAbs = /^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith("\\\\") || clean.startsWith("/");
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    const tab: TabInstance = {
      id: uid(), type: "file", title: fname,
      fileRel: clean, fileAbs: clean, // 先占位（让本页立即进入"文件预览"形态，而不是"打开文件夹"空态）
      // A-1120：降级说明随 tab 一起进（后续 updateTab 只 patch 内容字段，不会把它抹掉）
      fileNotice: notice,
    };
    void (async () => {
      let lastErr = "";
      const triedAll: string[] = [];
      // ① 主进程多基准解析（唯一权威：它知道会话工作目录与项目根）
      const resolved = await api?.workspace?.openTarget?.(clean, {
        root: (props.workspace ?? "").trim(),
        sessionId: props.sessionId ?? "",
      }).catch(() => null) as { ok?: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string } | null | undefined;
      if (resolved?.tried) { triedAll.push(...resolved.tried); }
      if (resolved?.ok && resolved.path) {
        if (resolved.isDir) {
          // 目录：开一个以它为浏览根的文件页（文件页自带「上级/打开文件夹」导航）
          updateTab(tab.id, { fileAbs: undefined, fileContent: undefined, browseRoot: resolved.path, title: fname });
          return;
        }
        /* ══ A-1133：工作文档**不能**当文本直读 ══════════════════════════════════════════
           旧路径对任何文件都调 `readFileAbs`（按 utf-8 读）⇒ .docx/.xlsx/.pdf 拿到的是二进制乱码。
           乱码比报错更坏：用户会以为"文档坏了"，模型会把乱码当真去回答。
           ⇒ 走文档通道抽文本（`slime:docs:read`，判据在 core-ts 的 `office/*` 与 `doc_text.ts`），
             并用 `fileNotice` 如实说明"这是**文本预览**，不是原排版"（`fileNotice` 的语义正是
             "内容在，但不是用户点这一下所期望的形态"）。 */
        const kindInfo = classifyFile(resolved.path);
        /* ⚠️ A-1133 修正：**PDF 不在这里拦** —— `readFileAbs` 返回的 `mime:"pdf"` 会走右侧栏既有的
           **内嵌 Chromium PDF 查看器**（`<embed>`），那比"抽成纯文本"体面得多。上一轮我一律走文本，
           等于把更好的路径覆盖掉了（用户当轮反馈"稍微有点不和我心意"，这里纠正）。
           ⚠️ 同理：`mime:"office"` 分支原本有「图标 + 用系统应用打开」，也不该被文本形态取代 ——
           所以 office 文档走**新的 `docText` 形态**：既有文本可读，也保留系统打开的出口。 */
        if (kindInfo.office && kindInfo.kind !== "pdf") {
          const dr = await api?.docs?.read?.(resolved.path).catch(() => null) as
            { ok?: boolean; text?: string; error?: string; truncated?: boolean } | null | undefined;
          if (dr?.ok) {
            /* ⚠️ 阶段 C：老格式**多一句实话** —— 它其实可以保真预览，只是缺 LibreOffice。
               不说这句的话，用户会以为"老文件天生就只能看文本"（能装一个软件解决的事被当成限制）。
               判据单一产地：`needsLibreOffice()`（与 `renderPage` 内部用的是同一条规则）。 */
            const loNote = needsLibreOffice(resolved.path)
              ? "（装好 LibreOffice 后可点上方「网页渲染」查看原版式）"
              : "";
            updateTab(tab.id, {
              fileContent: dr.text ?? "", fileMime: "docText", fileAbs: resolved.path, fileError: undefined,
              fileNotice: `已转成**结构化文本**预览（.${kindInfo.ext} 的原排版仍需系统程序）${dr.truncated ? "；内容较长已截断" : ""}。${loNote}`,
            });
            return;
          }
          /* 抽不出文本（加密 PDF / 扫描件 / 老版二进制…）⇒ 退回 `office` 形态：图标 +
             「用系统应用打开」，并**如实说明原因**（既不静默，也不显示乱码）。 */
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
        // 解析到的路径读不出来（权限/编码等）→ 再退回旧路径试一次，尽量不把可读的文件挡在外面
      } else {
        lastErr = resolved?.error ?? "";
      }
      // ② 旧兜底链：绝对路径直接读；相对路径先按工作目录读，再当绝对路径读
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
      // 失败时把"试过哪些路径"一并展示：这类问题多为解析基准不对，给出候选清单才能一眼定位
      const hint = triedAll.length > 0
        ? `\n已尝试解析为：\n${triedAll.slice(0, 6).map((t) => `· ${t}`).join("\n")}`
        : "\n（已按工作目录 / 项目根 / 绝对路径逐一尝试）";
      updateTab(tab.id, { fileError: (lastErr || `找不到该路径：${clean}`) + hint });
    })();
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  /**
   * A-1120：把一个**已归一化**的 URL 落到浏览器页 —— 优先复用**同址**页，其次**空白**页，
   * 都没有才新建。
   *
   * ⚠️ 这段逻辑原先只内联在「打开链接」那一支里；①（html 产物走浏览器）若自己再写一份，
   * 就会出现两套"复用谁"的判据 —— 同一地址可能被两个页签同时挂着（本仓已在
   * 「预演页 vs 真身」上吃过"两份口径"的账）。故抽成唯一实现，两处都调它。
   */
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

  /**
   * A-1120（①）：`.html` 产物 → 右栏**浏览器**跑真页面，而不是文件页里的源码。
   *
   * 判据分两层，缺一不可：
   *   ① **要不要**走浏览器 —— `shouldRenderAsWeb()`（纯函数，唯一出处，只认扩展名）；
   *   ② **能不能**走浏览器 —— 必须拿到磁盘上的**真绝对路径**（`openTarget` 是唯一权威解析器：
   *      产物卡的 `rel` 可能是"相对工作目录 / 带项目名前缀"的形态，自己拼绝对路径必然踩空）。
   *
   * 任一环失败 → **退回文件页**（照常显示源码，或把"找不到路径"说清楚），并挂一条
   * `fileNotice` 说明**为什么不是渲染形态** —— 静默退回等于让用户以为功能没做。
   *
   * 常驻服务风险由主进程兜底：`httpServer.serve` 自带**同目录复用**（`dir + host` 命中即返回既有端口），
   * 所以这里不需要自己维护一张"目录 → 服务"表（那会是第二个产地，且必然与真实状态分家）。
   */
  const openWebPreview = (rel: string, name?: string): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void (async () => {
      const resolved = await api?.workspace?.openTarget?.(rel, {
        root: (props.workspace ?? "").trim(),
        sessionId: props.sessionId ?? "",
      }).catch(() => null) as { ok?: boolean; path?: string; isDir?: boolean } | null | undefined;
      const abs = resolved?.ok && !resolved.isDir ? (resolved.path ?? "").trim() : "";
      if (!abs) {
        // 解析不出真路径：交给文件页（它会把"试过哪些基准"列出来），但要说清这次点的是"要看效果"
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

  /**
   * A-1133 + A-1136：**文档 → 网页**。两条路线，**优先保真**：
   *
   * 1. **A-1136 保真渲染**（首选）：把原文件字节交给真渲染库（pptx-preview / docx-preview / SheetJS）
   *    ⇒ 字体/字号/颜色/位置/图片都按原样还原 = 用户要的「像图片一样」。
   * 2. **A-1133 结构化重排**（兜底）：抽文本 → 纸张壳 HTML。**不是保真**，但老格式/未知类型能看。
   *
   * ⚠️ 无论走哪条，**`docs.read` 抽文本都不撤** —— 那是 Agent 理解文件内容的唯一入口
   *    （用户明确要求：「不要到时候只能用户看，Agent 什么都做不了」）。
   *
   * ⚠️ 任何一环失败都**退回文件页并说明原因** —— 静默退回等于让用户以为功能没做
   *    （这正是上一轮"文档文本"形态被拍的原因：他没看出那是渲染结果还是源码）。
   */
  const openDocPreviewPage = (path: string, name?: string): void => {
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void (async () => {
      const label = (name ?? "").trim() || path.split(/[\\/]/).pop() || "文档";

      /* A-1136：**先试保真渲染**（人看要的是"像图片一样"，不是抽文本重排）。
         能保真的类型（pptx/docx/xlsx）直接成功；
         阶段 C 起**老格式（.doc/.xls/.ppt）也走这条**（内部先用本机 LibreOffice 转 PDF）；
         老格式若本机没装 LibreOffice ⇒ 返回 `needs:"libreoffice"` + `hint` ⇒ 这里**如实告知**后再退回文本。
         ⚠️ 两条通道**都要在**：保真渲染给人看，`docs.read` 抽文本给 Agent 读（用户明确要求，不许回退）。 */
      const rp = await api?.docs?.renderPage?.({ path, name: label }).catch(() => null) as
        { ok?: boolean; dir?: string; name?: string; error?: string; degrade?: boolean;
          needs?: string; hint?: string; reason?: string; transient?: boolean } | null | undefined;
      /* ⚠️⚠️ **保真路线的「任何**一种没成功**都要有话说**（2026-09-30 用户实测「怎么变成 md 样式了」）：
         旧实现只覆盖 `reason === "no-libreoffice"` 与 `"failed"` 两种 —— 下面三种情形**完全静默**：
           ① `rp` 为 `null`/`undefined`（IPC 未接通 / 主进程处理时抛了）；
           ② `rp.ok===false` 但是**别的**原因（例如主进程版本旧、`.ppt` 被当成"不支持保真"）；
           ③ `rp.ok===true` 却 **serve / URL 失败**。
         静默的后果 = 用户只看到"样式变了个样"，既不知道**为什么**、也不知道**怎么办**（A-1133 的老教训）。
         ⇒ 现在**每一条**都拼成 `routeNote`，写进结构化页面的**可见提示条**里。 */
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
        /* `rp` 为 null/undefined：IPC 没接通、或主进程在处理时抛了异常。
           ⚠️ **主进程改动必须重启应用才生效** —— 这句提示就是给"更新后没重启"这种最常见的坑准备的。 */
        routeNote = "保真渲染通道没有响应（若应用刚更新过，请**重启应用**后再试）。"
          + "当前按文本结构重排显示，不是原版式。";
      }

      const dr = await api?.docs?.read?.(path).catch(() => null) as
        { ok?: boolean; text?: string; error?: string } | null | undefined;
      if (!dr?.ok) {
        openFileAbs(path, label, `${routeNote}\n（另外，文本提取也没成功：${dr?.error ?? "未知原因"}）`);
        return;
      }
      /* 保真路线没成功 ⇒ **结构化重排**（纸张壳 + 段落/表格/分页结构），并挂上上面那段**可见**提示。 */
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

  /**
   * A-1121（②）：终端页 —— 复用**已有**终端页（终端是有状态的：历史、运行中的命令，
   * 多开只会让用户不知道自己在哪个终端里），没有才新建；每次打开都刷新 `termNonce`
   * 以便同一个命令被再次预填时也能生效。
   */
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

  /**
   * A-1121（②）：文件树页 —— 复用**纯浏览页**（只看目录、没在预览某个文件），没有才新建。
   * ⚠️ 复用判据必须排除"正在看某文件"的页：把用户的文件预览页改造成目录树，
   *    等于悄悄关掉他正在看的东西（`fileAbs` / `fileContent` 有值即属于这种情况）。
   */
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

  /** A-173：监听聊天消息里的「在右侧栏打开」事件（文件/网址） */
  React.useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<SidebarOpenPayload>).detail;
      if (!d) { return; }
      /* A-975-R5：站点弹窗保护**只拦"风暴"，不拦正常点击**。
       * ⚠️ 上一版（R4）写了个「浏览器页总数 ≥8 就一律拦」的硬上限，结果用户开了很多页签后
       * **任何需要新页签的链接点击都被静默吞掉** → 表现成"能进网站，之后点什么都没反应"（用户实测）。
       * 现在：只在 3s 内连爆 ≥5 个（广告风暴）时拦截；总量上限放宽到 16 且**只在爆发时**参与判断；
       * 被拦时一定给横幅（横幅上「打开」可手动打开该链接），不静默丢。 */
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
        /* A-1133：文档 → HTML 网页渲染（用户要的“变换成 HTML”落地在这里）。 */
        openDocPreviewPage(d.rel, d.name);
      } else if (d.kind === "file" && d.rel) {
        /* A-1120（①）：**产物按类型分流**在这里落地（不能在 `ProductPanel` 做：`ProductItem`
           只有 rel/name，没有绝对路径；侧栏才有 workspace + openTarget + `http.serve`）。
           `.html/.htm/.xhtml` → 浏览器跑真页面；其余（含 `.md`、`.ts`…）仍走文件页源码。
           ⚠️ 判据只看扩展名，不看产物 kind —— `file_read` 出来的 html 同样该被渲染。 */
        if (shouldRenderAsWeb(d.rel, d.name)) { openWebPreview(d.rel, d.name); }
        else { openFileAbs(d.rel, d.name); }
      } else if (d.kind === "terminal") {
        /* A-1121（②）：Agent 打开终端。`cmd` 只**预填**，绝不自动执行 —— 自动执行等于把
           "打开一个面板"变成"代替用户敲了回车"，而用户对这一下的预期只是"看到终端"。 */
        openTerminalTab(d.cmd, d.name);
      } else if (d.kind === "files") {
        // A-1121（②）：Agent 打开文件树（可带 root / rel 定位）
        openFilesTab(d.root, d.rel, d.name);
      } else if (d.kind === "url" && d.url) {
        // A-980-R6：统一归一 URL（裸地址补 http://）——链接路径不再把 `127.0.0.1:8081`
        // 原样塞进 webview src（无 scheme 加载无效 → 白屏），与地址栏 go() 一致。
        const url = normalizeBrowserUrl(d.url);
        // A-980-R13：非 Web 协议（slime://、weixin:// 等）绝不进浏览器页导航——
        // 否则 loadURL 该协议会触发系统「获取打开此链接的应用」弹窗
        if (!isWebNavUrl(url)) { return; }
        // A-980-R14：新建页标题用域名兜底（不再裸显示"浏览器"占位）
        const domainTitle = (): string => {
          try { return new URL(url).hostname.replace(/^www\./, "") || url; } catch { return url; }
        };
        // A-975-R2：name 可能是**空串**（主进程 slime:sidebar:open 就是 `name: ""`）——`??` 不会兜底，
        // 结果新建的页签标题是空的（用户实测"跳转的页面没有标签页名字"）。改用「非空才用」。
        const pageTitle = (): string => {
          const n = (d.name ?? "").trim();
          return n || domainTitle();
        };
        // A-1120：「复用谁」的唯一实现在 `openBrowserTab`（同址 > 空白 > 新建），这里不再内联一份
        openBrowserTab(url, pageTitle());
      }
    };
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  /** A-918++：订阅主进程「HTTP 生成的网页应用在侧边栏浏览器打开」事件（slime:sidebar:open），
      复用 SIDEBAR_OPEN_EVENT 已有逻辑把 URL 注入浏览器标签。Agent 工具 http_create_app 生成应用后触发。
      A-1121（②）：这里是**唯一**把主进程请求转成 `SIDEBAR_OPEN_EVENT` 的地方 ——
      原先只透传 url，于是终端/文件树两类请求会在这一步被静默丢掉（多一种 kind 就必须跟着改这里，
      所以别再写成 `if (kind === "url")` 的白名单：直接整包转发，让唯一的消费者 RightSidebar 去判）。 */
  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: { onSidebarOpen?: (cb: (p: SidebarOpenPayload) => void) => () => void } };
    const off = w.slimeAPI?.onSidebarOpen?.((p) => {
      if (!p) { return; }
      /* A-1142：**归属校验**。右栏视图是全局单例，而 Agent 是异步的 ——
         用户在会话 A 派活、切到会话 B 之后 A 的 Agent 才跑完工具 ⇒ 这条请求若就地打开，
         就会变成"上一个会话的页开到了这个会话里"（用户实测复现）。
         ⇒ 不归当前会话的请求**暂存**进它自己那个会话的队列，等切回时补投（不是丢弃：
         丢弃 = 工具回执说"已打开"、而用户在自己会话里永远看不到）。
         ⚠️ `sessionIdRef` 而不是 `props.sessionId`：这个 effect 的依赖是 `[]`，
         闭包里的 props 会永远停在首次挂载那一刻（实测踩过同类坑）。 */
      const owner = p.sessionId ?? "";
      if (!sidebarOpenMatchesSession(owner, sessionIdRef.current)) {
        const q = pendingOpenRef.current[owner] ?? [];
        q.push(p);
        pendingOpenRef.current[owner] = q;
        return;
      }
      // A-975-R4：来源透传——主进程 setWindowOpenHandler（站点弹窗）会带 from:"site"，
      // 走弹窗风暴限流；Agent 的工具调用不带（属于用户意图，不限流）。
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
    <aside ref={menuHostRef} className={`right-sidebar${props.open ? "" : " collapsed"}`} style={{ width: props.width }}>
      {/* A-980-R27：只挂 right-sidebar-resizer（left:-5px）——此前同时挂了 sidebar-resizer
          （right:-5px），同一元素左/右锚点都写死属于过约束，拖拽期宽度变化会跟着错位；
          onMouseDown 改 onPointerDown 配合指针捕获，指针划过 <webview> 也不丢松手事件。
          A-980-R27 → A-1106（问题 4）：命中区宽度与流光的**唯一出处是 `index.css`**
          （`.sidebar-resizer` / `.right-sidebar-resizer` 共用段）—— 此处**不重复数值**
          （上一版写「6px → 10px」而 CSS 里是 8px，两处漂移成假陈述）。
          `--rz-y` 的驱动与左栏**共用同一个实现**（`resizerGlint.ts`，两栏各写一份 =
          流光位置有第二个定义）。 */}
      {props.open && !props.floatLayout && (
        /* ⚠️⚠️ A-1152（用户原话：「取消中间聊天部分的可以手动拖拽左右侧边栏宽度，被挤压卸载的功能，
           **改成只能点窗口化收起**」）：**浮层态下不挂拖拽手柄**。
           此前 resizer 只看 `props.open` ⇒ 浮层态（右栏展开着）手柄仍在 ⇒ 用户能直接拖它
           ⇒ 拖动会把右栏拉窄/拉宽，而 `.main` 已归零 ⇒ 观感就是"中间被强行拉开/出现空白"。
           ⇒ 浮层态只保留「窗口化按钮」这一个入口（右栏宽度由 `rightSidebarMaxW()` 统管）。
           ⚠️ `floatLayout` 由 App 注入（`mainIsFloatLayout`），是"此刻中间页已卸载"的**同一份真状态**
           —— 不用另造判据，避免第二份事实。 */
        <div className="right-sidebar-resizer" onPointerDown={props.onResize}
          onMouseMove={trackResizerGlint} onMouseLeave={clearResizerGlint} />
      )}

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
                title={tab.isDefault ? `${tab.fileRel || tab.title}（默认页，常驻）` : (tab.fileRel || tab.title)}
              >
                <Icon size={14} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: "1", minWidth: 0 }}>{tab.title}</span>
                {/* A-980-R24：默认页（任务页）**不再显示「固定」徽标**。
                 *  原徽标是"不可删除"的说明牌，但常驻标签页本身就是约定俗成（VS Code 钉子页同理），
                 *  徽标挤在标题旁边既占宽又不美观（用户反馈）——语义改由 tooltip「默认页，常驻」承载。 */}
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
        {/* A-980-R24：此处原有的第二个「收起右侧栏」按钮**已删除**——顶部标题栏（App.tsx 的
            .titlebar）已有一个同功能按钮，两个并存既重复又让人以为是两个不同操作（用户反馈）。
            收起入口统一由标题栏那一个承担。 */}
      </div>

      {/* A-1015b：菜单浮层加进出场（常驻挂载 + .pop.is-open）。原先是 `{menuOpen && …}`——
          弹出是瞬间出现、关闭是瞬间消失。绝对定位因此不算"折叠"，用位移 + 淡入淡出，
          不做高度插值（top/left 是按按钮实时测的，改高度没意义）。
          ⚠️ 常驻挂载后必须保证收起态 pointer-events:none（在 .pop 里）——
          否则这个不可见的浮层会盖住下面的按钮，"点加号没反应"。 */}
      <div
        ref={menuRef}
        className={`pop${menuOpen ? " is-open" : ""}`}
        style={{
          position: "absolute", zIndex: 9999,
          // A-980-R24：跟随「新建」加号按钮定位（此前无 top/left → 永远贴在侧栏最左端）
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

      {/* ── 内容区 ── */}
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
        {/* A-918++：任务页常驻 mount（display 控制显隐）——切换 tab 时 state 不丢，切回立即看到原数据；
            active=false 时轮询 useEffect 提前 return，不浪费资源 */}
        <div style={{ display: activeTab?.type === "tasks" ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <TasksTab active={activeTab?.type === "tasks"} agentId={props.agentId ?? ""} sessionId={props.sessionId ?? ""} agentName={props.agentName} workspace={props.workspace} dl={props.dl} providerModels={props.providerModels} />
        </div>
        {activeTab && activeTab.type === "terminal" && (
          <TerminalTab workspace={props.workspace} initialCmd={activeTab.termCmd} nonce={activeTab.termNonce} />
        )}
        {/* A-976：浏览器页**全部常驻挂载**（display 控制显隐）+ 每页独立 key。
            此前只挂载当前激活的那一个、且没有 key：切换/新建浏览器页时 React 复用同一个组件实例与
            同一个 <webview> DOM 节点，navUrl 内部 state 也被延续 → 新页继承旧页内容、「两页绑定」
            （用户实测 bug："只能访问一个网站，新建的页延续第一个页的内容，改一个另一个也变"）。
            常驻挂载同时保留了各页各自的浏览位置与历史（切回不重载）。 */}
        {/* A-980-R3：弹窗/协议提示横幅（三态：need-install 琥珀 / opened 绿 / popup-denied 中性；
            高 ≥34px、按钮 min-width + nowrap 防截断变形、URL 单行 ellipsis） */}
        {activeTab?.type === "browser" && popupBanner && (() => {
          const kind = popupBanner.kind ?? "popup-denied";
          const needInstall = kind === "need-install";
          const opened = kind === "opened";
          // A-980-R4：浏览器唤起类协议（bitbrowser:// 等）——不再提示"未注册需装客户端"，
          // 而是说明「已拦截、不唤醒外部浏览器」（BitBrowser 被拉起只会自己弹报错横幅）
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
                  // A-975-R5：在**浏览器页**里打开（复用同址 → 空白页 → 新建），
                  // 不再把「当前页签」的地址改掉（若当前是任务页/文件页会把它们改坏）
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
          // A-979-R：**全部常驻**（display 控制显隐）——A-979 的 LRU 卸载导致非激活 tab 的 webview 被销毁、
          // Agent 切回/操作时重挂载 about:blank 并中断原加载（抖音等反爬站点重载即白屏，用户实测"右侧白屏开不了"）。
          // 资源占用改由「失活显式 setBackgroundThrottling(true)」控制（非激活页动画/定时器/合成降速），
          // 状态不丢、不重载、不白屏；N 个重 tab 叠加的占用是 Chromium 固有成本。
          //
          // A-1137：**交付信息没回来之前不挂浏览器页**。`preload` 只在 webview 首次挂载那一刻生效，
          // 晚到的 preload 会得到一个「能看见搜索页、却搜不动且不报错」的页面 —— 比不显示更坏。
          // （正常情况下这是一瞬间：主进程在注册 IPC 时就已经预热了搜索页。）
          if (searchDelivery === null) { return null; }
          return (
            <div
              key={t.id}
              style={{ display: isActive ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}
            >
              <BrowserTabInstance tabId={t.id} url={t.url ?? ""} active={isActive}
                /* A-1137：每个浏览器页都拿 preload（是否真正 expose 由 preload 自己按"本机文档"判，
                   见 `searchHost.cjs`）；空白页的默认首页 = 搜索页。 */
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
  /** A-1015b：分支下拉从原生 <select> 换成自绘 button + .pop 列表。
      原生 select 的选项面板由**操作系统绘制**（不在 DOM 里），无法参与任何 CSS 过渡 →
      展开/收起必然是"啪"地出现。自绘列表才能跟全仓其他浮层同一节拍。 */
  const [branchOpen, setBranchOpen] = React.useState(false);
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

  /** A-1015b：目录展开改「先取回子项、再开」。
      两个毛病一起修：
      ① 原写在 setState updater 里触发 loadDir（副作用进 updater）—— strict 模式下 updater
         会被调用两次 → 重复请求；
      ② 先开、后加载：.collapse 的插值目标（子项容器高度）此刻还是 0，
         观感是"点了没反应"，等数据回来才由 0 突现。先 await 再置 true，动画才有东西可插。 */
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

  /** A-1015b：目录展开改成「目录行 + .collapse 容器」两层结构。
      原先是把子项数组铺平回同一个列表（`...(isOpen ? renderDirChildren(…) : [])`）——
      展开/收起直接增删 DOM 节点，结构上没有可插值的容器，所以从来没有动画。
      现在每个目录自成一个 wrapper：第一行是目录行，紧跟一个 .collapse 容器，
      容器唯一子元素是装子项的 div（.collapse 是 display:grid，直接子元素就是那一行 grid，
      因此子项必须先包一层，不能直接摊进来）。
      ⚠️ 常驻挂载 → 昂贵内容要 memo；这里子项列表是轻量 DOM，且深度受限，不做 memo。 */
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
      {/* ─ 右键菜单 ── */}
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
          {/* A-1015b：箭头加开合反馈（90°=朝下 表示"有下拉"，270°=朝上 表示"已展开"） */}
          <button className="right-mini-btn" title="仓库菜单" onClick={() => setMoreOpen((v) => !v)} style={{ fontWeight: 700 }}><ChevronIcon size={12} rotate={moreOpen ? 270 : 90} /></button>
          {/* A-1015b：菜单浮层常驻 + .pop 进出场（原先 `{moreOpen && …}` 弹/收都是瞬跳）。
              绝对定位不做高度插值（top 是按按钮实时测的，改高度没意义），用位移 + 淡入淡出。
              `.pop` 自带 pointer-events:none（收起态）—— 常驻浮层不设它就会盖住按钮本身。
              外部点击关闭的 effect 只在 moreOpen=true 时注册，所以浮层常驻不会带来误关。 */}
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
                {(fileCache[""] ?? []).map((e) => renderTreeRow(e, 0))}
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
                    <span ref={branchWrapRef} style={{ position: "relative", marginLeft: "auto", display: "inline-flex" }}>
                      {/* A-1015b：自绘分支下拉（原 <select> 的选项面板由系统绘制，任何 CSS 过渡都进不去） */}
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
                      /* A-1130：与工具卡/思考历程的 diff 用**同一套类**（`think-diff-body` 只负责
                         滚动与底色，`diff-rows-fit` 负责"行行同宽、底色铺到最右"）——
                         此前这里是手抄的一份内联样式，等于同一个事实两个产地，改一处必漏一处。 */
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
  mime: "text" | "docText" | "image" | "binary" | "pdf" | "office";
  content: string;   // 文本原义；图片/二进制为 base64
  size: number;
  truncated?: boolean;
  error?: string;
}

function FileTab(props: { tab: TabInstance; workspace: string; onBack: () => void; onBrowseRootChange?: (root: string) => void;
  /* A-1146：会话产物 diff 需要「哪个会话」的产物 —— 由主组件透传（子组件自己不持有全局状态）。 */
  agentId?: string | null; sessionId?: string }): JSX.Element {
  const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
  const workspaceRoot = props.workspace?.trim() || "";

  /** A-980-R8：用系统默认应用打开文件（word/pdf/ppt/excel 等右侧栏只读格式） */
  const openInSystem = React.useCallback(async (f: FSActionState): Promise<void> => {
    const abs = f.rel && !props.tab.fileAbs ? undefined : props.tab.fileAbs;
    const api2 = (window as unknown as { slimeAPI?: { workspace?: { openPath?: (p: string) => Promise<{ ok?: boolean; error?: string }> } } }).slimeAPI;
    if (!api2?.workspace?.openPath) { return; }
    try {
      // 有绝对路径直接用；否则按「当前浏览根（用户可能选的是工作区之外的目录）→ 回退工作目录」拼绝对路径
      const base = (props.tab.browseRoot || workspaceRoot || "").trim();
      const target = abs ?? (base ? `${base}/${f.rel}`.replace(/\\/g, "/") : f.rel);
      const r = await api2.workspace.openPath(target);
      if (r && r.ok === false && r.error) {
        console.warn("[slime] 系统打开失败:", r.error);
      }
    } catch (e) { console.warn("[slime] 系统打开异常:", e); }
  }, [props.tab.fileAbs, props.tab.browseRoot, workspaceRoot]);

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
  /** A-975：浏览根随 tab 持久化（`tab.browseRoot`）——用户在「打开文件夹」里选定的目录
   *  （可以是**工作区之外**任意位置）不再因会话 workspace 变化/组件重挂载被顶回工作目录。 */
  const [browseRoot, setBrowseRoot] = React.useState<string>(props.tab.browseRoot ?? workspaceRoot);
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
  /* A-1115：md 文档的目录卷轴。参数只在设置页改动时更新一次 state；条目由卷轴在测量时机回调。 */
  const mdScrollRef = React.useRef<HTMLDivElement | null>(null);
  const [railParamsMd, setRailParamsMd] = React.useState<RailParams>(() => loadRailParams("ticks"));
  React.useEffect(() => onRailParams((m, p) => { if (m === "ticks") { setRailParamsMd(p); } }), []);
  const mdScroller = React.useCallback((): HTMLElement | null => mdScrollRef.current, []);
  const collectMdEntries = React.useCallback((): RailEntry[] => {
    const sc = mdScrollRef.current;
    if (!sc) { return []; }
    const scTop = sc.getBoundingClientRect().top;
    // 条目 = 标题（h1/h2/h3）；层级只决定刻度的基础长度
    return Array.from(sc.querySelectorAll<HTMLElement>("h1,h2,h3")).map((el) => {
      const lv = el.tagName.toLowerCase();
      return {
        top: el.getBoundingClientRect().top - scTop + sc.scrollTop,
        label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34) || "（无标题）",
        level: (lv === "h1" ? "h1" : lv === "h2" ? "h2" : "h3") as "h1" | "h2" | "h3",
      };
    });
  }, []);
  // A-918++：diff 模式（当前文件 vs Git HEAD，VS Code 风格红绿行）
  const [diffMode, setDiffMode] = React.useState(false);
  const [diffHead, setDiffHead] = React.useState<string | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffError, setDiffError] = React.useState("");
  /**
   * A-1029：diff 失败的**种类**。区分"不是 Git 仓库"（信息性——这个目录本来就没有历史版本）
   * 与真正的读取错误（红色告警）。此前两者共用一句 `diffError`，用户看到一屏红字
   * `fatal: not a git repository`，既不知道原因也不知道下一步——而其实那个目录
   * 压根不该走 Git 对比，本次改动的 before/after 正躺在聊天区的工具卡里。
   */
  const [diffErrorCode, setDiffErrorCode] = React.useState<"" | "not-repo" | "no-head" | "not-found">("");
  /* A-1146：右栏「对比」的**第二个数据源** —— 本次会话的产物改动。
     用户原话：「右侧边栏的对比功能还是限定死了在 Git 仓库，我觉得应该可以像对话里面的一样，展现此次变动。」
     现实是大量文件根本不在 Git 仓库里（新项目 / 临时脚本 / Agent 现生成的文件）⇒ 以前只会得到一句
     "不在 Git 仓库内…请用聊天区工具卡查看" ⇒ 等于没有这个功能。
     ⚠️ 优先级 = **会话产物优先**：它正是"此次变动"（用户要的），Git HEAD 退为兜底（看历史差异）。 */
  const [sessionDiff, setSessionDiff] = React.useState<SessionFileDiff | null>(null);
  const [diffSource, setDiffSource] = React.useState<"session" | "git">("git");
  // A-918++：切换查看的文件时重置 diff（避免把上一个文件的 HEAD 版本误贴到新文件）
  React.useEffect(() => { setDiffMode(false); setDiffHead(null); setDiffError(""); setDiffErrorCode(""); }, [preview?.rel]);
  /** 左右分栏：左侧文件列表宽度占比（%） */
  const [split, setSplit] = React.useState(40);
  const splitRef = React.useRef<HTMLDivElement>(null);
  /**
   * A-1133：**左栏收起**（用户原话：「文件查看页的左侧文件列表无法收起……总是因为这个列表而无法
   * 完全显示文件内容」）。收起后左栏宽度归 0，内容区独占整宽。
   *
   * 为什么做成**可持久化**：看长文档是连续行为 —— 每开一个文件都要再点一次收起，
   * 等于把"用户已经表达过的偏好"丢掉（NN/g 第 3 条：用户应当有控制权且状态可预期）。
   * ⚠️ 与 `split` 分开存：收起不该覆盖用户拖过的分栏比例，展开时要回到他上次的宽度。
   */
  const [listCollapsed, setListCollapsed] = React.useState<boolean>(() => {
    try { return localStorage.getItem("slime.fileTab.listCollapsed") === "1"; } catch { return false; }
  });
  const toggleListCollapsed = React.useCallback((): void => {
    setListCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("slime.fileTab.listCollapsed", next ? "1" : "0"); } catch { /* 隐私模式等忽略 */ }
      return next;
    });
  }, []);

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

  /** workspace 变化时，把浏览根切换到工作目录（只切根，列出目录交给下面统一的 effect）。
   *  A-975：**用户手动选过目录的 tab 不覆盖**——否则选了个工作区外的文件夹，只要 workspace 一变
   *  （或组件重挂载）就被顶回工作目录，表现成"工作区外的文件打不开"。 */
  React.useEffect(() => {
    if (!workspaceRoot) { return; }
    if (props.tab.browseRoot) {
      if (props.tab.browseRoot !== browseRoot) { setBrowseRoot(props.tab.browseRoot); }
      return;
    }
    setBrowseRoot(workspaceRoot);
    setDirStack([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspace, props.tab.browseRoot]);

  /** A-980-R32：**浏览根一变就列目录**（统一唯一入口）。
   *  此前只有「workspace 变化」那条分支会调 listDir，于是**由外部带着 browseRoot 直接打开的目录页**
   *  （点击思考里出现的目录路径 → 主进程解析出 isDir → 建一个 browseRoot=该目录的文件页）
   *  永远停在空列表，用户看到的是"打开了个空文件夹"。
   *  这里只依赖 browseRoot（不依赖 curRel）：目录内导航由各导航 handler 自己 listDir，
   *  否则一次点击会打两次 IPC 并可能因响应乱序闪烁。 */
  React.useEffect(() => {
    if (!browseRoot) { return; }
    if (props.tab.fileAbs) { return; } // 文件预览页不抢列表
    /* A-1121（②）：带 `browseRel` 的页（Agent 让它「打开文件树到 apps/」）必须**一次到位**：
       先列根再列子目录 = 两次 IPC 且顺序无保证，用户会看到"闪一下又跳走"。
       `dirStack` 也要一起设 —— 只改列表不改面包屑的话，界面会显示"在根目录"却在列 apps 的内容。 */
    const want = (props.tab.browseRel ?? "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (want) {
      setDirStack(want.split(/[\\/]+/).filter((s) => s.length > 0));
      void listDir(browseRoot, want);
      return;
    }
    void listDir(browseRoot, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseRoot, props.tab.fileAbs, props.tab.browseRel]);

  /** A-173：聊天消息内打开的文件（fileAbs/fileContent 异步预读完成）→ 内容回来即渲染预览 */
  React.useEffect(() => {
    if (!props.tab.fileAbs) { return; }
    // A-975：内容为**空文件**时 fileContent === "" 也是有效结果（旧写法用真值判断会漏渲染）
    if (props.tab.fileContent !== undefined) {
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

  /** 打开系统文件夹选择对话框，选择后展示所选目录的内容列表（进入文件资源管理器模式）。
   *  A-975：选定结果写回 tab（`browseRoot`）→ 该页的浏览位置持久化，可停留在**工作区之外**的目录。 */
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
    } catch { /* 用户取消或失败，保持原状 */ }
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
    // A-980-R8：PDF——右侧栏内嵌 <embed> 预览（Chromium 原生 PDF viewer）
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
    /* ══ A-1133：工作文档的**结构化文本**形态 ═══════════════════════════════════════════
       为什么不复用 `text` 分支：那一支是**源码视图**（等宽、不折行、按语言高亮），文档正文恰恰相反 ——
       要按段落排版、要折行、要能看表格/分页标记。
       为什么用 `pre-wrap` 而不是 Markdown 渲染：抽取出来的正文**没有 Markdown 语法**，而
       Markdown 会把"单换行"合并成一段（docx 的段落正是按单换行分隔的）⇒ 段落结构会被吃掉。
       `pre-wrap` + `break-word` 才是"所见即抽取结果"，且**长行不再无限右溢**（用户报的正是在这里）。
       ⚠️ 这里刻意不写 `whiteSpace: "pre"`（那正是"单行无限往右延伸"的根因）。 */
    if (preview.mime === "docText") {
      const blocks = buildDocView(classifyFile(preview.name).kind, preview.content);
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, flexShrink: 0 }}>
            <FileTypeIcon filename={preview.name} size={14} />
            <span style={{ color: "var(--text-secondary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>{preview.name}</span>
            <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>文档文本</span>
            <span style={{ flex: 1 }} />
            {/* 用户要求：把「这里只能看」讲清楚，旁边给一个**只说「跳转」**的按钮（按钮内不放长文案）。 */}
            <span style={{ color: "var(--text-dim)", fontSize: 10.5, flexShrink: 0 }}>当前窗口仅供浏览，如需修改请在系统程序中打开</span>
            {/* A-1133：主按钮 = **转成 HTML 当网页看**。用户原话：「不是说了变换成 HTML 吗，怎么还在文件查看器内？」
                ⚠️ `FileTab` 与 `Sidebar` 是**两个组件** ⇒ 这里只能发事件，由 `Sidebar` 里那份
                `openDocPreviewPage` 落地（"该建什么页"的判据只有一处 —— 本仓的既有约定）。 */}
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
                /* pptx：一页一张卡片（原版式仍需系统程序；这里保证"页边界"这个结构不丢） */
                <section key={i} style={{ marginBottom: 14, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ padding: "5px 10px", background: "var(--bg-secondary)", fontSize: 11, color: "var(--text-dim)", fontWeight: 600 }}>{b.label}</div>
                  <div style={{ padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{b.lines.join("\n")}</div>
                </section>
              ) : b.type === "table" ? (
                /* xlsx / 旧版 xls：**真表格**（这是"显示正确内容"的关键 —— 网格文本读起来根本不是表） */
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
                          /* ⚠️ `minWidth` 与网页版同源（`DOC_CELL_MIN_EM`）：中文 min-content = 1 个汉字，
                             不设下限时"旁边那列超长"会把这一列压成**竖排单字**（用户 2026-09-28 截图）。
                             两处渲染共用同一个常量，不许各写一份（铁律 11）。 */
                          <td key={ci} style={{ border: "1px solid var(--border)", padding: "4px 10px", minWidth: `${DOC_CELL_MIN_EM}em`, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{c}</td>
                        ))}</tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              ) : (
                /* docx / pdf / 纯文本：段落（可折行 —— ⚠️ 不许回到 `white-space: pre`） */
                <p key={i} style={{ margin: "0 0 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{b.text}</p>
              )))}
          </div>
        </div>
      );
    }
    // A-980-R8：Office（word/excel/ppt）——右侧栏不内置解析，提供图标 + 系统应用打开
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
            {/* A-975：此前只提示"自己去资源管理器"，没有出口 → 补「用系统应用打开」（可顺手定位/解压） */}
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
    // Markdown：默认渲染预览；可切到源码查看
    if (!diffMode && isMd && mdMode === "preview") {
      return (
        /* A-1115：外层改成 relative 以便挂绝对定位的目录卷轴；右侧内边距 16 → 30
           （卷轴 6 + 宽 w + 左侧 12px 余量 = 30，不改的话"向左突起"会压到正文）。 */
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
    // A-918++：diff 模式 → 当前文件 vs Git HEAD（VS Code 风格行）
    if (diffMode) {
      if (diffLoading) {
        return <div style={{ flex: 1, padding: 16, color: "var(--text-dim)", fontSize: 12 }}>读取 Git HEAD 版本…</div>;
      }
      /* A-1146：两个数据源在这里合流 —— 会话产物（"此次变动"）优先，Git HEAD 兜底。
         ⚠️ 变量而不是复制渲染块：两份 diff 视图一旦各写一份，样式与统计口径迟早漂。 */
      const sd = diffSource === "session" ? sessionDiff : null;
      const useSession = !!sd && !sd.trimmed;
      if (!useSession && diffHead === null) {
        /* A-1029：按**失败种类**分色。
           "不是 Git 仓库"是**信息**而不是错误——这个目录本来就没有历史版本，用户没做错什么，
           真正有用的信息是"去哪看这次改动"。全屏红字 `fatal: not a git repository` 只会让人
           以为功能坏了。剩下的（读取失败、文件不在 HEAD）才保留红色告警。 */
        const infoOnly = diffErrorCode === "not-repo" || diffErrorCode === "no-head";
        return (
          <div style={{ flex: 1, padding: 16, fontSize: 12, color: infoOnly ? "var(--text-muted)" : diffError ? "var(--danger)" : "var(--text-dim)", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              {infoOnly && <WarningIcon size={13} style={{ flexShrink: 0, marginTop: 2, color: "#fbbf24" }} />}
              <span style={{ flex: 1 }}>{diffError || "（此文件未纳入 Git / HEAD 无此版本）"}</span>
            </div>
            <div>
              {/* A-1146：两条路都拿不到时，把"各自为什么不行"说清楚 —— 尤其"这次改过但详情没存下来"
                  这一种，静默只给 Git 的提示会让用户以为"这次没改过"。 */}
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
          {/* A-1130：`diff-rows-fit` 让所有行同宽 ⇒ 底色铺到最右（判据见 index.css）。
              ⚠️ 这个容器自己的 `flex:1/minHeight:0` 是布局需要，故保留内联样式，
                 只把"行行同宽"这条**判据**交给唯一产地（类）。 */}
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
      /* A-1133：**代码**保留不折行（等宽 + 横向滚动是它的正确形态），但**纯文本**必须折行 ——
         否则一篇长文就是"单行无限往右延伸"（用户报的正是这个）。判据用"有没有识别出语言"：
         认出语言 = 代码（`highlightCode` 会处理）；没认出 = 普通文本 ⇒ 折行。 */
      <pre style={{ flex: 1, margin: 0, padding: "12px 14px", fontSize: 13, fontFamily: "Consolas, 'Courier New', monospace", lineHeight: 1.6, color: "var(--text)", overflow: "auto", whiteSpace: lang ? "pre" : "pre-wrap", wordBreak: lang ? "normal" : "break-word", overflowWrap: lang ? "normal" : "anywhere", tabSize: 2 }}>
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
    /* A-1146：先问「本次会话有没有改过这个文件」—— 有就直接看它（不依赖 Git 仓库）。
       ⚠️ 两条路都拿不到时，**说明白两条路各自为什么不行**（不静默降级）。 */
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
          // A-1029：把主进程给出的**失败种类**原样接下（渲染层不再自己猜文案），
          // 非仓库/无 HEAD 走信息性提示，其余才当错误。
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

  /* ── 统一布局：顶栏 + 左右分栏（左：文件列表 / 右：内容预览） ── */
  return (
    <div className="right-tab-pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶栏：← 返回上级 + 路径 + 打开文件夹 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button onClick={goBack} title={canGoUp ? "返回上一级" : "返回 Git 仓库"} disabled={!canGoUp} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", cursor: canGoUp ? "pointer" : "not-allowed", color: canGoUp ? "var(--text-secondary)" : "var(--text-dim)", fontSize: 12, opacity: canGoUp ? 1 : 0.5 }}><ArrowLeftIcon size={14} /></button>
        {/* A-1133：左栏收起/展开（唯一开关）。收起后内容区独占整宽 —— 长文档不再被列表挤窄。 */}
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

      {/* 左右分栏容器 */}
      <div ref={splitRef} style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
        {/* 左：文件列表（A-1133 可收起：宽度归 0 + 去掉分隔线，内容区独占整宽） */}
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
          {/* A-1120：降级说明常驻在内容上方 —— 内容照常可读，同时如实说明"为什么不是你要的那种形态" */}
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

/* ══════════════ 任务进度 ══════════════ */

   interface AccumUsage {
  requests: number;
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /**
   * A-990「以模型所属地决定总账币种」：累计成本里**来自人民币归属地模型**的那部分
   * （与 `costUsd` 同一记账单位，都是 USD —— 只是按成本来源模型归属地做了归集）。
   *
   * 为什么需要它：右栏「会话费用」原先硬编码 `costUsd * 7.25`（且 7.25 与共享层的
   * `USD_CNY_RATE=7.2` 不一致，同一笔账两处显示不同数）。现在改为：
   *   - 币种由**本会话成本主要来自哪个归属地的模型**决定（见 `usageCurrency`）；
   *   - 金额经共享层唯一折算点 `convertFromUsd` 换算，格式由 `formatMoney` 统一
   *     （不再 `toFixed(4)` 印出 `¥12.3000` 这种长尾 —— 用户原话"看着不舒服"）。
   */
  costUsdFromCn: number;
  /** A-974-R6：推理 token 含**估算成分**（上游 usage 从不回传 reasoning_tokens 时，用实际收到的
   *  思考文本按 ≈4 字符/token 折算并明示为估算，避免该行永远显示 0 造成"侦测不到"的误解）。 */
  reasoningEstimated?: boolean;
  /**
   * A-1095：本会话上游的 `prompt_tokens` **是否已包含**缓存命中（`cache_read_in_prompt`）。
   *   - `true`  → OpenAI / DeepSeek 系（prompt 是总量）
   *   - `false` → Anthropic / Claude（input 不含 cache_read）
   *   - `undefined` → 上游未标记（旧持久化数据 / 非流式路径）→ 消费方按 `true` 兜底
   *
   * 为什么必须落到累计态：侧栏「Token 构成 / 明细」的**合计要去重**（缓存命中 ⊂ 输入），
   * 而去重方向取决于是哪一家协议 —— 不记下来，渲染层就只能猜，猜错就是又一次"假信息"。
   */
  cacheReadInPrompt?: boolean;
}

interface ModelPriceInfo {
  price_in_usd?: number;
  price_out_usd?: number;
  /**
   * A-990-B：用户在「定价」面板为该模型手选的计价币种。
   * 右栏的总账币种**优先看它**（`pricingDisplayCurrency`：用户选择 > 归属地推断）——
   * 否则会出现"面板里我选了 ¥，右栏却按 $"的分裂。
   */
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
  /** A-980-R27：完成时刻（ISO）。由 todo_write 落盘时打戳，这里只读用于展示"何时完成" */
  completedAt?: string;
}

/**
 * A-987：主进程回传/推送的待办 → 渲染层 `TodoItem`（映射只有这一处，别在调用点各写一遍）。
 *
 * `id` 必须有兜底：它是渲染 key，为空会让 React 复用错行（表现为勾了 A 行亮 B 行）。
 */
function toTodoItems(raw: Array<{ id?: string; content?: string; status?: string; completedAt?: string }>): TodoItem[] {
  return raw.map((t) => ({
    id: t.id ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content: String(t.content ?? ""),
    status: (t.status as TaskStatus) ?? "pending",
    completedAt: t.completedAt,
  }));
}

/**
 * A-980-R27：完成标记的图形部分——实心绿底 + 可"画入"的对勾。
 *
 * 为什么不用现成图标组件：`CheckboxCheckedIcon` 是一条静态路径，没有可供动画的
 * stroke-dasharray 钩子，做不出"划一下打勾"的完成反馈。这里自绘一个最小 SVG：
 * - `pathLength={100}` 把路径长度归一化 → CSS 里 dasharray/dashoffset 恒为 100，
 *   无论图标渲染成 13px 还是 15px、check 的 d 怎么调，动画都刚好一划到底（不会被截断）。
 * - 颜色走 `var(--success)`，深浅主题共用一套。
 * 无障碍：完成态本身还有删除线（纹理）+ 行降透明度，不靠颜色单独传意（WCAG 1.4.1）。
 */
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

/**
 * 待办分组标题（进行中 / 待办 / 已完成）。
 * 细线填满剩余宽度，让分组在窄侧栏里也能一眼分段，而不靠加粗或背景块。
 */
function TodoGroupLabel({ text, count, tone }: { text: string; count: number; tone: "accent" | "muted" | "success" }): JSX.Element {
  const color = tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : "var(--text-dim)";
  // A-980-R28：上内边距 7px → 4px。分组标题只在多状态时出现，7px 的留白在窄侧栏里显得很空。
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 5px 0", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, color }}>
      <span>{text}</span>
      <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}

/**
 * A-980-R28：待办数量徽标。
 *
 * 原来是一段内联样式（`fontSize:10 + padding:1px 6px + borderRadius:999`），
 * 靠行盒自然撑高 → 数字在胶囊里**上下不居中**（用户："那个数字文本内容不在文本框的正中间"），
 * 且 `1/3` 与 `10/12` 宽度不同会让胶囊忽宽忽窄。
 * 现在用固定高度 + inline-flex 居中 + `tabular-nums` + `minWidth` 锁宽，
 * 数字永远垂直居中、位数变化也不跳。
 */
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

/** 完成时刻的紧凑展示：今天只给 HH:MM，跨天补 MM-DD（侧栏空间紧张，不写年份） */
function fmtDoneAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return ""; }
  const p = (n: number): string => String(n).padStart(2, "0");
  const now = new Date();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
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
            /* `api:<provider_key>:<model_id>` / `api:<provider_key>` / 纯 `<model_id>` */
            const parts = choice.split(":");
            /* ⚠️ 这里曾写 `key = parts[0]` —— 而 `parts[0]` 恒为字面量 `"api"`：
             * 于是 `providers.find(p => p.key === "api")` **永远命中不了任何供应商**，
             * 那段「按 provider 规格取 context_window」的分支是**死代码**，
             * 上限只能落到运行时探测的兜底值（甚至 0）。表现为面板上的上限与
             * 供应商配置里写的规格对不上（本仓实测：配置 1M，界面 512K/524K）。
             * `api:` 是**格式标记**，不是供应商 key —— key 在第二段。 */
            const isApiForm = parts[0] === "api";
            const modelId = isApiForm ? (parts[parts.length - 1] ?? "") : choice;
            const key = isApiForm && parts.length >= 3 ? parts[1] : null;
            const providers = await api.providers.list().catch(() => [] as Array<{ key: string; models?: Array<{ id: string; context_window?: number }> }>);
            if (key) {
              const prov = providers.find((p: { key: string }) => p.key === key);
              const hit = prov?.models?.find((x: { id: string; context_window?: number }) => x.id === modelId);
              // 供应商 key 命中但没这个模型 → 不跨供应商乱找（那会把别家的窗口扣到本模型头上）
              ctx = hit?.context_window;
            } else {
              for (const p of providers) {
                const m = p.models?.find((x: { id: string; context_window?: number }) => x.id === modelId);
                if (m?.context_window && m.context_window > 0) { ctx = m.context_window; break; }
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
    /* ⚠️ `api` 自身必须带可选链：preload 未就绪 / 沙箱未注入时 `slimeAPI` 是 undefined，
       此前只在第二层（chat）带了可选链，会在读第一层属性时当场抛
       "Cannot read properties of undefined (reading 'chat')"
       —— 这个异常发生在**渲染阶段**，会被 ErrorBoundary 拦下并替换整棵组件树
       （用户看到的是"界面渲染出错"，而不是某个按钮失灵）。降级为"没有流式指标"是可接受的，
       整页白屏不可接受。 */
    const off1 = api?.chat?.onChunk?.(() => setIsStreaming(true));
    const off2 = api?.chat?.onDone?.(() => setIsStreaming(false));
    const off3 = api?.chat?.onError?.(() => setIsStreaming(false));
    return () => { off1?.(); off2?.(); off3?.(); };
  }, [api]);
  /** A-975：自动压缩触发占比——阈值刻度线与「距压缩」余量同源；设置面板保存后立即跟随（不再写死 80%） */
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
  /**
   * A-990-D：主页实时监测的消费币种（「通用」设置里手选，`auto` = 沿用推断）。
   * 订阅方式与上面的 `acRatio` 一致：本窗口事件 + `storage`（另一个窗口改了也要跟随）。
   * 为什么必须订阅而不是渲染时现读：右栏只在数据变化时重渲，用户改完设置回到聊天页
   * 可能很久不重渲 → 他会以为没生效，然后再改一遍。
   */
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
      } catch { /* ignore */ }
    };
    void refreshModel();
    const timer = setInterval(() => { void refreshModel(); }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.agentName, active]);
  /** 模型定价刷新的外部抓手：每轮回复 done 后立即刷一次（新模型可能刚被用到）。
   *  ⚠️ 不把轮询调紧的原因：主进程 listProviders → loadTable → decrypt 无缓存，
   *  每次都要跑一遍 PBKDF2(600k) 且是**同步**的（阻塞主进程）——5s 轮询会让 GUI 周期性卡顿。
   *  因此采用「事件驱动（done 即刷）+ 30s 兜底」而非高频轮询。 */
  const pricesRefreshRef = React.useRef<(() => void) | null>(null);
  /** 定期刷新模型定价缓存；切模型时由 modelChoice 变化主动 refresh 一次（A-4b） */
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
                // A-990-B：把用户手选的币种一起带过来，总账币种要用它
                price_currency: mod.price_currency,
              });
            }
          }
        }
        modelPricesRef.current = m;
      } catch { /* ignore */ }
    };
    void refresh();
    pricesRefreshRef.current = () => { void refresh(); }; // 暴露给 onDone：回复完成即刷
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
  /** 从 localStorage 持久化恢复：key 按「agentId + sessionId」聚合（会话级），
   *  会话切换时重新读取，避免多会话任务串联混淆（A-919） */
  const loadPersisted = React.useCallback(() => {
    // A-980-R28：**会话就绪前一律不读**。此前无守卫，会把 key 拼成
    // `slime_tasks_<agentId>_undefined`：既可能读到脏 key 里的缓存，
    // 又会让后面的 flushPersist 把数据写进这个永远无人认领的桶里。
    if (!props.agentId || !props.sessionId) { return null; }
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
  /** A-974-R6：本轮在途输出估算（正文/思考）——流式期间让「Token 明细」跟随刷新，done 时结算进累计 */
  const [liveTurn, setLiveTurn] = React.useState<{ reply: number; reason: number }>({ reply: 0, reason: 0 });
  const liveTurnRef = React.useRef<{ reply: number; reason: number }>({ reply: 0, reason: 0 });
  /** A-975：本轮流式已耗时——并入「运行时间」让它在流式期也走字 */
  const [liveElapsed, setLiveElapsed] = React.useState(0);
  /** 清空在途输出估算（本轮结算进累计 / 切会话 / 异常收尾） */
  const resetLiveTurn = React.useCallback((): void => {
    liveTurnRef.current = { reply: 0, reason: 0 };
    setLiveTurn({ reply: 0, reason: 0 });
    // A-980-R31：**同时清掉挂起里的在途值**。
    // 否则 done 路径「先 resetLiveTurn() 再 applyPendingCtx()」会把刚才清掉的旧在途值
    // 又原样灌回来（applyPendingCtx 读的是 pendingCtxRef），在途估算被重复展示/重复计入。
    pendingCtxRef.current.reply = 0;
    pendingCtxRef.current.reason = 0;
    pendingCtxRef.current.elapsedMs = 0;
  }, []);
  // A-939：上下文分桶（随 done 事件/单一事件源传入；缺省 undefined 回退到 compose 的旧展示）
  const [liveBuckets, setLiveBuckets] = React.useState<CtxBuckets | undefined>(undefined);
  /** A-935：会话 ID 实时引用——订阅闭包读 ref 而非陈旧 props（根治切会话后 done/事件被旧值误过滤，
   *  导致右栏不更新/慢于圆环的根因）；组件随会话切换不重建本闭包也不受影响 */
  const sessionIdRef = React.useRef(props.sessionId);
  React.useEffect(() => { sessionIdRef.current = props.sessionId; }, [props.sessionId]);
  /** A-975：右栏刷新节拍。
   *
   *  为什么是节拍而不是"来事件就 setState"：右栏是大组件，流式期 1s 心跳 + 高频派发会让它高频重渲染，
   *  观感"又慢又抖"；所以事件只写 ref、由节拍统一应用。
   *
   *  ⚠️ A-980-R31 **根因修复**：节拍此前是**固定 10s**——等于右栏在整轮输出/思考过程中一动不动，
   *  直到 done 才一次性跳变（用户："为什么思考中右边的所有实时监测报告的功能都不实时更新？"）。
   *  现在改成**事件驱动的自适应节拍**：
   *   - 有事件进来 → 最多 LIVE_APPLY_MS 后落地一次（尾沿合并，一窗多事件只渲染一次）；
   *   - 空闲时 10s 兜底一拍（覆盖"无事件但显示值需要沉淀"的场景，如耗时兜底）。
   *  主观上"跟着流走"，客观上渲染频率仍有上限（≤1 次/秒）。 */
  const LIVE_APPLY_MS = 1000;
  const pendingCtxRef = React.useRef<{
    used?: number; cap?: number; buckets?: CtxBuckets; reply?: number; reason?: number; elapsedMs?: number;
  }>({});
  const appliedCtxOnceRef = React.useRef(false);
  /** 挂起中的落地定时器（**只由卸载 effect 清理**；事件到达时若已挂起则复用 → 天然合并） */
  const ctxApplyTimerRef = React.useRef<number | null>(null);
  /** 把 ref 里的最新值一次性应用到状态（事件节拍 + 首次 + done 强制三处调用） */
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
  /** 排一次落地（已在挂起则复用该窗口，实现"合并 + 有上限的实时性"） */
  const scheduleApply = React.useCallback((): void => {
    if (ctxApplyTimerRef.current !== null) { return; }
    ctxApplyTimerRef.current = window.setTimeout(() => {
      ctxApplyTimerRef.current = null;
      applyPendingCtx();
    }, LIVE_APPLY_MS);
  }, [applyPendingCtx]);
  /** 卸载清理挂起的落地定时器 */
  React.useEffect(() => () => {
    if (ctxApplyTimerRef.current !== null) {
      window.clearTimeout(ctxApplyTimerRef.current);
      ctxApplyTimerRef.current = null;
    }
  }, []);
  /** A-935：订阅上下文占用单一事件源（发送估算 / 流式实时 / done 真实校准）——与右上角环严格同源 */
  React.useEffect(() => {
    const off = onCtxUpdate((p) => {
      if (p.sessionId !== sessionIdRef.current) { return; }
      // 只写 ref（零重渲染）；实际落地交给节拍 / done
      const q = pendingCtxRef.current;
      if (p.used > 0) { q.used = p.used; }
      if (p.cap > 0) { q.cap = p.cap; }
      if (p.buckets) { q.buckets = p.buckets; }
      q.reply = typeof p.liveReplyTokens === "number" ? p.liveReplyTokens : 0;
      q.reason = typeof p.liveReasonTokens === "number" ? p.liveReasonTokens : 0;
      q.elapsedMs = typeof p.liveElapsedMs === "number" ? p.liveElapsedMs : 0;
      // 首次有值立即落地一次（否则新会话要等满一拍右栏才有数字，观感像"没数据"）；
      // 之后走快速节拍 —— 这就是"思考中右栏全都不动"的修复点。
      if (!appliedCtxOnceRef.current) { applyPendingCtx(); } else { scheduleApply(); }
    });
    return off;
  }, [applyPendingCtx, scheduleApply]);
  /** 空闲兜底节拍：覆盖"无事件、但显示值仍需沉淀"的场景（耗时兜底等）；有事件时由快速节拍负责 */
  React.useEffect(() => {
    const iv = window.setInterval(() => { applyPendingCtx(); }, 10_000);
    return () => window.clearInterval(iv);
  }, [applyPendingCtx]);

  /**
   * A-982：**主动取样**在途监测快照（每 250ms），这是"右栏实时"的主通道。
   *
   * 为什么必须有这条：事件推送链上任何一处守卫失效都会让数值静默冻死 —— 且不报错、测试也测不出
   * （事件本身没错，只是没到）。这条拉取路径只依赖"ChatPanel 还在写快照"，与订阅时机、
   * 节流窗口、组件重挂全部解耦，因此"输出途中右栏不动、只在 done 跳变"这个反复出现三次的
   * 问题从架构上不再可能复现（done 后再停写快照，取样自然停止，也顺带避免了残值）。
   *
   * 取值全部走"不变则原样返回"的更新方式，避免每拍都重渲染。
   */
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
  /** A-934：重启恢复——右栏窗口占用随会话元数据还原（与右上角环同源读取同一 key）；
   *  无持久化占用 → 显式置 0，防残留上一会话数值（切会话不同步的根因） */
  React.useEffect(() => {
    const meta = readSessionCtxMeta(props.agentId, props.sessionId);
    setLiveUsed(restoreUsed(meta));
    if (meta?.cap && meta.cap > 0) { setLiveCap(meta.cap); }
    resetLiveTurn(); // A-974-R6：切会话清空在途输出估算，防上一会话残值混入
    // A-975：切会话必须清掉挂起的 10s 快照，否则下一拍会把**上一个会话**的数值刷回来
    pendingCtxRef.current = {};
    appliedCtxOnceRef.current = false;
    setLiveElapsed(0);
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
      // A-980-R28：会话未就绪不落盘——否则会写进 `slime_tasks_<agent>_undefined` 这个
      // 永远无人认领的桶，下次启动若仍是未就绪态就会被当成本会话初值读回来
      if (!props.agentId || !props.sessionId) { return; }
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
      // A-980-R28：**会话未就绪必须清空并停止拉取**。TasksTab 拿到的是 `props.sessionId ?? ""`，
      // 空串会让主进程读到 `todos_` + "" + `.json` = `data/todos_.json` —— 修复前遗留的孤儿文件
      // 恰好长这样，于是"会话加载途中就闪出上一次的旧待办"（用户实测）。
      if (!props.agentId || !props.sessionId) {
        setTodos([]);
        setUsage(EMPTY_USAGE);
        return;
      }
      const p = loadPersisted();
      if (p) { setTodos(p.todos); setUsage(p.usage); } else { setTodos([]); setUsage(EMPTY_USAGE); }
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      // A-987：**磁盘才是真源，localStorage 只是上次的镜像** —— 上面的 `loadPersisted()`
      // 只配当"立即出画面"的草稿，随后必须被主进程读盘的结果覆盖掉。
      // 此前这里写的是 `void api?.tasks?.loadTodos?.(...)`（返回值直接丢弃，指望广播回来纠正），
      // 三个后果都实测过：
      //   ① 用户点「清空」→ 主进程删盘 + 广播空列表；但只要渲染层这一轮恰好没收到广播，
      //      localStorage 里那份旧清单就会在下一次切会话时**原样铺回面板**；
      //   ② IPC 失败被 `.catch(() => {})` 吞掉 → 内存清了、盘子还在，切走再切回就"删了又回来"；
      //   ③ 打开会话先闪一下旧清单再被广播纠正（肉眼可见的错帧）。
      // 现在把返回值的**显式**取用补上，并带会话守卫：异步返回时若已切走/卸载，一律丢弃
      // （否则会把上一个会话的清单写进当前面板 —— 竞态的经典形态）。
      let alive = true;
      void api?.tasks?.loadTodos?.(props.sessionId)
        .then((r: { todos?: Array<{ id?: string; content?: string; status?: string; completedAt?: string }> } | undefined) => {
          if (!alive || !r || !Array.isArray(r.todos)) { return; }
          setTodos(toTodoItems(r.todos));
        })
        .catch(() => { /* 读盘失败保留草稿：下一次广播/切会话会再对齐 */ });
      return () => { alive = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.agentId, props.sessionId]);
    // 订阅主进程推送的任务列表（todo_write 工具写入后由主进程广播；按 sessionId 过滤）
    React.useEffect(() => {
      const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
      if (!api?.tasks?.onTodos) { return; }
      const off = api.tasks.onTodos((data: { sessionId: string; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }) => {
        // A-980-R28：**两侧都必须严格匹配**。此前写的是
        // `if (props.sessionId && data.sessionId !== props.sessionId) return;`
        // —— props.sessionId 为空时整条守卫被跳过，任何会话（含空会话的孤儿文件）的推送都会被收下。
        if (!props.sessionId || !data.sessionId || data.sessionId !== props.sessionId) { return; }
        setTodos(toTodoItems(data.todos));
      });
      return () => { off(); };
    }, [props.sessionId]);

  /**
   * A-986：手改待办 = 乐观更新 + **落盘**。
   *
   * ⚠️ 这是本次修的根因：此前 `toggleTodo/advanceTodo/addTodo` 只调 `setTodos()` 改内存，
   * 而待办的真源是 `data/todos_<sid>.json`。于是任何一次 `slime:tasks:todos` 广播
   * （模型 `todo_write` / 切会话 / 重启读盘）都用盘上的旧内容把用户的手改**覆盖回去** ——
   * 用户实测"手动全部勾选了还是没反应"。主进程的「全部完成 → 自动清空」挂在 `broadcastTodos` 上，
   * 手改不落盘就永不广播 → 勾完也不会清。
   * 现在与模型写待办走**同一条链路**（落盘 → 广播），语义才一致、行为才可预期。
   *
   * 顺序刻意是"先改本地再发 IPC"：勾选反馈必须是立即的；即使 IPC 失败，下一次广播会把
   * 磁盘真值刷回来（自愈），不会长期显示假状态。
   */
  const persistTodos = React.useCallback((next: TodoItem[]): void => {
    setTodos(next);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    if (!props.sessionId) { return; }
    void api?.tasks?.saveTodos?.(props.sessionId, next).catch(() => { /* 交给下一次广播纠正 */ });
  }, [props.sessionId]);

  /** A-986：整张清空（用户明确要求恢复的手动入口 —— 见下方长注释） */
  const clearAllTodos = React.useCallback(async (): Promise<void> => {
    if (!props.sessionId || todos.length === 0) { return; }
    const ok = await confirmAsync(
      `清空待办清单？将删除本会话的全部 ${todos.length} 项（含已完成记录）并删除落盘文件。`,
      "此操作不可撤销。若非本会话的任务，请先确认当前会话是否正确。",
    );
    if (!ok) { return; }
    setTodos([]);
    const api = (window as unknown as { slimeAPI?: any }).slimeAPI;
    void api?.tasks?.clearTodos?.(props.sessionId).catch(() => { /* 下一次读盘会纠正 */ });
  }, [props.sessionId, todos.length]);

  const toggleTodoCollapse = React.useCallback(() => setCollapsedTodos((v) => !v), []);

  const addTodo = React.useCallback(() => {
    // A-980-R28：会话未就绪时不接受手动添加——否则这条任务无处归属（既不会落盘到任何会话，
    // 也会在切会话时被清掉，用户观感是"加了就没了"）
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
      // 手动勾选同样要打/撤完成时间戳，语义与 todo_write 工具保持一致
      if (t.status === "completed") { return { ...t, status: "pending", completedAt: undefined }; }
      return { ...t, status: "completed", completedAt: t.completedAt ?? new Date().toISOString() };
    }));
  }, [todos, props.sessionId, persistTodos]);

  const advanceTodo = React.useCallback((id: string) => {
    if (!props.sessionId) { return; }
    // 「单一进行中」是全局约束（与 todo_write 归一化同一规则），手动切换也不能破坏
    persistTodos(todos.map((t) => {
      if (t.id === id) { return t.status === "completed" ? t : { ...t, status: "in_progress" }; }
      return t.status === "in_progress" ? { ...t, status: "pending" } : t;
    }));
  }, [todos, props.sessionId, persistTodos]);

  /**
   * A-980-R32：**移除了两个手动清除入口**（行尾 ✕ 单删 / 标题栏「清完成」）。
   *
   * 为什么删：待办清单现在由 Agent 的任务规划驱动（`todo_write` 落盘 → 主进程广播），
   * 完成态本身就是"滚动的进度账"，而两项手动删除的语义与它冲突：
   * - 行尾 ✕ 删掉的是**证据**：用户事后复盘时看不到"这项做过/跳过了"；
   * - 「清完成」是**双份控制**：全部完成时主进程会自动清空（见 scheduleTodoAutoClear），
   *   再留一个手动按钮只会让人以为"不清就一直是脏的"。
   * 需要真正丢弃整张计划时，模型调 `todo_write {action:"clear"}` 即可（有明确归属与留痕）。
   */

  /**
   * A-980-R27：完成瞬间的「划过」动画。
   *
   * 行是稳定 key，状态变化不会重挂载，所以单靠 CSS 无法知道"这一帧刚好完成"。
   * 这里 diff 出**刚刚**变成 completed 的 id，短暂放进 justDoneIds（900ms），
   * 渲染时给这些行打 data-just-done，由 CSS 播放「对勾画入 + 删除线划入 + 沉降」。
   *
   * A-980-R28：基线**必须带上所属会话**。todo id 常是模型自己编的 "1"/"2"/"3"，
   * 切换会话时新旧两批 id 会撞车 → 新会话里本来就是 completed 的项会被误判成"刚刚完成"而整片闪。
   * 首次拉取（无基线 / 换了会话）一律不判定，只重建基线。
   */
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

  /**
   * 分组：进行中 → 待办 → 已完成。
   * 已完成的沉到底部是有意的（GOV.UK 任务列表的用户研究发现：完成几项之后，用户很难再扫出"还没做的"）。
   * 组内保持原顺序（计划本身的顺序有意义）。
   */
  const todoGroups = React.useMemo(() => {
    const active = todos.filter((t) => t.status === "in_progress");
    const pending = todos.filter((t) => t.status === "pending");
    const done = todos.filter((t) => t.status === "completed");
    return { active, pending, done };
  }, [todos]);

  /**
   * A-980-R28：会话未就绪（sessionId 还是空串）时，待办区**不渲染任何数据**。
   * 这是"pnpm dev 冷启动、会话加载途中冒出上一次的待办任务"的兜底门闸——
   * 除了干净的空态，不给任何可能来自"空会话文件 / 上一会话缓存"的内容留显示窗口。
   */
  const sessionReady = Boolean(props.sessionId);
  /** 分组标题只在**存在多个分组**时才显示：同状态一堆任务时，标题纯属占高（用户："该紧凑的不紧凑"）。 */
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
        // A-973：tool 事件标签必须带上「具体抓手」（文件路径/网址/查询词）——
        // 下方「会话文件」tab 靠正则从标签里抽扩展名文件，只存工具名的旧逻辑永远抽不到 → 恒空。
        let detail = "";
        try {
          const args = typeof c.data?.args === "string" ? JSON.parse(c.data.args) : (c.data?.args ?? {});
          if (args.path && typeof args.path === "string") { detail = args.path; }
          else if (args.file && typeof args.file === "string") { detail = args.file; }
          else if (args.url && typeof args.url === "string") { detail = args.url; }
          else if (args.query && typeof args.query === "string") { detail = args.query; }
        } catch { /* args 不可解析 → 无细节 */ }
        // A-1018：工具名走**唯一映射** resolveToolLabel（与思考历程的工具卡同源）→ 显示人类可读名，
        // 不再是 `⟳ 调用工具 web_search` 这种裸工具名。detail 必须保留：下方「会话文件」tab
        // 靠正则从 label 里抽扩展名文件，去掉它那个 tab 会恒空。
        const label = name.startsWith("delegate:")
          ? `传唤子 Agent「${name.slice(9)}」`
          : `${resolveToolLabel(name).label}${detail ? ` ${detail}` : ""}`;
        pushEvent("tool", label, name);
      } else if (t === "reasoning") { setRunning(true); }
      else if (t === "progress") { pushEvent("progress", c.data?.progress ?? c.data?.content ?? "子任务进行中…"); }
      else if (t === "chunk") { setRunning(true); }
    });
    const off2 = api.chat.onDone((m: { interrupted?: boolean; timings?: Record<string, number>; model?: string; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }) => {
      // A-933 会话隔离：本面板只记账当前会话的流（用实时 ref，杜绝陈旧 props 误过滤）
      if (m.sessionId != null && m.sessionId !== sessionIdRef.current) { return; }
      setRunning(false);
      pushEvent("done", m?.interrupted ? "⏹ 已中断" : "回复完成");
      pricesRefreshRef.current?.(); // 本轮可能首次用到某模型 → 立即刷新定价（费用/命中率不留 30s 空窗）
      const t = m?.timings ?? {};
      const pt = typeof t.promptTokens === "number" ? t.promptTokens : 0;
      const ct = typeof t.completionTokens === "number" ? t.completionTokens : 0;
      const rtReal = typeof t.reasoningTokens === "number" ? t.reasoningTokens : 0;
      const cr = typeof t.cacheReadTokens === "number" ? t.cacheReadTokens : 0;
      // A-1095：协议语义标记（与 ChatPanel 同一编码：timings 里布尔存为 1/0）——
      // 侧栏「Token 构成 / 明细」的输入侧**去重**依赖它（OpenAI 系 prompt 已含命中）。
      // 上游没标记（undefined）时**不覆盖**累计值，由消费方按缺省 true 兜底。
      const cri = t.cacheReadInPrompt === 1 ? true : t.cacheReadInPrompt === 0 ? false : undefined;
      const em = typeof t.elapsedMs === "number" ? t.elapsedMs : 0;
      // A-974-R6：推理 token 兜底——上游 usage 不回传 reasoning_tokens 时（本项目全量历史里它恒为 0，
      // 见 config/usage.jsonl），用本轮**实收思考文本**按 ≈4 字符/token 折算，并置 reasoningEstimated
      // 让明细行显式标注「估算」；上游一旦回传真实值则一律以真实值为准（估算不覆盖真值）。
      const turnLive = liveTurnRef.current;
      const reasonEst = Math.round(turnLive.reason);
      const rt = rtReal > 0 ? rtReal : reasonEst;
      const markingEstimated = rtReal <= 0 && reasonEst > 0;
      // 费用计算：从模型缓存读取定价；无定价时 cost=0
      const cost = computeModelCost(m?.model ?? "", pt, ct, modelPricesRef.current);
      // A-990：同时记录这笔费用来自哪个归属地的模型 —— 右栏总账从此按"钱主要花在哪边的模型"
      // 选显示币种（用户指令：以模型所属地决定），不再无脑乘 7.25 假装成人民币。
      // A-990-B：币种判定走 `pricingDisplayCurrency` —— **用户在定价面板手选的币种优先**，
      // 没选过才回落到归属地推断。否则用户选了 ¥ 而右栏仍按 $ 显示，又是一处"两处不一样"。
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
      resetLiveTurn(); // 本轮已结算进累计（含估算），清空在途值
      // A-975：done 是"最终值"落地时机 → 立刻应用一次挂起的 ctx 快照（不等 10s 节拍），
      // 否则一轮结束后右栏可能还停在中途值上
      applyPendingCtx();
    });
    const off3 = api.chat.onError((e: { message?: string }) => {
      setRunning(false);
      resetLiveTurn(); // A-974-R6：异常收尾同样清空在途输出估算
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

  /**
   * 活动记录行首徽标。
   * `Icon` 存在时 → 渲染**图标**代替文字胶囊（`done` 用 `完成.svg` 转出来的 DoneIcon）。
   */
  const badge = (k: TaskEvent["kind"]): { color: string; bg: string; text: string; Icon?: (p: IconProps) => JSX.Element } => {
    switch (k) {
      case "tool": return { color: "var(--accent)", bg: "var(--accent-soft)", text: "工具" };
      case "thinking": return { color: "var(--accent-hover)", bg: "var(--accent-soft)", text: "思考" };
      case "progress": return { color: "var(--warning)", bg: "rgba(251,191,36,0.12)", text: "进度" };
      // A-1021：`done` 不再显示文字「完成」——在整列图标/短词徽标里冒出一个绿色文字胶囊显得突兀
      // （用户实测截图）。改用 `D:\下载\完成.svg` 转出来的 DoneIcon（绿底白勾）。
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

  /**
   * A-980-R28：单行渲染抽成函数——三个分组各写一份会把「行内边距/图标尺寸/列宽」抄三遍，
   * 改一处漏两处（此前 active/pending/done 三块的 padding 已经不一致）。
   * 三态差异只在：复选框图形、状态图标列、文字色。
   */
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
        {/* 状态图标列：固定 13px，三态对齐（进行中→转子，待办→可点的开始三角，已完成→占位） */}
        {todo.status === "in_progress"
          ? <LoadingCircleIcon size={12} className="icon-spin" style={{ color: "var(--accent)", flexShrink: 0 }} />
          : todo.status === "pending"
            ? <button onClick={() => advanceTodo(todo.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, width: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }} title="标记为进行中"><span className="todo-play">▶</span></button>
            : <span style={{ width: 13, flexShrink: 0 }} />}
        {/* A-980-R32：正文 + **灰化层**。
            灰化层是正文的一份绝对定位副本，用 clip-path 从右往左裁掉，
            与 ::after 那根删除线**同一时长同一缓动** → 视觉上「线扫到哪，灰跟到哪」。
            套一层 .todo-text-inner 是为了让划线/灰化只覆盖**文字实际宽度**，
            而不是 flex:1 撑开的整行宽度（否则线会跑到文字右侧的空白里，与灰化脱节）。
            注：p.todo.content 重复渲染两次是刻意的（层是同一段文字）。 */}
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

  /* 本会话窗口上限的**唯一**本地取值（流式事件下发的权威值优先，其次 Agent/模型解析值）。
     上下文进度条、距压缩余量、会话指标、明细四项构成全部用它 —— 既是数值来源，也是
     **K 进制**的来源（`fmtTokens(n, cap)`）：同屏 token 数必须同进制，否则「64K/512K」
     与「累计 447K」会像两组不相干的量。 */
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
                {/* A-1038：显示**阶段**而不只是百分比 —— 解压期百分比属于另一个口径，
                    只写数字会让用户以为"下载卡在 100% 不动了"。 */}
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
        {/* A-975 修复：会话指标**常驻**。此前 `isStreaming ? <MetricsGrid/> : 占位文本` ——
            空闲时整块数据表消失（只留一行灰字提示），用户两次反馈「右侧边栏会话指标/各项数据又没了」。
            现在始终渲染累计指标；流式期间随本轮输出实时刷新（在途量已并入构成/明细）。 */}
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
          {/* A-980-R28：整块收紧。此前「标题 6px + 进度条 6px + 分组标题 7px 上内边距」叠出
             约 20px 死区，用户反馈"该紧凑的不紧凑，内容离标题有点远了"。 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <button onClick={toggleTodoCollapse} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", padding: 0 }}
              title={collapsedTodos ? "展开待办列表" : "收起待办列表"}>
              {/* A-980-R28：ChevronIcon 基准方向是**右**（路径 d 从上→中→下，是个右尖括号）。
                  所以展开态要转 90° 朝下 ▾，收起态回 0° 朝右 ▸。
                  此前写成 `collapsedTodos ? 90 : 0` 恰好反了——用户实测"展开时箭头朝右、收起时朝下"。
                  全仓其余 ChevronIcon 用法都是 `open ? 90 : 0`，这里对齐同一约定。 */}
              <ChevronIcon rotate={collapsedTodos ? 0 : 90} size={12} style={{ color: "var(--text-muted)" }} />
              <TaskIcon size={13} style={{ color: "var(--text-muted)" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>待办任务</span>
              {sessionReady && todos.length > 0 && (
                todoPct === 100
                  ? <TodoCountChip text="全部完成 ✓" tone="success" />
                  : <TodoCountChip text={`${todoDone}/${todos.length}`} tone="accent" />
              )}
            </button>
            {/* A-986：恢复「清空」入口。
                A-980-R32 曾以"自动清空已覆盖"为由删掉它 —— 实践证伪：自动清空只覆盖
                **全部 completed** 这一种终态；清单里混进"莫须有的任务"（模型写歪 / 旧会话串味 /
                手滑加错）时，用户既删不掉（行尾 ✕ 也删了）也清不了，只能看着它一直挂着。
                用户诉求："你给我彻底优化这个待办任务的清除逻辑"。 */}
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
          {/* A-1015：常驻 + 高度插值。此前是 `{!collapsedTodos && …}`，收起瞬间卸载 → 生硬跳变。
              ⚠️ 三层结构必需：.collapse(grid 容器) > 纯 div(grid 行, 负责 overflow 裁切) > 原内容。
              role="list" 那一层自己还有 maxHeight:220 + overflowY:auto，与 grid 行的 overflow 不冲突。 */}
          <div className={`collapse${collapsedTodos ? "" : " is-open"}`}>
            <div>
              <div role="list" style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 220, overflowY: "auto", marginBottom: 5 }}>
                {/* A-980-R28：会话未就绪只给一句中性提示，不渲染任何数据 */}
                {!sessionReady && <div className="tree-hint" style={{ padding: "4px 0", fontSize: 11.5 }}>正在加载会话…</div>}
                {sessionReady && todos.length === 0 && <div className="tree-hint" style={{ padding: "4px 0", fontSize: 11.5 }}>暂无任务 — Agent 规划后会自动显示，也可手动添加</div>}
                {/* 分组顺序固定：进行中 → 待办 → 已完成（完成项沉底，见 index.css 注释里的 GOV.UK 研究发现）。
                    分组标题**只在出现两种以上状态时**才显示：同状态一堆任务时标题纯属占高。 */}
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

        {/* A-937：上下文消耗进度条 + token 构成 + 明细折叠（取代原"Metrics 下明细 / 已用 标签位"） */}
        <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          <ContextWindowBar
            used={liveUsed}
            cap={capNow}
            // A-974：距压缩余量 = 触发阈值(cap×ratio) - 当前占用（真实同源；旧值为硬编码 0 → 恒显"距压缩 0"，误导）
            compressCount={(() => {
              if (capNow <= 0 || liveUsed <= 0) { return 0; }
              const thr = capNow * acRatio;
              return Math.max(0, Math.round(thr - liveUsed));
            })()}
            // A-975：阈值刻度线与设置里的触发占比同源（改设置立即跟随）
            thresholdPct={Math.round(acRatio * 100)}
            compose={{
              promptTokens: usage.promptTokens,
              // A-974-R6：把本轮在途输出估算并入构成条 —— 流式期间构成微条/明细同步增长
              completionTokens: usage.completionTokens + liveTurn.reply,
              reasoningTokens: usage.reasoningTokens + liveTurn.reason,
              cacheReadTokens: usage.cacheReadTokens,
              // A-1095：输入侧去重方向由协议语义决定（OpenAI 系 prompt 已含命中）
              cacheReadInPrompt: usage.cacheReadInPrompt,
            }}
            buckets={liveBuckets}
            detailOpen={detailOpen}
            onToggleDetail={() => setDetailOpen((v) => !v)}
          />
          {/* A-1015：明细块从 `{detailOpen && …}` 改为**常驻 + 高度插值**。
              此前展开明细会让这张卡**当场变高**（用户："卡片还会伸长，这不能在同一个地方控制"），
              收起时又是瞬间塌陷。现在整块走 .collapse，卡片高度连续伸展/收缩。 */}
          <div className={`collapse${detailOpen ? " is-open" : ""}`}>
            <div>
              <UsageBreakdown usage={usage} live={liveTurn} detailOpen={detailOpen} cap={capNow} onToggleDetail={() => setDetailOpen((v) => !v)} />
            </div>
          </div>
        </div>

        {/* A-937：分隔线 + 活动记录 / 会话文件 并列 tab（横向收纳）
            A-980-R14：活动记录区**独立滚动**（flex:1 + 内容容器 overflow-y:auto），
            不再把滚动绑定到整个右侧栏 */}
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
                  /* A-1018/A-1028：行首符号槽位**只有一种**写法。
                     工具事件 → 该工具自己的图标（与思考历程的工具卡同源映射）；
                     终端状态（done）→ `b.Icon`。两者都走 `.task-badge .task-badge-icon`
                     的同一尺寸/圆角/软底色槽位 —— 此前 `done` 走的是"透明底 + 13px + 不挂
                     .task-badge"的旁路，于是同一列里它既更大、又自带一块实心绿底，与上下行
                     的单色小图标不是一套语言（用户截图："改一下图标颜色风格，要求与上面符号一致"）。 */
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

// SubAgentsTab 已移除（A-978：子代理入口统一走监测栏按钮）

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

function ContextWindowBar({ used, cap, compressCount, compose, buckets, detailOpen, onToggleDetail, thresholdPct = 80 }: {
  used: number; cap: number; compressCount: number;
  /** A-937：token 构成（四项累计）→ 进度条下方 4 色构成微条 + 图例，让"已用"不再是黑盒 */
  compose?: { promptTokens: number; completionTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheReadInPrompt?: boolean };
  /** A-939：上下文分桶（按注入来源切分，对齐 Cursor Context Buckets 理念） */
  buckets?: CtxBuckets;
  detailOpen?: boolean; onToggleDetail?: () => void;
  /** A-975：自动压缩触发占比（0-100）——进度条上的阈值刻度线必须**跟随设置**。
   *  此前写死 left:80% + 标签"80%"，用户在设置里改 60%/70% 后刻度线纹丝不动（用户实测 bug）。 */
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
  // token 构成占比（经 contextMath 纯函数，F 单测锁定）
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
        {/* A-975：压缩触发阈值刻度线——位置与标签都跟随设置的 ratio（不再写死 80%） */}
        <div aria-hidden style={{ position: "absolute", left: `${Math.max(0, Math.min(100, thresholdPct))}%`, top: 0, bottom: 0, width: 1, background: "rgba(139,148,158,0.75)" }} />
        <div style={{ position: "absolute", left: 2, top: -18, fontSize: 10.5, color: color, fontWeight: 700 }}>{pctLabel}%</div>
        <div style={{ position: "absolute", right: 4, top: -18, fontSize: 10.5, color: "var(--text-muted)", fontWeight: 600 }} title="自动压缩触发阈值（设置 → 通用 → 上下文自动压缩）">{thresholdPct}% 压缩</div>
        {pct > 0 && <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 999, transition: "width .25s ease" }} />}
      </div>
      {/* A-937：token 构成微条（四项占比）——"已用"不再是黑盒 */}
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
      {/* A-939：上下文分桶（按注入来源）——"已用"各来源细目，对齐 Cursor Context Buckets 理念 */}
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
          {/* A-1015：字符箭头 ▶ 换成图标库 ChevronIcon（= chevron-right.svg 原样），
              旋转节拍由组件自带（走全局 --collapse-dur），不再自写 transition .2s。 */}
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
  /** A-975：本轮在途量（正文/思考 token + 已耗时）——流式期间「运行时间 / 累计 tokens」也随之走字，
   *  不再整轮只在 done 跳一次（用户反馈"各项数值刷新慢"）。 */
  live?: { reply: number; reason: number; elapsedMs: number };
  /** A-990-D：「通用」设置里手选的消费币种；`auto` = 沿用下面的成本占比推断 */
  pref?: LedgerCurrencyPref;
  /** 本会话窗口上限 —— 只为**选 K 进制**（512K 还是 524K 读法由它定）。
   *  同一块面板里所有 token 数必须传同一个 cap，否则同屏出现两种进制。 */
  cap?: number;
}): JSX.Element {
  const liveReply = live?.reply ?? 0;
  const liveReason = live?.reason ?? 0;
  const liveElapsed = live?.elapsedMs ?? 0;
  const inFlight = liveReply > 0 || liveReason > 0 || liveElapsed > 0;
  // A-1095：累计口径与侧栏明细**同源**（usageComposition）—— 旧实现把四项子集直接相加
  // （reasoning ⊂ completion、cacheRead ⊂ prompt），「累计 tokens」因此虚高。
  const cum = usageComposition({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens + liveReply,
    reasoningTokens: usage.reasoningTokens + liveReason,
    cacheReadTokens: usage.cacheReadTokens,
    cacheReadInPrompt: usage.cacheReadInPrompt,
  });
  // 命中率分母 = **输入侧总量**（Anthropic 系 input 不含 cache，直接除 prompt 会低估命中率）
  const cacheHit = cum.inputSide > 0 ? (cum.cacheRead / cum.inputSide) * 100 : 0;
  /*
   * A-990：会话总账币种**由模型所属地决定**（用户指令），不用一个全局常量拍板。
   *
   * 规则：看这笔账的钱主要花在**哪个归属地**的模型上 —— 国内厂商的模型占多数就用 ¥ 显示，
   * 否则用 $。为什么按成本占比而不是"最后一个模型"：一个会话中途换模型很常见，
   * 按最后用过的那次会让总账币种在切模型时来回跳；按成本占比则稳定反映"这笔账主要付给谁"。
   * 成本为 0 时该单元格显示"—"，不涉及币种。
   *
   * ⚠️ 这里**绝不**再出现硬编码汇率：旧实现是 `costUsd * 7.25`（还写成 toFixed(4)），
   * 既与共享层 `USD_CNY_RATE`(7.2) 打架，又把 ¥12.30 印成 ¥12.3000。
   * 现在折算走 `convertFromUsd`（唯一出处）、格式走 `formatMoney`（去尾零）。
   */
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
  /** A-974-R6：本轮在途输出估算（正文/回复 + 思考），并入明细让数值随流式刷新 */
  live?: { reply: number; reason: number };
  detailOpen: boolean; onToggleDetail: () => void;
  /** 本会话窗口上限 —— 见 `MetricsGrid.cap` 的说明（同一面板同一进制） */
  cap?: number;
}): JSX.Element {
  const liveReply = live?.reply ?? 0;
  const liveReason = live?.reason ?? 0;
  // A-1095：构成算术**只有一个产地**（`contextMath.usageComposition`，判据与记账层
  // `computeRecordCost` 同源）。旧实现在这里手写 `prompt + reply + reasoning + cache`，
  // 把两个**子集**（缓存读 ⊂ 输入、思考 ⊂ 回复）又加了一遍 → 合计虚高约 86%
  // （用户截图实测明细合计 17,007,635，真实约 8.96M）；图例还把缓存读错标成「其他」。
  const c = usageComposition({
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens + liveReply,
    reasoningTokens: usage.reasoningTokens + liveReason,
    cacheReadTokens: usage.cacheReadTokens,
    cacheReadInPrompt: usage.cacheReadInPrompt,
  });
  /** 提示词里**未命中**的部分（互斥切片 = 输入侧 − 缓存读） */
  const missInput = Math.max(0, c.inputSide - c.cacheRead);
  /** 回复里**可见**的部分（互斥切片 = 输出侧 − 思考） */
  const visibleOut = Math.max(0, c.outputSide - c.reasoning);

  const C_PROMPT = "#56d4dd";
  const C_REPLY = "#a371f7";
  const C_REASON = "#d29922";
  const C_CACHE = "#3fb950";

  const pctOf = (n: number): number => (c.total > 0 ? (n / c.total) * 100 : 0);
  const pct = (n: number): string => `${n.toFixed(0)}%`;
  const dashOr = (n: number): string => (n === 0 ? "—" : fmtTokens(n, cap));
  /** 「其中」子行的缩进 + 弱化样式（子项已计入父项，不重复计入合计） */
  const subRow: React.CSSProperties = { paddingLeft: 12, color: "var(--text-muted)" };
  const numStyle: React.CSSProperties = { fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", fontWeight: 600 };

  return (
    <div>
      <div style={{ borderRadius: 6, background: "var(--input-bg, #161b22)", border: "1px solid var(--border)", padding: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8 }}>Token 构成</div>
        {/* A-1095：四段**互斥**（和恒为 100%）—— 缓存读从「提示词」里切出来、思考从「回复」里切出来，
            而不是各自再占一份。旧实现四段共用"含子集"的分母，条长与合计都不守恒。 */}
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
      {/* A-1015：此处**去掉** detailOpen 门控。本组件只在 detailOpen=true 时被渲染
          （外层 ContextWindowBar 那一层已由 .collapse 门控），所以原来的 `{detailOpen && …}`
          在此恒为真；若保留，"点明细收起"时这段高度会瞬间归零、外层插值目标突变 → 动画跳。 */}
      <div style={{ marginTop: 6, borderRadius: 4, background: "rgba(139,148,158,0.06)", border: "1px solid var(--border)", padding: "8px 10px", fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.65 }}>
        {/* A-1095：**两层结构**（父项 = 侧别总量 / 子项 = 其中）。这样"合计"的算式一眼可核：
            合计 === 输入 + 输出，缓存读与思考是**被包含**的，不再各自再占一行相加。 */}
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

/* ═══════════════ 终端 ═══════════════ */

/* ═══════════════ 终端（A-1139 全面重写） ═══════════════
 *
 * ## 用户实测反馈（2026-10-01）
 * 「内置终端体验很差……**我本地部分代码都无法适配**，你给我全面优化一下，**适配现在终端的所有
 *   样式**，可以在使用时**自适应直接接入主机本地终端的各个组件**」—— 对标 VS Code 的终端下拉
 *   （PowerShell 7 / Windows PowerShell / 命令提示符 / WSL 发行版 / Developer Command Prompt for VS /
 *   Developer PowerShell for VS / Git Bash）。
 *
 * ## 三个根因与对应修法
 *  ① **永远是 cmd**：旧实现是主进程 `exec(cmd)` —— 平台默认 shell，用户装的是 PowerShell 7、
 *    WSL、Git Bash，一个都用不上 ⇒ 现在下拉选（探测 + 判据全在主进程）。
 *  ② **中文乱码**：`exec` 把输出按 UTF-8 解，而中文 Windows 控制台是 CP936(GBK) ⇒
 *    主进程改用 `decodeBytes`（严格 UTF-8 试起，失败退 GB18030）。
 *  ③ **满屏转义垃圾 / 进度条刷屏**：旧实现把 `\x1b[32m`、`\x1b[K` 原样打印 ⇒ 现在按
 *    `parseAnsi` 渲染颜色，剥掉光标控制序列（我们不是终端模拟器，留着只会显示成垃圾字符）。
 *
 * ## cwd：**主进程定事实，渲染层只存缓存**
 * 一次性进程模型下 shell 记不住 cwd（`cd src` 然后 `ls` 会跑在原目录）。现在主进程从每条命令
 * 推导"下一条该在哪儿"（`resolveCd` + 存在性校验），并经 `TermResult.cwd` 回带 ——
 * 渲染层拿到什么就存什么，**不做任何推导**（算错的 cwd 会让命令静默跑错目录，比不延续更糟）。
 *
 * ## 降级必须看得见（铁律 31）
 * 超时 / 输出截断 / 编码兜底 / 工作目录被拒 —— 全部经 `TermResult.notice` 显示成一行
 * `notice`。旧实现超时返回 `ok:true` + 部分输出 ⇒ 用户以为命令正常结束了，这是最坑的一条。
 */

/** 终端输出 → 带样式的行（**纯函数**，可被守卫直接断言，不必驱动组件渲染）。 */
function termOutputLines(raw: string, kind: "out" | "err"): TermLine[] {
  const parts = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  /* 末尾换行会切出一个空元素 —— 它表示"输出到此为止"，不是"一行空行"。 */
  if (parts.length > 0 && parts[parts.length - 1] === "") { parts.pop(); }
  const out: TermLine[] = [];
  for (const line of parts) {
    const spans = parseAnsi(line);
    /* 纯控制序列行（进度条的擦除/光标移动帧）⇒ `parseAnsi` 给空数组 ⇒ **跳过**。
       ⚠️ 与"真正的空行"区分：空行 strip 后也是空串，但**原串本身为空** ⇒ 空行要保留
       （输出里的空行是排版信息，全丢掉会很挤）。 */
    if (spans.length === 0 && line.length > 0) { continue; }
    out.push({ kind, text: stripAnsi(line), spans });
  }
  return out;
}

/** ANSI 片段 → 内联样式。色值来自 `ansi.js` 的标准 16 色 / 256 色表（不在渲染层另立一份）。 */
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
  /** A-1139：主机本地终端组件清单（下拉数据源；**主进程是唯一产地**）。 */
  const [profiles, setProfiles] = React.useState<TermProfile[]>([]);
  const [profilesErr, setProfilesErr] = React.useState("");
  const [profileId, setProfileId] = React.useState("");
  /** A-1139：当前工作目录。**只是缓存** —— 真值由主进程经 `TermResult.cwd` 回带。 */
  const [cwd, setCwd] = React.useState(props.workspace ?? "");
  /** 最近一次输出的编码（非 utf-8 时在标题栏显示一个提示芯片）。 */
  const [encHint, setEncHint] = React.useState<{ encoding: string; loose: boolean } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => { const el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; } }, [lines]);

  /* 探测主机本地终端组件。⚠️ `alive` 令牌：异步回来时组件可能已卸载（切走终端页）。 */
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
        /* 判别联合的失败分支必须显示 —— 静默空列表会被读成"这台机器没有终端"。 */
        setProfilesErr(res?.error || "无法获取终端配置（终端桥不可用）");
        return;
      }
      const list = res.profiles ?? [];
      setProfiles(list);
      setProfilesErr("");
      let saved = "";
      try { saved = localStorage.getItem(TERM_PROFILE_KEY) ?? ""; } catch { /* 隐私模式等忽略 */ }
      /* 上次选的 shell 可能已经不在了（换机器 / 卸载了 PowerShell 7）⇒ 退到默认，
         但**用户看得见**：标题栏显示的就是当前 profile 名。 */
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

  /* 切换 shell：写回偏好 + 明确回显（否则用户点了下拉却看不出变化 —— 命令跑在哪个 shell 里
     唯一的可见证据就是这一行）。
     ⚠️ 用 ref 跳过"首次自动选中"那一次：它不是用户动作，不该打印一行提示。 */
  const profileInitRef = React.useRef(true);
  React.useEffect(() => {
    if (!profileId) { return; }
    try { localStorage.setItem(TERM_PROFILE_KEY, profileId); } catch { /* 忽略 */ }
    if (profileInitRef.current) { profileInitRef.current = false; return; }
    const p = profiles.find((x) => x.id === profileId);
    if (!p) { return; }
    setLines((prev) => [...prev, { kind: "info", text: `已切换到 ${p.label}${p.detail ? "（" + p.detail + "）" : ""}` }]);
  }, [profileId, profiles]);

  /* 工作区变了 ⇒ cwd 回到工作区（否则会停在上一个工作区的目录里）。 */
  const wsRef = React.useRef(props.workspace ?? "");
  React.useEffect(() => {
    const ws = props.workspace ?? "";
    if (ws === wsRef.current) { return; }
    wsRef.current = ws;
    setCwd(ws);
  }, [props.workspace]);

  /* A-1121（②）：Agent 让「打开终端并预填某条命令」。按 **nonce** 而不是命令文本触发 ——
     同一条命令被再次要求预填时（用户刚清空输入框），只比文本的话这里会毫无反应。
     ⚠️ 只填进输入框，**不自动执行**：回车是用户的动作。 */
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
      /* ⚠️ 非致命说明必须显示（超时 / 截断 / 编码兜底 / cwd 被拒）——见组件头部注释的第 4 条。 */
      if (res.notice) { extra.push({ kind: "notice", text: res.notice }); }
      if (typeof res.code === "number" && res.code !== 0) { extra.push({ kind: "info", text: `退出码 ${res.code}` }); }
      if (outLines.length === 0 && errLines.length === 0 && extra.length === 0) {
        extra.push({ kind: "info", text: `（无输出，退出码 ${res.code ?? "?"}）` });
      }
      setLines((prev) => [...prev, ...outLines, ...errLines, ...extra]);
      /* cwd 以**主进程回带值**为准（它可能因 `cd` 而变，也可能被校验拒掉）。 */
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
        {/* A-1139：主机本地终端组件下拉（对齐 VS Code 的终端下拉）。 */}
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
      {/* 探测失败/无 shell 时必须说出来 —— 否则"终端打不开"会变成一件没有解释的事。 */}
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

/* ═══════════════ 浏览器（独立实例） ═══════════════ */

/* A-1018：错误码 → 可读标题/建议 的实现已移到 `./browserErrors.ts`（纯逻辑不许住 .tsx），
   并把旧表里两个错项修正（-130 不在证书段、-201 实为 ERR_CERT_DATE_INVALID）。
   全页错误页见下方 `BrowserTabInstance` 的 `.browser-error-page`。 */

/* ── 站点"新建页跳转"（A-975-R3：**已撤掉注入脚本，回归纯原生**）────────────────────────────
 * 历史：这里曾注入一段脚本，把 `window.open` 整个覆盖成"永远 return null"，并在捕获阶段
 * `stopPropagation` 拦截 `a[target=_blank]` 点击（用 location.href=slime:// 桥接宿主新建页）。
 * 后果（用户实测）：
 *   ① 覆盖 window.open 会打断站点自身逻辑（登录/阅读器/播放器都靠 `window.open` 的返回值做后续处理）
 *      → "网页里很多地方点不动"；
 *   ② 捕获阶段吞掉点击 → 站点的 SPA 路由/埋点一起失效；
 *   ③ 任何一处抛错都发生在**站点的事件处理栈里** → 整页交互看起来"死了"。
 * 结论：**不再向页面注入任何东西、不改站点全局、不拦站点事件**。
 * 新窗口/新标签页统一由主进程 `setWindowOpenHandler`（app.on("web-contents-created") 覆盖所有 guest）
 * 接住并派发 `slime:sidebar:open` → 右栏新建浏览器页。这是 Electron 的官方机制，且完全在宿主侧，
 * 站点与我们互不干扰；webview 的 `new-window` 监听只用于**非 Web 协议**的确认/诊断。 */

function BrowserTabInstance(props: {
  tabId: string;
  url: string;
  active?: boolean;
  /**
   * A-1137：**空白页的默认首页**（搜索页地址）。只在 `url` 为空时生效。
   * ⚠️ **不回写** `tab.url` —— 回写会让 `openBrowserTab` 的「复用空白页」判据（`!t.url`）
   * 永远找不到空白页，于是每打开一个链接就多一个页签（那是全仓多处共用的兜底逻辑，不能为了这一处改掉）。
   */
  homeUrl?: string;
  /** A-1137：guest preload 的 `file://` 路径（搜索页宿主桥）。空串 = 没有桥（页面会"能看但搜不动"）。 */
  preload?: string;
  /** A-1137：搜索页**交付失败**的原因（非空 = 首页用不了，必须让用户看见，不能静默空白）。 */
  homeError?: string;
  onUrlChange: (url: string) => void;
  onTitleChange?: (title: string) => void;
}): JSX.Element {
  const webviewRef = React.useRef<HTMLElement | null>(null);
  /** A-975-R5：guest 崩溃是否已自动救过一次（防止"崩溃→重载→再崩溃"死循环） */
  const goneHandledRef = React.useRef(false);
  /** A-975-R6：最近一次已上报的页面标题（去重，避免重复 setState） */
  const titleRef = React.useRef("");
  const [inputUrl, setInputUrl] = React.useState(props.url ?? "");
  const [navUrl, setNavUrl] = React.useState("");
  const [canBack, setCanBack] = React.useState(false);
  const [canFwd, setCanFwd] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(false);
  /** A-980-R3：加载失败提示（did-fail-load）——不再白屏无反馈（如 http://127.0.0.1:8081 连不上） */
  const [failInfo, setFailInfo] = React.useState<{ url: string; code: number } | null>(null);
  /* A-1137：空白页本该自动显示搜索页。**没显示成**时要如实说明 ——
     否则"新建浏览器页是一片空白"就变成一件没有解释的事（静默降级 = 用户以为功能没做）。
     ⚠️ 刻意**提到组件顶部**（不在 JSX 里现算）：占位页那段 JSX 的形状被 A-1045 守卫锚着
     （它要求 `!active && !failInfo` 就是紧挨 `<div className="browser-blank">` 的条件），
     在 JSX 里塞一个 IIFE 会让那段锚取不到条件 —— 保持形状，改派生值的位置。
     ⚠️ 判据是"这一页没有自己的 url 且有交付错误"：用户自己输了网址进来时，这条提示与他无关。 */
  const homeFailed = !!props.homeError && !(props.url ?? "").trim();

  // A-979：非激活浏览器页显式开启后台节流（display:none 时 Chromium 的动画/定时器/合成降速，
  // 避免后台页持续全速吃 GPU/CPU；卸载时随 webview 销毁自动清理）
  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    if (!wv) { return; }
    // setBackgroundThrottling 不在 WebviewTag 类型上（Electron 类型滞后），运行时守卫后调用
    const throttle = (wv as unknown as { setBackgroundThrottling?: (v: boolean) => void }).setBackgroundThrottling;
    if (typeof throttle !== "function") { return; }
    try { throttle.call(wv, props.active !== true); } catch { /* 忽略 */ }
  }, [props.active]);

  // A-173 / A-976：外部（聊天链接、自动打开、多页切换）修改 url 后自动导航。
  // 以前只在 props.url 为真值时同步 → 新建的空浏览器页会残留上一页的 navUrl（"两页绑定"的另一半原因）。
  // 现在按"设置 or 清空"双向同步；且每个浏览器页是独立组件实例（渲染处已加 key），互不干扰。
  /* A-1137：**有效目标 = 页签自己的 url，没有就用默认首页（搜索页）**。
     ⚠️ `homeUrl` 是异步来的（要问主进程）⇒ 它**必须**进依赖数组，否则"问回来了但没导航"。
     ⚠️ 这里读的是 `props.homeUrl`，**从不写回** `tabs[].url`（见 `props.homeUrl` 的注释）。 */
  const effectiveUrl = (props.url ?? "").trim() || (props.homeUrl ?? "").trim();
  React.useEffect(() => {
    // A-980-R6：统一归一 URL（裸地址补 http://）——与 go()/onOpen 一致，杜绝无 scheme 进 src
    const next = normalizeBrowserUrl(effectiveUrl);
    // A-979-R2：忽略空值与 about:blank 占位——webview 初始 src=about:blank 的 did-navigate
    // 会把 tabs 里的 url 污染成 about:blank（再经本 effect 把 navUrl 拉回 → 真实导航被顶掉 → 白屏）
    if (!next || next === "about:blank") { return; }
    // A-980：非 Web 协议（bitbrowser:// 等）不进 navUrl（直接进 src 会触发系统弹窗）
    if (!isWebNavUrl(next)) { return; }
    if (next === navUrl) { return; }
    setInputUrl(next);
    setNavUrl(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveUrl]);

  /* A-980-R7：**命令式导航**（不再受控 src）——Electron 官方文档明确 webview 基于 Chromium OOPIF、
   * 渲染与导航存在已知不稳定问题，`src` 属性写入才触发导航；而 React 受控 src 在「新建页首次挂载
   * frame 内立刻改 src」的时序下存在竞态（webview 内部尚未 attach，src 更新不触发 loadURL → 白屏；
   * 手动输入 go() 时 webview 已就绪所以正常——这正是用户实测"点链接新建页白屏、手输能进"的机制）。
   * 业界的稳妥做法是**不依赖受控 src**，改为 webview 就绪后显式调 `loadURL`，并以 `did-attach`
   * 兜底（attach 表示 guest 进程已就绪，此时 loadURL 必生效）。webview 的 src 恒为 about:blank 占位，
   * 所有导航（链接点击 / 地址栏 go() / props.url 同步）统一由 navUrl → forceNav() 落地。 */
  const navUrlRef = React.useRef("");
  React.useEffect(() => { navUrlRef.current = navUrl; }, [navUrl]);
  /* A-1133：**导航失败账本 + attach 标记** —— 「无休止报错」的结构性闸门（判据在 webviewNav.ts）。
     事故：拖入 .docx ⇒ 目标地址注定加载失败 ⇒ 安全网/地址写回每 300ms 重发一次，永远刷屏。 */
  const navFailBookRef = React.useRef<NavFailureBook>(new Map());
  const wvAttachedRef = React.useRef(false);
  const forceNav = React.useCallback((): void => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    const next = navUrlRef.current;
    if (!wv || !next) { return; }
    try {
      // 已是目标地址则跳过（防与 did-navigate 写回互相循环触发）
      const cur = typeof wv.getURL === "function" ? wv.getURL() : "";
      if (cur === next) { return; }
      /* A-1133：**判死的地址不再自动重发**（唯一判据）。少问这一句，就是这次的"无休止刷屏"。 */
      if (!navAutoLoadAllowed(navFailBookRef.current, next, "url-change", wvAttachedRef.current)) { return; }
      /* A-1106b：换成唯一安全出口 —— 旧写法 `wv.loadURL(next)` 的异步 reject 接不住，
         Electron 会把它当未捕获异常打印（调试面板反复刷 GUEST_VIEW_MANAGER_CALL / ERR_ABORTED）。 */
      safeLoadURL(wv, next);
    } catch { /* getURL 未 attach 时会同步抛，did-attach 兜底重试 */ }
  }, []);
  // navUrl 变化（链接点击 / go() / props.url 同步）→ 命令式导航
  React.useEffect(() => { forceNav(); }, [forceNav, navUrl]);

  /* A-980-R9：把 `did-attach` 兜底监听**提前到 ref callback 注册**——修 A-980-R7 引入的回归。
   * 根因：R7 把 webview 的 src 固定为 about:blank、一切导航依赖命令式 loadURL 后，唯一兜底是
   * `did-attach`；但该监听原来注册在 useEffect（React 在浏览器 **paint 之后**才执行），而 webview
   * guest 进程的 attach 是异步 IPC——attach 极快时会**先于 useEffect 触发** did-attach → 兜底监听
   * 永久丢失，且 attach 前的 loadURL 抛 "must be attached to the DOM" 被静默吞掉 → 新建页/点链接
   * 卡死在 about:blank（用户实测"点不了了"，手动输入 go() 时 webview 已就绪所以正常）。
   * ref callback 在 React commit 阶段**同步**执行（DOM 元素插入即调用），必然早于 guest attach 的
   * 异步完成 → did-attach 必不丢失；同时元素入 DOM 后立即尝试一次 forceNav（未 attach 被拒则由
   * did-attach / 安全网兜底）。 */
  const setWvRef = React.useCallback((el: HTMLElement | null) => {
    const prev = webviewRef.current;
    if (prev && prev !== el) {
      try { (prev as unknown as Electron.WebviewTag).removeEventListener?.("did-attach", forceNav); } catch { /* 忽略 */ }
    }
    webviewRef.current = el;
    if (!el) { return; }
    // A-975-R6：`allowpopups` 兜一层显式 setAttribute（必须在 guest attach 前生效；ref 回调在 commit 阶段执行）
    try { el.setAttribute("allowpopups", "true"); } catch { /* 忽略 */ }
    try { (el as unknown as Electron.WebviewTag).addEventListener?.("did-attach", forceNav); } catch { /* 忽略 */ }
    forceNav();
  }, [forceNav]);

  // A-980-R9：导航安全网——webview 常驻挂载下，任何单一事件（did-attach / navUrl effect）都可能因
  // Electron OOPIF 的异步时序错过；300ms 周期的轻量检查兜底：只要 webview 仍处于初始 about:blank
  //（首帧竞态窗口，顶层导航尚未打通）且存在期望地址，就命令式 loadURL，直到 attach 后成功。
  // ★ 一旦 getURL 离开 about:blank（顶层导航已落地）立即停止干预——否则 SPA 页内 pushState 改址后
  // cur≠navUrl 会被误判"未落地"而每 300ms 强制 loadURL 回初始页，把正在浏览的页内状态弹回（新引入
  // bug）。之后的导航（二次 go() / SPA 内跳转）由 forceNav 与 did-navigate 写回负责，均同步生效。
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
      const next = navUrlRef.current;
      if (!wv || !next) { return; }
      try {
        const cur = typeof wv.getURL === "function" ? wv.getURL() : "";
        if (cur && cur !== "about:blank") { return; }
        /* A-1133：安全网**也必须**问锁存 —— 它是"无休止刷屏"的第二条通路。
           判据里还包含「guest 已 attach 就不再由安全网发」（那已越过它的职责窗口：它只服务
           首帧 attach 竞态）。这两条合起来才把"永远失败、永远重发"关掉。 */
        if (!navAutoLoadAllowed(navFailBookRef.current, next, "net", wvAttachedRef.current)) { return; }
        /* A-1106b：安全网每 300ms 会重发 —— 若不接住 reject，-3 会被漏成「反复刷屏」的主产地 */
        safeLoadURL(wv, next);
      } catch { /* 未 attach → 下一轮再试 */ }
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    // A-976 修复：**不再要求 navUrl 非空**——webview 已改为常驻挂载（空白页 src=about:blank），
    // 否则"新建的空白浏览器页"没有 webview → Agent 无法在其上做任何操作（只能导航）。
    if (!wv) { return; }
    registerWebview(props.tabId, wv);
    return () => { unregisterWebview(props.tabId); };
  }, [props.tabId]);

  React.useEffect(() => {
    const wv = webviewRef.current as unknown as Electron.WebviewTag | null;
    if (!wv) { return; }
    // A-979-R2：过滤 about:blank 的 did-navigate——webview 初始 src=about:blank 的加载完成事件
    // 若被同步到地址栏/tabs，会把真实导航（如 douyin.com）顶成 about:blank → 白屏 + 网址栏错乱。
    const onNav = (e: Electron.DidNavigateEvent): void => {
      if (!e.url || e.url === "about:blank") { return; }
      setInputUrl(e.url); setActive(true); props.onUrlChange(e.url);
    };
    // A-980-R7：guest 进程 attach 完成（webview 就绪）→ 若此时已有期望地址（新建页链接），
    // 命令式 loadURL 兜底（受控 src 的首次挂载竞态用 did-attach 保证必导航）
    // A-1133：attach 是**一次性时序标志** —— 安全网据此停手（它只服务 attach 前的首帧竞态）
    const onAttach = (): void => { wvAttachedRef.current = true; forceNav(); };
    const onInPage = (e: Electron.DidNavigateInPageEvent): void => {
      if (!e.url || e.url === "about:blank") { return; }
      setInputUrl(e.url);
    };
    const onStart = (): void => { setLoading(true); setFailInfo(null); };
    /* A-975-R6：**页签名跟随页面标题**（此前完全没有监听 → 站内跳转/SPA 换题后页签名永不更新，
     * 新建页也只有域名）。用 ref 比对去重，避免同一标题反复 setState 触发无谓重渲染。 */
    const onTitle = (e: { title?: string }): void => {
      const t = (e?.title ?? "").trim();
      if (!t || t === titleRef.current) { return; }
      titleRef.current = t;
      props.onTitleChange?.(t.length > 28 ? `${t.slice(0, 28)}…` : t);
    };
    /* A-975-R4/R5：**guest 进程崩溃/OOM 自动恢复**（每个页签只自动救一次）。
     * 页面渲染进程挂掉时画面停在最后一帧、点什么都没反应。
     * ⚠️ 必须一次性：若站点自身稳定崩溃，反复 reload 会变成"永远在重载 → 看起来还是点不动"的循环。 */
    const onGone = (): void => {
      const cur = navUrlRef.current;
      setLoading(false);
      if (!cur || goneHandledRef.current) { return; }
      goneHandledRef.current = true;
      try {
        window.setTimeout(() => { try { (webviewRef.current as unknown as Electron.WebviewTag | null)?.reload(); } catch { /* 忽略 */ } }, 400);
      } catch { /* 忽略 */ }
    };
    const onStop = (): void => {
      setLoading(false); setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward());
      // A-975-R3：**不再注入任何脚本**（见文件上方 NEWTAB_HOOK 撤除说明）——
      // 新窗口/新标签页改由主进程 setWindowOpenHandler 统一接住派发，站点侧零侵入。
    };
    // A-980-R3：加载失败可见化（ERR_CONNECTION_REFUSED 等）——过滤 about:blank/-3(ABORTED 重定向)误报
    /* A-1021：**字段名修复**——原实现读 `e.url`，但 Electron 的 `DidFailLoadEvent` 只有
     * `{ errorCode, errorDescription, validatedURL, isMainFrame }`（见 electron.d.ts 19838），
     * **根本没有 `url` 字段**。于是 `!e.url` 对每一次真实失败都为真 → onFail 在第一道守卫就
     * return，`setFailInfo` 从未被调用 → 错误页恒不显示（用户实测"网页无法加载时什么都不显示"）。
     * 同理 `errorCode` 是有的，-3/ABORTED 过滤一直生效，只是永远走不到。
     * 教训：手写的事件形状 `{ url?: string }` 看着合理、tsc 也不报错（结构类型 + 可选字段），
     * 但它不是 Electron 的契约 → 必须用官方类型 `Electron.DidFailLoadEvent` 而不是自造接口。 */
    const onFail = (e: Electron.DidFailLoadEvent): void => {
      const url = e?.validatedURL ?? "";
      // about:blank 占位导航、以及 -3(ERR_ABORTED，重定向/主动 abort) 属正常噪声，不上错误页
      if (!url || url === "about:blank" || e?.errorCode === -3) { return; }
      /* A-1133：**把失败记进账本** —— 自动通路（安全网 / 地址写回 / attach 兜底）据此不再重发。
         这是"无休止报错"的终点。记的是**目标地址**（navUrl）而不是失败地址：
         重发是由"目标与当前不一致"驱动的，判死也必须判在那个键上。 */
      noteNavFailure(navFailBookRef.current, navUrlRef.current || url, e?.errorCode ?? 0);
      setFailInfo({ url, code: e?.errorCode ?? 0 });
      setLoading(false);
      setCanBack(wv.canGoBack()); setCanFwd(wv.canGoForward());
    };
    // A-980-R2：自定义协议链接（bitbrowser://、weixin://、mailto: 等）**不再静默拦截**——
    // preventDefault 阻止 Chromium 自己处理（防系统弹「获取打开此链接的应用」），然后探测系统
    // 是否注册了该协议处理器：**已注册 → 交给系统应用真实打开链接**（装了对应客户端即真正生效）；
    // 未注册 → 明确提示「需要安装 xxx 客户端」。「解决报错」而非「屏蔽报错」。
    const onWillNav = (e: Electron.WillNavigateEvent | { url: string; preventDefault: () => void }): void => {
      try {
        const url = (e as { url?: string }).url ?? "";
        if (!url) { return; }
        const scheme = url.split(":")[0].toLowerCase();
        if (scheme === "http" || scheme === "https" || scheme === "about" || scheme === "file" || scheme === "data" || scheme === "blob" || url === "about:blank") { return; }
        e.preventDefault();
        // A-980-R12：注入钩子触发的"新建页跳转"桥（slime://open?u=https%3A%2F%2F…）→ 右栏新建浏览器页
        if (scheme === "slime") {
          try {
            const u = new URL(url).searchParams.get("u");
            if (u && /^https?:\/\//i.test(u)) {
              requestSidebarOpen({ kind: "url", url: u, name: "" });
              return;
            }
          } catch { /* 非标准 slime URL */ }
          // 其余 slime:// 内部跳转保持原行为（交给 onUrlChange 导航）
          props.onUrlChange(url);
          return;
        }
        // 其余非 Web 协议 → **先征求用户同意**（允许/拒绝跳转，A-980-R10）：同意才探测系统处理器并真实打开
        //（已注册→ShellExecute，未注册→诊断缺应用）；拒绝则拦截并轻提示。
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
          } catch { /* 忽略 */ }
        })();
      } catch { /* 忽略 */ }
    };
    // webview 的 will-navigate / will-redirect / new-window 事件：named 引用便于卸载；都是"导航尝试"统一走协议守卫。
    // will-redirect 覆盖**服务端 302/301 跳转**——will-navigate 不会为重定向目标触发，
    // 不少站点（如视频站"打开 App"跳板）就是靠服务端跳转抛 bitbrowser:// 这类未知协议。
    const onWillNavEvent = (e: unknown): void => onWillNav(e as Electron.WillNavigateEvent);
    const onWillRedirect = (e: unknown): void => onWillNav(e as Electron.WillNavigateEvent);
    // A-980-R11：webview new-window 事件签名为 (event, url, ...)——url 在**第二参数**
    //（event 上无 url）。allowpopups 后 guest 的 window.open/target=_blank 会触发本事件。
    // A-975-R3：**Web URL 也在这里兜底开页**（此前只处理非 Web 协议、把 web 全交给主进程
    // setWindowOpenHandler）。两条路传入的是**同一个 url**，渲染层的复用逻辑按「同址优先」命中
    // → 只会有一个页签，不会开两份；主进程那条路若因版本差异没触发，这条也能开出来。
    const onNewWindow = (e: unknown, url?: string): void => {
      try {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          requestSidebarOpen({ kind: "url", url, name: "", from: "site" });
          return;
        }
        if (typeof url === "string" && url) {
          onWillNav({ url, preventDefault: () => { try { (e as { preventDefault?: () => void }).preventDefault?.(); } catch { /* 忽略 */ } } } as Electron.WillNavigateEvent);
        } else {
          onWillNav(e as Electron.WillNavigateEvent);
        }
      } catch { /* 忽略 */ }
    };
    try { (wv as any).addEventListener?.("will-navigate", onWillNavEvent); } catch { /* 忽略 */ }
    try { (wv as any).addEventListener?.("will-redirect", onWillRedirect); } catch { /* 忽略 */ }
    try { (wv as any).addEventListener?.("new-window", onNewWindow); } catch { /* 忽略 */ }
    try { (wv as any).addEventListener?.("did-attach", onAttach); } catch { /* 忽略 */ }
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onInPage);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-fail-load", onFail);
    try { (wv as any).addEventListener?.("page-title-updated", onTitle); } catch { /* 忽略 */ }
    // A-975-R4：guest 崩溃/OOM 自愈（新老两个事件名都挂，版本差异兜底）
    try { (wv as any).addEventListener?.("render-process-gone", onGone); } catch { /* 忽略 */ }
    try { (wv as any).addEventListener?.("crashed", onGone); } catch { /* 忽略 */ }
    return () => {
      try { (wv as any).removeEventListener?.("will-navigate", onWillNavEvent); } catch { /* 忽略 */ }
      try { (wv as any).removeEventListener?.("will-redirect", onWillRedirect); } catch { /* 忽略 */ }
      try { (wv as any).removeEventListener?.("new-window", onNewWindow); } catch { /* 忽略 */ }
      try { (wv as any).removeEventListener?.("did-attach", onAttach); } catch { /* 忽略 */ }
      try { (wv as any).removeEventListener?.("page-title-updated", onTitle); } catch { /* 忽略 */ }
      try { (wv as any).removeEventListener?.("render-process-gone", onGone); } catch { /* 忽略 */ }
      try { (wv as any).removeEventListener?.("crashed", onGone); } catch { /* 忽略 */ }
      wv.removeEventListener("did-navigate", onNav); wv.removeEventListener("did-navigate-in-page", onInPage); wv.removeEventListener("did-start-loading", onStart); wv.removeEventListener("did-stop-loading", onStop); wv.removeEventListener("did-fail-load", onFail);
    };
  }, []);

  const go = (): void => {
    const targetRaw = inputUrl.trim();
    if (!targetRaw) { return; }
    // A-980：未知协议（bitbrowser:// 等）不让它进 webview src（否则系统弹"获取打开此链接的应用"）
    if (!isWebNavUrl(targetRaw)) {
      setInputUrl("");
      return;
    }
    // A-980-R6：统一归一（裸地址补 http://）——此前补 https:// 会把 `127.0.0.1:8081` 这种
    // 本地 IP:端口 错拼成 https（TLS 握手失败白屏），与链接点击路径同规后行为一致。
    let target = normalizeBrowserUrl(targetRaw);
    setNavUrl(target);
  };

  const wv = webviewRef.current as unknown as Electron.WebviewTag | null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%", background: "var(--bg, #fff)" }}>
      <div className="right-pane-head browser-bar" style={{ flexShrink: 0 }}>
        <button className="right-mini-btn" title="后退" disabled={!canBack} onClick={() => { wv?.goBack(); }}>‹</button>
        {/* A-1015：ChevronIcon 基准方向是**右**（= chevron-right.svg 原样），"前进"应为 0°。
            此前写 rotate={90} → 箭头朝下，方向语义错了（同排"后退"用的是字符 ‹ 朝左）。 */}
        <button className="right-mini-btn" title="前进" disabled={!canFwd} onClick={() => { wv?.goForward(); }}><ChevronIcon size={12} rotate={0} /></button>
        <button className="right-mini-btn" title="刷新" disabled={!active} onClick={() => { wv?.reload(); }}><RefreshIcon size={12} /></button>
        <input className="term-input browser-url" value={inputUrl} placeholder="输入网址，回车访问" onChange={(e) => setInputUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { go(); } }} />
        {/* A-1151：用户报「访问按钮是个黄图标」⇒ 换成与「浏览器」菜单同款的放大镜（`SearchIcon`）。
            同一动作在别处都是放大镜，这里用箭头属于"同一个功能两套图标"，容易看错。 */}
        <button className="right-mini-btn" title="访问" onClick={go}><SearchIcon size={13} /></button>
      </div>
      <div className="browser-stage">
        {loading && active && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--accent, #58a6ff)", zIndex: 10 }} />}
        {/* A-1045：**主题色占位页**——guest 还没有真实文档时盖住 Chromium 的白色基底。
            `active` 只由「真实 URL 的 did-navigate」置真（见下方 onNav），所以
            `!active` 恰好等价于「这个浏览器页里目前没有任何真实网页」= 纯白晃眼的那一段时间；
            真实文档落地后占位页自动撤掉，绝不影响正常浏览。
            覆盖层 pointerEvents:none（A-976：任何吃点击的覆盖层都会让 Agent 点不动页面），
            定位/配色走 `.browser-blank`（不在 JSX 写 inline position:absolute —— 静态守卫 ⑬）。
            ⚠️ 本块必须排在上面那条进度条**之后**：进度条是 inline `position:absolute`，而 ⑬ 的
            扫描窗口是「条件行起 8 行内」，排在它上面会被误判成「残留浮层」。
            两者状态互斥（`loading && active` vs `!active`），换序无视觉影响（z-index 才是层级权威）。 */}
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
        {/* A-1018：加载失败 → **整页错误页**（对标主流浏览器：原因 + 网址 + 错误标识 + 建议 + 重试）。
            此前只有一条细红条贴在工具栏下方，下面仍是一整片白 —— 用户原话"打不开的都只会显示白屏，
            不会像现在的浏览器一样弹出无法连接、连接失败等一系列的原因或者标识"。
            定位/配色走 index.css 的 `.browser-error-page`（不在 JSX 写 inline position：
            静态守卫 ⑬ 会把"条件渲染 + inline absolute"当成收起即卸载的残留浮层）。 */}
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
              <button className="btn primary" onClick={() => { /* A-1133：手动重试 = 清掉该地址的失败记录（用户明确意图），否则按钮点了也不会生效 */ clearNavFailure(navFailBookRef.current, navUrlRef.current); setFailInfo(null); try { (webviewRef.current as unknown as Electron.WebviewTag | null)?.reload(); } catch { /* 忽略 */ } }}>重试</button>
              <button className="btn" onClick={() => { void navigator.clipboard?.writeText(failInfo.url).catch(() => undefined); }}>复制网址</button>
            </div>
          </div>
        )}
        {/* A-976：webview **常驻挂载**（空白页用 about:blank）——保证任何浏览器页都可被 Agent 操作，
            且导航不必等 React 重挂载新元素（此前 navUrl 由空变非空才渲染，导致"只能导航不能操作"）。
            A-980-R7：src 固定 about:blank 占位（不再受控），一切导航由 navUrl → forceNav() 命令式 loadURL，
            did-attach 兜底——规避 React 首帧改 src 与 webview attach 的竞态（新建页白屏根因）。 */}
        <WebviewTag
          ref={setWvRef}
          src="about:blank"
          partition="persist:slime-browser"
          allowpopups
          /* 防守性开启（**不是**某个 bug 的修复 —— 实测这版 Electron 开不开都能渲染 PDF，
             见 `WebviewTag` 定义处的长注释：A/B 白纸占比都是 0.641、差 0.0）。 */
          plugins
          /* A-1137：搜索页宿主桥。**必须在首次挂载时就给**（Electron 要求 webview 属性在首次导航前生效）
             ⇒ 父组件等交付信息回来才渲染本组件（见 `searchDelivery === null` 那个分支）。
             ⚠️ 它对**每次导航**都执行，是否真正 expose 由 preload 自己按"本机文档"判。 */
          preload={props.preload || undefined}
          /* A-1045：host 底色也是硬编码 #fff 的残留 —— 改为主题变量，与容器/占位页同色。
             （guest 有真实文档后由站点自己绘制，宿主底色不再可见；它只在 guest 未绘制的那一帧露出来。） */
          style={{ flex: 1, width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
        />
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
        {/* A-1015：旋转交给 ChevronIcon 自己（组件自带 --collapse-dur 节拍）。此前外层 span 还写了
            `rotate(-90deg)` + `transition .15s` → 两层旋转叠加（-90+0 / 0+90），且 .15s 与折叠
            动画 0.45s 不同步，观感是"箭头先转完、内容再长"。 */}
        <ChevronIcon size={10} rotate={props.collapsed ? 0 : 90} style={{ opacity: 0.7, flexShrink: 0 }} />
        <span style={{ fontWeight: 500 }}>{props.title}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--input-bg, #161b22)", borderRadius: 8, padding: "0 6px" }}>{props.files.length}</span>
      </div>
      {/* A-1015：常驻 + 高度插值（此前 `{!props.collapsed && …}` 收起即卸载 → 生硬跳变） */}
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
