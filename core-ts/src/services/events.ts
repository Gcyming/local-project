






export interface ServiceEvent<T = unknown> {
  seq: number;
  type: string;
  data: T;
}


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


export const globalSequence = new EventSequence();


export function emitEvent<T>(type: string, data: T): ServiceEvent<T> {
  return globalSequence.emit(type, data);
}


export function sseEncode(ev: ServiceEvent<unknown>): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}


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
