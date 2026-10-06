import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentToolsOnly, creatorGuide, DEFAULT_TOOL_PROFILE, skillsRootDir } from "../../core-ts/src/services/agentTools.js";
import { getRegistry, resetRegistry } from "../../core-ts/src/tools/registry.js";
import { registerBuiltinTools, setPluginCatalog } from "../../core-ts/src/tools/builtin.js";

/**
 * A-1195（交接欠账 A2）：creator 模式落地的「少量专用管控工具」。
 *
 * 裁决依据（docs/plugin-ecosystem-survey.md，DSH 对照）：同工具面 + 少量**只读**管控工具
 * + 更强的指导文本；不给通用创造工具（已启用工具的描述每轮都占 token）。
 * 本组钉住：plugin_status 只进 creator 工具面；行为如实（未接线/抛错都不假装）；
 * creatorGuide 的自验步骤引用它。
 */

const CATALOG_NAMES = ["file_read", "plugin_status", "mcp_git_status"];

afterEach(() => {
  resetRegistry();
  setPluginCatalog(null);
});

describe("A-1195 A2：plugin_status 的可见性（creator-only）", () => {
  it("creator 工具面含 plugin_status", () => {
    const out = agentToolsOnly({ mode: "creator", skills: [], mcp: [] }, () => CATALOG_NAMES);
    expect(out).toContain("plugin_status");
    expect(out).toContain("file_read");
  });

  it("default / custom 工具面不含（专用管控工具不占其他模式的上下文）", () => {
    expect(agentToolsOnly(DEFAULT_TOOL_PROFILE, () => CATALOG_NAMES)).not.toContain("plugin_status");
    expect(agentToolsOnly({ mode: "custom", skills: [], mcp: [] }, () => CATALOG_NAMES)).not.toContain("plugin_status");
  });
});

describe("A-1195 A2：plugin_status 的行为（如实）", () => {
  beforeEach(() => {
    resetRegistry();
    registerBuiltinTools();
  });

  it("未接线：如实提示「尚未接线」，不假装空清单", async () => {
    setPluginCatalog(null);
    const out = await getRegistry().get("plugin_status")!.executeFn({});
    expect(out).toContain("尚未接线");
  });

  it("已接线：列出条目（status / origin / 贡献）", async () => {
    setPluginCatalog(() => [
      {
        name: "my-helper",
        version: "1.0.0",
        origin: "agent",
        status: "loaded",
        contributions: ["instructions:my-helper 的技能"],
        unloadable: true,
      },
    ]);
    const out = await getRegistry().get("plugin_status")!.executeFn({});
    expect(out).toContain("my-helper@1.0.0");
    expect(out).toContain("[loaded]");
    expect(out).toContain("origin=agent");
    expect(out).toContain("instructions:my-helper 的技能");
    expect(out).toContain("创造模式自验");
  });

  it("宿主查询抛错：如实报错（不静默成空）", async () => {
    setPluginCatalog(() => { throw new Error("boom"); });
    const out = await getRegistry().get("plugin_status")!.executeFn({});
    expect(out).toContain("[错误]");
    expect(out).toContain("boom");
  });
});

describe("A-1195 A2：creatorGuide 的自验引用", () => {
  it("自验步骤引用 plugin_status 且为四步", () => {
    const guide = creatorGuide(skillsRootDir());
    expect(guide).toContain("plugin_status");
    expect(guide).toContain("四步");
    expect(guide).toContain("文件存在不等于装载成功");
  });
});
