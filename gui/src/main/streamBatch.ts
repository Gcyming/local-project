
























import type { StreamChunk } from "../shared/ipc.js";


export const DEFAULT_BATCH_WINDOW_MS = 40;


export const DEFAULT_BATCH_MAX_CHARS = 24_000;


const TEXT_TYPES: ReadonlySet<string> = new Set(["chunk", "reasoning"]);


const NON_COALESCED_FIELDS: ReadonlyArray<keyof StreamChunk["data"]> = [
  "model", "timings", "elapsedMs", "promptTokens", "completionTokens",
  "name", "args", "result", "message", "agentId",
];


export function isCoalescible(chunk: StreamChunk): boolean {
  if (!TEXT_TYPES.has(chunk.type)) { return false; }
  const d = chunk.data as Record<string, unknown>;
  if (typeof d.content !== "string" && typeof d.reasoning !== "string") { return false; }
  for (const f of NON_COALESCED_FIELDS) {
    if (d[f] !== undefined) { return false; }
  }
  return true;
}


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

  
  push(chunk: StreamChunk): void {
    if (this.disposed) { return; }
    if (!isCoalescible(chunk)) {
      
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
    
    this.flush();
    this.pending = { ...chunk, data: { ...chunk.data } };
    this.pendingKey = key;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.windowMs);
    
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.pending;
    this.pending = null;
    this.pendingKey = "";
    if (c) { this.emit(c); }
  }

  
  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private emit(chunk: StreamChunk): void {
    if (this.disposed) { return; }
    try {
      this.send(chunk);
    } catch {
      
    }
  }
}
