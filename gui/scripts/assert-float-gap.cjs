/*
 * 守卫（离屏实测 + 源码权威值）：**悬浮窗布局下不得残留空白条**（A-1149）。
 *
 * 用户实测：左栏收起 + 聊天窗口化（悬浮）+ 右栏占满 → 左边缘多出一小块空白，
 * 观感像"收起后不该出现的左侧边栏又露出来了"。
 *
 * 根因（机制，不是推测 —— 见下方两条断言各自锁住一半）：
 *   `.body` 是一行 flex：`[.sidebar][.main][.right-wrapper]`。
 *   悬浮态 `.main` 的内容是 `position:fixed` 浮层 ⇒ 对布局零贡献，而 CSS 里
 *   `.main { flex: 1 1 0% }` + `.main.main-float { min-width: 0 }`
 *   ⇒ **行内剩余空间全部被 `.main` 吸收**。于是只要右栏请求的不是整窗宽（旧代码
 *   `innerWidth - 48`，且 CSS 还把右栏 max-width 钉在 `100vw - 48px`），那 48px 就变成
 *   `.main` 的**实宽** —— 它位于右栏左侧，正好落在收起后的左栏位置上。
 *
 * 断言（关系性质，不写死窗口宽度）：
 *   【静态·权威值】App.tsx 里悬浮态的可达宽上限 = **整窗宽**（不得再减 48）；CSS 不得把
 *                  `.right-sidebar` 的 max-width 钉在 `100vw - 48px`。
 *   【动态·真实产物】真实 renderer 里逐宽度实测（左栏用**真按钮点击**收起）：
 *     ① 悬浮 + 右栏 = 整窗宽 → 剩 0：`.main` 宽 0、右栏 left=0 且 right=innerWidth
 *     ② 悬浮 + 右栏拖窄  → 剩余空间落在**左侧**（聊天让位处），右栏仍贴右边缘
 *     ③ 悬浮 + 左栏展开 + 请求整窗宽 → 右栏被收缩、不溢出、`.main` 仍 0
 *     ④ 任何组合都不得横向溢出（`.app` / 文档 scrollWidth == clientWidth）
 *     ⑤ 回归：左栏收起恒 0 宽；普通（非悬浮）布局右栏仍贴右边缘且聊天区 ≥ 200px
 *   另有 `float-legacy` 取证行：按**修复前**的取值摆一遍，把"48px 落在左边缘"原样量出来
 *   （不计入通过/失败，避免守卫变成"必须保留 bug"）。
 *
 * 用法（必须在 gui/ 下跑，且 out/renderer 已构建；Windows 上 Electron 是 GUI 子系统进程，
 * 结论写文件，不依赖 stdout）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/assert-float-gap.cjs
 * 退出码 0 = 全部通过；1 = 有断言失败（逐条写进报告）。
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const rendererDir = path.join(guiDir, "out", "renderer");
const appTsx = path.join(guiDir, "src", "renderer", "App.tsx");
const cssPath = path.join(guiDir, "src", "renderer", "index.css");
const outDir = path.join(guiDir, "out", "float-gap-probe");
const reportPath = path.join(outDir, "report.json");

/* ── 静态权威值：只从源码读，不在这里写死 ──
 * ⚠️ 解析前**必须剥掉注释**：本仓注释里大量引用被删掉的旧取值（如"删掉 calc(100vw - 48px)"），
 *    不剥就会把**注释里的字面量**当成代码判据 → 假红/假绿（A-1019④-R2 的坑①同款）。 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")           // 块注释
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");      // 行注释（保留 http:// 这类）

function readAuthority() {
  const src = stripComments(fs.readFileSync(appTsx, "utf8"));
  const css = stripComments(fs.readFileSync(cssPath, "utf8"));
  const staticFailures = [];

  const fn = /function rightSidebarMaxW\(\)[^]*?\n  \}/.exec(src);
  if (!fn) { throw new Error("取不到 rightSidebarMaxW（守卫自己失效了）"); }
  const floatBranch = /floatActive\s*\??\s*([^:\n]+)\n?\s*:/.exec(fn[0]);
  if (!floatBranch) { throw new Error("取不到 rightSidebarMaxW 的 floatActive 分支（守卫自己失效了）"); }
  const floatExpr = floatBranch[1].trim();
  if (/- ?48\b/.test(floatExpr)) {
    staticFailures.push(`rightSidebarMaxW 悬浮分支仍预留 48px：${floatExpr}（应 = 整窗宽，否则那 48px 会变成 .main 的空白实宽）`);
  }

  const toggle = /function handleToggleFloat\(\)[^]*?\n  \}/.exec(src);
  if (!toggle) { throw new Error("取不到 handleToggleFloat（守卫自己失效了）"); }
  const call = /animateRightSidebar\(true,([^)]*)\)/.exec(toggle[0]);
  if (!call) { throw new Error("取不到 handleToggleFloat 里的 animateRightSidebar 调用（守卫自己失效了）"); }
  if (/- ?48\b/.test(call[1])) {
    staticFailures.push(`handleToggleFloat 仍请求 innerWidth - 48：${call[1].trim()}（应请求整窗宽）`);
  }

  const maxW = /\.right-sidebar \{[^}]*max-width:\s*([^;]+);/.exec(css);
  if (!maxW) { throw new Error("取不到 .right-sidebar 的 max-width（守卫自己失效了）"); }
  if (/100vw\s*-\s*48px/.test(maxW[1])) {
    staticFailures.push(`.right-sidebar 的 max-width 仍是 ${maxW[1].trim()}：即使宽度请求整窗宽，也会被这条钉回 48px 缺口`);
  }

  return { floatExpr, toggleExpr: call[1].trim(), maxW: maxW[1].trim(), staticFailures };
}

/** 静态解析失败**不弹窗崩溃**（Windows 上会让用户看到一个 JS Error 对话框）：
 *  记成失败项、走正常退出码 1，报告里写明原因。 */
