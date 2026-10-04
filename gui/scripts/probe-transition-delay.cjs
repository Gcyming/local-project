/* eslint-disable */
/**
 * gui/scripts/probe-transition-delay.cjs — 极简：把产物卡两条过渡的**计算值**打出来。
 *
 * 为什么要单独一个：主探针（probe-product-collapse.cjs）跑一轮要十几秒，还偶发超时；
 * 而"我写的 CSS 到底有没有落到元素上"是个**一眼可判**的问题 —— 直接读
 * `getComputedStyle` 的 transitionProperty / Duration / Delay 就够了（闭合态 + 展开态各读一次）。
 *
 * 用法：cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-transition-delay.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(guiDir, "src", "renderer", "index.css"), "utf8");
const htmlPath = path.join(os.tmpdir(), "slime-probe-td.html");
const outPath = path.join(os.tmpdir(), "slime-probe-td.txt");

const rows = [];
for (let i = 0; i < 8; i += 1) { rows.push(`<div>+ line ${i} ` + "x".repeat(60) + "</div>"); }
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
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(htmlPath);
  const r = await win.webContents.executeJavaScript(`(() => {
    const host = document.getElementById('ph');
    const col = document.getElementById('pc');
    const snap = (label) => {
      const c = getComputedStyle(col), h = getComputedStyle(host);
      return label
        + '\\n  .collapse  property=' + c.transitionProperty + ' dur=' + c.transitionDuration + ' delay=' + c.transitionDelay
        + '\\n  .prod-host property=' + h.transitionProperty + ' dur=' + h.transitionDuration + ' delay=' + h.transitionDelay
        + '\\n  行内层   property=' + getComputedStyle(col.firstElementChild).transitionProperty + ' delay=' + getComputedStyle(col.firstElementChild).transitionDelay;
    };
    const a = snap('[收起态]');
    host.classList.add('is-open'); col.classList.add('is-open');
    const b = snap('[展开态]');
    return a + '\\n' + b;
  })()`);
  fs.writeFileSync(outPath, r, "utf8");
  app.exit(0);
});
