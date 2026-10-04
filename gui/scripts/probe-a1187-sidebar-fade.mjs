/* eslint-disable */
/**
 * gui/scripts/probe-a1187-sidebar-fade.mjs —— 左/右栏「折叠 / 展开」的逐帧 opacity + 宽度取证。
 *
 * ## 用户现象（A-1187）
 * 「现在不仅仅是尾帧的问题，侧边栏淡入淡出效果都没了，而且左侧边栏展开甚至都异常了。」
 * ⇒ 需要**分别**回答两个问题（不许合并成一句"都有问题"）：
 *   ① 右栏（`.right-wrapper` / `.right-sidebar`）折叠/展开时**到底有没有** opacity 变化？
 *   ② 左栏（`.sidebar`）展开时**异常**是什么形态 —— 宽度不对？还是 opacity 停在 0/中间值？
 *
 * ## 判据
 * · 对每一路，把「t / 宽度 / 计算 opacity / 内联 opacity」的变化点列出来；
 * · 再对"opacity 有几种取值"计数：只有 1 种 ⇒ **没有任何淡入淡出**（把数字摆出来，不靠嘴）。
 *
 * ## ⚠️ 窗口必须可见
 * 窗口 hidden 时 Electron 把 rAF **与** timer **一起停掉**，且**布局都不更新**
 * （`getBoundingClientRect()` 返回旧值）⇒ 采样全假。所以：
 *   · 采样由**探针侧**每隔若干毫秒发一次 CDP eval（eval 在主线程跑，不受页内节流）；
 *   · 跑之前先校验 `document.visibilityState`，不是 visible **直接退出**（绝不拿假数据当结论）；
 *   · **不反复 bringToFront 抢焦点**（那是用户的机器）。
 *
 * 运行：`node gui/scripts/probe-a1187-sidebar-fade.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1187_OUT || "D:/pilot project/gui/out/_a1187-sidebar-fade.txt";
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      /* dev 下渲染层 URL 是 `http://localhost:5173/`（打包后才是 `index.html`）⇒ 两种都要认。 */
      const page = list.find((t) => t.type === "page"
        && (t.url.includes("index.html") || t.url.includes("localhost:5173")));
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

const LEFT_SAMPLE = `JSON.stringify((() => {
  const node = document.querySelector(".sidebar");
  if (!node) { return null; }
  const cs = getComputedStyle(node);
  const b = node.getBoundingClientRect();
  return [Math.round(performance.now() - window.__t0), Math.round(b.width),
    Math.round(Number(cs.opacity) * 1000) / 1000, node.style.opacity || "-",
    node.className];
})())`;

const RIGHT_SAMPLE = `JSON.stringify((() => {
  const w = document.querySelector(".right-wrapper");
  const s = document.querySelector(".right-sidebar");
  if (!w) { return null; }
  const csw = getComputedStyle(w);
  const bw = w.getBoundingClientRect();
  const cs = s ? getComputedStyle(s) : null;
  const bs = s ? s.getBoundingClientRect() : null;
  return [Math.round(performance.now() - window.__t0), Math.round(bw.width), Math.round(bs ? bs.width : 0),
    cs ? Math.round(Number(cs.opacity) * 1000) / 1000 : -1, (s ? (s.style.opacity || "-") : "-"),
    Math.round(Number(csw.opacity) * 1000) / 1000, w.className];
})())`;

const clickByTitle = (re) => `(() => {
  const b = Array.from(document.querySelectorAll("button"))
    .find((x) => ${re}.test(x.getAttribute("title") || ""));
  if (!b) { return "NO"; }
  const t = b.getAttribute("title") || "?";
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK:" + t;
})()`;

const LEFT_BTN = clickByTitle("/侧栏/");
const RIGHT_BTN = clickByTitle("/右侧栏/");

