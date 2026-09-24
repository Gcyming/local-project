# 交接：上下文压缩 Agent-Loop（P1 及以后）

> **给接手的 Agent**：先读 §1（用户的问题与证据）→ §2（进度）→ §3（精确坐标）→ §4（任务分解，
> 每项都有判据/验收/变异/坑）→ §5（门禁与**本环境限制**）→ §6（本仓硬规矩）→ §7（别做的事）。
> 设计依据与一手来源在 `docs/context-compaction-loop.md`（253 行，含三份权威检索报告的结论）。
> 本文件只讲**现状与怎么接着干**。

---

## 1. 用户的问题（为什么要做这件事）

用户原话（2026-09-23）：

> 「不行，现在直接模型都用不了了，目前只有小红书的模型能稳定使用，其他的全部是要么连接半天
> 还是重连，要么直接超时报错。我一直在怀疑，是不是你的 Agent-Loop 还有缺漏，中间少了一环，
> **压缩并非真压缩**，因为用不了的模型在其他会话还能使用。」
>
> 「要求触发压缩阈值时：压缩→总结→**理解总结**→继续→……→达到阈值→压缩→总结→理解总结内容→继续」

**这三条症状合起来只指向一个解释**（不是供应商故障）：

| 症状 | 指向 |
| --- | --- |
| 只有小红书(dot4, **512K 窗口**)能稳 | 请求**真的很大**，只有超大窗口的模型扛得住 |
| 同一模型换**新会话**就能用 | 与"该会话积累的上下文"强相关 |
| "连接半天还是重连" / "直接超时报错" | 超限类失败被当成**可重试** ⇒ 重连风暴 |

### 1.1 故障链（已由代码证据确认）

```
长会话（历史 + 固定开销）超过该模型窗口
  → 上游返回 400(prompt too long / context_length_exceeded)  或  干脆挂住不出首字节
  → 客户端：PERMANENT_STATUSES = [401,403,404]（400 刻意不在内）；挂住 → 空闲超时（也算可重试）
  → 两者都被判"可重试" ⇒ 9 次重连（递增退避 + 60s 空闲超时）⇒ "连接半天还是重连"
  → 最终 "直接超时报错"
```

⇒ **"少的那一环"**：上游说"太长"时，**循环里没有任何人去压缩**，只有空转重连。

### 1.2 「压缩并非真压缩」——七处实证（都在本仓代码里）

| # | 位置 | 现状 | 后果 |
| --- | --- | --- | --- |
| ① | `context_compress.ts:33 estimateHistoryTokens` | `chars/4`（+ 每条 300 字符开销） | **CJK 4 倍低估**（1 汉字 ≈ 1 token，却按 0.25 算）⇒ 阈值形同虚设 |
| ② | `context_compress.ts:107 buildCompactedHistory` | `tail.map(m => ({role, content}))` | **丢 `tool_calls`/工具结果**；`tool` 角色塌成 `user` ⇒ 配对与角色交替被破坏 |
| ③ | `context_compress.ts:97 hardTruncate` | `[首条, ...末K]` | 中段**无摘要直接丢**；首尾不相邻（对话不连续） |
| ④ | `main/index.ts:2563 loadSessionHistory` | `loadHistoryForSession(..., **50**, ...)` | 历史先被**静默截到 50 条**：超出部分既**不进摘要**也**不出声** |
| ⑤ | `main/index.ts:~2946 slime:chat:compress` | `if (used > histUsed && history.length <= K+2) return skipped` | 固定开销（系统提示/记忆/技能/工具定义/工作区注入）占大头时**每轮空转**，什么都没变 |
| ⑥ | `engine.ts:1138 summarizeContext` | `SUMMARIZE_INPUT_CAP=9000` 超限即 `return null` | 放弃摘要 → 调用方**静默硬裁剪**：回执写"已压缩"，其实**一个字都没总结** |
| ⑦ | `ChatPanel.tsx:4459` 压缩成功分支 | `const next = Math.max(1, Math.round(res.cap * 0.5)); ctxAnchorRef.current = next;` | **假报占用**：界面把它写成"上限的 50%"，与真实体积**无关**；后续判定也被污染 |

### 1.3 一条决定判据形态的硬证据

`client.ts` 对上游错误体做了 **`slice(0, 200)`**（9 处，见 `UpstreamError` 构造点）。而 OpenAI 把
`"code":"context_length_exceeded"` 放在响应体**末尾** ⇒ **被截掉**。
⇒ 任何"靠结构化 `code` 精确分类"的实现都会在真实错误上漏判。
**判据必须以散文句为主**（它总在 message 开头）。这条已写进 `streamErrors.ts` 的注释与守卫。

