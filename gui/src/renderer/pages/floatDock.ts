/**
 * gui/src/renderer/pages/floatDock.ts — 输入框上方「悬浮按钮坞」的**互斥判据**（A-1074 / #230）。
 *
 * 用户原话（#230）：
 *   「改成输入框**正上方的最右边**悬浮按钮，点击后**横向延伸再向上展开**，动画与产物卡片同族」
 *   「子代理从右侧监测栏移出，做成**同款**悬浮按钮」
 *   「**一个展开时另一个渐出**」
 *
 * ## 为什么把这三行判据抽成纯模块
 *
 * 「同一个时刻只能展开一个」这件事，如果让两个按钮**各自**持有一个 `open` 布尔，那么
 * "两个同时展开"只是一个没人在意的非法状态 —— 界面上表现为两块面板叠在一起、或者后点开的
 * 把先点开的盖住，而 tsc / 构建 / 全部逻辑测试都不会响。
 *
 * ⇒ 把"当前展开的是哪一个"收敛成**一个单值**（`DockState`），非法状态在类型上就不存在；
 *   "另一个要不要渐出"也不再由组件各判一次，而是从同一个单值派生（`dockSlotState`）。
 *   这样"互斥"是可**穷举验证**的：枚举所有 `(state, id)` 组合即可（见守卫）。
 *
 * 本模块**不得**出现 React / JSX / DOM（对齐 `insertCopy.ts` / `streamFade.ts` 的分家约定）。
 */

/** 坞里的两个位置。顺序即渲染顺序（左 → 右）。 */
export type DockId = "procs" | "subs";

/** 同一时刻**至多一个**展开：`null` = 都收起。 */
export type DockState = DockId | null;

/** 渲染顺序的唯一出处（组件与守卫都读它，不各处再写一遍数组字面量）。 */
export const DOCK_ORDER: readonly DockId[] = ["procs", "subs"];

/** 点一下某一项：展开它；已经展开它则收起（toggle）。 */
export function toggleDock(current: DockState, id: DockId): DockState {
  return current === id ? null : id;
}

/**
 * **只关自己**：若正展开的是 `id` 就收起，否则原样返回。
 *
 * 为什么不能写成 `setDock(null)`：那样会把**另一个**正在展开的面板一起关掉。
 * 使用场景是"本项的数据空了 ⇒ 顺手收起自己的面板"（如后台资源清空）——
 * 此刻用户可能正开着子代理面板看东西，被顺手关掉就是典型的"无关操作互相踩"。
 */
export function closeDock(current: DockState, id: DockId): DockState {
  return current === id ? null : current;
}

/** 该项是否展开。 */
export function isDockOpen(current: DockState, id: DockId): boolean {
  return current === id;
}

/** 该项是否应当**渐出**（另一个正在展开 ⇒ 本项让位）。都收起时谁都不渐出。 */
export function isDockFaded(current: DockState, id: DockId): boolean {
  return current !== null && current !== id;
}

/**
 * 坞内一格的视觉态。组件只消费这个结果，不再自己判 ——
 * 于是"展开/渐出"这两个类名永远同源，不会出现"一个说展开、一个说收起"的漂移。
 *
 * 组件拿到的就是这两个布尔（由父级从**单值** state 派生后传下去），
 * 子组件**不许**再自己持有一份 `open` —— 那就是第二个真相源。
 */
export function dockSlotState(current: DockState, id: DockId): { open: boolean; faded: boolean } {
  return { open: isDockOpen(current, id), faded: isDockFaded(current, id) };
}

/**
 * 类名由**已派生出的标志**拼（不是再从 state 判一次）。
 * 唯一产地：组件之间不会各拼一份字符串，CSS 类名不会漂移。
 */
export function dockSlotClassOf(open: boolean, faded: boolean): string {
  return `dock-slot${open ? " is-open" : ""}${faded ? " is-faded" : ""}`;
}
