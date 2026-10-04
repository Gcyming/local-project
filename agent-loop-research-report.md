# 权威 AI Agent 厂商与前沿机构的 Agent-Loop（智能体主循环）设计调研

> 调研方法：仅采信本次会话中**实际成功抓取**的页面内容（一手官方文档 / 官方博客 / 官方系统卡 / arXiv 摘要页）。
> 抓取失败或无法访问的来源，在「未能核验的来源」一节中明确标注。所有引号内文字为原文摘录（英文原文保留，未逐字翻译）。
> 调研时间：2026 年（以各来源页面显示的发布日期为准）。

---

## 一、来源清单（标题 + URL + 一句话结论）

### A. Anthropic

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| A1 | Building effective agents（2024-12-19） | https://www.anthropic.com/engineering/building-effective-agents | 把「agentic systems」拆成 workflow（预定义代码路径）与 agent（模型自主决定流程），给出 5 种 workflow 模式 + 1 种 agent 模式，核心主张是「先用最简单方案，只在可证明有收益时才加复杂度」。 |
| A2 | Effective context engineering for AI agents（2025-09-29） | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 把 agent 定义为「LLMs autonomously using tools in a loop」，并把长时程任务的三板斧定为 **compaction / structured note-taking / sub-agent architectures**。 |
| A3 | How we built our multi-agent research system（2025-06-13） | https://www.anthropic.com/engineering/multi-agent-research-system | Orchestrator-worker：lead agent 规划 + 并行 subagent 检索 + CitationAgent 归因，明确给出「多 agent 比单 agent Opus 高 90.2%」与「多 agent 约 15× token」两个量化结论。 |
| A4 | Writing effective tools for agents — with agents（2025-09-11） | https://www.anthropic.com/engineering/writing-tools-for-agents | 工具设计十条：不要包 API 端点、要合并成高阶工具、命名空间、返回高信号内容、分页/截断、把错误信息写成可执行的改进指令。 |
| A5 | Claude Code — How the agentic loop works（Agent SDK 文档） | https://code.claude.com/docs/en/agent-sdk/agent-loop.md | 官方把 loop 定义为「prompt → 评估 → 工具执行 → 重复」，一 cycle = 一 turn，工具无调用即结束；给出 max_turns / max_budget_usd / effort / permission_mode / 自动 compaction / hooks 的完整控制面。 |
| A6 | Claude Code — How Claude Code works | https://code.claude.com/docs/en/how-claude-code-works.md | 把主循环明确写成三段：**gather context → take action → verify results**，「These phases blend together」，且人可随时打断介入。 |
| A7 | Claude Code — Subagents in the SDK | https://code.claude.com/docs/en/agent-sdk/subagents.md | subagent 的四项收益：上下文隔离、并行、专用指令、工具限制；默认深度 3 层、并发 20、可设花费上限。 |
| A8 | Claude Code — Create custom subagents | https://code.claude.com/docs/en/sub-agents.md | 给出「什么时候用主对话 vs 什么时候用 subagent」的官方判定表，以及 fork（继承全部对话）与非 fork（全新上下文）的取舍。 |
| A9 | Managing context on the Claude Developer Platform | https://claude.com/blog/context-management | 官方上下文管理能力页（本次抓取到页面骨架，正文未完整取得）。 |

### B. OpenAI

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| B1 | OpenAI Agents SDK — Intro | https://openai.github.io/openai-agents-python/ | 只有三个原语：Agents / Agents-as-tools 与 Handoffs / Guardrails；内建 tracing；是 Swarm 的生产级后继。 |
| B2 | OpenAI Agents SDK — Running agents（The agent loop） | https://openai.github.io/openai-agents-python/running_agents/ | 循环三段：调 LLM → 若 final output 则结束 / 若 handoff 则换 agent 重跑 / 若 tool call 则执行并重跑；超过 `max_turns` 抛 `MaxTurnsExceeded`。 |
| B3 | OpenAI Agents SDK — Agent orchestration | https://openai.github.io/openai-agents-python/multi_agent/ | 把编排分为「orchestrating via LLM」与「orchestrating via code」，并明确推荐：**能用代码确定的流程就用代码**，因为更快更省更可预测。 |
| B4 | OpenAI Agents SDK — Context management | https://openai.github.io/openai-agents-python/context/ | 区分「本地 context（不发给 LLM）」与「LLM context」，并给出 4 种把数据送进 LLM 的途径（instructions / input / FunctionTool 按需取 / retrieval & web search）。 |
| B5 | OpenAI Agents SDK — Guardrails | https://openai.github.io/openai-agents-python/guardrails/ | 三类护栏（input / output / tool）+ tripwire 机制；input 护栏默认并行执行，可改为 blocking 以避免「贵模型已经跑起来了才发现不该跑」。 |
| B6 | Swarm（已归档，官方 README） | https://raw.githubusercontent.com/openai/swarm/main/README.md | 原文明确：「Swarm is now replaced by the OpenAI Agents SDK」；其 loop 原话是 5 步（取 completion → 执行工具并追加结果 → 必要时切换 Agent → 更新 context variables → 无新函数调用则返回）。 |
| B7 | Deep Research System Card（2025-02-25） | https://deploymentsafety.openai.com/deep-research/preparedness-mitigations | 明确 deep research = 「multi-step research on the internet」由**早期版 o3 针对网页浏览优化**，经 RL 训练学会搜索/点击/滚动/读文件/沙箱写 Python；并披露 prompt injection 缓解前后的攻击成功率对照（如纯文本 4.04% → 0.00%）。 |
| B8 | Computer-Using Agent（2025-01-23） | https://openai.com/index/computer-using-agent/ | CUA「combines GPT-4o's vision capabilities with advanced reasoning through reinforcement learning」，可以「break tasks into multi-step plans and adaptively self-correct」；不给 OS/Web 专用 API，只用 GUI。 |
| B9 | Introducing Operator（2025-01-23） | https://openai.com/index/introducing-operator/ | Operator 的产品化公告（本次抓到内容被截断，仅有开头）。 |