---

## 2. 进度总览

### ✅ 已完成（P0，已落地并验证）

| 项 | 位置 | 说明 |
| --- | --- | --- |
| **上下文超限 = 第三类（终态·可压缩）** | `gui/src/renderer/pages/streamErrors.ts:100/102/126` | 新增 `CONTEXT_OVERFLOW_STATUSES=[413,414]`、`isContextOverflowError()`、`contextOverflowHint()`；散文为主判据，覆盖 OpenAI / Anthropic / Kimi / 百炼 / 网关真实文案；**裸 400 明确不算** |
| **反应式压缩 + 重试一次** | `gui/src/renderer/pages/ChatPanel.tsx:3879`（分支）、`:2317`（一次性 ref） | 超限 → `maybeAutoCompress(..., force=true)` → 重试一次；**排在 9 次重连之前**；用独立 ref（复用 `didCompressTurnRef` 会在早退分支死循环） |
| **`force` 越过阈值但不越过用户开关** | `ChatPanel.tsx:4417`（签名）、`:4424`（阈值行） | 只越过 `used < cap*ratio` 这条；`cfg.enabled`（用户设置）仍然优先 |
| **守卫 +13 条** | `tests/gui/stream-errors.spec.ts` | 25/25 通过（含真实错误串、裸 400 不算、连线位置/顺序/一次性闸门） |
| **设计定稿** | `docs/context-compaction-loop.md` | 8 状态环路 + 7 条硬不变量 + 分期 + 一手来源 |
| **锚点静态核验工具** | `gui/scripts/check-mut-anchors.mjs` | 见 §5.3（本环境跑不了变异套件时的替代） |
| **A-1082 变异脚本（2026-09-23 夜补建）** | `gui/scripts/mut-a1082.mjs` | 7 条（估算/按条数硬切/`delete summaryCount`/去掉 `!force`/`cap*0.5`/`isCompressWindow`/`stillOverflow` 回带）；**锚点 7/7 命中且唯一**，3 条关键项已手工实跑 **RED** + 逐字节还原。环境恢复后直接 `node gui/scripts/mut-a1082.mjs` |

### ✅ 已完成（P1 主体，A-1082，2026-09-23 追加）

> ⚠️ **接手前先读这一节**：P1 的**核心闭环已落地**，且**根因与本文档 §1.2 的推断不同** ——
> 真正的「压缩并非真压缩」是 **①降级路径是空操作 + 假报**（不是单纯估算口径问题）。
> 详见 `docs/REVIEW_AGENT.md` 的 A-1082 行（含五条根因、变异验证记录、诚实边界）。

| 编号 | 事项 | 落地位置 |
| --- | --- | --- |
| **P1-1** | 真实占用估算（CJK 感知）+ 口径统一 | `context_compress.ts: estimateHistoryTokens`（旧 `字符/4` 改为与 `estimateTokensLocal` 同口径） |
| **P1-2** | turn 对齐裁剪 + 工具配对校验 | `context_loop.ts: planCut / trimTurnAligned / validateHistory`；⚠️ §4.2 的 **⚠️ 已查证：结论是 (a)** —— 持久化历史里**没有 tool 消息**，故 I1 分支当前恒真，只作未来防线 |
| **P1-3** | 递进式摘要（不倒退）+ generation | `buildCompressSummaryPrompt(text, priorSummary)`、`acceptSummary()`、`SessionMeta.summaryGeneration` |
| **P1-4** | **「理解总结」环**（AWAIT_COMPREHEND，有界） | `context_loop.ts: buildResumeBlock / parseComprehend`；`engine.comprehendContext()`；`SessionMeta.contextComprehend`（随摘要注入） |
| **P1-5** | 熔断（连续失败 ≥3 停） | `context_loop.ts: nextBreakerState / BREAKER_THRESHOLD`；主进程 `compressBreaker` |
| **P1-6** | `planCompaction` 四档动作 | **未做**（见下）——`none` 必须带 `reason` 这一条已单独落地（主进程 skipped 分支 + ChatPanel `skip` 阶段如实显示） |
| **P1-7** | **去掉 `cap*0.5` 假报，改实测回填** | `main/index.ts` 的 `tokensAfter / stillOverflow / realShrink`；`ChatPanel.tsx` 用 `res.tokensAfter` + `overflow` 诚实文案 |
| **P1-8** | （可选）工具结果成对清理（clear 档） | **未做**（同 P1-2 的 (a) 结论：当前无可作用对象，避免死代码） |
| — | **① 降级路径空操作（最致命，本轮新发现）** | `sessions.ts: setSessionSummary` 解耦 `summaryCount`；`loadSessionHistory` 改为「只要 `summaryCount` 存在就真的裁」 |
| — | **② 摘要轮无条件放弃（本轮新发现）** | `context_compress.ts: buildSummaryInput`（超预算取头 30% + 尾 70% 摘录，永不放弃）；预算按窗口解析 |
| — | **④ `force` 未接到主进程（P0 实际没接上）** | IPC 透传 `force`；主进程 `if (!force && !needsCompress(` + 空转护栏同样越过 |

