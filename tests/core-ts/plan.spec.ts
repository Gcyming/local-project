/**
 * plan.spec.ts — Plan 一等对象回归（E：Claude Code Task System / Devin 拆解 对标）。
 * 覆盖：创建/状态机推导/阶段推进（id 与 label 双引用）/进度计算/序列化往返/工具注册与执行。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createPlan, updateStage, advanceByLabel, derivePlanStatus, planProgress, planToJSON, parsePlan } from "../../core-ts/src/planning/plan.js";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools } from "../../core-ts/src/tools/builtin.js";

describe("Plan 纯函数", () => {
  it("createPlan：阶段默认 pending，status=planning，进度 0%", () => {
    const plan = createPlan({ description: "重构鉴权模块", stages: ["设计", "实现", "测试"] }, "p-1");
    expect(plan.id).toBe("p-1");
    expect(plan.status).toBe("planning");
    expect(plan.stages).toHaveLength(3);
    expect(plan.stages[0]).toMatchObject({ id: "1", label: "设计", status: "pending" });
    expect(planProgress(plan)).toEqual({ done: 0, total: 3, pct: 0 });
  });

  it("状态机推导：全部 done → done；任一 failed → failed；有 in_progress → active", () => {
    const base = createPlan({ description: "x", stages: ["a", "b", "c"] }, "p-2");
    const done = ["1", "2", "3"].reduce((p, id) => updateStage(p, id, "done"), base);
    expect(derivePlanStatus(done.stages)).toBe("done");
    const fail = updateStage(base, "2", "failed");
    expect(derivePlanStatus(fail.stages)).toBe("failed");
    const act = updateStage(base, "2", "in_progress");
    expect(derivePlanStatus(act.stages)).toBe("active");
  });

  it("按阶段 label 推进（模型自然语言引用阶段名）", () => {
    const plan = createPlan({ description: "x", stages: ["数据采集", "分析", "报告"] }, "p-3");
    const r = advanceByLabel(plan, "分析", "in_progress");
    expect(r.matched).toBe("2");
    expect(r.plan.stages[1].status).toBe("in_progress");
    const miss = advanceByLabel(plan, "不存在的阶段", "done");
    expect(miss.matched).toBeNull();
  });

  it("进度统计：skipped 计入完成，failed 不计", () => {
    const plan = createPlan({ description: "x", stages: ["a", "b", "c", "d"] }, "p-4");
    const p1 = updateStage(updateStage(pl4(), "1", "done"), "2", "done");
    const p2 = updateStage(updateStage(p1, "3", "skipped"), "4", "failed");
    expect(planProgress(p2)).toEqual({ done: 3, total: 4, pct: 75 });
    function pl4() { return plan; }
  });

  it("JSON 序列化往返一致（工具返回体可被 plan_update 解析）", () => {
    const plan = createPlan({ description: "x", stages: ["a", "b"] }, "p-5");
    const txt = planToJSON(updateStage(plan, "1", "in_progress"));
    const back = parsePlan(txt);
    expect(back).not.toBeNull();
    expect(back!.id).toBe("p-5");
    expect(back!.stages[0].status).toBe("in_progress");
    expect(parsePlan("不是 JSON")).toBeNull();
  });
});

describe("plan 工具（引擎工具循环可见）", () => {
  beforeEach(() => {
    resetRegistry();
    registerBuiltinTools();
  });

  it("plan_create 注册并创建 Plan，返回体含 id 与阶段 JSON", async () => {
    const tool = getRegistry().get("plan_create")!;
    const out = await tool.executeFn({ description: "重构鉴权", stages: ["设计", "实现"] });
    expect(out).toContain("Plan 已创建");
    expect(out).toContain("[Plan 已创建]");
    const json = out.slice(out.indexOf("{\n"));
    const plan = parsePlan(json);
    expect(plan!.stages.map((s) => s.label)).toEqual(["设计", "实现"]);
  });

  it("plan_update 推进阶段（label 引用）并算出 50%", async () => {
    const create = getRegistry().get("plan_create")!;
    const update = getRegistry().get("plan_update")!;
    const out = await create.executeFn({ description: "x", stages: ["a", "b"] });
    const json = out.slice(out.indexOf("{\n"));
    const upd = await update.executeFn({ plan: json, stage: "a", status: "done" });
    expect(upd).toContain("1/2 阶段");
    expect(upd).toContain("50%");
    expect(upd).toContain('"status": "done"');
  });

  it("plan_update 非法参数如实报错", async () => {
    const update = getRegistry().get("plan_update")!;
    expect(await update.executeFn({ plan: "bad", stage: "1", status: "done" })).toContain("无效");
    const create = getRegistry().get("plan_create")!;
    expect(await create.executeFn({ description: "", stages: [] })).toContain("必填");
  });
});