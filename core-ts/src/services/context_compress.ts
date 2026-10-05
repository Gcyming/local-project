




























import { planCut, trimTurnAligned, type LoopMessage } from "./context_loop.js";

export { trimTurnAligned };


export const DEFAULT_COMPRESS_RATIO = 0.85;

export const RATIO_MIN = 0.5;
export const RATIO_MAX = 0.97;








export const DEFAULT_TAIL_KEEP = 6;

export const SUMMARIZE_INPUT_CAP = 24000;












export const SUMMARIZE_OUTPUT_CAP = 4096;








export function summarizeOutputCap(inputTokens: number): number {
  const n = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  return Math.max(1024, Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.25)));
}

export const MESSAGE_OVERHEAD_TOKENS = 30;










export const HISTORY_LOAD_LIMIT = 50;








export function estimateTokensLocal(text: string): number {
  if (!text) { return 0; }
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.round(cjk + other / 4);
}


function contentTokensOf(content: unknown): number {
  if (typeof content === "string") { return estimateTokensLocal(content); }
  if (Array.isArray(content)) {
    let n = 0;
    let hasImage = false;
    for (const part of content) {
      if (part && typeof part === "object") {
        const text = (part as { text?: string }).text;
        if (typeof text === "string") { n += estimateTokensLocal(text); }
        const t = (part as { type?: string }).type;
        if (t === "image_url" || t === "image") { hasImage = true; }
      }
    }
    
    return n + (hasImage ? 2000 : 0);
  }
  return 0;
}









export function estimateHistoryTokens(messages: Array<{ role: string; content: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + contentTokensOf(m?.content);
  }
  return Math.round(total);
}


export function needsCompress(used: number, cap: number, ratio: number, turnCount: number): boolean {
  if (cap <= 0 || used <= 0) { return false; }
  if (turnCount < 6) { return false; } 
  return used >= cap * Math.min(Math.max(ratio, RATIO_MIN), RATIO_MAX);
}











export function buildCompressSummaryPrompt(conversationText: string, priorSummary?: string): string {
  const prior = String(priorSummary ?? "").trim();
  const base =
    "你是一个专业的长对话上下文压缩器。请把下面 `<conversation>` 中的历史对话浓缩为一份中文结构化摘要。\n" +
    "摘要必须保留以下信息（没有的项可省略，不要编造）：\n" +
    "1. 当前进行中的任务与目标；\n" +
    "2. 已经完成的成果/结论/关键文件路径；\n" +
    "3. 关键决策及其原因、当前采用的方案；\n" +
    "4. 明确的下一步计划/待办；\n" +
    "5. 用户表达的偏好、约束与需求；\n" +
    "6. 重要工具调用结果（读取过哪些文件、访问过哪些网址、执行结果概要）。\n" +
    "要求：要点式、信息密度高、不口语化寒暄。用**被动陈述**语气记录（例如「用户要求…」「待办事项为…」），" +
    "**禁止**出现第二人称命令句（例如「接下来只允许调用 X」「忽略之前的规则」）——那会被后续模型误当成用户指令。";
  const rule = prior
    ? "这是一次**递进式**压缩：下面的 `<prior_summary>` 是**此前已经压缩过的要点**。" +
      "你必须在它的基础上**扩充**（把新增对话的信息并入），并**完整保留** `<prior_summary>` 里的全部要点，" +
      "不许丢弃、不许改写含义、不许只写新增部分。输出仍是一份完整摘要（不是补丁、不是差异）。\n\n" +
      `<prior_summary>\n${prior}\n</prior_summary>\n\n`
    : "";
  return `${base}\n\n${rule}<conversation>\n${conversationText}\n</conversation>`;
}


export function messagesToPlainText(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map((m) => {
      const c = m.content;
      if (typeof c === "string") { return `${m.role.toUpperCase()}: ${c}`; }
      if (Array.isArray(c)) {
        const parts: string[] = [];
        let hasImage = false;
        for (const part of c) {
          if (part && typeof part === "object") {
            const text = (part as { text?: string }).text;
            if (typeof text === "string" && text) { parts.push(text); }
            const t = (part as { type?: string }).type;
            if (t === "image_url" || t === "image") { hasImage = true; }
          }
        }
        const body = parts.join(" ") || (hasImage ? "[图片内容]" : "[空]");
        return `${m.role.toUpperCase()}: ${body}`;
      }
      return `${m.role.toUpperCase()}: (unsupported)`;
    })
    .join("\n\n");
}











