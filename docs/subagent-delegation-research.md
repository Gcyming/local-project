# 子代理派发机制设计基准（一手来源调研）

> 调研时间：2026-09-25
> 方法：优先官方文档 / 官方博客 / 官方源码逆向 / 学术论文。
> 每条结论均标注来源链接，并标注证据性质：**[一手官方]**、**[官方源码逆向]**（非官方发布，来自社区对源码的解读）、**[二手报道]**。凡未找到一手来源者均明确写出。

---

## A. 主流 Agent CLI / IDE 的子代理派发机制对比

### A.0 总表

| 产品 | ① 是否支持自主派发 | ② 判据写在哪儿 | ③ 是否要求用户显式授权 | ④ 防过度派发机制 | ⑤ 前台阻塞 or 后台并行 |
|---|---|---|---|---|---|
| **Claude Code** | 是（自动委派为默认行为） | 系统提示词 + `Task/Agent` 工具 description + 子代理 `description` 字段 | 否（可 `@` 强制指定） | 「When NOT to use」负向清单；子代理 description 合计 15,000 token 上限警告；后台子代理工具集收窄；`maxTurns` | **两者皆有**：前台默认阻塞、`run_in_background` 可后台；fork 模式默认后台 |
| **OpenAI Codex CLI** | **分档**：Ultra 档可主动，其他档默认「只在你明确要求时」 | **硬编码在源码里的模式开关**（`effective_multi_agent_mode` → 两个常量提示词） | 是（非 Ultra 档必须显式要求） | `agents.max_threads` 默认 6；`agents.max_depth` 默认 1；官方警告提升深度会导致 fan-out 爆炸 | 后台并行线程；「等所有结果齐了再合成一条回复」 |
| **Gemini CLI** | 是（主 Agent 被指示自动路由） | 子代理 `description` 字段；主 Agent 系统提示词 | 否（可 `@` 强制指定） | 每个子代理 `maxTurns`；browser agent `maxActionsPerTask` 默认 100；官方警告并行改代码会冲突 | 子代理作为工具调用；并行子代理支持 |
| **Devin (Cognition)** | 是，但**写入保持单线程** | 人的任务分解 + 管理器型编排；不由模型自由决定 | 是（会话/任务由人分配） | 核心原则：「多代理系统只在 **写入单线程** 时可靠」；多代理默认只做只读子代理 | 多会话并行，各自独立 VM |
| **Cursor** | 是（`/multitask`、Build in Parallel、Cloud Agents） | 显式指令为主；Build in Parallel 会**自动构建依赖图**分派 | 多数场景显式要求 | git worktree 隔离；依赖图只分派「无共享写入」的分支 | 后台 / 云端并行 |
| **Aider** | **否**（不是自主子代理，是「架构师/编辑者」双模型分工） | 硬编码在 `/architect` 模式 | 是（用户手动切模式） | 不适用（无自主派发） | 前台阻塞，两次串行 LLM 请求 |
| **Anthropic 多智能体研究系统** | 是（orchestrator 自主派生） | **系统提示词内嵌的「按复杂度缩放」规则** | 否（但面向用户的 Research 功能会展示进度） | 提示词内嵌 effort budget（1 个 / 2–4 个 / 10+ 个）；早期「简单问题派 50 个子代理」的失败教训 | **同步阻塞**：lead agent 等每一批子代理全部完成；官方明确说异步是未来方向 |

---

### A.1 Claude Code

**① 是否支持自主派发：是，且是默认设计。**

[一手官方] 官方博客《How and when to use subagents in Claude Code》：
> "Custom subagents … Claude then **delegates to it automatically whenever a task matches its description, no prompting required**."

[一手官方] 官方文档 sub-agents 页：
> "**Claude automatically delegates tasks based on the task description in your request, the `description` field in subagent configurations, and current context.** To encourage proactive delegation, include phrases like 'use proactively' in your subagent's description field."
> 链接：https://code.claude.com/docs/en/sub-agents

**② 判据写在哪儿：三处叠加。**
1. 子代理的 `description` 字段（核心路由层）。[一手官方]："**Claude uses each subagent's description to decide when to delegate tasks.**"
2. 用户请求里的任务描述 + 当前上下文。
3. `Task`/`Agent` 工具自身的 description（作为 system prompt 的一部分注入）。

[官方源码逆向] 工具 description 原文（来源：社区对 `packages/builtin-tools/src/tools/AgentTool/prompt.ts` 的解读）：
> "Launch a new agent to handle complex, multi-step tasks autonomously.
> The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.
> … When using the Agent tool, specify a subagent_type parameter to select which agent type to use. **If omitted, the general-purpose agent is used.**"
> 链接：https://blog.csdn.net/skypig555/article/details/162333158

