# slime Agent-Loop 设计

> 依据：三份调研报告 —— [agent-loop-research-report.md](../agent-loop-research-report.md)（33 来源 / 9 共识 / 5 分歧 / 17 反模式）、
> [llm-agent-memory-research.md](../llm-agent-memory-research.md)（39 来源，37 条抓取核验 / 15 失败模式）、
> [agent-plugin-ecosystem-research.md](../agent-plugin-ecosystem-research.md)（40 来源 / 8 个真实事故）。
>
> 本文只写**裁决与规格**，不写实现。每条裁决都标注依据来源编号或「工程推断」。
> 凡与 slime 现状冲突的，附现状证据（文件:行）。

---

## 0. 三条最反直觉的结论（先看这个）

调研推翻了三个我原本以为是常识的设计前提。它们改变了本设计的优先级：

| # | 结论 | 依据 | 对 slime 的直接含义 |
|---|---|---|---|
| **0.1** | **瓶颈在写入侧，不在检索侧** | 记忆报告 Q2：LongMemEval 两条最直接观察都是写入失败 —— ChatGPT *覆盖*关键信息（在线 0.5773 vs 离线全文 0.9184）、Coze *根本没记下*间接信息。只有 Zep / Mem0 把写入治理做成一等公民，也恰好是公开数字最好的两家；检索算法已进平台期 | slime 的 lesson 写入曾是这条的极端形态。⚠️ **但该结论所依据的实测语料 99.89% 是测试形态**（§3.1，真实内容只有 13 条），**「先修写入闸门，再谈检索」的优先级前提已变** —— 闸门现已在 `core/llm.py:1156` 落地，待验证的变成「已实现的闸门够不够」（§3.2.1） |
| **0.2** | **图结构不配做默认架构** | 记忆报告 Q4：Mem0ᵍ 加图后单跳 67.13→**65.71**、多跳 51.15→**47.19**（均下降）；HippoRAG 2 自认图方法「在基础事实记忆上明显低于标准 RAG」；UnWeaver 端到端 QA 上 VectorRAG 优于标准 GraphRAG；Zep 的 +18.5% 是对「全上下文」劣质基线的增益，**不是图 vs 向量的对照** | slime 的四阶段检索（`sidecar/retrieve_api.py`）把「links/backlinks BFS 遍历」放在阶段 2 且**默认启用** → 应按查询类型降级为可插拔层 |
| **0.3** | **遗忘机制只有理论优雅，无实证支持** | 记忆报告 Q5：MemoryBank 的艾宾浩斯曲线作者自述「探索性、高度简化」，贡献列表把「有无遗忘都能用」当**泛化性**而非增益，**全文无增益 ablation**；MemoryAgentBench 把 Selective Forgetting 列为**尚未掌握**的四项能力之一。唯一有正向数字的是 Zep/Mem0ᵍ 的**矛盾关系软失效**（标 `t_invalid` 而非物理删除） | slime 的 `forgetting_factor`（半衰期 5 天）**不要扩展成删除机制**；改造成「矛盾软失效」 |

---

## 1. 主循环：三段式 + 三闸

### 1.1 循环形态

行业共识是**没有比「LLM 在循环里自主用工具」更复杂的必要**（共识 1，Anthropic/LangChain/OpenAI/ADK/Manus 五方）。所以主循环保持简单，复杂度放在**闸门**与**上下文管理**上。

```
┌─ 段 A：准备 ────────────────────────────────────┐
│  组装上下文（身份/偏好 → 召回 → 技能清单）        │
│  ⚠️ 静态前缀必须字节稳定（见 §1.3）              │
└────────────────────────────────────────────────┘
                    ↓
┌─ 段 B：执行（循环体）───────────────────────────┐
│  模型推理 → 工具调用 → 拿环境真值 → 回到推理      │
│  · 每轮必须拿到真值才能继续（共识 2）             │
│  · 工具错误信息必须可执行（共识 7）               │
│  · 三闸检查（见 §1.2）                           │
└────────────────────────────────────────────────┘
                    ↓
┌─ 段 C：收尾 ───────────────────────────────────┐
│  显式完成信号 / 失败归因 / 异步写记忆（见 §3）    │
└────────────────────────────────────────────────┘
```

### 1.2 三闸取代单一轮次上限

**依据**（共识 3，四方同一口径）：
- ADK 官方原话：LoopAgent 自己不会决定何时停止，**「You *must* implement a termination mechanism」**
- AutoGen：「a run can go on forever」
- Claude Code：`max_turns` / `max_budget_usd` 双闸

**slime 现状**：Swarm 子任务只有轮次闸（`MAX_ROUNDS=3`，见 CLAUDE.md），无花费闸、无墙钟闸。

**裁决**：补成三闸，任一触发即终止并归因。

| 闸 | 阈值来源 | 触发后行为 |
|---|---|---|
| 轮次 | 现有 MAX_ROUNDS | 标记 `failed`，不虚报成功（保持现有语义） |
| **花费** | 新增，按 provider 定价折算 | 终止并上报实际花费 |
| **墙钟** | 新增 | 终止并上报已耗时 |

