/**
 * A-1137：搜索页接入右栏浏览器 + 对话侧实时监测。
 *
 * ## 这组守卫为什么必须存在（每一条都对应一个「静默失效」）
 * 1. **右栏浏览器页是 `<webview>`（独立顶层 frame）** ⇒ 页面里 `window.parent === window`，
 *    搜索页原设计的 `postMessage` 通道**天然失效**；接入只能靠 guest preload + IPC。
 *    ⇒ 一旦有人把 guest preload 从 webview 上摘掉，页面只是「能看但搜不动」，**没有任何报错**。
 * 2. **`gui/src/preload/searchHost.cjs` 不受任何静态检查**（`gui/tsconfig.json` 的 `include` 只含
 *    `src/` 下的 `.ts`；它也不进 electron-vite 构建）⇒ 语法错不会在构建期炸，
 *    只会在运行期「preload 加载即抛 ⇒ 页面永远未接入」。**真踩过**：块注释里写了路径通配，
 *    其中的 星号紧跟斜杠 提前闭合了块注释 ⇒ 整个文件 `SyntaxError`。所以这里**真在 vm 里跑它**。
 * 3. **两类 sender 必须两套白名单**：`search_host_info` / `search_view_get` 的 sender 是**主窗口**，
 *    而 `search_query` / `search_event` 的 sender 是 webview 的 **guest**。早先错用 guest 那条判据，
 *    后果是**开发模式下渲染层问不到搜索页**（dev 时渲染层 origin 是另一个端口 ⇒ 被拒），
 *    表现为「搜索页根本打不开」且 `hostInfo` 静默返回 `{ok:false}`。
 * 4. **广播是一次性的** ⇒ 渲染层晚挂载就永远空白；所以必须有 `search_view_get` 这条 pull 补课。
 *
 * ## 判据风格
 * 全部是**行为级**：真的把 IPC 注册进一个假 `ipcMain`、真的用假事件调 handler、真的在 `vm` 里
 * 执行 preload 源。不做「文件里有没有这段文本」的断言（那对「改了条件」是瞎的，本仓铁律 3）。
 * 只有两处例外（guest preload 的「channel 不许硬编码 / 只准 require electron」）——
 * 那要守的东西本身就是「源码里不该出现某个字面量」，且范围已钉死在注入后的全文上。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import vm from "node:vm";

/* ══════════ 假 electron：把 IPC 注册面抓在手里（模块级假件必须 hoist） ══════════ */

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  return {
    handlers,
    listeners,
    wcList: [] as { getURL(): string; send(ch: string, payload?: unknown): void; isDestroyed(): boolean }[],
    userData: "",
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); },
      on: (ch: string, fn: (...a: unknown[]) => void) => {
        const arr = listeners.get(ch) ?? [];
        arr.push(fn);
        listeners.set(ch, arr);
      },
    },
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => fake.userData },
  ipcMain: fake.ipcMain,
  webContents: { getAllWebContents: () => fake.wcList },
}));

import { IPC_CHANNELS } from "../../gui/src/shared/ipc.js";
import { viewFromPageEvent } from "../../gui/src/shared/searchView.js";
import { APP_THEMES, searchThemeOf } from "../../gui/src/shared/searchTheme.js";
import {
  registerSearchBridge, ensureSearchPage, isTrustedSearchUrl, pushSearchTheme, getLastPageTheme,
  getSidebarSearchView, searchPageFingerprint, __resetSearchBridgeForTest,
  type SearchBridgeDeps,
} from "../../gui/src/main/searchBridge.js";
import {
  publishSidebarTab, describeSidebarSnapshot, getSidebarSnapshot, subscribeSidebarSnapshot,
  applySearchView, connectSidebarSearch, getSearchPageDelivery,
  __resetSidebarViewForTest, __resetSearchPageDeliveryForTest,
  type SidebarTabView,
} from "../../gui/src/renderer/pages/sidebarSearch.js";
import {
  parseBingItems, parseBaiduItems, formatItemsForModel, isCaptchaHtml,
} from "../../core-ts/src/search/onlineSearch.js";

const ROOT = join(__dirname, "..", "..");
const PRELOAD_SRC = join(ROOT, "gui", "src", "preload", "searchHost.cjs");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "a1137-"));
const SEARCH_URL = "http://127.0.0.1:45678/";

let userDataDir = mkdtempSync(join(TMP_ROOT, "userdata-"));

beforeEach(() => {
  userDataDir = mkdtempSync(join(TMP_ROOT, "userdata-"));
  fake.userData = userDataDir;
  fake.handlers.clear();
  fake.listeners.clear();
  fake.wcList = [];
  __resetSearchBridgeForTest();
  __resetSidebarViewForTest();
  __resetSearchPageDeliveryForTest();
  vi.unstubAllGlobals();
});

afterAll(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 临时目录清不掉不该让门禁红 */ }
});

/* ══════════════════════════ ① 页面事件 → 右栏视图（唯一翻译器） ══════════════════════════ */

