/**
 * core-ts/src/services/stats.ts — StatsService（面板数据：模型服务器 + Agent 统计）。
 * - modelServers：ModelServerManager.status() 快照（端口/状态/VRAM）
 * - agents：Agent 树/数量/生命周期分布/会话历史统计
 */

import { AgentRegistry } from "./agents.js";
import { getModelServer } from "../model_server.js";
import { loadHistory } from "./history.js";

export interface ServerStatusItem {
  role: string;
  port: number;
  state: string;
  model: string;
  vram: number;
  [key: string]: unknown;
}

// ── 异常告警（v2.8 可观测性：sidecar 崩溃/OOM/检索超时 → 日志 + stats 状态 + 可选通知钩子）─

export type AlarmSeverity = "info" | "warning" | "critical";

export interface AlarmRecord {
  seq: number;
  severity: AlarmSeverity;
  source: string;
  message: string;
  timestamp: string;
}

export interface AlarmBusOptions {
  /** 可选通知钩子（如推送到桌面通知/日志聚合） */
  notify?: (alarm: AlarmRecord) => void;
  maxRecords?: number;
}

export class AlarmBus {
  private records: AlarmRecord[] = [];
  private seq = 1;
  private notify?: (alarm: AlarmRecord) => void;
  private maxRecords: number;

  constructor(opts: AlarmBusOptions = {}) {
    this.notify = opts.notify;
    this.maxRecords = opts.maxRecords ?? 50;
  }

  record(source: string, message: string, severity: AlarmSeverity = "warning"): AlarmRecord {
    const alarm: AlarmRecord = {
      seq: this.seq++,
      severity,
      source,
      message,
      timestamp: new Date().toISOString(),
    };
    this.records.push(alarm);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
    try {
      this.notify?.(alarm);
    } catch {
      // 通知钩子失败不影响主流程
    }
    return alarm;
  }

  list(): AlarmRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
  }
}

/** 进程级单例（服务层默认注入点） */
export let alarmBusSingleton: AlarmBus | null = null;
export function getAlarmBus(): AlarmBus {
  if (!alarmBusSingleton) {
    alarmBusSingleton = new AlarmBus();
  }
  return alarmBusSingleton;
}
export function resetAlarmBus(): void {
  alarmBusSingleton = null;
}

export interface StatsSnapshot {
  servers: ServerStatusItem[];
  agents: {
    total: number;
    roots: number;
    leaves: number;
    byLifecycle: Record<string, number>;
    maxDepth: number;
  };
  sessions: {
    totalRecords: number;
    recent: number;
  };
  alarms: AlarmRecord[];
  timestamp: string;
}

export class StatsService {
  private registry: AgentRegistry;
  private alarmBus: AlarmBus;

  constructor(registry: AgentRegistry, alarmBus?: AlarmBus) {
    this.registry = registry;
    this.alarmBus = alarmBus ?? getAlarmBus();
  }

  async servers(): Promise<ServerStatusItem[]> {
    const mgr = getModelServer();
    if (!mgr) {
      return [];
    }
    try {
      return mgr.status() as unknown as ServerStatusItem[];
    } catch {
      return [];
    }
  }

  /** Agent 树统计（对齐 Python agent_tree 的面板口径） */
  async agentsStats(): Promise<StatsSnapshot["agents"]> {
    const agents = await this.registry.loadedAgents;
    const byLifecycle: Record<string, number> = {};
    const childSet = new Set<string>();
    for (const a of agents) {
      byLifecycle[String(a.lifecycle ?? "unknown")] = (byLifecycle[String(a.lifecycle ?? "unknown")] ?? 0) + 1;
      for (const c of a.children ?? []) {
        childSet.add(c);
      }
    }
    const roots = agents.filter((a) => a.parent_id === null || a.parent_id === undefined).length;
    return {
      total: agents.length,
      roots,
      leaves: agents.filter((a) => (a.children ?? []).length === 0).length,
      byLifecycle,
      maxDepth: computeMaxDepth(agents),
    };
  }

  async sessions(): Promise<StatsSnapshot["sessions"]> {
    const all = await loadHistory(null, 1000);
    const now = Date.now();
    const recent = all.filter((r) => {
      const t = Date.parse(r.timestamp);
      return !Number.isNaN(t) && now - t < 24 * 3600 * 1000;
    }).length;
    return { totalRecords: all.length, recent };
  }

  async snapshot(): Promise<StatsSnapshot> {
    const [servers, agents, sessions] = await Promise.all([
      this.servers(),
      this.agentsStats(),
      this.sessions(),
    ]);
    return {
      servers,
      agents,
      sessions,
      alarms: this.alarmBus.list(),
      timestamp: new Date().toISOString(),
    };
  }
}

function computeMaxDepth(agents: Array<{ id: string; parent_id?: string | null; children?: string[] }>): number {
  const byId = new Map(agents.map((a) => [a.id, a]));
  let max = 0;
  for (const a of agents) {
    let depth = 0;
    let cur = a.parent_id ?? null;
    const seen = new Set<string>([a.id]);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      depth++;
      cur = byId.get(cur)?.parent_id ?? null;
    }
    max = Math.max(max, depth);
  }
  return max;
}