/**
 * gui/src/renderer/pages/SubAgentBar.tsx — 输入栏上方的子代理活动折叠条（A-918++）。
 * 实时显示后台子代理（运行中 / 已完成），事件驱动即时刷新；有活动才出现，不占位。
 */
import React, { type JSX } from "react";

interface SubRun {
  id: string; name: string; status: string; result?: string; error?: string; startedAt?: number; finishedAt?: number;
}

const STATUS_META: Record<string, { txt: string; c: string }> = {
  pending: { txt: "排队中", c: "var(--text-muted)" },
  running: { txt: "执行中", c: "#22c55e" },
  done: { txt: "完成", c: "#22c55e" },
  fail: { txt: "失败", c: "#f87171" },
  cancelled: { txt: "已取消", c: "var(--text-muted)" },
};

export default function SubAgentBar(): JSX.Element | null {
  const [runs, setRuns] = React.useState<SubRun[]>([]);
  const [open, setOpen] = React.useState(false);

  const refresh = React.useCallback((): void => {
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.state?.()
      .then((s: { subagents?: SubRun[] }) => { if (Array.isArray(s?.subagents)) { setRuns(s.subagents); } })
      .catch(() => { /* 服务未就绪 */ });
  }, []);

  React.useEffect(() => {
    refresh();
    const w = window as unknown as { slimeAPI?: any };
    // A-918++：订阅后台实时推送（subagent start/complete 立即刷新，5s 轮询兜底）
    const off = w.slimeAPI?.resident?.onUpdate?.(() => refresh());
    const iv = window.setInterval(refresh, 5000);
    return () => { off?.(); window.clearInterval(iv); };
  }, [refresh]);

  const running = runs.filter((r) => r.status === "running" || r.status === "pending");
  const recent = runs.filter((r) => r.status === "done" || r.status === "fail").slice(-5).reverse();
  if (runs.length === 0) { return null; }

  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg)", fontSize: 12, flexShrink: 0 }}>
      <button onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 7, padding: "5px 16px", background: "transparent", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: running.length > 0 ? "#22c55e" : "var(--text-dim)", animation: running.length > 0 ? "liveDot 1.5s ease-in-out infinite" : "none" }} />
        <span style={{ fontWeight: 700, color: "var(--text)" }}>后台任务</span>
        {running.length > 0 && <span style={{ color: "#22c55e", fontWeight: 700 }}>{running.length} 个执行中</span>}
        {running.length === 0 && recent.length > 0 && <span style={{ color: "var(--text-dim)" }}>{recent.length} 个已完成</span>}
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 11 }}>{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          {[...running, ...recent].map((r) => {
            const m = STATUS_META[r.status] ?? { txt: r.status, c: "var(--text-dim)" };
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", borderRadius: 6, background: "var(--bg-hover)" }}>
                <span style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{r.name}</span>
                <span style={{ fontSize: 11, color: m.c, flexShrink: 0 }}>{m.txt}</span>
                {r.status === "fail" && r.error && <span style={{ fontSize: 11, color: "#f87171", flexShrink: 0 }} title={r.error}>⚠</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
