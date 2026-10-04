

















import type { PriceCurrency } from "../../../../shared/gen/model-capabilities.js";


export type LedgerCurrencyPref = "auto" | "USD" | "CNY";

export const LEDGER_CURRENCY_STORAGE_KEY = "slime_ledger_currency";









export const LEDGER_CURRENCY_EVENT = "slime:ledger-currency:changed";


export function readLedgerCurrencyPref(): LedgerCurrencyPref {
  try {
    const raw = localStorage.getItem(LEDGER_CURRENCY_STORAGE_KEY);
    if (raw === "USD" || raw === "CNY" || raw === "auto") { return raw; }
  } catch {  }
  return "auto";
}


export function saveLedgerCurrencyPref(pref: LedgerCurrencyPref): LedgerCurrencyPref {
  try {
    localStorage.setItem(LEDGER_CURRENCY_STORAGE_KEY, pref);
  } catch {  }
  try {
    window.dispatchEvent(new CustomEvent<LedgerCurrencyPref>(LEDGER_CURRENCY_EVENT, { detail: pref }));
  } catch {  }
  return pref;
}







export function resolveLedgerCurrency(pref: LedgerCurrencyPref, fallback: PriceCurrency): PriceCurrency {
  return pref === "auto" ? fallback : pref;
}
