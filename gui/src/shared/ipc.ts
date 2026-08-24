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
  // 通用设置（开机自启 / 卸载）
  settings_autostart_get: "slime:settings:autostart:get",
  settings_autostart_set: "slime:settings:autostart:set",
  settings_uninstall: "slime:settings:uninstall",
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
  // 右侧栏：工作树 / 终端
  workspace_list: "slime:workspace:list",
  // 文件资源管理器：系统对话框选浏览根 / 上级目录
  workspace_pick_browse_root: "slime:workspace:pickBrowseRoot",
  workspace_get_parent: "slime:workspace:getParent",
  term_exec: "slime:term:exec",
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
  /** 联网搜索开关：false 时 web_search/web_fetch 工具被静默拒绝 */
  networkEnabled?: boolean;
}

/** 本地模型加载进度（主进程 → 渲染层，slime:model:loading） */
export interface ModelLoadingStatus {
  loading: boolean;
  message?: string;
  /** 取消加载用的会话/Agent key（chat.cancel(key)） */
  key?: string;
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
  /** 该条回复的推理/思考过程（assistant，Markdown；旧记录无此字段） */
  reasoning?: string;
  /** 该条回复的耗时（毫秒，assistant；旧记录无此字段） */
  elapsedMs?: number;
}

/** 会话级审批模式（映射沙箱档位） */
export type ApprovalMode = "auto" | "confirm" | "strict";

/** 权限请求选项（渲染层选择题 UI：列出每个选项的结果，供用户抉择） */
export interface PermissionOption {
  id: string;
  label: string;
  /** 选择该选项后的结果说明 */
  hint: string;
  /** 需要用户自填的占位提示（仅 "custom" 选项） */
  customPlaceholder?: string;
}

/** 主进程 → 渲染层：权限请求（输入框位置弹出选择题，替代系统弹窗） */
export interface PermissionRequestUI {
  requestId: string;
  agentId: string;
  agentName: string;
  /** 风险/方向说明（工作目录外 / 需要用户抉择的上下文） */
  taskDescription: string;
  actions: Array<{ action: string; target: string; level: number }>;
  /** 选择题选项（含各选项结果） */
  options: PermissionOption[];
}

/** 渲染层 → 主进程：用户对权限请求的决策 */
export interface PermissionDecision {
  requestId: string;
  approved: boolean;
  /** 拒绝或自定义时填写的原因/指示 */
  reason: string;
  /** 本次会话内该工具不再询问 */
  alwaysAllow: boolean;
}

/** 主进程 → 渲染层：ask_user 提问（方向分歧 / 关键决策；输入框位置选择题 UI，复用权限交互形态） */
export interface AskUserRequestUI {
  requestId: string;
  agentId: string;
  agentName: string;
  /** 问题正文（模型给出，含各选项后果说明） */
  question: string;
  /** 建议选项（可为空数组，此时展示自填输入） */
  options: string[];
}

/** 渲染层 → 主进程：用户对 ask_user 的回答 */
export interface AskUserDecision {
  requestId: string;
  /** 选择的选项文本 / 自定义输入 */
  answer: string;
  /** 用户跳过（未作答）时为 true */
  skipped: boolean;
}

/** 全局权限控制（设置「权限」专栏；gui_permissions.json 持久化） */
export interface GuiPermissions {
  globalApproval: ApprovalMode;
  toolRead: boolean;
  toolWrite: boolean;
  toolTerminal: boolean;
  toolNetwork: boolean;
  mcpEnabled: boolean;
  skillsEnabled: boolean;
}

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
  /** 思考显示开关（"1"=开默认 / "0"=关） */
  show_thinking?: string;
  max_context?: number;
  max_output?: number;
  lifecycle: string;
}

