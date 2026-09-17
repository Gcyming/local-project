/**
 * core-ts/src/services/events.ts — 服务事件流统一格式（v2.6 定案）。
 * 所有 core-ts 服务事件统一为 `{ seq, type, data }` 序号事件对象：
 * - IPC（结构化克隆）与 SSE（JSON）同传同一格式
 * - SSE 客户端断线凭 seq 重连补漏
 */

export interface ServiceEvent<T = unknown> {
  seq: number;
  type: string;
  data: T;
}

/** 序号事件流工具：单消费者按序发号（对齐 Python 事件序列语义） */
export class EventSequence {
  private nextSeq = 1;

  next(): number {
    return this.nextSeq++;
  }

  emit<T>(type: string, data: T): ServiceEvent<T> {
    return { seq: this.next(), type, data };
  }

  reset(seq = 1): void {
    this.nextSeq = seq;
  }

  get current(): number {
    return this.nextSeq - 1;
  }
}

/** 全局共享序号（服务级事件流；IPC 与 SSE 共用同一序列保证断线重连可补漏） */
export const globalSequence = new EventSequence();

/** 构造带全局序号的 ServiceEvent */
export function emitEvent<T>(type: string, data: T): ServiceEvent<T> {
  return globalSequence.emit(type, data);
}

/** SSE 编码：单事件 data 帧（UTF-8 原文，对齐 Python ensure_ascii=False 语义） */
export function sseEncode(ev: ServiceEvent<unknown>): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/** 事件流消息类型（端点级统一；对齐 Python SSE 事件名） */
export const STREAM_EVENT_TYPES = [
  "chunk",
  "tool",
  "reasoning",
  "progress",
  "done",
  "error",
  "heartbeat",
] as const;
export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];
