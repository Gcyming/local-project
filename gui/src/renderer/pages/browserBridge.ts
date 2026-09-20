/**
 * gui/src/renderer/pages/browserBridge.ts — 右侧栏浏览器「指令执行桥」（A-976）。
 *
 * 背景：Agent 的工具在主进程执行，而右侧栏浏览器是 renderer 里的 <webview>。
 * 主进程把指令（navigate/click/type/read/snapshot/screenshot…）下发到 renderer，
 * 本模块负责在**当前激活的浏览器页**上把指令落地，并把结果回传主进程。
 *
 * 关键设计（对齐业界做法）：
 *  1. **元素优先于坐标**：`snapshot` 枚举可点元素（含稳定序号 + 文本 + CSS 选择器 + 中心点），
 *     调用方优先用 selector/text/index 点击，等价于安卓的 uiautomator 路线。
 *  2. **真实鼠标事件**：点击用 `sendInputEvent`（mouseMove/Down/Up），而非 `el.click()`，
 *     以免绕过前端的真实事件逻辑（多数现代框架需要 real event）。
 *  3. **文本输入用原生 setter + input 事件**：兼容 React/Vue 受控组件（直接改 value 不触发框架更新）。
 *  4. **截图标注**：注入临时浮层画编号框（Set-of-Mark），截完即移除——纯页面内实现，不依赖 nativeImage。
 *  5. **就绪前提**：所有非导航操作都先确保 `dom-ready`（Electron 硬性要求，见 waitDomReady）。
 */
import { SIDEBAR_OPEN_EVENT } from "./Markdown.js";
import { isBrowserSchemeUrl } from "../../shared/ipc.js";

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserHost {
  listTabs(): BrowserTabInfo[];
  /** 新建浏览器页；返回 tabId */
  openTab(url?: string, activate?: boolean): string;
  closeTab(tabId?: string): boolean;
  activateTab(tabId: string): boolean;
  activeTabId(): string | null;
}

/**
 * A-976 修复：确保右侧栏处于展开状态。
 * 收起时 webview 被隐藏（display:none / 宽度 0）→ 元素 rect 全为 0、capturePage 空白，
 * Agent 的点击/截图必然失败。App 监听 SIDEBAR_OPEN_EVENT 即展开（忽略 detail），
 * 这里只带 kind 不带 url，避免顺带导航。
 */
function expandSidebar(): void {
  try {
    window.dispatchEvent(new CustomEvent(SIDEBAR_OPEN_EVENT, { detail: { kind: "url" } }));
  } catch { /* 忽略 */ }
}

let host: BrowserHost | null = null;

export function setBrowserHost(h: BrowserHost | null): void {
  host = h;
}

/** webview 注册表：tabId → <webview> 实例（由 BrowserTabInstance 挂载/卸载时登记） */
const webviews = new Map<string, any>();

export function registerWebview(tabId: string, wv: unknown): void {
  webviews.set(tabId, wv);
}

export function unregisterWebview(tabId: string): void {
  webviews.delete(tabId);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等待 webview 可见（A-980-R11：非激活 tab 是 display:none → rect 全 0，坐标点击必失败；
 *  activateTab 切页后 React 重渲染到 flex 有延迟，必须等 rect 恢复正尺寸再操作，杜绝"点了没反应"） */
async function waitVisible(wv: any, timeoutMs = 2500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = (wv as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { return true; }
    } catch { /* 元素可能未挂载 */ }
    if (Date.now() > deadline) { return false; }
    await sleep(60);
  }
}

/* ═══ A-980-R：弹窗被拒通知（登录弹窗不再卡死 Agent 循环） ═══
 * 主进程 setWindowOpenHandler 现对任何 webContents 一律拒绝 window.open，并把被拒 URL
 * 经 preload 广播（slime:browser:popup-notice）。RightSidebar 收到后派发同名 window 事件，
 * 本模块记下最新一次被拒 URL；下一次 click/snapshot/navigate 工具结果里带回给 Agent：
 * 「站点试图打开新窗口(URL)，已拦截；如确需登录可 browser_navigate 到该地址」——
 * 模型不会再对着被弹窗盖住的状态空转。 */
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
      // A-980-R4：浏览器唤起类协议（bitbrowser:// 等）→ 已拦截，不要求装客户端、不反复尝试
      if (isBrowserSchemeUrl(url)) {
        pendingPopupNotice = `已拦截浏览器唤起链接（${scheme}://）——这类链接的目的是唤起另一款浏览器加载页面，对当前浏览无帮助，且外部浏览器收到指令会自己弹报错横幅；不要在浏览器里反复尝试。`;
      } else {
        pendingPopupNotice = `${scheme}:// 链接需要安装「${scheme}」客户端才能打开（当前系统未注册该协议）。请如实告知用户：这链接指向的应用未安装；不要在浏览器里反复尝试。`;
      }
    } else {
      pendingPopupNotice = `站点刚试图弹出新窗口（${url}），已自动拦截（防弹窗盖页面卡死循环）。如确需在那里登录，可 browser_navigate 打开该地址。`;
    }
  }) as EventListener);
} catch { /* 非浏览器环境（单测）忽略 */ }

