











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

import { DIFF_TAG_RE } from "../tool_loop.js";

import { DELEGATION_GUIDANCE } from "./subagentCatalog.js";

import { sidebarMountSection } from "../sidebarMount.js";

import { DIFF_TRIMMED_MARKER as DIFF_TRIMMED_TAG } from "../diff_marker.js";



export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STREAM_MAX_CHARS = 10 * 1024 * 1024;
export const MAX_DELEGATIONS = 3;















function positiveEnvNumber(key: string, fallback: number): number {
  const env = typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const DEFAULT_TOOL_WALL_CLOCK_MS = positiveEnvNumber("SLIME_MAX_WALL_CLOCK_MS", 3 * 60 * 60 * 1000);
export const DEFAULT_TOOL_MAX_TOTAL_TOKENS = positiveEnvNumber("SLIME_MAX_TOTAL_TOKENS", 12_000_000);


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















const TRACE_DIFF_MAX = 60_000;





export function diffTagForTrace(result: unknown): string | undefined {
  if (typeof result !== "string") { return undefined; }
  const m = DIFF_TAG_RE.exec(result);
  if (!m) { return undefined; }
  const tag = m[0];
  
  if (tag.length > TRACE_DIFF_MAX * 1.4) { return DIFF_TRIMMED_TAG; }
  return tag;
}






export function composeToolCallBlock(toolNames: string[], diffTags?: Array<string | undefined>): string {
  if (toolNames.length === 0) { return ""; }
  const lines = toolNames.map((n, i) => {
    const tag = diffTags?.[i];
    return `- ⟳ ${toolDisplayName(n)}${tag ? ` ${tag}` : ""}`;
  });
  return `### 工具调用记录\n${lines.join("\n")}`;
}


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



export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  retry?: boolean;
  maxTokens?: number;
  
  sessionId?: string;
  








  modelChoice?: string;
  
  networkEnabled?: boolean;
  
  images?: string[];
  
  resumeHint?: string;
  






  windowCap?: number;
}


export interface EngineChunk {
  type: "chunk" | "tool" | "tool-start" | "reasoning" | "progress" | "done" | "error" | "heartbeat" | "member" | "steer" | "notice";
  content?: string;
  name?: string;
  


  toolId?: string;
  




  steerId?: string;
  
  agentId?: string;
  args?: string;
  result?: string;
  message?: string;
  reply?: string;
  reply_raw?: string;
  
  reasoning?: string | null;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  

  reasoning_tokens?: number;
  



  window_prompt_tokens?: number;
  window_cache_read_tokens?: number;
  window_cache_creation_tokens?: number;
  



  cache_read_in_prompt?: boolean;
  elapsed_ms?: number;
  tools_only?: string[];
  
  timings?: Record<string, number>;
  
  ctxBuckets?: ContextBuckets;
}

export interface ChatEngineResult {
  reply: string;
  replyRaw?: string;
  
  reasoning?: string | null;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  elapsedMs?: number;
  timings?: Record<string, number>;
  
  ctxBuckets?: ContextBuckets;
}






export interface ContextBuckets {
  
  system: number;
  
  rules: number;
  
  memory: number;
  
  workspace: number;
  
  planning: number;
  
  tools: number;
  
  history: number;
  
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
  
  signal?: AbortSignal;
  
  networkEnabled?: boolean;
  
  workspace?: string;
  
  sessionId?: string;
  
  images?: string[];
  
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
  



  windowCap?: number;
}

export interface ChatEngine {
  chat(opts: ChatEngineCall): Promise<ChatEngineResult>;
  stream(opts: ChatEngineCall): AsyncIterable<EngineChunk>;
  
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


export type EvidenceInjector = (message: string) => Promise<string> | string;

export interface ChatServiceOptions {
  registry: AgentRegistry;
  engine: ChatEngine;
  bus?: ServerA2ABus;
  postProcess?: PostProcessHooks;
  evidence?: EvidenceInjector;
  
  emit?: (ev: ServiceEvent<unknown>) => void;
  
  alarms?: AlarmBus;
  
  history?: HistoryStore;
  logger?: Pick<Console, "warn" | "info" | "debug">;
  






  dataDir?: string;
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


export function isGenerationRequest(message: string): boolean {
  if (!message) {
    return false;
  }
  return (
    GEN_REQ_HINTS.some((h) => message.includes(h)) &&
    GEN_TARGET_HINTS.some((h) => message.toLowerCase().includes(h))
  );
}


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


export function isFailReply(reply: string): boolean {
  return FAIL_REPLY_PREFIXES.some((p) => reply.includes(p));
}


const THINK_TAG_PAIRS: ReadonlyArray<{ open: string; close: string }> = [
  { open: "<thinking", close: "</thinking>" },
  { open: "<reasoning", close: "</reasoning>" },
  { open: "<thought", close: "</thought>" },
  { open: "<reason", close: "</reason>" },
  { open: "<|begin_of_thought|>", close: "<|end_of_thought|>" },
];





const DS_START = " thinking";
const DS_END = " response";

export function stripToolCallXml(text: string): { clean: string; toolCalls: string } {
  if (!text) {
    return { clean: text, toolCalls: "" };
  }
  const parts: string[] = [];
  
  let clean = text.replace(/<[a-z0-9_]*function_call[\s\S]*?<\/[a-z0-9_]*function_call\s*>/gi, (m) => {
    parts.push(m.trim());
    return "";
  });
  
  clean = clean.replace(/<invoke\b[\s\S]*?<\/invoke\s*>/gi, (m) => {
    parts.push(m.trim());
    return "";
  });
  
  clean = clean.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter\s*>|<parameter\b[^>]*\/>/gi, (m) => {
    parts.push(m.trim());
    return "";
  });
  
