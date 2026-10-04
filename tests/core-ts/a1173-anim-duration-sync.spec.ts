























import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));
const RAW_APP = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");






const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));


function ruleBody(css: string, selectorRe: RegExp): string | null {
  const m = selectorRe.exec(css);
  return m ? m[1] : null;
}

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
    
    expect(APP_CODE, "宿主的 className 又用回业务状态 `mainIsFloatLayout` ⇒ 与同元素的 style 判据不同源")
      .toMatch(/className=\{hostIsFloat \? "float-window" : "inline-chat-host"\}/);
    expect(RAW_APP, "宿主 style 也必须用 `hostIsFloat`").toMatch(/style=\{hostIsFloat \? floatBoxStyle : inlineChatHostStyle\}/);
  });
});

describe("A-1173 ⑤ 退浮层期间右栏必须**贴住窗口右缘**（否则右侧露一条空白）", () => {
  it("`.right-sidebar` 有一条规则带 `margin-left: auto`（且不限定 `body.float-layout`）", () => {
    


    const bodies = [...CSS_CODE.matchAll(/\.right-sidebar\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(bodies.length, "CSS 里找不到任何 `.right-sidebar { … }` 规则").toBeGreaterThan(0);
    expect(
      bodies.some((b) => /margin-left:\s*auto/.test(b)),
      "没有一条 `.right-sidebar` 规则带 `margin-left: auto` ⇒ 退浮层时右侧会露出一条空白",
    ).toBe(true);
  });
});
