/**
 * tests/core-ts/pricing-tiers.spec.ts — 分时（峰谷）定价回归测试。
 *
 * 背景：峰谷分时已是主流计价模式（DeepSeek 等），而旧的 `priceIn/priceOut` 是单一数值，
 * 只能取「峰谷均值」—— 一个**在任何真实时段都不存在**的价格，单条记录最多偏 ±33%。
 * 本文件锁死新语义：**按每条记录自己的 ts 命中档位**计费，并给出可对账的 `price_tier`。
 *
 * 三个最容易写错、且写错了不报错的地方，逐条锁死：
 *   ① **时区**：高峰窗是「北京时间」，不是 UTC、更不是本机时区。错 8 小时 → 整段账单错档；
 *   ② **边界**：09:00-12:00 / 14:00-18:00 必须左闭右开，午休 12:00-14:00 是空闲；
 *   ③ **优先级**：存值（表快照）必须让位于分时规格，否则整套功能形同虚设；
 *      反过来，手填价 / 上游结算价 / 本地端点必须**压过**分时价（不得凭空计费）。
 */
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

/* ─────────── 北京时间 ↔ UTC 换算基准（UTC+8，无夏令时） ───────────
 * 2026-09-16 是周三；2026-09-19 周六；2026-09-20 周日；2026-09-21 周一。
 * 北京时间 HH:mm == 同日 UTC (HH-8):mm。
 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 由「某个日期的北京时间 H:M:S」造出对应的 ISO 时刻（便于直读边界用例） */
function bj(isoDate: string, h: number, m = 0, s = 0): string {
  const base = new Date(`${isoDate}T00:00:00Z`).getTime();
  return new Date(base + h * 3600_000 + m * 60_000 + s * 1000 - TZ_OFFSET_MS).toISOString();
}
const WED = "2026-09-16"; // 周三
const MON = "2026-09-21"; // 周一
const SAT = "2026-09-19"; // 周六
const SUN = "2026-09-20"; // 周日

describe("resolveModelPriceTier：DeepSeek 峰谷档位", () => {
  it("高峰时段（北京时间周三 10:00）→ peak 档，价格 = 高峰价", () => {
    const r = resolveModelPriceTier("deepseek-flash", bj(WED, 10));
    expect(r.tiered).toBe(true);
    expect(r.tierId).toBe("peak");
    expect(r.timezone).toBe("Asia/Shanghai");
    // 官方英文定价页（核实 2026-09-16）：flash 高峰 = 输入 0.30 / 输出 1.20 / 命中 0.006
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
    // 已废弃的峰谷均值 0.225 不得再出现：它在任何真实时段都不存在
    expect(flat.priceIn).not.toBeCloseTo(0.225, 6);
    // 不传 at → tiered=false，走平铺价（保证面板展示/预填结果确定、不随时间跳动）
    const r = resolveModelPriceTier("deepseek-flash");
    expect(r.tiered).toBe(false);
    expect(r.tierId).toBe("flat");
    expect(r.pricing.priceIn).toBeCloseTo(0.3, 9);
  });

  it("无分时规格的模型 → tiered=false（不得把平铺价硬说成某个档位）", () => {
    // 内置表有价、且与快照**数值一致** → 用内置表价（一手核实），tierId="flat"。
    // 这是 ③-2 的修正结果：快照是机器同步的二手镜像，数值一致时不该把一手价降级成二手来源
    // （否则面板会显示「快照兜底」，暗示"这价 slime 没核实过"，用户就不去复核了）。
    const r = resolveModelPriceTier("claude-sonnet-4-20250514", bj(WED, 10));
    expect(r.tiered).toBe(false);
    expect(r.tierId).toBe("flat");
    expect(r.timezone).toBeUndefined();
    expect(r.pricing.priceIn).toBeCloseTo(3, 9);

    // A-989：内置表**完全没价**、纯由权威快照（LiteLLM 首方刊例价）补位 → tierId="snapshot"。
    // 两者都表示"没有分时档位"，区分开是为了让排障时能看出价是内置表给的还是二手镜像给的。
    const snap = resolveModelPriceTier("kimi-k2", bj(WED, 10));
    expect(snap.tiered).toBe(false);
    expect(snap.tierId).toBe("snapshot");
    expect(snap.pricing.priceIn).toBeGreaterThan(0);
  });

  it("查不到价的模型 → pricing 为空、tiered=false（仍是「未定价」，不是免费）", () => {
    // A-989：这里原本用 kimi-k2-0711-preview 当"未知模型"，但快照层上线后 kimi 已经有权威价了 ——
    // 「未定价」分支必须用**真正没有数据**的 id 来验，否则测的其实是"kimi 有价"这件事。
    const r = resolveModelPriceTier("zz-unlisted-model-xyz", bj(WED, 10));
    expect(r.tiered).toBe(false);
    expect(r.pricing).toEqual({});
  });
});

