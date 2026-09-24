/**
 * gui/src/renderer/pages/streamCursor.ts — A-1091：流式「吐字光标」的显示判据（唯一出处）。
 *
 * ## 用户诉求（原话）
 *
 * 「给我吧那个输入的闪烁的光标删了，或者改成**只有吐字的时候才显示**。」
 *
 * ## 改前的行为（与诉求相反）
 *
 * `.stream-cursor` 在 `streaming` 期间**无条件**闪烁（`animation: blink 1s step-start infinite`）——
 * 也就是只要这一轮还在"进行中"就一直闪，**与"有没有字在出来"无关**。
 * 真机现象：状态行写着「正在输出回复 · 已 6m49s · 工具 12 次」，整整 6 分多钟没有任何新字符，
 * 光标却一刻不停地闪 —— 看起来像"还在打字"，实际上游什么都没回来
 * （用户只能干等，且无法从界面判断"是真在出字还是卡住了"）。
 *
 * ## 判据
 *
 * **「最近一次真正吐字（显示层推进）距今 < 阈值」才显示。**
 *
 * ⚠️ 证据必须是**活动时间戳**，不能用 UI 状态（`loading` / `streaming`）——
 *    这正是本仓 A-1061⑤ 立下的判据：「某操作正在进行」不能用 UI 状态当唯一依据
 *    （它会被合法的提前收尾清掉，也会像这里一样在**停滞**时仍然为真）。
 *    唯一的区别是本次的镜像形态：不是"误判为已结束"，而是"**误判为还在进行**"。
 *
 * ⚠️ 阈值取 1.2s：typewriter 的推进间隔是 28ms/字，正常吐字时每次推进都会刷新时间戳，
 *    因此正常流式期间光标**始终可见**（观感不变）；只有真正断流才会在 1.2s 后消失。
 *    阈值给太小（如 200ms）会在高速模型"逐字追赶"的帧间隙里闪断，看起来像在抖。
 */

/** 停止吐字后光标还能停留多久（ms）——见文件头注释里的取值理由 */
export const STREAM_CURSOR_IDLE_MS = 1200;

/**
 * 是否显示吐字光标。
 *
 * @param now 当前时间（ms，`Date.now()`；调用方注入以便单测）
 * @param lastEmitAt 最近一次**显示层真的推进了字符**的时刻（ms）。
 *   `0` / 非有限值 = 本轮还没吐过任何字 ⇒ 不显示（此时界面上是「正在思考」三点动画，不该有光标）。
 * @param idleMs 空闲阈值；超过它就认为"没在吐字"
 * @returns true = 显示
 *
 * ⚠️ 不做 `now - lastEmitAt >= 0` 的钳制：时钟回拨 / `lastEmitAt` 落在未来时差值为负，
 *    那恰恰说明"刚刚才吐过"，应该显示。只在**超过阈值**时隐藏。
 */
export function shouldShowStreamCursor(
  now: number,
  lastEmitAt: number,
  idleMs: number = STREAM_CURSOR_IDLE_MS,
): boolean {
  if (!Number.isFinite(lastEmitAt) || lastEmitAt <= 0) { return false; }
  if (!Number.isFinite(idleMs) || idleMs <= 0) { return false; }
  return now - lastEmitAt < idleMs;
}
