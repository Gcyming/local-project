import { describe, expect, it } from "vitest";
import {
  buildDecomposePrompt,
  buildMergePrompt,
  buildRefFrameBlock,
  buildSharedSpecBlock,
  batchCompletionStats,
  decomposeTask,
  extractGlobalSpec,
  extractTotalDuration,
  groupByRound,
  parseSubtasks,
  planMaxSubtasks,
  ruleBasedSegments,
  validateVideoSegments,
  BATCH_MAX_SUBTASKS,
  BATCH_MIN_SUBTASKS,
  DEFAULT_DECOMPOSE_POLICY,
  assessBatchRisks,
  batchHasBlockingRisk,
  buildBatchVerdict,
  collectBatchClaimErrors,
  detectBatchConflict,
  resolveBatchConflict,
  type DecomposePolicy,
} from "../../core-ts/src/services/subagent_batch.js";
import { SubAgentManager } from "../../core-ts/src/services/subagent.js";

describe("拆解：JSON 解析与轮次分组", () => {
  it("rounds 新格式按轮次展开", () => {
    const reply =
      '{"global": {"style": "cyberpunk"}, "rounds": [{"subtasks": [{"desc": "第一段", "agent": "A"}]}, {"subtasks": [{"desc": "第二段", "agent": ""}]}]}';
    const items = parseSubtasks(reply, 8);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ desc: "第一段", agent: "A", round: 1 });
    expect(items[1]).toMatchObject({ desc: "第二段", round: 2 });
  });

  it("扁平 subtasks 全部归到第 1 轮", () => {
    const items = parseSubtasks('{"subtasks": ["甲任务", "乙任务"]}', 8);
    expect(items.every((i) => i.round === 1)).toBe(true);
    expect(items.map((i) => i.desc)).toEqual(["甲任务", "乙任务"]);
  });

  it("非法 JSON 时回退到编号列表", () => {
    const items = parseSubtasks("1. 写一个解析器\n2. 写一个测试用例", 8);
    expect(items.length).toBe(2);
    expect(items[0].desc).toContain("解析器");
  });

  it("groupByRound 按轮次聚合", () => {
    const g = groupByRound([
      { desc: "a", agent: "", round: 1 },
      { desc: "b", agent: "", round: 2 },
      { desc: "c", agent: "", round: 1 },
    ]);
    expect(g.size).toBe(2);
    expect(g.get(1)?.length).toBe(2);
    expect(g.get(2)?.length).toBe(1);
  });
});

describe("拆解：规模与全局规格", () => {
  it("planMaxSubtasks 随 provider 数与总时长增长", () => {
    expect(planMaxSubtasks(1)).toBe(BATCH_MIN_SUBTASKS);
    expect(planMaxSubtasks(2)).toBe(6);
    expect(planMaxSubtasks(2, 50)).toBe(10);
    expect(planMaxSubtasks(100)).toBe(BATCH_MAX_SUBTASKS);
  });

  it("extractTotalDuration 识别中文与英文表述", () => {
    expect(extractTotalDuration("做一个 60 秒的视频")).toBe(60);
    expect(extractTotalDuration("make a 2 minutes clip")).toBe(120);
    expect(extractTotalDuration("没有时长")).toBe(0);
  });

  it("extractGlobalSpec 提取 global 与超时/总时长", () => {
    const reply = '{"global": {"style": "x", "timeout": 900, "total_seconds": 30}}';
    const spec = extractGlobalSpec(reply);
    expect(spec).toContain('"style":"x"');
    expect(spec).toContain("【预估超时】900 秒");
    expect(spec).toContain("【总时长】30 秒");
  });

  it("buildDecomposePrompt 注入 roster 与自定义规则", () => {
    const p = buildDecomposePrompt("任务", 4, [["甲", "审查代码质量与潜在缺陷"]], ["8. 自定义规则"]);
    expect(p).toContain("甲（审查代码质量与潜在缺陷");
    expect(p).toContain("8. 自定义规则");
    expect(p).toContain("只输出 JSON");
  });
});

