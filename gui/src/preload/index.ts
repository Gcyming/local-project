/**
 * gui/src/preload/index.ts — preload 层（v2.5/v2.6 安全基线）。
 * - contextIsolation: true / sandbox: true 环境下运行，仅可用 electron 子集 API
 * - contextBridge 唯一暴露窗口：window.slimeAPI（封装回调，不暴露原始 ipcRenderer）
 * - IPC 接收侧白名单验证由主进程 onMessage 处理完成；渲染层仅收可信类型
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type {
  StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus,
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
    retryLast: (agentId: string) =>
      ipcRenderer.invoke("slime:chat:retry", { agentId }) as Promise<{ ok: boolean; error?: string }>,
    onChunk: (cb: (chunk: StreamChunk) => void) => onMessage<StreamChunk>("slime:chat:chunk", cb),
    onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => void) =>
      onMessage<{ reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }>(
        "slime:chat:done", cb,
      ),
    onError: (cb: (err: { message: string }) => void) =>
      onMessage<{ message: string }>("slime:chat:error", cb),
  },
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
    /** P0: 更新 Agent 配置（model_choice / mode / reasoning_effort / show_thinking） */
    update: (agentId: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke("slime:agents:update", { agentId, patch }) as Promise<{ ok: boolean }>,
    /** P0: 监听主进程推送的选中事件（创建/分裂后自动切换） */
    onAgentSelected: (cb: (agentId: string) => void) => onMessage<string>("slime:agents:selected", cb),
  },
  sidecar: {
    status: () => ipcRenderer.invoke("slime:sidecar:status") as Promise<SidecarStatus>,
    spawn: () => ipcRenderer.invoke("slime:sidecar:spawn"),
    terminate: () => ipcRenderer.invoke("slime:sidecar:terminate"),
    onStatus: (cb: (status: SidecarStatus) => void) => onMessage<SidecarStatus>("slime:sidecar:update", cb),
  },
  window: {
    minimize: () => ipcRenderer.invoke("slime:window:minimize"),
    quit: () => ipcRenderer.invoke("slime:window:quit"),
  },
});

declare global {
  interface Window {
    slimeAPI: {
      chat: {
        stream: (input: ChatInput) => Promise<void>;
        newConversation: (agentId: string) => Promise<{ ok: boolean }>;
        retryLast: (agentId: string) => Promise<{ ok: boolean; error?: string }>;
        onChunk: (cb: (chunk: StreamChunk) => void) => () => void;
        onDone: (cb: (m: { reply: string; model: string; elapsedMs: number; timings?: Record<string, number> }) => void) => () => void;
        onError: (cb: (err: { message: string }) => void) => () => void;
      };
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
        update: (agentId: string, patch: Record<string, unknown>) => Promise<{ ok: boolean }>;
        onAgentSelected: (cb: (agentId: string) => void) => () => void;
      };
      sidecar: {
        status: () => Promise<SidecarStatus>;
        spawn: () => Promise<void>;
        terminate: () => Promise<void>;
        onStatus: (cb: (status: SidecarStatus) => void) => () => void;
      };
      window: { minimize: () => Promise<void>; quit: () => Promise<void> };
    };
  }
}
