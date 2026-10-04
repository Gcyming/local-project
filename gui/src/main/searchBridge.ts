



























import { app, ipcMain, webContents } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IPC_CHANNELS } from "../shared/ipc.js";
import { viewFromPageEvent, type SidebarSearchView } from "../shared/searchView.js";
import { searchOnline } from "../../../core-ts/src/search/onlineSearch.js";



import searchPageHtml from "../../../apps/local-search-engine/index.html?raw";




import searchHostPreloadSource from "../preload/searchHost.cjs?raw";


const CHANNEL_PLACEHOLDER = "/*__SLIME_CHANNELS__*/ null";


const EMPTY_PAGE_NOTICE =
  "<!doctype html><meta charset=\"utf-8\"><title>搜索页缺失</title>" +
  "<body style=\"font-family:Segoe UI,system-ui;padding:40px;color:#c33\">" +
  "<h2>搜索引擎页面未内联进产物</h2>" +
  "<p>构建期 <code>?raw</code> 导入到的内容是空的。请检查 <code>gui/vite.config.ts</code> " +
  "与 <code>apps/local-search-engine/index.html</code> 是否存在。</p></body>";

export interface SearchBridgeDeps {
  
  getTheme: () => string;
  
  getWindow: () => Electron.BrowserWindow | null;
  









  isMainSender: (sender: Electron.WebContents) => boolean;
  
  serve: (opts: { dir: string; port?: number; host?: string; spa?: boolean; origin?: "agent" | "restored" | "builtin" }) => Promise<{
    ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string;
  }>;
}


export function searchPageFingerprint(): string {
  return createHash("sha256").update(searchPageHtml).digest("hex").slice(0, 16);
}


function writeIfChanged(file: string, content: string): boolean {
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === content) { return false; }
    const tmp = file + "." + randomUUID() + ".tmp";
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);   
    return true;
  } catch {
    return false;
  }
}

let pageDirCache: string | null = null;

function searchPageDir(): string {
  if (!pageDirCache) {
    pageDirCache = join(app.getPath("userData"), "slime-search", "page");
  }
  return pageDirCache;
}


let delivered: { url: string; origin: string; preload: string } | null = null;

const ALLOWED_ORIGINS = new Set<string>();









function searchHostPreloadDir(): string {
  return join(app.getPath("userData"), "slime-search", "preload");
}






function materializeSearchHostPreload(): string | null {
  if (!searchHostPreloadSource || searchHostPreloadSource.length === 0) {
    console.error("[searchBridge] guest preload 的 ?raw 内联结果是空串 —— 构建配置有问题");
    return null;
  }
  if (!searchHostPreloadSource.includes(CHANNEL_PLACEHOLDER)) {
    console.error("[searchBridge] guest preload 缺少 channel 注入锚点 —— 源文件被改坏了");
    return null;
  }
  
  const src = searchHostPreloadSource.split(CHANNEL_PLACEHOLDER).join(JSON.stringify(IPC_CHANNELS));
  try {
    const dir = searchHostPreloadDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "searchHost.cjs");
    writeIfChanged(file, src);   
    return pathToFileURL(file).href;
  } catch (e) {
    console.error("[searchBridge] guest preload 落盘失败：", e instanceof Error ? e.message : String(e));
    return null;
  }
}


export function isTrustedSearchUrl(url: string): boolean {
  const u = String(url || "");
  if (!u) { return false; }
  if (u === "about:blank") { return true; }
  if (u.startsWith("file://")) { return true; }   
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
    
    return isTrustedSearchUrl(event.sender?.getURL?.() ?? "");
  } catch {
    return false;
  }
}







function isTrustedMainSender(event: { sender: Electron.WebContents }, deps: SearchBridgeDeps): boolean {
  try {
    return deps.isMainSender(event.sender);
  } catch {
    return false;
  }
}


function trustedGuests(): Electron.WebContents[] {
  const out: Electron.WebContents[] = [];
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed()) { continue; }
      if (isTrustedSearchUrl(wc.getURL())) { out.push(wc); }
    } catch {  }
  }
  return out;
}


export function pushSearchTheme(mode: string): void {
  for (const wc of trustedGuests()) {
    try { wc.send(IPC_CHANNELS.search_theme, mode); } catch {  }
  }
}


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
  try { origin = new URL(url).origin; } catch {  }
  ALLOWED_ORIGINS.add(origin);
  delivered = { url, origin, preload };
  return { ok: true, url, preload };
}




let viewSeq = 0;
let lastView: SidebarSearchView | null = null;


export function getSidebarSearchView(): SidebarSearchView | null {
  return lastView;
}




function argStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}


export function registerSearchBridge(deps: SearchBridgeDeps): void {
  
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

  
  ipcMain.handle(IPC_CHANNELS.search_theme_get, (event) => {
    if (!isTrustedSearchFrame(event)) { return "dark"; }
    return deps.getTheme();
  });

  
  ipcMain.on(IPC_CHANNELS.search_event, (event, evt: unknown) => {
    if (!isTrustedSearchFrame(event)) { return; }
    const view = viewFromPageEvent(evt, ++viewSeq, lastView);
    if (!view) { return; }
    lastView = view;
    try {
      deps.getWindow()?.webContents.send(IPC_CHANNELS.search_view_changed, view);
    } catch {  }
  });

  
  ipcMain.on(IPC_CHANNELS.search_theme_report, (event, detail: unknown) => {
    if (!isTrustedSearchFrame(event)) { return; }
    const mode = typeof detail === "object" && detail !== null
      ? (detail as Record<string, unknown>).mode
      : detail;
    if (typeof mode === "string" && (mode === "dark" || mode === "light" || mode === "auto")) {
      lastPageTheme = mode;
    }
  });

  

  ipcMain.handle(IPC_CHANNELS.search_host_info, async (event) => {
    if (!isTrustedMainSender(event, deps)) {
      return { ok: false, error: "未授权来源：只有主窗口可以索取搜索页信息" };
    }
    const r = await ensureSearchPage(deps);
    if (!r.ok) { return { ok: false, error: r.error || "搜索页交付失败" }; }
    return { ok: true, url: r.url, preload: r.preload, fingerprint: searchPageFingerprint() };
  });

  


  ipcMain.handle(IPC_CHANNELS.search_view_get, (event) => {
    if (!isTrustedMainSender(event, deps)) { return null; }
    return lastView;
  });
}


let lastPageTheme: string | null = null;
export function getLastPageTheme(): string | null {
  return lastPageTheme;
}


export function __resetSearchBridgeForTest(): void {
  delivered = null;
  pageDirCache = null;
  ALLOWED_ORIGINS.clear();
  lastView = null;
  lastPageTheme = null;
  viewSeq = 0;
}
