/**
 * core-ts/src/services/agentTools.ts — Agent 工具面白名单（A-980-R22：定制 Agent 能力）。
 * - skill 与 MCP 全局共用 → Agent 创建时可选「默认推荐集 / 自定义勾选」，运行时按白名单注入工具面
 * - mode=default：内置推荐集（体验向技能；MCP 默认不启用，安全/成本保守）
 * - mode=custom：用户显式勾选的 skills（技能名）与 mcp（服务器名）白名单
 */

export type ToolProfileMode = "default" | "custom";

export interface ToolProfile {
  mode: ToolProfileMode;
  /** 启用的技能名（skillList 的 name；mode=default 时忽略，用内置推荐集） */
  skills: string[];
  /** 启用的 MCP 服务器名（McpServerInfo.name；mode=default 时忽略）——运行时按 mcp_<server>_* 前缀匹配工具 */
  mcp: string[];
}

/** 内置推荐集：通用体验向技能（从 config/skills 现有技能中精选，低重资源/低风险）；
 *  第三方 MCP 默认不启用（安全面收敛，需时在自定义里勾选） */
export const DEFAULT_TOOL_PROFILE: ToolProfile = {
  mode: "default",
  skills: [
    "google-search-serp",
    "webcrawler-deep-crawl",
    "prompt-optimizer",
    "market-research",
    "banner-design",
    "ios-icon-gen",
  ],
  mcp: [],
};

/** 解析 Agent 实际生效的工具概况（default/缺失 → 内置推荐集；custom → 用户勾选） */
export function resolveAgentToolProfile(profile?: ToolProfile): ToolProfile {
  if (profile && profile.mode === "custom") {
    return {
      mode: "custom",
      skills: Array.isArray(profile.skills) ? profile.skills.slice() : [],
      mcp: Array.isArray(profile.mcp) ? profile.mcp.slice() : [],
    };
  }
  return { mode: "default", skills: DEFAULT_TOOL_PROFILE.skills.slice(), mcp: DEFAULT_TOOL_PROFILE.mcp.slice() };
}

/**
 * 按 Agent 概况生成工具名下发白名单（toolsOnly 语义）：
 * - 内置工具（非 mcp_*、非技能入口）始终保留；
 * - skill_search / skill_lookup 保留（技能入口；可用范围由系统提示的清单约束）；
 * - mcp_<server>_* 工具仅当 server 命中白名单 mcp 时保留。
 */
export function agentToolsOnly(profile: ToolProfile, listToolNames: () => string[]): string[] {
  const allowedMcp = profile.mcp;
  return listToolNames().filter((name) => {
    if (!name.startsWith("mcp_")) {
      return true; // 内置工具 + skill 入口全保留
    }
    return allowedMcp.some((server) => {
      const prefix = `mcp_${server}`;
      return name === prefix || name.startsWith(`${prefix}_`);
    });
  });
}

/** 追加进系统提示的技能清单（让模型只把已启用技能当作可用能力） */
export function agentSkillGuide(profile: ToolProfile): string {
  if (profile.skills.length === 0 && profile.mcp.length === 0) {
    return "\n\n## 工具能力（白名单）\n当前未启用任何外部技能与 MCP，仅可使用内置核心工具。如需扩展能力，请在 Agent 管理中调整工具配置。";
  }
  const skillLines = profile.skills.length > 0
    ? profile.skills.map((s) => `- ${s}`).join("\n")
    : "（未启用）";
  const mcpLines = profile.mcp.length > 0
    ? profile.mcp.map((s) => `- ${s}（mcp_${s}_* 系列工具）`).join("\n")
    : "（未启用）";
  return [
    "",
    "## 工具能力（白名单）",
    "你当前启用的技能：",
    skillLines,
    "你当前启用的 MCP：",
    mcpLines,
    "仅清单内的能力视为可用；如需清单外能力，向用户说明或请其在 Agent 管理中调整工具配置。",
  ].join("\n");
}