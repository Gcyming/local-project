















import { SIDEBAR_OPEN_EVENT } from "./Markdown.js";
import { isBrowserSchemeUrl } from "../../shared/ipc.js";

import { publishOperationFocus, type OpFocusRect } from "./operationFocus.js";

import { safeLoadURL } from "./webviewNav.js";

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserHost {
  listTabs(): BrowserTabInfo[];
  
  openTab(url?: string, activate?: boolean): string;
  closeTab(tabId?: string): boolean;
  activateTab(tabId: string): boolean;
  activeTabId(): string | null;
}







function expandSidebar(): void {
  try {
    window.dispatchEvent(new CustomEvent(SIDEBAR_OPEN_EVENT, { detail: { kind: "url" } }));
  } catch {  }
}

let host: BrowserHost | null = null;

export function setBrowserHost(h: BrowserHost | null): void {
  host = h;
}


const webviews = new Map<string, any>();

export function registerWebview(tabId: string, wv: unknown): void {
  webviews.set(tabId, wv);
}

export function unregisterWebview(tabId: string): void {
  webviews.delete(tabId);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));














function webviewRectOf(wv: unknown): OpFocusRect | null {
  try {
    const r = (wv as HTMLElement).getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) { return null; }
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  } catch { return null; }
}


function restoreUserFocus(wv: unknown, prev: HTMLElement | null): void {
  try {
    if (!prev || prev === (wv as unknown as HTMLElement) || !prev.isConnected) { return; }
    
    if (document.activeElement !== (wv as unknown as HTMLElement)) { return; }
    prev.focus();
  } catch {  }
}





async function withWebviewFocus<T>(wv: unknown, label: string, fn: () => Promise<T>): Promise<T> {
  const prev = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
  try {
    
    (wv as Electron.WebviewTag).focus({ preventScroll: true });
  } catch {
    try { (wv as Electron.WebviewTag).focus(); } catch {  }
  }
  
  publishOperationFocus({ phase: "begin", target: "browser", label, rect: webviewRectOf(wv), waitingUser: false });
  try {
    await sleep(30); 
    return await fn();
  } finally {
    publishOperationFocus({ phase: "end", target: "browser", label });
    restoreUserFocus(wv, prev);
  }
}



async function waitVisible(wv: any, timeoutMs = 2500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = (wv as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { return true; }
    } catch {  }
    if (Date.now() > deadline) { return false; }
    await sleep(60);
  }
}







let pendingPopupNotice: string | null = null;
try {
  window.addEventListener("slime-browser-popup-notice", ((e: Event) => {
    const d = (e as CustomEvent<{ url?: string; kind?: string; scheme?: string; handler?: string }>).detail ?? {};
    const url = d.url ?? "";
    if (!url) { return; }
    const kind = d.kind;
    const scheme = d.scheme ?? (url.split(":")[0] || "").toLowerCase();
    if (kind === "opened") {
      pendingPopupNotice = `已把 ${scheme}:// 链接交给系统打开${d.handler ? `（${d.handler}）` : ""}——链接目的已达成，无需在浏览器里再处理。`;
    } else if (kind === "need-install") {
      
      if (isBrowserSchemeUrl(url)) {
        pendingPopupNotice = `已拦截浏览器唤起链接（${scheme}://）——这类链接的目的是唤起另一款浏览器加载页面，对当前浏览无帮助，且外部浏览器收到指令会自己弹报错横幅；不要在浏览器里反复尝试。`;
      } else {
        pendingPopupNotice = `${scheme}:// 链接需要安装「${scheme}」客户端才能打开（当前系统未注册该协议）。请如实告知用户：这链接指向的应用未安装；不要在浏览器里反复尝试。`;
      }
    } else {
      pendingPopupNotice = `站点刚试图弹出新窗口（${url}），已自动拦截（防弹窗盖页面卡死循环）。如确需在那里登录，可 browser_navigate 打开该地址。`;
    }
  }) as EventListener);
} catch {  }


function takePopupNotice(): string | null {
  const v = pendingPopupNotice;
  pendingPopupNotice = null;
  return v;
}


