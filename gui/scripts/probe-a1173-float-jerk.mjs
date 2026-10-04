/* eslint-disable */
/**
 * gui/scripts/probe-a1173-float-jerk.mjs —— 窗口化「进入 / 退出」期间右栏的逐帧几何取证。
 *
 * ## 用户现象（问题 1）
 * 「聊天界面窗口化以及窗口化退出时，右侧边栏的自动调整期间总是会发生抽搐、闪动」。
 *
 * ## 判据
 * 每一条几何曲线（右栏容器 / 右栏本体 / 浮窗宿主 / 主区）在过渡期间应**单调**。
 * 任何**方向反转**（先变大再变小 / 位置来回）都会被人眼读成"抽搐"；
 * 而 `opacity` 的非单调或"复位跳变"会读成"闪动"。
 * ⇒ 逐帧记录全部列，逐列统计反转次数与反转时刻，再对照时间线找源头。
 *
 * 运行：`node gui/scripts/probe-a1173-float-jerk.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1173J_OUT || "D:/pilot project/gui/out/_a1173-jerk.txt";
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

/* 列：t | rwL rwW | rsL rsW | hostL hostW | mainL mainW | rwOp rsOp | classes */
const ARM = `(() => {
  const rw = document.querySelector(".right-wrapper");
  const rs = document.querySelector(".right-sidebar");
  const main = document.querySelector(".main");
  window.__jk = { t0: 0, rows: [] };
  const tr = window.__jk;
  const R = (e) => { if (!e) { return [null, null]; } const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
  const tick = () => {
    const now = performance.now();
    const host = document.querySelector(".float-window, .inline-chat-host");
    const a = R(rw), b = R(rs), c = R(host), d = R(main);
    const rwCs = rw ? getComputedStyle(rw) : null;
    const rsCs = rs ? getComputedStyle(rs) : null;
    const hostCs = host ? getComputedStyle(host) : null;
    tr.rows.push([
      Math.round(now - tr.t0),
      a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1],
      rwCs ? Math.round(Number(rwCs.opacity) * 1000) / 1000 : null,
      rsCs ? Math.round(Number(rsCs.opacity) * 1000) / 1000 : null,
      host ? (host.className || "") : "-",
      rw ? (rw.className || "") : "-",
      /* ⚠️ 宿主自身的 opacity 与 visibility（关键：切换那一刻它若已不可见，则几何突变**看不见**）。
         visibility: hidden 在 computed opacity 上**看不出来**（仍是 1）⇒ 必须单独采一列。 */
      hostCs ? Math.round(Number(hostCs.opacity) * 1000) / 1000 : null,
      hostCs ? hostCs.visibility : null,
      /* 内层包裹层（floatInnerRef）的 opacity */
      (() => { const fi = host ? host.firstElementChild : null; return fi ? Math.round(Number(getComputedStyle(fi).opacity) * 1000) / 1000 : null; })(),
    ]);
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  return "ARMED";
})()`;

const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO-BTN"; }
  (img.closest("button") || img.parentElement || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

const READ = `JSON.stringify((() => {
  const tr = window.__jk;
  cancelAnimationFrame(tr.raf);
  return { total: tr.rows.length, rows: tr.rows };
})())`;

const COLS = [
  ["rwL", 1], ["rwW", 2], ["rsL", 3], ["rsW", 4],
  ["hostL", 5], ["hostW", 6], ["mainL", 7], ["mainW", 8],
  ["rwOp", 9], ["rsOp", 10],
];

function analyze(rows) {
  const out = [];
  for (const [name, idx] of COLS) {
    const marks = []; let last = null;
    for (const r of rows) {
      const v = r[idx];
      if (v === null) { continue; }
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
    out.push({ name, rev, at: at.slice(0, 8), first: marks[0] || null, last: marks[marks.length - 1] || null, points: marks.length });
  }
  return out;
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
  /* ⚠️⚠️⚠️ 窗口 hidden（最小化/后台）时 Electron 把 rAF 与 timer 一起停掉，
     而且**连布局都不更新**（`getBoundingClientRect()` 返回陈旧值）⇒ 采样全假。
     ⇒ 拿不到 visible 就直接退出，绝不产出误导性的报告。
     （`Browser.getWindowForTarget` 在 Electron 里不可用，所以这里只能校验、不能恢复 ——
       若报 hidden，请把 slime 窗口恢复/置前后重跑。） */
  const vis = await cdp.eval("document.visibilityState");
  say(`  visibilityState=${vis}`);
  if (vis !== "visible") { say("❌ 窗口不可见 ⇒ 布局不更新、采样全假。先把 slime 窗口恢复/置前再跑。"); process.exit(1); }
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ btn: !!document.querySelector('img[alt="唤起悬浮窗"]') })`));
    if (st.btn) { say(`✅ 启动门（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  await new Promise((r) => setTimeout(r, 1500));

  const once = async (label) => {
    await cdp.eval(ARM);
    await cdp.eval(CLICK_FLOAT);
    await new Promise((r) => setTimeout(r, 1800));
    const o = JSON.parse(await cdp.eval(READ));
    say(`\n═══ ${label}（${o.total} 帧）═══`);
    const an = analyze(o.rows);
    let totalRev = 0;
    say("  列      反转  变化点   起点 → 终点");
    for (const a of an) {
      totalRev += a.rev;
      say(`  ${a.name.padEnd(7)} ${String(a.rev).padStart(3)}  ${String(a.points).padStart(5)}   ${JSON.stringify(a.first)} → ${JSON.stringify(a.last)}`
        + (a.at.length ? `  ⚠️ 反转于 ${a.at.join("/")}ms` : ""));
    }
    say(`  ⇒ 合计方向反转：${totalRev} 次${totalRev === 0 ? "（✅ 全程单调）" : "（❌ 有抽搐）"}`);
    /* 时间线（只打"几何或类名变了"的行） */
    /* 时间线：打「前 12 + 后 30」个变化点 —— 关键窗口在**切换那一刻**（尾部）。 */
    const marks = []; let last = "";
    for (const r of o.rows) {
      const k = r.slice(1).join(",");
      if (k !== last) {
        marks.push(`${String(r[0]).padStart(5)}ms rw=${r[1]}+${r[2]} rs=${r[3]}+${r[4]} host=${r[5]}+${r[6]} `
          + `hostOp=${r[13]} hostVis=${r[14]} fiOp=${r[15]} main=${r[7]}+${r[8]} cls="${r[11]}" rwCls="${r[12]}"`);
        last = k;
      }
    }
    const shown = marks.length <= 60 ? marks : [...marks.slice(0, 20), `      …（略过 ${marks.length - 45} 个）…`, ...marks.slice(-25)];
    say(`  🔍 时间线（${marks.length} 个变化点）：`);
    for (const m of shown) { say("      " + m); }
  };

  await once("① 进入窗口化");
  await new Promise((r) => setTimeout(r, 600));
  await once("② 退出窗口化");

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
