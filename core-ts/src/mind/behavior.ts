/**
 * core-ts/src/mind/behavior.ts — 行为模式（L2 半固定层）+ 沉淀引擎。
 * 语义移植自 core/behavior.py + core/consolidation.py（逐项对齐）：
 * - BehaviorPattern：场景 → 步骤（习惯/做事方式，含 decision_rationale）
 * - BehaviorStore：沉淀（L3→L2）+ 艾宾浩斯衰减 + 归档（降级到记忆层非删除）+ 再巩固
 * - ConsolidationEngine：每 N 次交互触发沉淀（高频 pattern 强化 + 长期未用弱化/归档）
 * - shadow 预留：分裂/继承时 BehaviorStore.clone() 即行为模式 shadow（夺舍核心：行为属于 Agent，
 *   不随模型切换而丢失；阶段 4.5 Swarm 分裂消费）
 * 序列化格式与 agents.json 的 agent.behavior 字段原样兼容。
 */

import { randomUUID } from "node:crypto";

export const BEHAVIOR_DECAY_DAYS = 30;

export class BehaviorPattern {
  id: string;
  scenario: string;
  steps: string[];
  confidence: number;
  usageCount: number;
  lastReinforced: string;
  source: string;
  decisionRationale: string;

  constructor(opts: {
    patternId: string;
    scenario: string;
    steps: string[];
    confidence?: number;
    usageCount?: number;
    lastReinforced?: string;
    source?: string;
    decisionRationale?: string;
  }) {
    this.id = opts.patternId;
    this.scenario = opts.scenario;
    this.steps = Array.isArray(opts.steps) ? opts.steps : [];
    this.confidence = opts.confidence ?? 0.3;
    this.usageCount = opts.usageCount ?? 0;
    this.lastReinforced = opts.lastReinforced ?? "";
    this.source = opts.source ?? "";
    this.decisionRationale = opts.decisionRationale ?? "";
  }

  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      scenario: this.scenario,
      steps: this.steps,
      confidence: round3(this.confidence),
      usage_count: this.usageCount,
      last_reinforced: this.lastReinforced,
      source: this.source,
      decision_rationale: this.decisionRationale,
    };
  }

  static fromDict(data: Record<string, unknown>): BehaviorPattern {
    return new BehaviorPattern({
      patternId: String(data.id ?? ""),
      scenario: String(data.scenario ?? ""),
      steps: Array.isArray(data.steps) ? data.steps.map(String) : [],
      confidence: Number(data.confidence ?? 0.3),
      usageCount: Number(data.usage_count ?? 0),
      lastReinforced: String(data.last_reinforced ?? ""),
      source: String(data.source ?? ""),
      decisionRationale: String(data.decision_rationale ?? ""),
    });
  }
}

export class BehaviorStore {
  patterns: BehaviorPattern[] = [];

  constructor(patterns: BehaviorPattern[] = []) {
    this.patterns = [...patterns];
  }

  /** 强化已有模式或新建模式（初始 confidence 0.3，需多次重复才稳定） */
  reinforce(opts: { scenario: string; steps: string[]; source?: string; rationale?: string }): BehaviorPattern {
    const now = nowIso();
    for (const p of this.patterns) {
      if (p.scenario === opts.scenario) {
        p.usageCount += 1;
        p.confidence = Math.min(1.0, p.confidence + 0.05);
        p.lastReinforced = now;
        if (opts.steps.length > 0) {
          p.steps = opts.steps;
        }
        if (opts.rationale) {
          p.decisionRationale = opts.rationale;
        }
        return p;
      }
    }
    const pattern = new BehaviorPattern({
      patternId: `pat_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      scenario: opts.scenario,
      steps: opts.steps,
      confidence: 0.3,
      usageCount: 1,
      lastReinforced: now,
      source: opts.source ?? "",
      decisionRationale: opts.rationale ?? "",
    });
    this.patterns.push(pattern);
    return pattern;
  }

  /** 艾宾浩斯衰减：长期未强化 confidence 下降；confidence < 0.15 → 标记待归档 */
  decay(days = BEHAVIOR_DECAY_DAYS): { weakened: number; archived: BehaviorPattern[] } {
    const now = Date.now();
    let weakened = 0;
    const archived: BehaviorPattern[] = [];
    for (const p of this.patterns) {
      if (!p.lastReinforced) {
        continue;
      }
      const t = Date.parse(p.lastReinforced);
      if (Number.isNaN(t)) {
        continue;
      }
      const ageDays = (now - t) / 86_400_000;
      if (ageDays > days) {
        p.confidence = Math.max(0.1, p.confidence - 0.1);
        weakened += 1;
      }
      if (p.confidence < 0.15) {
        archived.push(p);
      }
    }
    return { weakened, archived };
  }

  /** 从活跃层移除（降级到记忆层，非删除） */
  archive(pattern: BehaviorPattern): void {
    const idx = this.patterns.indexOf(pattern);
    if (idx >= 0) {
      this.patterns.splice(idx, 1);
    }
  }

  /** 归档条目再巩固回活跃层：起点 max(0.3, 原confidence × 0.5)；scenario 已存在则强化而非新建 */
  reconsolidate(opts: { scenario: string; steps: string[]; archivedConfidence?: number; source?: string; rationale?: string }): BehaviorPattern {
    const now = nowIso();
    for (const p of this.patterns) {
      if (p.scenario === opts.scenario) {
        p.usageCount += 1;
        p.confidence = Math.min(1.0, p.confidence + 0.05);
        p.lastReinforced = now;
        if (opts.steps.length > 0) {
          p.steps = opts.steps;
        }
        return p;
      }
    }
    const pattern = new BehaviorPattern({
      patternId: `pat_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      scenario: opts.scenario,
      steps: opts.steps,
      confidence: Math.max(0.3, (opts.archivedConfidence ?? 0.0) * 0.5),
      usageCount: 1,
      lastReinforced: now,
      source: opts.source ?? "reconsolidated",
      decisionRationale: opts.rationale ?? "",
    });
    this.patterns.push(pattern);
    return pattern;
  }

