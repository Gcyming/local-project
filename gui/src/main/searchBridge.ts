/**
 * gui/src/main/searchBridge.ts — **搜索页宿主桥的唯一产地**（右栏搜索页 ↔ slime 主程序 ↔ 对话侧）。
 *
 * ## 这里承担四件事（都在这一处，避免"同一事实两个产地"）
 * 1. **把搜索页交付给右栏浏览器**：页面正文在**构建期**被 `?raw` 内联进主进程产物
 *    （`apps/local-search-engine/index.html` 是唯一产地，不再有手抄副本），
 *    运行时幂等落到 `userData` 下的固定目录 ⇒ 复用既有 `slime:http:serve` 起本地服务 ⇒
 *    右栏 `<webview src="http://127.0.0.1:PORT/">` 打开它。
 *    ⚠️ 为什么不让渲染层直接 `file://` 打开：`file://` 的 origin 是 `null`，
 *    白名单只能粗放到"任意 file 页面"，而 http 形态能把边界收成"**我们起的那个端口**"。
 * 2. **guest preload 的交付**：`gui/src/preload/searchHost.cjs` 在**构建期**被 `?raw` 内联成字符串，
 *    运行时注入 channel 表（唯一产地 `shared/ipc.ts`）后落盘到 `userData`，返回其 `file://` URL。
 *    ⚠️ 为什么不让渲染层自己算路径：渲染层不知道构建产物布局，也拿不到源码；
 *    而 electron-vite 的 preload 构建是单入口（多入口实测不生效）⇒ 没有"现成的第二个产物"可取。
 * 3. **联网检索**：转发给 `core-ts/src/search/onlineSearch.ts`（**唯一产地**，Bing 优先/百度兜底）。
 * 4. **guest 事件的归一化与转发**：页面里的检索/点击/切模式 → 归一化成"右栏视图" → 送给渲染层，
 *    对话侧据此显示状态条（用户要求「左侧浏览器搜索后，对话栏能实时监测右侧边栏打开的内容」）。
 *
 * ## ⚠️ 安全边界：为什么这一组 handler 不走 `handleTrusted`
 * `handleTrusted` 的 `isTrustedSender` 只认**主窗口**的 webContents。而这里的 sender 是
 * 右栏 webview 的 **guest**（独立顶层 frame + 独立 webContents）⇒ 必然被拒。
 * 于是本文件自带一条**基于 frame URL 的白名单**（`isTrustedSearchFrame`）：
 * 唯一的搜索页 origin（本机回环 + 动态端口，运行时记下）、`file://`（用户双击页面/探针）、
 * `about:blank`（webview 初始态）。
 * ⚠️ 为什么不在 preload 里做这件事就够：右栏是**通用浏览器**，preload 对它的每次导航都执行；
 * preload 里的 `location` 还可能因页面跑了 `history.pushState` 而与真实 frame URL 不同步 ⇒
 * preload 那层只当**功能性开关**（外网站点连对象都看不见），**权威判据在这里**。
 */
import { app, ipcMain, webContents } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../shared/ipc.js";
import { viewFromPageEvent, type SidebarSearchView } from "../shared/searchView.js";
import { searchOnline } from "../../../core-ts/src/search/onlineSearch.js";
// ⚠️ `?raw`：页面正文**构建期内联**进主进程产物。这样：
//   · 唯一产地就是 `apps/local-search-engine/index.html`（不存在第二份手抄副本 ⇒ 不会漂）；
//   · 打包后不依赖源码路径（`PROJECT_ROOT` 在安装态是**用户数据目录**，源码根本不在那里）。
import searchPageHtml from "../../../apps/local-search-engine/index.html?raw";
// ⚠️ guest preload 同样走"构建期内联 + 运行期落盘"（**不是** electron-vite 的第二个 preload 入口）。
// 原因见 `gui/src/preload/searchHost.cjs` 顶部：`<webview preload>` 只接受单个现成 JS 文件，
// 而 electron-vite 的 preload 构建是单入口 + 固定名（`findLibEntry`），多入口开关实测不生效
// （把 input 键名改成 foo 后产物仍是 index.js 且字节数不变 ⇒ 该字段被整体忽略）。
import searchHostPreloadSource from "../preload/searchHost.cjs?raw";

/** preload 源里的 channel 注入锚点（唯一产地仍是 `gui/src/shared/ipc.ts`）。 */
const CHANNEL_PLACEHOLDER = "/*__SLIME_CHANNELS__*/ null";

/** 页面兜底文案：`?raw` 结果是空串时说明构建配置出了问题，宁可显式报错也不给一个空白页。 */
const EMPTY_PAGE_NOTICE =
  "<!doctype html><meta charset=\"utf-8\"><title>搜索页缺失</title>" +
  "<body style=\"font-family:Segoe UI,system-ui;padding:40px;color:#c33\">" +
  "<h2>搜索引擎页面未内联进产物</h2>" +
  "<p>构建期 <code>?raw</code> 导入到的内容是空的。请检查 <code>gui/vite.config.ts</code> " +
  "与 <code>apps/local-search-engine/index.html</code> 是否存在。</p></body>";

