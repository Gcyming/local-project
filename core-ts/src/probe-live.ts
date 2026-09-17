/**
 * core-ts/src/probe-live.ts — 探针层第 2 层：响应实时探测引擎（纯逻辑，可 mock 单测）。
 *
 * 定位（对齐用户诉求："上游信息先过网关检测再传回，最大程度拓展全平台适配"）：
 * - 每次经 LLM 网关转发成功后，从上游真实响应里提取「实时能力快照」（context 上限、
 *   是否实际支持流式/工具/reasoning、延迟、错误类），缓存该供应商/模型的最新状态。
 * - 上游模型变了/下线了/能力改了，slime 不用重配：下一轮 TTL 过期自动重探，引擎按最新能力调用。
 * - 失败时给出「降级探测决策」（换哪套鉴权、换哪个端点再试），而非直接报红。
 *
 * 纯逻辑、无 IO、无网络——上层（gateway-ts 转发钩子）负责发请求 + 把响应喂给这里，
 * 这里只负责「怎么从响应里读、怎么判断过期、失败怎么换」，便于单测与审计。
 *
 * 与 new-api 的边界：全 slime 自研，不引用 new-api 源码；只解析 OpenAI/Anthropic/Gemini
 * 三类响应的公开字段（usage / error.type / model 等），不涉及其内部实现。
 */

import type { ApiFormat } from "./router.js";

/** 模型级实时能力快照（每次成功转发后从响应刷新；TTL 过期则重探） */
export interface CapabilitySnapshot {
  /** 供应商键（provider） */
  provider: string;
  /** 模型 id */
  model: string;
  /** 上下文上限（若上游响应 usage.prompt_tokens 逼近/超过某阈值，引擎据此截断） */
  contextWindow?: number;
  /** 是否支持流式（本次调用成功用了流式 → true） */
  streaming?: boolean;
  /** 是否支持工具调用（响应里出现过 tool_calls） */
  toolCalls?: boolean;
  /** 是否支持 reasoning（响应里出现过 reasoning_content / thinking） */
  reasoning?: boolean;
  /** 实测单请求延迟（ms） */
  latencyMs?: number;
  /** 最近一次上游错误类型（成功则清空）——用于引擎提前规避已知失效模型 */
  lastErrorType?: string;
  /**
   * 该 provider:model 是否被判为「模型级失效」（404 模型不存在 / "Model is unavailable" / 区域限制）。
   * true 时引擎（ModelRouter 前置剔除）应直接跳过该模型，不必再试一次。
   * 与 lastErrorType 区别：401/403/429 属「供应商/账号级」问题（换模型也没用，同供应商其它模型可能仍可用），
   * 此时 modelDead 保持 false——只有明确「这个模型没了/下线了」才置 true。
   */
  modelDead?: boolean;
  /** 快照时间戳（Date.now()） */
  ts: number;
}

/** 实时探测器的可注入 now（测试隔离，绝不依赖真实时间） */
type NowFn = () => number;

/** 实时探测缓存：provider:model → 快照 + TTL */
export class LiveProbeCache {
  private cache = new Map<string, CapabilitySnapshot>();
  private readonly ttlMs: number;
  private readonly now: NowFn;

  constructor(opts?: { ttlMs?: number; now?: NowFn }) {
    this.ttlMs = opts?.ttlMs ?? 5 * 60_000; // 默认 5 分钟过期重探
    this.now = opts?.now ?? Date.now;
  }

