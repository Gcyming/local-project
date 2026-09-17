/**
 * core-ts/src/services/grouptalk.ts — 群聊发言调度引擎（A-950，A-951 学理落地）。
 *
 * 移植业界群聊 turn-taking 共识（AmorLink 五级决策梯 / fanyamin Conversation Router /
 * Claude Tag @ 路由 / AutoGen GroupChat / ACM threaded chat）：
 * - @ 路由：仅 @ 谁谁回；@全体/无 @ = 全员参与（决策梯 rung1/2）
 * - 短消息续说：紧跟成员发言的空 @ 短消息 → 上一位续说（rung3）
 * - 点名多成员 = **顺序生成**：一个一个按序发言，后一个能看到前一个的原文（sequential，rung2 学理）
 * - 无 @ 全员 = **抢答**：并行预研（省墙钟），按"谁先完成谁先上场"的顺序**逐个**回放（rung5 floor 平衡 +
 *   人类社交"先想好先说"），全程可流式
 * - 每个成员发言支持流式（speakStream: reasoning/chunk 逐段回调）
 */
import { randomUUID } from "node:crypto";
import type { TranscriptLine } from "./brainstorm.js";

export type { TranscriptLine } from "./brainstorm.js";

export interface StreamEmit {
  /** 思考增量（逐段） */
  reasoning: (chunk: string) => void;
  /** 正文增量（逐字/段） */
  chunk: (text: string) => void;
  /** 第一条正文产生（抢答计时点） */
  firstChunk: () => void;
}

export interface GroupTalkParticipant {
  id: string;
  name: string;
  role: string;
  /** 一次性发言（测试/退化路径） */
  speak?: (prompt: string) => Promise<string>;
  /** 流式发言（GUI 主路径：engine.stream） */
  speakStream?: (prompt: string, emit: StreamEmit) => Promise<string>;
}

export type GroupTalkMode = "single" | "seq" | "contest";

export interface GroupTalkOptions {
  members: GroupTalkParticipant[];
  topic: string;
  mode: GroupTalkMode;
  /** 仅 mode=single/seq：发言成员（id 列表；single 取首个） */
  targets?: string[];
  /** seq 时的明确先后顺序（id 列表；缺省按 targets 或 members 顺序） */
  order?: string[];
  /** 既有讨论记录（首条为"用户议题"；后续成员发言由引擎追加） */
  transcript?: TranscriptLine[];
  /** 成员发言指令构建（默认 buildGroupPrompt；可覆写测试） */
  buildPrompt?: (member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]) => string;
  /** contest 第二轮（互看回应轮）指令构建；缺省 buildRebuttalPrompt */
  buildRebuttalPrompt?: (member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]) => string;
  /** A-959：contest 是否需要回应轮（互看轮）——收到第一轮全体观点后判定：
   *  返回 true 才执行第二轮；缺省 defaultRebuttalFilter（寒暄/短议题/观点已高度一致 → 单轮收敛） */
  rebuttalFilter?: (topic: string, round1: TranscriptLine[]) => boolean;
  /** A-951：每成员独立上下文——装配方按该成员当下使用量返回压缩后的讨论记录；undefined=全量 */
  compressTranscript?: (memberId: string, transcript: TranscriptLine[]) => TranscriptLine[] | undefined;
  onSpeechStart?: (m: { memberId: string; name: string }, index: number) => void;
  onReasoning?: (m: { memberId: string; name: string }, chunk: string) => void;
  onChunk?: (m: { memberId: string; name: string }, text: string) => void;
  onSpeechEnd?: (m: { memberId: string; name: string }, full: string) => void;
  onDone?: (transcript: TranscriptLine[]) => void;
}

function defaultPrompt(member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]): string {
  const history = transcript.length > 1
    ? `\n\n当前讨论记录：\n${transcript.map((l) => `【${l.speaker}】${l.content}`).join("\n\n")}`
    : "";
  return (
    `群聊讨论：你是「${member.name}」（角色：${member.role}）。议题：${topic || "（未提供）"}${history}\n\n` +
    `请先内部充分思考（思考内容不要输出在正文），正文 200 字以内、一段；观点要具体、可操作，可对前面发言补充或指出分歧。`
  );
}

