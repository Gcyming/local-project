/**
 * tests/core-ts/mind.spec.ts — 心智模块（情绪 + 行为）语义对照测试。
 * 对照 Python 侧 core/emotion.py + core/behavior.py 语义逐项移植验证。
 */
import { describe, expect, it } from "vitest";
import { EmotionalState, topKForMood } from "../../core-ts/src/mind/emotion.js";
import { BehaviorStore, BehaviorPattern, ConsolidationEngine } from "../../core-ts/src/mind/behavior.js";
import { buildMindSegments, mindHooks } from "../../core-ts/src/mind/hooks.js";

describe("EmotionalState（PAD + 8 mood + 半衰期）", () => {
  it("初始状态：neutral + PAD 基线", () => {
    const e = new EmotionalState();
    expect(e.mood).toBe("neutral");
    expect(e.valence).toBe(0.0);
    expect(e.arousal).toBe(0.3);
    expect(e.dominance).toBe(0.5);
  });

  it("success 更新：PAD 正向 + 事件时间线记录；连续多次后 mood 移向 happy", () => {
    const e = new EmotionalState();
    e.update({ success: true });
    expect(e.valence).toBeGreaterThan(0);
    expect(e.relationalDepth).toBeCloseTo(0.01, 5);
    expect(e.events.length).toBe(1);
    expect(e.events[0].trigger).toBe("success");
    expect(e.events[0].detail).toBe("任务完成");
    // 单次 success 不满足滞回收益（Python 语义一致：保持 neutral）
    expect(e.mood).toBe("neutral");
    for (let i = 0; i < 7; i++) {
      e.update({ success: true });
    }
    expect(e.mood).toBe("happy"); // 8 次后滞回收益 0.076 ≥ 0.05 → happy
  });

  it("连续 3 次任务失败 → angry 硬触发（≥3 跳闸）", () => {
    const e = new EmotionalState();
    e.update({ success: false, failureType: "task" });
    e.update({ success: false, failureType: "task" });
    expect(e.mood).not.toBe("angry");
    e.update({ success: false, failureType: "task" });
    expect(e.mood).toBe("angry");
    expect(e.consecutiveFailures).toBe(3);
    expect(e.events.at(-1)?.detail).toBe("任务失败");
  });

  it("tool 失败不计连续失败（渐进降温，不跳闸）", () => {
    const e = new EmotionalState();
    for (let i = 0; i < 5; i++) {
      e.update({ success: false, failureType: "tool" });
    }
    expect(e.consecutiveFailures).toBe(0);
    expect(e.mood).not.toBe("angry");
    expect(e.events.at(-1)?.trigger).toBe("tool");
  });

  it("interrupt 三零语义：PAD 全零、失败不计数、关系深度不回落", () => {
    const e = new EmotionalState();
    e.update({ success: true }); // 建立关系深度
    const depthBefore = e.relationalDepth;
    e.update({ success: false, failureType: "interrupt" });
    expect(e.relationalDepth).toBeCloseTo(depthBefore, 5);
    expect(e.consecutiveFailures).toBe(0);
    expect(e.events.at(-1)?.trigger).toBe("interrupt");
  });

  it("praise 硬触发 happy（覆盖最近邻）", () => {
    const e = new EmotionalState();
    e.update({ success: false, failureType: "task" });
    e.update({ success: false, failureType: "task" });
    e.update({ success: false, failureType: "task" });
    expect(e.mood).toBe("angry");
    e.update({ success: true, praise: true });
    expect(e.mood).toBe("happy");
    expect(e.events.at(-1)?.trigger).toBe("praise");
  });

  it("violation 硬触发 disgusted", () => {
    const e = new EmotionalState();
    e.update({ violation: true });
    expect(e.mood).toBe("disgusted");
    expect(e.events.at(-1)?.trigger).toBe("violation");
  });

  it("novelty + 高 valence → interested", () => {
    const e = new EmotionalState();
    e.update({ success: true });
    e.update({ success: true });
    e.update({ success: true, novelty: true });
    expect(e.mood).toBe("interested");
  });

  it("指数半衰期衰减：离基线越远回落越多；half_life 因 mood 而异", () => {
    const e = new EmotionalState();
    e.update({ success: true, praise: true }); // 大幅正向
    const v0 = e.valence;
    e.decay(35); // happy 半衰期
    expect(e.valence).toBeGreaterThan(0);
    expect(e.valence).toBeLessThan(v0);
    expect(e.arousal).toBeGreaterThanOrEqual(0.3); // 向基线 0.3 回落不越过
  });

  it("events cap 8（Soul-Plan 时间线容量）", () => {
    const e = new EmotionalState();
    for (let i = 0; i < 12; i++) {
      e.update({ success: true });
    }
    expect(e.events.length).toBe(8);
  });

  it("滞回保护：邻近 mood 切换收益不足保持原状态", () => {
    const e = new EmotionalState();
    e.update({ success: true, praise: true }); // happy
    const moodAfter = e.mood;
    // 轻微正向不满足 0.05 切换收益 → 保持
    e.decay(0.001);
    expect(e.mood).toBe(moodAfter);
  });

  it("recent_events 叙事句子（cap 2）；n=0 返回全部（Python [-0:] 同款切片语义）", () => {
    const e = new EmotionalState();
    e.update({ success: true });
    e.update({ success: false, failureType: "tool" });
    expect(e.recentEvents(2)).toBe("任务完成；工具调用受挫");
    expect(e.recentEvents(0)).toBe("任务完成；工具调用受挫");
    expect(e.recentEvents(1)).toBe("工具调用受挫");
  });

  it("to_prompt / to_identity_prompt 含情绪叙事与承诺台词", () => {
    const e = new EmotionalState();
    e.update({ success: false, failureType: "task" });
    e.update({ success: false, failureType: "task" });
    e.update({ success: false, failureType: "task" }); // angry
    const identity = e.toIdentityPrompt();
    expect(identity).toContain("当前情绪：愤怒");
    expect(identity).toContain("对抗态");
    const style = e.toPrompt();
    expect(style).toContain("强硬、直接");
  });

  it("current_behavior_hint：concerned → caution_level 2", () => {
    const e = new EmotionalState();
    // 构造 concerned：负 valence 中 arousal
    e.update({ success: false, failureType: "task" });
    expect(e.currentBehaviorHint).toMatchObject({ caution_level: 0 });
    const c = new EmotionalState({ valence: -0.3, arousal: 0.55, dominance: 0.35, mood: "concerned" });
    expect(c.currentBehaviorHint.caution_level).toBe(2);
  });

  it("序列化往返（agents.json 字段格式）+ clone 深拷贝", () => {
    const e = new EmotionalState();
    for (let i = 0; i < 8; i++) {
      e.update({ success: true }); // happy
    }
    const d = e.toDict();
    expect(d).toHaveProperty("valence");
    expect(d).toHaveProperty("mood");
    expect(d).toHaveProperty("relational_depth");
    expect(d).toHaveProperty("last_updated");
    expect(d).toHaveProperty("events");
    const e2 = EmotionalState.fromDict(d);
    expect(e2.mood).toBe(e.mood);
    expect(e2.valence).toBe(e.valence);
    const c = e.clone();
    c.update({ success: false, failureType: "task" });
    expect(c.mood).not.toBe(e.mood); // 克隆独立
  });

  it("top_k_for_mood 夹紧 [3,10]（防负面情绪负反馈循环）", () => {
    expect(topKForMood("happy")).toBe(10);
    expect(topKForMood("angry")).toBe(3);
    expect(topKForMood("unknown")).toBe(5);
  });
});

