












import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  builtInPriceTiers,
  cacheWriteRatio,
  createDefaultPriceTiers,
  describeCacheRateSource,
  describePriceTiers,
  describeTierSpec,
  inferModelPricing,
  isLocalEndpoint,
  normalizePriceTiers,
  resolveEffectivePricing,
  resolveModelPriceTier,
  resolveTierId,
  type ModelPriceTiers,
} from "../../shared/gen/model-capabilities.js";
import { computeRecordCost, recomputeOne, type UsageRecord } from "../../core-ts/src/services/usage.js";
import { inferPricingFromUrl, makePriceResolver, type ProvidersTable } from "../../gui/src/main/providers.js";





const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function bj(isoDate: string, h: number, m = 0, s = 0): string {
  const base = new Date(`${isoDate}T00:00:00Z`).getTime();
  return new Date(base + h * 3600_000 + m * 60_000 + s * 1000 - TZ_OFFSET_MS).toISOString();
}
const WED = "2026-09-16"; 
const MON = "2026-09-21"; 
const SAT = "2026-09-19"; 
const SUN = "2026-09-20"; 

describe("resolveModelPriceTier：DeepSeek 峰谷档位", () => {
  it("高峰时段（北京时间周三 10:00）→ peak 档，价格 = 高峰价", () => {
    const r = resolveModelPriceTier("deepseek-flash", bj(WED, 10));
    expect(r.tiered).toBe(true);
    expect(r.tierId).toBe("peak");
    expect(r.timezone).toBe("Asia/Shanghai");
    
    expect(r.pricing.priceIn).toBeCloseTo(0.3, 9);
    expect(r.pricing.priceOut).toBeCloseTo(1.2, 9);
    expect(r.pricing.priceCacheRead).toBeCloseTo(0.006, 9);
  });

  it("空闲时段（北京时间周三 02:00）→ offpeak 档，价格 = 高峰的一半", () => {
    const r = resolveModelPriceTier("deepseek-flash", bj(WED, 2));
    expect(r.tiered).toBe(true);
    expect(r.tierId).toBe("offpeak");
    expect(r.pricing.priceIn).toBeCloseTo(0.15, 9);
    expect(r.pricing.priceOut).toBeCloseTo(0.6, 9);
    expect(r.pricing.priceCacheRead).toBeCloseTo(0.003, 9);
  });

  it("pro 档同规则但单价不同（档位表是模型级的，不能串味）", () => {
    expect(resolveModelPriceTier("deepseek-v4-pro", bj(WED, 10)).pricing.priceOut).toBeCloseTo(3.96, 9);
    expect(resolveModelPriceTier("deepseek-v4-pro", bj(WED, 3)).pricing.priceOut).toBeCloseTo(1.98, 9);
  });

  it("平铺价 = 高峰标准价（真实存在的档位，不是均值）；不传时刻不猜档位", () => {
    const flat = inferModelPricing("deepseek-flash");
    expect(flat.priceIn).toBeCloseTo(0.3, 9);
    
    expect(flat.priceIn).not.toBeCloseTo(0.225, 6);
    
    const r = resolveModelPriceTier("deepseek-flash");
    expect(r.tiered).toBe(false);
    expect(r.tierId).toBe("flat");
    expect(r.pricing.priceIn).toBeCloseTo(0.3, 9);
  });

  it("无分时规格的模型 → tiered=false（不得把平铺价硬说成某个档位）", () => {
    
    
    
    const r = resolveModelPriceTier("claude-sonnet-4-20250514", bj(WED, 10));
    expect(r.tiered).toBe(false);
    expect(r.tierId).toBe("flat");
    expect(r.timezone).toBeUndefined();
    expect(r.pricing.priceIn).toBeCloseTo(3, 9);

    
    
    const snap = resolveModelPriceTier("kimi-k2", bj(WED, 10));
    expect(snap.tiered).toBe(false);
    expect(snap.tierId).toBe("snapshot");
    expect(snap.pricing.priceIn).toBeGreaterThan(0);
  });

  it("查不到价的模型 → pricing 为空、tiered=false（仍是「未定价」，不是免费）", () => {
    
    
    const r = resolveModelPriceTier("zz-unlisted-model-xyz", bj(WED, 10));
    expect(r.tiered).toBe(false);
    expect(r.pricing).toEqual({});
  });
});

describe("resolveModelPriceTier：时段边界（左闭右开）", () => {
  const at = (h: number, m = 0, s = 0): string => resolveModelPriceTier("deepseek-flash", bj(WED, h, m, s)).tierId;

  it("上午场 09:00-12:00：起点含、终点不含", () => {
    expect(at(8, 59, 59)).toBe("offpeak"); 
    expect(at(9, 0, 0)).toBe("peak");      
    expect(at(11, 59, 59)).toBe("peak");   
    expect(at(12, 0, 0)).toBe("offpeak");  
  });

  it("午休 12:00-14:00 是空闲（最易被写成一整段 09:00-18:00）", () => {
    expect(at(12, 30)).toBe("offpeak");
    expect(at(13, 59, 59)).toBe("offpeak");
  });

  it("下午场 14:00-18:00：起点含、终点不含", () => {
    expect(at(14, 0, 0)).toBe("peak");
    expect(at(17, 59, 59)).toBe("peak");
    expect(at(18, 0, 0)).toBe("offpeak"); 
  });

  it("周末整天空闲；周一 09:00 重新进高峰", () => {
    expect(resolveModelPriceTier("deepseek-flash", bj(SAT, 10)).tierId).toBe("offpeak");
    expect(resolveModelPriceTier("deepseek-flash", bj(SUN, 10)).tierId).toBe("offpeak");
    expect(resolveModelPriceTier("deepseek-flash", bj(SUN, 23, 59)).tierId).toBe("offpeak");
    expect(resolveModelPriceTier("deepseek-flash", bj(MON, 9)).tierId).toBe("peak");
  });
});