describe("A-1137 ① 页面事件翻译（searchView.viewFromPageEvent）", () => {
  it("results：拿到模式 / 检索词 / 条数 / 标题", () => {
    const v = viewFromPageEvent(
      { type: "results", mode: "online", query: "天气", count: 7, items: [{ title: "a" }, { title: "b" }] },
      3,
    );
    expect(v).not.toBeNull();
    expect(v!.mode).toBe("online");
    expect(v!.query).toBe("天气");
    expect(v!.count).toBe(7);
    expect(v!.titles).toEqual(["a", "b"]);
    expect(v!.seq).toBe(3);
  });

  it("**未知事件类型返回 null**（宁可对话侧不更新，也不显示一个右栏并没有的状态）", () => {
    expect(viewFromPageEvent({ type: "某个将来才有的类型" }, 1)).toBeNull();
    expect(viewFromPageEvent({ type: "" }, 1)).toBeNull();
    expect(viewFromPageEvent({}, 1)).toBeNull();
  });

  it("非对象输入也返回 null（页面是不可信输入）", () => {
    expect(viewFromPageEvent(null, 1)).toBeNull();
    expect(viewFromPageEvent(undefined, 1)).toBeNull();
    expect(viewFromPageEvent("results", 1)).toBeNull();
    expect(viewFromPageEvent(42, 1)).toBeNull();
  });

  it("count 缺失时用标题条数兜底；非数字的 count 不被信任", () => {
    const a = viewFromPageEvent({ type: "results", items: [{ title: "a" }, { title: "b" }, { title: "c" }] }, 1)!;
    expect(a.count).toBe(3);
    const b = viewFromPageEvent({ type: "results", count: "9", items: [{ title: "a" }] }, 1)!;
    expect(b.count).toBe(1);
  });

  it("`online` 与 `web` 都算联网；其余一律本地（v3.2.0 把两模式合并成「全网」，枚举值是 web）", () => {
    for (const m of ["online", "web"]) {
      expect(viewFromPageEvent({ type: "results", mode: m }, 1)!.mode, `mode=${m} 必须算联网`).toBe("online");
    }
    for (const m of ["local", "ONLINE", "WEB", "Web", "", 7, null, undefined]) {
      expect(viewFromPageEvent({ type: "results", mode: m }, 1)!.mode, `mode=${String(m)} 不是联网`).toBe("local");
    }
    /* 切模式事件同理：`hostNotify('mode', {mode: state.mode})` 里 `state.mode` 就是 `'web'`
       ⇒ 认不出来时，用户切到「全网」会被对话侧显示成「本地索引」。 */
    expect(viewFromPageEvent({ type: "mode", mode: "web" }, 1)!.mode).toBe("online");
  });

  it("open：opened 记下标题（缺标题时回落到第一条结果标题）", () => {
    const v = viewFromPageEvent(
      { type: "open", query: "q", url: "https://x.test/a", title: "标题A", items: [{ title: "首条" }] },
      1,
    )!;
    expect(v.opened).toEqual({ title: "标题A", url: "https://x.test/a", path: undefined });

    const v2 = viewFromPageEvent({ type: "open", url: "https://x.test/b", items: [{ title: "首条" }] }, 2)!;
    expect(v2.opened!.title).toBe("首条");

    const v3 = viewFromPageEvent({ type: "open", url: "https://x.test/c" }, 3)!;
    expect(v3.opened!.title).toBe("");
  });

  it("open 带本地路径时保留 path（联网是 url，本地是文档路径）", () => {
    const v = viewFromPageEvent({ type: "open", path: "D:/doc/a.md", title: "a.md" }, 1)!;
    expect(v.opened!.path).toBe("D:/doc/a.md");
  });

  it("**page：条数沿用上一份**（翻页只是换了结果页，页面这次没带 count ⇒ 别清成 0）", () => {
    const prev = viewFromPageEvent({ type: "results", count: 12, items: [{ title: "x" }] }, 1)!;
    const next = viewFromPageEvent({ type: "page", page: 2, query: "q" }, 2, prev)!;
    expect(next.count).toBe(12);
    expect(next.titles).toEqual([]);
    expect(next.query).toBe("q");
  });

  it("page：没有 prev 时退化成 0（不编造一个条数）", () => {
    expect(viewFromPageEvent({ type: "page", page: 2 }, 1, null)!.count).toBe(0);
  });

  it("index：清空检索词，条数来自 docs（建索引不是检索）", () => {
    const v = viewFromPageEvent({ type: "index", docs: 321, query: "不该显示" }, 1)!;
    expect(v.query).toBe("");
    expect(v.count).toBe(321);
    expect(viewFromPageEvent({ type: "index" }, 1)!.count).toBe(0);
  });

  it("error：记下页面报的错；缺文案时给一句默认的（否则状态条会显示空错误）", () => {
    expect(viewFromPageEvent({ type: "error", error: "引擎超时" }, 1)!.error).toBe("引擎超时");
    expect(viewFromPageEvent({ type: "error" }, 1)!.error).toBe("联网检索失败");
    expect(viewFromPageEvent({ type: "error", error: 5 }, 1)!.error).toBe("联网检索失败");
  });

  it("ready / mode：条数与标题都归零（切模式不是一次检索）", () => {
    const r = viewFromPageEvent({ type: "ready", mode: "online" }, 1)!;
    expect(r).toMatchObject({ mode: "online", query: "", count: 0, titles: [] });
    const m = viewFromPageEvent({ type: "mode", mode: "local" }, 2)!;
    expect(m).toMatchObject({ mode: "local", query: "", count: 0, titles: [] });
  });

  it("超长字段被截断（页面是不可信输入，别让一条事件撑爆状态条）", () => {
    const v = viewFromPageEvent(
      { type: "results", query: "q".repeat(500), items: [{ title: "t".repeat(500) }] },
      1,
    )!;
    expect(v.query.length).toBe(200);
    expect(v.titles[0].length).toBe(120);
    expect(viewFromPageEvent({ type: "open", url: "u".repeat(5000) }, 1)!.opened!.url.length).toBe(2000);
  });

  it("标题最多取前 8 条里的非空项；空标题被丢掉（空行会让状态条看着像卡住）", () => {
    /* 契约：先截前 8 条、再丢掉空标题 ⇒ 第 1 条是空标题时结果恰好 7 条。
       这个"先截后滤"的顺序是有意的（事件里最多只认 8 条，避免一条事件撑爆状态条）。 */
    const items = Array.from({ length: 20 }, (_, i) => ({ title: i === 0 ? "" : `t${i}` }));
    const v = viewFromPageEvent({ type: "results", items }, 1)!;
    expect(v.titles.length).toBe(7);
    expect(v.titles[0]).toBe("t1");
    expect(v.titles).not.toContain("");
    /* 全部非空时就是 8 条（不是 20 条） */
    const all = viewFromPageEvent({ type: "results", items: items.map((x) => ({ title: x.title || "x" })) }, 2)!;
    expect(all.titles.length).toBe(8);
  });
});

/* ══════════════════════════ ② guest preload：真在 vm 里跑 ══════════════════════════ */

/**
 * 在 `vm` 沙箱里执行 guest preload 源（**注入 channel 之后**的那个形态）。
 * 这是本 spec 最有价值的一条判据：它同时对「块注释提前闭合」这类**语法错**和
 * 「白名单失效（外网站点也拿到对象）」这两件事变红。
 */
