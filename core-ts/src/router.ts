/**
 * core-ts/src/router.ts — ModelRouter：统一路由 + OOM 降级链（阶段 3）。
 * 语义对齐：
 * - 原项目 model_choice 三选一（inherit / api:<key> / local:path）的"统一路由"抽象：
 *   本地（sidecar/llama-server）与云端（OpenAI 兼容）同表，按 priority 选路。
 * - 降级链（规划 §9 阶段 3）：请求首选失败且失败类型可降级 →
 *   按 priority 降序尝试下一候选；全部失败 → 聚合错误（如实报告，不虚报成功）。
 * - 诚实协议约束：流式一旦收到首个 chunk（onDelta 被调用）→ 不再降级，
 *   抛错给上层（避免静默切源造成内容重复/丢失）。
 */

import { ChatClient, ChatStreamResult, UpstreamError } from "./llm/client.js";
import { ChatRequest, ChatResponse } from "shared/schemas";

export type RouteKind = "local" | "cloud";

export interface RouteEntry {
  name: string;
  baseUrl: string;
  apiKey?: string;
  kind: RouteKind;
  /** 数值越大优先级越高 */
  priority: number;
  roles: Array<"chat" | "embedding">;
  /** 请求体 model 名（云端必填；本地缺省时由上游决定） */
  model?: string;
  /** 路由级超时覆盖（默认走 ChatClient 120s） */
  timeoutMs?: number;
}

export interface FallbackRecord {
  from: string;
  to: string;
  reason: string;
  ts: number;
}

export interface ChatResult {
  response: ChatResponse;
  routeName: string;
}

export interface ChatStreamResultRouted extends ChatStreamResult {
  routeName: string;
}

export type ClientFactory = (route: RouteEntry) => ChatClient;

/** 可降级失败：OOM（503/local_model_error）、网络不可达/超时、429 配额。
 *  4xx（除 429）为请求语义错误 → 不降级（换后端不会成功）。 */
function isFallbackError(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) {
    return true; // 未知错误（网络层）→ 降级
  }
  if (e.status >= 400 && e.status < 500 && e.status !== 429) {
    return false;
  }
  return true;
}

export class ModelRouter {
  private routes: RouteEntry[] = [];
  private createClient: ClientFactory;
  private fallbacks: FallbackRecord[] = [];

  constructor(routes: RouteEntry[] = [], createClient?: ClientFactory) {
    this.routes = [...routes];
    this.createClient =
      createClient ??
      ((route) => new ChatClient({ baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs }));
  }

  add(route: RouteEntry): void {
    this.routes.push(route);
  }

  /** 取指定角色的当前首选路由（按 priority 降序，稳定排序） */
  select(role: "chat" | "embedding"): RouteEntry | undefined {
    return this.fallbackChain(role)[0];
  }

  /** 降级链：按优先级降序的可用候选 */
  fallbackChain(role: "chat" | "embedding"): RouteEntry[] {
    return [...this.routes]
      .filter((r) => r.roles.includes(role))
      .sort((a, b) => b.priority - a.priority);
  }

  list(): RouteEntry[] {
    return [...this.routes];
  }

  reset(): void {
    this.routes = [];
    this.fallbacks = [];
  }

  /** 降级记录（观察用；/stats 或日志消费） */
  fallbackLog(): FallbackRecord[] {
    return [...this.fallbacks];
  }

  get fallbackCount(): number {
    return this.fallbacks.length;
  }

  /** 注入路由 model（请求未显式指定时） */
  private withModel(payload: ChatRequest, route: RouteEntry): ChatRequest {
    if (payload.model || !route.model) {
      return payload;
    }
    return { ...payload, model: route.model };
  }

  private recordFallback(from: string, to: string | null, reason: string): void {
    this.fallbacks.push({ from, to: to ?? "", reason, ts: Date.now() });
  }

  /**
   * 非流式 chat：逐级降级尝试。
   * 4xx（除 429）不降级；全部失败抛聚合错误。
   */
  async chat(payload: ChatRequest): Promise<ChatResult> {
    const chain = this.fallbackChain("chat");
    if (chain.length === 0) {
      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);
    }
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const route = chain[i];
      try {
        const response = await this.createClient(route).chat(this.withModel(payload, route));
        return { response, routeName: route.name };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        errors.push(`${route.name}: ${reason}`);
        if (!isFallbackError(e) || i === chain.length - 1) {
          break; // 请求语义错误或已到链尾：不降级也不记 fallback
        }
        this.recordFallback(route.name, chain[i + 1].name, reason);
      }
    }
    throw new Error(`chat 全部路由失败: ${errors.join(" | ")}`);
  }

  /**
   * 流式 chat：仅"请求建立前"失败可降级；首个 chunk 之后抛错不降级。
   */
  async chatStream(payload: ChatRequest, onDelta: (delta: string) => void): Promise<ChatStreamResultRouted> {
    const chain = this.fallbackChain("chat");
    if (chain.length === 0) {
      throw new Error(`无可用 chat 路由（roles=chat 的路由表为空）`);
    }
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      const route = chain[i];
      let started = false;
      try {
        const result = await this.createClient(route).chatStream(this.withModel(payload, route), (d) => {
          started = true;
          onDelta(d);
        });
        return { ...result, routeName: route.name };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        errors.push(`${route.name}: ${reason}`);
        if (started) {
          // 诚实协议：已开流则如实失败，不静默切源
          throw new Error(`流式中断（${route.name}，已收到部分内容，不降级）: ${reason}`);
        }
        if (!isFallbackError(e) || i === chain.length - 1) {
          break;
        }
        this.recordFallback(route.name, chain[i + 1].name, reason);
      }
    }
    throw new Error(`chatStream 全部路由失败: ${errors.join(" | ")}`);
  }
}