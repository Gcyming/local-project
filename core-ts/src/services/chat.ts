/**
 * core-ts/src/services/chat.ts — ChatService（slime_server.py /chat、/chat/analyze、/chat/stream 语义移植）。
 * 承载端点全语义：
 * - analyze：Swarm 分裂分析（build_swarm_analysis_prompt + parseSwarmAnalysis，A-015 显式降级）
 * - chat：委托 prompt → A2A 排水 → A-098 平台证据注入 → 推理 → 委托/广播路由（≤3）
 *        → A-087 失败前缀黑名单 → A-090 reply_raw 分离 → 交互/历史持久化 → 后台 post-process
 * - stream：事件流（chunk/tool/reasoning/progress/done/heartbeat/error，统一 {seq,type,data}）
 *        → A-049/A-085 编造检测强制工具轮 → 委托心跳（15s）→ done 单收尾 → finally 持久化
 * 依赖注入：ChatEngine（模型+工具轮执行器）、ServerA2ABus、AgentRegistry、post-process hooks
 * （evolution/记忆提取为 5B.3 注入点，缺省跳过并告警——对齐 Python best-effort 语义）。
 */

import { ChatMessage } from "shared/schemas";
import {
  buildDelegationPrompt,
  parseBroadcast,
  parseDelegations,
  stripDelegationTags,
  ServerA2ABus,
} from "../a2a.js";
import { findUnverifiedClaims } from "../claims.js";
import { AgentRegistry, AgentState, PersonaModel } from "./agents.js";
import {
  resolveAgentToolProfile,
  agentToolsOnly,
  agentSkillGuide,
} from "./agentTools.js";
import {
  fileHistoryStore,
  HistoryStore,
} from "./history.js";
import { detectNovelty } from "./novelty.js";
import { EmotionalState } from "../mind/emotion.js";
import { BehaviorStore, ConsolidationEngine } from "../mind/behavior.js";
import { getKnowledgeEngine } from "../memory/knowledge.js";
import { consolidateMemoryNow } from "../memory/store.js";
import { EventSequence, ServiceEvent } from "./events.js";
import { AlarmBus, getAlarmBus, AlarmSeverity } from "./stats.js";
import { getSession } from "./sessions.js";

// ── 常量（对齐 slime_server.py）────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STREAM_MAX_CHARS = 10 * 1024 * 1024;
export const MAX_DELEGATIONS = 3;

/** A-980-R24：工具循环的**默认预算护栏**（可被环境变量覆盖）。
 *
 *  `core-ts/src/tool_loop.ts` 早就定义了 `maxToolCalls` / `maxTotalTokens` / `maxWallClockMs`，
 *  但 GUI 调用链（`chat.ts` → `engine.stream`）**从来没有传过** —— 于是实际只有
 *  `TOOL_MAX_ROUNDS`（500 轮）在生效，另外三道护栏是死代码。
 *
 *  后果：模型陷入"反复调工具但拿不到进展"时，会一路跑满 500 轮；而工具循环**每轮都要全量重发
 *  历史消息**，于是主进程内存与上游请求体积双双膨胀 → 渲染进程 OOM（`renderer-crash.log` 有过
 *  `oom` 记录）/ 上游超长报错 → 用户侧看到的就是"用着用着 slime 直接崩了、任务中断"。
 *
 *  这里补上**宽松但有限**的默认值（正常任务差 1~2 个数量级，只拦真正失控的循环；
 *  命中后 `tool_loop` 会给模型"预算耗尽"提示并**优雅收束**输出已有结论，不是硬中断）：
 *    - 墙钟 3 小时（`SLIME_MAX_WALL_CLOCK_MS`）：单轮对话跑过 3 小时必然是卡死，不是长任务；
 *    - 累计 token 1200 万（`SLIME_MAX_TOTAL_TOKENS`）。 */
function positiveEnvNumber(key: string, fallback: number): number {
  const env = typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const DEFAULT_TOOL_WALL_CLOCK_MS = positiveEnvNumber("SLIME_MAX_WALL_CLOCK_MS", 3 * 60 * 60 * 1000);
export const DEFAULT_TOOL_MAX_TOTAL_TOKENS = positiveEnvNumber("SLIME_MAX_TOTAL_TOKENS", 12_000_000);

/** 工具名 → 思考过程留痕的展示标签（与 GUI renderer TOOL_LABELS 对齐；未知工具回退原始名） */
const TOOL_DISPLAY_LABELS: Record<string, string> = {
  web_search: "网络搜索",
  web_fetch: "网页抓取",
  file_read: "读取文件",
  file_list: "列出文件",
  file_write: "写入文件",
  code_check: "语法检查",
  delegate: "传唤子 Agent",
  ask_user: "询问用户",
  todo_write: "记录待办",
  agnes_prompt_build: "构建生成提示词",
  agnes_generate_image: "生成图片",
  agnes_generate_video: "生成视频",
  agnes_video_status: "视频任务状态",
};

export function toolDisplayName(name: string): string {
  if (name.startsWith("delegate:")) {
    return `传唤子 Agent「${name.slice("delegate:".length)}」`;
  }
  return TOOL_DISPLAY_LABELS[name] ?? name;
}

/** 组装「工具调用记录」思考块（无思考模型也能在思考过程留痕；同一工具多次调用逐行记录） */
export function composeToolCallBlock(toolNames: string[]): string {
  if (toolNames.length === 0) { return ""; }
  const lines = toolNames.map((n) => `- ⟳ ${toolDisplayName(n)}`);
  return `### 工具调用记录\n${lines.join("\n")}`;
}

/** A-087（漏洞清单 P1-2）：回复失败前缀黑名单——命中任一 → success=False */
export const FAIL_REPLY_PREFIXES = [
  "[API 调用失败",
  "[API 响应解析失败",
  "[工具调用处理失败",
  "[工具调用后请求失败",
  "[工具调用轮次已达上限",
  "[工具调用后无文本回复",
  "[本地模型加载失败",
  "[本地模型未就绪",
  "[本地模型调用失败",
  "[Agent 未返回有效回复]",
  "[委托失败",
  "[流式调用异常",
  "[流式生成异常",
  "[截断]",
];

export const GEN_REQ_HINTS = ["生成", "制作", "创建", "画", "保存", "下载", "写", "做", "设计", "编", "出"];
export const GEN_TARGET_HINTS = ["图", "视频", "图片", "海报", "logo", "文件", "文案", "报告", "图标", "封面", "头像"];
export const IMAGE_REQ_HINTS = [
  "图", "图片", "照片", "头像", "写真", "壁纸", "插画", "海报", "封面",
  "logo", "icon", "draw", "image", "photo", "picture", "illustration",
  "美女", "人像", "模特", "人物", "角色", "风景", "场景", "动物", "静物",
  "美食", "建筑", "画", "肖像",
];
export const VIDEO_REQ_HINTS = ["视频", "短片", "动画", "剪辑", "录像", "video", "footage", "clip", "movie"];
export const TEXT_TARGET_HINTS = [
  "文档", "方案", "报告", "代码", "文案", "文字", "文章", "脚本", "文件",
  "表格", "提纲", "摘要", "总结", "小说", "故事", "歌词", "论文",
  "歌", "歌曲", "音乐", "音频", "语音", "配音",
];
export const MEDIA_TOOLS = ["agnes_prompt_build", "agnes_generate_image", "agnes_generate_video", "agnes_video_status"];

export const CLAIM_VERBS = ["已保存", "保存到", "已生成", "已创建", "已写入", "已下载", "已导出"];
export const EVIDENCE_HINTS = ["字节", "kb", "mb", "文件大小", "完整路径", "时长"];

// ── 类型 ──────────────────────────────────────────────────

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  retry?: boolean;
  maxTokens?: number;
  /** 会话 ID（GUI 项目内独立会话；缺省写入无 session_id 记录） */
  sessionId?: string;
  /** 联网搜索开关：false 时 web_search/web_fetch 工具被静默拒绝（GUI 侧下发） */
  networkEnabled?: boolean;
  /** 识图图片（data URL 列表，data:image/png;base64,...）。引擎层转为 OpenAI 兼容 content 数组 */
  images?: string[];
  /** 故障自愈续接提示：自动重连/换模型继续时告知模型『你被中断了，从断点继续』，防幻觉已完成 */
  resumeHint?: string;
}

/** 引擎事件块（对齐 Python call_llm_stream chunk 协议） */
export interface EngineChunk {
  type: "chunk" | "tool" | "reasoning" | "progress" | "done" | "error" | "heartbeat" | "member";
  content?: string;
  name?: string;
  /** 团队会话：成员发言事件（type="member"）的发声 Agent ID */
  agentId?: string;
  args?: string;
  result?: string;
  message?: string;
  reply?: string;
  reply_raw?: string;
  /** A-124 正文/思考分离：SILAM 兑底的思考过程（done 事件携带，供上层折叠展示） */
  reasoning?: string | null;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  /** 缓存命中/写入 token（上游 prompt caching；done 事件携带，缓存命中率监测数据源） */
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** 推理/思考 token（上游 completion_tokens_details.reasoning_tokens；done 事件携带，
   *  供 GUI「推理 Tokens（思考）」明细与用量统计还原真实思考成本） */
  reasoning_tokens?: number;
  /**
   * A-974-R7：**窗口占用口径**（仅工具循环路径下发）——「最近一轮」上游请求的输入侧 token。
   * `prompt_tokens` 是跨轮累计（计费口径）；上下文窗口占用必须用最近一轮，否则 N 轮全量重发叠加爆表。
   */
  window_prompt_tokens?: number;
  window_cache_read_tokens?: number;
  window_cache_creation_tokens?: number;
  /**
   * A-974-R8：该上游 `prompt_tokens` **是否已含缓存命中**（OpenAI 兼容=true / Anthropic=false）。
   * GUI 窗口占用公式据此决定是否 +cache_read，避免 OpenAI 兼容系重复计缓存导致窗口虚高。
   */
  cache_read_in_prompt?: boolean;
  elapsed_ms?: number;
  tools_only?: string[];
  /** v2.8 可观测性：全链路耗时（路由→检索→推理→工具轮），done 事件必带 */
  timings?: Record<string, number>;
  /** A-939 上下文分桶：done 事件携带各来源 token 估算（供 GUI 分桶托盘显示） */
  ctxBuckets?: ContextBuckets;
}

export interface ChatEngineResult {
  reply: string;
  replyRaw?: string;
  /** A-124 正文/思考分离：SILAM 兑底的思考过程（情绪/取向/生长提示），供上层折叠展示 */
  reasoning?: string | null;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 缓存命中/写入 token（上游 prompt caching；缓存命中率监测数据源） */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  elapsedMs?: number;
  timings?: Record<string, number>;
  /** A-939 上下文分桶：一次请求各来源 token 估算（system/rules/memory/workspace/planning/tools/history/message） */
  ctxBuckets?: ContextBuckets;
}

/**
 * A-939 上下文分桶（对齐 Cursor 3.3 Context Buckets / Claude Code context-window 分来源计量）：
 * 按「注入来源」切分一次请求的上下文占用。全部为估算（estimateTokens 0.6×字符），与总 prompt_tokens 同量级。
 * 纯数据结构（零逻辑）→ 契约层定义，engine 层计算，GUI 层展示。
 */
export interface ContextBuckets {
  /** 身份铁律 + 诚实协议 + 人格（identity_prompt）+ 思考格式约束 */
  system: number;
  /** 规则注入（InjectionHooks.fixedSegments：技能/平台规则等固定段） */
  rules: number;
  /** 记忆检索注入（InjectionHooks.retrieveSegments：心智/记忆上下文） */
  memory: number;
  /** 工作目录清单（workspace 预加载清单段） */
  workspace: number;
  /** 任务执行规范（todo_write 规划引导段） */
  planning: number;
  /** 工具 schema（本次请求注入的工具定义） */
  tools: number;
  /** 历史消息 */
  history: number;
  /** 当前用户消息（含图片文本段） */
  message: number;
}

export interface ChatEngineCall {
  agent: AgentState;
  message: string;
  history: ChatMessage[];
  systemPrompt: string;
  maxTokens?: number;
  toolsOnly?: string[];
  onChunk?: (delta: string) => void;
  /** 用户主动中断信号（GUI 停止生成时中止底层流） */
  signal?: AbortSignal;
  /** 联网搜索开关：false 时 web_search/web_fetch 工具被静默拒绝 */
  networkEnabled?: boolean;
  /** 会话级工作目录（"以文件夹为主"：优先于 Agent sandbox_override.workspace） */
  workspace?: string;
  /** 会话 ID（透传至工具循环的权限/提问请求，GUI 据此打会话标签过滤旧流） */
  sessionId?: string;
  /** 识图图片（data URL 列表），引擎层组装进最新 user 消息的 content 数组 */
  images?: string[];
  /** 任务预算护栏（透传工具循环：任一达到即优雅收束；缺省=不限制） */
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
}

export interface ChatEngine {
  chat(opts: ChatEngineCall): Promise<ChatEngineResult>;
  stream(opts: ChatEngineCall): AsyncIterable<EngineChunk>;
  /** A-980-R22：可选工具目录列举（支持则按 Agent 白名单下发 toolsOnly；缺省引擎返回 undefined → 全量零回归） */
  listTools?(): Array<{ function?: { name?: string } }>;
}

export interface BehaviorPatternExtracted {
  scenario: string;
  steps: string[];
  rationale?: string;
}

export interface ExtractedMemory {
  traitSignals: unknown[];
  userSentiment: number;
  behaviorPatterns: BehaviorPatternExtracted[];
}

/** post-process 注入点（evolution / 记忆提取为 5B.3 迁移后接线；缺省跳过） */
export interface PostProcessHooks {
  extractMemory?: (opts: {
    agent: AgentState;
    userMsg: string;
    reply: string;
    success: boolean;
  }) => Promise<ExtractedMemory> | ExtractedMemory;
  evolve?: (opts: {
    agent: AgentState;
    success: boolean;
    traitSignals: unknown[];
    userSentiment: number;
  }) => Promise<void>;
}

/** 平台证据注入（A-098；skill_engine/MCP 迁移后接线，缺省原样返回） */
export type EvidenceInjector = (message: string) => Promise<string> | string;

export interface ChatServiceOptions {
  registry: AgentRegistry;
  engine: ChatEngine;
  bus?: ServerA2ABus;
  postProcess?: PostProcessHooks;
  evidence?: EvidenceInjector;
  /** 流事件发射器（缺省 emitServiceEvent 输出；SSE 由 gateway 消费） */
  emit?: (ev: ServiceEvent<unknown>) => void;
  /** 异常告警总线（v2.8：sidecar 崩溃/OOM/检索超时 → 日志 + stats 状态 + 可选通知钩子） */
  alarms?: AlarmBus;
  /** 历史存储（缺省 config/history.jsonl 文件实现；测试注入内存实现） */
  history?: HistoryStore;
  logger?: Pick<Console, "warn" | "info" | "debug">;
}

export interface ChatMeta {
  model: string;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
}

export interface ChatResult {
  reply: string;
  agentId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
  success: boolean;
}

export interface SwarmAnalysis {
  action: "chat" | "fork" | "swarm";
  subtasks: string[];
  reason: string;
  parse_ok: boolean;
}

// ── 纯函数（对齐 slime_server.py 同级函数）────────────────

