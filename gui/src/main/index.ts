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
import { INSTALL_ROOT, BUNDLE_ROOT } from "./boot.js";
// A-980-R31：子代理运行记录落盘（内存态 + 历史合并、终态快照持久化）
import { clearSubagentRuns, mergedSubagentRuns, syncSubagentRuns } from "./subagentStore.js";
// A-984：主进程事件循环卡死看门狗（埋点 + 掉拍检测 → data/watchdog.log）
import { startMainWatchdog, markMainActivity } from "./watchdog.js";
// A-986：意外退出保底（脏标记判定异常退出 + 清障 + 留证 → data/crash-report.log）
import { sweepAfterCrash, markRunning, markCleanExit } from "./crashGuard.js";

// A-937：退出行为（模块级，IPC handlers 与窗口 close 拦截共用）
let exitModeStore: "quit" | "background" = "quit";
let tray: Electron.Tray | null = null;
let appIsQuitting = false;
const exitModePath = () => join(app.getPath("userData"), "exit-mode.json");

/** B：审批前置分类——把 sandbox 权限请求映射为分类器输入做调用前复核。
 *
 * 【设计原则】分类器不再靠「工具名子串」猜风险，而是**服从工具自述 + slime 自身审批策略**：
 *   1. 从注册表取工具，读它声明的 `riskKind`（缺省由 permissions 推导）；
 *   2. 未注册工具 → **fail-closed**（需确认），绝不默认放行；
 *   3. read 类 → 直接放行；
 *   4. write/terminal/network 类 → 先跑硬规则（`..` 越权、敏感文件、受保护源码目录、
 *      rm -rf / curl|sh 等 block 特征始终生效），再按工具是否声明 `autoApprovable` 决定：
 *        声明了 → 允许 auto；未声明 → 一律收敛为「需用户确认」。
 *   这样可以杜绝 adb_install / adb_connect / http_create_app 这类新工具因名字不匹配
 *   三档正则而被静默放行，也让「设置 → 权限」成为唯一权威。 */
function classifyPermissions(actions: Array<{ action: string; target: string }>): {
  hasBlocked: boolean;
  allAuto: boolean;
  reasons: string[];
} {
  let hasBlocked = false;
  let allAuto = true;
  const reasons: string[] = [];
  const registry = getRegistry();
  for (const a of actions) {
    const name = (a.action ?? "").toLowerCase();
    const target = (a.target ?? "").trim();
    const tool = registry.get(name);

    // ① 未注册工具：不猜、不放行，交给用户审批
    if (!tool) {
      allAuto = false;
      reasons.push(`${name}: 未注册工具，需用户确认（fail-closed）`);
      continue;
    }

    const kind = tool.effectiveRiskKind();
    let r: { level: "auto" | "confirm" | "block"; reason: string; matched: string };

    if (kind === "read") {
      r = { level: "auto", reason: `只读工具 ${name}`, matched: "read" };
    } else if (kind === "terminal") {
      const { command, commandArgs } = splitCommand(target);
      r = assessAction({ kind: "terminal", command, commandArgs });
    } else if (kind === "write") {
      r = assessAction({ kind: "write", path: target });
      // 引擎源码/契约/宿主目录写入一律 block（防 Agent 自我改写护栏），仅锚定 PROJECT_ROOT 内不误伤用户工作区
      if (r.level !== "block" && isProtectedSourcePath(target, PROJECT_ROOT)) {
        r = { level: "block", reason: `受保护源码目录禁止写入：${target.slice(0, 60)}`, matched: "protected-dir" };
      }
    } else {
      r = assessAction({ kind: "network", url: target });
    }

    // ② 非只读工具未声明 autoApprovable 时，分类器的 auto 一律降级为「需确认」——
    //    免审批权只有工具自己显式声明才能拿到（web_search / file_write 等无副作用动作）。
    //    只读类（kind === "read"）不参与降级：纯读取无副作用，不需要每次审批。
    if (kind !== "read" && r.level === "auto" && !tool.autoApprovable) {
      r = { level: "confirm", reason: `${name}（${kind} 类）未声明可自动放行，需用户确认`, matched: "policy-confirm" };
    }

    if (r.level !== "auto") { allAuto = false; }
    if (r.level === "block") { hasBlocked = true; }
    reasons.push(`${name}: ${r.reason}`);
  }
  return { hasBlocked, allAuto, reasons };
}
try {
  const raw = readFileSync(exitModePath(), "utf8");
  exitModeStore = raw.trim() === "background" ? "background" : "quit";
} catch { exitModeStore = "quit"; }
const saveExitMode = (mode: "quit" | "background"): void => {
  try { writeFileSync(exitModePath(), mode, "utf8"); } catch { /* ignore */ }
};

// 全局子代理默认模型（对齐 Claude Code subagents model: frontmatter 全局版，A-942）
// 持久化 userData/subagent-model.json；空串 = 不覆盖（回退 inherit）
let subagentDefaultModel = "";
const subagentModelPath = () => join(app.getPath("userData"), "subagent-model.json");
try {
  subagentDefaultModel = readFileSync(subagentModelPath(), "utf8").trim();
} catch { subagentDefaultModel = ""; }
const saveSubagentDefaultModel = (model: string): void => {
  subagentDefaultModel = model;
  try { writeFileSync(subagentModelPath(), model, "utf8"); } catch { /* 落盘失败不阻断 */ }
};

// 用户选定的子代理（设置→子代理菜单勾选的自建 agent，A-918+）
// 持久化 userData/subagent-selection.json；自动派发优先级 = 用户选定子代理 > slime 自建专家
let subagentSelectedAgentIds: string[] = [];
const subagentSelectionPath = () => join(app.getPath("userData"), "subagent-selection.json");
try {
  const rawSel = JSON.parse(readFileSync(subagentSelectionPath(), "utf8")) as { selectedAgentIds?: unknown };
  if (Array.isArray(rawSel.selectedAgentIds)) {
    subagentSelectedAgentIds = rawSel.selectedAgentIds.filter((x): x is string => typeof x === "string");
  }
} catch { subagentSelectedAgentIds = []; }
const saveSubagentSelection = (ids: string[]): void => {
  subagentSelectedAgentIds = ids;
  try { writeFileSync(subagentSelectionPath(), JSON.stringify({ selectedAgentIds: ids }), "utf8"); } catch { /* 落盘失败不阻断 */ }
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
import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, session, shell, Tray, Menu, nativeImage } from "electron";
import { join, resolve, sep, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { spawn, exec, execFile, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { installAdBlocker } from "./adblock.js";
import { basePortFor, getModelServer, ModelServerManager, setModelServer } from "../../../core-ts/src/model_server.js";
// S1：本地服务能力**问询**（`/props` + `/v1/models`）。纯逻辑在 core-ts/src/model_introspect.ts，
// 这里只拿"发请求 + 缓存"的部分；resolveSessionWindowCap 是它目前唯一的读取者。
import { capabilityMatchesModel, clearLocalCapabilityCache, getLocalCapability, isLoopbackBaseUrl, probeManagedChatCapability } from "./localServerProbe.js";
import { resolveWindowCap } from "../../../core-ts/src/model_introspect.js";
import { ChatService } from "../../../core-ts/src/services/chat.js";
import { SchedulerService } from "../../../core-ts/src/services/scheduler.js";
import { SubAgentManager, type SubagentDefinition } from "../../../core-ts/src/services/subagent.js";
import { setSubagentManager, setMemoryStoreProvider, setAdbService, setHttpServer, setSidebarOpener, setScreenController } from "../../../core-ts/src/tools/builtin.js";
import { setBrowserAdapter } from "../../../core-ts/src/tools/browser.js";
import { BrowserBridge } from "./browserBridge.js";
import { StreamChunkBatcher } from "./streamBatch.js";
import { assessAction, splitCommand, isProtectedSourcePath } from "../../../core-ts/src/tools/classifier.js";
import { adbService, type AdbDetect, type AdbDevice, type AdbCmdResult, type AdbScreencapResult, type AdbDownloadProgress } from "./adb.js";
import { annotateBitmap } from "../shared/imageAnnotate.js";
// A-1012：群聊席位上限与参与名单判据的**唯一实现**（引擎与建群弹窗共用，杜绝"上限只有引擎知道"）
import { groupParticipantIds } from "../../../shared/gen/groupRoster.js";
import { httpServer } from "./httpServer.js";
import { createServer } from "node:http";
import { ServerA2ABus } from "../../../core-ts/src/a2a.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";
// A-980-R29：待办存储唯一真源（工具与主进程共用；别再各自手搓路径/解析）
import { readTodos, removeTodos, writeTodos, todosToPlanStatus, demoteStaleInProgress } from "../../../core-ts/src/services/todoStore.js";
import { loadUsage, clearUsage, rewriteUsageCosts } from "../../../core-ts/src/services/usage.js";
import { getLlmGatewayManager, readLlmGatewayConfig, type LlmGatewayConfig } from "./llmGateway.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine, buildSilamTraitSignals } from "../../../core-ts/src/services/engine.js";
import { ChatClient, AnthropicClient } from "../../../core-ts/src/llm/client.js";
import { inferApiFormat, type RouteEntry } from "../../../core-ts/src/router.js";
import { chromiumFetch } from "./providers.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, UsageSnapshot, UsageRecomputeResult, SidecarStatus, PermissionDecision, PermissionRequestUI, PermissionOption, AskUserRequestUI, AskUserDecision, WorkspaceEntry, WorkspaceListResult, WorkspaceReadFileResult, TermResult, GitDetect, GitInfo, GitAction, GitCloneResult, GitDiffResult, CompressResult } from "../shared/ipc.js";
import { isBrowserSchemeUrl } from "../shared/ipc.js";
import { parseUnifiedDiff } from "./git_diff.js";
import { initUpdater, registerUpdaterHandlers, setStatusSink } from "./updater.js";
import {
  listProviders, enrichModels, saveProvider, removeProvider, clearAllProviders, refreshProviderModels,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
  buildPriceResolver,
  type ProviderSummary, type LocalModelSpec,
} from "./providers.js";
import { overview as configOverview, readConfigFile, writeConfigFile, setMcpEnabled, setSkillEnabled, deleteSkill, deleteMcp, skillDirPath } from "./config_files.js";
// A-980-R26：系统通知 + 可定制提示音（设置 → 通用）
import { initNotify, notifyUser, readNotifyConfig, writeNotifyConfig, importSound, clearSound, readSoundData, customSoundPath } from "./notify.js";
import { getPermissions, setPermissions } from "./permissions.js";
import { SlimeEngine } from "../../../core-ts/src/services/engine.js";
import { SilamBrainClient, readSilamConfig, type SilamBrain, type SilamAffectState } from "../../../core-ts/src/services/silam_brain.js";
import { decryptRaw } from "../../../core-ts/src/encryption.js";
import { removeAgentHistory, loadHistory, appendHistory, attachTimelineToRecord, type HistoryRecord } from "../../../core-ts/src/services/history.js";
import { SkillRegistry } from "../../../core-ts/src/skills.js";
import { getRegistry, setToolCategoryGate } from "../../../core-ts/src/tools/registry.js";
import {
  getScreenController,
  DesktopScreenBackend,
  AndroidScreenBackend,
  setImageOptimizer,
} from "../../../core-ts/src/screen/index.js";
import { MemoryStore } from "../../../core-ts/src/memory/store.js";
import { createTrace, beginSpan, endSpan, emitEvent, attachEval, type Trace, type TraceEventKind } from "../../../core-ts/src/observability/trace.js";
import { parsePlan, type Plan, type PlanStageStatus } from "../../../core-ts/src/planning/plan.js";
import { runGroupTalk, parseMentions, type GroupTalkParticipant, type StreamEmit, type TranscriptLine } from "../../../core-ts/src/services/grouptalk.js";

// 全局兜底：任何未捕获的 Promise rejection 不得终止主进程——Node 默认 throw 模式会让
// 整个应用直接退出（用户感知为"软件自己关了"）。记录后继续运行；具体逻辑错误仍由各调用点 try/catch 处理。
process.on("unhandledRejection", (reason) => {
  console.error("[gui:main] 未捕获的 Promise rejection（已拦截，主进程继续运行）:", reason);
});

// ── D：全链路可观测（引擎 stream 真实事件点 → trace spans → 渲染层 TraceViewer） ──
// sessionId → 最近一次请求的 Trace 快照（内存驻留；流结束经 slime:trace:update 广播）
//
// A-980-R24：**加上限**。此前是纯 `Map` 且全仓无 `delete`——每开一个新会话就永久多留一份 Trace
// （含 40 个 span + 字符串快照），长时间使用（尤其群聊/子 Agent 会不断产生新 sessionId）主进程
// 内存只增不减，是"用久了越来越卡、最后崩"的慢性根因之一。
// 现在用「Map 保序 = 插入序」做 LRU：超上限时删最早插入的键，并设 TTL 拒绝过期快照。
const traceStore = new Map<string, Trace>();
const TRACE_STORE_MAX = 60;
const TRACE_STORE_TTL_MS = 30 * 60 * 1000;
function traceStoreSet(key: string, trace: Trace): void {
  // 重新插入以刷新 LRU 位置（Map 的 set 对已存在键不改顺序，故先删再插）
  traceStore.delete(key);
  traceStore.set(key, trace);
  while (traceStore.size > TRACE_STORE_MAX) {
    const oldest = traceStore.keys().next();
    if (oldest.done) { break; }
    traceStore.delete(oldest.value);
  }
}
/** 读取前的过期清理（TraceViewer 拉取旧会话时用；过期直接当没有） */
function traceStoreGet(key: string): Trace | undefined {
  const t = traceStore.get(key);
  if (!t) { return undefined; }
  const at = t.endedAt ?? t.startedAt;
  if (Number.isFinite(at) && Date.now() - at > TRACE_STORE_TTL_MS) {
    traceStore.delete(key);
    return undefined;
  }
  return t;
}
/** chunk/reasoning 逐 token 级事件采样上限，防止 spans 爆炸 */
const TRACE_SAMPLE_CAP = 40;
function capStr(s: string, n: number): string {
  return typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s;
}

/** 单次请求的 trace 记录器：把引擎事件映射为带时间的 span，请求结束收敛（success/eval）。 */
class TraceRecorder {
  private trace: Trace;
  private counts = new Map<string, number>();
  constructor(sessionId?: string) {
    const t = createTrace({ sessionId });
    this.trace = beginSpan(t, { name: "turn:start", kind: "route_select" }).trace;
  }
  /** 事件推进（tool → call+result 双联 span；chunk/reasoning 采样；error → eval 失败）。 */
  push(ev: { type: string; data?: unknown }): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "tool") {
      const name = String(d.name ?? "");
      const { trace, spanId } = beginSpan(this.trace, {
        name: `tool:${name}`,
        kind: "tool_call",
        data: { args: capStr(String(d.args ?? ""), 200) },
      });
      this.trace = endSpan(trace, spanId, { result: capStr(String(d.result ?? ""), 240) });
      return;
    }
    const kindOf: Record<string, TraceEventKind> = { chunk: "reply_chunk", reasoning: "reasoning_chunk" };
    const kind = kindOf[ev.type];
    if (!kind) { return; }
    const n = (this.counts.get(kind) ?? 0) + 1;
    if (n > TRACE_SAMPLE_CAP) { return; }
    this.counts.set(kind, n);
    this.trace = emitEvent(this.trace, kind, kind === "reply_chunk" ? "chunk" : "reasoning", {
      idx: n,
      content: capStr(String(d.content ?? ""), 160),
    });
  }
  /** 收敛：失败时挂 completion eval=false + 错误，成功挂 eval=true；统一 done 收尾。 */
  finish(ok: boolean, notes?: string): Trace {
    this.trace = attachEval(this.trace, "completion", ok, ok ? undefined : capStr(notes ?? "", 200));
    return emitEvent(this.trace, "done", "turn:done");
  }
  get(): Trace { return this.trace; }
}

/** D IPC：读取某会话最近一次 trace；渲染层 TraceViewer 用 */
function registerTraceHandlers(): void {
  ipcMain.handle("slime:trace:get", (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== "string") { return null; }
    const t = traceStoreGet(sessionId);
    return t ? { sessionId, ...t } : null;
  });
}

// ── E：Plan 一等对象（plan_create/plan_update/todo_write 工具返回 → 会话级 planStore → PlanPanel） ──
// sessionId → 当前 Plan（内存驻留；工具结果流经 slime:plan:update 广播；重启后可由工具输出重建）
const planStore = new Map<string, Plan>();
/** planStore 上限：只用于展示的派生数据，没必要无限驻留（超限按 updatedAt 淘汰最旧） */
const PLAN_STORE_MAX = 64;
const PLAN_TOOLS = new Set(["plan_create", "plan_update", "todo_write"]);

/**
 * A-980-R30：子代理管理器引用（供 fixedSegments 注入「可用子代理」清单）。
 *
 * 为什么需要这个引用：此前可用子代理只活在管理器内部，**模型完全不知道能问谁** ——
 * 工具描述里硬编码三个方向，用户勾选的自建 Agent 名字从不进提示词，于是"配好了也派不到"。
 * Claude Code 的做法是把 name + description 清单写进上下文，模型才能按描述自动选人或显式点名。
 */
let subagentsRef: SubAgentManager | null = null;

/** 把子代理目录渲染成系统提示段（无任何子代理时返回空数组，不占上下文） */
function subagentCatalogSegment(): string[] {
  const cat = subagentsRef?.catalog?.() ?? [];
  if (cat.length === 0) { return []; }
  const user = cat.filter((c) => c.source === "user");
  const builtin = cat.filter((c) => c.source !== "user");
  const lines = [
    "## 可用子代理（delegate_subagent）",
    "你可以把**独立、自包含**的子任务交给下列子代理并行执行（各自独立上下文与工具面，产出会作为工具结果交回给你验收）：",
  ];
  if (user.length > 0) {
    lines.push("用户选定的子代理（优先用）：");
    for (const c of user) { lines.push(`- ${c.name}：${c.description}`); }
  }
  if (builtin.length > 0) {
    lines.push("内置专家子代理：");
    for (const c of builtin) { lines.push(`- ${c.name}：${c.description}`); }
  }
  lines.push('用法：`delegate_subagent({ agent: "<上面的名字>", task: "目标 + 期望输出格式 + 边界" })`；不点名则由系统按任务语义自动选。');
  lines.push("派发后**必须验收**产出：对照目标核对是否真的完成、产物是否落地；存疑就点名同一子代理追问，或自己补齐——不要把子代理的结论不加核对地当事实转述给用户。");
  return [lines.join("\n")];
}


/** 会话被删除时清掉其 Plan 与待办文件（此前两者都只增不减：内存常驻 + data/ 堆垃圾） */
function purgeSessionPlanning(sessionId: string): void {
  if (!sessionId) { return; }
  planStore.delete(sessionId);
  removeTodos(sessionId);
}

/**
 * 解析工具返回：plan_create/plan_update 从结果 JSON 还原；todo_write 从 `todos_<session>` 落盘文件还原。
 *
 * ⚠️ 这是一条**有损的单向派生**（真源仍是待办文件本身）：`todo_write` 没有自己的 Plan 对象，
 * PlanPanel 要显示就得在这里把清单映射成「阶段」。因此必须：
 * ① 用 `todoStore.readTodos` 读同一份文件（别再手搓路径/解析）；
 * ② 打上 `source: "todo"` —— 真 Plan（plan_create）优先级更高，不允许被派生数据顶掉（见 interceptPlanTool）；
 * ③ `status` 由进度推导，**不能恒定 "planning"**（否则全做完了还显示"规划中"）。
 */
function planFromToolResult(name: string, result: string, sessionId: string): Plan | null {
  if (name === "plan_create" || name === "plan_update") {
    const idx = result.indexOf("\n"); // 工具返回形如 "[Plan 已创建] id（…）\n{json}"
    const json = idx >= 0 ? result.slice(idx + 1) : result;
    const p = parsePlan(json);
    return p ? { ...p, source: "plan" } : null;
  }
  if (name === "todo_write" && sessionId) {
    const items = readTodos(sessionId); // 空 sessionId / 文件缺失 / 损坏 → []（store 内已兜底）
    if (items.length === 0) { return null; }
    const statusMap: Record<string, PlanStageStatus> = { pending: "pending", in_progress: "in_progress", completed: "done", done: "done" };
    return {
      id: `todo-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "s"}`,
      sessionId,
      description: items[0]!.content.slice(0, 60),
      stages: items.map((it, i) => ({
        id: it.id || String(i + 1),
        label: it.content.slice(0, 120),
        status: statusMap[it.status] ?? "pending",
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: todosToPlanStatus(items),
      source: "todo",
    };
  }
  return null;
}

/** planStore 落盘 + 淘汰超限项（只保留最近的 N 个会话） */
function putPlan(sessionId: string, plan: Plan): void {
  planStore.set(sessionId, plan);
  if (planStore.size <= PLAN_STORE_MAX) { return; }
  const sorted = [...planStore.entries()].sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  for (const [sid] of sorted.slice(0, planStore.size - PLAN_STORE_MAX)) { planStore.delete(sid); }
}

/**
 * A-980-R27：todo_write 落盘后**立刻**把列表推给渲染层。
 *
 * 此前全仓库只有「切会话」时经 `slime:sessions:loadTodos` 主动拉一次，
 * Agent 在会话中途写待办没有任何广播 → 右侧栏停在旧快照上，
 * 用户体感就是"待办面板不动/像摆设"。这里在工具拦截点补上推送。
 *
 * A-980-R29：读取改用 `todoStore.readTodos`（与工具同一份实现），
 * 并**总是**广播（含空列表）—— 否则模型 `clear` 掉待办后界面会一直留着旧项。
 */
function broadcastTodos(sessionId: string): void {
  if (!sessionId) { return; }
  const todos = readTodos(sessionId).map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    // completedAt 必须带上：界面完成标记的时间戳来源（缺了会退化成"没有时间"的旧样式）
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
  }));
  mainWindow?.webContents.send("slime:tasks:todos", { sessionId, todos });
  // A-980-R32：推送之后再判"是否已全部完成" → 排一次自动清空（见该函数注释）
  scheduleTodoAutoClear(sessionId, todos);
}

/**
 * A-980-R32：全部完成 → **自动清空**待办（用户明确要求，同时移除了手动的 ✕ 与「清完成」）。
 *
 * 为什么清空必须落在主进程，而不是渲染层"看不见就算了"：
 * 待办的唯一真源是 `data/todos_<sid>.json`。渲染层 setTodos([]) 只是清掉内存镜像，
 * 文件还在 → 下次 `slime:sessions:loadTodos`（切会话、重启、重挂载）原样读回来，
 * 症状就是"界面明明清空了，重启后旧清单又复活"。
 *
 * 为什么要延迟而不是立即清：留给「划过」动画（--todo-sweep 0.36s + 沉降 0.9s）播完的时间，
 * 否则最后一项刚变勾就被删掉，用户根本看不到完成反馈。
 * 1.5s 内若又有新的 `todo_write`（模型连续写两次很常见），计时器**重置**并重新判定，
 * 避免"第一次的定时器把第二次刚写的、还没做完的清单清掉"。
 */
const TODO_AUTO_CLEAR_MS = 1500;
const todoAutoClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A-985：**本进程已做过"僵尸 in_progress 收敛"的会话**。
 *
 * 只在**首次**读某会话的待办时收敛一次（进程刚起时一定没有活跃流，所以这一次是安全的）。
 * 之后不再重复：若每读一次都降级，会把用户/模型刚标记的"进行中"立刻打回待办 —— 那才是真 bug。
 */
const staleChecked = new Set<string>();

/** 全部完成判定：**必须有项**（空列表不算"全部完成"，否则会与 clear 语义打架） */
function allTodosCompleted(todos: Array<{ status?: string }>): boolean {
  return todos.length > 0 && todos.every((t) => t.status === "completed");
}

function scheduleTodoAutoClear(sessionId: string, todos: Array<{ status?: string }>): void {
  const pending = todoAutoClearTimers.get(sessionId);
  if (!allTodosCompleted(todos)) {
    // 不再是"全完成"（模型又加了一项 / 用户手动取消勾选）→ 撤销已排队的清空
    if (pending) { clearTimeout(pending); todoAutoClearTimers.delete(sessionId); }
    return;
  }
  if (pending) { clearTimeout(pending); }
  const timer = setTimeout(() => {
    todoAutoClearTimers.delete(sessionId);
    removeTodos(sessionId);
    // 清空后必须再广播一次（空列表）——渲染层据此把面板收干净，并重置它的"刚刚完成"基线
    broadcastTodos(sessionId);
  }, TODO_AUTO_CLEAR_MS);
  todoAutoClearTimers.set(sessionId, timer);
}