describe("拆解：decomposeTask 控制流", () => {
  const okReply = '{"global": {"style": "x"}, "rounds": [{"subtasks": [{"desc": "甲"}, {"desc": "乙"}]}]}';

  it("一次成功 → source=llm，attempts=1", async () => {
    const out = await decomposeTask({ task: "任务", maxSubtasks: 4, llmFn: () => okReply });
    expect(out.source).toBe("llm");
    expect(out.attempts).toBe(1);
    expect(out.subtasks.length).toBe(2);
    expect(out.globalSpec).toContain("x");
  });

  it("首次非法、二次合法 → 带修正提示重试", async () => {
    const prompts: string[] = [];
    let n = 0;
    const out = await decomposeTask({
      task: "任务",
      maxSubtasks: 4,
      llmFn: (p) => {
        prompts.push(p);
        n++;
        return n === 1 ? "完全不是 JSON 的废话" : okReply;
      },
    });
    expect(out.source).toBe("llm");
    expect(out.attempts).toBe(2);
    expect(prompts[1]).toContain("重试提示");
  });

  it("校验不通过（视频段超 5 秒）→ 追加重切提示后重试", async () => {
    const prompts: string[] = [];
    let n = 0;
    const out = await decomposeTask({
      task: "做一个视频",
      maxSubtasks: 8,
      llmFn: (p) => {
        prompts.push(p);
        n++;
        return n === 1
          ? '{"rounds":[{"subtasks":[{"desc":"第 1 段 0-12 秒：打斗"}]}]}'
          : '{"rounds":[{"subtasks":[{"desc":"第 1 段 0-5 秒：打斗"}]}]}';
      },
    });
    expect(out.source).toBe("llm");
    expect(out.attempts).toBe(2);
    expect(prompts[1]).toContain("修正提示");
    expect(prompts[1]).toContain("≤5 秒");
  });

  it("时长覆盖不足也算校验失败（不能只覆盖一段就交差）", async () => {
    let calls = 0;
    const out = await decomposeTask({
      task: "做一个 20 秒视频",
      maxSubtasks: 8,
      llmFn: () => {
        calls++;
        return '{"rounds":[{"subtasks":[{"desc":"第 1 段 0-5 秒：打斗"}]}]}';
      },
    });
    expect(calls).toBe(3);
    expect(out.source).toBe("fallback");
    expect(out.subtasks.length).toBe(4);
  });

  it("三次全失败 → policy.fallback 兜底", async () => {
    const out = await decomposeTask({
      task: "做一个 10 秒视频",
      maxSubtasks: 8,
      llmFn: () => "仍然不是 JSON",
    });
    expect(out.source).toBe("fallback");
    expect(out.attempts).toBe(3);
    expect(out.subtasks.length).toBeGreaterThan(0);
  });

  it("兜底也为空 → 退化为整任务单子任务", async () => {
    const policy: DecomposePolicy = { fallback: () => [] };
    const out = await decomposeTask({ task: "一整块任务", maxSubtasks: 4, llmFn: () => "没 JSON", policy });
    expect(out.source).toBe("whole-task");
    expect(out.subtasks).toEqual([{ desc: "一整块任务", agent: "", round: 1 }]);
  });

  it("自定义 policy 可完全替换校验器", async () => {
    let called = 0;
    const policy: DecomposePolicy = {
      validate: () => {
        called++;
        return "";
      },
      fallback: () => [],
    };
    const out = await decomposeTask({
      task: "任务",
      maxSubtasks: 4,
      llmFn: () => okReply,
      policy,
    });
    expect(called).toBe(1);
    expect(out.source).toBe("llm");
  });

  it("默认 policy 自带视频规则与兜底", () => {
    expect(DEFAULT_DECOMPOSE_POLICY.rules?.length).toBeGreaterThan(0);
    expect(DEFAULT_DECOMPOSE_POLICY.fallback).toBeTypeOf("function");
    expect(validateVideoSegments([{ desc: "第 1 段 0-9 秒" }], 0)).toContain("超过 5 秒上限");
    expect(ruleBasedSegments("做一个 10 秒视频", 8).length).toBe(2);
  });
});

