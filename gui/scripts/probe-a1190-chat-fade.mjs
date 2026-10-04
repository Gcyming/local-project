/* eslint-disable */
/**
 * gui/scripts/probe-a1190-chat-fade.mjs —— A-1190 的**真机端到端取证**。
 *
 * ## 要回答的两件事（用户原话，不许合并成一句"好了"）
 * 「现在的消失判定是一点击侧边栏的边缘，还没有拖拽就消失，这不对，改成只有发生**实质性比例变化**
 *  才会消失。还有，现在中间的渐入渐出都是与侧边栏**错开**设计的……改成**同步**的吧。」
 *  ⇒ ① **只按下（pointerdown）、不移动** ⇒ 聊天页 `.chat-scroll` 的 opacity **必须恒为 1**
 *       （body 上只许出现 `slime-dragging`，**不许**出现 `slime-fading`）。
 *  ⇒ ② 点折叠/展开按钮（宽度**真的**在变）⇒ 聊天页 opacity 的**整段动画**与侧边栏宽度过渡
 *       **同起同落**（A-1190② 的正解是"凹陷"：先淡到 0、再在同一个 500ms 窗口内回到 1）。
 *       旧结构（三段式）= 淡出 500 + 停住 40 + 淡入 500 ⇒ **~1020ms** 才回到 1，
 *       后半段侧边栏已静止 ⇒ 肉眼"错开"（用户第二轮报障）。
 *
 * ## 判据（把数字摆出来，不靠嘴）
 * · ①：pointerdown 后 300ms 内，`.chat-scroll` 的 computed opacity 取值集合必须 == {1}，
 *      且 body class 里没有 `slime-fading`。
 * · ②③：打印 (t, sb.w, chatOp, cls) 的**变化点**，判据 = 凹陷真的发生（最低 opacity < 0.9）
 *      且**回到 1 的时刻 ≤ 650ms**（合上留 150ms 余量；旧结构 ~1020ms 会被判 ❌）。
 *
 * ## ⚠️ 窗口必须可见（同 a1187 的教训）
 * hidden 时 rAF / timer / 布局**一起停** ⇒ 采样全假 ⇒ 直接 `exit(2)`，绝不拿假数据当结论。
 * 也**不反复 bringToFront**（那是用户的机器）—— 只在"本来就不可见"时请求恢复一次。
 *
 * 前置：一个带调试端口的实例。产物版：
 *   cd gui && SLIME_DEVTOOLS_PORT=9444 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/electron/dist/electron.exe .
 * 运行：`node gui/scripts/probe-a1190-chat-fade.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1190_OUT || "C:/Users/MR/AppData/Local/Temp/a1190/probe-a1190.txt";
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page"
        && (t.url.includes("index.html") || t.url.includes("localhost:5173")));
      if (page) { return page; }
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("CDP 目标未找到（实例没起来？端口不对？）");
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

/* 采样：一条里同时带"聊天页 opacity"、"两侧栏宽度"、"body class"（判据都要用）。 */
const SAMPLE = `JSON.stringify((() => {
  const cs = document.querySelector(".chat-scroll");
  const sb = document.querySelector(".sidebar");
  const rw = document.querySelector(".right-wrapper");
  const rs = document.querySelector(".right-sidebar");
  const o = cs ? getComputedStyle(cs).opacity : "-1";
  return [
    Math.round(performance.now() - window.__t0),
    cs ? Math.round(Number(o) * 1000) / 1000 : -1,
    sb ? Math.round(sb.getBoundingClientRect().width) : -1,
    rs ? Math.round(rs.getBoundingClientRect().width) : (rw ? Math.round(rw.getBoundingClientRect().width) : -1),
    (cs && cs.style.opacity) ? cs.style.opacity : "-",
    document.body.className
  ];
})())`;

/* 在左栏 resizer 上"只按下、不移动" */
const PTR_DOWN = `(() => {
  const rz = document.querySelector(".sidebar-resizer");
  if (!rz) { return "NO-RESIZER"; }
  const b = rz.getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  window.__pt = { x, y };
  rz.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1,
    clientX: x, clientY: y
  }));
  return "OK";
})()`;

/* 松手（结束这次"只按下"） */
const PTR_UP = `(() => {
  const p = window.__pt || { x: 0, y: 0 };
  document.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0,
    clientX: p.x, clientY: p.y
  }));
  return "OK";
})()`;

