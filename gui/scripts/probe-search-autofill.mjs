#!/usr/bin/env node
/**
 * gui/scripts/probe-search-autofill.mjs — A-1145「本地命中不足 ⇒ 自动联网补量 / 收录」的**真页面探针**。
 *
 * ## 为什么必须有它
 * 被改动的对象是 `apps/local-search-engine/index.html` —— 一个跑在右栏 webview 里的**独立页面**，
 * vitest 加载不到它的函数 ⇒ `a1145-search-autofill.spec.ts` 那一组只有**形状断言**，
 * 证明不了运行时行为（"冷却真的生效吗""补量真的触发吗""收录请求真的发出去了吗"）。
 * 这组形状守卫的**唯一**加固方式就是本探针：起真 Electron + 真页面 + 真 preload + 假自建索引服务。
 *
 * ## 判据（全部是**行为级**，不 grep 文案 —— 铁律 27）
 *  · 变体 A（**带 preload** ⇒ 有内核 ⇒ 走 `runOnline`）：联网结果卡片 ≥1 且带 http 链接；
 *    **假索引服务真的收到 `/crawl`**（seeds 全是 http(s) 地址）。
 *  · 变体 B（**不带 preload** ⇒ 无内核 ⇒ 走 `runWeb`）：本地索引被真的查询了（`/search` ≥1 次）；
 *    没有联网能力 ⇒ **不该**出现补量块（`#autoFillBox` 不存在）。
 *  · 变体 C（本地命中**充足** ⇒ 不该触发补量）：`total ≥ AUTOFILL_MIN` ⇒ `#autoFillBox` 不存在。
 *
 * ## ⚠️ 沿用 `probe-search-host.mjs` 的纪律（那条探针踩过的坑）
 *  · **绝不能用 `spawnSync`**（同进程还起着 http 服务 ⇒ 阻塞事件循环 ⇒ 服务收不到请求）。
 *  · **每个变体一个独立进程**（复用窗口 ⇒ 取到旧帧/旧状态）。
 *  · `ELECTRON_RUN_AS_NODE` 必须从子进程环境删掉。
 *  · 窗口必须**可见 + 置顶**。
 *  · 生成的主脚本先 `node --check`。
 *  · 注入 `executeJavaScript` 的代码**原样打印**（只报 `Unexpected end of input` 时看不出哪段被改了形）。
 *  · **样本必须是被交付的那个东西**：preload 用生产的 `searchHost.cjs` 真身（不是探针自造的 mock）。
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

const TMP = process.env.PROBE_TMP || mkdtempSync(join(tmpdir(), "slime-autofill-"));
const cleanup = () => { if (process.env.PROBE_TMP) { console.log("[autofill] 保留临时目录：" + TMP); return; } try { rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } };

/* ── ① 页面本体 ── */
const PAGE_SRC = join(ROOT, "apps/local-search-engine/index.html");
if (!existsSync(PAGE_SRC)) { console.log("[autofill] 找不到搜索页，探针跳过"); cleanup(); process.exit(0); }
console.log("[autofill] ① 页面本体：" + PAGE_SRC);

