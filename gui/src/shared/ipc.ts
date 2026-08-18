/**
 * gui/src/shared/ipc.ts — IPC 事件名常量 + 类型（渲染 ↔ 主进程）。
 * 事件流统一格式 {seq,type,data}（v2.6 定案；IPC 结构化克隆）。
 * GUI 通过 IPC 调用 core-ts 服务 API 直接回传，不经过 HTTP/gateway-ts。
 */

export const IPC_CHANNELS = {
  // 聊天
  chat_stream: "slime:chat:stream",
  chat_send: "slime:chat:send",
  // P0: 新对话 / 重试上条
  chat_new: "slime:chat:new",
  chat_retry: "slime:chat:retry",
  // 状态
  stats_snapshot: "slime:stats:snapshot",
  stats_poll: "slime:stats:poll",
  // Agent 管理
  agent_list: "slime:agents:list",
  agent_create: "slime:agents:create",
  agent_fork: "slime:agents:fork",
  agent_select: "slime:agents:select",
  agent_update: "slime:agents:update",
  // 身份移民协议 v1.2：导出 / 导入
  agent_export: "slime:agents:export",
  agent_import: "slime:agents:import",
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

/** 身份移民协议 v1.2 — 导出结果（§4） */
export interface AgentExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** 身份移民协议 v1.2 — 冲突策略（§5.2） */
export type AgentImportConflictStrategy = "abort" | "overwrite" | "keep-old";

/** 身份移民协议 v1.2 — 导入结果（§5） */
export interface AgentImportResult {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  error?: string;
  warnings?: string[];
}