/**
 * 工具轮拦截：Plan 类工具结果 → planStore 更新 + 广播渲染层。
 *
 * A-980-R29：两条规划链路（`plan_create` 真 Plan / `todo_write` 派生 Plan）共用同一个 sessionId key，
 * 原先后到的会**顶掉**先到的 → 模型只要顺手调一次 todo_write，就能把用户正在看的真 Plan 冲掉。
 * 现在按 `source` 定优先级：真 Plan 不被派生 Plan 覆盖（派生 Plan 可以被真 Plan 覆盖）。
 */
function interceptPlanTool(ev: { type: string; data?: unknown }, sessionId: string): void {
  if (ev.type !== "tool" || !sessionId) { return; }
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const name = String(d.name ?? "");
  if (!PLAN_TOOLS.has(name)) { return; }
  // 待办列表走独立通道（右侧栏「待办任务」面板订阅 slime:tasks:todos），
  // 与 PlanPanel 的 slime:plan:update 并行推，两个面板各自即时刷新
  if (name === "todo_write") { broadcastTodos(sessionId); }
  const result = String(d.result ?? "");
  const plan = planFromToolResult(name, result, sessionId);
  if (!plan) { return; }
  const prev = planStore.get(sessionId);
  if (plan.source === "todo" && prev?.source === "plan") {
    // 会话已有真 Plan：派生数据只做兜底，不顶掉真 Plan
    return;
  }
  putPlan(sessionId, plan);
  mainWindow?.webContents.send("slime:plan:update", { sessionId, plan });
}

/** E IPC：读取某会话的当前 Plan；渲染层 PlanPanel/StatusPanel 用 */
function registerPlanHandlers(): void {
  ipcMain.handle("slime:plan:get", (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== "string") { return null; }
    return planStore.get(sessionId) ?? null;
  });
}

// ── A-950：群聊发言调度主线（@ 路由 + 抢答/顺序 + 全程流式 + 思考事件） ──

/** A-955：流式拆分正文中的 <thinking>…</thinking>——
 *  思考段重定向给 onThink（进右栏碰撞流），正文只输出标签外文本；
 *  支持标签跨 chunk 与未闭合结尾兜底（未闭合尾巴 → 视为思考，正文不回显）。 */
