/**
 * gui/src/preload/searchHost.cjs — **右栏搜索页专用的 guest preload**。
 *
 * ## 为什么必须有它（实测结论，不是设计偏好）
 * 用户的搜索页（单文件 HTML）把「联网检索」交给宿主，原设计有**两条通道**：
 *   ① `window.SlimeBrowserHost.query(q)` —— 宿主注入的对象（存在即视为已接入）
 *   ② `postMessage` 到 `window.parent` —— 页面被 iframe 承载时才成立
 * 而右栏浏览器页是 **`<webview>`（独立顶层 frame）**：在那个文档里 `window.parent === window`
 * ⇒ 通道②发出的消息**只能被自己听到**，宿主永远收不到。
 * ⇒ 接入只能靠通道①，而要让 guest 里出现 `SlimeBrowserHost`，唯一正规机制就是
 *   `<webview preload="file://…">` + `contextBridge` + `ipcRenderer`。
 * （`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 下 preload 仍能
 *  `require('electron')` 拿到这两个 API —— 已用真 Electron A/B 探针实测 12/12，
 *  见 `gui/scripts/probe-search-host.mjs`。**文档只说"能"，实测才敢信**，铁律 34。）
 *
 * ## ⚠️ 为什么这个文件是 `.cjs` 而不是 `.ts`（本仓唯一例外，理由要留档）
 * `<webview preload="...">` 只接受**单个现成的 JS 文件路径**。而 electron-vite 的 preload
 * 构建是「单一入口 + 固定文件名」（`src/preload/index.{js,ts,mjs,cjs}`，见其
 * `findLibEntry`），要产出**第二个** preload 文件只能靠 `build.isolatedEntries`。
 * **实测该开关在本仓当前版本/配置下不生效**：把 `rollupOptions.input` 的键名改成 `foo`
 * 后产物**仍是 `index.js` 且字节数一字不差** ⇒ 说明 `preload.build.rollupOptions.input`
 * 被整体忽略（走的是 `lib.entry` 默认入口）。而 `gui/tsconfig.json` 的 `include` 只匹配
 * `src/` 目录下的 `.ts`（本文件是 `.cjs`，**不在其中**），`vite.config.ts` 本身也不受类型检查
 * ⇒ 这两行一直没被发现的"装饰性配置"。
 * ⇒ 改用与 `gui/vendor/*.js`、搜索页本体相同的机制：**构建期 `?raw` 内联进主进程产物，
 *   运行期写盘**，再由渲染层把路径挂到 webview 上（见 `gui/src/main/searchBridge.ts`）。
 *
 * ## ⚠️⚠️ 本文件**没有任何静态语法检查** ⇒ 踩过的坑必须写在这里
 * 因为它不在 tsc 的 `include` 里，也不会被 electron-vite 构建 ⇒ **语法错不会有任何构建期报错**，
 * 只会在运行期"preload 加载即抛 ⇒ 页面永远显示未接入"（一个彻底的静默失效）。
 *  · **坑（真实踩过）**：块注释里写了路径通配 `src/**` + `/*.ts` 连起来的那四个字符（`*` `/`），
 *    它**提前闭合了块注释** ⇒ 整个文件 `SyntaxError: Unexpected token '*'`。
 *    ⇒ 本文件的注释里**绝不出现** 星号紧跟斜杠 的组合；写通配一律写成 `src/` 下的 `.ts` 这种形式。
 *  · **判据**：`gui/scripts/probe-search-host.mjs` 用**真身**（读本文件 + 按 main 的方式注入 channel）
 *    跑真 Electron，只有能 expose 才算过 ⇒ 语法错会立刻变红。别把那条探针降级回 mock。
 *
 * ## ⚠️ 代价与它的两道补偿（缺一不可）
 * 本文件**不受 tsc 检查** ⇒ 用两条纪律补偿：
 *   1. 只用最小 API（`contextBridge` / `ipcRenderer`），**不引任何依赖**
 *      —— sandbox preload 根本不能 `require` node_modules，引了就是运行期炸；
 *   2. **channel 名不硬编码** —— 由 main 写盘时注入 `__SLIME_CHANNELS__`
 *      （唯一产地仍是 `gui/src/shared/ipc.ts`）。
 * 这两条都由 `tests/gui/a1137-search-bridge.spec.ts` 的源码扫描守卫锁住。
 *
 * ## ⚠️ 两道白名单，职责不同（都不是可选的）
 * 右栏浏览器页是**通用浏览器**：用户能把它导航到任意站点，而 webview 的 preload
 * 对**每一次导航**都会执行。不给白名单的话，**任何外网站点**都能拿到 `SlimeBrowserHost`，进而：
 *   · 调 `query()` 让 slime 替它去抓 Bing/百度页面（把本机当代理）；
 *   · 调 `notify()` 伪造「右栏打开了 X」污染对话侧状态。
 * 所以：
 *   · **本文件的白名单 = 功能性的**（同步、宽松）：只在"本机文档"里 expose，外网站点连对象都看不见；
 *   · **`gui/src/main/searchBridge.ts` 的白名单 = 安全性的**（权威、严格）：校验 `senderFrame.url`。
 *     ⚠️ 不能把本文件的判断当安全边界 —— 页面若跑了 `history.pushState`，preload 侧的 `location`
 *     会与真实 frame URL 不同步。本文件的判断只在**文档创建那一刻**执行一次（页面脚本还没跑），
 *     所以它挡得住"外网站点顺手拿对象"，但**权威判据必须在 main**。
 *
 * ## 与页面的契约（`apps/local-search-engine/index.html` 消费）
 *   SlimeBrowserHost = {
 *     name: string,                                   // 页面的「已接入：X」角标
 *     query(q) -> { ok, engine, engineName, items }    // items: {title,url,snippet,source}[]
 *     notify(evt) -> void                              // fire & forget，供对话侧实时监测
 *     onTheme(cb) -> void                              // main 推主题 → cb(mode)
 *     getTheme() -> Promise<string>                    // 首次加载对齐主程序主题
 *     reportTheme(detail) -> void                      // 页面自行切换主题时回传
 *   }
 * ⚠️ contextBridge 的暴露面是**深拷贝**：页面改不动这里的闭包；反过来这里也无法
 * "异步拿到真名再回填" `name`（所以它只能是静态串）。
 */