⚠️ 三闸必须**显式终止**，不能靠「模型自己觉得该停」。另有硬约束：**轮次耗尽未收到 `<DONE>` 一律 failed** —— 这条现有语义是对的，别改。

### 1.3 KV-cache 纪律（易被忽视的硬约束）

**反模式**：system prompt 开头放秒级时间戳 —— 破坏 KV-cache（反模式清单）。
**Manus 的一手复盘**：压缩会打碎 KV-cache。

**裁决**：
- 上下文组装遵守**只追加 + 稳定前缀**：身份/偏好/技能清单必须**字节稳定**地放在最前
- 时间戳等易变内容放**末尾**，且精度降到「天」或直接省略
- 压缩不得重写已有前缀（只能追加新块或替换尾部）

---

## 2. 记忆在 Loop 中的五个介入点

**核心原则：分层注射预算。** 依据是 Chroma《Context Rot》的量化结论 —— 同一批 306 题，**加 1 条干扰项就开始掉点**；且 ~300 token 的 focused 上下文对四族模型**全部显著优于** ~113k token 的全量上下文，**开 thinking 也补不平**。

所以：不是「记得越多越好」，而是**每一层的注入量必须有预算**。

| # | 时机 | 注入什么 | 预算 | 检索？ |
|---|---|---|---|---|
| **1** | Turn start | L1 身份 / 偏好 / 铁律 | **固定 ~300 token** | ❌ 不检索 |
| **2** | Pre-model | L2 情景记忆 | top-3，带来源标记 | ⚠️ **按需**，非每轮 |
| **3** | In-loop | L3 程序记忆 / 工具经验 | 模型主动拉取 | ✅ 工具调用 |
| **4** | Post-turn | —— （写入） | 异步、锁外 | —— |
| **5** | Idle | —— （巩固） | 空闲期批处理 | —— |

### 2.1 第 2 点：召回必须「按需」而不是「每轮」

**依据**：共识/反模式未直接给判据，但 Chroma 的干扰项实验给出了机制解释 —— 无关注入 = 噪声 = 掉点。

**裁决**：召回前加一道**廉价判据**（不需要 LLM），命中才召：
- 用户消息出现过去时/指代（「上次」「之前」「那个」）
- 出现新实体（专有名词、路径、人名）
- 任务类型切换

### 2.2 第 3 点：补上 `memory_recall` 工具（当前完全缺失）

**slime 现状**：[tools/builtin.py](../tools/builtin.py) 只注册了 `file_read / file_list / file_write / code_check / web_fetch / web_search` —— **模型没有任何主动查记忆的能力**，只能被动接受 `summary()` 塞给它的东西。这是当前 Agent-Loop 最大的结构缺口。

**裁决**：新增 `memory_recall(query, k, category?)` 与 `memory_write(content, category, importance)`。**合并为一个工具面**，不暴露底层向量库/嵌入模型。

### 2.3 第 4 点：写入移出锁（D3）

**slime 现状**：`_store_categorized_locked` 在**持有 per-agent `threading.Lock` 时**同步调 `_embed`（HTTP，timeout 2s）再写 LanceDB → 记忆写入被网络调用阻塞。

**裁决**：JSON 写入留在锁内（快），`_embed` + LanceDB 写入移到锁外异步。

---

## 3. 写入策略 —— 本设计的最高优先级

### 3.1 病根：写入闸门缺失

