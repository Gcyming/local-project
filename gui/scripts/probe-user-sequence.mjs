/* eslint-disable */
/**
 * gui/scripts/probe-user-sequence.mjs — A-1154：**严格按用户原话**逐步操作 + 每步截图。
 *
 * 用户报告的现象序列（第一轮原话）：
 *   ① 正常：直接点「对话页面窗口化」→ 右栏内容自适应正常
 *   ② 再点标题栏「收起右侧边栏」→ 「对话页自适应窗口调整失效」
 *   ③ 再点「展开右侧边栏」→ 「对话内容被挤压到屏幕外、被切割」
 *   ④ 再点「窗口化」→ 「抽搐抖动但不窗口化」；再点一次 → 回到①
 *   ⑤ 恢复窗口化到原位 → 右栏拖拽比例功能异常，要左右多拖几次才恢复
 *   ⑥ 拖拽不跟手
 *   ⑦ 一拖拽对话页闪烁
 *
 * 本探针把 ①②③④⑤ 走完整，**每步落一张 PNG**，并同步输出几何快照。
 *
 * 运行：
 *   node gui/scripts/probe-user-sequence.mjs
 */
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9340);
import fs from "node:fs";
import path from "node:path";
const OUTDIR = process.env.SLIME_SEQ_DIR || "D:/pilot project/gui/out/_user-seq";
fs.mkdirSync(OUTDIR, { recursive: true });
const OUT = path.join(OUTDIR, "_log.txt");
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 40000);
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
    return path.basename(f);
  }
}

const SNAP = `window.__snap = function () {
  const R = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const rs = document.querySelector(".right-sidebar");
  const mainEl = document.querySelector("main.main");
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    cls: Array.from(document.body.classList).filter((c) => c.startsWith("float") || c.startsWith("slime")).join("|"),
    main: R(mainEl), fw: R(document.querySelector(".float-window")), rs: R(rs),
    rsW: rs ? rs.style.width || "" : "",
    tgt: rs ? getComputedStyle(rs).getPropertyValue("--right-target-w").trim() : "",
    resizer: document.querySelectorAll(".right-sidebar-resizer").length,
  };
}; "__ok__";`;

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
  if (vis.hidden) { say("⚠️ 页面不可见 ⇒ rAF 停摆，几何判据不可采信。"); }

  /* ⚠️ 干净初始态：必须重载（否则继承上一轮探针的浮层/脏 CSS 变量）。
     同时**清掉宽度偏好**，让 ①②③④⑤ 从"用户第一次打开 App"的状态走起。 */
  await cdp.eval(`try { localStorage.removeItem("slime_rightbar_w"); localStorage.removeItem("slime_sidebar_w"); } catch(e) {} "ok"`);
  await cdp.send("Page.reload", {});
  await sleep(3800);
  try { await cdp.send("Page.bringToFront"); } catch { /* 可忽略 */ }
  for (let i = 0; i < 40; i++) {
    if (await cdp.eval(`!!document.querySelector('img[alt="唤起悬浮窗"]')`)) { break; }
    await sleep(800);
  }
  await cdp.eval(SNAP);
  await sleep(600);

  const clickFloat = `(() => {
    const img = document.querySelector('img[alt="唤起悬浮窗"]');
    if (!img) { return "NO-FLOAT"; }
    const b = img.closest("button") || img.parentElement;
    (b || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK";
  })()`;
  const clickTitleRight = `(() => {
    const hdr = document.querySelector("header.titlebar");
    if (!hdr) { return "NO-TITLEBAR"; }
    const t = Array.from(hdr.querySelectorAll("button.titlebar-btn")).find((b) => /右侧栏/.test(b.getAttribute("title") || ""));
    if (!t) { return "NO-RIGHTBTN"; }
    const before = t.getAttribute("title");
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK(" + before + ")";
  })()`;

  const snap = async () => JSON.parse(await cdp.eval(`JSON.stringify(window.__snap())`));
  /* ⚠️ 文件名不能用中文（`Page.captureScreenshot` 落盘 + shell 都容易踩编码坑），
     用序号 + ASCII slug；中文说明只留在日志里。 */
  let shotSeq = 0;
  const step = async (tag, clickExpr, waitMs = 1400) => {
    say("");
    say(`════ ${tag} ════`);
    if (clickExpr) { say("  动作：" + await cdp.eval(clickExpr)); await sleep(60); }
    await sleep(waitMs);
    const f = await cdp.shot(`${String(++shotSeq).padStart(2, "0")}-${tag.replace(/[^\x20-\x7e]/g, "").replace(/[^\w-]/g, "-").replace(/-+/g, "-") || "step"}`);
    const s = await snap();
    say(`  快照：${JSON.stringify(s)}`);
    say(`  截图：${f}`);
    return s;
  };

  const g0 = await snap();
  say("初始：" + JSON.stringify(g0));
  say("");

  /* ── 用户现象 ①：直接点「对话页面窗口化」 ── */
  await step("①-点窗口化", clickFloat);
  /* ── 用户现象 ②：点标题栏「收起右侧边栏」 ── */
  await step("②-收起右侧栏", clickTitleRight);
  /* ── 用户现象 ③：再点「展开右侧边栏」 ── */
  await step("③-展开右侧栏", clickTitleRight);
  /* ── 用户现象 ④：再点「窗口化」（第一次） ── */
  await step("④a-窗口化第1次", clickFloat);
  /* ── 用户现象 ④：再点「窗口化」（第二次，应回到 ①） ── */
  await step("④b-窗口化第2次", clickFloat);
  /* ── 用户现象 ⑤：确认普通布局后，验证拖拽可正常改比例 ── */
  const g5 = await snap();
  say("");
  say(`⑤-前置：cls=[${g5.cls}] resizer=${g5.resizer} rs=${JSON.stringify(g5.rs)}`);
  if (g5.cls.includes("float-layout")) {
    say("  ⚠️ 仍在浮层 → 主动点一次窗口化退出");
    await cdp.eval(clickFloat);
    await sleep(1400);
  }
  {
    const s = await snap();
    say(`  → cls=[${s.cls}] resizer=${s.resizer} rs=${JSON.stringify(s.rs)}`);
  }
  /* ── ⑤：真实输入拖拽（向右＝变窄） ── */
  const geo = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return JSON.stringify({ok:false}); }
    const b = h.getBoundingClientRect();
    return JSON.stringify({ ok:true, x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) });
  })()`));
  if (geo.ok) {
    say("");
    say(`⑤-真实拖拽（右栏 resizer 从 x=${geo.x} 向右拖 150px = 变窄，应逐帧跟随）`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x, y: geo.y, button: "left", buttons: 1, clickCount: 1 });
    const trail = [];
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x + i * 15, y: geo.y, button: "left", buttons: 1 });
      await sleep(25);
      trail.push((await snap()).rs[2]);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x + 150, y: geo.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(700);
    const after = await snap();
    say(`  轨迹（每步 +15px）：${JSON.stringify(trail)}`);
    say(`  ⇒ ${trail.length > 1 && trail[0] !== trail[trail.length - 1] ? "✅ 宽度跟随鼠标变化" : "❌ 宽度未变化"}`);
    say(`  松手后：cls=[${after.cls}] rs=${JSON.stringify(after.rs)}`);
    await cdp.shot(`${String(++shotSeq).padStart(2, "0")}-after-drag`);
  } else {
    say("❌ 无 resizer，无法验拖拽");
  }

  say("");
  say("完成。产物：" + OUT);
  cdp.ws.close();
  process.exit(0);
})().catch((e) => { say("❌ " + (e && e.stack || e)); process.exit(1); });