/** A-015：解析 Swarm 分析回复（整体 JSON → 正则兜底 → 显式降级标记） */
export function parseSwarmAnalysis(reply: string): SwarmAnalysis {
  let data: Record<string, unknown> | null = null;
  let parseOk = false;
  try {
    const parsed = JSON.parse(reply ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
      parseOk = true;
    }
  } catch {
    // 继续正则兜底
  }
  if (data === null) {
    const m = (reply ?? "").match(/\{[^{}]*"action"\s*:\s*"(chat|fork|swarm)"[^{}]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
          parseOk = true;
        }
      } catch {
        // 兜底失败
      }
    }
  }
  if (data === null) {
    data = {};
  }
  let action = data.action;
  if (action !== "chat" && action !== "fork" && action !== "swarm") {
    action = "chat";
    parseOk = false;
  }
  let subtasks: unknown = data.subtasks;
  if (!Array.isArray(subtasks)) {
    subtasks = [];
    parseOk = false;
  }
  const cleanSubtasks: string[] = Array.isArray(subtasks)
    ? subtasks.filter((s): s is string => typeof s === "string").slice(0, 8)
    : [];
  return {
    action: action as SwarmAnalysis["action"],
    subtasks: cleanSubtasks,
    reason: typeof data.reason === "string" ? data.reason : "",
    parse_ok: parseOk,
  };
}

/** 构建 Swarm 分析提示词（对齐 Agent.build_swarm_analysis_prompt） */
export function buildSwarmAnalysisPrompt(userMessage: string, availableProviders = 1): string {
  return (
    "分析以下用户任务，判断是否需要分裂执行。\n\n" +
    `用户任务：${userMessage}\n\n` +
    "## 任务类型判断（按优先级）：\n\n" +
    '### 不应分裂（action: "chat"）：\n' +
    "- 日常闲聊、问候、情感交流\n" +
    "- 单一事实问答、简单查询\n" +
    "- 对已有内容的评价/讨论/建议\n" +
    "- 单步操作（如「帮我读这个文件」）\n\n" +
    '### 适合 self-fork（action: "fork"，同一模型分裂 1 次 = 2 个并行 Worker）：\n' +
    "- 代码编译/构建项目（编译 + 测试可并行）\n" +
    "- 单类型批量生成（如「生成 3 张 logo」「写 2 篇文案」）\n" +
    "- 同一任务可天然拆成 2 个独立子任务\n" +
    "- fork 最多拆 2 个子任务（1 次分裂）\n\n" +
    '### 适合 swarm（action: "swarm"，分配到不同模型并行）：\n' +
    "- 需要不同领域专业知识（如「同时分析代码 + 写文档 + 做测试」）\n" +
    "- 多类型任务组合（如「查资料 + 画图 + 翻译」）\n" +
    "- 任务可拆成 3+ 个独立子任务且类型各异\n\n" +
    "## 输出格式：\n" +
    "严格按以下 JSON 回复（不要加 markdown 代码块）：\n" +
    '{"action": "chat"|"fork"|"swarm", "subtasks": ["子任务1", ...], "reason": "简要原因"}\n\n' +
    "fork 时 subtasks 最多 2 个。chat 时 subtasks 为空数组。" +
    `\n\n（当前可用 Provider 数：${availableProviders}）`
  );
}

/** A-049：生成类请求判定 */
export function isGenerationRequest(message: string): boolean {
  if (!message) {
    return false;
  }
  return (
    GEN_REQ_HINTS.some((h) => message.includes(h)) &&
    GEN_TARGET_HINTS.some((h) => message.toLowerCase().includes(h))
  );
}

/** A-085：图片请求判定（视频词 → False；图片词 → True；文本目标词 → False；默认图片） */
export function isImageRequest(message: string): boolean {
  if (!message) {
    return false;
  }
  const low = message.toLowerCase();
  if (VIDEO_REQ_HINTS.some((v) => low.includes(v))) {
    return false;
  }
  if (IMAGE_REQ_HINTS.some((h) => low.includes(h))) {
    return true;
  }
  if (TEXT_TARGET_HINTS.some((t) => low.includes(t))) {
    return false;
  }
  return GEN_REQ_HINTS.some((h) => message.includes(h));
}

/** 完成态声称判定（A-049；对齐 core/claims.py 语义：声称动词 或 证据描述+路径核验） */
export async function claimsCompletion(reply: string): Promise<boolean> {
  if (!reply) {
    return false;
  }
  if (CLAIM_VERBS.some((v) => reply.includes(v))) {
    return true;
  }
  const low = reply.toLowerCase();
  if (EVIDENCE_HINTS.some((h) => low.includes(h))) {
    if ((await findUnverifiedClaims(reply)).length > 0) {
      return true;
    }
    if (
      (reply.includes("路径") || reply.includes("文件")) &&
      EVIDENCE_HINTS.some((h) => low.includes(h))
    ) {
      return true;
    }
  }
  return false;
}

/** A-087：失败前缀黑名单判定（命中任一 → 失败） */
export function isFailReply(reply: string): boolean {
  return FAIL_REPLY_PREFIXES.some((p) => reply.includes(p));
}

/** XML 风格思考标签对（open 在前；有前缀重叠的按更长优先，避免 <reasoning> 被 <reason> 误匹配） */
const THINK_TAG_PAIRS: ReadonlyArray<{ open: string; close: string }> = [
  { open: "<thinking", close: "</thinking>" },
  { open: "<reasoning", close: "</reasoning>" },
  { open: "<thought", close: "</thought>" },
  { open: "<reason", close: "</reason>" },
  { open: "<|begin_of_thought|>", close: "<|end_of_thought|>" },
];

/** DeepSeek 风格无尖括号思考块（DeepSeek R1 / 部分 Qwen3/蒸馏模型）：开头 ` thinking`、结尾 ` response`。
 *  仅用于「正文尚未开始」的前沿——思考块总是模型输出的首块，避免正文中正常出现的「 response」被误判。
 *  注意：DeepSeek 标准闭合是「空格+response」（` response`，如 `\n\n response\n\n`）；部分模型输出
 *  `\nresponse`（无空格）或 `\n response`（换行+空格），由 findDsMarker 的行界判定统一兼容。 */
const DS_START = " thinking";
const DS_END = " response";

export function stripToolCallXml(text: string): { clean: string; toolCalls: string } {
  if (!text) {
    return { clean: text, toolCalls: "" };
  }
  const parts: string[] = [];
  // ① 带 dots_ 前缀的伪工具块（小模型常见误写：<dots_function_call>…</dots_function_call>）
  let clean = text.replace(/<[a-z0-9_]*function_call[\s\S]*?<\/[a-z0-9_]*function_call\s*>/gi, (m) => {
    parts.push(m.trim());
    return "";
  });
  // ② Claude 风格 XML 工具调用（<invoke name="web_search">…<parameter>…</parameter></invoke>）
  clean = clean.replace(/<invoke\b[\s\S]*?<\/invoke\s*>/gi, (m) => {
    parts.push(m.trim());
    return "";
  });
  // ③ 游离 parameter 残片（外层块被剥后裸露的）
  clean = clean.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter\s*>|<parameter\b[^>]*\/>/gi, (m) => {
    parts.push(m.trim());
    return "";
  });
  // ④ 剥除后残留的空壳包装标签（模型常以 <ignore>…</ignore> 包裹工具声明；剥掉内容后空壳也清理）
  clean = clean.replace(/<(ignore|result|output|tool)\b[^>]*>\s*<\/\1\s*>/gi, "");
  return { clean, toolCalls: parts.join("\n") };
}

/** 从回复正文中剥离思考内容（Qwen3/DeepSeek 等思考模型已知会把思考泄漏进 content）。
 * 处理三种形态（业界共识：客户端/展示层须同时兼容 reasoning_content + 内嵌思考标签）：
 * 1. XML 风格思考块：<thinking>...</thinking> / <reasoning> / <thought> / <reason> / <|begin_of_thought|>
 * 2. DeepSeek 无尖括号思考块：前缀 ` thinking…\nresponse`（正文前沿）
 * 3. 思考重复前缀：content 以已捕获的 reasoning 开头（模型把思考同时写进 content，可能重复多次）
 * 返回 { cleanReply, reasoning }：cleanReply 为剥离后的正文，reasoning 为合并后的思考内容。
 */
export function extractThinkingFromReply(
  reply: string,
  existingReasoning = "",
): { cleanReply: string; reasoning: string } {
  if (!reply) {
    return { cleanReply: reply, reasoning: existingReasoning };
  }
  let clean = reply;
  let reasoning = existingReasoning;

  // 1. XML 风格思考标签块（跨标签对捕获；同开同闭，容忍换行/空白）
  const tagParts: string[] = [];
  clean = clean.replace(/<(thinking|thought|reasoning|reason)>[\s\S]*?<\/(thinking|thought|reasoning|reason)>/gi, (m) => {
    tagParts.push(m.replace(/<\/?(thinking|thought|reasoning|reason)>/gi, "").trim());
    return "";
  });
  clean = clean.replace(/\|<begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, (m) => {
    tagParts.push(m.replace(/\|<begin_of_thought\|>|<\|end_of_thought\|>/gi, "").trim());
    return "";
  });

  // 2. DeepSeek 无尖括号思考块：仅当 clean 在「正文前沿」出现 ` thinking` 且其后有 `\nresponse` 闭合。
  //    开标记前必须是非字母数字（通常是换行/空格），避免误匹配正文里的「thinking」一词。
  const dsRe = /(^|[\s])thinking\s+([\s\S]*?)(\n\s*response\b)/i;
  let change = true;
  let guard = 0;
  while (change && guard++ < 10) {
    change = false;
    const dm = clean.match(dsRe);
    if (dm && dm.index !== undefined) {
      const prefix = dm[1] || ""; // 开标记前那个分隔符（换行等，保留给正文排版）
      const reason = dm[2].trim();
      const tail = clean.slice(dm.index! + dm[0].length);
      if (reason) {
        tagParts.push(reason);
        clean = prefix + tail;
        change = true;
      }
    }
  }

  if (tagParts.length > 0) {
    reasoning = [reasoning, ...tagParts].filter(Boolean).join("\n");
  }

  // A-966：剥离工具调用 XML 误写（小模型以 XML 声明工具、系统无法解析执行 → 直接泄漏成正文异常文本）。
  // 剥出的声明并入思考区（用户可见"想调 web_search"），正文保持干净。
  const tc = stripToolCallXml(clean);
  clean = tc.clean;
  if (tc.toolCalls) {
    reasoning = [reasoning, tc.toolCalls].filter(Boolean).join("\n");
  }

  // 3. 思考重复前缀：content 以 reasoning 开头且其后仍有内容 → 剥离（循环处理重复）
  const rt = reasoning.trim();
  let trimmed = clean.trimStart();
  while (rt && trimmed.startsWith(rt) && trimmed.length > rt.length) {
    trimmed = trimmed.slice(rt.length).trimStart();
  }
  clean = trimmed;

  // 4. 逐词换行思考检测：模型有时把整段思考以「每行1-3字」的逐词换行格式输出（无XML标签）。
  //    这类文本不含强/弱关键词，会穿透 splitUntaggedThinking 泄漏到正文。
  const tokenStrip = stripTokenByTokenThinking(clean, reasoning);
  if (tokenStrip.cleanReply !== clean) {
    return { cleanReply: tokenStrip.cleanReply, reasoning: tokenStrip.reasoning.trim() };
  }

  // 5. 无标记裸思考兜底：正文前沿「分析用户输入 + 自我指涉回应」段 → 剥离为 reasoning
  const untagged = splitUntaggedThinking(clean, reasoning);
  return { cleanReply: untagged.cleanReply, reasoning: untagged.reasoning.trim() };
}

/** 逐词换行思考检测：模型有时把整段思考以「每行1-3字」的逐词换行格式输出（无XML标签）。
 *  这类文本不含强/弱关键词，会穿透 splitUntaggedThinking 泄漏到正文。
 *  策略：扫描正文前沿，若前 N 行中 ≥70% 是 ≤3字符的超短行 → 视为逐词换行思考块并剥离。 */
function stripTokenByTokenThinking(reply: string, existingReasoning = ""): { cleanReply: string; reasoning: string } {
  if (!reply) { return { cleanReply: reply, reasoning: existingReasoning }; }
  const lines = reply.split("\n");
  // 只扫描前 40 行（避免误伤正常列表/代码块）
  const scanLimit = Math.min(lines.length, 40);
  let shortLineCount = 0;
  let totalNonEmpty = 0;
  for (let i = 0; i < scanLimit; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    totalNonEmpty++;
    if (trimmed.length <= 3) shortLineCount++;
  }
  // 阈值：非空行 ≥8 且 ≥70% 是超短行 → 判定为逐词换行思考
  if (totalNonEmpty >= 8 && shortLineCount / totalNonEmpty >= 0.7) {
    // 找到最后一个连续超短行段的结束位置
    let thinkingEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.length <= 3) {
        thinkingEnd += lines[i].length + 1; // +1 for \n
      } else {
        break;
      }
    }
    if (thinkingEnd > 0 && thinkingEnd < reply.length) {
      const thinkingText = reply.slice(0, thinkingEnd).trim();
      const rest = reply.slice(thinkingEnd).trim();
      if (thinkingText && rest) {
        return { cleanReply: rest, reasoning: [existingReasoning, thinkingText].filter(Boolean).join("\n") };
      }
    }
    // 整个 reply 都是逐词换行 → 全部作为思考，正文留空（由 promoteOrphanThinking 处理）
    return { cleanReply: "", reasoning: [existingReasoning, reply.trim()].filter(Boolean).join("\n") };
  }
  return { cleanReply: reply, reasoning: existingReasoning };
}

/** orphan thought 提升（对照 agentero docs deepseek-thinking-body 完成时兜底）：
 *  当 turn 结束只有思考（reasoning）而无正文（cleanReply 为空）时，说明模型把含最终答案的整块
 *  内容全写进了思考区。把最后一个非空思考块提升为正文，避免「答案被藏在思考里 / 正文 (empty)」。
 *  仅提升最后一段：兼容「思考 → 工具 → 再思考 → 答案被误标」的多段场景，更早的思考仍归思考区。 */
export function promoteOrphanThinking(
  cleanReply: string,
  reasoning: string,
): { cleanReply: string; reasoning: string } {
  if (cleanReply.trim()) {
    return { cleanReply, reasoning }; // 已有正文：不抬升
  }
  const blocks = (reasoning ?? "")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) {
    return { cleanReply, reasoning: (reasoning ?? "").trim() };
  }
  const last = blocks[blocks.length - 1];
  return {
    cleanReply: last,
    reasoning: blocks.slice(0, -1).join("\n\n"),
  };
}

/**
 * 无标记裸思考剥离（模型把思考裸写进正文、无任何标签时的保守兜底）。
 *
 * 模型（尤其未开启推理强度但本身会思考的模型，本地/云端均可能）会把「分析用户输入 + 自我指涉
 * 回应」的思考直接写进正文，形如「用户发送了…根据我的身份设定…我需要…我可以概述…」后接真正
 * 回答。此时无标签可拆，只能靠启发式。
 *
 * 判定策略（0.1.4 增强，修复同行密集思考 + 思考与正文同行 + 第一人称分析型思考无法剥离）：
 *  1) 特征计权：强思考信号（身份/角色/用中文回应/保持自然等自我指涉）+2，弱思考信号（用户发送
 *     了/我需要/我看到/根据我的等分析动作）+1。累积权重 ≥3 才剥离。
 *      - 强信号型（你好问候）自然过线；
 *      - 弱信号型（长任务分析：我需要…我可以概述…）多处累积过线；
 *      - 正常回答开头（「用户询问…根据我的经验…应该先分析瓶颈」，权重仅 2）不过线，避免误伤。
 *  2) 思考块末行支持「行内正文锚点切分」：思考特征之后若紧跟正文引导词（你好/您好/好/以下是…），
 *     行内切开，锚点起为正文，避免思考与首句正文同行时被整段误归思考、或单行时思考端=全文。
 *
 * 剥离条件：累积权重 ≥3 且 思考块结束下标 < 全文长度（之后确有正文）。仅作用于正文前沿（≤8 行）。
 */
