/**
 * gui/src/shared/ipc.ts — IPC 事件名常量 + 类型（渲染 ↔ 主进程）。
 * 事件流统一格式 {seq,type,data}（v2.6 定案；IPC 结构化克隆）。
 * GUI 通过 IPC 调用 core-ts 服务 API 直接回传，不经过 HTTP/gateway-ts。
 */
// 只引类型（`import type` 编译期擦除，不会把 shared 的运行时实现拖进 main 的依赖图）
import type { ModelPriceTiers, PriceCurrency } from "../../../shared/gen/model-capabilities.js";

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
  sessions_remove_workspace: "slime:sessions:removeWorkspace",
  sessions_set_members: "slime:sessions:setMembers",
  // 加号/命令面板 + 输入联想
  extras_list: "slime:extras:list",
  chat_suggest: "slime:chat:suggest",
  // 状态
  stats_snapshot: "slime:stats:snapshot",
  stats_poll: "slime:stats:poll",
  // 使用统计（Settings「使用统计」面板数据源）
  usage_snapshot: "slime:usage:snapshot",
  usage_clear: "slime:usage:clear",
  /** 用当前生效价格重算历史成本（修正"写入时还没有价"的 0 成本记录） */
  usage_recompute: "slime:usage:recompute",
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
  // LLM 网关（设置 → LLM 网关）
  llmgw_get: "slime:llmgw:get",
  llmgw_set: "slime:llmgw:set",
  llmgw_status: "slime:llmgw:status",
  llmgw_restart: "slime:llmgw:restart",
  llmgw_token_add: "slime:llmgw:token:add",
  llmgw_token_update: "slime:llmgw:token:update",
  llmgw_token_remove: "slime:llmgw:token:remove",
  llmgw_token_toggle: "slime:llmgw:token:toggle",
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
  /** A-980-R8：用系统默认应用打开文件（word/pdf/ppt/excel 等右侧栏无力渲染的格式） */
  shell_open_path: "slime:shell:openPath",
  term_exec: "slime:term:exec",
  /* ── A-1069（#226）：Agent 启动的后台资源面板 ─────────────────────────────
     范围由用户划定：**仅 Agent 启动的**（屏幕控制常驻宿主 / http_serve 的本地服务 /
     后台子代理）。应用自身服务（Python 后端、llama-server、MCP、情感脑 sidecar）
     一概不进这个面板 —— 关掉它等于把应用打瘸，那不是用户想在这里做的事。 */
  agentprocs_list: "slime:agentprocs:list",
  agentprocs_stop: "slime:agentprocs:stop",
  /** 主进程 → 渲染层：后台资源集合发生变化（起/停），让面板立刻刷新而不是靠轮询 */
  agentprocs_changed: "slime:agentprocs:changed",
} as const;

/**
 * A-980-R4：**浏览器类协议名单**——`bitbrowser://`、`chrome://`、`msedge://` 这类协议的目标是
 * 「唤起另一款浏览器加载当前页面/云控指令」，对 slime 右侧栏浏览毫无价值。
 * 若按「探测→已注册就 shell.openExternal」处理，用户装了 BitBrowser 时会被拉起，
 * BitBrowser 自己加载不了 `bitbrowser://cc` 这类指令 → 它界面顶部弹黄色横幅报错（丑、按钮变形）。
 * 因此浏览器类协议一律**不唤醒外部应用**，静默拦截 + 渲染层轻提示（治本而非屏蔽）。
 * 其余真实应用协议（weixin:// / mailto: / qq:// / taobao:// 等）仍走「探测→已注册才打开」通道。
 */
export const BROWSER_SCHEMES = new Set([
  "bitbrowser", "chrome", "msedge", "edge", "firefox", "opera", "opear", "vivaldi", "brave",
  "qqbrowser", "sogou", "browser360", "360se", "360chrome", "maxthon", "baidubrowser",
  "ucbrowser", "quark",
]);

/** URL 是否属于浏览器唤起类协议（应为 true → 拦截不唤起外部应用） */
export function isBrowserSchemeUrl(url: string): boolean {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec((url ?? "").trim());
  if (!m) { return false; }
  return BROWSER_SCHEMES.has(m[1].toLowerCase());
}

