











import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  inferPricingFromUrl,
  makePriceResolver,
  mergeModelPrice,
  overridesToPriceTiers,
  parseContextTiers,
  parsePricingOverrides,
  parseUpstreamModelItems,
  probeUpstreamTwoPhase,
  newApiConfigMap,
  resolvePrice,
  type ProvidersTable,
} from "../../gui/src/main/providers.js";
import {
  inferModelPricing, resolveEffectivePricing, snapshotVetoReason,
  pricingSnapshotMeta, snapshotPricingInfo, builtInFlatPricing, builtInPriceTiers,
  resolveModelPriceTier,
  USD_CNY_RATE, cnyToUsd, formatPricingAmounts,
  
  vendorRegion, currencyOfRegion, displayCurrencyForModel, convertFromUsd, formatMoney,
  
  pricingDisplayCurrency, officialPriceCurrency, formatAmountsInCurrency, toUsdAmount, formatAmount,
  
  amountInCurrency, classifyProbeOutcome, PROBE_OUTCOME_HINT, inferModelCapabilities,
  
  MODEL_CAPABILITIES, PRICING_VERIFIED_AT, pricingVerifiedAtUnknown,
  
  pricingMatchKind,
} from "../../shared/gen/model-capabilities.js";
import { PRICING_SNAPSHOT } from "../../shared/gen/pricing-snapshot.js";

import { ledgerCurrencyOf } from "../../gui/src/renderer/pages/usageCurrency.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listProviders, saveProvider, setRootOverrideForTest as setProvRoot } from "../../gui/src/main/providers.js";

