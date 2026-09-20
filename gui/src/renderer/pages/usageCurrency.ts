/**
 * gui/src/renderer/pages/usageCurrency.ts — 账目/报表的**币种归属**判定（A-990 / A-990-B）。
 *
 * **为什么独立成模块**：这段判定原本写在 `UsageStatsPanel.tsx` 里。它是纯函数
 * （输入若干条账目，输出一个币种），但住在 .tsx 里就意味着"要单测它就必须 import 一个
 * React 组件" —— 与本仓库刚修掉的那类耦合（测试 → 组件 → 整个渲染层依赖图）是同一个病。
 * 纯逻辑配一个无 JSX 的模块：面板用它、测试也用它，谁都不用碰对方。
 *
 * 不放进 `shared/gen/model-capabilities.ts` 的原因：那里是"定价真相源"，
 * 服务的是**单价**；而"这笔账该用哪种币显示"是**报表层**的聚合口径，
 * 依赖 `usage.jsonl` 的记录形状（model / provider_key / cost_usd）。
 * 混进真相源会让那个文件同时承担两个不同层次的职责。
 */

import { displayCurrencyForModel, type PriceCurrency } from "../../../../shared/gen/model-capabilities.js";

/** 判定所需的最小记录形状（真实调用方传 `UsageRecord` / `ModelBucket`，都满足） */
export interface CurrencyJudgeRecord {
  model: string;
  /** 供应商 key —— 同一模型 id 在不同中转站可能是两笔不同的账（价格/币种都可能不同） */
  provider_key?: string;
  /** 该条/该组以 USD 记账的成本 */
  cost_usd: number;
}

/**
 * 面板级总账币种：按"这笔钱主要花在**哪个币种**的模型上"判定。
 *
 * 为什么不固定成一个币种：报表会同时统计国内（¥ 账单）与海外（$ 账单）模型，
 * 固定任一边都会让另一边的数字变成"任何官方页面都查不到的折算值"。
 *
 * 为什么不按**请求数**占比：成本差几个数量级时（一次 Opus vs 一百次便宜模型），
 * 请求数会给出误导性的主币种 —— 账目币种应当跟着**钱**走，不是跟着次数走。
 * 为什么不取"最后一个模型"：那会让币种随切模型来回跳，用户看到的是闪烁而不是口径。
 *
 * 平票（各占一半）取 USD：必须有**确定**答案，不能依赖遍历顺序。
 * 成本全为 0 时无法判定 → 也回落 USD（此时界面显示「—」，不涉及金额）。
 *
 * `currencyOf` 由调用方注入：面板传入的判据是"**用户在定价面板手选的币种**优先于归属地推断"
 * （见 `pricingDisplayCurrency`）。不传则退回纯归属地判定，方便单测与旧调用点。
 */
export function ledgerCurrencyOf(
  records: CurrencyJudgeRecord[],
  currencyOf?: (r: CurrencyJudgeRecord) => PriceCurrency,
): PriceCurrency {
  let total = 0, cny = 0;
  for (const r of records) {
    total += r.cost_usd;
    const cur = currencyOf ? currencyOf(r) : displayCurrencyForModel(r.model);
    if (cur === "CNY") { cny += r.cost_usd; }
  }
  // 严格多数才算 CNY：平票取 USD（口径必须确定，不能随记录顺序变）
  return total > 0 && cny > total - cny ? "CNY" : "USD";
}
