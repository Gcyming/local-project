/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * A-1156 守卫：浮层态右栏**内容列必须真的随右栏长大**（用户：「右侧边栏内容**一直是只有一段**」）。
 *
 * ## 为什么单独一个 spec（而不是并进 A-1152 那份）
 * A-1152 那份守的是"限宽 + 居中"这个**意图**；A-1156 把限宽的上限从 620px 抬到 1600px，
 * 两者已经**不是同一个断言**（`min(620px, 62%)` vs `min(1600px, 100%)`）。
 * 把两条历史断言塞进一份文件，早晚有一份会为了"让另一份变绿"而放松自己。
 *
 * ## 判据（全部静态可判，不依赖运行时）
 * ① CSS 侧：浮层态 `.right-body` 的 `max-width` 必须是「铺满 + 高上限」形态；
 * ② JS 侧：过渡期 `--right-body-pin` 必须用**同一个常量**算（常量与 CSS 字面量相等）；
 * ③ JS 侧：浮层支的 pin 目标宽**不得**再过 `rightSidebarMaxW()`
 *    （那一刻 `floatStateRef` 还是 "none"，该函数返回的是**非浮层**上限）。
 *
 * 真机证据（`gui/scripts/probe-a1155-cdp.mjs`，截图 `gui/out/_r7-shots-before/s1-float-settled.png`）：
 *   修前 fillRatio = 620/1092 = 0.568，右栏本体铺满而内容只占 57%，两侧各空 236px。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}
/** ⚠️ 解析前必须先剥注释：源码里的注释含 `min(620px, 62%)` 这类**字面量示例**，
 *  不剥就会被下面的正则当成真声明（上一轮就因此把注释里的值当成了实际取值）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const APP_CODE = stripComments(read("gui/src/renderer/App.tsx"));
const CSS_CODE = stripComments(read("gui/src/renderer/index.css"));

/** 取浮层态内容列那条规则的选择器与声明体 */
const RIGHT_BODY_RULE =
  /body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body\s*\{([^}]*)\}/.exec(CSS_CODE);