/** 取走（并清空）最近一次弹窗/协议通知文案；无则 null。 */
function takePopupNotice(): string | null {
  const v = pendingPopupNotice;
  pendingPopupNotice = null;
  return v;
}

/** A-980-R2：深度链接真实打开——经主进程探测系统协议处理器：已注册→系统应用打开；未注册→返回缺应用诊断。 */
async function tryOpenExternal(url: string): Promise<{ ok: boolean; handler?: string; error?: string }> {
  try {
    const api = (window as unknown as {
      slimeAPI?: { protocol?: { open?: (u: string) => Promise<{ ok?: boolean; handler?: string; reason?: string }> } }
    }).slimeAPI?.protocol;
    const r = await api?.open?.(url);
    if (r?.ok) { return { ok: true, handler: r.handler }; }
    // A-980-R4：浏览器唤起类协议（bitbrowser:// 等）→ 已拦截，不要求装客户端
    if (r?.reason === "browser-scheme" || isBrowserSchemeUrl(url)) {
      return { ok: false, error: `已拦截浏览器唤起链接 ${(url.split(":")[0] || "").toLowerCase()}:// ——不唤醒外部浏览器` };
    }
    return { ok: false, error: `链接 ${(url.split(":")[0] || "").toLowerCase()}:// 需要安装对应客户端才能打开（当前系统未注册该协议）。请如实告知用户，不要反复尝试。` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "无法打开该链接" };
  }
}

/* ═══ A-980：自定义协议链接守卫（bitbrowser:// 等） ═══
 * Windows 系统对话框「获取打开此'xxx'链接的应用」= 程序带着未知协议 URL 调了系统协议分发，
 * 系统没有注册该协议的应用就弹窗。webview 的 will-navigate **拦不住 loadURL/src 编程式导航**
 * （Electron 文档：will-navigate 仅覆盖用户点击/页面内导航），所以必须在**所有** URL 进入
 * webview 的入口（navigate/open/地址栏/openTab）做 scheme 白名单校验：非 Web 协议一律拒绝，
 * 根本不让 Chromium 把 bitbrowser:// 这类链接交给系统。 */
const SAFE_NAV_SCHEMES = new Set(["http", "https", "about", "file", "data", "blob"]);

/** URL 是否能安全交给右侧栏浏览器加载：http(s)/about/blank/file/data/blob 放行；未知协议拦截。 */
export function isWebNavUrl(raw: string | undefined): boolean {
  const url = (raw ?? "").trim();
  if (!url || url === "about:blank") { return true; }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!m) { return true; } // 无 scheme（将由调用方补 https://）
  return SAFE_NAV_SCHEMES.has(m[1].toLowerCase());
}

/**
 * A-980-R6：**统一 URL 归一**——把「用户可见地址」转换成可被 webview 直接加载的完整 URL。
 * 背景（用户实测）：点击 Agent/聊天返回的链接 `127.0.0.1:8081`（无协议头）新建页**白屏**，
 * 手动在地址栏输入 `http://127.0.0.1:8081` 却能进——因为链接路径把裸地址原样塞进 webview
 * `src`（无 scheme → 加载无效），而地址栏 `go()` 会补 `https://`（对本地 IP:端口 又会错拼成
 * https）。归一规则（按序）：
 *   ① `host:数字端口`（如 127.0.0.1:8081 / localhost:3000/a）→ 补 `http://`（本地服务默认 HTTP）；
 *   ② `scheme://` 完整协议头（https://… / bitbrowser://…）→ 原样保留（非 Web 协议由守卫拦截）；
 *   ③ 特殊协议 about:/file:/data:/blob: → 原样保留；
 *   ④ 其余带冒号的未知协议（mailto:a@b）→ 原样保留，交给 isWebNavUrl 拦截（绝不补 http）；
 *   ⑤ 纯裸地址（douyin.com / www.bilibili.com/v/xx）→ 补 `http://`（域名侧自会 301 到 https）。
 * 统一在「进入右栏浏览器的所有入口」调用：链接点击（onOpen）、props.url 同步、地址栏 go()、
 * Agent browser_navigate。
 */
