/**
 * tests/core-ts/gateway.spec.ts — 网关核心逻辑（限流/认证/转发），mock sidecar 用本地 http server。
 * 服务端点契约（/chat /swarm /stats /agents）注入 Fake services 验证。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildGateway, SlidingWindowRateLimiter } from "../../gateway-ts/src/index.js";
import { ChatService } from "../../core-ts/src/services/chat.js";
import { SwarmService } from "../../core-ts/src/services/swarm.js";
import { StatsService, AlarmBus } from "../../core-ts/src/services/stats.js";
import { AgentRegistry } from "../../core-ts/src/services/agents.js";
import { getSharedLiveProbe, setSharedLiveProbe, LiveProbeCache } from "../../core-ts/src/probe-live.js";
import type { ProviderConfig } from "../../core-ts/src/services/engine.js";

describe("SlidingWindowRateLimiter", () => {
  it("窗口内允许 maxHits 次", () => {
    const l = new SlidingWindowRateLimiter(3, 60_000);
    expect(l.check("a", 0)).toBe(true);
    expect(l.check("a", 1)).toBe(true);
    expect(l.check("a", 2)).toBe(true);
    expect(l.check("a", 3)).toBe(false);
  });

  it("滑窗后放行（旧条目过期）", () => {
    const l = new SlidingWindowRateLimiter(1, 60_000);
    expect(l.check("a", 0)).toBe(true);
    expect(l.check("a", 60_001)).toBe(true);
  });

  it("不同 key 互不影响", () => {
    const l = new SlidingWindowRateLimiter(1, 60_000);
    expect(l.check("a", 0)).toBe(true);
    expect(l.check("b", 0)).toBe(true);
  });

  it("sweep 清理过期空条目", () => {
    const l = new SlidingWindowRateLimiter(1, 60_000);
    l.check("a", 0);
    l.check("b", 0);
    expect(l.sweep(120_000)).toBe(2);
    expect(l.sweep(120_000)).toBe(0);
  });
});

describe("buildGateway", () => {
  const TOKEN = "test-token-abc";
  let sidecar: Server;
  let sidecarPort = 0;
  let app: ReturnType<typeof buildGateway>;

  beforeAll(async () => {
    sidecar = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (req.url === "/v1/retrieve") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results: [{ agent_id: "a1" }], took_ms: 1 }));
          return;
        }
        if (req.url === "/chat/completions") {
          const wantStream = body.includes('"stream":true');
          if (wantStream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n');
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    sidecarPort = (sidecar.address() as AddressInfo).port;
    app = buildGateway({
      port: 0,
      authToken: TOKEN,
      sidecarBaseUrl: `http://127.0.0.1:${sidecarPort}`,
      rateLimitPerMin: 1000,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => sidecar.close(() => resolve()));
  });

  it("无 token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("错误 token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/stats", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("正确 token → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/stats", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it("/health 豁免认证", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("/v1/retrieve 转发到 sidecar", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/retrieve",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agent_id: "a1", query: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].agent_id).toBe("a1");
  });

  it("/chat/completions stream=true → SSE 透传", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat/completions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { model: "qwen", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("[DONE]");
  });

  it("sidecar 不可达 → 502", async () => {
    const dead = buildGateway({
      port: 0,
      authToken: TOKEN,
      sidecarBaseUrl: "http://127.0.0.1:1",
      rateLimitPerMin: 1000,
    });
    await dead.ready();
    const res = await dead.inject({
      method: "POST",
      url: "/v1/retrieve",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agent_id: "a1", query: "x" },
    });
    expect(res.statusCode).toBe(502);
    await dead.close();
  });
});

describe("buildGateway 限流", () => {
  const TOKEN = "rate-limit-token";
  let app: ReturnType<typeof buildGateway>;

  beforeAll(async () => {
    app = buildGateway({
      port: 0,
      authToken: TOKEN,
      sidecarBaseUrl: "http://127.0.0.1:1",
      rateLimitPerMin: 5,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("超过限流 → 429（/health 亦受限，前 5 次 200）", async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) {
      last = (await app.inject({ method: "GET", url: "/health" })).statusCode;
    }
    const sixth = await app.inject({ method: "GET", url: "/health" });
    expect(last).toBe(200);
    expect(sixth.statusCode).toBe(429);
  });
});

describe("buildGateway 服务端点（注入 Fake services）", () => {
  const TOKEN = "svc-token";
  let app: ReturnType<typeof buildGateway>;
  const analyzeMock = vi.fn(async () => ({ action: "chat", subtasks: [] as string[], reason: "", parse_ok: false }));
  const chatMock = vi.fn(async () => ({ reply: "ok", model: "m", success: true, raw_reply: "ok" }));
  const streamMock = vi.fn(async function* () {
    yield { seq: 1, type: "chunk", data: { content: "你" } };
    yield { seq: 2, type: "chunk", data: { content: "好" } };
    yield { seq: 3, type: "done", data: { reply: "你好", reply_raw: "你好" } };
  });
  const chat = {
    analyze: analyzeMock,
    chat: chatMock,
    stream: streamMock,
  } as unknown as ChatService;
  const swarm = {
    dispatch: vi.fn(async () => ({ task_id: "t1", agent_snapshots: [], warnings: [] })),
    report: vi.fn(async () => ({ ok: true, success: true })),
  } as unknown as SwarmService;
  const agents = {
    loadedAgents: Promise.resolve([{ id: "a1", name: "A1", role: "r" }]),
    list: vi.fn(async () => [{ id: "a1", name: "A1" }]),
  } as unknown as AgentRegistry;
  const alarms = new AlarmBus();
  const stats = new StatsService(
    { loadedAgents: [] } as unknown as AgentRegistry,
    alarms,
  );
  vi.spyOn(stats, "servers").mockResolvedValue([]);
  vi.spyOn(stats, "sessions").mockResolvedValue({ totalRecords: 0, recent: 0 });

  beforeAll(async () => {
    app = buildGateway(
      { port: 0, authToken: TOKEN, sidecarBaseUrl: "http://127.0.0.1:1", rateLimitPerMin: 1000 },
      { chat, swarm, stats, agents },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("/agents → list", async () => {
    const res = await app.inject({ method: "GET", url: "/agents", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: "a1", name: "A1", role: "r", children: [], parent_id: undefined, lifecycle: "growth" }]);
  });

  it("POST /agents/:id/chat/analyze → 解析结果", async () => {
    analyzeMock.mockResolvedValueOnce({ action: "swarm", subtasks: ["x"], reason: "r", parse_ok: true });
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/chat/analyze",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { message: "多任务" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ action: "swarm", subtasks: ["x"], reason: "r", parse_ok: true });
  });

  it("POST /agents/:id/chat → 聊天结果", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/chat",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe("ok");
  });

  it("POST /agents/:id/chat/stream → SSE 帧 {seq,type,data}", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/chat/stream",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = res.body
      .split("\n\n")
      .filter((f) => f.startsWith("data:"))
      .map((f) => JSON.parse(f.slice(5).trim()));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ seq: 1, type: "chunk", data: { content: "你" } });
    expect(frames[2].type).toBe("done");
  });

  it("POST /agents/:id/swarm → dispatch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/swarm",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { task: "任务" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task_id).toBe("t1");
  });

  it("POST /agents/:id/swarm/report → report", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/swarm/report",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agent_id: "a1", task: "t", summary: "s", results: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, success: true });
  });

  it("GET /stats → snapshot", async () => {
    const res = await app.inject({ method: "GET", url: "/stats", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("servers");
    expect(body).toHaveProperty("agents");
    expect(body).toHaveProperty("sessions");
    expect(body).toHaveProperty("alarms");
    expect(body).toHaveProperty("timestamp");
  });
});

describe("buildGateway 服务端点错误路径", () => {
  const TOKEN = "err-token";
  let app: ReturnType<typeof buildGateway>;
  const chat = {
    analyze: vi.fn(async () => { throw new Error("Agent 不存在"); }),
    chat: vi.fn(async () => { throw new Error("boom"); }),
    stream: vi.fn(async function* () { throw new Error("stream boom"); }),
  } as unknown as ChatService;
  const swarm = {
    dispatch: vi.fn(async () => { throw new Error("任务失败"); }),
    report: vi.fn(async () => { throw new Error("校验失败"); }),
  } as unknown as SwarmService;
  const agents = { loadedAgents: Promise.resolve([]), list: vi.fn(async () => []) } as unknown as AgentRegistry;
  const stats = new StatsService({ loadedAgents: [] } as unknown as AgentRegistry, new AlarmBus());
  vi.spyOn(stats, "servers").mockResolvedValue([]);
  vi.spyOn(stats, "sessions").mockResolvedValue({ totalRecords: 0, recent: 0 });

  beforeAll(async () => {
    app = buildGateway(
      { port: 0, authToken: TOKEN, sidecarBaseUrl: "http://127.0.0.1:1", rateLimitPerMin: 1000 },
      { chat, swarm, stats, agents },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("analyze 抛错 → 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/chat/analyze",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe("Agent 不存在");
  });

  it("chat 抛错 → 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/chat",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(500);
  });

  it("swarm/report 抛错 → 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agents/a1/swarm/report",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agent_id: "a1", task: "t", summary: "s", results: [] },
    });
    expect(res.statusCode).toBe(500);
  });
});

describe("buildGateway LLM 转发网关 /v1/capabilities（第 3 层能力知识图谱诊断端点）", () => {
  const TOKEN = "cap-token";
  let app: ReturnType<typeof buildGateway>;
  let savedProbe: ReturnType<typeof getSharedLiveProbe> | null = null;

  const providers: Record<string, ProviderConfig> = {
    agg: {
      api_base: "https://agg.example.com/v1",
      api_key: "sk",
      api_format: "openai",
      models: [
        { id: "fast-model", selected: true },
        { id: "slow-model", selected: true },
        { id: "dead-model", selected: true },
      ],
    },
  } as unknown as Record<string, ProviderConfig>;

  beforeAll(async () => {
    app = buildGateway({
      port: 0,
      authToken: TOKEN,
      sidecarBaseUrl: "http://127.0.0.1:1",
      rateLimitPerMin: 1000,
      llmGateway: { enabled: true, projectRoot: process.cwd(), providers },
    });
    await app.ready();
    // 用独立实时缓存隔离（注入已知快照，避免污染全局单例/其它用例）
    const t0 = 2_000_000;
    const live = new LiveProbeCache({ ttlMs: 60_000, now: () => t0 });
    live.put({ provider: "agg", model: "fast-model", ts: t0, latencyMs: 80 });
    live.put({ provider: "agg", model: "slow-model", ts: t0, latencyMs: 900 });
    live.put({ provider: "agg", model: "dead-model", ts: t0, modelDead: true, lastErrorType: "HTTP 404" });
    savedProbe = getSharedLiveProbe();
    setSharedLiveProbe(live);
  });

  afterAll(async () => {
    await app.close();
    setSharedLiveProbe(savedProbe); // 复位全局单例
  });

  it("未认证 → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/capabilities?provider=agg → 节点 + 推荐排序（fast<slow<dead）+ 健康态", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities?provider=agg", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("capability_graph");
    expect(body.provider).toBe("agg");
    expect(body.nodes).toHaveLength(3);
    // ranked：ok 档按实测延迟（fast 80ms < slow 900ms），dead 垫底
    expect(body.ranked.agg).toEqual(["fast-model", "slow-model", "dead-model"]);
    // 健康态
    const byModel = Object.fromEntries(body.nodes.map((n: { model: string; health: string }) => [n.model, n.health]));
    expect(byModel["fast-model"]).toBe("ok");
    expect(byModel["slow-model"]).toBe("ok");
    expect(byModel["dead-model"]).toBe("dead");
    // explain 行可读
    expect(Array.isArray(body.explain)).toBe(true);
    expect(body.explain.some((s: string) => s.includes("[dead]"))).toBe(true);
  });

  it("GET /v1/capabilities（不带 provider）→ 聚合全 provider", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe(null);
    expect(body.ranked.agg).toContain("fast-model");
  });

  it("GET /v1/capabilities?provider=agg:dead-model → 只出该模型", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities?provider=agg:dead-model", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].model).toBe("dead-model");
    expect(body.nodes[0].health).toBe("dead");
  });
});