/**
 * tests/core-ts/knowledge.spec.ts — KnowledgeEngine 语义测试。
 * 对照 tests/test_knowledge.py TestKnowledgeEngine 逐例移植。
 * 隔离：dataDir 指向临时目录，A-011 验证 rules/generated_skills 不污染项目 Knowledge/。
 */
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeEngine, getKnowledgeEngine, resetKnowledgeEngine,
  PROMOTE_THRESHOLDS, type PersonaLike,
} from "../../core-ts/src/memory/knowledge.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "know-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("recordPattern：复发与升级（对照 test_record_pattern_recurrence_and_escalation）", () => {
  it("第 3 次触发 → escalate（low → medium）", () => {
    const ke = new KnowledgeEngine("t1", { dataDir: makeTmp() });
    const r1 = ke.recordPattern("task.file-write.fail", "task", "写文件失败", "low");
    expect(r1.recurrence).toBe(1);
    expect(r1.action).toBeNull();
    ke.recordPattern("task.file-write.fail", "task", "写文件失败", "low");
    const r3 = ke.recordPattern("task.file-write.fail", "task", "写文件失败", "low");
    expect(r3.recurrence).toBe(3);
    expect(r3.action).toBe("escalate");
    expect(r3.new_priority).toBe("medium");
  });

  it("非法 key 拒绝（N10-M3 白名单，对照 test_invalid_key_rejected）", () => {
    const ke = new KnowledgeEngine("t3", { dataDir: makeTmp() });
    const r = ke.recordPattern("../etc/passwd", "task", "恶意 key");
    expect(r.action).toBeNull();
    expect(r.error).toBe("invalid_key");
    expect(ke.getStats().total_patterns).toBe(0);
  });

  it("非法 category 回退 task（对照 test_invalid_category_falls_back_to_task）", () => {
    const ke = new KnowledgeEngine("t4", { dataDir: makeTmp() });
    const r = ke.recordPattern("ok.key", "hacker", "说明");
    expect(r.recurrence).toBe(1);
    const stats = ke.getStats();
    expect(stats.total_patterns).toBe(1);
  });
});

describe("晋升管线阈值（对照 test_promote_pipeline_thresholds）", () => {
  it("5 次 → rule；8 次 → trait 信号；统计正确", () => {
    const ke = new KnowledgeEngine("t2", { dataDir: makeTmp() });
    let result: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      result = ke.recordPattern("task.code-review.success", "task", "代码成功", "medium");
    }
    expect(result.action).toBe("promote_to_trait");
    expect(result.trait_name).toBe("Code Review");
    const stats = ke.getStats();
    expect(stats.total_patterns).toBe(1);
    expect(stats.total_rules).toBe(1); // 第 5 次已晋升 rule
    const promotable = ke.getPromotableTraits();
    expect(promotable.length).toBe(1);
    expect(promotable[0].name).toBe("Code Review");
  });

  it("第 5 次返回 promote_to_rule（对照 test_rule_markdown_isolated_to_data_dir）", () => {
    const dir = makeTmp();
    const ke = new KnowledgeEngine("t6", { dataDir: dir });
    let result: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      result = ke.recordPattern("task.build.fail", "task", "构建失败");
    }
    expect(result.action).toBe("promote_to_rule");
    const ruleId = result.rule as string;
    expect(existsSync(join(dir, "rules", `${ruleId}.md`))).toBe(true);
  });
});

describe("持久化 roundtrip（对照 test_persistence_roundtrip）", () => {
  it("重新加载后 recurrence 保持", () => {
    const dir = makeTmp();
    const ke1 = new KnowledgeEngine("t5", { dataDir: dir });
    for (let i = 0; i < 3; i++) {
      ke1.recordPattern("task.retry.success", "task", "重试成功");
    }
    const ke2 = new KnowledgeEngine("t5", { dataDir: dir });
    expect(ke2.getStats().total_patterns).toBe(1);
  });
});

describe("generateSkill（对照 test_generate_skill_*）", () => {
  it("≥10 次 → manifest.json + SKILL.md 写入 data_dir/generated_skills（A-011 隔离）", () => {
    const dir = makeTmp();
    const ke = new KnowledgeEngine("t7", { dataDir: dir });
    for (let i = 0; i < 10; i++) {
      ke.recordPattern("task.foo.bar", "task", "高频成功模式");
    }
    const out = ke.generateSkill("task.foo.bar");
    expect(out).not.toBeNull();
    expect(existsSync(join(out!.dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(out!.dir, "SKILL.md"))).toBe(true);
    expect(out!.dir).toContain("generated_skills");
    expect(out!.dir).toContain(dir);
  });

  it("低于阈值 → null（对照 test_generate_skill_below_threshold_returns_none）", () => {
    const ke = new KnowledgeEngine("t8", { dataDir: makeTmp() });
    for (let i = 0; i < 3; i++) {
      ke.recordPattern("task.low.count", "task", "低频模式");
    }
    expect(ke.generateSkill("task.low.count")).toBeNull();
  });
});

describe("review（90 天归档 + persona trait 强化）", () => {
  it("90 天未出现的 pattern → resolved 归档", () => {
    const dir = makeTmp();
    const ke = new KnowledgeEngine("r1", { dataDir: dir });
    ke.recordPattern("task.old.stale", "task", "老模式");
    const p = (ke as unknown as { patterns: Map<string, { resolved: boolean; last_seen: string }> }).patterns.get("task.old.stale")!;
    p.last_seen = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const r = ke.review();
    expect(r.patterns_reviewed).toBe(1);
    expect(r.patterns_resolved).toBe(1);
    expect(p.resolved).toBe(true);
  });

  it("高频 pattern → persona trait 强化（PersonaLike）", () => {
    const dir = makeTmp();
    const ke = new KnowledgeEngine("r2", { dataDir: dir });
    for (let i = 0; i < 8; i++) {
      ke.recordPattern("task.code-review.success", "task", "代码成功");
    }
    let touched = 0;
    const persona: PersonaLike = {
      traits: [],
      _touch: () => { touched += 1; },
    };
    const r = ke.review(persona);
    expect(r.traits_reinforced).toBe(1);
    expect(persona.traits.length).toBe(1);
    expect(persona.traits[0].name).toBe("Code Review");
    expect(touched).toBeGreaterThan(0);
  });
});

describe("全局缓存（getKnowledgeEngine / resetKnowledgeEngine）", () => {
  it("按 agent_id+data_dir 键控，reset 后重建", () => {
    const dir = makeTmp();
    const e1 = getKnowledgeEngine("cache1", { dataDir: dir });
    const e2 = getKnowledgeEngine("cache1", { dataDir: dir });
    expect(e1).toBe(e2);
    resetKnowledgeEngine("cache1", dir);
    const e3 = getKnowledgeEngine("cache1", { dataDir: dir });
    expect(e3).not.toBe(e1);
  });

  it("阈值常量对齐方案（alert 3 / rule 5 / trait 8 / skill 10）", () => {
    expect(PROMOTE_THRESHOLDS.alert).toBe(3);
    expect(PROMOTE_THRESHOLDS.rule).toBe(5);
    expect(PROMOTE_THRESHOLDS.trait).toBe(8);
    expect(PROMOTE_THRESHOLDS.skill).toBe(10);
  });
});