# slime Agent-Loop 设计（v1 · 2026-09-22）

> 这份文档回答一个问题：**slime 的 Agent-Loop 到底该长什么样，为什么。**
>
> 三条写作纪律：
> 1. **一手来源优先**。所有厂商做法都取自官方 changelog / 官方工程博客 / 原始论文，
>    并注日期；二手转述（博客园、CSDN）只用来发现线索，不作为判据。
> 2. **每条设计都指向仓内实现**。没有实现位置的设计不进本文（否则就是宣言）。
> 3. **可验证优先**。凡"必须如此"的地方，都写出**守卫与变异脚本**在哪 ——
>    本项目的规矩是：守卫只是声明，变异测试才证明它真的在拦。
>
> 本文同时是 **A-1060 / A-1061 系列改动（steer、计划核对、压缩期预输入、上游如实上报、
> 阶段命名、流式渐入）的设计归口**：那些改动散在十几个工单里，需要一个统一的理论底座。

---

## 0. 摘要（先读这一段）

slime 的 Agent-Loop 是一句话：

> **一个 `while` 循环，每一轮必须产生一次「可观测的状态推进」；循环的每一种"停不下来"
> 和每一种"看起来停了其实没干"都有独立的判据、独立的留痕、独立的守卫。**

拆成六条：

| # | 设计主张 | 一句话理由 | 落地 |
| --- | --- | --- | --- |
| P1 | **单循环、单实现** | 流式与非流式分叉 = 语义漂移温床 | `core-ts/src/tool_loop.ts` 的 `run` / `runStream` |
| P2 | **终止 = 模型不再要工具**，上限只兜底 | 与 Codex 的 turn 定义对齐 | `TOOL_MAX_ROUNDS`（默认 500，可 env 覆盖） |
| P3 | **计划是有身份的产物**，不是上下文里的一句话 | 计划腐烂是"任务做完了却没划掉"的根因 | `services/todoStore.ts` + 循环级 `reconcilePlan` |
| P4 | **中途输入是一等阶段**（steer），不是打断 | Cursor 2026-08-19 的转向语义 | `services/steerBus.ts` + 轮次边界消费 |
| P5 | **压缩是循环的一部分，且必须可解释** | 静默重试/静默压缩 = 用户认定卡死 | `llm/upstreamNotice.ts` + `compressUi` 预输入队列 |
| P6 | **静默失败是精度杀手** | 判据里"失败/未知"必须独立成支 | 全仓纪律（见 §4） |

---

## 1. 一手调研

### 1.1 OpenAI —— Codex / Agents API

来源：`openai.com/index/unrolling-the-codex-agent-loop`（官方工程博客，逐条核对原文）、
`developers.openai.com/api/docs/guides/agents`、Agents API 发布公告（2026-09-10 公测）。

| 结论 | 原文要点 |
| --- | --- |
| **Turn 的定义** | 「The journey from *user input* to *agent response* … is referred to as one *turn*」；一个 turn 内部可以包含几十次「模型推理 → 工具调用」迭代 |
| **终止条件** | 「This process repeats until the model stops emitting tool calls and instead produces a message for the user」；「each turn always ends with an assistant message … which signals a termination state in the agent loop」 |
| **强缓存友好的上下文组织** | 旧 prompt 是新 prompt 的**精确前缀**（append-only）；「place static content like instructions and examples at the beginning of your prompt, and put variable content … at the end」 |
| **配置变更靠"追加"而非"改写"** | 沙箱/审批/cwd 变化时插入**新的** `role=developer` / `role=user` 消息，而不是修改历史消息 —— 就是为了不破坏精确前缀 |
| **自动压缩** | 超过 `auto_compact_limit` 时自动调 `/responses/compact`；压缩项带 `encrypted_content`，保留模型对原始对话的潜在理解 |
| **工具按需加载** | tool search：只加载需要的那几个工具定义，省 token 且**保住缓存** |
| **多代理** | subagent 各有独立 context；主代理负责汇总 |

**对 slime 的启示**：turn 边界是**唯一合法的"用户重入点"**；但 Codex 把自由文本输入封闭在 turn 边界，
**没有 steer 概念** —— 这正是 slime 需要向 Cursor/Claude Code 补课的地方（见 §1.3）。