### ❌ 仍未完成

| 编号 | 事项 | 为什么没做 |
| --- | --- | --- |
| **P1-6** | `planCompaction` 四档（唯一出处） | 四档中的 `clear` 支**当前无可作用对象**（工具结果不持久化，见 P1-2 结论）；只剩 `none/summarize/trim` 三档，而这三档的判据已分别落在 `needsCompress`（保留原语义）+ 主进程分支里。做成"唯一出处"是一次纯重构，价值在于可测性 —— 建议与 P1-8 一起在**引入持久化工具消息**之后再做 |
| **P1-8** | 工具结果成对清理（clear 档） | 同上：本仓工具结果不持久化 ⇒ 无对象可清 |
| — | `loadHistoryForSession(…, 50, …)` 的 50 条静默上限（§1.2 ④） | 本轮未动：它只影响「摘要覆盖范围」，不影响「压缩是否真的变小」；动它会改变请求体积基线，需单独评估 |
| — | 分层超时（connect / first-byte / idle / total，设计定稿 §2 最后一行） | 属 P0 遗留，本轮未触及 |


---

## 3. 精确坐标（现状快照，行号取 2026-09-23 19:2x）

### 3.1 纯逻辑模块 `core-ts/src/services/context_compress.ts`（118 行）

```
:14  DEFAULT_COMPRESS_RATIO = 0.85     触发占比（用户可调，RATIO_MIN/MAX = 0.5/0.97）
:19  DEFAULT_TAIL_KEEP = 12            压缩后保留的尾部条数
:21  SUMMARIZE_INPUT_CAP = 9000        摘要轮输入硬上限（超限即放弃摘要）
:24  estimateTokensLocal(text)         CJK=1 字/1 tok、其余 /4  ← 与 :33 **口径不一致**
:33  estimateHistoryTokens(messages)   chars/4 + 300/条          ← ① 要改
:52  needsCompress(used, cap, ratio, turns)   turnCount < 6 直接 false
:60  buildCompressSummaryPrompt(conversationText)   摘要轮提示词（要点式 ≤500 字）
:76  messagesToPlainText(messages)     摘要轮输入（图片只占位）
:97  hardTruncate(messages, keep)      [首条, ...末K]            ← ③ 要改
:107 buildCompactedHistory(summary, messages, keep)              ← ② 要改
```

**现有 `buildCompactedHistory` 的关键缺陷行**（要重点改）：

```ts
// :107-118
export function buildCompactedHistory(summary, messages, keep = DEFAULT_TAIL_KEEP) {
  const tail = messages.slice(-keep);
  return [
    { role: "user", content: `【会话上下文压缩摘要】（早期 N 轮已压缩…）\n${summary}` },
    { role: "assistant", content: "（已收录以上摘要，在此基础上继续当前任务）" },
    ...tail.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",   // ← 塌角色
      content: typeof m.content === "string" ? m.content : "[图片消息]",                // ← 丢结构（tool_calls 没了）
    })),
  ];
}
```

### 3.2 主进程 `gui/src/main/index.ts`

```
:866   import { … setSessionSummary … } from session 模块
:2083  async function resolveSessionWindowCap(agentId, modelId)   窗口上限解析（agent.max_context 优先）
:2556  async function loadSessionHistory(sessionId)               ★ 压缩产物**注入点**
:2563  const records = await loadHistoryForSession(meta.agentId, meta.id, 50, firstSession)   ← ④
       :2572-2580  if (meta.contextSummary && lines.length > 4) { tail = lines.slice(-(meta.summaryCount ?? 12)); … }
                   ↑ 这里才是"摘要头 + 最近 K 条"的注入实现；**只有它真的在裁**
:2923  handleTrusted("slime:chat:compress", …)                     ★ 压缩编排
       :2938  histUsed = estimateHistoryTokens(history)
       :2939  hint = p.used（渲染层实测输入侧占用）
       :2940  used = Math.max(histUsed, hint)
       :2946  if (used > histUsed && history.length <= DEFAULT_TAIL_KEEP + 2) return skipped   ← ⑤ 空转
       :2950  if (!needsCompress(used, cap, ratio, history.length)) return skipped
       :2959  summary = await engine.summarizeContext(agent, history, {})
       :2961  await setSessionSummary(sessionId, summary.summary, DEFAULT_TAIL_KEEP)   ← 覆盖式，无存档/generation
       :2965  await setSessionSummary(sessionId, null, DEFAULT_TAIL_KEEP)              ← 摘要失败 → 硬裁剪（静默）
:3313  loadHistoryForSession(meta.agentId, meta.id, 500, firstSession)  另一处调用（500，导出/其它路径）
```

