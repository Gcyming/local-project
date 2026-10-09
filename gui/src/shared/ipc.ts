





import type { ModelPriceTiers, PriceCurrency } from "../../../shared/gen/model-capabilities.js";

/** 数据根（skill / 配置 / 运行时状态的落盘根目录）对渲染层的只读视图。 */
export interface DataRootInfo {
  /** 本次进程实际生效的数据根 */
  root: string;
  /** 是否来自用户显式选择（false = 出厂默认） */
  custom: boolean;
  /** 出厂默认位置（供 UI 做「恢复默认」提示） */
  default: string;
  /** root 目录当前是否存在 */
  exists: boolean;
}

export const IPC_CHANNELS = {
  
  chat_stream: "slime:chat:stream",
  chat_send: "slime:chat:send",
  
  chat_new: "slime:chat:new",
  chat_retry: "slime:chat:retry",
  
  sessions_list: "slime:sessions:list",
  sessions_create: "slime:sessions:create",
  sessions_rename: "slime:sessions:rename",
  /** A-1197 · B3（L4c）：设置会话的显式运行模式（插件 mode；空串 = 清除回默认）。 */
  sessions_set_mode: "slime:sessions:setMode",
  sessions_remove: "slime:sessions:remove",
  sessions_load: "slime:sessions:load",
  sessions_clear: "slime:sessions:clear",
  sessions_config: "slime:sessions:config",
  sessions_config_get: "slime:sessions:configGet",
  sessions_pick_folder: "slime:sessions:pickFolder",
  sessions_remove_agent: "slime:sessions:removeAgent",
  sessions_remove_workspace: "slime:sessions:removeWorkspace",
  sessions_set_members: "slime:sessions:setMembers",
  

  docs_read: "slime:docs:read",
  docs_create: "slime:docs:create",
  docs_local_file: "slime:docs:local-file",
  
  docs_html_preview: "slime:docs:htmlPreview",
  

  docs_render_page: "slime:docs:renderPage",
  

  office_libreoffice_probe: "slime:office:libreofficeProbe",
  






  search_query: "slime:search:query",
  
  search_event: "slime:search:event",
  
  search_theme: "slime:search:theme",
  search_theme_get: "slime:search:themeGet",
  search_theme_report: "slime:search:themeReport",
  



  search_host_info: "slime:search:hostInfo",
  
  search_view_get: "slime:search:viewGet",
  


  search_view_changed: "slime:search:viewChanged",
  


  search_index_start: "slime:search:indexStart",
  search_index_stop: "slime:search:indexStop",
  search_index_status: "slime:search:indexStatus",
  
  search_index_crawl: "slime:search:indexCrawl",
  



  search_index_rebuild: "slime:search:indexRebuild",
  search_index_clear: "slime:search:indexClear",
  
  search_index_removeSite: "slime:search:indexRemoveSite",
  


  search_index_params_get: "slime:search:indexParamsGet",
  search_index_params_set: "slime:search:indexParamsSet",
  
  extras_list: "slime:extras:list",
  plugins_list: "slime:plugins:list",
  plugins_reload: "slime:plugins:reload",
  /* A-1197 · B1（L4b 设置贡献点）：参数只有 plugin/key/value，**刻意没有 path**
     —— 落盘路径只由 plugin.name 在主进程推导（见 core-ts/src/plugin/settings-store.ts）。 */
  plugins_settings_get: "slime:plugins:settingsGet",
  plugins_settings_set: "slime:plugins:settingsSet",
  /** A-1197 · B2（L4a）：UI 槽位声明（按需拉取；列表接口只给 uiCount）。 */
  plugins_ui: "slime:plugins:ui",
  /** A-1197 · B5（L4a page）：打开扩展自有页面（按需起 127.0.0.1 静态服务，返回 url）。 */
  plugins_page_open: "slime:plugins:pageOpen",
  /** A-1200 · B1：取某个 panel 声明的可加载 url（按需起 127.0.0.1 静态服务）。
   *  与 `plugins_page_open` 同款底子（同一个 `httpServer`、同样的目录白名单口径），
   *  区别只是**服务哪个入口**：`page` 是插件的整页，`panel` 是挂在任意区域的小块 UI。 */
  plugins_panel_open: "slime:plugins:panelOpen",
  /** A-1200 · B3：取某个**栏目**（`contributes.views`）声明的可加载 url。
   *  与 `plugins_panel_open` / `plugins_page_open` **完全同一套底子**（同一个 `httpServer`、
   *  同样的「目录白名单 = 该插件自己的目录」口径、同样的沙箱 iframe）——
   *  栏目不是新机制，只是「整块 UI」的又一种落点。 */
  plugins_view_open: "slime:plugins:viewOpen",
  /** A-1198：安装官方示例扩展（从随包 template/plugins 复制到 config/plugins；已存在则拒绝覆盖）。 */
  plugins_install_example: "slime:plugins:installExample",
  /** A-1198：统一保存扩展页的拨片 / 信任改动（一次写盘 停用名单 + trust.json，随后重扫+广播使其生效；**不退出进程**）。 */
  plugins_apply_changes: "slime:plugins:applyChanges",
  
  plugins_changed: "slime:plugins:changed",
  chat_suggest: "slime:chat:suggest",
  
  stats_snapshot: "slime:stats:snapshot",
  stats_poll: "slime:stats:poll",
  
  usage_snapshot: "slime:usage:snapshot",
  usage_clear: "slime:usage:clear",
  
  usage_recompute: "slime:usage:recompute",
  
  agent_list: "slime:agents:list",
  agent_create: "slime:agents:create",
  agent_fork: "slime:agents:fork",
  agent_select: "slime:agents:select",
  agent_detail: "slime:agents:detail",
  agent_update: "slime:agents:update",
  agent_remove: "slime:agents:remove",
  
  agent_export: "slime:agents:export",
  agent_import: "slime:agents:import",
  
  sidecar_status: "slime:sidecar:status",
  sidecar_spawn: "slime:sidecar:spawn",
  sidecar_terminate: "slime:sidecar:terminate",
  
  providers_list: "slime:providers:list",
  providers_fetch_models: "slime:providers:fetchModels",
  providers_save: "slime:providers:save",
  providers_remove: "slime:providers:remove",
  
  providers_local_list: "slime:providers:localList",
  providers_local_save: "slime:providers:localSave",
  providers_local_remove: "slime:providers:localRemove",
  providers_local_scan: "slime:providers:localScan",
  providers_local_pick: "slime:providers:localPick",
  
  config_overview: "slime:config:overview",
  config_read: "slime:config:read",
  config_write: "slime:config:write",
  
  update_check: "slime:update:check",
  update_install: "slime:update:install",
  update_status: "slime:update:status",
  
  settings_autostart_get: "slime:settings:autostart:get",
  settings_autostart_set: "slime:settings:autostart:set",
  settings_uninstall: "slime:settings:uninstall",
  
  fallback_get: "slime:fallback:get",
  fallback_set: "slime:fallback:set",
  
  llmgw_get: "slime:llmgw:get",
  llmgw_set: "slime:llmgw:set",
  llmgw_status: "slime:llmgw:status",
  llmgw_restart: "slime:llmgw:restart",
  llmgw_token_add: "slime:llmgw:token:add",
  llmgw_token_update: "slime:llmgw:token:update",
  llmgw_token_remove: "slime:llmgw:token:remove",
  llmgw_token_toggle: "slime:llmgw:token:toggle",
  
  mind_config_get: "slime:mind:configGet",
  mind_config_set: "slime:mind:configSet",
  mind_emotion_get: "slime:mind:emotionGet",
  mind_emotion_set: "slime:mind:emotionSet",
  mind_book_to_skill: "slime:mind:bookToSkill",
  mind_download: "slime:mind:download",
  mind_download_control: "slime:mind:downloadControl",
  mind_download_snapshot: "slime:mind:downloadSnapshot",
  mind_locate_dep: "slime:mind:locateDep",
  
  workspace_list: "slime:workspace:list",
  
  workspace_pick_browse_root: "slime:workspace:pickBrowseRoot",
  workspace_get_parent: "slime:workspace:getParent",
  
  shell_open_path: "slime:shell:openPath",
  term_exec: "slime:term:exec",
  
  term_profiles: "slime:term:profiles",
  




  data_root_get: "slime:dataRoot:get",
  data_root_pick: "slime:dataRoot:pick",
  data_root_set: "slime:dataRoot:set",
  data_root_reset: "slime:dataRoot:reset",
  
  agentprocs_list: "slime:agentprocs:list",
  agentprocs_stop: "slime:agentprocs:stop",
  
  agentprocs_changed: "slime:agentprocs:changed",
} as const;









