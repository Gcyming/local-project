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
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { getModelServer } from "../../../core-ts/src/model_server.js";
import { ChatService } from "../../../core-ts/src/services/chat.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine } from "../../../core-ts/src/services/engine.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus } from "../shared/ipc.js";
import { initUpdater, registerUpdaterHandlers, setStatusSink } from "./updater.js";
import {
  listProviders, fetchModels, saveProvider, removeProvider,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
  type ProviderSummary, type LocalModelSpec,
} from "./providers.js";
import { overview as configOverview, readConfigFile, writeConfigFile } from "./config_files.js";
import { SlimeEngine } from "../../../core-ts/src/services/engine.js";
import { removeAgentHistory, loadHistory } from "../../../core-ts/src/services/history.js";
import { SkillRegistry } from "../../../core-ts/src/skills.js";
import { getRegistry } from "../../../core-ts/src/tools/registry.js";
import { MemoryStore } from "../../../core-ts/src/memory/store.js";
import { retrieveFromStore, formatMemoryItems } from "../../../core-ts/src/memory/retrieve.js";
import { EmotionalState, topKForMood } from "../../../core-ts/src/mind/emotion.js";
import { BehaviorStore } from "../../../core-ts/src/mind/behavior.js";
import { buildMindSegments } from "../../../core-ts/src/mind/hooks.js";
import { loadMindConfig, saveMindConfig, readDepStatus, detectLocalDeps, updateTomlKey } from "./mind_config.js";
import {
  startDownload, controlDownload, downloadSnapshot, setDownloadListener, tryRelocateDownloads,
  type DownloadTarget, type DownloadProgress,
} from "./downloader.js";
import {
  listSessions, getSession, createSession, renameSession, removeSession,
  ensureDefaultSession, removeSessionsForAgent, touchSessionWithMessage,
} from "../../../core-ts/src/services/sessions.js";
import { loadHistoryForSession, clearSessionHistory } from "../../../core-ts/src/services/history.js";
import { SandboxManager, defaultSandboxConfig, type SandboxConfig } from "../../../core-ts/src/sandbox.js";

let mainWindow: BrowserWindow | null = null;
let chatService: ChatService | null = null;
let statsService: StatsService | null = null;
let agentRegistry: AgentRegistry | null = null;
let engine: SlimeEngine | null = null;
let sandbox: SandboxManager | null = null;
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
  sandbox = new SandboxManager();
  // 审批确认弹窗（原生同步对话框；"需确认"档位 L2-L4 操作走这里，阻塞等待用户点选）
  sandbox.setApprovalCallback((req) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      return {
        requestId: req.requestId, approved: false, approvedActions: [], deniedActions: [req.actions[0].action],
        reason: "无窗口", autoApproved: false,
      };
    }
    const a = req.actions[0];
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: `权限请求 — ${req.agentName}`,
      message: `${req.agentName} 请求执行操作`,
      detail: `${a.action}\n目标：${a.target}\n权限等级：L${a.level}${req.taskDescription ? `\n任务：${req.taskDescription}` : ""}`,
      buttons: ["批准", "拒绝"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return {
      requestId: req.requestId, approved: choice === 0,
      approvedActions: choice === 0 ? [a.action] : [],
      deniedActions: choice === 0 ? [] : [a.action],
      reason: choice === 0 ? "" : "用户拒绝",
      autoApproved: false,
    };
  });
  // 从 agents.json sandbox_override 恢复会话级沙箱配置（workspace/审批档位）
  for (const a of agentRegistry.loadedAgents) {
    if (a.sandbox_override && typeof a.sandbox_override === "object") {
      try {
        sandbox.setAgentConfig(a.id, sandboxConfigFromOverride(a.sandbox_override));
      } catch (e) {
        console.warn(`[gui:main] 恢复沙箱配置失败 ${a.id}:`, e);
      }
    }
  }
  engine = createEngine({
    registry: agentRegistry,
    sandbox,
    hooks: {
      fixedSegments: (agent) => {
        try {
          const a = agentRegistry!.loadedAgents.find((x) => x.name === agent.name);
          const emotion = new EmotionalState((a?.emotion as Record<string, unknown>) ?? undefined);
          const behavior = BehaviorStore.fromDict(a?.behavior ?? {});
          return buildMindSegments(emotion, behavior);
        } catch (e) {
          console.warn(`[gui:mind] 心智固定段注入失败: ${e}`);
          return [];
        }
      },
      retrieveSegments: async (agentId: string, query: string) => {
        try {
          const agent = await agentRegistry!.findAgent(agentId);
          const emotion = new EmotionalState((agent?.emotion as Record<string, unknown>) ?? undefined);
          const res = await retrieveFromStore(memoryStoreFor(agentId), {
            query,
            topK: topKForMood(emotion.mood),
            maxHops: 2,
          });
          const seg = formatMemoryItems(res.items);
          return seg ? [seg] : [];
        } catch (e) {
          console.warn(`[gui:mind] 记忆检索失败（静默降级为空）: ${e}`);
          return [];
        }
      },
    },
  });
  chatService = new ChatService({ registry: agentRegistry, engine });
  statsService = new StatsService(agentRegistry);
  // 依赖下载进度 → 渲染层（下载条 UI）
  setDownloadListener((p: DownloadProgress) => {
    mainWindow?.webContents.send("slime:mind:downloadProgress", p);
  });
  console.info("[gui:main] core-ts 服务已加载（ChatService/StatsService + SandboxManager）");
}

// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────

/** BGE-M3 真实嵌入（llama-server 8999 /v1/embeddings，OpenAI 兼容；失败由 MemoryStore 降级哈希） */
function bgeEmbed(): { embed: (text: string) => Promise<number[]> } {
  return {
    embed: async (text: string): Promise<number[]> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch("http://127.0.0.1:8999/v1/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "bge-m3", input: text }),
          signal: ctrl.signal,
        });
        if (!resp.ok) {
          throw new Error(`embeddings HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
        const vec = data.data?.[0]?.embedding;
        if (!vec || vec.length === 0) {
          throw new Error("embeddings 空响应");
        }
        return vec;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 每 Agent 记忆存储缓存（LanceDB 初始化失败自动降级 JSON；嵌入失败自动降级哈希） */
const memoryStores = new Map<string, MemoryStore>();

function memoryStoreFor(agentId: string): MemoryStore {
  let s = memoryStores.get(agentId);
  if (!s) {
    const cfg = loadMindConfig();
    s = new MemoryStore(agentId, {
      lancedbEnabled: true,
      dataDir: cfg.memoryRoot || undefined,
      embed: cfg.vectorTool === "bge" ? bgeEmbed() : undefined,
    });
    memoryStores.set(agentId, s);
    if (memoryStores.size > 40) {
      memoryStores.clear();
    }
  }
  return s;
}

/** 审批档位 → SandboxConfig（会话级持久化格式：sandbox_override 存 approval 档位 + workspace） */
const APPROVAL_MODES = ["auto", "confirm", "strict"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

function sandboxConfigFromOverride(ov: Record<string, unknown>): SandboxConfig {
  const cfg = defaultSandboxConfig();
  const mode = (ov.approval as ApprovalMode) ?? "auto";
  if (mode === "auto") {
    cfg.auto_approve_levels = [0, 1, 2, 3, 4];
    cfg.require_approval_levels = [];
    cfg.deny_levels = [5];
  } else if (mode === "confirm") {
    cfg.auto_approve_levels = [0, 1];
    cfg.require_approval_levels = [2, 3, 4];
    cfg.deny_levels = [5];
  } else {
    cfg.auto_approve_levels = [0];
    cfg.require_approval_levels = [1, 2, 3, 4];
    cfg.deny_levels = [5];
  }
  cfg.workspace = typeof ov.workspace === "string" ? ov.workspace : "";
  return cfg;
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
    // Campanula 式自绘标题栏：隐藏系统标题栏，Windows overlay 渲染窗口按钮
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1e293b", symbolColor: "#e2e8f0", height: 40 },
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

  /** 会话上下文加载（注入聊天请求；会话隔离，旧记录归首个会话） */
  async function loadSessionHistory(sessionId: string | undefined): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    if (!sessionId) { return []; }
    try {
      const meta = await getSession(sessionId);
      if (!meta) { return []; }
      const agentSessions = (await listSessions()).filter((m) => m.agentId === meta.agentId);
      const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
      const records = await loadHistoryForSession(meta.agentId, meta.id, 50, firstSession);
      return records.flatMap((r) => [
        { role: "user" as const, content: r.user },
        { role: "assistant" as const, content: r.ai },
      ]);
    } catch (e) {
      console.warn("[gui:main] 会话上下文加载失败:", e);
      return [];
    }
  }

  handleTrusted<ChatInput>("slime:chat:stream", async (_event, input: ChatInput) => {
    await ensureServices();
    const agentId = resolveAgentId(input.agentId);
    let history = input.history ? (input.history as any) : [];
    // 会话上下文注入：无显式 history 时按 session_id 加载
    if (history.length === 0) {
      history = await loadSessionHistory(input.sessionId);
    }
    const req: ChatRequest = {
      message: input.message,
      history,
      retry: false,
      maxTokens: input.maxTokens,
      sessionId: input.sessionId,
    };
    const session = createStreamSession();
    void (async () => {
      for await (const ev of chatService!.stream(agentId, req, input.resumeSeq ?? 0)) {
        const chunk: StreamChunk = { seq: ev.seq, type: ev.type as StreamChunk["type"], data: ev.data as StreamChunk["data"] };
        session.pushChunk(chunk);
        mainWindow?.webContents.send("slime:chat:chunk", chunk);
      }
      if (input.sessionId) {
        await touchSessionWithMessage(input.sessionId, input.message).catch(() => undefined);
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
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:chat:retry", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const { popLastRecordForAgentExport } = await import("../../../core-ts/src/services/history.js");
    const last = await popLastRecordForAgentExport(agentId, payload.sessionId);
    if (!last || !last.user) {
      return { ok: false, error: "无历史可重试" };
    }
    const req: ChatRequest = {
      message: last.user,
      history: await loadSessionHistory(payload.sessionId),
      retry: true,
      sessionId: payload.sessionId,
    };
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

  /* ── 会话管理（侧栏对话列表：项目 = Agent，项目内独立会话） ── */

  /** 会话列表：sessions.json 元数据 ∪ history 记录（按 session_id 聚合） */
  handleTrusted<void>("slime:sessions:list", async () => {
    await ensureServices();
    const [metas, records] = await Promise.all([
      listSessions(),
      loadHistory(null, 100000),
    ]);
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    // 历史按 (agent_id, session_id ?? 默认会话) 聚合
    const byKey = new Map<string, { agentId: string; count: number; firstUser: string; lastTime: string }>();
    for (const r of records) {
      const key = `${r.agent_id}::${r.session_id ?? "default"}`;
      const agg = byKey.get(key) ?? { agentId: r.agent_id, count: 0, firstUser: "", lastTime: "" };
      agg.count += 1;
      if (!agg.firstUser) { agg.firstUser = r.user; }
      if (r.timestamp > agg.lastTime) { agg.lastTime = r.timestamp; }
      byKey.set(key, agg);
    }
    const items: Array<{ sessionId: string; agentId: string; agentName: string; title: string; count: number; lastTime: string }> = [];
    for (const meta of metas) {
      // 旧记录（无 session_id）按 "default" 聚合，归入该 Agent 首个会话
      const agg = byKey.get(`${meta.agentId}::${meta.id}`) ?? byKey.get(`${meta.agentId}::default`);
      items.push({
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        title: meta.title,
        count: agg?.count ?? 0,
        lastTime: agg?.lastTime ?? meta.updatedAt,
      });
    }
    // 无会话元数据的旧历史（惰性迁移：为该 Agent 建默认会话）
    for (const [key, agg] of byKey) {
      const agentId = key.split("::")[0];
      if (!metas.some((m) => m.agentId === agentId)) {
        const meta = await ensureDefaultSession(agentId);
        items.push({
          sessionId: meta.id,
          agentId,
          agentName: names.get(agentId) ?? agentId,
          title: meta.title === "新对话" ? (agg.firstUser || "新对话").slice(0, 60) : meta.title,
          count: agg.count,
          lastTime: agg.lastTime,
        });
      }
    }
    return items.sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1));
  });

  /** 新建会话（项目内独立会话，默认标题"新对话"） */
  handleTrusted<{ agentId: string; title?: string }>("slime:sessions:create", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    if (!agent) { throw new Error("Agent 不存在"); }
    const meta = await createSession(payload.agentId, payload.title);
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    console.info(`[gui:main] 新建会话: agent=${payload.agentId} session=${meta.id}`);
    return {
      ok: true,
      session: {
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        title: meta.title,
        count: 0,
        lastTime: meta.updatedAt,
      },
    };
  });

  /** 重命名会话 */
  handleTrusted<{ sessionId: string; title: string }>("slime:sessions:rename", async (_event, payload) => {
    await ensureServices();
    const meta = await renameSession(payload.sessionId, payload.title);
    return { ok: !!meta };
  });

  /** 删除会话（清元数据 + 清该会话历史） */
  handleTrusted<{ sessionId: string }>("slime:sessions:remove", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    const removed = await removeSession(payload.sessionId);
    if (meta) {
      await clearSessionHistory(meta.agentId, meta.id);
    }
    console.info(`[gui:main] 会话已删除: session=${payload.sessionId}`);
    return { ok: removed };
  });

  /** 加载某会话的完整消息（聊天面板显示历史） */
  handleTrusted<{ sessionId: string }>("slime:sessions:load", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return []; }
    const metas = await listSessions();
    const agentSessions = metas.filter((m) => m.agentId === meta.agentId);
    // 旧记录（无 session_id）归入创建最早的会话
    const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
    const records = await loadHistoryForSession(meta.agentId, meta.id, 500, firstSession);
    const messages: Array<{ role: "user" | "assistant"; content: string; time: string }> = [];
    for (const r of records) {
      if (r.user) {
        messages.push({ role: "user", content: r.user, time: r.timestamp });
      }
      if (r.ai) {
        messages.push({ role: "assistant", content: r.ai, time: r.timestamp });
      }
    }
    return messages;
  });

  /** 清空会话历史（保留会话条目与标题） */
  handleTrusted<{ sessionId: string }>("slime:sessions:clear", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return { ok: false }; }
    await clearSessionHistory(meta.agentId, meta.id);
    console.info(`[gui:main] 会话已清空: session=${payload.sessionId}`);
    return { ok: true };
  });

  /** 会话级配置：审批模式 + 工作目录（持久化到 agents.json sandbox_override + 内存沙箱同步） */
  handleTrusted<{ agentId: string; approval?: ApprovalMode; workspace?: string | null }>(
    "slime:sessions:config",
    async (_event, payload) => {
      await ensureServices();
      const agent = await agentRegistry!.findAgent(payload.agentId);
      if (!agent) { throw new Error("Agent 不存在"); }
      const prev = (agent.sandbox_override && typeof agent.sandbox_override === "object")
        ? { ...agent.sandbox_override }
        : { approval: "auto" as ApprovalMode };
      const next: Record<string, unknown> = { ...prev };
      if (payload.approval) { next.approval = payload.approval; }
      if (payload.workspace !== undefined) { next.workspace = payload.workspace ?? ""; }
      await agentRegistry!.updateAgent(payload.agentId, { sandbox_override: next });
      sandbox!.setAgentConfig(payload.agentId, sandboxConfigFromOverride(next));
      return { ok: true, approval: next.approval as ApprovalMode, workspace: next.workspace as string };
    },
  );

  /** 会话级配置读取（审批模式 + 工作目录） */
  handleTrusted<{ agentId: string }>("slime:sessions:configGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const ov = agent?.sandbox_override;
    if (!ov || typeof ov !== "object") {
      return { approval: "auto" as ApprovalMode, workspace: "" };
    }
    return {
      approval: (ov.approval as ApprovalMode) ?? "auto",
      workspace: typeof ov.workspace === "string" ? ov.workspace : "",
    };
  });

  /** 选择工作目录（项目文件夹） */
  handleTrusted<void>("slime:sessions:pickFolder", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择项目工作目录（Agent 的读写将限制在此目录内）",
      properties: ["openDirectory", "createDirectory"],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  /** 删除 Agent 时清理其全部会话元数据 */
  handleTrusted<{ agentId: string }>("slime:sessions:removeAgent", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId;
    await removeSessionsForAgent(agentId);
    await removeAgentHistory(agentId);
    console.info(`[gui:main] 项目已删除（会话+历史清理）: agent=${agentId}`);
    return { ok: true };
  });

  /** 加号/命令面板：技能 + MCP 工具列表 */
  handleTrusted<void>("slime:extras:list", async () => {
    await ensureServices();
    const skills: Array<{ name: string; description: string }> = [];
    try {
      const skillReg = new SkillRegistry();
      await skillReg.loadSkills();
      for (const schema of skillReg.listSkills() as Array<{ function?: { name?: string; description?: string } }>) {
        skills.push({
          name: schema.function?.name ?? "?",
          description: schema.function?.description ?? "",
        });
      }
    } catch (e) {
      console.warn("[gui:main] 技能列表加载失败:", e);
    }
    const mcpTools: Array<{ name: string; description: string }> = [];
    try {
      for (const schema of getRegistry().listTools() as Array<{ function?: { name?: string; description?: string } }>) {
        const name = schema.function?.name ?? "";
        if (name.startsWith("mcp_")) {
          mcpTools.push({ name, description: schema.function?.description ?? "" });
        }
      }
    } catch (e) {
      console.warn("[gui:main] MCP 工具列表加载失败:", e);
    }
    return { skills, mcpTools };
  });

  /** 输入联想：检索历史会话中相似的用户消息 */
  handleTrusted<{ text: string }>("slime:chat:suggest", async (_event, payload) => {
    await ensureServices();
    const text = (payload.text ?? "").trim();
    if (!text) {
      return [];
    }
    const records = await loadHistory(null, 1000);
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const hits = records
      .filter((r) => r.user && r.user.includes(text) && r.user !== text)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 6)
      .map((r) => ({
        content: r.user.slice(0, 140),
        agentName: names.get(r.agent_id) ?? r.agent_id,
        time: r.timestamp,
      }));
    return hits;
  });

  handleTrusted<void>("slime:stats:snapshot", async () => {
    await ensureServices();
    return (await statsService!.snapshot()) as unknown as StatsSnapshot;
  });

  // ── 心智中枢 IPC ────────────────────────────────────────

  /** 配置读取：向量工具 / 记忆位置 / 依赖状态（模型文件不在 git 仓库，换设备需手动就位） */
  handleTrusted<void>("slime:mind:configGet", async () => {
    // 收尾归位：downloads/ 下已完成的文件自动放到配置路径（含 llama_bin 自动改写）
    try {
      tryRelocateDownloads();
    } catch (e) {
      console.warn(`[gui:mind] 归位收尾异常: ${e}`);
    }
    const cfg = loadMindConfig();
    return {
      vectorTool: cfg.vectorTool,
      memoryRoot: cfg.memoryRoot,
      memoryPaths: {
        knowledge: resolve(PROJECT_ROOT, "Knowledge", "Agent Memory"),
        lance: resolve(PROJECT_ROOT, "data", "<agentId>", "lancedb"),
      },
      deps: readDepStatus(),
    };
  });

  /** 配置保存：向量工具（bge=真实 BGE-M3 嵌入 / basic=哈希占位）+ 记忆根路径（重启生效） */
  handleTrusted<{ vectorTool?: string; memoryRoot?: string }>("slime:mind:configSet", async (_event, payload) => {
    const cfg = saveMindConfig({
      vectorTool: payload.vectorTool === "basic" || payload.vectorTool === "bge" ? payload.vectorTool : undefined,
      memoryRoot: payload.memoryRoot,
    });
    memoryStores.clear();
    return { ok: true, vectorTool: cfg.vectorTool, memoryRoot: cfg.memoryRoot };
  });

  /** 依赖定位：auto=项目文件夹内自动检索；pick=手动选择文件/目录。命中即写入 slime.toml */
  handleTrusted<{ mode: "auto" | "pick"; key: "llama_bin" | "model_path" | "models_dir" }>(
    "slime:mind:locateDep",
    async (_event, payload) => {
      let picked: string | null = null;
      if (payload.mode === "pick") {
        const isDir = payload.key === "models_dir";
        const opts: Electron.OpenDialogOptions = isDir
          ? { title: "选择本地聊天模型目录", properties: ["openDirectory"] }
          : {
              title: payload.key === "llama_bin" ? "选择 llama-server.exe" : "选择嵌入模型 GGUF 文件",
              properties: ["openFile"],
              filters: payload.key === "llama_bin"
                ? [{ name: "llama-server", extensions: ["exe"] }]
                : [{ name: "GGUF 模型", extensions: ["gguf"] }],
            };
        const r = await dialog.showOpenDialog(mainWindow!, opts);
        picked = r.canceled ? null : (r.filePaths[0] ?? null);
      } else {
        const found = detectLocalDeps();
        picked = payload.key === "llama_bin" ? found.llamaBin : payload.key === "model_path" ? found.bgeModel : found.chatDir;
      }
      if (!picked) {
        return { found: false, deps: readDepStatus() };
      }
      const written = updateTomlKey(payload.key, picked);
      memoryStores.clear();
      return { found: true, written, deps: readDepStatus() };
    },
  );

  /** 情绪读取：Agent 当前 PAD/mood + 事件时间线 */
  handleTrusted<{ agentId: string }>("slime:mind:emotionGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const emotion = new EmotionalState((agent?.emotion as Record<string, unknown>) ?? undefined);
    return { ...emotion.toDict(), agentName: agent?.name ?? payload.agentId };
  });

  /** 情绪手动调节：写 PAD 基线并重算 mood（不影响自动演化与事件时间线） */
  handleTrusted<{ agentId: string; valence: number; arousal: number; dominance: number }>(
    "slime:mind:emotionSet",
    async (_event, payload) => {
      await ensureServices();
      const agent = await agentRegistry!.findAgent(payload.agentId);
      if (!agent) {
        return { ok: false, error: "Agent 不存在" };
      }
      const emotion = new EmotionalState((agent.emotion as Record<string, unknown>) ?? undefined);
      emotion.setBaseline(payload.valence, payload.arousal, payload.dominance);
      agent.emotion = emotion.toDict() as unknown as typeof agent.emotion;
      await agentRegistry!.save();
      return { ok: true, emotion: emotion.toDict() };
    },
  );

  /** book-to-skill：外部文档 → config/skills/<name>/SKILL.md（技能即装即用，不影响既有学习管线） */
  handleTrusted<{ name: string; content: string }>("slime:mind:bookToSkill", async (_event, payload) => {
    const name = (payload.name ?? "").trim().replace(/[^\w\u4e00-\u9fa5-]/g, "").slice(0, 60);
    if (!name) {
      return { ok: false, error: "技能名称无效（仅支持中文/字母/数字/短横线）" };
    }
    const content = (payload.content ?? "").trim();
    if (!content) {
      return { ok: false, error: "文档内容为空" };
    }
    const dir = resolve(PROJECT_ROOT, "config", "skills", name);
    mkdirSync(dir, { recursive: true });
    const desc = content.replace(/\s+/g, " ").slice(0, 120);
    const md =
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n` +
      `# ${name}\n\n> 由 book-to-skill 从外部文档转换生成。\n\n${content.slice(0, 12000)}\n`;
    writeFileSync(resolve(dir, "SKILL.md"), md, "utf8");
    return { ok: true, path: resolve(dir, "SKILL.md") };
  });

  /** 依赖下载链路（国内镜像：hf-mirror / gh-proxy 系列；应用内下载，断点续传） */
  handleTrusted<{ target: string }>("slime:mind:download", async (_event, payload) => {
    const target = payload.target as DownloadTarget;
    if (target !== "llama" && target !== "bge") {
      return { ok: false, error: "未知下载目标" };
    }
    return startDownload(target);
  });

  handleTrusted<{ target: string; action: "pause" | "cancel" | "resume" }>(
    "slime:mind:downloadControl",
    async (_event, payload) => {
      const target = payload.target as DownloadTarget;
      if (target !== "llama" && target !== "bge") {
        return { ok: false };
      }
      return controlDownload(target, payload.action);
    },
  );

  handleTrusted<{ target: string }>("slime:mind:downloadSnapshot", async (_event, payload) => {
    const target = payload.target as DownloadTarget;
    if (target !== "llama" && target !== "bge") {
      return { ok: false };
    }
    return downloadSnapshot(target);
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

  /** 删除 Agent（递归子树 + 悬空 children 清理 + 历史清理） */
  handleTrusted<{ agentId: string }>("slime:agents:remove", async (_event, payload) => {
    await ensureServices();
    const deleted = await agentRegistry!.removeAgent(payload.agentId);
    if (deleted.length === 0) {
      return { ok: false, error: "Agent 不存在" };
    }
    for (const aid of deleted) {
      try {
        await removeAgentHistory(aid);
      } catch (e) {
        console.warn(`[gui:main] 历史清理失败 ${aid}:`, e);
      }
      try {
        await removeSessionsForAgent(aid);
      } catch (e) {
        console.warn(`[gui:main] 会话清理失败 ${aid}:`, e);
      }
    }
    if (selectedAgentId && deleted.includes(selectedAgentId)) {
      selectedAgentId = null;
    }
    console.info(`[gui:main] 已删除 Agent 子树: ${deleted.join(", ")}`);
    return { ok: true, deleted };
  });

  /** 属性面板：返回 Agent 完整状态（model_choice/role/reasoning_effort 等） */
  handleTrusted<{ agentId: string }>("slime:agents:detail", async (_event, payload) => {
    await ensureServices();
    const a = await agentRegistry!.findAgent(payload.agentId);
    if (!a) { return null; }
    return {
      id: a.id, name: a.name, role: a.role,
      model_choice: a.model_choice ?? "inherit",
      mode: a.mode ?? "build",
      reasoning_effort: a.reasoning_effort ?? "none",
      max_context: a.max_context ?? undefined,
      max_output: a.max_output ?? undefined,
      lifecycle: a.lifecycle ?? "unknown",
    };
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

  /** Provider 管理（加密存储；渲染层只接触脱敏摘要，明文 key 不出主进程） */
  handleTrusted<void>("slime:providers:list", async (): Promise<ProviderSummary[]> => listProviders());

  handleTrusted<{ baseUrl: string; apiKey: string }>("slime:providers:fetchModels", async (_event, p) =>
    fetchModels(p.baseUrl, p.apiKey),
  );

  handleTrusted<{ key: string; api_base: string; api_key?: string; model?: string | null; models?: unknown[] }>(
    "slime:providers:save",
    async (_event, p) => {
      const res = saveProvider(p);
      if (res.ok) {
        engine?.refreshProviders();
        console.info(`[gui:main] Provider 已保存并热更新: ${p.key}`);
      }
      return res;
    },
  );

  handleTrusted<{ key: string }>("slime:providers:remove", async (_event, p) => {
    const res = removeProvider(p.key);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] Provider 已删除并热更新: ${p.key}`);
    }
    return res;
  });

  /** 本地模型：列表 / 保存 / 删除 / 目录扫描 / 文件选择 */
  handleTrusted<void>("slime:providers:localList", async (): Promise<LocalModelSpec[]> => listLocalModels());

  handleTrusted<{ id: string; path: string; label?: string; ctx_len?: number; gpu_layers?: number; max_output?: number; vision?: boolean }>(
    "slime:providers:localSave",
    async (_event, p) => {
      const res = saveLocalModel(p);
      if (res.ok) { console.info(`[gui:main] 本地模型已保存: ${p.id}`); }
      return res;
    },
  );

  handleTrusted<{ id: string }>("slime:providers:localRemove", async (_event, p) => removeLocalModel(p.id));

  handleTrusted<{ dir: string }>("slime:providers:localScan", async (_event, p) => scanLocalModels(p.dir));

  /** 弹出文件选择框挑选本地模型（.gguf） */
  handleTrusted<void>("slime:providers:localPick", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择本地模型文件（GGUF）",
      properties: ["openFile"],
      filters: [{ name: "GGUF 模型", extensions: ["gguf", "ggml"] }, { name: "全部文件", extensions: ["*"] }],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  /** 参数文件调试（折叠栏）：清单 / 读取 / 写入（白名单 + 备份原子写） */
  handleTrusted<void>("slime:config:overview", async () => configOverview());

  handleTrusted<{ name: string }>("slime:config:read", async (_event, p) => readConfigFile(p.name));

  handleTrusted<{ name: string; content: string }>("slime:config:write", async (_event, p) =>
    writeConfigFile(p.name, p.content),
  );

  handleTrusted<void>("slime:window:minimize", () => mainWindow?.minimize());
  handleTrusted<void>("slime:window:maximize", () => {
    if (mainWindow?.isMaximized()) { mainWindow.unmaximize(); } else { mainWindow?.maximize(); }
  });
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
      // 启动 Python 后端 sidecar（自包含安装包模式）
      await startPythonBackend();
      registerProtocolHandler();
      createWindow();
      registerIpcHandlers();
      registerUpdaterHandlers(); // 注册自动更新 IPC handler
      // 更新状态推送到渲染进程（StatusPanel 监听 slime:update:status）
      setStatusSink((s) => mainWindow?.webContents.send("slime:update:status", s));
      initUpdater();             // 延迟检查更新（不阻塞首屏）
      mainWindow?.loadURL("slime://./index.html");
      mainWindow?.webContents.on("did-finish-load", () => {
        console.info("[gui:main] 渲染层已加载 (slime://)");
      });
    })
       .catch((e) => { console.error("[gui:main] 启动失败:", e); process.exit(1); });

  app.on("window-all-closed", () => {
    terminatePythonBackend();
    if (process.platform !== "darwin") { app.quit(); }
  });
  app.on("before-quit", () => {
    terminatePythonBackend();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  });
}

void main();

// —— Python backend sidecar ——
let pythonBackend: ChildProcess | null = null;
const SLIME_PORT = process.env.SLIME_PORT || "19000";

function resolveResourcePath(relativePath: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, relativePath);
  }
  return join(PROJECT_ROOT, relativePath);
}

async function startPythonBackend(): Promise<void> {
  // 定位 Python venv（Windows: Scripts/python.exe，Linux/macOS: bin/python）
  const venvSub = process.platform === "win32" ? "Scripts" : "bin";
  const venvPyName = process.platform === "win32" ? "python.exe" : "python";
  const venvPython = app.isPackaged
    ? join(process.resourcesPath, "runtime", "venv", venvSub, venvPyName)
    : join(PROJECT_ROOT, "runtime", "venv", venvSub, venvPyName);

  const serverScript = resolveResourcePath("slime_server.py");
  if (!existsSync(venvPython) || !existsSync(serverScript)) {
    console.warn("[gui:backend] Python backend not found, running without server");
    return;
  }

  const env = { ...process.env, SLIME_PORT };
  pythonBackend = spawn(venvPython, [serverScript], {
    env,
    detached: true,
    windowsHide: true,
  });

  pythonBackend.stdout?.on("data", (data) => {
    console.info(`[slime-server] ${data.toString().trim()}`);
  });
  pythonBackend.stderr?.on("data", (data) => {
    console.error(`[slime-server:err] ${data.toString().trim()}`);
  });

  // 等待服务就绪（最多15秒）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://localhost:${SLIME_PORT}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.info("[gui:backend] slime_server.py 已就绪");
        return;
      }
    } catch {}
  }
  console.error("[gui:backend] slime_server.py 启动超时（15秒）");
}

function terminatePythonBackend(): void {
  if (pythonBackend) {
    pythonBackend.kill();
    pythonBackend = null;
  }
}
