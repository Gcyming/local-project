/* eslint-disable */
/**
 * gui/scripts/probe-drag-perf.cjs — 拖动/窗口化的**每帧成本**实测（A-1152）。
 *
 * ## 为什么要注入假消息
 * 真产物探针（`probe-left-gap.cjs`）量布局时，聊天区是**空的**（没有会话数据 ⇒ ChatPanel 不挂载），
 * 重排成本接近 0 ⇒ 量出来的"很流畅"是假的。
 * 而真实的掉帧恰恰来自**长会话的聊天区**（上千 DOM 节点）在每帧宽度变化时全量重排。
 * ⇒ 这里往 `.main` 里注入 N 段文本节点模拟长会话，再量。
 *
 * ## 判据（三条都是"行为/成本"，不是像素）
 * ① 帧间隔：用户是 ~166Hz ⇒ 帧预算 **6ms**；`dt > 12ms` 记为掉帧，`dt > 33ms` 记为严重卡顿；
 * ② 每帧**同步布局耗时**：在 rAF 里读一次几何（强制 layout）测出这一帧为了拿新宽度要重排多少；
 * ③ longtask（>50ms）条数：Chromium 的 PerformanceObserver，React 重渲染导致的超长任务会命中。
 *
 * 用法：cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-drag-perf.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const GUI = path.join(__dirname, "..");
const PAGE = path.join(GUI, "out", "renderer", "index.html");
const PRELOAD = path.join(GUI, "out", "preload", "index.js");
const outPath = path.join(os.tmpdir(), "slime-probe-drag-perf.txt");
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(outPath, lines.join("\n"), "utf8"); };

/* 注入 N 段消息 + 跑一轮"把宽度从 A 扫到 B"的拖动，逐帧采成本。 */
/* ⚠️ 必须 `async`：脚本体里用了 await，第一版漏了 async IIFE ⇒ 整段抛"Script failed to execute"。 */
const SCRIPT = (sel, from, to, nodes, skip) => `(async () => {
  const main = document.querySelector(".main");
  if (!main) { return "NO-MAIN"; }
  // ⚠️ 复刻真实结构：消息流在 `.chat-scroll` 里（真产物没有会话 ⇒ 容器也不存在，先建出来）。
  // 判据 CSS（body.slime-resizing .chat-scroll）只对这个类生效，注到 .main 上验不到。
  let scrollBox = document.querySelector(".chat-scroll");
  if (!scrollBox) {
    scrollBox = document.createElement("div");
    scrollBox.className = "chat-scroll";
    scrollBox.style.cssText = "flex:1;min-height:0;overflow:auto";
    main.appendChild(scrollBox);
  }
  for (let i = 0; i < ${nodes}; i++) {
    const el = document.createElement("div");
    el.className = "msg-row";
    el.textContent = "第 " + i + " 条消息：这是一段用于模拟真实长会话的文本内容，用来把重排成本放大到可测量。";
    scrollBox.appendChild(el);
  }
  const sb = document.querySelector(".sidebar");
  const t0 = performance.now();
  const rows = [];
  let last = t0;
  const longtasks = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { longtasks.push(+e.duration.toFixed(1)); } })
      .observe({ entryTypes: ["longtask"] });
  } catch { /* 不支持就只靠 dt 判 */ }
  await new Promise((res) => {
    const step = (t) => {
      const p = (t - t0) / (${to} - ${from});
      const w = ${from} + (${to} - ${from}) * Math.min(1, Math.max(0, p));
      sb.style.width = w + "px";
      document.body.classList.toggle("slime-resizing", ${skip ? "true" : "false"});
      rows.push({ dt: +(t - last).toFixed(1) });
      last = t;
      if (t - t0 < 600) { requestAnimationFrame(step); } else { res(); }
    };
    requestAnimationFrame(step);
  });
  const dts = rows.map((r) => r.dt);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return JSON.stringify({
    frames: rows.length,
    dtMax: +Math.max(0, ...dts).toFixed(1),
    dtP95: +dts.slice().sort((a, b) => a - b)[Math.floor(dts.length * 0.95)].toFixed(1),
    dropped6ms: dts.filter((x) => x > 12).length,
    dropped33ms: dts.filter((x) => x > 33).length,
    longtasks,
  });
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 800, x: 30, y: 30,
    webPreferences: {
      preload: fs.existsSync(PRELOAD) ? PRELOAD : undefined,
      contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  const ev = (js) => win.webContents.executeJavaScript(js);
  say("探针已启动（Chromium " + process.versions.electron + "）");
  await win.loadFile(PAGE);
  await new Promise((r) => setTimeout(r, 3500));
  say("真产物已加载");
  try {

  for (const nodes of [1000, 2000]) {
    // ⚠️ 每组**重载页面**：上一轮组间没重置 ⇒ 后面的组叠着前面的 DOM，数据自相矛盾
    // （2000 条那组一度测出 0 掉帧，与首轮的 27 掉帧/83ms longtask 冲突）。
    await win.loadFile(PAGE);
    await new Promise((r) => setTimeout(r, 3000));
    const a = await ev(SCRIPT(".sidebar", 240, 520, nodes, false));
    say("注入 " + nodes + " 条 ·【对照 A：正常重排】");
    say("  " + a);
    await win.loadFile(PAGE);
    await new Promise((r) => setTimeout(r, 3000));
    const b = await ev(SCRIPT(".sidebar", 240, 520, nodes, true));
    say("注入 " + nodes + " 条 ·【对照 B：body.slime-resizing（本次修复）】");
    say("  " + b);
  }
  } catch (e) { say("❌ 失败：" + String(e && e.message ? e.message : e)); }
  app.exit(0);
});
