#!/usr/bin/env node
/**
 * gui/scripts/probe-pdf-webview.mjs — 「PDF 在预览标签页里**到底显示不显示**」的机器判据。
 *
 * ## 为什么必须用真 Electron（普通浏览器探针测不出来）
 * 阶段 C 的老格式路线最终落在 `<embed type="application/pdf">`，由 **Chromium 的 PDF 查看器**渲染。
 * 而查看器在 **Electron 里是以「插件」形式实现的** —— Electron 官方 `<webview>` 文档原文：
 * 「**Plugins are disabled by default.**」⇒ `<webview>` 不显式开 `plugins` 就只有**一片空白**。
 * 普通 Chrome/Edge 默认能看 PDF ⇒ 用浏览器探针**测不出来**，必须起真 Electron + 真 `<webview>`。
 *
 * ## 怎么判「显示了没有」（**不靠肉眼、不靠退出码**）
 * 取 guest 的 `capturePage()`（`NativeImage`），再 `toBitmap()` 拿 **原始 BGRA 像素** —— 不需要任何
 * PNG 解码库。然后统计**近白像素占比**：
 *   · **渲染出 PDF**：画面里有一大块**白纸** ⇒ 近白占比高（>12%）；
 *   · **一片空白**（插件没开）：Chromium 的 PDF 容器底色是**均匀深灰** ⇒ 近白≈0。
 * ⇒ 同一份 PDF 做 **A/B 对照**（开 / 不开 `plugins`），两个数字的**差**就是判据本身。
 *
 * ## 本文件自己踩过的坑
 * · ⚠️ **绝不能用 `spawnSync` 起 Electron**：本进程里同时起着 http 服务，`spawnSync` 阻塞事件循环
 *   ⇒ 服务收不到请求 ⇒ 截图全白 ⇒ 误判「渲染库画不出来」（铁律 26）。
 * · ⚠️ 窗口必须**可见**（`show:true`）：隐藏窗口会截到旧帧/空帧。
 * · ⚠️ 别 grep 页面里的错误文案 —— 那些字就写在模板里，一 grep 必命中（铁律 27）。
 * · ⚠️ `ELECTRON_RUN_AS_NODE` 必须从子进程环境里**删掉**，否则 Electron 退化成纯 Node、没有 BrowserWindow。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const GUI = join(ROOT, "gui");
const ELECTRON = join(GUI, "node_modules/electron/dist/electron.exe");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  \u2713 " + m); };
const no = (m) => { fail++; console.log("  \u2717 " + m); };
const skip = (m) => { console.log("  \u25cb " + m); };

const TMP = mkdtempSync(join(tmpdir(), "slime-pdfwv-"));
const cleanup = () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } };

/* ── ① 造一个真 PDF（用 LibreOffice 转一个真老格式文件） ── */
const SOFFICE = "C:/Program Files/LibreOffice/program/soffice.com";
const SRC_DOC = "C:/Users/MR/Downloads/EDA第九组实验一报告.doc";
console.log("[PDF-in-webview] ① 造真 PDF（LibreOffice 转 .doc）");
const convDir = join(TMP, "conv");
mkdirSync(convDir, { recursive: true });
let pdfPath = "";
if (existsSync(SOFFICE) && existsSync(SRC_DOC)) {
  await new Promise((res) => {
    const p = spawn(SOFFICE, ["--headless", "--convert-to", "pdf", "--outdir", convDir, SRC_DOC], { windowsHide: true, stdio: "ignore" });
    p.on("close", () => res()); p.on("error", () => res());
  });
  const guess = join(convDir, SRC_DOC.split("/").pop().replace(/\.doc$/, "") + ".pdf");
  if (existsSync(guess)) { pdfPath = guess; ok("真 PDF 就位：" + Math.round(readFileSync(guess).length / 1024) + " KB"); }
}
if (!pdfPath) { skip("没有 LibreOffice 或样本 ⇒ 造不出 PDF，本探针跳过"); cleanup(); process.exit(0); }