/* ── ② 静态服务托管页面（生产形态就是 http 服务 + webview） ── */
const siteDir = join(TMP, "site");
mkdirSync(siteDir, { recursive: true });
copyFileSync(PAGE_SRC, join(siteDir, "index.html"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const siteServer = createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  const f = join(siteDir, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
  try {
    const buf = readFileSync(f);
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => siteServer.listen(0, "127.0.0.1", r));
const PAGE_URL = "http://127.0.0.1:" + siteServer.address().port + "/";

/* ── ③ 假「自建全网索引」服务：记录 `/search` 与 `/crawl` 的真实请求 ──
    ⚠️ 它跑在**探针进程**里（不是 Electron 子进程）⇒ 计数可以直接读，不必跨进程回传。 */
const idx = { search: 0, crawl: 0, seeds: [], total: 1 };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
const idxServer = createServer((req, res) => {
  const u = (req.url || "/").split("?")[0];
  /* ⚠️ 必须回 `OPTIONS` 预检：`Content-Type: application/json` 的 POST 会先发预检，
     探针不回 204 ⇒ fetch 直接失败 ⇒ 会误判成"收录没发生"（生产服务 CORS 全开，所以这是探针的锅）。 */
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  const send = (obj) => {
    res.writeHead(200, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(obj));
  };
  if (u === "/crawl" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      idx.crawl += 1;
      try { const p = JSON.parse(body || "{}"); idx.seeds = (p.seeds || []).slice(0, 20); } catch { /* 忽略 */ }
      send({ ok: true, accepted: idx.seeds.length });
    });
    return;
  }
  if (u === "/status") { send({ ok: true, pages: 12, terms: 340, engine: "探针假索引" }); return; }
  if (u === "/search") {
    idx.search += 1;
    const items = [{ title: "本地命中 A", url: "https://local.example/a", snippet: "本地摘要 A", source: "local.example" }];
    send({ ok: true, total: idx.total, items, took_ms: 1.2, engine: "探针假索引" });
    return;
  }
  send({ ok: false, error: "not found" });
});
await new Promise((r) => idxServer.listen(0, "127.0.0.1", r));
const IDX_BASE = "http://127.0.0.1:" + idxServer.address().port;
console.log("[autofill] ② 页面 " + PAGE_URL + " ｜ ③ 假索引服务 " + IDX_BASE);

/* ── ④ guest preload：用生产真身 ── */
const PROBE_CH = {
  search_query: "probe:query",
  search_event: "probe:notify",
  search_theme: "probe:theme",
  search_theme_get: "probe:themeGet",
  search_theme_report: "probe:reportTheme",
};
const CHANNEL_PLACEHOLDER = "/*__SLIME_CHANNELS__*/ null";
const REAL_PRELOAD = join(GUI, "src/preload/searchHost.cjs");
if (!existsSync(REAL_PRELOAD)) { no("找不到生产的 guest preload：" + REAL_PRELOAD); process.exit(1); }
const realPreloadSrc = readFileSync(REAL_PRELOAD, "utf8");
if (!realPreloadSrc.includes(CHANNEL_PLACEHOLDER)) { no("生产 preload 缺少 channel 注入锚点"); }
const preloadPath = join(TMP, "searchHost.cjs");
writeFileSync(preloadPath, realPreloadSrc.split(CHANNEL_PLACEHOLDER).join(JSON.stringify(PROBE_CH)));
const preloadUrl = "file:///" + preloadPath.replace(/\\/g, "/");
console.log("[autofill] ④ 生产 preload（注入后 " + Buffer.byteLength(readFileSync(preloadPath)) + " 字节）");

/* ── ⑤ 宿主页 + Electron 主脚本 ── */
function hostHtml(preload) {
  return [
    "<!doctype html><html><head><meta charset='utf-8'><title>autofill-host</title></head>",
    "<body style='margin:0;background:#111'>",
    "<webview id='wv' src='" + PAGE_URL + "'" + (preload ? " preload='" + preload + "'" : ""),
    "  style='width:960px;height:760px;border:0;display:inline-flex'></webview>",
    "</body></html>",
  ].join("\n");
}

function electronMain() {
  return [
    "const { app, BrowserWindow, ipcMain } = require('electron');",
    "const { writeFileSync } = require('fs');",
    "const OUT = process.env.PROBE_OUT, HOST = process.env.PROBE_HOST, TAG = process.env.PROBE_TAG;",
    "const CH = JSON.parse(process.env.PROBE_CH), WEBBASE = process.env.PROBE_WEBBASE;",
    "const bead = (s, x) => { try { writeFileSync(OUT, JSON.stringify(Object.assign({ stage: s }, x || {}))); } catch (e) {} };",
    "const say = (m) => { try { console.log('[probe] ' + m); } catch (e) {} };",
    "bead('boot');",
    "process.on('uncaughtException', (e) => { bead('uncaught', { error: String((e && e.message) || e) }); app.quit(); });",
    "/* 模拟 slime 主进程的联网检索（入参是 {query} 包装对象 —— 生产 preload 就是这么发的）。 */",
    "ipcMain.handle(CH.search_query, async (_e, payload) => {",
    "  const q = (payload && typeof payload === 'object') ? String(payload.query || '') : String(payload);",
    "  return { ok: true, engine: '探针内核', engineName: '探针内核', items: [",
    "    { title: '联网结果 A ' + q, url: 'https://online.example/a', snippet: '联网摘要 A', source: 'online.example' },",
    "    { title: '联网结果 B ' + q, url: 'https://online.example/b', snippet: '联网摘要 B', source: 'online.example' },",
    "  ] };",
    "});",
    "ipcMain.handle(CH.search_theme_get, () => 'dark');",
    "ipcMain.on(CH.search_event, (_e, m) => { say('guest notify: ' + JSON.stringify(m).slice(0, 200)); });",
    "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
    "app.whenReady().then(async () => {",
    "  const out = { tag: TAG };",
    "  const win = new BrowserWindow({ width: 1040, height: 860, show: true,",
    "    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });",
    "  win.setAlwaysOnTop(true); win.moveTop(); win.focus();",
    "  let guest = null;",
    "  const ready1 = new Promise((res) => {",
    "    win.webContents.on('did-attach-webview', (_e, gwc) => {",
    "      guest = gwc;",
    "      try { gwc.on('console-message', (e, l, m) => { const msg = (e && typeof e === 'object' && e.message !== undefined) ? e.message : m; say('guest console: ' + msg); }); } catch (e) {}",
    "      gwc.once('dom-ready', () => res(true));",
    "    });",
    "    setTimeout(() => res(false), 15000);",
    "  });",
    "  await win.loadFile(HOST);",
    "  out.attached = await ready1;",
    "  if (!guest) { writeFileSync(OUT, JSON.stringify(out)); app.quit(); return; }",
    "  /* ⚠️ 页面初始化时 `web.base` 是**硬编码默认值 8600**，并不读 localStorage（只有用户点「重连」时才写）。",
    "     ⇒ 探针必须走**页面自己的 UI 路径**（填 `#webServerAddr` + 点 `#webReconnect`）—— 这样测的才是真实交互链路；",
    "        而且**不 reload**（reload 会重建 guest 状态，把前面刚建立的握手也冲掉）。 */",
    "  const CODE_ADDR = '(function(){ var a=document.getElementById(\"webServerAddr\"); var b=document.getElementById(\"webReconnect\"); if(!a||!b) return \"no-ui\"; a.value=' + JSON.stringify(WEBBASE) + '; b.click(); return \"clicked\"; })()';",
    "  say('CODE_ADDR=' + CODE_ADDR);",
    "  try { out.addrSet = await guest.executeJavaScript(CODE_ADDR); } catch (e) { out.addrSet = 'ERR ' + String(e && e.message); say('addr threw: ' + out.addrSet); }",
    "  say('addrSet=' + out.addrSet);",
    "  await sleep(1800);",
    "  out.stats = await guest.executeJavaScript('JSON.stringify({ host: typeof window.SlimeBrowserHost, onlineHost: ((window.SlimeSearch && window.SlimeSearch.stats && window.SlimeSearch.stats()) || {}).onlineHost, webOnline: ((window.SlimeSearch && window.SlimeSearch.stats && window.SlimeSearch.stats()) || {}).webOnline })');",
    "  say('stats ' + out.stats);",
    "  const CODE = '(function(){ window.SlimeSearch.setMode(\"web\"); window.SlimeSearch.search(\"autofill-probe\"); return 1; })()';",
    "  say('CODE=' + CODE);",
    "  const TIMES = Number(process.env.PROBE_TIMES || 1);",
    "  for (let t = 0; t < TIMES; t += 1) {",
    "    try { await guest.executeJavaScript(CODE); } catch (e) { out.searchError = String((e && e.message) || e); say('search threw: ' + out.searchError); }",
    "    await sleep(1200);",
    "  }",
    "  const SAMPLE = '(function(){ return JSON.stringify({ cards: document.querySelectorAll(\"#resultList .result\").length, crawlNote: (document.querySelector(\"#crawlNoteBox .svc-note\") || {}).textContent || \"\", head: (document.getElementById(\"resultMeta\") || {}).textContent || \"\", hrefs: Array.prototype.slice.call(document.querySelectorAll(\"#resultList .result a.result-name\")).map(function(a){ return a.getAttribute(\"href\") || \"\"; }) }); })()';",
    "  out.timeline = [];",
    "  for (let i = 0; i < 12; i += 1) {",
    "    await sleep(400);",
    "    try { out.timeline.push(((i + 1) * 400) + 'ms ' + await guest.executeJavaScript(SAMPLE)); } catch (e) { out.timeline.push(((i + 1) * 400) + 'ms ERR ' + String((e && e.message) || e)); }",
    "  }",
    "  out.timeline.forEach((l) => say('TL ' + l));",
    "  writeFileSync(OUT, JSON.stringify(out));",
    "  app.quit();",
    "});",
  ].join("\n");
}

/* ── ⑥ 跑变体 ── */
async function runVariant(tag, opts) {
  const hostPath = join(TMP, "host-" + tag + ".html");
  const mainPath = join(TMP, "main-" + tag + ".cjs");
  const outPath = join(TMP, "out-" + tag + ".json");
  writeFileSync(hostPath, hostHtml(opts.preload || ""));
  writeFileSync(mainPath, electronMain());

  const chk = spawn(process.execPath, ["--check", mainPath], { stdio: ["ignore", "pipe", "pipe"] });
  const chkCode = await new Promise((r) => chk.on("close", r));
  if (chkCode !== 0) { no("变体 " + tag + " 主脚本语法错（node --check " + chkCode + "）"); return null; }

  idx.search = 0; idx.crawl = 0; idx.seeds = []; idx.total = opts.total || 1;

  const { json, log } = await new Promise((resolve) => {
    const env = { ...process.env, PROBE_OUT: outPath, PROBE_HOST: hostPath, PROBE_TAG: tag,
      PROBE_CH: JSON.stringify(PROBE_CH), PROBE_WEBBASE: IDX_BASE, PROBE_TIMES: String(opts.times || 1) };
    delete env.ELECTRON_RUN_AS_NODE;
    const lines = [];
    const p = spawn(ELECTRON, [mainPath], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: false });
    p.stdout.on("data", (d) => lines.push(String(d)));
    p.stderr.on("data", (d) => lines.push(String(d)));
    const guard = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, 90000);
    p.on("close", () => {
      clearTimeout(guard);
      let j = null;
      try { j = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* 忽略 */ }
      resolve({ json: j, log: lines.join("") });
    });
    p.on("error", () => { clearTimeout(guard); resolve({ json: null, log: lines.join("") }); });
  });
  return { json, log, search: idx.search, crawl: idx.crawl, seeds: idx.seeds.slice() };
}

