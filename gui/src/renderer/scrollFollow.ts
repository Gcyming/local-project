/**
 * gui/src/renderer/scrollFollow.ts — 「锁定吐字最新」（贴底自动跟随）的**判据唯一出处**。
 *
 * 用户原话（A-1107）：「现在锁定在吐字最新的功能有点问题，有时候用户想往上滚动很费劲，
 * 会抖动半天，有种用户想往上，但是程序不准你往上的感觉，你优化一下代码，这个功能本身
 * 没问题，但是体验有问题，你优化一下，不删除功能本身的同时，又可以不妨碍用户使用。」
 *
 * 用户原话（A-1109，第二轮 —— 第一版**反而更糟**）：「现在锁定最新吐字位置的功能不仅
 * 时常出现不能在用户滚到最新吐字位置后锁定在最新位置的情况，还会在途中偶尔出现反复
 * 上下抖动的情况，你这比改动之前还糟糕啊。」
 *
 * 分工：本模块只回答两个问题；真正的 `scrollTop` 写入留在 `ChatPanel`（DOM 的持有者）。
 *   ① `decideFollow` —— 这次**用户**滚动之后，还要不要继续自动跟随？
 *   ② `hasInnerScroller` —— 这次滚轮是**内层**（代码块）在滚，还是整条对话流在滚？
 *
 * ⚠️ 为什么必须有 ②：`wheel` 会从内层元素**冒泡**上来。不做区分的话，用户在代码块里
 *    滚一下就把整条对话流的自动跟随解掉了（静默：回来发现「怎么不跟了」）。
 *
 * ══ A-1109：第一版判据为什么「比改之前还糟」—— 两条症状同一个源头 ══════════════
 *
 * 第一版 `decideFollow` 在距离支之外还有一条**方向支**：`top < prevTop - 1` ⇒ 判定
 * 「用户在上翻」⇒ 解锁。它假设「scrollTop 变小 = 用户意图」。**这个假设是错的**：
 *
 *   · `scrollTop` 不只用户会写 —— **程序自己每帧也在写**（贴底循环 `el.scrollTop = scrollHeight`）；
 *   · 而 `scrollHeight` 会被**重排**短暂变小（markdown 重新解析、图片/字体加载完成、
 *     折叠块收放、`pre-wrap` 换行重算…）；
 *   · `scrollHeight` 一变小，浏览器就把 `scrollTop` **钳小**（否则会滚过内容底部）
 *     ⇒ 方向支读到「变小」⇒ **误判成用户上翻**。
 *
 * 用户**什么都没做**，跟随却被解掉了 —— 这就是症状①「滚到最新也锁不住」；
 * 而误判那一刻 `gap = scrollHeight - top - clientHeight` **仍然是 0**（视口确实在底部），
 * 于是「方向支判解锁」与「距离支判重锁」在**同一批帧里互相打架** ⇒ 反复解锁/重锁
 * ⇒ 症状②「反复上下抖动」。
 *
 * ⇒ 修法（结构性，不是调参）：
 *   ① **删掉方向支**。判据只看 `gap` —— 重排时 `top` 被钳小、`gap` 恒为 0，不再误判。
 *      「用户上翻」改由 `wheel` 事件承担（见下）。
 *   ② **引入滞回（hysteresis）**：解锁阈值 `FOLLOW_RELEASE_PX`(48) 与重锁阈值
 *      `FOLLOW_RESUME_PX`(8) **刻意不等**，中间是**不动作区**。这是控制论里消除
 *      「阈值附近来回切换」的标准手段 —— 抖动因此在结构上不可能发生。
 *
 * ⚠️ 为什么「用户上翻」的主信号必须是 `wheel`（而 `gap` 只能当补充）：贴底时程序每帧写
 *    `scrollTop = scrollHeight`，用户滚轮上滚的那几个像素**立刻被下一帧拉回**，
 *    所以 `scroll` 事件里读到的 `gap` 几乎恒为 0 —— **判不出**「用户正在上翻」。
 *    `deltaY < 0` 与 `scrollTop` 无关，不受这个抵消影响。
 *    `gap` 支只作补充：覆盖拖滚动条 / PageUp / 触屏这些**不产生 wheel** 的上翻。
 * ⚠️ 「回到底部」必须**真的到底**（`FOLLOW_RESUME_PX`=8）：若沿用 48px 那种宽松阈值，
 *    用户只上翻 20px 就会被立刻重锁（又把他拽回去）—— 那正是用户说的
 *    「想往上，但程序不准你往上」。
 */

