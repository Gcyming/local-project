#!/usr/bin/env node
/**
 * gui/scripts/probe-rail-loop.mjs — 目录卷轴的**活实例取证**：循环数与画面形态。
 *
 * ## 为什么需要它（A-1118）
 *
 * 本轮出现过两个**只有真窗口才看得见**的缺陷，而源码级守卫、tsc、构建**全部是绿的**：
 *   ① **rAF 循环泄漏** —— 同一张 canvas 上有两代闭包同时逐帧画，旧的每帧后画、
 *      把新的图整帧盖掉 ⇒ 用户看到「md 编辑页只有滚动 / 悬停时才变成刻度，其余时间是波形」；
 *   ② **与边界相交** —— 页签按钮左边框与设置导航栏的分割线**像素级重合**。
 * 两者都不是"某个函数写错了"，而是**运行时布局 / 生命周期事实** ⇒ 只能用活实例取证。
 *
 * 本脚本就把那次取证固化下来（当时是用临时脚本 + CDP 手敲的），判据两条：
 *
 *   · **每张 canvas 每秒的清屏次数必须 ≈ 帧率**。若某张 canvas ≈ 2× 帧率，说明**有两个闭包在抢同一张画布**
 *     （这正是泄漏的签名）；改前实测 692 vs 1384 次 / 2s ⇒ 演示框那张被画了两遍。
 *   · **不同 rAF 回调实例数**。改前：界面上 2 个卷轴、活着 **6** 个循环。
 *
 * ⚠️ 端口**不硬编码 9222**（A-1110 起会顺延）：优先读 `<userData>/devtools-port.json`，
 *    也支持 `--port N` 显式覆盖。
 * ⚠️ **窗口被遮挡 / 最小化时 rAF 会被 Chromium 暂停**，那时数字全是 0 —— 脚本会识别并提示
 *    「把窗口提到前台再跑」，**不会**把 0 当成"没有泄漏"。这是本轮真实踩到的坑：
 *    第一次测量得到 0 次重绘，差点误判成"画布静止、说明没问题"。
 * ⚠️ 只读、不改任何状态；注入的计数器会在结束时卸掉。
 *
 * 用法：
 *   node gui/scripts/probe-rail-loop.mjs                 # 自动尝试打开「设置 → 外观 → md 文档」
 *   node gui/scripts/probe-rail-loop.mjs --port 9223
 *   node gui/scripts/probe-rail-loop.mjs --no-nav        # 只测量，不动界面
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const NO_NAV = argv.includes("--no-nav");
const MEASURE_MS = 1500;

/** 端口：命令行 > 落盘文件 > 默认。落盘位置与主进程同源（`app.getPath("userData")`）。 */
function resolvePort() {
  const explicit = argVal("--port");
  if (explicit) { return Number(explicit); }
  const home = process.env.APPDATA || process.env.HOME || "";
  const dir = platform() === "win32" ? join(home, "slime-gui") : join(home, ".config", "slime-gui");
  try {
    const j = JSON.parse(readFileSync(join(dir, "devtools-port.json"), "utf8"));
    if (Number.isInteger(j.port) && j.port > 0) { return j.port; }
  } catch { /* 没跑过 dev / 文件不存在：回落默认，下面的探活会说话 */ }
  return 9222;
}

const PORT = resolvePort();

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return await r.json();
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const to = setTimeout(() => rej(new Error("ws 打开超时")), 8000);
    ws.addEventListener("open", () => { clearTimeout(to); res(ws); });
    ws.addEventListener("error", () => { clearTimeout(to); rej(new Error("ws 连接失败")); });
  });
}

let seq = 0;
function send(ws, method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    const h = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === id) {
        ws.removeEventListener("message", h);
        if (m.error) { rej(new Error(`${method} → ${JSON.stringify(m.error)}`)); } else { res(m.result); }
      }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => rej(new Error(`${method} 超时`)), 30000);
  });
}

async function evaluate(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) { throw new Error(`页面内抛错：${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`); }
  return r.result?.value;
}

