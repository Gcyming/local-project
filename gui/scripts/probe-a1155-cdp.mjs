/* eslint-disable */
/**
 * gui/scripts/probe-a1155-cdp.mjs —— A-1155「切页引发布局错乱」端到端取证。
 *
 * ## 用户原话（四张截图）
 * ① 第一次点「窗口化悬浮窗」⇒ 右栏内容自适应失效（内容压成窄带）；
 * ② 此时点**其他页/切 tab** ⇒ 部分恢复，但**左侧边栏只剩一点点**；
 * ③ 再切页 ⇒ 左栏恢复正常；
 * ④ **展开左侧边栏 + 恢复窗口化** ⇒ 右栏被**挤压到屏幕外**。
 *
 * ## 为什么必须连真 App
 * 用户现象**只在"切 tab"后出现** ⇒ 必然与 re-render / effect 结算有关；
 * `probe-a1155-sequence.mjs`（隔离 root + 只起 renderer）拿不到 IPC ⇒ 会话列表为空
 * ⇒ ChatPanel 不挂载 ⇒ 复现不到。必须真主进程 + 真 IPC + 真会话数据。
 *
 * 前置：另开终端
 *   cd gui && SLIME_ROOT=<隔离root> SLIME_DEVTOOLS_PORT=9444 \
 *     env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
 * 运行：node gui/scripts/probe-a1155-cdp.mjs
 */
import fs from "node:fs";

const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1155_OUT || "D:/pilot project/gui/out/_a1155-cdp.txt";
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

/* ── 采样：`.body` 三栏几何 + 全部嫌疑状态 ── */
const SNAP = `window.__snap = function () {
  const R = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), l: Math.round(b.left), r: Math.round(b.right) }; };
  const bodyEl = document.querySelector(".body");
  const sb = document.querySelector(".sidebar");
  const mainEl = document.querySelector("main.main");
  const rw = document.querySelector(".right-wrapper");
  const rs = document.querySelector(".right-sidebar");
  const rb = document.querySelector(".right-body");
  const rws = rw ? getComputedStyle(rw) : null;
  const sbs = sb ? getComputedStyle(sb) : null;
  return {
    vw: window.innerWidth,
    bodyCls: Array.from(document.body.classList).join(" "),
    floatLayoutCls: document.body.classList.contains("float-layout"),
    /* 三栏几何 */
    sb: R(sb), main: R(mainEl), rw: R(rw), rs: R(rs), rb: R(rb),
    /* 左栏：内联 + 计算值 + min-width 类 */
    sbInlineW: sb ? (sb.style.width || "(none)") : null,
    sbInlineShrink: sb ? (sb.style.flexShrink || "(none)") : null,
    sbComputedShrink: sbs ? sbs.flexShrink : null,
    sbMinW: sbs ? sbs.minWidth : null,
    sbNoMinCls: sb ? sb.classList.contains("sidebar-no-min") : null,
    sbCollapsed: sb ? sb.classList.contains("collapsed") : null,
    /* 右栏 wrapper：内联 width / flexShrink（rightMin0 驱动） */
    rwInlineW: rw ? (rw.style.width || "(none)") : null,
    rwInlineShrink: rw ? (rw.style.flexShrink || "(none)") : null,
    rwComputedShrink: rws ? rws.flexShrink : null,
    rwNoMinCls: rw ? rw.classList.contains("right-wrapper-no-min") : null,
    rwAnimCls: rw ? rw.classList.contains("right-wrapper-anim") : null,
    /* A-1156：右栏的**内联**宽度 —— 它压过一切选择器规则（除非 !important）。
       「右栏没铺满 = 内联 px 把浮层态的 width 规则吃掉了」这条判据必须量它。 */
    rsInlineW: rs ? (rs.style.width || "(none)") : null,
    rsComputedW: rs ? getComputedStyle(rs).width : null,
    /* A-1156：内容列（.right-body）的计算宽度 / 上限 / 外边距 —— 判「内容只有一段」 */
    rbComputedW: rb ? getComputedStyle(rb).width : null,
    rbMaxW: rb ? getComputedStyle(rb).maxWidth : null,
    rbMarginLeft: rb ? getComputedStyle(rb).marginLeft : null,
    /* ⚠️ A-1156：浮层稳态 wrapper 宽 = calc(100% - var(--left-w))。
       这个变量失同步时症状是「右栏右缘越窗」（用户现象④），必须单独量出来。 */
    leftWVar: rw ? (rw.style.getPropertyValue("--left-w") || "(none)") : null,
    rwComputedW: rws ? rws.width : null,
    /* 覆盖率：内容列宽 / 右栏宽（<0.75 即「只有一段」） */
    fillRatio: (rs && rb) ? +(rb.getBoundingClientRect().width / Math.max(1, rs.getBoundingClientRect().width)).toFixed(3) : null,
    /* 过渡期变量（残留检测） */
    tgtW: rw ? (rw.style.getPropertyValue("--right-target-w") || "(none)") : null,
    bodyPin: rw ? (rw.style.getPropertyValue("--right-body-pin") || "(none)") : null,
    /* 临时类 */
    slimeCls: Array.from(document.body.classList).filter((c) => c.startsWith("slime-")).join(","),
    floatBtn: !!document.querySelector('img[alt="唤起悬浮窗"]'),
    floatWin: !!document.querySelector(".float-window"),
    /* 越窗 */
    overflowRight: [sb, mainEl, rw, rs, rb].filter(Boolean)
      .map((el) => Math.round(el.getBoundingClientRect().right)).filter((v) => v > window.innerWidth + 1),
  };
}; "__ready__";`;