export const BROWSER_SCHEMES = new Set([
  "bitbrowser", "chrome", "msedge", "edge", "firefox", "opera", "opear", "vivaldi", "brave",
  "qqbrowser", "sogou", "browser360", "360se", "360chrome", "maxthon", "baidubrowser",
  "ucbrowser", "quark",
]);


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
    



    toolId?: string;
    




    steerId?: string;
    
    args?: string;
    
    result?: string;
    
    reasoning?: string;
    
    agentId?: string;
    

    speechEnd?: boolean;
    
    failed?: boolean;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    elapsedMs?: number;
    timings?: Record<string, number>;
    message?: string;
    
    sessionId?: string;
  };
}


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
  
  source?: "plan" | "todo";
}


export interface TodoItemDTO {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  
  completedAt?: string;
}

export interface ChatInput {
  agentId: string;
  message: string;
  history?: unknown[];
  maxTokens?: number;
  resumeSeq?: number;
  
  sessionId?: string;
  
  networkEnabled?: boolean;
  
  images?: string[];
}


export interface ModelLoadingStatus {
  loading: boolean;
  message?: string;
  
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


export interface ToolProfileDTO {
  

  mode: "default" | "creator" | "custom";
  
  skills: string[];
  
  mcp: string[];
}


export interface SessionItem {
  sessionId: string;
  agentId: string;
  agentName: string;
  
