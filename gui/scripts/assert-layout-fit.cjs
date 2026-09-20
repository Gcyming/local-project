/*
 * 布局探针 / 守卫：**窗口小到多大时界面开始"出屏幕"**（A-1019）。
 *
 * 为什么必须离屏实测：布局溢出是**静默**的 —— 窗口被缩小后，右侧栏/标题栏按钮被推出可视区，
 * 但 DOM 全都"在"、tsc / vitest / 产物断言全绿。只有量真实几何才能发现。
 * A-1018 的教训：`WIN_MIN.width`（窗口地板）与 `.app { min-width }`（布局地板）是两个独立数字，
 * 一旦窗口地板 < 布局地板，窗口就能被缩到布局装不下的尺寸 → 横向滚动 / 右栏被推出屏幕。
 * 本脚本把这条关系变成断言，并把每个宽度的截图落盘作为**可复核的肉眼证据**。
 *
 * 实现要点（都踩过）：
 *   · 只开**一个** BrowserWindow，逐宽度 setContentSize —— 反复 new BrowserWindow 会在第 2 个
 *     就 ERR_FAILED (-2)，量不完。
 *   · 真实渲染层里有未守卫的 `window.slimeAPI.xxx`（TasksTab 的 `.chat`），缺 API 时整棵树被
 *     ErrorBoundary 拦下 → 注入同源 stub（外部脚本，不放宽 CSP）让界面以空数据挂载。
 *   · 用本地 http 提供产物（file:// 下 CSP 的 'self' 匹配不上，module script 会被挡）。
 *
 * 断言的是**关系性质**，不写死任何像素值：
 *   ① `.app` / 文档不产生横向溢出（scrollWidth <= clientWidth + 1）—— 溢出 = 一定有内容在屏幕外
 *   ② 三栏都在视口内（left >= 0 且 right <= innerWidth）
 *   ③ 标题栏的两个开合按钮都在视口内（用户报的"侧边栏按钮消失"就是它被推出去了）
 *   ④ 侧栏底部的「设置」按钮在视口内
 *   ⑤ 正文区不被两侧栏挤到不可读（< 200px）
 *
 * 用法（必须在 gui/ 下跑；Windows 上 Electron 是 GUI 子系统进程，结论写文件，不依赖 stdout）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/assert-layout-fit.cjs
 * 可用环境变量 SLIME_LAYOUT_WIDTHS=1440,976,900 覆盖测宽列表。
 * 退出码 0 = 全部宽度都装得下；1 = 有宽度装不下（逐条打印）。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const projectRoot = path.join(guiDir, "..");
const rendererDir = path.join(guiDir, "out", "renderer");
const srcCss = path.join(guiDir, "src", "renderer", "index.css");
const shotDir = path.join(guiDir, "out", "layout-probe");
const reportPath = path.join(shotDir, "report.json");

/* ── 权威值全部**从源码读出**，不在这里硬编码 ──
 * 硬编码的守卫会在权威值改动后静默失效（A-1019 的教训：守卫 ① 锁了" WIN_MIN ≥ 三栏之和"，
 * 通过了，可真正决定地板的是 `.app { min-width: 1100px }` —— 没有任何守卫看它）。 */
