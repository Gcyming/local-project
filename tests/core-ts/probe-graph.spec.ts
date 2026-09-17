/**
 * tests/core-ts/probe-graph.spec.ts — 探针层第 3 层（能力知识图谱）测试。
 * 全 mock 注入（statics/live 均可隔离），不发真实 HTTP、不碰全局单例数据（用例内显式 setShared 后复位）。
 *
 * 验证：
 * - resolve：三层融合（实时 > 静态；health 四态判定；endpoint 覆盖优先级）
 * - rank：ok（按延迟）→ unknown → degraded → dead 排序
 * - explain：单行可读输出
 * - 共享单例 get/set + 缺省静态层 = shared/model-capabilities
 */
import { describe, it, expect } from "vitest";
import {
  CapabilityGraph,
  GraphNode,
  getSharedCapabilityGraph,
  setSharedCapabilityGraph,
} from "../../core-ts/src/probe-graph.js";
import { LiveProbeCache } from "../../core-ts/src/probe-live.js";

/** 可控静态层（不依赖真能力表，隔离测试） */
describe("CapabilityGraph.resolve（三层融合）", () => {
  const t0 = 1_000_000;
  function fixture() {
    const live = new LiveProbeCache({ ttlMs: 60_000, now: () => t0 });
    // 静态层：固定返回 gpt-4o 家族能力
    const statics = {
      capsFor: (id: string) => {
        if (id === "gpt-4o") {
          return { supported: true, efforts: ["low", "high"], vendor: "openai", thinkingParam: "reasoning_effort" as const, endpoint: "responses" as const, context: 1000000, maxOut: 128000 };
        }
        if (id === "dead-model") {
          return { supported: true, vendor: "unknown", thinkingParam: "reasoning_effort" as const, endpoint: "openai" as const };
        }
        return { supported: false, vendor: "unknown", thinkingParam: "reasoning_effort" as const, endpoint: "openai" as const };
      },
    };
    return { live, statics, g: new CapabilityGraph({ statics, live }) };
  }

  it("无快照 → health=unknown，上下文走静态兜底", () => {
    const { g } = fixture();
    const n = g.resolve("openai", "gpt-4o");
    expect(n.health).toBe("unknown");
    expect(n.context).toBe(1000000); // 静态兜底
    expect(n.endpoint).toBe("responses"); // 静态层端点
    expect(n.live).toBeUndefined();
    expect(n.notes.some((s) => s.includes("无新鲜快照"))).toBe(true);
  });

  it("实时成功快照 → health=ok，实测 contextWindow 覆盖静态兜底", () => {
    const { g, live } = fixture();
    live.put({ provider: "openai", model: "gpt-4o", ts: t0, contextWindow: 512_000, latencyMs: 320, toolCalls: true, reasoning: true });
    const n = g.resolve("openai", "gpt-4o");
    expect(n.health).toBe("ok");
    expect(n.context).toBe(512_000); // 实时 > 静态
    expect(n.maxOut).toBe(128000); // 实时层暂无输出位 → 静态
    expect(n.live?.toolCalls).toBe(true);
    expect(n.live?.reasoning).toBe(true);
  });

  it("实时失败快照（未判死）→ health=degraded", () => {
    const { g, live } = fixture();
    live.put({ provider: "openai", model: "gpt-4o", ts: t0, lastErrorType: "upstream|provider|429 rate" });
    expect(g.resolve("openai", "gpt-4o").health).toBe("degraded");
  });

  it("modelDead=true → health=dead（引擎前置剔除依据）", () => {
    const { g, live } = fixture();
    live.put({ provider: "opencode", model: "dead-model", ts: t0, modelDead: true, lastErrorType: "HTTP 404" });
    const n = g.resolve("opencode", "dead-model");
    expect(n.health).toBe("dead");
    expect(g.liveDead("opencode", "dead-model")).toBe(true);
  });

  it("快照过期（TTL 外）→ 回退 unknown（该重探）", () => {
    const live = new LiveProbeCache({ ttlMs: 60_000, now: () => t0 });
    live.put({ provider: "p", model: "m", ts: t0, latencyMs: 10 });
    const g = new CapabilityGraph({ statics: fixture().statics, live: new LiveProbeCache({ ttlMs: 60_000, now: () => t0 + 61_000 }) });
    expect(g.resolve("p", "m").health).toBe("unknown"); // reader 侧 now 已过期
    expect(live.get("p", "m")?.latencyMs).toBe(10); // writer 侧未过期（数据仍在）
  });

  it("apiFormatOverride > 静态 endpoint > 缺省 openai", () => {
    const { g } = fixture();
    expect(g.resolve("openai", "gpt-4o").endpoint).toBe("responses"); // 静态层
    expect(g.resolve("openai", "gpt-4o", "openai").endpoint).toBe("openai"); // 路由覆盖优先
    expect(g.resolve("other", "mystery-model").endpoint).toBe("openai"); // 缺省
  });
});

