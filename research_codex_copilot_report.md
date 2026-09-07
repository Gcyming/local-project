# 业界调研报告：OpenAI Codex vs GitHub Copilot — 对自研 slime 平台的启发

> 调研时间：2026 公开资料。覆盖 OpenAI Codex（CLI + 云端/App + IDE 扩展）与 GitHub Copilot（Agent Mode / Copilot Workspace / Agent HQ 编排）。
> 资料均为公开网页，文末附 URL。七维度对比，每节含：业界具体做法 / 关键设计点 / 对 slime 启发。

---

## 0. 一句话定位

- **Codex**：OpenAI 第一方终端编码 Agent，Rust 轻量 CLI，以「操作系统级沙箱 + 审批策略 + MCP/AGENTS.md/记忆」为骨架，强调「敢在用户机器上动手」的安全能力分层。
- **Copilot**：从补全进化为「任务级自主 Agent」，以 VS Code 内 plan→edit→verify 循环为内核，并升级为 Agent HQ（mission control）跨模型编排多个编码 Agent（Copilot/Claude/Codex 可并行），强调企业级编排与多 Agent 调度。

两者是 slime 的两条并行参照系：Codex 的「安全沙箱/权限/上下文」值得抄，Copilot 的「规划-验收-编排-人审」值得抄。

---

## 1. 任务规划与执行

### 业界具体做法
**Codex**：
- 无独立规划器，靠 /plan-mode 切换多步规划，与执行分离（打开后先产计划，确认后执行）。
- plan 产物落 sidebar/artifacts：任务摘要、计划、生成文件预览、来源引用，供人审阅。
- /review 代码审查模式：审查未提交改动、对比 base 分支。
- 执行是「工具循环」：模型发工具调用 → 沙箱执行 → 结果回灌 → 继续。
- 云端（Codex cloud）用两阶段运行时：setup 阶段（可联网装依赖）→ agent 阶段（默认离线）。

**Copilot（Agent Mode / Workspace）**：
- 明确 plan → implement → review → commit → verify 生命周期，带显式 STOP 门让用户把持节奏。
- Planner 产出 phased plan（TDD 优先）+ 验收标准(acceptance criteria) + 风险 + 非功能需求，交付 Orchestrator。
- grounded 工作流把计划持久化为 roadmap.json（单一事实源）：每条 item 带 complexity / acceptance criteria / verification 字段，Orchestrator 按优先级逐条派发，失败 item 阻塞并上报用户。
- 多文件编辑：Agent 自动读 workspace 上下文，自己定位要改哪些文件（任务级思维，非文件级思维）。
- autoFix 循环：跑命令 → 读报错 → 自我修复 → 再跑，无需逐步征询。

### 关键设计点
- 计划要显式可审、可持久化（Codex sidebar artifacts / Copilot roadmap.json 单源）。
- 验收标准(acceptance criteria)是规划产物的一部分，Copilot 用红/绿测试作验收门，比 Codex 更工程化。

### 对 slime 启发
- slime 的 Swarm 拆解已有 plan/SubTask 雏形（SwarmPlan）。可补「plan 持久化 + 验收字段」（复杂度/验收标准/验证命令），类似 Copilot roadmap.json 单源，让主 Agent/Merger 有据可依。
- 引入「规划/执行分离」，让人类先审计划再执行。
- 验收环节用 slime 已有 qa.py / run_tests.py 作「红/绿测试门」（Copilot 做法），把测试结果写进 plan item 的 verification。

---

## 2. 上下文管理

### 业界具体做法
**Codex**：
- 会话(session)转录落盘到 CODEX_HOME，history.persistence / history.max_bytes 可调，支持恢复/resume。
- AGENTS.md 项目记忆：仓库级指令文件，Agent 每次启动读入（slime 已有同款概念）。
- Memories（跨线程记忆）：把过去线程的有用上下文带到未来工作，可按线程控制。
- 上下文感知建议：返回 Codex 时把可续做的任务/后续步骤浮出来（context-aware suggestions）。
- Archived threads：归档会话可按日期/项目上下文恢复。
- /status 显示 thread ID、context usage、rate limits——实时上下文占用透明化。
- 上下文压缩：靠会话存档与摘要机制（issue #8573 提出 Deterministic Session Checkpoint 无摘要化压缩方案）。

**Copilot**：
- VS Code 内聊天/Agent 共享编辑器的 workspace 上下文自动注入，无需用户指定文件。
- 会话线程按模型/模式组织，copilot_chat_compact_tables 等 flags 支持表格/上下文紧凑展示。