/* ── 页面内点击（合成事件，但走 React 的 onClick 通道） ── */
const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO-FLOAT-BTN"; }
  const b = img.closest("button") || img.parentElement;
  (b || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

const CLICK_LEFT_TOGGLE = `(() => {
  const hdr = document.querySelector("header.titlebar") || document;
  const btns = Array.from(hdr.querySelectorAll("button"));
  const t = btns.find((b) => /侧栏|侧边栏/.test(b.getAttribute("title") || ""));
  if (!t) { return "NO-BTN:" + btns.map((b) => b.title).slice(0, 8).join("|"); }
  const before = t.getAttribute("title");
  t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK(" + before + ")";
})()`;

/* 切 tab：左栏的会话项 —— 结构是 `.sidebar > div` 里按 workspace 分组的容器，
   每个会话项是 `div`（含 title 文本 + 重命名/删除按钮）。
   ⚠️ 不要用 `[class*="session"]` —— 会话项**没有**那个类名（实测探针因此报"共0项"，
   是**探针 bug 而非产品问题**；左栏实际渲染了 7 项）。用结构 + 文本双重定位。 */
const LIST_SESSIONS = `(() => {
  const sb = document.querySelector(".sidebar");
  if (!sb) { return "[]"; }
  /* 会话项 = 含可点文本、高度 > 18、且不含子分组容器的 div 后代 */
  const cands = Array.from(sb.querySelectorAll("div"))
    .filter((e) => {
      const t = (e.textContent || "").trim();
      if (!t) { return false; }
      const b = e.getBoundingClientRect();
      if (b.height < 18 || b.height > 60 || b.width < 60) { return false; }
      /* 必须含"重命名/删除"两个按钮之一 ⇒ 是会话项而非分组标题 */
      return !!e.querySelector('button[title*="重命名"], button[title*="删除"]');
    });
  return JSON.stringify(cands.slice(0, 12).map((e) => (e.textContent || "").trim().slice(0, 20)));
})()`;

const CLICK_SESSION_N = (n) => `(() => {
  const sb = document.querySelector(".sidebar");
  if (!sb) { return "NO-SIDEBAR"; }
  const cands = Array.from(sb.querySelectorAll("div"))
    .filter((e) => {
      const b = e.getBoundingClientRect();
      if (b.height < 18 || b.height > 60 || b.width < 60) { return false; }
      return !!e.querySelector('button[title*="重命名"], button[title*="删除"]');
    });
  const t = cands[${n}];
  if (!t) { return "NO-ITEM(共" + cands.length + ")"; }
  const label = (t.textContent || "").trim().slice(0, 16);
  t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK:" + label;
})()`;

async function main() {
  const t = await getTarget();
  say(`CDP 目标：${t.title} (${t.id})`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  /* ⚠️⚠️ 必须**重载**回到干净初始态：上一轮探针会把 App 留在浮层/残留 CSS 变量上
     （实测残留 `--right-target-w:1332px` / `--right-body-pin:441px` / `right-wrapper-anim`），
     带着脏状态跑序列 ⇒ 判读全错。 */
  say("重载页面以获得干净初始态…");
  await cdp.send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 4000));
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  const vis = await cdp.eval(`JSON.stringify({ hidden: document.hidden, vs: document.visibilityState })`);
  say(`可见性：${vis}`);
  if (JSON.parse(vis).hidden) { say("⚠️ 页面不可见 ⇒ rAF 停摆，几何判据不可采信。"); }

  /* 等启动门 + 会话渲染 */
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      btn: !!document.querySelector('img[alt="唤起悬浮窗"]'),
      chat: !!document.querySelector("main.main"),
    })`));
    if (i % 6 === 0) { say(`  轮询 ${i + 1}: btn=${st.btn} chat=${st.chat}`); }
    if (st.btn) { ready = true; say(`✅ 启动门已过（第 ${i + 1} 次轮询）`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!ready) {
    say("❌ 未等到窗口化按钮。sidebar 文本：" + (await cdp.eval(`(document.querySelector(".sidebar")?.textContent||"").slice(0,160)`)));
    process.exit(1);
  }
  await cdp.eval(SNAP);

  const snap = async (tag) => {
    const o = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
    say(`\n【${tag}】`);
    say(`  vw=${o.vw} bodyCls="${o.bodyCls}"`);
    say(`  左栏 sb=${JSON.stringify(o.sb)} inlineW=${o.sbInlineW} inlineShrink=${o.sbInlineShrink} computedShrink=${o.sbComputedShrink} minW=${o.sbMinW} noMinCls=${o.sbNoMinCls} collapsed=${o.sbCollapsed}`);
    say(`  main=${JSON.stringify(o.main)}`);
    say(`  rw=${JSON.stringify(o.rw)} rs=${JSON.stringify(o.rs)} rb=${JSON.stringify(o.rb)}`);
    say(`  rwInlineW=${o.rwInlineW} rwInlineShrink=${o.rwInlineShrink} computedShrink=${o.rwComputedShrink} noMin=${o.rwNoMinCls} anim=${o.rwAnimCls}`);
    say(`  rsInlineW=${o.rsInlineW} rsComputedW=${o.rsComputedW}`);
    say(`  rbComputedW=${o.rbComputedW} rbMaxW=${o.rbMaxW} rbMarginLeft=${o.rbMarginLeft} fillRatio=${o.fillRatio}`);
    say(`  ⚠️ left-w="${o.leftWVar}" rwComputedW=${o.rwComputedW}`);
    say(`  tgtW="${o.tgtW}" bodyPin="${o.bodyPin}" slimeCls=[${o.slimeCls}] floatWin=${o.floatWin}`);
    say(`  ⚠️ overflowRight=${JSON.stringify(o.overflowRight)}`);
    return o;
  };

  /** 左栏当前是否收起（标题栏按钮的 title 随状态翻转，不能靠 title 猜） */
const isLeftCollapsed = (cdp) =>
  cdp.eval(`!!document.querySelector(".sidebar")?.classList.contains("collapsed")`);

  /* ── 截图（人眼判据的唯一来源：数字说不出「空白长什么样」） ── */
  const shot = async (tag) => {
    if (!process.env.SLIME_A1155_SHOTS) { return; }
    const dir = process.env.SLIME_A1155_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    const p = `${dir}/${tag}.png`;
    fs.writeFileSync(p, Buffer.from(r.data, "base64"));
    say(`  📷 ${p}`);
  };

  /* ── 过渡收敛观察：轮询到 `right-wrapper-anim` 摘掉为止，记录耗时与终态 ──
     A-1156：`done` 迟到时用户看到的就是"卡在半路的破布局"，
     所以必须量「从点击到 anim 摘掉」的**真实毫秒数**，而不是固定等 2.4s 再看一眼。 */
  const waitSettle = async (label, budgetMs = 8000) => {
    const t0 = Date.now();
    const trace = [];
    for (;;) {
      const o = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
      trace.push(`${Date.now() - t0}ms anim=${o.rwAnimCls} rs=${o.rs ? o.rs.w : "-"} rw=${o.rw ? o.rw.w : "-"} rb=${o.rb ? o.rb.w : "-"}`);
      if (!o.rwAnimCls) { break; }
      if (Date.now() - t0 > budgetMs) { say(`  ⏱ ${label}：${budgetMs}ms 内未收敛（anim 仍挂着）`); break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    say(`  ⏱ ${label} 收敛耗时=${Date.now() - t0}ms，轨迹：${trace.join(" | ")}`);
  };

  say("═══ S0 初始 ═══");
  await snap("S0 初始（未点窗口化）");
  await shot("s0-initial");
  say("左栏会话项：" + (await cdp.eval(LIST_SESSIONS)));

  /* ⚠️⚠️ 取样必须**页内**进行：`Page.captureScreenshot` 与 `Runtime.evaluate` 都有
   几十到几百毫秒往返，放在点击与轮询之间会把时间轴整体后移 —— 实测「点击后 90ms」
   那一采其实发生在 ~500ms 时，量出来的 `anim=false / 收敛 2ms` 全是假的。
   ⇒ 采样器与点击**同一个 eval** 起，动画结束后再一次性读回。 */
const ARM_FLOAT_TRACE = `(() => {
  const wrap = document.querySelector(".right-wrapper");
  const side = document.querySelector(".right-sidebar");
  window.__ftArm = { t0: 0, rows: [], dt: [], longTasks: [], loaf: [] };
  const tr = window.__ftArm;
  /* ⚠️ 用户本轮报「界面会**抽搐**，而非线性平滑的左拉」⇒ 必须能回答
     "哪一帧卡了、卡在脚本还是渲染"。所以除几何外还要记 ① 每帧间隔
     ② longtask（>50ms 的 **JS** 占用）③ **LoAF**（>50ms 的**动画帧**，
     浏览器自己给归因：renderStart 减 startTime 是脚本/渲染的分界，
     blockingDuration 是它认为「该帧多阻塞了多久」）。
     ⚠️ 「卡顿」在这三种里成因完全不同、修法也不同，不能只看帧间隔就下结论。 */
  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { tr.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }
    });
    po.observe({ entryTypes: ["longtask"] });
    tr.po = po;
  } catch (e) { tr.longTaskErr = String(e); }
  /* ⚠️ LoAF **必须先于点击注册、且不要开 buffered** —— buffered:true 会把注册之前的
     条目一并倒出来（实测第一版就因此报出启动期的 start:5 dur:57，差点被当成
     「过渡期掉帧」的证据）。归因只看**点击之后**的条目。 */
  try {
    const lo = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const scripts = (e.scripts || []).map((s) => ({
          n: (s.sourceURL || "").split("/").pop().slice(0, 40),
          dur: Math.round(s.duration || 0),
          inv: Math.round(s.invokerTime || 0),
        }));
        tr.loaf.push({
          start: Math.round(e.startTime - tr.t0),
          dur: Math.round(e.duration),
          blocking: Math.round(e.blockingDuration || 0),
          renderStart: e.renderStart === undefined ? null : Math.round(e.renderStart - e.startTime),
          scripts,
        });
      }
    });
    lo.observe({ type: "long-animation-frame" });
    tr.lo = lo;
  } catch (e) { tr.loafErr = String(e); }
  let prev = 0;
  /* ⚠️⚠️ **对照实验开关**（环境变量 SLIME_PROBE_NO_SAMPLE=1）：只记时间戳、
     **不碰任何几何 API**。
     理由：本采样器每帧要读两次 getBoundingClientRect() + 一次 getComputedStyle()
     —— 这些都是**强制同步布局**，会把"浏览器本该在帧末做的那次布局"提前到帧头，
     在刚挂载大子树的这一帧里可能自己就制造出几十毫秒的停顿。
     ⇒ 不采样时若"慢帧"消失，就说明那 90ms 有多少是**探针自己**的，
     不能再算到界面头上（这正是本轮吃过的两次教训的同一类）。 */
  const noSample = !!window.__probeNoSample;
  const tick = () => {
    const now = performance.now();
    if (prev) { tr.dt.push([Math.round(now - tr.t0), Math.round(now - prev)]); }
    prev = now;
    /* ⚠️⚠️ ARM 这一段**只记时间戳，不推几何行**。
       几何采样由「点击」那次的 tick 负责（CLICK_FLOAT_TRACE 里那六个盒子）。
       两段都推行 ⇒ 行里会混进**两种不同形状**（本段是右栏/wrapper 的，
       那段是六栏的）⇒ 逐栏分析读到错位的列，会凭空报出"310 次方向反转"这种假抖动。
       （实测踩过：out/_r27-jitter.txt 里 sb/main/host 全报 310 次反转，
         实际是形状错位，不是界面在抽。） */
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  return "ARMED";
})()`;

const CLICK_FLOAT_TRACE = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO-FLOAT-BTN"; }
  const b = img.closest("button") || img.parentElement;
  const tr = window.__ftArm || (window.__ftArm = { t0: performance.now(), rows: [], dt: [], longTasks: [], loaf: [] });
  /* ⚠️⚠️ 用户本轮报：「窗口化时各个栏目的衔接动画**抖动、抽搐**异常明显」。
     「抖动」是可量化的：**每一栏的几何在过渡中途反向移动**（先往右又往左）。
     ⇒ 这里逐帧记录**五个盒子**的 left/width，最后由 Node 侧做单调性分析，
        精确定位是哪一栏在抽，而不是"看着别扭就改 CSS"。
     ⚠️⚠️ 读这些盒子（getBoundingClientRect）是**强制同步布局**，每帧读会自己制造停顿
        （上一版实测探针采样贡献 7~11ms）。这里在 rAF 里**一次性批量读**六个盒子，
        并保留 NO_SAMPLE 对照开关复核两者差异。 */
  const boxes = () => ({
    sb: document.querySelector(".sidebar"),
    main: document.querySelector(".main"),
    host: document.querySelector(".float-window, .inline-chat-host"),
    rs: document.querySelector(".right-sidebar"),
    rb: document.querySelector(".right-body"),
    tabbar: document.querySelector(".right-tabbar"),
  });
  /* ⚠️⚠️ 绝不要把下面这个 .chat-scroll 放进上面的 boxes() 里：
     boxes() 的每个键占**两个**索引（left/width），多一个键就把后面所有列
     （opacity / 探针点 / 滚动条槽宽）**整体顶歪一格**。实测踩过：槽宽读数 100
     ——那是 opacity 的值，而报告还打印出「✓ 槽宽恒定」的**假绿**。 */
  const cs = document.querySelector(".chat-scroll");
  const M = boxes();
  const HOST = M.host;
  /* 固定探针点：浮窗下方空白、右栏可见区、浮窗右侧空白、左栏与浮窗之间 —— 四个
     "用户盯着看"的地方。坐标在**当前视口**下按比例取，1900px 与 1332px 都适用。 */
  const probePoints = [
    [Math.round(window.innerWidth * 0.35), Math.round(window.innerHeight * 0.90)],
    [Math.round(window.innerWidth * 0.62), Math.round(window.innerHeight * 0.78)],
    [Math.round(window.innerWidth * 0.80), Math.round(window.innerHeight * 0.40)],
    [Math.round(window.innerWidth * 0.18), Math.round(window.innerHeight * 0.55)],
  ];
  let prev = 0;
  const tick = () => {
    const now = performance.now();
    if (prev) { tr.dt.push([Math.round(now - tr.t0), Math.round(now - prev)]); }
    prev = now;
    if (!window.__probeNoSample) {
      const row = [Math.round(now - tr.t0)];
      for (const k of Object.keys(M)) {
        const e = M[k];
        if (!e) { row.push(null); continue; }
        const r = e.getBoundingClientRect();
        row.push(Math.round(r.left), Math.round(r.width));
      }
      /* ⚠️ A-1159：浮窗**透明度**与右栏宽度的时间轴是否同步 —— 这才是"抽搐"的判据
         （几何单调不代表观感同步：浮窗可能瞬间到位而右栏还在滑）。 */
      row.push(HOST ? Math.round(Number(getComputedStyle(HOST).opacity) * 100) : null);
      /* ⚠️⚠️ A-1159-R 真正管用的"闪烁"判据 —— **固定探针点**。
         用户的原话是「中间那个空白区域一大一小闪烁」：人眼判的是**那块地方
         画的东西换没换**，不是几何有没有反向移动（几何全程单调也已经测过了）。
         ⇒ 在若干屏幕固定点上问 elementFromPoint：签名（tag+class）一变，
         就说明那一小块**换了内容** ⇒ 客观的"闪一下"。
         ⚠️ 为什么用**固定屏幕坐标**而不是跟着元素走：跟着元素走的采样天然看不到
         "这块地方空了一下又填上"，而那正是用户说的现象。 */
      row.push(probePoints ? probePoints.map((pt) => {
        const el = document.elementFromPoint(pt[0], pt[1]);
        if (!el) { return "∅"; }
        const c = el.className;
        return (typeof c === "string" && c) ? el.tagName.toLowerCase() + "." + c.trim().split(/\s+/).slice(0, 2).join(".") : el.tagName.toLowerCase();
      }).join("|") : null);
      /* ⚠️⚠️ A-1161：用户截的那条**波浪竖线**极可能是**胶囊滚动条**（聊天区右侧）。
         滚动条出现/消失会让**内容区宽度变一格（~15px）** ⇒ 内部所有东西左右跳一格
         ⇒ 观感就是「那条边界剧烈左右抖动」+「空白一大一小」。
         ⚠️ 而且 index.css 里记着：聊天区的 ::webkit-scrollbar-* 在 Chromium 121+
            **全部失效**（标准属性优先）⇒ 实际是**平台默认滚动条**，宽且会随内容高度
            出现/消失。⇒ 这里逐帧记滚动条槽宽 + 是否溢出 + overflow-y。 */
      const csEl = cs;
      if (csEl) {
        row.push(
          csEl.offsetWidth - csEl.clientWidth,                                /* 滚动条槽宽 */
          csEl.scrollHeight > csEl.clientHeight ? 1 : 0,                      /* 是否溢出 */
          getComputedStyle(csEl).overflowY,
          Math.round(csEl.clientWidth),                                       /* 内容区实际宽 */
        );
      } else {
        row.push(null, null, null, null);
      }
      /* ⚠️⚠️ A-1163：**空洞探测**（放在**所有**既有列之后 —— 加在中间会把后面列位顶歪，
         这个坑本文件上面已经踩过一次并写了守卫）。
         用户实拍帧显示三件事：中间一整块**纯黑**（浮窗该在的位置）、右栏右缘没贴住
         窗口右缘、**看不到浮窗** ⇒ 疑似「.main 已塌成 0、浮窗还没绘制」。
         ⇒ 逐帧问「浮窗中心那个点，屏幕上顶层到底是谁」：
            命中 .float-window 子树 = 已绘制；命中 .main / body = **空洞**。
         ⚠️ 坐标取**浮窗自己的实测 rect**（不是算出来的目标值）：只有实测才知道它这帧在哪。
         ⚠️⚠️⚠️ 本段注释里**绝对不许出现反引号**：整段代码是被包进页内模板字符串的，
            反引号会提前截断它，后面 .main 就被当代码执行 ⇒ 报 ".main is not a function"。
            （同一个坑本文件已犯过四次，每次症状都一样。注意 node --check **抓不到**：
             模板字符串的内容仍是合法 JS，只有真正在浏览器里跑才炸。）*/
      {
        const he = M.host;
        let tag = "HOLE:no-host";
        if (he) {
          const r = he.getBoundingClientRect();
          const top = r.width > 4 && r.height > 4
            ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
            : null;
          if (!top) { tag = "HOLE:zero-rect"; }
          else if (top.closest(".float-window")) { tag = "FLOATWIN"; }
          else {
            const c = typeof top.className === "string" && top.className.trim()
              ? "." + top.className.trim().split(/\s+/)[0] : "";
            tag = "HOLE:" + top.tagName.toLowerCase() + c;
          }
        }
        row.push(tag);
      }
      tr.rows.push(row);
    }
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "CLICKED(traced)";
})()`;

