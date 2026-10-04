/**
 * tests/core-ts/a1177-drag-gap.spec.ts —— 浮层态**拖左栏**时右栏必须跟随（A-1177）。
 *
 * ## 用户现象
 * 「窗口化后，如果你大幅拖动调整左右侧边栏比例，中间的分隔线就会分开，
 *   分的不远会自动吸附，一旦远了，就无法吸附变成……空白区域。」（附截图：左栏内容右边界
 *   在 x≈230、分隔线/主区在 x≈318 ⇒ 中间约 88px 空白）
 *
 * ## 三条根因（都是"同一事实写了多处、彼此不同步"）
 * ① **拖拽期 `--left-w` 完全不跟随**：`--left-w` 的语义是「左栏**目标占位宽**」
 *    （`sidebarOpen ? sidebarWidth : 0`，A-1172 定的），而拖动为了"零 React 重渲染"
 *    **不动 `sidebarWidth`** ⇒ 右栏纹丝不动、而左栏已拖开 ⇒ 边界脱节。
 *    ⇒ `onMove` 里逐帧写 `--left-w`（写 `lastW`，**不是** `getBoundingClientRect()`：
 *    不触碰 A-1166 那条"不许写实测派生值"的红线 —— 拖动路径没有那个观测闭环）。
 * ② **松手时内联宽被清空**：`onUp` 原来写 `asideEl.style.width = ""`，注释理由是
 *    "否则 React 认为 prop 未变而不再写回"。那只对了一半 —— React 的 style diff 比的是
 *    **上次渲染下发的 style 对象**，命令式清空它**不知道** ⇒ 若 `sidebarWidth` 恰好没变就
 *    **不重写** ⇒ `sb` 回落到 CSS 的 `clamp(...)`（本机正好 240）而 `--left-w` 是 520
 *    ⇒ 错位 280px（实测）。⇒ 改成**钉成最终值 `w`**（与 `setSidebarWidth(w)` 逐字一致）。
 *    `onCancel` 同理。
 * ③ **RO 与拖拽争抢**：A-1172 的 `attachLeftWidthObserver` 在浮层态会写
 *    `sidebarWidthRef.current`（= 拖动**起点**宽度），拖拽中途被 RO 触发就**覆盖掉**
 *    `onMove` 的真值 ⇒ 一帧错位（实测 `left-w=520px` 而 `sb.w=280px`）。
 *    ⇒ 拖拽期以 `onMove` 为唯一权威：`leftDraggingRef` 让 `sync` 让位。
 *    ⚠️ 用 ref 而不是 `classList.contains("slime-dragging")`：RO 逐帧触发，
 *      每帧读 classList 是强制样式重算（A-1162 记过：7~11ms/帧）。
 *
 * ④ **CSS 特异度**（实测踩到）：A-1177 需要在拖拽期禁掉**右栏容器**的宽度过渡
 *    （A-1176 给浮层稳态的 `.right-wrapper` 加了 0.5s 过渡；不禁的话它每个 55ms 的新目标
 *    只走 5% ⇒ 永远追不上）。而 `body.slime-dragging .right-wrapper` 只有 **2 个类**，
 *    敌不过 A-1176 那条 `:not()×2` 的 **6 个类** ⇒ 必须照抄同样的 `:not()` 凑特异度。
 *
 * ## 取证（`gui/scripts/probe-a1177-drag-gap.mjs`，真 App CDP 逐帧）
 * 判据：拖拽全程 `rw.left === sb.width`（右栏左缘贴着左栏右缘），偏差 > 8px 即"分开"。
 * 修复前：向右拖到最宽 ⇒ 错位 280px；向左拖到最窄 ⇒ 280px。
 * 修复后：两个场景**全程 0px**。
 *
 * ⚠️ 判据风格：**剥注释**后形状断言（不渲染组件、不依赖会话数据）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const APP_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8"));
const CSS_CODE = strip(readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8"));

const fnBody = (name: string): string => {
  const m = new RegExp(`function ${name}\\([^)]*\\)[\\s\\S]*?\\n  \\}`).exec(APP_CODE);
  expect(m, `取不到 ${name}（守卫自己失效了）`).toBeTruthy();
  return m![0];
};

describe("A-1177 浮层态拖左栏：右栏必须跟随（不许出现空白带）", () => {
  it("`onMove` 逐帧把左栏宽同步给 `--left-w`（浮层态）", () => {
    /* ⚠️ 写 `lastW`（目标宽）而**不是** `getBoundingClientRect()`：
       A-1166 那条不变量禁止的是"逐帧把**动画中间值**喂回去"形成观测闭环，
       拖动路径没有那个闭环；而 `lastW` 是个 number，语义干净。 */
    const body = fnBody("handleSidebarResize");
    expect(body, "`onMove` 没有同步 `--left-w` ⇒ 拖拽期间右栏不动 ⇒ 边界脱节")
      .toMatch(/if\s*\(floatStateRef\.current\s*!==\s*"none"\)\s*\{\s*rightWrapperRef\.current\?\.style\.setProperty\("--left-w",\s*`\$\{lastW\}px`\)/);
  });

  it("`onUp` / `onCancel` 都**不许**把内联宽清空（要钉成最终值）", () => {
    const body = fnBody("handleSidebarResize");
    /* ⚠️ 判据：清空只允许出现在**吸附收起分支**里那一处 ——
       收起时 `.sidebar.collapsed { width: 0 !important }` 会接管，清掉是对的。
       而 `onUp` 的普通分支与 `onCancel` 那两处**必须钉成最终值**。
       ⇒ 判据 = "清空处恰好 1 处，且它前面是 `if (asideEl)`、后面紧跟 `setSidebarWidth(restoreW)`"
       —— 也就是它只可能出现在吸附分支里。 */
    const clears = [...body.matchAll(/asideEl\.style\.width\s*=\s*""/g)];
    expect(clears.length, `清空内联宽的地方有 ${clears.length} 处（只允许吸附分支那 1 处）⇒ onUp/onCancel 会让左栏回落 CSS 宽度 ⇒ 与 --left-w 错位`).toBe(1);
    /* 唯一那处必须紧跟在"走收起"分支之后（`setSidebarWidth(restoreW)` + `animateLeftSidebar(false)`）。 */
    const after = body.slice(clears[0].index ?? 0, (clears[0].index ?? 0) + 400);
    expect(after, "唯一那处清空不在吸附分支里 ⇒ onUp/onCancel 会让左栏回落 CSS 宽度")
      .toMatch(/setSidebarWidth\(restoreW\)/);
    expect(body, "`onUp` 该把内联宽钉成最终值 `w`").toMatch(/asideEl\.style\.width\s*=\s*`\$\{w\}px`/);
    expect(body, "松手时也要把 `--left-w` 钉成最终值 `w`（否则右栏停在拖动中的值）")
      .toMatch(/setProperty\("--left-w",\s*`\$\{w\}px`\)/);
/* `onCancel` 走的是**另一个变量名**（`wCancel`）—— 它同样不许清空、同样要钉内联宽 + `--left-w`。
       ⚠️ `Math.round` 必须在 `setSidebarWidth(Math.round(` 里**内联**：
          守卫 `a1154-drag-baseline` ③ 钉的正是这个形状，抽成中间变量会让它假红（实测踩过）。 */
    expect(body, "`onCancel` 没把内联宽钉成最终值（会回落 CSS 宽度）")
      .toMatch(/asideEl\.style\.width\s*=\s*`\$\{wCancel\}px`/);
    expect(body, "`onCancel` 没把 `--left-w` 钉成最终值")
      .toMatch(/setProperty\("--left-w",\s*`\$\{wCancel\}px`\)/);
    expect(body, "`onCancel` 的 setSidebarWidth 必须内联 Math.round（a1154 ③ 钉的形状）")
      .toMatch(/setSidebarWidth\(Math\.round\(/);
  });

  it("`leftDraggingRef` 有写、且在 `onUp` / `onCancel` **成对**摘除（铁律 11）", () => {
    const body = fnBody("handleSidebarResize");
    expect(body, "起点没写 `leftDraggingRef.current = true` ⇒ RO 会覆盖 onMove 的真值")
      .toMatch(/leftDraggingRef\.current\s*=\s*true/);
    const nFalse = (body.match(/leftDraggingRef\.current\s*=\s*false/g) || []).length;
    expect(nFalse, `摘除点只有 ${nFalse} 处（应为 2：onUp + onCancel）⇒ 有一处漏了会让"拖动中"状态一直挂着`)
      .toBe(2);
  });

  it("RO 的 `sync` 在拖拽期让位（以 `onMove` 为唯一权威）", () => {
    /* 取 `attachLeftWidthObserver`（useCallback 形式，判据要兼容） */
    const m = new RegExp("attachLeftWidthObserver[\\s\\S]*?\\n  \\}, \\[\\]\\)").exec(APP_CODE);
    expect(m, "取不到 `attachLeftWidthObserver`").toBeTruthy();
    const body = m![0];
    expect(body, "`sync` 没有在拖拽期让位 ⇒ 它会按 A-1172 写拖动**起点**宽度、覆盖 `onMove` 的真值（一帧错位 240px）")
      .toMatch(/if\s*\(leftDraggingRef\.current\)\s*\{\s*return;\s*\}/);
  });
});

