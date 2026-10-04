/* eslint-disable */
/**
 * gui/scripts/probe-x-anim.cjs — **横向（宽度）过渡到底有没有在插值** —— 只看这一件事。
 *
 * ## 为什么要单独一个
 * 用户口径：「向下展开和向上折叠有衔接动画了，**横向呢？为什么还没有**？我自始至终的目标都是完善横向的动画。」
 * 而计算值显示 `.prod-host` 的 `transition-property=width`、`duration=0.18s` **都是对的** ——
 * 说明"声明了过渡"不等于"真的插值了"。`width: fit-content ↔ 100%` 属于**关键字插值**，
 * 只有 `interpolate-size: allow-keywords` 真正生效时才可插值；不生效时**属性被当离散值处理**
 * ⇒ 声明照旧、但**一帧跳完**（这正是"看不到横向动画"的唯一形态）。
 *
 * ## 判据（直接看宽度序列，不猜）
 * · 真实播放（可见窗口 + rAF）采宽度：**只有 {起, 止} 两个值** ⇒ 不可插值（瞬跳）❌
 * · 出现中间值 ⇒ 可插值 ✅（那就只是"太快/幅度太小"的问题，改节拍即可）
 * 另外把 `CSS.supports('interpolate-size', 'allow-keywords')` 与 Chromium 版本一并打出来。
 *
 * 用法：cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-x-anim.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(guiDir, "src", "renderer", "index.css"), "utf8");
const htmlPath = path.join(os.tmpdir(), "slime-probe-x.html");
const outPath = path.join(os.tmpdir(), "slime-probe-x.txt");

const rows = [];
for (let i = 0; i < 200; i += 1) { rows.push(`<div>+ line ${i} ` + "x".repeat(72) + "</div>"); }
/* ⚠️ 结构照抄真实：`.prod-host` 是 **flex 容器里的 flex item**（`display:flex; flexWrap:wrap`）
   —— flex item 的宽度受 flex 布局影响，这正是"声明了 width 却看不到过渡"的经典现场。 */
fs.writeFileSync(htmlPath, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${css}
</style></head><body style="margin:0;background:#111">
<div id="wrap" style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:660px">
  <div id="ph" class="prod-host">
    <div class="prod-card" style="border-radius:8px;padding:8px;max-width:100%">
      <div style="font-size:12px">v525_session.py</div>
      <div class="collapse" id="pc"><div>
        <div class="prod-diff" style="margin-top:6px;max-height:340px;overflow-y:auto;font-family:Consolas,monospace;font-size:11.5px">
          ${rows.join("\n          ")}
        </div>
      </div></div>
    </div>
  </div>
</div>
</body></html>`, "utf8");

app.whenReady().then(async () => {
  /* ⚠️ 必须可见：隐藏/offscreen 窗口 rAF 降到 ~1fps，采不到真实帧。 */
  const win = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: { backgroundThrottling: false } });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  await win.loadFile(htmlPath);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const host = document.getElementById('ph');
    const col = document.getElementById('pc');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const W = () => +host.getBoundingClientRect().width.toFixed(1);
    const H = () => +col.getBoundingClientRect().height.toFixed(1);

    /* 真实播放采宽度：不 pause，逐帧读（这是"用户肉眼能不能看到横向动"的唯一证据）。 */
    const record = async (durMs) => {
      const t0 = performance.now();
      const ws = [], hs = [];
      await new Promise((res) => {
        const step = (t) => {
          ws.push(W()); hs.push(H());
          if (t - t0 < durMs) { requestAnimationFrame(step); } else { res(); }
        };
        requestAnimationFrame(step);
      });
      return { ws, hs };
    };
    const uniq = (a) => Array.from(new Set(a));

    await raf(); await sleep(250); await raf();
    const out = {
      version: navigator.userAgent.match(/Chrome\\/[\\d.]+/)?.[0] || '',
      supportsInterp: (typeof CSS !== 'undefined' && CSS.supports) ? CSS.supports('interpolate-size', 'allow-keywords') : null,
      closed: { w: W(), h: H(), hostWidth: getComputedStyle(host).width, hostDisplay: getComputedStyle(host).display, flex: getComputedStyle(host).flex },
    };

    host.classList.add('is-open'); col.classList.add('is-open');
    const open = await record(900);
    await sleep(200);
    out.openEnd = { w: W(), h: H() };
    host.classList.remove('is-open'); col.classList.remove('is-open');
    const close = await record(900);

    out.openWidths = open.ws;
    out.openUnique = uniq(open.ws.map((v) => Math.round(v)));
    out.closeUnique = uniq(close.ws.map((v) => Math.round(v)));
    out.openHeights = open.hs;
    return out;
  })()`);

  const lines = [
    `Chromium: ${r.version} · CSS.supports('interpolate-size','allow-keywords') = ${r.supportsInterp}`,
    `收起态：宽 ${r.closed.w}（computed width=${r.closed.hostWidth} / display=${r.closed.hostDisplay} / flex=${r.closed.flex}） 高 ${r.closed.h}`,
    `展开终态：宽 ${r.openEnd.w} 高 ${r.openEnd.h}`,
    "",
    `【展开】宽度序列（${r.openWidths.length} 帧）：`,
    `  ${r.openWidths.map((v) => Math.round(v)).join(", ")}`,
    `  去重后只有 ${r.openUnique.length} 个值：${r.openUnique.join(", ")}`,
    `【展开】高度序列：${r.openHeights.map((v) => Math.round(v)).join(", ")}`,
    "",
    `【收起】宽度去重后 ${r.closeUnique.length} 个值：${r.closeUnique.join(", ")}`,
    "",
    r.openUnique.length <= 2
      ? "❌ 宽度**只有起止两个值** ⇒ 没有插值（`interpolate-size` 没生效 / 关键字不可插值）—— 这就是「看不到横向动画」"
      : "✅ 宽度有中间值 ⇒ 确实在插值（那「看不到」只是节拍/幅度问题）",
  ];
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  app.exit(0);
});
