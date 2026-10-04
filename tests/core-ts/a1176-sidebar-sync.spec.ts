/**
 * tests/core-ts/a1176-sidebar-sync.spec.ts —— 浮层态「展开左栏」时右栏必须**同步让位**（A-1176）。
 *
 * ## 用户现象
 * 「窗口化后，左侧边栏的展开，动画慢于动作……右侧边栏已经让开了（是**秒让**，没有动画），
 *   左侧边栏才跟上。主要问题就是窗口化后，右侧边栏没有与左侧边栏的展开衔接动画协调」。
 *
 * ## 机制
 * 容器 `rw` 的宽度是内联的 `calc(100% - var(--left-w, 0px))`，而 `--left-w` 写的是
 * **目标占位宽**（`sidebarOpen ? sidebarWidth : 0`，A-1172 定的语义 —— 那条不能改，
 * 否则折叠左栏时右栏会少铺满 240px）。`sidebarOpen` 在点击那一帧就翻转
 * ⇒ `--left-w` **当帧**变 240 ⇒ `rw` 的宽度当帧 1332 → 1092；
 * 而浮层态 `rw` 有 `margin-left: auto`（A-1152）⇒ **左缘 = 窗口宽 − 宽度** ⇒ 左缘也当帧跳到 240。
 * 左栏那边却是 CSS `transition: width 0.5s` 慢慢长的 ⇒ 两者脱节。
 *
 * 真机实测（`probe-a1176-sidebar-sync.mjs`，浮层态点「展开左栏」）：
 * | | 修复前 | 修复后 |
 * |---|---|---|
 * | `12ms` | `sb.w=1  rw.l=240` ← 右栏**一帧**到位 | `sb.w=1  rw.l=1` |
 * | `19ms` | `sb.w=32 rw.l=240` | `sb.w=23 rw.l=23` ← 逐帧相等 |
 * | `389ms` | `sb.w=232 rw.l=240` ← 左栏还在长 | `sb.w=212 rw.l=212` |
 *
 * ## 修法
 * 给**浮层稳态**的 `rw` 补一条 `transition: width <与 .sidebar 逐字一致>`。
 * `--left-w` 仍是"目标值"（A-1172 的语义不动），但它的阶跃被 CSS 过渡抹平 ⇒ 与左栏同拍。
 *
 * ⚠️ 判据风格：**剥注释**后形状断言；时长**从两份文本取值比对**（不手抄期望值）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));

/** 取某条规则的规则体（选择器用正则给，避免手写转义）。 */
const ruleBody = (re: RegExp): string | null => {
  const m = re.exec(CSS_CODE);
  return m ? m[1] : null;
};
const durOf = (s: string): string | null => {
  const m = /transition:\s*width\s+([0-9.]+m?s)/.exec(s);
  return m ? m[1] : null;
};

describe("A-1176 浮层态「展开左栏」右栏必须同步让位（不许秒让）", () => {
  it("存在**浮层稳态**的 `rw` 宽度过渡规则（且排除过渡期与退场期）", () => {
    /* ⚠️ 必须排除 `.right-wrapper-anim`（过渡期用 `var(--right-target-w)` 驱动）
       与 `.right-wrapper-exit`（退场专用）—— 那两段有自己的宽度来源，不能被这条抢。 */
    const body = ruleBody(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s*\{([^}]*)\}/);
    expect(body, "找不到浮层稳态的 `.right-wrapper` 规则 ⇒ 右栏会「秒让」（用户现象）").toBeTruthy();
    expect(body, "这条规则里没有 `transition: width` ⇒ 右栏宽度仍然一帧到位").toMatch(/transition:\s*width\s/);
  });

  it("这条过渡的时长/缓动与 `.sidebar` 的 `transition: width` **逐字一致**（否则仍是一快一慢）", () => {
    const rwBody = ruleBody(/body\.float-layout\s+\.right-wrapper:not\(\.right-wrapper-anim\):not\(\.right-wrapper-exit\)\s*\{([^}]*)\}/);
    const sbBody = ruleBody(/(?:^|\n)\.sidebar\s*\{([^}]*)\}/);
    expect(rwBody, "找不到 rw 的浮层稳态规则").toBeTruthy();
    expect(sbBody, "找不到顶层 `.sidebar { … }` 规则").toBeTruthy();
    const rwDur = durOf(rwBody!);
    const sbDur = durOf(sbBody!);
    expect(rwDur, "rw 那条没写 `transition: width <时长>`").toBeTruthy();
    expect(sbDur, "`.sidebar` 没写 `transition: width <时长>`（守卫自己失效了）").toBeTruthy();
    expect(rwDur, `右栏让位时长 ${rwDur} 与左栏 ${sbDur} 不等 ⇒ 仍然不协调`).toBe(sbDur);
    const rwEase = /transition:\s*width\s+[0-9.]+m?s\s+([^;]+)/.exec(rwBody!);
    const sbEase = /transition:\s*width\s+[0-9.]+m?s\s+([^;]+)/.exec(sbBody!);
    expect((rwEase && rwEase[1].trim()) || "", "两者的缓动函数也必须一致（否则节奏不同）")
      .toBe((sbEase && sbEase[1].trim()) || "");
  });

  it("**不许**给普通态（非浮层）的 `.right-wrapper` 加宽度过渡（`auto` 不可插值）", () => {
    /* ⚠️ A-1157 记过的坑：普通态 `rw` 的宽度是 `auto`，而 `auto` **不参与插值**
       ⇒ 过渡根本不会启动。浮层态是 `calc(...)`（计算后是 px）才能插值。
       ⇒ 反向断言：不许出现"没有 `body.float-layout` 前缀的 `.right-wrapper { transition: width }`"。 */
    const all = [...CSS_CODE.matchAll(/(?:^|\n)([^{\n]*\.right-wrapper[^{\n]*)\{([^}]*)\}/g)];
    for (const m of all) {
      const sel = m[1].trim();
      const body = m[2];
      if (!/transition:\s*width/.test(body)) { continue; }
      expect(sel, `\`${sel}\` 给普通态的 .right-wrapper 加了宽度过渡 ⇒ \`auto\` 不可插值、过渡不会启动（A-1157 的坑）`)
        .toContain("float-layout");
    }
  });
});