### 3.3 引擎 `core-ts/src/services/engine.ts`

```
:1125  async summarizeContext(agent, messages, opts?)  → { summary, inputTokens } | null
:1136  text = messagesToPlainText(messages)
:1137  inputTokens = estimateTokens(text)              ← 用的是 engine 自己的估算
:1139  if (inputTokens >= cap) { warn("降级硬裁剪"); return null }   ← ⑥ 静默放弃摘要
:1148  payload = { messages: [system, user(buildCompressSummaryPrompt(text))], max_tokens: 1024 }
:1157  const { response } = await router.chat(withModel(payload, route!))
:1162  catch → warn("摘要轮失败（降级硬裁剪）") → return null
```

### 3.4 渲染层 `gui/src/renderer/pages/ChatPanel.tsx`

```
:2313  retryCountRef                  已重连次数
:2317  ctxOverflowRetriedRef          ★ A-1081 新增：本轮"超限→压缩+重试"是否用过
:3872  const MAX_RETRY = 9
:3879  if (isContextOverflowError(msg)) { … }   ★ A-1081 新增（**必须在下面这条之前**）
:3899  if (isPermanentStreamError(msg)) { failReconnect(msg, 0); return; }
:3903  if (retryCountRef.current < MAX_RETRY) { … 9 次重连 … }
:4417  async function maybeAutoCompress(sid, liveUsed?, force = false)   ★ force = A-1081 新增
:4424  if (!force && used < cap * cfg.ratio) { return; }   ← force = A-1081 新增（越过阈值，不越过用户开关）
:4459  const next = Math.max(1, Math.round(res.cap * 0.5));   ← ⑦ 假报
:4462  ctxAnchorRef.current = next;
:4598  const base = Math.max(ctxAnchorRef.current, estimate);   ← 锚点是**单调**的 ⇒ 假报会污染后续判定
```

### 3.5 渲染层错误分类 `gui/src/renderer/pages/streamErrors.ts`

```
:48  PERMANENT_STATUSES = [401,403,404]
:57  upstreamStatusOf(msg)             只认 `上游错误 NNN` / `HTTP NNN`（禁裸数字扫描）
:100 CONTEXT_OVERFLOW_STATUSES = [413,414]     ★ 新增
:102 isContextOverflowError(msg)                ★ 新增（散文 4 档 + code 1 档 + 广谱 1 档 + 状态码）
:126 contextOverflowHint()                      ★ 新增（可操作提示）
:142 isPermanentStreamError(msg)               终态·不可恢复
:173 explainStreamError(msg, attemptCount?)
```

### 3.6 新增脚本与文档

```
gui/scripts/check-mut-anchors.mjs   锚点静态核验（只读；见 §5.3）
gui/scripts/mut-a1063-streamerrors.mjs   已扩：TARGETS 加入 ChatPanel；+3 条 A-1081 变异
docs/context-compaction-loop.md     设计定稿
docs/handoff-context-compaction-p1.md  本文件
```

---

## 4. P1 任务分解（每项：目标 / 改哪里 / 判据 / 验收 / 变异 / 坑）

### 4.1 P1-7 去掉 `cap*0.5` 假报，改**实测回填**（建议**先做**）

**目标**：界面上的"上下文占用"必须能追溯到**实测值**，不许再有构造值。

**改**：
1. `gui/src/main/index.ts` 的 `slime:chat:compress`：在 `setSessionSummary` **之后**重新加载历史并估算，
   把 `tokensAfter` 一起返回（`CompressResult` 加字段：`tokensAfter`、`stillOverflow: boolean`）。
   - `stillOverflow` = `Math.max(estimateHistoryTokens(重新加载的历史), 固定开销估算) >= cap`。
2. `ChatPanel.tsx:4459` 的 `cap*0.5` → 用 `res.tokensAfter`；`res.stillOverflow` 为真时
   **明说**「压缩后仍超限，需要换窗口更大的模型或开新会话」（不许静默）。
3. `ctxAnchorRef.current = next` 这行只在**实测**来源下写（`tokensAfter` 属于估算 ⇒ 可以写，
   但要在注释里写清"这是估算，下一次 done 会用 prompt_tokens 校准"）。