const lastSample = (json) => {
  const tl = (json && json.timeline) || [];
  for (let i = tl.length - 1; i >= 0; i -= 1) {
    const s = tl[i].replace(/^\d+ms /, "");
    try { return JSON.parse(s); } catch { /* 继续往前找 */ }
  }
  return null;
};

console.log("[autofill] ⑥ 变体 A：**带 preload**（有内核 ⇒ 走 `runOnline`）");
const A = await runVariant("on", { preload: preloadUrl, total: 1 });
if (!A || !A.json || !A.json.attached) { no("变体 A 没跑出结果\n" + (A ? A.log : "")); }
else {
  const s = lastSample(A.json);
  const st = JSON.parse(A.json.stats || "null");
  if (st && st.host === "object" && st.onlineHost === true) { ok("guest 里有生产 preload 的内核桥（`SlimeBrowserHost` + `onlineHost=true`）"); }
  else { no("内核桥没建立（stats=" + A.json.stats + "）\n" + A.log); }
  if (st && st.webOnline === true) { ok("页面连上了探针的假索引服务（`webOnline=true`）"); }
  else { no("页面没连上假索引（stats=" + A.json.stats + "）"); }
  const http = ((s && s.hrefs) || []).filter((h) => /^https?:/i.test(String(h)));
  if (http.length >= 1) { ok("联网检索渲染出 " + http.length + " 条带 http 链接的结果（走的真是内核，不是本地示例语料）"); }
  else { no("联网路径没渲染出 http 结果（sample=" + JSON.stringify(s) + "）"); }
  /* ⚠️ 核心判据：联网结果出来后，**收录请求真的发出去了吗**？ */
  if (A.crawl >= 1) {
    ok("**收录发生**：假索引收到 " + A.crawl + " 次 `/crawl`，seeds=" + JSON.stringify(A.seeds));
    const bad = A.seeds.filter((x) => !/^https?:/i.test(String(x)));
    if (bad.length === 0) { ok("收录的 seeds 全是 http(s) 地址（没有把站内路径/空串丢给爬虫）"); }
    else { no("seeds 里混进了非 http 地址：" + JSON.stringify(bad)); }
  } else { no("**没有收录**：联网结果出来了，但假索引没收到任何 `/crawl`（A-1145 的落点没生效）"); }
  if (s && /提交收录/.test(s.crawlNote || "")) { ok("**降级看得见**：页面明说「" + s.crawlNote.slice(0, 40) + "…」"); }
  else { no("收录了却没给出可见说明（crawlNote=" + JSON.stringify(s && s.crawlNote) + "）"); }
}