**闸门现状（已落地）** [core/llm.py:1156-1166](../core/llm.py#L1156-L1166)：

> ⚠️ **本文初稿引用的 `core/llm.py:1119-1134`（「无闸门，每次工具调用都写一条 lesson」）已与代码不符。** 当前写入路径已带闸门：

```python
_worth_remembering = (
    (not _tool_ok and not _env_rejection)
    or (_tool_ok and _prev_fail_streak > 0)
)
if _worth_remembering:
    _mem.add_lesson(
        f"用 {tool_name} 处理{args_str[:60]} 类请求{'成功' if _tool_ok else '失败'}",
        _tool_ok, importance=4,
    )
```

**该闸门逐行对应 §3.2 裁决表前四行**（成功不写 / 反复失败后成功写 / 失败且非环境原因写 / 沙箱拒绝不写）⇒ **§3.2 的裁决在代码侧已经落地**。

**语料实测**（2026-09-09 静态扫描 `Knowledge/Agent Memory/` 下全部 `memory.json`，未跑测试）：

| 指标 | 实测值 |
|---|---|
| agent 记忆目录 | **10,253 个** |
| 记忆条目总数 | **11,871** |
| `lesson` 类占比 | **98.8%**（11,724 条） |
| 不同内容（全库） | **35 条** |
| 最高频单条 | `用 agnes_generate_video 处理{} 类请求成功` × **2018** |
| **其中真实内容** | **13 条（0.11%）** |
| LanceDB 索引 | **空**（只有 2 个测试残留，3 B / 9 B） |

⚠️ **这是「测试形态实测」，不能作为容量规划或优先级排序的依据。** 逐条溯源，每一条都能在 `tests/` 里 grep 到出处：

| 模板族 | 生成处 | 条数 | 占比 |
|---|---|---|---|
| A. `用 {tool} 处理{args} 类请求成功\|失败` | [core/llm.py:1163](../core/llm.py#L1163) | **10,892** | 91.8% |
| B. `行为归档：场景「X」的步骤…` | [core/consolidation.py:60](../core/consolidation.py#L60) | **826** | 7.0% |
| C. `本次对话经验：…` | 对话经验抽取路径 | **140** | 1.2% |
| D/E. **真实内容** | —— | **13** | **0.11%** |

- **目录名形态**：10,242 个是 `agent_XXXXXXXX`（8 位 hex），那是 [core/agent.py:207](../core/agent.py#L207) 的**默认构造 id**（`agent_id or f"agent_{uuid4().hex[:8]}"`）；而 `config/agents.json` 里**实有 4 个生产 agent，id 全是 12-hex**。**没有一条生产路径会用默认 id 建记忆目录。**
- 10,492 / 10,892 的 A 族参数是测试占位符（`{}`、`{"path":"x"}` 之类）
- **2,835 条用的工具名只在 `tests/` 注册过**：`fake_echo` 2013（`tests/test_smoke.py:313`）、`probe_ctx` 417（`tests/test_agnes_media.py:714`）、`viz_echo` 405（`tests/test_tools.py:713`）
- 400 条 `用 web_search 处理 查询类请求成功` 与 `tests/test_tool_emotion.py:75` **逐字相同**
- B 族 826 条 = **恰好 2 个场景各 413**：`做饭`、`处理批量文件`（均出自 `tests/test_behavior_archive.py`）
- C 族 95 条含 `我是 TestSlime，测试角色`（测试 agent 的身份串）
- **全局索引交叉验证**：`.global/index.json` 共 35 条 —— 22 条归模板条目（hits 401–2017），**13 条真实内容的 hits 全是 0**

> **准确定性**：语料是**「测试套件反复跑出来的形态」**，而不是「测试夹具污染」。它忠实刻画了**写入闸门缺失时的写入放大系数**，但**完全不刻画真实使用形态**。**作为「无闸门时的放大系数」证据它仍然有效；作为「真实容量/真实分布」证据完全无效。真实分布是 13 条。**

而读侧最多只返回 **3 条** —— [core/llm.py:636-637](../core/llm.py#L636-L637) `_retrieve_tool_experience` 里的 `if len(hits) >= 3: break`。
（⚠️ 本文初稿引用的 `core/llm.py:612` 现已指向另一个函数 `_retrieve_behavior_archive` 的 `return "\n".join(parts)`，链接已修正。）

> **写侧无上限、读侧封顶 3 条。** 这与记忆报告的结论（Q2：瓶颈在写入侧）完全吻合，只是 slime 是它的极端形态。

> ⚠️ **代码事实补充（不依赖语料）**：上句「写侧无上限」指的是**调用点** `core/llm.py:1163` 不传任何条数上限；**存储层已有上限** —— [core/memory.py:1005-1011](../core/memory.py#L1005-L1011) 在 `len(facts) >= _max_entries()`（默认 `_MAX_ENTRIES = 2000`）时先 `_spill_to_archive()` 腾位置，腾不出就**丢弃本次写入**。**跨 agent 无总量上限**仍是代码事实。
>
> 另有一条本文原未提的**第二条读侧封顶路径**：`memory.summary()` 默认 `max_items=10`（`core/memory.py:1103`），graph / semantic 各取 `[:3]`（`core/memory.py:1162,1165`），lessons 取 `limit=max_items*2` 后再 `[:max_items]`（`core/memory.py:1183,1188`）。

为什么去重没救回来？**两个原因叠加**：
1. **去重是 per-agent 的** —— 每个 agent 有独立的 `memory.json`（`Knowledge/Agent Memory/<agent_id>/memory.json` 按 agent_id 分目录），跨 agent 永不收敛。**依据是结构性代码事实（存储按 agent_id 分目录），不依赖语料构成。**
   （⚠️ 精确化：自 A-1139 起 [core/memory.py:947-957](../core/memory.py#L947) 已有**跨 agent 去重** —— 命中时本地只留 `shared_refs` 指针、不新增内容。但**内容仍留在原 agent 的 `memory.json` 里，物理上不收敛**，故「各 agent 记忆库独立」这一结构事实不变。）
2. **中文 Jaccard 失效** ——「用户喜欢用 Python 写脚本」vs「用户偏好使用 Python 编程」只有 0.20，够不着 0.75 阈值（本次已修，见 §3.3）

### 3.2 写入闸门（裁决）

**原则：工具成功不是经验。** 依据是记忆报告 Q3 的巩固做法与 Q2 的写入失败模式。

| 事件 | 是否写 | 理由 |
|---|---|---|
| 工具调用**成功** | ❌ **不写** | 「file_read 成功」不构成任何可复用知识 |
| 工具**反复失败后成功** | ✅ 写 | 「这条路走通了」是真经验 |
| 工具失败且**原因非显然** | ✅ 写 | 负经验有价值 |
| 沙箱拒绝 / 权限错误 | ❌ 不写 | 环境噪声，非认知收获 |
| 用户显式纠正 | ✅ 写（高 importance） | 最高价值信号 |
| LLM 抽取的事实/偏好/教训 | ✅ 写（现有 `extract_memories_from_chat` 路径） | 保留 |

**配套**（**三条均已在代码侧落地**，见 [core/memory.py:928-957](../core/memory.py#L928) 与 `core/llm.py:1156`）：
- 写入前查**跨 agent 全局去重**（不只 per-agent）—— ✅ `_cross_agent_scan()`，命中则本地只留 `shared_refs` 指针、不新增内容
- **写入必须有上限**：单 agent 记忆条目数达到阈值后，新条目只能通过替换/合并进入（不能无限追加）—— ✅ `len(facts) >= _max_entries()`（默认 2000）时先并入高相似旧条目、再 `_spill_to_archive()` 软归档腾位置；腾不出则**丢弃本次写入**
- 现有 `importance=4` 的机械写入全部删除 —— ✅ 即 §3.1 的 `_worth_remembering` 闸门

#### 3.2.1 优先级前提已变：从「要不要修闸门」到「已实现的闸门够不够」

**原裁决「先修写入闸门，再谈检索」的前提已不成立** —— 闸门连同上表配套三条现已在代码侧实现。待验证的问题因此变成 **「已实现的闸门够不够」**，而这件事**目前无法用现有语料证伪**：

- **证伪不了：真实样本只有 13 条。** 实测语料里真实内容只有 **13 条**（§3.1），且这 13 条在全局索引里 `hits` 全是 0。闸门宽一点、窄一点，在 13 条上都看不出差别 —— 用这批数据调参等于**对着测试模板拟合**。**必须先攒出足量真实语料才能评估。**
- **仍成立、且与语料无关的结构性事实**：读侧封顶 3 条 / `summary()` 封顶 10 条；写侧单 agent 封顶 `max_entries`；**跨 agent 无总量上限**。
- **因此 P1 不应再按「停掉 per-tool-call lesson」排期**（已经停了），而应改为：① 在真实使用中观测闸门命中率；② 拿到足量真实语料后再回来校准「闸门够不够」。

### 3.3 中文相似度（本次已修）

**已完成**（见 §7 附录 A 的改动清单）：
- `_tokens()`：CJK 补**字符 unigram + bigram**，拉丁仍按空白分词
- `_text_similarity` / `_rank_by_relevance` 共用 `_tokens`
- 阈值按真实语料校准：**去重 0.75 保留**（召回 0.867 / 误判 3.2%）、**建链 0.3 → 0.70**（原值会误链 42%）

**实测改善**（真实语料 15 组同模板对 / 285 组不同模板对）：

| 方案 | 同模板均值 | 不同模板均值 | 判别间隔 |
|---|---|---|---|
| 旧（空白分词） | 0.6204 | 0.1009 | 0.5195 |
| **新（CJK 单+双字）** | **0.8386** | 0.2534 | **0.5852** |

⚠️ **两分布有重叠**（不同模板 max=0.882 ≈ 同模板 max=0.889），不存在完美阈值。且**不同工具的模板条目相似度约 0.74，距 0.75 阈值仅 ~0.01 余量** —— 所以去重阈值**不能往下调**。

> **一处反直觉但正确的例外**：本节的校准样本，正是 §3.1 里那批被判定为「测试形态」的语料 —— 而在这里它**恰好是恰当样本**。§3.1 问的是「真实使用会产生什么」，那批语料答不了；本节问的是「不同工具的模板条目彼此长什么样」，而**模板条目正是生产代码会产生的形态**（`core/llm.py:1163` 写出的就是这种串），测试语料在这里与生产形态同分布。**这是全文档唯一一处「测试语料用对了地方」** —— 结论（去重 0.75 不能下调）保留。

### 3.4 伪嵌入（本次已修）

**slime 现状**：`_embed` 失败时 `return _hash_embed(text)`，而其实现是字符码位截断，**补位值 `ord(' ')/256 = 0.125` 而非 0**。

**实测**：5 个语义完全无关的短中文文本两两余弦 **min=0.9659 / max=0.9920 / 均值=0.9835**（真实嵌入应在 0.3~0.6）；`'你好'` 只有 **2/1024** 维度承载信息，其余是常数；超过 1024 字符的内容**完全不可见**。

**裁决**：`_embed` 失败返回 **None**（显式失败），调用方走「无向量 → 回落关键词」分支。已删除 `_hash_embed`。

> **设计原则**：**静默的垃圾比显式失败更糟。** 这条在插件安全上同样适用（§6）。

---

## 4. 检索策略：图降级为可插拔层

### 4.1 裁决

**依据**：§0.2（Mem0ᵍ 加图后单跳/多跳**均下降**；UnWeaver：VectorRAG > 标准 GraphRAG）。

**slime 现状**：`sidecar/retrieve_api.py` 四阶段 = 向量种子 → **links/backlinks BFS（默认启用）** → 标签过滤 → 艾宾浩斯排序。文件头已注明「@deprecated，已移植为 Node 侧 `core-ts/src/memory/retrieve.ts`」。

**裁决**：
1. 默认链路改为 **向量 + 全文（FTS）混合** —— 这正是 Zep 自己的检索（cosine + BM25 + BFS 三路混合，图只是其中一路）
2. **链接遍历降级为「按查询类型触发的可插拔层」**：仅当查询显式要求多跳关联（「和 X 相关的所有 Y」）时才启用
3. 建链阈值已从 0.3 提到 0.70（§3.3），图谱密度显著下降

### 4.2 读取侧是独立瓶颈（最被低估的优化点）

**依据**：记忆报告 Q2 —— LongMemEval 原话「即使召回完美，准确利用检索条目也绝非易事」；**仅换阅读格式（Chain-of-Note + 结构化）就 +10 绝对点**。

**裁决**：`summary()` 的输出格式是一等公民，不是收尾工作：
- 检索结果必须**结构化**（分条、带 category / 时间 / 来源标记），不是一段散文
- 与 Chroma 的结论一致：**少而准 > 多而全**（~300 token focused 全面优于 ~113k full）

---

## 5. 遗忘：从「艾宾浩斯衰减」改为「矛盾软失效」

### 5.1 裁决

**依据**：§0.3（艾宾浩斯无实证支持；唯一有正向数字的是软失效）。Zep 时序题 45.1%→**62.4%**、Mem0ᵍ 55.51→**58.13%**。

**slime 现状**：`forgetting_factor = exp(-days/5.0) × (importance/10)`. 它**只重排、不删除**（这点是对的），但有两个问题：

1. **它没有实证依据** —— 半衰期 5 天是拍出来的
2. **它有实现级 bug（富者愈富）**：`summary()` 每次调用都会把选中的 top-N 的 `last_accessed` 刷成当前时间。于是排名外的「沉睡记忆」**永远不会被 touch**，也就永远进不了 top-N —— 「沉睡但可唤醒」在实现上不成立

**裁决**：
- **保留**衰减作为**排序信号**（无害，且能防陈旧条目霸榜）
- **删除**「`summary()` 调用即刷新 `last_accessed`」—— 只有**真正的检索命中**才算访问
- **新增矛盾软失效**：新条目与旧条目**语义冲突**时，把旧条目标 `invalid_at`（**不物理删除**），检索默认过滤已失效条目但允许显式查回

### 5.2 不要做的事

**不要**把遗忘做成「到期物理删除」。依据：无任何实证来源支持遗忘带来增益；而物理删除不可逆，误删代价高于留存成本。

---

## 6. 多 Agent 边界与插件/模式设计

### 6.1 单 / 多 Agent 判据（可直接做工程判据）

| 判据 | 结论 | 依据 |
|---|---|---|
| 强并行 + 上下文超窗 + 大量复杂工具 | → 多 agent | 共识 5 |
| 共享同一上下文 / 高依赖 | → 单 agent | 共识 5 |
| **写操作** | **必须单线程** | Cognition 2026 |
| **只读子 agent** | 才能并行 | Cognition 2026 |
| 工具数爆炸导致选错工具 | → 多 agent | LangChain |
| **成本** | 多 agent 是 **~15× token** 的决策，不是架构口味 | Anthropic |

**⚠️ 对 slime 的硬约束**：Swarm 当前是**并行 executor 写共享 worktree**（`core/swarm.py` / `core/executor.py`）。按上表这踩了「并行写操作」反模式。**裁决**：Swarm 的写操作必须串行化，或每个 worker 独占 worktree 后再合并（AGENTS.md §1.3 已有 worktree 隔离规范，需确认执行器真正落到了它）。

**验证必须来自外部真值**（共识 6）：
- 已有 `core/claims.py` 幻觉护栏（产物存在性校验）—— **扩展为三类硬校验**：① 产物存在性 ② 测试通过 ③ 引用可溯源
- **反模式**：同上下文自我批评。验证者必须用**完全干净的上下文**（Cognition 2026）

### 6.2 三档模式

**关键调研结论（否定性）**：**未找到任何产品实现「标准 / 创造 / 自定义」三档**。最接近的是 **Zed 恰好三个内置 profile（Write / Ask / Minimal）**；Cursor 团队 marketplace 有三档分发（Default Off / Default On / Required），但控的是分发强制度而非能力面。

→ **slime 做这个会是第一个。** 且主流模式维度是四轴：**工具集 × 权限 × 提示词 × 模型**。

**好消息：slime 已有两档。** `core-ts/src/services/agentTools.ts` 已有：

```ts
export interface ToolProfile {
  mode: "default" | "custom";
  skills: string[];
  mcp: string[];
}
```

| 档位 | 现状 | 缺什么 |
|---|---|---|
| **① 标准** | ✅ `mode="default"` + `DEFAULT_TOOL_PROFILE`（6 个推荐技能） | 只差显式命名 |
| **② 创造** | ⚠️ 半成品 | 见 §6.4 |
| **③ 自定义** | ✅ `mode="custom"` + skills/mcp 白名单 + `ToolProfilePicker` | 只差提升为一级模式 |

**⚠️ 命名冲突**：现有 `mode` 字段（`build`/`grow`/`normal`/`plan`，见 `gui/src/renderer/pages/AgentsPanel.tsx:70`、`core/llm.py:292`）是**行为模式**，与能力档位不是一回事。**不得复用该字段名** —— 裁决：能力档位用 `capability_profile`。

### 6.3 插件页

**slime 现状**：`SkillsPanel.tsx` 已是半个插件页（列表 / 启用停用 / 新增自定义技能 / Skill 广场拉 anthropics/skills / GitHub Token 加密存储 / 安装删除 / 打开目录）。

**裁决**：插件页**不重复 SkillsPanel**，而是**统一清单**，把三类收在一个视图：

| 来源 | 载体 | 说明 |
|---|---|---|
| 官方市场 | `config/skills/<name>/SKILL.md` | 现有 `skillMarketInstall` |
| **用户自备** | 同上 + 用户自选 MCP | 现有 `skillAdd` |
| **Agent 自建** | 同上，但**标记来源** | 新增，见 §6.4 |

实现位置：`gui/src/renderer/pages/SettingsDialog.tsx:26` 的 `SettingsTab` 加一项 + `SECTIONS` 加一条 + 渲染分支。

### 6.4 创造模式：让 Agent 给自己造插件

**已有的半成品**：`core-ts/src/services/agentTools.ts:83-111` 的 `agentSkillGuide()` **已经在系统提示里教 Agent 怎么给自己装技能**：

```
技能目录（绝对路径）：<root>
新增技能：在 <root>\<技能名>\ 下写 SKILL.md（必须），frontmatter 至少含 name 与 description
写入后用 skill_search 复核是否已能被检索到
```

**调研给出的最小闭环（10 步，每步有源）**：
缺口检测 → 写制品 → **把 description 当检索键写**（模型只凭它决定触发）→ 结构校验 → **执行验证** → 落位 → 重载 → 再入隔离 → 回滚 → worktree 隔离

**对 slime 的裁决**：
1. **创造模式 = 显式开启**该能力（而非提示里的附带说明），并**在 UI 上可见产物**
2. **必须补「执行验证」**：现在写完只 `skill_search` 复核「能不能被检索到」，这**不验证它能不能用**。要补：用测试输入真跑一次，失败则拒绝落位
3. **description 是一等公民**：模型只凭它决定是否触发技能，所以校验必须检查 description 的**判别力**（能否与已有技能区分）
4. **失败模式必查**（调研已列）：描述不匹配永不触发 / 上下文预算被工具定义吃光 / 自改代码逃逸沙箱 / 注释投毒（tool poisoning、rug pull、shadowing）/ 不可见 Unicode 污染 / 版本未重载

### 6.5 插件安全（本次调研最有价值的差异化机会）

**关键发现**：Claude Code 官方文档**明文承认**「插件可以以你的用户权限在你的机器上执行任意代码」，且**权限规则与沙箱只覆盖 Claude 发起的工具调用，不覆盖插件自跑的代码**（hooks / MCP / LSP / mods 全在沙箱外，`bin/` 还会进 PATH）。

→ **主流产品都没把插件代码关进沙箱。这是自研平台能做差异的地方。**

**已核验的真实事故**：
- `postmark-mcp`（npm，2025-09）：**首个野外恶意 MCP server**，一行代码把每封邮件 BCC 给攻击者，下架前 **1,643+ 次下载**
- **CVE-2025-54135 CurXecute**（Cursor，CVSS 8.6）：`~/.cursor/mcp.json` 新增条目**自动启动无需确认**，一条 Slack 消息即可 RCE。原文：「**即使这次编辑被拒绝，代码执行也已经发生了**」
- Pillar 的 Rules File Backdoor：不可见 Unicode 污染规则文件，**在 PR 审核界面同样不可见**

**裁决（三条铁律）**：
1. **插件代码默认进沙箱** —— slime 已有 `core/sandbox.py`（L0–L5），插件执行必须走它，不能像主流那样「插件代码在沙箱外」
2. **`Agent 自建的插件不得能修改自己的权限配置`** —— 这是调研给自研平台的第一条铁律。落点：`core/permissions.py` / `slime.toml [sandbox]` 属于 AGENTS.md §6 的受保护模块，插件写路径必须硬拒绝
3. **配置变更必须「先同意后执行」** —— 直接针对 CVE-2025-54135 的「自动启动无需确认」模式

---

## 7. 落地顺序

| 阶段 | 内容 | 可独立验证 | 风险 |
|---|---|---|---|
| **P0** ✅**已完成** | 伪嵌入改显式 None / 中文相似度 / 零向量哨兵 | 探针 + 43 用例全过 | 低。**注意**：会暴露此前被掩盖的 embedding 失败 |
| **P1** ✅**已实现**（待验证） | 写入闸门（§3.2，`core/llm.py:1156`）+ 单 agent 上限 + 跨 agent 去重 | **不再是「增长率归零」，而是「真实语料下的闸门命中率」** —— 现有 13 条真实语料不足以验证（§3.2.1） | 低（已落地）。⚠️ 改变 Agent 行为语义这件事**已经发生**，需用户追认 |
| **P2** | 写入移出锁（§2.3）+ 跨 agent 全局去重 | 并发写压测 | 低 |
| **P3** | `memory_recall` / `memory_write` 工具（§2.2） | 模型能主动查记忆 | 低 |
| **P4** | 三闸（§1.2）+ KV-cache 纪律（§1.3） | 长任务不再失控 | 低 |
| **P5** | 图降级为可插拔（§4.1）+ 读取格式（§4.2） | 召回质量对比 | 中 |
| **P6** | 软失效取代衰减刷新（§5.1） | 矛盾条目被正确标记 | 中 |
| **P7** | 三档模式 + 插件页（§6.2–6.4） | UI 可见 | 中 |
| **P8** | 插件沙箱化 + 三条铁律（§6.5） | 恶意插件被拦 | 高（安全关键） |

**阶段依赖**：P1 必须在 P3 之前 —— 否则给一个被投毒的记忆库装上「主动检索」只会放大噪声。

**未决项（需用户决策）**：
1. ~~已积累的 11,796 条记忆如何处置（备份后清空 lesson / 只留有 fact 与 preference 的 agent / 冷冻观察）—— **这是用户数据，不擅自删**~~
   **⚠️ 结论已更正：那不是用户数据，是测试残留** —— §3.1 实测真实内容只有 **13 条**，其余是测试套件反复跑出来的模板条目。
   **谨慎态度保留：仍不擅自删**，但**保留的理由必须换** —— 不是「怕删掉用户数据」，而是：① 存储按 agent_id 分目录，删哪个 agent 的目录需要用户显式指定；② 这批数据是**闸门修好之前的写入放大系数证据**，留着可复跑探针做前后对照。处置选项同原案（清空 lesson / 只留 fact 与 preference / 冷冻观察），但风险等级从「不可逆的用户数据丢失」降为「可重建的残留清理」。
2. P1 写入闸门会改变 Agent 行为语义，需认可
3. Swarm 并行写的串行化方案（§6.1）与现有 AGENTS.md worktree 规范如何对齐

---

## 附录 A：P0 已完成改动清单

| 文件 | 改动 |
|---|---|
| `core/memory.py` | 新增 `_tokens()`（CJK unigram+bigram）；`_text_similarity` / `_rank_by_relevance` 改用之；新增 `_DEDUP_THRESHOLD=0.75` / `_LINK_THRESHOLD=0.70`；`_embed` 改返回 `Optional` 且失败返回 `None`；**删除** `_hash_embed`；新增 `_memory_table_schema()` 替代零向量哨兵建表；4 个 `_embed` 调用点全部处理 `None`；修正 `drop_table` 处与代码不符的「记忆可再生」注释 |
| `tests/test_model_server.py` | `TestEmbedFallback` 重写：断言降级返回 `None`、`_hash_embed` 已不存在 |
| `tests/test_memory_similarity.py` | **新增** 5 个测试类，锁定 token 化 / 中文相似度 / 真实语料阈值 / 阈值不变式 |

**验证**：`py -m pytest tests/test_memory_similarity.py tests/test_model_server.py -q --basetemp=<dir>` → **43 passed, exit=0**

## 附录 B：探针（可复跑）

| 探针 | 作用 |
|---|---|
| `temp_test_dir/probe_memory_defects.py` | 量化伪嵌入退化 + 中文 Jaccard 失效 |
| `temp_test_dir/probe_memory_state.py` | 盘点记忆存储真实状态（10,253 目录 / 11,871 条；⚠️ 见 §3.1 —— **这是「测试形态实测」，不是真实分布**，真实内容仅 13 条） |
| `temp_test_dir/probe_memory_rootcause.py` | 追查 lesson 泛滥根因 |
| `temp_test_dir/probe_similarity_variants.py` | 5 种 token 化方案对比 |
| `temp_test_dir/probe_threshold_sweep.py` | 阈值扫描（去重 / 建链） |

## 附录 C：环境问题（非 slime 代码问题）

1. **`%TEMP%\pytest-of-MR\pytest-current` 是损坏的 reparse point**，导致 `py -m pytest` 在 teardown 阶段抛 `PermissionError` 并返回 **exit=1**（测试实际全过）。`rmdir` 无法删除。**绕过**：`--basetemp=<dir>`。疑与 DSH 沙箱此前在 `%TEMP%` 的权限操作有关。
2. `delegate_task` 全角色不可用：`tools.restrict() names unknown global tool "review_task"`。

---

## 8. 第二轮补缺口调研的增量

来源：[agent-loop-research-supplement.md](../agent-loop-research-supplement.md)（三类缺口：Google 消费级 agent / OpenAI reasoning / Anthropic Managed Agents 与 context management）。
以下四条**修正或补强**前文，其中 §8.1 是本次最有价值的架构增量。

### 8.1 【新增能力】事前 critic + veto（slime 当前完全缺失）

**Google 的一手架构**（[architecting-security](https://blog.google/security/architecting-security-for-agentic/)）：
```
planner 读页面决策
   → User Alignment Critic 逐动作复核
       · 只喂「动作元数据」，隔离不可信内容（防间接注入）
       · 可否决 → 带反馈回 planner 重规划
       · 连续失败 → 交还用户
   → 执行（注入分类器与 planner 并行）
```

**为什么对 slime 是硬缺口**：slime 只有 `core/claims.py`（**事后**核验「已保存/已生成」类声称的路径是否存在），**没有任何事前否决**。事后护栏只能在产物没生成时报警，拦不住「这个动作本身就不该做」。

**裁决**：新增 critic 环节，插在「模型决定动作」与「工具执行」之间。三条实现约束：
1. **输入隔离**：critic 只拿动作元数据（工具名 + 参数 + 目标），**不喂工具返回的原文与网页内容** —— 这是防间接注入的关键，否则 critic 自己会被投毒
2. **可否决且带反馈**：veto 后不是简单拒绝，而是把理由回给 planner 重新规划
3. **连败交还用户**：连续 N 次未通过 → 停手交人，不要无限重试

### 8.2 【补强 §1.3】压缩的首选形式是「清工具结果」，不是整体摘要

**Anthropic 官方原话**（[context-engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）：
> **tool result clearing 是最安全、最轻量的 compaction 形式**

官方给的形态选择：多来回对话 → compaction；迭代式 → note-taking；并行探索 → multi-agent。

**具体参数**（官方 SDK 例程一手印证，`clear_tool_uses_20250919`）：

| 参数 | 含义 | 官方示例 |
|---|---|---|
| `trigger` | 何时触发清理 | 30000 token |
| `keep` | 保留最近几个 tool use | 3 |
| `clear_at_least` | 至少清掉多少 | —— |
| `exclude_tools` | 豁免哪些工具 | —— |

**裁决**：slime 的 `[context]` 配置（现只有 `head` / `tail` / `window`，见 [slime.toml:26](../slime.toml#L26)）**补上 trigger / keep / exclude 三个 token 旋钮**，并优先实现「只清工具结果」这一档 —— 它比重写摘要便宜得多，也不破坏 KV-cache 前缀（§1.3）。

### 8.3 【参考实现】Anthropic memory tool 的文件模型与实测数字

**官方数据**（[context-management 官博](https://claude.com/blog/context-management)）：memory tool + context editing 比 baseline **+39%**；仅 editing **+29%**；100 轮检索 token **−84%**。

**文件模型**（官方 SDK 例程 `basic.py` 一手印证）：
- 根目录 `/memories`，markdown 格式，类型 `memory_20250818`
- 命令：`view` / `create` / `str_replace` / `insert` / `delete` / `rename`
- ⚠️ **必须限制在 `/memories` 内，防路径穿越**

**裁决**：slime 的 `Knowledge/Agent Memory/<agent_id>/` 设计与此同构，**验证了现有方向**。但要注意两点差异：
1. slime 的 `_validate_agent_id`（`^[A-Za-z0-9_-]{1,64}$`）已防 agent_id 穿越 —— 这点是对的，保留
2. Anthropic 给的是**客户端**文件式记忆（模型自己读写文件），而 slime 现在是**服务端自动注入**（`summary()`）。§2.2 新增的 `memory_recall` / `memory_write` 工具正是往「模型自管」方向补 —— 与本参考一致

### 8.4 【选型约束】接 o 系列时必须保留 reasoning item

**OpenAI 官方要求**（[reasoning_items cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/responses_api/reasoning_items.ipynb)）：reasoning item 必须**跨工具调用保留** —— 同一 turn 内有 function call 就必须回传（`previous_response_id` 或显式入 `input`）。

- **Chat Completions 做不到；Responses API 可以**；官方实测 SWE-bench **+3%**
- 无状态多轮 loop 用 `include=["reasoning.encrypted_content"]` + ZDR 强制 `store=false`（内存解密不落盘，缓存命中 40%→**80%**）
- 唯一的「分离」= 不暴露原始 CoT，只给 reasoning summary
- 选型原话：**「reserve reasoning models for high complexity tasks」**（配 router 按复杂度路由）

**对 slime 的含义**：`core/llm.py` 若接入 o 系列，**必须走 Responses API 并保留 reasoning item**；用 Chat Completions 会静默掉点。这是一个「不报错但变差」的坑，与 §3.4 的伪嵌入同类。

### 8.5 仍属未找到

- **Google Project Mariner 自身循环**：官方模型页已下线（落回首页）、实验室博客 **404**；`support.google.com` 与 `ai.google.dev` 在本机网络 curl 返回 **000**（完全不可达，非 403）。改用 Google 安全博客的 Chrome agentic 架构（§8.1）作为 Google 消费级 agent 的一手来源。
- **Anthropic context management 文档正文**：`platform.claude.com` / `docs.anthropic.com` **301 → 地区限制页**；`claude.com/docs/**` 404。相关细节标注为「三方镜像 + 官方 SDK 交叉印证」。
- **官方 token 阈值建议**：未找到。

> **方法论提示**（对后续调研有用）：`platform.openai.com` / `developers.openai.com`（403 Cloudflare）与 `platform.claude.com`（地区限制 301）正文都抓不到，但**官方 GitHub 仓库可 curl**。同类调研优先走官方 GitHub 组织（`openai/openai-cookbook`、`anthropics/anthropic-sdk-python`）。