export interface StreamChunk {
  seq: number;
  type: "chunk" | "tool" | "tool-start" | "reasoning" | "progress" | "done" | "error" | "heartbeat" | "member" | "steer" | "notice";
  data: {
    content?: string;
    name?: string;
    /**
     * A-1061②：工具调用 id —— `tool-start` 与 `tool` 同值，界面据此把那一行
     * 从「执行中…」翻成「✓ 成功 / ✗ 失败」（与 Claude Code 的 tool_start→tool_end 同一形态）。
     */
    toolId?: string;
    /**
     * A-1060：中途「引导」已进本轮上下文（type="steer"）。
     * 值是渲染层待发卡片的 id —— 界面据此撤掉那张卡（它已生效，不该再排队发一遍），
     * 并用同一事件的 `content` 就地补上用户气泡。
     */
    steerId?: string;
    /** A-162: 工具调用的参数原文（tool 事件；前端提取网址/文件路径展示细节行） */
    args?: string;
    /** 工具执行结果（tool 事件；供阶段卡展示/留痕） */
    result?: string;
    /** SILAM 大脑思考过程（type="done"/"chunk" 事件携带，折叠展示） */
    reasoning?: string;
    /** 团队会话：成员发言事件（type="member"）的发声 Agent ID */
    agentId?: string;
    /** A-1008：member 事件的「发言结束通知」（true 时 content 为空）——用于把该成员刚生成的气泡
     *  按结果降级（目前只用于 failed）。判据只有整段正文才成立，故不能塞进逐段到达的 chunk。 */
    speechEnd?: boolean;
    /** A-1008：member 事件对应发言失败（正文是失败占位文本，UI 降级为错误样式） */
    failed?: boolean;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    elapsedMs?: number;
    timings?: Record<string, number>;
    message?: string;
    /** 该流所属会话（main 进程注入；渲染层据此过滤，杜绝切会话后旧流串扰） */
    sessionId?: string;
  };
}

// ── D：全链路可观测（trace/span，LangSmith/LangGraph 语义） ────────────────
export type TraceEventKind =
  | "route_select" | "memory_retrieve" | "tool_call" | "tool_result"
  | "reasoning_chunk" | "reply_chunk" | "done" | "eval";

export interface TraceSpan {
  id: string;
  name: string;
  kind: TraceEventKind;
  parentId?: string;
  startedAt: number;
  endedAt?: number;
  data?: Record<string, unknown>;
}

export interface TraceSnapshot {
  id: string;
  sessionId?: string;
  spans: TraceSpan[];
  startedAt: number;
  endedAt?: number;
}

// ── E：Plan 一等对象（plan_create/plan_update/todo_write → 会话级 Plan） ─────
export type PlanStageStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type PlanStatus = "planning" | "active" | "done" | "failed";

export interface PlanStage {
  id: string;
  label: string;
  detail?: string;
  status: PlanStageStatus;
}

export interface PlanInfo {
  id: string;
  sessionId?: string;
  description: string;
  stages: PlanStage[];
  createdAt: number;
  updatedAt: number;
  status: PlanStatus;
  /** A-980-R29：`"plan"`=plan_create 真 Plan；`"todo"`=由待办清单派生的只读镜像（优先级更低） */
  source?: "plan" | "todo";
}

/** 待办任务项（右侧栏「待办任务」面板 / todo_write 工具落盘结构） */
export interface TodoItemDTO {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** 完成时刻（ISO）——转入 completed 时由 todo_write 自动打戳，界面据此展示"何时完成" */
  completedAt?: string;
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
  /** 识图图片（data URL 列表，data:image/png;base64,...） */
  images?: string[];
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

/** A-980-R22：Agent 工具面白名单（skill/MCP 差异化配置；与 core-ts agentTools.ToolProfile 同构） */
export interface ToolProfileDTO {
  mode: "default" | "custom";
  /** 启用的技能名（extras.skillList 的 name） */
  skills: string[];
  /** 启用的 MCP 服务器名（extras.mcpList 的 name，运行时按 mcp_<server>_* 前缀匹配工具） */
  mcp: string[];
}

/** 侧栏会话项（以目标工作文件夹为主分组；会话内指定调用 Agent，可随时切换） */
export interface SessionItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  /** 目标工作文件夹（会话级；旧数据可能为空 → 归入「未绑定文件夹」组） */
  workspace?: string;
  title: string;
  count: number;
  lastTime: string;
  /** 团队会话成员 Agent id 列表（组长 = agentId；不含组长；空/缺省 = 单人会话） */
  memberIds?: string[];
  /** 团队会话成员 Agent 名称（与 memberIds 同序，渲染徽章用） */
  memberNames?: string[];
  /** A-954：成员入群模型（memberId → model_choice 串） */
  memberModels?: Record<string, string>;
  /** A-954：群聊组长（会话归属 Agent）入群模型 */
  leaderModel?: string;
  /** A-1011：成员推理强度覆盖（memberId → effort；缺省 = 群聊默认 high） */
  memberEfforts?: Record<string, string>;
  /** A-1011：群聊组长的推理强度覆盖（缺省 = 群聊默认 high） */
  leaderEffort?: string;
  /** A-943 会话模式：brainstorm = 群聊头脑风暴（左侧特殊渲染）；缺省 normal */
  type?: "normal" | "brainstorm";
}

