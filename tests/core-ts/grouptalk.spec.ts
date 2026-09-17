/**
 * grouptalk.spec.ts — 群聊发言调度引擎（A-950）：@ 解析 / 顺序生成 / 抢答回放 / 流式回调。
 */
import { describe, it, expect } from "vitest";
import { parseMentions, runGroupTalk, defaultRebuttalFilter, type GroupTalkParticipant, type StreamEmit } from "../../core-ts/src/services/grouptalk.js";

function mk(name: string, role = "专家", delay = 0, reply = ""): GroupTalkParticipant & { prompts: string[] } {
  const p: GroupTalkParticipant & { prompts: string[] } = {
    id: name, name, role, prompts: [],
    speak: async (prompt: string) => { p.prompts.push(prompt); if (delay > 0) { await new Promise((r) => setTimeout(r, delay)); } return reply || `${name}观点${p.prompts.length}`; },
  };
  return p;
}

describe("parseMentions（@ 路由解析）", () => {
  it("@全体 / @所有人 → all", () => {
    expect(parseMentions("@全体 帮我看看", ["a", "b"])).toEqual({ all: true, mentions: [] });
    expect(parseMentions("大家 @ 所有人 一起", ["a", "b"]).all).toBe(true);
  });
  it("@成员名 → mentions（边界不误伤：@iris 不匹配 irises）", () => {
    const r = parseMentions("@L2 帮我看看 L2s 的问题", ["L2", "L2s"]);
    expect(r.all).toBe(false);
    expect(r.mentions).toContain("L2");
    expect(parseMentions("看看 @组员A 和 @组员B", ["组员A", "组员B", "组员"])).toEqual({ all: false, mentions: ["组员A", "组员B"] });
  });
  it("无 @ → 空提及（走抢答）", () => {
    expect(parseMentions("随便聊聊", ["a"])).toEqual({ all: false, mentions: [] });
  });
});

