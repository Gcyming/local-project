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
  // 会话管理（侧栏对话列表：项目 = Agent，项目内独立会话）
  sessions_list: "slime:sessions:list",
  sessions_create: "slime:sessions:create",
  sessions_rename: "slime:sessions:rename",
  sessions_remove: "slime:sessions:remove",
  sessions_load: "slime:sessions:load",
  sessions_clear: "slime:sessions:clear",
  sessions_config: "slime:sessions:config",
  sessions_config_get: "slime:sessions:configGet",
  sessions_pick_folder: "slime:sessions:pickFolder",
  sessions_remove_agent: "slime:sessions:removeAgent",
  // 加号/命令面板 + 输入联想
  extras_list: "slime:extras:list",
  chat_suggest: "slime:chat:suggest",
  // 状态
  stats_snapshot: "slime:stats:snapshot",
  stats_poll: "slime:stats:poll",
  // Agent 管理
  agent_list: "slime:agents:list",
  agent_create: "slime:agents:create",
  agent_fork: "slime:agents:fork",
  agent_select: "slime:agents:select",
  agent_detail: "slime:agents:detail",
  agent_update: "slime:agents:update",
  agent_remove: "slime:agents:remove",
  // 身份移民协议 v1.2：导出 / 导入
  agent_export: "slime:agents:export",
  agent_import: "slime:agents:import",
  // sidecar 生命周期
  sidecar_status: "slime:sidecar:status",
  sidecar_spawn: "slime:sidecar:spawn",
  sidecar_terminate: "slime:sidecar:terminate",
  // Provider 管理（加密存储 + 模型探测）
  providers_list: "slime:providers:list",
  providers_fetch_models: "slime:providers:fetchModels",
  providers_save: "slime:providers:save",
  providers_remove: "slime:providers:remove",
  // 本地模型管理
  providers_local_list: "slime:providers:localList",
  providers_local_save: "slime:providers:localSave",
  providers_local_remove: "slime:providers:localRemove",
  providers_local_scan: "slime:providers:localScan",
  providers_local_pick: "slime:providers:localPick",
  // 参数文件调试（折叠栏）
  config_overview: "slime:config:overview",
  config_read: "slime:config:read",
  config_write: "slime:config:write",
  // 自动更新
  update_check: "slime:update:check",
  update_install: "slime:update:install",
  update_status: "slime:update:status",
  // 心智中枢（记忆/学习/进化/情绪整合）
  mind_config_get: "slime:mind:configGet",
  mind_config_set: "slime:mind:configSet",
  mind_emotion_get: "slime:mind:emotionGet",
  mind_emotion_set: "slime:mind:emotionSet",
  mind_book_to_skill: "slime:mind:bookToSkill",
  mind_download: "slime:mind:download",
  mind_download_control: "slime:mind:downloadControl",
  mind_download_snapshot: "slime:mind:downloadSnapshot",
  mind_locate_dep: "slime:mind:locateDep",
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
  /** 会话 ID（项目内独立会话；缺省写入无 session_id 记录） */
  sessionId?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  children: string[];
  parent_id: string | null;
  lifecycle: string;
}

/** 侧栏会话项（项目 = Agent，项目内独立会话） */
export interface SessionItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string;
  count: number;
  lastTime: string;
}

/** 会话消息（历史加载） */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
}

/** 会话级审批模式（映射沙箱档位） */
export type ApprovalMode = "auto" | "confirm" | "strict";

/** 会话级配置（审批模式 + 工作目录） */
export interface SessionConfig {
  approval: ApprovalMode;
  workspace: string;
}

/** 输入联想项（历史会话相似消息） */
export interface SuggestionItem {
  content: string;
  agentName: string;
  time: string;
}

/** 加号/命令面板数据（技能 + MCP 工具） */
export interface ExtrasList {
  skills: Array<{ name: string; description: string }>;
  mcpTools: Array<{ name: string; description: string }>;
}

/** 属性面板详情（agents:detail 返回，字段对齐 core-ts AgentState） */
export interface AgentDetail {
  id: string;
  name: string;
  role: string;
  model_choice: string;
  mode: string;
  reasoning_effort: string;
  max_context?: number;
  max_output?: number;
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

/* ── Provider 管理 ── */

export interface ModelSpec {
  id: string;
  context_window?: number;
  max_output?: number;
  vision?: boolean;
}

/** 渲染层可见的脱敏 Provider 摘要（绝不含明文 api_key） */
export interface ProviderSummary {
  key: string;
  api_base: string;
  has_key: boolean;
  key_hint: string;
  model: string | null;
  models: ModelSpec[];
}

/** 本地模型注册项（model_choice=local:<id>） */
export interface LocalModelSpec {
  id: string;
  path: string;
  label: string;
  ctx_len?: number;
  gpu_layers?: number;
  max_output?: number;
  vision?: boolean;
}

/* ── 参数文件调试 ── */

export interface ConfigFileInfo {
  name: string;
  path: string;
  exists: boolean;
  writable: boolean;
  size: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  hasManifest: boolean;
  hasSkillMd: boolean;
}

export interface McpServerInfo {
  name: string;
  kind: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
}

export interface ConfigOverview {
  files: ConfigFileInfo[];
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
}

/* ── 心智中枢 ── */

/** 向量工具：bge = 真实 BGE-M3 嵌入（高优）；basic = LanceDB + 哈希占位向量（基础） */
export type VectorTool = "bge" | "basic";

/** 依赖状态（模型/llama.cpp 不在 git 仓库，换设备需手动就位） */
export interface MindDeps {
  llamaBin: string;
  bgeModel: string;
  localModelsDir: string;
  ok: { llamaBin: boolean; bgeModel: boolean; localModelsDir: boolean };
}

/** 心智中枢配置快照 */
export interface MindConfigInfo {
  vectorTool: VectorTool;
  memoryRoot: string;
  memoryPaths: { knowledge: string; lance: string };
  deps: MindDeps;
}

/** 依赖定位结果（locateDep）：found=找到并尝试写入 slime.toml；written=是否写成功 */
export interface LocateDepResult {
  found: boolean;
  written?: boolean;
  deps: MindDeps;
}

/** Agent 情绪快照（对齐 EmotionalState.toDict） */
export interface EmotionSnapshot {
  valence: number;
  arousal: number;
  dominance: number;
  mood: string;
  relational_depth: number;
  last_updated: string | null;
  events: Array<{ t: string; trigger: string; detail: string; mood_before: string; mood_after: string }>;
  agentName?: string;
}

/** 依赖下载任务状态（应用内下载，国内镜像） */
export type DownloadTarget = "llama" | "bge";
export type DownloadState = "idle" | "downloading" | "paused" | "done" | "error";

export interface DownloadProgressInfo {
  target: DownloadTarget;
  state: DownloadState;
  percent: number;
  receivedMB: number;
  totalMB: number;
  path: string;
  error?: string;
  extractedDir?: string;
}