/** 允许「剥离后正文为空」（rest 为空）的思考段最小字符数：
 *  短句（如"根据我的角色设定，我需要保持角色。"）可能是模型把自述当回复 → 不剥离，
 *  交给 promoteOrphanThinking 终局提升；超长思考（正文尚未到达）才允许空正文剥离。 */
const MIN_EMPTY_REST_CHARS = 60;
/** 无标记裸思考扫描行上限：低证据（weight<3）时 8 行快速判定；一旦权重 ≥3（疑似长思考块）
 *  扩展到本上限以找到真正正文起始行，避免 >8 行的思考块尾部（如「不过，作为 X，我可以…」）
 *  被误当正文泄漏。 */
const UNTAGGED_SCAN_LIMIT = 60;
export function splitUntaggedThinking(
  reply: string,
  existingReasoning = "",
): { cleanReply: string; reasoning: string } {
  if (!reply) {
    return { cleanReply: reply, reasoning: existingReasoning };
  }
  const lines = reply.split("\n");

  // 强思考信号（自我指涉程度高，几乎不会出现在正常回答开头）。带 g 以统计同一次命中。
  const strongRe =
    /身份设定|角色设定|我的身份|保持角色|用中文\s*(回应|回答|回复|沟通)|作为[^，。\n]{0,8}(我|助手|agent)|保持[^，。\n]{0,6}(自然|平静|专业|均衡|情绪)|当前[^，。\n]{0,4}(情绪|状态)|我[^，。\n]{0,6}\b(回应|回复|回答)用户/ig;
  // 弱思考信号（分析用户输入 / 明确自指分析动作 / 自我指涉义务；正常回答开头可能零星出现，
  // 需累积到阈值才生效，避免误伤）。刻意排除「可以/要/从/先」等正文中也常见、易误吞正文的词。
  // 带 g。
  const weakRe =
    /用户\s*(发送了|说|问|询问|提到|要求|让我|叫我|给|上报|讲述了)|用户[^，。\n]{0,6}(说|问|发|提|要|想|给|夸|称|表示|认为|觉得|称赞|赞美|夸奖|只是|还|终于)|我\s*(需要|应该|将|打算|必须|看到|已经|分析|检测|列出|读取|查看|检查|介绍|说明|概述|总结|给出|提供|梳理|整理|研究|了解|根据|翻一下|找一下|查一下|得先)|根据(我的|系统提示)|让我\s*(先|开始|列出|阅读|查看|分析|检查|了解|确认|概述)|(我先|首先)\s*(列表|阅读|查看|分析|检查|了解|确认|概述)/ig;
  // 正文引导锚词（用于区分「正文起始行」与「思考内部尾句」）
  const bodyStartRe =
    /^(哈哈|你好|您好|好的|当然|没问题|谢谢|抱歉|可以|好嘞|明白了|收到|好的呀|好的呢|嗯嗯|好的吧|没毛病|没问题|来啦|在的|你好呀)/;

  let thinkingEnd = -1; // 思考块在整段中的结束下标（字符级，含前导）
  let weight = 0;
  let prevHadFeature = false; // 上一行是否有思考特征（用于列表项延续）
  let anchorStart = -1; // 行内正文锚点起点（仅最后一个特征行内的锚点有效，前面的可能是假阳性引用锚）
  let naturalBreak = false; // 前面已有思考特征时遇到独立正文行 → 思考块结束

  // 低证据（weight<3）时 8 行快速判定；一旦权重 ≥3（疑似长思考块）扩展到 UNTAGGED_SCAN_LIMIT，
  // 以扫描到真正的正文起始行，避免 >8 行的思考块尾部（如「不过，作为 X，我可以…」）被误当正文泄漏。
  for (let i = 0; i < lines.length && i < (weight >= 3 ? UNTAGGED_SCAN_LIMIT : 8); i++) {
    const line = lines[i].trim();
    if (!line) {
      // 思考块前的空行归思考段（思考段常含空行）
      continue;
    }
    const strongCount = (line.match(strongRe) || []).length;
    const weakCount = (line.match(weakRe) || []).length;
    const isList = /^(\d+[.、]|[-*])\s/.test(line);
    const hasFeature = strongCount > 0 || weakCount > 0;
    if (hasFeature) {
      weight += strongCount * 2 + weakCount;
      prevHadFeature = true;
      thinkingEnd = computeLineEnd(lines, i);
      // 行内正文锚点切分：本行已有思考特征权，其后紧跟正文引导词 → 行内切开
      // 注意：只覆盖记录（最后一个特征行的 anchor 才可能是真实分界），不立即 break
      // 否则前面行里引用用户话里的"你好"会触发假阳性、中断扫描导致权重不足
      const anchor = findBodyAnchor(line, strongRe, weakRe);
      if (anchor >= 0) {
        anchorStart = computeLineStart(lines, i) + anchor;
      }
      continue;
    }
    // 列表项且前面是思考特征 → 延续思考块（思考常以「1. 2.」列步骤）
    if (isList && (prevHadFeature || weight > 0)) {
      thinkingEnd = computeLineEnd(lines, i);
      continue;
    }
    // 无思考特征、非延续列表行
    if (weight > 0) {
      // 冒号结尾 → 思考内过渡行（"根据角色要求：" 通常引出后续列表/说明）→ 延续思考
      if (/[:：]\s*$/.test(line)) {
        // 强正文锚词行（报告/结论起头，如「以下是项目分析报告：」）且特征充足 → 思考块结束、正文开始
        if (strongBodyStartRe.test(line) && weight >= 3) {
          naturalBreak = true;
          break;
        }
        thinkingEnd = computeLineEnd(lines, i);
        continue;
      }
      // 正文引导锚词开头（哈哈/你好/好的…），或强正文锚词（报告/结论/交付开场如「让我来分享…」，
      // 需 weight≥3 避免误伤）→ 确认为正文起始行 → 思考块结束
      if (bodyStartRe.test(line) || (strongBodyStartRe.test(line) && weight >= 3)) {
        naturalBreak = true;
        break;
      }
      // 其他无特征行：视为思考内部尾句（"同时要保持轻松友好的语气。"），延续思考
      thinkingEnd = computeLineEnd(lines, i);
      continue;
    }
    // 首行即无特征（weight===0）：非正文锚词开头 → 疑似思考开头（特征未出现），整段非裸思考，直通
    break;
  }

  // naturalBreak 为真：思考块后紧跟独立正文行（正文引导锚词开头）。
  // 此时 thinkingEnd 已正确指向最后一个特征/列表行的末尾 → 直接用 thinkingEnd 切分，
  // 丢弃 anchorStart（它是前面某特征行内的锚点，必然是引用假阳性或无关行内切分）。
  const endIdx = naturalBreak ? thinkingEnd : (anchorStart >= 0 ? anchorStart : thinkingEnd);
  // 判定：naturalBreak 且 weight≥2（思考段已结束 + 特征证据），或 weight≥3（行内锚点/无独立正文行）
  const canCut = (naturalBreak && weight >= 2) || weight >= 3;
  if (canCut && endIdx > 0 && endIdx <= reply.length) {
    const thinkingText = reply.slice(0, endIdx).trim();
    const rest = reply.slice(endIdx).trim();
    // 允许 rest 为空：超长思考（>8 行）在正文到达前被兜底剥离时，把思考段剥离、正文留空，
    // 后续正文 chunk 再正常输出；否则思考会因「无正文 rest」被误判为正文而泄漏。
    // 但短句「思考即全文」（如"根据我的角色设定，我需要保持角色。"）不剥离——可能是
    // 模型把整段自述当回复（无独立正文），交由 promoteOrphanThinking 终局提升，避免误删空回复。
    const emptyRestLongEnough = thinkingText.length >= MIN_EMPTY_REST_CHARS;
    if (thinkingText && (rest || emptyRestLongEnough)) {
      return {
        cleanReply: rest,
        reasoning: [existingReasoning, thinkingText].filter(Boolean).join("\n"),
      };
    }
  }
  return { cleanReply: reply, reasoning: existingReasoning };
}

/** 计算第 i 行在整段中的起始字符下标（含换行） */
function computeLineStart(lines: string[], i: number): number {
  let s = 0;
  for (let k = 0; k < i; k++) {
    s += lines[k].length + 1; // +1 换行
  }
  return s;
}
/** 计算第 i 行结束后的字符下标 */
function computeLineEnd(lines: string[], i: number): number {
  return computeLineStart(lines, i) + lines[i].length;
}
/** 判断锚词前的字符是否为「词内」字符（CJK 表意字符/ASCII 字母数字/全角字母数字）。
 *  若是，说明锚词只是更长单词的一部分（如「友好的」里的"好的"、"理所当然"里的"当然"），
 *  不是真正的正文引导词 → 应跳过该命中。 */
function isAnchorInWord(pre: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/.test(pre);
}

/** 强正文锚词行开头（报告性/结论性/交付开场起头）：思考段后紧跟此类行 → 思考结束、正文开始。
 *  即使行尾是冒号（如「以下是项目分析报告：」「让我来分享几点：」）也属正文起头；
 *  但需 weight≥3 才生效，避免「以下是具体方案：」式正常回答被误吞（弱特征时保守直通）。 */
const strongBodyStartRe =
  /^(以下是|总结是|答案是|先说|下面|综上所述|综上|简单说|简单来说|总之|答案|结果|让我来|接下来|我来给|我来说|我来分享|让我分享|让我直接)/;

/**
 * 在思考特征行内找「正文引导锚点」的起始位置（特征之后紧跟的正文起头）。
 * 返回相对行首的下标；未找到返回 -1。避免把思考特征自身的「你好」误判——仅扫描最后一个
 * 思考特征匹配结束之后。找不到则整体仍属思考。
 */
function findBodyAnchor(line: string, strongRe: RegExp, weakRe: RegExp): number {
  // 收集行内所有思考特征匹配，取最后一个匹配的结束位置
  let lastEnd = -1;
  for (const re of [strongRe, weakRe]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      lastEnd = Math.max(lastEnd, m.index + m[0].length);
      if (m[0].length === 0) {
        re.lastIndex++;
      }
    }
  }
  if (lastEnd < 0) {
    return -1;
  }
  // 特征之后的 tail 内找首个正文引导锚词（强烈分界词，思考中几乎不会单独出现）
  const tail = line.slice(lastEnd);
  const anchorWords = ["你好", "您好", "好的", "当然", "所以", "因此", "那么", "总之", "总结是", "以下是", "先说", "下面", "答案", "结果"];
  const leftQuotes = new Set(['"', "'", "「", "『", "(", "（", "`", "<", "《", "【", "[", "{"]);
  const anchorIndexes: Array<{ pos: number; word: string }> = [];
  for (const word of anchorWords) {
    let from = 0;
    while (from < tail.length) {
      const p = tail.indexOf(word, from);
      if (p < 0) break;
      // 排除引用场景：锚词前紧邻左引号/括号（如「用户发送了"你好"」中的"你好"是复述，非正文引导）
      const preChar = p > 0 ? tail.charAt(p - 1) : "";
      const inQuote = preChar && leftQuotes.has(preChar);
      // 排除词内场景：锚词是更长单词的一部分（"友好的"里的"好的"）→ 非正文引导，跳过
      const inWord = p > 0 && isAnchorInWord(preChar);
      if (!inQuote && !inWord) {
        anchorIndexes.push({ pos: p, word });
        break; // 每种锚词只取最左一个（非引用、非词内），继续下一种
      }
      from = p + 1; // 锚词在引号里或词内，跳过继续找同词的下一次出现
    }
  }
  if (anchorIndexes.length === 0) {
    return -1;
  }
  anchorIndexes.sort((a, b) => a.pos - b.pos);
  return lastEnd + anchorIndexes[0].pos;
}

/**
 * 流式思考剥离器（模型无关）：跨 chunk 状态机，把思考内容从正文中剥离并路由到 reasoning。
 * 解决云端/本地思考模型（Qwen3/DeepSeek 等）把思考同时写进 content 的已知问题——等 done 才剥离
 * 会让思考在流式过程中混入正文，必须边到边剥离。
 * 处理四种形态（业界共识 + 生产实测）：
 * 1. XML 风格思考标签块（多标签变体，可能跨 chunk）：
 *    <thinking> / <thought> / <reasoning> / <reason> / <|begin_of_thought|>
 * 2. DeepSeek 无尖括号思考块：行首 ` thinking` … 行首 ` response`
 *    仅在正文前沿（started=false）检测，避免正文里的「 thinking/response」被误判。
 * 3. 思考重复前缀：正文开头以已捕获 reasoning 开头（模型把思考同时写进 content）
 * 4. 无标记裸思考（生产实测最难）：思考直接裸写在正文前沿、无任何标签（用户实测场景）。
 *    采用「前沿缓冲 + 启发式权重判定」：在 started=true 前先缓冲前沿，
 *    累积足够特征（splitUntaggedThinking 阈值逻辑）后实时剥离；缓冲超限则直通避免延迟。
 * getReasoning 返回当前已剥离的思考累积（供重复前缀比对与最终合并）。
 */
