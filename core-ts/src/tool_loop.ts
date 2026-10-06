










import { ModelRouter } from "./router.js";
import { ChatMessage, ChatRequest } from "shared/schemas";
import { ToolRegistry } from "./tools/registry.js";
import { targetFromArgs } from "./tools/hard_rules.js";
import { SandboxManager } from "./sandbox.js";
import { OutputFilter, StreamFilter } from "./filter.js";

import { drainSteers } from "./services/steerBus.js";
import { agentSkillVisibilityFor, isSkillEntryToolName } from "./services/agentTools.js";

import { planReconcileText } from "./services/todoStore.js";
import { isAbsolute, join } from "node:path";


function uiIsPathTool(name: string): boolean {
  return /^(file_list|file_read|file_write|code_check)$/.test(name);
}











const SESSION_SCOPED_TOOLS = new Set(["todo_write", "plan_create", "plan_update"]);





const UNDO_SCOPED_TOOLS = new Set(["file_write", "file_delete"]);




function truncateWithDiffTag(raw: string, limit: number): string {
  const m = DIFF_TAG_RE.exec(raw);
  if (!m) { return raw.slice(0, limit); }
  const without = raw.replace(m[0], "").trim();
  return `${without.slice(0, limit)}\n${m[0]}`;
}

/** A-1194：工具执行与 abort 赛跑——用户点「停止」后以占位结果立即返回，
 *  不再让整轮 Promise.all 干等飞行中的工具（无信号支持的长工具会后台自然结束）。
 *  中断后调用方会检查 signal.aborted 提前收束，占位文本不会进入最终回复。 */
function abortableToValue<T>(p: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) { return p; }
  if (signal.aborted) { return Promise.resolve(fallback); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); resolve(fallback); };
    const cleanup = (): void => { signal.removeEventListener("abort", onAbort); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}










export { DIFF_MARKER_RE as DIFF_TAG_RE } from "./diff_marker.js";
import { DIFF_MARKER_RE as DIFF_TAG_RE } from "./diff_marker.js";


const DISPLAY_LIMIT_DEFAULT = 1200;












const DISPLAY_LIMIT_BY_TOOL: Record<string, number> = { todo_write: 8000 };


function displayLimitFor(toolName: string): number {
  return DISPLAY_LIMIT_BY_TOOL[toolName] ?? DISPLAY_LIMIT_DEFAULT;
}













export const TOOL_RESULT_CONTEXT_MAX = 24_000;


export function truncateForContext(raw: string, limit: number = TOOL_RESULT_CONTEXT_MAX): string {
  if (typeof raw !== "string" || raw.length <= limit) { return raw; }
  const m = DIFF_TAG_RE.exec(raw);
  const diffTag = m ? m[0] : "";
  const body = diffTag ? raw.replace(diffTag, "") : raw;
  if (body.length <= limit) { return diffTag ? `${body}\n${diffTag}` : body; }
  
  const budget = Math.max(2000, limit - 320 - diffTag.length);
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  const omitted = body.length - headLen - tailLen;
  const note = `\n\n……[已省略 ${omitted} 字符：工具输出过长，为保护上下文只保留开头与结尾。`
    + `需要中间内容请改用更精确的实现——按行号范围/关键字读取（grep、head/tail、sed -n 'a,bp'）或分页读取，不要一次倾倒全量输出]……\n\n`;
  return `${body.slice(0, headLen)}${note}${body.slice(-tailLen)}${diffTag ? `\n${diffTag}` : ""}`;
}



export const TOOL_MAX_ROUNDS = (() => {
  const env = typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
  const n = Number(env.SLIME_TOOL_MAX_ROUNDS);
  if (Number.isFinite(n) && n > 0) { return n; }
  return 500;
})();

/** A-1196（需求：高自由度创造模式 L3）：轮上限收敛（Agent 级 maxRounds 覆盖模块默认）。
 *  非法值一律回退默认 —— 不静默把轮数放大。 */
function resolveMaxRounds(v: number | undefined): number {
  if (v !== undefined && Number.isFinite(v) && v > 0) { return Math.floor(v); }
  return TOOL_MAX_ROUNDS;
}

