/*
 * 守卫：价目明细**内联展开在对应模型行的正下方**，且展开不扰动列宽（A-1017）。
 *
 * 为什么需要它：这块地方被改过三次，每一次的"病"都是几何的、而且是静默的 ——
 *   · A-998：插行后列左右跳（诊断认为是"内容变高 → 容器出现纵向滚动条 → 挤压内容宽 →
 *            tableLayout:fixed 整表重排"）。当时改成"底部固定区块"绕开了它。
 *   · A-1017：用户指出绕开的代价是**位置错了** —— "每次都是出现在最下面……我觉得展开应该是
 *            出现在对应模型的下面"。而当初的抖动源（滚动条挤压宽度）已在 A-999 用
 *            `scrollbarGutter: stable` 根治，所以内联插行可以回去了。
 * 这类回归 tsc / vitest / 产物断言**全绿**（结构对、字符串在），只有离屏实测能看出来。
 *
 * 断言的（都是关系性质，不写死像素）：
 *   ① 位置：展开第 k 行 → 明细块紧贴**该行**下边界（间隙 = 模板里的 marginTop），且不贴表格底
 *   ② 跟随：展开靠上的行 vs 靠下的行，明细块的纵向位置必须**明显不同**（锁死"永远在最下面"）
 *   ③ 列稳：整个展开动画期间，6 个表头的 offsetLeft/offsetWidth 与首行各单元格的 left/width
 *           必须逐帧恒定（最大波动 ≤ 0.5px）—— 这是 A-998 那个"列左右跳"的回归锚点
 *   ④ 动画：明细块高度有 ≥3 个严格位于 (0, 终值) 之间的中间帧（真的在插值，不是瞬现）
 *   ⑤ 居中：复刻组件的居中滚动公式后，明细块中心与滚动容器中心对齐（≤2px），且滚动位置真的变了
 *   ⑥ 收起后该行不占高（≤1px 残留）—— 守"内层 margin 漏成残留高度"这一类真 bug
 *
 * 用法（必须在 gui/ 下跑；Windows 上 Electron 是 GUI 子系统进程，结果靠 exit code）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/assert-price-detail-inline.cjs
 * 退出码 0 = 全部命中；1 = 有断言失败（逐条打印）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const guiDir = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(guiDir, "src", "renderer", "index.css"), "utf8");
const htmlPath = path.join(os.tmpdir(), "slime-probe-price-detail.html");

const fail = [];
const pass = [];
const check = (cond, label, detail) => {
  (cond ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* 复刻真实结构（务必与 ProvidersPanel 的弹窗一致，脚手架失真比没有脚手架更糟）：
 *  · 滚动容器：flex:1 1 auto + minHeight:0 + overflowY:auto + paddingRight:4 + scrollbarGutter:stable
 *  · 表格：width:100% + borderCollapse:collapse + fontSize:13 + tableLayout:fixed
 *  · 表头列宽逐字抄自源码：启用 9% / 模型ID(auto) / 上下文K 9.5% / 输出K 9.5% / 图片 6.5% / 定价来源 26%
 *  · 每行后面跟一个常驻的明细 <tr>（td colSpan=6，padding 0，border none），内层 .collapse（来自真实 index.css）
 *  · 明细内容 maxHeight:560 + overflowY:auto + scrollbarGutter:stable + marginTop:10（与组件同值）
 */
const ROWS = 12;
const rowsHtml = Array.from({ length: ROWS }, (_, i) => `
  <tr class="mrow" data-row="${i}" style="border-top:1px solid var(--border)">
    <td style="padding:5px 6px 5px 8px"><div style="height:20px">●</div></td>
    <td style="padding:5px 8px"><div style="height:20px">model-${i}</div></td>
    <td style="padding:5px 6px"><div style="height:20px">1024</div></td>
    <td style="padding:5px 6px"><div style="height:20px">8</div></td>
    <td style="padding:5px 6px"><div style="height:20px"></div></td>
    <td style="padding:5px 6px"><div style="height:20px">手填</div></td>
  </tr>
  <tr class="drow" data-for="${i}">
    <td colspan="6" style="padding:0;border:none">
      <div class="collapse"><div>
        <div class="dbox" style="margin-top:10px;margin-bottom:4px;max-height:560px;overflow-y:auto;scrollbar-gutter:stable;border:1px solid var(--border-hover);border-radius:10px;background:var(--bg-secondary);padding:10px 12px 12px">
          <div style="height:180px">价目明细内容</div>
        </div>
      </div></div>
    </td>
  </tr>`).join("");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${css}
