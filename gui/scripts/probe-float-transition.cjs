/* eslint-disable */
/**
 * gui/scripts/probe-float-transition.cjs — **窗口化过渡帧**的逐帧几何实测（A-1152）。
 *
 * ## 为什么专门写这个
 * 用户截取了一帧，问：「为什么窗口化的过渡帧不是右侧边栏直接向左合上，
 * 而是右侧边栏**跑到左边**然后往右合上？」
 * ⇒ 这是**动画方向**问题，纯静态探针（量终态）量不出来，必须**逐帧**量。
 *
 * ## 它量什么
 * 模拟 App 的宽度序列（`animateRightSidebar` 是几何同步：宽度从 0/当前 → 目标），
 * 逐帧打印 `.right-wrapper` 与 `.right-sidebar` 的 l/r/w ⇒
 * **右边缘（r）是固定还是移动**，直接回答"向左合上"还是"往右长"。
 *
 * 判据（用户要的语义）：
 *   · 右边缘应**固定在窗口右缘**，宽度收缩时只有左边缘向右移（像抽屉关）；
 *   · 若右边缘随宽度一起移动（甚至先跑到左边）⇒ 布局方向错了。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const electron = require("electron");
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

const GUI = path.join(__dirname, "..");
const PAGE = path.join(GUI, "out", "renderer", "index.html");
const outPath = path.join(os.tmpdir(), "slime-probe-float-transition.txt");
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(outPath, lines.join("\n"), "utf8"); };

/* 一个过渡帧序列：widths 会被写进 .right-sidebar，每帧打一次几何。 */
const SCRIPT = (widths, floatMode, animMode) => `(async () => {
  const body = document.querySelector(".body");
  const wrap = document.querySelector(".right-wrapper");
  const side = document.querySelector(".right-sidebar");
  const main = document.querySelector("main.main");
  if (!body || !wrap || !side) { return "MISSING body/wrap/side"; }
  const vw = window.innerWidth;
  /* 复刻App 的状态：float 态挂 body.float-layout；main 不挂载（渲染成 null）
     ⇒ 探针里用display:none 等价（它对 flex 布局的贡献同为0）。 */
  document.body.classList.toggle("float-layout", ${floatMode});
  wrap.classList.toggle("right-wrapper-anim", ${!!animMode});
  wrap.style.width = ${floatMode} && !${!!animMode} ? "100%" : "";
  wrap.style.flexShrink = ${floatMode} && !${!!animMode} ? "0" : "1";
  /* CSS 的 :not(.right-wrapper-anim) 是关键：过渡期不锁宽 */
  if (main) { main.style.display = ${floatMode} ? "none" : ""; }
  /* 关掉过渡，我们要逐帧驱动 */
  side.style.transition = "none";
  wrap.style.transition = "none";
  const rows = [];
  for (const w of ${JSON.stringify(widths)}) {
    side.style.width = w + "px";
    /* 强制布局后再量（否则拿到的是上一帧的值） */
    void side.getBoundingClientRect().width;
    const sb = side.getBoundingClientRect();
    const wb = wrap.getBoundingClientRect();
    rows.push({ w, sideL: Math.round(sb.left), sideR: Math.round(sb.right),
      wrapL: Math.round(wb.left), wrapR: Math.round(wb.right), wrapW: Math.round(wb.width) });
  }
  return JSON.stringify({ vw, rows });
})()`;

/*真实过渡模式**：不逐帧写内联宽度，而是写一个目标宽度然后**采样**真实过渡曲线。
   ⚠️ 这一条才是用户体感的判据：「过渡帧直接没了」= 硬跳；有过渡 = 宽度逐帧变化。
   判据：采样到的宽度序列里，**相邻两帧差值 > 1px** ⇒ 有过渡；全为 0 ⇒ 硬跳。 */
