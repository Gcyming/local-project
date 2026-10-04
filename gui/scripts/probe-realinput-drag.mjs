/* eslint-disable */
/**
 * gui/scripts/probe-realinput-drag.mjs — A-1154：用 **CDP Input 域的真实输入事件**驱动右栏拖拽。
 *
 * ## 为什么不能只用 dispatchEvent
 * `probe-sidebar-e2e-cdp.mjs` 用 `new PointerEvent(...)` + `dispatchEvent` —— 那是**合成事件**，
 * 绕过了浏览器真实的输入管线，尤其是 **pointer capture**（`setPointerCapture` 之后事件被重定向
 * 到捕获元素，而合成事件直接派发到目标，不经过这条路径）。用户是**真鼠标**操作的，
 * 所以拖拽类现象（⑥不跟手 / ⑦闪烁）必须用 `Input.dispatchMouseEvent` 走真实管线复验。
 *
 * ## 用法
 *   cd gui && SLIME_DEVTOOLS_PORT=9336 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
 *   node gui/scripts/probe-realinput-drag.mjs
 */
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9336);
import fs from "node:fs";
const OUT = process.env.SLIME_RI_OUT || "D:/pilot project/gui/out/_realinput-drag.txt";
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

/* 页面内采样器：只记"变化点"，避免刷屏 */
const SNAP = `window.__snap = function () {
  const R = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const rs = document.querySelector(".right-sidebar");
  const mainEl = document.querySelector("main.main");
  const chat = document.querySelector(".chat-scroll");
  const cs = chat ? getComputedStyle(chat) : null;
  return {
    cls: Array.from(document.body.classList).filter((c) => c.startsWith("float") || c.startsWith("slime")).join("|"),
    rs: R(rs), rsStyleW: rs ? (rs.style.width || "") : "",
    main: R(mainEl),
    chatOpacity: cs ? cs.opacity : "",
    chatCV: cs ? cs.contentVisibility : "",
    resizer: document.querySelectorAll(".right-sidebar-resizer").length,
  };
}; "__ok__";`;

const RECORDER = `window.__rec = { on: false, out: [], t0: 0, last: "" };
window.__recStart = function () { window.__rec = { on: true, out: [], t0: performance.now(), last: "" }; };
window.__recStop = function () { window.__rec.on = false; return JSON.stringify(window.__rec.out); };
(function loop() {
  if (window.__rec && window.__rec.on) {
    const s = window.__snap();
    const key = JSON.stringify([s.cls, s.rs, s.main, s.chatOpacity, s.chatCV]);
    if (key !== window.__rec.last) {
      window.__rec.last = key;
      window.__rec.out.push({ t: Math.round(performance.now() - window.__rec.t0), cls: s.cls,
        rsW: s.rs ? s.rs[2] : null, mainW: s.main ? s.main[2] : null, op: s.chatOpacity, cv: s.chatCV });
    }
  }
  requestAnimationFrame(loop);
})(); "__ok__";`;

