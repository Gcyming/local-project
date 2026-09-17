/**
 * core-ts/src/tool_loop.ts — 多轮工具调用循环（BUG-032 语义移植）。
 * 语义移植自 core/llm.py _handle_tool_calls：
 * - 每轮：执行 pending 工具调用（沙箱检查 → 去重 → 回填 tool 消息）→ 再请求模型
 * - MAX_ROUNDS=3 上限（与 core.executor.MAX_ROUNDS 对齐）；耗尽返回轮次摘要（不过滤模型名）
 * - 参数 JSON 解析失败回填错误不执行；请求级去重（同工具同参数只真实执行一次）
 * - 沙箱为插件点：sandboxGateFrom 把 L0-L5 SandboxManager 桥接为 SandboxGate（4.4）
 * - A-968：同轮多工具并发执行（Promise.all）——纯读/检索类工具无依赖可并发
 *   （对齐 Claude Code streaming concurrent execution，多工具场景 2-5× 加速）。
 */

import { ModelRouter } from "./router.js";
import { ChatMessage, ChatRequest } from "shared/schemas";
import { ToolRegistry } from "./tools/registry.js";
import { SandboxManager } from "./sandbox.js";
import { OutputFilter, StreamFilter } from "./filter.js";
import { isAbsolute, join } from "node:path";

/** 文件/路径类工具（沙箱需按路径 + 工作目录校验）；URL 走 SSRF 不在此列 */
function uiIsPathTool(name: string): boolean {
  return /^(file_list|file_read|file_write|code_check)$/.test(name);
}

/**
 * 会话级工具：存储按 sessionId 隔离（待办列表 / 计划）。
 *
 * ⚠️ sessionId **必须由工具循环注入**，不能让模型自己填：
 * - 模型并不知道真实 sessionId，只能瞎编或留空。留空会长成 `data/todos_.json`，
 *   而主进程与界面读的是 `todos_<sessionId>.json` → 待办面板永远空。
 *   （这正是 A-980-R27 的根因：用户实测"待办任务什么都没出现过"，磁盘上却
 *   躺着一个 `todos_.json`，里面是 Agent 真实规划过的任务。）
 * - 允许模型传值 = 可以跨会话读写别人的待办/计划（越权面）。
 */
const SESSION_SCOPED_TOOLS = new Set(["todo_write", "plan_create", "plan_update"]);

/** 截断工具结果时保护 [__slime_diff__] 标记（renderer 产物卡 +n/-m 与 diff 详情依赖它；
 *  正文可截断，标记必须完整保留——此前直接 slice(0,1200) 会把长 diff 的 base64 标记砍掉，
 *  产物卡永远不显示变更统计，用户实测"写入和删除的标注呢"的根因）。 */
function truncateWithDiffTag(raw: string, limit: number): string {
  const m = DIFF_TAG_RE.exec(raw);
  if (!m) { return raw.slice(0, limit); }
  const without = raw.replace(m[0], "").trim();
  return `${without.slice(0, limit)}\n${m[0]}`;
}

