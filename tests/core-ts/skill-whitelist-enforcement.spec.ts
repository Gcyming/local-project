import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, Tool } from "../../core-ts/src/tools/registry.js";
import { ToolLoop } from "../../core-ts/src/tool_loop.js";
import type { ModelRouter } from "../../core-ts/src/router.js";
import {
  SkillRegistry,
  loadAllSkills,
  skillScopeFromArgs,
  skillVisibilityDenial,
  SKILL_VISIBILITY_DENIED_PREFIX,
} from "../../core-ts/src/skills.js";
import {
  DEFAULT_TOOL_PROFILE,
  resolveSkillVisibilityScope,
  isSkillNameVisible,
  isSkillEntryToolName,
  agentToolsOnly,
  agentSkillVisibilityFor,
  registerAgentSkillVisibility,
  resetAgentSkillVisibility,
  UNRESTRICTED_SKILL_VISIBILITY,
  type ToolProfile,
} from "../../core-ts/src/services/agentTools.js";

const dir = await mkdtemp(join(tmpdir(), "skill-scope-"));

async function writeSkill(name: string, files: Record<string, string>): Promise<void> {
  const d = join(dir, name);
  await mkdir(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(d, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, content, "utf8");
  }
}

beforeEach(() => {
  resetAgentSkillVisibility();
});

afterEach(async () => {
  resetAgentSkillVisibility();
  await rm(dir, { recursive: true, force: true });
});

describe("P4-1 resolveSkillVisibilityScope：白名单语义（空 ≠ 全部）", () => {
  it("profile 缺失 ⇒ 不受约束（保持改动前行为，向后兼容）", () => {
    const s = resolveSkillVisibilityScope(undefined);
    expect(s.constrained).toBe(false);
    expect(s.allowed).toEqual([]);
    expect(isSkillNameVisible("任意技能", s)).toBe(true);
  });

  it("profile 为 null ⇒ 不受约束（不得读成「全禁」）", () => {
    expect(resolveSkillVisibilityScope(null).constrained).toBe(false);
  });

  it("custom 且 skills 为空 ⇒ 受约束且一个技能都不可见（不退化成空=全部）", () => {
    const s = resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] });
    expect(s.constrained).toBe(true);
    expect(s.allowed).toEqual([]);
    expect(isSkillNameVisible("google-search-serp", s)).toBe(false);
    expect(isSkillNameVisible("", s)).toBe(false);
  });

  it("custom 且 skills 有值 ⇒ 仅白名单内可见，清单外一律不可见", () => {
    const s = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    expect(s.constrained).toBe(true);
    expect(isSkillNameVisible("alpha", s)).toBe(true);
    expect(isSkillNameVisible("beta", s)).toBe(false);
  });

  it("default 模式 ⇒ 落到内置推荐集（不是「全部技能」）", () => {
    const s = resolveSkillVisibilityScope({ mode: "default", skills: [], mcp: [] });
    expect(s.allowed).toEqual(DEFAULT_TOOL_PROFILE.skills);
    expect(isSkillNameVisible("google-search-serp", s)).toBe(true);
    expect(isSkillNameVisible("grill-me", s)).toBe(false);
  });

  it("profile 字段类型损坏 ⇒ fail-closed（受约束且全禁），不静默放行", () => {
    const s = resolveSkillVisibilityScope({ mode: "custom", skills: "不是数组", mcp: [] } as unknown as ToolProfile);
    expect(s.constrained).toBe(true);
    expect(isSkillNameVisible("alpha", s)).toBe(false);
  });

  it("creator 模式 ⇒ 落到内置推荐集 + 放行 origin=agent 自建技能", () => {
    const s = resolveSkillVisibilityScope({ mode: "creator", skills: ["alpha"], mcp: [] });
    expect(s.allowAgentAuthored).toBe(true);
    expect(s.allowed).toEqual(DEFAULT_TOOL_PROFILE.skills);
    expect(isSkillNameVisible(DEFAULT_TOOL_PROFILE.skills[0], s, false)).toBe(true);
    expect(isSkillNameVisible("agent-made", s, true)).toBe(true);
    expect(isSkillNameVisible("agent-made", s, false)).toBe(false);
  });
});