export interface SandboxDecision {
  allowed: boolean;
  anomalyDetected?: boolean;
  anomalyAlerts?: string[];
  
  reason?: string;
}


export interface SandboxCheckContext {
  sessionId?: string;
}

export interface SandboxGate {
  



  check(
    agentId: string,
    toolName: string,
    target: string,
    level: number,
    ctx: SandboxCheckContext,
  ): Promise<SandboxDecision>;
}




export function sandboxGateFrom(manager: SandboxManager): SandboxGate {
  return {
    async check(agentId, toolName, target, level) {
      const r = await manager.grantPermission({ agentId, action: toolName, target, level });
      return r;
    },
  };
}

const PERM_LEVEL: Record<string, number> = { read: 0, write: 2, terminal: 3, network: 4 };


function tokEst(text: unknown): number {
  const s = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  return Math.round(s.length * 0.6);
}


interface BudgetState {
  toolCalls: number;
  tokens: number;
  startMs: number;
}


interface BudgetLimits {
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
}


function budgetReason(b: BudgetState, limits: BudgetLimits): string | null {
  if (limits.maxToolCalls !== undefined && limits.maxToolCalls > 0 && b.toolCalls >= limits.maxToolCalls) {
    return `工具调用次数已达上限（${limits.maxToolCalls} 次）`;
  }
  if (limits.maxTotalTokens !== undefined && limits.maxTotalTokens > 0 && b.tokens >= limits.maxTotalTokens) {
    return `token 预算已耗尽（${limits.maxTotalTokens}）`;
  }
  if (limits.maxWallClockMs !== undefined && limits.maxWallClockMs > 0 && Date.now() - b.startMs >= limits.maxWallClockMs) {
    return `运行时长已达上限（${limits.maxWallClockMs}ms）`;
  }
  return null;
}


export interface ToolRoundDetail {
  name: string;
  args: string;
  result: string;
}


export interface ToolLoopResult {
  text: string;
  raw: string;
  rounds: number;
  roundLog: ToolRoundDetail[];
  reasonings: string[];
  
  interrupted?: boolean;
  
  budgetExhausted?: boolean;
  
  budgetReason?: string;
  
  usage?: LoopUsage;
  





  lastUsage?: LoopUsage;
}


export interface LoopUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  
  cache_read_in_prompt?: boolean;
}


function mergeLoopUsage(acc: LoopUsage | undefined, u: LoopUsage | undefined): LoopUsage | undefined {
  if (!u) { return acc; }
  const out: LoopUsage = { ...(acc ?? {}) };
  for (const k of ["prompt_tokens", "completion_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) { out[k] = (out[k] ?? 0) + v; }
  }
  
  if (typeof u.cache_read_in_prompt === "boolean") { out.cache_read_in_prompt = u.cache_read_in_prompt; }
  return out;
}





export interface FlatToolCall {
  id: string;
  
  type?: string;
  name: string;
  arguments: string;
}


export interface ContractToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}


























export function pickFinalBody(tailText: string | undefined, allText: string | undefined): string {
  const r = tailText ?? "";
  return r ? r : (allText ?? "");
}

export function toContract(calls: FlatToolCall[]): ContractToolCall[] {
  return calls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }));
}

export function toFlat(calls: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>): FlatToolCall[] {
  return calls
    .filter((c) => c?.function && c.function.name)
    .map((c) => ({
      id: c.id ?? `t_${c.function!.name}`,
      type: "function",
      name: c.function!.name as string,
      arguments: c.function!.arguments ?? "{}",
    }));
}

export interface AskUserRequest {
  agentId: string;
  agentName?: string;
  question: string;
  options: string[];
  header?: string;
  consequences?: string[];
  recommendation?: number;
  sessionId?: string;
}
export interface AskUserResponse {
  choice?: string;
  answer: string;
  skipped?: boolean;
  cancelled?: boolean;
}
export type AskUserHook = (req: AskUserRequest) => Promise<AskUserResponse>;


export type ToolLoopEvent =
  | { type: "chunk"; content: string }
  | { type: "reasoning"; content: string }
  




  | { type: "tool-start"; id: string; name: string; args: string }
  | {
      type: "tool";
      
      id?: string;
      name: string;
      args: string;
      result: string;
      
      image?: string;
    }
  



  | { type: "steer"; id: string; text: string };





