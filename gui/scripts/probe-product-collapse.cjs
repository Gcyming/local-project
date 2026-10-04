/* eslint-disable */
/**
 * gui/scripts/probe-product-collapse.cjs — 产物卡「展开/收起衔接动画」的**真结构探针**。
 *
 * ## 为什么单独写一个（已有的 `assert-collapse-anim.cjs` 测不出这个病）
 * 已有守卫 ①–⑥ 测的是**裸 `.collapse`**：外层 grid 容器 + 一个 200px 的内容块。
 * 而真实的产物卡是**双类驱动**：
 *     <div class="prod-host is-open">      ← A-1106：width: fit-content ↔ 100%（横向）
 *       <div class="prod-card">
 *         <div class="collapse is-open">  ← 纵向：grid-template-rows 0fr ↔ 1fr
 *           <div><div class="prod-diff" style="max-height:340px;overflow:auto">…多行 diff…</div></div>
 * 两层过渡**在同一帧**启动，且宽度变化会改变 diff 的换行数 ⇒ 内容本征高度在动。
 * ⚠️ 已有守卫**只测一次开合**（`classList.add` → 采样 → `remove` → 采样），
 * 所以"第二次展开没动画"这条症状它结构上就抓不到。
 *
 * ## 本探针回答什么（全部是行为级，不看 CSS 文案）
 *   ① 第一次展开有中间帧吗？
 *   ② 收起有中间帧吗？
 *   ③ **第二次展开**有中间帧吗？（用户实测：没有）
 *   ④ 宽度序列（`fit-content → 100%`）与高度序列是否**同帧**启动？
 *
 * 用法（必须在 gui/ 下跑；结果写文件，不依赖 stdout）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-product-collapse.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(guiDir, "src", "renderer", "index.css"), "utf8");
const htmlPath = path.join(os.tmpdir(), "slime-probe-product-collapse.html");
const outPath = path.join(os.tmpdir(), "slime-probe-product-collapse.json");

/* ⚠️ 照抄真实结构：外层 `.prod-host`（横向过渡）+ `.prod-card` + `.collapse`（纵向）。
   diff 行用**长文本**（窄宽度下会换行）—— 否则宽度变化不改高度，两层过渡就不耦合，测不出来。 */
const diffRows = [];
for (let i = 0; i < 200; i += 1) {   // ⚠️ 接近真实规模（用户截图 +186 行）：34 行测不出重排成本
  diffRows.push(`+ line ${i + 1} ` + "x".repeat(72));
}
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${css}
</style></head><body style="margin:0;background:#111">
<div id="wrap" style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:660px">
  <div id="ph" class="prod-host">
    <div class="prod-card" style="border-radius:8px;padding:8px;max-width:100%">
      <div style="display:flex;gap:6px;align-items:center;font-size:12px">
        <span>v525_session.py</span>
        <span style="color:#4ade80">+186</span><span style="color:#f87171">-250</span>
      </div>
      <div class="collapse" id="pc"><div>
        <div class="prod-diff" style="margin-top:6px;border-radius:8px;overflow:hidden;max-height:340px;overflow-y:auto;font-family:Consolas,monospace;font-size:11.5px;line-height:1.65">
          ${diffRows.map((t) => `<div style="white-space:pre-wrap;word-break:break-all">${t}</div>`).join("\n          ")}
        </div>
      </div></div>
    </div>
  </div>
