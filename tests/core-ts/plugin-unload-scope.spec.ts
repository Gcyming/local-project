import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillRegistry,
  SKILL_SOURCE_PROTECTED_PREFIX,
  skillBelongsToSource,
  SKILL_VISIBILITY_DENIED_PREFIX,
  getSkillRegistry,
  loadAllSkills,
  resetSkillRegistry,
  skillScopeFromArgs,
} from "../../core-ts/src/skills.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";
import { UNRESTRICTED_SKILL_VISIBILITY } from "../../core-ts/src/services/agentTools.js";
import {
  PLUGIN_SKILLS_SUBDIR,
  pluginSkillsRoot,
  readPluginSkillNames,
} from "../../core-ts/src/plugin/loader.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-unload-scope-"));
  roots.push(root);
  return root;
}

/** 写一个技能目录：SKILL.md 是载入口径（loadSingleSkill 缺它就返回 null）。 */
function writeSkill(skillsRoot: string, dirName: string, skillName: string): void {
  const d = join(skillsRoot, dirName);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: 技能「${skillName}」的简介。\n---\n\n# ${skillName}\n\n正文。\n`,
    "utf8",
  );
}

/** 一个插件目录：<plugin>/skills/<skillDir>/SKILL.md */
function makePlugin(skillsParent: string, pluginName: string, skills: Array<[string, string]>): string {
  const dir = join(skillsParent, pluginName);
  const skillsRoot = pluginSkillsRoot(dir);
  mkdirSync(skillsRoot, { recursive: true });
  for (const [dirName, skillName] of skills) {
    writeSkill(skillsRoot, dirName, skillName);
  }
  return skillsRoot;
}

function newRegistry(systemRoot: string): SkillRegistry {
  return new SkillRegistry({ skillDir: systemRoot, extraDirs: [] });
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("按来源卸载：只摘命中来源，其余原样留下", () => {
  it("3 个技能分属 2 个来源 ⇒ 卸载 A 后 A 的技能搜不到、B 的仍在（search 与 lookup 两条路径都验）", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    writeSkill(systemRoot, "sys", "sys-skill");

    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"], ["a-two", "a-two"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["b-one", "b-one"]]);

    const reg = newRegistry(systemRoot);
    await reg.loadSkillsFromDirs([systemRoot, rootA, rootB]);

    expect(reg.listSkillNames().sort()).toEqual(["a-one", "a-two", "b-one", "sys-skill"]);

    const removed = await reg.unloadBySource(rootA);

    expect(removed.sort()).toEqual(["a-one", "a-two"]);

    // 路径一：search（skill_search 的底层）—— A 的技能一条都不该出现，B 的仍在
    const hits = reg.search("a-one", 50, UNRESTRICTED_SKILL_VISIBILITY);
    expect(hits.map((h) => h.name)).toEqual([]);
    expect(reg.search("a-two", 50, UNRESTRICTED_SKILL_VISIBILITY)).toEqual([]);
    expect(reg.search("b-one", 50, UNRESTRICTED_SKILL_VISIBILITY).map((h) => h.name)).toEqual(["b-one"]);

    // 路径二：lookup（skill_lookup 的底层 = callSkill）—— 同样必须查不到
    await expect(reg.callSkill("a-one", {}, UNRESTRICTED_SKILL_VISIBILITY)).resolves.toContain("未找到");
    await expect(reg.callSkill("a-two", {}, UNRESTRICTED_SKILL_VISIBILITY)).resolves.toContain("未找到");
    const bBody = await reg.callSkill("b-one", {}, UNRESTRICTED_SKILL_VISIBILITY);
    expect(bBody).toContain("b-one");
    expect(bBody).toContain("正文");

    // 系统来源的技能既不该被摘，也不该受影响
    expect(reg.listSkillNames().sort()).toEqual(["b-one", "sys-skill"]);

    // 白名单（P4 真实访问控制）没有被绕过：卸载不影响白名单语义，检索照旧走可见性判定
    const allowedOnlyB = { constrained: true, allowed: ["b-one"], allowAgentAuthored: false };
    expect(reg.search("", 50, allowedOnlyB).map((h) => h.name)).toEqual(["b-one"]);
  });

  it("归属判定只认目录前缀，不会把同名前缀的兄弟目录误判为归属", () => {
    const tmp = makeRoot();
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const sibling = makePlugin(tmp, "plugin-ab", [["ab-one", "ab-one"]]);

    // rootA 与 sibling 是同层兄弟目录，前缀互不包含
    expect(skillBelongsToSource(join(rootA, "a-one"), rootA)).toBe(true);
    expect(skillBelongsToSource(join(sibling, "ab-one"), rootA)).toBe(false);
    expect(skillBelongsToSource(join(rootA, "a-one"), sibling)).toBe(false);
  });

  it("嵌套子目录算归属（同来源根下的深层目录）", () => {
    const tmp = makeRoot();
    const root = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    expect(skillBelongsToSource(join(root, "a-one", "deep", "deeper"), root)).toBe(true);
  });
});

