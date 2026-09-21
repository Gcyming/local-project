/**
 * gui/src/renderer/insertModeToggle.ts — 「发新指令时默认怎么插」的**唯一**读写入口。
 *
 * 为什么单独成模块：这是同一类坑的第四次复现 —— 一个偏好在多处各写一遍 `localStorage`
 * 口径，于是"没存过时算哪个"在两处给出不同答案（见 `networkToggle.ts` 头部记录的那次）。
 * 队列面板（徽标切换）与 send()（决定要不要打断）**必须**读同一个来源，
 * 否则会出现"界面显示即将插入、实际却把当前生成掐了"这种最难查的不一致。
 *
 * 口径：**未显式存过时默认「即将插入」**（不打断）。
 * 依据：打断是不可逆的（正在跑的工具循环当场报废），而"多等一会儿"只是慢。
 * 旧行为（A-162）是"一发就打断"，但它从来没给过用户选择；现在默认取**非破坏性**的那一侧，
 * 想打断的人在输入框上方一点即切（并会持久化）。
 *
 * 约束：任何新调用点都必须走这里，不许再出现 `slime_insert_mode` 字面量。
 */

import type { InsertMode } from "./pages/instructionQueue.js";

const KEY = "slime_insert_mode";

/** 读默认插入方式：只认 "interrupt"，其余（未存过 / "queue" / 脏值）一律 "queue"。 */
export function readInsertMode(): InsertMode {
  try { return localStorage.getItem(KEY) === "interrupt" ? "interrupt" : "queue"; } catch { return "queue"; }
}

/** 写默认插入方式（只写两个合法值，便于人肉排查）。 */
export function writeInsertMode(mode: InsertMode): void {
  try { localStorage.setItem(KEY, mode); } catch { /* 忽略：隐私模式下写入会抛 */ }
}

/** 存储键名（仅测试与守卫用；业务代码请走上面两个函数）。 */
export const INSERT_MODE_KEY = KEY;
