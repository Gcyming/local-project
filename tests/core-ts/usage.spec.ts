




import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as usage from "../../core-ts/src/services/usage.js";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "usage-"));
  process.env.SLIME_USAGE_PATH = join(tmpDir, "usage.jsonl");
});

beforeEach(async () => {
  await usage.clearUsage();
});

afterAll(async () => {
  if (tmpDir) { await rm(tmpDir, { recursive: true, force: true }); }
  delete process.env.SLIME_USAGE_PATH;
});

describe("appendUsage + loadUsage", () => {
  it("追加单条记录后再读取能拿到", async () => {
    await usage.appendUsage({
      agent_id: "a1",
      session_id: "s1",
      model: "gpt-4o",
      provider_key: "openai",
      prompt_tokens: 100,
      completion_tokens: 50,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      elapsed_ms: 1000,
      cost_usd: 0.001,
      success: true,
    });
    const all = await usage.loadUsage();
    expect(all).toHaveLength(1);
    expect(all[0].model).toBe("gpt-4o");
    expect(all[0].prompt_tokens).toBe(100);
  });

  it("sinceIso/untilIso 过滤生效", async () => {
    await usage.appendUsage({
      agent_id: "a1", session_id: "s1", model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: true,
      ts: "2026-09-10T00:00:00.000Z",
    });
    await usage.appendUsage({
      agent_id: "a2", session_id: "s2", model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: false,
      ts: "2026-09-11T00:00:00.000Z",
    });
    const r1 = await usage.loadUsage({ sinceIso: "2026-09-10T12:00:00.000Z" });
    expect(r1).toHaveLength(1);
    expect(r1[0].agent_id).toBe("a2");
    const r2 = await usage.loadUsage({ untilIso: "2026-09-10T12:00:00.000Z" });
    expect(r2).toHaveLength(1);
    expect(r2[0].agent_id).toBe("a1");
  });

  it("批量追加", async () => {
    await usage.appendUsageBatch([
      { agent_id: "a1", session_id: "s1", model: "m", provider_key: "p",
        prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        elapsed_ms: 10, cost_usd: 0.001, success: true },
      { agent_id: "a2", session_id: "s2", model: "m", provider_key: "p",
        prompt_tokens: 3, completion_tokens: 4, reasoning_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        elapsed_ms: 20, cost_usd: 0.002, success: true },
    ]);
    const all = await usage.loadUsage();
    expect(all).toHaveLength(2);
  });
});

describe("clearUsage", () => {
  it("清空后 loadUsage 返回空数组", async () => {
    await usage.appendUsage({
      agent_id: "a1", session_id: "s1", model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: true,
    });
    expect((await usage.loadUsage()).length).toBe(1);
    await usage.clearUsage();
    expect((await usage.loadUsage()).length).toBe(0);
  });
});