  workspace?: string;
  title: string;
  count: number;
  lastTime: string;
  
  memberIds?: string[];
  
  memberNames?: string[];
  
  memberModels?: Record<string, string>;  
  leaderModel?: string;
  
  memberEfforts?: Record<string, string>;
  
  leaderEffort?: string;
  
  type?: "normal" | "brainstorm";
  /** A-1197 · B3（L4c）：会话的显式运行模式（= 提供 mode 的插件名；缺省 = 默认 agent-loop）。 */
  mode?: string;
}


export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
  
  ts?: string;
  
  reasoning?: string;
  
  elapsedMs?: number;
  
  timeline?: Array<{ kind: string; text?: string; name?: string; label?: string; detail?: string; result?: string }>;
  
  agentName?: string;
  
  agentId?: string;
  

  failed?: boolean;
}



export type ApprovalMode = "manual" | "auto" | "none" | "custom";


export interface PermissionOption {
  id: string;
  label: string;
  
  hint: string;
  
  customPlaceholder?: string;
}


export interface PermissionRequestUI {
  requestId: string;
  agentId: string;
  agentName: string;
  
  taskDescription: string;
  actions: Array<{ action: string; target: string; level: number }>;
  
  options: PermissionOption[];
  
  sessionId?: string;
  /** A-1198：可选长文本详情（git_commit 差异评审的 diff stat + 关键片段；弹窗内滚动展示）。 */
  detail?: string;
}


export interface PermissionDecision {
  requestId: string;
  approved: boolean;
  
  reason: string;
  
  alwaysAllow: boolean;
}


export interface AskUserRequestUI {
  requestId: string;
  agentId: string;
  agentName: string;
  
  question: string;
  
  header?: string;
  
  options: string[];
  
  consequences?: string[];
  
  recommendation?: number;
  
  sessionId?: string;
}


export interface AskUserDecision {
  requestId: string;
  
  answer: string;
  
  skipped: boolean;
  
  choice?: string;
  
  cancelled?: boolean;
}

export interface AskUserCancelNotice {
  requestId: string;
  
  reason: string;
}


export interface GuiPermissions {
  globalApproval: ApprovalMode;
  
  approvalAllowPaths: string[];
  toolRead: boolean;
  toolWrite: boolean;
  
  toolTerminal: boolean;
  
  screenEnabled: boolean;
  mcpEnabled: boolean;
  skillsEnabled: boolean;
}


export interface SessionConfig {
  approval: ApprovalMode;
  workspace: string;
}


export interface SuggestionItem {
  content: string;
  agentName: string;
  time: string;
}


export interface ExtrasList {
  skills: Array<{ name: string; description: string }>;
  mcpTools: Array<{ name: string; description: string }>;
}



export interface PluginRejectedDTO {
  dir: string;
  errors: string[];
}

export interface PluginSnapshotDTO {
  plugins: PluginSummaryDTO[];
  rejected: PluginRejectedDTO[];
}