describe("resolveModelPriceTier：计费时区必须是供应商的钟（不是 UTC、也不是本机时区）", () => {
  it("UTC 02:00 实为北京时间 10:00 → 高峰；若错按 UTC 判会得到空闲", () => {
    
    expect(resolveModelPriceTier("deepseek-flash", "2026-09-16T02:00:00Z").tierId).toBe("peak");
  });

  it("UTC 16:00 实为北京时间次日 00:00 → 空闲；若错按 UTC 判会落在 14:00-18:00 高峰", () => {
    expect(resolveModelPriceTier("deepseek-flash", "2026-09-16T16:00:00Z").tierId).toBe("offpeak");
  });

  it("周一（北京）09:30 的高峰请求：UTC 侧是周一凌晨，若用 UTC 连星期都会算错", () => {
    
    expect(resolveModelPriceTier("deepseek-flash", "2026-09-21T01:30:00Z").tierId).toBe("peak");
  });

  it("非法时区名 → 退回兜底档（不崩、不记 0）", () => {
    const bad: ModelPriceTiers = {
      timezone: "Not/AZone",
      tiers: [
        { id: "peak", windows: [{ startMin: 0, endMin: 1 }], priceIn: 9, priceOut: 9 },
        { id: "offpeak", priceIn: 1, priceOut: 1 },
      ],
    };
    const tier = resolveTierId(bad.tiers, new Date("2026-09-16T02:00:00Z"), bad.timezone);
    expect(tier?.id).toBe("offpeak");
    
    expect(tier?.priceIn).toBe(1);
  });

  it("tiers 里没有兜底档（全都带 windows）→ 窗都不命中时回落第一档，不会无价", () => {
    const tiers = [{ id: "peak", windows: [{ startMin: 600, endMin: 660 }], priceIn: 5, priceOut: 5 }];
    expect(resolveTierId(tiers, new Date("2026-09-16T02:00:00Z"), "Asia/Shanghai")?.id).toBe("peak");
  });

  it("多个档位都命中 → 首个命中者胜（顺序即优先级）", () => {
    const tiers = [
      { id: "a", windows: [{ startMin: 0, endMin: 1440 }], priceIn: 1, priceOut: 1 },
      { id: "b", windows: [{ startMin: 0, endMin: 1440 }], priceIn: 2, priceOut: 2 },
    ];
    expect(resolveTierId(tiers, new Date(), "Asia/Shanghai")?.id).toBe("a");
  });
});

describe("分时定价的成本效果", () => {
  it("同一批 token，高峰价恰为空闲价的 2 倍（DeepSeek 官方规则）", () => {
    const peak = resolveModelPriceTier("deepseek-flash", bj(WED, 10)).pricing;
    const off = resolveModelPriceTier("deepseek-flash", bj(WED, 2)).pricing;
    const args = [1_000_000, 1_000_000, 0, 0, 0] as const;
    const costPeak = computeRecordCost(...args, peak.priceIn!, peak.priceOut!, peak.priceCacheRead);
    const costOff = computeRecordCost(...args, off.priceIn!, off.priceOut!, off.priceCacheRead);
    expect(costPeak).toBeCloseTo(1.5, 9);  
    expect(costOff).toBeCloseTo(0.75, 9);  
    expect(costPeak / costOff).toBeCloseTo(2, 9);
  });

  it("旧的峰谷均值（0.225）与两个真实档位都不等 —— 均值确实不对应任何时段", () => {
    const peak = resolveModelPriceTier("deepseek-flash", bj(WED, 10)).pricing.priceIn;
    const off = resolveModelPriceTier("deepseek-flash", bj(WED, 2)).pricing.priceIn;
    expect(peak).not.toBeCloseTo(0.225, 6);
    expect(off).not.toBeCloseTo(0.225, 6);
  });
});

describe("历史成本回填按每条记录的 ts 取档", () => {
  const table: ProvidersTable = {
    deepseek: {
      api_base: "https://api.deepseek.com/v1",
      api_key: "sk-x",
      models: [{ id: "deepseek-flash", price_in_usd: 0.3, price_out_usd: 1.2, price_source: "table" }],
    },
  };

  const rec = (ts: string): UsageRecord => ({
    ts,
    agent_id: "a1",
    session_id: "s1",
    model: "deepseek-flash",
    provider_key: "deepseek",
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    elapsed_ms: 10,
    cost_usd: 0,
    success: true,
  });

  it("高峰时刻的记录按高峰价回填，并把 price_tier 落盘", () => {
    const { rec: next, changed } = recomputeOne(rec(bj(WED, 10)), makePriceResolver(table));
    expect(changed).toBe(true);
    expect(next.cost_usd).toBeCloseTo(0.3, 9); 
    expect(next.price_tier).toBe("peak");
  });

  it("空闲时刻的同一条按空闲价回填 —— 两条记录因时刻不同而价不同，这是正确的", () => {
    const { rec: next } = recomputeOne(rec(bj(WED, 2)), makePriceResolver(table));
    expect(next.cost_usd).toBeCloseTo(0.15, 9);
    expect(next.price_tier).toBe("offpeak");
  });

  it("解析器必须把 ts 透传下去：同一记录给不同 ts 得到不同价（锁住「按 now 重算历史」的错法）", () => {
    const resolve = makePriceResolver(table);
    expect(resolve("deepseek", "deepseek-flash", bj(WED, 10))?.priceIn).toBeCloseTo(0.3, 9);
    expect(resolve("deepseek", "deepseek-flash", bj(WED, 2))?.priceIn).toBeCloseTo(0.15, 9);
    
    expect(resolve("deepseek", "deepseek-flash")?.priceIn).toBeCloseTo(0.3, 9);
  });

  it("手填 / 上游价不分时（单一数值语义，直接采信，不返回 tierId）", () => {
    const t2: ProvidersTable = {
      deepseek: {
        api_base: "https://api.deepseek.com/v1",
        api_key: "sk-x",
        models: [{ id: "deepseek-flash", price_in_usd: 7, price_out_usd: 8, price_source: "manual" }],
      },
    };
    const p = makePriceResolver(t2)("deepseek", "deepseek-flash", bj(WED, 10));
    expect(p?.priceIn).toBe(7);
    expect(p?.tierId).toBeUndefined();
  });

  it("成本已 > 0 的记录绝不被分时重算篡改（只增不减原则不受分时功能影响）", () => {
    const r = { ...rec(bj(WED, 2)), cost_usd: 42 };
    const { rec: next, changed } = recomputeOne(r, makePriceResolver(table));
    expect(changed).toBe(false);
    expect(next.cost_usd).toBe(42);
    expect(next.price_tier).toBeUndefined();
  });
});

