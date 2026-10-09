





import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from "electron";
import type {
  StreamChunk, ChatInput, AgentInfo, StatsSnapshot, UsageSnapshot, UsageRecomputeResult, SidecarStatus,
  LlmGatewayConfigDTO, LlmGatewayStatusDTO, LlmGatewayNewTokenDTO,
  LlmGatewayUpdateTokenDTO, LlmGatewayTokenOpResultDTO,
  AgentExportResult, AgentImportResult, AgentImportConflictStrategy,
  ProviderSummary, ModelSpec, ConfigOverview, LocalModelSpec, AgentDetail,
  SessionItem, ConversationMessage, SessionConfig, ApprovalMode,
  SuggestionItem, ExtrasList, MindConfigInfo, VectorTool, EmotionSnapshot, EvolutionSnapshot,
  DownloadTarget, DownloadProgressInfo, LocateDepResult, BootStatus, AdbDownloadProgressInfo,
  GuiPermissions, McpServerInfo, SkillInfo, ModelLoadingStatus, PluginSnapshotDTO,
  PluginSettingsDTO, PluginSettingsWriteDTO, PluginUiSnapshotDTO,
  PermissionRequestUI, PermissionDecision, AskUserRequestUI, AskUserDecision, AskUserCancelNotice, WorkspaceListResult, TermResult,
  TermProfilesResult,
  AgentProcsListResult, AgentProcsStopResult,
  GitDetect, GitInfo, GitAction, GitCloneResult, GitDiffResult, WorkspaceReadFileResult,
  ContextMenuItem, WorkspaceContextMenuParams, WorkspaceCreateResult,
  ResidentState, SubAgentRunView,
  CtxBuckets,
  TraceSnapshot, PlanInfo, CompressResult,
  ToolProfileDTO,
  NotifyConfigDTO,
  FallbackPoolEntryDTO,
  UpdateStatusDTO,
  OperationFocusUI,
  DataRootInfo,
} from "../shared/ipc.js";

import type { SidebarOpenRequest } from "../shared/ipc.js";

import type { FileUndoPlan, FileUndoResult } from "../shared/ipc.js";
import type { SidebarSearchView } from "../shared/searchView.js";


