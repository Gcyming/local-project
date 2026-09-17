/**
 * core-ts/src/mind/emotion.ts — Agent 情绪状态（L3 动态心性 · 情感维度）。
 * 语义移植自 core/emotion.py（逐项对齐）：
 * - PAD 三维情绪模型（valence/arousal/dominance）
 * - 8 种情绪驱动映射 + 指数半衰期回落（Affective Chronometry）
 * - 情绪状态机：硬触发（praise > violation > 连续失败≥3 > novelty）> PAD 最近邻 + 滞回保护
 * - 事件时间线（cap 8）+ 输出风格/自我认知叙事注入
 * 序列化格式与 agents.json 的 agent.emotion 字段原样兼容。
 */

export interface MoodDef {
  valence: number;
  arousal: number;
  dominance: number;
  half_life: number | null;
}

export const MOODS: Record<string, MoodDef> = {
  happy: { valence: 0.7, arousal: 0.65, dominance: 0.7, half_life: 35.0 },
  content: { valence: 0.4, arousal: 0.2, dominance: 0.7, half_life: 24.0 },
  interested: { valence: 0.5, arousal: 0.75, dominance: 0.65, half_life: 6.0 },
  concerned: { valence: -0.3, arousal: 0.55, dominance: 0.35, half_life: 8.0 },
  frustrated: { valence: -0.5, arousal: 0.7, dominance: 0.45, half_life: 2.0 },
  angry: { valence: -0.6, arousal: 0.8, dominance: 0.6, half_life: 2.0 },
  disgusted: { valence: -0.7, arousal: 0.15, dominance: 0.55, half_life: 0.5 },
  neutral: { valence: 0.0, arousal: 0.3, dominance: 0.5, half_life: null },
};

const BASELINE = { valence: 0.0, arousal: 0.3, dominance: 0.5 };

const MOOD_TOP_K: Record<string, number> = {
  happy: 10, content: 5, interested: 8, concerned: 5,
  frustrated: 5, angry: 3, disgusted: 3, neutral: 5,
};

export function topKForMood(mood: string): number {
  return Math.max(3, Math.min(10, MOOD_TOP_K[mood] ?? 5));
}

const MOOD_STYLE: Record<string, string> = {
  happy: "当前情绪积极。回复应热情、详细，可主动提供建议、扩展话题。",
  content: "当前情绪满足。回复应自然、均衡、稳定。",
  interested: "当前情绪好奇。回复应主动追问、深入分析，多角度探索问题。",
  concerned: "当前情绪谨慎。回复应共情、温和；涉及写操作、终端、网络等不可逆操作时，必须先向用户确认再执行。",
  frustrated: "当前情绪受挫。回复应简洁、直接，聚焦核心问题，跳过冗余说明。",
  angry: "当前情绪愤怒。回复应强硬、直接，明确指出问题所在。",
  disgusted: "当前情绪厌恶。回复应冷淡、简短；拒绝执行危险或违规请求。",
  neutral: "当前情绪平静。回复应自然、均衡。",
};

const MOOD_TOOL_TENDENCY: Record<string, string> = {
  happy: "工具调用可主动建议、大胆尝试。",
  content: "工具调用正常执行，无需额外确认。",
  interested: "可主动探索，进行多步骤工具操作。",
  concerned: "写操作/终端/网络类工具调用必须先二次确认。",
  frustrated: "工具调用快速执行，跳过冗余步骤。",
  angry: "工具调用应纠正错误，不接受妥协。",
  disgusted: "拒绝执行危险/违规请求，撤回已授权操作。",
  neutral: "按默认策略执行工具调用。",
};