describe("A-1177 拖拽期必须禁掉右栏**容器**的宽度过渡（且特异度要够）", () => {
  it("存在 `slime-dragging` + `right-wrapper` 的 `transition: none` 规则", () => {
    expect(CSS_CODE, "拖拽期没禁掉右栏容器的过渡 ⇒ A-1176 那条 0.5s 会让它永远追不上 `--left-w` 的每帧新值")
      .toMatch(/body\.slime-dragging\s+\.right-wrapper[^{]*\{[^}]*transition:\s*none/);
  });

  it("那条规则的**特异度不低于** A-1176 那条（否则被盖掉 —— 实测就踩了）", () => {
    /* A-1176：`body.float-layout .right-wrapper:not(.right-wrapper-anim):not(.right-wrapper-exit)` = 6 个类。
       `body.slime-dragging .right-wrapper` 只有 2 个类 ⇒ **输给它、拖拽时右栏仍不动**（实测）。
       ⇒ 需要一条**照抄了同样两个 `:not()`** 的（凑到同等特异度、靠源码顺序取胜）。
       ⚠️ 用"所有匹配里**至少一条**带 `:not()`"而不是"第一条"：文件里有两条同名规则
       （一条简写、一条带 `:not()`），只判第一条会假红。 */
    const sels = [...CSS_CODE.matchAll(/body\.slime-dragging\s+\.right-wrapper([^{]*)\{/g)].map((m) => m[1]);
    expect(sels.length, "找不到 `body.slime-dragging .right-wrapper` 规则").toBeGreaterThan(0);
    const strong = sels.filter((s) => s.includes(":not(.right-wrapper-anim)") && s.includes(":not(.right-wrapper-exit)"));
    expect(strong.length,
      `带 :not() 的那条不存在（现有 ${sels.length} 条：${JSON.stringify(sels)}）`
      + ` ⇒ 特异度不够（2 个类 vs A-1176 的 6 个类）⇒ 会被盖掉、拖拽时右栏仍不动`)
      .toBeGreaterThan(0);
  });
});