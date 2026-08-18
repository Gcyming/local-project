/**
 * gui/src/main/index.ts — Electron 主进程（Phase 5 MVP + P0 缺口补齐）。
 * - 窗口/生命周期管理
 * - slime:// 自定义协议加载渲染页面（v2.5 安全基线）
 * - 直接加载 core-ts 调度核心（函数调用，非 HTTP 回环）
 * - sidecar spawn/terminate 管理
 * - IPC 通道注册（sender 白名单验证 + contextBridge 封装回传）
 * - P0: chat:new / chat:retry / agents:select / agents:update
 *
 * 非破坏性：仅新增于 gui/，不修改 core-ts/gateway-ts/sidecar/legacy。
 */
import { app, BrowserWindow, ipcMain, session } from "electron";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getModelServer } from "../../../core-ts/src/model_server.js";
import { ChatService } from "../../../core-ts/src/services/chat.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine } from "../../../core-ts/src/services/engine.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus } from "../shared/ipc.js";

let mainWindow: BrowserWindow | null = null;
let chatService: ChatService | null = null;
let statsService: StatsService | null = null;
let agentRegistry: AgentRegistry | null = null;
let statsPoll: NodeJS.Timeout | null = null;
/** P0: 当前选中 Agent ID（渲染层通过 agents:select 设置） */
let selectedAgentId: string | null = null;

function isTrustedSender(sender: Electron.WebContents): boolean {
  if (!mainWindow) {
    return false;
  }
  try {
    return sender.id === mainWindow.webContents.id;
  } catch {
    return false;
  }
}

async function ensureServices(): Promise<void> {
  if (chatService) {
    return;
  }
  agentRegistry = new AgentRegistry();
  await agentRegistry.load();
  const engine = createEngine({ registry: agentRegistry });
  chatService = new ChatService({ registry: agentRegistry, engine });
  statsService = new StatsService(agentRegistry);
  console.info("[gui:main] core-ts 服务已加载（ChatService/StatsService）");
}

function buildAgentState(name: string, role: string, parentId: string | null = null): AgentState {
  return {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    name,
    role,
    identity_prompt: `I am ${name}, ${role}.`,
    model_choice: "inherit",
    parent_id: parentId,
    persona: { traits: [], preferences: [], skill_ownership: [], interactions: [], created_at: null, updated_at: null },
    emotion: { mood: "neutral" },
    behavior: { active: [] },
    children: [],
    created_at: new Date().toISOString(),
    lifecycle: "growth",
  } as AgentState;
}

async function createAgent(name: string, role: string): Promise<AgentState> {
  const agents = agentRegistry!.loadedAgents;
  const a = buildAgentState(name, role, null);
  agents.push(a);
  await agentRegistry!.save();
  return a;
}

async function forkAgent(parent: AgentState, name: string, role: string): Promise<AgentState> {
  if ((parent.fork_depth ?? 0) + 1 > 2) {
    throw new Error("分裂深度已达上限（MAX_FORK_DEPTH=2）");
  }
  const child = buildAgentState(name, role, parent.id);
  child.model_choice = parent.model_choice;
  child.fork_depth = (parent.fork_depth ?? 0) + 1;
  parent.children.push(child.id);
  const agents = agentRegistry!.loadedAgents;
  agents.push(child);
  await agentRegistry!.save();
  return child;
}