[官方源码逆向] 关于「主动」的唯一措辞：
> "If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first."
> 注意：全文**没有** "aggressively" 之类的激进措辞。

**③ 是否要求用户显式授权：不要求。** 但提供三级升级路径强制指定：[一手官方]
> "Natural language: name the subagent in your prompt; Claude decides whether to delegate
> @-mention: guarantees the subagent runs for a task
> Session-wide: the whole session uses that subagent's system prompt … via `--agent`"

**④ 防过度派发机制（这是"防滥用"的样本）：**
- **负向清单显式存在**。[官方源码逆向]「When NOT to use the Agent tool」：
  > "- If you want to read a specific file path, use the FileRead tool or Glob tool instead of the Agent tool, to find the match more quickly
  > - If you are searching for a specific class definition … use the Glob tool instead
  > - If you are searching for code within a specific file or set of 2-3 files, use the FileRead tool …
  > - Other tasks that are not related to the agent descriptions above"

  注意：这段**在 Fork Subagent 启用时不注入**（fork 模式下交由模型自行判断）。
- **成本护栏**。[一手官方]：子代理 description 合计超过 15,000 token 会启动时告警；后台子代理只保留白名单内置工具（`Read/Grep/Glob/LSP/Bash/Edit/Write/…/TaskStop/SendMessage` 等）。
- **`maxTurns`**：可对子代理设置最大 agentic 回合数，"to prevent runaway subagents or control cost"（[二手，schema 文档] http://catalog.lintel.tools/schemas/claude-code/agent）。

**⑤ 前台 or 后台：两者皆有，且默认随场景切换。**
[一手官方] sub-agents 文档：
> "**Foreground subagents block the main conversation until complete.** Permission prompts are passed through to you as they come up.
> **Background subagents run concurrently while you continue working.**"
> "Where **fork mode is on**, as it is by default in an interactive session, Claude Code runs the subagent in the background … and Claude can't ask for the foreground."
> "Where **fork mode is off**, Claude runs the subagent in the background by default and in the foreground when it needs the result before continuing."

[官方源码逆向] `run_in_background` 的取舍逻辑（文章称之为"最核心的一段提示词"）：
> "- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. **Use background when you have genuinely independent work to do in parallel.**"
> "- When an agent runs in the background, you will be automatically notified when it completes — **do NOT sleep, poll, or proactively check on its progress.** Continue with other work or respond to the user instead."

**成本**：[一手官方，经二手转引] Claude Code 官方成本文档称 agent teams「在 plan 模式下约为标准会话的 **7×** token」；subagents 约 3–4×（后者为二手）。
链接：https://note.com/shiny_lilac7900/n/ndb3f0e48dd94?hl=en（转引官方 "Manage costs effectively"）

---

### A.2 OpenAI Codex CLI

**① 是否支持自主派发：分档支持。**
[一手官方] https://developers.openai.com/codex/subagents
> "**Codex only spawns subagents when you explicitly ask it to.**"
> "At most intelligence levels, ask for delegation explicitly. **With Ultra, ChatGPT can proactively delegate work when parallel agents would materially improve speed or quality.**"
> "Current local Codex releases delegate when you ask directly or when applicable AGENTS.md or skill instructions request it."

**② 判据写在哪儿：硬编码在源码的模式开关（这是本次调研最直接的"阈值 + 强制例外"证据）。**
[官方源码逆向] 来源：社区对 `config_toml.rs` / `world_state.rs` 的解读（https://www.sina.cn/news/detail/5332951573466053.html）
> 判断函数 `effective_multi_agent_mode`：若当前有效推理等级是 **Ultra** → 选 **Proactive**；否则 → **ExplicitRequestOnly**。
> 两个常量提示词文本写死在 `MultiAgentModeInstructions::body`：
> - `PROACTIVE_MULTI_AGENT_MODE_TEXT` ≈「主动式多代理委派已启用……当任务并行处理能明显提速或提质时，就使用子代理」
> - `EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT` ≈「**除非用户或 AGENTS.md 明确要求，否则不要派子代理**」
> `models.json` 中 ultra 的描述为 "Maximum reasoning with automatic task delegation"。
> 可用 `multi_agent_mode_hint_text` 覆盖默认文案。

**③ 是否要求用户显式授权：是（默认档）。** 官方文档给出的触发句式：
> "In practice, manual triggering means using direct instructions such as **'spawn two agents,' 'delegate this work in parallel,' or 'use one agent per point.'**"

**④ 防过度派发机制（非常明确的量化护栏）：**
[一手官方] https://developers.openai.com/codex/subagents
> "- `agents.max_threads` … **defaults to 6** …
> - `agents.max_depth` … **defaults to 1**, which allows a direct child agent to spawn but prevents deeper nesting. **Keep the default unless you specifically need recursive delegation. Raising this value can turn broad delegation instructions into repeated fan-out, which increases token usage, latency, and local resource consumption.**"