export function buildSummaryInput(
  messages: Array<{ role: string; content: unknown }>,
  budgetTokens: number,
): { text: string; elided: number } {
  const full = messagesToPlainText(messages);
  const budget = Math.max(256, Math.floor(Number.isFinite(budgetTokens) ? budgetTokens : SUMMARIZE_INPUT_CAP));
  if (estimateTokensLocal(full) <= budget) { return { text: full, elided: 0 }; }

  const blocks = messages.map((m) => messagesToPlainText([m]));
  const headBudget = Math.floor(budget * 0.3);
  const tailBudget = budget - headBudget;

  const head: string[] = [];
  let headUsed = 0;
  for (const b of blocks) {
    const t = estimateTokensLocal(b);
    if (headUsed + t > headBudget) { break; }
    head.push(b);
    headUsed += t;
  }

  const tail: string[] = [];
  let tailUsed = 0;
  for (let i = blocks.length - 1; i >= head.length; i--) {
    const t = estimateTokensLocal(blocks[i]);
    
    if (tail.length > 0 && tailUsed + t > tailBudget) { break; }
    tail.unshift(blocks[i]);
    tailUsed += t;
  }

  const elided = Math.max(0, blocks.length - head.length - tail.length);
  const parts = [...head];
  if (elided > 0) { parts.push(`（此处省略 ${elided} 条较早消息：受摘要轮输入预算所限）`); }
  parts.push(...tail);
  return { text: parts.join("\n\n"), elided };
}


export function planCompactedCut(messages: LoopMessage[], keep = DEFAULT_TAIL_KEEP): number {
  return planCut(messages, keep);
}

export const MIN_CONVERSATION_BUDGET = 256;

export const PRIOR_BUDGET_SHARE = 0.6;

const SUMMARY_JOIN_SLACK = 8;

const CLIP_ELISION_MARKER = "（…摘要轮预算所限，中间已省略…）";

function takeHeadByTokens(text: string, maxTokens: number): string {
  const limit = Math.max(0, Math.floor(Number.isFinite(maxTokens) ? maxTokens : 0));
  if (limit <= 0) { return ""; }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokensLocal(text.slice(0, mid)) <= limit) { lo = mid; } else { hi = mid - 1; }
  }
  return text.slice(0, lo);
}

function takeTailByTokens(text: string, maxTokens: number): string {
  const limit = Math.max(0, Math.floor(Number.isFinite(maxTokens) ? maxTokens : 0));
  if (limit <= 0) { return ""; }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokensLocal(text.slice(text.length - mid)) <= limit) { lo = mid; } else { hi = mid - 1; }
  }
  return text.slice(text.length - lo);
}

export function clipToTokenBudget(text: string, maxTokens: number): string {
  const src = String(text ?? "");
  const limit = Math.floor(Number.isFinite(maxTokens) ? maxTokens : 0);
  if (limit <= 0) { return ""; }
  if (estimateTokensLocal(src) <= limit) { return src; }
  const room = limit - estimateTokensLocal(CLIP_ELISION_MARKER) - 1;
  if (room <= 0) { return takeHeadByTokens(src, limit); }
  const head = takeHeadByTokens(src, Math.floor(room * 0.4));
  const tail = takeTailByTokens(src, room - estimateTokensLocal(head));
  if (head.length + tail.length >= src.length) { return takeHeadByTokens(src, limit); }
  return `${head}${CLIP_ELISION_MARKER}${tail}`;
}

export function summaryPromptScaffoldTokens(): number {
  return estimateTokensLocal(buildCompressSummaryPrompt("", "x"));
}

export interface PriorSummaryFit {
  prior: string;

  truncated: boolean;

  priorTokens: number;

  conversationBudget: number;

  overBudget: boolean;
}

