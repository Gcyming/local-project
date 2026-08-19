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
  fileHistoryStore,
  HistoryStore,
} from "./history.js";
import { detectNovelty } from "./novelty.js";
import { EmotionalState } from "../mind/emotion.js";
import { BehaviorStore, ConsolidationEngine } from "../mind/behavior.js";
import { getKnowledgeEngine } from "../memory/knowledge.js";
import { EventSequence, ServiceEvent } from "./events.js";
import { AlarmBus, getAlarmBus, AlarmSeverity } from "./stats.js";

// ── 常量（对齐 slime_server.py）────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STREAM_MAX_CHARS = 10 * 1024 * 1024;
export const MAX_DELEGATIONS = 3;

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
}

/** 引擎事件块（对齐 Python call_llm_stream chunk 协议） */
export interface EngineChunk {
  type: "chunk" | "tool" | "reasoning" | "progress" | "done" | "error" | "heartbeat";
  content?: string;
  name?: string;
  args?: string;
  result?: string;
  message?: string;
  reply?: string;
  reply_raw?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  elapsed_ms?: number;
  tools_only?: string[];
  /** v2.8 可观测性：全链路耗时（路由→检索→推理→工具轮），done 事件必带 */
  timings?: Record<string, number>;
}

export interface ChatEngineResult {
  reply: string;
  replyRaw?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  elapsedMs?: number;
  timings?: Record<string, number>;
}

export interface ChatEngineCall {
  agent: AgentState;
  message: string;
  history: ChatMessage[];
  systemPrompt: string;
  maxTokens?: number;
  toolsOnly?: string[];
  onChunk?: (delta: string) => void;
}

export interface ChatEngine {
  chat(opts: ChatEngineCall): Promise<ChatEngineResult>;
  stream(opts: ChatEngineCall): AsyncIterable<EngineChunk>;
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
    const allNames = await this.registry.names();
    let sys = agent.identity_prompt || `你是 ${agent.name}，你的角色是：${agent.role}`;
    const delegation = buildDelegationContext(children, allNames);
    if (delegation) {
      sys += "\n\n" + delegation;
    }
    return sys;
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
    const effective = await this.effectiveMessage(agent, req.message);
    const history = [...(req.history ?? [])];

