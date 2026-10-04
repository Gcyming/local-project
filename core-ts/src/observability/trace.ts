







import { randomUUID } from "node:crypto";

export type TraceEventKind =
  | "route_select"
  | "memory_retrieve"
  | "tool_call"
  | "tool_result"
  | "reasoning_chunk"
  | "reply_chunk"
  | "done"
  | "eval";

export interface TraceSpan {
  id: string;
  name: string;
  kind: TraceEventKind;
  parentId?: string;
  startedAt: number;
  endedAt?: number;
  data?: Record<string, unknown>;
}

export interface Trace {
  id: string;
  sessionId?: string;
  spans: TraceSpan[];
  startedAt: number;
  endedAt?: number;
}

export interface SpanInput {
  name: string;
  kind: TraceEventKind;
  parentId?: string;
  data?: Record<string, unknown>;
}


export function createTrace(opts: { id?: string; sessionId?: string } = {}): Trace {
  const now = Date.now();
  return { id: opts.id ?? randomUUID(), sessionId: opts.sessionId, spans: [], startedAt: now };
}


export function beginSpan(trace: Trace, input: SpanInput): { trace: Trace; spanId: string } {
  const span: TraceSpan = {
    id: randomUUID(),
    name: input.name,
    kind: input.kind,
    parentId: input.parentId,
    startedAt: Date.now(),
    data: input.data,
  };
  return { trace: { ...trace, spans: [...trace.spans, span] }, spanId: span.id };
}


export function endSpan(trace: Trace, spanId: string, data?: Record<string, unknown>): Trace {
  return {
    ...trace,
    spans: trace.spans.map((s) => {
      if (s.id !== spanId || s.endedAt !== undefined) { return s; }
      return { ...s, endedAt: Date.now(), data: data ? { ...(s.data ?? {}), ...data } : s.data };
    }),
  };
}


export function emitEvent(trace: Trace, kind: TraceEventKind, name: string, data?: Record<string, unknown>): Trace {
  const now = Date.now();
  return {
    ...trace,
    endedAt: kind === "done" ? now : trace.endedAt,
    spans: [...trace.spans, { id: randomUUID(), name, kind, startedAt: now, endedAt: now, data }],
  };
}


export function attachEval(
  trace: Trace,
  gate: "tool" | "completion" | "memory",
  passed: boolean,
  notes?: string,
): Trace {
  return emitEvent(trace, "eval", `eval:${gate}`, { passed, notes });
}


export function summarize(trace: Trace): {
  id: string;
  total: number;
  ended: number;
  failed: boolean;
  durationMs?: number;
  events: Array<{ name: string; kind: TraceEventKind; durationMs?: number }>;
} {
  const events = trace.spans.map((s) => ({
    name: s.name,
    kind: s.kind,
    durationMs: s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined,
  }));
  const failed = trace.spans.some((s) => s.data?.passed === false || s.data?.level === "block");
  return {
    id: trace.id,
    total: trace.spans.length,
    ended: trace.spans.filter((s) => s.endedAt !== undefined).length,
    failed,
    durationMs: trace.endedAt !== undefined ? trace.endedAt - trace.startedAt : undefined,
    events,
  };
}


export function traceToJSON(trace: Trace): string {
  return JSON.stringify(trace, null, 2);
}


export function parseTrace(raw: string): Trace | null {
  try {
    const t = JSON.parse(raw) as Trace;
    if (!t || typeof t.id !== "string" || !Array.isArray(t.spans)) { return null; }
    return t;
  } catch { return null; }
}