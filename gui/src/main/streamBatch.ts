/**
 * gui/src/main/streamBatch.ts — 流式 chunk 的**发送侧合批**（A-980-R24）。
 *
 * ## 为什么需要
 * 上游每吐一个 SSE delta，`core-ts/src/llm/client.ts` 就回调一次 → engine 逐条 yield →
 * 主进程逐条 `webContents.send("slime:chat:chunk", chunk)`。**没有任何合批**。
 *
 * 高速率模型（每秒数百 token）于是变成每秒数百条 IPC 消息。Electron 的 `webContents.send`
 * **没有背压**：渲染进程一旦来不及处理（它同时还要跑 Markdown 全量重解析），主进程侧的消息
 * 队列只增不减 → 渲染进程内存被顶爆。项目里已经真实发生过：
 * `data/logs/renderer-crash.log` 记录过 `oom (exit=-536870904)`，
 * 用户侧的表现就是"**用着用着 slime 直接崩溃、任务直接中断**"。
 *
 * ## 做法
 * 在**发送侧**把「同一条流 + 同一类型」的纯文本增量在一个短时间窗内合并成一条再发。
 * 默认窗口 40ms ≈ 25 帧/秒，与渲染层的 rAF 合帧节拍同量级，观感无损，但 IPC 消息数下降 1~2 个数量级。
 *
 * ## 边界（重要，别扩大）
 * - 合并**只发生在发送侧**：调用方仍然按原始 chunk 记录日志 / 累积 `fullReply`，
 *   断线重放与轨迹数据完全不受影响。
 * - **不可合并的事件一律立即下发，绝不延迟**：`done` / `error` / `tool` / `progress` / 心跳，
 *   以及群聊 `member`（按成员分流）、带 `model`/`timings`/token 统计的帧——这些是驱动状态机的关键帧。
 * - 顺序必须保持：遇到不可合并的帧时，先把待发帧 flush 出去，再发该帧。
 */

import type { StreamChunk } from "../shared/ipc.js";

/** 默认合批窗口（毫秒）。40ms ≈ 25 帧/秒；调大更省 IPC，但首字延迟会变明显。 */
export const DEFAULT_BATCH_WINDOW_MS = 40;

/** 单条合并帧的字符上限：超出就立刻 flush，避免"一条超大 IPC 消息"反过来卡渲染。 */
export const DEFAULT_BATCH_MAX_CHARS = 24_000;

/** 适合合批的纯文本增量类型（正文 / 思考） */
const TEXT_TYPES: ReadonlySet<string> = new Set(["chunk", "reasoning"]);

/** 这些字段一旦出现，说明该帧还带着状态/统计语义，必须立即下发 */
const NON_COALESCED_FIELDS: ReadonlyArray<keyof StreamChunk["data"]> = [
  "model", "timings", "elapsedMs", "promptTokens", "completionTokens",
  "name", "args", "result", "message", "agentId",
];

/** 该帧能否与其他帧合并成一条 */
export function isCoalescible(chunk: StreamChunk): boolean {
  if (!TEXT_TYPES.has(chunk.type)) { return false; }
  const d = chunk.data as Record<string, unknown>;
  if (typeof d.content !== "string" && typeof d.reasoning !== "string") { return false; }
  for (const f of NON_COALESCED_FIELDS) {
    if (d[f] !== undefined) { return false; }
  }
  return true;
}

/** 合并键：跨流 / 跨类型合并会把内容串到一起，必须区分 */
function mergeKey(chunk: StreamChunk): string {
  return `${chunk.type}\u0000${chunk.data.sessionId ?? ""}`;
}

export class StreamChunkBatcher {
  private pending: StreamChunk | null = null;
  private pendingKey = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly send: (chunk: StreamChunk) => void,
    private readonly windowMs: number = DEFAULT_BATCH_WINDOW_MS,
    private readonly maxChars: number = DEFAULT_BATCH_MAX_CHARS,
  ) {}

  /** 入队一帧；够窗口/够大/不可合并时就发出去 */
  push(chunk: StreamChunk): void {
    if (this.disposed) { return; }
    if (!isCoalescible(chunk)) {
      // 关键帧：先按序把待发文本 flush，再原样下发
      this.flush();
      this.emit(chunk);
      return;
    }
    const key = mergeKey(chunk);
    if (this.pending && this.pendingKey === key) {
      const prev = this.pending;
      this.pending = {
        ...prev,
        seq: chunk.seq,
        data: {
          ...prev.data,
          content: (prev.data.content ?? "") + (chunk.data.content ?? ""),
          reasoning: (prev.data.reasoning ?? "") + (chunk.data.reasoning ?? ""),
        },
      };
      const len = (this.pending.data.content?.length ?? 0) + (this.pending.data.reasoning?.length ?? 0);
      if (len >= this.maxChars) { this.flush(); }
      return;
    }
    // 流/类型切换：先把上一段发出去，保持顺序
    this.flush();
    this.pending = { ...chunk, data: { ...chunk.data } };
    this.pendingKey = key;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.windowMs);
    // 定时器不该拖住进程退出
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** 立即下发待发帧。**done/error 之前必须调用**，否则最后一小段正文可能晚于 done 到达。 */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.pending;
    this.pending = null;
    this.pendingKey = "";
    if (c) { this.emit(c); }
  }

  /** 关闭：flush 剩余内容，之后的 push 一律丢弃 */
  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private emit(chunk: StreamChunk): void {
    if (this.disposed) { return; }
    try {
      this.send(chunk);
    } catch {
      // 渲染进程正在重载/销毁：丢这一帧即可，重载后按需继续（不在此处刷错误日志）
    }
  }
}
