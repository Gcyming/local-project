/**
 * tests/core-ts/providers-pricing.spec.ts — 定价链路回归测试（A-9xx 定价事故复盘）。
 *
 * 事故现象：`config/usage.jsonl` 1606 条记录 **100% 成本为 0**（总消耗 $0.0000），其中包含
 * 27.1M tokens 的 `deepseek-flash`、19.5M 的 `agnes-3.0-flash`、527K 的 `小红书::dots3-note-prev`。
 * 根因是三处同时失守，本文件逐条锁死：
 *   ① 内置价目表缺失/单位错（美元价又除了一次 7.25）、正则漏匹配（deepseek-flash 不命中）；
 *   ② 上游探针"命中第一个 200 就 return"，导致 `/api/pricing` 永远执行不到（两阶段修复）；
 *   ③ 历史脏值（`price_source === undefined`）压住新表，形成「错值自杀锁」。
 *
 * 这些函数此前**完全无单测覆盖**，是本次事故能潜伏一整个版本的原因之一。
 */
import { describe, expect, it } from "vitest";
import {
  inferPricingFromUrl,
  makePriceResolver,
  mergeModelPrice,
  parseUpstreamModelItems,
  probeUpstreamTwoPhase,
  resolvePrice,
  type ProvidersTable,
} from "../../gui/src/main/providers.js";
import { inferModelPricing } from "../../shared/gen/model-capabilities.js";

describe("inferModelPricing（内置家族价目表，单一真相源）", () => {
  it("命中已核实刊例价：DeepSeek pro/flash 都在表内", () => {
    // 平铺字段 = **高峰标准价**（真实存在的档位；分时档位见 priceTiers / pricing-tiers.spec.ts）。
    // 这里**曾经**是峰谷均值（0.99/2.97、0.225/0.9）—— 均值在任何真实时段都不存在，已废弃。
    const pro = inferModelPricing("deepseek-v4-pro");
    expect(pro.priceIn).toBeCloseTo(1.32, 6);
    expect(pro.priceOut).toBeCloseTo(3.96, 6);
    // 回归：旧正则只匹配 chat|reasoner|v4，`deepseek-flash` 完全不命中 → 直接无价
    const flash = inferModelPricing("deepseek-flash");
    expect(flash.priceIn).toBeCloseTo(0.3, 6);
    expect(flash.priceOut).toBeCloseTo(1.2, 6);
  });

  it("回归：DeepSeek 价格不得再被汇率除一次（0.14/7.25 = 0.0193 是历史脏值）", () => {
    const p = inferModelPricing("deepseek-v4-pro");
    expect(p.priceIn!).toBeGreaterThan(0.5); // 曾被写成 0.0193
  });

  it("Claude 按档位分档（opus / haiku / sonnet 不同价）", () => {
    expect(inferModelPricing("claude-opus-4-1").priceIn).toBeCloseTo(15, 6);
    expect(inferModelPricing("claude-haiku-4").priceIn).toBeCloseTo(0.8, 6);
    expect(inferModelPricing("claude-sonnet-4-20250514").priceIn).toBeCloseTo(3, 6);
  });

  it("回归：agnes 免费档只覆盖 flash，付费档不能被写成 0", () => {
    // 旧实现把**所有** Agnes 硬编码成 {0,0}，agnes-2.5-pro 的真实消耗被吞掉
    const pro = inferModelPricing("agnes-2.5-pro");
    expect(pro.priceIn).toBeCloseTo(0.45, 6);
    expect(pro.priceOut).toBeCloseTo(0.9, 6);
    const beta = inferModelPricing("agnes-2.5-pro-beta");
    expect(beta.priceIn).toBeCloseTo(0.1, 6);
    // 免费 flash 档必须命中 `agnes` 兜底 → 显式 0（免费是**正确结果**，不是"没价"）
    const flash = inferModelPricing("agnes-3.0-flash");
    expect(flash.priceIn).toBe(0);
    expect(flash.priceOut).toBe(0);
  });

  it("回归：glm-flash 免费那档必须排在宽泛的 glm 前面（条目顺序 bug）", () => {
    const flash = inferModelPricing("glm-5.3-flash");
    expect(flash.priceIn).toBe(0);
    expect(flash.priceOut).toBe(0);
    const paid = inferModelPricing("glm-5.3");
    expect(paid.priceIn).toBeCloseTo(0.083, 6);
    expect(paid.priceOut).toBeCloseTo(0.234, 6);
  });

  it("小红书 dots 为官方限时免费 → 0，不是 undefined", () => {
    const p = inferModelPricing("dots3-note-prev");
    expect(p.priceIn).toBe(0);
    expect(p.priceOut).toBe(0);
  });

  it("未核实刊例价的厂商 → 返回 {}（宁缺勿造，UI 会显示「未定价」让用户手填）", () => {
    expect(inferModelPricing("kimi-k2-0711-preview")).toEqual({});
    expect(inferModelPricing("qwen3.7-max")).toEqual({});
    expect(inferModelPricing("")).toEqual({});
  });

  it("非对话模型（embedding/rerank/图像）不参与 token 定价", () => {
    const p = inferModelPricing("text-embedding-3-large");
    expect(p.priceIn).toBeUndefined();
  });
});

