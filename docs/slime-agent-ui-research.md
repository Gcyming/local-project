# 主流 Agent 产品「思考 / 正文 / 工具调用」UI 编排调研报告

> 目标：为 slime（Electron 桌面 Agent IDE，上下文压缩型，时间线制聊天界面）的重构提供一手依据。
> 调研日期：2026-09-24
> 原则：**结论 + 依据 + 来源**；严格区分「查到的原文」与「我的推断」。所有关键论断均附可核查 URL / 源码路径。

---

## 0. 执行摘要（给赶时间的你）

| 问题 | 主流共识 | 对 slime 的直接含义 |
|---|---|---|
| 思考 vs 正文的时序 | **推理模型下，思考流式显示、正文等思考结束（或该阶段结束）才开始**。二者在**协议层就是不同字段/不同 content block**，天然可分离渲染 | slime 现在"思考途中同步输出正文"是**逆主流**的，且技术上并非不可避免——上游给的就是分离字段，是渲染层把它们混在了一起 |
| 工具调用的归属 | **归组进"阶段/轮次"**是主流；平铺独立成列是反模式。代表：ChatGPT「Worked for 2m」、Cursor「Worked for…」折叠组、Claude Code `collapseReadSearchGroups`/`groupToolUses`、Cline `groupLowStakesTools` | slime 现在"工具调用在时间线上独立成列"= 业界公认的"混乱桌面"缺陷，改造方向明确 |
| token 实时监测 | **协议层没有任何办法逐 chunk 拿到精确 output token**；usage 只在流末尾（或 message_delta）出现。所有产品的"实时计数"都是**本地估算**，精确值事后回填 | slime 右侧栏"只有推理 token 能实时刷新、正文靠 ≈4 字符/token 估算"——这**不是 bug，是业界唯一可行做法**；问题在于没把"估算值 vs 精确值"在 UI 上区分表达 |
| 流式期 markdown | **"渐进渲染 + 未闭合语法保护"是标准做法**：按块边界提交，未闭合代码围栏临时补 `\`\`\``，节流重渲染 | slime 若在流式期裸解析 markdown，露 `**`/`#`/`|` 是必然的；有成熟标准方案 |

**一句话结论**：slime 的三个"问题"里，只有第 3 个（token）是物理上无法完美解决的；第 1、2 个是**渲染层设计选择**，业界已有成熟范式，且上游协议已经为正确做法铺好了路。

---

## 1. 思考与正文的时序编排

### 1.1 关键事实：分离是**协议层**的，不是 UI 层的

这是整份报告最重要的地基。主流推理 API 在流式响应里，思考与正文**本来就是两个不同的字段 / content block**：

| 厂商 | 思考字段 | 正文字段 | 原文依据 |
|---|---|---|---|
| DeepSeek | `delta.reasoning_content` | `delta.content` | 官方 AsyncAPI：*"The `deepseek-reasoner` model additionally emits a `reasoning_content` field in delta chunks during the chain-of-thought phase, followed by `content` deltas for the final answer."*（apis.io DeepSeek AsyncAPI，标注 *"no fields have been inferred or fabricated beyond the official docs"*） |
| Anthropic | `thinking_delta` 事件（在 `content_block_delta` 内，`delta.type == "thinking_delta"`） | `text_delta` | 官方 Streaming 文档：*"When using extended thinking with streaming enabled, you'll receive thinking content via `thinking_delta` events."*（platform.claude.com/docs/en/build-with-claude/streaming） |
| OpenAI o 系列 | reasoning summary（`response.reasoning_summary_text.delta` / Responses API） | `response.output_text.delta` | OpenAI Cookbook / Responses API 事件流 |
| Gemini | `thoughts_token_count`（usage 层面）/ thought parts | `candidatesTokenCount` / parts text | Firebase 官方：*"`thoughts_token_count`: token count of any thinking tokens"*（firebase.google.com/docs/ai-logic/count-tokens） |

**DeepSeek 的原文尤其关键**（dev.to/multigrid 引官方行为）：
> "the transition between them is **the signal that thinking has finished** — the reasoning deltas stop and content deltas begin, **with no marker in between beyond the field name changing**."
> "because the trace and the answer are different fields rather than different regions of one string, **you can render them into different parts of the page from the first chunk**. You do not need to buffer until a closing tag arrives to know which is which."

**→ 这直接否定了一个常见借口**："模型是交错吐的，所以 UI 只能交错显示。" 事实是：**字段名本身就带语义**，UI 完全可以（也应该）把 `reasoning_content` 和 `content` 分流到两个渲染区。

### 1.2 各产品具体做法

#### Claude / Claude Code（Anthropic）
- **claude.ai**：思考折叠为 `Thinking` 区块（显示耗时如 "Thinking 1m 21s"），**在最终回复之上**，点击展开。Anthropic 3.7 System Card 原文：*"Claude's reasoning in extended thinking appears in **a separate section before its final response**."*
- **Claude Code（CLI）**：**默认折叠**。官方 `model-config` 文档原文：
  > "**Claude Code collapses thinking output by default.** Press `Ctrl+O` to toggle verbose mode and see the reasoning as gray italic text."