/** 单调性分析：把某一栏的 left/width 序列切成"变化点"，标出方向反转 */
const analyzeJitter = (rows, keys) => {
  /* rows: [t, ...每盒 [left,width] 或 null] */
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const off = 1 + i * 2;
    const last = [];
    const marks = [];
    for (const r of rows) {
      const l = r[off], w = r[off + 1];
      if (l === undefined || l === null) { continue; }
      if (last[0] !== l || last[1] !== w) { marks.push([r[0], l, w]); last[0] = l; last[1] = w; }
    }
    if (marks.length < 3) { continue; }
    /* 方向反转：去掉 <2px 的抖动后，相邻变化的方向必须一致 */
    let dir = 0, reversals = 0, backtracks = 0, revAt = [];
    for (let k = 1; k < marks.length; k++) {
      const d = (marks[k][1] - marks[k - 1][1]) + (marks[k][2] - marks[k - 1][2]);
      if (Math.abs(d) < 2) { continue; }
      const nd = Math.sign(d);
      if (dir !== 0 && nd !== dir) { reversals++; revAt.push(marks[k][0]); }
      dir = nd;
    }
    out.push({ key: keys[i], points: marks.length, reversals, revAtMs: revAt.slice(0, 8),
               first: marks[0], last: marks[marks.length - 1] });
  }
  return out;
};

