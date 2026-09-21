/*
 * ask_user「决策分叉窗口」链路的**运行时取证**（A-1042）。
 *
 * 用户症状：「我好久没看见 slime 内返回选项询问用户建议了」（怀疑链路断了）。
 *
 * 源码级排查结论：链路的**每一环都在**（工具注册 → tool_loop 拦截 → engine 钩子 →
 * main 的 onAskUser → preload 订阅 → ChatPanel 渲染），所以静态断言全绿也说明不了问题 ——
 * 必须真跑，因为最可疑的一环恰恰是 **渲染层那句静默 return**：
 *
 *   const reqSid = req.sessionId !== undefined ? req.sessionId : streamSessionRef.current;
 *   if (reqSid !== sessionRef.current) { return; }        // ← 丢弃，不留痕、不报错
 *
 * 本探针用**真实 out/renderer 产物** + 可编程的 `slimeAPI` 桩，把这条判定当锁对象：
 *   · 一条提问带「正确的会话标签」→ 界面必须显示（否则就是链路真断了）
 *   · 一条提问带「别的会话标签」  → 界面必须不显示，且**必须留痕**（丢弃不能是静默的）
 *   · 不带会话标签（回退流归属）  → 与上面两条的判据必须自洽
 *   · 显示后点选项 + 确认         → `askUser.resolve` 必须收到正确的 AskUserDecision
 *
 * 跑法（在 gui/ 下）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe scripts/assert-ask-chain.cjs
 *   ↑ 不带 SLIME_PROBE_CASE = 总控模式：**每个用例各起一个 Electron 进程**（见下）
 *   单跑某一例（调试）：
 *   SLIME_PROBE_CASE=match ./node_modules/electron/dist/electron.exe scripts/assert-ask-chain.cjs
 *   可用用例 key：match / mismatch / noguard-nosid / send-nosid / resolve
 *
 * ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：它会让 electron.exe 退化成纯 node，
 * `require("electron")` 只拿到可执行文件路径字符串 → `app` 为 undefined。
 * ⚠️ 模板字符串里的注释**不得出现反引号**（本文件大量用拼接，就是为此）。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const GUI = path.resolve(__dirname, "..");
const rendererDir = path.join(GUI, "out", "renderer");
const outDir = path.join(GUI, "out", "ask-probe");
const OBSERVE_MS = 2500;
const POLL_MS = 250;

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

/**
 * 可编程的 slimeAPI 桩（注入在渲染层主世界，在 React 挂载前就位）。
 *
 * ⚠️ 首屏门（`FIRST_LOAD_KEYS = agents/sessions/providers/localModels`）必须真的被满足：
 * App 要等 `conversations.list()` 有内容才会选中一个会话，**没有会话就不会渲染 ChatPanel**
 * （连输入框都没有）。所以这里给一份最小的真实数据 —— 否则探针测的是"空态页"，
 * 会得出"提问窗口从不出现"的错误结论（第一版就是这么假红的）。
 *
 * ⚠️ 兜底桩必须是「**可调用 + 可 await 的通用对象**」，不能是纯 Promise：
 * 渲染层两种用法并存 —— `const off = api.x.onY(cb); off()`（要可调用）与
 * `const rows = await api.x.list()`（要 thenable）。纯 Promise 会让前者抛
 * `off is not a function` 并被 ErrorBoundary 吃掉整块面板（实测 TasksTab / RightSidebar 都这么崩过，
 * 而崩掉的面板里就可能包含我们要观察的输入框）。
 */