async function tryOpenExternal(url: string): Promise<{ ok: boolean; handler?: string; error?: string }> {
  try {
    const api = (window as unknown as {
      slimeAPI?: { protocol?: { open?: (u: string) => Promise<{ ok?: boolean; handler?: string; reason?: string }> } }
    }).slimeAPI?.protocol;
    const r = await api?.open?.(url);
    if (r?.ok) { return { ok: true, handler: r.handler }; }
    
    if (r?.reason === "browser-scheme" || isBrowserSchemeUrl(url)) {
      return { ok: false, error: `已拦截浏览器唤起链接 ${(url.split(":")[0] || "").toLowerCase()}:// ——不唤醒外部浏览器` };
    }
    return { ok: false, error: `链接 ${(url.split(":")[0] || "").toLowerCase()}:// 需要安装对应客户端才能打开（当前系统未注册该协议）。请如实告知用户，不要反复尝试。` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "无法打开该链接" };
  }
}
















const SAFE_NAV_SCHEMES = new Set(["http", "https", "about", "data", "blob"]);


export function isWebNavUrl(raw: string | undefined): boolean {
  const url = (raw ?? "").trim();
  if (!url || url === "about:blank") { return true; }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!m) { return true; } 
  return SAFE_NAV_SCHEMES.has(m[1].toLowerCase());
}















export function normalizeBrowserUrl(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s || s === "about:blank") { return s; }
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d+/.test(s)) { return `http://${s}`; }        
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) { return s; }                   
  if (/^(about|file|data|blob):/i.test(s)) { return s; }                       
  if (s.includes(":")) { return s; }                                           
  return `http://${s}`;                                                        
}


async function awaitWebview(tabId: string, timeoutMs = 4000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const wv = webviews.get(tabId);
    if (wv) { return wv; }
    if (Date.now() > deadline) { return null; }
    await sleep(60);
  }
}








const domReady = new WeakMap<any, boolean>();

async function waitDomReady(wv: any, timeoutMs = 8000): Promise<boolean> {
  if (domReady.get(wv) === true) { return true; }
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const ok = (): void => {
      if (done) { return; }
      done = true;
      try { wv.removeEventListener("dom-ready", ok); wv.removeEventListener("did-fail-load", fail); } catch {  }
      domReady.set(wv, true);
      resolve(true);
    };
    const fail = (): void => {
      if (done) { return; }
      done = true;
      try { wv.removeEventListener("dom-ready", ok); wv.removeEventListener("did-fail-load", fail); } catch {  }
      resolve(false);
    };
    try {
      wv.addEventListener("dom-ready", ok);
      wv.addEventListener("did-fail-load", fail);
    } catch {  }
    setTimeout(() => {
      if (done) { return; }
      done = true;
      try { wv.removeEventListener("dom-ready", ok); wv.removeEventListener("did-fail-load", fail); } catch {  }
      resolve(domReady.get(wv) === true);
    }, timeoutMs);
  });
}


function resetDomReady(wv: any): void {
  domReady.delete(wv);
}





async function runJs(wv: any, code: string): Promise<any> {
  await waitDomReady(wv);
  try {
    return await wv.executeJavaScript(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/dom-ready|attached to the DOM|destroyed|not ready/i.test(msg)) {
      await sleep(350);
      await waitDomReady(wv, 4000);
      return await wv.executeJavaScript(code);
    }
    throw e;
  }
}


async function waitLoaded(wv: any, timeoutMs = 15000): Promise<void> {
  try {
    if (typeof wv.isLoading === "function" && !wv.isLoading()) { return; }
  } catch {  }
  await new Promise<void>((resolve) => {
    let done = false;
    const fin = (): void => {
      if (done) { return; }
      done = true;
      try {
        wv.removeEventListener("did-stop-loading", fin);
        wv.removeEventListener("did-fail-load", fin);
      } catch {  }
      resolve();
    };
    try {
      wv.addEventListener("did-stop-loading", fin);
      wv.addEventListener("did-fail-load", fin);
    } catch {  }
    setTimeout(fin, timeoutMs);
  });
}