function makeThinkingStripper(onText: (s: string) => void, onThink: (s: string) => void): { push: (chunk: string) => void; finish: () => void } {
  const OPEN = /<thinking(?:\s[^>]*)?>/i;
  const CLOSE = /<\/thinking\s*>/i;
  const OPEN_PREFIX = "<thinking";
  const CLOSE_PREFIX = "</thinking";
  // 判断 s 是否为标签的前缀（区分大小写不敏感、且不含已闭合的 >）
  const isPrefixOf = (full: string) => (s: string): boolean => {
    const up = s.toLowerCase();
    return !up.includes(">") && up.length > 0 && up.length <= full.length && full.startsWith(up);
  };
  const isOpenPfx = isPrefixOf(OPEN_PREFIX);
  const isClosePfx = isPrefixOf(CLOSE_PREFIX);
  /** buf 末尾若挂着可能是未闭合标签的前缀（从最后一个 '<' 起），返回该尾巴；否则 null */
  const prefixTail = (pred: (s: string) => boolean): string | null => {
    const idx = buf.lastIndexOf("<");
    if (idx < 0) { return null; }
    const s = buf.slice(idx);
    return pred(s) ? s : null;
  };
  let buf = "";
  let inThink = false;
  const scan = (): void => {
    while (true) {
      if (inThink) {
        const m = CLOSE.exec(buf);
        if (m) {
          if (m.index > 0) { onThink(buf.slice(0, m.index)); }
          buf = buf.slice(m.index + m[0].length);
          inThink = false;
          continue;
        }
        const t = prefixTail(isClosePfx);
        if (t) { buf = buf.slice(0, buf.length - t.length); }
        if (buf) { onThink(buf); buf = ""; }
        if (t) { buf = t; }
        return;
      }
      const o = OPEN.exec(buf);
      if (o) {
        if (o.index > 0) { onText(buf.slice(0, o.index)); }
        buf = buf.slice(o.index + o[0].length);
        inThink = true;
        continue;
      }
      const t = prefixTail(isOpenPfx);
      if (t) { buf = buf.slice(0, buf.length - t.length); }
      if (buf) { onText(buf); buf = ""; }
      if (t) { buf = t; }
      return;
    }
  };
  return {
    push: (chunk: string) => { buf += chunk; scan(); },
    finish: () => { if (buf) { onThink(buf); buf = ""; } inThink = false; },
  };
}
// 组装成 ServiceEvent 风格 {seq,type,data} 事件流（member/done）+ 状态事件（slime:brainstorm:event）。
async function* streamGroupTalkFlow(opts: {
  engine: SlimeEngine;
  members: AgentState[];
  topic: string;
  sessionId?: string;
  networkEnabled?: boolean;
}): AsyncGenerator<{ seq: number; type: string; data: Record<string, unknown> }> {
  const started = Date.now();
  let seq = 0;
  const broadcastStatus = (payload: Record<string, unknown>): void => {
    if (!opts.sessionId) { return; }
    mainWindow?.webContents.send("slime:brainstorm:event", { sessionId: opts.sessionId, ...payload });
  };
  // A-951：每成员独立上下文池——记账（prompt 字符估算 ≈0.6 token/字）→ 右栏进度条 & 超阈值压缩
  const estTok = (s: string): number => Math.round(((s ?? "").length || 0) * 0.6);
  const usage = new Map<string, { used: number; cap: number }>();
  const QUOTA = 0.8; // 80% 触发压缩
  const capOf = (agent: AgentState): number => {
    const raw = (agent as { max_context?: unknown }).max_context;
    return typeof raw === "number" && raw > 0 ? raw : 32000;
  };
  const noteUsage = (agent: AgentState, prompt: string): void => {
    const cur = usage.get(agent.id) ?? { used: 0, cap: capOf(agent) };
    cur.used += estTok(prompt);
    usage.set(agent.id, cur);
  };
  const quotaOf = (id: string): { used: number; cap: number } => usage.get(id) ?? { used: 0, cap: 32000 };
  // 压缩：超 80% → 讨论记录每行截断 60 字（保议题 + 观点要点），标注已压缩；
  // 压缩后按压缩视图重新记账——进度条反映该成员池的"当前足迹"而非累计投入
  const compressTranscript = (memberId: string, transcript: TranscriptLine[]): TranscriptLine[] | undefined => {
    const u = quotaOf(memberId);
    if (u.used < u.cap * QUOTA) { return undefined; }
    const packed = transcript.map((l, i) => (i === 0 ? l : { ...l, content: l.content.slice(0, 60) + "…" }));
    const packedTokens = estTok(transcript.map((l) => l.content).join("\n"));
    if (u.used > packedTokens) { usage.set(memberId, { used: packedTokens, cap: u.cap }); }
    return packed;
  };
  // 成员流式发言（engine.stream：思考/正文边到边；思考摘要另发状态事件）
  const toParticipant = (agent: AgentState): GroupTalkParticipant => {
    // A-1011：推理强度不再写死 high —— 由成员组装处按会话成员卡设置注入（readEffort ?? "high"），
    // 这里只做兜底（万一调用方没注入，保持改前的 high 行为）。
    const thinking = { ...agent, reasoning_effort: agent.reasoning_effort || "high" };
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      speakStream: async (prompt: string, e: StreamEmit): Promise<string> => {
        let rep = "";
        noteUsage(agent, prompt); // 独立记账
        const quota = quotaOf(agent.id);
        broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", used: quota.used, cap: quota.cap });
        // A-955：正文中的 <thinking>…</thinking> 全部拆出→思考流；正文干净、思考进右栏碰撞流
        const split = makeThinkingStripper(
          (t) => { e.chunk(t); rep += t; },
          (t) => {
            e.reasoning(t);
            broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", chunk: t, ...quotaOf(agent.id) });
          },
        );
        try {
          for await (const ev of opts.engine.stream({
            agent: thinking,
            message: prompt,
            history: [],
            systemPrompt: `${agent.identity_prompt || `你是 ${agent.name}，你的角色是：${agent.role}`}\n\n输出规范：正文只输出你的观点（≤200 字、一段、直接可读），严禁在正文中出现 <thinking> 标签、思考过程、草稿、自我检查或任何元叙述；思考只能作为你的内部过程。如需最新信息可调用 web_search / web_fetch（仅联网工具），并注明来源。\n\n硬性输出约束：必须直接围绕议题输出有信息量的实质内容；严禁输出「我在听/请说得更明确/你想问什么/先给个目标/我正在衡量」这类空泛确认、反问式等待或仅自我介绍（身份声明最多一句话前缀，正文须立即进入实质回答）；若议题看似不完整，按最可能的意图直接作答并顺带询问唯一的待确认点。`,
            toolsOnly: opts.networkEnabled ? ["web_search", "web_fetch"] : [],
            maxTokens: 2048,
            networkEnabled: opts.networkEnabled,
          })) {
            if (ev.type === "reasoning" && ev.content && ev.content.trim()) {
              e.reasoning(ev.content);
              broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", chunk: ev.content, ...quotaOf(agent.id) });
            } else if (ev.type === "chunk" && ev.content) {
              split.push(ev.content);
            } else if (ev.type === "done") {
              // A-958：SILAM 等一次性 done 模型的正文只在 done.reply（不吐 chunk）。
              // 仅当全程未产出任何正文时才兜底注入，避免与已流式吐出的 chunk 重复。
              const d = ev as { reply?: unknown };
              if (!rep && typeof d.reply === "string" && d.reply.trim()) {
                split.push(d.reply);
              }
            }
          }
        } catch (err) {
          rep = `（${agent.name} 本次发言失败：${err instanceof Error ? err.message : String(err)}）`;
          e.chunk(rep);
        }
        split.finish();
        return rep;
      },
    };
  };

  // @ 路由（A-950）：点名 1 人 → single；点名多人/@全体 → seq（逐个非并发，后见前文）；未点名 → contest 抢答
  const names = opts.members.map((a) => a.name);
  const { all, mentions } = parseMentions(opts.topic, names);
  const byId = new Map(opts.members.map((a) => [a.name, a.id]));
  const targets = mentions.map((n) => byId.get(n)).filter((x): x is string => Boolean(x));
  let mode: "single" | "seq" | "contest" = "contest";
  if (targets.length === 1) { mode = "single"; }
  else if (targets.length > 1 || all) { mode = "seq"; }

  const memberEvents: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
  const emitMember = (m: { name: string; memberId: string }, payload: Record<string, unknown>): void => {
    memberEvents.push({ seq: ++seq, type: "member", data: { name: m.name, agentId: m.memberId, ...payload } });
  };
  void broadcastStatus; // 状态经 slime:brainstorm:event 广播（thinking 实时）
  let flowDone = false;
  let runErr: Error | null = null;
  const flow = runGroupTalk({
    members: opts.members.map(toParticipant),
    topic: opts.topic,
    mode,
    targets: mode !== "contest" ? targets : undefined,
    compressTranscript,
    onSpeechStart: (m) => {
      broadcastStatus({ memberId: m.memberId, name: m.name, state: "speaking", ...quotaOf(m.memberId) });
    },
    onChunk: (m, text) => emitMember(m, { content: text }),
    onSpeechEnd: (m, full) => {
      broadcastStatus({ memberId: m.memberId, name: m.name, state: "done", content: full, ...quotaOf(m.memberId) });
      // A-1008：本次发言失败 → 追加一条"结束通知"，让渲染层把该成员刚生成的气泡降级为错误样式。
      // 判据只在"整段正文"上成立（chunk 逐段到达时判不出），所以不能塞进上面的 onChunk。
      // 顺序安全：memberEvents 是同一个 FIFO 队列，本事件必然排在该成员最后一个 chunk 之后
      // （contest 回放路径同样成立——onSpeechEnd 在每个 slot 回放循环结束处触发）。
      if (isSpeechFailure(full)) { emitMember(m, { speechEnd: true, failed: true }); }
    },
    onDone: () => { /* 落库在下方 */ },
  }).then((r) => ({ r })).catch((e: unknown) => {
    runErr = e instanceof Error ? e : new Error(String(e));
    return null;
  });
  // 事件不经缓冲直接流式（runGroupTalk 已保证同一时刻只有一个成员在输出）
  while (!flowDone) {
    while (memberEvents.length > 0) { yield memberEvents.shift()!; }
    const done = await Promise.race([flow.then(() => true as const), new Promise<false>((r) => setTimeout(() => r(false as const), 30))]);
    flowDone = done;
  }
  while (memberEvents.length > 0) { yield memberEvents.shift()!; }
  if (runErr) { throw runErr; }
  const res = (await flow)!;
  // A-948：群聊发言落库（带名字聚合）——重启可恢复
  // A-1008：**同时**落结构化 turns —— 只落那个拼好的大字符串会让 GUI 侧读回来变成
  // "一条署名会话归属 Agent、内容把所有人揉在一起"的巨长气泡：这正是用户历时很久的
  // 「总有一个 Agent 出来把所有内容总结复述一遍」+「重启后只剩那个总结的 Agent」的同一根因。
  // `ai` 仍是拼好的文本（模型侧历史照旧），`turns` 只多存一份给界面按成员展开。
  if (opts.sessionId && res.r.transcript.length > 1) {
    try {
      const idByName = new Map(opts.members.map((m) => [m.name, m.id]));
      const turns = res.r.transcript.slice(1).map((l) => ({
        name: l.speaker,
        agentId: idByName.get(l.speaker),
        content: l.content,
        ...(l.failed ? { failed: true } : {}),
      }));
      const body = formatSpeakerBlob(turns);
      await appendHistory(opts.members[0].id, (opts.topic ?? "").trim() || "（群聊议题）", body, true, opts.sessionId, undefined, Date.now() - started, turns);
    } catch (e) {
      console.warn(`[grouptalk] 群聊历史落库失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A-946：不追加"结论/组长"消息——收束由用户
  yield {
    seq: ++seq,
    type: "done",
    data: { reply: "", reply_raw: "", model: "grouptalk", prompt_tokens: 0, completion_tokens: 0, elapsed_ms: Date.now() - started },
  };
}
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
  ensureDefaultSession, setSessionMembers, setSessionType, removeSessionsForAgent, removeSessionsForWorkspace,
  setSessionAgent, setSessionWorkspace, setSessionSummary, touchSessionWithMessage, SESSIONS_PATH,
  memberIdsOf, memberModelsOf, memberEffortsOf, setSessionMemberEffort, type MemberEntry,
} from "../../../core-ts/src/services/sessions.js";
import { loadHistoryForSession, loadHistoryForSessionBefore, clearSessionHistory, clearLegacySessionHistory } from "../../../core-ts/src/services/history.js";
import { formatSpeakerBlob, isSpeechFailure, expandHistoryRecord, type ExpandedMessage } from "../../../core-ts/src/services/grouptalkTranscript.js";
import { needsCompress, estimateHistoryTokens, DEFAULT_TAIL_KEEP, DEFAULT_COMPRESS_RATIO } from "../../../core-ts/src/services/context_compress.js";
import { SandboxManager, defaultSandboxConfig, type SandboxConfig } from "../../../core-ts/src/sandbox.js";
// A-980-R32：点击路径的多基准候选解析（纯逻辑，vitest 直测）
import { buildTargetCandidates, normalizeTargetPath } from "./targetPath.js";

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
/** A-1017：最近一次本地模型请求的取消键 —— 「正在加载本地模型」面板上的「取消加载」按它中断加载。
 *  面板本身改由 ModelServerManager 的状态广播驱动（不再由本文件预判），广播那一刻拿不到本次流的 key，
 *  只能在这里记一笔。用"最近一次"是合理的：加载必然由某次请求触发，且 chat 实例同时只有一个。 */
let lastChatCancelKey: string | null = null;
let sandbox: SandboxManager | null = null;
/** 权限请求 → 渲染层等待用户抉择的挂起解析器（requestId → resolver） */
const pendingPerms = new Map<string, (decision: PermissionDecision) => void>();
/**
 * 后台子代理的会话 ID 前缀（配合 core-ts 子代理流）。
 * A-980-R31：**这里也是一个关键的静默失败源**——子代理会话与用户当前会话永远不相等，
 * 渲染层的会话过滤会把这些交互请求静默丢弃，于是它们既不展示、也不立即失败，
 * 而是挂满 5 分钟超时（PERM_TIMEOUT_MS / ASK_TIMEOUT_MS）才被拒/跳过。
 * 实测后果：子代理在等一个永远不会出现的用户点击，直到自己的执行预算耗尽 → 被记为"超时中断"。
 * 所以这两类请求必须在**主进程**就按"后台无人可交互"处理掉。
 */
const SUBAGENT_SESSION_PREFIX = "__subagent__:";
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

/** 已注册的 IPC channel（A-1020 去重防护用，见 `handleTrusted`） */
const REGISTERED_CHANNELS = new Set<string>();

/**
 * 安全基线（官方清单 #17）：所有 IPC handler 统一走 sender 白名单校验。
 * 校验失败直接 reject，渲染层收到 rejected promise。
 *
 * ⚠️ A-1020：对同一 channel 调两次 `ipcMain.handle` 会**直接 throw**
 *   （`Attempted to register a second handler for 'xxx'`）。而 `registerIpcHandlers`
 *   是**线性注册**的大函数 —— 任何一条 throw 都会让**它之后的所有 handler 全部失去注册**，
 *   并且是在 `app.whenReady` 阶段抛的，表现为**整个应用打不开**。
 *   实测踩坑：A-1019 给 `slime:theme:set` 补持久化时**加了新 handler 却忘删旧的**，
 *   于是 `dev` 直接起不来（用户原话："打都打不开了"）。
 *
 *   两层防护（缺一不可）：
 *     ① 这里：重复注册时**先摘掉旧的再注册**，把失败模式从"app 打不开"降级为
 *        "app 能开 + 一行醒目的 console.error"。**不静默** —— 静默失败同样致命。
 *     ② CI：`tests/core-ts/a1020-guards.spec.ts` 扫源码，重复 channel 直接红。
 */
function handleTrusted<T>(
  channel: string,
  fn: (event: Electron.IpcMainInvokeEvent, payload: T) => unknown,
): void {
  if (REGISTERED_CHANNELS.has(channel)) {
    console.error(
      `[gui:main] ⚠️ IPC channel 重复注册: "${channel}" —— 旧的 handler 已被覆盖。` +
      `多半是"加了新 handler 却忘删旧的"，请在 gui/src/main/index.ts 里删掉其中一处。`,
    );
    try {
      ipcMain.removeHandler(channel);
    } catch (e) {
      console.error(`[gui:main] removeHandler("${channel}") 失败:`, e);
    }
  }
  REGISTERED_CHANNELS.add(channel);
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
      // B：调用前分类器预检——block 直拒（防社工，不进弹窗）、全部 auto 直放、其余走弹窗
      const cls = classifyPermissions(req.actions);
      if (cls.hasBlocked) {
        resolve({
          requestId: req.requestId,
          approved: false,
          approvedActions: [],
          deniedActions: req.actions.map((a) => a.action),
          reason: `[分类器预检拦截] ${cls.reasons.join("；")}`,
          autoApproved: false,
        });
        return;
      }
      if (cls.allAuto) {
        resolve({
          requestId: req.requestId,
          approved: true,
          approvedActions: req.actions.map((a) => a.action),
          deniedActions: [],
          reason: `[分类器自动放行] ${cls.reasons.join("；")}`,
          autoApproved: true,
        });
        return;
      }
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) {
        resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: [req.actions[0].action], reason: "无窗口", autoApproved: false });
        return;
      }
      // A-980-R31：后台子代理的授权请求 → **立即拒绝并说清原因**，不要推给渲染层。
      // 理由：① 子代理跑在 `__subagent__:*` 会话，渲染层会话过滤必然丢弃它（无人可见）；
      //      ② 于是它会挂满 PERM_TIMEOUT_MS（5 分钟）才被拒 —— 这段时间子代理什么都没做，
      //         最后往往被自己的执行预算判成"超时中断"（用户看到的"子代理超时率 100%"有它一份）；
      //      ③ 后台任务本来就不该静默替用户点"允许"，fail-closed 才是正确姿势。
      // 立即拒绝 + 可操作原因，能让子代理**当场换一条不需要授权的路**把任务做完。
      const reqSid = req.sessionId ?? agentStreamSessionMap.get(req.agentId);
      if (typeof reqSid === "string" && reqSid.startsWith(SUBAGENT_SESSION_PREFIX)) {
        resolve({
          requestId: req.requestId,
          approved: false,
          approvedActions: [],
          deniedActions: req.actions.map((a) => a.action),
          reason:
            "该操作需要用户授权，但这是后台子代理（无人可交互确认）→ 已直接拒绝。"
            + "请改用不需要授权的做法完成任务（例如只读分析、基于已有信息给结论），"
            + "并在最终产出里如实说明哪一步因权限被跳过。",
          autoApproved: false,
        });
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
    // A-965 core-ts↔server 通报：SILAM 情绪/成长态 → server 人格演化（fire-and-forget）
    onSilamEvolve: notifySilamEvolve,
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
        const segs: string[] = [];
        try {
          const a = agentRegistry!.loadedAgents.find((x) => x.name === agent.name);
          const emotion = new EmotionalState((a?.emotion as Record<string, unknown>) ?? undefined);
          const behavior = BehaviorStore.fromDict(a?.behavior ?? {});
          segs.push(...buildMindSegments(emotion, behavior));
        } catch (e) {
          console.warn(`[gui:mind] 心智固定段注入失败: ${e}`);
        }
        // A-980-R30：可用子代理清单（模型据此决定委派给谁 / 点名谁）
        try {
          segs.push(...subagentCatalogSegment());
        } catch (e) {
          console.warn(`[gui:subagent] 子代理清单注入失败: ${e}`);
        }
        return segs;
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
        // A-980-R31：后台子代理不能向用户提问（同权限请求的道理：渲染层会按会话丢弃 → 白挂 5 分钟）。
        // 按「跳过」立即返回，子代理据此基于合理默认继续，并在产出里写明这个假设。
        const askSid = req.sessionId ?? agentStreamSessionMap.get(req.agentId);
        if (typeof askSid === "string" && askSid.startsWith(SUBAGENT_SESSION_PREFIX)) {
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
        // A-980-R26：「需要用户做选择」→ 系统通知（模型在等回答，用户可能没盯着这个窗口；
        // 弹通知不出现在渲染层，故不受渲染层切会话过滤影响）
        notifyUser({
          kind: "choice",
          title: `${ui.agentName || "Agent"} 需要你选择`,
          body: (ui.question || ui.header || "有一个待确认的选择").slice(0, 160),
        });
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
      // A-918++：注册生命周期钩子 → 实时推送 subagent start/complete/error 事件到 renderer（修复"用户从没见过 subagent 活动"）
      const subagents = new SubAgentManager(async (def, ctx) => {
        const ag = def.agentId
          ? (await agentRegistry?.findAgent(def.agentId))
          : undefined;
        let target = ag ?? agentRegistry?.loadedAgents[0];
        // v2 模型路由：def.model 为显式路由（api:<key>[:<model>] / local:<id>）时覆盖目标模型；inherit/缺省 = 沿用目标 agent 默认模型
        if (def.model && /^(api:|local:)/.test(def.model.trim()) && target) {
          target = { ...target, model_choice: def.model.trim() };
        }
        if (!target) { throw new Error(`子代理「${def.name}」找不到可执行 Agent`); }
        if (!engine) { throw new Error("引擎未就绪"); }
        const system = def.systemPrompt ?? (await engine.buildSystem(target, undefined, undefined));
        // A-978：子代理流必须带专属 sessionId（`__subagent__:<runId>`），否则 chunk 的 sessionId 为 undefined，
        // 渲染器过滤逻辑（cSid == null 时回退 streamSessionRef 判定）会把子代理 chunk 误判为主 Agent 流，
        // 导致主 Agent 监测栏（tokens/耗时/tokens/s）被子代理数据污染（用户实测"指定 subagent 模型后主 Agent 动作也被认定"）。
        const subagentSessionId = `${SUBAGENT_SESSION_PREFIX}${def.id ?? def.name}`;
        // A-980-R30 **深度守卫**：子代理不再获得派发/收取子代理的能力。
        // 理由：本管理器没有深度计数（不像 Claude Code 有 MAX_SUBAGENT_SPAWN_DEPTH），
        // 子代理若能再 delegate，每层 3 并发 → 指数级套娃；Anthropic 也明确多智能体的
        // 协调成本可能超过收益。需要多级时走「链式」：主 Agent 依次派发并把上下文转交下一个。
        const dispatchTools = new Set(["delegate_subagent", "subagent_result"]);
        const allToolNames = engine.listTools?.().map((t) => t?.function?.name).filter((n): n is string => !!n) ?? [];
        const subToolsOnly = def.toolsOnly
          ?? (allToolNames.length > 0 ? allToolNames.filter((n) => !dispatchTools.has(n)) : undefined);
        // A-980-R31 **超时率 100% 的根因**：此前这里没有把 `ctx.signal` 交给 engine.stream，
        // 于是 SubAgentManager.execute() 里那句 `setTimeout(() => controller.abort(), timeoutMs)`
        // 只是让一个**没人监听**的信号变成 aborted——模型流照旧跑到自然结束
        // （实测：120s 预算实跑 332.3s），最后收尾时再按 signal.aborted 把它**归因**为"超时中断"。
        // 即：不是模型慢，是中断从来没生效过。现在把 signal 透传进去（引擎 abort → 底层请求中断 → 携部分正文收尾）。
        // 断链 C 修复：继承父请求的联网开关（ctx.networkEnabled 由 SubAgentManager.execute 透传）。
        // 用户关掉联网后，主 Agent 派出的子代理也必须关（否则「关了还偷偷联网」）；
        // 父未传时 ctx.networkEnabled 为 undefined → 引擎缺省即 true（保住 A-918+「缺省即开」）。
        let reply = "";
        const acc: string[] = [];
        for await (const ev of engine.stream({
          agent: target,
          message: def.task,
          history: [],
          systemPrompt: system,
          sessionId: subagentSessionId,
          signal: ctx?.signal,
          networkEnabled: ctx?.networkEnabled,
          ...(subToolsOnly ? { toolsOnly: subToolsOnly } : {}),
        })) {
          // 注意顺序：先消费事件、再判中断。引擎在 abort 之后会 yield 一个**携带部分正文**的 done，
          // 旧写法在读取前就 `break`，这份部分产出被直接丢掉 → 落盘 0 字节、
          // 主 Agent 只拿到一句"超时中断"（用户："失败了，但怎么一个记录都没有"）。
          if (ev.type === "chunk" && typeof ev.content === "string") {
            acc.push(ev.content);
          } else if (ev.type === "done" && typeof ev.reply === "string") {
            reply = ev.reply;
          }
          if (ctx?.signal.aborted) { break; }
        }
        // done 未到达（异常/提前跳出）时用累积增量兜底；引擎的中断占位文案不算产出
        const aborted = ctx?.signal.aborted === true;
        if (!reply || reply.trim() === "（生成已被中断）") { reply = acc.join(""); }
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        // 中断也落盘（带归因头），不再写 0 字节空文件——"没有记录"本身就是最坏的结果
        const body = reply.trim()
          ? `${aborted ? "> ⚠️ 本次执行被中断，以下为中断前已产出的部分内容。\n\n" : ""}${reply}`
          : `> 本次执行${aborted ? "被中断" : "结束"}，子代理未产出任何正文。\n`;
        writeFileSync(join(dir, `subagent-${def.name}-${stamp}.md`), body, "utf8");
        return reply;
      }, {
        concurrency: 3,
        hooks: {
          // A-980-R31：每次广播运行态时顺手把**新到达终态**的记录落盘。
          // 为什么放在广播点而不是只放 onComplete/onError：取消「排队中」的任务是在
          // SubAgentManager.cancel() 里直接改状态、**不触发任何钩子**，只挂钩子会漏掉这一类记录。
          onStart: (run) => {
            console.log(`[subagent] 开始 ${run.name} (${run.id})`);
            syncSubagentRuns(subagents.list());
            // A-918+：派发即推送，让右侧栏「子代理」区立即看到（不等 4s 轮询）
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          onComplete: (run) => {
            console.log(`[subagent] 完成 ${run.name}${run.structured ? "（含结构化结果）" : ""}`);
            syncSubagentRuns(subagents.list());
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          onError: (run) => {
            console.warn(`[subagent] ${run.status} ${run.name}: ${run.error ?? ""}`);
            syncSubagentRuns(subagents.list());
            mainWindow?.webContents.send("slime:resident:update", null);
          },
        },
      });

      // v2 自动委派：注册专家子代理定义（description 是自动路由键），供 delegate() 依描述自动选人
      subagents.register({
        name: "代码审查员",
        description: "审查代码质量、发现潜在 bug、静态分析、给出改进建议",
        systemPrompt: "你是资深代码审查专家，输出问题清单与修复建议。",
        model: "inherit",
        // A-980-R31：执行预算 120s→300s（原值配上"abort 不生效"= 必然超时；预算应防挂死，不该是常态失败源）
        timeoutMs: 300_000,
        outputSchema: true,
      });
      subagents.register({
        name: "调研员",
        description: "联网搜索资料、汇总信息、多来源调研与引用整理",
        systemPrompt: "你是多来源调研专家，输出带引用的结构化调研摘要。",
        model: "inherit",
        timeoutMs: 300_000,
        outputSchema: true,
      });
      subagents.register({
        name: "数据分析员",
        description: "数据清洗、统计、表格/指标计算与分析",
        systemPrompt: "你是数据分析专家，输出可核验的统计与结论。",
        model: "inherit",
        timeoutMs: 300_000,
        outputSchema: true,
      });

      // A-918+：注册用户选定的自建 agent 作为子代理（派发优先级 = 用户选定 > 内置专家）。
      // 读 subagent-selection.json → findAgent → 包装成 SubagentDefinition（description=role 作路由键，
      // systemPrompt=identity_prompt，agentId 绑定具体持久 agent），打 userSelected:true。
      const syncUserSelectedSubagents = async (): Promise<void> => {
        const defs: SubagentDefinition[] = [];
        for (const id of subagentSelectedAgentIds) {
          const ag = await agentRegistry?.findAgent(id).catch(() => undefined);
          if (!ag) { continue; }
          defs.push({
            name: ag.name,
            description: `${ag.name}：${ag.role}`,
            systemPrompt: ag.identity_prompt?.trim() || `你是「${ag.name}」，负责：${ag.role}。`,
            agentId: ag.id,
            model: "inherit",
            timeoutMs: 300_000,
            outputSchema: true,
          });
        }
        subagents.setUserSelected(defs);
        if (defs.length > 0) {
          console.log(`[subagent] 已登记 ${defs.length} 个用户选定子代理：${defs.map((d) => d.name).join("、")}`);
        }
      };
      void syncUserSelectedSubagents();

      // 自动委派注入：把管理器挂到 delegate_subagent 工具（模型对话中可自行委派）
      setSubagentManager(subagents);
      // A-980-R30：同时挂到 fixedSegments 的清单注入（让模型知道"能问谁"）
      subagentsRef = subagents;
      // 全局子代理默认模型：恢复上次设置（无显式 def/委派模型时生效；继承优先级最低）
      if (subagentDefaultModel) {
        subagents.setDefaultModel(subagentDefaultModel);
        console.log(`[subagent] 全局默认模型已应用：${subagentDefaultModel}`);
      }

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
        // A-980-R31：内存运行态 + 落盘历史合并（重启后不再是空白面板 / 消失的下拉按钮）
        subagents: mergedSubagentRuns(subagents.list()),
        defaultModel: subagents.getDefaultModel(),
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
      ipcMain.handle("slime:resident:subagent:spawn", (_e, p: { name?: string; task?: string; systemPrompt?: string; agentId?: string; model?: string; timeoutMs?: number; outputSchema?: boolean }) => {
        if (!p?.name || !p?.task) { return { ok: false, error: "name/task 必填" }; }
        const run = subagents.spawn({ name: p.name, task: p.task, systemPrompt: p.systemPrompt, agentId: p.agentId, model: p.model, timeoutMs: p.timeoutMs, outputSchema: p.outputSchema });
        return { ok: true, run };
      });
      // v2 取消运行中/排队中的子代理
      ipcMain.handle("slime:resident:subagent:cancel", (_e, p: { id?: string }) => ({
        ok: !!p?.id && subagents.cancel(p.id!),
      }));
      // A-980-R31：清空**历史记录**（落盘 + 内存中已终态的痕迹）。
      // 运行中/排队中的**保留**——用户要清的是"跑完的痕迹"，不能顺手把在途任务也干掉。
      // 必须同时 `forgetTerminal()`：只清文件的话，下一次广播的 `syncSubagentRuns(list())`
      // 会发现内存里那些终态记录"不在文件里"，又把它们写回去（清空变僵尸）。
      ipcMain.handle("slime:resident:subagent:clear", () => {
        const cleared = clearSubagentRuns();
        const dropped = subagents.forgetTerminal();
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, cleared, dropped };
      });
      // v2 自动委派：依任务与已注册定义的 description 语义匹配，自动选人派发；无匹配时 delegate 会
      // 自动合成通用子代理兜底（故这里几乎不会失败）。A-980-R30：支持 agent 点名（设置页/外部调用）。
      ipcMain.handle("slime:resident:subagent:delegate", (_e, p: { task?: string; agentId?: string; agent?: string; model?: string }) => {
        if (!p?.task) { return { ok: false, error: "task 必填" }; }
        const overrides: { agentId?: string; agent?: string; model?: string } = {};
        if (p.agentId) { overrides.agentId = p.agentId; }
        if (p.agent) { overrides.agent = p.agent; }
        if (p.model) { overrides.model = p.model; }
        const run = subagents.delegate(p.task, overrides);
        if (!run) { return { ok: false, error: p.agent ? `没有名为「${p.agent}」的子代理` : "无可派发的子代理定义" }; }
        return { ok: true, run };
      });
      // A-942：全局子代理默认模型（贵模型统筹、廉价模型执行档位；持久化 + 即时生效）
      ipcMain.handle("slime:resident:subagent:setDefaultModel", (_e, p: { model?: string }) => {
        const raw = typeof p?.model === "string" ? p.model.trim() : "";
        // A-918++ 兼容用户常见写错：api:<key>.<model>（点号分隔）自动转 api:<key>:<model>（冒号）
        // 原生支持中文 key（之前 [A-Za-z0-9_-]+ 限制让"小红书"等中文供应商名被拒）
        const normalized = raw && raw.startsWith("api:") && !raw.includes(":")
          ? (() => {
              const rest = raw.slice(4);
              const dotIdx = rest.lastIndexOf(".");
              if (dotIdx > 0 && /[A-Za-z0-9_.\-\u4e00-\u9fa5]+$/.test(rest)) {
                return `api:${rest.slice(0, dotIdx)}:${rest.slice(dotIdx + 1)}`;
              }
              return raw;
            })()
          : raw;
        if (!/^(api:[A-Za-z0-9_.\-\u4e00-\u9fa5]+(:[^\s:]+)?|local:[A-Za-z0-9_.\-\u4e00-\u9fa5]+|inherit|)$/.test(normalized)) {
          return {
            ok: false,
            error: `非法模型格式：${raw}\n\n正确格式示例：\n  api:供应商名:模型名（如 api:openai:gpt-5）\n  api:供应商名（用该供应商默认模型）\n  api:小红书:dots3-note-prev（中文 key + 模型名）\n  local:本地模型名\n  inherit（沿用父 Agent 模型）\n  留空（不设置）`,
          };
        }
        subagents.setDefaultModel(normalized);
        saveSubagentDefaultModel(normalized);
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, defaultModel: normalized };
      });
      // A-918+：用户选定子代理（设置→子代理菜单勾选的自建 agent）读写
      ipcMain.handle("slime:resident:subagent:getSelection", () => ({
        ok: true,
        selectedAgentIds: [...subagentSelectedAgentIds],
      }));
      ipcMain.handle("slime:resident:subagent:setSelection", async (_e, p: { selectedAgentIds?: unknown }) => {
        const ids = Array.isArray(p?.selectedAgentIds)
          ? p!.selectedAgentIds.filter((x): x is string => typeof x === "string")
          : [];
        saveSubagentSelection(ids);
        await syncUserSelectedSubagents();
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, selectedAgentIds: [...subagentSelectedAgentIds] };
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
    }).catch((e) => {
      console.warn("[gui:main] 自动拉起 embedding 失败（不阻断，可在状态面板手动重试）:", e);
    });
  });
  console.info("[gui:main] core-ts 服务已加载（ChatService/StatsService + SandboxManager）");
}

// ── 心智中枢：记忆存储 + BGE 嵌入（向量工具开关接线） ───────

/** 嵌入端点端口（S2：端口只有一个真值来源）。
 *
 *  ⚠️ 这里**不许**写死 `8999`。原先 `bgeEmbed` 直连字面量 `http://127.0.0.1:8999`，
 *  绕过了 `basePortFor()` —— 用户一旦在 `slime.toml [model_server.embedding].port` 改了端口，
 *  管理器会在**新**端口起 BGE，而这里仍问**旧**端口 → 嵌入永远失败 → `MemoryStore`
 *  **静默降级成哈希**（用户无感，只是记忆检索质量悄悄变差）。原先"恰好一致"只是配置没改过的巧合。
 *
 *  两级取值，都不新增判据：① 服务已就绪 → 端口由管理器**自述**（唯一真值）；
 *  ② 未就绪 → 用与管理器启动时**同一个** `basePortFor` 按配置推导（不可能漂移）。 */
function embeddingBaseUrl(): string {
  const live = getModelServer()?.getPort("embedding");
  if (live && live > 0) { return `http://127.0.0.1:${live}`; }
  const cfg = readModelServerConfig();
  const port = basePortFor("embedding", cfg.embedding ?? {}, cfg.chat ?? {});
  return `http://127.0.0.1:${port}`;
}

/** BGE-M3 真实嵌入（llama-server `/v1/embeddings`，OpenAI 兼容；失败由 MemoryStore 降级哈希） */
function bgeEmbed(): { embed: (text: string) => Promise<number[]> } {
  return {
    embed: async (text: string): Promise<number[]> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch(`${embeddingBaseUrl()}/v1/embeddings`, {
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

// 记忆自管理注入：把 per-Agent 记忆存储缓存挂到 memory_insert/search/forget 工具
// （对齐 setSubagentManager 模式；工具循环按注入的 _agent_id 定位对应 MemoryStore）。
setMemoryStoreProvider(memoryStoreFor);

/** 审批档位 → SandboxConfig（会话级持久化格式：sandbox_override 存 approval 档位 + workspace）
 *  四档：manual 手动 / auto 自动 / none 无需 / custom 自定义。
 *  旧档位兼容：strict、confirm → manual。 */
const APPROVAL_MODES = ["manual", "auto", "none", "custom"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** A-939 上下文分桶（引擎 done 事件携带，随 slime:chat:done 透传渲染层；各字段为 token 估算） */
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

function buildAgentState(
  name: string,
  role: string,
  parentId: string | null = null,
  toolProfile?: { mode: "default" | "custom"; skills: string[]; mcp: string[] },
): AgentState {
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
    // A-980-R22：工具面白名单（缺省 → 运行时回退内置推荐集）
    ...(toolProfile ? { tool_profile: toolProfile } : {}),
  } as AgentState;
}

/** 边界校验：渲染层传入的 name/role 必须是非空字符串（防误传对象/恶意输入污染 agents.json） */
function assertAgentNameRole(name: unknown, role: unknown): asserts name is string {
  if (typeof name !== "string" || !name.trim() || typeof role !== "string" || !role.trim()) {
    throw new Error("name/role 必须为非空字符串");
  }
}

async function createAgent(
  name: string,
  role: string,
  toolProfile?: { mode: "default" | "custom"; skills: string[]; mcp: string[] },
): Promise<AgentState> {
  assertAgentNameRole(name, role);
  const agents = agentRegistry!.loadedAgents;
  const a = buildAgentState(name.trim(), role.trim(), null, toolProfile);
  agents.push(a);
  await agentRegistry!.save();
  return a;
}

async function forkAgent(parent: AgentState, name: string, role: string): Promise<AgentState> {
  assertAgentNameRole(name, role);
  if ((parent.fork_depth ?? 0) + 1 > 2) {
    throw new Error("分裂深度已达上限（MAX_FORK_DEPTH=2）");
  }
  const child = buildAgentState(name.trim(), role.trim(), parent.id, parent.tool_profile as { mode: "default" | "custom"; skills: string[]; mcp: string[] } | undefined);
  child.model_choice = parent.model_choice;
  child.fork_depth = (parent.fork_depth ?? 0) + 1;
  parent.children.push(child.id);
  const agents = agentRegistry!.loadedAgents;
  agents.push(child);
  await agentRegistry!.save();
  return child;
}

/**
 * 一次流式请求的累积器（正文 / 模型 / 耗时 / timings）。
 *
 * ⚠️ A-1008：`fullReply` **只累积本会话 Agent 自己的正文**（`type === "chunk"`）。
 *
 * 事故：这里原本无条件 `fullReply += chunk.data.content`，把**所有**带 content 的事件都算进去 ——
 * 包括群聊的 `member` 事件（成员发言）。而群聊的 done 事件 `reply` 恒为 `""`（收束由用户），
 * `cleanReply ?? session.fullReply` 于是回退到这个被污染的 `fullReply`，值 = **全体成员发言首尾相接、
 * 不带任何 `【名字】` 归属标记的一大坨**。
 *
 * 渲染层 onDone 见到非空 `reply` 就追加一条 assistant 气泡（没有 agentName/agentId）→ 头部退回
 * **会话归属 Agent** 的名字、也没有「成员」徽标。**这就是用户历时很久的**
 * 「在它们说完话，总是有一个 Agent 出来总结重复一遍所有内容」——它不是引擎多跑了一轮，
 * 而是这条 done 回退污染的假回复。同一根因的另一半（重启后成员气泡全丢）在落库形状，
 * 见 core-ts/src/services/grouptalkTranscript.ts 的文件头。
 *
 * `reasoning` 事件同样不计入（思考不是正文，界面上另有折叠卡）；`member` 事件是**别人的**发言，
 * 更不属于本会话 Agent 的回复。
 */
function createStreamSession() {
  let fullReply = "";
  let model = "";
  let elapsedMs = 0;
  const timings: Record<string, number> = {};
  return {
    pushChunk(chunk: StreamChunk) {
      if (chunk.type === "chunk" && chunk.data.content) { fullReply += chunk.data.content; }
      if (chunk.data.model) { model = chunk.data.model; }
      if (chunk.data.elapsedMs) { elapsedMs = chunk.data.elapsedMs; }
      if (chunk.data.timings) { Object.assign(timings, chunk.data.timings); }
    },
    get fullReply() { return fullReply; },
    get model() { return model; },
    get elapsedMs() { return elapsedMs; },
    get timings() { return timings; },
  };
}

/** A-933 上下文窗口上限（单一事实源，随 done 事件下发，环与右栏共用同一值）。
 *
 *  ── S1 重写（2026-09-19）：从「层层推断」改成「显式覆盖 + **问服务器**」─────────────
 *  原实现是一条 6 级级联：agent.max_context → 本地模型条目 ctx_len → slime.toml chat.ctx_len
 *  → provider 规格 → undefined（然后渲染层再回落家族能力表）。
 *  问题不在某一级写错了，而在**真值来源选错了**：级联里没有任何一级知道
 *  "llama-server 这次到底分配了多少 KV"。家族能力表写的是模型**训练时**的窗口
 *  （qwen3 = 524K），而服务实际按 `-c 8192` 分配 —— 于是界面显示"还剩 480K"，
 *  请求却被上游 400 顶回：`exceeds the available context size (8192 tokens)`（A-1018 ③）。
 *
 *  现在的优先级（决策函数唯一出处：`core-ts/src/model_introspect.ts` 的 resolveWindowCap）：
 *    ① `agent.max_context`            —— 用户显式配置，最高优先（允许故意设小）
 *    ② **问本机服务器**（`/props.n_ctx`）—— 权威。覆盖"配置里写的"和"文件里推的"
 *    ③ `slime.toml` 的 ctx_len        —— **同域**兜底：它就是启动时下发的 `-c`，仅服务器问不到时用
 *    ④ provider 规格 `context_window` —— 远端模型
 *  任何一步都不再回落到家族能力表。
 *
 *  ⚠️ 两类"本地模型"都要覆盖（配置里看不出区别）：
 *    (a) slime 托管的 llama-server —— 端口从 ModelServerManager 拿，并**校验在服务的模型身份**
 *        （一次只服务一个模型；拿 A 的窗口回答 B 就是换个位置重演同一个 bug）；
 *    (b) 指向本机的普通 provider（如 `api_base = http://127.0.0.1:8800/v1`）—— 用户自己拉的进程，
 *        slime 的启动记录里没有它，唯一判据就是发请求。
 *  详见 `gui/src/main/localServerProbe.ts`。
 *
 *  解析失败仍返回 undefined（渲染层有自己的兜底路径，不阻断 done 下发）。 */
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

    const localSpec = listLocalModels().find(
      // label 可选（历史条目可能没有）→ 显式判非空再比对，别把 undefined 塞进 includes
      (m) => candidates.includes(m.id) || (typeof m.label === "string" && candidates.includes(m.label)),
    );
    let serverCtx: number | undefined;
    let plannedCtx: number | undefined;

    /* ②a slime 托管的本地模型 —— 问服务器，并确认它服务的就是这个模型 */
    if (localSpec || modelId.startsWith("local:")) {
      const cap = await probeManagedChatCapability({ path: localSpec?.path, ids: candidates }).catch(() => null);
      if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { path: localSpec?.path, ids: candidates })) {
        serverCtx = cap.effectiveCtx;
      }
      /* ③ 同域兜底：`-c` 的真实取值 =
         模型条目自己的 ctx_len（ModelServerManager.ensure 的 opts.ctxLen 优先级更高）
         ?? slime.toml chat.ctx_len。这两者是**同一个值**的输入侧，不是另一份真相。 */
      const chatCfgCtx = Number((readModelServerConfig()?.chat as { ctx_len?: number } | undefined)?.ctx_len ?? 0);
      plannedCtx = localSpec?.ctx_len && localSpec.ctx_len > 0
        ? localSpec.ctx_len
        : (chatCfgCtx > 0 ? chatCfgCtx : undefined);
      logLocalCapGap(cap?.state ?? "down", serverCtx);
    }

    /* ②b 指向本机的普通 provider（用户自己拉起的 llama-server）—— 同样问服务器 */
    if (serverCtx === undefined) {
      for (const p of listProviders()) {
        const base = typeof p.api_base === "string" ? p.api_base : "";
        if (!isLoopbackBaseUrl(base)) { continue; }
        const owns = (p.models ?? []).some((m) => candidates.includes(m.id))
          || (typeof p.model === "string" && candidates.includes(p.model));
        if (!owns) { continue; }
        const cap = await getLocalCapability(base).catch(() => null);
        /* 这个 baseUrl 就是该模型的地址 —— provider 配置本身即身份证据（trustedEndpoint）。 */
        if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { trustedEndpoint: true })) {
          serverCtx = cap.effectiveCtx;
          break;
        }
      }
    }

    /* ④ 远端 provider 的模型规格 */
    let providerCtx: number | undefined;
    for (const id of candidates) {
      for (const p of listProviders()) {
        const m = (p.models ?? []).find((x) => x.id === id);
        if (m?.context_window && m.context_window > 0) { providerCtx = m.context_window; break; }
      }
      if (providerCtx !== undefined) { break; }
    }

    return resolveWindowCap({ serverCtx, plannedCtx, providerSpecCtx: providerCtx }).ctx;
  } catch { /* ignore */ }
  return undefined;
}

/** 本地服务"问不到窗口"时的状态迁移日志（**去重**：只在状态变化时打一次）。
 *
 *  它是"就绪但拿不到 n_ctx"这个**回归信号**的唯一读取者 —— 没有它，llama.cpp 改字段名后
 *  界面只会静默地退回兜底值，我们看不到任何异常。
 *  S4 会把 `state` 提升成下发字段（那时这里降级为纯日志）。 */
let lastLocalCapWarn: string | null = null;
function logLocalCapGap(state: string, serverCtx: number | undefined): void {
  const key = `${state}|${serverCtx ?? "-"}`;
  if (key === lastLocalCapWarn) { return; }
  lastLocalCapWarn = key;
  if (state === "ready" && serverCtx === undefined) {
    console.warn(
      "[gui:cap] 本地服务已就绪但解析不出 n_ctx —— 端点半结构可能变了；" +
      "已回落到 slime.toml 的 ctx_len。请检查 /props.default_generation_settings.n_ctx " +
      "与 /v1/models.data[].meta.n_ctx 的字段名（见 core-ts/src/model_introspect.ts 的文件头实测记录）。",
    );
  } else if (state === "loading") {
    console.info("[gui:cap] 本地模型加载中（/props 503 unavailable_error），窗口上限本次取兜底值");
  }
}

/** A-980-R26：通知标题用的 Agent 显示名（查不到就回落到 Agent id / 通用文案，绝不抛） */
function agentNameForNotify(agentId: string | undefined): string {
  try {
    if (agentId && agentRegistry) {
      const a = agentRegistry.loadedAgents.find((x) => x.id === agentId || x.name === agentId);
      if (a?.name) { return a.name; }
    }
  } catch { /* ignore */ }
  return agentId || "Agent";
}

/** A-980-R24：为一条流创建「chunk 发送合批器」。
 *
 *  上游每吐一个 token 就回调一次 → 此前主进程**逐条** `webContents.send("slime:chat:chunk")`，
 *  高速率模型下变成每秒数百条 IPC。Electron 的 send 没有背压，渲染进程（同时还在跑 Markdown
 *  全量重解析）一旦跟不上，消息队列只增不减 → 渲染进程 OOM（`data/logs/renderer-crash.log`
 *  已记录过 `oom`，用户侧表现就是"用着用着 slime 直接崩了、任务中断"）。
 *
 *  这里把「同一条流 + 同类型」的纯文本增量按 40ms 窗口合并成一条再发（≈25 帧/秒，观感无损），
 *  IPC 消息数下降 1~2 个数量级。**只动发送侧**：`session.pushChunk()` 仍按原始 chunk 记录，
 *  断线重放与轨迹数据不受影响。详见 `gui/src/main/streamBatch.ts`。
 *
 *  ⚠️ `done` / `error` 之前必须 `flush()`，否则最后一段正文会晚于 done 到达（尾部丢字）。 */
function createChunkSender(): StreamChunkBatcher {
  return new StreamChunkBatcher((chunk) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("slime:chat:chunk", chunk);
    }
  });
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
  // 缓存写入 token（prompt caching 的 cache_creation；可选透传，供用量分析展示）
  if (typeof mergedTimings.cacheCreationTokens !== "number") {
    if (typeof (d as any).cache_creation_tokens === "number") {
      mergedTimings.cacheCreationTokens = (d as any).cache_creation_tokens;
    } else if (typeof (d as any).cacheCreationTokens === "number") {
      mergedTimings.cacheCreationTokens = (d as any).cacheCreationTokens;
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
  // A-974-R7：窗口占用口径（「最近一轮」输入侧 token；仅工具循环路径下发）——
  // 工具循环每轮全量重发历史，外层 prompt_tokens 是跨轮累计（计费口径）；
  // 直接拿它当窗口占用会 N 轮叠加 → GUI 上下文环/右栏爆表（用户实测正文输出后爆到 1.1M）。
  {
    const wpt = (d as any).window_prompt_tokens ?? (d as any).windowPromptTokens;
    const wcr = (d as any).window_cache_read_tokens ?? (d as any).windowCacheReadTokens;
    if (typeof wpt === "number") { mergedTimings.windowPromptTokens = wpt; }
    if (typeof wcr === "number") { mergedTimings.windowCacheReadTokens = wcr; }
  }
  // A-974-R8：协议语义标记（OpenAI 兼容=true=prompt 已含缓存命中 / Anthropic=false）——
  // 渲染层窗口占用公式据此决定是否 +cacheRead，避免 OpenAI 兼容系重复计缓存导致窗口虚高。
  // timings 为 number 表，布尔编码为 1/0，渲染层按 `=== 1` 判定。
  {
    const cri = (d as any).cache_read_in_prompt ?? (d as any).cacheReadInPrompt;
    if (typeof cri === "boolean") { mergedTimings.cacheReadInPrompt = cri ? 1 : 0; }
  }
  return {
    seq: ev.seq,
    type: ev.type as StreamChunk["type"],
    data: {
      content: typeof d.content === "string" ? d.content : undefined,
      name: typeof d.name === "string" ? d.name : undefined,
      /** A-957：member 事件归属 Agent id 必须透传——此前被白名单滤掉 → 群聊成员消息 agentId=undefined → 多人发言全被并进第一条（名字全显第一个成员） */
      agentId: typeof d.agentId === "string" ? d.agentId : undefined,
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

/* A-1017：`isLocalModelReady(agent)` 已删除。
 * 它做的事是"调用方自己再查一次就绪没有"——先另读一份 providers 表拿到 spec.path，再拿路径去
 * `mgr.isChatReady(path)` 做**裸字符串比较**；只要这个路径与"管理器里实际加载的 model_path"有出入
 * （引擎用的是它构造时的 providers 快照，本文件读的是实时盘上文件），就**永久判否** →
 * 模型已就绪却每轮对话都弹全屏「正在加载本地模型」。判据不该由调用方重新推导，它只有一个真值来源：
 * ModelServerManager 自己的实例状态。现在由管理器的状态广播驱动面板（见 initModelServerManager）。 */

/** A-980-R24：窗口启动尺寸**固定按屏幕工作区比例**（不再沿用上次退出尺寸）。
 *
 *  用户实测诉状：每次重启都恢复上次拖过的大小 → 同一程序在不同时候"长相不一"，且拖小过之后
 *  再启动就是个小窗。现在：每次启动都用主屏工作区比例算出尺寸并**居中**，只有位置可选记忆。
 *  比例取自用户给定的目标版式截图实测：窗口占工作区宽 77.8%、高 89.9%。
 *  （另一个附带好处：窗口渲染尺寸稳定 → 首帧布局/动画节拍也稳定，不再随上次窗口大小漂移。） */
interface WindowState { width: number; height: number; x?: number; y?: number; }
const WIN_STATE_PATH = resolveExtra("../config/winstate.json");
/** 窗口最小尺寸 —— **由布局自身的硬下限推导，不是拍脑袋定的**（A-1018）。
 *
 *  三栏（都展开时）各自的"再也不能小"的宽度：
 *    · 左栏 `.sidebar`      min-width 240px（= App 的 SIDEBAR_MIN_W）
 *    · 聊天主区 `.main`     min-width 380px（= App 的 CHAT_MIN_W，保底可读）
 *    · 右栏 `.right-sidebar` min-width 260px
 *  合计 880px。窗口再窄时：右栏 wrapper 会被 flex 压缩，而内层 `.right-sidebar` 的
 *  min-width 260 顶着不让，于是它**超出 wrapper 并被 `overflow:hidden` 裁掉** ——
 *  右栏**右上角的展开/折叠按钮正好被裁到视野外**（用户原话："右侧边栏的展开折叠按钮消失，
 *  同时聊天栏目的内容跑到屏幕外"）。所以最小宽度必须 ≥ 三栏下限之和。
 *  880 + 边框/滚动条余量 → **900**。
 *
 *  ⚠️ 改这三个 min-width 中任意一个，这里必须同步重算（否则又会挤出上面那两个症状）。
 *     高度 560 保持原值：纵向没有这类"三栏并列"的硬约束。 */
const WIN_MIN = { width: 900, height: 560 };

/* ── 主题持久化（A-1019）────────────────────────────────────────────────────────
 * 为什么主进程要自己存一份主题：
 *   渲染层的主题存在 localStorage 里，**主进程读不到**；而 `titleBarOverlay.color`
 *   必须在**创建窗口时**就已经正确，否则会先显示一帧错误配色 —— alpha 主题下
 *   那三个系统按钮（最小化/还原/关闭）背后会闪一块比标题栏更深的色块
 *   （用户原话：「这三个按钮有个明显的色块背景，给我去了」）。
 *   A-1018 只修了「切换主题」这条路径，启动路径仍是写死 beta 色 → 残留。
 *   现在：窗口创建时读本文件；渲染层挂载后调 `slime:theme:set` 会把它写回来。
 * 文件位置沿用既有约定（每个功能一个 config/*.json：notifications / winstate / mind …）。 */
const THEME_CFG_PATH = join(PROJECT_ROOT, "config", "theme.json");

/** 读取持久化主题；缺省 = beta（与渲染层 theme.ts 的 getTheme() 默认值保持一致） */
function readPersistedTheme(): "alpha" | "beta" {
  try {
    const p = JSON.parse(readFileSync(THEME_CFG_PATH, "utf8")) as { theme?: string };
    return p.theme === "alpha" ? "alpha" : "beta";
  } catch {
    return "beta";
  }
}

function writePersistedTheme(theme: string): void {
  try {
    mkdirSync(join(PROJECT_ROOT, "config"), { recursive: true });
    writeFileSync(THEME_CFG_PATH, JSON.stringify({ theme: theme === "alpha" ? "alpha" : "beta" }, null, 2), "utf8");
  } catch (e) {
    /* 持久化失败不影响本次运行，只是下次启动 overlay 初值可能不对 */
    console.warn("[gui:main] 写入主题配置失败:", e instanceof Error ? e.message : String(e));
  }
}

/** 标题栏系统按钮 overlay 配色：`color` 必须等于标题栏的**实际合成色**，否则按钮后面就是一块色块。
 *  · alpha：`.titlebar { background: var(--bg-secondary) }` = `#1e293b`（不透明）
 *  · beta ：`--bg-secondary: rgba(15,22,40,.6)` 叠在 `--bg: #05070e` 上
 *           = 0.6×(15,22,40) + 0.4×(5,7,14) = (11,16,30) = `#0b101e`
 *  改主题配色时（--bg-secondary / --bg 一动）这里必须同步重算。 */
function titleBarColors(theme: string): { color: string; symbolColor: string } {
  return theme === "alpha"
    ? { color: "#1e293b", symbolColor: "#e2e8f0" }
    : { color: "#0b101e", symbolColor: "#e6f1ff" };
}
/** 默认尺寸比例（× 主屏工作区宽/高，用户指定版式） */
const WIN_DEFAULT_RATIO = { width: 0.78, height: 0.90 };
/** 默认尺寸下限（首启/超小屏时保证可用工作面的最小逻辑窗口） */
const WIN_DEFAULT_FLOOR = { width: 1040, height: 700 };

function defaultWindowState(): WindowState {
  const wa = screen.getPrimaryDisplay().workArea;
  const wantW = Math.round(wa.width * WIN_DEFAULT_RATIO.width);
  const wantH = Math.round(wa.height * WIN_DEFAULT_RATIO.height);
  // 下限保证小屏不缩得过小，上限受工作区与全局极值双重约束，杜绝越界
  const w = Math.max(WIN_MIN.width, Math.min(Math.max(wantW, WIN_DEFAULT_FLOOR.width), wa.width, 2560));
  const h = Math.max(WIN_MIN.height, Math.min(Math.max(wantH, WIN_DEFAULT_FLOOR.height), wa.height, 1600));
  return { width: w, height: h };
}

/** A-980-R24：只读回**位置**（尺寸一律由上方的 defaultWindowState 按比例重算），
 *  并按新尺寸重新钳制进工作区——否则"旧坐标 + 新尺寸"会让窗口探出屏幕外。 */
function loadWindowPos(size: { width: number; height: number }): { x?: number; y?: number } {
  try {
    const s = JSON.parse(readFileSync(WIN_STATE_PATH, "utf8")) as Partial<WindowState>;
    if (typeof s.x !== "number" || typeof s.y !== "number") { return {}; }
    const wa = screen.getPrimaryDisplay().workArea;
    const x = Math.round(s.x), y = Math.round(s.y);
    if (x + 200 > wa.x + wa.width || y + 120 > wa.y + wa.height || x < wa.x - 400 || y < wa.y - 400) {
      return {}; // 位置越界（换显示器/分辨率变了）→ 不给坐标，走默认居中
    }
    return {
      x: Math.max(wa.x, Math.min(x, wa.x + wa.width - size.width)),
      y: Math.max(wa.y, Math.min(y, wa.y + wa.height - size.height)),
    };
  } catch {
    return {};
  }
}

function persistWindowState(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) { return; }
  try {
    // A-980-R24：只存位置（尺寸下次启动一律按比例重算，不存也不读）
    const [x, y] = win.getPosition();
    writeFileSync(WIN_STATE_PATH, JSON.stringify({ x, y }), "utf8");
  } catch { /* 首次无目录时忽略（下次写） */ }
}
let winStateTimer: NodeJS.Timeout | null = null;
function schedulePersistWindowState(): void {
  if (winStateTimer) { clearTimeout(winStateTimer); }
  winStateTimer = setTimeout(() => { winStateTimer = null; persistWindowState(); }, 400);
}

function createWindow(): void {
  // A-980-R26：通知模块注入主窗口获取器 + 设置 Windows AppUserModelID（通知归属，须早于任何弹窗）
  initNotify({ getWindow: () => mainWindow });
  // A-980-R24：每次启动都按屏幕比例定尺寸 + 居中（位置可选记忆，见 loadWindowPos）
  const st = defaultWindowState();
  const pos = loadWindowPos(st);
  mainWindow = new BrowserWindow({
    width: st.width, height: st.height, x: pos.x, y: pos.y,
    minWidth: WIN_MIN.width, minHeight: WIN_MIN.height, show: false,
    icon: join(INSTALL_ROOT, "build", "icon.png"),
    // Campanula 式自绘标题栏：隐藏系统标题栏，Windows overlay 渲染窗口按钮
    titleBarStyle: "hidden",
    // A-1018/A-1019：初值必须等于**当前持久化主题**的标题栏合成色，否则启动瞬间那三个
    // 系统按钮背后会闪一块比标题栏更亮或更暗的色块。此处读 config/theme.json（见 titleBarColors）。
    titleBarOverlay: { ...titleBarColors(readPersistedTheme()), height: 40 },
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
  // A-980-R23：拖动/缩放/关闭时持久化窗口状态（下一启动恢复同尺寸同位置）
  mainWindow.on("resize", () => schedulePersistWindowState());
  mainWindow.on("move", () => schedulePersistWindowState());
  mainWindow.on("close", () => persistWindowState());
  // GPU 崩溃保护：ready-to-show 未触发时（如 GPU exit_code=-1），兜底主动 show
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 3000);
  // A-975：渲染进程崩溃自愈（DeepSeek 长时间生成实测白屏 + 终端无限 error 的根因一半在此）——
  // 渲染进程一旦崩溃（OOM/长任务/未知），主进程仍在持续 send → 每条对已销毁 webContents 报错 → "无限 error"；
  // 窗口则停在纯白。此处：崩溃原因落盘 + 自动 reload 恢复（在途流现场由 per-session 快照/后台镜像兜底）。
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    try {
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "renderer-crash.log"), `${new Date().toISOString()}\t${details.reason} (exit=${details.exitCode})\n`, { flag: "a" });
      console.error("[gui:main] 渲染进程已崩溃，原因:", details.reason, "(将自动重载恢复)");
    } catch { /* ignore */ }
    // A-980-R26：意外终止 → 系统通知（用户可能正在别的窗口，页面白屏他看不到）
    notifyUser({
      kind: "aborted",
      title: "slime 意外终止",
      body: `界面进程异常退出（${details.reason}），已自动重载恢复；进行中的生成可能已中断。`,
    });
    try { mainWindow?.webContents.reload(); } catch { /* ignore */ }
  });
  // 渲染进程无响应（主线程死循环/巨大长任务）→ 记录后尝试重载恢复
  mainWindow.webContents.on("unresponsive", () => {
    try {
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "renderer-unresponsive.log"), `${new Date().toISOString()}\n`, { flag: "a" });
    } catch { /* ignore */ }
    // A-980-R26：界面卡死（主线程死循环/巨长任务）也属"意外终止"体验——通知提醒用户
    notifyUser({
      kind: "aborted",
      title: "slime 界面无响应",
      body: "界面进程长时间未响应，可能正在执行超长任务；若无恢复请重启应用。",
    });
  });
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

  /** 会话上下文加载（注入聊天请求；会话隔离，旧记录归首个会话）。
   *  A-969：会话存在压缩摘要时，旧轮替换为「摘要头 + 最近 K 轮」——早期内容不再全量重发，真正降低发送量 */
  async function loadSessionHistory(sessionId: string | undefined): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    if (!sessionId) { return []; }
    try {
      const meta = await getSession(sessionId);
      if (!meta) { return []; }
      const agentSessions = (await listSessions()).filter((m) => m.agentId === meta.agentId);
      const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
      const records = await loadHistoryForSession(meta.agentId, meta.id, 50, firstSession);
      const lines = records.flatMap((r) => [
        { role: "user" as const, content: r.user },
        { role: "assistant" as const, content: r.ai },
      ]);
      if (meta.contextSummary && lines.length > 4) {
        const tail = lines.slice(-(meta.summaryCount ?? 12));
        const dropped = lines.length - tail.length;
        if (dropped > 0) {
          // A-969：摘要头紧随一条 assistant 垫脚——保证绝对 user→assistant 交替
          // （Anthropic 系 API 拒绝连续同角色消息；历史上最早轮次也是 user，两者必须隔开）
          return [
            { role: "user" as const, content: `【历史上下文压缩摘要】（早期 ${dropped} 轮对话已压缩为要点，仅作延续上下文）\n${meta.contextSummary}` },
            { role: "assistant" as const, content: "（已收录以上摘要，在此进展基础上继续当前任务）" },
            ...tail,
          ];
        }
      }
      return lines;
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
    // A-1017：「正在加载本地模型」面板**不再在这里预判**。
    // 此前是 `needLoadingPanel = isLocalModel && !isLocalModelReady(agent)` —— 判断依据由调用方
    // 自己重新推导（另读一份 providers 表 + 裸字符串比路径），与"管理器里实际加载了哪个模型"
    // 一旦有出入就**永久判否**：模型明明已就绪，每轮对话仍弹一次全屏加载面板（用户报的"每次都加载"）。
    // 现在唯一真值来源 = ModelServerManager 的状态广播（见 initModelServerManager 的 onChatState）：
    // 真的开始加载才弹、就绪/失败/取消即关。这里只登记取消键，供面板上的「取消加载」按钮使用。
    const loadingAgent = await agentRegistry!.findAgent(agentId).catch(() => undefined);
    const cancelKey = input.sessionId ?? agentId;
    const controller = new AbortController();
    activeChats.set(cancelKey, controller);
    agentStreamSessionMap.set(input.agentId, cancelKey); // 授权/提问请求按当前流打会话标签
    lastChatCancelKey = cancelKey;
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
      // A-966 修复：此前 images 未透传——粘贴/拖拽图片在 GUI 端可见、但引擎从未收到（模型回"没看到图片"）
      images: input.images,
      resumeHint: (input as { resumeHint?: string }).resumeHint,
    };
    const session = createStreamSession();
    // A-980-R24：chunk 下发合批（见 createChunkSender 注释）
    const chunkSender = createChunkSender();
    // 干净正文：优先取 chatService done 事件里全量 extractThinkingFromReply 清洗后的 reply
    // （流式逐 chunk 剥离对细粒度 chunk 可能漏掉裸思考，累积的 fullReply 不代表最终正文）
    let cleanReply: string | undefined;
    // A-939 上下文分桶（随 done 事件透传给渲染层分桶托盘）
    let ctxBuckets: CtxBuckets | undefined;
    // D: 本次请求链路 trace 记录（事件点 → spans；收尾广播 TraceViewer）
    const recorder = new TraceRecorder(cancelKey);
    // E: 工具轮 Plan 拦截（plan_create/plan_update/todo_write → planStore → 广播）
    const planSessionId = cancelKey;
    // A-943：群聊头脑风暴分支（会话 type=brainstorm 且已选成员）——发议题 → 全员并行发言 → 组长收束
    const brainMeta = input.sessionId && typeof input.sessionId === "string" ? await getSession(input.sessionId).catch(() => null) : null;
    const isBrainstorm = brainMeta?.type === "brainstorm" && memberIdsOf(brainMeta.members).length > 0;
    void (async () => {
      try {
        const evSource = isBrainstorm
          ? streamGroupTalkFlow({
              engine: engine!, // 本 handler 顶部已 await ensureServices()，引擎必就绪
              // 群聊 = 会话归属 Agent + 全部成员（无组长 Agent，组长即用户）；@ 路由在 flow 内解析
              // A-954：成员入群时指定了模型 → 覆盖 model_choice；池 cap 按所选模型 context_window（agent.max_context 不优先）
              members: await (async () => {
                const modelMap = memberModelsOf(brainMeta!.members);
                const modelEntries: Array<[string, string]> = [...Object.entries(modelMap)];
                if (typeof brainMeta!.leaderModel === "string" && brainMeta!.leaderModel) { modelEntries.push([loadingAgent!.id, brainMeta!.leaderModel]); }
                const modelCaps = await Promise.all(modelEntries.map(async ([id, model]) => [id, await resolveSessionWindowCap("", model)] as const));
                const capBy = new Map(modelCaps);
                // A-1012：参与名单（**组长 + 成员、按 id 去重、取前 GROUP_MAX_PARTICIPANTS 位**）由共享纯函数
                // 唯一决定 —— 建群弹窗用同一个函数拦人，两头不可能再漂移。
                // ⚠️ 此前这里是内联 `.slice(0, 5)` 字面量，而界面毫不知情 → 用户能邀请 7 个 Agent，
                //    第 6 位起卡片照常显示、照样可点「思考·X」，引擎却从不读（静默丢弃 = 假旋钮）。
                // 截断仍保留作兜底：上限引入之前建的旧会话、以及脏数据仍可能超员。
                const participantIds = groupParticipantIds(loadingAgent?.id, memberIdsOf(brainMeta!.members));
                // 组长**无条件在场**（他是会话归属 Agent，原来就不经 findAgent 过滤，这里保持原语义）；
                // 其余按名单顺序解析，解析不到的（Agent 已被删除）直接跳过而**不拉后续成员补位** ——
                // 否则"界面按名单算出的参会者"与"引擎实际参会者"会错位，界面就会标错人。
                const otherMembers = await Promise.all(
                  participantIds
                    .filter((id) => id !== loadingAgent?.id)
                    .map((id) => agentRegistry!.findAgent(id).catch(() => null)),
                );
                const roster: AgentState[] = [
                  ...(loadingAgent ? [loadingAgent] : []),
                  ...otherMembers.filter((a): a is AgentState => a !== null),
                ];
                const effortMap = memberEffortsOf(brainMeta!.members);
                return roster.map((a) => {
                  const model = a.id === loadingAgent!.id ? brainMeta!.leaderModel : modelMap[a.id];
                  // A-1011：必须总是显式赋 reasoning_effort（缺省 "high"），否则会回落该 Agent 的全局设置（行为回归）
                  const effort = a.id === loadingAgent!.id ? brainMeta!.leaderEffort : effortMap[a.id];
                  const cap = capBy.get(a.id);
                  return { ...a, ...(model ? { model_choice: model } : {}), ...(cap && cap > 0 ? { max_context: cap } : {}), reasoning_effort: effort || "high" };
                });
              })(),
              topic: req.message,
              sessionId: input.sessionId,
              networkEnabled: input.networkEnabled,
            })
          : chatService!.stream(agentId, req, input.resumeSeq ?? 0, controller.signal);
        for await (const ev of evSource) {
          recorder.push(ev);
          // A-984：给看门狗留现场 —— 卡顿时能直接看出"当时在跑哪个工具"
          if (ev.type === "tool") {
            const t = (ev.data ?? {}) as Record<string, unknown>;
            markMainActivity(`tool ${String(t.name ?? "?")}`);
          }
          if (planSessionId) { interceptPlanTool(ev, planSessionId); }
          if (ev.type === "done") {
            const d = (ev.data ?? {}) as Record<string, unknown>;
            if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            // A-939 上下文分桶透传（渲染层分桶托盘显示；引擎 done 事件携带各来源 token 估算）
            if (d && typeof d === "object" && "ctxBuckets" in d) { ctxBuckets = d.ctxBuckets as CtxBuckets; }
          }
          const chunk = toStreamChunk(ev, cancelKey);
          session.pushChunk(chunk);
          // A-980-R24：原始 chunk 已逐条进 session 缓冲（重放/轨迹完整），IPC 侧走合批
          chunkSender.push(chunk);
        }
        if (input.sessionId) {
          await touchSessionWithMessage(input.sessionId, input.message).catch(() => undefined);
        }
        try {
          // A-980-R24：**done 之前必须 flush**，否则尾部正文会晚于 done 到达（末尾丢字）
          chunkSender.flush();
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("slime:chat:done", {
              reply: cleanReply ?? session.fullReply, model: session.model,
              elapsedMs: session.elapsedMs, timings: session.timings,
              interrupted: controller.signal.aborted,
              sessionId: cancelKey,
              // A-933：权威窗口上限（Agent.max_context 或本次模型 context_window）——右栏进度条/圆环/
              // 压缩阈值三者同源。⚠️ 此前**只**在 retry 路径下发，正常发送的 done 里没有 →
              // 渲染层只能退回本地预设（曾把 512K 模型显示成 128K），且压缩阈值判定跟着错。
              windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
              ctxBuckets,
            });
            // A-918：流终态广播——渲染层据此把 per-session 快照 hasActive 校准为 false，
            // 根治「切走再切回仍显示生成中/仍重连」的假活跃状态
            mainWindow.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
            // A-980-R26：任务完成 → 系统通知。**用户主动中断（aborted）不通知**——
            // 那是用户自己按的停止，再弹一条"完成"只会打扰。
            if (!controller.signal.aborted) {
              notifyUser({
                kind: "done",
                title: `${agentNameForNotify(agentId)} 已完成`,
                body: (cleanReply ?? session.fullReply ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || "任务已结束",
              });
            }
          }
        } catch { /* ignore */ }
        // D：收敛 trace 并广播（成功）
        const traced = recorder.finish(true);
        traceStoreSet(cancelKey, traced);
        try {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: traced });
          }
        } catch { /* ignore */ }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[gui:main] chat stream error:", msg);
        // A-980-R24：错误前把已生成的待发文本放出去（用户应看到中断前已产出的内容）
        chunkSender.flush();
        // A-918++：中断类错误落盘（data/logs/chat-errors.log），便于事后归因"刚要开始就中断"
        try {
          const logDir = resolveExtra("../data/logs");
          mkdirSync(logDir, { recursive: true });
          writeFileSync(join(logDir, "chat-errors.log"), `${new Date().toISOString()}\t${cancelKey}\t${msg}\n`, { flag: "a" });
        } catch { /* 落盘失败不影响主流程 */ }
        mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: cancelKey });
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
        // A-980-R26：出错 → 系统通知（用户常在生成中切走做别的事，回来才发现整轮标红）
        notifyUser({
          kind: "error",
          title: `${agentNameForNotify(input.agentId)} 出错`,
          body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "生成过程中发生错误",
        });
        // D：失败轨迹也收敛广播（TraceViewer 见失败归因 eval=false + 错误摘要）
        const failedTrace = recorder.finish(false, msg);
        traceStoreSet(cancelKey, failedTrace);
        mainWindow?.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: failedTrace });
      } finally {
        // A-980-R24：合批器收尾（flush 幂等；此后新帧一律丢弃，避免流结束后仍向渲染层发僵尸帧）
        chunkSender.dispose();
        activeChats.delete(cancelKey);
        // 会话标签竞态防护（A-151）：仅当映射中的值仍是本流注册的 cancelKey 时才删除——
        // 同 Agent 多会话并发时，本流 finally 可能晚于「新会话流已 set」执行，
        // 无条件 delete 会把新流的会话标签一并删掉 → 新流 perm/ask 请求丢 sessionId
        // → 渲染层无条件弹选择题替换输入框（切会话后输入框卡死的根因链）。
        if (agentStreamSessionMap.get(input.agentId) === cancelKey) {
          agentStreamSessionMap.delete(input.agentId);
        }
        // A-1017：面板显隐由管理器状态广播驱动，这里是**兜底**——取消发生在 ensure 之前时
        // 不会产生任何状态迁移，广播也就不来，必须在流结束时无条件收口（渲染层置 false 是幂等的）。
        mainWindow?.webContents.send("slime:model:loading", { loading: false });
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
      // A-980-R26：发送阶段就失败（服务未就绪 / Agent 解析失败）同样通知
      notifyUser({
        kind: "error",
        title: "请求未能开始",
        body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "发送阶段发生错误",
      });
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
    // A-985：用户主动中断 = 没人在干活了 → 把该会话停在"进行中"的项降级为待办。
    // 否则中断后那一项会一直转圈高亮，看起来像"任务还在跑"（与强杀重启后的僵尸态同一个坑）。
    try {
      const key = payload.key ?? "";
      if (key && demoteStaleInProgress(key) > 0) { broadcastTodos(key); }
    } catch { /* 收敛失败不影响中断本身 */ }
    return { ok: true, active: activeChats.size };
  });

  /** A-973：查询指定会话是否仍有进行中的流（渲染层恢复会话时判定"进行中/已结算"的唯一真相源）。
   *  activeChats 的 key 与流归属同口径（sessionId ?? agentId）：先按传入 key 精确查，未命中再
   *  遍历值匹配 agentStreamSessionMap 兜底——主进程 activeChats 才有资格回答"这条流死没死"，
   *  杜绝渲染层靠 6s 超时猜测导致"恢复中"冻结/误判整条重发。 */
  handleTrusted<{ key?: string }>("slime:chat:isActive", async (_event, payload): Promise<{ active: boolean }> => {
    const key = payload.key ?? "";
    // 流归属口径：activeChats 的 cancelKey = sessionId ?? agentId。渲染层恢复时传的 key 可能是
    // 当前 sessionId 或 agentId，故遍历比对（精确匹配或经 agentStreamSessionMap 反查）。
    if (activeChats.has(key)) { return { active: true }; }
    for (const mapKey of activeChats.keys()) {
      if (mapKey === key) { return { active: true }; }
    }
    for (const [, boundKey] of agentStreamSessionMap) {
      if (boundKey === key) { return { active: true }; }
    }
    return { active: false };
  });

  /** A-969 上下文自动压缩：把指定会话历史压缩为摘要并写回会话 meta（后续 loadSessionHistory 自动注入摘要头 +
   *  最近 K 轮，不再全量重发）。摘要轮失败/无模型时降级硬裁剪——绝不阻塞对话。GUI 发送前触发并展示过渡动画。 */
  handleTrusted<{ sessionId?: string; ratio?: number; used?: number }>("slime:chat:compress", async (_event, p): Promise<CompressResult> => {
    try {
      const sessionId = (p?.sessionId ?? "").trim();
      if (!sessionId) { return { ok: false, error: "缺少会话 ID" }; }
      const meta = await getSession(sessionId);
      if (!meta) { return { ok: false, error: "会话不存在" }; }
      const agent = await agentRegistry!.findAgent(meta.agentId).catch(() => null);
      const capRaw = await resolveSessionWindowCap(meta.agentId, agent?.model_choice ?? "").catch(() => undefined);
      const cap = capRaw ?? (agent?.max_context ?? 0);
      const history = await loadSessionHistory(sessionId);
      if (history.length < 6) { return { ok: true, skipped: true, used: 0, cap }; }
      // A-974-R3：占用口径取「历史轮次估算」与「渲染层实测输入侧占用」的**较大值**。
      // 实测值 = 上游 prompt_tokens + cache_read（含系统提示/记忆/技能/工具定义/工作区注入），
      // 比只看可见轮次的估算更贴近真实窗口压力；此前只用估算 → 实测已超阈值却判 skipped，
      // 压缩永不执行（用户实测"逼近硬阈值却毫无动作/压缩失效"的根因）。
      const histUsed = estimateHistoryTokens(history);
      const hint = typeof p?.used === "number" && Number.isFinite(p.used) && p.used > 0 ? Math.round(p.used) : 0;
      const used = Math.max(histUsed, hint);
      // A-974-R3 护栏：由「实测占用（hint）抬高」触发的场景，必须确有**多余轮次可裁**才动手——
      // 压缩后 loadSessionHistory 只剩「摘要头 + 最近 K 轮」（长度回落到 ~K+2），若固定开销
      // （系统提示/记忆/技能/工具定义/工作区注入）本身就逼近上限，裁历史降不下来 →
      // 每轮都会空跑一次摘要模型调用并刷一条「已压缩上下文」。此处显式拦掉这种空转。
      // 注意：histUsed 自身超阈值的既有路径不受影响（保持原语义，无回归）。
      if (used > histUsed && history.length <= DEFAULT_TAIL_KEEP + 2) {
        return { ok: true, skipped: true, used, cap };
      }
      const ratio = typeof p?.ratio === "number" && p.ratio > 0 ? p.ratio : DEFAULT_COMPRESS_RATIO;
      if (!needsCompress(used, cap, ratio, history.length)) {
        return { ok: true, skipped: true, used, cap };
      }
      const dropped = Math.max(0, history.length - DEFAULT_TAIL_KEEP);
      if (!agent || !engine) {
        // 无模型可做摘要 → 硬裁剪保底（保留最近 K 轮），摘要置空避免陈旧内容误导
        await setSessionSummary(sessionId, null, DEFAULT_TAIL_KEEP);
        return { ok: true, truncated: true, dropped, used, cap };
      }
      const summary = await engine.summarizeContext(agent, history, {});
      if (summary) {
        await setSessionSummary(sessionId, summary.summary, DEFAULT_TAIL_KEEP);
        return { ok: true, summary: summary.summary, dropped, used, cap };
      }
      // 摘要轮失败 → 降级硬裁剪
      await setSessionSummary(sessionId, null, DEFAULT_TAIL_KEEP);
      return { ok: true, truncated: true, dropped, used, cap };
    } catch (e) {
      console.error("[gui:main] chat:compress crashed:", e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
    // A-1017：同 slime:chat:stream —— 加载面板不再由这里预判，改由管理器状态广播驱动。
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
    // A-980-R24：重试流同样走 chunk 合批（此前与正常发送路径一样是每 token 一条 IPC）
    const chunkSender = createChunkSender();
    // 授权/提问请求按当前流打会话标签（retry 流的会话 = payload.sessionId）
    const retryCancelKey = payload.sessionId ?? agentId;
    agentStreamSessionMap.set(agentId, retryCancelKey);
    lastChatCancelKey = retryCancelKey; // A-1017：供加载面板的「取消加载」中断本次加载
    // 干净正文：优先取 chatService done 事件全量清洗后的 reply（同 slime:chat:stream）
    let cleanReply: string | undefined;
    // A-939 上下文分桶（随 done 事件透传给渲染层分桶托盘）
    let ctxBuckets: CtxBuckets | undefined;
    // D/E：重试流同样记录 trace 与 Plan 工具拦截
    const recorder = new TraceRecorder(retryCancelKey);
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      void (async () => {
        try {
          for await (const ev of chatService!.stream(agentId, req, 0)) {
            recorder.push(ev);
            interceptPlanTool(ev, retryCancelKey);
            if (ev.type === "done") {
              const d = (ev.data ?? {}) as Record<string, unknown>;
              if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            }
            const chunk = toStreamChunk(ev, payload.sessionId);
            session.pushChunk(chunk);
            // A-980-R24：合批下发（原始 chunk 仍逐条进 session 缓冲）
            chunkSender.push(chunk);
          }
          // A-980-R24：done 之前必须 flush（否则尾部正文晚于 done 到达）
          chunkSender.flush();
          mainWindow?.webContents.send("slime:chat:done", {
            reply: cleanReply ?? session.fullReply, model: session.model,
            elapsedMs: session.elapsedMs, timings: session.timings,
            sessionId: payload.sessionId,
            // A-933：权威窗口上限（Agent.max_context 或本次模型 context_window），右栏与环同源
            windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
            // A-939：上下文分桶（引擎 done 事件 → 渲染层分桶托盘）
            ctxBuckets,
          });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          // A-980-R26：重新生成完成 → 系统通知
          notifyUser({
            kind: "done",
            title: `${agentNameForNotify(agentId)} 已完成`,
            body: (cleanReply ?? session.fullReply ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || "任务已结束",
          });
          const traced = recorder.finish(true);
          traceStoreSet(retryCancelKey, traced);
          mainWindow?.webContents.send("slime:trace:update", { sessionId: retryCancelKey, trace: traced });
          resolve({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[gui:main] chat retry error:", msg);
          chunkSender.flush(); // A-980-R24：中断前已产出的内容照常放出去
          mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: payload.sessionId });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          // A-980-R26：重新生成出错同样通知
          notifyUser({
            kind: "error",
            title: `${agentNameForNotify(agentId)} 出错`,
            body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "重新生成时发生错误",
          });
          const failedTrace = recorder.finish(false, msg);
          traceStoreSet(retryCancelKey, failedTrace);
          mainWindow?.webContents.send("slime:trace:update", { sessionId: retryCancelKey, trace: failedTrace });
          resolve({ ok: false, error: msg });
        } finally {
          chunkSender.dispose(); // A-980-R24：合批器收尾（flush 幂等）
          // 值匹配才删（A-151 竞态防护，同 slime:chat:stream）
          if (agentStreamSessionMap.get(agentId) === retryCancelKey) {
            agentStreamSessionMap.delete(agentId);
          }
          // A-1017：兜底收口（同 slime:chat:stream —— 面板由管理器状态广播驱动）
          mainWindow?.webContents.send("slime:model:loading", { loading: false });
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
    const items: Array<{ sessionId: string; agentId: string; agentName: string; workspace?: string; title: string; count: number; lastTime: string; memberIds?: string[]; memberNames?: string[]; memberModels?: Record<string, string>; leaderModel?: string; memberEfforts?: Record<string, string>; leaderEffort?: string; type?: "normal" | "brainstorm" }> = [];
    for (const meta of metas) {
      // 旧记录（无 session_id）按 "default" 聚合，归入该 Agent 首个会话
      const agg = byKey.get(`${meta.agentId}::${meta.id}`) ?? byKey.get(`${meta.agentId}::default`);
      const memberIds = memberIdsOf(meta.members);
      const memberNames = memberIds.map((id) => names.get(id) ?? id);
      items.push({
        sessionId: meta.id,
        agentId: meta.agentId,
        agentName: names.get(meta.agentId) ?? meta.agentId,
        workspace: meta.workspace,
        title: meta.title,
        count: agg?.count ?? 0,
        lastTime: agg?.lastTime ?? meta.updatedAt,
        memberIds,
        memberNames,
        memberModels: memberModelsOf(meta.members),
        leaderModel: meta.leaderModel,
        memberEfforts: memberEffortsOf(meta.members),
        leaderEffort: meta.leaderEffort,
        type: meta.type,
      });
    }
    // 无会话元数据的旧历史（惰性迁移：为该 Agent 建默认会话）
    for (const [key, agg] of byKey) {
      const agentId = key.split("::")[0];
      if (!metas.some((m) => m.agentId === agentId)) {
        // A-1017：**只有 Agent 仍然存在才迁移**。
        // 此前无条件 `ensureDefaultSession(agentId)` → 历史里任何孤儿 agent_id 都会被建成
        // 一个绑定不存在 Agent 的**幽灵会话**：模型一个都选不了（引擎 findAgent 返回 undefined
        // → 404「Agent 不存在」），而且删掉之后下一次列表刷新又照原样建回来。
        // 孤儿 agent_id 的现实来源：测试漏注入 history store 把夹具写进了真实 history.jsonl
        // （测试侧已修 + 有守卫），以及历史上被删除的 Agent。
        if (!names.has(agentId)) {
          console.warn(
            `[gui:main] 跳过孤儿历史的会话迁移：Agent「${agentId}」不存在（${agg.count} 条记录，未建会话）`,
          );
          continue;
        }
        const meta = await ensureDefaultSession(agentId);
        const memberIds = memberIdsOf(meta.members);
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
  handleTrusted<{ agentId?: string; title?: string; workspace?: string | null; memberIds?: MemberEntry[]; leaderModel?: string; type?: "normal" | "brainstorm" }>("slime:sessions:create", async (_event, payload) => {
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
      leaderModel: payload.leaderModel,
      type: payload.type === "brainstorm" ? "brainstorm" : undefined,
    });
    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));
    const memberIds = memberIdsOf(meta.members);
    console.info(`[gui:main] 新建会话: agent=${aid} session=${meta.id} workspace=${meta.workspace ?? "(未绑定)"} members=${memberIds.length}${meta.type === "brainstorm" ? "（头脑风暴）" : ""}`);
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
        memberModels: memberModelsOf(meta.members),
        leaderModel: meta.leaderModel,
        memberEfforts: memberEffortsOf(meta.members),
        leaderEffort: meta.leaderEffort,
        type: meta.type,
      },
    };
  });

  /** A-943：切换会话模式（普通 / 群聊头脑风暴） */
  handleTrusted<{ sessionId: string; type?: "normal" | "brainstorm" }>("slime:sessions:setType", async (_event, payload) => {
    if (!payload?.sessionId) { return { ok: false, error: "sessionId 必填" }; }
    const meta = await setSessionType(payload.sessionId, payload.type === "brainstorm" ? "brainstorm" : null);
    return { ok: !!meta, sessionId: payload.sessionId, type: meta?.type ?? "normal" };
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
      // A-1017：该 Agent 的**最后一个**会话被删掉时，连**没有 session_id 的遗留历史**一起清。
      // 不清的后果：遗留记录留在盘上 → 下一次 `sessions:list` 的孤儿迁移又把它建成新会话
      // → 用户体感"这个会话删不掉"，且每次复活都换一个新 sessionId。
      const rest = (await listSessions()).filter((s) => s.agentId === meta.agentId);
      if (rest.length === 0) {
        const purged = await clearLegacySessionHistory(meta.agentId);
        if (purged > 0) {
          console.info(`[gui:main] 会话删除时清理遗留历史（无 session_id）: agent=${meta.agentId} 条数=${purged}`);
        }
      }
    }
    // A-980-R29：会话删了，它的 Plan（内存 Map）与待办文件（data/todos_<sid>.json）也要一起走。
    // 此前两条都只增不减 → 内存常驻 + data/ 目录无限堆积。
    purgeSessionPlanning(payload.sessionId);
    console.info(`[gui:main] 会话已删除: session=${payload.sessionId}`);
    return { ok: removed };
  });

  /** A-1008：历史记录 → GUI 消息。
   *
   *  群聊记录（type=brainstorm 且有逐成员发言）必须**按成员展开成多条**，每条带自己的
   *  agentName/agentId。此前一律只产出一条不带归属的 assistant 消息 → 渲染层回退到会话归属
   *  Agent 的名字，于是"把所有人发言揉在一起的一条巨长气泡"看起来就像某个 Agent 出来总结复述，
   *  且重启后成员气泡全丢（它们从未落库）。这是同一根因的两个症状，见 ref-grouptalk.md。
   *
   *  旧记录（只有拼好的大字符串、没有 turns）走 `parseSpeakerBlob` 还原，用户历史里已有的
   *  记录也能直接恢复成逐成员气泡，不必等重开一轮。
   *
   *  实现已搬到 `core-ts/src/services/grouptalkTranscript.ts` 的 `expandHistoryRecord`
   *  （纯函数）—— 内联在 IPC handler 里等于测不到，而"一条记录展开成几条气泡"正是这个
   *  历时很久的故障的最后一环，必须可回归。这里只保留一个同签名包装，调用点不用改。
   */
  const historyRecordToMessages = (
    r: HistoryRecord,
    groupNames?: ReadonlySet<string>,
  ): ExpandedMessage[] => expandHistoryRecord(r, groupNames);

  /** 群聊会话的成员名集合（用于判断某条记录该不该按发言块展开；undefined = 非群聊会话） */
  const groupNamesOf = async (meta: { id?: string; type?: string; members?: unknown }): Promise<ReadonlySet<string> | undefined> => {
    if (meta.type !== "brainstorm") { return undefined; }
    try {
      const ids = memberIdsOf(meta.members as MemberEntry[] | undefined);
      const agents = await Promise.all(ids.map((id) => agentRegistry!.findAgent(id).catch(() => null)));
      const names = agents.filter((a): a is AgentState => a !== null).map((a) => a.name);
      // 会话归属 Agent 也可能发言（roster 含 loadingAgent）→ 一并纳入
      if (meta.id) {
        const owner = await getSession(meta.id).catch(() => null);
        if (owner?.agentId) {
          const a = await agentRegistry!.findAgent(owner.agentId).catch(() => null);
          if (a) { names.push(a.name); }
        }
      }
      return new Set(names);
    } catch {
      return undefined;
    }
  };

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
    const groupNames = await groupNamesOf(meta);
    return records.flatMap((r) => historyRecordToMessages(r, groupNames));
  });

  /** A-980-R18：分页加载更早历史（聊天顶部「加载更早的消息」分段胶囊点击再载；首屏只载最近 500 条） */
  handleTrusted<{ sessionId: string; beforeTs: string; limit?: number }>("slime:sessions:loadEarlier", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return { messages: [], hasMore: false }; }
    const metas = await listSessions();
    const agentSessions = metas.filter((m) => m.agentId === meta.agentId);
    // 旧记录（无 session_id）归入创建最早的会话
    const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
    const { records, hasMore } = await loadHistoryForSessionBefore(
      meta.agentId, meta.id, payload.limit ?? 200, firstSession, payload.beforeTs,
    );
    const groupNames = await groupNamesOf(meta);
    return { messages: records.flatMap((r) => historyRecordToMessages(r, groupNames)), hasMore };
  });

  /** A-966：渲染层 done 后把该条回复的交错时间线回填到 history.jsonl（重启恢复时间线，不依赖 localStorage） */
  handleTrusted<{ agentId: string; sessionId: string; timeline: unknown[] }>("slime:chat:attachTimeline", async (_event, p) => {
    try {
      await attachTimelineToRecord(p.agentId, p.sessionId, (p.timeline as HistoryRecord["timeline"]) ?? []);
      return { ok: true };
    } catch (e) {
      console.warn("[gui:main] attachTimeline 失败:", e instanceof Error ? e.message : String(e));
      return { ok: false };
    }
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
    const memberIds = memberIdsOf(updated.members);
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
        memberModels: memberModelsOf(updated.members),
        leaderModel: updated.leaderModel,
        memberEfforts: memberEffortsOf(updated.members),
        leaderEffort: updated.leaderEffort,
      },
    };
  });

  /** A-1011 群聊成员思考推理强度（会话级覆盖；仅影响该群聊，不写 Agent 全局配置）
   *  - effort=null 清除覆盖 → 回落群聊默认 high
   *  - 组长（meta.agentId）写 leaderEffort，其余成员写 members 条目 */
  handleTrusted<{ sessionId: string; memberId: string; effort: string | null }>("slime:sessions:setMemberEffort", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionMemberEffort(payload.sessionId, payload.memberId, payload.effort ?? null);
    if (!updated) { throw new Error("会话不存在或该成员不在群聊中"); }
    const eff = payload.effort ? payload.effort : "(默认 high)";
    console.info(`[gui:main] 群聊成员推理强度: session=${payload.sessionId} member=${payload.memberId} → ${eff}`);
    return { ok: true, memberEfforts: memberEffortsOf(updated.members), leaderEffort: updated.leaderEffort };
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
    // A-980-R28：**空 sessionId 直接拒绝**。渲染层在会话未就绪时传的是 `?? ""`，
    // 而 `todos_` + "" + `.json` = `data/todos_.json` —— 那正好是修复前遗留孤儿文件的文件名，
    // 于是"会话加载途中就把上一次的旧待办显示出来了"（用户实测）。
    // 这类兜底必须放在主进程：渲染层任何一处忘了守卫都不该能把孤儿文件读出来。
    // （A-980-R29：`todoStore.todoPath` 对空 sessionId 返回 null，双重保险。）
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) {
      console.warn("[gui:main] loadTodos 收到空 sessionId，已拒绝（避免读到 todos_.json 这类孤儿文件）");
      return { ok: true, todos: [] };
    }
    // A-985：**首次**读某会话的待办时收敛"僵尸 in_progress" ——
    // App 卡死被强杀 / 进程重启后，落盘的 in_progress 项会永远显示成"进行中"（转圈 + 高亮），
    // 但根本没有流在跑（用户实测："我并未输入任何命令，列表却显示一个任务在进行中"）。
    // 判定依据用 `activeChats`（主进程唯一有资格回答"这条流死没死"的地方，key = sessionId ?? agentId）：
    // 只有确证没有活跃流才降级，绝不会误伤正在跑的任务。
    if (!staleChecked.has(sid)) {
      staleChecked.add(sid);
      if (!activeChats.has(sid)) {
        const n = demoteStaleInProgress(sid);
        if (n > 0) {
          console.warn(`[gui:main] 待办收敛：会话 ${sid} 有 ${n} 项停在"进行中"但没有活跃流，已降级为待办（A-985）`);
        }
      }
    }
    // 读取统一走 todoStore（容错 + 归一化口径与工具一致）
    const todos = readTodos(sid);
    // A-985：读盘路径读到一张**已全部完成**的清单 → **立即**清干净，不再走 1.5s 延迟。
    // 那个延迟的唯一目的是"让刚完成时的划过动画播完"；而读盘路径没有任何动画要播，
    // 延迟只会让用户看到"打开会话后列表自己消失一下" —— 用户实测把它当成了显示异常
    // （原话："我怀疑是列表判断为任务全部完成后全部自动清除"）。
    // 顺带解决一个更糟的边界：若在这 1.5s 内 App 被强杀，清空永远不会发生 → 那张全完成清单
    // 会一直躺在盘上，每次打开会话都重新排一次清空（反复"自己消失"）。
    if (allTodosCompleted(todos)) {
      removeTodos(sid);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("slime:tasks:todos", { sessionId: sid, todos: [] });
      }
      return { ok: true, todos: [] };
    }
    // 广播到所有渲染进程（支持多窗口场景）
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("slime:tasks:todos", { sessionId: sid, todos });
    }
    return { ok: true, todos };
  });

  /**
   * A-986：渲染层手改待办 → **落盘**。
   *
   * 事故：此前**根本没有这条通道**（只有 load + 订阅），渲染层的 `toggleTodo/advanceTodo/addTodo`
   * 只调 `setTodos()` 改内存。而待办的真源是 `data/todos_<sid>.json` ——
   * 下一次任何来源的 `slime:tasks:todos` 广播（模型 todo_write / 切会话 / 重启读盘）
   * 都用盘上的旧内容把它覆盖回去。后果有两个，用户都撞上了：
   *   ① 手动勾选"没反应"（勾完过一会儿又变回未完成）；
   *   ② 主进程的「全部完成 → 自动清空」挂在 `broadcastTodos` 上 —— 手改不落盘就永不广播，
   *      于是把全部任务勾完也**不会**触发自动清空。
   * 现在手改同样走"写盘 → 广播"（与模型写 todo_write 完全同一条链路），语义才一致。
   */
  handleTrusted<{ sessionId?: string; todos?: unknown[] }>("slime:tasks:saveTodos", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) { return { ok: false, error: "会话未就绪，无法保存待办" }; }
    if (!Array.isArray(payload?.todos)) { return { ok: false, error: "todos 必须是数组" }; }
    // 归一化 + 落盘统一走 todoStore（与工具同一份实现，规则只有一处）
    const saved = writeTodos(sid, payload.todos as Parameters<typeof writeTodos>[1]);
    if (!saved) { return { ok: false, error: "写入失败（路径不可写或会话无效）" }; }
    // 写盘后立刻广播：界面与磁盘对齐，并顺带触发"全部完成 → 自动清空"判定
    broadcastTodos(sid);
    return { ok: true, todos: saved };
  });

  /**
   * A-986：整张清空（删文件 + 广播空列表）。
   *
   * A-980-R32 曾以"自动清空已覆盖"为由删掉手动清空入口。实践证伪：自动清空只覆盖
   * **全部 completed** 这一种终态；清单里混进"莫须有的任务"（模型写歪、旧会话串味、
   * 手滑加错）时，用户既删不掉（行尾 ✕ 也被删了）也清不了 —— 只能看着它一直挂在那儿。
   * 用户的诉求很直接："你给我彻底优化这个待办任务的清除逻辑"。故恢复该入口。
   */
  handleTrusted<{ sessionId?: string }>("slime:tasks:clearTodos", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) { return { ok: false }; }
    removeTodos(sid);
    staleChecked.add(sid); // 刚清空 → 没有可收敛的东西，避免下一次读盘又走一遍收敛
    broadcastTodos(sid);
    return { ok: true };
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
    // A-980-R29：**先记住**该 Agent 的会话 id —— `removeSessionsForAgent` 只返回数量，
    // 删完就再也查不到这些 sessionId，待办文件（data/todos_<sid>.json）会永远留在磁盘上。
    const doomed = (await listSessions()).filter((s) => s.agentId === agentId).map((s) => s.id);
    await removeSessionsForAgent(agentId);
    await removeAgentHistory(agentId);
    for (const sid of doomed) { purgeSessionPlanning(sid); }
    console.info(`[gui:main] 项目已删除（会话+历史+待办清理）: agent=${agentId} sessions=${doomed.length}`);
    return { ok: true };
  });

  /** 删除工作文件夹分组：清除该 workspace 下全部会话元数据 + 各会话历史（文件夹本身与 Agent 保留） */
  handleTrusted<{ workspace: string }>("slime:sessions:removeWorkspace", async (_event, payload) => {
    await ensureServices();
    const workspace = payload.workspace;
    const removed = await removeSessionsForWorkspace(workspace);
    for (const s of removed) {
      try { await clearSessionHistory(s.agentId, s.sessionId); } catch { /* 忽略单条历史清理失败 */ }
      // A-980-R29：待办文件与 Plan 一并清理（与上面两个删除入口口径一致）
      purgeSessionPlanning(s.sessionId);
    }
    // A-1017：涉及到的 Agent 若已**再无任何会话**，连它没有 session_id 的遗留历史一起清 ——
    // 否则下一次 `sessions:list` 的孤儿迁移会把它们重新建成幽灵会话（同 sessions:remove）。
    const rest = await listSessions();
    for (const aid of new Set(removed.map((s) => s.agentId))) {
      if (rest.some((s) => s.agentId === aid)) { continue; }
      try {
        const purged = await clearLegacySessionHistory(aid);
        if (purged > 0) {
          console.info(`[gui:main] 工作文件夹删除时清理遗留历史（无 session_id）: agent=${aid} 条数=${purged}`);
        }
      } catch { /* 忽略单条历史清理失败 */ }
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

  /** A-918++：GUI 表单新增 MCP 服务器（追加 [[mcp_servers]] 块，不再要求手动编辑 slime.toml） */
  handleTrusted<{ name: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string> }>(
    "slime:extras:mcpAdd",
    async (_event, p) => {
      const { addMcp } = await import("./config_files.js");
      return addMcp(p);
    },
  );

  /** A-918++：GUI 表单新建技能（生成 config/skills/<name>/SKILL.md） */
  handleTrusted<{ name: string; description: string; content?: string }>(
    "slime:extras:skillAdd",
    async (_event, p) => {
      const { addSkill } = await import("./config_files.js");
      return addSkill(p);
    },
  );

  /** A-918++：联网搜索技能市场（anthropics/skills 官方仓库） */
  handleTrusted<{ query?: string }>("slime:extras:skillMarketSearch", async (_event, p) => {
    const { searchSkillMarket } = await import("./config_files.js");
    return searchSkillMarket(p?.query ?? "");
  });

  /** A-918++：从官方仓库安装技能（下载 SKILL.md 写入 config/skills/） */
  handleTrusted<{ name: string }>("slime:extras:skillMarketInstall", async (_event, p) => {
    const { installSkillFromMarket } = await import("./config_files.js");
    return installSkillFromMarket(p?.name ?? "");
  });

  /** A-918++：读取数据源认证（GitHub Token，加密） */
  handleTrusted<void>("slime:extras:registryAuthGet", async () => {
    const { getRegistryAuth } = await import("./config_files.js");
    return getRegistryAuth();
  });

  /** A-918++：保存数据源认证（GitHub Token，加密） */
  handleTrusted<{ githubToken?: string }>("slime:extras:registryAuthSet", async (_event, p) => {
    const { setRegistryAuth } = await import("./config_files.js");
    return setRegistryAuth({ githubToken: p?.githubToken });
  });

  /** A-918++：内嵌 BrowserWindow 打开 GitHub Token 生成页（利用 Electron Chromium 内核，用户应用内登录生成 token） */
  handleTrusted<void>("slime:extras:openGithubAuth", async () => {
    try {
      const win = new BrowserWindow({
        width: 920, height: 720, minWidth: 640, minHeight: 480,
        title: "GitHub 授权 — 登录后生成 Token 并复制，回到 slime 粘贴保存",
        autoHideMenuBar: true,
        backgroundColor: "#0d1117",
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
      void win.loadURL("https://github.com/settings/tokens/new?scopes=repo&description=slime-agent");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `打开授权窗口失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /** A-918++：运行环境一览（node/python/git/llama/models 的路径·版本·大小·就绪状态，供 RuntimePanel） */  handleTrusted<void>("slime:runtime:list", async (): Promise<{
    ok: boolean; items?: Array<{
      kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string;
      action?: { label: string; kind: string; url?: string; path?: string; target?: string };
    }>; error?: string;
  }> => {
    const fmtBytes = (n: number): string => {
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
      if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${n} B`;
    };
    const fileSize = (p: string): string | undefined => {
      try { if (!existsSync(p)) { return undefined; } return fmtBytes(statSync(p).size); } catch { return undefined; }
    };
    const items: Array<{ kind: string; label: string; path?: string; version?: string; sizeText?: string; ok: boolean; note?: string; source: string; action?: { label: string; kind: string; url?: string; path?: string; target?: string } }> = [];
    try {
      // Node（Electron 内嵌）
      items.push({ kind: "node", label: "Node.js", version: `v${process.versions.node}`, ok: true, source: "bundled", note: "GUI 由 Electron 内嵌 Node 驱动" });
      // Python venv（随包）—— 随包依赖，必须走 resolveBundled（开发模式在项目根，不在 gui/）
      const pyExe = process.platform === "win32"
        ? resolveBundled("runtime/venv/Scripts/python.exe")
        : resolveBundled("runtime/venv/bin/python");
      const pyOk = existsSync(pyExe);
      items.push({ kind: "python", label: "Python（随包 venv）", path: pyExe, sizeText: fileSize(pyExe), ok: pyOk, source: pyOk ? "bundled" : "missing", ...(pyOk ? {} : { note: "缺少随包 venv——请重新运行 prepare-runtime 或重装" }) });
      // Git（系统）
      await new Promise<void>((resolveP) => {
        execFile("git", ["--version"], { timeout: 4000 }, (err, stdout) => {
          if (err || !stdout) {
            items.push({ kind: "git", label: "Git", ok: false, source: "missing", note: "未检测到 git——请安装 Git for Windows（https://git-scm.com）后重开" });
          } else {
            const ver = stdout.trim().replace(/^git version\s*/i, "");
            items.push({ kind: "git", label: "Git", version: ver, ok: true, source: "system" });
          }
          resolveP();
        });
      });
      // llama.cpp（随包二进制）
      const llamaExe = process.platform === "win32"
        ? resolveBundled("llama.cpp/build/bin/llama-server.exe")
        : resolveBundled("llama.cpp/build/bin/llama-server");
      const llamaOk = existsSync(llamaExe);
      items.push({
        kind: "llama", label: "llama.cpp（本地推理）", path: llamaExe, sizeText: fileSize(llamaExe), ok: llamaOk,
        source: llamaOk ? "bundled" : "missing",
        ...(llamaOk ? {} : { note: "缺失——重新运行 prepare-runtime 下载或到 设置→供应商→本地模型 配置" }),
      });
      // 模型目录（随包 npz + 按需 GGUF）
      const modelRoot = resolveBundled("models");
      const ggufFiles: Array<{ p: string; n: string }> = [];
      try {
        const scan = (dir: string, depth: number): void => {
          if (depth > 2 || !existsSync(dir)) { return; }
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name);
            if (e.isDirectory()) { scan(full, depth + 1); }
            else if (e.name.endsWith(".gguf") || e.name.endsWith(".npz")) { ggufFiles.push({ p: full, n: e.name }); }
          }
        };
        scan(modelRoot, 0);
      } catch { /* 忽略 */ }
      if (ggufFiles.length > 0) {
        items.push({
          kind: "models", label: "本地模型", path: modelRoot,
          version: `${ggufFiles.length} 个文件`, sizeText: ggufFiles[0] ? fileSize(ggufFiles[0].p) : undefined,
          ok: true, source: ggufFiles[0]?.n.includes("bge") ? "bundled" : "download",
          note: ggufFiles.map((f) => f.n).join("、").slice(0, 120),
        });
      } else {
        items.push({ kind: "models", label: "本地模型", path: modelRoot, ok: false, source: "download", note: "暂无模型文件——首次使用本地推理时自动下载" });
      }
      // A-918++：ADB（Android 调试桥）—— 检测安装情况（缺失给下载动作，就绪给启动服务动作）
      try {
        const ad = await adbService.detect();
        if (ad.ok) {
          items.push({ kind: "adb", label: "ADB（Android 调试桥）", path: ad.path, version: ad.version, ok: true, source: ad.source || "system", note: "已就绪——可连接模拟器/安卓设备；服务未启动时可点右侧按钮" });
        } else {
          items.push({ kind: "adb", label: "ADB（Android 调试桥）", ok: false, source: "missing", note: "未检测到 adb——下载 platform-tools 后即可连接安卓设备/模拟器" });
        }
      } catch { /* 忽略 */ }
      // 缺失项补动作：llama/bge 走内置下载器；python 缺失走官网（要求用户装 Python 后重建 venv，避免打包 Python 解释器）；
      // git 缺失走官网；action.kind = "download" → renderer 调 mind.download；"openExternal"/"openPath" 走 slime:runtime:open
      for (const it of items) {
        if (it.ok) { continue; }
        if (it.kind === "llama") { it.action = { label: "下载 llama.cpp", kind: "download", target: "llama" }; }
        else if (it.kind === "models") { it.action = { label: "下载 BGE 模型", kind: "download", target: "bge" }; }
        else if (it.kind === "git") { it.action = { label: "下载 Git", kind: "openExternal", url: "https://git-scm.com/downloads" }; }
        // python 缺失：官网装 Python 后点"重建 venv"（vbox 真实路径在项目根 runtime/venv，不在 gui/runtime）
        else if (it.kind === "python") { it.action = { label: "下载 Python（装后再重建）", kind: "openExternal", url: "https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe" }; }
      }
      // A-918++：ADB —— 缺失给「下载 platform-tools」，就绪给「启动 ADB 服务」
      for (const it of items) {
        if (it.kind !== "adb") { continue; }
        if (!it.ok) { it.action = { label: "下载 platform-tools", kind: "adbDownload" }; }
        else { it.action = { label: "启动 ADB 服务", kind: "adbStart" }; }
      }
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: `读取运行环境失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /** A-918++：重建 Python venv（系统 Python → BUNDLE_ROOT/runtime/venv → pip install -r requirements.txt）。
   *  走 spawn 系统 Python（PATH 的 python.exe）。完成后 renderer 调 load() 刷新。 */
  handleTrusted<void>("slime:runtime:installPython", async (): Promise<{ ok: boolean; log?: string; error?: string }> => {
    const venvDir = resolveBundled("runtime/venv");
    const reqFile = resolveBundled("requirements.txt");
    /*
     * 这两行原先是 `resolveExtra("../runtime/venv")` 的字符串绕行 —— 注释自陈"gui/runtime/venv 错误"。
     * 它只在**开发模式**蒙对（`gui/../` 恰好是项目根），打包模式下 `../` 会指到安装根的**上一级**，
     * 于是"重建 venv"在正式安装包里必然失败。改用 resolveBundled 后两个模式同时正确。
     */
    const isWin = process.platform === "win32";
    const venvPip = isWin ? join(venvDir, "Scripts", "pip.exe") : join(venvDir, "bin", "pip");
    const sysPy = isWin ? "python.exe" : "python3";
    const log: string[] = [];
    try {
      log.push(`创建 venv：${venvDir}`);
      await new Promise<void>((resolveP, rejectP) => {
        execFile(sysPy, ["-m", "venv", "--copies", venvDir], { timeout: 120_000 }, (err, stdout, stderr) => {
          log.push(stdout || ""); log.push(stderr || "");
          err ? rejectP(err) : resolveP();
        });
      });
      log.push(`pip install：${reqFile}`);
      await new Promise<void>((resolveP, rejectP) => {
        execFile(venvPip, ["install", "-r", reqFile], { timeout: 600_000 }, (err, stdout, stderr) => {
          log.push(stdout || ""); log.push(stderr || "");
          err ? rejectP(err) : resolveP();
        });
      });
      log.push("✅ venv 重建完成");
      return { ok: true, log: log.join("\n").slice(-4000) };
    } catch (e) {
      log.push(`✗ 失败：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, log: log.join("\n").slice(-4000), error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** A-918++：运行环境缺失项的动作（打开官网下载 / 打开本地目录） */
  handleTrusted<{ action?: { label?: string; kind?: string; url?: string; path?: string } }>(
    "slime:runtime:open",
    async (_event, p): Promise<{ ok: boolean; error?: string }> => {
      const a = p?.action;
      if (!a) { return { ok: false, error: "缺少动作参数" }; }
      try {
        if (a.kind === "openExternal" && a.url) {
          await shell.openExternal(a.url);
          return { ok: true };
        }
        if (a.kind === "openPath" && a.path) {
          const err = await shell.openPath(a.path);
          return err ? { ok: false, error: err } : { ok: true };
        }
        return { ok: false, error: "未知动作" };
      } catch (e) {
        return { ok: false, error: `执行动作失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  );

  /** A-918++：git show <ref>:<rel>（FileTab diff 模式对比 Git HEAD 用；rel 相对仓库根） */
  handleTrusted<{ rel: string; workspace: string; ref?: string }>(
    "slime:git:showFile",
    async (_event, p): Promise<{ ok: boolean; content?: string; error?: string; code?: "not-repo" | "no-head" | "not-found" }> => {
      const rel = (p?.rel ?? "").trim();
      const ws = (p?.workspace ?? "").trim();
      const ref = p?.ref || "HEAD";
      if (!rel || !ws) { return { ok: false, error: "缺少参数" }; }
      /**
       * A-1029：**先探测仓库，再说话**。
       *
       * 原先直接把 `git show` 的 stderr 截 300 字回给界面，于是非 Git 工作区（用户实测
       * `D:\试验场` 下没有 `.git`）会抛出原始英文：
       *   `fatal: not a git repository (or any of the parent directories): .git`
       * 用户看到这句只会认为"功能坏了"，既不知道**原因**（这个目录本来就不是仓库），
       * 也不知道**还能怎么办**（其实本次改动的 before/after 就内嵌在聊天区的工具卡里）。
       *
       * 现有的三个容错分支（exists on disk / did not match any file / unknown revision）
       * 漏掉的正是最常见的那一类。故这里显式探测，并把"下一步去哪看"写进文案。
       */
      const inside = await runGit(["rev-parse", "--is-inside-work-tree"], ws);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return {
          ok: false,
          code: "not-repo",
          error: `「${ws}」不在 Git 仓库内（该目录及其上层都找不到 .git），因此没有可对比的 Git 历史版本。` +
            `要查看本次改动的前后差异，请用聊天区「写入文件」工具卡里的「变更详情」（那份对比是随消息一起记录的，不依赖 Git）。`,
        };
      }
      const r = await runGit(["show", `${ref}:${rel}`], ws);
      if (r.code !== 0) {
        // 若文件在 HEAD 不存在（新增文件）→ 空内容 diff 全新增
        if (/exists on disk, but not in|did not match any file|path .* unknown revision/i.test(r.stderr)) {
          return { ok: true, content: "" };
        }
        // A-1029：仓库存在但没有提交（空仓库）→ 同样给可读解释，而不是原始 porcelain 提示
        if (/does not have any commits yet|unknown revision or path not in the working tree/i.test(r.stderr)) {
          return {
            ok: false,
            code: "no-head",
            error: `「${ws}」是 Git 仓库但还没有任何提交，没有可比对的 HEAD 版本。先提交一次再对比。`,
          };
        }
        return { ok: false, error: r.stderr.slice(0, 300) || `git show 失败（${r.code}）` };
      }
      return { ok: true, content: r.stdout };
    },
  );

  /* ═══════════════ ADB 设备管理（A-918++） ═══════════════ */
  /** 注入 AdbService 给 core-ts 工具层（对齐 setSubagentManager 注入模式） */
  setAdbService(adbService);

  /* ═══════════════ HTTP 静态服务搭建（A-918++） ═══════════════ */
  /** 注入 HttpStaticServer 给 core-ts 工具层（对齐 setAdbService 注入模式） */
  setHttpServer(httpServer);
  /** A-977：静态服务清单持久化——记到 userData，启动时按记录端口重建（重启后旧链接仍可用）。 */
  try {
    const persistPath = join(app.getPath("userData"), "http_servers.json");
    httpServer.setPersistPath(persistPath);
    void httpServer.restore().then((r) => {
      if (r.restored > 0 || r.failed > 0) {
        console.log(`[slime] HTTP 静态服务恢复：成功 ${r.restored}，失败 ${r.failed}`);
      }
    }).catch(() => { /* 恢复失败不影响启动 */ });
  } catch { /* userData 不可用时退化为不持久化 */ }

  /** A-918++：生成网页应用后，由 core-ts 工具层回调 → 主进程通知渲染层在右侧栏浏览器自动打开 */
  setSidebarOpener((url: string, name?: string): void => {
    mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url, name });
  });

  /* ═══════════════ 图形控制能力（screen_*）：slime 全程序级 ═══════════════ */
  /** ① 截图瘦身钩子：electron.nativeImage 缩放 + PNG→JPEG（防原图吃掉巨量 token），
   *     并叠加**刻度网格 + 元素编号框**标注（A-975：让模型有刻度可读、有编号可点）。 */
  setImageOptimizer((pngBase64: string, maxWidth: number, quality: number, annotate?: { grid?: boolean; marks?: Array<{ index: number; label?: string; x1: number; y1: number; x2: number; y2: number }>; marksSpace?: { width: number; height: number } }) => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
      if (img.isEmpty()) { return null; }
      const size = img.getSize();
      const out = maxWidth > 0 && size.width > maxWidth
        ? img.resize({ width: maxWidth, quality: "good" })
        : img;
      let finalImg = out;
      // A-975：在缩放后的位图上叠加标注（BGRA 逐像素绘制，零新依赖）
      if (annotate && (annotate.grid || (annotate.marks && annotate.marks.length > 0))) {
        try {
          const fs = out.getSize();
          const bmp = out.toBitmap();
          annotateBitmap(
            { buf: bmp, width: fs.width, height: fs.height },
            { grid: annotate.grid, marks: annotate.marks, marksSpace: annotate.marksSpace },
          );
          finalImg = nativeImage.createFromBitmap(bmp, { width: fs.width, height: fs.height });
        } catch { /* 标注失败 → 用无标注图（不阻断截图） */ }
      }
      const jpg = finalImg.toJPEG(quality);
      if (!jpg || jpg.length === 0) { return null; }
      const finalSize = finalImg.getSize();
      return {
        dataUrl: `data:image/jpeg;base64,${jpg.toString("base64")}`,
        width: finalSize.width,
        height: finalSize.height,
        bytes: jpg.length,
      };
    } catch {
      return null; // 优化失败 → 上层回退原 PNG
    }
  });

  /** ② 注册图形控制后端：桌面（Windows PowerShell+user32.dll 常驻宿主）与 Android（adb shell input）。
   *     两后端共用同一套动作语义与归一化坐标 → 这就是「属于 slime 整个程序的图形控制能力」，不限 ADB。 */
  const screenCtl = getScreenController();
  screenCtl.register(new DesktopScreenBackend());
  screenCtl.register(new AndroidScreenBackend(adbService));
  setScreenController(screenCtl);

  /** A-976：右侧栏浏览器控制桥 —— Agent 的 browser_* 工具经它把指令下发到 renderer 的 <webview> 执行。
   *  与 screen_* 并列的"第三块操控面"：ADB/桌面是屏幕级，这里是应用内嵌浏览器级。 */
  setBrowserAdapter(new BrowserBridge(() => mainWindow));

  /** ③ 工具类别闸门：让「设置 → 权限」的开关真正生效（此前只有 UI、无执行点）。
   *      每次调用实时读取配置 → 改设置后无需重启引擎。 */
  setToolCategoryGate((tool) => {
    const perms = getPermissions();
    // 图形控制总开关（高危能力，默认关闭）
    if (!perms.screenEnabled && tool.name.startsWith("screen_")) {
      return { allowed: false, reason: "图形控制已在「设置 → 权限」中关闭" };
    }
    // 断链 B 修复：MCP / 技能 全局开关（此前只有 UI 落盘、全仓无读取者 = 假开关）。
    // 工具名前缀是唯一运行时可靠判据：mcp_*（core-ts/src/mcp.ts:1021）/ skill_*（core-ts/src/skills.ts:215/502/532）。
    if (!perms.mcpEnabled && tool.name.startsWith("mcp_")) {
      return { allowed: false, reason: "MCP 已在「设置 → 权限」中关闭" };
    }
    if (!perms.skillsEnabled && tool.name.startsWith("skill_")) {
      return { allowed: false, reason: "技能已在「设置 → 权限」中关闭" };
    }
    const has = (p: string): boolean => tool.permissions.includes(p as never);
    // 只读工具：仅当「读」类别被关闭时才拦（避免误伤纯检索）
    if (!has("write") && !has("terminal") && !has("network")) {
      return perms.toolRead ? { allowed: true } : { allowed: false, reason: "「读」类别已关闭" };
    }
    if (!perms.toolWrite && has("write")) {
      return { allowed: false, reason: "「写」类别已关闭" };
    }
    if (!perms.toolTerminal && has("terminal")) {
      return { allowed: false, reason: "「终端」类别已关闭（ADB shell / 命令执行需开启此项）" };
    }
    return { allowed: true };
  });

  /** A-918++：HTTP —— 把本地目录作为静态服务启动（默认 0.0.0.0，端口自动选） */
  handleTrusted<{ dir: string; port?: number; host?: string; spa?: boolean }>("slime:http:serve", async (_event, p): Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }> => {
    return httpServer.serve({ dir: p?.dir ?? "", port: p?.port, host: p?.host, spa: p?.spa });
  });

  /** A-918++：HTTP —— 停止指定服务 */
  handleTrusted<{ id: string }>("slime:http:stop", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    return httpServer.stop(p?.id ?? "");
  });

  /** A-918++：HTTP —— 停止全部服务 */
  handleTrusted<void>("slime:http:stopAll", async (): Promise<{ ok: boolean; stopped: number }> => {
    return httpServer.stopAll();
  });

  /** A-918++：HTTP —— 列出运行中的服务 */
  handleTrusted<void>("slime:http:list", async (): Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>> => {
    return httpServer.list();
  });

  /* ═══════════════ 图形控制能力（screen_*）：GUI 面板与紧急停止 ═══════════════ */

  /** 列出可用图形控制后端与目标（渲染层「图形控制」卡片展示） */
  handleTrusted<void>("slime:screen:info", async (): Promise<{
    enabled: boolean;
    halted: boolean;
    backends: string[];
    targets: Array<{ backend: string; target: string; width: number; height: number; label: string }>;
  }> => {
    const enabled = getPermissions().screenEnabled;
    const ctl = getScreenController();
    const backends = ctl.listBackends();
    let targets: Array<{ backend: string; target: string; width: number; height: number; label: string }> = [];
    try {
      targets = await ctl.listTargets();
    } catch { /* 无可用目标不抛错 */ }
    return { enabled, halted: ctl.isHalted(), backends, targets };
  });

  /** 紧急停止：中断后续所有图形动作（用户在 GUI 上一键刹车） */
  handleTrusted<void>("slime:screen:halt", async (): Promise<{ ok: boolean }> => {
    getScreenController().halt();
    return { ok: true };
  });

  /** 恢复图形控制（新一轮任务开始） */
  handleTrusted<void>("slime:screen:resume", async (): Promise<{ ok: boolean }> => {
    getScreenController().resume();
    return { ok: true };
  });

  /** 截图（GUI 手动预览用；工具侧走 screen_capture 工具） */
  handleTrusted<{ backend?: string; target?: string }>("slime:screen:capture", async (_event, p): Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }> => {
    const backend = p?.backend === "android" ? "android" : "desktop";
    const r = await getScreenController().capture(backend, p?.target || undefined);
    return { ok: r.ok, dataUrl: r.dataUrl, width: r.width, height: r.height, error: r.error };
  });

  /** A-918++：HTTP —— 用系统默认浏览器打开某个访问地址。
   *  A-980-R3：加协议安全门——web 链接直接开；非 web（bitbrowser:// 等）走 openExternalSafe
   *  （探测处理器，已注册才开；未注册返回诊断，**绝不**直接 openExternal 触发系统报错框）。 */
  handleTrusted<{ url: string }>("slime:http:open", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const url = (p?.url ?? "").trim();
    if (!url) { return { ok: false, error: "url 不能为空" }; }
    try {
      if (isWebSafeUrl(url)) {
        await shell.openExternal(url);
        return { ok: true };
      }
      const r = await openExternalSafe(url);
      if (r.ok) { return { ok: true }; }
      // A-980-R4：浏览器唤起类协议 → 明确告知已拦截（不要求装客户端）
      if (r.reason === "browser-scheme") {
        return { ok: false, error: `已拦截浏览器唤起链接 ${(url.split(":")[0] || "").toLowerCase()}:// ——不唤醒外部浏览器` };
      }
      return { ok: false, error: `链接 ${(url.split(":")[0] || "").toLowerCase()}:// 需要安装对应客户端才能打开（系统未注册该协议）` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });


  /** A-918++：ADB —— 检测 adb 是否就绪（含版本/来源） */
  handleTrusted<void>("slime:adb:detect", async (): Promise<AdbDetect> => {
    return adbService.detect();
  });

  /** A-918++：ADB —— 下载官方 platform-tools 便携包（进度经 webContents 推渲染层） */
  handleTrusted<void>("slime:adb:download", async (): Promise<AdbCmdResult & { progress?: AdbDownloadProgress }> => {
    return adbService.downloadPlatformTools((p) => {
      mainWindow?.webContents.send("slime:adb:downloadProgress", p);
    });
  });

  /** A-918++：ADB —— 列出已连接设备 */
  handleTrusted<void>("slime:adb:devices", async (): Promise<{ ok: boolean; devices?: AdbDevice[]; error?: string }> => {
    return adbService.devices();
  });

  /** A-918++：ADB —— 无线连接设备（host 形如 192.168.1.10:5555） */
  handleTrusted<{ host: string }>("slime:adb:connect", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.connect(p?.host ?? "");
  });

  /** A-918++：ADB —— 断开无线连接 */
  handleTrusted<{ host: string }>("slime:adb:disconnect", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.disconnect(p?.host ?? "");
  });

  /** A-918++：ADB —— 在指定设备执行 shell 命令 */
  handleTrusted<{ serial: string; command: string }>("slime:adb:shell", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.shell(p?.serial ?? "", p?.command ?? "");
  });

  /** A-918++：ADB —— 安装 APK（serial + 本地 apk 路径） */
  handleTrusted<{ serial: string; apkPath: string }>("slime:adb:install", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.install(p?.serial ?? "", p?.apkPath ?? "");
  });

  /** A-918++：ADB —— 卸载应用（serial + 包名） */
  handleTrusted<{ serial: string; pkg: string }>("slime:adb:uninstall", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.uninstall(p?.serial ?? "", p?.pkg ?? "");
  });

  /** A-918++：ADB —— 截图（返回 PNG base64） */
  handleTrusted<{ serial: string }>("slime:adb:screencap", async (_event, p): Promise<AdbScreencapResult> => {
    return adbService.screencap(p?.serial ?? "");
  });

  /** A-918++：ADB —— 从设备拉取文件到本地 */
  handleTrusted<{ serial: string; remote: string; local: string }>("slime:adb:pull", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.pull(p?.serial ?? "", p?.remote ?? "", p?.local ?? "");
  });

  /** A-918++：ADB —— 推送本地文件到设备 */
  handleTrusted<{ serial: string; local: string; remote: string }>("slime:adb:push", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.push(p?.serial ?? "", p?.local ?? "", p?.remote ?? "");
  });

  /** A-918++：ADB —— 重启设备 */
  handleTrusted<{ serial: string }>("slime:adb:reboot", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.reboot(p?.serial ?? "");
  });

  /** A-918++：ADB —— 启动服务（连模拟器前需在跑）+ 停止服务 */
  handleTrusted<void>("slime:adb:startServer", async () => {
    return adbService.startServer();
  });
  handleTrusted<void>("slime:adb:killServer", async () => {
    return adbService.killServer();
  });

  /** A-918++：MCP 官方 registry 联网搜索（registry.modelcontextprotocol.io） */
  handleTrusted<{ query?: string }>("slime:mcpRegistrySearch", async (_event, p) => {
    const { searchMcpRegistry } = await import("./config_files.js");
    return searchMcpRegistry(p?.query ?? "");
  });

  /** A-918++：从官方 registry 安装 MCP（写 slime.toml） */
  handleTrusted<{ card: import("./config_files.js").RegistryServerCard }>("slime:mcpRegistryInstall", async (_event, p) => {
    const { installFromMcpRegistry } = await import("./config_files.js");
    return installFromMcpRegistry(p?.card);
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

  // ── 使用统计（Settings「使用统计」面板） ────────────────
  handleTrusted<{ sinceIso?: string; untilIso?: string; limit?: number }>("slime:usage:snapshot", async (_e, payload) => {
    // 本地时区偏移（分钟；东八区=+480）—— 仅 Date.getTimezoneOffset 的反向
    const tzOffsetMin = -new Date().getTimezoneOffset();
    const records = await loadUsage({
      sinceIso: payload?.sinceIso,
      untilIso: payload?.untilIso,
      limit: payload?.limit ?? 5000,
    });
    /*
     * A-990-B：把"用户手选的计价币种"与账目一起下发（见 UsageSnapshot.modelCurrencies 注释）。
     * 只收集**用户真的手选过**的条目；未手选的留空，渲染层会按模型归属地推断。
     * 键用 `供应商key::模型id`：同一个模型 id 在不同中转站可能是两笔不同的账
     * （价格/币种都可能不同），只按 model 归并会让两行显示成同一个币种。
     */
    const modelCurrencies: Record<string, string> = {};
    for (const p of listProviders()) {
      for (const mo of (p.models ?? [])) {
        if (mo.price_currency) { modelCurrencies[`${p.key}::${mo.id}`] = mo.price_currency; }
      }
    }
    return {
      records,
      tzOffsetMin,
      totalRecords: records.length,
      modelCurrencies,
    } as unknown as UsageSnapshot;
  });

  handleTrusted<void>("slime:usage:clear", async () => {
    await clearUsage();
    return { ok: true };
  });

  // 用**当前生效价格**重算历史成本：usage.jsonl 的 cost_usd 是写入时固化的，
  // 之前价格表全线失守导致 1606 条记录 100% 为 0；价格表修正后需要一次性回填。
  // 只把"0 → 有价"的记录改写（只增不减），免费模型（价目表显式 0）保持 0 不产生 diff。
  handleTrusted<void>("slime:usage:recompute", async () => {
    await ensureServices();
    const res = await rewriteUsageCosts(buildPriceResolver());
    return { ok: true, ...res } as UsageRecomputeResult;
  });

  // ── D/E：可观测 trace + Plan 一等对象 IPC ────────────────
  registerTraceHandlers();
  registerPlanHandlers();

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
      statsPoll = setInterval(() => {
        void (async () => {
          try {
            const svc = statsService;
            if (!svc) return; // ensureServices 尚未完成，本轮跳过（原 statsService! 非空断言会同步 TypeError）
            const snap = await svc.snapshot();
            mainWindow?.webContents.send("slime:stats:update", snap);
          } catch (e) {
            console.warn("[gui:main] statsPoll snapshot 失败（本轮跳过）:", e);
          }
        })();
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

  handleTrusted<{ name: string; role: string; toolProfile?: { mode: "default" | "custom"; skills: string[]; mcp: string[] } }>("slime:agents:create", async (_event, params) => {
    await ensureServices();
    const a = await createAgent(params.name, params.role, params.toolProfile);
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
      tool_profile: a.tool_profile as { mode: "default" | "custom"; skills: string[]; mcp: string[] } | undefined,
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

  handleTrusted<{ baseUrl: string; apiKey: string; api_format?: "openai" | "anthropic" | "responses" | "google" | "auto" }>("slime:providers:fetchModels", async (_event, p) =>
    // A-918+：探测即 enrich 填充元数据（context_window/max_output/vision/think/pricing），
    // 让「探测成功」一步到位，渲染层拿到完整 model spec 而非仅 ID。
    // api_format 穿透：用户显式指定 anthropic 时用 x-api-key 探测，auto 时双鉴权兜底。
    enrichModels(p.baseUrl, p.apiKey, p.api_format ?? "auto"),
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

  /** A-954：自研 SILAM 脑可用性（sidecar 拉起成功才 enabled）——群聊成员步进选择的供应商之一。
   *  必须先 await ensureServices()：silamBrain 在引擎启动时拉起，App 启动即探活会读到 null → false */
  handleTrusted<void>("slime:silam:status", async (): Promise<{ enabled: boolean }> => {
    await ensureServices();
    return { enabled: silamBrain?.enabled === true };
  });

  /** A-963 双向桥-后向：读取某 Agent 的 SILAM 情感/成长态（engine 侧 reply/observe 后缓存） */
  handleTrusted<{ agentId: string }>("slime:silam:state", async (_event, p): Promise<{
    fear?: number; desire?: number; n_nodes?: number; step?: number; langLoaded?: boolean;
  } | null> => {
    await ensureServices();
    const st = engine!.getSilamAffect(p.agentId);
    if (!st) { return null; }
    return { fear: st.fear, desire: st.desire, n_nodes: st.n_nodes, step: st.step, langLoaded: st.langLoaded };
  });

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

  /** A-980-R32：把「聊天/产物里点到的路径」解析成真实存在的绝对路径。
   *
   *  背景（用户实测）：思考历程与产物卡里点的**很多**文件都报「文件不存在」，但自己按同样路径去
   *  右侧栏翻却能打开。根因不是文件不在，而是**解析基准不对**：点击来源五花八门——
   *  工具回传的 path 可能是「相对会话工作目录」「相对项目根」「带项目名前缀」「带 `:行:列` 后缀」，
   *  甚至是设备内路径（adb 的 /sdcard/...）；而渲染层手里那个 workspace 可能还没加载完或压根没绑定。
   *  旧实现只试两种（workspace 相对 + 当绝对），于是大量明明存在的文件被判"不存在"。
   *
   *  这里把所有**合理候选**按优先级列出来逐个试，并且把试过的路径原样回给界面：
   *  找不到时用户/开发者看到的是"我按这些路径找过"，而不是一句黑箱错误。
   *  额外返回值 `isDir`：目录也是合法的点击目标（渲染层据此打开一个浏览该目录的文件页），
   *  而不是沿用 readFile 那套"是目录 → 报错"（这正是用户说的"文件夹也点不开"）。
   */
  handleTrusted<{ rel: string; root?: string; sessionId?: string }>(
    "slime:workspace:openTarget",
    async (_event, p): Promise<{ ok: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string }> => {
      const sessionWorkspace = p.sessionId
        ? (await getSession(p.sessionId).catch(() => null))?.workspace
        : null;
      // 候选生成是纯逻辑（可单测）：见 ./targetPath.ts
      const { candidates } = buildTargetCandidates(
        typeof p?.rel === "string" ? p.rel : "",
        { root: p.root, sessionWorkspace, projectRoot: PROJECT_ROOT },
        resolve, basename, dirname,
      );
      if (candidates.length === 0) {
        return { ok: false, error: `缺少文件路径（原始值："${typeof p?.rel === "string" ? p.rel : ""}"）`, tried: [] };
      }
      for (const c of candidates) {
        try {
          if (existsSync(c)) {
            return { ok: true, path: c, isDir: statSync(c).isDirectory(), tried: candidates };
          }
        } catch { /* 权限等异常跳到下一个候选 */ }
      }
      return {
        ok: false,
        error: `文件不存在：${normalizeTargetPath(typeof p?.rel === "string" ? p.rel : "")}`,
        tried: candidates,
      };
    },
  );

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
      // A-980-R8：PDF / Office（word/excel/ppt）专用 mime——pdf 由右侧栏内嵌预览，
      // office 右侧栏只读二进制（复杂格式不外挂解析库），交给系统默认应用打开。
      // 注意要在 ARCHIVE_BINARY_EXT 判定**之前**（.pdf 原在该集合里判 binary）。
      const OFFICE_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
      if (ext === ".pdf") {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "pdf", content: buf.toString("base64") };
      }
      if (OFFICE_EXT.has(ext)) {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "office", content: buf.toString("base64") };
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
      // A-980-R8：PDF / Office 专用 mime（与 readFile 同规，先于 ARCHIVE 判定）
      const OFFICE_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
      if (ext === ".pdf") {
        const buf = readFileSync(abs);
        return { ok: true, path: abs, name, mime: "pdf", content: buf.toString("base64") };
      }
      if (OFFICE_EXT.has(ext)) {
        const buf = readFileSync(abs);
        return { ok: true, path: abs, name, mime: "office", content: buf.toString("base64") };
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

  /** A-980-R8：用系统默认应用（关联程序）打开文件——word/pdf/ppt/excel 等右侧栏只读的格式 */
  handleTrusted<{ path: string }>("slime:shell:openPath", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim().replace(/^["']|["']$/g, "");
    if (!abs) { return { ok: false, error: "缺少文件路径" }; }
    if (!existsSync(abs)) { return { ok: false, error: `文件不存在：${abs}` }; }
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
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

  /** A-968：读取指定文件的变更 diff（红绿标注渲染；未跟踪文件整体视为新增；已删除文件输出纯删除） */
  handleTrusted<{ path?: string; file?: string }>("slime:git:diff", async (_event, p): Promise<GitDiffResult> => {
    try {
      const norm = gitPathOf(p?.path);
      if ("error" in norm) { return { ok: false, error: norm.error }; }
      const dir = norm.path;
      const relFile = (p?.file ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!relFile) { return { ok: false, error: "缺少文件路径" }; }
      const inside = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return { ok: false, error: "不是 Git 仓库" };
      }
      // ① 已跟踪文件：git diff HEAD -- <file>（工作区相对 HEAD 完整变更 = 暂存 + 未暂存）
      // 显式 --no-color：防用户全局 color.diff=always 把 ANSI 转义码带进解析
      const headOk = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], dir);
      const raw = headOk.code === 0
        ? await runGit(["diff", "--no-color", "HEAD", "--", relFile], dir)
        : await runGit(["diff", "--no-color", "--cached", "--", relFile], dir); // 无提交仓库：走暂存区
      let out = (raw.code === 0 ? raw.stdout : "") || "";
      const absFile = join(dir, ...relFile.split("/"));
      const fileExists = existsSync(absFile) && statSync(absFile).isFile();
      // ② 未跟踪文件（git diff 默认不出）：整体视为新增
      if (!out && fileExists) {
        const ls = await runGit(["ls-files", "--error-unmatch", "--", relFile], dir);
        if (ls.code !== 0) {
          const buf = readFileSync(absFile);
          if (binarySniff(buf)) {
            return { ok: true, files: [{ file: relFile, status: "untracked", additions: 0, deletions: 0, hunks: [] }] };
          }
          const lines = buf.toString("utf-8").split(/\r?\n/);
          if (lines.length > 0 && lines[lines.length - 1] === "") { lines.pop(); }
          return {
            ok: true,
            files: [{
              file: relFile,
              status: "untracked",
              additions: lines.length,
              deletions: 0,
              hunks: [{ header: `@@ -0,0 +1,${lines.length} @@（未跟踪 · 全部为新增）`, lines: lines.map((t) => ({ type: "add", text: t })) }],
            }],
          };
        }
      }
      if (!out) { return { ok: true, files: [] }; }
      // ③ 解析 unified diff：@@ 头 + +/-/空格 前缀行
      const parsed = parseUnifiedDiff(out);
      return {
        ok: true,
        files: [{ file: relFile, status: fileExists ? "modified" : "deleted", additions: parsed.additions, deletions: parsed.deletions, hunks: parsed.hunks }],
      };
    } catch (e) {
      console.error("[gui:main] git:diff crashed:", e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 主题切换：持久化 + 同步标题栏系统按钮 overlay 配色（配色表见上方 `titleBarColors`）
   *
   *  ⚠️ A-1018：overlay 的 `color` 必须等于标题栏的**实际合成色**，否则那三个系统按钮后面会出现
   *  一块明显的色块（用户原话："最小化/还原/关闭这三个按钮有个明显的色块背景，给我去了"）。
   *  ⚠️ A-1019：光在**切换时**纠正还不够 —— 窗口创建的那一刻就需要对（`titleBarOverlay` 的初值），
   *  否则 alpha 主题用户每次启动都会先闪一帧 beta 色的色块。故这里同时**持久化**，
   *  由窗口创建处 `titleBarColors(readPersistedTheme())` 读出。 */
  handleTrusted<{ theme: string }>("slime:theme:set", (_event, p) => {
    writePersistedTheme(p.theme);
    mainWindow?.setTitleBarOverlay({ ...titleBarColors(p.theme), height: 40 });
  });
  handleTrusted<void>("slime:settings:autostart:get", async (): Promise<{ ok: boolean; enabled: boolean }> => {
    try {
      // A-967：显式 path=execPath（部分形态 setLoginItemSettings 无 path 时生效对象与读取不一致）
      const s = app.getLoginItemSettings({ path: process.execPath });
      return { ok: true, enabled: s.openAtLogin };
    } catch (e) {
      console.warn("[gui:main] 读取开机自启失败:", e);
      return { ok: false, enabled: false };
    }
  });

  /** 开机自启：设置开关（设置 → 通用） */
  handleTrusted<{ enabled: boolean }>("slime:settings:autostart:set", async (_event, p): Promise<{ ok: boolean; enabled: boolean; error?: string }> => {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(p.enabled), path: process.execPath });
      const s = app.getLoginItemSettings({ path: process.execPath });
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

  /* ── A-980-R26：系统通知 + 可定制提示音（设置 → 通用） ── */

  /** 读取通知配置（含自定义音频是否存在——文件被用户删掉时界面要能提示） */
  handleTrusted<void>("slime:notify:get", async () => {
    const cfg = readNotifyConfig();
    const soundOk = cfg.soundFile ? Boolean(customSoundPath()) : false;
    return { ok: true, config: cfg, soundReady: soundOk };
  });

  /** 保存通知配置（局部合并：界面只传改动的字段） */
  handleTrusted<Partial<{ enabled: boolean; soundEnabled: boolean }>>("slime:notify:set", async (_event, patch) => {
    try {
      const cfg = writeNotifyConfig({
        ...(typeof patch?.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(typeof patch?.soundEnabled === "boolean" ? { soundEnabled: patch.soundEnabled } : {}),
      });
      return { ok: true, config: cfg, soundReady: cfg.soundFile ? Boolean(customSoundPath()) : false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 选择并导入自定义提示音（拷进应用配置目录；原文件之后删掉也不影响） */
  handleTrusted<void>("slime:notify:sound:pick", async () => {
    try {
      const soundOpts = {
        title: "选择提示音音频",
        properties: ["openFile"] as Array<"openFile">,
        filters: [{ name: "音频文件", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm", "opus"] }],
      };
      const r = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, soundOpts)
        : await dialog.showOpenDialog(soundOpts);
      if (r.canceled || !r.filePaths?.[0]) { return { ok: false, canceled: true }; }
      const res = importSound(r.filePaths[0]);
      return res.ok ? { ...res, config: readNotifyConfig() } : res;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 移除自定义提示音（回落系统默认音） */
  handleTrusted<void>("slime:notify:sound:clear", async () => {
    const res = clearSound();
    return res.ok ? { ...res, config: readNotifyConfig() } : res;
  });

  /** 读出自定义音频（data URL）——渲染层 new Audio() 播放/试听用 */
  handleTrusted<void>("slime:notify:sound:data", async () => readSoundData());

  /** 发送一条测试通知（无视总开关，便于用户确认系统层通不通） */
  handleTrusted<void>("slime:notify:test", async () => {
    notifyUser({
      kind: "test",
      // A-1021：标题是**事件文案**（见 notifyIdentity.ts 的分工说明）。
      // 用户要核对的「头部那行应用名」由 ensureNotificationIdentity() 注册的 DisplayName 决定，
      // 不是这个字段 —— 所以正文里把该看的地方点名说出来。
      title: "通知测试",
      body: "请核对通知**头部那行应用名**是不是本程序的名字（不是 com.slime.gui）；提示音按你的设置播放。",
    });
    return { ok: true, config: readNotifyConfig() };
  });

  // ── LLM 网关（设置 → LLM 网关） ────────────────
  handleTrusted<void>("slime:llmgw:get", async () => {
    const cfg = readLlmGatewayConfig();
    const mgr = getLlmGatewayManager();
    const st = mgr.status();
    return { ok: true, config: cfg, status: st };
  });

  handleTrusted<LlmGatewayConfig>("slime:llmgw:set", async (_event, cfg) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.apply({
        enabled: Boolean(cfg?.enabled),
        port: typeof cfg?.port === "number" && cfg.port > 0 && cfg.port < 65536 ? Math.floor(cfg.port) : 19110,
        apiKey: typeof cfg?.apiKey === "string" ? cfg.apiKey : "",
        tokens: cfg?.tokens ?? mgr.listTokens(),
      });
      return { ...r, status: mgr.status() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<void>("slime:llmgw:status", async () => {
    return getLlmGatewayManager().status();
  });

  handleTrusted<void>("slime:llmgw:restart", async () => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.start();
      return { ...r, status: mgr.status() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  // ── 令牌 CRUD（B 档：每令牌独立速率/日配额/模型白名单）────
  handleTrusted<import("./llmGateway.js").NewTokenInput>("slime:llmgw:token:add", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.addToken(input ?? {});
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<import("./llmGateway.js").UpdateTokenInput>("slime:llmgw:token:update", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.updateToken(input ?? { key: "" });
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<{ key: string }>("slime:llmgw:token:remove", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.removeToken(input?.key ?? "");
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
    }
  });

  handleTrusted<{ key: string; active: boolean }>("slime:llmgw:token:toggle", async (_event, input) => {
    try {
      const mgr = getLlmGatewayManager();
      const r = await mgr.toggleToken(input?.key ?? "", input?.active ?? false);
      return { ...r, status: mgr.status(), tokens: mgr.listTokens() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: getLlmGatewayManager().status() };
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

/** A-980：主进程协议安全白名单——非 Web 协议（bitbrowser://、mailto:…）一律拦截，
 *  防止 Chromium 把未知 scheme 交给系统协议分发触发 Windows「获取打开此链接的应用」弹窗。
 *  slime:// 仅主窗口使用，单独放行。 */
function isWebSafeUrl(url: string): boolean {
  try {
    if (!url) { return true; }
    if (url === "about:blank" || url.startsWith("slime://")) { return true; }
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    if (!m) { return true; } // 无 scheme（相对地址等）
    return ["http", "https", "about", "file", "data", "blob", "chrome"].includes(m[1].toLowerCase());
  } catch {
    return false;
  }
}

/** A-980-R3：**唯一的**打开外部链接通道——先探测系统是否注册了该协议处理器：
 *  已注册（装了对应客户端）→ `shell.openExternal` 交给系统应用**真正打开**；
 *  未注册 → 返回诊断（绝不 openExternal，避免 Windows「获取打开此链接的应用」系统框）。
 *  A-980-R4：浏览器类协议（bitbrowser:// 等）**永远返回失败**——即使系统注册了对应浏览器也
 *  不唤起：这类链接的目的是把另一款浏览器拉起来加载页面/云控指令，BitBrowser 收到
 *  `bitbrowser://cc` 这类指令自己打不开，会在界面顶部弹黄色横幅报错（用户痛批的丑弹窗）。
 *  所有外部打开（webview 深链转发 / slime:http:open IPC / iframe 深链）都必须走这里。 */
async function openExternalSafe(url: string): Promise<{ ok: boolean; handler?: string; reason?: string }> {
  if (isBrowserSchemeUrl(url)) {
    return { ok: false, reason: "browser-scheme" };
  }
  try {
    const info = await app.getApplicationInfoForProtocol(url);
    const handler = info && typeof info === "object" ? (info as { name?: string }).name : undefined;
    if (handler) {
      await shell.openExternal(url);
      return { ok: true, handler };
    }
  } catch { /* 探测失败按未注册处理 */ }
  return { ok: false, reason: "未注册" };
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
    // A-980：任意 webContents（含 <webview> 客页、授权子窗口）导航/重定向到**非 Web 协议**
    // （bitbrowser://、mailto: 等）一律 preventDefault——这是 renderer 层 will-navigate 守卫
    // 的**硬兜底**：renderer 脚本一旦漏拦，Chromium 会把未知 scheme 交给系统协议分发 → 
    // Windows 弹「获取打开此'xxx'链接的应用」。主进程兜底保证弹窗绝不可能出现。
    webContents.on("will-navigate", (e, url) => {
      // A-980-R12：slime://open?u=… 是渲染层"新建页跳转"桥（站点按钮 window.open/target=_blank 经
      // 注入钩子转入），**必须放行**给 renderer 的 will-navigate 守卫拦截并新建右栏页；此处 preventDefault
      // 会连 renderer 事件一起取消 → 新建页跳转再次失效（用户实测"还是无法新建浏览器页跳转"的根因之一）。
      if (url.startsWith("slime://open?u=")) { return; }
      if (!isWebSafeUrl(url)) {
        e.preventDefault();
        return;
      }
      // A-918++ 修复「GitHub 登录输入密码后无响应」：此前对所有 webContents 无条件 preventDefault，
      // 把 GitHub 授权窗口/内嵌 webview 的登录成功重定向也拦死了（停在原地看似无响应）。
      // 现在仅阻止【主窗口】导航到非 slime:// 的外部地址；webview / 授权子窗口放行。
      if (webContents === mainWindow?.webContents && !url.startsWith("slime://")) {
        e.preventDefault();
      }
    });
    // 服务端 302/301 跳转到未知协议同样拦截（will-navigate 不覆盖重定向目标）
    webContents.on("will-redirect", (e, url) => {
      if (!isWebSafeUrl(url)) {
        e.preventDefault();
      }
    });
    // A-980-R3：**frame 级**深链拦截——will-navigate/will-redirect 只覆盖顶层导航，站点的
    // "打开客户端"逻辑常放在 iframe 或脚本动态创建的链接内（子 frame 导航到外部协议不会触发
    // will-navigate → Chromium 直接交系统分发 → 未注册就弹系统框）。will-frame-navigate 覆盖
    // 任意 frame：非 Web 协议 preventDefault 后经 openExternalSafe 真实打开（确认是否装了客户端）。
    webContents.on("will-frame-navigate", (details) => {
      const url = details?.url ?? "";
      if (isWebSafeUrl(url)) { return; }
      try { details.preventDefault(); } catch { /* 忽略 */ }
      void openExternalSafe(url).then((r) => {
        if (!r.ok) {
          try {
            // 未注册 → 通知渲染层「需安装对应客户端」（banner），绝不让系统框出现
            mainWindow?.webContents.send("slime:browser:popup-notice", { url, ts: Date.now(), kind: "need-install", scheme: (url.split(":")[0] || "").toLowerCase() });
          } catch { /* 忽略 */ }
        }
      });
    });
    webContents.setWindowOpenHandler(({ url }) => {
      // A-980-R11：站点"新建页跳转"（window.open / target=_blank）不再静默失败——
      // webview 已加 allowpopups，guest 的开窗请求会到达本 handler。web URL 一律在
      // slime 右栏**新浏览器页**打开（send slime:sidebar:open → renderer 新建/复用 tab）；
      // 非 Web 协议保持拒绝 + 通知（renderer 协议确认框 / 缺应用诊断）。窗口本身**绝不
      // 真实创建**（return deny）——防站点弹系统新窗抢焦点、阻断 Agent 工具循环
      // （A-980-R 用户实测「中途弹出的登录弹窗，不关就得卡死」）。
      try {
        if (url.startsWith("slime://open?u=")) {
          // 旧注入钩子（slime://open 桥）的兼容分支：解析出真实网址再开页。
          // A-975-R3 起钩子已整体撤除，这里只作历史兜底保留。
          try {
            const u = new URL(url).searchParams.get("u");
            if (u && /^https?:\/\//i.test(u)) {
              mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url: u, name: "", from: "site" });
            }
          } catch { /* 忽略 */ }
          return { action: "deny" };
        }
        if (isWebSafeUrl(url)) {
          // ⚠️ A-975-R4：站点弹窗必须带 from:"site" —— 渲染层据此做**弹窗风暴限流**。
          // 站点广告会在计时器里连续 window.open，而右栏浏览器页是常驻挂载（webview 不卸载），
          // 每弹一个就多一个常驻重页面 → 内存暴涨、渲染进程卡死（用户实测"浏览器什么都点不动"）。
          mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url, name: "", from: "site" });
        } else {
          mainWindow?.webContents.send("slime:browser:popup-notice", { url, ts: Date.now(), kind: "need-install", scheme: (url.split(":")[0] || "").toLowerCase() });
        }
      } catch { /* 忽略 */ }
      return { action: "deny" };
    });
  });

  // A-980-R2：深度链接「真实打开」——拦截到 bitbrowser:// 等非 Web 协议时，**不再屏蔽**，
  // 而是先探测系统是否注册了该协议处理器：已注册（用户安装 BitBrowser 等客户端后自动注册）→
  // 调系统协议分发**真正打开链接**（弹窗报错消失、链接意图达成）；未注册 → 返回明确诊断
  // 「需要安装 xxx 客户端」，由渲染层提示用户，绝不弹系统对话框、绝不静默卡住。
  ipcMain.handle("slime:protocol:open", async (_ev, raw: unknown) => {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url) { return { ok: false, reason: "空链接" }; }
    const scheme = (url.split(":")[0] || "").toLowerCase();
    // Web 链接不走系统协议分发（应由浏览器页导航），防止被滥用为外部打开
    if (isWebSafeUrl(url)) { return { ok: false, reason: "web" }; }
    const r = await openExternalSafe(url); // A-980-R3：统一走「探测→已注册才打开」通道
    return r.ok ? { ok: true, url, scheme, handler: r.handler } : { ok: false, url, scheme, reason: r.reason ?? "未注册" };
  });
}

function main(): void {
  registerSchemePrivileges(); // 必须先于 app ready

  // A-918++：去掉 User-Agent 里的 Electron/slime 标识（伪装标准 Chrome），
  // 避免 GitHub 等站点检测到非标准浏览器而阻断登录/授权
  app.userAgentFallback = (app.userAgentFallback || "")
    .replace(/\sElectron\/[\d.]+/g, "")
    .replace(/\sslime\/[\d.]+/g, "")
    .trim();

  // V8 字节码缓存（VS Code 同款策略）：把首次编译的渲染层 bundle 结果落盘复用，
  // 跳过重复启动时的重新编译，明显缩短二次启动时间
  app.commandLine.appendSwitch("v8-cache-options", "code");

  // A-980-R：禁用 Chromium 的 ExternalProtocolDialog 特性——**系统级绝杀**：
  // 即便未来某条导航绕过全部 will-navigate/will-redirect 守卫抵达系统协议分发，
  // 未知协议（bitbrowser:// 等）也**不会再弹** Windows「获取打开此链接的应用」对话框
  // （无注册应用则静默失败不打扰）。与既有守卫构成双脚架：守卫在"导航到达 OS 层之前"
  // 拦掉，该开关保证"即使漏网到 OS 层也绝不弹窗"。
  app.commandLine.appendSwitch("disable-features", "ExternalProtocolDialog");

  // A-980-R4（修正 R3 反语义）：**不再显式设置 proxy-bypass-list 的 <-loopback>**。
  // 实测核验（Microsoft Docs + Chromium net/docs/proxy.md + 多源复证）：Chromium 自 Chrome 72 起
  // 对 loopback（127.0.0.1/8、localhost、[::1]、169.254/16）有**隐式绕过代理直连**规则，
  // 且该隐式规则无法被系统代理/PAC 覆盖；而 `<-loopback>` 的语义恰恰是**禁用这个隐式绕过、
  // 强制 loopback 走代理**（Dev Proxy 等工具用它来劫持 localhost）。上一版把它当"强制直连"是
  // 方向写反了——用户一旦开 Clash 全局代理，此行会把 127.0.0.1:8081 的请求强行丢进代理 → 白屏。
  // 正确做法 = 什么都不做（默认即直连）。若未来需显式兜底，应写普通条目 127.0.0.1;localhost，不要用尖括号语法。

  // A-980-R5（GPU 白屏根治）：**默认不再禁用 GPU**。实弹对照验证（同机 Electron 35 webview 加载
  // 127.0.0.1:8081）：disable-gpu + disable-gpu-sandbox 下 capturePage 返回 **0 字节、整窗无像素**
  // （webview 网络导航全部成功但内容完全不绘制 → 白屏无错误）；克 GPU 时页面正常绘制。
  // 此前"部分机器 GPU 崩溃 exit_code=-1"的规避本身在部分环境制造了持续白屏（含 Agent 打开
  // 本地 HTTP 服务"其他浏览器能开、slime 白屏"的经典症状）。改为默认启用 GPU，保留逃生门：
  // 环境变量 SLIME_DISABLE_GPU=1 时仍回退软渲染（仅个别崩溃机器需要）。
  if (process.env.SLIME_DISABLE_GPU === "1") {
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }

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

  // CDP 远程调试端口（仅开发环境开启，便于 agent-browser 自动化接入）。
  // 安全：以 app.isPackaged 判定——构建产物中 process.env.NODE_ENV 不做静态替换且运行时未设置，
  // 旧判定会让正式包默认开放 9222，本机任意进程可附到渲染层执行任意 JS、读取全部 IPC 流量。
  if (!app.isPackaged) {
    app.commandLine.appendSwitch("remote-debugging-port", "9222");
  }

  app.whenReady()
    .then(async () => {
      // 先建窗口立即出首屏，后端 sidecar 并行启动（渲染层启动加载面板展示进度）
      registerProtocolHandler();
      // A-980-R13：给 webview 独立 session（persist:slime-browser）注册 slime:// 处理器——
      // app 级 protocol.handle 对独立 partition **不生效**，用户实测 webview 导航 slime:// 仍弹
      // Windows「获取打开此'slime'链接的应用」。会话级注册后该导航由 Electron 接管（204 空响应），
      // 不再落到系统协议分发 → 系统弹窗根除；正常路径仍被 renderer will-navigate 拦截新建右栏页。
      try {
        session.fromPartition("persist:slime-browser").protocol.handle("slime", () => new Response(null, { status: 204 }));
      } catch { /* 忽略 */ }
      createWindow();
      // A-984：主进程卡死看门狗（用户实测过一次"界面点按钮没反应"，当时只能从
      // audit.jsonl 停止写入反推主进程被独占 —— 没有日志就无法归因，故补这个探针）
      startMainWatchdog();
      markMainActivity("app ready");
      // A-986：意外退出保底 —— 判定上次是否异常退出（run.lock 残留）+ 清掉残留临时文件 + 留证，
      // 然后写下本次的运行标记（强杀时它不会被删，下次启动即可据此判定）
      {
        const sweep = sweepAfterCrash();
        if (sweep.abnormalExit) {
          console.warn(`[gui:main] 检测到上次异常退出（清障：临时文件 ${sweep.removedTmp} 个）；详见 data/crash-report.log`);
        }
        markRunning(app.getVersion());
      }
      app.on("will-quit", () => { markCleanExit(); });
      // 本地模型生命周期管理器（llama-server：BGE 嵌入 / 对话 GGUF），解析自 slime.toml [model_server]
      initModelServerManager();
      /* A-1018：内嵌浏览器（右侧栏 <webview>，分区 persist:slime-browser）的广告/跟踪器拦截。
         装在该分区上而不是 defaultSession —— 只作用于我们的内嵌浏览器，不影响主进程自身的网络请求。
         默认开启；`config/adblock/settings.json` 里 `enabled:false` 可关；
         更多规则丢 `config/adblock/*.txt`（EasyList 派生的域名形态即可）。详见 adblock.ts 头注释。 */
      installAdBlocker(session.fromPartition("persist:slime-browser"), PROJECT_ROOT);
      registerIpcHandlers();
      registerUpdaterHandlers(); // 注册自动更新 IPC handler
      // 更新状态推送到渲染进程（StatusPanel 监听 slime:update:status）
      setStatusSink((s) => mainWindow?.webContents.send("slime:update:status", s));
      initUpdater();             // 延迟检查更新（不阻塞首屏）
      // 启动状态推送到渲染进程（启动加载面板 slime:boot:event）
      setBootSink((s) => mainWindow?.webContents.send("slime:boot:event", s));
      void startPythonBackend(); // 并行启动，不阻塞窗口
      // LLM 网关自动启动：配置 enabled 时随应用启动（auth token 未就绪则 fallback，网关端点用独立 key）
      void (async () => {
        try {
          const cfg = readLlmGatewayConfig();
          if (cfg.enabled) {
            const r = await getLlmGatewayManager().start();
            if (!r.ok) { console.warn("[gui:main] LLM 网关启动失败:", r.error); }
          }
        } catch (e) {
          console.warn("[gui:main] LLM 网关自动启动异常:", e);
        }
      })();
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

  // A-975：主进程兜底——渲染进程崩溃/主进程未知异常全部落盘（不退出、静默容错），
  // 便于用户把 data/logs/main-errors.log 里第一条 error 贴出来精确定位（DeepSeek 白屏调查闭环）。
  const logMainError = (tag: string, err: unknown): void => {
    try {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "main-errors.log"), `${new Date().toISOString()}\t[${tag}]\t${msg}\n`, { flag: "a" });
      console.error(`[gui:main] ${tag}:`, msg);
    } catch { /* 兜底失败的兜底 */ }
  };
  process.on("uncaughtException", (err) => { logMainError("uncaughtException", err); });
  process.on("unhandledRejection", (reason) => { logMainError("unhandledRejection", reason); });

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
    void getLlmGatewayManager().stop(); // 停止 LLM 网关，释放端口
    // A-918++：退出前清理所有 HTTP 静态服务，释放端口
    try { httpServer.stopAll(); } catch { /* 忽略清理异常 */ }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  });
}

void main();

// —— Python backend sidecar ——
let pythonBackend: ChildProcess | null = null;
const SLIME_PORT = process.env.SLIME_PORT || "19000";

/** A-965 core-ts↔server 通报：SILAM 情绪/成长态 → slime_server /agents/{id}/evolve 驱动人格演化。
 *  fire-and-forget：token 缺失 / 请求失败一律静默（server 未起、鉴权失败均不阻塞对话）。
 *  节流：同 agent 5 分钟内至多通报一次（与 engine persistSilamAffect 节流对齐）。 */
const silamEvolveThrottle = new Map<string, number>();
function notifySilamEvolve(agentId: string, state: SilamAffectState): void {
  void (async () => {
    try {
      const signals = buildSilamTraitSignals(state);
      if (signals.length === 0) {
        return;
      }
      const now = Date.now();
      if (now - (silamEvolveThrottle.get(agentId) ?? 0) < 5 * 60 * 1000) {
        return;
      }
      silamEvolveThrottle.set(agentId, now);
      let token: string | null = null;
      try {
        // 与 Python 同源：decryptRaw 内部经 ensurePassphrase 读 ~/.slime_pass 解密 auth_token.enc
        token = decryptRaw("config/auth_token.enc");
      } catch {
        token = null;
      }
      if (!token) {
        return; // 无认证 token（server 尚未生成 auth_token.enc）→ 静默跳过
      }
      const port = process.env.SLIME_PORT || "19000";
      const res = await fetch(
        `http://127.0.0.1:${port}/agents/${encodeURIComponent(agentId)}/evolve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ success: true, trait_signals: signals }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        console.warn(`[gui:silam-evolve] 通报失败 HTTP ${res.status}（agent=${agentId}）`);
      }
    } catch {
      /* 通报失败静默：不影响对话 */
    }
  })();
}

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

/** 安装根：**应用自身资源**（build/icon.png、data/、config/、Knowledge/） */
function resolveExtra(subpath: string): string {
  return join(INSTALL_ROOT, subpath);
}

/**
 * 随包资源根：`llama.cpp/`、`runtime/venv/`、`models/`、`slime_server.py`、`requirements.txt`。
 *
 * ⚠️ 与 `resolveExtra` 是**两个不同的根**，混用就是"运行环境怎么都检测不到"的根因：
 * 打包模式下两者相等（extraFiles 都落到安装根），但开发模式下随包依赖留在**项目根**
 * （prepare-runtime 的落点、也是 core-ts PROJECT_ROOT / mind_config / downloader 用的那个），
 * 而应用自身资源在 `gui/`。过去随包资源走 `resolveExtra` → 全部落在 `gui/…` → 齐报缺失。
 *
 * 判断"该用哪个"只看一件事：**这个文件是 electron-builder `extraFiles.from: "../…"` 搬来的吗**。
 * 是 → 本函数；`build/icon.png`、`data/`、`config/` 这类应用自身资源 → `resolveExtra`。
 */
function resolveBundled(subpath: string): string {
  return join(BUNDLE_ROOT, subpath);
}

async function startPythonBackend(): Promise<void> {
  emitBoot({ phase: "backend", backendReady: false, message: "正在启动本地后端服务…" });
  // 定位 Python venv（Windows: Scripts/python.exe，Linux/macOS: bin/python）
  const venvSub = process.platform === "win32" ? "Scripts" : "bin";
  const venvPyName = process.platform === "win32" ? "python.exe" : "python";
  const venvPython = resolveBundled(join("runtime", "venv", venvSub, venvPyName));

  const serverScript = resolveBundled("slime_server.py");
  if (!existsSync(venvPython) || !existsSync(serverScript)) {
    console.warn("[gui:backend] Python backend not found, running without server");
    emitBoot({ phase: "degraded", backendReady: false, message: "后端组件缺失，将以受限模式运行" });
    return;
  }

  const env: Record<string, string | undefined> = { ...process.env, SLIME_PORT };
  if (process.platform !== "win32") {
    // Linux/macOS：llama-server 动态库加载（随包布局：资源根/llama.cpp/build/bin）
    const libDir = resolveBundled(join("llama.cpp", "build", "bin"));
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
    }, {
      // A-1017：「正在加载本地模型」面板的唯一驱动源。
      // 此前是每条对话开始前由本文件预判"这次要加载吗"（另读一份 providers 表 + 裸路径比较）——
      // 与引擎实际加载的 model_path 一旦不一致就永久判否，于是模型已就绪也每轮弹一次全屏面板。
      // 现在只在管理器**真的**进入 loading 时才弹，进入 ready/idle 即刻收（不再等整轮回答结束）。
      onChatState: (ev) => {
        /* S4-D：状态一有迁移就作废能力缓存。
           为什么不能只靠 2s TTL：`probeManagedChatCapability()` 调 `getLocalCapability()`
           时**不传 alias**，于是缓存 key 只到端口 —— 而模型切换/重载**恰好发生在同一个端口上**。
           不清缓存，切换后最多 2s 内会拿**上一个模型**的 n_ctx 去回答，
           正是 A-1018 ③ 的形状（界面按旧模型显示窗口）。
           失效点放在这里而不是各个调用方：状态广播是"这个端口上发生了什么"的唯一真值来源。
           ⚠️ 必须在下面的窗口判空**之前** —— 无窗口时同样要作废。 */
        clearLocalCapabilityCache();
        const w = mainWindow;
        if (!w || w.isDestroyed()) { return; }
        if (ev.state === "loading") {
          w.webContents.send("slime:model:loading", {
            loading: true,
            message: `正在加载本地模型「${ev.modelName || basename(ev.modelPath)}」…首次加载可能需要数十秒`,
            key: lastChatCancelKey ?? undefined,
          });
          console.info(`[gui:main] 本地模型开始加载: ${ev.modelName} (${ev.modelPath})`);
        } else {
          w.webContents.send("slime:model:loading", { loading: false });
          if (ev.state === "ready") { console.info(`[gui:main] 本地模型已就绪: ${ev.modelName}`); }
          else if (ev.error) { console.warn(`[gui:main] 本地模型未就绪(${ev.state}): ${ev.modelName} — ${ev.error}`); }
        }
      },
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