- Anthropic 还在 2026-02-12 通过 beta header `redact-thinking-2026-02-12` **默认隐藏思考**。Boris Cherny（Claude Code 作者）原话：
  > "This beta header hides thinking from the UI, since most people don't look at it. It does not impact thinking itself... **It is a UI-only change.**"
- 设计理由（官方口径）：**延迟收益 + UX 清晰**——隐藏思考后跳过"为流式展示而生成摘要"的开销，降低 time-to-useful-output；且原始 reasoning 含大量"试错分支"，暴露出来反而误导用户。

#### ChatGPT（OpenAI）
- 推理模型的思考呈现为**可折叠块**，显示为 "Thinking" / "Thought for Xs" 级别的**摘要**（不是原始 CoT）。
- **摘要机制是刻意的**：OpenAI 明确不返回原始 chain-of-thought。Simon Willison 引 OpenAI 原文：
  > "we have decided **not to show the raw chains of thought to users**"（安全 + 竞争壁垒双理由）。
- o3-mini 起改为"更详细的摘要"，但仍是后处理产物。TechCrunch 引 OpenAI 发言人：
  > "o3-mini can 'think freely' and then **organize its 'thoughts' into more detailed summaries**... we've added an additional post-processing step where the model reviews the raw chain of thought, removing any unsafe content, and then simplifies any complex ideas."
- **形态**：正文**在思考块之后**统一出现；思考块默认折叠。正文不会与思考逐字交错刷屏。

#### Cursor
- **官方论坛运维原话（一手，极具参考价值）**：
  > "**Thoughts stream open while the model is thinking, then fold into a 'Thought for Xs' line when that step finishes**, and you expand them again with a click."
  > "In the Agents Window, open Settings → Appearance → Agent Conversations, and set **Tool Call Density** to **Detailed**. Edits and terminal commands then **render inline instead of being folded into a 'Worked for…' group**."
  （forum.cursor.com/t/how-do-i-view-thoughts-in-expanded-mode/171250）
- **→ 这是"阶段化"的最佳一手证据**：Cursor 的生命周期是「**思考流式展开 → 该 step 结束后折叠为 'Thought for Xs'**」，并且工具活动默认折叠进 **"Worked for…" 组**，可通过 Tool Call Density（Compact / Balanced / Detailed）调节粒度。
- Cursor 3.4 changelog 原文（繁中）：*"你可以自訂工具呼叫的密度，控制每則回應中要顯示多少代理的工具活動：**Compact** 顯示精簡結果，只保留最少的工具痕跡；**Balanced** 包含重要的中間步驟；**Detailed** 提供近乎完整的逐步上下文"*（cursor.com/zh-Hant/changelog/3-4）
- 注意 Cursor changelog 还提到修过 *"thought-chunk 轉送問題"*——说明思考与工具事件在传输层就是分离的 chunk 类型。

#### Cline（VS Code，开源，可查源码）
- **Plan / Act 两模式**，思考与"做事"分离（cline.bot/ide 原文：*"PLAN · ACT — Separate thinking from doing."*）
- **关键源码证据**：Cline v3.50.0 引入 `groupLowStakesTools`（路径 `webview-ui/src/components/chat/chat-view/utils/messageUtils.ts`），**把 reasoning 消息与低风险工具调用（readFile / searchFiles 等）归组**。GitHub Issue #8636 维护者原文：
  > "introduced a new `groupLowStakesTools` function... This function has a bug where standalone reasoning messages that are not followed by low-stakes tools are being silently dropped."
  > 受影响版本：Working v3.45.1 / Broken v3.50.0
- 该 issue 里 Cline 产品负责人 Renee 的回应也很关键（设计意图）：
  > "It is an **intentional UI change** given the thinking block can be distracting sometimes with rare user clicking in."
- 每步是一个 **"API Request" 可展开行**（Cline 时间线里每个 API 请求可展开看该次调用的 token / cost）——见 whoburnedmore 指南：*"Each 'API Request' entry in the timeline can be expanded to show the tokens and cost for a single call."*

#### Claude Code（CLI）——工具归组的另一份强证据
DeepWiki 对 Claude Code 源码的分析（文件路径可核）：
- `src/utils/collapseReadSearch.ts` → `collapseReadSearchGroups`：
  > "To reduce visual noise, the system **automatically collapses consecutive 'Read' or 'Search' operations into a single summary line**."
- `src/utils/groupToolUses.ts`：把并行工具调用聚合为单个视觉块（`GroupedToolUseContent`）。
- `src/components/Messages.tsx` 负责 grouping + 虚拟化；`StreamingMarkdown` 提供增量 markdown 渲染。
- 主视图只显示 *"Worked for Xs" / "Crunched for Xs"* 级别的汇总行，详细轨迹藏在 `Ctrl+O`（见 claudeissues #42824）。