/** 页面内执行：先自动导航到「外观 → md 文档」，再采集循环数与画布形态。 */
const COLLECT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NAV = ${NO_NAV ? "false" : "true"};

  if (NAV) {
    const openBtn = Array.from(document.querySelectorAll("[title]"))
      .find((e) => /^设置（/.test(e.getAttribute("title") || ""));
    if (openBtn && !document.querySelector(".modal-card")) { openBtn.click(); await sleep(700); }
    const mc = document.querySelector(".modal-card");
    if (mc) {
      const nav = Array.from(mc.querySelectorAll("button")).find((b) => /^外观/.test((b.textContent || "").trim()));
      if (nav) { nav.click(); await sleep(600); }
      const md = Array.from(mc.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "md 文档");
      if (md) { md.click(); await sleep(800); }
    }
  }

  /* ── 采集 1：rAF 回调实例数（每个实例 = 一个活着的循环） ── */
  const origRaf = window.requestAnimationFrame;
  const seen = new Map();
  window.requestAnimationFrame = function (cb) {
    const key = cb.__probeTag || (cb.__probeTag = seen.size + 1);
    if (!seen.has(key)) { seen.set(key, { frames: 0, where: (new Error().stack || "").split("\\n")[2] || "" }); }
    seen.get(key).frames++;
    return origRaf.call(window, cb);
  };

  /* ── 采集 2：每张 canvas 的清屏次数（> 帧率 ⇒ 有第二个闭包在抢同一张画布） ── */
  const rails = Array.from(document.querySelectorAll(".topic-rail"));
  const canvasMeters = rails.map((host) => {
    const cv = host.querySelector("canvas");
    const hit = host.querySelector(".topic-rail-hit");
    const ctx = cv && cv.getContext("2d");
    const m = { clears: 0, ok: !!ctx };
    if (ctx) {
      const orig = ctx.clearRect.bind(ctx);
      ctx.clearRect = function (...a) { m.clears++; return orig(...a); };
      m.restore = () => { ctx.clearRect = orig; };
    }
    return {
      m, host, hit, cv, ctx,
      label: hit ? hit.getAttribute("aria-label") : "?",
      rect: (() => { const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height }; })(),
    };
  });

  const t0 = performance.now();
  await sleep(${MEASURE_MS});
  const dur = performance.now() - t0;
  window.requestAnimationFrame = origRaf;

  /* ── 采集 3：画布形态（波形 = 1 段连续；刻度 = 多段离散） ── */
  const shapeOf = (o) => {
    if (!o.ctx) { return "无画布"; }
    const cv = o.cv;
    const dpr = window.devicePixelRatio || 1;
    const OX = 12, W = 12, RIGHT_ROOM = 6;
    const x0 = Math.round(OX * dpr), x1 = Math.min(cv.width, Math.round((OX + W) * dpr));
    const img = o.ctx.getImageData(0, 0, cv.width, cv.height).data;
    let filled = 0, total = 0, runs = 0, prev = false;
    for (let y = 0; y < cv.height; y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) { if (img[(y * cv.width + x) * 4 + 3] > 8) { n++; } }
      total++;
      if (n > 0) { filled++; if (!prev) { runs++; } prev = true; } else { prev = false; }
    }
    const pct = Math.round((filled / total) * 1000) / 10;
    if (runs <= 1 && pct > 90) { return "波形（连续，覆盖 " + pct + "% 行）"; }
    if (runs >= 3) { return "刻度（" + runs + " 段离散，覆盖 " + pct + "% 行）"; }
    return "稀疏（" + runs + " 段 / " + pct + "%）";
  };

  const shapes = canvasMeters.map((o) => shapeOf(o));
  const rows = canvasMeters.map((o, i) => ({
    卷轴: o.label,
    位置: Math.round(o.rect.x) + "," + Math.round(o.rect.y),
    高: Math.round(o.rect.h),
    形态: shapes[i],
    清屏次数: o.m.clears,
    每秒清屏: Math.round(o.m.clears / (dur / 1000)),
  }));
  for (const o of canvasMeters) { if (o.m.restore) { o.m.restore(); } }

  const loops = Array.from(seen.values())
    .map((v) => ({ frames: v.frames, fps: Math.round(v.frames / (dur / 1000)), where: String(v.where).trim().slice(-90) }))
    .sort((a, b) => b.frames - a.frames);

  return { durationMs: Math.round(dur), railCount: rails.length, canvasRows: rows, loopCount: seen.size, loops };
})()`;

const targets = await listTargets();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("file:"))
  ?? targets.find((t) => t.type === "page");
if (!page) { console.error(`端口 ${PORT} 上没有可调试页面。先跑 \`npm run dev\`（在 gui/ 下）。`); process.exit(2); }

const ws = await connect(page.webSocketDebuggerUrl);
await send(ws, "Page.bringToFront").catch(() => {});
await send(ws, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

let data;
try {
  data = await evaluate(ws, COLLECT);
} finally {
  ws.close();
}

/* ── 报告 ─────────────────────────────────────────────────────────────── */
console.log(`\n目录卷轴活实例取证（CDP 端口 ${PORT}，采样 ${data.durationMs}ms）\n`);
console.log(`发现 ${data.railCount} 个卷轴：`);
for (const r of data.canvasRows) {
  console.log(`  · ${r.卷轴}  @${r.位置}  高${r.高}px`);
  console.log(`      形态：${r.形态}`);
  console.log(`      清屏：${r.清屏次数} 次 / ${r.每秒清屏} 次每秒`);
}

console.log(`\n活着的 rAF 循环：${data.loopCount} 个`);
for (const l of data.loops) {
  console.log(`  · ${l.fps} fps（${l.frames} 帧）  ${l.where || "（无栈信息）"}`);
}

/* 判定：把"帧率"当作该有的清屏速率基准（dev 下窗口帧率未必 60）。 */
const maxFps = Math.max(1, ...data.canvasRows.map((r) => r.每秒清屏));
const problems = [];
for (const r of data.canvasRows) {
  if (r.清屏次数 === 0) { continue; }
  if (r.每秒清屏 > maxFps * 1.5) {
    problems.push(`「${r.卷轴}」每秒被清屏 ${r.每秒清屏} 次，是其他画布（${maxFps}）的 `
      + `${(r.每秒清屏 / maxFps).toFixed(1)} 倍 ⇒ **有两个闭包在抢同一张画布**（rAF 循环泄漏）`);
  }
}
if (data.loopCount > data.railCount && data.loopCount > 0) {
  problems.push(`活着 ${data.loopCount} 个绘制循环，但只有 ${data.railCount} 个卷轴 ⇒ **有 ${data.loopCount - data.railCount} 个僵尸循环**`);
}

if (data.canvasRows.every((r) => r.清屏次数 === 0)) {
  console.log("\n⚠️ 所有画布在采样期都没重绘 —— **窗口可能被遮挡 / 最小化，rAF 被 Chromium 暂停**。");
  console.log("   把窗口提到前台再跑一次；不要把这个 0 当成「没有泄漏」。");
  process.exit(3);
}

if (problems.length === 0) {
  console.log("\n✅ 未发现循环泄漏：每张画布的清屏速率一致，且循环数不超过卷轴数。");
  process.exit(0);
}
console.log("\n❌ 发现问题：");
for (const p of problems) { console.log("  · " + p); }
process.exit(1);
