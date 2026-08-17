# BUGS — Slime 心智架构优化遗留问题

> 生成时间：2026-08-13 | 最后更新：2026-08-14
> 背景：对照 Intelligence.md 完整架构文档做全面审查，确认实现与设计的差距。
> 2026-08-14 修复：BUG-014~020 全部闭环，BUGS.md 累计 20 项全部闭环。
> 2026-08-14 二轮修复：BUG-021~030 全部闭环，BUGS.md 累计 30 项全部闭环。
> 2026-08-14 新增：流式路径工具调用 S3 遗留问题。
> 2026-08-14 三轮修复：BUG-031 闭环（流式 tools 注入 + tool_calls 片段累积 + 工具执行二次请求），累计 31 项全部闭环。
> 2026-08-14 四轮修复：BUG-032 闭环（工具多轮循环 + 工具场景流式回复），累计 32 项全部闭环。
> 2026-08-14 五轮：BUG-033 内置网络工具（web_fetch/web_search）落地，累计 33 项。
> 2026-08-14 六轮：BUG-034（Bing 正常页误判验证码 + Agent 能力认知脱节）闭环，累计 34 项。

---

## ✅ 已闭环（2026-08-13）

| ID | 状态 | 修复说明 |
|----|------|---------|
| BUG-001 | ✅ 已修复 | `extract_memories_from_chat` prompt 新增 `behavior_patterns` 字段，返回 LLM 提取的真实步骤 |
| BUG-002 | ✅ 已修复 | prompt 新增 `user_sentiment` 字段，`emotion.update(success, user_sentiment)` |
| BUG-003 | ✅ 已修复 | `_store_categorized_locked` 写入时自动建立双向链接 |
| BUG-004 | ✅ 已修复 | `_periodic_review_loop()` 后台任务，每小时触发 |
| BUG-005 | ✅ 已修复 | `_load()` 中迁移时补填 `last_accessed` |
| BUG-006 | ✅ 已修复 | 图谱联想独立于 LanceDB，种子 fallback 到 ranked 前 3 |
| BUG-007 | ✅ 已修复 | graph_items 追加前检查 content not in known |
| BUG-008 | ✅ 已修复 | 条件统一用 `linked.get("content", "")` 兜底空值 |
| BUG-009 | ✅ 已修复 | 用 `content_to_fact` 字典索引替代 O(N²) 遍历 |
| BUG-010 | ✅ 已修复 | 知识引擎循环内恢复兜底沉淀 |
| BUG-011 | ✅ 已修复 | tags 为空时用 `_text_similarity` > 0.3 兜底建链 |
| BUG-012 | ✅ 已修复 | seeds 按 content 去重后再映射 fact |
| BUG-013 | ✅ 已修复 | review 循环加 `_get_evolve_lock()` + `save_agents` |

---

## BUG-014 [P2] _post_process_chat 未更新记忆 last_accessed（N11-P2-17 根治不完整）