console.log("[autofill] ⑦ 变体 B：**不带 preload**（无内核 ⇒ 走 `runWeb`，本地命中不足）");
const B = await runVariant("off", { total: 1 });
if (!B || !B.json || !B.json.attached) { no("变体 B 没跑出结果\n" + (B ? B.log : "")); }
else {
  const s = lastSample(B.json);
  const st = JSON.parse(B.json.stats || "null");
  if (st && st.host === "undefined") { ok("反例前提成立：没有 preload ⇒ 没有内核桥"); }
  else { no("反例前提不成立：没 preload 却拿到了 " + JSON.stringify(st && st.host)); }
  if (B.search >= 1) { ok("本地索引被真的查询了（`/search` " + B.search + " 次）⇒ 走的是 `runWeb` 路径"); }
  else { no("本地索引没被查询（search=" + B.search + "）⇒ 没走到 `runWeb`"); }
  if (s && !s.crawlNote) { ok("**无联网能力时不收录**：没有内核 ⇒ 不出现收录说明（不该假装收过）"); }
  else { no("没有内核却出现了收录说明（sample=" + JSON.stringify(s) + "）"); }
  if (B.crawl === 0) { ok("没有联网能力 ⇒ 也没向索引提交任何收录（不乱发请求）"); }
  else { no("没有内核却发了 " + B.crawl + " 次 `/crawl`"); }
}

