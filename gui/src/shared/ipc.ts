/**
 * gui/src/shared/ipc.ts — IPC 事件名常量 + 类型（渲染 ↔ 主进程）。
 * 事件流统一格式 {seq,type,data}（v2.6 定案；IPC 结构化克隆）。
 * GUI 通过 IPC 调用 core-ts 服务 API 直接回传，不经过 HTTP/gateway-ts。
 */

export const IPC_CHANNELS = {
  // 聊天
  chat_stream: "slime:chat:stream",
  chat_send: "slime:chat:send",
  // 状态
  stats_snapshot: "slime:stats:snapshot",
  stats_poll: "slime:stats:poll",
  // Agent 管理
  agent_list: "slime:agents:list",
  agent_create: "slime:agents:create",
  agent_fork: "slime:agents:fork",
  // sidecar 生命周期
  sidecar_status: "slime:sidecar:status",
  sidecar_spawn: "slime:sidecar:spawn",
  sidecar_terminate: "slime:sidecar:terminate",
} as const;

export interface StreamChunk {
  seq: number;
  type: "chunk" | "tool" | "reasoning" | "progress" | "done" | "error" | "heartbeat";
  data: {
    content?: string;
    name?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    elapsedMs?: number;
    timings?: Record<string, number>;
    message?: string;
  };
}

export interface ChatInput {
  agentId: string;
  message: string;
  history?: unknown[];
  maxTokens?: number;
  resumeSeq?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  children: string[];
  parent_id: string | null;
  lifecycle: string;
}

export interface StatsSnapshot {
  servers: Array<{ role: string; port: number; state: string; model: string; vram: number }>;
  agents: { total: number; roots: number; leaves: number; byLifecycle: Record<string, number>; maxDepth: number };
  sessions: { totalRecords: number; recent: number };
  alarms: Array<{ seq: number; severity: string; source: string; message: string; timestamp: string }>;
  timestamp: string;
}

export type SidecarStatus = {
  running: boolean;
  port?: number;
  model?: string;
  vram?: number;
  pid?: number;
};
