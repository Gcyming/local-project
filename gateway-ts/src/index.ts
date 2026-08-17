/**
 * gateway-ts/src/index.ts — Fastify 网关：Bearer 认证 / IP 滑动窗口限流 / CORS，转发到 sidecar。
 * 语义移植自 slime_server.py：
 * - Bearer 认证（auth_token，恒定时间比较）
 * - R5 限流：IP 滑动窗口 120 次/分（豁免 _AUTH_EXEMPT 健康检查类端点）
 * - 转发：/chat/completions /embeddings /v1/retrieve → sidecar（INFER_PORT），SSE 透传
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cors from "@fastify/cors";

export interface GatewayConfig {
  port: number;
  authToken: string;
  sidecarBaseUrl: string;
  rateLimitPerMin?: number;
  rateLimitWindowMs?: number;
  authExempt?: string[];
}

const DEFAULT_AUTH_EXEMPT = ["/health"];

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** IP 滑动窗口限流（语义对齐 Python R5：120/min，滑窗去旧条目） */
export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  private windowMs: number;
  private maxHits: number;

  constructor(maxHits: number, windowMs: number) {
    this.maxHits = maxHits;
    this.windowMs = windowMs;
  }

  /** 命中检查；允许则登记并返回 true */
  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxHits) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** 清理过期条目（防僵尸 Map 膨胀） */
  sweep(now = Date.now()): number {
    const cutoff = now - this.windowMs;
    let removed = 0;
    for (const [key, times] of this.hits) {
      const alive = times.filter((t) => t > cutoff);
      if (alive.length === 0) {
        this.hits.delete(key);
        removed++;
      } else {
        this.hits.set(key, alive);
      }
    }
    return removed;
  }
}

export function buildGateway(cfg: GatewayConfig): FastifyInstance {
  const app = Fastify({ logger: false });
  const limiter = new SlidingWindowRateLimiter(
    cfg.rateLimitPerMin ?? 120,
    cfg.rateLimitWindowMs ?? 60_000,
  );
  const exempt = new Set(cfg.authExempt ?? DEFAULT_AUTH_EXEMPT);
  const sidecar = cfg.sidecarBaseUrl.replace(/\/+$/, "");

  void app.register(cors, {
    origin: false, // 本机服务，不开放跨域（CORS 收窄语义对齐 Python R2）
    methods: ["GET", "POST"],
  });

  app.addHook("onRequest", async (req, reply) => {
    const ip = req.ip ?? "unknown";
    if (!limiter.check(`ip:${ip}`)) {
      return reply.code(429).send({ error: { message: "请求过于频繁", type: "rate_limited" } });
    }
    if (exempt.has(req.url.split("?")[0])) {
      return;
    }
    const header = (req.headers.authorization ?? "").trim();
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeEqual(token, cfg.authToken)) {
      return reply.code(401).send({ error: { message: "未认证", type: "unauthorized" } });
    }
  });

  const proxyPaths: Array<{ method: "POST"; path: string }> = [
    { method: "POST", path: "/chat/completions" },
    { method: "POST", path: "/embeddings" },
    { method: "POST", path: "/v1/retrieve" },
  ];

  for (const p of proxyPaths) {
    app.post(p.path, async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const upstream = await fetch(`${sidecar}${p.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body ?? {}),
        });
        const raw = await upstream.text();
        reply.code(upstream.status).header("Content-Type", upstream.headers.get("content-type") ?? "application/json");
        if (p.path === "/chat/completions" && req.body && (req.body as { stream?: boolean }).stream) {
          // SSE 透传：text/event-stream
          reply.header("Content-Type", "text/event-stream; charset=utf-8");
        }
        return reply.send(raw);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(502).send({ error: { message: `sidecar 转发失败: ${msg}`, type: "upstream_error" } });
      }
    });
  }

  app.get("/health", async () => ({ status: "ok", service: "slime-gateway" }));

  app.get("/stats", async () => {
    try {
      const resp = await fetch(`${sidecar}/stats`);
      return { vram: (await resp.json()) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `sidecar 不可达: ${msg}` };
    }
  });

  return app;
}

export async function startGateway(cfg: GatewayConfig): Promise<FastifyInstance> {
  const app = buildGateway(cfg);
  await app.listen({ port: cfg.port, host: "127.0.0.1" });
  return app;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const token = process.env.SLIME_AUTH_TOKEN ?? "";
  const sidecarUrl = process.env.INFER_PORT ? `http://127.0.0.1:${process.env.INFER_PORT}` : "http://127.0.0.1:19100";
  const port = Number(process.env.GATEWAY_PORT ?? "19110");
  if (!token) {
    console.error("[gateway] 缺少 SLIME_AUTH_TOKEN 环境变量");
    process.exit(1);
  }
  startGateway({ port, authToken: token, sidecarBaseUrl: sidecarUrl })
    .then(() => console.log(`[gateway] listening on 127.0.0.1:${port}`))
    .catch((e) => {
      console.error(`[gateway] 启动失败: ${e}`);
      process.exit(1);
    });
}
