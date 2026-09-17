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
import { LlmGateway, LlmGatewayError } from "./llmGateway.js";
import { TokenStore, TokenDef } from "./tokenStore.js";
import { getSharedLiveProbe } from "../../core-ts/src/probe-live.js";
import { getSharedCapabilityGraph } from "../../core-ts/src/probe-graph.js";
import type { ChatRequest as LlmChatRequest } from "shared/schemas";

export interface GatewayConfig {
  port: number;
  authToken: string;
  sidecarBaseUrl: string;
  rateLimitPerMin?: number;
  rateLimitWindowMs?: number;
  authExempt?: string[];
  /** LLM 转发网关（OpenAI 兼容入口 + 多上游转发）；未配置则关闭该能力 */
  llmGateway?: {
    /** 是否启用 LLM 转发（默认 false，保持 v2.6 边界） */
    enabled?: boolean;
    /** slime 项目根（providers.enc.json 所在目录）；缺省 process.cwd() */
    projectRoot?: string;
    /** 客户端访问网关所需的独立 API Key（配置后客户端须带 Authorization: Bearer <此值>）；
     *  未配置则沿用全局 authToken（与 slime 主认证一致）。 */
    apiKey?: string;
    /** 令牌列表（B 档：每令牌独立速率/配额/模型白名单）。
     *  配置后认证逻辑：令牌任一命中 → 放行；否则回退 apiKey（或全局 authToken）。
     *  客户端 Authorization: Bearer <令牌 key> 或 <apiKey>。 */
    tokens?: TokenDef[];
    /** 每 provider 最多注入候选模型数（缺省 8） */
    maxModelsPerProvider?: number;
    /** 测试缝：直接注入解密后的 providers 表（跳过 providers.enc.json 解密）；生产不传 */
    providers?: Record<string, import("../../core-ts/src/services/engine.js").ProviderConfig>;
  };
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