export function normalizeBrowserUrl(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s || s === "about:blank") { return s; }
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d+/.test(s)) { return `http://${s}`; }        // ① host:端口（域名/IP/localhost）
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) { return s; }                   // ② scheme://
  if (/^(about|file|data|blob):/i.test(s)) { return s; }                       // ③ 特殊协议
  if (s.includes(":")) { return s; }                                           // ④ 未知协议
  return `http://${s}`;                                                        // ⑤ 裸地址
}

/** 轮询等待某个 tab 的 webview 就绪（新建页后 React 挂载有延迟） */
async function awaitWebview(tabId: string, timeoutMs = 4000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const wv = webviews.get(tabId);
    if (wv) { return wv; }
    if (Date.now() > deadline) { return null; }
    await sleep(60);
  }
}

/**
 * A-976 修复：**等待 webview 的 dom-ready**。
 * Electron 硬性要求——webview 未 emit `dom-ready` 之前，`executeJavaScript` / `sendInputEvent` /
 * `capturePage` 全部抛 "The WebView must be attached to the DOM and the dom-ready event emitted
 * before this method can be called"。而 `loadURL`（导航）**不需要** dom-ready，
 * 这正是"只能进网址、无法进行任何操作"的根因。
 */
const domReady = new WeakMap<any, boolean>();

async function waitDomReady(wv: any, timeoutMs = 8000): Promise<boolean> {
  if (domReady.get(wv) === true) { return true; }
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const ok = (): void => {
      if (done) { return; }
      done = true;
      try { wv.removeEventListener("dom-ready", ok); wv.removeEventListener("did-fail-load", fail); } catch { /* 忽略 */ }
      domReady.set(wv, true);
      resolve(true);
    };
    const fail = (): void => {
      if (done) { return; }
      done = true;
      try { wv.removeEventListener("dom-ready", ok); wv.removeEventListener("did-fail-load", fail); } catch { /* 忽略 */ }
      resolve(false);
    };
    try {
      wv.addEventListener("dom-ready", ok);
      wv.addEventListener("did-fail-load", fail);
    } catch { /* 事件系统不可用 → 走超时 */ }
    setTimeout(() => {
      if (done) { return; }
      done = true;
      try { wv.removeEventListener("dom-ready", ok); wv.removeEventListener("did-fail-load", fail); } catch { /* 忽略 */ }
      resolve(domReady.get(wv) === true);
    }, timeoutMs);
  });
}

/** 导航到新文档后必须重置 ready 标记（新 document 需要重新 dom-ready） */
function resetDomReady(wv: any): void {
  domReady.delete(wv);
}

/**
 * 在 webview 里执行 JS（带就绪保证 + 一次重试）。
 * 有些场景 dom-ready 刚 fire、执行上下文还没切换完，首次调用仍会抛——重试一次即可覆盖。
 */
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

/** 等待 webview 加载完成（或超时；已加载则立即返回） */
async function waitLoaded(wv: any, timeoutMs = 15000): Promise<void> {
  try {
    if (typeof wv.isLoading === "function" && !wv.isLoading()) { return; }
  } catch { /* is-loading 不可用则直接等事件 */ }
  await new Promise<void>((resolve) => {
    let done = false;
    const fin = (): void => {
      if (done) { return; }
      done = true;
      try {
        wv.removeEventListener("did-stop-loading", fin);
        wv.removeEventListener("did-fail-load", fin);
      } catch { /* 忽略 */ }
      resolve();
    };
    try {
      wv.addEventListener("did-stop-loading", fin);
      wv.addEventListener("did-fail-load", fin);
    } catch { /* 事件不可用则仅靠超时 */ }
    setTimeout(fin, timeoutMs);
  });
}

/** 枚举可点元素的注入脚本（序号稳定：同一页面重复调用顺序一致）。
 *  A-980-R12：**穿透同源 iframe**——站点登录/功能常把按钮放进 iframe（跨域 iframe 读不到
 *  contentDocument 自动跳过），iframe 内元素坐标叠加 iframe 矩形偏移到宿主视口；带 frame 标记
 *  供模型感知（iframe 内元素的 selector 只在该 iframe 文档内有效，点击走坐标优先）。 */
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