#### Windsurf / Cascade
- Cascade 的形态是**"可见推理的步骤流"**：先出 plan（含 Todo list），再逐步执行。webcoderspeed 的实测记录里，Cascade 的显示是「**说明 → [工具动作] → 说明 → [工具动作] …**」的**阶段序列**，而非"思考列 + 工具列"两个平行轨道：
  > Cascade's visible reasoning: *"I'll read the project structure first..."* `[reads src/middleware/]` *"The project uses Express.js..."* `[reads existing middleware files]` *"I see Redis is already configured..."* …
- 官方文档：单次 prompt 最多 25 次工具调用；三种自动执行级别 Off / Auto / Turbo；每步可 revert（checkpoint）。
- **注意**：Windsurf 的"推理说明"是**面向用户的进度叙述**，不是原始 CoT。

#### Devin / Manus
- **Manus**：多代理（Planner / Executor / Knowledge），UI 左对话 + 右终端（虚拟机）双栏；任务被**分解为子任务序列**在 UI 上推进。21 世纪经济报道原文：
  > "当开始执行任务后，左面开始**识别意图、制定执行步骤**以及开始搜索、调用所需的各类工具。右面的终端相当于一个虚拟机。"
- **Devin**：以 task / step 为组织单位，执行轨迹按步推进（Plan → 执行 → 自查），差异以 PR / diff 交付。
- 共性：**以"轮次/阶段"为 UI 单位**，工具调用是阶段内的动作，不是并列的第二条时间线。

#### OpenAI Codex CLI
- 官方 Interactive mode 文档：主会话视图 contains 五类内容——User messages / Agent messages / **Command execution** / **File changes** / **Reasoning（when available）**，*"Content streams in real-time as the agent works."*
- 有专门的 reasoning 配置项（`~/.codex/config.toml`）：`hide_agent_reasoning`、`show_raw_agent_reasoning`、`model_reasoning_summary`（`auto` / `concise` / `detailed` / `none`）。**默认 `false`（即默认隐藏 reasoning）**。
- 每个 step 也带审批门（Command Approval Required 内联卡片）。

#### Aider（CLI）
- **reasoning 与正文走两个通道分别处理**：DeepWiki 对 `aider/reasoning_tags.py` 的分析：
  > "**Attribute-based (OpenAI, Claude): The API returns reasoning_content as a separate field**; Tag-based (DeepSeek, QwQ): Reasoning is wrapped in XML tags."
  > 两者都以 **视觉标记**（`REASONING_START`/`REASONING_END`）显示，然后 `remove_reasoning_content()` 把它**从对话历史中剥离**。
- Aider 的 `--architect` 模式更彻底：**thinking model 出计划 → editor model 出代码**，两阶段串行。

### 1.3 结论（问题 1）

**主流做法（除少数 CLI 的 verbose 模式）**：
1. **思考与正文在渲染上分流**，且**正文不在思考途中就大段刷出**——要么等思考块关闭（ChatGPT/Claude/Cursor），要么以"step 结束 → 折叠"的节奏推进（Cursor）。
2. **折叠是默认**，展开是 opt-in（Claude Code `Ctrl+O`、ChatGPT 点击、Cursor 点击）。
3. **思考多为"摘要"而非原始 CoT**（OpenAI/Anthropic 都明确只给 summary）。
4. **思考有阶段感**：Cursor "步骤结束即折叠成 'Thought for Xs'"；Codex CLI 区分 reasoning summary 粒度。

**个别反例**：Aider 在终端里可以把 reasoning 逐步打印（`REASONING_START/END` 标记），但这是 CLI 的调试取向，不是主流聊天 UI 做法；且 Aider 同样把它从历史里剥离。

---

## 2. 工具调用在 UI 上的归属

### 2.1 两种范式

| 范式 | 代表 | 形态 |
|---|---|---|
| **A. 独立时间线节点平铺** | ❌ 较少见（多为早期/简陋实现），**slime 现状** | 思考、工具、正文混在一条竖列里，谁先来谁先占位 |
| **B. 归组进「阶段/轮次」** ✅ 主流 | ChatGPT、Cursor、Claude Code、Cline、Windsurf、Devin、Manus、Codex CLI | 一轮 = 一个可折叠单元，内含「思考 + 工具调用 + （该轮的）正文」 |

### 2.2 具体产品 + 具体形态（可核查）