export function createThinkingStripper(getReasoning: () => string): {
  push(content: string): string;
  flush(): string;
  get reasoning(): string;
} {
  let rawReasoning = ""; // 原始思考累积（含标签，getter 剥离）
  let inTag = false; // XML 思考标签内
  let activeClose = ""; // 当前 XML 思考标签对的闭合标签
  let inDs = false; // DeepSeek 无尖括号思考块内
  let pending = ""; // 未决缓冲（可能含跨 chunk 的标签残片）
  let headBuf = ""; // 正文开头缓冲（重复前缀判定，仅在正文尚未输出时启用）
  let started = false;
  // ── 流式无标记裸思考缓冲与状态 ──
  let untaggedBuf = "";      // 正文前沿缓冲（started=true 前，标签剥离后进入，待启发式判定）
  let untaggedLineCount = 0; // untaggedBuf 中已累积行数（仅扫描前 8 行，对齐 splitUntaggedThinking）
  const UNTAGGED_MAX_CHARS = 4000; // 缓冲上限：超限强制判定直通，避免无限延迟
  const UNTAGGED_MAX_LINES = 8;    // 对齐 splitUntaggedThinking 的 i < 8
  // ── 逐词换行思考剥离状态（A-175）：模型偶发把中间思考「每 token 换一行」输出且无标签，
  //     特征词启发式（evalUntagged）对逐词文本无权重（每行 1-2 字），quickRelease 会直接放行泄漏到正文。
  //     用「超短行密度」识别：短行(≤3字符)占绝对多数 → 判定为思考、整体剥离到 rawReasoning。
  let tbtBuf = "";   // 跨 chunk 累积的行（未判定，正文前沿及中部均生效）
  let inTbt = false; // 已判定进入逐词换行思考模式（后续内容整体剥离，直至正文回归）
  const TBT_END_LEN = 4; // 长度 >=4 且非纯符号的行视为「正常行」

  /** pending 尾部是否为某标签的部分前缀（跨 chunk 场景），返回应保留的字符数 */
  const holdTail = (s: string, tag: string): number => {
    const lower = s.toLowerCase();
    let hold = 0;
    for (let k = 1; k <= tag.length; k++) {
      if (lower.endsWith(tag.slice(0, k))) hold = Math.max(hold, k);
    }
    return hold;
  };

  /** 在 s 中找行首 DeepSeek 闭合标记 `response`（兼容 ` response` 空格 / `\nresponse` 无空格 /
   *  `\n response` 换行+空格三种形态）。返回标记起始位置（含前导空白），未找到返回 -1。
   *  仅当 response 位于行首（字符串开头/换行后，可带前导空格/tab）时命中，避免正文中单词误匹配。 */
  const findDsMarker = (s: string, marker: string, from = 0): number => {
    const lower = s.toLowerCase();
    const word = marker.trim().toLowerCase();
    let idx = from;
    while (idx < s.length) {
      const pos = lower.indexOf(word, idx);
      if (pos === -1) return -1;
      let start = pos;
      while (start > 0 && (s[start - 1] === " " || s[start - 1] === "\t")) start--;
      const before = start === 0 ? "" : s[start - 1];
      if (start === 0 || before === "\n" || before === "\r") return start;
      idx = pos + word.length;
    }
    return -1;
  };

  /** 找 DeepSeek 思考块开标记：` thinking`（标准，行首带空格）或 `thinking`（行首无空格）。
   *  返回 { pos, len }：pos 为标记起始（含前导空白），len 为应消费的字符数。
   *  仅当标记位于行首（字符串开头/换行后，可带前导空白）时命中，避免正文中单词误匹配。 */
  const findDsStart = (s: string, from = 0): { pos: number; len: number } | null => {
    const lower = s.toLowerCase();
    let idx = from;
    while (idx < s.length) {
      const pos = lower.indexOf("thinking", idx);
      if (pos === -1) return null;
      let start = pos;
      while (start > 0 && (s[start - 1] === " " || s[start - 1] === "\t")) start--;
      const before = start === 0 ? "" : s[start - 1];
      if (start === 0 || before === "\n" || before === "\r") {
        return { pos: start, len: pos + "thinking".length - start };
      }
      idx = pos + "thinking".length;
    }
    return null;
  };

  // ── 流式无标记裸思考判定：复用 splitUntaggedThinking 的阈值与正则，独立副本（避免闭包互相污染） ──
  const _strongRe =
    /身份设定|角色设定|我的身份|保持角色|用中文\s*(回应|回答|回复|沟通)|作为[^，。\n]{0,8}(我|助手|agent)|保持[^，。\n]{0,6}(自然|平静|专业|均衡|情绪)|当前[^，。\n]{0,4}(情绪|状态)|我[^，。\n]{0,6}\b(回应|回复|回答)用户/ig;
  const _weakRe =
    /用户\s*(发送了|说|问|询问|提到|要求|让我|叫我|给|上报|讲述了)|用户[^，。\n]{0,6}(说|问|发|提|要|想|给|夸|称|表示|认为|觉得|称赞|赞美|夸奖|只是|还|终于)|我\s*(需要|应该|将|打算|必须|看到|已经|分析|检测|列出|读取|查看|检查|介绍|说明|概述|总结|给出|提供|梳理|整理|研究|了解|根据|翻一下|找一下|查一下|得先)|根据(我的|系统提示)|让我\s*(先|开始|列出|阅读|查看|分析|检查|了解|确认|概述)|(我先|首先)\s*(列表|阅读|查看|分析|检查|了解|确认|概述)/ig;
  const _anchorWords = ["你好", "您好", "好的", "当然", "所以", "因此", "那么", "总之", "总结是", "以下是", "先说", "下面", "答案", "结果"];
  /** 正文引导锚词（用于区分「正文起始行」与「思考内部尾句」） */
  const _bodyStartRe =
    /^(哈哈|你好|您好|好的|当然|没问题|谢谢|抱歉|可以|好嘞|明白了|收到|好的呀|好的呢|嗯嗯|好的吧|没毛病|没问题|来啦|在的|你好呀)/;
  /** 流式版无标记裸思考评估：对 buf 前 maxLines 行扫特征权重与行内锚点。
   *  返回 { decided: true,  thought, body } 时立即切分；
   *  返回 { decided: false, weight, naturalBreak, bodyStart } 时表示：尚需更多数据（或超限无法判定，调用方自行直通）。
   *  weight 回传给调用方，用于「无特征正常对话快速放行」的判定；
   *  naturalBreak：已出现独立正文行（思考段明确结束，前面已有特征）→ 可立即放行/按阈值剥离；
   *  bodyStart：首行即为正文引导锚词开头（哈哈/你好…）→ 纯正文，可立即放行。
   *  判定条件：naturalBreak 且 weight≥2（思考段已结束 + 特征证据），或 weight≥3（行内锚点/无独立正文行）。
   */
  const evalUntagged = (buf: string): { decided: boolean; thought?: string; body?: string; weight: number; naturalBreak: boolean; bodyStart: boolean } => {
    if (!buf) return { decided: false, weight: 0, naturalBreak: false, bodyStart: false };
    const lines = buf.split("\n");
    let thinkingEnd = -1;
    let weight = 0;
    let prevHadFeature = false;
    let anchorStart = -1;
    let naturalBreak = false;
    let bodyStart = false;
    let bodyStartPending = false; // 首行命中引导锚词（无特征），待后续行确认是正文还是思考
    const _leftQuotes = new Set(['"', "'", "「", "『", "(", "（", "`", "<", "《", "【", "[", "{"]);
    let scannedChars = 0; // 已扫描行的字符累计（含换行）
    // 低证据（weight<3）时 8 行快速判定；一旦权重 ≥3（疑似长思考块）扩展到 UNTAGGED_SCAN_LIMIT，
    // 以扫描到真正的正文起始行（对齐 splitUntaggedThinking，避免长思考块尾部泄漏）
    for (let i = 0; i < lines.length && i < (weight >= 3 ? UNTAGGED_SCAN_LIMIT : UNTAGGED_MAX_LINES); i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineStart = scannedChars;
      scannedChars += line.length + (i < lines.length - 1 ? 1 : 0);
      if (!trimmed) continue;
      const strongCount = (trimmed.match(_strongRe) || []).length;
      const weakCount = (trimmed.match(_weakRe) || []).length;
      const isList = /^(\d+[.、]|[-*])\s/.test(trimmed);
      const hasFeature = strongCount > 0 || weakCount > 0;
      if (hasFeature) {
        // 前面已有引导锚词行（如「好的」）+ 本行出现思考特征 → 引导词属于思考开头，给弱特征加成
        if (bodyStartPending) {
          weight += 1;
          bodyStartPending = false;
        }
        weight += strongCount * 2 + weakCount;
        prevHadFeature = true;
        thinkingEnd = lineStart + line.length;
        // 行内正文锚点：最后一个特征之后找首个引导锚词（排除引用场景）
        // 注意：仅覆盖记录（最后一个特征行的 anchor 才可能是真实切分），不立即 break
        let lastEnd = -1;
        for (const re of [_strongRe, _weakRe]) {
          re.lastIndex = 0;
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(trimmed)) !== null) {
            lastEnd = Math.max(lastEnd, mm.index + mm[0].length);
            if (mm[0].length === 0) re.lastIndex++;
          }
        }
        if (lastEnd >= 0) {
          const tail = trimmed.slice(lastEnd);
          let bestIdx = -1;
          for (const w of _anchorWords) {
            let from = 0;
            while (from < tail.length) {
              const p = tail.indexOf(w, from);
              if (p < 0) break;
              const preChar = p > 0 ? tail.charAt(p - 1) : "";
              const inQuote = preChar && _leftQuotes.has(preChar);
              const inWord = p > 0 && isAnchorInWord(preChar);
              if (!inQuote && !inWord) {
                if (bestIdx === -1 || p < bestIdx) bestIdx = p;
                break; // 该锚词找到有效命中
              }
              from = p + 1; // 引号内或词内，继续找同词的下一处
            }
          }
          if (bestIdx >= 0) {
            anchorStart = lineStart + lastEnd + bestIdx;
          }
        }
        continue;
      }
      if (isList && (prevHadFeature || weight > 0)) {
        thinkingEnd = lineStart + line.length;
        continue;
      }
      // 无特征、非列表行
      if (weight > 0) {
        // 冒号结尾 → 思考内过渡行（"根据角色要求：" 通常引出后续列表/说明）→ 延续思考
        if (/[:：]\s*$/.test(trimmed)) {
          // 强正文锚词行（报告/结论起头，如「以下是项目分析报告：」）且特征充足 → 思考段结束、正文开始
          if (strongBodyStartRe.test(trimmed) && weight >= 3) {
            naturalBreak = true;
            break;
          }
          thinkingEnd = lineStart + line.length;
          continue;
        }
        // 正文引导锚词开头（哈哈/你好/好的…），或强正文锚词（报告/结论/交付开场如「让我来分享…」，
        // 需 weight≥3 避免误伤）→ 确认为正文起始行 → 思考段结束
        if (_bodyStartRe.test(trimmed) || (strongBodyStartRe.test(trimmed) && weight >= 3)) {
          naturalBreak = true;
          break;
        }
        // 其他无特征行：视为思考内部尾句（"同时要保持轻松友好的语气。"），延续思考
        thinkingEnd = lineStart + line.length;
        continue;
      }
      // 首行即无特征（weight===0）：
      // 正文引导锚词开头 → 暂记 bodyStartPending（可能是「好的\n用户说…」思考开头），
      // 不立即 break，继续扫描后续行确认：后续出现特征 → 整体按思考；全程无特征 → 纯正文直通
      if (_bodyStartRe.test(trimmed)) {
        bodyStartPending = true;
        thinkingEnd = lineStart + line.length;
        continue;
      }
      // 非引导锚词的无特征行：疑似思考开头（特征未出现），等更多数据
      break;
    }
    // 全程无任何特征且首行为引导锚词 → 纯正文直通
    if (bodyStartPending && weight === 0) {
      bodyStart = true;
    }
    const endIdx = naturalBreak ? thinkingEnd : (anchorStart >= 0 ? anchorStart : thinkingEnd);
    const canCut = (naturalBreak && weight >= 2) || weight >= 3;
    if (canCut && endIdx > 0 && endIdx < buf.length) {
      const thought = buf.slice(0, endIdx).trim();
      const body = buf.slice(endIdx).trim();
      if (thought && body) return { decided: true, thought, body, weight, naturalBreak, bodyStart };
    }
    return { decided: false, weight, naturalBreak, bodyStart };
  };

  /** A-9xx 逐词换行思考缓存判定（push/flush 共用）。
   *  短行判定：≤3 字符且非列表标记、**非缩进行**——缩进（代码/引用/对齐）与列表标记作中性行，
   *  不参与密度统计（修复原实现把缩进代码块/列表逐行误判为「逐词换行思考」并整个吞掉的缺陷）。
   *  决策：
   *   - buffer：证据不足，继续累积；
   *   - release：出现正文行但碎片证据不足（或超长防卡）→ 整段按正文释放；
   *   - all-think：纯短行密集（≥8 行且 ≥70% 短行）→ 整体进思考并进入逐词思考模式；
   *   - cut：短行碎片（≥3 行且碎片占多数）后跟正文行（如 `好\n，让…。\n\n以下是报告`）
   *     → 碎片进思考、首个正文行起为正文（单 chunk 内「思考+正文」一次解出）。 */
  const evaluateTbt = (buf: string): { decision: "buffer" | "release" | "all-think" | "cut"; reason?: string; body?: string } => {
    const lines = buf.split("\n");
    let total = 0;
    let short = 0;
    let firstNormal = -1;
    for (let i = 0; i < lines.length; i++) {
      const tr = lines[i].trim();
      if (!tr) continue;
      if (/^[ \t]/.test(lines[i]) || /^(\s*[-*•+]\s|\s*\d+[.、]\s)/.test(tr)) continue; // 缩进/列表：中性
      if (tr.length <= 3) { short++; total++; continue; }
      if (!/^[\d.\-*•>\s]+$/.test(tr)) {
        if (firstNormal < 0) firstNormal = i;
        total++;
        continue;
      }
      // 纯符号/数字行（`---`、`123`）：中性
    }
    if (firstNormal < 0) {
      if (total >= 8 && short / total >= 0.7) return { decision: "all-think" };
      if (buf.length > 8000) return { decision: "release" };
      return { decision: "buffer" };
    }
    if (short >= 3 && short / total >= 0.7) {
      let cutOff = 0;
      for (let i = 0; i < firstNormal; i++) cutOff += lines[i].length + 1;
      return { decision: "cut", reason: buf.slice(0, cutOff), body: buf.slice(cutOff) };
    }
    return { decision: "release" };
  };

  /** A-9xx 逐词碎片拼接：把 token 逐行思考（`好\n，让\n我\n继续…`）合并为可读文本——全中文碎片
   *  直接拼接（`关\n键` → `关键`），含英文用空格（`The\nuser` → `The user`），与正文折叠语义一致。 */
  const joinFragmentedLines = (s: string): string => {
    const parts = s.split("\n").map((l) => l.trim()).filter(Boolean);
    const allCjk = parts.every((p) => /^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/.test(p));
    return allCjk ? parts.join("") : parts.join(" ");
  };

  return {
    get reasoning() {
      let r = rawReasoning;
      for (const p of THINK_TAG_PAIRS) {
        r = r.split(p.open).join("").split(p.close).join("");
      }
      r = r.split(DS_START).join("").split(DS_END).join("").split("\nresponse").join("");
      return r.trim();
    },
    push(content: string): string {
      if (!content) { return ""; }
      pending += content;
      const clean: string[] = [];
      while (pending.length > 0) {
        if (inDs) {
          // DeepSeek 思考块内：找行首 `response` 闭合（兼容 ` response` / `\nresponse` / `\n response`）
          const ci = findDsMarker(pending, DS_END);
          if (ci === -1) {
            const hold = holdTail(pending, "response");
            if (hold > 0) {
              const keep = pending.length - hold;
              if (keep > 0) {
                rawReasoning += pending.slice(0, keep);
                pending = pending.slice(keep);
              }
              break; // 尾部是闭合标记前缀，等待更多数据
            }
            rawReasoning += pending;
            pending = "";
          } else {
            // ci 指向行首空白（含前导空格/tab）；消费到 response 词尾
            const rest = pending.slice(ci);
            const m = rest.match(/^\s*response\b/i);
            const consume = m ? m[0].length : "response".length;
            rawReasoning += pending.slice(0, ci + consume);
            // response 后的换行是 DS 格式分隔符，不属于正文，去掉避免正文前导空行
            pending = pending.slice(ci + consume).replace(/^\s+/, "");
            inDs = false;
          }
        } else if (inTag) {
          const ci = pending.toLowerCase().indexOf(activeClose);
          if (ci === -1) {
            const hold = holdTail(pending, activeClose);
            if (hold > 0) {
              const keep = pending.length - hold;
              if (keep > 0) {
                rawReasoning += pending.slice(0, keep);
                pending = pending.slice(keep);
              }
              break; // 尾部是闭合标签前缀，等待更多数据
            }
            rawReasoning += pending;
            pending = "";
          } else {
            rawReasoning += pending.slice(0, ci + activeClose.length);
            pending = pending.slice(ci + activeClose.length);
            inTag = false;
            activeClose = "";
          }
        } else {
          // 正常模式：找最早出现的 XML 开标签或 DeepSeek 开标记（仅正文前沿）
          let oi = -1;
          let pairIdx = -1;
          for (let p = 0; p < THINK_TAG_PAIRS.length; p++) {
            const idx = pending.toLowerCase().indexOf(THINK_TAG_PAIRS[p].open);
            if (idx !== -1 && (oi === -1 || idx < oi)) {
              oi = idx;
              pairIdx = p;
            }
          }
          const dsStart = !started ? findDsStart(pending) : null;
          if (dsStart && (oi === -1 || dsStart.pos < oi)) {
            // 畸形标签防护：`< thinking >`（标记后紧跟 `>`）不是 DeepSeek 思考块，按普通文本放行
            const after = pending.slice(dsStart.pos + dsStart.len);
            const ws = after.match(/^\s*/);
            const firstNonWs = ws ? after.charAt(ws[0].length) : "";
            if (firstNonWs === ">") {
              clean.push(pending);
              pending = "";
              continue;
            }
            // 标记后仅有空白：可能是 ` thinking 内容`（思考）或 `< thinking >` 残片（畸形标签）
            // 保守暂扣留等待更多数据判定，避免误判畸形标签或思考块
            if (after.trim() === "") {
              const keep = dsStart.pos;
              if (keep > 0) {
                clean.push(pending.slice(0, keep));
              }
              pending = pending.slice(keep);
              break;
            }
            // DeepSeek 开标记更早：进入思考块（统一记录标准标记，getter 剥离）
            clean.push(pending.slice(0, dsStart.pos));
            rawReasoning += DS_START;
            pending = pending.slice(dsStart.pos + dsStart.len);
            inDs = true;
            continue;
          }
          if (oi === -1) {
            // 无开标签：检查尾部是否为某开标签前缀（跨 chunk）
            let hold = 0;
            for (const p of THINK_TAG_PAIRS) {
              hold = Math.max(hold, holdTail(pending, p.open));
            }
            if (!started) {
              hold = Math.max(hold, holdTail(pending, DS_START), holdTail(pending, "thinking"));
            }
            if (hold > 0) {
              const keep = pending.length - hold;
              if (keep > 0) {
                clean.push(pending.slice(0, keep));
                pending = pending.slice(keep);
              }
              break; // 尾部是开标签前缀，等待更多数据
            }
            clean.push(pending);
            pending = "";
          } else {
            clean.push(pending.slice(0, oi));
            const rest = pending.slice(oi);
            const active = THINK_TAG_PAIRS[pairIdx];
            const ci = rest.toLowerCase().indexOf(active.close);
            if (ci !== -1) {
              // 同一 chunk 内闭合：提取思考，剩余部分继续按正文处理
              rawReasoning += rest.slice(0, ci + active.close.length);
              pending = rest.slice(ci + active.close.length);
            } else {
              const hold = holdTail(rest, active.close);
              if (hold > 0) {
                // rest 尾部是闭合标签前缀残片：保留残片，其余入思考
                const keep = rest.length - hold;
                if (keep > 0) {
                  rawReasoning += rest.slice(0, keep);
                  pending = rest.slice(keep);
                } else {
                  pending = rest;
                }
              } else {
                rawReasoning += rest;
                pending = "";
              }
              inTag = true;
              activeClose = active.close;
              break;
            }
          }
        }
      }
      let out = clean.join("");

      // ── A-175/A-9xx: 逐词换行思考剥离（全阶段生效，包含正文中部/工具轮后的第二轮思考）──
      // 模型把中间思考逐 token 换行输出且无标签时，特征词启发式（evalUntagged）失效，
      // quickRelease 会把它当普通正文放行。此处用「超短行密度」识别并整体剥离。
      let tbtCut = false; // 本次 push 已由逐词层确认「碎片思考+正文」切分（body 免再受怀疑缓冲）
      if (inTbt) {
        // 已在逐词思考模式：碎片先累积（不逐 chunk 进 reasoning），等正文回归时**一次性拼接**，
        // 避免 `关\n键` 等跨 chunk 碎片在 reasoning 里保留逐行形态。
        tbtBuf += out;
        out = "";
        const tbtBufLines = tbtBuf.split("\n");
        let cutOff = -1;
        let offset = 0;
        for (let i = 0; i < tbtBufLines.length; i++) {
          const tr = tbtBufLines[i].trim();
          if (!tr) continue;
          if (tr.length >= TBT_END_LEN && !/^[\d.\-*•>\s]+$/.test(tr)) { cutOff = offset; break; }
          offset += tbtBufLines[i].length + 1;
        }
        if (cutOff >= 0) {
          // **首个**正文行即正文回归（原实现要求连续 2 个正常行——正文一侧只有一行时整段被吞，A-9xx 修正）
          rawReasoning += "\n" + joinFragmentedLines(tbtBuf.slice(0, cutOff)) + "\n";
          out = tbtBuf.slice(cutOff);
          inTbt = false;
          tbtBuf = "";
        }
        // 否则：碎片继续累积（out 保持空，流式阶段不泄漏）
      } else if (out) {
        tbtBuf += out;
        out = "";
        const ev = evaluateTbt(tbtBuf);
        if (ev.decision === "release") {
          // 无碎片特征（正常正文）→ 立即释放；避免正文被卡在缓冲里、饿死后续 untagged 判定层
          out = tbtBuf;
          tbtBuf = "";
        } else if (ev.decision === "all-think") {
          rawReasoning += "\n" + joinFragmentedLines(tbtBuf) + "\n";
          tbtBuf = "";
          inTbt = true;
        } else if (ev.decision === "cut") {
          rawReasoning += "\n" + joinFragmentedLines(ev.reason ?? "") + "\n";
          out = ev.body ?? "";
          tbtBuf = "";
          tbtCut = true;
        }
        // decision === "buffer" → 继续累积（out 保持空）
      }

      // ── 新增：流式无标记裸思考层（仅正文前沿 started=false，先于重复前缀判定） ──
      if (!started && out) {
        if (!tbtCut) {
          // 逐词层已确认本片段为正文（碎片思考已入 reasoning）——跳过怀疑缓冲，直接进重复前缀层
          untaggedBuf += out;
        out = "";
        // 统计行数（换行符 + 1，首行无前置换行也算；上限 UNTAGGED_MAX_LINES 对齐 i<8）
        let lc = 1;
        for (let i = 0; i < untaggedBuf.length; i++) if (untaggedBuf[i] === "\n") lc++;
        untaggedLineCount = lc;
        const judged = evalUntagged(untaggedBuf);
        if (judged.decided && judged.thought && judged.body) {
          // 命中：思考推入 rawReasoning（加换行，getter 会 trim），body 进入后续 headBuf 流程
          rawReasoning += "\n" + judged.thought + "\n";
          untaggedBuf = judged.body;
          untaggedLineCount = 1;
          // body 是真实正文：untagged 层使命完成；后续 chunk 不再进这层（started 仍由 headBuf 设置）
          // 但考虑到 body 可能仍有思考重复前缀，把 untaggedBuf 内容「直接交给」下一层 headBuf
          out = untaggedBuf; // 转入 headBuf 分支（下面的 !started 块会 += out 再处理）
          untaggedBuf = "";
          untaggedLineCount = 0;
        } else {
          // 未判定：分策略决定是继续扣留（疑似裸思考，需要更多证据）还是立即放行（正常对话）
          const trimmed = untaggedBuf.trim();
          const bufChars = trimmed.length;
          // 权重 ≥3（疑似长思考块）时放宽行上限到 UNTAGGED_SCAN_LIMIT，避免长思考块在正文到达前
          // 被提前强制切分、尾部思考泄漏为正文；低证据时维持 8 行快速判定
          const overLines = untaggedLineCount > (judged.weight >= 3 ? UNTAGGED_SCAN_LIMIT : UNTAGGED_MAX_LINES);
          const overChars = bufChars > UNTAGGED_MAX_CHARS;
          // 最高优先级：已出现独立正文行（naturalBreak）→ 说明思考段已结束，可立即放行
          // 注意：bodyStart（首行锚词如「好的」）不再立即放行——可能是「好的\n用户说…」思考开头，
          // 需等待第二行确认：第二行同为正文锚词 → 纯正文放行；否则继续缓冲供 eval 判定剥离。
          const sawBodyLine = judged.naturalBreak;
          let bodyConfirm = false;
          if (judged.bodyStart) {
            const ls = untaggedBuf.split("\n");
            if (ls.length >= 2 && ls[1].trim() && _bodyStartRe.test(ls[1].trim())) {
              bodyConfirm = true;
            }
          }
          // 快速放行：完全无思考特征 / 特征极弱 → 到达温和阈值即直通（阈值放宽，避免思考开头被误放行）
          let quickRelease = false;
          if (judged.weight === 0) {
            quickRelease = untaggedLineCount >= 4 || bufChars >= 200;
          } else if (judged.weight <= 1) {
            quickRelease = untaggedLineCount >= 5 || bufChars >= 300;
          }
          if (overLines || overChars || sawBodyLine || bodyConfirm || quickRelease) {
            let result = { cleanReply: untaggedBuf, reasoning: "" };
            // 超限：仍尝试一次完整的 splitUntaggedThinking 兜底（弱/强阈值可能命中）
            if (overLines || overChars) {
              result = splitUntaggedThinking(untaggedBuf);
              if (result.reasoning && result.cleanReply !== untaggedBuf) {
                rawReasoning += "\n" + result.reasoning + "\n";
                out = result.cleanReply;
                untaggedBuf = "";
                untaggedLineCount = 0;
              } else {
                out = result.cleanReply;
                untaggedBuf = "";
                untaggedLineCount = 0;
              }
            } else {
              // naturalBreak / bodyStart / quickRelease：判为无裸思考或思考段已结束，直通不做思考剥离
              out = untaggedBuf;
              untaggedBuf = "";
              untaggedLineCount = 0;
            }
          }
        }
        } // tbtCut else（正常走怀疑缓冲分支）收口
      }

      // 重复前缀剥离（仅正文开头；无 reasoning 时零延迟直通）
      if (!started) {
        headBuf += out;
        out = "";
        const rt = getReasoning().trim();
        if (headBuf.trim()) {
          if (rt) {
            // 循环剥离重复前缀（模型可能把思考重复写进 content）
            while (headBuf.startsWith(rt) && headBuf.length > rt.length) {
              headBuf = headBuf.slice(rt.length).trimStart();
            }
            if (headBuf.startsWith(rt) || rt.startsWith(headBuf)) {
              // headBuf 仍是 rt 前缀（或等于 rt）→ 继续缓冲等待更多数据
            } else {
              started = true;
              out = headBuf;
              headBuf = "";
            }
          } else {
            started = true;
            out = headBuf;
            headBuf = "";
          }
        }
        // 全空白 headBuf：继续缓冲（等待可能的 DeepSeek 思考块或首个真实正文）
      }
      return out;
    },
    flush(): string {
      let out = pending;
      pending = "";
      if (inTag || inDs) {
        rawReasoning += out;
        out = "";
      }
      // ── A-175/A-9xx: 逐词换行思考残留兜底（流结束未判定/未退出的缓冲区一次性处理） ──
      if (inTbt) {
        rawReasoning += "\n" + joinFragmentedLines(tbtBuf + out) + "\n";
        out = "";
        inTbt = false;
        tbtBuf = "";
      } else if (tbtBuf) {
        // 流结束未判定缓冲：按同一套密度逻辑最终判定（短行占多数 → 并入思考；buffer 在流结束视为正文）
        const ev = evaluateTbt(tbtBuf);
        if (ev.decision === "all-think") {
          rawReasoning += "\n" + joinFragmentedLines(tbtBuf) + "\n";
          tbtBuf = "";
        } else if (ev.decision === "cut") {
          rawReasoning += "\n" + joinFragmentedLines(ev.reason ?? "") + "\n";
          out = (ev.body ?? "") + (out ? out : "");
          tbtBuf = "";
        } else {
          // buffer / release：流结束一律按正文释放（不再等后续数据）
          out = tbtBuf + (out ? out : "");
          tbtBuf = "";
        }
      }
      // ── 残余 untaggedBuf + TBT 释放的正文前沿兜底切分（完整 splitUntaggedThinking） ──
      // A-9xx：TBT 在流结束释放的内容**并入 untaggedBuf 统一走怀疑判定**（原来直接落 headBuf，
      // 「同行思考+正文单行」等场景在 flush 时思考从未被评估 → 泄漏到正文）
      if (!started && (untaggedBuf || out)) {
        untaggedBuf += out;
        out = "";
        const judged = evalUntagged(untaggedBuf);
        let body = untaggedBuf;
        if (judged.decided && judged.thought && judged.body) {
          rawReasoning += "\n" + judged.thought + "\n";
          body = judged.body;
        } else {
          const result = splitUntaggedThinking(untaggedBuf);
          if (result.reasoning) rawReasoning += "\n" + result.reasoning + "\n";
          body = result.cleanReply;
        }
        untaggedBuf = "";
        untaggedLineCount = 0;
        out = body;
      }
      if (!started) {
        headBuf += out;
        out = "";
        const rt = getReasoning().trim();
        if (rt) {
          while (headBuf.startsWith(rt) && headBuf.length > rt.length) {
            headBuf = headBuf.slice(rt.length).trimStart();
          }
        }
        out = headBuf;
        headBuf = "";
      }
      return out;
    },
  };
}

