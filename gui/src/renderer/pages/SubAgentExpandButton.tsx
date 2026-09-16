/**
 * gui/src/renderer/pages/SubAgentExpandButton.tsx — 监测栏右侧子代理展开按钮（A-976）。
 * 有活跃子代理时显示向上箭头，点击弹出详情列表。
 */
import React, { type JSX, useEffect, useState } from "react";
import SubAgentModal from "./SubAgentModal.js";
import SubagentAvatar from "../components/SubagentAvatar.js";

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

/**
 * A-980-R31：补上 `timeout`。
 * 此前缺这一项，超时中断的子代理在下拉里显示成**原始英文 `timeout`**（STATUS_META 未命中 →
 * 回落 `{ txt: r.status }`），而同一套状态在设置页里明明写着"⏱ 超时中断"——同一种事实两种说法。
 */
const STATUS_META: Record<string, { txt: string; c: string }> = {
  pending: { txt: "排队", c: "#fbbf24" },
  running: { txt: "运行", c: "#22c55e" },
  done: { txt: "完成", c: "#22c55e" },
  fail: { txt: "失败", c: "#f87171" },
  timeout: { txt: "超时中断", c: "#fbbf24" },
  cancelled: { txt: "取消", c: "var(--text-muted)" },
};

export default function SubAgentExpandButton(): JSX.Element | null {
  const [runs, setRuns] = useState<SubRun[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = React.useCallback((): void => {
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.state?.()
      .then((s: { subagents?: SubRun[] }) => { if (Array.isArray(s?.subagents)) { setRuns(s.subagents); } })
      .catch(() => { /* 服务未就绪 */ });
  }, []);

  useEffect(() => {
    refresh();
    const w = window as unknown as { slimeAPI?: any };
    const off = w.slimeAPI?.resident?.onUpdate?.(() => refresh());
    const iv = window.setInterval(refresh, 3000);
    return () => { off?.(); window.clearInterval(iv); };
  }, [refresh]);

  const active = runs.filter((r) => r.status === "running" || r.status === "pending");
  if (runs.length === 0) { return null; }

  return (
    <>
      <span style={{ color: "var(--text-dim)" }}>|</span>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: active.length > 0 ? "#22c55e" : "var(--text-muted)",
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 6px", fontSize: 11,
        }}
        title={active.length > 0 ? `${active.length} 个子代理运行中` : "查看子代理"}
      >
        <span style={{
          display: "inline-block", width: 6, height: 6, borderRadius: "50%",
          background: active.length > 0 ? "#22c55e" : "var(--text-dim)",
          animation: active.length > 0 ? "liveDot 1.5s ease-in-out infinite" : "none",
        }} />
        <span style={{ fontWeight: 600 }}>{runs.length}</span>
        <span style={{
          transform: open ? "rotate(180deg)" : "none",
          transition: "transform 0.2s",
          display: "inline-block",
        }}>
          ▲
        </span>
      </button>

      {/* 展开列表 */}
      {open && (
        <div
          style={{
            position: "absolute", bottom: "100%", right: 14, marginBottom: 8,
            width: 320, maxHeight: 400, overflow: "auto",
            background: "var(--bg-card, #1e293b)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
            zIndex: 100,
          }}
        >
          <div style={{
            padding: "10px 12px", borderBottom: "1px solid var(--border)",
            fontSize: 12, fontWeight: 700, color: "var(--text)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>子代理 ({runs.length})</span>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--text-muted)", fontSize: 14, padding: 0,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            {runs.slice().reverse().map((r) => {
              const m = STATUS_META[r.status] ?? { txt: r.status, c: "var(--text-dim)" };
              return (
                <button
                  key={r.id}
                  onClick={() => { setSelectedId(r.id); setOpen(false); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 6, background: "var(--bg-hover, #334155)",
                    border: "none", cursor: "pointer", textAlign: "left",
                  }}
                >
                  {/* A-980-R31：与设置页同一套头像（图标=身份），下拉与详情里能一眼对上人 */}
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
      )}

      {/* 详情弹窗 */}
      {selectedId && (
        <SubAgentModal runId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </>
  );
}
