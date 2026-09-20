/*
 * 浏览器加载失败页的**运行时取证**（A-1021）。
 *
 * 用户症状：「当网页无法加载时，不还是什么都不显示吗」+ 截图（右栏浏览器一片白）。
 *
 * 已有实现（A-1018）其实是完整的：`browserErrors.ts` 有归因表、`RightSidebar.tsx` 监听了
 * `did-fail-load`、`.browser-error-page` 也写了（absolute/inset:0/z-index:8）。
 * 所以「什么都不显示」必然发生在**状态机**层面，源码级断言看不出来 —— 必须真跑。
 *
 * 本探针：真窗口 + 真 webview + 真导航到一个**必然失败**的地址（127.0.0.1:1 → ECONNREFUSED），
 * 然后**长时间轮询** `.browser-error-page` 是否存在，记录时间线。
 * 判据：错误页必须出现，且**能稳定停留**（不能被随后的重试清掉）。
 *
 * 跑法（在 gui/ 下）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/assert-browser-error.cjs
 *   ↑ 不带环境变量 = 总控模式：**每个用例各起一个 Electron 进程**（见 runOrchestrator 注释）
 *   单跑某一例（调试用）：
 *   SLIME_PROBE_CASE=dns env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/assert-browser-error.cjs
 *   可用用例 key：refused / unsafe-port / dns / bare-222 / dead-port / typed-dead-port
 *
 * ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：它会让 electron.exe 退化成纯 node，
 * `require("electron")` 只拿到可执行文件路径字符串 → `app` 为 undefined。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const GUI = path.resolve(__dirname, "..");
const rendererDir = path.join(GUI, "out", "renderer");
const shotDir = path.join(GUI, "out", "browser-error-probe");
const FAIL_URL = process.env.SLIME_BROWSER_FAIL_URL || "http://127.0.0.1:1/";
const OBSERVE_MS = 6000;
const POLL_MS = 200;

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

const STUB_JS = `/* browser-error-probe stub — 仅探针使用，不进产物 */
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
  try { window.slimeAPI = make("slimeAPI"); } catch (e) {}
  /* 记录 webview 的重试节奏：onStart 每次都会清错误态，次数越多越说明在打转 */
  window.__probeLoads = 0;
  window.__probeFails = 0;
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

/**
 * 地面真值：从**主进程**侧订阅 webview guest 的真实导航事件。
 * 这是"外部观察"——不依赖渲染层自述，能判定"事件到底有没有发生"，
 * 从而把"没触发"和"触发了但界面没渲染"这两种失败区分开。
 */
const guestEvents = [];
function armGuestRecording() {
  app.on("web-contents-created", (_e, wc2) => {
    let type = "";
    try { type = wc2.getType(); } catch { type = ""; }
    if (type !== "webview") { return; }
    const push = (t, extra) => guestEvents.push({ t: Date.now(), type: t, ...extra });
    wc2.on("did-start-loading", () => push("did-start-loading", {}));
    wc2.on("did-stop-loading", () => push("did-stop-loading", {}));
    wc2.on("did-fail-load", (_ev, code, desc, url, isMainFrame) =>
      push("did-fail-load", { code, desc, url, main: isMainFrame }));
    wc2.on("did-navigate", (_ev, url) => push("did-navigate", { url }));
    wc2.on("did-navigate-in-page", (_ev, url) => push("did-navigate-in-page", { url }));
    push("guest-created", {});
  });
}

/** 模拟"在已挂载的页里手动输入地址并回车"（与"新建页导航"是两条不同时序的路径） */
const TYPE_AND_ENTER = (url) => `(() => {
  const input = document.querySelector("input.browser-url");
  if (!input) { return "no-input"; }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(url)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return "typed";
})()`;

/** 打开浏览器页并导航到失败地址；同时挂上 webview 事件计数（真事件，不改产品代码） */
const OPEN_AND_ARM = (url) => `(() => {
  window.dispatchEvent(new CustomEvent("slime:open-in-sidebar", { detail: { kind: "url", url: ${JSON.stringify(url)} } }));
  return "dispatched";
})()`;

