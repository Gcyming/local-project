import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");











describe("A-1171 呈现模式与业务状态解耦（退场收工前不切成内联）", () => {
  it("宿主的 style 走 `hostIsFloat`，**不再**直接用 `mainIsFloatLayout`", () => {
    expect(APP_CODE, "宿主呈现模式又直接绑回业务状态 ⇒ 退场时仍会可见地跳")
      .not.toMatch(/style=\{mainIsFloatLayout\s*\?\s*floatBoxStyle/);
    expect(APP_CODE, "宿主 style 没有走 hostIsFloat").toMatch(/style=\{hostIsFloat\s*\?\s*floatBoxStyle/);
  });

  it("`hostIsFloat` 必须**包含**进场态（否则进场会以内联尺寸闪一帧）", () => {
    

    expect(APP_CODE, "hostIsFloat 没包含进场态 ⇒ 进场时仍有一帧内联尺寸闪现")
      .toMatch(/hostIsFloat\s*=[^;]*floatAnim\s*===\s*"in"/);
  });

  it("`hostIsFloat` 覆盖 退场 / 最小化 / 进场 三种进行中状态", () => {
    const m = /const\s+hostIsFloat\s*=\s*([^;]+);/.exec(APP_CODE);
    expect(m, "找不到 hostIsFloat 定义").toBeTruthy();
    for (const k of ["mainIsFloatLayout", "floatClosing", "floatAnimOut"]) {
      expect(m![1], `hostIsFloat 少了 ${k} ⇒ 该状态下宿主会提前切成内联`).toMatch(new RegExp(k));
    }
  });

  it("切换发生的时刻浮窗必须是 0×0 且透明（否则解耦没有意义）", () => {
    


    expect(APP_CODE, "floatClosing 不再优先 ⇒ 推迟切换会换来一个可见的静止浮窗")
      .toMatch(/floatClosing\s*\?\s*0\s*:/);
  });
});