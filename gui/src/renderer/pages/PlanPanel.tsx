





import React, { type JSX } from "react";
import type { PlanInfo, PlanStage } from "../../shared/ipc.js";


export function planProgress(plan: PlanInfo): { done: number; total: number; pct: number } {
  const total = Math.max(1, plan.stages.length);
  const done = plan.stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total, pct: Math.round((done / total) * 100) };
}

const STATUS_TEXT: Record<PlanStage["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};

function statusColor(status: PlanStage["status"]): string {
  switch (status) {
    case "done": return "var(--success)";
    case "failed": return "var(--danger)";
    case "in_progress": return "var(--accent)";
    default: return "var(--text-muted)";
  }
}


export function PlanCard({ plan, sessionLabel }: { plan: PlanInfo; sessionLabel?: string }): JSX.Element {
  const p = planProgress(plan);
  const failed = plan.status === "failed";
  const done = plan.status === "done";
  return (
    <div className="card" style={{ padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {plan.description}
        </div>
        <span style={{
          fontSize: 10.5, color: done ? "var(--success)" : failed ? "var(--danger)" : "var(--text-secondary)",
          fontWeight: 600, whiteSpace: "nowrap",
        }}>
          {done ? "已完成" : failed ? "已失败" : `${p.done}/${p.total} 阶段`}
        </span>
      </div>
      {sessionLabel && (
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 2 }}>会话：{sessionLabel}</div>
      )}
      {
}
      {plan.source && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, opacity: 0.85 }}>
          {plan.source === "todo" ? "来源：待办清单（只读镜像）" : "来源：plan_create（结构化计划）"}
        </div>
      )}
      <div style={{ height: 6, background: "var(--border)", borderRadius: 3, marginTop: 6, overflow: "hidden" }}>
        <div style={{
          width: `${p.pct}%`, height: "100%",
          background: failed ? "var(--danger)" : "var(--accent)",
          borderRadius: 3, transition: "width 0.3s",
        }} />
      </div>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
        {plan.stages.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: statusColor(s.status),
              boxShadow: s.status === "in_progress" ? "0 0 4px var(--accent)" : undefined,
            }} />
            <span style={{
              color: s.status === "done" ? "var(--text-muted)" : "var(--text-secondary)",
              textDecoration: s.status === "done" ? "line-through" : undefined,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
            }}>
              {s.label}
            </span>
            <span style={{ color: statusColor(s.status), fontSize: 10, flexShrink: 0 }}>{STATUS_TEXT[s.status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


export function PlanCardList({ plans }: { plans: PlanInfo[] }): JSX.Element {
  if (plans.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "10px 0" }}>
        暂无进行中的任务计划——Agent 遇到多步任务时会先规划（plan_create/todo_write）再逐步推进。
      </div>
    );
  }
  return (
    <div>
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </div>
  );
}


export function usePlanStore(): PlanInfo[] {
  const [plans, setPlans] = React.useState<PlanInfo[]>([]);
  React.useEffect(() => {
    const w = window as unknown as { slimeAPI?: any };
    if (!w.slimeAPI?.plan?.onUpdate) { return; }
    const off = w.slimeAPI.plan.onUpdate((payload: { sessionId: string; plan: PlanInfo }) => {
      setPlans((prev) => {
        
        
        
        
        const key = payload.plan.sessionId ?? payload.sessionId ?? "";
        const at = key
          ? prev.findIndex((pl) => (pl.sessionId ?? "") === key)
          : prev.findIndex((pl) => pl.id === payload.plan.id);
        
        if (at >= 0 && prev[at]!.source === "plan" && payload.plan.source === "todo") { return prev; }
        const next = at >= 0 ? prev.map((pl, i) => (i === at ? payload.plan : pl)) : [...prev, payload.plan];
        return next.slice(-8); 
      });
    });
    return off;
  }, []);
  return React.useMemo(
    () => [...plans].sort((a, b) => b.updatedAt - a.updatedAt),
    [plans],
  );
}


export default function PlanPanel(): JSX.Element {
  const plans = usePlanStore();
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>任务进度</div>
      <PlanCardList plans={plans} />
    </div>
  );
}