const IMG_MARKER = "@@IMG@@";

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4;

const MAX_IMAGES_PER_ROUND = 2;


function extractImages(text: string, sink: string[]): string {
  if (!text || !text.includes(IMG_MARKER)) { return text; }
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf(IMG_MARKER);
    if (i < 0) { kept.push(line); continue; }
    const url = line.slice(i + IMG_MARKER.length).trim();
    if (url.startsWith("data:image/") && sink.length < MAX_INLINE_IMAGES) {
      const comma = url.indexOf(",");
      const payload = comma >= 0 ? url.slice(comma + 1) : "";
      const approx = Math.floor((payload.length * 3) / 4);
      if (payload && approx <= MAX_INLINE_IMAGE_BYTES) { sink.push(url); }
    }
    
  }
  return kept.join("\n");
}

export interface ToolLoopStreamOptions {
  agentId: string;
  agentName?: string;
  messages: ChatMessage[];
  initialToolCalls: FlatToolCall[];
  maxTokens?: number;
  model?: string;
  tools?: ChatRequest["tools"];
  sessionId?: string;
  signal?: AbortSignal;
  onEvent?: (ev: ToolLoopEvent) => void;
  
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
  /** A-1196：本请求的工具轮上限（Agent 级 loop_config 可覆盖模块默认 TOOL_MAX_ROUNDS）。 */
  maxRounds?: number;
}

export interface ToolLoopOptions {
  agentId: string;
  agentName?: string;
  messages: ChatMessage[];
  initialToolCalls: FlatToolCall[];
  maxTokens?: number;
  model?: string;
  tools?: ChatRequest["tools"];
  sessionId?: string;
  
  signal?: AbortSignal;
  
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
  /** A-1196：本请求的工具轮上限（Agent 级 loop_config 可覆盖模块默认 TOOL_ROUNDS）。 */
  maxRounds?: number;
}

export interface ToolLoopInput {
  router: ModelRouter;
  registry: ToolRegistry;
  sandbox?: SandboxManager | SandboxGate | null;
  networkEnabled?: boolean;
  workspace?: string;
  onAskUser?: AskUserHook;
}



export class ToolLoop {
  router: ModelRouter;
  registry: ToolRegistry;
  sandbox: SandboxGate | null;
  networkEnabled: boolean;
  workspace?: string;
  outputFilter: OutputFilter;
  streamFilter: StreamFilter;
  onAskUser?: AskUserHook;

  constructor(
    routerOrOpts: ToolLoopInput | ModelRouter,
    registry?: ToolRegistry,
    opts?: {
      sandbox?: SandboxManager | SandboxGate | null;
      networkEnabled?: boolean;
      workspace?: string;
      onAskUser?: AskUserHook;
    },
  ) {
    
    if (routerOrOpts instanceof ModelRouter || !("router" in (routerOrOpts as object))) {
      
      this.router = routerOrOpts as ModelRouter;
      this.registry = registry as ToolRegistry;
      opts = opts ?? {};
    } else {
      
      const o = routerOrOpts as ToolLoopInput;
      this.router = o.router;
      this.registry = o.registry;
      opts = {
        sandbox: o.sandbox,
        networkEnabled: o.networkEnabled,
        workspace: o.workspace,
        onAskUser: o.onAskUser,
      };
    }
    
    
    this.sandbox = (opts.sandbox as SandboxGate | null | undefined) ?? null;
    this.networkEnabled = opts.networkEnabled ?? true; 
    this.workspace = opts.workspace;
    this.outputFilter = new OutputFilter();
    this.streamFilter = new StreamFilter();
    this.onAskUser = opts.onAskUser;
  }

  reasoningParams(): Record<string, unknown> {
    return {};
  }

  

