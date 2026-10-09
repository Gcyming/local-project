











import "./boot.js"; 
import { INSTALL_ROOT, BUNDLE_ROOT } from "./boot.js";
import {
  clearDataRootPointer, dataRootExists, defaultDataRoot, isCustomDataRoot,
  runtimeStateDir, writeDataRootPointer, RUNTIME_DATA_DIR,
} from "./dataRoot.js";

import { clearSubagentRuns, mergedSubagentRuns, syncSubagentRuns } from "./subagentStore.js";

import { startMainWatchdog, markMainActivity } from "./watchdog.js";

import { sweepAfterCrash, markRunning, markCleanExit } from "./crashGuard.js";

import {
  DEVTOOLS_PORT_ENV, DEVTOOLS_PORT_SCAN,
  listeningPortsSync, resolveDevtoolsPort, writeDevtoolsPortFile, parseDevToolsActivePort,
} from "./devtoolsPort.js";


let exitModeStore: "quit" | "background" = "quit";
let tray: Electron.Tray | null = null;
let appIsQuitting = false;
const exitModePath = () => join(app.getPath("userData"), "exit-mode.json");

















function permSwitches(p: GuiPermissions): GrantSwitches {
  return {
    toolRead: p.toolRead,
    toolWrite: p.toolWrite,
    toolTerminal: p.toolTerminal,
    screenEnabled: p.screenEnabled,
    mcpEnabled: p.mcpEnabled,
    skillsEnabled: p.skillsEnabled,
  };
}

function classifyPermissions(actions: Array<{ action: string; target: string }>): {
  hasBlocked: boolean;
  allAuto: boolean;
  reasons: string[];
} {
  let hasBlocked = false;
  let allAuto = true;
  const reasons: string[] = [];
  const registry = getRegistry();
  const sw = permSwitches(getPermissions());
  for (const a of actions) {
    const name = (a.action ?? "").toLowerCase();
    const target = (a.target ?? "").trim();
    const tool = registry.get(name);

    
    if (!tool) {
      allAuto = false;
      reasons.push(`${name}: 未注册工具，需用户确认（fail-closed）`);
      continue;
    }

    
    
    
    
    const r = classifyToolCall({
      name,
      permissions: tool.permissions,
      riskKind: tool.effectiveRiskKind(),
      autoApprovable: tool.autoApprovable,
      target,
      switches: sw,
    });

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
  try { writeFileSync(exitModePath(), mode, "utf8"); } catch {  }
};




const subagentModelsPath = () => join(app.getPath("userData"), "subagent-models.json");

const legacySubagentModelPath = () => join(app.getPath("userData"), "subagent-model.json");
let subagentDefaultModels: string[] = (() => {
  try {
    const raw = JSON.parse(readFileSync(subagentModelsPath(), "utf8")) as { models?: unknown };
    if (Array.isArray(raw?.models)) { return normalizeModelPool(raw.models); }
  } catch {  }
  try {
    return normalizeModelPool([readFileSync(legacySubagentModelPath(), "utf8")]);
  } catch { return []; }
})();
const saveSubagentDefaultModels = (models: unknown): void => {
  subagentDefaultModels = normalizeModelPool(models);
  try { writeFileSync(subagentModelsPath(), JSON.stringify({ models: subagentDefaultModels }), "utf8"); } catch {  }
};





















const normalizeSubagentModelValue = (raw: string): { ok: true; value: string } | { ok: false; error: string } => {
  const s = (raw ?? "").trim();
  const normalized = s && s.startsWith("api:") && !s.includes(":")
    ? (() => {
        const rest = s.slice(4);
        const dotIdx = rest.lastIndexOf(".");
        if (dotIdx > 0 && /[A-Za-z0-9_.\-\u4e00-\u9fa5]+$/.test(rest)) {
          return `api:${rest.slice(0, dotIdx)}:${rest.slice(dotIdx + 1)}`;
        }
        return s;
      })()
    : s;
  if (!/^(api:[A-Za-z0-9_.\-\u4e00-\u9fa5]+(:[^\s:]+)?|local:[A-Za-z0-9_.\-\u4e00-\u9fa5]+|inherit|)$/.test(normalized)) {
    return {
      ok: false,
      error: `非法模型格式：${raw}\n\n正确格式示例：\n  api:供应商名:模型名（如 api:openai:gpt-5）\n  api:供应商名（用该供应商默认模型）\n  api:小红书:dots3-note-prev（中文 key + 模型名）\n  local:本地模型名\n  inherit（沿用父 Agent 模型）\n  留空（不设置）`,
    };
  }
  return { ok: true, value: normalized };
};




const applySubagentModels = (models: unknown): void => {
  saveSubagentDefaultModels(models);                      
  subagentsRef?.setDefaultModels(subagentDefaultModels);  
  mainWindow?.webContents.send("slime:resident:update", null);
};




const setSubagentModels = (models: unknown): { ok: true; defaultModels: string[] } | { ok: false; error: string } => {
  const list = Array.isArray(models) ? models : [];
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    const r = normalizeSubagentModelValue(typeof item === "string" ? item : "");
    if (!r.ok) { return { ok: false, error: `第 ${i + 1} 项：${r.error}` }; }
    
    if (r.value && r.value !== "inherit") { out.push(r.value); }
  }
  applySubagentModels(out);
  return { ok: true, defaultModels: [...subagentDefaultModels] };
};




const setSubagentDefaultModel = (model: unknown): { ok: true; defaultModel: string; defaultModels: string[] } | { ok: false; error: string } => {
  const r = normalizeSubagentModelValue(typeof model === "string" ? model : "");
  if (!r.ok) { return { ok: false, error: r.error }; }
  applySubagentModels(r.value ? [r.value] : []);
  return { ok: true, defaultModel: r.value, defaultModels: [...subagentDefaultModels] };
};








const syncTrayTooltip = (): void => {
  try {
    const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
    tray?.setToolTip(visible ? "Slime — 运行中" : "Slime — 已最小化到托盘（点击恢复）");
  } catch {  }
};


const toggleMainWindow = (): void => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) { return; }
  try {
    if (w.isVisible() && !w.isMinimized() && w.isFocused()) { w.hide(); }
    else {
      if (w.isMinimized()) { w.restore(); }
      w.show();
      w.focus();
    }
  } catch {  }
  syncTrayTooltip();
};


















const resolveAppIcon = (): string => {
  const preferred = join(INSTALL_ROOT, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
  try {
    if (!nativeImage.createFromPath(preferred).isEmpty()) { return preferred; }
  } catch {  }
  const fallback = join(INSTALL_ROOT, "build", "icon.png");
  console.warn(`[gui:main] 应用图标 ${preferred} 读不出来，回落 ${fallback}`);
  return fallback;
};














const resolveAppIconImage = (): Electron.NativeImage | undefined => {
  const p = resolveAppIcon();
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) { return img; }
  } catch {  }
  console.warn(`[gui:main] 窗口图标 nativeImage 解码失败（${p}），交由 Electron 兜底`);
  return undefined;
};










const ensureTray = (): void => {
  if (tray) { return; }
  try {
    const iconPath = resolveAppIcon();
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip("Slime — 运行中");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示 / 隐藏主界面", click: toggleMainWindow },
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
    tray.on("click", toggleMainWindow);
    syncTrayTooltip();
  } catch (e) {
    tray = null;
    console.warn("[gui:main] 托盘图标创建失败（不影响主流程）:", e instanceof Error ? e.message : String(e));
  }
};
import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, session, shell, Tray, Menu, nativeImage } from "electron";
import { join, resolve, sep, dirname, basename, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync, watch, cpSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";


import { spawn, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { productUserAgent } from "../../../core-ts/src/product.js";

import { classifyFile, isNavigableLocalFile, nonNavigableReason } from "../../../core-ts/src/office/fileKinds.js";



import { extractDocText, extractOleText, docKindFromExt, oleKindFromExt } from "../../../core-ts/src/doc_text.js";
import { writeDocument, type DocFormat } from "../../../core-ts/src/office/docWrite.js";


import { previewHtmlPath } from "../../../core-ts/src/previewPage.js";


import { writeRenderPage, writePdfViewerPage, pdfViewerPaths } from "./docRenderPage.js";
import { planRender, fallbackRender } from "../../../core-ts/src/office/renderPlan.js";


import { convertToPdf, cleanupConvertDir, probeLibreOffice } from "./libreofficeConvert.js";
import { installAdBlocker } from "./adblock.js";
import { basePortFor, getModelServer, ModelServerManager, setModelServer } from "../../../core-ts/src/model_server.js";


import { capabilityMatchesModel, clearLocalCapabilityCache, getLocalCapability, isLoopbackBaseUrl, probeManagedChatCapability } from "./localServerProbe.js";
import { resolveWindowCap } from "../../../core-ts/src/model_introspect.js";
import { ChatService } from "../../../core-ts/src/services/chat.js";
import { resolveRunnerKind, runnerLabel } from "../../../core-ts/src/services/chatRunner.js";
import { buildStageMessage, clipCarry, stageProgressText } from "../../../core-ts/src/services/stageRunner.js";
import { validateModeTools } from "../../../core-ts/src/plugin/mode.js";
import { setGitReviewCallback, buildReviewDetail, type GitReviewRequest } from "../../../core-ts/src/tools/git.js";
import { SchedulerService } from "../../../core-ts/src/services/scheduler.js";
import { SubAgentManager, DEFAULT_EXEC_BUDGET_MS, normalizeModelPool, sanitizeSubagentRunName } from "../../../core-ts/src/services/subagent.js";
import { buildSharedSpecBlock } from "../../../core-ts/src/services/subagent_batch.js";
import {
  dispatchableAgentIds,
  dispatchableSubagentDefinitions,
  groupSubagentCatalog,
  isSubagentDispatchAllowed,
  renderSubagentCatalogLines,
  renderSubagentModelSegments,
} from "../../../core-ts/src/services/subagentCatalog.js";
import { setSubagentManager, setMemoryStoreProvider, setAdbService, setHttpServer, setScreenController, setTrashService, setPluginCatalog } from "../../../core-ts/src/tools/builtin.js";

import { setSidebarOpener, normalizeSidebarOpenRequest } from "../../../core-ts/src/sidebarOpen.js";

import { setSidebarMount } from "../../../core-ts/src/sidebarMount.js";

import { SUBAGENT_SESSION_PREFIX } from "../../../core-ts/src/services/subagent.js";
import { setBrowserAdapter } from "../../../core-ts/src/tools/browser.js";
import { BrowserBridge } from "./browserBridge.js";
import { StreamChunkBatcher } from "./streamBatch.js";
import { adbService, type AdbDetect, type AdbDevice, type AdbCmdResult, type AdbScreencapResult, type AdbDownloadProgress } from "./adb.js";
import { annotateBitmap } from "../shared/imageAnnotate.js";

import { groupParticipantIds } from "../../../shared/gen/groupRoster.js";
import { httpServer } from "./httpServer.js";



import { registerSearchBridge, pushSearchTheme, ensureSearchPage } from "./searchBridge.js";

import { registerSearchIndexIpc, startSearchIndexService } from "./searchIndexService.js";

import { searchThemeOf } from "../shared/searchTheme.js";
import { createServer } from "node:http";
import { ServerA2ABus } from "../../../core-ts/src/a2a.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";

import { readTodos, removeTodos, writeTodos, todosToPlanStatus, demoteStaleInProgress } from "../../../core-ts/src/services/todoStore.js";

import { shouldClearTodosOnTurnEnd } from "../../../core-ts/src/services/todoLifecycle.js";


import {
  buildAgentProcView,
  planAgentProcStop,
  type AgentProcSources,
} from "../../../core-ts/src/services/agentProcs.js";


import { pushSteer, clearSteers, dropSteer } from "../../../core-ts/src/services/steerBus.js";
import { loadUsage, clearUsage, rewriteUsageCosts } from "../../../core-ts/src/services/usage.js";
import { getLlmGatewayManager, readLlmGatewayConfig, type LlmGatewayConfig } from "./llmGateway.js";




import { getTermProfiles } from "./termProfiles.js";
import { resolveProfile, pickDefaultProfile, shellInvocation, resolveCd, type TermProfile, type TermProfileKind, type ShellInvocation } from "../../../core-ts/src/terminal/profiles.js";
import { decodeBytes } from "../../../core-ts/src/text/encoding.js";


import { killProcessTree } from "../../../core-ts/src/procKill.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine, buildSilamTraitSignals } from "../../../core-ts/src/services/engine.js";
import { createRouteClient, type RouteEntry } from "../../../core-ts/src/router.js";
import { chromiumFetch } from "./providers.js";
import { AskCoordinator, DEFAULT_ASK_TIMEOUT_MS, releaseAsksOnAbort } from "./askCoordinator.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, UsageSnapshot, UsageRecomputeResult, SidecarStatus, PermissionDecision, PermissionRequestUI, PermissionOption, AskUserRequestUI, AskUserDecision, WorkspaceEntry, WorkspaceListResult, WorkspaceReadFileResult, TermResult, GitDetect, GitInfo, GitAction, GitCloneResult, GitDiffResult, CompressResult, ResidentState, AgentProcsListResult, AgentProcsStopRequest, AgentProcsStopResult, TermProfilesResult } from "../shared/ipc.js";
import { isBrowserSchemeUrl, IPC_CHANNELS } from "../shared/ipc.js";
import { parseUnifiedDiff } from "./git_diff.js";
import { initUpdater, registerUpdaterHandlers, setStatusSink } from "./updater.js";
import {
  listProviders, enrichModels, saveProvider, removeProvider, clearAllProviders, refreshProviderModels,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
  buildPriceResolver,
  type ProviderSummary, type LocalModelSpec,
} from "./providers.js";
import { overview as configOverview, readConfigFile, writeConfigFile, setMcpEnabled, setSkillEnabled, deleteSkill, deleteMcp, skillDirPath } from "./config_files.js";

import { initNotify, notifyUser, readNotifyConfig, writeNotifyConfig, importSound, clearSound, readSoundData, customSoundPath } from "./notify.js";



import { readFallbackPool, writeFallbackPool } from "../../../core-ts/src/services/fallbackPool.js";


import { APP_AUMID } from "./notifyIdentity.js";
import { getPermissions, setPermissions, type GuiPermissions } from "./permissions.js";
import { SlimeEngine } from "../../../core-ts/src/services/engine.js";
import { SilamBrainClient, readSilamConfig, type SilamBrain, type SilamAffectState } from "../../../core-ts/src/services/silam_brain.js";
import { decryptRaw } from "../../../core-ts/src/encryption.js";
import { removeAgentHistory, loadHistory, appendHistory, attachTimelineToRecord, type HistoryRecord } from "../../../core-ts/src/services/history.js";
import { SkillRegistry, loadAllSkills, getSkillRegistry } from "../../../core-ts/src/skills.js";
import { PluginHost } from "../../../core-ts/src/plugin/host.js";
import { BUILTIN_PLUGIN_GROUPS, builtinPluginManifests } from "../../../core-ts/src/plugin/builtin-plugins.js";
import { loadPluginsFromDisk, pluginSkillsRoot } from "../../../core-ts/src/plugin/loader.js";
import type { RejectedPluginDir } from "../../../core-ts/src/plugin/loader.js";
import { markPluginDisabled, readDisabledPlugins, unmarkPluginDisabled } from "../../../core-ts/src/plugin/disabled-store.js";
import type { PluginUiContribution } from "../../../core-ts/src/plugin/contributes.js";
import type { PluginThemeDecl } from "../../../core-ts/src/plugin/contributes.js";
import { readPluginTrust, writePluginTrust } from "../../../core-ts/src/plugin/trust.js";
import { SettingsService } from "../../../core-ts/src/plugin/settings-service.js";
import { SKILL_ENTRY_TOOL_NAMES, agentSkillGuide, resolveAgentToolProfile, selfAwarenessGuide } from "../../../core-ts/src/services/agentTools.js";
import type { PluginRejectedDTO, PluginSettingsDTO, PluginSettingsWriteDTO, PluginSnapshotDTO, PluginSummaryDTO, PluginThemeDTO, PluginUiSlotDTO, PluginUiSnapshotDTO } from "../shared/ipc.js";
import { getKnowledgeEngine } from "../../../core-ts/src/memory/knowledge.js";
import { getRegistry, setToolCategoryGate, Tool } from "../../../core-ts/src/tools/registry.js";
import type { GrantSwitches } from "../../../core-ts/src/tools/grant.js";
import { targetFromArgs } from "../../../core-ts/src/tools/hard_rules.js";
import { gateToolCall, classifyToolCall } from "../../../core-ts/src/tools/policy.js";
import {
  getScreenController,
  DesktopScreenBackend,
  AndroidScreenBackend,
  setImageOptimizer,
  setImageDiffer,
} from "../../../core-ts/src/screen/index.js";
import { MemoryStore, resolveMemoryPaths, setLancedbModuleLoader } from "../../../core-ts/src/memory/store.js";
import { requireLancedb, lancedbComponentStatus, type LancedbComponentStatus } from "./__stubs/lancedb-stub.js";









setLancedbModuleLoader(async () => requireLancedb() as { connect: (uri: string) => Promise<unknown> });
import { createTrace, beginSpan, endSpan, emitEvent, attachEval, type Trace, type TraceEventKind } from "../../../core-ts/src/observability/trace.js";
import { parsePlan, type Plan, type PlanStageStatus } from "../../../core-ts/src/planning/plan.js";
import { runGroupTalk, parseMentions, type GroupTalkParticipant, type StreamEmit, type TranscriptLine } from "../../../core-ts/src/services/grouptalk.js";



process.on("unhandledRejection", (reason) => {
  console.error("[gui:main] 未捕获的 Promise rejection（已拦截，主进程继续运行）:", reason);
});








const traceStore = new Map<string, Trace>();
const TRACE_STORE_MAX = 60;
const TRACE_STORE_TTL_MS = 30 * 60 * 1000;
function traceStoreSet(key: string, trace: Trace): void {
  
  traceStore.delete(key);
  traceStore.set(key, trace);
  while (traceStore.size > TRACE_STORE_MAX) {
    const oldest = traceStore.keys().next();
    if (oldest.done) { break; }
    traceStore.delete(oldest.value);
  }
}

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

const TRACE_SAMPLE_CAP = 40;
function capStr(s: string, n: number): string {
  return typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s;
}


class TraceRecorder {
  private trace: Trace;
  private counts = new Map<string, number>();
  constructor(sessionId?: string) {
    const t = createTrace({ sessionId });
    this.trace = beginSpan(t, { name: "turn:start", kind: "route_select" }).trace;
  }
  
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
  
  finish(ok: boolean, notes?: string): Trace {
    this.trace = attachEval(this.trace, "completion", ok, ok ? undefined : capStr(notes ?? "", 200));
    return emitEvent(this.trace, "done", "turn:done");
  }
  get(): Trace { return this.trace; }
}


function registerTraceHandlers(): void {
  ipcMain.handle("slime:trace:get", (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== "string") { return null; }
    const t = traceStoreGet(sessionId);
    return t ? { sessionId, ...t } : null;
  });
}



const planStore = new Map<string, Plan>();

const PLAN_STORE_MAX = 64;
const PLAN_TOOLS = new Set(["plan_create", "plan_update", "todo_write"]);








let subagentsRef: SubAgentManager | null = null;


function subagentCatalogSegment(): string[] {
  const cat = subagentsRef?.catalog?.() ?? [];
  if (cat.length === 0) { return []; }
  
  
  
  const lines = [
    "## 可用子代理（delegate_subagent）",
    "你可以把**独立、自包含**的子任务交给下列子代理并行执行（各自独立上下文与工具面，产出会作为工具结果交回给你验收）：",
    ...renderSubagentCatalogLines(groupSubagentCatalog(cat)),
  ];
  lines.push('用法：`delegate_subagent({ agent: "<上面的名字>", task: "目标 + 期望输出格式 + 边界" })`；不点名则由系统按任务语义自动选。');
  lines.push("派发后**必须验收**产出：对照目标核对是否真的完成、产物是否落地；存疑就点名同一子代理追问，或自己补齐——不要把子代理的结论不加核对地当事实转述给用户。");
  
  
  return [lines.join("\n"), ...renderSubagentModelSegments(subagentsRef?.getDefaultModels?.() ?? subagentDefaultModels)];
}
















function syncDispatchableSubagents(mgr: SubAgentManager | null = subagentsRef): boolean {
  if (!mgr) {
    
    console.warn("[subagent] 管理器尚未装配，本次「可派发清单」刷新被跳过（装配时会统一登记一次）");
    return false;
  }
  const defs = dispatchableSubagentDefinitions(agentRegistry?.loadedAgents ?? []);
  mgr.setUserSelected(defs);
  if (defs.length > 0) {
    console.log(`[subagent] 已登记 ${defs.length} 个可派发 Agent 子代理：${defs.map((d) => d.name).join("、")}`);
  } else {
    console.log("[subagent] 当前没有被授权派发的自建 Agent（均已在 Agent 设置里关闭）—— 仅内置专家可用");
  }
  return true;
}



function purgeSessionPlanning(sessionId: string): void {
  if (!sessionId) { return; }
  planStore.delete(sessionId);
  removeTodos(sessionId);
}










function planFromToolResult(name: string, result: string, sessionId: string): Plan | null {
  if (name === "plan_create" || name === "plan_update") {
    const idx = result.indexOf("\n"); 
    const json = idx >= 0 ? result.slice(idx + 1) : result;
    const p = parsePlan(json);
    return p ? { ...p, source: "plan" } : null;
  }
  if (name === "todo_write" && sessionId) {
    const items = readTodos(sessionId); 
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


function putPlan(sessionId: string, plan: Plan): void {
  planStore.set(sessionId, plan);
  if (planStore.size <= PLAN_STORE_MAX) { return; }
  const sorted = [...planStore.entries()].sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
  for (const [sid] of sorted.slice(0, planStore.size - PLAN_STORE_MAX)) { planStore.delete(sid); }
}











function broadcastTodos(sessionId: string): void {
  if (!sessionId) { return; }
  const todos = readTodos(sessionId).map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
  }));
  mainWindow?.webContents.send("slime:tasks:todos", { sessionId, todos });
  
  scheduleTodoAutoClear(sessionId, todos);
}














const TODO_AUTO_CLEAR_MS = 1500;
const todoAutoClearTimers = new Map<string, ReturnType<typeof setTimeout>>();







const staleChecked = new Set<string>();


function allTodosCompleted(todos: Array<{ status?: string }>): boolean {
  return todos.length > 0 && todos.every((t) => t.status === "completed");
}

function scheduleTodoAutoClear(sessionId: string, todos: Array<{ status?: string }>): void {
  const pending = todoAutoClearTimers.get(sessionId);
  if (!allTodosCompleted(todos)) {
    
    if (pending) { clearTimeout(pending); todoAutoClearTimers.delete(sessionId); }
    return;
  }
  if (pending) { clearTimeout(pending); }
  const timer = setTimeout(() => {
    todoAutoClearTimers.delete(sessionId);
    removeTodos(sessionId);
    
    broadcastTodos(sessionId);
  }, TODO_AUTO_CLEAR_MS);
  todoAutoClearTimers.set(sessionId, timer);
}

















function clearTodosOnTurnEnd(sessionId: string | undefined): void {
  if (!sessionId) { return; }
  if (readTodos(sessionId).length === 0) { return; }
  removeTodos(sessionId);
  
  broadcastTodos(sessionId);
}








function interceptPlanTool(ev: { type: string; data?: unknown }, sessionId: string): void {
  if (ev.type !== "tool" || !sessionId) { return; }
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const name = String(d.name ?? "");
  if (!PLAN_TOOLS.has(name)) { return; }
  
  
  if (name === "todo_write") { broadcastTodos(sessionId); }
  const result = String(d.result ?? "");
  const plan = planFromToolResult(name, result, sessionId);
  if (!plan) { return; }
  const prev = planStore.get(sessionId);
  if (plan.source === "todo" && prev?.source === "plan") {
    
    return;
  }
  putPlan(sessionId, plan);
  mainWindow?.webContents.send("slime:plan:update", { sessionId, plan });
}


function registerPlanHandlers(): void {
  ipcMain.handle("slime:plan:get", (_e, sessionId: string) => {
    if (!sessionId || typeof sessionId !== "string") { return null; }
    return planStore.get(sessionId) ?? null;
  });
}