describe("resolveModelPriceTier：时段边界（左闭右开）", () => {
  const at = (h: number, m = 0, s = 0): string => resolveModelPriceTier("deepseek-flash", bj(WED, h, m, s)).tierId;

  it("上午场 09:00-12:00：起点含、终点不含", () => {
    expect(at(8, 59, 59)).toBe("offpeak"); // 08:59:59 仍空闲
    expect(at(9, 0, 0)).toBe("peak");      // 09:00:00 进高峰
    expect(at(11, 59, 59)).toBe("peak");   // 11:59:59 仍高峰
    expect(at(12, 0, 0)).toBe("offpeak");  // 12:00:00 出高峰（午休）
  });

  it("午休 12:00-14:00 是空闲（最易被写成一整段 09:00-18:00）", () => {
    expect(at(12, 30)).toBe("offpeak");
    expect(at(13, 59, 59)).toBe("offpeak");
  });

  it("下午场 14:00-18:00：起点含、终点不含", () => {
    expect(at(14, 0, 0)).toBe("peak");
    expect(at(17, 59, 59)).toBe("peak");
    expect(at(18, 0, 0)).toBe("offpeak"); // 18:00:00 出高峰（晚间空闲）
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
    // 这条用例同时是「时区写错」的探针：把 Asia/Shanghai 改成 UTC 就会红
    expect(resolveModelPriceTier("deepseek-flash", "2026-09-16T02:00:00Z").tierId).toBe("peak");
  });

  it("UTC 16:00 实为北京时间次日 00:00 → 空闲；若错按 UTC 判会落在 14:00-18:00 高峰", () => {
    expect(resolveModelPriceTier("deepseek-flash", "2026-09-16T16:00:00Z").tierId).toBe("offpeak");
  });

  it("周一（北京）09:30 的高峰请求：UTC 侧是周一凌晨，若用 UTC 连星期都会算错", () => {
    // 北京时间 2026-09-21（周一）09:30 == UTC 2026-09-21T01:30Z
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
    // 兜底档必须给出**非零**价：宁可退回标准价，也不能把成本静默清零
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
    expect(costPeak).toBeCloseTo(1.5, 9);  // (1M×0.30 + 1M×1.20)/1e6
    expect(costOff).toBeCloseTo(0.75, 9);  // (1M×0.15 + 1M×0.60)/1e6
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
    expect(next.cost_usd).toBeCloseTo(0.3, 9); // 1M × 0.30 / 1e6
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
    // 不传 ts → 平铺价（向后兼容：老调用点不关心分时）
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
    expect([0.15, 0.3]).toContain(e.priceIn); // 不传 at → 平铺价（高峰标准价 0.3）
    expect(e.priceOut).toBe(1.2);
  });

  it("存值是机器写下的历史错值（无来源标记）→ 被表价取代，且把错值回传给 UI 标注", () => {
    // 真实数据：providers.enc.json 里 deepseek-v4-pro 存着 0.0193（美元刊例价又被按人民币除了一次 7.25）
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
    // 用户真实配置：deepseek-chat provider 指向 http://127.0.0.1:8800，两个模型都没有任何价格字段
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
    // 旧 engine 写法是 `spec?.price_in_usd ?? fallback`，无来源的错值会永远赢过人工核对的表。
    // 新语义与历史回填（makePriceResolver）一致：人工核对的表压过历史落库值。
    const e = resolveEffectivePricing("deepseek-v4-pro", "https://api.deepseek.com", { price_in_usd: 0.0193 });
    expect(e.priceIn).toBe(1.32);
    expect(e.origin).toBe("table");
  });
});

/**
 * A-988：缓存命中价绝不允许"留空后落回输入价"。
 *
 * 事故形态（用户这次问的正是这一点）：面板只让填输入/输出两个框。用户手填 0.3 / 1.2 后
 * `price_source: "manual"`，`resolveEffectivePricing` 的 manual 分支只透传
 * `stored.price_cache_read_usd`（未填 → undefined）→ `computeRecordCost` 的兜底
 * `priceCacheReadUsd ?? priceInUsd` 生效 → **缓存命中部分按 0.3 全价记账**，
 * 而真实价是内置表里的 0.006。同一批 token 虚高 50 倍，且因为"看着有数字"而极难发现。
 *
 * 修法（对标 LiteLLM 的文档化取舍：覆盖基准价时缓存字段从后端模型默认条目继承，
 * 免得缓存部分被静默按 0 计 —— slime 这里的失败方向相反但更贵，是"静默按全价计"）：
 *   **手填/上游存值 > 内置表继承 > 行业倍率推导（0.1× 输入 / 1.25× 输入）**。
 */
describe("A-988：缓存命中价 / 写入价的解析（绝不留空落回输入价）", () => {
  const DEEPSEEK = "https://api.deepseek.com/v1";

  it("内置表里有已核实的缓存价 → 继承它（不是按输入价，也不是 0）", () => {
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" });
    expect(e.origin).toBe("manual");
    // 关键：用户只填了输入/输出，缓存价必须**自动**落到表里的 0.006，而不是 0.3
    expect(e.priceCacheRead).toBe(0.006);
    expect(e.cacheRateReadSource).toBe("table");
    expect(e.priceCacheRead).not.toBe(e.priceIn);
  });

  it("这条修复对账目有实际意义：缓存 100 万 token 的费用从 $0.3 降到 $0.006（50 倍）", () => {
    const withFix = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" });
    // 旧行为的等价写法：显式传 undefined 缓存价 → computeRecordCost 落回输入价
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
    // 用户看到的自相矛盾：只手填了「缓存命中」，同一行的「缓存写入」格子写「未定价」
    // 而旁边徽标却报「手填/上游」—— 两个字段互相打脸。
    const e = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", {
      price_in_usd: 2, price_out_usd: 8, price_source: "manual", price_cache_read_usd: 0.15,
    });
    expect(e.cacheRateReadSource).toBe("stored");   // 手填了 → credit 归用户
    expect(e.cacheRateWriteSource).toBe("ratio");   // 没手填 → 如实说是推导的
  });

  it("表里查不到该家族 → 命中价按 0.1× 输入推导，并标明这是推导值", () => {
    const e = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", {
      price_in_usd: 2, price_out_usd: 8, price_source: "manual",
    });
    expect(e.priceCacheRead).toBeCloseTo(0.2, 9);   // = 2 × 0.1（OpenAI / Anthropic 的命中倍率）
    expect(e.cacheRateReadSource).toBe("ratio");
  });

  it("A-988c：非 Anthropic 家族**不得**凭空造出缓存写入费（写入不收费是多数的默认）", () => {
    // 旧实现无条件按 1.25× 推导 → deepseek-flash 的「缓存写入」会显示 2.5 倍的编造价，
    // 用户据此手填就把假价写进了配置。这比"少一个字段"更贵：它污染后续所有记账。
    const e = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", {
      price_in_usd: 2, price_out_usd: 8, price_source: "manual",
    });
    expect(e.priceCacheWrite).toBe(0);
    expect(e.cacheRateWriteSource).toBe("ratio");   // 来源仍是"推导"，但推导结论是 0
  });

  it("A-988c：Anthropic 家族才按 1.25× 推导写入价（唯一明示收 write token 的家族）", () => {
    // ⚠️ 模型名必须**命中 write 正则但不命中内置价目表**，否则走的是 table 分支、
    // 测不到这条推导规则（实测 `claude-sonnet-4-6-*` 会命中 claude 家族表）。
    expect(cacheWriteRatio("zz-anthropic-write-probe")).toBe(1.25);
    expect(cacheWriteRatio("some-brand-new-model-xyz")).toBe(0);
    const e = resolveEffectivePricing("zz-anthropic-write-probe", "https://api.anthropic.com/v1", {
      price_in_usd: 3, price_out_usd: 15, price_source: "manual",
    });
    expect(e.priceCacheRead).toBeCloseTo(0.3, 9);   // 3 × 0.1
    expect(e.priceCacheWrite).toBeCloseTo(3.75, 9); // 3 × 1.25
    expect(e.cacheRateReadSource).toBe("ratio");
    expect(e.cacheRateWriteSource).toBe("ratio");
  });

  it("推导值是估算 → UI 必须能区分「继承」与「推导」（否则用户以为 0.1× 是官方价）", () => {
    const inherited = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" });
    const derived = resolveEffectivePricing("some-brand-new-model-xyz", "https://api.example.com/v1", { price_in_usd: 2, price_out_usd: 8, price_source: "manual" });
    expect(inherited.cacheRateReadSource).not.toBe(derived.cacheRateReadSource);
    // 文案也必须不同：否则「内置表继承」与「按倍率推导」在 UI 上长得一样
    const a = describeCacheRateSource(inherited.cacheRateReadSource ?? "none", inherited.priceCacheRead);
    const b = describeCacheRateSource(derived.cacheRateReadSource ?? "none", derived.priceCacheRead);
    expect(a.estimated).toBe(false);
    expect(b.estimated).toBe(true);
    expect(a.text).not.toBe(b.text);
  });

  it("A-988c：write 来源为 ratio 且值为 0 时，文案必须是「推定不收费」而不是「按倍率推导」", () => {
    // 共用一句「按倍率推导」会让用户以为我们算错了（1.25 × 2 = 0？）
    const meta = describeCacheRateSource("ratio", 0);
    expect(meta.text).toContain("不收费");
    expect(meta.estimated).toBe(true);
    // 对照组：值非 0 时才是真的倍率推导
    expect(describeCacheRateSource("ratio", 3.75).text).not.toContain("不收费");
  });

  it("本地端点：缓存价与输入价一起恒 0（免费是正确结果，不是「未定价」）", () => {
    const e = resolveEffectivePricing("deepseek-flash", "http://127.0.0.1:8080/v1", {});
    expect(e.origin).toBe("local");
    expect(e.priceCacheRead).toBe(0);
    expect(e.priceCacheWrite).toBe(0);
  });

  it("未定价：缓存价必须留空，不得由 0 推导出「免费」的假象", () => {
    // 0.1 × 0 = 0 → 如果在这里套倍率推导，「未定价」会被伪装成「缓存免费」，账目上无法分辨
    const e = resolveEffectivePricing("zz-unlisted-model-xyz", "https://api.moonshot.cn/v1", {});
    expect(e.origin).toBe("none");
    expect(e.priceCacheRead).toBeUndefined();
  });

  it("分时档也补齐缓存价（档位表只配了 in/out 时不得留空）", () => {
    const peak = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual" }, bj(WED, 10));
    // 手填价压过分时 → 走 manual 分支，但缓存价仍要给出来
    expect(typeof peak.priceCacheRead).toBe("number");
    const flat = resolveEffectivePricing("deepseek-flash", DEEPSEEK, {}, bj(WED, 10));
    expect(typeof flat.priceCacheRead).toBe("number");
  });
});

describe("A-988c（B3）：用户自定义分时档", () => {
  const DEEPSEEK = "https://api.deepseek.com/v1";

  /** 用户自定：每天 23:00→07:00 半价（**跨午夜**），其余走兜底档 */
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
    // 症状是「设了夜间档却一直按高峰价计费」—— 不报错、不崩溃，纯静默错账。
    const at = (d: string, h: number, m = 0): string | undefined =>
      resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: NIGHT }, bj(d, h, m)).tierId;
    expect(at(WED, 23, 30)).toBe("night");      // 周三 23:30 —— 窗口开始当天
    expect(at("2026-09-17", 6)).toBe("night");  // 周四 06:00 —— 窗口落在次日凌晨
    expect(at("2026-09-17", 12)).toBe("base");  // 周四 12:00 —— 早过了 07:00
    expect(at(WED, 22, 59)).toBe("base");       // 周三 22:59 —— 还差一分钟
    expect(at("2026-09-17", 7)).toBe("base");   // **左闭右开**：07:00 整已出窗
    expect(at(WED, 23)).toBe("night");          // 23:00 整进窗
  });

  it("跨午夜窗口的次日段只能归「窗口开始那天」的星期（多算一天 = 多错一整段账）", () => {
    // days=[5]（周五）23:00→07:00：命中周五 23:30 与周六 06:00，**不**命中周六 23:30。
    // 与 OpenRouter 文档一致："the override applies to the UTC day the window starts"。
    const fri = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [
        { id: "frinight", windows: [{ days: [5], startMin: 23 * 60, endMin: 7 * 60 }], priceIn: 0.1 },
        { id: "base", priceIn: 0.5 },
      ],
    })!;
    const at = (d: string, h: number, m = 0): string | undefined =>
      resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: fri }, bj(d, h, m)).tierId;
    expect(at("2026-09-18", 23, 30)).toBe("frinight"); // 周五 23:30
    expect(at("2026-09-19", 6)).toBe("frinight");      // 周六 06:00（窗口始于周五）
    expect(at("2026-09-19", 23, 30)).toBe("base");     // 周六 23:30 —— 不属于周五那一段
    expect(at("2026-09-18", 12)).toBe("base");         // 周五中午
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
    // 若手填分支先返回，用户填了档位表却仍按那个平铺数字计费，
    // 而面板顶部状态条显示「手填」—— 界面与账目再次分裂。
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK,
      { price_in_usd: 0.3, price_out_usd: 1.2, price_source: "manual", price_tiers: NIGHT }, bj(WED, 23, 30));
    expect(e.origin).toBe("customTier");
    expect(e.priceIn).toBe(0.1);
    expect(e.priceOut).toBe(0.4);
    // 被取代的平铺值要如实回传，UI 才能提示而不是让用户猜
    expect(e.superseded?.priceIn).toBe(0.3);
  });

  it("自定义档位缺缓存价时，逐字段走 stored→内置表→倍率链（不得留空落回输入价）", () => {
    const e = resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: NIGHT }, bj(WED, 23, 30));
    expect(typeof e.priceCacheRead).toBe("number");
    expect(e.priceCacheRead).not.toBe(e.priceIn);
    expect(e.cacheRateReadSource).toBe("table"); // 内置表里有已核实的 0.006
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
    expect(e.priceIn).toBe(0.5); // 兜底档，不是夜间档
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
    // 价格只认数字：字符串 "0.5" 会让 `typeof === "number"` 全线失守 → 整档丢
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: "0.5" }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: NaN }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "", priceIn: 1 }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [null, 42] })).toBeUndefined();
    // 写明了时段但全不合法 → 整档丢弃（**不许退化成兜底档**，见下一条）
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: 1, windows: [{ startMin: -1, endMin: 10 }] }] })).toBeUndefined();
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: 1, windows: [{ startMin: 0, endMin: 1440 }] }] })).toBeUndefined();
    // 但 **0 是合法价格**（官方限时免费）—— 不许当作"没填"
    expect(normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "free", priceIn: 0, priceOut: 0 }] })?.tiers[0].priceIn).toBe(0);
  });

  it("时段被写坏的档位必须整体丢弃，绝不能「退化成兜底档」而全天按它计费", () => {
    // 这是最恶劣的一类静默错账：高峰档的 windows 被写坏 → 变空数组 →
    // 被当成兜底档，且它排在第一位 → 全天按高峰价计费。用户唯一症状是"账单变贵"。
    const t = normalizePriceTiers({
      timezone: "Asia/Shanghai",
      tiers: [
        { id: "peak", windows: [{ startMin: -5, endMin: 9999 }], priceIn: 9 },   // 写坏
        { id: "base", priceIn: 0.5 },                                            // 合法兜底
      ],
    })!;
    expect(t.tiers.map((x) => x.id)).toEqual(["base"]);
    // 且取价不会命中那个坏档
    expect(resolveEffectivePricing("deepseek-flash", DEEPSEEK, { price_tiers: t }, bj(WED, 10)).priceIn).toBe(0.5);
  });

  it("normalizePriceTiers 容忍并净化半脏输入：非法星期就地剔除、排序，超长文本修剪", () => {
    // 注意语义：越界/非整数的星期是"剔掉那一位"，而不是"整条时段作废"
    // （与上面"时段全废 → 整档丢"不同：这里时段本身仍然可用，只是星期表被污染）
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
    // 空 days 数组 == 每天（不要让"空数组"变成"哪天都不命中"）
    const daily = normalizePriceTiers({ timezone: "Asia/Shanghai", tiers: [{ id: "a", priceIn: 1, windows: [{ days: [], startMin: 0, endMin: 60 }] }] })!;
    expect(daily.tiers[0].windows![0].days).toBeUndefined();
  });

  it("builtInPriceTiers 返回深拷贝（UI 就地编辑不得污染内置真相源）", () => {
    const a = builtInPriceTiers("deepseek-flash")!;
    a.tiers[0].priceIn = 999;
    a.tiers[0].windows![0].startMin = 0;
    expect(builtInPriceTiers("deepseek-flash")!.tiers[0].priceIn).not.toBe(999);
    expect(builtInPriceTiers("deepseek-flash")!.tiers[0].windows![0].startMin).not.toBe(0);
    // 无分时规格的模型 → undefined（UI 不显示"改为自定义"以外的分时信息）
    expect(builtInPriceTiers("kimi-k2-0711-preview")).toBeUndefined();
  });

  it("createDefaultPriceTiers：空闲档 = 基准半价，时区随环境", () => {
    const t = createDefaultPriceTiers(1, 4);
    expect(t.tiers.length).toBe(2);
    expect(t.tiers[0].priceIn).toBe(1);
    expect(t.tiers[1].priceIn).toBe(0.5);
    expect(t.tiers[1].priceOut).toBe(2);
    expect(describeTierSpec(t)).toContain("（Asia/Shanghai）");
    expect(describeTierSpec(t)).not.toContain("（次日）"); // 双高峰不跨午夜
  });

  it("跨午夜时段在文案里必须标出「（次日）」（否则 23:00-07:00 会被读成从早到晚）", () => {
    expect(describeTierSpec(NIGHT)).toContain("（次日）");
    expect(describeTierSpec(NIGHT)).toContain("夜间");
  });
});

