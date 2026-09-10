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

/** B：审批前置分类——把 sandbox 权限请求映射为 classifier 输入做调用前复核。
 *  action 名启发分型：terminal/shell/exec/run → 命令；write/save/append → 写路径；
 *  fetch/search/http/web → 网络；其余归类 read。返回是否含拦截项 + 是否全自动 + 原因清单。 */
function classifyPermissions(actions: Array<{ action: string; target: string }>): {
  hasBlocked: boolean;
  allAuto: boolean;
  reasons: string[];
} {
  let hasBlocked = false;
  let allAuto = true;
  const reasons: string[] = [];
  for (const a of actions) {
    const name = (a.action ?? "").toLowerCase();
    const target = (a.target ?? "").trim();
    let r;
    if (/terminal|shell|exec|run_cmd|run_command|command/.test(name)) {
      const { command, commandArgs } = splitCommand(target);
      r = assessAction({ kind: "terminal", command, commandArgs });
    } else if (/write|save|append|create|patch|modify/.test(name)) {
      r = assessAction({ kind: "write", path: target });
      // 引擎源码/契约/宿主目录写入一律 block（防 Agent 自我改写护栏），仅锚定 PROJECT_ROOT 内不误伤用户工作区
      if (r.level !== "block" && isProtectedSourcePath(target, PROJECT_ROOT)) {
        r = { level: "block", reason: `受保护源码目录禁止写入：${target.slice(0, 60)}`, matched: "protected-dir" };
      }
    } else if (/fetch|search|http|web|request/.test(name)) {
      r = assessAction({ kind: "network", url: target });
    } else {
      r = { level: "auto", reason: `只读动作 ${name}`, matched: "read" };
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
import { SubAgentManager, type SubagentDefinition } from "../../../core-ts/src/services/subagent.js";
import { setSubagentManager, setMemoryStoreProvider, setAdbService, setHttpServer } from "../../../core-ts/src/tools/builtin.js";
import { assessAction, splitCommand, isProtectedSourcePath } from "../../../core-ts/src/tools/classifier.js";
import { adbService, type AdbDetect, type AdbDevice, type AdbCmdResult, type AdbScreencapResult, type AdbDownloadProgress } from "./adb.js";
import { httpServer } from "./httpServer.js";
import { createServer } from "node:http";
import { ServerA2ABus } from "../../../core-ts/src/a2a.js";
import { StatsService } from "../../../core-ts/src/services/stats.js";
import { AgentRegistry, type AgentState } from "../../../core-ts/src/services/agents.js";
import { createEngine, buildSilamTraitSignals } from "../../../core-ts/src/services/engine.js";
import { ChatClient, AnthropicClient } from "../../../core-ts/src/llm/client.js";
import { inferApiFormat, type RouteEntry } from "../../../core-ts/src/router.js";
import { chromiumFetch } from "./providers.js";
import type { ChatRequest } from "../../../core-ts/src/services/chat.js";
import type { StreamChunk, ChatInput, AgentInfo, StatsSnapshot, SidecarStatus, PermissionDecision, PermissionRequestUI, PermissionOption, AskUserRequestUI, AskUserDecision, WorkspaceEntry, WorkspaceListResult, WorkspaceReadFileResult, TermResult, GitDetect, GitInfo, GitAction, GitCloneResult, GitDiffResult, CompressResult } from "../shared/ipc.js";
import { parseUnifiedDiff } from "./git_diff.js";
import { initUpdater, registerUpdaterHandlers, setStatusSink } from "./updater.js";
import {
  listProviders, enrichModels, saveProvider, removeProvider, clearAllProviders, refreshProviderModels,
  listLocalModels, saveLocalModel, removeLocalModel, scanLocalModels,
  type ProviderSummary, type LocalModelSpec,
} from "./providers.js";
import { overview as configOverview, readConfigFile, writeConfigFile, setMcpEnabled, setSkillEnabled, deleteSkill, deleteMcp, skillDirPath } from "./config_files.js";
import { getPermissions, setPermissions } from "./permissions.js";
import { SlimeEngine } from "../../../core-ts/src/services/engine.js";
import { SilamBrainClient, readSilamConfig, type SilamBrain, type SilamAffectState } from "../../../core-ts/src/services/silam_brain.js";
import { decryptRaw } from "../../../core-ts/src/encryption.js";
import { removeAgentHistory, loadHistory, appendHistory, attachTimelineToRecord, type HistoryRecord } from "../../../core-ts/src/services/history.js";
import { SkillRegistry } from "../../../core-ts/src/skills.js";
import { getRegistry } from "../../../core-ts/src/tools/registry.js";
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
const traceStore = new Map<string, Trace>();
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
    const t = traceStore.get(sessionId);
    return t ? { sessionId, ...t } : null;
  });
}

