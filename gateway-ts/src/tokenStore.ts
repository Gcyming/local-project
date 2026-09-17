/**
 * gateway-ts/src/tokenStore.ts — LLM 网关令牌管理（B 档：A + 令牌/限流管理）。
 *
 * 定位：slime 专属的轻量令牌层。每个令牌可独立配置：
 * - 每分钟速率（ratePerMin）
 * - 每日请求配额（dailyQuota，UTC 自然日滚动）
 * - 模型白名单（models，空 = 全部可用）
 *
 * 与 new-api 的差异（合规）：
 * - 不实现余额/计费/扣费（slime 定位是本地自托管的个人网关）
 * - 不实现用户分组（个人向，令牌已足够）
 * - 令牌表由 GUI 写 config/llm_gateway.json，主进程启动网关时注入，
 *   改令牌需重启网关生效（v1 定案，热更新放后续）
 * - 纯逻辑、无 IO、可单测；限流用进程内滑动窗口，与全局 IP 限流正交
 *
 * 限流语义：tryConsume（原子"检查+登记"，拒绝时不登记避免 429 刷量）+ peek（只读剩余）。
 */

import { randomBytes } from "node:crypto";

/** 单个令牌定义（持久化到 llm_gateway.json） */
export interface TokenDef {
  /** 令牌明文（客户端 Authorization: Bearer <key> 携带；建议 ≥24 字符随机） */
  key: string;
  /** 人类可读标签（如 "Cherry Studio"、"调试"） */
  label?: string;
  /** 是否启用（默认 true；false 则 resolveToken 拒绝） */
  active?: boolean;
  /** 每分钟请求数上限（缺省 0 = 不限） */
  ratePerMin?: number;
  /** 每日请求数上限（UTC 自然日滚动；缺省 0 = 不限） */
  dailyQuota?: number;
  /** 模型白名单（精确模型 id，不含 provider: 前缀；缺省/空 = 全部） */
  models?: string[];
  /** 备注（可选） */
  note?: string;
}

/** 限流尝试消费结果 */
export interface ConsumeResult {
  /** 是否放行 */
  ok: boolean;
  /** 拒绝原因（仅 ok=false 时有值） */
  reason?: "rate" | "quota";
  /** 本次放行后剩余的分钟速率额度（不限时为 undefined） */
  remainingRate?: number;
  /** 本次放行后剩余的每日配额（不限时为 undefined） */
  remainingQuota?: number;
}

/** 滑动窗口限流器（用于分钟速率；窗口固定 60s） */
class RollingWindowLimiter {
  private hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now, windowMs = 60_000) {
    this.now = now;
    this.windowMs = windowMs;
  }

  /** 尝试消费一次（maxHits <= 0 = 不限）。返回 { ok, remaining }；拒绝时不登记 */
  tryConsume(key: string, maxHits: number): { ok: boolean; remaining: number } {
    if (maxHits <= 0) { return { ok: true, remaining: -1 }; } // -1 表示不限
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= maxHits) { return { ok: false, remaining: 0 }; }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, remaining: maxHits - recent.length };
  }

  /** 只读剩余次数（maxHits <= 0 返回 -1 = 不限） */
  peek(key: string, maxHits: number): number {
    if (maxHits <= 0) { return -1; }
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    return Math.max(0, maxHits - recent.length);
  }

  sweep(now?: number): number {
    const t = now ?? this.now();
    const cutoff = t - this.windowMs;
    let removed = 0;
    for (const [key, times] of this.hits) {
      const alive = times.filter((x) => x > cutoff);
      if (alive.length === 0) { this.hits.delete(key); removed++; }
      else { this.hits.set(key, alive); }
    }
    return removed;
  }
}