  private async executePendingTools(
    messages: ChatMessage[],
    pending: FlatToolCall[],
    agentId: string,
    dedup: Set<string>,
    agentName = "",
    sessionId?: string,
    signal?: AbortSignal,
    onEvent?: (ev: ToolLoopEvent) => void,
  ): Promise<ToolRoundDetail[]> {
    
    
    
    


    if (onEvent) {
      for (const tc of pending) {
        onEvent({ type: "tool-start", id: tc.id, name: tc.name, args: tc.arguments ?? "" });
      }
    }
    const results = await Promise.all(
      pending.map(async (tc) => {
        if (signal?.aborted) {
          return { tc, msg: "[已中断] 用户停止生成，剩余工具未执行" as string };
        }
        return {
          tc,
          msg: await abortableToValue(
            this.runOneTool(tc, agentId, dedup, agentName, sessionId, signal),
            signal,
            "[已中断] 用户停止生成，工具执行被跳过",
          ),
        };
      }),
    );
    
    const details: ToolRoundDetail[] = [];
    
    const images: string[] = [];
    for (const { tc, msg } of results) {
      const own: string[] = [];
      const clean = extractImages(msg, own);
      for (const u of own) { if (images.length < MAX_INLINE_IMAGES) { images.push(u); } }
      
      
      
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: truncateForContext(clean) });
      