function createStreamSession() {
  let fullReply = "";
  let model = "";
  let elapsedMs = 0;
  const timings: Record<string, number> = {};
  return {
    pushChunk(chunk: StreamChunk) {
      if (chunk.data.content) fullReply += chunk.data.content;
      if (chunk.data.model) model = chunk.data.model;
      if (chunk.data.elapsedMs) elapsedMs = chunk.data.elapsedMs;
      if (chunk.data.timings) Object.assign(timings, chunk.data.timings);
    },
    get fullReply() { return fullReply; },
    get model() { return model; },
    get elapsedMs() { return elapsedMs; },
    get timings() { return timings; },
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 560, show: false,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      preload: join(__dirname, "../preload/index.js"), webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
}

function registerIpcHandlers(): void {
  /** 获取当前选中 Agent ID（优先渲染层传入，回退到第一个 root Agent） */
  function resolveAgentId(inputAgentId: string | undefined): string {
    if (inputAgentId) { return inputAgentId; }
    if (selectedAgentId) { return selectedAgentId; }
    // 回退：取第一个 root Agent
    const roots = agentRegistry!.loadedAgents.filter((a) => !a.parent_id);
    return roots[0]?.id ?? "primary";
  }

  ipcMain.handle("slime:chat:stream", async (event, input: ChatInput) => {
    if (!isTrustedSender(event.sender)) {
      return { ok: false, error: "sender 校验失败" };
    }
    await ensureServices();
    const agentId = resolveAgentId(input.agentId);
    const req: ChatRequest = {
      message: input.message,
      history: input.history ? (input.history as any) : [],
      retry: false,
      maxTokens: input.maxTokens,
    };
    const session = createStreamSession();
    void (async () => {
      for await (const ev of chatService!.stream(agentId, req, input.resumeSeq ?? 0)) {
        const chunk: StreamChunk = { seq: ev.seq, type: ev.type as StreamChunk["type"], data: ev.data as StreamChunk["data"] };
        session.pushChunk(chunk);
        mainWindow?.webContents.send("slime:chat:chunk", chunk);
      }
      mainWindow?.webContents.send("slime:chat:done", {
        reply: session.fullReply, model: session.model,
        elapsedMs: session.elapsedMs, timings: session.timings,
      });
    })().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] chat stream error:", msg);
      mainWindow?.webContents.send("slime:chat:error", { message: msg });
    });
    return { ok: true };
  });

  /** P0: 新对话 — 清空历史文件并重置本地状态 */
  ipcMain.handle("slime:chat:new", async (_event, payload: { agentId: string }) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const { clearHistoryForAgentExport } = await import("../../../core-ts/src/services/history.js");
    await clearHistoryForAgentExport(agentId);
    console.info(`[gui:main] 新对话: agent=${agentId}`);
    return { ok: true };
  });

  /** P0: 重试上条 — 重发最后一条 user 消息 */
  ipcMain.handle("slime:chat:retry", async (_event, payload: { agentId: string }) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const { popLastRecordForAgentExport } = await import("../../../core-ts/src/services/history.js");
    const last = await popLastRecordForAgentExport(agentId);
    if (!last || !last.user) {
      return { ok: false, error: "无历史可重试" };
    }
    const req: ChatRequest = { message: last.user, history: [], retry: true };
    const session = createStreamSession();
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      void (async () => {
        try {
          for await (const ev of chatService!.stream(agentId, req, 0)) {
            const chunk: StreamChunk = { seq: ev.seq, type: ev.type as StreamChunk["type"], data: ev.data as StreamChunk["data"] };
            session.pushChunk(chunk);
            mainWindow?.webContents.send("slime:chat:chunk", chunk);
          }
          mainWindow?.webContents.send("slime:chat:done", {
            reply: session.fullReply, model: session.model,
            elapsedMs: session.elapsedMs, timings: session.timings,
          });
          resolve({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[gui:main] chat retry error:", msg);
          mainWindow?.webContents.send("slime:chat:error", { message: msg });
          resolve({ ok: false, error: msg });
        }
      })();
    });
  });

  ipcMain.handle("slime:stats:snapshot", async () => {
    await ensureServices();
    return (await statsService!.snapshot()) as unknown as StatsSnapshot;
  });

  ipcMain.handle("slime:stats:poll", async (_event, start: boolean) => {
    if (start) {
      if (statsPoll) clearInterval(statsPoll);
      statsPoll = setInterval(async () => {
        const snap = await statsService!.snapshot();
        mainWindow?.webContents.send("slime:stats:update", snap);
      }, 3000);
    } else if (statsPoll) {
      clearInterval(statsPoll);
      statsPoll = null;
    }
    return { ok: true };
  });

  ipcMain.handle("slime:agents:list", async () => {
    await ensureServices();
    return (await agentRegistry!.loadedAgents).map((a): AgentInfo => ({
      id: a.id, name: a.name, role: a.role,
      children: a.children ?? [], parent_id: a.parent_id ?? null,
      lifecycle: a.lifecycle ?? "unknown",
    }));
  });

  ipcMain.handle("slime:agents:create", async (_event, params: { name: string; role: string }) => {
    await ensureServices();
    const a = await createAgent(params.name, params.role);
    selectedAgentId = a.id;
    mainWindow?.webContents.send("slime:agents:selected", a.id);
    return { id: a.id, name: a.name, role: a.role, children: [], parent_id: null, lifecycle: a.lifecycle ?? "unknown" } as AgentInfo;
  });

  ipcMain.handle("slime:agents:fork", async (_event, params: { parentId: string; name: string; role: string }) => {
    await ensureServices();
    const parent = await agentRegistry!.findAgent(params.parentId);
    if (!parent) { throw new Error("父 Agent 不存在"); }
    const child = await forkAgent(parent, params.name, params.role);
    selectedAgentId = child.id;
    mainWindow?.webContents.send("slime:agents:selected", child.id);
    return { id: child.id, name: child.name, role: child.role, children: [], parent_id: parent.id, lifecycle: child.lifecycle ?? "unknown" } as AgentInfo;
  });

  /** P0: 选中 Agent */
  ipcMain.handle("slime:agents:select", async (_event, payload: { agentId: string }) => {
    selectedAgentId = payload.agentId;
    console.info(`[gui:main] 选中 Agent: ${payload.agentId}`);
    return { ok: true };
  });

  /** P0: 更新 Agent 配置 */
  ipcMain.handle("slime:agents:update", async (_event, payload: { agentId: string; patch: Record<string, unknown> }) => {
    await ensureServices();
    const updated = await agentRegistry!.updateAgent(payload.agentId, payload.patch as Partial<AgentState>);
    if (!updated) { throw new Error(`Agent ${payload.agentId} 不存在`); }
    return { ok: true };
  });

  ipcMain.handle("slime:sidecar:status", async () => {
    const mgr = getModelServer();
    if (!mgr) { return { running: false } as SidecarStatus; }
    const items = mgr.status();
    const primary = items.find((i) => i.role === "inference") ?? items[0];
    if (!primary) { return { running: false } as SidecarStatus; }
    const vram = primary.vram_gb as { used_gb?: number } | null | undefined;
    return {
      running: primary.state === "idle" || primary.state === "loading" || primary.state === "ready" || primary.state === "unloading",
      port: primary.port, model: primary.model,
      vram: vram?.used_gb, pid: primary.pid ?? undefined,
    } as SidecarStatus;
  });

  ipcMain.handle("slime:sidecar:spawn", async () => {
    const mgr = getModelServer();
    if (!mgr) { return; }
    await mgr.startup();
  });

  ipcMain.handle("slime:sidecar:terminate", async () => {
    const mgr = getModelServer();
    if (!mgr) { return; }
    await mgr.shutdown();
  });

  ipcMain.handle("slime:window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("slime:window:quit", () => app.quit());
}

async function registerProtocol(): Promise<void> {
  const rendererDir = resolve(__dirname, "../renderer");
  await app.whenReady().then(() =>
    session.defaultSession.protocol.registerFileProtocol("slime", (request) => {
      const urlPath = new URL(request.url).pathname.replace(/^\//, "");
      const safePath = join(rendererDir, urlPath || "index.html");
      return { path: safePath, module: "file" };
    }),
  );

  app.on("web-contents-created", (_event, webContents) => {
    webContents.on("will-navigate", (e) => e.preventDefault());
    webContents.setWindowOpenHandler(() => ({ action: "deny", overrideLevel: "no" as const }));
  });
}

function main(): void {
  app.whenReady()
    .then(async () => {
      await registerProtocol();
      createWindow();
      registerIpcHandlers();
      mainWindow?.loadURL("slime://./index.html");
      mainWindow?.webContents.on("did-finish-load", () => {
        console.info("[gui:main] 渲染层已加载 (slime://)");
      });
    })
    .catch((e) => { console.error("[gui:main] 启动失败:", e); process.exit(1); });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") { app.quit(); }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  });
}

void main();
