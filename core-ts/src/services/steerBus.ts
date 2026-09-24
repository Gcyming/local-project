/**
 * core-ts/src/services/steerBus.ts — 「引导」（steer）的**会话级缓冲区**（A-1060）。
 *
 * ## 为什么需要它
 *
 * 用户原话：「中间插入输出**还是会直接中断** …… 你全网搜索一下 …… 现在很多 agent 都不是直接中断了，
 * 而是在 agent 输出中插入『引导』」。
 *
 * 调研结论（一手来源）：
 * - **Cursor changelog 2026-08-19**：「send a message to steer the agent while it's working
 *   **without interruption**. Follow-ups **wait for the next tool call** instead of cutting the
 *   agent off mid-action」。
 * - **Claude Code 交互模式**：Enter 把消息**排队**到"下一轮边界"发出（不打断当前步），Esc 才中断。
 * - 社区汇总（busy-input mode）：`queue`（下轮）/ **`steer`（注入当前运行，在下一个工具调用之后到达，
 *   不开新轮）** / `interrupt`（立即停）三态并存。
 *
 * slime 此前只有 `queue` 与 `interrupt` 两态，缺的正是 `steer` —— 所以「直接插入」只能掐掉当前生成。
 *
 * ## 职责边界（刻意做到最小）
 *
 * 本模块**只**管一个 `Map<sessionId, SteerItem[]>`：进（`pushSteer`）/ 出（`drainSteers`）/
 * 清（`clearSteers`）/ 查（`pendingSteerCount`）。**不碰** IPC、不碰 React、不碰 LLM ——
 * 这样它可单测、可变异，而"什么时候消费"由工具循环决定（见 `tool_loop.ts` 的轮次边界）。
 *
 * ## 为什么放 core-ts 而不是主进程
 *
 * 消费方是 `tool_loop.ts`（core-ts）。若缓冲住在主进程，就得把回调一路穿过
 * `chatService.stream → engine.stream → ToolLoop.runStream` 三层签名 —— 改动面大得多，
 * 且任何一层忘了转发就是**静默失效**（指令被吞、用户完全看不出来）。
 * 用模块级缓冲，装配层只需「推进去」，消费点就近在轮次边界，**不存在漏转发的可能**。
 *
 * ## 与渲染层队列的关系（重要）
 *
 * 本缓冲**不是**那份待发队列的全部，它只是"已投递给主进程、等待被当前运行消费"的副本。
 * 渲染层仍然持有待发卡片（用户可以撤回）。若某条 steer 一直没被消费（例如当前这轮
 * 纯文本输出、压根没有工具调用 → 永远到不了轮次边界），渲染层会按**普通排队**在下一轮发出
 * —— 这正是 Claude Code「Enter 排队」的语义，**既不丢也不重复**。
 * 因此：**流一结束就必须 `clearSteers`**，否则残留会在下一次运行里被再次注入（重复发送）。
 */

export interface SteerItem {
  /** 渲染层队列条目的自增 id（去掉前缀后原样带回，用于"这一条已被消费，从待发卡片里撤掉"） */
  id: string;
  /** 用户输入的原文（原样注入，不加任何自造前缀） */
  text: string;
}

/** sessionId → 待注入队列（FIFO）。模块级：进程内单例，随流生命周期清空。 */
const buffers = new Map<string, SteerItem[]>();

/** 单会话待注入上限：防止用户连点把上下文撑爆（超出丢弃最早的，并保留计数供上层观察）。 */
export const STEER_MAX_PENDING = 8;

/** 文本上限：与 todo 的 content 上限同量级，够写一段引导，又不至于把上下文吃光。 */
export const STEER_TEXT_MAX = 2000;

/**
 * 投入一条引导。返回投入后该会话的待注入**条数**（0 表示被拒：空文本/空会话/超限）。
 *
 * ⚠️ 空文本必须**拒绝而不是入队空串** —— 空串注入进去就是一条无内容的 user 消息，
 *    既浪费上下文，又会让模型面对一个"没有要求的要求"。
 */
export function pushSteer(sessionId: string, item: SteerItem): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  const text = typeof item?.text === "string" ? item.text.trim() : "";
  if (!sid || !text) { return 0; }
  const list = buffers.get(sid) ?? [];
  list.push({ id: String(item.id ?? ""), text: text.slice(0, STEER_TEXT_MAX) });
  // 超限丢**最早**的：用户最新说的那句一定是当下最相关的
  while (list.length > STEER_MAX_PENDING) { list.shift(); }
  buffers.set(sid, list);
  return list.length;
}

/**
 * 取走该会话全部待注入项（**清空缓冲**）。
 *
 * 取走即清空是刻意的（不是"读一份快照"）：消费方是工具循环的轮次边界，
 * 同一条引导只能进一次上下文 —— 否则每轮都重复注入，模型会反复看到同一句话。
 * 无会话（undefined/空串）→ 返回空数组（不抛）。
 */
export function drainSteers(sessionId: string | undefined): SteerItem[] {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return []; }
  const list = buffers.get(sid);
  if (!list || list.length === 0) { return []; }
  buffers.delete(sid);
  return list;
}

/**
 * 丢弃该会话的待注入项。
 *
 * 必须在**流结束时**调用（done / error / 用户取消三条路径都要）：
 * 没被消费的残留若留到下一次运行，会在那一轮的轮次边界被注入 → **同一条引导发两遍**。
 * ⚠️ 渲染层的待发卡片不受影响（它自己那份还在），所以用户不会"丢指令"。
 */
export function clearSteers(sessionId: string | undefined): void {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return; }
  buffers.delete(sid);
}

/** 该会话当前待注入条数（供界面/日志如实展示；不做任何副作用）。 */
export function pendingSteerCount(sessionId: string | undefined): number {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return 0; }
  return buffers.get(sid)?.length ?? 0;
}

/** 仅供测试：清空全部会话的缓冲（进程内单例，测试之间必须隔离）。 */
export function resetSteerBusForTest(): void {
  buffers.clear();
}