**位置**：[slime_server.py:675-754](../slime_server.py#L675-L754) — `_post_process_chat` 函数

**现象**：`_retrieve_psyche_context` 调用 `memory.summary(context=user_message)` 时，会更新 `selected` 记忆的 `last_accessed`（[memory.py:361-362](../core/memory.py#L361-L362)）。但 `_post_process_chat` 在提取记忆后，并没有显式更新这些被检索到的记忆的 `last_accessed` 时间戳。

更关键的是：**LLM 提取记忆的流程是：`extract_memories_from_chat` → 写入新记忆 → 返回 `user_sentiment`/`behavior_patterns`**，但写入完成后没有回写 `last_accessed`（写入时已设了当前时间，但历史记忆的访问未刷新）。

**影响**：长期未访问的记忆虽然有效权重会衰减，但 `_post_process_chat` 完成后这些记忆的 `last_accessed` 仍然是旧时间，不会"越用越熟"。只有下一次 `summary()` 被调用时才会刷新。这是设计上的正确行为（按需刷新），但有一个边界：如果 `_post_process_chat` 中调用了 `extract_memories_from_chat`，这些被检索到的记忆应该在提取完成后立即更新 `last_accessed`。

**修复方向**：在 `extract_memories_from_chat` 返回后，对提取过程中涉及的记忆显式更新 `last_accessed`。或者，在 `_post_process_chat` 中，提取完成后重新调用一次 `memory.summary(context="")` 来刷新所有记忆的访问记录（代价较高）。更优方案：在 `extract_memories_from_chat` 内部，对写入的新记忆直接设置 `last_accessed = now`（已实现），同时让 `_post_process_chat` 在提取完成后刷新检索到的旧记忆。

**参考**：[memory.py:349](../core/memory.py#L349) — `summary()` 中已有此逻辑，但 `_post_process_chat` 未调用 `summary()`。

---

## BUG-015 [P2] 情感→检索策略影响未实现（Intelligence 11.2 "Emotion → Retrieval"）

**位置**：[core/emotion.py](../core/emotion.py) — `EmotionalState` 类

**现象**：Intelligence.md 11.2 节定义了情绪对检索策略的影响：

| 情绪状态 | 检索策略 |
|---------|---------|
| happy | 更积极，扩大检索范围 |
| concerned | 更谨慎，缩小范围 |
| frustrated | 聚焦核心，跳过冗余 |

但当前代码中，`_retrieve_psyche_context`（[llm.py:90-126](../core/llm.py#L90-L126)）**完全忽略 agent.emotion**，检索参数（top_k、categories）不随情绪状态变化。

**影响**：情绪模块目前只影响输出风格（`to_prompt()`），不影响记忆检索。这违背了 Intelligence.md 中"四个维度互相作用"的设计——情感应该能影响检索策略。

**修复方向**：
```python
def _retrieve_psyche_context(agent, user_message, history):
    ...
    memory = load_memory(...)
    # 根据情绪调整检索策略（Intelligence 11.2）
    mood = agent.emotion.mood
    if mood == "happy":
        top_k = max(5, agent.max_context // 1024)   # 扩大范围
    elif mood == "concerned":
        top_k = max(2, agent.max_context // 2048)   # 缩小范围，更精准
    else:
        top_k = 5
    mem_summary = memory.summary(context=user_message, max_items=top_k)
    ...
```

**参考**：[Intelligence.md 11.2](../docs/Intelligence.md#L663) — 情绪影响检索策略的设计规范。

---

## BUG-016 [P3] 情感→输出风格影响不完整

**位置**：[core/emotion.py:57-65](../core/emotion.py#L57-L65) — `to_prompt()` 方法

**现象**：`to_prompt()` 只输出了一段静态描述文本，注入 system prompt。但这只是"告诉模型我现在情绪如何"，并没有真正影响**输出内容的结构和行为**。

例如：
- `happy` → 只说"回复应热情、详细"，但没有具体指导
- `concerned` → 只说"重要操作先确认再执行"，但没有在工具调用层强制确认

**影响**：情绪对输出的影响停留在"提示词描述"层面，缺乏行为层面的约束。模型可能忽略这段描述，直接按自己的风格输出。

**修复方向**：
1. `to_prompt()` 增加更具体的行为指令（如针对工具调用的确认要求）
2. 在 `_apply_filter` 或工具调用前，根据情绪状态增加确认逻辑（如 `concerned` 时强制二次确认写操作）
3. 可考虑在 `_inject_psyche` 中增加情绪上下文（不仅仅是 `to_prompt()` 的静态文本）

---

## BUG-017 [P3] 长期关系感未实现（Intelligence 11.2 + 12.4）

**位置**：[core/emotion.py](../core/emotion.py) — `EmotionalState` 类

**现象**：
- `relational_depth` 字段存在（[emotion.py:19](../core/emotion.py#L19)），且随成功交互缓慢累积
- 但 `relational_depth` **仅用于内部状态**，未注入到 system prompt 或 message 层
- Intelligence.md 12.4 节定义了 `relationships/user_profile.json` 和 `relationships/history_narrative.json`，当前未实现

**影响**：Agent 无法向用户表达"我们的关系正在加深"，也无法基于关系历史做出差异化回应。`relational_depth` 变成了死数据。

**修复方向**：
1. 在 `_retrieve_psyche_context` 或 `to_prompt()` 中，根据 `relational_depth` 输出关系上下文：
   ```python
   def to_prompt(self) -> str:
       parts = [self._mood_prompt()]
       if self.relational_depth > 0.3:
           parts.append(f"- 与用户关系深度：{self.relational_depth:.2f}（{( '熟悉' if self.relational_depth > 0.7 else '了解中' if self.relational_depth > 0.3 else '初识' )}）")
       return "\n".join(parts)
   ```
2. 实现 `relationships/user_profile.json` 存储用户画像（从 memory 中提取）
3. 实现 `relationships/history_narrative.json` 存储关系历程叙事

---

## BUG-018 [P3] 沉淀引擎（consolidation.py）未实现

**位置**：[core/](../core/) 目录

**现象**：Intelligence.md 12.6 节定义了完整的沉淀机制（L3→L2），包括：
- `should_consolidate()` 触发条件判断
- `consolidate()` 沉淀过程（提取模式 → 强化/新建 → 弱化长期未用 → 记录日志）

当前代码中：
- `behavior.py` 有 `reinforce()` 方法（L3→L2 的单步操作）
- `knowledge.py` 有 `review()` 方法（周期性整理，但主要关注 pattern → trait 晋升）
- **缺失**：专门的 `core/psyche/consolidation.py` 模块，也没有统一的 `should_consolidate` 触发判断

**影响**：L3→L2 的沉淀是零散的（knowledge engine 晋升 + behavior.reinforce），缺乏系统性的"习惯成自然"提炼过程。Intelligence.md 描述的四个阶段循环（激活→决策→反馈→沉淀）中，"沉淀"阶段是断链的。

**修复方向**：
创建 `core/consolidation.py`（或放在 `core/psyche/` 下），实现：
```python
class ConsolidationEngine:
    def should_consolidate(self, agent) -> bool:
        # 检查交互次数阈值
        # 检查高频模式集中度
        # 检查离线整理窗口
        
    async def consolidate(self, agent):
        # 从近期记忆提取重复出现的模式
        # 与现有 behavior patterns 对比
        # 强化或新建
        # 弱化长期未用的
        # 记录演化日志
```

并在 `_periodic_review_loop` 中调用（或在每 N 次交互后触发）。

---

## BUG-019 [P3] extract_reasoning_summary 未实现

**位置**：[core/llm.py](../core/llm.py) 或 [slime_server.py](../slime_server.py)

**现象**：Intelligence.md 14.1 路线图 P1 优先级项："实现 `extract_reasoning_summary`（在 `_post_process_chat` 中调用）"。该函数的目的是：从强模型的推理过程（reasoning trace）中提取可复用的思维模式，存入 behavior patterns。

当前代码中没有任何 `extract_reasoning_summary` 相关实现。`behavior_patterns` 来自 LLM 对对话内容的分析（`extract_memories_from_chat` 的 `behavior_patterns` 字段），而不是从 reasoning trace 中提取。

**影响**：夺舍时继承的"行为模式"来自对话内容分析，而非实际的推理过程。弱模型只能学到"应该做什么步骤"，学不到"为什么要这样决策"。

**修复方向**：
1. 在 `extract_memories_from_chat` 的 prompt 中增加 reasoning_trace 提取
2. 或新增独立的 `extract_reasoning_summary` 函数，从 LLM 的 thinking/reasoning 字段中提取
3. 将提取的思维模式存入 `BehaviorPattern` 的额外字段（如 `decision_rationale`）

---

## BUG-020 [P3] Identity 架构级不可变保护未完全实现

**位置**：[core/agent.py:54](../core/agent.py#L54) — `Agent` 类

**现象**：
- Intelligence.md 12.7 节定义了 `Identity` 类，使用 `__setattr__` 抛异常保护 L1 字段
- 当前代码中，`Agent` 类有 `_PROTECTED_FIELDS = frozenset({"identity_prompt", "name", "role"})` 和对应的 property setter，但**没有 `__setattr__` 钩子**
- `_identity_prompt` 是私有字段（双下划线），但 `name` 和 `role` 是公开属性，可通过 `agent.name = "xxx"` 直接修改

**影响**：演化引擎或其他模块理论上可以修改 `agent.name` 或 `agent.role`，虽然目前没有代码这么做，但缺少架构级保护意味着未来任何误操作都可能导致身份铁律被绕过。

**修复方向**：
```python
def __setattr__(self, key, value):
    if key in self._PROTECTED_FIELDS and hasattr(self, key):
        raise AttributeError(f"身份铁律字段 {key} 不可修改")
    super().__setattr__(key, value)
```

---

## BUG-021 [P3] _CMD_GROUPS 缺"模型"分组

**位置**：[slime_cli.py:1371](../slime_cli.py#L1371)

**现象**：
```python
_CMD_GROUPS = ["系统", "对话", "查看", "配置", "高级"]  # 缺"模型"
```
`/servers` 命令管理本地模型，但不在 `_CMD_SPECS` 中，`/help` 无法查到。

**影响**：本地模型管理入口"隐身"，用户不知道有这个命令。

**修复方向**：将 `/servers` 加入 `_CMD_SPECS`，`_CMD_GROUPS` 追加"模型"分组。

---

## BUG-022 [P2] 情绪负反馈循环

**位置**：[core/llm.py:114-115](../core/llm.py#L114-L115)

**现象**：
```python
top_k = {"happy": 15, "concerned": 5, "frustrated": 3}.get(mood, 10)
```
frustrated 时 top_k=3，检索记忆极少 → 回复质量差 → 更容易失败 → valence 更低 → 恶性循环。

**影响**：情绪低落时 Agent 越用越笨，难以自行恢复。

**修复方向**：
- frustrated 时 top_k 不应低于基础值（建议最小 5）
- 或者加一个下限：`max(5, {"happy": 15, "concerned": 5, "frustrated": 3}.get(mood, 10))`
- 同时 happy 的 top_k=15 也可能过度，建议上限 10

---

## BUG-023 [P3] Persona.evolve/strength_trait 重复代码（无调用点）

**位置**：[core/persona.py:142-174](../core/persona.py#L142-L174)

**现象**：`Persona` 类有 `evolve()`/`strength_trait()`/`weaken_trait()`，但实际调用链走的是 `EvolutionEngine`（[evolve.py](../core/evolve.py)）。`persona.py` 版本**无任何调用点**。

**影响**：目前不影响运行，但属于死代码。如果未来有人误用 `persona.evolve()` 会和行为不一致（参数签名不同）。

**修复方向**：删除 `persona.py` 中的 `evolve`/`strength_trait`/`weaken_trait`，统一走 `EvolutionEngine`。

---

## BUG-024 [P2] 沉淀逻辑重复 + 触发不一致

**位置**：[slime_server.py:730-758](../slime_server.py#L730-L758) + [core/consolidation.py](../core/consolidation.py)

**现象**：
1. `_post_process_chat` 内联了知识引擎兜底沉淀（730-739）+ behavior.reinforce（743-750）+ decay（755-758）
2. `ConsolidationEngine.consolidate()` 做了几乎相同的事（知识引擎兜底 + decay）
3. `should_consolidate` 定义每 50 次触发，但 `_periodic_review_loop` 每小时触发，从未调用 `should_consolidate`

**影响**：沉淀逻辑分散在两个地方，`should_consolidate` 是死代码，实际触发条件不统一。

**修复方向**：
- 删除 `_post_process_chat` 中的内联沉淀逻辑（730-758），统一改调 `ConsolidationEngine`
- `should_consolidate` 改为检查交互次数阈值，在 `_post_process_chat` 中判断是否触发
- 或者反过来：`_post_process_chat` 只做 LLM 提取的 reinforce，定期整理交给 `ConsolidationEngine`

---

## BUG-025 [P3] LanceDB 维度硬编码 1024

**位置**：[core/memory.py:110](../core/memory.py#L110)

**现象**：`_EMBED_DIM = 1024` 写死。当前 BGE-M3 输出 1024 维没问题，但换模型时 `_init_lancedb` 检测到维度不匹配会 `drop_table` 重建，向量数据丢失。

**影响**：换 embedding 模型 = 语义检索能力归零（JSON 数据还在，但 LanceDB 索引需重建）。

**修复方向**：将 `_EMBED_DIM` 改为从配置读取（`slime.toml`），或从首次创建表时自动推断并持久化到配置。

---

## BUG-026 [P1] memory.decay() 物理删除记忆，违背"记忆永不消失"原则

**位置**：[core/memory.py:439-460](../core/memory.py#L439-L460)

**现象**：
```python
def decay(self, threshold_days: int = 30):
    """...importance < 3 且超过 threshold_days 天未更新的记忆会被移除。"""
    ...
    if imp < 3 and age > threshold_days:
        removed += 1
        continue  # ← 永久删除
    kept.append(item)
```
Intelligence.md 第 6.4 节明确说：**不推荐 C（过期清理）**——因为"删除"和"遗忘"是两回事。人脑不会真正删除记忆，只是让它沉睡。

虽然当前代码中 `memory.decay()` **没有被任何调用点触发**（只有测试调），但这个删除逻辑本身与核心设计原则冲突。

**影响**：如果未来某处调用 `memory.decay()`，记忆会被物理删除，违背"记忆永不消失，只沉睡可唤醒"的设计哲学。

**修复方向**：
1. **删除 `memory.decay()` 方法**——艾宾浩斯遗忘已通过 `_effective_weight` 排序实现（沉睡记忆排在后面不被注入），不需要物理删除
2. 或者将 `decay()` 改造为纯权重衰减（不改 `_data["facts"]`，只降低 `importance`），与 Intelligence.md 方式 A 一致
3. 保留方法签名但添加注释说明此方法不应在生产环境调用

---

## BUG-027 [P3] history.jsonl 无限增长无轮转

**位置**：[core/history.py:18-29](../core/history.py#L18-L29)

**现象**：`append()` 只追加不限制大小，`load()` 有 `limit=200` 但仅读取时截断，文件本身持续增长。

**影响**：长期运行的服务器磁盘持续增长；大文件后 `load()` 全量读取再切片，I/O 效率下降。

**修复方向**：在 `append()` 中增加轮转逻辑（如超过 N 条或 M MB 时压缩旧记录为摘要）。

---

## BUG-028 [P3] 编码/版本控制/过时文档问题

**位置**：多处

**现象**：
- `slime.ps1` 为 GBK 编码，UTF-8 环境下注释乱码
- 无 `.gitignore`，`data/`、`Knowledge/`、虚拟环境等可能被意外提交
- `CLAUDE.md` 阶段状态与实际进度不符（GUI 未开始但文档标记完成）

**影响**：运维和协作风险，不影响运行时功能。

---

## BUG-029 [P3] wizard 本地模型提示过时

**位置**：[slime_cli.py:2576](../slime_cli.py#L2576), [2656](../slime_cli.py#L2656)

**现象**：
```python
console.print("  2. 本地 GGUF 模型（阶段二支持）")  # 实际已实现
console.print("[yellow]本地 GGUF 模型将在阶段二支持，当前跳过。[/]")  # 实际已实现
```
本地模型功能早已完整实现，但 wizard 文案仍显示"阶段二支持"。

**影响**：用户困惑，以为本地模型还没准备好。

---

## BUG-030 [P3] server /docs /openapi.json 免认证暴露

**位置**：`slime_server.py` FastAPI 路由

**现象**：`/docs` 和 `/openapi.json` 没有认证保护，任何能访问端口的请求都能查看 API 结构。

**影响**：内网环境可接受，但部署到公网时会泄露 API 结构信息。

---

## BUG-031 [P0] 流式路径工具调用完全失效（S3 遗留）

**位置**：[core/llm.py:726-871](../core/llm.py#L726-L871) — `call_api_provider_stream` 函数

**现象**：对比非流式版本 `call_api_provider`（[llm.py:356-361](../core/llm.py#L356-L361)），流式版本存在两处缺失：

1. **payload 未注入 tools**：非流式有 `payload["tools"] = tools_schema`，流式没有
2. **流式 delta 忽略 tool_calls**：非流式在完整响应后检查 `message.get("tool_calls")` 并调 `_handle_tool_calls`；流式只处理 `delta.content` 和 `delta.reasoning`，`delta.tool_calls` 被完全忽略

```python
# 非流式（正常）：
payload["tools"] = tools_schema          # ✅ 有
...
tool_calls = message.get("tool_calls")   # ✅ 有
if tool_calls:
    return await _handle_tool_calls(...)  # ✅ 有

# 流式（缺陷）：
# payload 无 tools 字段
...
content = delta.get("content", "")       # ✅ 有
reasoning = delta.get("reasoning", "")   # ✅ 有
# delta.tool_calls 被忽略 ❌
# 最终 yield done 但 full_reply 可能是空字符串
```

**影响**：**CLI 主对话中 Agent 完全无法调用任何工具**。所有工具调用都必须走非流式路径才能工作。这意味着：
- `/chat`（非流式）API → 工具调用正常
- `/chat/stream`（流式 SSE）API → 工具调用静默失败，模型可能返回 tool_calls 但被丢弃
- CLI 交互如果走流式 → 工具调用不可用

**修复方向**：
1. 在 `call_api_provider_stream` 中添加 tools 注入（与非流式一致）
2. 在流式 chunk 循环中处理 `delta.tool_calls`，累积 tool_calls 片段
3. 流式结束后，如果检测到 tool_calls，调用 `_handle_tool_calls` 执行工具并二次请求
4. `_handle_tool_calls` 需要支持流式场景（二次请求可以是流式也可以是非流式）

---

## BUG-032 [P1] 工具调用仅单轮 + 工具场景最终回复非流式（网络工具规划阻断）

**位置**：[core/llm.py](../core/llm.py) — `_handle_tool_calls` / `call_api_provider_stream`

**现象**（两个遗留观察）：

1. **单轮工具**：非流式 `call_api_provider`（:396-399）与 `_handle_tool_calls` 二次请求（:478-492）都没有 while 循环——工具执行完直接当最终回复，不检查模型是否又要工具。
   - `web_search → web_fetch` 依赖链（必须等搜索结果才决定抓哪个 URL）在单轮里做不了，模型只能一次发一批**互相独立**的工具调用。
   - 边缘 bug：二次请求若模型再返回 `tool_calls`，`content` 为 None → `_apply_filter("")` → 空回复。

2. **工具场景最终回复非流式**：流式路径二次请求 `stream=False`（:878）→ 用户看到"流完 → 静默 → 整段回复一次性弹出"，混合模式割裂。

**影响**：网络工具（web_search/web_fetch 等）无法做链式操作；CLI 工具场景体验割裂。

**修复**：
- `_TOOL_MAX_ROUNDS = 3`（与 `core.executor.MAX_ROUNDS` 对齐）
- `_execute_pending_tools()`：工具执行 + 沙箱权限检查 + 回填，流式/非流式共用
- `_handle_tool_calls()`：多轮 while 循环，模型继续要工具则再轮；`content=None` 兜底 `"[工具调用后无文本回复]"`
- `_handle_tool_calls_stream()`：流式多轮循环，每轮 SSE 逐块 yield，chunk 实时转发（修复观察 2）
- `call_api_provider_stream` 改调流式循环

---

## BUG-033 [P1] 内置网络工具（web_fetch / web_search）落地

**位置**：[core/fetcher.py](../core/fetcher.py) + [core/extractor.py](../core/extractor.py) + [core/search.py](../core/search.py) + [tools/builtin.py](../tools/builtin.py)

**内容**：按 docs/search_engine.md 落地内置"上网"能力（自研，不依赖外部 MCP）：
- SSRF 全校验（getaddrinfo A+AAAA 全解析 + ipaddress 逐段拦截 + 不可解析拒绝）
- IP 钉扎连接（P0，防 DNS Rebinding：URL 改写 + Host 头 + HTTPS sni_hostname）
- 手动重定向链（≤5 跳逐跳重验）+ 2MB 流式累计中断 + gb18030 编码启发式
- 内容提取（语义标签 + JS 渲染检测 + HTML 实体解码 + 4000 截断）
- Bing 主 + 百度兜底 + 预热/随机延迟/验证码退避 + Semaphore(5)
- 沙箱 `auto_approve_tools` 白名单 + `_validate_workspace` url 放行 + llm target_str 加 url 字段
- 45 用例全 mock（含 DNS Rebinding 钉扎断言、workspace 兼容、Host 头断言）

---

## BUG-034 [P1] Bing 正常结果页被误判验证码 + Agent 能力认知脱节

**位置**：[core/search.py](../core/search.py) + [core/agent.py](../core/agent.py)

**现象**（两处）：
1. `_is_captcha` 对整段 HTML 子串匹配，Bing 正常页自带 JS 文件名 `powchallengesolver`（含 "challenge"）→ 误判验证码 → 真实搜索能力被文案阻断。
2. `_build_capabilities_prompt` 硬编码「目前支持 file_read / file_list」，未动态反映已注册工具 → Agent 说"尚未配置联网搜索"，与真实注册表（web_search/web_fetch 已注册）矛盾。

**修复**：
1. `_is_captcha` 改**可见文本检测**（`BeautifulSoup.get_text()`），脚本文件名不参与；判定顺序改为**先解析结果 → 无结果才验验证码 → 无特征才返回「未找到」**。
2. `_build_capabilities_prompt` 工具清单**动态取自注册表**（`_list_tool_capabilities`），内置 + MCP 工具实时列出，回答能力以清单为准。
3. 测试 +3（正常页含 powchallengesolver → 返回结果；真验证码页 → 仍返回文案；能力清单动态列出注册工具）。

---

## 状态汇总

| ID | 标题 | 优先级 | 实现成本 | 状态 |
|----|------|--------|---------|------|
| BUG-001~020 | 全部问题（见上文各节） | — | — | ✅ 全部已闭环 |
| BUG-021 | _CMD_GROUPS 缺"模型"分组 | P3 | 极低 | ✅ 已修复 |
| BUG-022 | 情绪负反馈循环（frustrated→top_k骤减→更易失败）| P2 | 低 | ✅ 已修复 |
| BUG-023 | Persona.evolve/strength_trait 重复代码（无调用点）| P3 | 低 | ✅ 已修复 |
| BUG-024 | 沉淀逻辑重复 + should_consolidate 与实际触发不符 | P2 | 中 | ✅ 已修复 |
| BUG-025 | LanceDB 维度硬编码 1024 | P3 | 极低 | ✅ 已修复 |
| BUG-026 | **memory.decay() 物理删除记忆，违背"记忆永不消失"原则** | **P1** | 低 | ✅ 已修复 |
| BUG-027 | history.jsonl 无限增长无轮转 | P3 | 低 | ✅ 已修复 |
| BUG-028 | 编码/版本控制/过时文档问题 | P3 | 极低 | ✅ 已修复（原已 UTF-8/有 .gitignore）|
| BUG-029 | wizard 本地模型提示过时（实际已实现）| P3 | 极低 | ✅ 已修复 |
| BUG-030 | server /docs /openapi.json 免认证暴露 | P3 | 极低 | ✅ 已修复 |
| BUG-031 | **流式路径 tools 未注入且 tool_calls 流式 delta 被忽略** | **P0** | 中 | ✅ 已修复 |
| BUG-032 | **工具调用仅单轮 + 工具场景最终回复非流式** | **P1** | 中 | ✅ 已修复 |
| BUG-033 | **内置网络工具 web_fetch / web_search 落地** | **P1** | 中 | ✅ 已实现 |
| BUG-034 | **Bing 正常页误判验证码 + Agent 能力认知脱节** | **P1** | 低 | ✅ 已修复 |