function runPreload(opts: { injectChannels: boolean; protocol: string; hostname?: string }) {
  const raw = readFileSync(PRELOAD_SRC, "utf8");
  const placeholder = "/*__SLIME_CHANNELS__*/ null";
  if (!raw.includes(placeholder)) {
    throw new Error("guest preload 缺少 channel 注入锚点 —— 源文件被改坏了");
  }
  const src = opts.injectChannels ? raw.split(placeholder).join(JSON.stringify(IPC_CHANNELS)) : raw;

  const exposed: Record<string, Record<string, unknown>> = {};
  const sent: unknown[][] = [];
  const invoked: unknown[][] = [];
  const sandbox = {
    location: { protocol: opts.protocol, hostname: opts.hostname ?? "" },
    require: (name: string) => {
      if (name !== "electron") { throw new Error("guest preload 不许 require 别的模块：" + name); }
      return {
        contextBridge: { exposeInMainWorld: (k: string, v: Record<string, unknown>) => { exposed[k] = v; } },
        ipcRenderer: {
          invoke: (...a: unknown[]) => { invoked.push(a); return Promise.resolve({ ok: true }); },
          send: (...a: unknown[]) => { sent.push(a); },
          on: (...a: unknown[]) => { void a; },
        },
      };
    },
  };
  /* ⚠️ 这里**不 mock 掉语法错**：源里有语法错时 `runInNewContext` 立刻抛 ⇒ 守卫变红。
     这正是当初那个「preload 加载即抛、页面永远未接入、构建期零报错」的真 bug 的判据。 */
  vm.runInNewContext(src, vm.createContext(sandbox) as object);
  return { exposed, sent, invoked, src };
}

describe("A-1137 ② guest preload（searchHost.cjs）", () => {
  it("本机文档 + 已注入 channel ⇒ 暴露 SlimeBrowserHost，且六个成员齐备", () => {
    const { exposed } = runPreload({ injectChannels: true, protocol: "http:", hostname: "127.0.0.1" });
    const host = exposed.SlimeBrowserHost;
    expect(host, "guest 里没有 SlimeBrowserHost ⇒ 搜索页会一直显示未接入").toBeTruthy();
    expect(host.name).toBe("slime 浏览器内核");
    expect(Object.keys(host).sort()).toEqual(["getTheme", "name", "notify", "onTheme", "query", "reportTheme"]);
  });

  it("**外网站点拿不到对象**（右栏是通用浏览器，preload 对每次导航都执行）", () => {
    for (const host of ["www.baidu.com", "evil.test", "localhost.evil.test", "127.0.0.1.evil.test", "evil-127.0.0.1"]) {
      const { exposed } = runPreload({ injectChannels: true, protocol: "https:", hostname: host });
      expect(Object.keys(exposed), `${host} 竟然拿到了 SlimeBrowserHost`).toEqual([]);
    }
  });

  it("`file:` / `about:` 也放行（用户双击搜索页、webview 初始 blank 态）", () => {
    for (const protocol of ["file:", "about:"]) {
      const { exposed } = runPreload({ injectChannels: true, protocol, hostname: "" });
      expect(Object.keys(exposed), `${protocol} 应当放行`).toContain("SlimeBrowserHost");
    }
  });

  it("**channel 未注入就不暴露**（宁可页面明确报未接入，也不挂一个永远用不了的桥）", () => {
    const { exposed } = runPreload({ injectChannels: false, protocol: "http:", hostname: "127.0.0.1" });
    expect(Object.keys(exposed)).toEqual([]);
  });

  it("回环的四种写法都认（`http://[::1]` 的 hostname 是 `[::1]`）", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      const { exposed } = runPreload({ injectChannels: true, protocol: "http:", hostname: host });
      expect(Object.keys(exposed), `${host} 应当放行`).toContain("SlimeBrowserHost");
    }
  });

  it("query / notify / reportTheme 走的是**注入进来的** channel（不是硬编码）", async () => {
    const { exposed, sent, invoked } = runPreload({ injectChannels: true, protocol: "http:", hostname: "127.0.0.1" });
    const host = exposed.SlimeBrowserHost as {
      query: (q: unknown) => Promise<unknown>;
      notify: (e: unknown) => void;
      reportTheme: (d: unknown) => void;
    };
    await host.query("天气");
    expect(invoked[0][0]).toBe(IPC_CHANNELS.search_query);
    expect(invoked[0][1]).toEqual({ query: "天气" });

    await host.query(null);
    expect((invoked[1][1] as { query: string }).query).toBe("");

    host.notify({ type: "results" });
    expect(sent[0][0]).toBe(IPC_CHANNELS.search_event);
    host.reportTheme({ mode: "light" });
    expect(sent[1][0]).toBe(IPC_CHANNELS.search_theme_report);
  });

  it("源里**不许硬编码 channel 名**、**只准 require electron**（channel 唯一产地在 shared/ipc.ts）", () => {
    const { src } = runPreload({ injectChannels: true, protocol: "file:", hostname: "" });
    /* 注入后的形态里 channel 全来自注入对象 ⇒ 正文不该出现任何 channel 字面量。
       ⚠️ 要先把**注入进去的那段 JSON** 摘掉再查，否则它自己就是「字面量」。 */
    const withoutInjected = src.split(JSON.stringify(IPC_CHANNELS)).join("<ch>");
    expect(withoutInjected).not.toMatch(/slime:search:/);
    /* sandbox preload 根本不能 require node_modules ⇒ 引了就是运行期炸。
       ⚠️ 先剥注释再查：本文件的**块注释里就举过 `require('electron')` 这个例子**
       （不给它剥掉的话，扫到的会是注释而不是代码 —— 铁律 10「形状断言先剥注释」）。 */
    const code = withoutInjected.replace(/\/\*[\s\S]*?\*\//g, " ");
    const requires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(requires).toEqual(["electron"]);
  });

  it("源里绝不允许块注释被提前闭合（用真编译器判，不靠肉眼）", () => {
    /* 判据就是「能不能编译」—— 块注释体里一旦出现注释结束符（星号紧跟斜杠），
       剩下的散字立刻是 SyntaxError。真踩过一次：注释里写路径通配，整个文件加载即抛
       且构建期零报错。（本行特意用文字描述那个符号组合，不写出来才安全。） */
    const raw = readFileSync(PRELOAD_SRC, "utf8");
    let err = "";
    try { new vm.Script(raw); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    expect(err, "guest preload 编译不过 ⇒ 加载即抛 ⇒ 页面永远未接入（且构建期不报错）").toBe("");
  });
});