/** A-1197 · B1：单个设置项回渲染层的形状。
 *  ⚠️ `secret: true` 的项**只会有 `hasValue`，永远不会有 `value`** —— 主进程不提供读明文的通道。 */
export interface PluginSettingItemDTO {
  key: string;
  label: string;
  type: string;
  hint?: string;
  options?: string[];
  min?: number;
  max?: number;
  root?: string;
  secret: boolean;
  default?: unknown;
  value?: unknown;
  hasValue?: boolean;
}

export interface PluginSettingsDTO {
  plugin: string;
  items: PluginSettingItemDTO[];
  /** 设置文件损坏 / 落盘值不再合法等告警（**如实上抛，不静默当空配置**） */
  warnings: string[];
}

export interface PluginSettingsWriteDTO {
  ok: boolean;
  error?: string;
  dto?: PluginSettingsDTO;
  warnings?: string[];
}

export interface PluginSummaryDTO {

  name: string;
  description: string;
  version: string;
  origin: string;
  contributions: string[];
  tools: string[];
  modules: string[];
  unloadable: boolean;
  status: string;
  error?: string;
  dir: string;
  /** A-1197 · B1：该插件**声明**了多少个设置项（0/ 缺省 = 不声明）。
   *  刻意只给「声明条数」而不是直接塞值 —— 值按需拉（`plugins_settings_get`），
   *  免得每次列插件都去读每个插件目录里的设置文件。 */
  settingsCount?: number;
  /** A-1197 · B2：该插件**声明**了多少条 UI 槽位（0/ 缺省 = 不声明）。
   *  同理只给计数，明细按需拉（`plugins_ui`）。 */
  uiCount?: number;
  /** A-1197 · B4：该插件**声明**了多少个可执行脚本（0/ 缺省 = 不声明）。 */
  scriptCount?: number;
  /** A-1197 · B4：该插件的脚本是否已被用户信任（读 `trust.json`；默认拒绝）。 */
  trusted?: boolean;
  /** A-1197 · B3：该插件是否提供运行模式（`provides: ["mode"]`）+ 展示名（下拉数据源）。 */
  hasMode?: boolean;
  modeTitle?: string;
}

/** A-1197 · B2（L4a）：一条已接线的 UI 槽位声明（渲染层按它渲染；`冲突` 项禁用）。 */
export interface PluginUiSlotDTO {
  slot: string;
  plugin: string;
  id: string;
  /** A-1200 · B1：贡献形态（`item` = 宿主渲染；`panel` = 扩展自带 HTML）。
   *  缺省按 `item` 处理（老 DTO 兼容），但主进程快照一律显式带上 —— 渲染层要靠它分派。 */
  kind?: string;
  /** 仅 `kind: "panel"`：**纯相对**入口（清单层已 fail-closed 校验过 `..`/盘符/前导分隔符）。
   *  渲染层**不自己拼 url** —— 调 `plugins_panel_open` 由主进程起服务并给出绝对 url。 */
  entry?: string;
  title?: string;
  label?: string;
  icon?: string;
  order?: number;
  refresh?: string;
  when?: string;
  /** 跨插件「同 slot 同 id」冲突时标 true —— 渲染成禁用态并显示冲突原因（不静默丢弃）。 */
  conflict?: boolean;
}

/** A-1198 · 主题贡献点（皮肤）：一条已接线的主题声明（渲染层按它落 CSS 变量；卸载即消失）。 */
export interface PluginThemeDTO {
  plugin: string;
  /** A-1200 · B2：**同一插件内区分第几套**的稳定键（= 皮肤名）。
   *  ⚠️ 不能只用 `plugin` —— 一个插件多套皮肤时会全部撞成同一个 key（外观页两套皮肤
   *  互相串台，且持久化选择分不清"选的是哪一套"）。 */
  id: string;
  name: string;
  /** 白名单设计令牌（解析已 fail-closed 校验；渲染层只需落值，无需再验）。 */
  tokens: import("../../../core-ts/src/plugin/contributes.js").PluginThemeTokens;
}

/** A-1198 · 续：扩展 CSS 外观声明（已在 core-ts fail-closed 校验；渲染层负责包 @layer + 作用域）。 */
export interface PluginCssDTO {
  plugin: string;
  name: string;
  /** 纯 CSS 文本（静态禁令已在解析阶段拒掉：外联/@font-face/!important/全局选择器/position:fixed 等）。 */
  css: string;
}

