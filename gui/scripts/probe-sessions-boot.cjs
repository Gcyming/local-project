#!/usr/bin/env node
/**
 * gui/scripts/probe-sessions-boot.cjs — 测量「启动后左侧会话列表何时真正出现」。
 *
 * 用户实测（v0.0.4 打包版）：每次重启后左侧会话列表先是空白、像刚装的一样，
 * 要等「相当一段时间」才出来。数据量已排除（4 个会话 / 104 条历史 / 12.9MB），
 * 所以嫌疑落在**服务首次初始化**上（首次 `slime:sessions:list` 要等 ensureServices()）。
 *
 * 本探针用真实 Electron 应用 + CDP，**外部观察**：
 *   - 从渲染层进入到一个非空会话列表，实际花了多久（毫秒）
 *    - 直接给 `conversations.list()` 计时（区分"IPC 慢"还是"渲染慢"）
 *    - 记录空白期长度：页面可用 → 首个会话条目出现
 *
 * 跑法：node gui/scripts/probe-sessions-boot.cjs
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const GUI = path.resolve(__dirname, "..");
const ELECTRON = path.join(GUI, "node_modules", "electron", "dist", "electron.exe");
const PORT = Number(process.env.PROBE_PORT ?? 9333);
const WATCH_MS = Number(process.env.PROBE_WATCH_MS ?? 60000);

/**
 * 默认跑 `out/`（开发模式，数据根 = 项目根）。
 * 传 `PROBE_EXE` 可指向**打包产物**（安装版数据根 = %APPDATA%/<name>/slime-data），
 * 那才是用户真实使用的形态 —— 两者数据根不同，必须分别测。
 */
const exe = process.env.PROBE_EXE || ELECTRON;
const exeArgs = process.env.PROBE_EXE
  ? [`--remote-debugging-port=${PORT}`]
  : [".", `--remote-debugging-port=${PORT}`];
const cwd = process.env.PROBE_CWD || GUI;
console.log(`[probe] 目标: ${exe}`);

const child = spawn(exe, exeArgs, {
  cwd,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});

const mainLog = [];
child.stdout.on("data", (d) => mainLog.push(d.toString()));
child.stderr.on("data", (d) => mainLog.push(d.toString()));
child.on("exit", (c) => console.log(`[probe] electron 退出 code=${c}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach() {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !/devtools/.test(t.url));
      if (page) { return { page, elapsed: Date.now() - t0 }; }
    } catch { /* 还没起来 */ }
    await sleep(120);
  }
  throw new Error("CDP 目标未出现");
}

(async () => {
  const tSpawn = Date.now();
  const { page, elapsed } = await attach();
  console.log(`[probe] CDP 目标就绪，用时 ${elapsed} ms`);
  console.log(`[probe] url=${page.url}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  await new Promise((r) => { ws.onopen = r; });

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error("eval: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)); }
    return r.result.value;
  };

  // 探针表达式：空白判定 = 侧栏里出现"暂无会话"文案（App.tsx 的 groups.length===0 空态）
  const PROBE = `(() => {
    const aside = document.querySelector('aside');
    const txt = aside ? (aside.innerText || '') : '';
    return {
      ts: Math.round(performance.now()),
      hasApi: !!window.slimeAPI,
      aside: !!aside,
      empty: aside ? txt.includes('暂无会话') : null,
    };
  })()`;

  console.log("[probe] 开始观察侧栏状态（每 150ms 一次）...");
  const timeline = [];
  const tObserve = Date.now();
  let firstEmptySeen = null;   // 首次看到"暂无会话"
  let firstFilled = null;      // 空态之后首次填上内容

  while (Date.now() - tObserve < WATCH_MS) {
    let snap;
    try { snap = await evaluate(PROBE); } catch (e) { snap = { err: String(e.message).slice(0, 80) }; }
    const t = Date.now() - tObserve;
    timeline.push({ t, ...snap });
    if (snap && snap.empty === true && firstEmptySeen === null) { firstEmptySeen = t; }
    // 判据：**先**出现过空态，**再**变成非空 —— 才算"空白期结束"
    if (firstEmptySeen !== null && snap && snap.empty === false && snap.aside) {
      firstFilled = t;
      break;
    }
    await sleep(150);
  }

  // 直接给 IPC 计时（渲染层视角）
  let listTiming = null;
  try {
    listTiming = await evaluate(`(async () => {
      const t = performance.now();
      const items = await window.slimeAPI.conversations.list();
      return { ms: Math.round(performance.now() - t), count: Array.isArray(items) ? items.length : -1 };
    })()`);
  } catch (e) { listTiming = { err: String(e.message).slice(0, 120) }; }

  console.log("");
  console.log("=== 时间线（前 12 个采样）===");
  for (const s of timeline.slice(0, 12)) { console.log(JSON.stringify(s)); }
  console.log("");
  console.log(`空态首次出现: ${firstEmptySeen === null ? "未观测到" : firstEmptySeen + " ms"}`);
  console.log(`侧栏填充完成: ${firstFilled === null ? "未在观察窗内填充" : firstFilled + " ms"}`);
  if (firstEmptySeen !== null && firstFilled !== null) {
    console.log(`>>> 空白期长度: ${firstFilled - firstEmptySeen} ms`);
  }
  console.log(`conversations.list() 计时: ${JSON.stringify(listTiming)}`);

  // 关键证据：ensureServices 是否被并发重入（同一次启动里重复打印初始化日志）
  const log = mainLog.join("");
  const count = (re) => (log.match(re) ?? []).length;
  const initEvidence = {
    "silam 启动行": count(/\[gui:silam\][^\n]*/g),
    "skills 就绪行": count(/\[gui:skills\][^\n]*/g),
    "boot 行": count(/\[gui:boot\][^\n]*/g),
  };
  console.log("");
  console.log("=== 初始化日志重复度（>1 即并发重入）===");
  for (const [k, v] of Object.entries(initEvidence)) { console.log(`  ${k}: ${v}`); }

  const out = path.join(GUI, "out", "_probe-sessions-boot.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    target: exe,
    cdprReady: elapsed, firstEmptySeen, firstFilled,
    blankWindowMs: (firstEmptySeen !== null && firstFilled !== null) ? firstFilled - firstEmptySeen : null,
    listTiming, initEvidence,
    timeline,
    mainTail: log.split("\n").filter(Boolean).slice(-30),
  }, null, 2), "utf8");
  console.log(`报告: ${out}`);

  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error("[probe] 失败:", e.message);
  console.error(mainLog.join("").split("\n").filter(Boolean).slice(-20).join("\n"));
  child.kill();
  process.exit(1);
});