/* ── ② 用**生产的** writePdfViewerPage 落一页查看器 ── */
console.log("[PDF-in-webview] ② 用生产代码落「PDF 查看器页」");
const esbuildDir = [
  join(ROOT, "node_modules/.pnpm/esbuild@0.25.11/node_modules/esbuild"),
  join(ROOT, "node_modules/.pnpm/esbuild@0.25.0/node_modules/esbuild"),
  join(ROOT, "node_modules/.pnpm/esbuild@0.19.3/node_modules/esbuild"),
].find((d) => existsSync(join(d, "lib/main.js")));
const esbuildMod = await import(pathToFileURL(join(esbuildDir, "lib/main.js")).href);
const esbuild = esbuildMod.default ?? esbuildMod;
const rawPlugin = {
  name: "vite-raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({
      path: join(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (a) => ({
      contents: "export default " + JSON.stringify(readFileSync(a.path, "utf8")) + ";", loader: "js",
    }));
  },
};
const bundle = join(TMP, "docRenderPage.mjs");
await esbuild.build({
  entryPoints: [join(GUI, "src/main/docRenderPage.ts")], bundle: true, platform: "node",
  format: "esm", outfile: bundle, external: ["electron"], plugins: [rawPlugin], logLevel: "warning",
});
const renderMod = await import(pathToFileURL(bundle).href);
const pageRoot = join(TMP, "serve");
mkdirSync(pageRoot, { recursive: true });
const built = renderMod.writePdfViewerPage(pageRoot, pdfPath, SRC_DOC, "探针样本");
if (!built.ok) { no("落查看器页失败：" + built.error); cleanup(); process.exit(1); }
ok("查看器页：`" + built.name + "`（内含 `<embed type=\"application/pdf\">`）");

/* ── ②b 「rootDir 传临时目录」这个陷阱的**行为级复现**（2026-09-30 用户截图定位的真 bug）── */
console.log("[PDF-in-webview] ②b 页面必须落进**持久**目录（rootDir 传临时目录 ⇒ 页面随后被删）");
{
  const persistent = join(TMP, "persist");
  const p1 = renderMod.writePdfViewerPage(persistent, pdfPath, SRC_DOC, "样本");
  /* 另造一个"临时目录"并把它删掉 —— 模拟主进程 `cleanupConvertDir(conv.dir)` 的动作 */
  const transient = mkdtempSync(join(tmpdir(), "slime-lo-fake-"));
  rmSync(transient, { recursive: true, force: true });
  if (p1.ok && existsSync(join(persistent, p1.name))) {
    ok("正例：rootDir 传**持久目录** ⇒ 删掉临时目录后页面**仍在**（PDF 副本随之保留）");
  } else {
    no("正例失败：页面不该消失（p1=" + JSON.stringify(p1) + "）");
  }

  /* ⚠️ **反例**：把"临时目录"当 rootDir（正是旧代码的写法）⇒ 删掉它，页面就跟着没了 ——
     这也是"服务起不来 / 只剩重排"的**直接成因**。反例必须真的失败，否则说明探针没测到点子上。 */
  const transient2 = mkdtempSync(join(tmpdir(), "slime-lo-fake2-"));
  const p2 = renderMod.writePdfViewerPage(transient2, pdfPath, SRC_DOC, "样本");
  const pageInside = p2.ok ? join(transient2, p2.name) : "";
  const existed = !!pageInside && existsSync(pageInside);
  rmSync(transient2, { recursive: true, force: true });
  if (existed && !existsSync(pageInside)) {
    ok("反例（**复现 bug**）：rootDir 传临时目录 ⇒ 页面确实被一起删掉 ⇒ `http.serve` 必然报「目录不存在」");
  } else {
    no("反例没复现出问题（页面本来就没生成？existed=" + existed + "）⇒ 这条判据没测到点子上");
  }
}

/* ── ③ 起静态服务 ── */
const MIME = { ".html": "text/html; charset=utf-8", ".pdf": "application/pdf" };
const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
  const f = join(pageRoot, rel === "" ? "index.html" : rel);
  if (!f.startsWith(pageRoot)) { res.writeHead(403); res.end(); return; }
  try {
    const buf = readFileSync(f);
    res.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] ?? "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("nf"); }
});
const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
const pageUrl = "http://127.0.0.1:" + port + "/" + built.name;
console.log("     服务: " + pageUrl);

