/**
 * A-1035 守卫：心智 ↔ 记忆 ↔ 知识 三方闭环 + 知识驱动能力调用。
 *
 * 这一轮修的是一整批**"有实现、没接线"**：函数都写好了、测试也全绿，
 * 但生产代码里根本没有调用者 —— 于是对外宣称的能力实际不存在。
 * 所以本文件的重点不是"函数能不能跑"，而是**接线是否真的接上了**。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KnowledgeEngine, applyTraitToPersona } from "../../core-ts/src/memory/knowledge.js";
import { SkillRegistry, loadAllSkills } from "../../core-ts/src/skills.js";
import { getRegistry } from "../../core-ts/src/tools/registry.js";
import { ConsolidationEngine, BehaviorStore } from "../../core-ts/src/mind/behavior.js";

const ROOT = resolve(__dirname, "../..");
const readText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a1035-"));
});
function cleanup(): void { rmSync(dir, { recursive: true, force: true }); }

/** 造一个达到 skill 阈值的 pattern（阈值 10） */
function seedPattern(ke: KnowledgeEngine, key: string, times: number, category = "learning"): Record<string, unknown> {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < times; i += 1) { last = ke.recordPattern(key, category, "测试用", "low"); }
  return last;
}

describe("A-1035 ① 知识 → 人格（trait 写入不再只在死代码里）", () => {
  it("applyTraitToPersona：新 trait 以弱先验 0.45 建立，重复调用则加权且不重复插入", () => {
    const persona = { traits: [] as Array<{ name: string; weight: number }> };
    const first = applyTraitToPersona(persona, "代码审查", "k");
    expect(first.created).toBe(true);
    expect(persona.traits).toHaveLength(1);
    expect(persona.traits[0].weight).toBe(0.45);
    applyTraitToPersona(persona, "代码审查", "k");
    expect(persona.traits).toHaveLength(1);
    expect(persona.traits[0].weight).toBeGreaterThan(0.45);
  });

  it("空 trait 名不写入（不产出无名条目）", () => {
    const persona = { traits: [] as Array<{ name: string; weight: number }> };
    expect(applyTraitToPersona(persona, "   ", "k").created).toBe(false);
    expect(persona.traits).toHaveLength(0);
  });

  it("★ applyPromotion 在 action 只报最高一档时，**仍然**写下低档的 trait", () => {
    // 这正是最容易漏的一条：recordPattern 的 action 是逐档覆盖赋值，
    // 命中 skill 阈值时 action 只剩 "promote_to_skill"，按 action 分派就会漏写 trait。
    const ke = new KnowledgeEngine("a1", { dataDir: dir });
    const persona = { traits: [] as Array<{ name: string; weight: number }> };
    const result = seedPattern(ke, "task.demo.success", 10, "learning");
    expect(result.action).toBe("promote_to_skill");      // 最高档确实是 skill
    const out = ke.applyPromotion(result, persona);
    expect(out.trait, "低档 trait 不能被跳过").toBeTruthy();
    expect(persona.traits.length).toBe(1);
    cleanup();
  });

  it("applyPromotion 生成技能时，落盘目录 == generatedSkillsDir（访问器与实际写入必须一致）", () => {
    const ke = new KnowledgeEngine("a1", { dataDir: dir });
    const result = seedPattern(ke, "task.demo.success", 10, "learning");
    const out = ke.applyPromotion(result, null);
    expect(out.skill).toBeTruthy();
    expect(resolve(out.skill!.dir).startsWith(resolve(ke.generatedSkillsDir))).toBe(true);
    expect(existsSync(join(out.skill!.dir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(out.skill!.dir, "manifest.json"))).toBe(true);
    cleanup();
  });

  it("applyPromotion 幂等：第二次调用不再重写技能模板", () => {
    const ke = new KnowledgeEngine("a1", { dataDir: dir });
    const first = ke.applyPromotion(seedPattern(ke, "task.demo.success", 10, "learning"), null);
    const stamp = readFileSync(join(first.skill!.dir, "SKILL.md"), "utf8");
    const again = ke.applyPromotion(ke.recordPattern("task.demo.success", "learning", "x", "low"), null);
    expect(again.skill).toBeUndefined();
    expect(readFileSync(join(first.skill!.dir, "SKILL.md"), "utf8")).toBe(stamp);
    cleanup();
  });

  it("getPromotableTraits 只返回越过 trait 阈值的 pattern", () => {
    const ke = new KnowledgeEngine("a1", { dataDir: dir });
    seedPattern(ke, "task.low.success", 3, "learning");
    seedPattern(ke, "task.high.success", 8, "learning");
    const names = ke.getPromotableTraits().map((t) => t.name);
    expect(names.length).toBe(1);
    cleanup();
  });
});

describe("A-1035 ② 知识 → 心智（行为沉淀这一跳真的被喂了参数）", () => {
  it("consolidate 收到 knowledgeTraits 时会把知识里的高频项沉淀成行为模式", () => {
    const store = BehaviorStore.fromDict({});
    const ce = new ConsolidationEngine();
    const patternsOf = (s: BehaviorStore): Array<{ scenario?: string }> =>
      (s.toDict().patterns ?? []) as Array<{ scenario?: string }>;
    const before = patternsOf(store).length;
    ce.consolidate({
      behavior: store,
      totalInteractions: 50,
      knowledgeTraits: [{ name: "代码审查", source: "task.code-review.success" }],
      existingScenarios: new Set<string>(),
    });
    const after = patternsOf(store);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((p) => String(p.scenario ?? "").includes("代码审查"))).toBe(true);
  });

  it("不传 knowledgeTraits 时行为库不凭空多出条目（参数缺失 ≠ 静默造假数据）", () => {
    const store = BehaviorStore.fromDict({});
    new ConsolidationEngine().consolidate({ behavior: store, totalInteractions: 50, existingScenarios: new Set<string>() });
    const patterns = (store.toDict().patterns ?? []) as Array<unknown>;
    expect(patterns.length).toBe(0);
  });
});