describe("runGroupTalk", () => {
  it("single：仅点名者发言，其流式回调齐全", async () => {
    const a = mk("甲"); const b = mk("乙");
    const chunks: string[] = []; const rs: string[] = [];
    const a2: GroupTalkParticipant = { ...a, speakStream: async (p, e: StreamEmit) => { a.prompts.push(p); e.reasoning("想…"); e.chunk("第"); e.chunk("一段"); return "甲乙观点"; } };
    const out = await runGroupTalk({ members: [a2, b], topic: "议题", mode: "single", targets: ["甲"],
      onReasoning: (_m, c) => rs.push(c), onChunk: (_m, c) => chunks.push(c) });
    expect(out.count).toBe(1);
    expect(out.transcript.map((l) => l.speaker)).toEqual(["用户", "甲"]);
    expect(rs).toEqual(["想…"]);
    expect(chunks).toEqual(["第", "一段"]);
    expect(b.prompts).toHaveLength(0); // 未被点名不发
  });

  it("seq：顺序非并发，后一个能看到前一个的发言", async () => {
    const a = mk("A", "R", 5); const bS = mk("B", "R", 0);
    await runGroupTalk({ members: [bS, a], topic: "T", mode: "seq", order: ["A", "B"] });
    expect(a.prompts).toHaveLength(1);
    expect(bS.prompts[0]).toContain("A观点1"); // B 的 prompt 包含 A 已产出原文
  });

  it("contest：并行预研、按完成顺序逐个回放（先快者先上台），有分歧则两轮", async () => {
    const slow = mk("慢", "R", 30); const fast = mk("快", "R", 0);
    const order: string[] = [];
    const { transcript } = await runGroupTalk({ members: [slow, fast], topic: "实现这个功能，是我们来讨论一下方案？", mode: "contest",
      onSpeechEnd: (m) => order.push(m.name) });
    expect(order[0]).toBe("快"); // 完成先上台
    expect(order[1]).toBe("慢");
    expect(order.length).toBe(4); // 有任务意图 → 预研回放 + 互看回应轮
    expect(transcript[1]?.speaker).toBe("快");
    expect(transcript[2]?.speaker).toBe("慢");
  });

  it("contest 互看：第二轮回应轮能看到第一轮全体观点（prompt 含他人名）", async () => {
    const a = mk("A"); const b = mk("B");
    await runGroupTalk({ members: [a, b], topic: "把这个优化方案落地，来讨论一下步骤？", mode: "contest" });
    // 每成员两段发言（预研 + 回应）；回应段的 prompt 应含其他成员第一轮观点名
    expect(a.prompts).toHaveLength(2);
    expect(b.prompts).toHaveLength(2);
    expect(a.prompts[1]).toContain("B观点1");
    expect(b.prompts[1]).toContain("A观点1");
  });

  it("contest：压缩钩子按成员生效（compressTranscript 返回精简记录则 prompt 不含他人发言）", async () => {
    const a = mk("A"); const b = mk("B");
    await runGroupTalk({ members: [a, b], topic: "我们怎么评估这个方案的好坏？", mode: "contest", compressTranscript: () => [{ speaker: "用户", content: "T" }] });
    expect(a.prompts[0]).not.toContain("B观点");
    expect(a.prompts[1]).not.toContain("B观点");
  });

  it("A-959：寒暄/短议题 → 单轮收敛（不执行回应轮，只每人发言一次）", async () => {
    const a = mk("A"); const b = mk("B");
    const ends: string[] = [];
    await runGroupTalk({ members: [a, b], topic: "大家好", mode: "contest", onSpeechEnd: (m) => ends.push(m.name) });
    expect(ends.length).toBe(2); // 各一次（无回应轮）
    expect(a.prompts).toHaveLength(1);
    expect(b.prompts).toHaveLength(1);
  });

  it("A-959：有任务意图 → 仍两轮；可显式关闭回应轮", async () => {
    const a = mk("A"); const b = mk("B");
    const ends: string[] = [];
    await runGroupTalk({ members: [a, b], topic: "我们讨论一下怎么优化", mode: "contest", onSpeechEnd: (m) => ends.push(m.name) });
    expect(ends.length).toBe(4); // 两轮
    const single: string[] = [];
    await runGroupTalk({ members: [a, b], topic: "我们讨论一下怎么优化", mode: "contest", rebuttalFilter: () => false, onSpeechEnd: (m) => single.push(m.name) });
    expect(single.length).toBe(2); // 显式关闭 → 单轮
  });
});

describe("defaultRebuttalFilter（A-959 回应轮收敛判定）", () => {
  it("寒暄/短议题无任务意图 → false（不回应）", () => {
    expect(defaultRebuttalFilter("大家好", [])).toBe(false);
    expect(defaultRebuttalFilter("早上好！", [])).toBe(false);
    expect(defaultRebuttalFilter("嗯嗯", [])).toBe(false);
  });
  it("短问句（还没观点）→ false：一轮作答即可，不空转回应轮", () => {
    expect(defaultRebuttalFilter("为什么？", [])).toBe(false);
    expect(defaultRebuttalFilter("怎么优化", [])).toBe(false);
  });
  it("有任务意图且存在分歧（观点互不重合）→ true 保留回应轮；高度一致 → false", () => {
    const same = [{ speaker: "A", content: "我觉得用方案一更好，因为简单可靠稳当省心" }, { speaker: "B", content: "我觉得用方案一更好，因为简单可靠稳当省心" }];
    expect(defaultRebuttalFilter("怎么优化方案", same)).toBe(false); // 高度一致 → 已收敛
    const diff = [{ speaker: "A", content: "我主张用方案一，快" }, { speaker: "B", content: "我坚持方案二，稳" }];
    expect(defaultRebuttalFilter("怎么优化方案", diff)).toBe(true); // 分歧 → 保留回应轮
  });
});