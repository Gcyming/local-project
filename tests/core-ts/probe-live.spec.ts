import { describe, it, expect } from "vitest";
import {
  LiveProbeCache,
  extractSnapshot,
  nextAuthOnFailure,
  nextEndpointOnFailure,
  getSharedLiveProbe,
  setSharedLiveProbe,
  isModelDeadError,
} from "../../core-ts/src/probe-live.js";

describe("LiveProbeCache（TTL 实时能力缓存）", () => {
  it("写入后未过期可取回", () => {
    let t = 1_000_000;
    const c = new LiveProbeCache({ ttlMs: 100, now: () => t });
    c.put({ provider: "p", model: "m", ts: t });
    t += 50;
    expect(c.get("p", "m")?.model).toBe("m");
    expect(c.isStale("p", "m")).toBe(false);
  });

  it("TTL 过期 → get 返回 null，isStale true（该重探）", () => {
    let t = 1_000_000;
    const c = new LiveProbeCache({ ttlMs: 100, now: () => t });
    c.put({ provider: "p", model: "m", ts: t });
    t += 101;
    expect(c.get("p", "m")).toBeNull();
    expect(c.isStale("p", "m")).toBe(true);
  });

  it("不存在的模型 isStale true", () => {
    const c = new LiveProbeCache({ now: () => 0 });
    expect(c.isStale("nope", "x")).toBe(true);
  });

  it("size/clear/all", () => {
    const c = new LiveProbeCache();
    c.put({ provider: "a", model: "m1", ts: 0 });
    c.put({ provider: "a", model: "m2", ts: 0 });
    expect(c.size()).toBe(2);
    expect(c.all().length).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
  });
});

describe("extractSnapshot（从上游响应提取实时能力）", () => {
  it("成功响应：刷新能力位 + 清错误 + 估算 context", () => {
    const s = extractSnapshot("openai", "gpt-4o", {
      ok: true,
      usage: { prompt_tokens: 1000, completion_tokens: 50 },
      hasToolCalls: true,
      hasReasoning: false,
      streamed: true,
      latencyMs: 420,
    }, () => 999);
    expect(s.contextWindow).toBe(2000); // 1000*2
    expect(s.toolCalls).toBe(true);
    expect(s.streaming).toBe(true);
    expect(s.reasoning).toBe(false);
    expect(s.latencyMs).toBe(420);
    expect(s.lastErrorType).toBeUndefined();
    expect(s.ts).toBe(999);
  });

  it("失败响应：记录错误类型，无能力位", () => {
    const s = extractSnapshot("p", "m", { ok: false, errorStatus: 503, errorType: "local_model_error" }, () => 1);
    expect(s.lastErrorType).toBe("local_model_error");
    expect(s.toolCalls).toBeUndefined();
  });

  it("失败无 errorType 但有 status → HTTP xxx", () => {
    const s = extractSnapshot("p", "m", { ok: false, errorStatus: 404 });
    expect(s.lastErrorType).toBe("HTTP 404");
  });

  it("404 / 模型不可用正文 → modelDead=true；401/403/429（供应商级）→ modelDead 保持 false", () => {
    // 模型级失效：404 或 "Model is unavailable" 正文
    const dead404 = extractSnapshot("openai", "gpt-x", { ok: false, errorStatus: 404 });
    expect(dead404.modelDead).toBe(true);
    const deadBody = extractSnapshot("agg", "model", { ok: false, errorType: "upstream|model|Model is unavailable" });
    expect(deadBody.modelDead).toBe(true);
    // 供应商级（换模型无用）：401/429 不置 modelDead（显式 false）
    const auth = extractSnapshot("openai", "gpt-4o", { ok: false, errorStatus: 401, errorType: "upstream" });
    expect(auth.modelDead).toBe(false);
    const quota = extractSnapshot("openai", "gpt-4o", { ok: false, errorStatus: 429, errorType: "rate_limited" });
    expect(quota.modelDead).toBe(false);
  });
});

describe("isModelDeadError（模型级失效判定，纯函数）", () => {
  it("404 → true", () => {
    expect(isModelDeadError(undefined, 404)).toBe(true);
  });
  it("正文含 'model not found' / 'Model is unavailable' / RegionError → true", () => {
    expect(isModelDeadError("model not found")).toBe(true);
    expect(isModelDeadError("Model is unavailable")).toBe(true);
    expect(isModelDeadError("RegionError: not available in your country")).toBe(true);
  });
  it("供应商级（401/403/429/超时）→ false", () => {
    expect(isModelDeadError("upstream", 401)).toBe(false);
    expect(isModelDeadError("unauthorized", 403)).toBe(false);
    expect(isModelDeadError("rate_limited", 429)).toBe(false);
    expect(isModelDeadError("timeout", 0)).toBe(false);
  });
});