function buildDelegationContext(
  children: Array<{ name: string; role: string }>,
  allNames: string[],
): string {
  return buildDelegationPrompt(children, allNames);
}

function drainA2AContext(pending: Array<{ msg_type: string; from_agent: string; content: string }>): string {
  const tagMap: Record<string, string> = { request: "委托", response: "回复", info: "广播", alert: "告警" };
  const parts: string[] = [];
  for (const m of pending.slice(-10)) {
    const tag = tagMap[m.msg_type] ?? m.msg_type;
    parts.push(`[${tag} 来自 ${m.from_agent}]: ${m.content.slice(0, 300)}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return "## 来自其他 Agent 的消息\n" + parts.join("\n");
}

// ── 流会话（{seq,type,data} + 断线重放缓冲）───────────────

export interface StreamSession {
  streamId: string;
  seq: EventSequence;
  buffer: ServiceEvent<unknown>[];
  readonly maxBuffered: number;
  emit<T>(type: string, data: T): ServiceEvent<T>;
  resumeFrom(lastSeq: number): ServiceEvent<unknown>[];
}

export function createStreamSession(): StreamSession {
  const seq = new EventSequence();
  const maxBuffered = 500;
  const buffer: ServiceEvent<unknown>[] = [];
  return {
    streamId: crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : String(Date.now()),
    seq,
    buffer,
    maxBuffered,
    emit<T>(type: string, data: T): ServiceEvent<T> {
      const ev = seq.emit(type, data);
      buffer.push(ev as ServiceEvent<unknown>);
      if (buffer.length > maxBuffered) {
        buffer.splice(0, buffer.length - maxBuffered);
      }
      return ev;
    },
    resumeFrom(lastSeq: number): ServiceEvent<unknown>[] {
      return buffer.filter((e) => e.seq > lastSeq);
    },
  };
}

// ── ChatService ────────────────────────────────────────────

export class ChatService {
  private registry: AgentRegistry;
  private engine: ChatEngine;
  private bus: ServerA2ABus | null;
  private postProcess: PostProcessHooks;
  private evidence: EvidenceInjector;
  private emit: (ev: ServiceEvent<unknown>) => void;
  private alarms: AlarmBus;
  private historyStore: HistoryStore;
  private logger: Pick<Console, "warn" | "info" | "debug">;

  constructor(opts: ChatServiceOptions) {
    this.registry = opts.registry;
    this.engine = opts.engine;
    this.bus = opts.bus ?? null;
    this.postProcess = opts.postProcess ?? {};
    this.evidence = opts.evidence ?? ((m) => m);
    this.emit = opts.emit ?? (() => undefined);
    this.alarms = opts.alarms ?? getAlarmBus();
    this.historyStore = opts.history ?? fileHistoryStore;
    this.logger = opts.logger ?? console;
  }

  private alarm(source: string, message: string, severity: AlarmSeverity = "warning"): void {
    this.alarms.record(source, message, severity);
    this.logger.warn(`[alarm][${severity}] ${source}: ${message}`);
  }

  private async systemPromptFor(agent: AgentState): Promise<string> {
    const children = await this.registry.childrenOf(agent);
    const allNames = (await this.registry.names()).filter((n) => n !== agent.name);
    let sys = agent.identity_prompt || `你是 ${agent.name}，你的角色是：${agent.role}`;
    const delegation = buildDelegationContext(children, allNames);
    if (delegation) {
      sys += "\n\n" + delegation;
    }
    // A-980-R30：委派规范重写。原句只说"主动调 delegate_subagent，结果由系统回收"——
    // ① 没讲怎么派（Anthropic 实测：只写一句"研究半导体短缺"会让多个子代理重复劳动，
    //    task 必须带「目标 + 输出格式 + 边界」）；
    // ② 没讲按复杂度伸缩（简单事实查不该委派）；
    // ③ **"由系统回收"是当时的空头承诺**（代码里根本没有回收），现在工具本身阻塞等结果并交回验收，
    //    所以这里必须明确要求主 Agent 验收，否则多智能体最大的失效模式就是"不加核对地转述子代理结论"。
    sys += "\n\n子任务委派（delegate_subagent / subagent_result）：" +
      "\n- **何时委派**：子任务**独立、自包含**、不需要跟用户来回确认，且产出较冗长（联网调研 / 代码审查 / 数据分析 / 批量处理 / 多方案比对）时，交给子代理可避免污染主线上下文。" +
      "\n- **何时不委派**：主线对话本身（要频繁追问/修改/确认的）、一两步就能做完的、必须共享同一上下文才能做的——这些自己做完。" +
      "\n- **怎么派（重要）**：`task` 必须写清 **①目标 ②期望的输出格式 ③边界**。只写一句「研究一下 X」会让子代理跑偏、或与另一个子代理重复劳动。" +
      "\n- **规模按复杂度伸缩**：简单事实查不用委派；一个独立子任务派一个；只有**多个互不依赖**的子任务才并行派（同一轮连续调用多次即可，每次都会等自己的结果；或 background=true 先全部派出，之后逐个 `subagent_result` 收）。" +
      "\n- **必须验收**：子代理的产出会作为工具结果交回给你。先对照你下发的目标核对它是否真的完成、产物是否落地，再据其推进主线；产出不完整或结论存疑时，点名同一个子代理追问（`agent` 参数），或自己补齐。" +
      "**绝不要把子代理的结论不加核对地当作事实转述给用户。**" +
      (sys.includes("## 可用子代理") ? "" : "（系统提示里若给出了「可用子代理」清单，可在 `agent` 里点名；没有清单就留空，由系统按任务语义自动选。）");
    // A-918++：指令驱动 —— ADB / HTTP 网页应用生成，全靠 Agent 工具，不让用户手动操作
    sys += "\n\n指令驱动（无需让用户手动操作面板）：\n" +
      "1) 用户要「做个网页 / 应用 / 小工具 / 页面 / 网站 / 落地页 / 表单 / 计算器 / 待办 / 计时器」等需求时，**直接用 http_create_app 工具**生成自包含单页应用（按需求自动选模板），生成后会在右侧栏浏览器自动打开，并把可点击的访问地址（http://127.0.0.1:<port>）直接告诉用户。不要追问技术细节，直接生成并给链接。\n" +
      "2) 用户要「操作手机 / 模拟器 / 安卓设备 / 装 App / 卸载 / 截图 / 跑命令」时，**直接用 adb_* 工具**：先 adb_connect（不传 host 会自动扫描雷电/夜神/MuMu/Genymotion/AVD 等常见模拟器端口并列出连上的设备）或 adb_devices 拿到 serial，再执行 adb_shell / adb_install / adb_screencap 等操作。**不要让用户自己输参数或手动连设备**——你主动探测、连接、操作，只把结果汇报给用户。\n" +
      "3) 以上工具依赖运行环境装配的 AdbService / HttpServer；若返回「未就绪」提示，如实告知用户当前环境未启用该能力即可，不要假装成功。\n" +
      "4) **图形控制（点击/滑动/输入）必须按下面的高精度流程做**，否则极易点错：\n" +
      "   a. **安卓**：先 screen_ui_dump 拿元素列表 → 用 screen_action({kind:\"click\", selector:{index:N}}（或 text/id））**按元素点击**——这是最稳的方式，优先于任何坐标。\n" +
      "   b. 元素列表里没有目标 → 先 screen_action 下滑/swipe 后再 screen_ui_dump；若是全屏画布/游戏（无元素树）→ 用 screen_capture 截图，按图上**刻度网格**读像素坐标，再 screen_action 传 x,y（默认就是**所见图像的像素坐标**，直接量，不要换算）。\n" +
      "   c. **每次 screen_action 后都会回传操作后的画面——务必看一眼确认是否真的点中/生效**；没生效就重新截图重新定位，**不要用同一坐标盲目重试**。\n" +
      "   d. 桌面（本机电脑）：**先 screen_windows 看有哪些窗口 → screen_focus 或 screen_capture({window:\"记事本\"}) 把目标窗口带到前台再截图**（按窗口截图会自动裁到该窗口、坐标带窗口偏移，比截整屏准得多）→ screen_action 按刻度读像素坐标操作。桌面无元素树，「先聚焦、再看图、按刻度定位」这三步是精度的关键；type 输入中文在安卓上不受支持（需设备装 ADBKeyboard），失败时如实说明别硬试。\n" +
      "5) **右侧栏浏览器操作（browser_* 工具）**——用户要求「打开某网站 / 在网页里点某按钮 / 填表 / 查网页内容」时用它，**不要**改用命令行或让他自己开浏览器：\n" +
      "   a. 流程：browser_navigate 打开网址 → **browser_snapshot** 拿元素清单（编号/文本/CSS 选择器）→ browser_click({index:N} 或 {text:\"登录\"}) 点击、browser_type({text, selector}) 填表 → browser_snapshot/browser_screenshot 核对是否生效。\n" +
      "   b. **元素定位优先于坐标**（与安卓同思路）；确实要按坐标点时浏览器坐标是**页面像素**（可用 browser_screenshot 的元素编号辅助）。\n" +
      "   c. 页面需要时间加载/渲染时用 browser_wait；要同时访问多个网站用 browser_open_tab 新开页（各页内容互相独立）。\n" +
      "   d. 操作后**必须核对**（snapshot 或截图）；没生效就重新 snapshot 再试，不要重复同样的点击。";
    // A-980-R22：工具面白名单——按 Agent 概况注入「已启用技能/MCP 清单」，模型只把清单内能力当可用
    sys += agentSkillGuide(resolveAgentToolProfile(agent.tool_profile));
    return sys;
  }

  /** A-980-R22：按 Agent 概况解析工具面下发白名单（内置工具+skill 入口恒保留；mcp_* 按勾选服务器前缀匹配）。
   *  引擎未实现 listTools（例如测试 mock）→ 返回 undefined，调用处不传 toolsOnly（全量，零回归） */
  private agentToolsFor(agent: AgentState): string[] | undefined {
    const names = this.engine.listTools?.().map((t) => t?.function?.name).filter((n): n is string => !!n);
    if (!names) { return undefined; }
    return agentToolsOnly(
      resolveAgentToolProfile(agent.tool_profile),
      () => names,
    );
  }

  private async effectiveMessage(agent: AgentState, message: string): Promise<string> {
    let effective = await this.evidence(message); // A-098: 平台证据注入
    if (this.bus) {
      const pending = this.bus.drainAll(agent.name);
      if (pending.length > 0) {
        const a2aCtx = drainA2AContext(
          pending.map((m) => ({
            msg_type: m.msg_type,
            from_agent: m.from_agent,
            content: m.content,
          })),
        );
        if (a2aCtx) {
          effective = effective + "\n\n" + a2aCtx;
        }
      }
    }
    return effective;
  }

  // ── /chat/analyze ──────────────────────────────────────

  /** 会话级工作目录（"以文件夹为主"模型）：按 sessionId 查 SessionMeta.workspace；无会话/无配置 → undefined（回退 Agent 级） */
  private async sessionWorkspaceFor(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) { return undefined; }
    try {
      const meta = await getSession(sessionId);
      const ws = meta?.workspace?.trim();
      return ws || undefined;
    } catch {
      return undefined;
    }
  }

  /** 团队会话声明信息（组长视角）：按 sessionId 解析成员名单与角色（"一个会话=一个团队"模型） */
  private async teamContextFor(sessionId?: string): Promise<string> {
    if (!sessionId) { return ""; }
    try {
      const meta = await getSession(sessionId);
      const memberIds = Array.isArray(meta?.members) ? meta.members.filter((id) => id && id !== meta!.agentId) : [];
      if (memberIds.length === 0) { return ""; }
      const loaded = await this.registry.loadedAgents;
      const roster = memberIds
        .map((id) => loaded.find((a) => a.id === id))
        .filter((a): a is AgentState => !!a)
        .map((a) => `- ${a.name}：${a.role || "无角色"}`);
      if (roster.length === 0) { return ""; }
      return [
        "## 团队协作模式（组长职责）",
        "你当前领导一个 Agent 团队，以下成员与你协作共同服务用户：",
        roster.join("\n"),
        "协作规则：",
        "- 你是组长：负责理解用户需求、拆解任务、统筹规划、分派与汇总。",
        "- 需要某成员出力时，使用 <DELEGATE name=\"成员名\">任务描述</DELEGATE> 标签派单。",
        "  成员会并行执行并把结果发回本会话，由你整合成完整回复。",
        "- 成员职责范围内的问题交给对应成员完成，不要越俎代庖；整合时注明各成员的贡献。",
      ].join("\n");
    } catch {
      return "";
    }
  }

  async analyze(agentId: string, message: string): Promise<SwarmAnalysis> {
    const agent = await this.registry.findAgent(agentId);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    const prompt = buildSwarmAnalysisPrompt(message, 1);
    const result = await this.engine.chat({
      agent,
      message: prompt,
      history: [],
      systemPrompt: "你是 slime 平台的调度分析器。",
      maxTokens: 512,
    });
    const parsed = parseSwarmAnalysis(result.reply);
    if (!parsed.parse_ok) {
      this.logger.warn(`[slime] Swarm 分析回复解析失败，降级为 chat: ${result.reply.slice(0, 120)}`);
    }
    return parsed;
  }

  // ── /chat ──────────────────────────────────────────────

  async chat(agentId: string, req: ChatRequest): Promise<ChatResult> {
    const agent = await this.registry.findAgent(agentId);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    const systemPrompt = await this.systemPromptFor(agent);
    const teamCtx = await this.teamContextFor(req.sessionId);
    const systemBegin = teamCtx ? `${systemPrompt}\n\n${teamCtx}` : systemPrompt;
    const effective = await this.effectiveMessage(agent, req.message);
    const history = [...(req.history ?? [])];
    const workspace = await this.sessionWorkspaceFor(req.sessionId);

    let result = await this.engine.chat({
      agent,
      message: effective,
      history,
      systemPrompt: systemBegin,
      maxTokens: req.maxTokens,
      workspace,
      // A-980-R22：工具面白名单（内置+skill 入口保留，mcp_* 按 Agent 勾选过滤）
      toolsOnly: this.agentToolsFor(agent),
    });
    let reply = result.reply?.trim() || "[Agent 未返回有效回复]";

    // ── 委托 / 广播路由 ──
    const delegations = parseDelegations(reply);
    const broadcastMsg = parseBroadcast(reply);
    if (broadcastMsg && this.bus) {
      this.bus.broadcast(agent.name, broadcastMsg, "info");
      this.logger.info(`[slime] ${agent.name} 广播了一条消息给 ${this.bus.getRegisteredNames()}`);
    }
    if (delegations.length > 0) {
      const delegationResults: Array<{ name: string; task: string; result: string }> = [];
      for (const d of delegations.slice(0, MAX_DELEGATIONS)) {
        const child = (await this.registry.loadedAgents).find(
          (a) => a.name.toLowerCase() === d.name.toLowerCase(),
        );
        if (!child) {
          continue;
        }
        try {
          const childResult = await this.engine.chat({
            agent: child,
            message: d.task,
            history: [],
            systemPrompt: child.identity_prompt || `你是 ${child.name}，你的角色是：${child.role}`,
            workspace,
          });
          const childReply = childResult.reply ?? "";
          delegationResults.push({ name: d.name, task: d.task, result: childReply });
          if (this.bus) {
            this.bus.sendResult(d.name, agent.name, childReply.slice(0, 500));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.warn(`[slime] 委托到 ${d.name} 失败: ${msg}`);
          delegationResults.push({ name: d.name, task: d.task, result: `委托失败: ${msg}` });
        }
      }
      if (delegationResults.length > 0) {
        const resultsText = delegationResults
          .map((r) => `## ${r.name} 的回复\n任务：${r.task}\n结果：${r.result}`)
          .join("\n\n");
        const followupMsg =
          `你刚才将以下子任务委托给了子 Agent，现在结果已经返回。` +
          `请基于这些结果整合成完整的回复给用户：\n\n${resultsText}`;
        const followupHistory = [...history];
        followupHistory.push({ role: "assistant", content: stripDelegationTags(reply) });
        const followupResult = await this.engine.chat({
          agent,
          message: followupMsg,
          history: followupHistory,
          systemPrompt: systemBegin,
          maxTokens: req.maxTokens,
          workspace,
        });
        reply = stripDelegationTags(followupResult.reply ?? "");
        result = followupResult;
      } else {
        reply = stripDelegationTags(reply);
      }
    } else {
      reply = stripDelegationTags(reply);
    }
    if (!reply) {
      reply = "[Agent 未返回有效回复]";
    }
    // 思考内容剥离（Qwen3 泄漏进正文时提取；非流式路径无 reasoning 展示，直接丢弃）
    reply = extractThinkingFromReply(reply).cleanReply || "[Agent 未返回有效回复]";

    // A-087: 失败前缀黑名单（API 失败不驱动人格正反馈）
    const success = !isFailReply(reply);

    // A-090: 存储/学习用原文（reply_raw），品牌过滤只作用于展示
    const rawReply = extractThinkingFromReply(result.replyRaw ?? reply).cleanReply;

    if (req.retry) {
      await this.historyStore.popLast(agent.id, req.sessionId);
    }
    await this.recordInteraction(agent, req.message, rawReply, success, req.sessionId, undefined, result.elapsedMs && result.elapsedMs > 0 ? result.elapsedMs : undefined);

    void this.spawnPostProcess(agent, req.message, rawReply, success); // 后台派发，不阻塞响应

    return {
      reply,
      agentId: agent.id,
      model: result.model ?? "",
      promptTokens: result.promptTokens ?? 0,
      completionTokens: result.completionTokens ?? 0,
      elapsedMs: result.elapsedMs ?? 0,
      success,
    };
  }

  // ── /chat/stream ───────────────────────────────────────

  /**
   * 流式对话：事件流（{seq,type,data}）。完整语义：
   * A-005 委托能力对齐 /chat；A-049/A-085 编造检测强制工具轮；
   * 委托后台执行 + 15s 心跳；done 单收尾（委托整合后发出）；finally 持久化。
   */
  async *stream(agentId: string, req: ChatRequest, resumeSeq = 0, signal?: AbortSignal): AsyncGenerator<ServiceEvent<unknown>> {
    const agent = await this.registry.findAgent(agentId);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    const session = createStreamSession();
    // 断线重连：先重放缓冲中 seq 之后的事件，再继续新事件
    for (const ev of session.resumeFrom(resumeSeq)) {
      yield ev;
      this.emit(ev);
    }

    const emitChunk = (chunk: EngineChunk): ServiceEvent<unknown> => {
      const ev = session.emit(chunk.type, chunk as unknown as Record<string, unknown>);
      this.emit(ev);
      return ev;
    };

    const systemPrompt = await this.systemPromptFor(agent);
    const teamCtx = await this.teamContextFor(req.sessionId);
    const systemBase = teamCtx ? `${systemPrompt}\n\n${teamCtx}` : systemPrompt;
    const system = req.resumeHint ? `${systemBase}\n\n[系统·中断续接] ${req.resumeHint}` : systemBase;
    const workspace = await this.sessionWorkspaceFor(req.sessionId);
    // 显式传唤预委派：入参消息若直接包含 <DELEGATE name="..">（用户按「⟳ 传唤」按钮，
    // 或消息里手写委派标签），不依赖主 Agent 二次输出标签，立即按标签直连目标 Agent
    // 执行并把结果注入，保证本地小模型下传唤也稳定生效。
    // 团队会话中，成员的答复以 type="member" 事件冒泡成独立"成员发言"（群聊渲染）。
    const directDelegates = parseDelegations(req.message);
    let directDelegationInject = "";
    for (const d of directDelegates.slice(0, MAX_DELEGATIONS)) {
      const target = (await this.registry.loadedAgents).find(
        (a) => a.name.toLowerCase() === d.name.toLowerCase(),
      );
      if (!target) {
        directDelegationInject += `\n\n[传唤失败] 找不到名为「${d.name}」的 Agent，未执行委派。`;
        continue;
      }
      try {
        const childResult = await this.engine.chat({
          agent: target,
          message: d.task,
          history: [],
          systemPrompt: target.identity_prompt || `你是 ${target.name}，你的角色是：${target.role}`,
          workspace,
        });
        const childReply = childResult.reply ?? "";
        directDelegationInject +=
          `\n\n📮 你已传唤 Agent「${target.name}」执行任务：${d.task}\n对方回复：\n${childReply}`;
        yield emitChunk({ type: "member", name: target.name, agentId: target.id, content: childReply });
        if (this.bus) {
          this.bus.sendResult(d.name, agent.name, childReply.slice(0, 500));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        directDelegationInject += `\n\n[传唤失败] Agent「${d.name}」执行出错：${msg}`;
        yield emitChunk({ type: "member", name: target?.name ?? d.name, agentId: target?.id, content: `（任务执行出错）${msg}` });
      }
    }
    // 主消息去掉 DELEGATE 标签文本本身（委派结果已注入），避免模型把标签当普通内容
    const mainMsg = stripDelegationTags(req.message).trim();
    const msgForEngine = directDelegationInject ? `${mainMsg}\n${directDelegationInject}` : mainMsg;
    const effective = await this.effectiveMessage(agent, msgForEngine || req.message);
    const history = [...(req.history ?? [])];

    let fullReply = "";
    let errorMsg = "";
    let doneReceived = false;
    let heldDone: EngineChunk | null = null;
    let toolEventCount = 0;
    const toolEventNames: string[] = [];
    /** 本次所有工具调用（主循环 + 委托 + 强制工具轮），持久化进思考过程留痕 */
    const reasoningToolNames: string[] = [];
    let model = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let elapsedMs = 0;
    /** 推理/思考过程累积（持久化到历史，切换会话后仍可展开查看） */
    let reasoningBuf = "";
    /** 流式思考剥离器：边到边把思考从正文 chunk 中剥离（云端/本地思考模型都可能泄漏） */
    const stripper = createThinkingStripper(() => reasoningBuf);

    try {
      for await (const chunk of this.engine.stream({
        agent,
        message: effective,
        history,
        systemPrompt: system,
        maxTokens: req.maxTokens,
        signal,
        workspace,
        sessionId: req.sessionId,
        images: req.images,
        // A-980-R22：工具面白名单（内置+skill 入口保留，mcp_* 按 Agent 勾选过滤）
        toolsOnly: this.agentToolsFor(agent),
        // A-980-R24：接线工具循环的预算护栏（此前从未传 → tool_loop 里的三道护栏是死代码）。
        // 用宽松默认值（见文件头常量注释）；需要更长/更短时改环境变量，无需改代码。
        maxWallClockMs: DEFAULT_TOOL_WALL_CLOCK_MS,
        maxTotalTokens: DEFAULT_TOOL_MAX_TOTAL_TOKENS,
      })) {
        if (chunk.type === "chunk") {
          const clean = stripper.push(chunk.content ?? "");
          fullReply += clean;
          if (fullReply.length > STREAM_MAX_CHARS) {
            yield emitChunk({ type: "error", message: "响应超限已截断（>10MB）" });
            return;
          }
          if (clean) {
            yield emitChunk({ ...chunk, content: clean });
          }
        } else if (chunk.type === "tool") {
          toolEventCount += 1;
          const tname = String(chunk.name ?? "");
          toolEventNames.push(tname);
          reasoningToolNames.push(tname);
          yield emitChunk(chunk);
        } else if (chunk.type === "reasoning" || chunk.type === "progress") {
          if (chunk.type === "reasoning") {
            reasoningBuf += chunk.content ?? "";
          }
          yield emitChunk(chunk);
        } else if (chunk.type === "done") {
          doneReceived = true;
          // A-090: 存储/学习用原文（reply_raw），展示走逐 chunk
          fullReply = chunk.reply_raw ?? chunk.reply ?? fullReply;
          heldDone = chunk;
        } else if (chunk.type === "error") {
          errorMsg = chunk.message ?? "";
          fullReply = errorMsg;
          this.alarm("chat.stream", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
          yield emitChunk(chunk);
        }
      }

      // 主循环结束：冲刷剥离器残留（未闭合标签/未决前缀），并把剥离的思考并入 reasoningBuf
      const stripperTail = stripper.flush();
      if (stripperTail) {
        // done 已携带全文（reply_raw 含缓冲内容）→ 不再重复累加，仅流未完成（无 done）时补充到 fullReply
        if (!doneReceived) {
          fullReply += stripperTail;
        }
        yield emitChunk({ type: "chunk", content: stripperTail });
      }
      const sr = stripper.reasoning.trim();
      if (sr && !reasoningBuf.includes(sr)) {
        reasoningBuf = [reasoningBuf, sr].filter(Boolean).join("\n");
      }

      // 用户已中断：跳过 A-049 强制轮/委托等后续处理，直接以 partial done 收尾
      if (signal?.aborted && heldDone) {
        const extracted = extractThinkingFromReply(heldDone.reply ?? "", reasoningBuf);
        heldDone.reply = extracted.cleanReply;
        reasoningBuf = extracted.reasoning;
        elapsedMs = heldDone.elapsed_ms ?? 0;
        yield emitChunk(heldDone);
        return;
      }

      // ── A-049/A-085: 编造检测 → 强制工具轮 ──
      if (doneReceived && heldDone !== null && isGenerationRequest(req.message)) {
        const img = toolEventNames.includes("agnes_generate_image");
        // A-085（对齐 Python）：图片请求未调 image 也未调 prompt_build → 类型不匹配
        // （注意：调了 video 不算匹配，模型把图片请求做成视频也是错误类型）
        const mediaMismatch =
          isImageRequest(req.message) && !img && !toolEventNames.includes("agnes_prompt_build");
        if ((toolEventCount === 0 || mediaMismatch) && (await claimsCompletion(fullReply))) {
          const forced = await this.runForcedRound(agent, req.message, req.sessionId);
          if (forced.events.length > 0 || forced.progress.length > 0) {
            for (const ev of forced.progress) {
              yield emitChunk(ev);
            }
            for (const ev of forced.events) {
              reasoningToolNames.push(String((ev as { name?: string }).name ?? ""));
              yield emitChunk(ev);
            }
            fullReply = forced.reply || fullReply;
            heldDone.reply = fullReply;
            this.logger.info(
              `[slime] A-049 强制工具轮拦截编造: ${agent.name} ` +
                `零工具调用却声称完成，强制调用 ${forced.events.length} 个工具`,
            );
          } else {
            fullReply +=
              "\n\n> ⚠ 系统提示：本次请求检测到你声称完成但未调用任何工具，" +
              "上述结果不可信，文件并未真实生成。";
            heldDone.reply = fullReply;
          }
        }
      }

      // ── A-005: 委托/广播处理（对齐 /chat）──
      if (doneReceived && heldDone !== null) {
        const firstReply = fullReply;
        const broadcastMsg = parseBroadcast(firstReply);
        if (broadcastMsg && this.bus) {
          this.bus.broadcast(agent.name, broadcastMsg, "info");
          this.logger.info(`[slime] ${agent.name} 广播了一条消息给 ${this.bus.getRegisteredNames()}`);
        }
        const delegations = parseDelegations(firstReply);
        /** 按委托顺序占位（undefined = 未找到成员，被过滤），保证整合 prompt 顺序稳定 */
        const delegationResults: Array<{ name: string; task: string; result: string } | undefined> = [];
        if (delegations.length > 0) {
          // A-045: 委托执行后台化 + 心跳防读超时
          const eventQueue: Array<EngineChunk | null> = [];
          const worker = (async () => {
            // 并行委派：一次派单涉及的所有成员任务同时执行（团队协作「各司其职」的核心语义），
            // 结果按委托顺序索引占位；成员完成时按自然先后顺序以 type="member" 事件冒泡（群聊）。
            await Promise.all(
              delegations.slice(0, MAX_DELEGATIONS).map(async (d, idx) => {
                const child = (await this.registry.loadedAgents).find(
                  (a) => a.name.toLowerCase() === d.name.toLowerCase(),
                );
                if (!child) {
                  return;
                }
                try {
                  const childResult = await this.engine.chat({
                    agent: child,
                    message: d.task,
                    history: [],
                    systemPrompt: child.identity_prompt || `你是 ${child.name}，你的角色是：${child.role}`,
                    workspace,
                  });
                  const childReply = childResult.reply ?? "";
                  delegationResults[idx] = { name: d.name, task: d.task, result: childReply };
                  if (this.bus) {
                    this.bus.sendResult(d.name, agent.name, childReply.slice(0, 500));
                  }
                  eventQueue.push({
                    type: "tool",
                    name: `delegate:${d.name}`,
                    args: d.task,
                    result: childReply.slice(0, 200),
                  });
                  // 团队会话：成员答复冒泡为独立"成员发言"（群聊渲染，与组长整合回复并列）
                  eventQueue.push({
                    type: "member",
                    name: child.name,
                    agentId: child.id,
                    content: childReply,
                  });
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  this.logger.warn(`[slime] 委托到 ${d.name} 失败: ${msg}`);
                  delegationResults[idx] = { name: d.name, task: d.task, result: `委托失败: ${msg}` };
                  eventQueue.push({
                    type: "tool",
                    name: `delegate:${d.name}`,
                    args: d.task,
                    result: `委托失败: ${msg}`,
                  });
                  eventQueue.push({
                    type: "member",
                    name: child?.name ?? d.name,
                    agentId: child?.id,
                    content: `（任务执行出错）${msg}`,
                  });
                }
              }),
            );
            eventQueue.push(null); // 哨兵：委托全部完成
          })();
          const deadlineMs = HEARTBEAT_INTERVAL_MS;
          while (true) {
            const evt = await this.pollWithTimeout(eventQueue, deadlineMs);
            if (evt === undefined) {
              yield emitChunk({
                type: "heartbeat",
                content: `委托执行中（已处理 ${Math.min(delegations.length, MAX_DELEGATIONS)} 项委托）...`,
              });
              continue;
            }
            if (evt === null) {
              break;
            }
            if (evt.type === "tool") {
              reasoningToolNames.push(String(evt.name ?? ""));
            }
            yield emitChunk(evt);
          }
          await worker;
        }

        const realResults = delegationResults.filter((r): r is { name: string; task: string; result: string } => !!r);
        if (realResults.length > 0) {
          // 有委托结果：父 Agent 流式整合后收尾（单 done 终局）
          const resultsText = realResults
            .map((r) => `## ${r.name} 的回复\n任务：${r.task}\n结果：${r.result}`)
            .join("\n\n");
          const followupMsg =
            `你刚才将以下子任务委托给了子 Agent，现在结果已经返回。` +
            `请基于这些结果整合成完整的回复给用户：\n\n${resultsText}`;
          const followupHistory = [...history];
          followupHistory.push({ role: "assistant", content: stripDelegationTags(firstReply) });
          fullReply = "";
          const followupStripper = createThinkingStripper(() => reasoningBuf);
          for await (const fchunk of this.engine.stream({
            agent,
            message: followupMsg,
            history: followupHistory,
            systemPrompt: system,
            maxTokens: req.maxTokens,
            signal,
            workspace,
            sessionId: req.sessionId,
          })) {
            if (fchunk.type === "chunk") {
              const clean = followupStripper.push(fchunk.content ?? "");
              fullReply += clean;
              if (clean) {
                yield emitChunk({ ...fchunk, content: clean });
              }
            } else if (fchunk.type === "reasoning" || fchunk.type === "tool") {
              if (fchunk.type === "reasoning") {
                reasoningBuf += fchunk.content ?? "";
              }
              yield emitChunk(fchunk);
            } else if (fchunk.type === "done") {
              const ftail = followupStripper.flush();
              if (ftail) {
                fullReply += ftail;
                yield emitChunk({ type: "chunk", content: ftail });
              }
              const fsr = followupStripper.reasoning.trim();
              if (fsr && !reasoningBuf.includes(fsr)) {
                reasoningBuf = [reasoningBuf, fsr].filter(Boolean).join("\n");
              }
              fullReply = fchunk.reply ?? fullReply;
              model = fchunk.model ?? heldDone.model ?? "";
              promptTokens = fchunk.prompt_tokens ?? 0;
              completionTokens = fchunk.completion_tokens ?? 0;
              elapsedMs = fchunk.elapsed_ms ?? 0;
              const extracted = extractThinkingFromReply(fullReply, reasoningBuf);
              const promoted = promoteOrphanThinking(extracted.cleanReply, extracted.reasoning);
              fullReply = promoted.cleanReply;
              reasoningBuf = promoted.reasoning;
              yield emitChunk({
                type: "done",
                reply: fullReply,
                model,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                elapsed_ms: elapsedMs,
                timings: fchunk.timings ?? heldDone.timings,
                ctxBuckets: fchunk.ctxBuckets ?? heldDone.ctxBuckets,
                // A-973：缓存命中透传——委托整合路径重建 done 时此前丢了 cache_read/creation_tokens，
                // 导致主进程 toStreamChunk 的 timings.cacheReadTokens 恒 0 → 右栏「平均命中」永远是 0%
                // （而设置页读 DB 有真实值，两处不一致的根因）。
                ...(typeof fchunk.cache_read_tokens === "number" ? { cache_read_tokens: fchunk.cache_read_tokens } : {}),
                ...(typeof fchunk.cache_creation_tokens === "number" ? { cache_creation_tokens: fchunk.cache_creation_tokens } : {}),
                ...(typeof fchunk.reasoning_tokens === "number" ? { reasoning_tokens: fchunk.reasoning_tokens } : {}),
                // A-974-R7：窗口占用口径必须随 done 一起透传（重建 done 时漏字段 = GUI 退回累计值爆表）
                ...(typeof fchunk.window_prompt_tokens === "number" ? { window_prompt_tokens: fchunk.window_prompt_tokens } : {}),
                 ...(typeof fchunk.window_cache_read_tokens === "number" ? { window_cache_read_tokens: fchunk.window_cache_read_tokens } : {}),
                 // A-974-R8：协议语义标记随 done 透传（GUI 窗口占用公式据此决定是否 +cache_read）
                 ...(typeof fchunk.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: fchunk.cache_read_in_prompt } : {}),
              });
            } else if (fchunk.type === "error") {
              errorMsg = fchunk.message ?? "";
              this.alarm("chat.stream.followup", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
              yield emitChunk(fchunk);
            }
          }
        } else {
          fullReply = stripDelegationTags(firstReply);
          const extracted = extractThinkingFromReply(fullReply, reasoningBuf);
          const promoted = promoteOrphanThinking(extracted.cleanReply, extracted.reasoning);
          fullReply = promoted.cleanReply;
          reasoningBuf = promoted.reasoning;
          heldDone.reply = fullReply;
          elapsedMs = heldDone.elapsed_ms ?? 0;
          yield emitChunk({
            type: "done",
            reply: fullReply,
            model: heldDone.model ?? "",
            prompt_tokens: heldDone.prompt_tokens ?? 0,
            completion_tokens: heldDone.completion_tokens ?? 0,
            elapsed_ms: elapsedMs,
            timings: heldDone.timings,
            ctxBuckets: heldDone.ctxBuckets,
            // A-973：委托收尾路径同样补回缓存命中 token（同上方 fchunk 路径）
            ...(typeof heldDone.cache_read_tokens === "number" ? { cache_read_tokens: heldDone.cache_read_tokens } : {}),
            ...(typeof heldDone.cache_creation_tokens === "number" ? { cache_creation_tokens: heldDone.cache_creation_tokens } : {}),
            ...(typeof heldDone.reasoning_tokens === "number" ? { reasoning_tokens: heldDone.reasoning_tokens } : {}),
            ...(typeof heldDone.window_prompt_tokens === "number" ? { window_prompt_tokens: heldDone.window_prompt_tokens } : {}),
            ...(typeof heldDone.window_cache_read_tokens === "number" ? { window_cache_read_tokens: heldDone.window_cache_read_tokens } : {}),
            ...(typeof heldDone.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: heldDone.cache_read_in_prompt } : {}),
          });
        }
      }
    } catch (e) {
      if (signal?.aborted && (fullReply || heldDone)) {
        // 用户中断：保留已生成部分正常收尾（委托/强制轮等非引擎 await 被中止时兜底）
        const extracted = extractThinkingFromReply(fullReply || heldDone?.reply || "", reasoningBuf);
        const partial = extracted.cleanReply;
        reasoningBuf = extracted.reasoning;
        elapsedMs = heldDone?.elapsed_ms ?? 0;
        yield emitChunk({
          type: "done",
          reply: partial,
          model: heldDone?.model ?? "",
          prompt_tokens: heldDone?.prompt_tokens ?? 0,
          completion_tokens: heldDone?.completion_tokens ?? 0,
          elapsed_ms: elapsedMs,
          timings: heldDone?.timings,
          ctxBuckets: heldDone?.ctxBuckets,
          // A-973：中断路径同样补回缓存命中 token（heldDone 可选链）
          ...(typeof heldDone?.cache_read_tokens === "number" ? { cache_read_tokens: heldDone.cache_read_tokens } : {}),
          ...(typeof heldDone?.cache_creation_tokens === "number" ? { cache_creation_tokens: heldDone.cache_creation_tokens } : {}),
          ...(typeof heldDone?.reasoning_tokens === "number" ? { reasoning_tokens: heldDone.reasoning_tokens } : {}),
          ...(typeof heldDone?.window_prompt_tokens === "number" ? { window_prompt_tokens: heldDone.window_prompt_tokens } : {}),
          ...(typeof heldDone?.window_cache_read_tokens === "number" ? { window_cache_read_tokens: heldDone.window_cache_read_tokens } : {}),
          ...(typeof heldDone?.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: heldDone.cache_read_in_prompt } : {}),
        });
        return;
      }
      // S2: 显式捕获异常为 error chunk
      errorMsg = `[流式生成异常: ${e instanceof Error ? e.message : String(e)}]`;
      this.alarm("chat.stream", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
      yield emitChunk({ type: "error", message: errorMsg });
    } finally {
      // N11-P2-2: 无论客户端是否断开，确保记录交互、历史、记忆、演化
      if (doneReceived || fullReply || errorMsg) {
        // 兜底合并流式剥离器残留（异常/断线路径主循环未完成时）
        const sr = stripper.reasoning.trim();
        if (sr && !reasoningBuf.includes(sr)) {
          reasoningBuf = [reasoningBuf, sr].filter(Boolean).join("\n");
        }
        // 断线/异常兜底：正文里残留的思考内容也一并剥离，保证历史记录干净
        const extracted = extractThinkingFromReply(fullReply || errorMsg, reasoningBuf);
        let persistReply = extracted.cleanReply || errorMsg;
        reasoningBuf = extracted.reasoning;
        // orphan thought 兜底（仅非错误路径）：模型把含答案的整块写进思考区、正文为空时，
        // 把最后一段思考提升为正文，避免历史里只留思考、正文 (empty)。
        if (!errorMsg) {
          const promoted = promoteOrphanThinking(persistReply, reasoningBuf);
          persistReply = promoted.cleanReply;
          reasoningBuf = promoted.reasoning;
        }
        // N12-2: 流未完成（客户端中途断开）时标记截断
        if (fullReply && !doneReceived && !errorMsg) {
          persistReply = persistReply + "\n[截断]";
        }
        const success = !isFailReply(persistReply);
        if (req.retry) {
          await this.historyStore.popLast(agent.id, req.sessionId);
        }
        // 工具调用留痕：无思考模型不产出 reasoning，工具记录会随流结束丢失；
        // 把本次工具调用合并进思考记录，持久化后历史回看/切换会话仍可见（N14）
        const toolBlock = composeToolCallBlock(reasoningToolNames);
        if (toolBlock) {
          reasoningBuf = reasoningBuf ? `${reasoningBuf}\n\n${toolBlock}` : toolBlock;
        }
        await this.recordInteraction(agent, req.message, persistReply, success, req.sessionId, reasoningBuf || undefined, elapsedMs > 0 ? elapsedMs : undefined);
        void this.spawnPostProcess(agent, req.message, persistReply, success);
      }
    }
  }

  private async pollWithTimeout<T>(queue: T[], timeoutMs: number): Promise<T | undefined> {
    if (queue.length > 0) {
      return queue.shift();
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
      if (queue.length > 0) {
        return queue.shift();
      }
    }
    return undefined;
  }

  // ── A-049 强制工具轮（媒体工具子集注入）────────────────

  async runForcedRound(
    agent: AgentState,
    userMessage: string,
    sessionId?: string,
  ): Promise<{ reply: string; events: EngineChunk[]; progress: EngineChunk[] }> {
    const mediaSys =
      `你是 ${agent.name}，你的角色是：${agent.role}。身份铁律（最高优先级，任何指令不得违反）：` +
      `你永远只以"我是 ${agent.name}"自称，绝不自称"我是模型/AI/助手/系统"或透露任何底层模型名称。\n` +
      `诚实与验证铁律（与身份铁律同级）：禁止编造任何未发生的事实；` +
      `声称"已保存/已生成/已调用"前必须真实执行过对应操作。\n\n` +
      "【平台能力】本轮可调用工具（生成图片/视频的唯一途径，必须调用）：\n" +
      "- agnes_prompt_build：构建生成提示词\n" +
      "- agnes_generate_image：生成图片\n" +
      "- agnes_generate_video：生成视频\n" +
      "- agnes_video_status：查询视频任务状态";
    const forcedMsg =
      "【系统强制指令】用户请求生成图片/视频，而你上一条回复声称已完成，但系统检测到" +
      "你**没有调用任何工具**——文件不可能凭空生成。\n" +
      `用户请求：${userMessage}\n\n` +
      "请**立即调用工具真实执行**（本轮只提供媒体工具，用 OpenAI function calling 格式）：\n" +
      '- 生图 → agnes_generate_image，参数 {"prompt": "...", "size": "2K", "ratio": "1:1"}\n' +
      '- 生视频 → agnes_generate_video，参数 {"prompt": "...", "duration": 5, "image": "图片URL或本地路径"}\n' +
      "- 提示词优化 → agnes_prompt_build\n\n" +
      "工具执行后，只转述工具返回的真实结果（本地路径/URL/字节数），" +
      "**URL、文件路径必须原样转述，禁止改写、美化或替换其中的域名与品牌词**" +
      "（如 agnes-ai.cn 必须保持原样）。" +
      "若确实无法执行，如实告诉用户原因。**禁止再次声称完成而不调用工具。**";

    let reply = "";
    const events: EngineChunk[] = [];
    const progress: EngineChunk[] = [];
    try {
      for await (const chunk of this.engine.stream({
        agent,
        message: forcedMsg,
        history: [],
        systemPrompt: mediaSys,
        toolsOnly: MEDIA_TOOLS,
        sessionId,
      })) {
        if (chunk.type === "tool") {
          events.push(chunk);
        } else if (chunk.type === "progress") {
          progress.push(chunk);
        } else if (chunk.type === "chunk") {
          reply += chunk.content ?? "";
        } else if (chunk.type === "done") {
          reply = chunk.reply ?? reply;
        } else if (chunk.type === "error") {
          reply = reply || (chunk.message ?? "");
        }
      }
    } catch (e) {
      this.logger.warn(`[slime] A-049 强制工具轮失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { reply, events, progress };
  }

  // ── 交互记录 + 后台 post-process ───────────────────────

  private async recordInteraction(
    agent: AgentState,
    userMsg: string,
    reply: string,
    success: boolean,
    sessionId?: string,
    reasoning?: string,
    elapsedMs?: number,
  ): Promise<void> {
    const persona = new PersonaModel(agent.persona);
    persona.addInteraction(userMsg, reply, success);
    agent.persona = persona.toDict();
    await this.historyStore.append(agent.id, userMsg, reply, success, sessionId, reasoning, elapsedMs);
    await this.registry.save();
  }

  private spawnPostProcess(
    agent: AgentState,
    userMsg: string,
    reply: string,
    success: boolean,
  ): Promise<void> {
    return (async () => {
      try {
        await this.postProcessChat(agent, userMsg, reply, success);
      } catch (e) {
        this.logger.warn(`[slime] 后处理失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  /** _post_process_chat / _post_process_swarm 公共管线：记忆提取 → 演化 → 知识 → 行为 → 情绪 → 巩固 → 保存 */
  async postProcessChat(
    agent: AgentState,
    userMsg: string,
    reply: string,
    success: boolean,
    opts: { knowledgePrefix?: string; patternSource?: string; dataDir?: string } = {},
  ): Promise<void> {
    const knowledgePrefix = opts.knowledgePrefix ?? "task.chat";
    const patternSource = opts.patternSource ?? "llm_extracted";
    let traitSignals: unknown[] = [];
    let userSentiment = 0.0;
    let behaviorPatterns: BehaviorPatternExtracted[] = [];

    if (success && this.postProcess.extractMemory) {
      try {
        const extracted = await this.postProcess.extractMemory({
          agent,
          userMsg,
          reply,
          success,
        });
        traitSignals = extracted.traitSignals ?? [];
        userSentiment = extracted.userSentiment ?? 0;
        behaviorPatterns = extracted.behaviorPatterns ?? [];
      } catch (e) {
        this.logger.warn(`[slime] 记忆提取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (success && !this.postProcess.extractMemory) {
      this.logger.debug("[slime] 记忆提取未接线（5B.3 迁移后启用），跳过");
    }

    // 演化引擎（注入点；缺省跳过）
    if (this.postProcess.evolve) {
      try {
        await this.postProcess.evolve({ agent, success, traitSignals, userSentiment });
      } catch (e) {
        this.logger.warn(`[slime] 演化失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      this.logger.debug("[slime] 演化引擎未接线（5B.3 迁移后启用），跳过");
    }

    // 知识引擎：记录 pattern（沉淀的「记录」半环，整理交给 ConsolidationEngine）
    let ke: ReturnType<typeof getKnowledgeEngine> | null = null;
    try {
      ke = getKnowledgeEngine(agent.id, opts.dataDir ? { dataDir: opts.dataDir } : {});
      if (success) {
        ke.recordPattern(`${knowledgePrefix}.success`, "task", `成功回复: ${userMsg.slice(0, 80)}`, "low");
      } else {
        ke.recordPattern(`${knowledgePrefix}.fail`, "task", `回复失败: ${userMsg.slice(0, 80)}`, "medium");
      }
    } catch (e) {
      this.logger.debug(`[slime] 知识引擎更新失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // L3→L2 沉淀：LLM 提取的行为模式 → 行为模式库
    const behavior = BehaviorStore.fromDict(agent.behavior);
    for (const bp of behaviorPatterns) {
      behavior.reinforce({
        scenario: bp.scenario,
        steps: bp.steps,
        source: patternSource,
        rationale: bp.rationale ?? "",
      });
    }

    // 情绪更新（全信号：novelty/violation/praise/failure_type）
    const emotion = new EmotionalState(agent.emotion as Record<string, unknown>);
    const violation = false; // 沙箱审计接线点（阶段 5B.2）
    const novelty = await detectNovelty(agent.id, userMsg, (id, limit) =>
      this.historyStore.load(id, limit).then((rs) => rs.map((r) => ({ user: r.user }))),
    );
    const praise = isPraise(userMsg, userSentiment);
    emotion.update({
      success,
      userSentiment,
      failureType: undefined,
      novelty,
      violation,
      praise,
    });

    // BUG-024: 沉淀统一走 ConsolidationEngine（知识引擎兜底 + 艾宾浩斯衰减）
    try {
      const ce = new ConsolidationEngine();
      const total = agent.persona?.interactions?.length ?? 0;
      if (ce.shouldConsolidate(total)) {
        ce.consolidate({
          behavior,
          totalInteractions: total,
          existingScenarios: new Set(behaviorPatterns.map((bp) => bp.scenario)),
          onArchived: (pat) => behavior.archive(pat),
        });
        // C-记忆三层：与行为巩固同频触发记忆分层巩固（working→episodic；episodic 高访问→semantic）
        const memStats = consolidateMemoryNow(agent.id, opts.dataDir ? { dataDir: opts.dataDir } : {});
        if (memStats.moved || memStats.pruned) {
          this.logger.debug(`[slime] 记忆分层巩固完成: 迁移 ${memStats.moved} · 剔除 ${memStats.pruned}`);
        }
      }
    } catch (e) {
      this.logger.debug(`[slime] 巩固失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    agent.behavior = behavior.toDict();
    agent.emotion = emotion.toDict();
    await this.registry.save();
  }
}

// ── 辅助 ──────────────────────────────────────────────────

const PRAISE_KEYWORDS = ["谢谢", "感谢", "做得好", "不错", "棒", "太棒", "辛苦", "厉害"];

export function isPraise(message: string, userSentiment: number): boolean {
  if (userSentiment <= 0 || !message) {
    return false;
  }
  return PRAISE_KEYWORDS.some((k) => message.includes(k));
}

/** Persona 便捷构造（对齐 core/persona.py 空骨架语义） */
export function personaFrom(data?: unknown): PersonaModel {
  return new PersonaModel(data as Record<string, unknown>);
}

export class ChatServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