### 关键设计点
- 上下文使用量要透明可见（Codex /status 的 context usage）。
- 会话可持久化、可恢复、可归档，跨线程记忆可选带。
- AGENTS.md 是「项目级常驻上下文」。

### 对 slime 启发
- slime 已有「上下文圆环/压缩」（GUI 阶段 8-13）。可加 /status 式透明占用显示（当前 token / 上下文占用 / 速率限制）。
- 已有「记忆」模块：对照 Codex Memories 的「跨线程携带」语义，明确记忆作用域（per-thread vs 全局）。
- 会话持久化 + resume：对照 Codex 的 CODEX_HOME 转录与「可恢复建议」。

---

## 3. 工具调用与沙箱

### 业界具体做法
**Codex（沙箱是最大亮点）**：
- 三种沙箱模式：ReadOnly（全盘只读+可执行进程+禁网）/ WorkspaceWrite（只读+工作目录可写+禁网默认）/ DangerFullAccess（--yolo / --dangerously-bypass，全放行，不推荐）。
- OS 级强制：
  - macOS：Seatbelt / sandbox-exec，-D 参数化策略，硬编码 /usr/bin/sandbox-exec 防替换；
  - Linux：Landlock(ABI V5) + seccomp，bwrap 管道 + 代理-only 网桥，失败即关断；
  - Windows：原生用 AppContainer 受限令牌 + Capability SID（实验性，官方建议容器隔离）；WSL2 走 Linux 实现。
- 网络默认关闭，[sandbox_workspace_write] network_access = true 才开；web 搜索默认走 OpenAI 缓存索引（防 prompt injection），--search/live 才直连。
- 受保护路径：可写根下 .git（含 gitdir 指针目标）、.agents、.codex 目录恒只读，递归保护。
- 审批策略：untrusted / on-failure / on-request / never；granular 可分类自动拒/自动批；guardian_subagent 可替代人工审批。
- MCP 工具也受审批约束：破坏性/未标注工具需批准（issue #7635：早期 MCP 可绕过沙箱，官方以 destructive annotation 修复）。
- Telemetry(OTel)：默认关，事件含 tool_decision/tool_result/approval，审计合规。

**Copilot**：
- Agent Mode 三种模式：Ask / Edit / Agent；runTasks 控制终端命令执行，autoFix 控制自愈循环。
- 每个 Agent 在自己的沙箱环境起线程、建分支、改代码、提 PR 供人审（Agent HQ）。
- 工具调用与审批在 VS Code 内以交互 UI 呈现（允许/拒绝）。

### 关键设计点
- 纵深防御、分层强制：文件系统(Landlock/Seatbelt) + 网络(seccomp) + 系统调用三层。
- 沙箱与审批解耦：沙箱决定「技术上能做什么」，审批决定「何时停下问人」。
- .git 保护是独特设计：防 Agent 破坏仓库历史。
- 路径规范化：解析 symlink、处理 /var→/private/var 歧义，防绕过。

### 对 slime 启发
- slime 已有 L0–L5 沙箱分层 + [sandbox] 配置。可对照 Codex 补充：受保护路径（.git/.agents/.codex 恒只读）、网络默认关 + 白名单/缓存检索、路径规范化防 symlink 绕过。
- MCP 工具权限映射：slime 的 mcp_client.py 缺省 network——可对照 Codex 的 destructive annotation → 必批语义，防止 MCP 绕过沙箱（对应 AGENTS.md 里 A-044/049 幻觉护栏的 MCP 侧）。
- 审批策略可加 granular 分类自动拒/批 + guardian_subagent 代理审批。

---

## 4. 记忆

### 业界具体做法
**Codex**：
- Memories：跨线程持久记忆，把过去线程上下文带入未来工作，per-thread 可开关。
- AGENTS.md：项目级常驻指令/记忆（编码规范、构建命令）。
- context-aware suggestions：返回时浮出「上次未完成的任务/可续接步骤」。
- Archived threads + 会话转录：历史可恢复。

**Copilot**：
- 靠 roadmap.json 作为项目级结构化「长期记忆」（计划/验收/验证状态持续更新）。
- 无独立记忆系统，主要依赖 IDE workspace 上下文 + 会话线程。

### 关键设计点
- 记忆要有作用域粒度（per-thread / 项目 / 全局）与可开关。
- 结构化计划文件(roadmap.json)兼作记忆载体——既是任务单源也是项目状态记忆。

### 对 slime 启发
- slime 记忆模块可引入作用域粒度（线程级 vs Agent 级 vs 全局），对照 Codex Memories 的 per-thread 控制。
- AGENTS.md（slime 已有）正是项目级常驻记忆，与 Codex 完全同构——可强化为「计划/验收/状态」的持久单源（Copilot roadmap 思路）。

