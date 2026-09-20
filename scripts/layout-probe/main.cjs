/**
 * 布局探针：用真实 Chromium + 真实的 index.css 量「数字有没有被裁」。
 *
 * 背景：用户截图里 上下文K 显示成 "10:"、输出K 显示成 "{"。要确认修复有效，必须量：
 *   ① 每个数字输入框的 content box 宽度；
 *   ② 该框在最坏情况下要显示的文本（"1024" / "0.000001"）在同字体下的真实宽度。
 * 只要 ②+内边距 <= ①，就不再可能有截断。
 *
 * 量四类会"纸面算得下、实际放不下"的东西：
 *   · 纵向滚动条占宽（本机 4px，Windows 默认 ~17px → 额外跑一遍 narrow 预算）
 *   · th 文字宽度 vs 列宽（nowrap 表头在 table-layout:fixed 下会溢出）
 *   · ToggleSwitch 固定 40px vs 「启用」列宽
 *   · 徽标组（内置表 + 峰谷分时 + ▼）vs 「定价来源」列宽
 *
 * ── 怎么跑（三个坑都在这里，别再踩一遍）────────────────────────
 *   cd <repo>
 *   unset ELECTRON_RUN_AS_NODE          # 坑 1：本环境预设了 =1 → electron 退化成普通 node，
 *                                       #        表现为 "Cannot read properties of undefined (reading 'disableHardwareAcceleration')"
 *   node gui/node_modules/electron/cli.js scripts/layout-probe/main.cjs
 *   cat scripts/layout-probe/result.json   # 坑 2：Electron 在 Windows 是 GUI 子系统程序，
 *                                          #        console.log 不回传父 shell，所以结果只写文件
 *
 *   · 坑 3：真窗口模式（show:false 但非 offscreen）在本环境会**挂死**，
 *     被外层 shell SIGTERM 掉后连输出都不剩 —— 所以必须 offscreen + 看门狗 + 分阶段落盘。
 *   · 结果留在 result.json 里（运行产物，别入库）。
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const OUT = path.join(__dirname, "result.json");
let stage = "boot";
function dump(obj) {
  try { fs.writeFileSync(OUT, JSON.stringify({ stage, ...obj }, null, 2), "utf8"); } catch (_) {}
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");

// 看门狗：任何阶段卡住都在 25s 内留下证据并硬退出（否则会被外层 shell SIGTERM 掉，什么都不剩）
const watchdog = setTimeout(() => {
  dump({ ok: false, error: "watchdog timeout at stage=" + stage });
  app.exit(2);
}, 25000);

const MEASURE = `(() => {
  const cv = document.createElement("canvas").getContext("2d");
  const px = (el) => el.getBoundingClientRect().width;
  const textW = (el, s) => {
    const cs = getComputedStyle(el);
    cv.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    return +cv.measureText(s).width.toFixed(2);
  };

  function measure(label) {
    const out = { label };
    const card = document.getElementById("card");
    const wrap = document.querySelector(".provider-model-table");
    const table = wrap.querySelector("table");

    // —— 0) 基础几何：表格真实可用宽度 ——
    out.geom = {
      cardClient: card.clientWidth,
      cardInner: card.clientWidth - 32,
      wrapClient: wrap.clientWidth,
      wrapOffset: wrap.offsetWidth,
      scrollbarW: +(wrap.offsetWidth - wrap.clientWidth).toFixed(1),
      tableW: +px(table).toFixed(1),
      scrollHeight: wrap.scrollHeight,
      clientHeight: wrap.clientHeight,
    };

    // —— 1) 表头：nowrap 文字 vs 列宽 ——
    out.headers = [...table.querySelectorAll("th")].map((th) => {
      const cs = getComputedStyle(th);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const avail = +(px(th) - pad).toFixed(2);
      const txt = th.textContent.replace(/\\s+/g, " ").trim();
      const need = textW(th, txt);
      return { txt, colW: +px(th).toFixed(1), avail, need, fits: avail >= need, slack: +(avail - need).toFixed(2) };
    });

    // —— 2) 「启用」列：ToggleSwitch 固定 40px ——
    out.toggle = (() => {
      const sw = document.querySelector(".toggle");
      const td = sw.closest("td");
      const cs = getComputedStyle(td);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const avail = +(px(td) - pad).toFixed(2);
      return { swW: +px(sw).toFixed(2), avail, fits: avail >= px(sw), slack: +(avail - px(sw)).toFixed(2) };
    })();

    // —— 3) 数字输入框：content box vs 最坏文本 ——
    const CASES = [
      ["ctx0", "1024", "上下文K"],
      ["out0", "1024", "输出K"],
      ["pin0", "0.000001", "单价输入"],
      ["pout0", "0.000001", "单价输出"],
    ];
    out.inputs = {};
    for (const [id, worst, label2] of CASES) {
      const el = document.getElementById(id);
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const contentW = +(el.clientWidth - pad).toFixed(2);
      const need = textW(el, worst);
      out.inputs[label2] = {
        boxW: +px(el).toFixed(2), contentW, pad, border,
        worstText: worst, need, fits: contentW >= need, slack: +(contentW - need).toFixed(2),
      };
    }

    // —— 4) 「定价来源」徽标组 ——
    out.badge = (() => {
      const b = document.getElementById("bdg0");
      const td = b.closest("td");
      const cs = getComputedStyle(td);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const avail = +(px(td) - pad).toFixed(2);
      const w = +px(b).toFixed(2);
      return { badgeW: w, avail, fits: avail >= w, slack: +(avail - w).toFixed(2), clipped: td.scrollWidth > td.clientWidth };
    })();

    // —— 5) spinner 是否真的被 CSS 关掉 ——
    const probeEl = document.getElementById("ctx0");
    const inner = getComputedStyle(probeEl, "::-webkit-inner-spin-button");
    out.spinner = {
      appearance: getComputedStyle(probeEl).appearance,
      innerDisplay: inner.display,
    };

    // —— 6) 全局：有没有横向溢出 ——
    out.overflowX = {
      docScrollW: document.documentElement.scrollWidth,
      wrapScrollW: wrap.scrollWidth,
      tableDrawnW: +px(table).toFixed(1),
      wrapClipped: wrap.scrollWidth > wrap.clientWidth,
    };
    out.verticalAlign = getComputedStyle(document.getElementById("ctx0").closest("td")).verticalAlign;
    return out;
  }

  const normal = measure("normal-scrollbar");
  document.body.classList.add("force-narrow");
  const narrow = measure("17px-scrollbar-budget");
  document.body.classList.remove("force-narrow");
  return { normal, narrow };
})()`;

async function main() {
  stage = "ready";
  dump({ ok: false, note: "app ready" });

  const win = new BrowserWindow({
    width: 700, height: 900, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  stage = "loading";
  await win.loadURL(pathToFileURL(path.join(__dirname, "probe.html")).href);

  stage = "fonts";
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");

  stage = "measuring";
  const result = await win.webContents.executeJavaScript(MEASURE);

  clearTimeout(watchdog);
  stage = "done";
  dump({ ok: true, ...result });
  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((e) => {
  clearTimeout(watchdog);
  dump({ ok: false, error: String((e && e.stack) || e) });
  app.exit(1);
});