### 1.2 Anthropic —— Claude Code / Agent SDK

来源：`anthropic.com/research/building-effective-agents`、`/engineering/effective-harnesses-for-long-running-agents`、
`/engineering/writing-tools-for-agents`、`/engineering/effective-context-engineering-for-agents`、
`code.claude.com/docs/en/best-practices`，以及 2026-03-24 官方多代理多轮构建的工程博客。

| 结论 | 要点 |
| --- | --- |
| **workflow vs agent 的分界线** | workflow = 控制流写在代码里；agent = **模型自己掌控制流**。五种植式的共同契约是"控制流预定义"；agent loop 是唯一把控制流交给模型的形态 |
| **从最简开始** | 「Start with the simplest pattern possible. Add complexity only when measurable improvements justify the cost.」 |
| **上下文是有限资源，与窗口大小无关** | 「Context rot is real. Model accuracy declines as context grows.」；`/cost` 一到 ~70% 就手动 `/compact`（自动阈值 ~83.5%） |
| **压缩必须被告知模型** | 「If your harness compacts context, tell Claude in the system prompt so it doesn't prematurely wrap up work.」 |
| **context anxiety** | 窗口将满时模型会**提前收工**；单靠 compaction 不够，需要"清空 + 把结构化状态交接给新代理" |
| **计划/任务落盘、跨重启存活** | Claude Code Task 系统把待办从"只活在上下文里"升级为落盘，并**经 system-reminder 反复重注入**，让 agent 保持战略连贯 |
| **子代理是上下文隔离手段** | subagent 有独立窗口，只把结论交回主线 —— 目的是分区上下文，不是角色分工 |
| **自评偏置** | 「Claude is a bad QA agent out of the box」：能找出真问题，然后说服自己放过它 ⇒ **生成者与评判者必须分离**（`generator + evaluator`），且要有客观判据（硬阈值 / 浏览器实测） |
| **工具是主要失败模式** | 「If engineers can't decide which tool applies, agents won't either.」工具描述要当 onboarding 文档写；相对路径 → 绝对路径消灭了一整类错误 |
| **ACI 视角** | 接口本身决定能力上限（与 §1.5 SWE-agent 同源） |

### 1.3 Cursor —— 转向（steering）语义

来源：`cursor.com/changelog/08-19-26`（官方 changelog，2026-08-19）。

> **#Steering improvements**
> You can now send a message to steer the agent while it's working **without interruption**.
> Follow-ups **wait for the next tool call** instead of cutting the agent off mid-action.
> Type a follow-up and hit Send now, or press ⏎ twice.

同一次发布还给了三件与 Loop 有关的东西：

- **`/goal`**：给 agent 一个**长期目标**，一直追到完成；
- **`/loop`**：周期性回来检查（配 `/goal` 用）；
- **Custom Mode**：把某个 skill **常驻**在会话里（"always on skills"），让 agent 按固定方法论工作；
- **Subscriptions**：agent 订阅 PR / Slack 线程 / 定时任务，**事件驱动地回来继续干**。

社区侧对忙碌输入的三态归纳（queue 下轮 / steer 注入本轮 / interrupt 立即停）与此一致。

**这是 slime `steer` 的直接依据**：slime 此前只有 `queue` 与 `interrupt` 两态，
用户要的「不打断地插一句话进去」从前只能靠 cancel 硬中断做到 ⇒ 症状就是"中途插入还是会被打断"。

### 1.4 Manus —— 上下文工程六条

来源：Manus 官方博客 *Context Engineering for AI Agents: Lessons from Building Manus*（Peak Ji）。

1. **围绕 KV-cache 设计**：agent 的输入/输出 token 比可达 **100:1**，缓存命中率是生产成本的一号指标
   （缓存 $0.30/MTok vs 未缓存 $3/MTok）；要求稳定前缀、append-only、确定性序列化。
