/**
 * tests/core-ts/agent-tools.spec.ts — A-980-R22：Agent 工具面白名单纯函数锚定
 * （默认推荐集 / 自定义勾选 / mcp_ 工具前缀过滤 / 系统提示技能清单）
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  DEFAULT_TOOL_PROFILE,
  resolveAgentToolProfile,
  agentToolsOnly,
  agentSkillGuide,
  skillsRootDir,
  type ToolProfile,
} from "../../core-ts/src/services/agentTools.js";

describe("resolveAgentToolProfile", () => {
  it("缺省/默认模式 → 内置推荐集（default）", () => {
    const p = resolveAgentToolProfile(undefined);
    expect(p.mode).toBe("default");
    expect(p.skills).toEqual(DEFAULT_TOOL_PROFILE.skills);
    expect(p.mcp).toEqual([]);
    expect(resolveAgentToolProfile({ mode: "default", skills: [], mcp: [] }).mode).toBe("default");
  });

  it("custom 模式 → 用户勾选列表（复制而非引用）", () => {
    const src: ToolProfile = { mode: "custom", skills: ["foo", "bar"], mcp: ["git", "web"] };
    const p = resolveAgentToolProfile(src);
    expect(p.mode).toBe("custom");
    expect(p.skills).toEqual(["foo", "bar"]);
    expect(p.mcp).toEqual(["git", "web"]);
    p.skills.push("baz"); // 不污染源
    expect(src.skills).toEqual(["foo", "bar"]);
  });

  it("custom 且字段缺失 → 空名单（用户自行选择了就要全勾）", () => {
    const p = resolveAgentToolProfile({ mode: "custom", skills: [] as string[], mcp: undefined as unknown as string[] });
    expect(p.skills).toEqual([]);
    expect(p.mcp).toEqual([]);
  });
});

describe("agentToolsOnly", () => {
  const allNames = ["skill_search", "skill_lookup", "http_create_app", "adb_connect", "mcp_git_status", "mcp_git_commit", "mcp_web_search", "mcp_web_fetch"];

  it("内置工具 + skill 入口恒保留（default 推荐集无 MCP → mcp_ 全过滤）", () => {
    const out = agentToolsOnly(DEFAULT_TOOL_PROFILE, () => allNames);
    expect(out).toEqual(["skill_search", "skill_lookup", "http_create_app", "adb_connect"]);
  });

  it("custom：mcp 服务器前缀白名单（mcp_<server>_* 命中，未勾选过滤）", () => {
    const out = agentToolsOnly({ mode: "custom", skills: [], mcp: ["git"] }, () => allNames);
    expect(out).toEqual(["skill_search", "skill_lookup", "http_create_app", "adb_connect", "mcp_git_status", "mcp_git_commit"]);
    expect(out).not.toContain("mcp_web_search");
  });

  it("custom：服务器自身也保留（mcp_<server> 无后缀形态）", () => {
    const out = agentToolsOnly({ mode: "custom", skills: [], mcp: ["web"] }, () => ["mcp_web", "mcp_web_search"]);
    expect(out).toContain("mcp_web");
    expect(out).toContain("mcp_web_search");
  });
});

describe("agentSkillGuide", () => {
  it("空名单 → 明确提示仅内置核心工具", () => {
    const g = agentSkillGuide({ mode: "custom", skills: [], mcp: [] });
    expect(g).toContain("未启用任何外部技能与 MCP");
    expect(g).toContain("内置核心工具");
  });

  it("default/custom 有内容 → 列表引导模型只用清单内能力", () => {
    const g = agentSkillGuide({ mode: "custom", skills: ["foo"], mcp: ["git"] });
    expect(g).toContain("- foo");
    expect(g).toContain("git（mcp_git_* 系列工具）");
    expect(g).toContain("仅清单内的能力视为可用");
  });

  it("必须下发技能目录的**绝对路径**（否则 Agent 自己猜路径 → 写成功但技能库读不到）", () => {
    /*
     * 事故形态：用户让 Agent「帮我装个技能」，Agent 把 SKILL.md 写进了**源码仓库**
     * （E:\local project\slime\config\skills），而打包版读取的是用户数据目录
     * （%APPDATA%/slime-gui/slime-data/config/skills）。
     * 两侧都不报错 —— 文件真的写成功了，只是技能库永远看不到它。
     * 根因：系统提示里只有相对写法 "config/skills"，没有绝对路径，模型只能自己推断。
     */
    const root = skillsRootDir();
    expect(root.endsWith(join("config", "skills"))).toBe(true);
    // 必须是绝对路径（模型据此落盘）
    expect(root).toMatch(/^[A-Za-z]:[\\/]|^\//);

    // 两种分支都要带上，否则「未启用任何技能」的 Agent 依旧会去瞎猜路径
    for (const profile of [
      { mode: "custom" as const, skills: [], mcp: [] },
      { mode: "custom" as const, skills: ["foo"], mcp: [] },
    ]) {
      const g = agentSkillGuide(profile);
      expect(g).toContain(root);
      expect(g).toContain("SKILL.md");
      // 必须明确劝阻写到别处
      expect(g).toContain("不要写到源码仓库");
    }
  });
});