/* ═══════════════════ ③ 交付链 + 两类 sender（真注册、真调 handler） ═══════════════════ */

interface Sent { ch: string; payload: unknown }

function mkDeps(over: Partial<SearchBridgeDeps> = {}) {
  const sent: Sent[] = [];
  const win = { webContents: { send: (ch: string, payload: unknown) => { sent.push({ ch, payload }); } } };
  const deps: SearchBridgeDeps = {
    getTheme: () => "dark",
    getWindow: () => win as unknown as Electron.BrowserWindow,
    isMainSender: (s) => (s as unknown as { id?: number })?.id === 1,
    serve: async () => ({ ok: true, port: 45678, host: "127.0.0.1", id: "srv" }),
    ...over,
  };
  return { deps, sent };
}

/** 主窗口 sender（`isMainSender` 只认 id === 1）。 */
const MAIN = { id: 1 } as unknown as Electron.WebContents;
/** guest（webview 的 webContents）—— 永远不是主窗口。 */
const GUEST = { id: 2, getURL: () => SEARCH_URL } as unknown as Electron.WebContents;
/** 不可信的 guest（外网站点）。 */
const EVIL = { id: 3, getURL: () => "https://evil.test/" } as unknown as Electron.WebContents;

/** ⚠️ 必须支持**多参数**：`search_query` 的签名是 `(event, payload)` —— 只传 event 的话
 *  payload 恒为 undefined，于是「入参清洗」那几条会**因为错误的理由而绿**（本仓铁律 3）。 */
const call = <T,>(ch: string, ...args: unknown[]): T => (fake.handlers.get(ch) as (...a: unknown[]) => T)(...args);
const fire = (ch: string, ...args: unknown[]): void => {
  for (const fn of fake.listeners.get(ch) ?? []) { fn(...args); }
};

describe("A-1137 ③ 搜索页交付（ensureSearchPage / search_host_info）", () => {
  it("交付成功：返回 http 地址 + **已落盘的** guest preload 的 file:// 路径 + 指纹", async () => {
    const { deps } = mkDeps();
    registerSearchBridge(deps);
    const r = await call<Promise<{ ok: boolean; url?: string; preload?: string; fingerprint?: string }>>(
      IPC_CHANNELS.search_host_info, { sender: MAIN },
    );
    expect(r.ok).toBe(true);
    expect(r.url).toBe(SEARCH_URL);
    expect(r.preload).toMatch(/^file:\/\/\/.*searchHost\.cjs$/);
    expect(r.fingerprint).toBe(searchPageFingerprint());
    /* 成功判据是**磁盘上真有产物**，不是「函数返回了 ok」（铁律 28） */
    const file = fileURLToPath(r.preload!);
    expect(existsSync(file), "preload 没真落盘").toBe(true);
    const written = readFileSync(file, "utf8");
    expect(written).not.toContain("/*__SLIME_CHANNELS__*/");
    expect(written).toContain("SlimeBrowserHost");
    expect(existsSync(join(userDataDir, "slime-search", "page", "index.html"))).toBe(true);
  });

  it("**主窗口判据不看 URL**：dev 渲染层是 `http://localhost:PORT`，也必须放行（真 bug 的判据）", async () => {
    const { deps } = mkDeps();
    registerSearchBridge(deps);
    /* 注意 guest 那条判据对 `http://localhost:5173/` 是**拒绝**的 —— 这正是当初那个缺口 */
    expect(isTrustedSearchUrl("http://localhost:5173/")).toBe(false);
    const r = await call<Promise<{ ok: boolean }>>(IPC_CHANNELS.search_host_info, {
      sender: MAIN, senderFrame: { url: "http://localhost:5173/" },
    });
    expect(r.ok, "渲染层被 guest 白名单误拒 ⇒ 搜索页根本打不开（且 hostInfo 静默返回 ok:false）").toBe(true);
  });

  it("非主窗口索取搜索页信息 ⇒ 拒绝（返回可读原因，不静默）", async () => {
    const { deps } = mkDeps();
    registerSearchBridge(deps);
    const r = await call<Promise<{ ok: boolean; error?: string }>>(IPC_CHANNELS.search_host_info, { sender: GUEST });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未授权");
  });

  it("`isMainSender` 自己抛异常 ⇒ 当拒绝（异常不许穿透成放行）", async () => {
    const { deps } = mkDeps({ isMainSender: () => { throw new Error("boom"); } });
    registerSearchBridge(deps);
    const r = await call<Promise<{ ok: boolean }>>(IPC_CHANNELS.search_host_info, { sender: MAIN });
    expect(r.ok).toBe(false);
  });

  it("本地服务起不来 ⇒ 交付失败并说明原因（不给一个打不开的页面）", async () => {
    const { deps } = mkDeps({ serve: async () => ({ ok: false, error: "端口被占" }) });
    registerSearchBridge(deps);
    const r = await call<Promise<{ ok: boolean; error?: string }>>(IPC_CHANNELS.search_host_info, { sender: MAIN });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("端口被占");
  });

  it("**交付失败不缓存** ⇒ 第二次会重试（一次抖动 ≠ 永久打不开）", async () => {
    let n = 0;
    const { deps } = mkDeps({
      serve: async () => {
        n += 1;
        return n === 1 ? { ok: false, error: "还没起来" } : { ok: true, port: 45678, host: "127.0.0.1" };
      },
    });
    registerSearchBridge(deps);
    const a = await call<Promise<{ ok: boolean }>>(IPC_CHANNELS.search_host_info, { sender: MAIN });
    const b = await call<Promise<{ ok: boolean }>>(IPC_CHANNELS.search_host_info, { sender: MAIN });
    expect(a.ok).toBe(false);
    expect(b.ok, "第一次失败被永久记住了").toBe(true);
    expect(n).toBe(2);
  });

  it("**落盘是幂等的**：内容没变就不碰磁盘（否则每次都抖 mtime）", async () => {
    const { deps } = mkDeps();
    registerSearchBridge(deps);
    const first = await ensureSearchPage(deps);
    expect(first.ok).toBe(true);
    const preloadFile = fileURLToPath(first.preload!);
    const pageFile = join(userDataDir, "slime-search", "page", "index.html");
    const p1 = statSync(preloadFile).mtimeMs;
    const q1 = statSync(pageFile).mtimeMs;
    await new Promise((r) => setTimeout(r, 40));
    __resetSearchBridgeForTest();          // 清掉 delivered ⇒ 逼它重跑整条落盘路径
    const second = await ensureSearchPage(deps);
    expect(second.ok).toBe(true);
    expect(second.preload).toBe(first.preload);
    expect(statSync(preloadFile).mtimeMs, "内容没变却重写了 preload").toBe(p1);
    expect(statSync(pageFile).mtimeMs, "内容没变却重写了页面").toBe(q1);
  });

  it("交付成功后，**搜索页 origin 才被登记**为可信；未登记的站点一律不可信", async () => {
    const { deps } = mkDeps();
    expect(isTrustedSearchUrl(SEARCH_URL)).toBe(false);      // 还没交付
    registerSearchBridge(deps);
    await ensureSearchPage(deps);
    expect(isTrustedSearchUrl(SEARCH_URL)).toBe(true);
    expect(isTrustedSearchUrl(SEARCH_URL + "deep/page.html")).toBe(true);
    expect(isTrustedSearchUrl("https://www.baidu.com/")).toBe(false);
    expect(isTrustedSearchUrl("")).toBe(false);
    expect(isTrustedSearchUrl("不是地址")).toBe(false);
    expect(isTrustedSearchUrl("about:blank")).toBe(true);
    expect(isTrustedSearchUrl("file:///D:/x.html")).toBe(true);
  });
});