**⑤ 前台 or 后台：后台并行，聚合返回。**
[一手官方]
> "Codex handles orchestration across agents, including spawning new subagents, routing follow-up instructions, waiting for results, and closing agent threads. When many agents are running, **Codex waits until all requested results are available, then returns a consolidated response.**"
> "The app surfaces each subagent thread so you can inspect its work and the summary returned to the main chat."
> "Use `/agent` to inspect and switch between agent threads while they run."

**反模式佐证（社区）**：https://community.openai.com/t/sub-agents-are-fully-hydrating-parents-context/1393050/5 给出了生产化配置：
> "Subagents must not spawn further subagents unless the user explicitly requests recursive delegation."
> "Never select reasoning_effort: 'ultra' for a subagent." —— 即「根用 Ultra（主动编排），子代理用 max（只推理、不继承主动派发）」。

---

### A.3 Google Gemini CLI

**① 是否支持自主派发：是。**
[一手官方] https://geminicli.com/docs/core/subagents
> "You can use subagents through **automatic delegation** or by explicitly forcing them in your prompt.
> **Automatic delegation** — Gemini CLI's main agent is **instructed to use specialized subagents when a task matches their expertise.**"
[一手官方] Google Developers Blog https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli
> "Gemini CLI **automatically routes tasks to your subagents when it determines they are the most efficient path based on their description.**"

**② 判据写在哪儿**：子代理 `description` 字段 + 主 Agent 系统提示词指令。子代理以「同名工具」暴露给主 Agent：
> "Subagents are exposed to the main agent as a tool of the same name. When the main agent calls the tool, it delegates the task to the subagent."

**③ 是否要求用户显式授权：不要求，但提供 `@` 强制。**
> "When you use the `@` syntax, the CLI **injects a system note that nudges the primary model to use that specific subagent tool immediately.**"

**④ 防过度派发机制**：每个子代理可配 `max_turns`；browser agent `maxActionsPerTask` 默认 100；官方明确警告：
> "**Exercise caution with parallel subagents for tasks that require heavy code edits. Multiple agents editing code at the same time can lead to conflicts and agents overwriting one another.** Additionally, parallel subagents will also lead to usage limits being hit faster."

**⑤ 前台/后台**：子代理独立 context loop，完成后回报；支持并行子代理。

---

### A.4 Devin (Cognition)

**① 是否支持自主派发：支持，但刻意收窄。**
[一手官方] https://cognition.ai/blog/multi-agents-working
> "10 months ago, I wrote *Don't Build Multi-Agents*, arguing that most people shouldn't try to build multi-agent systems. … we've found a narrower class of patterns that do: **setups where multiple agents contribute intelligence to a task while writes stay single-threaded.**"

**② 判据写在哪儿：不由模型自由决定，而是「人/管理器驱动的分解」。**
[二手报道] 转引官方博客：
> "Task Decomposition and Delegation: The system can break down large-scale engineering tasks and delegate them to a team of managed agents, with **each agent operating in an isolated, parallel virtual machine (VM)**."
> 链接：https://www.thenextgentechinsider.com/pulse/cognition-launches-advanced-multi-agent-orchestration-framework-for-ai-teams

**③ 是否要求用户显式授权：是**（任务由人分配；`Ask Devin` 探索 → 计划 → 人类定范围 → Devin 拆小任务并行）。

**④ 防过度派发机制（这是"写入单线程"的源头论点）：**
[一手官方] https://cognition.ai/blog/dont-build-multi-agents
> "**Actions carry implicit decisions.** When one agent makes certain changes or edits, it might make implicit choices (style, code patterns, how certain edge cases should be handled) that might conflict with the implicit choices of other parallel agents."
> "**As a consequence of principle 2, most multi-agent setups in the world are limited to 'readonly' subagents, like web search subagents and code search subagents.** For example, Devin can call out to a Deepwiki subagent to acquire codebase context. But these types of subagents mostly resemble tool calls rather than true multi-agent collaboration."

**⑤ 前台/后台**：多会话并行（各自 VM、各自分支）；写入保持单线程。

**补充：Devin Fusion 的「默认委派」措辞**（[二手报道]，适合直接借鉴其主句措辞）：
> "The frontier agent acts as a tech lead … **As the task progresses, the main agent decides which tasks to give the sidekick and which tasks to do itself. The main agent should take minimal actions, and only read what is absolutely necessary. By default it should delegate and monitor, while making the significant decisions: the plan, the interpretation of ambiguity, the final review.**"
> 链接：https://alphasignal.ai/news/cognition-s-devin-fusion-cuts-coding-ai-costs-35-without-losing-frontier

> ⚠️ 关于 Devin 是否存在「模型自主决定派子代理」的机制：**未找到一手官方文档明确说明**；上述为官方博客 + 二手报道的综合。