/** 每日配额计数器：按 UTC 日期分桶（跨天自动清零） */
class DailyQuotaCounter {
  private hits = new Map<string, { date: string; count: number }>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  private dateKey(d: Date): string {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  /** 尝试消费一次（maxQuota <= 0 = 不限）。返回 { ok, remaining }；拒绝时不登记 */
  tryConsume(key: string, maxQuota: number): { ok: boolean; remaining: number } {
    if (maxQuota <= 0) { return { ok: true, remaining: -1 }; }
    const today = this.dateKey(this.now());
    const cur = this.hits.get(key);
    const count = cur && cur.date === today ? cur.count : 0;
    if (count >= maxQuota) { return { ok: false, remaining: 0 }; }
    this.hits.set(key, { date: today, count: count + 1 });
    return { ok: true, remaining: maxQuota - (count + 1) };
  }

  peek(key: string, maxQuota: number): number {
    if (maxQuota <= 0) { return -1; }
    const today = this.dateKey(this.now());
    const cur = this.hits.get(key);
    return Math.max(0, maxQuota - (cur && cur.date === today ? cur.count : 0));
  }

  sweep(now?: Date): number {
    const today = this.dateKey(now ?? this.now());
    let removed = 0;
    for (const [k, v] of this.hits) {
      if (v.date !== today) { this.hits.delete(k); removed++; }
    }
    return removed;
  }
}

/** 令牌存储主体：解析 + 白名单校验 + 限流。纯逻辑，无 IO。 */
export class TokenStore {
  private byKey = new Map<string, TokenDef>();
  private readonly rateLimiter: RollingWindowLimiter;
  private readonly dailyCounter: DailyQuotaCounter;

  constructor(defs: TokenDef[] = [], opts?: { now?: () => number; dateNow?: () => Date }) {
    this.rateLimiter = new RollingWindowLimiter(opts?.now);
    this.dailyCounter = new DailyQuotaCounter(opts?.dateNow);
    for (const d of defs) { this.ingest(d); }
  }

  /** 注入一个令牌（构造或热更新时调用） */
  ingest(def: TokenDef): void {
    if (!def || typeof def.key !== "string" || def.key.length < 8) {
      throw new Error("令牌 key 至少 8 字符");
    }
    this.byKey.set(def.key, def);
  }

  remove(key: string): boolean {
    return this.byKey.delete(key);
  }

  list(): TokenDef[] {
    return [...this.byKey.values()];
  }

  /** 解析客户端 Bearer token → 令牌定义（未命中 / 已停用 → null） */
  resolve(token: string | undefined | null): TokenDef | null {
    if (!token) { return null; }
    const def = this.byKey.get(token);
    if (!def) { return null; }
    if (def.active === false) { return null; }
    return def;
  }

  /** 模型白名单校验：requestedModel 是否在令牌允许范围内（空白名单 = 全放行） */
  checkModel(def: TokenDef, requestedModel: string | undefined | null): boolean {
    const allowed = def.models;
    if (!allowed || allowed.length === 0) { return true; }
    const m = (requestedModel ?? "").trim();
    if (!m) { return true; } // 未指定模型（如 /v1/models 列表）不校验
    const bare = m.includes(":") ? m.split(":").slice(1).join(":") : m;
    return allowed.includes(m) || allowed.includes(bare);
  }

  /** 限流检查：分钟速率 + 日配额。先速率后配额，任一拒绝即拒绝。 */
  checkRate(def: TokenDef): ConsumeResult {
    const key = `token:${def.key}`;
    const rateMax = def.ratePerMin ?? 0;
    const rate = this.rateLimiter.tryConsume(key, rateMax);
    if (!rate.ok) {
      return { ok: false, reason: "rate" };
    }
    const quotaMax = def.dailyQuota ?? 0;
    const quota = this.dailyCounter.tryConsume(key, quotaMax);
    if (!quota.ok) {
      // 速率已通过并登记，但配额耗尽 → 整体拒绝（速率那次登记可接受，属保守行为）
      return { ok: false, reason: "quota", remainingQuota: 0 };
    }
    return {
      ok: true,
      remainingRate: rateMax > 0 ? rate.remaining : undefined,
      remainingQuota: quotaMax > 0 ? quota.remaining : undefined,
    };
  }

  /** 周期性清理（网关启动定时器调用；防 Map 膨胀） */
  sweep(now?: number): number {
    const removedRate = this.rateLimiter.sweep(now);
    const removedDaily = this.dailyCounter.sweep(now === undefined ? undefined : new Date(now));
    return removedRate + removedDaily;
  }

  /** 生成一个新令牌（强随机，防枚举） */
  static generateKey(prefix = "slime"): string {
    const body = randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 24);
    return `${prefix}_${body}`;
  }
}
