/**
 * gui/src/preload/index.ts — preload 层（v2.5/v2.6 安全基线）。
 * - contextIsolation: true / sandbox: true 环境下运行，仅可用 electron 子集 API
 * - contextBridge 唯一暴露窗口：window.slimeAPI（封装回调，不暴露原始 ipcRenderer）
 * - IPC 接收侧白名单验证由主进程 onMessage 处理完成；渲染层仅收可信类型
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type {
  StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus,
  AgentExportResult, AgentImportResult, AgentImportConflictStrategy,
  ProviderSummary, ModelSpec, ConfigOverview, LocalModelSpec, AgentDetail,
  SessionItem, ConversationMessage, SessionConfig, ApprovalMode,
  SuggestionItem, ExtrasList, MindConfigInfo, VectorTool, EmotionSnapshot, EvolutionSnapshot,
  DownloadTarget, DownloadProgressInfo, LocateDepResult, BootStatus,
  GuiPermissions, McpServerInfo, SkillInfo, ModelLoadingStatus,
  PermissionRequestUI, PermissionDecision, AskUserRequestUI, AskUserDecision, WorkspaceListResult, TermResult,
  GitDetect, GitInfo, GitAction, GitCloneResult, GitDiffResult, WorkspaceReadFileResult,
  ContextMenuItem, WorkspaceContextMenuParams, WorkspaceCreateResult,
  ResidentState, SubAgentRunView,
  CtxBuckets,
  TraceSnapshot, PlanInfo, CompressResult,
} from "../shared/ipc.js";

/** 监听 ipcRenderer 事件→回掉，自动注销；渲染层拿到 cleanup() */
function onMessage<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("slimeAPI", {
  chat: {
    stream: (input: ChatInput) => ipcRenderer.invoke("slime:chat:stream", input),
    /** A-966：done 后把该条回复的交错思考时间线回填 history.jsonl（重启保持时间线展示） */
    attachTimeline: (agentId: string, sessionId: string | undefined, timeline: unknown[]) =>
      ipcRenderer.invoke("slime:chat:attachTimeline", { agentId, sessionId, timeline }) as Promise<{ ok: boolean }>,
    /** A-161: 回滚持久化 —— 截断该会话历史到目标用户消息之前（回滚后重启不再复现旧消息） */
    truncateFrom: (agentId: string, sessionId: string | undefined, userMsg: string) =>
      ipcRenderer.invoke("slime:history:truncateFrom", { agentId, sessionId, userMsg }) as Promise<{ ok: boolean; removed?: number; error?: string }>,
    /** P0: 新对话（重置历史，返回空 OK） */
    newConversation: (agentId: string) =>
      ipcRenderer.invoke("slime:chat:new", { agentId }) as Promise<{ ok: boolean }>,
    /** P0: 重试最后一条（重发 user 消息，返回 {ok} 或 error） */
    retryLast: (agentId: string, sessionId?: string) =>
      ipcRenderer.invoke("slime:chat:retry", { agentId, sessionId }) as Promise<{ ok: boolean; error?: string }>,
    /** 主动中断当前 Agent 输出（key=sessionId ?? agentId） */
    cancel: (key: string) =>
      ipcRenderer.invoke("slime:chat:cancel", { key }) as Promise<{ ok: boolean; error?: string; active?: number }>,
    /** A-969：上下文自动压缩（GUI 发送前触发；摘要写回会话 meta，后续发送自动用摘要头+最近 N 轮） */
    compress: (sessionId: string, ratio: number) =>
      ipcRenderer.invoke("slime:chat:compress", { sessionId, ratio }) as Promise<CompressResult>,
    onChunk: (cb: (chunk: StreamChunk) => void) => onMessage<StreamChunk>("slime:chat:chunk", cb),
    onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }) => void) =>
      onMessage<{ reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }>(
        "slime:chat:done", cb,
      ),
    onError: (cb: (err: { message: string; sessionId?: string }) => void) => onMessage<{ message: string; sessionId?: string }>("slime:chat:error", cb),
    /** A-918：流终态广播（done/error/取消统一出口）——渲染层校准 per-session 流快照，防"切回仍在生成"假活跃 */
    onStreamEnded: (cb: (ev: { sessionId?: string }) => void) => onMessage<{ sessionId?: string }>("slime:chat:streamEnded", cb),
  },
  model: {
    /** 本地模型加载进度（渲染层弹出 slime 主题加载弹窗） */
    onLoading: (cb: (s: ModelLoadingStatus) => void) => onMessage<ModelLoadingStatus>("slime:model:loading", cb),
    /** 启动/重试嵌入模型（向量模型 idle/失败时在状态面板手动触发） */
    startEmbedding: () =>
      ipcRenderer.invoke("slime:model:startEmbedding") as Promise<{ ok: boolean; error?: string; state?: string }>,
  },
  conversations: {
    list: () => ipcRenderer.invoke("slime:sessions:list") as Promise<SessionItem[]>,
    load: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:load", { sessionId }) as Promise<ConversationMessage[]>,
    /** 新建会话：以目标工作文件夹为主（workspace），会话内指定调用 Agent（agentId）；memberIds=可选团队成员；type=brainstorm 群聊头脑风暴 */
    create: (opts?: { agentId?: string; title?: string; workspace?: string | null; memberIds?: string[]; type?: "normal" | "brainstorm" }) =>
      ipcRenderer.invoke("slime:sessions:create", opts) as Promise<{ ok: boolean; session?: SessionItem }>,
    /** 会话内切换调用的 Agent（保留工作文件夹/标题/历史） */
    setAgent: (sessionId: string, agentId: string) =>
      ipcRenderer.invoke("slime:sessions:setAgent", { sessionId, agentId }) as Promise<{ ok: boolean }>,
    /** A-943：切换会话模式（normal 普通 / brainstorm 群聊头脑风暴） */
    setType: (sessionId: string, type: "normal" | "brainstorm") =>
      ipcRenderer.invoke("slime:sessions:setType", { sessionId, type }) as Promise<{ ok: boolean; type?: string }>,
    /** 团队会话成员更新（组长=会话当前 agentId；空数组=退回单人会话） */
    setMembers: (sessionId: string, memberIds: string[]) =>
      ipcRenderer.invoke("slime:sessions:setMembers", { sessionId, memberIds }) as Promise<{ ok: boolean; session?: SessionItem }>,
    /** 会话级工作目录更新（以文件夹为主：绑定/更换工作文件夹） */
    setWorkspace: (sessionId: string, workspace: string | null) =>
      ipcRenderer.invoke("slime:sessions:setWorkspace", { sessionId, workspace }) as Promise<{ ok: boolean; workspace?: string }>,
    rename: (sessionId: string, title: string) =>
      ipcRenderer.invoke("slime:sessions:rename", { sessionId, title }) as Promise<{ ok: boolean }>,
    remove: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:remove", { sessionId }) as Promise<{ ok: boolean }>,
    clear: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:clear", { sessionId }) as Promise<{ ok: boolean }>,
    config: (input: { agentId: string; sessionId?: string; approval?: ApprovalMode; workspace?: string | null }) =>
      ipcRenderer.invoke("slime:sessions:config", input) as Promise<{ ok: boolean; approval: ApprovalMode; workspace: string }>,
    configGet: (input: { agentId: string; sessionId?: string }) =>
      ipcRenderer.invoke("slime:sessions:configGet", input) as Promise<SessionConfig>,
    pickFolder: () =>
      ipcRenderer.invoke("slime:sessions:pickFolder") as Promise<{ ok: boolean; path?: string; error?: string }>,
    removeAgent: (agentId: string) =>
      ipcRenderer.invoke("slime:sessions:removeAgent", { agentId }) as Promise<{ ok: boolean }>,
    /** 删除工作文件夹分组：清除该 workspace 下全部会话与历史（文件夹与 Agent 保留） */
    removeWorkspace: (workspace: string) =>
      ipcRenderer.invoke("slime:sessions:removeWorkspace", { workspace }) as Promise<{ ok: boolean; count?: number }>,
    loadTodos: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:loadTodos", { sessionId }) as Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string }> }>,
  },
  extras: {
    list: () => ipcRenderer.invoke("slime:extras:list") as Promise<ExtrasList>,
    /** 技能库状态列表（含已禁用的） */
    skillList: () => ipcRenderer.invoke("slime:extras:skillList") as Promise<SkillInfo[]>,
    /** 启用/禁用技能 */
    skillToggle: (name: string, enabled: boolean) =>
      ipcRenderer.invoke("slime:extras:skillToggle", { name, enabled }) as Promise<{ ok: boolean; error?: string }>,
    /** 打开技能目录（系统文件管理器） */
    skillOpen: (name: string) =>
      ipcRenderer.invoke("slime:extras:skillOpen", { name }) as Promise<{ ok: boolean; error?: string }>,
    /** 打开技能根目录 config/skills（系统文件管理器）——空列表引导添加 */
    skillsRootOpen: () =>
      ipcRenderer.invoke("slime:extras:skillsRootOpen") as Promise<{ ok: boolean; error?: string }>,
    /** 删除技能（递归删除目录） */
    skillDelete: (name: string) =>
      ipcRenderer.invoke("slime:extras:skillDelete", { name }) as Promise<{ ok: boolean; error?: string }>,
    /** A-918++：GUI 表单新建技能（生成 config/skills/<name>/SKILL.md） */
    skillAdd: (input: { name: string; description: string; content?: string }) =>
      ipcRenderer.invoke("slime:extras:skillAdd", input) as Promise<{ ok: boolean; error?: string; name?: string }>,
    /** A-918++：联网搜索技能市场（anthropics/skills 官方仓库） */
    skillMarketSearch: (query?: string) =>
      ipcRenderer.invoke("slime:extras:skillMarketSearch", { query }) as Promise<{ ok: boolean; skills?: Array<{ name: string; description: string }>; error?: string }>,
    /** A-918++：从官方仓库安装技能 */
    skillMarketInstall: (name: string) =>
      ipcRenderer.invoke("slime:extras:skillMarketInstall", { name }) as Promise<{ ok: boolean; error?: string; name?: string }>,
    /** A-918++：读取数据源认证（GitHub Token） */
    registryAuthGet: () =>
      ipcRenderer.invoke("slime:extras:registryAuthGet") as Promise<{ githubToken?: string }>,
    /** A-918++：保存数据源认证（GitHub Token，加密） */
    registryAuthSet: (auth: { githubToken?: string }) =>
      ipcRenderer.invoke("slime:extras:registryAuthSet", auth) as Promise<{ ok: boolean; error?: string }>,
    /** A-918++：内嵌 BrowserWindow 打开 GitHub Token 生成页 */
    openGithubAuth: () =>
      ipcRenderer.invoke("slime:extras:openGithubAuth") as Promise<{ ok: boolean; error?: string }>,
    /** MCP 服务器状态列表（含已禁用的） */
    mcpList: () => ipcRenderer.invoke("slime:extras:mcpList") as Promise<McpServerInfo[]>,
    /** 启用/禁用 MCP 服务器 */
    mcpToggle: (name: string, enabled: boolean) =>
      ipcRenderer.invoke("slime:extras:mcpToggle", { name, enabled }) as Promise<{ ok: boolean; error?: string }>,
    /** 打开 MCP 配置所在目录（slime.toml 项目根） */
    mcpOpen: () => ipcRenderer.invoke("slime:extras:mcpOpen") as Promise<{ ok: boolean; error?: string }>,
    /** 删除 MCP 服务器（从 slime.toml 移除块） */
    mcpDelete: (name: string) =>
      ipcRenderer.invoke("slime:extras:mcpDelete", { name }) as Promise<{ ok: boolean; error?: string }>,
    /** A-918++：GUI 表单新增 MCP 服务器（追加 [[mcp_servers]] 块） */
    mcpAdd: (input: { name: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; force?: boolean }) =>
      ipcRenderer.invoke("slime:extras:mcpAdd", input) as Promise<{ ok: boolean; error?: string }>,
    /** A-918++：MCP 官方 registry 联网搜索 */
    mcpRegistrySearch: (query?: string) =>
      ipcRenderer.invoke("slime:mcpRegistrySearch", { query }) as Promise<{ ok: boolean; servers?: Array<{ name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }>; error?: string }>,
    /** A-918++：从官方 registry 安装 MCP */
    mcpRegistryInstall: (card: { name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }) =>
      ipcRenderer.invoke("slime:mcpRegistryInstall", { card }) as Promise<{ ok: boolean; error?: string }>,
  },
  runtime: {
    /** A-918++：运行环境一览（node/python/git/llama/models 状态） */
    list: () => ipcRenderer.invoke("slime:runtime:list") as Promise<{
      ok: boolean; items?: Array<{
        kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string;
        action?: { label: string; kind: string; url?: string; path?: string; target?: string };
      }>; error?: string;
    }>,
    /** A-918++：缺失项动作（打开官网/目录） */
    open: (action: { label?: string; kind?: string; url?: string; path?: string }) =>
      ipcRenderer.invoke("slime:runtime:open", { action }) as Promise<{ ok: boolean; error?: string }>,
    /** A-918++：重建 Python venv（系统 Python → venv → pip install -r requirements.txt） */
    installPython: () =>
      ipcRenderer.invoke("slime:runtime:installPython") as Promise<{ ok: boolean; log?: string; error?: string }>,
  },
  files: {
    /** 导入文件对话框：返回本地路径（聊天输入区附件） */
    pick: () => ipcRenderer.invoke("slime:files:pick") as Promise<{ ok: boolean; path?: string; error?: string }>,
  },
  images: {
    /** 识图：选择图片（多选≤4）→ 主进程编码 data URL（给聊天输入区附件 / 直接发送） */
    pick: () => ipcRenderer.invoke("slime:images:pick") as Promise<{
      ok: boolean;
      images?: Array<{ name: string; mime: string; dataUrl: string }>;
      error?: string;
    }>,
  },
  permissions: {
    get: () => ipcRenderer.invoke("slime:permissions:get") as Promise<GuiPermissions>,
    set: (patch: Partial<Record<keyof GuiPermissions, unknown>>) =>
      ipcRenderer.invoke("slime:permissions:set", patch) as Promise<{ ok: boolean; permissions: GuiPermissions; error?: string }>,
  },
  perm: {
    /** 主进程 → 渲染层：权限请求（输入框位置弹出选择题 UI） */
    onRequest: (cb: (req: PermissionRequestUI) => void) => onMessage<PermissionRequestUI>("slime:perm:request", cb),
    /** 主进程 → 渲染层：权限请求超时（未收到决策，主进程已按拒绝处理）→ 渲染层收起选择题 UI */
    onTimeout: (cb: (req: { requestId: string }) => void) =>
      onMessage<{ requestId: string }>("slime:perm:timeout", cb),
    /** 渲染层 → 主进程：提交用户对权限请求的决策 */
    resolve: (decision: PermissionDecision) =>
      ipcRenderer.invoke("slime:perm:resolve", decision) as Promise<{ ok: boolean }>,
  },
  askUser: {
    /** 主进程 → 渲染层：ask_user 提问（方向分歧 / 关键决策；输入框选择题 UI） */
    onRequest: (cb: (req: AskUserRequestUI) => void) => onMessage<AskUserRequestUI>("slime:ask:request", cb),
    /** 主进程 → 渲染层：提问超时（未收到回答，主进程已按「跳过」处理）→ 渲染层收起提问 UI */
    onTimeout: (cb: (req: { requestId: string }) => void) =>
      onMessage<{ requestId: string }>("slime:ask:timeout", cb),
    /** 渲染层 → 主进程：提交用户对 ask_user 的回答 */
    resolve: (decision: AskUserDecision) =>
      ipcRenderer.invoke("slime:ask:resolve", decision) as Promise<{ ok: boolean }>,
  },
  suggest: (text: string) =>
    ipcRenderer.invoke("slime:chat:suggest", { text }) as Promise<SuggestionItem[]>,
  dialog: {
    /** 异步确认框（A-151）：主进程原生对话框，不阻塞渲染层 JS——替代 window.confirm */
    confirm: (message: string, detail?: string) =>
      ipcRenderer.invoke("slime:dialog:confirm", { message, detail }) as Promise<{ ok: boolean; confirmed: boolean; error: string | null }>,
    /** 异步提示框（A-151）：替代 window.alert */
    alert: (message: string, detail?: string) =>
      ipcRenderer.invoke("slime:dialog:alert", { message, detail }) as Promise<{ ok: boolean; error: string | null }>,
  },
  stats: {
    snapshot: () => ipcRenderer.invoke("slime:stats:snapshot") as Promise<StatsSnapshot>,
    poll: (start: boolean) => ipcRenderer.invoke("slime:stats:poll", start),
    onPoll: (cb: (snapshot: StatsSnapshot) => void) => onMessage<StatsSnapshot>("slime:stats:update", cb),
  },
  /** D：全链路可观测（引擎事件轨迹，TraceViewer 用） */
  trace: {
    get: (sessionId: string) =>
      ipcRenderer.invoke("slime:trace:get", sessionId) as Promise<TraceSnapshot | null>,
    onUpdate: (cb: (payload: { sessionId: string; trace: TraceSnapshot }) => void) =>
      onMessage<{ sessionId: string; trace: TraceSnapshot }>("slime:trace:update", cb),
  },
  /** E：Plan 一等对象（任务进度卡片 / PlanPanel 用） */
  plan: {
    get: (sessionId: string) =>
      ipcRenderer.invoke("slime:plan:get", sessionId) as Promise<PlanInfo | null>,
    onUpdate: (cb: (payload: { sessionId: string; plan: PlanInfo }) => void) =>
      onMessage<{ sessionId: string; plan: PlanInfo }>("slime:plan:update", cb),
  },
  agents: {
    list: () => ipcRenderer.invoke("slime:agents:list") as Promise<AgentInfo[]>,
    create: (name: string, role: string) =>
      ipcRenderer.invoke("slime:agents:create", { name, role }) as Promise<AgentInfo>,
    fork: (parentId: string, name: string, role: string) =>
      ipcRenderer.invoke("slime:agents:fork", { parentId, name, role }) as Promise<AgentInfo>,
    /** P0: 选中 Agent（渲染层通知主进程当前活跃 Agent） */
    select: (agentId: string) => ipcRenderer.invoke("slime:agents:select", { agentId }),
    /** 属性面板详情（完整字段，安全无敏感信息） */
    detail: (agentId: string) =>
      ipcRenderer.invoke("slime:agents:detail", { agentId }) as Promise<AgentDetail | null>,
    /** 删除 Agent（递归子树，主进程同步清理历史） */
    remove: (agentId: string) =>
      ipcRenderer.invoke("slime:agents:remove", { agentId }) as Promise<{ ok: boolean; error?: string; deleted?: string[] }>,
    /** P0: 更新 Agent 配置（model_choice / mode / reasoning_effort / show_thinking） */
    update: (agentId: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke("slime:agents:update", { agentId, patch }) as Promise<{ ok: boolean }>,
    /** P0: 监听主进程推送的选中事件（创建/分裂后自动切换） */
    onAgentSelected: (cb: (agentId: string) => void) => onMessage<string>("slime:agents:selected", cb),
    /** 身份移民协议 v1.2 §4：导出 Agent（主进程弹保存对话框） */
    exportAgent: (agentId: string) =>
      ipcRenderer.invoke("slime:agents:export", { agentId }) as Promise<AgentExportResult>,
    /** 身份移民协议 v1.2 §5：导入身份包（主进程弹打开对话框；冲突策略默认 abort） */
    importPack: (conflictStrategy?: AgentImportConflictStrategy) =>
      ipcRenderer.invoke("slime:agents:import", { conflictStrategy }) as Promise<AgentImportResult>,
  },
  sidecar: {
    status: () => ipcRenderer.invoke("slime:sidecar:status") as Promise<SidecarStatus>,
    spawn: () => ipcRenderer.invoke("slime:sidecar:spawn"),
    terminate: () => ipcRenderer.invoke("slime:sidecar:terminate"),
    onStatus: (cb: (status: SidecarStatus) => void) => onMessage<SidecarStatus>("slime:sidecar:update", cb),
  },
  window: {
    minimize: () => ipcRenderer.invoke("slime:window:minimize"),
    maximize: () => ipcRenderer.invoke("slime:window:maximize"),
    quit: () => ipcRenderer.invoke("slime:window:quit"),
    /** A-967：退出模式——直接退出 / 最小化到后台托盘常驻 */
    setExitMode: (mode: "quit" | "background") =>
      ipcRenderer.invoke("slime:window:setExitMode", mode) as Promise<{ ok: boolean; mode: "quit" | "background" }>,
    getExitMode: () =>
      ipcRenderer.invoke("slime:window:getExitMode") as Promise<{ mode: "quit" | "background" }>,
  },
  theme: {
    /** 主题切换：同步标题栏系统按钮 overlay 配色 */
    set: (theme: string) => ipcRenderer.invoke("slime:theme:set", { theme }),
  },
  providers: {
    list: () => ipcRenderer.invoke("slime:providers:list") as Promise<ProviderSummary[]>,
    fetchModels: (baseUrl: string, apiKey: string) =>
      ipcRenderer.invoke("slime:providers:fetchModels", { baseUrl, apiKey }) as Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }>,
    /** 一键刷新：用已保存的密钥重新探测上游模型列表并就地更新（无需重新填写配置） */
    refresh: (key: string) =>
      ipcRenderer.invoke("slime:providers:refresh", { key }) as Promise<{ ok: boolean; total?: number; added?: number; removed?: number; error?: string }>,
    save: (input: { key: string; api_base: string; api_key?: string; model?: string | null; api_format?: "openai" | "anthropic" | "auto"; models?: unknown[] }) =>
      ipcRenderer.invoke("slime:providers:save", input) as Promise<{ ok: boolean; error?: string }>,
    remove: (key: string) =>
      ipcRenderer.invoke("slime:providers:remove", { key }) as Promise<{ ok: boolean; error?: string }>,
    localList: () => ipcRenderer.invoke("slime:providers:localList") as Promise<LocalModelSpec[]>,
    localSave: (input: { id: string; path: string; label?: string; ctx_len?: number; gpu_layers?: number; max_output?: number; vision?: boolean }) =>
      ipcRenderer.invoke("slime:providers:localSave", input) as Promise<{ ok: boolean; error?: string }>,
    localRemove: (id: string) =>
      ipcRenderer.invoke("slime:providers:localRemove", { id }) as Promise<{ ok: boolean; error?: string }>,
    localScan: (dir: string) =>
      ipcRenderer.invoke("slime:providers:localScan", { dir }) as Promise<{ ok: boolean; models?: Array<{ path: string; label: string }>; error?: string }>,
    localPick: () =>
      ipcRenderer.invoke("slime:providers:localPick") as Promise<{ ok: boolean; path?: string; error?: string }>,
  },
  silam: {
    /** A-954：自研 SILAM 脑可用性（供应商选择面板用它决定是否展示 silam） */
    status: () => ipcRenderer.invoke("slime:silam:status") as Promise<{ enabled: boolean }>,
    /** A-963：读取某 Agent 的 SILAM 情感/成长态（fear/desire/树节点/step） */
    getState: (agentId: string) =>
      ipcRenderer.invoke("slime:silam:state", { agentId }) as Promise<{
        fear?: number; desire?: number; n_nodes?: number; step?: number; langLoaded?: boolean;
      } | null>,
  },
  config: {
    overview: () => ipcRenderer.invoke("slime:config:overview") as Promise<ConfigOverview>,
    read: (name: string) =>
      ipcRenderer.invoke("slime:config:read", { name }) as Promise<{ ok: boolean; content?: string; error?: string }>,
    write: (name: string, content: string) =>
      ipcRenderer.invoke("slime:config:write", { name, content }) as Promise<{ ok: boolean; error?: string }>,
  },
  update: {
    check: () => ipcRenderer.invoke("slime:update:check") as Promise<{ status: string; version?: string; error?: string }>,
    install: () => ipcRenderer.invoke("slime:update:install") as Promise<{ ok: boolean }>,
    onStatus: (cb: (status: { status: string; version?: string; releaseNotes?: string; error?: string }) => void) =>
      onMessage<{ status: string; version?: string; releaseNotes?: string; error?: string }>("slime:update:status", cb),
  },
  settings: {
    /** 开机自启：读取当前状态 */
    autostartGet: () =>
      ipcRenderer.invoke("slime:settings:autostart:get") as Promise<{ ok: boolean; enabled: boolean }>,
    /** 开机自启：设置开关 */
    autostartSet: (enabled: boolean) =>
      ipcRenderer.invoke("slime:settings:autostart:set", { enabled }) as Promise<{ ok: boolean; enabled: boolean; error?: string }>,
    /** 卸载 Slime：启动 NSIS 卸载器并退出应用 */
    uninstall: () =>
      ipcRenderer.invoke("slime:settings:uninstall") as Promise<{ ok: boolean; error?: string }>,
  },
  mind: {
    configGet: () => ipcRenderer.invoke("slime:mind:configGet") as Promise<MindConfigInfo>,
    configSet: (patch: { vectorTool?: VectorTool; memoryRoot?: string }) =>
      ipcRenderer.invoke("slime:mind:configSet", patch) as Promise<{ ok: boolean; vectorTool: VectorTool; memoryRoot: string }>,
    emotionGet: (agentId: string) =>
      ipcRenderer.invoke("slime:mind:emotionGet", { agentId }) as Promise<EmotionSnapshot>,
    emotionSet: (input: { agentId: string; valence: number; arousal: number; dominance: number }) =>
      ipcRenderer.invoke("slime:mind:emotionSet", input) as Promise<{ ok: boolean; emotion?: EmotionSnapshot; error?: string }>,
    evolutionGet: (agentId: string) =>
      ipcRenderer.invoke("slime:mind:evolutionGet", { agentId }) as Promise<EvolutionSnapshot>,
    bookToSkill: (name: string, content: string) =>
      ipcRenderer.invoke("slime:mind:bookToSkill", { name, content }) as Promise<{ ok: boolean; path?: string; error?: string }>,
    download: (target: DownloadTarget) =>
      ipcRenderer.invoke("slime:mind:download", { target }) as Promise<{ ok: boolean; error?: string }>,
    downloadControl: (target: DownloadTarget, action: "pause" | "cancel" | "resume") =>
      ipcRenderer.invoke("slime:mind:downloadControl", { target, action }) as Promise<{ ok: boolean }>,
    downloadSnapshot: (target: DownloadTarget) =>
      ipcRenderer.invoke("slime:mind:downloadSnapshot", { target }) as Promise<DownloadProgressInfo>,
    locateDep: (mode: "auto" | "pick", key: "llama_bin" | "model_path" | "models_dir") =>
      ipcRenderer.invoke("slime:mind:locateDep", { mode, key }) as Promise<LocateDepResult>,
    onDownloadProgress: (cb: (p: DownloadProgressInfo) => void) =>
      onMessage<DownloadProgressInfo>("slime:mind:downloadProgress", cb),
  },
  boot: {
    status: () => ipcRenderer.invoke("slime:boot:status") as Promise<BootStatus>,
    onEvent: (cb: (s: BootStatus) => void) => onMessage<BootStatus>("slime:boot:event", cb),
  },
  workspace: {
    /** 右侧栏「工作树」：列目录（root=工作根，rel=相对路径，主进程校验锚定） */
    list: (root: string, rel: string) =>
      ipcRenderer.invoke("slime:workspace:list", { root, rel }) as Promise<WorkspaceListResult>,
    /** 右侧栏「工作树」：读取文件内容（支持 text/image/binary，主进程校验锚定） */
    readFile: (root: string, rel: string) =>
      ipcRenderer.invoke("slime:workspace:readFile", { root, rel }) as Promise<WorkspaceReadFileResult>,
    /** A-173：按绝对路径读取文件（聊天消息内点击文件链接在右侧栏打开） */
    readFileAbs: (path: string) =>
      ipcRenderer.invoke("slime:workspace:readFileAbs", { path }) as Promise<WorkspaceReadFileResult>,
    /** 构建右键菜单模板（主进程侧校验路径） */
    contextmenu: (root: string, params: WorkspaceContextMenuParams) =>
      ipcRenderer.invoke("slime:workspace:contextmenu", { root, params }) as Promise<{ ok: boolean; items?: ContextMenuItem[]; error?: string }>,
    /** 新建文件/文件夹 */
    create: (params: { root: string; parentRel: string; name: string; isDir: boolean }) =>
      ipcRenderer.invoke("slime:workspace:create", params) as Promise<WorkspaceCreateResult>,
    /** 文件资源管理器：调用系统对话框选择任意文件夹作为浏览根（互通系统资源管理器） */
    pickBrowseRoot: () =>
      ipcRenderer.invoke("slime:workspace:pickBrowseRoot") as Promise<{ ok: boolean; path?: string; error?: string }>,
    /** 文件资源管理器：返回某目录的父级（"上级"逐级向上浏览） */
    getParent: (path: string) =>
      ipcRenderer.invoke("slime:workspace:getParent", { path }) as Promise<{ ok: boolean; parent?: string | null; diskRoot?: boolean; error?: string }>,
  },
  term: {
    /** 右侧栏「终端」：执行命令并返回输出 */
    exec: (cmd: string, cwd?: string) =>
      ipcRenderer.invoke("slime:term:exec", { cmd, cwd }) as Promise<TermResult>,
  },
  git: {
    /** 检测路径是否为 Git 仓库（自动关联工作目录用） */
    detect: (path: string) =>
      ipcRenderer.invoke("slime:git:detect", { path }) as Promise<GitDetect>,
    /** 初始化 Git 仓库 */
    init: (path: string) =>
      ipcRenderer.invoke("slime:git:init", { path }) as Promise<GitAction>,
    /** 读取分支 / 提交 / 状态 / 分支列表 */
    info: (path: string) =>
      ipcRenderer.invoke("slime:git:info", { path }) as Promise<GitInfo>,
    /** 提交（全量暂存后 commit） */
    commit: (path: string, message: string) =>
      ipcRenderer.invoke("slime:git:commit", { path, message }) as Promise<GitAction>,
    /** 推送 */
    push: (path: string) =>
      ipcRenderer.invoke("slime:git:push", { path }) as Promise<GitAction>,
    /** 拉取 */
    pull: (path: string) =>
      ipcRenderer.invoke("slime:git:pull", { path }) as Promise<GitAction>,
    /** 切换分支 */
    checkout: (path: string, branch: string) =>
      ipcRenderer.invoke("slime:git:checkout", { path, branch }) as Promise<GitAction>,
    /** 克隆远程仓库 */
    clone: (url: string) =>
      ipcRenderer.invoke("slime:git:clone", { url }) as Promise<GitCloneResult>,
    /** A-968：读取指定文件的变更 diff（红绿标注渲染用） */
    diff: (path: string, file: string) =>
      ipcRenderer.invoke("slime:git:diff", { path, file }) as Promise<GitDiffResult>,
    /** A-918++：git show <ref>:<rel>（FileTab diff 模式对比 Git HEAD 用） */
    showFile: (rel: string, workspace: string, ref?: string) =>
      ipcRenderer.invoke("slime:git:showFile", { rel, workspace, ref }) as Promise<{ ok: boolean; content?: string; error?: string }>,
  },
  data: {
    /** 重置本地数据（清空 Provider / Agent / 会话与历史；记忆文件保留） */
    reset: () => ipcRenderer.invoke("slime:data:reset") as Promise<{ ok: boolean; error?: string }>,
  },
  resident: {
    /** 后台常驻快照（定时任务 + 子代理，A-910） */
    state: () => ipcRenderer.invoke("slime:resident:state") as Promise<ResidentState>,
    /** 新增定时任务（写回 data/schedules.json + 运行态落盘） */
    schedulerAdd: (p: { name: string; cron: string; prompt: string; agentId?: string }) =>
      ipcRenderer.invoke("slime:resident:scheduler:add", p) as Promise<{ ok: boolean; id?: string; error?: string }>,
    /** 删除定时任务（同步从 schedules.json 移除） */
    schedulerRemove: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:remove", { id }) as Promise<{ ok: boolean }>,
    schedulerPause: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:pause", { id }) as Promise<{ ok: boolean }>,
    schedulerResume: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:resume", { id }) as Promise<{ ok: boolean }>,
    /** 立即触发一次（事件/手动） */
    schedulerTrigger: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:trigger", { id }) as Promise<{ ok: boolean }>,
    /** 派发后台子代理（fire-and-forget；结果落盘 subagent-*.md） */
    subagentSpawn: (p: { name: string; task: string; systemPrompt?: string; agentId?: string }) =>
      ipcRenderer.invoke("slime:resident:subagent:spawn", p) as Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>,
    /** 取消后台子代理（运行中 → Abort 中断；排队中 → 直接标记 cancelled） */
    subagentCancel: (id: string) =>
      ipcRenderer.invoke("slime:resident:subagent:cancel", { id }) as Promise<{ ok: boolean }>,
    /** 按 description 自动委派子代理（命中 代码审查/调研/数据分析 专家，后台并行执行） */
    subagentDelegate: (p: { task: string; agentId?: string }) =>
      ipcRenderer.invoke("slime:resident:subagent:delegate", p) as Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>,
    /** A-942：设置全局子代理默认模型（api:<key>[:<model>] / local:<id> / inherit / 空=继承） */
    subagentSetDefaultModel: (model: string) =>
      ipcRenderer.invoke("slime:resident:subagent:setDefaultModel", { model }) as Promise<{ ok: boolean; defaultModel?: string; error?: string }>,
    /** A-918+：读取用户选定的子代理（自建 agent id 列表） */
    subagentGetSelection: () =>
      ipcRenderer.invoke("slime:resident:subagent:getSelection") as Promise<{ ok: boolean; selectedAgentIds?: string[] }>,
    /** A-918+：保存用户选定的子代理（自建 agent id 列表） */
    subagentSetSelection: (selectedAgentIds: string[]) =>
      ipcRenderer.invoke("slime:resident:subagent:setSelection", { selectedAgentIds }) as Promise<{ ok: boolean; selectedAgentIds?: string[]; error?: string }>,
    /** A-918++：订阅后台实时推送（subagent start/complete/error、定时任务触发、监控状态等），返回 cleanup */
    onUpdate: (cb: (payload: unknown) => void) => onMessage<unknown>("slime:resident:update", cb),
  },
  /** A-950：群聊状态事件（成员 thinking/speaking/done + 思考增量）——群聊专属右侧栏用 */
  brainstorm: {
    onEvent: (cb: (payload: { sessionId: string; memberId: string; name: string; state?: string; chunk?: string; content?: string }) => void) =>
      onMessage<{ sessionId: string; memberId: string; name: string; state?: string; chunk?: string; content?: string }>("slime:brainstorm:event", cb),
  },
  requests: {
    /** 读请求频率配置（并发上限 / 断流重连基间隔，A-916） */
    get: () => ipcRenderer.invoke("slime:requests:get") as Promise<{ concurrency: number; reconnectBaseMs: number }>,
    set: (p: { concurrency?: number; reconnectBaseMs?: number }) =>
      ipcRenderer.invoke("slime:requests:set", p) as Promise<{ ok: boolean; concurrency?: number; reconnectBaseMs?: number; error?: string }>,
  },
  adb: {
    /** A-918++：检测 adb 是否就绪（含版本/来源） */
    detect: () => ipcRenderer.invoke("slime:adb:detect") as Promise<{ ok: boolean; path?: string; version?: string; source?: string; error?: string }>,
    /** A-918++：下载官方 platform-tools 便携包（进度经 onDownloadProgress 监听） */
    download: () => ipcRenderer.invoke("slime:adb:download") as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string; progress?: { state: string; percent: number; receivedMB: number; totalMB: number; error?: string } }>,
    /** A-918++：列出已连接设备 */
    devices: () => ipcRenderer.invoke("slime:adb:devices") as Promise<{ ok: boolean; devices?: Array<{ serial: string; state: string; model?: string; product?: string }>; error?: string }>,
    /** A-918++：无线连接设备（host 形如 192.168.1.10:5555） */
    connect: (host: string) => ipcRenderer.invoke("slime:adb:connect", { host }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：断开无线连接 */
    disconnect: (host: string) => ipcRenderer.invoke("slime:adb:disconnect", { host }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：在指定设备执行 shell 命令 */
    shell: (serial: string, command: string) => ipcRenderer.invoke("slime:adb:shell", { serial, command }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：安装 APK（serial + 本地 apk 路径） */
    install: (serial: string, apkPath: string) => ipcRenderer.invoke("slime:adb:install", { serial, apkPath }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：卸载应用（serial + 包名） */
    uninstall: (serial: string, pkg: string) => ipcRenderer.invoke("slime:adb:uninstall", { serial, pkg }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：截图（返回 PNG base64） */
    screencap: (serial: string) => ipcRenderer.invoke("slime:adb:screencap", { serial }) as Promise<{ ok: boolean; pngBase64?: string; error?: string }>,
    /** A-918++：从设备拉取文件到本地 */
    pull: (serial: string, remote: string, local: string) => ipcRenderer.invoke("slime:adb:pull", { serial, remote, local }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：推送本地文件到设备 */
    push: (serial: string, local: string, remote: string) => ipcRenderer.invoke("slime:adb:push", { serial, local, remote }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：重启设备 */
    reboot: (serial: string) => ipcRenderer.invoke("slime:adb:reboot", { serial }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    /** A-918++：下载进度监听（主进程 → 渲染层） */
    onDownloadProgress: (cb: (p: { state: string; percent: number; receivedMB: number; totalMB: number; error?: string }) => void) => onMessage<{ state: string; percent: number; receivedMB: number; totalMB: number; error?: string }>("slime:adb:downloadProgress", cb),
  },
  http: {
    /** A-918++：把本地目录作为静态服务启动（默认 0.0.0.0，端口留空自动选） */
    serve: (p: { dir: string; port?: number; host?: string; spa?: boolean }) =>
      ipcRenderer.invoke("slime:http:serve", p) as Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }>,
    /** A-918++：停止指定服务 */
    stop: (id: string) => ipcRenderer.invoke("slime:http:stop", { id }) as Promise<{ ok: boolean; error?: string }>,
    /** A-918++：停止全部服务 */
    stopAll: () => ipcRenderer.invoke("slime:http:stopAll") as Promise<{ ok: boolean; stopped: number }>,
    /** A-918++：列出运行中的服务 */
    list: () => ipcRenderer.invoke("slime:http:list") as Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>>,
    /** A-918++：用系统默认浏览器打开某个访问地址 */
    open: (url: string) => ipcRenderer.invoke("slime:http:open", { url }) as Promise<{ ok: boolean; error?: string }>,
  },
  /** A-918++：主进程通知「HTTP 生成的网页应用在右侧栏浏览器自动打开」 */
  onSidebarOpen: (cb: (payload: { kind: "url"; url: string; name?: string }) => void) =>
    onMessage<{ kind: "url"; url: string; name?: string }>("slime:sidebar:open", cb),
});

declare global {
  interface Window {
    slimeAPI: {
      chat: {
        stream: (input: ChatInput) => Promise<unknown>;
        truncateFrom: (agentId: string, sessionId: string | undefined, userMsg: string) => Promise<{ ok: boolean; removed?: number; error?: string }>;
        newConversation: (agentId: string) => Promise<{ ok: boolean }>;
        retryLast: (agentId: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
        cancel: (key: string) => Promise<{ ok: boolean; error?: string; active?: number }>;
        compress: (sessionId: string, ratio: number) => Promise<CompressResult>;
        onChunk: (cb: (chunk: StreamChunk) => void) => () => void;
        onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number }) => void) => () => void;
        onError: (cb: (err: { message: string; sessionId?: string }) => void) => () => void;
        onStreamEnded: (cb: (ev: { sessionId?: string }) => void) => () => void;
      };
      model: {
        onLoading: (cb: (s: ModelLoadingStatus) => void) => () => void;
        startEmbedding: () => Promise<{ ok: boolean; error?: string; state?: string }>;
      };
      conversations: {
        list: () => Promise<SessionItem[]>;
        load: (sessionId: string) => Promise<ConversationMessage[]>;
        create: (opts?: { agentId?: string; title?: string; workspace?: string | null; memberIds?: Array<string | { id: string; model?: string }>; leaderModel?: string; type?: "normal" | "brainstorm" }) => Promise<{ ok: boolean; session?: SessionItem }>;
        setAgent: (sessionId: string, agentId: string) => Promise<{ ok: boolean }>;
        setMembers: (sessionId: string, memberIds: string[]) => Promise<{ ok: boolean; session?: SessionItem }>;
        setWorkspace: (sessionId: string, workspace: string | null) => Promise<{ ok: boolean; workspace?: string }>;
        rename: (sessionId: string, title: string) => Promise<{ ok: boolean }>;
        remove: (sessionId: string) => Promise<{ ok: boolean }>;
        clear: (sessionId: string) => Promise<{ ok: boolean }>;
        config: (input: { agentId: string; sessionId?: string; approval?: ApprovalMode; workspace?: string | null }) => Promise<{ ok: boolean; approval: ApprovalMode; workspace: string }>;
        configGet: (input: { agentId: string; sessionId?: string }) => Promise<SessionConfig>;
        pickFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
        removeAgent: (agentId: string) => Promise<{ ok: boolean }>;
        removeWorkspace: (workspace: string) => Promise<{ ok: boolean; count?: number }>;
        loadTodos: (sessionId: string) => Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string }> }>;
      };
      extras: {
        list: () => Promise<ExtrasList>;
        skillList: () => Promise<SkillInfo[]>;
        skillToggle: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
        skillOpen: (name: string) => Promise<{ ok: boolean; error?: string }>;
        skillsRootOpen: () => Promise<{ ok: boolean; error?: string }>;
        skillDelete: (name: string) => Promise<{ ok: boolean; error?: string }>;
        skillAdd: (input: { name: string; description: string; content?: string }) => Promise<{ ok: boolean; error?: string; name?: string }>;
        skillMarketSearch: (query?: string) => Promise<{ ok: boolean; skills?: Array<{ name: string; description: string }>; error?: string }>;
        skillMarketInstall: (name: string) => Promise<{ ok: boolean; error?: string; name?: string }>;
        registryAuthGet: () => Promise<{ githubToken?: string }>;
        registryAuthSet: (auth: { githubToken?: string }) => Promise<{ ok: boolean; error?: string }>;
        openGithubAuth: () => Promise<{ ok: boolean; error?: string }>;
        mcpList: () => Promise<McpServerInfo[]>;
        mcpToggle: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
        mcpOpen: () => Promise<{ ok: boolean; error?: string }>;
        mcpDelete: (name: string) => Promise<{ ok: boolean; error?: string }>;
        mcpAdd: (input: { name: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; force?: boolean }) => Promise<{ ok: boolean; error?: string }>;
        mcpRegistrySearch: (query?: string) => Promise<{ ok: boolean; servers?: Array<{ name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }>; error?: string }>;
        mcpRegistryInstall: (card: { name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }) => Promise<{ ok: boolean; error?: string }>;
      };
      runtime: {
        list: () => Promise<{
          ok: boolean; items?: Array<{
            kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string;
            action?: { label: string; kind: string; url?: string; path?: string; target?: string };
          }>; error?: string;
        }>;
        open: (action: { label?: string; kind?: string; url?: string; path?: string }) => Promise<{ ok: boolean; error?: string }>;
        installPython: () => Promise<{ ok: boolean; log?: string; error?: string }>;
      };
      files: { pick: () => Promise<{ ok: boolean; path?: string; error?: string }> };
      images: {
        pick: () => Promise<{ ok: boolean; images?: Array<{ name: string; mime: string; dataUrl: string }>; error?: string }>;
      };
      permissions: {
        get: () => Promise<GuiPermissions>;
        set: (patch: Partial<Record<keyof GuiPermissions, unknown>>) => Promise<{ ok: boolean; permissions: GuiPermissions; error?: string }>;
      };
      perm: {
        onRequest: (cb: (req: PermissionRequestUI) => void) => () => void;
        onTimeout: (cb: (req: { requestId: string }) => void) => () => void;
        resolve: (decision: PermissionDecision) => Promise<{ ok: boolean }>;
      };
      tasks: {
        loadTodos: (sessionId: string) => Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string }> }>;
        onTodos: (cb: (data: { sessionId: string; todos: Array<{ id: string; content: string; status: string }> }) => void) => () => void;
      };
      askUser: {
        onRequest: (cb: (req: AskUserRequestUI) => void) => () => void;
        onTimeout: (cb: (req: { requestId: string }) => void) => () => void;
        resolve: (decision: AskUserDecision) => Promise<{ ok: boolean }>;
      };
      suggest: (text: string) => Promise<SuggestionItem[]>;
      stats: {
        snapshot: () => Promise<StatsSnapshot>;
        poll: (start: boolean) => Promise<{ ok: boolean }>;
        onPoll: (cb: (snapshot: StatsSnapshot) => void) => () => void;
      };
      agents: {
        list: () => Promise<AgentInfo[]>;
        create: (name: string, role: string) => Promise<AgentInfo>;
        fork: (parentId: string, name: string, role: string) => Promise<AgentInfo>;
        select: (agentId: string) => Promise<void>;
        detail: (agentId: string) => Promise<AgentDetail | null>;
        remove: (agentId: string) => Promise<{ ok: boolean; error?: string; deleted?: string[] }>;
        update: (agentId: string, patch: Record<string, unknown>) => Promise<{ ok: boolean }>;
        onAgentSelected: (cb: (agentId: string) => void) => () => void;
        exportAgent: (agentId: string) => Promise<AgentExportResult>;
        importPack: (conflictStrategy?: AgentImportConflictStrategy) => Promise<AgentImportResult>;
      };
      sidecar: {
        status: () => Promise<SidecarStatus>;
        spawn: () => Promise<void>;
        terminate: () => Promise<void>;
        onStatus: (cb: (status: SidecarStatus) => void) => () => void;
      };
      window: { minimize: () => Promise<void>; maximize: () => Promise<void>; quit: () => Promise<void>; setExitMode: (mode: "quit" | "background") => Promise<{ ok: boolean; mode: "quit" | "background" }>; getExitMode: () => Promise<{ mode: "quit" | "background" }> };
      theme: { set: (theme: string) => Promise<void> };
      providers: {
        list: () => Promise<ProviderSummary[]>;
        fetchModels: (baseUrl: string, apiKey: string) => Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }>;
        refresh: (key: string) => Promise<{ ok: boolean; total?: number; added?: number; removed?: number; error?: string }>;
        save: (input: { key: string; api_base: string; api_key?: string; model?: string | null; api_format?: "openai" | "anthropic" | "auto"; models?: unknown[] }) => Promise<{ ok: boolean; error?: string }>;
        remove: (key: string) => Promise<{ ok: boolean; error?: string }>;
        localList: () => Promise<LocalModelSpec[]>;
        localSave: (input: { id: string; path: string; label?: string; ctx_len?: number; gpu_layers?: number; max_output?: number; vision?: boolean }) => Promise<{ ok: boolean; error?: string }>;
        localRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
        localScan: (dir: string) => Promise<{ ok: boolean; models?: Array<{ path: string; label: string }>; error?: string }>;
        localPick: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      };
      config: {
        overview: () => Promise<ConfigOverview>;
        read: (name: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
        write: (name: string, content: string) => Promise<{ ok: boolean; error?: string }>;
      };
      update: {
        check: () => Promise<{ status: string; version?: string; error?: string }>;
        install: () => Promise<{ ok: boolean }>;
        onStatus: (cb: (status: { status: string; version?: string; releaseNotes?: string; error?: string }) => void) => () => void;
      };
      settings: {
        autostartGet: () => Promise<{ ok: boolean; enabled: boolean }>;
        autostartSet: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; error?: string }>;
        uninstall: () => Promise<{ ok: boolean; error?: string }>;
      };
      mind: {
        configGet: () => Promise<MindConfigInfo>;
        configSet: (patch: { vectorTool?: VectorTool; memoryRoot?: string }) => Promise<{ ok: boolean; vectorTool: VectorTool; memoryRoot: string }>;
        emotionGet: (agentId: string) => Promise<EmotionSnapshot>;
        emotionSet: (input: { agentId: string; valence: number; arousal: number; dominance: number }) => Promise<{ ok: boolean; emotion?: EmotionSnapshot; error?: string }>;
        evolutionGet: (agentId: string) => Promise<EvolutionSnapshot>;
        bookToSkill: (name: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
        download: (target: DownloadTarget) => Promise<{ ok: boolean; error?: string }>;
        downloadControl: (target: DownloadTarget, action: "pause" | "cancel" | "resume") => Promise<{ ok: boolean }>;
        downloadSnapshot: (target: DownloadTarget) => Promise<DownloadProgressInfo>;
        onDownloadProgress: (cb: (p: DownloadProgressInfo) => void) => () => void;
      };
      boot: {
        status: () => Promise<BootStatus>;
        onEvent: (cb: (s: BootStatus) => void) => () => void;
      };
      workspace: {
        list: (root: string, rel: string) => Promise<WorkspaceListResult>;
        readFile: (root: string, rel: string) => Promise<WorkspaceReadFileResult>;
        readFileAbs: (path: string) => Promise<WorkspaceReadFileResult>;
        /** 构建右键菜单模板（主进程侧校验路径） */
        contextmenu: (root: string, params: WorkspaceContextMenuParams) => Promise<{ ok: boolean; items?: ContextMenuItem[]; error?: string }>;
        /** 新建文件/文件夹 */
        create: (params: { root: string; parentRel: string; name: string; isDir: boolean }) => Promise<WorkspaceCreateResult>;
      };
      term: {
        exec: (cmd: string, cwd?: string) => Promise<TermResult>;
      };
      git: {
        detect: (path: string) => Promise<GitDetect>;
        init: (path: string) => Promise<GitAction>;
        info: (path: string) => Promise<GitInfo>;
        commit: (path: string, message: string) => Promise<GitAction>;
        push: (path: string) => Promise<GitAction>;
        pull: (path: string) => Promise<GitAction>;
        checkout: (path: string, branch: string) => Promise<GitAction>;
        clone: (url: string) => Promise<GitCloneResult>;
        diff: (path: string, file: string) => Promise<GitDiffResult>;
      };
      data: {
        reset: () => Promise<{ ok: boolean; error?: string }>;
      };
      dialog: {
        confirm: (message: string, detail?: string) => Promise<{ ok: boolean; confirmed: boolean; error: string | null }>;
        alert: (message: string, detail?: string) => Promise<{ ok: boolean; error: string | null }>;
      };
      resident: {
        state: () => Promise<ResidentState>;
        schedulerAdd: (p: { name: string; cron: string; prompt: string; agentId?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>;
        schedulerRemove: (id: string) => Promise<{ ok: boolean }>;
        schedulerPause: (id: string) => Promise<{ ok: boolean }>;
        schedulerResume: (id: string) => Promise<{ ok: boolean }>;
        schedulerTrigger: (id: string) => Promise<{ ok: boolean }>;
        subagentSpawn: (p: { name: string; task: string; systemPrompt?: string; agentId?: string }) => Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>;
        subagentCancel: (id: string) => Promise<{ ok: boolean }>;
        subagentDelegate: (p: { task: string; agentId?: string }) => Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>;
        subagentGetSelection: () => Promise<{ ok: boolean; selectedAgentIds?: string[] }>;
        subagentSetSelection: (selectedAgentIds: string[]) => Promise<{ ok: boolean; selectedAgentIds?: string[]; error?: string }>;
        onUpdate: (cb: (payload: unknown) => void) => () => void;
      };
      requests: {
        get: () => Promise<{ concurrency: number; reconnectBaseMs: number }>;
        set: (p: { concurrency?: number; reconnectBaseMs?: number }) => Promise<{ ok: boolean; concurrency?: number; reconnectBaseMs?: number; error?: string }>;
      };
      adb: {
        detect: () => Promise<{ ok: boolean; path?: string; version?: string; source?: string; error?: string }>;
        download: () => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string; progress?: { state: string; percent: number; receivedMB: number; totalMB: number; error?: string } }>;
        devices: () => Promise<{ ok: boolean; devices?: Array<{ serial: string; state: string; model?: string; product?: string }>; error?: string }>;
        connect: (host: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        disconnect: (host: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        shell: (serial: string, command: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        install: (serial: string, apkPath: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        uninstall: (serial: string, pkg: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        screencap: (serial: string) => Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
        pull: (serial: string, remote: string, local: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        push: (serial: string, local: string, remote: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        reboot: (serial: string) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        onDownloadProgress: (cb: (p: { state: string; percent: number; receivedMB: number; totalMB: number; error?: string }) => void) => () => void;
      };
      http: {
        serve: (p: { dir: string; port?: number; host?: string; spa?: boolean }) => Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }>;
        stop: (id: string) => Promise<{ ok: boolean; error?: string }>;
        stopAll: () => Promise<{ ok: boolean; stopped: number }>;
        list: () => Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>>;
        open: (url: string) => Promise<{ ok: boolean; error?: string }>;
      };
      /** A-918++：主进程通知「HTTP 生成的网页应用在右侧栏浏览器自动打开」 */
      onSidebarOpen: (cb: (payload: { kind: "url"; url: string; name?: string }) => void) => () => void;
    };
  }
}