/** 收集文本型输入框（供 snapshot 提示） */
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

/* ═══ A-980：动作后紧凑观察（点击即观察 / Click-and-Observe） ═══
 * 业界共识（Anthropic CU 工具结果回传状态；OSWorld-Human 论文：actions grouped per
 * observation 可省一多半回合，LLM planning 占任务耗时 75-94%，回合数减半 ≈ 耗时减半）：
 * 每次变更性动作（click/type/press/scroll/drag）执行后，直接回传**当前画面主要可交互元素**
 * 的紧凑清单，模型无需再额外调 browser_snapshot 看"点完之后发生了什么"——一次省 1 轮模型往返
 * （每轮 1-3s prefill + decode），正是"Agent 操控墨迹半天"的主要优化点。
 * 与完整 snapshot 的区别：只取视口内**面积最大**的 12 个元素（大卡片/视频封面优先），
 * 文本截断 40 字符，Token 开销极小；脚本确定性（同一画面重复调用结果一致）。 */
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

/**
 * A-980：动作后观察（点击即观察）。 settleMs 后取 OBSERVE_JS 结果转成紧凑文本；
 * 页面导航中 / DOM 不可用等失败场景返回一句提示（不中断动作结果）。
 */
async function observeAfter(wv: any, settleMs: number): Promise<string> {
  await sleep(settleMs);
  // 页面正在加载（点击后出现的新导航）→ executeJavaScript 会等新文档就绪而挂起——直接给提示，不等
  try {
    if (typeof wv.isLoading === "function" && wv.isLoading()) {
      return "（页面加载中——可 browser_wait / browser_snapshot 查看新状态）";
    }
  } catch { /* 不阻塞观察 */ }
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

/** 浮层标注：画编号框（截图用，截后移除） */
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

/* ── 拖拽轨迹（A-978：browser_drag）──
 * 业界共识（Playwright dragTo steps / page.mouse 序列、主流滑块验证码自动化方案）：
 * 拖拽不是"一步到位的 mousemove"，而是 按下 → 多步插值移动（缓动 + 微抖）→ 松开。
 * 多步中间事件让依赖 dragover / 逐帧 mousemove 的组件（canvas 滑块等）真正响应；
 * ease-out 缓动 + 小幅度随机抖动模拟人手轨迹，规避风控的机械直线特征。
 * 抽成纯函数：无 DOM / Electron 依赖，vitest 可直测（防"顺手优化正则"式回归）。 */
export interface DragPoint { x: number; y: number; }

/**
 * 生成拖拽移动路径（起点按下后、终点松开前的中间插值点序列，含精确终点）。
 * @param from  起点（按下位置）
 * @param to    终点（松开位置）
 * @param steps 中间步数（钳制 2..80）
 * @param jitter 是否叠加 ±2px 微抖动（默认 true，模拟人手；测试传 false 保证确定性）
 * @param rnd   随机源（默认 Math.random；测试可注入固定序列）
 */
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
    // ease-out 缓动：开头移动快、接近终点减速，接近人手拖拽轨迹
    const ease = 1 - (1 - t) * (1 - t);
    let x = from.x + (to.x - from.x) * ease;
    let y = from.y + (to.y - from.y) * ease;
    if (jitter) { x += rnd() * 4 - 2; y += rnd() * 4 - 2; }
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  out.push({ x: Math.round(to.x), y: Math.round(to.y) }); // 确保精确落到终点（抖动不引入终点偏移）
  return out;
}

/**
 * 解析拖拽/点击的定位点（与 browser_click 同语义，前缀化）：
 * 坐标优先（${prefix}x/${prefix}y）→ selector → index → text。
 * @param prefix 参数前缀："from" 或 "to"
 */
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