describe("inferModelPricing（内置家族价目表，单一真相源）", () => {
  it("命中已核实刊例价：DeepSeek pro/flash 都在表内", () => {
    
    
    const pro = inferModelPricing("deepseek-v4-pro");
    expect(pro.priceIn).toBeCloseTo(1.32, 6);
    expect(pro.priceOut).toBeCloseTo(3.96, 6);
    
    const flash = inferModelPricing("deepseek-flash");
    expect(flash.priceIn).toBeCloseTo(0.3, 6);
    expect(flash.priceOut).toBeCloseTo(1.2, 6);
  });

  it("回归：DeepSeek 价格不得再被汇率除一次（0.14/7.25 = 0.0193 是历史脏值）", () => {
    const p = inferModelPricing("deepseek-v4-pro");
    expect(p.priceIn!).toBeGreaterThan(0.5); 
  });

  it("Claude 按档位分档（opus / haiku / sonnet 不同价）", () => {
    
    expect(inferModelPricing("claude-opus-4-1").priceIn).toBeCloseTo(15, 6);
    
    expect(inferModelPricing("claude-3-5-haiku").priceIn).toBeCloseTo(0.8, 6);
    
    expect(inferModelPricing("claude-haiku-4-5").priceIn).toBeCloseTo(1, 6);
    expect(inferModelPricing("claude-haiku-4-5").priceOut).toBeCloseTo(5, 6);
    expect(inferModelPricing("claude-sonnet-4-20250514").priceIn).toBeCloseTo(3, 6);
    
    expect(inferModelPricing("claude-opus-4-6").priceIn).toBeCloseTo(5, 6);
    expect(inferModelPricing("claude-opus-4-6").priceOut).toBeCloseTo(25, 6);
    
    expect(inferModelPricing("claude-sonnet-5").priceIn).toBeCloseTo(2, 6);
  });

  it("回归：agnes 免费档只覆盖 flash，付费档不能被写成 0", () => {
    
    const pro = inferModelPricing("agnes-2.5-pro");
    expect(pro.priceIn).toBeCloseTo(0.45, 6);
    expect(pro.priceOut).toBeCloseTo(0.9, 6);
    const beta = inferModelPricing("agnes-2.5-pro-beta");
    expect(beta.priceIn).toBeCloseTo(0.1, 6);
    
    const flash = inferModelPricing("agnes-3.0-flash");
    expect(flash.priceIn).toBe(0);
    expect(flash.priceOut).toBe(0);
  });

  it("回归：GLM **免费档三兄弟**必须各自成条，且排在宽泛的付费条目之前", () => {
    
    
    
    
    for (const id of ["glm-4-flash", "glm-4.5-flash", "glm-4.7-flash", "glm-4.6v-flash"]) {
      const p = inferModelPricing(id);
      
      expect(p.priceIn, id).toBe(0);
      expect(p.priceOut, id).toBe(0);
    }
    
    const flashx = inferModelPricing("glm-4.7-flashx");
    expect(flashx.priceInCny).toBe(0.5);
    expect(flashx.priceOutCny).toBe(3);
    const paid53 = inferModelPricing("glm-5.3-flash");
    expect(paid53.priceInCny).toBe(0.8);
    expect(paid53.priceOutCny).toBe(2.8);
    expect(paid53.priceIn).toBeGreaterThan(0);
  });

  it("GLM 价格以**官方人民币原价**存放，USD 是折算值（$ 与 ¥ 分开）", () => {
    const p = inferModelPricing("glm-5.3");
    
    expect(p.priceInCny).toBe(8);
    expect(p.priceOutCny).toBe(28);
    expect(p.priceCacheReadCny).toBe(2);
    
    expect(p.priceIn).toBeCloseTo(cnyToUsd(8), 9);
    expect(p.priceOut).toBeCloseTo(cnyToUsd(28), 9);
    expect(p.usdDerivedFromCny).toBe(true);
    
    
    expect(p.priceIn).not.toBeCloseTo(1.4, 2);
  });

  it("$ 与 ¥ 的展示必须分开：官方人民币原价为主，折算值必须带 ≈", () => {
    
    const glm = formatPricingAmounts(inferModelPricing("glm-5.3"));
    expect(glm).toContain("¥8 / ¥28");
    expect(glm).toContain("≈$");
    
    const gpt = formatPricingAmounts(inferModelPricing("gpt-4o"));
    expect(gpt?.startsWith("$")).toBe(true);
    expect(gpt).not.toContain("¥");
    expect(inferModelPricing("gpt-4o").priceInCny).toBeUndefined();
    expect(inferModelPricing("gpt-4o").usdDerivedFromCny).toBeUndefined();
    
    expect(formatPricingAmounts(inferModelPricing("glm-4.7-flash"))).toContain("¥0");
  });

  it("折算率只有一个出处：USD_CNY_RATE，且任何带 ¥ 原价的条目都必须精确等于它的折算", () => {
    
    
    expect(USD_CNY_RATE).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5", "glm-5.1", "glm-4.7", "glm-4.7-flashx", "glm-4.5-air", "glm-4.6v"]) {
      const p = inferModelPricing(id);
      if (p.priceInCny === undefined) { bad.push(`${id}: 缺 priceInCny`); continue; }
      if (p.priceIn !== cnyToUsd(p.priceInCny)) { bad.push(`${id}: priceIn ${p.priceIn} ≠ ${cnyToUsd(p.priceInCny)}`); }
      if (p.usdDerivedFromCny !== true) { bad.push(`${id}: 未标记 usdDerivedFromCny`); }
    }
    expect(bad).toEqual([]);
  });

  it("DeepSeek：官方同时公布 $ 与 ¥ 两列 → 两列都存，**不得**互相折算（美元列是官方价）", () => {
    
    
    
    const pro = inferModelPricing("deepseek-v4-pro");
    expect(pro.priceIn).toBeCloseTo(1.32, 9);
    expect(pro.priceInCny).toBe(9);
    expect(pro.priceOutCny).toBe(27);
    expect(pro.priceCacheReadCny).toBe(0.3);
    expect(pro.usdDerivedFromCny).toBeUndefined();
    
    expect(pro.priceIn).not.toBeCloseTo(cnyToUsd(9), 2);
    
    const peak = resolveModelPriceTier("deepseek-flash");
    expect(peak.pricing.priceIn).toBeCloseTo(0.3, 9);
    expect(peak.pricing.priceInCny).toBe(2);
    expect(peak.pricing.priceOutCny).toBe(8);
  });

  it("DeepSeek V4 Pro 必须保持**自己的档位价**：官方已撤回\"Pro 路由到 Flash 计费\"的公告", () => {
    
    
    
    const peak = resolveModelPriceTier("deepseek-v4-pro", new Date("2026-09-16T02:30:00Z")); 
    expect(peak.tierId).toBe("peak");
    expect(peak.pricing.priceIn).toBeCloseTo(1.32, 9);
    expect(peak.pricing.priceOut).toBeCloseTo(3.96, 9);
    const flashAtSameMoment = resolveModelPriceTier("deepseek-flash", new Date("2026-09-16T02:30:00Z"));
    expect(peak.pricing.priceIn).toBeGreaterThan(flashAtSameMoment.pricing.priceIn!);
  });

  

















  it("DeepSeek V4.1-Flash（现行 deepseek-flash）必须是 09-10 之后的降价档，不得写成退休版 V4-Flash 的价", () => {
    const peak = resolveModelPriceTier("deepseek-flash", new Date("2026-09-18T02:00:00Z")); 
    const off = resolveModelPriceTier("deepseek-flash", new Date("2026-09-18T20:00:00Z"));  
    expect(peak.tierId).toBe("peak");
    expect(off.tierId).toBe("offpeak");
    
    expect(peak.pricing.priceIn).toBeCloseTo(0.3, 9);
    expect(peak.pricing.priceOut).toBeCloseTo(1.2, 9);
    expect(peak.pricing.priceCacheRead).toBeCloseTo(0.006, 9);
    expect(off.pricing.priceIn).toBeCloseTo(0.15, 9);
    expect(off.pricing.priceOut).toBeCloseTo(0.6, 9);
    expect(off.pricing.priceCacheRead).toBeCloseTo(0.003, 9);
    
    expect(peak.pricing.priceInCny).toBe(2);
    expect(peak.pricing.priceOutCny).toBe(8);
    expect(peak.pricing.priceCacheReadCny).toBeCloseTo(0.04, 9);
    expect(off.pricing.priceInCny).toBe(1);
    expect(off.pricing.priceOutCny).toBe(4);
    
    expect(peak.pricing.priceIn).not.toBeCloseTo(0.44, 6);
    expect(peak.pricing.priceOut).not.toBeCloseTo(1.32, 6);
    
    
    expect(off.pricing.priceIn).toBeCloseTo((peak.pricing.priceIn ?? NaN) / 2, 12);
    expect(off.pricing.priceOut).toBeCloseTo((peak.pricing.priceOut ?? NaN) / 2, 12);
  });

  it("DeepSeek 高峰窗口 = UTC 01:00-04:00 / 06:00-10:00 的工作日（= 北京 9-12、14-18）", () => {
    
    
    const at = (iso: string): string | undefined => resolveModelPriceTier("deepseek-flash", new Date(iso)).tierId;
    expect(at("2026-09-18T01:30:00Z"), "UTC 01:30 = 北京周五 09:30").toBe("peak");
    expect(at("2026-09-18T06:30:00Z"), "UTC 06:30 = 北京周五 14:30").toBe("peak");
    expect(at("2026-09-18T04:30:00Z"), "UTC 04:30 = 北京周五 12:30（午休）").toBe("offpeak");
    expect(at("2026-09-18T10:30:00Z"), "UTC 10:30 = 北京周五 18:30（已过高峰）").toBe("offpeak");
    expect(at("2026-09-19T01:30:00Z"), "同一 UTC 时刻的周六必须空闲").toBe("offpeak");
  });

  it("小红书 dots 为官方限时免费 → 0，不是 undefined", () => {
    const p = inferModelPricing("dots3-note-prev");
    expect(p.priceIn).toBe(0);
    expect(p.priceOut).toBe(0);
  });

  it("未核实刊例价的厂商 → 返回 {}（宁缺勿造，UI 会显示「未定价」让用户手填）", () => {
    
    
    expect(inferModelPricing("zz-unlisted-model-xyz")).toEqual({});
    expect(inferModelPricing("")).toEqual({});
  });

  it("A-989 权威快照：内置表未定价的长尾家族由快照补价（消灭\"用户必须逐个手填\"）", () => {
    
    for (const id of ["kimi-k2", "qwen3.7-max", "glm-5", "minimax-m2.5", "grok-4.5", "mistral-large-latest"]) {
      const p = inferModelPricing(id);
      expect(p.priceIn, id).toBeGreaterThan(0);
      expect(p.priceOut, id).toBeGreaterThan(0);
    }
  });

  it("A-989 快照抑制表：退休别名不得被快照的旧价覆盖（deepseek-chat → 按 V4.1-Flash 价）", () => {
    
    
    for (const id of ["deepseek-chat", "deepseek-reasoner"]) {
      const p = inferModelPricing(id);
      expect(p.priceIn, id).toBeCloseTo(0.3, 9);
      expect(p.priceOut, id).toBeCloseTo(1.2, 9);
    }
    expect(snapshotVetoReason("deepseek-chat")).toBeTruthy();
    expect(snapshotVetoReason("deepseek-v4-flash")).toBeUndefined();
  });

  it("非对话模型（embedding/rerank/图像）不参与 token 定价", () => {
    const p = inferModelPricing("text-embedding-3-large");
    expect(p.priceIn).toBeUndefined();
  });

  it("A-989 手写表与权威快照**不得冲突**（冲突必须先在表里修掉或显式加抑制）", () => {
    
    
    
    
    
    
    
    const conflicts: string[] = [];
    for (const e of PRICING_SNAPSHOT) {
      const built = builtInFlatPricing(e.id);
      if (typeof built.priceIn !== "number") { continue; }   
      if (snapshotVetoReason(e.id)) { continue; }            
      
      
      if (builtInPriceTiers(e.id)) { continue; }
      const same = built.priceIn === e.priceIn
        && (built.priceOut ?? built.priceIn) === (e.priceOut ?? e.priceIn);
      if (!same) {
        conflicts.push(`${e.id}: 手写表 ${built.priceIn}/${built.priceOut} vs 快照 ${e.priceIn}/${e.priceOut}`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("A-989 生效价的 origin 必须自报家门：快照兜底 ≠ 内置表（界面不许撒谎）", () => {
    
    
    
    const eff = resolveEffectivePricing("kimi-k2", "https://api.moonshot.cn/v1");
    expect(eff.origin).toBe("snapshot");
    expect(eff.tiered).toBe(false);
    expect(eff.priceIn).toBeGreaterThan(0);
    
    expect(resolveEffectivePricing("claude-opus-4-20250514", "https://api.anthropic.com/v1").origin).toBe("table");
    expect(resolveEffectivePricing("gpt-4o-2024-05-13", "https://api.openai.com/v1").origin).toBe("table");
    
    expect(resolveEffectivePricing("chatgpt-4o-latest", "https://api.openai.com/v1").priceIn).toBe(2.5);
    
    expect(resolveEffectivePricing("deepseek-v4-flash", "https://api.deepseek.com/v1").origin).toBe("table");
    expect(resolveEffectivePricing("deepseek-v4-flash", "https://api.deepseek.com/v1", undefined, new Date("2026-09-16T02:30:00Z")).origin).toBe("tier");
  });

  it("A-989 两处「一个正则表达两代价」的实测错价已修正（权威双源交叉印证）", () => {
    
    expect(inferModelPricing("gpt-4o-2024-05-13").priceIn).toBeCloseTo(5, 9);
    expect(inferModelPricing("gpt-4o-2024-05-13").priceOut).toBeCloseTo(15, 9);
    expect(inferModelPricing("gpt-4o").priceIn).toBeCloseTo(2.5, 9);
    expect(inferModelPricing("gpt-4o-2024-08-06").priceIn).toBeCloseTo(2.5, 9);
    
    expect(inferModelPricing("claude-3-haiku-20240307").priceIn).toBeCloseTo(0.25, 9);
    expect(inferModelPricing("claude-3-haiku-20240307").priceOut).toBeCloseTo(1.25, 9);
    expect(inferModelPricing("claude-3-5-haiku-20241022").priceIn).toBeCloseTo(0.8, 9);
  });

  it("A-989 快照元信息可读（时效性是底线 → 生成日期必须能被界面取到）", () => {
    const meta = pricingSnapshotMeta();
    expect(meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.count).toBeGreaterThan(100);
    expect(meta.litellmUrl).toContain("litellm");
    expect(meta.openrouterUrl).toContain("openrouter");
  });

  it("A-989 单模型快照详情：出处 / 长上下文分档 / 抑制原因都能拿到", () => {
    const hit = snapshotPricingInfo("claude-sonnet-4-5-20250929")!;
    expect(hit.source).toBe("litellm");
    
    expect(hit.contextTiers?.length).toBeGreaterThan(0);
    expect(hit.contextTiers![0].fromInputTokens).toBeGreaterThanOrEqual(200000);
    expect(hit.vetoReason).toBeUndefined();
    
    expect(snapshotPricingInfo("claude-sonnet-4-5-20991231")!.snapshotId).toBe("claude-sonnet-4-5");
    
    const vetoed = snapshotPricingInfo("deepseek-chat")!;
    expect(vetoed.vetoReason).toBeTruthy();
    
    expect(snapshotPricingInfo("zz-unlisted-model-xyz")).toBeUndefined();
  });
});

describe("resolvePrice（优先级：手填 > 上游 > 内置表 > 历史残留）", () => {
  it("手填价永不被覆盖", () => {
    expect(resolvePrice(7, true, 1, 2)).toEqual({ value: 7, source: "manual" });
  });

  it("上游价次之", () => {
    expect(resolvePrice(undefined, false, 1.5, 2)).toEqual({ value: 1.5, source: "upstream" });
  });

  it("上游显式给 0 = 官方声明免费，必须采纳（不得回落到内置表非零价）", () => {
    
    
    
    
    
    
    
    
    expect(resolvePrice(undefined, false, 0, 2)).toEqual({ value: 0, source: "upstream" });
    
    expect(resolvePrice(undefined, false, 0, undefined)).toEqual({ value: 0, source: "upstream" });
    
    expect(resolvePrice(undefined, false, undefined, 2)).toEqual({ value: 2, source: "table" });
  });

  it("上游 0 也不能被内置表压成非零（本地端点场景：http://127.0.0.1 别名到官方模型名）", () => {
    
    
    expect(resolvePrice(undefined, false, 0, 1.32).value).toBe(0);
    expect(resolvePrice(0.0193, false, 0, 1.32)).toEqual({ value: 0, source: "upstream" });
  });

  it("上游给 0 也**不能**压过手填价（手填仍是最高优先级）", () => {
    expect(resolvePrice(5, true, 0, 2)).toEqual({ value: 5, source: "manual" });
  });

  it("两种 0 必须分开对待 —— 这是「改 resolvePrice 到底安不安全」的判据", () => {
    






    
    const m = newApiConfigMap({ model_ratio: { broken: 0, ok: 1.25 } });
    expect(m.get("broken"), "model_ratio=0 的条目必须被跳过，不得变成价格 0").toBeUndefined();
    
    expect(m.get("ok")?.pricing?.prompt).toBe(2.5);
    
    expect(resolvePrice(undefined, false, m.get("broken")?.pricing?.prompt, 2))
      .toEqual({ value: 2, source: "table" });

    
    expect(resolvePrice(undefined, false, 0, 2)).toEqual({ value: 0, source: "upstream" });
  });

  it("内置表再次（含 0 = 免费）", () => {
    expect(resolvePrice(undefined, false, undefined, 0)).toEqual({ value: 0, source: "table" });
  });

  it("历史残留垫底：打破「错值自杀锁」——新表有价时必须压过已存的脏值", () => {
    
    expect(resolvePrice(0.0193, false, undefined, 1.32)).toEqual({ value: 1.32, source: "table" });
    
    expect(resolvePrice(0.0193, false, undefined, undefined)).toEqual({ value: 0.0193, source: undefined });
  });

  it("全空 → {}", () => {
    expect(resolvePrice(undefined, false, undefined, undefined)).toEqual({});
  });
});

describe("mergeModelPrice（一键刷新时保护手填价）", () => {
  it("prev 是手填 → 整组保留 prev，探测结果被丢弃", () => {
    const prev = { price_in_usd: 7, price_out_usd: 8, price_source: "manual" as const };
    const out = mergeModelPrice(prev, { price_in_usd: 1, price_out_usd: 2, price_source: "table" as const });
    expect(out.price_in_usd).toBe(7);
    expect(out.price_out_usd).toBe(8);
    expect(out.price_source).toBe("manual");
  });

  it("回归：探测到 0（官方限时免费）必须覆盖旧的非零价，不能把 0 当「没有值」", () => {
    
    const prev = { price_in_usd: 3, price_out_usd: 15, price_source: "table" as const };
    const out = mergeModelPrice(prev, { price_in_usd: 0, price_out_usd: 0, price_source: "upstream" as const });
    expect(out.price_in_usd).toBe(0);
    expect(out.price_out_usd).toBe(0);
    expect(out.price_source).toBe("upstream");
  });

  it("探测没给值 → 保留旧值，不丢用户数据", () => {
    const prev = { price_in_usd: 3, price_out_usd: undefined, price_source: "table" as const };
    const out = mergeModelPrice(prev, { price_in_usd: undefined, price_out_usd: 15 });
    expect(out.price_in_usd).toBe(3);
    expect(out.price_out_usd).toBe(15);
    expect(out.price_source).toBe("table");
  });

  it("无 prev（首次保存）→ 原样采用 next", () => {
    const out = mergeModelPrice(undefined, { price_in_usd: 1, price_out_usd: 2, price_source: "table" });
    expect(out).toEqual({ price_in_usd: 1, price_out_usd: 2, price_source: "table" });
  });
});

describe("inferPricingFromUrl（本地端点免费 + 委托内置表）", () => {
  it("本地 / 内网推理端点 → 显式 0（免费而非未定价）", () => {
    expect(inferPricingFromUrl("http://localhost:11434/v1", "any-model").price_in_usd).toBe(0);
    expect(inferPricingFromUrl("http://127.0.0.1:8080", "any-model").price_in_usd).toBe(0);
    expect(inferPricingFromUrl("http://192.168.1.20:8000/v1", "any-model").price_in_usd).toBe(0);
  });

  it("回归：任意自建网关/中转站不再一律无价（旧表只认十几个域名）", () => {
    const t = inferPricingFromUrl("https://my-private-gateway.example.com/v1", "deepseek-flash");
    expect(t.price_in_usd).toBeCloseTo(0.3, 6); 
  });

  it("表里查不到的模型 → undefined（未定价，交给用户手填）", () => {
    const t = inferPricingFromUrl("https://api.moonshot.cn/v1", "zz-unlisted-model-xyz");
    expect(t.price_in_usd).toBeUndefined();
  });

  it("A-989：内置表未定价但快照有价 → 由快照补上（kimi 不再要求用户手填）", () => {
    const t = inferPricingFromUrl("https://api.moonshot.cn/v1", "kimi-k2");
    expect(t.price_in_usd).toBeGreaterThan(0);
    expect(t.price_out_usd).toBeGreaterThan(0);
  });
});

describe("makePriceResolver（历史成本回填的取价器）", () => {
  const table: ProvidersTable = {
    deepseek: {
      api_base: "https://api.deepseek.com",
      api_key: "sk-x",
      models: [
        
        { id: "deepseek-v4-pro", price_in_usd: 0.0193, price_out_usd: 0.0386 },
        
        { id: "deepseek-chat", price_in_usd: 9, price_out_usd: 9, price_source: "manual" },
        
        { id: "deepseek-reasoner", price_in_usd: 4, price_out_usd: 4, price_source: "upstream" },
      ],
    },
    agnes: {
      api_base: "https://api.agnes-ai.cn/v1",
      api_key: "sk-y",
      models: [{ id: "agnes-3.0-flash" }],
    },
    _local_models: { api_base: "", api_key: "", models: [{ id: "local-3b", price_in_usd: 999, price_out_usd: 999 }] },
  };

  it("无 price_source 的历史脏值 → 用修好的内置表纠正，而不是沿用错值", () => {
    const p = makePriceResolver(table)("deepseek", "deepseek-v4-pro");
    expect(p?.priceIn).toBeCloseTo(1.32, 6);
    expect(p?.priceOut).toBeCloseTo(3.96, 6);
  });

  it("手填 / 上游价直接采信（用户议价、网关真实结算价）", () => {
    const resolve = makePriceResolver(table);
    expect(resolve("deepseek", "deepseek-chat")?.priceIn).toBe(9);
    expect(resolve("deepseek", "deepseek-reasoner")?.priceIn).toBe(4);
  });

  it("免费模型 → 返回 0（回填后成本仍为 0，是正确的，不是失败）", () => {
    const p = makePriceResolver(table)("agnes", "agnes-3.0-flash");
    expect(p?.priceIn).toBe(0);
    expect(p?.priceOut).toBe(0);
  });

  it("_local_models 这类元数据键不当供应商处理", () => {
    expect(makePriceResolver(table)("_local_models", "local-3b")).toBeUndefined();
  });

  it("供应商已从表里删除 → 仍按模型 ID 走价目表，历史账目保持可读", () => {
    const p = makePriceResolver(table)("已删除的供应商", "deepseek-flash");
    expect(p?.priceIn).toBeCloseTo(0.3, 6);
  });

  it("彻底查不到（模型不在表也不在价目表）→ undefined，回填跳过", () => {
    expect(makePriceResolver(table)("mystery", "unknown-model-xyz")).toBeUndefined();
  });
});

describe("parseUpstreamModelItems（上游字段名各家不一）", () => {
  it("回归：上下文窗口要读多种字段名（只读 context_length 会让探针整体白跑）", () => {
    const cases: Array<Record<string, unknown>> = [
      { id: "m1", context_length: 512000 },
      { id: "m2", context_window: 512000 },
      { id: "m3", max_context_length: 512000 },
      { id: "m4", context_size: 512000 },
      { id: "m5", max_input_tokens: 512000 },
      { id: "m6", top_provider: { context_length: 512000 } },
      { id: "m7", model_info: { context_length: 512000 } },
    ];
    const map = parseUpstreamModelItems(cases);
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]) {
      expect(map.get(id)?.context_length, `${id} 应解析出 512000`).toBe(512000);
    }
  });

  it("new-api 系用 model_name 而非 id", () => {
    const map = parseUpstreamModelItems([{ model_name: "deepseek-v4-flash", model_ratio: 0.1125 }]);
    expect(map.has("deepseek-v4-flash")).toBe(true);
    
    expect(map.get("deepseek-v4-flash")?.pricing?.prompt).toBeCloseTo(0.225, 6);
    expect(map.get("deepseek-v4-flash")?.pricing?.completion).toBeCloseTo(0.225, 6);
  });

  it("quota_type=1（按次计费：图像/音乐/视频）的 model_price 不当 token 价使用", () => {
    const map = parseUpstreamModelItems([{ model_name: "dall-e-3", model_ratio: 0.02, quota_type: 1 }]);
    expect(map.get("dall-e-3")?.pricing).toBeUndefined();
  });

  it("cache_ratio / create_cache_ratio 从 prompt 价派生缓存单价", () => {
    const map = parseUpstreamModelItems([{
      model_name: "m", model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.25, create_cache_ratio: 1.25,
    }]);
    const p = map.get("m")?.pricing;
    expect(p?.prompt).toBeCloseTo(1, 6); 
    expect(p?.completion).toBeCloseTo(2, 6);
    expect(p?.promptCacheRead).toBeCloseTo(0.25, 6); 
    expect(p?.promptCacheCreate).toBeCloseTo(1.25, 6);
  });
});

describe("A-988d：上游定价字段探针表（覆盖各家厂商的命名）", () => {
  const one = (item: Record<string, unknown>) => parseUpstreamModelItems([item]).get(String(item.id ?? item.model_name))?.pricing;

  it("单位三分法：per-token（×1e6）/ per-1M（直接用）/ auto（值域判定）", () => {
    
    expect(one({ id: "a", input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "b", input_cost_per_1m_tokens: 3, output_cost_per_1m_tokens: 15 })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "c", input_cost_per_million_tokens: 3 })?.prompt).toBeCloseTo(3, 9);
    
    expect(one({ id: "d", pricing: { prompt: "0.000003", completion: "0.000015" } })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "d", pricing: { prompt: "0.000003", completion: "0.000015" } })?.completion).toBeCloseTo(15, 9);
    
    expect(one({ id: "e", input_price: 3 })?.prompt).toBeCloseTo(3, 9);
  });

  it("金额字符串的可读写法也要能读（`$0.000003` / `0.000003 USD`）", () => {
    expect(one({ id: "a", pricing: { prompt: "$0.000003" } })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "b", pricing: { prompt: "0.000003 USD" } })?.prompt).toBeCloseTo(3, 9);
    expect(one({ id: "c", prompt_price: "$3 /1M" })?.prompt).toBeCloseTo(3, 9);
    
    expect(one({ id: "d", pricing: { prompt: "免费" } })).toBeUndefined();
  });

  it("0 是「官方限时免费」，必须如实返回 0 而不是被当成没给", () => {
    const p = one({ id: "free", pricing: { prompt: "0", completion: "0" } });
    expect(p?.prompt).toBe(0);
    expect(p?.completion).toBe(0);
  });

  it("缓存命中价：OpenRouter / LiteLLM / 自建三种命名都要读到", () => {
    
    expect(one({ id: "a", pricing: { prompt: "0.000003", input_cache_read: "0.0000003" } })?.promptCacheRead).toBeCloseTo(0.3, 9);
    expect(one({ id: "b", pricing: { prompt: "0.000003" }, cache_read_input_token_cost: 0.0000003 })?.promptCacheRead).toBeCloseTo(0.3, 9);
    expect(one({ id: "c", pricing: { prompt: "0.000003" }, cached_input_price: 0.3 })?.promptCacheRead).toBeCloseTo(0.3, 9);
  });

  it("缓存写入价：5 分钟档与 1 小时档必须**分开**（差 1.6 倍，合并会让长 TTL 少记 37%）", () => {
    const p = one({
      id: "a",
      pricing: { prompt: "0.000003", input_cache_write: "0.00000375", input_cache_write_1h: "0.000006" },
    });
    expect(p?.promptCacheCreate).toBeCloseTo(3.75, 9);
    expect(p?.promptCacheWrite1h).toBeCloseTo(6, 9);
    
    const only1h = one({ id: "b", pricing: { prompt: "0.000003" }, cache_write_1h_cost: 6 });
    expect(only1h?.promptCacheWrite1h).toBeCloseTo(6, 9);
    expect(only1h?.promptCacheCreate).toBeUndefined();
  });

  it("乘数型缓存字段（new-api/one-api）保留 0（显式「不收费」不得被 `> 0` 过滤掉）", () => {
    const p = one({ model_name: "m", model_ratio: 0.5, cache_ratio: 0.1, create_cache_ratio: 0 });
    expect(p?.prompt).toBeCloseTo(1, 9);
    expect(p?.promptCacheRead).toBeCloseTo(0.1, 9);
    expect(p?.promptCacheCreate).toBe(0);
  });

  it("OpenRouter `pricing.overrides[]` → 采集时段档（含跨午夜与字符串星期）", () => {
    const ov = parsePricingOverrides([
      { utc_start: 1600, utc_end: 600, utc_days: ["Monday", "tue", "WED"], prompt: "0.000001" },
      { min_prompt_tokens: 200000, prompt: "0.000009" },   
      { prompt: "0.000002" },                              
      { utc_start: 900, utc_end: 900, prompt: "0.000003" }, 
    ])!;
    expect(ov).toHaveLength(2);
    expect(ov[0].utcStart).toBe(16 * 60);
    expect(ov[0].utcEnd).toBe(6 * 60);
    expect(ov[0].utcDays).toEqual([1, 2, 3]);
    expect(ov[0].prompt).toBeCloseTo(1, 9);
    expect(ov[1].minPromptTokens).toBe(200000);
  });

  it("时段字段是 **HHMM**（不是分钟数）：`800` = 08:00，`480` 是「4:80」→ 必须判为非法而丢弃", () => {
    
    
    const ov = parsePricingOverrides([{ utc_start: 0, utc_end: 800, prompt: "0.000001" }])!;
    expect(ov[0].utcStart).toBe(0);
    expect(ov[0].utcEnd).toBe(8 * 60);
    
    const bad = parsePricingOverrides([{ utc_start: 0, utc_end: 480, prompt: "0.000001" }])!;
    expect(bad[0].utcStart).toBe(0);
    expect(bad[0].utcEnd).toBeUndefined();
    
    expect(parsePricingOverrides([{ utc_start: "16:00", utc_end: "06:00", prompt: "0.000001" }])![0].utcStart).toBe(960);
    expect(parsePricingOverrides([{ utc_start: "1600", utc_end: "0600", prompt: "0.000001" }])![0].utcEnd).toBe(360);
  });

  it("上游时段档转成分时规格：时区标 UTC + 必补兜底档（否则非命中时段会凭空多收）", () => {
    const ov = parsePricingOverrides([{ utc_start: 1600, utc_end: 600, prompt: "0.000001" }])!;
    const spec = overridesToPriceTiers(ov, 3, 15)!;
    expect(spec.timezone).toBe("UTC");
    
    const base = spec.tiers.find((t) => t.id === "base")!;
    expect(base.priceIn).toBe(3);
    expect(base.priceOut).toBe(15);
    expect(base.windows).toEqual([]);
    
    expect(spec.tiers[0].windows![0].startMin).toBe(16 * 60);
    expect(spec.tiers[0].windows![0].endMin).toBe(6 * 60);
  });

  it("上游时段档可以被用户导入后直接生效（导入 = price_tiers，且立刻参与取价）", () => {
    
    const ov = parsePricingOverrides([{ utc_start: 0, utc_end: 800, prompt: "0.000001" }])!;
    const spec = overridesToPriceTiers(ov, 3, 15)!;
    
    const hit = resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T03:00:00Z");
    expect(hit.origin).toBe("customTier");
    expect(hit.priceIn).toBeCloseTo(1, 9);
    
    const miss = resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T12:00:00Z");
    expect(miss.priceIn).toBe(3);
    
    expect(resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T08:00:00Z").priceIn).toBe(3);
    expect(resolveEffectivePricing("zz-unknown-model", "https://gw.example.com/v1", { price_tiers: spec }, "2026-09-16T00:00:00Z").priceIn).toBe(1);
  });

  it("上下文长度分档：LiteLLM 后缀形态与 one-api 数组形态都要采集到", () => {
    
    const litellm = parseContextTiers({
      input_cost_per_token_above_200k_tokens: 0.000006,
      output_cost_per_token_above_200k_tokens: 0.000018,
      input_cost_per_1m_tokens_above_128k_tokens: 4,
    })!;
    expect(litellm).toHaveLength(2);
    const t200 = litellm.find((t) => t.fromInputTokens === 200000)!;
    expect(t200.prompt).toBeCloseTo(6, 9);
    expect(t200.completion).toBeCloseTo(18, 9);
    expect(litellm.find((t) => t.fromInputTokens === 128000)!.prompt).toBeCloseTo(4, 9);
    
    const oneApi = parseContextTiers({
      tiers: [{ input_token_threshold: 200000, input_cost_per_million_tokens: 6, output_cost_per_million_tokens: 18 }],
    })!;
    expect(oneApi[0].fromInputTokens).toBe(200000);
    expect(oneApi[0].prompt).toBeCloseTo(6, 9);
    expect(oneApi[0].completion).toBeCloseTo(18, 9);
    
    expect(parseContextTiers({ id: "x" })).toBeUndefined();
  });

  it("按次/按张计费的单价被单独采集（不混进 token 价，但 UI 要能提示）", () => {
    const p = one({ id: "gpt-image", pricing: { prompt: "0.000005", request: "0.04", image: "0.02", web_search: "0.01" } })!;
    expect(p.perRequest?.request).toBeCloseTo(0.04, 9);
    expect(p.perRequest?.image).toBeCloseTo(0.02, 9);
    expect(p.perRequest?.webSearch).toBeCloseTo(0.01, 9);
    
    expect(p.prompt).toBeCloseTo(5, 9);
  });

  it("上游折扣字段原样带上（`discount` 是比例，不是单价，绝不能乘进 prompt）", () => {
    const p = one({ id: "a", pricing: { prompt: "0.000003", discount: "0.5" } })!;
    expect(p.discount).toBeCloseTo(0.5, 9);
    expect(p.prompt).toBeCloseTo(3, 9);
  });
});