describe("P4-2 skill_search：白名单外技能搜不到", () => {
  it("受约束时 search 只返回白名单内技能，清单外不出现", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();

    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    const hits = reg.search("浏览器", 10, scope);
    expect(hits.map((h) => h.name)).toEqual(["alpha"]);
    expect(JSON.stringify(reg.search("", 10, scope))).not.toContain("beta");
  });

  it("白名单为空 ⇒ search 一条都不返回（含不带关键词的全量列举）", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 数据处理\n---\n\n# B" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();

    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] });
    expect(reg.search("", 50, scope)).toEqual([]);
    expect(reg.search("浏览器", 50, scope)).toEqual([]);
  });

  it("不传 scope ⇒ 与改动前一致（全部可见，向后兼容）", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();

    expect(reg.search("", 50)).toHaveLength(2);
    expect(reg.search("浏览器", 50).map((h) => h.name).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("P4-3 skill_lookup：白名单外拒绝且给出可执行原因", () => {
  it("白名单外技能 ⇒ 拒绝并说明「不在你当前的白名单内」，而非含糊的未找到", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n正文A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 数据处理\n---\n\n正文B" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();

    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    const r = await reg.callSkill("beta", {}, scope);
    expect(r).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
    expect(r).toContain("不在你当前的白名单内");
    expect(r).toContain("alpha");
    expect(r).toContain("Agent 管理");
    expect(r).not.toContain("正文B");
  });

  it("白名单为空时拒绝文案要点明「白名单为空」", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\n---\n\n正文A" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] });
    const r = await reg.callSkill("alpha", {}, scope);
    expect(r).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
    expect(r).toContain("白名单为空");
  });

  it("白名单内技能 ⇒ 正常返回正文，不被误伤", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\n---\n\n正文A" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    expect(await reg.callSkill("alpha", {}, scope)).toContain("[技能 alpha 指导]");
  });

  it("受约束时连「不存在」的技能也报白名单拒绝（不泄露技能库真实内容）", async () => {
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] });
    expect(await reg.callSkill("never-existed", {}, scope)).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
  });

  it("不传 scope ⇒ 保持原有「未找到」文案（向后兼容，不收紧）", async () => {
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    const r = await reg.callSkill("never-existed", {});
    expect(r).toContain("[错误]");
    expect(r).toContain("未找到");
    expect(r).not.toContain(SKILL_VISIBILITY_DENIED_PREFIX);
  });

  it("拒绝文案使用「」而非 ASCII 双引号（项目铁律）", async () => {
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    const msg = skillVisibilityDenial("beta", scope);
    expect(msg).toContain("「beta」");
    expect(msg).not.toContain('"');
  });

  it("全部对外文案（空/非空白名单两种）均无 ASCII 双引号", () => {
    const nonEmpty = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha", "beta"], mcp: [] });
    const empty = resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] });
    for (const msg of [
      skillVisibilityDenial("gamma", nonEmpty),
      skillVisibilityDenial("gamma", empty),
      skillVisibilityDenial("", nonEmpty),
      SKILL_VISIBILITY_DENIED_PREFIX,
    ]) {
      expect(msg.includes('"'), `含 ASCII 双引号：${msg}`).toBe(false);
    }
  });
});

describe("P4-4 工具入口闭环：skill_search / skill_lookup 端到端强制", () => {
  it("skill_search 注入白名单后搜不到清单外技能", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    const registry = new ToolRegistry();
    await loadAllSkills({ skillDir: dir, registry });

    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    const res = await registry.callTool("skill_search", { query: "浏览器", _skill_scope: scope });
    expect(res).toContain("alpha");
    expect(res).not.toContain("beta");
  });

  it("skill_search 白名单为空 ⇒ 返回明确拒绝而非「未找到」", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    const registry = new ToolRegistry();
    await loadAllSkills({ skillDir: dir, registry });

    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] });
    const res = await registry.callTool("skill_search", { query: "浏览器", _skill_scope: scope });
    expect(res).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
    expect(res).not.toContain("alpha");
  });

  it("skill_lookup 白名单外 ⇒ 拒绝；白名单内 ⇒ 放行", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\n---\n\n正文A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\n---\n\n正文B" });
    const registry = new ToolRegistry();
    await loadAllSkills({ skillDir: dir, registry });

    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    const denied = await registry.callTool("skill_lookup", { name: "beta", _skill_scope: scope });
    expect(denied).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
    expect(denied).not.toContain("正文B");
    expect(await registry.callTool("skill_lookup", { name: "alpha", _skill_scope: scope })).toContain("[技能 alpha 指导]");
  });

  it("无 _skill_scope ⇒ 与改动前一致（全部可见）", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    const registry = new ToolRegistry();
    await loadAllSkills({ skillDir: dir, registry });

    const res = await registry.callTool("skill_search", { query: "浏览器" });
    expect(res).toContain("alpha");
    expect(res).toContain("beta");
    expect(await registry.callTool("skill_lookup", { name: "beta" })).toContain("[技能 beta 指导]");
  });
});