---

## 5. 多 Agent

### 业界具体做法
**Copilot（Agent HQ / Mission Control）——多 Agent 编排标杆**：
- 在 PR 评论/Issue/VS Code 聊天里 @copilot / @claude / @codex 触发，每个 Agent 独立沙箱 + 建分支 + 改码 + 提 PR 供人审。
- 多模型并行：同一仓库不同任务分配给不同 Agent（重构给 Claude、样板给 Codex），统一 dashboard 监控。
- 跨端一致：GitHub.com / VS Code / Mobile / CLI 同一界面。
- 身份与访问控制：像管理开发者一样管理 Agent 权限、访问策略、审计轨迹。
- 第三方集成：Slack/Linear/Jira/Teams/Azure Boards/Raycast。
- 指标看板：合并率、代码质量、AI 对交付速度的影响。
- Custom Agents 编排：Orchestrator/Planner/Researcher/Architect/Implementer/Reviewer/Security-Auditor 用 agent handoffs/subagent 相互委托。
- 定价：Agent HQ 对 Copilot 付费订阅零额外成本，每编码会话消耗 1 个 premium request。

**Codex**：多 Agent 能力较弱，靠 guardian_subagent 代理审批、子 Agent/skills，主战场是单 Agent 深度执行。

### 关键设计点
- 编排层(mission control)与执行层解耦：编排只调度，不直接跑校验（grounded 里 Orchestrator 不直接跑 checks，评估 sub-agent 裁决）。
- 跨模型可插拔：Agent 是「可编排的工人」而非一体助手。
- 人类审阅是终点：每个 Agent 提 PR，人审后合入。

### 对 slime 启发
- slime 的 Swarm（主 Agent 拆解 → max_workers 并发 → Merger 合并）已是编排雏形。可对照 Copilot：让编排器只管调度不直接跑校验（Merger 只在 SubWorker 分支上跑 QA，与 grounded 的 Orchestrator 语义一致）。
- 跨模型路由：slime split() 已支持 inherit/api/local 三选——可升级为「按任务复杂度/类型路由不同 provider」（Copilot 的 Claude 重构 / Codex 样板思路）。
- 补统一监控/指标看板：合并率、工具调用、token 消耗、Agent 成功率。

---

## 6. 交互体验

### 业界具体做法
**Codex**：
- CLI /status（thread ID / context usage / rate limits）、/plan-mode、/review、/mcp、/feedback、/permissions 等斜杠命令。
- Sidebar / artifacts：计划、来源、任务摘要、生成文件预览可视化。
- computer use（macOS）：可看可操作 GUI（需 Screen Recording + Accessibility 权限，限欧洲/英国/瑞士外）。
- App 多线程并行 + 内置 worktree + 自动化 + Git 功能；codex:// deeplink。
- Skills 复用指令与工作流，跨 app/CLI/IDE 一致。
- 成本展示：会话消耗 ChatGPT 套餐额度（Plus/Pro/Business/Edu/Enterprise 含 Codex），无独立按 token 计费展示。

**Copilot**：
- 编辑器内 Ask / Edit / Agent 三模式切换，Agent 运行中可在编辑器中实时看到文件改动/命令输出。
- 改动以 diff 呈现，用户接受/拒绝（Edit 模式）；Agent 模式自主迭代。
- Agent HQ 提供统一 dashboard 监控多个 Agent 的进度、分支、PR。

### 关键设计点
- 实时可见性：agent 正在改什么、跑什么、占多少上下文，用户一眼可见。
- 审阅即交互：改动以 diff 呈现，人审后合入。

### 对 slime 启发
- slime GUI 已有思考/工具折叠卡、右侧栏（工作树/终端/浏览器/Git）、事件流。可补 /status 式上下文占用 + 速率限制展示。
- 实时 diff 预览 + 接受/拒绝：把 Agent 改动以 diff 卡呈现，人审后合入（Copilot 交互）。
- 斜杠命令体系（/plan /review /mcp /permissions）可移植为 GUI 命令面板。

---

## 7. 安全可信

