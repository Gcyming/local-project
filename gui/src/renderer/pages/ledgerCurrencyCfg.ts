/**
 * gui/src/renderer/pages/ledgerCurrencyCfg.ts —— 「主页实时监测的消费币种」用户偏好（A-990-D）。
 *
 * 用户诉求：「设置的通用栏目里面加一个可以手动选择主页实时监测返回的消费币种。」
 *
 * 为什么需要一个**全局**偏好（此前币种是按"模型所属地 / 用户在定价面板给该模型手选的币种"推的）：
 * 那两个判据回答的是"这个模型的官方价是用哪种币标价的"，对**单价**是正确的；
 * 但"我这台机器上的消耗该用哪种币看"是**观看者**的偏好 —— 我拿人民币账单，
 * 就希望所有消耗都按人民币看，哪怕模型本身是美元计价的海外模型。
 * 两者是不同的东西，所以必须能显式覆盖，而不是继续往推断链上加规则。
 *
 * `auto` = 沿用既有推断（按成本占比 + 用户手选的模型币种），这也是**默认值** ——
 * 没动过这个设置的人，行为与本次改动前**完全一致**。
 *
 * 存在 localStorage（不做落盘配置）：这是**渲染层的观看偏好**，与主题一类的 UI 偏好同级；
 * 放配置文件里会多一轮 IPC 与一次"改完要重启"的负担，而它没有任何跨进程语义。
 * 与 `slime_auto_compress` 同一套约定：localStorage + 自定义事件广播。
 */
import type { PriceCurrency } from "../../../../shared/gen/model-capabilities.js";

/** `auto` = 按模型归属地/成本占比推断；其余为**用户显式指定**的显示币种 */
export type LedgerCurrencyPref = "auto" | "USD" | "CNY";

export const LEDGER_CURRENCY_STORAGE_KEY = "slime_ledger_currency";

/**
 * 变更广播事件。
 *
 * 为什么要有它（而不是让右栏每次重渲染时读一遍）：右栏的会话指标只在数据变化时重渲染，
 * 用户改完设置回到聊天页可能一分钟都不重渲 —— 那时他会看到币种"没生效"，
 * 然后再去改一遍。一次性通知是这类"用户主动设置"的正确传播方式
 * （与 `AUTOCOMPRESS_CFG_EVENT` 同一范式）。
 */
export const LEDGER_CURRENCY_EVENT = "slime:ledger-currency:changed";

/** 读取偏好（配置损坏/未设置 → `auto`） */
export function readLedgerCurrencyPref(): LedgerCurrencyPref {
  try {
    const raw = localStorage.getItem(LEDGER_CURRENCY_STORAGE_KEY);
    if (raw === "USD" || raw === "CNY" || raw === "auto") { return raw; }
  } catch { /* localStorage 不可用（隐私模式/权限）→ 默认 */ }
  return "auto";
}

/** 保存并广播。返回落库后的值，供调用方做乐观 UI。 */
export function saveLedgerCurrencyPref(pref: LedgerCurrencyPref): LedgerCurrencyPref {
  try {
    localStorage.setItem(LEDGER_CURRENCY_STORAGE_KEY, pref);
  } catch { /* 写不进去也不该让设置面板炸：本次会话内 UI 仍会更新（走事件） */ }
  try {
    window.dispatchEvent(new CustomEvent<LedgerCurrencyPref>(LEDGER_CURRENCY_EVENT, { detail: pref }));
  } catch { /* 非浏览器环境（单测）忽略 */ }
  return pref;
}

/**
 * 偏好 → 实际显示币种。`auto` 时用调用方推断出的 `fallback`（成本占比 / 用户手选的模型币种）。
 *
 * 这个函数就是"用户显式选择压过推断"的**唯一落点**：右栏与用量面板都必须调它，
 * 否则会出现"会话指标按 ¥、用量统计按 $"，而那正是本文件存在的理由。
 */
export function resolveLedgerCurrency(pref: LedgerCurrencyPref, fallback: PriceCurrency): PriceCurrency {
  return pref === "auto" ? fallback : pref;
}