2. **Mask, don't remove**：不要在运行中动态增删工具定义（会击穿缓存并让模型困惑），用 logit masking。
3. **把文件系统当上下文**：大观测物落盘，上下文里只留**指针**（URL / 文件路径）⇒ 压缩必须**可还原**。
4. **用"复述"操纵注意力**：持续重写 `todo.md`，把全局计划顶回上下文末尾，对抗 lost-in-the-middle。
5. **保留错误**（keep the wrong stuff in）：失败动作 + 堆栈留在上下文里，模型会隐式更新信念 ——
   「error recovery is one of the clearest signals of true agentic behavior」。
6. **别被 few-shot 带跑**：动作-观测对过于雷同会让模型模仿自己过去的次优行为 ⇒ 需要受控的变化。

另有两条实践数字：Manus 曾把 **~33% 的动作**花在更新 `todo.md` 上 ⇒ 后来改为"规划 agent + 执行子代理"；
子代理的首要目的同样是**上下文隔离**。

### 1.5 SWE-agent（Princeton NLP / Stanford，NeurIPS 2024）

来源：论文 *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering*（arXiv 2405.15793）。

核心命题：**语言模型是一类新的最终用户，需要为它专门设计的软件接口**（Agent-Computer Interface, ACI）。
实测：同一底层模型下，只改「浏览代码 / 编辑文件 / 运行命令 / 接收错误信息」的方式，
SWE-Bench 分数几乎翻倍。

> **接口即模型。** 能力不只来自权重，也来自模型外面的工具、接口、上下文、权限与反馈。

### 1.6 学界：从 Prompt Engineering 到 Loop Engineering

2025 年的软件工程路线论文提出 **Agentic Loop Engineering（ALE）**：目标是把 agent 不透明的内部求解
过程转化为**可观察 / 可控制 / 可审计 / 可复现 / 可优化**的工程工作流；并给出 `LoopScript` 这类
"Agent 时代的工作流描述语言"设想（任务如何拆、哪些能并行、每阶段需要什么验证、哪些节点必须人工审批、
失败后重试还是回滚、交付要带哪些证据）。

**这一条直接解释了本项目的门禁文化**（parse-check → tsc → vitest → 变异 → 产物核验）：
它就是 slime 版的"可复现/可审计"落地。§4 的收敛判据即 ALE 在 slime 上的具体化。

### 1.7 共识与分歧

| 议题 | 共识 | 分歧 / slime 的选择 |
| --- | --- | --- |
| 循环形状 | 都是 `while`：推理 → 工具 → 观测 → 再推理 | 并行工具调度：Codex 串行；slime 在 `executePendingTools` 里 `Promise.all` 并行（本地工具延迟低，收益 > 缓存损失） |
| 终止 | 模型不再要工具即终止；上限只兜底 | slime 上限 500（可 env 覆盖），另加"轮次即将耗尽"的显式提示 |
| 用户重入 | 都承认"运行中要有入口" | Codex 只在 turn 边界；Cursor 提供 steer；**slime 取 Cursor 路线** |
| 计划 | 都要有外部化的计划，且要反复重注入 | 落盘位置不同（Claude Code `~/.claude/tasks/`；Manus `todo.md`）；slime 落 `config/todos/<sessionId>.json` |
| 压缩 | 到阈值就压；压完要能让 agent 继续 | slime 额外要求：**压缩过程本身要在界面上可见**，且压缩期 steer 要能被取消 |
| 评判 | 生成者 ≠ 评判者 | slime 目前**缺**独立 evaluator（见 §5 缺口 G2） |

---

## 2. slime Agent-Loop 的形状

### 2.1 一次 Turn 的生命周期

