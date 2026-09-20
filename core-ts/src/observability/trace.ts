/**
 * core-ts/src/observability/trace.ts — 全链路可观测骨架（LangSmith/LangGraph trace 语义对标）。
 *
 * 目标：一次 Agent 请求从路由到完成的事件轨迹（trace）可被记录、关联、导出——事件流
 * route_select → memory_retrieve → tool_call → tool_result → reasoning_chunk → reply_chunk → done，
 * 支持 span 父子关联（工具轮内嵌套）与评估门禁结果（eval）挂载。纯函数、可序列化。
 * 装配方（引擎 stream）负责在真实事件点调用 begin/end；本模块只做记录与汇总。
 */
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

/** 创建 trace（幂等：可显式传 id）。 */
export function createTrace(opts: { id?: string; sessionId?: string } = {}): Trace {
  const now = Date.now();
  return { id: opts.id ?? randomUUID(), sessionId: opts.sessionId, spans: [], startedAt: now };
}

/** 开始一个 span；返回 (trace, spanId)。父 span 缺失时挂顶层。 */
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

/** 结束 span（补 endedAt 与 data 合并；不存在或已结束则原样返回）。 */
export function endSpan(trace: Trace, spanId: string, data?: Record<string, unknown>): Trace {
  return {
    ...trace,
    spans: trace.spans.map((s) => {
      if (s.id !== spanId || s.endedAt !== undefined) { return s; }
      return { ...s, endedAt: Date.now(), data: data ? { ...(s.data ?? {}), ...data } : s.data };
    }),
  };
}

/** 记录一个无耗时标记事件（如 reasoning/reply chunk 采样、done）。 */
export function emitEvent(trace: Trace, kind: TraceEventKind, name: string, data?: Record<string, unknown>): Trace {
  const now = Date.now();
  return {
    ...trace,
    endedAt: kind === "done" ? now : trace.endedAt,
    spans: [...trace.spans, { id: randomUUID(), name, kind, startedAt: now, endedAt: now, data }],
  };
}

/** 挂载评估门禁结果（工具调用后/完成声明后/记忆写入前）。 */
export function attachEval(
  trace: Trace,
  gate: "tool" | "completion" | "memory",
  passed: boolean,
  notes?: string,
): Trace {
  return emitEvent(trace, "eval", `eval:${gate}`, { passed, notes });
}

/** 汇总：span 计数 / 含 duration 的已结束 span 列表（供前端 TraceViewer）。 */
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

/** 序列化导出（落盘/上报）。 */
export function traceToJSON(trace: Trace): string {
  return JSON.stringify(trace, null, 2);
}

/** 从 JSON 还原；失败返回 null。 */
export function parseTrace(raw: string): Trace | null {
  try {
    const t = JSON.parse(raw) as Trace;
    if (!t || typeof t.id !== "string" || !Array.isArray(t.spans)) { return null; }
    return t;
  } catch { return null; }
}