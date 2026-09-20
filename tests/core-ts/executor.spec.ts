/**
 * tests/core-ts/executor.spec.ts — Swarm Executor 测试。
 * 对照 core/executor.py 语义：拆解解析（A-058 栈式/A-067 兜底/A-078 时长）/
 * worker 循环 <DONE> 协议（A-047）/ 轮次耗尽标记失败 / A-055 轮次分组并发 / Merger 集成。
 * router 用 fake（tools.spec.ts 同款 cast 模式）。
 */
import { describe, expect, it } from "vitest";
import { SwarmExecutor, MAX_ROUNDS, TASK_BOUNDARY } from "../../core-ts/src/executor.js";
import {
  buildWorkerMessage,
  buildDecomposePrompt,
  extractJsonObjects,
  normalizeSubtaskItems,
  parseSubtasks,
  extractGlobalSpec,
  extractTotalDuration,
  validateVideoSegments,
  ruleBasedSegments,
} from "../../core-ts/src/executor.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";
import type { ModelRouter } from "../../core-ts/src/router.js";

function fakeRouter(replies: string[]): ModelRouter {
  let i = 0;
  return {
    chat: async () => ({
      response: { choices: [{ message: { content: replies[i++] ?? "fallback" } }] },
      routeName: "fake",
    }),
  } as unknown as ModelRouter;
}

describe("拆解解析", () => {
  it("parseSubtasks：rounds 新格式", () => {
    const reply = '{"global": {"style": "x"}, "rounds": [{"subtasks": [{"desc": "第一段", "agent": "A"}]}, {"subtasks": [{"desc": "第二段", "agent": ""}]}]}';
    const items = parseSubtasks(reply, 8);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ desc: "第一段", agent: "A", round: 1 });
    expect(items[1]).toMatchObject({ desc: "第二段", round: 2 });
  });

  it("parseSubtasks：subtasks 旧格式 + maxSubtasks 截断", () => {
    const reply = '{"subtasks": [{"desc": "a"}, {"desc": "b"}, {"desc": "c"}]}';
    expect(parseSubtasks(reply, 2).length).toBe(2);
  });

  it("parseSubtasks：行号正则兜底（含截断 JSON 先行）", () => {
    const reply = '{"rounds": [{"subtasks": [{"desc": "被截断'; // 未闭合 JSON → 兜底
    expect(parseSubtasks(reply, 8)).toEqual([]);
    const lines = "思考过程...\n1. 子任务一：收集数据并整理\n2. 子任务二：完成分析报告\n3. 子任务三：输出最终结论";
    const items = parseSubtasks(lines, 8);
    expect(items.map((i) => i.desc)).toEqual(["子任务一：收集数据并整理", "子任务二：完成分析报告", "子任务三：输出最终结论"]);
    expect(items[0].round).toBe(1);
  });

  it("parseSubtasks：嵌套截断 JSON 容忍（栈式提取）", () => {
    const reply = '{"rounds": [{"subtasks": [{"desc": "包含 }} 花括号"}]}]}';
    const items = parseSubtasks(reply, 8);
    expect(items.length).toBe(1);
    expect(items[0].desc).toBe("包含 }} 花括号");
  });

  it("extractJsonObjects：杂讯 + 多对象 + 字符串内括号", () => {
    const objs = extractJsonObjects('前缀 {"a": 1} 中间 {"b": {"c": 2}} 后缀');
    expect(objs).toEqual([{ a: 1 }, { b: { c: 2 } }]);
    const withStr = extractJsonObjects('{"s": "}}"}');
    expect(withStr).toEqual([{ s: "}}" }]);
  });

  it("normalizeSubtaskItems：字符串/对象/dir/截断", () => {
    const items = normalizeSubtaskItems(["甲", { desc: "乙", agent: "B" }, { description: "丙" }, 42, ""], 3);
    expect(items).toEqual([
      { desc: "甲", agent: "" },
      { desc: "乙", agent: "B" },
      { desc: "丙", agent: "" },
    ]);
  });

  it("extractGlobalSpec：global + timeout + total_seconds", () => {
    const spec = extractGlobalSpec('{"global": {"style": "dark", "timeout": 900, "total_seconds": 300}, "rounds": []}');
    expect(spec).toContain('"style":"dark"');
    expect(spec).toContain("【预估超时】900 秒");
    expect(spec).toContain("【总时长】300 秒");
    expect(extractGlobalSpec("无 JSON")).toBe("");
  });

  it("extractTotalDuration：英文/分钟/连字符/中文秒", () => {
    expect(extractTotalDuration("a video of exactly 30 seconds")).toBe(30);
    expect(extractTotalDuration("3 minutes video")).toBe(180);
    expect(extractTotalDuration("duration: 8-seconds long")).toBe(8);
    expect(extractTotalDuration("60 秒的视频")).toBe(60);
    expect(extractTotalDuration("随便写点")).toBe(0);
  });

  it("validateVideoSegments：5 秒段合规；超 5 秒报错；覆盖不足报错", () => {
    expect(validateVideoSegments([{ desc: "第 1 段 0-5 秒" }, { desc: "第 2 段 5-10 秒" }], 10)).toBe("");
    expect(validateVideoSegments([{ desc: "第 1 段 0-8 秒" }], 8)).toContain("超过 5 秒");
    expect(validateVideoSegments([{ desc: "第 1 段 0-5 秒" }], 10)).toContain("仅覆盖 0-5 秒");
  });

  it("ruleBasedSegments：时间标记拆分 + 无标记字符比例兜底 + 无规则返回空", () => {
    const withMarks = ruleBasedSegments("第 1 段 0-8 秒：开场\n第 2 段 8-16 秒：高潮", 8);
    expect(withMarks.length).toBe(4); // 16/5=4 段，每段 ≤5 秒
    expect(withMarks.every((m) => m.round === 1)).toBe(true);
    const byChar = ruleBasedSegments("生成一个 10 秒的视频，内容如下：" + "剧本".repeat(100), 8);
    expect(byChar.length).toBe(2); // 10/5
    expect(byChar[0].desc).toContain("agnes_generate_video");
    expect(ruleBasedSegments("随便", 8)).toEqual([]);
  });

  it("buildWorkerMessage：首轮含边界与 <DONE> 协议；续轮引用上轮", () => {
    const first = buildWorkerMessage("子任务描述", 1);
    expect(first).toContain(TASK_BOUNDARY);
    expect(first).toContain("<DONE>");
    expect(first).toContain("严禁编造");
    const cont = buildWorkerMessage("子任务描述", 2, "上轮内容");
    expect(cont).toContain("第 1 轮");
    expect(cont).toContain("上轮内容");
    expect(cont).toContain("严禁重复上一轮回复");
  });

  it("buildDecomposePrompt：含 JSON 输出格式与视频 5 秒硬约束", () => {
    const p = buildDecomposePrompt("任务", 8, [["A", "研究员"]]);
    expect(p).toContain("1-8 个可并行子任务");
    expect(p).toContain("每段 ≤5 秒");
    expect(p).toContain("A（研究员）");
  });
});

