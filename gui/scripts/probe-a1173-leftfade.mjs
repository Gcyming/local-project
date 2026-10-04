/* eslint-disable */
/**
 * gui/scripts/probe-a1173-leftfade.mjs —— 左栏收起/展开的**逐帧**不透明度与几何取证。
 *
 * ## 用户现象（问题 2）
 * 「左侧边栏的收起时的衔接动画似乎有点问题，怎么是先渐出消失再重新在最后几帧闪出文本？
 *   不应该是慢慢消失直至没有文本吗？」
 *
 * ## 判据
 * 收起时 `opacity` 必须**单调不增**地走到 0，并且**在宽度归零之前不许回升**
 * （复位成 1 而宽度还有剩余 ⇒ 那几帧文本会重新可见 = 用户看到的「闪出」）。
 *
 * 运行：`node gui/scripts/probe-a1173-leftfade.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9444);
const OUT = process.env.SLIME_A1173_OUT || "D:/pilot project/gui/out/_a1173-leftfade.txt";
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(OUT, lines.join("\n"), "utf8"); };

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.url.includes("index.html"));
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

/* ⚠️⚠️⚠️ 采样**不走页内定时器**：
   窗口 hidden（最小化/后台）时 Electron 会把 rAF **与** timer **一起停掉**
   —— 实测 `ARMED sb=true vis=hidden` 后用 rAF 得 **0 帧**、改用 setInterval 也只采到 **2 帧**。
   而 CSS 过渡本身是**时间驱动**的、在 hidden 窗口里照常推进（实测宽 240→0 确实发生了）
   ⇒ 正确的取法是**由探针侧每隔十几毫秒发一次 CDP eval**（eval 在主线程执行，不受页内节流）。
   代价：采样间隔受 IPC 往返影响（~10~20ms），不是严格逐帧，但足够画曲线。 */
const BEGIN = `(() => { window.__lfT0 = performance.now(); return "OK"; })()`;

/* ⚠️⚠️⚠️ 取证前**必须把窗口恢复成可见**：
   窗口 hidden（最小化/后台）时 Electron 把 rAF **与** timer **一起停掉**，
   而且**连布局都不更新**（实测 `getBoundingClientRect()` 恒返回 240 ⇒ 采样全假）。
   ⇒ 先 `Browser.getWindowForTarget` + `setWindowBounds({windowState:"normal"})` 把它恢复，
     再用 `document.visibilityState` 校验（仍 hidden 就直接报错退出，别拿假数据当结论）。 */
async function ensureWindowVisible(cdp, say) {
  try {
    const w = await cdp.send("Browser.getWindowForTarget");
    if (w && w.windowId !== undefined) {
      await cdp.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "normal" } });
      say(`  已请求恢复窗口（windowId=${w.windowId}）`);
    }
  } catch (e) { say("  ⚠️ 恢复窗口失败：" + e.message); }
  try { await cdp.send("Page.bringToFront"); } catch { /* 老版本无此命令 */ }
  await new Promise((r) => setTimeout(r, 400));
  const vis = await cdp.eval("document.visibilityState");
  say(`  visibilityState=${vis}`);
  return vis === "visible";
}

const SAMPLE = `JSON.stringify((() => {
  const node = document.querySelector(".sidebar");
  if (!node) { return null; }
  const cs = getComputedStyle(node);
  const b = node.getBoundingClientRect();
  return [Math.round(performance.now() - window.__lfT0), Math.round(b.width),
    Math.round(Number(cs.opacity) * 1000) / 1000, node.style.opacity || "-",
    node.classList.contains("collapsed") ? "C" : "-",
    node.classList.contains("sidebar-no-min") ? "M" : "-"];
})())`;

const CLICK = `(() => {
  const b = Array.from(document.querySelectorAll("header.titlebar button, .titlebar button"))
    .find((x) => /侧栏|侧边栏/.test(x.getAttribute("title") || ""));
  if (!b) { return "NO"; }
  const sb = document.querySelector(".sidebar");
  const before = (b.getAttribute("title") || "?") + " collapsed=" + (sb ? sb.classList.contains("collapsed") : "?");
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return before;
})()`;

function report(rows, label) {
  say(`\n═══ ${label} ═══`);
  if (!rows.length) { say("  ❌ 0 帧 —— 采样器没跑起来（窗口在后台？见 ARM 里的说明）"); return; }
  /* 变化点时间线 */
  const marks = []; let last = "";
  for (const r of rows) {
    const k = r.slice(1).join(",");
    if (k !== last) { marks.push(r); last = k; }
  }
  say(`  共 ${rows.length} 帧 · ${marks.length} 个变化点`);
  say("   t(ms)  width  opacity  inline-op  cls");
  for (const r of marks) {
    say(`  ${String(r[0]).padStart(6)} ${String(r[1]).padStart(6)} ${String(r[2]).padStart(8)}  ${String(r[3]).padStart(7)}  ${r[4]}${r[5]}`);
  }
  /* 判据：opacity 是否在「宽度未归零」时回升 */
  let spike = null;
  for (let k = 1; k < marks.length; k++) {
    const prev = marks[k - 1], cur = marks[k];
    if (cur[2] > prev[2] + 0.05 && cur[1] > 2) { spike = { t: cur[0], w: cur[1], from: prev[2], to: cur[2] }; break; }
  }
  say(spike
    ? `  ❌ 检测到「宽度未归零时不透明度回升」：t=${spike.t}ms 宽=${spike.w}px opacity ${spike.from} → ${spike.to} ⇒ 文本会在这几帧重新可见（用户报的「闪出」）`
    : `  ✅ 不透明度全程未在"宽度还有剩余"时回升`);
  const lastRow = rows[rows.length - 1];
  say(`  🏁 终态：宽=${lastRow[1]} opacity=${lastRow[2]} inline=${lastRow[3]}`);
}

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  try { await cdp.send("Page.bringToFront"); } catch {}
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4500));
  const visible = await ensureWindowVisible(cdp, say);
  if (!visible) { say("❌ 窗口仍不可见 ⇒ 布局不更新、采样全假。先把 slime 窗口恢复/置前再跑。"); process.exit(1); }
  /* ⚠️ 必须**等 `.sidebar` 真的挂上**：启动门（`.splash` 消失）与它挂载之间有间隙，
     只等启动门会在 `getComputedStyle(null)` 上抛 ⇒ 采样器一次都不跑（实测「共 0 帧」）。 */
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await cdp.eval(`JSON.stringify({
      gate: !!document.querySelector('img[alt="唤起悬浮窗"]'),
      sb: !!document.querySelector(".sidebar"),
    })`));
    if (st.gate && st.sb) { ready = true; say(`✅ 启动门 + .sidebar 就绪（第 ${i + 1} 次）`); break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { say("❌ 未等到 .sidebar（gate/sb）"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1200));

  const once = async (label) => {
    await cdp.eval(BEGIN);
    const before = await cdp.eval(CLICK);
    say(`\n[点击] ${label}（点击前 ${before}）`);
    /* ⚠️ 采样由**探针侧**发起（见 BEGIN/SAMPLE 的说明）：窗口 hidden 时页内定时器会被停。 */
    const rows = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1400) {
      const r = JSON.parse(await cdp.eval(SAMPLE));
      if (r) { rows.push(r); }
      await new Promise((res) => setTimeout(res, 6));
    }
    report(rows, label);
  };

  await once("① 收起左栏");
  await new Promise((r) => setTimeout(r, 500));
  await once("② 展开左栏");

  say("\n=== 完成 ===");
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });
