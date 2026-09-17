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
  describePriceTiers,
  inferModelPricing,
  isLocalEndpoint,
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
    const r = resolveModelPriceTier("claude-sonnet-4-20250514", bj(WED, 10));
    expect(r.tiered).toBe(false);
    expect(r.tierId).toBe("flat");
    expect(r.timezone).toBeUndefined();
    expect(r.pricing.priceIn).toBeCloseTo(3, 9);
  });

  it("查不到价的模型 → pricing 为空、tiered=false（仍是「未定价」，不是免费）", () => {
    const r = resolveModelPriceTier("kimi-k2-0711-preview", bj(WED, 10));
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
    const e = resolveEffectivePricing("kimi-k2-0711-preview", "https://api.moonshot.cn/v1", {});
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

describe("源码守卫：分时的接线点不能被「重构」掉", () => {
  /** 去掉注释后再断言：注释里提到这些写法不算数（本文件自己的注释就提到过） */
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const readSrc = (rel: string): string => strip(readFileSync(join(process.cwd(), rel), "utf8"));

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
    // 未定价时占位必须显示「引擎实际会用的价」，不能只写中性的“输入”——
    // 用户投诉的正是这个：表里明明有 0.3，界面却显示成没定价。
    expect(panel).toContain("function pricePlaceholder");
    // 分时徽标只在分时价真的参与计价时出现：本地端点/手填价会压过分时价，
    // 此时还挂「峰谷分时」会让人以为时段在生效（127.0.0.1 上的 deepseek-chat 就命中该家族规格）
    expect(panel).toContain('const tierActive = !!tierDesc && (eff.origin === "table" || eff.origin === "tier")');
    expect(panel).toContain("{tierActive && (");
  });

  it("模型表格必须适配弹窗宽度（minWidth 会把表格顶出容器 → 左右两端被裁）", () => {
    const panel = readSrc("gui/src/renderer/pages/ProvidersPanel.tsx");
    // 弹窗卡片固定 width:680，内容区约 640 CSS px。曾写 minWidth: 880（后加到 920）→
    // 表格比容器宽 280px，用户看到的正是「左边只剩 sh/-pro 尾巴、右边单价列整列不见 + 横向滚动条」。
    expect(panel).not.toContain("minWidth: 920");
    expect(panel).not.toContain("minWidth: 880");
    expect(panel).toContain('<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>');
    // 列头文字长度直接决定列的最小宽度（th 有 nowrap），必须保持短列头
    expect(panel).toContain(">上下文K</th>");
    expect(panel).toContain(">输出K</th>");
    expect(panel).toContain(">单价 $/M</th>");
    // 模型 ID 单行省略号，不得回退成换行（第二行文字会把行高从 31px 顶到 53px）
    expect(panel).toContain('textOverflow: "ellipsis"');
    const table = panel.slice(panel.indexOf("<table style={{ width: \"100%\""), panel.indexOf("</table>"));
    expect(table.length).toBeGreaterThan(500); // 切片有效（不然后面的断言是空转）
    expect(table).not.toContain("wordBreak");
  });

  it("usage.recomputeOne 把记录自己的 ts 传给解析器（不是 now）", () => {
    const src = readSrc("core-ts/src/services/usage.ts");
    expect(src).toContain("resolve(rec.provider_key, rec.model, rec.ts)");
    expect(src).toContain("next.price_tier = price.tierId");
  });

  it("providers.makePriceResolver 把 ts 透传给 inferPricingFromUrl 并回传 tierId", () => {
    const src = readSrc("gui/src/main/providers.ts");
    expect(src).toContain('inferPricingFromUrl(String(rec?.api_base ?? ""), model, ts)');
    expect(src).toContain("tierId: t.tier_id");
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
});
