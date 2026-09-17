/**
 * core-ts/src/services/brainstorm.ts — 群聊头脑风暴引擎（AutoGen GroupChat / LangGraph group chat 对标）。
 *
 * 机制（A-943，对齐 AutoGen SelectorGroupChat 的「共享讨论串 + 组长统一调度」共识）：
 * - 全员围观同一条讨论记录（transcript），成员发言广播给所有人；
 * - 每轮所有成员**并行**发言（成本 O(n)/轮）：第 1 轮自由发表看法，后续轮针对已有观点
 *   支持 / 反驳 / 纠错 / 补充——现实中小组头脑风暴的相互追问；
 * - 每轮结束后组长（Team Lead）点评 / 点名追问 / 指出分歧；
 * - 跑满 maxRounds 后组长做终局总结（收束：结论 + 分歧点 + 下一步）。
 *
 * 与旧「传唤」（<DELEGATE> 单向委派）并存：群聊是用户发议题 → 引擎主动召集全体成员讨论；
 * 传唤仍是普通会话中主 Agent 按需点名单个成员执行子任务。
 *
 * 执行器（runBrainstorm）不调模型，通过注入口 member.speak() 回调接入 SlimeEngine；
 * 提示词构建为纯函数（build*Prompt / formatTranscript），零外部依赖、可单测。
 */
import { randomUUID } from "node:crypto";

// ── 类型 ──────────────────────────────────────────────────

export interface BrainstormParticipant {
  id: string;
  name: string;
  role: string;
  /** 发言调用（装配方注入：engine.chat toolsOnly=[] 走无工具单轮，最省成本） */
  speak: (prompt: string) => Promise<string>;
}

export interface Speech {
  memberId: string;
  name: string;
  content: string;
}

export interface BrainstormRound {
  index: number;
  speeches: Speech[];
  /** 组长对本轮点评/点名追问；null = 未生成 */
  leaderReview?: string;
}

export interface BrainstormRun {
  id: string;
  topic: string;
  maxRounds: number;
  rounds: BrainstormRound[];
  summary: string;
  finishedAt: number;
}

export interface BrainstormOptions {
  /** 组长（可选）：**建立群聊的用户才是真正的组长**——不传时只做全员并行发言，无 Agent 点评/总结，
   *  讨论直接呈现给用户（用户自行收束）；传入时（CLI/接口场景）组长每轮点评、末轮终局总结。 */
  leader?: BrainstormParticipant;
  members: BrainstormParticipant[];
  topic: string;
  /** 讨论轮数上限（默认 2；每轮 = 全员并行发言 1 次 + 组长点评 1 次（仅 leader 存在时）） */
  maxRounds?: number;
  /** 组长终局总结提示词构建（默认 buildLeaderSummaryPrompt；测试可覆写） */
  summaryPrompt?: (transcript: TranscriptLine[]) => string;
  /** 逐条发言即时回调（流式：每产生一条成员发言/组长点评即通知外部；避免攒到轮次结束才可见） */
  onSpeech?: (sp: Speech & { kind: "member" | "leader" }) => void;
  /** 逐轮回调（主进程流式广播进度用） */
  onRound?: (round: BrainstormRound) => void;
  onSummary?: (summary: string) => void;
}

export interface TranscriptLine {
  speaker: string;
  content: string;
}

const DEFAULT_ROUNDS = 2;

// ── 纯逻辑（可单测） ─────────────────────────────────────

/** 讨论记录 → 文本（带发言者前缀，供模型语境注入） */
export function formatTranscript(lines: TranscriptLine[]): string {
  if (lines.length === 0) { return "（暂无讨论内容）"; }
  return lines.map((l) => `【${l.speaker}】${l.content}`).join("\n\n");
}

/** 成员本轮发言指令：第 1 轮自由发表；后续轮针对已有观点支持/反驳/纠错/补充 */
export function buildMemberPrompt(member: { name: string; role: string }, leaderName: string, transcript: TranscriptLine[], round: number, maxRounds: number): string {
  const isFirst = round <= 1;
  const guidance = isFirst
    ? "请围绕议题从你的专业视角发表看法：提出观点、可行思路或需要重视的风险。"
    : "请基于上述全部讨论发言：支持或反驳他人的观点时说明理由；发现他人观点中的事实错误或逻辑漏洞请明确指出；也可以补充新的角度。不要简单复述已有内容，聚焦增量价值。";
  const lastRound = round >= maxRounds ? "（这是最后一轮，请把最有价值的意见说透。）" : "";
  return (
    `群聊头脑风暴：组长为 ${leaderName}，你是成员「${member.name}」（角色：${member.role}）。\n` +
    `议题：${transcript[0]?.content ?? ""}\n\n` +
    `当前为第 ${round}/${maxRounds} 轮，讨论记录如下：\n${formatTranscript(transcript.slice(0, Math.max(1, isFirst ? 1 : transcript.length)))}` +
    `\n\n${guidance}${lastRound}\n请直接输出你的发言（200 字以内，一次一段）。`
  );
}

