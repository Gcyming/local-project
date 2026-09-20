/**
 * grouptalk-transcript.spec.ts — 群聊发言的「结构化落库 ↔ 还原」回归（A-1008）。
 *
 * 为什么这个文件必须存在（对应两个**历时很久、反复修还是这样**的故障）：
 *
 *   ①「总有一个 Agent 出来把所有内容总结重复一遍」
 *   ②「退出 slime 重启后历史会话消失，只剩那个总结的 Agent」
 *
 * 两个症状的**同一根因**：群聊把全体发言拼成一个大字符串、只写**一条** history 记录；
 * 读回来时又产出一条**不带 agentName/agentId** 的 assistant 消息 → 渲染层回退到"会话归属
 * Agent"的名字。于是"一条把所有人揉在一起、署名却是某个 Agent"的巨长气泡 = 看起来像总结复述；
 * 而成员各自的气泡从未落库 → 重启只剩那一条。
 *
 * 所以本文件锁死三件事：
 *   1. `formatSpeakerBlob` 仍然产出与旧格式**逐字节相同**的文本（模型侧历史零变化）；
 *   2. `parseSpeakerBlob` 对旧记录保守还原 —— 宁可返回 null 也不要切出假发言；
 *   3. `expandHistoryRecord` 把一条群聊记录展开成**逐成员多条**，各带自己的归属，
 *      且 `reasoning/elapsedMs/timeline` 只挂首条（只存了一份，重复挂会重复渲染）。
 *
 * ## ⚠️ 症状①有**第二个、独立的**产地（B 根因）：`fullReply` 被成员发言污染
 *
 * 上面(A)说的是"读旧记录"时那条假"总结"气泡。但用户实测：A 修完之后当场**依旧**多出一条
 * 「某 Agent 把所有人内容总结复述一遍」的气泡 —— 那一条根本没经过 history.jsonl，
 * 它是**当场流式**产生的：
 *   - 群聊的 done 事件里 `reply` 恒为 `""`（A-946：正文由成员各自的气泡收束）；
 *   - 主进程 done 处理写成 `reply: cleanReply ?? session.fullReply` → `""` 是 falsy → 回退；
 *   - 而 `createStreamSession().pushChunk` 原本**无条件** `fullReply += chunk.data.content`
 *     → 把 `member` / `speech-end` 等"别人的发言"也攒进去了 → 回退值 = 全体成员发言首尾相接。
 * 守卫在文件末尾（读 `gui/src/main/index.ts` 源码断言闸门），别在别处再实现一遍累积。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  formatSpeakerBlob,
  parseSpeakerBlob,
  isSpeechFailure,
  expandHistoryRecord,
  type SpeakerTurn,
} from "../../core-ts/src/services/grouptalkTranscript.js";

const turns: SpeakerTurn[] = [
  { name: "test1", agentId: "04de8e0a21a7", content: "我建议先落库结构化 turns。" },
  { name: "t2", agentId: "9a972c223653", content: "（t2 本次发言失败：chatStream 全部路由失败: 上游错误 404）", failed: true },
  { name: "Omni", agentId: "09b53eb84c4e", content: "同意，但要注意旧记录兼容。" },
];

describe("formatSpeakerBlob（模型侧历史文本，必须与旧格式逐字节相同）", () => {
  it("输出 `【名字】内容` 空行分隔（旧记录就是这个形状）", () => {
    expect(formatSpeakerBlob(turns.slice(0, 2))).toBe(
      "【test1】我建议先落库结构化 turns。\n\n【t2】（t2 本次发言失败：chatStream 全部路由失败: 上游错误 404）",
    );
  });

  it("空列表 → 空串（不产出多余的换行）", () => {
    expect(formatSpeakerBlob([])).toBe("");
  });
});

describe("parseSpeakerBlob（旧记录还原：保守优先）", () => {
  it("正常群聊记录 → 还原成逐发言", () => {
    const out = parseSpeakerBlob(formatSpeakerBlob(turns));
    expect(out).not.toBeNull();
    expect(out!.map((t) => t.name)).toEqual(["test1", "t2", "Omni"]);
    expect(out![0].content).toBe("我建议先落库结构化 turns。");
    expect(out![2].content).toBe("同意，但要注意旧记录兼容。");
  });

  it("CRLF 的行尾也能还原（仓库里 history.jsonl 是 CRLF 写的）", () => {
    const crlf = formatSpeakerBlob(turns).replace(/\n/g, "\r\n");
    const out = parseSpeakerBlob(crlf);
    expect(out!.map((t) => t.name)).toEqual(["test1", "t2", "Omni"]);
  });

  it("不以标记起头 → null（普通正文里的 `【…】` 不得被切成假发言）", () => {
    expect(parseSpeakerBlob("参考《【重要】文档》里的说明，然后【补充】两点")).toBeNull();
    expect(parseSpeakerBlob("前导说明\n\n【test1】正文")).toBeNull();
  });

  it("标记数不足 minTurns → null（默认 2；群聊可传 1 以支持 @ 单人）", () => {
    const one = "【test1】只有一条发言";
    expect(parseSpeakerBlob(one)).toBeNull();
    expect(parseSpeakerBlob(one, { minTurns: 1 })!.map((t) => t.name)).toEqual(["test1"]);
  });

  it("空文本 / 只有空白 → null", () => {
    expect(parseSpeakerBlob("")).toBeNull();
    expect(parseSpeakerBlob("   \n  ")).toBeNull();
    expect(parseSpeakerBlob(undefined as unknown as string)).toBeNull();
  });

  it("某条发言为空正文 → 该条被丢弃（不产出空气泡）", () => {
    const out = parseSpeakerBlob("【a】正文甲\n\n【b】\n\n【c】正文丙");
    expect(out!.map((t) => t.name)).toEqual(["a", "c"]);
  });
});

describe("isSpeechFailure（失败占位文本识别）", () => {
  it("引擎写的失败占位 → true", () => {
    expect(isSpeechFailure("（t2 本次发言失败：chatStream 全部路由失败: 上游错误 404）")).toBe(true);
  });
  it("正常观点（哪怕提到'失败'二字）→ false", () => {
    expect(isSpeechFailure("本次的构建失败率下降了。")).toBe(false);
    expect(isSpeechFailure("")).toBe(false);
  });
});

describe("expandHistoryRecord（一条记录 → GUI 消息列表）", () => {
  it("群聊新记录（有 turns）→ 逐成员多条，各带自己的 agentName/agentId", () => {
    const msgs = expandHistoryRecord({
      user: "我们来定一下落库方案",
      ai: formatSpeakerBlob(turns),
      timestamp: "2026-09-18T10:00:00.000Z",
      reasoning: "（组长思考）",
      elapsed_ms: 1234,
      timeline: [{ kind: "think", text: "x" }],
      turns,
    });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    const speakers = msgs.filter((m) => m.role === "assistant");
    expect(speakers.map((m) => m.agentName)).toEqual(["test1", "t2", "Omni"]);
    expect(speakers.map((m) => m.agentId)).toEqual(["04de8e0a21a7", "9a972c223653", "09b53eb84c4e"]);
    // 失败那条必须带 failed（UI 降级为错误样式），正常条不带
    expect(speakers.map((m) => m.failed)).toEqual([undefined, true, undefined]);
  });

  it("reasoning / elapsedMs / timeline 只挂首条发言（一条记录只存了一份）", () => {
    const msgs = expandHistoryRecord({
      user: "议题", ai: formatSpeakerBlob(turns), timestamp: "t",
      reasoning: "（组长思考）", elapsed_ms: 1234, timeline: [{ kind: "think" }], turns,
    });
    const speakers = msgs.filter((m) => m.role === "assistant");
    expect(speakers[0].reasoning).toBe("（组长思考）");
    expect(speakers[0].elapsedMs).toBe(1234);
    expect(speakers[0].timeline).toEqual([{ kind: "think" }]);
    expect(speakers[1].reasoning).toBeUndefined();
    expect(speakers[1].elapsedMs).toBeUndefined();
    expect(speakers[1].timeline).toBeUndefined();
  });

  it("群聊旧记录（没有 turns）→ 走 parseSpeakerBlob 还原，失败文本仍被认出来", () => {
    const msgs = expandHistoryRecord(
      { user: "议题", ai: formatSpeakerBlob(turns), timestamp: "t" },
      new Set(["test1", "t2", "Omni"]),
    );
    const speakers = msgs.filter((m) => m.role === "assistant");
    expect(speakers.map((m) => m.agentName)).toEqual(["test1", "t2", "Omni"]);
    // 旧记录没有 turns.failed，只能靠正文判定 —— 这条路也必须认出来
    expect(speakers[1].failed).toBe(true);
    // 旧记录没有 agentId：留 undefined，让渲染层按名字反查
    expect(speakers[0].agentId).toBeUndefined();
  });

  it("普通单人记录（不像群聊）→ 仍然只产出一条 assistant 消息（旧行为不变）", () => {
    const msgs = expandHistoryRecord(
      { user: "你好", ai: "普通回复，正文里有【注意】两个字", timestamp: "t", elapsed_ms: 5 },
      new Set(["test1"]),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe("普通回复，正文里有【注意】两个字");
    expect(msgs[1].agentName).toBeUndefined();
    expect(msgs[1].elapsedMs).toBe(5);
  });

  it("群聊会话里 @ 单人（一轮只有一条发言）→ groupNames 命中时按 1 条阈值也能展开", () => {
    const single = "【test1】这条只有我一个人说";
    const asGroup = expandHistoryRecord({ ai: single, timestamp: "t" }, new Set(["test1", "t2"]));
    expect(asGroup.map((m) => m.agentName)).toEqual(["test1"]);
    // 非群聊会话（groupNames 缺省）→ 退回单条，不猜
    const asNormal = expandHistoryRecord({ ai: single, timestamp: "t" });
    expect(asNormal).toHaveLength(1);
    expect(asNormal[0].agentName).toBeUndefined();
  });

  /*
   * 这条是本修复**自己会引入的新故障**的守卫：
   * 模型爱用 `【小标题】` 写正文（「【结论】…【建议】…」）。若只看"以标记起头 + 有标记"
   * 就切，一条普通单人回复会被切成两条假成员气泡（署名"结论""建议"）。
   * 判据必须是"解析出的发言者里至少有一个真在成员名单里"。
   */
  it("群聊会话里的普通回复（【小标题】排版）→ 标记名不在成员名单 → 不切", () => {
    const normal = "【结论】这次改动风险可控。\n\n【建议】先跑全量测试再构建。";
    const msgs = expandHistoryRecord({ ai: normal, timestamp: "t" }, new Set(["test1", "t2"]));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].agentName).toBeUndefined();
    expect(msgs[0].content).toBe(normal);
  });

  it("群聊旧记录里只要有一个发言者命中名单就照切（成员被改名/退群不至于整条放弃）", () => {
    const blob = "【test1】甲\n\n【已退群的老王】乙";
    const msgs = expandHistoryRecord({ ai: blob, timestamp: "t" }, new Set(["test1", "t2"]));
    expect(msgs.map((m) => m.agentName)).toEqual(["test1", "已退群的老王"]);
  });

  it("ai 为空 → 只回用户那条（不产出空 assistant 气泡）", () => {
    const msgs = expandHistoryRecord({ user: "只有提问", ai: "", timestamp: "t" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("turns 为空数组 → 视为没有结构化数据（回退到文本解析）", () => {
    const msgs = expandHistoryRecord(
      { ai: formatSpeakerBlob(turns), timestamp: "t", turns: [] },
      new Set(["test1", "t2", "Omni"]),
    );
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(3);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────
 * B 根因（症状①的第二个产地）：当场流式那条假"总结"气泡
 * ────────────────────────────────────────────────────────────────────────────
 * 这条故障的特点是"**改回去完全不报错**"：tsc 绿、单测绿、只有真人跑一轮群聊才看得见。
 * 所以只能把闸门逐字钉在源码文本上。
 *
 * 断言前先剥掉注释 —— index.ts 里那段事故说明本身写着 `fullReply += chunk.data.content`
 * （作为"旧写法"的对照引用），不剥注释就会**被自己写的说明误伤**。
 */
function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("A-1008 B 根因：done 回退用的 fullReply 只能累积本会话 Agent 自己的正文", () => {
  const main = codeOf("gui/src/main/index.ts");

  it("每一处 `fullReply +=` 都必须被 `chunk.type === \"chunk\"` 闸门守住", () => {
    const lines = main.split("\n").filter((l) => l.includes("fullReply +="));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // 闸门被撤掉 → member / speech-end / reasoning 的 content 会被当成"本会话 Agent 的正文"
      // → 全体成员发言首尾相接 → done 回退把这个大字符串渲染成一条没有成员标记的巨型气泡
      expect(line).toContain('chunk.type === "chunk"');
      expect(line).toContain("chunk.data.content");
    }
  });

  it("群聊的 done 回退路径仍然存在（reply 恒为空串时不能产出空气泡）", () => {
    expect(main).toContain("reply: cleanReply ?? session.fullReply");
  });

  it("累积实现只有一份（不许在别处再攒一遍同样的 fullReply）", () => {
    expect(main.split("fullReply +=").length - 1).toBe(1);
  });
});