/* ── ④ 真 Electron：A/B 各截一次 ── */
console.log("[PDF-in-webview] ③ 真 Electron `<webview>` 截图（开 / 不开 plugins 对照）");
/* host 页由探针生成两份，避免"运行时改属性对已 attach 的 guest 无效"这个坑。 */
const hostOn = join(TMP, "host-on.html");
const hostOff = join(TMP, "host-off.html");
writeFileSync(hostOn, hostHtml(pageUrl, true));
writeFileSync(hostOff, hostHtml(pageUrl, false));
const mainPath = join(TMP, "main.cjs");
writeFileSync(mainPath, mainScript());

/* ⚠️⚠️ **生成后先自检语法**（`node --check`）—— 本轮真踩过：主脚本里一段注释**忘了闭合**
   （结尾少了星号加斜杠），于是把后面的函数边界全吞进注释里、`await` 跑到顶层 ⇒ Electron 只抛一句
   「await is only valid in async functions」，而**阶段标记已经写过 `boot`** ⇒ 看起来像"卡住"。
   把语法错误在**探针这一侧**立刻抓出来（带文件名），比隔着一层 Electron 猜要快得多。
   ⚠️ 写这条注释本身时也踩了同一个坑：注释里**不能出现字面的注释结束符**（会把本条提前闭合）。 */
{
  const chk = spawn(process.execPath, ["--check", mainPath], { stdio: ["ignore", "pipe", "pipe"] });
  let cerr = "";
  chk.stderr.on("data", (d) => { cerr += String(d); });
  const code = await new Promise((r) => chk.on("close", (c) => r(c)));
  if (code !== 0) {
    no("探针生成的 Electron 主脚本**语法不合法**（不是环境问题，是本探针的 bug）：");
    console.log("     " + cerr.trim().split("\n").slice(0, 6).join("\n     "));
    cleanup();
    process.exit(1);
  }
}

/* ⚠️ **每个变体起一个全新 Electron 进程**（不共用窗口、不共用 OUT）：
   复用窗口时实测第二次 `capturePage()` 会返回**和第一次完全相同**的图（0.641 == 0.641）
   ⇒ 那是**旧帧**，会让 A/B 得出"没差别"的假结论。独立进程 = 干净的一次合成。
   本轮 A/B 轴换成了**导航守卫的白名单**（`new` 放行 `chrome-extension` / `old` 不放行），
   host 页共用（`plugins` 恒开，与应用的现状一致）。 */
async function runVariants() {
  const out = { new: null, old: null };
  for (const guard of ["new", "old"]) {
    const host = hostOn;
    const outPath = join(TMP, "result-" + guard + ".json");
    const r = await new Promise((resolve) => {
      const env = { ...process.env, PROBE_URL: pageUrl, PROBE_HOST: host, PROBE_TAG: guard, PROBE_GUARD: guard, PROBE_OUT: outPath };
      delete env.ELECTRON_RUN_AS_NODE;
      const p = spawn(ELECTRON, [mainPath], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: false });
      let so = "", se = "";
      /* ⚠️ **stdout 必须一起收**：只收 stderr 时一旦跑挂就**什么都看不到**（本探针第一版就这样白等 90 秒）。
         ⚠️ 也不能用 `| head` 之类把管道提前关掉 —— 子进程吃到 EPIPE 会被挂住不退出。 */
      p.stdout.on("data", (d) => { so += String(d); });
      p.stderr.on("data", (d) => { se += String(d); });
      p.on("close", (code) => {
        if (existsSync(outPath)) {
          try {
            const r2 = JSON.parse(readFileSync(outPath, "utf8"));
            if (!r2.stage) {
              if (r2.error) { console.log("     [" + guard + "] Electron 内报错：" + r2.error); }
              resolve(r2);
              return;
            }
            console.log("     [" + guard + "] 停在阶段 `" + r2.stage + "`" + (r2.error ? "（" + r2.error + "）" : ""));
          } catch { /* 落盘损坏 */ }
        }
        console.log("     [" + guard + "] exit=" + code);
        if (so.trim()) { console.log("     [" + guard + "] stdout: " + so.trim().split("\n").slice(-6).join(" | ")); }
        if (se.trim()) { console.log("     [" + guard + "] stderr: " + se.trim().split("\n").slice(-6).join(" | ")); }
        resolve(null);
      });
      setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } }, 75_000);
    });
    out[guard] = r && r.shot ? r.shot : null;
  }
  return out;
}
const results = await runVariants();