/** 会话消息（历史加载） */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
  /** A-980-R18：原始 ISO 时间戳（分页加载更早历史时作 beforeTs 定位锚；旧字段兼容缺省） */
  ts?: string;
  /** 该条回复的推理/思考过程（assistant，Markdown；旧记录无此字段） */
  reasoning?: string;
  /** 该条回复的耗时（毫秒，assistant；旧记录无此字段） */
  elapsedMs?: number;
  /** A-966：交错思考时间线（思考/工具调用顺序；随历史落库，重启恢复时间线展示） */
  timeline?: Array<{ kind: string; text?: string; name?: string; label?: string; detail?: string; result?: string }>;
  /** 发言人 Agent 名称（团队会话成员发言；缺省 = 会话组长/当前 Agent） */
  agentName?: string;
  /** 发言人 Agent ID（团队会话成员发言） */
  agentId?: string;
  /** A-1008：该条实为「发言失败」占位文本（`（名字 本次发言失败：…）`），不是这位成员真说过的话。
   *  UI 据此降级为错误样式——不加这个标记时，一段上游报错串会伪装成成员观点常驻在群聊里。 */
  failed?: boolean;
}

/** 会话级审批模式（映射沙箱档位） */
/** 审批档位：manual 手动 / auto 自动 / none 无需 / custom 自定义（旧值 strict/confirm 兼容为 manual） */
export type ApprovalMode = "manual" | "auto" | "none" | "custom";

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
  /** 触发该请求的流所属会话（main 注入；切会话后旧会话残留请求可据此丢弃，避免输入框被无关选择题卡住） */
  sessionId?: string;
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
  /** 决策分类徽章（如"部署方案"/"架构取舍"） */
  header?: string;
  /** 建议选项 = 各方向主体（可为空数组，此时展示自填输入） */
  options: string[];
  /** 与 options 平行的后果说明（选择该选项的影响） */
  consequences?: string[];
  /** 模型自评推荐项下标（UI 标注「⭐ 推荐」） */
  recommendation?: number;
  /** 触发该请求的流所属会话（main 注入；切会话后旧会话残留提问可据此丢弃，避免输入框被无关提问卡住） */
  sessionId?: string;
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
  /** 自定义审批白名单（目录/仓库命中免审批，custom 档生效） */
  approvalAllowPaths: string[];
  toolRead: boolean;
  toolWrite: boolean;
  /** terminal 类：shell / 命令执行（含 ADB shell） */
  toolTerminal: boolean;
  /** 图形控制总开关（screen_* 工具：桌面输入注入 + 安卓触摸控制） */
  screenEnabled: boolean;
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
  /** A-980-R22：工具面白名单（skill/MCP 差异化配置） */
  tool_profile?: ToolProfileDTO;
}

export interface StatsSnapshot {
  servers: Array<{ role: string; port: number; state: string; model: string; vram: number; error?: string }>;
  agents: { total: number; roots: number; leaves: number; byLifecycle: Record<string, number>; maxDepth: number };
  sessions: { totalRecords: number; recent: number };
  alarms: Array<{ seq: number; severity: string; source: string; message: string; timestamp: string }>;
  timestamp: string;
}

/** LLM 网关配置（设置 → LLM 网关） */
/** LLM 网关令牌定义（B 档：每令牌独立速率/日配额/模型白名单） */
export interface LlmGatewayTokenDTO {
  key: string;
  label?: string;
  active?: boolean;
  /** 每分钟请求数上限（0/undefined = 不限） */
  ratePerMin?: number;
  /** 每日请求数上限（UTC 自然日；0/undefined = 不限） */
  dailyQuota?: number;
  /** 模型白名单（空 = 全部可用） */
  models?: string[];
  note?: string;
}
/** LLM 网关配置（设置 → LLM 网关） */
export interface LlmGatewayConfigDTO {
  enabled: boolean;
  port: number;
  apiKey: string;
  tokens: LlmGatewayTokenDTO[];
}
/** 新增令牌输入（key 由系统生成） */
export interface LlmGatewayNewTokenDTO {
  label?: string;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}