```
用户输入 ──┐
           ▼
      ┌─ 轮次开始 ───────────────────────────────────────────────┐
      │ ① 计划复述：engine.buildMessages 折进最后一条 user（foldUserReminder）│  P3
      │    （未完成计划 → 复述进度+进行中项；无/全完成 → null 空转）│
      │ ② 轮次边界：injectSteers(sessionId, messages, onEvent)    │  P4
      │    （steerBus drain，取走即清空；空缓冲 = 纯空转）          │
      │ ③ 构造 payload → 请求上游                                 │
      │    · 429/瞬时错误 → noteUpstream 上报 → 再睡（不静默）      │  P5
      │    · 切备用模型   → noteUpstream 上报                       │
      ├─ 模型要工具？ ───────────────────────────────────────────┤
      │  是 → 逐个播 tool-start（界面立刻建"执行中"卡）             │
      │       → Promise.all 并行执行 → 逐个播 tool（带同一 id）     │  P1
      │       → continue（usedTodoWrite 置位，见下）               │
      │  否 → 本轮正文收尾，进入收尾核对 ─────────────────────────┤
      │       A. reconcilePlan（仅当 !reconciled && usedTodoWrite）│  P3
      │          → 有计划未收尾 ⇒ 续一轮，要模型交代              │
      │       B. injectSteers 还有货 ⇒ 续一轮，把引导注入本轮      │  P4
      │       C. 都没有 ⇒ 终止，交还用户                          │  P2
      └───────────────────────────────────────────────────────────┘
```

要点：

- **A 在 B 之前**：先让模型把计划收尾，再吃用户的引导 —— 否则引导会把"计划核对"这一轮挤掉。
- **两个"续一轮"判据都必须有闸**：`reconciled`（一次运行只核对一次）与"真的取到了引导"
  （`injectSteers` 取走即清空，取不到就正常收尾）。没有闸就是死循环。
- **`usedTodoWrite` 是"本次运行是否碰过计划"的准入条件**：没有它，任何一句闲聊都会被追问"你计划还没完成"。

### 2.2 事件契约（循环对外的可观察面）

唯一出处 `core-ts/src/services/chat.ts`：

```
"chunk" | "tool" | "tool-start" | "reasoning" | "progress" | "done"
| "error" | "heartbeat" | "member" | "steer" | "notice"
```

| 事件 | 语义 | 谁消费 |
| --- | --- | --- |
| `chunk` | 流式正文增量 | 正文渲染（渐入单元，`streamFade.ts`） |
| `reasoning` | 思考增量 | 思考历程 |
| `tool-start` | 工具**开始**执行（带 id/name/args） | 时间线立刻建 running 卡（A-1061②） |
| `tool` | 工具**完成**（同一 id + result） | 原地翻状态，不追加第二张卡 |
| `steer` | 引导**已被注入本轮上下文**（带 steerId/text） | 撤待发卡片 + 思考历程折一条 + 状态行确认 |
| `notice` | 上游状态如实上报（重试/限流/换模型） | 状态行（`liveStatus` 的 `notice` 阶段，扫光） |
| `heartbeat` | 存活心跳（15s） | 前端"流是否还在动"的证据来源 |
| `done` / `error` | 收尾 | 现场复位 + 落库 |

### 2.3 终止与上限

- **正常终止**：模型不再请求工具，且收尾核对与引导注入都没有新活。
- **兜底**：`TOOL_MAX_ROUNDS`（默认 500）。第 `TOOL_MAX_ROUNDS - 3` 轮起注入
  「轮次即将耗尽，请给最终结论」的系统提示 —— 这是**先礼后兵**，避免跑到上限被动截断。

---

## 3. 设计原则（逐条对应实现与守卫）

### P1 单循环、单实现

`run()`（非流式）与 `runStream()`（流式）是**两份独立实现**，任何循环级语义都必须**两边都改**。
这是已知技术债，但现状下最强的防线是守卫：

- 守卫：`tests/core-ts/tools.spec.ts` 的**镜像用例**（同一个行为分别驱动两条路径）。
- 变异：`mut-a1061-steerloop` M5「非流式路径的续轮被删」→ 必须变红。
- 纪律：新增续轮/中断分支时，**先写两条路径的镜像断言，再写实现**。

### P2 终止 = 模型不再要工具

- 实现：`nextCalls.length === 0` 分支。
- 反例守卫：`mut-a1061-steerloop` M4「续轮时不留上一段正文」——
  续轮前必须把本轮正文 push 成 assistant 消息，否则模型不知道自己刚说了什么。

### P3 计划是有身份的产物

三层，缺一层就会退回"任务做完却没划掉"：