describe("SwarmExecutor 主流程", () => {
  it("全流程：拆解注入 → worker 完成 → 合并通过", async () => {
    const registry = new ToolRegistry();
    const router = fakeRouter(["完成子任务A<DONE>", "完成子任务B<DONE>"]);
    const ex = new SwarmExecutor({ providersCount: 2, router, registry });
    const llmFn = async (p: string) => {
      if (p.includes("整合为完整")) {
        return "这是最终合并总结。" + "任务已全部完成，所有子任务执行成功，结果汇总如下。".repeat(10);
      }
      if (p.includes("主 Agent")) return ""; // verdict → 模板兜底
      return '{"rounds": [{"subtasks": [{"desc": "A"}, {"desc": "B"}]}]}';
    };
    const r = await ex.run({ task: "写一份报告", subtasks: ["子任务A", "子任务B"], llmFnOverride: llmFn, maxWorkers: 2 });
    expect(r.merge_result).not.toBeNull();
    expect(r.merge_result!.trial_passed).toBe(true);
    expect(r.merge_result!.final_verdict).toContain("✓");
    expect(r.agent_snapshots.length).toBe(2);
    expect(r.agent_snapshots.every((s) => s.state === "done")).toBe(true);
    expect(r.agent_snapshots.map((s) => s.result).sort()).toEqual(["完成子任务A", "完成子任务B"].sort());
    expect(r.warnings).toEqual([]);
  });

  it("轮次耗尽未收到 <DONE> → failed 且保留产出", async () => {
    const registry = new ToolRegistry();
    const router = fakeRouter(new Array(MAX_ROUNDS).fill("还在干，没有完成"));
    const ex = new SwarmExecutor({ providersCount: 1, router, registry });
    const r = await ex.run({
      task: "任务",
      subtasks: ["子任务X"],
      maxWorkers: 1,
      llmFnOverride: async (p) => (p.includes("整合为完整") ? "合并总结内容。" : ""),
    });
    expect(r.agent_snapshots[0].state).toBe("failed");
    expect(r.agent_snapshots[0].error).toContain("未确认完成");
    expect(r.agent_snapshots[0].rounds).toBe(MAX_ROUNDS);
    expect(r.agent_snapshots[0].result).toContain("还在干"); // 保留最后一轮产出
    expect(r.merge_result!.trial_passed).toBe(false);
  });

  it("onRoundExhausted=reset → 重新计数直至完成", async () => {
    const registry = new ToolRegistry();
    const noDone = new Array(MAX_ROUNDS).fill("未完成");
    const router = fakeRouter([...noDone, "终于完成了<DONE>"]);
    const ex = new SwarmExecutor({ providersCount: 1, router, registry });
    let exhaustedCalls = 0;
    const r = await ex.run({
      task: "任务",
      subtasks: ["子任务Y"],
      maxWorkers: 1,
      llmFnOverride: async (p) => (p.includes("整合为完整") ? "合并总结内容，任务完成。" : ""),
      onRoundExhausted: () => {
        exhaustedCalls++;
        return "reset";
      },
    });
    expect(exhaustedCalls).toBe(1);
    expect(r.agent_snapshots[0].state).toBe("done");
  });

  it("onRoundExhausted=terminate → 用户终止失败态", async () => {
    const registry = new ToolRegistry();
    const router = fakeRouter(new Array(MAX_ROUNDS).fill("未完成"));
    const ex = new SwarmExecutor({ providersCount: 1, router, registry });
    const r = await ex.run({
      task: "任务",
      subtasks: ["子任务Z"],
      maxWorkers: 1,
      llmFnOverride: async (p) => (p.includes("整合为完整") ? "总结" : ""),
      onRoundExhausted: () => "terminate",
    });
    expect(r.agent_snapshots[0].state).toBe("failed");
    expect(r.agent_snapshots[0].error).toBe("用户终止");
  });

  it("并发执行：maxWorkers=2 四子任务全部完成", async () => {
    const registry = new ToolRegistry();
    const router = fakeRouter(["r1<DONE>", "r2<DONE>", "r3<DONE>", "r4<DONE>"]);
    const ex = new SwarmExecutor({ providersCount: 4, router, registry });
    const r = await ex.run({
      task: "任务",
      subtasks: ["s1", "s2", "s3", "s4"],
      maxWorkers: 2,
      llmFnOverride: async (p) => (p.includes("整合为完整") ? "合并总结，全部完成。" + "x".repeat(300) : ""),
    });
    expect(r.agent_snapshots.length).toBe(4);
    expect(r.agent_snapshots.filter((s) => s.state === "done").length).toBe(4);
  });

  it("幻觉护栏集成：worker 声称生成不存在文件 → merge errors", async () => {
    const registry = new ToolRegistry();
    const router = fakeRouter(["已生成视频并保存到 D:\\tool\\slime\\data\\generated\\exec_fake_never.mp4<DONE>"]);
    const ex = new SwarmExecutor({ providersCount: 1, router, registry });
    const r = await ex.run({
      task: "生成视频",
      subtasks: ["生成一段视频"],
      maxWorkers: 1,
      llmFnOverride: async (p) => (p.includes("整合为完整") ? "视频已保存到 D:\\tool\\slime\\data\\generated\\exec_fake_never.mp4" : ""),
    });
    expect(r.merge_result!.errors.some((e) => e.includes("幻觉护栏"))).toBe(true);
    expect(r.merge_result!.trial_passed).toBe(false);
  });

  it("拆解为空 → 单子任务兜底执行（不虚报成功）", async () => {
    const registry = new ToolRegistry();
    const ex = new SwarmExecutor({ providersCount: 1, router: fakeRouter([]), registry });
    const r = await ex.run({
      task: "任务",
      subtasks: [],
      llmFnOverride: async (p) => (p.includes("整合为完整") ? "总结" : '{"rounds": []}'),
    });
    // decompose 三连空 → 规则兜底失败 → 单任务兜底；worker 无 <DONE> → failed（绝不虚报成功）
    expect(r.merge_result).not.toBeNull();
    expect(r.agent_snapshots.length).toBe(1);
    expect(r.agent_snapshots[0].state).toBe("failed");
    expect(r.agent_snapshots[0].error).toContain("未确认完成");
  });
});