### C. Google

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| C1 | ADK — Runtime Event Loop | https://adk.dev/runtime/event-loop/index.md | ADK 的主循环是**事件循环**：Runner 与「执行逻辑」之间 yield / pause / commit / resume，只有在 Runner 提交完 state_delta 之后 agent 才恢复执行；并明确警告「dirty read」。 |
| C2 | ADK — Workflows: multi-agent, multi-node applications | https://adk.dev/workflows/index.md | 官方把「多 agent 化」的理由定为三点：可预测性、可靠性、结构（分离职责并**限制每个任务的数据上下文**）；并列出图工作流 / 动态工作流 / 协作工作流 / 模板工作流四类。 |
| C3 | ADK — Loop template workflow agent | https://adk.dev/agents/workflow-agents/loop-agents/index.md | LoopAgent 官方「How it Works」：**LoopAgent 自己不会决定何时停止**，「You *must* implement a termination mechanism to prevent infinite loops」，否则必须靠 max_iterations 或子 agent 主动 escalate。 |
| C4 | ADK — Compress agent context for performance | https://adk.dev/context/compaction/index.md | compaction 被内建进 SingleFlow（CompactionRequestProcessor），分 token-based（优先）与 sliding-window 两策略，可自定义 summarizer 模型。 |
| C5 | ADK — Build collaborative agent teams | https://adk.dev/workflows/collaboration/index.md | 协作模式下每个 task / single_turn 子 agent 跑在**独立 session 分支**里，「cannot see what its peer agents are doing」；并列出已知限制（task 模式必须是叶子 agent）。 |

### D. Microsoft

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| D1 | AutoGen — Teams 教程 | https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html | 明确写出选型建议：「**start with a single agent for simpler tasks**, and transition to a multi-agent team when a single agent proves inadequate. Ensure that you have optimized your single agent with the appropriate tools and instructions before moving to a team-based approach.」 |
| D2 | AutoGen — Termination 教程 | https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html | 「a run can go on forever」——所以有 11 种内建终止条件（MaxMessage / TokenUsage / Timeout / Handoff / External …），可 `&`、`|` 组合，且每次 run 后自动 reset。 |
| D3 | AutoGen — Magentic-One | https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html | 双层循环：外层 Task Ledger（重规划）+ 内层 Progress Ledger（自省进度、判断是否完成、派活）；含大段容器化 / 人工监督 / prompt injection 风险警告。 |
| D4 | Semantic Kernel — Agent Architecture | https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-architecture | 以 `Agent` + `AgentThread` 抽象承载会话状态；官方声明旧的 `AgentGroupChat` 「**is no longer maintained**」，迁到 `GroupChatOrchestration`。 |
| D5 | Semantic Kernel — Agent Orchestration | https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/ | 五种编排模式（Concurrent / Sequential / Handoff / Group Chat / Magentic），并标注整块功能「in the experimental stage… may change significantly」（页面最后更新 2025-07-21）。 |

### E. LangChain / LangGraph

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| E1 | LangChain — Agents | https://docs.langchain.com/oss/python/langchain/agents.md | 定义「An agent is a model calling tools in a loop until a given task is complete」，并提出 **Agent = Model + Harness**，harness 的职责是「get the model the right context at the right time」。 |
| E2 | LangChain — Context engineering in agents | https://docs.langchain.com/oss/python/langchain/context-engineering.md | 明确说 agent 失败的两大原因中，**「the 'right' context was not passed to the LLM」比模型能力不足更常见**；把上下文分成 model / tool / life-cycle 三类，transient vs persistent。 |
| E3 | LangChain — Multi-agent | https://docs.langchain.com/oss/python/langchain/multi-agent.md | 开篇即写「**not every complex task requires this approach**—a single agent with the right (sometimes dynamic) tools and prompt can often achieve similar results」，并给出各模式在 3 类场景下的模型调用次数对比。 |

