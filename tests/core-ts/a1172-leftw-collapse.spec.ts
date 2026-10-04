

































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));

const count = (src: string, needle: string): number => {
  let n = 0;
  let i = 0;
  for (;;) {
    const k = src.indexOf(needle, i);
    if (k < 0) { return n; }
    n++;
    i = k + needle.length;
  }
};


const WRITE_TARGET_SLOT =
  /setProperty\("--left-w",\s*`\$\{Math\.round\(sidebarOpenRef\.current\s*\?\s*sidebarWidthRef\.current\s*:\s*0\)\}px`\)/g;

const WRITE_BARE_STATE =
  /setProperty\("--left-w",\s*`\$\{Math\.round\(sidebarWidthRef\.current\)/;

const WRITE_MEASURED =
  /setProperty\("--left-w",\s*`\$\{Math\.round\([a-zA-Z]+\.getBoundingClientRect\(\)\.width\)/;

describe("A-1172 浮层态「折叠左栏」不许留白：`--left-w` 必须是**目标占位宽**", () => {
  it("`--left-w` 的写点仍在（唤出 / 窗口 resize / RO / 左栏动画 四条路径）", () => {
    const n = count(APP_CODE, 'setProperty("--left-w"');
    expect(n >= 4, `写点只剩 ${n} 处 —— 少了产地就会让某条路径的浮层宽度算错（铁律 11）`).toBe(true);
  });

  it("至少两处（RO `sync` + 左栏动画 onFrame）写的是「目标占位宽」`sidebarOpenRef.current ? sidebarWidthRef.current : 0`", () => {
    const n = (APP_CODE.match(WRITE_TARGET_SLOT) || []).length;
    expect(n >= 2,
      `只有 ${n} 处写「目标占位宽」⇒ 少的那处必然写成了别的形态：`
      + `写裸展开宽 ⇒ 折叠后左侧留 240px 空白；写实测宽 ⇒ 逐帧闭环（A-1166 的六处反转）`).toBe(true);
  });

  it("**不许**写裸「展开宽常量 `sidebarWidthRef.current`」（A-1172 要治的形态）", () => {
    

    expect(APP_CODE, [
      "`--left-w` 又被写成裸 `sidebarWidthRef.current` 了（没有按折叠归零）。",
      "那会让折叠左栏后变量停在「展开宽」：",
      "  · 折叠时左栏实宽 0，而该 state **不随折叠变化**（`animateLeftSidebar` 只翻 `sidebarOpen`）",
      "  · ⇒ 浮层 wrapper 宽 = `calc(100% − 展开宽)` = 1092，而它左缘按 flex 顺序应为 0",
      "  · ⇒ 折叠后左侧空出那一整条（实测 240px），被 wrapper 的 `marginLeft: \"auto\"` 吃掉",
      "它唯一「看起来对」的场合是「左栏展开」——恰好是多数人只测的那一种。",
      "⇒ 正确写法是目标占位宽：`sidebarOpenRef.current ? sidebarWidthRef.current : 0`。",
    ].join("\n")).not.toMatch(WRITE_BARE_STATE);
  });

  it("**不许**写**本帧实测宽**（A-1166 的闭环形态 —— 那条不变量也在这里再钉一次）", () => {
    expect(APP_CODE, [
      "`--left-w` 又在写本帧实测宽（`X.getBoundingClientRect().width`）了。",
      "`.sidebar` 常驻 `transition: 0.5s` ⇒ 逐帧把动画中间值写回",
      "⇒ 与 ResizeObserver 构成「观测 → 写回 → 再观测」⇒ 六处方向反转（用户实测的「抽搐」）。",
      "详见 `a1166-left-w-feedback.spec.ts`；本条只是**同一条不变量的第二个钉子**",
      "（它现在有两处产地 —— RO `sync` 与左栏动画 onFrame，必须**成对**保持同源）。",
    ].join("\n")).not.toMatch(WRITE_MEASURED);
  });

  it("消费端仍是浮层稳态宽度 `calc(100% - var(--left-w, 0px))`（语义未被换掉）", () => {
    expect(APP_CODE).toMatch(/width:\s*\(?\s*mainIsFloatLayout\s*&&\s*!rightMin0\s*\)?\s*\?\s*"calc\(100% - var\(--left-w,\s*0px\)\)"/);
  });
});
