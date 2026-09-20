/**
 * gui/src/renderer/pages/SubAgentModal.tsx — 子代理详情弹窗（A-976）。
 * 点击子代理时弹出，显示任务详情、执行状态、输出结果。
 * 尺寸与设置弹窗一致（max-w-2xl, max-h-[80vh]）。
 */
import React, { type JSX, useEffect, useState } from "react";
import { CloseIcon } from "../components/Icon.js";
import SubagentAvatar from "../components/SubagentAvatar.js";
// A-986：子代理产出与聊天正文用**同一个 Markdown 渲染器**（此前是 pre-wrap 贴原文 → 星号/井号/表格全裸）
import Markdown from "./Markdown.js";

interface SubAgentRun {
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

/** A-980-R31：补上 `timeout`（此前超时中断会显示成原始英文 `timeout`） */
const STATUS_META: Record<string, { txt: string; c: string; bg: string }> = {
  pending: { txt: "排队中", c: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
  running: { txt: "执行中", c: "#22c55e", bg: "rgba(34,197,94,0.1)" },
  done: { txt: "已完成", c: "#22c55e", bg: "rgba(34,197,94,0.1)" },
  fail: { txt: "失败", c: "#f87171", bg: "rgba(248,113,113,0.1)" },
  timeout: { txt: "超时中断", c: "#fbbf24", bg: "rgba(251,191,36,0.1)" },
  cancelled: { txt: "已取消", c: "var(--text-muted)", bg: "rgba(139,148,158,0.1)" },
};

interface Props {
  runId: string;
  onClose: () => void;
}

export default function SubAgentModal({ runId, onClose }: Props): JSX.Element {
  const [run, setRun] = useState<SubAgentRun | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = React.useCallback((): void => {
    const w = window as unknown as { slimeAPI?: any };
    void w.slimeAPI?.resident?.state?.()
      .then((s: { subagents?: SubAgentRun[] }) => {
        const found = s?.subagents?.find((r) => r.id === runId) ?? null;
        setRun(found);
        setLoading(false);
      })
      .catch(() => { setLoading(false); });
  }, [runId]);

  useEffect(() => {
    refresh();
    // A-978：轮询刷新（2s），让运行中的子代理输出实时更新
    const iv = window.setInterval(refresh, 2000);
    return () => { window.clearInterval(iv); };
  }, [refresh]);

  const meta = run ? (STATUS_META[run.status] ?? { txt: run.status, c: "var(--text-dim)", bg: "transparent" }) : null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 99999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 1180, maxWidth: "96vw", height: "84vh", maxHeight: "90vh",
          background: "var(--bg-card, #1e293b)", borderRadius: 12,
          border: "1px solid var(--border)", boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-secondary, #0f172a)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {run && <SubagentAvatar name={run.name} size={30} running={run.status === "running"} />}
            <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text)" }}>{run ? run.name : "子代理详情"}</span>
            {run && meta && (
              <span style={{
                fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                color: meta.c, background: meta.bg,
              }}>
                {meta.txt}
              </span>
            )}
          </div>
          <button onClick={onClose} style={{
            background: "transparent", border: "none", cursor: "pointer",
            color: "var(--text-muted)", padding: 4, display: "flex",
          }}>
            <CloseIcon size={18} />
          </button>
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>加载中…</div>
          ) : !run ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>未找到该子代理</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* 基本信息 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <InfoItem label="名称" value={run.name} />
                <InfoItem label="模型" value={run.model ?? "继承主对话"} />
                <InfoItem label="开始时间" value={run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "—"} />
                <InfoItem label="完成时间" value={run.finishedAt ? new Date(run.finishedAt).toLocaleString("zh-CN") : "—"} />
                {/* A-980-R31：把生效的执行预算写明——判"超时"时用户能立刻分辨是预算太紧还是被误判 */}
                <InfoItem label="执行预算" value={run.timeoutMs ? `${(run.timeoutMs / 1000).toFixed(0)} 秒（到点强制中断）` : "不限时"} />
                <InfoItem label="实际耗时" value={
                  run.startedAt && run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} 秒` : "—"
                } />
              </div>

              {/* 任务 */}
              {run.task && (
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6, fontWeight: 600 }}>任务</div>
                  <div style={{
                    padding: 12, background: "var(--bg-hover, #334155)", borderRadius: 8,
                    fontSize: 13, color: "var(--text)", lineHeight: 1.6,
                  }}>
                    {/* A-986：任务文本同样是 Markdown（派发指令里常带 **强调**、`反引号路径`、列表），
                        与聊天正文统一渲染口径，避免"同一段文字在两处长得不一样"。 */}
                    <Markdown text={run.task} />
                  </div>
                </div>
              )}

              {/* 中断原因（timeout / cancelled 也会给出原因，不再只有 fail 才显示） */}
              {run.error && run.status !== "fail" && run.status !== "done" && (
                <div>
                  <div style={{ fontSize: 12, color: "#fbbf24", marginBottom: 6, fontWeight: 600 }}>中断原因</div>
                  <div style={{
                    padding: 12, background: "rgba(251,191,36,0.1)", borderRadius: 8,
                    fontSize: 13, color: "#fbbf24", lineHeight: 1.6, whiteSpace: "pre-wrap",
                  }}>
                    {run.error}
                  </div>
                </div>
              )}

              {/* 输出结果 */}
              {run.result && (
                <div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6, fontWeight: 600 }}>
                    {/* A-980-R31：中断的 run 现在保留部分产出，标题必须说清这是残稿而不是完整结果 */}
                    {run.status === "done" ? "输出结果" : "中断前已产出的部分内容（残稿，未必完整）"}
                  </div>
                  <div style={{
                    padding: 12, background: "var(--bg-hover, #334155)", borderRadius: 8,
                    fontSize: 13, color: "var(--text)", lineHeight: 1.6,
                    maxHeight: 300, overflow: "auto",
                  }}>
                    {/* A-986：与聊天正文**同一个渲染器**。此前这里用 `whiteSpace: pre-wrap` 直接贴原文，
                        于是子代理写的 Markdown 全部原样暴露：`**结论**` 显示成星号、`## 小标题` 显示成井号、
                        `|---|` 表格变成一堆竖线（用户实测截图）。子代理产出本就是 Markdown，
                        与主对话一视同仁即可（同一个组件 = 同一套排版/代码块/表格/链接规则）。 */}
                    <Markdown text={run.result} />
                  </div>
                </div>
              )}

              {/* 错误信息 */}
              {run.error && run.status === "fail" && (
                <div>
                  <div style={{ fontSize: 12, color: "#f87171", marginBottom: 6, fontWeight: 600 }}>错误信息</div>
                  <div style={{
                    padding: 12, background: "rgba(248,113,113,0.1)", borderRadius: 8,
                    fontSize: 13, color: "#f87171", lineHeight: 1.6, whiteSpace: "pre-wrap",
                  }}>
                    {run.error}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{value}</div>
    </div>
  );
}
