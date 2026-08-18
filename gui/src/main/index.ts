/**
 * gui/src/main/index.ts — Electron 主进程（Phase 5 MVP + P0 缺口补齐）。
 * - 窗口/生命周期管理
 * - slime:// 自定义协议加载渲染页面（v2.5 安全基线；Electron 25+ protocol.handle）
 * - 直接加载 core-ts 调度核心（函数调用，非 HTTP 回环）
 * - sidecar spawn/terminate 管理
 * - IPC 通道注册（sender 白名单验证 + contextBridge 封装回传）
 * - P0: chat:new / chat:retry / agents:select / agents:update
 * - 身份移民协议 v1.2: agents:export / agents:import
 *
 * 非破坏性：仅新增于 gui/，不修改 core-ts/gateway-ts/sidecar/legacy。
 */
import "./boot.js"; // 数据根引导：必须最先执行（在 core-ts 模块级常量求值前设置 SLIME_ROOT）
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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

/**
 * 安全基线（官方清单 #17）：所有 IPC handler 统一走 sender 白名单校验。
 * 校验失败直接 reject，渲染层收到 rejected promise。
 */
function handleTrusted<T>(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, payload: T) => unknown,
): void {
  ipcMain.handle(channel, (event, payload: T) => {
    if (!isTrustedSender(event.sender)) {
      throw new Error("sender 校验失败");
    }
    return fn(event, payload);
  });
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

/** 边界校验：渲染层传入的 name/role 必须是非空字符串（防误传对象/恶意输入污染 agents.json） */
function assertAgentNameRole(name: unknown, role: unknown): asserts name is string {
  if (typeof name !== "string" || !name.trim() || typeof role !== "string" || !role.trim()) {
    throw new Error("name/role 必须为非空字符串");
  }
}

async function createAgent(name: string, role: string): Promise<AgentState> {
  assertAgentNameRole(name, role);
  const agents = agentRegistry!.loadedAgents;
  const a = buildAgentState(name.trim(), role.trim(), null);
  agents.push(a);
  await agentRegistry!.save();
  return a;
}

async function forkAgent(parent: AgentState, name: string, role: string): Promise<AgentState> {
  assertAgentNameRole(name, role);
  if ((parent.fork_depth ?? 0) + 1 > 2) {
    throw new Error("分裂深度已达上限（MAX_FORK_DEPTH=2）");
  }
  const child = buildAgentState(name.trim(), role.trim(), parent.id);
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

  handleTrusted<ChatInput>("slime:chat:stream", async (_event, input: ChatInput) => {
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
  handleTrusted<{ agentId: string }>("slime:chat:new", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const { clearHistoryForAgentExport } = await import("../../../core-ts/src/services/history.js");
    await clearHistoryForAgentExport(agentId);
    console.info(`[gui:main] 新对话: agent=${agentId}`);
    return { ok: true };
  });

  /** P0: 重试上条 — 重发最后一条 user 消息 */
  handleTrusted<{ agentId: string }>("slime:chat:retry", async (_event, payload) => {
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

  handleTrusted<void>("slime:stats:snapshot", async () => {
    await ensureServices();
    return (await statsService!.snapshot()) as unknown as StatsSnapshot;
  });

  handleTrusted<boolean>("slime:stats:poll", async (_event, start: boolean) => {
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

  handleTrusted<void>("slime:agents:list", async () => {
    await ensureServices();
    return (await agentRegistry!.loadedAgents).map((a): AgentInfo => ({
      id: a.id, name: a.name, role: a.role,
      children: a.children ?? [], parent_id: a.parent_id ?? null,
      lifecycle: a.lifecycle ?? "unknown",
    }));
  });

  handleTrusted<{ name: string; role: string }>("slime:agents:create", async (_event, params) => {
    await ensureServices();
    const a = await createAgent(params.name, params.role);
    selectedAgentId = a.id;
    mainWindow?.webContents.send("slime:agents:selected", a.id);
    return { id: a.id, name: a.name, role: a.role, children: [], parent_id: null, lifecycle: a.lifecycle ?? "unknown" } as AgentInfo;
  });

  handleTrusted<{ parentId: string; name: string; role: string }>("slime:agents:fork", async (_event, params) => {
    await ensureServices();
    const parent = await agentRegistry!.findAgent(params.parentId);
    if (!parent) { throw new Error("父 Agent 不存在"); }
    const child = await forkAgent(parent, params.name, params.role);
    selectedAgentId = child.id;
    mainWindow?.webContents.send("slime:agents:selected", child.id);
    return { id: child.id, name: child.name, role: child.role, children: [], parent_id: parent.id, lifecycle: child.lifecycle ?? "unknown" } as AgentInfo;
  });

  /** P0: 选中 Agent */
  handleTrusted<{ agentId: string }>("slime:agents:select", async (_event, payload) => {
    selectedAgentId = payload.agentId;
    console.info(`[gui:main] 选中 Agent: ${payload.agentId}`);
    return { ok: true };
  });

  /** P0: 更新 Agent 配置 */
  handleTrusted<{ agentId: string; patch: Record<string, unknown> }>("slime:agents:update", async (_event, payload) => {
    await ensureServices();
    const updated = await agentRegistry!.updateAgent(payload.agentId, payload.patch as Partial<AgentState>);
    if (!updated) { throw new Error(`Agent ${payload.agentId} 不存在`); }
    return { ok: true };
  });

  /** 身份移民协议 v1.2 §4：导出 Agent 为 .slimeagent 身份包 */
  handleTrusted<{ agentId: string }>("slime:agents:export", async (_event, payload) => {
    await ensureServices();
    const agent = agentRegistry!.loadedAgents.find((a) => a.id === payload.agentId);
    if (!agent) { return { ok: false, error: `Agent ${payload.agentId} 不存在` }; }
    const saveOpts = {
      title: "导出 Agent 身份包",
      defaultPath: `${agent.name}.slimeagent`,
      filters: [{ name: "slime Agent 身份包", extensions: ["slimeagent"] }],
    };
    const save = mainWindow
      ? await dialog.showSaveDialog(mainWindow, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (save.canceled || !save.filePath) { return { ok: false, error: "已取消导出" }; }
    const { exportAgent } = await import("../../../core-ts/src/services/export.js");
    const res = await exportAgent({ agentId: payload.agentId, output: save.filePath });
    if (!res.ok) { console.error(`[gui:main] 导出失败: ${res.error}`); }
    return res.ok ? { ok: true, path: res.path } : { ok: false, error: res.error };
  });

  /** 身份移民协议 v1.2 §5：导入 .slimeagent 身份包（冲突策略 §5.2，默认 abort） */
  handleTrusted<{ conflictStrategy?: "abort" | "overwrite" | "keep-old" }>("slime:agents:import", async (_event, payload) => {
    await ensureServices();
    const openOpts: Electron.OpenDialogOptions = {
      title: "导入 Agent 身份包",
      properties: ["openFile"],
      filters: [{ name: "slime Agent 身份包", extensions: ["slimeagent"] }],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消导入" }; }
    const { importAgent, PROJECT_ROOT } = await import("../../../core-ts/src/services/import.js");
    const res = await importAgent({
      input: open.filePaths[0],
      targetRoot: PROJECT_ROOT,
      conflictStrategy: payload.conflictStrategy ?? "abort",
    });
    if (res.ok) {
      // 注册表已被 importAgent 落盘改动，重载内存态并通知渲染层刷新
      await agentRegistry!.load();
      mainWindow?.webContents.send("slime:agents:selected", res.agentId ?? null);
      console.info(`[gui:main] 导入成功: agent=${res.agentId} (${res.agentName})`);
    } else {
      console.error(`[gui:main] 导入失败: ${res.error}`);
    }
    return res;
  });

  handleTrusted<void>("slime:sidecar:status", async () => {
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

  handleTrusted<void>("slime:sidecar:spawn", async () => {
    const mgr = getModelServer();
    if (!mgr) { return; }
    await mgr.startup();
  });

  handleTrusted<void>("slime:sidecar:terminate", async () => {
    const mgr = getModelServer();
    if (!mgr) { return; }
    await mgr.shutdown();
  });

  handleTrusted<void>("slime:window:minimize", () => mainWindow?.minimize());
  handleTrusted<void>("slime:window:quit", () => app.quit());
}

/**
 * 安全基线（官方清单 #18）：slime:// 自定义协议替代 file://。
 * - registerSchemesAsPrivileged 必须在 app ready 之前调用（standard/secure 才能正确解析相对 URL）
 * - protocol.handle 为 Electron 25+ 正式 API（registerFileProtocol 已废弃）
 * - 解析后校验路径仍落在 rendererDir 内，防目录逃逸
 */
function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "slime", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function registerProtocolHandler(): void {
  const rendererDir = resolve(__dirname, "../renderer");
  protocol.handle("slime", (request) => {
    const urlPath = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
    const safePath = resolve(join(rendererDir, urlPath || "index.html"));
    if (!safePath.startsWith(rendererDir + sep)) {
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(safePath).toString());
  });

  app.on("web-contents-created", (_event, webContents) => {
    webContents.on("will-navigate", (e) => e.preventDefault());
    webContents.setWindowOpenHandler(() => ({ action: "deny", overrideLevel: "no" as const }));
  });
}

function main(): void {
  registerSchemePrivileges(); // 必须先于 app ready
  app.whenReady()
    .then(async () => {
      registerProtocolHandler();
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