/** A-1200 · B3：**插件自有栏目**的一条已接线声明（渲染层按 `placement` 挂到三个落点之一）。
 *  与 `PluginUiSlotDTO` 是**两种贡献形态**，不是同一件事的两个名字。 */
export interface PluginViewDTO {
  plugin: string;
  /** 同插件内唯一；跨插件「同 placement 同 id」冲突时标 `conflict`（渲染成禁用态）。 */
  id: string;
  /** 栏目展示名（清单层必填校验过；入口要显示它）。 */
  title: string;
  /** **纯相对**入口（清单层已 fail-closed 校验过 `..`/盘符/前导分隔符）。
   *  渲染层**不自己拼 url** —— 调 `plugins_view_open` 由主进程起服务并给出绝对 url。 */
  entry: string;
  /** 落点：`main`（主区整块视图）/ `right`（右栏 tab）/ `left`（左栏栏目块）。 */
  placement: import("../../../core-ts/src/plugin/contributes.js").PluginViewPlacement;
  icon?: string;
  order?: number;
  conflict?: boolean;
}

export interface PluginUiSnapshotDTO {
  slots: PluginUiSlotDTO[];
  /** A-1198：可用的扩展皮肤（空数组 = 没有插件声明 theme）。 */
  themes: PluginThemeDTO[];
  /** A-1198 · 续：可用的扩展 CSS 外观（空数组 = 没有插件声明 contributes.css）。 */
  cssStyles: PluginCssDTO[];
  /** A-1200 · B3：**插件自有栏目**（整块功能区；空数组 = 没有插件声明 contributes.views）。
   *  ⚠️ 与 `slots` 的根本差别：slot 是「在宿主既有区域里放小组件的插入点」，
   *     view 是「插件开辟自己的功能区 + 独立入口」（主区 / 右栏 tab / 左栏栏目块）。 */
  views: PluginViewDTO[];
  warnings: string[];
}


export interface AgentDetail {
  id: string;
  name: string;
  role: string;
  model_choice: string;
  mode: string;
  reasoning_effort: string;
  
  show_thinking?: string;
  max_context?: number;
  max_output?: number;
  lifecycle: string;
  
  tool_profile?: ToolProfileDTO;
  




  subagent_dispatch?: boolean;
}

export interface StatsSnapshot {
  servers: Array<{ role: string; port: number; state: string; model: string; vram: number; error?: string }>;
  agents: { total: number; roots: number; leaves: number; byLifecycle: Record<string, number>; maxDepth: number };
  sessions: { totalRecords: number; recent: number };
  alarms: Array<{ seq: number; severity: string; source: string; message: string; timestamp: string }>;
  timestamp: string;
}



export interface LlmGatewayTokenDTO {
  key: string;
  label?: string;
  active?: boolean;
  
  ratePerMin?: number;
  
  dailyQuota?: number;
  
  models?: string[];
  note?: string;
}

export interface LlmGatewayConfigDTO {
  enabled: boolean;
  port: number;
  apiKey: string;
  tokens: LlmGatewayTokenDTO[];
}

export interface LlmGatewayNewTokenDTO {
  label?: string;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}

export interface LlmGatewayUpdateTokenDTO {
  key: string;
  label?: string;
  active?: boolean;
  ratePerMin?: number;
  dailyQuota?: number;
  models?: string[];
  note?: string;
}

export interface LlmGatewayTokenOpResultDTO {
  ok: boolean;
  token?: LlmGatewayTokenDTO;
  restarted?: boolean;
  error?: string;
  status?: LlmGatewayStatusDTO;
  tokens?: LlmGatewayTokenDTO[];
}

export interface LlmGatewayStatusDTO {
  ok: boolean;
  running: boolean;
  port: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  error?: string;
  
  tokenCount?: number;
}


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
  
  tzOffsetMin: number;
  totalRecords: number;
  










  modelCurrencies?: Record<string, PriceCurrency>;
}


export interface UsageRecomputeResult {
  ok: boolean;
  
  updated: number;
  
  scanned: number;
  
  totalCostUsd: number;
  




  unpriced: number;
  




  unpricedModels: string[];
  




  tiered: number;
}

export type SidecarStatus = {
  running: boolean;
  port?: number;
  model?: string;
  vram?: number;
  pid?: number;
};