**判据**：源码里不再出现 `cap * 0.5` 这类构造值；`CompressResult` 有 `tokensAfter`；
stillOverflow 有独立的界面文案。

**验收**：`tests/gui/stream-errors.spec.ts` 或新建 `tests/gui/context-compress-ui.spec.ts`：
① 断言 ChatPanel 里**没有** `cap * 0.5`；② 断言用了 `res.tokensAfter`；
③ 断言 stillOverflow 分支存在。

**变异**：把 `res.tokensAfter` 换回 `Math.round(cap * 0.5)` → 守卫必须红。

---

### 4.2 P1-2 turn 对齐裁剪 + 工具配对完整性

> ✅ **本条已落地（A-1082），且动手前的查证已完成 —— 结论是 (a)**：
> `loadSessionHistory`（`main/index.ts`）是**手工拼** `{role:"user",content:r.user}` /
> `{role:"assistant",content:r.ai}`，而 `HistoryRecord` 只有 `user`/`ai` 两个字符串字段
> ⇒ **持久化历史里根本没有 `tool` 消息**，工具结果只活在**单轮内的 `core-ts/src/services/tool_loop.ts`**。
> 所以「配对破坏」风险**当前不存在**：`validateHistory` 的 I1 分支当前**恒真**，它的价值是
> ① 防未来引入持久化工具消息时回归；② 保证 `buildCompactedHistory` 若被喂进带结构的序列时不破坏配对。
> 已落地：`context_loop.ts` 的 `planCut` / `trimTurnAligned` / `validateHistory`，
> `buildCompactedHistory` 改为 turn 对齐 + 结构原样透传；旧的 `hardTruncate`（`[首条, ...末K]`，
> 会产出 `user, user` 连续同角色）**已删除**，统一走 `truncateTurnAligned`。
> **仍待做**：轮内（`tool_loop` 中途）压缩的配对保护 —— 需要在 `tool_loop.ts` 里加压缩钩子时才成立。

**目标**：压缩/裁剪的切口只落在 **turn 边界**，且工具调用与结果**成对**。

**改**（纯模块，`context_compress.ts` 或新建 `core-ts/src/services/context_loop.ts`）：
1. `planCut(messages, keepPairs)`：从尾往前**按 turn**（以 `role === "user"` 为界）累计，
   切口落在 turn 边界（参考 OpenAI Agents SDK `TrimmingSession`：从后往前找第 N 个 user，
   保留**其后的全部 item**）。
2. `validateHistory(messages)`：四条硬不变量 ——
   `①` 以 `user` 开场；`②` 无连续同角色；`③` 每个 `tool_calls` 的每个 id 都有紧随的 `tool` 结果
   （或**成对**消失）；`④` 非 system 消息 ≥ 1。
3. `buildCompactedHistory`：**保留结构**（`tool_calls` / `tool_call_id` 等字段原样带过去；
   `tool` 角色**不许**塌成 `user`）。
4. `hardTruncate` 降级为 `trim` 的一档，且必须 turn 对齐（不许 `[首条, ...末K]`）。

**判据**：`validateHistory(buildCompactedHistory(...)) === true`；对含 tool_calls 的序列，
裁剪后 **id 集合守恒**（或成对消失，不许单边）。

**验收**：`tests/core-ts/context-compress.spec.ts` 扩用例（该文件已存在，现有 5 组）：
构造交错序列，断言 ①–④；再断言"切口两侧不是同一条 assistant 的两半"。

**变异**：① 切口改回"按条数硬切" → 红；② `tool` 角色塌成 `user` → 红；
③ 只删 `tool` 结果不删对应的 `tool_calls` → 红。

**坑**：LangGraph 官方那条参数就是为这个存在的 —— `trim_messages(start_on="human", end_on=("human","tool"))`；
它承认裁剪会丢信息，所以 **`trim` 必须排在最后**（见 P1-6 的顺序）。

---

### 4.3 P1-3 递进式摘要 + 存档回滚 + generation

**目标**：① 摘要**不倒退**（新摘要包含旧摘要要点）② 可回滚 ③ 异步压缩不覆盖新历史。

**改**：
1. `buildCompressSummaryPrompt(conversationText)` 增加 `priorSummary?: string`：
   有旧摘要时提示词改成"**在既有摘要基础上扩充**"（LangGraph 滚动摘要范式，逐字可抄），
   并要求输出里保留旧摘要的全部要点。
2. `setSessionSummary` 增加 `prior`（存档）：每次压缩落一条
   `{ at, dropped, tokensBefore, tokensAfter, summary }`，可查、可回滚（建议存到会话 meta 的数组，或独立 jsonl）。