console.log("[autofill] ⑧ 变体 C：本地命中**充足**（`total=5`）⇒ 不该触发补量");
const C = await runVariant("plenty", { preload: "", total: 5 });
if (!C || !C.json || !C.json.attached) { no("变体 C 没跑出结果\n" + (C ? C.log : "")); }
else {
  const s = lastSample(C.json);
  if (s && !s.crawlNote) { ok("无内核 + 命中充足 ⇒ 不收录（没有联网结果可收）"); }
  else { no("无内核 + 命中充足却出现了收录说明（sample=" + JSON.stringify(s) + "）"); }
}

console.log("[autofill] ⑨ 变体 D：**同一查询连搜两次** ⇒ 冷却必须挡住第二次");
const D = await runVariant("cooldown", { preload: preloadUrl, total: 1, times: 2 });
if (!D || !D.json || !D.json.attached) { no("变体 D 没跑出结果"); console.log((D ? D.log : "").slice(0, 1500)); }
else {
  const s = lastSample(D.json);
  if (D.crawl === 1) { ok("**冷却生效**：同一查询搜两次 ⇒ `/crawl` 只发 1 次（不重复收录）"); }
  else { no("冷却没生效：搜了两次却发了 " + D.crawl + " 次 `/crawl`（sample=" + JSON.stringify(s) + "）"); }
  if (s && /提交收录/.test(s.crawlNote || "")) { ok("冷却期间说明仍在（不是被当成失败抹掉）"); }
  else { no("第二次搜索后收录说明没了（crawlNote=" + JSON.stringify(s && s.crawlNote) + "）"); }
}

siteServer.close();
idxServer.close();
cleanup();
console.log("\n[autofill] 汇总：通过 " + pass + " · 失败 " + fail);
process.exit(fail ? 1 : 0);
