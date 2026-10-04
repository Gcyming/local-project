/* eslint-disable */
/**
 * gui/scripts/probe-drag-robust.mjs — A-1154：拖拽**鲁棒性**探针。
 *
 * 动机：视觉取证（probe-visual-drag.mjs）发现一个**可复现的失败模式**：
 *   pointerdown 生效（`slime-dragging` 挂上、对话区淡出），但**整个拖动过程宽度纹丝不动**
 *   （`rsW` 恒定），松手后也没落新宽度 ⇒ 用户看到的是"内容啪地消失，面板不跟手"。
 * 本探针反复做多轮"按下→移动→松手"，统计 **pointermove 是否被 `onMove` 收到**，
 * 以及失败轮次有什么共同点（是否与 resizer 位置、pointerId、capture 状态有关）。
 *
 * 判据：在页面内包裹 `Element.prototype.setPointerCapture` / document 上的 pointermove
 * 监听，直接统计"收到的 pointermove 条数"与"宽度是否变化"，把失败轮次的现场打出来。
 *
 * 运行：
 *   node gui/scripts/probe-drag-robust.mjs
 */
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9336);
import fs from "node:fs";
const OUT = process.env.SLIME_DR_OUT || "D:/pilot project/gui/out/_drag-robust.txt";
const lines = [];
const say = (m) => { lines.push(m); process.stdout.write(m + "\n"); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) { return page; }
    } catch { /* 还没起 */ }
    await sleep(700);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { throw new Error("eval 异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
    return r.result.value;
  }
}

/* 埋点：统计 pointer 事件实际到达 document 的次数，以及 resizer 上 setPointerCapture 的调用/结果 */
const INSTRUMENT = `(() => {
  if (window.__inst) { return "already"; }
  window.__inst = { docMove: 0, docUp: 0, rsDown: 0, capOk: 0, capFail: 0, moves: [] };
  document.addEventListener("pointermove", (e) => { window.__inst.docMove++; window.__inst.moves.push({ x: Math.round(e.clientX), id: e.pointerId, tgt: (e.target && e.target.className || "").toString().slice(0, 24) }); }, true);
  document.addEventListener("pointerup", () => { window.__inst.docUp++; }, true);
  const rs = document.querySelector(".right-sidebar-resizer");
  if (rs && !rs.__instPatched) {
    rs.__instPatched = true;
    rs.addEventListener("pointerdown", () => { window.__inst.rsDown++; }, true);
    const origCap = rs.setPointerCapture.bind(rs);
    rs.setPointerCapture = function (id) { try { const r = origCap(id); window.__inst.capOk++; return r; } catch (e) { window.__inst.capFail++; throw e; } };
  }
  return "ok";
})()`;

(async () => {
  const t = await getTarget();
  say(`CDP 目标：${t.title}`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  await sleep(300);
  const vis = JSON.parse(await cdp.eval(`JSON.stringify({hidden:document.hidden,vs:document.visibilityState})`));
  say(`可见性：${JSON.stringify(vis)}`);

  say("重载回干净初始态…");
  await cdp.send("Page.reload", {});
  await sleep(3500);
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  for (let i = 0; i < 40; i++) {
    if (await cdp.eval(`!!document.querySelector('img[alt="唤起悬浮窗"]')`)) { break; }
    await sleep(800);
  }
  await sleep(800);
  say("埋点注入：" + await cdp.eval(INSTRUMENT));
  say("");

  const N = 8;
  let okCount = 0, failCount = 0;
  for (let round = 1; round <= N; round++) {
    const geo = JSON.parse(await cdp.eval(`(() => {
      const h = document.querySelector(".right-sidebar-resizer");
      if (!h) { return JSON.stringify({ok:false}); }
      const b = h.getBoundingClientRect();
      return JSON.stringify({ ok:true, x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) });
    })()`));
    if (!geo.ok) { say(`第 ${round} 轮：❌ 无 resizer`); break; }
    const before = JSON.parse(await cdp.eval(`JSON.stringify({
      w: Math.round(document.querySelector(".right-sidebar").getBoundingClientRect().width),
      inst: window.__inst })`));
    await cdp.eval(`window.__inst.docMove = 0; window.__inst.rsDown = 0; window.__inst.moves = []; window.__inst.capOk = 0; window.__inst.capFail = 0; "reset"`);

    const DX = round % 2 === 1 ? -120 : 120; // 交替方向，避免撞上下限
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x, y: geo.y, button: "left", buttons: 1, clickCount: 1 });
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x + Math.round(DX * i / steps), y: geo.y, button: "left", buttons: 1 });
      await sleep(16);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x + DX, y: geo.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(400);

    const after = JSON.parse(await cdp.eval(`JSON.stringify({
      w: Math.round(document.querySelector(".right-sidebar").getBoundingClientRect().width),
      cls: Array.from(document.body.classList).filter(c=>c.startsWith("slime")).join("|"),
      inst: window.__inst })`));
    const moved = Math.abs(after.w - before.w) > 20;
    const moveRecv = after.inst.docMove;
    if (moved) { okCount++; } else { failCount++; }
    say(`第 ${round} 轮(${DX > 0 ? "→" : "←"}${Math.abs(DX)}px)：resizerX=${geo.x} 宽 ${before.w} → ${after.w}  ` +
        `${moved ? "✅ 跟随" : "❌ 未跟随"}｜docMove=${moveRecv}/${steps} rsDown=${after.inst.rsDown} capOk=${after.inst.capOk} capFail=${after.inst.capFail} cls=[${after.cls}]`);
    if (!moved) {
      say(`     失败现场 moves 前 5 条：${JSON.stringify(after.inst.moves.slice(0, 5))}`);
    }
  }
  say("");
  say(`统计：成功 ${okCount} / 失败 ${failCount}（共 ${N} 轮）`);
  say(`⇒ ${failCount === 0 ? "✅ 拖拽稳定跟随" : "❌ 存在失败轮次 ⇒ 真实缺陷（用户'不跟手'的成因）"}`);
  say("");
  say("完成。产物：" + OUT);
  cdp.ws.close();
  process.exit(0);
})().catch((e) => { say("❌ " + (e && e.stack || e)); process.exit(1); });