describe("共享规格与合并", () => {
  it("buildSharedSpecBlock 空值返回空串", () => {
    expect(buildSharedSpecBlock("")).toBe("");
    expect(buildSharedSpecBlock("   ")).toBe("");
  });

  it("buildSharedSpecBlock 非空带标题", () => {
    const b = buildSharedSpecBlock('{"tech_stack":"TS"}');
    expect(b).toContain("【全局规格");
    expect(b).toContain("tech_stack");
  });

  it("buildRefFrameBlock 空值返回空串", () => {
    expect(buildRefFrameBlock("")).toBe("");
    expect(buildRefFrameBlock("/a/frame.png")).toContain("/a/frame.png");
  });

  it("buildMergePrompt 含各段状态、全局规格与缺口要求", () => {
    const p = buildMergePrompt({
      task: "做视频",
      globalSpec: '{"style":"noir"}',
      entries: [
        { name: "W1", state: "done", result: "第一段完成" },
        { name: "W2", state: "failed", result: "", error: "超时" },
      ],
    });
    expect(p).toContain("【全局规格");
    expect(p).toContain("noir");
    expect(p).toContain("第一段完成");
    expect(p).toContain("超时");
    expect(p).toContain("不得假装完整");
  });

  it("batchCompletionStats 统计完成度", () => {
    expect(batchCompletionStats([{ name: "a", state: "done", result: "" }])).toEqual({
      total: 1,
      done: 1,
      failed: 0,
      allDone: true,
    });
    expect(batchCompletionStats([
      { name: "a", state: "done", result: "" },
      { name: "b", state: "failed", result: "" },
    ])).toEqual({ total: 2, done: 1, failed: 1, allDone: false });
    expect(batchCompletionStats([]).allDone).toBe(false);
  });
});

describe("SubAgentManager：批量派发与共享规格", () => {
  it("spawnBatch 注册批次并把 sharedSpec 透传给 runner", async () => {
    const seen: Array<{ name: string; spec?: string }> = [];
    const mgr = new SubAgentManager(async (def) => {
      seen.push({ name: def.name, spec: def.sharedSpec });
      return `done:${def.name}`;
    });
    const { batchId, runs } = mgr.spawnBatch(
      [{ name: "甲", task: "t1" }, { name: "乙", task: "t2" }],
      { sharedSpec: "SPEC-X" },
    );
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.batchId === batchId)).toBe(true);

    const list = await mgr.awaitBatch(batchId, 5000);
    expect(list.length).toBe(2);
    expect(list.every((r) => r.status === "done")).toBe(true);
    expect(seen.map((s) => s.spec)).toEqual(["SPEC-X", "SPEC-X"]);
  });

  it("子代理自定义 sharedSpec 覆盖批次默认值", async () => {
    const specs: Array<string | undefined> = [];
    const mgr = new SubAgentManager(async (def) => {
      specs.push(def.sharedSpec);
      return "ok";
    });
    const { batchId } = mgr.spawnBatch(
      [{ name: "甲", task: "t1", sharedSpec: "OWN" }, { name: "乙", task: "t2" }],
      { sharedSpec: "BATCH-DEFAULT" },
    );
    await mgr.awaitBatch(batchId, 5000);
    expect(specs).toEqual(["OWN", "BATCH-DEFAULT"]);
  });

  it("批次遵守并发上限（不超 maxConcurrency）", async () => {
    let active = 0;
    let peak = 0;
    const mgr = new SubAgentManager(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return "ok";
    }, { concurrency: 2 });
    const { batchId } = mgr.spawnBatch(
      [{ name: "1", task: "t" }, { name: "2", task: "t" }, { name: "3", task: "t" }, { name: "4", task: "t" }],
    );
    await mgr.awaitBatch(batchId, 10_000);
    expect(peak).toBeLessThanOrEqual(2);
    expect(mgr.listBatch(batchId).length).toBe(4);
  });

  it("listBatch 对未知批次返回空数组（不抛）", async () => {
    const mgr = new SubAgentManager(async () => "ok");
    expect(mgr.listBatch("不存在")).toEqual([]);
    expect(await mgr.awaitBatch("不存在", 100)).toEqual([]);
  });

  it("无 sharedSpec 时 runner 收到 undefined（不注入空串）", async () => {
    const specs: Array<string | undefined> = [];
    const mgr = new SubAgentManager(async (def) => {
      specs.push(def.sharedSpec);
      return "ok";
    });
    const { batchId } = mgr.spawnBatch([{ name: "甲", task: "t" }]);
    await mgr.awaitBatch(batchId, 5000);
    expect(specs[0]).toBeUndefined();
  });

  it("forgetTerminal 回收终态批次", async () => {
    const mgr = new SubAgentManager(async () => "ok");
    const { batchId } = mgr.spawnBatch([{ name: "甲", task: "t" }]);
    await mgr.awaitBatch(batchId, 5000);
    const removed = mgr.forgetTerminal();
    expect(removed).toBe(1);
    expect(mgr.listBatch(batchId)).toEqual([]);
  });

  it("单发 delegate 行为不受批量能力影响", async () => {
    const mgr = new SubAgentManager(async () => "单发结果");
    const run = mgr.delegate("独立任务");
    expect(run).not.toBeNull();
    const final = await mgr.wait(run!.id, 5000);
    expect(final?.status).toBe("done");
    expect(final?.result).toBe("单发结果");
  });
});