const STUB_JS = [
  "(function () {",
  "  function uni(tag) {",
  "    var f = function () { return uni(tag + '()'); };",
  "    return new Proxy(f, {",
  "      get: function (t, prop) {",
  "        if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') { return function () { return ''; }; }",
  "        if (prop === Symbol.iterator) { return function () { return [][Symbol.iterator](); }; }",
  "        if (typeof prop === 'symbol') { return undefined; }",
  "        /* thenable：await 得到空数组（与真实空列表语义一致）。",
  "           ⚠️ 必须**返回 uni 而不是 `res([])` 的返回值** —— Promise 的 resolve() 返回 undefined，",
  "           而渲染层大量写 `.then(cb).catch(...)`，返回 undefined 会让链式 `.catch` 直接抛",
  "           「Cannot read properties of undefined」并把整棵 App 交给 ErrorBoundary（实测踩过）。 */",
  "        if (prop === 'then') { return function (res) { if (typeof res === 'function') { try { res([]); } catch (e) {} } return uni(tag + '.then'); }; }",
  "        if (prop === 'catch') { return function () { return uni(tag + '.catch'); }; }",
  "        if (prop === 'finally') { return function (cb) { if (typeof cb === 'function') { cb(); } return uni(tag + '.finally'); }; }",
  "        /* toJSON 必须显式 undefined：否则 JSON.stringify 会对代理无限递归 */",
  "        if (prop === 'toJSON') { return undefined; }",
  "        if (prop === 'length' || prop === 'size') { return 0; }",
  "        return uni(tag + '.' + String(prop));",
  "      },",
  "      apply: function () { return uni(tag + '()'); },",
  "      construct: function () { return {}; },",
  "    });",
  "  }",
  "  function wrap(obj) {",
  "    return new Proxy(obj, {",
  "      get: function (t, prop) {",
  "        if (prop in t) { return t[prop]; }",
  "        if (typeof prop === 'symbol') { return undefined; }",
  "        var name = String(prop);",
  "        /* 订阅类（onXxx）返回**可注销函数**：渲染层普遍写 `const off = api.x.onY(...)`",
  "           然后 cleanup 里 `off()`。语义与真实 preload 一致：注册回调 + 返回注销函数。 */",
  "        if (/^on[A-Z]/.test(name)) {",
  "          return function (cb) {",
  "            try {",
  "              probe.subs[name] = probe.subs[name] || [];",
  "              if (typeof cb === 'function') { probe.subs[name].push(cb); }",
  "            } catch (e) {}",
  "            return function () {};",
  "          };",
  "        }",
  "        return uni('slimeAPI.' + name);",
  "      },",
  "    });",
  "  }",
  "  var PROBE_SESSION = 'sess-probe-0001';",
  "  var probe = {",
  "    sessionId: PROBE_SESSION,",
  "    chatInputs: [],        /* 渲染层真正发出去的 ChatInput（用来取「本会话标签」真值） */",
  "    askHandlers: [],       /* 渲染层注册的 onRequest 回调 */",
  "    timeoutHandlers: [],",
  "    resolves: [],          /* 渲染层提交的 AskUserDecision */",
  "    fired: [],             /* 探针发出去的请求（含 sessionId 真值） */",
  "    dropped: [],           /* 渲染层显式留痕的丢弃（修好之前恒为空） */",
  "    subs: {},              /* 所有 onXxx 订阅（名 → 回调数组），探针可据此驱动任意事件 */",
  "    errors: [],            /* 渲染层未捕获异常（探针前提不成立时用来定位） */",
  "    panelMounted: false,",
  "  };",
  "  window.__askProbe = probe;",
  "  function off() { return function () {}; }",
  "  var chat = wrap({",
  "    stream: function (input) {",
  "      try { probe.chatInputs.push({ sessionId: input && input.sessionId, agentId: input && input.agentId, message: input && input.message }); } catch (e) {}",
  "      return Promise.resolve({ ok: true });",
  "    },",
  "    cancel: function () { return Promise.resolve({ ok: true }); },",
  "    onChunk: off, onDone: off, onError: off,",
  "  });",
  "  var askUser = wrap({",
  "    onRequest: function (cb) { probe.askHandlers.push(cb); return function () {}; },",
  "    onTimeout: function (cb) { probe.timeoutHandlers.push(cb); return function () {}; },",
  "    resolve: function (d) { probe.resolves.push(d); return Promise.resolve({ ok: true }); },",
  "  });",
  "  var conversations = wrap({",
  "    list: function () { return Promise.resolve([{ sessionId: PROBE_SESSION, title: '探针会话', count: 0, lastTime: '12:00', agentId: 'agent-x', agentName: '探索者', type: 'chat', workspace: '' }]); },",
  "    load: function () { return Promise.resolve([]); },",
  "    configGet: function () { return Promise.resolve({ workspace: '', approval: 'auto' }); },",
  "    onChanged: off,",
  "  });",
  "  var agents = wrap({",
  "    list: function () { return Promise.resolve([{ id: 'agent-x', name: '探索者', role: '通用助手' }]); },",
  "    detail: function () { return Promise.resolve({ model_choice: '', mode: 'chat', reasoning_effort: 'high', show_thinking: '1' }); },",
  "    onAgentSelected: off,",
  "  });",
  "  var providers = wrap({",
  "    list: function () { return Promise.resolve([]); },",
  "    localList: function () { return Promise.resolve([]); },",
  "  });",
  "  var perm = wrap({ onRequest: function () { return function () {}; }, onTimeout: function () { return function () {}; }, resolve: function () { return Promise.resolve({ ok: true }); } });",
  "  window.slimeAPI = wrap({",
  "    chat: chat, askUser: askUser, conversations: conversations, agents: agents,",
  "    providers: providers, perm: perm,",
  "  });",
  "  try {",
  "    /* 渲染层把「丢弃」留痕后，探针就能断言「不是静默的」 */",
  "    var origWarn = console.warn;",
  "    console.warn = function () {",
  "      var s = Array.prototype.map.call(arguments, function (a) { return String(a); }).join(' ');",
  "      if (s.indexOf('ask') >= 0 || s.indexOf('提问') >= 0 || s.indexOf('Ask') >= 0) { probe.dropped.push(s.slice(0, 200)); }",
  "      return origWarn.apply(console, arguments);",
  "    };",
  "    /* 面板挂载后置位：探针据此区分「提问没显示」和「面板压根没渲染」 */",
  "    window.addEventListener('error', function (e) {",
  "      try { probe.errors.push(String((e && e.message) || e).slice(0, 300) + ' @ ' + String((e && e.filename) || '') + ':' + String((e && e.lineno) || '')); } catch (x) {}",
  "    });",
  "    window.addEventListener('unhandledrejection', function (e) {",
  "      try { probe.errors.push('unhandledrejection: ' + String((e && e.reason && (e.reason.stack || e.reason.message)) || e).slice(0, 300)); } catch (x) {}",
  "    });",
  "    var timer = setInterval(function () {",
  "      try {",
  "        if (document.querySelector('.glass-input')) { probe.panelMounted = true; clearInterval(timer); }",
  "      } catch (e) {}",
  "    }, 100);",
  "  } catch (e) {}",
  "})();",
].join("\n");

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