describe("BehaviorStore（L2 行为模式）", () => {
  it("reinforce 新建（confidence 0.3）+ 重复强化（+0.05 封顶 1.0）", () => {
    const s = new BehaviorStore();
    const p = s.reinforce({ scenario: "写日报", steps: ["收集", "起草", "提交"] });
    expect(p.confidence).toBe(0.3);
    expect(p.usageCount).toBe(1);
    expect(p.id.startsWith("pat_")).toBe(true);
    s.reinforce({ scenario: "写日报", steps: ["收集", "起草", "提交"] });
    expect(p.confidence).toBeCloseTo(0.35, 5);
    expect(p.usageCount).toBe(2);
  });

  it("decay：长期未用弱化 + confidence < 0.15 归档", () => {
    const s = new BehaviorStore();
    const old = new BehaviorPattern({
      patternId: "pat_old", scenario: "旧习惯", steps: ["a"],
      confidence: 0.2, lastReinforced: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    });
    s.patterns.push(old);
    const { weakened, archived } = s.decay(30);
    expect(weakened).toBe(1);
    expect(old.confidence).toBeCloseTo(0.1, 5); // 0.2-0.1，下限 0.1
    expect(archived).toContain(old); // 0.1 < 0.15
  });

  it("archive 从活跃层移除（非删除——调用方负责写入记忆）", () => {
    const s = new BehaviorStore();
    const p = s.reinforce({ scenario: "s", steps: ["x"] });
    s.archive(p);
    expect(s.patterns).not.toContain(p);
  });

  it("reconsolidate 再巩固：起点 max(0.3, 原confidence×0.5)；重复调用强化而非新建", () => {
    const s = new BehaviorStore();
    const p = s.reconsolidate({ scenario: "回归习惯", steps: ["a"], archivedConfidence: 0.7 });
    expect(p.confidence).toBeCloseTo(0.35, 5); // 0.7×0.5
    const n1 = s.patterns.length;
    s.reconsolidate({ scenario: "回归习惯", steps: ["a", "b"], archivedConfidence: 0.0 });
    expect(s.patterns.length).toBe(n1); // 不重复建
  });

  it("to_prompt 只注入高置信度稳定习惯（≥0.5 且有 steps）", () => {
    const s = new BehaviorStore();
    s.reinforce({ scenario: "稳定习惯", steps: ["a", "b"] });
    const p = s.patterns[0];
    for (let i = 0; i < 5; i++) {
      s.reinforce({ scenario: "稳定习惯", steps: ["a", "b"] });
    }
    expect(p.confidence).toBeGreaterThanOrEqual(0.5);
    s.reinforce({ scenario: "未成型", steps: ["x"] });
    const prompt = s.toPrompt(5);
    expect(prompt).toContain("稳定习惯");
    expect(prompt).not.toContain("未成型");
  });

  it("序列化往返（agents.json 格式）", () => {
    const s = new BehaviorStore();
    s.reinforce({ scenario: "写代码", steps: ["需求", "实现", "测试"], source: "llm" });
    const d = s.toDict();
    const s2 = BehaviorStore.fromDict(d);
    expect(s2.patterns.length).toBe(1);
    expect(s2.patterns[0].scenario).toBe("写代码");
    expect(s2.patterns[0].confidence).toBe(0.3);
  });

  it("clone 深拷贝（分裂继承 shadow 语义）", () => {
    const s = new BehaviorStore();
    s.reinforce({ scenario: "s", steps: ["x"] });
    const c = s.clone();
    c.reinforce({ scenario: "s", steps: ["x"] });
    expect(c.patterns[0].confidence).not.toBe(s.patterns[0].confidence);
  });
});

