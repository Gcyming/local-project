/**
 * tests/core-ts/a1173-anim-duration-sync.spec.ts —— 动画「两半同拍」与切换帧可见性（A-1173）。
 *
 * ## 用户报的两个现象
 * ① 「聊天界面窗口化以及窗口化退出时，右侧边栏的自动调整期间总是会发生抽搐、闪动」；
 * ② 「左侧边栏的收起时的衔接动画似乎有点问题，怎么是先渐出消失再重新在最后几帧闪出文本？」
 *
 * ## 共同的根因：**透明度/收工判定**比**几何**先到
 * `runGeometrySyncFade` 是**时间驱动**的（`u = 已过时长 / duration`，收工判据只有 `u >= 1`）。
 * 它的 `duration` 一旦**小于**那条 CSS `transition` 的时长，就会：
 *   · 透明度提前收工，而宽度还在滑 ⇒ 收工那帧 `opacity` 复位 ⇒ 文本重新可见（现象 ②）
 *   · `floatAnim` 提前回 `idle` ⇒ 宿主提前从浮窗切成内联（几何还差 36px 未收完）⇒ 一帧跳变（现象 ①）
 *
 * 真机实测（`probe-a1173-leftfade.mjs` / `probe-a1173-float-jerk.mjs`）：
 * | 路径 | 旧 `duration` | 对应 CSS | 后果 |
 * |---|---|---|---|
 * | 左栏 `.sidebar` | `GEOM_FADE_MS`=280 | `transition: width 0.5s`=500 | `226ms 宽=51 opacity 回升到 0.545`；`344ms 宽=16 opacity=1` |
 * | 悬浮窗 `.float-window` | 同上 280 | `FLOAT_TRANSITION_MS`=400 | `288ms` 时浮窗**还有 36px 宽**就被切成内联（`567+36` → `240+661`） |
 *
 * ## 判据风格
 * · **不手抄期望值**：一律从**两份文本**分别取值再比对（JS 常量 ↔ CSS 声明）——
 *   手抄的那份迟早两边都漂，而"比较"会一直通过（A-1162 的同一条教训）。
 * · **剥注释**后做形状断言。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));
const RAW_APP = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");
/* ⚠️⚠️⚠️ **必须剥注释**（铁律 10：形状断言先剥注释）。
   本文件（和 index.css）的注释里**大量引用被删掉的旧写法** —— 例如
   `margin-left: auto` 这几个字在注释里出现 4 次以上 ⇒ 不剥的话
   "有没有这条声明"这类断言**恒为真**（第一版就是这样：变异 M9 删掉真声明后断言照样绿）。
   实测：`--apply 9` 后 `bodies.some((b) => /margin-left:\s*auto/.test(b))` 仍为 true ——
   命中的全是注释里的那几个字。 */
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));

/** 从 CSS 里取某个选择器规则的规则体（行尾无关：`\s` 吃掉 `\n` 与 `\r\n`）。 */
function ruleBody(css: string, selectorRe: RegExp): string | null {
  const m = selectorRe.exec(css);
  return m ? m[1] : null;
}
/** `0.5s` / `500ms` / `0.28s` → 毫秒数。 */
function toMs(v: string): number {
  return v.endsWith("ms") ? Number(v.slice(0, -2)) : Number(v.replace("s", "")) * 1000;
}

