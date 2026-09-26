/**
 * core-ts/src/services/context_compress.ts — 上下文自动压缩（A-969 落地，A-1082 修正）。
 *
 * 对齐 Anthropic Compaction API / Claude Code auto-compact / LangGraph 长期记忆抽象：
 * - 触发：输入侧占用 ≥ 窗口上限 × 触发占比（默认 0.85），发送前检查（「每次请求前体检」）。
 * - 摘要轮：用同 Agent 的路由模型把长历史浓缩为结构化摘要（任务/成果/决策/下一步/关键文件/用户约束）。
 * - 压缩后：历史注入 = 摘要头 + 最近 K 轮（K = summaryCount），早期内容不再全量重发。
 *
 * 本模块只含纯函数（估算/拼提示词/裁剪/摘录），模型调用由 engine.summarizeContext 承担；
 * turn 对齐裁剪、硬不变量、理解环、熔断在 `context_loop.ts`。
 *
 * ─────────────────────────── A-1082 修掉的三个「假压缩」根因 ───────────────────────────
 *
 * ① **CJK 4 倍低估**：`estimateHistoryTokens` 原为 `总字符 / 4`，而 1 个汉字 ≈ 1 token
 *    ⇒ 中文长会话的占用被算成真实的 1/4 ⇒ 阈值形同虚设、该压的时候不压。
 *    （同文件里的 `estimateTokensLocal` 一直是 CJK 感知的，却**无人调用**——口径分裂。）
 *
 * ② **摘要轮无条件放弃**：`SUMMARIZE_INPUT_CAP` 超限即 `return null`，调用方随即降级
 *    「硬裁剪」；而那条降级路径**实际什么都没裁**（见 ③）。现改为
 *    `buildSummaryInput` —— 超预算就**取头 30% + 尾 70% 的摘录**，摘要轮**永不放弃**。
 *
 * ③ **降级路径是空操作 + 假报**：摘要为 null 时旧代码 `setSessionSummary(sid, null, K)`
 *    会把 `contextSummary` 一并删掉，而 `loadSessionHistory` 的注入条件是
 *    `if (meta.contextSummary && …)` ⇒ 判定为假 ⇒ **返回完整未裁剪历史**。
 *    于是「已压缩 N 轮」只是界面话术，发出去的请求一个字都没少 ⇒
 *    原样重发 → 再次超限 → 用户看到「压缩并非真压缩」。
 *    现由 `trimTurnAligned`（turn 对齐）+ `isRealShrink`（真实降幅判据）兜住。
 */

import { planCut, trimTurnAligned, type LoopMessage } from "./context_loop.js";

export { trimTurnAligned };

/** 默认触发占比：输入侧占用达到窗口上限的 85% 时触发自动压缩（对齐 Claude Code 的 autoCompactThreshold 语义） */
export const DEFAULT_COMPRESS_RATIO = 0.85;
/** 区间：允许用户配置的触发占比上下限 */
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 0.97;
/**
 * 压缩后保留的尾部**轮数**（K；一轮 = 一个 user 及其后的全部消息）。
 *
 * ⚠️ A-1082：单位从「消息条数」改为「轮数」——依据 OpenAI Agents SDK `TrimmingSession`
 * 与 LangChain `trim_messages(start_on="human")` 的 turn 对齐语义（设计定稿不变量 I2）。
 * 本仓持久化历史恒为 user/ai 成对，故 **6 轮 ≡ 旧的 12 条消息**，发送体积与旧行为等价，
 * 但切口不再可能落在半轮上。
 */
