/**
 * core-ts/src/swarm.ts — Swarm 编排器（状态机 + 分裂计划）。
 * 语义移植自 core/swarm.py：
 * - TaskState 五态：pending → queued → running → done / failed
 * - SubTask 全字段（含 A-053 agent_name 角色路由、A-055 round 轮次、A-063 ref_frame）
 * - SwarmPlan（max_splits=provider 数；max_workers=min(请求, max_splits)，排队分批不丢任务）
 */

export enum TaskState {
  PENDING = "pending",
  QUEUED = "queued",
  RUNNING = "running",
  DONE = "done",
  FAILED = "failed",
}

export interface SubTask {
  id: string;
  name: string; // 子 Agent 名称（用户可命名）
  description: string;
  state: TaskState;
  result: string;
  error: string;
  progress: string;
  started_at: number;
  finished_at: number;
  agent_id: string;
  provider_key: string;
  rounds: number;
  agent_name: string; // A-053: 角色路由命中的持久子 Agent 名（空=临时 Worker）
  round: number; // A-055: 轮次编号
  ref_frame: string; // A-063: 链式参考帧
}

export function makeSubTask(partial: Partial<SubTask> & { id: string; name: string; description: string }): SubTask {
  return {
    state: TaskState.PENDING,
    result: "",
    error: "",
    progress: "",
    started_at: 0,
    finished_at: 0,
    agent_id: "",
    provider_key: "",
    rounds: 0,
    agent_name: "",
    round: 1,
    ref_frame: "",
    ...partial,
  };
}

export interface SwarmPlan {
  task_id: string;
  original_task: string;
  subtasks: SubTask[];
  max_splits: number;
  max_workers: number;
  created_at: number;
  global_spec: string; // A-057: 全局规格（风格/光线/色调/场景/人物/镜头语言）
}

export interface CreatePlanOptions {
  taskId: string;
  originalTask: string;
  subtaskDescriptions: string[];
  subtaskNames?: string[];
  subtaskAgents?: string[];
  subtaskRounds?: number[];
  maxWorkers?: number;
}

export class SwarmOrchestrator {
  private maxSplits: number;
  private plans = new Map<string, SwarmPlan>();

  constructor(providerCount: number) {
    this.maxSplits = Math.max(1, providerCount);
  }

  getProviderCount(): number {
    return this.maxSplits;
  }

  createPlan(opts: CreatePlanOptions): SwarmPlan {
    const descriptions = opts.subtaskDescriptions;
    if (!descriptions || descriptions.length === 0) {
      throw new Error("子任务列表不能为空");
    }
    const names = opts.subtaskNames ?? [];
    const agents = opts.subtaskAgents ?? [];
    const rounds = opts.subtaskRounds ?? [];
    const maxWorkers = Math.min(opts.maxWorkers ?? 2, this.maxSplits);

    const subtasks: SubTask[] = descriptions.map((desc, i) =>
      makeSubTask({
        id: `st_${Math.random().toString(16).slice(2, 10)}`,
        name: names[i] ?? `Worker-${i + 1}`,
        description: desc,
        provider_key: this.providerKeyFor(i),
        agent_name: agents[i] ?? "",
        round: rounds[i] !== undefined ? Number(rounds[i]) : 1,
      }),
    );

    const plan: SwarmPlan = {
      task_id: opts.taskId,
      original_task: opts.originalTask,
      subtasks,
      max_splits: this.maxSplits,
      max_workers: maxWorkers,
      created_at: Date.now() / 1000,
      global_spec: "",
    };
    this.plans.set(opts.taskId, plan);
    return plan;
  }

  /** 第 i 个子任务分配的 provider key（轮转分配，key 名由调用方以 n 个占位生成） */
  private providerKeyFor(i: number): string {
    return `p${(i % this.maxSplits) + 1}`;
  }

  private find(taskId: string, subtaskId: string): SubTask | undefined {
    return this.plans.get(taskId)?.subtasks.find((st) => st.id === subtaskId);
  }

  markQueued(taskId: string, subtaskId: string): void {
    const st = this.find(taskId, subtaskId);
    if (st) st.state = TaskState.QUEUED;
  }

  markRunning(taskId: string, subtaskId: string): void {
    const st = this.find(taskId, subtaskId);
    if (st) {
      st.state = TaskState.RUNNING;
      st.started_at = Date.now() / 1000;
    }
  }

  updateProgress(taskId: string, subtaskId: string, progress: string): void {
    const st = this.find(taskId, subtaskId);
    if (st) st.progress = progress;
  }

  incrementRounds(taskId: string, subtaskId: string): void {
    const st = this.find(taskId, subtaskId);
    if (st) st.rounds += 1;
  }

  markDone(taskId: string, subtaskId: string, result: string): void {
    const st = this.find(taskId, subtaskId);
    if (st) {
      st.state = TaskState.DONE;
      st.result = result;
      st.finished_at = Date.now() / 1000;
    }
  }

  markFailed(taskId: string, subtaskId: string, error: string): void {
    const st = this.find(taskId, subtaskId);
    if (st) {
      st.state = TaskState.FAILED;
      st.error = error;
      st.finished_at = Date.now() / 1000;
    }
  }

  isComplete(taskId: string): boolean {
    const plan = this.plans.get(taskId);
    if (!plan) return true;
    return plan.subtasks.every((st) => st.state === TaskState.DONE || st.state === TaskState.FAILED);
  }

  getRunningCount(taskId: string): number {
    return this.plans.get(taskId)?.subtasks.filter((st) => st.state === TaskState.RUNNING).length ?? 0;
  }

  getQueuedCount(taskId: string): number {
    return this.plans.get(taskId)?.subtasks.filter((st) => st.state === TaskState.QUEUED).length ?? 0;
  }

  getDoneCount(taskId: string): number {
    return this.plans.get(taskId)?.subtasks.filter((st) => st.state === TaskState.DONE || st.state === TaskState.FAILED).length ?? 0;
  }

  getResults(taskId: string): SubTask[] {
    return this.plans.get(taskId)?.subtasks ?? [];
  }

  getPlan(taskId: string): SwarmPlan | undefined {
    return this.plans.get(taskId);
  }

  cleanup(taskId: string): void {
    this.plans.delete(taskId);
  }
}