      const displayLimit = displayLimitFor(tc.name);
      details.push({ name: tc.name, args: (() => { try { return JSON.stringify(JSON.parse(tc.arguments || "{}")); } catch { return tc.arguments ?? ""; } })(), result: truncateWithDiffTag(clean, displayLimit) });
      if (onEvent) {
        
        onEvent({ type: "tool", id: tc.id, name: tc.name, args: tc.arguments ?? "", result: truncateWithDiffTag(clean, displayLimit), ...(own.length > 0 ? { image: own[own.length - 1] } : {}) });
      }
    }
    
    
    if (images.length > 0) {
      const use = images.slice(-MAX_IMAGES_PER_ROUND);
      const blocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: "text", text: "[系统] 以上工具回传的屏幕画面如下（图形控制截图）。请基于画面内容判断元素位置与下一步操作。" },
        ...use.map((url) => ({ type: "image_url", image_url: { url } })),
      ];
      messages.push({ role: "user", content: blocks as unknown as string });
    }
    return details;
  }

  










  private injectSteers(
    sessionId: string | undefined,
    messages: ChatMessage[],
    onEvent?: (ev: ToolLoopEvent) => void,
  ): number {
    const items = drainSteers(sessionId);
    if (items.length === 0) { return 0; }
    for (const it of items) {
      





      messages.push({
        role: "user",
        content: [
          "[用户中途插入 · Agent-Loop 编排指令]",
          "",
          "用户在你运行期间插入了下面的请求。按这个顺序处理，**不要丢掉原有任务**：",
          "1. 先用一两句话向用户确认你理解了这条请求要什么（这是本环节的「模型响应」）；",
          





          "2. 调用 todo_write 把它列入当前任务清单：**默认用 action=\"add\"**（按 id 合并，未提及的项自动保留，"
            + "已完成项保持 completed）。只有你确实要**整体重组**计划时才用 action=\"replace\"，"
            + "且那时**必须把完整清单（含所有已完成项）一并带上** —— 只带新增项就 replace 等于把用户的计划抹掉。",
          "3. 按新顺序继续执行 —— 原任务与这条插入请求都要在这轮会话里落地。",
          "",
          "—— 用户插入的原文 ——",
          it.text,
        ].join("\n"),
      });
      onEvent?.({ type: "steer", id: it.id, text: it.text });
    }
    return items.length;
  }

  





















  private reconcilePlan(
    sessionId: string | undefined,
    messages: ChatMessage[],
    roundText: string,
    mayReconcile: boolean,
  ): boolean {
    if (!mayReconcile) { return false; }                             
    if (!sessionId) { return false; }                                
    const ask = planReconcileText(sessionId);
    if (!ask) { return false; }                                      
    if (roundText) { messages.push({ role: "assistant", content: roundText }); } 
    messages.push({ role: "user", content: ask });
    return true;
  }

  

  private async runOneTool(
    tc: FlatToolCall,
    agentId: string,
    dedup: Set<string>,
    agentName: string,
    sessionId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (signal?.aborted) {
      return "[已中断] 用户停止生成，剩余工具未执行";
    }
    let args: Record<string, unknown>;
    let argsStr = tc.arguments;
    try {
      args = JSON.parse(tc.arguments || "{}");
      argsStr = JSON.stringify(args);
    } catch {
      return "[错误] 工具参数 JSON 解析失败，未执行";
    }

    const dedupKey = `${tc.name}:${argsStr}`;
    if (dedup.has(dedupKey)) {
      return "[提示] 相同参数的该工具已在本请求中执行过（结果见上方工具记录），不再重复执行";
    }

    
    if (this.workspace && !("_workspace" in args)) {
      args._workspace = this.workspace;
    }
    
    
    delete args._sandbox_allowed;

    
    
    if (tc.name === "memory_insert" || tc.name === "memory_search" || tc.name === "memory_forget"
      || tc.name === "memory_recall" || tc.name === "memory_write") {
      delete args._agent_id;
      args._agent_id = agentId;
    }
    
    
    if (tc.name === "delegate_subagent") {
      delete args._network_enabled;
      args._network_enabled = this.networkEnabled;
    }
    
    
    
    
    
    if (tc.name === "delegate_subagent" || tc.name === "subagent_result") {
      delete args._signal;
      if (signal) { args._signal = signal; }
    }

    
    
    
    if (SESSION_SCOPED_TOOLS.has(tc.name) && sessionId) {
      delete args.sessionId;
      args.sessionId = sessionId;
    }

    if (isSkillEntryToolName(tc.name)) {
      delete args._skill_scope;
      const scope = agentSkillVisibilityFor(agentId);
      if (scope) {
        args._skill_scope = {
          constrained: scope.constrained,
          allowed: [...scope.allowed],
          allowAgentAuthored: scope.allowAgentAuthored,
        };
      }
    }

    
    
    
    
    if (UNDO_SCOPED_TOOLS.has(tc.name)) {
      delete args._undo_scope;
      args._undo_scope = { agentId, sessionId: sessionId ?? "" };
    }

    
    if (!this.networkEnabled && (tc.name === "web_search" || tc.name === "web_fetch")) {
      return `[联网搜索已禁用] 工具 '${tc.name}' 被拒绝：请在 GUI 输入栏右侧打开「联网搜索」开关后重试。`;
    }

    const tool = this.registry.get(tc.name);
    if (tc.name === "ask_user" && this.onAskUser) {
      
      
      const question = String(args.question ?? "").trim();
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === "string").slice(0, 6)
        : [];
      const consequences = Array.isArray(args.consequences)
        ? args.consequences.filter((c): c is string => typeof c === "string").slice(0, 6)
        : [];
      while (consequences.length < options.length) { consequences.push(""); }
      const rec = Number(args.recommendation);
      const recommendation = Number.isInteger(rec) && rec >= 0 && rec < options.length ? rec : undefined;
      const header = typeof args.header === "string" ? String(args.header).slice(0, 24) : undefined;
      if (!question) {
        return "[错误] ask_user 缺少 question 参数";
      } else {
        
        
        
        
        const answer = await this.onAskUser({
          agentId, agentName: agentName || undefined, question, options,
          ...(header ? { header } : {}),
          ...(consequences.some((c) => c !== "") ? { consequences } : {}),
          ...(recommendation !== undefined ? { recommendation } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        if (!answer || answer.cancelled) {
          return "[已取消] 用户中止了本次生成，本提问作废（不是你的回答，也不要据此推断用户偏好）";
        }
        if (answer.skipped) {
          return "[提示] 用户未作答（跳过），请根据上下文自行判断后续方向，不要编造用户的选择";
        }
        return answer.choice
          ? `用户选择：${answer.choice}（${answer.answer}）`
          : `用户回答：${answer.answer}`;
      }
    }

    if (tool && this.sandbox) {
      
      
      let target = targetFromArgs(args);
      
      if (this.workspace && uiIsPathTool(tc.name) && target && !isAbsolute(target)) {
        target = join(this.workspace, target);
      }
      if (!target) {
        target = JSON.stringify(args);
      }
      let denied = false;
      let denyReason: string | undefined;
      let anomalyAlerts: string[] = [];
      for (const perm of tool.permissions) {
        const level = PERM_LEVEL[perm] ?? 4;
        const decision = await this.sandbox.check(agentId, tc.name, target, level, { sessionId });
        if (decision.anomalyAlerts && decision.anomalyAlerts.length > 0) {
          anomalyAlerts = decision.anomalyAlerts;
        }
        if (!decision.allowed) {
          denied = true;
          denyReason = decision.reason;
          break;
        }
      }
      if (denied) {
        const hint = anomalyAlerts.length > 0
          ? `（异常检测：${anomalyAlerts.join("、")}）`
          : "该操作需要用户确认授权；若被拒绝请向用户说明并尝试其他方案。";
        return `[沙箱拒绝] 工具 '${tc.name}' 未获授权（${denyReason ?? "权限不足"}）${hint}`;
      }
      
      
      args._sandbox_allowed = true;
      const r = await this.registry.callTool(tc.name, args);
      if (!String(r).startsWith("[沙箱拒绝]")) { dedup.add(dedupKey); }
      return r;
    }

    const r = await this.registry.callTool(tc.name, args);
    if (!String(r).startsWith("[沙箱拒绝]")) { dedup.add(dedupKey); }
    return r;
  }

  



  async run(opts: ToolLoopOptions): Promise<ToolLoopResult> {
    const dedup = new Set<string>();
    let pending = opts.initialToolCalls;
    
    let reconciled = false;
    



    let usedTodoWrite = false;
    const roundLog: Array<{ round: number; details: ToolRoundDetail[] }> = [];
    const reasonings: string[] = [];
    const reasoningParams = this.reasoningParams();
    const agentName = opts.agentName ?? "";
    
    const maxRounds = resolveMaxRounds(opts.maxRounds);
    const warnAt = Math.max(1, maxRounds - 3);
    
    const limits: BudgetLimits = { maxToolCalls: opts.maxToolCalls, maxTotalTokens: opts.maxTotalTokens, maxWallClockMs: opts.maxWallClockMs };
    const budget: BudgetState = {
      toolCalls: 0,
      tokens: opts.messages.reduce((s, m) => s + tokEst(m.content), 0),
      startMs: Date.now(),
    };
    let allText = "";
    

    let tailText = "";
    
    let usageAcc: LoopUsage | undefined;
    
    let lastUsage: LoopUsage | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      if (pending.some((tc) => tc.name === "todo_write")) { usedTodoWrite = true; }
      const details = await this.executePendingTools(opts.messages, pending, opts.agentId, dedup, agentName, opts.sessionId, opts.signal);
      roundLog.push({ round, details });
      budget.toolCalls += details.length;
      budget.tokens += details.reduce((s, d) => s + tokEst(d.result), 0);

      
      if (opts.signal?.aborted) {
        return {
          text: allText,
          raw: allText,
          rounds: round,
          roundLog: roundLog.map((r) => r.details).flat(),
          reasonings,
          interrupted: true,
          lastUsage,
          usage: usageAcc,
        };
      }

      
      if (round > 1) {
        const reason = budgetReason(budget, limits);
        if (reason) {
          const note = `\n\n[预算提示] ${reason}，任务已提前收束。以下为已收集的信息，如需更完整结果可提高预算后重试。`;
          const text = allText ? allText + note : `[预算提示] ${reason}，任务已提前收束。`;
          return { text, raw: text, rounds: round, roundLog: roundLog.map((r) => r.details).flat(), reasonings, lastUsage, budgetExhausted: true, budgetReason: reason, usage: usageAcc };
        }
      }

      
      if (round >= warnAt && round < maxRounds) {
        opts.messages.push({
          role: "system" as const,
          content: `[系统提示] 本请求工具调用轮次即将耗尽（当前第 ${round} 轮，上限 ${maxRounds} 轮）。请根据已收集的信息给出最终结论或下一步建议；无需再发起新的工具调用。`,
        });
      }

      
      
      this.injectSteers(opts.sessionId, opts.messages);

      const payload: ChatRequest = {
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        model: opts.model,
        tools: opts.tools,
      };
      Object.assign(payload, reasoningParams);
      const resp = await this.router.chat(payload, opts.signal);
      usageAcc = mergeLoopUsage(usageAcc, resp.response.usage as LoopUsage | undefined);
      
      if (resp.response.usage) { lastUsage = resp.response.usage as LoopUsage; }
      const msg = resp.response.choices[0]?.message;
      
      const reasoning = (msg as { reasoning_content?: string } | undefined)?.reasoning_content ?? "";
      if (reasoning) {
        reasonings.push(reasoning);
        budget.tokens += tokEst(reasoning);
      }
      const raw = msg?.content ?? "";
      budget.tokens += tokEst(raw);
      if (raw) { allText = allText ? `${allText}\n\n${raw}` : raw; }
      const nextCalls = toFlat((msg?.tool_calls ?? []) as unknown as Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>);
      

      if (nextCalls.length > 0) { tailText = ""; }
      else if (raw) { tailText = tailText ? `${tailText}\n\n${raw}` : raw; }
      if (nextCalls.length === 0) {
        
        
        pending = [];
        const steered = this.injectSteers(opts.sessionId, opts.messages);
        if (steered > 0) {
          if (raw) { opts.messages.push({ role: "assistant", content: raw }); }
          continue;
        }
        


        if (this.reconcilePlan(opts.sessionId, opts.messages, raw, !reconciled && usedTodoWrite)) {
          reconciled = true;
          continue;
        }
        return {
          


          text: pickFinalBody(tailText, allText), 
          raw: pickFinalBody(tailText, allText),
          rounds: round,
          roundLog: roundLog.map((r) => r.details).flat(),
          reasonings,
          lastUsage,
          usage: usageAcc,
        };
      }
      opts.messages.push({
        role: "assistant",
        content: msg?.content ?? null,
        
        reasoning_content: reasoning || undefined,
        tool_calls: toContract(nextCalls),
      });
      pending = nextCalls;
    }

    const text = this.formatRoundLimit(roundLog, maxRounds);
    return { text, raw: text, rounds: maxRounds, roundLog: roundLog.map((r) => r.details).flat(), reasonings, lastUsage, usage: usageAcc };
  }

  




  async runStream(opts: ToolLoopStreamOptions): Promise<ToolLoopResult> {
    const dedup = new Set<string>();
    let pending = opts.initialToolCalls;
    
    let reconciled = false;
    
    let usedTodoWrite = false;
    const roundLog: Array<{ round: number; details: ToolRoundDetail[] }> = [];
    const reasonings: string[] = [];
    

    let allText = "";
    

    let tailText = "";
    const reasoningParams = this.reasoningParams();
    const agentName = opts.agentName ?? "";
    
    const maxRounds = resolveMaxRounds(opts.maxRounds);
    const warnAt = Math.max(1, maxRounds - 3);
    
    const limits: BudgetLimits = { maxToolCalls: opts.maxToolCalls, maxTotalTokens: opts.maxTotalTokens, maxWallClockMs: opts.maxWallClockMs };
    const budget: BudgetState = {
      toolCalls: 0,
      tokens: opts.messages.reduce((s, m) => s + tokEst(m.content), 0),
      startMs: Date.now(),
    };
    
    let usageAcc: LoopUsage | undefined;
    
    let lastUsage: LoopUsage | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      if (pending.some((tc) => tc.name === "todo_write")) { usedTodoWrite = true; }
      const roundDetails = await this.executePendingTools(opts.messages, pending, opts.agentId, dedup, agentName, opts.sessionId, opts.signal, opts.onEvent);
      roundLog.push({ round, details: roundDetails });
      budget.toolCalls += roundDetails.length;
      budget.tokens += roundDetails.reduce((s, d) => s + tokEst(d.result), 0);

      
      
      if (opts.signal?.aborted) {
        return {
          text: allText,
          raw: allText,
          rounds: round,
          roundLog: roundLog.map((r) => r.details).flat(),
          reasonings,
          interrupted: true,
          lastUsage,
          usage: usageAcc,
        };
      }

      
      if (round > 1) {
        const reason = budgetReason(budget, limits);
        if (reason) {
          const note = `\n\n[预算提示] ${reason}，任务已提前收束。以上内容基于已收集的信息，如需更完整结果可提高预算后重试。`;
          const text = allText ? allText + note : `[预算提示] ${reason}，任务已提前收束。`;
          return {
            text,
            raw: text,
            rounds: round,
            roundLog: roundLog.map((r) => r.details).flat(),
            reasonings,
            budgetExhausted: true,
            budgetReason: reason,
            lastUsage,
            usage: usageAcc,
          };
        }
      }

      
      if (round >= warnAt && round < maxRounds) {
        opts.messages.push({
          role: "system" as const,
          content: `[系统提示] 本请求工具调用轮次即将耗尽（当前第 ${round} 轮，上限 ${maxRounds} 轮）。请根据已收集的信息给出最终结论或下一步建议；无需再发起新的工具调用。`,
        });
      }

      
      
      this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);

      const payload: ChatRequest = {
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        model: opts.model,
        tools: opts.tools,
      };
      Object.assign(payload, reasoningParams);

      
      const toolCallAcc: Array<{ index: number; id: string; name: string; args: string }> = [];
      const sf = new StreamFilter();
      let roundText = "";
      const streamRes = await this.router.chatStream(
        payload,
        (delta) => {
          const emitted = sf.push(delta, this.outputFilter, agentName);
          if (emitted) {
            roundText += emitted;
            opts.onEvent?.({ type: "chunk", content: emitted });
          }
        },
        opts.signal,
        (reasoning) => {
          reasonings.push(reasoning);
          budget.tokens += tokEst(reasoning);
          opts.onEvent?.({ type: "reasoning", content: reasoning });
        },
        (toolDeltas) => {
          for (const d of toolDeltas) {
            const idx = d.index ?? 0;
            let acc = toolCallAcc[idx];
            if (!acc) {
              acc = { index: idx, id: "", name: "", args: "" };
              toolCallAcc[idx] = acc;
            }
            if (d.id) { acc.id = d.id; }
            if (d.function?.name) { acc.name = d.function.name; }
            if (d.function?.arguments) { acc.args += d.function.arguments; }
          }
        },
      );
      usageAcc = mergeLoopUsage(usageAcc, streamRes.usage);
      
      if (streamRes.usage) { lastUsage = streamRes.usage; }
      const tail = sf.flush(this.outputFilter, agentName);
      if (tail) {
        roundText += tail;
        opts.onEvent?.({ type: "chunk", content: tail });
      }
      
      if (roundText) {
        allText = allText ? `${allText}\n\n${roundText}` : roundText;
        budget.tokens += tokEst(roundText);
      }

      const nextCalls = toolCallAcc
        .filter((a) => a.name)
        .map((a) => ({ id: a.id || `t_${a.index}`, type: "function" as const, name: a.name, arguments: a.args || "{}" }));
      

      if (nextCalls.length > 0) { tailText = ""; }
      else if (roundText) { tailText = tailText ? `${tailText}\n\n${roundText}` : roundText; }
      if (nextCalls.length === 0) {
        















        pending = [];
        const steered = this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);
        if (steered > 0) {
          if (roundText) { opts.messages.push({ role: "assistant", content: roundText }); }
          continue;
        }
        


        if (this.reconcilePlan(opts.sessionId, opts.messages, roundText, !reconciled && usedTodoWrite)) {
          reconciled = true;
          continue;
        }
        return {
          











          text: pickFinalBody(tailText, allText), 
          raw: pickFinalBody(tailText, allText),
          rounds: round,
          roundLog: roundLog.map((r) => r.details).flat(),
          reasonings,
          lastUsage,
          usage: usageAcc,
        };
      }
      opts.messages.push({
        role: "assistant",
        content: null,
        tool_calls: toContract(nextCalls),
      });
      pending = nextCalls;
    }

    const text = this.formatRoundLimit(roundLog, maxRounds);
    return { text, raw: text, rounds: maxRounds, roundLog: roundLog.map((r) => r.details).flat(), reasonings, lastUsage, usage: usageAcc };
  }

  
  private formatRoundLimit(log: Array<{ round: number; details: ToolRoundDetail[] }>, maxRounds: number): string {
    const last = log[log.length - 1];
    if (!last) { return "[警告] 工具调用达到上限，无法继续"; }
    const items = last.details
      .map((d) => `- ${d.name}(${d.args.slice(0, 60)}) → ${d.result.slice(0, 80)}`)
      .join("\n");
    return `[工具调用达到上限（${maxRounds} 轮）。已执行 ${log.reduce((s, r) => s + r.details.length, 0)} 个工具调用。请基于已有信息给出结论：\n${items}\n……`
  }
}