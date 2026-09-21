/**
 * tests/core-ts/skills.spec.ts — 技能引擎测试（对照 core/skill_engine.py 语义）。
 * 覆盖：真实 config/skills 加载（16 技能）/ frontmatter 回填 / manifest.yaml 解析 /
 * 指导模式调用 / 权限 fail-closed / search 评分 / skill_search/skill_lookup 工具注册 / symlink 拒绝。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry, parseMiniYaml, loadAllSkills, frontmatterDescription } from "../../core-ts/src/skills.js";
import { ToolRegistry } from "../../core-ts/src/tools/registry.js";

describe("parseMiniYaml", () => {
  it("标量/嵌套 map/列表/折叠续行/注释", () => {
    const data = parseMiniYaml(`name: banner-design
version: '1.0'
description: 'Design banners for social media,
  and print. Multi-line.'
permissions:
  read: true
  write: false
tags:
  - banner
  - design
empty_key:
`);
    expect(data.name).toBe("banner-design");
    expect(data.version).toBe("1.0");
    expect(data.description).toBe("Design banners for social media, and print. Multi-line.");
    expect((data.permissions as Record<string, unknown>).read).toBe(true);
    expect((data.permissions as Record<string, unknown>).write).toBe(false);
    expect(data.tags).toEqual(["banner", "design"]);
  });

  it("数字与布尔原样转换", () => {
    const d = parseMiniYaml("limit: 50\nenabled: true\nratio: 16:9");
    expect(d.limit).toBe(50);
    expect(d.enabled).toBe(true);
    expect(d.ratio).toBe("16:9");
  });

  it("块标量 `>`（折叠）：跨行折成空格连接的单行，块在缩进回退处结束", () => {
    const d = parseMiniYaml(`name: ponytail
description: >
  Forces the laziest solution that actually works, simplest, shortest, most
  minimal. Channels a senior dev who has seen everything: question whether the
  task needs to exist at all.
license: MIT
`);
    expect(d.name).toBe("ponytail");
    expect(d.description).toBe(
      "Forces the laziest solution that actually works, simplest, shortest, most minimal. "
      + "Channels a senior dev who has seen everything: question whether the task needs to exist at all.",
    );
    // 块后的同级键必须仍然是键，不能被吞进描述
    expect(d.license).toBe("MIT");
  });

  it("块标量 `|`（字面）：保留换行；chomping `-` 剥尾换行", () => {
    const lit = parseMiniYaml("body: |\n  line one\n  line two\nnext: 1\n");
    expect(lit.body).toBe("line one\nline two");
    expect(lit.next).toBe(1);
    const strip = parseMiniYaml("body: |-\n  only\nnext: 2\n");
    expect(strip.body).toBe("only");
    expect(strip.next).toBe(2);
  });

  it("frontmatterDescription：读 `>` 块标量描述并压成单行（GUI 技能库描述来源）", () => {
    const md = `---
name: ponytail
description: >
  Lazy but careful. Question whether the task
  needs to exist at all.
license: MIT
---

# Ponytail
`;
    expect(frontmatterDescription(md)).toBe(
      "Lazy but careful. Question whether the task needs to exist at all.",
    );
    // 首行分隔符 `---` 绝不能被当成描述（旧实现就是这样把描述读空的）
    expect(frontmatterDescription(md)).not.toBe("---");
  });

  it("frontmatterDescription：无 frontmatter / 未闭合（GUI 只读 4KB 截断）都不崩且不返回分隔符", () => {
    expect(frontmatterDescription("# Plain\n\n正文")).toBe("");
    expect(frontmatterDescription(`---\nname: t\ndescription: >\n  truncated mid desc`))
      .toBe("truncated mid desc");
    expect(frontmatterDescription("")).toBe("");
  });
});

describe("SkillRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skills-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSkill(name: string, files: Record<string, string>): Promise<void> {
    const d = join(dir, name);
    await mkdir(d, { recursive: true });
    for (const [f, content] of Object.entries(files)) {
      await writeFile(join(d, f), content, "utf8");
    }
  }

  it("真实 config/skills 全量加载（≥10 技能，banner-design 存在）", async () => {
    const reg = new SkillRegistry();
    const loaded = await reg.loadSkills();
    expect(loaded.length).toBeGreaterThanOrEqual(10);
    expect(reg.get("banner-design")).toBeDefined();
    expect(reg.isLoaded).toBe(true);
  });

  it("SKILL.md 仅 frontmatter（无 manifest）→ 零适配加载 + 描述回填", async () => {
    await writeSkill("front-only", {
      "SKILL.md": `---
name: front-only
description: 仅 frontmatter 的技能
tags: [alpha, beta]
---

# Front Only

正文指导内容。`,
    });
    const reg = new SkillRegistry({ skillDir: dir });
    const loaded = await reg.loadSkills();
    expect(loaded).toEqual(["front-only"]);
    const s = reg.get("front-only");
    expect(s?.description).toBe("仅 frontmatter 的技能");
    expect(s?.manifest.tags).toEqual(["alpha", "beta"]);
    expect(s?.body).toContain("正文指导内容");
  });

  it("manifest.yaml 优先级 > SKILL.md frontmatter", async () => {
    await writeSkill("mix", {
      "manifest.yaml": "name: mix\nversion: '2.0'\ndescription: manifest 描述\npermissions:\n  read: true\n",
      "SKILL.md": "---\nname: mix\n---\n\n# Mix 正文",
    });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    expect(reg.get("mix")?.description).toBe("manifest 描述");
    expect(reg.get("mix")?.manifest.version).toBe("2.0");
  });

  it("第三方风格技能（仅 SKILL.md + `>` 块标量描述）→ 描述可用且可被检索", async () => {
    await writeSkill("ponytail", {
      "SKILL.md": `---
name: ponytail
description: >
  Forces the laziest solution that actually works.
  Prefer the standard library over custom code.
---

# Ponytail
`,
    });
    const reg = new SkillRegistry({ skillDir: dir });
    expect(await reg.loadSkills()).toEqual(["ponytail"]);
    const s = reg.get("ponytail");
    // 旧实现会把字面量 ">" 当描述（parseMiniYaml 不认块标量）
    expect(s?.description).not.toBe(">");
    expect(s?.description).toContain("laziest solution");
    expect(s?.description).toContain("standard library");
  });

  it("指导模式调用：返回 [技能名 指导] 正文（A-038 纯读不拦权限）", async () => {
    await writeSkill("guide", {
      "manifest.yaml": "name: guide\npermissions:\n  network: true\n  read: true\n",
      "SKILL.md": "# Guide\n\n执行步骤……",
    });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    const r = await reg.callSkill("guide", {});
    expect(r).toContain("[技能 guide 指导]");
    expect(r).toContain("执行步骤……");
    expect(await reg.callSkill("nope", {})).toContain("[错误]");
  });

  it("A-038：指导模式不受权限拦截（fail-closed 仅约 executeFn；N11-P0-2 禁用自定义执行）", async () => {
    await writeSkill("needy", {
      "manifest.yaml": "name: needy\npermissions:\n  write: true\n  read: true\n",
      "SKILL.md": "# Needy\n\n正文",
    });
    await writeSkill("needy2", {
      "manifest.yaml": "name: needy2\npermissions:\n  network: true\n",
      "SKILL.md": "# Needy2\n\n正文",
    });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    // 无回调也能调用指导（A-038：指导模式纯读不拦）
    expect(await reg.callSkill("needy", {})).toContain("[技能 needy 指导]");
    expect(await reg.callSkill("nope", {})).toContain("[错误]");
    // 有审批回调：指导模式行为不变
    const reg2 = new SkillRegistry({ skillDir: dir, approvalCallback: () => true });
    await reg2.loadSkills();
    expect(await reg2.callSkill("needy2", {})).toContain("[技能 needy2 指导]");
  });

  it("skill.py 存在 → 警告 + 仅指导模式（N11-P0-2 禁用自定义执行）", async () => {
    await writeSkill("rce", {
      "manifest.yaml": "name: rce\npermissions:\n  read: true\n",
      "SKILL.md": "# RCE\n\n正文",
      "skill.py": "print('should not run')",
    });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    expect(reg.get("rce")?.executeFn).toBeUndefined();
    expect(await reg.callSkill("rce", {})).toContain("[技能 rce 指导]");
  });

  it("symlink 目录拒绝（N11-P0-3）", async () => {
    const outside = join(dir, "..", "outside-skill");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "# Out\n\n正文", "utf8");
    await symlink(outside, join(dir, "link-skill"), "junction").catch(() => undefined);
    const reg = new SkillRegistry({ skillDir: dir });
    const loaded = await reg.loadSkills();
    expect(loaded).not.toContain("link-skill");
    await rm(outside, { recursive: true, force: true });
  });

  it("search 评分：名称命中 > 描述/tags 命中；空查询返回全部", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# A" });
    await writeSkill("beta", { "SKILL.md": "---\nname: beta\ndescription: 数据处理\n---\n\n# B" });
    await writeSkill("gamma", { "SKILL.md": "---\nname: gamma\ndescription: 浏览器相关\n---\n\n# G" });
    const reg = new SkillRegistry({ skillDir: dir });
    await reg.loadSkills();
    const all = reg.search("", 10);
    expect(all).toHaveLength(3);
    const hits = reg.search("浏览器", 10);
    expect(hits.map((h) => h.name).sort()).toEqual(["alpha", "gamma"]);
    // limit 截断
    expect(reg.search("浏览器", 1)).toHaveLength(1);
  });

  it("loadAllSkills：注册 skill_search/skill_lookup 工具 + 调用闭环", async () => {
    await writeSkill("alpha", { "SKILL.md": "---\nname: alpha\ndescription: 浏览器工具\n---\n\n# Alpha\n\n正文内容" });
    const registry = new ToolRegistry();
    const loaded = await loadAllSkills({ skillDir: dir, registry });
    expect(loaded).toEqual(["alpha"]);
    expect(registry.get("skill_search")).toBeDefined();
    expect(registry.get("skill_lookup")).toBeDefined();
    const searchRes = await registry.callTool("skill_search", { query: "浏览器" });
    expect(searchRes).toContain("alpha");
    const lookupRes = await registry.callTool("skill_lookup", { name: "alpha" });
    expect(lookupRes).toContain("[技能 alpha 指导]");
    expect(await registry.callTool("skill_lookup", {})).toContain("[错误]");
  });
});