export interface SearchBridgeDeps {
  /** 取当前主程序主题（dark|light|auto）。**不在这里再存一份** —— 主题是别处的状态。 */
  getTheme: () => string;
  /** 取渲染主窗口（把 guest 事件广播回去 + 推主题给 guest）。 */
  getWindow: () => Electron.BrowserWindow | null;
  /**
   * 「这个 sender 是不是主窗口？」
   * ⚠️ **不在这里重新实现一份**（那就是"同一事实两个产地"）：由 `main/index.ts` 传入它既有的
   * `isTrustedSender`（`sender.id === mainWindow.webContents.id`）。
   * 为什么需要它：本文件服务**两类来源**，白名单**不能共用**——
   *   · guest（右栏 webview）⇒ 只能按 `senderFrame.url` 判（它永远不是主窗口）；
   *   · 主窗口（渲染层）⇒ 按 webContents id 判。
   * 早先 `search_host_info` 错用了 guest 那条判据，后果是**开发模式下渲染层问不到搜索页**
   * （dev 时渲染层是 `http://localhost:PORT`，其 origin 不在 guest 白名单里 ⇒ 被拒）。
   */
  isMainSender: (sender: Electron.WebContents) => boolean;
  /** 起本地静态服务（复用 `slime:http:serve` 的同一实现，带同目录复用）。 */
  serve: (opts: { dir: string; port?: number; host?: string; spa?: boolean; origin?: "agent" | "restored" | "builtin" }) => Promise<{
    ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string;
  }>;
}

/** 搜索页页面正文的内容指纹（用于幂等落盘；也是"页面改没改"的唯一判据）。 */
export function searchPageFingerprint(): string {
  return createHash("sha256").update(searchPageHtml).digest("hex").slice(0, 16);
}

/** 幂等写文件：内容相同则**不碰磁盘**（避免无谓 mtime 抖动 / 无谓重写）；不同则原子替换。 */
function writeIfChanged(file: string, content: string): boolean {
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === content) { return false; }
    const tmp = file + "." + randomUUID() + ".tmp";
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);   // 原子替换：读者要么读到旧完整文件，要么读到新完整文件
    return true;
  } catch {
    return false;
  }
}

let pageDirCache: string | null = null;
/** 搜索页落盘目录（固定，不随指纹变 —— 换目录会让 `http:serve` 的同目录复用失效并攒垃圾）。 */
function searchPageDir(): string {
  if (!pageDirCache) {
    pageDirCache = join(app.getPath("userData"), "slime-search", "page");
  }
  return pageDirCache;
}

/** 已交付的搜索页信息（`ensureSearchPage` 成功后才非空）。 */
let delivered: { url: string; origin: string; preload: string } | null = null;
/** 白名单：本机回环上的**搜索页 origin**（动态端口，故运行时记录）。 */
const ALLOWED_ORIGINS = new Set<string>();

/* ══════════ guest preload 的落盘 ══════════
 * ⚠️ 为什么不是"从 `out/preload/` 取现成产物"：electron-vite 的 preload 构建是
 * **单入口 + 固定文件名**（`findLibEntry`），本仓实测多入口开关不生效 ⇒ 第二个 preload
 * 根本不会被构建出来。于是改用与 `gui/vendor/*.js`、搜索页本体**同一机制**：
 * 构建期 `?raw` 内联进主进程产物 + 运行期幂等落盘。
 * 好处是"唯一产地"仍然只有 `gui/src/preload/searchHost.cjs` 一份（不存在手抄副本）。 */

/** preload 落盘目录（与页面目录并列，但**不在** http 服务目录里 —— preload 不该被下载）。 */
function searchHostPreloadDir(): string {
  return join(app.getPath("userData"), "slime-search", "preload");
}

/**
 * 生成 guest preload 文件（幂等）并返回其 `file://` URL。
 * 返回 `null` = 无法交付宿主（`?raw` 内联到了空串 / 注入锚点缺失 / 写盘失败）
 * —— 全部当作**失败出声**，宁可页面明确报"未接入"，也不静默挂上一个永远不 expose 的 preload。
 */