/** 修改令牌输入（按 key 定位） */
export interface LlmGatewayUpdateTokenDTO {
  key: string;
  label?: string;
  active?: boolean;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}
/** 令牌 CRUD 统一返回 */
export interface LlmGatewayTokenOpResultDTO {
  ok: boolean;
  token?: LlmGatewayTokenDTO;
  restarted?: boolean;
  error?: string;
  status?: LlmGatewayStatusDTO;
  tokens?: LlmGatewayTokenDTO[];
}
/** LLM 网关运行状态 */
export interface LlmGatewayStatusDTO {
  ok: boolean;
  running: boolean;
  port: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  error?: string;
  /** 当前配置里的令牌数 */
  tokenCount?: number;
}

/** 使用统计快照（Settings「使用统计」面板一次拉取） */
export interface UsageRecordRow {
  ts: string;
  agent_id: string;
  session_id: string;
  model: string;
  provider_key: string;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  elapsed_ms: number;
  cost_usd: number;
  success: boolean;
  error?: string;
}
export interface UsageSnapshot {
  records: UsageRecordRow[];
  /** 本地时区偏移分钟数（东八区=+480）—— 由主进程从 process.env.TZ 或系统推断 */
  tzOffsetMin: number;
  totalRecords: number;
  /**
   * A-990-B：`"供应商key::模型id"` → 用户在「定价」面板为该模型**手选**的计价币种。
   *
   * 为什么由主进程下发而不是渲染层自己去读配置：统计面板只看 `usage.jsonl` 的账目记录
   * （里面有 provider_key / model，但没有币种偏好），而币种偏好存在 providers 配置里。
   * 让面板再走一趟 `providers.list()` 也能拿到，但会多一次 IPC 往返 + 一份可能过期的快照；
   * 与账目**同一次**下发才能保证"这份报表用的币种"与"这份数据"是同一时刻的。
   *
   * 只包含**用户手选过**的条目（未手选的留空 → 渲染层按归属地推断），
   * 所以旧版主进程/渲染层混跑时这个字段缺失也只是"退回按归属地"，不会报错。
   */
  modelCurrencies?: Record<string, PriceCurrency>;
}