### F. 一线产品方公开复盘

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| F1 | Cognition — Don't Build Multi-Agents（2025-06，经第三方归档页核验） | https://raw.githubusercontent.com/jerrylususu/bookmark-summary/a525c7201e6e4eefb0b95e3458f3d16ce84303ff/202506/2025-06-19-cognition-don%E2%80%99t-build-multi-agents.md | 两条原则：**共享完整上下文**、**行动隐含决策**（并行写操作会让隐式决策互相冲突）；结论是优先单线程 + 上下文压缩。 |
| F2 | Cognition — Multi-Agents: What's Actually Working（2026-04-22，Walden Yan） | https://cognition.com/blog/multi-agents-working?trk=article-ssr-frontend-pulse_x-social-details_comments-action_comment-text | 立场演化：并行写型 swarm 仍然不行，但「**writes stay single-threaded、其他 agent 只贡献智力**」的一类模式确实有效（clean-context reviewer、smart friend、manager+child Devins）。 |
| F3 | Manus — Context Engineering for AI Agents: Lessons from Building Manus（2025-07-18，Yichao 'Peak' Ji） | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | 把 **KV-cache 命中率**称为生产级 agent 最重要的单一指标；给出「稳定前缀 / 只追加 / 显式缓存断点」三条硬规则，并披露平均输入输出 token 比约 100:1。 |
| F4 | Cursor — Scaling long-running autonomous coding（2026-01-14，Wilson Lin） | https://cursor.com/blog/scaling-agents | 数百并发 agent 跑数周：扁平自协调 + 锁**失败**（20 个 agent 退化成 2–3 个的吞吐），改为 **Planners / Workers 分离 + judge 判定是否继续**；结论是「**Many of our improvements came from removing complexity rather than adding it**」。 |

### G. 学术前沿（近两年）

| # | 来源 | URL | 一句话结论 |
|---|---|---|---|
| G1 | ReAct: Synergizing Reasoning and Acting in Language Models（ICLR 2023，arXiv 2210.03629） | https://arxiv.org/abs/2210.03629 | 把 reasoning trace 与 action 交错生成；在 ALFWorld / WebShop 上比模仿学习与 RL 方法绝对成功率分别高 34% 与 10%。 |
| G2 | Reflexion: Language Agents with Verbal Reinforcement Learning（arXiv 2303.11366） | https://arxiv.org/abs/2303.11366 | 不更新权重，靠语言反馈：把反思文本存进 **episodic memory buffer** 指导下一次尝试；HumanEval pass@1 达 91%（对比 GPT-4 的 80%）。 |
| G3 | Tree of Thoughts（NeurIPS 2023，arXiv 2305.10601） | https://arxiv.org/abs/2305.10601 | 用思想树做前瞻与回溯；Game of 24 上 CoT 仅 4%，ToT 达 74%。 |
| G4 | Self-Refine: Iterative Refinement with Self-Feedback（arXiv 2303.17651） | https://arxiv.org/abs/2303.17651 | 同一个 LLM 同时充当 generator / refiner / feedback provider，7 个任务平均绝对提升约 20%。 |
| G5 | **Large Language Models Cannot Self-Correct Reasoning Yet**（ICLR 2024，arXiv 2310.01798） | https://arxiv.org/abs/2310.01798 | 直接反驳上一类乐观结论：「LLMs struggle to self-correct their responses **without external feedback**, and at times, their performance even **degrades** after self-correction.」 |
| G6 | Why Do Multi-Agent LLM Systems Fail?（MAST，arXiv 2503.13657 v3） | https://arxiv.org/abs/2503.13657 | 「their performance gains on popular benchmarks are **often minimal**」；1600+ 条标注轨迹、7 个 MAS 框架，归纳出 14 种失败模式，分 3 大类：**system design issues / inter-agent misalignment / task verification**。 |

---

## 二、共识清单（每条附支持来源）

**共识 1：主循环的形状就是「LLM 在循环里自主用工具」，没有比这更复杂的必要。**
- Anthropic 原话（A2）：「LLMs autonomously using tools in a loop」；A1：「They are typically just LLMs using tools based on environmental feedback in a loop.」
- LangChain（E1）：「An agent is a model calling tools in a loop until a given task is complete.」
- OpenAI Agents SDK（B2）：调 LLM → 执行 tool → 重跑，直到产出无 tool call 的最终输出。
- Google ADK（C1）：Runner ↔ 执行逻辑的 yield/resume 事件循环。
- Manus（F3）：「the model selects an action… That action is then executed in the environment… The action and observation are appended to the context, forming the input for the next iteration.」

**共识 2：每一轮都要拿到「环境真值」（工具结果 / 测试结果 / 页面状态）才能继续，而不是靠模型自说自话。**
- Anthropic（A1）：「it's crucial for the agents to gain 'ground truth' from the environment at each step (such as tool call results or code execution) to assess its progress.」
- Anthropic（A2）：Claude Code 用 just-in-time 引用（file path / query / link）按需把真值拉进上下文。
- OpenAI CUA（B8）：靠 GUI 感知 + 自适应自我纠错，而不是靠预设 API。
- ReAct（G1）：reasoning 与 acting 交错，「actions allow it to interface with external sources… to gather additional information」。