/** 产物变更标记（base64 的 add/del 统计）；展示与入上下文两条截断路径都要保留它 */
const DIFF_TAG_RE = /\[__slime_diff__\]([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\[\/__slime_diff__\]/;

/** 回传给界面展示的工具结果字符上限（默认值） */
const DISPLAY_LIMIT_DEFAULT = 1200;

/**
 * A-980-R32：**按工具**放宽界面展示上限。
 *
 * `todo_write` 的回执不是普通工具输出，而是 `renderTodos` 渲染的**待办全景清单**
 * （进度头 + 最多 TODO_RENDER_MAX=30 条 `- [x] 内容`）。渲染层要把这份文本解析成
 * 「计划卡 + 逐项完成播报」折进思考历程：
 *  - 按 1200 截断会把长清单的尾部整条剪掉 → 计划卡缺项，用户看到"规划少了后面几条"；
 *  - 更糟的是截断可能落在某条**中间**，解析出的内容残缺 → 下一轮回执对比时该项内容对不上
 *    → 被当成"新任务"又播报一遍（重复刷屏）。
 * 清单本身体积很小（30 项 ≈ 1.5K 字符），放宽不构成上下文/内存压力，故单独给足空间。
 */
const DISPLAY_LIMIT_BY_TOOL: Record<string, number> = { todo_write: 8000 };

/** 该工具回传界面时允许的字符数 */
function displayLimitFor(toolName: string): number {
  return DISPLAY_LIMIT_BY_TOOL[toolName] ?? DISPLAY_LIMIT_DEFAULT;
}

/** A-980-R24：**进入上下文**的工具结果硬上限（字符，≈6K token）。
 *
 *  此前工具结果**全文**进 messages（`messages.push({ role:"tool", … content: clean })`），
 *  只有给界面展示的那一份被截到 1200 字符。但单次工具输出可以极其巨大：
 *  `gui/src/main/adb.ts` 的 maxBuffer 允许 64MB、git 16MB、`file_read` 256KB ——
 *  一条 `adb logcat`、一次大文件 `cat`、一个几万行的 `git diff` 就能把数 MB 文本塞进上下文。
 *  后果是双重的：
 *    ① 该轮请求体积暴涨；工具循环每轮都要**全量重发历史** → 上游直接报「超出上下文/400」→ 任务中断；
 *    ② 主进程与渲染层要序列化/渲染这段巨型字符串 → 内存顶爆、界面卡死。
 *
 *  这里做「头 + 尾 + 明示省略」：头（开头结论/命令回显）与尾（错误栈/最后输出）通常最关键，
 *  中间换成明确提示，并告诉模型**怎么拿剩余内容**（否则它会以为输出就这么点，进而编造结论）。 */
export const TOOL_RESULT_CONTEXT_MAX = 24_000;

/** 工具结果 → 入上下文的安全形态（保留 diff 标记；超限则头尾保留 + 显式省略说明） */
export function truncateForContext(raw: string, limit: number = TOOL_RESULT_CONTEXT_MAX): string {
  if (typeof raw !== "string" || raw.length <= limit) { return raw; }
  const m = DIFF_TAG_RE.exec(raw);
  const diffTag = m ? m[0] : "";
  const body = diffTag ? raw.replace(diffTag, "") : raw;
  if (body.length <= limit) { return diffTag ? `${body}\n${diffTag}` : body; }
  // 预留 ~320 字符给省略说明与 diff 标记
  const budget = Math.max(2000, limit - 320 - diffTag.length);
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  const omitted = body.length - headLen - tailLen;
  const note = `\n\n……[已省略 ${omitted} 字符：工具输出过长，为保护上下文只保留开头与结尾。`
    + `需要中间内容请改用更精确的实现——按行号范围/关键字读取（grep、head/tail、sed -n 'a,bp'）或分页读取，不要一次倾倒全量输出]……\n\n`;
  return `${body.slice(0, headLen)}${note}${body.slice(-tailLen)}${diffTag ? `\n${diffTag}` : ""}`;
}

/** 工具循环轮次上限（默认 500；可通过环境变量 SLIME_TOOL_MAX_ROUNDS 覆盖；分析类任务 8-12 轮、研究类 15-20 轮）。
 *  2026-08-29 用户要求：默认调到 500（A-152，此前 40 轮对长链路/多工具集成任务偏紧）。 */
export const TOOL_MAX_ROUNDS = (() => {
  const env = typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
  const n = Number(env.SLIME_TOOL_MAX_ROUNDS);
  if (Number.isFinite(n) && n > 0) { return n; }
  return 500;
})();

export interface SandboxDecision {
  allowed: boolean;
  anomalyDetected?: boolean;
  anomalyAlerts?: string[];
  /** 拒绝原因（未授权 / 超出工作目录范围等）；tool_loop 透传给模型改进重试 */
  reason?: string;
}

/** 沙箱检查上下文（触发请求的流所属会话；GUI 据此让渲染层丢弃切会话后旧流请求） */
export interface SandboxCheckContext {
  sessionId?: string;
}

export interface SandboxGate {
  /**
   * 按工具所需权限逐级检查；返回拒绝原因时工具不执行（对齐 manager.check_permission 语义）。
   * 实现方负责持久化审批结果（GUI：询问用户并写权限持久化；测试：全量放行 / 拒绝）。
   */
  check(
    agentId: string,
    toolName: string,
    target: string,
    level: number,
    ctx: SandboxCheckContext,
  ): Promise<SandboxDecision>;
}

/** 把 SandboxManager 桥接为 SandboxGate（engine.ts 传入 SandboxManager 时自动转换）。
   *  走 grantPermission（异步授权 + 审计落库）而非 checkPermission（同步纯决策无审计）——
   *  与工具循环的审计语义一致（工具执行必须在 audit 留痕）。 */
export function sandboxGateFrom(manager: SandboxManager): SandboxGate {
  return {
    async check(agentId, toolName, target, level) {
      const r = await manager.grantPermission({ agentId, action: toolName, target, level });
      return r;
    },
  };
}

const PERM_LEVEL: Record<string, number> = { read: 0, write: 2, terminal: 3, network: 4 };

/** token 估算（~0.6×字符数，量级对齐 engine.estimateTokens；本文件不依赖 engine 防循环导入） */
function tokEst(text: unknown): number {
  const s = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  return Math.round(s.length * 0.6);
}

/** 任务预算状态（run / runStream 各自维护一份，累计跨轮） */
interface BudgetState {
  toolCalls: number;
  tokens: number;
  startMs: number;
}

/** 预算上限（缺省 undefined = 不限制） */
interface BudgetLimits {
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
}

/** 任一预算超限返回原因文案；未超限返回 null。 */
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

/** 工具调用结果记录（RoundLog） */
export interface ToolRoundDetail {
  name: string;
  args: string;
  result: string;
}

/** 工具循环对外结果 */
export interface ToolLoopResult {
  text: string;
  raw: string;
  rounds: number;
  roundLog: ToolRoundDetail[];
  reasonings: string[];
  /** A-162/A-164：是否因用户停止/插入指令（signal abort）提前终止——中止后已产出的（子）内容保留在 text */
  interrupted?: boolean;
  /** 是否因任务预算（工具次数/token/时长）耗尽提前收束——已产出内容保留在 text，末尾附预算提示 */
  budgetExhausted?: boolean;
  /** 预算耗尽的具体原因（供上层/GUI 展示与审计） */
  budgetReason?: string;
  /** 跨轮累计的上游 usage（含缓存命中 token，done 事件据此还原缓存命中率） */
  usage?: LoopUsage;
  /**
   * A-974-R7：**最近一轮**（最后一次上游请求）的 usage —— 上下文窗口占用的唯一正确数据源。
   * 工具循环每一轮都会全量重发历史，因此 `usage`（跨轮累计）是**计费口径**（各轮都付费），
   * 而"当前窗口占用"只能取最后一轮。此前 GUI 用累计值当窗口占用 → N 轮 × 全量历史叠加，
   * 数值虚高数倍（用户实测：正文输出后上下文环/右栏直接爆到 1.1M，实际窗口仅约 600K）。
   */
  lastUsage?: LoopUsage;
}

/** 跨轮累计的 token 用量（对齐 client.ChatStreamResult["usage"] 形态） */
export interface LoopUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  /** A-974-R8：该上游 `prompt_tokens` 是否已含缓存命中（OpenAI 兼容=true / Anthropic=false） */
  cache_read_in_prompt?: boolean;
}

/** 归并一轮用量到累计器（累加数值字段）。 */
function mergeLoopUsage(acc: LoopUsage | undefined, u: LoopUsage | undefined): LoopUsage | undefined {
  if (!u) { return acc; }
  const out: LoopUsage = { ...(acc ?? {}) };
  for (const k of ["prompt_tokens", "completion_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens"] as const) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) { out[k] = (out[k] ?? 0) + v; }
  }
  // A-974-R8：协议语义标记透传（取本轮的；语义不会跨轮变化）
  if (typeof u.cache_read_in_prompt === "boolean") { out.cache_read_in_prompt = u.cache_read_in_prompt; }
  return out;
}

