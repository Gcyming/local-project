/**
 * gui/src/renderer/pages/TraceViewer.tsx — D：全链路可观测可视化（LangSmith/LangGraph 语义）。
 * - 订阅主进程 slime:trace:update / 快照读取 slime:trace:get
 * - 展示最近一次请求的事件轨迹：route → tool_call(→tool_result) → reasoning/reply 采样 → done + eval
 * - 每条 span 带耗时与事件分类徽章；失败请求红标 eval 归因
 */
import React, { type JSX } from "react";
import type { TraceSnapshot, TraceSpan } from "../../shared/ipc.js";

const KIND_LABEL: Record<TraceSpan["kind"], string> = {
  route_select: "路由",
  memory_retrieve: "记忆",
  tool_call: "工具",
  tool_result: "工具结果",
  reasoning_chunk: "思考",
  reply_chunk: "正文",
  done: "完成",
  eval: "评估",
};

const KIND_COLOR: Record<TraceSpan["kind"], string> = {
  route_select: "#a78bfa",
  memory_retrieve: "#fbbf24",
  tool_call: "#38bdf8",
  tool_result: "#34d399",
  reasoning_chunk: "#c084fc",
  reply_chunk: "#94a3b8",
  done: "#34d399",
  eval: "#f87171",
};

function fmtDur(ms?: number): string {
  if (ms === undefined) { return "—"; }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 单事件行：分类徽章 + 名称 + 耗时 + 时间；tool 行附参数/结果摘要。 */
function SpanRow({ span }: { span: TraceSpan }): JSX.Element {
  const dur = span.endedAt !== undefined ? span.endedAt - span.startedAt : undefined;
  const data = span.data ?? {};
  const content = typeof data.content === "string" ? data.content : undefined;
  const args = typeof data.args === "string" ? data.args : undefined;
  const result = typeof data.result === "string" ? data.result : undefined;
  const failed = data.passed === false;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "54px 1fr auto", gap: 8, alignItems: "baseline",
      padding: "3px 0", fontSize: 11.5, borderBottom: "1px solid var(--border-soft, rgba(128,128,128,0.15))",
    }}>
      <span style={{
        fontSize: 10, textAlign: "center", padding: "1px 4px", borderRadius: 4,
        color: "#0b1220", background: KIND_COLOR[span.kind] ?? "var(--border)", fontWeight: 700, whiteSpace: "nowrap",
      }}>
        {KIND_LABEL[span.kind] ?? span.kind}
      </span>
      <span style={{
        color: failed ? "var(--danger)" : "var(--text)",
        fontWeight: span.kind === "tool_call" || span.kind === "done" ? 600 : 400,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={span.name}>
        {span.name}
      </span>
      <span style={{ color: "var(--text-dim)", fontSize: 10.5, whiteSpace: "nowrap" }}>
        {dur !== undefined || span.endedAt === undefined ? fmtDur(dur) : "→"}
        <span style={{ marginLeft: 6 }}>{fmtTime(span.startedAt)}</span>
      </span>
      {(content || args || result || failed) && (
        <div style={{ gridColumn: "2 / 4", fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5, wordBreak: "break-all" }}>
          {content !== undefined && <div>{content}</div>}
          {args !== undefined && <div>入参：{args}</div>}
          {result !== undefined && <div>结果：{result}</div>}
          {failed && <div style={{ color: "var(--danger)" }}>⛔ 评估未通过</div>}
        </div>
      )}
    </div>
  );
}

/** 单条 trace 渲染体（导出供 F 批次无 DOM 纯渲染测试；hook 数据来源由调用方灌入）。 */
export function TraceBody({ trace }: { trace: TraceSnapshot }): JSX.Element {
  const total = trace.spans.length;
  const doneCount = trace.spans.filter((s) => s.endedAt !== undefined).length;
  const failed = trace.spans.some((s) => s.data?.passed === false);
  const durMs = trace.endedAt !== undefined ? trace.endedAt - trace.startedAt : undefined;
  return (
    <div className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: failed ? "var(--danger)" : "var(--text)" }}>
          {failed ? "⛔ 失败请求链路" : "✓ 请求链路"}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {total} 事件 · {doneCount} 闭合 · 共 {fmtDur(durMs)}
          {trace.sessionId ? ` · ${trace.sessionId.slice(-10)}` : ""}
        </span>
      </div>
      <div style={{ marginTop: 6, maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
        {trace.spans.map((s) => <SpanRow key={s.id} span={s} />)}
      </div>
    </div>
  );
}

/** 共享 store hook：监听所有会话 trace 更新（主事件源），保序去重。 */
export function useTraceStore(): TraceSnapshot[] {
  const [traces, setTraces] = React.useState<TraceSnapshot[]>([]);
  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    if (!w.slimeAPI?.trace?.onUpdate) { return; }
    const off = w.slimeAPI.trace.onUpdate((payload: { sessionId: string; trace: TraceSnapshot }) => {
      setTraces((prev) => {
        const idx = prev.findIndex((t) => t.id === payload.trace.id);
        const next = idx >= 0 ? prev.map((t, i) => (i === idx ? payload.trace : t)) : [...prev, payload.trace];
        return next.slice(-6); // 最多保留 6 条近期链路
      });
    });
    return off;
  }, []);
  return React.useMemo(() => [...traces].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)), [traces]);
}

/** 链路视图面板（默认导出）：按时间倒序列出近期 trace。 */
export default function TraceViewer(): JSX.Element {
  const traces = useTraceStore();
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>链路视图</div>
      {traces.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "10px 0" }}>
          暂无链路记录——发起一次对话后，这里会展示从路由到完成的完整事件轨迹（含工具调用与思考采样）。
        </div>
      ) : (
        traces.map((t) => <TraceBody key={t.id} trace={t} />)
      )}
    </div>
  );
}