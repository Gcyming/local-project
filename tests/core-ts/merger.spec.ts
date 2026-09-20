/**
 * tests/core-ts/merger.spec.ts — Merger 合并器测试。
 * 对照 core/merger.py 语义：collect/analyze/assess（风险分级）/trial（四维验证）/
 * A-047 幻觉护栏硬信号 / verdict 模板。
 */
import { describe, expect, it } from "vitest";
import { Merger, makeMergeResult, type SubtaskLike } from "../../core-ts/src/merger.js";

function sub(name: string, over: Partial<SubtaskLike> = {}): SubtaskLike {
  return { name, state: "done", description: "", result: "", error: "", rounds: 1, ...over };
}

describe("collectResults / analyzeErrors / assessRisks", () => {
  it("collectResults 生成合并上下文（状态/轮次/结果/错误）", () => {
    const m = new Merger("t1", "原始任务");
    const ctx = m.collectResults([
      sub("A", { result: "成果A" }),
      sub("B", { state: "failed", error: "炸了" }),
    ]);
    expect(ctx).toContain("原始任务");
    expect(ctx).toContain("### A [✓ 完成]");
    expect(ctx).toContain("结果: 成果A");
    expect(ctx).toContain("### B [✗ 失败]");
    expect(ctx).toContain("错误: 炸了");
  });

  it("analyzeErrors：failed 状态与带 error 的 done 都记错误", () => {
    const m = new Merger("t1", "");
    const errors = m.analyzeErrors([
      sub("A", { state: "failed", error: "e1" }),
      sub("B", { error: "e2" }),
      sub("C"),
    ]);
    expect(errors.length).toBe(2);
    expect(m.result.errors.length).toBe(2);
  });

  it("assessRisks：全部失败 → critical", () => {
    const m = new Merger("t1", "");
    m.assessRisks([sub("A", { state: "failed", error: "x" }), sub("B", { state: "failed", error: "y" })]);
    expect(m.result.risks[0].level).toBe("critical");
  });

  it("assessRisks：超过半数失败 → high", () => {
    const m = new Merger("t1", "");
    m.assessRisks([sub("A", { state: "failed", error: "x" }), sub("B"), sub("C")]);
    expect(m.result.risks[0].level).toBe("medium"); // 1/3 未过半
    const m2 = new Merger("t1", "");
    m2.assessRisks([sub("A", { state: "failed", error: "x" }), sub("B", { state: "failed", error: "y" }), sub("C")]);
    expect(m2.result.risks[0].level).toBe("high");
  });

  it("assessRisks：无失败但带错误 → medium；全成功 → low；空 → high", () => {
    const m = new Merger("t1", "");
    m.assessRisks([sub("A", { error: "warn" })]);
    expect(m.result.risks[0].level).toBe("medium");
    const m2 = new Merger("t1", "");
    m2.assessRisks([sub("A"), sub("B")]);
    expect(m2.result.risks[0].level).toBe("low");
    const m3 = new Merger("t1", "");
    m3.assessRisks([]);
    expect(m3.result.risks[0].level).toBe("high");
  });
});