| 产品 | 单元名 | 具体形态 | 来源 |
|---|---|---|---|
| **ChatGPT** | "Thinking" / "Thought for Xs" 折叠块 | 思考块位于正文之前，默认折叠；工具/搜索活动归入思考过程展示 | 3.7 System Card 描述 + startupfortune 报道 |
| **Cursor** | "Thought for Xs" / **"Worked for…"** 组 | 思考流式展开 → 该 step 结束折叠成 "Thought for Xs"；工具活动默认折叠进 "Worked for…"；密度可调（Compact/Balanced/**Detailed** 时工具内联展开） | forum.cursor.com/t/171250；cursor.com/zh-Hant/changelog/3-4 |
| **Claude Code** | "Worked for Xs" 汇总行 + 分组 | `collapseReadSearchGroups` 把连续 Read/Search 折叠成一行；`groupToolUses` 聚合并行工具；详细内容 `Ctrl+O` 展开 | deepwiki Claude Code 源码分析；claudeissues #42824 |
| **Cline** | "API Request" 可展开行 + `groupLowStakesTools` | 每个 API 请求是一个可展开时间线行（含该次 token/cost）；reasoning 与低风险工具（read/search）归同一组 | GitHub Issue #8636（含源码函数名） |
| **Windsurf/Cascade** | 步骤流（plan + todo + 逐步动作） | 「说明 → 工具动作 → 说明 → 动作」序列，max 25 次工具/prompt，每步可 revert | docs.windsurf.com/plugins/cascade；webcoderspeed 实测 |
| **Devin / Manus** | 子任务 / step | 任务分解为子任务序列推进；Manus 左对话右终端双栏 | 21jingji；theplanettools.ai 对比 |
| **Codex CLI** | reasoning summary + command/file-change 项 | 五类内容并列渲染但按事件流推进；reasoning 默认隐藏，可配粒度 | mintlify.wiki/openai/codex/concepts/interactive-mode |

### 2.3 一个重要的反面教材（正好印证 slime 的问题）

Cursor 官方把 **Tool Call Density** 做成一个用户可调项，正是为了对抗"工具痕迹太多导致刷屏"。其 Compact 档原文是 *"**只保留最少的工具痕跡**"*。Claude Code 把大部分工具痕迹藏进 `Ctrl+O`。**没有任何主流产品把工具调用作为与思考平级的第二条独立列长期暴露。**

### 2.4 结论（问题 2）

- **是的，"该轮次的思考 + 工具调用 + 正文打包成一个可折叠单元"是主流**，代表即 Cursor "Worked for…" / Claude Code 分组 / Cline `groupLowStakesTools` / ChatGPT "Worked for 2m"。
- 平铺独立成列 = 反模式（slime 现状）。
- **粒度是用户可调的**（Cursor 三档、Codex CLI summary 四档），说明"永远展开"或"永远折叠"都不对，应给用户开关。

---

## 3. token 消耗实时监测的真相

### 3.1 核心结论：**流式期无法逐 chunk 拿到精确 output token**

这是协议层事实，各厂一致：

**OpenAI（Chat Completions）原文**（developers.openai.com cookbook + API reference）：
> "You can get token usage statistics for your streamed response by setting `stream_options={"include_usage": True}`. When you do so, an **extra chunk will be streamed as the final chunk**... The value for the `usage` field on **all chunks except for the last one will be null**. The `usage` field on the last chunk contains token usage statistics for the entire request. The `choices` field on the last chunk will always be an **empty array `[]`**."
> API reference 补充警告：*"**If the stream is interrupted, you may not receive the final usage chunk** which contains the total token usage for the request."*

**Gemini 官方原文**（firebase.google.com/docs/ai-logic/count-tokens）：
> "**When streaming output, the `usageMetadata` attribute only appears on the last chunk of the stream. It's nil for intermediate chunks.**"
> 且字段分层：`thoughts_token_count`（推理 token，独立字段）、`candidates_token_count`（**不含** thinking tokens）、`total_token_count`（含 thinking）。

**Anthropic 官方原文**（platform.claude.com/docs/en/build-with-claude/streaming）：
> "The token counts shown in the `usage` field of the **`message_delta`** event are **cumulative**."
> （注意：`message_delta` 出现在 content blocks **之后、message_stop 之前**——即"接近末尾"，不是逐 chunk。）

**DeepSeek**：官方 AsyncAPI 描述 usage 同样在 *"The final data chunk before the terminator may include a populated `usage` object when `stream_options.include_usage` is set to true."*

**社区一手确认**（OpenAI Developer Community #738156，OpenAI 员工 owencmoore 发布）：
> "Previously this usage data **was not available** when using streaming."

### 3.2 `reasoning_tokens` 是不是独立字段？是不是只有流末尾才有？

**是独立字段，且只有末尾/接近末尾才有。** 多份原文：

- OpenAI usage 嵌套结构（multigrid.ai 引官方示例）：
  ```json
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 4400,
    "total_tokens": 5600,
    "completion_tokens_details": { "reasoning_tokens": 4000, ... }
  }
  ```
  且关键关系：`completion_tokens = reasoning_tokens + visible answer tokens`——**reasoning_tokens 是 completion_tokens 的子集**，不是额外项（别重复计费）。
- OpenAI API reference 明确 `completion_tokens_details.reasoning_tokens`（optional number）。
- Gemini 有独立的 `thoughts_token_count`。
- OpenAI 社区（#1105907）确认：o1-mini/o1-preview **早期根本不支持 streaming**；且 *"logprobs does NOT expose thinking tokens"*，只能从 `usage.completion_tokens_details.reasoning_tokens` 拿计数。

**⚠️ slime 现状对照**：报告称"只有推理 token 能实时刷新"。按上述协议事实，**这几乎不可能来自上游逐 chunk 推送**——更可能是 slime 通过某种方式（模型名/参数/特殊渠道）拿到的近似，或是对 `reasoning_content` 字符流的本地估算。**建议核查 slime 的这段实现**（见 §5 行动项）。

### 3.3 业界产品怎么做"实时计数"？——**全是估算 + 事后回填**

**Cursor 的混合策略（最完整的公开描述）**（CSDN 技术文，描述 `agent-cursor` 插件逆向 Cursor 行为）：
- **第一阶段（秒级）**：本地读消息文本，用 `Token数 ≈ 字符长度 / 4` **快速估算**，几秒内先显示。
- **第二阶段（分钟级）**：模拟浏览器认证，定时（默认每 5 分钟）拉取服务端生成的用量 CSV，拿到**精确 token**（含 prompt/completion/cache read/cache write），用唯一 session/bubble ID **覆盖**本地估算值。
- 原文：*"单纯依赖本地数据或服务器数据都有缺陷。本地数据获取快，但 Token 数可能是粗略估算；服务器数据精确，但存在延迟。"*

**Cline 的做法**：
- Task header 显示 running token ↑（input）/ ↓（output）/ cost / cache read/write，**"updates after every model turn"**。
- 但官方定位是估算：*"the dollar figure in the sidebar is **an estimate** Cline computes from the provider's published per-token prices. The authoritative charge is whatever your model provider records."*（whoburnedmore）
- Fast.io 原文更直白：*"Cline displays these metrics **retrospectively upon receiving completed API turn responses**, providing **accurate accounting**... rather than **speculative pre-flight estimates**."*
- 另有中文排查文：*"Cline 会在对话框下方显示当前会话累计的 context token，这个数字是 **Cline 自己估算的，不是模型返回的精确值**。"*

**X / 行业通用**：`≈4 字符/token`（英文经验值）就是"业界通用快速估算法"（CSDN 原文：*"插件采用了一个业界通用的快速估算法：Token数 ≈ 文本字符长度 / 4"*）。

### 3.4 有没有权威来源说明"流式实时 token 只能是估算"？

**有，且是最强证据：官方 API reference 的字段语义本身。**

- OpenAI：非末 chunk 的 `usage` **恒为 `null`**（API reference 原文）。字段为 null 意味着**协议上不存在**逐 chunk 精确计数。
- Gemini：*"`usageMetadata` only appears on the last chunk... **It's nil for intermediate chunks**."*
- 因此，"流式中途显示精确 output token"在协议层**不可能**——要么等末尾，要么本地估算，要么用第三方 tokenizer（tiktoken）对已收到的文本做**增量重算**（仍是"对已到文本的精确计数"，不等于"对模型已生成 token 的精确计数"，因为流式传输的 chunk 边界 ≠ token 边界；Gemini 文档明说 *"**Chunk boundaries are not token boundaries**"*）。

> **推断（明确标注）**：tiktoken 增量重算能给出"已收到文本的精确实 token 数"，但对**推理 token 无效**（推理文本要么不被返回、要么是摘要），也对"未到达的 token"无效。所以真正精确的 **output total** 只能等末尾。任何声称"实时精确 output token"的产品，要么在撒谎，要么指的是"对已落文本的 tokenizer 计数"。

---

## 4. 流式期 markdown 渲染

### 4.1 问题本质（来源：engineersofai.com/docs/ai-engineering/ai-product-engineering/streaming-ux-for-llms）

原文精准描述了 slime 的困境：
> "A `**bold**` span won't render correctly if the stream stops after `**bo`. A code block opened with ` ``` ` won't render correctly until the closing ` ``` ` arrives. The naive approach — re-rendering the full response through a Markdown parser on every token — produces **constant visual glitches: text flickering between raw syntax and rendered HTML, code blocks half-opening and half-closing, headers appearing and disappearing.** This is jarring and makes the streaming experience feel broken."

### 4.2 标准做法：**渐进渲染 + 未闭合语法保护**（不是"等整块再渲染"）

核心思想（同源）：
> "Markdown syntax is **line-oriented**. Most Markdown constructs (paragraphs, headers, list items, code blocks) are delimited by double-newlines or line boundaries. We can **safely render everything up to the last double-newline boundary**, and show the in-progress text of the current paragraph as **plain text**."

**两条成熟技术路线**：

**路线 A — "安全边界提交法"**（engineersofai / nepexgroup）：
1. 用 `\n\n`（段落边界）切分；
2. **完整段落**用 react-markdown 渲染（语法已闭合，安全）；
3. **最后一个未完成段落**先以**纯文本**渲染 + 光标；
4. 流结束时整体切回 markdown。
5. 性能：memoize 已完整段落，只重渲染最后一段。

**路线 B — "未闭合围栏临时闭合法"**（ossaihub / n4n.ai，生产中最常见）：
```js
function normalizePartialMarkdown(raw) {
  const fenceCount = (raw.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {   // 奇数 = 处在未闭合代码块内
    return raw + "\n```\n";      // 临时补一个闭合围栏，只为预览
  }
  return raw;
}
```
> 原文：*"If we're inside an open code fence (odd number of ` ``` ` so far), **close it temporarily so syntax highlighter renders it as a partial code block**."* / *"Half-rendered fences. Streaming partial code looks ugly — Starter handles this — adds closing fence during streaming."*
- 保留 `rawRef` 不动，最后完成后用原始文本渲染。

**必配工程措施**（多源共识）：
- **节流重渲染**：`requestAnimationFrame` 或 50ms debounce（>50 tokens/s 会卡顿）。原文：*"Parsing markdown on every token (often 10–30 per second) wastes CPU and causes jank."*
- **不依赖换行分块**：*"Do not rely on readline() or newline splits — tokens can arrive mid-line."*
- **XSS 防护**：`rehype-sanitize`（AI 生成内容也建议过一遍）。
- **表格 `|` 的特例**：表格在行未闭合时露 `|` 是最常见的视觉瑕疵；"段落边界提交 + 未闭合行当纯文本"可缓解。

### 4.3 产品侧的做法

- **Claude Code**：源码有 `StreamingMarkdown`，*"provides **incremental rendering of markdown tokens**, including support for tables and code blocks with syntax highlighting"*（deepwiki Claude Code）。
- **Codex CLI**：用 `marked` + `marked-terminal`，逐 item 渲染，**长输出截断**（>4 行只显示前 4 行）——终端场景的降噪策略。
- **社区共识**：react-markdown（基于 remark）**对未闭合语法不抛异常**（CommonMark 解析器天然宽容），但可能渲染出"破碎"结果，所以仍需 normalize 步骤。原文：*"react-markdown (built on remark) will not throw on an unclosed `*` or a missing link target—it renders what it can."*

### 4.4 结论（问题 4）

- **不是"等完整块再渲染"**（那样首字延迟太大），而是 **"渐进渲染 + 未闭合语法保护 + 节流"**。
- 标准手段：段落边界提交 / 未闭合围栏临时闭合 / 最后一段纯文本兜底 / rAF 节流。
- slime 若想根治"露 `**`/`#`/`|`"，应采用路线 A 或 B，而不是裸解析累积串。

---

## 5. 给 slime 的取舍建议

### 5.1 适合桌面 Agent IDE 的做法（建议采纳）

| # | 做法 | 理由 | 参考 |
|---|---|---|---|
| 1 | **思考与正文严格分流渲染**（不同区域，非交错） | 协议层字段已分离，无技术障碍；交错刷屏是纯设计缺陷 | DeepSeek `reasoning_content` / Anthropic `thinking_delta` |
| 2 | **思考默认折叠，正文在思考/阶段结束后才作为主内容推进** | 主流一致；减少干扰、降低 time-to-useful-output | Claude Code 默认折叠；ChatGPT/Cursor 折叠块 |
| 3 | **工具调用归组进"轮次/阶段"卡片**，不做独立列 | 反"混乱桌面"的核心改造 | Cursor "Worked for…"；Claude Code `groupToolUses`；Cline `groupLowStakesTools` |
| 4 | **提供"密度/详细度"用户开关**（Compact / Balanced / Detailed） | 不同用户对工具痕迹容忍度不同；主流都在做 | Cursor Tool Call Density；Codex CLI `model_reasoning_summary` 四档 |
| 5 | **token 计数区分"估算值"与"精确值"**：流中显示估算（带 `≈` 或灰色/斜体），流末用精确 usage 覆盖 | 这是唯一诚实的做法；Cursor/Cline 都这么做 | Cursor 两阶段；Cline "estimate" 定位 |
| 6 | **精确 usage 从流末尾 chunk 取**（`stream_options.include_usage` / `message_delta` / Gemini 末 chunk），并处理"流中断拿不到 usage"的降级 | 官方原文警示流中断会丢 usage chunk | OpenAI API reference |
| 7 | **markdown 渐进渲染 + 未闭合保护 + 节流** | 根治露符号；有成熟实现 | engineersofai / ossaihub / n4n.ai |
| 8 | **思考展示"摘要"而非原始 CoT**（若上游给的是摘要），并对 reasoning token 单独计数展示 | reasoning token 计费但不可见，需在 UI 明示"这部分你看不到但花钱了" | Anthropic 计费说明；OpenAI reasoning_tokens 子集关系 |

### 5.2 不适合 / 需谨慎的做法

| 做法 | 为什么不建议 |
|---|---|
| 把工具调用作为独立时间线列长期平铺 | 主流已全部放弃；用户明确抱怨"从没清理过的桌面" |
| 流式中途用本地估算值**冒充**精确值 | 会误导（Cline 明确标注是 estimate 而非精确值）；且估算对 reasoning token 完全无效 |
| 期望逐 chunk 拿精确 output token | 协议层不可能（OpenAI 非末 chunk usage=null；Gemini 中间 chunk nil） |
| 等整块思考结束才显示任何东西 | 首字延迟过大，用户失去"它在动"的反馈；正确做法是**折叠区流式展开 + 正文区等待** |
| 暴露原始 chain-of-thought | OpenAI/Anthropic 都刻意不返回；且原始 CoT 含试错分支，会误导用户 |

### 5.3 slime 现有"时间线制"的改造路线（具体）

**现状 → 目标**：

```
现状（混乱）                      目标（阶段化）
─────────────────────           ─────────────────────────
[思考 chunk 流]                   ┌─ Turn / Step 卡片 ─────────┐
[正文 chunk 流]  ← 交错           │ ▼ Thinking（流式展开中）   │
[工具调用列]     ← 平级独立        │   ...                      │
[思考 chunk 流]                   │   （step 结束→折叠为        │
[工具调用列]                       │    "Thought for 12s"）     │
[正文 chunk 流]                   │ ▶ 工具调用组（默认折叠为    │
                                  │    "Worked for 2m"）       │
                                  │ ─────────────────────      │
                                  │ 该轮正文（思考结束后出现）  │
                                  └────────────────────────────┘
```

**具体改造步骤**：
1. **数据层**：把流式 chunk 按 `reasoning_content` / `content` / `tool_call` **三类打标**，各自进入独立队列（不要合流成一个"事件流"）。
2. **分组层**：引入 `Turn`/`Step` 概念——一个"阶段"= 一次「思考(可含多段) + 若干工具调用 + 该阶段正文」。参考 Cline `groupLowStakesTools` 的思路：**把低风险工具（读文件/搜索）与相邻思考归同组**。
3. **渲染层**：
   - 思考区：流式展开 → 阶段结束**自动折叠**为 "Thought for Xs" 行（Cursor 范式）。
   - 工具区：默认折叠为 "Worked for Xs"，用户可展开；提供密度开关。
   - 正文区：**在该阶段的思考块关闭后再开始渲染**（至少不与之交错刷屏）。若上游确实交错推送（罕见），也应在 UI 上把正文缓冲到思考块结束。
4. **token 栏**：
   - 流中：正文 token 用估算（tiktoken 增量重算更准，字符/4 更快），**标注 `≈`**；reasoning token 单独一栏（它计费但不可见）。
   - 流末：用 `usage`（含 `completion_tokens_details.reasoning_tokens` / Gemini `thoughts_token_count`）**精确回填并去掉 `≈`**。
   - 流中断：保留估算值并标注"未收到 usage，此值为估算"。
5. **markdown 层**：采用 §4 路线 B（未闭合围栏临时闭合）+ rAF 节流；代码块/表格是重点保护对象。

### 5.4 需要 slime 自查的一个疑点

> slime 报告中"**只有推理 token 能实时刷新**，正文靠 `≈4 字符/token` 估算" —— 按协议事实，**推理 token 也拿不到逐 chunk 精确值**。
> **建议核查**：slime 的"推理 token 实时刷新"到底是
> (a) 上游逐 chunk 推的某个字段（若有，请确认是哪家 API 的哪个字段，因为主流没有）；
> (b) slime 对 `reasoning_content` **字符流的本地估算**（如果是，那就是估算，应与正文估算一视同仁地标注 `≈`）；
> (c) 某种私有网关行为。
> 这决定了右侧栏到底该有几栏、哪栏能带 `≈`。

---

## 6. 来源清单（可核查）

**官方文档 / 一手**
- Anthropic Extended Thinking（3.7 System Card，含 "separate section before its final response"）：https://www.anthropic.com/claude-3-7-sonnet-system-card
- Anthropic Thinking 文档（thinking blocks / display summarized-omitted / 计费）：https://docs.anthropic.com/en/docs/about-claude/models/extended-thinking-models
- Anthropic Streaming（`thinking_delta`、`message_delta` usage cumulative）：https://platform.claude.com/docs/en/build-with-claude/streaming
- Anthropic Claude Code model-config（"collapses thinking output by default"，`showThinkingSummaries`）：https://docs.anthropic.com/en/docs/claude-code/model-config
- OpenAI Cookbook — How to stream completions（`include_usage`，末 chunk、其余 null、choices=[]）：https://developers.openai.com/cookbook/examples/how_to_stream_completions
- OpenAI API Reference — `stream_options`、`completion_tokens_details.reasoning_tokens`：https://developers.openai.com/api/reference/resources/completions/methods/create
- OpenAI Developer Community #738156（官方公告 usage chunk）：https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156
- OpenAI Developer Community #1105907（o1 早期不支持 streaming；reasoning_tokens 位置）：https://community.openai.com/t/how-the-reasoning-tokens-were-calculated/1105907
- Gemini — Count tokens（`thoughts_token_count`、`usageMetadata` 仅末 chunk）：https://firebase.google.com/docs/ai-logic/count-tokens
- DeepSeek Streaming AsyncAPI（`reasoning_content` 后接 `content`）：https://apis.io/asyncapis/deepseek/deepseek-asyncapi
- Cursor 官方论坛（一手："Thought for Xs" 折叠、Tool Call Density、Worked for 组）：https://forum.cursor.com/t/how-do-i-view-thoughts-in-expanded-mode/171250
- Cursor Changelog 3.4（繁中，Tool Call Density Compact/Balanced/Detailed）：https://cursor.com/zh-Hant/changelog/3-4
- Windsurf/Cascade 官方文档（模式、工具数量、自动执行级别）：https://docs.windsurf.com/plugins/cascade/cascade-overview
- OpenAI Codex CLI Interactive mode（五类内容、reasoning 默认隐藏）：https://mintlify.wiki/openai/codex/concepts/interactive-mode

**源码 / 仓库**
- Cline：`webview-ui/src/components/chat/chat-view/utils/messageUtils.ts` 的 `groupLowStakesTools`（见 Issue #8636）：https://github.com/cline/cline/issues/8636
- Claude Code（社区逆向分析，源码路径 `src/utils/collapseReadSearch.ts`、`src/utils/groupToolUses.ts`、`StreamingMarkdown`）：https://deepwiki.com/zackautocracy/claude-code/5-terminal-ui-components
- Aider reasoning（`aider/reasoning_tags.py`，双通道处理）：https://deepwiki.com/dwash96/aider-ce/3.5-reasoning-models
- Codex CLI 渲染（`terminal-chat-response-item.tsx`，reasoning/tool/reasoning renderer 分离）：https://deepwiki.com/oaiagicorp/codex/2.3.2-message-history-and-rendering

**权威技术文章**
- Simon Willison — Notes on OpenAI's o1（OpenAI "not to show the raw chains of thought" 原文引用）：https://simonwillison.net/2024/Sep/12/openai-o1/
- TechCrunch — o3-mini CoT 更新（"think freely" + 后处理摘要）：https://techcrunch.com/2025/02/06/openai-now-reveals-more-of-its-o3-mini-models-thought-process/
- multigrid — Reasoning Tokens billing（`completion_tokens = reasoning + visible`）：https://multigrid.ai/learn/openai-reasoning-tokens-billing
- multigrid — Parsing DeepSeek-R1 think block（"字段名变化即是 thinking 结束信号"）：https://dev.to/multigrid/parsing-deepseek-r1s-think-block-out-of-the-response-5h6i
- engineersofai — Streaming UX for LLMs（渐进 markdown 完整方案 + 代码）：https://engineersofai.com/docs/ai-engineering/ai-product-engineering/streaming-ux-for-llms
- n4n.ai — Markdown streaming in React（未闭合围栏 normalize + rAF 节流）：https://n4n.ai/blog/markdown-streaming-in-react-parsing-partial-chunks-safely
- ossaihub — React Streaming Markdown Renderer（`normalizePartialMarkdown` 实现）：https://ossaihub.com/code/react-streaming-markdown-renderer
- hypogray — Why Claude Code hides its thinking（`redact-thinking-2026-02-12`，Boris Cherny 原话）：https://hypogray.com/stories/claude-code-hides-thinking
- whoburnedmore — Cline 用量（"sidebar 是 estimate"）：https://whoburnedmore.com/guides/check-cline-usage
- CSDN — Cursor 混合 token 计数策略（本地 ≈/4 估算 + 服务端 CSV 回填）：https://blog.csdn.net/weixin_42626599/article/details/160776816

---

## 7. 「我查到的原文」vs「我的推断」边界声明

**属于查到的原文（有直接引用）**：
- DeepSeek/Anthropic/OpenAI/Gemini 的字段与流式行为（§1.1、§3.1、§3.2）
- Cursor 的 "Thought for Xs" 折叠与 "Worked for…" 分组（§1.2、§2.2）
- Claude Code "collapses thinking output by default"、`collapseReadSearchGroups`（§1.2、§2.2）
- Cline `groupLowStakesTools` 与 Issue #8636 的维护者说明（§1.2、§2.2）
- OpenAI/Gemini "usage 仅末 chunk"（§3.1）
- Cursor/Cline 的 token 估算与回填策略（§3.3）

**属于我的推断（明确标注）**：
1. §3.4 "任何声称实时精确 output token 的产品要么撒谎要么指 tokenizer 对已落文本的计数"——这是基于协议事实的**逻辑推断**，非原文。
2. §5.4 对 slime "推理 token 能实时刷新"三种可能的推测——**推断**，需 slime 自查确认。
3. §5.3 的改造路线是**我的设计建议**，融合了 Cursor/Claude Code/Cline 的范式，非任何单一产品的原文。
4. §2.4 "平铺独立成列是反模式"——是对主流产品做法的**归纳**，非官方定性表述。
