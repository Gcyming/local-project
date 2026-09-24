/**
 * gui/src/renderer/pages/instructionQueue.ts — 待发指令队列（中途插入 / 即将插入）的**纯逻辑**。
 *
 * ── 要解决的体验 ──
 * Agent 正在跑（可能是一次几十秒的工具循环）时用户又想补一句。此前只有一种行为：
 * **打断插入**（A-162）—— 发出去就先 `chat.cancel` 掐掉当前生成，再把新指令当作新一轮。
 * 这在一半场景下是错的：用户只是想"再补一句"，并不想废掉正在跑的活。
 * 于是需要**多种**插入方式，并且让用户**看得见、改得动**（A-1060 起为三态）：
 *   ① **引导（steer）**：不打断，在下一个工具调用之后的**轮次边界**注入本轮上下文 ——
 *      这是「直接插入」现在的行为（此前它等于硬中断，用户点名"还是会直接中断"）；
 *   ② 排队（queue）：不打断，等当前这轮**自然收尾**后自动按序发出（默认）；
 *   ③ 中断（interrupt）：掐掉当前生成（Esc 语义），**只由「停止」按钮触发**。
 *
 * ── 为什么独立成模块 ──
 * 入队/出队/改模式/提升/移除都是纯数组运算，却决定"用户的指令会不会被吞"。
 * 住在 `.tsx` 里就只能靠读源码断言；这里可以直接喂输入断言行为（含顺序、幂等、不吞）。
 * 回归守卫见 `tests/core-ts/a1054-queue.spec.ts`。
 *
 * ⚠️ 与 `interruptQueueRef`（A-162）的关系：那个 ref 是**同一份队列的运行时镜像**，
 *    本模块只提供不变式；组件负责把返回值写回 ref 与 React state。**不要**在组件里
 *    另写一套 `push/shift/filter` —— 那样两套口径必然漂移（本项目反复踩过）。
 */

/**
 * 插入方式（A-1060 起三态，对齐主流 Agent 的 busy-input 语义）：
 *
 * - `queue`（默认）：不打断，等当前这轮**自然收尾**后按序发出；
 * - `steer`：**引导** —— 不打断，在**下一个工具调用之后的轮次边界**注入本轮上下文
 *   （Cursor 2026-08-19 steering / Claude Code 排队消息的语义；消费点见
 *   `core-ts/src/tool_loop.ts` 的 `injectSteers`）。若本轮没有工具调用，则退回 `queue` 行为；
 * - `interrupt`：立即停掉当前生成（Esc 语义）。**只由「停止」按钮触发** ——
 *   此前它挂在待发卡片的「直接插入」上，正是用户说的"中间插入还是会直接中断"。
 */
export type InsertMode = "interrupt" | "queue" | "steer";

export interface QueuedInstruction {
  /** 自增序号：React key 与"改哪一条"的身份，**不用数组下标**（删一条后下标全漂） */
  id: number;
  text: string;
  mode: InsertMode;
  /** 本轮随指令携带的图片 dataUrl（与 doSend 的入参同形） */
  images: string[];
  /** 入队时所在会话 —— 出队时必须比对，防跨会话误发 */
  sessionId: string;
  agentId: string;
  networkEnabled?: boolean;
  createdAt: number;
}

/** 自增 id 产地（模块级计数器；不依赖 Date.now，同一毫秒内入队两条也不会撞 key）。 */
let seq = 0;
export function nextQueueId(): number {
  seq += 1;
  return seq;
}

/** 入队（尾部追加 —— 队列语义是"按我说的顺序来"，后到的不能插队）。 */
export function enqueue(list: QueuedInstruction[], item: QueuedInstruction): QueuedInstruction[] {
  return [...list, item];
}

/** 队首（不改动原数组）；空队列 → null。 */
export function peek(list: QueuedInstruction[]): QueuedInstruction | null {
  return list.length > 0 ? list[0] : null;
}

/**
 * 为**指定会话**取出队首可发指令。
 *
 * ⚠️ 只认队首，且只认 `sessionId` 相同的那一条：跨会话的那条必须**留在队列里**等它自己的
 *    会话收尾，不能被顺手发到别的会话去（用户切走再切回时指令必须还在）。
 * 返回 `null` 表示"当前没轮到它"，调用方**不得**顺便 shift（那会吞指令）。
 */
export function takeNext(
  list: QueuedInstruction[],
  sessionId: string,
): { item: QueuedInstruction; rest: QueuedInstruction[] } | null {
  const head = peek(list);
  if (!head) { return null; }
  if (!sessionId || head.sessionId !== sessionId) { return null; }
  return { item: head, rest: list.slice(1) };
}

/** 改某一条的插入方式；id 不存在 → 原样返回（不抛、不静默新建）。 */
export function setMode(list: QueuedInstruction[], id: number, mode: InsertMode): QueuedInstruction[] {
  return list.map((q) => (q.id === id ? { ...q, mode } : q));
}

/**
 * 把某一条提到最前（"立刻插到我前面"）。
 *
 * 用途：用户在队列里把某条改成「中途插入」= 我要它**现在**就走。仅置 mode 是不够的 ——
 * 它前面可能还排着几条，所以必须同时提升到队首，否则"改成立即"却排在别人后面（观感是没反应）。
 */
