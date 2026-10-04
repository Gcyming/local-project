















import { randomUUID } from "node:crypto";



export interface BrainstormParticipant {
  id: string;
  name: string;
  role: string;
  
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
  

  leader?: BrainstormParticipant;
  members: BrainstormParticipant[];
  topic: string;
  
  maxRounds?: number;
  
  summaryPrompt?: (transcript: TranscriptLine[]) => string;
  
  onSpeech?: (sp: Speech & { kind: "member" | "leader" }) => void;
  
  onRound?: (round: BrainstormRound) => void;
  onSummary?: (summary: string) => void;
}

export interface TranscriptLine {
  speaker: string;
  content: string;
  





  failed?: boolean;
}

const DEFAULT_ROUNDS = 2;




export function formatTranscript(lines: TranscriptLine[]): string {
  if (lines.length === 0) { return "（暂无讨论内容）"; }
  return lines.map((l) => `【${l.speaker}】${l.content}`).join("\n\n");
}


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


export function buildLeaderRoundPrompt(leader: { name: string; role: string }, transcript: TranscriptLine[], round: number): string {
  return (
    `群聊头脑风暴：你是组长「${leader.name}」（角色：${leader.role}）。第 ${round} 轮成员发言已结束，讨论记录：\n` +
    `${formatTranscript(transcript)}\n\n` +
    `请以组长身份点评本轮：指出目前达成的一致点、存在的分歧，点名一两个最需要补充/追问的方向（可点名成员）。150 字以内。`
  );
}


export function buildLeaderSummaryPrompt(leader: { name: string; role: string }, transcript: TranscriptLine[]): string {
  return (
    `群聊头脑风暴：你是组长「${leader.name}」（角色：${leader.role}）。全部讨论结束，最终讨论记录：\n` +
    `${formatTranscript(transcript)}\n\n` +
    `请输出终局总结（300 字以内）：① 整体结论/推荐方向；② 成员间的关键分歧及取舍；③ 建议的下一步行动。`
  );
}




export async function runBrainstorm(opts: BrainstormOptions): Promise<BrainstormRun> {
  const id = randomUUID();
  const maxRounds = Math.max(1, Math.min(5, opts.maxRounds ?? DEFAULT_ROUNDS));
  const topic = (opts.topic ?? "").trim();
  
  const leaderName = opts.leader?.name ?? "用户";
  const transcript: TranscriptLine[] = [{ speaker: "用户", content: topic || "（未提供议题）" }];
  const rounds: BrainstormRound[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    
    const speeches: Speech[] = await Promise.all(opts.members.map(async (m) => {
      const content = (await m.speak(buildMemberPrompt(m, leaderName, transcript, round, maxRounds)) ?? "").trim();
      return { memberId: m.id, name: m.name, content: content || `（${m.name} 本轮未输出）` };
    }));
    const roundRec: BrainstormRound = { index: round, speeches };
    
    for (const sp of speeches) {
      transcript.push({ speaker: sp.name, content: sp.content });
      opts.onSpeech?.({ ...sp, kind: "member" });
    }
    
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