describe("按来源卸载：幂等", () => {
  it("重复卸载同一来源 ⇒ 第二次返回空数组且不误伤其它来源", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["b-one", "b-one"]]);

    const reg = newRegistry(systemRoot);
    await reg.loadSkillsFromDirs([rootA, rootB]);

    expect((await reg.unloadBySource(rootA)).sort()).toEqual(["a-one"]);
    expect(await reg.unloadBySource(rootA)).toEqual([]);
    expect(await reg.unloadBySource(rootA)).toEqual([]);

    expect(reg.listSkillNames().sort()).toEqual(["b-one"]);
    expect(reg.search("b-one", 50, UNRESTRICTED_SKILL_VISIBILITY).map((h) => h.name)).toEqual(["b-one"]);
  });

  it("卸载不存在的来源 ⇒ 返回空数组且不抛错", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);

    const reg = newRegistry(systemRoot);
    await reg.loadSkillsFromDirs([rootA]);

    expect(await reg.unloadBySource(join(tmp, "never-existed"))).toEqual([]);
    expect(reg.listSkillNames()).toEqual(["a-one"]);
  });

  it("撤销过的来源进入 unloadedSources：即便它后来被列进扫描根，全量重载也不把它扫回来", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);

    const reg = newRegistry(systemRoot);
    const handle = await reg.loadFromSource(rootA, "plugin-a");
    expect(reg.listSkillNames()).toEqual(["a-one"]);

    handle.dispose();
    expect(reg.listSkillNames()).toEqual([]);
    expect(reg.listUnloadedSources()).toHaveLength(1);

    // 把这个来源补进扫描根（模拟它后来被登记成额外目录）：unloadedSources 必须仍然挡住它
    reg.extraDirs = [rootA];
    await reg.loadSkills();
    expect(reg.listSkillNames()).toEqual([]);
    expect(reg.search("a-one", 50, UNRESTRICTED_SKILL_VISIBILITY)).toEqual([]);

    // loadFromSource 是解封入口：显式按来源装配才能把它装回来
    await reg.loadFromSource(rootA, "plugin-a");
    expect(reg.listSkillNames()).toEqual(["a-one"]);
  });
});

describe("按来源卸载：系统来源 fail-closed", () => {
  it("卸载 skillDir（系统来源根）⇒ 抛错且技能仍在", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    writeSkill(systemRoot, "sys", "sys-skill");

    const reg = newRegistry(systemRoot);
    await reg.loadSkillsFromDirs([systemRoot]);

    await expect(reg.unloadBySource(systemRoot)).rejects.toThrow(SKILL_SOURCE_PROTECTED_PREFIX);
    expect(reg.listSkillNames()).toEqual(["sys-skill"]);
    expect(reg.search("sys-skill", 50, UNRESTRICTED_SKILL_VISIBILITY).map((h) => h.name)).toEqual(["sys-skill"]);
  });

  it("卸载 extraDirs 里的系统来源根 ⇒ 同样抛错（保护的是全部系统装配根，不只 skillDir）", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    const agentRoot = join(tmp, "agent-skills");
    mkdirSync(systemRoot, { recursive: true });
    mkdirSync(agentRoot, { recursive: true });
    writeSkill(agentRoot, "agent-made", "agent-skill");

    const reg = new SkillRegistry({ skillDir: systemRoot, extraDirs: [agentRoot] });
    await reg.loadSkillsFromDirs([agentRoot]);

    await expect(reg.unloadBySource(agentRoot)).rejects.toThrow(SKILL_SOURCE_PROTECTED_PREFIX);
    expect(reg.listSkillNames()).toEqual(["agent-skill"]);
  });

  it("空来源根 ⇒ 返回空数组（无事可做，不算系统来源因而也不抛错）", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const reg = newRegistry(systemRoot);
    expect(await reg.unloadBySource("   ")).toEqual([]);
    expect(await reg.unloadBySource("")).toEqual([]);
  });
});