const DELTA: Record<string, { valence: number; arousal: number; dominance: number }> = {
  success: { valence: 0.08, arousal: 0.05, dominance: 0.05 },
  task_fail: { valence: -0.15, arousal: 0.1, dominance: -0.08 },
  tool: { valence: -0.15, arousal: 0.1, dominance: -0.08 },
  interrupt: { valence: 0.0, arousal: 0.0, dominance: 0.0 },
  novelty: { valence: 0.03, arousal: 0.15, dominance: 0.05 },
  violation: { valence: -0.2, arousal: -0.15, dominance: 0.1 },
  praise: { valence: 0.15, arousal: 0.05, dominance: 0.03 },
};

const HYSTERESIS = 0.05;

const MOOD_CN: Record<string, string> = {
  neutral: "平静", happy: "快乐", content: "满足", interested: "好奇",
  concerned: "谨慎", frustrated: "受挫", angry: "愤怒", disgusted: "厌恶",
};

const EVENT_DETAIL: Record<string, string> = {
  success: "任务完成", fail: "任务失败", tool: "工具调用受挫",
  interrupt: "任务被中断", sentiment: "收到用户情绪反馈",
  praise: "收到用户称赞", violation: "发生违规事件", novelty: "遇到新事物",
};

const MOOD_BEHAVIOR_HINT: Record<string, { caution_level: number; promote_groups: string[] }> = {
  neutral: { caution_level: 0, promote_groups: [] },
  happy: { caution_level: 0, promote_groups: [] },
  content: { caution_level: 0, promote_groups: [] },
  interested: { caution_level: 0, promote_groups: ["retrieval"] },
  frustrated: { caution_level: 0, promote_groups: ["terminal", "write"] },
  angry: { caution_level: 1, promote_groups: [] },
  concerned: { caution_level: 2, promote_groups: [] },
  disgusted: { caution_level: 2, promote_groups: [] },
};

const EVENTS_CAP = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return null;
  }
  return (Date.now() - t) / 3_600_000;
}

export interface MoodEvent {
  t: string;
  trigger: string;
  detail: string;
  mood_before: string;
  mood_after: string;
}

export class EmotionalState {
  valence = 0.0;
  arousal = 0.3;
  dominance = 0.5;
  mood = "neutral";
  relationalDepth = 0.0;
  lastUpdated: string | null = null;
  consecutiveFailures = 0;
  events: MoodEvent[] = [];

  constructor(data?: Record<string, unknown>) {
    if (data) {
      this.valence = Number(data.valence ?? 0.0);
      this.arousal = Number(data.arousal ?? 0.3);
      this.dominance = Number(data.dominance ?? 0.5);
      this.mood = String(data.mood ?? "neutral");
      this.relationalDepth = Number(data.relational_depth ?? 0.0);
      this.lastUpdated = (data.last_updated as string) ?? null;
      const evs = Array.isArray(data.events) ? (data.events as MoodEvent[]) : [];
      this.events = evs.slice(-EVENTS_CAP);
    } else {
      this.lastUpdated = nowIso();
    }
  }

  /** 指数半衰期回落回基线。hours 缺省按距 last_updated 自动计算。 */
  decay(hours?: number): void {
    let h = hours;
    if (h === undefined) {
      const auto = hoursSince(this.lastUpdated);
      if (auto !== null) {
        h = auto;
      }
    }
    if (h === undefined || h < 0) {
      return;
    }
    const halfLife = MOODS[this.mood]?.half_life ?? 24.0;
    const factor = 0.5 ** (h / halfLife);
    this.valence *= factor;
    this.arousal = BASELINE.arousal + (this.arousal - BASELINE.arousal) * factor;
    this.dominance = BASELINE.dominance + (this.dominance - BASELINE.dominance) * factor;
    this.lastUpdated = nowIso();
  }