function readAuthority() {
  const mainSrc = fs.readFileSync(path.join(guiDir, "src", "main", "index.ts"), "utf8");
  const appSrc = fs.readFileSync(path.join(guiDir, "src", "renderer", "App.tsx"), "utf8");
  const cssSrc = fs.readFileSync(srcCss, "utf8");

  const pick = (src, re, label) => {
    const m = re.exec(src);
    if (!m) { throw new Error(`取不到 ${label}（正则 ${re} 未命中 → 守卫自己失效了）`); }
    return Number(m[1]);
  };
  const winMinW = pick(mainSrc, /const WIN_MIN = \{ width: (\d+), height: \d+ \}/, "WIN_MIN.width");
  const sidebarMin = pick(appSrc, /const SIDEBAR_MIN_W = (\d+)/, "SIDEBAR_MIN_W");
  const chatMin = pick(appSrc, /const CHAT_MIN_W = (\d+)/, "CHAT_MIN_W");
  const rsBlock = /\.right-sidebar \{[^}]*min-width:\s*(\d+)px/.exec(cssSrc);
  if (!rsBlock) { throw new Error("取不到 .right-sidebar 的 min-width"); }
  const rightMin = Number(rsBlock[1]);

  /** `.app` / `.body` 的 min-width。
   *  ⚠️ 必须遍历**所有**同名块：文件开头有 `body, #root, .app { user-select: none }`
   *  这种选择器列表块，只取第一个会锁错对象（变异测试当场抓出来的）。 */
  const blockMinWidth = (cls) => {
    const re = new RegExp(`\\.${cls} \\{([^}]*)\\}`, "g");
    let m;
    let seen = false;
    let hit = null;
    while ((m = re.exec(cssSrc))) {
      seen = true;
      const mm = /min-width:\s*(\d+)px/.exec(m[1]);
      if (mm) { hit = Number(mm[1]); }
    }
    if (!seen) { return { found: false, value: null }; }
    return { found: true, value: hit === null ? 0 : hit };
  };

  /** 侧栏宽度变量里的百分比：固有尺寸阶段不可解析 → flex item 退化成 auto → 外层容器按
   *  内容的 max-content 撑宽（实测 431px vs 真实 260px）。必须是 vw 这类可解析的绝对量。 */
  const pctVar = /--(?:sidebar-w|right-sidebar-w)\s*:\s*[^;]*%/.exec(cssSrc);

  return {
    winMinW, sidebarMin, chatMin, rightMin,
    layoutFloor: sidebarMin + chatMin + rightMin,
    app: blockMinWidth("app"),
    body: blockMinWidth("body"),
    pctVar: pctVar ? pctVar[0].trim() : null,
  };
}

const AUTH = readAuthority();

/** 待测宽度：只要窗口**能缩到**的宽度都必须装得下。
 * 默认从窗口地板起，覆盖到用户实测过的常见值；可用 SLIME_LAYOUT_WIDTHS 覆盖。 */
const WIDTHS = process.env.SLIME_LAYOUT_WIDTHS
  ? process.env.SLIME_LAYOUT_WIDTHS.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)
  : [...new Set([AUTH.winMinW, AUTH.winMinW + 1, 1024, 1100, 1280, 1440])].sort((a, b) => a - b);
const HEIGHT = 900;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