    let result = await this.engine.chat({
      agent,
      message: effective,
      history,
      systemPrompt,
      maxTokens: req.maxTokens,
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
          systemPrompt,
          maxTokens: req.maxTokens,
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

    // A-087: 失败前缀黑名单（API 失败不驱动人格正反馈）
    const success = !isFailReply(reply);

    // A-090: 存储/学习用原文（reply_raw），品牌过滤只作用于展示
    const rawReply = result.replyRaw ?? reply;

    if (req.retry) {
      await this.historyStore.popLast(agent.id, req.sessionId);
    }
    await this.recordInteraction(agent, req.message, rawReply, success, req.sessionId);

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
  async *stream(agentId: string, req: ChatRequest, resumeSeq = 0): AsyncGenerator<ServiceEvent<unknown>> {
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

    const systemPrompt = await this.systemPromptFor(agent);
    const effective = await this.effectiveMessage(agent, req.message);
    const history = [...(req.history ?? [])];

    let fullReply = "";
    let errorMsg = "";
    let doneReceived = false;
    let heldDone: EngineChunk | null = null;
    let toolEventCount = 0;
    const toolEventNames: string[] = [];
    let model = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let elapsedMs = 0;

    const emitChunk = (chunk: EngineChunk): ServiceEvent<unknown> => {
      const ev = session.emit(chunk.type, chunk as unknown as Record<string, unknown>);
      this.emit(ev);
      return ev;
    };

    try {
      for await (const chunk of this.engine.stream({
        agent,
        message: effective,
        history,
        systemPrompt,
        maxTokens: req.maxTokens,
      })) {
        if (chunk.type === "chunk") {
          fullReply += chunk.content ?? "";
          if (fullReply.length > STREAM_MAX_CHARS) {
            yield emitChunk({ type: "error", message: "响应超限已截断（>10MB）" });
            return;
          }
          yield emitChunk(chunk);
        } else if (chunk.type === "tool") {
          toolEventCount += 1;
          toolEventNames.push(String(chunk.name ?? ""));
          yield emitChunk(chunk);
        } else if (chunk.type === "reasoning" || chunk.type === "progress") {
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

      // ── A-049/A-085: 编造检测 → 强制工具轮 ──
      if (doneReceived && heldDone !== null && isGenerationRequest(req.message)) {
        const img = toolEventNames.includes("agnes_generate_image");
        // A-085（对齐 Python）：图片请求未调 image 也未调 prompt_build → 类型不匹配
        // （注意：调了 video 不算匹配，模型把图片请求做成视频也是错误类型）
        const mediaMismatch =
          isImageRequest(req.message) && !img && !toolEventNames.includes("agnes_prompt_build");
        if ((toolEventCount === 0 || mediaMismatch) && (await claimsCompletion(fullReply))) {
          const forced = await this.runForcedRound(agent, req.message);
          if (forced.events.length > 0 || forced.progress.length > 0) {
            for (const ev of forced.progress) {
              yield emitChunk(ev);
            }
            for (const ev of forced.events) {
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
        const delegationResults: Array<{ name: string; task: string; result: string }> = [];
        if (delegations.length > 0) {
          // A-045: 委托执行后台化 + 心跳防读超时
          const eventQueue: Array<EngineChunk | null> = [];
          const worker = (async () => {
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
                });
                const childReply = childResult.reply ?? "";
                delegationResults.push({ name: d.name, task: d.task, result: childReply });
                if (this.bus) {
                  this.bus.sendResult(d.name, agent.name, childReply.slice(0, 500));
                }
                eventQueue.push({
                  type: "tool",
                  name: `delegate:${d.name}`,
                  args: d.task,
                  result: childReply.slice(0, 200),
                });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.logger.warn(`[slime] 委托到 ${d.name} 失败: ${msg}`);
                delegationResults.push({ name: d.name, task: d.task, result: `委托失败: ${msg}` });
                eventQueue.push({
                  type: "tool",
                  name: `delegate:${d.name}`,
                  args: d.task,
                  result: `委托失败: ${msg}`,
                });
              }
            }
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
            yield emitChunk(evt);
          }
          await worker;
        }

        if (delegationResults.length > 0) {
          // 有委托结果：父 Agent 流式整合后收尾（单 done 终局）
          const resultsText = delegationResults
            .map((r) => `## ${r.name} 的回复\n任务：${r.task}\n结果：${r.result}`)
            .join("\n\n");
          const followupMsg =
            `你刚才将以下子任务委托给了子 Agent，现在结果已经返回。` +
            `请基于这些结果整合成完整的回复给用户：\n\n${resultsText}`;
          const followupHistory = [...history];
          followupHistory.push({ role: "assistant", content: stripDelegationTags(firstReply) });
          fullReply = "";
          for await (const fchunk of this.engine.stream({
            agent,
            message: followupMsg,
            history: followupHistory,
            systemPrompt,
            maxTokens: req.maxTokens,
          })) {
            if (fchunk.type === "chunk") {
              fullReply += fchunk.content ?? "";
              yield emitChunk(fchunk);
            } else if (fchunk.type === "reasoning" || fchunk.type === "tool") {
              yield emitChunk(fchunk);
            } else if (fchunk.type === "done") {
              fullReply = fchunk.reply ?? fullReply;
              model = fchunk.model ?? heldDone.model ?? "";
              promptTokens = fchunk.prompt_tokens ?? 0;
              completionTokens = fchunk.completion_tokens ?? 0;
              elapsedMs = fchunk.elapsed_ms ?? 0;
              yield emitChunk({
                type: "done",
                reply: fullReply,
                model,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                elapsed_ms: elapsedMs,
                timings: fchunk.timings ?? heldDone.timings,
              });
            } else if (fchunk.type === "error") {
              errorMsg = fchunk.message ?? "";
              this.alarm("chat.stream.followup", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
              yield emitChunk(fchunk);
            }
          }
        } else {
          fullReply = stripDelegationTags(firstReply);
          heldDone.reply = fullReply;
          yield emitChunk({
            type: "done",
            reply: fullReply,
            model: heldDone.model ?? "",
            prompt_tokens: heldDone.prompt_tokens ?? 0,
            completion_tokens: heldDone.completion_tokens ?? 0,
            elapsed_ms: heldDone.elapsed_ms ?? 0,
            timings: heldDone.timings,
          });
        }
      }
    } catch (e) {
      // S2: 显式捕获异常为 error chunk
      errorMsg = `[流式生成异常: ${e instanceof Error ? e.message : String(e)}]`;
      this.alarm("chat.stream", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
      yield emitChunk({ type: "error", message: errorMsg });
    } finally {
      // N11-P2-2: 无论客户端是否断开，确保记录交互、历史、记忆、演化
      if (doneReceived || fullReply || errorMsg) {
        let persistReply = fullReply || errorMsg;
        // N12-2: 流未完成（客户端中途断开）时标记截断
        if (fullReply && !doneReceived && !errorMsg) {
          persistReply = fullReply + "\n[截断]";
        }
        const success = !isFailReply(persistReply);
        if (req.retry) {
          await this.historyStore.popLast(agent.id, req.sessionId);
        }
        await this.recordInteraction(agent, req.message, persistReply, success, req.sessionId);
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
  ): Promise<void> {
    const persona = new PersonaModel(agent.persona);
    persona.addInteraction(userMsg, reply, success);
    agent.persona = persona.toDict();
    await this.historyStore.append(agent.id, userMsg, reply, success, sessionId);
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