describe("A-988d 源码守卫：探针采集到的信息必须真的能被看见与使用", () => {
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const readSrc = (rel: string): string => strip(readFileSync(join(process.cwd(), rel), "utf8"));

  it("探针必须走字段表（新增一家厂商 = 追加一行，而不是再拼一条 ?? 链）", () => {
    
    
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain("const UPSTREAM_PRICE_FIELDS");
    expect(src).toContain("const CACHE_RATIO_FIELDS");
    expect(src).toContain("function parseUsdPerMillion");
    
    for (const slot of ["prompt", "completion", "cacheRead", "cacheWrite", "cacheWrite1h"]) {
      expect(src, `字段表缺槽位 ${slot}`).toContain(`slot: "${slot}"`);
    }
    
    expect(src).toContain("for (const f of UPSTREAM_PRICE_FIELDS)");
    expect(src).toContain("for (const f of CACHE_RATIO_FIELDS)");
  });

  it("采集结果必须落库（timeOverrides / contextTiers / perRequest 一个都不能只活在内存里）", () => {
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain("pricing_time_tiers_candidate:");
    expect(src).toContain("pricing_context_tiers:");
    expect(src).toContain("pricing_per_request:");
    
    expect(src).toContain("overridesToPriceTiers(timeOv,");
  });

  it("采集结果必须在面板上可见 —— 采集而不展示 = 没采集", () => {
    
    
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(panel).toContain("function UpstreamPricingHints");
    
    expect(panel).toContain("m.pricing_time_tiers_candidate");
    expect(panel).toContain("m.pricing_context_tiers");
    expect(panel).toContain("m.pricing_per_request");
    
    expect(panel).toContain("导入上游时段");
    
    expect(panel).toContain("不参与计费");
    expect(panel).toContain("不计入 token 账目");
    
    const editorStart = panel.indexOf("function TierEditor");
    const hintsInEditor = panel.slice(editorStart, editorStart + 3000);
    expect(hintsInEditor).toContain("UpstreamPricingHints");
  });

  it("HHMM 时段字段必须做合法性校验（`480` 是「4:80」而不是 08:00）", () => {
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain("function hhmmToMinute");
    
    expect(src).toMatch(/m\s*>\s*59/);
  });
});

