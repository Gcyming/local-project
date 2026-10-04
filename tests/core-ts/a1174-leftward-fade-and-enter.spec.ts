/**
 * tests/core-ts/a1174-leftward-fade-and-enter.spec.ts —— 左栏「收起仍要渐出」+ 进入窗口化的可见性（A-1174）。
 *
 * ## 这一轮修的是 A-1173 的**两个副作用**（用户实测反馈）
 * ① 「左侧边栏的折叠衔接动画你的解决方法太粗暴了，现在我左侧边栏折叠的渐出衔接动画直接没了」
 * ② 「窗口化恢复的时候一点闪烁、抽搐都没有了，但是**窗口化的那一下**右侧边栏还是会抽搐闪烁」
 *
 * ## ① 为什么 A-1173 把渐出"修没了"
 * A-1173 用 `1 - p` 把收起从"渐入"掰回"渐出"，但**继续沿用 `[LEFT_FADE_LO, LEFT_FADE_HI]`**。
 * 那组比例是**按面板实际宽度**定的（"95% 宽开始淡出、40% 宽全透明"），而 A-1162 之后
 * 喂进公式的 `w = full × u` 是**虚拟宽**（与时间**线性**）；实际宽度走的是
 * `cubic-bezier(0,0,0.2,1)`（**先快后慢**）⇒ 两者不同步：
 *   `u=0.40` ⇒ 虚拟宽 96，而实际宽只剩 **59px**（实测）。
 * ⇒ 「开始渐出」被推到实际宽度只剩几十 px 时，那一段内容早被 `overflow: hidden` 裁掉
 *   ⇒ **肉眼看不到任何渐出**。修法：收起改用按"实际宽度 100%→40%"反算出的虚拟宽窗口
 *   `[0, 0.27]`（推导见 `LEFT_FADE_COLLAPSE_*` 的注释）。
 *
 * ## ② 进入窗口化那一跳
 * 宿主切成 `.float-window` 时，框从「内联布局给的尺寸」变成「浮窗默认框」
 * （实测 `240+380` → `252+666`，**+286px**），同一帧 `rw` / `main` 也在跳，
 * 且**都可见** ⇒ 可见的抽搐。修法：切换那两帧把宿主 `visibility: hidden`。
 * ⚠️ **不能用 opacity 淡入**：`.float-window` 有一条刻意的 `opacity: 1`（A-1152/A-1160），
 *    注释写明"浮窗显式不透明，否则右栏内容会透上来叠印（A-1159 的失败）"。
 *
 * ⚠️ 判据风格：**剥注释**后形状断言；并**从两份文本取值比对**（不手抄期望值）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const RAW_APP = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");
const APP_CODE = strip(RAW_APP);
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));

const numConst = (name: string): number => {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*([0-9.]+)\\s*;").exec(APP_CODE);
  expect(m, `找不到常量 ${name}（守卫自己失效了）`).toBeTruthy();
  return Number(m![1]);
};

describe("A-1174 ① 左栏**收起**要用单独的可见性窗口（否则渐出落在「实际宽度只剩几十 px」处 = 看不见）", () => {
  it("`animateLeftSidebar` 的 opts **按方向分流**：展开用 LEFT_FADE_LO/HI、收起用 LEFT_FADE_COLLAPSE_LO/HI", () => {
    const m = /function\s+animateLeftSidebar\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `animateLeftSidebar` 函数体").toBeTruthy();
    const body = m![0];
    expect(body, "展开方向没传 LEFT_FADE_LO/HI（用户对展开是满意的，别动它）")
      .toMatch(/loRatio:\s*LEFT_FADE_LO,\s*hiRatio:\s*LEFT_FADE_HI/);
    expect(body, "收起方向没换用 LEFT_FADE_COLLAPSE_LO/HI ⇒ 渐出会被推迟到实际宽度只剩几十 px ⇒ 看不见渐出")
      .toMatch(/loRatio:\s*LEFT_FADE_COLLAPSE_LO,\s*hiRatio:\s*LEFT_FADE_COLLAPSE_HI/);
    expect(body, "两方向必须按 `nextOpen` 分流（不是写死一组）")
      .toMatch(/nextOpen\s*\n?\s*\?/);
  });

  it("收起窗口必须比展开窗口**更早**（`COLLAPSE_HI < LEFT_FADE_LO`）—— 这是「在宽度大时就淡出」的判据", () => {
    const hi = numConst("LEFT_FADE_COLLAPSE_HI");
    const lo = numConst("LEFT_FADE_LO");
    expect(hi, `LEFT_FADE_COLLAPSE_HI=${hi} 不小于 LEFT_FADE_LO=${lo} ⇒ 渐出又会被推到接近收尾（实际宽度已经很小）`)
      .toBeLessThan(lo);
    expect(numConst("LEFT_FADE_COLLAPSE_LO"), "收起窗口的下沿应为 0（从第一帧就开始淡）").toBe(0);
  });

  it("收起收工时 opacity 钉 `0`、展开收工复位 `\"\"`（A-1173 的不变量，再钉一次）", () => {
    const m = /function\s+animateLeftSidebar\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m![0], "收起收工没把 opacity 钉成 0 ⇒ 最后几 px 宽度里文本仍会露出来")
      .toMatch(/if\s*\(nextOpen\)\s*\{\s*node\.style\.removeProperty\("opacity"\);\s*\}\s*else\s*\{\s*node\.style\.opacity\s*=\s*"0";\s*\}/);
  });
});

describe("A-1174 ② 进入窗口化：切换那两帧宿主必须**不可见**（且不能用 opacity）", () => {
  it("`handleToggleFloat` 在 `setFloatState(\"float\")` **之前**设 `visibility = \"hidden\"`，之后再恢复", () => {
    const m = /function\s+handleToggleFloat\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `handleToggleFloat` 函数体").toBeTruthy();
    const body = m![0];
    const atVis = body.indexOf('style.visibility = "hidden"');
    const atState = body.indexOf('setFloatState("float")');
    expect(atVis, "切换前没把宿主藏起来 ⇒ 切换帧会露出 +286px 的几何跳变（用户报的「窗口化那一下抽搐」）").toBeGreaterThan(-1);
    expect(atState, "找不到 `setFloatState(\"float\")`").toBeGreaterThan(-1);
    expect(atVis, "藏必须**在** `setFloatState` 之前（同帧、DOM 立即生效）").toBeLessThan(atState);
    expect(body, "没有把 visibility 还回去 ⇒ 宿主持久隐藏（聊天区整个不见）")
      .toMatch(/style\.visibility\s*===\s*"hidden"[\s\S]{0,80}style\.visibility\s*=\s*""/);
  });

  it("宿主**不许**用 `opacity`/`animation` 做进入效果（`.float-window` 必须显式不透明）", () => {
    /* ⚠️ A-1159 的失败：给浮窗加 opacity 过渡 ⇒ 半透明期间右栏内容透上来叠印。
       `.float-window { opacity: 1 }` 那条硬规定就是为它写的（A-1152/A-1160）。
       ⇒ 进入效果只能用 `visibility`，不能用透明度。 */
    const body = (() => {
      const m = /const floatBoxStyle[\s\S]*?\n  \};/.exec(APP_CODE);
      expect(m, "找不到 `floatBoxStyle`").toBeTruthy();
      return m![0];
    })();
    expect(body, "`floatBoxStyle` 里出现了 opacity ⇒ 半透明期间右栏内容会透上来叠印（A-1159 的失败）")
      .not.toMatch(/\bopacity\s*:/);
    expect(body, "`floatBoxStyle` 里出现了 animation ⇒ 同上（淡入 = 半透明）")
      .not.toMatch(/\banimation\s*:/);
    expect(CSS_CODE, "`.float-window` 的显式不透明被删了 ⇒ 浮窗可能透出下层")
      .toMatch(/\.float-window\s*\{[^}]*opacity:\s*1/);
  });

  /*⚠️⚠️ 这里曾有一条「进入窗口化时右栏也藏一帧」的断言（A-1178），**已撤除**。
     那条修复把`.right-wrapper` 藏起来，而内容（`.right-sidebar`）还在 0.5s 过渡途中
     ⇒ 32ms 后恢复可见时容器已铺满、内容只长到一半 ⇒ 中间露出约 400px 空白
     ⇒ 用户实测「右侧边栏直接屏闪了，每次窗口化会有一帧黑屏」。
     ⇒ 「藏起来」这个方向本身是错的：容器与内容的过渡节奏不同步时，藏容器只会把空白暴露出来。
     正解见 `a1179-float-enter-blank.spec.ts`：**让容器过渡期不给宽度（贴合内容）**，
     结构上消除空白带，而不是把它藏一下。
     ⚠️ 留这条注释是为了防止后人"再补一次藏右栏" —— 那是同一条弯路。

     ⚠️⚠️⚠️ 但「藏**`.main`**」是对的（A-1180），别把两者一起撤掉：
     `.main` 有**不透明背景** `var(--bg)`，它塌陷那一帧**用户看得见**（见下条断言）。 */

  it("进入窗口化时**`.main`** 也要藏一帧（A-1180：藏 `host` 盖不住它）", () => {
    /* ⚠️⚠️ A-1180根因（`probe-a1180-visible-hole.mjs` 双采样实测，进入窗口化）：
         `17ms  main Δwidth=-721  rb Δwidth=+721`
       那一帧 `main-float` 类刚挂上，而 `.main.main-float { width: 0 !important }`
       还没生效 ⇒ `.main` 的 721px 宽度**一帧内塌成 0、下一帧又回来**。
       ⚠️ **它是可见的**：`.main { background: var(--bg) }`（不透明）
       ⇒ A-1174 藏的那个 `host`（聊天区宿主）**盖不住它** ⇒ 用户看到「一帧抽搐」。
       ⚠️ A-1152 注释里写「浮层态下 `<main>` 不渲染（渲染 null）」—— **实测它仍在 DOM 里**
         （只是被 `width:0` 压掉）⇒ 那条注释的前提在当前代码里不成立，不能据此认为它无害。
       ⚠️ 判据用**次数**：与 `host` 一起藏 ⇒ `visibility="hidden"` 与恢复各 ≥ 2 处。 */
    const m = /function\s+handleToggleFloat\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `handleToggleFloat` 函数体").toBeTruthy();
    const body = m![0];
    const hidden = (body.match(/style\.visibility\s*=\s*"hidden"/g) || []).length;
    expect(hidden, `进入窗口化只藏了 ${hidden} 处（应有 2：host + .main）⇒ .main 塌陷那一帧仍可见（A-1180）`)
      .toBeGreaterThanOrEqual(2);
    const clear = (body.match(/style\.visibility\s*=\s*""/g) || []).length;
    expect(clear, `恢复 visibility 只有 ${clear} 处（应有 2）⇒ 可能持久隐形`)
      .toBeGreaterThanOrEqual(2);
    /* 必须与宿主**同拍**恢复（同一个 setTimeout 里），否则 .main 会比 host 晚一帧出现。 */
    const to = /window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,400}?chatHostRef[\s\S]{0,400}?\.main[\s\S]{0,200}?\}, 32\)/.exec(body);
    expect(to, "`.main` 的恢复不在同一个 32ms 的 setTimeout 里 ⇒ 会比 host 晚一帧出现（又是新的抖动）")
      .toBeTruthy();
  });
});