describe("A-1173 ① 时长单源：JS 常量 ≡ CSS `transition` 时长（不手抄、两处取值再比对）", () => {
  it("`SIDEBAR_WIDTH_MS` ≡ `.sidebar` 的 `transition: width` 时长", () => {
    const js = /const\s+SIDEBAR_WIDTH_MS\s*=\s*(\d+)\s*;/.exec(APP_CODE);
    expect(js, "找不到 `SIDEBAR_WIDTH_MS`（守卫自己失效了）").toBeTruthy();
    const body = ruleBody(CSS_CODE, /(?:^|\n)\.sidebar\s*\{([^}]*)\}/);
    expect(body, "找不到顶层 `.sidebar { … }` 规则").toBeTruthy();
    const m = /transition:\s*width\s+([0-9.]+m?s)\s/.exec(body!);
    expect(m, "`.sidebar` 没有 `transition: width <时长>`").toBeTruthy();
    expect(Number(js![1]), `SIDEBAR_WIDTH_MS=${js![1]} 与 CSS 的 ${m![1]} 不等 ⇒ 透明度会提前收工，文本在最后几帧闪出`)
      .toBe(toMs(m![1]));
  });

  it("`FLOAT_TRANSITION_MS` ≡ `FLOAT_TRANSITION` 字符串里的时长（**同源拼接**，不是各写一份）", () => {
    const js = /const\s+FLOAT_TRANSITION_MS\s*=\s*(\d+)\s*;/.exec(APP_CODE);
    expect(js, "找不到 `FLOAT_TRANSITION_MS`").toBeTruthy();
    /* ⚠️ 判据是"**由常量拼接**"：直接在模板串里出现 `${FLOAT_TRANSITION_MS}ms`。
       若有人把它改回手抄的 `0.4s`，这条立刻红 —— 那正是两个产地开始漂的起点。 */
    expect(APP_CODE, "`FLOAT_TRANSITION` 不再由 `FLOAT_TRANSITION_MS` 拼接 ⇒ 时长出现第二产地")
      .toMatch(/const\s+FLOAT_TRANSITION\s*=\s*`[^`]*\$\{FLOAT_TRANSITION_MS\}ms/);
    expect(APP_CODE, "`FLOAT_TRANSITION_FULL` 不再由常量拼接")
      .toMatch(/const\s+FLOAT_TRANSITION_FULL\s*=\s*`[^`]*\$\{FLOAT_TRANSITION_MS\}ms/);
  });
});

describe("A-1173 ② 两条动画路径都必须显式传 `duration`（落回默认 ⇒ 比 CSS 短 ⇒ 半拍错位）", () => {
  it("左栏 `animateLeftSidebar` 传 `duration: SIDEBAR_WIDTH_MS`", () => {
    expect(APP_CODE, "左栏动画没传 duration ⇒ 落回 GEOM_FADE_MS（280）而 CSS 是 500 ⇒ 文本闪出")
      .toMatch(/loRatio:\s*LEFT_FADE_LO,\s*hiRatio:\s*LEFT_FADE_HI,\s*duration:\s*SIDEBAR_WIDTH_MS/);
  });

  it("悬浮窗 `startFloatGeometryFade` 传 `duration: FLOAT_TRANSITION_MS`", () => {
    expect(APP_CODE, "悬浮窗动画没传 duration ⇒ 收工时几何还差一截就被切成内联 ⇒ 抽搐闪动")
      .toMatch(/min:\s*minW,\s*full:\s*floatSizeRef\.current\.w,\s*duration:\s*FLOAT_TRANSITION_MS/);
  });
});

describe("A-1173 ③ 左栏不透明度必须**按方向取反**（收起是渐出，不是渐入）", () => {
  /* ⚠️ 根因：`runGeometrySyncFade` 是「渐**入**」引擎 —— 虚拟宽度 `w = min + span×u` 从 0 涨到 full
     ⇒ `p` 从 0 涨到 1。而**收起**时左栏实际宽度是 `240 → 0`，方向恰好相反。
     直接拿 `p` 当 opacity 就是把渐出跑成了渐入：第一帧 `w=0 ⇒ p=0`（瞬间全透明），
     随后 `p` 涨回 1 ⇒ **文本重新可见**（用户报的「先渐出消失再闪出文本」）。 */
  it("onFrame 里按 `nextOpen` 取反：展开用 `p`、收起用 `1 - p`", () => {
    const m = /function\s+animateLeftSidebar\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `animateLeftSidebar` 函数体").toBeTruthy();
    const body = m![0];
    expect(body, "左栏 onFrame 没有按方向取反 ⇒ 收起会被跑成渐入（文本闪出）")
      .toMatch(/nextOpen\s*\?\s*p\s*:\s*1\s*-\s*p/);
    expect(body, "收起收工时没把 opacity 钉成 0 ⇒ 最后几 px 宽度里文本仍会露出来")
      .toMatch(/if\s*\(nextOpen\)\s*\{\s*node\.style\.removeProperty\("opacity"\);\s*\}\s*else\s*\{\s*node\.style\.opacity\s*=\s*"0";\s*\}/);
  });
});