**共识 3：必须有显式的停止条件 / 预算上限，否则循环不会自己停。**
- Anthropic（A1）：「it's also common to include stopping conditions (such as a maximum number of iterations)」；（A5）`max_turns` / `max_budget_usd` / `ResultMessage.subtype`。
- OpenAI（B2）：超过 `max_turns` 抛 `MaxTurnsExceeded`。
- Microsoft AutoGen（D2）：「a run can go on forever, and in many cases, we need to know *when* to stop them」，内建 11 种终止条件。
- Google ADK（C3）：「**The `LoopAgent` itself does not inherently decide when to stop looping. You must implement a termination mechanism to prevent infinite loops.**」
- Cursor（F4）：每个 cycle 结束由 judge agent 判定是否继续。

**共识 4：上下文是有限稀缺资源，长时程任务必须做压缩 / 卸载 / 隔离。**
- Anthropic（A2）：三条技术线 compaction / structured note-taking / sub-agent architectures；并引「context rot」说明 token 越多召回越差。
- Google ADK（C4）：compaction 内建进 flow，token-based 阈值 + sliding window + 自定义 summarizer。
- LangChain（E2）：`SummarizationMiddleware` 会**永久**替换 state 里的旧消息；并区分 transient（单次调用）与 persistent（写入 state）。
- Manus（F3）：KV-cache 命中率是第一指标，前缀稳定 + 上下文只追加。
- OpenAI Agents SDK（B4）：区分「不发给 LLM 的本地 context」与「发给 LLM 的 context」，并主张用工具按需取。

**共识 5：多 agent 的价值主要来自「上下文隔离 + 并行」，而不是「角色扮演」；而且它更贵。**
- Anthropic（A3）：subagent「facilitate compression by operating in parallel with their own context windows」；量化「multi-agent systems use about **15× more tokens** than chats」，且「most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time」。
- Anthropic（A2）：subagent 可能烧掉数万 token，但只回传 1,000–2,000 token 的摘要。
- Google ADK（C5）：并行子 agent 各跑独立 session 分支，「cannot see what its peer agents are doing」。
- LangChain（E3）：多域任务下 Subagents/Router 因并行只需 ~9K token，而 Skills 累积到 ~15K；Subagents 每次调用多花 1 次 model call 换取中心化控制。
- Cognition（F2）：「multi-agent systems work best today when **writes stay single-threaded** and the additional agents contribute intelligence rather than actions.」

**共识 6：验证要来自「外部信号」，纯模型自省不可靠。**
- 学术反面（G5）：无外部反馈的自我纠正在推理任务上「performance even degrades」。
- Anthropic（A3）：用 LLM-as-judge + rubric（事实准确性/引用准确性/完整性/来源质量/工具效率），但强调「Human evaluation catches what automation misses」。
- Cognition（F2）：generator-verifier 之所以有效，关键在于 **reviewer 拥有完全干净的上下文**（且给出了 context rot 的推理）。
- Google ADK（C3）：LoopAgent 例子里 critic agent 输出精确完成短语，refiner 通过调用 `exit_loop` 工具（`escalate = True`）来终止——**验证结果要落到一个可执行的确定性信号上**。
- Microsoft AutoGen（D2）：终止条件是确定性代码（文本匹配 / token 数 / 手递 / 外部信号），不是模型口头说「我做完了」。

**共识 7：工具是「agent–computer interface」，其设计权重不低于 prompt，错误信息应当是可执行的。**
- Anthropic（A1）附录 2：工具格式要贴近模型见过的自然文本、不要让模型做无谓的格式化开销；「we actually spent more time optimizing our tools than the overall prompt」；把相对路径改成绝对路径后「the model used this method flawlessly」。
- Anthropic（A4）：不要只包装 API 端点，要合并成高阶工具（`schedule_event` / `search_logs` / `get_customer_context`）；返回高信号字段而非 uuid；错误信息要「clearly communicate specific and actionable improvements, rather than opaque error codes or tracebacks」；Claude Code 默认把工具响应截到 25,000 token。
- Anthropic（A3）：工具描述质量直接决定路径——「Bad tool descriptions can send agents down completely wrong paths」。
- Google ADK（C1）：tool 结果走 FunctionResponse 事件，与 state_delta 一起被 Runner 提交后才恢复执行。
- OpenAI Swarm（B6）：函数报错（缺失函数/参数错/异常）会作为 error response 追加进对话，让 agent 有机会自恢复。

**共识 8：流程能用代码写死就不要交给模型；确定性编排比 LLM 编排更快更省更可预测。**
- Anthropic（A1）：workflow = 预定义代码路径，agent = 模型自主决定；「consider adding complexity *only* when it demonstrably improves outcomes」。
- OpenAI（B3）：「orchestrating via code makes tasks more deterministic and predictable, in terms of speed, cost and performance」，并给出结构化输出路由、链式、while+评估器、`asyncio.gather` 并行四种模式。
- Google ADK（C2）：模板工作流「is not controlled by an AI model, and is deterministic in how it executes its sub-agents」。
- Microsoft SK（D5）：Sequential / Concurrent / Handoff 都是代码确定性编排；整块标注为 experimental。
- Cursor（F4）：改用 Planners/Workers 分离的固定管线后，「This solved most of our coordination problems」。

