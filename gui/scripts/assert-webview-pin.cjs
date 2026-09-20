/*
 * 右栏 webview 钉宽守卫（A-1016-F3）。**永久守卫**，不是临时探针。
 *
 * 目标：验证 **生产 CSS 规则本身** 真的把右栏 `<webview>` 的 guest 钉在固定宽度上
 *       （只被祖先裁切、不逐帧跨进程 resize），而不是只写了一条规则但没生效。
 *
 * 背景：v4 的 q1/q3 已证明「钉住宽度」这个**思路**有效（3 帧掉帧 → 0 帧）；本守卫证明的是
 * **index.css 里的真实规则**（`.right-wrapper-pin webview { width: var(--right-pin-w) !important }`）
 * 在**真实 DOM 嵌套**（wrapper > aside.right-sidebar > 面板栈 > webview）下确实命中、且真的把
 * guest 的宿主盒子钉住，同时**不破坏** aside 自身的宽度过渡、且解除后不残留旧宽度。
 *
 * ⚠️ 四个已踩过的坑，本文件都已规避：
 *   ① 离屏窗口 `win.destroy()` 会偶发硬崩（stderr 只留一行 crashpad「not connected」，
 *      进程被直接带走 → 后续场景一个字都打不出来）。所以**不 destroy**，窗口引用留住，
 *      由 `app.exit()` 在进程退出时一并拆掉。
 *   ② 未捕获异常会让 Electron 弹**系统模态框**并挂住进程 → 下面兜底为打印栈后退出。
 *      语法错误兜不住 → 跑之前先 `node --check`。
 *   ③ **脚手架失真比没有脚手架更糟**：第一版把 `#main` 写成 `flex:1 1 auto`
 *      （basis = max-content，巨大）→ 右栏被按比例狠压到 316px，得出"请求 820 只能到 317"
 *      的假结论，并据此写了一个"强制布局实测可达宽"的错误修法。真实 `.main` 是
 *      `flex:1 1 0% + min-width:380px` → 收缩量全部由右栏承担，可达宽 = innerWidth-左-380。
 *      本文件的 `#main` 必须**逐字镜像**真实模型，改它之前先回去核对 index.css。
 *   ④ 任何在**改动态**下的强制布局都会污染浏览器缓存的 computed style——还原后若不额外
 *      flush，下一帧的样式变化被判为"无变化"，**过渡根本不启动**（第一版修法实测：
 *      aside 全程一动不动 316.96）。所以钉值走**公式法**，不碰 DOM、不做强制布局。
 *
 * 结构按 App.tsx / RightSidebar.tsx 复刻（`#main` 见上文③）：
 *   <div class="right-wrapper [right-wrapper-pin]" style="display:flex;flex-shrink:1;min-width:0">
 *     <aside class="right-sidebar [collapsed]" style="width:820px">
 *       <div style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%">
 *         <div class="right-pane-head browser-bar">…</div>
 *         <div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
 *           <webview style="flex:1;width:100%;height:100%;border:none">
 *
 * 场景（pre = 动画前准备，go = 触发过渡）：
 *   r1 展开·**不钉**（F3 前行为）→ 对照组：guest 宿主宽度本就该每帧变（实测 span 560px / 7 帧掉帧）
 *   r2 展开·**公式钉宽**（F3）    → guest 恒定（span 0）、aside 正常插值、掉帧 ≤1
 *   r3 收起·钉当前宽（F3）        → guest 恒定、aside 正常插值到 0
 *   r4 展开·钉住后**解除**        → 钉子类与变量都摘净、guest 回到 100% 跟随容器（不残留旧宽）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

process.on("uncaughtException", (e) => { console.error("PROBE-ERR " + (e && e.stack ? e.stack : e)); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("PROBE-REJ " + (e && e.stack ? e.stack : e)); process.exit(1); });

const guiDir = path.join(__dirname, "..");
/* ⚠️ 直接读**生产** CSS：验证的是真规则，不是本探针自己编的一条等价规则。 */
const css = fs.readFileSync(path.join(guiDir, "src", "renderer", "index.css"), "utf8");

const guestHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
 body{margin:0;font:13px/1.6 system-ui;background:#0d1117;color:#c9d1d9}
 .blk{padding:6px 10px;border-bottom:1px solid #21262d}
 table{border-collapse:collapse;width:100%}td{border:1px solid #30363d;padding:3px 6px;white-space:nowrap}
</style></head><body>
 <table><tbody>${Array.from({ length: 300 }, (_, i) => `<tr><td>行 ${i}</td><td>数值 ${i * 37}</td><td>状态 ok</td><td>备注文本内容 ${i}</td></tr>`).join("")}</tbody></table>
 ${Array.from({ length: 700 }, (_, i) => `<div class="blk">内容块 ${i} —— 制造一点真实量级的布局与绘制</div>`).join("")}
</body></html>`;

const msgRows = Array.from({ length: 20 }, (_, i) =>
  `<div class="msg-row" style="padding:8px 10px"><div style="font-weight:700;margin-bottom:6px">消息 ${i + 1}</div>
   <div style="font-size:13px;line-height:1.6">${"这是一段用于占位的中文正文，长度接近真实回复。".repeat(6)}</div></div>`).join("");

const OPEN_W = 820;

const page = (opts) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${css}
body{margin:0;background:#0d1117;color:#ddd;font-family:system-ui}
#row{display:flex;height:100vh}
/* ⚠️ 必须镜像**真实** flex 模型（index.css）：
   .main 是 flex:1 1 0% + min-width:380px、左侧栏 flexShrink:0、右栏 wrapper flexShrink:1
   → 空间不足时收缩量**全部**由右栏承担，右栏实际 = innerWidth - 左 - 380。
   探针第一版把 #main 写成 flex:1 1 auto（basis = max-content，巨大）→ 右栏被按比例狠压到
   316px，得出"请求 820 只能到 317"的**假结论**，并据此写了一个"强制布局实测"的错误修法
   （还会污染 transition 起始点，见下）。脚手架失真比没有脚手架更糟。 */
#main{flex:1 1 0%;min-width:380px;overflow:hidden}
</style></head><body>
<div id="row">
  <div id="left"></div>
  <div id="main">${msgRows}</div>
  <div id="wrap" class="right-wrapper" style="display:flex;flex-shrink:1;min-width:0">
    <aside id="aside" class="right-sidebar${opts.open ? "" : " collapsed"}" style="width:${OPEN_W}px">
      <div style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%">
        <div class="right-pane-head browser-bar" style="flex-shrink:0">
          <button class="right-mini-btn">‹</button>
          <input class="term-input browser-url" placeholder="输入网址，回车访问" />
        </div>
        <div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
          <webview id="wv" src="guest.html"
                   style="flex:1;width:100%;height:100%;border:none;background:#fff"></webview>
        </div>
      </div>
    </aside>
  </div>
</div>
</body></html>`;

/* ── pre / go 两段动作（在页面里 eval，模拟 App 的真实步骤） ── */

/* F3 的生产同款：**公式法**求可达宽（= innerWidth - 左栏 - CHAT_MIN_W，与 rightSidebarMaxW 同式），
   取 min(请求, 可达) 作钉值。零 DOM 改动、零强制布局。
   ⚠️ 不要改回"临时改样式 + 强读布局"的实测法：任何在**改动态**下的强制布局都会污染浏览器缓存的
   computed style——还原后若不额外 flush，下一帧的样式变化被判为"无变化"，**过渡根本不启动**
   （本探针实测：aside 全程一动不动 316.96；这正是第一版修法的 bug）。 */
const PIN_BY_FORMULA = `({ aside, wrap }) => {
  const leftW = document.getElementById('left').getBoundingClientRect().width;
  const achievable = window.innerWidth - leftW - 380;   // 与 rightSidebarMaxW() 同式
  const target = Math.min(${OPEN_W}, achievable);
  wrap.style.setProperty('--right-pin-w', Math.round(target) + 'px');
  wrap.classList.add('right-wrapper-pin');
  return target;
}`;

/* 收起方向：钉在**当前**实测宽（guest 全程不缩） */
const PIN_CURRENT = `({ aside, wrap }) => {
  const cur = aside.getBoundingClientRect().width;
  wrap.style.setProperty('--right-pin-w', Math.round(cur) + 'px');
  wrap.classList.add('right-wrapper-pin');
  return cur;
}`;

const UNPIN = `({ wrap }) => {
  wrap.classList.remove('right-wrapper-pin');
  wrap.style.removeProperty('--right-pin-w');
}`;

const NOOP = `() => 0`;

const EXPAND = `({ aside }) => { aside.classList.remove('collapsed'); }`;
const COLLAPSE = `({ aside }) => { aside.classList.add('collapsed'); }`;

const CASES = {
  r1: { label: "R1 展开·不钉（F3 前行为）", open: false, pinNow: false, pre: NOOP, go: EXPAND, unpinAtMs: null },
  r2: { label: "R2 展开·公式钉宽（F3）", open: false, pinNow: true, pre: PIN_BY_FORMULA, go: EXPAND, unpinAtMs: null },
  r3: { label: "R3 收起·钉当前宽（F3）", open: true, pinNow: true, pre: PIN_CURRENT, go: COLLAPSE, unpinAtMs: null },
  /* r4：动画跑到一半就解除（模拟 done 回调），随后再等一会儿看最终态 */
  r4: { label: "R4 展开·钉住后解除（不残留）", open: false, pinNow: true, pre: PIN_BY_FORMULA, go: EXPAND, unpinAtMs: 560 },
};

let seqNo = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slime-p6-"));
fs.writeFileSync(path.join(tmpDir, "guest.html"), guestHtml, "utf8");
/* ⚠️ 不 destroy → 留住窗口引用，避免被 GC 提前拆掉 */
const KEEP = [];

async function run(c) {
  const p = path.join(tmpDir, `probe-${seqNo++}.html`);
  fs.writeFileSync(p, page(c), "utf8");
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false, webviewTag: true },
  });
  KEEP.push(win);
  await win.loadFile(p);
  await win.webContents.executeJavaScript(`new Promise((res) => {
    const wv = document.getElementById('wv');
    if (!wv) { res('no-wv'); return; }
    wv.addEventListener('did-finish-load', () => res('loaded'), { once: true });
    setTimeout(() => res('timeout'), 4000);
  })`).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));

  return JSON.parse(await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const aside = document.getElementById('aside');
    const wrap = document.getElementById('wrap');
    const wv = document.getElementById('wv');
    const W = (el) => +el.getBoundingClientRect().width.toFixed(2);
    await sleep(200);

    const pinTarget = (${c.pre})({ aside, wrap });

    const seq = [];
    let last = performance.now();
    const t0 = last;
    (${c.go})({ aside });
    while (performance.now() - t0 < 780) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      const dt = +(now - last).toFixed(1); last = now;
      const a = performance.now(); void aside.scrollWidth; const b = performance.now();
      seq.push({ dt, layoutMs: +(b - a).toFixed(2), guest: W(wv), aside: W(aside) });
    }
    ${c.unpinAtMs == null ? "" : `
    // 模拟生产 done 回调：宽度停住后解除钉子
    const wait = ${c.unpinAtMs} - (performance.now() - t0);
    await sleep(wait > 0 ? wait : 0);
    (${UNPIN})({ wrap });
    `}
    await sleep(300);

    const dts = seq.map((x) => x.dt).sort((x, y) => x - y);
    const pct = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;
    const gw = seq.map((x) => x.guest);
    const aw = seq.map((x) => x.aside);
    const mid = Math.floor(aw.length / 2);
    const finalGuest = W(wv), finalAside = W(aside);
    return JSON.stringify({
      frames: seq.length,
      fps: +(1000 / (seq.reduce((s, x) => s + x.dt, 0) / seq.length)).toFixed(1),
      dtP95: pct(dts, 0.95), jankFrames: dts.filter((d) => d > 20).length,
      layoutSum: +seq.reduce((s, x) => s + x.layoutMs, 0).toFixed(1),
      pinTarget: +(pinTarget || 0).toFixed(2),
      uniqGuestWidths: new Set(gw.map((v) => Math.round(v))).size,
      guestMin: Math.min.apply(null, gw), guestMax: Math.max.apply(null, gw),
      guestSpan: +(Math.max.apply(null, gw) - Math.min.apply(null, gw)).toFixed(2),
      asideStart: aw[0], asideMid: aw[mid], asideEnd: aw[aw.length - 1],
      finalAside, finalGuest,
      dropAtEnd: +Math.abs(finalGuest - finalAside).toFixed(2),
      pinClassPresent: wrap.classList.contains('right-wrapper-pin'),
      pinVar: wrap.style.getPropertyValue('--right-pin-w') || '(none)',
    });
  })()`));
}

/* 每场景硬断言：探针自己判红绿，退出码承担（不靠人眼看 JSON）。 */
const ASSERT = {
  /* 对照：不钉的时候 guest 宿主宽度**本来就该**每帧变——若这条不成立，
     说明载荷没跑到 guest 上，后面 r2/r3 的"恒定"就是假绿。 */
  r1: (r) => [
    [r.uniqGuestWidths > 3, `对照组必须每帧变宽（uniq=${r.uniqGuestWidths}, span=${r.guestSpan}px）`],
    [r.asideEnd > r.asideStart + 1, `aside 确实在过渡（${r.asideStart} → ${r.asideEnd}）`],
  ],
  r2: (r) => [
    [r.uniqGuestWidths === 1, `钉住后 guest 宿主宽度必须**恒定**（uniq=${r.uniqGuestWidths}, ${r.guestMin}~${r.guestMax}）`],
    [r.guestSpan < 1, `guest 宽度抖动 < 1px（span=${r.guestSpan}）`],
    [r.asideMid > r.asideStart + 1 && r.asideMid < r.asideEnd - 1, `aside 仍在正常插值（start=${r.asideStart} mid=${r.asideMid} end=${r.asideEnd}）`],
    /* 对照 R1 = 7 帧掉帧。这里留 1 帧余量：guest 在**钉住那一帧**必须做且只做一次真实 reflow，
       这一次本身就可能落在 20ms 阈值外侧（R4 同样打钉却 0 帧 → 说明不是持续成本）。
       真正的判据是上面的 uniqGuestWidths/guestSpan，这条只是兜住 "别退化成每帧掉"。 */
    [r.jankFrames <= 1, `掉帧 ≤ 1（jank=${r.jankFrames}, dtP95=${r.dtP95}；对照 R1=7）`],
  ],
  r3: (r) => [
    [r.uniqGuestWidths === 1, `收起方向 guest 宿主宽度也必须恒定（uniq=${r.uniqGuestWidths}, span=${r.guestSpan}）`],
    [r.asideMid > 1 && r.asideMid < r.asideStart - 1, `aside 仍在正常插值（start=${r.asideStart} mid=${r.asideMid} end=${r.asideEnd}）`],
    [r.asideEnd < 1, `aside 收起到 0（end=${r.asideEnd}）`],
  ],
  r4: (r) => [
    [r.pinClassPresent === false, `解除后钉子类必须已摘（present=${r.pinClassPresent}）`],
    [r.pinVar === "(none)", `解除后 --right-pin-w 必须已清空（var=${r.pinVar}）`],
    [r.dropAtEnd < 2, `解除后 guest 回到 100% 跟随容器（guest=${r.finalGuest} vs aside=${r.finalAside}，落差=${r.dropAtEnd}px）`],
  ],
};

app.whenReady().then(async () => {
  const arg = process.argv[2] || "all";
  const keys = arg === "all" ? Object.keys(CASES) : [arg];
  const lines = [];
  let fails = 0;
  for (const key of keys) {
    const c = CASES[key];
    if (!c) { lines.push("未知场景：" + key); fails++; continue; }
    try {
      const r = await run(c);
      lines.push(`\n──── ${c.label} ────`);
      lines.push(JSON.stringify(r));
      for (const [ok, msg] of ASSERT[key](r)) {
        lines.push((ok ? "OK   " : "FAIL ") + msg);
        if (!ok) { fails++; }
      }
    } catch (e) {
      lines.push("FAIL " + key + " 探针异常：" + (e && e.stack ? e.stack : e));
      fails++;
    }
  }
  lines.push("");
  lines.push(fails === 0 ? `全部命中（${keys.length} 场景）` : `失败 ${fails} 项`);
  const out = lines.join("\n") + "\n";
  /* 结果落盘到**临时目录**，不要写进仓库：脚本已在 stdout 打印（`| tail` 与 CI 都能拿到），
     写进 gui/scripts/ 只会给工作区留一个未跟踪文件（上一版就是这么留下 assert-webview-pin.out.txt 的）。 */
  fs.writeFileSync(path.join(tmpDir, "assert-webview-pin.out.txt"), out, "utf8");
  console.log(out);
  app.exit(fails === 0 ? 0 : 1);
});