describe("A-1175 `--right-target-w` 的摘除必须在「提交之后」的 effect 里（否则夹一个 IACVT 帧 = 一帧 661px 抖动）", () => {
  /* ⚠️⚠️⚠️ 本轮最难找的一条。现象是「窗口化那一瞬有一帧异常抖动」，只有一帧。
     根因：`animateRightSidebar` 的 done 里**同步**摘 `--right-target-w`，
     而同一处还 `setRightMin0(false)`（React state、**异步提交**）⇒ 中间夹一个 IACVT 帧：
     `rw` 的内联宽度那一帧仍写 `var(--right-target-w)`，变量却已不存在
     ⇒ 回落 `auto`（内容宽 **431px**）⇒ `.right-sidebar` 的 `100%` 跟着变 431 ⇒ 一帧缩 661px 再弹回。
     真机实测（`probe-a1175-enter-jerk.mjs` 的 ResizeObserver + layout-shift）：
       `290ms rw 1092 → 431 (Δ-661)` / `297ms 431 → 1092` / `layout-shift value=0.3891`。
     ⚠️ `setTimeout(…, 32)` 治不了（实测提交在 done 之后约 35ms，照样 431）
       ⇒ 只能挂在 `[rightMin0]` 的 effect 里（effect 跑时 React 一定已提交）。 */
  it("`animateRightSidebar` 里这两个变量只剩「入口 + 起点」两处清理（done 里不再摘）", () => {
    /* ⚠️ 用**次数**而不是"切 done 块"：`if (done)` 块用正则切会跨边界（把入口/起点的清理
       也算进去 ⇒ 假红）。次数判据的语义是明确的：**合法的摘除只有两处** ——
         · 函数入口的"复位到干净起点"（A-1155）
         · 两条支各自的"过渡起点清理"（A-1153/A-1155）
       收工（done）那次已挪到 effect ⇒ 一旦有人在 done 里又加回来，次数变 3 ⇒ 立刻红。
       ⚠️ 重构若合并/拆分了这两处清理，请同步改这个数（并想清楚"done 里到底有没有摘"）。 */
    const m = /function\s+animateRightSidebar\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `animateRightSidebar` 函数体").toBeTruthy();
    const body = m![0];
    const nPin = (body.match(/removeProperty\("--right-body-pin"\)/g) || []).length;
    const nTgt = (body.match(/removeProperty\("--right-target-w"\)/g) || []).length;
    expect(nTgt, `\`--right-target-w\` 的摘除点有 ${nTgt} 处（应为 2：入口 + 起点）⇒ done 里很可能又同步摘了 ⇒ 会夹一个 IACVT 帧（一帧 661px 的抖动）`)
      .toBe(2);
    expect(nPin, `\`--right-body-pin\` 的摘除点有 ${nPin} 处（应为 2：入口 + 起点）⇒ 同上`).toBe(2);
  });

  it("改由 `React.useEffect(…, [rightMin0])` 在提交之后摘（且两个变量都要摘）", () => {
    /* 判据：存在一个依赖 `[rightMin0]` 的 effect，体内**同时**摘这两个变量。
       ⚠️ 不锚具体行号/顺序（那种断言会在重构时假红），只要求"这个 effect 存在且摘全"。 */
    const m = /React\.useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[rightMin0\]\);/.exec(APP_CODE);
    expect(m, "找不到依赖 `[rightMin0]` 的 effect ⇒ 摘除点又跑到同步路径上了").toBeTruthy();
    const body = m![0];
    expect(body, "effect 里没摘 `--right-target-w`").toMatch(/removeProperty\("--right-target-w"\)/);
    expect(body, "effect 里没摘 `--right-body-pin`").toMatch(/removeProperty\("--right-body-pin"\)/);
    expect(body, "effect 必须**只在 `rightMin0` 为假时**摘（为真说明过渡还在跑，变量还要用）")
      .toMatch(/if\s*\(\s*rightMin0\s*\)\s*\{\s*return\s*;/);
  });
});