const TRANS_PROBE = (fromW, toW, ms) => `(async () => {
  const body = document.querySelector(".body");
  const wrap = document.querySelector(".right-wrapper");
  const side = document.querySelector(".right-sidebar");
  const main = document.querySelector("main.main");
  if (!body || !wrap || !side) { return "MISSING"; }
  const vw = window.innerWidth;
  const floatMode = ${""}true;
  document.body.classList.add("float-layout");
  wrap.classList.add("right-wrapper-anim");
  if (main) { main.style.display = "none"; }
  /* 起止宽度都不锁，交给 CSS 过渡（transition: width .28s）自己跑 */
  wrap.style.flexShrink = "0";
  side.style.width = ${fromW} + "px";
  void side.getBoundingClientRect().width;
  /* 强制 reflow 后再改目标值，确保 transition 真的启动 */
  side.style.transition = "";
  side.style.width = ${toW} + "px";
  const samples = [];
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      samples.push(Math.round(side.getBoundingClientRect().width));
      if (performance.now() - t0 < ${ms}) { requestAnimationFrame(tick); } else { res(); }
    };
    requestAnimationFrame(tick);
  });
  const uniq = new Set(samples);
  let maxStep = 0;
  for (let i = 1; i < samples.length; i++) { maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i-1])); }
  return JSON.stringify({ vw, frames: samples.length, distinct: uniq.size, maxStep,
    head: samples.slice(0, 6), tail: samples.slice(-4) });
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 800, x: 20, y: 20,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  const ev = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(PAGE);
  await new Promise((r) => setTimeout(r, 2500));

  for (const [floatMode, animMode] of [[false, false], [true, false], [true, true]]) {
    /* 收起方向：整窗 → 0（模拟"窗口化"时右栏向左合上） */
    const shrink = [1400, 1200, 1000, 800, 600, 400, 200, 0];
    const grow = [0, 200, 400, 600, 800, 1000, 1200, 1400];
    for (const [label, seq] of [["收起(→0)", shrink], ["展开(0→)", grow]]) {
      const raw = await ev(SCRIPT(seq, floatMode, animMode));
      if (raw === "MISSING body/wrap/side") { say("❌ " + raw); continue; }
      const d = JSON.parse(raw);
      say(`【float-layout=${floatMode} anim=${animMode} · ${label}】vw=${d.vw}`);
      say("  w → side.l  side.r | wrap.l  wrap.r  wrap.w");
      for (const r of d.rows) {
        say(`  ${String(r.w).padStart(5)} → ${String(r.sideL).padStart(6)} ${String(r.sideR).padStart(6)} | ${String(r.wrapL).padStart(6)} ${String(r.wrapR).padStart(7)} ${String(r.wrapW).padStart(6)}`);
      }
      /* 判据：右边缘是否固定在窗口右缘 */
      const rs = d.rows.map((r) => r.sideR);
      const rFixed = rs.every((v) => Math.abs(v - d.vw) <= 1);
      say(`  ⇒ 右边缘${rFixed ? "固定在窗口右缘 ✓（向左合上）" : "随宽度移动 ✗（会往右长）"}`);
      const ls = d.rows.map((r) => r.sideL);
      say(`  ⇒ 左边缘范围 ${Math.min(...ls)} .. ${Math.max(...ls)}（固定 ⇒ 抽屉式；变化 ⇒ 拉伸式）`);
      say("");
    }
  }
  // 真实过渡曲线采样（判据：distinct>3 且 maxStep>1 ⇒ 有过渡，否则是硬跳）
  for (const [fromW, toW, label] of [[300, 1388, "窄→宽（展开）"], [1388, 300, "宽→窄（收起）"]]) {
    const raw = await ev(TRANS_PROBE(fromW, toW, 700));
    if (raw === "MISSING") { say("MISSING"); continue; }
    const d2 = JSON.parse(raw);
    say(`【真实过渡 ${label}】${fromW}→${toW}px`);
    say(`  采样 ${d2.frames} 帧 ·不同宽度 ${d2.distinct} 个 · 最大单帧变化 ${d2.maxStep}px`);
    say(`  ⇒ ${d2.distinct > 3 && d2.maxStep > 1 ? "有真实过渡 ✓（衔接平滑）" : "硬跳 ✗（无过渡）"}`);
    say(`  头部: ${d2.head.join(" → ")}`);
    say(`  尾部: ${d2.tail.join(" → ")}`);
    say("");
  }

  app.exit(0);
});