const READ_FLOAT_TRACE = `JSON.stringify((() => {
  const tr = window.__ftArm;
  cancelAnimationFrame(tr.raf);
  tr.po && tr.po.disconnect();
  tr.lo && tr.lo.disconnect();
  /* 只保留「几何/透明度/anim 类」发生变化的那几帧（人眼读曲线用） */
  const marks = [];
  let last = "";
  for (const r of tr.rows) {
    const k = r.slice(1).join("|");
    if (k !== last) { marks.push("t=" + r[0] + "ms sb=" + r[1] + "/" + r[2] + " main=" + r[3] + "/" + r[4] + " host=" + r[5] + "/" + r[6] + " rs=" + r[7] + "/" + r[8] + " rb=" + r[9] + "/" + r[10]); last = k; }
  }
  /* 停顿：相邻两帧几何完全相同且间隔 > 40ms —— 「抽搐」的可测形态 */
  const stalls = [];
  for (let i = 1; i < tr.rows.length; i++) {
    const a = tr.rows[i - 1], b2 = tr.rows[i];
    const gap = b2[0] - a[0];
    if (gap > 40 && String(a.slice(1)) === String(b2.slice(1))) { stalls.push("t=" + a[0] + "→" + b2[0] + "ms 卡 " + gap + "ms（几何完全没动）"); }
  }
  const dt = tr.dt.map((d) => d[1]);
  const sorted = [...dt].sort((x, y) => x - y);
  return {
    total: tr.rows.length,
    dur: tr.rows.length ? tr.rows[tr.rows.length - 1][0] : 0,
    marks: marks.slice(0, 24),
    stalls,
    longTasks: tr.longTasks,
    longTaskErr: tr.longTaskErr || null,
    loaf: tr.loaf,
    loafErr: tr.loafErr || null,
    dtMax: Math.max(0, ...dt),
    dtP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    slowFrames: tr.dt.filter((d) => d[1] > 40).slice(0, 12),
    raw: tr.rows,
  };
})())`;

/* ⚠️ 用户本轮报：窗口化**恢复**时右栏「从左向右闭合、右边凭空空白」⇒ 与唤出相反的方向问题。
   ⚠️⚠️ 必须**页内采样**（同唤出那条）：CDP 的截图/eval 有几百毫秒往返，
   放在点击与轮询之间会把整条时间轴后移 —— 上版「点击后 90ms」那一采
   其实发生在 ~500ms 时，量出的「收敛 2ms、右栏已到位」全是假的。 */
const ARM_EXIT_TRACE = `(() => {
  const wrap = document.querySelector(".right-wrapper");
  const side = document.querySelector(".right-sidebar");
  window.__ftArm = { t0: 0, rows: [], dt: [], longTasks: [], loaf: [] };
  const tr = window.__ftArm;
  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { tr.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }
    });
    po.observe({ entryTypes: ["longtask"] });
    tr.po = po;
  } catch (e) { tr.longTaskErr = String(e); }
  try {
    const lo = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        tr.loaf.push({
          start: Math.round(e.startTime - tr.t0),
          dur: Math.round(e.duration),
          blocking: Math.round(e.blockingDuration || 0),
          renderStart: e.renderStart === undefined ? null : Math.round(e.renderStart - e.startTime),
          scripts: (e.scripts || []).map((s) => ({ n: (s.sourceURL || "").split("/").pop().slice(0, 40), dur: Math.round(s.duration || 0) })),
        });
      }
    });
    lo.observe({ type: "long-animation-frame" });
    tr.lo = lo;
  } catch (e) { tr.loafErr = String(e); }
  let prev = 0;
  const tick = () => {
    const now = performance.now();
    if (prev) { tr.dt.push([Math.round(now - tr.t0), Math.round(now - prev)]); }
    prev = now;
    const sr = side.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    tr.rows.push([
      Math.round(now - tr.t0),
      Math.round(sr.width), Math.round(sr.left), Math.round(sr.right),
      Math.round(wr.width), Math.round(wr.left), Math.round(wr.right),
      Math.round(Number(getComputedStyle(wrap).opacity) * 100),
      wrap.classList.contains("right-wrapper-anim"),
      side.style.width || "(none)",
    ]);
    tr.raf = requestAnimationFrame(tick);
  };
  tr.t0 = performance.now();
  tr.raf = requestAnimationFrame(tick);
  return "ARMED";
})()`;

const CLICK_EXIT_TRACE = `(() => {
  const b = document.querySelector('button[title*="恢复普通布局"]')
         || Array.from(document.querySelectorAll(".float-window button")).find((x) => x.textContent === "▢");
  if (!b) { return "NO-RESTORE-BTN"; }
  const tr = window.__ftArm || (window.__ftArm = { t0: performance.now(), rows: [], dt: [], longTasks: [], loaf: [] });
  tr.t0 = performance.now();
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "CLICKED(exit traced)";
})()`;

const READ_EXIT_TRACE = `JSON.stringify((() => {
  const tr = window.__ftArm;
  cancelAnimationFrame(tr.raf);
  tr.po && tr.po.disconnect();
  tr.lo && tr.lo.disconnect();
  const marks = [];
  let last = "";
  for (const r of tr.rows) {
    const k = r.slice(1).join("|");
    if (k !== last) {
      marks.push(\`\${r[0]}ms 右栏=\${r[1]}px @\${r[2]}..\${r[3]} wrapper=\${r[4]}px @\${r[5]}..\${r[6]} 不透明=\${r[7]}% anim=\${r[8]}\`);
      last = k;
    }
  }
  const dt = tr.dt.map((d) => d[1]);
  return {
    total: tr.rows.length,
    dur: tr.rows.length ? tr.rows[tr.rows.length - 1][0] : 0,
    marks: marks.slice(0, 26),
    head: tr.rows.slice(0, 12).map((r) => [r[0], r[1], r[9], r[8]]),
    slowFrames: tr.dt.filter((d) => d[1] > 40).slice(0, 8),
    dtMax: Math.max(0, ...dt),
    longTasks: tr.longTasks,
    loaf: tr.loaf,
    raw: tr.rows,
  };
})())`;