describe("probeUpstreamTwoPhase（两阶段探测：阶段 2 不能被阶段 1 短路）", () => {
  
  function fakeUpstream(routes: Record<string, unknown>, seen: string[]) {
    return async (url: string): Promise<{ data?: unknown } | null> => {
      seen.push(url);
      const hit = Object.keys(routes).find((k) => url.endsWith(k));
      if (!hit) { return null; }
      return routes[hit] as { data?: unknown };
    };
  }

  it("回归（事故根因）：/v1/models 返回 200 但没有 pricing 时，仍必须去 /api/pricing 取价", async () => {
    const seen: string[] = [];
    const getJson = fakeUpstream({
      
      "/v1/models": { data: [{ id: "deepseek-v4-pro", context_length: 512000 }] },
      "/api/pricing": { data: [{ model_name: "deepseek-v4-pro", model_ratio: 0.495 }] },
    }, seen);

    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);

    
    expect(seen).toContain("https://gw.example.com/api/pricing");
    
    expect(details.get("deepseek-v4-pro")?.context_length).toBe(512000);
    expect(details.get("deepseek-v4-pro")?.pricing?.prompt).toBeCloseTo(0.99, 6);
  });

  it("阶段 1 命中即止：拿到清单后不再试后续元数据端点", async () => {
    const seen: string[] = [];
    const getJson = fakeUpstream({
      "/v1/models": { data: [{ id: "m1" }] },
      "/openapi.json": { data: [{ id: "should-not-be-used" }] },
      "/api/pricing": { data: [{ model_name: "m1", model_ratio: 0.5 }] },
    }, seen);
    await probeUpstreamTwoPhase("https://gw.example.com", getJson);
    expect(seen.filter((u) => u.endsWith("/v1/models"))).toHaveLength(1);
    expect(seen).not.toContain("https://gw.example.com/openapi.json");
  });

  it("上游自带 pricing（OpenRouter 市场价）优先于定价端点的补位价", async () => {
    const getJson = fakeUpstream({
      "/v1/models": { data: [{ id: "m1", pricing: { prompt: "0.000003", completion: "0.000015" } }] },
      "/api/pricing": { data: [{ model_name: "m1", model_ratio: 99 }] },
    }, []);
    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);
    expect(details.get("m1")?.pricing?.prompt).toBeCloseTo(3, 6); 
    expect(details.get("m1")?.pricing?.completion).toBeCloseTo(15, 6);
  });

  it("定价端点是对象映射形态（/api/ratio_config）同样能合并", async () => {
    const getJson = fakeUpstream({
      "/v1/models": { data: [{ id: "m1" }] },
      "/api/ratio_config": { data: { model_ratio: { m1: 0.135 }, completion_ratio: { m1: 2 }, cache_ratio: { m1: 0.25 } } },
    }, []);
    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);
    const p = details.get("m1")?.pricing;
    expect(p?.prompt).toBeCloseTo(0.27, 6);
    expect(p?.completion).toBeCloseTo(0.54, 6);
    expect(p?.promptCacheRead).toBeCloseTo(0.0675, 6);
  });

  it("上游全线不可达 → 返回空 Map，不抛异常（探针失败不能中断保存流程）", async () => {
    const details = await probeUpstreamTwoPhase("https://gw.example.com", async () => null);
    expect(details.size).toBe(0);
  });
});








