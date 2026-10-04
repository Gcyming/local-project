/* eslint-disable */
/**
 * gui/scripts/probe-a1175-enter-jerk.mjs —— 窗口化「进入/退出」的**单帧跳变**检测。
 *
 * ## 用户现象（A-1175）
 * 「窗口化那一瞬，有一帧异常抖动、抽搐，只有一帧左右，基本没有」。
 *
 * ## 为什么不能用"方向反转"判据
 * 反转只抓"先变大再变小"；**单帧的一步跳**（几何单调但某一帧位移特别大）它看不见。
 * ⇒ 本探针改用**相邻帧差分**：把每一帧与前一帧的 `|Δleft| / |Δwidth|` 打出来，
 *   超过阈值（默认 20px）的帧就是"跳"。
 * ⚠️ 跳只有在**可见**时才刺眼 ⇒ 每帧同时记 `host` 的 `visibility` / `opacity`，
 *    并只把"可见地跳"标成 ❌（隐藏时的跳是**预期**的 —— A-1174 就是靠藏住它）。
 *
 * ## 前置
 * ⚠️⚠️ 窗口必须 `visibilityState === "visible"`：hidden（最小化/后台）时 Electron
 *    会把 rAF 与 timer 一起停掉、**而且连布局都不更新** ⇒ 采到的全是陈旧值。
 *    本探针拿不到 visible 会**直接退出**，不产出误导性报告。
 * 运行：`SLIME_DEVTOOLS_PORT=<port> node gui/scripts/probe-a1175-enter-jerk.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9446);
const OUT = process.env.SLIME_A1175_OUT || "D:/pilot project/gui/out/_a1175-enter-jerk.txt";
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

/* 列：0 t | 1 rwL 2 rwW | 3 rsL 4 rsW | 5 hostL 6 hostW | 7 mainL 8 mainW | 9 hostVis 10 hostOp | 11 cls */
const ARM = `(() => {
  const R = (el) => { if (!el) { return [null, null]; } const b = el.getBoundingClientRect(); return [b.left, b.width]; };
  window.__ej = { t0: performance.now(), rows: [], raf: 0, ls: [] };
  const tr = window.__ej;
  /* ⚠️ 同时采集 layout-shift（浏览器对"视觉抖动"的官方度量）：
     几何差分抓不到的东西（元素内部重排、文字换行、滚动条进出）它会记下来。
     ⚠️ 本轮的位移是**点击**触发的 ⇒ hadRecentInput 会是 true，但我们**照收**（只标记），
        否则会把要测的那一瞬全过滤掉。 */
  try {
    tr.lso = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        tr.ls.push({
          t: Math.round(e.startTime - tr.t0),
          v: Math.round(e.value * 10000) / 10000,
          recent: e.hadRecentInput ? 1 : 0,
          src: (e.sources || []).map((s) => {
            const pr = s.previousRect || {}, cr = s.currentRect || {};
            const rc = (o) => [Math.round(o.x || 0), Math.round(o.y || 0), Math.round(o.width || 0), Math.round(o.height || 0)];
            return {
              node: s.node ? ((typeof s.node.className === "string" ? s.node.className : "") || s.node.tagName) : "?",
              prev: rc(pr), cur: rc(cr),
              d: [Math.round((cr.x || 0) - (pr.x || 0)), Math.round((cr.y || 0) - (pr.y || 0)),
                Math.round((cr.width || 0) - (pr.width || 0)), Math.round((cr.height || 0) - (pr.height || 0))],
            };
          }).slice(0, 3),
        });
      }
    });
    tr.lso.observe({ type: "layout-shift", buffered: true });
  } catch (e) { tr.lsError = String(e && e.message); }
  /* ⚠️⚠️ 再加一个 ResizeObserver 记录**每一次**尺寸变化：
     rAF 采样（~6ms）会漏掉只存在一帧的中间态 —— 实测 layout-shift 报出
     right-sidebar 一度是 **1638px 宽**（比窗口还宽），而 6ms 采样完全没看见它。
     RO 在**每次布局后**触发 ⇒ 那种「一帧的中间态」也会被记下来。 */
  /* ⚠️ 本模板串内**绝不能用反引号**（连注释里也不行）—— 会直接截断模板串。
     本会话已因此踩了五次 SyntaxError，注释里的专名一律用「」。 */
  tr.ro = [];
  try {
    const rsEl = document.querySelector(".right-sidebar");
    if (rsEl) {
      tr.roObs = new ResizeObserver((ents) => {
        for (const en of ents) {
          const b = en.target.getBoundingClientRect();
          const rwEl = document.querySelector(".right-wrapper");
          tr.ro.push([Math.round(performance.now() - tr.t0), Math.round(b.left), Math.round(b.width),
            (en.target.className || ""), (en.target.style.width || "-"),
            rwEl ? (rwEl.style.getPropertyValue("--right-target-w") || "-") : "-"]);
        }
      });
      const rwEl = document.querySelector(".right-wrapper");
      if (rwEl) { tr.roObs.observe(rwEl); }
      if (rsEl) { tr.roObs.observe(rsEl); }
    }
  } catch (e) { tr.roError = String(e && e.message); }
  const tick = () => {
    const rw = document.querySelector(".right-wrapper");
    const rs = document.querySelector(".right-sidebar");
    const host = document.querySelector(".float-window, .inline-chat-host");
    const main = document.querySelector(".main");
    const rb = document.querySelector(".right-body");
    const a = R(rw), b = R(rs), c = R(host), d = R(main), e2 = R(rb);
    const hcs = host ? getComputedStyle(host) : null;
    tr.rows.push([
      Math.round(performance.now() - tr.t0),
      a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1],
      hcs ? hcs.visibility : "-",
      hcs ? Math.round(Number(hcs.opacity) * 100) / 100 : null,
      host ? (host.className || "") : "-",
      e2[0], e2[1],
      rw ? (rw.style.getPropertyValue("--right-body-pin") || "-") : "-",
      rw ? (rw.className || "") : "-",
      rw ? (rw.style.getPropertyValue("--right-target-w") || "-") : "-",
    ]);
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  return "ARMED vis=" + document.visibilityState;
})()`;

