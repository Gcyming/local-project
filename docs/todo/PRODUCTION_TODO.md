# 生产打磨问题 — Slime 心智系统

> 与 BUGS.md 的区别：BUGS.md 记录架构设计和实现缺陷，本文档记录**工程成熟度**层面的待打磨项。
> 这些不是"bug"，而是需要真实场景验证和调优的问题。

---

## 1. LLM 提取可靠性

**位置**：[core/memory.py](../core/memory.py) — `extract_memories_from_chat`

**问题**：该函数依赖 LLM 输出格式正确的 JSON，包含 `entries`、`traits_observed`、`user_sentiment`、`behavior_patterns` 四个字段。弱模型（如 Qwen 2.5-3B）可能：
- 输出格式错误（缺少字段、JSON 语法错误）
- 提取内容质量低（`behavior_patterns` 为空、`user_sentiment` 不准）
- 完全无法解析导致整个后处理失败（虽有 try/except 兜底，但静默跳过意味着该轮记忆不更新）

**影响**：换用弱模型时，成长系统的核心数据源（记忆提取、行为模式提炼、情绪信号）质量下降，但不会崩溃。这是"降级使用"而非"功能缺失"。

**打磨方向**：
- 增加提取结果的合理性校验（如 `behavior_patterns` 非空才调用 `reinforce`）
- 弱模型下可关闭部分提取功能（通过配置开关）
- 考虑本地小模型做提取（与 main chat 模型解耦）

---

## 2. 并发边界场景

**位置**：[slime_server.py](../slime_server.py) — `_periodic_review_loop` + `_post_process_chat`

**问题**：
- `_get_evolve_lock()` 保护了单个 agent 的写入，但 `agents` 列表在 review loop 中遍历，`save_agents()` 在锁内执行
- `KnowledgeEngine` 使用全局缓存 `_knowledge_cache`（按 `agent_id+data_dir` 键控），多 agent 同时触发 review 时可能读到 stale 缓存
- `save_agents(agents)` 写 `config/agents.json`，多个 agent 的后处理任务并发时虽有序列化保护，但极端情况下仍可能有窗口期

**影响**：当前用户量级下基本不会触发。高并发场景需要进一步压力测试。

**打磨方向**：
- 生产环境加限流（同一时间最多 N 个后处理任务）
- `KnowledgeEngine` 缓存增加 TTL 或版本号失效机制
- `save_agents` 增加重试逻辑（当前 Windows 下已有 PermissionError 重试）

---

## 3. 大数据量性能

**位置**：[core/memory.py](../core/memory.py) — `_text_similarity`、`_store_categorized_locked`

**问题**：
- `_text_similarity` 是词级 Jaccard，O(N) 复杂度，建链时对每条已有记忆都调用一次
- 当记忆数量 > 1000 时，每次写入新记忆的建链开销明显（N×M 比较）
- `summary()` 中的图谱联想遍历，如果双向链接密度高，可能返回大量关联记忆

**影响**：日常使用（几十到几百条记忆）无感知。长期重度使用后可能变慢。

**打磨方向**：
- 对 `_text_similarity` 增加短路：只与最近 N 条或高 importance 的记忆比较
- 建链频率控制：不是每次写入都建链，可每隔 M 条或超过时间阈值才重建关联
- 图谱遍历限制深度和分支数（当前已限制一层，但每层节点数无上限）

---

## 4. 弱模型切换体验

**位置**：[core/llm.py](../core/llm.py) — `_local_model_reply` + API 调用

**问题**：
- 切换到弱模型（如 Qwen 2.5-3B）时，`extract_memories_from_chat` 的 LLM 分析能力下降，提取的记忆质量变差
- 弱模型可能不支持 tool_calls，导致工具调用功能不可用（代码中已有判断，但用户侧无感知提示）
- `max_context` 较小时（如 4096），history 压缩后有效信息量少，Agent 显得"失忆"

**影响**：用户换模型后感觉"这个模型不如之前聪明"，部分是因为模型能力差异，部分是提取质量下降。