/** 离底超过这个（且这次滚动是**用户**干的）⇒ 认为用户确实离开了底部。 */
export const FOLLOW_RELEASE_PX = 48;
/** 真正回到底部（`gap ≤` 此值）⇒ 恢复跟随。**刻意 ≪ RELEASE** ⇒ 中间成为「不动作区」，抵消抖动。 */
export const FOLLOW_RESUME_PX = 8;

export interface ScrollMetrics {
  /** 本帧 `scrollTop` */
  top: number;
  scrollHeight: number;
  clientHeight: number;
  /** **当前**是否处于跟随态 —— 滞回需要知道「现在是哪一边」；落在不动作区时无从判断。 */
  following: boolean;
}

/** 这次**用户**滚动之后还要不要继续自动跟随（贴底）。
 *
 * | 情形 | 结果 | 为什么 |
 * |---|---|---|
 * | 离底 ≤ `FOLLOW_RESUME_PX`(8) | `true` | 真的回到底部 ⇒ 恢复跟随 |
 * | 离底 > `FOLLOW_RELEASE_PX`(48) | `false` | 用户明确离开底部（在看历史）⇒ 别抢他视口 |
 * | 其余（8 < gap ≤ 48） | `following`（**不变**） | **滞回区**：保持现状。抖动就在这里被结构性消除 |
 *
 * ⚠️ 这里**没有**方向支 —— 原因见文件头：重排会把 `scrollTop` 钳小，方向支必然误判。
 * ⚠️ 调用方必须先保证「这次滚动确实是用户产生的」：程序自己写 `scrollTop`（贴底跟随、
 *    加载更早的历史）不该被当成用户意图。
 * ⚠️ 程序滚动时**返回 `following`（现状）而不是 `true`**：一个误判成「用户滚动」的
 *    程序写入若被当成「用户回到 8px 内」，就会在用户明明已经上翻时把跟随**强行锁回来**
 *    —— 那正是「不准我往上」。 */
export function decideFollow(m: ScrollMetrics): boolean {
  const gap = m.scrollHeight - m.top - m.clientHeight;
  if (gap <= FOLLOW_RESUME_PX) { return true; }
  if (gap > FOLLOW_RELEASE_PX) { return false; }
  return m.following;
}

/** 一个元素的纵向滚动度量（调用方从 DOM 读，本模块只做判定）。 */
export interface ScrollBox {
  scrollHeight: number;
  clientHeight: number;
  /** `getComputedStyle(el).overflowY` */
  overflowY: string;
}

/** 祖先链里（**不含** scroller 自身）是否存在一个「自身可纵向滚动」的盒子。
 *
 *  ⚠️ `scrollHeight > clientHeight + 1` 里的 `+1`：亚像素 / 取整会造出 1px 的假溢出。
 *  ⚠️ 必须**同时**看 `overflowY`：`overflow: visible` 的元素即使内容更高也**不产生**
 *     自己的滚动条（它只是被撑高），把它当成「内层滚动」会让主判据整体失效
 *     —— 那样用户在代码块上滚一下，整条对话流的自动跟随就永远解不掉了。 */
export function hasInnerScroller(ancestors: readonly ScrollBox[]): boolean {
  return ancestors.some(
    (a) => a.scrollHeight > a.clientHeight + 1 && (a.overflowY === "auto" || a.overflowY === "scroll"),
  );
}