/** 历史成本回填结果（`slime:usage:recompute`） */
export interface UsageRecomputeResult {
  ok: boolean;
  /** 被改写的记录数（只统计"0 → 有价"，具体数值见 usage.ts recomputeOne） */
  updated: number;
  /** 成功解析（未损坏）的记录总数 */
  scanned: number;
  /** 回填后全部记录的成本合计（USD） */
  totalCostUsd: number;
  /**
   * A-971：有 token 但**查不到任何价**的记录数。用于区分两种"updated=0"：
   * 真·没有可回填项（unpriced=0） vs 价格解析全线失守（unpriced≈全库）。
   * 没有这个数字时，后者会被界面上的"无可回填项"伪装成成功。
   */
  unpriced: number;
  /**
   * 未定价的模型 ID（按记录数降序，最多 5 个）。
   * 只给条数不够用：`m1`/`free-a` 这类自建模型本就不在价目表里，条数会长期很大，
   * 一律报"解析失守"就成了狼来了；列出模型名，用户才能判断是"该手填单价"还是"该查链路"。
   */
  unpricedModels: string[];
  /**
   * 回填的记录中**有多少条是按峰谷分时取档**（`price_tier` 非空）。
   * 分时定价是"看不见的计算逻辑"，只报"回填 N 条"无法区分「一律按均价算」与「逐条按时刻分档」——
   * 这个数字就是"分时功能对我的历史账目真的生效了"的证据。
   */
  tiered: number;
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
  thinking?: boolean;
  thinking_efforts?: string[];
  /** 是否启用（聊天模型选择只列出启用项；旧记录无此字段视为启用） */
  selected?: boolean;
  price_in_usd?: number;
  price_out_usd?: number;
  /** 缓存读取单价 USD / 1M tokens（cache 命中，通常远低于 prompt） */
  price_cache_read_usd?: number;
  /** 缓存写入/创建单价 USD / 1M tokens（通常高于 prompt） */
  price_cache_write_usd?: number;
  /**
   * 定价来源 —— 与主进程 ModelSpec 保持同名字段（缺了它 UI 无法区分「未定价」和「免费」，
   * 也无法在保存时把用户的「手填」标记回传，见 providers.ts mergeModelPrice）。
   */
  price_source?: "upstream" | "table" | "manual";
  /**
   * A-988c：用户自定义的分时（峰谷）档位。
   *
   * ⚠️ **必须与主进程 ModelSpec 的同名字段保持同步** —— 缺了它会有两个后果：
   *   ① 面板里编辑的时段表过不了 IPC 的类型检查（编译期就断）；
   *   ② 即使编译期绕过去，保存时也会被静默丢弃（用户以为存了、重启后没了）。
   * 这两个字段（price_source / price_tiers）都是"用户显式意图"，规则见 providers.ts mergeModelPrice。
   */
  price_tiers?: ModelPriceTiers;
  /**
   * A-990：用户为**该模型**手选的计价币种（"手动调整币种填入"）。
   *
   * 缺省（undefined）= 按归属地推断（`pricingDisplayCurrency`）。用户选了就压过推断 ——
   * 他可能拿的是转售价/合同价账单，币种与厂商所在地不一致；或他就想用美元核对国内模型的账。
   *
   * ⚠️ 它**只决定输入/显示的单位**，不改变记账：`price_in_usd` 等四个字段**恒存 USD**，
   * 录入时经 `toUsdAmount` 折算、显示时经 `convertFromUsd` 折算。这样账目单位唯一，
   * 引擎与历史回填逻辑一行都不用改。
   * ⚠️ 与主进程 ModelSpec 同名字段必须**同步**（理由同 price_tiers：不同步会在保存时被静默丢弃）。
   */
  price_currency?: PriceCurrency;
  /**
   * A-988d：上游声明的**时段价目**（OpenRouter `pricing.overrides`，UTC）转成的分时规格。
   * 名字里的 `candidate` 是刻意的：**它是候选，不参与取价**，只有用户点「导入上游时段」
   * 把它拷进 `price_tiers` 才生效。取价一律只看 `price_tiers`。
   */
  pricing_time_tiers_candidate?: ModelPriceTiers;
  /** A-988d：上游声明的上下文长度分档（纯展示 —— slime 取价没有"按上下文长度"这一维） */
  pricing_context_tiers?: Array<{ fromInputTokens?: number; prompt?: number; completion?: number }>;
  /** A-988d：上游按次/按张计费单价（纯展示，用于提示"该模型不是按 token 计价"） */
  pricing_per_request?: { request?: number; image?: number; webSearch?: number; internalReasoning?: number; audio?: number };
  /** 端点格式覆盖（per-model）：聚合网关下不同模型可能走不同端点 */
  api_format?: "openai" | "anthropic" | "responses" | "google" | "auto";
}

/** 渲染层可见的脱敏 Provider 摘要（绝不含明文 api_key） */
export interface ProviderSummary {
  key: string;
  api_base: string;
  has_key: boolean;
  key_hint: string;
  model: string | null;
  api_format: "openai" | "anthropic" | "responses" | "google" | "auto";
  models: ModelSpec[];
}

/** 本地模型注册项（model_choice=local:<id>）。
 *
 *  ⚠️ S3：字段集合的**唯一来源**是 `core-ts/src/local_models.ts` 的 `LocalModelSpec`。
 *  这里保留一份是因为**渲染层不能 import core-ts**（那是 node 侧代码），本文件是跨进程契约投影。
 *  两份必须逐字段一致 —— 由 `tests/core-ts/a1024-guards.spec.ts` 强制（字段名与可选性都比对，
 *  否则会重演"engine 那份悄悄缺 `vision`"）。改这里就要同步改那边，反之亦然。 */
export interface LocalModelSpec {
  id: string;
  path: string;
  label?: string;
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
  /**
   * LanceDB **运行时组件**的就位状态（A-1041）。
   * 297MB 的原生子包不再随默认安装包分发，改为「内嵌组件」：随完整版携带 / 应用内下载 / 手动放置。
   * `ok=false` 时向量层不开，界面必须如实说明（不静默降级）；`candidates` 告诉用户可以放哪。
   */
  lancedb: { ok: boolean; dir?: string; error?: string; candidates: string[] };  /**
   * 记忆存储位置（**真实绝对路径**，按目标 Agent 推导；唯一实现 core-ts 的 resolveMemoryPaths）。
   * `memoryJson` = 该 Agent 的 memory.json；`lanceDir` = 该 Agent 的 LanceDB 目录。
   * 两者都由自定义根目录（memoryRoot）统一决定 —— 不再出现"改了根目录只有一个跟着变"。
   * 未选到 Agent 时为 null（界面据此提示先选 Agent，而不是编一个 `data/<agentId>/…` 假路径）。
   */
  memoryPaths: { memoryJson: string; lanceDir: string } | null;
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

/** A-1038：下载/解压阶段。判据（好文案、百分比算法）唯一实现在 shared/downloadPhase.ts */
export type DownloadPhase = "download" | "extract" | "config" | "done";

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
  /** A-1038：当前阶段（下载 / 解压 / 配置 / 完成）——UI 用它渲染阶段文案 */
  phase: DownloadPhase;
  /** A-1038：阶段明细（"128/305 个文件" / "CUDA 运行时 xxx.zip"）；无明细为空串 */
  detail: string;
}