// ── E：Plan 一等对象（plan_create/plan_update/todo_write 工具返回 → 会话级 planStore → PlanPanel） ──
// sessionId → 当前 Plan（内存驻留；工具结果流经 slime:plan:update 广播；重启后可由工具输出重建）
const planStore = new Map<string, Plan>();
const PLAN_TOOLS = new Set(["plan_create", "plan_update", "todo_write"]);

/** 解析工具返回：plan_create/plan_update 从结果 JSON 还原；todo_write 从 todos_<session> 落盘文件还原。 */
function planFromToolResult(name: string, result: string, sessionId: string): Plan | null {
  if (name === "plan_create" || name === "plan_update") {
    const idx = result.indexOf("\n"); // 工具返回形如 "[Plan 已创建] id（…）\n{json}"
    const json = idx >= 0 ? result.slice(idx + 1) : result;
    return parsePlan(json);
  }
  if (name === "todo_write" && sessionId) {
    try {
      const todoJson = join(PROJECT_ROOT, "data", `todos_${sessionId}.json`);
      if (!existsSync(todoJson)) { return null; }
      const raw = JSON.parse(readFileSync(todoJson, "utf8")) as { updated_at?: string; items?: Array<{ id?: string; content?: string; status?: string }> };
      const items = Array.isArray(raw.items) ? raw.items.filter((x) => x && typeof x.content === "string") : [];
      if (items.length === 0) { return null; }
      const statusMap: Record<string, PlanStageStatus> = { pending: "pending", in_progress: "in_progress", completed: "done", done: "done" };
      return {
        id: `todo-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "s"}`,
        sessionId,
        description: items[0]!.content!.slice(0, 60),
        stages: items.map((it, i) => ({
          id: String(it.id ?? i + 1),
          label: String(it.content ?? "").slice(0, 120),
          status: statusMap[String(it.status ?? "pending")] ?? "pending",
        })),
        createdAt: Date.parse(raw.updated_at ?? "") || Date.now(),
        updatedAt: Date.now(),
        status: "planning" as const,
      };
    } catch { return null; }
  }
  return null;
}

