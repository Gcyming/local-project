






import { join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";















export type ToolProfileMode = "default" | "creator" | "custom";

export interface ToolProfile {
  mode: ToolProfileMode;
  
  skills: string[];
  
  mcp: string[];
}



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


export function resolveAgentToolProfile(profile?: ToolProfile): ToolProfile {
  if (profile && profile.mode === "custom") {
    return {
      mode: "custom",
      skills: Array.isArray(profile.skills) ? profile.skills.slice() : [],
      mcp: Array.isArray(profile.mcp) ? profile.mcp.slice() : [],
    };
  }
  
  
  
  if (profile && profile.mode === "creator") {
    return { mode: "creator", skills: DEFAULT_TOOL_PROFILE.skills.slice(), mcp: DEFAULT_TOOL_PROFILE.mcp.slice() };
  }
  return { mode: "default", skills: DEFAULT_TOOL_PROFILE.skills.slice(), mcp: DEFAULT_TOOL_PROFILE.mcp.slice() };
}







export function agentToolsOnly(profile: ToolProfile, listToolNames: () => string[]): string[] {
  const allowedMcp = profile.mcp;
  return listToolNames().filter((name) => {
    if (!name.startsWith("mcp_")) {
      return true; 
    }
    return allowedMcp.some((server) => {
      const prefix = `mcp_${server}`;
      return name === prefix || name.startsWith(`${prefix}_`);
    });
  });
}













export function skillsRootDir(): string {
  return join(PROJECT_ROOT, "config", "skills");
}







export function creatorGuide(root: string): string {
  return [
    "",
    "## 创造模式（你被授权为自己创建技能）",
    "现有技能覆盖不了当前任务时，**你可以直接给自己造一个技能并使用它**，不必等用户手动安装。",
    "",
    `新增：在 ${root}\\<技能名>\\SKILL.md 写入，frontmatter 必须含 name / description / origin：`,
    "  · `name`：小写 ASCII + `-`，≤48 字符（同时是目录名）",
    "  · `description`：**本模式最重要的字段** —— 模型只凭它决定是否触发该技能。",
    "    要写「何时用」，不要写「这是什么」。",
    "      反例：`处理图片` —— 任何图片任务都不确定该不该触发它",
    "      正例：`把 PNG 批量转 WebP 并保留 EXIF，用于站点资源瘦身`",
    "  · `origin: agent`：声明这是 Agent 自建（插件页据此分类展示）",
    "",
    "落位后**必须自验**，三步都过才算完成：",
    "  1. `skill_search` 复核能被检索到 —— 注意这一步只证明「存在」，**不证明「可用」**",
    "  2. 用一段真实输入**实跑一次**，确认产出符合预期",
    "  3. 实跑失败就修好再验；连修 3 次仍失败则**删除该技能**并如实告知用户，不留半成品",
    "",
    "安全红线（违反即视为错误）：",
    "  · **不得修改权限与沙箱配置**（`slime.toml`、`core/permissions.py`、`config/gui_permissions.json` 等）",
    "    —— Agent 自建的插件不得能改自己的权限。",
    "  · 不得创建会执行用户未明确要求的网络请求或文件删除的技能。",
    "  · description 与正文中不得出现零宽 / 不可见 Unicode 字符（可用于投毒且肉眼不可见）。",
  ].join("\n");
}

export function agentSkillGuide(profile: ToolProfile): string {
  const root = skillsRootDir();
  
  const installHint = [
    `技能目录（绝对路径）：${root}`,
    `新增技能：在 ${root}\\<技能名>\\ 下写 SKILL.md（必须），frontmatter 至少含 name 与 description；manifest.yaml 可选。`,
    "⚠️ 不要写到源码仓库或其它路径 —— 那只会有文件、技能库读不到（slime 读的是上面这个目录）。写入后用 skill_search 复核是否已能被检索到。",
  ].join("\n");
  
  const creator = profile.mode === "creator" ? creatorGuide(root) : "";
  if (profile.skills.length === 0 && profile.mcp.length === 0) {
    return "\n\n## 工具能力（白名单）\n当前未启用任何外部技能与 MCP，仅可使用内置核心工具。如需扩展能力，请在 Agent 管理中调整工具配置。\n"
      + installHint + creator;
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
    "",
    installHint,
  ].join("\n") + creator;
}