  clean = clean.replace(/<(ignore|result|output|tool)\b[^>]*>\s*<\/\1\s*>/gi, "");
  return { clean, toolCalls: parts.join("\n") };
}








export function extractThinkingFromReply(
  reply: string,
  existingReasoning = "",
): { cleanReply: string; reasoning: string } {
  if (!reply) {
    return { cleanReply: reply, reasoning: existingReasoning };
  }
  let clean = reply;
  let reasoning = existingReasoning;

  
  const tagParts: string[] = [];
  clean = clean.replace(/<(thinking|thought|reasoning|reason)>[\s\S]*?<\/(thinking|thought|reasoning|reason)>/gi, (m) => {
    tagParts.push(m.replace(/<\/?(thinking|thought|reasoning|reason)>/gi, "").trim());
    return "";
  });
  clean = clean.replace(/\|<begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, (m) => {
    tagParts.push(m.replace(/\|<begin_of_thought\|>|<\|end_of_thought\|>/gi, "").trim());
    return "";
  });

  
  
  const dsRe = /(^|[\s])thinking\s+([\s\S]*?)(\n\s*response\b)/i;
  let change = true;
  let guard = 0;
  while (change && guard++ < 10) {
    change = false;
    const dm = clean.match(dsRe);
    if (dm && dm.index !== undefined) {
      const prefix = dm[1] || ""; 
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

  
  
  const tc = stripToolCallXml(clean);
  clean = tc.clean;
  if (tc.toolCalls) {
    reasoning = [reasoning, tc.toolCalls].filter(Boolean).join("\n");
  }

  
  const rt = reasoning.trim();
  let trimmed = clean.trimStart();
  while (rt && trimmed.startsWith(rt) && trimmed.length > rt.length) {
    trimmed = trimmed.slice(rt.length).trimStart();
  }
  clean = trimmed;

  
  
  const tokenStrip = stripTokenByTokenThinking(clean, reasoning);
  if (tokenStrip.cleanReply !== clean) {
    return { cleanReply: tokenStrip.cleanReply, reasoning: tokenStrip.reasoning.trim() };
  }

  
  const untagged = splitUntaggedThinking(clean, reasoning);
  return { cleanReply: untagged.cleanReply, reasoning: untagged.reasoning.trim() };
}




function stripTokenByTokenThinking(reply: string, existingReasoning = ""): { cleanReply: string; reasoning: string } {
  if (!reply) { return { cleanReply: reply, reasoning: existingReasoning }; }
  const lines = reply.split("\n");
  
  const scanLimit = Math.min(lines.length, 40);
  let shortLineCount = 0;
  let totalNonEmpty = 0;
  for (let i = 0; i < scanLimit; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    totalNonEmpty++;
    if (trimmed.length <= 3) shortLineCount++;
  }
  
  if (totalNonEmpty >= 8 && shortLineCount / totalNonEmpty >= 0.7) {
    
    let thinkingEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.length <= 3) {
        thinkingEnd += lines[i].length + 1; 
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
    
    return { cleanReply: "", reasoning: [existingReasoning, reply.trim()].filter(Boolean).join("\n") };
  }
  return { cleanReply: reply, reasoning: existingReasoning };
}





export function promoteOrphanThinking(
  cleanReply: string,
  reasoning: string,
): { cleanReply: string; reasoning: string } {
  if (cleanReply.trim()) {
    return { cleanReply, reasoning }; 
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






















const MIN_EMPTY_REST_CHARS = 60;



const UNTAGGED_SCAN_LIMIT = 60;
export function splitUntaggedThinking(
  reply: string,
  existingReasoning = "",
): { cleanReply: string; reasoning: string } {
  if (!reply) {
    return { cleanReply: reply, reasoning: existingReasoning };
  }
  const lines = reply.split("\n");

  
  const strongRe =
    /身份设定|角色设定|我的身份|保持角色|用中文\s*(回应|回答|回复|沟通)|作为[^，。\n]{0,8}(我|助手|agent)|保持[^，。\n]{0,6}(自然|平静|专业|均衡|情绪)|当前[^，。\n]{0,4}(情绪|状态)|我[^，。\n]{0,6}\b(回应|回复|回答)用户/ig;
  
  
  
  const weakRe =
    /用户\s*(发送了|说|问|询问|提到|要求|让我|叫我|给|上报|讲述了)|用户[^，。\n]{0,6}(说|问|发|提|要|想|给|夸|称|表示|认为|觉得|称赞|赞美|夸奖|只是|还|终于)|我\s*(需要|应该|将|打算|必须|看到|已经|分析|检测|列出|读取|查看|检查|介绍|说明|概述|总结|给出|提供|梳理|整理|研究|了解|根据|翻一下|找一下|查一下|得先)|根据(我的|系统提示)|让我\s*(先|开始|列出|阅读|查看|分析|检查|了解|确认|概述)|(我先|首先)\s*(列表|阅读|查看|分析|检查|了解|确认|概述)/ig;
  
  const bodyStartRe =
    /^(哈哈|你好|您好|好的|当然|没问题|谢谢|抱歉|可以|好嘞|明白了|收到|好的呀|好的呢|嗯嗯|好的吧|没毛病|没问题|来啦|在的|你好呀)/;

  let thinkingEnd = -1; 
  let weight = 0;
  let prevHadFeature = false; 
  let anchorStart = -1; 
  let naturalBreak = false; 

  
  
  for (let i = 0; i < lines.length && i < (weight >= 3 ? UNTAGGED_SCAN_LIMIT : 8); i++) {
    const line = lines[i].trim();
    if (!line) {
      
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
      
      
      
      const anchor = findBodyAnchor(line, strongRe, weakRe);
      if (anchor >= 0) {
        anchorStart = computeLineStart(lines, i) + anchor;
      }
      continue;
    }
    
    if (isList && (prevHadFeature || weight > 0)) {
      thinkingEnd = computeLineEnd(lines, i);
      continue;
    }
    
    if (weight > 0) {
      
      if (/[:：]\s*$/.test(line)) {
        
        if (strongBodyStartRe.test(line) && weight >= 3) {
          naturalBreak = true;
          break;
        }
        thinkingEnd = computeLineEnd(lines, i);
        continue;
      }
      
      
      if (bodyStartRe.test(line) || (strongBodyStartRe.test(line) && weight >= 3)) {
        naturalBreak = true;
        break;
      }
      
      thinkingEnd = computeLineEnd(lines, i);
      continue;
    }
    
    break;
  }

  
  
  
  const endIdx = naturalBreak ? thinkingEnd : (anchorStart >= 0 ? anchorStart : thinkingEnd);
  
  const canCut = (naturalBreak && weight >= 2) || weight >= 3;
  if (canCut && endIdx > 0 && endIdx <= reply.length) {
    const thinkingText = reply.slice(0, endIdx).trim();
    const rest = reply.slice(endIdx).trim();
    
    
    
    
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


function computeLineStart(lines: string[], i: number): number {
  let s = 0;
  for (let k = 0; k < i; k++) {
    s += lines[k].length + 1; 
  }
  return s;
}

function computeLineEnd(lines: string[], i: number): number {
  return computeLineStart(lines, i) + lines[i].length;
}



function isAnchorInWord(pre: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/.test(pre);
}




const strongBodyStartRe =
  /^(以下是|总结是|答案是|先说|下面|综上所述|综上|简单说|简单来说|总之|答案|结果|让我来|接下来|我来给|我来说|我来分享|让我分享|让我直接)/;






function findBodyAnchor(line: string, strongRe: RegExp, weakRe: RegExp): number {
  
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
  
  const tail = line.slice(lastEnd);
  const anchorWords = ["你好", "您好", "好的", "当然", "所以", "因此", "那么", "总之", "总结是", "以下是", "先说", "下面", "答案", "结果"];
  const leftQuotes = new Set(['"', "'", "「", "『", "(", "（", "`", "<", "《", "【", "[", "{"]);
  const anchorIndexes: Array<{ pos: number; word: string }> = [];
  for (const word of anchorWords) {
    let from = 0;
    while (from < tail.length) {
      const p = tail.indexOf(word, from);
      if (p < 0) break;
      
      const preChar = p > 0 ? tail.charAt(p - 1) : "";
      const inQuote = preChar && leftQuotes.has(preChar);
      
      const inWord = p > 0 && isAnchorInWord(preChar);
      if (!inQuote && !inWord) {
        anchorIndexes.push({ pos: p, word });
        break; 
      }
      from = p + 1; 
    }
  }
  if (anchorIndexes.length === 0) {
    return -1;
  }
  anchorIndexes.sort((a, b) => a.pos - b.pos);
  return lastEnd + anchorIndexes[0].pos;
}
















export function createThinkingStripper(getReasoning: () => string): {
  push(content: string): string;
  flush(): string;
  get reasoning(): string;
} {
  let rawReasoning = ""; 
  let inTag = false; 
  let activeClose = ""; 
  let inDs = false; 
  let pending = ""; 
  let headBuf = ""; 
  let started = false;
  
  let untaggedBuf = "";      
  let untaggedLineCount = 0; 
  const UNTAGGED_MAX_CHARS = 4000; 
  const UNTAGGED_MAX_LINES = 8;    
  
  
  
  let tbtBuf = "";   
  let inTbt = false; 
  const TBT_END_LEN = 4; 

  
  const holdTail = (s: string, tag: string): number => {
    const lower = s.toLowerCase();
    let hold = 0;
    for (let k = 1; k <= tag.length; k++) {
      if (lower.endsWith(tag.slice(0, k))) hold = Math.max(hold, k);
    }
    return hold;
  };

  


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

  
  const _strongRe =
    /身份设定|角色设定|我的身份|保持角色|用中文\s*(回应|回答|回复|沟通)|作为[^，。\n]{0,8}(我|助手|agent)|保持[^，。\n]{0,6}(自然|平静|专业|均衡|情绪)|当前[^，。\n]{0,4}(情绪|状态)|我[^，。\n]{0,6}\b(回应|回复|回答)用户/ig;
  const _weakRe =
    /用户\s*(发送了|说|问|询问|提到|要求|让我|叫我|给|上报|讲述了)|用户[^，。\n]{0,6}(说|问|发|提|要|想|给|夸|称|表示|认为|觉得|称赞|赞美|夸奖|只是|还|终于)|我\s*(需要|应该|将|打算|必须|看到|已经|分析|检测|列出|读取|查看|检查|介绍|说明|概述|总结|给出|提供|梳理|整理|研究|了解|根据|翻一下|找一下|查一下|得先)|根据(我的|系统提示)|让我\s*(先|开始|列出|阅读|查看|分析|检查|了解|确认|概述)|(我先|首先)\s*(列表|阅读|查看|分析|检查|了解|确认|概述)/ig;
  const _anchorWords = ["你好", "您好", "好的", "当然", "所以", "因此", "那么", "总之", "总结是", "以下是", "先说", "下面", "答案", "结果"];
  
  const _bodyStartRe =
    /^(哈哈|你好|您好|好的|当然|没问题|谢谢|抱歉|可以|好嘞|明白了|收到|好的呀|好的呢|嗯嗯|好的吧|没毛病|没问题|来啦|在的|你好呀)/;
  







  const evalUntagged = (buf: string): { decided: boolean; thought?: string; body?: string; weight: number; naturalBreak: boolean; bodyStart: boolean } => {
    if (!buf) return { decided: false, weight: 0, naturalBreak: false, bodyStart: false };
    const lines = buf.split("\n");
    let thinkingEnd = -1;
    let weight = 0;
    let prevHadFeature = false;
    let anchorStart = -1;
    let naturalBreak = false;
    let bodyStart = false;
    let bodyStartPending = false; 
    const _leftQuotes = new Set(['"', "'", "「", "『", "(", "（", "`", "<", "《", "【", "[", "{"]);
    let scannedChars = 0; 
    
    
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
        
        if (bodyStartPending) {
          weight += 1;
          bodyStartPending = false;
        }
        weight += strongCount * 2 + weakCount;
        prevHadFeature = true;
        thinkingEnd = lineStart + line.length;
        
        
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
                break; 
              }
              from = p + 1; 
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
      
      if (weight > 0) {
        
        if (/[:：]\s*$/.test(trimmed)) {
          
          if (strongBodyStartRe.test(trimmed) && weight >= 3) {
            naturalBreak = true;
            break;
          }
          thinkingEnd = lineStart + line.length;
          continue;
        }
        
        
        if (_bodyStartRe.test(trimmed) || (strongBodyStartRe.test(trimmed) && weight >= 3)) {
          naturalBreak = true;
          break;
        }
        
        thinkingEnd = lineStart + line.length;
        continue;
      }
      
      
      
      if (_bodyStartRe.test(trimmed)) {
        bodyStartPending = true;
        thinkingEnd = lineStart + line.length;
        continue;
      }
      
      break;
    }
    
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

  








  const evaluateTbt = (buf: string): { decision: "buffer" | "release" | "all-think" | "cut"; reason?: string; body?: string } => {
    const lines = buf.split("\n");
    let total = 0;
    let short = 0;
    let firstNormal = -1;
    for (let i = 0; i < lines.length; i++) {
      const tr = lines[i].trim();
      if (!tr) continue;
      if (/^[ \t]/.test(lines[i]) || /^(\s*[-*•+]\s|\s*\d+[.、]\s)/.test(tr)) continue; 
      if (tr.length <= 3) { short++; total++; continue; }
      if (!/^[\d.\-*•>\s]+$/.test(tr)) {
        if (firstNormal < 0) firstNormal = i;
        total++;
        continue;
      }
      
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
          
          const ci = findDsMarker(pending, DS_END);
          if (ci === -1) {
            const hold = holdTail(pending, "response");
            if (hold > 0) {
              const keep = pending.length - hold;
              if (keep > 0) {
                rawReasoning += pending.slice(0, keep);
                pending = pending.slice(keep);
              }
              break; 
            }
            rawReasoning += pending;
            pending = "";
          } else {
            
            const rest = pending.slice(ci);
            const m = rest.match(/^\s*response\b/i);
            const consume = m ? m[0].length : "response".length;
            rawReasoning += pending.slice(0, ci + consume);
            
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
              break; 
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
            
            const after = pending.slice(dsStart.pos + dsStart.len);
            const ws = after.match(/^\s*/);
            const firstNonWs = ws ? after.charAt(ws[0].length) : "";
            if (firstNonWs === ">") {
              clean.push(pending);
              pending = "";
              continue;
            }
            
            
            if (after.trim() === "") {
              const keep = dsStart.pos;
              if (keep > 0) {
                clean.push(pending.slice(0, keep));
              }
              pending = pending.slice(keep);
              break;
            }
            
            clean.push(pending.slice(0, dsStart.pos));
            rawReasoning += DS_START;
            pending = pending.slice(dsStart.pos + dsStart.len);
            inDs = true;
            continue;
          }
          if (oi === -1) {
            
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
              break; 
            }
            clean.push(pending);
            pending = "";
          } else {
            clean.push(pending.slice(0, oi));
            const rest = pending.slice(oi);
            const active = THINK_TAG_PAIRS[pairIdx];
            const ci = rest.toLowerCase().indexOf(active.close);
            if (ci !== -1) {
              
              rawReasoning += rest.slice(0, ci + active.close.length);
              pending = rest.slice(ci + active.close.length);
            } else {
              const hold = holdTail(rest, active.close);
              if (hold > 0) {
                
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

      
      
      
      let tbtCut = false; 
      if (inTbt) {
        
        
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
          
          rawReasoning += "\n" + joinFragmentedLines(tbtBuf.slice(0, cutOff)) + "\n";
          out = tbtBuf.slice(cutOff);
          inTbt = false;
          tbtBuf = "";
        }
        
      } else if (out) {
        tbtBuf += out;
        out = "";
        const ev = evaluateTbt(tbtBuf);
        if (ev.decision === "release") {
          
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
        
      }

      
      if (!started && out) {
        if (!tbtCut) {
          
          untaggedBuf += out;
        out = "";
        
        let lc = 1;
        for (let i = 0; i < untaggedBuf.length; i++) if (untaggedBuf[i] === "\n") lc++;
        untaggedLineCount = lc;
        const judged = evalUntagged(untaggedBuf);
        if (judged.decided && judged.thought && judged.body) {
          
          rawReasoning += "\n" + judged.thought + "\n";
          untaggedBuf = judged.body;
          untaggedLineCount = 1;
          
          
          out = untaggedBuf; 
          untaggedBuf = "";
          untaggedLineCount = 0;
        } else {
          
          const trimmed = untaggedBuf.trim();
          const bufChars = trimmed.length;
          
          
          const overLines = untaggedLineCount > (judged.weight >= 3 ? UNTAGGED_SCAN_LIMIT : UNTAGGED_MAX_LINES);
          const overChars = bufChars > UNTAGGED_MAX_CHARS;
          
          
          
          const sawBodyLine = judged.naturalBreak;
          let bodyConfirm = false;
          if (judged.bodyStart) {
            const ls = untaggedBuf.split("\n");
            if (ls.length >= 2 && ls[1].trim() && _bodyStartRe.test(ls[1].trim())) {
              bodyConfirm = true;
            }
          }
          
          let quickRelease = false;
          if (judged.weight === 0) {
            quickRelease = untaggedLineCount >= 4 || bufChars >= 200;
          } else if (judged.weight <= 1) {
            quickRelease = untaggedLineCount >= 5 || bufChars >= 300;
          }
          if (overLines || overChars || sawBodyLine || bodyConfirm || quickRelease) {
            let result = { cleanReply: untaggedBuf, reasoning: "" };
            
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
              
              out = untaggedBuf;
              untaggedBuf = "";
              untaggedLineCount = 0;
            }
          }
        }
        } 
      }

      
      if (!started) {
        headBuf += out;
        out = "";
        const rt = getReasoning().trim();
        if (headBuf.trim()) {
          if (rt) {
            
            while (headBuf.startsWith(rt) && headBuf.length > rt.length) {
              headBuf = headBuf.slice(rt.length).trimStart();
            }
            if (headBuf.startsWith(rt) || rt.startsWith(headBuf)) {
              
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
      
      if (inTbt) {
        rawReasoning += "\n" + joinFragmentedLines(tbtBuf + out) + "\n";
        out = "";
        inTbt = false;
        tbtBuf = "";
      } else if (tbtBuf) {
        
        const ev = evaluateTbt(tbtBuf);
        if (ev.decision === "all-think") {
          rawReasoning += "\n" + joinFragmentedLines(tbtBuf) + "\n";
          tbtBuf = "";
        } else if (ev.decision === "cut") {
          rawReasoning += "\n" + joinFragmentedLines(ev.reason ?? "") + "\n";
          out = (ev.body ?? "") + (out ? out : "");
          tbtBuf = "";
        } else {
          
          out = tbtBuf + (out ? out : "");
          tbtBuf = "";
        }
      }
      
      
      
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
    this.knowledgeDataDir = opts.dataDir;
  }

  
  private knowledgeDataDir?: string;

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
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    sys += "\n\n" + DELEGATION_GUIDANCE;
    
    sys += "\n\n指令驱动（无需让用户手动操作面板）：\n" +
      "1) 用户要「做个网页 / 应用 / 小工具 / 页面 / 网站 / 落地页 / 表单 / 计算器 / 待办 / 计时器」等需求时，**直接用 http_create_app 工具**生成自包含单页应用（按需求自动选模板），生成后会在右侧栏浏览器自动打开，并把可点击的访问地址（http://127.0.0.1:<port>）直接告诉用户。不要追问技术细节，直接生成并给链接。\n" +
      "2) 用户要「操作手机 / 模拟器 / 安卓设备 / 装 App / 卸载 / 截图 / 跑命令」时，**直接用 adb_* 工具**：先 adb_connect（不传 host 会自动扫描雷电/夜神/MuMu/Genymotion/AVD 等常见模拟器端口并列出连上的设备）或 adb_devices 拿到 serial，再执行 adb_shell / adb_install / adb_screencap 等操作。**不要让用户自己输参数或手动连设备**——你主动探测、连接、操作，只把结果汇报给用户。\n" +
      "3) 以上工具依赖运行环境装配的 AdbService / HttpServer；若返回「未就绪」提示，如实告知用户当前环境未启用该能力即可，不要假装成功。\n" +
      "4) **图形控制（点击/滑动/输入）必须按下面的高精度流程做**，否则极易点错：\n" +
      "   a. **安卓**：先 screen_ui_dump 拿元素列表 → 用 screen_action({kind:\"click\", selector:{index:N}}（或 text/id））**按元素点击**——这是最稳的方式，优先于任何坐标。\n" +
      "   b. 元素列表里没有目标 → 先 screen_action 下滑/swipe 后再 screen_ui_dump；若是全屏画布/游戏（无元素树）→ 用 screen_capture 截图，按图上**刻度网格**读像素坐标，再 screen_action 传 x,y（默认就是**所见图像的像素坐标**，直接量，不要换算）。\n" +
      "   c. **每次 screen_action 后都会回传操作后的画面——务必看一眼确认是否真的点中/生效**；没生效就重新截图重新定位，**不要用同一坐标盲目重试**。\n" +
      "   d. 桌面（本机电脑）：**先 screen_windows 看有哪些窗口 → screen_focus 或 screen_capture({window:\"记事本\"}) 把目标窗口带到前台再截图**（按窗口截图会自动裁到该窗口、坐标带窗口偏移，比截整屏准得多）→ screen_action 按刻度读像素坐标操作。桌面无元素树，「先聚焦、再看图、按刻度定位」这三步是精度的关键；type 输入中文在安卓上不受支持（需设备装 ADBKeyboard），失败时如实说明别硬试。\n" +
      "   e. **桌面的硬边界（必须如实告知用户，不要含糊承诺）**：Windows 的鼠标/键盘注入（SetCursorPos + mouse_event/SendInput）**只作用于当前前台窗口**，注入点击本身也会把窗口带到前台——所以**桌面做不到「目标窗口留在下层、不抢焦点地干活」**。另外 Windows 会拒绝后台进程抢前台（screen_focus 返回「未获得前台」时就是被拒了）：此时**不要**继续盲点，先如实告知用户「需要先把目标窗口切到前台」；若用了 screen_capture({window:...}) 且回传里带 ⚠️ 警告，说明那张图可能被其它窗口遮挡，看图时要把它当不确定信息。想要真正不抢焦点的后台操作，只有安卓（adb 在设备侧执行，与 PC 焦点无关）和右侧栏浏览器（操作发生在应用内，不经 OS 前台）这两条路。\n" +
      "5) **右侧栏浏览器操作（browser_* 工具）**——用户要求「打开某网站 / 在网页里点某按钮 / 填表 / 查网页内容」时用它，**不要**改用命令行或让他自己开浏览器：\n" +
      "   a. 流程：browser_navigate 打开网址 → **browser_snapshot** 拿元素清单（编号/文本/CSS 选择器）→ browser_click({index:N} 或 {text:\"登录\"}) 点击、browser_type({text, selector}) 填表 → browser_snapshot/browser_screenshot 核对是否生效。\n" +
      "   b. **元素定位优先于坐标**（与安卓同思路）；确实要按坐标点时浏览器坐标是**页面像素**（可用 browser_screenshot 的元素编号辅助）。\n" +
      "   c. 页面需要时间加载/渲染时用 browser_wait；要同时访问多个网站用 browser_open_tab 新开页（各页内容互相独立）。\n" +
      "   d. 操作后**必须核对**（snapshot 或截图）；没生效就重新 snapshot 再试，不要重复同样的点击。";
    
    sys += agentSkillGuide(resolveAgentToolProfile(agent.tool_profile));
    return sys;
  }

  

  private agentToolsFor(agent: AgentState): string[] | undefined {
    const names = this.engine.listTools?.().map((t) => t?.function?.name).filter((n): n is string => !!n);
    if (!names) { return undefined; }
    return agentToolsOnly(
      resolveAgentToolProfile(agent.tool_profile),
      () => names,
    );
  }

  private async effectiveMessage(agent: AgentState, message: string): Promise<string> {
    let effective = await this.evidence(message); 
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

  












  private async runAgentFor(agentId: string, modelChoiceOverride?: string): Promise<AgentState | undefined> {
    const agent = await this.registry.findAgent(agentId);
    const override = typeof modelChoiceOverride === "string" ? modelChoiceOverride.trim() : "";
    if (!agent || !override || override === agent.model_choice) { return agent; }
    return { ...agent, model_choice: override };
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

  

  async chat(agentId: string, req: ChatRequest): Promise<ChatResult> {
    const agent = await this.runAgentFor(agentId, req.modelChoice);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    const systemPrompt = await this.systemPromptFor(agent);
    const teamCtx = await this.teamContextFor(req.sessionId);
    


    const mount = sidebarMountSection(req.sessionId);
    const systemBegin = [systemPrompt, teamCtx, mount].filter(Boolean).join("\n\n");
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
      
      networkEnabled: req.networkEnabled,
      
      toolsOnly: this.agentToolsFor(agent),
    });
    let reply = result.reply?.trim() || "[Agent 未返回有效回复]";

    
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
            
            
            
            
            networkEnabled: req.networkEnabled,
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
          
          networkEnabled: req.networkEnabled,
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
    
    reply = extractThinkingFromReply(reply).cleanReply || "[Agent 未返回有效回复]";

    
    const success = !isFailReply(reply);

    
    const rawReply = extractThinkingFromReply(result.replyRaw ?? reply).cleanReply;

    if (req.retry) {
      await this.historyStore.popLast(agent.id, req.sessionId);
    }
    await this.recordInteraction(agent, req.message, rawReply, success, req.sessionId, undefined, result.elapsedMs && result.elapsedMs > 0 ? result.elapsedMs : undefined);

    void this.spawnPostProcess(agent, req.message, rawReply, success); 

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

  

  




  async *stream(agentId: string, req: ChatRequest, resumeSeq = 0, signal?: AbortSignal): AsyncGenerator<ServiceEvent<unknown>> {
    const agent = await this.runAgentFor(agentId, req.modelChoice);
    if (!agent) {
      throw new ChatServiceError(404, "Agent 不存在");
    }
    const session = createStreamSession();
    
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
    
    const mount = sidebarMountSection(req.sessionId);
    const systemBase = [systemPrompt, teamCtx, mount].filter(Boolean).join("\n\n");
    const system = req.resumeHint ? `${systemBase}\n\n[系统·中断续接] ${req.resumeHint}` : systemBase;
    const workspace = await this.sessionWorkspaceFor(req.sessionId);
    
    
    
    
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
          
          networkEnabled: req.networkEnabled,
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
    
    const reasoningToolNames: string[] = [];
    
    const reasoningToolDiffTags: Array<string | undefined> = [];
    let model = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let elapsedMs = 0;
    
    let reasoningBuf = "";
    
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
        
        
        windowCap: req.windowCap,
        
        
        networkEnabled: req.networkEnabled,
        
        toolsOnly: this.agentToolsFor(agent),
        
        
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
          
          reasoningToolDiffTags.push(diffTagForTrace(chunk.result));
          yield emitChunk(chunk);
        } else if (chunk.type === "reasoning" || chunk.type === "progress") {
          if (chunk.type === "reasoning") {
            reasoningBuf += chunk.content ?? "";
          }
          yield emitChunk(chunk);
        } else if (chunk.type === "done") {
          doneReceived = true;
          
          fullReply = chunk.reply_raw ?? chunk.reply ?? fullReply;
          heldDone = chunk;
        } else if (chunk.type === "error") {
          errorMsg = chunk.message ?? "";
          fullReply = errorMsg;
          this.alarm("chat.stream", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
          yield emitChunk(chunk);
        } else {
          

























          yield emitChunk(chunk);
        }
      }

      
      const stripperTail = stripper.flush();
      if (stripperTail) {
        
        if (!doneReceived) {
          fullReply += stripperTail;
        }
        yield emitChunk({ type: "chunk", content: stripperTail });
      }
      const sr = stripper.reasoning.trim();
      if (sr && !reasoningBuf.includes(sr)) {
        reasoningBuf = [reasoningBuf, sr].filter(Boolean).join("\n");
      }

      
      if (signal?.aborted && heldDone) {
        const extracted = extractThinkingFromReply(heldDone.reply ?? "", reasoningBuf);
        heldDone.reply = extracted.cleanReply;
        reasoningBuf = extracted.reasoning;
        elapsedMs = heldDone.elapsed_ms ?? 0;
        yield emitChunk(heldDone);
        return;
      }

      
      if (doneReceived && heldDone !== null && isGenerationRequest(req.message)) {
        const img = toolEventNames.includes("agnes_generate_image");
        
        
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
              reasoningToolDiffTags.push(diffTagForTrace((ev as { result?: unknown }).result));
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

      
      if (doneReceived && heldDone !== null) {
        const firstReply = fullReply;
        const broadcastMsg = parseBroadcast(firstReply);
        if (broadcastMsg && this.bus) {
          this.bus.broadcast(agent.name, broadcastMsg, "info");
          this.logger.info(`[slime] ${agent.name} 广播了一条消息给 ${this.bus.getRegisteredNames()}`);
        }
        const delegations = parseDelegations(firstReply);
        
        const delegationResults: Array<{ name: string; task: string; result: string } | undefined> = [];
        if (delegations.length > 0) {
          
          const eventQueue: Array<EngineChunk | null> = [];
          const worker = (async () => {
            
            
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
                    
                    networkEnabled: req.networkEnabled,
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
            eventQueue.push(null); 
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
              reasoningToolDiffTags.push(diffTagForTrace((evt as { result?: unknown }).result));
            }
            yield emitChunk(evt);
          }
          await worker;
        }

        const realResults = delegationResults.filter((r): r is { name: string; task: string; result: string } => !!r);
        if (realResults.length > 0) {
          
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
            
            networkEnabled: req.networkEnabled,
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
                
                
                
                ...(typeof fchunk.cache_read_tokens === "number" ? { cache_read_tokens: fchunk.cache_read_tokens } : {}),
                ...(typeof fchunk.cache_creation_tokens === "number" ? { cache_creation_tokens: fchunk.cache_creation_tokens } : {}),
                ...(typeof fchunk.reasoning_tokens === "number" ? { reasoning_tokens: fchunk.reasoning_tokens } : {}),
                
                ...(typeof fchunk.window_prompt_tokens === "number" ? { window_prompt_tokens: fchunk.window_prompt_tokens } : {}),
                 ...(typeof fchunk.window_cache_read_tokens === "number" ? { window_cache_read_tokens: fchunk.window_cache_read_tokens } : {}),
                 
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
          
          ...(typeof heldDone?.cache_read_tokens === "number" ? { cache_read_tokens: heldDone.cache_read_tokens } : {}),
          ...(typeof heldDone?.cache_creation_tokens === "number" ? { cache_creation_tokens: heldDone.cache_creation_tokens } : {}),
          ...(typeof heldDone?.reasoning_tokens === "number" ? { reasoning_tokens: heldDone.reasoning_tokens } : {}),
          ...(typeof heldDone?.window_prompt_tokens === "number" ? { window_prompt_tokens: heldDone.window_prompt_tokens } : {}),
          ...(typeof heldDone?.window_cache_read_tokens === "number" ? { window_cache_read_tokens: heldDone.window_cache_read_tokens } : {}),
          ...(typeof heldDone?.cache_read_in_prompt === "boolean" ? { cache_read_in_prompt: heldDone.cache_read_in_prompt } : {}),
        });
        return;
      }
      
      errorMsg = `[流式生成异常: ${e instanceof Error ? e.message : String(e)}]`;
      this.alarm("chat.stream", `${agent.name}: ${errorMsg.slice(0, 200)}`, "warning");
      yield emitChunk({ type: "error", message: errorMsg });
    } finally {
      
      if (doneReceived || fullReply || errorMsg) {
        
        const sr = stripper.reasoning.trim();
        if (sr && !reasoningBuf.includes(sr)) {
          reasoningBuf = [reasoningBuf, sr].filter(Boolean).join("\n");
        }
        
        const extracted = extractThinkingFromReply(fullReply || errorMsg, reasoningBuf);
        let persistReply = extracted.cleanReply || errorMsg;
        reasoningBuf = extracted.reasoning;
        
        
        if (!errorMsg) {
          const promoted = promoteOrphanThinking(persistReply, reasoningBuf);
          persistReply = promoted.cleanReply;
          reasoningBuf = promoted.reasoning;
        }
        
        if (fullReply && !doneReceived && !errorMsg) {
          persistReply = persistReply + "\n[截断]";
        }
        const success = !isFailReply(persistReply);
        if (req.retry) {
          await this.historyStore.popLast(agent.id, req.sessionId);
        }
        
        
        const toolBlock = composeToolCallBlock(reasoningToolNames, reasoningToolDiffTags);
        if (toolBlock) {
          reasoningBuf = reasoningBuf ? `${reasoningBuf}\n\n${toolBlock}` : toolBlock;
        }
        await this.recordInteraction(agent, req.message, persistReply, success, req.sessionId, reasoningBuf || undefined, elapsedMs > 0 ? elapsedMs : undefined);
        void this.spawnPostProcess(agent, req.message, persistReply, success, toolEventNames);
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
    tools: string[] = [],
  ): Promise<void> {
    return (async () => {
      try {
        
        
        await this.postProcessChat(agent, userMsg, reply, success, {
          tools,
          ...(this.knowledgeDataDir ? { dataDir: this.knowledgeDataDir } : {}),
        });
      } catch (e) {
        this.logger.warn(`[slime] 后处理失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  
  async postProcessChat(
    agent: AgentState,
    userMsg: string,
    reply: string,
    success: boolean,
    opts: { knowledgePrefix?: string; patternSource?: string; dataDir?: string; tools?: string[] } = {},
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

    
    if (this.postProcess.evolve) {
      try {
        await this.postProcess.evolve({ agent, success, traitSignals, userSentiment });
      } catch (e) {
        this.logger.warn(`[slime] 演化失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      this.logger.debug("[slime] 演化引擎未接线（5B.3 迁移后启用），跳过");
    }

    
    let ke: ReturnType<typeof getKnowledgeEngine> | null = null;
    try {
      ke = getKnowledgeEngine(agent.id, opts.dataDir ? { dataDir: opts.dataDir } : {});
      const primary = success
        ? ke.recordPattern(`${knowledgePrefix}.success`, "task", `成功回复: ${userMsg.slice(0, 80)}`, "low")
        : ke.recordPattern(`${knowledgePrefix}.fail`, "task", `回复失败: ${userMsg.slice(0, 80)}`, "medium");
      
      
      
      
      const promoted = ke.applyPromotion(primary, agent.persona as never);
      if (promoted.skill) {
        this.logger.info(`[slime] 自动生成技能: ${promoted.skill.name}（来源 pattern ${String(primary.key ?? "")}）`);
      }
      if (promoted.trait) {
        this.logger.info(`[slime] 人格特征强化: ${promoted.trait}（来源 pattern ${String(primary.key ?? "")}）`);
      }
      
      
      
      const usedTools = [...new Set((opts.tools ?? []).filter((t) => t && !t.startsWith("delegate:")))].slice(0, 8);
      for (const t of usedTools) {
        ke.recordPattern(
          `tool.${t}.${success ? "success" : "fail"}`,
          "learning",
          `工具 ${t} 在任务「${userMsg.slice(0, 40)}」中${success ? "成功" : "失败"}`,
          success ? "low" : "medium",
        );
      }
    } catch (e) {
      this.logger.debug(`[slime] 知识引擎更新失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    
    const behavior = BehaviorStore.fromDict(agent.behavior);
    for (const bp of behaviorPatterns) {
      behavior.reinforce({
        scenario: bp.scenario,
        steps: bp.steps,
        source: patternSource,
        rationale: bp.rationale ?? "",
      });
    }

    
    const emotion = new EmotionalState(agent.emotion as Record<string, unknown>);
    const violation = false; 
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

    
    try {
      const ce = new ConsolidationEngine();
      const total = agent.persona?.interactions?.length ?? 0;
      if (ce.shouldConsolidate(total)) {
        ce.consolidate({
          behavior,
          totalInteractions: total,
          
          
          knowledgeTraits: ke ? ke.getPromotableTraits() : undefined,
          existingScenarios: new Set(behaviorPatterns.map((bp) => bp.scenario)),
          onArchived: (pat) => behavior.archive(pat),
        });
        
        
        if (ke) {
          const rv = ke.review(agent.persona as never);
          if (rv.traits_reinforced > 0 || rv.patterns_resolved > 0) {
            this.logger.info(`[slime] 知识审查: 强化 trait ${rv.traits_reinforced} · 归档 pattern ${rv.patterns_resolved}`);
          }
        }
        
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



const PRAISE_KEYWORDS = ["谢谢", "感谢", "做得好", "不错", "棒", "太棒", "辛苦", "厉害"];

export function isPraise(message: string, userSentiment: number): boolean {
  if (userSentiment <= 0 || !message) {
    return false;
  }
  return PRAISE_KEYWORDS.some((k) => message.includes(k));
}


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