---

### A.5 Cursor

**① 是否支持自主派发：是（异步子代理 / 并行 / 云端）。**
[一手官方] Cursor 帮助中心《什么是多智能体编程？》：
> "**子智能体是主智能体创建的智能体，用于处理任务的一部分。每个子智能体都在独立的上下文窗口中运行，并将结果返回主对话**，因此可并行完成工作，不会挤占单个上下文。Cursor 内置了用于研究、shell 和浏览器操作的子智能体，你也可以自行定义。"
> 链接：https://cursor.com/help/ai-features/multi-agent（原文另见帮助中心多智能体页）

**② 判据写在哪儿：以显式指令为主；「Build in Parallel」会重建依赖图自动分派。**
[二手报道，转引 Cursor 官方发布说明]：
> "Composer breaks a plan into a dependency graph, **identifies branches with no shared writes, and dispatches them to async subagents.** You watch a tree of tasks finish in roughly the time the longest single branch would have taken — not the sum."
> 链接：https://dev.to/davekurian/cursor-3s-parallel-agents-change-what-a-template-ships-with-joc

**③ 是否要求用户显式授权：多数场景是。** [一手官方] 帮助中心：
> "输入 `/multitask`，让 Cursor 并行运行异步子智能体，而非将请求排队处理。在方案中点击 **并行构建**，Cursor 会同时执行相互独立的步骤，并保持存在依赖关系的步骤按顺序执行。"

**④ 防过度派发机制：worktree 隔离 + 「无共享写入」才并行 + forbid-list。**
[二手报道] Cursor 3 并行实测暴露的问题（可作反模式证据）：
> "Three subagents writing three files at once … Shared barrel files … three near-simultaneous writes, two silently overwriting the third."
> 对策："we now have one human-owned `index.ts` and a **forbid-list** … `parallel: false` flag on a handful of tasks … for steps that touch shared files."

**⑤ 前台/后台**：Cloud Agents / Background Agents 在各自 VM 运行，可关笔记本；PR 附截图/视频/日志。

---

### A.6 Aider

**① 是否支持自主派发：否。** Aider 没有自主子代理机制；它的「架构师/编辑者」是**硬编码的两段式双模型分工**，不是模型自主决定。

[一手官方] https://aider.chat/docs/usage/modes.html
> "**Architect mode and the editor model** — When you are in architect mode, aider sends your requests to two models:
> 1. First, it sends your request to the main model which will act as an architect to propose how to solve your coding request. …
> 2. Aider then sends another request to an 'editor model', asking it to turn the architect's proposal into specific file editing instructions. …
> Certain LLMs aren't able to propose coding solutions *and* specify detailed file edits all in one go. For these models, architect mode can produce better results than code mode by pairing them with an editor model …
> **But this uses two LLM requests, which can take longer and increase costs.**"

**② 判据**：硬编码在模式选择（用户 `/architect` 或 `--architect`），非模型判据。
**③ 显式授权**：是（用户切模式）。
**④ 防过度派发**：不适用。
**⑤ 前台/后台**：前台、串行阻塞（"two LLM requests"）。

> 与 Cognition 博客的呼应：Cognition 把这类「大模型出说明 + 小模型落地」的做法称为 "edit apply model"，并指出其**因为指令轻微歧义而误编辑**的失败模式，认为今天更应「由单一模型一次完成编辑决策与落地」。

---

### A.7 Anthropic 多智能体研究系统（重点）

[一手官方] 《How we built our multi-agent research system》https://www.anthropic.com/engineering/built-multi-agent-research-system （2025-06-13）

**架构**：orchestrator-worker。LeadResearcher 分析 query → 制定策略 → 并行 spawn 专业 Subagent → 汇总 → 判断是否继续 → CitationAgent 处理引用。

**派发规模判据（逐字，最关键）：**
> "**Scale effort to query complexity.** Agents struggle to judge appropriate effort for different tasks, so we **embedded scaling rules in the prompts. Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4 subagents with 10-15 calls each, and complex research might use more than 10 subagents with clearly divided responsibilities.** These explicit guidelines help the lead agent allocate resources efficiently and **prevent overinvestment in simple queries, which was a common failure mode in our early versions.**"

**代价（逐字）：**
> "There is a downside: in practice, these architectures burn through tokens fast. In our data, **agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats.** For economic viability, multi-agent systems require tasks where the value of the task is high enough to pay for the increased performance."
> "We found that **token usage by itself explains 80% of the variance**, with the number of tool calls and the model choice as the two other explanatory factors."（三个因素解释 95%）
> 性能：多代理（Opus 4 lead + Sonnet 4 sub）内部研究评测比单代理 Opus 4 高 **90.2%**。

