






import { join, resolve } from "node:path";
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







export const SKILL_ENTRY_TOOL_NAMES = ["skill_search", "skill_lookup"] as const;

const SKILL_ENTRY_TOOL_SET: ReadonlySet<string> = new Set(SKILL_ENTRY_TOOL_NAMES);

export function isSkillEntryToolName(name: string): boolean {
  return SKILL_ENTRY_TOOL_SET.has(name);
}

/** A-1195（交接欠账 A2）：创造模式专用管控工具 —— 只读、只在 creator 工具面可见。
 *  裁决依据（docs/plugin-ecosystem-survey.md）：同工具面 + 少量专用**管控**工具；
 *  不给「通用创造工具」（已启用工具的描述每轮都占 token，多挂是坏实践）。 */
export const CREATOR_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["plugin_status"]);

export function agentToolsOnly(profile: ToolProfile, listToolNames: () => string[]): string[] {
  const allowedMcp = profile.mcp;
  return listToolNames().filter((name) => {
    if (CREATOR_ONLY_TOOL_NAMES.has(name)) {
      return profile.mode === "creator";
    }
    if (!name.startsWith("mcp_")) {
      return true;
    }
    return allowedMcp.some((server) => {
      const prefix = `mcp_${server}`;
      return name === prefix || name.startsWith(`${prefix}_`);
    });
  });
}

export interface SkillVisibilityScope {
  constrained: boolean;
  allowed: string[];
  allowAgentAuthored: boolean;
}

export const UNRESTRICTED_SKILL_VISIBILITY: SkillVisibilityScope = {
  constrained: false,
  allowed: [],
  allowAgentAuthored: false,
};

export function resolveSkillVisibilityScope(profile?: ToolProfile | null): SkillVisibilityScope {
  if (profile === undefined || profile === null) {
    return { ...UNRESTRICTED_SKILL_VISIBILITY };
  }
  if (typeof profile !== "object" || Array.isArray(profile)) {
    return { constrained: true, allowed: [], allowAgentAuthored: false };
  }
  const resolved = resolveAgentToolProfile(profile);
  const allowed = resolved.skills
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length > 0);
  return {
    constrained: true,
    allowed,
    allowAgentAuthored: resolved.mode === "creator",
  };
}

export function isSkillNameVisible(name: string, scope: SkillVisibilityScope, isAgentAuthored = false): boolean {
  const n = String(name ?? "").trim();
  if (n.length === 0) { return false; }
  if (!scope.constrained) { return true; }
  if (scope.allowed.includes(n)) { return true; }
  return scope.allowAgentAuthored && isAgentAuthored;
}

const AGENT_SKILL_SCOPES = new Map<string, SkillVisibilityScope>();

export function registerAgentSkillVisibility(agentId: string, scope: SkillVisibilityScope): void {
  const id = String(agentId ?? "").trim();
  if (!id) { return; }
  AGENT_SKILL_SCOPES.set(id, {
    constrained: scope.constrained,
    allowed: [...scope.allowed],
    allowAgentAuthored: scope.allowAgentAuthored,
  });
}

export function agentSkillVisibilityFor(agentId: string | undefined): SkillVisibilityScope | undefined {
  const id = String(agentId ?? "").trim();
  if (!id) { return undefined; }
  return AGENT_SKILL_SCOPES.get(id);
}

export function resetAgentSkillVisibility(): void {
  AGENT_SKILL_SCOPES.clear();
}













export function skillsRootDir(): string {
  return join(PROJECT_ROOT, "config", "skills");
}