export interface AgentExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}


export type AgentImportConflictStrategy = "abort" | "overwrite" | "keep-old";


export interface AgentImportResult {
  ok: boolean;
  agentId?: string;
  agentName?: string;
  error?: string;
  warnings?: string[];
}



export interface ModelSpec {
  id: string;
  context_window?: number;
  max_output?: number;
  vision?: boolean;
  thinking?: boolean;
  thinking_efforts?: string[];
  
  selected?: boolean;
  price_in_usd?: number;
  price_out_usd?: number;
  
  price_cache_read_usd?: number;
  
  price_cache_write_usd?: number;
  



  price_source?: "upstream" | "table" | "manual";
  







  price_tiers?: ModelPriceTiers;
  










  price_currency?: PriceCurrency;
  




  pricing_time_tiers_candidate?: ModelPriceTiers;
  
  pricing_context_tiers?: Array<{ fromInputTokens?: number; prompt?: number; completion?: number }>;
  
  pricing_per_request?: { request?: number; image?: number; webSearch?: number; internalReasoning?: number; audio?: number };
  
  api_format?: "openai" | "anthropic" | "responses" | "google" | "auto";
  






  rpm?: number;
}


export interface ProviderSummary {
  key: string;
  api_base: string;
  has_key: boolean;
  key_hint: string;
  model: string | null;
  api_format: "openai" | "anthropic" | "responses" | "google" | "auto";
  models: ModelSpec[];
  
  rpm?: number;
}







export interface LocalModelSpec {
  id: string;
  path: string;
  label?: string;
  ctx_len?: number;
  gpu_layers?: number;
  max_output?: number;
  vision?: boolean;
}



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
  
  enabled: boolean;
  


  origin: string;
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




export type VectorTool = "bge" | "basic";


export interface MindDeps {
  llamaBin: string;
  bgeModel: string;
  localModelsDir: string;
  ok: { llamaBin: boolean; bgeModel: boolean; localModelsDir: boolean };
}


export interface MindConfigInfo {
  vectorTool: VectorTool;
  memoryRoot: string;
  




  lancedb: { ok: boolean; dir?: string; error?: string; candidates: string[] };  





  memoryPaths: { memoryJson: string; lanceDir: string } | null;
  deps: MindDeps;
}


export interface LocateDepResult {
  found: boolean;
  written?: boolean;
  deps: MindDeps;
}


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


export type DownloadTarget = "llama" | "bge";

export type DownloadState = "idle" | "downloading" | "paused" | "done" | "error";


export type DownloadPhase = "download" | "extract" | "config" | "done";


export interface BootStatus {
  phase: "starting" | "backend" | "ready" | "degraded";
  
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
  
  phase: DownloadPhase;
  
  detail: string;
}







export interface AdbDownloadProgressInfo {
  state: "downloading" | "extracting" | "done" | "error";
  percent: number;
  receivedMB: number;
  totalMB: number;
  error?: string;
  
  detail?: string;
}



export interface WorkspaceEntry {
  name: string;
  
  rel: string;
  isDir: boolean;
  size: number;
}


export interface WorkspaceListResult {
  ok: boolean;
  entries?: WorkspaceEntry[];
  error?: string;
}









export type FileMime = "text" | "docText" | "image" | "binary" | "pdf" | "office";


export interface WorkspaceReadFileResult {
  ok: boolean;
  path?: string;
  name?: string;
  content?: string;
  
  mime?: FileMime;
  
  truncated?: boolean;
  error?: string;
}


export interface TermResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  
  encoding?: string;
  




  looseEncoding?: boolean;
  
  profileId?: string;
  








  notice?: string;
  






  cwd?: string;
  error?: string;
}











import type { TermProfile } from "../../../core-ts/src/terminal/profiles.js";
export type { TermProfile, TermProfileKind } from "../../../core-ts/src/terminal/profiles.js";








export type TermProfilesResult =
  | { ok: true; profiles: TermProfile[]; defaultId: string | null }
  | { ok: false; error: string };









import type { AgentProcEntry, AgentProcView } from "../../../core-ts/src/services/agentProcs.js";
export type { AgentProcEntry, AgentProcView } from "../../../core-ts/src/services/agentProcs.js";






import type { RescuableModel } from "../../../core-ts/src/services/context_loop.js";