  /** 生成 L2 行为模式提示（只注入高置信度稳定习惯） */
  toPrompt(maxPatterns = 5): string {
    const stable = this.patterns.filter((p) => p.confidence >= 0.5 && p.steps.length > 0);
    if (stable.length === 0) {
      return "";
    }
    const top = [...stable].sort((a, b) => b.confidence - a.confidence).slice(0, maxPatterns);
    const lines = ["## 行为模式（已养成的做事习惯）"];
    for (const p of top) {
      let line = `- ${p.scenario}：${p.steps.join(" → ")}`;
      if (p.decisionRationale) {
        line += `（缘由：${p.decisionRationale}）`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  getHighConfidence(threshold = 0.5): BehaviorPattern[] {
    return this.patterns.filter((p) => p.confidence >= threshold);
  }

  toDict(): Record<string, unknown> {
    return { patterns: this.patterns.map((p) => p.toDict()) };
  }

  static fromDict(data: unknown): BehaviorStore {
    const raw = (data as Record<string, unknown>)?.patterns;
    const patterns = Array.isArray(raw)
      ? raw.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null).map(BehaviorPattern.fromDict)
      : [];
    return new BehaviorStore(patterns);
  }

  clone(): BehaviorStore {
    return new BehaviorStore(this.patterns.map((p) => BehaviorPattern.fromDict(p.toDict())));
  }
}

/** 沉淀引擎：L3 高频模式 → L2 行为习惯（量变到质变） */
export class ConsolidationEngine {
  static CONSOLIDATE_INTERVAL = 50;
  static DECAY_DAYS = 30;

  shouldConsolidate(totalInteractions: number): boolean {
    return totalInteractions > 0 && totalInteractions % ConsolidationEngine.CONSOLIDATE_INTERVAL === 0;
  }

  /**
   * 沉淀过程：
   * 1. 知识引擎高频 pattern → 行为模式（跳过已存在 scenario）
   * 2. 弱化长期未用的模式（艾宾浩斯）；归档条目交给 archiveSink（调用方写入记忆层）
   * 返回 (reinforced, decayed)。
   */
  consolidate(opts: {
    behavior: BehaviorStore;
    totalInteractions: number;
    knowledgeTraits?: Array<{ name: string; source: string }>;
    existingScenarios?: Set<string>;
    onArchived?: (pattern: BehaviorPattern) => void;
  }): { reinforced: number; decayed: number } {
    let reinforced = 0;
    const existing = opts.existingScenarios ?? new Set<string>();
    if (opts.knowledgeTraits) {
      for (const t of opts.knowledgeTraits.slice(0, 3)) {
        if (!existing.has(t.name)) {
          opts.behavior.reinforce({
            scenario: t.name,
            steps: ["检测模式", "应用规则", "验证结果"],
            source: `knowledge-engine:${t.source}`,
          });
          reinforced += 1;
        }
      }
    }
    const { weakened, archived } = opts.behavior.decay(ConsolidationEngine.DECAY_DAYS);
    if (opts.onArchived) {
      for (const pat of archived) {
        opts.onArchived(pat);
        opts.behavior.archive(pat);
      }
    }
    return { reinforced, decayed: weakened };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}