describe("A-1035 ③ 知识 → 技能 → Agent 可调用", () => {
  it("SkillRegistry 的 extraDirs 能被检索到（自动生成的技能不再是死文件）", async () => {
    const main = join(dir, "main"); mkdirSync(main, { recursive: true });
    const extra = join(dir, "gen"); mkdirSync(join(extra, "auto-skill"), { recursive: true });
    writeFileSync(join(extra, "auto-skill", "manifest.json"), JSON.stringify({ name: "auto-skill", description: "自动生成", tags: ["auto"] }));
    writeFileSync(join(extra, "auto-skill", "SKILL.md"), "# auto-skill\n");
    const reg = new SkillRegistry({ skillDir: main, extraDirs: [extra] });
    const loaded = await reg.loadSkills();
    expect(loaded).toContain("auto-skill");
    expect(reg.search("auto", 5).some((s) => s.name === "auto-skill")).toBe(true);
    cleanup();
  });

  it("主目录优先：同名技能时人工版覆盖自动生成版", async () => {
    const main = join(dir, "main"); mkdirSync(join(main, "dup"), { recursive: true });
    writeFileSync(join(main, "dup", "manifest.json"), JSON.stringify({ name: "dup", description: "人工版" }));
    writeFileSync(join(main, "dup", "SKILL.md"), "# 人工版\n");
    const extra = join(dir, "gen"); mkdirSync(join(extra, "dup"), { recursive: true });
    writeFileSync(join(extra, "dup", "manifest.json"), JSON.stringify({ name: "dup", description: "自动版" }));
    writeFileSync(join(extra, "dup", "SKILL.md"), "# 自动版\n");
    const reg = new SkillRegistry({ skillDir: main, extraDirs: [extra] });
    await reg.loadSkills();
    const hit = reg.search("dup", 5).find((s) => s.name === "dup");
    expect(hit?.description).toBe("人工版");
    cleanup();
  });

  it("主目录不存在不再连坐掉 extraDirs（原来会直接 return []）", async () => {
    const extra = join(dir, "gen"); mkdirSync(join(extra, "only-here"), { recursive: true });
    writeFileSync(join(extra, "only-here", "manifest.json"), JSON.stringify({ name: "only-here", description: "x" }));
    writeFileSync(join(extra, "only-here", "SKILL.md"), "# only-here\n");
    const reg = new SkillRegistry({ skillDir: join(dir, "不存在的目录"), extraDirs: [extra] });
    expect(await reg.loadSkills()).toContain("only-here");
    cleanup();
  });

  it("loadAllSkills 真的把 skill_search / skill_lookup 注册进工具表（Agent 才调得到）", async () => {
    const main = join(dir, "main"); mkdirSync(join(main, "s1"), { recursive: true });
    writeFileSync(join(main, "s1", "manifest.json"), JSON.stringify({ name: "s1", description: "技能一" }));
    writeFileSync(join(main, "s1", "SKILL.md"), "# s1\n正文内容\n");
    const toolReg = getRegistry();
    await loadAllSkills({ skillDir: main, registry: toolReg });
    const names = (toolReg.listTools() as Array<{ function?: { name?: string } }>)
      .map((t) => t.function?.name ?? "");
    expect(names).toContain("skill_search");
    expect(names).toContain("skill_lookup");
    cleanup();
  });
});