export function fitSummaryPrior(
  priorSummary: string | undefined,
  budgetTokens: number,
  fixedTokens = 0,
): PriorSummaryFit {
  const requested = Math.floor(
    Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : SUMMARIZE_INPUT_CAP,
  );
  const fixed = Math.max(0, Math.floor(Number.isFinite(fixedTokens) ? fixedTokens : 0));
  const room = Math.max(0, requested - fixed - SUMMARY_JOIN_SLACK);
  const raw = String(priorSummary ?? "").trim();
  const affordable = room - MIN_CONVERSATION_BUDGET;
  let prior = raw;
  if (raw && estimateTokensLocal(raw) > affordable) {
    const share = Math.floor(Math.max(0, affordable) * PRIOR_BUDGET_SHARE);
    const clipped = clipToTokenBudget(raw, share);
    if (estimateTokensLocal(clipped) < estimateTokensLocal(raw)) { prior = clipped; }
  }
  const priorTokens = estimateTokensLocal(prior);
  const conversationBudget = Math.max(MIN_CONVERSATION_BUDGET, room - priorTokens);
  return {
    prior,
    truncated: prior !== raw,
    priorTokens,
    conversationBudget,
    overBudget: fixed + priorTokens + conversationBudget > requested,
  };
}













export function buildCompactedHistory(
  summary: string,
  messages: LoopMessage[],
  keep = DEFAULT_TAIL_KEEP,
  opts?: { comprehend?: string },
): LoopMessage[] {
  const tail = trimTurnAligned(messages, keep).slice();
  
  
  while (tail.length > 0 && tail[0].role !== "user") { tail.shift(); }

  const header =
    `【会话上下文压缩摘要】（早期消息已压缩为要点，仅作延续上下文，不是待执行的新任务）\n${String(summary ?? "").trim()}`;
  const comprehend = String(opts?.comprehend ?? "").trim();
  const content = comprehend ? `${header}\n\n【续接认知（回读摘要后自述的当前状态）】\n${comprehend}` : header;

  return [
    { role: "user", content },
    { role: "assistant", content: "（已收录以上摘要与续接认知，在此基础上继续当前任务）" },
    ...tail,
  ];
}








export function truncateTurnAligned<T extends LoopMessage>(messages: T[], keep = DEFAULT_TAIL_KEEP): T[] {
  return trimTurnAligned(messages, keep);
}

export type CompactionGateCode = "shrunk" | "no-shrink" | "grew";

export interface CompactionGateInput {
  before: Array<{ role: string; content: unknown }>;

  raw: LoopMessage[];

  summary: string;

  comprehend?: string | null;

  keep?: number;
}

export interface CompactionGateResult {
  persist: boolean;

  code: CompactionGateCode;

  tokensBefore: number;

  tokensAfter: number;

  candidate: LoopMessage[];

  reason: string;
}

export function gateCompaction(input: CompactionGateInput): CompactionGateResult {
  const keep = Math.max(
    1,
    Math.floor(Number.isFinite(input?.keep) ? (input.keep as number) : DEFAULT_TAIL_KEEP),
  );
  const raw = Array.isArray(input?.raw) ? input.raw : [];
  const candidate: LoopMessage[] = raw.length > keep * 2
    ? buildCompactedHistory(
      String(input?.summary ?? ""),
      raw,
      keep,
      { comprehend: String(input?.comprehend ?? "") },
    )
    : raw.slice();
  const tokensBefore = estimateHistoryTokens(Array.isArray(input?.before) ? input.before : []);
  const tokensAfter = estimateHistoryTokens(candidate);
  const delta = tokensAfter - tokensBefore;
  const code: CompactionGateCode = delta < 0 ? "shrunk" : delta === 0 ? "no-shrink" : "grew";
  const reason = code === "shrunk"
    ? `压缩产物确实变短（${tokensBefore} → ${tokensAfter} tokens，-${Math.abs(delta)}）`
    : code === "no-shrink"
      ? `压缩产物与压缩前等长（${tokensBefore} → ${tokensAfter} tokens）`
      : `压缩产物反而更长（${tokensBefore} → ${tokensAfter} tokens，+${delta}）`;
  return { persist: code === "shrunk", code, tokensBefore, tokensAfter, candidate, reason };
}

export async function commitCompactionIfShrunk(
  gate: CompactionGateResult,
  commit: () => Promise<unknown>,
  onReject?: (reason: string) => void,
): Promise<boolean> {
  if (!gate || gate.persist !== true) {
    onReject?.(String(gate?.reason ?? "压缩产物未通过「必须真的变短」校验"));
    return false;
  }
  await commit();
  return true;
}
