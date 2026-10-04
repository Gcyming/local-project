/* eslint-disable */
/**
 * gui/scripts/probe-visual-drag.mjs — A-1154：**视觉取证**。拖动过程中逐帧截图，肉眼判读闪烁。
 *
 * ## 为什么需要它
 * 前几个探针量的都是**数值**（宽度、class、opacity 计算值）。但用户说的是"**看着**闪烁"
 * —— 数值正常不等于画面正常（例如元素被裁切、滚动条跳动、内容重绘）。
 * 本探针用 CDP `Page.captureScreenshot` 在拖动过程中连拍，落盘成 PNG 供肉眼判读。
 *
 * 运行：
 *   node gui/scripts/probe-visual-drag.mjs
 */
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9336);
import fs from "node:fs";
import path from "node:path";
const OUTDIR = process.env.SLIME_VIS_DIR || "D:/pilot project/gui/out/_vis-drag";
fs.mkdirSync(OUTDIR, { recursive: true });
const lines = [];
const say = (m) => { lines.push(m); process.stdout.write(m + "\n"); };
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
  async shot(tag) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const f = path.join(OUTDIR, `${tag}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, "base64"));
    return f;
  }
}

async function main() {
  const t = await getTarget();
  say(`CDP 目标：${t.title}`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  await sleep(300);

  say("重载回干净初始态…");
  await cdp.send("Page.reload", {});
  await sleep(3500);
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  for (let i = 0; i < 40; i++) {
    if (await cdp.eval(`!!document.querySelector('img[alt="唤起悬浮窗"]')`)) { break; }
    await sleep(800);
  }
  await sleep(600);

  const geo = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return JSON.stringify({ok:false}); }
    const b = h.getBoundingClientRect();
    return JSON.stringify({ ok:true, x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) });
  })()`));
  say(`resizer 几何：${JSON.stringify(geo)}`);
  if (!geo.ok) { say("❌ 无 resizer"); process.exit(1); }

  say("");
  say("── 基线截图（拖动前）──");
  say("  " + await cdp.shot("00-baseline"));

  /* ⚠️⚠️ 拖动方向：右栏 resizer 在**左边缘** ⇒ 鼠标**向右** = 右栏变窄、**向左** = 变宽。
     而上一轮探针常把宽度留在 `rightSidebarMaxW()` 上限（实测 715）⇒ 继续向左拖（变宽）
     会被上限钳回原值 ⇒ 十四张截图宽度全同，会被**误判成"拖不动"**（我第一版就踩了）。
     ⇒ 本探针统一**向右拖（变窄方向）**：只要不在 minW 附近，必然每步都有位移，判据才有效。 */
  const dragDir = 1; // +1 = 鼠标向右，右栏变窄
  say("");
  say("── 拖动中逐帧截图（每 30ms 一张，向右拖 200px＝右栏变窄）──");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x, y: geo.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 14; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x + dragDir * i * 14, y: geo.y, button: "left", buttons: 1 });
    await sleep(30);
    const f = await cdp.shot(`${String(i).padStart(2, "0")}-dragging-${i * 14}px`);
    const s = JSON.parse(await cdp.eval(`JSON.stringify({
      cls: Array.from(document.body.classList).filter(c => c.startsWith("slime")).join("|"),
      rsW: Math.round((document.querySelector(".right-sidebar")||{getBoundingClientRect:()=>({width:-1})}).getBoundingClientRect().width),
      cv: getComputedStyle(document.querySelector(".chat-scroll")).contentVisibility,
      op: getComputedStyle(document.querySelector(".chat-scroll")).opacity,
    })`));
    say(`  ${i * 14}px: cls=[${s.cls}] rsW=${s.rsW} chatCV=${s.cv} chatOp=${s.op} → ${path.basename(f)}`);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x + dragDir * 196, y: geo.y, button: "left", buttons: 0, clickCount: 1 });

  say("");
  say("── 松手后立即连拍 5 张（每 60ms）──");
  for (let i = 1; i <= 5; i++) {
    await sleep(60);
    const f = await cdp.shot(`5${i}-after-release-${i * 60}ms`);
    const s = JSON.parse(await cdp.eval(`JSON.stringify({
      cls: Array.from(document.body.classList).filter(c => c.startsWith("slime")).join("|"),
      rsW: Math.round((document.querySelector(".right-sidebar")||{getBoundingClientRect:()=>({width:-1})}).getBoundingClientRect().width),
      cv: getComputedStyle(document.querySelector(".chat-scroll")).contentVisibility,
      op: getComputedStyle(document.querySelector(".chat-scroll")).opacity,
    })`));
    say(`  +${i * 60}ms: cls=[${s.cls}] rsW=${s.rsW} chatCV=${s.cv} chatOp=${s.op} → ${path.basename(f)}`);
  }
  await sleep(1200);
  say("  静置后 → " + path.basename(await cdp.shot("99-settled")));

  say("");
  say(`截图目录：${OUTDIR}`);
  fs.writeFileSync(path.join(OUTDIR, "_log.txt"), lines.join("\n"), "utf8");
  cdp.ws.close();
  process.exit(0);
}
main().catch((e) => { say("❌ " + (e && e.stack || e)); process.exit(1); });
