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
import { INSTALL_ROOT } from "./boot.js";

// A-937：退出行为（模块级，IPC handlers 与窗口 close 拦截共用）
let exitModeStore: "quit" | "background" = "quit";
let tray: Electron.Tray | null = null;
let appIsQuitting = false;
const exitModePath = () => join(app.getPath("userData"), "exit-mode.json");
try {
  const raw = readFileSync(exitModePath(), "utf8");
  exitModeStore = raw.trim() === "background" ? "background" : "quit";
} catch { exitModeStore = "quit"; }
const saveExitMode = (mode: "quit" | "background"): void => {
  try { writeFileSync(exitModePath(), mode, "utf8"); } catch { /* ignore */ }
};
const ensureTray = (): void => {
  if (tray) { return; }
  try {
    tray = new Tray(nativeImage.createFromPath(join(INSTALL_ROOT, "build", "icon.png")));
    tray.setToolTip("Slime — 后台运行中");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Slime", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          appIsQuitting = true;
          tray?.destroy(); tray = null;
          app.quit();
        },
      },
    ]));
    tray.on("click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch { tray = null; }
};
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Tray, Menu, nativeImage } from "electron";
import { join, resolve, sep, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { spawn, exec, execFile, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { getModelServer, ModelServerManager, setModelServer } from "../../../core-ts/src/model_server.js";
import { ChatService } from "../../../core-ts/src/services/chat.js";
import { SchedulerService } from "../../../core-ts/src/services/scheduler.js";
import { SubAgentManager } from "../../../core-ts/src/services/subagent.js";
import { createServer } from "node:http";
import { ServerA2ABus } from "../../../core-ts/src/a2a.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine } from "../../../core-ts/src/services/engine.js";
import { ChatClient, AnthropicClient } from "../../../core-ts/src/llm/client.js";
import { inferApiFormat, type RouteEntry } from "../../../core-ts/src/router.js";
import { chromiumFetch } from "./providers.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus, PermissionDecision, PermissionRequestUI, PermissionOption, AskUserRequestUI, AskUserDecision, WorkspaceEntry, WorkspaceListResult, WorkspaceReadFileResult, TermResult, GitDetect, GitInfo, GitAction, GitCloneResult } from "../shared/ipc.js";
import { initUpdater, registerUpdaterHandlers, setStatusSink } from "./updater.js";
import {
  listProviders, fetchModels, saveProvider, removeProvider, clearAllProviders, refreshProviderModels,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
  type ProviderSummary, type LocalModelSpec,
} from "./providers.js";
import { overview as configOverview, readConfigFile, writeConfigFile, setMcpEnabled, setSkillEnabled, deleteSkill, deleteMcp, skillDirPath } from "./config_files.js";
import { getPermissions, setPermissions } from "./permissions.js";
import { SlimeEngine } from "../../../core-ts/src/services/engine.js";
import { SilamBrainClient, readSilamConfig, type SilamBrain } from "../../../core-ts/src/services/silam_brain.js";
import { removeAgentHistory, loadHistory } from "../../../core-ts/src/services/history.js";
import { SkillRegistry } from "../../../core-ts/src/skills.js";
import { getRegistry } from "../../../core-ts/src/tools/registry.js";
import { MemoryStore } from "../../../core-ts/src/memory/store.js";
import { retrieveFromStore, formatMemoryItems } from "../../../core-ts/src/memory/retrieve.js";
import { EmotionalState, topKForMood } from "../../../core-ts/src/mind/emotion.js";
import { BehaviorStore } from "../../../core-ts/src/mind/behavior.js";
import { buildMindSegments } from "../../../core-ts/src/mind/hooks.js";
import { loadMindConfig, saveMindConfig, readDepStatus, detectLocalDeps, updateTomlKey, readModelServerConfig } from "./mind_config.js";
import {
  startDownload, controlDownload, downloadSnapshot, setDownloadListener, setBgeReadyCallback, tryRelocateDownloads,
  type DownloadTarget, type DownloadProgress,
} from "./downloader.js";
import {
  listSessions, getSession, createSession, renameSession, removeSession,
  ensureDefaultSession, setSessionMembers, removeSessionsForAgent, removeSessionsForWorkspace,
  setSessionAgent, setSessionWorkspace, touchSessionWithMessage, SESSIONS_PATH,
} from "../../../core-ts/src/services/sessions.js";
import { loadHistoryForSession, clearSessionHistory } from "../../../core-ts/src/services/history.js";
import { SandboxManager, defaultSandboxConfig, type SandboxConfig } from "../../../core-ts/src/sandbox.js";

let mainWindow: BrowserWindow | null = null;
let chatService: ChatService | null = null;
let a2aBus: ServerA2ABus | null = null;
let statsService: StatsService | null = null;
let agentRegistry: AgentRegistry | null = null;
let engine: SlimeEngine | null = null;
/** SILAM 绝对大脑兑底客户端（A-121；无 API/本地模型时兜底应答） */
let silamBrain: SilamBrain | null = null;
/** 进行中的流式对话 → 取消控制器（key=sessionId ?? agentId） */
const activeChats = new Map<string, AbortController>();
/** agentId → 该 Agent 当前流的会话 key（perm/ask 请求据此打会话标签；供渲染层切会话时丢弃旧会话残留请求） */
const agentStreamSessionMap = new Map<string, string>();
let sandbox: SandboxManager | null = null;
/** 权限请求 → 渲染层等待用户抉择的挂起解析器（requestId → resolver） */
const pendingPerms = new Map<string, (decision: PermissionDecision) => void>();
/** 权限请求超时（渲染层无响应时自动拒绝，避免工具调用卡死） */
const PERM_TIMEOUT_MS = 300_000;
/** ask_user 提问 → 渲染层等待用户回答的挂起解析器（requestId → resolver） */
const pendingAsks = new Map<string, (decision: AskUserDecision) => void>();
/** ask_user 提问超时（渲染层无响应时按「跳过」处理，避免工具调用卡死） */
const ASK_TIMEOUT_MS = 300_000;
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

/** 安全执行 git（execFile 无 shell，杜绝注入；返回 code/stdout/stderr） */
function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile("git", args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    }, (err, stdout, stderr) => {
      const code = err
        ? (typeof (err as { code?: number }).code === "number" ? (err as { code?: number }).code as number : 1)
        : 0;
      resolveResult({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** 归一化 git 路径：绝对化 + strip 引号/空白（用户手动粘贴常带多余引号） */
function normalizeInputPath(p?: string): string {
  if (!p) { return ""; }
  return p.trim().replace(/^['"\s]+|['"\s]+$/g, "").trim();
}

/** 归一化 git 路径：绝对化 + 存在性校验；不存在时告知上层（可自动 mkdir） */
function gitPathOf(p?: string): { path: string; exists: true } | { path: string; exists: false } | { error: string } {
  const clean = normalizeInputPath(p);
  if (!clean) { return { error: "仓库路径为空" }; }
  try {
    const root = resolve(clean);
    if (!existsSync(root)) { return { path: root, exists: false }; }
    return { path: root, exists: true };
  } catch {
    return { error: "路径非法" };
  }
}

async function ensureServices(): Promise<void> {
  if (chatService) {
    return;
  }
  agentRegistry = new AgentRegistry();
  await agentRegistry.load();
  // A2A 通信总线（传唤/广播/委托回传；ChatService 依赖它完成跨 Agent 协作）
  a2aBus = new ServerA2ABus();
  for (const a of agentRegistry.loadedAgents) {
    a2aBus.register(a.name);
  }
  sandbox = new SandboxManager();
  // 权限审批：不再用系统弹窗，改为「输入框内嵌选择题」——主进程把请求推给渲染层，
  // 渲染层在输入框位置展示选择题（列出各选项的结果），用户点选后回传决策。
  sandbox.setApprovalCallback((req) => {
    return new Promise((resolve) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) {
        resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: [req.actions[0].action], reason: "无窗口", autoApproved: false });
        return;
      }
      const ui: PermissionRequestUI = {
        requestId: req.requestId,
        agentId: req.agentId,
        agentName: req.agentName,
        taskDescription: req.taskDescription,
        actions: req.actions,
        options: buildPermOptions(req),
        sessionId: req.sessionId ?? agentStreamSessionMap.get(req.agentId), // 精确流上下文会话标签（切会话后旧流请求可被渲染层丢弃）；无则回退当前流映射
      };
      // 渲染层可能尚未就绪（挂载前）：丢弃请求前先尝试，超时兜底拒绝
      const resolver = (d: PermissionDecision) => {
        clearTimeout(timer);
        resolve({
          requestId: req.requestId,
          approved: d.approved,
          approvedActions: d.approved ? req.actions.map((a) => a.action) : [],
          deniedActions: d.approved ? [] : req.actions.map((a) => a.action),
          reason: d.reason || "",
          autoApproved: false,
        });
        // 「本次会话总是允许」→ 会话级白名单（同 Agent 同工具不再询问）
        if (d.alwaysAllow && d.approved && req.actions.length > 0) {
          sandbox?.approveToolForSession(req.agentId, req.actions[0].action);
        }
      };
      pendingPerms.set(ui.requestId, resolver);
      // 超时兜底：渲染层无响应 → 自动拒绝，避免工具调用永久挂起
      const timer = setTimeout(() => {
        if (pendingPerms.delete(ui.requestId)) {
          win.webContents.send("slime:perm:timeout", { requestId: ui.requestId });
          resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: req.actions.map((a) => a.action), reason: "权限请求超时（未收到用户决策）", autoApproved: false });
        }
      }, PERM_TIMEOUT_MS);
      try {
        win.webContents.send("slime:perm:request", ui);
      } catch {
        // 渲染层异常：立即拒绝
        clearTimeout(timer);
        pendingPerms.delete(ui.requestId);
        resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: req.actions.map((a) => a.action), reason: "渲染层不可用", autoApproved: false });
      }
    });
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
  // A-121: SILAM 绝对大脑兑底——slime.toml [silam] enabled + as_brain 开启时
  // 拉起 python sidecar；起不来（缺 python/脚本/依赖）静默降级，不阻塞 GUI 主流程。
  try {
    const silamCfg = readSilamConfig();
    if (silamCfg.enabled && silamCfg.asBrain) {
      silamBrain = await SilamBrainClient.start(silamCfg);
      console.info(`[gui:silam] 绝对大脑兑底 ${silamBrain.enabled ? "已就绪（无模型时由 SILAM 应答）" : "不可用（回落默认提示）"}`);
    } else {
      console.info(`[gui:silam] 兑底未开启（enabled=${silamCfg.enabled} as_brain=${silamCfg.asBrain}）`);
    }
  } catch (e) {
    console.warn(`[gui:silam] 大脑启动跳过: ${e instanceof Error ? e.message : String(e)}`);
  }
  engine = createEngine({
    registry: agentRegistry,
    sandbox,
    silamBrain,
    // 聊天请求走 Chromium 网络栈（同 providers 探测）：绕过 Cloudflare 对
    // Electron 内置 Node(BoringSSL) fetch 指纹的风控拦截（opencode.ai 实测）
    clientFactory: (route: RouteEntry) => {
      const format = route.api_format === "anthropic" ? "anthropic"
        : route.api_format === "openai" ? "openai"
        : inferApiFormat(route.baseUrl);
      if (format === "anthropic") {
        return new AnthropicClient({ baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs, fetchImpl: chromiumFetch as typeof fetch });
      }
      return new ChatClient({ baseUrl: route.baseUrl, apiKey: route.apiKey, timeoutMs: route.timeoutMs, fetchImpl: chromiumFetch as typeof fetch });
    },
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
    onAskUser: (req) => {
      // ask_user 工具：模型向用户提问（方向分歧 / 关键决策）→ 输入框位置选择题 UI，
      // 与权限请求同一交互形态；无窗口/超时按「跳过」处理，不编造用户回答。
      return new Promise((resolve) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          resolve({ answer: "", skipped: true });
          return;
        }
        const ui: AskUserRequestUI = {
          requestId: randomUUID(),
          agentId: req.agentId,
          agentName: req.agentName ?? "",
          question: req.question,
          header: req.header,
          options: req.options,
          consequences: req.consequences,
          recommendation: req.recommendation,
          sessionId: req.sessionId ?? agentStreamSessionMap.get(req.agentId), // 精确流上下文会话标签（切会话后旧流提问可被渲染层丢弃）；无则回退当前流映射
        };
        const timer = setTimeout(() => {
          if (pendingAsks.delete(ui.requestId)) {
            win.webContents.send("slime:ask:timeout", { requestId: ui.requestId });
            resolve({ answer: "", skipped: true });
          }
        }, ASK_TIMEOUT_MS);
        pendingAsks.set(ui.requestId, resolve);
        try {
          win.webContents.send("slime:ask:request", ui);
        } catch {
          clearTimeout(timer);
          pendingAsks.delete(ui.requestId);
          resolve({ answer: "", skipped: true });
        }
      });
    },
  });
  chatService = new ChatService({ registry: agentRegistry, engine, bus: a2aBus ?? undefined });
  // ── 后台常驻定时唤醒（SchedulerService 装配，Phase 1 骨架）──
  // 对标 nanobot CronService：从 data/schedules.json 读取 cron 任务，到点用现有引擎跑一轮 AgentLoop
  // （复用模型路由/工具循环/记忆/沙箱），结果落盘 data/generated/schedule-*.md 供审计。
  // 无文件 / 空表 → 空闲（零副作用）；单个任务解析失败仅告警跳过，不影响其余任务与主流程。
  try {
    const schedPath = join(INSTALL_ROOT, "data", "schedules.json");
    const schedDefs = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
    const statePath = join(INSTALL_ROOT, "data", "scheduler-state.json");
    if (Array.isArray(schedDefs) || existsSync(statePath)) {
      const scheduler = new SchedulerService();
      // Phase 3 断点续跑：优先从运行态快照恢复（含 paused/lastRun/lastResult），再叠加 schedules.json 新增定义
      const persistState = (): void => {
        try { writeFileSync(statePath, scheduler.exportState(), "utf8"); } catch { /* 状态落盘失败不阻断主流程 */ }
      };
      if (existsSync(statePath)) {
        try { scheduler.importState(readFileSync(statePath, "utf8")); } catch { /* 快照损坏忽略，回退 schedules.json */ }
      }
      scheduler.setHandler(async (job) => {
        const byId = job.agentId ? await agentRegistry?.findAgent(job.agentId) : undefined;
        const agent = byId ?? agentRegistry?.loadedAgents[0];
        if (!agent) {
          throw new Error(`定时任务「${job.name}」找不到可执行 Agent（agentId=${job.agentId ?? "<default>"}）`);
        }
        let reply = "";
        if (!engine) { throw new Error("引擎未就绪"); }
        const system = await engine.buildSystem(agent, undefined, undefined);
        for await (const ev of engine.stream({
          agent,
          message: `${job.prompt}\n\n（本条为后台定时任务触发，触发时间：${new Date().toLocaleString()}）`,
          history: [],
          systemPrompt: system,
        })) {
          if (ev.type === "done") { reply = ev.reply ?? ""; }
        }
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `schedule-${job.name}-${stamp}.md`), reply, "utf8");
        persistState(); // Phase 3：运行态落盘，进程重启后从断点快照恢复
      });
      for (const d of schedDefs as Array<{ id?: string; name?: string; cron?: string; prompt?: string; agentId?: string }>) {
        if (!d.cron || !d.prompt) { continue; }
        if (d.id && scheduler.get(d.id)) { continue; } // 已从快照恢复的定义不重复注册
        try {
          scheduler.add({ id: d.id, name: d.name ?? d.id ?? "task", cron: d.cron, prompt: d.prompt, agentId: d.agentId });
        } catch (e) {
          console.warn(`[scheduler] 忽略非法定时任务「${d.name ?? d.id}」: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      scheduler.start();
      console.log(`[scheduler] 后台常驻定时唤醒已就绪（${scheduler.list().length} 个任务）`);

      // Phase 3 子代理管理器：后台独立上下文并行执行（Claude Code subagent 对标），结果落盘 subagent-*.md
      const subagents = new SubAgentManager(async (def) => {
        const ag = def.agentId
          ? (await agentRegistry?.findAgent(def.agentId))
          : undefined;
        const target = ag ?? agentRegistry?.loadedAgents[0];
        if (!target) { throw new Error(`子代理「${def.name}」找不到可执行 Agent`); }
        if (!engine) { throw new Error("引擎未就绪"); }
        const system = def.systemPrompt ?? (await engine.buildSystem(target, undefined, undefined));
        let reply = "";
        for await (const ev of engine.stream({ agent: target, message: def.task, history: [], systemPrompt: system })) {
          if (ev.type === "done") { reply = ev.reply ?? ""; }
        }
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `subagent-${def.name}-${stamp}.md`), reply, "utf8");
        return reply;
      }, { concurrency: 3 });

      // Phase 2 事件触发源：本地 HTTP 端点（127.0.0.1:19011）
      // POST /agent/trigger/:id → 立即执行一次（webhook/外部事件统一入口）；GET /agent/status → 快照
      createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && url.pathname === "/agent/status") {
          res.end(JSON.stringify({ ok: true, scheduler: scheduler.list(), subagents: subagents.list() }));
          return;
        }
        const m = /^\/agent\/trigger\/([\w-]+)$/.exec(url.pathname ?? "");
        if (req.method === "POST" && m) {
          const ok = scheduler.trigger(m[1]);
          res.end(JSON.stringify({ ok, id: m[1] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "not found" }));
      }).listen(19011, "127.0.0.1").on("error", (e) => {
        console.warn(`[agent-http] 事件端点监听失败: ${e instanceof Error ? e.message : String(e)}`);
      });

      // A-910：设置页「后台任务」IPC —— 定时任务增删/暂停恢复/立即触发、子代理派发、整体快照
      ipcMain.handle("slime:resident:state", () => ({
        scheduler: scheduler.list(),
        subagents: subagents.list(),
      }));
      ipcMain.handle("slime:resident:scheduler:add", (_e, p: { name?: string; cron?: string; prompt?: string; agentId?: string }) => {
        if (!p?.name || !p?.cron || !p?.prompt) { return { ok: false, error: "name/cron/prompt 必填" }; }
        try {
          const id = randomUUID();
          scheduler.add({ id, name: p.name, cron: p.cron, prompt: p.prompt, agentId: p.agentId });
          const list = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
          const arr = Array.isArray(list) ? list : [];
          arr.push({ id, name: p.name, cron: p.cron, prompt: p.prompt, agentId: p.agentId });
          writeFileSync(schedPath, JSON.stringify(arr, null, 2), "utf8");
          persistState();
          return { ok: true, id };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
      ipcMain.handle("slime:resident:scheduler:remove", (_e, p: { id?: string }) => {
        if (!p?.id) { return { ok: false }; }
        scheduler.remove(p.id);
        try {
          const list = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
          if (Array.isArray(list)) {
            writeFileSync(schedPath, JSON.stringify(list.filter((x: { id?: string }) => x?.id !== p.id), null, 2), "utf8");
          }
        } catch { /* 宽松 */ }
        persistState();
        return { ok: true };
      });
      ipcMain.handle("slime:resident:scheduler:pause", (_e, p: { id?: string }) => ({ ok: !!p?.id && scheduler.pause(p.id!) }));
      ipcMain.handle("slime:resident:scheduler:resume", (_e, p: { id?: string }) => ({ ok: !!p?.id && scheduler.resume(p.id!) }));
      ipcMain.handle("slime:resident:scheduler:trigger", (_e, p: { id?: string }) => ({ ok: !!p?.id && scheduler.trigger(p.id!) }));
      ipcMain.handle("slime:resident:subagent:spawn", (_e, p: { name?: string; task?: string; systemPrompt?: string; agentId?: string }) => {
        if (!p?.name || !p?.task) { return { ok: false, error: "name/task 必填" }; }
        const run = subagents.spawn({ name: p.name, task: p.task, systemPrompt: p.systemPrompt, agentId: p.agentId });
        return { ok: true, run };
      });

      // A-916：请求频率调节（config/requests.json）——并发上限 + 断流重连基间隔，双端（TS/Python）均可读
      const requestsFile = join(INSTALL_ROOT, "config", "requests.json");
      const DEFAULT_REQUESTS = { concurrency: 2, reconnectBaseMs: 3000 };
      const readRequests = (): typeof DEFAULT_REQUESTS => {
        try {
          if (existsSync(requestsFile)) {
            const p = JSON.parse(readFileSync(requestsFile, "utf8")) as Partial<typeof DEFAULT_REQUESTS>;
            return {
              concurrency: typeof p.concurrency === "number" && p.concurrency >= 1 && p.concurrency <= 20 ? p.concurrency : DEFAULT_REQUESTS.concurrency,
              reconnectBaseMs: typeof p.reconnectBaseMs === "number" && p.reconnectBaseMs >= 500 && p.reconnectBaseMs <= 15000 ? p.reconnectBaseMs : DEFAULT_REQUESTS.reconnectBaseMs,
            };
          }
        } catch { /* 损坏回退默认 */ }
        return { ...DEFAULT_REQUESTS };
      };
      ipcMain.handle("slime:requests:get", () => readRequests());
      ipcMain.handle("slime:requests:set", (_e, p: { concurrency?: number; reconnectBaseMs?: number }) => {
        const cur = readRequests();
        const next = {
          concurrency: typeof p?.concurrency === "number" && p.concurrency >= 1 && p.concurrency <= 20 ? Math.floor(p.concurrency) : cur.concurrency,
          reconnectBaseMs: typeof p?.reconnectBaseMs === "number" && p.reconnectBaseMs >= 500 && p.reconnectBaseMs <= 15000 ? Math.floor(p.reconnectBaseMs) : cur.reconnectBaseMs,
        };
        try {
          writeFileSync(requestsFile, JSON.stringify(next, null, 2), "utf8");
          return { ok: true, ...next };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
    }
  } catch (e) {
    console.warn(`[scheduler] 启动失败（不影响主流程）: ${e instanceof Error ? e.message : String(e)}`);
  }
  statsService = new StatsService(agentRegistry);
  // 依赖下载进度 → 渲染层（下载条 UI）
  setDownloadListener((p: DownloadProgress) => {
    mainWindow?.webContents.send("slime:mind:downloadProgress", p);
  });
  // bge 嵌入模型下载完成 → 自动拉起 embedding 服务（免手动重试），并推送状态刷新
  setBgeReadyCallback(() => {
    const mgr = getModelServer();
    if (!mgr) return;
    void mgr.startEmbedding().then((r) => {
      console.log(`[gui:main] bge 下载完成，自动拉起 embedding: ${r.ok ? "成功" : r.error}`);
      if (r.ok) {
        void statsService?.snapshot().then((snap) => {
          mainWindow?.webContents.send("slime:stats:update", snap);
        }).catch(() => {});
      }
    });
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

/** 审批档位 → SandboxConfig（会话级持久化格式：sandbox_override 存 approval 档位 + workspace）
 *  四档：manual 手动 / auto 自动 / none 无需 / custom 自定义。
 *  旧档位兼容：strict、confirm → manual。 */
const APPROVAL_MODES = ["manual", "auto", "none", "custom"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
const LEGACY_APPROVAL_MAP: Record<string, ApprovalMode> = { strict: "manual", confirm: "manual" };

function sandboxConfigFromOverride(ov: Record<string, unknown>): SandboxConfig {
  const cfg = defaultSandboxConfig();
  const raw = (ov.approval as string) ?? "auto";
  const mode = LEGACY_APPROVAL_MAP[raw] ?? (APPROVAL_MODES.includes(raw as ApprovalMode) ? (raw as ApprovalMode) : "auto");
  if (mode === "manual") {
    cfg.auto_approve_levels = [];
    cfg.require_approval_levels = [0, 1, 2, 3, 4, 5];
    cfg.deny_levels = [];
    cfg.askOnDeny = true;
    cfg.allowOutsideWorkspace = false;
    cfg.allowDeny = false;
  } else if (mode === "auto") {
    cfg.auto_approve_levels = [0, 1, 2, 3, 4, 5];
    cfg.require_approval_levels = [];
    cfg.deny_levels = [5];
    cfg.askOnDeny = true;
    cfg.allowOutsideWorkspace = true;
    cfg.allowDeny = false;
  } else if (mode === "none") {
    cfg.auto_approve_levels = [0, 1, 2, 3, 4, 5];
    cfg.require_approval_levels = [];
    cfg.deny_levels = [5];
    cfg.askOnDeny = false;
    cfg.allowOutsideWorkspace = true;
    cfg.allowDeny = true;
  } else {
    cfg.auto_approve_levels = [];
    cfg.require_approval_levels = [0, 1, 2, 3, 4, 5];
    cfg.deny_levels = [];
    cfg.askOnDeny = true;
    cfg.allowOutsideWorkspace = false;
    cfg.allowDeny = false;
    cfg.allowPaths = getPermissions().approvalAllowPaths;
  }
  cfg.workspace = typeof ov.workspace === "string" ? ov.workspace : "";
  return cfg;
}

/**
 * 权限请求 → 选择题选项（渲染层输入框 UI 列出「每个选项的结果」，参考 Claude Code /
 * Cursor / Cline 的授权交互：允许一次 / 会话内总是允许 / 拒绝 / 自定义）。
 * 按动作的权限级别与目标路径给出对应措辞与后果说明。
 */
function buildPermOptions(req: {
  agentId: string;
  agentName: string;
  taskDescription: string;
  actions: Array<{ action: string; target: string; level: number }>;
}): PermissionOption[] {
  const first = req.actions[0];
  const maxLevel = Math.max(...req.actions.map((a) => a.level), 0);
  const targets = [...new Set(req.actions.map((a) => a.target).filter(Boolean))];
  const targetText = targets.length > 0
    ? targets.map((t) => `\`${t}\``).join("、")
    : (first?.action ?? "此操作");

  // 级别 → 风险措辞（对齐 L0-L5 语义）
  const riskHint =
    maxLevel <= 1 ? "只读，风险较低"
    : maxLevel === 2 ? "将写入/修改文件，可能有改动"
    : maxLevel === 3 ? "将执行终端命令，可能影响系统"
    : maxLevel >= 4 ? "将访问网络或执行高权限操作，风险较高"
    : "有一定风险";

  const actionLabel = first ? `${first.action} → ${first.target || "…"}` : "此操作";

  return [
    {
      id: "allow-once",
      label: "允许通过",
      hint: `放行 ${actionLabel}（${riskHint}）。该 Agent 下次同类操作仍会再次询问。`,
    },
    {
      id: "allow-session",
      label: "本次会话全部允许",
      hint: `放行 ${actionLabel}（${riskHint}），且本次会话内该 Agent 的同类操作不再询问。`,
    },
    {
      id: "deny",
      label: "拒绝通过",
      hint: `阻止该操作，Agent 会收到拒绝原因并尝试其他方案。`,
    },
    {
      id: "custom",
      label: "其他需求",
      hint: `填写你的具体指示（例如：只允许读取 ${targetText}、改用指定目录、暂停操作等临时需求）。`,
      customPlaceholder: "输入你的指示…",
    },
  ];
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

/** A-933 上下文窗口上限（单一事实源，随 done 事件下发，环与右栏共用同一值）：
 *  1) Agent 显式配置 max_context 优先（对齐 Claude Code 可自定义窗口阈值语义）；
 *  2) 否则按本次实际使用模型解析 context_window——本地模型取 llama.cpp ctx_len，
 *     远端模型在 provider 模型规格（含内置启发推断）中按 id 匹配；
 *  3) 解析失败返回 undefined（渲染层用自己的兜底路径，不阻断 done 下发）。 */
async function resolveSessionWindowCap(agentId: string, modelId: string): Promise<number | undefined> {
  try {
    if (agentId && agentRegistry) {
      const agent = await agentRegistry.findAgent(agentId).catch(() => null);
      if (agent?.max_context && agent.max_context > 0) { return agent.max_context; }
    }
  } catch { /* ignore */ }
  if (!modelId) { return undefined; }
  try {
    const candidates = Array.from(new Set([
      modelId,
      modelId.replace(/^api:[^:]*:/, "").replace(/^local:/, ""),
      modelId.split(":").pop() ?? modelId,
    ])).filter(Boolean);
    for (const id of candidates) {
      const local = listLocalModels().find((m) => m.id === id || m.label === id);
      if (local?.ctx_len && local.ctx_len > 0) { return local.ctx_len; }
    }
    for (const id of candidates) {
      for (const p of listProviders()) {
        const m = (p.models ?? []).find((x) => x.id === id);
        if (m?.context_window && m.context_window > 0) { return m.context_window; }
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/** 引擎事件 → IPC StreamChunk：统一 snake_case→camelCase 字段映射（elapsed_ms→elapsedMs 等）
 *
 *  关键兼容：后端 `done` 事件会把 `prompt_tokens` / `completion_tokens` 放在 chunk **最外层**，
 *  `timings` 对象本身是 A-098 全链路耗时（不含这些 token 字段）。
 *  渲染层 `ChatPanel.ContextRing` 只读取 `m.timings.promptTokens`，
 *  所以这里必须把 token 统计 **同步注入 timings**，才能让右上角"上下文占比"真正跳动，
 *  也让任务页「用量分析」有 prompt/completion/cache-read 等累计数据源。
 */
function toStreamChunk(ev: { seq: number; type: string; data: unknown }, sessionId?: string): StreamChunk {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const pt = typeof d.promptTokens === "number" ? d.promptTokens : typeof d.prompt_tokens === "number" ? d.prompt_tokens : undefined;
  const ct = typeof d.completionTokens === "number" ? d.completionTokens : typeof d.completion_tokens === "number" ? d.completion_tokens : undefined;
  const em = typeof d.elapsedMs === "number" ? d.elapsedMs : typeof d.elapsed_ms === "number" ? d.elapsed_ms : undefined;
  const mergedTimings: Record<string, number> = {};
  if (typeof d.timings === "object" && d.timings !== null) {
    // 先复制原始 timings，再把 promptTokens / completionTokens / elapsedMs 覆盖注入（统一 camelCase）
    for (const [k, v] of Object.entries(d.timings as Record<string, number>)) {
      if (typeof v === "number") { mergedTimings[k] = v; }
    }
  }
  if (typeof pt === "number") { mergedTimings.promptTokens = pt; }
  if (typeof ct === "number") { mergedTimings.completionTokens = ct; }
  if (typeof em === "number") { mergedTimings.elapsedMs = em; }
  // A-098 预留：后端没写 cache read 时给个 0（避免概览面板的「缓存命中」始终是 -）
  if (typeof mergedTimings.cacheReadTokens !== "number") {
    if (typeof (d as any).cache_read_tokens === "number") {
      mergedTimings.cacheReadTokens = (d as any).cache_read_tokens;
    } else if (typeof (d as any).cacheReadTokens === "number") {
      mergedTimings.cacheReadTokens = (d as any).cacheReadTokens;
    } else {
      mergedTimings.cacheReadTokens = 0;
    }
  }
  // reasoning tokens：按 timings 中常见键兜底 0（DeepSeek / o1 系列引擎会回填）
  if (typeof mergedTimings.reasoningTokens !== "number") {
    if (typeof (d as any).reasoning_tokens === "number") {
      mergedTimings.reasoningTokens = (d as any).reasoning_tokens;
    } else {
      mergedTimings.reasoningTokens = 0;
    }
  }
  return {
    seq: ev.seq,
    type: ev.type as StreamChunk["type"],
    data: {
      content: typeof d.content === "string" ? d.content : undefined,
      name: typeof d.name === "string" ? d.name : undefined,
      // A-162: 工具参数与结果透传（tool 事件前端提取网址/文件路径展示细节行）
      args: typeof d.args === "string" ? d.args : undefined,
      result: typeof d.result === "string" ? d.result : undefined,
      model: typeof d.model === "string" ? d.model : undefined,
      reasoning: typeof d.reasoning === "string" ? d.reasoning : undefined,
      promptTokens: pt,
      completionTokens: ct,
      elapsedMs: em,
      timings: Object.keys(mergedTimings).length > 0 ? mergedTimings : undefined,
      message: typeof d.message === "string" ? d.message : undefined,
      sessionId,
    },
  };
}

/** 本地模型是否已就绪（决定是否弹「加载本地模型」面板；未注册/未启动/模型不匹配 → false） */
function isLocalModelReady(agent: AgentState): boolean {
  const id = agent.model_choice.slice("local:".length).trim();
  const spec = listLocalModels().find((m) => m.id === id);
  const mgr = getModelServer();
  if (!mgr) { return false; }
  return mgr.isChatReady(spec?.path ?? "");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 560, show: false,
    icon: join(INSTALL_ROOT, "build", "icon.png"),
    // Campanula 式自绘标题栏：隐藏系统标题栏，Windows overlay 渲染窗口按钮
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#10172a", symbolColor: "#e6f1ff", height: 40 },
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      // 聊天/IDE 场景不需要拼写检查，关掉可省下拼写词典加载与内存（Electron 官方性能清单）
      spellcheck: false,
      // 右侧栏「浏览器」标签页使用 <webview> 内嵌网页（仅加载用户指定的 URL）
      webviewTag: true,
      preload: join(__dirname, "../preload/index.js"), webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // GPU 崩溃保护：ready-to-show 未触发时（如 GPU exit_code=-1），兜底主动 show
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 3000);
  // A-937：退出行为——后台模式拦截 close → 隐藏窗口 + 托盘常驻（真正退出走托盘菜单或 app.quit）
  mainWindow.on("close", (e) => {
    if (exitModeStore === "background" && !appIsQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      ensureTray();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

/**
 * 二进制度嗅探：检查 buffer 前 N 字节中是否含 NUL 字节（0x00），
 * 命中即视为二进制。文本文件几乎不含 NUL；压缩包/可执行/媒体等二进制必然含大量 NUL。
 * 用于在把文件内容作为文本/预览返回前拦下二进制，防止乱码与渲染崩溃。
 */
function binarySniff(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

function registerIpcHandlers(): void {
  // 启动状态查询（渲染层启动加载面板：错过 push 事件时拉取当前状态）
  ipcMain.handle("slime:boot:status", () => bootQuery ?? { phase: "starting", backendReady: false, message: "正在初始化…" });

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

  /* ── 异步对话框（A-151）：渲染层不再用 window.confirm/alert（Electron 同步阻塞渲染进程 JS，
   *  对话框显示异常时整个 UI 冻结、所有输入框失灵）。改走主进程原生异步对话框，永不阻塞渲染层。 ── */
  handleTrusted<{ message: string; detail?: string }>("slime:dialog:confirm", async (_event, payload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { ok: false, confirmed: false, error: "无窗口" };
    }
    const r = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["取消", "确定"],
      defaultId: 1,
      cancelId: 0,
      title: "确认操作",
      message: payload.message,
      detail: payload.detail ?? "",
      noLink: true,
    });
    return { ok: true, confirmed: r.response === 1, error: null };
  });

  handleTrusted<{ message: string; detail?: string }>("slime:dialog:alert", async (_event, payload) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "无窗口" };
    }
    await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["知道了"],
      defaultId: 0,
      title: payload.detail ? "提示" : "提示",
      message: payload.message,
      detail: payload.detail ?? "",
      noLink: true,
    });
    return { ok: true, error: null };
  });

  handleTrusted<ChatInput>("slime:chat:stream", async (_event, input: ChatInput) => {
    try {
    await ensureServices();
    const agentId = resolveAgentId(input.agentId);
    // 本地模型对话：仅当对应 llama-server 尚未就绪（首载/切换模型）时弹「加载进度」面板；
    // 已就绪则直接对话，不再每次弹窗打扰
    const loadingAgent = await agentRegistry!.findAgent(agentId).catch(() => undefined);
    const isLocalModel = !!loadingAgent?.model_choice?.startsWith("local:");
    const needLoadingPanel = isLocalModel && !isLocalModelReady(loadingAgent!);
    const cancelKey = input.sessionId ?? agentId;
    const controller = new AbortController();
    activeChats.set(cancelKey, controller);
    agentStreamSessionMap.set(input.agentId, cancelKey); // 授权/提问请求按当前流打会话标签
    if (needLoadingPanel) {
      mainWindow?.webContents.send("slime:model:loading", {
        loading: true, message: `正在加载本地模型「${loadingAgent!.model_choice!.slice("local:".length)}」…首次加载可能需要数十秒`,
        key: cancelKey,
      });
    }
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
      networkEnabled: input.networkEnabled,
      resumeHint: (input as { resumeHint?: string }).resumeHint,
    };
    const session = createStreamSession();
    // 干净正文：优先取 chatService done 事件里全量 extractThinkingFromReply 清洗后的 reply
    // （流式逐 chunk 剥离对细粒度 chunk 可能漏掉裸思考，累积的 fullReply 不代表最终正文）
    let cleanReply: string | undefined;
    void (async () => {
      try {
        for await (const ev of chatService!.stream(agentId, req, input.resumeSeq ?? 0, controller.signal)) {
          if (ev.type === "done") {
            const d = (ev.data ?? {}) as Record<string, unknown>;
            if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
          }
          const chunk = toStreamChunk(ev, cancelKey);
          session.pushChunk(chunk);
          mainWindow?.webContents.send("slime:chat:chunk", chunk);
        }
        if (input.sessionId) {
          await touchSessionWithMessage(input.sessionId, input.message).catch(() => undefined);
        }
        mainWindow?.webContents.send("slime:chat:done", {
          reply: cleanReply ?? session.fullReply, model: session.model,
          elapsedMs: session.elapsedMs, timings: session.timings,
          interrupted: controller.signal.aborted,
          sessionId: cancelKey,
        });
        // A-918：流终态广播——渲染层据此把 per-session 快照 hasActive 校准为 false，
        // 根治「切走再切回仍显示生成中/仍重连」的假活跃状态
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[gui:main] chat stream error:", msg);
        mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: cancelKey });
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
      } finally {
        activeChats.delete(cancelKey);
        // 会话标签竞态防护（A-151）：仅当映射中的值仍是本流注册的 cancelKey 时才删除——
        // 同 Agent 多会话并发时，本流 finally 可能晚于「新会话流已 set」执行，
        // 无条件 delete 会把新流的会话标签一并删掉 → 新流 perm/ask 请求丢 sessionId
        // → 渲染层无条件弹选择题替换输入框（切会话后输入框卡死的根因链）。
        if (agentStreamSessionMap.get(input.agentId) === cancelKey) {
          agentStreamSessionMap.delete(input.agentId);
        }
        if (needLoadingPanel) {
          mainWindow?.webContents.send("slime:model:loading", { loading: false });
        }
      }
    })();
    return { ok: true };
    } catch (e: unknown) {
      // 启动前/入参阶段失败（服务未就绪、Agent 解析失败等）：同样走 error 通道，
      // 渲染层自动重连机制才能接管（否则 invoke 直接 reject，未处理回调会把重连链路切断）
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] chat stream setup error:", msg);
      mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: input.sessionId });
      mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: input.sessionId });
      return { ok: false, error: msg };
    }
  });

  /** 主动中断进行中的流式对话 */
  handleTrusted<{ key?: string }>("slime:chat:cancel", async (_event, payload) => {
    const active = activeChats.get(payload.key ?? "");
    if (!active) {
      return { ok: false, error: "无进行中的对话可取消", active: activeChats.size };
    }
    active.abort();
    return { ok: true, active: activeChats.size };
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

  /** A-161：回滚持久化 —— 截断该会话历史到目标用户消息之前（回滚后重启不再复现旧消息） */
  handleTrusted<{ agentId: string; sessionId?: string; userMsg: string }>("slime:history:truncateFrom", async (_event, payload) => {
    if (!payload || typeof payload.userMsg !== "string" || !payload.agentId) {
      return { ok: false, error: "参数不完整" };
    }
    const { truncateHistoryFromExport } = await import("../../../core-ts/src/services/history.js");
    const removed = await truncateHistoryFromExport(payload.agentId, payload.sessionId, payload.userMsg);
    console.info(`[gui:main] 回滚截断历史：agent=${payload.agentId} 会话=${payload.sessionId ?? "-"} 删除 ${removed} 条`);
    return { ok: true, removed };
  });

  /** P0: 重试上条 — 重发最后一条 user 消息 */
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:chat:retry", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const loadingAgent = await agentRegistry!.findAgent(agentId).catch(() => undefined);
    const isLocalModel = !!loadingAgent?.model_choice?.startsWith("local:");
    const needLoadingPanel = isLocalModel && !isLocalModelReady(loadingAgent!);
    if (needLoadingPanel) {
      mainWindow?.webContents.send("slime:model:loading", {
        loading: true, message: `正在加载本地模型「${loadingAgent!.model_choice!.slice("local:".length)}」…首次加载可能需要数十秒`,
      });
    }
    const { popLastRecordForAgentExport } = await import("../../../core-ts/src/services/history.js");
    const last = await popLastRecordForAgentExport(agentId, payload.sessionId);
    if (!last || !last.user) {
      if (needLoadingPanel) { mainWindow?.webContents.send("slime:model:loading", { loading: false }); }
      return { ok: false, error: "无历史可重试" };
    }
    const req: ChatRequest = {
      message: last.user,
      history: await loadSessionHistory(payload.sessionId),
      retry: true,
      sessionId: payload.sessionId,
    };
    const session = createStreamSession();
    // 授权/提问请求按当前流打会话标签（retry 流的会话 = payload.sessionId）
    const retryCancelKey = payload.sessionId ?? agentId;
    agentStreamSessionMap.set(agentId, retryCancelKey);
    // 干净正文：优先取 chatService done 事件全量清洗后的 reply（同 slime:chat:stream）
    let cleanReply: string | undefined;
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      void (async () => {
        try {
          for await (const ev of chatService!.stream(agentId, req, 0)) {
            if (ev.type === "done") {
              const d = (ev.data ?? {}) as Record<string, unknown>;
              if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            }
            const chunk = toStreamChunk(ev, payload.sessionId);
            session.pushChunk(chunk);
            mainWindow?.webContents.send("slime:chat:chunk", chunk);
          }
          mainWindow?.webContents.send("slime:chat:done", {
            reply: cleanReply ?? session.fullReply, model: session.model,
            elapsedMs: session.elapsedMs, timings: session.timings,
            sessionId: payload.sessionId,
            // A-933：权威窗口上限（Agent.max_context 或本次模型 context_window），右栏与环同源
            windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
          });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          resolve({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[gui:main] chat retry error:", msg);
          mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: payload.sessionId });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          resolve({ ok: false, error: msg });
        } finally {
          // 值匹配才删（A-151 竞态防护，同 slime:chat:stream）
          if (agentStreamSessionMap.get(agentId) === retryCancelKey) {
            agentStreamSessionMap.delete(agentId);
          }
          if (needLoadingPanel) { mainWindow?.webContents.send("slime:model:loading", { loading: false }); }
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
    const items: Array<{ sessionId: string; agentId: string; agentName: string; workspace?: string; title: string; count: number; lastTime: string; memberIds?: string[]; memberNames?: string[] }> = [];
    for (const meta of metas) {
      // 旧记录（无 session_id）按 "default" 聚合，归入该 Agent 首个会话
      const agg = byKey.get(`${meta.agentId}::${meta.id}`) ?? byKey.get(`${meta.agentId}::default`);
      const memberIds = Array.isArray(meta.members) ? meta.members : [];
      items.push({
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        workspace: meta.workspace,
        title: meta.title,
        count: agg?.count ?? 0,
        lastTime: agg?.lastTime ?? meta.updatedAt,
        memberIds,
        memberNames: memberIds.map((id) => names.get(id) ?? id),
      });
    }
    // 无会话元数据的旧历史（惰性迁移：为该 Agent 建默认会话）
    for (const [key, agg] of byKey) {
      const agentId = key.split("::")[0];
      if (!metas.some((m) => m.agentId === agentId)) {
        const meta = await ensureDefaultSession(agentId);
        const memberIds = Array.isArray(meta.members) ? meta.members : [];
        items.push({
          sessionId: meta.id,
          agentId,
          agentName: names.get(agentId) ?? agentId,
          workspace: meta.workspace,
          title: meta.title === "新对话" ? (agg.firstUser || "新对话").slice(0, 60) : meta.title,
          count: agg.count,
          lastTime: agg.lastTime,
          memberIds,
          memberNames: memberIds.map((id) => names.get(id) ?? id),
        });
      }
    }
    return items.sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1));
  });

  /** 新建会话（以目标工作文件夹为主；会话内指定调用 Agent）
   *  - payload.workspace 可选：目标工作文件夹（工具操作锚定到该目录）；缺省为空 → 归入「未绑定文件夹」组
   *  - payload.agentId 可选：缺省时自动选根 Agent（无 parent_id，优先）或首个已有 Agent
   *  - 若当前没有任何 Agent，兜底创建一个默认「助手」Agent，实现"打开直接聊"的懒会话
   */
  handleTrusted<{ agentId?: string; title?: string; workspace?: string | null; memberIds?: string[] }>("slime:sessions:create", async (_event, payload) => {
    await ensureServices();
    let aid = payload.agentId;
    // 1) 未传 agentId：优先选一个根 Agent（无 parent_id），否则选列表第一个
    if (!aid) {
      const roots = agentRegistry!.loadedAgents.filter((a) => !a.parent_id);
      const fallback = roots[0] ?? agentRegistry!.loadedAgents[0];
      if (fallback) {
        aid = fallback.id;
      } else {
        // 2) 无任何 Agent：创建默认「助手」Agent（通用 AI 助手角色）
        const def = await createAgent("助手", "通用 AI 助手，负责回答问题、编写代码、整理信息与日常协作");
        aid = def.id;
        console.info(`[gui:main] 兜底创建默认 Agent: ${def.id} name=${def.name}`);
      }
    }
    const agent = await agentRegistry!.findAgent(aid);
    if (!agent) { throw new Error("Agent 不存在"); }
    const meta = await createSession(aid, {
      title: payload.title,
      workspace: payload.workspace ?? undefined,
      memberIds: payload.memberIds,
    });
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const memberIds = Array.isArray(meta.members) ? meta.members : [];
    console.info(`[gui:main] 新建会话: agent=${aid} session=${meta.id} workspace=${meta.workspace ?? "(未绑定)"} members=${memberIds.length}`);
    return {
      ok: true,
      session: {
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        workspace: meta.workspace,
        title: meta.title,
        count: 0,
        lastTime: meta.updatedAt,
        memberIds,
        memberNames: memberIds.map((id) => names.get(id) ?? id),
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
    const messages: Array<{ role: "user" | "assistant"; content: string; time: string; reasoning?: string; elapsedMs?: number }> = [];
    for (const r of records) {
      if (r.user) {
        messages.push({ role: "user", content: r.user, time: r.timestamp });
      }
      if (r.ai) {
        messages.push({
          role: "assistant",
          content: r.ai,
          time: r.timestamp,
          reasoning: r.reasoning,
          elapsedMs: r.elapsed_ms,
        });
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

  /** 会话级配置：审批模式（Agent 级）+ 工作目录（会话级优先）
   *  - approval：写 Agent sandbox_override.approval（审批属于 Agent 能力，跨会话生效）
   *  - workspace：有 sessionId → 写会话 meta.workspace（"以文件夹为主"）；无 sessionId → 回退写 Agent sandbox_override（旧路径兼容）
   */
  handleTrusted<{ agentId: string; sessionId?: string; approval?: ApprovalMode; workspace?: string | null }>(
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
      let workspace = next.workspace as string | undefined;
      if (payload.workspace !== undefined) {
        if (payload.sessionId) {
          const updated = await setSessionWorkspace(payload.sessionId, payload.workspace ?? null);
          workspace = updated?.workspace ?? "";
        } else {
          next.workspace = payload.workspace ?? "";
          workspace = payload.workspace ?? "";
        }
      }
      if (payload.approval || payload.workspace === undefined) {
        await agentRegistry!.updateAgent(payload.agentId, { sandbox_override: next });
        sandbox!.setAgentConfig(payload.agentId, sandboxConfigFromOverride(next));
      }
      return { ok: true, approval: next.approval as ApprovalMode, workspace: workspace ?? "" };
    },
  );

  /** 会话级配置读取（审批模式 + 工作目录）；未单独配置时回退到全局权限默认审批 */
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:sessions:configGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const ov = agent?.sandbox_override;
    const globalDefault = getPermissions().globalApproval;
    const agentWorkspace = (ov && typeof ov === "object" && typeof ov.workspace === "string") ? ov.workspace : "";
    // 会话级工作目录优先（"以文件夹为主"模型）；无会话/无配置回退 Agent 级（旧数据）
    let workspace = agentWorkspace;
    let agentId = payload.agentId;
    if (payload.sessionId) {
      const meta = await getSession(payload.sessionId);
      agentId = meta?.agentId ?? payload.agentId;
      const ws = meta?.workspace?.trim();
      if (ws) { workspace = ws; }
    }
    return {
      approval: (ov && typeof ov === "object" && (ov.approval as ApprovalMode)) ?? globalDefault,
      workspace,
      agentId,
    };
  });

  /** 会话内切换调用的 Agent（保留工作文件夹/标题/历史；"以文件夹为主"模型多 Agent 协作） */
  handleTrusted<{ sessionId: string; agentId: string }>("slime:sessions:setAgent", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { throw new Error("会话不存在"); }
    const agent = await agentRegistry!.findAgent(payload.agentId);
    if (!agent) { throw new Error("Agent 不存在"); }
    const updated = await setSessionAgent(payload.sessionId, payload.agentId);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话切换 Agent: session=${payload.sessionId} ${meta.agentId} → ${payload.agentId}`);
    return { ok: true };
  });

  /** 团队会话成员更新（组长=会话当前 agentId；空数组 = 退回单人会话）
   *  - 成员名单持久化到会话元数据，引擎层将成员注入组长系统提示（团队协作规则）
   *  - 成员发言以"member"流事件冒泡到渲染层（群聊展示），并并入组长整合回复持久化 */
  handleTrusted<{ sessionId: string; memberIds: string[] }>("slime:sessions:setMembers", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionMembers(payload.sessionId, payload.memberIds);
    if (!updated) { throw new Error("会话不存在"); }
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const memberIds = Array.isArray(updated.members) ? updated.members : [];
    console.info(`[gui:main] 会话团队成员更新: session=${payload.sessionId} members=${memberIds.join(",") || "(单人会话)"}`);
    return {
      ok: true,
      session: {
        sessionId: updated.id,
        agentId: updated.agentId,
        agentName: names.get(updated.agentId) ?? updated.agentId,
        workspace: updated.workspace,
        title: updated.title,
        count: 0,
        lastTime: updated.updatedAt,
        memberIds,
        memberNames: memberIds.map((id) => names.get(id) ?? id),
      },
    };
  });

  /** 会话级工作目录更新（"以文件夹为主"：会话切换/新建时绑定文件夹） */
  handleTrusted<{ sessionId: string; workspace: string | null }>("slime:sessions:setWorkspace", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionWorkspace(payload.sessionId, payload.workspace);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话工作目录更新: session=${payload.sessionId} → ${updated.workspace ?? "(未绑定)"}`);
    return { ok: true, workspace: updated.workspace };
  });

  /** 加载会话级待办任务（由 todo_write 工具写入 data/todos_<sessionId>.json） */
  handleTrusted<{ sessionId: string }>("slime:sessions:loadTodos", async (_event, payload) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const { PROJECT_ROOT } = await import("../../../core-ts/src/paths.js");
    const p = path.join(PROJECT_ROOT, "data", `todos_${payload.sessionId}.json`);
    let todos: Array<{ id: string; content: string; status: string }> = [];
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { items: typeof todos };
      todos = parsed.items;
    } catch { /* 无历史文件视为空 */ }
    // 广播到所有渲染进程（支持多窗口场景）
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("slime:tasks:todos", { sessionId: payload.sessionId, todos });
    }
    return { ok: true, todos };
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

  /** 删除工作文件夹分组：清除该 workspace 下全部会话元数据 + 各会话历史（文件夹本身与 Agent 保留） */
  handleTrusted<{ workspace: string }>("slime:sessions:removeWorkspace", async (_event, payload) => {
    await ensureServices();
    const workspace = payload.workspace;
    const removed = await removeSessionsForWorkspace(workspace);
    for (const s of removed) {
      try { await clearSessionHistory(s.agentId, s.sessionId); } catch { /* 忽略单条历史清理失败 */ }
    }
    console.info(`[gui:main] 工作文件夹会话已删除: workspace=${workspace} count=${removed.length}`);
    return { ok: true, count: removed.length };
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

  /** 全局权限：读取（设置「权限」专栏） */
  handleTrusted<void>("slime:permissions:get", async () => getPermissions());

  /** 全局权限：写入（部分更新，返回合并后结果）；globalApproval 变更时同步所有 Agent 的 sandbox_override.approval，避免局部覆盖失效 */
  handleTrusted<Record<string, unknown>>("slime:permissions:set", async (_event, patch) => {
    const { ok, permissions, error } = setPermissions(patch);
    if (!ok) { return { ok: false, permissions, error }; }
    if (patch.globalApproval !== undefined || patch.approvalAllowPaths !== undefined) {
      try {
        const agents = agentRegistry!.loadedAgents;
        for (const a of agents) {
          const ov = (a.sandbox_override as Record<string, unknown>) ?? {};
          const next: Record<string, unknown> = { ...ov, approval: permissions.globalApproval };
          await agentRegistry!.updateAgent(a.id, { sandbox_override: next });
          sandbox!.setAgentConfig(a.id, sandboxConfigFromOverride(next));
        }
      } catch (e) {
        console.error("[gui:main] sync global approval to agents failed:", e);
      }
    }
    return { ok: true, permissions };
  });

  /** 权限请求：渲染层输入框选择题 → 用户决策回传（未匹配挂起请求视为陈旧丢弃） */
  handleTrusted<PermissionDecision>("slime:perm:resolve", async (_event, decision: PermissionDecision) => {
    const resolver = pendingPerms.get(decision.requestId);
    if (!resolver) {
      return { ok: false, error: "请求不存在或已超时" };
    }
    pendingPerms.delete(decision.requestId);
    resolver(decision);
    return { ok: true };
  });

  /** ask_user 提问：渲染层输入框选择题 → 用户回答回传（未匹配挂起请求视为陈旧丢弃） */
  handleTrusted<AskUserDecision>("slime:ask:resolve", async (_event, decision: AskUserDecision) => {
    const resolver = pendingAsks.get(decision.requestId);
    if (!resolver) {
      return { ok: false, error: "请求不存在或已超时" };
    }
    pendingAsks.delete(decision.requestId);
    resolver(decision);
    return { ok: true };
  });

  /** MCP 服务器状态列表（含被禁用的，供「MCP 接入」专栏恢复） */
  handleTrusted<void>("slime:extras:mcpList", async () => {
    await ensureServices();
    const { listMcpServers } = await import("./config_files.js");
    return listMcpServers();
  });

  /** 启用/禁用 MCP 服务器（注释/取消注释 [[mcp_servers]] 块） */
  handleTrusted<{ name: string; enabled: boolean }>("slime:extras:mcpToggle", async (_event, p) => {
    const res = setMcpEnabled(p.name, p.enabled);
    return res;
  });

  /** 技能库状态列表（含已禁用的，供「技能库」专栏恢复） */
  handleTrusted<void>("slime:extras:skillList", async () => {
    await ensureServices();
    const { listSkills } = await import("./config_files.js");
    return listSkills();
  });

  /** 启用/禁用技能（物理移动目录至 .disabled/ 下） */
  handleTrusted<{ name: string; enabled: boolean }>("slime:extras:skillToggle", async (_event, p) => {
    const res = setSkillEnabled(p.name, p.enabled);
    return res;
  });

  /** 打开技能目录（系统文件管理器） */
  handleTrusted<{ name: string }>("slime:extras:skillOpen", async (_event, p) => {
    const dir = skillDirPath(p.name);
    if (!existsSync(dir)) {
      return { ok: false, error: `技能目录不存在：${dir}` };
    }
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  });

  /** 删除技能（递归删除目录） */
  handleTrusted<{ name: string }>("slime:extras:skillDelete", async (_event, p) => {
    return deleteSkill(p.name);
  });

  /** 打开技能根目录（config/skills，系统文件管理器）——空列表时引导用户把技能放进来 */
  handleTrusted<void>("slime:extras:skillsRootOpen", async () => {
    const dir = resolve(PROJECT_ROOT, "config", "skills");
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        return { ok: false, error: `技能目录创建失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  });

  /** 打开 MCP 配置所在目录（slime.toml 所在项目根） */
  handleTrusted<void>("slime:extras:mcpOpen", async () => {
    const root = PROJECT_ROOT;
    if (!existsSync(root)) {
      return { ok: false, error: `项目目录不存在：${root}` };
    }
    const err = await shell.openPath(root);
    return { ok: !err, error: err || undefined };
  });

  /** 删除 MCP 服务器（从 slime.toml 移除块） */
  handleTrusted<{ name: string }>("slime:extras:mcpDelete", async (_event, p) => {
    return deleteMcp(p.name);
  });

  /** 导入文件（对话框）：返回本地路径，供聊天输入区引用为附件 */
  handleTrusted<void>("slime:files:pick", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择要加入对话的文件（图片 / 文档等）",
      properties: ["openFile"],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  /** 识图：选择图片（多选，最多 4 张）→ 主进程编码为 data URL（图片内容不落盘、不过 IPC 放大） */
  handleTrusted<void>("slime:images:pick", async (): Promise<{
    ok: boolean;
    images?: Array<{ name: string; mime: string; dataUrl: string }>;
    error?: string;
  }> => {
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择图片发送给模型识别（可多选，最多 4 张，单张 ≤ 8MB）",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
      ],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    const MIME: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    };
    const images: Array<{ name: string; mime: string; dataUrl: string }> = [];
    const rejected: string[] = [];
    for (const p of open.filePaths.slice(0, 4)) {
      try {
        const st = statSync(p);
        if (st.size > MAX_IMAGE_BYTES) {
          rejected.push(`${(p.split(/[\\/]/).pop() ?? p)}（${(st.size / 1024 / 1024).toFixed(1)}MB，超 8MB）`);
          continue;
        }
        const ext = "." + p.split(".").pop()!.toLowerCase();
        const mime = MIME[ext] ?? "image/png";
        const buf = readFileSync(p);
        images.push({
          name: p.split(/[\\/]/).pop() ?? p,
          mime,
          dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        });
      } catch (e) {
        rejected.push((p.split(/[\\/]/).pop() ?? p));
      }
    }
    if (images.length === 0) {
      return { ok: false, error: `图片读取失败${rejected.length ? `：${rejected.join("、")}` : ""}` };
    }
    return {
      ok: true,
      images,
      ...(rejected.length ? { error: `已跳过 ${rejected.join("、")}` } : {}),
    };
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

  /** 进化读取：生命周期 + 人格特质权重 + 行为沉淀/交互积累（心智中枢进化板块） */
  handleTrusted<{ agentId: string }>("slime:mind:evolutionGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    if (!agent) {
      return { ok: false, error: "Agent 不存在" };
    }
    const persona = (agent.persona as unknown as Record<string, unknown>) ?? {};
    const rawTraits = Array.isArray(persona.traits) ? (persona.traits as Array<Record<string, unknown>>) : [];
    const traits = rawTraits.map((t) => ({
      name: String(t.name ?? t.trait ?? "unknown"),
      weight: typeof t.weight === "number" ? t.weight : 0.5,
      last_used: typeof t.last_used === "string" ? t.last_used : null,
    }));
    const behavior = (agent.behavior ?? {}) as Record<string, unknown>;
    const patterns = Array.isArray(behavior.patterns) ? (behavior.patterns as unknown[]) : [];
    const interactions = Array.isArray(persona.interactions) ? (persona.interactions as unknown[]) : [];
    return {
      ok: true,
      agentName: agent.name,
      lifecycle: agent.lifecycle ?? "unknown",
      created_at: agent.created_at ?? null,
      traits,
      behaviorCount: patterns.length,
      interactionCount: interactions.length,
      evolution: (agent.evolution as Record<string, unknown>) ?? null,
    };
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
    await ensureServices(); // 确保进度 listener 已注册（否则下载进度事件丢失，进度条不实时）
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

  /** 启动/重试嵌入模型（下载完成后在状态面板手动触发） */
  handleTrusted<void>("slime:model:startEmbedding", async (): Promise<{ ok: boolean; error?: string; state?: string }> => {
    const mgr = getModelServer();
    if (!mgr) {
      return { ok: false, error: "模型服务器未初始化" };
    }
    const result = await mgr.startEmbedding();
    return { ok: result.ok, error: result.error, state: result.state };
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
    a2aBus?.register(a.name);
    mainWindow?.webContents.send("slime:agents:selected", a.id);
    return { id: a.id, name: a.name, role: a.role, children: [], parent_id: null, lifecycle: a.lifecycle ?? "unknown" } as AgentInfo;
  });

  handleTrusted<{ parentId: string; name: string; role: string }>("slime:agents:fork", async (_event, params) => {
    await ensureServices();
    const parent = await agentRegistry!.findAgent(params.parentId);
    if (!parent) { throw new Error("父 Agent 不存在"); }
    const child = await forkAgent(parent, params.name, params.role);
    selectedAgentId = child.id;
    a2aBus?.register(child.name);
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
        const aa = await agentRegistry!.findAgent(aid);
        if (aa) { a2aBus?.unregister(aa.name); }
      } catch (e) {
        console.warn(`[gui:main] A2A 注销失败 ${aid}:`, e);
      }
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
      show_thinking: a.show_thinking ?? "1",
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
    // 只把真正 ready 的角色当"运行中"，避免 embedding 未启动合成行(state=idle)误报"运行中"
    const ready = items.filter((i) => (i as unknown as { state: string }).state === "ready");
    const primary =
      ready.find((i) => (i as unknown as { role: string }).role === "inference") ??
      ready[0] ??
      null;
    if (!primary) { return { running: false } as SidecarStatus; }
    const vram = (primary as unknown as { vram_gb?: { used_gb?: number } | null }).vram_gb;
    return {
      running: true,
      port: (primary as unknown as { port: number }).port,
      model: (primary as unknown as { model?: string }).model,
      vram: vram?.used_gb,
      pid: (primary as unknown as { pid?: number | null }).pid ?? undefined,
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
      const res = await saveProvider(p);
      if (res.ok) {
        engine?.refreshProviders();
        console.info(`[gui:main] Provider 已保存并热更新: ${p.key}`);
      }
      return res;
    },
  );

  /** 一键刷新（上游模型更新同步）：用已保存密钥重新探测并合并，无需用户重新填写 */
  handleTrusted<{ key: string }>("slime:providers:refresh", async (_event, p) => {
    const res = await refreshProviderModels(p.key);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] Provider 模型列表已刷新: ${p.key}（总共 ${res.total ?? 0}，新增 ${res.added ?? 0}，移除 ${res.removed ?? 0}）`);
    }
    return res;
  });

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
      if (res.ok) {
        engine?.refreshProviders();
        console.info(`[gui:main] 本地模型已保存并热更新: ${p.id}`);
      }
      return res;
    },
  );

  handleTrusted<{ id: string }>("slime:providers:localRemove", async (_event, p) => {
    const res = removeLocalModel(p.id);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] 本地模型已删除并热更新: ${p.id}`);
    }
    return res;
  });

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
  handleTrusted<"quit" | "background">("slime:window:setExitMode", (_e, mode: "quit" | "background") => {
    exitModeStore = mode === "background" ? "background" : "quit";
    saveExitMode(exitModeStore);
    return { ok: true, mode: exitModeStore };
  });
  handleTrusted<void>("slime:window:getExitMode", () => ({ mode: exitModeStore }));

  /** 右侧栏「工作树」：列目录。path 必须锚定在 root 内（路径穿越保护） */
  /** 文件资源管理器：调系统对话框选择任意文件夹作为浏览根（与系统资源管理器互通） */
  handleTrusted<void>("slime:workspace:pickBrowseRoot", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      const openOpts: Electron.OpenDialogOptions = {
        title: "选择要打开的文件夹（可浏览任意位置）",
        properties: ["openDirectory", "createDirectory"],
      };
      const r = mainWindow
        ? await dialog.showOpenDialog(mainWindow, openOpts)
        : await dialog.showOpenDialog(openOpts);
      if (r.canceled || r.filePaths.length === 0) { return { ok: false, error: "已取消" }; }
      return { ok: true, path: r.filePaths[0] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 文件资源管理器：返回某目录的父级（供"上级"逐级向上浏览到磁盘根） */
  handleTrusted<{ path: string }>("slime:workspace:getParent", (_event, p): { ok: boolean; parent?: string | null; diskRoot?: boolean; error?: string } => {
    try {
      const cur = resolve(p.path || "");
      if (!cur) { return { ok: false, error: "路径为空" }; }
      const parent = dirname(cur);
      if (parent === cur) { return { ok: true, parent: null, diskRoot: true }; }
      return { ok: true, parent };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handleTrusted<{ root: string; rel: string }>("slime:workspace:list", (_event, p): WorkspaceListResult => {
    try {
      const root = resolve(p.root || "");
      if (!root) {
        return { ok: false, error: `工作根异常（${root}），已拒绝读取` };
      }
      if (!existsSync(root)) {
        return { ok: false, error: `工作目录不存在：${root}` };
      }
      // 相对路径规范化后拼接，校验仍在 root 内（root 为盘符根时其本身已带尾分隔符）
      const rel = (p.rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      const dir = rel ? resolve(root, ...rel.split("/")) : root;
      const rootNorm = root.endsWith(sep) ? root : root + sep;
      if (dir !== root && !dir.startsWith(rootNorm)) {
        return { ok: false, error: "路径越界：仅允许访问当前目录内部" };
      }
      const st = statSync(dir);
      if (!st.isDirectory()) {
        return { ok: false, error: "目标不是目录" };
      }
      const entries: WorkspaceEntry[] = readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith("."))
        .map((d) => {
          let size = 0;
          let isDir = d.isDirectory();
          if (!isDir) {
            try { size = statSync(join(dir, d.name)).size; } catch { size = 0; }
          }
          return {
            name: d.name,
            rel: rel ? `${rel}/${d.name}` : d.name,
            isDir,
            size,
          };
        });
      // 目录在前，按名称排序
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 右侧栏「工作树」：读取文件内容（文本/图片/二进制，主进程校验锚定） */
  handleTrusted<{ root: string; rel: string }>("slime:workspace:readFile", (_event, p): WorkspaceReadFileResult => {
    try {
      const root = resolve(p.root || "");
      if (!root) {
        return { ok: false, error: `工作根异常（${root}），已拒绝读取` };
      }
      if (!existsSync(root)) {
        return { ok: false, error: `工作目录不存在：${root}` };
      }
      const rel = (p.rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel) { return { ok: false, error: "缺少文件路径" }; }
      const filePath = resolve(root, ...rel.split("/"));
      const fileRootNorm = root.endsWith(sep) ? root : root + sep;
      if (!filePath.startsWith(fileRootNorm)) {
        return { ok: false, error: "路径越界：仅允许访问当前目录内部" };
      }
      if (!existsSync(filePath)) { return { ok: false, error: `文件不存在：${filePath}` }; }
      const st = statSync(filePath);
      if (st.isDirectory()) { return { ok: false, error: `不是文件（是目录）：${filePath}` }; }
      // 图片优先：常见 PNG/JPG/GIF/WebP/BMP/SVG
      const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
      const ext = "." + filePath.split(".").pop()!.toLowerCase();
      if (IMG_EXT.has(ext)) {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "image", content: buf.toString("base64") };
      }
      // 先读原始字节，再判定二进制：readFileSync(path, "utf-8") 在二进制上不会抛错（会静默按替换符解码），
      // 若直接当文本返回会得到乱码/超长字符串，渲染时拖垮乃至崩溃整个应用。
      const buf = readFileSync(filePath);
      const hasNul = binarySniff(buf);
      // 常见压缩包/归档/二进制扩展名直接判为 binary（阻止被当文本预览）
      const ARCHIVE_BINARY_EXT = new Set([
        ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".zst",
        ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
        ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
        ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node",
      ]);
      if (ARCHIVE_BINARY_EXT.has(ext) || hasNul) {
        return { ok: true, path: filePath, name: rel, mime: "binary", content: buf.toString("base64") };
      }
      // 文本：安全解码 + 体积上限（避免超大字符串打爆 IPC / 渲染线程）
      const MAX_TEXT = 512 * 1024;
      let text = buf.toString("utf-8");
      let truncated = false;
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
      return { ok: true, path: filePath, name: rel, mime: "text", content: text, truncated };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-173：按绝对路径直接读取文件（聊天消息内点击文件链接打开到右侧栏；无工作目录越界限制） */
  handleTrusted<{ path: string }>("slime:workspace:readFileAbs", (_event, p): WorkspaceReadFileResult => {
    try {
      const abs = typeof p.path === "string" ? p.path.trim().replace(/^["']|["']$/g, "") : "";
      if (!abs) { return { ok: false, error: "缺少文件路径" }; }
      if (!existsSync(abs)) { return { ok: false, error: `文件不存在：${abs}` }; }
      const st = statSync(abs);
      if (st.isDirectory()) { return { ok: false, error: `不是文件（是目录）：${abs}` }; }
      const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
      const ext = "." + abs.split(".").pop()!.toLowerCase();
      const name = abs.split(/[\\/]/).pop() ?? abs;
      if (IMG_EXT.has(ext)) {
        const buf = readFileSync(abs);
        return { ok: true, path: abs, name, mime: "image", content: buf.toString("base64") };
      }
      const buf = readFileSync(abs);
      const hasNul = binarySniff(buf);
      const ARCHIVE_BINARY_EXT = new Set([
        ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".zst",
        ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
        ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
        ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node",
      ]);
      if (ARCHIVE_BINARY_EXT.has(ext) || hasNul) {
        return { ok: true, path: abs, name, mime: "binary", content: buf.toString("base64") };
      }
      const MAX_TEXT = 512 * 1024;
      let text = buf.toString("utf-8");
      let truncated = false;
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
      return { ok: true, path: abs, name, mime: "text", content: text, truncated };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 工作树右键菜单：在主进程构建菜单模板，渲染层触发 popup */
  handleTrusted<{ root: string; params: import("../shared/ipc.js").WorkspaceContextMenuParams }>(
    "slime:workspace:contextmenu",
    (_event, p) => {
      const root = resolve(p.root || "");
      if (!root || !existsSync(root)) { return { ok: false, error: "工作目录不存在" }; }
      const params = p.params;
      const items: Array<{ label?: string; action?: string; accelerator?: string; enabled?: boolean; type?: "separator" }> = [];
      if (params.isDir) {
        items.push({ label: "在新标签打开", action: "open_in_tab", enabled: true });
        items.push({ label: "复制路径", action: "copy_path" });
        items.push({ type: "separator" as const });
        items.push({ label: "新建文件…", action: "new_file" });
        items.push({ label: "新建文件夹…", action: "new_folder" });
        items.push({ type: "separator" as const });
        items.push({ label: "重命名…", action: "rename" });
        items.push({ label: "删除", action: "delete" });
      } else {
        items.push({ label: "在新标签打开", action: "open_in_tab", accelerator: "Enter" });
        items.push({ label: "复制路径", action: "copy_path", accelerator: "Ctrl+C" });
        items.push({ type: "separator" as const });
        items.push({ label: "重命名…", action: "rename" });
        items.push({ label: "删除", action: "delete" });
      }
      return { ok: true, items };
    },
  );

  /** 工作树新建文件/文件夹 */
  handleTrusted<import("../shared/ipc.js").WorkspaceCreateItemParams>(
    "slime:workspace:create",
    (_event, p): import("../shared/ipc.js").WorkspaceCreateResult => {
      try {
        const root = resolve(p.root || "");
        if (!root || !existsSync(root)) { return { ok: false, error: "工作目录不存在" }; }
        const parentRel = (p.parentRel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
        const parentDir = parentRel ? resolve(root, ...parentRel.split("/")) : root;
        if (parentDir !== root && !parentDir.startsWith(root + sep)) {
          return { ok: false, error: "路径越界" };
        }
        const name = (p.name ?? "").trim();
        if (!name) { return { ok: false, error: "名称不能为空" }; }
        const fullPath = join(parentDir, name);
        if (fullPath !== root && !fullPath.startsWith(root + sep)) {
          return { ok: false, error: "路径越界" };
        }
        if (existsSync(fullPath)) { return { ok: false, error: `已存在同名项：${name}` }; }
        if (p.isDir) {
          mkdirSync(fullPath, { recursive: true });
        } else {
          writeFileSync(fullPath, "");
        }
        const rel = parentRel ? `${parentRel}/${name}` : name;
        return { ok: true, rel };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  /** 右侧栏「终端」：命令运行器（非 PTY；限时执行，cwd 默认工作目录） */
  handleTrusted<{ cmd: string; cwd?: string }>("slime:term:exec", (_event, p): Promise<TermResult> => {
    return new Promise((resolveResult) => {
      const cmd = (p.cmd ?? "").trim();
      if (!cmd) {
        resolveResult({ ok: false, stdout: "", stderr: "命令为空", code: null });
        return;
      }
      let cwd: string | undefined;
      if (p.cwd) {
        try {
          cwd = resolve(p.cwd);
          if (!existsSync(cwd)) { cwd = undefined; }
        } catch { cwd = undefined; }
      }
      exec(cmd, {
        cwd,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, SLIME_TERM: "1" },
      }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number | null }).code === "number" ? (err as { code?: number }).code as number : err ? 1 : 0;
        if (err && !(err as { killed?: boolean }).killed) {
          resolveResult({ ok: false, stdout, stderr: stderr || err.message, code });
          return;
        }
        resolveResult({ ok: true, stdout, stderr, code });
      });
    });
  });

  /** 右侧栏「Git 仓库」：检测路径是否为 Git 仓库（rev-parse + 顶层根 + 当前分支） */
  handleTrusted<{ path?: string }>("slime:git:detect", async (_event, p): Promise<GitDetect> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, isRepo: false, error: norm.error }; }
    const dir = norm.path;
    if (!norm.exists) {
      return { ok: true, isRepo: false, root: dir, notExists: true, error: "目录不存在，可初始化 Git 仓库时自动创建" };
    }
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { ok: true, isRepo: false, root: dir, error: "该目录还不是 Git 仓库" };
    }
    const toplevel = await runGit(["rev-parse", "--show-toplevel"], dir);
    const br = await runGit(["branch", "--show-current"], dir);
    return {
      ok: true,
      isRepo: true,
      root: toplevel.stdout.trim() || dir,
      branch: br.stdout.trim() || "",
    };
  });

  /** 右侧栏「Git 仓库」：初始化仓库（目录不存在可自动 mkdir；已是仓库直接成功） */
  handleTrusted<{ path?: string }>("slime:git:init", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const dir = norm.path;
    if (!norm.exists) {
      try { mkdirSync(dir, { recursive: true }); } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `创建目录失败：${msg}` };
      }
    }
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    if (inside.code === 0 && inside.stdout.trim() === "true") {
      return { ok: true };
    }
    const init = await runGit(["init"], dir);
    if (init.code !== 0) { return { ok: false, error: init.stderr.trim() || "git init 失败" }; }
    return { ok: true };
  });

  /** 右侧栏「Git 仓库」：读取分支 / 提交 / 状态 / 分支列表 */
  handleTrusted<{ path?: string }>("slime:git:info", async (_event, p): Promise<GitInfo> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const dir = norm.path;
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { ok: false, error: "不是 Git 仓库" };
    }
    const [br, log, st, bs] = await Promise.all([
      runGit(["branch", "--show-current"], dir),
      runGit(["log", "-20", "--pretty=format:%H%x1f%s%x1f%cI"], dir),
      runGit(["status", "--porcelain"], dir),
      runGit(["branch", "-a", "--format=%(refname:short)"], dir),
    ]);
    const commits = log.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, message, iso] = line.split("\x1f");
      return { hash: hash ?? "", message: message ?? "", time: iso ? iso.replace("T", " ").slice(0, 16) : "" };
    });
    // porcelain 首字符=index(暂存)，次字符=工作区；按暂存状态分组
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const deleted: string[] = [];
    for (const line of st.stdout.split("\n").filter(Boolean)) {
      if (line.startsWith("??")) { untracked.push(line.slice(3)); continue; }
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let f = line.slice(3).trim();
      const arrow = f.indexOf(" -> "); // 重命名/复制：old -> new
      if (arrow >= 0) { f = f.slice(arrow + 4); }
      if (x === "D" || y === "D") { deleted.push(f); }
      else if (x !== " " && x !== "?" && x !== "U") { staged.push(f); }
      else if (y !== " " && y !== "?" && y !== "U") { modified.push(f); }
    }
    const branches = bs.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    // 领先/落后远端（无上游时 = 0）
    let ahead = 0;
    let behind = 0;
    const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{u}"], dir);
    if (upstream.code === 0 && upstream.stdout.trim()) {
      const [a, b] = await Promise.all([
        runGit(["rev-list", "--count", "@{u}..HEAD"], dir),
        runGit(["rev-list", "--count", "HEAD..@{u}"], dir),
      ]);
      ahead = parseInt(a.stdout.trim(), 10) || 0;
      behind = parseInt(b.stdout.trim(), 10) || 0;
    }
    return {
      ok: true,
      branch: br.stdout.trim() || "main",
      commits,
      status: { staged, modified, untracked, deleted },
      branches,
      ahead,
      behind,
    };
  });

  /** 提交：全量暂存 + commit */
  handleTrusted<{ path?: string; message?: string }>("slime:git:commit", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const msg = (p?.message ?? "").trim();
    if (!msg) { return { ok: false, error: "提交信息为空" }; }
    const dir = norm.path;
    const add = await runGit(["add", "-A"], dir);
    if (add.code !== 0) { return { ok: false, error: add.stderr.trim() || "git add 失败" }; }
    const cm = await runGit(["commit", "-m", msg], dir);
    if (cm.code !== 0) {
      const err = cm.stderr.trim();
      if (err.includes("nothing to commit") || err.includes("no changes added")) {
        return { ok: false, error: "没有可提交的更改" };
      }
      return { ok: false, error: err || "git commit 失败" };
    }
    return { ok: true };
  });

  /** 推送（首次推送无上游时自动带 -u origin HEAD） */
  handleTrusted<{ path?: string }>("slime:git:push", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const push = await runGit(["push"], norm.path);
    if (push.code !== 0) {
      const err = push.stderr.trim();
      if (err.includes("No configured push destination") || err.includes("upstream")) {
        const up = await runGit(["push", "-u", "origin", "HEAD"], norm.path);
        if (up.code === 0) { return { ok: true }; }
        return { ok: false, error: up.stderr.trim() || "git push 失败" };
      }
      return { ok: false, error: err || "git push 失败" };
    }
    return { ok: true };
  });

  /** 拉取 */
  handleTrusted<{ path?: string }>("slime:git:pull", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const pull = await runGit(["pull"], norm.path);
    if (pull.code !== 0) { return { ok: false, error: pull.stderr.trim() || "git pull 失败" }; }
    return { ok: true };
  });

  /** 切换分支（本地无此分支但远端有时自动建跟踪分支） */
  handleTrusted<{ path?: string; branch?: string }>("slime:git:checkout", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const name = (p?.branch ?? "").trim();
    if (!name) { return { ok: false, error: "分支名为空" }; }
    const co = await runGit(["checkout", name], norm.path);
    if (co.code !== 0) {
      const track = await runGit(["checkout", "-b", name, `origin/${name}`], norm.path);
      if (track.code === 0) { return { ok: true }; }
      return { ok: false, error: co.stderr.trim() || "切换分支失败" };
    }
    return { ok: true };
  });

  /** 克隆远程仓库（选择目标父目录，克隆到 <父目录>/<仓库名>） */
  handleTrusted<{ url?: string }>("slime:git:clone", async (_event, p): Promise<GitCloneResult> => {
    try {
      const url = (p?.url ?? "").trim();
      if (!url) { return { ok: false, error: "仓库地址为空" }; }
      const openOpts: Electron.OpenDialogOptions = {
        title: "选择克隆目标父目录",
        properties: ["openDirectory", "createDirectory"],
      };
      const open = mainWindow
        ? await dialog.showOpenDialog(mainWindow, openOpts)
        : await dialog.showOpenDialog(openOpts);
      if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
      const parent = open.filePaths[0];
      const name = url.split("/").pop()?.replace(/\.git$/i, "") || "repo";
      const target = join(parent, name);
      if (existsSync(target)) { return { ok: false, error: `目标已存在：${target}` }; }
      const cl = await runGit(["clone", url, target], parent);
      if (cl.code !== 0) { return { ok: false, error: cl.stderr.trim() || "git clone 失败" }; }
      return { ok: true, path: target };
    } catch (e) {
      console.error("[gui:main] git:clone crashed:", e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 主题切换：同步标题栏系统按钮 overlay 配色（alpha=slate / beta=黑里透蓝） */
  handleTrusted<{ theme: string }>("slime:theme:set", (_event, p) => {
    if (p.theme === "beta") {
      mainWindow?.setTitleBarOverlay({ color: "#10172a", symbolColor: "#e6f1ff", height: 40 });
    } else {
      mainWindow?.setTitleBarOverlay({ color: "#1e293b", symbolColor: "#e2e8f0", height: 40 });
    }
  });
  handleTrusted<void>("slime:settings:autostart:get", async (): Promise<{ ok: boolean; enabled: boolean }> => {
    try {
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: s.openAtLogin };
    } catch (e) {
      console.warn("[gui:main] 读取开机自启失败:", e);
      return { ok: false, enabled: false };
    }
  });

  /** 开机自启：设置开关（设置 → 通用） */
  handleTrusted<{ enabled: boolean }>("slime:settings:autostart:set", async (_event, p): Promise<{ ok: boolean; enabled: boolean; error?: string }> => {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(p.enabled) });
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: s.openAtLogin };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] 设置开机自启失败:", e);
      return { ok: false, enabled: Boolean(p.enabled), error: msg };
    }
  });

  /** 卸载 Slime（设置 → 通用）：启动 NSIS 卸载器并退出应用 */
  handleTrusted<void>("slime:settings:uninstall", async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const exePath = app.getPath("exe");
      const uninstaller = join(dirname(exePath), "Uninstall Slime.exe");
      if (!existsSync(uninstaller)) {
        return { ok: false, error: `未找到卸载程序（${uninstaller}）。请到「控制面板 → 程序」或安装目录中运行卸载器。` };
      }
      spawn(uninstaller, [], { detached: true, stdio: "ignore" }).unref();
      app.quit();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] 启动卸载器失败:", e);
      return { ok: false, error: msg };
    }
  });

  /** 重置本地数据：清空 Provider / Agent / 会话与历史（记忆文件保留）。渲染层需先确认 */
  handleTrusted<void>("slime:data:reset", async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // 安全护栏：只允许清空 PROJECT_ROOT/config/ 下的应用数据文件，绝不触碰其他目录
      const cfgDir = resolve(PROJECT_ROOT, "config");
      const root = resolve(PROJECT_ROOT);
      if (!root || root === resolve(sep) || root === process.env.USERPROFILE || root === process.env.HOME) {
        return { ok: false, error: `数据根异常（${root}），已中止重置以保护文件` };
      }
      // 开发仓库保护：PROJECT_ROOT 若为源码仓库（含 .git 或 package.json+src/），
      // 说明运行的是开发版而非安装版，重置会误删开发机真实配置 → 直接拒绝
      const isDevRepo =
        existsSync(join(root, ".git")) ||
        (existsSync(join(root, "package.json")) && existsSync(join(root, "src")));
      if (isDevRepo) {
        return { ok: false, error: `检测到当前数据根是开发仓库（${root}），为保护开发配置已中止重置。请使用安装版（数据在 %APPDATA%\\slime-gui\\slime-data）执行重置。` };
      }
      const underConfig = (p: string): boolean => {
        const rp = resolve(p);
        return rp.startsWith(cfgDir + sep) || rp === cfgDir;
      };
      if (!underConfig(SESSIONS_PATH)) {
        return { ok: false, error: `会话文件路径不在应用数据目录内（${SESSIONS_PATH}），已中止重置` };
      }
      // 1) Agent：清历史 + 注销 A2A + 清空注册表并落盘
      const oldAgents = [...agentRegistry!.loadedAgents];
      for (const a of oldAgents) {
        try { await removeAgentHistory(a.id); } catch { /* 忽略单条失败 */ }
        try { a2aBus?.unregister(a.name); } catch { /* 忽略 */ }
      }
      agentRegistry!.loadedAgents.length = 0;
      await agentRegistry!.save();
      selectedAgentId = null;
      // 2) Provider 与本地模型注册：写空表
      const pr = clearAllProviders();
      if (!pr.ok && pr.error) { return { ok: false, error: pr.error }; }
      engine?.refreshProviders();
      // 3) 会话（仅删除 config/sessions.json 单文件，路径已校验在 config/ 内）
      try { if (existsSync(SESSIONS_PATH)) { rmSync(SESSIONS_PATH, { force: true }); } } catch { /* 忽略 */ }
      console.info(`[gui:main] 本地数据已重置（仅限 ${cfgDir} 下：providers.enc.json / agents.json / history.jsonl / sessions.json）`);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] 数据重置失败:", e);
      return { ok: false, error: msg };
    }
  });
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

  // V8 字节码缓存（VS Code 同款策略）：把首次编译的渲染层 bundle 结果落盘复用，
  // 跳过重复启动时的重新编译，明显缩短二次启动时间
  app.commandLine.appendSwitch("v8-cache-options", "code");

  // 禁用 GPU 加速：部分机器 GPU 进程崩溃导致窗口无法渲染（exit_code=-1）
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-sandbox");

  // 统一应用名：安装器写 HKCU Run 值名 "Slime"，而 setLoginItemSettings 用 app.getName()
  // 作值名（默认取 package.json name = "slime-gui"）——不同名会导致设置开关与安装勾选不同步。
  // 注意：boot.ts 已在模块加载时用 app.getPath("userData") 解析数据根（%APPDATA%\slime-gui），
  // 此处 setName 不会改变已解析的 userData 路径。
  app.setName("Slime");

  // 单实例锁：重复启动/残留实例时聚焦已有窗口而非再开一个无窗进程。
  // 否则第二个实例会因 SLIME_PORT(19000) 端口竞争 + Electron cache 锁(`拒绝访问`)
  // 而不显示窗口，表现为"安装后打不开"。拿到锁失败即退出，交由已有实例接管。
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    console.warn("[gui:main] 已存在 Slime 实例，退出本进程（聚焦已有窗口）");
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) { mainWindow.restore(); }
      mainWindow.focus();
      mainWindow.show();
    }
  });

  // CDP 远程调试端口（仅 dev 模式开启，便于 agent-browser 自动化接入）
  if (process.env.NODE_ENV !== "production") {
    app.commandLine.appendSwitch("remote-debugging-port", "9222");
  }

  app.whenReady()
    .then(async () => {
      // 先建窗口立即出首屏，后端 sidecar 并行启动（渲染层启动加载面板展示进度）
      registerProtocolHandler();
      createWindow();
      // 本地模型生命周期管理器（llama-server：BGE 嵌入 / 对话 GGUF），解析自 slime.toml [model_server]
      initModelServerManager();
      registerIpcHandlers();
      registerUpdaterHandlers(); // 注册自动更新 IPC handler
      // 更新状态推送到渲染进程（StatusPanel 监听 slime:update:status）
      setStatusSink((s) => mainWindow?.webContents.send("slime:update:status", s));
      initUpdater();             // 延迟检查更新（不阻塞首屏）
      // 启动状态推送到渲染进程（启动加载面板 slime:boot:event）
      setBootSink((s) => mainWindow?.webContents.send("slime:boot:event", s));
      void startPythonBackend(); // 并行启动，不阻塞窗口
      // dev 模式优先走 electron-vite dev server（渲染层热更新实时生效）；
      // 无 dev server 时（生产/直接 electron .）回退 slime:// 协议读磁盘产物
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      if (devUrl) {
        await mainWindow?.loadURL(devUrl);
        mainWindow?.webContents.on("did-finish-load", () => {
          console.info(`[gui:main] 渲染层已加载 (dev server: ${devUrl})`);
        });
      } else {
        mainWindow?.loadURL("slime://./index.html");
        mainWindow?.webContents.on("did-finish-load", () => {
          console.info("[gui:main] 渲染层已加载 (slime://)");
        });
      }
    })
       .catch((e) => { console.error("[gui:main] 启动失败:", e); process.exit(1); });

  app.on("window-all-closed", () => {
    terminatePythonBackend();
    silamBrain?.close();
    silamBrain = null;
    void terminateModelServer();
    if (process.platform !== "darwin") { app.quit(); }
  });
  app.on("before-quit", () => {
    appIsQuitting = true;
    tray?.destroy(); tray = null;
    terminatePythonBackend();
    silamBrain?.close();
    silamBrain = null;
    void terminateModelServer();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  });
}

void main();

// —— Python backend sidecar ——
let pythonBackend: ChildProcess | null = null;
const SLIME_PORT = process.env.SLIME_PORT || "19000";

/** 启动状态回调（渲染层启动加载面板消费） */
type BootStatusSink = (s: { phase: string; backendReady: boolean; message?: string }) => void;
let bootSink: BootStatusSink | null = null;
/** 最近一次启动状态（渲染层 invoke 查询用；错过 push 事件时兜底） */
let bootQuery: { phase: string; backendReady: boolean; message?: string } | null = null;
export function setBootSink(fn: BootStatusSink | null): void {
  bootSink = fn;
}
function emitBoot(s: { phase: string; backendReady: boolean; message?: string }): void {
  bootQuery = s;
  bootSink?.(s);
}

/** 打包模式下 electron-builder extraFiles 落到安装根（与 resources/ 平级） */
function resolveExtra(subpath: string): string {
  return join(INSTALL_ROOT, subpath);
}

async function startPythonBackend(): Promise<void> {
  emitBoot({ phase: "backend", backendReady: false, message: "正在启动本地后端服务…" });
  // 定位 Python venv（Windows: Scripts/python.exe，Linux/macOS: bin/python）
  const venvSub = process.platform === "win32" ? "Scripts" : "bin";
  const venvPyName = process.platform === "win32" ? "python.exe" : "python";
  const venvPython = resolveExtra(join("runtime", "venv", venvSub, venvPyName));

  const serverScript = resolveExtra("slime_server.py");
  if (!existsSync(venvPython) || !existsSync(serverScript)) {
    console.warn("[gui:backend] Python backend not found, running without server");
    emitBoot({ phase: "degraded", backendReady: false, message: "后端组件缺失，将以受限模式运行" });
    return;
  }

  const env: Record<string, string | undefined> = { ...process.env, SLIME_PORT };
  if (process.platform !== "win32") {
    // Linux/macOS：llama-server 动态库加载（extraFiles 布局：app 根/llama.cpp/build/bin）
    const libDir = resolveExtra(join("llama.cpp", "build", "bin"));
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
  }
  // 非 detached：让 python sidecar 随主进程生命周期结束（否则主程序退出/崩溃后其
  // 僵尸进程仍占住 SLIME_PORT(19000)，下次启动报 [Errno 10048] 绑定失败，且就绪
  // 检测会误读旧僵尸服务的 /health 而假报"已就绪"）。
  pythonBackend = spawn(venvPython, [serverScript], {
    env,
    windowsHide: true,
  });

  pythonBackend.stdout?.on("data", (data) => {
    console.info(`[slime-server] ${data.toString().trim()}`);
  });
  pythonBackend.stderr?.on("data", (data) => {
    console.error(`[slime-server:err] ${data.toString().trim()}`);
  });

  // 等待服务就绪（最多10秒；超时不再阻塞主窗口——渲染层加载面板展示中）
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://localhost:${SLIME_PORT}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.info("[gui:backend] slime_server.py 已就绪");
        emitBoot({ phase: "ready", backendReady: true, message: "后端服务已就绪" });
        return;
      }
    } catch {}
  }
  console.error("[gui:backend] slime_server.py 启动超时（10秒）");
  emitBoot({ phase: "degraded", backendReady: false, message: "后端服务启动超时（可用性受限）" });
}

function terminatePythonBackend(): void {
  if (pythonBackend) {
    pythonBackend.kill();
    pythonBackend = null;
  }
}

/** 初始化本地模型生命周期管理器（幂等；解析 slime.toml [model_server] 配置） */
let modelServerInit = false;
function initModelServerManager(): void {
  if (modelServerInit) { return; }
  modelServerInit = true;
  try {
    const cfg = readModelServerConfig();
    const mgr = new ModelServerManager({
      llama_bin: cfg.llama_bin ?? "",
      startup_timeout: cfg.startup_timeout,
      vram_budget_gb: cfg.vram_budget_gb,
      chat_est_gb: cfg.chat_est_gb,
      embedding: cfg.embedding,
      chat: cfg.chat,
    });
    setModelServer(mgr);
    void mgr.startup(); // 后台预加载常驻 BGE 嵌入实例（不阻塞主窗口）
    console.info("[gui:main] ModelServerManager 已初始化", { llama_bin: cfg.llama_bin ?? "(未配置)" });
  } catch (e) {
    console.error("[gui:main] 初始化 ModelServerManager 失败:", e);
  }
}

async function terminateModelServer(): Promise<void> {
  const mgr = getModelServer();
  if (mgr) {
    await mgr.shutdown().catch((e) => console.warn("[gui:main] 模型服务器关闭异常:", e));
  }
  setModelServer(new ModelServerManager({})); // 重置单例引用（防重复 shutdown）
}