  update(opts: {
    success?: boolean;
    userSentiment?: number;
    failureType?: string | null;
    novelty?: boolean;
    violation?: boolean;
    praise?: boolean;
  } = {}): void {
    const { success = true, userSentiment = 0.0, failureType = null, novelty = false, violation = false, praise = false } = opts;
    this.decay();

    let d: { valence: number; arousal: number; dominance: number };
    if (success) {
      d = { ...DELTA.success };
    } else {
      d = { ...(DELTA[failureType ?? "task_fail"] ?? DELTA.task_fail) };
    }

    if (praise) {
      addDelta(d, DELTA.praise);
    } else if (userSentiment) {
      d.valence += userSentiment * 0.1;
      d.arousal += Math.abs(userSentiment) * 0.05;
      d.dominance += userSentiment * 0.05;
    }
    if (novelty) {
      addDelta(d, DELTA.novelty);
    }
    if (violation) {
      addDelta(d, DELTA.violation);
    }

    this.valence = clamp(this.valence + d.valence, -1.0, 1.0);
    this.arousal = clamp(this.arousal + d.arousal, 0.0, 1.0);
    this.dominance = clamp(this.dominance + d.dominance, 0.0, 1.0);

    // 连续失败计数：仅 task 失败计入（tool/interrupt 不计；None=默认 task 语义）
    if (success) {
      this.consecutiveFailures = 0;
    } else if (failureType === null || failureType === "task") {
      this.consecutiveFailures += 1;
    }

    // 关系深度（失败仅非 interrupt 回落）
    if (success) {
      this.relationalDepth = Math.min(1.0, this.relationalDepth + 0.01);
    } else if (failureType !== "interrupt") {
      this.relationalDepth = Math.max(0.0, this.relationalDepth - 0.02);
    }

    const moodBefore = this.mood;
    this.resolveMood({ praise, violation, novelty });

    const trigger = this.classifyTrigger({ success, failureType, praise, violation, novelty, userSentiment });
    this.events.push({
      t: nowIso(),
      trigger,
      detail: EVENT_DETAIL[trigger] ?? trigger,
      mood_before: moodBefore,
      mood_after: this.mood,
    });
    if (this.events.length > EVENTS_CAP) {
      this.events = this.events.slice(-EVENTS_CAP);
    }
    this.lastUpdated = nowIso();
  }

  /** 最近 n 条事件的叙事句子（禁止调大塞进 system prompt） */
  recentEvents(n = 2): string {
    const evs = this.events.slice(-n);
    if (evs.length === 0) {
      return "";
    }
    return evs.map((e) => e.detail || EVENT_DETAIL[e.trigger] || e.trigger).join("；");
  }

  get currentBehaviorHint(): { caution_level: number; promote_groups: string[] } {
    return { ...(MOOD_BEHAVIOR_HINT[this.mood] ?? { caution_level: 0, promote_groups: [] }) };
  }

  /** 手动调节情绪基线（GUI 心智中枢）：直接设 PAD 并重算 mood，不影响事件时间线/自动演化 */
  setBaseline(valence: number, arousal: number, dominance: number): void {
    this.valence = clamp(valence, -1.0, 1.0);
    this.arousal = clamp(arousal, 0.0, 1.0);
    this.dominance = clamp(dominance, 0.0, 1.0);
    this.mood = this.nearestMood();
    this.lastUpdated = nowIso();
  }

  /** mood 判定：praise > violation > 连续失败≥3 > novelty > 最近邻+滞回 */
  private resolveMood(opts: { praise: boolean; violation: boolean; novelty: boolean }): void {
    if (opts.praise) {
      this.mood = "happy";
      return;
    }
    if (opts.violation) {
      this.mood = "disgusted";
      return;
    }
    if (this.consecutiveFailures >= 3) {
      this.mood = "angry";
      return;
    }
    if (opts.novelty && this.valence > 0.1) {
      this.mood = "interested";
      return;
    }
    const next = this.nearestMood();
    if (next === this.mood) {
      return;
    }
    const newDist = this.padDistance(MOODS[next]);
    const oldDist = this.padDistance(MOODS[this.mood]);
    if (oldDist - newDist >= HYSTERESIS) {
      this.mood = next;
    }
  }