</div>
</body></html>`;
fs.writeFileSync(htmlPath, html, "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    /* ⚠️⚠️ 必须**可见 + 置顶**：offscreen / 隐藏窗口下 rAF 被降到 ~1fps，
       「真实播放时每帧有没有被画出来」这件事**根本测不到**（上一轮就是因此漏判的）。 */
    show: true, width: 900, height: 760,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(htmlPath);
  /* 背景负载量（ms/16ms）—— 用来模拟真实渲染进程里的主线程竞争。 */
  await win.webContents.executeJavaScript("window.__PROBE_LOAD_MS = " + Number(process.env.PROBE_LOAD_MS || 0) + "; 1");

  const r = await win.webContents.executeJavaScript(`(async () => {
    const host = document.getElementById('ph');
    const col = document.getElementById('pc');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const H = (el) => +el.getBoundingClientRect().height.toFixed(1);
const W = (el) => +el.getBoundingClientRect().width.toFixed(1);
    /* ⚠️⚠️ **确定性相位采样**（css-animation-jank-audit 技能里的纪律）：
       墙钟采样（「setTimeout(30)」）在 offscreen/后台窗口里与掉帧混叠 ⇒ 采到的是"这些时刻的值"，
       不是"动画在这些相位上的值"。混叠会把平滑曲线显示成随机抖动（第一版就因此误判成"动画在抖"，
       还差点去改缓动曲线 —— 真因是采样方法）。
       正解：拿到 CSS transition 对象 → 「pause()」 → 手动扫 「currentTime」。
       两条 transition（grid-template-rows / width）**同一相位一起钉**，才算真正的"横纵同步"。 */
    const sweep = async (props, fromOpen) => {
      const list = props.map((p) => col.getAnimations({ subtree: true }).find((a) => a.transitionProperty === p)
        || host.getAnimations().find((a) => a.transitionProperty === p)).filter(Boolean);
      if (list.length < props.length) { return null; }
      const dur = Math.max(...list.map((a) => Number(a.effect.getTiming().duration) || 0));
      for (const a of list) { a.pause(); }
      const hs = [], ws = [];
      for (let i = 0; i <= 20; i += 1) {
        const t = (dur * i) / 20;
        for (const a of list) { a.currentTime = t; }
        await raf();
        hs.push(H(col)); ws.push(W(host));
      }
      for (const a of list) { a.play(); }
      return { hs, ws, dur };
    };
    const open = async () => { host.classList.add('is-open'); col.classList.add('is-open'); };
    const close = () => { host.classList.remove('is-open'); col.classList.remove('is-open'); };

    /* ⚠️⚠️ **真实播放采样**（用户假设的核心判据）：
       确定性 sweep（pause + currentTime）只能证明"插值曲线是对的"，它等价于**强制逐相机渲染** ——
       真实播放时若某帧的布局成本超过帧预算（16.7ms），那一相位**根本没被画出来**，
       视觉上就是"展开到一半直接跳到终态"。这件事只有**不 pause + rAF 逐帧**才测得到。
       ⚠️ 前提是窗口**可见**（隐藏窗口 rAF 降到 ~1fps ⇒ 采到的是混叠）。 */
    const realSweep = async (durMs) => {
      const t0 = performance.now();
      const rows = [];
      let last = t0;
      await new Promise((res) => {
        const step = (t) => {
          /* 每帧**布局成本**：读几何会触发一次同步布局 ⇒ 用它近似"这一帧为了拿到新高度
             必须先重排多少"。这是判断"每帧贵不贵"的直接证据（掉帧是结果，这是原因）。 */
          const t0 = performance.now();
          const h = H(col);
          const layout = +(performance.now() - t0).toFixed(2);
          rows.push({ dt: +(t - last).toFixed(1), h, layout });
          last = t;
          if (t - t0 < durMs) { requestAnimationFrame(step); } else { res(); }
        };
        requestAnimationFrame(step);
      });
      return rows;
    };

    /* ⚠️ 背景负载：真实 app 里展开动画**从不孤立发生** —— 流式输出、计时器、上下文圆环…都在抢主线程。
       探针实测帧间隔只有 6ms（166Hz 屏）⇒ 帧预算 6ms ⇒ 任何叠加工作都会让它掉帧。
       用「每 16ms 忙等 N ms」模拟这份竞争（N 由 PROBE_LOAD_MS 给，默认 0 = 无竞争）。 */
    const LOAD_MS = Number(window.__PROBE_LOAD_MS || 0);
    if (LOAD_MS > 0) {
      setInterval(() => { const t = performance.now(); while (performance.now() - t < LOAD_MS) { /* 忙等 */ } }, 16);
      await sleep(120);
    }

    await raf(); await sleep(200); await raf();

    const out = { rounds: [], real: [] };
    out.closedH = H(col); out.closedW = W(host);

    /* 先取一条确定性曲线（仅作"插值形状"的参考：它是理想值，不代表用户看到的） */
    open(); await raf();
    out.deterministic = await sweep(['grid-template-rows', 'width']);
    await sleep(700); close(); await sleep(700);

    const summarize = (rows) => {
      const hs = rows.map((x) => x.h);
      const dts = rows.map((x) => x.dt);
      let maxJump = 0, jumpAt = -1;
      for (let i = 1; i < hs.length; i += 1) {
        const j = Math.abs(hs[i] - hs[i - 1]);
        if (j > maxJump) { maxJump = +j.toFixed(1); jumpAt = i; }
      }
      const layouts = rows.map((x) => x.layout || 0);
      return {
        frames: rows.length,
        maxLayout: +Math.max(0, ...layouts).toFixed(2),
        avgLayout: +(layouts.reduce((a, b) => a + b, 0) / Math.max(1, layouts.length)).toFixed(2),
        dropped: dts.filter((x) => x > 33).length,
        maxDt: +Math.max(0, ...dts).toFixed(1),
        maxJump, jumpAt,
        hs, dts,
      };
    };

    for (let round = 1; round <= 3; round += 1) {
      open();
      const ro = summarize(await realSweep(760));
      const openEnd = { h: H(col), w: W(host) };
      close();
      const rc = summarize(await realSweep(760));
      const closedEnd = { h: H(col), w: W(host) };
      out.real.push({ round, open: ro, close: rc, openEnd, closedEnd });
    }
    return out;
  })()`);

  fs.writeFileSync(outPath, JSON.stringify(r), "utf8");

  /* ── 判据 ──
     ⚠️ 分两层，别混：
       · **确定性曲线**（pause + currentTime）只作**参考** —— 它等价于"强制逐相机渲染"，
         证明的是"插值曲线本身对不对"，**证明不了真实播放时每一帧都被画出来了**。
       · **真实播放**（不 pause，rAF 逐帧）才是"用户会不会看到跳跃"的判据：
         帧间隔（> 33ms = 掉了一帧）与**相邻帧高度跃迁**（一帧跳几十像素 = 眼睛里的"跳"）。
     ⚠️ 前置条件：窗口必须**可见**。隐藏窗口 rAF 降到 ~1fps ⇒ 采到的是混叠，结论全是假的。 */
  /* 阈值 = **被实测值夹出来的**，不拍脑袋：
     加长产物卡折叠时长前单帧跃迁 16.1~19.3px；加长后 12.9~14.7px。
     取 24px 作上限：它容许正常的抖动，但一旦有人把时长缩回去 / 内容量暴增（每帧位移变大）就会红。 */
  const JUMP_LIMIT = 24;
  const lines = [];
  let bad = 0;
  const det = r.deterministic;
  lines.push(`确定性曲线（理想值·仅参考）高度：${(det ? det.hs : []).map((v) => Math.round(v)).join(", ")}`);
  lines.push("");
  let worstJump = 0, worstDrop = 0;
  for (const rd of r.real) {
    const o = rd.open, c = rd.close;
    worstJump = Math.max(worstJump, o.maxJump, c.maxJump);
    worstDrop = Math.max(worstDrop, o.dropped, c.dropped);
    lines.push(
      `第 ${rd.round} 轮【展开·真实播放】${o.frames} 帧 · 掉帧 ${o.dropped} 帧 · 最大帧间隔 ${o.maxDt}ms · 单帧最大跃迁 ${o.maxJump}px · **每帧布局 avg ${o.avgLayout}ms / max ${o.maxLayout}ms**`,
      `　　高度序列：${o.hs.map((v) => Math.round(v)).join(", ")}`,
      `　　帧间隔：${o.dts.join(", ")}`,
      `第 ${rd.round} 轮【收起·真实播放】${c.frames} 帧 · 掉帧 ${c.dropped} 帧 · 单帧最大跃迁 ${c.maxJump}px（第 ${c.jumpAt} 帧）`,
      `　　高度序列：${c.hs.map((v) => Math.round(v)).join(", ")}`,
    );
    if (o.maxJump > JUMP_LIMIT) { bad += 1; }
    if (c.maxJump > JUMP_LIMIT) { bad += 1; }
  }
  lines.push("", `汇总：单帧最大跃迁 ${worstJump}px · 单侧最多掉帧 ${worstDrop} 帧`);
  const report = [
    `初始收起态：h=${r.closedH} w=${r.closedW}`,
    ...lines,
    "",
    bad === 0 ? "结论：见上方真实播放数据（阈值待实测夹出）" : `结论：${bad} 处异常 ❌`,
  ].join("\n");
  fs.writeFileSync(outPath.replace(/\.json$/, ".txt"), report, "utf8");
  app.exit(bad === 0 ? 0 : 1);
});