describe("inferPricingFromUrl / isLocalEndpoint（本地端点判定双处一致）", () => {
  it("本地端点 → 显式 0，且**不**给出分时档位（本地推理没有 API 账单）", () => {
    const t = inferPricingFromUrl("http://127.0.0.1:8080/v1", "deepseek-flash", bj(WED, 10));
    expect(t.price_in_usd).toBe(0);
    expect(t.tier_id).toBeUndefined();
  });

  it("远程端点 → 分时档位随时刻变化，并回传 tier_id", () => {
    const peak = inferPricingFromUrl("https://api.deepseek.com/v1", "deepseek-flash", bj(WED, 10));
    const off = inferPricingFromUrl("https://api.deepseek.com/v1", "deepseek-flash", bj(WED, 2));
    expect(peak.price_in_usd).toBeCloseTo(0.3, 9);
    expect(peak.tier_id).toBe("peak");
    expect(off.price_in_usd).toBeCloseTo(0.15, 9);
    expect(off.tier_id).toBe("offpeak");
  });

  it("isLocalEndpoint：loopback / 私网 / 容器主机名命中，公网域名不命中", () => {
    for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:8080", "http://0.0.0.0:1234",
      "http://192.168.1.20:8000/v1", "http://10.0.0.5/v1", "http://172.16.3.9:8080/v1",
      "http://host.docker.internal:1234/v1"]) {
      expect(isLocalEndpoint(u), u).toBe(true);
    }
    for (const u of ["https://api.deepseek.com/v1", "https://my-gw.example.com/v1",
      "http://172.32.0.1/v1", "https://api.openai.com/v1"]) {
      expect(isLocalEndpoint(u), u).toBe(false);
    }
  });
});

describe("describePriceTiers：UI 时段文案由数据生成", () => {
  it("DeepSeek → 两段高峰窗 + 北京时间，且不含已废弃的「均值」说法", () => {
    const d = describePriceTiers("deepseek-flash");
    expect(d).toBeTruthy();
    expect(d).toContain("高峰时段：周一至周五 09:00-12:00、14:00-18:00");
    expect(d).toContain("空闲时段：其余时段");
    expect(d).toContain("Asia/Shanghai");
  });

  it("无分时规格的模型 → undefined（UI 不显示徽标，避免对普通模型乱标）", () => {
    expect(describePriceTiers("claude-sonnet-4-20250514")).toBeUndefined();
    expect(describePriceTiers("kimi-k2-0711-preview")).toBeUndefined();
    expect(describePriceTiers("")).toBeUndefined();
  });
});