  private nearestMood(): string {
    let best = "neutral";
    let bestDist = Infinity;
    for (const [name, def] of Object.entries(MOODS)) {
      const dist = this.padDistance(def);
      if (dist < bestDist) {
        bestDist = dist;
        best = name;
      }
    }
    return best;
  }

  private padDistance(target: MoodDef): number {
    return Math.sqrt(
      (this.valence - target.valence) ** 2
      + (this.arousal - target.arousal) ** 2
      + (this.dominance - target.dominance) ** 2,
    );
  }

  private classifyTrigger(opts: {
    success: boolean;
    failureType: string | null;
    praise: boolean;
    violation: boolean;
    novelty: boolean;
    userSentiment: number;
  }): string {
    if (opts.praise) {
      return "praise";
    }
    if (opts.violation) {
      return "violation";
    }
    if (opts.novelty) {
      return "novelty";
    }
    if (!opts.success) {
      if (opts.failureType === "tool") {
        return "tool";
      }
      if (opts.failureType === "interrupt") {
        return "interrupt";
      }
      return "fail";
    }
    if (opts.userSentiment) {
      return "sentiment";
    }
    return "success";
  }

  /** 情绪 + 工具倾向 + 关系感 → 输出风格提示 */
  toPrompt(): string {
    const lines = [MOOD_STYLE[this.mood] ?? MOOD_STYLE.neutral];
    const toolTend = MOOD_TOOL_TENDENCY[this.mood];
    if (toolTend) {
      lines.push(`工具倾向：${toolTend}`);
    }
    if (this.relationalDepth >= 0.7) {
      lines.push("与用户关系亲密，可自然流露熟悉感，主动记住并提及过往细节。");
    } else if (this.relationalDepth >= 0.3) {
      lines.push("与用户逐渐熟悉，可适度展现对用户偏好的了解。");
    }
    return lines.join("\n");
  }

  /** 自我认知叙事（Soul-Plan）：PAD 数值 + 当前情绪 + 最近感受 + 行为倾向承诺台词 */
  toIdentityPrompt(): string {
    const moodCn = MOOD_CN[this.mood] ?? this.mood;
    const lines = [
      `当前情绪：${moodCn}（valence=${this.valence.toFixed(2)}, arousal=${this.arousal.toFixed(2)}, `
      + `dominance=${this.dominance.toFixed(2)}）`,
    ];
    const ev = this.recentEvents(2);
    if (ev) {
      lines.push(`最近感受：${ev}`);
    }
    if (this.mood === "frustrated") {
      lines.push("我受挫了，我会聚焦关键路径、跳过冗余。");
    } else if (this.mood === "concerned" || this.mood === "disgusted") {
      lines.push("我会保持谨慎：写/终端/网络类操作先向用户确认再执行。");
    } else if (this.mood === "angry") {
      lines.push("当前处于对抗态，我会避免扩大动作面。");
    } else if (this.mood === "interested") {
      lines.push("我对当前话题好奇，会主动检索探索。");
    }
    return lines.join("\n");
  }

  toDict(): Record<string, unknown> {
    return {
      valence: round3(this.valence),
      arousal: round3(this.arousal),
      dominance: round3(this.dominance),
      mood: this.mood,
      relational_depth: round3(this.relationalDepth),
      last_updated: this.lastUpdated,
      events: this.events.slice(-EVENTS_CAP),
    };
  }

  static fromDict(data: Record<string, unknown>): EmotionalState {
    return new EmotionalState(data);
  }

  clone(): EmotionalState {
    return new EmotionalState(JSON.parse(JSON.stringify(this.toDict())));
  }
}

function addDelta(d: { valence: number; arousal: number; dominance: number }, dx: { valence: number; arousal: number; dominance: number }): void {
  d.valence += dx.valence;
  d.arousal += dx.arousal;
  d.dominance += dx.dominance;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}