/* eslint-disable */
/**
 * gui/scripts/probe-a1177-drag-gap.mjs —— 浮层态**拖动左栏分隔线**时，右栏是否跟随。
 *
 * ## 用户现象（A-1177）
 * 「窗口化后，如果你大幅拖动调整左右侧边栏比例，中间的分隔线就会分开，
 *   分的不远会自动吸附，一旦远了，就无法吸附变成……空白区域。」
 * 截图：左栏内容右边界在 x≈230，而分隔线/主区在 x≈318 ⇒ 中间约 88px 空白。
 *
 * ## 假设
 * 浮层态 `rw` 的宽度是「窗口宽 − `--left-w`」，而 `--left-w` 写的是**目标占位宽**
 * （`sidebarOpen ? sidebarWidth : 0`）；拖拽为了"零 React 重渲染"**不更新 `sidebarWidth`**
 * （松手才落 state，见 A-1152/A-1154）⇒ **拖拽期间 `--left-w` 不跟随** ⇒ 左右栏边界脱节。
 *
 * ## 判据
 * 拖动过程中每一帧都应满足 `rw.left === sb.width`（右栏左缘贴着左栏右缘）。
 * 偏差 > 8px 就是"分开"。
 *
 * 运行：`SLIME_DEVTOOLS_PORT=<port> node gui/scripts/probe-a1177-drag-gap.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9448);
const OUT = process.env.SLIME_A1177_OUT || "D:/pilot project/gui/output-a1177-gap.txt";
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

const BEGIN = `(() => { window.__dgT0 = performance.now(); return "OK"; })()`;

/* [t, sb.l, sb.w, rw.l, rw.w, leftWVar, sbInnerW, bodyCls] */
const SAMPLE = `JSON.stringify((() => {
  const sb = document.querySelector(".sidebar");
  const rw = document.querySelector(".right-wrapper");
  if (!sb || !rw) { return null; }
  const a = sb.getBoundingClientRect(), b = rw.getBoundingClientRect();
  return [Math.round(performance.now() - window.__dgT0),
    Math.round(a.left), Math.round(a.width), Math.round(b.left), Math.round(b.width),
    rw.style.getPropertyValue("--left-w") || "-", sb.style.width || "-", sb.className];
})())`;

const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO"; }
  (img.closest("button") || img.parentElement || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

/* 模拟拖左栏的分隔线：pointerdown → 多次 pointermove → pointerup（每步由探针侧驱动，便于逐帧采样） */
const DRAG_DOWN = `(() => {
  const el = document.querySelector(".sidebar-resizer");
  if (!el) { return "NO-RESIZER"; }
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  window.__dgX = x; window.__dgY = y;
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, buttons: 1 }));
  return "OK at " + x + "," + y;
})()`;

const moveBy = (dx) => `(() => {
  document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: window.__dgX + (${dx}), clientY: window.__dgY, pointerId: 1, isPrimary: true, buttons: 1 }));
  return "OK";
})()`;

const DRAG_UP = `(() => {
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: window.__dgX, clientY: window.__dgY, pointerId: 1, isPrimary: true }));
  return "OK";
})()`;

function report(rows, label) {
  say(`\n═══ ${label} ═══`);
  if (!rows.length) { say("  ❌ 0 帧"); return; }
  say("   t(ms)   sb.w   rw.l   错位 |  left-w       sbInlineW       sbClass");
  let worst = 0, worstAt = null;
  for (const r of rows) {
    const gap = r[3] - r[2];   // 右栏左缘 − 左栏右缘
    if (Math.abs(gap) > Math.abs(worst)) { worst = gap; worstAt = r[0]; }
    say(`  ${String(r[0]).padStart(6)} ${String(r[2]).padStart(6)} ${String(r[3]).padStart(6)} ${String(gap).padStart(6)} |  ${String(r[5]).padStart(11)}  ${String(r[6]).padStart(13)}  ${r[7]}`);
  }
  say(`  ⚠️ 最大错位 ${worst}px（@${worstAt}ms）⇒ ${Math.abs(worst) > 8 ? "❌ 左右栏边界**脱节**（就是用户看到的空白）" : "✅ 全程贴合"}`);
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  /* ⚠️⚠️ `bringToFront` 要**重试到真的 visible**：窗口被切走时它是异步的，
     单次调用常常无效 ⇒ 后面所有采样都会是"布局不更新"的假数据。
     （实测连续两次：第一次报 hidden、第二次才 visible。） */
  let vis = "hidden";
  for (let i = 0; i < 12; i++) {
    try { await cdp.send("Page.bringToFront"); } catch { /* 老版本无此命令 */ }
    await new Promise((r) => setTimeout(r, 500));
    vis = await cdp.eval("document.visibilityState");
    if (vis === "visible") { say(`  ✅ 第 ${i + 1} 次 bringToFront 后可见`); break; }
  }
  if (vis !== "visible") { say(`❌ 窗口仍是 ${vis} ⇒ 请手动把 slime 窗口切到前台再跑。`); process.exit(1); }
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));
  for (let i = 0; i < 12; i++) {
    try { await cdp.send("Page.bringToFront"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
    if (await cdp.eval("document.visibilityState") === "visible") { break; }
  }
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ gate: !!document.querySelector('img[alt="唤起悬浮窗"]'), rz: !!document.querySelector(".sidebar-resizer") })`));
    if (st.gate && st.rz) { ready = true; say(`✅ 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未就绪（缺 .sidebar-resizer？）"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1200));

  say("\n[动作] 进入浮层态…");
  say("  " + await cdp.eval(CLICK_FLOAT));
  await new Promise((r) => setTimeout(r, 2000));

  await cdp.eval(BEGIN);
  say("\n[动作] pointerdown 到左栏分隔线上 ⇒ " + await cdp.eval(DRAG_DOWN));

  /* 场景 1：向右拖到**最宽**（远超 max 520，测上限夹取 + 吸附） */
  const rows1 = [];
  for (let step = 1; step <= 10; step++) {
    await cdp.eval(moveBy(step * 40));
    const r = JSON.parse(await cdp.eval(SAMPLE));
    if (r) { rows1.push(r); }
    await new Promise((res) => setTimeout(res, 55));
  }
  say("[动作] pointerup ⇒ " + await cdp.eval(DRAG_UP));
  await new Promise((res) => setTimeout(res, 600));
  const a1 = JSON.parse(await cdp.eval(SAMPLE));
  if (a1) { rows1.push(a1); }
  report(rows1, "① 浮层态 · 向右拖到最宽");

  /* 场景 2：重新按住，向左拖到**最窄**（测吸附收起那段） */
  await new Promise((res) => setTimeout(res, 600));
  await cdp.eval(DRAG_DOWN);
  const rows2 = [];
  for (let step = 1; step <= 10; step++) {
    await cdp.eval(moveBy(-step * 40));
    const r = JSON.parse(await cdp.eval(SAMPLE));
    if (r) { rows2.push(r); }
    await new Promise((res) => setTimeout(res, 55));
  }
  await cdp.eval(DRAG_UP);
  await new Promise((res) => setTimeout(res, 600));
  const a2 = JSON.parse(await cdp.eval(SAMPLE));
  if (a2) { rows2.push(a2); }
  report(rows2, "② 浮层态 · 向左拖到最窄（含吸附）");

  /* 场景 3：拖**右栏**分隔线（浮层态下右栏是铺满的，看它会不会把边界弄错位） */
  await new Promise((res) => setTimeout(res, 600));
  const d3 = await cdp.eval(`(() => {
    const el = document.querySelector(".right-resizer, .right-sidebar .sidebar-resizer, .right-sidebar-resizer");
    if (!el) { return "NO-RIGHT-RESIZER"; }
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    window.__dgX = x; window.__dgY = y;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, isPrimary: true, buttons: 1 }));
    return "OK at " + x + "," + y;
  })()`);
  say("\n[动作] 拖右栏分隔线 ⇒ " + d3);
  if (!d3.startsWith("NO-")) {
    const rows3 = [];
    for (let step = 1; step <= 8; step++) {
      await cdp.eval(moveBy(-step * 30));
      const r = JSON.parse(await cdp.eval(SAMPLE));
      if (r) { rows3.push(r); }
      await new Promise((res) => setTimeout(res, 55));
    }
    await cdp.eval(DRAG_UP);
    await new Promise((res) => setTimeout(res, 600));
    const a3 = JSON.parse(await cdp.eval(SAMPLE));
    if (a3) { rows3.push(a3); }
    report(rows3, "③ 浮层态 · 向左拖右栏分隔线");
  }

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