| 层 | 实现 | 作用 |
| --- | --- | --- |
| 落盘 | `todoStore.writeTodos / readTodos`（`config/todos/<sessionId>.json`） | 跨重启存活；有 `sessionId` ⇒ 不串会话 |
| 复述（recitation） | `engine.buildMessages` 末尾**折进最后一条 user 消息**（`llm/userReminder.foldUserReminder`） | 用 recency 把计划顶回高注意力区（Manus 第 4 条），同时**不制造非首位 system**（那会让 OpenAI 兼容上游 400 / 被 Anthropic 静默改写成 assistant） |
| 核对（reconciliation） | `ToolLoop.reconcilePlan` + `planReconcileText` | **循环级硬约束**：本次碰过计划且没收尾 ⇒ 续一轮要交代 |

`planReconcileText` 的判据（纯函数，`planReconcileFromTodos`）：

- 空表 / 全部 `completed` → `null`（**零行为变化**，不打扰）；
- 有未完成项 → 点名剩余项 + 给两条**合法出口**（标完成 / 说明为何留待下一轮）。
  ⚠️ 只给一条出口 = 逼模型假完成（`mut-a1061-reconcile` M9 专门锁这条）。

### P4 中途输入是一等阶段（steer）

- 缓冲：`services/steerBus.ts`，`Map<sessionId, SteerItem[]>`；
  `STEER_MAX_PENDING = 8`、`STEER_TEXT_MAX = 2000`；**只做进/出/清/查，不碰 IPC / React / LLM** ⇒ 可单测可变异。
- 消费点：轮次边界 + "本轮不要工具"的收尾分支（两条路径都调）。
- 注入形态：一条 `role: "user"` 消息（**绝不能是 assistant**，否则模型以为是自己说的）。
- 不落库是**有意取舍**：本项目历史按"一轮 user+assistant 成对"写，中途插话没有对应的 assistant 半轮。
  ⇒ 引导只进本轮上下文 + 思考历程（时间线已持久化 ⇒ 重启后仍可见），不进正文记录。
- **"同一会话绝不开第二条流"是入口不变量**（`instructionQueue.shouldDeferToSteer`）：
  判据用**活动时间戳**（chunk / 工具事件 / 心跳刷新）而不是 UI 的 `loading` ——
  因为 `loading` 会被合法的提前收尾清掉，那一刻判据失效，用户回车就会开第二条流，
  界面表现就是"正文从头开始"（用户原话："中途插入把 agent 打断了"）。

#### P4′ 两条路各自一个**动作**，不给「方向」做开关（A-1062，含其撤销）

三态（`queue` / `steer` / `interrupt`）是**语义**，但语义只有被用户表达出来才有用 ——
而表达它的正确形态**不是**一个方向选择器。这一段记录一次被撤销的设计，因为它的失败模式可复现：

| 阶段 | 做法 | 结果 |
| --- | --- | --- |
| A-1060/1061 | steer 做进循环，但「我这条走哪一态」留在**提交之后**；placeholder/title 仍是**新消息**口径，而回车实际恒定走 `steer` | **文案说 A、行为做 B** ⇒ 用户按"新消息"心智插入，得到"注入本轮"，反复报"插入会打断" |
| A-1062（首次尝试）| 照搬 ask_user 的 ◉/○ 可选项，做「运行中方向行」+ 后果行 + `steerIntent` 状态 | 用户裁决**撤销**：「这个选项也没必要，原本的就够了，**排队不直接发送，不排队直接发送**，你还专门划分一下，很多余」 |
| A-1062（收敛后，现行）| 不给方向开关；**两条路各自一个动作**，文案与动作同源 | 回车 = 排队（`queue`）；待发卡片「现在插入」= 直接发送（`steer`）|

为什么方向开关是错的（可复现的判据）：

1. **它把"两件不同的事"混成一个可调开关** —— 中途插入里，"排队"与"直接发送"本由
   **两个不同动作**表达；再叠一个方向单选，等于给同一个选择造了第二个产地；
2. **它只作用于"回车"这一个动作** —— 用户选了「排队」再点卡片箭头仍是插入，**自相矛盾**；
3. **与 A-1056③ 撤掉的「全局默认插入方式」胶囊同族**：一个全局默认去代表每一条指令的意图。

现行约束（唯一出处 `gui/src/renderer/pages/insertCopy.ts`，守卫 `tests/gui/insert-copy.spec.ts`，
变异 `mut-a1062-insertcopy`）：