export interface StatsSnapshot {
  servers: Array<{ role: string; port: number; state: string; model: string; vram: number; error?: string }>;
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
  /** 是否启用（禁用 = 技能目录被移至 config/skills/.disabled/ 下） */
  enabled: boolean;
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

/** Agent 进化快照（心智中枢进化板块：生命周期 + 人格特质 + 行为/交互积累） */
export interface EvolutionSnapshot {
  ok: boolean;
  agentName?: string;
  lifecycle?: string;
  created_at?: string | null;
  traits?: Array<{ name: string; weight: number; last_used: string | null }>;
  behaviorCount?: number;
  interactionCount?: number;
  evolution?: Record<string, unknown> | null;
  error?: string;
}

/** 依赖下载任务状态（应用内下载，国内镜像） */
export type DownloadTarget = "llama" | "bge";

export type DownloadState = "idle" | "downloading" | "paused" | "done" | "error";

/** 启动引导状态（A-C-C 式启动加载面板：等待后端等进程就绪再进入主界面） */
export interface BootStatus {
  phase: "starting" | "backend" | "ready" | "degraded";
  /** 后端服务是否可用（degraded = 后端缺失/失败，不阻塞进入主界面） */
  backendReady: boolean;
  message?: string;
}
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

/* ── 右侧栏：工作树 / 终端 ── */

/** 工作树目录项（右侧栏「工作树」标签页） */
export interface WorkspaceEntry {
  name: string;
  /** 相对工作根的路径（"/" 分隔，根目录为 ""） */
  rel: string;
  isDir: boolean;
  size: number;
}

/** 工作树读取结果（主进程校验路径锚定在工作根内） */
export interface WorkspaceListResult {
  ok: boolean;
  entries?: WorkspaceEntry[];
  error?: string;
}

/** 文件内容 MIME 类型映射 */
export type FileMime = "text" | "image" | "binary";

/** 工作树文件读取结果（点击文件打开新标签页用） */
export interface WorkspaceReadFileResult {
  ok: boolean;
  path?: string;
  name?: string;
  content?: string;
  /** "text" / "image" / "binary" */
  mime?: FileMime;
  /** 文本内容因体积超限被截断时为 true */
  truncated?: boolean;
  error?: string;
}

/** 终端执行结果（右侧栏「终端」标签页：命令运行器，非 PTY） */
export interface TermResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

/** 右键菜单项 */
export interface ContextMenuItem {
  /** 显示文字 */
  label: string;
  /** 菜单动作标识 */
  action: string;
  /** 可选快捷键（仅用于展示） */
  accelerator?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 分割线 */
  type?: "separator";
}

/** 工作树文件右键菜单参数 */
export interface WorkspaceContextMenuParams {
  /** 是否为目录 */
  isDir: boolean;
  /** 完整相对路径 */
  rel: string;
  /** 文件名 */
  name: string;
  /** 文件大小（字节），目录为 0 */
  size: number;
}

/** 工作树新建文件/文件夹参数 */
export interface WorkspaceCreateItemParams {
  root: string;
  parentRel: string;
  name: string;
  isDir: boolean;
}

/** 工作树新建结果 */
export interface WorkspaceCreateResult {
  ok: boolean;
  rel?: string;
  error?: string;
}

/* ── 右侧栏：Git 仓库 ── */

/** 提交记录项 */
export interface GitCommitItem {
  hash: string;
  message: string;
  time: string;
}

/** 工作区状态（按暂存状态分组；未跟踪 / 已删除单列） */
export interface GitStatusInfo {
  /** 已暂存（index 相对 HEAD 有变更） */
  staged: string[];
  /** 已修改未暂存（工作区相对 index 有变更） */
  modified: string[];
  /** 未跟踪 */
  untracked: string[];
  /** 已删除（工作区已删，含已暂存删除） */
  deleted: string[];
}

/** git 信息读取结果（分支 / 提交 / 状态 / 分支列表 / 领先落后） */
export interface GitInfo {
  ok: boolean;
  branch?: string;
  commits?: GitCommitItem[];
  status?: GitStatusInfo;
  branches?: string[];
  /** 领先远端提交数（可推送） */
  ahead?: number;
  /** 落后远端提交数（可拉取） */
  behind?: number;
  error?: string;
}

/** git 仓库检测结果（自动关联工作目录时使用） */
export interface GitDetect {
  ok: boolean;
  isRepo: boolean;
  /** 仓库根目录（工作目录可能只是仓库的子目录） */
  root?: string;
  branch?: string;
  /** 目标目录（或其父级）不存在，init 时可自动 mkdir 创建 */
  notExists?: boolean;
  error?: string;
}

/** 通用 git 操作结果 */
export interface GitAction {
  ok: boolean;
  error?: string;
}

/** git clone 结果 */
export interface GitCloneResult {
  ok: boolean;
  path?: string;
  error?: string;
}