/** 单条指令执行（主进程下行） */
export async function executeBrowserCommand(cmd: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!host) { return { ok: false, error: "右侧栏未就绪（浏览器宿主未注册；请确认右侧栏已打开）" }; }
  const kind = String(cmd?.kind ?? "");
  const explicitTab = typeof cmd.tabId === "string" && cmd.tabId ? cmd.tabId : undefined;
  const curId = (): string | null => explicitTab ?? host!.activeTabId();
  const curWv = async (): Promise<any> => {
    const id = curId();
    if (!id) { throw new Error("没有可用的浏览器页——请先 browser_navigate 打开一个网址"); }
    // 激活目标页：隐藏（display:none）时元素 rect 为 0、capturePage 可能空白，
    // 且让用户能看见 Agent 的操作过程（可解释性）。
    expandSidebar();                 // 右侧栏收起时先展开（否则 webview 隐藏 → 操作必失败）
    try { host!.activateTab(id); } catch { /* 忽略 */ }
    // A-980-R11：先等 webview 可见再操作——非激活 tab display:none 切过来后 rect 为 0，
    // 不等就发坐标点击/截图必然落空（"点了没反应"的高发原因之一）
    const wv = await awaitWebview(id);
    if (!wv) { throw new Error("浏览器页尚未就绪（webview 未挂载）"); }
    await waitVisible(wv);
    await sleep(40);               // 布局稳定余量
    // ★ A-976 修复：必须等 dom-ready，否则 executeJavaScript/sendInputEvent/capturePage 全部被 Electron 拒绝
    //（这正是"能导航、不能操作"的根因——loadURL 不需要 ready，其余操作都需要）。
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
        // A-980-R2：非 Web 协议不创建浏览器页，改为「真实打开」——探测系统处理器交给系统应用
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
        // A-980-R6：统一归一（裸地址补 http://）——Agent 若给 127.0.0.1:8081 等裸地址也直接可加载
        url = normalizeBrowserUrl(url);
        // A-980-R2：非 Web 协议不再拒绝/不再 https 前缀化，改为「真实打开」——探测系统处理器，
        // 已注册（装了对应客户端）→ 交给系统应用打开，链接目的达成、报错消失；未注册 → 明确诊断缺应用。
        if (!isWebNavUrl(url)) {
          const scheme = (url.split(":")[0] || "").toLowerCase();
          if (scheme === "slime") { return { ok: false, error: "slime:// 平台链接请使用平台内打开方式（如点击聊天里的链接）" }; }
          const ext = await tryOpenExternal(url);
          if (ext.ok) { return { ok: true, data: { systemOpened: true, url, handler: ext.handler } }; }
          return { ok: false, error: ext.error };
        }
        expandSidebar();               // 先展开右侧栏（收起时 webview 隐藏）
        await sleep(40);               // A-980：120ms → 40ms（纯粹省去冗余等待）
        let id = curId();
        if (!id) { id = host.openTab(url, true); }
        let wv = await awaitWebview(id);
        // 空白页可能刚建、webview 还在挂载：先等它出现
        const deadline = Date.now() + 4000;
        while (!wv && Date.now() < deadline) { await sleep(80); wv = await awaitWebview(id, 300); }
        if (!wv) { return { ok: false, error: "浏览器页未就绪（webview 未挂载）" }; }
        resetDomReady(wv);           // 新文档要重新 dom-ready
        wv.loadURL(url);
        // A-980-R：**不再 waitLoaded（等整页加载完）**——重度站点（视频/富媒体）整页加载
        // 可达 10-15s，Agent 只需 DOM 就绪即可 snapshot/点击；等整页加载是"打开网址墨迹半天"主因之一。
        await waitDomReady(wv, 10000); // ★ 等新页面 dom-ready（后续操作才可用）
        await sleep(150);            // 给 SPA 首屏渲染留时间（dom-ready 后骨架即出）
        const finalUrl = ((): string => { try { return wv.getURL(); } catch { return url; } })();
        return { ok: true, data: { tabId: id, url: finalUrl, popupNotice: takePopupNotice() } };
      }

      case "back": { const wv = await curWv(); try { wv.goBack(); } catch { /* noop */ } resetDomReady(wv); await waitDomReady(wv, 8000); await sleep(300); return { ok: true }; }
      case "forward": { const wv = await curWv(); try { wv.goForward(); } catch { /* noop */ } resetDomReady(wv); await waitDomReady(wv, 8000); await sleep(300); return { ok: true }; }
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
          // A-980-R12：iframe 内元素标记（其 selector 只在 iframe 文档内有效，提示模型走坐标点击）
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
        // 显式坐标优先（页面像素坐标，与 getBoundingClientRect 同基准）
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
        // A-980-R11：webview 失焦后首次 sendInputEvent 可能被丢弃（Electron 已知行为，
        // 焦点从宿主页移入 webview 的那一次点击无效）——点击前显式聚焦 + 短等，保证必点中
        try { wv.focus(); } catch { /* 忽略 */ }
        await sleep(30);
        wv.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y });
        wv.sendInputEvent({ type: "mouseDown", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        await sleep(20);
        wv.sendInputEvent({ type: "mouseUp", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
        // A-980：点击即观察——点击后直接回传主要元素，省掉模型再调 browser_snapshot 的一整轮
        const observe = await observeAfter(wv, 600);
        return { ok: true, data: { clicked: pt.what, x: pt.x, y: pt.y, observe, popupNotice: takePopupNotice() } };
      }

      case "type": {
        const wv = await curWv();
        const text = String(cmd.text ?? "");
        if (!text) { return { ok: false, error: "type 需要 text" }; }
        const selector = typeof cmd.selector === "string" ? cmd.selector : "";
        // 原生 setter + input/change 事件：兼容 React/Vue 受控组件
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
        if (cmd.submit) {
          wv.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wv.sendInputEvent({ type: "char", keyCode: "\r" });
          wv.sendInputEvent({ type: "keyUp", keyCode: "Return" });
          await sleep(600);
        }
        // A-980：输入即观察（回车提交后页面往往变化，直接回传新状态主要元素）
        const observe = await observeAfter(wv, cmd.submit ? 900 : 400);
        return { ok: true, data: { typed: text.slice(0, 40), submitted: Boolean(cmd.submit), observe } };
      }

      case "press": {
        const wv = await curWv();
        const key = String(cmd.key ?? "");
        if (!key) { return { ok: false, error: "press 需要 key（如 Enter / Escape / Tab / ArrowDown）" }; }
        // 键盘事件只会送到**聚焦**的元素/页面——先聚焦 webview，否则按键落空（静默失效）
        try { wv.focus(); } catch { /* 忽略 */ }
        await sleep(40);
        wv.sendInputEvent({ type: "keyDown", keyCode: key });
        wv.sendInputEvent({ type: "keyUp", keyCode: key });
        // A-980：按键即观察（Enter 提交等场景页面会变，回传新状态避免模型再快照）
        const observe = await observeAfter(wv, 600);
        return { ok: true, data: { key, observe } };
      }

      case "scroll": {
        const wv = await curWv();
        const dy = typeof cmd.delta === "number" ? cmd.delta : 600;
        await runJs(wv, `(window.scrollBy(0, ${Math.round(dy)}), true)`);
        // A-980：滚动即观察（懒加载页面滚动后常出新内容，直接回传）
        const observe = await observeAfter(wv, 450);
        return { ok: true, data: { scrolled: Math.round(dy), observe } };
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
        // A-980-R11：拖拽同样先聚焦 webview（失焦后首次 sendInputEvent 会被丢弃）
        try { wv.focus(); } catch { /* 忽略 */ }
        await sleep(30);
        // ① 移动到起点 → 按下（真实鼠标事件，canvas/pointer 监听都能收到）
        wv.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y });
        await sleep(60);
        wv.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
        // ② 按住停顿（真实用户按下后不会立即拖动）
        await sleep(150);
        // ③ 多步插值移动（缓动 + 微抖），每步一小段真实 mousemove
        const stepMs = Math.max(5, Math.round(duration / steps));
        const path = buildDragPath(from, to, steps, jitter);
        for (const p of path) {
          wv.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
          await sleep(stepMs);
        }
        // ④ 终点松开
        await sleep(80);
        wv.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 });
        // A-980：拖拽即观察（滑块是否归位等直接回传）
        const observe = await observeAfter(wv, 500);
        return { ok: true, data: { dragged: `${from.what} → ${to.what}`, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, durationMs: duration, steps: path.length, observe } };
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
        if (marked > 0) { try { await wv.executeJavaScript(CLEAR_OVERLAY_JS); } catch { /* 忽略 */ } }
        if (!dataUrl) { return { ok: false, error: "截图返回为空" }; }
        return { ok: true, data: { dataUrl, marks: marked } };
      }

      default:
        return { ok: false, error: `未知浏览器指令：${kind || "(空)"}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 就绪类竞态（dom-ready / 上下文切换）→ 稍等后**整条指令重试一次**，避免偶发失败被误报为"不支持"
    if (!(cmd as { __retried?: boolean }).__retried && /dom-ready|attached to the DOM|not ready|destroyed|Cannot read/i.test(msg)) {
      await sleep(500);
      return executeBrowserCommand({ ...cmd, __retried: true });
    }
    return { ok: false, error: msg };
  }
}
