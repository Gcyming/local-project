/**
 * gui/src/renderer/pages/floatDock.ts — 输入框上方「悬浮按钮坞」的**互斥判据**（A-1074 / #230）。
 *
 * 用户原话（#230）：
 *   「改成输入框**正上方的最右边**悬浮按钮，点击后**横向延伸再向上展开**，动画与产物卡片同族」
 *   「子代理从右侧监测栏移出，做成**同款**悬浮按钮」
 *   「**一个展开时另一个渐出**」
 *
 * ## 为什么把这几行判据抽成纯模块
 *
 * 「同一个时刻只能展开一个面板」这件事，如果让两个按钮**各自**持有一个 `open` 布尔，那么
 * "两个面板同时展开"只是一个没人在意的非法状态 —— 界面上表现为两块面板叠在一起、或者后点开的
 * 把先点开的盖住，而 tsc / 构建 / 全部逻辑测试都不会响。
 *
 * ⇒ 把"当前展开的是哪一个"收敛成**一个单值**（`DockState`），非法状态在类型上就不存在；
 *   "另一格现在是什么状态"也不再由组件各判一次，而是从同一个单值派生（`isDockOpen`）。
 *   这样"互斥"是可**穷举验证**的：枚举所有 `(state, id)` 组合即可（见守卫）。
 *
 * ## ⚠️ A-1126 范围更正：渐出的是**面板**，不是按钮（用户 2026-09-26）
 *
 * 用户原话：「为什么点击后台任务后，**同行的子代理悬浮按钮会消失**？旧设定没删干净？」
 *
 * 原实现（A-1074）把 `isDockFaded` 派生成的 `is-faded` 类挂到**整格**上
 * （`.dock-slot.is-faded { opacity: 0; pointer-events: none; }`）——
 * 于是展开「后台任务」时，**旁边那个子代理按钮**整颗淡成透明：用户"想点它却发现它没了"。
 * 那是把"面板互斥"顺手做成了"入口互斥"，与"两个按钮都该常显"直接冲突。
 *
 * ⇒ 现在**没有 `faded` 这个概念了**：面板互斥已经由单值 `DockState` + 各自的 `.collapse`
 *   开合态保证（同一时刻只有一个 `.collapse.is-open`）；按钮只按自己的数据决定显示与否
 *   （后台资源为 `any`、子代理为有记录），**永不因为另一个面板开着而消失**。
 *   唯一保留的视觉反馈是"哪个是开着的"（`is-open` 高亮，见 index.css）。
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

/** 该项的面板是否展开。 */
export function isDockOpen(current: DockState, id: DockId): boolean {
  return current === id;
}

/**
 * 坞内一格的类名。由**父级从单值 state 派生后**传下来（组件自己不许再持一份 `open`——
 * 那就是第二个真相源）。
 *
 * ⚠️ 只有 `is-open` 这一个状态位：**没有 `is-faded`** ——
 *   那是 A-1074 的旧设定（让另一格整颗淡出），已被用户否掉（见文件头 A-1126）。
 *   别把它加回来：加上去的那一刻，"另一个按钮会不会消失"就又开始由 CSS 决定了。
 */
export function dockSlotClassOf(open: boolean): string {
  return `dock-slot${open ? " is-open" : ""}`;
}