/** 工具轮拦截：Plan 类工具结果 → planStore 更新 + 广播渲染层。 */
function interceptPlanTool(ev: { type: string; data?: unknown }, sessionId: string): void {
  if (ev.type !== "tool" || !sessionId) { return; }
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const name = String(d.name ?? "");
  if (!PLAN_TOOLS.has(name)) { return; }
  const result = String(d.result ?? "");
  const plan = planFromToolResult(name, result, sessionId);
  if (plan) {
    planStore.set(sessionId, plan);
    mainWindow?.webContents.send("slime:plan:update", { sessionId, plan });
  }
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
    const thinking = { ...agent, reasoning_effort: "high" as const };
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
  if (opts.sessionId && res.r.transcript.length > 1) {
    try {
      const body = res.r.transcript.slice(1).map((l) => `【${l.speaker}】${l.content}`).join("\n\n");
      await appendHistory(opts.members[0].id, (opts.topic ?? "").trim() || "（群聊议题）", body, true, opts.sessionId, undefined, Date.now() - started);
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
  memberIdsOf, memberModelsOf, type MemberEntry,
} from "../../../core-ts/src/services/sessions.js";
import { loadHistoryForSession, clearSessionHistory } from "../../../core-ts/src/services/history.js";
import { needsCompress, estimateHistoryTokens, DEFAULT_TAIL_KEEP, DEFAULT_COMPRESS_RATIO } from "../../../core-ts/src/services/context_compress.js";
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
        let reply = "";
        for await (const ev of engine.stream({ agent: target, message: def.task, history: [], systemPrompt: system })) {
          if (ctx?.signal.aborted) { break; }
          if (ev.type === "done") { reply = ev.reply ?? ""; }
        }
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `subagent-${def.name}-${stamp}.md`), reply, "utf8");
        return reply;
      }, {
        concurrency: 3,
        hooks: {
          onStart: (run) => {
            console.log(`[subagent] 开始 ${run.name} (${run.id})`);
            // A-918+：派发即推送，让右侧栏「子代理」区立即看到（不等 4s 轮询）
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          onComplete: (run) => {
            console.log(`[subagent] 完成 ${run.name}${run.structured ? "（含结构化结果）" : ""}`);
            mainWindow?.webContents.send("slime:resident:update", null);
          },
          onError: (run) => {
            console.warn(`[subagent] ${run.status} ${run.name}: ${run.error ?? ""}`);
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
        timeoutMs: 120_000,
        outputSchema: true,
      });
      subagents.register({
        name: "调研员",
        description: "联网搜索资料、汇总信息、多来源调研与引用整理",
        systemPrompt: "你是多来源调研专家，输出带引用的结构化调研摘要。",
        model: "inherit",
        timeoutMs: 180_000,
        outputSchema: true,
      });
      subagents.register({
        name: "数据分析员",
        description: "数据清洗、统计、表格/指标计算与分析",
        systemPrompt: "你是数据分析专家，输出可核验的统计与结论。",
        model: "inherit",
        timeoutMs: 120_000,
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
            timeoutMs: 180_000,
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
        subagents: subagents.list(),
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
      // v2 自动委派：依任务与已注册定义的 description 语义匹配，自动选人派发；无匹配返回 ok:false
      ipcMain.handle("slime:resident:subagent:delegate", (_e, p: { task?: string; agentId?: string }) => {
        if (!p?.task) { return { ok: false, error: "task 必填" }; }
        const run = subagents.delegate(p.task, p.agentId ? { agentId: p.agentId } : {});
        if (!run) { return { ok: false, error: "无匹配的子代理定义（请先 register 定义）" }; }
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
      // A-966 修复：此前 images 未透传——粘贴/拖拽图片在 GUI 端可见、但引擎从未收到（模型回"没看到图片"）
      images: input.images,
      resumeHint: (input as { resumeHint?: string }).resumeHint,
    };
    const session = createStreamSession();
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
                const roster = [
                  loadingAgent!,
                  ...(await Promise.all(
                    memberIdsOf(brainMeta!.members).map((id) => agentRegistry!.findAgent(id).catch(() => null)),
                  )).filter((a): a is AgentState => a !== null),
                ].filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i).slice(0, 5);
                return roster.map((a) => {
                  const model = a.id === loadingAgent!.id ? brainMeta!.leaderModel : modelMap[a.id];
                  if (!model) { return a; }
                  const cap = capBy.get(a.id);
                  return { ...a, model_choice: model, ...(cap && cap > 0 ? { max_context: cap } : {}) };
                });
              })(),
              topic: req.message,
              sessionId: input.sessionId,
              networkEnabled: input.networkEnabled,
            })
          : chatService!.stream(agentId, req, input.resumeSeq ?? 0, controller.signal);
        for await (const ev of evSource) {
          recorder.push(ev);
          if (planSessionId) { interceptPlanTool(ev, planSessionId); }
          if (ev.type === "done") {
            const d = (ev.data ?? {}) as Record<string, unknown>;
            if (typeof d.reply === "string" && d.reply) { cleanReply = d.reply; }
            // A-939 上下文分桶透传（渲染层分桶托盘显示；引擎 done 事件携带各来源 token 估算）
            if (d && typeof d === "object" && "ctxBuckets" in d) { ctxBuckets = d.ctxBuckets as CtxBuckets; }
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
          ctxBuckets,
        });
        // A-918：流终态广播——渲染层据此把 per-session 快照 hasActive 校准为 false，
        // 根治「切走再切回仍显示生成中/仍重连」的假活跃状态
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
        // D：收敛 trace 并广播（成功）
        const traced = recorder.finish(true);
        traceStore.set(cancelKey, traced);
        mainWindow?.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: traced });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[gui:main] chat stream error:", msg);
        mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: cancelKey });
        mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: cancelKey });
        // D：失败轨迹也收敛广播（TraceViewer 见失败归因 eval=false + 错误摘要）
        const failedTrace = recorder.finish(false, msg);
        traceStore.set(cancelKey, failedTrace);
        mainWindow?.webContents.send("slime:trace:update", { sessionId: cancelKey, trace: failedTrace });
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

  /** A-969 上下文自动压缩：把指定会话历史压缩为摘要并写回会话 meta（后续 loadSessionHistory 自动注入摘要头 +
   *  最近 K 轮，不再全量重发）。摘要轮失败/无模型时降级硬裁剪——绝不阻塞对话。GUI 发送前触发并展示过渡动画。 */
  handleTrusted<{ sessionId?: string; ratio?: number }>("slime:chat:compress", async (_event, p): Promise<CompressResult> => {
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
      const used = estimateHistoryTokens(history);
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
            mainWindow?.webContents.send("slime:chat:chunk", chunk);
          }
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
          const traced = recorder.finish(true);
          traceStore.set(retryCancelKey, traced);
          mainWindow?.webContents.send("slime:trace:update", { sessionId: retryCancelKey, trace: traced });
          resolve({ ok: true });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[gui:main] chat retry error:", msg);
          mainWindow?.webContents.send("slime:chat:error", { message: msg, sessionId: payload.sessionId });
          mainWindow?.webContents.send("slime:chat:streamEnded", { sessionId: payload.sessionId }); // A-918
          const failedTrace = recorder.finish(false, msg);
          traceStore.set(retryCancelKey, failedTrace);
          mainWindow?.webContents.send("slime:trace:update", { sessionId: retryCancelKey, trace: failedTrace });
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
    const items: Array<{ sessionId: string; agentId: string; agentName: string; workspace?: string; title: string; count: number; lastTime: string; memberIds?: string[]; memberNames?: string[]; memberModels?: Record<string, string>; leaderModel?: string; type?: "normal" | "brainstorm" }> = [];
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
        type: meta.type,
      });
    }
    // 无会话元数据的旧历史（惰性迁移：为该 Agent 建默认会话）
    for (const [key, agg] of byKey) {
      const agentId = key.split("::")[0];
      if (!metas.some((m) => m.agentId === agentId)) {
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
    const messages: Array<{ role: "user" | "assistant"; content: string; time: string; reasoning?: string; elapsedMs?: number; timeline?: unknown[] }> = [];
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
          // A-966：历史附带交错时间线（重启后思考历程保持时间线展示）
          timeline: r.timeline as unknown[] | undefined,
        });
      }
    }
    return messages;
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
      // Python venv（随包）
      const pyExe = process.platform === "win32"
        ? resolveExtra("runtime/venv/Scripts/python.exe")
        : resolveExtra("runtime/venv/bin/python");
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
        ? resolveExtra("llama.cpp/build/bin/llama-server.exe")
        : resolveExtra("llama.cpp/build/bin/llama-server");
      const llamaOk = existsSync(llamaExe);
      items.push({
        kind: "llama", label: "llama.cpp（本地推理）", path: llamaExe, sizeText: fileSize(llamaExe), ok: llamaOk,
        source: llamaOk ? "bundled" : "missing",
        ...(llamaOk ? {} : { note: "缺失——重新运行 prepare-runtime 下载或到 设置→供应商→本地模型 配置" }),
      });
      // 模型目录（随包 npz + 按需 GGUF）
      const modelRoot = resolveExtra("models");
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
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: `读取运行环境失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /** A-918++：重建 Python venv（系统 Python → INSTALL_ROOT/../runtime/venv → pip install -r requirements.txt）。
   *  走 spawn 系统 Python（PATH 的 python.exe）。完成后 renderer 调 load() 刷新。 */
  handleTrusted<void>("slime:runtime:installPython", async (): Promise<{ ok: boolean; log?: string; error?: string }> => {
    const venvDir = resolveExtra("../runtime/venv");
    const reqFile = resolveExtra("../requirements.txt");
    // Windows 下 vbox 路径用 resolveExtra("../runtime/venv")（gui/runtime/venv 错误）
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
    async (_event, p): Promise<{ ok: boolean; content?: string; error?: string }> => {
      const rel = (p?.rel ?? "").trim();
      const ws = (p?.workspace ?? "").trim();
      const ref = p?.ref || "HEAD";
      if (!rel || !ws) { return { ok: false, error: "缺少参数" }; }
      const r = await runGit(["show", `${ref}:${rel}`], ws);
      if (r.code !== 0) {
        // 若文件在 HEAD 不存在（新增文件）→ 空内容 diff 全新增
        if (/exists on disk, but not in|did not match any file|path .* unknown revision/i.test(r.stderr)) {
          return { ok: true, content: "" };
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

  /** A-918++：HTTP —— 用系统默认浏览器打开某个访问地址 */
  handleTrusted<{ url: string }>("slime:http:open", async (_event, p): Promise<{ ok: boolean; error?: string }> => {
    const url = (p?.url ?? "").trim();
    if (!url) { return { ok: false, error: "url 不能为空" }; }
    try {
      await shell.openExternal(url);
      return { ok: true };
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
    // A-918+：探测即 enrich 填充元数据（context_window/max_output/vision/think/pricing），
    // 让「探测成功」一步到位，渲染层拿到完整 model spec 而非仅 ID
    enrichModels(p.baseUrl, p.apiKey),
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
    webContents.on("will-navigate", (e, url) => {
      // A-918++ 修复「GitHub 登录输入密码后无响应」：此前对所有 webContents 无条件 preventDefault，
      // 把 GitHub 授权窗口/内嵌 webview 的登录成功重定向也拦死了（停在原地看似无响应）。
      // 现在仅阻止【主窗口】导航到非 slime:// 的外部地址；webview / 授权子窗口放行。
      if (webContents === mainWindow?.webContents && !url.startsWith("slime://")) {
        e.preventDefault();
      }
    });
    webContents.setWindowOpenHandler(() => {
      // 仅主窗口禁止 window.open（安全）；授权窗口/webview 放行（GitHub 登录可能触发弹窗）
      if (webContents === mainWindow?.webContents) {
        return { action: "deny" };
      }
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
    });
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