**防止过度派发的做法（不是禁止派发，而是"按复杂度给预算"）：**
> "Early agents made errors like **spawning 50 subagents for simple queries**, scouring the web endlessly for nonexistent sources, and distracting each other with excessive updates."
> "**Our prompting strategy focuses on instilling good heuristics rather than rigid rules.**"

**派发的提示工程原则（逐字）：**
> "**Teach the orchestrator how to delegate.** In our system, the lead agent decomposes queries into subtasks and describes them to subagents. **Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries.** Without detailed task descriptions, agents duplicate work, leave gaps, or fail to find necessary information. We started by allowing the lead agent to give simple, short instructions like **'research the semiconductor shortage,'** but found these instructions often were vague enough that subagents misinterpreted the task or performed the exact same searches as other agents."

**并行与同步瓶颈（逐字）：**
> "For speed, we introduced two kinds of parallelization: **(1) the lead agent spins up 3-5 subagents in parallel rather than serially; (2) the subagents use 3+ tools in parallel.** These changes cut research time by up to 90% for complex queries."
> 瓶颈（[二手报道] 转引同一博客）："Current limitations include **synchronous execution creating bottlenecks, as lead agents must wait for subagents to complete before proceeding.** Anthropic identified **asynchronous execution as a future improvement** …"
> 链接：https://the-decoder.com/anthropic-shares-blueprint-for-claude-research-agent-using-multiple-ai-agents-in-parallel/

**适用边界（逐字）：**
> "When Multi-Agent Systems Excel: Tasks involving heavy parallelization; Information that exceeds single context windows; Interfacing with numerous complex tools.
> **Not a good fit for tasks requiring shared context or many dependencies between agents. Most coding tasks involve fewer truly parallelizable tasks than research.**"

> ⚠️ 该博客**未给出 orchestrator 完整提示词原文**，仅在文中转述规则，并把完整 prompt 外链到 Cookbook（https://platform.claude.com/cookbook/patterns-agents-basic-workflows）。

---

## B. 提示词怎么写才能让模型真的去派子代理

### B.1 官方「鼓励委派」的逐字原文（可直接抄）

**(1) Claude Code 官方 —— 一句话让路由生效：**
> "To encourage proactive delegation, include phrases like **'use proactively'** in your subagent's description field."
> "The description field is what Claude uses to decide when to delegate. **Be specific about the trigger conditions, not just the capability.** 'Reviews code for security issues before commits' routes better than 'security expert.'"
> 链接：https://claude.com/blog/subagents-in-claude-code

**(2) Claude Code 逆向出的 Agent 工具提示词主句：**
> "Launch a new agent to handle **complex, multi-step tasks autonomously**."
> "**Launch multiple agents concurrently whenever possible, to maximize performance**; to do that, use a single message with multiple tool uses"
> "If the user specifies … 'in parallel', you **MUST** send a single message with multiple Agent tool use content blocks."
> "If the agent description mentions that it should be used proactively, then you should **try your best to use it without the user having to ask for it first**."
> 链接：https://blog.csdn.net/skypig555/article/details/162333158

**(3) OpenAI Codex 官方 —— 显式触发句式：**
> "Ask for subagents or parallel agent work directly. … manual triggering means using direct instructions such as **'spawn two agents,' 'delegate this work in parallel,' or 'use one agent per point.'**"
> 好的子代理 prompt 三要素："**explain how to divide the work, whether Codex should wait for all agents before continuing, and what summary or output to return.**"
> 官方示例："Review this branch with parallel subagents. Spawn one subagent for security risks, one for test gaps, and one for maintainability. Wait for all three, then summarize the findings by category with file references."
> 链接：https://developers.openai.com/codex/subagents

**(4) Anthropic 多智能体博客 —— 委派 prompt 的"四件套"：**
> "Each subagent needs **an objective, an output format, guidance on the tools and sources to use, and clear task boundaries.**"
> "**the best prompts for these agents are not just strict instructions, but frameworks for collaboration that define the division of labor, problem-solving approaches, and effort budgets.**"
> "**Scale effort to query complexity.** … embedded scaling rules in the prompts."

**(5) 主 Agent 与子代理结果回传的"防幻觉"措辞（Claude Code 逆向）：**
> "**Don't peek.** The tool result includes an `output_file` path — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it.
> **Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results."

### B.2 反例：什么措辞会让模型退化成"主 Agent 单干"