function makeThinkingStripper(onText: (s: string) => void, onThink: (s: string) => void): { push: (chunk: string) => void; finish: () => void } {
  const OPEN = /<thinking(?:\s[^>]*)?>/i;
  const CLOSE = /<\/thinking\s*>/i;
  const OPEN_PREFIX = "<thinking";
  const CLOSE_PREFIX = "</thinking";
  
  const isPrefixOf = (full: string) => (s: string): boolean => {
    const up = s.toLowerCase();
    return !up.includes(">") && up.length > 0 && up.length <= full.length && full.startsWith(up);
  };
  const isOpenPfx = isPrefixOf(OPEN_PREFIX);
  const isClosePfx = isPrefixOf(CLOSE_PREFIX);
  
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
  
  const estTok = (s: string): number => Math.round(((s ?? "").length || 0) * 0.6);
  const usage = new Map<string, { used: number; cap: number }>();
  const QUOTA = 0.8; 
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
  
  
  const compressTranscript = (memberId: string, transcript: TranscriptLine[]): TranscriptLine[] | undefined => {
    const u = quotaOf(memberId);
    if (u.used < u.cap * QUOTA) { return undefined; }
    const packed = transcript.map((l, i) => (i === 0 ? l : { ...l, content: l.content.slice(0, 60) + "…" }));
    const packedTokens = estTok(transcript.map((l) => l.content).join("\n"));
    if (u.used > packedTokens) { usage.set(memberId, { used: packedTokens, cap: u.cap }); }
    return packed;
  };
  
  const toParticipant = (agent: AgentState): GroupTalkParticipant => {
    
    
    const thinking = { ...agent, reasoning_effort: agent.reasoning_effort || "high" };
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      speakStream: async (prompt: string, e: StreamEmit): Promise<string> => {
        let rep = "";
        noteUsage(agent, prompt); 
        const quota = quotaOf(agent.id);
        broadcastStatus({ memberId: agent.id, name: agent.name, state: "thinking", used: quota.used, cap: quota.cap });
        
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
            /* A-1198：群聊成员也是 Agent —— 发言提示同样带能力自述（与主对话**同一产地**，
               不另写一份文案）。这里用 selfAwarenessGuide（机制与边界）而不是 agentSkillGuide：
               本发言位的工具面只有联网工具，带「白名单清单」反而失真。 */
            systemPrompt: `${agent.identity_prompt || `你是 ${agent.name}，你的角色是：${agent.role}`}\n\n输出规范：正文只输出你的观点（≤200 字、一段、直接可读），严禁在正文中出现 <thinking> 标签、思考过程、草稿、自我检查或任何元叙述；思考只能作为你的内部过程。如需最新信息可调用 web_search / web_fetch（仅联网工具），并注明来源。\n\n硬性输出约束：必须直接围绕议题输出有信息量的实质内容；严禁输出「我在听/请说得更明确/你想问什么/先给个目标/我正在衡量」这类空泛确认、反问式等待或仅自我介绍（身份声明最多一句话前缀，正文须立即进入实质回答）；若议题看似不完整，按最可能的意图直接作答并顺带询问唯一的待确认点。` + selfAwarenessGuide(resolveAgentToolProfile(agent.tool_profile)),
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
  void broadcastStatus; 
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
      
      
      
      
      if (isSpeechFailure(full)) { emitMember(m, { speechEnd: true, failed: true }); }
    },
    onDone: () => {  },
  }).then((r) => ({ r })).catch((e: unknown) => {
    runErr = e instanceof Error ? e : new Error(String(e));
    return null;
  });
  
  while (!flowDone) {
    while (memberEvents.length > 0) { yield memberEvents.shift()!; }
    const done = await Promise.race([flow.then(() => true as const), new Promise<false>((r) => setTimeout(() => r(false as const), 30))]);
    flowDone = done;
  }
  while (memberEvents.length > 0) { yield memberEvents.shift()!; }
  if (runErr) { throw runErr; }
  const res = (await flow)!;
  
  
  
  
  
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
import { loadMindConfig, saveMindConfig, readDepStatus, detectLocalDeps, updateTomlKey, readModelServerConfig, type VectorTool } from "./mind_config.js";
import {
  startDownload, controlDownload, downloadSnapshot, setDownloadListener, setBgeReadyCallback, tryRelocateDownloads,
  type DownloadTarget, type DownloadProgress,
} from "./downloader.js";
import {
  listSessions, getSession, createSession, renameSession, removeSession,
  ensureDefaultSession, setSessionMembers, setSessionType, setSessionMode, removeSessionsForAgent, removeSessionsForWorkspace,
  setSessionAgent, setSessionWorkspace, setSessionSummary, touchSessionWithMessage, SESSIONS_PATH,
  memberIdsOf, memberModelsOf, memberEffortsOf, setSessionMemberEffort, type MemberEntry,
  
  setSessionModelChoice, effectiveModelChoice,
} from "../../../core-ts/src/services/sessions.js";
import { loadHistoryForSession, loadHistoryForSessionBefore, clearSessionHistory, clearLegacySessionHistory } from "../../../core-ts/src/services/history.js";
import { formatSpeakerBlob, isSpeechFailure, expandHistoryRecord, type ExpandedMessage } from "../../../core-ts/src/services/grouptalkTranscript.js";
import { needsCompress, estimateHistoryTokens, DEFAULT_TAIL_KEEP, DEFAULT_COMPRESS_RATIO, SUMMARIZE_INPUT_CAP, HISTORY_LOAD_LIMIT, buildCompactedHistory, truncateTurnAligned, gateCompaction, commitCompactionIfShrunk } from "../../../core-ts/src/services/context_compress.js";
import { acceptSummary, countTurns, formatCannotFit, formatRescueHint, pickRescueModel, INITIAL_BREAKER, isRealShrink, nextBreakerState, planSend, validateHistory, type BreakerState, type CapCandidate, type LoopMessage, type RescuableModel } from "../../../core-ts/src/services/context_loop.js";
import { SandboxManager, defaultSandboxConfig, type SandboxConfig } from "../../../core-ts/src/sandbox.js";

import { buildTargetCandidates, normalizeTargetPath } from "./targetPath.js";

import { singleFlight } from "./singleFlight.js";

let mainWindow: BrowserWindow | null = null;
let chatService: ChatService | null = null;
let a2aBus: ServerA2ABus | null = null;
let statsService: StatsService | null = null;
let agentRegistry: AgentRegistry | null = null;
let engine: SlimeEngine | null = null;

let silamBrain: SilamBrain | null = null;

/** A-1197 · B3（L4c 阶段机）：**纯用户定义的阶段流** —— main 侧执行器（薄壳）。
 *
 * 每阶段 = 构造消息（目标 + 上阶段收束 + 本阶段 prompt；**history 置空 = 阶段间裁剪**）
 * → 复用 `chatService.stream` 跑（`stageOverride` 带阶段级 toolsOnly/maxRounds；signal 透传）
 * → 收束文本作为下一阶段的「上一阶段结论」（只留最终文本，不保留完整工具输出）。
 *
 * ⚠️ 一个安全环节都不省：沙箱 / 硬规则 / 工具去重 / 预算 / abort 竞跑全在既有链路里照旧；
 *    本函数只换「跑什么」（阶段清单 + 每阶段白名单/上限），不碰「怎么判权限」。
 * ⚠️ 边界（设计兜底表）：abort ⇒ 后续阶段不再开始；插件离线 ⇒ 收束本回合并如实说明
 *    （**下一回合** `resolveRunnerKind` 会自然回落 agent-loop —— 不静默换模式）。 */
