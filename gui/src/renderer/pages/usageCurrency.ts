













import { displayCurrencyForModel, type PriceCurrency } from "../../../../shared/gen/model-capabilities.js";


export interface CurrencyJudgeRecord {
  model: string;
  
  provider_key?: string;
  
  cost_usd: number;
}

















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
  
  return total > 0 && cny > total - cny ? "CNY" : "USD";
}