/** FlatToolCall = 模型返回的未解析 tool_call（arguments 是 JSON string，name 平铺在顶层）。
 *  上游 OpenAI 兼容结构 { id, type, function:{name, arguments} } 经 toFlat() 转换而来。
 *  type 可选：扁平调用本身不消费 type（toContract 固定补 "function"）；测试/调用方
 *  传 { id, name, arguments } 即可（不需要重复声明 type）。 */
export interface FlatToolCall {
  id: string;
  /** 上游携带的 "function"；扁平调用不强制（toContract 会补全） */
  type?: string;
  name: string;
  arguments: string;
}

/** 与 OpenAI Contract ToolCall 对齐的格式（tool_calls 入队统一这个结构，功能上函数名嵌套） */
export interface ContractToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
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
}
export type AskUserHook = (req: AskUserRequest) => Promise<AskUserResponse>;

/** 流式工具循环事件（engine.ts 消费：chunk 正文 / reasoning 思考 / tool 工具结果） */
export type ToolLoopEvent =
  | { type: "chunk"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool"; name: string; args: string; result: string; /** 图形控制截图（data URL），供 GUI 缩略图预览；不回灌到模型文本 */ image?: string };

/* ── 图形控制：截图标记抽取 ──
 * screen_* 工具在结果里附一行 `@@IMG@@data:image/...;base64,...`；
 * 本循环把该行抽出（base64 绝不进文本上下文，否则一次截图就吃掉几 MB token），
 * 然后以 content-blocks 形式作为下一条 user 消息回灌 —— 模型因此能"看见"屏幕。 */
const IMG_MARKER = "@@IMG@@";
/** 与 engine.sanitizeImages 对齐的上限（本文件不 import engine，避免循环依赖） */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4;
/** 每轮回灌的最大张数（只给最近 2 张当前画面，控 token） */
const MAX_IMAGES_PER_ROUND = 2;

/** 从工具结果文本中抽出 @@IMG@@ 图像行；返回剥离图像后的文本（保留其余说明） */
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
    // 标记行整体丢弃：图像只走视觉通道，不进文本
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
  /** 任务预算护栏（三者独立，任一达到即优雅收束；缺省=不限制） */
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
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
  /** 任务预算护栏（三者独立，任一达到即优雅收束；缺省=不限制） */
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
}

