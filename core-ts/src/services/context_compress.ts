/**
 * core-ts/src/services/context_compress.ts — 上下文自动压缩（A-969 落地）。
 *
 * 对齐 Anthropic Compaction API / Claude Code auto-compact / LangGraph 长期记忆抽象：
 * - 触发：输入侧占用 ≥ 窗口上限 × 触发占比（默认 0.85），发送前检查（"每次请求前体检"）。
 * - 摘要轮：用同 Agent 的路由模型把长历史浓缩为结构化摘要（任务/成果/决策/下一步/关键文件/用户约束）。
 *   摘要轮本身有输入硬上限——历史已超过该上限时放弃模型摘要，降级硬裁剪（绝不阻塞用户）。
 * - 压缩后：历史注入 = 摘要头 + 最近 K 条（K = summaryCount），早期内容不再全量重发。
 *
 * 本模块只含纯函数（估算/拼提示词/裁剪），模型调用由 engine.summarizeContext 承担。
 */

/** 默认触发占比：输入侧占用达到窗口上限的 85% 时触发自动压缩（对齐 Claude Code 的 autoCompactThreshold 语义） */
export const DEFAULT_COMPRESS_RATIO = 0.85;
/** 区间：允许用户配置的触发占比上下限 */
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 0.97;
/** 压缩后保留的尾部轮数（摘要之后保留的最近对话条数；Claude Code 压缩后仍保留近期全文） */
export const DEFAULT_TAIL_KEEP = 12;
/** 摘要轮输入硬上限（tokens）——超过即放弃模型摘要、直接硬裁剪（避免摘要轮把窗口打爆） */
export const SUMMARIZE_INPUT_CAP = 9000;

/** 粗略 token 估算（字符/4；与 engine.estimateTokens 同口径；本模块不 import engine，避免循环依赖） */
export function estimateTokensLocal(text: string): number {
  if (!text) { return 0; }
  // 中英混合：中文按 1 字符 ≈ 1 token、英文按 4 字符 ≈ 1 token 的折中，用正则按字符集分计
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.round(cjk + other / 4);
}

/** 估算一段轮次列表的输入 token 数（粗略：总字符按估算口径折算 + 每轮固定开销） */
export function estimateHistoryTokens(messages: Array<{ role: string; content: unknown }>): number {
  let chars = 0;
  for (const m of messages) {
    chars += 300; // 每轮结构开销（role 标记 + 分隔符 + 提问/回复骨架）
    const c = m.content;
    if (typeof c === "string") { chars += c.length; }
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === "object") {
          const text = (part as { text?: string }).text;
          if (typeof text === "string") { chars += text.length; }
        }
      }
    }
  }
  return Math.round(chars / 4);
}

/** 是否需要压缩：used ≥ cap × ratio 且轮次够多（太短的会话压缩无意义） */
export function needsCompress(used: number, cap: number, ratio: number, turnCount: number): boolean {
  if (cap <= 0 || used <= 0) { return false; }
  if (turnCount < 6) { return false; } // 6 轮以下不压缩（Claude Code 同有最小轮次门槛）
  return used >= cap * Math.min(Math.max(ratio, RATIO_MIN), RATIO_MAX);
}

/** 摘要轮提示词：引导模型产出"续接能力"优先的结构化摘要（对齐 Anthropic 官方 compaction prompt 的
 *  state / next steps / learnings 语义）。 */
export function buildCompressSummaryPrompt(conversationText: string): string {
  return (
    "你是一个专业的长对话上下文压缩器。请把下面 `<conversation>` 中的历史对话浓缩为一份中文结构化摘要。\n" +
    "摘要必须保留以下信息（没有的项可省略，不要编造）：\n" +
    "1. 当前进行中的任务与目标；\n" +
    "2. 已经完成的成果/结论/关键文件路径；\n" +
    "3. 关键决策及其原因、当前采用的方案；\n" +
    "4. 明确的下一步计划/待办；\n" +
    "5. 用户表达的偏好、约束与需求；\n" +
    "6. 重要工具调用结果（读取过哪些文件、访问过哪些网址、执行结果概要）。\n" +
    "要求：要点式、≤500 字、信息密度高、不口语化寒暄。压缩后的摘要将替代早期全部对话轮次，作为后续回复的唯一早期上下文，请确保具备足够的接续能力。\n\n" +
    `<conversation>\n${conversationText}\n</conversation>`
  );
}

/** 把轮次序列拼成摘要轮的纯文本输入（图片仅标注占位，dataURL 不参与——不为压缩而携带几 MB base64） */
export function messagesToPlainText(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .map((m) => {
      const c = m.content;
      if (typeof c === "string") { return `${m.role.toUpperCase()}: ${c}`; }
      if (Array.isArray(c)) {
        const parts: string[] = [];
        for (const part of c) {
          if (part && typeof part === "object") {
            const text = (part as { text?: string }).text;
            if (typeof text === "string" && text) { parts.push(text); }
          }
        }
        return `${m.role.toUpperCase()}: ${parts.join(" ") || "[图片内容]"}`;
      }
      return `${m.role.toUpperCase()}: (unsupported)`;
    })
    .join("\n\n");
}

/** 硬裁剪降级：保留最近 K 轮（外加第一轮作为发端上下文，保留话题锚点） */
export function hardTruncate(messages: Array<{ role: string; content: unknown }>, keep = DEFAULT_TAIL_KEEP): Array<{ role: string; content: unknown }> {
  if (messages.length <= keep + 1) { return messages; }
  const head = messages.slice(0, 1);
  const tail = messages.slice(-keep);
  return [...head, ...tail];
}

/** 模型摘要成功后的历史拼装：摘要头 + 最近 K 轮。
 *  摘要头以 user 开场、紧跟一条 assistant 垫脚——绝对保持 user→assistant 交替
 *  （Anthropic 系 API 拒绝连续同角色消息，而历史上最早轮次也是 user）。 */
export function buildCompactedHistory(
  summary: string,
  messages: Array<{ role: string; content: unknown }>,
  keep = DEFAULT_TAIL_KEEP,
): Array<{ role: "user" | "assistant"; content: string }> {
  const tail = messages.slice(-keep);
  return [
    { role: "user", content: `【会话上下文压缩摘要】（早期 ${Math.max(0, messages.length - tail.length)} 轮已压缩，仅保留要点）\n${summary}` },
    { role: "assistant", content: "（已收录以上摘要，在此基础上继续当前任务）" },
    ...tail.map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: typeof m.content === "string" ? m.content : "[图片消息]" })),
  ];
}