/**
 * gui/src/preload/index.ts — preload 层（v2.5/v2.6 安全基线）。
 * - contextIsolation: true / sandbox: true 环境下运行，仅可用 electron 子集 API
 * - contextBridge 唯一暴露窗口：window.slimeAPI（封装回调，不暴露原始 ipcRenderer）
 * - IPC 接收侧白名单验证由主进程 onMessage 处理完成；渲染层仅收可信类型
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus } from "../shared/ipc.js";

/** 监听 ipcRenderer 事件→回掉，自动注销；渲染层拿到 cleanup() */
function onMessage<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("slimeAPI", {
  chat: {
    stream: (input: ChatInput) => ipcRenderer.invoke("slime:chat:stream", input),
    onChunk: (cb: (chunk: StreamChunk) => void) => onMessage<StreamChunk>("slime:chat:chunk", cb),
    onDone: (cb: (meta: { reply: string; model: string; elapsedMs: number }) => void) =>
      onMessage<{ reply: string; model: string; elapsedMs: number }>("slime:chat:done", cb),
    onError: (cb: (err: { message: string }) => void) => onMessage<{ message: string }>("slime:chat:error", cb),
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
        onChunk: (cb: (chunk: StreamChunk) => void) => () => void;
        onDone: (cb: (meta: { reply: string; model: string; elapsedMs: number }) => void) => () => void;
        onError: (cb: (err: { message: string }) => void) => () => void;
      };
      stats: {
        snapshot: () => Promise<StatsSnapshot>;
        onPoll: (cb: (snapshot: StatsSnapshot) => void) => () => void;
      };
      agents: {
        list: () => Promise<AgentInfo[]>;
        create: (name: string, role: string) => Promise<AgentInfo>;
        fork: (parentId: string, name: string, role: string) => Promise<AgentInfo>;
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