function materializeSearchHostPreload(): string | null {
  if (!searchHostPreloadSource || searchHostPreloadSource.length === 0) {
    console.error("[searchBridge] guest preload 的 ?raw 内联结果是空串 —— 构建配置有问题");
    return null;
  }
  if (!searchHostPreloadSource.includes(CHANNEL_PLACEHOLDER)) {
    console.error("[searchBridge] guest preload 缺少 channel 注入锚点 —— 源文件被改坏了");
    return null;
  }
  // channel 表由**唯一产地** `shared/ipc.ts` 注入（preload 里禁止硬编码 channel 名）。
  const src = searchHostPreloadSource.split(CHANNEL_PLACEHOLDER).join(JSON.stringify(IPC_CHANNELS));
  try {
    const dir = searchHostPreloadDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "searchHost.cjs");
    writeIfChanged(file, src);   // 内容没变则不碰磁盘（避免无谓 mtime 抖动）
    return pathToFileURL(file).href;
  } catch (e) {
    console.error("[searchBridge] guest preload 落盘失败：", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** frame URL 是否来自我们自己的搜索页（**唯一权威判据**）。 */
export function isTrustedSearchUrl(url: string): boolean {
  const u = String(url || "");
  if (!u) { return false; }
  if (u === "about:blank") { return true; }
  if (u.startsWith("file://")) { return true; }   // 用户双击页面 / 探针 harness
  try {
    return ALLOWED_ORIGINS.has(new URL(u).origin);
  } catch {
    return false;
  }
}

function isTrustedSearchFrame(event: { senderFrame?: { url: string } | null; sender: Electron.WebContents }): boolean {
  try {
    const frameUrl = event.senderFrame?.url;
    if (frameUrl) { return isTrustedSearchUrl(frameUrl); }
    // 极少数情况下 senderFrame 拿不到（frame 已销毁）⇒ 退回 webContents 的 URL
    return isTrustedSearchUrl(event.sender?.getURL?.() ?? "");
  } catch {
    return false;
  }
}

/**
 * 「渲染层（主窗口）发来的请求」是否可信 —— 用的是传进来的 `deps.isMainSender`（唯一判据）。
 * ⚠️ 为什么不能复用 `isTrustedSearchFrame`：dev 模式下渲染层的 URL 是 `http://localhost:PORT`
 * （另一个端口），不在搜索页 origin 白名单里 ⇒ 会被**误拒**，表现为"搜索页根本打不开"
 * 且没有任何报错（`hostInfo` 静默返回 `{ok:false}`）。这是两类来源必须两套判据的实证。
 */
function isTrustedMainSender(event: { sender: Electron.WebContents }, deps: SearchBridgeDeps): boolean {
  try {
    return deps.isMainSender(event.sender);
  } catch {
    return false;
  }
}

/** 当前所有"可信搜索页"的 guest webContents（推主题用）。 */
function trustedGuests(): Electron.WebContents[] {
  const out: Electron.WebContents[] = [];
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed()) { continue; }
      if (isTrustedSearchUrl(wc.getURL())) { out.push(wc); }
    } catch { /* 忽略已销毁的 */ }
  }
  return out;
}

/** 把主程序主题推给搜索页（webview 里 postMessage 收不到，只能走 IPC）。 */
export function pushSearchTheme(mode: string): void {
  for (const wc of trustedGuests()) {
    try { wc.send(IPC_CHANNELS.search_theme, mode); } catch { /* 忽略 */ }
  }
}

/** 交付搜索页（幂等）：落盘 → 起/复用本地服务 → 记下 origin。 */
export async function ensureSearchPage(deps: SearchBridgeDeps): Promise<{ ok: boolean; url?: string; preload?: string; error?: string }> {
  if (delivered) { return { ok: true, url: delivered.url, preload: delivered.preload }; }
  const dir = searchPageDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "无法创建搜索页目录：" + (e instanceof Error ? e.message : String(e)) };
  }
  const html = searchPageHtml && searchPageHtml.length > 0 ? searchPageHtml : EMPTY_PAGE_NOTICE;
  writeIfChanged(join(dir, "index.html"), html);

  // guest preload 必须先就绪：渲染层把 `preload` 属性挂在 `<webview>` 上的那一刻就定死了，
  // 之后再补是无效的（要重挂节点）。所以交付失败就整体失败，别给一个"能看但搜不动"的页面。
  const preload = materializeSearchHostPreload();
  if (!preload) {
    return { ok: false, error: "搜索页宿主桥交付失败：内联的 guest preload 不可用" };
  }

  const r = await deps.serve({ dir, host: "127.0.0.1", origin: "builtin" });
  if (!r?.ok || !r.port) {
    return { ok: false, error: r?.error || "本地服务启动失败" };
  }
  const host = r.host || "127.0.0.1";
  const url = `http://${host}:${r.port}/`;
  let origin = url;
  try { origin = new URL(url).origin; } catch { /* 保底用整串 */ }
  ALLOWED_ORIGINS.add(origin);
  delivered = { url, origin, preload };
  return { ok: true, url, preload };
}

