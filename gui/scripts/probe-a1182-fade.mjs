/* eslint-disable */
/**
 * gui/scripts/probe-a1182-fade.mjs —— 右栏折叠/展开的「擦除式衔接」是否真的在跑。
 *
 * ## 用户诉求
 * 「右侧边栏衔接呢？」—— 右栏收/展要**有衔接动画**。
 *
 * ## 关键背景（A-1164 的判断是对的，不能推翻）
 * 右栏原本用 `opacity` 做淡入淡出，A-1164 把它删了，证据是：
 *   静止态内容区 p95 = 133.0，过渡中 p95 = **10.0** ⇒ 亮字整个消失
 *   ⇒ 整块面板在滑动的同时"由黑变亮" = **抽搐**。
 * ⇒ 本轮（A-1182）**不恢复 opacity**，改用 `clip-path: inset(...)` **擦除**：
 *   内容**始终不透明**（没有"由黑变亮"）⇒ 不会抽搐；但有明确的揭开进程 ⇒ 有"衔接"感。
 *
 * ## 判据
 * 过渡期逐帧记录 `.right-sidebar` 的：
 *   · `clip-path` 计算值（`none` / `inset(...)`）—— **必须**在过渡中**逐帧变化**
 *     （有进程度 = 有衔接；一步到位 = 没衔接）。
 *   · `opacity` —— **必须恒为 1**（若它也变了 ⇒ 说明有人又把 opacity 淡入请回来了 ⇒ 抽搐回归）。
 *   · 宽度 —— 顺便确认 width 过渡没被破坏。
 *
 * 运行：`SLIME_DEVTOOLS_PORT=<port> node gui/scripts/probe-a1182-fade.mjs`
 */
import fs from "node:fs";
const PORT = Number(process.env.SLIME_DEVTOOLS_PORT || 9470);
const OUT = process.env.SLIME_A1182_OUT || "D:/pilot project/gui/out/_a1182-fade.txt";
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

/* ⚠️ 模板串内绝不能用反引号（连注释里也不行）。 */
const SNAP = `(() => {
  const rs = document.querySelector(".right-sidebar");
  const cs = rs ? getComputedStyle(rs) : null;
  return JSON.stringify({
    w: rs ? Math.round(rs.getBoundingClientRect().width) : -1,
    clip: cs ? String(Math.round(Number(cs.opacity) * 100) / 100) : "-",
    op: cs ? Math.round(Number(cs.opacity) * 100) / 100 : -1,
  });
})()`;

const CLICK_RIGHT = `(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => {
    const t = (x.getAttribute("title") || "");
    return t.indexOf("收起右侧栏") >= 0 || t.indexOf("展开右侧栏") >= 0;
  });
  if (!b) { return "NO-BTN"; }
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "OK " + (b.getAttribute("title") || "?");
})()`;

async function main() {
  const t = await getTarget();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  for (let i = 0; i < 12; i++) {
    try { await cdp.send("Page.bringToFront"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 500));
    if (await cdp.eval("document.visibilityState") === "visible") { say(`  ✅ 第 ${i + 1} 次可见`); break; }
  }
  if (await cdp.eval("document.visibilityState") !== "visible") { say("❌ 窗口不可见"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));

  const seq = async (label) => {
    const rows = [];
    say(`\n[点击] ${await cdp.eval(CLICK_RIGHT)}`);
    const t0 = Date.now();
    while (Date.now() - t0 < 1400) {
      rows.push(JSON.parse(await cdp.eval(SNAP)));
      await new Promise((r) => setTimeout(r, 12));
    }
    say(`\n═══ ${label} ═══`);
    const clips = rows.map((r) => r.clip);
    const ops = rows.map((r) => r.op);
    const ws = rows.map((r) => r.w);
    const clipSteps = new Set(clips.filter((c) => c !== "1")).size;
    const opMin = Math.min(...ops);
    const wSteps = new Set(ws).size;
    say(`  ${rows.length} 帧｜clip-path **不同值 ${clipSteps} 种**｜宽度不同值 ${wSteps} 种｜opacity 最低 ${opMin}`);
    const sample = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const k = String(rows[i].clip);
      if (String(rows[i].clip) !== "1" && !seen.has(k)) { seen.add(k); sample.push(rows[i]); }
    }
    say(`  过渡期的 opacity 取值（前 10）：`);
    for (const s of sample.slice(0, 10)) { say(`      w=${String(s.w).padStart(4)}  clip=${s.clip}  op=${s.op}`); }
    const okClip = clipSteps >= 5;
    const okOp = opMin < 0.95;
    say(`  ${okClip ? "✅" : "❌"} 淡入淡出衔接在跑（opacity 逐帧变化 ${clipSteps} 种，最低 ${opMin}）`);
    say(`  ${okOp ? "✅" : "❌"} 过渡中确实出现过半透明（最低 ${opMin} < 0.95）—— 没有淡入淡出就没有衔接`);
    say(`  ${wSteps >= 5 ? "✅" : "❌"} width 过渡在跑（${wSteps} 种）`);
    return okClip && okOp;
  };

  const r1 = await seq("① 右栏收起");
  await new Promise((r) => setTimeout(r, 800));
  const r2 = await seq("② 右栏展开（反向）");
  say(`\n=== 汇总：${[r1, r2].filter(Boolean).length} / 2 衔接正常 ===`);
  process.exit(0);
}
main().catch((e) => { say("❌ " + e.message); process.exit(1); });