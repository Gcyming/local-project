/* eslint-disable */
/**
 * gui/scripts/probe-a1172-trace.mjs —— 浮层态「左栏折叠 / 展开」**逐帧**追踪。
 *
 * 目的：验证 A-1172（`--left-w` 写实测宽）**没有**引入 A-1166 担心的「逐帧闭环抖动」。
 * 判据（每一帧）：
 *   · rw.left  应 ≈ sb.width      （右栏左缘跟着左栏右缘走）
 *   · rw.width 应 ≈ vw − sb.width （右栏宽度 = 窗口 − 左栏）
 *   · --left-w 应 ≈ sb.width
 *   · 以上三者**单调**（无方向反转）即「不抖」
 * 运行：`node gui/scripts/probe-a1172-trace.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = "D:/pilot project/gui/out/_a1172-trace.txt";
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

const ARM = `(() => {
  const sb = document.querySelector(".sidebar");
  const rw = document.querySelector(".right-wrapper");
  window.__tr = { t0: 0, rows: [] };
  const tr = window.__tr;
  const tick = () => {
    const now = performance.now();
    const s = sb.getBoundingClientRect();
    const r = rw.getBoundingClientRect();
    const lw = rw.style.getPropertyValue("--left-w") || "-";
    tr.rows.push([Math.round(now - tr.t0), Math.round(s.width), Math.round(r.left), Math.round(r.width), lw]);
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  return "ARMED";
})()`;

const CLICK_LEFT = `(() => {
  const b = Array.from(document.querySelectorAll("header.titlebar button, .titlebar button"))
    .find((x) => /侧栏|侧边栏/.test(x.getAttribute("title") || ""));
  if (!b) { return "NO"; }
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

const READ = `JSON.stringify((() => {
  const tr = window.__tr;
  cancelAnimationFrame(tr.raf);
  return { total: tr.rows.length, rows: tr.rows };
})())`;

function analyze(rows, key, idx) {
  const marks = [];
  let last = null;
  for (const r of rows) {
    const v = r[idx];
    if (last === null || last !== v) { marks.push([r[0], v]); last = v; }
  }
  let dir = 0, rev = 0; const at = [];
  for (let k = 1; k < marks.length; k++) {
    const d = marks[k][1] - marks[k - 1][1];
    if (Math.abs(d) < 2) { continue; }
    const nd = Math.sign(d);
    if (dir !== 0 && nd !== dir) { rev++; at.push(marks[k][0]); }
    dir = nd;
  }
  return { key, marks, rev, at: at.slice(0, 6) };
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch {}
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ btn: !!document.querySelector('img[alt="唤起悬浮窗"]') })`));
    if (st.btn) { say(`✅ 启动门（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  await new Promise((r) => setTimeout(r, 1200));

  const clickFloat = `(() => { const img = document.querySelector('img[alt="唤起悬浮窗"]'); if (!img) { return "NO"; }
    (img.closest("button") || img.parentElement || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return "OK"; })()`;

  say("进浮层=" + (await cdp.eval(clickFloat)));
  await new Promise((r) => setTimeout(r, 2600));

  const runOnce = async (label) => {
    say(`\n═══ ${label} ═══`);
    say("  装采样器=" + (await cdp.eval(ARM)));
    say("  点击=" + (await cdp.eval(CLICK_LEFT)));
    await new Promise((r) => setTimeout(r, 2600));
    const o = JSON.parse(await cdp.eval(READ));
    const rows = o.rows;
    const A = analyze(rows, "sb.width", 1);
    const B = analyze(rows, "rw.left", 2);
    const C = analyze(rows, "rw.width", 3);
    for (const a of [A, B, C]) {
      say(`  📐 ${a.key.padEnd(10)} ${String(a.rev).padStart(3)} 次反转 · ${String(a.marks.length).padStart(3)} 点 · ${JSON.stringify(a.marks[0])} → ${JSON.stringify(a.marks[a.marks.length - 1])}`
        + (a.at.length ? ` · 反转于 ${a.at.join("/")}ms` : ""));
    }
    /* 一致性：rw.left 应 ≈ sb.width；rw.width 应 ≈ vw − sb.width；--left-w ≈ sb.width */
    const vw = await cdp.eval("window.innerWidth");
    let bad = 0; const checks = [];
    for (const r of rows) {
      const [, sbw, rwl, rww] = r;
      if (Math.abs(rwl - sbw) > 2) { bad++; if (checks.length < 5) { checks.push(`t=${r[0]} rw.left=${rwl} ≠ sb.w=${sbw}`); } }
      if (Math.abs(rww - (vw - sbw)) > 2) { bad++; if (checks.length < 5) { checks.push(`t=${r[0]} rw.w=${rww} ≠ ${vw}-${sbw}`); } }
    }
    say(`  🔗 一致性：${bad === 0 ? "✓ 全程 rw.left == sb.width 且 rw.width == vw − sb.width" : "❌ " + bad + " 帧不一致 → " + checks.join(" | ")}`);
    /* 时间线（变化点） */
    const marks = []; let last = "";
    for (const r of rows) {
      const k = r.slice(1).join(",");
      if (k !== last) { marks.push(`${String(r[0]).padStart(4)}ms sb.w=${r[1]} rw.left=${r[2]} rw.w=${r[3]} left-w=${r[4]}`); last = k; }
    }
    say("  🔍 变化点：");
    for (const m of marks.slice(0, 22)) { say("      " + m); }
  };

  await runOnce("② 浮层态·折叠左栏");
  await new Promise((r) => setTimeout(r, 400));
  await runOnce("③ 浮层态·展开左栏");

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
