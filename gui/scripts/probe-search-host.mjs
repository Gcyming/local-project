#!/usr/bin/env node
/**
 * gui/scripts/probe-search-host.mjs — 「Slime Search 接入右栏浏览器页」这条路**到底通不通**的机器判据。
 *
 * ## 这条判据要回答什么
 * 用户的搜索引擎（单文件 HTML）把「联网检索」交给宿主，契约是**两条通道**：
 *   ① `window.SlimeBrowserHost.query(q)`（页面首选，存在即视为已接入）
 *   ② `postMessage` 到 `window.parent`（承载在 iframe 里才成立）
 * 而 slime 的右栏浏览器页是 **`<webview>`（独立顶层 frame）** ⇒ 通道②里的
 * `window.parent === window` ⇒ 页面**只能听到自己发的消息** ⇒ 通道②必然失效。
 * ⇒ 接入必须靠通道①，而通道①要能在 guest 里拿到 `SlimeBrowserHost`，
 *   唯一正规机制是 **guest preload（`<webview preload="file://…">`）+ `ipcRenderer.invoke`**。
 *
 * ## 为什么必须实测（铁律 34：文档推断 ≠ 实测事实）
 * Electron 文档对 webview preload 有一堆条件性描述（是 `file:` 协议、sandbox 下能用哪些模块、
 * 必须在首次导航前生效……）。这些**据以设计就会翻车**（本仓已为"按文档推断"付过账：
 * 曾据文档断言"不开 `plugins` ⇒ PDF 空白"，A/B 实测直接证伪）。所以这里用真 Electron 打通全链：
 * **页面 → SlimeBrowserHost → preload → ipcRenderer.invoke → 主进程 → 回包 → 页面渲染出卡片**。
 *
 * ## 判据（全部是**行为级**，不 grep 文案 —— 铁律 27）
 *  · ON  变体：`typeof window.SlimeBrowserHost === 'object'`；**且 `name === 'slime 浏览器内核'`**
 *             （证明用的是**生产那份 preload 的真身**，不是探针自造的 mock）；
 *             `SlimeSearch.stats().onlineHost === true`；
 *             且**联网搜索后 `#resultList .result` 卡片数 ≥ 1**（真链路走通的唯一硬证据）；
 *             主题通道 `onTheme` 生效（`data-theme` 真的翻转）；`reportTheme` 反向上报到达主进程；
 *             事件上报 `ready`/`results`/`open` 三类都收到且 `results.items` 形状正确。
 *  · OFF 变体（**反例**）：无 preload ⇒ `SlimeBrowserHost` 不存在 + `onlineHost === false`
 *             + 搜索结果区出现失败空态 ⇒ 证明上面那条"通过"**不是**因为探针白测。
 *  · NO-CHAN 变体（**反例**）：preload 在、但 channel 锚点**没被注入**（`CH === null`）⇒ 同样不该 expose
 *             ⇒ 证明 main 的注入动作是**承重件**（漏注入 = 静默失效，这条能抓住它）。
 *
 * ## ⚠️ 用真身，不用 mock（铁律：判据的样本必须是被交付的那个东西）
 * 早期版本这里是探针手写的一段 mock preload —— 它只能证明"机制可行"，
 * **不能证明 `gui/src/preload/searchHost.cjs` 可行**（两者的白名单、通道名、暴露面都可能不同）。
 * 现在直接读生产文件、复刻 `searchBridge.ts::materializeSearchHostPreload()` 的注入动作。
 *
 * ## 探针自身踩过的坑（沿用 `probe-pdf-webview.mjs` 的纪律）
 *  · ⚠️ **绝不能用 `spawnSync`**（同进程还起着 http 服务 ⇒ 阻塞事件循环 ⇒ 服务收不到请求）。
 *  · ⚠️ **每个变体一个独立进程**（复用窗口 ⇒ 第二次取到的是**旧帧/旧状态** ⇒ 把"有差别"判成"无差别"）。
 *  · ⚠️ `ELECTRON_RUN_AS_NODE` 必须从子进程环境删掉，否则 Electron 退化成纯 Node。
 *  · ⚠️ 窗口必须**可见 + 置顶**（被遮挡 ⇒ 合成暂停 ⇒ `capturePage()` 永不 resolve）。
 *  · ⚠️ 生成的脚本先 `node --check`（本轮真的靠它抓到过一次语法错）。
 *  · ⚠️ 注入 `executeJavaScript` 的代码要**原样打印**：只报 `Unexpected end of input` 时，
 *       看不出到底是哪一段被改了形（上一版就卡在这里）。
 *  · ⚠️ **截图必须真看**（铁律：视觉交付物"先眼见为实、再交付"）——只断言元素数不等于页面好看。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const GUI = join(ROOT, "gui");
const ELECTRON = join(GUI, "node_modules/electron/dist/electron.exe");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  \u2713 " + m); };
const no = (m) => { fail++; console.log("  \u2717 " + m); };

const TMP = process.env.PROBE_TMP || mkdtempSync(join(tmpdir(), "slime-searchhost-"));
const cleanup = () => { if (process.env.PROBE_TMP) { console.log("[search-host] 保留临时目录：" + TMP); return; } try { rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } };

/* 截图落在**稳定目录**：临时目录会被清掉，清掉就看不成图了（看图这件事不能省）。 */
const SHOT_DIR = process.env.PROBE_SHOT_DIR || join(GUI, "scripts/.probe-shots");
mkdirSync(SHOT_DIR, { recursive: true });