/** 单次采样：错误页在不在？文案是什么？webview 当前 URL 是什么？ */
const SAMPLE = `(() => {
  const page = document.querySelector(".browser-error-page");
  const wv = document.querySelector("webview");
  const title = document.querySelector(".browser-error-title");
  const code = document.querySelector(".browser-error-code");
  const input = document.querySelector("input.browser-url");
  let wvUrl = "";
  try { wvUrl = wv && typeof wv.getURL === "function" ? wv.getURL() : ""; } catch (e) { wvUrl = "<err>"; }
  return JSON.stringify({
    hasWv: !!wv,
    pagePresent: !!page,
    title: title ? (title.textContent || "").trim() : "",
    code: code ? (code.textContent || "").trim() : "",
    inputValue: input ? input.value : "",
    wvUrl: wvUrl,
    /* 探针自己挂在同一个 <webview> 元素上的监听记录 —— 用于判定
       "DOM 事件到底有没有到达渲染层"（与应用内部监听无关，是独立观察点） */
    probeEvents: (wv && wv.__probeEvents ? wv.__probeEvents : []).slice(-8),
    probeArmed: !!(wv && wv.__probeArmed),
    probeId: wv ? (wv.__probeId || "") : "",
    /* 页面上出现过的 webview 元素总数：>1 说明组件被重挂载过（state 会丢） */
    wvCount: document.querySelectorAll("webview").length,
    /* A-1021：DOM 里现存的**错误页数量**。>1 说明多个常驻浏览器页并存 ——
       这正是第一版探针 5/5 假绿的原因（它永远读到第一个），必须显式暴露出来。 */
    errorPages: document.querySelectorAll(".browser-error-page").length,
    paneMountedAt: window.__probePaneMounts || 0,
  });
})()`;

/**
 * 给当前 `<webview>` 元素挂上探针自己的事件监听（幂等）。
 * 每个浏览器页会新建一个元素，所以每轮采样前都要调。
 * 记的是**真实 DOM 事件**：若它触发了、而错误页仍不出现 → 问题在渲染层处理逻辑；
 * 若它压根不触发 → 问题在事件根本没送到渲染层。
 */
const ARM_WV_LISTENER = `(() => {
  const wv = document.querySelector("webview");
  if (!wv) { return "no-wv"; }
  if (!wv.__probeId) { wv.__probeId = Math.random().toString(36).slice(2, 8); window.__probePaneMounts = (window.__probePaneMounts || 0) + 1; }
  if (wv.__probeArmed) { return "armed:" + wv.__probeId; }
  wv.__probeArmed = true;
  wv.__probeEvents = [];
  const rec = (t) => (e) => {
    try {
      /* A-1021：**必须记录事件对象的真实字段名**。
         本轮真凶是"应用读 e.url，而 Electron 的 DidFailLoadEvent 只有 validatedURL"——
         而本探针自己原来也读 e.url，于是**探针与病灶犯了同一个错**：它记到的 url 恒为空串，
         却因为输出里只打印 code，看不出来。现在把 own keys 一并记下，
         让"Electron 到底给了哪些字段"成为可断言的锁对象，而不是靠人记。
         ⚠️ 本段住在模板字符串里：注释中**不得出现反引号**，否则提前闭合。 */
      const keys = e ? Object.keys(e) : [];
      wv.__probeEvents.push({
        t: t,
        code: e && e.errorCode,
        url: (e && e.url || "").slice(0, 60),
        validatedURL: (e && e.validatedURL || "").slice(0, 80),
        keys: keys,
      });
      if (wv.__probeEvents.length > 40) { wv.__probeEvents.shift(); }
    } catch (err) { /* 忽略 */ }
  };
  ["did-start-loading", "did-stop-loading", "did-fail-load", "did-navigate"].forEach((t) => {
    wv.addEventListener(t, rec(t));
  });
  return "armed:" + wv.__probeId;
})()`;

