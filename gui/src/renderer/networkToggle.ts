/**
 * gui/src/renderer/networkToggle.ts — 「联网搜索」开关的**唯一**读写入口（A-1008）。
 *
 * 为什么单独成模块：这个开关的持久化口径曾经有**两份实现**——
 *   - ChatPanel（主聊天）：`localStorage.getItem(KEY) !== "0"` → 没存过 = **开**
 *   - App.tsx（会话标题/欢迎语流）：`localStorage.getItem(KEY) === "1"` → 没存过 = **关**
 * 用户从没点过开关时，同一个偏好得到两个答案：主聊天开着联网、欢迎语那条流却把
 * `web_search/web_fetch` 静默拒掉。这类"同一个规则两处实现"是本项目反复踩过的坑
 * （见 ref-pricing.md 里取价优先级的事故），所以口径只留一处。
 *
 * 口径：**未显式存过 `"0"` 即视为开**。依据是 A-966 的实测——默认关时工具被静默拒绝，
 * 用户表现为"群聊搜不了"，却看不到任何提示；宁可默认开、用户需要时手动关。
 *
 * 约束：任何新调用点都必须走这里，不许再出现 `slime_network_enabled` 字面量
 * （`tests/core-ts/gui-products.spec.ts` 里有守卫）。
 */

const KEY = "slime_network_enabled";

/** 读开关：未显式存过 "0" 即视为开（localStorage 不可用同样退化为"开"）。 */
export function readNetworkEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

/** 写开关：只写 "1"/"0"（便于人肉排查：`localStorage` 里出现别的值一律按"开"处理）。 */
export function writeNetworkEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* 忽略：隐私模式下写入会抛 */ }
}

/** 存储键名（仅测试与守卫用；业务代码请走上面两个函数）。 */
export const NETWORK_TOGGLE_KEY = KEY;