describe("聚合函数", () => {
  const fixtures: Array<Record<string, unknown>> = [
    { ts: "2026-09-10T08:00:00.000Z", agent_id: "a1", session_id: "s1",
      model: "gpt-4o", provider_key: "openai",
      prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0,
      cache_read_tokens: 300, cache_creation_tokens: 0,
      elapsed_ms: 1200, cost_usd: 0.005, success: true },
    { ts: "2026-09-10T20:30:00.000Z", agent_id: "a2", session_id: "s2",
      model: "claude-sonnet-4", provider_key: "anthropic",
      prompt_tokens: 800, completion_tokens: 400, reasoning_tokens: 100,
      cache_read_tokens: 0, cache_creation_tokens: 200,
      elapsed_ms: 900, cost_usd: 0.003, success: true },
    { ts: "2026-09-11T03:15:00.000Z", agent_id: "a1", session_id: "s1",
      model: "gpt-4o", provider_key: "openai",
      prompt_tokens: 500, completion_tokens: 250, reasoning_tokens: 0,
      cache_read_tokens: 100, cache_creation_tokens: 0,
      elapsed_ms: 600, cost_usd: 0.0025, success: false },
  ];

  it("summarizeRecords: 总和/命中率/唯一数", () => {
    const records = fixtures as unknown as Array<usage.UsageRecord>;
    const s = usage.summarizeRecords(records);
    expect(s.total_requests).toBe(3);
    expect(s.successful_requests).toBe(2);
    expect(s.prompt_tokens).toBe(1000 + 800 + 500);
    expect(s.completion_tokens).toBe(500 + 400 + 250);
    expect(s.reasoning_tokens).toBe(100);
    expect(s.cache_read_tokens).toBe(300 + 100);
    expect(s.cache_creation_tokens).toBe(200);
    expect(s.cost_usd).toBeCloseTo(0.005 + 0.003 + 0.0025, 6);
    expect(s.cache_hit_rate).toBeCloseTo(400 / 2300, 4);
    expect(s.unique_models_used).toBe(2);
    expect(s.unique_agents).toBe(2);
    expect(s.earliest_ts).toBe("2026-09-10T08:00:00.000Z");
    expect(s.latest_ts).toBe("2026-09-11T03:15:00.000Z");
  });

  it("aggregateDaily: 按本地日分桶（UTC 偏移 = +480 东八区）", () => {
    const records = fixtures as unknown as Array<usage.UsageRecord>;
    
    
    
    
    const days = usage.aggregateDaily(records, 480);
    expect(days).toHaveLength(2);
    expect(days[0].date).toBe("2026-09-10");
    expect(days[0].requests).toBe(1);
    expect(days[0].cost_usd).toBeCloseTo(0.005, 6);
    expect(days[1].date).toBe("2026-09-11");
    expect(days[1].requests).toBe(2);
    expect(days[1].cost_usd).toBeCloseTo(0.003 + 0.0025, 6);
  });

  it("aggregateByModel: 按 cost_usd 降序", () => {
    const records = fixtures as unknown as Array<usage.UsageRecord>;
    const ms = usage.aggregateByModel(records);
    expect(ms).toHaveLength(2);
    expect(ms[0].model).toBe("gpt-4o");
    expect(ms[0].requests).toBe(2);
    expect(ms[1].model).toBe("claude-sonnet-4");
  });

  it("aggregateByAgent: 按 agent_id 分组", () => {
    const records = fixtures as unknown as Array<usage.UsageRecord>;
    const ag = usage.aggregateByAgent(records);
    expect(ag).toHaveLength(2);
    expect(ag.find((a) => a.agent_id === "a1")?.requests).toBe(2);
    expect(ag.find((a) => a.agent_id === "a2")?.requests).toBe(1);
  });

  it("aggregateTokenComposition: 求和五项", () => {
    const records = fixtures as unknown as Array<usage.UsageRecord>;
    const c = usage.aggregateTokenComposition(records);
    expect(c.prompt).toBe(2300);
    expect(c.completion).toBe(1150);
    expect(c.reasoning).toBe(100);
    expect(c.cache_read).toBe(400);
    expect(c.cache_creation).toBe(200);
  });

  it("aggregateHeatmap: 24 小时 × 每天", () => {
    const records = fixtures as unknown as Array<usage.UsageRecord>;
    const cells = usage.aggregateHeatmap(records, 0); 
    expect(cells.length).toBe(3);
    const c08 = cells.find((c) => c.hour === 8);
    expect(c08?.requests).toBe(1);
  });
});

