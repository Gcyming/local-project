/**
 * tests/core-ts/gateway.spec.ts — 网关核心逻辑（限流/认证/转发），mock sidecar 用本地 http server。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildGateway, SlidingWindowRateLimiter } from "../../gateway-ts/src/index.js";

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