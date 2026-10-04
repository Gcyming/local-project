/**
 * tests/core-ts/a1188-fade-engine-starts.spec.ts —— **淡入淡出引擎必须真的开始跑**（A-1188）。
 *
 * ## 为什么需要这条（这是本轮最贵的一课）
 * 现象：用户报「侧边栏淡入淡出效果都没了」+「左侧边栏展开甚至都异常了」。
 * 真机 CDP 逐帧取证（`probe-a1187-sidebar-fade.mjs`，修复前）：
 * ```
 * ① 收起左栏 : 内联 opacity 全程 "-"（引擎一次都没写）· 计算 opacity 恒 1  ⇒ 无淡出
 * ② 展开左栏 : 内联 opacity 恒 "0"，512ms 后仍是 0   ⇒ **左栏展开后内容全透明、看不见**
 * ③ 收起右栏 : opacity 恒 1（当时右栏刻意不淡 —— A-1164；⚠️ **该结论已被 A-1189 取代**：
 *              右栏已恢复与左栏同语言的淡入淡出，见 `a1189-rightbar-fade.spec.ts`）
 * ④ 展开右栏 : 496ms 后仍挂着 `right-wrapper-anim`（done 从未触发 ⇒ 收尾清理没跑）
 * ```
 * 根因：`runGeometrySyncFade` 里**只剩"链内续播"，没有"首帧启动"** ——
 * `const step = () => { …; raf = requestAnimationFrame(step); };` 之后**直接 `return`**，
 * 少了函数体外那行 `raf = window.requestAnimationFrame(step);`。
 * ⇒ 引擎一帧都不跑 ⇒ `onFrame` 永不执行、`done` 永不触发。
 *
 * ## 为什么既有守卫全绿还漏了它（铁律 5）
 * `a1173`（时长单源）/ `a1174`（窗口按方向分流、`--right-target-w` 摘除点计数）/
 * `a1175` 全是**形状**断言：常量对不对、窗口常量有没有被传、done 里有没有摘变量。
 * 它们问的是「**算式对不对**」，没有一条问「**这个算式会不会被求值**」。
 * ⇒ 删掉唯一那行启动调用后，源码仍然"语法合法 + 常量正确 + 结构完备"，
 *   全部断言照样通过 —— 典型的**静默失效**（守卫的盲区，不是守卫写错了）。
 *
 * ## 本文件锚的不变量（与上面那些"形状"断言互补）
 * **`runGeometrySyncFade` 必须在 `return` 之前做一次首帧启动调度。**
 * 判据用**两处**（缺一不可）：① 全函数 `requestAnimationFrame(step)` 恰好 2 处
 * （链内续播 + 首帧启动）；② 启动那处紧邻 `return`，即位于 `step` 函数体**之外**。
 *
 * ⚠️ 判据风格与同目录其它 spec 一致：**先剥注释**再做形状断言（铁律 10）。
 */
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
    /* ⚠️ 锚"启动行紧接 return"而不是行号：行号会在重构时假红；
       ⚠️ 也不锚"出现顺序"（`step` 内那处文本上更靠前，顺序判据区分不出"谁是启动"）。 */
    expect(body, "`raf = window.requestAnimationFrame(step);` 不在 `return` 之前 ⇒ "
      + "首帧调度缺失（或被挪进了 `step` 里当自递归）⇒ 引擎永远停在「未启动」状态")
      .toMatch(/raf\s*=\s*window\.requestAnimationFrame\(step\);\s*\n\s*return\s*\(\)\s*=>/);
  });

  it("取消句柄仍只「停表」（不许在 cancel 里补跑 `onFrame`）", () => {
    /* ⚠️ A-1186 的教训：曾在 cancel 里补跑一次 `onFrame(1, true)` 想"把样式收干净"。
       但每个调用点开头都是 `xxxFadeCancelRef.current?.()` —— 新动画刚启动就会
       取消上一次 ⇒ 那次补跑立刻写 done 值 ⇒ 新动画的 opacity 只被写 1 次（其后 0 次）
       ⇒ 淡入淡出彻底消失。⇒ cancel 只许停表，不允许回调。 */
    const m = /function\s+runGeometrySyncFade\b[\s\S]*?\n\}/.exec(APP_CODE);
    const body = m![0];
    const ret = body.slice(body.indexOf("return () => {"));
    /* ⚠️⚠️ 必须用**词边界** `/\\bonFrame\\b/`：裸 `/onFrame/` 会命中 `cancelAnimati` + **`onFrame`**
       —— 即 `cancelAnimationFrame(raf)` 自己是它的子串 ⇒ 这条断言会**恒假红**
       （第一版就是这么写的，实测报红而实际代码完全正确）。 */
    expect(ret, "cancel 回调里出现了 `onFrame` ⇒ 会立即写 done 值（A-1186 的回归）")
      .not.toMatch(/\bonFrame\b/);
    expect(ret, "cancel 回调里必须真的取消 rAF（否则那一帧仍会跑一次 onFrame）")
      .toMatch(/window\.cancelAnimationFrame\(raf\)/);
  });
});
