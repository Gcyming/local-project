import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

const APP_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/App.tsx"), "utf8");
const CSS_CODE = readFileSync(join(PROJECT_ROOT, "gui/src/renderer/index.css"), "utf8");

/** 取某个函数体的花括号范围。
 *  ⚠️ 必须同时支持 `function foo()` 与 `const foo = React.useCallback(() => {…})` 两种写法 ——
 *  只认 `function ` 的话，`attachLeftWidthObserver` 这种 useCallback 形式会直接找不到；
 *  而这个查找发生在 **describe 求值期**（不是 it 里）⇒ vitest 报「no tests」而不是「1 failed」，
 *  很容易被误判成"文件写坏了"。 */
function fnBody(src: string, name: string): string {
  const m = new RegExp("(?:function\\s+|const\\s+|let\\s+|var\\s+)" + name + "\\b").exec(src);
  if (!m) { throw new Error("找不到声明 " + name); }
  const arrow = src.indexOf("=>", m.index);
  const brace = src.indexOf("{", m.index);
  const start = arrow >= 0 && arrow < brace ? arrow : brace;
  let depth = 0, started = false;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) { return src.slice(m.index, j + 1); } }
  }
  throw new Error("函数体未闭合 " + name);
}
/* ⚠️⚠️⚠️ A-1166：`--left-w` 必须写**目标宽度**，**绝不**写实测宽度。
   六轮抖动的总闸门。用户自检数据（Ctrl+Shift+D，真实长会话 + 最大化 1707px）逐帧实测：

     sb.width   303 → **257** → 295 → 302 → 303      ← 硬跳 + 平滑回弹
     rw.width   1404 → **1450** → 1412 → 1405 → 1404  ← = 1707 − 左栏宽
     rs.left    257 → 508 → 578 → 610 → 638 → 666
     host.left  315 → 396 → 420 → 432 → 442 → 452    ← 浮窗位置跟着走
     host.width 666 → 504 → 455 → 433 → 412 → 392    ← 被推着挤缩

   六处"方向反转"里，**五处都是左栏宽度的下游**：
     · `.right-wrapper` 浮层态宽度 = `calc(100% - var(--left-w))`；
     · `rs.left` 由同一变量决定；
     · 浮窗默认 x = `(sidebarOpen ? sidebarWidth : 0) + 12`（App.tsx:1763）。
   1404→1450→1412 的"冲过头再回落"正是 `1707−257=1450`、`1707−295=1412` ——
   说明 `--left-w` **逐帧跟着实测值走**，而不是跟着目标走。

   闭环成立：`.sidebar` **常驻** `transition: 0.5s` ⇒ 它每一帧宽度都在变 ⇒
   ResizeObserver 每帧触发 ⇒ 每帧把**动画中的中间值**写回 `--left-w` ⇒
   布局再被这个中间值影响 ⇒ 再观测。**观测 → 写回 → 再观测。 */
describe("A-1166 `--left-w` 写目标、不写实测（切断观测→写回→再观测的闭环）", () => {
  const sync = fnBody(APP_CODE, "attachLeftWidthObserver");

  it("`--left-w` 写入的是 `sidebarWidthRef`（目标），不是 `getBoundingClientRect()`（实测）", () => {
    expect(sync, "`--left-w` 仍在写实测宽度 ⇒ 闭环未切断，动画中间值会继续逐帧写回")
      .toMatch(/setProperty\(\s*"--left-w"[^\n]*sidebarWidthRef\.current/);
    expect(sync, "`--left-w` 仍从 getBoundingClientRect 取值 ⇒ 写回的是动画中间值")
      .not.toMatch(/setProperty\(\s*"--left-w"[^\n]*getBoundingClientRect/);
  });

  it("保留 ResizeObserver 作为**触发器**（窗口 resize 走 CSS `--sidebar-w`，不经 React state）", () => {
    /* ⚠️ 反向守卫：不能顺手把 ResizeObserver 删掉 —— 窗口 resize 时左栏宽是
       `vw×17.5%`（index.css 的 `--sidebar-w`），那条路**不经过** React state，
       删了就再也同步不上，等于用一个 bug 换另一个更隐蔽的 bug。 */
    expect(sync, "ResizeObserver 被删了 —— 窗口 resize 后 --left-w 会永久失同步")
      .toMatch(/ResizeObserver/);
  });

  it("只在浮层态同步（普通态不该持有浮层专用变量）", () => {
    expect(sync, "少了浮层态判断 ⇒ 普通态也会残留 --left-w").toMatch(/floatStateRef\.current\s*===\s*"none"/);
  });

  it("`--left-w` 的**逐帧写入点**只剩稳态读值，不许再有动画中间值回写", () => {
    /* ⚠️ 消费侧守卫：`--left-w` 的唯一消费者是**内联**的
       `width: calc(100% - var(--left-w, 0px))`（App.tsx:2334）——它**不在 CSS 文件里**，
       早先误断言 `CSS_CODE` 会恒红。真正要守的是：**所有** `setProperty("--left-w")`
       的实参里都不许再出现 `getBoundingClientRect()` 派生值。
       ⚠️ 稳态那一处（浮层唤出后读一次实测 `leftWNow`）是**允许**的 ——
          它一个浮层周期只跑一次，不是逐帧闭环；且窗口 resize 时左栏宽由 CSS `--sidebar-w`
          决定、不经 React state，只能靠实测兜底。 */
    const writes = [...APP_CODE.matchAll(/setProperty\(\s*"--left-w"\s*,\s*([^\n;]*)/g)]
      .map((m) => m[1]);
    expect(writes.length, "没找到 `--left-w` 的写入点（守卫失效，需重写）").toBeGreaterThan(0);
    for (const w of writes) {
      expect(w, "`--left-w` 又在写实测派生值 ⇒ 观测→写回→再观测的闭环没切断")
        .not.toMatch(/getBoundingClientRect/);
    }
    /* 反向断言：稳态那次读值必须还在，否则窗口 resize 后会永久失同步。 */
    expect(APP_CODE, "稳态 `--left-w` 读值被误删 —— 窗口 resize 后会永久失同步")
      .toMatch(/leftWNow/);
  });
});