/**
 * 失败类别矩阵。**必须覆盖多个类别**，因为它们走的 Chromium 错误码不同，
 * 而历史守卫恰好按错误码做了豁免（`-3` 被当成"重定向误报"）——
 * 只测一个类别会得出"修好了"的错误结论。
 *
 * A-1021 补：每条用例都带上 **expectCode**（本轮实测得到的确定值）。
 * 为什么必须有它：本轮第一次跑矩阵时 5/5 全绿，但报告里 5 条用例的
 * `title`/`code`/`inputValue` **全是第一条用例（65530 / -102）的**，
 * 而 `guestFailCode` 却是各自正确的 -312/-105/-109 ——
 * 说明探针自 `querySelector` 取的是 **DOM 里第一个** 错误页/`<webview>`（= 第 1 例留下的常驻页），
 * 第 2 例起测的全是别人的残留态，**绿得毫无意义**（"已经可见"被当成"这次显示了"）。
 * 于是：归因码必须双向锁死 —— 显示值 == guest 实测值 == 预期值。任一不等即红。
 */
const ALL_CASES = [
  { key: "refused", label: "连接被拒绝", input: "http://127.0.0.1:65530/", expectCode: -102 },
  { key: "unsafe-port", label: "不安全端口（曾表现为 -3）", input: "http://127.0.0.1:1/", expectCode: -312 },
  { key: "dns", label: "域名解析不了", input: "http://slime-nonexistent-host.invalid/", expectCode: -105 },
  { key: "bare-222", label: "用户截图里的输入「222」", input: "http://222", expectCode: -109 },
  { key: "dead-port", label: "普通死端口 19199", input: "http://127.0.0.1:19199/", expectCode: -102 },
];
const TYPED_CASES = [
  { key: "typed-dead-port", label: "输入死端口", input: "http://127.0.0.1:19199/", expectCode: -102 },
];

/* A-1021：**用例必须进程隔离**。
   病因：requestSidebarOpen 每轮都新建一个浏览器页，而按项目铁律 webview 是**常驻挂载**的
   （禁 `{open && <div>}`），旧页不卸载 → DOM 里会同时存在 5 个 `<webview>` / 5 个错误页。
   而探针用 querySelector 只能拿到第一个 → 从第 2 例开始就在测"第 1 例的残留"。
   单靠"取最后一个/取可见的"都是脆的（依赖 DOM 顺序与 CSS，正是本轮的踩坑模式），
   所以采用**无歧义**的隔离方式：一个用例一个进程，每个进程里 DOM 里只有它自己那一页。 */
const ONLY = process.env.SLIME_PROBE_CASE || "";
const ALL_KEYS = ALL_CASES.concat(TYPED_CASES).map((c) => c.key);
if (ONLY && ALL_KEYS.indexOf(ONLY) < 0) {
  console.error(`未知用例 SLIME_PROBE_CASE=${ONLY}；可选：${ALL_KEYS.join(", ")}`);
  process.exit(2);
}
const CASES = ONLY ? ALL_CASES.filter((c) => c.key === ONLY) : ALL_CASES;
const TYPED = ONLY ? TYPED_CASES.filter((c) => c.key === ONLY) : TYPED_CASES;

/**
 * 总控（无 SLIME_PROBE_CASE 时进入）：**一个用例一个 Electron 进程**，最后汇总。
 *
 * 这是本轮最重要的一条工程教训：探针 5/5 全绿，但报告里 5 条用例的 title/code/inputValue
 * 全是第一条的 —— 因为 webview 按铁律常驻挂载，旧页不卸载，`querySelector` 永远读到第一个。
 * "取最后一个""取可见的那个"都是在猜 DOM 顺序，脆；**进程隔离**才是无歧义的隔离。
 */
