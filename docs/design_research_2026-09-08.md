# Agent 应用前沿设计方案调研报告

> 调研日期：2026-09-08
> 调研方式：WebSearch + WebFetch（只读，不写代码）
> 目标：为 slime 的 4 个 UI / 架构决策（模型自动路由、上游配置自动发现、会话切换状态保留、缓存命中率可视化）提供权威参考
> 资料范围：优先 2024–2026 的官方文档 / GitHub / 知名工程博客 / A/B 实测文章
> 有效检索/抓取：约 22 次工具调用，覆盖 4 主题、12+ 权威来源

---

## 目录

- [主题 A：模型选择中的「自动 / auto-routing」选项](#主题-a模型选择中的自动--auto-routing选项)
- [主题 B：上游模型配置自动发现](#主题-b上游模型配置自动发现)
- [主题 C：聊天界面会话切换的状态保留](#主题-c聊天界面会话切换的状态保留)
- [主题 D：缓存命中率的实时可视化](#主题-d缓存命中率的实时可视化)
- [附录：来源索引](#附录来源索引)

---

## 主题 A：模型选择中的「自动 / auto-routing」选项

**核心问题**：模型选择器里要不要有"自动"选项？怎么命名？自动模式怎么选型？用户能否看到它选了谁、为什么切？

### A.1 Claude Code —— `default` 别名 + `opusplan` 混合 + effort 工作量级别

- **URL**：https://code.claude.com/docs/zh-CN/model-config （英文：https://docs.claude.com/en/docs/claude-code/model-config）
- **核心引用**：
  - 模型选择器里提供一个特殊值 **`default`**："特殊值，清除任何模型覆盖并恢复到您的账户类型推荐的模型。本身不是模型别名"。它代表"基于订阅层级的运行时默认值"，且**不受 `availableModels` 白名单限制**，始终可用。
  - 别名体系：`best`（最强）、`sonnet`、`opus`、`haiku`、`sonnet[1m]`、`opus[1m]`、`opusplan`。其中 **`opusplan` 是自动混合模式**：Plan Mode 用 opus 推理，执行阶段自动切到 sonnet 生成。
  - **透明度**：当前活跃模型显示在状态行（status line）与 `/status`；切换 `opus`→`sonnet` 时的 effort 级别也会显示在徽标旁（如"with low effort"）；当默认模型在账户中不可用时，会**显示回退通知**。
  - **自动回退（降级）**："如果您在使用 Opus 时达到使用阈值，Claude Code 可能会自动回退到 Sonnet。"；启动时若默认版本不可用，会尝试更早版本，失败时回退并不持久化。
- **与 slime 决策的相关性**：`default` 的命名方式（"推荐/系统默认"而非"Smart"）很克制；`opusplan` 是"按阶段自动切换模型"的现成范式，值得 slime 的 Plan/Execute 场景借鉴；"当前模型始终可见 + 回退有通知"是可复用的透明度模板。

### A.2 Cursor Router —— `Auto` + Cost / Balance / Intelligence 三模式

- **URL**：发布博文 https://cursor.com/en-US/blog/router ；文档 https://prod.cursor.com/cn/docs/cursor-router （及 https://www.learncursor.dev/learn/cursor-for-teams/cursor-router）
- **核心引用**：
  - 模型选择器里有一个 **`Auto`** 条目，是 Router 系统的入口。"并非每个请求都需要前沿级智能，路由器会根据任务为每个请求选择合适的模型：简单请求交给快速高效的模型，复杂任务交给能力最强的模型。"
  - **三档优化模式**（用户选的是"偏好"而非具体模型）：**Cost**（优化 token 支出、捆绑定价）、**Balance**（智能/速度/成本平衡）、**Intelligence**（最难任务路由到最强模型，成本低于单跑前沿模型）。"你无法手动指定由哪个模型处理请求；随着新模型上线，模型池不断变化。你可以通过选择优化模式来引导路由。"
  - **选型依据**：在每次请求运行前用分类器分析 query、context、任务复杂度、领域，结合各模型行为画像；简单工作→最省钱的模型，UI 更新→最有"品味"的模型，长周期难题→前沿推理模型。**路由是 cache-aware 的**：训练集里路由会导致 cache miss，实测节省也把 cache miss 成本算进去了。
  - **实测透明度**：在线 A/B 测试覆盖数百万请求，优化目标是"用户满意度（AFC）"；早期客户比全量 Opus 4.8 便宜 30–50%。分类器实际是两步：先由 **Compass** 预测"这轮是否够简单可用便宜模型"，再按真实开发者流量学到的领域/任务分类法选顶级模型。
  - **企业管控**：跟随团队模型访问控制；被禁模型则改用允许的模型；依赖一个强且便宜的回退模型（Cursor Grok 4.5）才能运行。
- **与 slime 决策的相关性**：这是**最完整的"Auto + 优化档位"参考**。"Auto"命名 + "Cost/Balance/Intelligence"三档比单一名字更适合多目标权衡；"用户选偏好、系统管具体模型"的委托模式避免用户被实现细节淹没；cache-aware 提醒 slime 路由时要算上缓存失效代价。

### A.3 OpenRouter —— `openrouter/auto`（Auto Router，task-aware）

- **URL**：https://openrouter.ai/docs/models ；路由器说明 https://lobehub.com/skills/jeremylongshore-claude-code-plugins-plus-skills-openrouter-model-catalog
- **核心引用**：
  - 模型目录里有一个特殊 ID **`openrouter/auto`**："Auto-selects best model for your prompt (powered by NotDiamond)"，按聚合消费为任务分类后路由到该任务最流行的模型，并可按所选"成本-质量权衡"过滤。
  - **透明度设计值得直接抄**："To see which model was used, visit Activity, or read the **`model` attribute of the response**." 即**响应里始终回传实际命中的模型 ID**，用户事后可在 Activity 或响应字段查到"这次 Auto 到底用了谁"。响应按路由模型的实际费率计费。
  - 另有 `:free / :nitro / :floor / :extended / :thinking` 等后缀变体，让用户在不指定具体模型时仍能细控（免费层 / 最高吞吐 / 最低价 / 扩展上下文 / 推理）。
- **与 slime 决策的相关性**：**"响应里回传真实模型 ID"是 auto-routing 透明度的最低可行方案**，slime 的自动模式必须在每次响应中暴露实际模型 + 切换理由，否则用户无法审计成本与质量。

### A.4 Continue / Cline / Aider（开源 Agent）的做法（补充）

- **URL（对比）**：https://wetheflywheel.com/en/guides/open-source-ai-coding-agents-2026/ ；https://dev.to/jovan_chan_9500711396d4e6/continue-dev-vs-cline-vs-aider-2026-48ig
- **核心引用**：开源 Agent 普遍**不做智能自动路由**，而是强调"Bring Your Own Model"与多层模型配置——例如 Continue 用**小快模型做 autocomplete、大模型做 chat** 的双模型架构；Aider 支持 `model` + `editor-model`（编辑用 Haiku 级、主对话用 Opus 级）的显式分工；Cline 在侧栏手动选 provider + 模型。
- **与 slime 决策的相关性**：开源阵营验证了"**双/多模型分工（快模型做轻活、强模型做重活）**"是自动路由之外的务实替代；slime 即便不做全局 Router，也应在 Plan/检索/生成等子环节固化"用什么模型"。

### 提炼建议（slime）

1. **命名**：提供一个 `default`（系统推荐/账户默认）兜底项，再提供一个 `Auto` 智能路由项。避免含糊的 "Smart"，对齐 Claude 的 `default` + Cursor 的 `Auto`。
2. **行为**：`Auto` 给出 **Cost / Balance / Intelligence 三档优化偏好**而非具体模型；底层用分类器按任务复杂度/领域路由，并像 Cursor 一样**把缓存失效成本计入路由决策**（cache-aware）。
3. **透明度（必须）**：每次响应**回传实际模型 ID + 切换理由**（参考 OpenRouter 的 `response.model`），并在 UI 当前会话处显示"本次由 X 处理"；可借鉴 Claude 的"状态行常显当前模型 + 回退有 toast 通知"。
4. **分阶段自动**：借鉴 `opusplan`——Plan 阶段用强模型、Execute 阶段用高效模型，让用户对"哪个阶段花哪份钱"有预期。
5. **失败降级**：当 `Auto` 选中模型不可用时，回退到 `default` 并**显式通知**；企业/团队场景下允许管理员禁用某些模型并限定可选模式。

---

## 主题 B：上游模型配置自动发现

**核心问题**：添加模型时，如何从上游（Ollama / vLLM / OpenRouter / Bedrock / LiteLLM）自动拉取完整配置？拉哪些字段？缓存多久？失败怎么办？

### B.1 Ollama —— `/api/tags` + `/api/show` 隐式发现

- **URL**：Ollama 原生 API https://docs.ollama.com/api/tags ；集成方文档 https://clawdbot.sh/en/docs/providers/ollama 与 https://docs.openclaw.ai/providers/ollama
- **核心引用**：
  - **触发条件**：当设置了 `OLLAMA_API_KEY`（或 auth profile）且**未显式定义** provider 条目时，客户端从本地实例 `http://127.0.0.1:11434` 自动发现模型。
  - **拉取字段**：调用 `/api/tags` 列出模型；对每一个再调 `/api/show` **能力探测**——读取 `contextWindow` / `num_ctx`、Modelfile 参数、capabilities（**vision / tools / thinking**）。只保留**报告了 tools 能力**的模型；报告 thinking 的标记为推理模型；`contextWindow` 取自 `model_info[".context_length"]`；`maxTokens` 设为上下文窗口的 10 倍；本地模型成本全置 0。
  - **缓存/发现时机**：**启动时发现**；新增模型只需 `ollama pull`，下次即自动出现（隐式 provider 不跳过）。若显式配置 provider，则**跳过自动发现**，需手动列模型。
  - **失败降级**：未检测到时提示确认 Ollama 在运行 + 已设 key + 未显式定义 provider；`curl /api/tags` 不可达即提示连接被拒。
- **与 slime 决策的相关性**：给出"**隐式发现 vs 显式配置**"二选一、`/api/show` 探测能力、仅收 tools-capable、成本默认 0 的完整范式，可直接映射到 slime 的本地模型接入。

### B.2 OpenRouter —— `/api/v1/models` 富 Schema

- **URL**：https://openrouter.ai/docs/models
- **核心引用**：
  - 每个模型对象包含：`id`、`name`、`context_length`、**`architecture`**（input/output modalities、tokenizer、instruct_type）、**`pricing`**（`prompt` / `completion` / `request` / `image` / `web_search` / `internal_reasoning` / **`input_cache_read`** / **`input_cache_write`**，并支持 `overrides` 条件定价如长上下文/分时）、**`supported_parameters`**（tools、tool_choice、reasoning、structured_outputs、response_format…）、`top_provider`（`max_completion_tokens`、`is_moderated`）、`expiration_date`、`benchmarks`。
  - 分页（默认全量或 offset/limit），数据**实时返回**，客户端应"refresh catalog hourly; pricing updates dynamically"。
- **与 slime 决策的相关性**：这是 slime "未自定义时自动拉取"应覆盖字段的**最全清单**：上下文、定价（含缓存读写价）、能力标志（tools/reasoning/vision）、tokenizer、最大输出、弃用日期。

### B.3 LiteLLM —— `model_prices_and_context_window.json` + Catalog API + `/model/info`

- **URL**：Catalog API https://api.litellm.ai/docs ；GitHub 讨论 https://github.com/BerriAI/litellm/discussions/21029 ；Proxy 模型管理 https://docs.litellm.ai/docs/proxy/model_management
- **核心引用**：
  - **免费 Catalog API**（2500+ 模型）：每项含 context window（input/output tokens）、per-token 定价（input/output/caching/audio/reasoning）、**capability 标志**（`supports_function_calling`、`supports_vision`、`supports_audio_input`、`supports_reasoning`、`supports_prompt_caching`、`supports_web_search`、`supports_pdf_input`）、`deprecation_date`。支持按 `provider` / `supports_vision` / `supports_reasoning` 过滤。
  - **缓存策略**："Data refreshes from LiteLLM's GitHub repository every **60 seconds**."（即成本图每 60s 从 GitHub 同步一次）——这是"被动/定时刷新"的范例。
  - **Proxy `/model/info`**：返回 `max_tokens`、`max_input_tokens`、`max_output_tokens`、`input_cost_per_token`、`output_cost_per_token`、`mode`、`litellm_provider`，并允许通过 `model_info` 附加自定义元数据（团队、描述、版本）——**用户自定义可叠加在自动拉取之上**。
- **与 slime 决策的相关性**：提供"**定时（60s TTL）被动刷新 + 允许自定义覆盖**"的缓存与合并策略样板。

### B.4 vLLM —— `/v1/models` 元数据有限，需另取 tokenizer

- **URL**：https://docs.getbifrost.ai/providers/supported-providers/vllm ；vLLM 官方 quickstart https://github.com/vllm-project/vllm
- **核心引用**：
  - 标准 OpenAI 兼容 `/v1/models` 仅返回 `id`、`object`、`created`、`owned_by`，以及 vLLM 扩展的 **`max_model_len`**；**默认不含 pricing / capabilities / context 之外的富元数据**。
  - 需通过 `/tokenize`、`/detokenize`（及 `/v1/tokenize`、`/v1/detokenize`）或 `/get_tokenizer_info` 获取 tokenizer 信息；能力（如是否支持 tools）通常靠客户端配置或探测，而非 API 自报。
- **与 slime 决策的相关性**：提醒 slime——**并非所有上游都提供富元数据**。对 vLLM 这类"瘦"端点，应回退到"用默认上下文 + 显式配置补充"，不能假设一定能拉到 pricing/capabilities。

### 提炼建议（slime）

1. **拉取字段清单**（优先级）：`context_length` / `max_output_tokens` → `pricing`（input/output/**cache_read**/cache_write）→ capability 标志（**tools / function_calling / vision / reasoning / prompt_caching**）→ `tokenizer`（`instruct_type`）→ 弃用日期 `expiration_date`。对齐 OpenRouter + LiteLLM 字段集。
2. **缓存策略**：采用"**启动时拉取 + 定时被动刷新**"，TTL 建议 **30–60 秒**（参考 LiteLLM 的 60s）；对 Ollama 这类本地端点可"发现即缓存、pull 新模型即刷新"。元数据只作默认值，**允许用户自定义覆盖并持久化**（叠加而非替换）。
3. **失败降级**：上游不可达/超时 → 保留上次成功缓存（若有）并标"配置可能过期"；若无缓存 → 退回最小安全默认（如 `context_window=8192`、cost=0 对本地、`max_output` 保守值），并在 UI 提示"未能自动获取配置，请手动填写"。像 Ollama 那样区分"隐式自动发现"与"显式手动配置"两条路径。
4. **能力探测**：对 OpenAI 兼容端点（Ollama/vLLM）若 Schema 不含能力标志，应**主动发一次探测请求**（或读 `/api/show`、tokenizer 端点）判断 tools/vision 支持，避免把不支持 tool 的模型放进可 Agent 调用的列表。
5. **一致性**：把"自动发现结果"与"用户自定义"统一进一个 model 记录，运行时以"自定义优先、自动兜底"解析；变更不要求重启（参考 LiteLLM DB 存储免重启）。

---

## 主题 C：聊天界面会话切换的状态保留

**核心问题**：用户切会话时，正在流式输出/生成的会话怎么办——abort、后台继续、还是持久化恢复？输入草稿、toast 是否跨会话？

### C.1 Mozilla Firefox 内置 AI（D286405）—— 解耦流式与 UI，后台继续

- **URL**：https://phabricator.services.mozilla.com/differential/diff/1220257 （Bug 2015576, 2026-03）
- **核心引用**：
  - 目标："handle tab switching during long-running conversation responses… decouple the streaming response logic from the UI so that conversations can **continue receiving and processing tokens in the background**, even when the user navigates away."
  - 做法：把流消费循环从 UI 组件移到**数据模型**（`ChatConversation.receiveResponse(stream)`）；用 **EventEmitter** 驱动 UI 更新（token 到达才发 `message-update`）；把 `ChatConversation` 对象直接存进 **tab state**，切回时恢复活跃实例；侧边栏用 **collapsed 而非 hidden**，避免文档卸载导致后台流中断。
  - 结论：流式状态应**随会话实例持久化**，切换标签页不丢、不重连。
- **与 slime 决策的相关性**：这是"**persist & resume（后台继续 + 切回即恢复）**"的教科书级实现，最适合 Agent 这类长任务场景。

### C.2 Open WebUI（issue #21462）—— 每会话追踪 loading，加 stale-check

- **URL**：https://github.com/open-webui/open-webui/issues/21462 （2026-02）
- **核心引用**：
  - 症状：切换正在流式/刚提交的会话时出现 3 类竞态——侧边栏 spinner 停太晚、Stop 按钮/loading 图标在切回后残留、提交后立刻切换导致 loading 泄漏到错误会话。
  - 根因：异步回调引用了会随导航变化的响应式 `$chatId`；后端 `chat:active=false` 发得太晚（在后台任务之后）；缺少 **stale-check 守卫**。
  - 修复：在流式结束（而非后台任务结束）即发 `chat:active=false`；`loadChat` 捕获 `targetChatId`，每次 `await` 后 `if ($chatId !== targetChatId) return;`；用 `activeChatIds` + 未完成 assistant 消息做**复合流式检测**，确保只更新"当前正在看的会话"。
- **与 slime 决策的相关性**：给出"**per-session 状态 + 导航时 stale-check**"的反模式清单与修复范式。

### C.3 Babbily（bug fix, 2026-02）—— per-session loading

- **URL**：https://support.babbily.com/en/articles/13752679-bug-fix-multiple-threads-processing-february-17-2026
- **核心引用**："loading states are **tracked per-session**, so the spinner only shows when the chat you're currently viewing is actively streaming a response. This means you can freely switch between conversations without seeing misleading loading states."
- **与 slime 决策的相关性**：一句话点明原则——**loading 态必须绑定到具体会话对象，而非全局**。

### C.4 dark-factory（issue #206）—— 切换即重置 + abort

- **URL**：https://github.com/coleam00/dark-factory-experiment/issues/206 （2026-04）
- **核心引用**：
  - 症状：流式状态在不同会话间"bleed"——切到别的会话仍显示 stuck streaming，只有硬刷新能恢复。
  - 修复方向：`useStreamingResponse` 需接收 `conversationId` 并在其变化时**重置**（isStreaming=false、清空 streamingContent/sources）；切换时调用 **`abortStream()` + 显式 reset**；确保未完成的 `fetch`/`AbortController` 在路由变化时也被 abort，否则上一会话的 SSE chunk 会落进新会话。
- **与 slime 决策的相关性**：代表"**abort + 彻底重置**"的保守派做法——适合把"切走=放弃当前生成"作为明确语义的产品。

### C.5 服务端后台执行（通用架构）

- **URL**：https://askfilo.com/user-question-answers-smart-solutions/does-that-mean-for-the-first-chat-it-will-continue-to-3435363535343831
- **核心引用**："In most advanced AI environments, once a command is sent, the processing happens on the **server**, not your local device… Switching to a different chat session does not 'pause' the previous one. Each chat session is usually treated as an **independent instance**."（但长任务可能遇 session timeout、并发上限。）
- **与 slime 决策的相关性**：确认"生成在服务器、会话互相独立"是可行基线；slime 若后端常驻，可天然支持后台继续。

### 提炼建议（slime）

1. **生成语义二选一，但要明确**：
   - 若定位"聊天/轻交互"→ 采用 **abort + 彻底重置**（dark-factory 范式）：切走即取消当前流，`AbortController` 必须随会话销毁，避免 chunk 串台。
   - 若定位"Agent 长任务"→ 采用 **persist & resume**（Firefox 范式）：把流逻辑放进会话数据模型 + EventEmitter，切走后台继续、切回即看到已完成部分。slime 偏 Agent，**推荐后台继续**为默认，并提供"停止"显式中止。
2. **loading/streaming 状态必须 per-session 绑定**（Babbily + Open WebUI）：spinner / Stop 按钮只对"当前正在看的会话"可见；任何异步回调都要带 `targetChatId` 守卫（`if (currentChatId !== targetChatId) return;`），杜绝跨会话泄漏。
3. **输入草稿（composer draft）按会话独立保存**：切走不丢、切回还原到该会话的输入框；不要全局共享一个草稿。
4. **toast / 弹窗默认不跨会话**：瞬时通知（错误、完成提示）只在产生它的会话上下文内展示；若需"后台任务完成"全局提醒，应聚合到一处（如侧栏小红点），而非在每个会话里冒泡。
5. **持久化颗粒度**：会话的 `messages` 列表务必落库（参考 ChatGPT/Claude 机制），切回即加载；进行中的生成若选后台继续，应把"已流式到的部分"也实时追加进该会话记录，保证刷新/崩溃后可恢复。

---

## 主题 D：缓存命中率的实时可视化

**核心问题**：显示哪些缓存指标？显示位置？实时性如何（轮询/SSE）？

### D.1 Anthropic Prompt Caching —— 用法字段与命中率算法

- **URL**：官方文档 https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching ；实践指南 https://blog.devops-monk.com/2026/05/claude-prompt-caching-guide
- **核心引用**：
  - API `usage` 返回字段：**`input_tokens`**、**`cache_creation_input_tokens`**、**`cache_read_input_tokens`**、`output_tokens`，以及 `cache_creation` 子对象（`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`）。
  - **命中率算法**（devops-monk）：`total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`；`hit_rate = cache_read_input_tokens / total`。"A well-tuned implementation targeting a large stable prefix should show **80–95%** of tokens as cache reads after the first request."
  - 缓存失效排查：`cache_read_input_tokens` 持续为 0 → 多半是阈值不足（<1024 token 被忽略）、TTL 过期（默认 5 分钟）、或前缀哈希不匹配（空白/格式变化破坏缓存）。
  - TTL：默认 **5 分钟**，可付费升级 **1 小时**（`ttl: "1h"`）；5 分钟缓存"每次使用免费刷新"，1 小时适合 5 分钟~1 小时之间的访问节奏。
- **与 slime 决策的相关性**：这是**必须展示的原始指标来源**——slime 要可视化，底层就是这三个 token 计数；命中率=读缓存/(输入+写+读)。

### D.2 Helicone —— 代理层 cache analytics

- **URL**：对比评测 https://stackpulsar.com/blog/llm-observability-tools-2026 ；https://aitoolpick.org/blog/best-llm-observability-tools-2026
- **核心引用**：
  - Helicone 是**开源代理层**，只需改 OpenAI base URL + 加 API key header，即自动记录每次调用；提供 **request logs、token counts、latency tracking、cache analytics**、请求过滤与限流。
  - "If you are running a single-model application… Helicone's proxy swap takes five minutes and gives you full request logs, token counts, latency tracking, and **cache analytics**."
  - 注意：2026-03 被 Mintlify 收购，进入维护模式，功能迭代放缓。
- **与 slime 决策的相关性**：展示了"**代理层无侵入采集缓存指标**"的产品形态；slime 若自带网关，可直接在网关层聚合 cache 指标，无需每个前端埋点。

### D.3 Portkey —— 语义缓存 + 节省金额

- **URL**：https://aitoolpick.org/blog/portkey-review-2026
- **核心引用**：
  - Portkey 的 **semantic cache** 使 25–35% 请求命中缓存；文中给出可量化节省："30% cache hit rate saves ~$6.75/day = $202/month"（Claude Sonnet 场景）。
  - 定位：唯一同时把 **AI 网关（路由/回退/缓存）+ 可观测** 合一的产品；缓存不是魔法——低多样性输入（代码生成、创意写作）缓存收益极小。
- **与 slime 决策的相关性**：提示 slime 可视化**不应只秀命中率，还要折算成"省了多少钱 / 省了多少延迟"**，这对用户更有感知。

### D.4 可观测性通用清单（LangSmith / Langfuse / TheRouter）

- **URL**：https://therouter.ai/blog/llm-api-observability-monitoring-tools-comparison-2026
- **核心引用**：生产 LLM 可观测"必须追踪的指标"清单中明确列出：
  - **Latency per model/provider**（含流式 time-to-first-token）；
  - **Token usage and cost** —— input/output/**cached tokens**/cost per request，按 feature/user/team 拆分；
  - **Error rates by type**（429/500/400 区分处理）；
  - **Fallback frequency**；
  - **Output quality scores**；
  - **Cache hit rate** —— "if you use prompt caching (OpenAI, Anthropic, DashScope) or gateway-level caching (Helicone, Portkey), track the savings."
- **与 slime 决策的相关性**：确认 **cache hit rate 应和 token 成本、延迟、回退率并列为一级指标**，放在统一可观测面板而非孤立弹窗。

### 提炼建议（slime）

1. **最关键 2–3 个指标**（必展示）：
   - **缓存命中率**（hit rate = `cache_read_input_tokens / (input + cache_creation + cache_read)`），目标参照 80–95%；
   - **缓存读写 token 数**（`cache_read_input_tokens` / `cache_creation_input_tokens`）——让用户看见"多少 token 走了便宜的缓存"；
   - **节省金额（或节省延迟）**——把命中率折算成 $ 与 TTFT 缩短，像 Portkey 那样给用户体感价值。
2. **显示位置**：
   - **常驻侧栏/状态栏小标**（每次响应后更新当前会话的命中率与读缓存 token），仿 Claude.ai 把 cache 信息贴在使用处；
   - **详情放 modal / 设置面板**：点开看单次请求明细（input / cache_creation 5m / cache_creation 1h / cache_read / output 分项），对齐 Anthropic `usage` 结构；
   - 若 slime 有全局可观测面板，把 **cache hit rate 与 token 成本、延迟、回退率并列**为一等公民（参考 TheRouter 清单）。
3. **实时性**：每次 API 响应已自带 `usage`，**无需轮询**——在 SSE/流式完成的 `usage` 块到达时即时更新当前会话指标即可；若要跨会话聚合（如"今日总节省"），用后端轻量聚合 + 打开面板时拉取，不必常驻 SSE。
4. **透明诊断**：当 `cache_read_input_tokens` 持续为 0，主动提示可能原因（阈值不足、TTL 过期、前缀变化），帮用户调优，而非只秀一个 0% 命中率。
5. **避免误导**：命中率要基于"本次请求的真实 token 构成"计算，且明确区分 **5 分钟缓存 vs 1 小时缓存**的写入成本，避免把"写了缓存但没命中"误算成收益。

---

## 附录：来源索引

| # | 主题 | 来源 | 类型 | 日期参考 |
|---|------|------|------|----------|
| 1 | A | Claude Code model-config 文档 | 官方文档 | 2026 |
| 2 | A | Cursor Router 博文 + 文档 | 官方博客/文档 | 2026-07 |
| 3 | A | OpenRouter Models 文档 + Auto Router | 官方文档 | 2026 |
| 4 | A | Open-Source AI Coding Agents 2026 对比（Continue/Cline/Aider） | 工程博客 | 2026 |
| 5 | B | Ollama `/api/tags` + `/api/show`；Clawdbot/OpenClaw 集成 | 官方 API + 集成文档 | 2025-2026 |
| 6 | B | OpenRouter `/api/v1/models` Schema | 官方文档 | 2026 |
| 7 | B | LiteLLM Catalog API + Proxy 模型管理 | 官方文档/GitHub | 2026 |
| 8 | B | vLLM `/v1/models` + tokenizer 端点 | 官方文档 | 2026 |
| 9 | C | Mozilla Firefox AI D286405（流式解耦） | 代码评审/Phabricator | 2026-03 |
| 10 | C | Open WebUI issue #21462（竞态修复） | GitHub Issue | 2026-02 |
| 11 | C | Babbily bug fix（per-session loading） | 产品更新 | 2026-02 |
| 12 | C | dark-factory issue #206（切换重置+abort） | GitHub Issue | 2026-04 |
| 13 | C | 服务端后台执行架构说明 | 问答/科普 | 2026 |
| 14 | D | Anthropic Prompt Caching 文档 + devops-monk 实践 | 官方文档/博客 | 2026 |
| 15 | D | Helicone 代理层 cache analytics | 评测/文档 | 2026 |
| 16 | D | Portkey 语义缓存与节省 | 评测 | 2026 |
| 17 | D | TheRouter LLM 可观测指标清单 | 工程博客 | 2026 |

> 说明：以上链接均来自本次 WebSearch/WebFetch 实际返回，未凭记忆编造。部分聚合评测站（aitoolpick / stackpulsar / therouter）为二手来源，用于交叉印证产品行为；一手决策依据优先采用官方文档与 GitHub Issue/Diff。
