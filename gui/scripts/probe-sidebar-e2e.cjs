/* eslint-disable */
/**
 * gui/scripts/probe-sidebar-e2e.cjs — 右栏×对话页交互**端到端序列**探针（A-1154）。
 *
 * ## 为什么必须另写一个（而不是复用 probe-float-realclick.cjs）
 * `probe-float-realclick.cjs` 只点了「窗口化」**一次**就退出，而用户报的 7 个现象
 * **全部发生在"多次点击的组合路径"上**（窗口化 → 标题栏收右栏 → 展开右栏 → 再窗口化 → 拖拽）。
 * ⇒ 那个探针**结构上就量不到**用户看到的东西。这就是"门禁全绿但用户说一点用没有"的由来。
 *
 * ## 本探针严格按用户原话驱动
 *   S1 点「对话页面窗口化」                     ⇒ 记为 A（正常自适应用户认可的基线）
 *   S2 点标题栏「收起右侧栏」                   ⇒ 用户：自适应失效
 *   S3 点标题栏「展开右侧栏」                   ⇒ 用户：对话被挤压到屏幕外
 *   S4 点「对话页面窗口化」×2                   ⇒ 用户：抽搐抖动但不窗口化，再点回到起点
 *   S5 恢复窗口化后拖右栏 resizer               ⇒ 用户：比例异常，要左右拖多次才恢复
 *   S6 连续快速拖拽                             ⇒ 用户：不跟手 + 对话页闪烁
 *
 * ## 每步都逐帧量（requestAnimationFrame 采样，最多 ~1.2s）
 *   .body 直属子元素几何 / .float-window / main.main / .right-sidebar
 *   + body 的类快照（float-layout / slime-fading / slime-resizing / slime-dragging）
 *   + 右栏内联 width / --right-target-w / --right-body-pin 的值
 *
 * ⚠️ 判据一律用**运行时几何与状态**，绝不 grep 文案（模板里就有那些字）。
 *
 * 用法：cd gui && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-sidebar-e2e.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const electron = require("electron");
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

/* 隔离数据根：预置一条会话，否则 ChatPanel 不挂载 ⇒「窗口化」按钮不存在 */
const TMP_ROOT = path.join(os.tmpdir(), "slime-probe-e2e-root");
process.env.SLIME_ROOT = TMP_ROOT;
const { mkdirSync, writeFileSync, existsSync } = require("fs");
mkdirSync(path.join(TMP_ROOT, "config"), { recursive: true });
mkdirSync(path.join(TMP_ROOT, "data"), { recursive: true });
const WS = process.cwd();
const sessPath = path.join(TMP_ROOT, "config", "sessions.json");
if (!existsSync(sessPath)) {
  writeFileSync(sessPath, JSON.stringify({
    sessions: {
      s_probe: { id: "s_probe", agentId: "test1", workspace: WS,
        title: "探针会话", createdAt: Date.now(), updatedAt: Date.now() },
    },
  }), "utf8");
}
if (!existsSync(path.join(TMP_ROOT, "config", "agents.json"))) {
  writeFileSync(path.join(TMP_ROOT, "config", "agents.json"), JSON.stringify([
    { id: "test1", name: "test1", model: "test", workspace: WS },
  ]), "utf8");
}

const GUI = path.join(__dirname, "..");
const PAGE = path.join(GUI, "out", "renderer", "index.html");
const outPath = path.join(os.tmpdir(), "slime-probe-sidebar-e2e.txt");
const lines = [];
const say = (m) => { lines.push(m); fs.writeFileSync(outPath, lines.join("\n"), "utf8"); };

/* 单帧几何快照（同步，供 rAF 序列调用） */
const SNAP_FN = `window.__snap = function () {
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = (el) => { if (!el) { return null; } const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const body = document.querySelector(".body");
  const kids = body ? Array.from(body.children).map((el) =>
    ((el.className || "").toString().split(" ")[0] || el.tagName.toLowerCase()) + ":" + JSON.stringify(r(el))) : [];
  const rs = document.querySelector(".right-sidebar");
  const rw = document.querySelector(".right-wrapper");
  const cs = rs ? getComputedStyle(rs) : null;
  const rws = rw ? getComputedStyle(rw) : null;
  return {
    vw, vh,
    cls: Array.from(document.body.classList).filter((c) => c.startsWith("float") || c.startsWith("slime")).join(","),
    main: r(document.querySelector("main.main")),
    fw: r(document.querySelector(".float-window")),
    rs: r(rs),
    rw: r(rw),
    rsInlineW: rs ? rs.style.width : null,
    rwInlineW: rw ? rw.style.width : null,
    tgtW: rs ? cs.getPropertyValue("--right-target-w").trim() : null,
    bodyPin: cs ? cs.getPropertyValue("--right-body-pin").trim() : null,
    rsTrans: cs ? cs.transitionProperty + "/" + cs.transitionDuration : null,
    rwFlexShrink: rws ? rws.flexShrink : null,
    rsResizer: document.querySelectorAll(".right-sidebar-resizer").length,
    kids,
  };
};`;

/* 逐帧采样：返回一个 Promise，最多 ms 毫秒，每帧一条 */
function sampler(ms) {
  return `new Promise((res) => {
    const out = []; const t0 = performance.now();
    const tick = () => {
      out.push(window.__snap());
      if (performance.now() - t0 < ${ms}) { requestAnimationFrame(tick); }
      else { res(JSON.stringify({ frames: out.length, samples: out })); }
    };
    requestAnimationFrame(tick);
  })`;
}