describe("币种归属（vendorRegion / currencyOfRegion / displayCurrencyForModel）", () => {
  it("国内厂商 → cn；海外与未知 → other（未知**不猜**成 cn）", () => {
    expect(vendorRegion("deepseek")).toBe("cn");
    expect(vendorRegion("glm")).toBe("cn");
    expect(vendorRegion("qwen")).toBe("cn");
    expect(vendorRegion("openai")).toBe("other");
    expect(vendorRegion("claude")).toBe("other");
    
    expect(vendorRegion("DeepSeek")).toBe("cn");
    
    expect(vendorRegion(undefined)).toBe("other");
    expect(vendorRegion("zz-unknown-vendor")).toBe("other");
  });

  it("只有 cn 用人民币，us/other 一律美元（宁可显示美元，也不要把美元当人民币）", () => {
    expect(currencyOfRegion("cn")).toBe("CNY");
    expect(currencyOfRegion("us")).toBe("USD");
    expect(currencyOfRegion("other")).toBe("USD");
  });

  it("displayCurrencyForModel：官方有 ¥ 价的模型 → CNY；海外 → USD；未知模型 → USD", () => {
    
    expect(displayCurrencyForModel("deepseek-v4.1-flash")).toBe("CNY");
    expect(displayCurrencyForModel("glm-5.3")).toBe("CNY");
    
    expect(displayCurrencyForModel("gpt-4o")).toBe("USD");
    expect(displayCurrencyForModel("claude-sonnet-4-20250514")).toBe("USD");
    
    expect(displayCurrencyForModel("zz-unlisted-model-xyz")).toBe("USD");
  });

  it("displayCurrencyForModel 与 formatPricingAmounts 的主币种**必须一致**（同一价不能两处显示不同币种）", () => {
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-pro", "glm-5.3", "gpt-4o"]) {
      const cur = displayCurrencyForModel(id);
      
      const txt = formatPricingAmounts(builtInFlatPricing(id));
      if (!txt) { continue; }
      
      if (cur === "CNY") { expect(txt, id).toContain("¥"); }
      else { expect(txt, id).not.toContain("¥"); }
    }
  });
});