describe("批次风险分级（迁自 Merger，零 LLM 成本）", () => {
  const done = (name: string, result = "成功完成"): { name: string; state: string; result: string } =>
    ({ name, state: "done", result });
  const failed = (name: string, error = "超时"): { name: string; state: string; result: string; error: string } =>
    ({ name, state: "failed", result: "", error });

  it("无结果 → high", () => {
    const r = assessBatchRisks([]);
    expect(r[0].level).toBe("high");
    expect(r[0].description).toContain("无子任务");
  });

  it("全部失败 → critical", () => {
    const r = assessBatchRisks([failed("a"), failed("b")]);
    expect(r[0].level).toBe("critical");
    expect(r[0].description).toContain("全部失败");
  });

  it("过半失败 → high", () => {
    const r = assessBatchRisks([failed("a"), failed("b"), done("c")]);
    expect(r[0].level).toBe("high");
  });

  it("少数失败 → medium", () => {
    const r = assessBatchRisks([done("a"), done("b"), failed("c")]);
    expect(r[0].level).toBe("medium");
  });

  it("全成功 → low", () => {
    const r = assessBatchRisks([done("a"), done("b")]);
    expect(r[0].level).toBe("low");
    expect(r[0].description).toContain("成功");
  });

  it("batchHasBlockingRisk 只对 high/critical 为真", () => {
    expect(batchHasBlockingRisk(assessBatchRisks([]))).toBe(true);
    expect(batchHasBlockingRisk(assessBatchRisks([done("a")]))).toBe(false);
    expect(batchHasBlockingRisk([])).toBe(false);
  });
});

