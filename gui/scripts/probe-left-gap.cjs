/* eslint-disable */
/**
 * gui/scripts/probe-left-gap.cjs — 「左栏收起/中间最小化时最左边那段空白是谁」。
 *
 * ## 为什么这么写
 * 用户四张截图 + 原话：「slime 中间最小化、窗口化，右侧边栏最大化，slime 界面最左侧就是会有一段空白间隔」。
 * 之前的版本**直接给 DOM 设 style** 去模拟 —— 那是错的：绕过了 React 状态，根本没进 float/min 态，
 * 量出来的自然是"一切正常"。**必须走真实点击路径**：
 *   ① 点 title=「唤起聊天悬浮窗…」（展开右栏到最宽 + 聊天变悬浮窗）
 *   ② 点 title=「最小化（缩小为图标）」（→ min 态，用户报的就是这一步）
 *
 * ## 判据
 * `document.elementFromPoint(x, 300)` 逐点问"这个坐标上是谁" —— 比量几何强：
 * 连"盒子为 0 但内容溢出可见"的形态也能抓到（几何判据会漏）。
 *
 * ⚠️ 本文件是**可见窗口**脚本，跑前必须 `node --check`（曾把报错窗弹到用户屏幕上）。
 * 用法：cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-left-gap.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const GUI = path.join(__dirname, "..");
const PAGE = path.join(GUI, "out", "renderer", "index.html");
const PRELOAD = path.join(GUI, "out", "preload", "index.js");
const outPath = path.join(os.tmpdir(), "slime-probe-left-gap.txt");
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(outPath, lines.join("\n"), "utf8"); };

/* 逐点扫描：把 x 轴上一排坐标上的"命中者"打出来 */
const SCAN = `(() => {
  const rows = [];
  for (const x of [1, 3, 6, 10, 16, 24, 34, 44, 60, 120]) {
    const el = document.elementFromPoint(x, 300);
    if (!el) { rows.push(String(x) + ":null"); continue; }
    const b = el.getBoundingClientRect();
    rows.push(x + "=" + el.tagName.toLowerCase() + "." + String(el.className || "").slice(0, 30)
      + "[x0=" + b.x.toFixed(0) + " w=" + b.width.toFixed(0) + ']"'
      + ' "' + String(el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 26) + '"');
  }
  return rows.join(" | ");
})()`;

const GEOM = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) { return sel + ":null"; }
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return sel + " x=" + b.x.toFixed(1) + " w=" + b.width.toFixed(1) + " op=" + cs.opacity
      + " ov=" + cs.overflow + " clip=" + cs.overflowClipMargin + " minW=" + cs.minWidth;
  };
  return [".sidebar", ".main", ".right-wrapper", ".body", ".app"].map(pick).join(" | ");
})()`;

const clickByTitle = (t) => `(() => {
  const b = document.querySelector('button[title="' + ${JSON.stringify(t)} + '"]');
  if (!b) { return "NO-BUTTON"; }
  b.click();
  return "CLICKED";
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1080, height: 700, x: 40, y: 40,
    webPreferences: {
      preload: fs.existsSync(PRELOAD) ? PRELOAD : undefined,
      contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  const ev = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(PAGE);
  await new Promise((r) => setTimeout(r, 3500));

  say("[1 初始] " + await ev(GEOM));
  say("[1 初始] " + await ev(SCAN));

  say("[2 唤起悬浮窗] " + await ev(clickByTitle("唤起聊天悬浮窗（展开右栏到最宽，聊天以悬浮窗浮于其上；再点收起）")));
  await new Promise((r) => setTimeout(r, 2000));
  say("[2 float] " + await ev(GEOM));
  say("[2 float] " + await ev(SCAN));

  say("[3 最小化] " + await ev(clickByTitle("最小化（缩小为图标）")));
  await new Promise((r) => setTimeout(r, 2000));
  say("[3 min] " + await ev(GEOM));
  say("[3 min] " + await ev(SCAN));

  app.exit(0);
});
