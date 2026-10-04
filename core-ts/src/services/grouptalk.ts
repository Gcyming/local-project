











import { randomUUID } from "node:crypto";
import type { TranscriptLine } from "./brainstorm.js";
import { isSpeechFailure } from "./grouptalkTranscript.js";

export type { TranscriptLine } from "./brainstorm.js";

export interface StreamEmit {
  
  reasoning: (chunk: string) => void;
  
  chunk: (text: string) => void;
  
  firstChunk: () => void;
}

export interface GroupTalkParticipant {
  id: string;
  name: string;
  role: string;
  
  speak?: (prompt: string) => Promise<string>;
  
  speakStream?: (prompt: string, emit: StreamEmit) => Promise<string>;
}

export type GroupTalkMode = "single" | "seq" | "contest";

export interface GroupTalkOptions {
  members: GroupTalkParticipant[];
  topic: string;
  mode: GroupTalkMode;
  
  targets?: string[];
  
  order?: string[];
  
  transcript?: TranscriptLine[];
  
  buildPrompt?: (member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]) => string;
  
  buildRebuttalPrompt?: (member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]) => string;
  

  rebuttalFilter?: (topic: string, round1: TranscriptLine[]) => boolean;
  
  compressTranscript?: (memberId: string, transcript: TranscriptLine[]) => TranscriptLine[] | undefined;
  onSpeechStart?: (m: { memberId: string; name: string }, index: number) => void;
  onReasoning?: (m: { memberId: string; name: string }, chunk: string) => void;
  onChunk?: (m: { memberId: string; name: string }, text: string) => void;
  onSpeechEnd?: (m: { memberId: string; name: string }, full: string) => void;
  onDone?: (transcript: TranscriptLine[]) => void;
}




function realSpeech(transcript: TranscriptLine[]): TranscriptLine[] {
  return transcript.filter((l) => !l.failed);
}

function defaultPrompt(member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]): string {
  const seen = realSpeech(transcript);
  const history = seen.length > 1
    ? `\n\n当前讨论记录：\n${seen.map((l) => `【${l.speaker}】${l.content}`).join("\n\n")}`
    : "";
  return (
    `群聊讨论：你是「${member.name}」（角色：${member.role}）。议题：${topic || "（未提供）"}${history}\n\n` +
    `请先内部充分思考（思考内容不要输出在正文），正文 200 字以内、一段；观点要具体、可操作，可对前面发言补充或指出分歧。`
  );
}


function defaultRebuttalPrompt(member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]): string {
  const seen = realSpeech(transcript);
  const history = seen.length > 1
    ? `\n\n当前全部发言（含其他成员观点）：\n${seen.map((l) => `【${l.speaker}】${l.content}`).join("\n\n")}`
    : "";
  return (
    `群聊讨论·回应轮：你是「${member.name}」（角色：${member.role}）。议题：${topic || "（未提供）"}${history}\n\n` +
    `现在你已看到其他成员的观点。请输出你的回应（200 字以内、一段）：支持/反驳请说明理由，指出分歧或事实错误，给出最终收敛建议。` +
    `\n硬性要求：严禁复述/粘贴/回显上面“当前全部发言”中的任何原文，也严禁逐条转述他人发言——直接针对观点给出你的新内容；若你只是重复他人观点，宁可只说“同意/补充一点”。`
  );
}