describe("P4-5 skillScopeFromArgs：上下文解析与抗伪造", () => {
  it("_skill_scope 缺省 ⇒ undefined（不约束）", () => {
    expect(skillScopeFromArgs({ query: "x" })).toBeUndefined();
    expect(skillScopeFromArgs({ query: "x", _skill_scope: null })).toBeUndefined();
  });

  it("支持对象形态与 JSON 字符串形态", () => {
    const obj = skillScopeFromArgs({ _skill_scope: { constrained: true, allowed: ["a"], allowAgentAuthored: false } });
    expect(obj?.constrained).toBe(true);
    expect(obj?.allowed).toEqual(["a"]);
    const str = skillScopeFromArgs({ _skill_scope: JSON.stringify({ constrained: true, allowed: ["b"], allowAgentAuthored: true }) });
    expect(str?.allowed).toEqual(["b"]);
    expect(str?.allowAgentAuthored).toBe(true);
  });

  it("constrained 非 true 的信封不得被当作白名单放行", () => {
    const loose = skillScopeFromArgs({ _skill_scope: { constrained: false, allowed: ["任意"] } });
    expect(loose?.constrained).toBe(false);
    expect(UNRESTRICTED_SKILL_VISIBILITY.constrained).toBe(false);
    const junk = skillScopeFromArgs({ _skill_scope: { allowed: ["任意"] } });
    expect(junk).toBeUndefined();
  });

  it("字符串损坏 / 类型离谱 ⇒ 不静默放行也不静默全禁，退回不约束（与改动前一致）", () => {
    expect(skillScopeFromArgs({ _skill_scope: "{不是json" })).toBeUndefined();
    expect(skillScopeFromArgs({ _skill_scope: 12345 })).toBeUndefined();
  });
});

describe("P4-6 白名单注册表：agentId 作用域", () => {
  it("注册后可按 agentId 取回，未注册 ⇒ undefined（⇒ 不约束）", () => {
    expect(agentSkillVisibilityFor("nobody")).toBeUndefined();
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    registerAgentSkillVisibility("a1", scope);
    expect(agentSkillVisibilityFor("a1")?.allowed).toEqual(["alpha"]);
    expect(agentSkillVisibilityFor("a2")).toBeUndefined();
    expect(agentSkillVisibilityFor(undefined)).toBeUndefined();
  });

  it("注册的是副本：外部改动不影响已注册作用域（防别名污染）", () => {
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    registerAgentSkillVisibility("a1", scope);
    scope.allowed.push("beta");
    expect(agentSkillVisibilityFor("a1")?.allowed).toEqual(["alpha"]);
  });

  it("空 agentId 不落库（防止污染全局）", () => {
    const scope = resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] });
    registerAgentSkillVisibility("   ", scope);
    expect(agentSkillVisibilityFor("")).toBeUndefined();
  });
});

describe("P4-7 agentToolsOnly 与 skill 入口的职责边界", () => {
  const allNames = ["skill_search", "skill_lookup", "http_create_app", "mcp_git_status", "mcp_web_search"];

  it("profile.mcp 行为不变：仅 mcp_ 前缀受白名单约束", () => {
    expect(agentToolsOnly(DEFAULT_TOOL_PROFILE, () => allNames)).toEqual(["skill_search", "skill_lookup", "http_create_app"]);
    expect(agentToolsOnly({ mode: "custom", skills: [], mcp: ["git"] }, () => allNames))
      .toEqual(["skill_search", "skill_lookup", "http_create_app", "mcp_git_status"]);
  });

  it("skill 入口工具恒保留（否则模型连白名单都问不到）", () => {
    const out = agentToolsOnly({ mode: "custom", skills: [], mcp: [] }, () => allNames);
    expect(out).toContain("skill_search");
    expect(out).toContain("skill_lookup");
  });

  it("agentToolsOnly 不因 skills 为空而隐藏 skill 入口（可见性由 skill 可见域负责）", () => {
    const out = agentToolsOnly({ mode: "custom", skills: [], mcp: [] }, () => allNames);
    expect(isSkillEntryToolName("skill_search")).toBe(true);
    expect(isSkillEntryToolName("skill_lookup")).toBe(true);
    expect(isSkillEntryToolName("http_create_app")).toBe(false);
    expect(out).toHaveLength(allNames.filter((n) => !n.startsWith("mcp_")).length);
  });
});