const clickByTitle = (re) => `(() => {
  const b = Array.from(document.querySelectorAll("button"))
    .find((x) => ${re}.test(x.getAttribute("title") || ""));
  if (!b) { return "NO"; }
  const t = b.getAttribute("title") || "?";
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK:" + t;
})()`;

const markT0 = `(() => { window.__t0 = performance.now(); return "OK"; })()`;

/** 采样一段窗口（探针侧逐 8ms 发一次 eval；主线程跑，不受页内节流）。 */
async function sample(cdp, ms) {
  const rows = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = JSON.parse(await cdp.eval(SAMPLE));
    if (r) { rows.push(r); }
    await new Promise((res) => setTimeout(res, 8));
  }
  return rows;
}

/** 只列"有变化"的帧（去掉重复），避免刷屏。 */
function changes(rows) {
  const out = []; let last = "";
  for (const r of rows) { const k = r.slice(1).join("|"); if (k !== last) { out.push(r); last = k; } }
  return out;
}

const OP = 1, SBW = 2, CLS = 5;

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");

  let vis = await cdp.eval("document.visibilityState");
  if (vis !== "visible") {
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
    try { await cdp.send("Page.bringToFront"); } catch { /* */ }
    for (let i = 0; i < 60 && vis !== "visible"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      vis = await cdp.eval("document.visibilityState");
      if (i % 10 === 0) { try { await cdp.send("Page.bringToFront"); } catch { /* */ } }
    }
  }
  say(`visibilityState=${vis}（hidden ⇒ 布局不更新、采样全假，直接退出）`);
  if (vis !== "visible") { say("❌ 窗口不可见 ⇒ 拒绝出结论（不拿假数据当结论）。"); process.exit(2); }

  /* 等 UI 就绪（要有 .chat-scroll / .sidebar / 折叠按钮 / 一个会话……）。 */
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      cs: !!document.querySelector(".chat-scroll"),
      sb: !!document.querySelector(".sidebar"),
      rz: !!document.querySelector(".sidebar-resizer"),
      lb: !!Array.from(document.querySelectorAll("button")).find((x) => /收起侧栏|展开侧栏/.test(x.getAttribute("title") || "")),
    })`));
    if (st.cs && st.sb && st.rz && st.lb) { ready = true; say(`✅ UI 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未等到 UI 就绪（缺 .chat-scroll / .sidebar / .sidebar-resizer / 折叠按钮）"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 800));

  /* ════════ ① 只按下、不移动 ⇒ 不许淡出 ════════ */
  say("\n########## ① 诉求①：在左栏边缘**只按下**（不拖）⇒ 聊天页不许淡出 ##########");
  await cdp.eval(markT0);
  const downRes = await cdp.eval(PTR_DOWN);
  say(`  pointerdown → ${downRes}`);
  const rows1 = await sample(cdp, 300);
  const seen = changes(rows1);
  say("    t(ms)  chatOpacity  sb.w  rs.w  chat-inline  body.class");
  for (const r of seen) { say("  " + r.map((v, i) => i === 0 ? String(v).padStart(6) : String(v)).join("  ")); }
  const ops1 = [...new Set(rows1.map((r) => r[OP]))];
  const hadFading = rows1.some((r) => String(r[CLS]).includes("slime-fading"));
  const hadDragging = rows1.some((r) => String(r[CLS]).includes("slime-dragging"));
  say(`  ▶ chatOpacity 取值集合：${ops1.join(" → ")}`);
  say(`  ▶ body 上出现 slime-dragging：${hadDragging ? "是（预期，跟手用）" : "否（⚠️ 起点没挂？）"}`);
  say(`  ▶ body 上出现 slime-fading ：${hadFading ? "❗是（回归：点一下边缘就淡出）" : "否（✅ 符合诉求①）"}`);
  say(`  ${ops1.length === 1 && ops1[0] === 1 && !hadFading ? "✅ ① 通过：只按下不拖 ⇒ 聊天页 opacity 恒为 1" : "❌ ① 不通过"}`);
  await cdp.eval(PTR_UP);
  await new Promise((r) => setTimeout(r, 600));

  /* ════════ ② 折叠（宽度真的变）⇒ 聊天页与侧边栏同拍（凹陷：整段落在 500ms 内）════════ */
  say("\n########## ② 诉求②：点折叠按钮 ⇒ 聊天页整段动画必须落在侧边栏那 500ms 之内 ##########");
  say("  判据（A-1190② 之后）：聊天页 opacity 先**凹陷**到 0、再**在 ≤650ms 内**回到 1。");
  say("  旧结构（三段式）= 淡出 500ms + 停住 40ms + 淡入 500ms ⇒ ~1020ms 才回到 1（后半段侧边栏已静止）。");
  await cdp.eval(markT0);
  const c1 = await cdp.eval(clickByTitle("/收起侧栏/"));
  say(`  [点击] 收起左栏 → ${c1}`);
  const rows2 = await sample(cdp, 1800);
  say("    t(ms)  chatOpacity  sb.w  rs.w  chat-inline  body.class");
  for (const r of changes(rows2)) { say("  " + r.map((v, i) => i === 0 ? String(v).padStart(6) : String(v)).join("  ")); }
  const dipMin2 = rows2.reduce((a, r) => (a === null || r[OP] < a[OP] ? r : a), null);
  const dipBack2 = dipMin2 ? rows2.find((r) => r[0] > dipMin2[0] && r[OP] >= 0.99) : null;
  const fadeZero2 = rows2.find((r) => r[OP] === 0);
  const sbMin2 = rows2.find((r) => r[SBW] === 0);
  say(`  ▶ 聊天页最低 opacity=${dipMin2 ? dipMin2[OP] : "-"} 于 t=${dipMin2 ? dipMin2[0] : "-"}ms；到 0 于 t=${fadeZero2 ? fadeZero2[0] : "-"}ms`);
  say(`  ▶ 侧边栏宽度首次到 0 于 t=${sbMin2 ? sbMin2[0] : "-"}ms`);
  const dipRan2 = !!dipMin2 && dipMin2[OP] < 0.9;
  say(`  ▶ 凹陷真的发生了（最低 opacity < 0.9）：${dipRan2 ? "是" : "❗否（没淡出？）"}`);
  say(`  ▶ 聊天页回到 1 于 t=${dipBack2 ? dipBack2[0] : "-（1800ms 内没回来）"}ms`);
  say(`  ${dipRan2 && dipBack2 && dipBack2[0] <= 650 ? `✅ ② 通过：凹陷在 ${dipBack2[0]}ms 收工（≤650ms，与侧边栏同拍）` : "❌ ② 不通过（凹陷没发生，或回到 1 的时刻 > 650ms = 又出现尾巴）"}`);

  /* ════════ ③ 展开（复位方向：同一段凹陷，不许再晚 ~500ms）════════ */
  say("\n########## ③ 诉求②：点展开按钮 ⇒ 同一条凹陷（不许比侧边栏晚 ~500ms）##########");
  await new Promise((r) => setTimeout(r, 700));
  await cdp.eval(markT0);
  const c2 = await cdp.eval(clickByTitle("/展开侧栏/"));
  say(`  [点击] 展开左栏 → ${c2}`);
  const rows3 = await sample(cdp, 2000);
  say("    t(ms)  chatOpacity  sb.w  rs.w  chat-inline  body.class");
  for (const r of changes(rows3)) { say("  " + r.map((v, i) => i === 0 ? String(v).padStart(6) : String(v)).join("  ")); }
  const dipMin3 = rows3.reduce((a, r) => (a === null || r[OP] < a[OP] ? r : a), null);
  const dipBack3 = dipMin3 ? rows3.find((r) => r[0] > dipMin3[0] && r[OP] >= 0.99) : null;
  const sbFull3 = rows3.find((r) => r[SBW] >= 200);
  const dipRan3 = !!dipMin3 && dipMin3[OP] < 0.9;
  say(`  ▶ 聊天页最低 opacity=${dipMin3 ? dipMin3[OP] : "-"} 于 t=${dipMin3 ? dipMin3[0] : "-"}ms`);
  say(`  ▶ 侧边栏宽度回到 ≥200 于 t=${sbFull3 ? sbFull3[0] : "-"}ms`);
  say(`  ▶ 凹陷真的发生了：${dipRan3 ? "是" : "❗否"}`);
  say(`  ▶ 聊天页回到 1 于 t=${dipBack3 ? dipBack3[0] : "-（2000ms 内没回来）"}ms`);
  say(`  ${dipRan3 && dipBack3 && dipBack3[0] <= 650 ? `✅ ③ 通过：展开方向也在 ${dipBack3[0]}ms 收工（≤650ms）` : "❌ ③ 不通过（没凹陷，或回到 1 的时刻 > 650ms）"}`);

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