**共识 9：人类必须能随时介入（打断 / 审批 / 检查点）。**
- Anthropic（A5）：6 种 permission_mode（default / acceptEdits / plan / dontAsk / auto / bypassPermissions），配合 hooks（PreToolUse 可拦截工具调用）。
- Anthropic（A6/a5）：checkpoint 让文件编辑可回滚，「Esc」随时打断。
- OpenAI（B5）：tripwire 机制 + 工具审批；可把 input 护栏从并行改为 blocking，「preventing token consumption and tool execution」。
- Microsoft AutoGen（D3）：Magentic-One 官方列出六条防护（容器、虚拟环境、监控日志、human in the loop、限制网络、数据隔离）。

---

## 三、分歧清单（每条附各方立场与 URL）

**分歧 1：多 agent 到底该不该做？**
- 「别做」一侧：Cognition 2025 年原文主张优先单线程或上下文压缩（F1：https://raw.githubusercontent.com/jerrylususu/bookmark-summary/a525c7201e6e4eefb0b95e3458f3d16ce84303ff/202506/2025-06-19-cognition-don%E2%80%99t-build-multi-agents.md ）；Anthropic 也承认「LLM agents are not yet great at coordinating and delegating to other agents in real time」（A3）。
- 「该做，但要看任务」一侧：Anthropic 的研究系统在 breadth-first 检索上多 agent 比单 agent Opus 高 90.2%，但明确指出「some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit」（A3，https://www.anthropic.com/engineering/multi-agent-research-system ）。
- 「部分场景已经能跑通」一侧：Cognition 2026 年自己改口——并行写型 swarm 仍不行，但单写者 + 智力增强型多 agent 已在生产用（F2，https://cognition.com/blog/multi-agents-working ）。
- 「工程上确实能规模化了」一侧：Cursor 用数百并发 agent 跑数周、百万行代码，但代价是需要 Planners/Workers/judge 的显式结构，且「Multi-agent coordination remains a hard problem」（F4，https://cursor.com/blog/scaling-agents ）。
- **结论性差异**：分歧不在「多 agent 是否可能」，而在「写操作是否必须单线程」与「协调结构该多重」。

**分歧 2：自我批评 / 自反思到底有没有用？**
- 正面：Self-Refine 报告 7 任务平均绝对提升约 20%（G4，https://arxiv.org/abs/2303.17651 ）；Reflexion 靠语言反馈把 HumanEval 从 GPT-4 的 80% 提到 91%（G2，https://arxiv.org/abs/2303.11366 ）。
- 反面：ICLR 2024 论文直接反驳，指出**没有外部反馈**的内在自纠正在推理任务上甚至会掉点（G5，https://arxiv.org/abs/2310.01798 ）。
- 一线实践：Cognition 说「You would think that making a model review its own code would not result in any useful findings. But… Devin Review catches an average of 2 bugs per PR」，但强调有效的前提是 **reviewer 用完全干净的上下文**，而不是同一上下文里的自我反思（F2，https://cognition.com/blog/multi-agents-working ）。
- **可调和的读法**：自我批评在「有外部真值 / 有独立干净上下文」时有效，在「同一上下文里凭感觉重判」时无效或有害。

**分歧 3：长时程上下文该「压缩」还是该「卸载 / 隔离」？**
- 压缩派：Anthropic 把 compaction 称为「the first lever」（A2）；Google ADK 把 compaction 做成框架内建（C4）；LangChain 的 `SummarizationMiddleware` 直接永久替换历史（E2）。
- 卸载/隔离派：Cognition 明确说「引入专用语言模型压缩历史对话与行动记录」需要针对领域调整甚至微调小模型，代价高；Claude Code 实践是子代理只回答特定问题、子代理工作不进主上下文（F1）。
- 中间派：Manus 认为关键是**别让压缩破坏缓存**——「Make your context append-only. Avoid modifying previous actions or observations」，压缩本身会打碎 KV-cache（F3，https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus ）。
- **未被任何来源解决的点**：压缩的召回/精度权衡该由谁调、何时触发，各家只给了经验值（例如 Anthropic 建议「先最大化 recall 再收紧 precision」，ADK 给了 token_threshold + event_retention_size 两个旋钮）。

**分歧 4：子 agent 该给「干净上下文」还是「完整上下文」？**
- 干净上下文派：Cognition 明确说 generator-verifier 效果最好的时候恰恰是二者**不共享任何上下文**，理由是注意力数学（context rot）与避免用户指令错误被继承（F2）。
- 完整上下文派：Cognition 自己 2025 年原文的原则 1 是「Share as much context as possible between the agents」（F1）；Anthropic 也强调「Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries」（A3）。
- 折中：Anthropic 的 fork 机制（A8）——普通 subagent 全新上下文，fork 继承全部对话，由使用场景选择。
- **可调和的读法**：**写者之间共享上下文，验证者保持干净上下文**。这也是 F2 的实际做法。

