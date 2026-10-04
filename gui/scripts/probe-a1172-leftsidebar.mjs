/* eslint-disable */
/**
 * gui/scripts/probe-a1172-leftsidebar.mjs —— 左侧边栏「折叠 / 展开」逐帧取证。
 *
 * 用户报：「我自己改动的时候出了点问题，左侧边栏的折叠与展开功能出现异常了」。
 *
 * 判据（每一帧都记，不只看稳态）：
 *   · 左栏 left/width、`.body` / `main` / `.right-wrapper` 的 left/width
 *   · 内联 width / 内联 flexShrink / **计算** flexShrink / 计算 minWidth
 *   · opacity、`collapsed` 类、`sidebar-no-min` 类
 * ⇒ 折叠/展开应当只有「宽度平滑变化」一条曲线；任何 width 反向、min-width 卡住、
 *    flex 收缩把宽度压过 width 属性，都在这里显形。
 *
 * 前置：`cd gui && SLIME_DEVTOOLS_PORT=9444 env -u ELECTRON_RUN_AS_NODE \
 *        ./node_modules/electron/dist/electron.exe .`
 * 运行：`node gui/scripts/probe-a1172-leftsidebar.mjs`
 */
import fs from "node:fs";

const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1170_OUT || "D:/pilot project/gui/out/_a1172-left.txt";
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) { return page; }
    } catch { /* 还没起来 */ }
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
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        if (msg.error) { rej(new Error(JSON.stringify(msg.error))); } else { res(msg.result); }
      }
    };
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

/* ── 逐帧采样器（页内 rAF，批量读，一次性读回） ── */
const ARM = `(() => {
  const sb = document.querySelector(".sidebar");
  const bodyEl = document.querySelector(".body");
  const mainEl = document.querySelector(".main");
  const rw = document.querySelector(".right-wrapper");
  window.__ls = { t0: 0, rows: [] };
  const tr = window.__ls;
  const R = (e) => { if (!e) { return [null, null]; } const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
  const tick = () => {
    const now = performance.now();
    const cs = sb ? getComputedStyle(sb) : null;
    const a = R(sb), b2 = R(bodyEl), c = R(mainEl), d = R(rw);
    tr.rows.push([
      Math.round(now - tr.t0),
      a[0], a[1], b2[0], b2[1], c[0], c[1], d[0], d[1],
      sb ? (sb.style.width || "-") : null,
      sb ? (sb.style.flexShrink || "-") : null,
      cs ? cs.flexShrink : null,
      cs ? cs.minWidth : null,
      cs ? Math.round(Number(cs.opacity) * 100) : null,
      sb ? (sb.classList.contains("collapsed") ? "C" : "-") : null,
      sb ? (sb.classList.contains("sidebar-no-min") ? "M" : "-") : null,
      sb ? (sb.className || "") : null,
    ]);
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  return "ARMED";
})()`;

const CLICK_LEFT = `(() => {
  const btns = Array.from(document.querySelectorAll("header.titlebar button, .titlebar button"));
  const t = btns.find((b) => /侧栏|侧边栏/.test(b.getAttribute("title") || ""));
  if (!t) { return "NO-BTN:" + btns.map((b) => b.getAttribute("title")).slice(0, 10).join("|"); }
  const sb = document.querySelector(".sidebar");
  const before = (t.getAttribute("title") || "?") + "|collapsed=" + (sb ? sb.classList.contains("collapsed") : "?");
  t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "CLICKED(" + before + ")";
})()`;

const READ = `JSON.stringify((() => {
  const tr = window.__ls;
  cancelAnimationFrame(tr.raf);
  return { total: tr.rows.length, rows: tr.rows };
})())`;