1. **回车恒为 `queue`**（"排队"这条语义必须真的有出口）—— 入队分支里一旦再出现
   `chat.steer(...)`，它就没了。⚠️ **两个产地**（`send()` 与 `doSend()` 的让位分支）都要锁；
2. **压缩窗口只拦「现在插入」那条路**（`isCompressWindow`）—— 窗口里投了没人消费，
   声称"已引导"就是骗用户；投递失败必须退回 `queue` 态（同族：A-1061⑪）；
3. **文案与判据同源** —— placeholder / 发送按钮 title / 卡片 title 一律从 `insertCopy` 导出，
   组件只调用、不拼字符串（否则"说反话"重演：过 tsc、过全部行为测试，只在用户眼里翻车）。

### P5 压缩是循环的一部分，且必须可解释

- 压缩阶段在界面上是一等状态：`compressUi.stage ∈ {prep, summarize, done, trunc}`。
- **压缩期 steer 的取舍**：不许插入（模型正在被重写上下文），但**收成可取消的预输入**
  （`preSteerIdsRef`），压缩完成后自动注入；用户随时可点"撤销删除"取消。
- 上游等待必须如实上报：`llm/upstreamNotice.ts`（**单槽 + 取走即清**）+
  `client.ts` 两处退避（**先上报再睡**）+ `router.recordFallback`。
  文案唯一出处：`formatRetryNotice` / `formatFallbackNotice`，重试次数用**用户口径**（从 1 开始）。
- 一条踩过的坑：单槽是**进程级**的，上一次请求留下的通知会被本次流的第一个轮询 tick 当成
  "本次的上游状态"吐出去 ⇒ **`engine.stream()` 入口先清槽**。

### P6 静默失败是精度杀手

四类必须独立成支的形态（都在仓内踩过）：

| 形态 | 错误写法 | 正确写法 |
| --- | --- | --- |
| 查询失败 ≡ 条件成立 | `.catch(() => null)` + `if (!r \|\| r.flag)` | "失败/未知"独立成支 + 重试上限 + 明确放弃时的保守取舍 |
| 粘性"别再干某事"标记 | `stoppingRef` 只在部分出口复位 | 问"**所有**出口都复位了吗" |
| 用 UI 状态当唯一依据 | `if (loading) …` | 用**活动时间戳**；所有内部调用点显式声明意图 |
| 降级不留痕 | 静默截断/静默瘦身 | 留 `diffTrimmed` / notice / 控制台 marker，并给出**方向性**提示 |

### P7 阶段可命名

`gui/src/renderer/pages/liveStatus.ts`：

- `ToolStage`：11 个**机器可读稳定键**（`generate-script` / `run-command` / `read-file` / `write-file` /
  `search-web` / `screen-control` / `browser` / `plan` / `memory` / `delegate` / `tool`）——
  将来的阶段级耗时统计 / 阶段卡片按这个键聚合，**不必正则匹配中文文案**。
- `TOOL_STAGE_TITLES`：阶段标题**唯一出处**（组件/统计/日志一律从这里取）。
- `classifyToolStage(toolName)`：纯函数、按前缀优先、顺序敏感
  （代表案例：`adb_screencap` 必须落"操作屏幕"而不是"执行命令" ⇒ screen 规则排在 `adb_` 前面）。

### P8 追加式上下文 + 稳定前缀

- 消息数组**只追加**；新增状态一律走"插入一条新消息"（与 Codex 的 append-only 同源）。
- 复述/提醒放**数组末尾**（recency），系统指令放开头（稳定前缀）。
- ⚠️ 本地 llama.cpp 端点下 prompt cache 收益与我们无关，但**append-only 仍然要做**：
  它同时是"上下文可解释"的前提（用户能看出这一轮多了什么）。

### P9 保留错误（keep the wrong stuff in）

- 工具失败**不吞**：失败结果原样进上下文（带错误前缀），并且**判定唯一出处**是
  `chatProducts.isToolFailResult`（实时"执行中"行与完成卡共用，避免两处判定漂移）。