describe("A-1035 ④ 接线守卫（函数写对了但没人调用 = 白写）", () => {
  it("chat.ts 后处理必须消费 recordPattern 的返回值并做晋升", () => {
    const src = readText("core-ts/src/services/chat.ts");
    expect(src).toMatch(/ke\.applyPromotion\(/);
    expect(src).toMatch(/const primary = success/);
  });

  it("chat.ts 必须把 knowledgeTraits 传给 ConsolidationEngine", () => {
    const src = readText("core-ts/src/services/chat.ts");
    expect(src).toMatch(/knowledgeTraits:\s*ke\s*\?\s*ke\.getPromotableTraits\(\)/);
  });

  it("chat.ts 必须调用周期审查 review（唯一会批量写 persona.traits 的入口）", () => {
    expect(readText("core-ts/src/services/chat.ts")).toMatch(/ke\.review\(agent\.persona/);
  });

  it("Swarm 路径同样接线（不能只修 chat 一份）", () => {
    const src = readText("core-ts/src/services/swarm.ts");
    expect(src).toMatch(/knowledgeTraits:\s*ke\s*\?\s*ke\.getPromotableTraits\(\)/);
    expect(src).toMatch(/ke\.review\(agent\.persona/);
  });

  it("工具使用必须回写成知识（能力→知识那一跳）", () => {
    const src = readText("core-ts/src/services/chat.ts");
    expect(src).toMatch(/tool\.\$\{t\}\.\$\{success \? "success" : "fail"\}/);
  });

  it("GUI 必须真的调用 loadAllSkills 并刷新技能可见集（此前只用一次性 registry 列 UI）", () => {
    const src = readText("gui/src/main/index.ts");
    expect(src).toMatch(/await loadAllSkills\(\{ registry: getRegistry\(\), extraDirs \}\)/);
    expect(src).toMatch(/async function refreshAgentSkills\(/);
    // 初始化与每轮对话前都要刷（否则上一轮生成的技能下一轮搜不到）
    expect((src.match(/refreshAgentSkills\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("ChatServiceOptions 提供 dataDir，让嵌入方与测试能改道（否则永远写项目根）", () => {
    const src = readText("core-ts/src/services/chat.ts");
    expect(src).toMatch(/this\.knowledgeDataDir = opts\.dataDir/);
    expect(src).toMatch(/dataDir: this\.knowledgeDataDir/);
  });

  it("[反例] 上面两条正则必须真的能抓到「没接线」的写法（守卫自检）", () => {
    const bad = "ke.recordPattern(\"x\", \"task\");\n// knowledgeTraits 没传\nce.consolidate({ behavior });";
    expect(/ke\.applyPromotion\(/.test(bad)).toBe(false);
    expect(/knowledgeTraits:\s*ke\s*\?\s*ke\.getPromotableTraits\(\)/.test(bad)).toBe(false);
  });
});
