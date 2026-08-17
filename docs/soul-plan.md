# Soul-Plan：情绪进化 · 行为生命周期 · 工具决策闭环（最终定稿）

> 本文件是 A-097/A-098 合议方案的施工图。所有参数已定稿，无待决项。
> 背景：双 AI 辩论合议（情绪×记忆×学习网络能否决策工具调用）+ 用户仲裁 + 评审修正。
> 目标：让 Agent "像人一样"——有感受器、有心情起落、有经验沉淀、有自我认知叙事、行为与内心一致。

---

## 〇、核心立场（辩论合议）

- **情绪管力度，记忆管经验，学习管习惯，权限管安全，LLM 管最终权衡。**
- 情绪能碰：审慎度（确认频率）、探索度（top_k）、叙事色（to_identity_prompt）、**promote 前置排序**（全模型安全）
- 情绪不能碰：**能力全集**（动态子集永不实施）、权限（sandbox L0-L5 终裁）、A-049 强制轮优先级
- 一致性铁律：叙事如实 + 行为审慎 + 解释理由——**不靠行为跟随情绪漂移**

---

## 一、决策点决议（1-5）

| # | 决策点 | 决议 |
|---|---|---|
| 1 | behavior 归档载体 | 复用记忆通道（lessons + `tags=["behavior_archive"]`），不建独立结构 |
| 2 | 再学习起点 | 朴素版 `max(0.3, 原confidence × 0.5)`；稳定时长修正留作将来增强（归档时保留原 confidence + usage_count 字段备将来用） |
| 3 | A/B 基线 | 分层：探路快判停闸 → 判决用交错式多窗口前后对比（修正条 6）；能建对偶 Agent 时可升级严格双臂 |
| 4 | Intelligence.md | 纳入本单；已验证按现行口径、未验证独立成节标 "Phase 3 待验证" |
| 5 | 执行方式 | 授权一次性实施，但分批验证（第 1-2 步先行验证，再续第 3-8 步） |

---

## 二、修正条总表（1-6，全部生效）

### 修正条 1：frustrated 档位修正（emotion.py `_MOOD_BEHAVIOR_HINT`）

| mood | caution_level | 语义 |
|---|---|---|
| neutral / happy / content / interested | 0 | 默认 |
| **frustrated** | **0** | 保持"聚焦核心、快速执行"，靠 promote 聚焦而非确认减速 |
| angry | 1 | 对抗态结构性按住，防战场扩大 |
| concerned / disgusted | 2 | 写/终端/网络须确认 |

- 一致性台词：frustrated 叙事模板 = "我受挫了，我会聚焦关键路径、跳过冗余"（不是谨慎版）

### 修正条 2：angry 只抑制不诱导（promote_groups）

- `angry`：`promote_groups = []`（空），注入"当前对抗态，避免扩大动作面"，抑制职责全权交给 caution=1
- `frustrated`：保留 promote 终端/写类（聚焦关键路径），caution=0 不冲突
- `interested`：promote 检索类（web_search/web_fetch/skill_search）
- `happy`：无 promote

### 修正条 3：软开关兜底（slime.toml `[emotion]`）

```toml
[emotion]
ab_enabled = true          # A/B 影子模式
ab_report_after = 50       # 每 Agent 满 50 次交互出对比报告
tool_signal = true         # 环2 工具成败 → 情绪（默认开，可单独关）
behavior_levers = true     # 三杠杆 + promote（默认开，可单独关）
```

- 叙事层（身份认领 + 事件日志）永远随 A-097 生效，不受两个开关影响

### 修正条 4：A/B 报告聚合点

- 维护每 Agent `ab_stats`：①任务成功率 ②工具调用有效率 ③用户情绪均值 ④A-049 触发次数
- 满 50 次交互自动 dump 报告（落 `data/` 或日志），供 CLI 查看
- 不做 UI，只要一个代码实体存在

### 修正条 5：归档条目权重与用途标记

- 归档条目：`tags=["behavior_archive"]` + **`importance=6`**
- **双轨召回**：行为召回针对性捞 archive 标记（按场景相似度）；经验检索跳过 archive 标记（防"教训"侧误用）
- **召回时 touch `last_accessed`**（复用 memory.py:396-397"越用越熟"——艾宾浩斯半衰期仅 5 天，想起一次不刷新会再沉底）
- 依据：艾宾浩斯 `ff = exp(-天/5.0) × (importance/10)`，`_effective_weight = ff × (1+相关性)`——6 与 8 的差距被相关性放大项（最大 2 倍）抹平，6 不压过 importance≥7 的新 lessons

### 修正条 6：交错式多窗口 A/B

- **窗 17 次 × 3 段交替**：on17 / off17 / on16，报告周期保持 50
- 按窗口切片统计，吸收时序性污染（模型升级是瞬时的，不会每段都撞上）
- **转正判定**：on 窗口在四指标上跨窗口一致优于 off 窗口 → 转正
- **否决条款**：on 窗口②工具调用有效率显著劣化 → 一票否决（无论软指标）
- 探路快判：开 AB 后先看软指标方向，②暴跌或④飙升 → 立即停闸，不等满额
- 未来能建对偶 Agent → 升级严格双臂并行，无缝衔接