function runOrchestrator() {
  console.log("========== 浏览器失败页探针：用例进程隔离（总控） ==========");
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 必须在子进程里清掉：否则 electron.exe 退化成纯 node，require('electron') 拿不到 app
  const rows = [];
  for (const key of ALL_KEYS) {
    env.SLIME_PROBE_CASE = key;
    const r = spawnSync(process.execPath, [__filename], { env: env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const out = String(r.stdout || "") + String(r.stderr || "");
    const pass = /RESULT=PASS/.test(out);
    const failBlock = /RESULT=FAIL\n([\s\S]*)$/.exec(out);
    const mCode = /归因码闭环\s*:\s*(.*)/.exec(out);
    const mTitle = /标题\s*:\s*(.*)/.exec(out);
    rows.push({
      key, pass, exit: r.status,
      codeLine: mCode ? mCode[1].trim() : "",
      title: mTitle ? mTitle[1].trim() : "",
      fail: failBlock ? failBlock[1].trim() : "",
    });
    console.log(`${pass ? "OK  " : "FAIL"}  ${key.padEnd(16, " ")} exit=${r.status}   ${mCode ? mCode[1].trim() : ""}`);
  }

  /* 把各子进程的分报告合并成一份总报告（子进程写 report-<key>.json） */
  const merged = { generatedAt: new Date().toISOString(), isolatedPerCase: true, cases: [] };
  for (const row of rows) {
    const p = path.join(shotDir, `report-${row.key}.json`);
    try { merged.cases.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch { /* 缺失则跳过 */ }
  }
  try { fs.writeFileSync(path.join(shotDir, "report.json"), JSON.stringify(merged, null, 2), "utf8"); } catch { /* 忽略 */ }

  const bad = rows.filter((x) => !x.pass);
  console.log("\n================ 总控汇总 ================");
  rows.forEach((x) => console.log(`  ${x.pass ? "OK  " : "FAIL"}  ${x.key.padEnd(16, " ")} ${x.codeLine || x.title}`));
  if (bad.length) {
    console.log("\n未通过详情：");
    bad.forEach((x) => console.log(`  ── ${x.key}\n${x.fail.split("\n").map((l) => "     " + l).join("\n")}`));
  }
  console.log(`\n报告: ${path.join(shotDir, "report.json")}`);
  console.log(bad.length === 0 ? "\nRESULT=PASS" : `\nRESULT=FAIL (${bad.length}/${rows.length} 用例未过)`);
  app.exit(bad.length === 0 ? 0 : 1);
}

app.whenReady().then(async () => {
  if (!ONLY) { runOrchestrator(); return; }
  fs.mkdirSync(shotDir, { recursive: true });
  armGuestRecording();
  const server = await startStaticServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const diag = [];
  const failures = [];

  const win = new BrowserWindow({
    width: 1100, height: 820, show: false, frame: false,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false,
      webviewTag: true,   // ← 必须；否则 <webview> 不工作
    },
  });
  const wc = win.webContents;
  wc.on("console-message", (e) => {
    const msg = e && e.message !== undefined ? e.message : "";
    if (String(msg).includes("frame-ancestors")) { return; }
    diag.push(`[console] ${String(msg).slice(0, 200)}`);
  });

  await wc.loadURL(`${origin}/index.html`);
  await wait(2000);

  console.log("================ 浏览器失败页探针（矩阵） ================");
  console.log(`渲染层: ${origin}`);

  const results = [];
  for (const c of CASES) {
    const evStart = guestEvents.length;
    await wc.executeJavaScript(OPEN_AND_ARM(c.input), true);
    await wc.executeJavaScript(ARM_WV_LISTENER, true);
    const timeline = [];
    const t0 = Date.now();
    while (Date.now() - t0 < OBSERVE_MS) {
      await wc.executeJavaScript(ARM_WV_LISTENER, true);
      let s;
      try { s = JSON.parse(await wc.executeJavaScript(SAMPLE, true)); }
      catch (e) { s = { error: String((e && e.message) || e) }; }
      s.tMs = Date.now() - t0;
      timeline.push(s);
      await wait(POLL_MS);
    }
    const withPage = timeline.filter((s) => s.pagePresent);
    const first = withPage[0];
    const everShown = withPage.length > 0;
    const stable = everShown && timeline.slice(timeline.indexOf(first)).every((s) => s.pagePresent);
    const visibleRatio = withPage.length / timeline.length;
    const last = timeline[timeline.length - 1];
    const visibleOk = everShown && stable && visibleRatio > 0.6;
    const guest = guestEvents.slice(evStart);
    const failEv = guest.find((g) => g.type === "did-fail-load");

    /* ── A-1021 契约断言：渲染层拿到的 DOM 事件必须带非空 validatedURL ──
       guest 层既然报了 did-fail-load，渲染层就必须能回答"失败的是哪个 URL"。
       这条不成立 = Electron 换了字段名（或我们读错字段）→ 错误页必然永不显示，
       且只会表现为"结果 FAIL"而看不出原因（本轮就吃了这个亏）。
       单独断言，让契约本身成为锁对象，而不是只锁最终现象。 */
    const failProbe = (last && last.probeEvents ? last.probeEvents : []).filter((p) => p.t === "did-fail-load");
    const contractOk = !!failEv && failProbe.some((p) => (p.validatedURL || "").length > 0);
    // 反证：若事件里真有 `url` 这个 own key，说明是我读错了字段名，而不是 Electron 换名
    const hasBareUrlKey = failProbe.some((p) => (p.keys || []).includes("url"));
    if (!contractOk) {
      failures.push(
        `${c.label}（${c.input}）→ 事件契约不符：渲染层 did-fail-load 未带 validatedURL` +
        `（渲染层收到 ${failProbe.length} 次；字段 ${failProbe[0] ? JSON.stringify(failProbe[0].keys) : "无"}）`,
      );
    }

    if (!visibleOk) { failures.push(`${c.label}（${c.input}）→ 错误页${everShown ? "出现但不稳定" : "从未出现"}`); }

    /* ── A-1021 双向归因码锁 ──
       ① 界面显示的码必须 == guest 实测的码（归因正确性）；
       ② guest 实测的码必须 == 用例预期码（防 Chromium 行为漂移而用例表悄悄失效）。
       第一版探针之所以 5/5 假绿，就是因为没有任何一条断言在比较"显示的"与"实测的"。 */
    const mCode = /(-?\d+)\s*$/.exec(first ? first.code : "");
    const displayedCode = mCode ? Number(mCode[1]) : null;
    const attributionOk = !!failEv && displayedCode !== null && displayedCode === failEv.code;
    if (!attributionOk) {
      failures.push(
        `${c.label}（${c.input}）→ 归因码不符：界面显示 ${displayedCode === null ? "「" + (first ? first.code : "") + "」" : displayedCode}` +
        `，guest 实测 ${failEv ? failEv.code : "无"}`,
      );
    }
    const expectOk = !!failEv && failEv.code === c.expectCode;
    if (!expectOk) {
      failures.push(`${c.label}（${c.input}）→ 失败码漂移：预期 ${c.expectCode}，实测 ${failEv ? failEv.code : "无"}（Chromium 行为变了，用例表需更新）`);
    }
    /* ③ 用例隔离自检：单进程内应当只有 1 个错误页 / 1 个 webview。
       >1 就说明探针又读到了别人的残留态 —— 这是本轮的"通过但锁错对象"，必须红。 */
    const singlePaneOk = !!(last && last.errorPages === 1 && last.wvCount === 1);
    if (!singlePaneOk) {
      failures.push(`${c.label}（${c.input}）→ 用例未隔离：DOM 中错误页 ${last && last.errorPages} 个 / webview ${last && last.wvCount} 个（应为 1/1）`);
    }
    const ok = visibleOk && contractOk && attributionOk && expectOk && singlePaneOk;
    results.push({
      key: c.key, label: c.label, input: c.input, ok, everShown, stable, visibleRatio,
      firstAt: first ? first.tMs : null,
      title: first ? first.title : "",
      code: first ? first.code : "",
      finalUrl: last ? last.wvUrl : "",
      guestSeq: guest.map((g) => (g.type === "did-fail-load" ? `did-fail-load(${g.code})` : g.type)),
      guestFailCode: failEv ? failEv.code : null,
      guestFailDesc: failEv ? failEv.desc : null,
      probeEvents: last ? last.probeEvents : [],
      probeArmed: last ? last.probeArmed : false,
      inputValue: last ? last.inputValue : "",
      contractOk: contractOk,
      hasBareUrlKey: hasBareUrlKey,
      failProbeKeys: failProbe.length ? failProbe[0].keys : null,
      visibleOk: visibleOk,
      attributionOk: attributionOk,
      expectOk: expectOk,
      singlePaneOk: singlePaneOk,
      displayedCode: displayedCode,
      expectCode: c.expectCode,
      errorPages: last ? last.errorPages : null,
    });

    console.log(`\n── ${c.label}  ${c.input}`);
    console.log(`   错误页可见采样占比 : ${(visibleRatio * 100).toFixed(0)}%   ${ok ? "OK" : "FAIL"}`);
    console.log(`   guest 事件序列     : ${guest.map((g) => (g.type === "did-fail-load" ? `did-fail-load(code=${g.code} ${g.desc})` : g.type)).join(" → ") || "（无）"}`);
    console.log(`   探针挂载成功       : ${last && last.probeArmed ? "是" : "否"}`);
    console.log(`   渲染层收到的事件   : ${last && last.probeEvents && last.probeEvents.length ? last.probeEvents.map((e) => e.t + (e.code !== undefined ? "(" + e.code + ")" : "")).join(" → ") : "（无 —— DOM 事件没到渲染层）"}`);
    console.log(`   事件字段契约       : ${contractOk ? "OK（带非空 validatedURL" + (hasBareUrlKey ? "，且存在 url 字段）" : "）") : "不符 ← 错误页不可能显示"}  keys=${JSON.stringify(failProbe.length ? failProbe[0].keys : null)}`);
    console.log(`   归因码闭环         : 显示 ${displayedCode === null ? "（无）" : displayedCode}  vs  guest 实测 ${failEv ? failEv.code : "（无）"}  vs  预期 ${c.expectCode}   ${attributionOk && expectOk ? "OK" : "FAIL"}`);
    console.log(`   用例隔离           : 错误页 ${last ? last.errorPages : "?"} 个 / webview ${last ? last.wvCount : "?"} 个   ${singlePaneOk ? "OK" : "FAIL ← 探针读到残留态，结论不可信"}`);
    console.log(`   地址栏当前值       : ${JSON.stringify(last ? last.inputValue : "")}`);
    console.log(`   webview 元素身份   : ${last ? last.probeId : "?"}  （DOM 中总数 ${last ? last.wvCount : "?"}，累计出现过 ${last ? last.paneMountedAt : "?"} 个）`);
    if (everShown) {
      console.log(`   标题               : ${first.title}`);
      console.log(`   标识               : ${first.code}`);
      console.log(`   稳定停留到观测结束 : ${stable ? "是" : "否"}`);
    } else {
      console.log(`   标题               : （无 —— 用户看到的就是这里的空白）`);
    }

    try {
      const img = await wc.capturePage();
      const png = img.toPNG();
      if (png && png.length > 2048) { fs.writeFileSync(path.join(shotDir, `${c.key}.png`), png); }
    } catch (e) { diag.push(`[capturePage] ${String((e && e.message) || e)}`); }

    await wait(400);
  }

  /* ── 第二轮：**手动输入**路径（先在正常页上挂载好监听，再输入失败地址） ──
     与上一轮"新建页立即导航"是两个不同的时序：若前者丢事件、后者能显示，
     说明病灶是"监听器注册晚于首次导航"，而不是归因表/样式。 */
  console.log("\n\n======== 第二轮：手动输入路径（监听已注册后再输入） ========");
  const typedResults = [];
  if (TYPED.length === 0) { console.log("（本轮隔离模式下跳过）"); }
  if (TYPED.length) {
    /* 手输入需要"已存在地址栏"。隔离模式下若本轮没跑矩阵，就还没有任何浏览器页 ——
       （旧版之所以"能跑"，恰恰是因为它继承了前 5 例留下的残留页，那是假绿的同一个病根）。
       所以先开一个**正常页**热身，再输入失败地址。用极小的静态文件，避免把整个渲染层塞进 webview。 */
    const had = await wc.executeJavaScript('!!document.querySelector("input.browser-url")', true);
    if (!had) {
      await wc.executeJavaScript(OPEN_AND_ARM(`${origin}/probe-stub.js`), true);
      await wait(2500);
      const now = await wc.executeJavaScript('!!document.querySelector("input.browser-url")', true);
      console.log(`（热身：先开一个正常页以产生地址栏 → ${now ? "OK" : "失败"}）`);
    }
  }
  for (const c of TYPED) {
    const evStart = guestEvents.length;
    const r = await wc.executeJavaScript(TYPE_AND_ENTER(c.input), true);
    await wc.executeJavaScript(ARM_WV_LISTENER, true);
    const timeline = [];
    const t0 = Date.now();
    while (Date.now() - t0 < OBSERVE_MS) {
      await wc.executeJavaScript(ARM_WV_LISTENER, true);
      let s;
      try { s = JSON.parse(await wc.executeJavaScript(SAMPLE, true)); }
      catch (e) { s = { error: String((e && e.message) || e) }; }
      s.tMs = Date.now() - t0;
      timeline.push(s);
      await wait(POLL_MS);
    }
    const withPage = timeline.filter((s) => s.pagePresent);
    const everShown = withPage.length > 0;
    const visibleRatio = withPage.length / timeline.length;
    const guest = guestEvents.slice(evStart);
    const failEv = guest.find((g) => g.type === "did-fail-load");
    /* 手输入路径同样要过"归因码闭环"（第一版漏了这条，于是 -312 的残留文案被判成通过） */
    const mCode = /(-?\d+)\s*$/.exec(withPage.length ? withPage[0].code : "");
    const displayedCode = mCode ? Number(mCode[1]) : null;
    const codeOk = !!failEv && displayedCode === failEv.code;
    const typedOk = everShown && codeOk;
    if (!everShown) { failures.push(`${c.label}（手输入 ${c.input}）→ 错误页从未出现`); }
    else if (!codeOk) {
      failures.push(`${c.label}（手输入 ${c.input}）→ 归因码不符：界面显示 ${displayedCode === null ? "（无）" : displayedCode}，guest 实测 ${failEv ? failEv.code : "无"}`);
    }
    typedResults.push({ key: c.key, label: c.label, input: c.input, dispatch: r, everShown, visibleRatio, ok: typedOk,
      guestSeq: guest.map((g) => (g.type === "did-fail-load" ? `did-fail-load(${g.code})` : g.type)),
      guestFailCode: failEv ? failEv.code : null,
      displayedCode: displayedCode, expectCode: c.expectCode, codeOk: codeOk,
      title: everShown ? withPage[0].title : "", code: everShown ? withPage[0].code : "" });
    console.log(`\n── ${c.label}  ${c.input}   (dispatch=${r})`);
    console.log(`   错误页可见采样占比 : ${(visibleRatio * 100).toFixed(0)}%   ${typedOk ? "OK" : "FAIL"}`);
    console.log(`   guest 事件序列     : ${guest.map((g) => (g.type === "did-fail-load" ? `did-fail-load(code=${g.code} ${g.desc})` : g.type)).join(" → ") || "（无）"}`);
    console.log(`   归因码闭环         : 显示 ${displayedCode === null ? "（无）" : displayedCode}  vs  guest 实测 ${failEv ? failEv.code : "（无）"}  vs  预期 ${c.expectCode}   ${codeOk ? "OK" : "FAIL"}`);
    console.log(`   标题               : ${everShown ? withPage[0].title : "（无）"}`);
    try {
      const img = await wc.capturePage();
      const png = img.toPNG();
      if (png && png.length > 2048) { fs.writeFileSync(path.join(shotDir, `${c.key}.png`), png); }
    } catch { /* 忽略 */ }
    await wait(400);
  }

  const reportPath = path.join(shotDir, ONLY ? `report-${ONLY}.json` : "report.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(), origin, isolatedPerCase: !!ONLY, results, typedResults,
    guestEventCount: guestEvents.length, diag: diag.slice(0, 60),
  }, null, 2), "utf8");

  console.log("\n================ 汇总 ================");
  results.forEach((r) => {
    console.log(`  ${r.ok ? "OK  " : "FAIL"}  [新建页] ${r.label.padEnd(20, " ")} 可见率 ${(r.visibleRatio * 100).toFixed(0)}%  显示码 ${r.displayedCode ?? "无"} / guest ${r.guestFailCode ?? "无"} / 预期 ${r.expectCode}`);
  });
  typedResults.forEach((r) => {
    console.log(`  ${r.ok ? "OK  " : "FAIL"}  [手输入] ${r.label.padEnd(20, " ")} 可见率 ${(r.visibleRatio * 100).toFixed(0)}%  显示码 ${r.displayedCode ?? "无"} / guest ${r.guestFailCode ?? "无"}  ${r.everShown ? "显示了：" + r.title : "未显示"}`);
  });
  console.log(`\n报告: ${reportPath}`);
  console.log(failures.length === 0 ? "\nRESULT=PASS" : `\nRESULT=FAIL\n未通过:\n${failures.map((f) => "  - " + f).join("\n")}`);
  app.exit(failures.length === 0 ? 0 : 1);
}).catch((e) => {
  console.error("探针崩溃:", e);
  app.exit(2);
});
