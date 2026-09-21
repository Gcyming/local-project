/**
 * gui/src/renderer/pages/instructionQueue.ts — 待发指令队列（中途插入 / 即将插入）的**纯逻辑**。
 *
 * ── 要解决的体验 ──
 * Agent 正在跑（可能是一次几十秒的工具循环）时用户又想补一句。此前只有一种行为：
 * **打断插入**（A-162）—— 发出去就先 `chat.cancel` 掐掉当前生成，再把新指令当作新一轮。
 * 这在一半场景下是错的：用户只是想"再补一句"，并不想废掉正在跑的活。
 * 于是需要**两种**插入方式，并且让用户**看得见、改得动**：
 *   ① 中途插入（interrupt）：掐掉当前生成，本条立刻作为新一轮发出；
 *   ② 即将插入（queue）：不打断，等当前这轮**自然收尾**后自动按序发出。
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

/** 插入方式：打断当前生成 / 等本轮结束。 */
export type InsertMode = "interrupt" | "queue";

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
