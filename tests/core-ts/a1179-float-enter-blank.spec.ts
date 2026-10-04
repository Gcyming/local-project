/**
 * tests/core-ts/a1179-float-enter-blank.spec.ts —— 进入窗口化时**容器必须贴合内容**（不许露底）（A-1179）。
 *
 * ## 用户现象
 * 「右侧边栏直接屏闪了，每次窗口化会有一帧黑屏。」（发生在**进入**窗口化那一瞬）
 *
 * ## 根因（用户 trace `float-trace-2026-10-04T10-26-12.json` 逐帧指出来的，窗口 1707宽）
 *   `t=507ms rw=768+939  rs=768+939`（两者一致，无空白）
 *   `t=514ms rw=268+1439 rs=725+982`   ← **容器一步跳到最终位，内容还在 0.5s 过渡途中**
 *   `t=519ms rw=268+1439 rs=649+1059`  ← 空白 286px，**峰值 380px**
 * 那段空白落在 `.app` 的 `var(--bg)`（不透明深色）⇒ **看到一帧黑屏**。
 *
 * ## 为什么容器硬跳、内容不跳
 * · 内容 `.right-sidebar` 的旧宽是 **px**（367）⇒ 它的 `transition: width 0.5s` 生效。
 * · 容器 `.right-wrapper` 过渡期的旧宽来自**内联** `style.width` 的非浮层分支 = **`auto`**
 *   ⇒ **`auto` 不参与插值** ⇒ 任何 CSS `transition` 都不启动 ⇒ 硬跳。
 *   （A-1176 的注释里已记过「`auto` 不能参与插值」，但当时只给**稳态**加了过渡。）
 *
 * ## 修法：过渡期**不给容器宽度**
 * `style.width` 的浮层过渡分支返回 `undefined` ⇒ 回落 `auto` ⇒ 容器宽 = **内容宽**
 * ⇒ 容器永远贴合内容 ⇒ **结构上不可能**出现「容器已到位、内容还在长」的空白带。
 *
 * ## 为什么不是"给容器加过渡"（实测两次都失败，别再试）
 * · 加 `transition: width` 于容器 ⇒ 无效（旧宽是 `auto`，不可插值）。
 * · 两段式写独立变量 `--right-wrap-w` + `void el.offsetWidth` 强制同步布局
 *   ⇒ 实测空白 380 → 582 → **662px**，**完全没改善**：内联宽读的变量在 React 提交那帧
 *   已经是目标值 ⇒ 没有「旧值」可插值。
 *
 * ##⚠️ 必须排除退场期（`rightExitAnim`）
 * `dismissFloat` 走 `right-wrapper-exit`，它要求容器**保持铺满**（A-1157-R2）。
 * 一旦这里也返回 `undefined`，退场期容器变内容宽 ⇒ 实测 `|rw.width − rs.width|` 峰值 657px。
 * ⇒ 用 `rightExitAnim ? "var(--right-target-w)" : undefined` 精确分流。
 *
 * ## 实测（A/B 对照，同一台机器同一探针）
 * | | 进入窗口化空白峰值 | 退出窗口化空白峰值 |
 * |---|---|---|
 * | 修复前 | **623px** ❌ | 661px |
 * | 修复后 | **0px** ✅ | 661px（**原本就有**，非本次引入） |
 *
 * ⚠️ 退出方向那 661px 是**既有**现象（A/B 对照证明修复前后相同），
 *   且用户此前明确说「窗口化恢复的时候没有抖动」⇒ 本轮**刻意不动**（铁律：不牵动其他问题）。
 *
 * ⚠️ 判据风格：**剥注释**后形状断言。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));

describe("A-1179 进入窗口化：容器过渡期**必须不给宽度**（否则容器硬跳、露底 = 一帧黑屏）", () => {
  /** 取 `.right-wrapper` 的 `style.width` 那个三元表达式（剥注释后按锚点定位）。 */
  const widthExpr = (): string => {
    const i = APP_CODE.indexOf("width: (mainIsFloatLayout && !rightMin0)");
    expect(i, "取不到 `.right-wrapper` 的 style.width（守卫自己失效了）").toBeGreaterThan(-1);
    /* ⚠️ 结束锚点用 `: "auto") }}` —— 之前用 `indexOf("}}")` 会命中**更早**的 `}}`
       （三元之前还有别的 JSX 闭合），导致截断后看不到 `rightExitAnim`（实测假红）。 */
    const end = APP_CODE.indexOf(': "auto") }}', i);
    expect(end, "三元表达式没有按预期闭合").toBeGreaterThan(-1);
    return APP_CODE.slice(i, end + ': "auto") }}'.length);
  };

  it("浮层过渡分支的容器宽度是 `undefined`（⇒ `auto` ⇒ 贴合内容）", () => {
    /* 判据：`style.width` 的浮层支必须是 `undefined`（或整支缺席）。
       ⚠️ 不锚具体 CSS 变量名 —— 要锚的是「不给宽度」这个**语义**。 */
    const seg = widthExpr();
    const floatBranch = /mainIsFloatLayout\s*\?\s*\(([\s\S]*?)\)\s*:\s*"auto"/.exec(seg);
    expect(floatBranch, "取不到浮层分支").toBeTruthy();
    expect(floatBranch![1], "浮层过渡分支给了具体宽度 ⇒ 容器硬跳 ⇒ 空白带（一帧黑屏）复现")
      .toMatch(/undefined/);
  });

  it("**退场期必须例外**（`rightExitAnim` 时仍给宽度，否则退出方向反而坏）", () => {
    /* ⚠️ 这是本条判据里最容易被"顺手清理"掉的一环：
       A-1157-R2 要求退场期容器保持铺满（`right-wrapper-exit` 依赖它）。
       实测：不给宽度 ⇒ 退出段 `|rw.width − rs.width|` 峰值 657px。 */
    const seg = widthExpr();
    const floatBranch = /mainIsFloatLayout\s*\?\s*\(([\s\S]*?)\)\s*:\s*"auto"/.exec(seg);
    expect(floatBranch![1], "浮层分支里没有 `rightExitAnim` 判断 ⇒ 退场期容器会变内容宽（A-1157-R2 被破坏）")
      .toMatch(/rightExitAnim\s*\?/);
  });

  it("过渡期**内容**宽度仍由 `--right-target-w` 驱动（不能一起改成 undefined）", () => {
    /* 反向断言：这次只改**容器**。内容若也改成 `undefined`，
       `.right-sidebar` 的 `width: var(--right-target-w) !important` 会失去意义
       ⇒ 过渡期宽度不由变量驱动 ⇒ 又回到 A-1155 那条死锁。 */
    const m = /if\s*\(el\s*&&\s*isFloatExpand\)\s*\{[\s\S]*?\n      \}/.exec(APP_CODE);
    expect(m, "取不到写`--right-target-w` 的那段").toBeTruthy();
    expect(m![0], "过渡期不再写 `--right-target-w` ⇒ 内容宽度失去来源")
      .toMatch(/setProperty\("--right-target-w"/);
  });

  it("**不许**给过渡期容器加宽度过渡（实测无效：`auto` 不可插值）", () => {
    /* 记录一个"看起来很合理但实测无效"的方案，防止后人再走一遍：
       两段式写独立变量 `--right-wrap-w` + `void offsetWidth` 强制同步布局
       ⇒ 实测空白 380 → 582 → 662px，完全没改善。 */
    const m = /if\s*\(el\s*&&\s*isFloatExpand\)\s*\{([\s\S]*?)\n      \}/.exec(APP_CODE);
    expect(m![1], "又出现了 `offsetWidth` 强制同步布局 ⇒ 那套实测无效（空白 662px）")
      .not.toMatch(/offsetWidth/);
    expect(APP_CODE, "又出现了作废的 `--right-wrap-w` ⇒ 那套实测无效")
      .not.toMatch(/--right-wrap-w/);
  });
});