/**
 * A-1038：adb platform-tools 下载/解压进度。
 *
 * 此前这个形状在 `preload/index.ts` 里被**内联抄了 4 遍**（运行时声明 2 处 + 类型声明 2 处），
 * 加一个 `detail` 字段就要改四处、漏一处就静默丢字段。抽到共享层，两侧都引用它。
 */
export interface AdbDownloadProgressInfo {
  state: "downloading" | "extracting" | "done" | "error";
  percent: number;
  receivedMB: number;
  totalMB: number;
  error?: string;
  /** 解压阶段明细（"128/305 个文件"）；下载阶段为空 */
  detail?: string;
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
export type FileMime = "text" | "image" | "binary" | "pdf" | "office";

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

/* ── A-1069（#226）：Agent 启动的后台资源 ────────────────────────────────────
   ① **只借类型**（`import type`）：渲染层刻意不引入 core-ts（见 ChatPanel 的注释
      「renderer 不引入 core-ts 依赖，避免浏览器构建打包主进程图谱」），而 `import type`
      在编译后被完全擦除 → 既拿到**唯一出处**的视图类型（不会与主进程漂移），
      又不把主进程图谱带进浏览器包。本文件第 7 行对 `model-capabilities` 就是同一手法。
   ② **判据全在主进程侧**：渲染层只负责"把收到的视图画出来 + 把点击转成 {kind,id}"。
      类别归属、排序、状态词、可否停止 —— 一律由 `core-ts/src/services/agentProcs.ts`
      的纯函数决定。组件里**不许**出现 `kind === "..."` 这类判断（否则判据就分家了）。 */
import type { AgentProcEntry, AgentProcView } from "../../../core-ts/src/services/agentProcs.js";
export type { AgentProcEntry, AgentProcView } from "../../../core-ts/src/services/agentProcs.js";

/* ── A-1090：可救模型（压无可压时的唯一出路）────────────────────────────────
   同样**只借类型**：`CompressResult.rescueModel` 必须与 `core-ts/services/context_loop`
   的 `RescuableModel` 逐字段一致 —— 若在这里手抄一份形状，主进程加一个字段（例如 `choice`）
   而投影没跟上时，***渲染层会静默地少用一个字段***（切模型按钮点了没反应），tsc 也发现不了。
   用 `import type` 就没有"两份形状"这回事。 */
import type { RescuableModel } from "../../../core-ts/src/services/context_loop.js";

/** 列表返回：视图**或**失败原因（失败必须能说出来，不许静默给个空列表 ——
 *  空列表的含义是"没有后台资源"，与"查询失败"完全不同，混在一起会让用户以为没东西在跑）。 */
export type AgentProcsListResult =
  | { ok: true; view: AgentProcView }
  | { ok: false; error: string };

/** 停止请求：`id` 对 `http-server` / `subagent` 必填（`screen-host` 全局唯一，不带）。 */
export interface AgentProcsStopRequest { kind: string; id?: string }

/** 停止结果：失败要带原因（界面据此如实报，而不是乐观地把它划掉）。 */
export interface AgentProcsStopResult {
  ok: boolean;
  /** 成功时的收尾说明（如「已停止 127.0.0.1:8080」） */
  detail?: string;
  error?: string;
}

/** 面板里单条条目的渲染模型（= 主进程派生的视图条目；此处仅为可读性重导出别名） */
export type AgentProcRow = AgentProcEntry;

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

/* ── Git 变更 diff（红绿标注渲染，A-968） ── */

/** diff 单行（add=新增绿 / del=删除红 / ctx=上下文） */
export interface GitDiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

/** diff 块（@@ 头 + 行序列） */
export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}

/** 单文件变更 diff */
export interface GitDiffFile {
  /** 相对仓库根的文件路径 */
  file: string;
  /** modified=已跟踪文件修改 / untracked=未跟踪（整体视为新增）/ deleted=已删除 */
  status: "modified" | "untracked" | "deleted";
  additions: number;
  deletions: number;
  hunks: GitDiffHunk[];
}