/** contest 第二轮——互看回应轮：成员已能看到全部第一轮观点，基于他人观点补充/纠正/收敛 */
function defaultRebuttalPrompt(member: GroupTalkParticipant, topic: string, transcript: TranscriptLine[]): string {
  const history = transcript.length > 1
    ? `\n\n当前全部发言（含其他成员观点）：\n${transcript.map((l) => `【${l.speaker}】${l.content}`).join("\n\n")}`
    : "";
  return (
    `群聊讨论·回应轮：你是「${member.name}」（角色：${member.role}）。议题：${topic || "（未提供）"}${history}\n\n` +
    `现在你已看到其他成员的观点。请输出你的回应（200 字以内、一段）：支持/反驳请说明理由，指出分歧或事实错误，给出最终收敛建议。` +
    `\n硬性要求：严禁复述/粘贴/回显上面“当前全部发言”中的任何原文，也严禁逐条转述他人发言——直接针对观点给出你的新内容；若你只是重复他人观点，宁可只说“同意/补充一点”。`
  );
}

/** @ 提及解析：@全体/@所有人 → all；@名字（Unicode 字面匹配，防部分词误伤）→ mentions */
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

/** A-959 启发式：议题是否带任务/讨论意图（寒暄问候 → 无 → 单轮即可） */
function hasTaskIntention(topic: string): boolean {
  const t = topic.trim();
  if (!t) { return false; }
  if (/[?？]/.test(t)) { return true; } // 疑问=至少要答
  return /怎么|如何|怎样|应该|需要|方案|建议|讨论|分析|优化|修复|设计|实现|是否|评估|比较|总结|安排|计划|写|做|改|查|看|找/.test(t);
}

/** 两串字符重合度（多集重叠 ×2 / 总长）；短中文观点相似度用 */
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

/** A-959 默认回应轮判定：寒暄/短议题（≤10 字且无任务意图）→ 不需要；
 *  第一轮全体观点两两高度重合（>0.9）→ 已收敛，单轮结束；否则保留互看回应轮 */
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

/** 发言调度主入口：single / seq / contest 三模式 */
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
    firstChunk: () => { /* 抢答计时点 */ },
  });

  // 单一成员发言（点名/续说/回应轮）：流式输出并并入共享讨论记录
  const speakOne = async (m: GroupTalkParticipant, index: number, rebuttal = false): Promise<void> => {
    // A-951：每成员独立上下文池——超预算按成员压缩讨论记录（compressTranscript 由装配方注入）
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
    transcript.push({ speaker: m.name, content });
    opts.onSpeechEnd?.({ memberId: m.id, name: m.name }, content);
  };

  if (opts.mode !== "contest") {
    // 点名（single / seq）：顺序非并发，后一个能看到前一个。
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

  // 抢答（contest）：并行预研 → 按"先完成"顺序逐个回放（非并发输出，避免阻塞）
  type Slot = { m: GroupTalkParticipant; buffer: Array<{ kind: "r" | "c"; text: string }>; done: boolean; order: number };
  const slots: Slot[] = members.map((m, i) => ({ m, buffer: [], done: false, order: i }));
  /** 就绪队列（成员完成 → 依完成序入队）与阻塞等待器（事件驱动，杜绝忙等轮询） */
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
        // 普通 speak（测试/退化路径）：返回值作为整段正文入缓冲，保证回放与后续互看可见
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
    void runSlot(s, buildPrompt(s.m, topic, transcript)); // 并行预研究（各自独立 prompt + 共享议程）
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
    // 逐个回放该成员完整流（思考 → 正文）——非并发输出，谁先完成谁先上台
    opts.onSpeechStart?.({ memberId: slot.m.id, name: slot.m.name }, index);
    let full = "";
    for (const b of slot.buffer) {
      if (b.kind === "r") { opts.onReasoning?.({ memberId: slot.m.id, name: slot.m.name }, b.text); }
      else { opts.onChunk?.({ memberId: slot.m.id, name: slot.m.name }, b.text); full += b.text; }
    }
    const content = (full ?? "").trim() || `（${slot.m.name} 未输出）`;
    transcript.push({ speaker: slot.m.name, content });
    opts.onSpeechEnd?.({ memberId: slot.m.id, name: slot.m.name }, content);
    speechOrder.push(slot.m);
    index++;
  }
  // A-950 补充（互看）：第二轮按第一轮完成顺序逐个"回应轮"——每个成员此时已能看到
  // 全部第一轮观点（transcript 已并入），顺序生成、后见前文。
  // A-959：回应轮不再无条件执行——寒暄/无分歧（观点高度收敛）时单轮结束，避免"问个好也讨论两轮"
  const round1 = transcript.slice(1); // 首条 = 用户议题，其余为第一轮全体观点
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