- 但"保留错误"不等于"把错误说成正常"：失败必须让用户看见（留痕 + 成功/失败状态词）。

### P10 可验证性优先

- 行为级测试 > 源码 `toContain`：优先用假 router 驱动**真**循环（`tests/core-ts/tools.spec.ts` 的
  续轮三例即此形态），只在无法行为化时才做结构断言。
- **守卫必须过变异**（改坏 → 红）；变异"未命中"与"存活"**同等报错**。
- 内容类文件（toml/md/json）的变异锚点必须**自带段落上下文**（注释里几乎必然复述了同一个值）。

---

## 4. 问题求解收敛（本文的重点目标）

### 4.1 收敛的定义

> 循环的每一轮，必须让某个**外部可观测对象**发生一次**不可逆的推进**。
> 该对象是：计划表的勾选状态 / 磁盘上的文件 / 终端输出 / 用户看到的新信息。
> 若一轮下来这四个都没动，那一轮就是**空转**。

这个定义把"收敛"从主观感受（"它好像在努力"）变成可判定条件，也是 §1.6 的 ALE 在 slime 上的落地。

### 4.2 五类不收敛形态与对策

| # | 形态 | 症状（用户看到什么） | 判据 | slime 对策 | 守卫 |
| --- | --- | --- | --- | --- | --- |
| **C1** | **计划腐烂**：任务干完了但计划表没划掉 | 待办面板永远停在半途 | 本次运行碰过 `todo_write` 且存在未完成项 | `reconcilePlan` 续一轮要交代；两条合法出口 | `mut-a1061-reconcile`（9 条） |
| **C2** | **目标漂移**：早期写下的目标被压到上下文中段而失效 | 干着干着跑偏，或反复重做已完成的事 | 每轮开头是否复述了未完成计划 | `planReminderText` 追加到消息末尾（recency） | `mut-a1061` M（计划复述段头） |
| **C3** | **假完成**：声称完成，验证没过 | "已完成"，但文件根本没写 / 测试没跑 | 是否只有 evaluator 能判（当前缺，见 G2） | 工具结果如实进上下文 + 失败判定单源；**禁止**把失败说成成功 | `mut-a1061-livetool` |
| **C4** | **静默空转**：一直在等，界面什么都不说 | "agent 什么都没有，自己加载半天" | 上报出口是否覆盖**所有**等待路径 | `upstreamNotice` 覆盖两处退避 + 换模型；`engine.stream()` 入口清槽 | `mut-a1061-notice`（16 条） |
| **C5** | **无限续/死循环**：同一个动作反复做 | 同一个工具出现很多遍 / 追问不停 | 每个"续一轮"分支是否都有闸 | `reconciled`（一次运行只核对一次）+ `injectSteers` 取走即清空 + `TOOL_MAX_ROUNDS` | `mut-a1061-steerloop` M1–M3、`mut-a1061-reconcile` M3 |

补充：C4 还有一个**同族** —— "看起来动了其实没动"：流已死但 `loading` 还挂着（或反之）。
判据必须用**活动时间戳**（`STREAM_ALIVE_MS = 60s`，心跳 15s ⇒ 4 倍余量），不用 `loading`。

---

## 5. 与厂商的差异 / 已知缺口（诚实交代）

| # | 缺口 | 现状 | 影响 | 备注 |
| --- | --- | --- | --- | --- |
| **G1** | **`run` / `runStream` 双实现** | 循环级语义要两边各改一次 | 改一处漏一处 = 静默语义分叉 | 缓解：镜像行为测试 + `mut-a1061-steerloop` 专锁非流式路径 |
| **G2** | **无独立 evaluator** | 模型自评（Anthropic 明确指出这会自信地放过烂活） | C3 假完成只能靠工具事实兜 | 缺客观判据的任务类型（设计/文案）尤其明显 |
| **G3** | **无显式 prompt cache 埋点** | 本地 llama.cpp 端点，缓存收益不适用 | 换云端端点时需重新设计前缀稳定性 | append-only 纪律已为它铺好路 |
| **G4** | **steer 不进正文历史** | 只进本轮上下文 + 思考历程 | 重启后正文记录里看不到那句引导 | **用户 2026-09-22 裁决：这是对的** —— 引导不该出现在正文记录中 |
| **G5** | **无事件驱动重入**（对应 Cursor Subscriptions） | 只有用户手动发起 + 会话恢复 | 长任务无法"等外部事件再回来干" | 未排期 |
| **G6** | **子代理无独立 VM / 无任务图** | 子代理只做上下文隔离 | 并行改动会互相踩 | 见 `ref-subagent` |