describe("金额格式化（convertFromUsd / formatMoney：尽量靠近整数、绝不留长尾）", () => {
  it("折算率只有一个出处：convertFromUsd 用 USD_CNY_RATE，不再是各处硬编码的 7.25", () => {
    expect(convertFromUsd(1, "USD")).toBe(1);
    expect(convertFromUsd(1, "CNY")).toBe(USD_CNY_RATE);
    expect(convertFromUsd(0, "CNY")).toBe(0);
    
    expect(convertFromUsd(10, "CNY")).toBe(72);
  });

  it("整数与短小数**不留尾零**（旧 toFixed(4) 会把 ¥12.30 印成 ¥12.3000）", () => {
    expect(formatMoney(2, "CNY")).toBe("¥2");           
    expect(formatMoney(12.3, "CNY")).toBe("¥12.3");
    expect(formatMoney(12.34, "CNY")).toBe("¥12.34");
    expect(formatMoney(0.5, "USD")).toBe("$0.5");
  });

  it("按量级给精度：≥100 取整、≥1 两位、≥0.01 四位、更小六位", () => {
    expect(formatMoney(1234.567, "CNY")).toBe("¥1235");
    expect(formatMoney(1234, "CNY")).toBe("¥1234");
    expect(formatMoney(0.0123, "USD")).toBe("$0.0123");
    expect(formatMoney(0.000123, "USD")).toBe("$0.000123");
  });

  it("极小**非零**金额不得被抹成 0（0 = 免费，与极小额是两件事）", () => {
    
    expect(formatMoney(0.0000001, "USD")).toBe("$<0.000001");
    
    expect(formatMoney(0, "USD")).toBe("$0");
    expect(formatMoney(0, "CNY")).toBe("¥0");
  });

  it("负值与非法值不崩（账目不可能为负，但格式化不能抛）", () => {
    expect(formatMoney(-12.3, "CNY")).toBe("¥-12.3");
    expect(formatMoney(Number.NaN, "USD")).toBe("$0");
    expect(formatMoney(Number.POSITIVE_INFINITY, "USD")).toBe("$0");
  });
});

