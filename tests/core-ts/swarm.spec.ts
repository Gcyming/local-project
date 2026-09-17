/**
 * tests/core-ts/swarm.spec.ts — Swarm 编排器状态机测试。
 * 对照 core/swarm.py 语义：五态流转 / max_workers 钳制 / provider 轮转 / 轮次分组。
 */
import { describe, expect, it } from "vitest";
import { SwarmOrchestrator, TaskState, makeSubTask } from "../../core-ts/src/swarm.js";

function makePlan(orchestrator: SwarmOrchestrator, descriptions: string[], opts: { names?: string[]; agents?: string[]; rounds?: number[]; maxWorkers?: number } = {}) {
  return orchestrator.createPlan({
    taskId: "t1",
    originalTask: "任务",
    subtaskDescriptions: descriptions,
    subtaskNames: opts.names,
    subtaskAgents: opts.agents,
    subtaskRounds: opts.rounds,
    maxWorkers: opts.maxWorkers,
  });
}

describe("createPlan", () => {
  it("子任务列表为空 → 抛错", () => {
    const o = new SwarmOrchestrator(2);
    expect(() => makePlan(o, [])).toThrow("子任务列表不能为空");
  });

  it("max_workers = min(请求, max_splits)；默认名字 Worker-N", () => {
    const o = new SwarmOrchestrator(2);
    const plan = makePlan(o, ["a", "b", "c"], { maxWorkers: 8 });
    expect(plan.max_workers).toBe(2);
    expect(plan.subtasks.map((s) => s.name)).toEqual(["Worker-1", "Worker-2", "Worker-3"]);
  });

  it("names/agents/rounds 映射 + provider 轮转分配", () => {
    const o = new SwarmOrchestrator(2);
    const plan = makePlan(o, ["a", "b", "c"], {
      names: ["n1", "n2"],
      agents: ["persist", ""],
      rounds: [2, 2, 1],
    });
    expect(plan.subtasks[0].name).toBe("n1");
    expect(plan.subtasks[1].name).toBe("n2");
    expect(plan.subtasks[2].name).toBe("Worker-3"); // 缺省
    expect(plan.subtasks[0].agent_name).toBe("persist");
    expect(plan.subtasks[1].agent_name).toBe("");
    expect(plan.subtasks[0].round).toBe(2);
    expect(plan.subtasks[1].round).toBe(2);
    expect(plan.subtasks[2].round).toBe(1);
    expect(plan.subtasks[0].provider_key).toBe("p1");
    expect(plan.subtasks[1].provider_key).toBe("p2");
    expect(plan.subtasks[2].provider_key).toBe("p1"); // 轮转
  });

  it("初始 state=pending；plan 注册进 plans", () => {
    const o = new SwarmOrchestrator(1);
    const plan = makePlan(o, ["x"]);
    expect(plan.subtasks[0].state).toBe(TaskState.PENDING);
    expect(o.getPlan("t1")).toBe(plan);
  });
});

describe("状态流转", () => {
  it("pending → queued → running → done（含时间戳）", () => {
    const o = new SwarmOrchestrator(1);
    const plan = makePlan(o, ["x"]);
    const st = plan.subtasks[0];
    o.markQueued("t1", st.id);
    expect(st.state).toBe(TaskState.QUEUED);
    o.markRunning("t1", st.id);
    expect(st.state).toBe(TaskState.RUNNING);
    expect(st.started_at).toBeGreaterThan(0);
    o.markDone("t1", st.id, "结果");
    expect(st.state).toBe(TaskState.DONE);
    expect(st.result).toBe("结果");
    expect(st.finished_at).toBeGreaterThan(0);
  });

  it("markFailed 记录错误 + 完成时间", () => {
    const o = new SwarmOrchestrator(1);
    const st = makePlan(o, ["x"]).subtasks[0];
    o.markFailed("t1", st.id, "boom");
    expect(st.state).toBe(TaskState.FAILED);
    expect(st.error).toBe("boom");
    expect(st.finished_at).toBeGreaterThan(0);
  });

  it("incrementRounds / updateProgress", () => {
    const o = new SwarmOrchestrator(1);
    const st = makePlan(o, ["x"]).subtasks[0];
    o.incrementRounds("t1", st.id);
    o.incrementRounds("t1", st.id);
    expect(st.rounds).toBe(2);
    o.updateProgress("t1", st.id, "第 2 轮");
    expect(st.progress).toBe("第 2 轮");
  });

  it("不存在的任务/子任务 → 静默忽略", () => {
    const o = new SwarmOrchestrator(1);
    expect(() => o.markDone("nope", "st_x", "r")).not.toThrow();
    expect(o.getResults("nope")).toEqual([]);
    expect(o.isComplete("nope")).toBe(true);
  });

  it("isComplete：部分完成 false；全 done/failed true", () => {
    const o = new SwarmOrchestrator(2);
    const plan = makePlan(o, ["a", "b"]);
    expect(o.isComplete("t1")).toBe(false);
    o.markDone("t1", plan.subtasks[0].id, "r");
    expect(o.isComplete("t1")).toBe(false);
    o.markFailed("t1", plan.subtasks[1].id, "e");
    expect(o.isComplete("t1")).toBe(true);
  });

  it("getRunningCount / getQueuedCount / getDoneCount", () => {
    const o = new SwarmOrchestrator(3);
    const plan = makePlan(o, ["a", "b", "c"]);
    o.markRunning("t1", plan.subtasks[0].id);
    o.markQueued("t1", plan.subtasks[1].id);
    o.markDone("t1", plan.subtasks[2].id, "r");
    expect(o.getRunningCount("t1")).toBe(1);
    expect(o.getQueuedCount("t1")).toBe(1);
    expect(o.getDoneCount("t1")).toBe(1);
  });
});

describe("cleanup", () => {
  it("cleanup 后 plan 移除", () => {
    const o = new SwarmOrchestrator(1);
    makePlan(o, ["x"]);
    expect(o.getPlan("t1")).toBeDefined();
    o.cleanup("t1");
    expect(o.getPlan("t1")).toBeUndefined();
  });
});

describe("makeSubTask", () => {
  it("缺省字段填充", () => {
    const st = makeSubTask({ id: "i", name: "n", description: "d" });
    expect(st.state).toBe(TaskState.PENDING);
    expect(st.rounds).toBe(0);
    expect(st.round).toBe(1);
    expect(st.agent_name).toBe("");
    expect(st.progress).toBe("");
  });
});