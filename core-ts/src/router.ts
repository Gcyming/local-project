/**
 * core-ts/src/router.ts — ModelRouter 雏形（路由表 + 降级链声明）。
 * 阶段 3 将实现：健康探测 + OOM 降级链（本地 sidecar ↔ 云端切换）。
 * 本阶段：路由表声明 + 选择逻辑（高优先级优先，phase3 预留降级链出口）。
 */

export type RouteKind = "local" | "cloud";

export interface RouteEntry {
  name: string;
  baseUrl: string;
  apiKey?: string;
  kind: RouteKind;
  /** 数值越大优先级越高 */
  priority: number;
  roles: Array<"chat" | "embedding">;
}

export class ModelRouter {
  private routes: RouteEntry[] = [];

  constructor(routes: RouteEntry[] = []) {
    this.routes = [...routes];
  }

  add(route: RouteEntry): void {
    this.routes.push(route);
  }

  /** 取指定角色的当前首选路由（按 priority 降序，稳定排序） */
  select(role: "chat" | "embedding"): RouteEntry | undefined {
    return [...this.routes]
      .filter((r) => r.roles.includes(role))
      .sort((a, b) => b.priority - a.priority)[0];
  }

  /** 降级链声明：按优先级降序的可用候选（阶段 3 消费：OOM/429 时逐级降级） */
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
  }
}