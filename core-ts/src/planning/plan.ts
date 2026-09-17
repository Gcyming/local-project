/**
 * core-ts/src/planning/plan.ts — Plan 一等对象（Claude Code Task System / Cursor todo 状态机 / Devin 拆解 对标）。
 *
 * 目标：把"任务拆解"从提示词引导升级为结构化 Plan 对象——支持阶段状态机、
 * 进度追踪、失败标记与重规划。全部为无副作用纯函数（可单测、可序列化），
 * 持久化/广播由装配方（GUI 会话事件 / IPC）负责。
 *
 * 生命周期：planning(已建未动) → active(任一阶段执行中) → done(全部完成) / failed(任一失败)。
 */
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
  /**
   * A-980-R29：这条 Plan 从哪来。
   * - `"plan"`：`plan_create` / `plan_update` 产生的**真 Plan**（一等对象，可被推进）
   * - `"todo"`：由 `todo_write` 的待办清单**派生**（有损、只读镜像，仅为让 PlanPanel 也能看到进度）
   *
   * 两条链路共用同一个 sessionId key，故必须靠它定优先级：
   * 派生数据不得顶掉真 Plan（否则模型顺手一次 todo_write 就会把用户正在看的计划冲掉）。
   * 缺省视为 `"plan"`（历史数据/其它构造点都是真 Plan）。
   */
  source?: "plan" | "todo";
}

export interface PlanInput {
  sessionId?: string;
  description: string;
  /** 阶段列表：字符串 label 或 {label, detail}；微软规划按顺序执行，循环推进 */
  stages: Array<string | { label: string; detail?: string }>;
}

/** 创建一个新 Plan（幂等：可显式传 id 以支持重规划同 id 覆盖）。 */
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

/** 阶段推进：将 stage 置为指定终态/进行态。返回新 Plan（不可变更新）。 */
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

/** 按阶段 label（前缀/包含）定位并推进——供模型以自然语言引用阶段。返回 (newPlan, matchedId|null)。 */
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

/** 依据各阶段状态推导 Plan 总状态（无副作用、可直测）。 */
export function derivePlanStatus(stages: PlanStage[]): PlanStatus {
  if (stages.length === 0) { return "done"; }
  if (stages.some((s) => s.status === "failed")) { return "failed"; }
  if (stages.every((s) => s.status === "done" || s.status === "skipped")) { return "done"; }
  if (stages.some((s) => s.status === "in_progress")) { return "active"; }
  return "planning";
}

/** 进度统计：{ done, total, pct(0-100) }。failed/skipped 计入 done 之外，pct 按 done/total。 */
export function planProgress(plan: Plan): { done: number; total: number; pct: number } {
  const total = Math.max(1, plan.stages.length);
  const done = plan.stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total, pct: Math.round((done / total) * 100) };
}

/** 序列化为传输/落盘 JSON 字符串（工具返回体）。 */
export function planToJSON(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

/** 从 JSON 字符串 / 对象解析为 Plan；失败返回 null。 */
export function parsePlan(raw: string | Record<string, unknown>): Plan | null {
  try {
    const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown as Plan) : (raw as unknown as Plan);
    if (!obj || typeof obj.id !== "string" || !Array.isArray(obj.stages)) { return null; }
    return obj;
  } catch { return null; }
}