describe("aggregateByConfiguredModels", () => {
  it("取「已配置 ∩ 已使用」的交集——未使用的模型不补 0 桶", () => {
    const records = [
      { ts: "2026-09-10T00:00:00Z", agent_id: "a1", session_id: "s1",
        model: "gpt-4o", provider_key: "openai",
        prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        elapsed_ms: 1000, cost_usd: 0.001, success: true },
    ] as unknown as Array<usage.UsageRecord>;
    const configured: Array<usage.ConfiguredModel> = [
      { provider_key: "openai", model_id: "gpt-4o", price_in_usd: 2.5, price_out_usd: 10 },
      { provider_key: "openai", model_id: "gpt-4o-mini", price_in_usd: 0.15, price_out_usd: 0.6 },   
      { provider_key: "anthropic", model_id: "claude-sonnet-4-20250514", price_in_usd: 3, price_out_usd: 15 }, 
    ];
    const buckets = usage.aggregateByConfiguredModels(records, configured);
    
    expect(buckets).toHaveLength(1);
    expect(buckets[0].model).toBe("gpt-4o");
    expect(buckets[0].requests).toBe(1);
    expect(buckets[0].cost_usd).toBeCloseTo(0.001, 6);
    expect(buckets[0].unused).toBeFalsy();
  });

  it("用了但未配置的模型被过滤掉（不展示幽灵模型）", () => {
    const records = [
      { ts: "2026-09-10T00:00:00Z", agent_id: "a1", session_id: "s1",
        model: "unknown-model", provider_key: "mystery",
        prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        elapsed_ms: 1000, cost_usd: 0.001, success: true },
    ] as unknown as Array<usage.UsageRecord>;
    const buckets = usage.aggregateByConfiguredModels(records, []);
    expect(buckets).toHaveLength(0);
  });

  it("排序：按 cost 降序", () => {
    const records = [
      { ts: "2026-09-10T00:00:00Z", agent_id: "a", session_id: "s",
        model: "m1", provider_key: "p1", prompt_tokens: 0, completion_tokens: 0,
        reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
        elapsed_ms: 0, cost_usd: 1, success: true },
      { ts: "2026-09-10T00:00:00Z", agent_id: "a", session_id: "s",
        model: "m2", provider_key: "p1", prompt_tokens: 0, completion_tokens: 0,
        reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
        elapsed_ms: 0, cost_usd: 5, success: true },
    ] as unknown as Array<usage.UsageRecord>;
    const configured = [
      { provider_key: "p1", model_id: "m1" },
      { provider_key: "p1", model_id: "m2" },
    ];
    const buckets = usage.aggregateByConfiguredModels(records, configured);
    expect(buckets.map((b) => b.model)).toEqual(["m2", "m1"]);
  });
});