export const DEFAULT_TAIL_KEEP = 6;
/** 摘要轮输入**预算**（tokens）。A-1082：超预算不再放弃摘要，而是走 `buildSummaryInput` 摘录。 */
export const SUMMARIZE_INPUT_CAP = 24000;
/**
 * A-1106：摘要轮**输出**上限的绝对封顶（tokens）。
 *
 * ⚠️ 旧实现写死 `max_tokens: 1024` 且**不检查 `finish_reason`** —— CJK 下 1024 token
 * 约只能写出几百个汉字，长会话摘要触达上限时**被腰斩**，而半截文本 `trim()` 后非空
 * ⇒ 被当作**完整摘要**写入 `contextSummary` ⇒ **静默丢失早期上下文**（用户症状：
 * "压缩后 Agent 丢失上下文记忆"）。而 `validateHistory` 只校验序列合法性，**查不出**这个。
 *
 * 现在：输出上限按输入规模自适应（见 `summarizeOutputCap`），并在上游
 * `finish_reason === "length"` 时**抬满到本上限重试一次**；仍截断则**如实标记**
 * （`truncated: true`）交由上层出声 —— 绝不静默当完整。
 */
export const SUMMARIZE_OUTPUT_CAP = 4096;

/**
 * 摘要轮的输出上限：按**输入规模**给（摘要天然短于母本），钳在 `[1024, SUMMARIZE_OUTPUT_CAP]`。
 *
 * 为什么不是常数：同一次摘要的输入跨度从几千 token 到 `SUMMARIZE_INPUT_CAP` 不等，
 * 一个固定值必然「对小输入浪费、对大输入腰斩」。0.25 是压缩比的常见下界
 * （业界摘要任务通常要求 ≤1:4）；下界 1024 保证小会话不被无谓收紧。
 */
export function summarizeOutputCap(inputTokens: number): number {
  const n = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  return Math.max(1024, Math.min(SUMMARIZE_OUTPUT_CAP, Math.ceil(n * 0.25)));
}
/** 每条消息的固定结构开销（tokens；role 标记 + 分隔符 + chat template 骨架） */
export const MESSAGE_OVERHEAD_TOKENS = 30;

/**
 * A-1085：**常规发送**时读取的历史条数上限（一轮 ≈ 2 条 ⇒ 50 条 ≈ 25 轮）。
 *
 * 它保护的是"发送体积"（老会话不该把上千条历史全塞进请求）。
 * ⚠️ 但**摘要轮绝不能用它** —— 摘要轮的目的是"把早期内容**收进**摘要"，
 *    用它就变成"只看最后 25 轮，更早的从未进摘要"，于是那些内容既不在摘要里、
 *    也不在保留尾巴里 ⇒ **静默丢失**（用户看到"已压缩"，早期上下文却蒸发了）。
 *    ⇒ 摘要轮一律传 `full`（见 `loadHistoryForSession` 的 `limit <= 0` = 不限）。
 */
export const HISTORY_LOAD_LIMIT = 50;

/**
 * 粗略 token 估算（CJK 感知：1 汉字 ≈ 1 token、其余 4 字符 ≈ 1 token）。
 *
 * ⚠️ 与 `engine.estimateTokens`（`length * 0.6`，服务于上下文分桶展示）**刻意不统一**：
 * 那个是展示口径、已按分桶做过校准，全局改会牵动界面所有占用数字；
 * 这里是**压缩触发判据**口径，必须贴近真实 tokenizer。
 */
export function estimateTokensLocal(text: string): number {
  if (!text) { return 0; }
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.round(cjk + other / 4);
}

/** 取单条消息的可计文本（图片只按占位计，绝不把 base64 算进去） */
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
    // 图片按 ~2000 token 计（对齐 Claude Code 图片占用口径），但不读 dataURL 原始字符
    return n + (hasImage ? 2000 : 0);
  }
  return 0;
}

/**
 * 估算一段轮次列表的输入 token 数。
 *
 * A-1082：改为**与 `estimateTokensLocal` 同口径**逐条累加（CJK 1 字 = 1 token）+ 每条固定结构开销。
 * 旧实现 `总字符 / 4` 对中文是 4 倍低估 ⇒ 压缩阈值永远达不到。
 *
 * 判据：1000 个汉字的 messages 应落在 900–1600（旧实现只有 ~250）。
 */
export function estimateHistoryTokens(messages: Array<{ role: string; content: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + contentTokensOf(m?.content);
  }
  return Math.round(total);
}