/** 在输入框里打字并回车（走渲染层真实的 send() 路径，不绕过产品代码） */
const SEND_MESSAGE = [
  "(() => {",
  "  var ta = document.querySelector('textarea');",
  "  if (!ta) { return 'no-textarea'; }",
  "  var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;",
  "  setter.call(ta, '探针消息');",
  "  ta.dispatchEvent(new Event('input', { bubbles: true }));",
  "  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));",
  "  return 'sent';",
  "})()",
].join("\n");

/** 构造并投递一条 ask_user 请求。sid 为 null 表示**省略 sessionId 字段**（回退流归属分支） */
function FIRE_ASK(sid) {
  const sidLine = sid === null ? "" : "sessionId: " + JSON.stringify(sid) + ",";
  return [
    "(() => {",
    "  var probe = window.__askProbe;",
    "  if (!probe || probe.askHandlers.length === 0) { return JSON.stringify({ err: 'no-ask-handler' }); }",
    "  var req = {",
    "    requestId: 'probe-' + Math.random().toString(36).slice(2, 8),",
    "    agentId: 'agent-x',",
    "    agentName: '探索者',",
    "    question: '这条路线要往哪走？',",
    "    header: '架构取舍',",
    "    options: ['方案A 先修链路', '方案B 先瘦身'],",
    "    consequences: ['先修链路影响面小', '先瘦身收益立竿见影'],",
    "    recommendation: 1,",
    "    " + sidLine,
    "  };",
    "  if (!('sessionId' in req)) { delete req.sessionId; }",
    "  probe.fired.push({ requestId: req.requestId, hasSid: 'sessionId' in req, sid: req.sessionId });",
    "  probe.askHandlers.forEach(function (cb) { try { cb(req); } catch (e) {} });",
    "  return JSON.stringify({ fired: req.requestId, hasSid: 'sessionId' in req });",
    "})()",
  ].join("\n");
}