describe("loadFromSource：按名精确撤销", () => {
  it("同批次同名技能不被误摘：A 先占名、B 的同名技能不归 A，B 撤 A 后同名仍在", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });

    // A 与 B 都提供名为 shared-name 的技能：A 先载入占住这个名字，B 的同名技能被拒（载入去重）
    const rootA = makePlugin(tmp, "plugin-a", [["shared", "shared-name"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["shared", "shared-name"]]);

    const reg = newRegistry(systemRoot);
    const handleA = await reg.loadFromSource(rootA, "plugin-a");
    const handleB = await reg.loadFromSource(rootB, "plugin-b");

    // B 因为同名被 A 占位，不算「本次真正新增」⇒ B 的撤销句柄不该声称摘掉任何东西
    expect(reg.listSkillNames()).toEqual(["shared-name"]);

    // 撤 A：shared-name 本体归 A，按名精确撤销应当真的摘掉它
    handleA.dispose();
    expect(reg.listSkillNames()).toEqual([]);

    // 撤 B：B 从未新增过任何名字 ⇒ 撤它不得误伤（此时也没有同名技能可误伤）
    handleB.dispose();
    expect(reg.listSkillNames()).toEqual([]);
  });

  it("撤 B（后载入的同批次）不得摘掉 A 的技能", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["shared", "shared-name"]]);

    const reg = newRegistry(systemRoot);
    const handleA = await reg.loadFromSource(rootA, "plugin-a");
    const handleB = await reg.loadFromSource(rootB, "plugin-b");

    // 先撤 B：只摘 B 本次新增的 shared-name，A 的技能必须原样留下
    handleB.dispose();
    expect(reg.listSkillNames()).toEqual(["a-one"]);
    expect(reg.search("a-one", 50, UNRESTRICTED_SKILL_VISIBILITY).map((h) => h.name)).toEqual(["a-one"]);
    await expect(reg.callSkill("a-one", {}, UNRESTRICTED_SKILL_VISIBILITY)).resolves.toContain("正文");

    handleA.dispose();
    expect(reg.listSkillNames()).toEqual([]);
  });

  it("同一句柄重复 dispose 幂等（第二次不再重复摘）", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["b-one", "b-one"]]);

    const reg = newRegistry(systemRoot);
    const handleA = await reg.loadFromSource(rootA, "plugin-a");
    const handleB = await reg.loadFromSource(rootB, "plugin-b");

    handleB.dispose();
    handleA.dispose();
    // A 已摘完；再 dispose 一次不应把 B 的技能误摘（哪怕 B 名字也在本次集合里被重复计入）
    handleA.dispose();
    expect(reg.listSkillNames()).toEqual([]);
  });

  it("句柄带来源插件名，供上层归因", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);

    const reg = newRegistry(systemRoot);
    const handle = await reg.loadFromSource(rootA, "plugin-a");
    expect(handle.name).toBe("plugin-a");
    expect(typeof handle.dispose).toBe("function");
  });
});

describe("loadFromSource 与 unloadBySource 的往返语义", () => {
  it("unloadBySource 之后 loadFromSource 能把该来源重新装回来", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["b-one", "b-one"]]);

    const reg = newRegistry(systemRoot);
    await reg.loadSkillsFromDirs([rootA, rootB]);
    await reg.unloadBySource(rootA);
    expect(reg.listSkillNames()).toEqual(["b-one"]);

    // 撤销句柄那次 dispose 把来源记进了 unloadedSources，loadFromSource 必须能把它解封
    const handle = await reg.loadFromSource(rootA, "plugin-a");
    expect(reg.listSkillNames().sort()).toEqual(["a-one", "b-one"]);

    handle.dispose();
    expect(reg.listSkillNames()).toEqual(["b-one"]);
  });

  it("dispose 之后再 loadFromSource 同一来源 ⇒ 重新装回并给出新的可用句柄", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);

    const reg = newRegistry(systemRoot);
    const first = await reg.loadFromSource(rootA, "plugin-a");
    first.dispose();
    expect(reg.listSkillNames()).toEqual([]);

    const second = await reg.loadFromSource(rootA, "plugin-a");
    expect(reg.listSkillNames()).toEqual(["a-one"]);
    second.dispose();
    expect(reg.listSkillNames()).toEqual([]);
  });
});

