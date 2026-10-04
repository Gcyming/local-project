































import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));

describe("A-1188 淡入淡出引擎：必须有「首帧启动」调度（否则整条 rAF 链从未开始）", () => {
  it("`runGeometrySyncFade` 体内 `requestAnimationFrame(step)` 恰好 2 处：链内续播 + 首帧启动", () => {
    const m = /function\s+runGeometrySyncFade\b[\s\S]*?\n\}/.exec(APP_CODE);
    expect(m, "取不到 `runGeometrySyncFade` 函数体（守卫自己失效了）").toBeTruthy();
    const body = m![0];
    const n = (body.match(/window\.requestAnimationFrame\(step\)/g) || []).length;
    expect(n, `\`requestAnimationFrame(step)\` 只有 ${n} 处（应为 2：step 内的续播 + 函数体内的首帧启动）。`
      + "只剩 1 处 ⇒ 引擎**一帧都不会跑** ⇒ onFrame 永不执行（写进去的 opacity 没人改回来）、"
      + "done 永不触发（收尾清理静默失踪）= 用户现象「淡入淡出都没了 / 左栏展开后内容全透明」")
      .toBe(2);
  });

  it("启动那处必须在 `step` 函数体**之外**（紧邻 `return`，不是把递归当成启动）", () => {
    const m = /function\s+runGeometrySyncFade\b[\s\S]*?\n\}/.exec(APP_CODE);
    const body = m![0];
    

    expect(body, "`raf = window.requestAnimationFrame(step);` 不在 `return` 之前 ⇒ "
      + "首帧调度缺失（或被挪进了 `step` 里当自递归）⇒ 引擎永远停在「未启动」状态")
      .toMatch(/raf\s*=\s*window\.requestAnimationFrame\(step\);\s*\n\s*return\s*\(\)\s*=>/);
  });

  it("取消句柄仍只「停表」（不许在 cancel 里补跑 `onFrame`）", () => {
    



    const m = /function\s+runGeometrySyncFade\b[\s\S]*?\n\}/.exec(APP_CODE);
    const body = m![0];
    const ret = body.slice(body.indexOf("return () => {"));
    


    expect(ret, "cancel 回调里出现了 `onFrame` ⇒ 会立即写 done 值（A-1186 的回归）")
      .not.toMatch(/\bonFrame\b/);
    expect(ret, "cancel 回调里必须真的取消 rAF（否则那一帧仍会跑一次 onFrame）")
      .toMatch(/window\.cancelAnimationFrame\(raf\)/);
  });
});
