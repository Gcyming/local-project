/**
 * core-ts/src/memory/knowledge.ts — 知识引擎（Pattern-Key 追踪 + 晋升管线 + 周期性审查）。
 * 语义移植自 core/knowledge.py（A-011 隔离、N10-M1/M3、PROMOTE_THRESHOLDS 全量对照）。
 *
 * 管线：事件触发 record_pattern → 达阈值 promote → Rule 积累 → generate_skill → Persona trait。
 * 持久化：Knowledge/{agent_id}/knowledge.json + rules/*.md + generated_skills/（Obsidian vault 语义）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

export const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const KNOWLEDGE_DIR = resolve(PROJECT_ROOT, "Knowledge", "Agent Memory");
export const DATA_DIR = resolve(PROJECT_ROOT, "data");

// 晋升阈值（对照 PROMOTE_THRESHOLDS）
export const PROMOTE_THRESHOLDS = {
  alert: 3, // 第 3 次出现 → 升级为高风险
  rule: 5, // 第 5 次出现 → 晋升为行为规则
  trait: 8, // 第 8 次出现 → 晋升为 persona 特征
  skill: 10, // 第 10 次成功 → 生成为可复用技能
} as const;

// 输入校验（N10-M3）
const VALID_CATEGORIES = new Set(["task", "security", "learning", "skill", "behavior", "preference"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const KEY_RE = /^[a-zA-Z0-9_.\-]+$/;
// A-112: agent_id 仅允许安全字符（防御路径遍历；空串放行 = global 语义）
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateAgentId(agentId: string): void {
  if (agentId && !AGENT_ID_RE.test(agentId)) {
    throw new Error(`[knowledge] 非法 agent_id: ${JSON.stringify(agentId)}`);
  }
}

export const PRIORITY_WEIGHTS = { critical: 100, high: 50, medium: 20, low: 5 } as const;

// ── 数据结构（对照 PatternEntry / KnowledgeRule） ─────────

export interface PatternEntry {
  key: string;
  category: string;
  priority: string;
  recurrence: number;
  first_seen: string;
  last_seen: string;
  description: string;
  related_rules: string[];
  resolved: boolean;
}

export interface KnowledgeRule {
  id: string;
  title: string;
  category: string;
  content: string;
  source_pattern: string;
  created_at: string;
  active: boolean;
}

export function patternFromDict(data: Record<string, unknown>): PatternEntry {
  return {
    key: String(data.key ?? ""),
    category: String(data.category ?? ""),
    priority: String(data.priority ?? "medium"),
    recurrence: Number(data.recurrence ?? 0),
    first_seen: String(data.first_seen ?? ""),
    last_seen: String(data.last_seen ?? ""),
    description: String(data.description ?? ""),
    related_rules: Array.isArray(data.related_rules) ? data.related_rules.map(String) : [],
    resolved: Boolean(data.resolved),
  };
}

export function ruleToMarkdown(rule: KnowledgeRule): string {
  return [
    "---",
    `id: ${rule.id}`,
    `category: ${rule.category}`,
    `source: ${rule.source_pattern}`,
    `created: ${rule.created_at}`,
    `active: ${rule.active}`,
    `tags: [${rule.category}, rule]`,
    "---",
    "",
    `# ${rule.title}`,
    "",
    `${rule.content}`,
    "",
  ].join("\n");
}

// ── 向量化接入（对照 _vectorize / vectorize_knowledge） ────

export interface VectorizeHook {
  (role: string, content: string, tags?: string): Promise<boolean>;
}

// ── Persona 联动（对照 agent_persona.traits + _touch） ────

export interface PersonaLike {
  traits: Array<{ name: string; weight: number; [k: string]: unknown }>;
  _touch?: () => void;
}

// ── KnowledgeEngine ──────────────────────────────────────

export interface KnowledgeEngineOptions {
  dataDir?: string;
  projectRoot?: string;
  vectorize?: VectorizeHook | null;
}

export class KnowledgeEngine {
  readonly agentId: string;
  private patterns: Map<string, PatternEntry> = new Map();
  private rules: KnowledgeRule[] = [];
  private baseDir: string;
  private jsonPath: string;
  private vectorize: VectorizeHook | null;
  private projectRoot: string;

  constructor(agentId = "", opts: KnowledgeEngineOptions = {}) {
    validateAgentId(agentId);
    this.agentId = agentId;
    this.projectRoot = opts.projectRoot ?? PROJECT_ROOT;
    const base = opts.dataDir ? resolve(this.projectRoot, opts.dataDir) : KNOWLEDGE_DIR;
    // A-011: 所有输出（knowledge.json / rules/ / generated_skills/）都锚定 base 目录
    this.baseDir = base;
    this.jsonPath = resolve(base, agentId || "global", "knowledge.json");
    this.vectorize = opts.vectorize ?? null;
    this.load();
  }

  // ── 持久化 ─────────────────────────────────────────────

  private load(): void {
    // 迁移：旧 data/ 位置有数据但新位置没有 → 移动
    const oldPath = resolve(DATA_DIR, this.agentId || "global", "knowledge.json");
    if (existsSync(oldPath) && !existsSync(this.jsonPath)) {
      try {
        mkdirSync(dirname(this.jsonPath), { recursive: true });
        const raw = readFileSync(oldPath, "utf8");
        writeFileSync(this.jsonPath, raw, "utf8");
        renameSync(oldPath, this.jsonPath);
        console.log(`[knowledge] 已从 ${oldPath} 迁移到 ${this.jsonPath}`);
      } catch (e) {
        console.warn(`[knowledge] 迁移失败: ${e}`);
      }
    }
    if (existsSync(this.jsonPath)) {
      try {
        const data = JSON.parse(readFileSync(this.jsonPath, "utf8")) as { patterns?: Record<string, unknown>; rules?: unknown[] };
        this.patterns = new Map(Object.entries(data.patterns ?? {}).map(([k, v]) => [k, patternFromDict(v as Record<string, unknown>)]));
        this.rules = (data.rules ?? [])
          .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
          .map((r) => ({
            id: String(r.id ?? ""),
            title: String(r.title ?? ""),
            category: String(r.category ?? ""),
            content: String(r.content ?? ""),
            source_pattern: String(r.source_pattern ?? ""),
            created_at: String(r.created_at ?? ""),
            active: r.active === undefined ? true : Boolean(r.active),
          }));
      } catch (e) {
        console.warn(`[knowledge] 加载失败: ${e}`);
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.jsonPath), { recursive: true });
    const data = {
      patterns: Object.fromEntries([...this.patterns.entries()].map(([k, v]) => [k, v])),
      rules: this.rules,
    };
    const raw = JSON.stringify(data, null, 2);
    const tmp = `${this.jsonPath}.${randomUUID().replace(/-/g, "").slice(0, 8)}.tmp`;
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, this.jsonPath);
  }

  // ── Pattern 追踪 ───────────────────────────────────────

  /**
   * 记录一个 Pattern 出现。返回 {action, ...} 指示触发晋升则 action 不为空。
   * N10-M3: key/category/priority 白名单校验，非法输入降级为 safe defaults。
   */
  recordPattern(key: string, category = "task", description = "", priority = "medium"): Record<string, unknown> {
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      console.warn(`[knowledge] 非法 pattern key: ${JSON.stringify(key)}`);
      return { action: null, error: "invalid_key" };
    }
    if (!VALID_CATEGORIES.has(category)) category = "task";
    if (!VALID_PRIORITIES.has(priority)) priority = "medium";
    const now = new Date().toISOString();
    let p: PatternEntry;
    if (this.patterns.has(key)) {
      p = this.patterns.get(key)!;
      p.recurrence += 1;
      p.last_seen = now;
      if (description && !p.description) p.description = description;
    } else {
      p = { key, category, priority, recurrence: 1, first_seen: now, last_seen: now, description, related_rules: [], resolved: false };
      this.patterns.set(key, p);
    }

    const result: Record<string, unknown> = { action: null, key, recurrence: p.recurrence };

    // 检查晋升阈值
    if (p.recurrence >= PROMOTE_THRESHOLDS.alert && p.priority !== "critical") {
      const escalate: Record<string, string> = { low: "medium", medium: "high", high: "critical" };
      p.priority = escalate[p.priority] ?? "high";
      result.action = "escalate";
      result.new_priority = p.priority;
      console.log(`[knowledge] Pattern 升级: ${key} → ${p.priority} (×${p.recurrence})`);
    }

    if (p.recurrence >= PROMOTE_THRESHOLDS.rule && !p.related_rules.length) {
      const rule = this.promoteToRule(p);
      if (rule) {
        p.related_rules.push(rule.id);
        result.action = "promote_to_rule";
        result.rule = rule.id;
      }
    }

    if (p.recurrence >= PROMOTE_THRESHOLDS.trait) {
      result.action = "promote_to_trait";
      result.trait_name = this.keyToTraitName(key);
    }

    if (p.recurrence >= PROMOTE_THRESHOLDS.skill && (category === "task" || category === "learning")) {
      result.action = "promote_to_skill";
      result.skill_name = this.keyToSkillName(key);
    }

    this.save();
    return result;
  }

  /** 从 Pattern-Key 提取 trait 名。例: task.code-review.success → 代码审查（对照 _key_to_trait_name） */
  private keyToTraitName(key: string): string {
    const parts = key.split(".");
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!["success", "fail", "task", "security", "learning"].includes(part)) {
        return part.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }
    return parts.length ? parts[parts.length - 1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : key;
  }

  /** 从 Pattern-Key 提取技能名（对照 _key_to_skill_name） */
  private keyToSkillName(key: string): string {
    const parts = key.split(".");
    return parts.slice(1, 3).filter((p) => !["success", "fail"].includes(p)).map((p) => p.replace(/-/g, "_")).join("_");
  }

  // ── 晋升管线 ───────────────────────────────────────────

  /** 将高频 Pattern 晋升为持久行为规则，写入 Knowledge/ 目录 */
  promoteToRule(pattern: PatternEntry): KnowledgeRule | null {
    const now = new Date().toISOString();
    const ruleId = `rule_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

    const templates: Record<string, string> = {
      security: [
        "## 安全规则",
        `模式 \`${pattern.key}\` 触发了 ${pattern.recurrence} 次。`,
        `**规则**: ${pattern.description || "检测到重复的危险操作模式"}。`,
        `**建议**: 自动收紧该操作的权限要求，要求显式用户确认。`,
      ].join("\n"),
      task: [
        "## 任务规则",
        `模式 \`${pattern.key}\` 重复出现 ${pattern.recurrence} 次。`,
        `**规则**: ${pattern.description || "该任务类型需要特殊处理"}。`,
        `**建议**: 委托给专门的子 Agent 或在执行前进行预检查。`,
      ].join("\n"),
      learning: [
        "## 学习规则",
        `从 ${pattern.recurrence} 次经验中总结。`,
        `**规则**: ${pattern.description || "重复遇到的经验教训"}。`,
        `**建议**: 将此规则注入 Agent system prompt 以预防复发。`,
      ].join("\n"),
    };

    const rule: KnowledgeRule = {
      id: ruleId,
      title: `${pattern.category.charAt(0).toUpperCase() + pattern.category.slice(1)} Rule: ${pattern.key}`,
      category: pattern.category,
      content: templates[pattern.category] ?? templates.learning,
      source_pattern: pattern.key,
      created_at: now,
      active: true,
    };
    this.rules.push(rule);
    this.save();

    // 写入 Knowledge 目录（Obsidian markdown）
    this.writeRuleMarkdown(rule);

    // 向量化：存入 LanceDB 供语义召回（失败不影响晋升主流程）
    if (this.vectorize) {
      void this.vectorize(`rule:${rule.category}`, `${rule.title}\n${rule.content}`, "").catch(() => {});
    }

    console.log(`[knowledge] 新规则已晋升: ${rule.title}`);
    return rule;
  }

  /** 将规则写入 rules/ 目录（A-011: 锚定实例 base 目录，尊重 data_dir 隔离） */
  private writeRuleMarkdown(rule: KnowledgeRule): void {
    const targetDir = join(this.baseDir, "rules");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, `${rule.id}.md`), ruleToMarkdown(rule), "utf8");
  }

  /** 从成功的 Pattern 生成可复用技能模板，写入 generated_skills/（A-011 隔离） */
  generateSkill(patternKey: string): { name: string; dir: string } | null {
    const pattern = this.patterns.get(patternKey);
    if (!pattern || pattern.recurrence < PROMOTE_THRESHOLDS.skill) return null;

    const skillName = this.keyToSkillName(patternKey);
    const skillDir = join(this.baseDir, "generated_skills", skillName);
    mkdirSync(skillDir, { recursive: true });

    const manifest = {
      name: skillName,
      version: "1.0",
      description: `自动生成: ${pattern.description || pattern.key} (×${pattern.recurrence})`,
      author: "slime-knowledge-engine",
      tags: [pattern.category, "auto-generated"],
      permissions: { read: true, write: false },
      trigger_patterns: [pattern.key],
    };
    writeFileSync(join(skillDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const skillMd = [
      `# ${skillName}`,
      "",
      "## 功能",
      `从 ${pattern.recurrence} 次成功经验中自动生成的技能。`,
      "",
      "## 触发模式",
      `\`${pattern.key}\``,
      "",
      "## 经验来源",
      `${pattern.description}`,
      "",
      "## 使用方式",
      "当检测到相似任务时，该技能会被自动推荐。",
      "人工审查后可将 skill_dir 移动到 config/skills/ 以正式激活。",
      "",
    ].join("\n");
    writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf8");

    console.log(`[knowledge] 技能模板已生成: ${skillName} → ${skillDir}`);
    return { name: skillName, dir: skillDir };
  }

  // ── 审查与整理 ─────────────────────────────────────────

  /**
   * 周期性审查：整理过时记忆、强化高频 trait、清理已解决的 pattern。
   * 返回审查摘要（对照 KnowledgeEngine.review）。
   */
  review(agentPersona?: PersonaLike | null): {
    patterns_reviewed: number;
    patterns_resolved: number;
    rules_updated: number;
    traits_reinforced: number;
    memories_decayed: number;
    summary: string[];
  } {
    const now = new Date();
    const result = { patterns_reviewed: 0, patterns_resolved: 0, rules_updated: 0, traits_reinforced: 0, memories_decayed: 0, summary: [] as string[] };

    // 1. 检查 pattern — 超过 90 天未出现的标记为 resolved
    for (const [key, p] of [...this.patterns.entries()]) {
      result.patterns_reviewed += 1;
      let age = 0;
      if (p.last_seen) {
        const ts = Date.parse(p.last_seen);
        if (!Number.isNaN(ts)) age = Math.floor((now.getTime() - ts) / 86_400_000);
      }
      if (age > 90) {
        p.resolved = true;
        result.patterns_resolved += 1;
        result.summary.push(`归档旧 Pattern: ${key}（${age} 天未出现）`);
      }
    }

    // 2. 高 recurrence 的 pattern → 强化对应 trait
    if (agentPersona) {
      for (const [key, p] of this.patterns.entries()) {
        if (p.recurrence >= PROMOTE_THRESHOLDS.trait && !p.resolved) {
          const traitName = this.keyToTraitName(key);
          let found = false;
          for (const t of agentPersona.traits) {
            if (String(t.name ?? "").toLowerCase() === traitName.toLowerCase()) {
              t.weight = Math.min(1.0, (t.weight ?? 0.5) + 0.1);
              found = true;
              break;
            }
          }
          if (!found) {
            agentPersona.traits.push({ name: traitName, weight: 0.45, last_used: now.toISOString(), source: `knowledge-pattern:${key}` });
          }
          result.traits_reinforced += 1;
          result.summary.push(`强化 trait: ${traitName}（来自 pattern ${key} ×${p.recurrence}）`);
          agentPersona._touch?.();
        }
      }
    }

    // 3. 写审查日志到 Knowledge 目录
    const reviewMd = [
      `# Review ${now.toISOString().slice(0, 16).replace("T", " ")}`,
      "",
      ...result.summary.map((s) => `- ${s}`),
      "",
      `> 自动生成，${result.patterns_reviewed} 个 pattern 已审查。`,
      "",
    ].join("\n");
    const reviewDir = join(KNOWLEDGE_DIR, "reviews");
    mkdirSync(reviewDir, { recursive: true });
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === "T" ? "_" : ""));
    writeFileSync(join(reviewDir, `review_${stamp}.md`), reviewMd, "utf8");

    // 向量化审查摘要（供语义召回）
    if (this.vectorize) {
      void this.vectorize("review", reviewMd.slice(0, 500), "").catch(() => {});
    }

    this.save();
    return result;
  }

  /** 返回所有达到 trait 晋升阈值的 pattern 对应的 trait 信号 */
  getPromotableTraits(): Array<{ name: string; signal: number; source: string; recurrence: number }> {
    const signals: Array<{ name: string; signal: number; source: string; recurrence: number }> = [];
    for (const [key, p] of this.patterns.entries()) {
      if (p.recurrence >= PROMOTE_THRESHOLDS.trait && !p.resolved) {
        signals.push({ name: this.keyToTraitName(key), signal: 1, source: key, recurrence: p.recurrence });
      }
    }
    return signals;
  }

  /** 获取所有高优先级未解决的 pattern */
  getHighPriorityPatterns(): PatternEntry[] {
    return [...this.patterns.values()].filter((p) => (p.priority === "high" || p.priority === "critical") && !p.resolved);
  }

  getStats(): { total_patterns: number; high_priority: number; total_rules: number; pending_review: number } {
    return {
      total_patterns: this.patterns.size,
      high_priority: this.getHighPriorityPatterns().length,
      total_rules: this.rules.length,
      pending_review: [...this.patterns.values()].filter((p) => p.recurrence >= PROMOTE_THRESHOLDS.rule && !p.resolved).length,
    };
  }
}

// ── 全局缓存（按 agent_id+data_dir 键控，非单例） ───────

const knowledgeCache = new Map<string, KnowledgeEngine>();

function cacheKey(agentId: string, dataDir: string): string {
  return `${agentId}::${dataDir}`;
}

export function getKnowledgeEngine(agentId = "", opts: KnowledgeEngineOptions = {}): KnowledgeEngine {
  const key = cacheKey(agentId, opts.dataDir ?? "");
  if (!knowledgeCache.has(key)) {
    knowledgeCache.set(key, new KnowledgeEngine(agentId, opts));
  }
  return knowledgeCache.get(key)!;
}

export function resetKnowledgeEngine(agentId = "", dataDir = ""): void {
  knowledgeCache.delete(cacheKey(agentId, dataDir));
}