describe("A-1156-① CSS：内容列随右栏铺满，只留一个高上限", () => {
  it("取到那条规则", () => {
    expect(RIGHT_BODY_RULE, "找不到 body.float-layout … .right-body 规则").toBeTruthy();
  });

  it("`max-width` 是 `min(<上限>px, 100%)` —— 第二项必须是 100%（= 铺满）", () => {
    /* ⚠️ 修前是 `var(--right-content-max, min(620px, 62%))`：620px 封顶 ⇒
       1092px 的右栏里只有 57% 是内容（用户：「一直是只有一段」）。
       ⇒ 判据不是"有个上限"，而是**上限之下按 100% 铺满**。 */
    const decl = /max-width:\s*([^;]+)/.exec(RIGHT_BODY_RULE![1])?.[1] ?? "";
    expect(decl).toMatch(/^min\(\s*\d+px\s*,\s*100%\s*\)$/);
  });

  it("上限 ≥ 1200px（否则大窗口上又退回「只有一段」）", () => {
    /* 1200 是**下限**：1332px 窗口实测右栏 1092px，上限低于它就等于没改。
       不锚死具体值（1600 是观感值，可再调）。 */
    const px = Number(/max-width:\s*min\(\s*(\d+)px/.exec(RIGHT_BODY_RULE![1])?.[1]);
    expect(Number.isFinite(px)).toBe(true);
    expect(px).toBeGreaterThanOrEqual(1200);
  });

  it("上限**不超过整窗宽的量级**（不许退化成纯 100%：超宽屏一行到底）", () => {
    const px = Number(/max-width:\s*min\(\s*(\d+)px/.exec(RIGHT_BODY_RULE![1])?.[1]);
    expect(px).toBeLessThanOrEqual(2560);
  });

  it("`var(--right-content-max)` 钩子已移除（全仓无写入方 = 第二个真相源）", () => {
    expect(CSS_CODE).not.toMatch(/--right-content-max/);
  });

  it("限宽与居中仍在（`width:100%` + `margin-inline:auto`）", () => {
    /* ⚠️ 居中是为了「超宽屏留边时左右对称」；去掉 auto 会让内容贴左、右侧留一片
       —— 那正是用户反复报的"空白"。 */
    expect(RIGHT_BODY_RULE![1]).toMatch(/width:\s*100%/);
    expect(RIGHT_BODY_RULE![1]).toMatch(/margin-inline:\s*auto/);
  });

  it("限宽只挂在浮层态选择器上（裸 `.right-body` 不带 max-width）", () => {
    expect(/(^|\n)\s*\.right-body\s*\{[^}]*max-width/.test(CSS_CODE)).toBe(false);
  });

  it("浏览器页（webview）仍然豁免限宽", () => {
    expect(CSS_CODE).toMatch(/body\.float-layout\s+\.right-sidebar:not\(:has\(webview\)\)\s+\.right-body/);
  });
});

describe("A-1156-② JS：过渡期 `--right-body-pin` 与稳态规则同式", () => {
  it("有 `RIGHT_CONTENT_MAX_W` 常量", () => {
    const m = /const\s+RIGHT_CONTENT_MAX_W\s*=\s*(\d+)/.exec(APP_CODE);
    expect(m, "找不到 RIGHT_CONTENT_MAX_W 常量").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1200);
  });

  it("常量值 === CSS 里的上限（**同一处事实**，否则过渡结束会突跳）", () => {
    /* ⚠️ 这是本 spec 的核心：pin 是过渡期的值、`max-width` 是稳态的值，
       两处公式若不同源，过渡结束的**那一帧**内容宽度会从 pin 跳到稳态值（用户可见的一跳）。 */
    const js = Number(/const\s+RIGHT_CONTENT_MAX_W\s*=\s*(\d+)/.exec(APP_CODE)?.[1]);
    const css = Number(/max-width:\s*min\(\s*(\d+)px/.exec(RIGHT_BODY_RULE![1])?.[1]);
    expect(js).toBe(css);
  });

  it("pin 的算法是 `Math.min(RIGHT_CONTENT_MAX_W, targetW)`（旧式 `× 0.62` 已作废）", () => {
    expect(APP_CODE).toMatch(/setProperty\("--right-body-pin"/);
    const at = APP_CODE.indexOf('setProperty("--right-body-pin"');
    const seg = APP_CODE.slice(Math.max(0, at - 400), at + 120);
    expect(seg).toMatch(/Math\.min\(RIGHT_CONTENT_MAX_W\s*,\s*targetW\)/);
    expect(seg).not.toMatch(/targetW\s*\*\s*0\.62/);
  });

  it("浮层支的 pin 目标宽**不再**过 `rightSidebarMaxW()`", () => {
    /* ⚠️ 根因（铁律 11）：`handleToggleFloat` 先调 `animateRightSidebar`、
       后 `setFloatState("float")` ⇒ 调用那一刻 `floatStateRef.current` 还是 "none"
       ⇒ `rightSidebarMaxW()` 返回**非浮层**上限（实测把 1092 夹回 712）。
       ⇒ 浮层支必须直接用 `nextWidth`。 */
    const at = APP_CODE.indexOf('setProperty("--right-body-pin"');
    const seg = APP_CODE.slice(Math.max(0, at - 500), at + 120);
    expect(seg).toMatch(/const\s+targetW\s*=\s*isFloatExpand\s*\?/);
    const floatBranch = seg.slice(seg.indexOf("isFloatExpand"));
    const clamp = floatBranch.indexOf("rightSidebarMaxW()");
    /* 右值里出现 clamp 只能出现在非浮层那一支（`? :` 之后） */
    const ternary = floatBranch.indexOf(":");
    expect(ternary).toBeGreaterThan(-1);
    expect(clamp === -1 || clamp > ternary).toBe(true);
  });

  it("pin 仍然成对摘除（起点写 / done 摘）", () => {
    expect(APP_CODE).toMatch(/setProperty\("--right-body-pin"/);
    expect(APP_CODE).toMatch(/removeProperty\("--right-body-pin"\)/);
  });
});

describe("A-1156-③ `--left-w` 必须**自愈**（用户现象④：右栏被挤压到屏幕外）", () => {
  it("必须有 `ResizeObserver` 观察左栏（动画逐帧同步被证明不够）", () => {
    /* ⚠️ 真机轨迹（`probe-a1155-cdp.mjs`）：点「展开左栏」后前 524ms 左栏实测都是 1px
       （React 未提交 `.collapsed` 摘除），659ms 才真的跳到 240px；
       逐帧同步在 1px 上就判"稳定"收工 ⇒ `--left-w` 永久停在 1px
       ⇒ 浮层稳态 wrapper = `calc(100% - 1px)` ⇒ `rw.r=1571 > vw=1332`（越窗 239px）。
       ⇒ 判据是"有没有一个**由宽度变化驱动**的同步点"，不是"有没有写 `--left-w`"。 */
    expect(APP_CODE).toMatch(/new ResizeObserver\(/);
  });

  it("喂给 RO 的那个回调**就是**写 `--left-w` 的那个函数（不是另一个同形函数）", () => {
    /* ⚠️ 只断言"文件里有 setProperty('--left-w')"是弱判据：它有三个主动写点，
       删掉 RO 照样绿 —— 而那正是本条要防的回归。 */
    expect(APP_CODE).toMatch(/const sync = \(\): void => \{[\s\S]{0,400}?setProperty\("--left-w"/);
    expect(APP_CODE).toMatch(/new ResizeObserver\(sync\)/);
    expect(APP_CODE).toMatch(/ro\.observe\(el\)/);
  });

  it("该回调只在浮层态写，且判据用真状态 `floatStateRef`（铁律 11）", () => {
    expect(APP_CODE).toMatch(
      /const sync = \(\): void => \{\s*if \(floatStateRef\.current === "none"\) \{ return; \}/,
    );
  });

  it("⚠️ 观察器必须挂在**回调 ref** 上，不能是 `useEffect(..., [])`（实测踩过的坑）", () => {
    /* ⚠️⚠️ App 首帧可能还停在**启动门**里（`splashVisible` 门，`.sidebar` 尚未挂载）
       ⇒ 空依赖 effect 跑的时候 `leftSidebarRef.current === null` ⇒ 直接 return
       ⇒ **观察器永远装不上**（第一版就是这么写的，实测 `--left-w` 仍停在 1px、越窗照旧）。
       ⇒ 判据：`.sidebar` 上必须是 `attachLeftWidthObserver`，且它内部自己 observe。 */
    expect(APP_CODE).toMatch(/ref=\{attachLeftWidthObserver\}/);
    expect(APP_CODE).toMatch(/const attachLeftWidthObserver = React\.useCallback\(/);
    expect(APP_CODE).not.toMatch(/React\.useEffect\(\(\) => \{\s*const el = leftSidebarRef\.current/);
    /* 回调 ref 仍必须把节点交给 leftSidebarRef（拖拽 / 动画实测都靠它） */
    expect(APP_CODE).toMatch(/leftSidebarRef\.current = el;/);
  });

  it("回调 ref 的身份必须稳定（`useCallback([])`），且重挂前先 disconnect", () => {
    /* ⚠️ 身份每次渲染都变 ⇒ React 每次渲染 detach+attach ⇒ 正在进行的同步被打断。 */
    const at = APP_CODE.indexOf("const attachLeftWidthObserver = React.useCallback(");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/\}, \[\]\);/);
    expect(seg).toMatch(/leftWidthObserverRef\.current\?\.disconnect\(\)/);
  });

  it("RO 必须挂在**左栏**这个被观察对象上（挂错元素 = 看着有、实际不同步）", () => {
    const at = APP_CODE.indexOf("const attachLeftWidthObserver = React.useCallback(");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/ro\.observe\(el\)/);
  });

  it("观察器必须在重挂前 `disconnect`（节点换了不 disconnect ⇒ 旧观察者泄漏）", () => {
    const at = APP_CODE.indexOf("const attachLeftWidthObserver = React.useCallback(");
    expect(at).toBeGreaterThan(-1);
    const seg = APP_CODE.slice(at, at + 1600);
    expect(seg).toMatch(/leftWidthObserverRef\.current\?\.disconnect\(\)/);
    expect(seg).toMatch(/ro\.disconnect\(\)|ro\.observe\(el\)/);
  });
});

describe("A-1156-④ 探针：必须量得到「内容列 / 右栏」这条比例与越窗", () => {
  it("`probe-a1155-cdp.mjs` 报 `fillRatio`（用户体感的判据 = 内容占右栏多少）", () => {
    /* ⚠️ 只量 `.right-sidebar` 宽度是不够的：A-1152 之后右栏本体早就铺满了，
       用户看到的「只有一段」发生在**内层内容列**。这条比例是本轮唯一的直接判据。 */
    const src = read("gui/scripts/probe-a1155-cdp.mjs");
    expect(src).toMatch(/fillRatio/);
  });

  it("探针的截图能力是可选开关（不默认落盘，避免污染工作树）", () => {
    const src = read("gui/scripts/probe-a1155-cdp.mjs");
    expect(src).toMatch(/SLIME_A1155_SHOTS/);
  });

  it("解析器自检：stripComments 真能剥掉注释里的字面量示例", () => {
    /* ⚠️ 没有这条自检，将来注释里再写一个 `min(999px, 100%)` 就会把守卫测绿。 */
    expect(stripComments("/* max-width: min(999px, 100%) */ .a { width: 1px; }")).not.toMatch(/999px/);
  });
});