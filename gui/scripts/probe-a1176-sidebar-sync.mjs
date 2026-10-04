/* eslint-disable */
/**
 * gui/scripts/probe-a1176-sidebar-sync.mjs —— 浮层态「展开左栏」时右栏是否**同步让位**。
 *
 * ## 用户现象（A-1176）
 * 「窗口化后，左侧边栏的展开，动画慢于动作……右侧边栏已经让开了（是秒让，没有动画），
 *   左侧边栏才跟上。主要问题就是窗口化后，右侧边栏没有与左侧边栏的展开衔接动画协调」。
 *
 * ## 判据
 * 点「展开左栏」之后：
 *   · `sb`（左栏）宽度：0 → 240，CSS `transition: width 0.5s`（渐入）
 *   · `rw`（右栏容器）左缘：应当**同步**从 0 → 240，**跑满 ~500ms**
 * ⇒ 若 `rw.l` 在**一两帧内**就跳到 240（而 `sb.w` 还在慢慢长）⇒ 就是用户说的「秒让、没动画」。
 *
 * 采样由**探针侧发 CDP eval**（窗口 hidden 时页内 rAF/timer 会被停）。
 * 运行：`SLIME_DEVTOOLS_PORT=<port> node gui/scripts/probe-a1176-sidebar-sync.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9447);
const OUT = process.env.SLIME_A1176_OUT || "D:/pilot project/gui/output-a1176-sync.txt";
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) { return page; }
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("CDP 目标未找到");
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) { rej(new Error(JSON.stringify(m.error))); } else { res(m.result); } } };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 40000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error("eval 异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
    return r.result.value;
  }
}

const BEGIN = `(() => { window.__syT0 = performance.now(); return "OK"; })()`;

/* 一行采样：[t, sb.l, sb.w, rw.l, rw.w, bodyCls, leftWVar] */
const SAMPLE = `JSON.stringify((() => {
  const sb = document.querySelector(".sidebar");
  const rw = document.querySelector(".right-wrapper");
  if (!sb || !rw) { return null; }
  const a = sb.getBoundingClientRect(), b = rw.getBoundingClientRect();
  return [Math.round(performance.now() - window.__syT0),
    Math.round(a.left), Math.round(a.width), Math.round(b.left), Math.round(b.width),
    document.body.className, rw.style.getPropertyValue("--left-w") || "-"];
})())`;

const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO"; }
  (img.closest("button") || img.parentElement || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

const CLICK_LEFT = `(() => {
  const b = Array.from(document.querySelectorAll("header.titlebar button, .titlebar button"))
    .find((x) => /侧栏|侧边栏/.test(x.getAttribute("title") || ""));
  if (!b) { return "NO"; }
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

function report(rows, label) {
  say(`\n═══ ${label} ═══`);
  if (!rows.length) { say("  ❌ 0 帧"); return; }
  say("   t(ms)   sb.l  sb.w   rw.l  rw.w   left-w");
  for (const r of rows) {
    say(`  ${String(r[0]).padStart(6)} ${String(r[1]).padStart(6)} ${String(r[2]).padStart(5)}  ${String(r[3]).padStart(6)} ${String(r[4]).padStart(5)}   ${r[6]}`);
  }
  /* 判据：rw.l 到位用了多久 vs sb.w 到位用了多久 */
  const t = (pred) => { const f = rows.find(pred); return f ? f[0] : null; };
  const first = rows[0];
  const target = 240;
  const tRw = t((r) => Math.abs(r[3] - target) <= 2);
  const tSb = t((r) => Math.abs(r[2] - target) <= 2);
  say(`  ⏱  rw.l 到达 240 用时 ${tRw === null ? "未达到" : tRw - first[0] + "ms"}｜sb.w 到达 240 用时 ${tSb === null ? "未达到" : tSb - first[0] + "ms"}`);
  if (tRw !== null && tSb !== null) {
    const gap = (tSb - first[0]) - (tRw - first[0]);
    say(gap > 150
      ? `  ❌ 右栏比左栏**早 ${gap}ms** 到位 ⇒ 就是用户说的「右栏秒让、左栏才跟上」（不协调）`
      : `  ✅ 两者到位时间接近（差 ${gap}ms）`);
  }
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  /* ⚠️ 先请求前置：窗口被最小化/切走时 `visibilityState` 会是 hidden，
     而那时 Electron 会把 rAF 与 timer 一起停掉、**连布局都不更新** ⇒ 采样全假。 */
  try { await cdp.send("Page.bringToFront"); } catch { /* 老版本无此命令 */ }
  await new Promise((r) => setTimeout(r, 500));
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));
  try { await cdp.send("Page.bringToFront"); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 600));
  const vis = await cdp.eval("document.visibilityState");
  say(`  visibilityState=${vis}`);
  if (vis !== "visible") { say("❌ 窗口不可见 ⇒ 先把 slime 窗口恢复/置前再跑。"); process.exit(1); }
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ gate: !!document.querySelector('img[alt="唤起悬浮窗"]'), rw: !!document.querySelector(".right-wrapper") })`));
    if (st.gate && st.rw) { ready = true; say(`✅ 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未就绪"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));

  say("\n[动作] 点「窗口化」进入浮层态…");
  say("  " + await cdp.eval(CLICK_FLOAT));
  await new Promise((r) => setTimeout(r, 2000));

  const once = async (label) => {
    await cdp.eval(BEGIN);
    await cdp.eval(CLICK_LEFT);
    const rows = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      const r = JSON.parse(await cdp.eval(SAMPLE));
      if (r) { rows.push(r); }
      await new Promise((res) => setTimeout(res, 5));
    }
    report(rows, label);
  };

  await once("① 浮层态 · 展开左栏");
  await new Promise((r) => setTimeout(r, 700));
  await once("② 浮层态 · 收起左栏");

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
