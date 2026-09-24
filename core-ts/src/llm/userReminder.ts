/**
 * core-ts/src/llm/userReminder.ts — 把"提醒"折进**最后一条 user 消息**，而不是新增一条
 * `role: "system"` 消息。
 *
 * ## 它修的是什么（真实协议缺陷，不是风格问题）
 *
 * A-1061① 的"计划复述"最初实现成 `messages.push({ role: "system", content: reminder })`
 * —— 于是消息数组里出现了**第二位之后的 system**。这在三种上游上的下场完全不同：
 *
 * | 上游 | 拿到"非首位 system"会怎样 |
 * | --- | --- |
 * | OpenAI 兼容（`agnes` / 各类反代网关，见 `probe.ts` 的 agnes→openai）| 多数网关**直接 400**（协议校验）；宽容的网关则按实现各自解释 |
 * | Anthropic（`client.ts` 的 `toAnthropicPayload`）| 不报错，但 `role: m.role === "user" ? "user" : "assistant"` 会把它**静默改写成 assistant** —— 提醒变成了"模型自己说过的话" |
 * | Responses / Gemini | `toResponsesPayload` 只把 system 收进 `instructions`（丢掉位置）；`toGooglePayload` 全部拼进 systemText |
 *
 * 也就是说：**同一个"提醒"在四条协议上是四种语义**，其中最坏的一档是"静默变成模型的发言"。
 * 判据很简单 —— **system 只允许出现在第 0 位**（引擎本来就放了唯一一条：`out[0]`）。
 *
 * ## 为什么折进 user，而不是折进 system
 *
 * 复述提醒的**价值来自 recency**（Manus「目标复述 / recitation」：长任务早期的计划会沉到
 * 上下文中段而失效，必须顶回高注意力区）。折进首位 system 等于把它丢回中段 → 复述白做。
 * 折进**最后一条 user 消息**同时满足两点：
 *   · 位置仍在末尾（recency 保住）；
 *   · **角色组合合法**（system 仍在第 0 位）—— 而且这正是 Claude Code 的做法：
 *     它的 `<system-reminder>` 就是**塞在 user 回合里**的，而不是新增一条 system。
 *
 * ## 边界
 *
 *   · 提醒为空 / 全空白 → **原样返回**（不制造空消息）；
 *   · 没有任何 user 消息（异常调用）→ 追加一条新的 user 消息（仍不产生非首位 system）；
 *   · `content` 是字符串 → 追加段落；是 content-blocks 数组 → 追加一个 text block
 *     （有图的那条 user 消息就是数组形态，见 `engine.buildMessages`）；
 *   · 其它（undefined/对象）→ 直接用提醒文本作内容。
 *
 * `messages` 元素的最小结构约束（ChatMessage 兼容，但不依赖它，便于单测直接喂字面量）：
 * `{ role?: string; content?: unknown }`。
 *
 * ⚠️ 返回**新数组**、不改入参 —— 引擎那边 `out` 是局部变量，但纯函数化能让守卫直接喂字面量断言。
 *
 * 回归守卫见 `tests/core-ts/user-reminder.spec.ts`；变异见 `gui/scripts/mut-a1061-reminder.mjs`。
 */

/** 本模块要求的消息最小形态（ChatMessage 结构性兼容）。 */
export interface RemindableMessage {
  role?: string;
  content?: unknown;
}

/**
 * 把 `reminder` 折进**最后一条 user 消息**（没有则追加一条 user 消息）。
 *
 * 保证：返回值里**只有第 0 位可能是 `role: "system"`** —— 这是 OpenAI 兼容上游的硬约束，
 * 也是 Anthropic 路径不被静默改写的前提。
 */
export function foldUserReminder<T extends RemindableMessage>(messages: readonly T[], reminder: string): T[] {
  const out = messages.slice();
  const text = typeof reminder === "string" ? reminder.trim() : "";
  if (!text) { return out; }

  let idx = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]?.role === "user") { idx = i; break; }
  }
  if (idx < 0) {
    // 没有 user 回合可挂（异常调用）：追加一条 —— 仍然**不**制造非首位 system。
    out.push({ role: "user", content: text } as T);
    return out;
  }

  const msg = out[idx]!;
  const cur = msg.content;
  if (typeof cur === "string") {
    out[idx] = { ...msg, content: cur.trim() ? `${cur}\n\n${text}` : text };
  } else if (Array.isArray(cur)) {
    // 有图的那条 user 消息是 content-blocks 数组：追加一个 text block，保持块结构不变
    out[idx] = { ...msg, content: [...(cur as unknown[]), { type: "text", text }] };
  } else {
    out[idx] = { ...msg, content: text };
  }
  return out;
}

/**
 * 消息数组是否满足"system 只能在第 0 位"。
 *
 * 单独导出是为了让守卫能**直接断言不变量**（而不是逐字比对实现）：
 * 任何"提醒注入"的实现都该过这一关，换实现也不用重写守卫。
 */
export function hasOnlyLeadingSystem(messages: readonly RemindableMessage[]): boolean {
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "system") { return false; }
  }
  return true;
}
