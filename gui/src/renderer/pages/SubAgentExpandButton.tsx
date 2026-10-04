
















import React, { type JSX, useEffect, useState } from "react";
import SubAgentModal from "./SubAgentModal.js";
import SubagentAvatar from "../components/SubagentAvatar.js";
import { ChevronIcon } from "../components/Icon.js";
import { dockSlotClassOf } from "./floatDock.js";
import { latestSubagentRuns, subagentPanelCountLabel, SUBAGENT_PANEL_LIMIT } from "./subAgentPanel.js";

interface SubRun {
  id: string;
  name: string;
  status: string;
  task?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  model?: string;
  timeoutMs?: number;
}






const STATUS_META: Record<string, { txt: string; c: string }> = {
  pending: { txt: "排队", c: "#fbbf24" },
  running: { txt: "运行", c: "#22c55e" },
  done: { txt: "完成", c: "#22c55e" },
  fail: { txt: "失败", c: "#f87171" },
  timeout: { txt: "超时中断", c: "#fbbf24" },
  cancelled: { txt: "取消", c: "var(--text-muted)" },
};

export default function SubAgentExpandButton(
  { open, onToggle }: { open: boolean; onToggle: () => void },
): JSX.Element | null {
  const [runs, setRuns] = useState<SubRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = React.useCallback((): void => {
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.state?.()
      .then((s: { subagents?: SubRun[] }) => { if (Array.isArray(s?.subagents)) { setRuns(s.subagents); } })
      .catch(() => {  });
  }, []);

  useEffect(() => {
    refresh();
    const w = window as unknown as { slimeAPI?: any };
    const off = w.slimeAPI?.resident?.onUpdate?.(() => refresh());
    const iv = window.setInterval(refresh, 3000);
    return () => { off?.(); window.clearInterval(iv); };
  }, [refresh]);

  const active = runs.filter((r) => r.status === "running" || r.status === "pending");
  

  const visible = latestSubagentRuns(runs);
  








  if (runs.length === 0) { return null; }

  return (
    <>
      {
}
      <div className="dock-panel">
        <div className={`collapse${open ? " is-open" : ""}`}>
          <div className="dock-panel-card">
            <div style={{
              padding: "8px 11px", borderBottom: "1px solid var(--border)",
              fontSize: 12, fontWeight: 700, color: "var(--text)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span title={`这里只看最近 ${SUBAGENT_PANEL_LIMIT} 条（完整历史在 设置 → 子代理，可手动清空）`}>
                {subagentPanelCountLabel(runs.length, visible.length)}
              </span>
              <button
                onClick={onToggle}
                title="收起"
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", fontSize: 14, padding: 0,
                }}
              >✕</button>
            </div>
            {
}
            <div
              data-subagent-panel-list
              style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 340, overflow: "auto" }}
            >
              {visible.map((r) => {
                const m = STATUS_META[r.status] ?? { txt: r.status, c: "var(--text-dim)" };
                return (
                  <button
                    key={r.id}
                    onClick={() => { setSelectedId(r.id); onToggle(); }}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 10px", borderRadius: 6, background: "var(--bg-hover)",
                      border: "none", cursor: "pointer", textAlign: "left",
                    }}
                  >
                    {}
                    <SubagentAvatar name={r.name} size={22} running={r.status === "running"} />
                    <span style={{
                      flex: 1, fontSize: 12, fontWeight: 600, color: "var(--text)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {r.name}
                    </span>
                    <span style={{ fontSize: 11, color: m.c, flexShrink: 0 }}>{m.txt}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {
}
      <span className={dockSlotClassOf(open)}>
        <button
          className="dock-pill"
          onClick={onToggle}
          title={active.length > 0 ? `${active.length} 个子代理运行中` : "查看子代理"}
        >
          <span style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: active.length > 0 ? "#22c55e" : "var(--text-dim)",
            animation: active.length > 0 ? "liveDot 1.5s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontWeight: 600, flexShrink: 0 }}>子代理</span>
          {








}
          <span style={{
            flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
            minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, lineHeight: 1,
            background: "var(--bg-hover)", border: "1px solid var(--border)",
            color: "var(--text-muted)", fontSize: 10.5, fontWeight: 600,
          }}>{runs.length}</span>
          {}
          {}
          <ChevronIcon size={10} rotate={open ? 90 : 270} style={{ flexShrink: 0 }} />
        </button>
      </span>

      {}
      {selectedId && (
        <SubAgentModal runId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </>
  );
}