/* ── ① 找到页面本体（仓库副本优先，其次用户 Downloads 里的原件） ── */
const CANDIDATES = [
  join(ROOT, "apps/local-search-engine/index.html"),
  "C:/Users/MR/Downloads/search-engine.html",
];
const pageSrc = CANDIDATES.find((p) => existsSync(p));
if (!pageSrc) { console.log("[search-host] 找不到 search-engine.html，探针跳过"); cleanup(); process.exit(0); }
console.log("[search-host] ① 页面本体：" + pageSrc);

/* ── ② 起一个**真的**本地静态服务（生产里就是这个形态：http 服务 + webview） ── */
const siteDir = join(TMP, "site");
mkdirSync(siteDir, { recursive: true });
copyFileSync(pageSrc, join(siteDir, "index.html"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  const f = join(siteDir, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
  try {
    const buf = readFileSync(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const PAGE_URL = "http://127.0.0.1:" + PORT + "/";
console.log("[search-host] ② 静态服务 " + PAGE_URL + "（" + Math.round(readFileSync(join(siteDir, "index.html")).length / 1024) + " KB）");

/* ── ③ guest preload：**用真身**（`gui/src/preload/searchHost.cjs`），复刻 main 的 channel 注入 ──
 * ⚠️ 早期这里放的是探针自写的 mock ⇒ 只能证明"机制可行"，不能证明"我们那份文件可行"。
 * 现在读生产文件，并按 `searchBridge.ts::materializeSearchHostPreload()` 的同一动作注入。
 * channel 名仍由**一处**产出（下面的 `PROBE_CH`），避免"channel 名在探针里到处硬编码"。 */
const PROBE_CH = {
  search_query: "probe:query",
  search_event: "probe:notify",
  search_theme: "probe:theme",
  search_theme_get: "probe:themeGet",
  search_theme_report: "probe:reportTheme",
};
const CHANNEL_PLACEHOLDER = "/*__SLIME_CHANNELS__*/ null";
const REAL_PRELOAD = join(GUI, "src/preload/searchHost.cjs");
if (!existsSync(REAL_PRELOAD)) {
  no("找不到生产的 guest preload：" + REAL_PRELOAD);
  server.close(); cleanup(); process.exit(1);
}
const realPreloadSrc = readFileSync(REAL_PRELOAD, "utf8");
if (!realPreloadSrc.includes(CHANNEL_PLACEHOLDER)) {
  /* 锚点丢了 ⇒ main 的注入会**静默不生效**（`CH` 一直是 null，页面永远"未接入"）。这里先拦住。 */
  no("生产 preload 缺少 channel 注入锚点 `" + CHANNEL_PLACEHOLDER + "` ⇒ main 的注入会静默失效");
}
const injectedSrc = realPreloadSrc.split(CHANNEL_PLACEHOLDER).join(JSON.stringify(PROBE_CH));
const preloadPath = join(TMP, "searchHost.cjs");
writeFileSync(preloadPath, injectedSrc);
/* 反例 C：锚点**留在原地**（等价于"main 忘了注入"）⇒ `CH === null` ⇒ 什么都不该 expose。 */
const preloadNoChanPath = join(TMP, "searchHost-nochan.cjs");
writeFileSync(preloadNoChanPath, realPreloadSrc);
const preloadUrl = "file:///" + preloadPath.replace(/\\/g, "/");
const preloadNoChanUrl = "file:///" + preloadNoChanPath.replace(/\\/g, "/");
console.log("[search-host] ③ 生产 preload " + REAL_PRELOAD + "（" + Buffer.byteLength(realPreloadSrc)
  + " 字节 → 注入后 " + Buffer.byteLength(injectedSrc) + " 字节）");

/* ── ④ 宿主页 + Electron 主脚本（每个变体一份，独立进程） ── */
function hostHtml(preload) {
  return [
    "<!doctype html><html><head><meta charset='utf-8'><title>search-host</title></head>",
    "<body style='margin:0;background:#111'>",
    "<webview id='wv' src='" + PAGE_URL + "'" + (preload ? " preload='" + preload + "'" : ""),
    "  style='width:960px;height:760px;border:0;display:inline-flex'></webview>",
    "</body></html>",
  ].join("\n");
}

function electronMain() {
  return [
    "/* 探针用 Electron 主脚本：装载真页面，检查 guest 里的宿主桥 + 联网检索 + 主题 + 事件上报。 */",
    "const { app, BrowserWindow, ipcMain } = require('electron');",
    "const { writeFileSync } = require('fs');",
    "const OUT = process.env.PROBE_OUT;",
    "const HOST = process.env.PROBE_HOST;",
    "const TAG = process.env.PROBE_TAG;",
    "const SHOT_DIR = process.env.PROBE_SHOT_DIR;",
    "/* channel 表由**一处**（探针脚本里的 PROBE_CH）产出 —— 与生产侧「channel 名只有一份产地」同构。 */",
    "const CH = JSON.parse(process.env.PROBE_CH);",
    "let HOST_THEME = 'dark';",
    "/* ⚠️ 等多久必须**按变体区分**：无宿主时页面若还认通道②会等 4s 才报错；",
    "   通道①（已判定无宿主）则是**立即**失败。等 3s 只会读到「正在经由项目浏览器内核检索…」这个中间态。 */",
    "const WAIT = Number(process.env.PROBE_WAIT || 3000);",
    "const NOTIFY = [];",
    "const THEME_REPORTS = [];",
    "const bead = (stage, extra) => { try { writeFileSync(OUT, JSON.stringify(Object.assign({ stage }, extra || {}))); } catch (e) { /* 忽略 */ } };",
    "const say = (m) => { try { console.log('[probe] ' + m); } catch (e) { /* 忽略 */ } };",
    "bead('boot');",
    "process.on('uncaughtException', (e) => { bead('uncaught', { error: String((e && e.message) || e) }); app.quit(); });",
    "say('electron ' + process.versions.electron);",
    "/* 模拟 slime 主进程的联网检索。⚠️ 入参是 **{query} 包装对象**（生产 preload 就是这么发的）。 */",
    "ipcMain.handle(CH.search_query, async (_e, payload) => {",
    "  const q = (payload && typeof payload === 'object') ? String(payload.query || '') : String(payload);",
    "  return {",
    "    ok: true, engine: '探针内核', engineName: '探针内核', items: [",
    "      { title: '探针结果 A ' + q, url: 'https://example.com/a', snippet: '摘要 A ' + q, source: 'example.com' },",
    "      { title: '探针结果 B ' + q, url: 'https://example.com/b', snippet: '摘要 B ' + q, source: 'example.com' },",
    "    ],",
    "  };",
    "});",
    "/* 生产 preload 的 `getTheme()` 会来问这条（主题状态归宿主，页面不自己猜）。 */",
    "ipcMain.handle(CH.search_theme_get, () => HOST_THEME);",
    "ipcMain.on(CH.search_event, (_e, m) => { NOTIFY.push(m); say('guest notify: ' + JSON.stringify(m).slice(0, 220)); });",
    "ipcMain.on(CH.search_theme_report, (_e, d) => { THEME_REPORTS.push(d); say('guest reportTheme: ' + JSON.stringify(d)); });",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "app.whenReady().then(async () => {",
    "  const out = { tag: TAG };",
    "  const win = new BrowserWindow({ width: 1040, height: 860, show: true,",
    "    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });",
    "  win.setAlwaysOnTop(true); win.moveTop(); win.focus();",
    "  let guest = null;",
    "  const T0 = Date.now();",
    "  const EV = [];",
    "  const ev = (k) => { EV.push((Date.now() - T0) + 'ms ' + k); say('EV ' + (Date.now() - T0) + 'ms ' + k); };",
    "  const guestReady = new Promise((res) => {",
    "    win.webContents.on('did-attach-webview', (_e, gwc) => {",
    "      guest = gwc;",
    "      ev('attach-webview');",
    "      /* ⚠️ 装全导航事件：'读了 2 张卡片但截图是失败空态' 这种自相矛盾，",
    "         只有把「页面到底加载了几次」量出来才能解释（不然只能瞎猜）。 */",
    "      ['dom-ready', 'did-finish-load', 'did-navigate', 'did-navigate-in-page', 'did-start-navigation'].forEach((k) => {",
    "        try { gwc.on(k, (_a, b) => ev(k + ' ' + (typeof b === 'string' ? b.slice(0, 70) : ''))); } catch (e) { /* 忽略 */ }",
    "      });",
    "      try {",
    "        /* ⚠️ Electron 35 把 `console-message` 的参数改成了单个事件对象；旧写法 `(_e, level, message)`",
    "           在这里只会打印 `undefined: undefined` —— 正是它把「preload 加载即抛」这条真因藏住了。",
    "           两种形态都兼容，别只留一种。 */",
    "        gwc.on('console-message', (e, level, message) => {",
    "          const lv = (e && typeof e === 'object' && e.level !== undefined) ? e.level : level;",
    "          const msg = (e && typeof e === 'object' && e.message !== undefined) ? e.message : message;",
    "          say('guest console[' + lv + ']: ' + msg);",
    "        });",
    "      } catch (e) { /* 忽略 */ }",
    "      gwc.once('dom-ready', () => { ev('dom-ready#1'); res(true); });",
    "    });",
    "    setTimeout(() => res(false), 15000);",
    "  });",
    "  await win.loadFile(HOST);",
    "  const attached = await guestReady;",
    "  out.attached = attached;",
    "  if (!guest) { bead('no-guest'); writeFileSync(OUT, JSON.stringify(out)); app.quit(); return; }",
    "  /* ⚠️ 截图名必须带变体前缀：两个变体共用同名文件时，后跑的反例会覆掉正例的证据（本轮真拿反例的失败空态当了正例的结果\uff09。 */",
    "  const shot = async (name) => {",
    "    try {",
    "      const img = await Promise.race([guest.capturePage(), new Promise((_r, rj) => setTimeout(() => rj(new Error('capture timeout')), 8000))]);",
    "      const p = SHOT_DIR + '/' + TAG + '-' + name + '.png';",
    "      writeFileSync(p, img.toPNG());",
    "      out.shots = Object.assign(out.shots || {}, { [name]: p });",
    "      say('shot -> ' + p);",
    "    } catch (e) { say('shot failed (' + name + '): ' + String((e && e.message) || e)); }",
    "  };",
    "  await sleep(2600);",
    "  out.probe = await guest.executeJavaScript('JSON.stringify({'",
    "    + 'host: typeof window.SlimeBrowserHost, name: (window.SlimeBrowserHost && window.SlimeBrowserHost.name) || \\'\\','",
    "    + 'stats: (window.SlimeSearch && window.SlimeSearch.stats && window.SlimeSearch.stats()) || null,'",
    "    + 'pill: (document.getElementById(\\'engineText\\') || {}).textContent || \\'\\''",
    "    + '})');",
    "  say('probe#1 ' + out.probe);",
    "  /* ⚠️ 注入代码**原样打印**：上一版这里只报「Unexpected end of input」，看不出到底是哪一段被改了形。 */",
    "  /* ⚠️ v3.2.0 的「全网」枚举值是 web，不是 online（原「联网 / 全网」两模式已合并）。",
    "     setMode 内部是 state.mode = (m === 'web') ? 'web' : 'local' ⇒ 传 online 会静默落到本地模式，",
    "     于是页面拿内置示例语料出结果，把「全链走通」判据喂成假绿。 */",
    "  const CODE_SEARCH = '(function(){ window.SlimeSearch.setMode(\\'web\\'); window.SlimeSearch.search(\\'slime-probe\\'); return 1; })()';",
    "  say('CODE_SEARCH=' + CODE_SEARCH);",
    "  try { out.search = await guest.executeJavaScript(CODE_SEARCH); }",
    "  catch (e) { out.searchError = String((e && e.message) || e); say('search threw: ' + out.searchError); }",
    "  /* 密集采样：把「结果区在搜索后如何演变」量出来（含 hostReady/probeDone），",
    "     这样 'cards=2 而截图是失败态' 这类矛盾能自证，而不是靠推断。 */",
    "  const SAMPLE = '(function(){ var s = window.SlimeSearch.stats(); return JSON.stringify({ cards: document.querySelectorAll(\"#resultList .result\").length, failed: !!document.querySelector(\"#resultList .empty\"), head: (document.getElementById(\"resultMeta\") || {}).textContent || \"\", host: s.onlineHost, pill: (document.getElementById(\"engineText\") || {}).textContent || \"\" }); })()';",
    "  out.timeline = [];",
    "  for (let i = 0; i < 10; i += 1) {",
    "    await sleep(400);",
    "    try { out.timeline.push(((i + 1) * 400) + 'ms ' + await guest.executeJavaScript(SAMPLE)); }",
    "    catch (e) { out.timeline.push(((i + 1) * 400) + 'ms ERR ' + String((e && e.message) || e)); }",
    "  }",
    "  out.timeline.forEach((l) => say('TL ' + l));",
    "  await sleep(Math.max(0, WAIT - 4000));",
    "  /* ⚠️ cards 里多带一份 hrefs：v3.2.0 内置了示例语料，未接入内核时照样能渲染出卡片",
    "     ⇒ 只数卡片数分不清「走的真是内核」还是「被本地语料兜底了」。内核结果一定有 http(s) 链接，",
    "     本地语料没有 ⇒ 判据必须是「有 http 链接的卡片」，不是「有卡片」。 */",
    "  try { out.render = await guest.executeJavaScript('JSON.stringify({cards: document.querySelectorAll(\"#resultList .result\").length, head: (document.getElementById(\"resultMeta\") || {}).textContent || \"\", failed: !!document.querySelector(\"#resultList .empty\"), hrefs: Array.prototype.slice.call(document.querySelectorAll(\"#resultList .result a.result-name\")).map(function(a){ return a.getAttribute(\"href\") || \"\"; })})'); }",
    "  catch (e) { out.renderError = String((e && e.message) || e); say('render threw: ' + out.renderError); }",
    "  say('probe#2 ' + out.render);",
    "  await shot('a-dark-results');",
    "  /* 主题通道：宿主 → 页面。postMessage 在 webview 里天然失效，只能靠 preload 的 onTheme。 */",
    "  HOST_THEME = 'light';",
    "  try { guest.send(CH.search_theme, 'light'); } catch (e) { say('send theme threw: ' + String(e && e.message)); }",
    "  await sleep(500);",
    "  try { out.theme = await guest.executeJavaScript('JSON.stringify({ resolved: (window.SlimeSearch.getTheme() || {}).resolved, dataTheme: document.documentElement.getAttribute(\"data-theme\"), dataMode: document.documentElement.getAttribute(\"data-slime-theme\"), label: (document.getElementById(\"themeLabel\") || {}).textContent || \"\" })'); }",
    "  catch (e) { out.themeError = String((e && e.message) || e); say('theme threw: ' + out.themeError); }",
    "  say('probe#3 ' + out.theme);",
    "  await shot('b-light-results');",
    "  /* 结果点击上报：capture 阶段 preventDefault，只取事件不真跳转。 */",
    "  const CODE_CLICK = '(function(){ var a = document.querySelector(\"#resultList a.result-name\"); if (!a) return \"no-anchor\"; a.addEventListener(\"click\", function(e){ e.preventDefault(); }, true); a.dispatchEvent(new MouseEvent(\"click\", { bubbles: true, cancelable: true })); return \"clicked\"; })()';",
    "  try { out.click = await guest.executeJavaScript(CODE_CLICK); }",
    "  catch (e) { out.clickError = String((e && e.message) || e); say('click threw: ' + out.clickError); }",
    "  await sleep(400);",
    "  /* 主题反向上报：页面 setTheme 应经 reportTheme 回到主进程。 */",
    "  try { await guest.executeJavaScript('(function(){ window.SlimeSearch.setTheme(\"dark\"); return 1; })()'); } catch (e) { say('setTheme threw: ' + String(e && e.message)); }",
    "  await sleep(400);",
    "  out.notify = NOTIFY;",
    "  out.themeReports = THEME_REPORTS;",
    "  writeFileSync(OUT, JSON.stringify(out));",
    "  app.quit();",
    "});",
  ].join("\n");
}

/* ── ⑤ 跑三个变体（各一个独立进程） ── */
async function runVariant(tag, opts) {
  const hostPath = join(TMP, "host-" + tag + ".html");
  const mainPath = join(TMP, "main-" + tag + ".cjs");
  const outPath = join(TMP, "out-" + tag + ".json");
  writeFileSync(hostPath, hostHtml(opts.preload || ""));
  writeFileSync(mainPath, electronMain());

  const chk = spawn(process.execPath, ["--check", mainPath], { stdio: ["ignore", "pipe", "pipe"] });
  const chkCode = await new Promise((r) => chk.on("close", r));
  if (chkCode !== 0) { no("变体 " + tag + " 生成的主脚本语法错（node --check 退出码 " + chkCode + "）"); return null; }

  return await new Promise((resolve) => {
    const env = {
      ...process.env,
      PROBE_OUT: outPath, PROBE_HOST: hostPath, PROBE_TAG: tag,
      PROBE_WAIT: String(opts.waitMs), PROBE_SHOT_DIR: SHOT_DIR,
      PROBE_CH: JSON.stringify(PROBE_CH),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const lines = [];
    const p = spawn(ELECTRON, [mainPath], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: false });
    p.stdout.on("data", (d) => lines.push(String(d)));
    p.stderr.on("data", (d) => lines.push(String(d)));
    const guard = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, 90000);
    p.on("close", () => {
      clearTimeout(guard);
      let json = null;
      try { json = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* 忽略 */ }
      resolve({ json, log: lines.join("") });
    });
    p.on("error", () => { clearTimeout(guard); resolve({ json: null, log: lines.join("") }); });
  });
}

console.log("[search-host] ④ 变体 A：**带 preload（channel 已注入）**（期望全链打通）");
const on = await runVariant("on", { preload: preloadUrl, waitMs: 3000 });
if (!on || !on.json) { no("变体 A 没跑出结果（Electron 未就绪或崩溃）\n" + (on ? on.log : "")); }
else if (!on.json.attached) { no("变体 A：guest 未 attach（15s 超时）\n" + on.log); }
else {
  let p1 = null, p2 = null, p3 = null;
  try { p1 = JSON.parse(on.json.probe); } catch { /* 忽略 */ }
  try { p2 = JSON.parse(on.json.render); } catch { /* 忽略 */ }
  try { p3 = JSON.parse(on.json.theme); } catch { /* 忽略 */ }
  if (p1 && p1.host === "object") { ok("guest 里 `window.SlimeBrowserHost` 存在（preload + contextBridge 生效，sandbox 不拦）"); }
  else { no("guest 里拿不到 `SlimeBrowserHost`（实测 " + JSON.stringify(p1) + "）⇒ 通道①不可用，接入方案要换\n" + on.log); }
  /* 这条是"用的真是生产那份文件"的证据 —— mock 的名字不会是这个。 */
  if (p1 && p1.name === "slime 浏览器内核") { ok("内核名是**生产 preload 的**「slime 浏览器内核」⇒ 用的不是探针 mock"); }
  else { no("内核名不是生产值（实测 name=" + JSON.stringify(p1 && p1.name) + "）⇒ 探针没在测真身"); }
  if (p1 && p1.stats && p1.stats.onlineHost === true) { ok("页面自己的握手判据认了：`stats().onlineHost === true`"); }
  else { no("页面握手没认（stats=" + JSON.stringify(p1 && p1.stats) + "）"); }
  if (p2 && p2.cards >= 1) { ok("**全链走通**：联网检索后结果区渲染出 " + p2.cards + " 张卡片（" + p2.head + "）"); }
  else { no("联网检索没渲染出卡片（render=" + JSON.stringify(p2) + "）\n" + on.log); }

  /* — 主题通道（宿主 → 页面）：postMessage 在 webview 里收发都失效，这条是唯一的主题通路 — */
  if (p3 && p3.resolved === "light" && p3.dataTheme === "light") {
    /* v3.2.0 已取消页面自带的配色切换按钮 ⇒ 不再拿按钮文案当佐证，只看 data-theme 与 resolved。 */
    ok("**主题通道生效**：宿主经 preload 推 `light` ⇒ `data-theme=" + p3.dataTheme + "`、`getTheme().resolved=" + p3.resolved + "`");
  } else {
    no("主题通道没生效（theme=" + JSON.stringify(p3) + "）⇒ 用户在浅色主题下会看到一页黑底（静默失效）");
  }

  /* — 事件上报（页面 → 宿主）：对话侧「实时监测右栏」全靠这条 — */
  const evs = on.json.notify || [];
  const byType = {};
  evs.forEach((e) => { if (e && e.type) { byType[e.type] = e; } });
  if (byType.ready) { ok("上报 `ready` 到达主进程（onlineHost=" + String(byType.ready.onlineHost) + "）"); }
  else { no("没收到 `ready` 上报（收到 " + JSON.stringify(evs.map((e) => e && e.type)) + "）"); }
  const r = byType.results;
  if (r && r.query === "slime-probe" && Array.isArray(r.items) && r.items.length === 2 && r.items[0].url && r.items[0].title) {
    ok("上报 `results` 形状正确：query/items[2]/首条 title+url+snippet 齐全");
  } else { no("`results` 上报形状不对（" + JSON.stringify(r) + "）"); }
  const o = byType.open;
  /* ⚠️ v3.2.0 起「全网」模式下 `open` 事件上报的 mode 是 `web`（页面里写死），不是 `online` ——
     与 `viewFromPageEvent` 那处契约漂移同源：只认 `online` 会把整个「全网」判成「本地」。 */
  if (o && o.url === "https://example.com/a" && o.rank === 1 && (o.mode === "online" || o.mode === "web")) {
    ok("上报 `open` 抓到用户点击：url=" + o.url + " rank=" + o.rank + " mode=" + o.mode);
  } else { no("`open` 上报不对（" + JSON.stringify(o) + "，click=" + String(on.json.click) + "）"); }
  const tr = on.json.themeReports || [];
  if (tr.length >= 1) { ok("上报 `reportTheme` 到达主进程（" + JSON.stringify(tr[0]) + "）"); }
  else { no("页面切主题没有回传宿主（themeReports 为空）"); }

  const shots = on.json.shots || {};
  if (shots["a-dark-results"] && shots["b-light-results"]) { ok("落了两张真截图（深色/浅色结果页）⇒ 可肉眼验收"); }
  else { no("截图未落盘（shots=" + JSON.stringify(shots) + "）"); }
}

console.log("[search-host] ⑤ 变体 B：**不带 preload**（反例，必须失败）");
const off = await runVariant("off", { waitMs: 6000 });
if (!off || !off.json || !off.json.attached) { no("变体 B 没跑出结果\n" + (off ? off.log : "")); }
else {
  let p1 = null, p2 = null;
  try { p1 = JSON.parse(off.json.probe); } catch { /* 忽略 */ }
  try { p2 = JSON.parse(off.json.render); } catch { /* 忽略 */ }
  if (p1 && p1.host === "undefined") { ok("反例成立：没有 preload ⇒ guest 里没有 `SlimeBrowserHost`"); }
  else { no("反例不成立：没 preload 却拿到了 " + JSON.stringify(p1 && p1.host) + " ⇒ 上一条'通过'可能是假绿"); }
  if (p1 && p1.stats && p1.stats.onlineHost === false) { ok("反例成立：页面自判「未接入浏览器内核（独立运行）」"); }
  else { no("反例不成立：stats=" + JSON.stringify(p1 && p1.stats)); }
  /* ⚠️ v3.2.0 起**不能用**「没有卡片」当反例：页面内置了示例语料，未接入内核时照样渲染出卡片
     （实测：无 preload ⇒ cards=2 · failed=false ⇒ 旧判据把真反例判成"不成立"）。
     正确的反例是「**没有任何结果来自内核**」—— 内核结果一定有 http(s) 链接。 */
  const offHttp = (p2 && Array.isArray(p2.hrefs) ? p2.hrefs : []).filter((h) => /^https?:/i.test(String(h)));
  if (p2 && offHttp.length === 0) {
    ok("反例成立：没有 preload ⇒ 结果区**没有任何 http 结果**（" + (p2.cards || 0) + " 张卡片全是本地示例语料兜底）⇒ 内核链路确实没通");
  } else { no("反例不成立：没 preload 却拿到了 " + offHttp.length + " 条 http 结果 ⇒ 上一条'通过'可能是假绿（render=" + JSON.stringify(p2) + "）"); }
}

/* 反例 C：preload 在但**锚点没被注入**（等价"main 忘了注入"）⇒ 必须同样拿不到宿主。
   这条证明注入动作是**承重件**：漏了它 = 页面永远显示"未接入"而构建毫无报错。 */
console.log("[search-host] ⑥ 变体 C：**preload 在、但 channel 锚点未注入**（反例，必须失败）");
const nochan = await runVariant("nochan", { preload: preloadNoChanUrl, waitMs: 6000 });
if (!nochan || !nochan.json || !nochan.json.attached) { no("变体 C 没跑出结果\n" + (nochan ? nochan.log : "")); }
else {
  const q1 = JSON.parse(nochan.json.probe || "null");
  if (q1 && q1.host === "undefined") { ok("反例成立：锚点未注入（`CH === null`）⇒ **不 expose**，页面拿不到宿主"); }
  else { no("反例不成立：没注入 channel 却拿到了 " + JSON.stringify(q1 && q1.host) + " ⇒ 注入动作其实无关紧要？"); }
}

server.close();
if (process.env.PROBE_SHOT_DIR) { console.log("[search-host] 截图目录（保留）：" + SHOT_DIR); }
else { console.log("[search-host] 截图目录：" + SHOT_DIR); }
cleanup();
console.log("\n[search-host] 汇总：通过 " + pass + " · 失败 " + fail);
process.exit(fail ? 1 : 0);