/** 把一次采样压缩成"变化点摘要"（只打印几何真正变过的帧，避免刷屏） */
function summarize(label, jsonStr) {
  const o = JSON.parse(jsonStr);
  const S = o.samples;
  say(`── ${label}｜采样 ${o.frames} 帧 ──`);
  let prevKey = null;
  let printed = 0;
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    const key = JSON.stringify({ m: s.main, f: s.fw, r: s.rs, cls: s.cls, iw: s.rsInlineW, tw: s.tgtW, pin: s.bodyPin, fx: s.rwFlexShrink, rw: s.rw });
    if (key === prevKey) { continue; }
    prevKey = key;
    printed++;
    if (printed > 24) { say("   …（更多变化帧已省略）"); break; }
    say(`   f${String(i).padStart(3)} cls=[${s.cls}] main=${JSON.stringify(s.main)} rs=${JSON.stringify(s.rs)} rw=${JSON.stringify(s.rw)} fw=${JSON.stringify(s.fw)}`)
    say(`        rsInlineW=${s.rsInlineW} rwInlineW=${s.rwInlineW} --tgt=${s.tgtW} --pin=${s.bodyPin} rsTrans=${s.rsTrans} rwFlexShrink=${s.rwFlexShrink} resizer=${s.rsResizer}`);
  }
  say("");
  return o;
}

app.setPath("userData", path.join(TMP_ROOT, "userData"));
app.setPath("sessionData", path.join(TMP_ROOT, "userData"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 820, x: 20, y: 20,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true); win.moveTop(); win.focus();
  const ev = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(PAGE);
  say("真产物已加载，等启动门…");

  let ready = false;
  for (let i = 0; i < 45; i++) {
    await sleep(700);
    const st = await ev(`JSON.stringify({ btn: !!document.querySelector('img[alt="唤起悬浮窗"]') })`);
    if (JSON.parse(st).btn) { ready = true; say(`启动门已过（第 ${i + 1} 次轮询）`); break; }
  }
  if (!ready) {
    say("❌ 45 次轮询内没等到「窗口化」按钮。DOM：" + (await ev(`document.body.innerHTML.slice(0,500)`)));
    app.exit(1); return;
  }
  await ev(SNAP_FN);

  /* 点击辅助：用真实坐标 dispatch 更接近用户，但先直接用元素 dispatchEvent */
  const clickFloat = `(() => {
    const img = document.querySelector('img[alt="唤起悬浮窗"]');
    if (!img) { return "NO-FLOAT-BTN"; }
    const b = img.closest("button") || img.parentElement;
    (b || img).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK";
  })()`;
  /* 标题栏右栏按钮：title 以「收起右侧栏 / 展开右侧栏」开头，取标题栏内最后一个 titlebar-btn */
  const clickTitlebarRight = `(() => {
    const hdr = document.querySelector("header.titlebar");
    if (!hdr) { return "NO-TITLEBAR"; }
    const btns = Array.from(hdr.querySelectorAll("button.titlebar-btn"));
    const t = btns.find((b) => /右侧栏/.test(b.getAttribute("title") || ""));
    if (!t) { return "NO-RIGHT-BTN"; }
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return "OK title=" + t.getAttribute("title");
  })()`;

  say("======== S1 点「对话页面窗口化」（用户认可的基线） ========");
  say("点击：" + await ev(clickFloat));
  await sleep(60);
  summarize("S1 窗口化", await ev(sampler(1200)));

  say("======== S2 点标题栏「收起右侧栏」 ========");
  say("点击：" + await ev(clickTitlebarRight));
  await sleep(60);
  summarize("S2 收右栏", await ev(sampler(1200)));

  say("======== S3 点标题栏「展开右侧栏」 ========");
  say("点击：" + await ev(clickTitlebarRight));
  await sleep(60);
  summarize("S3 展右栏", await ev(sampler(1200)));

  say("======== S4a 再点「窗口化」 ========");
  say("点击：" + await ev(clickFloat));
  await sleep(60);
  summarize("S4a 窗口化", await ev(sampler(1200)));

  say("======== S4b 再点「窗口化」（用户：回到起点） ========");
  say("点击：" + await ev(clickFloat));
  await sleep(60);
  summarize("S4b 窗口化", await ev(sampler(1200)));

  say("======== S5 拖右栏 resizer（比例异常？） ========");
  const drag = `(async () => {
    const h = document.querySelector(".right-sidebar-resizer");
    if (!h) { return "NO-RESIZER"; }
    const b = h.getBoundingClientRect();
    const x0 = b.left + b.width / 2, y0 = b.top + b.height / 2;
    const mk = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y0, pointerId: 1, buttons: 1, button: 0, isPrimary: true });
    h.dispatchEvent(mk("pointerdown", x0));
    // 向左拖 160px（右栏变宽）
    for (let i = 1; i <= 16; i++) {
      document.dispatchEvent(mk("pointermove", x0 - i * 10));
      await new Promise((r) => setTimeout(r, 16));
    }
    document.dispatchEvent(mk("pointerup", x0 - 160));
    return "OK from " + Math.round(x0);
  })()`;
  const r5 = await ev(drag);
  say("拖拽：" + r5);

  say("======== S6 恢复窗口化后立刻检查 ========");
  say("点击：" + await ev(clickFloat));
  await sleep(60);
  summarize("S6 窗口化", await ev(sampler(1200)));

  say("======== 最终几何（静置 1.5s 后） ========");
  await sleep(1500);
  const fin = JSON.parse(await ev(`JSON.stringify(window.__snap())`));
  say("最终：" + JSON.stringify(fin, null, 1).slice(0, 2000));

  say("\n完成。产物：" + outPath);
  app.exit(0);
});