  private key(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  /** 写入/刷新快照 */
  put(snap: CapabilitySnapshot): void {
    this.cache.set(this.key(snap.provider, snap.model), snap);
  }

  /** 取未过期快照；过期或不存在 → null（提示上层重探） */
  get(provider: string, model: string): CapabilitySnapshot | null {
    const s = this.cache.get(this.key(provider, model));
    if (!s) { return null; }
    if (this.now() - s.ts >= this.ttlMs) { return null; }
    return s;
  }

  /** 该模型快照是否已过期（不存在也算过期 → 该重探） */
  isStale(provider: string, model: string): boolean {
    return this.get(provider, model) === null;
  }

  /** 该 provider:model 是否被实时探测判定为「模型级失效」（未过期 + modelDead=true）。
   *  引擎（ModelRouter 前置剔除）据此跳过已知 404/下线的模型，省一次浪费请求。
   *  供应商级失效（401/403/429，modelDead=false）不在此列——同供应商其它模型可能仍可用。 */
  isDead(provider: string, model: string): boolean {
    return this.get(provider, model)?.modelDead === true;
  }

  /** 全部快照（引擎做模型选择/降级时查表用） */
  all(): CapabilitySnapshot[] {
    return [...this.cache.values()];
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  /** 全部快照（供持久化落盘用；保留 ts，加载后可判断是否已过期） */
  toJSON(): CapabilitySnapshot[] {
    return [...this.cache.values()];
  }

  /** 从持久化快照恢复（启动时调用；只保留未过期的条目，过期直接丢弃 → 下轮重探） */
  hydrate(snapshots: CapabilitySnapshot[]): void {
    const now = this.now();
    for (const s of snapshots) {
      if (!s || typeof s.provider !== "string" || typeof s.model !== "string" || typeof s.ts !== "number") {
        continue;
      }
      if (now - s.ts >= this.ttlMs) { continue; } // 已过期的不恢复，避免把失效模型当可用
      this.cache.set(this.key(s.provider, s.model), s);
    }
  }
}

/** 上游响应里可提取的能力信号（上层喂进来的"原始观测"） */
export interface UpstreamResponseSignal {
  ok: boolean;
  /** OpenAI 风格 usage（或归一化后的 token 数） */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** 响应里是否出现过 tool_calls */
  hasToolCalls?: boolean;
  /** 是否出现过 reasoning_content / thinking */
  hasReasoning?: boolean;
  /** 该请求是否走了流式 */
  streamed?: boolean;
  /** 实测延迟 ms */
  latencyMs?: number;
  /** 错误（成功时 undefined）：UpstreamError 的 type/status */
  errorType?: string;
  errorStatus?: number;
  /** 上游回显的 model（可能与服务端路由名不同） */
  model?: string;
}

/**
 * 判定一次上游失败是否属于「模型级失效」——该模型本身没了（404 不存在 / 下线 / 区域限制），
 * 此时应切换同供应商另一模型（可降级）；而 401/403/429 属「供应商/账号级」问题，换模型无用。
 * 纯函数，便于单测。与 nextAuthOnFailure 的 abandon 语义同源但更细粒度（专供 modelDead 标志）。
 */
export function isModelDeadError(errorType: string | undefined, errorStatus?: number): boolean {
  const err = (errorType ?? "").toLowerCase();
  // 404 / 明确的"模型不存在/不可用" → 模型级失效
  if (errorStatus === 404 || /not.*found|no.*model|model.*(unavailable|not.*found)|model_dead/.test(err)) {
    return true;
  }
  // 上游在错误正文里明确标注模型不可用（RegionError / "Model is unavailable"）
  if (/regionerror|not available in your (country|region)|model (is |not )?unavailable/i.test(err)) {
    return true;
  }
  return false;
}

/**
 * 从一次上游响应里提取实时能力快照。
 * 成功：刷新能力位 + 清 lastError；失败：记录错误类型（引擎据此规避）。
 */
export function extractSnapshot(provider: string, model: string, sig: UpstreamResponseSignal, now?: NowFn): CapabilitySnapshot {
  const ts = (now ?? Date.now)();
  if (sig.ok) {
    const ctx = sig.usage?.prompt_tokens;
    return {
      provider,
      model: sig.model ?? model,
      contextWindow: ctx && ctx > 0 ? ctx * 2 : undefined, // 粗略估算（prompt 占用的近似上限）
      streaming: sig.streamed === true,
      toolCalls: sig.hasToolCalls === true,
      reasoning: sig.hasReasoning === true,
      latencyMs: sig.latencyMs,
      ts,
    };
  }
  // 失败：保留最后一次成功能力位（从缓存补，这里只记录错误 + 模型级失效标志）
  const modelDead = isModelDeadError(sig.errorType, sig.errorStatus);
  return {
    provider,
    model,
    lastErrorType: sig.errorType ?? (sig.errorStatus ? `HTTP ${sig.errorStatus}` : "unknown"),
    modelDead, // 模型级失效才 true（供应商级 401/403/429 不置）
    ts,
  };
}

/**
 * 失败降级决策：根据上游错误类型，决定「下一轮该换什么再试」。
 * 返回 null = 该模型已彻底失效（引擎应切到同 provider 的另一模型）。
 */
export interface RetryDecision {
  /** 换这套鉴权头再试（undefined = 不变） */
  authSwap?: "bearer" | "x-api-key" | "x-goog-api-key";
  /** 换这个端点再试（undefined = 不变） */
  endpointSwap?: string;
  /** 是否应直接放弃该模型（引擎切下一个） */
  abandon?: boolean;
  /** 人类可读原因 */
  reason: string;
}

export function nextAuthOnFailure(format: ApiFormat, errorType: string | undefined, errorStatus?: number): RetryDecision {
  const err = (errorType ?? "").toLowerCase();
  // 401/403：鉴权问题 → 换鉴权方式（OpenAI 系常需 Bearer，某些网关要 x-api-key）
  if (errorStatus === 401 || errorStatus === 403 || /unauthor|forbidden|invalid.*key/.test(err)) {
    const swap: RetryDecision["authSwap"] = format === "openai" || format === "responses" ? "x-api-key" : "bearer";
    return { authSwap: swap, reason: `鉴权失败（${errorStatus ?? err}），换 ${swap} 重试` };
  }
  // 404 模型不存在：可能该网关不暴露这个模型 → 放弃，切下一个
  if (errorStatus === 404 || /not.*found|no.*model|model.*unavailable/.test(err)) {
    return { abandon: true, reason: "模型不存在/不可用，切换下一候选" };
  }
  // 429 配额：不降级模型（同模型重试或换 provider），标记由引擎的限流逻辑处理
  if (errorStatus === 429 || /quota|rate|too.*many/.test(err)) {
    return { reason: "配额/限流，等待或换 provider（不换模型）" };
  }
  // 5xx / 区域限制 / 网络：可降级换模型（引擎 isFallbackError 已覆盖）
  if ((errorStatus && errorStatus >= 500) || /region|unavailable|timeout|ECONN/.test(err)) {
    return { abandon: true, reason: `上游错误（${errorStatus ?? err}），降级到同供应商另一模型` };
  }
  return { reason: `未知错误（${errorStatus ?? err}），保持现状重试一次` };
}

/** 端点候选降级（聚合网关常见：/v1/models 404 但 /api/v1/models 或 /models 通） */
export function nextEndpointOnFailure(current: string, errorStatus?: number, errorType?: string): string | undefined {
  const u = current.toLowerCase();
  // 更具体的 /api/v1/models 必须先判断（它同样以 /v1/models 结尾，顺序反了会被上一分支吞掉）
  if (u.endsWith("/api/v1/models")) {
    return errorStatus === 404 ? current.replace("/api/v1/models", "/models") : undefined;
  }
  // /v1/models 失败 → 试 /api/v1/models
  if (u.endsWith("/v1/models")) {
    return errorStatus === 404 || /not.*found/.test(errorType ?? "") ? current.replace("/v1/models", "/api/v1/models") : undefined;
  }
  if (u.endsWith("/models") && !u.includes("/v1/")) {
    return undefined; // 最后一级，不再换
  }
  return undefined;
}

// ── 进程级共享单例（LLM 网关与 slime 引擎用同一份实时能力缓存）────────────
// 网关转发后刷快照（第 2 层），引擎发起调用前读快照做规避/降级——两者必须看到同一份数据，
// 否则"网关检测到的失效模型"引擎不会知道。模块级引用（无 IO，保持本文件纯逻辑）。
let sharedLiveProbe: LiveProbeCache | null = null;

/** 获取（必要时创建）进程级共享实时探测缓存。缺省 TTL 5min。 */
export function getSharedLiveProbe(opts?: { ttlMs?: number; now?: NowFn }): LiveProbeCache {
  if (!sharedLiveProbe) {
    sharedLiveProbe = new LiveProbeCache(opts);
  }
  return sharedLiveProbe;
}

/** 注入共享实例（上层自定义 TTL / 测试隔离用；传 null 复位） */
export function setSharedLiveProbe(cache: LiveProbeCache | null): void {
  sharedLiveProbe = cache;
}