describe("computeRecordCost", () => {
  it("基本 prompt+completion", () => {
    const c = usage.computeRecordCost(1_000_000, 1_000_000, 0, 0, 0, 2.5, 10);
    expect(c).toBeCloseTo(12.5, 6); 
  });

  
  
  it("A-971：OpenAI/DeepSeek 语义（prompt 已含命中）→ 命中部分不按输入价重复计费", () => {
    
    const c = usage.computeRecordCost(
      1_000_000, 0, 0, 900_000, 0, 2.5, 10, 0.3, undefined, true,
    );
    expect(c).toBeCloseTo((100_000 * 2.5 + 900_000 * 0.3) / 1e6, 9);
    
    expect(c).not.toBeCloseTo((1_000_000 * 2.5 + 900_000 * 0.3) / 1e6, 9);
  });

  it("A-971：Anthropic 语义（input 不含命中）→ 命中与输入是并列项，不剔除", () => {
    const c = usage.computeRecordCost(
      1_000_000, 0, 0, 900_000, 0, 2.5, 10, 0.3, undefined, false,
    );
    expect(c).toBeCloseTo((1_000_000 * 2.5 + 900_000 * 0.3) / 1e6, 9);
  });

  it("A-971：缺缓存单价时按输入价收（不假设折扣，也不重复计费）", () => {
    const c = usage.computeRecordCost(
      1_000_000, 0, 0, 900_000, 0, 2.5, 10, undefined, undefined, true,
    );
    
    expect(c).toBeCloseTo((1_000_000 * 2.5) / 1e6, 9);
  });

  it("A-971：reasoning 是 completion 的子集 → 取较大值，不重复计费", () => {
    
    const c = usage.computeRecordCost(0, 100, 200, 0, 0, 1, 5);
    expect(c).toBeCloseTo((200 * 5) / 1e6, 9);
    expect(c).not.toBeCloseTo((100 * 5 + 200 * 5) / 1e6, 9); 
  });

  it("A-971：万一 reasoning 超出 completion，也不漏计", () => {
    const c = usage.computeRecordCost(0, 100, 250, 0, 0, 1, 5);
    expect(c).toBeCloseTo((250 * 5) / 1e6, 9);
  });

  it("cache_creation 用写价", () => {
    const c = usage.computeRecordCost(0, 0, 0, 0, 100, 1, 1, undefined, 12.5);
    expect(c).toBeCloseTo((100 * 12.5) / 1e6, 9);
  });

  it("A-971 回归：真实 deepseek-flash 记录不再虚高（样本 10.81×）", () => {
    
    const c = usage.computeRecordCost(
      13_399_272, 170_614, 0, 13_014_912, 0,
      0.225, 0.9, 0.0045, undefined, true,
    );
    expect(c).toBeCloseTo(0.298601, 5); 
  });

  it("defaultCacheReadInPrompt：Anthropic/Claude 系为 false，其余为 true", () => {
    expect(usage.defaultCacheReadInPrompt("anthropic", "claude-sonnet-4")).toBe(false);
    expect(usage.defaultCacheReadInPrompt("mykey", "claude-3-5-haiku")).toBe(false);
    expect(usage.defaultCacheReadInPrompt("deepseek", "deepseek-flash")).toBe(true);
    expect(usage.defaultCacheReadInPrompt("test-key", "m1")).toBe(true);
  });
});


describe("rotateIfNeeded", () => {
  it("文件不存在时不报错", async () => {
    await expect(usage.rotateIfNeeded()).resolves.toBeUndefined();
  });
});

describe("损坏行容错", () => {
  it("loadUsage 跳过损坏 JSON 行", async () => {
    await usage.clearUsage();
    
    const { writeFile } = await import("node:fs/promises");
    const ok1 = JSON.stringify({ ts: "2026-09-10T00:00:00Z", agent_id: "a", session_id: "s",
      model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: true });
    const ok2 = JSON.stringify({ ts: "2026-09-11T00:00:00Z", agent_id: "b", session_id: "s",
      model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: true });
    const path = process.env.SLIME_USAGE_PATH!;
    
    const { stat: fstat } = await import("node:fs/promises");
    const beforeStat = await fstat(path);
    await writeFile(path, [ok1, "{garbage line}", ok2].join("\n") + "\n", "utf8");
    const afterStat = await fstat(path);
    
    await usage.appendUsage({
      agent_id: "x", session_id: "s", model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: true,
    });
    
    const records = await usage.loadUsage();
    
    expect(records.length).toBeGreaterThanOrEqual(2);
    
    
    const hasGarbage = records.some((r) => (r as unknown as Record<string, unknown>).agent_id === undefined);
    expect(hasGarbage).toBe(false);
    void beforeStat; void afterStat;
  });
});