const READ = `JSON.stringify((() => {
  const tr = window.__ej;
  cancelAnimationFrame(tr.raf);
  if (tr.lso) { try { tr.lso.disconnect(); } catch (e) { /* */ } }
  if (tr.roObs) { try { tr.roObs.disconnect(); } catch (e) { /* */ } }
  return { total: tr.rows.length, rows: tr.rows, ls: tr.ls, ro: tr.ro, lsError: tr.lsError || null };
})())`;

const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO-BTN"; }
  (img.closest("button") || img.parentElement || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

/* 列名 + 索引（几何列两两一组：L / W） */
const GEO = [
  ["rw", 1], ["rs", 3], ["host", 5], ["main", 7],
];
const THRESH = Number(process.env.SLIME_A1175_THRESH || 20);

function detect(rows) {
  const jumps = [];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], c = rows[i];
    for (const [name, idx] of GEO) {
      const dl = Math.abs(c[idx] - p[idx]);
      const dw = Math.abs(c[idx + 1] - p[idx + 1]);
      const d = Math.max(dl, dw);
      if (d > THRESH) {
        jumps.push({ t: c[0], name, dl: Math.round(c[idx] - p[idx]), dw: Math.round(c[idx + 1] - p[idx + 1]),
          vis: c[9], op: c[10], cls: c[11], from: [Math.round(p[idx]), Math.round(p[idx + 1])], to: [Math.round(c[idx]), Math.round(c[idx + 1])] });
      }
    }
  }
  return jumps;
}

