/* eslint-disable */
/**
 * gui/scripts/probe-sidebar-e2e-cdp.mjs — 右栏×对话页**端到端序列**取证（A-1154）。
 *
 * ## 为什么是这条路
 * 前两个探针都**量不到用户看到的东西**：
 *  · `probe-float-transition.cjs` —— 自己造 DOM，量的是"布局规则对不对"；
 *  · `probe-float-realclick.cjs` —— 只点一次窗口化，且**没有主进程/preload**
 *    （renderer 拿不到 IPC ⇒ 会话列表为空 ⇒ ChatPanel 不挂载 ⇒ 按钮根本不存在 ⇒ 它 40 轮轮询后
 *     报的是"没等到按钮"，那 7 个现象一个都复现不到）。
 * ⇒ 本脚本连**真 App**（真主进程 + 真 IPC + 真会话数据），通过 CDP 驱动 renderer，
 *   严格按用户原话把那串操作走一遍，每步逐帧采样几何与状态类。
 *
 * 前置：另开终端启动真 App
 *   cd gui && SLIME_DEVTOOLS_PORT=9333 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
 * 运行：
 *   node gui/scripts/probe-sidebar-e2e-cdp.mjs
 */
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9333);
const OUT = process.env.SLIME_E2E_OUT || "D:/pilot project/gui/out/_sidebar-e2e.txt";
import fs from "node:fs";