/** git diff 读取结果（file 参数传单个文件；留空 = 全工作区） */
export interface GitDiffResult {
  ok: boolean;
  files?: GitDiffFile[];
  error?: string;
}

/* ── 系统通知 + 可定制提示音（A-980-R26，设置 → 通用） ── */

/**
 * 通知配置（落盘 config/notifications.json）。
 * 语义：`enabled` 是总开关；`soundEnabled` 仅在总开关打开时有意义。
 * `soundFile` 为空 = 用系统默认提示音；非空 = 用户上传的音频（存于 config/notification-sounds/）。
 */
export interface NotifyConfigDTO {
  /** 总开关：Agent 任务完成 / 需要选择 / 出错 / 意外终止时是否弹系统通知 */
  enabled: boolean;
  /** 弹通知时是否发出提示音 */
  soundEnabled: boolean;
  /** 自定义音频落盘文件名（null = 系统默认音） */
  soundFile: string | null;
  /** 自定义音频的原始文件名（仅界面展示） */
  soundName: string | null;
}

/**
 * A-1055：自动更新状态（主进程 → 渲染层 `slime:update:status`）。
 *
 * ⚠️ 与主进程 `updater.ts` 的 `UpdateStatus` 是**同一份契约**（字段增删必须同步）。
 * 之所以在这里再声明一次：preload/renderer 不能 import 主进程模块（会拖进 electron-updater）。
 */