  // ── LLM 转发网关（OpenAI 兼容入口 + 多上游转发 + 4 类格式互转 + 令牌限流）──
  // 端点豁免全局 authToken（走独立认证）。认证逻辑（B 档）：
  //   1. 令牌命中（tokens 列表中任一 key）→ 放行，按该令牌做速率/配额/模型白名单
  //   2. 否则回退 apiKey（若配置）→ 放行，无令牌级限制
  //   3. 否则回退全局 authToken → 放行，无令牌级限制
  if (cfg.llmGateway?.enabled) {
    const llmApiKey = cfg.llmGateway.apiKey ?? cfg.authToken;
    const tokenStore = new TokenStore(cfg.llmGateway.tokens ?? []);
    // 豁免全局 auth（端点内部走令牌 + apiKey 独立校验）
    exempt.add("/v1/chat/completions");
    exempt.add("/v1/models");
    exempt.add("/v1/capabilities");

    // 网关实例延迟构建（首次请求时解密 providers.enc.json，避免空启动阻塞）
    let llmGateway: LlmGateway | null = null;
    // 探针层第 2 层：用「进程级共享」实时探测缓存（网关写、引擎读同一份，避免数据割裂）。
    // 持久化（落盘/恢复/定时 flush）由 GUI 侧 LlmGatewayManager 经 probe-persist 负责。
    const liveProbe = getSharedLiveProbe({ ttlMs: 5 * 60_000 });
    const getGateway = (): LlmGateway => {
      if (!llmGateway) {
        llmGateway = new LlmGateway({
          projectRoot: cfg.llmGateway!.projectRoot,
          maxModelsPerProvider: cfg.llmGateway!.maxModelsPerProvider,
          liveProbe,
          providers: cfg.llmGateway!.providers, // 测试缝：注入则跳过解密
        });
      }
      return llmGateway;
    };

    /** LLM 网关认证：先令牌，再 apiKey，再全局 authToken。
     *  返回 (true, token) 或 (false, null)；token 非空表示走令牌级限制。 */
    const authLlm = (
      req: FastifyRequest,
      reply: FastifyReply,
    ): [boolean, TokenDef | null] => {
      const header = (req.headers.authorization ?? "").trim();
      const token = header.startsWith("Bearer ") ? header.slice(7) : header;
      if (!token) {
        reply.code(401).send({ error: { message: "未认证（LLM 网关需要 API Key 或令牌）", type: "unauthorized" } });
        return [false, null];
      }
      // 1. 令牌命中？（命中即启用令牌级速率/配额/白名单）
      const def = tokenStore.resolve(token);
      if (def) { return [true, def]; }
      // 2. 回退 apiKey
      if (safeEqual(token, llmApiKey)) { return [true, null]; }
      // 3. 回退全局 authToken（llmApiKey 缺省即等于 authToken，此处兜底）
      if (safeEqual(token, cfg.authToken)) { return [true, null]; }
      reply.code(401).send({ error: { message: "未认证（LLM 网关需要 API Key 或令牌）", type: "unauthorized" } });
      return [false, null];
    };

    /** 令牌级限制检查（白名单 + 速率 + 配额）。通过返回 true；被限返回 false（已写好 429/403 响应）。 */
    const enforceTokenLimits = (
      def: TokenDef | null,
      requestedModel: string,
      req: FastifyRequest,
      reply: FastifyReply,
    ): boolean => {
      if (!def) { return true; } // 走 apiKey/全局 token，不做令牌级限制
      if (!tokenStore.checkModel(def, requestedModel)) {
        reply.code(403).send({
          error: {
            message: `模型「${requestedModel}」不在令牌「${def.label ?? def.key.slice(0, 8) + "…"}」的白名单内`,
            type: "model_not_allowed",
          },
        });
        return false;
      }
      const c = tokenStore.checkRate(def);
      if (!c.ok) {
        reply.code(429).send({
          error: {
            message: c.reason === "rate" ? "请求过于频繁（每分钟速率上限）" : "今日配额已用尽",
            type: c.reason === "rate" ? "rate_limited" : "quota_exhausted",
          },
        });
        return false;
      }
      // 剩余次数回写响应头（客户端可感知配额状态）
      if (c.remainingRate !== undefined) {
        reply.header("X-RateLimit-Limit-Minute", String(def.ratePerMin));
        reply.header("X-RateLimit-Remaining-Minute", String(c.remainingRate));
      }
      if (c.remainingQuota !== undefined) {
        reply.header("X-RateLimit-Limit-Daily", String(def.dailyQuota));
        reply.header("X-Quota-Remaining-Daily", String(c.remainingQuota));
      }
      void req; // （req 预留，暂不使用）
      return true;
    };

    // GET /v1/models：列出可用模型（OpenAI 兼容）
    app.get("/v1/models", async (req, reply) => {
      const [ok, def] = authLlm(req, reply);
      if (!ok) { return; }
      try {
        // 令牌级：只列白名单内的模型（空白名单 = 全量）
        let models;
        if (def) {
          const g = getGateway();
          const all = g.listModels();
          models = def.models && def.models.length > 0
            ? all.filter((m) => def.models!.includes(m.id) || def.models!.includes(`${(m.owned_by ?? "")}:${m.id}`))
            : all;
        } else {
          models = getGateway().listModels();
        }
        return { object: "list", data: models };
      } catch (e) {
        return reply.code(500).send({ error: { message: e instanceof Error ? e.message : String(e), type: "gateway_error" } });
      }
    });

    // GET /v1/capabilities[?provider=<key>]：探针层第 3 层能力知识图谱（诊断/面板用）
    // 返回该 provider 每个模型的三层融合节点（静态能力表 + 实时快照 + 健康态）+ 推荐排序。
    // 不带 provider 则聚合全部路由；只读，不影响转发。
    app.get("/v1/capabilities", async (req, reply) => {
      const [ok] = authLlm(req, reply);
      if (!ok) { return; }
      try {
        const g = getGateway();
        const graph = getSharedCapabilityGraph();
        // 支持 "provider:model" 语法（与 /v1/models 一致）；纯键 = 该 provider 全量
        const rawProvider = (req.query as { provider?: string }).provider?.trim();
        const provider = rawProvider?.includes(":") ? rawProvider.split(":")[0] : rawProvider;
        const modelFilter = rawProvider?.includes(":") ? rawProvider.split(":")[1] : undefined;

        // 按 owned_by 分组（与 /v1/models 同源）；指定 provider/model 时只留命中组
        const byProvider = new Map<string, string[]>();
        for (const m of g.listModels()) {
          if (provider && m.owned_by !== provider) { continue; }
          if (modelFilter && m.id !== modelFilter) { continue; }
          const key = provider ?? m.owned_by;
          const arr = byProvider.get(key) ?? [];
          arr.push(m.id);
          byProvider.set(key, arr);
        }
        const nodes: Array<ReturnType<typeof graph.resolve>> = [];
        const ranked: Record<string, string[]> = {};
        for (const [p, ps] of byProvider) {
          ranked[p] = graph.rank(p, ps); // 推荐顺序：ok（按实测延迟）→ unknown → degraded → dead
          for (const m of ps) { nodes.push(graph.resolve(p, m)); }
        }
        return {
          object: "capability_graph",
          provider: provider ?? null,
          nodes,
          ranked,
          // 人类可读摘要（前 20 条，日志/面板直接展示）
          explain: nodes.slice(0, 20).map((n) => graph.explain(n)),
        };
      } catch (e) {
        return reply.code(500).send({ error: { message: e instanceof Error ? e.message : String(e), type: "gateway_error" } });
      }
    });

    // POST /v1/chat/completions：非流式 + 流式（SSE）转发
    app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
      const [ok, def] = authLlm(req, reply);
      if (!ok) { return; }
      try {
        const g = getGateway();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const model = String(body.model ?? "").trim();
        const stream = Boolean(body.stream);
        const payload = body as unknown as LlmChatRequest;

        // 令牌级白名单 + 速率 + 配额
        if (!enforceTokenLimits(def, model, req, reply)) { return; }

        if (stream) {
          // 流式：SSE 逐帧输出 OpenAI chunk 格式
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const encoder = new TextEncoder();
          const write = (obj: unknown): void => {
            reply.raw.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };
          await g.chatStream(
            payload,
            model,
            {
              onChunk: (chunk) => write(chunk),
              onDone: (usage) => {
                if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
                  write({
                    id: `chatcmpl-${Date.now().toString(36)}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [],
                    usage: {
                      prompt_tokens: usage.prompt_tokens ?? 0,
                      completion_tokens: usage.completion_tokens ?? 0,
                      total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
                    },
                  });
                }
              },
            },
            undefined,
          );
          reply.raw.write(encoder.encode("data: [DONE]\n\n"));
          reply.raw.end();
          return reply.raw;
        }

        // 非流式
        const response = await g.chat(payload, model);
        return response;
      } catch (e) {
        if (e instanceof LlmGatewayError) {
          return reply.code(e.status).send({ error: { message: e.message, type: e.status === 404 ? "model_not_found" : "gateway_error" } });
        }
        return reply.code(502).send({ error: { message: e instanceof Error ? e.message : String(e), type: "upstream_error" } });
      }
    });

    // 令牌限流清理定时器（每分钟 sweep 一次滑动窗口 + 日配额桶，防 Map 膨胀）
    const sweepTimer = setInterval(() => { void tokenStore.sweep(); }, 60_000);
    sweepTimer.unref?.(); // 不让定时器阻塞进程退出
    app.addHook("onClose", () => { clearInterval(sweepTimer); });
  }

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