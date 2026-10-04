/**
 * gui/src/renderer/pages/subAgentPanel.ts — 子代理悬浮面板「只显示最近几条」的**纯判据**（A-1127）。
 *
 * ## 用户需求（2026-09-26）
 *
 * 原话：「悬浮按钮处的子代理历史调用似乎会一直积累……这个页面似乎**没有增长上限**，
 * 这不行，你设定一个上限，超过这个上限后这个界面就不在增长，开始滚动，
 * 同时**这个界面最多允许 5 个最新的 subAgent 运作历史存在**，设置中的历史记录不受限，
 * 但是设置一个用户可主动选择删除历史记录的选项按钮。」
 *
 * 拆成三条：
 *   ① 悬浮面板**最多显示最近 5 条**（`SUBAGENT_PANEL_LIMIT`）；
 *   ② 面板有高度上限、超出即滚动（组件侧 `maxHeight` + `overflow: auto`；条目上限把常态锁在 5 行内）；
 *   ③ **设置页的历史不受这条限制**（它仍展示落盘的全部历史，上限 100，只靠「清空历史」手动删）——
 *      所以这个常量**只属于悬浮面板**，不要拿它去改 `subagentStore` 的 `SUBAGENT_RUN_CAP`。
 *
 * ## 为什么抽成纯模块
 *
 * "取最后 N 条、新的在最上面"看起来是一行 `slice().reverse()`，但它是**判据**：
 * 一旦有人把 `slice(-n)` 写成 `slice(0, n)`（取最旧的 N 条），界面上表现为
 * "最近跑的子代理不在列表里"——tsc 不报、构建不报，只在用户眼里翻车。
 * 抽出来就能**行为断言**（见 tests/gui/a1127-subagent-panel.spec.ts）。
 *
 * ⚠️ 顺序口径与真源一致：`resident.state().subagents` 由 `mergedSubagentRuns()`
 *   **按 startedAt 升序**给出（旧在前、新在后，见 gui/src/main/subagentStore.ts 的头注释），
 *   所以"最近 5 条"= 数组**尾部** 5 条，展示时再翻成"新的在最上面"。
 *   本模块不依赖时间戳排序 —— 时间戳可能缺失（`startedAt` 可选），
 *   而数组顺序是**真源已经排好的事实**。
 *
 * 本模块**不得**出现 React / JSX / DOM（对齐 insertCopy.ts / streamFade.ts / floatDock.ts 的分家约定）。
 */

/** 悬浮面板最多显示的历史条数（**只作用于悬浮面板**；设置页的历史另有自己的上限） */
export const SUBAGENT_PANEL_LIMIT = 5;

/**
 * 取"最近 `limit` 条"，**新的在最前面**。
 *
 * · 顺序依据 = 数组顺序（真源升序：旧在前）⇒ 取尾部、再反转；
 * · `limit <= 0` / 非有限数 → 空数组（不抛：面板该是"少显示几条"，不是"炸掉"）；
 * · `limit` 大于总数 → 全部条目，仍是新的在前（不补空位）。
 */
export function latestSubagentRuns<T>(runs: readonly T[], limit: number = SUBAGENT_PANEL_LIMIT): T[] {
  if (!Array.isArray(runs) || runs.length === 0) { return []; }
  if (!Number.isFinite(limit) || limit <= 0) { return []; }
  const n = Math.min(Math.floor(limit), runs.length);
  return runs.slice(runs.length - n).reverse();
}

/**
 * 面板标题里那句计数。**唯一出处** —— 免得组件里再拼一遍（两处口径迟早分家）。
 *
 * · 没被截断 → `子代理 (3)`；
 * · 被截断 → `子代理 (5 / 12)`（让用户知道"还有更旧的，去设置里看"，
 *   而不是以为历史被删了 —— 那正是"静默截断"会造成的误读）。
 */
export function subagentPanelCountLabel(total: number, shown: number): string {
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const s = Number.isFinite(shown) && shown > 0 ? Math.floor(shown) : 0;
  return s < t ? `子代理 (${s} / ${t})` : `子代理 (${t})`;
}