**分歧 5：多 agent 的拓扑该「扁平整群」还是「层级管线」？**
- 扁平派（失败）：Cursor 一开始让 agent 平等自协调 + 共享文件加锁，结果「Agents would hold locks for too long, or forget to release them entirely」「Twenty agents would slow down to the effective throughput of two or three」，且「With no hierarchy, agents became risk-averse… No agent took responsibility for hard problems」（F4）。
- 层级派：Cursor 改为 Planners / Workers / judge 后成功（F4）；Anthropic 用 lead + subagent + CitationAgent（A3）；Microsoft 用 Orchestrator + 四个专才 agent（D3）；OpenAI 提供 agents-as-tools（经理制）与 handoffs（路由制）两种（B3）。
- 唯一「去中心」的官方主张：Cognition 明确说「We think the **unstructured-swarm approach, arbitrary networks of agents negotiating with each other, is mostly a distraction**. The practical shape is map-reduce-and-manage」（F2）。
- **注意**：Cursor 同时警告「Too little structure and agents conflict, duplicate work, and drift. Too much structure creates fragility」，即层级也不是越重越好——他们先把自建的 integrator 角色删掉了。

---

## 四、反模式清单（明示「不要做」的做法 + 出处）

| # | 反模式 | 出处与原话/依据 |
|---|---|---|
| 1 | **让多个 agent 并行做写操作** | Cognition：「writes stay single-threaded」是当前多 agent 唯一可靠的形态；并行写会让隐式决策（风格、边界情况、代码模式）互相冲突。（F2 https://cognition.com/blog/multi-agents-working ；F1 归档页） |
| 2 | **在同一个上下文里做自我批评式反思** | ICLR 2024：「LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction.」（G5 https://arxiv.org/abs/2310.01798 ） |
| 3 | **无终止条件的 agent 循环** | Google ADK：「The `LoopAgent` itself does *not* inherently decide when to stop looping. You *must* implement a termination mechanism to prevent infinite loops.」（C3 https://adk.dev/agents/workflow-agents/loop-agents/index.md ）；AutoGen：「a run can go on forever」（D2） |
| 4 | **不加边界的自主循环 + 无监督环境** | AutoGen Magentic-One 官方 Caution 列了 6 条硬要求（容器、虚拟环境、监控日志、human in the loop、限制网络、数据隔离），并警告 agent 可能「recruiting humans for help or accepting cookie agreements without human involvement」，且「may be susceptible to prompt injection attacks from webpages」。（D3 https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html ） |
| 5 | **把已有 API 端点逐个包成工具（工具爆炸）** | Anthropic：「A common error we've observed is tools that merely wrap existing software functionality or API endpoints」；「Too many tools or overlapping tools can also distract agents from pursuing efficient strategies」。（A4 https://www.anthropic.com/engineering/writing-tools-for-agents ）；另 A2：「One of the most common failure modes we see is bloated tool sets… If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better.」 |
| 6 | **返回原始 uuid / 低层技术字段给模型** | Anthropic：工具返回应「eschew low-level technical identifiers (for example: `uuid`, `256px_image_url`, `mime_type`)」，把 UUID 解析成语义化标识能「significantly improves Claude's precision in retrieval tasks」。（A4） |
| 7 | **把控制逻辑硬编码进 prompt（brittle if-else prompt）** | Anthropic：系统提示的两个失败极端之一是「engineers hardcoding complex, brittle logic in their prompts to elicit exact agentic behavior. This approach creates fragility and increases maintenance complexity over time.」（A2 https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ） |
| 8 | **把边缘情况清单塞进 prompt（laundry list of edge cases）** | Anthropic：「teams will often stuff a laundry list of edge cases into a prompt… **We do not recommend this.** Instead, we recommend working to curate a set of diverse, canonical examples.」（A2） |
| 9 | **在系统提示开头放精确到秒的时间戳** | Manus：这是破坏 KV-cache 的常见错误——「A common mistake is including a timestamp—especially one precise to the second—at the beginning of the system prompt… it also kills your cache hit rate.」；同理「Make your context append-only. Avoid modifying previous actions or observations.」（F3 https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus ） |
| 10 | **过度使用框架抽象、不读底层代码** | Anthropic：「they often create extra layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug. They can also make it tempting to add complexity when a simpler setup would suffice.」「Incorrect assumptions about what's under the hood are a common source of customer error.」（A1） |
| 11 | **一上来就上多 agent** | AutoGen：「start with a single agent for simpler tasks, and transition to a multi-agent team when a single agent proves inadequate. Ensure that you have optimized your single agent with the appropriate tools and instructions before moving to a team-based approach.」（D1 https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html ）；LangChain：「not every complex task requires this approach」（E3） |
| 12 | **用共享文件 + 锁做 agent 间协调** | Cursor：「Agents would hold locks for too long, or forget to release them entirely… it became a bottleneck. Twenty agents would slow down to the effective throughput of two or three」；换乐观并发控制后仍有更深层问题。（F4 https://cursor.com/blog/scaling-agents ） |
| 13 | **无层级的平等自协调（去中心 swarm）** | Cursor：扁平结构下「agents became risk-averse. They avoided difficult tasks and made small, safe changes… work churning for long periods of time without progress」；Cognition：「unstructured-swarm approach… is mostly a distraction」。（F4；F2） |
| 14 | **为一个简单查询启动几十个子 agent** | Anthropic：早期 agent「made errors like spawning 50 subagents for simple queries, scouring the web endlessly for nonexistent sources, and distracting each other with excessive updates」。（A3 https://www.anthropic.com/engineering/multi-agent-research-system ） |
| 15 | **依赖"绝对不要在运行时改历史"之外的隐式假设** | Google ADK：明确警告 session state 的 **dirty read**——callback 里改的 state 在本次 invocation 内可被后续工具读到，但「if the invocation fails *before* the event carrying the `state_delta` is yielded and processed by the `Runner`, the uncommitted state change will be lost. For critical state transitions, ensure they are associated with an event that gets successfully processed.」（C1 https://adk.dev/runtime/event-loop/index.md ） |
| 16 | **在受保护/共享上下文的领域硬上多 agent** | Anthropic：「some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems today. For instance, most coding tasks involve fewer truly parallelizable tasks than research.」（A3） |
| 17 | **为省成本而让"更笨的模型"去判断何时求援** | Cognition 的 Smart Friend 实验明确失败：SWE-1.5 作为 primary 时，「The gap between it and Sonnet 4.5 was too wide in exactly the places that mattered for this setup: knowing when to escalate, knowing what to ask」，且「the quality ceiling was set by the primary」。（F2） |