describe("A-1173 ④ 切换呈现模式那一帧，宿主必须**已经不可见**", () => {
  it("`dismissFloat` 在 `setFloatState(\"none\")` **之前**同步把宿主 opacity 压到 0", () => {
    /* ⚠️ 唯一会把宿主 opacity 置 0 的地方是 `startInlineChatRevealFade`，
       而它挂在**两帧 rAF 之后**（避开 React commit 边界）⇒ 切换那一帧宿主仍完全不透明
       ⇒ 几何从「浮窗收拢后的 0×0」一步跳到「内联完整尺寸」（实测 +661px）= 可见的闪。
       ⇒ 必须在切换之前同步压 0。 */
    const m = /function\s+dismissFloat\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `dismissFloat` 函数体").toBeTruthy();
    const body = m![0];
    const atOpacity = body.indexOf('hostExit.style.opacity = "0"');
    const atState = body.indexOf('setFloatState("none")');
    expect(atOpacity, "`dismissFloat` 没有在切换前压宿主 opacity ⇒ 切换帧会露出 661px 的跳变").toBeGreaterThan(-1);
    expect(atState, "找不到 `setFloatState(\"none\")`").toBeGreaterThan(-1);
    expect(atOpacity, "压 opacity 必须**在** `setFloatState(\"none\")` 之前（同帧、DOM 立即生效）")
      .toBeLessThan(atState);
  });

  it("唯一宿主的**类**与**盒模**同源：都用 `hostIsFloat`（不用业务状态）", () => {
    /* ⚠️ 两半判据不同源 ⇒ 只要有一帧不同步，就会出现"类还是浮窗、盒模已是内联"（或反之）。 */
    expect(APP_CODE, "宿主的 className 又用回业务状态 `mainIsFloatLayout` ⇒ 与同元素的 style 判据不同源")
      .toMatch(/className=\{hostIsFloat \? "float-window" : "inline-chat-host"\}/);
    expect(RAW_APP, "宿主 style 也必须用 `hostIsFloat`").toMatch(/style=\{hostIsFloat \? floatBoxStyle : inlineChatHostStyle\}/);
  });
});

describe("A-1173 ⑤ 退浮层期间右栏必须**贴住窗口右缘**（否则右侧露一条空白）", () => {
  it("`.right-sidebar` 有一条规则带 `margin-left: auto`（且不限定 `body.float-layout`）", () => {
    /* ⚠️ 退浮层那一帧 `float-layout` 已被摘、而 wrapper 还没缩到位
       ⇒ 若 auto 只在浮层态挂，右栏就退回"贴 wrapper 左缘" ⇒ 右侧露 135px
       （实测 408~450ms：`rw=901+431` 而 `rs=901+296`）。 */
    const bodies = [...CSS_CODE.matchAll(/\.right-sidebar\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(bodies.length, "CSS 里找不到任何 `.right-sidebar { … }` 规则").toBeGreaterThan(0);
    expect(
      bodies.some((b) => /margin-left:\s*auto/.test(b)),
      "没有一条 `.right-sidebar` 规则带 `margin-left: auto` ⇒ 退浮层时右侧会露出一条空白",
    ).toBe(true);
  });
});