const COLLECT_JS = `(() => {
  const sel = "a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],video,[onclick],[contenteditable=true]";
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    return true;
  };
  const cssPath = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.name) p += "[name='" + cur.name + "']";
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) p += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
      parts.unshift(p);
      if (cur.id) { parts[0] = "#" + CSS.escape(cur.id); break; }
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  // 收集一个文档（顶层或 iframe 内）的可点元素；bx/by=该文档原点在宿主视口中的偏移
  const collectIn = (doc, bx, by) => {
    const out = [];
    const seen = new Set();
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      if (seen.has(el) || !vis(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      let txt = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || (el.tagName === "VIDEO" ? "▶ 视频" : "") || "").trim().replace(/\\s+/g, " ").slice(0, 60);
      // A-980-R10：空文本图标按钮（登录弹窗右上角 X 等纯 SVG 关闭钮）补可定位占位
      const hasIcon = !txt && (el.querySelector("svg,img,i,span") !== null);
      if (!txt) { txt = hasIcon ? ("[图标] " + el.tagName.toLowerCase()) : el.tagName.toLowerCase(); }
      out.push({
        tag: el.tagName.toLowerCase(),
        text: txt,
        icon: hasIcon ? 1 : 0,
        selector: cssPath(el),
        frame: (bx || by) ? 1 : 0,
        x: Math.round(bx + r.left + r.width / 2),
        y: Math.round(by + r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  };
  let out = [];
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    try {
      const fd = f.contentDocument;
      if (!fd || !fd.body) continue;
      const fr = f.getBoundingClientRect();
      out = out.concat(collectIn(fd, fr.left, fr.top));
    } catch { /* 跨域 iframe 不可读 → 跳过 */ }
  }
  out = out.concat(collectIn(document, 0, 0));
  return out;
})()`;


const COLLECT_INPUTS_JS = `(() => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll("input,textarea,[contenteditable=true]"))) {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "checkbox", "radio", "file", "image", "reset"].includes(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    let p = el.tagName.toLowerCase();
    if (el.id) p = "#" + CSS.escape(el.id);
    else if (el.name) p += "[name='" + el.name + "']";
    out.push({ selector: p, placeholder: el.getAttribute("placeholder") || "", value: String(el.value ?? "").slice(0, 40) });
  }
  return out;
})()`;









const OBSERVE_JS = `(() => {
  const sel = "a,button,summary,label,[role=button],[role=link],[role=tab],video,[onclick]";
  const out = [];
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // 只收视口内主体区域（上 15% - 下 95%），忽略贴边小工具条
    if (r.bottom < innerHeight * 0.15 || r.top > innerHeight * 0.95 || r.right < 0 || r.left > innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) continue;
    if (el.tagName === "A" && r.width < 90 && r.height < 24) continue; // 跳过导航小链接
    const txt = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.tagName === "VIDEO" ? "▶ 视频" : "") || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    out.push({
      index: out.length + 1,
      tag: el.tagName.toLowerCase(),
      text: txt,
      area: r.width * r.height,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  out.sort((a, b) => b.area - a.area);
  return out.slice(0, 12).map((e, i) => ({ index: i + 1, tag: e.tag, text: e.text, x: e.x, y: e.y, w: e.w, h: e.h }));
})()`;





async function observeAfter(wv: any, settleMs: number): Promise<string> {
  await sleep(settleMs);
  
  try {
    if (typeof wv.isLoading === "function" && wv.isLoading()) {
      return "（页面加载中——可 browser_wait / browser_snapshot 查看新状态）";
    }
  } catch {  }
  try {
    const els = await wv.executeJavaScript(OBSERVE_JS);
    if (!Array.isArray(els) || els.length === 0) {
      return "（页面加载中/暂无可观察元素——可 browser_wait 或 browser_snapshot 再看）";
    }
    return (els as Array<{ index: number; tag: string; text: string }>)
      .map((e) => `#${e.index} <${e.tag}>${e.text ? ` ${e.text}` : ""}`)
      .join(" | ");
  } catch {
    return "（观察失败，可用 browser_snapshot / browser_screenshot 核对）";
  }
}