---

## 五、「单 agent + 工具」与「多 agent 编排」的边界

各权威来源给出的边界条件如下（这些是可以直接作为工程判据的）：

**1）任务是否可并行、依赖是否稀疏 —— Anthropic 的正面清单**
> 「We've found that multi-agent systems excel at valuable tasks that involve **heavy parallelization, information that exceeds single context windows, and interfacing with numerous complex tools**.」
> 反面：「some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit… most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time.」
> —— https://www.anthropic.com/engineering/multi-agent-research-system

Anthropic 同时给出三条上下文技术的分工判据：
> 「Compaction maintains conversational flow for tasks requiring extensive back-and-forth; Note-taking excels for iterative development with clear milestones; Multi-agent architectures handle complex research and analysis where parallel exploration pays dividends.」
> —— https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

**2）写操作是否单线程 —— Cognition 的边界条件（最强约束）**
> 「multi-agent systems work best today when **writes stay single-threaded** and the additional agents contribute intelligence rather than actions. A clean-context reviewer catches bugs the coder can't see. A frontier-level smart friend catches subtleties a weaker primary misses. A manager coordinates scope across child agents without fragmenting decisions.」
> 并且他们明确指出大多数多 agent 部署实际上被限制在「readonly subagents, like web search subagents and code search subagents」，「these types of subagents mostly resemble tool calls rather than true multi-agent collaboration」。
> —— https://cognition.com/blog/multi-agents-working

**3）编辑/写入面是否与主 agent 重叠 —— Google ADK 的官方判据**
> 「Multi-agent patterns are particularly valuable when **a single agent has too many tools and makes poor decisions about which to use**, when tasks require specialized knowledge with extensive context (long prompts and domain-specific tools), or when you need to enforce sequential constraints that unlock capabilities only after certain conditions are met.」
> —— https://docs.langchain.com/oss/python/langchain/multi-agent.md （LangChain「Why multi-agent?」）

超过 15,000 token 的 subagent 描述会触发 Claude Code 启动告警——这是上下文预算的硬信号：
> 「When the combined descriptions of your subagents, except the built-in ones, exceed 15,000 tokens, Claude Code shows a warning at startup with the total token count.」
> —— https://code.claude.com/docs/en/sub-agents.md

**4）协调结构该多重 —— Cursor 的工程教训**
> 「The right amount of structure is somewhere in the middle. Too little structure and agents conflict, duplicate work, and drift. Too much structure creates fragility.」
> 「Many of our improvements came from removing complexity rather than adding it. We initially built an integrator role for quality control and conflict resolution, but found it created more bottlenecks than it solved.」
> —— https://cursor.com/blog/scaling-agents

**5）成本门槛 —— 多 agent 是 15× token 的决策，不是架构口味的决策**
> 「agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats. For economic viability, multi-agent systems require tasks where the value of the task is high enough to pay for the increased performance.」
> —— https://www.anthropic.com/engineering/multi-agent-research-system

**6）综合判据（把上面 5 条合成一张判别表）**

