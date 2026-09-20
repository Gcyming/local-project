/*
 * 守卫：展开/收起衔接动画**真的在播**（A-1015 / A-1015b）。
 *
 * 两类容器，一套节拍（--collapse-dur / --collapse-ease，decelerate = 侧栏那条 0→0.2→1）：
 *   · `.collapse` —— **文档流内**的展开/收起（高度插值 grid-template-rows 0fr↔1fr）
 *   · `.pop` / `.pop-up` —— **绝对定位浮层**（下拉菜单 / 气泡），做淡入+位移，不做高度插值
 *
 * 为什么需要它：`.collapse` 用的是 `grid-template-rows: 0fr ↔ 1fr` 插值。这条规则"规范上可插值"
 * 不等于"在这台机器上逐帧在动"——A-1000 的教训是布局/动画不要靠规范推演，要离屏实测。
 * 而动画失效是**静默**的：界面看起来"能展开"，只是生硬跳变，tsc / vitest / 产物断言全绿。
 * 浮层那一侧最隐蔽的是 **pointer-events**：常驻挂载后若收起态不关掉命中测试，
 * 一个"看不见的浮层"会盖住触发按钮 → 用户报"点加号没反应"，而 DevTools 里什么都看不到。
 *
 * 断言的是**关系性质**，不写死任何像素值 / 时长：
 *   【collapse】① 展开全程有 ≥3 个严格位于 (0, 终值) 之间的中间帧（= 真的在插值，不是瞬跳）
 *   ② 展开采样单调不减
 *   ③ 曲线先快后慢（前半段平均增量 > 后半段）—— 对齐侧栏 cubic-bezier(0,0,0.2,1) 的 decelerate
 *   ④ 展开终值 > 内层内容高度（说明内容整体参与布局，没有被裁掉）
 *   ⑤ **收起后高度回 0**——守的是"内层 margin 漏成残留高度"这一类真实 bug
 *   ⑥ 收起态 opacity=0 / grid 行 visibility=hidden；展开态相反
 *   【pop】⑦ 收起态三件套 pointer-events:none / visibility:hidden / opacity:0（缺一即真 bug）
 *   ⑧ 展开态三件套 auto / visible / 1
 *   ⑨ 展开、收起都有中间帧（淡入淡出真的在动）
 *   ⑩ 曲线先快后慢（与 collapse 同一条曲线）
 *   ⑪ `.pop` 收起位移朝上、`.pop-up` 收起位移朝下（方向必须相反）
 *   ⑫ 移除 is-open 后**立刻**读 visibility 仍是 visible（延迟到动画结束才隐藏，否则内容"啪"地消失）
 *   ⑭ A-1016：`.collapse > *` 的 content-visibility。展开方向必须 **0 延迟**归 visible
 *      （1fr 靠内容本征高度才能插值）；收起方向必须**推迟**到动画结束才转 hidden
 *      （裸 CV 实测会在第 0 帧就跳过渲染 → 收起插值被整段抹掉），且真的会归位（不是永不 hidden）。
 *   ⑬ 静态：**没有任何残留的「条件渲染 + position:absolute」浮层**（除具名豁免）
 *
 * 用法（必须在 gui/ 下跑；Windows 上 Electron 是 GUI 子系统进程，本脚本把结果写文件，
 * 不依赖 stdout，因此 terminal 里看不到中间输出是正常的）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/assert-collapse-anim.cjs
 * 退出码 0 = 全部命中；1 = 有断言失败（逐条打印）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(guiDir, "src", "renderer", "index.css"), "utf8");
const htmlPath = path.join(os.tmpdir(), "slime-probe-collapse.html");

const fail = [];
const pass = [];
const check = (cond, label, detail) => {
  (cond ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// 复刻真实层级：.collapse > 纯 div(grid 行) > 带 margin 的内容（margin 是"漏成残留高度"的诱因）
// 浮层侧：一个 relative 容器里放两个绝对定位浮层（plain / pop-up），复刻菜单与向上气泡两种锚向
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${css}
</style></head><body style="margin:0;background:#111">
<div style="width:300px;background:#222">
  <div id="c" class="collapse">
    <div>
      <div id="inner" style="height:200px;background:#3a3;margin-top:8px">内容</div>
    </div>
  </div>
</div>
<div style="position:relative;width:300px;height:220px;background:#222">
  <div id="pd" class="pop" style="position:absolute;top:0;left:0;width:200px;height:100px;background:#345">菜单</div>
  <div id="pu" class="pop pop-up" style="position:absolute;bottom:0;left:0;width:200px;height:100px;background:#453">气泡</div>
</div>
</body></html>`;
fs.writeFileSync(htmlPath, html, "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 500, height: 600,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(htmlPath);

  // ── 浮层：淡入淡出 + 位移方向 + pointer-events + visibility 延迟 ──
  // 采样前先热身（等首帧真的开始跑）。这里踩过一次：本脚本是 loadFile 之后**第一个** eval，
  // 若第一帧还没 tick，transition 的起始时间戳被推到 ~200ms 之后，
  // 结果"展开"采到一串 0 再跳 —— 看起来像"曲线不对"，其实是**采样窗口没对准动画**（假红）。
  const p = await win.webContents.executeJavaScript(`(async () => {
    const el = document.getElementById('pd');
    const up = document.getElementById('pu');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    await raf(); await sleep(120); await raf();
    const cs = (e) => getComputedStyle(e);
    const op = (e) => +(+cs(e).opacity).toFixed(3);
    // transform: none 视为 0；matrix(a,b,c,d,tx,ty) → 取 ty
    const ty = (e) => {
      const m = cs(e).transform;
      if (!m || m === 'none') { return 0; }
      const g = m.match(/-?[\\d.]+/g);
      if (!g) { return 0; }
      return g.length >= 6 ? +(+g[5]).toFixed(2) : 0;
    };
    const snap = (e) => ({ o: op(e), vis: cs(e).visibility, pe: cs(e).pointerEvents, ty: ty(e) });
    const closed = snap(el);
    const closedUpTy = ty(up);
    const opening = [];
    el.classList.add('is-open'); up.classList.add('is-open');
    for (let i = 0; i < 20; i++) { await sleep(20); opening.push(op(el)); }
    await sleep(320);
    const open = snap(el);
    el.classList.remove('is-open');
    const justClosedVis = cs(el).visibility;   // 同步读：应仍是 visible（隐藏被 delay 推迟了）
    const closing = [];
    for (let i = 0; i < 20; i++) { await sleep(20); closing.push(op(el)); }
    await sleep(420);
    const closedAgain = snap(el);
    return { closed, open, closedAgain, justClosedVis, closedUpTy, opening, closing };
  })()`);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const c = document.getElementById('c');
    const row = c.firstElementChild;
    const inner = document.getElementById('inner');
    const H = (el) => +el.getBoundingClientRect().height.toFixed(1);
    const cv = (el) => getComputedStyle(el).contentVisibility;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const sample = async (n, step) => { const a = []; for (let i = 0; i < n; i++) { await sleep(step); a.push(H(c)); } return a; };

    const closed = { h: H(c), opacity: getComputedStyle(c).opacity, vis: getComputedStyle(row).visibility, cv: cv(row) };
    c.classList.add('is-open');
    const openCV = cv(row);   // 同步读：展开方向必须 0 延迟 → 立刻 visible
    const opening = await sample(16, 30);
    await sleep(400);
    const open = { h: H(c), opacity: getComputedStyle(c).opacity, vis: getComputedStyle(row).visibility, innerH: H(inner) };
    c.classList.remove('is-open');
    const justClosedCV = cv(row);   // 同步读：收起瞬间仍 visible（转 hidden 被 delay 推后）
    const closing = await sample(16, 30);
    await sleep(400);
    const closedAgain = { h: H(c), opacity: getComputedStyle(c).opacity, vis: getComputedStyle(row).visibility, cv: cv(row) };
    return { closed, open, closedAgain, opening, closing, openCV, justClosedCV };
  })()`);

  /* ⚠️ 这里**不要** win.destroy()。实测：离屏（offscreen:true）窗口在 destroy 时会偶发硬崩
     （stderr 只留一行 crashpad「not connected」，进程被直接带走 → 退出码 127、断言结果一个字都打不出来，
     表现为"守卫莫名其妙红了/绿了"。插桩定位过：两个 eval 都已返回，死在 destroy 那一行）。
     数据此时已全部拿到，直接 app.exit() 结束进程即可（进程退出本身会拆掉窗口）。 */

  const finalH = r.open.h;
  const mids = r.opening.filter((h) => h > 0.5 && h < finalH - 0.5).length;
  check(mids >= 3, "① 展开有中间帧（真的在插值，不是瞬跳）", `中间帧 ${mids} 个 > 0，序列 ${r.opening.join(", ")}`);

  const mono = r.opening.every((h, i) => i === 0 || h >= r.opening[i - 1] - 0.2);
  check(mono, "② 展开采样单调不减", r.opening.join(", "));

  const half = Math.floor(r.opening.length / 2);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const d1 = r.opening.slice(1, half).map((h, i) => h - r.opening[i]);
  const d2 = r.opening.slice(half + 1).map((h, i) => h - r.opening[half + i]);
  check(avg(d1) > avg(d2), "③ 展开曲线先快后慢（decelerate，对齐侧栏）", `前半均增 ${avg(d1).toFixed(1)} > 后半均增 ${avg(d2).toFixed(1)}`);

  const c1 = r.closing.slice(1, half).map((h, i) => r.closing[i] - h);
  const c2 = r.closing.slice(half + 1).map((h, i) => r.closing[half + i] - h);
  check(avg(c1) > avg(c2), "③b 收起曲线先快后慢", `前半均减 ${avg(c1).toFixed(1)} > 后半均减 ${avg(c2).toFixed(1)}`);

  check(r.open.h > r.open.innerH, "④ 展开终值 > 内层内容高度（内容整体参与布局）", `block ${r.open.h} > inner ${r.open.innerH}`);
  check(r.closedAgain.h === 0, "⑤ 收起后高度回 0（内层 margin 不残留）", `closedAgain.h=${r.closedAgain.h}`);
  check(r.closed.h === 0, "⑤b 初始收起态高度为 0", `closed.h=${r.closed.h}`);
  check(r.closed.opacity === "0" && r.open.opacity === "1", "⑥ opacity 0↔1", `${r.closed.opacity} → ${r.open.opacity}`);
  check(r.closed.vis === "hidden" && r.open.vis === "visible", "⑥b grid 行 visibility hidden↔visible", `${r.closed.vis} → ${r.open.vis}`);

  /* ⑭ A-1016：content-visibility（收起态跳过渲染/布局）。三条缺一不可：
       ① 展开 0 延迟归 visible —— 否则 1fr 拿不到内容本征高度，插值不发生；
       ② 收起瞬间仍 visible —— 延迟到动画走完才转 hidden；
       ③ 动画结束后真的归 hidden —— 否则"延迟"退化成"永不生效"，优化白做。
     裸 CV（无延迟）实测：外层高度第 0 帧即归 0，收起插值被整段抹掉 → ⑭b 会红。 */
  check(r.closed.cv === "hidden" && r.openCV === "visible",
    "⑭ 展开方向 content-visibility 0 延迟归 visible（1fr 要靠内容本征高度插值）",
    `closed=${r.closed.cv} → 展开瞬间=${r.openCV}`);
  check(r.justClosedCV === "visible",
    "⑭b 收起瞬间 content-visibility 仍 visible（推迟到动画结束，否则收起插值被抹掉）",
    `justClosedCV=${r.justClosedCV}`);
  check(r.closedAgain.cv === "hidden",
    "⑭c 收起 880ms 后 content-visibility 归 hidden（延迟真的生效，不是永不跳过渲染）",
    `closedAgain.cv=${r.closedAgain.cv}`);

  /* ───────── A-1015b：`.pop` 绝对定位浮层 ───────── */

  // ⑦ / ⑧ 两态三件套。pointer-events 是这里最要命的一项：常驻挂载后收起态若还能命中，
  // 就是"看不见的浮层盖住触发按钮"。
  check(p.closed.pe === "none" && p.open.pe === "auto", "⑦ pointer-events none↔auto（收起态必须让点击穿透）", `${p.closed.pe} → ${p.open.pe}`);
  check(p.closed.vis === "hidden" && p.open.vis === "visible", "⑦b visibility hidden↔visible", `${p.closed.vis} → ${p.open.vis}`);
  check(p.closed.o === 0 && p.open.o === 1, "⑦c opacity 0↔1", `${p.closed.o} → ${p.open.o}`);

  // 只截取"动画真正在跑"的那一段（掐掉首尾的静止平台）：多采样几十毫秒是廉价的，
  // 但把 0/1 平台算进均值会让"先快后慢"的判据失真（decelerate 的尾巴极长，尾段全 1）。
  const activeWin = (arr) => {
    const i0 = arr.findIndex((v) => v > 0.001);
    if (i0 < 0) { return []; }
    let i1 = arr.length - 1;
    while (i1 > i0 && arr[i1] >= 0.999) { i1--; }
    return arr.slice(i0, Math.min(arr.length, i1 + 2));
  };
  const openSeq = activeWin(p.opening);
  const closeSeq = activeWin(p.closing);

  const pMidsOpen = openSeq.filter((o) => o > 0.01 && o < 0.99).length;
  check(pMidsOpen >= 3, "⑨ 展开有中间帧（淡入真的在动）", `中间帧 ${pMidsOpen} 个，动画窗口 ${openSeq.join(", ")}`);
  const pMidsClose = closeSeq.filter((o) => o > 0.01 && o < 0.99).length;
  check(pMidsClose >= 3, "⑨b 收起有中间帧（淡出真的在动，不是瞬跳）", `中间帧 ${pMidsClose} 个，动画窗口 ${closeSeq.join(", ")}`);

  const ph = Math.floor(openSeq.length / 2);
  const po1 = openSeq.slice(1, ph).map((o, i) => o - openSeq[i]);
  const po2 = openSeq.slice(ph + 1).map((o, i) => o - openSeq[ph + i]);
  check(avg(po1) > avg(po2), "⑩ 浮层淡入先快后慢（与 collapse 同一条曲线）", `前半均增 ${avg(po1).toFixed(3)} > 后半均增 ${avg(po2).toFixed(3)}`);
  const pc1 = closeSeq.slice(1, ph).map((o, i) => closeSeq[i] - o);
  const pc2 = closeSeq.slice(ph + 1).map((o, i) => closeSeq[ph + i] - o);
  check(avg(pc1) > avg(pc2), "⑩b 浮层淡出先快后慢", `前半均减 ${avg(pc1).toFixed(3)} > 后半均减 ${avg(pc2).toFixed(3)}`);

  // ⑪ 位移方向：普通 .pop 收起态向上（ty<0，菜单从按钮上方"掉"下来）；
  //    .pop-up 收起态向下（ty>0，气泡从按钮下方"升"上去）。两者必须反向。
  check(p.closed.ty < 0 && p.closedUpTy > 0, "⑪ .pop 收起朝上 / .pop-up 收起朝下（位移方向相反）", `pop ty=${p.closed.ty}，pop-up ty=${p.closedUpTy}`);
  check(p.open.ty === 0, "⑪b 展开态无残余位移", `open ty=${p.open.ty}`);

  // ⑫ 隐藏要**推迟**到动画结束：移除 is-open 后同步读仍是 visible，
  //    否则浮层在淡出还没走完时就让内容消失（观感 = 直接没了）。
  check(p.justClosedVis === "visible", "⑫ 收起瞬间 visibility 仍 visible（隐藏被 delay 推迟，不是立刻消失）", `justClosedVis=${p.justClosedVis}`);
  check(p.closedAgain.vis === "hidden" && p.closedAgain.pe === "none" && p.closedAgain.o === 0,
    "⑫b 收起 420ms 后归位（延迟真的生效，不是永不隐藏）",
    `vis=${p.closedAgain.vis} pe=${p.closedAgain.pe} o=${p.closedAgain.o}`);

  /* ───────── A-1015b：静态 —— 不许再有「条件渲染 + 绝对定位」的浮层 ─────────
     这是浮层"生硬出现"的**唯一形态**：`{open && (<div style={{position:"absolute"…}}>…</div>)}`。
     条件渲染 = 收起即卸载 = 结构上不可能有进出场。
     具名豁免（都不是浮层，逐个说明为什么可以留着）：
       · App.tsx `showAgents && (`      —— 整块页面切换，不是浮层
       · SubagentAvatar `running && (`  —— 头像上的运行徽标（纯装饰圆点，无进出场语义）
       · AgentsPanel `q !== "" && (`    —— 输入框内的"清空"按钮（不是浮层，且必须即时出现）
       · RightSidebar `modal && (`      —— 模态遮罩弹层（有自己的交互约定，不属于"展开/收起"）
       · RightSidebar `!active && !navUrl && (` —— 浏览器空态提示层（inset:0 铺满、pointerEvents:none、
         纯"有没有页面"的状态提示，没有展开/收起语义；它和 `{loading && active && …}` 进度条是一类）
     任何新增命中都会让本项变红 —— 要么改成常驻 + .pop，要么把理由写进这张豁免表。 */
  const ALLOW_COND = ["showAgents && (", "running && (", "q !== \"\" && (", "modal && (", "!active && !navUrl && ("];
  const residuals = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
      if (!fp.endsWith(".tsx")) { continue; }
      const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!/\{\s*[^;]*&&\s*\(\s*$/.test(t)) { continue; }
        if (!/position:\s*"absolute"/.test(lines.slice(i, i + 8).join("\n"))) { continue; }
        if (ALLOW_COND.includes(t.replace(/^\{/, ""))) { continue; }
        residuals.push(`${path.relative(guiDir, fp)}:${i + 1}  ${t}`);
      }
    }
  };
  walk(path.join(guiDir, "src", "renderer"));
  check(residuals.length === 0, "⑬ 无残留「条件渲染 + position:absolute」浮层（收起即卸载 = 结构上不可能有动画）",
    residuals.length ? residuals.join(" | ") : "全部浮层已改常驻挂载 + .pop");

  try { fs.unlinkSync(htmlPath); } catch { /* 临时文件清理失败不影响结论 */ }

  for (const p2 of pass) { console.log("OK   " + p2); }
  for (const f of fail) { console.log("FAIL " + f); }
  if (fail.length === 0) {
    console.log(`\n展开/收起衔接动画守卫全部命中（${pass.length} 项：.collapse + .pop）`);
    app.exit(0);
  } else {
    console.log(`\n展开/收起衔接动画守卫失败 ${fail.length} 项（通过 ${pass.length} 项）`);
    app.exit(1);
  }
});