describe("trialRun 四维验证", () => {
  it("无总结 → 不通过", async () => {
    const m = new Merger("t1", "任务");
    m.assessRisks([sub("A", { result: "结果" })]);
    const t = await m.trialRun("", [sub("A", { result: "结果" })]);
    expect(t.passed).toBe(false);
    expect(t.log).toContain("未生成有效总结");
  });

  it("存在错误 → 不通过", async () => {
    const m = new Merger("t1", "任务");
    const sts = [sub("A", { error: "e" })];
    m.analyzeErrors(sts);
    m.assessRisks(sts);
    const t = await m.trialRun("这是一段足够长的总结，说明任务完成情况良好。", sts);
    expect(t.passed).toBe(false);
    expect(t.log).toContain("发现 1 个错误");
  });

  it("高风险（全失败）→ 不通过", async () => {
    const m = new Merger("t1", "任务");
    const sts = [sub("A", { state: "failed", error: "x" })];
    m.analyzeErrors(sts);
    m.assessRisks(sts);
    const t = await m.trialRun("总结文字", sts);
    expect(t.passed).toBe(false);
  });

  it("全部通过：质量分 + 完成度加权 → 高评分", async () => {
    const m = new Merger("t1", "任务");
    const sts = [sub("A", { result: "成功完成" }), sub("B", { result: "成功完成" })];
    m.analyzeErrors(sts);
    m.assessRisks(sts);
    const t = await m.trialRun("这是一段足够长的总结，完整覆盖了所有子任务执行情况，结论明确。", sts, () => "9");
    expect(t.passed).toBe(true);
    expect(t.score).toBeGreaterThanOrEqual(8);
    expect(t.log).toContain("基础检查通过");
  });

  it("完成度：200 字以上长度满分；覆盖率按成功比例", () => {
    const m = new Merger("t1", "任务");
    const c1 = m.checkCompletion("字".repeat(200), [sub("A", { result: "r" }), sub("B", { result: "r" })]);
    expect(c1.length_score).toBe(1);
    expect(c1.coverage_score).toBe(1);
    expect(c1.score).toBe(1);
    const c2 = m.checkCompletion("短", [sub("A", { result: "r" }), sub("B", { state: "failed", error: "x" })]);
    expect(c2.length_score).toBe(0.005); // 1/200
    expect(c2.coverage_score).toBe(0.5);
  });

  it("一致性启发式：负面多于正面 → 不通过 + LLM 裁定解除误报", async () => {
    const m = new Merger("t1", "任务");
    const sts = [sub("A", { result: "构建成功" }), sub("B", { result: "测试失败" }), sub("C", { result: "部署失败" })];
    m.analyzeErrors(sts);
    m.assessRisks(sts);
    const t = await m.trialRun("这是一段足够长的总结文字，用来通过长度检查。", sts);
    expect(t.passed).toBe(false);
    expect(t.details["consistency"]).toMatchObject({ consistent: false });

    const m2 = new Merger("t1", "任务");
    const sts2 = [sub("A", { result: "构建成功" }), sub("B", { result: "测试失败" }), sub("C", { result: "部署失败" })];
    m2.analyzeErrors(sts2);
    m2.assessRisks(sts2);
    const t2 = await m2.trialRun("这是一段足够长的总结文字，用来通过长度检查。", sts2, () => '{"is_conflict": false, "reason": "描述不同侧面"}');
    expect(t2.passed).toBe(true); // LLM 裁定非矛盾 → 解除
  });
});

describe("finalize + A-047 幻觉护栏", () => {
  it("完成管线：summary/verdict/subtask_results 落盘", async () => {
    const m = new Merger("t1", "任务");
    const sts = [sub("A", { result: "成功完成调研" })];
    const r = await m.finalize("这是一段足够长的总结，说明任务顺利完成。", sts);
    expect(r.summary).toContain("总结");
    expect(r.subtask_results.length).toBe(1);
    expect(r.trial_passed).toBe(true);
    expect(r.final_verdict).toContain("✓");
    expect(r.final_verdict).toContain("评分");
  });

  it("幻觉护栏：声称已生成但文件不存在 → errors + 不通过", async () => {
    const m = new Merger("t1", "任务");
    const sts = [sub("A", { result: "视频已生成并保存到 D:\\tool\\slime\\data\\generated\\fake_never_created.mp4" })];
    const r = await m.finalize("视频任务完成，产物已保存到 D:\\tool\\slime\\data\\generated\\fake_never_created.mp4", sts);
    expect(r.errors.some((e) => e.includes("幻觉护栏"))).toBe(true);
    expect(r.trial_passed).toBe(false);
    expect(r.final_verdict).toContain("⚠");
  });

  it("llmVerdict：LLM 生成结论优先", async () => {
    const m = new Merger("t1", "任务");
    const r = await m.finalize("总结文字内容", [sub("A", { result: "r" })], () => "自然语言结论");
    expect(r.final_verdict).toBe("自然语言结论");
  });

  it("makeMergeResult 默认值", () => {
    const r = makeMergeResult("t", "原始");
    expect(r.task_id).toBe("t");
    expect(r.trial_passed).toBe(false);
    expect(r.trial_score).toBe(0);
    expect(r.created_at).toBeGreaterThan(0);
  });
});