{
  const nu = results.new, od = results.old;
  const fmt = (s) => (s ? ("近白=" + s.whiteRatio.toFixed(3) + "  被拦 frame 导航=" + (s.blocked ?? "?") + "  " + s.w + "x" + s.h) : "(无结果)");
  console.log("     新白名单（放行 chrome-extension）= 应用的现状：" + fmt(nu));
  console.log("     旧白名单（不放行）        = 修之前的对照：" + fmt(od));
  if (!nu) {
    no("新白名单那一路没跑出结果 ⇒ 本探针没能回答「PDF 显示不显示」");
  } else if (nu.whiteRatio > 0.12) {
    ok("**应用当前配置下 PDF 真的画出来了**（白纸占比 " + (nu.whiteRatio * 100).toFixed(1) + "%）");
  } else {
    no("应用当前配置下没画出 PDF（近白仅 " + (nu.whiteRatio * 100).toFixed(1) + "%）");
  }
  /* ⚠️⚠️ **这里如实交代一句重要的"没测到"**（铁律 34：文档推断 ≠ 实测事实）：
     我一度以为"`chrome-extension` 不在白名单 ⇒ 查看器被掐断 ⇒ 空白"是用户那个 bug 的**根因**，
     并想用这组 A/B 证明它。**但两路都是 `blocked=0`** —— 说明在**本探针的会话里那条 frame 导航压根没发生**，
     所以这组对照**不能**作为"白名单是根因"的证据。
     ⇒ 保留它只作为**信息**；而 `isWebSafeUrl` / `openExternalSafe` 那两处修改的依据是
       **用户截图里那个「无法打开 chrome-extension:// 链接」的弹窗**（那是 `shell.openExternal` 被调用的直接证据），
       不是这组探针数据。**不把没证实的东西写成结论。** */
  console.log("     ⚠️ 对照说明：两路都是 blocked=0 ⇒ **本探针未能复现**那条 frame 拦截，"
    + "因此这组对照**不构成**「白名单是根因」的证据（修那两处的依据是用户截图里的弹窗）。");
}

