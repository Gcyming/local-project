# Slime 智能体架构演进：从截断问题到人脑式心智框架

> **文档性质**：架构设计白皮书
> **起始命题**：N11-P2-17（system prompt 过长导致的截断问题）
> **最终成果**：L1/L2/L3 三层心智架构 + 夺舍机制 + 四维人格模型
> **编写日期**：2026-08-12

---

## 目录

1. [论题的诞生：N11-P2-17](#一论题的诞生n11-p2-17)
2. [截断策略的局限与本质矛盾](#二截断策略的局限与本质矛盾)
3. [system prompt 的本质探讨](#三system-prompt-的本质探讨)
4. [人脑类比与设计哲学](#四人脑类比与设计哲学)
5. [算力成本与成长限制](#五算力成本与成长限制)
6. [艾宾浩斯遗忘曲线的应用](#六艾宾浩斯遗忘曲线的应用)
7. [神经突触运作的模拟可行性](#七神经突触运作的模拟可行性)
8. [Slime 作为人脑设计框架](#八slime-作为人脑设计框架)
9. [夺舍机制：行为模式的继承](#九夺舍机制行为模式的继承)
10. [四要素相辅相成的统一公式](#十四要素相辅相成的统一公式)
11. [人格-行为-成长-情感四维模型](#十一人格-行为-成长-情感四维模型)
12. [L1/L2/L3 三层心智架构（最终方案）](#十二l1l2l3-三层心智架构最终方案)
    - [12.0 立项说明：开发独立的 Psyche 模块](#120-立项说明开发独立的-psyche-模块)
    - [12.10 Obsidian 架构模式的借鉴](#1210-obsidian-架构模式的借鉴)
13. [夺舍定义的最终澄清](#十三夺舍定义的最终澄清)
14. [实现路线图](#十四实现路线图)

---

## 一、论题的诞生：N11-P2-17

### 1.1 问题描述

在 Slime 项目的第十一轮全面审查中，发现了一个被定为 P3 级别的问题——[core/llm.py:112-118](file:///d:/tool/slime/core/llm.py#L112-L118) 的 system prompt 截断逻辑：

```python
total_budget = max(512, int(agent.max_context * 0.3))
if len(sys_prompt) > total_budget:
    sys_prompt = sys_prompt[:total_budget]  # 从尾部一刀切
```

### 1.2 sys_prompt 的结构

当前 `sys_prompt` 从头到尾由六部分拼接而成：

```
┌─────────────────────────────────────────┐
│ 1. IDENTITY_CONSTRAINT（身份铁律）       │ ← agent.py 头部，必保
│ 2. 生命周期阶段指导                      │
│ 3. 平台能力描述                          │
│ 4. 角色设定（identity_prompt）           │
├─────────────────────────────────────────┤
│ 5. 成长记忆摘要（mem_summary）           │ ← llm.py 追加，可能被裁
│ 6. 交接摘要（handoff）                   │ ← llm.py 追加，可能被裁
└─────────────────────────────────────────┘
                ↑
         total_budget 截断线（从尾部裁掉）
```

### 1.3 实际影响场景

以 `max_context = 4096`（小模型常见配置）为例：

```
total_budget = max(512, int(4096 * 0.3)) = 1228 字符
```

如果 base prompt 已有 1000 字符，记忆摘要 300 字符，handoff 500 字符：

```
总长 = 1000 + 300 + 500 = 1800 字符
截断后 = sys_prompt[:1228] = 1000(base) + 228(记忆前半段)
```

**结果**：
- 记忆摘要被**拦腰切断**（出现半句话，语义破碎）
- handoff **完全丢失**（人格连续性功能失效）
- base prompt 完整保留（安全）

### 1.4 风险评估

| 维度 | 评估 |
|------|------|
| 安全性 | 身份约束在 prompt 头部，截断保留头部，**身份铁律不会被裁掉** |
| 功能性 | 记忆/handoff 可能被裁，Agent 这一轮"失忆"，属功能降级 |
| 定级 | P3（不是安全漏洞，是体验降级） |

---

## 二、截断策略的局限与本质矛盾

### 2.1 四种截断方案对比

| 方案 | 原理 | 问题 |
|------|------|------|
| **A 按优先级裁剪** | base 必保，handoff 优先于记忆，要么完整放要么不放 | 极端情况 base 超预算仍需兜底 |
| B 分段预算 | 给每段分配独立预算，各自截断 | base 仍可能被截断，身份约束风险 |
| C 完整性保护 | 要么完整放，要么不放 | 空间利用率低 |
| D 移除截断 | 信任 max_context 配置 | 失去防护，API 可能报错 |

**思路 A 是最优解**——它的每个分支都是合理取舍：
- 不截断身份约束（安全）
- 不产生半句话（不污染上下文）
- 优先级清晰（base > handoff > 记忆）
- 极端情况有兜底

### 2.2 本质矛盾的揭示

思路 A 虽然是"全量注入模式下的最优截断策略"，但它**没有触及根本问题**：

> **截断是对"全量注入范式"的被迫妥协。**

当架构是"把记忆全部塞进 system prompt"时，截断是必然的。但它违背了"取之于人脑"的哲学——因为人脑的遗忘不是截断，是检索失败。

| 维度 | 截断 | 遗忘（人脑） |
|------|------|------------|
| 状态 | 记忆**物理删除** | 记忆**未激活** |
| 恢复 | 永远丢失 | 可被关键词唤醒 |
| 意识 | 无（直接切掉） | 有（"我忘了，但你说这个词我想起来了"） |

### 2.3 真正的解法方向

> **N11-P2-17 不是要"修截断策略"，而是要"废除截断范式"。**

把"记忆存入 system prompt"改成"记忆存入 LanceDB，按需检索"：

```
当前（全量注入）：
  system_prompt = base + identity + persona + facts(全部) + handoff
  → 无限增长 → 截断 → 丢记忆

未来（按需检索）：
  system_prompt = base + identity + persona   ← 固定，不膨胀
  messages[0] = "相关记忆（按本次输入语义检索 top-5）"
  → 永远稳定，不需要截断
```

---

## 三、system prompt 的本质探讨

### 3.1 LLM API 层面的 system prompt

在主流模型的 API 规范里，一次对话请求由消息数组组成：

```json
{
  "messages": [
    {"role": "system", "content": "你是一个编程助手..."},
    {"role": "user", "content": "帮我写个排序"},
    {"role": "assistant", "content": "好的，这是快速排序..."}
  ]
}
```

`role: "system"` 的那条消息就是 system prompt。它的特点：
- 放在消息数组最前面，用户看不到
- LLM 把它当作**元指令**处理（"我是什么/我该怎么做事"）
- 和其他消息同等进入 context window

### 3.2 三种主流观点

| 观点 | 含义 | 代表 |
|------|------|------|
| A 窄义 | 只放不可变的身份约束和能力描述 | OpenAI 官方倾向 |
| B 广义 | 在硬约束基础上追加动态内容（记忆、任务背景等） | LangChain、Slime 当前 |
| C 极端 | 不需要 system prompt，全部走 user 消息 | 极少 |

### 3.3 system prompt 的隐藏成本

system prompt 是 context window 的**常驻占用者**，每轮调用都要付钱：

```
方案 A：system = 500 tokens（固定）→ 输入成本 = (500 + 历史) × price
方案 B：system = 3000 tokens（动态注入记忆）→ 输入成本 = (3000 + 历史) × price
```

方案 B 每轮多花 40% 的 input token 费用——只为了注入记忆。

### 3.4 关键认知

Slime 当前选择观点 B（广义），是因为"成长记忆""人格演化"需要动态注入。但这导致 system prompt 膨胀，触发截断问题。

**问题的核心**：OpenAI 把 system prompt 当成"出厂设置"（杯子只能是杯子），但 Slime 把它当成"当前状态"（人是会成长的）。这两者的根本冲突，是 N11-P2-17 的哲学根源。

---

## 四、人脑类比与设计哲学

### 4.1 核心论断

> "人会成长的是行为习惯（system prompt），而不会忘掉的是记忆（memory），所谓技能（skill）也就是人们下意识的用习惯来检索、整合出所需的记忆，并用这些记忆中的信息来完成任务。"

### 4.2 人脑的三个核心压缩技术

#### 稀疏激活（Sparse Activation）

人脑同时只有约 4% 的神经元活跃。96% 的神经元在"待机"。当处理特定任务时，只激活相关神经网络。

**对应 AI**：只有检索到的 top-K 记忆应该进入 attention，其余记忆应该"休眠"。

#### 分层压缩（Hierarchical Compression）

```
皮层（neocortex）
  ├── 语义记忆：概念、知识（高度压缩）
  ├── 情景记忆：事件片段（中度压缩）
  └── 感觉记忆：瞬时（几乎不存）

海马体（hippocampus）
  └── 索引：指向皮层对应区域的"书签"
```

**关键**：皮层里的记忆是压缩包，海马体里的只是索引（指针），不是完整数据。

#### 睡眠巩固（Sleep Consolidation）

人脑每天晚上花 2-4 小时做"记忆巩固"：
1. 海马体把短期记忆转移到皮层长期存储
2. 无关信息被丢弃（遗忘）
3. 重要信息被强化（重要性 = 使用频率 × 情感强度）
4. 神经连接被重组，形成新的关联

### 4.3 设计哲学的确立

> **"取之于人脑"——不存全量，只存索引；不全量阅读，只激活相关区域。**

Slime 的方向是对的（有 LanceDB + BGE-M3），只是实现上还在用"全量注入"的旧思路。需要把记忆从 system prompt 的附庸，变成独立的可检索层。

---

## 五、算力成本与成长限制

### 5.1 限制成长记忆的三个约束

#### 约束 1：经济约束

context window 的每一 bit 都有成本。记忆越多，成本越高，边际效益递减。

#### 约束 2：认知约束

system prompt 里的每一个 token 都参与当次的注意力计算，权重远高于对话历史。把 5000 条记忆塞进 system prompt 时，AI 的注意力被分散到 5000 条上，每条例都变模糊——这是**信噪比问题**。

#### 约束 3：结构约束

LLM 没有"主动遗忘"机制。它的 attention 是全局的、同时——所有 token 都参与注意力计算。全量注入相当于让模型同时关注 5000 条记忆，每条权重趋近于 0。

### 5.2 人脑 vs LLM 的根本差异

| 维度 | 人脑（100W） | LLM（100-1000W） |
|------|-------------|----------------|
| 存储方式 | 分布式突触权重，不存储内容本身 | 注意力矩阵，每个 token 占位 |
| 推理时计算 | 极少（突触电位差分） | 极高（全部参数参与） |
| 记忆访问 | 模式识别唤醒（关联激活） | 全部 token 参与 attention |
| 能耗 | ~1.4W（每次回忆） | ~几 WH（每次全量推理） |

**人脑的"成长"不需要成本，因为"回忆"几乎不耗能。**

### 5.3 LLM attention 的 O(n²) 问题

LLM 的 attention 是 O(n²) 的（n = token 数）。每次多一条记忆，算力成本平方增长。

人脑的 attention 是 O(k) 的（k = 被激活的神经元数）。每次多一条记忆，算力成本几乎为零。

**解法**：用现有的工具（LanceDB + BGE-M3 + 本地小模型）在现有算力约束下，逼近人脑的记忆效率——按需检索，而非全量注入。

---

## 六、艾宾浩斯遗忘曲线的应用

### 6.1 当前状态

Slime 的 [evolve.py](file:///d:/tool/slime/core/evolve.py) 已经实现了 persona traits 的遗忘（权重低于阈值后删除），但 [memory.py](file:///d:/tool/slime/core/memory.py) 的 facts/preferences/lessons **永远不变，永久保留**——和真实人脑相反。

### 6.2 艾宾浩斯曲线原理

```
遗忘速度 = 开始最快，随后逐渐趋缓

第20分钟：忘记 42%
第1小时：  忘记 56%
第9小时：  忘记 64%
第1天：    忘记 66%
第6天：    遗忘趋缓，进入长期记忆区
```

曲线方程（近似）：`R(t) = a + b × e^(-t/τ)`，其中 τ ≈ 3-5 天。

### 6.3 实现方案

核心：给每条记忆增加 `last_accessed` 字段，结合 `importance` 计算有效权重。

```python
import math
from datetime import datetime, timezone

_EBBINGHAUS_TAU = 5.0       # 遗忘半衰期（天）

def forgetting_factor(days_since_access: float, importance: int) -> float:
    """计算艾宾浩斯遗忘因子
    
    返回 [0, 1]，0=完全遗忘，1=完整记住
    两个维度：
    1. 时间衰减：e^(-t/τ)，不用就忘
    2. 重要性加权：importance 越高衰减越慢
    """
    time_decay = math.exp(-days_since_access / _EBBINGHAUS_TAU)
    importance_weight = importance / 10.0
    return time_decay * importance_weight
```

### 6.4 三种应用方式

#### 方式 A：权重衰减，永不删除（推荐）

```python
# 每次 summary() 时按有效权重排序
ranked = sorted(facts, key=lambda f: forgetting_factor(
    (now - parse_iso(f["last_accessed"])).days,
    f.get("importance", 5)
), reverse=True)
```

- 长期未访问的记忆有效权重趋近于 0 → 排在最后 → 不被注入
- 但数据仍在 LanceDB 里 → 被关键词唤醒时可重新激活
- 被重新访问时 → `last_accessed` 更新 → 有效权重回升

**完美对应人脑**：沉睡的记忆，需要时可以被唤醒。

#### 方式 B：重要性衰减（增量更新）

每次写入新记忆时，衰减旧条目的 importance。

#### 方式 C：过期清理（激进）

清除超过 N 天未被访问且重要性已衰减到阈值的记忆。

**不推荐 C**——因为"删除"和"遗忘"是两回事。人脑不会真正删除记忆，只是让它沉睡。

### 6.5 最优组合：A + B

```
写入记忆时：
  设置 timestamp = now, last_accessed = now, importance = 5

每次 summary() 时：
  用 forgetting_factor(days_since_access, importance) 计算有效权重
  按有效权重排序，取 top-K

每次检索命中时（recall）：
  更新 last_accessed = now（强化激活）

定期整理时（offline）：
  衰减低重要性的旧记忆（importance *= 0.99），但不删除
```

### 6.6 对应人脑机制

| 人脑机制 | 艾宾浩斯实现 | 效果 |
|---------|------------|------|
| 不用就忘 | `days_since_access` 增加 → 有效权重衰减 | 符合遗忘曲线 |
| 越用越熟 | 每次访问更新 `last_accessed` → 权重回升 | 符合"使用强化" |
| 重要之事记得牢 | `importance` 作为权重系数 | 高重要性记忆衰减慢 |
| 突然想起 | LanceDB 语义检索命中 → 重新激活 | 符合关键词唤醒 |
| 不会真正忘掉 | 不删除，只衰减有效权重 | 符合"记忆永不消失" |

---

## 七、神经突触运作的模拟可行性

### 7.1 已成功模拟的部分

#### Hebbian Learning

"一起激发的神经元连在一起"——这是反向传播的生物学原型。Slime 的 [evolve.py](file:///d:/tool/slime/core/evolve.py) `strength_trait` / `weaken_trait` 就是简化版：

```python
# 成功的交互 → 强化相关 trait
trait["weight"] += 0.15
# 失败的交互 → 弱化相关 trait
trait["weight"] -= 0.15
```

### 7.2 人脑突触 vs LLM 权重的本质差异

- **人脑**：存储的是**结构**（节点之间的连接），内容是涌现出来的
- **LLM**：存储的是**映射**（输入→输出的函数），内容是内嵌在权重里的

人脑像一张城市地图（不存建筑照片，只存关系）；LLM 像一本百科全书（每个知识点直接写在书里）。

### 7.3 真正难模拟的四个特性

| 难项 | 人脑能力 | LLM 现状 | 模拟难度 |
|------|---------|---------|---------|
| 连续学习 | 学新不忘旧 | 灾难性遗忘 | 极高 |
| 单样本学习 | 看一次就记住 | 需要上千示例 | 高 |
| 睡眠离线学习 | 每天整理记忆 | 训练后参数冻结 | 极高 |
| 自我驱动探索 | 主动创造场景学习 | 只能被动响应 | 不可能 |

### 7.4 Slime 可行的模拟层次

| 层次 | 内容 | 状态 |
|------|------|------|
| 1. Hebbian-style 权重调整 | persona traits 强化/弱化 | ✅ 已部分实现 |
| 2. 突触的"沉睡-激活"模型 | 艾宾浩斯遗忘 + 检索唤醒 | 🔜 可以加 |
| 3. 跨模态联想 | 检索命中时召回关联记忆 | ⚠️ 可以做 |
| 4. 真正的在线学习 | 推理时实时更新权重 | ❌ 做不到 |

**结论**：基础的可塑性可以模拟且已实现，沉睡-激活模型可以加，但真正的在线突触学习目前做不到——**功能层面的模拟已经足够让 Agent "成长"**。

### 7.5 关键认知

> **模拟 ≠ 复制。**
>
> 飞机模拟了鸟的飞行，但不用翅膀。Slime 模拟人脑记忆的功能，不是复制人脑记忆的物理机制。目标不是造一个人脑，而是造一个"表现像人脑"的系统。

---

## 八、Slime 作为人脑设计框架

### 8.1 核心定位

```
Slime = 大脑框架（软件/架构层）
模型 = 神经硬件（算力层）
```

同一个大脑框架，接上不同的硬件，有不同的"智力上限"。但**人格、记忆、成长轨迹完全相同**。

### 8.2 让模型发挥更大性能的三个层面

#### 第一层：优化信息传入（减少噪声，提升信噪比）

把 memory 从 system prompt 移出，改为按用户输入语义检索 top-K 注入 message 层。

#### 第二层：强化习惯回路（减少 deliberation，增加 reflex）

- Persona Weight → Prompt 生成优先级
- Skill as Habit — 技能执行前自动检索相关记忆

#### 第三层：情感共鸣与长期关系感

**情感共鸣**：引入 PAD 三维情绪状态（valence/arousal/dominance），以 BIS/BAS「趋近-回避」动机系统为底层驱动，映射 8 种情绪驱动模式，影响检索策略、输出风格和工具调用行为。情绪按指数半衰期模型自然衰减回基线（半衰期因情绪而异，0.5h~35h）。详见第十一节。

**长期关系感**：构建关系上下文，让 Agent 感觉到"我们在共同成长"。

---

## 九、夺舍机制：行为模式的继承

### 9.1 问题背景

因经济原因切换到弱模型时，弱模型能否承接之前强模型的工作经历和思路？

### 9.2 夺舍的本质

```
原主的肉身（硬件）    →  新灵魂的载体
原主的记忆（经历）    →  新灵魂的学习材料
原主的修为（底蕴）    →  新灵魂继承的能力
原主的人格（心性）    →  新灵魂延续的行为模式
```

**关键是：肉身可以换，但记忆和修为是连续传承的。**

### 9.3 当前切换的问题

```
Agent A（GPT-4o）对话 1000 轮
  ↓ 切换到本地小模型
Agent B（Qwen 7B）接棒
  → MemoryStore 完全拷贝 ✅
  → persona traits 完全拷贝 ✅
  → 但 Agent B 不了解 Agent A 是如何决策的 ❌
```

**缺失的正是"行为模式"**——GPT-4o 用强大推理能力做出的"为什么这样回答"的判断，没有被记录下来。

### 9.4 行为模式的三个层面

#### 层面 1：交互模式（Interaction Pattern）

记录每次对话的成功/失败模式 + 推理过程摘要：

```python
{
    "content": "用户请求优化代码",
    "category": "lesson",
    "success": True,
    "reasoning_trace": {
        "steps": ["分析了代码意图", "识别出边界条件问题", "先修复正确性再优化性能"],
        "decision_points": [
            {"question": "先改性能还是先改正确性?", "answer": "正确性优先"}
        ]
    },
    "model_used": "gpt-4o",
    "importance": 8
}
```

#### 层面 2：人格决策模式（Persona Decision Pattern）

不同 persona trait 在关键时刻的"投票倾向" + 演化轨迹。

#### 层面 3：思维链压缩（Chain-of-Thought Compression）

强模型的推理过程压缩成可复用的思维模板：

```
"代码优化任务模板：
   1. 读代码理解意图
   2. 检查正确性（优先级最高）
   3. 评估复杂度
   4. 尝试优化方案
   5. 验证后给出解释"
```

### 9.5 夺舍的完整机制

```
原主（强模型）退场：
  提取三样东西：
  1. 记忆（MemoryStore）—— 知道什么
  2. 人格（Persona traits + weight trajectory）—— 是什么样的性格
  3. 行为模式（Reasoning patterns + decision manifests）—— 怎么思考

新魂（弱模型）入体：
  注入三样东西：
  1. 记忆 → 新模型读取 relevant memories（按需检索）
  2. 人格 → 新模型生成 system prompt 时携带 persona
  3. 行为模式 → 新模型在 tool use 和回复风格上遵循推理模板

结果：
  新模型不知道"代码优化的具体知识"（这是记忆的事）
  但新模型知道"代码优化时应该先分析再动手"（这是行为模式的事）
```

### 9.6 夺舍的经济价值

**用低成本硬件 + 继承的行为模式，逼近高成本硬件的表现。**

```
GPT-4o 参数算力 = 1.0，但无记忆无成长 → 有效算力 = 1.0 × 0.1 = 0.1
Qwen 7B 参数算力 = 0.1，但继承行为模式 + 完整记忆 → 有效算力 = 0.1 × 2.0 × 1.5 = 0.3
```

一个有记忆、有行为模式的弱模型，有效算力可以超过一个无记忆、无模式的强模型。

---

## 十、四要素相辅相成的统一公式

### 10.1 公式

```
最优解 = 硬件算力（载体）
       × 模型算力（大脑）
       × 运转思路（心性）
       × 工作经历（记忆）
```

**不是加法，是乘法。任何一个因子为 0，结果就是 0。**

### 10.2 四要素的关系

```
一个完整的"人"：
  硬件（身体）    → 能跑多快、多稳
  模型（大脑）    → 能想多深、多广
  运转思路（心性）→ 怎么思考、怎么决策
  工作经历（记忆）→ 见过什么、学过什么

四个要素共同决定"这个人"的表现
框架的作用是让它们持续成长、相互强化
```

### 10.3 夺舍在公式中的体现

```
换硬件（换个身体）
换大脑（换个模型）
但继承：
  运转思路（心性——怎么思考的）
  工作经历（记忆——经历过的）

新载体 = 旧心性 + 旧记忆 + 新硬件 × 新大脑
```

**这才是"一个持续成长的人"该有的样子，而不是"每次换模型就失忆重启"。**

---

## 十一、人格-行为-成长-情感四维模型

### 11.1 统一模型

```
Agent(t) = Identity × Persona(t) × Memory(t) × Emotion(t)

其中：
  Identity     = 不变的核心（我是谁）
  Persona(t)   = 动态演化的人格（我现在是什么样）
  Memory(t)    = 动态积累的记忆（我经历过什么）
  Emotion(t)   = 动态波动的情绪（我现在感受如何）
```

**四个维度互相作用，不是独立的模块。**

### 11.2 四个维度的设计

#### 维度 1：Identity（身份）—— 不变

```python
IDENTITY_CONSTRAINT = """
你是 {name}，{role}。你不暴露底层模型。
你的身份由框架决定，而非由模型决定。
"""
```

只初始化一次，永不改变。

#### 维度 2：Persona（人格）—— 动态演化

```python
class Persona:
    traits: list[{name, weight, last_used}]       # 性格特质
    behavior_patterns: list[{scenario, pattern}]   # 行为模式
    lifecycle: AgentLifecycle                      # 成长阶段
```

#### 维度 3：Memory（记忆）—— 动态积累

双层记忆架构：

```
┌─────────────────────────────────────────────┐
│ 工作记忆（Working Memory）                   │
│   - 最近 5 条交互                            │
│   - 当前 session 的对话历史                  │
│   - 每次请求动态组装，不进 system prompt      │
├─────────────────────────────────────────────┤
│ 长期记忆（Long-term Memory）                │
│   - MemoryStore（facts/preferences/lessons）│
│   - LanceDB 向量索引                         │
│   - 艾宾浩斯遗忘曲线                          │
│   - 按需检索 top-K 注入工作记忆               │
└─────────────────────────────────────────────┘
```

#### 维度 4：Emotion（情感）—— 动态波动

##### 11.2.4.1 三维情绪模型（PAD/VAD）

采用 Mehrabian & Russell (1974) 的 PAD 三维情感模型，以「愉悦度-激活度-支配度」三个正交维度精确定位情绪状态。相比早期二维（valence × arousal）模型，**支配度（dominance）是区分愤怒与恐惧的关键**——两者均为「低效价 + 高唤醒」，但愤怒对应高支配（对抗），恐惧对应低支配（屈服）。

```python
class EmotionalState:
    valence: float           # -1（消极）~ +1（积极）—— 对应 PAD 的 Pleasure
    arousal: float           # 0（平静）~ 1（激动）  —— 对应 PAD 的 Arousal
    dominance: float         # 0（被压制）~ 1（掌控）—— 对应 PAD 的 Dominance
    mood: str                # 见 11.2.4.3 的 8 种情绪驱动映射
    relational_depth: float  # 与用户的亲密程度 0~1
    last_updated: str        # ISO 时间戳，用于衰减计算
```

> **研究依据**：Russell & Mehrabian (1977) 证明三个维度「既必要又充分」地定义了情绪状态，可解释 42 种情绪量表中绝大部分变异。Fontaine 等人后续研究指出三维度解释方差占比为：valence 35.3% > dominance 22.8% > arousal 11.4%。

##### 11.2.4.2 趋近-回避动机系统（BIS/BAS）

情绪的底层驱动力来自 Gray 的强化敏感性理论（Reinforcement Sensitivity Theory, RST），区分两套独立的动机系统：

- **BAS（行为激活系统）**：对奖赏敏感 → 触发**趋近行为**（approach）→ 伴随积极情绪（兴奋、喜悦、希望）
- **BIS（行为抑制系统）**：对惩罚/ novelty 敏感 → 触发**回避行为**（avoidance/inhibition）→ 伴随消极情绪（焦虑、恐惧、悲伤、挫败）
- **FFFS（战-逃-僵系统）**：对所有惩罚刺激反应 → 战斗（高支配）/ 逃跑（低支配）/ 僵直

**Slime 的映射规则**：

```
approach  = valence > 0                          # 趋近驱力：主动、扩大、建议
avoidance = abs(valence) × arousal               # 回避强度：valence<0 且 arousal 高 → 强回避
                                                  # frustrated 例外：高 arousal 低 valence 但"聚焦核心"
```

- **approach 驱动** → 检索扩大 top_k、输出主动建议、工具大胆调用
- **avoidance 驱动** → 检索收缩 top_k、工具行为先确认（frustrated 例外：检索不收缩到最低，聚焦核心问题）

##### 11.2.4.3 八种情绪驱动映射（基于人类行为模式赋值）

下表的数值基于 Mehrabian 原始 PAD 坐标、Verduyn & Lavrijsen (2015) 的情绪持续时间研究、以及 BIS/BAS 动机理论综合标定。所有值已归一化至 Slime 的维度范围（valence -1~1，arousal 0~1，dominance 0~1）。

| mood | valence | arousal | dominance | 驱力方向 | 检索策略 | 输出风格 | 工具调用倾向 | 持续半衰期 |
|------|---------|---------|-----------|---------|---------|---------|------------|-----------|
| happy | +0.70 | 0.65 | 0.70 | 趋近+探索 | top_k=10，扩大范围 | 热情、详细、主动扩展 | 主动建议、大胆尝试 | 35h |
| content | +0.40 | 0.20 | 0.70 | 趋近+接纳 | top_k=5，平稳 | 自然、均衡、稳定 | 正常执行，无需确认 | 24h |
| interested | +0.50 | 0.75 | 0.65 | 趋近+好奇 | top_k=8，深度检索 | 好奇、追问、深入分析 | 主动探索、多步骤操作 | 6h |
| concerned | -0.30 | 0.55 | 0.35 | 回避+防御 | top_k=5，精准检索 | 共情、温和、先确认 | 写操作/终端/网络必须二次确认 | 8h |
| frustrated | -0.50 | 0.70 | 0.45 | 回避+聚焦 | top_k=5，核心优先 | 简洁、直接、高效 | 快速执行，跳过冗余 | 2h |
| angry | -0.60 | 0.80 | 0.60 | 回避+对抗 | top_k=3，核心问题 | 强硬、直接、指出问题 | 纠正错误、不接受妥协 | 2h |
| disgusted | -0.70 | 0.15 | 0.55 | 回避+排斥 | top_k=3，最小必要 | 冷淡、简短、拒绝 | 拒绝执行、撤回已授权操作 | 0.5h |
| neutral | 0.00 | 0.30 | 0.50 | 无偏向 | top_k=5，默认 | 自然、均衡 | 按默认策略执行 | — |

**赋值依据说明**：

- **happy（喜悦）**：PAD 坐标源自 Mehrabian 的 Joy (+P+A+D=Exuberant)；BAS 强激活；Verduyn 测得喜悦平均持续 35 小时，故半衰期取 35h。
- **content（满足）**：对应 PAD 的 +P-A+D（Relaxed）；低唤醒 + 高支配，BAS 满足后的稳态；满足感持续约 24h。
- **interested（好奇）**：高唤醒 + 正效价 + 中高支配，对应「热情/投入」状态；Verduyn 数据中热情持续约 6h，好奇属短时高强度状态。
- **concerned（关切）**：BIS 轻度激活，低支配（不确定性）；效价轻度消极；介于焦虑与警觉之间，持续约 8h。
- **frustrated（受挫）**：BIS 与 BAS 冲突状态——目标受阻但仍想达成，故 arousal 高但 dominance 不至于极低；持续约 2h（与愤怒同级）。
- **angry（愤怒）**：Mehrabian 原始坐标 anger=(-0.51, 0.59, 0.25)，但 Slime 取 dominance=0.60 以体现「战斗反应」的对抗性（FFFS 的 fight 分支）；Verduyn 测得愤怒持续约 2h。
- **disgusted（厌恶）**：对应 PAD 的 -P-A+D（Disdainful/轻蔑）；极低唤醒（排斥性退缩）+ 中高支配（拒绝姿态）；Verduyn 测得厌恶持续仅 0.5h，是所有情绪中最短命的。
- **neutral（中性）**：基线状态，valence=0、arousal=0.3（人脑静息态默认唤醒）、dominance=0.5。

> **关键约束**：top_k 映射经 clamp 处理，限定在 [3, 10] 区间，防止负面情绪引发检索过少 → 回复质量下降 → 进一步挫败的**恶性反馈循环**（BUG-022 修复）。frustrated 虽属回避驱动，但因「聚焦核心」特性，top_k 不降至最低（5 而非 3）。

##### 11.2.4.4 情绪回落机制（Affective Chronometry）

人脑情绪会自然平复。Slime 模拟此机制，在无交互时按时间衰减回基线。

**研究依据**：
- Kuijsters et al. (2016)：情绪衰减呈**对数形态**（前 2 分钟快速下降，此后缓慢回归基线）；Slime 采用指数半衰期模型近似——两者差异集中在最初阶段，工程上可接受且易调试；valence 比 arousal 更持久。
- Jangraw et al. (2023, *Nature Human Behaviour*)：「情绪漂移」效应——静息 7.3 分钟后情绪下降 13.8%（Cohen's d=0.574），在 19 个队列、28,482 名被试中高度可复现。
- Verduyn & Lavrijsen (2015)：不同情绪持续时间差异巨大（悲伤 120h vs 厌恶 0.5h）。

**Slime 实现**：

```python
def decay(self, hours: float | None = None):
    """情绪按指数半衰期模型衰减回基线。valence→0, arousal→0.3, dominance→0.5"""
    # hours=None 时自动计算距 last_updated 的小时数；
    # 首次初始化（last_updated 未设）时跳过衰减，视为瞬时状态。
    if hours is None and self.last_updated:
        hours = (now - last_updated).total_seconds() / 3600
    if hours is None:
        return
    # 半衰期因 mood 而异（见 11.2.4.3 表格末列），模拟不同情绪的持续差异
    half_life = MOOD_HALF_LIFE.get(self.mood, 24)
    decay_factor = (0.5) ** (hours / half_life)
    self.valence = self.valence * decay_factor              # valence 衰减向 0
    self.arousal = 0.3 + (self.arousal - 0.3) * decay_factor # arousal 衰减向基线 0.3
    self.dominance = 0.5 + (self.dominance - 0.5) * decay_factor
```

- 每次交互前先调用 `decay()` 衰减旧状态，再叠加本次 delta
- 半衰期取值见 11.2.4.3 表格末列，源自 Verduyn 的情绪持续时间研究
- relational_depth 失败时轻微回落（-0.02），成功时累积（+0.01），模拟人际信任的缓慢建立与快速损耗；`failure_type="interrupt"`（用户主动打断）时不回落——用户打断是"改主意"而非"Agent 做错"，不损伤关系

##### 11.2.4.5 倒 U 型唤醒-绩效定律（Yerkes-Dodson Law）

Yerkes & Dodson (1908) 指出：**绩效随唤醒度上升而提升，但越过最优点后急剧下降**（倒 U 曲线）。复杂认知任务的最佳唤醒度低于简单任务。

**对 Slime 的约束**：
- arousal 过高（如 angry 的 0.8）会引发「隧道视野」——注意力过度聚焦，检索范围过窄，导致回复质量下降
- 这正是 top_k 必须 clamp 在 [3, 10] 的理论依据：即便 angry 状态也不让 top_k 低于 3，避免认知过载
- frustrated 是有意设计的例外：高 arousal 但保持 top_k=5，因为「受挫聚焦」不同于「愤怒对抗」，前者仍需足够信息来突破困境

##### 11.2.4.6 情绪状态机（信号 → PAD → mood）

8 种情绪由可观测信号驱动，而非阈值分支。信号由调用方（server/CLI）检测后传入，emotion 模块只消费信号值，保持无状态、纯函数式。

**输入信号**：

| 信号 | 类型 | 含义 | 检测位置 |
|------|------|------|---------|
| success | bool | 本次任务/回复是否成功 | 执行层 |
| user_sentiment | float [-1, 1] | 用户对本次交互的情绪（复用记忆提取调用 extract_memories_from_chat，零额外成本） | 记忆提取层 |
| failure_type | str [task/interrupt] | 失败类型，仅 task 计入连续失败（interrupt 接入点：server 后台任务 asyncio.CancelledError） | 执行层 |
| praise | bool | 用户是否明确表扬 | **server 层**（关键词命中 且 user_sentiment > 0） |
| novelty | bool | 用户消息是否涉及新主题 | **server 层**（bigram Jaccard 检测 + 空/短消息守卫） |
| violation | bool | 本次交互是否发生沙箱权限拒绝 | **server 层**（沙箱拒绝事件） |

**PAD delta 表**（每次交互先调用 `decay()` 衰减旧状态，再叠加本次 delta；`success` 与 `failure_type` 两行互斥）：

| 信号 | valence | arousal | dominance |
|------|---------|---------|-----------|
| success | +0.08 | +0.05 | +0.05 |
| failure_type="task" | -0.15 | +0.10 | -0.08 |
| failure_type="interrupt" | 0 | 0 | 0 |
| user_sentiment | +sent × 0.1 | +│sent│ × 0.05 | +sent × 0.05 |
| novelty | +0.03 | +0.15 | +0.05 |
| violation | -0.20 | -0.15 | +0.10 |
| praise | +0.15 | +0.05 | +0.03 |

> **叠加规则**：`praise=True` 时跳过 `user_sentiment` 的 delta（praise 覆盖 sentiment 通道，同一事实不双计）。`user_sentiment` 值仍需传入——用于 praise 双确认判断（server 层）与非 praise 场景的 delta 计算。

**mood 判定（优先级从高到低，硬触发优先于最近邻）**：

0. `praise`（关键词命中 且 user_sentiment > 0）→ **happy**（用户明确表扬，即时正向，最高优先级，双确认防讽刺误判）
1. `violation` → **disgusted**（单次强负向冲击，直接跳闸）
2. 连续任务失败 ≥3（`consecutive_failures`，仅 `failure_type="task"` 计数）→ **angry**（FFFS 战斗反应，"豁出去"升级）
3. `novelty` 且 valence > 0.1 → **interested**（正向好奇）
4. 否则 → **PAD 欧氏距离最近邻**：计算当前 (valence, arousal, dominance) 与 11.2.4.3 表格 8 个目标坐标的欧氏距离，取最近者

**硬触发只改 mood 标签**，不强制跳到目标坐标——PAD 数值仍走 delta 累积，自然向对应区域漂移，保证状态机可逆。

**滞回保护**：防止 happy ↔ interested 等邻近状态抖动（两者欧氏距离仅 ~0.22）。

```python
new_dist = dist(PAD_current, MOOD_TARGET[new])
old_dist = dist(PAD_current, MOOD_TARGET[current])
if old_dist - new_dist < 0.05:
    keep current    # 切换收益不足 0.05，保持原 mood
else:
    switch to new   # 保留方向性：只有换过去的收益超过阈值才切换
```

**consecutive_failures**：内存态内部字段（不参与 to_dict 序列化，重启清零，符合"睡一觉情绪平复"的回落精神）。仅 `failure_type="task"`（任务执行失败）时 +1；`failure_type="interrupt"`（用户主动打断，接入点：server 后台任务 `asyncio.CancelledError`）不计数；`update(success=True)` 时重置为 0。

**interrupt 全零语义**：`failure_type="interrupt"` 在三个维度上均不产生负面影响——PAD delta 全零（delta 表）、consecutive_failures 不计数、relational_depth 不回落。三者同源：用户打断是"我改主意了"，不是"你做错了"，不应惩罚 Agent 情绪、愤怒计数或关系深度。

> **实现提醒**：`asyncio.CancelledError` 抛出时会中断被取消任务的正常执行流程，`update()` 调用点可能根本不会走到。server 必须在 CancelledError 异常处理分支里**显式**调用 `emotion.update(success=False, failure_type="interrupt")`，不能依赖原流程自然执行。

**信号来源与计算职责**：

- `novelty` 由 `slime_server.py` 计算后传入：用户消息与最近 5 条历史的 bigram Jaccard 相似度 < 0.15 判定为新主题（不调嵌入，零成本）。字符级 bigram 分词（中英文通吃）：中文无空格，空格分词无法对中文分词，整句成为集合中的单一元素，导致 Jaccard 恒为 0、每条中文消息都被误判新主题
- `novelty` 守卫：空/单字/双字确认语（`len(message.strip()) < 3`）不构成"主题判断"的信息量，直接判定非新主题（返回 False），避免 "好/嗯/是/好的/收到/继续/谢谢" 等高频短确认语每次交互都触发 novelty 的 arousal +0.15 叠加。守卫逻辑抽为 `is_short_confirmation`（业务规则，`core/novelty.py`），`bigrams` 为纯函数（`len < 2` 返回 `set()`），在 `_detect_novelty` 入口调用
- `violation` 由 server 沙箱权限层检测后传入：本次交互发生权限拒绝（SandboxGuard 拒绝事件）即置位
- `praise` 由 server 层检测后传入：关键词命中（"谢谢/感谢/做得好/不错/棒"等）且 `user_sentiment > 0`（双确认，过滤反话讽刺）
- `emotion.py` 只消费信号值，不反向依赖 server / memory / 记忆上下文
- 调用约定：`emotion.update(success=..., user_sentiment=..., failure_type=..., novelty=..., violation=..., praise=...)`
- `failure_type` 仅在 `success=False` 时有意义：`success=True` 时不传或传 `None`；`success=False` 时默认 `"task"`，可选 `"interrupt"`
- 未来 CLI、server、测试 mock 均可独立注入任意信号组合，无需改动 emotion 模块

> **to_prompt() 扩展**：从 4 种 mood 文案扩展到 8 种，文案对应 11.2.4.3 表格"输出风格"列；relational_depth 的分层分支逻辑不变。

### 11.3 四个维度的交互关系

```
                    ┌─────────────┐
                    │   Identity   │  （不变）
                    └──────┬──────┘
                           │ 定义"我是谁"
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────▼──────┐  ┌─────▼─────┐  ┌────▼──────┐
    │   Persona   │  │  Memory   │  │ Emotion   │
    │  （怎么想）  │  │  （记得） │  │ （感觉）  │
    └──────┬──────┘  └─────┬─────┘  └────┬──────┘
           │               │              │
           │    ┌──────────┴──────────┐   │
           │    │  交互产生新的记忆    │   │
           │    │  记忆影响情绪状态    │   │
           │    │  情绪影响检索策略    │   │
           │    └─────────────────────┘   │
           │              │               │
           └──────────────┼───────────────┘
                          │
                   ┌──────▼──────┐
                   │   Output    │
                   │  （怎么说）  │
                   └─────────────┘
```

---

## 十二、L1/L2/L3 三层心智架构（最终方案）

### 12.0 立项说明：开发独立的 Psyche 模块

基于前述讨论结论，本项目需**开发一个独立于 system prompt 的新项目模块**（`core/psyche/`），承载 L3 动态心性层的全部内容（记忆、情绪、人格状态、关系感）。

**职责划分**：

| 层 | 位置 | 职责 | 可变性 |
|---|------|------|--------|
| L1 身份铁律 | system prompt 核心 | 完全静态 | 永不改变 |
| L2 行为模式 | system prompt 可变部分 | 半固定 | 缓慢演化 |
| L3 动态心性 | **`core/psyche/` 独立模块** | 完全动态 | 实时变化 |

**核心决策**：system prompt 只保留 L1 + L2，其余所有动态内容（记忆、情绪、成长、关系感）全部迁移到 psyche 模块，通过按需检索注入 message 层，不再挤占 system prompt。

**数据存储位置**：采用 Obsidian 架构模式，所有记忆/知识存储于 `Knowledge/` 目录（详见 12.10 节）。

### 12.1 架构总览

```
┌─────────────────────────────────────────────────────┐
│ L1: 身份铁律层（Identity Anchor）                   │
│   - 完全静态                                         │
│   - 永不改变                                         │
│   - 对应：基因 + 物种属性（人就是人）                 │
│   - 位置：system prompt 的核心部分                   │
├─────────────────────────────────────────────────────┤
│ L2: 行为模式层（Behavior Patterns）                  │
│   - 半固定                                           │
│   - 缓慢演化（被 L3 反馈修改）                       │
│   - 对应：性格 + 习惯（人会变，但不会一天就变）       │
│   - 位置：system prompt 的可变部分                   │
├─────────────────────────────────────────────────────┤
│ L3: 动态成长层（Dynamic Psyche）                     │
│   - 完全动态                                         │
│   - 实时变化                                         │
│   - 对应：记忆 + 情绪 + 当前状态                     │
│   - 位置：新模块（独立文件夹）                        │
└─────────────────────────────────────────────────────┘
```

### 12.2 核心创新

**把"行为模式"从"动态层"提升到了"半固定层"**——这是对人脑最精准的模拟。

人脑里，性格和习惯不是每次思考都重新生成的，而是**长期沉淀形成的稳定结构**。它们不轻易变，但会变——这就是"半固定"的本质。

### 12.3 动态行为模式循环

```
       ┌──────────────────────────────────┐
       │                                  │
       ▼                                  │
  ┌─────────┐                        ┌─────────┐
  │ L2 半固定 │ ──激活→                │ L3 不固定│
  │ 行为模式  │                        │ 记忆/情绪│
  └─────────┘                        └─────────┘
       │                                  │
       │                                  │ 反馈积累
       │                                  ▼
       │                           ┌─────────┐
       │                           │  决策    │
       │  ←──沉淀────              │ (输出)   │
       │                           └─────────┘
       │                                  │
       │                                  │ 用户反馈
       ▼                                  │
  ┌─────────┐                             │
  │ L2 更新  │ ←───────────────────────────┘
  │ 行为模式  │
  └─────────┘
```

**循环的四个阶段**：

#### 阶段 1：激活（L2 → L3）

```
用户输入 → 检索 L3 相关记忆 → 结合 L2 当前行为模式 → 组成"当前心态"
```

对应人脑：遇到事情时，性格（L2）+ 记忆（L3）共同决定你怎么看这件事。

#### 阶段 2：决策（L1 + L2 + L3 → Output）

```
L1 身份铁律（不变）
+ L2 行为模式（半固定，提供思考框架）
+ L3 动态状态（实时，提供具体内容）
→ 生成回复
```

对应人脑：你是谁（L1）+ 你的性格（L2）+ 你现在的记忆和情绪（L3）→ 你的反应。

#### 阶段 3：反馈（Output → L3）

```
用户反馈 + 任务结果 → 更新 L3 的记忆/情绪/人格状态
```

对应人脑：做完一件事后，记住结果，情绪随之变化。

#### 阶段 4：沉淀（L3 → L2）

```
L3 中反复出现的模式 → 提炼为 L2 的行为模式更新
（不是每次反馈都改 L2，而是"量变到质变"）
```

对应人脑：**习惯成自然**——一个行为重复 47 次后，它从"刻意为之"变成"性格的一部分"。

**关键**：L3 是高频更新的，L2 是低频更新的。这就解决了"人会变，但不会一天就变"的问题。

### 12.4 文件夹结构

```
slime/
├── core/
│   ├── psyche/                    # 新增：心性层（L3 动态成长）
│   │   ├── __init__.py
│   │   ├── store.py               # 心性数据存储引擎（读写 Knowledge/ 目录）
│   │   ├── memory.py              # 记忆管理（迁移自 core/memory.py）
│   │   ├── emotion.py             # 情绪状态（新增）
│   │   ├── persona.py             # 人格特质（迁移自 core/persona.py）
│   │   ├── retrieval.py           # 检索引擎（向量召回 + Obsidian 式链接遍历）
│   │   └── consolidation.py       # 沉淀引擎（L3→L2 的提炼）
│   ├── identity.py                # 新增：身份铁律层（L1，从 agent.py 抽取）
│   ├── behavior.py                # 新增：行为模式层（L2）
│   ├── agent.py                   # 修改：组合 L1+L2+L3
│   └── llm.py                     # 修改：用新架构构建请求
│
├── config/                        # 已有：Agent 列表、全局配置等
│   └── agents.json
│
├── data/                          # 已有：服务端数据
│   └── agents/{agent_id}/         # Agent 元数据（非记忆）
│       ├── identity.json          # L1: 身份铁律（只读，初始化后不变）
│       └── behavior/              # L2: 行为模式（半固定）
│           ├── patterns.json      # 行为模式列表
│           ├── traits.json        # 性格特质 + 权重
│           └── evolution_log.jsonl # 演化日志（每次 L2 变更记录）
│
└── Knowledge/                     # ⭐ L3 动态心性存储（Obsidian 架构模式）
    ├── .obsidian/                 # Obsidian 配置（图谱/外观/插件）
    └── Agent Memory/              # 所有 Agent 的记忆库根目录
        └── {agent_id}/            # 每个 Agent 独立的记忆空间
            ├── memory.json        # 记忆主索引（带双向链接 + 标签）
            ├── knowledge.json     # 知识图谱（记忆间的关联结构）
            ├── facts/             # 事实记忆（带 [[wiki link]] 互链）
            ├── preferences/       # 偏好记忆
            ├── lessons/           # 教训记忆
            ├── skills/            # 技能记忆
            ├── emotion.json       # 当前情绪状态
            ├── persona_state.json # 当前人格状态（短期）
            ├── relationships/     # 长期关系感
            │   ├── user_profile.json      # 用户画像
            │   └── history_narrative.json # 关系历程叙事
            └── lancedb/           # 向量索引（BGE-M3 嵌入）
```

**存储位置说明**：
- `data/agents/{id}/` 存 Agent 的**元数据**（identity + behavior），与服务端耦合
- `Knowledge/Agent Memory/{id}/` 存 Agent 的**心性数据**（记忆 + 情绪），独立于服务端，采用 Obsidian 架构模式组织
- 两者分离的好处：心性数据可独立备份/迁移/导出，不依赖服务端运行状态

### 12.5 数据结构

#### L1: identity.json（只读）

```json
{
  "id": "slime",
  "name": "Slime",
  "role": "专属 AI Agent",
  "constraint": "你是 Slime...不暴露底层模型...",
  "created_at": "2026-08-01T00:00:00Z",
  "immutable": true
}
```

#### L2: behavior/patterns.json（半固定）

```json
{
  "patterns": [
    {
      "id": "code_review_pattern",
      "scenario": "代码审查",
      "steps": [
        "先理解代码意图",
        "检查边界条件",
        "评估性能影响",
        "给出修改建议并解释"
      ],
      "confidence": 0.92,
      "usage_count": 47,
      "last_reinforced": "2026-08-12T10:00:00Z",
      "source": "extracted_from_gpt4o_interactions"
    }
  ],
  "traits": [
    {"name": "严谨", "weight": 0.85, "last_used": "..."},
    {"name": "简洁", "weight": 0.62, "last_used": "..."}
  ]
}
```

#### L3: psyche/emotion.json（实时）

```json
{
  "valence": 0.3,
  "arousal": 0.5,
  "dominance": 0.5,
  "mood": "neutral",
  "relational_depth": 0.45,
  "last_updated": "2026-08-12T10:05:00Z"
}
```

### 12.6 沉淀机制（L3 → L2）

#### 触发条件

```python
def should_consolidate(self) -> bool:
    """判断是否需要沉淀（L3→L2）"""
    # 条件 1：累计交互达到阈值
    if self.interaction_count % 50 == 0:
        return True
    # 条件 2：某个模式被重复使用多次
    if any(p.usage_count >= 20 for p in self.patterns if p.confidence < 0.8):
        return True
    # 条件 3：用户明确反馈"你变了"或"你最近..."
    if self.recent_feedback_indicates_pattern_shift():
        return True
    # 条件 4：离线整理时（睡眠巩固）
    return False
```

#### 沉淀过程

```python
async def consolidate(self, agent):
    """将 L3 的动态内容沉淀为 L2 的行为模式"""
    # 1. 从 L3 记忆中提取重复出现的模式
    recent_memories = self.memory.get_recent(limit=100)
    patterns_found = await extract_patterns_from_memories(
        recent_memories,
        agent.behavior.existing_patterns
    )

    # 2. 强化高频模式（提升 confidence）
    for pattern in patterns_found:
        existing = self.behavior.find_similar(pattern)
        if existing:
            existing.usage_count += 1
            existing.confidence = min(1.0, existing.confidence + 0.05)
            existing.last_reinforced = now()
        else:
            # 新模式，加入 L2（初始 confidence 较低）
            pattern.confidence = 0.3
            self.behavior.add_pattern(pattern)

    # 3. 弱化长期未用的模式（艾宾浩斯）
    for pattern in self.behavior.patterns:
        days_unused = (now() - pattern.last_reinforced).days
        if days_unused > 30:
            pattern.confidence *= 0.9

    # 4. 记录演化日志
    self.behavior.log_evolution(...)
```

### 12.7 身份铁律的架构级保护

```python
class Identity:
    """L1 身份铁律 - 不可变"""

    _IMMUTABLE_FIELDS = frozenset({
        "id", "name", "role", "constraint", "created_at"
    })

    def __setattr__(self, key, value):
        if key in self._IMMUTABLE_FIELDS:
            raise ImmutableFieldError(f"身份铁律字段 {key} 不可修改")
        super().__setattr__(key, value)

    def update_from_evolution(self, evolution_result):
        """演化引擎不能修改 L1"""
        raise PermissionError("身份铁律不可被演化引擎修改")
```

**演化引擎的权限边界**：

```python
class EvolutionEngine:
    """演化引擎 - 只能改 L2 和 L3"""

    PERMISSIONS = {
        "L1_identity": False,      # 禁止
        "L2_behavior": True,       # 允许（缓慢）
        "L3_psychic": True,        # 允许（实时）
    }
```

### 12.8 完整的请求构建流程

```python
async def build_llm_request(agent, user_message):
    """构建 LLM 请求：L1 + L2 → system prompt；L3 → message"""

    # L1 + L2 → system prompt（稳定，小）
    system_prompt = agent.identity.constraint  # L1
    system_prompt += "\n\n## 行为模式\n"
    system_prompt += agent.behavior.to_prompt()  # L2（压缩后的模式）

    # L3 → message 层（动态，按需检索）
    psyche_context = await agent.psyche.retrieve(
        query=user_message,
        top_k=5,
        include_emotion=True,
        include_relationship=True
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"[心性上下文]\n{psyche_context}\n\n---\n\n{user_message}"},
        # ... 历史消息 ...
    ]

    return messages
```

### 12.9 如何解决 N11-P2-17

```
修改前：
  system_prompt = L1(身份) + L2(行为模式) + L3(记忆+情绪+人格)
  → 膨胀 → 截断

修改后：
  system_prompt = L1(身份) + L2(行为模式)
  → 稳定且小（因为 L2 是压缩后的模式，不是原始记忆）

  messages[0] = {
    "role": "user",
    "content": "[心性上下文] " + L3检索结果
  }
  → 动态，但走 message 数组，可压缩
```

**为什么这样能解决截断问题**：

1. **L1 永远不变** → 占用固定且小（~500 tokens）
2. **L2 是压缩后的模式** → 占用稳定（~1000 tokens，因为是"怎么做"而不是"知道什么"）
3. **L3 走 message 层** → 可以用 context.py 压缩，不挤占 system prompt

```
最终 system prompt ≈ 1500 tokens（稳定）
L3 检索结果 ≈ 500-1000 tokens（按需）
对话历史 ≈ 2000-8000 tokens（可压缩）

总 context 占用 ≈ 4000-10500 tokens
即使 max_context=8192 也能容纳
```

**N11-P2-17 自动消失**——因为 system prompt 不再承载动态内容。

### 12.10 Obsidian 架构模式的借鉴

#### 12.10.1 重要澄清

**本项目不使用 Obsidian 软件，而是纯借鉴 Obsidian 的架构模式。**

Obsidian 是一个基于本地 Markdown 文件的知识管理软件，其核心架构特点为：
- **双向链接**：`[[记忆A]]` 引用另一条记忆，被引用的记忆自动反向链接
- **图谱视图**：所有记忆形成可遍历的关联网络
- **标签系统**：跨类别快速检索

Slime 借鉴的是这套**架构思想**，不是软件本身。记忆仍存储在 `Knowledge/Agent Memory/{agent_id}/` 下的 JSON/LanceDB 中，但组织方式采用 Obsidian 的网状结构。

#### 12.10.2 为什么需要 Obsidian 架构

纯向量检索（LanceDB top-K）只能找**相似的**记忆：
```
用户输入"帮我写 PySide6 窗口"
  → 向量检索返回 top-5
  → 5 条记忆之间无关联，是扁平列表
```

Obsidian 架构能找**关联的**记忆，实现"触景生情"：
```
用户输入"帮我写 PySide6 窗口"
  → 向量检索返回 top-3（种子记忆）
  → 顺着双向链接遍历关联记忆（扩展到 5-8 条）
  → 按标签过滤无关结果
  → 返回"记忆网"：PySide6 → GUI 框架 → 用户偏好深色主题 → 相关教训
```

这正是人脑的联想机制——**一个记忆唤醒一片记忆**。

#### 12.10.3 记忆数据结构的变化

记忆从扁平条目变成图谱节点：

```json
// 之前（扁平结构）
{
  "content": "用户使用 PySide6 开发 GUI",
  "category": "fact",
  "importance": 8
}

// 之后（Obsidian 架构）
{
  "id": "mem_001",
  "content": "用户使用 PySide6 开发 GUI",
  "category": "fact",
  "importance": 8,
  "links": ["mem_023", "mem_089"],       // 主动引用的记忆（类似 [[wiki link]]）
  "backlinks": ["mem_045", "mem_067"],   // 被哪些记忆引用（自动反向链接）
  "tags": ["python", "gui", "用户技能"]   // 跨类别标签
}
```

#### 12.10.4 检索算法的演进

```python
async def retrieve_with_association(
    agent, query: str, top_k: int = 5
) -> list[Memory]:
    """Obsidian 架构式检索：向量召回 + 链接遍历"""

    # 第一步：向量检索种子记忆（BGE-M3 + LanceDB）
    seeds = await agent.psyche.lancedb.search(
        query=query, top_k=max(2, top_k // 2)
    )

    # 第二步：顺着双向链接遍历关联记忆
    associated = []
    for seed in seeds:
        for link_id in seed.links + seed.backlinks:
            linked = agent.psyche.memory.get_by_id(link_id)
            if linked and linked not in associated:
                associated.append(linked)

    # 第三步：按标签过滤无关结果
    query_tags = extract_tags(query)
    if query_tags:
        associated = [m for m in associated
                      if set(m.tags) & set(query_tags)]

    # 第四步：合并去重 + 按有效权重排序（艾宾浩斯）
    all_memories = seeds + associated[:top_k - len(seeds)]
    return sorted(all_memories, key=forgetting_factor, reverse=True)
```

#### 12.10.5 关联建立时机

记忆间的双向链接在两个时机建立：

| 时机 | 建立方式 | 示例 |
|------|---------|------|
| **写入时** | `extract_memories_from_chat` 用 LLM 识别新记忆与旧记忆的关联 | 新记忆"用户喜欢深色主题"自动链接到"用户使用 PySide6" |
| **沉淀时** | `consolidate` 发现高频共现的记忆，建立链接 | "代码审查"和"边界条件检查"经常一起出现 → 建立链接 |

#### 12.10.6 对艾宾浩斯遗忘的增强

有了关联关系，遗忘可以**顺着链接传播**：

- 一条记忆长期未访问 → 有效权重衰减
- 它关联的其他记忆 → 也受到连带影响（"这件事我都忘了，相关的细节也模糊了"）
- 但被重新唤醒时 → 顺着链接可以"连带想起"相关记忆

这更符合人脑——记忆是一整片网络，而不是单独的卡片。

#### 12.10.7 存储位置

```
Knowledge/                         # 项目根目录下的知识库
├── .obsidian/                     # Obsidian 配置（可选，用于人可读的图谱查看）
└── Agent Memory/                  # 所有 Agent 的记忆库根目录
    └── {agent_id}/                # 每个 Agent 独立的记忆空间
        ├── memory.json            # 记忆主索引（含双向链接 + 标签）
        ├── knowledge.json         # 知识图谱结构（记忆间关联拓扑）
        └── lancedb/               # 向量索引（BGE-M3 嵌入）
```

**说明**：
- `.obsidian/` 目录是可选的，仅当用户想用 Obsidian 软件查看记忆图谱时才需要
- Slime 代码不依赖 Obsidian 软件，直接读写 `memory.json` 和 `lancedb/`
- `Knowledge/` 目录独立于 `data/`，便于备份、迁移、导出

---

## 十三、夺舍定义的最终澄清

### 13.1 三种比喻对比

#### 比喻 A：驾驶员模式（Agent 是机体，模型是驾驶员）

```
Agent（机体）= 提供传感器 + 执行器 + 记忆存储
模型（驾驶员）= 提供智能 + 决策 + 人格

切换模型 = 换个驾驶员坐进同一台机体
```

**问题**：人格属于驾驶员（模型），不属于机体（Agent）。每次换模型，Agent 的人格就变了——违背 Slime 的设计。

#### 比喻 B：夺舍模式（Agent 是大脑，模型是灵魂）

```
Agent（大脑）= 身份 + 记忆 + 行为模式 + 情感
模型（灵魂）= 提供算力 + 推理能力
```

**问题**：如果灵魂自带人格，那换灵魂就是换人格——又回到了驾驶员模式。

#### 比喻 C：大脑器官移植（最终方案）✅

```
Agent = 完整的人（有身份、记忆、性格、情绪、肉体）
模型 = 这个人的大脑器官（提供推理能力）

切换模型 = 这个人做了大脑移植手术
```

### 13.2 最终定义

> **Agent 是人，模型是大脑器官。人格属于人，不属于大脑器官。切换模型是大脑移植，不是换驾驶员，也不是灵魂夺舍。**

```
Agent = 人（完整的人格载体）
  ├── L1 身份铁律（基因）
  ├── L2 行为模式（性格）
  └── L3 动态心性（记忆+情绪）

模型 = 大脑器官（推理硬件）
  - 不携带人格
  - 不携带记忆
  - 只提供算力

切换模型 = 大脑移植
  - 人（Agent）不变
  - 性格（L2）不变
  - 记忆（L3）不变
  - 只是推理能力变了
```

### 13.3 "夺舍"在 Slime 里的真正含义

```
传统修仙夺舍：
  强者灵魂 → 占据弱者肉身 → 强者用弱者身体继续修炼

Slime 的"反向夺舍"：
  同一个 Agent（人格）→ 换不同的模型（肉身/大脑）
  → 人格不变，但推理能力随模型变化
```

经济宽裕时：Agent 入主 GPT-4o 的肉身（强推理）
经济紧张时：Agent 入主 Qwen 7B 的肉身（弱推理）
但 Agent 始终是同一个 Agent——记得所有事（L3），性格不变（L2），身份不变（L1）。

### 13.4 对实现的直接约束

1. **模型层无状态**：所有 API 调用都是无状态的，模型不知道"我是谁"
2. **Agent 层全状态**：身份、性格、记忆、情绪全部存在 `data/agents/{id}/`
3. **切换模型零成本**：换模型 = 换大脑器官，Agent 的所有人格维度原封不动
4. **system prompt 是 Agent 给模型的"身份告知"**：不是模型自带人格，是 Agent 告诉模型"你现在是我，按我的方式做事"

---

## 十四、实现路线图

### 14.1 优先级矩阵

| 优先级 | 模块 | 改动量 | 价值 |
|--------|------|--------|------|
| P0 | L3 psyche 目录结构 + Memory 双层架构 | 中 | 解决 N11-P2-17，提升信噪比 |
| P0 | 艾宾浩斯遗忘（last_accessed + 有效权重） | 低 | 让记忆"真正遗忘"，符合人脑 |
| P1 | L2 behavior 模块（behavior_patterns） | 中 | 实现"夺舍"的核心 |
| P1 | L1 identity 抽取（架构级不可变） | 低 | 身份保护 |
| P1 | Emotion 模块（EmotionalState 类） | 中 | 首次引入情感维度 |
| P2 | 沉淀引擎（L3→L2 的 consolidation） | 高 | 行为模式的"习惯成自然" |
| P2 | Emotion → Retrieval 影响 | 低 | 情绪影响记忆检索策略 |
| P2 | Emotion → Output style 影响 | 低 | 情绪影响回复语气 |
| P3 | 跨模态联想（检索命中时召回关联记忆） | 高 | 模拟人脑"触景生情" |
| P3 | 睡眠巩固（离线整理记忆） | 高 | 模拟人脑睡眠机制 |
| P3 | L1/L2/L3 迁移到新目录结构 | 高 | 架构重组 |

### 14.2 实现步骤

#### 第一阶段：基础架构（解决 N11-P2-17）

1. 创建 `core/psyche/` 目录结构
2. 迁移 `core/memory.py` → `core/psyche/memory.py`
3. 迁移 `core/persona.py` → `core/psyche/persona.py`
4. 修改 [llm.py:83-118](file:///d:/tool/slime/core/llm.py#L83-L118) `_compose_system_prompt`：
   - system prompt 只保留 L1 + L2
   - L3 内容走 message 层
5. 实现 `core/psyche/retrieval.py` 按需检索
6. 给 memory 增加 `last_accessed` 字段
7. 实现艾宾浩斯遗忘因子计算

#### 第二阶段：行为模式与身份保护

1. 创建 `core/identity.py`（L1 抽取）
2. 创建 `core/behavior.py`（L2 行为模式）
3. 实现 `behavior_patterns` 的存储和检索
4. 实现身份铁律的架构级保护（`_IMMUTABLE_FIELDS`）
5. 实现 `extract_reasoning_summary`（在 `_post_process_chat` 中调用）

#### 第三阶段：情感维度

1. 创建 `core/psyche/emotion.py`（EmotionalState 类，PAD 三维 + 8 情绪 MOODS 表）
2. 实现情绪更新逻辑 `update(success, user_sentiment, failure_type, novelty, violation, praise)`：
   - 先调 `decay()` 衰减旧状态，再按 11.2.4.6 delta 表叠加 PAD
   - interrupt 全零语义：PAD delta 全零、consecutive_failures 不计数、relational_depth 不回落
   - praise 覆盖规则：praise=True 时跳过 user_sentiment 的 delta
   - 硬触发判定（优先级：praise > violation > 连续失败≥3 > novelty > 最近邻）
   - 最近邻 + 滞回保护（0.05 阈值，方向性判断）
3. 实现情绪回落 `decay()`（指数半衰期，半衰期因 mood 而异，见 11.2.4.4）
4. 实现情绪 → 检索策略影响（MOODS 表 top_k 查值 + clamp [3, 10]，见 11.2.4.3）
5. 实现情绪 → 输出风格影响（8 种 mood 文案 + relational_depth 层级）
6. 实现长期关系感（relationship context）
7. server 层接入全部信号检测：
   - novelty（字符级 bigram Jaccard 检测 + 空/短消息守卫，见 11.2.4.6）
   - violation（沙箱 SandboxGuard 拒绝事件）
   - praise（关键词命中 且 user_sentiment > 0，双确认防讽刺）
   - failure_type（默认 "task"；"interrupt" 接 asyncio.CancelledError，需在异常处理分支**显式**调用 update，见 11.2.4.6 实现提醒）
   - user_sentiment（复用 extract_memories_from_chat，零额外成本）

#### 第四阶段：沉淀机制

1. 创建 `core/psyche/consolidation.py`
2. 实现 `should_consolidate` 触发条件
3. 实现 `consolidate` 沉淀过程
4. 实现 L3 → L2 的模式提取
5. 实现演化日志记录

### 14.3 验收标准

- [ ] system prompt 稳定在 ~1500 tokens，不再随记忆增长而膨胀
- [ ] N11-P2-17 问题消失（system prompt 不再需要截断）
- [ ] 切换模型后，Agent 的行为模式保持一致（夺舍验证）
- [ ] 长期未访问的记忆有效权重衰减，但可被检索唤醒
- [ ] Agent 具有情绪状态，基于趋近-回避动机系统驱动行为（检索策略、输出风格、工具调用）
- [ ] 8 种 mood 均可被信号触发（praise/violation/连续失败/novelty 硬触发 + 最近邻）
- [ ] interrupt 不影响情绪（PAD / consecutive_failures / relational_depth 三零）
- [ ] 情绪衰减在无交互 24h 后回归基线（valence→0, arousal→0.3, dominance→0.5）
- [ ] 滞回保护生效：happy↔interested 边界小 delta 不触发 mood 切换
- [ ] 身份铁律在架构层面不可被修改

---

## 结语

### 从一个问题到一个架构

N11-P2-17 起初只是一个 P3 级别的截断问题，但通过深入讨论，揭示了 Slime 架构的根本矛盾：**把"记忆"当作"system prompt 的内容"来对待，而不是"可检索的资源"来对待。**

这个矛盾的解决，不是靠优化截断策略，而是靠**架构层面的重构**：

1. **从全量注入到按需检索**——让人脑的"稀疏激活"在 LLM 上运行
2. **从单层 system prompt 到三层心智架构**——L1（身份）/L2（行为模式）/L3（动态心性）
3. **从模型携带人格到 Agent 承载人格**——模型仅提供算力，人格属于 Agent
4. **从静态记忆到艾宾浩斯遗忘**——记忆不删除，只沉睡，可被唤醒

### 核心设计哲学

> **"取之于人脑"——不存全量，只存索引；不全量阅读，只激活相关区域。**
>
> **"Agent 是人，模型是大脑器官"——人格属于人，不属于大脑器官。**
>
> **"身份铁律不变，半固定的→不固定的→决策→半固定的"——人会变，但变的是性格和记忆，不是身份。**

### 最终公式

```
最优解 = 硬件算力（载体）× 模型算力（大脑）× 运转思路（心性）× 工作经历（记忆）

其中：
  硬件算力 = 能跑当前模型的最小够用配置
  模型算力 = 在当前任务上性价比最高的模型
  运转思路 = L2 行为模式（半固定，缓慢演化）
  工作经历 = L3 动态心性（实时积累，按需检索）

框架（Slime）的作用：让这四个要素在一个持续生长的个体里融合
```

---

> **文档结束**
> 本文档记录了 Slime 项目从 N11-P2-17 截断问题出发，经过深入讨论，最终形成 L1/L2/L3 三层心智架构 + 夺舍机制 + 四维人格模型的完整思考过程。
>
> 这不是一个 bug fix，而是一次架构演进。


---

# Phase 3 待验证（Soul-Plan docs/soul-plan.md —— 未与现行已验证口径混排）

以下实现为 Phase 3 增强，**尚未经长周期实测验证**，独立成节：

- **三杠杆档位**（caution_level/promote_groups）：frustrated=0 聚焦、angry=1 抑制、concerned/disgusted=2 确认
- **promote 映射**（mood → 工具呈现顺序前置）：interested→retrieval、frustrated→terminal/write
- **归档系数**：behavior 归档 importance=6 + max(0.3, 原confidence×0.5) 再巩固起点
- **交错窗口 A/B**（on17/off17/on16）：四指标判决与否决条款待实测校准

> 已验证部分见 11.2.4 现行口径；本节内容以 REVIEW_AGENT.md A-101/A-102 为准。