/** 采样：提问 UI 到底出现了没，出现了长什么样 */
const SAMPLE = [
  "(() => {",
  "  var probe = window.__askProbe || {};",
  "  var box = document.querySelector('.glass-input');",
  "  var txt = box ? (box.textContent || '') : '';",
  "  var btns = box ? Array.prototype.slice.call(box.querySelectorAll('button')).map(function (b) { return (b.textContent || '').trim(); }) : [];",
  "  var ta = document.querySelector('textarea');",
  "  return JSON.stringify({",
  "    hasBox: !!box,",
  "    hasAskHeader: txt.indexOf('Agent 提问') >= 0,",
  "    hasChoiceHint: txt.indexOf('需要你做出抉择') >= 0,",
  "    hasHeaderBadge: txt.indexOf('架构取舍') >= 0,",
  "    hasQuestion: txt.indexOf('这条路线要往哪走') >= 0,",
  "    hasConsequence: txt.indexOf('先瘦身收益立竿见影') >= 0,",
  "    hasRecommend: txt.indexOf('推荐') >= 0,",
  "    buttons: btns.slice(0, 10),",
  "    chatInputs: (probe.chatInputs || []).map(function (c) { return c.sessionId; }),",
  "    panelMounted: !!probe.panelMounted,",
  "    probeSession: probe.sessionId || null,",
  "    errors: (probe.errors || []).slice(-6),",
  "    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),",
  "    hasSplash: !!document.querySelector('.splash'),",
  "    firedCount: (probe.fired || []).length,",
  "    resolves: probe.resolves || [],",
  "    droppedTraces: probe.dropped || [],",
  "  });",
  "})()",
].join("\n");

/** 选中「方案B 先瘦身」 */
const CLICK_OPTION = [
  "(() => {",
  "  var box = document.querySelector('.glass-input');",
  "  if (!box) { return 'no-box'; }",
  "  var btns = Array.prototype.slice.call(box.querySelectorAll('button'));",
  "  var opt = btns.filter(function (b) { return (b.textContent || '').indexOf('方案B') >= 0; })[0];",
  "  if (!opt) { return 'no-option'; }",
  "  opt.click();",
  "  return 'clicked';",
  "})()",
].join("\n");

/** 点「确认」 */
const CLICK_CONFIRM = [
  "(() => {",
  "  var box = document.querySelector('.glass-input');",
  "  if (!box) { return 'no-box'; }",
  "  var btns = Array.prototype.slice.call(box.querySelectorAll('button'));",
  "  var btn = btns.filter(function (b) { return (b.textContent || '').trim() === '确认'; })[0];",
  "  if (!btn) { return 'no-confirm'; }",
  "  if (btn.disabled) { return 'confirm-disabled'; }",
  "  btn.click();",
  "  return 'confirmed';",
  "})()",
].join("\n");

const ALL_CASES = ["match", "mismatch", "noguard-nosid", "send-nosid", "resolve"];

const ONLY = process.env.SLIME_PROBE_CASE || "";
if (ONLY && ALL_CASES.indexOf(ONLY) < 0) {
  console.error("未知用例 SLIME_PROBE_CASE=" + ONLY + "；可选：" + ALL_CASES.join(", "));
  process.exit(2);
}

/**
 * 总控：**一个用例一个 Electron 进程**。
 * 理由同浏览器失败页探针（A-1021）：渲染层有跨用例的常驻状态（pendingAsk / 会话绑定），
 * 同进程连跑必然互相污染，且"读到了上一个用例的残留"会表现为假绿。
 */