describe("历史成本回填 (recomputeOne / recomputeCosts / rewriteUsageCosts)", () => {
  const mk = (over: Partial<usage.UsageRecord> = {}): usage.UsageRecord => ({
    ts: "2026-09-16T00:00:00Z", agent_id: "a", session_id: "s",
    model: "deepseek-flash", provider_key: "deepseek",
    prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    elapsed_ms: 0, cost_usd: 0, success: true,
    ...over,
  });

  it("0 成本 + 有 token + 能解析到价 → 重算为真实成本", () => {
    const r = mk({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const { rec: next, changed } = usage.recomputeOne(r, () => ({ priceIn: 0.225, priceOut: 0.9 }));
    expect(changed).toBe(true);
    expect(next.cost_usd).toBeCloseTo(1.125, 9); 
  });

  it("只增不减：cost_usd>0 的记录原样保留，不篡改历史账目", () => {
    const r = mk({ cost_usd: 9.99, prompt_tokens: 1_000 });
    const { rec: next, changed } = usage.recomputeOne(r, () => ({ priceIn: 100, priceOut: 100 }));
    expect(changed).toBe(false);
    expect(next.cost_usd).toBe(9.99);
    expect(next).toBe(r); 
  });

  it("解析不到价 → 不改写（宁可留 0，也不编造价格）", () => {
    expect(usage.recomputeOne(mk({ prompt_tokens: 1_000 }), () => undefined).changed).toBe(false);
    expect(usage.recomputeOne(mk({ prompt_tokens: 1_000 }), () => ({})).changed).toBe(false);
  });

  it("无 token（失败请求）→ 不改写", () => {
    const r = mk({ success: false });
    expect(usage.recomputeOne(r, () => ({ priceIn: 1, priceOut: 1 })).changed).toBe(false);
  });

  it("免费模型（价目表显式 0）→ 保持 0，而且不产生无意义 diff", () => {
    const r = mk({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const { changed } = usage.recomputeOne(r, () => ({ priceIn: 0, priceOut: 0, priceCacheRead: 0 }));
    expect(changed).toBe(false);
  });

  it("reasoning / cache token 也一起重算", () => {
    const r = mk({ reasoning_tokens: 1_000_000, cache_read_tokens: 2_000_000 });
    const { rec: next, changed } = usage.recomputeOne(r, () => ({ priceIn: 0, priceOut: 3, priceCacheRead: 0.3 }));
    expect(changed).toBe(true);
    expect(next.cost_usd).toBeCloseTo(3.6, 9); 
  });

  it("recomputeCosts 统计改写条数与累计成本", () => {
    const rs = [
      mk({ prompt_tokens: 1_000_000, model: "m1" }),
      mk({ prompt_tokens: 1_000_000, model: "m2" }), 
      mk({ cost_usd: 5, prompt_tokens: 1_000_000, model: "m3" }),
    ];
    const resolve: usage.PriceResolver = (_p, m) => (m === "m1" ? { priceIn: 1, priceOut: 0 } : undefined);
    const out = usage.recomputeCosts(rs, resolve);
    expect(out.updated).toBe(1);
    expect(out.records).toHaveLength(3);
    expect(out.totalCostUsd).toBeCloseTo(6, 9); 
  });

  it("rewriteUsageCosts 落盘：只改 0 成本行，损坏行字节级保留", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const path = process.env.SLIME_USAGE_PATH!;
    const zero = JSON.stringify(mk({ prompt_tokens: 1_000_000, model: "m1" }));
    const paid = JSON.stringify(mk({ cost_usd: 5, prompt_tokens: 1_000_000, model: "m3" }));
    const body = [zero, "{broken line", paid].join("\n") + "\n";
    await writeFile(path, body, "utf8");

    const res = await usage.rewriteUsageCosts((_p, m) => (m === "m1" ? { priceIn: 2, priceOut: 0 } : undefined));
    expect(res.updated).toBe(1);
    expect(res.scanned).toBe(2); 
    expect(res.totalCostUsd).toBeCloseTo(7, 9);

    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); 
    expect(lines[1]).toBe("{broken line");
    expect(JSON.parse(lines[0]).cost_usd).toBeCloseTo(2, 9);
    expect(JSON.parse(lines[2]).cost_usd).toBe(5);
  });

  it("rewriteUsageCosts 无可改写项时完全不碰文件（不产生无意义 diff）", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const path = process.env.SLIME_USAGE_PATH!;
    const body = [JSON.stringify(mk({ prompt_tokens: 1_000_000, model: "free" }))].join("\n") + "\n";
    await writeFile(path, body, "utf8");
    const res = await usage.rewriteUsageCosts(() => ({ priceIn: 0, priceOut: 0 }));
    expect(res.updated).toBe(0);
    expect(await readFile(path, "utf8")).toBe(body);
  });

  
  
  it("A-971：unpriced 暴露「有 token 但查不到价」的条数（避免静默无操作）", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = process.env.SLIME_USAGE_PATH!;
    const body = [
      JSON.stringify(mk({ prompt_tokens: 1_000_000, model: "m1" })),      
      JSON.stringify(mk({ prompt_tokens: 1_000_000, model: "m2" })),      
      JSON.stringify(mk({ model: "m3" })),                                
    ].join("\n") + "\n";
    await writeFile(path, body, "utf8");
    const res = await usage.rewriteUsageCosts((_p, m) => (m === "m1" ? { priceIn: 1, priceOut: 0 } : undefined));
    expect(res.updated).toBe(1);
    expect(res.unpriced).toBe(1);
    expect(res.unpricedModels).toEqual(["m2"]); 
  });

  
  
  it("分时定价：解析器回传 tierId → 写进 price_tier 并计入 tiered", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const path = process.env.SLIME_USAGE_PATH!;
    const body = [
      JSON.stringify(mk({ ts: "2026-09-16T02:00:00Z", prompt_tokens: 1_000_000, model: "ds" })), 
      JSON.stringify(mk({ ts: "2026-09-16T18:00:00Z", prompt_tokens: 1_000_000, model: "ds" })), 
      JSON.stringify(mk({ ts: "2026-09-16T02:00:00Z", prompt_tokens: 1_000_000, model: "plain" })), 
    ].join("\n") + "\n";
    await writeFile(path, body, "utf8");

    const res = await usage.rewriteUsageCosts((_p, m, ts) => {
      if (m === "plain") { return { priceIn: 1, priceOut: 0 }; }
      const peak = String(ts).startsWith("2026-09-16T02");
      return peak
        ? { priceIn: 0.3, priceOut: 0, tierId: "peak" }
        : { priceIn: 0.15, priceOut: 0, tierId: "offpeak" };
    });
    expect(res.updated).toBe(3);
    expect(res.tiered).toBe(2); 

    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[0]).price_tier).toBe("peak");
    expect(JSON.parse(lines[1]).price_tier).toBe("offpeak");
    expect(JSON.parse(lines[2]).price_tier).toBeUndefined();
    
    expect(JSON.parse(lines[0]).cost_usd).toBeCloseTo(0.3, 9);
    expect(JSON.parse(lines[1]).cost_usd).toBeCloseTo(0.15, 9);
  });
});








describe("A-971 源码守卫：计价公式子集语义", () => {
  const strip = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")        
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");   

  const readUsageSrc = async () => {
    const { readFile } = await import("node:fs/promises");
    return strip(await readFile(join(process.cwd(), "core-ts/src/services/usage.ts"), "utf8"));
  };

  it("reasoning 不再与 completion 相加，而是取较大值", async () => {
    const src = await readUsageSrc();
    expect(src).not.toContain("cost += completionTokens * priceOutUsd");
    expect(src).toContain("Math.max(completionTokens, reasoningTokens)");
  });

  it("OpenAI/DeepSeek 语义下先把命中部分从输入里剔除（不再收两次）", async () => {
    const src = await readUsageSrc();
    expect(src).toContain("Math.max(0, promptTokens - cacheReadTokens)");
    expect(src).toContain("billableInput");
  });

  it("记录侧把 cache_read_in_prompt 一起落盘（历史行才能被准确回填）", async () => {
    const { readFile } = await import("node:fs/promises");
    const eng = strip(await readFile(join(process.cwd(), "core-ts/src/services/engine.ts"), "utf8"));
    expect(eng).toContain("cache_read_in_prompt: cacheReadInPrompt");
  });
});