export function parseMentions(text: string, names: string[]): { all: boolean; mentions: string[] } {
  const t = text ?? "";
  if (/@[ \t]*(全体|所有人|everyone|all)/i.test(t)) {
    return { all: true, mentions: [] };
  }
  const found = new Set<string>();
  for (const n of names) {
    if (!n) { continue; }
    const re = new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s，。、,.;:!?！？])`);
    if (re.test(t)) { found.add(n); }
  }
  return { all: false, mentions: [...found] };
}


function hasTaskIntention(topic: string): boolean {
  const t = topic.trim();
  if (!t) { return false; }
  if (/[?？]/.test(t)) { return true; } 
  return /怎么|如何|怎样|应该|需要|方案|建议|讨论|分析|优化|修复|设计|实现|是否|评估|比较|总结|安排|计划|写|做|改|查|看|找/.test(t);
}


function charOverlap(a: string, b: string): number {
  const A = a.replace(/\s+/g, "");
  const B = b.replace(/\s+/g, "");
  if (A.length + B.length === 0) { return 1; }
  const cnt = new Map<string, number>();
  for (const ch of A) { cnt.set(ch, (cnt.get(ch) ?? 0) + 1); }
  let inter = 0;
  for (const ch of B) {
    const n = cnt.get(ch) ?? 0;
    if (n > 0) { inter += 1; cnt.set(ch, n - 1); }
  }
  return (inter * 2) / (A.length + B.length);
}



export function defaultRebuttalFilter(topic: string, round1: TranscriptLine[]): boolean {
  const t = topic.trim();
  if (t && t.length <= 10 && !hasTaskIntention(t)) {
    return false;
  }
  const items = round1.map((l) => l.content.trim()).filter(Boolean);
  if (items.length < 2) { return false; }
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      total += charOverlap(items[i], items[j]);
      pairs += 1;
    }
  }
  return (total / pairs) <= 0.9;
}


export async function runGroupTalk(opts: GroupTalkOptions): Promise<{ transcript: TranscriptLine[]; count: number }> {
  const members = opts.members;
  const topic = (opts.topic ?? "").trim();
  const transcript: TranscriptLine[] = opts.transcript
    ? [...opts.transcript]
    : [{ speaker: "用户", content: topic || "（未提供议题）" }];
  const buildPrompt = opts.buildPrompt ?? defaultPrompt;
  const emit = (m: GroupTalkParticipant) => ({
    reasoning: (chunk: string) => opts.onReasoning?.({ memberId: m.id, name: m.name }, chunk),
    chunk: (text: string) => opts.onChunk?.({ memberId: m.id, name: m.name }, text),
    firstChunk: () => {  },
  });

  
  const speakOne = async (m: GroupTalkParticipant, index: number, rebuttal = false): Promise<void> => {
    
    const hist = opts.compressTranscript?.(m.id, transcript) ?? transcript;
    const prompt = rebuttal
      ? (opts.buildRebuttalPrompt ?? defaultRebuttalPrompt)(m, topic, hist)
      : buildPrompt(m, topic, hist);
    opts.onSpeechStart?.({ memberId: m.id, name: m.name }, index);
    let full = "";
    if (m.speakStream) {
      full = await m.speakStream(prompt, emit(m));
    } else if (m.speak) {
      const e = emit(m);
      const buf = await m.speak(prompt);
      for (const seg of buf.match(/.{1,200}/gs) ?? []) { e.chunk(seg); }
      full = buf;
    }
    const content = (full ?? "").trim() || `（${m.name} 未输出）`;
    
    transcript.push({ speaker: m.name, content, ...(isSpeechFailure(content) ? { failed: true } : {}) });
    opts.onSpeechEnd?.({ memberId: m.id, name: m.name }, content);
  };

  if (opts.mode !== "contest") {
    
    const byId = new Map(members.map((m) => [m.id, m]));
    const ids = (opts.mode === "single" ? (opts.targets ?? []).slice(0, 1) : (opts.order ?? opts.targets ?? []));
    const picked = ids.map((id) => byId.get(id)).filter((m): m is GroupTalkParticipant => Boolean(m));
    const roster = picked.length > 0 ? picked : members;
    for (let i = 0; i < roster.length; i++) {
      await speakOne(roster[i], i);
    }
    opts.onDone?.(transcript);
    return { transcript, count: roster.length };
  }

  
  type Slot = { m: GroupTalkParticipant; buffer: Array<{ kind: "r" | "c"; text: string }>; done: boolean; order: number };
  const slots: Slot[] = members.map((m, i) => ({ m, buffer: [], done: false, order: i }));
  
  const ready: Slot[] = [];
  let notify: (() => void) | null = null;
  const runSlot = async (slot: Slot, prompt: string): Promise<void> => {
    try {
      const e = {
        reasoning: (chunk: string) => slot.buffer.push({ kind: "r", text: chunk }),
        chunk: (text: string) => slot.buffer.push({ kind: "c", text }),
        firstChunk: () => {},
      };
      if (slot.m.speakStream) {
        await slot.m.speakStream(prompt, e);
      } else if (slot.m.speak) {
        
        const buf = await slot.m.speak(prompt);
        if (buf) { e.chunk(buf); }
      }
    } finally {
      slot.done = true;
      ready.push(slot);
      notify?.();
    }
  };
  for (const s of slots) {
    void runSlot(s, buildPrompt(s.m, topic, transcript)); 
  }

  let index = 0;
  const speechOrder: GroupTalkParticipant[] = [];
  while (slots.some((s) => !s.done) || ready.length > 0) {
    if (ready.length === 0) {
      await new Promise<void>((r) => { notify = r; });
      notify = null;
      continue;
    }
    const slot = ready.shift()!;
    
    opts.onSpeechStart?.({ memberId: slot.m.id, name: slot.m.name }, index);
    let full = "";
    for (const b of slot.buffer) {
      if (b.kind === "r") { opts.onReasoning?.({ memberId: slot.m.id, name: slot.m.name }, b.text); }
      else { opts.onChunk?.({ memberId: slot.m.id, name: slot.m.name }, b.text); full += b.text; }
    }
    const content = (full ?? "").trim() || `（${slot.m.name} 未输出）`;
    
    transcript.push({ speaker: slot.m.name, content, ...(isSpeechFailure(content) ? { failed: true } : {}) });
    opts.onSpeechEnd?.({ memberId: slot.m.id, name: slot.m.name }, content);
    speechOrder.push(slot.m);
    index++;
  }
  
  
  
  
  const round1 = realSpeech(transcript).slice(1); 
  const needRebuttal = (opts.rebuttalFilter ?? defaultRebuttalFilter)(topic, round1);
  if (needRebuttal) {
    const rebuttalMembers = speechOrder.length === members.length ? speechOrder : members;
    for (let i = 0; i < rebuttalMembers.length; i++) {
      await speakOne(rebuttalMembers[i], index + i, true);
    }
  }
  opts.onDone?.(transcript);
  return { transcript, count: slots.length };
}

export { randomUUID };