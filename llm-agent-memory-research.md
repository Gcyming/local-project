# LLM Agent 记忆系统：前沿架构与实证结论（深度网络调研报告）

**调研范围**：学术系统（MemGPT/Letta、A-MEM、HippoRAG 1/2、GraphRAG、Zep/Graphiti、Mem0、MemoryBank、Generative Agents）+ 工业实现（Anthropic memory tool、OpenAI memory、Cursor、Windsurf、LangChain/LangGraph）+ 评测基准（LongMemEval、LOCOMO、MemoryAgentBench、MemoryArena、Context Rot）

**核验规则**：本报告中标注 `[已验证]` 的 URL 均由本次调研实际发起 HTTP 抓取并返回 200 且正文内容与标题一致；标注 `[未核验]` 的表示正文抓取被跨域重定向或反爬拦截，仅确认该 URL 被搜索引擎索引存在。**未找到可靠来源的条目已明确标注。**

**证据强度分级**（全文表格沿用）：

| 级别 | 含义 |
|---|---|
| **A** | 第三方独立评测 / 同行评审论文，非被评测方自己做的实验 |
| **B** | 作者/厂商自评，但公开了实验设置、数据集与可复现数字 |
| **C** | 厂商工程文档或博客，无对照实验、无可复现数字 |
| **D** | 用户社区单一报告，仅作存在性证据 |

---

## 1. 来源清单

### 1.1 评测基准

| # | 标题 | URL | 一句话结论 | 实证数据 | 级别 |
|---|---|---|---|---|---|
| 1 | LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory (ICLR 2025) | https://arxiv.org/abs/2410.10813 `[已验证]` | 500 题、5 类长时记忆能力，长上下文 LLM 掉 30%~60%，商用聊天助手只有 30%~70% 准确率 | 是 | A |
| 2 | LongMemEval 论文全文（含表 1/表 3.4） | https://arxiv.org/html/2410.10813v2 `[已验证]` | 同上，含 ChatGPT 在线记忆 vs 离线全文阅读对照表 | 是 | A |
| 3 | LongMemEval 官方仓库 | https://github.com/xiaowu0162/LongMemEval `[已验证]` | 基准与代码公开 | 否 | A |
| 4 | Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions（MemoryAgentBench, ICLR 2026） | https://arxiv.org/abs/2507.05257 `[已验证]` | 四能力（AR/TTL/LRU/SF）全覆盖，现有记忆 agent **没有任何一个在四项上同时达标** | 是 | A |
| 5 | MemoryAgentBench 论文全文 v4（含数据集总表） | https://arxiv.org/html/2507.05257v4 `[已验证]` | 2071 题，上下文 103k–1.44M token；明确写出 top-k 检索的失效边界 | 是 | A |
| 6 | MemoryAgentBench 官方仓库 README | https://cdn.jsdelivr.net/gh/HUST-AI-HYZ/MemoryAgentBench@main/README.md `[已验证]` | 指标口径、评测命令、ICLR 2026 录用 | 是 | A |
| 7 | Evaluating Very Long-Term Conversational Memory of LLM Agents（LOCOMO） | https://arxiv.org/abs/2402.17753 `[已验证]` | 35 会话 / 300 轮 / 9K token；长上下文与 RAG 有改善但**仍大幅落后人类** | 是 | A |
| 8 | MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks (ICML 2026) | https://arxiv.org/abs/2602.16313 `[已验证]` | 在 LoCoMo 上接近饱和的 agent，在**多会话 agentic 任务里表现很差**——记忆"记住"≠"用得上" | 是 | A |
| 9 | Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers（综述，2022–2026） | https://arxiv.org/abs/2603.07670 `[已验证]` | 把 agent 记忆形式化为 write–manage–read 闭环，五大机制族；点出 write-path filtering / contradiction handling / 遗忘为未解难题 | 是（综述） | A |
| 10 | Context Rot: How Increasing Input Tokens Impacts LLM Performance（Chroma 技术报告） | https://www.trychroma.com/research/context-rot `[已验证]` | 18 个模型；LongMemEval 上"只喂相关内容"与"喂全量 113k"差距巨大，且**单条干扰项就开始掉点** | 是 | A |

### 1.2 学术记忆系统