/** 工具循环构造参数（对象形式）。兼容旧的 (router, registry, opts?) 三参调用——旧调用方
 *  三参里没传 sandbox 等价于 { sandbox: undefined }，行为不变。测试/引擎均以对象形式为主。 */
export interface ToolLoopInput {
  router: ModelRouter;
  registry: ToolRegistry;
  sandbox?: SandboxManager | SandboxGate | null;
  networkEnabled?: boolean;
  workspace?: string;
  onAskUser?: AskUserHook;
}

/** 多轮工具循环实现（ChatEngine 真入口）。
 *  对齐 core/llm.py ToolLoop 语义：executePendingTools → chat → loop。 */
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
    // 对象形式：new ToolLoop({ router, registry, sandbox?, ... })
    if (routerOrOpts instanceof ModelRouter || !("router" in (routerOrOpts as object))) {
      // 3 参形式：new ToolLoop(router, registry, opts?)
      this.router = routerOrOpts as ModelRouter;
      this.registry = registry as ToolRegistry;
      opts = opts ?? {};
    } else {
      // 对象形式
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
    // SandboxManager（checkPermission）与 SandboxGate 结构兼容：4 参实现可赋给 5 参接口，
    // 返回 PermissionCheckResult 覆盖 SandboxDecision 全字段。直接按 SandboxGate 类型收窄即可。
    this.sandbox = (opts.sandbox as SandboxGate | null | undefined) ?? null;
    this.networkEnabled = opts.networkEnabled ?? true; // A-918+：联网工具开箱即用（缺省从 false 改为 true），仅 renderer 显式传 false 才 gate
    this.workspace = opts.workspace;
    this.outputFilter = new OutputFilter();
    this.streamFilter = new StreamFilter();
    this.onAskUser = opts.onAskUser;
  }

  reasoningParams(): Record<string, unknown> {
    return {};
  }

  /** 执行一轮 pending 工具调用（A-968 并发版）。返回按模型回传顺序排列的 Results。
   *  onEvent 可选：流式（runStream）透传每条工具的实时 tool 事件；run() 不传（旧行为无事件）。 */
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
    // A-968：同轮多工具并发执行（Promise.all）——file_read/web_search/code_check 等纯读检索
    // 工具彼此无依赖（对齐 Claude Code streaming concurrent execution，多工具场景 2-5× 加速）。
    // abort 在每个工具执行前检查；去重 dedup 为并发共享集，命中重复的工具返回提示串不重复执行。
    const results = await Promise.all(
      pending.map(async (tc) => {
        if (signal?.aborted) {
          return { tc, msg: "[已中断] 用户停止生成，剩余工具未执行" as string };
        }
        return { tc, msg: await this.runOneTool(tc, agentId, dedup, agentName, sessionId, signal) };
      }),
    );
    // 按模型回传顺序回填（不按完成先后，避免 tool_call_id 错位）；同时实时通知（思考过程展示）
    const details: ToolRoundDetail[] = [];
    /** 本轮工具产生的图像（图形控制截图）——抽出后回灌视觉通道 */
    const images: string[] = [];
    for (const { tc, msg } of results) {
      const own: string[] = [];
      const clean = extractImages(msg, own);
      for (const u of own) { if (images.length < MAX_INLINE_IMAGES) { images.push(u); } }
      // name 一并回传：Gemini 等原生端点按函数名匹配 functionCall↔functionResponse，而非 OpenAI 的 call_id
      // A-980-R24：**入上下文前必须截断**（展示用的 1200 截断管不到这里）。
      // 几 MB 的工具输出原样进 messages → 工具循环每轮全量重发 → 上游超长报错、主进程内存爆掉。
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: truncateForContext(clean) });
      // A-980-R32：展示用上限按工具取（todo_write 放宽，见 DISPLAY_LIMIT_BY_TOOL）
      const displayLimit = displayLimitFor(tc.name);
      details.push({ name: tc.name, args: (() => { try { return JSON.stringify(JSON.parse(tc.arguments || "{}")); } catch { return tc.arguments ?? ""; } })(), result: truncateWithDiffTag(clean, displayLimit) });
      if (onEvent) {
        onEvent({ type: "tool", name: tc.name, args: tc.arguments ?? "", result: truncateWithDiffTag(clean, displayLimit), ...(own.length > 0 ? { image: own[own.length - 1] } : {}) });
      }
    }
    // 截图回灌：作为下一条 user 消息的 content-blocks（模型因此能看见屏幕画面）。
    // 若工具未把图像挂到事件上（如 screen_capture 返回后又经 screen_action 复截），此处补一条汇总事件供 GUI 预览。
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

  /** 单个工具执行（并发安全）：解析参数 → 去重 → 工作目录锚定 → 联网开关 → ask_user/沙箱 → callTool。
   *  与旧串行版语义一致：解析失败/去重/联网禁用/沙箱拒绝均返回提示文本（供模型感知调整）。 */
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

    // 注入 Agent 工作目录上下文（file_* / code_check 据此锚定项目根 ∪ 工作目录）
    if (this.workspace && !("_workspace" in args)) {
      args._workspace = this.workspace;
    }
    // 安全：清除模型可能注入的 _sandbox_allowed——该豁免只能由本循环在沙箱审批通过后置位，
    // 防止模型通过工具参数自授权绕过路径限制（无沙箱的调用路径不会拿到豁免）。
    delete args._sandbox_allowed;

    // 注入当前 Agent 标识：仅 memory_* 工具需要（据此定位该 Agent 的记忆存储）；
    // 覆盖模型可能伪造的 _agent_id，防止跨 Agent 读写记忆。其余工具不注入，避免污染入参。
    if (tc.name === "memory_insert" || tc.name === "memory_search" || tc.name === "memory_forget") {
      delete args._agent_id;
      args._agent_id = agentId;
    }

    // 注入受信 sessionId：会话级工具（待办 / 计划）据此定位本会话的存储文件。
    // ⚠️ 先 delete 再写，覆盖模型可能伪造的同名参数（防跨会话越权）。
    // 无 sessionId（CLI/测试环境）时不注入，让工具自己如实报错，而不是静默写进空名文件。
    if (SESSION_SCOPED_TOOLS.has(tc.name) && sessionId) {
      delete args.sessionId;
      args.sessionId = sessionId;
    }

    // 联网搜索开关：web_search / web_fetch 在未启用时被静默拒绝（模型侧无法绕过）
    if (!this.networkEnabled && (tc.name === "web_search" || tc.name === "web_fetch")) {
      return `[联网搜索已禁用] 工具 '${tc.name}' 被拒绝：请在 GUI 输入栏右侧打开「联网搜索」开关后重试。`;
    }

    const tool = this.registry.get(tc.name);
    if (tc.name === "ask_user" && this.onAskUser) {
      // ask_user 工具：模型向用户提问（方向分歧 / 关键决策）→ 走 onAskUser 钩子
      // （GUI 输入框选择题 UI）；无钩子/无 UI 环境（CLI/测试）回退工具内置提示，不编造用户回答。
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
        // A-9xx：契约只携带有效字段——header/consequences/recommendation/sessionId 无真实值时
        // 直接省略（对齐 Anthropic AskUserQuestion 的 label/description 可选、Codex
        // request_user_input 的 recommendation 独立可选语义；不给 UI 塞 undefined/空串占位）。
        // consequences 全为空串（模型未给选项后果）时同样省略，UI 端 consequences?.[i] 已兼容缺省。
        const answer = await this.onAskUser({
          agentId, agentName: agentName || undefined, question, options,
          ...(header ? { header } : {}),
          ...(consequences.some((c) => c !== "") ? { consequences } : {}),
          ...(recommendation !== undefined ? { recommendation } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        if (!answer || answer.skipped) {
          return "[提示] 用户未作答（跳过），请根据上下文自行判断后续方向，不要编造用户的选择";
        }
        return answer.choice
          ? `用户选择：${answer.choice}（${answer.answer}）`
          : `用户回答：${answer.answer}`;
      }
    }

    if (tool && this.sandbox) {
      let target = String(args.url ?? args.path ?? args.file ?? args.target ?? "");
      // 相对路径 + 配置工作目录 → 锚定工作目录转绝对，避免沙箱以进程 CWD 为基准误判超范围
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
      // 沙箱已放行（含用户批准的工作目录外操作）→ 通知工具层跳过外部路径硬拒；
      // 敏感文件/黑名单/符号链接防护仍在工具内部强制，不随豁免降级。
      args._sandbox_allowed = true;
      const r = await this.registry.callTool(tc.name, args);
      if (!String(r).startsWith("[沙箱拒绝]")) { dedup.add(dedupKey); }
      return r;
    }

    const r = await this.registry.callTool(tc.name, args);
    if (!String(r).startsWith("[沙箱拒绝]")) { dedup.add(dedupKey); }
    return r;
  }

  /**
   * 多轮工具循环：执行工具 → 请求 → 模型继续要工具则再轮（上限 TOOL_MAX_ROUNDS）。
   * 返回 { text, raw, rounds, roundLog }；text 为对外安全文本（raw 供存储/学习）。
   */
  async run(opts: ToolLoopOptions): Promise<ToolLoopResult> {
    const dedup = new Set<string>();
    let pending = opts.initialToolCalls;
    const roundLog: Array<{ round: number; details: ToolRoundDetail[] }> = [];
    const reasonings: string[] = [];
    const reasoningParams = this.reasoningParams();
    const agentName = opts.agentName ?? "";
    /** 接近上限时注入提醒，促使模型收束而非硬熔断 */
    const warnAt = Math.max(1, TOOL_MAX_ROUNDS - 3);
    /** 任务预算（#4 护栏）：跨轮累计；allText 承载预算耗尽时保留的已产出正文 */
    const limits: BudgetLimits = { maxToolCalls: opts.maxToolCalls, maxTotalTokens: opts.maxTotalTokens, maxWallClockMs: opts.maxWallClockMs };
    const budget: BudgetState = {
      toolCalls: 0,
      tokens: opts.messages.reduce((s, m) => s + tokEst(m.content), 0),
      startMs: Date.now(),
    };
    let allText = "";
    /** 跨轮累计上游 usage（缓存命中 token 透传） */
    let usageAcc: LoopUsage | undefined;
    /** A-974-R7：最近一轮 usage（窗口占用数据源，见 ToolLoopResult.lastUsage） */
    let lastUsage: LoopUsage | undefined;

    for (let round = 1; round <= TOOL_MAX_ROUNDS; round++) {
      const details = await this.executePendingTools(opts.messages, pending, opts.agentId, dedup, agentName, opts.sessionId);
      roundLog.push({ round, details });
      budget.toolCalls += details.length;
      budget.tokens += details.reduce((s, d) => s + tokEst(d.result), 0);

      // 预算护栏：第 2 轮起，在发起下一批模型请求前熔断（保留已产出内容，末尾附提示）
      if (round > 1) {
        const reason = budgetReason(budget, limits);
        if (reason) {
          const note = `\n\n[预算提示] ${reason}，任务已提前收束。以下为已收集的信息，如需更完整结果可提高预算后重试。`;
          const text = allText ? allText + note : `[预算提示] ${reason}，任务已提前收束。`;
          return { text, raw: text, rounds: round, roundLog: roundLog.map((r) => r.details).flat(), reasonings, lastUsage, budgetExhausted: true, budgetReason: reason, usage: usageAcc };
        }
      }

      // 最后三轮：提示模型收敛
      if (round >= warnAt && round < TOOL_MAX_ROUNDS) {
        opts.messages.push({
          role: "system" as const,
          content: `[系统提示] 本请求工具调用轮次即将耗尽（当前第 ${round} 轮，上限 ${TOOL_MAX_ROUNDS} 轮）。请根据已收集的信息给出最终结论或下一步建议；无需再发起新的工具调用。`,
        });
      }

      const payload: ChatRequest = {
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        model: opts.model,
        tools: opts.tools,
      };
      Object.assign(payload, reasoningParams);
      const resp = await this.router.chat(payload);
      usageAcc = mergeLoopUsage(usageAcc, resp.response.usage as LoopUsage | undefined);
      // A-974-R7：同时记录本轮（最后一次请求）的原始 usage —— 窗口占用取它，不取累计
      if (resp.response.usage) { lastUsage = resp.response.usage as LoopUsage; }
      const msg = resp.response.choices[0]?.message;
      // 思考内容提取（OpenAI 兼容响应 message.reasoning_content；schema 未含该字段，类型断言）
      const reasoning = (msg as { reasoning_content?: string } | undefined)?.reasoning_content ?? "";
      if (reasoning) {
        reasonings.push(reasoning);
        budget.tokens += tokEst(reasoning);
      }
      const raw = msg?.content ?? "";
      budget.tokens += tokEst(raw);
      if (raw) { allText = allText ? `${allText}\n\n${raw}` : raw; }
      const nextCalls = toFlat((msg?.tool_calls ?? []) as unknown as Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>);
      if (nextCalls.length === 0) {
        return {
          text: raw,
          raw,
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
        // DeepSeek 思考模式：reasoning_content 必须原样回传，否则上游 400（invalid_request_error）
        reasoning_content: reasoning || undefined,
        tool_calls: toContract(nextCalls),
      });
      pending = nextCalls;
    }

    const text = this.formatRoundLimit(roundLog);
    return { text, raw: text, rounds: TOOL_MAX_ROUNDS, roundLog: roundLog.map((r) => r.details).flat(), reasonings, lastUsage, usage: usageAcc };
  }

  /**
   * 真流式工具循环（5B.3）：每轮用 chatStream 流式请求，思考/正文边到边回调 onEvent，
   * 实时可见（而非等整轮完成才一次性回放）。delta.tool_calls 按 index 累积 → 执行 → 下一轮。
   * 返回 { text, raw, rounds, roundLog, reasonings }；text 为过滤后展示文本。
   */
  async runStream(opts: ToolLoopStreamOptions): Promise<ToolLoopResult> {
    const dedup = new Set<string>();
    let pending = opts.initialToolCalls;
    const roundLog: Array<{ round: number; details: ToolRoundDetail[] }> = [];
    const reasonings: string[] = [];
    /** 跨轮累积的模型正文（每轮 roundText 只含当轮内容；最终 reply 必须包含全部轮次）。 */
    let allText = "";
    const reasoningParams = this.reasoningParams();
    const agentName = opts.agentName ?? "";
    /** 接近上限时注入提醒，促使模型收束而非硬熔断 */
    const warnAt = Math.max(1, TOOL_MAX_ROUNDS - 3);
    /** 任务预算（#4 护栏）：跨轮累计；allText 承载预算耗尽时保留的已产出正文 */
    const limits: BudgetLimits = { maxToolCalls: opts.maxToolCalls, maxTotalTokens: opts.maxTotalTokens, maxWallClockMs: opts.maxWallClockMs };
    const budget: BudgetState = {
      toolCalls: 0,
      tokens: opts.messages.reduce((s, m) => s + tokEst(m.content), 0),
      startMs: Date.now(),
    };
    /** 跨轮累计上游 usage（缓存命中 token 透传） */
    let usageAcc: LoopUsage | undefined;
    /** A-974-R7：最近一轮 usage（窗口占用数据源，见 ToolLoopResult.lastUsage） */
    let lastUsage: LoopUsage | undefined;

    for (let round = 1; round <= TOOL_MAX_ROUNDS; round++) {
      const roundDetails = await this.executePendingTools(opts.messages, pending, opts.agentId, dedup, agentName, opts.sessionId, opts.signal, opts.onEvent);
      roundLog.push({ round, details: roundDetails });
      budget.toolCalls += roundDetails.length;
      budget.tokens += roundDetails.reduce((s, d) => s + tokEst(d.result), 0);

      // A-162：signal 已中止（用户停止/插入指令）→ 后续（含新一轮模型请求）不再执行。
      // 已产出的正文/工具结果保留在 allText/roundLog，仅中断而非丢弃。
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

      // 预算护栏：第 2 轮起，在发起下一批模型请求前熔断（保留已产出内容，末尾附提示）
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

      // 最后三轮：提示模型收敛
      if (round >= warnAt && round < TOOL_MAX_ROUNDS) {
        opts.messages.push({
          role: "system" as const,
          content: `[系统提示] 本请求工具调用轮次即将耗尽（当前第 ${round} 轮，上限 ${TOOL_MAX_ROUNDS} 轮）。请根据已收集的信息给出最终结论或下一步建议；无需再发起新的工具调用。`,
        });
      }

      const payload: ChatRequest = {
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        model: opts.model,
        tools: opts.tools,
      };
      Object.assign(payload, reasoningParams);

      /** 流式 delta 累加器（tool_calls 增量按 index 累积） */
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
      // A-974-R7：记录本轮（最后一次请求）原始 usage —— 窗口占用取它，不取累计（同上）
      if (streamRes.usage) { lastUsage = streamRes.usage; }
      const tail = sf.flush(this.outputFilter, agentName);
      if (tail) {
        roundText += tail;
        opts.onEvent?.({ type: "chunk", content: tail });
      }
      // 把本轮正文并入跨轮累积（含默认轮：模型在最终轮可能只发工具调用、无任何正文）
      if (roundText) {
        allText = allText ? `${allText}\n\n${roundText}` : roundText;
        budget.tokens += tokEst(roundText);
      }

      const nextCalls = toolCallAcc
        .filter((a) => a.name)
        .map((a) => ({ id: a.id || `t_${a.index}`, type: "function" as const, name: a.name, arguments: a.args || "{}" }));
      if (nextCalls.length === 0) {
        return {
          text: allText,
          raw: allText,
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

    const text = this.formatRoundLimit(roundLog);
    return { text, raw: text, rounds: TOOL_MAX_ROUNDS, roundLog: roundLog.map((r) => r.details).flat(), reasonings, lastUsage, usage: usageAcc };
  }

  /** 工具调用超轮时的提示文案（硬截断提示，不对 LLM 说话） */
  private formatRoundLimit(log: Array<{ round: number; details: ToolRoundDetail[] }>): string {
    const last = log[log.length - 1];
    if (!last) { return "[警告] 工具调用达到上限，无法继续"; }
    const items = last.details
      .map((d) => `- ${d.name}(${d.args.slice(0, 60)}) → ${d.result.slice(0, 80)}`)
      .join("\n");
    return `[工具调用达到上限（${TOOL_MAX_ROUNDS} 轮）。已执行 ${log.reduce((s, r) => s + r.details.length, 0)} 个工具调用。请基于已有信息给出结论：\n${items}\n……`
  }
}