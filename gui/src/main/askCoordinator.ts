import type { AskUserDecision } from "../shared/ipc.js";

export interface AskClock {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface AskOpenInput {
  requestId: string;
  ownerKey: string;
  agentId: string;
  settle: (decision: AskUserDecision) => void;
  onTimeout?: () => void;
  onCancel?: (reason: string) => void;
}

export const DEFAULT_ASK_TIMEOUT_MS = 180_000;

export const ASK_CANCEL_REASON = "用户停止了本次生成，提问已作废";

export function buildAskCancelDecision(requestId: string): AskUserDecision {
  return { requestId, answer: "", skipped: true, cancelled: true };
}

export function buildAskTimeoutDecision(requestId: string): AskUserDecision {
  return { requestId, answer: "", skipped: true };
}

interface AskEntry {
  requestId: string;
  ownerKey: string;
  agentId: string;
  settle: (decision: AskUserDecision) => void;
  onTimeout?: () => void;
  onCancel?: (reason: string) => void;
  timer: unknown;
}

export class AskCoordinator {
  private readonly pending = new Map<string, AskEntry>();
  private readonly timeoutMs: number;
  private readonly clock: AskClock;

  constructor(opts?: { timeoutMs?: number; clock?: Partial<AskClock> }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.clock = {
      setTimer: opts?.clock?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts?.clock?.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  get size(): number {
    return this.pending.size;
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  requestIds(): string[] {
    return [...this.pending.keys()];
  }

  open(input: AskOpenInput): boolean {
    if (this.pending.has(input.requestId)) { return false; }
    const entry: AskEntry = { ...input, timer: undefined };
    entry.timer = this.clock.setTimer(() => {
      const taken = this.take(input.requestId);
      if (!taken) { return; }
      taken.onTimeout?.();
      taken.settle(buildAskTimeoutDecision(taken.requestId));
    }, this.timeoutMs);
    this.pending.set(input.requestId, entry);
    return true;
  }

  resolve(requestId: string, decision: AskUserDecision): boolean {
    const entry = this.take(requestId);
    if (!entry) { return false; }
    entry.settle(decision);
    return true;
  }

  cancelByKey(key: string, reason: string = ASK_CANCEL_REASON): string[] {
    const hit = [...this.pending.values()].filter((e) => e.ownerKey === key || e.agentId === key);
    return this.settleAll(hit, reason);
  }

  cancelAll(reason: string = ASK_CANCEL_REASON): string[] {
    return this.settleAll([...this.pending.values()], reason);
  }

  private settleAll(entries: AskEntry[], reason: string): string[] {
    const settled: string[] = [];
    for (const entry of entries) {
      const taken = this.take(entry.requestId);
      if (!taken) { continue; }
      settled.push(taken.requestId);
      taken.onCancel?.(reason);
      taken.settle(buildAskCancelDecision(taken.requestId));
    }
    return settled;
  }

  private take(requestId: string): AskEntry | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) { return undefined; }
    this.pending.delete(requestId);
    this.clock.clearTimer(entry.timer);
    return entry;
  }
}

export function releaseAsksOnAbort(
  signal: AbortSignal,
  key: string,
  coordinator: AskCoordinator,
  onReleased?: (requestIds: string[]) => void,
): void {
  signal.addEventListener("abort", () => {
    const released = coordinator.cancelByKey(key);
    if (released.length > 0) { onReleased?.(released); }
  }, { once: true });
}