/* 把逐帧行压成「变化点」，并做方向反转分析 */
function analyze(rows, keys) {
  const HEAD = ["t", "sbL", "sbW", "bodyL", "bodyW", "mainL", "mainW", "rwL", "rwW"];
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const off = 1 + i * 2;
    const marks = [];
    let last = null;
    for (const r of rows) {
      const l = r[off], w = r[off + 1];
      if (l === null) { continue; }
      if (last === null || last[0] !== l || last[1] !== w) { marks.push([r[0], l, w]); last = [l, w]; }
    }
    let dir = 0, reversals = 0; const revAt = [];
    for (let k = 1; k < marks.length; k++) {
      const d = (marks[k][1] - marks[k - 1][1]) + (marks[k][2] - marks[k - 1][2]);
      if (Math.abs(d) < 2) { continue; }
      const nd = Math.sign(d);
      if (dir !== 0 && nd !== dir) { reversals++; revAt.push(marks[k][0]); }
      dir = nd;
    }
    out.push({ key: keys[i], points: marks.length, reversals, revAt: revAt.slice(0, 6), first: marks[0] || null, last: marks[marks.length - 1] || null });
  }
  return out;
}

async function main() {
  const t = await getTarget();
  say(`CDP 目标：${t.title}`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  say("重载页面以获得干净初始态…");
  await cdp.send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 4500));
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  /* 等启动门 */
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      btn: !!document.querySelector('img[alt="唤起悬浮窗"]'),
      sb: !!document.querySelector(".sidebar"),
    })`));
    if (st.btn && st.sb) { ready = true; say(`✅ 启动门已过（第 ${i + 1} 次轮询）`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!ready) { say("❌ 未等到启动门。sidebar 文本：" + (await cdp.eval(`(document.querySelector(".sidebar")?.textContent||"").slice(0,160)`))); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1200));

  const runOnce = async (label, ms) => {
    say(`\n═══ ${label} ═══`);
    say("  装采样器=" + (await cdp.eval(ARM)));
    say("  点击=" + (await cdp.eval(CLICK_LEFT)));
    await new Promise((r) => setTimeout(r, ms));
    const o = JSON.parse(await cdp.eval(READ));
    const rows = o.rows;
    say(`  共 ${o.total} 帧`);
    const keys = ["sb", "body", "main", "rw"];
    const an = analyze(rows, keys);
    for (const a of an) {
      say(`  📐 ${a.key.padEnd(5)} ${String(a.reversals).padStart(3)} 次反转 · ${String(a.points).padStart(3)} 点 · ${JSON.stringify(a.first)} → ${JSON.stringify(a.last)}` +
        (a.revAt.length ? ` · 反转于 ${a.revAt.join("/")}ms` : ""));
    }
    /* 取「几何/状态有任何变化」的那些帧，人眼读时间线 */
    const marks = [];
    let last = "";
    for (const r of rows) {
      const k = r.slice(1, 10).join(",") + "|" + r[9] + "|" + r[10] + "|" + r[11] + "|" + r[12] + "|" + r[13] + "|" + r[14];
      if (k !== last) {
        marks.push(`${String(r[0]).padStart(5)}ms sb=${r[1]}+${r[2]} body=${r[3]}+${r[4]} main=${r[5]}+${r[6]} rw=${r[7]}+${r[8]} inlineW=${r[9]} inlineShrink=${r[10]} calcShrink=${r[11]} calcMinW=${r[12]} op=${r[13]}% ${r[14]}${r[15]}`);
        last = k;
      }
    }
    say("  🔍 变化点时间线：");
    for (const m of marks.slice(0, 30)) { say("      " + m); }
    /* 终态 */
    const fin = rows[rows.length - 1];
    say(`  🏁 终态：sb=${fin[1]}+${fin[2]} body=${fin[3]}+${fin[4]} main=${fin[5]}+${fin[6]} rw=${fin[7]}+${fin[8]} inlineW=${fin[9]} inlineShrink=${fin[10]} calcShrink=${fin[11]} calcMinW=${fin[12]} class="${fin[16]}"`);
  };

  await runOnce("① 折叠左栏（点标题栏按钮）", 2600);
  await new Promise((r) => setTimeout(r, 600));
  await runOnce("② 展开左栏（再点一次）", 2600);

  say("\n=== 完成 ===");
  process.exit(0);
}

main().catch((e) => { say("❌ 异常：" + e.message); process.exit(1); });