const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 30; i++) {
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

const SNAP = `window.__snap = function () {
  const vw = window.innerWidth, vh = window.innerHeight;
  const R = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const body = document.querySelector(".body");
  const rs = document.querySelector(".right-sidebar");
  const rw = document.querySelector(".right-wrapper");
  const cs = rs ? getComputedStyle(rs) : null;
  const rws = rw ? getComputedStyle(rw) : null;
  const mainEl = document.querySelector("main.main");
  return {
    vw, vh,
    cls: Array.from(document.body.classList).filter((c) => c.startsWith("float") || c.startsWith("slime")).join("|"),
    main: R(mainEl), fw: R(document.querySelector(".float-window")),
    rs: R(rs), rw: R(rw),
    rsInlineW: rs ? rs.style.width || "" : "",
    rsW: cs ? cs.width : "",
    rsTrans: cs ? (cs.transitionProperty + "/" + cs.transitionDuration) : "",
    tgtW: cs ? cs.getPropertyValue("--right-target-w").trim() : "",
    bodyPin: cs ? cs.getPropertyValue("--right-body-pin").trim() : "",
    rwFlex: rws ? rws.flexShrink : "",
    rwInlineW: rw ? rw.style.width || "" : "",
    rwTrans: rws ? (rws.transitionProperty + "/" + rws.transitionDuration) : "",
    fwTrans: (() => { const f = document.querySelector(".float-window"); return f ? getComputedStyle(f).transitionProperty + "/" + getComputedStyle(f).transitionDuration : ""; })(),
    resizer: document.querySelectorAll(".right-sidebar-resizer").length,
    floatBtn: !!document.querySelector('img[alt="唤起悬浮窗"]'),
    mainFloatClass: mainEl ? mainEl.className : "",
  };
};
"__ready__";`;

/* 逐帧采样：在页面内跑 rAF，收集到 window.__samples
   ⚠️ 必须有 setTimeout 兜底：窗口被系统判定不可见/被限流时 rAF 可能停摆 ⇒ Promise 永不 resolve
   （真机实测卡死）。兜底只保证"一定返回"，帧数会少但不影响判据。 */
const SAMPLER = `window.__sample = function (ms) {
  return new Promise((res) => {
    const out = []; const t0 = performance.now();
    let settled = false;
    const finish = () => { if (!settled) { settled = true; res(JSON.stringify(out)); } };
    const tick = () => {
      out.push(window.__snap());
      if (performance.now() - t0 < ms) { requestAnimationFrame(tick); }
      else { finish(); }
    };
    requestAnimationFrame(tick);
    setTimeout(finish, ms + 2500);
  });
}; "__ready__";`;

function diffFrames(label, s) {
  say(`── ${label}｜${s.length} 帧 ──`);
  let prev = null, printed = 0;
  for (let i = 0; i < s.length; i++) {
    const f = s[i];
    const key = JSON.stringify([f.cls, f.main, f.fw, f.rs, f.rw, f.rsInlineW, f.tgtW, f.bodyPin, f.rwFlex, f.rwInlineW, f.resizer, f.mainFloatClass]);
    if (key === prev) { continue; }
    prev = key; printed++;
    if (printed > 20) { say(`   …（省略后续 ${s.length - i} 帧）`); break; }
    say(`  f${String(i).padStart(3)} cls=[${f.cls}] mainFloat="${f.mainFloatClass}"`);
    say(`        main=${JSON.stringify(f.main)} fw=${JSON.stringify(f.fw)} rs=${JSON.stringify(f.rs)} rw=${JSON.stringify(f.rw)}`);
    say(`        rsInlineW="${f.rsInlineW}" rsW=${f.rsW} rwInlineW="${f.rwInlineW}" rwFlex=${f.rwFlex} tgt="${f.tgtW}" pin="${f.bodyPin}"`);
    say(`        rsTrans=${f.rsTrans} rwTrans=${f.rwTrans} fwTrans=${f.fwTrans} resizer=${f.resizer}`);
  }
  say("");
}

async function main() {
  const t = await getTarget();
  say(`CDP 目标：${t.title} (${t.id})`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  /* ⚠️⚠️ 必须**先重载**回到干净初始态：上一轮探针会把 App 留在浮层/残留 CSS 变量上
     （实测初始态就带着 `--right-target-w:1332px` / `--right-body-pin:441px`），
     带着脏状态跑序列 ⇒ 判读全错。这是本探针与"多次点击复用同一实例"的关键区别。 */
  /* ⚠️⚠️ A-1154：**必须先 bringToFront 并断言页面可见**。
     实测（probe-raf-hidden.mjs）：窗口被遮挡/最小化时 `document.hidden=true` ⇒
     **rAF 完全停摆**（0 fps）⇒ 依赖 rAF 的几何 done 判据（含 GEOM_SYNC_NEVER_MOUNT_FRAMES
     的有界等待）整体失效 ⇒ `slime-freezing` 残留被误判成产品缺陷。
     这是**取证环境假象**而非真机缺陷：bringToFront 后 hidden=false、rAF ≈165fps。
     ⇒ 本探针此后一律先置前，并在 hidden 时会话明确标注（避免再出 `_e2e-final` 那种假结果）。 */
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  await new Promise((r) => setTimeout(r, 300));
  const vis = await cdp.eval(`JSON.stringify({ hidden: document.hidden, vs: document.visibilityState })`);
  say(`可见性：${vis}`);
  if (JSON.parse(vis).hidden) {
    say("⚠️ 页面不可见 ⇒ rAF 会停摆，本轮的几何判据结果不可采信（仅记录轨迹）。");
  }

  say("重载页面以获得干净初始态…");
  await cdp.send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 3500));
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }

  /* 等启动门 + 会话渲染 */
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      btn: !!document.querySelector('img[alt="唤起悬浮窗"]'),
      chat: !!document.querySelector("main.main"),
      splash: (() => { const s = document.querySelector('[class*="splash"]'); return !!s && getComputedStyle(s).opacity !== "0"; })(),
    })`));
    if (i % 5 === 0) { say(`  轮询 ${i + 1}: btn=${st.btn} chat=${st.chat} splash=${st.splash}`); }
    if (st.btn) { ready = true; say(`✅ 启动门已过，第 ${i + 1} 次轮询`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!ready) {
    say("❌ 未等到窗口化按钮。DOM 头：" + (await cdp.eval(`document.body.innerHTML.slice(0,600)`)));
    fs.writeFileSync(OUT, lines.join("\n"), "utf8"); process.exit(1);
  }

  await cdp.eval(SNAP); await cdp.eval(SAMPLER);

  const clickFloat = `(() => {
    const img = document.querySelector('img[alt="唤起悬浮窗"]');
    if (!img) { return "NO-FLOAT"; }
    const b = img.closest("button") || img.parentElement;
    (b || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK";
  })()`;
  const clickTitlebarRight = `(() => {
    const hdr = document.querySelector("header.titlebar");
    if (!hdr) { return "NO-TITLEBAR"; }
    const t = Array.from(hdr.querySelectorAll("button.titlebar-btn")).find((b) => /右侧栏/.test(b.getAttribute("title") || ""));
    if (!t) { return "NO-RIGHTBTN"; }
    const before = t.getAttribute("title");
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK(" + before + ")";
  })()`;

  async function step(name, clickExpr, ms = 1300) {
    say(`════ ${name} ════`);
    if (clickExpr) { say("  点击：" + await cdp.eval(clickExpr)); await new Promise((r) => setTimeout(r, 50)); }
    const raw = await cdp.eval(`window.__sample(${ms})`);
    diffFrames(name, JSON.parse(raw));
    const last = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
    say(`  步末：cls=[${last.cls}] main=${JSON.stringify(last.main)} rs=${JSON.stringify(last.rs)} fw=${JSON.stringify(last.fw)} resizer=${last.resizer}`);
    say("");
    return last;
  }

  const g0 = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  say("初始：" + JSON.stringify(g0));
  say("");

  await step("S1 点「对话页面窗口化」", clickFloat);
  await step("S2 点标题栏「收起右侧栏」", clickTitlebarRight);
  await step("S3 点标题栏「展开右侧栏」", clickTitlebarRight);
  await step("S4a 再点「窗口化」", clickFloat);
  await step("S4b 再点「窗口化」", clickFloat);
  /* ⚠️ S5：浮层态下右栏**故意不挂 resizer**（A-1152 设计：浮层宽度只由窗口化往返决定）。
     所以拖拽取证必须先回到**普通布局**。S4b 已经把浮层收掉 ⇒ 这里直接进拖拽。 */
  const g5 = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  say("════ S5 前置：确认已回到普通布局（有 resizer） ════");
  say("  " + JSON.stringify(g5));
  if (!g5.resizer) {
    say("  ⚠️ 仍在浮层态 → 主动点一次「窗口化」退出");
    await cdp.eval(clickFloat);
    await new Promise((r) => setTimeout(r, 1400));
    say("  退出后：" + JSON.stringify(JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`))));
  }
  say("");

  say("════ S6 拖右栏 resizer（向左 160px，应跟手且无过渡滞后） ════");
  const dragRes = await cdp.eval(`(async () => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return "NO-RESIZER"; }
    const b = h.getBoundingClientRect();
    const x0 = Math.round(b.left + b.width / 2), y0 = Math.round(b.top + b.height / 2);
    const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y0, pointerId: 1, buttons: 1, button: 0, isPrimary: true });
    const snap0 = window.__snap();
    h.dispatchEvent(ev("pointerdown", x0));
    const trail = []; const clsSeen = new Set();
    for (let i = 1; i <= 16; i++) {
      document.dispatchEvent(ev("pointermove", x0 - i * 10));
      await new Promise((r) => setTimeout(r, 16));
      const s = window.__snap();
      trail.push(s.rs ? s.rs[2] : -1);
      clsSeen.add(s.cls);
    }
    document.dispatchEvent(ev("pointerup", x0 - 160));
    return JSON.stringify({ x0, y0, rsInitialW: snap0.rs ? snap0.rs[2] : -1, rsWTrail: trail, clsSeen: Array.from(clsSeen) });
  })()`);
  say("拖拽结果：" + dragRes);
  const after = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  say("拖后：" + JSON.stringify(after));
  say("");

  say("════ S7 连续快速来回拖（不跟手/闪烁？） ════");
  const fast = await cdp.eval(`(async () => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return "NO-RESIZER"; }
    const b = h.getBoundingClientRect();
    const x0 = Math.round(b.left + b.width / 2), y0 = Math.round(b.top + b.height / 2);
    const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y0, pointerId: 2, buttons: 1, button: 0, isPrimary: true });
    const clsSeen = new Set(); const trail = [];
    h.dispatchEvent(ev("pointerdown", x0));
    for (let i = 0; i < 40; i++) {
      const t = i % 2 === 0 ? -80 : 80;
      document.dispatchEvent(ev("pointermove", x0 + t));
      await new Promise((r) => setTimeout(r, 8));
      const s = window.__snap();
      clsSeen.add(s.cls); trail.push(s.rs ? s.rs[2] : -1);
    }
    document.dispatchEvent(ev("pointerup", x0));
    return JSON.stringify({ clsSeen: Array.from(clsSeen), trail });
  })()`);
  say("快速来回拖：" + fast);
  say("");

  say("════ S8 拖完静置，确认无残留临时类 ════");
  await new Promise((r) => setTimeout(r, 1500));
  const rest = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  say("静置后：" + JSON.stringify(rest));
  say("");

  say("完成。产物：" + OUT);
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  process.exit(0);
}

main().catch((e) => { say("❌ " + (e && e.stack || e)); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); process.exit(1); });