describe("CapabilityGraph.rank（候选推荐排序）", () => {
  const t0 = 1_000_000;
  function fixture() {
    const live = new LiveProbeCache({ ttlMs: 60_000, now: () => t0 });
    live.put({ provider: "agg", model: "fast", ts: t0, latencyMs: 90 });
    live.put({ provider: "agg", model: "slow", ts: t0, latencyMs: 800 });
    live.put({ provider: "agg", model: "flaky", ts: t0, lastErrorType: "upstream|model|unavailable" });
    live.put({ provider: "agg", model: "gone", ts: t0, modelDead: true, lastErrorType: "HTTP 404" });
    const statics = {
      capsFor: () => ({ supported: true, vendor: "unknown", thinkingParam: "reasoning_effort" as const, endpoint: "openai" as const }),
    };
    return new CapabilityGraph({ statics, live });
  }

  it("ok（按实测延迟升序）→ unknown → degraded → dead", () => {
    const g = fixture();
    // 输入乱序（dead 在前、unknown 在中），排序后应严格分档
    const ranked = g.rank("agg", ["gone", "mystery", "flaky", "slow", "fast"]);
    expect(ranked).toEqual(["fast", "slow", "mystery", "flaky", "gone"]);
  });

  it("同档内稳定（未知模型保持原相对顺序）", () => {
    const g = fixture();
    const ranked = g.rank("agg", ["gone", "flaky", "slow", "fast"]);
    // 两 unknown？无。fast/slow 同 ok 档按延迟：fast(90) < slow(800)；flaky degraded；gone dead
    expect(ranked).toEqual(["fast", "slow", "flaky", "gone"]);
  });

  it("全未知 → 原顺序保持（不洗牌）", () => {
    const g = fixture();
    expect(g.rank("agg", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("CapabilityGraph.explain（单行可读）", () => {
  it("ok 节点含家族/协议/延迟", () => {
    const t0 = 1_000_000;
    const live = new LiveProbeCache({ now: () => t0 });
    live.put({ provider: "openai", model: "gpt-4o", ts: t0, latencyMs: 300 });
    const g = new CapabilityGraph({ live });
    const n: GraphNode = g.resolve("openai", "gpt-4o");
    const line = g.explain(n);
    expect(line).toContain("openai:gpt-4o");
    expect(line).toContain("[ok]");
    expect(line).toContain("300ms");
  });

  it("unknown 节点标注待重探", () => {
    const g = new CapabilityGraph({ live: new LiveProbeCache() });
    const line = g.explain(g.resolve("p", "nope"));
    expect(line).toContain("[unknown]");
    expect(line).toContain("待重探");
  });
});

describe("共享单例 + 缺省静态层", () => {
  it("getSharedCapabilityGraph 同一实例；set 可替换/复位", () => {
    const a = getSharedCapabilityGraph();
    expect(getSharedCapabilityGraph()).toBe(a);
    const custom = new CapabilityGraph();
    setSharedCapabilityGraph(custom);
    expect(getSharedCapabilityGraph()).toBe(custom);
    setSharedCapabilityGraph(null); // 复位（防跨用例污染全局单例）
  });

  it("缺省静态层 = shared/model-capabilities（GPT-5 家族 → responses 端点）", () => {
    const g = new CapabilityGraph({ live: new LiveProbeCache() });
    const n = g.resolve("openai", "gpt-5");
    expect(n.endpoint).toBe("responses"); // 真表 gpt[-_]?[5-9] → 官方 responses 端点
    expect(n.thinking.supported).toBe(true);
    expect(n.thinking.efforts?.length).toBeGreaterThan(0);
  });
});