/* ══ ⓪ **冷启动后的首次**左栏收起→展开 ══════════════════════════════════
     ④/⑤ 都是"已经动过几轮之后"的展开；用户抱怨的是"**现在**展开要等半天"，
     可能对应的是**刚打开应用后的第一次**（此时会话树/搜索索引/首屏都还没热）。
     ⇒ 必须单独量一次冷态，否则等于用热态数据去解释冷态抱怨。
     ⚠️ 位置说明：必须放在 `clickAndTraceLeft` 定义**之后** —— 它是 `const` 箭头函数，
       放前面会在 TDZ 里抛 "Cannot access before initialization"（实测踩过）。 */
  say("\n═══ ⓪ 冷态：左栏收起 → 展开（刚加载完就做） ═══");
  {
    const t0 = Date.now();
    await cdp.eval(CLICK_LEFT_TOGGLE);
    say(`  点击左栏按钮（收起）=OK(${Date.now() - t0}ms 内返回)`);
    await new Promise((r) => setTimeout(r, 900));
    await clickAndTraceLeft("⓪ 冷态 左栏展开");
  }

  say("\n═══ ① 点「窗口化」 ═══");
  /* ⚠️ 对照实验：设置探针的"只记时间不采样"开关（读环境变量，在页面里注入一个标志）。 */
  if (process.env.SLIME_PROBE_NO_SAMPLE) {
    say("⚠️ 对照模式：**不**读任何几何 API（用于判断慢帧有多少是探针自己制造的）");
    await cdp.eval(`(() => { window.__probeNoSample = true; return "NO-SAMPLE MODE"; })()`);
  }
  /* ⚠️ 观察器必须**先于**点击注册（LoAF 的条目按注册时刻起算）。 */
  say("装采样器=" + (await cdp.eval(ARM_FLOAT_TRACE)));
  say("点击=" + (await cdp.eval(CLICK_FLOAT_TRACE)));
  /* ⚠️ 截图夹在点击与轮询之间**会污染 CDP 时钟**，但页内采样器不受影响（见 CLICK_FLOAT_TRACE 注释）。 */
  await new Promise((r) => setTimeout(r, 90));
  await shot("s1a-mid-090ms");
  await new Promise((r) => setTimeout(r, 120));
  await shot("s1b-mid-210ms");
  await waitSettle("①窗口化过渡");
  await new Promise((r) => setTimeout(r, 600));
  const ft = JSON.parse(await cdp.eval(READ_FLOAT_TRACE));
  say(`  🎞 窗口化过渡曲线（页内采样，共 ${ft.total} 帧 / ${ft.dur}ms）：`);
  for (const m of ft.marks) { say(`      ${m}`); }
  say(`  ⏱ 帧间隔：p95=${ft.dtP95}ms max=${ft.dtMax}ms；>40ms 的慢帧=${JSON.stringify(ft.slowFrames)}`);
  say(`  ⏱ 长任务（>50ms）=${JSON.stringify(ft.longTasks)}${ft.longTaskErr ? " 观察器失败:" + ft.longTaskErr : ""}`);
  say(`  ⏱ **几何停顿**（宽度不变但帧间隔 >40ms）=${ft.stalls.length ? ft.stalls.join(" | ") : "无"}`);
  say(`  🧾 LoAF（>50ms 的动画帧，浏览器自己归因）=${JSON.stringify(ft.loaf)}${ft.loafErr ? " 观察器失败:" + ft.loafErr : ""}`);
  /* ⚠️⚠️ 抖动分析：逐栏看几何在过渡中途有没有**反向移动**（真正的"抽搐"）。 */
  {
    const BOXES = ["sb", "main", "host", "rs", "rb", "tabbar"];
    const jitter = analyzeJitter(ft.raw || [], BOXES);
    say(`  📐 逐栏抖动分析（方向反转次数 / 采样点）：`);
    for (const j of jitter) {
      const flag = j.reversals > 0 ? "⚠️ 反转" : "单调";
          say(`      ${j.key.padEnd(7)} ${String(j.reversals).padStart(3)} 次 ${flag}`
        + ` · ${j.points} 点 · ${JSON.stringify(j.first)} → ${JSON.stringify(j.last)}`
        + (j.revAtMs.length ? ` · 反转于 ${j.revAtMs.join("/")}ms` : ""));
    }
    /* ⚠️ A-1159：**时间轴对齐**判据 —— 浮窗透明度 0→100 的区间 vs 右栏宽度变化的区间。 */
    const rows = ft.raw || [];
    const op = [];
    for (const r of rows) { const o = r[13]; if (o !== undefined && o !== null) { if (!op.length || op[op.length - 1][1] !== o) { op.push([r[0], o]); } } }
    const rsW = [];
    for (const r of rows) { const w = r[8]; if (w !== undefined && w !== null) { if (!rsW.length || rsW[rsW.length - 1][1] !== w) { rsW.push([r[0], w]); } } }
    const opSpan = op.length ? [op[0][0], op[op.length - 1][0]] : null;
    const rsSpan = rsW.length ? [rsW[0][0], rsW[rsW.length - 1][0]] : null;
    say(`  ⏱ 时间轴对齐：浮窗透明度 ${JSON.stringify(op)}`);
    say(`             右栏宽度   ${JSON.stringify(rsW.slice(0, 3))} … ${JSON.stringify(rsW.slice(-2))}`);
    say(`             ⇒ 浮窗淡入区间 ${JSON.stringify(opSpan)} vs 右栏滑动区间 ${JSON.stringify(rsSpan)}`
      + (opSpan && rsSpan && Math.abs(opSpan[1] - rsSpan[1]) <= 60 ? " ✓ 收尾基本同步" : " ⚠️ 不同步"));

    /* ⚠️⚠️ A-1159-R：**固定探针点换元素的次数** = "那块地方闪没闪"的客观计数。
         几何全单调也照样会闪 —— 闪的是**画在那里的东西换了**，不是盒子动了。 */
    const n = rows.length ? (rows[0].length > 14 ? 14 : -1) : -1;
    if (n >= 0) {
      say("  🔦 固定探针点（换元素次数 / 采样点）：");
      for (let p = 0; p < 4; p++) {
        let changes = 0, first = null, last = null;
        const at = [];
        for (const r of rows) {
          if (typeof r[14] !== "string") { continue; }
          const sig = r[14].split("|")[p];
          if (first === null) { first = sig; }
          if (last !== null && last !== sig) { changes++; if (at.length < 8) { at.push(r[0] + "ms"); } }
          last = sig;
        }
        say(`      点${p + 1}  ${String(changes).padStart(3)} 次 ${changes === 0 ? "✓ 全程稳定" : "⚠️ 会闪"}`
            + ` · ${JSON.stringify(first)} → ${JSON.stringify(last)}`
            + (at.length ? ` · 变于 ${at.join("/")}` : ""));
      }
    }
  /* ⚠️⚠️ A-1161：**聊天区滚动条槽宽**逐帧变化 —— 这就是"边界左右抖动"的候选实体。
         槽宽一变，内容区宽度就变一格，聊天区内所有东西**跟着左右跳**。 */
    const sb = [];
    for (const r of rows) {
      const g = r[15];
      if (g === undefined || g === null) { continue; }
      if (!sb.length || sb[sb.length - 1][1] !== g || sb[sb.length - 1][2] !== r[16] || sb[sb.length - 1][3] !== r[17]) {
        sb.push([r[0], g, r[16], r[17], r[18]]);
      }
    }
    say("  📜 聊天区滚动条槽宽/溢出/overflowY/内容宽（变化点）：" + JSON.stringify(sb));
    say("     ⇒ 槽宽取值 " + JSON.stringify([...new Set(sb.map((x) => x[1]))])
      + (new Set(sb.map((x) => x[1])).size > 1 ? " ⚠️ **槽宽在变 ⇒ 内容左右跳**" : " ✓ 槽宽恒定"));
    /* ⚠️⚠️ **列位自检** —— 防止"索引错位读出别的列"却还打印 ✓ 的假绿（实测踩过：
       多塞一个盒子进 `boxes()`，后面所有列整体偏一格，槽宽读数变成 opacity=100，
       报告照样打「✓ 槽宽恒定」）。这里拿**已知真值**当标尺：
       浮窗不透明 ⇒ r[13] 必须落在 0..100；overflowY 必须是 scroll/auto/hidden 之一。 */
    const bad = [];
    for (const r of rows) {
      if (typeof r[13] !== "number" || r[13] < 0 || r[13] > 100) { bad.push("opacity@" + r[0] + "=" + r[13]); }
      if (typeof r[17] !== "string" || !/^(scroll|auto|hidden|visible)$/.test(r[17])) { bad.push("overflowY@" + r[0] + "=" + r[17]); }
    }
    /* ⚠️ A-1163：空洞探测列（r[19]）只许取约定的几个值，否则说明列位又被顶歪了。 */
    const holes = rows.filter((r) => typeof r[19] === "string" && (r[19] === "FLOATWIN" || r[19].startsWith("HOLE:")));
    if (holes.length !== rows.length) { bad.push("空洞列位置异常"); }
    say("  🕳 空洞帧：" + holes.filter((r) => r[19].startsWith("HOLE:")).length + " / " + holes.length
      + (holes.filter((r) => r[19].startsWith("HOLE:")).length
        ? " ⇒ 取值 " + JSON.stringify([...new Set(holes.filter((r) => r[19].startsWith("HOLE:")).map((r) => r[19]))].slice(0, 6))
        : " ✓ 全程浮窗都在屏幕上"));
    say("  🧷 列位自检：" + (bad.length ? "❌ 列位错位 → " + bad.slice(0, 4).join(", ") : "✓ 各列读数与其语义相符"));
  }   /* ← 抖动分析块的收尾 */
  await snap("S1 点窗口化后（收敛后）");
  await shot("s1-float-settled");

  say("\n═══ ② 切到另一个会话 ═══");
  say("点击会话[1]=" + (await cdp.eval(CLICK_SESSION_N(1))));
  await new Promise((r) => setTimeout(r, 1600));
  await snap("S2 切页后 (+1.6s)");
  await shot("s2-switch1");

  say("\n═══ ③ 再切回会话[0] ═══");
  say("点击会话[0]=" + (await cdp.eval(CLICK_SESSION_N(0))));
  await new Promise((r) => setTimeout(r, 1600));
  await snap("S3 再切页后 (+1.6s)");
  await shot("s3-switch2");

  /* A-1156：用户 ④ 的原文是「**展开**左侧边栏 + 恢复窗口化」。
     旧脚本点的是标题栏的左栏按钮，而它的 title 随状态在「收起侧栏/展开侧栏」之间翻转
     ⇒ 旧脚本点完常常是**收起**（与用户动作相反），④ 的越窗结论就测错了方向。
     现在**先读当前状态再决定点几次**，并且**收→放往返各量一次**：
     浮层稳态的 wrapper 宽是 `calc(100% - var(--left-w))`（A-1155-R7），
     `--left-w` 由左栏动画逐帧同步（A-1155-R7）⇒ 左栏一折一放，右栏必须跟着铺满/让位，
     这是用户「左栏只剩一点点」「右栏被挤压到屏幕外」两种报法的共同现场。 */
  say("\n═══ ④a 左侧边栏收起（浮层态） ═══");
  if (await isLeftCollapsed(cdp)) {
    say("  点击左栏按钮（展开）=" + (await cdp.eval(CLICK_LEFT_TOGGLE)));
    await new Promise((r) => setTimeout(r, 1500));
  }
  say("  点击左栏按钮（收起）=" + (await cdp.eval(CLICK_LEFT_TOGGLE)));
  await new Promise((r) => setTimeout(r, 1600));
  await snap("S4 左栏收起后");
  await shot("s4-left-collapsed");

  say("\n═══ ④b 左侧边栏展开（用户原文的动作） ═══");
  /* ⚠️⚠️ 用户本轮报：「左栏展开要等半天，经常以为没展开、点半天没反应」。
     ⇒ 量三件事，且**点击时间戳必须与点击同在一个 eval 里取**：
       ① commitMs = 点击 → React 真的把 `.collapsed` 摘掉；
       ② 帧间隔分布（主线程有没有被占住）；
       ③ 长任务。
     ⚠️⚠️ 第一版把「装探针」和「点按钮」拆成两次 eval，于是 commitMs 量的是
       **装完探针之后**才发生的提交（多算了几百毫秒，结论会被带偏）。
     ⚠️ 逐帧 rAF 采样会自己占主线程，间隔分布只作参考；判据以 commitMs 为主。 */
  /* ⚠️ 用**函数声明**而不是 const 箭头：冷态那一步要排在步骤 ① 之前，
     而 const 箭头函数有 TDZ —— 排在前面会在初始化前被调用，
     实测直接抛 "Cannot access 'clickAndTraceLeft' before initialization"。 */
  async function clickAndTraceLeft(label, ms = 2400) {
    const res = await cdp.eval(`(() => {
      const btn = Array.from(document.querySelectorAll("header.titlebar button, .titlebar button"))
        .find((b) => /侧栏|侧边栏/.test(b.getAttribute("title") || ""));
      const sb = document.querySelector(".sidebar");
      if (!btn || !sb) { return JSON.stringify({ err: "NO-BTN" }); }
      const trace = { frames: [], samples: [], longTasks: [], flipAt: null, flipClass: null };
      const mo = new MutationObserver(() => {
        if (trace.flipAt === null && !sb.classList.contains("collapsed")) {
          trace.flipAt = Math.round(performance.now() - trace.t0);
          trace.flipClass = sb.className;
        }
      });
      mo.observe(sb, { attributes: true, attributeFilter: ["class"] });
      try {
        const po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) { trace.longTasks.push(Math.round(e.duration)); }
        });
        po.observe({ entryTypes: ["longtask"] });
        trace.po = po;
      } catch (e) { trace.longTaskErr = String(e); }
      let prev = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = Math.round(now - prev);
        prev = now;
        /* ⚠️⚠️ 必须**每帧**记「宽度 + 不透明度 + 右栏位置」：用户说的是
           「以为没展开、点半天没反应」—— 这是**看见的**问题，不是提交慢的问题。
           提交耗时（commitMs）已经在上一版量过：2ms，完全正常。
           真正要回答的是：内容从点击到"看得见"过了多久、期间面板在不在动。 */
        const b = sb.getBoundingClientRect();
        const cs = getComputedStyle(sb);
        trace.frames.push(dt);
        trace.samples.push([
          Math.round(now - trace.t0),
          Math.round(b.width),
          Math.round(Number(cs.opacity) * 100),
          cs.visibility,
        ]);
        trace.raf = requestAnimationFrame(tick);
      };
      trace.raf = requestAnimationFrame(tick);
      /* ⚠️ 点击与 t0 同帧取：这是上一版结论被带偏的根因。 */
      trace.t0 = performance.now();
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      trace.handlerReturnedAt = Math.round(performance.now() - trace.t0);
      window.__lt = trace;
      window.__ltStop = () => {
        cancelAnimationFrame(trace.raf);
        mo.disconnect();
        trace.po && trace.po.disconnect();
      };
      return JSON.stringify({ armed: true, handlerReturnedAt: trace.handlerReturnedAt });
    })()`);
    say(`  ▶ ${label} 点击派发：${res}`);
    await new Promise((r) => setTimeout(r, ms));
    const o = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      window.__ltStop();
      const t = window.__lt;
      const sb = document.querySelector(".sidebar");
      const fr = t.frames.slice(2);
      const sorted = [...fr].sort((a, b) => a - b);
      return {
        handlerReturnedAt: t.handlerReturnedAt,
        flipAt: t.flipAt,
        flipClass: t.flipClass,
        frameCount: fr.length,
        maxFrame: Math.max(0, ...fr),
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        longTasks: t.longTasks,
        longTaskErr: t.longTaskErr || null,
        samples: t.samples || [],
        sbW: sb ? Math.round(sb.getBoundingClientRect().width) : -1,
        sbInline: sb ? sb.style.width || "(none)" : null,
        bodyCls: document.body.className,
      };
    })())`));
    const s = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
    say(`  📈 ${label}：handler 返回=${o.handlerReturnedAt}ms · **提交(摘 collapsed)=${o.flipAt}ms** · 帧数=${o.frameCount} p95=${o.p95}ms max=${o.maxFrame}ms · 长任务=${JSON.stringify(o.longTasks)}${o.longTaskErr ? "(观察器失败:" + o.longTaskErr + ")" : ""}`);
    say(`      末态：sb.w=${o.sbW} inline=${o.sbInline} class="${o.sb ? o.sb.className : "-"}" left-w="${s.leftWVar}" body="${o.bodyCls}"`);
    /* ⚠️ 可见性时间线（每帧的 宽/不透明度/可见性），压缩成「变化点」便于人眼读 */
    const sm = o.samples;
    const marks = [];
    let last = "";
    for (const [t, w, op, vis] of sm) {
      const k = `${w}|${op}|${vis}`;
      if (k !== last) { marks.push(`${t}ms 宽=${w} 不透明=${op}% ${vis}`); last = k; }
    }
    say(`      可见性时间线（共 ${sm.length} 帧）：${marks.slice(0, 26).join(" → ")}`);
    return o;
  }
  for (let i = 0; i < 3; i++) {
    if (!(await isLeftCollapsed(cdp))) { say("  已是展开态，不点"); break; }
    await clickAndTraceLeft(`左栏展开轨迹 #${i + 1}`);
  }
  await snap("S5 左栏展开后");
  await shot("s5-left-expanded");

  say("\n═══ ④c 恢复窗口化（点浮窗按钮退回中间页） ═══");
  /* ⚠️ 用户本轮报：**恢复**时右栏「从左向右闭合、右边凭空空白」⇒ 与唤出相反的方向问题。
     必须页内逐帧采样（理由同 ①）。 */
  say("装采样器=" + (await cdp.eval(ARM_EXIT_TRACE)));
  say("点击=" + (await cdp.eval(CLICK_EXIT_TRACE)));
  await waitSettle("④退浮层过渡");
  await new Promise((r) => setTimeout(r, 900));
  const ex = JSON.parse(await cdp.eval(READ_EXIT_TRACE));
  say(`  🎞 退浮层过渡曲线（页内采样，共 ${ex.total} 帧 / ${ex.dur}ms）：`);
  for (const m of ex.marks) { say(`      ${m}`); }
  say(`  🧾 退场前 12 帧逐帧（时间/右栏宽/内联宽/anim）=${JSON.stringify(ex.head)}`);
  say(`  ⏱ 帧间隔 max=${ex.dtMax}ms；>40ms 慢帧=${JSON.stringify(ex.slowFrames)}；长任务=${JSON.stringify(ex.longTasks)}`);
  say(`  🧩 LoAF=${JSON.stringify(ex.loaf)}`);
  const hostInfo = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector(".float-window, .inline-chat-host");
    if (!h) { return JSON.stringify({ missing: true }); }
    const r = h.getBoundingClientRect();
    const cs = getComputedStyle(h);
    const inner = h.firstElementChild;
    return JSON.stringify({
      cls: h.className,
      w: Math.round(r.width), h: Math.round(r.height),
      l: Math.round(r.left), t: Math.round(r.top),
      pos: cs.position, opacity: Number(cs.opacity), vis: cs.visibility,
      innerOpacity: inner ? Number(getComputedStyle(inner).opacity) : null,
    });
  })()`));
  say(`  🪟 浮窗宿主几何=${JSON.stringify(hostInfo)}`);
  /* ⚠️⚠️ **A-1158-R 的回归钉子**：退出浮层后，普通布局的聊天区**必须可见**。
     A-1158 把"浮窗外框"与"内联聊天区"合并成同一个宿主之后，`floatInnerRef` 那一层
     **常驻**了；而几何渐隐在退场终点会把它 `style.opacity` 写成 ≈0 ⇒ 残留把
     **普通布局的聊天区整块变透明**（用户实测：恢复后中间一片黑）。
     ⚠️ 这条断言是那次的**唯一**自动发现手段：几何量（w/h/bodyCls）全是"正常"的，
     只有 opacity 暴露了问题 —— 截图不比对哈希就看不出来。 */
  if (!hostInfo.missing && (hostInfo.opacity < 0.99 || (hostInfo.innerOpacity !== null && hostInfo.innerOpacity < 0.99))) {
    say(`  ❌❌❌ **宿主被透明化**：外层 opacity=${hostInfo.opacity} 内层 opacity=${hostInfo.innerOpacity}`
      + ` ⇒ 普通布局下聊天区不可见（A-1158-R 回归）`);
  }
  /* ⚠️⚠️ **复现用户最可能的那条路径**：退场动画还没结束就再点一次「窗口化」。
     用户这几轮的描述反复出现「点了没反应 / 等不及又点一下」，而 A-1154 的世代号机制
     正是为「被打断的退场」设计的 —— 这里必须实测它**会不会把状态卡住**
     （卡住的表现 = 浮窗 w/h 停在 0：`.floatAnim` 停在 `"closing"`、
       几何 done 没跑 ⇒ `setFloatAnim("idle")` / `setFloatState("none")` 都没执行）。 */
  say("\n═══ ④d 退场未结束就再点一次「窗口化」（打断路径） ═══");
  say("装采样器=" + (await cdp.eval(ARM_EXIT_TRACE)));
  say("第一次恢复=" + (await cdp.eval(CLICK_EXIT_TRACE)));
  await new Promise((r) => setTimeout(r, 180));
  say(`  ⏱ 打断前宿主=${await cdp.eval(`(() => {
    const h = document.querySelector(".float-window, .inline-chat-host");
    if (!h) { return "n/a"; }
    const r = h.getBoundingClientRect();
    return \`w=\${Math.round(r.width)} h=\${Math.round(r.height)}\`;
  })()`)}`);
  say("立刻再点窗口化=" + (await cdp.eval(CLICK_FLOAT_TRACE)));
  await new Promise((r) => setTimeout(r, 2600));
  say(`  🪟 打断后宿主=${await cdp.eval(`(() => {
    const h = document.querySelector(".float-window, .inline-chat-host");
    if (!h) { return "（宿主不存在）"; }
    const r = h.getBoundingClientRect();
    const cs = getComputedStyle(h);
    return JSON.stringify({
      cls: h.className, w: Math.round(r.width), h: Math.round(r.height),
      pos: cs.position, opacity: cs.opacity,
      inlineW: h.style.width || "(none)", inlinePos: h.style.position || "(none)",
      bodyFloat: document.body.classList.contains("float-layout"),
    });
  })()`)}`);
  await shot("s4d-interrupt");
  await new Promise((r) => setTimeout(r, 400));
  await snap("S4d 打断后（等 3s 稳态）");
  await snap("S6 恢复窗口化后");
  await shot("s6-float-restored");

  /* ══ ⑥ 最小化 → 还原（单宿主改造后，这条路径的几何 fade 目标换了节点）══════════
     A-1158 把"浮窗外框"和"内联聊天区"合并成**同一个元素**，而最小化/还原的几何渐隐
     写的是 `floatInnerRef`（内层包裹层）、退浮层的内联淡入写的是**宿主** ——
     两个 ref 现在指向不同节点，但如果哪天有人把它们并成一个，两条淡入淡出会互相覆盖。
     ⇒ 必须实测一遍"最小化 → 还原"仍是好的。 */
  say("\n═══ ⑥ 最小化 → 还原 ═══");
  await cdp.eval(CLICK_FLOAT);
  await new Promise((r) => setTimeout(r, 1200));
  await snap("S10 再次窗口化（准备最小化）");
  say("点最小化=" + (await cdp.eval(`(() => {
    const b = Array.from(document.querySelectorAll(".float-window button"))
      .find((x) => (x.getAttribute("title") || "").includes("最小化"));
    if (!b) { return "NO-MIN-BTN"; }
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK";
  })()`)));
  await new Promise((r) => setTimeout(r, 1400));
  await snap("S11 最小化后");
  await shot("s11-minimized");
  say("点还原=" + (await cdp.eval(`(() => {
    /* ⚠️⚠️ 事件必须发在**最小化浮层**（宿主最后一个子元素）上，不是宿主。
       onPointerDown={startFloatDrag(e, restoreFloat)} 挂在浮层；
       React 虽在 root 上监听并模拟传播，但那只对**实际冒泡经过**该节点的事件生效
       —— 派发在父元素（宿主）上，子元素的处理器根本不会被调用。
       实测两次踩坑：① 只发 click ⇒ tap 分支不跑；② 改成 pointerdown/up 但仍发在宿主上
       ⇒ 同样不触发，两次都表现为「还原后截图与最小化后逐字节相同」。 */
    const host = document.querySelector(".float-window");
    if (!host) { return "NO-FLOAT"; }
    const overlay = host.lastElementChild;
    if (!overlay) { return "NO-OVERLAY"; }
    const b = overlay.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
                   clientX: Math.round(b.left + 8), clientY: Math.round(b.top + 8) };
    overlay.dispatchEvent(new PointerEvent("pointerdown", opts));
    overlay.dispatchEvent(new PointerEvent("pointerup", opts));
    return "OK(overlay pointerdown+pointerup)";
  })()`)));
  await new Promise((r) => setTimeout(r, 1600));
  await snap("S12 还原后");
  await shot("s12-restored");

  /* ══ ⑦ 慢动作逐帧取证 ══════════════════════════════════════════════════
     A-1159-R：用户抓到一帧"浮窗半透明、右栏内容叠印其上、空白一大一小"的中间帧。
     ⚠️⚠️ **光看稳态帧永远看不出过渡问题**：所有断言在收敛后都是绿的。
     ⇒ 这里把 `transition-duration` / `animation-duration` **整体放大 12 倍**，
        每次 CDP 截图的往返（几十~上百 ms）落到的就是一个**稳定可辨认**的中间态。
     ⚠️ 这是**诊断专用**的注入，结束即移除（`--probe-slowmo` 元素）。
        它只改时长、不改缓动曲线形状，所以"哪个阶段在闪"的结论仍成立。 */
  say("\n═══ ⑦ 慢动作逐帧取证（过渡时长 ×12） ═══");
  await cdp.eval(`(() => {
    const st = document.createElement("style");
    st.id = "probe-slowmo";
    st.textContent = "*{transition-duration:3.36s !important;animation-duration:3.36s !important;}";
    document.head.appendChild(st);
    return "slowmo-injected";
  })()`);
  say("窗口化=" + (await cdp.eval(CLICK_FLOAT_TRACE)));
  for (const at of [400, 900, 1500, 2200, 2900]) {
    await new Promise((r) => setTimeout(r, at === 400 ? 400 : 500));
    await shot(`s7-slowmo-${at}ms`);
    say(`  📐 ${at}ms = ${await cdp.eval(`(() => {
      const h = document.querySelector(".float-window, .inline-chat-host");
      const rs = document.querySelector(".right-sidebar");
      if (!h || !rs) { return "n/a"; }
      const a = h.getBoundingClientRect(), b = rs.getBoundingClientRect();
      return JSON.stringify({
        host: Math.round(a.left) + ".." + Math.round(a.right) + "×" + Math.round(a.height),
        hostOpacity: Number(getComputedStyle(h).opacity).toFixed(2),
        rs: Math.round(b.left) + ".." + Math.round(b.right),
        rsOpacity: Number(getComputedStyle(rs).opacity).toFixed(2),
        /* ⚠️ 「空白区域」= 浮窗与右栏之间的空隙 + 浮窗下方的空隙 —— 用户说它一大一小 */
        gapX: Math.round(b.left - a.right),
        gapY: Math.round(window.innerHeight - a.bottom),
        /* ⚠️ 浮窗与右栏**重叠**的宽度：>0 就意味着两层内容会叠印 */
        overlap: Math.round(Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))),
      });
    })()`)}`);
  }
  say("恢复窗口化=" + (await cdp.eval(CLICK_EXIT_TRACE)));
  for (const at of [400, 900, 1500, 2200]) {
    await new Promise((r) => setTimeout(r, at === 400 ? 400 : 500));
    await shot(`s7-slowmo-exit-${at}ms`);
  }
  await cdp.eval(`(() => { const s = document.getElementById("probe-slowmo"); if (s) { s.remove(); } return "slowmo-removed"; })()`);
  await new Promise((r) => setTimeout(r, 4000));

  /* ══ ⑧ 宽窗口复现 ═══════════════════════════════════════════════════════
     ⚠️⚠️ 用户的窗口比本探针默认的 1332px **宽得多**（截图里整窗近 1900px）。
        而右栏稳态宽、`.right-body` 的 `max-width: min(1600px, 100%)` 钳制、
        浮窗 `fitFloatRect` 的可用空间**全都随窗宽变化** ⇒ 1332px 上测不到的
        现象，在宽窗口上完全可能出现。⇒ 这里用 `Emulation.setDeviceMetricsOverride`
        把视口撑到 1900px 再跑一遍"窗口化/恢复"。 */
  say("\n═══ ⑧ 宽窗口（1900px）复现 ═══");
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1900, height: 1150, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 1200));
    say("视口=" + (await cdp.eval("window.innerWidth + '×' + window.innerHeight")));
    for (const round of [1, 2]) {
      say(`第 ${round} 轮：窗口化=` + (await cdp.eval(CLICK_FLOAT_TRACE)));
      await new Promise((r) => setTimeout(r, 1200));
      await shot(`s8-wide-float-r${round}`);
      say(`  📐 浮窗态 ${await cdp.eval(`(() => {
        const h = document.querySelector(".float-window, .inline-chat-host");
        const rs = document.querySelector(".right-sidebar");
        const rb = document.querySelector(".right-body");
        if (!h || !rs) { return "n/a"; }
        const a = h.getBoundingClientRect(), b = rs.getBoundingClientRect(), c = rb.getBoundingClientRect();
        return JSON.stringify({
          host: Math.round(a.left) + ".." + Math.round(a.right) + "×" + Math.round(a.height),
          rs: Math.round(b.left) + ".." + Math.round(b.right),
          rb: Math.round(c.left) + ".." + Math.round(c.right),
          rbMaxW: getComputedStyle(rb).maxWidth,
          /* ⚠️ 关键：右栏内容比它的盒子**窄多少** ⇒ 这段差就是"空白一大一小" */
          rbSlack: Math.round(b.right - c.right),
          overflowRight: b.scrollWidth - Math.round(b.width),
        });
      })()`)}`);
      say(`         恢复=` + (await cdp.eval(CLICK_EXIT_TRACE)));
      await new Promise((r) => setTimeout(r, 1200));
      await shot(`s8-wide-restore-r${round}`);
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await new Promise((r) => setTimeout(r, 800));
  } catch (e) {
    say("⚠️ 宽窗口复现失败：" + String(e).slice(0, 160));
  }

  await new Promise((r) => setTimeout(r, 1800));
  await snap("S7 稳态 (+1.8s)");
  await shot("s7-steady");

  /* ══ ⑤ 非浮层态下的左栏收起/展开（用户日常最常走的那条路）═════════════
     ④ 的样本里主区在浮层态是 **null**（聊天页没挂载）⇒ 布局成本比日常低一截。
     而用户报「展开要等半天」时多半**不在浮层态** —— 那一侧挂着**整条会话**，
     左栏每帧变宽都会让聊天列重排 ⇒ 必须单独量一次，否则等于用最轻的场景去解释最重的抱怨。 */
  say("\n═══ ⑤ 非浮层态：左栏收起 → 展开 ═══");
  if (!(await isLeftCollapsed(cdp))) {
    say("  点击左栏按钮（收起）=" + (await cdp.eval(CLICK_LEFT_TOGGLE)));
    await new Promise((r) => setTimeout(r, 1400));
  }
  await snap("S8 非浮层·左栏收起后");
  await shot("s8-inline-left-collapsed");
  await clickAndTraceLeft("⑤ 非浮层 左栏展开");
  await snap("S9 非浮层·左栏展开后");
  await shot("s9-inline-left-expanded");

  say("\n=== 完成 ===");
  process.exit(0);
}

main().catch((e) => { say("❌ 异常：" + e.message); process.exit(1); });
