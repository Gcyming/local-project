/* eslint-disable */
/**
 * gui/scripts/probe-a1172-float-left.mjs —— **浮层态**下「左栏折叠 / 展开」取证。
 *
 * 假设：A-1166 把 `--left-w` 的写入从「实测宽」改成「目标宽 sidebarWidthRef.current」，
 * 于是**折叠**时（左栏实际宽 0）它仍写 240 ⇒ `.right-wrapper` 的
 * `width: calc(100% - var(--left-w))` 少算 240 ⇒ 右栏**右侧留一条空白**。
 * 判据：浮层稳态下 `rw.right` 必须 == `innerWidth`；`--left-w` 必须 == 左栏实际宽。
 *
 * 前置：`cd gui && SLIME_DEVTOOLS_PORT=9444 env -u ELECTRON_RUN_AS_NODE \
 *        ./node_modules/electron/dist/electron.exe .`
 * 运行：`node gui/scripts/probe-a1172-float-left.mjs`
 */
import fs from "node:fs";

const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1170F_OUT || "D:/pilot project/gui/out/_a1172-floatleft.txt";
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

const SNAP = `window.__snap2 = function () {
  const R = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return { l: Math.round(b.left), w: Math.round(b.width), r: Math.round(b.right) }; };
  const rw = document.querySelector(".right-wrapper");
  const sb = document.querySelector(".sidebar");
  const rs = document.querySelector(".right-sidebar");
  const rb = document.querySelector(".right-body");
  return {
    vw: window.innerWidth,
    bodyCls: Array.from(document.body.classList).join(" "),
    sb: R(sb), rw: R(rw), rs: R(rs), rb: R(rb),
    sbCollapsed: sb ? sb.classList.contains("collapsed") : null,
    sbInlineW: sb ? (sb.style.width || "(none)") : null,
    leftWVar: rw ? (rw.style.getPropertyValue("--left-w") || "(none)") : null,
    rwInlineW: rw ? (rw.style.width || "(none)") : null,
    rsInlineW: rs ? (rs.style.width || "(none)") : null,
    tgtW: rw ? (rw.style.getPropertyValue("--right-target-w") || "(none)") : null,
    /* ⚠️ 判据：浮层稳态右栏右缘应贴住窗口右缘 */
    gapRight: rw ? Math.round(window.innerWidth - rw.getBoundingClientRect().right) : null,
    /* 右栏内容是否铺满自己的盒子 */
    fillRatio: (rs && rb) ? +(rb.getBoundingClientRect().width / Math.max(1, rs.getBoundingClientRect().width)).toFixed(3) : null,
    overflowRight: [sb, rw, rs, rb].filter(Boolean)
      .map((el) => Math.round(el.getBoundingClientRect().right)).filter((v) => v > window.innerWidth + 1),
  };
}; "__ready__";`;

const CLICK_FLOAT = `(() => {
  const img = document.querySelector('img[alt="唤起悬浮窗"]');
  if (!img) { return "NO-FLOAT-BTN"; }
  const b = img.closest("button") || img.parentElement;
  (b || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK";
})()`;

const CLICK_LEFT = `(() => {
  const btns = Array.from(document.querySelectorAll("header.titlebar button, .titlebar button"));
  const t = btns.find((b) => /侧栏|侧边栏/.test(b.getAttribute("title") || ""));
  if (!t) { return "NO-BTN"; }
  const sb = document.querySelector(".sidebar");
  const before = (t.getAttribute("title") || "?") + " collapsed=" + (sb ? sb.classList.contains("collapsed") : "?");
  t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "CLICKED(" + before + ")";
})()`;

async function main() {
  const t = await getTarget();
  say(`CDP 目标：${t.title}`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  say("重载…");
  await cdp.send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 4500));
  try { await cdp.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({ btn: !!document.querySelector('img[alt="唤起悬浮窗"]') })`));
    if (st.btn) { ready = true; say(`✅ 启动门已过（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!ready) { say("❌ 未等到启动门"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1200));
  await cdp.eval(SNAP);

  const snap = async (tag) => {
    const o = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap2())`));
    say(`\n【${tag}】`);
    say(`  vw=${o.vw} bodyCls="${o.bodyCls}" sbCollapsed=${o.sbCollapsed}`);
    say(`  sb=${JSON.stringify(o.sb)} rw=${JSON.stringify(o.rw)} rs=${JSON.stringify(o.rs)} rb=${JSON.stringify(o.rb)}`);
    say(`  left-w="${o.leftWVar}" rwInlineW="${o.rwInlineW}" rsInlineW="${o.rsInlineW}" tgtW="${o.tgtW}"`);
    say(`  ⚠️ gapRight(右栏右缘到窗口右缘)=${o.gapRight}px  fillRatio=${o.fillRatio}  overflowRight=${JSON.stringify(o.overflowRight)}`);
    if (o.gapRight !== null) { say(`     ⇒ ${o.gapRight <= 1 ? "✓ 右栏铺满" : "❌ 右栏右侧留了 " + o.gapRight + "px 空白"}`); }
  };

  await snap("S0 初始（非浮层）");

  say("\n═══ ① 点窗口化 → 浮层态 ═══");
  say("  点击=" + (await cdp.eval(CLICK_FLOAT)));
  await new Promise((r) => setTimeout(r, 2600));
  await snap("S1 浮层稳态（左栏展开）");

  say("\n═══ ② 浮层态下**折叠**左栏 ═══");
  say("  点击=" + (await cdp.eval(CLICK_LEFT)));
  await new Promise((r) => setTimeout(r, 2600));
  await snap("S2 浮层·左栏折叠后");

  say("\n═══ ③ 浮层态下**展开**左栏 ═══");
  say("  点击=" + (await cdp.eval(CLICK_LEFT)));
  await new Promise((r) => setTimeout(r, 2600));
  await snap("S3 浮层·左栏再展开后");

  say("\n═══ ④ 退浮层 ═══");
  say("  点击=" + (await cdp.eval(CLICK_FLOAT)));
  await new Promise((r) => setTimeout(r, 2600));
  await snap("S4 退浮层后");

  say("\n=== 完成 ===");
  process.exit(0);
}

main().catch((e) => { say("❌ 异常：" + e.message); process.exit(1); });