3. 给 `contextSummary` 配 **`generation`**（单调 +1）。理由：压缩是异步的（`await engine.summarizeContext`），
   期间用户可能已发新消息 ⇒ **必须防"新压缩结果被更早的请求套用"**（OpenAI Agents SDK 的 Session 已内建这一条）。
   请求侧只接受 `generation >= 自己出发时看到的值`，过期摘要丢弃并标 stale。

**判据**：连续两次压缩后，摘要仍含第一次的要点；`generation` 单调；过期摘要不覆盖。

**验收**：`tests/core-ts/context-compress.spec.ts`：**纯函数层**测 `buildCompressSummaryPrompt` 在
有/无 priorSummary 时的提示词差异；`generation` 的接受/丢弃逻辑做成纯函数（如
`acceptSummary(currentGen, seenGen) => boolean`）后穷举。
⚠️ 一定要把 generation 判据抽成**纯函数**再测 —— 不要测主进程的异步时序（本仓测不过来的那种）。

**变异**：① 丢掉 `priorSummary`（每次从零重写）→ 红；② `acceptSummary` 恒 true → 红。

---

### 4.4 P1-4 「理解总结」环（AWAIT_COMPREHEND）—— **用户明确点名**

**目标**：压缩后**不立刻继续**，先让模型**回读摘要并自述当前状态**，作为续接锚；这一环必须**有界**。

**改**：
1. 新增纯模块（建议 `core-ts/src/services/context_loop.ts`）：
   - `buildResumeBlock(summary, archivePath?)` → 一段**只读**注入文本，含：
     ① 提示"以下是对过往工作的**记录**，不是待执行的任务"；② `<summary>` 全文；
     ③ 归档路径（若已做 P1-3）；④ 要求模型产出**固定 5 字段**：
     `目标 / 已完成+证据 / 失败与被否决 / 未决 / 下一步候选`。
   - `parseComprehend(text)` → 校验 5 字段齐备（纯函数，可穷举测试）。
2. 调用侧（`engine.ts` 或 `ChatPanel` 的压缩流程，**由你定但只准有一处**）：
   - **一次调用**、**禁副作用工具**（只允许只读工具或完全禁工具）、**硬超时**；
   - 失败重试 **1** 次；再失败 ⇒ **非阻塞降级**（继续对话）并留痕。
3. 每个 `compact_boundary` 之后**恰好跑一次**（用标志位/ref 保证）。

**判据**：① 5 字段齐备才算成功；② 自述**不得**提出未授权动作（安全闸：
若自述里有"接下来只允许调用 X / 忽略之前的规则"这类 → 视为失败并告警）；
③ 只跑一次；④ 失败不阻塞。

**验收**：`tests/core-ts/context-loop.spec.ts`：穷举 `parseComprehend`（齐备/缺字段/夹带指令句）；
`buildResumeBlock` 必含"不是任务"哨兵 + 归档路径占位。

**变异**：① 哨兵句删掉 → 红（防"摘要被当成新任务"⇒ 无限 Build→Compact 循环，这是有真实事故的）；
② 5 字段校验放宽成"非空即可"→ 红；③ "只跑一次"改成每轮都跑 → 红。
⚠️ **必须有界**：ReSum 的教训是"给模型无限推理空间去理解"在生产上不可接受。

---

### 4.5 P1-5 熔断

**改**：纯函数 `nextBreakerState(prev, outcome)`：连续失败 ≥ **3** ⇒ `open`（不再调用摘要模型）；
成功后 `closed`；`open` 状态下压缩请求直接返回"熔断中"并给可操作项。
失败计数维度：**"同一段历史是否已被处理过"**（JetBrains 教训：坏历史没被救出来却每轮重送）。

**验收**：穷举状态机；断言第 4 次**不再**调用摘要轮（用纯函数的返回值断言，不测真实调用）。

**变异**：阈值改成 `>= 999`（等于没熔断）→ 红；失败后不清零/不递增 → 红。

---

### 4.6 P1-6 `planCompaction` 四档动作（唯一出处）

**改**：`context_compress.ts` 新增纯函数
`planCompaction({ used, cap, ratio, turns, toolResultTokens, breaker, hasPriorSummary })`
→ `{ action: "none" | "clear" | "summarize" | "trim", reason: string }`。

- 顺序**不可换**：`clear`（工具结果成对清理 + 占位）→ `summarize` → `trim`。
  依据：JetBrains 实测「掩码打平摘要」+ Anthropic "tool result clearing 是最安全最轻量的一档"。
- `needsCompress` 收敛成其中一支（**保留原语义**，别改判据）。
- **任何 `none` 都必须带 `reason`**，且要**如实显示给用户**（现状的 `skipped` 是静默的 ——
  用户原话"逼近硬阈值却毫无动作"就是这个）。