/** 是否需要压缩：used ≥ cap × ratio 且轮次够多（太短的会话压缩无意义） */
export function needsCompress(used: number, cap: number, ratio: number, turnCount: number): boolean {
  if (cap <= 0 || used <= 0) { return false; }
  if (turnCount < 6) { return false; } // 6 轮以下不压缩（Claude Code 同有最小轮次门槛）
  return used >= cap * Math.min(Math.max(ratio, RATIO_MIN), RATIO_MAX);
}

/**
 * 摘要轮提示词。
 *
 * `priorSummary` 存在时切换为**递进式**（LangGraph 滚动摘要范式）：在既有摘要基础上**扩充**，
 * 并保留旧摘要的全部要点 —— 防止信息随轮次逐轮衰减（不变量 I5）。
 *
 * ⚠️ 模板刻意使用**被动语态字段名**（对齐 Anthropic 官方 compaction template 的设计意图，
 * 见设计定稿 §8.2）：摘要里出现命令式句子（「接下来只允许调用 X」）会被下游模型当成
 * **用户指令**，污染下一步决策。
 */
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

/** 把轮次序列拼成摘要轮的纯文本输入（图片仅标注占位，dataURL 不参与——不为压缩而携带几 MB base64） */
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

/**
 * 在**预算内**构造摘要轮输入（A-1082：替代旧「超限即放弃摘要」）。
 *
 * 策略：整体放得下就整段给；放不下就取**头部 30% + 尾部 70%**（尾部是最新、最相关的
 * 工作现场，权重更高），中间以一行省略说明替代。**至少保证尾部有 1 条**，
 * 避免"预算太小导致摘要轮看到空内容"。
 *
 * 依据：设计定稿 §8.8 —— 现场最常见的失败是"摘要轮自己先爆窗口"，放弃摘要又让
 * 调用方静默硬裁剪；正确做法是让摘要轮**永远有东西可摘要**。
 */
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
    // 至少收 1 条：预算再小也要让摘要轮看到最新现场
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

/** 压缩后历史的起始下标（turn 对齐；`0` = 无需裁剪） */
export function planCompactedCut(messages: LoopMessage[], keep = DEFAULT_TAIL_KEEP): number {
  return planCut(messages, keep);
}

/**
 * 压缩后的历史拼装：**摘要头 + assistant 垫脚 + 最近 K 轮**。
 *
 * 不变量保证：
 *   · 切口由 `trimTurnAligned` 落在 turn 边界 ⇒ `tail[0]` 必为 `user`；
 *   · 摘要头以 `user` 开场、紧跟一条 `assistant` 垫脚 ⇒ 绝对 `user→assistant` 交替（I3，
 *     Anthropic 系 API 拒绝连续同角色消息）；
 *   · `tail` 原样透传（**不塌角色、不丢 `tool_calls` / `tool_call_id`**，I1）。
 *
 * `opts.comprehend` 为「理解总结」环产出的**续接认知**，并入同一条 user 消息内
 * （并入而非另起一条，避免破坏角色交替）。
 */
export function buildCompactedHistory(
  summary: string,
  messages: LoopMessage[],
  keep = DEFAULT_TAIL_KEEP,
  opts?: { comprehend?: string },
): LoopMessage[] {
  const tail = trimTurnAligned(messages, keep).slice();
  // 防御：正常情况下 trimTurnAligned 已保证 tail[0] 是 user；异常输入（首条即 assistant）
  // 时丢弃开头非 user 的消息，宁可少留几条也不产出连续同角色序列。
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

/**
 * 无摘要可用的**降级裁剪**（trim 档）：只保留最近 K 整轮。
 *
 * A-1082：旧 `hardTruncate` 的 `[首条, ...末 K 条]` 已被删除 —— 它既让首尾不相邻
 * （对话不连续），又会在末 K 条以 user 开头时产出 `user, user` 连续同角色（I3 违反，
 * Anthropic 系直接 400）。此处统一走 `trimTurnAligned`。
 */
export function truncateTurnAligned<T extends LoopMessage>(messages: T[], keep = DEFAULT_TAIL_KEEP): T[] {
  return trimTurnAligned(messages, keep);
}