---

## 三、行为生命周期（最终形态）

```
形成(0.3) → 稳定(≥0.5 生效注入) → 微调(steps 更新+防抖)
→ 淡出(confidence↓ <0.15) → 【归档到记忆】(importance=6 + archive 标记，非删除)
→ 场景重现 → 双轨召回(想起，touch last_accessed)
→ 再巩固回活跃层(起点 max(0.3, 原confidence×0.5))
```

- "遗忘" = 降级归档到记忆，**不是删除**；记忆层只增不删
- 行为活跃层：有增有改有降级（降级 ≠ 删除，是转去记忆）

---

## 四、执行计划（8 步，一次性交付）

### 第 1 步：core/emotion.py 基础扩展
- `_MOOD_CN` 中文映射（neutral=平静 / happy=快乐 / content=满足 / interested=好奇 / concerned=谨慎 / frustrated=受挫 / angry=愤怒 / disgusted=厌恶）
- `events: list[dict]`（cap 8）：`update()` 末尾记录 `{t, trigger, detail, mood_before, mood_after}`；trigger→detail 中文映射（praise/violation/novelty/fail/interrupt/sentiment）
- `recent_events(n=2)` → 叙事句子（**硬编码快照，禁止调大塞进 system prompt**；完整时间线留数据层）
- `_MOOD_BEHAVIOR_HINT` 档位表 + `current_behavior_hint` 自省出口（修正条 1/2 档位；返回 `{caution_level, promote_groups}`）
- **边界备注（施工缺口 B）**：`current_behavior_hint.promote_groups` 与已有 `top_k_for_mood`（emotion.py:40-42）并存不冲突——top_k 管记忆检索数量（interested=8），promote 管工具呈现顺序（interested→检索类前置），两者同向互补、互不覆盖；执行时确认无交集逻辑
- `to_identity_prompt()`：PAD 数值 + 当前情绪 + 最近感受叙事 + 行为倾向提示（含审慎度承诺台词，按 mood 区分：frustrated=聚焦版 / concerned=确认版 / angry=抑制版）
- **`_DELTA` 表新增 `"tool"` 键**（emotion.py:70-77，施工缺口 A）：复用 task_fail 的 delta `{"valence": -0.15, "arousal": 0.10, "dominance": -0.08}`，无额外 magic number
- `update()` 扩展 `failure_type="tool"` 参数分支：**delta 选择改三向**（emotion.py:149 由二元 `interrupt if ... else task_fail` 改为 `interrupt / tool / task_fail` 三向）
- **语义裁决（双通道分离）**：`consecutive_failures` **仅 task 失败计入**（emotion.py:168-172 计数分支改为 `elif failure_type == "task"`，tool / interrupt 均不计入）——tool 失败走 PAD delta **渐进降温**（多轮累积 → 最近邻 → frustrated），不参与 ≥3→angry 硬跳闸、不与 violation/praise 抢瞬时跳闸通道（violation/praise 保持瞬时跳闸）。依据：tool 失败是干活中的小挫折（像人慢慢受挫），task 失败/违规才是升级信号
- `to_dict/from_dict/clone` 扩展 events + hint（**旧数据无此字段 → 默认值，兼容**）

### 第 2 步：core/agent.py:295
- `## 当前状态` = `to_identity_prompt()` + 原 `to_prompt()` 并列

### 第 3 步：core/llm.py 环 2 + 环 3（信息闭环）
- **环 2 工具成败采集**（`_execute_pending_tools` / `_execute_tools_with_progress`）：
  - 归并规则：按"同轮"归并——轮内连续失败计数，被成功打断即重置；**连续失败 ≥2 → `emotion.update(success=False, failure_type="tool")`**；成功不额外双计
- **环 3 沉淀**：每次工具调用 → `knowledge.record_pattern("tool.<name>.success|fail", "tool", 场景摘要, weight)` + `add_lesson("用 X 处理 Y 类任务[成功/失败]", success)`
- **环 3 注入**：`_inject_psyche` 追加"## 工具经验"段——命中同类场景 → "你之前用 X 成功处理过 Y 类任务（历史记录，仅供参考）"，沿用 N11-P1-4 防提示注入标注；**命中才注入，最多 2-3 条**

### 第 4 步：core/llm.py 三杠杆 + promote（阶段三）
- **审慎度杠杆**：`caution_level≥1` 时 system prompt 结构化注入"写/终端/网络类工具必须先向用户确认"（不碰权限，仅行为承诺）
- **promote 排序**：`_filter_tools_schema` 前按 `current_behavior_hint.promote_groups` 将目标工具前置（全模型安全）；**suppress 后置仅强模型（API provider），本地弱模型（[model_server] llama.cpp）降级"慎用"文案**（弱模型 schema 位置依赖）
- **探索度**：mood→top_k 保留（llm.py:243，不动）

