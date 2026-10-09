import { describe, expect, it } from "vitest";
import { agentSkillGuide, creatorGuide, DEFAULT_TOOL_PROFILE, selfAwarenessGuide, skillsRootDir } from "../../core-ts/src/services/agentTools.js";

/**
 * A-1196 ③ 能力自述 —— 截图场景回归（2026-10-06）。
 * 用户实测：默认模式的 Agent 被问「你能给自己写插件吗」时列了四个方向，
 * 唯独没提插件体系、也不知道自己的模式边界（只能瞎猜）。
 * 修法：所有模式都注入「能力边界」自述；默认模式明说「不能自建」+ 升级路径。
 */
describe("A-1196 ③ 能力自述（截图场景回归）", () => {
  const defaultProfile = { ...DEFAULT_TOOL_PROFILE };
  const creatorProfile = { mode: "creator" as const, skills: [], mcp: [] };

  it("默认模式：知道自己处于默认模式、不能自建插件、知道升级路径", () => {
    const g = agentSkillGuide(defaultProfile);
    expect(g).toContain("默认模式");
    expect(g).toContain("不能为自己新建插件");
    expect(g).toContain("Agent 管理");
    expect(g).toContain("创造模式");
  });

  it("默认模式：能力三机制必须提到「插件」（截图里它就漏了这个）", () => {
    const g = agentSkillGuide(defaultProfile);
    expect(g).toContain("插件（容器）");
    expect(g).toContain("plugin.json");
  });

  it("skills/mcp 全空（silam 的实际形态）：另一分支同样带上自述", () => {
    const g = agentSkillGuide({ mode: "default", skills: [], mcp: [] });
    expect(g).toContain("## 你的能力边界");
    expect(g).toContain("不能为自己新建插件");
    expect(g).toContain("Agent 管理");
  });

  it("创造模式：自述 + 完整创造指引都在", () => {
    const g = agentSkillGuide(creatorProfile);
    expect(g).toContain("## 你的能力边界");
    expect(g).toContain("被授权为自己创建插件");
    expect(g).toContain("### 二、写 plugin.json（最小模板）");
  });

  it("自述是模式感知的（两模式产物不同；同一产地 selfAwarenessGuide）", () => {
    expect(agentSkillGuide(defaultProfile)).toContain("## 你的能力边界");
    expect(selfAwarenessGuide(defaultProfile)).not.toBe(selfAwarenessGuide(creatorProfile));
    expect(selfAwarenessGuide(creatorProfile)).toContain("创造模式");
  });

  it("creatorGuide 覆盖 L2/L3 指导：工作模式固化 + loop_config（如实转述、不越权）", () => {
    const g = creatorGuide(skillsRootDir());
    expect(g).toContain("把重复的工作模式固化下来");
    expect(g).toContain("loop_config");
    expect(g).toContain("不要越权声称");
  });
});

/**
 * A-1197⑤ B1（L4b 设置贡献点）在**能力自述**里的回归。
 *
 * ## 为什么这里也要有守卫（而不是「只在创造模式导引里说」
 * 自述段落的职责是回答「我现在能做什么」。B1 落地后，创造模式的 Agent
 * 确实多了一项能力（能在插件清单里声明设置项），自述里若只字不提，
 * 它被问「你能给插件加设置项吗」时依然会答「不能」——
 * 与 A-1196 修的正是同一个病（能力没被告知 ⇒ 只能瞎猜）。
 *
 * ## 分工口径（不许两处都硬塞）
 * - **能做什么**（有哪些能力）⇒ 自述里说一句，指向创造模式导引；
 * - **怎么写 / 落在哪 / 什么会被拒**（怎么做）⇒ 只在创造模式导引里，默认模式不该看到。
 */
describe("A-1197⑤ 能力自述：B1 设置贡献点（只在创造模式那一支）", () => {
  const creator = selfAwarenessGuide({ mode: "creator", skills: [], mcp: [] });
  const def = selfAwarenessGuide({ ...DEFAULT_TOOL_PROFILE });

  it("创造模式：自述里必须出现 B1（声明设置项），否则被问就答「不能」", () => {
    expect(creator).toContain("声明设置项");
    expect(creator).toContain("contributes.settings");
    // 必须带边界，不能只吹「能声明」而不说落点
    expect(creator).toContain("只落在该插件自己的目录里");
    expect(creator).toContain("不改 slime 主配置");
  });

  it("创造模式：自述必须把详情指向创造模式导引（不许在自述里重开一份字段清单）", () => {
    expect(creator).toContain("完整步骤见下节「创造模式」");
    // 五种类型 / min-max 这类细节归导引，自述里不该复制一份（双产地漂移）
    expect(creator).not.toContain("min ≤ max");
    expect(creator).not.toContain("secret: true");
  });

  it("默认模式：不能说成自己能声明设置项（它连插件都不能建）", () => {
    expect(def).toContain("不能为自己新建插件");
    expect(def).not.toContain("contributes.settings");
    expect(def).not.toContain("声明设置项");
  });

  it("两支都不许出现承诺词（与创造模式导引同调）", () => {
    for (const bad of ["无缝", "即将支持", "即将上线"]) {
      expect(creator).not.toContain(bad);
      expect(def).not.toContain(bad);
    }
  });

  it("回归：自述原有两支的关键句没被改坏", () => {
    expect(def).toContain("不要含糊承诺");
    expect(def).toContain("也不要假装已具备");
    expect(creator).toContain("被授权为自己创建插件");
    // 「插件（容器）」这一句不能被 B1 文案挤掉
    expect(creator).toContain("插件（容器）");
  });
});