describe("resolvePrice（优先级：手填 > 上游 > 内置表 > 历史残留）", () => {
  it("手填价永不被覆盖", () => {
    expect(resolvePrice(7, true, 1, 2)).toEqual({ value: 7, source: "manual" });
  });

  it("上游价次之", () => {
    expect(resolvePrice(undefined, false, 1.5, 2)).toEqual({ value: 1.5, source: "upstream" });
  });

  it("上游给 0 不算「有价」，回落到内置表（0 是免费语义，只在表里显式表达）", () => {
    expect(resolvePrice(undefined, false, 0, 2)).toEqual({ value: 2, source: "table" });
  });

  it("内置表再次（含 0 = 免费）", () => {
    expect(resolvePrice(undefined, false, undefined, 0)).toEqual({ value: 0, source: "table" });
  });

  it("历史残留垫底：打破「错值自杀锁」——新表有价时必须压过已存的脏值", () => {
    // 旧配置里躺着 0.0193，若让"已有值"优先，刷新多少次都改不动
    expect(resolvePrice(0.0193, false, undefined, 1.32)).toEqual({ value: 1.32, source: "table" });
    // 但表里也没有价时，至少不丢用户数据
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
    // 旧逻辑 `next.x || prev.x` 会把 0 吞掉 → 给免费模型凭空计费
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
    expect(t.price_in_usd).toBeCloseTo(0.3, 6); // 高峰标准价（不传时刻 → 不猜档位）
  });

  it("表里查不到的模型 → undefined（未定价，交给用户手填）", () => {
    const t = inferPricingFromUrl("https://api.moonshot.cn/v1", "kimi-k2-0711-preview");
    expect(t.price_in_usd).toBeUndefined();
  });
});

describe("makePriceResolver（历史成本回填的取价器）", () => {
  const table: ProvidersTable = {
    deepseek: {
      api_base: "https://api.deepseek.com",
      api_key: "sk-x",
      models: [
        // 历史脏值：无 price_source，价格是"美元又除了一次 7.25"的产物
        { id: "deepseek-v4-pro", price_in_usd: 0.0193, price_out_usd: 0.0386 },
        // 手填价：必须被采信
        { id: "deepseek-chat", price_in_usd: 9, price_out_usd: 9, price_source: "manual" },
        // 上游结算价：必须被采信
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
    // 1 倍率 = $2/1M；completion_ratio 缺省 1 → 同价
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
    expect(p?.prompt).toBeCloseTo(1, 6); // 0.5 × 2
    expect(p?.completion).toBeCloseTo(2, 6);
    expect(p?.promptCacheRead).toBeCloseTo(0.25, 6); // 1 × 0.25
    expect(p?.promptCacheCreate).toBeCloseTo(1.25, 6);
  });
});

describe("probeUpstreamTwoPhase（两阶段探测：阶段 2 不能被阶段 1 短路）", () => {
  /** 造一个按 url 路由的假上游；记录实际请求过的 url 以断言调用序列 */
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
      // 大多数网关的 /v1/models 只给 id，**不带 pricing** —— 旧实现在这里 return 就结束了
      "/v1/models": { data: [{ id: "deepseek-v4-pro", context_length: 512000 }] },
      "/api/pricing": { data: [{ model_name: "deepseek-v4-pro", model_ratio: 0.495 }] },
    }, seen);

    const details = await probeUpstreamTwoPhase("https://gw.example.com", getJson);

    // ① 阶段 2 必须真的被调用到
    expect(seen).toContain("https://gw.example.com/api/pricing");
    // ② 元数据与定价都要拿到（旧实现只有前者）
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
    expect(details.get("m1")?.pricing?.prompt).toBeCloseTo(3, 6); // 3e-6 × 1e6
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
