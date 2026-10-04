/* eslint-disable */
/**
 * gui/scripts/probe-a1180-visible-hole.mjs —— 窗口化「进入」瞬间的**可见空白**检测。
 *
 * ## 为什么不用几何判据（A-1178 踩过的坑）
 * `layout-shift` 度量"元素移动了"，**与用户是否看得见无关** —— 它连**无背景**的容器都算。
 * 本仓 `.right-wrapper` / `.right-sidebar` **都没有背景**（底色 = `.app` 的 `var(--bg)`），
 * 所以那些几何位移**用户看不见**（A-1178 因此修错方向，反而引入一帧黑屏）。
 *
 * ## 本探针的判据：**"那一处到底有没有东西"**
 * 沿右栏区域横向扫一排采样点，每点用 `document.elementFromPoint` 问"你那儿是什么"：
 *   · 命中 `.right-sidebar` 内的元素 ⇒ **有内容**（用户看得见）
 *   · 命中 `.app` / `body` / 根⇒ **空白**（底色露出来 = 用户看见的洞）
 * 逐帧统计"空白段"的水平范围与面积 ⇒ 这才是**可见**的黑屏/闪。
 *
 * 运行：`SLIME_DEVTOOLS_PORT=<port> node gui/scripts/probe-a1180-visible-hole.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9461);
const OUT = process.env.SLIME_A1180_OUT || "D:/pilot project/gui/out/_a1180-hole.txt";
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

/* ⚠️ 本模板串内**绝不能用反引号**（连注释里也不行）—— 会直接截断模板串。 */
const ARM = `(() => {
  const rs = document.querySelector(".right-sidebar");
  const rw = document.querySelector(".right-wrapper");
  const host = document.querySelector(".float-window, .inline-chat-host");
  const t0 = performance.now();
  /* 采样点：右栏区域的横向一排（y 取窗口 42% 处，避开标题栏与顶部 tab） */
  const y = Math.round(window.innerHeight * 0.42);
  const N = 64;
  const x0 = Math.round(window.innerWidth * 0.30), x1 = window.innerWidth - 2;
  const rows = [];
  let raf = 0;
  const isBg = (el) => {
    if (!el) { return true; }
    const cn = typeof el.className === "string" ? el.className : "";
    return el === document.body || el === document.documentElement
      || (el.id === "root") || cn === "app" || cn === "";
  };
  const tick = () => {
    let holes = 0, firstHole = -1, lastHole = -1;
    for (let i = 0; i < N; i++) {
      const x = Math.round(x0 + (x1 - x0) * (i + 0.5) / N);
      const el = document.elementFromPoint(x, y);
      const hole = isBg(el);
      if (hole) { holes++; if (firstHole < 0) { firstHole = x; } lastHole = x; }
    }
    const a = rw ? rw.getBoundingClientRect() : null;
    const b = rs ? rs.getBoundingClientRect() : null;
    const hcs = host ? getComputedStyle(host) : null;
    rows.push([
      Math.round(performance.now() - t0), y, x0, x1, N,
      holes, firstHole, lastHole,
      a ? Math.round(a.left) : null, a ? Math.round(a.width) : null,
      b ? Math.round(b.left) : null, b ? Math.round(b.width) : null,
      hcs ? hcs.visibility : "-",
      /* 右栏内容区里有没有可见像素（抽样 3 点，避开文字行） */
      (() => {
        if (!rs) { return -1; }
        const rb = rs.getBoundingClientRect();
        let solid = 0;
        for (const f of [0.25, 0.5, 0.75]) {
          const px = Math.round(rb.left + rb.width * f);
          const py = Math.round(window.innerHeight * 0.30);
          if (px < 0 || px >= window.innerWidth) { continue; }
          if (!isBg(document.elementFromPoint(px, py))) { solid++; }
        }
        return solid;
      })(),
      /* ⚠️⚠️ **逐帧在右栏内容区内部取样**（A-1180 的关键判据）：
         固定横带会一直命中「右栏本来就空的那一带」（稳态基线 41~42 点）⇒ 淹没真正的抖动。
         这里跟着 rs 的实际盒子走，并只统计「本该有内容却是空的」那些点：
         即采样点在 rs 的**水平范围内**，但 elementFromPoint 命中的却是 .app/body 底色。
         ⇒ 正常内容稀疏处（如消息行之间）不算，只有「整块背景裸露」才算。
         ⚠️ 本模板串内绝不能用反引号（连注释里也不行）—— 会直接截断模板串。 */
      (() => {
        if (!rs) { return -1; }
        const rb = rs.getBoundingClientRect();
        let empty = 0, sampled = 0;
        const xs = [0.06, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94];
        for (const f of xs) {
          const px = Math.round(rb.left + rb.width * f);
          if (px < 0 || px >= window.innerWidth || rb.width < 20) { continue; }
          sampled++;
          const el = document.elementFromPoint(px, y);
          if (isBg(el)) { empty++; }
        }
        return sampled === 0 ? -1 : empty * 100 / sampled;   // 百分比，避免采样数差异
      })(),
    ]);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  window.__vh = { stop: () => cancelAnimationFrame(raf), rows: rows };
  return "ARMED y=" + y + " x0=" + x0 + " x1=" + x1 + " N=" + N;
})()`;