describe("LiveProbeCache.isDead（引擎前置剔除的查询口）", () => {
  it("未过期 + modelDead=true → isDead true；过期 → false", () => {
    let t = 1_000_000;
    const c = new LiveProbeCache({ ttlMs: 100, now: () => t });
    c.put({ provider: "p", model: "dead", ts: t, modelDead: true });
    c.put({ provider: "p", model: "alive", ts: t, modelDead: false });
    expect(c.isDead("p", "dead")).toBe(true);
    expect(c.isDead("p", "alive")).toBe(false);
    expect(c.isDead("p", "nope")).toBe(false); // 无快照 ≠ 失效
    t += 101; // 过期
    expect(c.isDead("p", "dead")).toBe(false); // 过期后恢复（下轮重探）
  });
});

describe("nextAuthOnFailure（鉴权降级决策）", () => {
  it("401 openai 系 → 换 x-api-key", () => {
    const d = nextAuthOnFailure("openai", undefined, 401);
    expect(d.authSwap).toBe("x-api-key");
    expect(d.abandon).toBeFalsy();
  });
  it("403 anthropic → 换 bearer", () => {
    const d = nextAuthOnFailure("anthropic", "unauthorized", 403);
    expect(d.authSwap).toBe("bearer");
  });
  it("404 模型不存在 → abandon（切下一个）", () => {
    const d = nextAuthOnFailure("openai", "model not found", 404);
    expect(d.abandon).toBe(true);
  });
  it("429 配额 → 不换模型（标记等待/换 provider）", () => {
    const d = nextAuthOnFailure("openai", "rate limit", 429);
    expect(d.abandon).toBeUndefined();
    expect(d.authSwap).toBeUndefined();
  });
  it("503 → abandon（降级换模型）", () => {
    const d = nextAuthOnFailure("openai", "unavailable", 503);
    expect(d.abandon).toBe(true);
  });
});

describe("nextEndpointOnFailure（端点候选降级）", () => {
  it("/v1/models 404 → /api/v1/models", () => {
    expect(nextEndpointOnFailure("https://x/v1/models", 404)).toBe("https://x/api/v1/models");
  });
  it("/api/v1/models 404 → /models", () => {
    expect(nextEndpointOnFailure("https://x/api/v1/models", 404)).toBe("https://x/models");
  });
  it("/models（最后一级）→ undefined", () => {
    expect(nextEndpointOnFailure("https://x/models", 404)).toBeUndefined();
  });
  it("非 404 → undefined（不换端点）", () => {
    expect(nextEndpointOnFailure("https://x/v1/models", 500)).toBeUndefined();
  });
});

describe("LiveProbeCache.hydrate + 进程级共享单例", () => {
  it("hydrate：恢复未过期条目，丢弃已过期条目", () => {
    let t = 1_000_000;
    const c = new LiveProbeCache({ ttlMs: 100, now: () => t });
    // 直接构造快照（模拟落盘后读回的条目；ts 相对 now 判断过期）
    c.hydrate([
      { provider: "p", model: "fresh", ts: t },           // 未过期
      { provider: "p", model: "stale", ts: t - 500 },     // 已过期（> ttl）
      { provider: "bad", model: "x" } as never,            // 缺 ts → 丢弃
    ]);
    expect(c.get("p", "fresh")).not.toBeNull();
    expect(c.get("p", "stale")).toBeNull();
    expect(c.isStale("p", "stale")).toBe(true);
    expect(c.size()).toBe(1);
  });

  it("getSharedLiveProbe：多次调用返回同一实例；setSharedLiveProbe 可替换", () => {
    const a = getSharedLiveProbe();
    const b = getSharedLiveProbe();
    expect(a).toBe(b);
    const custom = new LiveProbeCache({ now: () => 0 });
    setSharedLiveProbe(custom);
    expect(getSharedLiveProbe()).toBe(custom);
    // 复位（避免跨测试污染其它用例的全局单例）
    setSharedLiveProbe(null);
  });
});