function onMessage<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("slimeAPI", {
  chat: {
    stream: (input: ChatInput) => ipcRenderer.invoke("slime:chat:stream", input),
    
    attachTimeline: (agentId: string, sessionId: string | undefined, timeline: unknown[]) =>
      ipcRenderer.invoke("slime:chat:attachTimeline", { agentId, sessionId, timeline }) as Promise<{ ok: boolean }>,
    
    truncateFrom: (agentId: string, sessionId: string | undefined, userMsg: string) =>
      ipcRenderer.invoke("slime:history:truncateFrom", { agentId, sessionId, userMsg }) as Promise<{ ok: boolean; removed?: number; error?: string }>,
    
    newConversation: (agentId: string) =>
      ipcRenderer.invoke("slime:chat:new", { agentId }) as Promise<{ ok: boolean }>,
    
    retryLast: (agentId: string, sessionId?: string) =>
      ipcRenderer.invoke("slime:chat:retry", { agentId, sessionId }) as Promise<{ ok: boolean; error?: string }>,
    
    cancel: (key: string) =>
      ipcRenderer.invoke("slime:chat:cancel", { key }) as Promise<{ ok: boolean; error?: string; active?: number }>,
    






    steer: (sessionId: string, id: number | string, text: string) =>
      ipcRenderer.invoke("slime:chat:steer", { sessionId, id: String(id), text }) as Promise<{ ok: boolean; pending?: number; error?: string }>,
    


    dismissSteer: (sessionId: string, id: number | string) =>
      ipcRenderer.invoke("slime:chat:steer:dismiss", { sessionId, id: String(id) }) as Promise<{ ok: boolean; dropped?: boolean }>,
    
    isActive: (key: string) =>
      ipcRenderer.invoke("slime:chat:isActive", { key }) as Promise<{ active: boolean }>,
    



    compress: (sessionId: string, ratio: number, used?: number, force?: boolean) =>
      ipcRenderer.invoke("slime:chat:compress", { sessionId, ratio, used, force }) as Promise<CompressResult>,
    onChunk: (cb: (chunk: StreamChunk) => void) => onMessage<StreamChunk>("slime:chat:chunk", cb),
    onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }) => void) =>
      onMessage<{ reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number; ctxBuckets?: CtxBuckets }>(
        "slime:chat:done", cb,
      ),
    onError: (cb: (err: { message: string; sessionId?: string }) => void) => onMessage<{ message: string; sessionId?: string }>("slime:chat:error", cb),
    
    onStreamEnded: (cb: (ev: { sessionId?: string }) => void) => onMessage<{ sessionId?: string }>("slime:chat:streamEnded", cb),
  },
  
  browser: {
    onCommand: (cb: (cmd: { id: string; kind: string } & Record<string, unknown>) => void) =>
      onMessage<{ id: string; kind: string } & Record<string, unknown>>("slime:browser:command", cb),
    sendResult: (payload: { id: string; ok: boolean; data?: unknown; error?: string }) =>
      ipcRenderer.send("slime:browser:result", payload),
    
    onPopupNotice: (cb: (p: { url: string; ts: number; kind?: string; scheme?: string }) => void) =>
      onMessage<{ url: string; ts: number; kind?: string; scheme?: string }>("slime:browser:popup-notice", cb),
  },
  
  protocol: {
    open: (url: string) =>
      ipcRenderer.invoke("slime:protocol:open", url) as Promise<{ ok?: boolean; url?: string; scheme?: string; handler?: string; reason?: string }>,
  },
  model: {
    
    onLoading: (cb: (s: ModelLoadingStatus) => void) => onMessage<ModelLoadingStatus>("slime:model:loading", cb),
    
    startEmbedding: () =>
      ipcRenderer.invoke("slime:model:startEmbedding") as Promise<{ ok: boolean; error?: string; state?: string }>,
  },
  conversations: {
    list: () => ipcRenderer.invoke("slime:sessions:list") as Promise<SessionItem[]>,
    load: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:load", { sessionId }) as Promise<ConversationMessage[]>,
    
    loadEarlier: (payload: { sessionId: string; beforeTs: string; limit?: number }) =>
      ipcRenderer.invoke("slime:sessions:loadEarlier", payload) as Promise<{ messages: ConversationMessage[]; hasMore: boolean }>,
    
    create: (opts?: { agentId?: string; title?: string; workspace?: string | null; memberIds?: string[]; type?: "normal" | "brainstorm" }) =>
      ipcRenderer.invoke("slime:sessions:create", opts) as Promise<{ ok: boolean; session?: SessionItem }>,
    
    setAgent: (sessionId: string, agentId: string) =>
      ipcRenderer.invoke("slime:sessions:setAgent", { sessionId, agentId }) as Promise<{ ok: boolean }>,
    
    setType: (sessionId: string, type: "normal" | "brainstorm") =>
      ipcRenderer.invoke("slime:sessions:setType", { sessionId, type }) as Promise<{ ok: boolean; type?: string }>,
    /* A-1197 · B3（L4c）：设置会话的显式运行模式（插件 mode；空串 = 清除回默认）。 */
    setMode: (sessionId: string, mode: string) =>
      ipcRenderer.invoke("slime:sessions:setMode", { sessionId, mode }) as Promise<{ ok: boolean; mode?: string; error?: string }>,
    
    setMembers: (sessionId: string, memberIds: string[]) =>
      ipcRenderer.invoke("slime:sessions:setMembers", { sessionId, memberIds }) as Promise<{ ok: boolean; session?: SessionItem }>,
    
    setMemberEffort: (sessionId: string, memberId: string, effort: string | null) =>
      ipcRenderer.invoke("slime:sessions:setMemberEffort", { sessionId, memberId, effort }) as Promise<{ ok: boolean; memberEfforts?: Record<string, string>; leaderEffort?: string }>,
    
    setWorkspace: (sessionId: string, workspace: string | null) =>
      ipcRenderer.invoke("slime:sessions:setWorkspace", { sessionId, workspace }) as Promise<{ ok: boolean; workspace?: string }>,
    


    setModelChoice: (sessionId: string, modelChoice: string | null) =>
      ipcRenderer.invoke("slime:sessions:setModelChoice", { sessionId, modelChoice }) as Promise<{ ok: boolean; modelChoice?: string | null }>,
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
    
    removeWorkspace: (workspace: string) =>
      ipcRenderer.invoke("slime:sessions:removeWorkspace", { workspace }) as Promise<{ ok: boolean; count?: number }>,
    loadTodos: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:loadTodos", { sessionId }) as Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }>,
  },
  








  tasks: {
    loadTodos: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:loadTodos", { sessionId }) as Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }>,
    onTodos: (cb: (data: { sessionId: string; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }) => void) =>
      onMessage<{ sessionId: string; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }>("slime:tasks:todos", cb),
    







    saveTodos: (sessionId: string, todos: Array<{ id: string; content: string; status: string; completedAt?: string }>) =>
      ipcRenderer.invoke("slime:tasks:saveTodos", { sessionId, todos }) as Promise<{ ok: boolean; todos?: Array<{ id: string; content: string; status: string; completedAt?: string }>; error?: string }>,
    
    clearTodos: (sessionId: string) =>
      ipcRenderer.invoke("slime:tasks:clearTodos", { sessionId }) as Promise<{ ok: boolean }>,
  },
  extras: {
    list: () => ipcRenderer.invoke("slime:extras:list") as Promise<ExtrasList>,
    
    skillList: () => ipcRenderer.invoke("slime:extras:skillList") as Promise<SkillInfo[]>,
    
    skillToggle: (name: string, enabled: boolean) =>
      ipcRenderer.invoke("slime:extras:skillToggle", { name, enabled }) as Promise<{ ok: boolean; error?: string }>,
    
    skillOpen: (name: string) =>
      ipcRenderer.invoke("slime:extras:skillOpen", { name }) as Promise<{ ok: boolean; error?: string }>,
    
    skillsRootOpen: () =>
      ipcRenderer.invoke("slime:extras:skillsRootOpen") as Promise<{ ok: boolean; error?: string }>,
    
    skillDelete: (name: string) =>
      ipcRenderer.invoke("slime:extras:skillDelete", { name }) as Promise<{ ok: boolean; error?: string }>,
    
    skillAdd: (input: { name: string; description: string; content?: string }) =>
      ipcRenderer.invoke("slime:extras:skillAdd", input) as Promise<{ ok: boolean; error?: string; name?: string }>,
    
    skillMarketSearch: (query?: string) =>
      ipcRenderer.invoke("slime:extras:skillMarketSearch", { query }) as Promise<{ ok: boolean; skills?: Array<{ name: string; description: string }>; error?: string }>,
    
    skillMarketInstall: (name: string) =>
      ipcRenderer.invoke("slime:extras:skillMarketInstall", { name }) as Promise<{ ok: boolean; error?: string; name?: string }>,
    
    registryAuthGet: () =>
      ipcRenderer.invoke("slime:extras:registryAuthGet") as Promise<{ githubToken?: string }>,
    
    registryAuthSet: (auth: { githubToken?: string }) =>
      ipcRenderer.invoke("slime:extras:registryAuthSet", auth) as Promise<{ ok: boolean; error?: string }>,
    
    openGithubAuth: () =>
      ipcRenderer.invoke("slime:extras:openGithubAuth") as Promise<{ ok: boolean; error?: string }>,
    
    mcpList: () => ipcRenderer.invoke("slime:extras:mcpList") as Promise<McpServerInfo[]>,
    
    mcpToggle: (name: string, enabled: boolean) =>
      ipcRenderer.invoke("slime:extras:mcpToggle", { name, enabled }) as Promise<{ ok: boolean; error?: string }>,
    
    mcpOpen: () => ipcRenderer.invoke("slime:extras:mcpOpen") as Promise<{ ok: boolean; error?: string }>,
    
    mcpDelete: (name: string) =>
      ipcRenderer.invoke("slime:extras:mcpDelete", { name }) as Promise<{ ok: boolean; error?: string }>,
    
    mcpAdd: (input: { name: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; force?: boolean }) =>
      ipcRenderer.invoke("slime:extras:mcpAdd", input) as Promise<{ ok: boolean; error?: string }>,
    
    mcpRegistrySearch: (query?: string) =>
      ipcRenderer.invoke("slime:mcpRegistrySearch", { query }) as Promise<{ ok: boolean; servers?: Array<{ name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }>; appliedQuery?: string; unrecognized?: boolean; error?: string }>,
    
    mcpRegistryInstall: (card: { name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }) =>
      ipcRenderer.invoke("slime:mcpRegistryInstall", { card }) as Promise<{ ok: boolean; error?: string }>,

    pluginsList: () => ipcRenderer.invoke("slime:plugins:list") as Promise<PluginSnapshotDTO>,
    pluginsReload: () => ipcRenderer.invoke("slime:plugins:reload") as Promise<PluginSnapshotDTO>,
    pluginsUnload: (name: string) =>
      ipcRenderer.invoke("slime:plugins:unload", { name }) as Promise<{ ok: boolean; error?: string }>,
    /* A-1196：拨片开关「开」——从禁用名单移除并重新装载（返回最新快照，省一次往返）。 */
    pluginsEnable: (name: string) =>
      ipcRenderer.invoke("slime:plugins:enable", { name }) as Promise<{ ok: boolean; error?: string; snapshot?: PluginSnapshotDTO }>,
    /* A-1197：磁盘上新增/改了插件或技能后由主进程广播（自动重扫完成），页面据此自刷新。 */
    pluginsOnChanged: (cb: (e: { reason: string; at: number }) => void) => onMessage<{ reason: string; at: number }>("slime:plugins:changed", cb),
    /* A-1197 · B1：设置项读/写。**参数里没有 path** —— 落盘位置由主进程按插件名推导。 */
    pluginsSettingsGet: (plugin: string) =>
      ipcRenderer.invoke("slime:plugins:settingsGet", { plugin }) as Promise<{ ok: boolean; dto?: PluginSettingsDTO; error?: string }>,
    pluginsSettingsSet: (plugin: string, key: string, value: unknown) =>
      ipcRenderer.invoke("slime:plugins:settingsSet", { plugin, key, value }) as Promise<PluginSettingsWriteDTO>,
    /* A-1197 · B2（L4a）：UI 槽位声明（按需拉；列表接口只给 uiCount）。 */
    pluginsUi: () => ipcRenderer.invoke("slime:plugins:ui") as Promise<PluginUiSnapshotDTO>,
    /* A-1197 · B4（T1）：信任开关读/写（写后主进程会自动重装使脚本工具生效/撤装）。 */
    pluginsTrustGet: (name: string) =>
      ipcRenderer.invoke("slime:plugins:trustGet", { name }) as Promise<{ ok: boolean; trusted?: boolean; error?: string }>,
    pluginsTrustSet: (name: string, trusted: boolean) =>
      ipcRenderer.invoke("slime:plugins:trustSet", { name, trusted }) as Promise<{ ok: boolean; trusted?: boolean; snapshot?: PluginSnapshotDTO; error?: string }>,
    /* A-1197 · B5（L4a page）：打开扩展自有页面（返回要加载的 127.0.0.1 url）。 */
    pluginsPageOpen: (name: string) =>
      ipcRenderer.invoke("slime:plugins:pageOpen", { name }) as Promise<{ ok: boolean; url?: string; reused?: boolean; error?: string }>,
    /* A-1198：安装官方示例扩展（活教材）—— 已存在则不覆盖。 */
    pluginsInstallExample: () =>
      ipcRenderer.invoke("slime:plugins:installExample") as Promise<{ ok: boolean; snapshot?: PluginSnapshotDTO; error?: string }>,
  },
  runtime: {
    
    list: () => ipcRenderer.invoke("slime:runtime:list") as Promise<{
      ok: boolean; items?: Array<{
        kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string;
        action?: { label: string; kind: string; url?: string; path?: string; target?: string };
      }>; error?: string;
    }>,
    
    open: (action: { label?: string; kind?: string; url?: string; path?: string }) =>
      ipcRenderer.invoke("slime:runtime:open", { action }) as Promise<{ ok: boolean; error?: string }>,
    
    installPython: () =>
      ipcRenderer.invoke("slime:runtime:installPython") as Promise<{ ok: boolean; log?: string; error?: string }>,
  },
  files: {
    
    pick: () => ipcRenderer.invoke("slime:files:pick") as Promise<{ ok: boolean; path?: string; error?: string }>,
    




    pathForFile: (file: File): string => {
      try { return webUtils.getPathForFile(file) ?? ""; } catch { return ""; }
    },
  },
  



  fileUndo: {
    plan: (agentId: string, sessionId: string | undefined, userMsg: string) =>
      ipcRenderer.invoke("slime:file:undo", { agentId, sessionId, userMsg, mode: "plan" }) as Promise<FileUndoPlan>,
    apply: (agentId: string, sessionId: string | undefined, userMsg: string) =>
      ipcRenderer.invoke("slime:file:undo", { agentId, sessionId, userMsg, mode: "apply" }) as Promise<FileUndoResult>,
  },
  images: {
    
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
    
    onRequest: (cb: (req: PermissionRequestUI) => void) => onMessage<PermissionRequestUI>("slime:perm:request", cb),
    
    onTimeout: (cb: (req: { requestId: string }) => void) =>
      onMessage<{ requestId: string }>("slime:perm:timeout", cb),
    
    resolve: (decision: PermissionDecision) =>
      ipcRenderer.invoke("slime:perm:resolve", decision) as Promise<{ ok: boolean }>,
  },
  askUser: {
    
    onRequest: (cb: (req: AskUserRequestUI) => void) => onMessage<AskUserRequestUI>("slime:ask:request", cb),
    
    onTimeout: (cb: (req: { requestId: string }) => void) =>
      onMessage<{ requestId: string }>("slime:ask:timeout", cb),
    
    onCancel: (cb: (req: AskUserCancelNotice) => void) =>
      onMessage<AskUserCancelNotice>("slime:ask:cancel", cb),
    
    resolve: (decision: AskUserDecision) =>
      ipcRenderer.invoke("slime:ask:resolve", decision) as Promise<{ ok: boolean }>,
  },
  suggest: (text: string) =>
    ipcRenderer.invoke("slime:chat:suggest", { text }) as Promise<SuggestionItem[]>,
  dialog: {
    
    confirm: (message: string, detail?: string) =>
      ipcRenderer.invoke("slime:dialog:confirm", { message, detail }) as Promise<{ ok: boolean; confirmed: boolean; error: string | null }>,
    
    alert: (message: string, detail?: string) =>
      ipcRenderer.invoke("slime:dialog:alert", { message, detail }) as Promise<{ ok: boolean; error: string | null }>,
  },
  stats: {
    snapshot: () => ipcRenderer.invoke("slime:stats:snapshot") as Promise<StatsSnapshot>,
    poll: (start: boolean) => ipcRenderer.invoke("slime:stats:poll", start),
    onPoll: (cb: (snapshot: StatsSnapshot) => void) => onMessage<StatsSnapshot>("slime:stats:update", cb),
  },
  
  usage: {
    snapshot: (params?: { sinceIso?: string; untilIso?: string; limit?: number }) =>
      ipcRenderer.invoke("slime:usage:snapshot", params ?? {}) as Promise<UsageSnapshot>,
    clear: () => ipcRenderer.invoke("slime:usage:clear") as Promise<{ ok: boolean }>,
    
    recompute: () => ipcRenderer.invoke("slime:usage:recompute") as Promise<UsageRecomputeResult>,
  },
  
  trace: {
    get: (sessionId: string) =>
      ipcRenderer.invoke("slime:trace:get", sessionId) as Promise<TraceSnapshot | null>,
    onUpdate: (cb: (payload: { sessionId: string; trace: TraceSnapshot }) => void) =>
      onMessage<{ sessionId: string; trace: TraceSnapshot }>("slime:trace:update", cb),
  },
  
  plan: {
    get: (sessionId: string) =>
      ipcRenderer.invoke("slime:plan:get", sessionId) as Promise<PlanInfo | null>,
    onUpdate: (cb: (payload: { sessionId: string; plan: PlanInfo }) => void) =>
      onMessage<{ sessionId: string; plan: PlanInfo }>("slime:plan:update", cb),
  },
  agents: {
    list: () => ipcRenderer.invoke("slime:agents:list") as Promise<AgentInfo[]>,
    create: (name: string, role: string, toolProfile?: ToolProfileDTO) =>
      ipcRenderer.invoke("slime:agents:create", { name, role, toolProfile }) as Promise<AgentInfo>,
    fork: (parentId: string, name: string, role: string) =>
      ipcRenderer.invoke("slime:agents:fork", { parentId, name, role }) as Promise<AgentInfo>,
    
    select: (agentId: string) => ipcRenderer.invoke("slime:agents:select", { agentId }),
    
    detail: (agentId: string) =>
      ipcRenderer.invoke("slime:agents:detail", { agentId }) as Promise<AgentDetail | null>,
    
    remove: (agentId: string) =>
      ipcRenderer.invoke("slime:agents:remove", { agentId }) as Promise<{ ok: boolean; error?: string; deleted?: string[] }>,
    
    update: (agentId: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke("slime:agents:update", { agentId, patch }) as Promise<{ ok: boolean }>,
    
    onAgentSelected: (cb: (agentId: string) => void) => onMessage<string>("slime:agents:selected", cb),
    
    exportAgent: (agentId: string) =>
      ipcRenderer.invoke("slime:agents:export", { agentId }) as Promise<AgentExportResult>,
    
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
    
    setExitMode: (mode: "quit" | "background") =>
      ipcRenderer.invoke("slime:window:setExitMode", mode) as Promise<{ ok: boolean; mode: "quit" | "background" }>,
    getExitMode: () =>
      ipcRenderer.invoke("slime:window:getExitMode") as Promise<{ mode: "quit" | "background" }>,
  },
  theme: {
    
    set: (theme: string) => ipcRenderer.invoke("slime:theme:set", { theme }),
  },
  providers: {
    list: () => ipcRenderer.invoke("slime:providers:list") as Promise<ProviderSummary[]>,
    fetchModels: (baseUrl: string, apiKey: string, apiFormat: "openai" | "anthropic" | "responses" | "google" | "auto" = "auto") =>
      ipcRenderer.invoke("slime:providers:fetchModels", { baseUrl, apiKey, api_format: apiFormat }) as Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }>,
    
    refresh: (key: string) =>
      ipcRenderer.invoke("slime:providers:refresh", { key }) as Promise<{ ok: boolean; total?: number; added?: number; removed?: number; error?: string }>,
    save: (input: { key: string; api_base: string; api_key?: string; model?: string | null; api_format?: "openai" | "anthropic" | "responses" | "google" | "auto"; models?: unknown[]; rpm?: number }) =>
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
    
    status: () => ipcRenderer.invoke("slime:silam:status") as Promise<{ enabled: boolean }>,
    
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
    check: () => ipcRenderer.invoke("slime:update:check") as Promise<UpdateStatusDTO>,
    
    download: () => ipcRenderer.invoke("slime:update:download") as Promise<UpdateStatusDTO>,
    install: () => ipcRenderer.invoke("slime:update:install") as Promise<{ ok: boolean }>,
    onStatus: (cb: (status: UpdateStatusDTO) => void) =>
      onMessage<UpdateStatusDTO>("slime:update:status", cb),
  },
  settings: {
    
    autostartGet: () =>
      ipcRenderer.invoke("slime:settings:autostart:get") as Promise<{ ok: boolean; enabled: boolean }>,
    
    autostartSet: (enabled: boolean) =>
      ipcRenderer.invoke("slime:settings:autostart:set", { enabled }) as Promise<{ ok: boolean; enabled: boolean; error?: string }>,
    
    uninstall: () =>
      ipcRenderer.invoke("slime:settings:uninstall") as Promise<{ ok: boolean; error?: string }>,
  },
  




  notify: {
    get: () => ipcRenderer.invoke("slime:notify:get") as Promise<{ ok: boolean; config: NotifyConfigDTO; soundReady: boolean }>,
    set: (patch: { enabled?: boolean; soundEnabled?: boolean }) =>
      ipcRenderer.invoke("slime:notify:set", patch) as Promise<{ ok: boolean; config?: NotifyConfigDTO; soundReady?: boolean; error?: string }>,
    pickSound: () =>
      ipcRenderer.invoke("slime:notify:sound:pick") as Promise<{ ok: boolean; canceled?: boolean; name?: string | null; size?: number; config?: NotifyConfigDTO; error?: string }>,
    clearSound: () =>
      ipcRenderer.invoke("slime:notify:sound:clear") as Promise<{ ok: boolean; config?: NotifyConfigDTO; error?: string }>,
    soundData: () =>
      ipcRenderer.invoke("slime:notify:sound:data") as Promise<{ ok: boolean; dataUrl?: string; name?: string; size?: number; error?: string }>,
    test: () => ipcRenderer.invoke("slime:notify:test") as Promise<{ ok: boolean; config?: NotifyConfigDTO }>,
    
    onPlaySound: (cb: () => void) => onMessage<Record<string, never>>("slime:notify:playsound", cb),
  },
  









  fallback: {
    get: () => ipcRenderer.invoke("slime:fallback:get") as Promise<{ ok: boolean; entries: FallbackPoolEntryDTO[]; providers: ProviderSummary[] }>,
    set: (entries: FallbackPoolEntryDTO[]) =>
      ipcRenderer.invoke("slime:fallback:set", { entries }) as Promise<{ ok: boolean; entries?: FallbackPoolEntryDTO[]; error?: string }>,
  },
  
  llmGateway: {
    get: () => ipcRenderer.invoke("slime:llmgw:get") as Promise<{ ok: boolean; config: LlmGatewayConfigDTO; status: LlmGatewayStatusDTO }>,
    set: (cfg: LlmGatewayConfigDTO) => ipcRenderer.invoke("slime:llmgw:set", cfg) as Promise<{ ok: boolean; error?: string; status: LlmGatewayStatusDTO }>,
    status: () => ipcRenderer.invoke("slime:llmgw:status") as Promise<LlmGatewayStatusDTO>,
    restart: () => ipcRenderer.invoke("slime:llmgw:restart") as Promise<{ ok: boolean; error?: string; status: LlmGatewayStatusDTO }>,
    
    tokenAdd: (input: LlmGatewayNewTokenDTO) =>
      ipcRenderer.invoke("slime:llmgw:token:add", input) as Promise<LlmGatewayTokenOpResultDTO>,
    
    tokenUpdate: (input: LlmGatewayUpdateTokenDTO) =>
      ipcRenderer.invoke("slime:llmgw:token:update", input) as Promise<LlmGatewayTokenOpResultDTO>,
    
    tokenRemove: (key: string) =>
      ipcRenderer.invoke("slime:llmgw:token:remove", { key }) as Promise<LlmGatewayTokenOpResultDTO>,
    
    tokenToggle: (key: string, active: boolean) =>
      ipcRenderer.invoke("slime:llmgw:token:toggle", { key, active }) as Promise<LlmGatewayTokenOpResultDTO>,
  },
  mind: {
    
    configGet: (agentId?: string) =>
      ipcRenderer.invoke("slime:mind:configGet", agentId ? { agentId } : undefined) as Promise<MindConfigInfo>,
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
    
    version: () => ipcRenderer.invoke("slime:app:version") as Promise<string>,
  },
  system: {
    dataRootGet: () =>
      ipcRenderer.invoke("slime:dataRoot:get") as Promise<DataRootInfo>,
    dataRootPick: () =>
      ipcRenderer.invoke("slime:dataRoot:pick") as Promise<{ ok: boolean; canceled?: boolean; dir?: string; error?: string }>,
    dataRootSet: (p: { dir: string; migrate: boolean }) =>
      ipcRenderer.invoke("slime:dataRoot:set", p) as Promise<{ ok: boolean; error?: string; migrated?: boolean; root?: string; needRestart?: boolean }>,
    dataRootReset: () =>
      ipcRenderer.invoke("slime:dataRoot:reset") as Promise<{ ok: boolean; error?: string; needRestart?: boolean }>,
  },
  workspace: {
    
    list: (root: string, rel: string) =>
      ipcRenderer.invoke("slime:workspace:list", { root, rel }) as Promise<WorkspaceListResult>,
    
    readFile: (root: string, rel: string) =>
      ipcRenderer.invoke("slime:workspace:readFile", { root, rel }) as Promise<WorkspaceReadFileResult>,
    
    readFileAbs: (path: string) =>
      ipcRenderer.invoke("slime:workspace:readFileAbs", { path }) as Promise<WorkspaceReadFileResult>,
    

    openTarget: (rel: string, opts?: { root?: string; sessionId?: string }) =>
      ipcRenderer.invoke("slime:workspace:openTarget", { rel, root: opts?.root, sessionId: opts?.sessionId }) as Promise<{ ok: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string }>,
    
    contextmenu: (root: string, params: WorkspaceContextMenuParams) =>
      ipcRenderer.invoke("slime:workspace:contextmenu", { root, params }) as Promise<{ ok: boolean; items?: ContextMenuItem[]; error?: string }>,
    
    create: (params: { root: string; parentRel: string; name: string; isDir: boolean }) =>
      ipcRenderer.invoke("slime:workspace:create", params) as Promise<WorkspaceCreateResult>,
    
    pickBrowseRoot: () =>
      ipcRenderer.invoke("slime:workspace:pickBrowseRoot") as Promise<{ ok: boolean; path?: string; error?: string }>,
    
    getParent: (path: string) =>
      ipcRenderer.invoke("slime:workspace:getParent", { path }) as Promise<{ ok: boolean; parent?: string | null; diskRoot?: boolean; error?: string }>,
    
    openPath: (path: string) =>
      ipcRenderer.invoke("slime:shell:openPath", { path }) as Promise<{ ok: boolean; error?: string }>,
  },
  




  

  docs: {
    read: (path: string) =>
      ipcRenderer.invoke("slime:docs:read", { path }) as Promise<{ ok: boolean; kind?: string; text?: string; error?: string; truncated?: boolean }>,
    create: (spec: { path: string; format: string; title?: string; body: string }) =>
      ipcRenderer.invoke("slime:docs:create", { spec }) as Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>,
    
    htmlPreview: (payload: { name?: string; html: string }) =>
      ipcRenderer.invoke("slime:docs:htmlPreview", payload) as Promise<{ ok: boolean; path?: string; dir?: string; name?: string; error?: string }>,
    








    renderPage: (payload: { path: string; name?: string }) =>
      ipcRenderer.invoke("slime:docs:renderPage", payload) as Promise<{
        ok: boolean; dir?: string; name?: string; error?: string; degrade?: boolean;
        needs?: string; hint?: string; reason?: string; transient?: boolean; fallback?: boolean;
      }>,
    
    onLocalFile: (cb: (payload: { path: string; reason: string }) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { path: string; reason: string }): void => cb(p);
      ipcRenderer.on("slime:docs:local-file", h);
      return () => { ipcRenderer.off("slime:docs:local-file", h); };
    },
  },
  


  office: {
    

    libreofficeProbe: (force?: boolean) =>
      ipcRenderer.invoke("slime:office:libreofficeProbe", { force: Boolean(force) }) as Promise<{
        ok: boolean; found: boolean; path: string; version: string; hint: string; error?: string;
      }>,
  },
  



  search: {
    

    host: () =>
      ipcRenderer.invoke("slime:search:hostInfo") as Promise<{
        ok: boolean; url?: string; preload?: string; fingerprint?: string; error?: string;
      }>,
    
    view: () =>
      ipcRenderer.invoke("slime:search:viewGet") as Promise<SidebarSearchView | null>,
    
    onView: (cb: (v: SidebarSearchView) => void) =>
      onMessage<SidebarSearchView>("slime:search:viewChanged", cb),

    
    

    indexStart: () =>
      ipcRenderer.invoke("slime:search:indexStart") as Promise<{ ok: boolean; port?: number; error?: string }>,
    indexStop: () => ipcRenderer.invoke("slime:search:indexStop") as Promise<{ ok: boolean }>,
    


    indexCrawl: (payload: { seeds: string | string[]; opts?: Record<string, unknown> }) =>
      ipcRenderer.invoke("slime:search:indexCrawl", payload) as Promise<{ ok: boolean; error?: string }>,
    indexStatus: () => ipcRenderer.invoke("slime:search:indexStatus") as Promise<{
      running: boolean; port: number; pages: number; terms: number;
      crawling: boolean; log: string[];
      lastCrawl: { ok: boolean; fetched?: number; error?: string } | null;
      sites?: { host: string; pages: number }[];
    }>,
    
    indexRebuild: () =>
      ipcRenderer.invoke("slime:search:indexRebuild") as Promise<{ ok: boolean; pages?: number; terms?: number; error?: string }>,
    indexClear: () =>
      ipcRenderer.invoke("slime:search:indexClear") as Promise<{ ok: boolean; removed?: number; error?: string }>,
    indexRemoveSite: (host: string) =>
      ipcRenderer.invoke("slime:search:indexRemoveSite", host) as Promise<{ ok: boolean; removed?: number; error?: string }>,
    

    indexParamsGet: () =>
      ipcRenderer.invoke("slime:search:indexParamsGet") as Promise<{
        index: { k1: number; b: number; titleBoost: number; wholeWordMaxLen: number; minTermLen: number; stopwords: string[] };
        body: { minBodyChars: number; maxBodyChars: number };
      } | null>,
    

    indexParamsSet: (p: {
      index?: Partial<{ k1: number; b: number; titleBoost: number; wholeWordMaxLen: number; minTermLen: number; stopwords: string[] }>;
      body?: Partial<{ minBodyChars: number; maxBodyChars: number }>;
    }) =>
      ipcRenderer.invoke("slime:search:indexParamsSet", p) as Promise<{ ok: boolean; pages?: number; terms?: number; notice?: string; error?: string }>,
  },
  term: {
    


    exec: (cmd: string, cwd?: string, profileId?: string) =>
      ipcRenderer.invoke("slime:term:exec", { cmd, cwd, profileId }) as Promise<TermResult>,
    
    profiles: () =>
      ipcRenderer.invoke("slime:term:profiles") as Promise<TermProfilesResult>,
  },
  




  agentProcs: {
    list: () =>
      ipcRenderer.invoke("slime:agentprocs:list", {}) as Promise<AgentProcsListResult>,
    stop: (kind: string, id?: string) =>
      ipcRenderer.invoke("slime:agentprocs:stop", { kind, id }) as Promise<AgentProcsStopResult>,
    
    onChanged: (cb: () => void) => onMessage<Record<string, never>>("slime:agentprocs:changed", cb),
  },
  git: {
    
    detect: (path: string) =>
      ipcRenderer.invoke("slime:git:detect", { path }) as Promise<GitDetect>,
    
    init: (path: string) =>
      ipcRenderer.invoke("slime:git:init", { path }) as Promise<GitAction>,
    
    info: (path: string) =>
      ipcRenderer.invoke("slime:git:info", { path }) as Promise<GitInfo>,
    
    commit: (path: string, message: string) =>
      ipcRenderer.invoke("slime:git:commit", { path, message }) as Promise<GitAction>,
    
    push: (path: string) =>
      ipcRenderer.invoke("slime:git:push", { path }) as Promise<GitAction>,
    
    pull: (path: string) =>
      ipcRenderer.invoke("slime:git:pull", { path }) as Promise<GitAction>,
    
    checkout: (path: string, branch: string) =>
      ipcRenderer.invoke("slime:git:checkout", { path, branch }) as Promise<GitAction>,
    
    clone: (url: string) =>
      ipcRenderer.invoke("slime:git:clone", { url }) as Promise<GitCloneResult>,
    
    diff: (path: string, file: string) =>
      ipcRenderer.invoke("slime:git:diff", { path, file }) as Promise<GitDiffResult>,
    


    showFile: (rel: string, workspace: string, ref?: string) =>
      ipcRenderer.invoke("slime:git:showFile", { rel, workspace, ref }) as Promise<{ ok: boolean; content?: string; error?: string; code?: "not-repo" | "no-head" | "not-found" }>,
  },
  data: {
    
    reset: () => ipcRenderer.invoke("slime:data:reset") as Promise<{ ok: boolean; error?: string }>,
  },
  resident: {
    
    state: () => ipcRenderer.invoke("slime:resident:state") as Promise<ResidentState>,
    
    schedulerAdd: (p: { name: string; cron: string; prompt: string; agentId?: string }) =>
      ipcRenderer.invoke("slime:resident:scheduler:add", p) as Promise<{ ok: boolean; id?: string; error?: string }>,
    
    schedulerRemove: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:remove", { id }) as Promise<{ ok: boolean }>,
    schedulerPause: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:pause", { id }) as Promise<{ ok: boolean }>,
    schedulerResume: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:resume", { id }) as Promise<{ ok: boolean }>,
    
    schedulerTrigger: (id: string) => ipcRenderer.invoke("slime:resident:scheduler:trigger", { id }) as Promise<{ ok: boolean }>,
    
    subagentSpawn: (p: { name: string; task: string; systemPrompt?: string; agentId?: string }) =>
      ipcRenderer.invoke("slime:resident:subagent:spawn", p) as Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>,
    
    subagentCancel: (id: string) =>
      ipcRenderer.invoke("slime:resident:subagent:cancel", { id }) as Promise<{ ok: boolean }>,
    
    subagentClear: () =>
      ipcRenderer.invoke("slime:resident:subagent:clear") as Promise<{ ok: boolean; cleared: number; dropped: number }>,
    
    subagentDelegate: (p: { task: string; agentId?: string }) =>
      ipcRenderer.invoke("slime:resident:subagent:delegate", p) as Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>,
    
    subagentSetDefaultModel: (model: string) =>
      ipcRenderer.invoke("slime:resident:subagent:setDefaultModel", { model }) as Promise<{ ok: boolean; defaultModel?: string; defaultModels?: string[]; error?: string }>,
    
    subagentSetModels: (models: string[]) =>
      ipcRenderer.invoke("slime:resident:subagent:setModels", { models }) as Promise<{ ok: boolean; defaultModels?: string[]; error?: string }>,
    
    subagentGetSelection: () =>
      ipcRenderer.invoke("slime:resident:subagent:getSelection") as Promise<{ ok: boolean; selectedAgentIds?: string[] }>,
    
    subagentSetSelection: (selectedAgentIds: string[]) =>
      ipcRenderer.invoke("slime:resident:subagent:setSelection", { selectedAgentIds }) as Promise<{ ok: boolean; selectedAgentIds?: string[]; error?: string }>,
    
    onUpdate: (cb: (payload: unknown) => void) => onMessage<unknown>("slime:resident:update", cb),
  },
  
  brainstorm: {
    onEvent: (cb: (payload: { sessionId: string; memberId: string; name: string; state?: string; chunk?: string; content?: string }) => void) =>
      onMessage<{ sessionId: string; memberId: string; name: string; state?: string; chunk?: string; content?: string }>("slime:brainstorm:event", cb),
  },
  requests: {
    
    get: () => ipcRenderer.invoke("slime:requests:get") as Promise<{ concurrency: number; reconnectBaseMs: number }>,
    set: (p: { concurrency?: number; reconnectBaseMs?: number }) =>
      ipcRenderer.invoke("slime:requests:set", p) as Promise<{ ok: boolean; concurrency?: number; reconnectBaseMs?: number; error?: string }>,
  },
  adb: {
    
    detect: () => ipcRenderer.invoke("slime:adb:detect") as Promise<{ ok: boolean; path?: string; version?: string; source?: string; error?: string }>,
    
    download: () => ipcRenderer.invoke("slime:adb:download") as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string; progress?: AdbDownloadProgressInfo }>,
    
    devices: () => ipcRenderer.invoke("slime:adb:devices") as Promise<{ ok: boolean; devices?: Array<{ serial: string; state: string; model?: string; product?: string }>; error?: string }>,
    
    connect: (host: string) => ipcRenderer.invoke("slime:adb:connect", { host }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    disconnect: (host: string) => ipcRenderer.invoke("slime:adb:disconnect", { host }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    shell: (serial: string, command: string) => ipcRenderer.invoke("slime:adb:shell", { serial, command }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    install: (serial: string, apkPath: string) => ipcRenderer.invoke("slime:adb:install", { serial, apkPath }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    uninstall: (serial: string, pkg: string) => ipcRenderer.invoke("slime:adb:uninstall", { serial, pkg }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    screencap: (serial: string) => ipcRenderer.invoke("slime:adb:screencap", { serial }) as Promise<{ ok: boolean; pngBase64?: string; error?: string }>,
    
    pull: (serial: string, remote: string, local: string) => ipcRenderer.invoke("slime:adb:pull", { serial, remote, local }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    push: (serial: string, local: string, remote: string) => ipcRenderer.invoke("slime:adb:push", { serial, local, remote }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    reboot: (serial: string) => ipcRenderer.invoke("slime:adb:reboot", { serial }) as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    startServer: () => ipcRenderer.invoke("slime:adb:startServer") as Promise<{ ok: boolean; version?: string; stdout?: string; stderr?: string; error?: string }>,
    killServer: () => ipcRenderer.invoke("slime:adb:killServer") as Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>,
    
    onDownloadProgress: (cb: (p: AdbDownloadProgressInfo) => void) => onMessage<AdbDownloadProgressInfo>("slime:adb:downloadProgress", cb),
  },
  http: {
    
    serve: (p: { dir: string; port?: number; host?: string; spa?: boolean }) =>
      ipcRenderer.invoke("slime:http:serve", p) as Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }>,
    
    stop: (id: string) => ipcRenderer.invoke("slime:http:stop", { id }) as Promise<{ ok: boolean; error?: string }>,
    
    stopAll: () => ipcRenderer.invoke("slime:http:stopAll") as Promise<{ ok: boolean; stopped: number }>,
    
    list: () => ipcRenderer.invoke("slime:http:list") as Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>>,
    
    open: (url: string) => ipcRenderer.invoke("slime:http:open", { url }) as Promise<{ ok: boolean; error?: string }>,
  },
  screen: {
    
    info: () => ipcRenderer.invoke("slime:screen:info") as Promise<{
      enabled: boolean;
      halted: boolean;
      backends: string[];
      targets: Array<{ backend: string; target: string; width: number; height: number; label: string }>;
    }>,
    
    halt: () => ipcRenderer.invoke("slime:screen:halt") as Promise<{ ok: boolean }>,
    
    resume: () => ipcRenderer.invoke("slime:screen:resume") as Promise<{ ok: boolean }>,
    
    capture: (p?: { backend?: string; target?: string }) =>
      ipcRenderer.invoke("slime:screen:capture", p ?? {}) as Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }>,
    


    onOperationFocus: (cb: (e: OperationFocusUI) => void) =>
      onMessage<OperationFocusUI>("slime:screen:opFocus", cb),
  },
  


  onSidebarOpen: (cb: (payload: SidebarOpenRequest) => void) =>
    onMessage<SidebarOpenRequest>("slime:sidebar:open", cb),
  


  publishSidebarMount: (payload: { sessionId: string; text: string } | null) =>
    ipcRenderer.send("slime:sidebar:mount", payload),
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
        
        steer: (sessionId: string, id: number | string, text: string) => Promise<{ ok: boolean; pending?: number; error?: string }>;
        
        dismissSteer: (sessionId: string, id: number | string) => Promise<{ ok: boolean; dropped?: boolean }>;
        isActive: (key: string) => Promise<{ active: boolean }>;
        compress: (sessionId: string, ratio: number, used?: number, force?: boolean) => Promise<CompressResult>;
        onChunk: (cb: (chunk: StreamChunk) => void) => () => void;
        onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number>; interrupted?: boolean; sessionId?: string; windowCap?: number }) => void) => () => void;
        onError: (cb: (err: { message: string; sessionId?: string }) => void) => () => void;
        onStreamEnded: (cb: (ev: { sessionId?: string }) => void) => () => void;
      };
      
      browser: {
        onCommand: (cb: (cmd: { id: string; kind: string } & Record<string, unknown>) => void) => () => void;
        sendResult: (payload: { id: string; ok: boolean; data?: unknown; error?: string }) => void;
        onPopupNotice: (cb: (p: { url: string; ts: number; kind?: string; scheme?: string }) => void) => () => void;
      };
      




      fileUndo: {
        plan: (agentId: string, sessionId: string | undefined, userMsg: string) => Promise<FileUndoPlan>;
        apply: (agentId: string, sessionId: string | undefined, userMsg: string) => Promise<FileUndoResult>;
      };
      
      protocol: {
        open: (url: string) => Promise<{ ok?: boolean; url?: string; scheme?: string; handler?: string; reason?: string }>;
      };
      model: {
        onLoading: (cb: (s: ModelLoadingStatus) => void) => () => void;
        startEmbedding: () => Promise<{ ok: boolean; error?: string; state?: string }>;
      };
      conversations: {
        list: () => Promise<SessionItem[]>;
        load: (sessionId: string) => Promise<ConversationMessage[]>;
        create: (opts?: { agentId?: string; title?: string; workspace?: string | null; memberIds?: Array<string | { id: string; model?: string; effort?: string }>; leaderModel?: string; type?: "normal" | "brainstorm" }) => Promise<{ ok: boolean; session?: SessionItem }>;
        setAgent: (sessionId: string, agentId: string) => Promise<{ ok: boolean }>;
        /* A-1197 · B3（L4c）：显式运行模式（插件 mode；空串 = 清除回默认）。 */
        setMode: (sessionId: string, mode: string) => Promise<{ ok: boolean; mode?: string; error?: string }>;
        setMembers: (sessionId: string, memberIds: string[]) => Promise<{ ok: boolean; session?: SessionItem }>;
        
        setMemberEffort: (sessionId: string, memberId: string, effort: string | null) => Promise<{ ok: boolean; memberEfforts?: Record<string, string>; leaderEffort?: string }>;
        setWorkspace: (sessionId: string, workspace: string | null) => Promise<{ ok: boolean; workspace?: string }>;
        
        setModelChoice: (sessionId: string, modelChoice: string | null) => Promise<{ ok: boolean; modelChoice?: string | null }>;
        rename: (sessionId: string, title: string) => Promise<{ ok: boolean }>;
        remove: (sessionId: string) => Promise<{ ok: boolean }>;
        clear: (sessionId: string) => Promise<{ ok: boolean }>;
        config: (input: { agentId: string; sessionId?: string; approval?: ApprovalMode; workspace?: string | null }) => Promise<{ ok: boolean; approval: ApprovalMode; workspace: string }>;
        configGet: (input: { agentId: string; sessionId?: string }) => Promise<SessionConfig>;
        pickFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
        removeAgent: (agentId: string) => Promise<{ ok: boolean }>;
        removeWorkspace: (workspace: string) => Promise<{ ok: boolean; count?: number }>;
        loadTodos: (sessionId: string) => Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }>;
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
        mcpRegistrySearch: (query?: string) => Promise<{ ok: boolean; servers?: Array<{ name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }>; appliedQuery?: string; unrecognized?: boolean; error?: string }>;
        mcpRegistryInstall: (card: { name: string; displayName: string; description: string; source: string; install?: { kind: "stdio"; command: string; args: string[]; envHints: string[] } | { kind: "http"; url: string } }) => Promise<{ ok: boolean; error?: string }>;
        pluginsList: () => Promise<PluginSnapshotDTO>;
        pluginsReload: () => Promise<PluginSnapshotDTO>;
        pluginsUnload: (name: string) => Promise<{ ok: boolean; error?: string }>;
        /* A-1196：拨片开关「开」。 */
        pluginsEnable: (name: string) => Promise<{ ok: boolean; error?: string; snapshot?: PluginSnapshotDTO }>;
        /* A-1197：贡献目录自动重扫完成（返回订阅的取消函数）。 */
        pluginsOnChanged: (cb: (e: { reason: string; at: number }) => void) => () => void;
        /* A-1197 · B1：设置项读/写（无 path 参数 —— 落盘位置由主进程按插件名推导）。 */
        pluginsSettingsGet: (plugin: string) => Promise<{ ok: boolean; dto?: PluginSettingsDTO; error?: string }>;
        pluginsSettingsSet: (plugin: string, key: string, value: unknown) => Promise<PluginSettingsWriteDTO>;
        /* A-1197 · B2（L4a）：UI 槽位声明（按需拉）。 */
        pluginsUi: () => Promise<PluginUiSnapshotDTO>;
        /* A-1197 · B4（T1）：信任开关读/写。 */
        pluginsTrustGet: (name: string) => Promise<{ ok: boolean; trusted?: boolean; error?: string }>;
        pluginsTrustSet: (name: string, trusted: boolean) => Promise<{ ok: boolean; trusted?: boolean; snapshot?: PluginSnapshotDTO; error?: string }>;
        /* A-1197 · B5（L4a page）：打开扩展自有页面。 */
        pluginsPageOpen: (name: string) => Promise<{ ok: boolean; url?: string; reused?: boolean; error?: string }>;
        /* A-1198：安装官方示例扩展。 */
        pluginsInstallExample: () => Promise<{ ok: boolean; snapshot?: PluginSnapshotDTO; error?: string }>;
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
        loadTodos: (sessionId: string) => Promise<{ ok: boolean; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }>;
        onTodos: (cb: (data: { sessionId: string; todos: Array<{ id: string; content: string; status: string; completedAt?: string }> }) => void) => () => void;
        saveTodos: (sessionId: string, todos: Array<{ id: string; content: string; status: string; completedAt?: string }>) => Promise<{ ok: boolean; todos?: Array<{ id: string; content: string; status: string; completedAt?: string }>; error?: string }>;
        clearTodos: (sessionId: string) => Promise<{ ok: boolean }>;
      };
      askUser: {
        onRequest: (cb: (req: AskUserRequestUI) => void) => () => void;
        onTimeout: (cb: (req: { requestId: string }) => void) => () => void;
        onCancel: (cb: (req: AskUserCancelNotice) => void) => () => void;
        resolve: (decision: AskUserDecision) => Promise<{ ok: boolean }>;
      };
      suggest: (text: string) => Promise<SuggestionItem[]>;
      stats: {
        snapshot: () => Promise<StatsSnapshot>;
        poll: (start: boolean) => Promise<{ ok: boolean }>;
        onPoll: (cb: (snapshot: StatsSnapshot) => void) => () => void;
      };
      usage: {
        snapshot: (params?: { sinceIso?: string; untilIso?: string; limit?: number }) => Promise<UsageSnapshot>;
        clear: () => Promise<{ ok: boolean }>;
        recompute: () => Promise<UsageRecomputeResult>;
      };
      agents: {
        list: () => Promise<AgentInfo[]>;
        create: (name: string, role: string, toolProfile?: ToolProfileDTO) => Promise<AgentInfo>;
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
        fetchModels: (baseUrl: string, apiKey: string, apiFormat?: "openai" | "anthropic" | "responses" | "google" | "auto") => Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }>;
        refresh: (key: string) => Promise<{ ok: boolean; total?: number; added?: number; removed?: number; error?: string }>;
        save: (input: { key: string; api_base: string; api_key?: string; model?: string | null; api_format?: "openai" | "anthropic" | "responses" | "google" | "auto"; models?: unknown[] }) => Promise<{ ok: boolean; error?: string }>;
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
        check: () => Promise<UpdateStatusDTO>;
        download: () => Promise<UpdateStatusDTO>;
        install: () => Promise<{ ok: boolean }>;
        onStatus: (cb: (status: UpdateStatusDTO) => void) => () => void;
      };
      settings: {
        autostartGet: () => Promise<{ ok: boolean; enabled: boolean }>;
        autostartSet: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; error?: string }>;
        uninstall: () => Promise<{ ok: boolean; error?: string }>;
      };
      
      notify: {
        get: () => Promise<{ ok: boolean; config: NotifyConfigDTO; soundReady: boolean }>;
        set: (patch: { enabled?: boolean; soundEnabled?: boolean }) => Promise<{ ok: boolean; config?: NotifyConfigDTO; soundReady?: boolean; error?: string }>;
        pickSound: () => Promise<{ ok: boolean; canceled?: boolean; name?: string | null; size?: number; config?: NotifyConfigDTO; error?: string }>;
        clearSound: () => Promise<{ ok: boolean; config?: NotifyConfigDTO; error?: string }>;
        soundData: () => Promise<{ ok: boolean; dataUrl?: string; name?: string; size?: number; error?: string }>;
        test: () => Promise<{ ok: boolean; config?: NotifyConfigDTO }>;
        onPlaySound: (cb: () => void) => () => void;
      };
      
      fallback: {
        get: () => Promise<{ ok: boolean; entries: FallbackPoolEntryDTO[]; providers: ProviderSummary[] }>;
        set: (entries: FallbackPoolEntryDTO[]) => Promise<{ ok: boolean; entries?: FallbackPoolEntryDTO[]; error?: string }>;
      };
      llmGateway: {
        get: () => Promise<{ ok: boolean; config: LlmGatewayConfigDTO; status: LlmGatewayStatusDTO }>;
        set: (cfg: LlmGatewayConfigDTO) => Promise<{ ok: boolean; error?: string; status: LlmGatewayStatusDTO }>;
        status: () => Promise<LlmGatewayStatusDTO>;
        restart: () => Promise<{ ok: boolean; error?: string; status: LlmGatewayStatusDTO }>;
        tokenAdd: (input: LlmGatewayNewTokenDTO) => Promise<LlmGatewayTokenOpResultDTO>;
        tokenUpdate: (input: LlmGatewayUpdateTokenDTO) => Promise<LlmGatewayTokenOpResultDTO>;
        tokenRemove: (key: string) => Promise<LlmGatewayTokenOpResultDTO>;
        tokenToggle: (key: string, active: boolean) => Promise<LlmGatewayTokenOpResultDTO>;
      };
      mind: {
        
        configGet: (agentId?: string) => Promise<MindConfigInfo>;
        configSet: (patch: { vectorTool?: VectorTool; memoryRoot?: string }) => Promise<{ ok: boolean; vectorTool: VectorTool; memoryRoot: string }>;
        emotionGet: (agentId: string) => Promise<EmotionSnapshot>;
        emotionSet: (input: { agentId: string; valence: number; arousal: number; dominance: number }) => Promise<{ ok: boolean; emotion?: EmotionSnapshot; error?: string }>;
        evolutionGet: (agentId: string) => Promise<EvolutionSnapshot>;
        bookToSkill: (name: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
        download: (target: DownloadTarget) => Promise<{ ok: boolean; error?: string }>;
        downloadControl: (target: DownloadTarget, action: "pause" | "cancel" | "resume") => Promise<{ ok: boolean }>;
        downloadSnapshot: (target: DownloadTarget) => Promise<DownloadProgressInfo>;
        

        locateDep: (mode: "auto" | "pick", key: "llama_bin" | "model_path" | "models_dir") => Promise<LocateDepResult>;
        onDownloadProgress: (cb: (p: DownloadProgressInfo) => void) => () => void;
      };
      boot: {
        status: () => Promise<BootStatus>;
        onEvent: (cb: (s: BootStatus) => void) => () => void;
        version: () => Promise<string>;
      };
      system: {
        dataRootGet: () => Promise<DataRootInfo>;
        dataRootPick: () => Promise<{ ok: boolean; canceled?: boolean; dir?: string; error?: string }>;
        dataRootSet: (p: { dir: string; migrate: boolean }) => Promise<{ ok: boolean; error?: string; migrated?: boolean; root?: string; needRestart?: boolean }>;
        dataRootReset: () => Promise<{ ok: boolean; error?: string; needRestart?: boolean }>;
      };
      workspace: {
        list: (root: string, rel: string) => Promise<WorkspaceListResult>;
        readFile: (root: string, rel: string) => Promise<WorkspaceReadFileResult>;
        readFileAbs: (path: string) => Promise<WorkspaceReadFileResult>;
        
        openTarget: (rel: string, opts?: { root?: string; sessionId?: string }) => Promise<{ ok: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string }>;
        
        pickBrowseRoot: () => Promise<{ ok: boolean; path?: string; error?: string }>;
        
        getParent: (path: string) => Promise<{ ok: boolean; parent?: string | null; diskRoot?: boolean; error?: string }>;
        
        contextmenu: (root: string, params: WorkspaceContextMenuParams) => Promise<{ ok: boolean; items?: ContextMenuItem[]; error?: string }>;
        
        create: (params: { root: string; parentRel: string; name: string; isDir: boolean }) => Promise<WorkspaceCreateResult>;
        
        openPath: (path: string) => Promise<{ ok: boolean; error?: string }>;
      };
      term: {
        exec: (cmd: string, cwd?: string, profileId?: string) => Promise<TermResult>;
        
        profiles: () => Promise<TermProfilesResult>;
      };
      
      agentProcs: {
        list: () => Promise<AgentProcsListResult>;
        stop: (kind: string, id?: string) => Promise<AgentProcsStopResult>;
        onChanged: (cb: () => void) => () => void;
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
        subagentClear: () => Promise<{ ok: boolean; cleared: number; dropped: number }>;
        subagentDelegate: (p: { task: string; agentId?: string }) => Promise<{ ok: boolean; run?: SubAgentRunView; error?: string }>;
        subagentSetDefaultModel: (model: string) => Promise<{ ok: boolean; defaultModel?: string; defaultModels?: string[]; error?: string }>;
        
        subagentSetModels: (models: string[]) => Promise<{ ok: boolean; defaultModels?: string[]; error?: string }>;
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
        download: () => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string; progress?: AdbDownloadProgressInfo }>;
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
        startServer: () => Promise<{ ok: boolean; version?: string; stdout?: string; stderr?: string; error?: string }>;
        killServer: () => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
        onDownloadProgress: (cb: (p: AdbDownloadProgressInfo) => void) => () => void;
      };
      http: {
        serve: (p: { dir: string; port?: number; host?: string; spa?: boolean }) => Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }>;
        stop: (id: string) => Promise<{ ok: boolean; error?: string }>;
        stopAll: () => Promise<{ ok: boolean; stopped: number }>;
        list: () => Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>>;
        open: (url: string) => Promise<{ ok: boolean; error?: string }>;
      };
      
      onSidebarOpen: (cb: (payload: SidebarOpenRequest) => void) => () => void;
      
      publishSidebarMount: (payload: { sessionId: string; text: string } | null) => void;
      
      screen: {
        info: () => Promise<{
          enabled: boolean;
          halted: boolean;
          backends: string[];
          targets: Array<{ backend: string; target: string; width: number; height: number; label: string }>;
        }>;
        halt: () => Promise<{ ok: boolean }>;
        resume: () => Promise<{ ok: boolean }>;
        capture: (p?: { backend?: string; target?: string }) => Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }>;
      };
    };
  }
}