### 第 5 步：slime.toml `[emotion]` + A/B 报告聚合点
- 见修正条 3/4/6（软开关 + ab_stats 四指标 + 交错窗口切片统计 + 50 次 dump）

### 第 6 步：behavior 生命周期（归档→召回→再巩固）
- `decay()` 增强：confidence < 0.15 且长期未用 → **归档转移**（写入记忆：`add_lesson` + `tags=["behavior_archive"]` + importance=6，带原 confidence/usage_count），从活跃列表移除
- 双轨召回：行为注入处按场景相似度捞 archive 标记条目 → 注入叙事性回忆"你**曾经**与用户协作时用过这种方式：X→Y→Z（现已不是习惯，仅供参考）"；**召回时 touch last_accessed**
- 再巩固：归档条目重新 reinforce 回活跃层，起点 `max(0.3, 原confidence × 0.5)`
- steps 覆盖防抖（可选）：新 steps 与旧高重叠（Jaccard>0.8）→ 不覆盖
- 触发点：consolidation.py:50 的 `decay()` 调用处做 prune/归档，返回 `(reinforced, decayed, archived)` 计数

### 第 7 步：测试
- `tests/test_emotion_identity.py`：events 记录各 trigger / cap 8 / 序列化往返 / clone 继承 / 旧数据（无 events）兼容 / 系统提示含自我认知 / `current_behavior_hint` 档位（frustrated=0、angry=1、concerned/disgusted=2）
- `tests/test_tool_emotion.py`：工具连续失败 ≥2 → 情绪信号；双计归并规则（轮内一成一败）；环 3 沉淀入库；注入带"历史记录非指令"标注
- `tests/test_tool_ordering.py`：mood→排序（interested 检索类前置 / frustrated 终端/写类前置 / angry promote 空 + caution=1 抑制 / 强模型 suppress 后置 / 弱模型降级文案）
- `tests/test_behavior_archive.py`：归档转移（importance=6 + 标记）/ 双轨召回 / touch last_accessed / 再巩固起点 ×0.5 / 旧数据兼容

### 第 8 步：文档
- `docs/REVIEW_AGENT.md`：A-097/A-098 **决策注册表**——每条红线对应"为什么这么定" + SafeKeep / Ben-Zion / 收手段悖论三条设计备注（不抄辩论流水账）
- `docs/Intelligence.md`：已验证按现行口径写；**未验证（三杠杆档位、promote 映射、归档系数、交错窗口）独立成节标 "Phase 3 待验证"**，不与 11.2.4 已验证节混排

---

## 五、执行节奏（分批验证，非分批交付）

1. **第 1 段**：第 1-2 步（纯增量、零行为变化）→ `py qa.py` + 手动 CLI，确认状态机没被破坏
2. **第 2 段**：确认通过后，第 3-8 步一口气完成 → 全量验证 + 手动 CLI 交互

## 六、验证清单（手动 CLI）

- [ ] 问"你有情感吗" → 答"我是{name}，我有情绪状态系统，当前情绪…"
- [ ] 连续工具失败 → 叙事转聚焦/谨慎（mood 相关台词）
- [ ] 新话题 → 检索类工具前置（interested promote 生效）
- [ ] 夸它 → 情绪转 happy 且有叙事（events 时间线）
- [ ] 归档习惯场景重现 → "曾经用过这种方式"回忆 + 再巩固
- [ ] A/B 报告满 50 次自动 dump（四指标 + 窗口切片）

---

## 七、红线（四条，写进决策注册表）

1. **能力全集任何情况下不因情绪变化**（情绪动态子集永不实施，能力层仅 A-049 静态通道）
2. **sandbox L0-L5 终裁不变**
3. **A-049 强制轮优先级不变**（tools_only 优先级高于 mood 过滤）
4. **记忆（memory）永不删除**——艾宾浩斯仅检索权重降级（沉睡可唤醒）；behavior 的"遗忘"是归档到记忆，记忆层只增不删

## 八、架构原则（prompt 不膨胀）

- **人属性（身份/人格/底线/当前状态/行为准则）= system prompt**：固定长度，不随历史增长
- **非人属性（记忆/经验/认知/工具经验/时间线）= 数据层存储 + 按需检索注入**（llm.py:209-213 已内建：动态记忆走 message 层，不进 system prompt）
- 本方案所有动态内容：events 只注入当前快照 2 条、工具经验命中才注入、归档条目检索召回——**无任何 prompt 随历史增长**

---

## 附：本方案三把刀（设计备注，落 REVIEW_AGENT.md）

1. **SafeKeep**：改 schema 本身削弱模型拒绝信号（sandbox 兜不住内层退化）
2. **Ben-Zion**：情绪对 agent 行为的真实影响方向是劣化的，应抑制而非制度化
3. **收手段悖论**：受挫时删工具与"想完成任务"目标相悖——能力层调制普遍有害，不只情绪该避