/**
 * core-ts/src/services/outgoingMessages.ts — 出网前对 `messages[]` 的**唯一规范化**（A-1129）。
 *
 * ## 为什么必须有这一层
 *
 * 上游（本仓实测：AGNES / agnes-3.0-flash）对 `messages` 有一条硬校验：
 *
 *     400 BadRequestError: messages: Validation error: message content cannot be empty
 *
 * 而本项目**会把内容为空的消息发出去**，有两条独立来路：
 *
 *   ① **历史里的空记录**。会话历史按 `{user, ai}` 成对落盘（`history.jsonl`），
 *      读取时被**无条件**展开成两条消息（`gui/src/main/index.ts` 的 `loadRawHistoryWithMeta`：
 *      `flatMap(r => [{role:"user",content:r.user},{role:"assistant",content:r.ai}])`）。
 *      只要有一条记录的 `user` 或 `ai` 是空串，就会永久产出空消息。
 *      实测样本（会话 `s_8637c98c1f81`，2026-09-26T14:54:56Z）：`user: ""`、`ai: 2498 字`。
 *   ② **本轮的空输入**。渲染层的 `send()` 有**内部续发 / 兜底发送**路径（`forceNewTurn`），
 *      `text` 可能是空串；引擎 `buildMessages` 又把 `{role:"user", content: call.message}`
 *      无条件追加。
 *
 * ⚠️ 后果是**会话级不可逆**的：那条空消息一旦在历史里，就出现在**之后每一次**请求里
 *   ⇒ 这个会话**每一轮都 400**，而新建会话立刻正常（用户实测：「我换了个会话就好了」）。
 *   这正是"静默失效家族"的形态：写入门与发送门都没有判据，谁都不知道它坏了。
 *
 * ## 为什么是"补占位"而不是"整条丢弃"
 *
 * 丢消息会**改变角色交替**：`[assistant, <空 user>, assistant]` 丢掉中间那条就变成
 * `assistant, assistant`；`[user, <空 assistant>, user]` 丢掉就变成 `user, user`。
 * 连续同角色本身就是 OpenAI 兼容上游的另一个 400 来源 —— 本仓已经为此付过代价
 * （见 `context_compress.ts` 里 `trimTurnAligned` 的注释：A-1082 的 `hardTruncate`
 * 产出 `user, user` 导致 Anthropic 系直接 400）。
 *
 * ⇒ 一律**保留消息、只把空内容换成角色合适的占位**：交替关系与消息条数都不变，
 *   上游拿到的是合法请求。唯一的例外是**空 system**：它没有任何语义（不是"说了一句空话"，
 *   而是"没有系统提示"），留着只会占位，直接丢掉；它在数组首位，丢掉也不会造成同角色相邻。
 *
 * ## 与"渲染层要不要显示占位"无关
 *
 * 本模块只作用于**出网数组**（`engine.buildMessages` 的返回值），**不改**落盘历史、
 * 不改渲染层气泡、不改 `promptTokens` 之外的任何统计口径。历史里那条空记录照旧如实保留。
 *
 * 纯函数：不读时钟、不碰 IO（对齐 `agentProcs.ts` 等纯模块的分家约定）。
 */

/** 可以出现在本层的消息的最小形状（`ChatMessage` 的结构子集；本模块不 import schema） */
export interface WireMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

/**
 * 空内容 → 该角色用的占位文本（**唯一出处**）。
 *
 * 取舍：占位要**尽量中性**且不诱导模型复述 ——
 *   · `user: （继续）` —— 与真实的"空输入"语义最近（内部续发/兜底发送本来就是让模型接着做）；
 *   · `assistant: （本轮无输出）` —— 如实描述"这一轮没说话"，不假装说过什么；
 *   · `tool: （无输出）` —— 工具确实可能返回空；
 *   · `system: ""` —— **不补**（空 system = 没有系统提示，整条会被丢弃，见 `sanitizeOutgoingMessages`）。
 */
export const EMPTY_CONTENT_PLACEHOLDER: Readonly<Record<string, string>> = {
  user: "（继续）",
  assistant: "（本轮无输出）",
  tool: "（无输出）",
  system: "",
};