| # | 标题 | URL | 一句话结论 | 实证数据 | 级别 |
|---|---|---|---|---|---|
| 11 | MemGPT: Towards LLMs as Operating Systems | https://arxiv.org/abs/2310.08560 `[已验证]` | OS 式虚拟上下文：main context（core memory）+ external context（archival/recall），由 LLM 自己调函数搬数据 | 是（DMR） | B |
| 12 | Letta 官方文档：Context hierarchy（memory blocks / files / archival memory 对比表） | https://docs.letta.com/v1-sdk/memory/context-hierarchy.md `[已验证]` | 给出四种记忆抽象的可编辑性、是否常驻上下文、工具集与容量上限 | 否 | C |
| 13 | Letta 官方博客：Sleep-time Compute（MemGPT 2.0 / sleep-time agents） | https://www.letta.com/blog/sleep-time-compute `[已验证]` | 主 agent 不再持有改记忆的工具，改由独立 sleep-time agent 在空闲时重写 core memory | 否（博客）/是（论文） | B |
| 14 | Sleep-time Compute: Beyond Inference Scaling at Test-time | https://arxiv.org/abs/2504.13171 `[已验证]` | 同等准确率下测试期算力降 ~5×；加大 sleep-time 算力可再涨 13%（GSM-Symbolic）/18%（AIME） | 是 | B |
| 15 | A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025) | https://arxiv.org/abs/2502.12110 `[已验证]` | Zettelkasten 式笔记网络：每条记忆生成关键词/标签/上下文描述，自动建链并**反向演化旧记忆** | 是 | B |
| 16 | A-MEM 论文全文 v11（含 LoCoMo 六模型结果表） | https://arxiv.org/html/2502.12110v11 `[已验证]` | 排名 1.2（vs MemGPT 2.4 / MemoryBank 4.8），token 长度 2520（vs MemGPT 16977） | 是 | B |
| 17 | HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs (NeurIPS 2024) | https://arxiv.org/abs/2405.14831 `[已验证]` | 知识图 + Personalized PageRank；多跳 QA 最高 +20%，比 IRCoT 便宜 10–30×、快 6–13× | 是 | B |
| 18 | HippoRAG 2: From RAG to Memory (ICML 2025) | https://arxiv.org/abs/2502.14802 `[已验证]` | **自认图方法在"基础事实记忆"上曾显著低于标准 RAG**；本版在关联记忆上比 SOTA 嵌入模型 +7% | 是 | B |
| 19 | HippoRAG 官方仓库 README | https://cdn.jsdelivr.net/gh/OSU-NLP-Group/HippoRAG@main/README.md `[已验证]` | 离线索引成本"显著低于 GraphRAG/RAPTOR/LightRAG"；不牺牲简单任务 | 是 | B |
| 20 | GraphRAG: From Local to Global（Microsoft） | https://arxiv.org/abs/2404.16130 `[已验证]` | 只针对"全局性总结类问题"、约 1M token 语料，在**全面性与多样性**上超过传统 RAG | 是 | B |
| 21 | Zep: A Temporal Knowledge Graph Architecture for Agent Memory | https://arxiv.org/abs/2501.13956 `[已验证]` | 三层图（episode/semantic entity/community）+ 双时间轴；LongMemEval +15.2%~18.5%，延迟 −90% | 是（自评） | B |
| 22 | Zep 论文全文 v1（含 DMR 与 LongMemEval 明细表） | https://arxiv.org/html/2501.13956v1 `[已验证]` | DMR 上 Zep 94.8% vs MemGPT 93.4%，但**全上下文基线 94.4%**；作者自承 DMR 基准不合格 | 是（自评） | B |
| 23 | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | https://arxiv.org/abs/2504.19413 `[已验证]` | 抽取→比对→LLM 选 ADD/UPDATE/DELETE/NOOP；LOCOMO 上 J 比 OpenAI 高 26%，图版本仅 +2% | 是（自评） | B |
| 24 | Mem0 论文全文（含 LOCOMO 全表） | https://ar5iv.labs.arxiv.org/html/2504.19413 `[已验证]` | OpenAI memory 时序题 J 仅 21.71（全场最低），作者归因于"时间戳丢失" | 是（自评） | B |
| 25 | MemoryBank: Enhancing Large Language Models with Long-Term Memory (AAAI 2024) | https://arxiv.org/abs/2305.10250 `[已验证]` | 层次化日记+用户画像；遗忘用 Ebbinghaus 曲线 R=e^(−t/S)，S 初始化 1、每次召回 +1、t 归零 | 是 | B |
| 26 | MemoryBank 论文全文 v3（含定量结果表 2 与遗忘模型自述） | https://arxiv.org/html/2305.10250v3 `[已验证]` | 作者自述遗忘模型是"探索性的、高度简化的"；**未给出遗忘模块的增益 ablation** | 是 | B |
| 27 | Generative Agents: Interactive Simulacra of Human Behavior (UIST'23) | https://arxiv.org/abs/2304.03442 `[已验证]` | memory stream + 检索打分（相关性+时近性+重要性）+ reflection；消融显示三组件均关键 | 是 | A |
| 28 | Generative Agents 论文全文 v2 | https://arxiv.org/html/2304.03442v2 `[已验证]` | 最常见错误：**检索不到相关记忆**、给记忆编造 embellishment、继承模型的过度正式文风 | 是 | A |
| 29 | UnWeaving the knots of GraphRAG — turns out VectorRAG is almost enough | https://arxiv.org/abs/2603.29875 `[已验证]` | 端到端 QA 上**纯向量 RAG 优于标准 GraphRAG**，且接近 SOTA 图方案，成本只是零头 | 是 | A |

### 1.3 工业实现

| # | 标题 | URL | 一句话结论 | 实证数据 | 级别 |
|---|---|---|---|---|---|
| 30 | Anthropic 工程博客：Effective context engineering for AI agents | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents `[已验证]` | 记忆 tool 是**文件式、客户端侧**（`/memories` 类文件系统）；提出 compaction / structured note-taking / sub-agent 三招 | 否 | C |
| 31 | Anthropic memory tool 官方文档页 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool `[未核验]` | 该 URL 被搜索引擎索引，但本次抓取连续被 302 到 `www.anthropic.com`，**正文未能核验**；机制描述以第 30 条为准 | — | — |
| 32 | OpenAI Help Center：Memory in ChatGPT | https://help.openai.com/en/articles/8590148-memory-in-chatgpt `[已验证]` | saved memories / memory summary / reference chat history 三层；模型自决记什么；关闭 reference chat history 后 30 天内删除 | 否 | C |
| 33 | OpenAI Agents SDK：Sessions | https://openai.github.io/openai-agents-js/guides/sessions/ `[已验证]` | 官方"会话记忆"抽象是 Session（含 MemorySession / 对话式 Session），**不存在名为 memory_store 的官方概念** | 否 | C |
| 34 | OpenAI Agents SDK：Sandbox agents → Agent memory | https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/ `[已验证]` | 页面存在，正文被超长导航挤占未能取出；SDK 中有 `MemorySession` 类作为短期会话存储 | 否 | C |
| 35 | LangChain 官方文档：Memory overview | https://docs.langchain.com/oss/python/concepts/memory.md `[已验证]` | semantic/episodic/procedural 三分；写入分 hot-path vs background；**profile 会丢信息、collection 转成"删改难"** | 否 | C |
| 36 | Cursor 官方文档：Rules | https://cursor.com/docs/rules `[已验证]` | `docs.cursor.com/context/memories` 现 302 到该页；Cursor 官方口径是"LLM 不在补全间保留记忆，用 Rules 提供持久上下文" | 否 | C |
| 37 | Cursor 研究博客：Securely indexing large codebases | https://cursor.com/blog/secure-codebase-indexing `[已验证]` | Merkle 树 + 语法分块 + 嵌入 + 团队内索引复用；语义搜索带来 12.5% 准确率提升 | 是（自评） | C |
| 38 | Windsurf（Cognition）文档：Cascade Memories & Rules | https://docs.devin.ai/windsurf/plugins/cascade/memories.md `[已验证]` | memory 由 Cascade **自动生成**、"自认为有用"即写入；规则文件上限 12000 字符；**无遗忘机制说明** | 否 | C |
| 39 | Cursor 社区论坛：Can't clear memories | https://forum.cursor.com/t/cant-clear-memories/148254/3 `[已验证]` | 用户报告无法清除记忆，agent 自述 `update_memory` 工具不可用、记忆"属于系统永久指令" | 否 | D |

---

## 2. 分层方案对比表

> 「写入策略」列中"谁决定"回答：模型自决 / 规则 / 摘要机。

| 系统 | 分层 | 写入策略（什么被记 / 谁决定 / 门槛） | 巩固与遗忘 | 检索策略 | 实测结论（自评/第三方） |
|---|---|---|---|---|---|
| **MemGPT** | main context（core memory，常驻提示词）↔ external context（recall=全历史、archival=向量库） | **模型自决**：LLM 在对话中自己调 `core_memory_append/replace`、`archival_memory_insert` 等函数；无显式门槛 | 主上下文溢出时 **eviction + 递归摘要**压进 recall storage；无淘汰语义 | 工具调用式检索（模型自己发 query 查 archival） | DMR 93.4%（gpt-4-turbo）；**Zep 团队无法在 LongMemEval 上复现 MemGPT**（"未能取得有效回答"） |
| **Letta（MemGPT 后继）** | Memory blocks（可编辑、常驻）> Files（只读、可 open/close/grep）> Archival memory（读写、**不常驻**）> External RAG | 块由 agent 自决改写（`memory_rethink/replace/insert`）；**推荐上限**：块 <50k 字符、<20 块/agent，archival 单条 300 token、条数不限 | **sleep-time agent** 在空闲时重写主 agent 的 core memory，把"增量变脏"的记忆整理为"干净、简明、详尽" | archival 向量检索 + 文件 `semantic_search`/`grep`；块直接常驻 | Sleep-time 论文：同准确率下测试期算力 −5×；GSM-Symbolic +13%、AIME +18%；**但效果与"用户 query 可预测性"强相关**（自评） |
| **A-MEM** | 单一 note 网络（Zettelkasten），无显式工作/情景/语义分层；每条 note = 内容+时间戳+关键词+标签+上下文描述+嵌入+链接集 | **模型自决 + 结构化**：LLM 生成 K/G/X 属性；建链 = 先用嵌入取 top-k 邻居，再让 LLM 判定是否连边 | **Memory Evolution**：新记忆插入时会让 top-k 邻居的上下文/关键词/标签被 LLM 重写并**原地替换**（无删除、无衰减） | **纯余弦 top-k（k=10）为主**；被检索到的 note 所在的"box"（链接邻居）会被一并带出 | LoCoMo 六模型，平均排名 1.2、token 长度 2520（自评）；Mem0 复跑 A-Mem 得 J=39.79，**显著低于 Mem0 的 67.13**（第三方复跑，但由竞争对手执行） |
| **HippoRAG / 2** | 无对话式分层；离线索引=开放 IE 抽三元组建 KG（实体节点+事实边+段落节点），在线=检索 | 离线批处理写入，**非模型自决**：OpenIE 抽取全部三元组，无重要性门槛；不做遗忘 | 无遗忘；HippoRAG 2 用"filtered triples"+更深段落整合降低噪声 | **混合**：查询实体识别 → 图上的 **Personalized PageRank** 传播 → 段落排序 | HippoRAG 1：多跳 QA 最高 +20%，比 IRCoT 便宜 10–30×、快 6–13×；HippoRAG 2：关联记忆比 SOTA 嵌入 +7%；**并自认"图方法在基础事实记忆上曾明显低于标准 RAG"**（自评） |
| **GraphRAG（Microsoft）** | 文档→实体 KG→Leiden 社区→社区摘要（层次索引）；查询侧分 local / global 两种模式 | 离线 LLM 抽取实体与关系 + 社区摘要，**规则驱动**，全量写入 | 无遗忘；社区摘要即"抽象层"巩固 | **图遍历 + map-reduce 摘要**（global search）或实体邻域（local search） | 仅对"全局总结类问题"、1M token 量级语料，在**全面性/多样性**上胜传统 RAG（自评）；**独立评测显示端到端 QA 上不如 VectorRAG**（UnWeaver） |
| **Zep / Graphiti** | 三层子图：episode（原始、无损）→ semantic entity → community；**双时间轴** T（事实有效区间）/ T′（入库事务时间） | **LLM 抽取 + 冲突消解**：抽实体/事实三元组，与同实体对的既有边做混合检索去重；矛盾时**不物理删除**，而是设置 `t_invalid` 使旧边失效（保留历史） | 边失效即"软遗忘"；community 用标签传播做动态扩展，**定期仍需全量刷新**（作者承认会漂移） | **三路混合**：cosine 语义 + Okapi BM25 全文本 + **图 BFS**（n 跳）；再上 RRF/MMR/episode-mentions/node-distance/cross-encoder 重排 | LongMemEval_S：gpt-4o 全上下文 60.2% → Zep 71.2%；延迟 28.9s → 2.58s；上下文 token 115k → 1.6k。**但 single-session-assistant 反而下降**：94.6%→80.4%（自评） |
| **Mem0 / Mem0ᵍ** | 扁平事实集合（Mem0）或 有向标记图（Mem0ᵍ：节点=实体，边=关系，节点带类型/嵌入/时间戳） | **两阶段 LLM 自决**：抽取阶段用「全局摘要 + 最近 10 条消息 + 当前消息对」抽出候选事实；更新阶段取 top-10 相似记忆，让 LLM 选 ADD / UPDATE / DELETE / NOOP | DELETE 用于"被新信息推翻"的记忆（真删）；Mem0ᵍ 则把过时关系**标记失效而非物理删除**，以支持时序推理 | Mem0：向量检索；Mem0ᵍ：**双路**（实体锚点 + 邻域子图）与（全查询嵌入 vs 三元组文本编码） | LOCOMO（自评）：Mem0 J 单跳 67.13 / 多跳 51.15 / 开放域 72.93 / 时序 55.51。**图记忆（Mem0ᵍ）在单跳（65.71）与多跳（47.19）上不升反降**，仅时序升到 58.13 |
| **MemoryBank** | 三层：原始对话（带时间戳）→ 日事件摘要 → 全局摘要；并维护日/全局用户画像 | **摘要机驱动**：LLM 按固定 prompt 逐日摘要事件与人格，无重要性门槛 | **Ebbinghaus 遗忘曲线**：R=e^(−t/S)，S 初始 1、被召回时 +1 且 t 归零；无合并、无抽象 | 双塔稠密检索（DPR 式）+ FAISS 向量索引，**纯向量** | 自评 194 题：ChatGPT 版检索准确率 0.763、回答正确性 0.716、连贯性 0.912；**Mem0 在 LOCOMO 上复跑 MemoryBank 得 F1 5.00**（跨基准迁移后近乎失效） |
| **Generative Agents** | 单一 memory stream（自然语言全记录）+ reflection（更高层推断）+ plan，三者互相写回 stream | **全量记录**（"complete record of experiences"），无写入门槛；reflection 由重要性累积触发 | reflection 即**抽象式巩固**：把零散观察合成为高层推断并写回 stream；**无遗忘**（只增不减） | 打分排序：score = 相关性(嵌入余弦) + 时近性(指数衰减) + 重要性(LLM 打 1–10)，三者加权；top-k 进提示词 | 消融：observation / planning / reflection 三组件**各自都关键**；最常见失败是**检索不到相关记忆**与**给记忆编造细节**（A） |
| **Anthropic memory tool** | 文件系统式：`/memories` 目录下的客户端侧文件（非服务端记忆） | **模型自决**：agent 自己决定建/读/改哪些文件；无写入规则 | **无自动遗忘**；靠客户端实现，官方仅建议用 compaction 与"结构化记笔记" | agentic retrieval：模型自己列目录、读文件、grep，**不做预计算嵌入检索**（just-in-time） | 无对照实验（C）；官方自陈代价："运行时探索比预计算检索慢"、"缺引导时 agent 会浪费上下文、追死路、找不到关键信息" |
| **OpenAI memory（ChatGPT）** | "Improved Memory"= 持续更新的**整体摘要**；"Legacy saved memories"= 显式条目列表；外加 reference chat history / custom instructions / Library 文件 / 连接应用 | **模型自决**：saved memories 可"用户明确要求"或"ChatGPT 在其行为可用时自行保存"；官方明说"不保留每次对话的每个细节，由 ChatGPT 决定哪些信息相关" | **无自动遗忘**。用户侧纠正/删除/"Don't mention this again"（只减少引用、**不删源**）；关闭 reference chat history 后 30 天内删除派生记忆 | 未公开；官方仅称"当可能改善回答时寻找相关上下文" | **LOCOMO 时序题 J=21.71、F1=14.04，为全部被测系统中最低**；Mem0 作者归因："尽管显式要求带时间戳抽取，大多数生成的记忆仍缺时间戳"（第三方复跑） |
| **Cursor** | Rules（项目/用户/团队/AGENTS.md，提示词层持久上下文）与 codebase index（向量检索）**是两件事** | Rules **人工撰写**（`alwaysApply` / `description` / `globs` 三字段决定注入时机）；codebase index 由 Merkle 树变更检测 + 语法分块 + 嵌入**自动增量写入** | rules 无遗忘（手工删）；索引按内容哈希缓存嵌入、文件删除即从服务端删除 | 语义搜索（嵌入）+ 索引复用（simhash 在向量库中找相似索引） | 语义搜索带来 **12.5% 平均准确率提升**（自评）；中位仓库首个查询 7.87s → 525ms，p99 4.03h → 21s（自评） |
| **Windsurf Cascade** | Memories（自动生成，工作区隔离）+ Rules（用户手写，global / `.windsurf/rules` / 企业 system-level） | **模型自决**："Cascade 若遇到它认为值得记住的上下文，会自动生成并存储记忆"；无门槛、无审核 | **文档完全未提遗忘或淘汰**；用户可在 Customizations 面板手工编辑 | 文档仅称"当它认为相关时检索"，未披露机制 | 无实证数据（C） |
| **LangChain / LangGraph** | short-term（thread-scoped，checkpointer 持久化）↔ long-term（跨 thread，namespace + key 的 JSON 文档 store）；long-term 再分 semantic / episodic / procedural | 明示两条路：**hot path**（Agent 在回复前自决写，如 ChatGPT 的 `save_memories` 工具）vs **background**（异步任务写）。hot path 代价：增加延迟、agent 要"一心二用"、可能影响记忆数量与质量 | 文档坦承：**改成 collection 就"把复杂度转移到删改"**，"有些模型倾向过度插入、有些倾向过度更新"，需借助 Trustcall 类工具与评估来调 | semantic search + 内容 filter；procedural 用 reflection/meta-prompting 改写指令 | 无对照实验（C） |

---

## 3. 失败模式清单（每条附来源与数据）

### F1. 「存入时就没存住」——写入侧遗漏间接信息
- **来源**：LongMemEval（A）https://arxiv.org/html/2410.10813v2
- **数据/原话**：论文让证据以"间接方式"出现在任务型对话里（例如不直说"我上个月买了车"，而是问车险）。人工评测发现 **Coze"经常没能记录用户间接提供的信息"（often failed to record indirectly provided user information）**。
- **意义**：写入门槛/触发点设计不当，会让正确答案**从未进入记忆库**——此时任何检索优化都无效。

### F2. 「存进去了但被覆盖」——知识更新被错误的写入策略破坏
- **来源**：LongMemEval（A）同上
- **数据/原话**：**"ChatGPT 倾向于随对话推进覆盖关键信息"（ChatGPT tended to overwrite crucial information as the chat continues）**。
- **量化对照**：在线记忆 vs 离线全文阅读——**ChatGPT 0.5773 vs GPT-4o 离线阅读 0.9184**（同一 97 题、3–6 会话、约为 LongMemEval_S 的 1/10 长度）。即：在**远易于**正式基准的设置下，只拿到 58%。
- **意义**：这是与"遗忘"相反方向的失败——不是忘得太快，是**更新得太激进/太粗糙**。

### F3. 时间戳缺失导致时序推理整体崩塌（商业记忆功能的实测最差项）
- **来源**：Mem0 论文 LOCOMO 全表（第三方复跑，但由竞争厂商执行——需打折阅读）https://ar5iv.labs.arxiv.org/html/2504.19413
- **数据**：OpenAI memory 在 **temporal** 类问题上 F1 = **14.04**、B1 = 11.25、J = **21.71**，为全表最低（Mem0 自身 48.93/40.51/55.51）。作者归因：**"尽管在提示中明确要求带时间戳抽取记忆，大多数生成记忆仍缺时间戳"**。
- **旁证**：LongMemEval 也把 temporal reasoning 单列，并指出 **"朴素的、时间无关的记忆设计在时序问题上表现很差"**，其 time-aware 索引+查询扩展把时序召回提升 **6.8%~11.3%**。

### F4. 长上下文"全塞进去"并不等于记忆（Context Rot 定量证据）
- **来源**：Chroma Context Rot 技术报告（A，独立于被评测方）https://www.trychroma.com/research/context-rot
- **数据**：取 LongMemEval_S，筛出 knowledge-update / temporal-reasoning / multi-session 三类，人工清洗后 **306 题、平均 ~113k token**；对照组"focused"只给相关片段、**平均 ~300 token**。**在所有被测模型（GPT、Claude、Gemini、Qwen 四族）上，focused 显著高于 full。** 即使开启 thinking 模式，两条件间的差距**依然存在**。
- 同样在 18 个模型上：**加入即使只有 1 条干扰项就开始掉点**；4 条干扰项进一步叠加；**针-问相似度越低，随长度衰减越快**。
- **反直觉发现**：把 haystack 句子打乱（破坏逻辑连贯）后，**18 个模型的表现一致变好**。

### F5. 纯向量 top-k 的机制性边界（基准作者原话）
- **来源**：MemoryAgentBench（A）https://arxiv.org/html/2507.05257v4
- **原话**：RAG 类方法"面对歧义查询、多跳推理与长程理解仍吃力。**当问题需要整合整个会话的知识、或从很长的技能型输入中学习时，检索机制——被限制在 top-k 最相关段落——可能无法把必要信息捞出来**。"
- **量化框架**：MemoryAgentBench 2071 题、103k–1.44M token，覆盖 AR / TTL / LRU / SF 四能力；论文结论：**"现有方法未能掌握全部四项能力"**。

### F6. 跨基准"记忆饱和"是假象
- **来源**：MemoryArena（ICML 2026，A）https://arxiv.org/abs/2602.16313
- **原话**：**"在 LoCoMo 等现有长上下文记忆基准上接近饱和的 agent，在我们的 agentic 设置中表现很差"**——因为既有基准把"记忆"与"行动"割裂评估。
- **意义**：单一基准上的高分不能外推到"用记忆指导决策"。

### F7. 图/结构化记忆在**简单事实检索**上可能倒退
- **来源 1**：HippoRAG 2 论文自述（A/B）https://arxiv.org/abs/2502.14802 —— **"这些（图增强）方法在更基础的事实记忆任务上，性能明显低于标准 RAG"（drops considerably below standard RAG）**。这正是 HippoRAG 2 要修的问题。
- **来源 2**：Mem0 的 Mem0ᵍ 消融（B）https://ar5iv.labs.arxiv.org/html/2504.19413 —— 加图后 **单跳 67.13 → 65.71、多跳 51.15 → 47.19（均下降）**；作者原话：**"多跳问题上，Mem0ᵍ 预期的关系优势并未转化为更好的结果"**、"在图结构上进行多步推理可能存在开销或冗余"。只有时序从 55.51 → 58.13。
- **来源 3**：UnWeaver（A）https://arxiv.org/abs/2603.29875 —— **"在端到端 QA 评测上，VectorRAG 优于标准 GraphRAG，并且几乎与当前 SOTA 图方案持平，成本只是零头"**。

### F8. 检索到的信息"用不好"——读取侧独立瓶颈
- **来源**：LongMemEval（A）https://arxiv.org/html/2410.10813v2
- **原话+数据**：**"即使记忆召回完美，准确利用检索到的条目也绝非易事。"** 加上 Chain-of-Note 与结构化数据格式后，**三个 LLM 上 QA 准确率提升最高达 10 个绝对点**。
- **意义**：召回率不是终点；同样的记忆喂给模型，格式与阅读策略本身值 10 分。

### F9. 检索式记忆在"助手侧信息"上倒退
- **来源**：Zep 论文 LongMemEval 分类明细（B，厂商自评且对自己不利）https://arxiv.org/html/2501.13956v1
- **数据**：single-session-assistant 类：gpt-4o **全上下文 94.6% → Zep 80.4%（−17.7%）**；gpt-4o-mini **81.8% → 75.0%（−9.06%）**。knowledge-update 在 4o-mini 上也 −3.36%。
- **意义**：引入检索管线会**牺牲一部分本来靠长上下文就能做对的题**。任何"记忆改造"都必须做**回归测试**，而不只看平均分。

### F10. 遗忘机制缺乏增益证据
- **来源**：MemoryBank 论文（B）https://arxiv.org/html/2305.10250v3
- **事实**：(a) 作者自己写：**"需要说明的是，这是一个探索性的、高度简化的记忆更新模型。"** (b) 贡献列表把"**在有/无记忆遗忘机制两种情况下都可用**（Applicability with and without memory forgetting mechanism）"列为**泛化性**论据，而**不是**报告遗忘带来的性能增益。全文未找到遗忘模块的消融增益数字。
- **旁证**：MemoryAgentBench 把 **Selective Forgetting** 列为核心能力之一，并用 FactConsolidation-SH/MH 专门测"面对矛盾证据时改写/覆盖/删除旧信息"——说明该能力**至今仍被当作未解决问题在测**，而非已验证有效的手段。
- **结论**：**"Ebbinghaus 式遗忘带来实测收益"目前未找到可靠来源支持。**

### F11. 巩固（compaction）本身会丢信息
- **来源**：Anthropic 工程博客（C）https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **原话**：**"压缩的艺术在于选择保留什么、丢弃什么，因为过于激进的压缩会导致丢失那些微妙的、但其重要性稍后才显现的关键上下文。"** 官方建议：先把 prompt 调到**最大化召回**，再迭代收紧精度；并称"最安全、最轻量的压缩形式之一是清除工具结果"。
- 另一条官方承认的权衡：agentic retrieval **"运行时探索比检索预计算数据更慢"**，且**"缺乏适当引导时，agent 会因误用工具、追死路、识别不出关键信息而浪费上下文"**。
- **Claude Code 的官方取舍**：CLAUDE.md 直接塞进上下文，而 glob/grep 走 just-in-time，**"有效绕开了陈旧索引和复杂语法树的问题"**——即把"索引陈旧"当作向量索引的固有病。

### F12. 长上下文模型在"有干扰项"时的行为差异（含幻觉率）
- **来源**：Chroma Context Rot（A）https://www.trychroma.com/research/context-rot
- **数据**：失败分析显示 **GPT 系模型幻觉率最高**（干扰项在场时给出自信但错误的回答）；**Claude 系幻觉率最低**，倾向于弃权（明确说找不到答案）。
- **副作用**：Chroma 发现 Claude Opus 4 / Sonnet 4 因为"过度保守弃权"，在 LongMemEval full prompt 上**反而比更老的 Claude 版本分数更低**——即"更谨慎"与"更高分"之间并不一致。

### F13. 无法复现的前作
- **来源 1**：Zep 论文（B）https://arxiv.org/html/2501.13956v1 —— **"鉴于当前 MemGPT 框架不支持直接导入既有消息历史，我们通过把对话消息加入 archival history 做了绕过；但我们未能用这种方式取得成功的问答回答。"** 即 **MemGPT 在 LongMemEval 上不可复现**。
- **来源 2**：同上 —— 同一篇论文里，作者对**自己主打的 DMR 基准**给出了否定评价：**"每段对话只有 60 条消息，很容易放进当前 LLM 上下文窗口"**、**"该评估只依赖单轮事实检索问题，无法评估复杂记忆理解"**、**"简单的全上下文方法在现代 LLM 上取得的高分进一步凸显了该基准的不足"**。
- **来源 3**：Mem0 论文（B）对 A-Mem 的复跑：A-Mem 自报 LoCoMo F1 27.02 / BLEU 20.09（GPT-4o-mini），Mem0 复跑得 F1 20.76 / BLEU 14.90，**J 仅 39.79**。
- ⚠️ **引用警告**：两篇论文对**同一组 A-Mem/MemGPT 数字的类别归属不一致**。A-Mem 原文把 27.02 标为 **Multi-Hop**、44.65 标为 **Single-Hop**；Mem0 表 1 则把 27.02 放在 **Single-Hop** 列、44.65 放在 **Open Domain** 列。**跨论文引用这两组 F1 时必须核对列对齐，否则会得出相反结论。**

### F14. 评测本身在"内卷"：长基准已不再有区分度
- **来源**：MemoryAgentBench（A）https://arxiv.org/html/2507.05257v4
- **原话**：早期基准 **LOCOMO（~9k token）、LooGLE（~24k）、LongBench（~20k）"上下文相对较短，已不再能挑战当前模型"**；同时批评 LongMemEval **"主题多样性有限、交互模式不够真实"**。
- **旁证**：MemoryArena（A）https://arxiv.org/abs/2602.16313 —— 明确指出既有评测把记忆与行动割裂。

### F15. 工业侧：无遗忘、无治理
- **Windsurf**（C）https://docs.devin.ai/windsurf/plugins/cascade/memories.md：由 Cascade "自认为有用"即自动写入；**文档通篇没有遗忘、淘汰、冲突消解的任何机制说明**。
- **Cursor**（D，单一用户报告）https://forum.cursor.com/t/cant-clear-memories/148254/3：用户无法清除记忆，agent 自述 `update_memory` 工具不可用、"记忆是系统永久指令的一部分，只能通过本界面之外的特定内部机制修改"；且**旧记忆会被长期沿用**，用户只能每次开新对话时手动要求别用。
- **OpenAI**（C）https://help.openai.com/en/articles/8590148-memory-in-chatgpt：**"Don't mention this again 只减少未来引用，不删除原始来源"**；删除一条 saved memory **不会**删除原对话，删除原对话**也不一定**删除由它派生的 saved memory——存在**孤儿记忆**的结构性风险。官方还承认"memory summary 不包含 ChatGPT 记住的全部内容"。

---

## 4. 对五个必答问题的回答

### Q1. 纯向量 top-k 检索在长时记忆任务上的**具体失败模式**是什么？有量化数据吗？

有，且可分成五类互相独立的失败：

| 失败模式 | 机制 | 量化证据 | 来源 |
|---|---|---|---|
| **①时间不可检索** | 嵌入把"3 周前""上个月"这类相对时间抹平；缺时间戳的记忆在时序 query 下无法被召回 | OpenAI memory temporal 类 **J=21.71 / F1=14.04**（全表最低）；LongMemEval 报告朴素时间无关设计在时序题上"表现很差"，加 time-aware 索引+查询扩展后时序召回 **+6.8%~11.3%** | Mem0 表 1；LongMemEval §5.4 |
| **②粒度错配** | 以"会话"为单位切块时，一个 chunk 混入多主题，向量被平均成"什么都像、什么都不准" | LongMemEval：**回合（round）粒度优于会话粒度**；压成"用户事实"虽提高多会话推理，但**因信息损失反而拉低总体表现** | LongMemEval §5.2 |
| **③索引键太薄** | 只用原文当 key，query 措辞不同就召不回 | 用抽取出的事实做**键扩展**：recall@k **+9.4%**、下游 QA 准确率 **+5.4%** | LongMemEval §5.3 |
| **④top-k 的结构性上限** | 需要聚合整个会话、或整合长程分布式信息时，相关片段不落在 top-k 内 | MemoryAgentBench 作者原话（top-k"可能无法把必要信息捞出来"）；四能力无方法全达标 | MemoryAgentBench §2.2/§1 |
| **⑤干扰项让向量相似度失去分辨力** | 高相似但不回答问题的文本挤占 top-k | 18 模型上**加 1 条干扰项就开始掉点**，4 条叠加更差；针-问相似度越低，随长度衰减越快；GPT 系在干扰项在场时**幻觉率最高** | Chroma Context Rot |

**还应该补一条"对照实验"级的证据**：Chroma 把同一批 LongMemEval 题（306 题，knowledge-update / temporal-reasoning / multi-session）分别以 **~113k token 全量** 和 **~300 token 只含相关片段** 喂给模型，**四族模型全部是 focused 显著高于 full**，且开 thinking 也补不平差距。这直接量化了"检索+去噪"这一步值多少分。

---

### Q2. 写入侧和检索侧，哪个是当前系统的瓶颈？有什么证据？

**结论：主要瓶颈在写入侧（尤其是"更新/冲突消解"子环节），但读取侧的独立损失也不可忽略。三者的量级顺序是：写入与更新 ≳ 读取格式 ≳ 检索算法。**

支持"写入/更新是主瓶颈"的证据：

1. **两条最直接的观察都是写入失败，不是检索失败**：LongMemEval 人工评测里，ChatGPT 的问题是**覆盖**关键信息（写坏），Coze 的问题是**根本没记下**间接信息（没写）。两者都不是"记下了但没搜到"。（A）
2. **写入侧的改进有可观的边际收益**：LongMemEval 的键扩展（写入/索引侧改动）带来 QA **+5.4%**；time-aware 索引（写入侧的时间戳关联）在时序题上带来召回 **+6.8%~11.3%**。（A）
3. **成熟的商业实现普遍缺失写入治理**：Windsurf 文档无冲突消解与遗忘；OpenAI 的 saved memory 与原对话存在孤儿关系；Cursor 用户报告无法清除旧记忆。相对地，**只有 Zep（双时间轴 + 边失效）与 Mem0（LLM 选 ADD/UPDATE/DELETE/NOOP）明确把写入治理当作一等公民**——而这两家恰好也是公开数字最好的两家。（B/C/D）
4. **LangChain 官方文档的诚实陈述**：从 profile 改成 collection 提高召回后，**"复杂度就转移到了删改上"**，且**"有些模型倾向过度插入，有些倾向过度更新"**——即写入策略的失控是当前实现层面的已知痛点。（C）
5. **MemoryAgentBench 把 Selective Forgetting / conflict resolution 单列为四项核心能力之一并专设 FactConsolidation-SH/MH 数据集**——如果写入侧不是瓶颈，不需要为它单独造基准。（A）

支持"读取侧也是独立瓶颈"的证据：

6. **LongMemEval 原话**："即使记忆召回完美，准确利用检索到的条目也绝非易事"，仅靠换阅读策略（Chain-of-Note + 结构化格式）就有 **+10 绝对点**。（A）
7. Anthropic 官方也承认 agentic retrieval 的代价是延迟与"追死路"。（C）

**不支持"检索算法是首要瓶颈"的证据**：HippoRAG 1/2、GraphRAG、Zep 都把工程复杂度压在检索/索引结构上，但 (i) HippoRAG 2 自认图方法在简单事实记忆上曾**低于**标准 RAG；(ii) Mem0ᵍ 加图后单跳/多跳**下降**；(iii) UnWeaver 的端到端评测里 VectorRAG **优于**标准 GraphRAG。也就是说：**在检索侧继续加复杂度，收益已经进入平台期甚至负值区**。

---

### Q3. 「记忆巩固（consolidation）」有哪些**被验证有效**的具体做法？

按证据强度从高到低：

| 做法 | 具体机制 | 证据 | 强度 |
|---|---|---|---|
| **① 结构化后台重写（sleep-time）** | 把"改记忆"的工具从主对话 agent 上摘掉，交给独立的 sleep-time agent 在空闲时重写主 agent 的常驻上下文 | Sleep-time Compute 论文：同准确率下**测试期算力 −5×**；加大 sleep-time 算力可再 **+13%（GSM-Symbolic）/ +18%（AIME）**；多查询场景**每查询均摊成本 −2.5×**。**边界条件：效果与"用户 query 的可预测性"强相关。** | A/B（有数字，含边界） |
| **② 保留活跃集的压缩（compaction）+ 只清工具结果** | 会话逼近窗口上限时摘要化并开新窗口，保留架构决策/未解 bug/实现细节，丢弃冗余工具输出；并保留最近访问的 5 个文件 | Anthropic 工程博客（C，无对照数字）；但 Claude Code 是长期在生产中跑的实现。**同时被官方警告：过度激进的压缩会丢关键上下文。** | C |
| **③ 事实粒度的键扩展（fact-augmented key expansion）** | 写入一条记忆时，额外抽取出"事实"作为索引键，让同一段原文有多个入口 | LongMemEval：recall@k **+9.4%**、QA **+5.4%** | A |
| **④ 时间感知的索引与查询扩展** | 把时间戳显式绑定到事实上，并在查询时先用 LLM 推断时间范围以收窄搜索空间 | LongMemEval：时序召回 **+6.8%~11.3%**（需强 LLM 做 query expansion） | A |
| **⑤ 分层事件摘要 + 全局画像** | 原始对话 → 日事件摘要 → 全局摘要；人格画像同理逐级聚合 | MemoryBank 采用此结构，但其定量结果（检索 0.763 / 正确性 0.716）**未把"分层"与"遗忘"分开消融**，无法归因 | B（结构合理，归因不足） |
| **⑥ 反思（reflection）合成为高层推断** | 把零散观察合成更高层结论，再写回记忆流影响后续行为 | Generative Agents 消融：reflection 组件**对行为可信度有因果贡献**（论文 §6.5.3 "Reflection Is Required for Synthesis"） | A |
| **⑦ 在线重写邻居记忆（memory evolution）** | 新记忆插入时，让 LLM 改写 top-k 邻居的上下文描述/关键词/标签 | A-MEM 自评在 LoCoMo 上平均排名 1.2、token 长度仅为 MemGPT 的 1/6.7；**但 Mem0 复跑得分显著更低**，独立复现存疑 | B（自评）/ 存疑 |
| **⑧ 输出侧的阅读策略**（常被忽略的"半个巩固"） | Chain-of-Note + 结构化数据格式；把检索结果以表格/字段化形式给模型 | LongMemEval：**+10 绝对点**，跨三个 LLM 一致 | A |

**未被验证的做法**：Ebbinghaus 式时间衰减遗忘（见 Q5）、社区摘要级抽象（GraphRAG/Zep 的 community 层）——后者在 Zep 论文里被作者自己承认为"动态扩展后逐渐偏离完整标签传播结果，因此仍需定期全量刷新"。

---

### Q4. 图结构相比纯向量的**实证增益**有多少？值得这个复杂度吗？

**增益数字（全部为提出方自评，需打折）**：

| 工作 | 增益 | 对照基线 | 任务类型 |
|---|---|---|---|
| HippoRAG 1 | 多跳 QA **最高 +20%**；比 IRCoT **便宜 10–30×、快 6–13×** | 当时的 SOTA 检索方法 / IRCoT | 多跳 |
| HippoRAG 2 | 关联记忆 **+7%** | SOTA 嵌入模型 | 关联（MuSiQue/2Wiki/HotpotQA/LV-Eval） |
| Mem0ᵍ | 总分 **+2%**（仅时序 55.51→58.13、开放域 72.93→75.71） | Mem0 自身（无图） | LOCOMO 全类 |
| Zep | LongMemEval **+15.2%（4o-mini）/ +18.5%（4o）**，延迟 −90%，上下文 115k→1.6k | **全上下文**（不是纯向量 RAG） | LongMemEval_S |

**关键的负向/打折证据**：

1. **Mem0ᵍ 的图在单跳与多跳上都是负增益**（67.13→65.71；51.15→47.19）。作者原话："多跳问题上，Mem0ᵍ 预期的关系优势并未转化为更好的结果"、"在图结构上进行多步推理可能存在开销或冗余"。
2. **HippoRAG 2 自己承认**：图增强方法"在更基础的事实记忆任务上，性能明显低于标准 RAG"——即图方法的**基础代价**是需要专门修复的。
3. **UnWeaver（独立于上述所有提出方）**：端到端 QA 上 **VectorRAG 优于标准 GraphRAG**，且接近 SOTA 图方案，"成本只是零头"。同时论文点出图方案的两个固有代价：**"构建图索引的组合复杂度高出几个数量级"**、**"依赖启发式来做检索"**。
4. **Zep 的 +18.5% 不是"图 vs 向量"的对照**，而是"图记忆 vs 把 115k token 全塞进上下文"。后者本来就被 Chroma 证明是劣质基线——**用"全上下文"当基线会系统性夸大图记忆的增益**。
5. **Zep 论文自己承认社区层会漂移**，需要周期性全量重算——即图结构的维护成本不是一次性的。

**判断：不值得作为默认架构，值得作为"按需叠加层"。** 理由：
- 增益集中在**多跳/关联/时序**三类查询，在单跳事实类查询上图结构**实测为负或零**（Mem0ᵍ、HippoRAG 2 两条独立证据）。
- 成本不是"多写点代码"，而是**索引期的 LLM 抽取开销 + 图库运维 + 社区刷新 + 抽取噪声治理**（HippoRAG 2 需要"filtered triples"来压噪声）。
- 工程上的可行折中已经被验证：**先用纯向量 + 时间过滤 + 事实键扩展做强基线，把"图"降级为只服务特定查询类型的可插拔重排/遍历步骤**。Zep 自己的检索实现其实就是这条路——**它的检索是三路混合（cosine + BM25 + BFS）再加多级重排**，而不是"纯图遍历"。这说明即便在图阵营内部，**图也只是混合检索的一路，而非全部**。

---

### Q5. 遗忘机制有实证支持吗？还是只是理论优雅？

**结论：截至目前，遗忘机制基本停留在"理论优雅"阶段——没有找到任何一份报告了"遗忘/淘汰带来实测增益"的可靠来源。**

逐条核查：

| 声称 | 核查结果 |
|---|---|
| MemoryBank 用 Ebbinghaus 曲线（R=e^(−t/S)，被召回则 S+1、t 归零）实现"更像人"的遗忘 | **论文未提供遗忘模块的消融增益。** 作者把"在有/无遗忘机制下都可用"列为**泛化性**（即两种配置都能跑），而非性能提升；并自述"这是一个探索性的、高度简化的记忆更新模型"。→ **未找到支持增益的证据** |
| 遗忘能提升长时记忆表现 | MemoryAgentBench 把 **Selective Forgetting** 列为**尚未被掌握**的四项核心能力之一，并新建 FactConsolidation-SH/MH 专门测它。**"仍在被当作开放问题评估" ≠ "已被验证有效"** |
| 商业系统有遗忘 | OpenAI：**无自动遗忘**，且"Don't mention this again"不删源、删除来源不删派生记忆（孤儿记忆风险）；Windsurf：文档**完全未提**遗忘；Cursor：用户报告**无法清除**记忆；Letta/Anthropic：**无自动遗忘**，交给用户或客户端 |
| 遗忘的替代品有实证吗？ | **有，而且是"软遗忘"**：Zep 与 Mem0ᵍ 都采用**把矛盾关系标记失效（`t_invalid`）而非物理删除**，以保留历史支持时序推理。Zep 因此拿下 temporal-reasoning **45.1%→62.4%（gpt-4o）**；Mem0ᵍ 在时序上 **55.51→58.13**。这是**唯一有正向数字支撑的"遗忘类"机制** |
| 检索侧有没有"隐式遗忘"？ | 有——**top-k 截断本身就是一种遗忘**，而且它是有实证代价的（Chroma：干扰项挤占 top-k；MemoryAgentBench：top-k 捞不出聚合所需信息）。即当前系统的"遗忘"是被动的、失控的，而非主动设计的 |

**给自研系统的直接含义**：先把**冲突消解 + 过期失效（软删除/时间区间）** 做对——它同时解决 F2（覆盖关键信息）和 Q1①（时序不可检索）两个最高频失败；**不要**先上基于时间衰减的概率淘汰，因为那会在没有任何增益证据的情况下，主动引入"丢掉稍后才显现其重要性的上下文"的风险（正是 Anthropic 对 compaction 的警告）。

---

## 5. 对自研记忆系统的建议（300 字以内）

> 先修写入侧，再谈图。
> ① 写入粒度用**回合**而非会话，索引键附加抽取出的事实：recall@k **+9.4%**、QA **+5.4%**。
> ② 强制带**时间戳**：OpenAI memory 时序题 J 仅 **21.71**；Zep 补时序后 45.1%→62.4%。
> ③ 写入走「抽取→比对 top-s 相似记忆→LLM 选 ADD/UPDATE/DELETE/NOOP」，矛盾关系**标失效而非物理删**。
> ④ 巩固放**后台空闲期**重写，热路径只清工具结果；激进压缩会丢关键上下文。
> ⑤ 检索先用**纯向量+时间过滤**做强基线，仅当多跳/关联查询有增益才上图——VectorRAG 常已够用，Mem0ᵍ 的图在单跳/多跳反而无增益。
> ⑥ 遗忘别凭理论优雅上衰减：MemoryBank 自认模型简化、无增益 ablation。
> ⑦ 上线前做**回归集**（Zep 单 session-assistant −17.7%）。

---

## 6. 未找到可靠来源 / 未能核验的项目（诚实清单）

| 条目 | 状态 |
|---|---|
| **OpenAI 的 `memory_store`** | **未找到官方来源。** OpenAI 官方文档体系中不存在名为 `memory_store` 的产品概念：ChatGPT 侧是 "saved memories / memory summary / reference chat history"；Agents SDK 侧是 **Session**（含 `MemorySession` 类）与 Sandbox agents 的 "Agent memory" 页。LangChain 文档称 ChatGPT 内部使用一个名为 **`save_memories`** 的工具做 upsert——这是第三方描述，**非 OpenAI 官方**。请勿在自研系统中沿用 "memory_store" 作为 OpenAI 官方术语引用。 |
| **Anthropic memory tool 官方文档页正文** | URL `https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool` 被搜索引擎索引，但本次多次抓取均被 302 重定向到 `www.anthropic.com` 而中断，**正文未核验**。第 30 条工程博客已确认它存在且是"file-based system / public beta / Sonnet 4.5 同期发布"，但**目录结构、写入触发、上限等细节未找到可核验的官方来源**。 |
| **Cursor "Memories" 功能官方文档** | `https://docs.cursor.com/context/memories` 现 302 至 `https://cursor.com/docs/rules`。**未找到 Cursor 官方仍把 Memories 作为独立功能维护的文档页**；仅找到社区论坛的故障报告（D 级）。若需引用 Cursor 记忆，请以第 36/37/39 条为准。 |
| **HippoRAG 2 论文中"图方法在基础事实记忆上低于标准 RAG"的具体数字** | 只取到摘要级的定性表述，**未取到该对照的具体百分点**（HTML 正文在结果表之前被截断）。 |
| **Mem0 论文表 2 中 RAG 各 chunk 尺寸的完整 J 分数** | 只取到 k=1 时 chunk 128 → **47.77**、chunk 256 → **50.15**（对比 Mem0 全类 J 为 51.15~72.93），**其余行未取到**。 |
| **MemoryAgentBench 的 Appendix I 成本-性能分析与 Appendix K 覆盖策略消融的具体数字** | 论文目录中存在这两节（与"写入侧瓶颈"高度相关），但 HTML 正文在进入附录前被截断，**具体数字未取到**。 |
| **第三方对 ChatGPT memory / Claude memory 的独立系统性评测（幻觉记忆率等）** | **未找到可靠来源。** 现有最接近的是 Mem0 论文对 OpenAI memory 的复跑（第 24 条），但由竞争厂商执行，不能算中立第三方。 |
| **"遗忘机制带来实测增益"的任何来源** | **未找到可靠来源**（详见 Q5）。 |

---

## 附：本次调研的核验方法与已知局限

1. **所有 `[已验证]` URL 均由本次会话实际 `web_fetch` 成功并返回正文。** arXiv 论文通过 `export.arxiv.org/api/query`（Atom 接口，仅摘要）+ `arxiv.org/abs/*`（元数据）+ `arxiv.org/html/*`（正文，长文会在中段被截断）+ `ar5iv.labs.arxiv.org/html/*`（备选渲染，截断位置不同，可用于交叉取数）四路交叉获取。
2. **已知局限（影响结论强度，请一并转述）**：
   - arXiv HTML 抓取存在长度截断，**部分结果表只取到前半**（见第 6 节）。
   - `platform.claude.com` / `docs.cursor.com` 对本环境存在跨域 302，导致两个官方文档页正文不可得。
   - **本报告中"图 vs 向量""记忆系统 vs 全上下文"的多数数字来自提出方自评**（HippoRAG 2、Zep、Mem0、GraphRAG），只有 UnWeaver、Chroma Context Rot、MemoryAgentBench、MemoryArena、LongMemEval 属独立评测。**跨厂商横向对比（Zep vs Mem0 vs A-Mem 在 LOCOMO 上的名次）由 Mem0 提供，需按"竞争对手复跑"折价理解。**
   - 引用 A-Mem / MemGPT 的 LOCOMO F1 时务必核对列对齐（见 F13 警告）。