/** 组长每轮点评指令：点评全员发言、指出分歧、点名追问 */
export function buildLeaderRoundPrompt(leader: { name: string; role: string }, transcript: TranscriptLine[], round: number): string {
  return (
    `群聊头脑风暴：你是组长「${leader.name}」（角色：${leader.role}）。第 ${round} 轮成员发言已结束，讨论记录：\n` +
    `${formatTranscript(transcript)}\n\n` +
    `请以组长身份点评本轮：指出目前达成的一致点、存在的分歧，点名一两个最需要补充/追问的方向（可点名成员）。150 字以内。`
  );
}

/** 组长终局总结指令：收束结论 + 分歧点 + 下一步 */
export function buildLeaderSummaryPrompt(leader: { name: string; role: string }, transcript: TranscriptLine[]): string {
  return (
    `群聊头脑风暴：你是组长「${leader.name}」（角色：${leader.role}）。全部讨论结束，最终讨论记录：\n` +
    `${formatTranscript(transcript)}\n\n` +
    `请输出终局总结（300 字以内）：① 整体结论/推荐方向；② 成员间的关键分歧及取舍；③ 建议的下一步行动。`
  );
}

// ── 执行器（不调模型；speak 由装配方注入） ─────────────────

/** 运行一轮头脑风暴：并行成员发言 → 组⻓点评 → 循环；收尾组长终局总结。 */
export async function runBrainstorm(opts: BrainstormOptions): Promise<BrainstormRun> {
  const id = randomUUID();
  const maxRounds = Math.max(1, Math.min(5, opts.maxRounds ?? DEFAULT_ROUNDS));
  const topic = (opts.topic ?? "").trim();
  // 用户 = 真正的组长：讨论记录的发起者与收束者；leader（可选）仅作额外调度角色
  const leaderName = opts.leader?.name ?? "用户";
  const transcript: TranscriptLine[] = [{ speaker: "用户", content: topic || "（未提供议题）" }];
  const rounds: BrainstormRound[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    // 并行轮：全员同时收到同一份讨论记录（组长未设置时，成员视角的组长 = 用户）
    const speeches: Speech[] = await Promise.all(opts.members.map(async (m) => {
      const content = (await m.speak(buildMemberPrompt(m, leaderName, transcript, round, maxRounds)) ?? "").trim();
      return { memberId: m.id, name: m.name, content: content || `（${m.name} 本轮未输出）` };
    }));
    const roundRec: BrainstormRound = { index: round, speeches };
    // 广播：成员发言追加进共享讨论记录（成员下一轮可见彼此观点），并即时回调（流式）
    for (const sp of speeches) {
      transcript.push({ speaker: sp.name, content: sp.content });
      opts.onSpeech?.({ ...sp, kind: "member" });
    }
    // 组长点评（仅当显式设置了 leader 且有后续轮次）：点评/点名追问
    if (opts.leader && round < maxRounds) {
      const review = (await opts.leader.speak(buildLeaderRoundPrompt(opts.leader, transcript, round))).trim();
      roundRec.leaderReview = review || undefined;
      if (roundRec.leaderReview) {
        transcript.push({ speaker: opts.leader.name, content: roundRec.leaderReview });
        opts.onSpeech?.({ memberId: opts.leader.id, name: opts.leader.name, content: roundRec.leaderReview, kind: "leader" });
      }
    }
    rounds.push(roundRec);
    opts.onRound?.(roundRec);
  }

  // 终局收束（组长可选）：不设置 leader 时由"用户（组长）"自行收束，不生成 Agent 总结
  let summary = "";
  if (opts.leader) {
    const summaryPrompt = opts.summaryPrompt ?? ((lines: TranscriptLine[]) => buildLeaderSummaryPrompt(opts.leader!, lines));
    summary = (await opts.leader.speak(summaryPrompt(transcript))).trim();
    opts.onSummary?.(summary);
  } else {
    opts.onSummary?.("");
  }

  return { id, topic, maxRounds, rounds, summary, finishedAt: Date.now() };
}