describe("MindHooks（L2 心智注入固定段）", () => {
  it("buildMindSegments：行为模式 + 当前状态（情绪叙事）注入", () => {
    const e = new EmotionalState();
    for (let i = 0; i < 8; i++) {
      e.update({ success: true }); // happy
    }
    const b = new BehaviorStore();
    for (let i = 0; i < 6; i++) {
      b.reinforce({ scenario: "先测试再交付", steps: ["写测试", "跑测试", "交付"] }); // 0.55
    }
    const segs = buildMindSegments(e, b);
    expect(segs.some((s) => s.includes("## 行为模式"))).toBe(true);
    expect(segs.some((s) => s.includes("先测试再交付"))).toBe(true);
    expect(segs.some((s) => s.includes("当前情绪：快乐"))).toBe(true);
  });

  it("mindHooks：fixedSegments 接入，retrieveSegments 阶段 4.2 前为空", async () => {
    const e = new EmotionalState();
    const b = new BehaviorStore();
    const hooks = mindHooks(e, b);
    const segs = hooks.fixedSegments({ name: "小灵", role: "助手" });
    expect(segs.join("\n")).toContain("当前情绪：平静");
    expect(await hooks.retrieveSegments("a1", "q")).toEqual([]);
  });
});

describe("ConsolidationEngine（沉淀引擎）", () => {
  it("每 50 次交互触发一次", () => {
    const eng = new ConsolidationEngine();
    expect(eng.shouldConsolidate(0)).toBe(false);
    expect(eng.shouldConsolidate(49)).toBe(false);
    expect(eng.shouldConsolidate(50)).toBe(true);
    expect(eng.shouldConsolidate(100)).toBe(true);
  });

  it("knowledgeTraits 高频 pattern → 行为模式（跳过已存在）", () => {
    const eng = new ConsolidationEngine();
    const s = new BehaviorStore();
    s.reinforce({ scenario: "已有场景", steps: ["a"] });
    const existing = new Set(["已有场景"]);
    const r = eng.consolidate({
      behavior: s,
      totalInteractions: 50,
      knowledgeTraits: [
        { name: "已有场景", source: "k1" },
        { name: "新场景A", source: "k2" },
        { name: "新场景B", source: "k3" },
        { name: "新场景C", source: "k4" },
      ],
      existingScenarios: existing,
    });
    expect(r.reinforced).toBe(2); // 只新增 2 个（跳过已有 + 前 3 限制）
    expect(s.patterns.some((p) => p.scenario === "新场景A")).toBe(true);
  });

  it("归档回调：归档条目交给调用方后从活跃层移除", () => {
    const eng = new ConsolidationEngine();
    const s = new BehaviorStore();
    s.patterns.push(new BehaviorPattern({
      patternId: "pat_old", scenario: "旧", steps: ["a"],
      confidence: 0.14, lastReinforced: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    }));
    const archived: string[] = [];
    eng.consolidate({
      behavior: s,
      totalInteractions: 50,
      onArchived: (p) => archived.push(p.scenario),
    });
    expect(archived).toEqual(["旧"]);
    expect(s.patterns.some((p) => p.scenario === "旧")).toBe(false);
  });
});