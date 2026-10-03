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

  say("\n═══ ① 点「窗口化」 ═══");
  say("点击=" + (await cdp.eval(CLICK_FLOAT)));
  await waitSettle("①窗口化过渡");
  await new Promise((r) => setTimeout(r, 600));
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
  /* ⚠️ 逐帧盯 `--left-w`：它一旦与左栏实宽失同步，浮层稳态的
     `calc(100% - var(--left-w))` 就会让右栏右缘越窗（用户现象④「被挤压到屏幕外」）。
     ⇒ 这里不是"等 1.5s 再看一眼"，而是把整条轨迹记下来。 */
  const traceLeftW = async (label, ms = 1800) => {
    const t0 = Date.now();
    const tr = [];
    while (Date.now() - t0 < ms) {
      const o = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
      tr.push(`${Date.now() - t0}ms sb.w=${o.sb ? o.sb.w : "-"} left-w=${o.leftWVar} rw.w=${o.rw ? o.rw.w : "-"} rw.r=${o.rw ? o.rw.r : "-"}`);
      await new Promise((r) => setTimeout(r, 120));
    }
    say(`  📈 ${label}：${tr.join(" | ")}`);
  };
  for (let i = 0; i < 3; i++) {
    if (!(await isLeftCollapsed(cdp))) { say("  已是展开态，不点"); break; }
    say("  点击左栏按钮=" + (await cdp.eval(CLICK_LEFT_TOGGLE)));
    await traceLeftW(`左栏展开轨迹 #${i + 1}`);
  }
  await snap("S5 左栏展开后");
  await shot("s5-left-expanded");

  say("\n═══ ④c 恢复窗口化（点浮窗按钮退回中间页） ═══");
  say("点击=" + (await cdp.eval(CLICK_FLOAT)));
  await waitSettle("④退浮层过渡");
  await new Promise((r) => setTimeout(r, 600));
  await snap("S6 恢复窗口化后");
  await shot("s6-float-restored");

  await new Promise((r) => setTimeout(r, 1800));
  await snap("S7 稳态 (+1.8s)");
  await shot("s7-steady");

  say("\n=== 完成 ===");
  process.exit(0);
}

main().catch((e) => { say("❌ 异常：" + e.message); process.exit(1); });