### 业界具体做法
**Codex（安全是主线）**：
- 审批分层：沙箱决定技术能力，审批决定何时问人；untrusted/on-failure/on-request/never/granular/guardian_subagent。
- .git/.agents/.codex 受保护路径恒只读——防 Agent 破坏仓库与自身配置。
- 网络默认关 + web 搜索缓存——降低 prompt injection 暴露；提示注入被视为不可信数据。
- 云上两阶段：setup 可联网，agent 阶段默认离线；secrets 仅在 setup 存在，agent 阶段前移除。
- MCP 破坏性工具必批（destructive annotation 优先级高于 read annotation）。
- OTel 可审计：默认关，事件含 tool_decision/tool_result/审批来源，可追踪异常工具执行。
- GPT-6 Astra 安全监控：异步监控，检测到潜在不安全模型行为可暂停任务（不替代沙箱/审批/人工审）。
- 路径规范化 / 可执行文件硬编码路径：防 symlink、PATH 替换绕过。

**Copilot（Agent HQ）**：
- 身份与访问控制：像管理开发者一样管理 Agent 权限、访问策略、审计轨迹。
- 每个 Agent 独立沙箱环境 + 建分支 + 提 PR 供人审（人工 gate 是收口）。
- 风险披露：业界文章指出「复合错误(compounding errors)」风险随多 Agent 编排内置进平台。

### 关键设计点
- 纵深防御：沙箱 + 审批 + 监控 + 人工审四层。
- 审计轨迹：谁在何时批准了什么工具调用。
- 受保护路径与配置自保护：Agent 不能改自己的治理规则（.codex / AGENTS.md）。

### 对 slime 启发
- slime 已有 L0–L5 权限 + 受保护模块（AGENTS.md/core/sandbox/encryption 需最高 approval）——与 Codex「.git/.codex 恒只读」「治理层自保护」同构，可强化。
- secrets 两阶段：云/远端执行时，密钥仅在 setup 阶段注入、执行前移除（slime 的 provider 加密可对照）。
- 安全监控可暂停任务：slime 可加「异常行为检测 → 暂停任务待审」的异步护栏。
- 审计轨迹：AGENTS.md 已要求 git notes intent 记录关键决策——可扩展为「审批/工具调用」全量审计（对照 Codex OTel）。

---

## 资料来源 URL

**OpenAI Codex**
- Codex 官方文档合集（sandbox/approvals/network/sessions/memories/AGENTS.md/CLI）：https://cdn.jsdelivr.net/gh/chadbyte/clay@main/docs/guides/codex-reference/llms-full.txt （单文件导出自 developers.openai.com/codex）
- Codex 官方 GitHub README：https://raw.githubusercontent.com/openai/codex/main/README.md
- Agent approvals & security（官方文档镜像）：https://www.codex-docs.com/en/docs/agent-approvals-security.md
- Codex Windows 沙箱构建（官方博客）：https://openai.com/zh-Hans-CN/index/building-codex-windows-sandbox/
- MCP 沙箱绕过 issue #7635：https://github.com/openai/codex/issues/7635
- Simon Willison 沙箱源码逆向报告：https://github.com/simonw/research/blob/main/codex-sandbox-investigation/notes.md 与 README.md
- Codex 会话恢复 issue #1991、确定性会话压缩 RFC issue #8573：https://github.com/openai/codex/issues/1991 、https://github.com/openai/codex/issues/8573
- Codex Agent Patterns 目录：https://www.agentpatternscatalog.org/compositions/codex-cli/

**GitHub Copilot / Agent HQ**
- GitHub 官方博客《Introducing Agent HQ: Any agent, any way you work》：https://github.blog/news-insights/company-news/welcome-home-agents/
- GitHub 官方博客《How to orchestrate agents using mission control》：https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/
- Visual Studio Magazine《GitHub Introduces Agent HQ》：https://visualstudiomagazine.com/articles/2025/10/28/github-introduces-agent-hq-to-orchestrate-any-agent-any-way-you-work.aspx
- VentureBeat《GitHub's Agent HQ 解决企业最大的 AI 编码问题》：https://venturebeat.com/ai/githubs-agent-hq-aims-to-solve-enterprises-biggest-ai-coding-problem-too
- AgentMarketCap《Agent HQ 多模型编排》：https://agentmarketcap.ai/blog/2026/04/05/github-agent-hq-multi-model-orchestration-end-single-provider-lock-in
- Copilot Agent Mode 完整指南：https://dev.to/stacknotice/github-copilot-agent-mode-complete-guide-2026-1p8k
- VS Code Copilot Agents Pack（plan-explore-review-commit 工作流）：https://github.com/jaktestowac/awesome-copilot-for-testers/blob/main/agent-orchestration/plan-explore-review-commit/README.md
- Grounded 工作流（roadmap.json 单源 + acceptance criteria）：https://github.com/dariokl/grounded
- Copilot 规划生成与评审课程：https://theneuralbase.com/github-copilot/learn/intermediate/plan-generation-and-review/
