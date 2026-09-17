/**
 * tests/core-ts/usage.spec.ts — usage store + 聚合 测试。
 * 策略：所有测试共享一个临时路径（beforeAll 设置 SLIME_USAGE_PATH）；
 * 每个测试用例在 beforeEach 中 clearUsage()，互不干扰。
 */
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
    // fixture 时间：
    //   2026-09-10T08:00Z → 本地 16:00 → 09-10（1 条）
    //   2026-09-10T20:30Z → 本地次日 04:30 → 09-11（2 条合并：这条 + fixture3）
    //   2026-09-11T03:15Z → 本地 11:15 → 09-11
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
    const cells = usage.aggregateHeatmap(records, 0); // UTC
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
      { provider_key: "openai", model_id: "gpt-4o-mini", price_in_usd: 0.15, price_out_usd: 0.6 },   // 配置但未用
      { provider_key: "anthropic", model_id: "claude-sonnet-4-20250514", price_in_usd: 3, price_out_usd: 15 }, // 配置但未用
    ];
    const buckets = usage.aggregateByConfiguredModels(records, configured);
    // 只保留「配置过且调用过」的 gpt-4o
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
    expect(c).toBeCloseTo(12.5, 6); // (1M*2.5 + 1M*10) / 1e6 = 12.5
  });

  // ── A-971 定价虚高事故：子集字段被当成并列项相加 ──────────────────────
  // 旧口径实测整体虚高 5.02×（单条最坏 10.81×），以下四条锁住修正后的语义。
  it("A-971：OpenAI/DeepSeek 语义（prompt 已含命中）→ 命中部分不按输入价重复计费", () => {
    // prompt 1M 其中 900K 命中：只有 100K 走输入价，900K 走缓存价
    const c = usage.computeRecordCost(
      1_000_000, 0, 0, 900_000, 0, 2.5, 10, 0.3, undefined, true,
    );
    expect(c).toBeCloseTo((100_000 * 2.5 + 900_000 * 0.3) / 1e6, 9);
    // 旧口径（全额输入 + 命中再收一遍）= 2.77，明确断言不再复现
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
    // 退化成「全部输入按输入价」——既不高估优惠，也不重复计
    expect(c).toBeCloseTo((1_000_000 * 2.5) / 1e6, 9);
  });

  it("A-971：reasoning 是 completion 的子集 → 取较大值，不重复计费", () => {
    // 实测本机 47 条带推理 token 的记录，47/47 全部 reasoning < completion
    const c = usage.computeRecordCost(0, 100, 200, 0, 0, 1, 5);
    expect(c).toBeCloseTo((200 * 5) / 1e6, 9);
    expect(c).not.toBeCloseTo((100 * 5 + 200 * 5) / 1e6, 9); // 旧的相加口径已废弃
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
    // 样本取自 config/usage.jsonl 2026-09-16T09:08:44.261Z（deepseek-flash）
    const c = usage.computeRecordCost(
      13_399_272, 170_614, 0, 13_014_912, 0,
      0.225, 0.9, 0.0045, undefined, true,
    );
    expect(c).toBeCloseTo(0.298601, 5); // 旧口径算出 $3.226956
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
    // 直接 append 一行损坏记录：通过 writeFile 模拟
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
    // 写入前先确认路径存在
    const { stat: fstat } = await import("node:fs/promises");
    const beforeStat = await fstat(path);
    await writeFile(path, [ok1, "{garbage line}", ok2].join("\n") + "\n", "utf8");
    const afterStat = await fstat(path);
    // 强制 invalidate：通过 appendUsage 触发 invalidation
    await usage.appendUsage({
      agent_id: "x", session_id: "s", model: "m", provider_key: "p",
      prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0,
      elapsed_ms: 0, cost_usd: 0, success: true,
    });
    // 这次 append 会 invalidate 缓存并写入第 4 行
    const records = await usage.loadUsage();
    // 期望至少读到原 2 行 OK + 新 1 行 = 3 行（损坏行被跳过）
    expect(records.length).toBeGreaterThanOrEqual(2);
    const hasGarbage = records.some((r) => (r as Record<string, unknown>).agent_id === undefined);
    expect(hasGarbage).toBe(false);
    void beforeStat; void afterStat;
  });
});
/* ═══════════ 历史成本回填（A-9xx 定价事故的收尾） ═══════════
 * 事故：usage.jsonl 的 cost_usd 在写入那一刻固化，价格表全线失守 → 实测 1606 条记录 100%
 * 为 0（总消耗 $0.0000），包括 27.1M tokens 的 deepseek-flash、19.5M 的 agnes-3.0-flash。
 * 价格表修好后历史记录不会自己变，必须用当前价格重算（`slime:usage:recompute`）。
 * 下面这些用例锁住"只增不减、免费不误计费、损坏行不动"三条不变量。
 */
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
    expect(next.cost_usd).toBeCloseTo(1.125, 9); // (1M*0.225 + 1M*0.9) / 1e6
  });

  it("只增不减：cost_usd>0 的记录原样保留，不篡改历史账目", () => {
    const r = mk({ cost_usd: 9.99, prompt_tokens: 1_000 });
    const { rec: next, changed } = usage.recomputeOne(r, () => ({ priceIn: 100, priceOut: 100 }));
    expect(changed).toBe(false);
    expect(next.cost_usd).toBe(9.99);
    expect(next).toBe(r); // 未改写对象本身
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
    expect(next.cost_usd).toBeCloseTo(3.6, 9); // (1M*3 + 2M*0.3) / 1e6
  });

  it("recomputeCosts 统计改写条数与累计成本", () => {
    const rs = [
      mk({ prompt_tokens: 1_000_000, model: "m1" }),
      mk({ prompt_tokens: 1_000_000, model: "m2" }), // 解析不到价
      mk({ cost_usd: 5, prompt_tokens: 1_000_000, model: "m3" }),
    ];
    const resolve: usage.PriceResolver = (_p, m) => (m === "m1" ? { priceIn: 1, priceOut: 0 } : undefined);
    const out = usage.recomputeCosts(rs, resolve);
    expect(out.updated).toBe(1);
    expect(out.records).toHaveLength(3);
    expect(out.totalCostUsd).toBeCloseTo(6, 9); // 1 + 0 + 5
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
    expect(res.scanned).toBe(2); // 损坏行不计入 scanned
    expect(res.totalCostUsd).toBeCloseTo(7, 9);

    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // 没有丢行、也没有多行
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

  // A-971：上一版只有 updated，"解析器一条价都没解析出来"与"确实没有可回填项"
  // 在界面上长得一样（都显示"无可回填项"），把故障伪装成了成功。unpriced 专门用于区分。
  it("A-971：unpriced 暴露「有 token 但查不到价」的条数（避免静默无操作）", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = process.env.SLIME_USAGE_PATH!;
    const body = [
      JSON.stringify(mk({ prompt_tokens: 1_000_000, model: "m1" })),      // 有价 → 回填
      JSON.stringify(mk({ prompt_tokens: 1_000_000, model: "m2" })),      // 无价 → unpriced
      JSON.stringify(mk({ model: "m3" })),                                // 无 token → 不计 unpriced
    ].join("\n") + "\n";
    await writeFile(path, body, "utf8");
    const res = await usage.rewriteUsageCosts((_p, m) => (m === "m1" ? { priceIn: 1, priceOut: 0 } : undefined));
    expect(res.updated).toBe(1);
    expect(res.unpriced).toBe(1);
    expect(res.unpricedModels).toEqual(["m2"]); // 只列出真正缺价的模型，供用户判断该不该手填
  });

  // 分时（峰谷）定价：解析器回传 tierId 时必须**落盘**并计数。
  // 没有这个数字，"一律按均价算"与"逐条按时刻分档"在界面上长得一模一样 —— 功能等于隐形。
  it("分时定价：解析器回传 tierId → 写进 price_tier 并计入 tiered", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const path = process.env.SLIME_USAGE_PATH!;
    const body = [
      JSON.stringify(mk({ ts: "2026-09-16T02:00:00Z", prompt_tokens: 1_000_000, model: "ds" })), // 高峰
      JSON.stringify(mk({ ts: "2026-09-16T18:00:00Z", prompt_tokens: 1_000_000, model: "ds" })), // 空闲
      JSON.stringify(mk({ ts: "2026-09-16T02:00:00Z", prompt_tokens: 1_000_000, model: "plain" })), // 非分时
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
    expect(res.tiered).toBe(2); // 只有分时模型那两条带档位

    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[0]).price_tier).toBe("peak");
    expect(JSON.parse(lines[1]).price_tier).toBe("offpeak");
    expect(JSON.parse(lines[2]).price_tier).toBeUndefined();
    // 不同时刻 → 不同单价：这就是分时定价的全部意义（同一模型两条记录价不同）
    expect(JSON.parse(lines[0]).cost_usd).toBeCloseTo(0.3, 9);
    expect(JSON.parse(lines[1]).cost_usd).toBeCloseTo(0.15, 9);
  });
});

/**
 * A-971 源码守卫：计价公式的「子集字段 vs 并列项」语义是**纯计算逻辑** ——
 * tsc 不报错、产物断言也只能证明函数在包里，抓不到公式本身写错（实测虚高 5.02× 就是这么漏出去的）。
 * 这类缺陷只能锁源码约定。
 * ⚠️ 必须先剥掉注释：修复说明会引用旧写法做对照，全文 `not.toContain` 会被自己的注释判失败
 * （todo-tasks.spec 已踩过这个坑）。
 */
describe("A-971 源码守卫：计价公式子集语义", () => {
  const strip = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")        // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");   // 行注释（排除 http:// 里的 ://）

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