| 反例措辞 | 后果 | 证据 |
|---|---|---|
| 把「何时不要派」写成 4 条硬清单，而「何时要派」只有零散一两句 | 负向信号压过正向信号，模型倾向保守不派 | [官方源码逆向] Claude Code 「When NOT to use the Agent tool」为 4 条 bullet，而「when to use」需另找（CSDN 逆向） |
| 工具主描述只说「Launch a new agent…」而**不写"默认/优先派发"** | 模型视为"可选项"，默认单干 | [官方源码逆向] 该 shared 描述无 default/优先字样；仅在 `description` 含 "use proactively" 时才升级为主动 |
| 把派发条件写成「预计超过 N 步才可派」这类**硬性规则** | 官方明确反对：规则太硬会让 agent 判错 | [一手官方] Anthropic："**Our prompting strategy focuses on instilling good heuristics rather than rigid rules.**" |
| 派发指令放在**子代理的 description**里，而主 Agent 的系统提示词里完全没有"鼓励委派"条款 | 路由层缺失，模型不知道"可以/应该派" | [一手官方] Claude Code 两处都要（CLAUDE.md 放 policy，description 放 trigger）；官方示例 CLAUDE.md 用来写"何时必须走子代理" |
| 约束写成「除非用户明确要求，否则不要派子代理」 | 直接退化为单干（这正是 Codex 非 Ultra 档的行为，也是用户实测现象） | [官方源码逆向] Codex `EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT` |
| 子代理描述过宽（"backend code. Use proactively."） | 路由误命中；过窄又永远不命中 | [二手工程经验] https://www.mehdi.cz/blog/claude-code-subagent-descriptions |

### B.3 关键问题：「默认派发」与「防止滥用」如何同时满足？

**业界答案：不是「默认不派」vs「默认派」的二选一，而是「默认派 + 按规模给预算 + 少量硬上限 + 强制例外」。**

三种已验证的组合方案：

1. **Anthropic：阈值分档（推荐权重最高）**
   在**同一条**系统提示词里既写「默认委派」，又写**按复杂度分档的 effort budget**：
   - 简单事实查找：1 个 agent / 3–10 tool calls
   - 直接对比：2–4 个子代理 / 各 10–15 calls
   - 复杂研究：10+ 子代理
   这样"默认派发"不会失控（有上限），"防滥用"也不是靠"不派"（而是靠"派多少"）。

2. **OpenAI Codex：模式开关（proactive vs explicit-only）作为"强制例外"**
   默认档 = explicit-only（保守）；**Ultra 档 = proactive（默认派）**。相当于用一个"高阶档位"承载"默认派发"，其余档位保持保守，避免全局默认派发带来的成本失控。且用 `max_threads=6`、`max_depth=1` 兜底。

3. **Claude Code：正向默认 + 负向最小化边界**
   默认自动委派（description 路由）＋ `use proactively` 提升主动率 ＋ 一份**很短的**"何时别用"负向清单（只列"单文件读取/单文件搜索"这类明显浪费场景）＋ 15k token description 成本护栏 ＋ 后台工具集收窄。

**可落地的提示词骨架（对 slime 直接可改写）：**
```
# Delegation guidance（默认派发，主句）
默认委派：遇到可独立、可并行、或会产生大量中间噪声的子任务，先派子代理，再由你汇总。
只有在下列少数情况才自己直接做：
  - 单文件读取 / 单次精确查找（用 Read/Grep 更快）
  - 结果是你下一步决策的必要输入且子代理会明显更慢

# 力度预算（防止失控，而非防止派发）
- 简单事实查找：1 个子代理，3–10 次工具调用
- 直接对比/多文件同类修改：2–4 个子代理
- 复杂研究/大范围重构：10+ 个子代理，职责明确划分

# 硬上限（兜底）
- 并发子代理上限 N；嵌套深度上限 1（除非用户明确要求更深）

# 每个子代理 brief 必须包含
目标 / 输出格式 / 可用工具与来源 / 明确的边界
```

---

## C. 反模式（过度设计）清单

> 判据：是否**抑制派发意愿**且**没有换来对应的可靠性收益**。