describe("源码守卫：分时的接线点不能被「重构」掉", () => {
  /** 去掉注释后再断言：注释里提到这些写法不算数（本文件自己的注释就提到过） */
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const readSrc = (rel: string): string => strip(readFileSync(join(process.cwd(), rel), "utf8"));

  it("A-988c（B1）：价目明细行的标题与「收起」按钮必须**双保险**防换行", () => {
    // 用户投诉原话：「你看到那个收起按钮了吗？怎么又出现换行错误了，我非常反感这种换行渲染问题」。
    // 根因是 flex 默认 flex-shrink:1 且缺 whiteSpace:nowrap：
    //   · `deepseek-flash` 在连字符处断行  → 文字层问题，靠 nowrap 解决
    //   · 「收起」在 CJK 字间断行        → 布局层问题，靠 flexShrink:0 解决
    // **只补其一会分别表现为"溢出撑破容器"或"仍然断行"** —— 所以两处必须同时断言。
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    // A-998：明细改为底部浮层后，文件里"价目明细 ·"出现了两处（浮层标题 + PriceDetailRow 内部）。
    // 本守卫守护的是**明细行本身**的标题/收起防换行 → 从 PriceDetailRow 定义处开始找，
    // 否则会锚到浮层那处而误判（浮层那处自身也已做双保险：nowrap + flexShrink:0）。
    const defIdx = panel.indexOf("function PriceDetailRow");
    expect(defIdx).toBeGreaterThan(0); // 重命名/搬走就会红 —— 提醒回来改这里
    const start = panel.indexOf("价目明细 ·", defIdx);
    expect(start).toBeGreaterThan(defIdx);
    const row = panel.slice(start, start + 2600);

    // ① 文字层：标题与按钮都要 nowrap
    expect(row).toMatch(/whiteSpace:\s*"nowrap"/);
    // ② 布局层：按钮与标题都不许被压缩
    expect(row).toMatch(/flexShrink:\s*0/);
    // ③ 中间那段解释必须可省略（flex:1 1 auto + minWidth:0 + ellipsis），
    //    否则弹性空间会从标题/按钮身上抢，回到断行老路
    expect(row).toMatch(/flex:\s*"1 1 auto"/);
    expect(row).toMatch(/textOverflow:\s*"ellipsis"/);
    // ④ 行本身不得允许换行（换行容器 + nowrap 子项 = 白忙）
    expect(row).toMatch(/flexWrap:\s*"nowrap"/);
    // ⑤ "双保险"的**数量**也要对：标题与按钮**各自**都要 flexShrink:0，
    //    只给其中一个写 = 另一个仍会被弹性空间压缩 → 回到断行老路
    expect((row.match(/flexShrink:\s*0/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // ⑥ 收起草案里不许出现会被误当断行点的连写（`· |` 这类历史事故形态）
    expect(row).not.toContain("价目明细 · |");
  });

  it("engine.recordUsage 的取价必须走共享的 resolveEffectivePricing（不得再自建一套优先级）", () => {
    const src = readSrc("core-ts/src/services/engine.ts");
    // 单源入口：engine / 供应商面板 / 历史回填三处共用同一个优先级函数。
    // 此前三处各写一遍，分裂出真实事故：面板显示「未定价」而引擎按 0.3 计费；
    // 本地端点存值缺价时引擎仍套官方刊例价（凭空产生账单）。
    expect(src).toContain('resolveEffectivePricing(modelId, route?.baseUrl ?? "", spec, at)');
    expect(src).toContain("price_tier: eff.tiered ? eff.tierId : undefined");
    // ts 与取档依据必须是同一个 Date，否则会写出「记录在高峰、成本按空闲算」的矛盾数据
    expect(src).toContain("const at = new Date();");
    expect(src).toContain("const ts = at.toISOString();");
    // 不得再退回"自己算一遍优先级"的旧写法（那正是分裂的来源）
    expect(src).not.toContain("const fallback = spec?.price_in_usd === undefined");
    expect(src).not.toContain("const useTier =");
  });

  it("面板的定价列必须用同一个 resolveEffectivePricing（否则显示与账目会再次分裂）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(panel).toContain("resolveEffectivePricing(m.id, baseUrl, m)");
    // 未定价/生效值必须显示「引擎实际会用的价」——A-994 起外层"单价 $/M 输/出"两框已删除
    // （它们直接显示存储 USD 裸值、不受「单价币种」影响，GLM 显示 0.1111111 那种折算残渣），
    // 单价录入/币种/生效值全部收进价目明细栏 `PriceDetailRow`，其生效值走 `amountInCurrency` 原生列。
    // 此守卫原先锚定 `function pricePlaceholder`（外层两框的占位函数），两框删除后改锚新接线点。
    expect(panel).toContain("function PriceDetailRow");
    expect(panel).toContain("amountInCurrency(eff, FIELD_KEY[f], cur)");
    // 分时徽标只在分时价真的参与计价时出现：本地端点/手填价会压过分时价，
    // 此时还挂「峰谷分时」会让人以为时段在生效（127.0.0.1 上的 deepseek-chat 就命中该家族规格）
    // A-988c 起 `customTier`（用户自定义分时档）也是分时生效态 —— 漏了它，
    // 用户自己定义的档位生效时徽标反而不显示，界面与账目又一次分裂。
    expect(panel).toMatch(/const tierActive = [^\n]*eff\.origin === "customTier"/);
    expect(panel).toContain("{tierActive && (");
  });

  it("A-1001：价目明细的主口径必须是「此刻」（带时刻），否则与下方「● 当前」档位标记同屏打架", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    /*
     * 用户实测提问（A-1001 原话）："这个可填入的表格的加码没有随着波峰波谷规定的时间变动而改变，
     * 这会影响分时价位的生效吗？"
     *
     * 结论分两半，守卫也要守两半：
     *   ① **引擎侧一直是生效的** —— `engine.recordUsage` 用 `at = new Date()` 取档并写 `price_tier`
     *      （上面那条 spec 已逐字锚定）。所以这不是"分时没生效"，而是"面板显示用了另一个口径"。
     *   ② **面板此前确实用错了口径** —— `PriceDetailRow` 主口径取的是不带时刻的确定性平铺价
     *      （= 高峰标准价），于是出现同屏矛盾：上面写「计费价 ¥2/¥8」，下面档位表却标着
     *      「空闲时段 ● 当前」。用户无法分辨哪个是真的。
     */
    // 主口径必须带时刻（`new Date()`），且必须与 TierEditor 用同一个对象 ——
    // 两处各取一次时刻在跨档瞬间会拿到不同档位，又是一次"同屏两个价"。
    expect(panel).toContain("const eff = resolveEffectivePricing(m.id, baseUrl, m, new Date());");
    // 不带时刻的那份只允许服务"必须稳定"的两处：手填原生列比对基准 + 残留值提示
    expect(panel).toContain("const effFlat = resolveEffectivePricing(m.id, baseUrl, m);");
    expect(panel).toContain("const cny = effFlat[CNY_KEY[FIELD_KEY[f]]];");
    expect(panel).toContain("effFlat.superseded");
    // A-994 的阈值是按平铺/高峰标准价校准的，绝不能被时刻价接管（否则谷时段手填官方价丢原生 ¥）
    expect(panel).not.toContain("const cny = eff[CNY_KEY[FIELD_KEY[f]]];");
    // 命中分时档时文案必须自述"当前"，否则数字随时间变而界面不说原因
    expect(panel).toContain('${eff.tiered ? "当前计费价" : "计费价"}');
    // 单价框的自述要带档位名（"当前生效 ¥1（空闲时段）"），用户才知道数字为什么变
    expect(panel).toContain("const tierName = eff.tiered ?");
    expect(panel).toContain("`当前生效 ${effText ?? \"未定价\"}${tierName}`");
    // A-1001b：必须有一个"让此刻会走"的 tick，否则 11:59 打开、12:00 之后界面仍是旧档，
    // 而引擎已按新档计价 —— 静默不一致（数字看着正常，只是旧的）。
    expect(panel).toContain("setClockTick((n) => n + 1)");
    expect(panel).toContain("30_000");
  });

  it("A-1002：分时界面与手动单价界面**互斥显示**（默认给「引擎此刻采用的那一套」）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    /*
     * 用户指令（原话）：「在这个可手动定价的部分…有分时的模型就不显示这个配置界面，只显示分时界面，
     * 没分时的或者没配置的就显示这个界面。**当然，我不是让你删了，而是做一个额外的条件选择显示的功能**。」
     *
     * 三个要点，逐条锁死：
     *   ① 两套配置各自被一个条件包住（`view === "manual"` / `view === "tier"`），互斥；
     *   ② 默认值**从 `eff.origin` 反推**（引擎裁决），不自己再算一遍优先级；
     *   ③ 不做成硬删：切换入口（`PRICE_VIEW_TABS`）+ 手填价的清理出路都必须在。
     */
    // ① 互斥包裹：手动块（币种 + 四个单价框 + 缓存说明）与分时块（TierEditor）各一个 Fragment 门控
    expect(panel).toContain('{view === "manual" && (<>');
    expect(panel).toContain('{view === "tier" && (<>');
    // TierEditor 必须在 tier 分支内（它上方 200 字符内出现该门控），否则两套又并排了
    const tierIdx = panel.indexOf("<TierEditor m={m} eff={eff}");
    const gateIdx = panel.lastIndexOf('{view === "tier" && (<>', tierIdx);
    expect(gateIdx, "TierEditor 没有被 tier 视图包住").toBeGreaterThan(-1);
    expect(tierIdx - gateIdx).toBeLessThan(900);
    // ② 默认视图 = 引擎此刻采用的那一套；判据与列表徽标逐字一致（两处不同 = 同屏矛盾）
    expect(panel).toContain('const tierActive = hasTierSpec && (eff.origin === "table" || eff.origin === "tier" || eff.origin === "customTier");');
    expect(panel).toContain('const defaultView: PriceView = tierActive ? "tier" : "manual";');
    // 用户显式切换用"覆盖标记"而不是直接改 view —— 否则面板里改分时配置后自动判据就失效了
    expect(panel).toContain("const [viewOverride, setViewOverride] = useState<PriceView | null>(null);");
    expect(panel).toContain("const view: PriceView = viewOverride ?? defaultView;");
    // ③ 不硬删：切换条在、两个页签在、手填价的清理入口在
    expect(panel).toContain("PRICE_VIEW_TABS");
    // 按钮文案按**正则**锚（`>清空手填<` 在源码里是跨行的，字面量匹配必然假红 —— A-988 学到的教训）
    expect(panel).toMatch(/>\s*清空手填\s*<\/button>/);
    expect(panel).toContain("定价方式");
    // ⚠️ 互斥显示唯一可能撒谎的地方：有内置分时规格 + **手填价正在压过它**（origin=manual）。
    // 此时默认显示手动视图，否则用户对着一张时段表会以为时段在生效。判据必须取自共享层
    // （`eff.superseded`）、不能拿"存了数字"当判据 —— 后者会把历史残留值说成"正在压过分时"。
    expect(panel).toContain("const manualInEffect = eff.origin === \"manual\";");
    expect(panel).toContain("{view === \"tier\" && (manualInEffect || eff.superseded) && (");
    // 切到分时视图却没有手填出路 = 用户切走后**再也清不掉**残留（这条是"不硬删"的底线）
    expect(panel).toContain("onClick={onClearManual}");
    // 视图状态是**按模型**隔离的：切换展开的模型时 React 会复用同位置实例
    expect(panel).toContain("key={mm.id}");
  });

  it("A-1002b：切换条选中态必须写 `border` 简写（`.btn` 无边框，只写 `borderColor` 是静默失效）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    const css = readFileSync(join(process.cwd(), "gui/src/renderer/index.css"), "utf8");
    /*
     * 静默失效（本项目第 5 类老病）：`index.css` 的 `.btn` 是显式 `border: none`，
     * 所以内联 `borderColor: var(--accent)` **没有任何边框可着色** —— 选中/未选中的
     * 视觉差只剩背景 tint 与字重。而这条切换条是用户判断"我在哪套视图"的唯一凭据。
     *
     * 两侧都要锁，缺一侧这条守卫就会变成空转：
     *   ① CSS 契约侧：`.btn` 确实无边框 —— 将来谁给 `.btn` 加了边框，这里会先报红提醒复核；
     *   ② 面板侧：必须用整个 `border` 简写，且未选中态给**透明的同宽边框**而不是 `none`,
     *      否则每次切换按钮宽高跳 2px（A-999 的"改宽/高必跳"）。
     */
    expect(css, "`.btn` 契约变了（不再是 border:none）→ 请复核本守卫是否仍必要")
      .toMatch(/\.btn\s*\{[^}]*border:\s*none/);
    expect(panel).toContain('border: `1px solid ${on ? "var(--accent, #8b7bf7)" : "transparent"}`');
    // 同区块的「单价币种」是同一行模式，必须一致（一处有框一处没有 = 新的不一致观感）
    expect(panel).toContain('border: `1px solid ${cur === c ? "var(--accent, #8b7bf7)" : "transparent"}`');
    // 不得回退到只会静默失效的 `borderColor` 写法
    expect(panel).not.toContain("borderColor: on ?");
    expect(panel).not.toContain("borderColor: cur === c ?");
  });

  it("模型表格必须适配弹窗宽度（minWidth 会把表格顶出容器 → 左右两端被裁）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    // 弹窗卡片固定 width:680，内容区约 640 CSS px。曾写 minWidth: 880（后加到 920）→
    // 表格比容器宽 280px，用户看到的正是「左边只剩 sh/-pro 尾巴、右边单价列整列不见 + 横向滚动条」。
    expect(panel).not.toContain("minWidth: 920");
    expect(panel).not.toContain("minWidth: 880");
    expect(panel).toContain("tableLayout: \"fixed\"");
    // 列头文字长度直接决定列的最小宽度（th 有 nowrap），必须保持短列头
    expect(panel).toContain(">上下文K</th>");
    expect(panel).toContain(">输出K</th>");
    // A-994：外层"单价 $/M 输/出"列已删除（裸 USD 值不受币种影响）→ 改锚"定价来源"列
    //（点击展开价目明细 = 单价/币种/缓存费率的新家），并确认旧列头没有残留
    expect(panel).toContain(">定价来源</th>");
    // 模型 ID 单行省略号，不得回退成换行（第二行文字会把行高从 31px 顶到 53px）
    expect(panel).toContain('textOverflow: "ellipsis"');
    const table = panel.slice(panel.indexOf("<table style={{ width: \"100%\""), panel.indexOf("</table>"));
    expect(table.length).toBeGreaterThan(500); // 切片有效（不然后面的断言是空转）
    expect(table).not.toContain("wordBreak");
    // A-994：外层"单价 $/M 输/出"两框必须真的删干净（裸 USD 值不受币种影响，
    // GLM 显示 0.1111111 那种折算残渣）—— 单价录入/币种全在价目明细栏
    expect(table).not.toContain("单价 $/M");
    expect(table).not.toContain('updateDraftPrice(i, "price_in_usd"');
  });

  it("A-988：数字输入框必须靠 CSS 关掉 spinner（spinner 吃 18px = 用户看到的「10:」）", () => {
    // 用户截图症状：上下文K 显示 "10:"、输出K 显示 "{"。真凶是 number 框自带的 spinner：
    // 列宽 60 − padding 16 = 44px 的输入框，spinner 又占 18px，剩下的内文区放不下 "1024"。
    // 靠"加宽列"解决不了（会把单价列顶出容器，就是上面那条注释踩过的坑）。
    const css = readFileSync(join(process.cwd(), "gui/src/renderer/index.css"), "utf8");
    expect(css).toContain(".provider-model-table input[type=\"number\"]");
    expect(css).toContain("-webkit-outer-spin-button");
    expect(css).toContain("appearance: textfield");
    // 作用域必须是表格类名，不能写成全局 input[type=number]（别处的数字框行为不该被改）
    expect(css).not.toMatch(/^input\[type="number"\]\s*\{/m);
    // 表格容器必须挂上这个类，否则上面全部规则空转
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    expect(panel).toContain('className="provider-model-table"');
  });

  it("A-988：列宽预算必须容得下最坏内容（数字来自真实 Chromium 实测，不是纸面推算）", () => {
    /*
     * 为什么要有这条：之前列宽是"看着差不多"给的（7.5% / 9% / 8% / …），
     * 结果 输出K 那列的表头文字就比列宽宽、输入框内容区比 "1024" 窄 —— 用户看到 "10:" / "{"。
     * 这里把实测出来的**内容所需宽度**当预算算一遍，谁把列改窄都会当场红。
     *
     * 实测环境：Electron 31 的真实 Chromium，加载的就是 gui/src/renderer/index.css，
     * 卡片 width:680、字体走系统 sans-serif。复现方式见 _probe_layout/。
     *   表格可用宽度 = 680 − card padding 32 − 滚动条
     *     · 本机滚动条 4px  → 641.6px
     *     · Windows 默认 17px → 628.6px（取这个当预算，留足余量）
     * 内容所需宽度（canvas measureText，同 computed font）：
     *     "1024"     = 26.7px   （上下文K / 输出K 可能出现 4 位数字）
     *     "0.000001" = 50.05px  （单价最多 6 位小数）
     *     ToggleSwitch = 40px   （组件里写死的 const w = 40）
     *     "内置表"+"峰谷分时"+"▼" = 103.93px（最宽的一种徽标组合）
     *     输入框自身开销 = padding 12 + border 1.6
     */
    const TABLE_W_WORST = 628.6; // 17px 滚动条预算，不用本机的 641.6 —— 保守取大
    const INPUT_CHROME = 12 + 1.6; // input 的横向 padding + border
    const NEED = { toggle: 40, cellText: 26.7, priceText: 50.05, badge: 103.93 };

    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    // 抓每个 th 的 padding 与百分比宽度（模型 ID 那列故意不给宽度，走 auto 吸收余量）
    const ths = [...panel.matchAll(/<th style=\{\{ padding: "([^"]+)"(?:, width: "([\d.]+)%")?/g)].map((m) => ({
      pad: m[1],
      pct: m[2] === undefined ? null : Number(m[2]),
    }));
    expect(ths.length).toBe(6); // A-994 删掉"单价 $/M"列后是 6 列；列数变了就必须回来核对这份预算

    const colW = (pct: number) => (TABLE_W_WORST * pct) / 100;
    /** th/td 的横向 padding 之和：2 段是 "上下 左右"，4 段是 "上 左右 下 左右" */
    const padX = (pad: string) => {
      const p = pad.split(" ").map((s) => parseFloat(s));
      const left = p.length === 4 ? p[3] : p[1];
      return left + p[1];
    };
    /** 单元格内容区可用宽度（扣掉 padding） */
    const cellAvail = (i: number) => colW(ths[i].pct as number) - padX(ths[i].pad);

    // ① 只有一列走 auto，且必须是「模型 ID」—— 这一列靠省略号，缩不缩都不出错
    const autoCols = ths.map((t, i) => (t.pct === null ? i : -1)).filter((i) => i >= 0);
    expect(autoCols).toEqual([1]);
    const pctSum = ths.reduce((s, t) => s + (t.pct ?? 0), 0);
    expect(pctSum).toBeLessThanOrEqual(80); // 给 auto 列留 ≥20%（~126px），否则 ID 全变省略号

    // ② 「启用」列要放得下写死 40px 的 ToggleSwitch
    expect(cellAvail(0)).toBeGreaterThanOrEqual(NEED.toggle);

    // ③ 上下文K / 输出K：输入框内容区 ≥ "1024"
    for (const i of [2, 3]) {
      expect(cellAvail(i) - INPUT_CHROME).toBeGreaterThanOrEqual(NEED.cellText);
      // 表头 nowrap 文字也必须放得下（fixed 布局下 th 宽度是权威值，放不下会直接溢出）
      expect(cellAvail(i)).toBeGreaterThan(44.4); // "上下文K" 实测 44.31px
    }

    // ④ 「定价来源」列（现在下标 5）要放得下最宽的徽标组合（否则徽标被 td 的 overflow:hidden 切掉尾部）
    //    A-994：该列从 20% 加宽到 26%（吸收了删掉的"单价"列），徽标 103.93px 有充足余量
    expect(cellAvail(5)).toBeGreaterThanOrEqual(NEED.badge);
  });

  it("usage.recomputeOne 把记录自己的 ts 传给解析器（不是 now）", () => {
    const src = readSrc("core-ts/src/services/usage.ts");
    expect(src).toContain("resolve(rec.provider_key, rec.model, rec.ts)");
    expect(src).toContain("next.price_tier = price.tierId");
  });

  it("providers.makePriceResolver 必须收敛到 resolveEffectivePricing（不得再自建第三套优先级）", () => {
    const src = readSrc("gui/src/main/providers.ts");
    // A-988c 前的写法是 inferPricingFromUrl + t.tier_id 手拼四条分支 —— 那是第三套实现。
    // 它看不到 price_tiers，所以"重算历史成本"的口径与实时记账不一致
    // → 用户点了重算，历史账单反而和实时账单对不上（比不算还糟）。
    expect(src).toContain('resolveEffectivePricing(model, String(rec?.api_base ?? ""), hit, ts)');
    expect(src).not.toContain("inferPricingFromUrl(String(rec?.api_base");
    expect(src).not.toContain("tierId: t.tier_id");
    // 未定价必须**返回 undefined**（而不是 0）：0 会让重算把"未知"写成"免费"
    expect(src).toContain('if (eff.origin === "none") { return undefined; }');
    // 缓存价必须一起回传，否则重算的历史记录会把缓存命中按全价输入算
    expect(src).toContain("priceCacheRead: eff.priceCacheRead");
  });

  it("deepseek 表项必须同时带 priceTiers 与高峰平铺价（只留一个 = 功能失效或价错）", () => {
    const src = readSrc("shared/gen/model-capabilities.ts");
    expect(src).toContain("DEEPSEEK_PEAK_WINDOWS");
    expect(src).toContain('const DEEPSEEK_TZ = "Asia/Shanghai"');
    // 高峰窗必须是 09:00-12:00 与 14:00-18:00 **两段**（写成一整段 09:00-18:00 是最典型的笔误）
    expect(src).toContain("startMin: 9 * 60, endMin: 12 * 60");
    expect(src).toContain("startMin: 14 * 60, endMin: 18 * 60");
    // 平铺价不得回退成已废弃的峰谷均值
    expect(src).not.toContain("priceIn: 0.225");
    expect(src).not.toContain("priceIn: 0.99");
  });

  it("本地端点判定只有一份实现（两处各写一遍 = 迟早分裂）", () => {
    const shared = readSrc("shared/gen/model-capabilities.ts");
    expect(shared).toContain("export function isLocalEndpoint");
    // providers.ts 不得再自己内联一份 loopback 正则
    const providers = readSrc("gui/src/main/providers.ts");
    expect(providers).not.toContain("127\\.0\\.0\\.1");
    expect(providers).toContain("isLocalEndpoint(base)");
  });

  it("刷新逻辑必须过 mergeModelPrice（漏了 = 一键刷新静默抹掉用户手填的议价）", () => {
    const providers = readSrc("gui/src/main/providers.ts");
    for (const fn of ["saveProvider", "refreshProviderModels"]) {
      const i = providers.indexOf(`export async function ${fn}`);
      expect(i, `${fn} 不存在`).toBeGreaterThan(-1);
      // 取该函数体（下一处 export 之前）——逐字断言"合并点调了 mergeModelPrice"
      const nextExport = providers.indexOf("\nexport ", i + 10);
      const body = providers.slice(i, nextExport > 0 ? nextExport : i + 6000);
      expect(body, `${fn} 未调用 mergeModelPrice`).toContain("mergeModelPrice(");
    }
  });

  it("A-988：四个费率字段都必须可手填并落盘（只做输入/输出 = 缓存价被静默按全价计）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    // 字段集合必须是四个，且与 LiteLLM 的 model cost map 命名对齐（便于和外部价格表对拍）
    for (const f of ["price_in_usd", "price_out_usd", "price_cache_read_usd", "price_cache_write_usd"]) {
      expect(panel, `缺少手填字段 ${f}`).toContain(f);
    }
    // 「是否还有手填值」的判定必须遍历四个字段；只判断 in/out 会让"只填了缓存价"在刷新后被清掉
    expect(panel).toContain("const PRICE_FIELDS: PriceField[]");
    expect(panel).toContain("PRICE_FIELDS.some(");
    // 保存时必须把缓存价一起回传（漏了 → 界面能填但存不下去）
    expect(panel).toContain("price_cache_read_usd: m.price_cache_read_usd ?? undefined");
    expect(panel).toContain("price_cache_write_usd: m.price_cache_write_usd ?? undefined");
    // 明细必须真的渲染出来，而不是只定义了组件。
    // A-1000：它从"表格里的一行"（<tr className="price-detail-row">）改为弹窗内的普通区块
    // （<div className="price-detail-block">）—— 明细不在表格里了，就不该再带表格语义
    // （`<tr>` 嵌在 `<div>` 下是非法 DOM 嵌套，React 会报 validateDOMNesting）。
    expect(panel).toContain("<PriceDetailRow");
    expect(panel).toContain("className=\"price-detail-block\"");
    expect(panel).not.toContain("className=\"price-detail-row\"");
  });
});