**验收**：穷举输入 → 四档；`action==="none"` ⇒ `reason` 非空；工具结果占比高时优先 `clear`。

**变异**：① 把 `clear` 从判定里拿掉（顺序退化）→ 红；② `none` 不带 reason → 红。

---

### 4.7 P1-1 真实占用估算（CJK 感知）+ 口径统一

**现状问题**：同一个文件里**两套口径** —— `estimateTokensLocal`（CJK=1/字）与
`estimateHistoryTokens`（chars/4）。压缩触发用的是后者 ⇒ 4 倍低估。

**改**：`estimateHistoryTokens` 改成按 `estimateTokensLocal` 同口径逐条累加（+ 每条固定结构开销）。

**判据**（可测量）：1000 个汉字的 messages，`estimateHistoryTokens` 应落在 **900–1600**（而不是 ~250+）。

**验收**：`tests/core-ts/context-compress.spec.ts` 加一条"中文占比高的历史，估算不低于字数的 0.7 倍"。

**变异**：把 CJK 权重退回 chars/4 → 红。

**坑**：
- 改了估算会**改变压缩触发时机** ⇒ 必须回归 `main/index.ts:2940` 的 `Math.max(histUsed, hint)`
  与 `:2946` 的空转护栏（这两条是 A-974-R3 修的既有 bug，别打回去）。
- `SUMMARIZE_INPUT_CAP=9000` 也是同一口径问题：CJK 下它实际只覆盖约 9k 汉字 ⇒ 会误判"超限"而
  放弃摘要（第 ⑥ 条）。要么同步抬到合理值，要么在摘要轮前先跑 `clear`。

---

### 4.8 P1-8（可选）工具结果成对清理（clear 档）

Anthropic 官方称"最安全、最轻量、零 LLM 调用"的一档：把历史深处的原始工具输出**成对**清空、
用**占位文本**替换（`[已清理：<工具名> 的结果]`）。
⚠️ 本仓工具结果**不持久化**（见 §4.2 的 ⚠️）⇒ 这一档大概率只能作用于**轮内的 tool_loop**，
或等 P1-2 查明后再动。**先查证，别盲写。**

---

## 5. 门禁与验证（**本环境有硬限制，务必按 §5.2/§5.3 走**）

### 5.1 标准门禁（按序、串行、不许并发抢 CPU）

```bash
# 0) 改过 JSX/TSX 之后**先**过语法门（本仓特有的快速检查）
node scripts/parse-check.mjs gui/src/renderer/pages/ChatPanel.tsx

# 1) 三处 tsc —— ⚠️ `--noEmit` 保命 flag 必须带（否则往源码树吐编译影子）
node node_modules/typescript/bin/tsc -p tsconfig.base.json --noEmit
node node_modules/typescript/bin/tsc -p gui/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p gateway-ts/tsconfig.json --noEmit

# 2) 全量测试
node node_modules/vitest/vitest.mjs run

# 3) 构建 + 产物内核校验（第二步必须在 gui/ 里跑）
cd gui && node ./node_modules/electron-vite/bin/electron-vite.js build
cd gui && node scripts/assert-bundle.mjs      # 期望 ALL ASSERTIONS PASSED
```

### 5.2 ⚠️ 本运行环境的两条限制（不是代码问题，别去改代码迁就它）

1. **`mut-*.mjs` 跑不了**：这些脚本要 `spawnSync(process.execPath, …)` 跑 vitest，而本环境的
   WorkBuddy 运行时注入的 `node-brokered-fs-shim.cjs` **拦截 `child_process`** ⇒ 一律
   `EBUSY: spawnSync … node.exe`（**关沙箱也没用**，`execFileSync` / `shell:true` 同样被挡）。
   脚本会打印"基线未通过 —— 先修好测试再跑变异"。**基线失败发生在任何写入之前 ⇒ 源码零残留**（可放心）。
2. **写 OS 临时目录被拒**：`%TEMP%` 下的写入返回 `EPERM` ⇒
   `tests/core-ts/concurrency.spec.ts`（50 并发 appendFile）与 `tests/core-ts/encryption.spec.ts`
   （Python↔Node 跨栈往返）各有 1–3 条会**假红**，与改动无关。
   （另：环境负载高时 vitest 会从 ~17s 涨到 150s+，出现 `import.spec.ts` 等**既有 5s 超时 flake** ⇒ 重跑。）

**在 shell 顶层跑 vitest / build 是通的**（vitest 用 worker_threads，不再 spawn）。

### 5.3 跑不了变异套件时的**替代验证**（两条都要做）