/** 该角色的占位文本；未知角色回落到「（继续）」（宁可有一句中性话，也不能让请求出不去） */
export function placeholderForRole(role: string): string {
  const p = EMPTY_CONTENT_PLACEHOLDER[role];
  return typeof p === "string" && p ? p : "（继续）";
}

/**
 * 这条 content 算"空"吗 —— 判据必须与上游的校验口径一致（**trim 后为空**）。
 *
 * · `string`      → `trim() === ""` 为空；
 * · `null`/`undefined` → 为空（`tool_loop` 在模型只回工具调用时正是推 `content: null`）；
 * · `Array`       → **空数组**才算空。⚠️ 有元素的数组一律**不算空**：识图路径把
 *                   `[{type:"text",text:""},{type:"image_url",…}]` 塞进 content，
 *                   文字为空但**图就是这一轮的问题**，判空会把它修没。
 * · 其它类型      → 交给 `String()` 判（数字 0 之类不是空内容）。
 */
export function isEmptyWireContent(content: unknown): boolean {
  if (content === null || content === undefined) { return true; }
  if (typeof content === "string") { return content.trim() === ""; }
  if (Array.isArray(content)) { return content.length === 0; }
  return String(content).trim() === "";
}

/** 这条消息是否带着工具调用（带工具调用的 assistant **不能丢**：丢了会让后面的 tool 消息失去配对） */
export function hasToolCalls(msg: WireMessage): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

/**
 * 出网数组的规范化。**唯一入口** —— 任何要发到上游的 `messages` 都必须过它。
 *
 * 规则（顺序即优先级）：
 *   1. 空 `system` → **整条丢弃**（没有系统提示 ≠ 说了一句空话）；
 *   2. 其余空内容 → **换成角色占位**（保留消息 ⇒ 角色交替不变，见文件头）；
 *   3. 没变的数组**原样返回同一个引用**（调用方/测试可据此判断"无需处理"，也避免无谓复制）。
 */
export function sanitizeOutgoingMessages<T extends WireMessage>(messages: readonly T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) { return messages as T[]; }
  let changed = false;
  const out: T[] = [];
  for (const m of messages) {
    if (isEmptyWireContent(m?.content)) {
      /* 空 system：丢。⚠️ 只丢**内容为空**的 system —— 有内容的 system 是首条提示，绝不许动。 */
      if (m?.role === "system") { changed = true; continue; }
      changed = true;
      out.push({ ...m, content: placeholderForRole(String(m?.role ?? "")) } as T);
      continue;
    }
    out.push(m);
  }
  return changed ? out : (messages as T[]);
}

/**
 * 规范化后是否**还有**空内容（供守卫/诊断用；正常恒为 false）。
 * 存在的意义：把"我们以为修好了"变成一个可断言的量，而不是靠肉眼。
 */
export function countEmptyContent(messages: readonly WireMessage[]): number {
  if (!Array.isArray(messages)) { return 0; }
  return messages.filter((m) => isEmptyWireContent(m?.content)).length;
}

/**
 * 对**请求体**做规范化（`messages` 字段就地换掉，其它字段原样透传）。
 *
 * 这是接线层唯一需要的入口：`ModelRouter.chat` / `.chatStream` 各调一次，
 * 于是「四个协议客户端 + 全部调用方（含 tool_loop 的中途重发）」一次覆盖。
 *
 * ⚠️ 没有 `messages`（或不是数组）时**原样返回同一个引用** —— embeddings 之类不带消息的
 *   请求也会经过同一个出口，不能被顺手改成空数组。
 * ⚠️ 无需改动时返回**入参本身**（不是副本）：router 的下游会拿它做缓存键比较之类的事，
 *   无谓的复制会让"没变"看起来像"变了"。
 */
export function sanitizeWirePayload<T extends object>(payload: T): T {
  if (!payload || typeof payload !== "object") { return payload; }
  const msgs = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) { return payload; }
  const safe = sanitizeOutgoingMessages(msgs as WireMessage[]);
  return safe === (msgs as WireMessage[]) ? payload : ({ ...payload, messages: safe } as T);
}