function overlayJs(elements: Array<{ index: number; x: number; y: number; w: number; h: number; text: string }>): string {
  const data = JSON.stringify(elements);
  return `(() => {
    const old = document.getElementById("__slime_som__");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "__slime_som__";
    box.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    for (const e of ${data}) {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;left:" + (e.x - e.w/2) + "px;top:" + (e.y - e.h/2) + "px;width:" + e.w + "px;height:" + e.h + "px;border:2px solid #ffd60a;box-sizing:border-box;background:rgba(255,214,10,0.08)";
      const l = document.createElement("div");
      l.textContent = "#" + e.index + (e.text ? " " + e.text.slice(0, 10) : "");
      l.style.cssText = "position:absolute;left:0;top:-16px;font:11px/14px monospace;color:#111;background:#ffd60a;padding:0 3px;white-space:nowrap";
      d.appendChild(l);
      box.appendChild(d);
    }
    document.documentElement.appendChild(box);
    return true;
  })()`;
}

const CLEAR_OVERLAY_JS = `(() => { const o = document.getElementById("__slime_som__"); if (o) o.remove(); return true; })()`;







export interface DragPoint { x: number; y: number; }









export function buildDragPath(
  from: DragPoint,
  to: DragPoint,
  steps: number,
  jitter = true,
  rnd: () => number = Math.random,
): DragPoint[] {
  const n = Math.max(2, Math.min(80, Math.round(Number.isFinite(steps) ? steps : 20)));
  const out: DragPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    
    const ease = 1 - (1 - t) * (1 - t);
    let x = from.x + (to.x - from.x) * ease;
    let y = from.y + (to.y - from.y) * ease;
    if (jitter) { x += rnd() * 4 - 2; y += rnd() * 4 - 2; }
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  out.push({ x: Math.round(to.x), y: Math.round(to.y) }); 
  return out;
}






async function resolvePoint(
  wv: any,
  cmd: Record<string, unknown>,
  prefix: "from" | "to",
): Promise<DragPoint & { what: string } | null> {
  const cx = typeof cmd[`${prefix}x`] === "number" ? cmd[`${prefix}x`] : undefined;
  const cy = typeof cmd[`${prefix}y`] === "number" ? cmd[`${prefix}y`] : undefined;
  if (typeof cx === "number" && typeof cy === "number") {
    return { x: Math.round(cx), y: Math.round(cy), what: `坐标(${Math.round(cx)},${Math.round(cy)})` };
  }
  const selector = typeof cmd[`${prefix}selector`] === "string" ? cmd[`${prefix}selector`] : "";
  if (selector) {
    const r = await wv.executeJavaScript(`(() => { try { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2), what: (el.innerText||el.value||el.tagName).slice(0,40) }; } catch(e) { return null; } })()`);
    if (r) { return r; }
  }
  const iv = cmd[`${prefix}index`];
  const index = typeof iv === "number" ? iv : undefined;
  if (index !== undefined) {
    const els = await wv.executeJavaScript(COLLECT_JS);
    const e = Array.isArray(els) ? els[index - 1] : null;
    if (e) { return { x: e.x, y: e.y, what: `${e.tag}${e.text ? ` "${e.text}"` : ""}` }; }
  }
  const text = typeof cmd[`${prefix}text`] === "string" ? cmd[`${prefix}text`] : "";
  if (text) {
    const r = await wv.executeJavaScript(`(() => { const t = ${JSON.stringify(text)}; const cands = Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,label,[role=button],[role=link]")); const el = cands.find((e) => ((e.innerText||e.value||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim().includes(t))); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2), what: (el.innerText||el.value||el.tagName).slice(0,40) }; })()`);
    if (r) { return r; }
  }
  return null;
}