async function main() {
  const t = await getTarget();
  say(`CDP 目标：${t.title}`);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  await sleep(300);
  const vis = JSON.parse(await cdp.eval(`JSON.stringify({hidden:document.hidden,vs:document.visibilityState})`));
  say(`可见性：${JSON.stringify(vis)}`);
  if (vis.hidden) { say("⚠️ 页面不可见 ⇒ rAF 停摆，结果不可采信。"); }

  say("重载回干净初始态…");
  await cdp.send("Page.reload", {});
  await sleep(3500);
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  for (let i = 0; i < 40; i++) {
    const ok = await cdp.eval(`!!document.querySelector('img[alt="唤起悬浮窗"]')`);
    if (ok) { break; }
    await sleep(800);
  }
  await cdp.eval(SNAP);
  await cdp.eval(RECORDER);
  await sleep(200);

  /* 找 resizer 的真实屏幕坐标（含 devicePixelRatio 无关，CDP Input 用 CSS 像素） */
  const geo = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return JSON.stringify({ok:false}); }
    const b = h.getBoundingClientRect();
    return JSON.stringify({ ok:true, x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2), w: Math.round(b.width), h: Math.round(b.height) });
  })()`));
  say(`resizer 几何：${JSON.stringify(geo)}`);
  if (!geo.ok) { say("❌ 无 resizer（是否仍在浮层态？）"); process.exit(1); }

  say("");
  say("════ 真实输入：按住 → 分步向左拖 200px → 松手（每步 16ms，模拟真鼠标） ════");
  await cdp.eval(`window.__recStart()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x, y: geo.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 20; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x - i * 10, y: geo.y, button: "left", buttons: 1 });
    await sleep(16);
  }
  const recDrag = JSON.parse(await cdp.eval(`window.__recStop()`));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x - 200, y: geo.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(900);
  const afterDrag = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  say(`拖动轨迹（${recDrag.length} 个变化点）：`);
  for (const r of recDrag.slice(0, 40)) { say(`  t=${String(r.t).padStart(5)}ms cls=[${r.cls}] rsW=${r.rsW} mainW=${r.mainW} chatOp=${r.op} chatCV=${r.cv}`); }
  if (recDrag.length > 40) { say(`  …省略 ${recDrag.length - 40} 个`); }
  say(`松手后：${JSON.stringify(afterDrag)}`);
  say(`⇒ 每步位移 10px，轨迹是否精确跟随：${(() => {
    const ws = recDrag.map((r) => r.rsW).filter((w) => w != null);
    let jumps = 0;
    for (let i = 1; i < ws.length; i++) { if (Math.abs(ws[i] - ws[i - 1]) > 25) { jumps++; } }
    return jumps === 0 ? "✅ 无跳变（跟手）" : `⚠️ ${jumps} 处跳变`;
  })()}`);
  say(`⇒ 拖动中 chat 是否被隐藏（content-visibility: hidden / opacity 0）：${recDrag.some((r) => r.cv === "hidden" || r.op === "0") ? "是（第二阶段生效，符合设计）" : "否"}`);
  say(`⇒ 松手后是否残留临时类：${afterDrag.cls === "" ? "✅ 无残留" : "❌ 残留 [" + afterDrag.cls + "]"}`);

  say("");
  say("════ 真实输入：快速来回拖 30 次（每步 8ms）→ 松手 → 静置 ════");
  /* ⚠️ 上一轮拖动把右栏挪了位 ⇒ resizer 的屏幕坐标必须**重新量**，
     否则鼠标按在 `.right-sidebar` 主体上（不是 resizer）⇒ pointerdown 不触发拖拽，
     轨迹只有一个变化点，会被误读成"没有拖拽/闪烁"。 */
  const geo2 = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return JSON.stringify({ok:false}); }
    const b = h.getBoundingClientRect();
    return JSON.stringify({ ok:true, x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) });
  })()`));
  say(`resizer 新几何：${JSON.stringify(geo2)}`);
  if (!geo2.ok) { say("❌ 无 resizer"); process.exit(1); }
  await cdp.eval(`window.__recStart()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo2.x, y: geo2.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 0; i < 30; i++) {
    const x = i % 2 === 0 ? geo2.x - 100 : geo2.x + 40;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: geo2.y, button: "left", buttons: 1 });
    await sleep(8);
  }
  const recFast = JSON.parse(await cdp.eval(`window.__recStop()`));
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo2.x, y: geo2.y, button: "left", buttons: 0, clickCount: 1 });
  say(`快速拖轨迹（${recFast.length} 个变化点）：`);
  for (const r of recFast.slice(0, 30)) { say(`  t=${String(r.t).padStart(5)}ms cls=[${r.cls}] rsW=${r.rsW} chatOp=${r.op} chatCV=${r.cv}`); }
  if (recFast.length > 30) { say(`  …省略 ${recFast.length - 30} 个`); }
  const clsSet = new Set(recFast.map((r) => r.cls));
  say(`⇒ 出现过的类组合：${JSON.stringify(Array.from(clsSet))}`);
  /* 闪烁判据：chat opacity 在「1 → 0 → 1」反复的次数（每次拖动只应发生一次淡出，不应抖） */
  const ops = recFast.map((r) => r.op).filter((o) => o !== "");
  let flips = 0;
  for (let i = 1; i < ops.length; i++) { if (ops[i] !== ops[i - 1]) { flips++; } }
  say(`⇒ chat opacity 变化次数：${flips}（${flips <= 6 ? "✅ 正常（仅淡出+淡入）" : "⚠️ 抖动偏多"})`);

  await sleep(1600);
  const rest = JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  say(`静置 1.6s 后：${JSON.stringify(rest)}`);
  say(`⇒ 残留检查：${rest.cls === "" ? "✅ 完全无残留" : "❌ [" + rest.cls + "]"}`);

  say("");
  say("完成。产物：" + OUT);
  cdp.ws.close();
  process.exit(0);
}
main().catch((e) => { say("❌ " + (e && e.stack || e)); process.exit(1); });