| # | 反模式 | 为什么会抑制派发 | 证据 |
|---|---|---|---|
| 1 | **派发需要用户逐次批准** | 主 Agent 学不到"派发是默认动作"；每次派发都打断流程，模型倾向规避 | [官方源码逆向] Codex 非 Ultra 档 `EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT`（"除非明确要求否则不要派"）；用户实测现象与之吻合 |
| 2 | **派发前必须满足一串硬性条件**（如"预计 > N 步才可派"） | 官方明确反对硬规则，判错即不派 | [一手官方] Anthropic："instilling good heuristics **rather than rigid rules**" |
| 3 | **前台等待把主 Agent 阻塞很久** | 子代理越慢，主 Agent 越倾向"自己做更快" | [一手官方] Claude Code："**Foreground subagents block the main conversation until complete.**"；Anthropic：同步执行"blocks the whole system on the slowest searcher and prevents the lead from steering work in flight" |
| 4 | **工具描述里"何时不要派"比"何时要派"更醒目** | 负向清单权重过高 → 保守化 | [官方源码逆向] Claude Code 的 "When NOT to use" 是 4 条明确 bullet；而进取型措辞仅一句 "used proactively" |
| 5 | **子代理结果不实时回传（只能等最终结果）** | 主 Agent 无法中途决策；遇到长任务无法判断"是否要换路" | [一手官方] Claude Code："A background subagent's results reach Claude as a **completion notification in a later turn**"；且明确 "**do NOT sleep, poll, or proactively check on its progress**"（设计上不轮询） |
| 6 | **子代理失败/超时后没有补救** | 模型学到"派了也没用" | [一手官方] Claude Code 有补救：API 错误时返回部分输出＋`resume`（SendMessage 续接）＋`maxTurns` 标记 partial；**若缺失这些，就是反模式** |
| 7 | **不做规模分档，全凭模型自由发挥** | 早期 Anthropic 因此"简单问题派 50 个子代理" | [一手官方] Anthropic："Early agents made errors like **spawning 50 subagents for simple queries**" |
| 8 | **允许多层嵌套递归派发且不设上限** | fan-out 爆炸，成本/延迟失控，反而促使人关闭派发 | [一手官方] Codex："Raising this value can turn broad delegation instructions into **repeated fan-out**, which increases token usage, latency, and local resource consumption." |
| 9 | **让多个子代理并行写入同一片代码** | 冲突/覆盖，可靠性崩塌 → 产品方退回单线程 | [一手官方] Cognition："**writes stay single-threaded**"；Cursor 实测三个子代理覆盖 barrel 文件 |
| 10 | **通信膨胀（子代理互刷状态）** | 注意力被噪声占据，质量下降 | [一手官方] Anthropic："distracting each other with **excessive updates**" |

**学术补充（MAS 失败模式）：**
[学术一手] 《Why Do Multi-Agent LLM Systems Fail?》arXiv:2503.13657（MAST 分类法，1600+ traces，7 框架）
- 失败率 **41%–87%**；三大类占比：System Design Issues 44.2%、Inter-Agent Misalignment 32.3%、Task Verification 23.5%。
- 与本议题最相关的具体失败模式：FM-1.2 Disobey Role Specification（1.5%）、FM-2.4 Information Withholding（0.8%）、FM-2.5 Ignored Other Agent's Input（1.9%）、FM-2.6 Reasoning-Action Mismatch（13.2%）。
- 链接：https://arxiv.org/abs/2503.13657
- ⚠️ 注意该论文的一处重要批评（[二手] 读书会评论）：多数 14 种失败模式**在单 agent 场景同样会发生**，真正"只能发生在多 agent"的模式占比很低（信息扣留 + 忽略同伴输入合计 < 3%，宽松口径 < 18%）。**因此不要把 MAS 论文当作"必须多代理"的依据。**

---

## D. 实时监测与事件驱动

### D.1 三种状态回传机制的官方取舍（A2A 协议）

[标准草案] A2A（Agent-to-Agent）协议定义了三套互补机制（原文逐字）：

| 机制 | 操作 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| **Polling** | 客户端周期 `GetTask` | 实现简单、兼容所有 HTTP | **延迟高、产生无效请求** | 简单集成、受限网络 |
| **Streaming (SSE)** | `SendStreamingMessage` / `SubscribeToTask` | **低延迟、高频更新高效** | 需长连接支持 | **交互式应用、实时看板、进度监控** |
| **Push (Webhook)** | agent 主动 POST 到客户端注册端点 | 异步、客户端无需保活 | 客户端须可被 HTTP 触达 | 服务器间集成、长任务、事件驱动架构 |

关键实现细节（可直接抄给 slui 悬浮监测按钮）：
> "**Event Ordering** — Events MUST be delivered in the order they were generated. Events MUST NOT be reordered during transmission."
> "**Reconnection** — If a client's SSE connection breaks while a task is still active, the client can reconnect using `SubscribeToTask`. The reconnected stream **starts with the current Task state**, preventing loss of information."
> 事件流形态：`{"statusUpdate": {"taskId": "...", "status": {"state": "TASK_STATE_WORKING"}}}` → … → `TASK_STATE_COMPLETED`
> 链接：https://github.com/tangledgroup/tangled-skills/blob/main/misc/a2a-1-0-0/reference/04-streaming-async.md

### D.2 事件驱动 vs 轮询 的取舍（通用工程共识）

[二手工程文档，多源一致]
- 结论：**能服务端推就推，不要用高频轮询模拟实时**。
  > "核心思想只有一句：不要让客户端不停问'有消息了吗'，而是让服务器有消息时主动推送。"（轮询 → SSE → WebSocket 的选型阶梯）
  > 链接：http://www.wfcoding.com/articles/design/0116
- SSE vs WebSocket：SSE 单向（服务端→客户端）、纯 HTTP、**浏览器自动重连**（带 `Last-Event-ID` 断点续传）；WebSocket 双向、需自己写重连逻辑。**"只需要服务器推给客户端，优先 SSE；双方都要高频主动发消息，再考虑 WebSocket。"**
  > 链接：https://lycoristechnologies.com/blog/what-is-server-sent-events