describe("skill_search / skill_lookup 工具层：工具路径也反映卸载结果", () => {
  it("走真实工具调用（callTool）⇒ 卸载后 search 查不到、lookup 报错，另一来源照常可用", async () => {
    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["b-one", "b-one"]]);

    // 不传 skillDir：让 loadAllSkills 复用全局 registry（工具闭包绑到它上面），
    // 这样我们既能通过同一实例做卸载，也能断言工具路径确实反映了卸载结果。
    // 插件技能刻意**不**登记进 extraDirs —— 一旦登记它就成了系统来源根，
    // 按来源卸载会 fail-closed 拒绝（这正是 gui 接线把插件技能走 loadFromSource 的原因）。
    resetSkillRegistry();
    const reg = getSkillRegistry();
    reg.skillDir = systemRoot;

    const toolReg = new ToolRegistry();
    await loadAllSkills({ registry: toolReg });
    await reg.loadFromSource(rootA, "plugin-a");
    await reg.loadFromSource(rootB, "plugin-b");

    expect(reg.listSkillNames().sort()).toEqual(["a-one", "b-one"]);
    expect(toolReg.listToolNames()).toContain("skill_search");
    expect(toolReg.listToolNames()).toContain("skill_lookup");

    const open: { constrained: false; allowed: string[]; allowAgentAuthored: boolean } = {
      constrained: false,
      allowed: [],
      allowAgentAuthored: false,
    };
    const searchA = await toolReg.callTool("skill_search", { query: "a-one", _skill_scope: JSON.stringify(open) });
    expect(searchA).toContain("a-one");
    const lookupA = await toolReg.callTool("skill_lookup", { name: "a-one", _skill_scope: JSON.stringify(open) });
    expect(lookupA).toContain("正文");

    expect(await reg.unloadBySource(rootA)).toEqual(["a-one"]);

    const searchAfter = await toolReg.callTool("skill_search", { query: "a-one", _skill_scope: JSON.stringify(open) });
    expect(searchAfter).not.toContain("a-one");
    expect(searchAfter).toContain("未找到匹配的技能");

    const lookupAfter = await toolReg.callTool("skill_lookup", { name: "a-one", _skill_scope: JSON.stringify(open) });
    expect(lookupAfter).toContain("未找到");

    // 另一来源必须照常可用（不能因为撤 A 把 B 一起带走）
    const searchB = await toolReg.callTool("skill_search", { query: "b-one", _skill_scope: JSON.stringify(open) });
    expect(searchB).toContain("b-one");
    const lookupB = await toolReg.callTool("skill_lookup", { name: "b-one", _skill_scope: JSON.stringify(open) });
    expect(lookupB).toContain("正文");
  });

  it("skillScopeFromArgs 解析出的白名单信封可透传给 search/lookup（不绕过可见性判定）", async () => {
    const scope = skillScopeFromArgs({ _skill_scope: JSON.stringify({ constrained: true, allowed: ["b-one"] }) });
    expect(scope).toEqual({ constrained: true, allowed: ["b-one"], allowAgentAuthored: false });

    const tmp = makeRoot();
    const systemRoot = join(tmp, "system-skills");
    mkdirSync(systemRoot, { recursive: true });
    const rootA = makePlugin(tmp, "plugin-a", [["a-one", "a-one"]]);
    const rootB = makePlugin(tmp, "plugin-b", [["b-one", "b-one"]]);

    const reg = newRegistry(systemRoot);
    await reg.loadSkillsFromDirs([rootA, rootB]);
    await reg.unloadBySource(rootA);

    // 白名单里只有 b-one：a-one 既已卸载、也不在白名单，两条路径都拿不到它的正文
    expect(reg.search("", 50, scope).map((h) => h.name)).toEqual(["b-one"]);
    await expect(reg.callSkill("a-one", {}, scope)).resolves.toContain(SKILL_VISIBILITY_DENIED_PREFIX);
    await expect(reg.callSkill("b-one", {}, scope)).resolves.toContain("正文");
  });
});