/* ══════════ guest 事件 → 「右栏视图」归一化 ══════════
 * 翻译函数与视图类型都在 `gui/src/shared/searchView.ts`（**唯一产地**）——
 * 因为渲染层也要读同一个类型（对话侧状态条）。这里只负责**持有序号**。 */
let viewSeq = 0;
let lastView: SidebarSearchView | null = null;

/** 取最近一次视图（渲染层挂载时可以先要一份，避免"错过广播就永远空白"）。 */
export function getSidebarSearchView(): SidebarSearchView | null {
  return lastView;
}

/* ══════════ IPC 注册 ══════════ */

/** 从 guest 的入参里取字符串（**不可信输入**：非字符串一律归零，且截断）。 */
function argStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** 注册搜索桥的全部 IPC（只调一次；重复调用会因 A-1020 的机制被拦下）。 */
export function registerSearchBridge(deps: SearchBridgeDeps): void {
  /** guest：联网检索（结构化）。 */
  ipcMain.handle(IPC_CHANNELS.search_query, async (event, payload: unknown) => {
    if (!isTrustedSearchFrame(event)) {
      return { ok: false, error: "未授权来源：只接受本机搜索页发起的检索" };
    }
    const q = typeof payload === "object" && payload !== null
      ? argStr((payload as Record<string, unknown>).query, 400).trim()
      : String(payload ?? "").trim();
    if (!q) { return { ok: false, error: "缺少查询词" }; }
    const r = await searchOnline(q, { maxResults: 10 });
    if (!r.ok) { return { ok: false, error: r.error, captcha: r.captcha }; }
    return { ok: true, engine: r.engine, engineName: r.engineName, items: r.items };
  });

  /** guest：查询当前主题（页面首次加载对齐主程序，否则浅色用户先看到一页黑底）。 */
  ipcMain.handle(IPC_CHANNELS.search_theme_get, (event) => {
    if (!isTrustedSearchFrame(event)) { return "dark"; }
    return deps.getTheme();
  });

  /** guest：上报页面内部事件 → 归一化 → 广播给渲染层（对话侧状态条）。 */
  ipcMain.on(IPC_CHANNELS.search_event, (event, evt: unknown) => {
    if (!isTrustedSearchFrame(event)) { return; }
    const view = viewFromPageEvent(evt, ++viewSeq, lastView);
    if (!view) { return; }
    lastView = view;
    try {
      deps.getWindow()?.webContents.send(IPC_CHANNELS.search_view_changed, view);
    } catch { /* 窗口没了就算了，事件本身不是关键路径 */ }
  });

  /** guest：页面自行切换主题时回传 —— 供将来"页面主题反推主程序"用，当前只记录不反向改主程序。 */
  ipcMain.on(IPC_CHANNELS.search_theme_report, (event, detail: unknown) => {
    if (!isTrustedSearchFrame(event)) { return; }
    const mode = typeof detail === "object" && detail !== null
      ? (detail as Record<string, unknown>).mode
      : detail;
    if (typeof mode === "string" && (mode === "dark" || mode === "light" || mode === "auto")) {
      lastPageTheme = mode;
    }
  });

  /** **渲染层（主窗口）**：要「搜索页 URL + guest preload 路径」。
   *  ⚠️ sender 判据用 `isMainSender`（不是 guest 那条）—— 见 `isTrustedMainSender` 的注释。 */
  ipcMain.handle(IPC_CHANNELS.search_host_info, async (event) => {
    if (!isTrustedMainSender(event, deps)) {
      return { ok: false, error: "未授权来源：只有主窗口可以索取搜索页信息" };
    }
    const r = await ensureSearchPage(deps);
    if (!r.ok) { return { ok: false, error: r.error || "搜索页交付失败" }; }
    return { ok: true, url: r.url, preload: r.preload, fingerprint: searchPageFingerprint() };
  });

  /** **渲染层（主窗口）**：取一份"最近视图"。
   *  为什么需要它：广播是**一次性**的 —— 渲染层挂载晚于某次 guest 上报时，那条广播已经过去了，
   *  没有这条 pull，状态条会**永远空白**（"错过一次就永久瞎"是最难查的一类静默失效）。 */
  ipcMain.handle(IPC_CHANNELS.search_view_get, (event) => {
    if (!isTrustedMainSender(event, deps)) { return null; }
    return lastView;
  });
}

/** 页面自己上报的主题（只记录；主程序主题另有产地，不在这里反向覆盖）。 */
let lastPageTheme: string | null = null;
export function getLastPageTheme(): string | null {
  return lastPageTheme;
}

/** 仅供测试复位（模块级缓存在单测里要能清干净，否则用例间互相污染）。 */
export function __resetSearchBridgeForTest(): void {
  delivered = null;
  pageDirCache = null;
  ALLOWED_ORIGINS.clear();
  lastView = null;
  lastPageTheme = null;
  viewSeq = 0;
}
