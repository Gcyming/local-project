






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
    "  · `provides`：合法值只有 `instructions` / `tools` / `prompt` / `mode` 四个；**只贡献指令时只写 `instructions`**，",
    "      要额外贡献运行模式才加 `\"mode\"` 并写顶层 `mode` 字段（声明示例见「二·补 ④」）。",
    "      写 `tools` 或 `prompt` **不会被拒绝，但也不会生效** —— `provides` 这条路，桌面端目前不接受外部插件贡献工具（宿主钩子返回空），",
    "      装载后插件清单里那一项只会显示「尚未接线」，**不会真的多出任何工具**。",
    "      **不要因为清单里写了某个字段，就宣称自己多了工具能力** —— 那是无法兑现的承诺。",
    "      ⚠️ 但别把它读成「插件加不了工具」—— 加**工具能力**另有真路径：`contributes.scripts`（见本节「二·补 ②」），",
    "      它装配出来的才是真的可调用工具（同样要用户点「信任脚本」）。",
    "      确实需要新工具时，如实告诉用户两条路（由用户来开，不要假装已具备）：",
    "        ① 走 `contributes.scripts` 自带脚本（装完**提醒用户去「扩展」页点「信任脚本」**，否则工具不存在）；",
    "        ② 或在 设置 → Agent 管理 里调整工具配置 / 接入 MCP。",
    "      两条都不走却声称「我有新工具了」，同样是无法兑现的承诺。",
    "  · `contributes`：可选，**进界面 / 进工具表**的声明（与上面 `provides` 的「进上下文」是两回事：",
    "      `provides` 是无 UI 的资产贡献，`contributes.*` 是**由宿主渲染成 UI 或装配成工具**的贡献点）。",
    "      共四类、**都已落地可用**（各自的声明示例见本节「二·补」）：",
    "        `settings` —— 宿主在「扩展」页渲染一组设置项，值只落该插件自己的目录；",
    "        `ui`       —— UI 槽位（设置页 / 状态行 / 输入栏动作 / 工具条入口）；",
    "        `scripts`  —— 插件自带 .mjs 脚本，装配成可调用工具（需用户点「信任脚本」）；",
    "        `page`     —— 插件自有 HTML 页，右栏沙箱 iframe 打开。",
    "      下面先展开 `settings` 的完整形状与边界：",
    "      声明长这样（与 `provides` 同级）：",
    '      "contributes": {',
    '        "settings": [',
    '          { "key": "retries", "label": "重试次数", "type": "number", "min": 1, "max": 10, "default": 3 },',
    '          { "key": "token", "label": "访问令牌", "type": "string", "secret": true }',
    "        ]",
    "      }",
    "      每项：`key`（同插件内不得重复；只允许小写字母数字与 - _ . 作分隔）/ `label`（面板上显示的名字）/ `type`（必填）/ `hint`（可选说明）/ `default`（可选默认值，必须配得上该 type）。",
    "      `type` **只有五种**，各自的专属字段如下（专属字段挂到别的 type 上会被拒，不静默忽略）：",
    "        `boolean` 开关 —— 无专属字段",
    "        `string`  文本框 —— 无专属字段",
    "        `number`  数值框 —— `min` 与 `max` **都必填**（闭区间，且 min ≤ max）",
    "        `enum`    下拉框 —— `options` 必填且非空（候选字符串列表）",
    "        `path`    路径文本框 —— `root` 必填，且**只能**是 `plugin`（相对插件目录）或 `workspace`（相对会话工作目录）",
    "      令牌 / 密码这类加 `\"secret\": true`：只对 `string` / `enum` / `path` 有意义，**加密落盘**、",
    "      读回来只告知「是否已有值」，**不回显明文**；`secret: true` 时**不许**写 `default`（那等于把明文留在清单里）。",
    "      `path` 的取值还必须是纯相对路径（不含盘符、不以分隔符开头、不含 `..`）—— 想让插件读主配置位置，写不出来。",
    "      一个插件最多声明 32 项。",
    "      落点：值存在**这个插件自己的目录**里（插件目录下的 settings.json；`secret` 项落 settings.enc.json），",
    "      **不进** slime 主配置，也不影响别的插件。",
    "      路径**只由插件名推导**：写设置的入口只收「插件名 + 设置项 key + 值」，**根本没有「路径」这个参数** ——",
    "      所以「让界面或调用方指定落盘位置」在结构上就不成立，不靠事后校验拦。",
    "      校验是 **fail-closed**：字段名拼错、`type` 不在五种之内、出现未知字段、专属字段挂到错的 type 上，",
    "      ⇒ **整份 plugin.json 被拒**（插件不会装载），而不是「配了但没生效」。写完务必用 `plugin_status` 复核。",
    "      ⚠️ 边界：设置项**只影响该插件自己**。它**不等于**「插件能改 slime 的配置」——",
    "      想让用户改主配置或塞凭据进来，没有这条声明式路径，请如实告诉用户手动改。",
    "",
    "### 二·补：插件还能贡献什么（与 `contributes.settings` 同级；以下全部**已落地可用**）",
    "（共同红线：扩展**不能**贡献 JSX / CSS / 脚本注入宿主 —— 界面一律是「宿主实现的渲染器 + 你的声明」；",
    "  任何声明非法都会**整份拒绝装载**，写完务必 `plugin_status` 复核。）",
    "",
    "**① UI 槽位** `contributes.ui` —— 让宿主在界面上渲染你的入口（四个白名单槽位）：",
    '  { "slot": "settings_panel", "id": "panel", "title": "专属设置页" }        ← 设置弹窗里多一个页面',
    '  { "slot": "status_item",   "id": "count", "label": "计数", "refresh": "manual|on_event" } ← 右栏状态行',
    '  { "slot": "chat_action",   "id": "run",  "label": "用本扩展处理", "when": "可选说明" }    ← 输入栏动作钮',
    '  { "slot": "toolbar_item",  "id": "open", "label": "打开面板" }             ← 会话标题栏入口',
    "  规则：`id` 小写字母数字与 `-`；`settings_panel` 必填 `title`，其余必填 `label`；",
    "  **`toolbar_item` 必须同时声明 `contributes.page`**（它的唯一用途就是打开你的页面，没有 page 就是假按钮）。",
    "",
    "**② 脚本工具** `contributes.scripts` —— 插件自带的 .mjs 脚本被装配成**可调用工具**（每个脚本一个工具）：",
    '  { "name": "hello", "entry": "tools/hello.mjs", "description": "何时用（模型据此判断）" }',
    "  `entry` 必须是**纯相对路径**（不许盘符 / `..` / 以分隔符开头）。执行边界（宿主保证，如实转述）：",
    "  一次性子进程、`cwd` 限定在插件目录、30s 超时、输出上限 256KB；脚本读 **stdin** 的 JSON（`{prompt}`）、",
    "  写 **stdout** 作为工具结果；**拿不到任何宿主对象**（沙箱是结构性的，不靠自觉）。",
    "  ⚠️⚠️ **必须由用户**在「扩展」页该插件卡片上点「**信任脚本**」（落 trust.json）**才会装配**——",
    "  默认**拒绝**；你写完脚本后要**主动提示用户去点这个开关**，在此之前工具**不存在**（别假装已可用）。",
    "",
    "**③ 自有页面** `contributes.page` —— 一个 HTML 页，从会话标题栏的工具条入口在右栏打开：",
    '  { "kind": "html", "entry": "panel.html" }   ← kind 目前只认 "html"（webview 形态暂未开放）',
    "  页面经 127.0.0.1 静态服务加载（**不是** file://），在**沙箱 iframe** 里显示——",
    "  页面里可以跑你自己的 JS 与 fetch 同服务的资源，但**碰不到宿主**（跨源隔离）。",
    "",
    "**④ 运行模式（阶段机）** `provides: [\"mode\"]` + 顶层 `mode` 字段 —— 用户可在会话顶「运行模式」下拉选中：",
    '  "mode": { "kind": "stages", "stages": [',
    '    { "id": "survey", "title": "调研", "prompt": "只读调研…", "tools": ["file_read"], "maxRounds": 8 },',
    '    { "id": "plan",   "title": "方案", "prompt": "产出方案…", "requirePrevious": "survey" } ] }',
    "  规则：阶段 1–8 个；`prompt` ≤4000 字；`requirePrevious` 只能指**前面**的阶段；`maxRounds` 1–500；",
    "  `tools` 里的名字必须**真实存在**于当前工具表：**装载时查一次**（查不到 ⇒ 该插件被拒绝装载），",
    "  运行前每阶段还会重查（工具被停用 ⇒ 该阶段不执行，并在对话里如实说明 —— 不静默跳过）。",
    "  选中后：按阶段逐段执行、阶段间只带上一阶段结论（上下文自动裁剪）、进度在对话里逐段显示；",
    "  用户切模式要确认（会丢弃当前阶段上下文）；扩展被停用 ⇒ 会话自动回落默认模式（如实播报）。",
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
 *  因为它从未被告知 slime 的能力架构与自己的模式边界（只能瞎猜）。
 *  ⚠️ 2026-10-08（B2–B6 落地后同步）：插件**能贡献的东西已经扩展**（设置项 / UI 槽位 / 脚本工具 /
 *  自有页面 / 运行模式）——本函数与 `creatorGuide` 必须**同步涵盖**，否则 Agent 又"不知道自己有能力"。 */
