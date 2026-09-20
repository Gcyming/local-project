/**
 * brainstorm.spec.ts — 群聊头脑风暴引擎（A-943）回归锚点。
 * 覆盖：纯提示词构建（首轮自由发言/后续轮纠错/组长点评/终局收束）、并行轮次执行与共享讨论记录、
 * 空成员/单轮收敛等边界。
 */
import { describe, it, expect } from "vitest";
import {
  runBrainstorm,
  formatTranscript,
  buildMemberPrompt,
  buildLeaderRoundPrompt,
  buildLeaderSummaryPrompt,
  type BrainstormParticipant,
  type TranscriptLine,
} from "../../core-ts/src/services/brainstorm.js";

/** 记录每次发言收到的提示词，便于断言轮次语义注入 */
function speechQueue(name: string, role: string) {
  const prompts: string[] = [];
  const p: BrainstormParticipant = {
    id: name,
    name,
    role,
    speak: async (prompt: string) => { prompts.push(prompt); return `${name}发言：针对议题${prompts.length}次`; },
  };
  return { p, prompts };
}

const leader = { id: "组长", name: "组长", role: "统筹", speak: async () => "组长发言" } as BrainstormParticipant;

describe("brainstorm 纯提示词构建", () => {
  const transcript: TranscriptLine[] = [{ speaker: "用户", content: "如何优化鉴权" }];

  it("首轮成员：引导自由发表看法，附角色与议题", () => {
    const prompt = buildMemberPrompt({ name: "审查员", role: "代码审查" }, "组长", transcript, 1, 2);
    expect(prompt).toContain("组长");
    expect(prompt).toContain("审查员");
    expect(prompt).toContain("围绕议题");
    expect(prompt).toContain("第 1/2 轮");
  });

  it("后续轮成员：导向反驳/纠错/增量，并附完整讨论记录与最后一轮提示", () => {
    const full: TranscriptLine[] = [
      { speaker: "用户", content: "议题" },
      { speaker: "A", content: "建议 A" },
      { speaker: "B", content: "反驳 A" },
    ];
    const prompt = buildMemberPrompt({ name: "C", role: "数据分析" }, "组长", full, 2, 2);
    expect(prompt).toContain("反驳");
    expect(prompt).toContain("逻辑漏洞");
    expect(prompt).toContain("【A】");
    expect(prompt).toContain("最后一轮");
  });

  it("组长点评与终局收束", () => {
    expect(buildLeaderRoundPrompt({ name: "组长", role: "统筹" }, transcript, 1)).toContain("点名");
    const summary = buildLeaderSummaryPrompt({ name: "组长", role: "统筹" }, transcript);
    expect(summary).toContain("建议的下一步行动");
    expect(summary).toContain("终局总结");
  });

  it("formatTranscript：空记录兜底文案", () => {
    expect(formatTranscript([])).toContain("暂无讨论");
  });
});

describe("runBrainstorm 执行器（并行轮次 + 共享记录 + 组长收束）", () => {
  it("默认 2 轮：成员并行发言 2 次、组长点评 1 次（末轮点评被收束接管）、终局总结 1 次", async () => {
    const a = speechQueue("A", "角色A");
    const b = speechQueue("B", "角色B");
    const leaderPrompts: string[] = [];
    const leaderP: BrainstormParticipant = {
      ...leader, speak: async (p: string) => { leaderPrompts.push(p); return `组长点评${leaderPrompts.length}`; },
    };
    const run = await runBrainstorm({ leader: leaderP, members: [a.p, b.p], topic: "议题X" });
    expect(run.id).toBeTruthy();
    expect(run.maxRounds).toBe(2);
    expect(run.rounds).toHaveLength(2);
    // 每轮两个成员并行发言；成员收到的提示词各 2 份（第 1、2 轮）
    expect(a.prompts).toHaveLength(2);
    expect(b.prompts).toHaveLength(2);
    // 首轮成员提示不含其他成员发言；第二轮提示带讨论记录（成员 B 的前轮发言注入）
    expect(a.prompts[0]).not.toContain("B发言");
    expect(a.prompts[1]).toContain("B发言");
    // 组长：1 次点评 + 1 次终局收束
    expect(leaderPrompts).toHaveLength(2);
    expect(leaderPrompts[0]).toContain("点评");
    expect(leaderPrompts[1]).toContain("终局总结");
    expect(run.summary).toContain("组长点评2");
    expect(run.rounds.every((r) => r.speeches.length === 2)).toBe(true);
  });

  it("maxRounds=1：无组长点评（收束直出），但终局总结在", async () => {
    const c = speechQueue("C", "角色C");
    const run = await runBrainstorm({ leader, members: [c.p], topic: "单轮议题", maxRounds: 1 });
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0].leaderReview).toBeUndefined();
    expect(c.prompts).toHaveLength(1);
    expect(run.summary).toBeTruthy();
  });

  it("maxRounds 上限钳制到 5；空成员列表返回空轮次（不崩溃）", async () => {
    const run = await runBrainstorm({ leader, members: [], topic: "x", maxRounds: 99 });
    expect(run.maxRounds).toBe(5);
    expect(run.rounds).toHaveLength(5);
    expect(run.rounds.every((r) => r.speeches.length === 0)).toBe(true);
    expect(run.summary).toBeTruthy();
  });

  it("成员发言为空 → 占位「未输出」，不阻断流程", async () => {
    const silent: BrainstormParticipant = { id: "s", name: "沉默者", role: "r", speak: async () => "" };
    const run = await runBrainstorm({
      leader, members: [silent], topic: "t", maxRounds: 1,
    });
    expect(run.rounds[0].speeches[0].content).toContain("未输出");
    expect(run.summary).toBeTruthy();
  });

  it("A-945：不设置 leader（组长=用户）→ 仅全员并行发言，无 Agent 点评/总结，成员视角组长为用户", async () => {
    const a = speechQueue("A", "角色A");
    const b = speechQueue("B", "角色B");
    const run = await runBrainstorm({ members: [a.p, b.p], topic: "议题X", maxRounds: 2 });
    expect(run.rounds).toHaveLength(2);
    // 无组长：每轮无 leaderReview；summary 为空（收束交给用户）
    expect(run.rounds.every((r) => r.leaderReview === undefined)).toBe(true);
    expect(run.summary).toBe("");
    // 成员提示的"组长"为「用户」
    expect(a.prompts[0]).toContain("组长为 用户");
    // 共享记录照常：第二轮成员可见另一人首轮发言
    expect(a.prompts[1]).toContain("B发言");
    expect(run.rounds.every((r) => r.speeches.length === 2)).toBe(true);
  });
});