</style></head><body style="margin:0;background:#111">
<div style="width:1000px">
  <div id="box" style="flex:1 1 auto;min-height:0;height:320px;overflow-y:auto;padding-right:4px;scrollbar-gutter:stable">
    <div id="mhead" style="display:flex;margin-bottom:12px"><div style="height:20px">③ 模型调试</div></div>
    <table id="tbl" style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed">
      <thead><tr style="text-align:left;color:#aaa;font-size:12px">
        <th id="h0" style="padding:5px 6px 5px 8px;width:9%">启用</th>
        <th id="h1" style="padding:5px 8px">模型 ID</th>
        <th id="h2" style="padding:5px 6px;width:9.5%">上下文K</th>
        <th id="h3" style="padding:5px 6px;width:9.5%">输出K</th>
        <th id="h4" style="padding:5px 6px;width:6.5%">图片</th>
        <th id="h5" style="padding:5px 6px;width:26%">定价来源</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</div>
</body></html>`;
fs.writeFileSync(htmlPath, html, "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 500,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(htmlPath);

  const r = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // 热身：等首帧真的开始跑，否则 transition 起始时间戳会被推到下一帧（采样窗口没对准 → 假红）
    await raf(); await sleep(120); await raf();

    const box = document.getElementById('box');
    const tbl = document.getElementById('tbl');
    const rows = [...document.querySelectorAll('tr.mrow')];
    const drows = [...document.querySelectorAll('tr.drow')];
    const collapseOf = (i) => drows[i].querySelector('.collapse');
    const dboxOf = (i) => drows[i].querySelector('.dbox');
    const R = (el) => el.getBoundingClientRect();
    const H = (el) => +R(el).height.toFixed(2);

    // ── 列指纹：6 个表头 + 首行各单元格的 left/width ──
    const colFingerprint = () => {
      const out = [];
      for (let c = 0; c < 6; c++) {
        const th = document.getElementById('h' + c);
        out.push(+th.offsetLeft.toFixed(2), +th.offsetWidth.toFixed(2));
        const td = rows[0].children[c];
        out.push(+td.getBoundingClientRect().left.toFixed(2), +td.getBoundingClientRect().width.toFixed(2));
      }
      return out;
    };
    const spread = (samples) => {
      const out = [];
      for (let k = 0; k < samples[0].length; k++) {
        const vs = samples.map((s) => s[k]);
        out.push(Math.max(...vs) - Math.min(...vs));
      }
      return Math.max(...out);
    };

    // ── 场景 1：展开靠上的行（第 1 行）──
    const fpBefore = colFingerprint();
    const c1 = collapseOf(1);
    c1.classList.add('is-open');
    /* ⚠️ 插值要量 **.collapse 壳**，不是内层 .dbox：壳走 grid-template-rows 0fr↔1fr，
       内层内容是被 overflow:hidden 裁掉的，它的自身高度全程都是终值（量它永远是"0 中间帧"假红）。 */
    const heights = [];
    const fps = [colFingerprint()];
    for (let i = 0; i < 24; i++) { await sleep(20); heights.push(H(c1)); fps.push(colFingerprint()); }
    await sleep(300);
    const rowRect1 = R(rows[1]);
    const dRect1 = R(dboxOf(1));
    const tblRect = R(tbl);
    const boxRect = R(box);
    const h1 = H(c1);
    const gap1 = +(dRect1.top - rowRect1.bottom).toFixed(2);
    const topInTable1 = +(dRect1.top - tblRect.top).toFixed(2);
    const colSpread = spread([fpBefore, ...fps]);

    // 明细块是否"贴表格底"（= 旧实现的特征）：它的下边界离表格底部不足一个行高
    const rowH = +(R(rows[0]).height).toFixed(2);
    const bottomGap1 = +(tblRect.bottom - dRect1.bottom).toFixed(2);

    // ── 场景 5：居中滚动（复刻组件公式）──
    const before = box.scrollTop;
    const elRect = R(dboxOf(1)), boxRect2 = R(box);
    const delta = (elRect.top - boxRect2.top) + elRect.height / 2 - boxRect2.height / 2;
    box.scrollTop = box.scrollTop + delta;
    await sleep(60);
    const afterCenter = R(dboxOf(1));
    const centerErr = +Math.abs((afterCenter.top + afterCenter.height / 2) - (R(box).top + R(box).height / 2)).toFixed(2);
    const scrolled = Math.abs(box.scrollTop - before) > 5;

    // ── 场景 6：收起后不占高 ──
    box.scrollTop = 0;
    await sleep(40);
    c1.classList.remove('is-open');
    await sleep(700);
    const closedH = H(drows[1]);

    // ── 场景 2：展开靠下的行（第 9 行），位置必须不同 ──
    const c9 = collapseOf(9);
    c9.classList.add('is-open');
    await sleep(700);
    const dRect9 = R(dboxOf(9));
    const topInTable9 = +(dRect9.top - tblRect.top).toFixed(2);
    const gap9 = +(R(dboxOf(9)).top - R(rows[9]).bottom).toFixed(2);
    const bottomGap9 = +(R(tbl).bottom - dRect9.bottom).toFixed(2);
    c9.classList.remove('is-open');
    await sleep(500);

    return {
      gap1, gap9, topInTable1, topInTable9, bottomGap1, bottomGap9, rowH,
      colSpread, heights, h1, closedH, centerErr, scrolled, boxH: +R(box).height.toFixed(2),
    };
  })()`);

  /* ⚠️ 不要 win.destroy()：offscreen 窗口在 destroy 时偶发硬崩（crashpad not connected），
     会把退出码与断言输出一起带走（同 assert-collapse-anim.cjs / assert-webview-pin.cjs 的教训）。 */
  try { fs.unlinkSync(htmlPath); } catch { /* 临时文件清理失败不影响结论 */ }

  const midFrames = r.heights.filter((h) => h > 0.5 && h < r.h1 - 0.5).length;
  const openIsUnderRow = r.gap1 >= 6 && r.gap1 <= 16;
  const followsRow = Math.abs(r.topInTable9 - r.topInTable1) > r.rowH * 4;
  const notStuckToBottom = r.bottomGap1 > r.rowH * 1.5 && r.bottomGap9 > r.rowH * 1.5;

  check(openIsUnderRow, "① 明细紧贴被展开的那一行下方（间隙 = 模板 marginTop 10px 量级）",
    `gap=${r.gap1}px（row.bottom → detail.top）`);
  check(notStuckToBottom, "①b 明细不在表格最底部（旧「固定区块」的特征是贴底）",
    `距表底 ${r.bottomGap1}px / ${r.bottomGap9}px，行高 ${r.rowH}px`);
  check(followsRow, "② 展开不同行 → 明细位置跟着变（锁死「每次都出现在最下面」）",
    `第1行 top=${r.topInTable1} vs 第9行 top=${r.topInTable9}，行高 ${r.rowH}px`);
  check(r.colSpread <= 0.5, "③ 整段展开动画期间列宽零波动（tableLayout:fixed 不重排、列不左右跳）",
    `6 表头 + 6 单元格的 left/width 最大波动 ${r.colSpread}px`);
  check(midFrames >= 3, "④ 明细高度真的在插值（≥3 个严格中间帧，不是瞬现）",
    `中间帧 ${midFrames} 个，终值 ${r.h1}px`);
  check(r.centerErr <= 2, "⑤ 复刻组件的居中公式后，明细中心与滚动容器中心对齐", `偏差 ${r.centerErr}px`);
  check(r.scrolled, "⑤b 居中确实产生了滚动（不是本来就居中才「对齐」）", `${r.boxH}px 容器`);
  check(r.closedH <= 1.5, "⑥ 收起后该行不占高（不留空隙/残留 margin）", `${r.closedH}px`);

  for (const p of pass) { console.log("OK   " + p); }
  for (const f of fail) { console.log("FAIL " + f); }
  if (fail.length === 0) {
    console.log(`\n价目明细内联展开守卫全部命中（${pass.length} 项）`);
    app.exit(0);
  } else {
    console.log(`\n价目明细内联展开守卫失败 ${fail.length} 项（通过 ${pass.length} 项）`);
    app.exit(1);
  }
});
