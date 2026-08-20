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
  SuggestionItem, ExtrasList, MindConfigInfo, VectorTool, EmotionSnapshot,
  DownloadTarget, DownloadProgressInfo, LocateDepResult, BootStatus,
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
    /** P0: 新对话（重置历史，返回空 OK） */
    newConversation: (agentId: string) =>
      ipcRenderer.invoke("slime:chat:new", { agentId }) as Promise<{ ok: boolean }>,
    /** P0: 重试最后一条（重发 user 消息，返回 {ok} 或 error） */
    retryLast: (agentId: string, sessionId?: string) =>
      ipcRenderer.invoke("slime:chat:retry", { agentId, sessionId }) as Promise<{ ok: boolean; error?: string }>,
    onChunk: (cb: (chunk: StreamChunk) => void) => onMessage<StreamChunk>("slime:chat:chunk", cb),
    onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => void) =>
      onMessage<{ reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }>(
        "slime:chat:done", cb,
      ),
    onError: (cb: (err: { message: string }) => void) =>
      onMessage<{ message: string }>("slime:chat:error", cb),
  },
  conversations: {
    list: () => ipcRenderer.invoke("slime:sessions:list") as Promise<SessionItem[]>,
    load: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:load", { sessionId }) as Promise<ConversationMessage[]>,
    create: (agentId: string, title?: string) =>
      ipcRenderer.invoke("slime:sessions:create", { agentId, title }) as Promise<{ ok: boolean; session?: SessionItem }>,
    rename: (sessionId: string, title: string) =>
      ipcRenderer.invoke("slime:sessions:rename", { sessionId, title }) as Promise<{ ok: boolean }>,
    remove: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:remove", { sessionId }) as Promise<{ ok: boolean }>,
    clear: (sessionId: string) =>
      ipcRenderer.invoke("slime:sessions:clear", { sessionId }) as Promise<{ ok: boolean }>,
    config: (input: { agentId: string; approval?: ApprovalMode; workspace?: string | null }) =>
      ipcRenderer.invoke("slime:sessions:config", input) as Promise<{ ok: boolean; approval: ApprovalMode; workspace: string }>,
    configGet: (agentId: string) =>
      ipcRenderer.invoke("slime:sessions:configGet", { agentId }) as Promise<SessionConfig>,
    pickFolder: () =>
      ipcRenderer.invoke("slime:sessions:pickFolder") as Promise<{ ok: boolean; path?: string; error?: string }>,
    removeAgent: (agentId: string) =>
      ipcRenderer.invoke("slime:sessions:removeAgent", { agentId }) as Promise<{ ok: boolean }>,
  },
  extras: {
    list: () => ipcRenderer.invoke("slime:extras:list") as Promise<ExtrasList>,
  },
  suggest: (text: string) =>
    ipcRenderer.invoke("slime:chat:suggest", { text }) as Promise<SuggestionItem[]>,
  stats: {
    snapshot: () => ipcRenderer.invoke("slime:stats:snapshot") as Promise<StatsSnapshot>,
    poll: (start: boolean) => ipcRenderer.invoke("slime:stats:poll", start),
    onPoll: (cb: (snapshot: StatsSnapshot) => void) => onMessage<StatsSnapshot>("slime:stats:update", cb),
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
  },
  providers: {
    list: () => ipcRenderer.invoke("slime:providers:list") as Promise<ProviderSummary[]>,
    fetchModels: (baseUrl: string, apiKey: string) =>
      ipcRenderer.invoke("slime:providers:fetchModels", { baseUrl, apiKey }) as Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }>,
    save: (input: { key: string; api_base: string; api_key?: string; model?: string | null; models?: unknown[] }) =>
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
  mind: {
    configGet: () => ipcRenderer.invoke("slime:mind:configGet") as Promise<MindConfigInfo>,
    configSet: (patch: { vectorTool?: VectorTool; memoryRoot?: string }) =>
      ipcRenderer.invoke("slime:mind:configSet", patch) as Promise<{ ok: boolean; vectorTool: VectorTool; memoryRoot: string }>,
    emotionGet: (agentId: string) =>
      ipcRenderer.invoke("slime:mind:emotionGet", { agentId }) as Promise<EmotionSnapshot>,
    emotionSet: (input: { agentId: string; valence: number; arousal: number; dominance: number }) =>
      ipcRenderer.invoke("slime:mind:emotionSet", input) as Promise<{ ok: boolean; emotion?: EmotionSnapshot; error?: string }>,
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
});

declare global {
  interface Window {
    slimeAPI: {
chat: {
        stream: (input: ChatInput) => Promise<unknown>;
        newConversation: (agentId: string) => Promise<{ ok: boolean }>;
        retryLast: (agentId: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
        onChunk: (cb: (chunk: StreamChunk) => void) => () => void;
        onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => void) => () => void;
        onError: (cb: (err: { message: string }) => void) => () => void;
      };
      conversations: {
        list: () => Promise<SessionItem[]>;
        load: (sessionId: string) => Promise<ConversationMessage[]>;
        create: (agentId: string, title?: string) => Promise<{ ok: boolean; session?: SessionItem }>;
        rename: (sessionId: string, title: string) => Promise<{ ok: boolean }>;
        remove: (sessionId: string) => Promise<{ ok: boolean }>;
        clear: (sessionId: string) => Promise<{ ok: boolean }>;
        config: (input: { agentId: string; approval?: ApprovalMode; workspace?: string | null }) => Promise<{ ok: boolean; approval: ApprovalMode; workspace: string }>;
        configGet: (agentId: string) => Promise<SessionConfig>;
        pickFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
        removeAgent: (agentId: string) => Promise<{ ok: boolean }>;
      };
      extras: {
        list: () => Promise<ExtrasList>;
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
      window: { minimize: () => Promise<void>; maximize: () => Promise<void>; quit: () => Promise<void> };
      providers: {
        list: () => Promise<ProviderSummary[]>;
        fetchModels: (baseUrl: string, apiKey: string) => Promise<{ ok: boolean; models?: ModelSpec[]; error?: string }>;
        save: (input: { key: string; api_base: string; api_key?: string; model?: string | null; models?: unknown[] }) => Promise<{ ok: boolean; error?: string }>;
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
      mind: {
        configGet: () => Promise<MindConfigInfo>;
        configSet: (patch: { vectorTool?: VectorTool; memoryRoot?: string }) => Promise<{ ok: boolean; vectorTool: VectorTool; memoryRoot: string }>;
        emotionGet: (agentId: string) => Promise<EmotionSnapshot>;
        emotionSet: (input: { agentId: string; valence: number; arousal: number; dominance: number }) => Promise<{ ok: boolean; emotion?: EmotionSnapshot; error?: string }>;
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
    };
  }
}
