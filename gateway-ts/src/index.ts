/**
 * gateway-ts/src/index.ts — Fastify 网关（v2.6 边界定案：HTTP 适配薄壳，无独立调度逻辑）。
 * - 认证：Bearer（auth_token，恒定时间比较，/health 豁免）
 * - 限流：IP 滑动窗口 120/min
 * - CORS 收窄（origin: false）
 * - 端点集（5A.4）：/agents/:id/chat（非流式）、/agents/:id/chat/analyze、/agents/:id/chat/stream
 *   （SSE {seq,type,data} + x-slime-stream-id + x-slime-resume 断线补漏）、/agents/:id/swarm、
 *   /agents/:id/swarm/report、/agents、/stats（面板数据）
 * - 业务逻辑全部在 core-ts Service API（ChatService/SwarmService/StatsService）——函数调用，非 HTTP 回环
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { ChatService, ChatServiceError, ChatRequest } from "../../core-ts/src/services/chat.js";
import { SwarmService, SwarmReportRequest } from "../../core-ts/src/services/swarm.js";
import { StatsService } from "../../core-ts/src/services/stats.js";
import { AgentRegistry } from "../../core-ts/src/services/agents.js";
import { SocialService, SocialConfig, SocialAgentRef, SocialChatFn } from "../../core-ts/src/services/social.js";
import { sseEncode } from "../../core-ts/src/services/events.js";

export interface GatewayConfig {
  port: number;
  authToken: string;
  sidecarBaseUrl: string;
  rateLimitPerMin?: number;
  rateLimitWindowMs?: number;
  authExempt?: string[];
}

export interface GatewayServices {
  chat: ChatService;
  swarm: SwarmService;
  stats: StatsService;
  agents: AgentRegistry;
  social?: SocialService;
}

export interface SocialServiceConfig {
  config: SocialConfig;
  agentRef: SocialAgentRef;
  chatFn: SocialChatFn;
}

const DEFAULT_AUTH_EXEMPT = ["/health", "/social/webhook"];

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

function toErrorBody(e: unknown): { error: { message: string; type: string } } {
  if (e instanceof ChatServiceError) {
    return { error: { message: e.message, type: e.status === 404 ? "not_found" : e.status === 400 ? "bad_request" : "error" } };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { error: { message: msg, type: "error" } };
}

export function buildGateway(
  cfg: GatewayConfig,
  services?: GatewayServices,
): FastifyInstance {
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

  // ── sidecar 推理转发（保留阶段 2 语义）────────────────────
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

  // ── core-ts 服务端点（5A.4；services 未注入时返回 501）──────
  if (services) {
    const { chat, swarm, stats, agents } = services;

    app.get("/agents", async (_req, reply) => {
      try {
        const list = await agents.loadedAgents;
        return list.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          children: a.children ?? [],
          parent_id: a.parent_id,
          lifecycle: a.lifecycle ?? "growth",
        }));
      } catch (e) {
        return replyError(reply, e, 500);
      }
    });

    app.post<{ Params: { agentId: string } }>("/agents/:agentId/chat/analyze", async (req, reply) => {
      try {
        const message = String((req.body as { message?: unknown })?.message ?? "").trim();
        if (!message) {
          return reply.code(400).send({ error: { message: "message 不能为空", type: "bad_request" } });
        }
        return await chat.analyze(req.params.agentId, message);
      } catch (e) {
        return replyError(reply, e, e instanceof ChatServiceError ? e.status : 500);
      }
    });

    app.post<{ Params: { agentId: string } }>("/agents/:agentId/chat", async (req, reply) => {
      try {
        const body = req.body as Partial<ChatRequest>;
        const message = String(body.message ?? "").trim();
        if (!message) {
          return reply.code(400).send({ error: { message: "message 不能为空", type: "bad_request" } });
        }
        return await chat.chat(req.params.agentId, {
          message,
          history: Array.isArray(body.history) ? body.history : [],
          retry: Boolean(body.retry),
          maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
        });
      } catch (e) {
        return replyError(reply, e, e instanceof ChatServiceError ? e.status : 500);
      }
    });

    // SSE 流式：事件 {seq,type,data} + x-slime-stream-id + x-slime-resume（断线补漏）
    app.post<{ Params: { agentId: string } }>("/agents/:agentId/chat/stream", async (req, reply) => {
      try {
        const body = req.body as Partial<ChatRequest> & { stream_id?: string };
        const message = String(body.message ?? "").trim();
        if (!message) {
          return reply.code(400).send({ error: { message: "message 不能为空", type: "bad_request" } });
        }
        const resumeSeq = Number(req.headers["x-slime-resume"] ?? 0) || 0;
        const streamId = typeof body.stream_id === "string" ? body.stream_id : "";
        const request: ChatRequest = {
          message,
          history: Array.isArray(body.history) ? body.history : [],
          retry: Boolean(body.retry),
          maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
        };

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "x-slime-stream-id": streamId,
        });
        for await (const ev of chat.stream(req.params.agentId, request, resumeSeq)) {
          reply.raw.write(sseEncode(ev));
        }
        reply.raw.end();
        return reply.raw;
      } catch (e) {
        return replyError(reply, e, e instanceof ChatServiceError ? e.status : 500);
      }
    });

    app.post<{ Params: { agentId: string } }>("/agents/:agentId/swarm", async (req, reply) => {
      try {
        const body = req.body as { task?: unknown; max_workers?: unknown };
        const task = String(body.task ?? "").trim();
        if (!task) {
          return reply.code(400).send({ error: { message: "task 不能为空", type: "bad_request" } });
        }
        const result = await swarm.dispatch(req.params.agentId, task, {
          maxWorkers: typeof body.max_workers === "number" ? body.max_workers : undefined,
        });
        return {
          ok: true,
          task_id: result.task_id,
          warnings: result.warnings,
          agent_snapshots: result.agent_snapshots,
          merge_result: result.merge_result,
        };
      } catch (e) {
        return replyError(reply, e, e instanceof ChatServiceError ? e.status : 500);
      }
    });

    app.post<{ Params: { agentId: string } }>("/agents/:agentId/swarm/report", async (req, reply) => {
      try {
        const body = req.body as Partial<SwarmReportRequest>;
        return await swarm.report(req.params.agentId, {
          task: String(body.task ?? ""),
          summary: String(body.summary ?? ""),
          results: Array.isArray(body.results) ? body.results : [],
        });
      } catch (e) {
        return replyError(reply, e, e instanceof ChatServiceError ? e.status : 500);
      }
    });

    app.get("/stats", async (_req, reply) => {
      try {
        return await stats.snapshot();
      } catch (e) {
        return replyError(reply, e, 500);
      }
    });

    // ── 社交 webhook（对齐 Python _AUTH_EXEMPT 豁免 + /social/webhook）──────
    // 企业微信 WeCom：官方 HTTP API → TS 原生 (SocialService)
    // 个人微信：wechaty TS 长弃维护 → 回退 sidecar（v2.7 唯一例外），TS 不实现
    if (services.social) {
      app.post("/social/webhook", async (req, reply) => {
        try {
          const result = await services!.social!.handleWebhook(req.body as Record<string, unknown>);
          if (!result.ok) {
            return reply.code(result.status).send({ error: { message: result.error, type: "social_error" } });
          }
          return result;
        } catch (e) {
          return replyError(reply, e, 500);
        }
      });
    } else {
      app.post("/social/webhook", async (_req, reply) => {
        return reply.code(503).send({ error: { message: "社交服务未配置", type: "social_error" } });
      });
    }
    // 个人微信 webhook 路由（仅占位，TS 不实现—由 sidecar adapters/ 处理）
    app.post("/social/wechat/personal/webhook", async (_req, reply) => {
      return reply.code(501).send({ error: { message: "个人微信接入由 sidecar adapters/ 负责（wechaty TS 不可用）", type: "not_implemented" } });
    });
  } else {
    // 无 services（CLI/Electron 未接线）时仍提供面板空态（对齐 Python：无 provider 时 servers=[]）
    app.get("/stats", async (_req, _reply) => {
      return {
        servers: [],
        agents: { total: 0, roots: 0, leaves: 0, byLifecycle: {}, maxDepth: 0 },
        sessions: { totalRecords: 0, recent: 0 },
        alarms: [],
        timestamp: new Date().toISOString(),
      };
    });
  }

  return app;

  function replyError(reply: FastifyReply, e: unknown, status: number) {
    return reply.code(status).send(toErrorBody(e));
  }
}

export async function startGateway(
  cfg: GatewayConfig,
  services?: GatewayServices,
): Promise<FastifyInstance> {
  const app = buildGateway(cfg, services);
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