export function selfAwarenessGuide(profile: ToolProfile): string {
  const isCreator = profile.mode === "creator";
  return [
    "",
    "## 你的能力边界（自我认知 —— 别猜，照实说）",
    "你运行在 slime（桌面多 Agent 应用）里。给 slime 扩展能力有三条路：",
    "  ① 技能（instructions，指令层）：Markdown 指导，放技能目录、按需加载正文；",
    "  ② MCP（工具的一种来源）：外部服务提供的工具，注册进工具表；",
    "  ③ 插件（容器）：一份 plugin.json + 贡献，是 slime 里**能力最全**的扩展形态。能贡献的东西（**全部已落地可用**）：",
    "      · 技能 —— Markdown 指令资产（SKILL.md），按需加载正文；",
    "      · 设置项 —— 宿主在「扩展」页渲染成 UI；值只落在该插件自己的目录里，**不改 slime 主配置**；",
    "      · UI 槽位 —— 四个白名单槽位：设置页 / 状态行 / 输入栏动作 / 工具条入口；",
    "      · 脚本工具 —— 插件自带 .mjs 脚本装配成**可调用工具**（**要用户点「信任脚本」才会装**，默认拒绝，别以为写了就有）；",
    "      · 自有页面 —— 一个 HTML 页，经 127.0.0.1 静态服务显示在右栏沙箱里（碰不到宿主）；",
    "      · 运行模式 —— 阶段机：用户在会话顶选中后，按声明的阶段清单逐段执行（每段可限工具白名单与轮次）。",
    "",
    "  扩展的定位（用户口径）：是**外部武装 / 精装** —— 可开可关、可停用可卸载；装着就有、卸了就恢复原样。",
    "  **它不改动 slime 程序本身**（不存在「改源码 / 改内核」这条路）：新能力一律走上列六类贡献点、",
    "  落在**外部插件目录**里。不要把「高自由度」说成改程序 —— 如实告诉用户「能力以可开可关的外部插件形态提供」。",
    isCreator
      ? "你当前处于**创造模式**：被授权为自己创建插件（完整步骤见下节「创造模式」，各贡献点的声明示例也在那里：" +
        "声明设置项（`contributes.settings`）、UI 槽位（`contributes.ui`）、脚本工具（`contributes.scripts`）、" +
        "自有页面（`contributes.page`）、运行模式（`provides: [\"mode\"]`））。" +
        "**若当前场景没有「创造模式」一节（如只在群聊里发言），照上面这份清单如实说明即可 —— 不要编造步骤**。" +
        "建完后用 `plugin_status` 自验装载；脚本 / 页面类贡献要提醒用户去「扩展」页点信任 / 查看。"
      : profile.mode === "custom"
        ? "你当前处于**自定义模式**（技能 / MCP 清单由用户在 Agent 管理里定制）：同样不能为自己新建插件；也无法通过自建技能扩展自己。" +
          "想让 slime 获得新能力：如实告诉用户「到 设置 → Agent 管理，把我的工具配置切换为『创造模式』」——不要含糊承诺，也不要假装已具备。"
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