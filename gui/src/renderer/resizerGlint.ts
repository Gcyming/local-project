/**
 * gui/src/renderer/resizerGlint.ts — 拖拽分隔条「聚光」的位置驱动（A-1106 问题 4）。
 *
 * 用户原话：「你把这中间的判定做大一点……然后做个鼠标放上去的流光效果，描述的话就是，
 * 对于这个拖拽控制界面大小的部分，鼠标放置的位置来个最大的弧形以及颜色变化，
 * 然后鼠标放置的那个位置的上下部分逐渐变浅、变窄，直至变成正常界面间隔线的样子。」
 *
 * 分工：**本模块只负责「把指针的 Y 写进 CSS 变量」**，聚光的形状/衰减/颜色全在 CSS
 * （`index.css` 的 `--rz-ramp` + `.sidebar:has(.sidebar-resizer:hover)` 的 `border-image`）。
 * 形状是纯几何、不该由 JS 参与 —— 否则每帧算渐变就是「用 JS 重实现 CSS」。
 *
 * ⚠️⚠️ **变量写在父级上，不是写在 resizer 自己身上**（A-1106 续轮改成这样，别改回去）：
 *     分隔线就是父级（`.sidebar` / `.right-sidebar`）自己的那条 1px `border`，
 *     而把「静态 border 换成沿 y 的聚光渐变」只能用父级的 `border-image` 画 ——
 *     覆盖层要么被父级 `overflow: hidden` 裁掉，要么与真 border 叠成 2px（两条路都试过）。
 *     自定义属性**只向下继承、不向上**，所以写在 resizer 上父级读不到 ⇒ 必须写 `parentElement`。
 *     ⇒ **resizer 必须是那两个 aside 的直接子元素**；中间插一层 wrapper 会让聚光静默失灵
 *       （属性落在 wrapper 上，父级的渐变永远用兜底的 50%）。
 *
 * ⚠️ **为什么写 CSS 变量而不是 React state**：跟随鼠标是**每帧**的事，走 `setState`
 *    会把宿主组件（左栏 = `App`，右栏 = `RightSidebar`）整棵重渲染。直接写 DOM 自定义属性
 *    只有一次样式失效重算，零 React 渲染。这也是本模块刻意**不是** hook 的原因。
 *
 * ⚠️ **唯一出处**：左栏（`App.tsx`）与右栏（`RightSidebar.tsx`）必须共用这两个函数。
 *    两边各写一份 `onMouseMove` 也行得通，但那时「聚光位置」就有了第二个定义 ——
 *    改一处不改另一处 = 两栏行为不一致，而且过 tsc、过测试，只在用户眼里看得出来。
 */
import type * as React from "react";

/** 聚光变量的唯一名字 —— 与 `index.css` 的 `var(--rz-y, 50%)` 必须逐字符一致。
 *  写成常量而不是两处字面量：名字错了 CSS 读不到 ⇒ 渐变永远停在兜底 50%（静默失灵）。 */
const GLINT_VAR = "--rz-y";

/** 把指针在分隔条上的相对高度写进**父级**的 `--rz-y`（百分比，0% = 顶端，100% = 底端）。
 *
 *  钳到 [0, 100]：指针捕获（拖拽中）时 `clientY` 可以跑到元素之外，
 *  不钳的话渐变中心会飞出元素、聚光整段消失（用户看到「流光突然没了」）。 */
export function trackResizerGlint(e: React.MouseEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const host = el.parentElement;   // 分隔线的主人 = 父级（border 在它身上）
  if (!host) { return; }
  const r = el.getBoundingClientRect();
  if (r.height <= 0) { return; }
  const pct = ((e.clientY - r.top) / r.height) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  host.style.setProperty(GLINT_VAR, `${clamped.toFixed(2)}%`);
}

/** 指针离开：**移除**变量，回到渐变里声明的默认位（`var(--rz-y, 50%)`）。
 *  ⚠️ 用 `removeProperty` 而不是写回 `"50%"`：写回会把「默认值」变成第二个产地
 *  （CSS 里一份、这里一份），改了 CSS 就静默不一致。
 *  ⚠️ 清的是**父级**上的同名变量（与 `trackResizerGlint` 同一个宿主），否则清不掉、聚光卡在最后一个位置。 */
export function clearResizerGlint(e: React.MouseEvent<HTMLElement>): void {
  e.currentTarget.parentElement?.style.removeProperty(GLINT_VAR);
}