export async function executeBrowserCommand(cmd: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!host) { return { ok: false, error: "右侧栏未就绪（浏览器宿主未注册；请确认右侧栏已打开）" }; }
  const kind = String(cmd?.kind ?? "");
  const explicitTab = typeof cmd.tabId === "string" && cmd.tabId ? cmd.tabId : undefined;
  const curId = (): string | null => explicitTab ?? host!.activeTabId();
  const curWv = async (): Promise<any> => {
    const id = curId();
    if (!id) { throw new Error("没有可用的浏览器页——请先 browser_navigate 打开一个网址"); }
    
    
    expandSidebar();                 
    try { host!.activateTab(id); } catch {  }
    
    
    const wv = await awaitWebview(id);
    if (!wv) { throw new Error("浏览器页尚未就绪（webview 未挂载）"); }
    await waitVisible(wv);
    await sleep(40);               
    
    
    const ok = await waitDomReady(wv, 6000);
    if (!ok) {
      throw new Error("浏览器页还没准备好（webview 尚未完成 dom-ready 或加载失败）——请先 browser_wait，或重新 browser_navigate 后再操作");
    }
    return wv;
  };

  try {
    switch (kind) {
      case "tabs":
        return { ok: true, data: host.listTabs() };

      case "open": {
        expandSidebar();
        const url = typeof cmd.url === "string" ? cmd.url : undefined;
        
        if (url !== undefined && url.trim() && !isWebNavUrl(url)) {
          const ext = await tryOpenExternal(url.trim());
          if (ext.ok) { return { ok: true, data: { systemOpened: true, url: url.trim(), handler: ext.handler } }; }
          return { ok: false, error: ext.error };
        }
        const id = host.openTab(url, cmd.activate !== false);
        return { ok: true, data: { tabId: id } };
      }

      case "close":
        return { ok: true, data: { closed: host.closeTab(explicitTab) } };

      case "activate": {
        const id = String(cmd.tabId ?? "");
        if (!id) { return { ok: false, error: "activate 需要 tabId" }; }
        return { ok: true, data: { activated: host.activateTab(id) } };
      }

      case "navigate": {
        let url = String(cmd.url ?? "").trim();
        if (!url) { return { ok: false, error: "navigate 需要 url" }; }
        
        url = normalizeBrowserUrl(url);
        
        
        if (!isWebNavUrl(url)) {
          const scheme = (url.split(":")[0] || "").toLowerCase();
          if (scheme === "slime") { return { ok: false, error: "slime:// 平台链接请使用平台内打开方式（如点击聊天里的链接）" }; }
          const ext = await tryOpenExternal(url);
          if (ext.ok) { return { ok: true, data: { systemOpened: true, url, handler: ext.handler } }; }
          return { ok: false, error: ext.error };
        }
        expandSidebar();               
        await sleep(40);               
        let id = curId();
        if (!id) { id = host.openTab(url, true); }
        let wv = await awaitWebview(id);
        
        const deadline = Date.now() + 4000;
        while (!wv && Date.now() < deadline) { await sleep(80); wv = await awaitWebview(id, 300); }
        if (!wv) { return { ok: false, error: "浏览器页未就绪（webview 未挂载）" }; }
        resetDomReady(wv);           
        safeLoadURL(wv, url);        
        
        
        await waitDomReady(wv, 10000); 
        await sleep(150);            
        const finalUrl = ((): string => { try { return wv.getURL(); } catch { return url; } })();
        return { ok: true, data: { tabId: id, url: finalUrl, popupNotice: takePopupNotice() } };
      }

      case "back": { const wv = await curWv(); try { wv.goBack(); } catch {  } resetDomReady(wv); await waitDomReady(wv, 8000); await sleep(300); return { ok: true }; }
      case "forward": { const wv = await curWv(); try { wv.goForward(); } catch {  } resetDomReady(wv); await waitDomReady(wv, 8000); await sleep(300); return { ok: true }; }
      case "reload": { const wv = await curWv(); resetDomReady(wv); wv.reload(); await waitDomReady(wv, 15000); await waitLoaded(wv); return { ok: true }; }

      case "read": {
        const wv = await curWv();
        const mode = cmd.mode === "html" ? "html" : "text";
        const js = mode === "html"
          ? `({ url: location.href, title: document.title, html: document.documentElement.outerHTML.slice(0, 20000) })`
          : `({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 6000) })`;
        const r = await wv.executeJavaScript(js);
        return { ok: true, data: r };
      }

      case "snapshot": {
        const wv = await curWv();
        const meta = await wv.executeJavaScript(`({ url: location.href, title: document.title })`);
        const els = await wv.executeJavaScript(COLLECT_JS);
        const inputs = await wv.executeJavaScript(COLLECT_INPUTS_JS);
        const list = (Array.isArray(els) ? els : []).slice(0, 80).map((e: any, i: number) => ({
          index: i + 1, tag: e.tag, text: e.text, selector: e.selector, x: e.x, y: e.y,
          
          frame: e.frame ?? 0,
        }));
        return { ok: true, data: { url: meta?.url, title: meta?.title, elements: list, inputs, popupNotice: takePopupNotice() } };
      }

      case "click": {
        const wv = await curWv();
        const selector = typeof cmd.selector === "string" ? cmd.selector : "";
        const text = typeof cmd.text === "string" ? cmd.text : "";
        const index = typeof cmd.index === "number" ? cmd.index : undefined;
        const cx = typeof cmd.x === "number" ? cmd.x : undefined;
        const cy = typeof cmd.y === "number" ? cmd.y : undefined;
        let pt: { x: number; y: number; what: string } | null = null;
        
        if (typeof cx === "number" && typeof cy === "number") {
          pt = { x: Math.round(cx), y: Math.round(cy), what: `坐标(${Math.round(cx)},${Math.round(cy)})` };
        }
        if (selector) {
          const r = await wv.executeJavaScript(`(() => { try { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2), what: (el.innerText||el.value||el.tagName).slice(0,40) }; } catch(e) { return null; } })()`);
          if (r) { pt = r; }
        }
        if (!pt && index !== undefined) {
          const els = await wv.executeJavaScript(COLLECT_JS);
          const e = Array.isArray(els) ? els[index - 1] : null;
          if (e) { pt = { x: e.x, y: e.y, what: `${e.tag}${e.text ? ` "${e.text}"` : ""}` }; }
        }
        if (!pt && text) {
          const r = await wv.executeJavaScript(`(() => { const t = ${JSON.stringify(text)}; const cands = Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,label,[role=button],[role=link]")); const el = cands.find((e) => ((e.innerText||e.value||e.getAttribute("aria-label")||e.getAttribute("placeholder")||"").trim().includes(t))); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2), what: (el.innerText||el.value||el.tagName).slice(0,40) }; })()`);
          if (r) { pt = r; }
        }
        if (!pt) { return { ok: false, error: `未找到可点元素（selector=${selector || "-"} text=${text || "-"} index=${index ?? "-"}）——请先 browser_snapshot 查看可用元素` }; }
        
        
        return await withWebviewFocus(wv, `点击网页元素${pt.what ? `：${pt.what}` : ""}`, async () => {
          wv.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y });
          wv.sendInputEvent({ type: "mouseDown", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
          await sleep(20);
          wv.sendInputEvent({ type: "mouseUp", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
          
          const observe = await observeAfter(wv, 600);
          return { ok: true, data: { clicked: pt.what, x: pt.x, y: pt.y, observe, popupNotice: takePopupNotice() } };
        });
      }

      case "type": {
        const wv = await curWv();
        const text = String(cmd.text ?? "");
        if (!text) { return { ok: false, error: "type 需要 text" }; }
        const selector = typeof cmd.selector === "string" ? cmd.selector : "";
        
        const js = `(() => {
          const sel = ${JSON.stringify(selector)};
          let el = sel ? document.querySelector(sel) : document.activeElement;
          if (!el) el = document.querySelector("input,textarea,[contenteditable=true]");
          if (!el) return false;
          el.scrollIntoView({ block: "center" });
          el.focus();
          const v = ${JSON.stringify(text)};
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(el, v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            el.textContent = v;
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
          }
          return true;
        })()`;
        const done = await wv.executeJavaScript(js);
        if (!done) { return { ok: false, error: "未找到可输入的输入框（可传 selector 指定）" }; }
        
        return await withWebviewFocus(wv, `在网页中输入 ${text.length} 个字符`, async () => {
          if (cmd.submit) {
            wv.sendInputEvent({ type: "keyDown", keyCode: "Return" });
            wv.sendInputEvent({ type: "char", keyCode: "\r" });
            wv.sendInputEvent({ type: "keyUp", keyCode: "Return" });
            await sleep(600);
          }
          
          const observe = await observeAfter(wv, cmd.submit ? 900 : 400);
          return { ok: true, data: { typed: text.slice(0, 40), submitted: Boolean(cmd.submit), observe } };
        });
      }

      case "press": {
        const wv = await curWv();
        const key = String(cmd.key ?? "");
        if (!key) { return { ok: false, error: "press 需要 key（如 Enter / Escape / Tab / ArrowDown）" }; }
        
        return await withWebviewFocus(wv, `向网页发送按键 ${key}`, async () => {
          wv.sendInputEvent({ type: "keyDown", keyCode: key });
          wv.sendInputEvent({ type: "keyUp", keyCode: key });
          
          const observe = await observeAfter(wv, 600);
          return { ok: true, data: { key, observe } };
        });
      }

      case "scroll": {
        const wv = await curWv();
        const dy = typeof cmd.delta === "number" ? cmd.delta : 600;
        
        return await withWebviewFocus(wv, `滚动网页 ${Math.round(dy)}px`, async () => {
          await runJs(wv, `(window.scrollBy(0, ${Math.round(dy)}), true)`);
          
          const observe = await observeAfter(wv, 450);
          return { ok: true, data: { scrolled: Math.round(dy), observe } };
        });
      }

      case "drag": {
        const wv = await curWv();
        const from = await resolvePoint(wv, cmd, "from");
        if (!from) { return { ok: false, error: "未定位到拖拽起点——请传 from_x/from_y 坐标（canvas/验证码场景用 browser_screenshot 定位），或 from_selector/from_text/from_index" }; }
        const to = await resolvePoint(wv, cmd, "to");
        if (!to) { return { ok: false, error: "未定位到拖拽终点——请传 to_x/to_y 坐标，或 to_selector/to_text/to_index" }; }
        const duration = Math.max(100, Math.min(8000, typeof cmd.durationMs === "number" ? cmd.durationMs : 800));
        const steps = typeof cmd.steps === "number" ? cmd.steps : 20;
        const jitter = cmd.jitter !== false;
        
        
        return await withWebviewFocus(wv, `拖拽网页元素：${from.what} → ${to.what}`, async () => {
          
          wv.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y });
          await sleep(60);
          wv.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
          
          await sleep(150);
          
          const stepMs = Math.max(5, Math.round(duration / steps));
          const path = buildDragPath(from, to, steps, jitter);
          for (const p of path) {
            wv.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
            await sleep(stepMs);
          }
          
          await sleep(80);
          wv.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 });
          
          const observe = await observeAfter(wv, 500);
          return { ok: true, data: { dragged: `${from.what} → ${to.what}`, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, durationMs: duration, steps: path.length, observe } };
        });
      }

      case "wait": {
        const ms = Math.max(0, Math.min(15000, typeof cmd.durationMs === "number" ? cmd.durationMs : 1000));
        await sleep(ms);
        return { ok: true, data: { waited: ms } };
      }

      case "screenshot": {
        const wv = await curWv();
        let marked = 0;
        if (cmd.marks !== false) {
          const els = await wv.executeJavaScript(COLLECT_JS);
          const list = (Array.isArray(els) ? els : []).slice(0, 60);
          if (list.length > 0) {
            await wv.executeJavaScript(overlayJs(list.map((e: any, i: number) => ({ index: i + 1, x: e.x, y: e.y, w: e.w, h: e.h, text: e.text }))));
            marked = list.length;
          }
        }
        await sleep(120);
        let dataUrl = "";
        try {
          const img = await wv.capturePage();
          dataUrl = typeof img?.toDataURL === "function" ? img.toDataURL() : "";
        } catch (e) {
          return { ok: false, error: `截图失败：${e instanceof Error ? e.message : String(e)}` };
        }
        if (marked > 0) { try { await wv.executeJavaScript(CLEAR_OVERLAY_JS); } catch {  } }
        if (!dataUrl) { return { ok: false, error: "截图返回为空" }; }
        return { ok: true, data: { dataUrl, marks: marked } };
      }

      default:
        return { ok: false, error: `未知浏览器指令：${kind || "(空)"}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    
    if (!(cmd as { __retried?: boolean }).__retried && /dom-ready|attached to the DOM|not ready|destroyed|Cannot read/i.test(msg)) {
      await sleep(500);
      return executeBrowserCommand({ ...cmd, __retried: true });
    }
    return { ok: false, error: msg };
  }
}
