/* eslint-disable */
/**
 * gui/scripts/probe-float-realclick.cjs — **真点「窗口化」按钮**的离屏探针（A-1152）。
 *
 * ## 为什么必须另写一个探针（而不是扩展 assert-float-gap.cjs）
 * `assert-float-gap.cjs` 自己造 DOM（`main.classList.add("main-float")`），
 * 输出里 `float=false` 说明它**从未真正渲染过 `.float-window`** ——
 * 它量的是"布局规则对不对"，**量不到"浮层真渲染出来是什么样"**。
 * 而用户连续三轮报的问题（空白、强行拉开、按钮失效）**全都只在真路径上出现**。
 * ⇒ 这个探针走真路径：等启动门 → 找 `img[alt="唤起悬浮窗"]` → **真的点它** → 量真实几何。
 *
 * ## 它量什么（全部是行为/几何，不看颜色）
 * ① `.float-window` 是否真的出现，及其真实 w/h/left/top；
 * ② `.body` 每个直属子元素的几何（谁占了哪、谁没占）；
 * ③ **「空白」判定**：视口内既不属于右栏、也不属于浮窗、也不属于左栏的面积占比；
 * ④ 拖拽手柄是否还在（浮窗内 `cursor: ew-resize/ns-resize` 的元素 + 右栏那条）。
 *
 * 用法：cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-float-realclick.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const electron = require("electron");
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

/* ⚠️ **隔离目录**（A-1152）：探针必须能在"有会话数据"的环境里跑，否则 ChatPanel 不挂载
   ⇒「窗口化」按钮根本不存在 ⇒ 探针量不到真路径（这正是上一轮 `float=false` 的由来）。
   用 `SLIME_ROOT` 把整个数据目录指向临时区，预置一条最小会话，不碰用户真实数据。
   ⚠️ 必须**在 app ready 之前**设好，且userData 也要跟着换，否则 sessions.json 读不到。 */
const TMP_ROOT = path.join(os.tmpdir(), "slime-probe-float-root");
process.env.SLIME_ROOT = TMP_ROOT;
const { mkdirSync, writeFileSync, existsSync } = require("fs");
mkdirSync(path.join(TMP_ROOT, "config"), { recursive: true });
mkdirSync(path.join(TMP_ROOT, "data"), { recursive: true });
const sessPath = path.join(TMP_ROOT, "config", "sessions.json");
if (!existsSync(sessPath)) {
  writeFileSync(sessPath, JSON.stringify({
    sessions: {
      s_probe: { id: "s_probe", agentId: "test1", workspace: "D:\pilot project",
        title: "探针会话", createdAt: Date.now(), updatedAt: Date.now() },
    },
  }), "utf8");
}
if (!existsSync(path.join(TMP_ROOT, "config", "agents.json"))) {
  writeFileSync(path.join(TMP_ROOT, "config", "agents.json"), JSON.stringify([
    { id: "test1", name: "test1", model: "test", workspace: "D:\pilot project" },
  ]), "utf8");
}

const GUI = path.join(__dirname, "..");
const PAGE = path.join(GUI, "out", "renderer", "index.html");
const outPath = path.join(os.tmpdir(), "slime-probe-float-realclick.txt");
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(outPath, lines.join("\n"), "utf8"); };

const GEOM = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const body = document.querySelector(".body");
  const kids = body ? Array.from(body.children).map((el) => ({
    tag: el.tagName.toLowerCase(), cls: (el.className || "").toString().slice(0, 34), ...r(el),
  })) : [];
  const fw = document.querySelector(".float-window");
  const floatBox = r(fw);
  const rightSide = document.querySelector(".right-sidebar");
  const rs = r(rightSide);
  const mainEl = document.querySelector("main.main");
  /* 「空白」= 视口内被"右栏 ∪ 浮窗 ∪ 左栏"覆盖不到的面积。
     ⚠️ 这里用面积而不是像素采样：采样会漏掉细条，量不出来"右侧一条空带"。 */
  let uncovered = 0;
  const covered = (x) => {
    const inBox = (b) => b && x >= b.l && x <= b.r;
    return inBox(rs) || inBox(floatBox) || (() => { const l = document.querySelector(".sidebar"); const lb = r(l); return inBox(lb); })();
  };
  for (let y = 4; y < vh; y += 8) { for (let x = 4; x < vw; x += 8) { if (!covered(x)) { uncovered += 64; } } }
  const total = vw * vh;
  return JSON.stringify({
    vw, vh,
    floatExists: !!fw, floatBox,
    mainExists: !!mainEl, mainBox: r(mainEl),
    rightBox: rs,
    kids,
    uncoveredPct: +(uncovered / total * 100).toFixed(1),
    /* 拖拽手柄：浮窗内 + 右栏那条 */
    resizeHandles: document.querySelectorAll(".right-sidebar-resizer").length,
    floatInnerHandles: (() => { let n = 0; if (fw) {
      for (const el of fw.querySelectorAll("div")) { const cs = getComputedStyle(el);
        if (cs.cursor === "ew-resize" || cs.cursor === "ns-resize" || cs.cursor === "nwse-resize") { n++; } } } return n; })(),
  });
})()`;

app.setPath("userData", path.join(TMP_ROOT, "userData"));
app.setPath("sessionData", path.join(TMP_ROOT, "userData"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 820, x: 20, y: 20,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  const ev = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(PAGE);
  say("真产物已加载，等启动门…");

  // 等启动门：SplashScreen 消失 or 出现窗口化按钮
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const st = await ev(`(() => {
      const btn = document.querySelector('img[alt="唤起悬浮窗"]');
      const splash = document.querySelector('.splash, [class*="splash"]');
      return JSON.stringify({ btn: !!btn, splash: !!splash && getComputedStyle(splash).opacity !== "0" });
    })()`);
    const o = JSON.parse(st);
    if (o.btn) { ready = true; say(`启动门已过（第 ${i + 1} 次轮询），找到「窗口化」按钮`); break; }
    if (i % 8 === 0) { say(`  轮询 ${i + 1}：btn=${o.btn} splash=${o.splash}`); }
  }
  if (!ready) {
    const st = await ev(`JSON.stringify({ html: document.body.innerHTML.slice(0, 400) })`);
    say("❌ 40 次轮询内没等到按钮（可能启动门卡住）。DOM 头部：" + st);
    app.exit(1);
    return;
  }

  say("【点之前】" + await ev(GEOM));
  say("—— 真点「窗口化」 ——");
  const clicked = await ev(`(() => {
    const img = document.querySelector('img[alt="唤起悬浮窗"]');
    if (!img) { return "NO-BTN"; }
    // 点它外层的可点元素（img 本身可能 pointer-events:none）
    const btn = img.closest("button") || img.parentElement;
    (btn || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "CLICKED on " + (btn ? btn.tagName : img.tagName);
  })()`);
  say("点击结果：" + clicked);
  for (const wait of [400, 1200, 2500]) {
    await new Promise((r) => setTimeout(r, wait));
    say(`【点之后 +${wait}ms】` + await ev(GEOM));
  }
  app.exit(0);
});