describe("源码守卫：折算率不许再出现第二处（A-990）", () => {
  





  it("gui/core-ts/gateway-ts 的代码行里不得出现硬编码汇率", () => {
    const roots = ["gui/src", "core-ts/src", "gateway-ts/src"];
    const offenders: string[] = [];
    







    const RATE_USED = /7\.25|[*\/]\s*7\.2(?!\d)/;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) { continue; }
        const lines = readFileSync(p, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!RATE_USED.test(line)) { return; }
          const t = line.trim();
          
          if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) { return; }
          
          if (line.includes("USD_CNY_RATE")) { return; }
          offenders.push(`${p}:${i + 1}  ${t.slice(0, 90)}`);
        });
      }
    };
    for (const r of roots) { walk(r); }
    expect(offenders, `折算率只能来自 shared 的 USD_CNY_RATE，以下位置疑似硬编码：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("守卫自检：故意构造的违规行必须被规则抓到（否则这条守卫是空转的）", () => {
    const RATE_USED = /7\.25|[*\/]\s*7\.2(?!\d)/;
    
    expect(RATE_USED.test("const cny = usd * 7.25;")).toBe(true);
    expect(RATE_USED.test("const cny = usd * 7.2;")).toBe(true);
    expect(RATE_USED.test("const cny = usd / 7.2;")).toBe(true);
    
    expect(RATE_USED.test('<path d="M882.048 134.848L762.56 862.72a38.4"/>')).toBe(false);
    expect(RATE_USED.test('<path d="M267.264 581.824 110.848"/>')).toBe(false);
    
    expect(RATE_USED.test("target: es2020, version 7.20")).toBe(false);
  });
});











describe("A-990-B：币种判定与换算（用户手选 > 归属地）", () => {
  it("pricingDisplayCurrency：用户选择压过归属地；非法/空值按「未选」处理", () => {
    
    expect(displayCurrencyForModel("deepseek-v4.1-flash")).toBe("CNY");
    
    expect(pricingDisplayCurrency("deepseek-v4.1-flash", "USD")).toBe("USD");
    
    expect(pricingDisplayCurrency("gpt-4o", "CNY")).toBe("CNY");
    
    expect(pricingDisplayCurrency("gpt-4o", undefined)).toBe("USD");
    expect(pricingDisplayCurrency("deepseek-v4.1-flash", undefined)).toBe("CNY");
    
    expect(pricingDisplayCurrency("gpt-4o", "usd" as never)).toBe("USD");
    expect(pricingDisplayCurrency("gpt-4o", "" as never)).toBe("USD");
  });

  it("toUsdAmount ⇄ convertFromUsd 可逆且共用同一个汇率（往返后与用户敲的数字一致）", () => {
    expect(toUsdAmount(8, "USD")).toBe(8);           
    expect(toUsdAmount(8, "CNY")).toBe(cnyToUsd(8)); 
    for (const typed of [0, 0.5, 2, 8, 28, 123.45]) {
      const usd = toUsdAmount(typed, "CNY");
      
      expect(formatAmount(convertFromUsd(usd, "CNY")), String(typed)).toBe(formatAmount(typed));
    }
  });

  it("formatAmountsInCurrency 按「该侧有没有原生值」判定，绝不拿美元价乘汇率冒充官方人民币价", () => {
    
    const ds = { priceIn: 0.3, priceOut: 1.2, priceInCny: 2, priceOutCny: 8, usdDerivedFromCny: false };
    expect(formatAmountsInCurrency(ds, "CNY")).toBe("¥2 / ¥8 /1M");
    expect(formatAmountsInCurrency(ds, "CNY")).not.toContain("2.16");
    expect(formatAmountsInCurrency(ds, "USD")).toBe("$0.3 / $1.2 /1M");

    
    const cnyOnly = { priceIn: 0.111, priceOut: 0.389, priceInCny: 0.8, priceOutCny: 2.8, usdDerivedFromCny: true };
    expect(formatAmountsInCurrency(cnyOnly, "CNY")).toBe("¥0.8 / ¥2.8 /1M");
    expect(formatAmountsInCurrency(cnyOnly, "USD")).toMatch(/^≈\$/);

    
    const usdOnly = { priceIn: 2.5, priceOut: 10 };
    expect(formatAmountsInCurrency(usdOnly, "USD")).toBe("$2.5 / $10 /1M");
    expect(formatAmountsInCurrency(usdOnly, "CNY")).toMatch(/^≈¥/);

    
    expect(formatAmountsInCurrency({}, "CNY")).toBeUndefined();
  });

  it("无价的模型：三个币种函数都不得凭空造出数字", () => {
    expect(formatAmountsInCurrency({}, "USD")).toBeUndefined();
    expect(formatAmountsInCurrency({}, "CNY")).toBeUndefined();
    expect(formatPricingAmounts({})).toBeUndefined();
  });

  









  it("amountInCurrency：有官方 ¥ 列就返回官方数字（不得返回折算值）", () => {
    
    const eff = { priceIn: 0.3, priceOut: 1.2, priceCacheRead: 0.006, priceInCny: 2, priceOutCny: 8, priceCacheReadCny: 0.04 };
    expect(amountInCurrency(eff, "priceIn", "CNY")).toEqual({ value: 2, native: true });
    expect(amountInCurrency(eff, "priceOut", "CNY")).toEqual({ value: 8, native: true });
    expect(amountInCurrency(eff, "priceCacheRead", "CNY")).toEqual({ value: 0.04, native: true });
    
    expect(amountInCurrency(eff, "priceIn", "CNY")!.value).not.toBeCloseTo(0.3 * USD_CNY_RATE, 6);
    
    expect(amountInCurrency(eff, "priceIn", "USD")).toEqual({ value: 0.3, native: true });
    
    expect(amountInCurrency({ priceIn: 0.3, priceCacheWrite: 0.375, priceInCny: 2 }, "priceCacheWrite", "CNY"))
      .toEqual({ value: 2.7, native: false });
    
    expect(amountInCurrency({ priceInCny: 2 }, "priceCacheWrite", "CNY")).toBeUndefined();
  });

  it("amountInCurrency 与 formatAmountsInCurrency 的原生性判据必须一致（同一字段不得一处原生一处折算）", () => {
    const eff = { priceIn: 0.3, priceOut: 1.2, priceInCny: 2, priceOutCny: 8 };
    const pair = formatAmountsInCurrency(eff, "CNY")!;
    expect(pair).toBe("¥2 / ¥8 /1M");                       
    expect(amountInCurrency(eff, "priceIn", "CNY")!.native).toBe(true);
    expect(amountInCurrency(eff, "priceOut", "CNY")!.native).toBe(true);
    
    const usdOnly = { priceIn: 2.5, priceOut: 10 };
    expect(formatAmountsInCurrency(usdOnly, "CNY")!).toMatch(/^≈¥/);
    expect(amountInCurrency(usdOnly, "priceIn", "CNY")!.native).toBe(false);
  });


  it("officialPriceCurrency：只有真登记了 ¥ 列才算「官方人民币价」（归属地不算）", () => {
    expect(officialPriceCurrency("deepseek-v4.1-flash")).toBe("CNY");
    expect(officialPriceCurrency("glm-5.3")).toBe("CNY");
    expect(officialPriceCurrency("gpt-4o")).toBe("USD");
    expect(officialPriceCurrency("zz-unlisted-model-xyz")).toBe("USD");
  });

  it("手填 ¥8 的端到端：落库是 USD（记账单位唯一），显示回到 ¥8", () => {
    
    const typed = 8;
    const storedUsd = toUsdAmount(typed, pricingDisplayCurrency("deepseek-v4.1-flash", "CNY"));
    expect(storedUsd).toBeCloseTo(8 / USD_CNY_RATE, 10);
    
    expect(storedUsd).not.toBe(typed);
    
    expect(formatAmount(convertFromUsd(storedUsd, "CNY"))).toBe("8");
  });
});

describe("A-990-E：探针诊断分类（回答「探针探不到吗」）", () => {
  it("本地端点 / 上游命中 / 上游没给价 / 完全无价 四种分类互不混淆", () => {
    
    expect(classifyProbeOutcome("table", "http://127.0.0.1:8800")).toBe("local");
    expect(classifyProbeOutcome("manual", "http://127.0.0.1:8800")).toBe("local");
    
    expect(classifyProbeOutcome("upstream", "https://gw.example.com")).toBe("upstream-hit");
    
    expect(classifyProbeOutcome("table", "https://api.deepseek.com")).toBe("builtin-table");
    expect(classifyProbeOutcome("tier", "https://api.deepseek.com")).toBe("builtin-table");
    expect(classifyProbeOutcome("snapshot", "https://api.deepseek.com")).toBe("builtin-table");
    
    expect(classifyProbeOutcome("none", "https://gw.example.com")).toBe("unpriced");
  });

  it("文案必须说清「不是故障」，否则用户会一直去重修探针", () => {
    
    expect(PROBE_OUTCOME_HINT["builtin-table"]).toContain("不发布价目");
    expect(PROBE_OUTCOME_HINT["builtin-table"]).not.toContain("失败");
    expect(PROBE_OUTCOME_HINT.local).toContain("探针");
  });
});

describe("A-990-F：补齐国内厂商官方人民币价（消除「官方文档没有小数点」的根因）", () => {
  it("Kimi / MiniMax 必须用官方 ¥ 价，且命中精确条目", () => {
    







    const cases: Array<[string, number, number, number | "none"]> = [
      
      ["kimi-k3", 20, 100, 2],
      ["kimi-k2.7-code", 6.5, 27, 1.3],
      ["kimi-k2.6", 6.5, 27, 1.1],
      ["kimi-k2.5", 4, 21, 0.7],
      ["moonshot-v1", 10, 30, "none"],
      ["minimax-m3", 2.1, 8.4, 0.42],
      ["minimax-m2.7", 2.1, 8.4, 0.42],
      ["minimax-m2.5", 2.1, 8.4, 0.21],
      ["minimax-m2", 2.1, 8.4, 0.21],
    ];
    for (const [id, inCny, outCny, crCny] of cases) {
      const p = builtInFlatPricing(id);
      expect(p.priceInCny, `${id} ¥输入价`).toBe(inCny);
      expect(p.priceOutCny, `${id} ¥输出价`).toBe(outCny);
      if (crCny === "none") { expect(p.priceCacheReadCny, `${id} 无缓存价`).toBeUndefined(); }
      else { expect(p.priceCacheReadCny, `${id} ¥缓存命中价`).toBeCloseTo(crCny, 9); }
      
      expect(p.usdDerivedFromCny, `${id} 美元应为折算值`).toBe(true);
      
      expect(pricingMatchKind(id), `${id} 应为精确条目`).toBe("exact");
    }
    
    expect(builtInFlatPricing("minimax-m2.7").priceCacheWriteCny).toBeCloseTo(2.625, 9);
    
    expect(builtInFlatPricing("minimax-m2.7-highspeed").priceInCny).toBe(4.2);
    expect(builtInFlatPricing("minimax-m2.7").priceInCny).toBe(2.1);
  });
  it("Qwen 必须走内置表的官方 ¥ 价，而不是 OpenRouter 快照的二手美元价", () => {
    
    const p = builtInFlatPricing("qwen3.8-max");
    expect(p.priceInCny).toBe(14.988);
    expect(p.priceOutCny).toBe(44.965);
    
    expect(p.usdDerivedFromCny).toBe(true);
    
    expect(resolveModelPriceTier("qwen3.8-max").pricing.priceIn).toBeCloseTo(14.988 / USD_CNY_RATE, 10);
    const resolved = resolveEffectivePricing("qwen3.8-max", "");
    expect(resolved.origin === "table" || resolved.origin === "tier").toBe(true);
    
    expect(formatAmountsInCurrency(builtInFlatPricing("qwen3.8-max"), "CNY")).toBe("¥14.988 / ¥44.965 /1M");
  });

  it("补价不得盖掉同一家族的思考能力（单表首个命中：能力与价格必须同条目）", () => {
    
    
    for (const id of ["qwen3.8-max", "qwen3.8-flash", "qwen3.8-27b", "qwen3.7-plus"]) {
      const caps = inferModelCapabilities(id);
      expect(caps.supported, id).toBe(true);
      expect(caps.thinkingParam, id).toBe("enable_thinking");
      expect(caps.efforts, id).toEqual(["low", "medium", "xhigh"]);
    }
  });
});


describe("A-990-G：全表时效性守卫（价格必须可溯源到某一天）", () => {
  







  it("凡是在内置表里写了价的厂商，都必须在 PRICING_VERIFIED_AT 里有日期（`unknown` 也算有）", () => {
    const vendorsWithPrice = new Set<string>();
    for (const v of MODEL_CAPABILITIES) {
      const vendorLevel = v.priceIn !== undefined || v.priceOut !== undefined
        || v.priceInCny !== undefined || v.priceOutCny !== undefined;
      const modelLevel = v.models.some((m) => m.priceIn !== undefined || m.priceInCny !== undefined
        || m.priceTiers !== undefined);
      if (vendorLevel || modelLevel) { vendorsWithPrice.add(v.key); }
    }
    const missing = [...vendorsWithPrice].filter((k) => PRICING_VERIFIED_AT[k] === undefined).sort();
    expect(missing, `这些厂商有内置价却没有核实日期（界面会显示成"永远新鲜"）：${missing.join(", ")}`).toEqual([]);
  });

  it("日期必须是 `unknown` 或 ISO 日期，不得是空串/其它形态（脏值会让界面显示出假的新鲜度）", () => {
    for (const [k, v] of Object.entries(PRICING_VERIFIED_AT)) {
      expect(v === "unknown" || /^\d{4}-\d{2}-\d{2}$/.test(v), `${k}=${JSON.stringify(v)}`).toBe(true);
    }
    
    expect(pricingVerifiedAtUnknown("mistral")).toBe(true);
    expect(pricingVerifiedAtUnknown("deepseek")).toBe(false);
    expect(pricingVerifiedAtUnknown("zz-no-such-vendor")).toBe(true);
  });

  it("OpenAI 现行全表必须与官方定价页一致（一手来源：developers.openai.com/api/docs/pricing，2026-09-18）", () => {
    




    const cases: Array<[string, number, number, number | undefined, number | undefined]> = [
      
      ["gpt-6-astra", 10, 50, 1, 12.5],
      ["gpt-5.6-sol", 4, 20, 0.4, 5],
      ["gpt-5.6-terra", 2, 12, 0.2, 2.5],
      ["gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
      ["gpt-5.6-cyber", 12.5, 75, 1.25, 15.625],
      ["gpt-5.5-cyber", 12.5, 75, 1.25, undefined],
      ["gpt-5.5", 5, 30, 0.5, undefined],
      ["gpt-5.5-pro", 30, 180, undefined, undefined],
      ["gpt-5.4", 2.5, 15, 0.25, undefined],
      ["gpt-5.4-mini", 0.75, 4.5, 0.075, undefined],
      ["gpt-5.4-nano", 0.2, 1.25, 0.02, undefined],
      ["gpt-5.4-pro", 30, 180, undefined, undefined],
      ["gpt-5.3-codex", 1.75, 14, 0.175, undefined],
      ["gpt-5.2", 1.75, 14, 0.175, undefined],
      ["gpt-5.2-pro", 21, 168, undefined, undefined],
      ["gpt-5.1", 1.25, 10, 0.125, undefined],
      ["gpt-5", 1.25, 10, 0.125, undefined],
      ["gpt-5-mini", 0.25, 2, 0.025, undefined],
      ["gpt-5-nano", 0.05, 0.4, 0.005, undefined],
      ["gpt-5-pro", 15, 120, undefined, undefined],
      ["gpt-4.1", 2, 8, 0.5, undefined],
      ["gpt-4.1-mini", 0.4, 1.6, 0.1, undefined],
      ["gpt-4.1-nano", 0.1, 0.4, 0.025, undefined],
      ["gpt-4o", 2.5, 10, 1.25, undefined],
      ["gpt-4o-2024-05-13", 5, 15, undefined, undefined],
      ["gpt-4o-mini", 0.15, 0.6, 0.075, undefined],
      ["o1", 15, 60, 7.5, undefined],
      ["o1-pro", 150, 600, undefined, undefined],
      ["o3", 2, 8, 0.5, undefined],
      ["o3-pro", 20, 80, undefined, undefined],
      ["o3-mini", 1.1, 4.4, 0.55, undefined],
      ["o4-mini", 1.1, 4.4, 0.275, undefined],
      ["gpt-4-turbo-2024-04-09", 10, 30, undefined, undefined],
    ];
    for (const [id, inP, outP, cr, cw] of cases) {
      const p = inferModelPricing(id);
      expect(p.priceIn, `${id} 输入价`).toBeCloseTo(inP, 9);
      expect(p.priceOut, `${id} 输出价`).toBeCloseTo(outP, 9);
      
      
      
      if (cr === undefined) { expect(p.priceCacheRead, `${id} 无缓存命中列`).toBeUndefined(); }
      else { expect(p.priceCacheRead, `${id} 缓存命中价`).toBeCloseTo(cr, 9); }
      if (cw === undefined) { expect(p.priceCacheWrite, `${id} 无缓存写入列`).toBeUndefined(); }
      else { expect(p.priceCacheWrite, `${id} 缓存写入价`).toBeCloseTo(cw, 9); }
    }
    
    expect(inferModelPricing("gpt-5.5-pro").priceIn).not.toBe(inferModelPricing("gpt-5.5").priceIn);
    
    
    expect(builtInFlatPricing("gpt-5.5-unknown-suffix").priceIn).toBeUndefined();
  });

  it("gpt-5/6 家族的能力（思考 + responses 端点）必须齐备：回退价格时也不能连带砍掉能力", () => {
    for (const id of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.1", "gpt-5", "gpt-5.7-whatever"]) {
      const caps = inferModelCapabilities(id);
      expect(caps.supported, id).toBe(true);
      expect(caps.endpoint, id).toBe("responses");
      expect(caps.efforts, id).toContain("xhigh");
    }
  });
});








describe("A-990-H：价目命中方式必须可判定、且现行旗舰必须是精确条目", () => {
  it("现行旗舰（OpenAI / DeepSeek / Qwen）必须命中精确条目", () => {
    for (const id of [
      "gpt-6-astra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-5.1", "o3", "o4-mini",
      "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo-2024-04-09",
      "deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner",
      "qwen3.8-max", "qwen3.8-flash",
    ]) {
      expect(pricingMatchKind(id), `${id} 应为精确条目`).toBe("exact");
    }
  });

  








  it("已知未精确化的厂商（待办，**不是**通过）", () => {
    const stillFamily = ["glm-5.3", "claude-sonnet-5", "gemini-3-pro", "mistral-large", "cohere-command-r-plus"];
    const exact = stillFamily.filter((id) => pricingMatchKind(id) === "exact");
    expect(exact, `这些已精确化，请从待办清单移除：${exact.join(", ")}`).toEqual([]);
    
    expect(pricingMatchKind("glm-5.3")).toBe("family");
  });

  it("未登记型号必须落到 family（而不是被某条精确条目误吃）", () => {
    
    expect(pricingMatchKind("claude-9-opus-imaginary")).toBe("family");
    expect(pricingMatchKind("zz-unlisted-model-xyz")).toBe("none");
  });

  it("resolveEffectivePricing 必须把命中方式带出来（界面才能标注「可能偏离」）", () => {
    expect(resolveEffectivePricing("gpt-6-astra", "").pricingMatch).toBe("exact");
    
    const fam = resolveEffectivePricing("claude-9-opus-imaginary", "");
    expect(fam.pricingMatch).toBe("family");
  });
});

describe("A-993：手填错值压过内置表必须被检出（用户实测踩到）", () => {
  





  it("手填 0.0193 vs 官方档位 1.32（偏离 68 倍）必须被标记为疑似错值", () => {
    const eff = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 0.0193, price_out_usd: 0.0386, price_cache_read_usd: 0.00417,
      price_source: "manual",
    }, new Date("2026-09-18T02:00:00Z")); 
    expect(eff.origin).toBe("manual");            
    expect(eff.priceIn).toBeCloseTo(0.0193, 9);
    expect(eff.suspiciousStored, "必须亮出偏离详情").toBeTruthy();
    expect(eff.suspiciousStored!.tableIn).toBeCloseTo(1.32, 9);
    expect(eff.suspiciousStored!.ratio).toBeLessThan(0.02);
  });

  it("正常手填（如议价 ±30%）不得误报", () => {
    const eff = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 1.0, price_out_usd: 3.0, price_source: "manual",
    }, new Date("2026-09-18T02:00:00Z"));
    expect(eff.origin).toBe("manual");
    expect(eff.suspiciousStored, "偏离仅 1.32 倍，是合理议价区间").toBeUndefined();
  });

  it("偏离恰在阈值边界的行为必须确定（避开浮点边界：5.2× 报、4.8× 不报）", () => {
    const at = new Date("2026-09-18T02:00:00Z");
    
    const at5x = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 6.9, price_source: "manual", 
    }, at);
    expect(at5x.suspiciousStored, "5.2× 必须报").toBeTruthy();
    const at49x = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 6.3, price_source: "manual", 
    }, at);
    expect(at49x.suspiciousStored, "4.8× 不报（阈值内）").toBeUndefined();
  });

  it("非手填来源（upstream/table）不参与疑似错值检测", () => {
    const eff = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 0.0193, price_source: "upstream",
    }, new Date("2026-09-18T02:00:00Z"));
    
    expect(eff.suspiciousStored).toBeUndefined();
  });
});

describe("A-990-B：用户选择必须存得住（落盘 + 一键刷新两条路）", () => {
  it("mergeModelPrice：手填分支与自动分支都必须保住 price_currency", () => {
    const withCur = (extra: Record<string, unknown>) => ({
      price_in_usd: 8 / USD_CNY_RATE, price_out_usd: 28 / USD_CNY_RATE,
      price_source: "manual" as const, price_currency: "CNY" as const, ...extra,
    });
    
    const manual = mergeModelPrice(withCur({}), { price_in_usd: 1, price_source: "table" });
    expect(manual.price_currency).toBe("CNY");
    expect(manual.price_source).toBe("manual");
    
    const prevAuto = { price_in_usd: 1, price_out_usd: 2, price_source: "table" as const, price_currency: "USD" as const };
    const auto = mergeModelPrice(prevAuto, { price_in_usd: 3, price_source: "upstream" });
    expect(auto.price_currency).toBe("USD");
    
    expect(mergeModelPrice(undefined, { price_in_usd: 1 }).price_currency).toBeUndefined();
  });

  it("落盘往返：price_currency 存得住，脏值被丢弃（sanitize 是白名单重建，漏字段会静默丢）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slime-cur-"));
    setProvRoot(dir);
    try {
      await saveProvider({
        key: "curtest", api_base: "https://api.example.com/v1", api_key: "sk-1234567890",
        models: [
          { id: "m-cny", price_in_usd: 8 / USD_CNY_RATE, price_source: "manual", price_currency: "CNY" },
          { id: "m-junk", price_in_usd: 1, price_currency: "RUB" as never },
        ],
      });
      const saved = listProviders().find((p) => p.key === "curtest");
      const byId = new Map((saved?.models ?? []).map((m) => [m.id, m]));
      
      expect(byId.get("m-cny")?.price_currency).toBe("CNY");
      
      expect(byId.get("m-junk")?.price_currency).toBeUndefined();
    } finally {
      setProvRoot(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("A-990-B：消耗显示按用户选择", () => {
  it("ledgerCurrencyOf：注入 currencyOf 后按用户选择判币種，未注入时退回归属地", () => {
    const recs = [
      { model: "gpt-4o", provider_key: "p1", cost_usd: 1 },
      { model: "gpt-4o", provider_key: "p2", cost_usd: 1 },
    ];
    
    expect(ledgerCurrencyOf(recs)).toBe("USD");
    
    
    const curOf = (r: { model: string; provider_key?: string }): "USD" | "CNY" =>
      (r.provider_key === "p2" ? "CNY" : "USD");
    expect(ledgerCurrencyOf(recs, curOf)).toBe("USD");
    
    const recs2 = [
      { model: "gpt-4o", provider_key: "p2", cost_usd: 5 },
      { model: "gpt-4o", provider_key: "p1", cost_usd: 1 },
    ];
    expect(ledgerCurrencyOf(recs2, curOf)).toBe("CNY");
    
    expect(ledgerCurrencyOf([{ model: "gpt-4o", cost_usd: 0 }], () => "CNY")).toBe("USD");
  });
});