const READ = `JSON.stringify((() => {
  const t = window.__vh;
  t.stop();
  return { rows: t.rows };
})())`;

const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO"; }
  (img.closest("button") || img.parentElement || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

function report(rows, label) {
  say(`\n═══ ${label} ═══`);
  if (!rows.length) { say("  ❌ 0 帧"); return; }
  say(`  采样：y=${rows[0][1]}，x ∈ [${rows[0][2]}, ${rows[0][3]}]，${rows[0][4]} 个点`);
  say(`  共 ${rows.length} 帧`);
  /* ⚠️ 判据：以**稳态基线**为参照，而不是绝对值。
     固定横带在右栏"本来就空"的那一带恒为 41~42 点（那是正常的）⇒ 只有**超出基线**的部分是抖动。 */
  const col = (r) => r[14];   // 右栏内容区内部的"空点百分比"
  const vals = rows.map(col).filter((v) => v >= 0);
  const base = vals.slice(-8).reduce((a, b) => a + b, 0) / Math.max(1, vals.slice(-8).length);
  const over = rows.map((r) => ({ t: r[0], v: col(r), rwL: r[8], rwW: r[9], rsL: r[10], rsW: r[11], vis: r[12] }))
    .filter((x) => x.v >= 0 && x.v > base + 12);
  say(`  稳态基线（右栏内部空点率）= ${base.toFixed(0)}%　｜　过渡期峰值 = ${Math.max(...vals).toFixed(0)}%`);
  say(`  ⚠️ 判据：**超出基线 12 个百分点**才算「用户看得见的空洞」`);
  if (over.length === 0) {
    say(`  ✅ **全程无超出基线的空洞** ⇒ 右栏内部没有"该有内容却是空的"那一帧`);
  } else {
    say(`  ❌ 有 ${over.length} 帧超出基线：`);
    for (const x of over.slice(0, 14)) {
      say(`      ${String(x.t).padStart(5)}ms  空点率=${x.v.toFixed(0)}%  rw=${x.rwL}+${x.rwW}  rs=${x.rsL}+${x.rsW}  hostVis=${x.vis}`);
    }
  }
  /* 时间线（原始两列 + 新的空点率） */
  say("  🔍 逐帧（t / 固定横带空白数 / 右栏内部空点率 / rw / rs / host可见）：");
  let lastKey = "";
  for (const r of rows) {
    const key = [r[5], Math.round(col(r) / 5), r[8], r[9], r[10], r[11], r[12]].join(",");
    if (key === lastKey) { continue; }
    lastKey = key;
    say(`      ${String(r[0]).padStart(5)}ms  横带=${String(r[5]).padStart(2)}  内部空点率=${String(Math.round(col(r))).padStart(3)}%  rw=${r[8]}+${r[9]}  rs=${r[10]}+${r[11]}  ${r[12]}`);
  }
}

/* ⚠️⚠️ A-1180：**双采样**捕捉 <1 帧的跳变（rAF + ResizeObserver）。
   rAF 采样（~6ms）会漏掉只存在一帧的中间态；而 RO 在**每次布局后**触发。
   两路合并后逐帧比对：**同一元素相邻两次采样的屏幕矩形差> 4px** 且**不是单调渐变**
   ⇒ 判为「跳变」，再检查那一帧它是否**可见**（落在有背景的链路里）。 */
const JUMP = `(() => {
  const R = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const els = {
    sb: document.querySelector(".sidebar"),
    main: document.querySelector(".main"),
    host: document.querySelector(".float-window, .inline-chat-host"),
    rw: document.querySelector(".right-wrapper"),
    rs: document.querySelector(".right-sidebar"),
    rb: document.querySelector(".right-body"),
  };
  window.__vj = { t0: performance.now(), raf: 0, ro: [], snap: [] };
  const t = window.__vj;
  const snap = (tag) => {
    const o = { t: Math.round(performance.now() - t.t0), tag: tag };
    for (const k of Object.keys(els)) { o[k] = R(els[k]); }
    /* 右栏内容区里"有东西"的采样点（跟随 rs 走） */
    let empty = -1;
    if (o.rs) {
      let e = 0, n = 0;
      for (const f of [0.06, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94]) {
        const px = Math.round(o.rs[0] + o.rs[2] * f);
        if (px < 0 || px >= window.innerWidth || o.rs[2] < 20) { continue; }
        n++;
        const el = document.elementFromPoint(px, Math.round(window.innerHeight * 0.42));
        const cn = el ? (typeof el.className === "string" ? el.className : "") : "";
        const bg = !el || el === document.body || el === document.documentElement
          || el.id === "root" || cn === "app" || cn === "";
        if (bg) { e++; }
      }
      empty = n === 0 ? -1 : Math.round(e * 100 / n);
    }
    o.empty = empty;
    t.snap.push(o);
  };
  const tick = () => { snap("raf"); t.raf = requestAnimationFrame(tick); };
  t.raf = requestAnimationFrame(tick);
  /* ResizeObserver 那一路：在每次布局后触发 ⇒ 不漏 <1 帧的中间态 */
  try {
    t.roObs = new ResizeObserver(() => { snap("ro"); });
    for (const k of ["rw", "rs", "rb", "sb"]) { if (els[k]) { t.roObs.observe(els[k]); } }
    t.roObs.observe(document.body);
  } catch (e) { t.roErr = String(e && e.message); }
  return "JUMP-ARMED";
})()`;

const READ_JUMP = `JSON.stringify((() => {
  const t = window.__vj;
  cancelAnimationFrame(t.raf);
  if (t.roObs) { try { t.roObs.disconnect(); } catch (e) { /* */ } }
  return { snap: t.snap, roErr: t.roErr || null };
})())`;

function reportJump(snaps, roErr) {
  say(`\n───跳变检测（双采样：rAF + ResizeObserver）───`);
  if (roErr) { say(`  ⚠️ RO 采集失败：${roErr}`); }
  if (!snaps || snaps.length < 4) { say("  ❌ 采样不足"); return; }
  const KEYS = ["sb", "main", "host", "rw", "rs", "rb"];
  let found = 0;
  for (const k of KEYS) {
    /* 只比较相邻两次采样（同一路），跳过跨路（rAF vs RO 时刻不同 ⇒ 不可比） */
    for (let i = 1; i < snaps.length; i++) {
      const p = snaps[i - 1], c = snaps[i];
      if (p.tag !== c.tag) { continue; }
      if (!p[k] || !c[k]) { continue; }
      const dl = Math.abs(c[k][0] - p[k][0]), dw = Math.abs(c[k][2] - p[k][2]);
      const d = Math.max(dl, dw);
      if (d <= 4) { continue; }
      /* 非单调？比较它与**再上一次**的方向 */
      const q = i >= 2 && snaps[i - 2][k] && snaps[i - 2].tag === p.tag ? snaps[i - 2][k] : null;
      const prevD = q ? c[k][0] - q[k][0] : null;
      const curD = c[k][0] - p[k][0];
      const rev = prevD !== null && Math.sign(prevD) !== 0 && Math.sign(curD) !== 0 && Math.sign(prevD) !== Math.sign(curD);
      /* 可见性：宿主在那一帧是否可见（不可见 ⇒ 用户看不见） */
      const hostVis = snaps[i].host && c.host ? null : null;
      say(`  ${rev ? "❗方向反转" : "⚠️ 单帧跳变"} ${k.padEnd(5)} t=${String(c.t).padStart(4)}ms (${p.tag}) Δleft=${String(curD).padStart(6)} Δwidth=${String(c[k][2] - p[k][2]).padStart(6)}`
        + `  空点率=${c.empty}%  hostVisible=${c.host && snaps[i].hostVis}`);
      found++;
      if (found > 40) { say("  （过多，已截断）"); return; }
    }
  }
  say(found === 0 ? "  ✅ 双采样下未捕捉到任何 >4px 的单帧跳变" : `  共 ${found} 处，详见上`);
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  for (let i = 0; i < 12; i++) {
    try { await cdp.send("Page.bringToFront"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 500));
    if (await cdp.eval("document.visibilityState") === "visible") { say(`  ✅ 第 ${i + 1} 次 bringToFront 后可见`); break; }
  }
  if (await cdp.eval("document.visibilityState") !== "visible") { say("❌ 窗口仍不可见 ⇒ 请手动置前。"); process.exit(1); }
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));
  for (let i = 0; i < 12; i++) {
    try { await cdp.send("Page.bringToFront"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
    if (await cdp.eval("document.visibilityState") === "visible") { break; }
  }
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ gate: !!document.querySelector('img[alt="唤起悬浮窗"]'), rw: !!document.querySelector(".right-wrapper") })`));
    if (st.gate && st.rw) { ready = true; say(`✅ 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未就绪"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));

  const once = async (label) => {
    say(`\n[ARM] ${await cdp.eval(ARM)}`);
    await cdp.eval(CLICK_FLOAT);
    await new Promise((r) => setTimeout(r, 1800));
    const o = JSON.parse(await cdp.eval(READ));
    report(o.rows, label);
  };
  await once("① 进入窗口化");
  await new Promise((r) => setTimeout(r, 500));
  await once("② 退出窗口化");

  /* ---- 跳变检测（只对"进入"做一次，避免两次混在一起） ---- */
  if (await cdp.eval("document.querySelector('.float-window') ?1:0") === 1) {
    await cdp.eval(CLICK_FLOAT);           /* 先退回普通态 */
    await new Promise((r) => setTimeout(r, 1800));
  }
  say(`\n[ARM-JUMP] ${await cdp.eval(JUMP)}`);
  await cdp.eval(CLICK_FLOAT);
  await new Promise((r) => setTimeout(r, 1800));
  const j = JSON.parse(await cdp.eval(READ_JUMP));
  reportJump(j.snap, j.roErr);

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