| 判据 | 倾向单 agent + 工具 | 倾向多 agent |
|---|---|---|
| 子任务是否可并行、依赖是否稀疏 | 串行依赖、共享同一份上下文 | 强并行、上下文需要隔离（Anthropic A3） |
| 子任务是否需要「写」 | 需要写 | 只读（检索/审查/规划）（Cognition F2） |
| 单一工具集是否已经导致选错工具 | 工具数可控（< ~20 且语义清晰） | 工具集爆炸、需要按角色裁剪（LangChain E3 / Anthropic A4） |
| 是否已有确定性的流程 | 流程可预定义 | 步骤数不可预测（Anthropic A1） |
| 任务价值 vs token 成本 | 单价敏感 | 高价值、可承受 15× token（Anthropic A3） |
| 是否有人把关 / 沙箱 | 无（则应保留人工与上限） | 有容器化 + 人工监督（Microsoft D3） |

---

## 六、未能核验的来源（明确标注「未找到可靠来源」/ 抓取失败）

以下条目**未取得可核验的原文**，本报告未据此下任何结论：

1. **Cognition《Don't Build Multi-Agents》原文页** —— `https://cognition.ai/blog/dont-build-multi-agents` 本次抓取报「cross-origin redirect to https://cognition.com is not followed automatically」，重试 `https://cognition.com/blog/dont-build-multi-agents` 返回 fetch failed。**未能取得一手原文**；本报告对该文的使用全部来自第三方归档页（`raw.githubusercontent.com/jerrylususu/bookmark-summary/...`，URL 见 F1），属于二手摘要，逐字引用请以原文为准。
2. **OpenAI Deep Research 官方博客《Introducing deep research》** —— `https://openai.com/index/introducing-deep-research/` 两次均返回 HTTP 403。**未取得**。本报告改用 Deep Research System Card（B7）作为 OpenAI Deep Research 循环形态的一手来源。
3. **OpenAI 官方 Agents 指南（developers.openai.com）** —— `https://developers.openai.com/api/docs/guides/agents` 与 `.../running-agents.md` 均返回 HTTP 403，**未取得**。本报告改用 `openai.github.io/openai-agents-python`（官方 SDK 文档，B1–B5）。
4. **OpenAI o 系列 reasoning 与 agent loop 的官方说明** —— `https://openai.com/index/openai-o1-system-card/` 返回 403；`https://developers.openai.com/cookbook/examples/reasoning_function_calls` 返回 403。**关于「o 系列 reasoning 与 agent loop 的关系」未找到可直接引用的一手来源**；本报告仅能从 B7（Deep Research 由「an early version of OpenAI o3 optimized for web browsing」+ RL 训练）与 B8（CUA 由 RL 训练）间接说明「reasoning 模型本身就是被训练成 agent 循环的」，除此之外**未找到可靠来源**。
5. **Project Mariner / Gemini Agent Mode 的官方循环说明** —— 本次会话未成功抓取到 DeepMind/Google 官方关于 Mariner 循环形态的一手页面。**未找到可靠来源**。本报告中 Google 一侧的结论全部来自 ADK 官方文档（C1–C5）。
6. **Anthropic《Managing context on the Claude Developer Platform》正文** —— `https://claude.com/blog/context-management` 抓取到的是页面骨架（导航 + 侧栏），正文未取得。**该页的实质结论未核验**；本报告对 Anthropic context management 的引用一律以 A2/A5 为准。
7. **Anthropic 官方 multi-agent 与单 agent 的取舍是否有更新的表述** —— 除 A1/A2/A3 之外，未找到更新的官方立场文件。
8. **图/表类信息** —— 各来源中的架构图（如 Anthropic 的 multi-agent 架构图、Magentic-One 架构图）为图片，本次未做图像解读，仅依据正文文字描述。

---

## 七、对自研 Agent 平台的建议（≤300 字，每条对应来源）

主循环照 Claude Code 三段式（收集上下文→行动→验证，A6），但把 `MAX_ROUNDS` 升级为「轮次＋花费＋墙钟」三闸，并像 ADK LoopAgent 那样强制显式终止信号（A5/C3），别让「没有 `<DONE>`」成为唯一兜底。上下文按任务分派：对话用 compaction、长迭代用笔记、检索类才上多 agent（A2）；压缩须遵守 Manus 的只追加＋稳定前缀（F3），并补 token 阈值与保留最近 N 条原始事件两个旋钮（C4）。多 agent 只在「读」放开、「写」单线程（F1/F2），这与 Anthropic「编码并行度低」的判断一致（A3）。验证必须接外部真值，且验证者用干净上下文（G5/F2/D2）——`core/claims.py` 方向正确，可扩为产物存在性＋测试通过＋引用可溯源三类硬校验。工具层做减法：不逐个包 API、合并高阶工具、错误写成可执行指令、响应强制截断（A4）。最后，多 agent 是 15× token 的决策（A3），Cursor 的经验是改进多来自删复杂度（F4）——建议 Swarm 加硬门槛：子任务 <3 或不可并行时强制单 agent。
