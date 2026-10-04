

























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

  











  it("进入窗口化时**`.main`** 也要藏一帧（A-1180：藏 `host` 盖不住它）", () => {
    








    const m = /function\s+handleToggleFloat\b[\s\S]*?\n  \}/.exec(APP_CODE);
    expect(m, "取不到 `handleToggleFloat` 函数体").toBeTruthy();
    const body = m![0];
    const hidden = (body.match(/style\.visibility\s*=\s*"hidden"/g) || []).length;
    expect(hidden, `进入窗口化只藏了 ${hidden} 处（应有 2：host + .main）⇒ .main 塌陷那一帧仍可见（A-1180）`)
      .toBeGreaterThanOrEqual(2);
    const clear = (body.match(/style\.visibility\s*=\s*""/g) || []).length;
    expect(clear, `恢复 visibility 只有 ${clear} 处（应有 2）⇒ 可能持久隐形`)
      .toBeGreaterThanOrEqual(2);
    
    const to = /window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,400}?chatHostRef[\s\S]{0,400}?\.main[\s\S]{0,200}?\}, 32\)/.exec(body);
    expect(to, "`.main` 的恢复不在同一个 32ms 的 setTimeout 里 ⇒ 会比 host 晚一帧出现（又是新的抖动）")
      .toBeTruthy();
  });
});

describe("A-1175 `--right-target-w` 的摘除必须在「提交之后」的 effect 里（否则夹一个 IACVT 帧 = 一帧 661px 抖动）", () => {
  








  it("`animateRightSidebar` 里这两个变量只剩「入口 + 起点」两处清理（done 里不再摘）", () => {
    





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
    

    const m = /React\.useEffect\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[rightMin0\]\);/.exec(APP_CODE);
    expect(m, "找不到依赖 `[rightMin0]` 的 effect ⇒ 摘除点又跑到同步路径上了").toBeTruthy();
    const body = m![0];
    expect(body, "effect 里没摘 `--right-target-w`").toMatch(/removeProperty\("--right-target-w"\)/);
    expect(body, "effect 里没摘 `--right-body-pin`").toMatch(/removeProperty\("--right-body-pin"\)/);
    expect(body, "effect 必须**只在 `rightMin0` 为假时**摘（为真说明过渡还在跑，变量还要用）")
      .toMatch(/if\s*\(\s*rightMin0\s*\)\s*\{\s*return\s*;/);
  });
});