"use strict";

var electron = require("electron");
var contextBridge = electron.contextBridge;
var ipcRenderer = electron.ipcRenderer;

/* 注入点：main 写盘时把 `shared/ipc.ts` 的 channel 表替换进来（唯一产地仍是那份 TS）。 */
var CH = /*__SLIME_CHANNELS__*/ null;

/** 内核显示名（静态：contextBridge 的暴露面是拷贝，无法后续回填真实名）。 */
var HOST_NAME = "slime 浏览器内核";

/** 本机主机名白名单（`loc.hostname` 对 `http://[::1]:80` 返回 `[::1]`）。 */
var LOCAL_HOSTS = { "127.0.0.1": 1, localhost: 1, "::1": 1, "[::1]": 1 };

/**
 * 功能性白名单：这是不是"本机文档"？
 * 允许 `file:`（用户直接双击搜索页）、`about:`（webview 初始 blank 态）、
 * 以及回环地址上的 `http(s):`（生产形态：main 的 `slime:http:serve` 托管搜索页）。
 */
function isLocalDocument() {
  try {
    var proto = location.protocol;
    if (proto === "file:" || proto === "about:") { return true; }
    if (proto === "http:" || proto === "https:") { return !!LOCAL_HOSTS[location.hostname]; }
    return false;
  } catch (e) {
    return false;
  }
}

if (CH && isLocalDocument()) {
  contextBridge.exposeInMainWorld("SlimeBrowserHost", {
    name: HOST_NAME,

    /** 联网检索：交给 main 侧的**唯一产地** `core-ts/src/search/onlineSearch.ts`。 */
    query: function (q) {
      return ipcRenderer.invoke(CH.search_query, { query: String(q == null ? "" : q) });
    },

    /** 上报页面内部事件（检索结果 / 打开条目 / 切换模式 …）。fire & forget。 */
    notify: function (evt) {
      try { ipcRenderer.send(CH.search_event, evt); } catch (e) { /* 通道没了也不该打断页面 */ }
    },

    /** 订阅主程序主题。`cb(mode)`，mode ∈ dark|light|auto。 */
    onTheme: function (cb) {
      if (typeof cb !== "function") { return; }
      ipcRenderer.on(CH.search_theme, function (_e, mode) {
        try { cb(mode); } catch (e) { /* 页面自身的回调异常不该影响桥 */ }
      });
    },

    /** 首次加载时主动问一次当前主题（否则浅色用户会先看到一页黑底）。 */
    getTheme: function () {
      return ipcRenderer.invoke(CH.search_theme_get);
    },

    /** 页面自行切换主题时回传（用户点了页面里的主题按钮）。 */
    reportTheme: function (detail) {
      try { ipcRenderer.send(CH.search_theme_report, detail); } catch (e) { /* 同上 */ }
    }
  });
}