export interface UpdateStatusDTO {
  status: "checking" | "downloading" | "downloaded" | "error" | "available" | "up-to-date" | "skipped" | "disabled";
  version?: string;
  releaseNotes?: string;
  error?: string;
  /** 下载进度百分比（0–100；仅 status === "downloading" 有值） */
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

/* ── 上下文自动压缩（A-969 / A-1082） ── */
/** 上下文自动压缩结果（GUI 发送前调用；动画展示后继续原消息发送） */
export interface CompressResult {
  ok: boolean;
  /** skipped：未达触发阈值 / 历史过短 / 熔断中 / 结果过期，未执行压缩 */
  skipped?: boolean;
  /**
   * A-1082：跳过 / 熔断 / 过期的**如实原因**（设计定稿 §3.2「任何 none 都必须带 reason」）。
   * ⚠️ 必须显示给用户——旧实现 `skipped` 是静默的，用户看到「逼近硬阈值却毫无动作」。
   */
  reason?: string;
  /**
   * A-1083：**压无可压且真的装不下** ⇒ 这一轮**拒发**（不发注定失败/会挂住的请求）。
   * 这是「连接半天」的根治：旧实现把这种请求发出去，靠 300s 超时 ×N 次重连来『发现』它超限。
   * `reason` 此时必须给出可操作项（换更大窗口的模型 / 开新会话）。
   */
  cannotFit?: boolean;
  /** truncated：摘要轮失败 / 无模型可用，降级为**只裁不摘要**（turn 对齐，保留最近 K 整轮） */
  truncated?: boolean;
  /** 模型生成的摘要文本（truncated/skipped 时无） */
  summary?: string;
  /** A-1082「理解总结」环产出的续接认知（5 字段自述；失败则为空） */
  comprehend?: string;
  /** 本次压缩剔除的历史消息条数 */
  dropped?: number;
  /** 压缩前输入侧估算 tokens */
  used?: number;
  /** 当前窗口上限 tokens */
  cap?: number;
  /**
   * A-1082：压缩后**实测估算**的输入侧 tokens，与 `used` **同口径**（历史 + 固定开销）。
   * 取代旧实现那个与真实体积无关的构造值 `cap × 0.5`（「假报」的直接形态）。
   */
  tokensAfter?: number;
  /** A-1082：压缩后**仍然**超限 ⇒ 界面必须明说「需换大窗口模型或开新会话」，不许静默 */
  stillOverflow?: boolean;
  /** A-1082：体积是否真的下降（不变量 I4；假压缩会被判 false） */
  realShrink?: boolean;
  /** A-1082：摘要轮因预算所限摘录掉的中间消息条数（0 = 全量喂给摘要轮） */
  elided?: number;
  /** A-1082：本次结果因期间已有更新压缩落地而丢弃（skip-stale） */
  stale?: boolean;
  /** A-1082：同一段历史连续失败 ≥3 次已熔断 */
  breakerOpen?: boolean;
  /**
   * A-1086：**压无可压**时给出的出路（"切到哪个模型"），唯一产地
   * `context_loop.formatRescueHint`。
   *
   * 有候选 → 具体模型名 + 窗口数（用户不用自己一个个试）；
   * 没候选 → 如实说"没有窗口更大的候选，请开新会话"（**不许沉默**：沉默会让用户
   * 以为工具根本没查过，于是继续在同一个死局里点重试）。
   */
  rescueHint?: string;
  /**
   * A-1090：`rescueHint` 的**结构化**形态（只在真的挑到候选时回带；没候选/没查成都不带）。
   *
   * 渲染层据此渲染「一键切换」按钮 —— `choice` 是**可直接写入 `model_choice`** 的选择串
   * （`api:<供应商key>:<模型id>` / `local:<模型id>`，唯一产地 `suggestWiderChatModel`）。
   * ⚠️ 渲染层**不许**拿 `id` 自己拼：同一个 model id 可能挂在多个供应商下，只有主进程
   * 知道这条候选的来历 —— 拼错 = 切到一个不存在的模型（静默失败：切完照旧发不出去）。
   * 类型与 `core-ts` 的 `RescuableModel` **同源**（`import type`，编译期擦除，见第 866 条注）。
   */
  rescueModel?: RescuableModel;
  error?: string;
}

/** 后台常驻：定时任务视图（ResidentPanel 消费，A-910） */
export interface ResidentJobView {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  agentId?: string;
  nextRun?: number;
  lastRun?: number;
  lastResult?: string;
  paused?: boolean;
  running?: boolean;
}

/** 后台常驻：子代理运行视图 */
export interface SubAgentRunView {
  id: string;
  name: string;
  /**
   * A-980-R31：补齐 `timeout` / `cancelled`。
   * 此前声明只有 4 态，但运行时本来就会下发超时/取消——类型在骗人，渲染层只好各自兜底，
   * 于是「超时中断」在监测栏下拉里被显示成原始英文 `timeout`（STATUS_META 缺这一项）。
   */
  status: "pending" | "running" | "done" | "fail" | "timeout" | "cancelled";
  /** A-980-R31：派发时的任务指令（详情弹窗据此回答"这次到底让它干什么"） */
  task?: string;
  /** A-980-R31：本次生效的墙钟预算（毫秒，undefined/0 = 不限时） */
  timeoutMs?: number;
  startedAt?: number;
  finishedAt?: number;
  /** 结果摘要（完整产出落盘 data/generated/subagent-*.md）；中断时保留**中断前已产出的部分** */
  result?: string;
  error?: string;
  /** 实际路由到的模型（可核验"执行档"是否真的生效） */
  model?: string;
  /** 命中的声明式定义名（自动委派审计） */
  definitionName?: string;
  /** 结构化自评（outputSchema 契约） */
  structured?: { status: string; summary: string; artifacts: string[]; confidence: number };
}

/** 后台常驻：整体快照 */
export interface ResidentState {
  scheduler: ResidentJobView[];
  subagents: SubAgentRunView[];
  /** A-942：全局子代理默认模型（api:<key>[:<model>] / local:<id> / inherit / 空=继承） */
  defaultModel?: string;
}

/** A-939 上下文分桶（引擎 done 事件携带，随 slime:chat:done 透传渲染层） */
export interface CtxBuckets {
  system: number;
  rules: number;
  memory: number;
  workspace: number;
  planning: number;
  tools: number;
  history: number;
  message: number;
}

/**
 * A-1044：**图形操作可视化**事件（主进程 → 渲染层，通道 `slime:screen:opFocus`）。
 *
 * 形状与 `core-ts/src/screen/controller.ts` 的 `OperationFocusEvent` **逐字对应**——
 * 这里只做 IPC 传输层的类型（core-ts 的类型不能直接被 renderer 的 tsconfig 引用）。
 * ⚠️ 两侧字段名必须同步改：这类"跨进程契约"漂移不会报错，只会让界面永远不亮（静默失效）。
 */
export interface OperationFocusUI {
  /** begin = 注入动作**之前**（先让用户看见"Agent 要动了"）；end = 动作结束 */
  phase: "begin" | "end";
  /** 后端 id：desktop（整机屏幕）/ android（设备） */
  backend: string;
  /** 动作种类（click / type / key / drag …） */
  action: string;
  /** 人话标签，悬浮提示直接显示（如「点击 (812, 431)」） */
  label: string;
  /** 被操作区域（**虚拟桌面/设备坐标**，不是应用内坐标）；无可信区域时 null（不画假框） */
  region: { x: number; y: number; width: number; height: number } | null;
  /** 本次是否需要让位给用户（true → 界面显示"正在等用户停手"） */
  waitingUser?: boolean;
}