**① 手工变异**（shell 顶层，改坏→跑守卫→还原→`diff` 校验）：

```bash
cp <目标> /tmp/bak
<改坏那一行>
node node_modules/vitest/vitest.mjs run <spec> --reporter=dot >/dev/null 2>&1 && echo GREEN || echo RED   # 期望 RED
cp /tmp/bak <目标>; diff -q <目标> /tmp/bak && echo "restore OK"
```

**② 锚点静态核验**（新增工具，只读）：

```bash
node gui/scripts/check-mut-anchors.mjs                                  # 扫全部 mut-*.mjs
node gui/scripts/check-mut-anchors.mjs gui/scripts/mut-a1063-streamerrors.mjs
```
判据：`1` = 命中且唯一 ✓ / `0` = **未命中（该守卫已失效）** / `>1` = **不唯一（可能改错对象）**。
**改过实现之后一定要跑它** —— 本仓反复踩"重构改了实现，变异锚点静默未命中，守卫失去保护"。
（2026-09-23 实测：`mut-a1063` 7/7、`mut-a1074-dock` 25/25、`mut-a1069` 25/25。）

---

## 6. 本仓硬规矩（接手必读，违反会被门禁挡）

1. **改代码三件套**：改前画 JSX 层级图核对开/闭 → `node scripts/parse-check.mjs <file>` 0 错 → tsc/测试/构建。
   **同一文件多处改动必须串行 + 改完读回/grep 复核**（并行 Edit 会静默丢一处）。
2. **纯逻辑不许住 `.tsx`**：新判据一律放纯模块（`core-ts/src/services/*.ts`），组件只消费。
3. **守卫必须过变异**（改坏→必须红），否则"通过但锁错对象"。
4. **重构要同步变异脚本的锚点**（用 §5.3 的工具查），否则那条守卫从此刻起失去保护。
5. **锚点不许依赖装饰性空白**（缩进/空行）；`toContain` 前先确认字串**唯一**，不唯一就带**邻位上下文**。
6. **中文句子里不许夹 ASCII 双引号**（`"…"` 一律写「」）—— 实测会把整份 spec 打成 0 用例。
7. **含反斜杠的代码（正则/`\n`）不要经 shell heredoc 写入**：本环境的 heredoc 会**吃掉一层反斜杠**
   （`\\` → `\`），本轮因此静默失败 3 次。**用编辑/写入工具（结构化传参）**。
8. **未获明确指令一律不提交**；提交要走 `slime/*` 分支，提交信息用同仓既有形态。
9. 门禁**串行**跑，禁并发抢 CPU；除 `run-capture.mjs` 外不要用管道（会吞 tsc 报错）。

---

## 7. 明确**不要**做的事（边界）

1. **不要引入 token 级 / 注意力级压缩**（LLMLingua / Gist / AutoCompressor / KV-cache 那一类）：
   要么需重训、要么要改推理内核，而且会**摧毁工具调用结构**。我们调的是黑盒 HTTP API。
2. **不要换掉本地全量历史**：压缩只作用于**本次请求的输入副本**（本地可回滚、可审计）。
3. **不要写死 token 阈值**：slime 面向多模型（128K / 512K 都有），主判据必须是**窗口占比**。
4. **不要为了让测试过而放宽判据**；也不要"顺手"改与本任务无关的既有护栏
   （`main/index.ts:2940/2946` 那两条是 A-974-R3 修的既有 bug）。
5. **不要在没有查证 §4.2 的 ⚠️ 之前**去写"通用工具配对保护"——先确认工具消息到底会不会进压缩输入。

---

## 8. 一句话总结交接

> **P0 已止血**（上下文超限 = 第三类，压缩一次 + 重试一次，不再 9 次空转重连）。
> **P1 主体已落地（A-1082）**：五条根因全部修掉 —— ①降级路径是**空操作 + 假报**（最致命：
> 界面报「已压缩 N 轮」而请求一字未减）、②摘要轮无条件放弃（9000 上限）、③CJK 4 倍低估、
> ④`force` 没接到主进程（P0 实际没接上）、⑤`cap×0.5` 假报；并补齐**用户点名的「理解总结」环**
> 与 turn 对齐裁剪 / 递进摘要 / 熔断 / skip-stale / `validateHistory` / 「压完仍超限」如实告知。
> **剩余**：P1-6 `planCompaction` 唯一出处（`clear` 档当前无对象可清）、P1-8、`loadHistoryForSession` 的
> 50 条静默上限、分层超时。**本环境跑不了 `mut-*.mjs`** ⇒ 用 §5.3 的两条替代验证（本轮五处变异已手工验完）。