function report(rows, label, ls, ro) {
  say(`\n═══ ${label} ═══`);
  if (!rows.length) { say("  ❌ 0 帧 —— 采样器没跑起来（窗口 hidden？）"); return; }
  const dt = rows.map((r, i) => (i ? r[0] - rows[i - 1][0] : 0)).slice(1);
  const sorted = [...dt].sort((a, b) => a - b);
  say(`  共 ${rows.length} 帧 · 帧间隔 p50=${sorted[Math.floor(sorted.length * 0.5)]}ms p95=${sorted[Math.floor(sorted.length * 0.95)]}ms max=${sorted[sorted.length - 1]}ms`);
  const jumps = detect(rows);
  const visibleJumps = jumps.filter((j) => j.vis === "visible" && (j.op === null || j.op > 0.05));
  say(`  📐 单帧变化 > ${THRESH}px 的共 ${jumps.length} 处（其中**可见**的 ${visibleJumps.length} 处）`);
  say("  t(ms)  元素  Δleft  Δwidth   可见性      从 → 到            cls");
  for (const j of jumps) {
    const vis = (j.vis === "visible" && (j.op === null || j.op > 0.05)) ? "❗可见" : "  隐藏";
    say(`  ${String(j.t).padStart(5)}  ${j.name.padEnd(5)} ${String(j.dl).padStart(5)} ${String(j.dw).padStart(7)}   ${vis}    `
      + `${JSON.stringify(j.from)} → ${JSON.stringify(j.to)}   "${j.cls}"`);
  }
  say(visibleJumps.length === 0
    ? "  ✅ **没有可见的单帧跳变**"
    : `  ❌ 有 ${visibleJumps.length} 处**可见**的单帧跳变 —— 那就是用户看到的「一帧抽搐」`);
  /* 关键窗口的时间线：0~320ms 的**变化点**（去重）—— 覆盖整段过渡（不只开头）。 */
  say("  🔍 点后 0~320ms 变化点：");
  let last = "";
  for (const r of rows) {
    if (r[0] > 320) { break; }
    const k = [r[1], r[2], r[3], r[4], r[12], r[13], r[14], r[15], r[16]].map((v) => typeof v === "number" ? Math.round(v) : v).join(",");
    if (k === last) { continue; }
    last = k;
    say(`      ${String(r[0]).padStart(4)}ms rw=${Math.round(r[1])}+${Math.round(r[2])} rs=${Math.round(r[3])}+${Math.round(r[4])} `
      + `rb=${Math.round(r[12])}+${Math.round(r[13])} pin=${r[14]} tgt=${r[16]} host=${Math.round(r[5])}+${Math.round(r[6])} vis=${r[9]} rwCls="${r[15]}"`);
  }
  /* layout-shift：浏览器对"视觉抖动"的官方度量。几何差分抓不到的元素内部重排/换行/滚动条进出，它会记下来。 */
  say(`  📉 layout-shift（${(ls || []).length} 条）：`);
  if (!(ls || []).length) { say("      （无）"); }
  for (const e of (ls || [])) {
    say(`      t=${String(e.t).padStart(5)}ms  value=${e.v}  ${e.recent ? "点击后窗口内" : "非输入"}  来源=${JSON.stringify(e.src)}`);
  }
  /* ResizeObserver 的每一次尺寸记录 —— 只打"宽度变化 > 8px"的，那些是抖动候选。 */
  const roAll = ro || [];
  const roJumps = [];
  for (let i = 1; i < roAll.length; i++) {
    const p = roAll[i - 1], c = roAll[i];
    if (Math.abs(c[2] - p[2]) > 8) { roJumps.push({ t: c[0], from: p[2], to: c[2], cls: c[3], inline: c[4], tgt: c[5] }); }
  }
  say(`  📏 ResizeObserver：共 ${roAll.length} 次尺寸变化，其中宽度突变(>8px) ${roJumps.length} 处：`);
  for (const j of roJumps) {
    say(`      t=${String(j.t).padStart(5)}ms  宽 ${j.from} → ${j.to}  (Δ${j.to - j.from})  cls="${j.cls}" inlineW="${j.inline}" tgtW="${j.tgt}"`);
  }
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  /* A-1178：把 viewport 钉到 1332×850 —— 抖动是"窗口越宽、右栏普通态与浮层态差值越大"越明显，
     1332 是复现的确定性窗口（普通态右栏窄条 vs 浮层态铺满，跳变 ~1000px）。 */
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1332, height: 850, deviceScaleFactor: 1, mobile: false });
  } catch { /* 老版本无此命令 */ }
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));
  const vis = await cdp.eval("document.visibilityState");
  say(`  visibilityState=${vis}`);
  if (vis !== "visible") { say("❌ 窗口不可见 ⇒ 布局不更新、采样全假。先把 slime 窗口恢复/置前再跑。"); process.exit(1); }

  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      gate: !!document.querySelector('img[alt="唤起悬浮窗"]'),
      sb: !!document.querySelector(".sidebar"),
      rw: !!document.querySelector(".right-wrapper"),
    })`));
    if (st.gate && st.sb && st.rw) { ready = true; say(`✅ 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未等到就绪元素"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));

  const once = async (label) => {
    say(`\n[ARM] ${await cdp.eval(ARM)}`);
    await cdp.eval(CLICK_FLOAT);
    await new Promise((r) => setTimeout(r, 1600));
    const o = JSON.parse(await cdp.eval(READ));
    if (o.lsError) { say(`  ⚠️ layout-shift 采集失败：${o.lsError}`); }
    report(o.rows, label, o.ls, o.ro);
  };

  await once("① 进入窗口化");
  await new Promise((r) => setTimeout(r, 500));
  await once("② 退出窗口化");

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