let AUTH;
try {
  AUTH = readAuthority();
} catch (e) {
  AUTH = { floatExpr: "(解析失败)", toggleExpr: "(解析失败)", maxW: "(解析失败)", staticFailures: [`静态解析失败：${(e && e.message) || e}`] };
}

const WIDTHS = process.env.SLIME_FLOAT_GAP_WIDTHS
  ? process.env.SLIME_FLOAT_GAP_WIDTHS.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)
  : [1600, 1280, 1000];
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

/* 与 assert-layout-fit.cjs 同款：API 全 stub（本探针只看布局，不看数据） */
const STUB_JS = `(function () {
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

/** 真实点击标题栏的「收起侧栏」按钮（走 React 真路径 + 真过渡）。
 *  调用方负责**自证 + 重试**（App 每 15s 轮询 / 首屏异步加载都会重渲染，
 *  单次 click 不能当作"已收起"）。 */
const COLLAPSE_LEFT = `(() => {
  const btn = document.querySelector('.titlebar .titlebar-btn');
  if (!btn) { return "no-button"; }
  if (!document.querySelector(".sidebar.collapsed")) { btn.click(); }
  return "clicked";
})()`;

const LEFT_STATE = `(() => {
  const el = document.querySelector(".sidebar");
  if (!el) { return JSON.stringify({ shell: false }); }
  return JSON.stringify({
    collapsedClass: el.classList.contains("collapsed"),
    w: Math.round(el.getBoundingClientRect().width),
    cls: el.className,
  });
})()`;

/** 把目标态**钉住**（截图是异步的，几十毫秒里 React 可能重渲染把注入态刷掉 ——
 *  实测就撞上过：同一模式量到 collapsed、截出来却是 expanded）。
 *  截图期间逐帧重放同一状态，截完立刻解钉；**测量走单次同步脚本**（不需要钉）。 */
const pinMode = (mode) => `(() => {
  if (window.__slimePin) { cancelAnimationFrame(window.__slimePin); }
  const applyOnce = () => {
    const left = document.querySelector(".sidebar");
    const main = document.querySelector(".main");
    const right = document.querySelector(".right-sidebar");
    if (!left || !main || !right) { return; }
    const vw = window.innerWidth;
    left.style.transition = "none";
    right.style.transition = "none";
    left.classList.toggle("collapsed", ${mode === "float-leftopen" ? "false" : "true"});
    main.classList.remove("main-float");
    right.style.width = "";
    if ("${mode}" === "float-full" || "${mode}" === "float-leftopen") { main.classList.add("main-float"); right.style.width = vw + "px"; }
    else if ("${mode}" === "float-legacy") { main.classList.add("main-float"); right.style.width = Math.max(560, vw - 48) + "px"; }
    else if ("${mode}" === "float-narrow") { main.classList.add("main-float"); right.style.width = Math.max(360, vw - 400) + "px"; }
    else if ("${mode}" === "inline") { right.style.width = Math.max(560, vw - 48) + "px"; }
  };
  const tick = () => { applyOnce(); window.__slimePin = requestAnimationFrame(tick); };
  applyOnce();
  /* ⚠️ 隐藏窗口（show:false）里 rAF 会被节流甚至不触发 ⇒ 只用 rAF 钉不住
     （实测：截图仍是 React 回滚后的样子）。所以再挂一条定时器兜底重放。 */
  window.__slimePin = setInterval(applyOnce, 25);
  return "pinned";
})()`;

const unpinMode = `(() => {
  if (window.__slimePin !== undefined && window.__slimePin !== null) {
    clearInterval(window.__slimePin);
    cancelAnimationFrame(window.__slimePin);
    window.__slimePin = null;
  }
  const left = document.querySelector(".sidebar");
  const right = document.querySelector(".right-sidebar");
  if (left) { left.style.transition = ""; }
  if (right) { right.style.transition = ""; }
  return "unpinned";
})()`;

/** 摆好目标态 **并** 量几何（同一个同步脚本内完成）。
 *
 *  ⚠️ 两个必须这么做的理由（都实测踩过）：
 *   ① 宽度有 0.5s CSS 过渡（与 App 的收展动画同源）——赋值后立刻量到的是**动画起点**；
 *   ② 真实页面每 15s 轮询 `loadSessions` 会重渲染 → **跨 tick 注入的 DOM 会被 React 擦掉**
 *      （上一版等 800ms 再量，量到的其实是"刚被复位"的样子）。
 *  ⇒ 同 tick 内 `transition:none` + 直接量：既拿到**稳态几何**，又不给 React 擦除的机会。
 *     （动画本身由 assert-collapse-anim.cjs 等守卫负责，本探针只管最终几何。）
 *
 * mode：
 *   float-full    : main-float + 右栏请求整窗宽（修复后的 App 行为）
 *   float-legacy  : main-float + 右栏请求 innerWidth-48（修复前，取证用）
 *   float-narrow  : main-float + 右栏拖窄到 vw-400
 *   inline        : 普通布局 + 右栏请求 innerWidth-48
 *   float-leftopen: 左栏展开 + main-float + 右栏请求整窗宽
 */
const applyAndMeasure = (mode) => `(() => {
  const left = document.querySelector(".sidebar");
  const main = document.querySelector(".main");
  const wrap = document.querySelector(".right-wrapper");
  const right = document.querySelector(".right-sidebar");
  if (!left || !main || !wrap || !right) { return JSON.stringify({ shell: false }); }
  const vw = window.innerWidth;
  // ① 禁过渡（量稳态；不改变任何宽度语义）
  left.style.transition = "none";
  right.style.transition = "none";
  wrap.style.transition = "none";
  // ② 摆状态
  left.classList.toggle("collapsed", ${mode === "float-leftopen" ? "false" : "true"});
  main.classList.remove("main-float");
  right.style.width = "";
  if ("${mode}" === "float-full" || "${mode}" === "float-leftopen") { main.classList.add("main-float"); right.style.width = vw + "px"; }
  else if ("${mode}" === "float-legacy") { main.classList.add("main-float"); right.style.width = Math.max(560, vw - 48) + "px"; }
  else if ("${mode}" === "float-narrow") { main.classList.add("main-float"); right.style.width = Math.max(360, vw - 400) + "px"; }
  else if ("${mode}" === "inline") { right.style.width = Math.max(560, vw - 48) + "px"; }
  // ③ 量
  const R = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
  const appEl = document.querySelector(".app");
  const out = {
    vw, shell: true,
    left: R(left), main: R(main), wrap: R(wrap), right: R(right),
    appScrollW: appEl.scrollWidth, appClientW: appEl.clientWidth,
    deScrollW: document.documentElement.scrollWidth, deClientW: document.documentElement.clientWidth,
    leftCssWidth: getComputedStyle(left).width,
    rightInlineWidth: right.style.width || "(none)",
    rightCssMaxWidth: getComputedStyle(right).maxWidth,
    mainCssFlex: getComputedStyle(main).flex,
  };
  // ④ 还原（不留副作用给下一次/给页面）
  left.style.transition = "";
  right.style.transition = "";
  wrap.style.transition = "";
  return JSON.stringify(out);
})()`;

function judge(d) {
  const f = [];
  if (!d.shell) { return ["骨架未渲染（.app/.sidebar/.main/.right-sidebar 缺失）"]; }
  const inVp = (r) => r && r.l >= -0.5 && r.r <= d.vw + 0.5;
  if (d.appScrollW > d.appClientW + 1) { f.push(`.app 横向溢出 ${d.appScrollW} > ${d.appClientW}`); }
  if (d.deScrollW > d.deClientW + 1) { f.push(`文档横向溢出 ${d.deScrollW} > ${d.deClientW}`); }
  if (d.mode !== "float-leftopen" && d.left.w !== 0) { f.push(`收起态左栏宽度应为 0，实测 ${d.left.w}`); }
  if (d.mode === "float-full") {
    if (d.main.w !== 0) { f.push(`悬浮+右栏占满时 .main 仍占 ${d.main.w}px（= 左边缘那条空白）`); }
    if (d.right.l !== 0) { f.push(`右栏未贴左边缘：left=${d.right.l}（应 0）`); }
    if (d.right.r !== d.vw) { f.push(`右栏未贴右边缘：right=${d.right.r}（应 ${d.vw}）`); }
  }
  if (d.mode === "float-narrow") {
    if (d.right.r !== d.vw) { f.push(`拖窄态右栏未贴右边缘：right=${d.right.r}（应 ${d.vw}）`); }
    if (d.main.l !== 0) { f.push(`拖窄态剩余空间未落在左侧：.main.left=${d.main.l}`); }
    if (d.main.w < 100) { f.push(`拖窄态让位区过窄：${d.main.w}px`); }
  }
  if (d.mode === "float-leftopen") {
    if (!inVp(d.right)) { f.push(`左栏展开时右栏越界 ${JSON.stringify(d.right)}`); }
    if (d.main.w !== 0) { f.push(`左栏展开+悬浮时 .main 仍占 ${d.main.w}px`); }
  }
  if (d.mode === "inline") {
    if (d.right.r !== d.vw) { f.push(`普通布局右栏未贴右边缘：right=${d.right.r}（应 ${d.vw}）`); }
    if (d.main.w < 200) { f.push(`普通布局聊天区被挤到 ${d.main.w}px`); }
  }
  return f;
}

const MODES = ["float-full", "float-legacy", "float-narrow", "inline", "float-leftopen"];

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
    throw new Error(`未找到构建产物 ${path.join(rendererDir, "index.html")} —— 先跑 electron-vite build`);
  }
  const server = await startStaticServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({
    width: WIDTHS[0], height: HEIGHT, show: false, frame: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  await wc.loadURL(`${origin}/index.html`);
  await wait(2000);

  // 左栏收起走**真路径**（标题栏按钮 → React state → CSS 过渡），等过渡跑完再量；
  // 单次 click 不算数 —— 自证 + 必要时重试（见 COLLAPSE_LEFT 注释）。
  let clickRes = "";
  let collapsedW = -1;
  for (let i = 0; i < 4; i++) {
    clickRes = await wc.executeJavaScript(COLLAPSE_LEFT, true);
    await wait(900);
    const st = JSON.parse(await wc.executeJavaScript(LEFT_STATE, true));
    collapsedW = st.w;
    if (st.collapsedClass && st.w === 0) { break; }
  }

  const results = [];
  const failures = [];
  for (const vw of WIDTHS) {
    for (let i = 0; i < 20; i++) {
      win.setContentSize(vw, HEIGHT);
      await wait(150);
      const cur = await wc.executeJavaScript("window.innerWidth", true);
      if (Math.abs(cur - vw) <= 1) { break; }
    }
    await wc.executeJavaScript(COLLAPSE_LEFT, true);
    await wait(700);
    for (const mode of MODES) {
      let d;
      try {
        d = JSON.parse(await wc.executeJavaScript(applyAndMeasure(mode), true));
      } catch (e) {
        d = { shell: false, probeError: String((e && e.message) || e) };
      }
      d.mode = mode;
      d.targetW = vw;
      const bad = judge(d);
      d.failures = bad;
      if (bad.length && mode !== "float-legacy") { failures.push({ vw, mode, failures: bad }); }
      results.push(d);
      // 可选：逐模式截图取证（与 assert-layout-fit.cjs 同款惯例）。
      // ⚠️ 截图是异步的，必须先**钉住目标态**（否则 React 重渲染会让"量到的"与"截到的"不一致）。
      if (process.env.SLIME_FLOAT_GAP_SHOT) {
        try {
          await wc.executeJavaScript(pinMode(mode), true);
          const img = await wc.capturePage();
          const png = img.toPNG();
          if (png && png.length > 2048) {
            const name = `w${vw}-${mode}.png`;
            fs.writeFileSync(path.join(outDir, name), png);
            d.shot = name;
          }
        } catch (e) { d.shotError = String((e && e.message) || e); }
        finally { try { await wc.executeJavaScript(unpinMode, true); } catch { /* ignore */ } }
      }
    }
  }

  const summary = results.map((d) =>
    `vw=${d.vw} ${d.mode}: left.w=${d.left.w} main.w=${d.main.w} right.l=${d.right.l} right.w=${d.right.w} right.r=${d.right.r} overflow=${d.appScrollW - d.appClientW}`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(), authority: AUTH, widths: WIDTHS,
    leftCollapseClick: clickRes, leftCollapsedWidth: collapsedW,
    results, failures, summary,
  }, null, 2), "utf8");
  console.log(`左栏收起真路径：click=${clickRes}，收起后实测宽=${collapsedW}`);
  console.log(summary.join("\n"));
  console.log("静态权威值：悬浮上限=" + AUTH.floatExpr + " · 唤出请求=" + AUTH.toggleExpr + " · 右栏 max-width=" + AUTH.maxW);
  const staticBad = AUTH.staticFailures;
  if (staticBad.length) { console.log("✗ 静态：" + staticBad.join(" | ")); }
  console.log(failures.length ? `✗ ${failures.length} 项失败：\n` + failures.map((f) => `  ${f.vw} ${f.mode}: ${f.failures.join(" | ")}`).join("\n") : "✓ 悬浮布局零残留空白");
  console.log("报告: " + reportPath);
  if (!win.isDestroyed()) { win.destroy(); }
  server.close();
  app.exit(staticBad.length + failures.length ? 1 : 0);
}).catch((e) => {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ fatal: String((e && e.stack) || e) }, null, 2), "utf8");
  } catch { /* ignore */ }
  console.log("启动失败:", (e && e.stack) || e);
  app.exit(2);
});