function runOrchestrator() {
  console.log("========== ask_user 链路探针：用例进程隔离（总控） ==========");
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const rows = [];
  for (const key of ALL_CASES) {
    env.SLIME_PROBE_CASE = key;
    const r = spawnSync(process.execPath, [__filename], { env: env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const out = String(r.stdout || "") + String(r.stderr || "");
    const pass = /RESULT=PASS/.test(out);
    const summary = /SUMMARY\s*:\s*(.*)/.exec(out);
    rows.push({ key, pass, exit: r.status, summary: summary ? summary[1].trim() : "", tail: out.split("\n").filter(Boolean).slice(-6).join("\n") });
    console.log((pass ? "OK  " : "FAIL") + "  " + key.padEnd(16, " ") + " exit=" + r.status + "   " + (summary ? summary[1].trim() : ""));
  }
  const merged = { generatedAt: new Date().toISOString(), isolatedPerCase: true, cases: [] };
  for (const row of rows) {
    try { merged.cases.push(JSON.parse(fs.readFileSync(path.join(outDir, "report-" + row.key + ".json"), "utf8"))); } catch { /* 缺失跳过 */ }
  }
  try { fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(merged, null, 2), "utf8"); } catch { /* 忽略 */ }
  const bad = rows.filter((x) => !x.pass);
  console.log("\n================ 总控汇总 ================");
  rows.forEach((x) => console.log("  " + (x.pass ? "OK  " : "FAIL") + "  " + x.key.padEnd(16, " ") + " " + x.summary));
  if (bad.length) {
    console.log("\n未通过详情：");
    bad.forEach((x) => console.log("  ── " + x.key + "\n" + x.tail.split("\n").map((l) => "     " + l).join("\n")));
  }
  console.log("\n报告: " + path.join(outDir, "report.json"));
  console.log(bad.length === 0 ? "\nRESULT=PASS" : "\nRESULT=FAIL (" + bad.length + "/" + rows.length + " 用例未过)");
  app.exit(bad.length === 0 ? 0 : 1);
}

app.whenReady().then(async () => {
  if (!ONLY) { runOrchestrator(); return; }
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startStaticServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const consoleLines = [];

  const win = new BrowserWindow({
    width: 1180, height: 860, show: false, frame: false,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      backgroundThrottling: false, webviewTag: true,
    },
  });
  const wc = win.webContents;
  wc.on("console-message", (e) => {
    const msg = e && e.message !== undefined ? e.message : "";
    if (String(msg).indexOf("frame-ancestors") >= 0) { return; }
    consoleLines.push(String(msg).slice(0, 200));
  });

  await wc.loadURL(origin + "/index.html");
  await wait(1500);
  /* 首屏门（A-1039）最短 700ms + 数据装载；等面板真的挂上再开始，否则测的是空态页 */
  {
    const t0 = Date.now();
    let mounted = false;
    while (Date.now() - t0 < 8000) {
      const s = await sample();
      if (s.hasBox) { mounted = true; break; }
      await wait(250);
    }
    if (!mounted) {
      /* 再等一轮，尽量把 console 里的原因抓全（门 8s 兜底后仍无输入框 = 前提真不成立） */
      await wait(2500);
    }
  }

  const failures = [];
  const diag = [];
  const notes = [];
  async function sample() {
    try { return JSON.parse(await wc.executeJavaScript(SAMPLE, true)); }
    catch (e) { return { error: String((e && e.message) || e) }; }
  }

  const boot = await sample();
  if (!boot.hasBox) {
    failures.push("渲染层未挂载输入框（.glass-input 不存在）—— 探针前提不成立，先看 console 行");
  }
  diag.push("面板挂载: " + (boot.panelMounted ? "是" : "否") + " · 探针会话: " + JSON.stringify(boot.probeSession) + " · 渲染层发出的 sessionId: " + JSON.stringify(boot.chatInputs));
  diag.push("画面文本: " + JSON.stringify(boot.bodyText || ""));

  let summary = "";

  if (ONLY === "match" || ONLY === "send-nosid" || ONLY === "resolve") {
    /* 走真实 send() 路径，拿到渲染层自己声明的会话标签 */
    const sent = await wc.executeJavaScript(SEND_MESSAGE, true);
    await wait(1200);
    const afterSend = await sample();
    diag.push("发送动作: " + sent + " · 渲染层发出的 sessionId: " + JSON.stringify(afterSend.chatInputs));
    const realSid = afterSend.chatInputs.length > 0 ? afterSend.chatInputs[afterSend.chatInputs.length - 1] : undefined;
    if (afterSend.chatInputs.length === 0) {
      failures.push("渲染层没有发出 chat.stream —— 取不到「本会话标签」真值（send() 前置条件未满足）");
    }
    if (ONLY === "match" || ONLY === "resolve") {
      if (typeof realSid !== "string" || realSid === "") {
        failures.push("本会话标签为空/缺失（拿到 " + JSON.stringify(realSid) + "），无法验证匹配分支");
      }
      const fired = await wc.executeJavaScript(FIRE_ASK(realSid), true);
      diag.push("投递提问: " + fired);
    } else {
      const fired = await wc.executeJavaScript(FIRE_ASK(null), true);
      diag.push("投递提问（故意省略 sessionId）: " + fired);
    }
  } else if (ONLY === "mismatch") {
    const fired = await wc.executeJavaScript(FIRE_ASK("__other_session__"), true);
    diag.push("投递提问（异会话标签）: " + fired);
  } else if (ONLY === "noguard-nosid") {
    const fired = await wc.executeJavaScript(FIRE_ASK(null), true);
    diag.push("投递提问（无会话标签 + 无活跃流）: " + fired);
  }

  await wait(400);
  let shown = null;
  const timeline = [];
  {
    const t0 = Date.now();
    while (Date.now() - t0 < OBSERVE_MS) {
      const s = await sample();
      s.tMs = Date.now() - t0;
      timeline.push(s);
      if (s.hasAskHeader && shown === null) { shown = s; }
      await wait(POLL_MS);
    }
  }
  const last = timeline[timeline.length - 1] || {};
  const askVisible = !!shown;
  const askStable = askVisible && timeline.slice(timeline.indexOf(shown)).every((s) => s.hasAskHeader);

  if (ONLY === "resolve") {
    // ⚠️ 摘要必须取**点完确认之后**那次采样（after），不能取 before 的 `last`：
    //    回传完成后界面已收起提问，`last.resolves` 是空的 → 摘要恒显示"回传 null"，
    //    而 diag 里明明写着 answer 已回传。这种"证据与结论相反"的摘要会误导下一次排查。
    let resolveSample = null;
    if (!askVisible) {
      failures.push("提问窗口未出现，无法验证回答回传");
    } else {
      const c1 = await wc.executeJavaScript(CLICK_OPTION, true);
      await wait(300);
      const c2 = await wc.executeJavaScript(CLICK_CONFIRM, true);
      await wait(500);
      const after = await sample();
      const r = (after.resolves || [])[0];
      resolveSample = r || null;
      diag.push("选点: " + c1 + " / 确认: " + c2 + " / resolves=" + JSON.stringify(after.resolves));
      if (c1 !== "clicked") { failures.push("选不中「方案B」选项（返回 " + c1 + "）"); }
      if (c2 !== "confirmed") { failures.push("「确认」按钮不可用（返回 " + c2 + "）"); }
      if (!r) { failures.push("askUser.resolve 没有被调用 —— 回答链路断在渲染层"); }
      else {
        if (r.answer !== "方案B 先瘦身") { failures.push("回传答案不符：期望「方案B 先瘦身」，实得 " + JSON.stringify(r.answer)); }
        if (r.skipped !== false) { failures.push("skipped 应为 false，实得 " + JSON.stringify(r.skipped)); }
        if (typeof r.requestId !== "string" || r.requestId.indexOf("probe-") !== 0) { failures.push("回传的 requestId 不是本次请求：" + JSON.stringify(r.requestId)); }
      }
      if (after.hasAskHeader) { failures.push("回答后提问窗口没有收起"); }
    }
    summary = askVisible
      ? ("提问可见 · 回传 " + (resolveSample ? JSON.stringify(resolveSample.answer) : "null（resolve 未被调用）"))
      : "提问不可见";
  } else if (ONLY === "match" || ONLY === "send-nosid") {
    if (!askVisible) { failures.push("提问窗口从未出现 —— 匹配/回退分支被静默丢弃"); }
    if (!askStable) { failures.push("提问窗口出现但不稳定（被后续渲染清掉）"); }
    if (askVisible && !shown.hasQuestion) { failures.push("提问正文没渲染出来"); }
    if (askVisible && !shown.hasChoiceHint) { failures.push("缺少「需要你做出抉择」提示"); }
    if (askVisible && !shown.hasConsequence) { failures.push("缺少选项后果注释"); }
    if (askVisible && !shown.hasRecommend) { failures.push("缺少「⭐ 推荐」标注"); }
    // ⚠️ 不能只按「方案」筛：界面上还有一个「⭐ 按推荐执行「方案B 先瘦身」」的快捷按钮，
    //    它同样含"方案" → 数出来是 3 个（实测）。真正的**选项**按钮以选中标记 ◉/○ 开头，
    //    快捷按钮以 ⭐ 开头，两者必须分开数，否则这条断言永远红，会把真问题淹没在假红里。
    if (askVisible) {
      const opts = (shown.buttons || []).filter((b) => /^[◉○]\s*方案/.test(b));
      if (opts.length !== 2) {
        failures.push("选项按钮数量不符（应为 2 个 ◉/○ 选项）：" + JSON.stringify(shown.buttons));
      }
      const shortcut = (shown.buttons || []).filter((b) => b.indexOf("按推荐执行") >= 0);
      if (shortcut.length !== 1) {
        failures.push("「按推荐执行」快捷按钮缺失或重复：" + JSON.stringify(shown.buttons));
      }
    }
    summary = askVisible ? "提问可见" : "提问不可见";
  } else {
    /* mismatch / noguard-nosid：**设计上就该丢弃**，但丢弃必须留痕 */
    if (askVisible) {
      failures.push("本应被过滤的提问却显示了（会话标签过滤失效，输入框会被别的会话的提问卡住）");
    }
    const traces = last.droppedTraces || [];
    if (traces.length === 0) {
      failures.push("丢弃是**静默**的（console 无任何留痕）—— 这正是「好久没看见提问」时无从排查的原因");
    }
    summary = askVisible ? "提问可见（不应如此）" : ("提问被过滤 · 留痕 " + traces.length + " 条");
  }

  const report = {
    case: ONLY, askVisible, askStable, summary, diag, failures,
    timelineLast: last, consoleTail: consoleLines.slice(-12),
  };
  fs.writeFileSync(path.join(outDir, "report-" + ONLY + ".json"), JSON.stringify(report, null, 2), "utf8");

  console.log("================ ask_user 链路探针：" + ONLY + " ================");
  console.log("渲染层: " + origin);
  diag.forEach((d) => console.log("  · " + d));
  console.log("  提问可见           : " + (askVisible ? "是" : "否"));
  console.log("  抽样末态           : " + JSON.stringify({ header: last.hasAskHeader, hint: last.hasChoiceHint, q: last.hasQuestion, cons: last.hasConsequence, rec: last.hasRecommend, btns: last.buttons }));
  console.log("  丢弃留痕           : " + JSON.stringify(last.droppedTraces || []));
  if (last.errors && last.errors.length) {
    console.log("  渲染层异常         :");
    last.errors.forEach((e) => console.log("    · " + e));
  }
  if (boot.errors && boot.errors.length) {
    console.log("  启动阶段异常       :");
    boot.errors.forEach((e) => console.log("    · " + e));
  }
  if (consoleLines.length) { console.log("  console 末行       : " + consoleLines.slice(-4).join(" | ")); }
  console.log("SUMMARY: " + summary);
  failures.forEach((f) => console.log("  失败: " + f));
  console.log(failures.length === 0 ? "\nRESULT=PASS" : "\nRESULT=FAIL\n" + failures.map((f) => "  - " + f).join("\n"));
  try { server.close(); } catch { /* 忽略 */ }
  app.exit(failures.length === 0 ? 0 : 1);
});