describe("批次矛盾检测与 LLM 复核（迁自 Merger 的 A-013 机制）", () => {
  it("样本不足 2 条 → 直接判定一致，不触发复核", () => {
    const c = detectBatchConflict([{ name: "a", state: "done", result: "完成" }]);
    expect(c.consistent).toBe(true);
    expect(c.positiveCount).toBe(0);
  });

  it("关键词启发式命中矛盾（负面过半）", () => {
    const c = detectBatchConflict([
      { name: "a", state: "done", result: "构建成功" },
      { name: "b", state: "done", result: "测试失败" },
      { name: "c", state: "done", result: "部署错误" },
    ]);
    expect(c.consistent).toBe(false);
    expect(c.issue).toContain("矛盾");
  });

  it("全正面 → 一致", () => {
    const c = detectBatchConflict([
      { name: "a", state: "done", result: "已成功完成" },
      { name: "b", state: "done", result: "通过验证" },
    ]);
    expect(c.consistent).toBe(true);
  });

  it("✅ 一致时绝不调用 LLM（廉价前置筛选）", async () => {
    let called = 0;
    const out = await resolveBatchConflict(() => { called++; return "{}"; }, [
      { name: "a", state: "done", result: "成功完成" },
      { name: "b", state: "done", result: "通过" },
    ]);
    expect(called).toBe(0);
    expect(out.check.consistent).toBe(true);
    expect(out.adjudication).toBeUndefined();
  });

  it("🔑 启发式命中但 LLM 裁定不矛盾 → 解除误报（A-013 核心）", async () => {
    const out = await resolveBatchConflict(
      () => '{"is_conflict": false, "reason": "一个说构建成功、一个说测试失败，不矛盾"}',
      [
        { name: "a", state: "done", result: "构建成功" },
        { name: "b", state: "done", result: "测试失败" },
        { name: "c", state: "done", result: "部署错误" },
      ],
    );
    expect(out.check.consistent).toBe(true);
    expect(out.check.issue).toBeNull();
    expect(out.adjudication?.isConflict).toBe(false);
  });

  it("启发式命中且 LLM 确认矛盾 → 保持不一致", async () => {
    const out = await resolveBatchConflict(
      () => '{"is_conflict": true, "reason": "对同一文件是否存在给出相反结论"}',
      [
        { name: "a", state: "done", result: "文件已保存成功" },
        { name: "b", state: "done", result: "文件不存在错误" },
        { name: "c", state: "done", result: "读取文件异常" },
      ],
    );
    expect(out.check.consistent).toBe(false);
    expect(out.adjudication?.isConflict).toBe(true);
  });

  it("无 llmFn 时只做启发式、不崩", async () => {
    const out = await resolveBatchConflict(undefined, [
      { name: "a", state: "done", result: "构建成功" },
      { name: "b", state: "done", result: "测试失败" },
      { name: "c", state: "done", result: "部署错误" },
    ]);
    expect(out.check.consistent).toBe(false);
    expect(out.adjudication).toBeUndefined();
  });

  it("LLM 回复不可解析 → isConflict=null 且不误判为一致", async () => {
    const out = await resolveBatchConflict(() => "我不会输出 JSON", [
      { name: "a", state: "done", result: "构建成功" },
      { name: "b", state: "done", result: "测试失败" },
      { name: "c", state: "done", result: "部署错误" },
    ]);
    expect(out.adjudication?.isConflict).toBeNull();
    expect(out.check.consistent).toBe(false);
  });

  it("启发式要求「负面数 > 正面数」才判矛盾（1:1 不算）", () => {
    const c = detectBatchConflict([
      { name: "a", state: "done", result: "构建成功" },
      { name: "b", state: "done", result: "测试失败" },
    ]);
    expect(c.positiveCount).toBe(1);
    expect(c.negativeCount).toBe(1);
    expect(c.consistent).toBe(true);
  });
});

describe("批次幻觉护栏（复用 claims.ts）与结论文案", () => {
  it("无任何声称 → 空数组，不抛", async () => {
    expect(await collectBatchClaimErrors("只是普通总结，没有文件声称", [])).toEqual([]);
  });

  it("不存在的路径 + 声称动词 → 产出幻觉护栏错误（带前缀）", async () => {
    const errs = await collectBatchClaimErrors("已保存到 core-ts/src/__no_such_file_xyz__.ts", []);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("幻觉护栏");
  });

  it("buildBatchVerdict：全成功 → ✓ 且无风险", () => {
    const entries = [{ name: "a", state: "done", result: "完成" }];
    const v = buildBatchVerdict("总结", entries, assessBatchRisks(entries));
    expect(v.startsWith("✓")).toBe(true);
  });

  it("buildBatchVerdict：有 critical 风险 → ⚠ 并如实标注", () => {
    const entries = [{ name: "a", state: "failed", result: "", error: "崩溃" }];
    const v = buildBatchVerdict("总结", entries, assessBatchRisks(entries));
    expect(v.startsWith("⚠")).toBe(true);
    expect(v).toContain("critical");
  });

  it("buildBatchVerdict：无汇总 → 明确说缺汇总（不假装完整）", () => {
    const entries = [{ name: "a", state: "done", result: "完成" }];
    const v = buildBatchVerdict("   ", entries, assessBatchRisks(entries));
    expect(v).toContain("缺少有效汇总");
  });
});