describe("resolveEffectivePricing：生效价单源（面板显示 = 引擎计费）", () => {
  it("存值缺价但内置表有价 → origin=table（这就是「flash 显示未定价」的根因：旧面板只看存值）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "https://api.deepseek.com", {});
    expect(e.origin).toBe("table");
    expect(e.superseded).toBeUndefined();
    expect([0.15, 0.3]).toContain(e.priceIn); 
    expect(e.priceOut).toBe(1.2);
  });

  it("存值是机器写下的历史错值（无来源标记）→ 被表价取代，且把错值回传给 UI 标注", () => {
    
    const e = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", {
      price_in_usd: 0.019310344827586208, price_out_usd: 0.038620689655172416,
    });
    expect(e.origin).toBe("table");
    expect(e.priceIn).toBe(1.32);
    expect(e.priceOut).toBe(3.96);
    expect(e.superseded?.priceIn).toBeCloseTo(0.0193103, 6);
  });

  it("手填价压过表价：origin=manual、不返回 superseded（它就是生效价，不是残留）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "https://api.deepseek.com", {
      price_in_usd: 100, price_out_usd: 200, price_source: "manual",
    });
    expect(e.origin).toBe("manual");
    expect(e.priceIn).toBe(100);
    expect(e.priceOut).toBe(200);
    expect(e.superseded).toBeUndefined();
    expect(e.tiered).toBe(false);
  });

  it("上游结算价同样压过表价（网关说多少就是多少）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "https://opencode.ai/zen/v1", {
      price_in_usd: 0.07, price_out_usd: 0.28, price_source: "upstream",
    });
    expect(e.origin).toBe("upstream");
    expect(e.priceIn).toBe(0.07);
  });

  it("本地端点恒 0，即使存值缺价也不套官方刊例价（此前会按 0.3 凭空记账）", () => {
    
    for (const id of ["deepseek-chat", "deepseek-reasoner"]) {
      const e = resolveEffectivePricing(id, "http://127.0.0.1:8800", {});
      expect(e.origin).toBe("local");
      expect(e.priceIn).toBe(0);
      expect(e.priceOut).toBe(0);
    }
  });

  it("本地端点上若躺着非 0 的无来源存值 → 归零并标 superseded（引擎不采用它）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "http://127.0.0.1:8080/v1", { price_in_usd: 0.3 });
    expect(e.origin).toBe("local");
    expect(e.priceIn).toBe(0);
    expect(e.superseded?.priceIn).toBe(0.3);
  });

  it("本地端点上的手填价仍然是权威的（用户可能真要给自建端点计费）", () => {
    const e = resolveEffectivePricing("local-model", "http://127.0.0.1:8800", {
      price_in_usd: 0.5, price_out_usd: 1, price_source: "manual",
    });
    expect(e.origin).toBe("manual");
    expect(e.priceIn).toBe(0.5);
  });

  it("表里查不到 → 退回存值并标 origin=stored（残留值：引擎采用它，但来源不明）", () => {
    const e = resolveEffectivePricing("my-selfhosted-model", "https://api.example.com/v1", {
      price_in_usd: 1.5, price_out_usd: 3,
    });
    expect(e.origin).toBe("stored");
    expect(e.priceIn).toBe(1.5);
  });

  it("表里查不到且存值也缺 → origin=none（未定价，按 $0 记账，必须让用户看得见）", () => {
    const e = resolveEffectivePricing("zz-unlisted-model-xyz", "https://api.moonshot.cn/v1", {});
    expect(e.origin).toBe("none");
    expect(e.superseded).toBeUndefined();
  });

  it("给了时刻 → origin=tier 并回传档位 id（与不带时刻的 table 区分开）", () => {
    const peak = resolveEffectivePricing("deepseek-flash", "https://api.deepseek.com", {}, bj(WED, 10));
    expect(peak.origin).toBe("tier");
    expect(peak.tierId).toBe("peak");
    expect(peak.priceIn).toBe(0.3);

    const off = resolveEffectivePricing("deepseek-flash", "https://api.deepseek.com", {}, bj(WED, 2));
    expect(off.origin).toBe("tier");
    expect(off.tierId).toBe("offpeak");
    expect(off.priceIn).toBe(0.15);
  });

  it("与旧优先级的行为差异被有意固定：表价 > 存值（存值不再是错值自杀锁）", () => {
    
    
    const e = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", { price_in_usd: 0.0193 });
    expect(e.priceIn).toBe(1.32);
    expect(e.origin).toBe("table");
  });
});














describe("A-988：缓存命中价 / 写入价的解析（绝不留空落回输入价）", () => {
  const DEEPSEEK = "https://api.deepseek.com/v1";

  it("内置表里有已核实的缓存价 → 继承它（不是按输入价，也不是 0）", () => {
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" });
    expect(e.origin).toBe("manual");
    
    expect(e.priceCacheRead).toBe(0.006);
    expect(e.cacheRateReadSource).toBe("table");
    expect(e.priceCacheRead).not.toBe(e.priceIn);
  });

  it("这条修复对账目有实际意义：缓存 100 万 token 的费用从 $0.3 降到 $0.006（50 倍）", () => {
    const withFix = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" });
    
    const oldCost = computeRecordCost(0, 0, 0, 1_000_000, 0, 0.3, 1.2, undefined, undefined, true);
    const newCost = computeRecordCost(0, 0, 0, 1_000_000, 0, 0.3, 1.2, withFix.priceCacheRead, withFix.priceCacheWrite, true);
    expect(oldCost).toBeCloseTo(0.3, 9);
    expect(newCost).toBeCloseTo(0.006, 9);
    expect(oldCost / newCost).toBeCloseTo(50, 6);
  });

  it("用户手填的缓存价 > 内置表继承（用户拿到的合同价永远赢）", () => {
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, {
      price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual", price_cache_read_usd: 0.002,
    });
    expect(e.priceCacheRead).toBe(0.002);
    expect(e.cacheRateReadSource).toBe("stored");
  });

  it("A-988b：来源必须**逐字段**给出，未手填的那个不得跟着一起报 credit", () => {
    
    
    const e = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", {
      price_in_usd: 2, price_out_usd: 8, price_source: "manual", price_cache_read_usd: 0.15,
    });
    expect(e.cacheRateReadSource).toBe("stored");   
    expect(e.cacheRateWriteSource).toBe("ratio");   
  });

  it("表里查不到该家族 → 命中价按 0.1× 输入推导，并标明这是推导值", () => {
    const e = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", {
      price_in_usd: 2, price_out_usd: 8, price_source: "manual",
    });
    expect(e.priceCacheRead).toBeCloseTo(0.2, 9);   
    expect(e.cacheRateReadSource).toBe("ratio");
  });

  it("A-988c：非 Anthropic 家族**不得**凭空造出缓存写入费（写入不收费是多数的默认）", () => {
    
    
    const e = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", {
      price_in_usd: 2, price_out_usd: 8, price_source: "manual",
    });
    expect(e.priceCacheWrite).toBe(0);
    expect(e.cacheRateWriteSource).toBe("ratio");   
  });

  it("A-988c：Anthropic 家族才按 1.25× 推导写入价（唯一明示收 write token 的家族）", () => {
    
    
    expect(cacheWriteRatio("zz-anthropic-write-probe")).toBe(1.25);
    expect(cacheWriteRatio("some-brand-new-model-xyz")).toBe(0);
    const e = resolveEffectivePricing("zz-anthropic-write-probe", "https://api.anthropic.com/v1", {
      price_in_usd: 3, price_out_usd: 15, price_source: "manual",
    });
    expect(e.priceCacheRead).toBeCloseTo(0.3, 9);   
    expect(e.priceCacheWrite).toBeCloseTo(3.75, 9); 
    expect(e.cacheRateReadSource).toBe("ratio");
    expect(e.cacheRateWriteSource).toBe("ratio");
  });

  it("推导值是估算 → UI 必须能区分「继承」与「推导」（否则用户以为 0.1× 是官方价）", () => {
    const inherited = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" });
    const derived = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", { price_in_usd: 2, price_out_usd: 8, price_source: "manual" });
    expect(inherited.cacheRateReadSource).not.toBe(derived.cacheRateReadSource);
    
    const a = describeCacheRateSource(inherited.cacheRateReadSource ?? "none", inherited.priceCacheRead);
    const b = describeCacheRateSource(derived.cacheRateReadSource ?? "none", derived.priceCacheRead);
    expect(a.estimated).toBe(false);
    expect(b.estimated).toBe(true);
    expect(a.text).not.toBe(b.text);
  });

  it("A-988c：write 来源为 ratio 且值为 0 时，文案必须是「推定不收费」而不是「按倍率推导」", () => {
    
    const meta = describeCacheRateSource("ratio", 0);
    expect(meta.text).toContain("不收费");
    expect(meta.estimated).toBe(true);
    
    expect(describeCacheRateSource("ratio", 3.75).text).not.toContain("不收费");
  });

  it("本地端点：缓存价与输入价一起恒 0（免费是正确结果，不是「未定价」）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "http://127.0.0.1:8080/v1", {});
    expect(e.origin).toBe("local");
    expect(e.priceCacheRead).toBe(0);
    expect(e.priceCacheWrite).toBe(0);
  });

  it("未定价：缓存价必须留空，不得由 0 推导出「免费」的假象", () => {
    
    const e = resolveEffectivePricing("zz-unlisted-model-xyz", "https://api.moonshot.cn/v1", {});
    expect(e.origin).toBe("none");
    expect(e.priceCacheRead).toBeUndefined();
  });

  it("分时档也补齐缓存价（档位表只配了 in/out 时不得留空）", () => {
    const peak = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" }, bj(WED, 10));
    
    expect(typeof peak.priceCacheRead).toBe("number");
    const flat = resolveEffectivePricing("deepseek-flash", DEEPSEEK, {}, bj(WED, 10));
    expect(typeof flat.priceCacheRead).toBe("number");
  });
});