async function* streamStageFlow(opts: {
  chatService: ChatService;
  agentId: string;
  goal: string;
  stages: Array<import("../../../core-ts/src/plugin/mode.js").StageDecl>;
  modeTitle: string;
  signal?: AbortSignal;
  sessionId?: string;
  modelChoice?: string;
  networkEnabled?: boolean;
  /** 每阶段开始前的在线检查（插件仍 loaded？）——不传 = 不检查。 */
  canContinue?: () => boolean;
  /** 每阶段开始前的**工具表重查**（A-1197 · B3 第二层其二）——返回该 Agent 当前可用的
   *  工具名；查不到就跳过该阶段并如实说明（不静默）。返回 undefined = 判不了（不阻断）。 */
  availableTools?: () => Promise<string[] | undefined>;
}): AsyncGenerator<{ seq: number; type: string; data: Record<string, unknown> }> {
  let seq = 0;
  let carried = "";
  const total = opts.stages.length;
  let skipped = 0;
  const stopNote = "用户已停止：后续阶段不再执行。";
  for (let i = 0; i < total; i++) {
    const stage = opts.stages[i];
    if (opts.signal?.aborted) {
      yield { seq: ++seq, type: "notice", data: { text: stopNote } };
      return;
    }
    if (opts.canContinue && !opts.canContinue()) {
      yield { seq: ++seq, type: "notice", data: { text: `「${opts.modeTitle}」所属扩展已停用 —— 本回合在此收束（下一条消息将回落到默认模式）。` } };
      return;
    }
    /* A-1197 · B3（L4c）第二层其二：**运行前（每阶段开始时）重查工具表** ——
       查不到 ⇒ 该阶段不执行并如实写进对话（设计兜底表：不静默跳阶段）。
       重查本身失败（拿不到表）⇒ 出声但不阻断（既有链路继续，绝不假装查过）。 */
    if (stage.tools && stage.tools.length > 0 && opts.availableTools) {
      const available = await opts.availableTools().catch((e) => {
        console.warn(`[gui:stage] 阶段工具表重查失败（本阶段照常执行，但存在静默缺工具风险）: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      if (available) {
        const missing = stage.tools.filter((t) => !available.includes(t));
        if (missing.length > 0) {
          skipped += 1;
          yield { seq: ++seq, type: "notice", data: { text: `⚠️ 阶段「${stage.title ?? stage.id}」因工具不可用被跳过：${missing.join("、")} 不在当前工具表（去「设置 → 权限」开启对应工具、检查 MCP 连接 / 扩展页的脚本信任，或关掉本扩展）。**该阶段未执行。**` } };
          continue;
        }
      }
    }
    yield { seq: ++seq, type: "notice", data: { text: stageProgressText(stage.title ?? stage.id, i + 1, total) } };

    const message = buildStageMessage({ goal: opts.goal, carried, stage, index: i + 1, total });
    let stageText = "";
    let doneReply = "";
    const req: ChatRequest = {
      message,
      history: [],                                   // ← 阶段间裁剪的另一半：不带完整会话历史
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.modelChoice ? { modelChoice: opts.modelChoice } : {}),
      ...(opts.networkEnabled !== undefined ? { networkEnabled: opts.networkEnabled } : {}),
      stageOverride: {
        ...(stage.tools && stage.tools.length > 0 ? { toolsOnly: [...stage.tools] } : {}),
        ...(stage.maxRounds ? { maxRounds: stage.maxRounds } : {}),
      },
      /* A-1026 守卫口径：引擎请求必须带 windowCap（不然上下文压缩的保险门永远放行）。
         与主 stream 路径同款：由 resolveSessionWindowCap 的唯一决策函数定。 */
      windowCap: await resolveSessionWindowCap(opts.agentId, opts.modelChoice ?? "").catch(() => undefined),
    };
    for await (const ev of opts.chatService.stream(opts.agentId, req, 0, opts.signal)) {
      yield { seq: ++seq, type: ev.type, data: (ev.data ?? {}) as Record<string, unknown> };
      if (ev.type === "chunk") {
        const c = (ev.data as { content?: string } | undefined)?.content;
        if (typeof c === "string") { stageText += c; }
      } else if (ev.type === "done") {
        const r = (ev.data as { reply?: string } | undefined)?.reply;
        if (typeof r === "string" && r) { doneReply = r; }
      }
    }
    carried = clipCarry(doneReply || stageText);
    if (opts.signal?.aborted) {
      yield { seq: ++seq, type: "notice", data: { text: stopNote } };
      return;
    }
  }
  if (skipped === 0) {
    yield { seq: ++seq, type: "notice", data: { text: `✅ 全部 ${total} 个阶段已完成（「${opts.modeTitle}」）。` } };
  } else {
    /* 有阶段被跳过 ⇒ 收束语必须如实 —— 不许把「跳过 K 步」说成「全部完成」。 */
    yield { seq: ++seq, type: "notice", data: { text: `⚠️ 阶段流结束（「${opts.modeTitle}」）：${total - skipped}/${total} 步已执行，${skipped} 步因工具不可用被跳过（见上文逐条）。` } };
  }
}

const activeChats = new Map<string, AbortController>();

const agentStreamSessionMap = new Map<string, string>();



let lastChatCancelKey: string | null = null;
let sandbox: SandboxManager | null = null;

const pendingPerms = new Map<string, (decision: PermissionDecision) => void>();












const PERM_TIMEOUT_MS = 300_000;

const ASK_TIMEOUT_MS = DEFAULT_ASK_TIMEOUT_MS;

const ASK_RELEASE_MARKER = "[slime:ask-release]";

const askCoordinator = new AskCoordinator({ timeoutMs: ASK_TIMEOUT_MS });
let statsPoll: NodeJS.Timeout | null = null;

let selectedAgentId: string | null = null;

/* ── A-1198 · git_commit 的「差异评审」通道（D1 第二闸）─────────────────────────
   git_commit 每次提交前把 diff stat + 关键片段送进**权限弹窗**（复用 pendingPerms +
   slime:perm:request/resolve 基建，无第二套弹窗）；用户点头才落 commit。
   两条不可绕的边界，与权限审批同口径：
     · 后台子代理（__subagent__: 会话）无人可交互 ⇒ 一律拒绝（不静默放行）；
     · 无窗口 / 渲染层不可用 ⇒ 拒绝。
   评审详情的拼装在 core 侧（buildReviewDetail，单一产地）。 */
function requestGitReview(req: GitReviewRequest): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      resolve({ approved: false, reason: "无窗口（无法展示差异评审）" });
      return;
    }
    const sid = agentStreamSessionMap.get(req.agentId);
    if (typeof sid === "string" && sid.startsWith(SUBAGENT_SESSION_PREFIX)) {
      resolve({
        approved: false,
        reason: "后台子代理无人可交互确认 —— commit 差异评审不适用（请在主对话里发起提交）",
      });
      return;
    }
    const requestId = `gitr_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const ui: PermissionRequestUI = {
      requestId,
      agentId: req.agentId,
      agentName: req.agentName,
      taskDescription:
        `git commit 差异评审（D1 门禁）\n${req.title}\n`
        + `分支 ${req.branch} · ${req.stats.files} 个文件 / +-${req.stats.lines} 行 · 门禁：${req.qaSummary}`
        + (req.protectedModules.length > 0 ? "\n⚠️ 包含受保护模块（AGENTS.md §6）—— 需要你的显式批准。" : ""),
      detail: buildReviewDetail(req),
      actions: [{ action: "git_commit", target: `${req.branch} @ ${req.repoRoot}`, level: 3 }],
      options: [
        { id: "allow-once", label: "批准提交", hint: "按上方 diff 落 commit（author=Agent 身份；产物停在当前分支，**不会合并**——合并永远是你的动作）。" },
        { id: "deny", label: "拒绝本次提交", hint: "不落任何 commit，拒绝原因会带回给 Agent。" },
      ],
      sessionId: sid,
    };
    const timer = setTimeout(() => {
      if (pendingPerms.delete(requestId)) {
        try { win.webContents.send("slime:perm:timeout", { requestId }); } catch { /* 窗口可能已销毁 */ }
        resolve({ approved: false, reason: "差异评审超时（用户未决策）" });
      }
    }, PERM_TIMEOUT_MS);
    pendingPerms.set(requestId, (d) => {
      clearTimeout(timer);
      resolve({ approved: d.approved === true, ...(d.reason ? { reason: d.reason } : {}) });
    });
    try {
      win.webContents.send("slime:perm:request", ui);
    } catch {
      clearTimeout(timer);
      pendingPerms.delete(requestId);
      resolve({ approved: false, reason: "渲染层不可用" });
    }
  });
}

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


const REGISTERED_CHANNELS = new Set<string>();

















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



















const TERM_TIMEOUT_MS = 30_000;
const TERM_MAX_BYTES = 8 * 1024 * 1024;


function termSpawnError(file: string, profileId: string, e: unknown): TermResult {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    stdout: "",
    stderr: "",
    code: null,
    profileId,
    
    error: `无法启动 ${file}：${msg}。该终端配置可能已被卸载或路径已变，请把终端标签栏切换到其它 shell。`,
  };
}













function resolveTermCwd(
  proposed: string | undefined,
  kind: TermProfileKind,
): { dir?: string; rejected?: string } {
  const p = (proposed ?? "").trim();
  if (!p) { return {}; }
  if (kind === "wsl") { return { dir: p }; }
  try {
    const dir = resolve(p);
    if (statSync(dir).isDirectory()) { return { dir }; }
    return { rejected: `工作目录 ${dir} 不存在或不是目录，本条命令已改用默认目录` };
  } catch {
    return { rejected: `工作目录 ${p} 不可用，本条命令已改用默认目录` };
  }
}


function pushTermNotice(res: TermResult, note: string): void {
  res.notice = res.notice ? `${res.notice}；${note}` : note;
}











function nextTermCwd(cmd: string, cwd: string | undefined, kind: TermProfileKind): string | undefined {
  const r = resolveCd(cmd, cwd, kind, homedir());
  if (!r) { return cwd; }
  if (kind === "wsl") { return r.next; }
  try { return statSync(r.next).isDirectory() ? r.next : cwd; } catch { return cwd; }
}

function runShellCommand(inv: ShellInvocation, prof: TermProfile, spawnCwd: string | undefined): Promise<TermResult> {
  const profileId = prof.id;
  return new Promise((resolveResult) => {
    let child: ChildProcess;
    try {
      child = spawn(inv.file, inv.args, {
        


        cwd: prof.kind === "wsl" ? undefined : spawnCwd,
        windowsHide: true,
        
        env: { ...process.env, SLIME_TERM: "1" },
      });
    } catch (e) {
      resolveResult(termSpawnError(inv.file, profileId, e));
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let spawnErr: Error | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let fallbackTimer: NodeJS.Timeout | null = null;

    

    const collect = (isOut: boolean, buf: Buffer): void => {
      const used = isOut ? outLen : errLen;
      if (used >= TERM_MAX_BYTES) { truncated = true; return; }
      const room = TERM_MAX_BYTES - used;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      if (buf.length > room) { truncated = true; }
      (isOut ? outChunks : errChunks).push(slice);
      if (isOut) { outLen += slice.length; } else { errLen += slice.length; }
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      if (fallbackTimer) { clearTimeout(fallbackTimer); }

      
      if (spawnErr && outLen === 0 && errLen === 0) {
        resolveResult(termSpawnError(inv.file, profileId, spawnErr));
        return;
      }

      const so = decodeBytes(Buffer.concat(outChunks));
      const se = decodeBytes(Buffer.concat(errChunks));
      

      const encoding = so.encoding === "utf-8" ? se.encoding : so.encoding;
      const looseEncoding = so.loose || se.loose;

      const notes: string[] = [];
      if (timedOut) { notes.push(`命令超过 ${TERM_TIMEOUT_MS / 1000} 秒未结束，已终止进程树`); }
      if (truncated) { notes.push(`输出超过 ${TERM_MAX_BYTES / 1024 / 1024} MB，已截断`); }
      if (looseEncoding) { notes.push(`输出编码未能确认，已按 ${encoding} 兜底解码`); }
      if (spawnErr) { notes.push(`进程异常：${spawnErr.message}`); }
      else if (signal && !timedOut) { notes.push(`进程被信号 ${signal} 终止`); }

      resolveResult({
        ok: !timedOut && !spawnErr && code === 0,
        stdout: so.text,
        stderr: se.text,
        code,
        encoding,
        looseEncoding,
        profileId,
        notice: notes.length > 0 ? notes.join("、") : undefined,
      });
    };

    child.stdout?.on("data", (b: Buffer) => collect(true, b));
    child.stderr?.on("data", (b: Buffer) => collect(false, b));
    child.on("error", (e: Error) => { spawnErr = e; });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

    timer = setTimeout(() => {
      timedOut = true;
      
      killProcessTree(child.pid, { onDone: () => { try { child.kill(); } catch {  } } });
      

      fallbackTimer = setTimeout(() => finish(null, "SIGKILL"), 3000);
    }, TERM_TIMEOUT_MS);
  });
}


function normalizeInputPath(p?: string): string {
  if (!p) { return ""; }
  return p.trim().replace(/^['"\s]+|['"\s]+$/g, "").trim();
}


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

















async function refreshAgentSkills(): Promise<void> {
  try {
    const extraDirs: string[] = [];
    for (const a of agentRegistry?.loadedAgents ?? []) {
      try {
        extraDirs.push(getKnowledgeEngine(a.id).generatedSkillsDir);
      } catch {  }
    }
    const loaded = await loadAllSkills({ registry: getRegistry(), extraDirs });
    console.info(`[gui:skills] 技能工具已就绪，可见技能 ${loaded.length} 个（额外扫描根 ${extraDirs.length} 个）`);
  } catch (e) {
    console.warn("[gui:skills] 技能加载失败（不影响对话，但 Agent 将无法检索技能）:", e);
  }
}





// P3：插件宿主。三类来源：系统默认（代码内置）、Agent 自建、外部载入（磁盘扫描 config/plugins）。
// builtin 由 host 内建语义保证不可卸载；磁盘清单里的 origin=builtin 由 loader 直接拒绝。
// skills 的实际装配仍走上面的 refreshAgentSkills —— 这里只登记清单与贡献，不重复装配。
// 登记什么、怎么撤销，全部由下面注入的钩子决定：host 本身不知道任何具体工具名。
const PLUGINS_ROOT = join(PROJECT_ROOT, "config", "plugins");
/* A-1198：官方示例扩展名（随包 `template/plugins/<name>` 播种/一键安装的落点 —— 名字单一产地）。 */
const EXAMPLE_PLUGIN_NAME = "hello-slime";
/* A-1196：插件禁用名单（持久化）—— 扩展页拨片开关「关」的记录。
   重扫/重启后按名单把对应插件装载后立即卸载（记录在、贡献撤），开关保持「关」。 */
const PLUGINS_DISABLED_FILE = join(PROJECT_ROOT, "config", "plugins-disabled.json");

interface PluginHostState {
  host: PluginHost;
  /** 插件名 → 来源目录绝对路径（builtin 为空串，它不在磁盘上） */
  dirs: Map<string, string>;
  /** fail-closed 拒绝的目录清单：随每次 list/reload 一并回传，不静默吞掉 */
  rejected: RejectedPluginDir[];
  warnings: string[];
}

/**
 * 插件名 → 该插件当前生效的技能来源句柄（loadFromSource 的返回物）的在途 Promise。
 *
 * A-1195 起 host.load 会在重建前先 await 撤销上一轮全部 scope（核心层兜底，不再依赖本层），
 * 本 Map 收窄为「句柄登记簿」：dispose 闭包借它找到当前句柄并按来源精确撤销。previous 的
 * stale 兜底仍然保留 —— 幂等，且覆盖「旧 scope 撤销失败后的残余」。
 */
const pluginSkillSourceHandles = new Map<string, Promise<{ name: string; dispose: () => void }>>();

/* ── A-1197 · B2（L4a UI 贡献点）：运行期槽位登记表 ──────────────────────────
 * 真源仍是**清单**（`PluginRecord.manifest.contributes.ui`）；本表只装「已接线」插件的声明：
 * activate 时 registerUi 写入、dispose 时按插件名精确移除（与 pluginSkillSourceHandles 同模式）。
 * 被卸载/被禁用/rejected 的插件不在表里 ⇒ `plugins_ui` 自然回不出它们的槽位（不留幽灵）。 */
const pluginUiDecls = new Map<string, PluginUiContribution[]>();

/** A-1198 · 主题贡献点（皮肤）：已接线的主题声明（`plugins_ui` 快照的 themes 数据源）。
 *  纯数据表 —— activate 时写入、dispose 时按插件名移除；渲染层按 `plugins_changed` 重算。 */
const pluginThemeDecls = new Map<string, PluginThemeDecl>();

/** 汇总各插件已接线的 UI 声明（`plugins_ui` handler 的唯一数据源）。
 *  冲突裁决（设计 §4.1）：同 slot 同 id 时按 order（缺省 0）再按插件名排序取第一个，
 *  其余标 `conflict: true` —— **不静默丢弃、不静默覆盖**。 */
function pluginUiSnapshot(): PluginUiSnapshotDTO {
  const rows: PluginUiSlotDTO[] = [];
  for (const [plugin, decls] of pluginUiDecls) {
    for (const d of decls) {
      rows.push({
        slot: d.slot,
        plugin,
        id: d.id,
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.label !== undefined ? { label: d.label } : {}),
        ...(d.icon !== undefined ? { icon: d.icon } : {}),
        ...(d.order !== undefined ? { order: d.order } : {}),
        ...(d.refresh !== undefined ? { refresh: d.refresh } : {}),
        ...(d.when !== undefined ? { when: d.when } : {}),
      });
    }
  }
  const byKey = new Map<string, PluginUiSlotDTO[]>();
  for (const r of rows) {
    const key = `${r.slot}\u0000${r.id}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const out: PluginUiSlotDTO[] = [];
  for (const list of byKey.values()) {
    if (list.length <= 1) { out.push(...list); continue; }
    const sorted = [...list].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
        || (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0),
    );
    sorted.forEach((r, i) => { out.push(i === 0 ? r : { ...r, conflict: true }); });
  }
  const slotRank = new Map<string, number>([["settings_panel", 0], ["status_item", 1], ["chat_action", 2]]);
  out.sort((a, b) =>
    (slotRank.get(a.slot) ?? 99) - (slotRank.get(b.slot) ?? 99)
    || (a.order ?? 0) - (b.order ?? 0)
    || (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /* A-1198 · 主题（皮肤）：按插件名排序保证快照稳定（渲染层按 plugin 名持久化选择）。 */
  const themes: PluginThemeDTO[] = [...pluginThemeDecls.entries()]
    .map(([plugin, theme]) => ({ plugin, name: theme.name, tokens: theme.tokens }))
    .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  return { slots: out, themes, warnings: [] };
}

/* ── A-1197 · B4（T1 脚本信任）：扩展脚本的执行边界（设计 §5.1）──────────────
 * 一次性子进程：cwd = 该插件目录、不注入任何宿主对象、只以 stdout 返回结果、
 * 显式 timeout、输出上限。这是本平台唯一能安全跑扩展代码的形态。 */
const PLUGIN_SCRIPT_TIMEOUT_MS = 30_000;
const PLUGIN_SCRIPT_OUTPUT_CAP = 256 * 1024;

interface PluginScriptRun { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string; }

/** 脚本工具的注册名：`plugin__<插件>__<脚本>`（跨插件不撞名；连字符转下划线以匹配 LLM 工具名规则）。 */
function pluginScriptToolName(plugin: string, script: string): string {
  return `plugin__${plugin.replace(/-/g, "_")}__${script.replace(/-/g, "_")}`;
}

function execPluginScript(entryAbs: string, cwd: string, input: string): Promise<PluginScriptRun> {
  return new Promise((resolve) => {
    let timedOut = false;
    let out = "";
    let err = "";
    let settled = false;
    let child: ChildProcess;
    const finish = (code: number | null, error?: string): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut, ...(error ? { error } : {}) });
    };
    try {
      child = spawn(process.execPath, [entryAbs], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 进程可能已退出 */ }
    }, PLUGIN_SCRIPT_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => { if (out.length < PLUGIN_SCRIPT_OUTPUT_CAP) { out += d.toString("utf8"); } });
    child.stderr?.on("data", (d: Buffer) => { if (err.length < PLUGIN_SCRIPT_OUTPUT_CAP) { err += d.toString("utf8"); } });
    child.on("error", (e: Error) => finish(null, e.message));
    child.on("close", (code: number | null) => finish(code));
    child.stdin?.end(input);
  });
}

function createPluginHost(dirs: Map<string, string>): PluginHost {
  const toolReg = getRegistry();
  return new PluginHost({
    // 工具贡献：本宿主不由 host 代为登记任何内置工具，故无句柄可给（如实留空）。
    registerTools: () => [],
    /* A-1197 · B3（L4c）第二层其一：**装载时查一次** mode 声明的工具名。
       工具表为空（引擎尚未装配 / 拿不到注册表）⇒ 返回空 = 「判不了」而不是「不存在」，
       不得据此拒绝装载（加载顺序不是清单错误）；运行前每阶段重查是另一半兜底。 */
    checkModeTools: (manifest) => {
      if (!manifest.mode) {
        return [];
      }
      const names = new Set(toolReg.listToolNames());
      if (names.size === 0) {
        return [];
      }
      return validateModeTools(manifest.mode, (n) => names.has(n));
    },
    // 指令贡献：磁盘来源的插件按「插件自己的 skills 根」装配，撤销句柄就是
    // loadFromSource 的按名精确撤销（宿主撤它 ⇒ 只摘该插件本次真正新增的技能名）。
    registerInstructions: (manifest) => {
      const skillReg = getSkillRegistry();
      // builtin 没有磁盘来源目录：它的技能装配在系统来源根（skillDir / Agent 额外目录）上，
      // 而系统来源根对按来源卸载一律 fail-closed（SkillRegistry.unloadBySource 的 isSystemRoot）。
      // 所以 builtin 走与旧接线同一条路：只登记技能入口工具名，绝不参与技能撤销。
      if (manifest.origin === "builtin") {
        return [
          {
            label: `${SKILL_ENTRY_TOOL_NAMES.join("/")}（builtin：技能经由 SkillRegistry 登记，不参与按来源撤销）`,
            dispose: () => {
              for (const n of SKILL_ENTRY_TOOL_NAMES) {
                toolReg.unregister(n);
              }
            },
          },
        ];
      }
      const dir = dirs.get(manifest.name);
      if (!dir) {
        // 磁盘扫描没给出目录 ⇒ 如实不登记（host 会记「尚未接线」），不猜来源。
        return [];
      }
      const sourceRoot = pluginSkillsRoot(dir);
      const previous = pluginSkillSourceHandles.get(manifest.name);
      const pending = (previous ? previous.catch(() => null) : Promise.resolve(null)).then((stale) => {
        stale?.dispose();
        return skillReg.loadFromSource(sourceRoot, manifest.name);
      });
      pluginSkillSourceHandles.set(manifest.name, pending);
      // 装配失败留到撤销时再上报，避免在无人撤销时变成未处理的 rejection。
      pending.catch(() => {});
      return [
        {
          label: `${manifest.name} 的技能（按来源装配与撤销：${sourceRoot}）`,
          dispose: async () => {
            const handle = await pending;
            handle.dispose();
            if (pluginSkillSourceHandles.get(manifest.name) === pending) {
              pluginSkillSourceHandles.delete(manifest.name);
            }
          },
        },
      ];
    },
    // UI 槽位贡献（B2）：登记声明进运行期表；撤销 = 按插件名精确移除
    // （renderer 侧按 `plugins_changed` 全量重算自然摘除；「get === ui」守卫防重装时误删新表）。
    registerUi: (manifest) => {
      const ui = manifest.contributes?.ui;
      if (!ui || ui.length === 0) {
        return [];
      }
      pluginUiDecls.set(manifest.name, ui);
      return [
        {
          label: `${manifest.name} 的 UI 槽位（${ui.length} 条）`,
          dispose: () => {
            if (pluginUiDecls.get(manifest.name) === ui) {
              pluginUiDecls.delete(manifest.name);
            }
          },
        },
      ];
    },
    // 脚本贡献（B4/T1）：**只有**用户在扩展页信任过（trust.json）才装配；
    // 未声明/无目录/未信任 ⇒ 返回空（host 如实记「尚未接线」，不假装已生效）。
    // 关信任 ⇒ 重装（reload）→ 旧 handle 撤销 ⇒ 工具立即注销（走 ContributionScope）。
    registerScripts: (manifest) => {
      const decl = manifest.contributes?.scripts;
      if (!decl || decl.length === 0) {
        return [];
      }
      const dir = dirs.get(manifest.name);
      if (!dir) {
        return [];
      }
      if (!readPluginTrust(dir)) {
        return [];
      }
      const toolReg = getRegistry();
      const mounted: string[] = [];
      for (const s of decl) {
        const toolName = pluginScriptToolName(manifest.name, s.name);
        const entryAbs = join(dir, s.entry.replace(/\\/g, "/"));
        toolReg.register(new Tool({
          name: toolName,
          description: `[扩展：${manifest.name}] ${s.description ?? s.name} —— 由本扩展脚本执行（一次性子进程；cwd 限定在插件目录、${PLUGIN_SCRIPT_TIMEOUT_MS / 1000}s 超时）。`,
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "传给脚本的输入（作为 stdin 的 JSON.prompt）" } },
            required: [],
          },
          executeFn: async (args: Record<string, unknown>): Promise<string> => {
            const prompt = typeof args.input === "string" ? args.input : "";
            const r = await execPluginScript(entryAbs, dir, JSON.stringify({ prompt }));
            if (r.error) { return `[错误] 扩展脚本启动失败：${r.error}`; }
            if (r.timedOut) { return `[错误] 扩展脚本超时（>${PLUGIN_SCRIPT_TIMEOUT_MS / 1000}s 已终止）：${s.entry}`; }
            if (r.code !== 0) { return `[错误] 扩展脚本退出码 ${r.code}：${s.entry}\n${r.stderr.slice(0, 2000)}`; }
            return r.stdout.trim() || "（脚本无输出）";
          },
          permissions: ["terminal"],
        }), true);
        mounted.push(toolName);
      }
      return [
        {
          label: `${manifest.name} 的脚本工具（${mounted.join("/")}）`,
          dispose: () => {
            for (const n of mounted) {
              toolReg.unregister(n);
            }
          },
        },
      ];
    },
    /* A-1197 · B5（L4a page）：扩展自有页面 —— 服务**按需**起（plugins_page_open 时
       serve 插件目录），dispose 负责按目录精确 stop（防「page 的 http 服务泄漏」，
       见设计 §4.1 兜底表；stop 失败如实 console.error，不静默）。 */
    registerPage: (manifest) => {
      const page = manifest.contributes?.page;
      if (!page) {
        return [];
      }
      const dir = dirs.get(manifest.name);
      if (!dir) {
        return [];
      }
      return [
        {
          label: `${manifest.name} 的页面（${page.kind}:${page.entry}）`,
          dispose: async () => {
            try {
              const list = await httpServer.list();
              for (const e of list) {
                if (resolve(e.dir) === resolve(dir)) {
                  const r = await httpServer.stop(e.id);
                  if (!r.ok) {
                    console.error(`[gui:plugins] 插件页面服务 stop 失败（${manifest.name} / ${e.id}）：${r.error ?? "未知原因"}`);
                  }
                }
              }
            } catch (e) {
              console.error(`[gui:plugins] 插件页面服务清理异常（${manifest.name}）：${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
      ];
    },
    /* A-1198 · 主题贡献点（皮肤）：纯数据登记 —— 进 `pluginThemeDecls` 表（`plugins_ui` 快照的
       themes 数据源）；撤销 = 按插件名精确移除（渲染层按 `plugins_changed` 重算并回落默认皮肤，
       满足「可开可关、卸下即恢复」。「get === theme」守卫防重装时误删新表）。 */
    registerTheme: (manifest) => {
      const theme = manifest.contributes?.theme;
      if (!theme) {
        return [];
      }
      pluginThemeDecls.set(manifest.name, theme);
      return [
        {
          label: `${manifest.name} 的皮肤（${theme.name}）`,
          dispose: () => {
            if (pluginThemeDecls.get(manifest.name) === theme) {
              pluginThemeDecls.delete(manifest.name);
            }
          },
        },
      ];
    },
  });
}

async function scanAndLoadInto(host: PluginHost, dirs: Map<string, string>): Promise<Pick<PluginHostState, "rejected" | "warnings">> {
  const disk = await loadPluginsFromDisk(PLUGINS_ROOT);
  dirs.clear();
  for (const loaded of disk.manifests) {
    dirs.set(loaded.manifest.name, loaded.dir);
  }
  // builtin 排在最前：它是地基，后装插件的 requires 才有解析对象。
  const manifests = [...builtinPluginManifests(), ...disk.manifests.map((m) => m.manifest)];
  const records = await host.load(manifests);
  // A-1196：按持久化禁用名单关闭（装载→立即卸载：记录保留供扩展页展示开关、贡献全部撤销）。
  let disabledByStore = 0;
  for (const name of readDisabledPlugins(PLUGINS_DISABLED_FILE)) {
    const rec = host.get(name);
    if (rec?.unloadable && rec.status === "loaded") {
      await host.unload(name);
      disabledByStore += 1;
    }
  }
  const failed = records.filter((r) => r.status === "failed").length;
  const unloadable = records.filter((r) => r.unloadable).length;
  const fromDisk = records.filter((r) => r.manifest.origin !== "builtin").length;
  console.info(
    `[gui:plugins] 插件已装载 ${records.length} 个（内置 ${records.length - fromDisk} · 磁盘 ${fromDisk}，清单失败 ${failed}，可卸载 ${unloadable}${disabledByStore > 0 ? `，按禁用名单关闭 ${disabledByStore}` : ""}）`,
  );
  for (const r of disk.rejected) {
    console.warn(`[gui:plugins] 目录未通过校验未装载 ${r.dir}：${r.errors.join("；")}`);
  }
  return { rejected: disk.rejected, warnings: disk.warnings };
}

const ensurePluginHostOnce = singleFlight<PluginHostState>(async () => {
  const dirs = new Map<string, string>();
  const host = createPluginHost(dirs);
  // A-1195：plugin_status（creator 专用只读工具）的数据源 —— 闭包实时读 host.list()，
  // 重载后自动反映，无需重新注入。
  setPluginCatalog(() => host.list().map((r) => ({
    name: r.manifest.name,
    version: r.manifest.version,
    origin: r.manifest.origin,
    status: r.status,
    contributions: r.contributions,
    unloadable: r.unloadable,
  })));
  const scanned = await scanAndLoadInto(host, dirs);
  return { host, dirs, ...scanned };
});

async function ensurePluginHost(): Promise<PluginHostState> {
  return ensurePluginHostOnce();
}

/* ── A-1197 · B1：设置项服务（每次调用新建，不缓存） ────────────────────────────
   **刻意不缓存**：设置项是持久数据、读取时机由渲染层决定（打开设置区才拉），
   缓存一份就会变成「第二个真相源」—— 那正是设计文档 §4.2 明确要避免的。
   `isLoaded` 直接接host 的status：插件被禁用 / 装载失败 ⇒ 读写一律拒。 */
function pluginSettingsService(state: PluginHostState): SettingsService {
  return new SettingsService({
    pluginsRoot: PLUGINS_ROOT,
    declarations: (name) => state.host.get(name)?.manifest.contributes?.settings,
    isLoaded: (name) => state.host.get(name)?.status === "loaded",
  });
}

async function reloadPlugins(): Promise<PluginHostState> {
  const state = await ensurePluginHost();
  const scanned = await scanAndLoadInto(state.host, state.dirs);
  state.rejected = scanned.rejected;
  state.warnings = scanned.warnings;
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// A-1197：贡献目录变更后自动重扫
//
// 缺陷现场（用户实测）：Agent 刚写好的插件/技能，在「扩展」页要到**重启 slime** 才出现。
// 根因：插件清单只在 app 启动（ensurePluginHostOnce）或用户手动点「重新装载」时扫盘，
//       中间没有任何变更信号 —— 文件已经躺在 config/plugins 里，宿主状态却还是上一轮快照。
// 方案：对两个用户自助贡献目录挂 watcher，去抖后重扫 + 重装配技能工具，并广播给渲染层，
//       让已打开的「扩展」页自己刷新（而不是让用户去猜要重启）。
// 兜底：Watcher 不可用/失败都不致命 —— 「重新装载」按钮与重启仍是可用的老路。
// ───────────────────────────────────────────────────────────────────────────
const CONTRIB_RESCAN_DEBOUNCE_MS = 500;
let contribRescanTimer: NodeJS.Timeout | null = null;
let contribRescanQueue: Promise<void> = Promise.resolve();

function broadcastContribRescan(reason: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) { continue; }
    try {
      w.webContents.send(IPC_CHANNELS.plugins_changed, { reason, at: Date.now() });
    } catch {
      // 单个窗口发不出不影响其它窗口，也不应打断重扫
    }
  }
}

async function runContribRescan(reason: string): Promise<void> {
  // 串行化：重扫涉及技能的全部卸载/重装载，并发会互相踩正在置换的 scope。
  const run = contribRescanQueue.then(async () => {
    try {
      await reloadPlugins();
      await refreshAgentSkills();
      broadcastContribRescan(reason);
    } catch (e) {
      console.warn(`[gui:plugins] 自动重扫失败（不影响对话，可手动点「重新装载」）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, async () => {
    // 上一轮失败也要放这一轮进来，不能让队列永久卡死
    try {
      await reloadPlugins();
      await refreshAgentSkills();
      broadcastContribRescan(reason);
    } catch { /* 已在上面出声 */ }
  });
  contribRescanQueue = run.catch(() => undefined);
  await run;
}

function scheduleContribRescan(reason: string): void {
  if (contribRescanTimer) { clearTimeout(contribRescanTimer); }
  contribRescanTimer = setTimeout(() => {
    contribRescanTimer = null;
    void runContribRescan(reason);
  }, CONTRIB_RESCAN_DEBOUNCE_MS);
}

/**
 * 挂载贡献目录 watcher。两个目录都不存在时（全新数据根）也要先建起来再监听，
 * 否则第一个插件是被 Agent 用 mkdir -p 连带建出来的，watch 会 ENOENT 直接哑掉。
 */
export function startContributionWatchers(): void {
  const roots = [
    { dir: PLUGINS_ROOT, what: "扩展" },
    { dir: join(PROJECT_ROOT, "config", "skills"), what: "技能" },
  ];
  for (const { dir, what } of roots) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // 建不出来也照样尝试 watch（父目录异常时下面会出声）
    }
    try {
      const w = watch(dir, (_event, filename) => {
        scheduleContribRescan(`${what}目录变更：${String(filename ?? "").slice(0, 40)}`);
      });
      w.on("error", (e) => {
        console.warn(`[gui:plugins] ${what}目录监听失效（自动重扫停用，仍可手动重装）: ${e instanceof Error ? e.message : String(e)}`);
      });
    } catch (e) {
      console.warn(`[gui:plugins] ${what}目录无法监听（自动重扫停用，仍可手动重装）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}





// 族级信息（tools / modules）只在 BUILTIN_PLUGIN_GROUPS 里，PluginRecord 不带，
// 所以两边合并后才可序列化发给渲染层。host 的 load() 覆盖全部来源，故以 host 顺序为准。
function summarizePlugins(state: PluginHostState): PluginSummaryDTO[] {
  return state.host.list().map((record) => {
    const group = BUILTIN_PLUGIN_GROUPS.find((g) => g.name === record.manifest.name);
    return {
      name: record.manifest.name,
      description: record.manifest.description,
      version: record.manifest.version,
      origin: record.manifest.origin,
      contributions: [...record.manifest.provides],
      tools: group?.tools ? [...group.tools] : [],
      modules: group?.modules ? [...group.modules] : [],
      unloadable: record.unloadable,
      status: record.status,
      error: record.error,
      dir: state.dirs.get(record.manifest.name) ?? "",
      settingsCount: record.manifest.contributes?.settings?.length ?? 0,
      uiCount: record.manifest.contributes?.ui?.length ?? 0,
      scriptCount: record.manifest.contributes?.scripts?.length ?? 0,
      /* A-1197 · B3：运行模式声明（下拉数据源——只列已装载且声明了 mode 的插件）。 */
      hasMode: record.manifest.mode !== undefined,
      ...(record.manifest.mode?.title ? { modeTitle: record.manifest.mode.title } : {}),
      /* B4：信任状态按需从 trust.json 读（默认拒绝）；无目录（如 builtin）恒 false。 */
      trusted: (() => {
        const dir = state.dirs.get(record.manifest.name);
        return dir ? readPluginTrust(dir) : false;
      })(),
    };
  });
}

function snapshotPlugins(state: PluginHostState): PluginSnapshotDTO {
  const rejected: PluginRejectedDTO[] = state.rejected.map((r) => ({ dir: r.dir, errors: [...r.errors] }));
  return { plugins: summarizePlugins(state), rejected };
}










const ensureRegistryOnce = singleFlight<AgentRegistry>(async () => {
  const reg = new AgentRegistry();
  await reg.load();
  agentRegistry = reg;
  return reg;
});





async function ensureRegistry(): Promise<AgentRegistry> {
  return ensureRegistryOnce();
}









const ensureServicesOnce = singleFlight<void>(async () => {
  if (chatService) {
    return;
  }
  const registry = await ensureRegistry();
  
  a2aBus = new ServerA2ABus();
  for (const a of registry.loadedAgents) {
    a2aBus.register(a.name);
  }
  sandbox = new SandboxManager();
  
  
  sandbox.setApprovalCallback((req) => {
    return new Promise((resolve) => {
      
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
        sessionId: req.sessionId ?? agentStreamSessionMap.get(req.agentId), 
      };
      
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
        
        if (d.alwaysAllow && d.approved && req.actions.length > 0) {
          sandbox?.approveToolForSession(req.agentId, req.actions[0].action);
        }
      };
      pendingPerms.set(ui.requestId, resolver);
      
      const timer = setTimeout(() => {
        if (pendingPerms.delete(ui.requestId)) {
          win.webContents.send("slime:perm:timeout", { requestId: ui.requestId });
          resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: req.actions.map((a) => a.action), reason: "权限请求超时（未收到用户决策）", autoApproved: false });
        }
      }, PERM_TIMEOUT_MS);
      try {
        win.webContents.send("slime:perm:request", ui);
      } catch {
        
        clearTimeout(timer);
        pendingPerms.delete(ui.requestId);
        resolve({ requestId: req.requestId, approved: false, approvedActions: [], deniedActions: req.actions.map((a) => a.action), reason: "渲染层不可用", autoApproved: false });
      }
    });
  });
  
  
  
  applyGlobalSandboxDefaults();
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
    registry,
    sandbox,
    silamBrain,
    
    onSilamEvolve: notifySilamEvolve,
    
    
    
    
    
    
    
    clientFactory: (route: RouteEntry) => createRouteClient(route, chromiumFetch as typeof fetch),
    hooks: {
      fixedSegments: () => [],
      volatileSegments: (agent) => {
        const segs: string[] = [];
        try {
          const a = agentRegistry!.loadedAgents.find((x) => x.name === agent.name);
          const emotion = new EmotionalState((a?.emotion as Record<string, unknown>) ?? undefined);
          const behavior = BehaviorStore.fromDict(a?.behavior ?? {});
          segs.push(...buildMindSegments(emotion, behavior));
        } catch (e) {
          console.warn(`[gui:mind] 心智易变段注入失败: ${e}`);
        }
        
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
      
      
      return new Promise((resolve) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          resolve({ answer: "", skipped: true });
          return;
        }
        
        
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
          sessionId: req.sessionId ?? agentStreamSessionMap.get(req.agentId), 
        };
        const send = (channel: string, payload: unknown): void => {
          try { win.webContents.send(channel, payload); } catch { }
        };
        askCoordinator.open({
          requestId: ui.requestId,
          ownerKey: typeof askSid === "string" ? askSid : req.agentId,
          agentId: req.agentId,
          settle: resolve,
          onTimeout: () => send("slime:ask:timeout", { requestId: ui.requestId }),
          onCancel: (reason) => send("slime:ask:cancel", { requestId: ui.requestId, reason }),
        });
        
        
        notifyUser({
          kind: "choice",
          title: `${ui.agentName || "Agent"} 需要你选择`,
          body: (ui.question || ui.header || "有一个待确认的选择").slice(0, 160),
        });
        try {
          win.webContents.send("slime:ask:request", ui);
        } catch {
          askCoordinator.resolve(ui.requestId, { requestId: ui.requestId, answer: "", skipped: true });
        }
      });
    },
  });
  chatService = new ChatService({ registry, engine, bus: a2aBus ?? undefined });
  /* A-1198：把 git_commit 的差异评审接到权限弹窗（D1 第二闸）。
     不注入 ⇒ git_commit 直接拒绝（评审不可省略）——所以这行是 git 工具可用的**前提**。 */
  setGitReviewCallback(requestGitReview);
  
  
  await refreshAgentSkills();
  // A-1197：挂上贡献目录 watcher —— 放在技能/插件首次装配之后，
  // 这样 watcher 建立时目录已经存在，也不会和首轮装载抢同一批 scope。
  try {
    startContributionWatchers();
  } catch (e) {
    console.warn(`[gui:plugins] 贡献目录 watcher 启动失败（不影响对话）: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  
  
  
  try {
    const schedPath = join(runtimeStateDir(), "schedules.json");
    const schedDefs = existsSync(schedPath) ? JSON.parse(readFileSync(schedPath, "utf8")) : [];
    const statePath = join(runtimeStateDir(), "scheduler-state.json");
    if (Array.isArray(schedDefs) || existsSync(statePath)) {
      const scheduler = new SchedulerService();
      
      const persistState = (): void => {
        try { writeFileSync(statePath, scheduler.exportState(), "utf8"); } catch {  }
      };
      if (existsSync(statePath)) {
        try { scheduler.importState(readFileSync(statePath, "utf8")); } catch {  }
      }
      scheduler.setHandler(async (job) => {
        const byId = job.agentId ? await agentRegistry?.findAgent(job.agentId) : undefined;
        const agent = byId ?? agentRegistry?.loadedAgents[0];
        if (!agent) {
          throw new Error(`定时任务「${job.name}」找不到可执行 Agent（agentId=${job.agentId ?? "<default>"}）`);
        }
        let reply = "";
        if (!engine) { throw new Error("引擎未就绪"); }
        /* A-1198：定时任务也是「Agent 在跑」—— 系统提示必须带能力指引（与主对话**同产地**：
           chat.systemPromptFor 里的 agentSkillGuide）。不带上 = 定时任务里的 Agent
           又成了「不知道自己能力」的那个（用户口径：所有 Agent 都要知道自己的功能）。 */
        const system = await engine.buildSystem(agent, undefined, undefined)
          + agentSkillGuide(resolveAgentToolProfile(agent.tool_profile));
        for await (const ev of engine.stream({
          agent,
          message: `${job.prompt}\n\n（本条为后台定时任务触发，触发时间：${new Date().toLocaleString()}）`,
          history: [],
          systemPrompt: system,
        })) {
          if (ev.type === "done") { reply = ev.reply ?? ""; }
        }
        const dir = join(runtimeStateDir(), "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `schedule-${job.name}-${stamp}.md`), reply, "utf8");
        persistState(); 
      });
      for (const d of schedDefs as Array<{ id?: string; name?: string; cron?: string; prompt?: string; agentId?: string }>) {
        if (!d.cron || !d.prompt) { continue; }
        if (d.id && scheduler.get(d.id)) { continue; } 
        try {
          scheduler.add({ id: d.id, name: d.name ?? d.id ?? "task", cron: d.cron, prompt: d.prompt, agentId: d.agentId });
        } catch (e) {
          console.warn(`[scheduler] 忽略非法定时任务「${d.name ?? d.id}」：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      scheduler.start();
      console.log(`[scheduler] 后台常驻定时唤醒已就绪（${scheduler.list().length} 个任务）`);

      
      
      const subagents = new SubAgentManager(async (def, ctx) => {
        const ag = def.agentId
          ? (await agentRegistry?.findAgent(def.agentId))
          : undefined;
        let target = ag ?? agentRegistry?.loadedAgents[0];
        
        if (def.model && /^(api:|local:)/.test(def.model.trim()) && target) {
          target = { ...target, model_choice: def.model.trim() };
        }
        if (!target) { throw new Error(`子代理「${def.name}」找不到可执行 Agent`); }
        if (!engine) { throw new Error("引擎未就绪"); }
        const baseSystem = def.systemPrompt ?? (await engine.buildSystem(target, undefined, undefined));
        const sharedSpecBlock = buildSharedSpecBlock(def.sharedSpec ?? "");
        const system = sharedSpecBlock ? `${baseSystem}\n\n${sharedSpecBlock}` : baseSystem;
        
        
        
        const subagentSessionId = `${SUBAGENT_SESSION_PREFIX}${def.id ?? def.name}`;
        
        
        
        
        const dispatchTools = new Set(["delegate_subagent", "subagent_result"]);
        const allToolNames = engine.listTools?.().map((t) => t?.function?.name).filter((n): n is string => !!n) ?? [];
        
        
        
        
        
        const subToolsOnly = def.toolsOnly
          ? def.toolsOnly.filter((n) => !dispatchTools.has(n))
          : (allToolNames.length > 0 ? allToolNames.filter((n) => !dispatchTools.has(n)) : undefined);
        
        
        
        
        
        
        
        
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
          
          
          
          if (ev.type === "chunk" && typeof ev.content === "string") {
            acc.push(ev.content);
          } else if (ev.type === "done" && typeof ev.reply === "string") {
            reply = ev.reply;
          }
          if (ctx?.signal.aborted) { break; }
        }
        
        const aborted = ctx?.signal.aborted === true;
        if (!reply || reply.trim() === "（生成已被中断）") { reply = acc.join(""); }
        const dir = join(runtimeStateDir(), "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        
        const body = reply.trim()
          ? `${aborted ? "> ⚠️ 本次执行被中断，以下为中断前已产出的部分内容。\n\n" : ""}${reply}`
          : `> 本次执行${aborted ? "被中断" : "结束"}，子代理未产出任何正文。\n`;
        
        
        
        
        writeFileSync(join(dir, `subagent-${sanitizeSubagentRunName(def.name)}-${stamp}.md`), body, "utf8");
        return reply;
      }, {
        
        
        
        
        
        concurrency: readRequests().concurrency,
        hooks: {
          
          
          
          
          onSpawn: (run) => {
            console.log(`[subagent] 派发 ${run.name} (${run.id})`);
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          
          
          
          
          onStart: (run) => {
            console.log(`[subagent] 开始 ${run.name} (${run.id})`);
            syncSubagentRuns(subagents.list());
            
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

      
      subagents.register({
        name: "代码审查员",
        description: "审查代码质量、发现潜在 bug、静态分析、给出改进建议",
        systemPrompt: "你是资深代码审查专家，输出问题清单与修复建议。",
        model: "inherit",
        
        
        
        
        timeoutMs: DEFAULT_EXEC_BUDGET_MS,
        outputSchema: true,
      });
      subagents.register({
        name: "调研员",
        description: "联网搜索资料、汇总信息、多来源调研与引用整理",
        systemPrompt: "你是多来源调研专家，输出带引用的结构化调研摘要。",
        model: "inherit",
        timeoutMs: DEFAULT_EXEC_BUDGET_MS,
        outputSchema: true,
      });
      subagents.register({
        name: "数据分析员",
        description: "数据清洗、统计、表格/指标计算与分析",
        systemPrompt: "你是数据分析专家，输出可核验的统计与结论。",
        model: "inherit",
        timeoutMs: DEFAULT_EXEC_BUDGET_MS,
        outputSchema: true,
      });

      
      
      
      
      
      
      
      
      
      
      
      
      syncDispatchableSubagents(subagents);

      
      setSubagentManager(subagents);
      
      subagentsRef = subagents;
      




      console.log(`[subagent] 装配完成：SubAgentManager 已接线 delegate_subagent（可用定义 ${subagents.catalog().length} 个 = 内置 3 + 被授权派发的自建 Agent）`);
      
      if (subagentDefaultModels.length > 0) {
        subagents.setDefaultModels(subagentDefaultModels);
        console.log(`[subagent] 执行模型池已应用（${subagentDefaultModels.length} 档，兜底档=${subagentDefaultModels[0]}）：${subagentDefaultModels.join(" / ")}`);
      }

      
      
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

      
      
      
      
      residentStateProvider = () => ({
        scheduler: scheduler.list(),
        
        subagents: mergedSubagentRuns(subagents.list()),
        defaultModel: subagents.getDefaultModel(),
        defaultModels: subagents.getDefaultModels(),
      });
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
        } catch {  }
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
      
      ipcMain.handle("slime:resident:subagent:cancel", (_e, p: { id?: string }) => {
        const ok = !!p?.id && subagents.cancel(p.id!);
        
        
        
        if (ok) {
          syncSubagentRuns(subagents.list());
          mainWindow?.webContents.send("slime:resident:update", null);
        }
        return { ok };
      });
      
      
      
      
      ipcMain.handle("slime:resident:subagent:clear", () => {
        const cleared = clearSubagentRuns();
        const dropped = subagents.forgetTerminal();
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, cleared, dropped };
      });
      
      
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
      










      







      ipcMain.handle("slime:resident:subagent:getSelection", () => ({
        ok: true,
        selectedAgentIds: dispatchableAgentIds(agentRegistry?.loadedAgents ?? []),
      }));
      ipcMain.handle("slime:resident:subagent:setSelection", async (_e, p: { selectedAgentIds?: unknown }) => {
        const ids = new Set(
          Array.isArray(p?.selectedAgentIds)
            ? (p!.selectedAgentIds as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        );
        for (const a of agentRegistry?.loadedAgents ?? []) {
          const want = ids.has(a.id);
          
          
          if (isSubagentDispatchAllowed(a) === want) { continue; }
          await agentRegistry!.updateAgent(a.id, { subagent_dispatch: want });
        }
        syncDispatchableSubagents();
        mainWindow?.webContents.send("slime:resident:update", null);
        return { ok: true, selectedAgentIds: dispatchableAgentIds(agentRegistry?.loadedAgents ?? []) };
      });

      
    } else {
      



      console.warn(
        "[scheduler] data/schedules.json 不是数组且无运行态快照 —— 跳过定时唤醒装配"
        + "（⚠️ 同块内的子代理装配 / 事件 HTTP 端点 / 后台任务 IPC 也一并被跳过；"
        + "delegate_subagent 将不可用。请把该文件写成 JSON 数组）",
      );
    }
  } catch (e) {
    





    console.warn(
      "[scheduler] 定时唤醒装配失败 —— ⚠️ 同块内的子代理装配 / 事件端点 / 后台任务 IPC 一并被跳过"
      + `（delegate_subagent 将不可用）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  statsService = new StatsService(registry);
  
  setDownloadListener((p: DownloadProgress) => {
    mainWindow?.webContents.send("slime:mind:downloadProgress", p);
  });
  
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
});









let residentStateProvider: () => ResidentState = () => ({ scheduler: [], subagents: [], defaultModel: undefined, defaultModels: [] });



function dataRootInfo(): {
  root: string; custom: boolean; default: string; exists: boolean;
} {
  const root = RUNTIME_DATA_DIR;
  return { root, custom: isCustomDataRoot(), default: defaultDataRoot(), exists: dataRootExists(root) };
}

/**
 * 把旧数据根的内容递归**复制**到新数据根（dataRootSet 的 migrate 分支）。
 *
 * 只复制不删除：来源目录原地保留，任何一步失败都只 console.warn 并在返回值里计数，
 * 不让「迁移」变成「丢数据」。临时/进程态文件（run.lock / 日志 / 端口文件）跳过 ——
 * 换了根它们本来就该重新生成。
 */
function copyDataRootTree(from: string, to: string): { copied: number; failed: number } {
  let copied = 0;
  let failed = 0;
  if (!existsSync(from)) { return { copied, failed }; }
  for (const name of readdirSync(from)) {
    if (RUNTIME_ONLY_FILES.has(name)) { continue; }
    const src = join(from, name);
    const dst = join(to, name);
    if (existsSync(dst)) { continue; }
    try {
      cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
      copied++;
    } catch (e) {
      failed++;
      console.warn(`[gui:dataRoot] 迁移复制失败（已跳过，来源保留）：${src} → ${dst}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { copied, failed };
}

/** 迁移时跳过的临时/进程态文件 —— 换了数据根它们本来就该重新生成，跟着搬没有意义。 */
const RUNTIME_ONLY_FILES = new Set([
  "run.lock",
  "watchdog.log",
  "crash-report.log",
  "DevToolsActivePort",
]);

const REQUESTS_FILE = join(runtimeStateDir(), "requests.json");
const DEFAULT_REQUESTS = { concurrency: 2, reconnectBaseMs: 3000 };
/**
 * 一次性把旧版散落在安装目录下的运行时文件**复制**到数据根。
 *
 * 背景：早期版本把 `data\\`（run.lock / schedules.json / generated\\ …）与 `config\\requests.json`
 * 直接写在安装目录下，于是用户的 D:\\…\\slimecode 下凭空长出这些文件。安装目录常常不可写、
 * 升级时还会被整体替换。现在这些文件都归数据根管，但**不能删用户的老数据**。
 *
 * 三条硬约束（改之前先读一遍）：
 *   · 只复制，**绝不删除/移动来源文件** —— 迁移失败也不会丢东西。
 *   · 目标已存在同名文件 ⇒ 跳过，不覆盖用户在新位置的选择。
 *   · 任一项失败只 console.warn，**不阻断启动**。
 */
function migrateLegacyInstallDirData(): void {
  try {
    const rt = runtimeStateDir();
    const legacyData = join(INSTALL_ROOT, "data");
    const legacyConfigFile = join(INSTALL_ROOT, "config", "requests.json");
    if (!existsSync(legacyData) && !existsSync(legacyConfigFile)) { return; }

    // 安装目录恰好就是数据根（例如用户直接把数据根设成安装目录）⇒ 无需迁移
    const legacyRt = resolve(legacyData);
    if (legacyRt === resolve(rt) || legacyRt === resolve(rt, "..")) { return; }

    let copied = 0;
    if (existsSync(legacyData)) {
      for (const name of readdirSync(legacyData)) {
        if (RUNTIME_ONLY_FILES.has(name)) { continue; }
        const from = join(legacyData, name);
        const to = join(rt, name);
        if (existsSync(to)) { continue; }
        try {
          cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
          copied++;
        } catch (e) {
          console.warn(`[gui:dataRoot] 旧数据复制失败（已跳过，来源文件原地保留）：${from} → ${to}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (existsSync(legacyConfigFile) && !existsSync(REQUESTS_FILE)) {
      try {
        cpSync(legacyConfigFile, REQUESTS_FILE, { force: false, errorOnExist: false });
        copied++;
      } catch (e) {
        console.warn(`[gui:dataRoot] 旧 requests.json 复制失败（已跳过，来源文件原地保留）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (copied > 0) {
      console.log(`[gui:dataRoot] 已从安装目录复制 ${copied} 项历史运行时数据到 ${rt}（来源文件保留在安装目录，未删除）`);
    }
  } catch (e) {
    console.warn(`[gui:dataRoot] 历史数据迁移跳过（不影响启动）：${e instanceof Error ? e.message : String(e)}`);
  }
}

function readRequests(): typeof DEFAULT_REQUESTS {
  try {
    if (existsSync(REQUESTS_FILE)) {
      const p = JSON.parse(readFileSync(REQUESTS_FILE, "utf8")) as Partial<typeof DEFAULT_REQUESTS>;
      return {
        concurrency: typeof p.concurrency === "number" && p.concurrency >= 1 && p.concurrency <= 20 ? p.concurrency : DEFAULT_REQUESTS.concurrency,
        reconnectBaseMs: typeof p.reconnectBaseMs === "number" && p.reconnectBaseMs >= 500 && p.reconnectBaseMs <= 15000 ? p.reconnectBaseMs : DEFAULT_REQUESTS.reconnectBaseMs,
      };
    }
  } catch {  }
  return { ...DEFAULT_REQUESTS };
}





async function ensureServices(): Promise<void> {
  await ensureServicesOnce();
}












function embeddingBaseUrl(): string {
  const live = getModelServer()?.getPort("embedding");
  if (live && live > 0) { return `http://127.0.0.1:${live}`; }
  const cfg = readModelServerConfig();
  const port = basePortFor("embedding", cfg.embedding ?? {}, cfg.chat ?? {});
  return `http://127.0.0.1:${port}`;
}


function bgeEmbed(): { embed: (text: string) => Promise<number[]> } {
  return {
    embed: async (text: string): Promise<number[]> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch(`${embeddingBaseUrl()}/v1/embeddings`, {
          method: "POST",
          // 申请类（模型 API）：诚实标产品身份，与 core-ts/src/llm/client.ts 同一套策略。
          headers: { "Content-Type": "application/json", "User-Agent": productUserAgent() },
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


const memoryStores = new Map<string, MemoryStore>();












let lancedbComponentCache: LancedbComponentStatus | null = null;

export function lancedbComponent(): LancedbComponentStatus {
  if (!lancedbComponentCache) { lancedbComponentCache = lancedbComponentStatus(); }
  return lancedbComponentCache;
}

export function refreshLancedbComponent(): LancedbComponentStatus {
  lancedbComponentCache = lancedbComponentStatus();
  
  memoryStores.clear();
  console.log(
    lancedbComponentCache.ok
      ? `[gui:lancedb] 组件已就位：${lancedbComponentCache.dir}`
      : `[gui:lancedb] 组件未就位：${lancedbComponentCache.error}`,
  );
  return lancedbComponentCache;
}

function memoryStoreFor(agentId: string): MemoryStore {
  let s = memoryStores.get(agentId);
  if (!s) {
    const cfg = loadMindConfig();
    s = new MemoryStore(agentId, {
      
      lancedbEnabled: lancedbComponent().ok,
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



setMemoryStoreProvider(memoryStoreFor);




const APPROVAL_MODES = ["manual", "auto", "none", "custom"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];


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
  
  
  
  
  const raw = (ov.approval as string) ?? getPermissions().globalApproval;
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






function applyGlobalSandboxDefaults(): void {
  if (!sandbox || !agentRegistry) { return; }
  for (const a of agentRegistry.loadedAgents) {
    try {
      const ov = (a.sandbox_override && typeof a.sandbox_override === "object")
        ? (a.sandbox_override as Record<string, unknown>)
        : {};
      sandbox.setAgentConfig(a.id, sandboxConfigFromOverride(ov));
    } catch (e) {
      console.warn(`[gui:main] 下发全局沙箱默认失败 ${a.id}:`, e);
    }
  }
}






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

  
  const riskHint =
    maxLevel <= 1 ? "只读，风险较低"
    : maxLevel === 2 ? "将写入外部文件，可能有改动"
    : maxLevel === 3 ? "将执行终端命令，可能影响系统"
    : maxLevel >= 4 ? "将访问网络或执行高权限操作，风险较高"
    : "有一定风险";

  const actionLabel = first ? `${first.action} → ${first.target || "…"}` : "此操作";

  return [
    {
      id: "allow-once",
      label: "允许通过",
      hint: `放行 ${actionLabel}（${riskHint}）—— 下次同类操作仍会再次询问。把「安全与权限」里对应类别（读 / 写 / 终端）的开关打开即可免去询问。`,
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
  toolProfile?: { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] },
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
    
    ...(toolProfile ? { tool_profile: toolProfile } : {}),
  } as AgentState;
}


function assertAgentNameRole(name: unknown, role: unknown): asserts name is string {
  if (typeof name !== "string" || !name.trim() || typeof role !== "string" || !role.trim()) {
    throw new Error("name/role 必须为非空字符串");
  }
}

async function createAgent(
  name: string,
  role: string,
  toolProfile?: { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] },
): Promise<AgentState> {
  assertAgentNameRole(name, role);
  const agents = agentRegistry!.loadedAgents;
  const a = buildAgentState(name.trim(), role.trim(), null, toolProfile);
  agents.push(a);
  await agentRegistry!.save();
  return a;
}


async function ensureDefaultAgent(): Promise<void> {
  try {
    const reg = await ensureRegistry();
    if (reg.loadedAgents.length > 0) { return; }
    const a = buildAgentState(
      "助手",
      "通用 AI 助手，负责回答问题、编写代码、整理信息与日常协作",
      null,
      { mode: "default", skills: [], mcp: [] },
    );
    reg.loadedAgents.push(a);
    await reg.save();
    console.info(`[gui:main] 首次启动：已创建默认 Agent ${a.id}`);
  } catch (e) {
    console.warn("[gui:main] 创建默认 Agent 失败（不影响启动）:", e instanceof Error ? e.message : String(e));
  }
}

async function forkAgent(parent: AgentState, name: string, role: string): Promise<AgentState> {
  assertAgentNameRole(name, role);
  if ((parent.fork_depth ?? 0) + 1 > 2) {
    throw new Error("分裂深度已达上限（MAX_FORK_DEPTH=2）");
  }
  const child = buildAgentState(name.trim(), role.trim(), parent.id, parent.tool_profile as { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] } | undefined);
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


























async function resolveSessionWindowCap(agentId: string, modelId: string): Promise<number | undefined> {
  try {
    if (agentId && agentRegistry) {
      const agent = await agentRegistry.findAgent(agentId).catch(() => null);
      if (agent?.max_context && agent.max_context > 0) { return agent.max_context; }
    }
  } catch {  }
  if (!modelId) { return undefined; }
  try {
    const candidates = Array.from(new Set([
      modelId,
      modelId.replace(/^api:[^:]*:/, "").replace(/^local:/, ""),
      modelId.split(":").pop() ?? modelId,
    ])).filter(Boolean);

    const localSpec = listLocalModels().find(
      
      (m) => candidates.includes(m.id) || (typeof m.label === "string" && candidates.includes(m.label)),
    );
    let serverCtx: number | undefined;
    let plannedCtx: number | undefined;

    
    if (localSpec || modelId.startsWith("local:")) {
      const cap = await probeManagedChatCapability({ path: localSpec?.path, ids: candidates }).catch(() => null);
      if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { path: localSpec?.path, ids: candidates })) {
        serverCtx = cap.effectiveCtx;
      }
      


      const chatCfgCtx = Number((readModelServerConfig()?.chat as { ctx_len?: number } | undefined)?.ctx_len ?? 0);
      plannedCtx = localSpec?.ctx_len && localSpec.ctx_len > 0
        ? localSpec.ctx_len
        : (chatCfgCtx > 0 ? chatCfgCtx : undefined);
      logLocalCapGap(cap?.state ?? "down", serverCtx);
    }

    
    if (serverCtx === undefined) {
      for (const p of listProviders()) {
        const base = typeof p.api_base === "string" ? p.api_base : "";
        if (!isLoopbackBaseUrl(base)) { continue; }
        const owns = (p.models ?? []).some((m) => candidates.includes(m.id))
          || (typeof p.model === "string" && candidates.includes(p.model));
        if (!owns) { continue; }
        const cap = await getLocalCapability(base).catch(() => null);
        
        if (cap?.effectiveCtx != null && capabilityMatchesModel(cap, { trustedEndpoint: true })) {
          serverCtx = cap.effectiveCtx;
          break;
        }
      }
    }

    
    let providerCtx: number | undefined;
    for (const id of candidates) {
      for (const p of listProviders()) {
        const m = (p.models ?? []).find((x) => x.id === id);
        if (m?.context_window && m.context_window > 0) { providerCtx = m.context_window; break; }
      }
      if (providerCtx !== undefined) { break; }
    }

    return resolveWindowCap({ serverCtx, plannedCtx, providerSpecCtx: providerCtx }).ctx;
  } catch {  }
  return undefined;
}

































async function suggestWiderChatModel(requiredTokens: number, currentCap: number): Promise<RescuableModel | null | undefined> {
  
  
  if (!Number.isFinite(requiredTokens) || requiredTokens <= 0) { return undefined; }
  try {
    



    const seen = new Set<string>();
    const candidates: CapCandidate[] = [];
    const add = (id: unknown, label: string, cap: unknown, choice: string): void => {
      const mid = typeof id === "string" ? id.trim() : "";
      const c = typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : 0;
      const ch = choice.trim();
      if (!mid || !ch || c <= 0 || seen.has(ch)) { return; }
      seen.add(ch);
      candidates.push({ id: mid, label: label && label.trim() ? label.trim() : mid, cap: c, choice: ch });
    };
    
    for (const m of listLocalModels()) {
      const label = String(m.label ?? "").trim() || m.id;
      const choice = `local:${m.id}`; 
      if (typeof m.ctx_len === "number" && m.ctx_len > 0) {
        add(m.id, label, m.ctx_len, choice);
      } else {
        add(m.id, label, await resolveSessionWindowCap("", m.id).catch(() => undefined), choice);
      }
    }
    
    for (const p of listProviders()) {
      const key = String(p.key ?? "").trim();
      for (const m of p.models ?? []) {
        const id = typeof m.id === "string" ? m.id : "";
        
        
        add(id, key ? `${key} · ${id}` : id, (m as { context_window?: number }).context_window, key ? `api:${key}:${id}` : "");
      }
    }
    const picked = pickRescueModel(requiredTokens, currentCap, candidates);
    if (picked) {
      console.info(`[gui:main] 上下文救回建议（${picked.label ?? picked.id}，${picked.cap} tokens，本次需 ${Math.round(requiredTokens)}）→ ${picked.choice ?? picked.id}`);
    } else {
      console.info(`[gui:main] 上下文救回：已查 ${candidates.length} 个候选，没有能装下 ≈${Math.round(requiredTokens)} 的更大窗口模型`);
    }
    return picked;
  } catch (e) {
    
    console.warn("[gui:main] 可救模型解析失败 —— 按「没查成」如实告知（不说成「查过没有」）:", e);
    return undefined;
  }
}






let lastLocalCapWarn: string | null = null;
function logLocalCapGap(state: string, serverCtx: number | undefined): void {
  const key = `${state}|${serverCtx ?? "-"}`;
  if (key === lastLocalCapWarn) { return; }
  lastLocalCapWarn = key;
  if (state === "ready" && serverCtx === undefined) {
    console.warn(
      "[gui:cap] 本地服务已就绪但解析不出 n_ctx —— 端点半结构可能变了；" +
      "已回落到 slime.toml 的 ctx_len。请检查 /props.default_generation_settings.n_ctx " +
      "/v1/models.data[].meta.n_ctx 的字段名（见 core-ts/src/model_introspect.ts 的文件头实测记录）。",
    );
  } else if (state === "loading") {
    console.info("[gui:cap] 本地模型加载中（/props 503 unavailable_error），窗口上限本次取兜底值");
  }
}


function agentNameForNotify(agentId: string | undefined): string {
  try {
    if (agentId && agentRegistry) {
      const a = agentRegistry.loadedAgents.find((x) => x.id === agentId || x.name === agentId);
      if (a?.name) { return a.name; }
    }
  } catch {  }
  return agentId || "Agent";
}













function createChunkSender(): StreamChunkBatcher {
  return new StreamChunkBatcher((chunk) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("slime:chat:chunk", chunk);
    }
  });
}









function toStreamChunk(ev: { seq: number; type: string; data: unknown }, sessionId?: string): StreamChunk {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const pt = typeof d.promptTokens === "number" ? d.promptTokens : typeof d.prompt_tokens === "number" ? d.prompt_tokens : undefined;
  const ct = typeof d.completionTokens === "number" ? d.completionTokens : typeof d.completion_tokens === "number" ? d.completion_tokens : undefined;
  const em = typeof d.elapsedMs === "number" ? d.elapsedMs : typeof d.elapsed_ms === "number" ? d.elapsed_ms : undefined;
  const mergedTimings: Record<string, number> = {};
  if (typeof d.timings === "object" && d.timings !== null) {
    
    for (const [k, v] of Object.entries(d.timings as Record<string, number>)) {
      if (typeof v === "number") { mergedTimings[k] = v; }
    }
  }
  if (typeof pt === "number") { mergedTimings.promptTokens = pt; }
  if (typeof ct === "number") { mergedTimings.completionTokens = ct; }
  if (typeof em === "number") { mergedTimings.elapsedMs = em; }
  
  if (typeof mergedTimings.cacheReadTokens !== "number") {
    if (typeof (d as any).cache_read_tokens === "number") {
      mergedTimings.cacheReadTokens = (d as any).cache_read_tokens;
    } else if (typeof (d as any).cacheReadTokens === "number") {
      mergedTimings.cacheReadTokens = (d as any).cacheReadTokens;
    } else {
      mergedTimings.cacheReadTokens = 0;
    }
  }
  
  if (typeof mergedTimings.cacheCreationTokens !== "number") {
    if (typeof (d as any).cache_creation_tokens === "number") {
      mergedTimings.cacheCreationTokens = (d as any).cache_creation_tokens;
    } else if (typeof (d as any).cacheCreationTokens === "number") {
      mergedTimings.cacheCreationTokens = (d as any).cacheCreationTokens;
    }
  }
  
  if (typeof mergedTimings.reasoningTokens !== "number") {
    if (typeof (d as any).reasoning_tokens === "number") {
      mergedTimings.reasoningTokens = (d as any).reasoning_tokens;
    } else {
      mergedTimings.reasoningTokens = 0;
    }
  }
  
  
  
  {
    const wpt = (d as any).window_prompt_tokens ?? (d as any).windowPromptTokens;
    const wcr = (d as any).window_cache_read_tokens ?? (d as any).windowCacheReadTokens;
    if (typeof wpt === "number") { mergedTimings.windowPromptTokens = wpt; }
    if (typeof wcr === "number") { mergedTimings.windowCacheReadTokens = wcr; }
  }
  
  
  
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
      
      
      toolId: typeof d.toolId === "string" ? d.toolId : undefined,
      
      
      steerId: typeof d.steerId === "string" ? d.steerId : undefined,
      
      agentId: typeof d.agentId === "string" ? d.agentId : undefined,
      
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














interface WindowState { width: number; height: number; x?: number; y?: number; }
const WIN_STATE_PATH = resolveExtra("../config/winstate.json");














const WIN_MIN = { width: 900, height: 560 };










const THEME_CFG_PATH = join(PROJECT_ROOT, "config", "theme.json");


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
    
    console.warn("[gui:main] 写入主机配置失败:", e instanceof Error ? e.message : String(e));
  }
}






function titleBarColors(theme: string): { color: string; symbolColor: string } {
  return theme === "alpha"
    ? { color: "#1e293b", symbolColor: "#e2e8f0" }
    : { color: "#0b101e", symbolColor: "#e6f1ff" };
}

const WIN_DEFAULT_RATIO = { width: 0.78, height: 0.90 };

const WIN_DEFAULT_FLOOR = { width: 1040, height: 700 };

function defaultWindowState(): WindowState {
  const wa = screen.getPrimaryDisplay().workArea;
  const wantW = Math.round(wa.width * WIN_DEFAULT_RATIO.width);
  const wantH = Math.round(wa.height * WIN_DEFAULT_RATIO.height);
  
  const w = Math.max(WIN_MIN.width, Math.min(Math.max(wantW, WIN_DEFAULT_FLOOR.width), wa.width, 2560));
  const h = Math.max(WIN_MIN.height, Math.min(Math.max(wantH, WIN_DEFAULT_FLOOR.height), wa.height, 1600));
  return { width: w, height: h };
}



function loadWindowPos(size: { width: number; height: number }): { x?: number; y?: number } {
  try {
    const s = JSON.parse(readFileSync(WIN_STATE_PATH, "utf8")) as Partial<WindowState>;
    if (typeof s.x !== "number" || typeof s.y !== "number") { return {}; }
    const wa = screen.getPrimaryDisplay().workArea;
    const x = Math.round(s.x), y = Math.round(s.y);
    if (x + 200 > wa.x + wa.width || y + 120 > wa.y + wa.height || x < wa.x - 400 || y < wa.y - 400) {
      return {}; 
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
    
    const [x, y] = win.getPosition();
    writeFileSync(WIN_STATE_PATH, JSON.stringify({ x, y }), "utf8");
  } catch {  }
}
let winStateTimer: NodeJS.Timeout | null = null;
function schedulePersistWindowState(): void {
  if (winStateTimer) { clearTimeout(winStateTimer); }
  winStateTimer = setTimeout(() => { winStateTimer = null; persistWindowState(); }, 400);
}

function createWindow(): void {
  
  initNotify({ getWindow: () => mainWindow });
  
  const st = defaultWindowState();
  const pos = loadWindowPos(st);
  mainWindow = new BrowserWindow({
    width: st.width, height: st.height, x: pos.x, y: pos.y,
    minWidth: WIN_MIN.width, minHeight: WIN_MIN.height, show: false,
    
    icon: resolveAppIconImage(),
    
    titleBarStyle: "hidden",
    
    
    titleBarOverlay: { ...titleBarColors(readPersistedTheme()), height: 40 },
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      
      spellcheck: false,
      
      webviewTag: true,
      preload: join(__dirname, "../preload/index.js"), webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  
  mainWindow.on("resize", () => schedulePersistWindowState());
  mainWindow.on("move", () => schedulePersistWindowState());
  mainWindow.on("close", () => persistWindowState());
  
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 3000);
  
  
  
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    try {
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "renderer-crash.log"), `${new Date().toISOString()}\t${details.reason} (exit=${details.exitCode})\n`, { flag: "a" });
      console.error("[gui:main] 渲染进程已崩溃，原因:", details.reason, "(将自动重载恢复)");
    } catch {  }
    
    notifyUser({
      kind: "aborted",
      title: "slime 意外终止",
      body: `界面进程异常退出（${details.reason}），已自动重载恢复；进行中的生成可能已中断。`,
    });
    try { mainWindow?.webContents.reload(); } catch {  }
  });
  
  mainWindow.webContents.on("unresponsive", () => {
    try {
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "renderer-unresponsive.log"), `${new Date().toISOString()}\n`, { flag: "a" });
    } catch {  }
    
    notifyUser({
      kind: "aborted",
      title: "slime 界面无响应",
      body: "界面进程长时间未响应，可能正在执行超长任务；若无恢复请重启应用。",
    });
  });
  
  mainWindow.on("close", (e) => {
    if (exitModeStore === "background" && !appIsQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      ensureTray();
      syncTrayTooltip();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  
  
  mainWindow.on("show", syncTrayTooltip);
  mainWindow.on("hide", syncTrayTooltip);
  mainWindow.on("minimize", syncTrayTooltip);
  mainWindow.on("restore", syncTrayTooltip);
}






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
  
  ipcMain.handle("slime:boot:status", () => bootQuery ?? { phase: "starting", backendReady: false, message: "正在初始化…" });
  
  
  ipcMain.handle("slime:app:version", () => app.getVersion());

  
  
  
  
  ipcMain.handle("slime:resident:state", () => residentStateProvider());
  ipcMain.handle("slime:requests:get", () => readRequests());
  ipcMain.handle("slime:requests:set", (_e, p: { concurrency?: number; reconnectBaseMs?: number }) => {
    const cur = readRequests();
    const next = {
      concurrency: typeof p?.concurrency === "number" && p.concurrency >= 1 && p.concurrency <= 20 ? Math.floor(p.concurrency) : cur.concurrency,
      reconnectBaseMs: typeof p?.reconnectBaseMs === "number" && p.reconnectBaseMs >= 500 && p.reconnectBaseMs <= 15000 ? Math.floor(p.reconnectBaseMs) : cur.reconnectBaseMs,
    };
    try {
      writeFileSync(REQUESTS_FILE, JSON.stringify(next, null, 2), "utf8");
      return { ok: true, ...next };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  
  
  
  
  
  
  ipcMain.handle("slime:resident:subagent:setModels", (_e, p: { models?: unknown }) => setSubagentModels(p?.models));
  ipcMain.handle("slime:resident:subagent:setDefaultModel", (_e, p: { model?: unknown }) => setSubagentDefaultModel(p?.model));

  
  function resolveAgentId(inputAgentId: string | undefined): string {
    if (inputAgentId) { return inputAgentId; }
    if (selectedAgentId) { return selectedAgentId; }
    
    const roots = agentRegistry!.loadedAgents.filter((a) => !a.parent_id);
    return roots[0]?.id ?? "primary";
  }

  











  
  type SessionHistoryLine = { role: "user" | "assistant"; content: string };
  type LoadedHistory = { raw: SessionHistoryLine[]; meta: Awaited<ReturnType<typeof getSession>> };

  










  async function loadRawHistoryWithMeta(sessionId: string | undefined, opts?: { full?: boolean }): Promise<LoadedHistory> {
    if (!sessionId) { return { raw: [], meta: null }; }
    try {
      const meta = await getSession(sessionId);
      if (!meta) { return { raw: [], meta: null }; }
      const agentSessions = (await listSessions()).filter((m) => m.agentId === meta.agentId);
      const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
      
      const records = await loadHistoryForSession(meta.agentId, meta.id, opts?.full ? 0 : HISTORY_LOAD_LIMIT, firstSession);
      const raw: SessionHistoryLine[] = records.flatMap((r) => [
        { role: "user" as const, content: r.user },
        { role: "assistant" as const, content: r.ai },
      ]);
      return { raw, meta };
    } catch (e) {
      console.warn("[gui:main] 会话原始历史加载失败:", e);
      return { raw: [], meta: null };
    }
  }

  







  function foldSessionHistory(raw: SessionHistoryLine[], meta: LoadedHistory["meta"]): SessionHistoryLine[] {
    const keep = meta?.summaryCount ?? DEFAULT_TAIL_KEEP;
    
    if (meta?.summaryCount !== undefined && raw.length > keep * 2) {
      if (meta.contextSummary) {
        
        
        
        return buildCompactedHistory(meta.contextSummary, raw, keep, { comprehend: meta.contextComprehend }) as SessionHistoryLine[];
      }
      
      return truncateTurnAligned(raw, keep);
    }
    return raw;
  }

  
  async function loadSessionHistory(sessionId: string | undefined, opts?: { full?: boolean }): Promise<SessionHistoryLine[]> {
    const { raw, meta } = await loadRawHistoryWithMeta(sessionId, opts);
    return foldSessionHistory(raw, meta);
  }

  

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

  handleTrusted<void>("slime:dataRoot:get", async () => {
    try {
      return dataRootInfo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:dataRoot] 读取数据根失败:", e);
      return { root: "", custom: false, default: "", exists: false, error: msg };
    }
  });

  handleTrusted<void>("slime:dataRoot:pick", async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      const r = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, {
            title: "选择数据根目录",
            properties: ["openDirectory", "createDirectory"],
            defaultPath: dataRootInfo().root,
          })
        : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
      if (r.canceled || r.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      return { ok: true, canceled: false, dir: r.filePaths[0] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:dataRoot] 选择目录失败:", e);
      return { ok: false, canceled: false, error: msg };
    }
  });

  handleTrusted<{ dir: string; migrate: boolean }>("slime:dataRoot:set", async (_event, payload) => {
    const dir = typeof payload?.dir === "string" ? payload.dir.trim() : "";
    if (!dir) {
      return { ok: false, error: "目录不能为空" };
    }
    let migrated = false;
    try {
      mkdirSync(dir, { recursive: true });
      if (!dataRootExists(dir)) {
        return { ok: false, error: `目录创建失败：${dir}` };
      }
      if (payload?.migrate === true) {
        const r = copyDataRootTree(RUNTIME_DATA_DIR, dir);
        migrated = r.copied > 0;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:dataRoot] 切换数据根失败:", e);
      return { ok: false, error: msg };
    }
    try {
      writeDataRootPointer(dir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:dataRoot] 数据根记录写入失败:", e);
      return { ok: false, error: msg, migrated };
    }
    /* root 必须与 dataRootInfo() 同产（同一事实只有一个产地）：那边给的是已 resolve 的
     * RUNTIME_DATA_DIR，这边若回传原始入参（可能是 `..` / 相对路径），渲染层会先乐观显示
     * 一个值、随即被下一次回刷成另一个。 */
    return { ok: true, migrated, root: resolve(dir), needRestart: true };
  });

  handleTrusted<void>("slime:dataRoot:reset", async () => {
    try {
      clearDataRootPointer();
      return { ok: true, needRestart: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:dataRoot] 恢复默认数据根失败:", e);
      return { ok: false, error: msg };
    }
  });

  handleTrusted<ChatInput>("slime:chat:stream", async (_event, input: ChatInput) => {
    try {
    await ensureServices();
    
    
    await refreshAgentSkills();
    const agentId = resolveAgentId(input.agentId);
    
    
    
    
    
    
    const loadingAgent = await agentRegistry!.findAgent(agentId).catch(() => undefined);
    const cancelKey = input.sessionId ?? agentId;
    const controller = new AbortController();
    activeChats.set(cancelKey, controller);
    releaseAsksOnAbort(controller.signal, cancelKey, askCoordinator, (released) => {
      console.warn(`${ASK_RELEASE_MARKER} ${cancelKey} 的 ${released.length} 条挂起提问已在取消时释放: ${released.join(",")}`);
    });
    agentStreamSessionMap.set(input.agentId, cancelKey); 
    lastChatCancelKey = cancelKey;
    let history = input.history ? (input.history as any) : [];
    
    if (history.length === 0) {
      history = await loadSessionHistory(input.sessionId);
    }
    

    const brainMeta = input.sessionId && typeof input.sessionId === "string" ? await getSession(input.sessionId).catch(() => null) : null;
    const isBrainstorm = brainMeta?.type === "brainstorm" && memberIdsOf(brainMeta.members).length > 0;
    

    const runModelChoice = effectiveModelChoice(brainMeta?.modelChoice, loadingAgent?.model_choice);
    const req: ChatRequest = {
      message: input.message,
      history,
      retry: false,
      maxTokens: input.maxTokens,
      sessionId: input.sessionId,
      networkEnabled: input.networkEnabled,
      
      images: input.images,
      resumeHint: (input as { resumeHint?: string }).resumeHint,
      



      windowCap: await resolveSessionWindowCap(agentId, runModelChoice).catch(() => undefined),
      
      modelChoice: brainMeta?.modelChoice,
    };
    const session = createStreamSession();
    
    const chunkSender = createChunkSender();
    
    
    let cleanReply: string | undefined;
    

    let hadError = false;
    
    let ctxBuckets: CtxBuckets | undefined;
    
    const recorder = new TraceRecorder(cancelKey);
    
    const planSessionId = cancelKey;
    
    
    void (async () => {
      try {
        /* A-1197 · B3（L4c）：运行器解析 —— **显式 mode > brainstorm > agent-loop**。
           mode 可用性 = 该插件已装载（status loaded）且声明了 mode；不可用 ⇒ 回落 agent-loop，
           并把原因**写进对话**（不静默换模式；下一回合 resolveRunnerKind 也会自然回落）。 */
        const sessionMode = typeof brainMeta?.mode === "string" ? brainMeta.mode.trim() : "";
        let modeRec: { stages: Array<import("../../../core-ts/src/plugin/mode.js").StageDecl>; title: string } | null = null;
        let modeHost: { get: (n: string) => { status?: string } | undefined } | null = null;
        if (sessionMode) {
          try {
            const st = await ensurePluginHost();
            modeHost = st.host as unknown as { get: (n: string) => { status?: string } | undefined };
            const rec = st.host.get(sessionMode);
            if (rec?.status === "loaded" && rec.manifest.mode) {
              modeRec = {
                stages: rec.manifest.mode.stages,
                title: runnerLabel(`mode:${sessionMode}`, rec.manifest.mode.title),
              };
            }
          } catch { /* host 拿不到 ⇒ 当作不可用，走回落 */ }
        }
        const runnerKind = resolveRunnerKind({
          sessionMode,
          isBrainstorm,
          isModeAvailable: () => modeRec !== null,
        });
        if (runnerKind.fellBack) {
          chunkSender.push(toStreamChunk({ seq: -1, type: "notice", data: { text: `${runnerKind.reason}。` } }, cancelKey));
        }
        /** 阶段边界检查：插件在本回合中途被停用 ⇒ 收束（不静默换模式）。 */
        const canContinueStage = (): boolean => {
          if (!sessionMode || !modeHost) { return true; }
          const r = modeHost.get(sessionMode);
          return !!r && r.status === "loaded";
        };
        const evSource = modeRec
          ? streamStageFlow({
              chatService: chatService!,
              agentId,
              goal: req.message,
              stages: modeRec.stages,
              modeTitle: modeRec.title,
              signal: controller.signal,
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(brainMeta?.modelChoice ? { modelChoice: brainMeta.modelChoice } : {}),
              ...(input.networkEnabled !== undefined ? { networkEnabled: input.networkEnabled } : {}),
              canContinue: canContinueStage,
              availableTools: async () => (chatService ? await chatService.availableToolsFor(agentId) : undefined),
            })
          : isBrainstorm
          ? streamGroupTalkFlow({
              engine: engine!, 
              
              
              members: await (async () => {
                const modelMap = memberModelsOf(brainMeta!.members);
                const modelEntries: Array<[string, string]> = [...Object.entries(modelMap)];
                if (typeof brainMeta!.leaderModel === "string" && brainMeta!.leaderModel) { modelEntries.push([loadingAgent!.id, brainMeta!.leaderModel]); }
                const modelCaps = await Promise.all(modelEntries.map(async ([id, model]) => [id, await resolveSessionWindowCap("", model)] as const));
                const capBy = new Map(modelCaps);
                
                
                
                
                
                const participantIds = groupParticipantIds(loadingAgent?.id, memberIdsOf(brainMeta!.members));
                
                
                
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
          
          if (ev.type === "tool") {
            const t = (ev.data ?? {}) as Record<string, unknown>;
            markMainActivity(`tool ${String(t.name ?? "?")}`);
          }
          if (planSessionId) { interceptPlanTool(ev, planSessionId); }
          if (ev.type === "done") {
            const d = (ev.data ?? {}) as Record<string, unknown>;
            if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            
            if (d && typeof d === "object" && "ctxBuckets" in d) { ctxBuckets = d.ctxBuckets as CtxBuckets; }
          }
          const chunk = toStreamChunk(ev, cancelKey);
          session.pushChunk(chunk);
          
          chunkSender.push(chunk);
        }
        if (input.sessionId) {
          await touchSessionWithMessage(input.sessionId, input.message).catch(() => undefined);
        }
        try {
          
          chunkSender.flush();
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("slime:chat:done", {
              reply: cleanReply ?? session.fullReply, model: session.model,
              elapsedMs: session.elapsedMs, timings: session.timings,
              interrupted: controller.signal.aborted,
              sessionId: cancelKey,
              
              
              
              windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
              ctxBuckets,
            });
            
            
            mainWindow.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
            
            
            if (!controller.signal.aborted) {
              notifyUser({
                kind: "done",
                title: `${agentNameForNotify(agentId)} 已完成`,
                body: (cleanReply ?? session.fullReply ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || "任务已结束",
              });
            }
          }
        } catch {  }
        
        const traced = recorder.finish(true);
        traceStoreSet(cancelKey, traced);
        try {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: traced });
          }
        } catch {  }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        hadError = true; 
        console.error("[gui:main] chat stream error:", msg);
        
        chunkSender.flush();
        
        try {
          const logDir = resolveExtra("../data/logs");
          mkdirSync(logDir, { recursive: true });
          writeFileSync(join(logDir, "chat-errors.log"), `${new Date().toISOString()}\t${cancelKey}\t${msg}\n`, { flag: "a" });
        } catch {  }
        mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: cancelKey });
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
        
        notifyUser({
          kind: "error",
          title: `${agentNameForNotify(input.agentId)} 出错`,
          body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "生成过程中发生错误",
        });
        
        const failedTrace = recorder.finish(false, msg);
        traceStoreSet(cancelKey, failedTrace);
        mainWindow?.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: failedTrace });
      } finally {
        
        chunkSender.dispose();
        



        clearSteers(cancelKey);
        






        const superseded = activeChats.get(cancelKey) !== controller;
        activeChats.delete(cancelKey);
        
        
        
        
        if (agentStreamSessionMap.get(input.agentId) === cancelKey) {
          agentStreamSessionMap.delete(input.agentId);
        }
        
        
        mainWindow?.webContents.send("slime:model:loading", { loading: false });
        

        if (shouldClearTodosOnTurnEnd({
          reason: controller.signal.aborted ? "cancelled" : hadError ? "error" : "done",
          stillActive: superseded,
        })) {
          clearTodosOnTurnEnd(input.sessionId);
        }
        


        broadcastAgentProcs();
      }
    })();
    return { ok: true };
    } catch (e: unknown) {
      
      
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] chat stream setup error:", msg);
      mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: input.sessionId });
      mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: input.sessionId });
      
      notifyUser({
        kind: "error",
        title: "请求未能开始",
        body: msg.replace(/\s+/g, " ").trim().slice(0, 160) || "发送阶段发生错误",
      });
      return { ok: false, error: msg };
    }
  });

  
  handleTrusted<{ key?: string }>("slime:chat:cancel", async (_event, payload) => {
    const active = activeChats.get(payload.key ?? "");
    if (!active) {
      return { ok: false, error: "无进行中的对话可取消", active: activeChats.size };
    }
    active.abort();
    
    
    try {
      const key = payload.key ?? "";
      if (key && demoteStaleInProgress(key) > 0) { broadcastTodos(key); }
    } catch {  }
    return { ok: true, active: activeChats.size };
  });

  











  handleTrusted<{ sessionId?: string; id?: string; text?: string }>("slime:chat:steer", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const pending = pushSteer(sid, { id: String(payload?.id ?? ""), text: String(payload?.text ?? "") });
    if (pending === 0) {
      
      return { ok: false, error: "引导内容为空或会话无效" };
    }
    return { ok: true, pending };
  });

  











  handleTrusted<{ sessionId?: string; id?: string }>("slime:chat:steer:dismiss", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const dropped = dropSteer(sid, String(payload?.id ?? ""));
    return { ok: true, dropped };
  });

  



  handleTrusted<{ key?: string }>("slime:chat:isActive", async (_event, payload): Promise<{ active: boolean }> => {
    const key = payload.key ?? "";
    
    
    if (activeChats.has(key)) { return { active: true }; }
    for (const mapKey of activeChats.keys()) {
      if (mapKey === key) { return { active: true }; }
    }
    for (const [, boundKey] of agentStreamSessionMap) {
      if (boundKey === key) { return { active: true }; }
    }
    return { active: false };
  });

  


  let compressBreaker: BreakerState = INITIAL_BREAKER;

  
  function historyFingerprint(messages: LoopMessage[]): string {
    let chars = 0;
    for (const m of messages) { chars += typeof m.content === "string" ? m.content.length : 0; }
    return `${messages.length}:${chars}`;
  }

  













  handleTrusted<{ sessionId?: string; ratio?: number; used?: number; force?: boolean }>("slime:chat:compress", async (_event, p): Promise<CompressResult> => {
    let sessionId = "";
    try {
      sessionId = (p?.sessionId ?? "").trim();
      if (!sessionId) { return { ok: false, error: "缺少会话 ID" }; }
      const meta = await getSession(sessionId);
      if (!meta) { return { ok: false, error: "会话不存在" }; }
      const force = p?.force === true;
      const agent = await agentRegistry!.findAgent(meta.agentId).catch(() => null);
      

      const capRaw = await resolveSessionWindowCap(meta.agentId, effectiveModelChoice(meta.modelChoice, agent?.model_choice)).catch(() => undefined);
      const cap = capRaw ?? (agent?.max_context ?? 0);
      








      const { raw: historyAll, meta: histMeta } = await loadRawHistoryWithMeta(sessionId, { full: true });
      const historyView = foldSessionHistory(historyAll, histMeta);
      



      if (historyAll.length < 6) {
        return { ok: true, skipped: true, reason: "历史过短（不足 6 条），压缩无意义", used: 0, cap, ...(force ? { stillOverflow: true } : {}) };
      }
      
      
      
      
      
      const histUsed = estimateHistoryTokens(historyView);
      const hint = typeof p?.used === "number" && Number.isFinite(p.used) && p.used > 0 ? Math.round(p.used) : 0;
      const used = Math.max(histUsed, hint);
      const ratio = typeof p?.ratio === "number" && p.ratio > 0 ? p.ratio : DEFAULT_COMPRESS_RATIO;
      
      
      
      
      
      const noRoomToCut = historyAll.length <= DEFAULT_TAIL_KEEP * 2 + 2;
      








      const plan = planSend({
        estimatedInput: used,
        cap,
        afterOverflow: force,
        
        
        
        ratioTriggered: needsCompress(used, cap, ratio, countTurns(historyAll)),
        canShrink: !noRoomToCut,
      });
      if (plan.action === "cannot-fit") {
        
        
        const rescue = await suggestWiderChatModel(used, cap);
        console.warn(`[gui:main] 上下文估算门拦截（拒发）：${plan.reason}`);
        return {
          ok: true, skipped: true, used, cap, stillOverflow: true, cannotFit: true,
          rescueHint: formatRescueHint(rescue),
          
          
          ...(rescue ? { rescueModel: rescue } : {}),
          reason: formatCannotFit(plan, rescue),
        };
      }
      if (plan.action === "ok") {
        return { ok: true, skipped: true, used, cap, reason: plan.reason };
      }
      
      const key = historyFingerprint(historyAll);
      if (compressBreaker.open && compressBreaker.lastKey === sessionId) {
        return {
          ok: true, skipped: true, used, cap, breakerOpen: true,
          ...(force ? { stillOverflow: true } : {}),
          reason: `压缩已熔断（同一会话连续 ${compressBreaker.failures} 次压缩失败）：本段历史无法靠压缩救回，请换窗口更大的模型，或开一个新会话`,
        };
      }
      const startGen = meta.summaryGeneration ?? 0;
      const keep = DEFAULT_TAIL_KEEP;
      
      
      const budget = cap > 0 ? Math.max(2048, Math.min(SUMMARIZE_INPUT_CAP, Math.floor(cap * 0.5))) : 8000;
      let summaryText: string | null = null;
      let comprehend: string | null = null;
      let summaryElided = 0;
      let summaryTruncated = false;
      if (agent && engine) {
        const s = await engine.summarizeContext(agent, historyAll, { maxInputTokens: budget, priorSummary: meta.contextSummary });
        if (s) {
          summaryText = s.summary;
          summaryElided = s.elided;
          summaryTruncated = s.truncated;
          
          
          
          
          
          if (s.elided > 0 || s.truncated) {
            console.warn(
              `[gui:main] 摘要不完整（丢记忆风险）：elided=${s.elided} 条中段消息未进摘要、` +
              `truncated=${s.truncated}（输出被腰斩）。摘要仍会写入，但早期细节可能缺失。`,
            );
          }
          
          let c = await engine.comprehendContext(agent, s.summary);
          if (!c) { c = await engine.comprehendContext(agent, s.summary); }
          comprehend = c?.comprehend ?? null;
        }
      }
      
      const fresh = await getSession(sessionId);
      if (fresh && !acceptSummary(startGen, fresh.summaryGeneration ?? 0)) {
        return { ok: true, skipped: true, used, cap, stale: true, reason: "本次压缩结果已过期（期间已有更新的压缩落地），已丢弃以避免覆盖" };
      }
      let rejectReason = "";
      if (summaryText !== null) {
        const gate = gateCompaction({ before: historyView, raw: historyAll, summary: summaryText, comprehend, keep });
        const committed = await commitCompactionIfShrunk(gate, () => setSessionSummary(sessionId, summaryText, keep, { comprehend }));
        if (!committed) {
          rejectReason = gate.reason;
          console.error(`[gui:main] 压缩产物未通过「必须真的变短」校验 ⇒ 拒绝落库：${rejectReason}`);
        }
      } else {
        await setSessionSummary(sessionId, summaryText, keep, { comprehend });
      }
      
      
      
      const after = await loadSessionHistory(sessionId, { full: true });
      
      
      
      const validation = validateHistory(after);
      if (!validation.ok) {
        console.error("[gui:main] 压缩产物未过硬不变量校验（I1/I3）:", validation.violations);
      }
      
      
      const fixedOverhead = Math.max(0, hint - histUsed);
      const tokensAfter = estimateHistoryTokens(after) + fixedOverhead;
      
      
      
      
      const realShrink = isRealShrink(used, tokensAfter);
      compressBreaker = nextBreakerState(compressBreaker, {
        ok: summaryText !== null && validation.ok && realShrink,
        historyKey: key,
        stableKey: sessionId,
      });
      const stillOverflow = cap > 0 && tokensAfter >= cap;
      



      const rescue = stillOverflow ? await suggestWiderChatModel(tokensAfter, cap) : null;
      const dropped = Math.max(0, historyAll.length - after.length);
      return {
        ok: true,
        ...(rejectReason
          ? {
            skipped: true,
            reason: `未落库：${rejectReason}。已丢弃本次摘要，历史保持原样；连续发生会触发熔断，请换窗口更大的模型或开一个新会话。`,
          }
          : {
            summary: summaryText ?? undefined,
            truncated: summaryText === null,
            comprehend: comprehend ?? undefined,
            dropped,
          }),
        used,
        cap,
        tokensAfter,
        stillOverflow,
        ...(stillOverflow ? { rescueHint: formatRescueHint(rescue) } : {}),
        
        ...(stillOverflow && rescue ? { rescueModel: rescue } : {}),
        realShrink,
        elided: summaryElided,
        summaryTruncated,
      };
    } catch (e) {
      console.error("[gui:main] chat:compress crashed:", e);
      compressBreaker = nextBreakerState(compressBreaker, { ok: false, stableKey: sessionId });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  
  handleTrusted<{ agentId: string }>("slime:chat:new", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    const { clearHistoryForAgentExport } = await import("../../../core-ts/src/services/history.js");
    await clearHistoryForAgentExport(agentId);
    console.info(`[gui:main] 新建会话: agent=${agentId}`);
    return { ok: true };
  });

  
  handleTrusted<{ agentId: string; sessionId?: string; userMsg: string }>("slime:history:truncateFrom", async (_event, payload) => {
    if (!payload || typeof payload.userMsg !== "string" || !payload.agentId) {
      return { ok: false, error: "参数不完整" };
    }
    const { truncateHistoryFromExport } = await import("../../../core-ts/src/services/history.js");
    const removed = await truncateHistoryFromExport(payload.agentId, payload.sessionId, payload.userMsg);
    console.info(`[gui:main] 回滚截断历史：agent=${payload.agentId} 会话=${payload.sessionId ?? "-"} 删除 ${removed} 条`);
    return { ok: true, removed };
  });

  













  handleTrusted<{ agentId: string; sessionId?: string; userMsg: string; mode?: "plan" | "apply" }>(
    "slime:file:undo", async (_event, payload) => {
      if (!payload || typeof payload.userMsg !== "string" || !payload.agentId) {
        return { ok: false, error: "参数不完整" };
      }
      const svc = await import("../../../core-ts/src/services/file_undo.js");
      if (payload.mode === "plan") {
        const plan = await svc.planFileUndo(payload.agentId, payload.sessionId, payload.userMsg);
        if (plan.count || plan.dirs || plan.blocked.length) {
          console.info(`[gui:main] 回滚预演：还原 ${plan.count} 个文件 / 重建 ${plan.dirs} 个目录 / ${plan.blocked.length} 处不可还原`);
        }
        return plan;
      }
      const res = await svc.applyFileUndo(payload.agentId, payload.sessionId, payload.userMsg);
      console.info(`[gui:main] 回滚文件：还原 ${res.restored} / 删除 ${res.deleted} / 重建目录 ${res.dirs} / 失败 ${res.failed.length} / 不可还原 ${res.blocked.length}`);
      return res;
    });

  
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:chat:retry", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId || resolveAgentId(undefined);
    
    const { popLastRecordForAgentExport } = await import("../../../core-ts/src/services/history.js");
    const last = await popLastRecordForAgentExport(agentId, payload.sessionId);
    if (!last || !last.user) {
      return { ok: false, error: "无历史可重试" };
    }
    
    const retryMeta = payload.sessionId ? await getSession(payload.sessionId).catch(() => null) : null;
    const req: ChatRequest = {
      message: last.user,
      history: await loadSessionHistory(payload.sessionId),
      retry: true,
      sessionId: payload.sessionId,
      

      

      windowCap: await resolveSessionWindowCap(
        agentId,
        effectiveModelChoice(retryMeta?.modelChoice, (await agentRegistry!.findAgent(agentId).catch(() => null))?.model_choice),
      ).catch(() => undefined),
      modelChoice: retryMeta?.modelChoice,
    };
    const session = createStreamSession();
    
    const chunkSender = createChunkSender();
    
    const retryCancelKey = payload.sessionId ?? agentId;
    agentStreamSessionMap.set(agentId, retryCancelKey);
    lastChatCancelKey = retryCancelKey; 
    
    let cleanReply: string | undefined;
    
    let ctxBuckets: CtxBuckets | undefined;
    
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
            
            chunkSender.push(chunk);
          }
          
          chunkSender.flush();
          mainWindow?.webContents.send("slime:chat:done", {
            reply: cleanReply ?? session.fullReply, model: session.model,
            elapsedMs: session.elapsedMs, timings: session.timings,
            sessionId: payload.sessionId,
            
            windowCap: await resolveSessionWindowCap(agentId, session.model).catch(() => undefined),
            
            ctxBuckets,
          });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); 
          
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
          chunkSender.flush(); 
          mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: payload.sessionId });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); 
          
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
          chunkSender.dispose(); 
          
          if (agentStreamSessionMap.get(agentId) === retryCancelKey) {
            agentStreamSessionMap.delete(agentId);
          }
          
          mainWindow?.webContents.send("slime:model:loading", { loading: false });
        }
      })();
    });
  });

  

  
  handleTrusted<void>("slime:sessions:list", async () => {
    
    
    
    
    
    await ensureRegistry();
    const [metas, records] = await Promise.all([
      listSessions(),
      loadHistory(null, 100000),
    ]);
    const names = new Map((agentRegistry?.loadedAgents ?? []).map((a) => [a.id, a.name]));
    
    const byKey = new Map<string, { agentId: string; count: number; firstUser: string; lastTime: string }>();
    for (const r of records) {
      const key = `${r.agent_id}::${r.session_id ?? "default"}`;
      const agg = byKey.get(key) ?? { agentId: r.agent_id, count: 0, firstUser: "", lastTime: "" };
      agg.count += 1;
      if (!agg.firstUser) { agg.firstUser = r.user; }
      if (r.timestamp > agg.lastTime) { agg.lastTime = r.timestamp; }
      byKey.set(key, agg);
    }
    const items: Array<{ sessionId: string; agentId: string; agentName: string; workspace?: string; title: string; count: number; lastTime: string; memberIds?: string[]; memberNames?: string[]; memberModels?: Record<string, string>; leaderModel?: string; memberEfforts?: Record<string, string>; leaderEffort?: string; type?: "normal" | "brainstorm"; modelChoice?: string; mode?: string }> = [];
    for (const meta of metas) {
      
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
        
        modelChoice: meta.modelChoice,
        memberEfforts: memberEffortsOf(meta.members),
        leaderEffort: meta.leaderEffort,
        type: meta.type,
        mode: meta.mode,
      });
    }
    
    for (const [key, agg] of byKey) {
      const agentId = key.split("::")[0];
      if (!metas.some((m) => m.agentId === agentId)) {
        
        
        
        
        
        
        if (!names.has(agentId)) {
          console.warn(
            `[gui:main] 跳过孤儿历史的会话迁移：Agent「${agentId}」不存在（${agg.count} 条记录，跳过会话）`,
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
          title: meta.title === "新会话" ? (agg.firstUser || "新会话").slice(0, 60) : meta.title,
          count: agg.count,
          lastTime: agg.lastTime,
          memberIds,
          memberNames: memberIds.map((id) => names.get(id) ?? id),
        });
      }
    }
    return items.sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1));
  });

  




  handleTrusted<{ agentId?: string; title?: string; workspace?: string | null; memberIds?: MemberEntry[]; leaderModel?: string; type?: "normal" | "brainstorm" }>("slime:sessions:create", async (_event, payload) => {
    await ensureServices();
    let aid = payload.agentId;
    
    if (!aid) {
      const roots = agentRegistry!.loadedAgents.filter((a) => !a.parent_id);
      const fallback = roots[0] ?? agentRegistry!.loadedAgents[0];
      if (fallback) {
        aid = fallback.id;
      } else {
        
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
        
        modelChoice: meta.modelChoice,
        memberEfforts: memberEffortsOf(meta.members),
        leaderEffort: meta.leaderEffort,
        type: meta.type,
      },
    };
  });

  
  handleTrusted<{ sessionId: string; type?: "normal" | "brainstorm" }>("slime:sessions:setType", async (_event, payload) => {
    if (!payload?.sessionId) { return { ok: false, error: "sessionId 必填" }; }
    const meta = await setSessionType(payload.sessionId, payload.type === "brainstorm" ? "brainstorm" : null);
    return { ok: !!meta, sessionId: payload.sessionId, type: meta?.type ?? "normal" };
  });

  /* A-1197 · B3（L4c）：设置会话的**显式运行模式**（= 提供 mode 的插件名；空串 = 清除回默认）。
     只写 meta（请求组装时读）——下一轮请求立即生效，不需重启（与 loop_config 同口径）。 */
  handleTrusted<{ sessionId: string; mode?: string }>(IPC_CHANNELS.sessions_set_mode, async (_event, payload) => {
    if (!payload?.sessionId) { return { ok: false as const, error: "sessionId 必填" }; }
    const meta = await setSessionMode(payload.sessionId, (payload.mode ?? "").trim() || null);
    return { ok: !!meta, sessionId: payload.sessionId, mode: meta?.mode ?? "" };
  });

  
  handleTrusted<{ sessionId: string; title: string }>("slime:sessions:rename", async (_event, payload) => {
    await ensureServices();
    const meta = await renameSession(payload.sessionId, payload.title);
    return { ok: !!meta };
  });

  
  handleTrusted<{ sessionId: string }>("slime:sessions:remove", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    const removed = await removeSession(payload.sessionId);
    if (meta) {
      await clearSessionHistory(meta.agentId, meta.id);
      
      
      
      const rest = (await listSessions()).filter((s) => s.agentId === meta.agentId);
      if (rest.length === 0) {
        const purged = await clearLegacySessionHistory(meta.agentId);
        if (purged > 0) {
          console.info(`[gui:main] 会话删除时清理遗留历史（无 session_id）: agent=${meta.agentId} 条数=${purged}`);
        }
      }
    }
    
    
    purgeSessionPlanning(payload.sessionId);
    console.info(`[gui:main] 会话已删除: session=${payload.sessionId}`);
    return { ok: removed };
  });

  













  const historyRecordToMessages = (
    r: HistoryRecord,
    groupNames?: ReadonlySet<string>,
  ): ExpandedMessage[] => expandHistoryRecord(r, groupNames);

  
  const groupNamesOf = async (meta: { id?: string; type?: string; members?: unknown }): Promise<ReadonlySet<string> | undefined> => {
    if (meta.type !== "brainstorm") { return undefined; }
    try {
      const ids = memberIdsOf(meta.members as MemberEntry[] | undefined);
      const agents = await Promise.all(ids.map((id) => agentRegistry!.findAgent(id).catch(() => null)));
      const names = agents.filter((a): a is AgentState => a !== null).map((a) => a.name);
      
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

  
  handleTrusted<{ sessionId: string }>("slime:sessions:load", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return []; }
    const metas = await listSessions();
    const agentSessions = metas.filter((m) => m.agentId === meta.agentId);
    
    const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
    const records = await loadHistoryForSession(meta.agentId, meta.id, 500, firstSession);
    const groupNames = await groupNamesOf(meta);
    return records.flatMap((r) => historyRecordToMessages(r, groupNames));
  });

  
  handleTrusted<{ sessionId: string; beforeTs: string; limit?: number }>("slime:sessions:loadEarlier", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return { messages: [], hasMore: false }; }
    const metas = await listSessions();
    const agentSessions = metas.filter((m) => m.agentId === meta.agentId);
    
    const firstSession = agentSessions.every((s) => s.createdAt >= meta.createdAt);
    const { records, hasMore } = await loadHistoryForSessionBefore(
      meta.agentId, meta.id, payload.limit ?? 200, firstSession, payload.beforeTs,
    );
    const groupNames = await groupNamesOf(meta);
    return { messages: records.flatMap((r) => historyRecordToMessages(r, groupNames)), hasMore };
  });

  
  handleTrusted<{ agentId: string; sessionId: string; timeline: unknown[] }>("slime:chat:attachTimeline", async (_event, p) => {
    try {
      await attachTimelineToRecord(p.agentId, p.sessionId, (p.timeline as HistoryRecord["timeline"]) ?? []);
      return { ok: true };
    } catch (e) {
      console.warn("[gui:main] attachTimeline 失败:", e instanceof Error ? e.message : String(e));
      return { ok: false };
    }
  });

  
  handleTrusted<{ sessionId: string }>("slime:sessions:clear", async (_event, payload) => {
    await ensureServices();
    const meta = await getSession(payload.sessionId);
    if (!meta) { return { ok: false }; }
    await clearSessionHistory(meta.agentId, meta.id);
    console.info(`[gui:main] 会话已清空: session=${payload.sessionId}`);
    return { ok: true };
  });

  



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

  
  handleTrusted<{ agentId: string; sessionId?: string }>("slime:sessions:configGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const ov = agent?.sandbox_override;
    const globalDefault = getPermissions().globalApproval;
    const agentWorkspace = (ov && typeof ov === "object" && typeof ov.workspace === "string") ? ov.workspace : "";
    
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

  


  handleTrusted<{ sessionId: string; memberId: string; effort: string | null }>("slime:sessions:setMemberEffort", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionMemberEffort(payload.sessionId, payload.memberId, payload.effort ?? null);
    if (!updated) { throw new Error("会话不存在或该成员不在群聊中"); }
    const eff = payload.effort ? payload.effort : "(默认 high)";
    console.info(`[gui:main] 群聊成员推理强度: session=${payload.sessionId} member=${payload.memberId} → ${eff}`);
    return { ok: true, memberEfforts: memberEffortsOf(updated.members), leaderEffort: updated.leaderEffort };
  });

  
  handleTrusted<{ sessionId: string; workspace: string | null }>("slime:sessions:setWorkspace", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionWorkspace(payload.sessionId, payload.workspace);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话工作目录更新: session=${payload.sessionId} → ${updated.workspace ?? "(未绑定)"}`);
    return { ok: true, workspace: updated.workspace };
  });

  








  handleTrusted<{ sessionId: string; modelChoice: string | null }>("slime:sessions:setModelChoice", async (_event, payload) => {
    await ensureServices();
    const updated = await setSessionModelChoice(payload.sessionId, payload.modelChoice);
    if (!updated) { throw new Error("会话不存在"); }
    console.info(`[gui:main] 会话模型更新: session=${payload.sessionId} → ${updated.modelChoice ?? "(跟随 Agent 默认)"}`);
    return { ok: true, modelChoice: updated.modelChoice ?? null };
  });

  
  handleTrusted<{ sessionId: string }>("slime:sessions:loadTodos", async (_event, payload) => {
    
    
    
    
    
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) {
      console.warn("[gui:main] loadTodos 收到空 sessionId，已拒绝（避免读到 todos_.json 这类孤儿文件）");
      return { ok: true, todos: [] };
    }
    
    
    
    
    
    if (!staleChecked.has(sid)) {
      staleChecked.add(sid);
      if (!activeChats.has(sid)) {
        const n = demoteStaleInProgress(sid);
        if (n > 0) {
          console.warn(`[gui:main] 待办收敛：会话 ${sid} 有 ${n} 项停在"进行中"但没有活跃流，已降级为待办（A-985）`);
        }
      }
    }
    
    const todos = readTodos(sid);
    
    
    
    
    
    
    if (allTodosCompleted(todos)) {
      removeTodos(sid);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("slime:tasks:todos", { sessionId: sid, todos: [] });
      }
      return { ok: true, todos: [] };
    }
    
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("slime:tasks:todos", { sessionId: sid, todos });
    }
    return { ok: true, todos };
  });

  











  handleTrusted<{ sessionId?: string; todos?: unknown[] }>("slime:tasks:saveTodos", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) { return { ok: false, error: "会话未就绪，无法保存待办" }; }
    if (!Array.isArray(payload?.todos)) { return { ok: false, error: "todos 必须是数组" }; }
    
    const saved = writeTodos(sid, payload.todos as Parameters<typeof writeTodos>[1]);
    if (!saved) { return { ok: false, error: "写入失败（路径不可写或会话无效）" }; }
    
    broadcastTodos(sid);
    return { ok: true, todos: saved };
  });

  







  handleTrusted<{ sessionId?: string }>("slime:tasks:clearTodos", async (_event, payload) => {
    const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    if (!sid) { return { ok: false }; }
    removeTodos(sid);
    staleChecked.add(sid); 
    broadcastTodos(sid);
    return { ok: true };
  });

  
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

  
  handleTrusted<{ agentId: string }>("slime:sessions:removeAgent", async (_event, payload) => {
    await ensureServices();
    const agentId = payload.agentId;
    
    
    const doomed = (await listSessions()).filter((s) => s.agentId === agentId).map((s) => s.id);
    await removeSessionsForAgent(agentId);
    await removeAgentHistory(agentId);
    for (const sid of doomed) { purgeSessionPlanning(sid); }
    console.info(`[gui:main] 项目已删除（会话+历史+待办清理）: agent=${agentId} sessions=${doomed.length}`);
    return { ok: true };
  });

  
  handleTrusted<{ workspace: string }>("slime:sessions:removeWorkspace", async (_event, payload) => {
    await ensureServices();
    const workspace = payload.workspace;
    const removed = await removeSessionsForWorkspace(workspace);
    for (const s of removed) {
      try { await clearSessionHistory(s.agentId, s.sessionId); } catch {  }
      
      purgeSessionPlanning(s.sessionId);
    }
    
    
    const rest = await listSessions();
    for (const aid of new Set(removed.map((s) => s.agentId))) {
      if (rest.some((s) => s.agentId === aid)) { continue; }
      try {
        const purged = await clearLegacySessionHistory(aid);
        if (purged > 0) {
          console.info(`[gui:main] 工作文件夹删除时清理遗留历史（无 session_id）: agent=${aid} 条数=${purged}`);
        }
      } catch {  }
    }
    console.info(`[gui:main] 工作文件夹会话已删除: workspace=${workspace} count=${removed.length}`);
    return { ok: true, count: removed.length };
  });

  
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

  
  handleTrusted<void>("slime:permissions:get", async () => getPermissions());

  
  handleTrusted<Record<string, unknown>>("slime:permissions:set", async (_event, patch) => {
    const { ok, permissions, error } = setPermissions(patch);
    if (!ok) { return { ok: false, permissions, error }; }
    if (patch.globalApproval !== undefined || patch.approvalAllowPaths !== undefined) {
      try {
        
        
        const agents = agentRegistry!.loadedAgents;
        for (const a of agents) {
          const ov = (a.sandbox_override && typeof a.sandbox_override === "object")
            ? { ...(a.sandbox_override as Record<string, unknown>) }
            : {};
          const next: Record<string, unknown> = { ...ov, approval: permissions.globalApproval };
          await agentRegistry!.updateAgent(a.id, { sandbox_override: next });
        }
      } catch (e) {
        console.error("[gui:main] sync global approval to agents failed:", e);
      }
      
      applyGlobalSandboxDefaults();
    }
    return { ok: true, permissions };
  });

  
  handleTrusted<PermissionDecision>("slime:perm:resolve", async (_event, decision: PermissionDecision) => {
    const resolver = pendingPerms.get(decision.requestId);
    if (!resolver) {
      return { ok: false, error: "请求不存在或已超时" };
    }
    pendingPerms.delete(decision.requestId);
    resolver(decision);
    return { ok: true };
  });

  
  handleTrusted<AskUserDecision>("slime:ask:resolve", async (_event, decision: AskUserDecision) => {
    if (!askCoordinator.resolve(decision.requestId, decision)) {
      return { ok: false, error: "请求不存在或已超时" };
    }
    return { ok: true };
  });

  
  handleTrusted<void>("slime:extras:mcpList", async () => {
    await ensureServices();
    const { listMcpServers } = await import("./config_files.js");
    return listMcpServers();
  });

  
  handleTrusted<{ name: string; enabled: boolean }>("slime:extras:mcpToggle", async (_event, p) => {
    const res = setMcpEnabled(p.name, p.enabled);
    return res;
  });

  
  handleTrusted<void>("slime:extras:skillList", async () => {
    await ensureServices();
    const { listSkills } = await import("./config_files.js");
    return listSkills();
  });


  handleTrusted<void>(IPC_CHANNELS.plugins_list, async (): Promise<PluginSnapshotDTO> => {
    const state = await ensurePluginHost();
    return snapshotPlugins(state);
  });

  handleTrusted<void>(IPC_CHANNELS.plugins_reload, async (): Promise<PluginSnapshotDTO> => {
    const state = await reloadPlugins();
    return snapshotPlugins(state);
  });

  /* ── A-1197 · B1（L4b 设置贡献点）─────────────────────────────────────────────
     设置项的读/ 写。两条硬边界写在代码里而不是文档里：
       ① **入参只有 plugin / key / value** —— 没有 path。落盘位置由 `plugin.name`
          在 settings-store 里推导（并在那里独立 assert 一次名字合法性）。
       ② 读写都先过 `host.get(name)?.status === "loaded"`：未装载 / 已禁用 / 装载失败
          一律拒 —— 关掉的插件不能被偷偷改设置，界面上的设置区也随插件一起被摘掉。
  */
  const readPluginSettingsFor = async (
    name: string,
  ): Promise<{ ok: true; dto: PluginSettingsDTO } | { ok: false; error: string }> => {
    const state = await ensurePluginHost();
    const record = state.host.get(name);
    if (!record) {
      return { ok: false, error: `插件未装载：${name}` };
    }
    if (record.status !== "loaded") {
      return { ok: false, error: `插件未装载或已停用（status=${record.status}）：${name}` };
    }
    return pluginSettingsService(state).get(name);
  };

  handleTrusted<{ plugin: string }>(IPC_CHANNELS.plugins_settings_get, async (_event, p) => {
    const name = String(p?.plugin ?? "").trim();
    if (!name) {
      return { ok: false, error: "缺少插件名" };
    }
    return readPluginSettingsFor(name);
  });

  handleTrusted<{ plugin: string; key: string; value: unknown }>(IPC_CHANNELS.plugins_settings_set, async (_event, p) => {
    const name = String(p?.plugin ?? "").trim();
    if (!name) {
      return { ok: false, error: "缺少插件名" };
    }
    const key = String(p?.key ?? "").trim();
    if (!key) {
      return { ok: false, error: "缺少设置项 key" };
    }
    const state = await ensurePluginHost();
    const record = state.host.get(name);
    if (!record) {
      return { ok: false, error: `插件未装载：${name}` };
    }
    if (record.status !== "loaded") {
      return { ok: false, error: `插件未装载或已停用（status=${record.status}）：${name}` };
    }
    const result: PluginSettingsWriteDTO = pluginSettingsService(state).set(name, key, p?.value);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, dto: result.dto, warnings: result.warnings };
  });

  /* A-1197 · B2（L4a UI 贡献点）：UI 槽位声明（按需拉 —— 列表接口只给 uiCount 计数）。
     数据源 = `pluginUiDecls`（activate 时 registerUi 写入、dispose 时移除）——
     只回「已接线」插件的槽位；跨插件冲突项已标 `conflict: true`（渲染层渲染成禁用态）。 */
  handleTrusted<void>(IPC_CHANNELS.plugins_ui, async (): Promise<PluginUiSnapshotDTO> => pluginUiSnapshot());

  /* A-1198：安装官方示例扩展（活教材）—— 从随包 `template/plugins/<name>` 复制到
     `<数据根>/config/plugins/<name>`，装完立即重扫（扩展页自己刷新）。
     已存在 ⇒ 拒绝覆盖（先卸载并删除再装 —— 示例只是起点，用户改过的东西不能被覆盖）。 */
  handleTrusted<void>(IPC_CHANNELS.plugins_install_example, async (): Promise<{ ok: boolean; snapshot?: PluginSnapshotDTO; error?: string }> => {
    const src = join(INSTALL_ROOT, "template", "plugins", EXAMPLE_PLUGIN_NAME);
    const dest = join(PLUGINS_ROOT, EXAMPLE_PLUGIN_NAME);
    if (!existsSync(src)) {
      return { ok: false, error: `随包示例扩展缺位（检查打包配置 extraFiles: template/plugins）：${src}` };
    }
    if (existsSync(dest)) {
      return { ok: false, error: `已存在同名扩展目录，不覆盖（如需重来：先卸载并删除该目录）：${dest}` };
    }
    try {
      cpSync(src, dest, { recursive: true });
    } catch (e) {
      return { ok: false, error: `复制失败：${e instanceof Error ? e.message : String(e)}` };
    }
    const state = await reloadPlugins();
    return { ok: true, snapshot: snapshotPlugins(state) };
  });

  /* A-1198：扩展页「保存并生效」—— 把草稿里的拨片 / 信任改动**一次写盘**（停用名单 + trust.json），
     然后**重扫装载 + 重装技能 + 广播**，让已打开的界面自己刷新。
     ⚠️ **刻意不退出进程**（用户口径：「我要的是重启不退出，要的是刷新 slime 的状态」）：
     早先这里做的是 `app.relaunch + app.exit`，用户明确否决——退出程序不是"刷新状态"。
     现在的生效点 = **一次写盘 + 一次重扫 + 一次广播**，进程与窗口全程不中断：
       · `reloadPlugins()` 自带「先撤销再重建」（host.load 会unload 旧贡献），
         所以停用的插件工具/技能/槽位/皮肤/脚本**真的被撤下**，不需要重启来兜；
       · `refreshAgentSkills()` 让技能贡献进Agent 上下文；
       · `broadcastContribRescan()` 让 UiSlotHost / SettingsDialog / PluginThemeHost /
         扩展页自身全量重算 —— 这正是原先"要刷页面"的根因（重扫只换主进程状态，
         渲染层不订阅广播就永远显示旧的）。
     任一条写失败 ⇒ ok:false 并带回原因（界面保留草稿，可重试；写盘都是幂等的）。 */
  handleTrusted<{ toggles?: unknown; trust?: unknown }>(IPC_CHANNELS.plugins_apply_changes, async (_event, p) => {
    const state = await ensurePluginHost();
    const applied = { toggles: 0, trust: 0 };
    const errors: string[] = [];
    const toggles = Array.isArray(p?.toggles) ? (p.toggles as unknown[]) : [];
    for (const raw of toggles) {
      const t = raw as { name?: unknown; enabled?: unknown };
      const name = String(t?.name ?? "").trim();
      if (!name) { errors.push("拨片改动缺 name"); continue; }
      const rec = state.host.get(name);
      if (!rec) { errors.push(`插件不在清单里，跳过：${name}`); continue; }
      if (!rec.unloadable) { errors.push(`系统默认插件不可停用：${name}`); continue; }
      try {
        if (t?.enabled === true) { unmarkPluginDisabled(PLUGINS_DISABLED_FILE, name); }
        else { markPluginDisabled(PLUGINS_DISABLED_FILE, name); }
        applied.toggles += 1;
      } catch (e) {
        errors.push(`停用名单写入失败（${name}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const trusts = Array.isArray(p?.trust) ? (p.trust as unknown[]) : [];
    for (const raw of trusts) {
      const t = raw as { name?: unknown; trusted?: unknown };
      const name = String(t?.name ?? "").trim();
      if (!name) { errors.push("信任改动缺 name"); continue; }
      const dir = state.dirs.get(name);
      if (!dir) { errors.push(`插件没有磁盘目录（builtin 或未装载），跳过信任写入：${name}`); continue; }
      try {
        writePluginTrust(dir, t?.trusted === true);
        applied.trust += 1;
      } catch (e) {
        errors.push(`信任写入失败（${name}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (errors.length > 0) {
      return { ok: false as const, applied, error: errors.join("；") };
    }
    /* ── 写盘全成功 ⇒ 立刻生效（不退出进程）──────────────────────────────
       顺序有意为之：先全部写盘（失败可如实回报、界面保留草稿），再统一重扫。
       任一写失败就**不重扫** —— 半套状态比"什么都没变"更难解释。 */
    await runContribRescan("applyChanges");
    const next = await ensurePluginHost();
    return { ok: true as const, applied, snapshot: snapshotPlugins(next) };
  });

  /* A-1197 · B5（L4a page）：打开扩展自有页面 —— 按需起 `127.0.0.1` 静态服务
     （复用既有 `httpServer`；同一插件目录天然复用同一服务），返回渲染层要的 url。
     **绝不 `file://`**（§5.4 的明文口径）；服务生命周期见 registerPage 的 dispose。 */
  handleTrusted<{ name: string }>(IPC_CHANNELS.plugins_page_open, async (_event, p) => {
    const name = String(p?.name ?? "").trim();
    if (!name) { return { ok: false as const, error: "缺少插件名" }; }
    const state = await ensurePluginHost();
    const record = state.host.get(name);
    if (!record) { return { ok: false as const, error: `插件未装载：${name}` }; }
    if (record.status !== "loaded") { return { ok: false as const, error: `插件未装载或已停用（status=${record.status}）：${name}` }; }
    const page = record.manifest.contributes?.page;
    if (!page) { return { ok: false as const, error: `插件未声明页面（contributes.page）：${name}` }; }
    const dir = state.dirs.get(name);
    if (!dir) { return { ok: false as const, error: `插件没有磁盘目录：${name}` }; }
    const served = await httpServer.serve({ dir, host: "127.0.0.1", origin: "agent" });
    if (!served.ok || !served.urls?.[0]) {
      return { ok: false as const, error: `页面服务启动失败：${served.error ?? "未知原因"}` };
    }
    const base = served.urls[0].endsWith("/") ? served.urls[0] : `${served.urls[0]}/`;
    const entry = page.entry.replace(/\\/g, "/");
    return { ok: true as const, url: `${base}${entry}`, reused: served.reused === true };
  });

  
  handleTrusted<{ name: string; enabled: boolean }>("slime:extras:skillToggle", async (_event, p) => {
    const res = setSkillEnabled(p.name, p.enabled);
    return res;
  });

  
  handleTrusted<{ name: string }>("slime:extras:skillOpen", async (_event, p) => {
    const dir = skillDirPath(p.name);
    if (!existsSync(dir)) {
      return { ok: false, error: `技能目录不存在：${dir}` };
    }
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  });

  
  handleTrusted<{ name: string }>("slime:extras:skillDelete", async (_event, p) => {
    return deleteSkill(p.name);
  });

  
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

  
  handleTrusted<void>("slime:extras:mcpOpen", async () => {
    const root = PROJECT_ROOT;
    if (!existsSync(root)) {
      return { ok: false, error: `项目路径不存在：${root}` };
    }
    const err = await shell.openPath(root);
    return { ok: !err, error: err || undefined };
  });

  
  handleTrusted<{ name: string }>("slime:extras:mcpDelete", async (_event, p) => {
    return deleteMcp(p.name);
  });

  
  handleTrusted<{ name: string; kind: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string> }>(
    "slime:extras:mcpAdd",
    async (_event, p) => {
      const { addMcp } = await import("./config_files.js");
      return addMcp(p);
    },
  );

  
  handleTrusted<{ name: string; description: string; content?: string }>(
    "slime:extras:skillAdd",
    async (_event, p) => {
      const { addSkill } = await import("./config_files.js");
      return addSkill(p);
    },
  );

  
  handleTrusted<{ query?: string }>("slime:extras:skillMarketSearch", async (_event, p) => {
    const { searchSkillMarket } = await import("./config_files.js");
    return searchSkillMarket(p?.query ?? "");
  });

  
  handleTrusted<{ name: string }>("slime:extras:skillMarketInstall", async (_event, p) => {
    const { installSkillFromMarket } = await import("./config_files.js");
    return installSkillFromMarket(p?.name ?? "");
  });

  
  handleTrusted<void>("slime:extras:registryAuthGet", async () => {
    const { getRegistryAuth } = await import("./config_files.js");
    return getRegistryAuth();
  });

  
  handleTrusted<{ githubToken?: string }>("slime:extras:registryAuthSet", async (_event, p) => {
    const { setRegistryAuth } = await import("./config_files.js");
    return setRegistryAuth({ githubToken: p?.githubToken });
  });

  
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

    handleTrusted<void>("slime:runtime:list", async (): Promise<{
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
      
      items.push({ kind: "node", label: "Node.js", version: `v${process.versions.node}`, ok: true, source: "bundled", note: "GUI 由 Electron 内嵌 Node 驱动" });
      
      const pyExe = process.platform === "win32"
        ? resolveBundled("runtime/venv/Scripts/python.exe")
        : resolveBundled("runtime/venv/bin/python");
      const pyOk = existsSync(pyExe);
      items.push({ kind: "python", label: "Python（随包 venv）", path: pyExe, sizeText: fileSize(pyExe), ok: pyOk, source: pyOk ? "bundled" : "missing", ...(pyOk ? {} : { note: "缺少随包 venv——请重新运行 prepare-runtime 或重装" }) });
      
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
      
      const llamaExe = process.platform === "win32"
        ? resolveBundled("llama.cpp/build/bin/llama-server.exe")
        : resolveBundled("llama.cpp/build/bin/llama-server");
      const llamaOk = existsSync(llamaExe);
      items.push({
        kind: "llama", label: "llama.cpp（本地推理）", path: llamaExe, sizeText: fileSize(llamaExe), ok: llamaOk,
        source: llamaOk ? "bundled" : "missing",
        ...(llamaOk ? {} : { note: "缺失——请重新运行 prepare-runtime 下载，或到 设置→供应商→本地模型 配置" }),
      });
      
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
      } catch {  }
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
      
      try {
        const ad = await adbService.detect();
        if (ad.ok) {
          items.push({ kind: "adb", label: "ADB（Android 调试桥）", path: ad.path, version: ad.version, ok: true, source: ad.source || "system", note: "已就绪——可连接模拟器/安卓设备；服务未启动时可点右侧按钮" });
        } else {
          items.push({ kind: "adb", label: "ADB（Android 调试桥）", ok: false, source: "missing", note: "未检测到 adb——下载 platform-tools 后即可连接安卓设备/模拟器" });
        }
      } catch {  }
      
      
      for (const it of items) {
        if (it.ok) { continue; }
        if (it.kind === "llama") { it.action = { label: "下载 llama.cpp", kind: "download", target: "llama" }; }
        else if (it.kind === "models") { it.action = { label: "下载 BGE 模型", kind: "download", target: "bge" }; }
        else if (it.kind === "git") { it.action = { label: "下载 Git", kind: "openExternal", url: "https://git-scm.com/downloads" }; }
        
        else if (it.kind === "python") { it.action = { label: "下载 Python（装后再重建）", kind: "openExternal", url: "https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe" }; }
      }
      
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

  

  handleTrusted<void>("slime:runtime:installPython", async (): Promise<{ ok: boolean; log?: string; error?: string }> => {
    const venvDir = resolveBundled("runtime/venv");
    const reqFile = resolveBundled("requirements.txt");
    




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
      log.push(`安装失败：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, log: log.join("\n").slice(-4000), error: e instanceof Error ? e.message : String(e) };
    }
  });

  
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

  
  handleTrusted<{ rel: string; workspace: string; ref?: string }>(
    "slime:git:showFile",
    async (_event, p): Promise<{ ok: boolean; content?: string; error?: string; code?: "not-repo" | "no-head" | "not-found" }> => {
      const rel = (p?.rel ?? "").trim();
      const ws = (p?.workspace ?? "").trim();
      const ref = p?.ref || "HEAD";
      if (!rel || !ws) { return { ok: false, error: "缺少参数" }; }
      











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
        
        if (/exists on disk, but not in|did not match any file|path .* unknown revision/i.test(r.stderr)) {
          return { ok: true, content: "" };
        }
        
        if (/does not have any commits yet|unknown revision or path not in the working tree/i.test(r.stderr)) {
          return {
            ok: false,
            code: "no-head",
            error: `「${ws}」是 Git 仓库但还没有任何提交，没有可对比的 HEAD 版本。先提交一次再对比。`,
          };
        }
        return { ok: false, error: r.stderr.slice(0, 300) || `git show 失败（${r.code}）` };
      }
      return { ok: true, content: r.stdout };
    },
  );

  
  
  setAdbService(adbService);

  
  


  setTrashService({
    trash: async (absPath: string) => {
      try {
        await shell.trashItem(absPath);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  
  
  setHttpServer(httpServer);
  
  try {
    const persistPath = join(app.getPath("userData"), "http_servers.json");
    httpServer.setPersistPath(persistPath);
    void httpServer.restore().then((r) => {
      if (r.restored > 0 || r.failed > 0) {
        console.log(`[slime] HTTP 静态服务恢复：成功 ${r.restored}，失败 ${r.failed}`);
      }
    }).catch(() => {  });
  } catch {  }

  




  setSidebarOpener((req, name): void => {
    const payload = normalizeSidebarOpenRequest(req, name);
    if (!payload) { return; }
    mainWindow?.webContents.send("slime:sidebar:open", payload);
  });

  





  ipcMain.on("slime:sidebar:mount", (_e, payload: { sessionId?: string; text?: string } | null) => {
    setSidebarMount(payload && payload.sessionId
      ? { sessionId: String(payload.sessionId), text: String(payload.text ?? "") }
      : null);
  });

  
  

  setImageOptimizer((pngBase64: string, maxWidth: number, quality: number, annotate?: { grid?: boolean; marks?: Array<{ index: number; label?: string; x1: number; y1: number; x2: number; y2: number }>; marksSpace?: { width: number; height: number } }) => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
      if (img.isEmpty()) { return null; }
      const size = img.getSize();
      const out = maxWidth > 0 && size.width > maxWidth
        ? img.resize({ width: maxWidth, quality: "good" })
        : img;
      let finalImg = out;
      
      if (annotate && (annotate.grid || (annotate.marks && annotate.marks.length > 0))) {
        try {
          const fs = out.getSize();
          const bmp = out.toBitmap();
          annotateBitmap(
            { buf: bmp, width: fs.width, height: fs.height },
            { grid: annotate.grid, marks: annotate.marks, marksSpace: annotate.marksSpace },
          );
          finalImg = nativeImage.createFromBitmap(bmp, { width: fs.width, height: fs.height });
        } catch {  }
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
      return null; 
    }
  });

  













  setImageDiffer((pngA: string, pngB: string): number | null => {
    try {
      const ia = nativeImage.createFromBuffer(Buffer.from(pngA, "base64"));
      const ib = nativeImage.createFromBuffer(Buffer.from(pngB, "base64"));
      if (ia.isEmpty() || ib.isEmpty()) { return null; }
      const sa = ia.getSize();
      const sb = ib.getSize();
      if (sa.width !== sb.width || sa.height !== sb.height) { return 1; }
      const ba = ia.toBitmap();
      const bb = ib.toBitmap();
      if (ba.length !== bb.length || ba.length === 0) { return null; }
      let changed = 0;
      for (let i = 0; i + 3 < ba.length; i += 4) {
        const d = Math.abs(ba[i] - bb[i]) + Math.abs(ba[i + 1] - bb[i + 1]) + Math.abs(ba[i + 2] - bb[i + 2]);
        if (d > 24) { changed += 1; }
      }
      const pixels = ba.length / 4;
      return pixels > 0 ? changed / pixels : null;
    } catch { return null; }
  });

  

  const screenCtl = getScreenController();
  


  const desktopBackend = new DesktopScreenBackend();
  screenCtl.register(desktopBackend);
  screenCtl.register(new AndroidScreenBackend(adbService));
  setScreenController(screenCtl);

  




  screenCtl.onOperationFocus = (e): void => {
    try { mainWindow?.webContents.send("slime:screen:opFocus", e); } catch {  }
  };

  

  setBrowserAdapter(new BrowserBridge(() => mainWindow));

  











  setToolCategoryGate((tool, args) => gateToolCall({
    tool,
    riskKind: tool.effectiveRiskKind(),
    
    target: targetFromArgs(args),
    switches: permSwitches(getPermissions()),
  }));

  
  handleTrusted<{ dir: string; port?: number; host?: string; spa?: boolean }>("slime:http:serve", async (_event, p): Promise<{ ok: boolean; id?: string; port?: number; host?: string; urls?: string[]; error?: string }> => {
    const r = await httpServer.serve({ dir: p?.dir ?? "", port: p?.port, host: p?.host, spa: p?.spa });
    
    if (r?.ok) { broadcastAgentProcs(); }
    return r;
  });

  
  handleTrusted<{ id: string }>("slime:http:stop", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const r = await httpServer.stop(p?.id ?? "");
    if (r?.ok) { broadcastAgentProcs(); }
    return r;
  });

  
  handleTrusted<void>("slime:http:stopAll", async (): Promise<{ ok: boolean; stopped: number }> => {
    const r = await httpServer.stopAll();
    broadcastAgentProcs();
    return r;
  });

  
  handleTrusted<void>("slime:http:list", async (): Promise<Array<{ id: string; dir: string; port: number; host: string; urls: string[]; startedAt: number; requests: number }>> => {
    return httpServer.list();
  });

  



















  const searchBridgeDeps = {
    
    getTheme: (): string => searchThemeOf(readPersistedTheme()),
    getWindow: (): Electron.BrowserWindow | null => mainWindow,
    
    isMainSender: (sender: Electron.WebContents): boolean => isTrustedSender(sender),
    serve: (opts: { dir: string; port?: number; host?: string; spa?: boolean; origin?: "agent" | "restored" | "builtin" }) => httpServer.serve(opts),
  };
  registerSearchBridge(searchBridgeDeps);
  
  
  void ensureSearchPage(searchBridgeDeps).catch(() => {  });

  








  registerSearchIndexIpc({
    userData: app.getPath("userData"),
    isMainSender: (sender: Electron.WebContents): boolean => isTrustedSender(sender),
  });
  void startSearchIndexService({ userData: app.getPath("userData") })
    .then((r) => {
      if (!r.ok) { console.warn("[gui:search-index] 自建索引服务未启动：" + String(r.error)); }
      else { console.info("[gui:search-index] 搜索索引服务已就绪（127.0.0.1:" + String(r.port) + "）"); }
    })
    .catch(() => {  });

  





















  
  async function collectAgentProcSources(): Promise<AgentProcSources> {
    const servers = await httpServer.list().catch(() => []);
    return {
      screenHost: desktopBackend.residentHost?.() ?? null,
      httpServers: servers.map((s) => ({
        id: s.id, port: s.port, host: s.host, dir: s.dir, startedAt: s.startedAt, requests: s.requests,
        

        origin: s.origin,
      })),
    };
  }

  
  function broadcastAgentProcs(): void {
    try { mainWindow?.webContents.send("slime:agentprocs:changed", {}); } catch {  }
  }

  handleTrusted<void>("slime:agentprocs:list", async (): Promise<AgentProcsListResult> => {
    try {
      const view = buildAgentProcView(await collectAgentProcSources(), Date.now());
      return { ok: true, view };
    } catch (e) {
      

      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handleTrusted<AgentProcsStopRequest>("slime:agentprocs:stop", async (_event, p): Promise<AgentProcsStopResult> => {
    const plan = planAgentProcStop({ kind: p?.kind ?? "", id: p?.id });
    if (!plan.ok) { return { ok: false, error: plan.reason }; }
    try {
      switch (plan.action) {
        case "dispose-screen-host":
          desktopBackend.dispose?.();
          break;
        case "stop-http-server": {
          const r = await httpServer.stop(plan.id);
          if (!r?.ok) { return { ok: false, error: r?.error ?? `停止服务 ${plan.id} 失败（未知原因）` }; }
          break;
        }
        default:
          

          return { ok: false, error: `暂不支持停止该类别：${String((plan as { action?: string }).action ?? "")}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    

    const view = buildAgentProcView(await collectAgentProcSources(), Date.now()).entries;
    broadcastAgentProcs();
    return { ok: true, detail: `已停止（余 ${view.length} 项）` };
  });

  

  
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
    
    
    targets = (await ctl.listTargetsReport()).targets;
    return { enabled, halted: ctl.isHalted(), backends, targets };
  });

  
  handleTrusted<void>("slime:screen:halt", async (): Promise<{ ok: boolean }> => {
    getScreenController().halt();
    return { ok: true };
  });

  
  handleTrusted<void>("slime:screen:resume", async (): Promise<{ ok: boolean }> => {
    getScreenController().resume();
    return { ok: true };
  });

  
  handleTrusted<{ backend?: string; target?: string }>("slime:screen:capture", async (_event, p): Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string }> => {
    const backend = p?.backend === "android" ? "android" : "desktop";
    const r = await getScreenController().capture(backend, p?.target || undefined);
    return { ok: r.ok, dataUrl: r.dataUrl, width: r.width, height: r.height, error: r.error };
  });

  


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
      
      if (r.reason === "browser-scheme") {
        return { ok: false, error: `已拦截浏览器唤起链接 ${(url.split(":")[0] || "").toLowerCase()}:// ——不唤醒外部浏览器` };
      }
      return { ok: false, error: `链接 ${(url.split(":")[0] || "").toLowerCase()}:// 需要安装对应客户端才能打开（系统未注册该协议）` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });


  
  handleTrusted<void>("slime:adb:detect", async (): Promise<AdbDetect> => {
    return adbService.detect();
  });

  
  handleTrusted<void>("slime:adb:download", async (): Promise<AdbCmdResult & { progress?: AdbDownloadProgress }> => {
    return adbService.downloadPlatformTools((p) => {
      mainWindow?.webContents.send("slime:adb:downloadProgress", p);
    });
  });

  
  handleTrusted<void>("slime:adb:devices", async (): Promise<{ ok: boolean; devices?: AdbDevice[]; error?: string }> => {
    return adbService.devices();
  });

  
  handleTrusted<{ host: string }>("slime:adb:connect", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.connect(p?.host ?? "");
  });

  
  handleTrusted<{ host: string }>("slime:adb:disconnect", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.disconnect(p?.host ?? "");
  });

  
  handleTrusted<{ serial: string; command: string }>("slime:adb:shell", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.shell(p?.serial ?? "", p?.command ?? "");
  });

  
  handleTrusted<{ serial: string; apkPath: string }>("slime:adb:install", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.install(p?.serial ?? "", p?.apkPath ?? "");
  });

  
  handleTrusted<{ serial: string; pkg: string }>("slime:adb:uninstall", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.uninstall(p?.serial ?? "", p?.pkg ?? "");
  });

  
  handleTrusted<{ serial: string }>("slime:adb:screencap", async (_event, p): Promise<AdbScreencapResult> => {
    return adbService.screencap(p?.serial ?? "");
  });

  
  handleTrusted<{ serial: string; remote: string; local: string }>("slime:adb:pull", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.pull(p?.serial ?? "", p?.remote ?? "", p?.local ?? "");
  });

  
  handleTrusted<{ serial: string; local: string; remote: string }>("slime:adb:push", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.push(p?.serial ?? "", p?.local ?? "", p?.remote ?? "");
  });

  
  handleTrusted<{ serial: string }>("slime:adb:reboot", async (_event, p): Promise<AdbCmdResult> => {
    return adbService.reboot(p?.serial ?? "");
  });

  
  handleTrusted<void>("slime:adb:startServer", async () => {
    return adbService.startServer();
  });
  handleTrusted<void>("slime:adb:killServer", async () => {
    return adbService.killServer();
  });

  
  handleTrusted<{ query?: string }>("slime:mcpRegistrySearch", async (_event, p) => {
    const { searchMcpRegistry } = await import("./config_files.js");
    return searchMcpRegistry(p?.query ?? "");
  });

  
  handleTrusted<{ card: import("./config_files.js").RegistryServerCard }>("slime:mcpRegistryInstall", async (_event, p) => {
    const { installFromMcpRegistry } = await import("./config_files.js");
    return installFromMcpRegistry(p?.card);
  });

  
  handleTrusted<void>("slime:files:pick", async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const openOpts: Electron.OpenDialogOptions = {
      title: "选择要加入会话的文件（图片 / 文档等）",
      properties: ["openFile"],
    };
    const open = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    return { ok: true, path: open.filePaths[0] };
  });

  
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

  
  handleTrusted<{ sinceIso?: string; untilIso?: string; limit?: number }>("slime:usage:snapshot", async (_e, payload) => {
    
    const tzOffsetMin = -new Date().getTimezoneOffset();
    const records = await loadUsage({
      sinceIso: payload?.sinceIso,
      untilIso: payload?.untilIso,
      limit: payload?.limit ?? 5000,
    });
    





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

  
  
  
  handleTrusted<void>("slime:usage:recompute", async () => {
    await ensureServices();
    const res = await rewriteUsageCosts(buildPriceResolver());
    return { ok: true, ...res } as UsageRecomputeResult;
  });

  
  registerTraceHandlers();
  registerPlanHandlers();

  

  
  handleTrusted<{ agentId?: string } | undefined>("slime:mind:configGet", async (_event, payload) => {
    
    
    
    try {
      await tryRelocateDownloads();
    } catch (e) {
      console.warn(`[gui:mind] 归位收尾异常: ${e}`);
    }
    const cfg = loadMindConfig();
    
    
    
    const agentId = typeof payload?.agentId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.agentId)
      ? payload.agentId
      : null;
    return {
      vectorTool: cfg.vectorTool,
      memoryRoot: cfg.memoryRoot,
      
      lancedb: lancedbComponent(),
      memoryPaths: agentId
        ? resolveMemoryPaths(agentId, { dataDir: cfg.memoryRoot || undefined })
        : null,
      deps: readDepStatus(),
    };
  });

  





  handleTrusted<{ vectorTool?: string; memoryRoot?: string }>("slime:mind:configSet", async (_event, payload) => {
    const patch: { vectorTool?: VectorTool; memoryRoot?: string } = {};
    if (payload.vectorTool === "basic" || payload.vectorTool === "bge") {
      patch.vectorTool = payload.vectorTool;
    }
    if (typeof payload.memoryRoot === "string") {
      patch.memoryRoot = payload.memoryRoot;
    }
    const cfg = saveMindConfig(patch);
    memoryStores.clear();
    return { ok: true, vectorTool: cfg.vectorTool, memoryRoot: cfg.memoryRoot };
  });

  
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

  
  handleTrusted<{ agentId: string }>("slime:mind:emotionGet", async (_event, payload) => {
    await ensureServices();
    const agent = await agentRegistry!.findAgent(payload.agentId);
    const emotion = new EmotionalState((agent?.emotion as Record<string, unknown>) ?? undefined);
    return { ...emotion.toDict(), agentName: agent?.name ?? payload.agentId };
  });

  
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

  
  handleTrusted<{ target: string }>("slime:mind:download", async (_event, payload) => {
    const target = payload.target as DownloadTarget;
    if (target !== "llama" && target !== "bge") {
      return { ok: false, error: "非法下载目标" };
    }
    await ensureServices(); 
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
            if (!svc) return; 
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

  
  handleTrusted<void>("slime:model:startEmbedding", async (): Promise<{ ok: boolean; error?: string; state?: string }> => {
    const mgr = getModelServer();
    if (!mgr) {
      return { ok: false, error: "模型服务器未初始化" };
    }
    const result = await mgr.startEmbedding();
    return { ok: result.ok, error: result.error, state: result.state };
  });

  handleTrusted<void>("slime:agents:list", async () => {
    
    await ensureRegistry();
    return (agentRegistry?.loadedAgents ?? []).map((a): AgentInfo => ({
      id: a.id, name: a.name, role: a.role,
      children: a.children ?? [], parent_id: a.parent_id ?? null,
      lifecycle: a.lifecycle ?? "unknown",
    }));
  });

  handleTrusted<{ name: string; role: string; toolProfile?: { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] } }>("slime:agents:create", async (_event, params) => {
    await ensureServices();
    const a = await createAgent(params.name, params.role, params.toolProfile);
    selectedAgentId = a.id;
    a2aBus?.register(a.name);
    
    
    syncDispatchableSubagents();
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
    
    syncDispatchableSubagents();
    mainWindow?.webContents.send("slime:agents:selected", child.id);
    return { id: child.id, name: child.name, role: child.role, children: [], parent_id: parent.id, lifecycle: child.lifecycle ?? "unknown" } as AgentInfo;
  });

  
  handleTrusted<{ agentId: string }>("slime:agents:select", async (_event, payload) => {
    selectedAgentId = payload.agentId;
    console.info(`[gui:main] 选中 Agent: ${payload.agentId}`);
    return { ok: true };
  });

  
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
    
    
    syncDispatchableSubagents();
    return { ok: true, deleted };
  });

  
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
      tool_profile: a.tool_profile as { mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] } | undefined,
      
      
      subagent_dispatch: a.subagent_dispatch as boolean | undefined,
    };
  });

  
  handleTrusted<{ agentId: string; patch: Record<string, unknown> }>("slime:agents:update", async (_event, payload) => {
    await ensureServices();
    const updated = await agentRegistry!.updateAgent(payload.agentId, payload.patch as Partial<AgentState>);
    if (!updated) { throw new Error(`Agent ${payload.agentId} 不存在`); }
    
    
    
    syncDispatchableSubagents();
    return { ok: true };
  });

  
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
    if (save.canceled || !save.filePath) { return { ok: false, error: "已取消选择" }; }
    const { exportAgent } = await import("../../../core-ts/src/services/export.js");
    const res = await exportAgent({ agentId: payload.agentId, output: save.filePath });
    if (!res.ok) { console.error(`[gui:main] 导出失败: ${res.error}`); }
    return res.ok ? { ok: true, path: res.path } : { ok: false, error: res.error };
  });

  
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
    if (open.canceled || open.filePaths.length === 0) { return { ok: false, error: "已取消选择" }; }
    const { importAgent, PROJECT_ROOT } = await import("../../../core-ts/src/services/import.js");
    const res = await importAgent({
      input: open.filePaths[0],
      targetRoot: PROJECT_ROOT,
      conflictStrategy: payload.conflictStrategy ?? "abort",
    });
    if (res.ok) {
      
      await agentRegistry!.load();
      
      syncDispatchableSubagents();
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

  
  handleTrusted<void>("slime:providers:list", async (): Promise<ProviderSummary[]> => listProviders());

  handleTrusted<{ baseUrl: string; apiKey: string; api_format?: "openai" | "anthropic" | "responses" | "google" | "auto" }>("slime:providers:fetchModels", async (_event, p) =>
    
    
    
    enrichModels(p.baseUrl, p.apiKey, p.api_format ?? "auto"),
  );

  handleTrusted<{ key: string; api_base: string; api_key?: string; model?: string | null; models?: unknown[] }>(
    "slime:providers:save",
    async (_event, p) => {
      const res = await saveProvider(p);
      if (res.ok) {
        engine?.refreshProviders();
        console.info(`[gui:main] Provider 已保存并生效: ${p.key}`);
      }
      return res;
    },
  );

  
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
      console.info(`[gui:main] Provider 已删除并生效: ${p.key}`);
    }
    return res;
  });

  
  handleTrusted<void>("slime:providers:localList", async (): Promise<LocalModelSpec[]> => listLocalModels());

  

  handleTrusted<void>("slime:silam:status", async (): Promise<{ enabled: boolean }> => {
    await ensureServices();
    return { enabled: silamBrain?.enabled === true };
  });

  
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
        console.info(`[gui:main] 本地模型已保存并生效: ${p.id}`);
      }
      return res;
    },
  );

  handleTrusted<{ id: string }>("slime:providers:localRemove", async (_event, p) => {
    const res = removeLocalModel(p.id);
    if (res.ok) {
      engine?.refreshProviders();
      console.info(`[gui:main] 本地模型已删除并生效: ${p.id}`);
    }
    return res;
  });

  handleTrusted<{ dir: string }>("slime:providers:localScan", async (_event, p) => scanLocalModels(p.dir));

  
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
      
      const rel = (p.rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      const dir = rel ? resolve(root, ...rel.split("/")) : root;
      const rootNorm = root.endsWith(sep) ? root : root + sep;
      if (dir !== root && !dir.startsWith(rootNorm)) {
        return { ok: false, error: "路径越界：仅允许访问当前目录内部" };
      }
      const st = statSync(dir);
      if (!st.isDirectory()) {
        return { ok: false, error: "路径不是目录" };
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
      
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  












  handleTrusted<{ rel: string; root?: string; sessionId?: string }>(
    "slime:workspace:openTarget",
    async (_event, p): Promise<{ ok: boolean; path?: string; isDir?: boolean; tried?: string[]; error?: string }> => {
      const sessionWorkspace = p.sessionId
        ? (await getSession(p.sessionId).catch(() => null))?.workspace
        : null;
      
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
        } catch {  }
      }
      return {
        ok: false,
        error: `文件不存在：${normalizeTargetPath(typeof p?.rel === "string" ? p.rel : "")}`,
        tried: candidates,
      };
    },
  );

  
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
      
      const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
      const ext = "." + filePath.split(".").pop()!.toLowerCase();
      if (IMG_EXT.has(ext)) {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "image", content: buf.toString("base64") };
      }
      
      
      
      const OFFICE_EXT = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
      if (ext === ".pdf") {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "pdf", content: buf.toString("base64") };
      }
      if (OFFICE_EXT.has(ext)) {
        const buf = readFileSync(filePath);
        return { ok: true, path: filePath, name: rel, mime: "office", content: buf.toString("base64") };
      }
      
      
      const buf = readFileSync(filePath);
      const hasNul = binarySniff(buf);
      
      const ARCHIVE_BINARY_EXT = new Set([
        ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz", ".zst",
        ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".deb", ".rpm", ".apk", ".msi",
        ".woff", ".woff2", ".ttf", ".eot", ".ico", ".db", ".sqlite", ".pdf", ".wasm",
        ".mat", ".npy", ".pkl", ".pyc", ".class", ".o", ".a", ".node",
      ]);
      if (ARCHIVE_BINARY_EXT.has(ext) || hasNul) {
        return { ok: true, path: filePath, name: rel, mime: "binary", content: buf.toString("base64") };
      }
      
      const MAX_TEXT = 512 * 1024;
      let text = buf.toString("utf-8");
      let truncated = false;
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
      return { ok: true, path: filePath, name: rel, mime: "text", content: text, truncated };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  
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

  
  handleTrusted<{ path: string }>("slime:shell:openPath", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim().replace(/^["']|["']$/g, "");
    if (!abs) { return { ok: false, error: "缺少文件路径" }; }
    if (!existsSync(abs)) { return { ok: false, error: `文件不存在：${abs}` }; }
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  






  handleTrusted<{ path: string }>("slime:docs:read", async (_event, p) => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim().replace(/^["']|["']$/g, "");
    if (!abs) { return { ok: false, error: "缺少文件路径" }; }
    if (!isAbsolutePath(abs)) { return { ok: false, error: `需要绝对路径：${abs}` }; }
    if (!existsSync(abs)) { return { ok: false, error: `文件不存在：${abs}` }; }
    try {
      const ext = (abs.slice(abs.lastIndexOf(".")) || "").toLowerCase();
      
      const kind = docKindFromExt(ext);
      if (kind) {
        const r = extractDocText(await readFile(abs), kind);
        return { ok: true, kind, text: r.text, truncated: r.truncated, info: r.info };
      }
      
      const ole = oleKindFromExt(ext);
      if (ole) {
        const r = extractOleText(await readFile(abs), ole);
        return { ok: true, kind: `ole-${ole}`, text: r.text, truncated: r.truncated, info: r.info };
      }
      
      if (classifyFile(abs).parser === "text") {
        return { ok: true, kind: "text", text: (await readFile(abs, "utf8")).slice(0, 200_000), truncated: false };
      }
      


      return { ok: false, error: nonNavigableReason(abs) };
    } catch (e) {
      return { ok: false, error: `读取失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  











  handleTrusted<{ name?: string; html?: string }>("slime:docs:htmlPreview", async (_event, p) => {
    const html = typeof p?.html === "string" ? p.html : "";
    if (!html.trim()) { return { ok: false, error: "没有可渲染的内容" }; }
    try {
      const dir = join(app.getPath("userData"), "doc-preview");
      mkdirSync(dir, { recursive: true });
      


      const written = previewHtmlPath(dir, p?.name, html);
      writeFileSync(written.path, html, "utf8");
      return { ok: true, path: written.path, dir, name: written.name };
    } catch (e) {
      return { ok: false, error: `写入预览页失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  









  handleTrusted<{ force?: boolean }>("slime:office:libreofficeProbe", async (_event, p) => {
    try {
      const r = await probeLibreOffice(Boolean(p?.force));
      return { ok: true, found: r.found, path: r.path, version: r.version, hint: r.hint };
    } catch (e) {
      return { ok: false, found: false, path: "", version: "", hint: "", error: String((e as Error)?.message ?? e) };
    }
  });

  















  handleTrusted<{ path?: string; name?: string; open?: boolean }>("slime:docs:renderPage", async (_event, p) => {
    const abs = (typeof p?.path === "string" ? p.path : "").trim();
    if (!abs) { return { ok: false, error: "缺少文件路径" }; }
    if (!isAbsolutePath(abs)) { return { ok: false, error: `需要绝对路径：${abs}` }; }
    const plan = planRender(abs);
    



    if (plan.render === "html-native") {
      return { ok: true, dir: dirname(abs), name: basename(abs) };
    }
    if (!plan.faithful) {
      return { ok: false, error: `该类型不支持保真渲染（.${abs.split(".").pop() ?? "?"}）`, degrade: true };
    }
    
    if (plan.needs === "libreoffice") {
      







      const pageRoot = join(app.getPath("userData"), "doc-render");
      mkdirSync(pageRoot, { recursive: true });
      const cachedPage = pdfViewerPaths(pageRoot, abs);
      if (existsSync(cachedPage.html) && existsSync(cachedPage.pdf) && statSync(cachedPage.pdf).size > 0) {
        return { ok: true, dir: pageRoot, name: cachedPage.name, transient: true, cached: true };
      }
      const conv = await convertToPdf(abs);
      if (!conv.ok) {
        





        if (fallbackRender(abs)) {
          const fbDir = join(app.getPath("userData"), "doc-render");
          mkdirSync(fbDir, { recursive: true });
          const fbBuilt = writeRenderPage(fbDir, abs, p?.name, {
            useFallback: true,
            notice: (conv.hint || conv.error || "本机没有 LibreOffice。")
              + "（当前按表格方式显示，不是原版式）",
          });
          if (fbBuilt.ok) {
            return { ok: true, dir: fbBuilt.dir, name: fbBuilt.name, transient: true, fallback: true, hint: conv.hint };
          }
        }
        

        return {
          ok: false, degrade: true,
          needs: "libreoffice",
          error: conv.error,
          hint: conv.hint,
          reason: conv.reason,
        };
      }
      const title = (p?.name ?? "").trim() || basename(abs);
      







      const built = writePdfViewerPage(pageRoot, conv.pdfPath, abs, title);
      






      cleanupConvertDir(conv.dir);
      if (!built.ok) {
        return { ok: false, error: built.error };
      }
      

      return { ok: true, dir: built.dir, name: built.name, transient: true };
    }
    try {
      const dir = join(app.getPath("userData"), "doc-render");
      mkdirSync(dir, { recursive: true });
      const written = writeRenderPage(dir, abs, p?.name);
      return written;
    } catch (e) {
      return { ok: false, error: `生成渲染页失败：${String((e as Error)?.message ?? e)}` };
    }
  });

  handleTrusted<{ spec: { path: string; format: string; title?: string; body: string } }>("slime:docs:create", async (_event, p) => {
    const spec = p?.spec;
    const abs = (typeof spec?.path === "string" ? spec.path : "").trim();
    if (!abs) { return { ok: false, error: "缺少输出路径" }; }
    if (!isAbsolutePath(abs)) { return { ok: false, error: `需要绝对路径：${abs}` }; }
    return await writeDocument({ path: abs, format: spec.format as DocFormat, title: spec.title, body: spec.body ?? "" });
  });

  
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

  
  handleTrusted<undefined>("slime:term:profiles", async (): Promise<TermProfilesResult> => {
    try {
      const profiles = await getTermProfiles();
      const def = pickDefaultProfile(profiles);
      return { ok: true, profiles, defaultId: def ? def.id : null };
    } catch (e) {
      

      return { ok: false, error: `终端配置探测失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  








  handleTrusted<{ cmd: string; cwd?: string; profileId?: string }>("slime:term:exec", async (_event, p): Promise<TermResult> => {
    const cmd = (p.cmd ?? "").trim();
    if (!cmd) {
      return { ok: false, stdout: "", stderr: "命令为空", code: null };
    }

    const profiles = await getTermProfiles();
    const prof = resolveProfile(profiles, p.profileId);
    if (!prof) {
      return {
        ok: false, stdout: "", stderr: "", code: null,
        error: "没有探测到任何可用的 shell（内置终端需要 cmd / PowerShell / bash 之一）"
      };
    }

    
    const cw = resolveTermCwd(p.cwd, prof.kind);
    const res = await runShellCommand(shellInvocation(prof, cmd, cw.dir), prof, cw.dir);
    if (cw.rejected) { pushTermNotice(res, cw.rejected); }
    
    res.cwd = nextTermCwd(cmd, cw.dir, prof.kind);
    return res;
  });

  
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
    
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    const deleted: string[] = [];
    for (const line of st.stdout.split("\n").filter(Boolean)) {
      if (line.startsWith("??")) { untracked.push(line.slice(3)); continue; }
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let f = line.slice(3).trim();
      const arrow = f.indexOf(" -> "); 
      if (arrow >= 0) { f = f.slice(arrow + 4); }
      if (x === "D" || y === "D") { deleted.push(f); }
      else if (x !== " " && x !== "?" && x !== "U") { staged.push(f); }
      else if (y !== " " && y !== "?" && y !== "U") { modified.push(f); }
    }
    const branches = bs.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    
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
        return { ok: false, error: "没有需要提交的更改" };
      }
      return { ok: false, error: err || "git commit 失败" };
    }
    return { ok: true };
  });

  
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

  
  handleTrusted<{ path?: string }>("slime:git:pull", async (_event, p): Promise<GitAction> => {
    const norm = gitPathOf(p?.path);
    if ("error" in norm) { return { ok: false, error: norm.error }; }
    const pull = await runGit(["pull"], norm.path);
    if (pull.code !== 0) { return { ok: false, error: pull.stderr.trim() || "git pull 失败" }; }
    return { ok: true };
  });

  
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
      
      
      const headOk = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], dir);
      const raw = headOk.code === 0
        ? await runGit(["diff", "--no-color", "HEAD", "--", relFile], dir)
        : await runGit(["diff", "--no-color", "--cached", "--", relFile], dir); 
      let out = (raw.code === 0 ? raw.stdout : "") || "";
      const absFile = join(dir, ...relFile.split("/"));
      const fileExists = existsSync(absFile) && statSync(absFile).isFile();
      
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

  






  handleTrusted<{ theme: string }>("slime:theme:set", (_event, p) => {
    writePersistedTheme(p.theme);
    mainWindow?.setTitleBarOverlay({ ...titleBarColors(p.theme), height: 40 });
    
    
    pushSearchTheme(searchThemeOf(p.theme));
  });
  handleTrusted<void>("slime:settings:autostart:get", async (): Promise<{ ok: boolean; enabled: boolean }> => {
    try {
      
      const s = app.getLoginItemSettings({ path: process.execPath });
      return { ok: true, enabled: s.openAtLogin };
    } catch (e) {
      console.warn("[gui:main] 读取开机自启失败:", e);
      return { ok: false, enabled: false };
    }
  });

  
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

  

  
  handleTrusted<void>("slime:notify:get", async () => {
    const cfg = readNotifyConfig();
    const soundOk = cfg.soundFile ? Boolean(customSoundPath()) : false;
    return { ok: true, config: cfg, soundReady: soundOk };
  });

  
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

  
  handleTrusted<void>("slime:notify:sound:clear", async () => {
    const res = clearSound();
    return res.ok ? { ...res, config: readNotifyConfig() } : res;
  });

  
  handleTrusted<void>("slime:notify:sound:data", async () => readSoundData());

  
  handleTrusted<void>("slime:notify:test", async () => {
    notifyUser({
      kind: "test",
      
      
      
      title: "通知测试",
      body: "请核对通知**头部那行应用名**是不是本程序的名字（不是 com.slime.gui）；提示音按你的设置播放。",
    });
    return { ok: true, config: readNotifyConfig() };
  });

  







  
  handleTrusted<void>("slime:fallback:get", async () => {
    return { ok: true, entries: readFallbackPool().entries, providers: listProviders() };
  });

  
  handleTrusted<{ entries?: unknown }>("slime:fallback:set", async (_event, p) => {
    try {
      const next = writeFallbackPool({ entries: p?.entries });
      console.info(
        `[gui:main] 全局降级池已更新：${next.entries.length} 条`
        + (next.entries.length > 0 ? `（${next.entries.map((e) => `${e.provider}:${e.model}`).join(" → ")}）` : "（空 = 不跨供应商降级）"),
      );
      return { ok: true, entries: next.entries };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  
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

  
  handleTrusted<void>("slime:data:reset", async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      
      const cfgDir = resolve(PROJECT_ROOT, "config");
      const root = resolve(PROJECT_ROOT);
      if (!root || root === resolve(sep) || root === process.env.USERPROFILE || root === process.env.HOME) {
        return { ok: false, error: `数据根异常（${root}），已中止重置以保护文件` };
      }
      
      
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
      
      const oldAgents = [...agentRegistry!.loadedAgents];
      for (const a of oldAgents) {
        try { await removeAgentHistory(a.id); } catch {  }
        try { a2aBus?.unregister(a.name); } catch {  }
      }
      agentRegistry!.loadedAgents.length = 0;
      await agentRegistry!.save();
      selectedAgentId = null;
      
      const pr = clearAllProviders();
      if (!pr.ok && pr.error) { return { ok: false, error: pr.error }; }
      engine?.refreshProviders();
      
      try { if (existsSync(SESSIONS_PATH)) { rmSync(SESSIONS_PATH, { force: true }); } } catch {  }
      console.info(`[gui:main] 本地数据已重置（仅限 ${cfgDir} 下：providers.enc.json / agents.json / history.jsonl / sessions.json）`);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gui:main] 数据重置失败:", e);
      return { ok: false, error: msg };
    }
  });
}







function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "slime", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}




function isWebSafeUrl(url: string): boolean {
  try {
    if (!url) { return true; }
    if (url === "about:blank" || url.startsWith("slime://")) { return true; }
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    if (!m) { return true; } 
    return ["http", "https", "about", "file", "data", "blob", "chrome", "chrome-extension"].includes(m[1].toLowerCase());
  } catch {
    return false;
  }
}












function isChromiumInternalScheme(url: string): boolean {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url ?? "");
  if (!m) { return false; }
  return ["chrome", "chrome-extension", "devtools", "view-source"].includes(m[1].toLowerCase());
}










function isAbsolutePath(p: string): boolean {
  try { return isAbsolute(p); } catch { return false; }
}

function localPathOfFileUrl(url: string): string | null {
  try {
    if (!url || !url.toLowerCase().startsWith("file:")) { return null; }
    const p = fileURLToPath(url);
    if (!p) { return null; }
    
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/") ? p : null;
  } catch { return null; }
}













function guardLocalFileDownloads(sess: Electron.Session): void {
  sess.on("will-download", (_event, item) => {
    const localPath = localPathOfFileUrl(item.getURL());
    if (!localPath) { return; }
    item.cancel();
    try {
      mainWindow?.webContents.send("slime:docs:local-file", {
        path: localPath,
        reason: "本地文件不会被当成「下载」写进磁盘（那会把文件夹塞满重复的半成品文件）。",
      });
    } catch {  }
  });
}








async function openExternalSafe(url: string): Promise<{ ok: boolean; handler?: string; reason?: string }> {
  





  if (isChromiumInternalScheme(url)) {
    return { ok: false, reason: "internal-scheme" };
  }
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
  } catch {  }
  return { ok: false, reason: "空链接" };
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
    
    
    
    
    webContents.on("will-navigate", (e, url) => {
      
      
      
      if (url.startsWith("slime://open?u=")) { return; }
      







      const localPath = localPathOfFileUrl(url);
      if (localPath && !isNavigableLocalFile(localPath)) {
        e.preventDefault();
        mainWindow?.webContents.send("slime:docs:local-file", { path: localPath, reason: nonNavigableReason(localPath) });
        return;
      }
      if (!isWebSafeUrl(url)) {
        e.preventDefault();
        return;
      }
      
      
      
      if (webContents === mainWindow?.webContents && !url.startsWith("slime://")) {
        e.preventDefault();
      }
    });
    
    webContents.on("will-redirect", (e, url) => {
      if (!isWebSafeUrl(url)) {
        e.preventDefault();
      }
    });
    
    
    
    
    webContents.on("will-frame-navigate", (details) => {
      const url = details?.url ?? "";
      if (isWebSafeUrl(url)) { return; }
      try { details.preventDefault(); } catch {  }
      void openExternalSafe(url).then((r) => {
        if (!r.ok) {
          try {
            
            mainWindow?.webContents.send("slime:browser:popup-notice", { url, ts: Date.now(), kind: "need-install", scheme: (url.split(":")[0] || "").toLowerCase() });
          } catch {  }
        }
      });
    });
    webContents.setWindowOpenHandler(({ url }) => {
      
      
      
      
      
      
      try {
        if (url.startsWith("slime://open?u=")) {
          
          
          try {
            const u = new URL(url).searchParams.get("u");
            if (u && /^https?:\/\//i.test(u)) {
              mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url: u, name: "", from: "site" });
            }
          } catch {  }
          return { action: "deny" };
        }
        if (isWebSafeUrl(url)) {
          
          
          
          mainWindow?.webContents.send("slime:sidebar:open", { kind: "url", url, name: "", from: "site" });
        } else {
          mainWindow?.webContents.send("slime:browser:popup-notice", { url, ts: Date.now(), kind: "need-install", scheme: (url.split(":")[0] || "").toLowerCase() });
        }
      } catch {  }
      return { action: "deny" };
    });
  });

  
  
  
  
  ipcMain.handle("slime:protocol:open", async (_ev, raw: unknown) => {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url) { return { ok: false, reason: "空链接" }; }
    const scheme = (url.split(":")[0] || "").toLowerCase();
    
    if (isWebSafeUrl(url)) { return { ok: false, reason: "web" }; }
    const r = await openExternalSafe(url); 
    return r.ok ? { ok: true, url, scheme, handler: r.handler } : { ok: false, url, scheme, reason: r.reason ?? "空链接" };
  });
}

function main(): void {
  registerSchemePrivileges(); 

  
  
  app.userAgentFallback = (app.userAgentFallback || "")
    .replace(/\sElectron\/[\d.]+/g, "")
    .replace(/\sslime\/[\d.]+/g, "")
    .trim();

  
  
  app.commandLine.appendSwitch("v8-cache-options", "code");

  
  
  
  
  
  app.commandLine.appendSwitch("disable-features", "ExternalProtocolDialog");

  
  
  
  
  
  
  

  
  
  
  
  
  
  if (process.env.SLIME_DISABLE_GPU === "1") {
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }

  
  
  
  
  app.setName("Slime");

  



















  app.setAppUserModelId(APP_AUMID);

  
  
  
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

  
  
  
  
  
  
  
  
  
  
  
  const devtoolsDecision = app.isPackaged
    ? null
    : resolveDevtoolsPort(process.env[DEVTOOLS_PORT_ENV], listeningPortsSync());
  if (devtoolsDecision) {
    app.commandLine.appendSwitch("remote-debugging-port", String(devtoolsDecision.port));
    
    if (devtoolsDecision.reason === "shifted") {
      console.warn(`[gui:devtools] ${devtoolsDecision.preferred} 已被占用 → CDP 端口顺延为 ${devtoolsDecision.port}`);
    } else if (devtoolsDecision.reason === "ephemeral") {
      console.warn(`[gui:devtools] ${devtoolsDecision.preferred} 及其后 ${DEVTOOLS_PORT_SCAN} 个端口均被占用 → 交系统分配临时端口（真实端口见 DevToolsActivePort）`);
    } else if (devtoolsDecision.explicit) {
      console.log(`[gui:devtools] CDP 端口 ${devtoolsDecision.port}（来自 ${DEVTOOLS_PORT_ENV}）`);
    }
  }

  app.whenReady()
    .then(async () => {
      
      registerProtocolHandler();
      
      
      
      
      try {
        session.fromPartition("persist:slime-browser").protocol.handle("slime", () => new Response(null, { status: 204 }));
      } catch {  }
      

      try { guardLocalFileDownloads(session.defaultSession); } catch {  }
      try { guardLocalFileDownloads(session.fromPartition("persist:slime-browser")); } catch {  }
      migrateLegacyInstallDirData();
      createWindow();
      
      
      
      
      if (devtoolsDecision) {
        void (async () => {
          let actual: number | null = null;
          if (devtoolsDecision.port === 0) {
            const activePath = join(app.getPath("userData"), "DevToolsActivePort");
            for (let i = 0; i < 25 && actual === null; i++) {
              try { actual = parseDevToolsActivePort(readFileSync(activePath, "utf8")); } catch {  }
              if (actual === null) { await new Promise((r) => setTimeout(r, 100)); }
            }
          }
          const file = writeDevtoolsPortFile(app.getPath("userData"), devtoolsDecision, actual);
          if (file) {
            console.log(`[gui:devtools] CDP 端口 ${actual ?? devtoolsDecision.port} 已发布到 ${file}`);
          }
        })();
      }
      
      
      ensureTray();
      
      
      startMainWatchdog();
      markMainActivity("app ready");
      
      
      {
        const sweep = sweepAfterCrash();
        if (sweep.abnormalExit) {
          console.warn(`[gui:main] 检测到上次异常退出（清障：临时文件 ${sweep.removedTmp} 个）；详见 data/crash-report.log`);
        }
        markRunning(app.getVersion());
      }
      app.on("will-quit", () => { markCleanExit(); });
      
      initModelServerManager();
      



      installAdBlocker(session.fromPartition("persist:slime-browser"), PROJECT_ROOT);
      registerIpcHandlers();
      
      void ensureDefaultAgent();
      registerUpdaterHandlers(); 
      
      setStatusSink((s) => mainWindow?.webContents.send("slime:update:status", s));
      initUpdater();             
      
      setBootSink((s) => mainWindow?.webContents.send("slime:boot:event", s));
      
      
      
      
      
      void ensureServices().catch((e) => {
        console.warn("[gui:main] 后台预热失败（首屏不受影响，对话时会按需重试）:", e);
      });
      void startPythonBackend(); 
      
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

  
  
  const logMainError = (tag: string, err: unknown): void => {
    try {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      const dir = resolveExtra("../data/logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "main-errors.log"), `${new Date().toISOString()}\t[${tag}]\t${msg}\n`, { flag: "a" });
      console.error(`[gui:main] ${tag}:`, msg);
    } catch {  }
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
    void getLlmGatewayManager().stop(); 
    
    try { httpServer.stopAll(); } catch {  }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
  });
}

void main();


let pythonBackend: ChildProcess | null = null;
const SLIME_PORT = process.env.SLIME_PORT || "19000";




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
        
        token = decryptRaw("config/auth_token.enc");
      } catch {
        token = null;
      }
      if (!token) {
        return; 
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
      
    }
  })();
}


type BootStatusSink = (s: { phase: string; backendReady: boolean; message?: string }) => void;
let bootSink: BootStatusSink | null = null;

let bootQuery: { phase: string; backendReady: boolean; message?: string } | null = null;
export function setBootSink(fn: BootStatusSink | null): void {
  bootSink = fn;
}
function emitBoot(s: { phase: string; backendReady: boolean; message?: string }): void {
  bootQuery = s;
  bootSink?.(s);
}


function resolveExtra(subpath: string): string {
  return join(INSTALL_ROOT, subpath);
}












function resolveBundled(subpath: string): string {
  return join(BUNDLE_ROOT, subpath);
}

async function startPythonBackend(): Promise<void> {
  emitBoot({ phase: "backend", backendReady: false, message: "正在启动本地后端服务…" });
  
  const venvSub = process.platform === "win32" ? "Scripts" : "bin";
  const venvPyName = process.platform === "win32" ? "python.exe" : "python";
  const venvPython = resolveBundled(join("runtime", "venv", venvSub, venvPyName));

  const serverScript = resolveBundled("slime_server.py");
  if (!existsSync(venvPython) || !existsSync(serverScript)) {
    console.warn("[gui:backend] Python backend not found, running without server");
    emitBoot({ phase: "degraded", backendReady: false, message: "后端组件缺失，将以受限模式运行" });
    return;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    SLIME_PORT,
    








    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  if (process.platform !== "win32") {
    
    const libDir = resolveBundled(join("llama.cpp", "build", "bin"));
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
  }
  
  
  
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
  
  
  
  
  console.warn("[gui:backend] slime_server.py 启动较慢（>10秒），后台继续等待就绪…");
  emitBoot({ phase: "backend", backendReady: false, message: "后端服务仍在启动（首次导入较慢）…" });
  void (async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`http://localhost:${SLIME_PORT}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          console.info(`[gui:backend] slime_server.py 已就绪（启动耗时约 ${10 + (i + 1) * 0.5} 秒）`);
          emitBoot({ phase: "ready", backendReady: true, message: "后端服务已就绪" });
          return;
        }
      } catch {  }
    }
    console.error("[gui:backend] slime_server.py 启动超时（60秒）");
    emitBoot({ phase: "degraded", backendReady: false, message: "后端服务启动超时（可用性受限）" });
  })().catch(() => {  });
}

function terminatePythonBackend(): void {
  if (pythonBackend) {
    pythonBackend.kill();
    pythonBackend = null;
  }
}


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
      
      
      
      
      onChatState: (ev) => {
        






        clearLocalCapabilityCache();
        const w = mainWindow;
        if (!w || w.isDestroyed()) { return; }
        if (ev.state === "loading") {
          w.webContents.send("slime:model:loading", {
            loading: true,
            message: `正在加载本地模型「${ev.modelName || basename(ev.modelPath)}」——首次加载可能需要数十秒`,
            key: lastChatCancelKey ?? undefined,
          });
          console.info(`[gui:main] 本地模型开始加载: ${ev.modelName} (${ev.modelPath})`);
        } else {
          w.webContents.send("slime:model:loading", { loading: false });
          if (ev.state === "ready") { console.info(`[gui:main] 本地模型已就绪: ${ev.modelName}`); }
          else if (ev.error) { console.warn(`[gui:main] 本地模型状态异常 (${ev.state}): ${ev.modelName} → ${ev.error}`); }
        }
      },
    });
    setModelServer(mgr);
    void mgr.startup(); 
    console.info("[gui:main] ModelServerManager 已初始化", { llama_bin: cfg.llama_bin ?? "(未配置)" });
  } catch (e) {
    console.error("[gui:main] 初始化 ModelServerManager 失败:", e);
  }
}

async function terminateModelServer(): Promise<void> {
  const mgr = getModelServer();
  if (mgr) {
    await mgr.shutdown().catch((e) => console.warn("[gui:main] 模型服务器关闭失败:", e));
  }
  setModelServer(new ModelServerManager({})); 
}