---

## 6. 门禁与验证（本文引用的守卫在哪）

| 主题 | 守卫 spec | 变异脚本 |
| --- | --- | --- |
| steer 语义（三态 / 入口不变量 / 跨会话归属） | `tests/core-ts/a1060-steer.spec.ts` | `gui/scripts/mut-a1060.mjs`（28 条） |
| 续轮（计划核对 + 引导注入，两条路径） | `tests/core-ts/tools.spec.ts` | `mut-a1061-steerloop` / `mut-a1061-reconcile` |
| 计划复述 / 核对文案 | `tests/core-ts/todo-store.spec.ts` | `mut-a1061-reconcile`（9 条） |
| 计划复述的**注入形态**（折进末尾 user，不造非首位 system） | `tests/core-ts/user-reminder.spec.ts`（11 条） | `mut-a1061-reminder`（9 条） |
| 中途插入（两条路 / 文案同源 / 闸门） | `tests/gui/insert-copy.spec.ts`（16 条） | `mut-a1062-insertcopy`（12 条） |
| 流式失败判定（不可恢复 / 重连阈值 / 诱因文案） | `tests/gui/stream-errors.spec.ts`（16 条） | `mut-a1063-streamerrors`（8 条） |
| 上游如实上报 | `tests/core-ts/a1061-notice.spec.ts` | `mut-a1061-notice`（16 条） |
| 工具实时状态 / 阶段命名 | `tests/core-ts/a1061-livetool.spec.ts`、`a1054-livestatus` | `mut-a1061-livetool`（12 条） |
| 字号层级 / 流式渐入 | `tests/gui/a1061-visual.spec.ts`（17 条） | `mut-a1061-visual`（15 条） |
| 工具留痕（marker@0） | `tests/core-ts/a1027-guards.spec.ts` | `mut-a1027-tooltrace`（12 条） |
| diff 可见性 / 降级留痕 | `tests/core-ts/a1029-guards.spec.ts` | `mut-a1029-diffvis`（21 条） |
| 发布说明格式 / 完整性 | `tests/gui/release-notes.spec.ts`（16 条） | `mut-a1042-notes-format`（8 条） |

**全量门禁**（串行，禁并发抢 CPU）：

```
node scripts/parse-check.mjs <改动文件>          # 0 诊断
tsc -p tsconfig.base.json --noEmit               # ⚠️ --noEmit 保命，否则往源码树吐编译影子
tsc -p gui/tsconfig.json --noEmit
tsc -p gateway-ts/tsconfig.json --noEmit
vitest run                                       # 全量
cd gui && node ./node_modules/electron-vite/bin/electron-vite.js build
cd gui && node ./scripts/assert-bundle.mjs       # 必须在 gui/ 下跑
node gui/scripts/mut-*.mjs                       # 每条都必须「全部验红」+ 哈希还原
```

---

## 7. 下一步（缺口优先级建议）

1. **G2 独立 evaluator**（收益最高）：先在最容易判定的场景做——`evaluator` 只看
   「磁盘事实 + 命令退出码 + 测试结果」，不看模型自述。对应 Anthropic 的 generator/evaluator 分离。
2. **G1 收敛为单实现**：把 `run` 抽成 `runStream` 的薄包装（消费同一个事件流），根治双实现分叉。
3. **C3 的判据化**：为"声称完成"的动作定义可检验的收尾证据（文件 mtime / 测试退出码 / 产物 hash），
   没有证据的"完成"不算完成。
4. **G5 事件驱动重入**：先做最小形态（"等 CI/等测试结束再回来继续"）。

> 本文随实现演进；任何新增的循环级分支，都必须在本文件 §2.1 的流程图与 §4.2 的表里出现，
> 否则说明它还没想清楚属于哪一类推进。