- 并行任务推荐的组合（对"监测悬浮按钮"直接适用）：
  > "**SSE for the live view, webhook for the authoritative completion signal.**"（SSE 承载各 worker 的进度，最终结果走 webhook）
  > "SSE typically carries **progress from each worker to the coordinator**, while the final result arrives through the webhook path."
  > 心跳：SSE 用注释行（`:` 开头）作 **heartbeat**，防止中间层关闭空闲连接。
  > 链接：https://pilotprotocol.network/learn/webhooks-sse-streaming-long-running-jobs

### D.3 「悬浮按钮/状态面板数据不实时」的通用解法

**诊断**：面板数据不实时，几乎总是因为**面板在轮询一个非权威、或被缓存的状态源**，或者**子代理根本没把中间状态 emit 出来**（只 emit 最终结果）。这与本议题直接相关——见 C-5。

**通用解法（按优先级）：**
1. **让子代理在产品层 emit 结构化事件**（不只是最终文本）。参照 A2A 的 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`，为 `delegate_subagent` / `subagent_wait` 建立事件：`status(started|working|blocked|completed|failed)`、`progress`、`partialOutput`、`heartbeat`。
2. **面板改为订阅事件流（SSE）而非轮询**；断线用 `Last-Event-ID` / `SubscribeToTask` 语义重连，首帧返回"当前全量状态"以防丢事件。
3. **区分「进度事件」与「完成事件」两条通道**：进度走 SSE（可丢、可合并），完成走一次权威回调（对齐 Anthropic/Claude Code 的"completion notification"模型）。
4. **禁止主 Agent 轮询**：Claude Code 的做法是把轮询定义为**错误的 agent 行为**（"do NOT sleep, poll, or proactively check on its progress"），改为**事件通知**。这对"Agent-Loop 是否设好"的问题是一个直接参照——**正确形态是事件驱动（通知）而不是轮询**。
5. **可观测性基建**：Anthropic 明确说，早期用户反馈"agent 找不到显而易见的信息"，团队**无法判断是 query 差、来源差、还是工具坏了**，因此补上了完整的 production tracing。→ 悬浮面板的价值不只是"好看"，而是**让失败可归因**。
   > 链接：https://reasoncore.dev/post/a-45-agent-claude-swarm-found-266-vulnerabilities-across-15-open-source-projects

### D.4 主流产品的实时监测形态（可直接对标的 UI 参照）

| 产品 | 运行中可见性 |
|---|---|
| **Claude Code** | 后台子代理完成时以 **completion notification** 回主会话；footer 提示 `/tasks to see subagents`；`Ctrl+B` 把前台任务转后台；`Esc` 可只拒绝某一次工具调用而不终止子代理。 |
| **OpenAI Codex** | `active` / `done` 列表；`/agent` 切换线程检视；background-agent panel「展开面板查看状态、停止全部活跃子代理、打开单个子代理线程」；审批请求会从**非活跃线程**浮出，附来源线程标签。 |
| **Gemini CLI** | `/agents` 查看已配置子代理；`@` 强制指定。 |
| **Cursor** | Agent 窗口侧栏管理多智能体；云端 agent 产出视频/截图/日志附加到 PR；「无需检出分支即可验证」。 |

---

## 附：证据性质说明与缺口

**一手官方来源（可直接引用）**
- Anthropic 多智能体博客、Claude Code 官方文档/官方博客、OpenAI Codex 官方文档、Gemini CLI 官方文档 + Google Developers Blog、Aider 官方文档、Cognition 官方博客（Don't Build Multi-Agents / Multi-Agents: What's Actually Working）、Cursor 帮助中心/Changelog、A2A 协议草案、arXiv:2503.13657。

**逆向/二手来源（引用时须标注不确定性）**
- Claude Code `AgentTool` 完整提示词（CSDN 逆向 `prompt.ts`）——与官方文档表述一致，可信度较高，但**非官方发布**。
- Codex 的 `PROACTIVE_MULTI_AGENT_MODE_TEXT` / `EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT` 常量（sina.cn 逆向 `config_toml.rs`）——与官方文档"Ultra 才 proactive"完全吻合，可信度较高，但**非官方发布**。
- 各家 token 倍数、失败案例数字多来自二手报道/厂商自评（已在正文标注）。

**未找到一手来源的项（已明确标注，未编造）**
- Devin 是否存在"模型自主决定派子代理"的机制细节——仅有官方博客的原则性论述。
- Cursor「子智能体」的官方独立参考页未取到英文原文（仅取到帮助中心中文页与二手转引）。
- Anthropic 博客的 orchestrator 完整提示词原文——正文未给出，仅外链 Cookbook。
