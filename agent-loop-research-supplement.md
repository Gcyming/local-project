# Agent-Loop 调研 · 缺口补充（第二轮）

来源标注：**一手**＝官方 docs/SDK；**官博**＝官方博客/系统卡；**三方**＝第三方转述或镜像。

## 缺口 1：Google Mariner / Gemini Agent 循环（官博，一手）

- **循环**：planner 读页面决策 → **User Alignment Critic** 逐动作复核（只喂动作元数据、隔离不可信内容；veto 后回 planner 重规划，连败交还用户）→ 执行；注入分类器与 planner 并行。[architecting-security](https://blog.google/security/architecting-security-for-agentic/)
- **HITL＝三层确认**：敏感站点清单（银行/医疗）确定性校验；Password Manager 登录；购买/支付/发消息前暂停征求许可或让用户完成；配 work log、可随时暂停。[Chrome AI](https://blog.google/products/chrome/new-ai-features-for-chrome/)、[DeepMind 防护](https://deepmind.google/blog/advancing-geminis-security-safeguards/)
- **上下文**：origin gating（可读/可写集合，无关 iframe 不进模型，planner 不能自加）。主威胁＝间接注入；静态防御对自适应攻击失效 → 模型硬化＋自动红队。

**增量**：上轮仅 ADK；产品侧新增 critic 复核＋origin 门控＋三层确认。

**未取得**：`deepmind.google/models/project-mariner/` 200 落回首页（下线）；`blog.google/technology/google-labs/project-mariner/` **404**；`support.google.com/labs/answer/16270604`、`/gemini/answer/16596215` fetch failed/**000**；`ai.google.dev` 文档页 **000**。→ **Mariner 自身循环：未找到**。

## 缺口 2：OpenAI reasoning 与 agent loop（一手：官方 cookbook＋系统卡）

- **不分开**：官方要求 reasoning item **跨工具调用保留**——同 turn 内有 function call 必须回传（`previous_response_id` 或显式入 `input`）；Chat Completions 不行、Responses API 可以；SWE-bench **+3%**；纯对话不必带。[reasoning_items](https://github.com/openai/openai-cookbook/blob/main/examples/responses_api/reasoning_items.ipynb)、[o3o4 guide](https://github.com/openai/openai-cookbook/blob/main/examples/o-series/o3o4-mini_prompting_guide.ipynb)
- 唯一的「分离」＝不暴露原始 CoT，只给 reasoning summary。
- **encrypted reasoning**：`include=["reasoning.encrypted_content"]`，ZDR 强制 `store=false`，内存解密不落盘 → **无状态多轮 loop 可行**（缓存命中 40%→80%）。
- **选型**：官方「reserve reasoning models for high complexity tasks」；[GPT-5 系统卡](https://openai.com/index/gpt-5-system-card/)＋[Safety Hub](https://deploymentsafety.openai.com/gpt-5)：fast＋reasoning＋实时 router 按复杂度/工具需求路由。

**增量**：上轮第 4 条补齐：推理状态需跨工具调用保留。

**未取得**：`developers.openai.com/api/docs/guides/reasoning[-best-practices]`、`platform.openai.com/docs/guides/reasoning` 均 **403**；`cookbook.openai.com/examples/reasoning_function_calls` cross-origin redirect。改用官方 cookbook 仓库 raw。

## 缺口 3：Anthropic Managed Agents / context / memory

- **Managed Agents 存在**（官博 2026-04-08）：托管 harness＋state/memory/permissions，自行决定何时调工具、如何管上下文与恢复错误；多 agent 协同、自评迭代为 preview（后者比标准 loop 最多 **+10 点**）。[announce](https://claude.com/blog/claude-managed-agents)、[build](https://claude.com/blog/building-with-claude-managed-agents)；文档 `platform.claude.com/docs/en/managed-agents/*`。
- **原语**（官博 2025-09-29，[context-management](https://claude.com/blog/context-management)）：context editing＝近上限时清过期 tool call/result；memory tool＝**客户端**文件式记忆，目录内增删改查、跨会话持久。memory＋editing 比 baseline **+39%**、仅 editing **+29%**、100 轮检索 token **−84%**。
- **文件模型**（三方镜像＋官方 SDK 互证）：`/memories`、markdown、类型 `memory_20250818`、命令 view/create/str_replace/insert/delete/rename；须限在 `/memories` 内防路径穿越。**参数**（一手 [basic.py](https://github.com/anthropics/anthropic-sdk-python/blob/main/examples/memory/basic.py)）：`clear_tool_uses_20250919`＋`trigger`/`keep`/`clear_at_least`/`exclude_tools`（例：30000 token 触发、留 3 个 tool use）。
- **何时清理**（官方工程博客 [context-engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）：compaction／note-taking／multi-agent 三选，原话「**tool result clearing 是最安全、最轻量的 compaction 形式**」；多来回→compaction，迭代→note-taking，并行探索→multi-agent。[harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)：compaction 不够，需 progress 文件＋git 桥接。**未找到**官方 token 阈值建议。

**增量**：上轮第 6 条（仅骨架）补齐；Managed Agents 与 memory 路径为全新。

**未取得**：`platform.claude.com/docs/**`、`docs.anthropic.com/**` **301 → claude.com/app-unavailable-in-region**（地区限制），`claude.com/docs/**` **404** → 正文未取得，靠三方镜像（core-memory-kit，自述官方文档摘录）＋官方 SDK 互证。

## 对 D:\pilot project（slime）的可执行落点

抄 Google 的 critic：验证器只喂「动作元数据＋目标」，隔离工具原文与网页内容，veto 后带反馈回 planner，连败交还用户——补 slime 只有 claims 事后护栏、缺事前 veto 的洞。抄其三层确定性确认（清单／凭据／不可逆动作），并给可见 work log＋中断键。接 o 系列时，多轮工具循环**必须**回传 reasoning item（无状态用 `encrypted_content`），否则掉点。上下文优先用 tool result clearing，memory 走 `/memories` 式目录＋路径穿越校验，并在 `MAX_ROUNDS` 外补 `trigger`/`keep`/`exclude` 三个 token 旋钮。