try { server.close(); } catch { /* noop */ }
cleanup();
console.log("\n[PDF-in-webview] 结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);

/** host 页：一个 `<webview>` 指向那个 PDF 查看器页。 */
function hostHtml(url, plugins) {
  return [
    "<!doctype html><html><head><meta charset='utf-8'><title>probe-host</title></head>",
    "<body style='margin:0;background:#111'>",
    "<webview id='wv' src='" + url + "'" + (plugins ? " plugins='true'" : "") + " allowpopups",
    "  style='width:960px;height:720px;border:0;display:inline-flex'></webview>",
    "</body></html>",
  ].join("\n");
}

/** 探针用的 Electron 主脚本（**独立进程**，不是应用的一部分）。
 *  ⚠️ 必须是**函数声明**（会被提升）—— 上面在模块顶层就调用了它；
 *     写成 `const MAIN_SCRIPT = ...` 会掉进 TDZ 直接抛 ReferenceError。 */
function mainScript() { return [
  '/* 探针用 Electron 主脚本：挂 <webview>，A/B 各截一次，统计近白像素占比。 */',
  'const { app, BrowserWindow } = require("electron");',
  'const { writeFileSync } = require("fs");',
  'const OUT = process.env.PROBE_OUT;',
  'const HOST_ON = process.env.PROBE_HOST_ON;',
  'const HOST_OFF = process.env.PROBE_HOST_OFF;',
  '/* ⚠️ 每步都落一个「阶段标记」：探针卡住时能一眼看出停在哪儿（只写最终结果的话，一挂就全瞎）。 */',
  'const bead = (stage, extra) => { try { writeFileSync(OUT, JSON.stringify(Object.assign({ stage }, extra || {}))); } catch (e) { /* 忽略 */ } };',
  'bead("boot");',
  'process.on("uncaughtException", (e) => { bead("uncaught", { error: String((e && e.message) || e) }); app.quit(); });',
  'console.log("[probe] electron", process.versions.electron);',
  'function stats(img) {',
  '  const bmp = img.toBitmap();',
  '  const size = img.getSize();',
  '  let white = 0, total = 0;',
  '  for (let i = 0; i + 3 < bmp.length; i += 4) {',
  '    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];',
  '    total++;',
  '    if (r > 200 && g > 200 && b > 200) { white++; }',
  '  }',
  '  return { whiteRatio: total ? white / total : 0, w: size.width, h: size.height };',
  '}',
  'async function shoot(win, hostFile, tag) {',
  '  bead("shoot:" + tag + ":load");',
  '  /* ⚠️⚠️ **守卫必须装在 guest 上**（2026-09-30 本探针自己踩过）：',
  '     应用的守卫装在 **app 级 `web-contents-created`** ⇒ 覆盖**所有** webContents（含 webview guest）；',
  '     而 PDF 查看器的 frame 导航发生在 **guest** 里，装在宿主窗口上**根本看不到** ⇒',
  '     第一版就是这么写的，结果 `blocked=0`、反例不复现（差点得出"这条修复没必要"的错误结论）。 */',
  '  const OLD = ["http","https","about","file","data","blob","chrome"];',
  '  const NEW = ["http","https","about","file","data","blob","chrome","chrome-extension"];',
  '  const allow = process.env.PROBE_GUARD === "old" ? OLD : NEW;',
  '  let blocked = 0;',
  '  function installGuard(wc) {',
  '    try {',
  '      wc.on("will-frame-navigate", (d) => {',
  '        const u = (d && d.url) || "";',
  '        const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);',
  '        if (!m) { return; }',
  '        if (allow.includes(m[1].toLowerCase())) { return; }',
  '        blocked++;',
  '        try { d.preventDefault(); } catch { /* 忽略 */ }',
  '      });',
  '    } catch { /* 忽略 */ }',
  '  }',
  '  installGuard(win.webContents);',
  '  let guest = null;',
  '  win.webContents.once("did-attach-webview", (_e, gwc) => {',
  '    guest = gwc;',
  '    console.log("[probe] guest attached (" + tag + ")");',
  '    installGuard(gwc);',
  '  });',
  '  await win.loadFile(hostFile);',
  '  bead("shoot:" + tag + ":wait");',
  '  await new Promise((r) => setTimeout(r, 6500));',
  '  let url = "";',
  '  try { url = guest ? guest.getURL() : ""; } catch { /* 忽略 */ }',
  '  bead("shoot:" + tag + ":capture");',
  '  let shot = { whiteRatio: 0, w: 0, h: 0 };',
  '  try {',
  '    /* ⚠️ 再给 capturePage 加一道**自己的**超时：它卡住时不能让整个探针跟着卡死（否则只能靠外层杀进程）。 */',
  '    const img = await Promise.race([',
  '      guest.capturePage(),',
  '      new Promise((r) => setTimeout(() => r(null), 12000)),',
  '    ]);',
  '    if (img) { shot = stats(img); console.log("[probe] " + tag + " white=" + shot.whiteRatio.toFixed(3) + " blocked=" + blocked); }',
  '    else { console.log("[probe] capturePage 超时（12s）"); }',
  '  } catch (e) { console.log("[probe] capture failed", String(e && e.message)); }',
  '  return { url, blocked, ...shot };',
  '}',
  'app.whenReady().then(async () => {',
  '  bead("ready");',
  '  const outcome = {};',
  '  /* ⚠️⚠️ **必须置顶**：窗口被别的窗口遮挡时 Chromium 会**暂停该窗口的合成**',
  '     ⇒ `guest.capturePage()` **永远不 resolve**（实测卡死在这一步，探针白等 90 秒）。',
  '     （同宗：rAF 在窗口被遮挡时也会停 —— 本仓既有铁律。） */',
  '  const win = new BrowserWindow({ width: 1040, height: 840, show: true,',
  '    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });',
  '  win.setAlwaysOnTop(true);',
  '  win.moveTop();',
  '  win.focus();',
  '  try {',
  '    outcome.shot = await shoot(win, process.env.PROBE_HOST, process.env.PROBE_TAG || "x");',
  '  } catch (e) { outcome.error = String((e && e.message) || e); }',
  '  writeFileSync(OUT, JSON.stringify(outcome));',
  '  app.quit();',
  '});',
].join("\n"); }