**打磨方向**：
- 检测当前模型能力（通过 capability probe），降级相应的功能（如关闭 tool_calls、简化 memory extraction）
- 在 psyche context 中明确标注"当前使用轻量模型，记忆可能不完整"
- 弱模型下增大 `max_context` 的比例（减少 history 压缩）

---

## 5. 配置与运维

**问题**：
- `_EMBED_DIM` 默认 1024，若换 embedding 模型需手动改代码或配置
- `history.jsonl` 轮转策略（超 10MB 保留最近 5000 条）是硬编码，不同场景可能需要不同阈值
- `CONSOLIDATE_INTERVAL = 50` 和 `DECAY_DAYS = 30` 是固定值，不同 Agent 可能需要不同参数
- `slime.toml` 缺少对这些参数的配置入口

**打磨方向**：
- 将关键参数（`CONSOLIDATE_INTERVAL`、`DECAY_DAYS`、历史轮转阈值）移到 `slime.toml` 配置
- 增加健康检查接口（`/health`）暴露当前状态（记忆数量、LanceDB 状态、模型状态等）

---

## 6. 多 Agent 场景

**位置**：[core/agent.py](../core/agent.py) — `split()` / `fork()`

**问题**：
- `fork()` 时 `emotion` 和 `behavior` 是深拷贝共享状态，但 `memory` 是独立的（每个 Agent 有自己的 `MemoryStore`）
- 分裂的子 Agent 有独立的记忆库，父 Agent 修改记忆不影响子 Agent
- Swarm 模式下多个 Worker 同时写各自的 memory，没有跨 Agent 的记忆同步机制

**影响**：目前符合设计意图（每个 Agent 独立成长）。但如果期望"共享记忆"的场景（如团队知识积累），需要额外设计。

---

## 7. 错误恢复与数据完整性

**问题**：
- `json.replace(tmp_path, ...)` 原子写入在 Windows 下偶发 `PermissionError`（已有重试），但在网络文件系统或特殊权限环境下可能持续失败
- LanceDB 表损坏（如进程崩溃写入中途）时，`_init_lancedb` 会重建表但丢失向量数据（JSON 记忆还在）
- `history.jsonl` 写入失败（磁盘满、权限）时静默跳过，可能导致对话历史不一致

**打磨方向**：
- 增加关键操作的 WAL（Write-Ahead Log）或备份机制
- LanceDB 损坏时尝试修复而非直接重建（如果数据可恢复）
- 关键写入失败时告警而非静默跳过

---

## 8. 可观测性

**问题**：当前日志级别主要是 `warning`/`debug`，缺乏结构化指标：
- 记忆数量趋势（增长/衰减曲线）
- 行为模式数量及 confidence 分布
- 情绪状态变化频率
- 提取成功率（LLM 解析是否成功）
- 沉淀触发次数及结果

**打磨方向**：
- 增加 metrics 导出（可选 Prometheus format）
- 定期生成健康报告（写入 `Knowledge/reports/`）
- 关键事件打点（记忆写入、模式沉淀、情绪突变等）

---

## 优先级汇总

| 编号 | 问题 | 优先级 | 触发条件 | 当前影响 |
|------|------|--------|---------|---------|
| 1 | LLM 提取可靠性 | P1 | 使用弱模型 | 记忆质量下降，不崩溃 |
| 2 | 并发边界场景 | P2 | 高并发/多 Agent | 极端场景数据不一致 |
| 3 | 大数据量性能 | P3 | 记忆 > 1000 条 | 写入变慢 |
| 4 | 弱模型切换体验 | P2 | 切换到 3B 以下模型 | 功能降级，用户体验差 |
| 5 | 配置与运维 | P3 | 长期使用 | 维护成本高 |
| 6 | 多 Agent 记忆隔离 | P3 | 多 Agent 场景 | 设计如此，非 bug |
| 7 | 错误恢复与数据完整性 | P2 | 磁盘满/进程崩溃 | 数据可能丢失 |
| 8 | 可观测性 | P3 | 生产部署 | 排查问题困难 |

> **说明**：P1/P2 问题在真实使用中会逐渐暴露，建议在正式使用前优先打磨。P3 问题不影响核心功能，可后续迭代。