const STUB_JS = `/* layout-probe stub — 仅探针使用，不进产物 */
(function () {
  function make(tag) {
    return new Proxy(function () {}, {
      get: function (t, prop) {
        if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") { return function () { return ""; }; }
        if (prop === Symbol.iterator) { return function () { return [][Symbol.iterator](); }; }
        if (typeof prop === "symbol") { return undefined; }
        if (prop === "then" || prop === "catch" || prop === "finally") { return undefined; }
        if (prop === "length" || prop === "size") { return 0; }
        return make(tag + "." + String(prop));
      },
      apply: function () { return Promise.resolve([]); },
      construct: function () { return {}; },
    });
  }
  /* 预设"用户拖过侧栏"的持久化宽度（每个探针跑在随机端口 = 新 origin，localStorage 天然是空的，
     所以必须在这里写）。用于验证 inline px 覆盖 + 窗口变窄这条边界不会溢出。 */
  try {
    var preset = ${JSON.stringify(process.env.SLIME_LAYOUT_PRESET_DRAGGED || "")};
    if (preset === "wide") { localStorage.setItem("slime_sidebar_w", "520"); localStorage.setItem("slime_rightbar_w", "700"); }
    if (preset === "narrow") { localStorage.setItem("slime_sidebar_w", "240"); localStorage.setItem("slime_rightbar_w", "260"); }
  } catch (e) {}
  try { window.slimeAPI = make("slimeAPI"); } catch (e) {}
})();
`;

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/probe-stub.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(STUB_JS);
      return;
    }
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const abs = path.join(rendererDir, rel);
    if (!abs.startsWith(rendererDir)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const ext = path.extname(abs).toLowerCase();
      let body = buf;
      // stub 必须在 module script 之前执行：classic script 立即执行，module 延迟执行
      if (ext === ".html") {
        body = Buffer.from(buf.toString("utf8").replace("<head>", '<head>\n    <script src="./probe-stub.js"></script>'), "utf8");
      }
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里执行的量测：返回 JSON 字符串 */
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const R = (sel) => {
    const el = document.querySelector(sel);
    if (!el) { return null; }
    const r = el.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const offscreen = [];
  document.querySelectorAll("body *").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) { return; }
    if (r.right > vw + 0.5 || r.left < -0.5) {
      offscreen.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === "string" ? el.className.slice(0, 48) : "",
        text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 28),
        l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width),
        depth: (() => { let d = 0, p = el; while (p.parentElement) { d++; p = p.parentElement; } return d; })(),
      });
    }
  });
  const maxDepth = offscreen.reduce((m, o) => Math.max(m, o.depth), 0);
  const deepest = offscreen.filter((o) => o.depth >= maxDepth - 1);
  const appEl = document.querySelector(".app");
  const de = document.documentElement;
  return JSON.stringify({
    vw, vh,
    shell: !!appEl,
    appScrollW: appEl ? appEl.scrollWidth : -1,
    appClientW: appEl ? appEl.clientWidth : -1,
    deScrollW: de.scrollWidth, deClientW: de.clientWidth,
    docScrollW: document.body.scrollWidth,
    app: R(".app"), body: R(".body"), titlebar: R(".titlebar"),
    sidebar: R(".sidebar"), main: R(".main"), rightWrapper: R(".right-wrapper"), rightSidebar: R(".right-sidebar"),
    titlebarBtns: Array.from(document.querySelectorAll(".titlebar .titlebar-btn")).map((b) => {
      const r = b.getBoundingClientRect();
      return { title: b.getAttribute("title") || "", l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
    }),
    settingsBtn: (() => {
      const b = document.querySelector('.sidebar .titlebar-btn[title^="设置"]');
      if (!b) { return null; }
      const r = b.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    offscreenCount: offscreen.length,
    offscreenDeepest: deepest.slice(0, 14),
    /** 宽度来源取证：431 这类"恒定值"必须查清出处，否则改一处坏一处 */
    cssProbe: (() => {
      const pick = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) { return null; }
        const cs = getComputedStyle(el);
        const o = {};
        props.forEach((p) => { o[p] = cs[p]; });
        o._inlineWidth = el.style.width || "(none)";
        return o;
      };
      return {
        rootVars: {
          rightSidebarW: getComputedStyle(document.documentElement).getPropertyValue("--right-sidebar-w").trim(),
          sidebarW: getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim(),
        },
        app: pick(".app", ["minWidth", "width", "overflowX"]),
        body: pick(".body", ["minWidth", "width", "overflowX"]),
        wrapper: pick(".right-wrapper", ["minWidth", "width", "flex", "flexBasis", "flexGrow", "flexShrink"]),
        rightSidebar: pick(".right-sidebar", ["minWidth", "width", "maxWidth", "flexBasis", "flexGrow", "flexShrink"]),
        sidebar: pick(".sidebar", ["minWidth", "width", "maxWidth", "flexShrink"]),
        main: pick(".main", ["minWidth", "flex", "flexBasis", "overflow"]),
      };
    })(),
    errorText: (() => { const e = document.querySelector(".error-boundary, [data-error-boundary]"); return e ? (e.innerText || "").slice(0, 160) : null; })(),
  });
})()`;

/** 单宽度的判定：返回失败项数组 */
function judge(d) {
  const f = [];
  if (!d.shell) { f.push("骨架未渲染（.app 缺失）"); return f; }
  const inVp = (r) => r && r.l >= -0.5 && r.r <= d.vw + 0.5;
  if (d.appScrollW > d.appClientW + 1) { f.push(`.app 横向溢出 scrollW=${d.appScrollW} > clientW=${d.appClientW}（多出 ${d.appScrollW - d.appClientW}px）`); }
  if (d.deScrollW > d.deClientW + 1) { f.push(`文档横向溢出 scrollW=${d.deScrollW} > clientW=${d.deClientW}`); }
  if (!inVp(d.sidebar)) { f.push(`左栏越界 ${JSON.stringify(d.sidebar)}`); }
  if (d.rightSidebar && !inVp(d.rightSidebar)) { f.push(`右栏越界 ${JSON.stringify(d.rightSidebar)}`); }
  if (d.rightWrapper && !inVp(d.rightWrapper)) { f.push(`右栏容器越界 ${JSON.stringify(d.rightWrapper)}`); }
  if (d.main && d.main.w < 200) { f.push(`正文区被挤到 ${d.main.w}px（可读性下限 200）`); }
  d.titlebarBtns.forEach((b) => { if (b.r > d.vw + 0.5 || b.l < -0.5) { f.push(`标题栏按钮「${b.title}」越界 l=${b.l} r=${b.r}`); } });
  if (d.settingsBtn && (d.settingsBtn.r > d.vw + 0.5 || d.settingsBtn.l < -0.5)) { f.push(`侧栏「设置」按钮越界 ${JSON.stringify(d.settingsBtn)}`); }
  return f;
}

app.whenReady().then(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await startStaticServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const allDiag = [];

  const win = new BrowserWindow({
    width: WIDTHS[0], height: HEIGHT, show: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const push = (s) => { allDiag.push(s); };
  wc.on("console-message", (e) => {
    const msg = e && e.message !== undefined ? e.message : "";
    const level = e && e.level !== undefined ? e.level : "";
    if (String(msg).includes("frame-ancestors")) { return; }
    push(`[console:${level}] ${String(msg).slice(0, 240)}`);
  });
  wc.on("render-process-gone", (_e, dd) => push(`[render-process-gone] ${JSON.stringify(dd)}`));
  wc.on("did-fail-load", (_e, code, desc, url) => push(`[did-fail-load] ${code} ${desc} ${url}`));

  await wc.loadURL(`${origin}/index.html`);
  await wait(1800);

  const results = [];
  const failures = [];
  for (const w of WIDTHS) {
    win.setContentSize(w, HEIGHT);
    await wait(600);
    let d;
    try {
      d = JSON.parse(await wc.executeJavaScript(MEASURE, true));
    } catch (e) {
      d = { shell: false, probeError: String((e && e.message) || e) };
    }
    d.width = w;
    const bad = judge(d);
    d.failures = bad;
    if (bad.length) { failures.push({ width: w, failures: bad }); }
    results.push(d);
    try {
      const img = await wc.capturePage();
      const png = img.toPNG();
      if (png && png.length > 2048) { fs.writeFileSync(path.join(shotDir, `w${w}.png`), png); d.shot = `w${w}.png`; }
    } catch (e) { d.shotError = String((e && e.message) || e); }

    console.log(`\n=== 目标 ${w}px（实际视口 ${d.vw}） ===`);
    console.log(`  骨架=${d.shell ? "有" : "无"}  溢出元素=${d.offscreenCount}`);
    if (d.probeError) { console.log(`  探针异常: ${d.probeError}`); }
    console.log(`  .app      ${JSON.stringify(d.app)}   scrollW=${d.appScrollW} clientW=${d.appClientW}`);
    console.log(`  .sidebar  ${JSON.stringify(d.sidebar)}`);
    console.log(`  .main     ${JSON.stringify(d.main)}`);
    console.log(`  .wrapper  ${JSON.stringify(d.rightWrapper)}`);
    console.log(`  .right    ${JSON.stringify(d.rightSidebar)}`);
    console.log(`  标题栏按钮 ${JSON.stringify(d.titlebarBtns)}`);
    console.log(`  设置按钮   ${JSON.stringify(d.settingsBtn)}`);
    (d.offscreenDeepest || []).slice(0, 10).forEach((o) => console.log(`    ✂ <${o.tag} class="${o.cls}"> l=${o.l} r=${o.r} w=${o.w} "${o.text}"`));
    if (d.cssProbe) {
      const c = d.cssProbe;
      console.log(`  CSS 变量 --sidebar-w=${c.rootVars.sidebarW} --right-sidebar-w=${c.rootVars.rightSidebarW}`);
      console.log(`  .app     ${JSON.stringify(c.app)}`);
      console.log(`  .body    ${JSON.stringify(c.body)}`);
      console.log(`  .wrapper ${JSON.stringify(c.wrapper)}`);
      console.log(`  .right   ${JSON.stringify(c.rightSidebar)}`);
      console.log(`  .sidebar ${JSON.stringify(c.sidebar)}`);
      console.log(`  .main    ${JSON.stringify(c.main)}`);
    }
    console.log(bad.length ? `  ✗ ${bad.join(" | ")}` : "  ✓ 装得下");
  }

  if (!win.isDestroyed()) { win.destroy(); }
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), widths: WIDTHS, results, failures, diag: allDiag.slice(0, 60) }, null, 2), "utf8");
  server.close();

  console.log("\n================ 静态关系（源码级，不依赖运行时） ================");
  const staticFailures = [];
  console.log(`  WIN_MIN.width          = ${AUTH.winMinW}`);
  console.log(`  三栏硬下限之和（地板） = ${AUTH.layoutFloor}  (左${AUTH.sidebarMin} + 聊${AUTH.chatMin} + 右${AUTH.rightMin})`);
  console.log(`  .app  min-width        = ${AUTH.app.found ? AUTH.app.value + "px" : "(未声明 → 0)"}`);
  console.log(`  .body min-width        = ${AUTH.body.found ? AUTH.body.value + "px" : "(未声明 → 0)"}`);
  console.log(`  侧栏宽度变量用 %       = ${AUTH.pctVar ? "是（坏）" : "否（vw，好）"}`);

  if (AUTH.winMinW < AUTH.layoutFloor) {
    staticFailures.push(
      `窗口最小宽度 ${AUTH.winMinW} < 三栏下限之和 ${AUTH.layoutFloor}：窗口能缩到布局装不下的尺寸 → 右栏被推出屏幕`,
    );
  }
  [["app", AUTH.app], ["body", AUTH.body]].forEach(([name, info]) => {
    if (info.found && info.value > AUTH.layoutFloor) {
      staticFailures.push(
        `.${name} { min-width: ${info.value}px } > 三栏下限之和 ${AUTH.layoutFloor}：`
          + "这是一个比三栏下限更硬的「隐形地板」，会把整页钉宽、绕过三栏的 min-width 自动收缩（A-1019 根因）",
      );
    }
  });
  if (AUTH.pctVar) {
    staticFailures.push(
      `侧栏宽度变量用了百分比（${AUTH.pctVar}）：百分比在固有尺寸计算阶段不可解析，`
        + "会让外层容器的 max-content 退化成内容宽度（实测 431px vs 右栏真实 260px）→ 窄窗口下右栏先被顶出屏幕。请用 vw。",
    );
  }
  if (!staticFailures.length) { console.log("  ✓ 三条关系都成立"); }
  staticFailures.forEach((s) => console.log(`  ✗ ${s}`));

  console.log("\n================ 动态实测汇总 ================");
  if (!failures.length) {
    console.log(`窗口可达的全部 ${WIDTHS.length} 个宽度（${WIDTHS.join("/")}）界面都装得下 ✓`);
  } else {
    failures.forEach((f) => console.log(`  ✗ ${f.width}px: ${f.failures.join(" | ")}`));
  }
  if (allDiag.length) {
    console.log("\n---- 渲染层诊断（去重前 12 条） ----");
    [...new Set(allDiag)].slice(0, 12).forEach((x) => console.log(`  ${x}`));
  }
  console.log(`报告: ${reportPath}`);
  console.log(`截图: ${shotDir}\\w<width>.png`);

  const total = staticFailures.length + failures.length;
  app.exit(total ? 1 : 0);
}).catch((e) => { console.log("启动失败:", e && e.stack ? e.stack : e); app.exit(2); });
