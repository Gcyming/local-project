








import { randomUUID } from "node:crypto";

export type PlanStageStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type PlanStatus = "planning" | "active" | "done" | "failed";

export interface PlanStage {
  id: string;
  label: string;
  detail?: string;
  status: PlanStageStatus;
}

export interface Plan {
  id: string;
  sessionId?: string;
  description: string;
  stages: PlanStage[];
  createdAt: number;
  updatedAt: number;
  status: PlanStatus;
  








  source?: "plan" | "todo";
}

export interface PlanInput {
  sessionId?: string;
  description: string;
  
  stages: Array<string | { label: string; detail?: string }>;
}


export function createPlan(input: PlanInput, id?: string): Plan {
  const now = Date.now();
  return {
    id: id ?? randomUUID(),
    sessionId: input.sessionId,
    description: input.description,
    stages: input.stages.map((s, i) => {
      const label = typeof s === "string" ? s : s.label;
      return {
        id: `${i + 1}`,
        label,
        detail: typeof s === "string" ? undefined : s.detail,
        status: "pending",
      };
    }),
    createdAt: now,
    updatedAt: now,
    status: "planning",
  };
}


export function updateStage(
  plan: Plan,
  stageId: string,
  status: PlanStageStatus,
  detail?: string,
): Plan {
  const stages = plan.stages.map((s) => {
    if (s.id !== stageId) { return s; }
    return detail !== undefined ? { ...s, status, detail } : { ...s, status };
  });
  return { ...plan, stages, updatedAt: Date.now(), status: derivePlanStatus(stages) };
}


export function advanceByLabel(
  plan: Plan,
  label: string,
  status: PlanStageStatus,
): { plan: Plan; matched: string | null } {
  const hit = plan.stages.find((s) =>
    label.trim() === s.label || s.label.includes(label.trim()) || label.trim().includes(s.label),
  );
  if (!hit) { return { plan, matched: null }; }
  return { plan: updateStage(plan, hit.id, status), matched: hit.id };
}


export function derivePlanStatus(stages: PlanStage[]): PlanStatus {
  if (stages.length === 0) { return "done"; }
  if (stages.some((s) => s.status === "failed")) { return "failed"; }
  if (stages.every((s) => s.status === "done" || s.status === "skipped")) { return "done"; }
  if (stages.some((s) => s.status === "in_progress")) { return "active"; }
  return "planning";
}


export function planProgress(plan: Plan): { done: number; total: number; pct: number } {
  const total = Math.max(1, plan.stages.length);
  const done = plan.stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total, pct: Math.round((done / total) * 100) };
}


export function planToJSON(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}


export function parsePlan(raw: string | Record<string, unknown>): Plan | null {
  try {
    const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown as Plan) : (raw as unknown as Plan);
    if (!obj || typeof obj.id !== "string" || !Array.isArray(obj.stages)) { return null; }
    return obj;
  } catch { return null; }
}