describe("A-988c（B3）：用户自定义分时档", () => {
  const DEEPSEEK = "https://api.deepseek.com/v1";

  
  const NIGHT = normalizePriceTiers({
    timezone: "Asia/Shanghai",
    tiers: [
      { id: "night", label: "夜间", windows: [{ startMin: 23 * 60, endMin: 7 * 60 }], priceIn: 0.1, priceOut: 0.4 },
      { id: "base", label: "其余时段", priceIn: 0.5, priceOut: 2 },
    ],
  })!;

  it("normalizePriceTiers 产出可用规格（UI 存下去的就是引擎读到的）", () => {
    expect(NIGHT).toBeDefined();
    expect(NIGHT.timezone).toBe("Asia/Shanghai");
    expect(NIGHT.tiers.length).toBe(2);
  });

  it("跨午夜 23:00-07:00 必须真的命中（早期实现数学上永不命中 → 静默落到兜底档）", () => {
    
    const at = (d: string, h: number, m = 0): string | undefined =>
      resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: NIGHT }, bj(d, h, m)).tierId;
    expect(at(WED, 23, 30)).toBe("night");      
    expect(at("2026-09-17", 6)).toBe("night");  
    expect(at("2026-09-17", 12)).toBe("base");  
    expect(at(WED, 22, 59)).toBe("base");       
    expect(at("2026-09-17", 7)).toBe("base");   
    expect(at(WED, 23)).toBe("night");          
  });

  it("跨午夜窗口的次日段只能归「窗口开始那天」的星期（多算一天 = 多错一整段账）", () => {
    
    
    const fri = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [
        { id: "frinight", windows: [{ days: [5], startMin: 23 * 60, endMin: 7 * 60 }], priceIn: 0.1 },
        { id: "base", priceIn: 0.5 },
      ],
    })!;
    const at = (d: string, h: number, m = 0): string | undefined =>
      resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: fri }, bj(d, h, m)).tierId;
    expect(at("2026-09-18", 23, 30)).toBe("frinight"); 
    expect(at("2026-09-19", 6)).toBe("frinight");      
    expect(at("2026-09-19", 23, 30)).toBe("base");     
    expect(at("2026-09-18", 12)).toBe("base");         
  });

  it("endMin === startMin 视为空窗口（永不命中），不得被当成「一整天」", () => {
    const empty = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [{ id: "never", windows: [{ startMin: 600, endMin: 600 }], priceIn: 0.01 }, { id: "base", priceIn: 0.5 }],
    })!;
    expect(resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: empty }, bj(WED, 10)).tierId).toBe("base");
    expect(resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: empty }, bj(WED, 10)).priceIn).toBe(0.5);
  });

  it("自定义分时档压过手填平铺价（档位表是更强的显式意图）", () => {
    
    
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK,
      { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual", price_tiers: NIGHT }, bj(WED, 23, 30));
    expect(e.origin).toBe("customTier");
    expect(e.priceIn).toBe(0.1);
    expect(e.priceOut).toBe(0.4);
    
    expect(e.superseded?.priceIn).toBe(0.3);
  });

  it("自定义档位缺缓存价时，逐字段走 stored→内置表→倍率链（不得留空落回输入价）", () => {
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: NIGHT }, bj(WED, 23, 30));
    expect(typeof e.priceCacheRead).toBe("number");
    expect(e.priceCacheRead).not.toBe(e.priceIn);
    expect(e.cacheRateReadSource).toBe("table"); 
  });

  it("档位自带缓存价 → 来源标 tier（档位比家族基价更具体）", () => {
    const t = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [{ id: "only", priceIn: 1, priceOut: 2, priceCacheRead: 0.05, priceCacheWrite: 1.1 }],
    })!;
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: t }, bj(WED, 10));
    expect(e.priceCacheRead).toBe(0.05);
    expect(e.priceCacheWrite).toBe(1.1);
    expect(e.cacheRateReadSource).toBe("tier");
    expect(e.cacheRateWriteSource).toBe("tier");
  });

  it("无时刻信息 → 取兜底档且 tiered=false（不猜档位，否则 UI 每次渲染都在跳）", () => {
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: NIGHT });
    expect(e.origin).toBe("customTier");
    expect(e.tiered).toBe(false);
    expect(e.priceIn).toBe(0.5); 
  });

  it("自定义分时是「显式意图」→ 仍然压过本地端点判定（自己写的价自己负责）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "http://127.0.0.1:8800/v1", { price_tiers: NIGHT }, bj(WED, 23, 30));
    expect(e.origin).toBe("customTier");
    expect(e.priceIn).toBe(0.1);
  });

  it("normalizePriceTiers 拒绝脏数据（宁可不生效，也不写一份会静默算错的配置）", () => {
    expect(normalizePriceTiers(null)).toBeUndefined();
    expect(normalizePriceTiers(undefined)).toBeUndefined();
    expect(normalizePriceTiers({})).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai" })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [] })).toBeUndefined();
    
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: "0.5" }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: NaN }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "", priceIn: 1 }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [null, 42] })).toBeUndefined();
    
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: 1, windows: [{ startMin: -1, endMin: 10 }] }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: 1, windows: [{ startMin: 0, endMin: 1440 }] }] })).toBeUndefined();
    
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "free", priceIn: 0, priceOut: 0 }] })?.tiers[0].priceIn).toBe(0);
  });

  it("时段被写坏的档位必须整体丢弃，绝不能「退化成兜底档」而全天按它计费", () => {
    
    
    const t = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [
        { id: "peak", windows: [{ startMin: -5, endMin: 9999 }], priceIn: 9 },   
        { id: "base", priceIn: 0.5 },                                            
      ],
    })!;
    expect(t.tiers.map((x) => x.id)).toEqual(["base"]);
    
    expect(resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: t }, bj(WED, 10)).priceIn).toBe(0.5);
  });

  it("normalizePriceTiers 容忍并净化半脏输入：非法星期就地剔除、排序，超长文本修剪", () => {
    
    
    const t = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [
        { id: "a", priceIn: 1, windows: [{ days: [3, 1, 1, 9, -1], startMin: 0, endMin: 60 }] },
        { id: "b", label: "x".repeat(200), priceIn: 2 },
      ],
    })!;
    expect(t).toBeDefined();
    expect(t.tiers[0].windows![0].days).toEqual([1, 3]);
    expect(t.tiers[1].label!.length).toBeLessThanOrEqual(40);
    
    const daily = normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: 1, windows: [{ days: [], startMin: 0, endMin: 60 }] }] })!;
    expect(daily.tiers[0].windows![0].days).toBeUndefined();
  });

  it("builtInPriceTiers 返回深拷贝（UI 就地编辑不得污染内置真相源）", () => {
    const a = builtInPriceTiers("deepseek-flash")!;
    a.tiers[0].priceIn = 999;
    a.tiers[0].windows![0].startMin = 0;
    expect(builtInPriceTiers("deepseek-flash")!.tiers[0].priceIn).not.toBe(999);
    expect(builtInPriceTiers("deepseek-flash")!.tiers[0].windows![0].startMin).not.toBe(0);
    
    expect(builtInPriceTiers("kimi-k2-0711-preview")).toBeUndefined();
  });

  it("createDefaultPriceTiers：空闲档 = 基准半价，时区随环境", () => {
    const t = createDefaultPriceTiers(1, 4);
    expect(t.tiers.length).toBe(2);
    expect(t.tiers[0].priceIn).toBe(1);
    expect(t.tiers[1].priceIn).toBe(0.5);
    expect(t.tiers[1].priceOut).toBe(2);
    expect(describeTierSpec(t)).toContain("（Asia/Shanghai）");
    expect(describeTierSpec(t)).not.toContain("（次日）"); 
  });

  it("跨午夜时段在文案里必须标出「（次日）」（否则 23:00-07:00 会被读成从早到晚）", () => {
    expect(describeTierSpec(NIGHT)).toContain("（次日）");
    expect(describeTierSpec(NIGHT)).toContain("夜间");
  });
});