describe("gui 接线层：registerInstructions 必须是按插件粒度，不得回退成全局粒度", () => {
  const source = readFileSync(new URL("../../gui/src/main/index.ts", import.meta.url), "utf8");

  function registerInstructionsBody(): string {
    const start = source.indexOf("registerInstructions:");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("async function scanAndLoadInto", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("registerInstructions 接收 manifest 形参（按插件粒度的前提）", () => {
    expect(registerInstructionsBody()).toMatch(/registerInstructions:\s*\(\s*manifest\s*\)/);
  });

  it("走 loadFromSource 按来源装配，并把它返回的 dispose 包成 ContributionScope 的撤销句柄", () => {
    const body = registerInstructionsBody();
    expect(body).toContain("pluginSkillsRoot");
    expect(body).toContain("loadFromSource");
    expect(body).toContain("dispose");
    // 撤销必须落在 SkillRegistry 的按名撤销上，而不是「清空后全量重装」
    expect(body).not.toMatch(/loadSkills\(\)/);
    expect(body).not.toMatch(/\.clear\(\)/);
  });

  it("不再用 listSkillNames() 全局计数来决定这次撤销什么（那正是旧的全局粒度写法）", () => {
    const body = registerInstructionsBody();
    expect(body).not.toContain("listSkillNames");
  });

  it("builtin 插件走独立分支：不参与按来源撤销，只登记技能入口工具名", () => {
    const body = registerInstructionsBody();
    expect(body).toMatch(/manifest\.origin\s*===\s*"builtin"/);
    // builtin 分支里不得出现 loadFromSource（系统来源根对按来源卸载一律 fail-closed）
    const builtinIdx = body.indexOf('manifest.origin === "builtin"');
    expect(builtinIdx).toBeGreaterThan(-1);
    const builtinBranch = body.slice(builtinIdx, body.indexOf("const dir = dirs.get"));
    expect(builtinBranch).not.toContain("loadFromSource");
    expect(builtinBranch).not.toContain("unloadBySource");
  });

  it("插件目录缺失时如实不登记（返回空数组），不猜来源", () => {
    const body = registerInstructionsBody();
    expect(body).toMatch(/if\s*\(\s*!dir\s*\)/);
    expect(body).toMatch(/return \[\];/);
  });

  it("来源目录来自 scanAndLoadInto 填好的 manifest.name → dir 映射", () => {
    expect(source).toMatch(/dirs\.set\(loaded\.manifest\.name,\s*loaded\.dir\)/);
    expect(source).toMatch(/dirs\.get\(manifest\.name\)/);
    // createPluginHost 必须拿到同一个 dirs 实例，否则按来源装配拿不到目录
    expect(source).toMatch(/createPluginHost\(dirs\)/);
    expect(source).toMatch(/scanAndLoadInto\(host,\s*dirs\)/);
  });
});

describe("loader：插件自带技能的事实来源", () => {
  it("pluginSkillsRoot 指向 <dir>/skills", () => {
    expect(PLUGIN_SKILLS_SUBDIR).toBe("skills");
    expect(pluginSkillsRoot(join("x", "p"))).toBe(join("x", "p", "skills"));
  });

  it("readPluginSkillNames 只认含 SKILL.md 的目录；无 skills 目录时返回 undefined", async () => {
    const tmp = makeRoot();
    const dir = join(tmp, "p");
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeSkill(pluginSkillsRoot(dir), "one", "one");
    // 无 SKILL.md 的目录不算技能
    mkdirSync(join(pluginSkillsRoot(dir), "no-skill-md"), { recursive: true });
    // __ 前缀目录被跳过
    writeSkill(pluginSkillsRoot(dir), "__internal", "internal");

    expect(await readPluginSkillNames(dir)).toEqual(["one"]);

    const bare = join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    expect(await readPluginSkillNames(bare)).toBeUndefined();
  });
});