export type { SidebarOpenRequest, SidebarOpenKind } from "../../../core-ts/src/sidebarOpen.js";







export type { UndoPlan as FileUndoPlan, UndoResult as FileUndoResult } from "../../../core-ts/src/services/file_undo.js";



export type AgentProcsListResult =
  | { ok: true; view: AgentProcView }
  | { ok: false; error: string };


export interface AgentProcsStopRequest { kind: string; id?: string }


export interface AgentProcsStopResult {
  ok: boolean;
  
  detail?: string;
  error?: string;
}


export type AgentProcRow = AgentProcEntry;


export interface ContextMenuItem {
  
  label: string;
  
  action: string;
  
  accelerator?: string;
  
  disabled?: boolean;
  
  type?: "separator";
}


export interface WorkspaceContextMenuParams {
  
  isDir: boolean;
  
  rel: string;
  
  name: string;
  
  size: number;
}


export interface WorkspaceCreateItemParams {
  root: string;
  parentRel: string;
  name: string;
  isDir: boolean;
}


export interface WorkspaceCreateResult {
  ok: boolean;
  rel?: string;
  error?: string;
}




export interface GitCommitItem {
  hash: string;
  message: string;
  time: string;
}


export interface GitStatusInfo {
  
  staged: string[];
  
  modified: string[];
  
  untracked: string[];
  
  deleted: string[];
}


export interface GitInfo {
  ok: boolean;
  branch?: string;
  commits?: GitCommitItem[];
  status?: GitStatusInfo;
  branches?: string[];
  
  ahead?: number;
  
  behind?: number;
  error?: string;
}


export interface GitDetect {
  ok: boolean;
  isRepo: boolean;
  
  root?: string;
  branch?: string;
  
  notExists?: boolean;
  error?: string;
}


export interface GitAction {
  ok: boolean;
  error?: string;
}


export interface GitCloneResult {
  ok: boolean;
  path?: string;
  error?: string;
}




export interface GitDiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}


export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}


export interface GitDiffFile {
  
  file: string;
  
  status: "modified" | "untracked" | "deleted";
  additions: number;
  deletions: number;
  hunks: GitDiffHunk[];
}


export interface GitDiffResult {
  ok: boolean;
  files?: GitDiffFile[];
  error?: string;
}








export interface NotifyConfigDTO {
  
  enabled: boolean;
  
  soundEnabled: boolean;
  
  soundFile: string | null;
  
  soundName: string | null;
}




export interface FallbackPoolEntryDTO {
  provider: string;
  model: string;
}











export interface FallbackPoolConfigDTO {
  entries: FallbackPoolEntryDTO[];
}






export interface UpdateStatusDTO {
  status: "checking" | "downloading" | "downloaded" | "error" | "available" | "up-to-date" | "skipped" | "disabled";
  version?: string;
  releaseNotes?: string;
  error?: string;
  
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}



export interface CompressResult {
  ok: boolean;
  
  skipped?: boolean;
  



  reason?: string;
  




  cannotFit?: boolean;
  
  truncated?: boolean;
  
  summary?: string;
  
  comprehend?: string;
  
  dropped?: number;
  
  used?: number;
  
  cap?: number;
  



  tokensAfter?: number;
  
  stillOverflow?: boolean;
  
  realShrink?: boolean;
  
  elided?: number;
  




  summaryTruncated?: boolean;
  
  stale?: boolean;
  
  breakerOpen?: boolean;
  







  rescueHint?: string;
  








  rescueModel?: RescuableModel;
  error?: string;
}


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


export interface SubAgentRunView {
  id: string;
  name: string;
  




  status: "pending" | "running" | "done" | "fail" | "timeout" | "cancelled";
  
  task?: string;
  
  timeoutMs?: number;
  startedAt?: number;
  finishedAt?: number;
  
  result?: string;
  error?: string;
  
  model?: string;
  
  definitionName?: string;
  
  structured?: { status: string; summary: string; artifacts: string[]; confidence: number };
}


export interface ResidentState {
  scheduler: ResidentJobView[];
  subagents: SubAgentRunView[];
  
  defaultModel?: string;
  
  defaultModels?: string[];
}


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








export interface OperationFocusUI {
  
  phase: "begin" | "end";
  
  backend: string;
  
  action: string;
  
  label: string;
  
  region: { x: number; y: number; width: number; height: number } | null;
  
  waitingUser?: boolean;
}