function oneShotRouter(toolName: string, args: Record<string, unknown>): ModelRouter {
  let n = 0;
  return {
    chat: async () => {
      n += 1;
      const isFinal = n > 1;
      return {
        response: {
          choices: [{
            index: 0,
            message: isFinal
              ? { role: "assistant", content: "完成" }
              : { role: "assistant", content: "", tool_calls: [{ id: `t${n}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      };
    },
  } as unknown as ModelRouter;
}

async function runSkillTool(toolName: string, args: Record<string, unknown>, agentId: string): Promise<string> {
  const reg = new ToolRegistry();
  await loadAllSkills({ skillDir: dir, registry: reg });
  const loop = new ToolLoop({ router: oneShotRouter(toolName, args), registry: reg, sandbox: null });
  const r = await loop.run({
    agentId,
    agentName: "A",
    messages: [{ role: "user", content: "任务" }] as never,
    initialToolCalls: [],
  });
  const detail = r.roundLog.find((d) => d.name === toolName);
  if (!detail) {
    throw new Error(`工具 ${toolName} 未被执行，roundLog=${JSON.stringify(r.roundLog)}`);
  }
  return detail.result;
}

describe("P4-8 工具循环注入闭环：白名单真的挡住 skill 工具（而非只写进提示词）", () => {
  it("已注册白名单 ⇒ skill_search 搜不到清单外技能", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    registerAgentSkillVisibility("a1", resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] }));

    const raw = await runSkillTool("skill_search", { query: "浏览器" }, "a1");
    expect(raw).toContain("alpha");
    expect(raw).not.toContain("beta");
  });

  it("已注册白名单为 空 ⇒ skill_search 一个技能都搜不到", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    registerAgentSkillVisibility("a1", resolveSkillVisibilityScope({ mode: "custom", skills: [], mcp: [] }));

    const raw = await runSkillTool("skill_search", { query: "浏览器" }, "a1");
    expect(raw).not.toContain("alpha");
    expect(raw).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
  });

  it("已注册白名单 ⇒ skill_lookup 拒绝清单外技能并给出可执行原因", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\n---\n\n正文A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\n---\n\n正文B" });
    registerAgentSkillVisibility("a1", resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] }));

    const raw = await runSkillTool("skill_lookup", { name: "beta" }, "a1");
    expect(raw).toContain(SKILL_VISIBILITY_DENIED_PREFIX);
    expect(raw).toContain("不在你当前的白名单内");
    expect(raw).not.toContain("正文B");
  });

  it("未注册该 agentId ⇒ 不注入上下文 ⇒ 行为与改动前一致（不收紧）", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });

    const raw = await runSkillTool("skill_search", { query: "浏览器" }, "没注册过的agent");
    expect(raw).toContain("alpha");
    expect(raw).toContain("beta");
  });

  it("模型自己伪造 _skill_scope ⇒ 被循环覆盖，伪造无效", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    registerAgentSkillVisibility("a1", resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] }));

    const raw = await runSkillTool("skill_search", {
      query: "浏览器",
      _skill_scope: { constrained: false, allowed: ["*"] },
    }, "a1");
    expect(raw).toContain("alpha");
    expect(raw).not.toContain("beta");
  });

  it("模型伪造 JSON 字符串 _skill_scope ⇒ 同样被覆盖", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    registerAgentSkillVisibility("a1", resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] }));

    const raw = await runSkillTool("skill_search", {
      query: "浏览器",
      _skill_scope: JSON.stringify({ constrained: true, allowed: ["beta"] }),
    }, "a1");
    expect(raw).toContain("alpha");
    expect(raw).not.toContain("beta");
  });

  it("白名单只作用于对应 agentId，不串号", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 浏览器相关\n---\n\n# B" });
    registerAgentSkillVisibility("a1", resolveSkillVisibilityScope({ mode: "custom", skills: ["alpha"], mcp: [] }));

    expect(await runSkillTool("skill_search", { query: "浏览器" }, "a1")).not.toContain("beta");
    expect(await runSkillTool("skill_search", { query: "浏览器" }, "a2")).toContain("beta");
  });

  it("非 skill 入口工具不被注入 _skill_scope（不污染其它工具参数）", async () => {
    const reg = new ToolRegistry();
    let seen: Record<string, unknown> | null = null;
    reg.register(new Tool({
      name: "spy",
      description: "记录收到的参数",
      parameters: { type: "object", properties: {} },
      executeFn: async (a) => { seen = a; return "ok"; },
      permissions: ["read"],
    }));
    const loop = new ToolLoop({ router: oneShotRouter("spy", { x: 1 }), registry: reg, sandbox: null });
    await loop.run({ agentId: "a1", agentName: "A", messages: [{ role: "user", content: "任务" }] as never, initialToolCalls: [] });
    expect(seen).toEqual({ x: 1 });
  });
});