function report(rows, label, opIdx) {
  say(`\n═══ ${label} ═══`);
  if (!rows.length) { say("  ❌ 0 帧 —— 采样器没跑起来"); return null; }
  const marks = []; let last = "";
  for (const r of rows) {
    const k = r.slice(1).join(",");
    if (k !== last) { marks.push(r); last = k; }
  }
  say(`  共 ${rows.length} 帧 · ${marks.length} 个变化点`);
  const hdr = opIdx === "left"
    ? "   t(ms)  sb.w  opacity  inline-op  cls"
    : "   t(ms)  rw.w  rs.w  rs-op  rs-inline  rw-op  cls";
  say(hdr);
  for (const r of marks) { say("  " + r.map((v, i) => i === 0 ? String(v).padStart(6) : String(v)).join("  ")); }
  const ops = [...new Set(rows.map((r) => r[opIdx === "left" ? 2 : 3]))];
  say(`  ▶ opacity 取值集合（${ops.length} 种）：${ops.join(" → ")}`);
  say(ops.length <= 1
    ? `  ⛔ **该路没有任何淡入淡出**（opacity 恒 ${ops[0]}）`
    : `  ✅ 该路存在 opacity 变化`);
  return { marks, ops };
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  /* ⚠️ 只有当窗口**已经不可见**时才去恢复它 —— 本探针通常是跑在"自己刚起的 dev 实例"上，
     不恢复就拿不到数据（hidden 时布局不更新、采样全假）。**绝不无条件 bringToFront**
     （那会在用户自己的窗口上抢焦点）。 */
  let vis = await cdp.eval("document.visibilityState");
  if (vis !== "visible") {
    /* ⚠️⚠️ `Browser.getWindowForTarget` **只在 browser 级端点**存在 —— 在 page 级 ws 上发它会
       报 `-32601 wasn't found`（实测）。browser 级 ws 从 `/json/version` 取。 */
    try {
      const vr = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const ver = await vr.json();
      const b = await Cdp.connect(ver.webSocketDebuggerUrl);
      const w = await b.send("Browser.getWindowForTarget", { targetId: t.id });
      if (w && w.windowId !== undefined) {
        await b.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "normal" } });
        say(`  窗口原本 ${vis} ⇒ 已请求恢复（windowId=${w.windowId}）`);
      }
      try { b.ws.close(); } catch { /* */ }
    } catch (e) { say("  ⚠️ 恢复窗口失败：" + e.message); }
    try { await cdp.send("Page.bringToFront"); } catch { /* 老版本无此命令 */ }
    /* 再给一段时间轮询 —— dev 实例启动后窗口可能还没被系统摆到前台（Chromium 的
       occlusion 判定会把"被完全遮挡"也算成 hidden）。 */
    for (let i = 0; i < 60 && vis !== "visible"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      vis = await cdp.eval("document.visibilityState");
      if (i % 10 === 0) { try { await cdp.send("Page.bringToFront"); } catch { /* */ } }
    }
  }
  say(`visibilityState=${vis}（若为 hidden ⇒ 布局不更新、采样全假，直接退出）`);
  if (vis !== "visible") { say("❌ 窗口不可见 ⇒ 拒绝出结论（不拿假数据当结论）。"); process.exit(2); }

  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      sb: !!document.querySelector(".sidebar"),
      rw: !!document.querySelector(".right-wrapper"),
      lb: !!Array.from(document.querySelectorAll("button")).find((x) => /收起侧栏|展开侧栏/.test(x.getAttribute("title") || "")),
      rb: !!Array.from(document.querySelectorAll("button")).find((x) => /右侧栏/.test(x.getAttribute("title") || "")),
    })`));
    if (st.sb && st.rw && st.lb && st.rb) { ready = true; say(`✅ .sidebar / .right-wrapper / 两个按钮 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未等到 UI 就绪"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 800));

  const run = async (label, sample, btn, opIdx, settleMs = 900) => {
    await cdp.eval(`(() => { window.__t0 = performance.now(); return "OK"; })()`);
    const clicked = await cdp.eval(btn);
    say(`\n[点击] ${label} → ${clicked}`);
    const rows = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const r = JSON.parse(await cdp.eval(sample));
      if (r) { rows.push(r); }
      await new Promise((res) => setTimeout(res, 8));
    }
    const out = report(rows, label, opIdx);
    await new Promise((r) => setTimeout(r, settleMs));
    return out;
  };

  say("\n########## 第一节：左栏（.sidebar）##########");
  await run("① 收起左栏", LEFT_SAMPLE, LEFT_BTN, "left");
  await run("② 展开左栏", LEFT_SAMPLE, LEFT_BTN, "left");

  say("\n########## 第二节：右栏（.right-wrapper/.right-sidebar）##########");
  const st = await cdp.eval(`JSON.stringify({
    lb: (Array.from(document.querySelectorAll("button")).find((x) => /收起侧栏|展开侧栏/.test(x.getAttribute("title") || "")) || {}).title,
    rb: (Array.from(document.querySelectorAll("button")).find((x) => /右侧栏/.test(x.getAttribute("title") || "")) || {}).title,
  })`);
  say(`  当前标题：left=${JSON.parse(st).lb} right=${JSON.parse(st).rb}`);
  await run("③ 收起右栏", RIGHT_SAMPLE, RIGHT_BTN, "right");
  await run("④ 展开右栏", RIGHT_SAMPLE, RIGHT_BTN, "right");

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