export function creatorGuide(root: string): string {
  const pluginRoot = resolve(root, "..", "plugins");
  return [
    "",
    "## 创造模式（你被授权为自己创建插件）",
    "现有技能与扩展覆盖不了当前任务时，**你可以直接给自己造一个插件并使用它**，不必等用户手动安装。",
    "",
    "### 一、插件是什么形状",
    "插件是**一个目录 + 一份清单**：",
    `  ${root}\\<插件名>\\        ← 指令贡献（技能）在这里`,
    `  ${pluginRoot}\\<插件名>\\   ← 插件目录，**必须含 plugin.json**`,
    "    plugin.json      ← 清单（必须，字段见下）",
    "    skills/          ← 贡献「指令」：放 SKILL.md",
    "",
    "### 二、写 plugin.json（最小模板）",
    "{",
    '  "name": "kebab-case-与目录同名",',
    '  "version": "1.0.0",',
    '  "description": "何时用（模型据此判断，不是「这是什么」）",',
    '  "origin": "agent",',
    '  "provides": ["instructions"]',
    "}",
    "",
    "字段要点：",
    "  · `name`：小写 ASCII + `-`，**必须与插件目录名完全一致**，不一致会被拒绝装载",
    "  · `description`：**最重要的字段** —— 模型只凭它决定是否触发。要写「何时用」，不要写「这是什么」。",
    "      反例：`处理图片` —— 任何图片任务都不确定该不该触发它",
    "      正例：`把 PNG 批量转 WebP 并保留 EXIF，用于站点资源瘦身`",
    "  · `origin`：如实写 `agent`。**绝不能写 `builtin`** —— 那是系统保留值，磁盘清单写 builtin 会被直接拒绝",
    "  · `provides`：本模式写 `[\"instructions\"]`；将来要贡献工具再加 `tools`",
    "",
    "### 三、写指令正文",
    "provides 含 instructions 时，在 " + `${root}\\<插件名>\\SKILL.md` + " 写入，frontmatter 至少含 name 与 description，",
    "让模型一眼能判断何时加载正文。",
    "",
    "### 四、落位后必须自验，四步都过才算完成",
    "  1. `plugin_status` 复核插件**真的被装载**（出现在清单里且 status=loaded）—— 文件存在不等于装载成功；",
    "     没出现或 failed 就检查形状（名字与目录同名、origin=agent、plugin.json 合法），修好后请用户重载插件再查",
    "  2. `skill_search` 复核技能能被检索到 —— 注意这一步只证明「存在」，**不证明「可用」**",
    "  3. 用一段真实输入**实跑一次**，确认产出符合预期",
    "  4. 实跑失败就修好再验；连修 3 次仍失败则**删除该插件**（含 plugin.json 与 SKILL.md）并如实告知用户，不留半成品",
    "",
    "### 五、把重复的工作模式固化下来（创造模式的一半价值在这里）",
    "用户反复要同一类任务时，不要每次从零指挥 —— **把套路固化成资产**：",
    "  · 固定流程 / 规范 → 写成技能（SKILL.md），下次直接加载，别在对话里重复交代；",
    "  · 固定的输出形态（模板、检查清单、字段规范）→ 放进技能正文，让产物一次成型；",
    "  · 固定的分工（谁调研、谁写、谁验收）→ 用 delegate_subagent 沿用同一套角色划分。",
    "",
    "### 六、Agent-Loop 的节奏可按 Agent 定制（如实转述，不要越权声称）",
    "循环预算在 agents.json（config/agents.json）里该 Agent 的 loop_config 字段，例如：",
    "  { \"maxRounds\": 60, \"maxToolCalls\": 500, \"maxTotalTokens\": 5000000, \"maxWallClockMs\": 3600000 }",
    "字段都可省略（省略即用默认）；只认正数，超上限会被封顶。**你自己没有改这个文件的权限** ——",
    "用户想调整工作量/时间上限时，把上面的形状和字段含义如实告诉他，由用户来改。",
    "",
    "安全红线（违反即视为错误）：",
    "  · **不得修改权限与沙箱配置**（`slime.toml`、`core/permissions.py`、`config/gui_permissions.json` 等）",
    "    —— Agent 自建的插件不得能改自己的权限。",
    "  · 不得创建会执行用户未明确要求的网络请求或文件删除的插件。",
    "  · `description` 与正文中不得出现零宽 / 不可见 Unicode 字符（可用于投毒且肉眼不可见，装载时会被拒绝）。",
    "  · `origin` 必须如实写 `agent`，禁止写 `builtin`（系统保留值，写了也装不进去）。",
  ].join("\n");
}

/** A-1196：能力自述 —— 每个 Agent 都必须知道「slime 是怎么扩展能力的」以及「自己当前能扩展什么」。
 *  用户实测（2026-10-06 截图）：默认模式的 Agent 被问「你能给自己写插件吗」时，
 *  列了「自定义技能 / MCP / 接入项目 / 其它」四个方向——**唯独没提插件体系**，
 *  因为它从未被告知 slime 的能力架构与自己的模式边界（只能瞎猜）。 */
export function selfAwarenessGuide(profile: ToolProfile): string {
  const isCreator = profile.mode === "creator";
  return [
    "",
    "## 你的能力边界（自我认知 —— 别猜，照实说）",
    "你运行在 slime（桌面多 Agent 应用）里。给 slime 扩展能力有三种机制：",
    "  ① 技能（instructions，指令层）：Markdown 指导，放技能目录、按需加载正文；",
    "  ② MCP（工具的一种来源）：外部服务提供的工具，注册进工具表；",
    "  ③ 插件（容器）：一份 plugin.json + 贡献（技能/工具），是①②的装配容器，可在「扩展」页启停。",
    isCreator
      ? "你当前处于**创造模式**：被授权为自己创建插件（完整步骤见下节「创造模式」）。"
      : "你当前处于**默认模式**：不能为自己新建插件；也无法通过自建技能扩展自己（自建技能仅在创造模式下对你可见）。" +
        "想让 slime 获得新能力：如实告诉用户「到 设置 → Agent 管理，把我的工具配置切换为『创造模式』」——不要含糊承诺，也不要假装已具备。",
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
  const awareness = selfAwarenessGuide(profile);
  if (profile.skills.length === 0 && profile.mcp.length === 0) {
    return "\n\n## 工具能力（白名单）\n当前未启用任何外部技能与 MCP，仅可使用内置核心工具。如需扩展能力，请在 Agent 管理中调整工具配置。\n"
      + installHint + awareness + creator;
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
  ].join("\n") + awareness + creator;
}