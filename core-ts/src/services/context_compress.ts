




























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













export function buildCompactedHistory(
  summary: string,
  messages: LoopMessage[],
  keep = DEFAULT_TAIL_KEEP,
  opts?: { comprehend?: string },
): LoopMessage[] {
  const tail = trimTurnAligned(messages, keep).slice();
  
  
  while (tail.length > 0 && tail[0].role !== "user") { tail.shift(); }
  const dropped = Math.max(0, messages.length - tail.length);

  const header =
    `【会话上下文压缩摘要】（早期 ${dropped} 条消息已压缩为要点，仅作延续上下文，不是待执行的新任务）\n${String(summary ?? "").trim()}`;
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