export function promote(list: QueuedInstruction[], id: number): QueuedInstruction[] {
  const idx = list.findIndex((q) => q.id === id);
  if (idx <= 0) { return list; }
  const hit = list[idx]!;
  return [hit, ...list.slice(0, idx), ...list.slice(idx + 1)];
}

/** 删掉某一条（id 不存在 → 原样返回）。 */
export function removeAt(list: QueuedInstruction[], id: number): QueuedInstruction[] {
  return list.filter((q) => q.id !== id);
}

/** 清空（会话切换/发送失败归还等场景）。 */
export function clearAll(): QueuedInstruction[] {
  return [];
}

/* A-1056③：原先这里有 `describeMode` / `modeHint` / `toggleMode`（"即将插入 / 中途插入"那套
   徽标黑话 + 全局来回切开关）、`previewText`（旧的一行预览）与 `hasPendingFor`（旧顶部提示），
   已随界面改版一并删除 —— 用户原话"即将插入是什么鬼？"。
   ⚠️ **别再往这里补文案函数**：待发指令的新形态是「用户气泡卡片 + 三个图标操作」
   （见 ChatPanel 的 `QueueAction`），它直接复用已发出用户消息的样式与全文，
   不再需要"模式徽标 → 人话"这一层翻译；`summarize` 是仅剩的文案产地。 */
/** 队列摘要（"2 条待发"）：空队列 → ""，供 UI 决定是否整块隐藏。 */
export function summarize(list: QueuedInstruction[]): string {
  return list.length > 0 ? `${list.length} 条待发` : "";
}

/* ─────────────────────────────────────────────────────────────────────────────
 * A-1061⑤：**同一会话绝不并行开第二条流** —— 判据（纯函数）。
 *
 * 用户原话：「现在某些时候中途插入输入时，程序某些时候还是会被中断重新输入正文。
 * 你检查检查，看看是哪里出问题了，这个插入**无论什么时候**都不该打断 agent 输入的」。
 *
 * ## 为什么"被中断重新输入正文"
 *
 * `doSend` 一进来就重置流式现场（partial / toolEvents / 计时器）并 `setLoading(true)` ——
 * 界面上就是**正文从头开始**。而打断的来源只有一个：这里开了**第二条流**
 * （全仓只有「停止」按钮会 `chat.cancel`；插入路径已经不调它了）。
 *
 * ## 为什么不能只判 `loading`
 *
 * A-1051 的「支④」（恢复查询重试耗尽）会**在流仍然活着时** `setLoading(false)` —— 这是刻意
 * 取舍（宁可收 loading 也别让用户无限看"恢复中"）。那一刻 `send()` 的 `loading` 守卫失效
 * → 用户此刻打字回车（或点插入）就真的开了第二条流 → 正是"某些时候被打断"。
 *
 * ## 判据：以"流是否**真的在动**"为准，而不是以 UI 状态为准
 *
 * `streamActiveRef` 是意图，`lastActivityAt` 是**证据**（每个 chunk / 工具事件 / 心跳都会刷新，
 * 心跳 15s 一次 ⇒ 60s 窗口足够）。
 * 用"最近是否有活动"而不是"loading 是否 true"，既覆盖了 loading 被提前收掉的那条路径，
 * 又不会因为粘性 ref 残留而**误吞合法的新发送**（残留会让时间戳变旧 → 自动失效）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 判定"流仍在动"的活动窗口（ms）。心跳 15s 一次，60s 有 4 倍余量 */
export const STREAM_ALIVE_MS = 60_000;

/**
 * 「已接收引导」确认在状态行上停留的时长（A-1061⑦）。
 *
 * 用户原话：「中途输入后，下面的状态行可以返回“模型响应中”之类的」——
 * 投递之后**必须立刻给一句确认**，否则用户不知道那句话有没有被接收
 * （此前只能看到原来的"思考中/正在输出"，感知上就是"点了没反应"）。
 * 但它只是**确认**，不该永久盖住阶段信息（工具/正文状态），所以带窗口自动退场。
 */
export const STEER_ACK_MS = 15_000;

/** 「这次 doSend 该不该**让位**给引导（而不是开新流）」 */
export function shouldDeferToSteer(i: {
  /** 调用方显式要求"就是要开新一轮"（done 后的续发 / 引导的兜底发送）—— 内部调用，不受拦截 */
  forceNewTurn?: boolean;
  /** 本实例是否认为有流在跑（意图） */
  streamActive: boolean;
  /** 本实例的流归属会话（`streamSessionRef.current`） */
  streamSession: string;
  /** 本次要发的目标会话 */
  targetSession: string;
  /** 最近一次流活动时刻（ms；0 = 从未） */
  lastActivityAt: number;
  /** 当前时刻（ms） */
  now: number;
}): boolean {
  if (i.forceNewTurn) { return false; }
  if (!i.streamActive) { return false; }
  // ⚠️ 按**目标会话**判定：在会话 B 发消息时，会话 A 的流不该被牵连
  if (!i.streamSession || i.streamSession !== i.targetSession) { return false; }
  return i.now - i.lastActivityAt < STREAM_ALIVE_MS;
}
