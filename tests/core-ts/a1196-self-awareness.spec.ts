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