describe("A-1137 ③ guest 侧 handler 的白名单", () => {
  /**
   * guest 侧的可信判据是**搜索页 origin**，而 origin 只有在交付成功后才被登记
   * ⇒ 每条用例都必须先把页面交付掉，否则测的其实是"未授权"，全是假绿/假红。
   */
  async function setupDelivered(over: Partial<SearchBridgeDeps> = {}) {
    const { deps, sent } = mkDeps(over);
    registerSearchBridge(deps);
    const d = await ensureSearchPage(deps);
    expect(d.ok, "交付没成功 ⇒ 后面的白名单断言全都不可信").toBe(true);
    return { deps, sent, guestFrame: { sender: GUEST, senderFrame: { url: SEARCH_URL } } };
  }

  it("可信 frame 的检索入参被清洗（非字符串归零）；空查询在联网之前就被挡下", async () => {
    const { guestFrame } = await setupDelivered();
    for (const payload of [{ query: "   " }, { query: 123 }, "", null, {}]) {
      const r = await call<Promise<{ ok: boolean; error?: string }>>(IPC_CHANNELS.search_query, guestFrame, payload);
      expect(r.ok).toBe(false);
      /* 关键：可信 frame 得到的是「缺少查询词」。若白名单被换成 `isMainSender`，
         guest 会先撞上授权，这里变成「未授权」⇒ 本条变红（这才是它真正锁住的东西）。 */
      expect(r.error).toBe("缺少查询词");
    }
  });

  it("**不可信 frame 的检索被拒**（把本机当代理是右栏浏览器最现实的滥用）", async () => {
    const { guestFrame } = await setupDelivered();
    for (const url of ["https://evil.test/", "http://127.0.0.1:9999/"]) {
      const r = await call<Promise<{ ok: boolean; error?: string }>>(IPC_CHANNELS.search_query,
        { sender: GUEST, senderFrame: { url } }, { query: "q" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("未授权");
    }
    /* 顺带确认"可信"的那条不是碰巧：把入参换成非空才会真的联网 ⇒ 只断言它**没有**被授权拦下 */
    const trusted = await call<Promise<{ ok: boolean; error?: string }>>(IPC_CHANNELS.search_query, guestFrame, { query: "   " });
    expect(trusted.error).not.toContain("未授权");
  });

  it("取主题：不可信 frame 一律给 dark（不泄露任何主程序状态）", async () => {
    const { deps } = mkDeps({ getTheme: () => "light" });
    registerSearchBridge(deps);
    await ensureSearchPage(deps);
    expect(call<string>(IPC_CHANNELS.search_theme_get, { sender: GUEST, senderFrame: { url: "https://evil.test/" } })).toBe("dark");
    expect(call<string>(IPC_CHANNELS.search_theme_get, { sender: GUEST, senderFrame: { url: SEARCH_URL } })).toBe("light");
    expect(call<string>(IPC_CHANNELS.search_theme_get, { sender: GUEST, senderFrame: { url: "file:///D:/x.html" } })).toBe("light");
  });

  it("guest 上报事件 ⇒ 归一化后**广播给主窗口**，并留下可 pull 的最近视图", async () => {
    const { sent, guestFrame } = await setupDelivered();
    fire(IPC_CHANNELS.search_event, guestFrame, { type: "results", mode: "online", query: "天气", count: 3 });
    expect(sent.length).toBe(1);
    expect(sent[0].ch).toBe(IPC_CHANNELS.search_view_changed);
    expect((sent[0].payload as { query: string }).query).toBe("天气");
    expect(getSidebarSearchView()?.query).toBe("天气");
    /* 序号由 main 持有并递增（翻译函数是纯函数、序号是显式入参 ⇒ 两个进程各加载一次也不会错乱） */
    fire(IPC_CHANNELS.search_event, guestFrame, { type: "results", query: "第二个", count: 1 });
    const v2 = getSidebarSearchView()!;
    expect(v2.query).toBe("第二个");
    expect(v2.seq).toBeGreaterThan(1);
  });

  it("**不可信 frame 上报事件 ⇒ 不广播**（否则任何站点都能伪造「右栏打开了 X」）", async () => {
    const { sent } = await setupDelivered();
    fire(IPC_CHANNELS.search_event, { sender: EVIL, senderFrame: { url: "https://evil.test/" } },
      { type: "results", query: "伪造" });
    expect(sent).toEqual([]);
    expect(getSidebarSearchView()).toBeNull();
  });

  it("看懂不了的事件（未知类型）⇒ 不广播、也不清掉上一份视图", async () => {
    const { sent, guestFrame } = await setupDelivered();
    fire(IPC_CHANNELS.search_event, guestFrame, { type: "results", query: "真" });
    fire(IPC_CHANNELS.search_event, guestFrame, { type: "将来才有的类型" });
    expect(sent.length).toBe(1);
    expect(getSidebarSearchView()?.query).toBe("真");
  });

  it("`search_view_get`：主窗口能 pull 到最近视图；**非主窗口拿不到**（这条就是「错过广播不再永久瞎」）", async () => {
    const { guestFrame } = await setupDelivered();
    expect(call<unknown>(IPC_CHANNELS.search_view_get, { sender: MAIN })).toBeNull();
    fire(IPC_CHANNELS.search_event, guestFrame, { type: "results", query: "补课", count: 2 });
    expect((call<{ query: string } | null>(IPC_CHANNELS.search_view_get, { sender: MAIN }))?.query).toBe("补课");
    expect(call<unknown>(IPC_CHANNELS.search_view_get, { sender: GUEST })).toBeNull();
  });

  it("页面自报主题：只记录、只认真实枚举；主程序主题另有产地（不在这里反向覆盖）", async () => {
    const { guestFrame } = await setupDelivered();
    expect(getLastPageTheme()).toBeNull();
    fire(IPC_CHANNELS.search_theme_report, guestFrame, { mode: "将来才有的值" });
    expect(getLastPageTheme()).toBeNull();
    fire(IPC_CHANNELS.search_theme_report, guestFrame, { mode: "light" });
    expect(getLastPageTheme()).toBe("light");
    fire(IPC_CHANNELS.search_theme_report, { sender: EVIL, senderFrame: { url: "https://evil.test/" } }, { mode: "auto" });
    expect(getLastPageTheme(), "外网 frame 改掉了记录的页面主题").toBe("light");
  });

  it("推主题只发给**可信**的搜索页（外网 frame 不该收到主程序状态；已销毁的跳过）", async () => {
    const { deps } = mkDeps();
    registerSearchBridge(deps);
    await ensureSearchPage(deps);
    const got: string[] = [];
    fake.wcList = [
      { getURL: () => SEARCH_URL, send: (ch) => { got.push("trusted:" + ch); }, isDestroyed: () => false },
      { getURL: () => "https://evil.test/", send: (ch) => { got.push("evil:" + ch); }, isDestroyed: () => false },
      { getURL: () => SEARCH_URL, send: () => { throw new Error("destroyed"); }, isDestroyed: () => true },
    ];
    pushSearchTheme("dark");
    expect(got).toEqual(["trusted:" + IPC_CHANNELS.search_theme]);
  });
});

/* ══════════════════ ④ 对话侧视图 store（渲染层汇合点） ══════════════════ */

const tab = (kind: SidebarTabView["kind"], url: string, title = ""): SidebarTabView => ({ kind, url, title });

describe("A-1137 ④ 右栏视图 store（sidebarSearch）", () => {
  it("空快照 ⇒ describe 返回 null（不渲染一条写着「右栏没开东西」的噪音条）", () => {
    expect(describeSidebarSnapshot(getSidebarSnapshot())).toBeNull();
    expect(describeSidebarSnapshot(null)).toBeNull();
    expect(describeSidebarSnapshot(undefined)).toBeNull();
  });

  it("**离开搜索页就必须把 search 清零**（把历史当现状比不显示更坏）", () => {
    publishSidebarTab(tab("browser", SEARCH_URL), SEARCH_URL);
    applySearchView(viewFromPageEvent({ type: "results", mode: "online", query: "天气", count: 3 }, 1));
    expect(getSidebarSnapshot().search?.query).toBe("天气");

    publishSidebarTab(tab("browser", "https://www.baidu.com/"), SEARCH_URL);
    expect(getSidebarSnapshot().search, "换了站点还留着搜索页视图").toBeNull();

    publishSidebarTab(tab("browser", SEARCH_URL), SEARCH_URL);
    applySearchView(viewFromPageEvent({ type: "results", query: "q2", count: 1 }, 2));
    publishSidebarTab(tab("terminal", "bash"), SEARCH_URL);
    expect(getSidebarSnapshot().search, "切到终端页签还留着搜索页视图").toBeNull();
  });

  it("**searchUrl 未知（空串）时不认搜索页**（宁可不认，也不猜）", () => {
    publishSidebarTab(tab("browser", SEARCH_URL), "");
    expect(getSidebarSnapshot().search).toBeNull();
  });

  it("applySearchView(null) 不产生新快照（不伪造、也不惊动订阅方）", () => {
    publishSidebarTab(tab("browser", SEARCH_URL), SEARCH_URL);
    const before = getSidebarSnapshot();
    applySearchView(null);
    expect(getSidebarSnapshot()).toBe(before);
    applySearchView(viewFromPageEvent({ type: "未知类型" }, 1));
    expect(getSidebarSnapshot()).toBe(before);
  });

  it("快照序号单调递增（订阅方据此判断「是不是新的一条」）", () => {
    const a = getSidebarSnapshot().seq;
    publishSidebarTab(tab("terminal", "bash"), SEARCH_URL);
    const b = getSidebarSnapshot().seq;
    publishSidebarTab(tab("file", "D:/x.md"), SEARCH_URL);
    const c = getSidebarSnapshot().seq;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("订阅能收到、退订后收不到（同步派发，不靠 etc 延时）", () => {
    const got: number[] = [];
    const off = subscribeSidebarSnapshot((s) => { got.push(s.seq); });
    publishSidebarTab(tab("terminal", "bash"), SEARCH_URL);
    expect(got.length).toBe(1);
    off();
    publishSidebarTab(tab("file", "D:/y.md"), SEARCH_URL);
    expect(got.length, "退订之后还在收").toBe(1);
  });

  it("一个订阅方抛异常不拖垮其余订阅方", () => {
    const ok: number[] = [];
    const off1 = subscribeSidebarSnapshot(() => { throw new Error("boom"); });
    const off2 = subscribeSidebarSnapshot((s) => { ok.push(s.seq); });
    publishSidebarTab(tab("terminal", "bash"), SEARCH_URL);
    expect(ok.length).toBe(1);
    off1(); off2();
  });
});

describe("A-1137 ④ 状态条文案（describeSidebarSnapshot）", () => {
  it("搜索页：label 说清模式与检索词，inject 带上条数 + 结果前几条 + 用户打开的那条", () => {
    publishSidebarTab(tab("browser", SEARCH_URL), SEARCH_URL);
    applySearchView(viewFromPageEvent({
      type: "open", mode: "online", query: "上下文压缩",
      count: 6, url: "https://x.test/a", title: "压缩综述",
      items: [{ title: "论文A" }, { title: "论文B" }],
    }, 1));
    const t = describeSidebarSnapshot(getSidebarSnapshot())!;
    expect(t.label).toContain("联网");
    expect(t.label).toContain("上下文压缩");
    expect(t.inject).toContain("模式：联网");
    expect(t.inject).toContain("检索词：「上下文压缩」");
    expect(t.inject).toContain("命中 6 条");
    expect(t.inject).toContain("已打开：压缩综述");
    expect(t.inject).toContain("1. 论文A");
    expect(t.inject).toContain("https://x.test/a");
  });

  it("搜索页报过错 ⇒ inject 里必须出现那个错误（否则 Agent 会基于一个已经不工作的右栏回答）", () => {
    publishSidebarTab(tab("browser", SEARCH_URL), SEARCH_URL);
    applySearchView(viewFromPageEvent({ type: "error", error: "人机验证", mode: "online" }, 1));
    expect(describeSidebarSnapshot(getSidebarSnapshot())!.inject).toContain("人机验证");
  });

  it("本地模式与联网模式的措辞不同（Agent 得知道「没联网」）", () => {
    publishSidebarTab(tab("browser", SEARCH_URL), SEARCH_URL);
    applySearchView(viewFromPageEvent({ type: "results", mode: "online", query: "a" }, 1));
    expect(describeSidebarSnapshot(getSidebarSnapshot())!.inject).toContain("模式：联网");
    applySearchView(viewFromPageEvent({ type: "results", mode: "local", query: "a" }, 2));
    expect(describeSidebarSnapshot(getSidebarSnapshot())!.inject).toContain("模式：本地索引");
  });

  it("非搜索页签：说清是哪个面板 + 位置；页签类型中文名有唯一产地", () => {
    /* ⚠️ A-1144 起**只对内容类页签**（浏览器/文件/终端）出文案：任务、Git 是**内部面板**，
       不是"用户在看的东西"—— 上一版对它们也播报，用户实测吐槽「怎么待办任务列表都会出现这个？」。
       `tasks` / `git` 的"不出文案"由 `a1144-sidebar-mount.spec.ts` 正面守着（那边是这条改动的居民）。 */
    for (const [kind, label] of [["terminal", "终端"], ["file", "文件"]] as const) {
      __resetSidebarViewForTest();
      publishSidebarTab(tab(kind, "loc-" + kind, ""), SEARCH_URL);
      const t = describeSidebarSnapshot(getSidebarSnapshot())!;
      expect(t.label).toContain(label);
      /* ⚠️ 这条**必须**在 label 上也断言位置：芯片上写的就是 label，
         只查 inject 的话「label 丢掉位置」的变异溜得过去（名字比断言强 = 假守卫）。 */
      expect(t.label, "芯片文案里没有位置 ⇒ Agent 不知道用户在看哪个文件").toContain("loc-" + kind);
      expect(t.inject).toContain(label);
      expect(t.inject).toContain("loc-" + kind);
    }
  });

  it("浏览器页签但**不在搜索页** ⇒ 走「其它页签」分支，不提搜索", () => {
    publishSidebarTab(tab("browser", "https://www.baidu.com/", "百度一下"), SEARCH_URL);
    const t = describeSidebarSnapshot(getSidebarSnapshot())!;
    expect(t.label).toContain("浏览器");
    expect(t.inject).toContain("https://www.baidu.com/");
    expect(t.inject).not.toContain("模式：");
  });

  it("页签没有标题时用地址兜底；都没有则写「未命名」（不留空）", () => {
    publishSidebarTab(tab("file", "D:/a/b.md", ""), SEARCH_URL);
    expect(describeSidebarSnapshot(getSidebarSnapshot())!.label).toContain("D:/a/b.md");
    __resetSidebarViewForTest();
    /* ⚠️ A-1144：这里原来用的是 `tasks` —— 而任务页已归入"内部面板 ⇒ 不出文案"。
       换成一个**内容类**页签来测同一条性质（"没标题没地址 ⇒ 未命名"），别把这条守卫一起废掉。 */
    publishSidebarTab(tab("terminal", "", ""), SEARCH_URL);
    expect(describeSidebarSnapshot(getSidebarSnapshot())!.inject).toContain("未命名");
  });
});

/* ══════════════════ ⑤ 交付信息：只成功问一次；失败必须能重试 ══════════════════ */

describe("A-1137 ⑤ 渲染层索取交付信息", () => {
  function stubWindow(host: () => Promise<unknown>) {
    let views: ((v: unknown) => void)[] = [];
    const apiObj = {
      host: vi.fn(host),
      view: vi.fn(async () => null as unknown),
      onView: (cb: (v: unknown) => void) => {
        views.push(cb);
        return () => { views = views.filter((x) => x !== cb); };
      },
    };
    vi.stubGlobal("window", { slimeAPI: { search: apiObj } });
    return { apiObj, pushView: (v: unknown) => { for (const cb of views) { cb(v); } } };
  }

  it("成功 ⇒ 进程内只问一次（之后的调用复用同一份结果）", async () => {
    const { apiObj } = stubWindow(async () => ({ ok: true, url: SEARCH_URL, preload: "file:///p.cjs" }));
    const a = await getSearchPageDelivery();
    const b = await getSearchPageDelivery();
    expect(a).toEqual({ url: SEARCH_URL, preload: "file:///p.cjs", error: "" });
    expect(b).toEqual(a);
    expect(apiObj.host).toHaveBeenCalledTimes(1);
  });

  it("**失败不入缓存** ⇒ 下次重试（一次抖动 = 永久打不开是本仓反复踩的坑）", async () => {
    let n = 0;
    const { apiObj } = stubWindow(async () => (n += 1) === 1
      ? { ok: false, error: "服务还没起来" }
      : { ok: true, url: SEARCH_URL, preload: "file:///p.cjs" });
    const a = await getSearchPageDelivery();
    expect(a.url).toBe("");
    expect(a.error).toBe("服务还没起来");
    const b = await getSearchPageDelivery();
    expect(b.url, "第一次失败被永久注入").toBe(SEARCH_URL);
    expect(apiObj.host).toHaveBeenCalledTimes(2);
  });

  it("主进程接口缺失 / 抛异常 ⇒ 给可读原因（不静默空手而归）", async () => {
    vi.stubGlobal("window", {});
    const r = await getSearchPageDelivery();
    expect(r.url).toBe("");
    expect(r.error).toContain("未就绪");

    __resetSearchPageDeliveryForTest();
    stubWindow(async () => { throw new Error("桥断了"); });
    const r2 = await getSearchPageDelivery();
    expect(r2.error).toContain("桥断了");
  });

  it("返回 ok 但没给地址 ⇒ 也算失败（不把空地址当成功缓存起来）", async () => {
    const { apiObj } = stubWindow(async () => ({ ok: true }));
    expect((await getSearchPageDelivery()).url).toBe("");
    await getSearchPageDelivery();
    expect(apiObj.host, "空地址被当成成功缓存了").toHaveBeenCalledTimes(2);
  });

  it("connectSidebarSearch 先 pull 补课再订阅（错过一次广播不该永久瞎）", async () => {
    const { apiObj, pushView } = stubWindow(async () => ({ ok: true, url: SEARCH_URL }));
    const view = viewFromPageEvent({ type: "results", mode: "online", query: "补课", count: 2 }, 9)!;
    apiObj.view = vi.fn(async () => view);
    const off = connectSidebarSearch();
    await new Promise((r) => setTimeout(r, 0));       // 让 pull 那个 promise 落定
    expect(getSidebarSnapshot().search?.query, "没有 pull 补课 ⇒ 状态条永远空白").toBe("补课");
    pushView(viewFromPageEvent({ type: "results", query: "广播", count: 1 }, 10));
    expect(getSidebarSnapshot().search?.query).toBe("广播");
    off();
  });
});

/* ══════════════════ ⑥ 主题映射漂移守卫（两边漂了不会报错） ══════════════════ */

describe("A-1137 ⑥ 主程序主题 → 搜索页主题", () => {
  it("`APP_THEMES` 与 renderer 的 `ThemeName` **取值集合一致**", () => {
    const src = readFileSync(join(ROOT, "gui", "src", "renderer", "theme.ts"), "utf8");
    const m = src.match(/export\s+type\s+ThemeName\s*=\s*([^;]+);/);
    expect(m, "renderer 的 ThemeName 定义找不到了 —— 抽取式守卫需要同步锚点").toBeTruthy();
    const names = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect(names.length).toBeGreaterThan(0);
    expect([...APP_THEMES].sort(), "两边漂了只会静默把搜索页锁死在 dark").toEqual(names);
  });

  it("每个主程序主题都能翻出一个搜索页主题；未知值落兜底、不抛也不返回空", () => {
    for (const t of APP_THEMES) {
      expect(["dark", "light", "auto"]).toContain(searchThemeOf(t));
    }
    expect(searchThemeOf("将来才有的主题")).toBe("dark");
    expect(searchThemeOf(undefined)).toBe("dark");
    expect(searchThemeOf(7)).toBe("dark");
  });
});

/* ══════════════════ ⑦ 联网检索的解析层（结构变了也不该静默返回空） ══════════════════ */

describe("A-1137 ⑦ 联网检索解析", () => {
  it("Bing：从 `li.b_algo` 抽标题/链接/摘要，source 是去 www 的域名", () => {
    const html = `
      <ol><li class="b_algo"><h2><a href="https://www.example.com/a">标题<b>甲</b></a></h2><p>摘要 甲</p></li>
      <li class="b_algo"><h2><a href="https://sub.test/b">标题乙</a></h2><p>摘要乙</p></li></ol>`;
    const items = parseBingItems(html, 10);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ title: "标题甲", url: "https://www.example.com/a", snippet: "摘要 甲", source: "example.com" });
    expect(items[1].source).toBe("sub.test");
  });

  it("Bing：`maxResults` 真截断；没有 `h2>a` 的块被跳过（不产出空条目）", () => {
    const one = '<li class="b_algo"><h2><a href="https://a.test/1">t</a></h2></li>';
    expect(parseBingItems(one.repeat(5), 2).length).toBe(2);
    expect(parseBingItems('<li class="b_algo">没有标题链接</li>', 10)).toEqual([]);
  });

  it("百度：从 `h3>a` 抽，摘要取该条之后的第一个 `<p>`", () => {
    const html = `<div><h3><a href="https://www.baidu.com/link?url=x">标题A</a></h3><p>摘要A</p></div>
                  <div><h3><a href="https://b.test/z">标题B</a></h3><p>摘要B</p></div>`;
    const items = parseBaiduItems(html, 10);
    expect(items.map((i) => i.title)).toEqual(["标题A", "标题B"]);
    expect(items[0].snippet).toBe("摘要A");
    expect(items[1].snippet).toBe("摘要B");
  });

  it("百度：空标题或空链接的条目被丢弃", () => {
    expect(parseBaiduItems('<h3><a href="">标题</a></h3>', 10)).toEqual([]);
    expect(parseBaiduItems('<h3><a href="https://a.test/">   </a></h3>', 10)).toEqual([]);
  });

  it("给模型看的紧凑文本是**历史契约**（改了就是改了 Agent 的输入）", () => {
    expect(formatItemsForModel([])).toBe("[无搜索结果]");
    expect(formatItemsForModel([{ title: "T", url: "https://a.test/", snippet: "S", source: "a.test" }]))
      .toBe("- T\n  https://a.test/\n  S");
  });

  it("验证码检测只看**可见文本**：脚本/样式里的关键字不算，正文里的才算", () => {
    expect(isCaptchaHtml('<html><script>var captchaUrl="/x";</script><body>正常结果</body></html>')).toBe(false);
    expect(isCaptchaHtml("<html><style>/* verify */</style><body>结果</body></html>")).toBe(false);
    expect(isCaptchaHtml("<html><body><div>请完成安全验证</div></body></html>")).toBe(true);
    expect(isCaptchaHtml("<html><body>unusual traffic from your network</body></html>")).toBe(true);
    expect(isCaptchaHtml("<html><body>普通页面</body></html>")).toBe(false);
  });
});