describe("源码守卫：分时的接线点不能被「重构」掉", () => {
  
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const readSrc = (rel: string): string => strip(readFileSync(join(process.cwd(), rel), "utf8"));

  it("A-988c（B1）：价目明细行的标题与「收起」按钮必须**双保险**防换行", () => {
    
    
    
    
    
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    
    
    
    const defIdx = panel.indexOf("function PriceDetailRow");
    expect(defIdx).toBeGreaterThan(0); 
    const start = panel.indexOf("价目明细 ·", defIdx);
    expect(start).toBeGreaterThan(defIdx);
    const row = panel.slice(start, start + 2600);

    
    expect(row).toMatch(/whiteSpace:\s*"nowrap"/);
    
    expect(row).toMatch(/flexShrink:\s*0/);
    
    
    expect(row).toMatch(/flex:\s*"1 1 auto"/);
    expect(row).toMatch(/textOverflow:\s*"ellipsis"/);
    
    expect(row).toMatch(/flexWrap:\s*"nowrap"/);
    
    
    expect((row.match(/flexShrink:\s*0/g) ?? []).length).toBeGreaterThanOrEqual(2);
    
    expect(row).not.toContain("价目明细 · |");
  });

  it("engine.recordUsage 的取价必须走共享的 resolveEffectivePricing（不得再自建一套优先级）", () => {
    const src = readSrc("core-ts/src/services/engine.ts");
    
    
    
    expect(src).toContain('resolveEffectivePricing(modelId, route?.baseUrl ?? "", spec, at)');
    expect(src).toContain("price_tier: eff.tiered ? eff.tierId : undefined");
    
    expect(src).toContain("const at = new Date();");
    expect(src).toContain("const ts = at.toISOString();");
    
    expect(src).not.toContain("const fallback = spec?.price_in_usd === undefined");
    expect(src).not.toContain("const useTier =");
  });

  it("面板的定价列必须用同一个 resolveEffectivePricing（否则显示与账目会再次分裂）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(panel).toContain("resolveEffectivePricing(m.id, baseUrl, m)");
    
    
    
    
    expect(panel).toContain("function PriceDetailRow");
    expect(panel).toContain("amountInCurrency(eff, FIELD_KEY[f], cur)");
    
    
    
    
    expect(panel).toMatch(/const tierActive = [^\n]*eff\.origin === "customTier"/);
    expect(panel).toContain("{tierActive && (");
  });

  it("A-1001：价目明细的主口径必须是「此刻」（带时刻），否则与下方「● 当前」档位标记同屏打架", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    










    
    
    expect(panel).toContain("const eff = resolveEffectivePricing(m.id, baseUrl, m, new Date());");
    
    expect(panel).toContain("const effFlat = resolveEffectivePricing(m.id, baseUrl, m);");
    expect(panel).toContain("const cny = effFlat[CNY_KEY[FIELD_KEY[f]]];");
    expect(panel).toContain("effFlat.superseded");
    
    expect(panel).not.toContain("const cny = eff[CNY_KEY[FIELD_KEY[f]]];");
    
    expect(panel).toContain('${eff.tiered ? "当前计费价" : "计费价"}');
    
    expect(panel).toContain("const tierName = eff.tiered ?");
    expect(panel).toContain("`当前生效 ${effText ?? \"未定价\"}${tierName}`");
    
    
    expect(panel).toContain("setClockTick((n) => n + 1)");
    expect(panel).toContain("30_000");
  });

  it("A-1002：分时界面与手动单价界面**互斥显示**（默认给「引擎此刻采用的那一套」）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    








    
    expect(panel).toContain('{view === "manual" && (<>');
    expect(panel).toContain('{view === "tier" && (<>');
    
    const tierIdx = panel.indexOf("<TierEditor m={m} eff={eff}");
    const gateIdx = panel.lastIndexOf('{view === "tier" && (<>', tierIdx);
    expect(gateIdx, "TierEditor 没有被 tier 视图包住").toBeGreaterThan(-1);
    expect(tierIdx - gateIdx).toBeLessThan(900);
    
    expect(panel).toContain('const tierActive = hasTierSpec && (eff.origin === "table" || eff.origin === "tier" || eff.origin === "customTier");');
    expect(panel).toContain('const defaultView: PriceView = tierActive ? "tier" : "manual";');
    
    expect(panel).toContain("const [viewOverride, setViewOverride] = useState<PriceView | null>(null);");
    expect(panel).toContain("const view: PriceView = viewOverride ?? defaultView;");
    
    expect(panel).toContain("PRICE_VIEW_TABS");
    
    expect(panel).toMatch(/>\s*清空手填\s*<\/button>/);
    expect(panel).toContain("定价方式");
    
    
    
    expect(panel).toContain("const manualInEffect = eff.origin === \"manual\";");
    expect(panel).toContain("{view === \"tier\" && (manualInEffect || eff.superseded) && (");
    
    expect(panel).toContain("onClick={onClearManual}");
    
    expect(panel).toContain("key={mm.id}");
  });

  it("A-1002b：切换条选中态必须写 `border` 简写（`.btn` 无边框，只写 `borderColor` 是静默失效）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    const css = readFileSync(join(process.cwd(), "gui/src/renderer/index.css"), "utf8");
    









    expect(css, "`.btn` 契约变了（不再是 border:none）→ 请复核本守卫是否仍必要")
      .toMatch(/\.btn\s*\{[^}]*border:\s*none/);
    expect(panel).toContain('border: `1px solid ${on ? "var(--accent, #8b7bf7)" : "transparent"}`');
    
    expect(panel).toContain('border: `1px solid ${cur === c ? "var(--accent, #8b7bf7)" : "transparent"}`');
    
    expect(panel).not.toContain("borderColor: on ?");
    expect(panel).not.toContain("borderColor: cur === c ?");
  });

  it("模型表格必须适配弹窗宽度（minWidth 会把表格顶出容器 → 左右两端被裁）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    
    
    expect(panel).not.toContain("minWidth: 920");
    expect(panel).not.toContain("minWidth: 880");
    expect(panel).toContain("tableLayout: \"fixed\"");
    
    expect(panel).toContain(">上下文K</th>");
    expect(panel).toContain(">输出K</th>");
    
    
    expect(panel).toContain(">定价来源</th>");
    
    expect(panel).toContain('textOverflow: "ellipsis"');
    const table = panel.slice(panel.indexOf("<table style={{ width: \"100%\""), panel.indexOf("</table>"));
    expect(table.length).toBeGreaterThan(500); 
    expect(table).not.toContain("wordBreak");
    
    
    expect(table).not.toContain("单价 $/M");
    expect(table).not.toContain('updateDraftPrice(i, "price_in_usd"');
  });

  it("A-988：数字输入框必须靠 CSS 关掉 spinner（spinner 吃 18px = 用户看到的「10:」）", () => {
    
    
    
    const css = readFileSync(join(process.cwd(), "gui/src/renderer/index.css"), "utf8");
    expect(css).toContain(".provider-model-table input[type=\"number\"]");
    expect(css).toContain("-webkit-outer-spin-button");
    expect(css).toContain("appearance: textfield");
    
    expect(css).not.toMatch(/^input\[type="number"\]\s*\{/m);
    
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(panel).toContain('className="provider-model-table"');
  });

  it("A-988：列宽预算必须容得下最坏内容（数字来自真实 Chromium 实测，不是纸面推算）", () => {
    
















    const TABLE_W_WORST = 628.6; 
    const INPUT_CHROME = 12 + 1.6; 
    const NEED = { toggle: 40, cellText: 26.7, priceText: 50.05, badge: 103.93 };

    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    
    const ths = [...panel.matchAll(/<th style=\{\{ padding: "([^"]+)"(?:, width: "([\d.]+)%")?/g)].map((m) => ({
      pad: m[1],
      pct: m[2] === undefined ? null : Number(m[2]),
    }));
    expect(ths.length).toBe(6); 

    const colW = (pct: number) => (TABLE_W_WORST * pct) / 100;
    
    const padX = (pad: string) => {
      const p = pad.split(" ").map((s) => parseFloat(s));
      const left = p.length === 4 ? p[3] : p[1];
      return left + p[1];
    };
    
    const cellAvail = (i: number) => colW(ths[i].pct as number) - padX(ths[i].pad);

    
    const autoCols = ths.map((t, i) => (t.pct === null ? i : -1)).filter((i) => i >= 0);
    expect(autoCols).toEqual([1]);
    const pctSum = ths.reduce((s, t) => s + (t.pct ?? 0), 0);
    expect(pctSum).toBeLessThanOrEqual(80); 

    
    expect(cellAvail(0)).toBeGreaterThanOrEqual(NEED.toggle);

    
    for (const i of [2, 3]) {
      expect(cellAvail(i) - INPUT_CHROME).toBeGreaterThanOrEqual(NEED.cellText);
      
      expect(cellAvail(i)).toBeGreaterThan(44.4); 
    }

    
    
    expect(cellAvail(5)).toBeGreaterThanOrEqual(NEED.badge);
  });

  it("usage.recomputeOne 把记录自己的 ts 传给解析器（不是 now）", () => {
    const src = readSrc("core-ts/src/services/usage.ts");
    expect(src).toContain("resolve(rec.provider_key, rec.model, rec.ts)");
    expect(src).toContain("next.price_tier = price.tierId");
  });

  it("providers.makePriceResolver 必须收敛到 resolveEffectivePricing（不得再自建第三套优先级）", () => {
    const src = readSrc("gui/src/main/providers.ts");
    
    
    
    expect(src).toContain('resolveEffectivePricing(model, String(rec?.api_base ?? ""), hit, ts)');
    expect(src).not.toContain("inferPricingFromUrl(String(rec?.api_base");
    expect(src).not.toContain("tierId: t.tier_id");
    
    expect(src).toContain('if (eff.origin === "none") { return undefined; }');
    
    expect(src).toContain("priceCacheRead: eff.priceCacheRead");
  });

  it("deepseek 表项必须同时带 priceTiers 与高峰平铺价（只留一个 = 功能失效或价错）", () => {
    const src = readSrc("shared/gen/model-capabilities.ts");
    expect(src).toContain("DEEPSEEK_PEAK_WINDOWS");
    expect(src).toContain('const DEEPSEEK_TZ = "Asia/Shanghai"');
    
    expect(src).toContain("startMin: 9 * 60, endMin: 12 * 60");
    expect(src).toContain("startMin: 14 * 60, endMin: 18 * 60");
    
    expect(src).not.toContain("priceIn: 0.225");
    expect(src).not.toContain("priceIn: 0.99");
  });

  it("本地端点判定只有一份实现（两处各写一遍 = 迟早分裂）", () => {
    const shared = readSrc("shared/gen/model-capabilities.ts");
    expect(shared).toContain("export function isLocalEndpoint");
    
    const providers = readSrc("gui/src/main/providers.ts");
    expect(providers).not.toContain("127\\.0\\.0\\.1");
    expect(providers).toContain("isLocalEndpoint(base)");
  });

  it("刷新逻辑必须过 mergeModelPrice（漏了 = 一键刷新静默抹掉用户手填的议价）", () => {
    const providers = readSrc("gui/src/main/providers.ts");
    for (const fn of ["saveProvider", "refreshProviderModels"]) {
      const i = providers.indexOf(`export async function ${fn}`);
      expect(i, `${fn} 不存在`).toBeGreaterThan(-1);
      
      const nextExport = providers.indexOf("\nexport ", i + 10);
      const body = providers.slice(i, nextExport > 0 ? nextExport : i + 6000);
      expect(body, `${fn} 未调用 mergeModelPrice`).toContain("mergeModelPrice(");
    }
  });

  it("A-988：四个费率字段都必须可手填并落盘（只做输入/输出 = 缓存价被静默按全价计）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    
    for (const f of ["price_in_usd", "price_out_usd", "price_cache_read_usd", "price_cache_write_usd"]) {
      expect(panel, `缺少手填字段 ${f}`).toContain(f);
    }
    
    expect(panel).toContain("const PRICE_FIELDS: PriceField[]");
    expect(panel).toContain("PRICE_FIELDS.some(");
    
    expect(panel).toContain("price_cache_read_usd: m.price_cache_read_usd ?? undefined");
    expect(panel).toContain("price_cache_write_usd: m.price_cache_write_usd ?? undefined");
    
    
    
    
    expect(panel).toContain("<PriceDetailRow");
    expect(panel).toContain("className=\"price-detail-block\"");
    expect(panel).not.toContain("className=\"price-detail-row\"");
  });
});
