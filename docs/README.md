# slime 文档索引

> 最近整理：2026-10-06 ｜ 上一版整理：2026-09-08（见 `PROJECT_OVERVIEW.md`）
>
> 本页是 `docs/` 的唯一入口。找文档先看这里，不再逐目录翻。

---

## 阅读路线

| 你想做什么 | 看哪份 |
| --- | --- |
| **了解项目现在长什么样** | 仓库根 [`README.md`](../README.md) → [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) |
| **理解 Agent 主循环与上下文压缩** | [slime-agent-loop-design.md](slime-agent-loop-design.md)（最新定稿）· [agent-loop.md](agent-loop.md) · [context-compaction-loop.md](context-compaction-loop.md) |
| **了解心智 / 记忆 / 人格设计** | [Intelligence.md](Intelligence.md)（白皮书） |
| **了解整体架构与双栈规划** | [长存架构规划.md](长存架构规划.md) |
| **查已知问题（修没修）** | [KNOWN-ISSUES.md](KNOWN-ISSUES.md) |
| **查某个功能当初为什么这么做** | [REVIEW_AGENT.md](REVIEW_AGENT.md)（框架 + 问题登记表） |
| **追溯某次改动的原因** | [_archive/REVIEW_AGENT-fixlog.md](_archive/REVIEW_AGENT-fixlog.md)（逐条流水） |
| **了解子代理派发机制** | [subagent-delegation-research.md](subagent-delegation-research.md)（调研） |
| **查某个版本发布了什么** | [releases/](releases/) |

---

## 目录结构

```
docs/
├─ README.md                    ← 本文件（唯一入口）
├─ _archive/                    ← 已过时 / 已完成 / 历史快照（不删，但别当现状读）
├─ releases/                    ← 各版本发布说明
├─ research/                    ← 专题调研（UI 编排、Office 预览）
├─ specs/                       ← 规格定案
└─ （以下为当前有效文档）
```

---

## 当前有效文档

### 一、架构与总览

| 文档 | 定位 | 状态 |
| --- | --- | --- |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | 改动时间线 + 功能/代码对照 + 设计理念 | ⚠️ 主体是 09-08 快照，对照表已校正 |
| [长存架构规划.md](长存架构规划.md) | 双栈架构总纲、数据契约、身份移民 | 长期愿景，仍有效 |
| [plugin-system-design.md](plugin-system-design.md) | 插件系统设计：Skill/MCP 层次分离、可逆贡献原语、分阶段实施 | 📋 规划（P0 已完成，P1–P4 待做） |
| [阶段日志.md](阶段日志.md) | 双栈迁移逐阶段里程碑与验收 | **历史记录，不改写** |

### 二、Agent 循环与上下文

| 文档 | 定位 | 状态 |
| --- | --- | --- |
| [slime-agent-loop-design.md](slime-agent-loop-design.md) | Agent-Loop 设计定稿（含写作/记忆/压缩三闸裁决） | ✅ 最新（10-05） |
| [agent-loop.md](agent-loop.md) | Agent-Loop 应长什么样的论证 | 有效 |
| [context-compaction-loop.md](context-compaction-loop.md) | 上下文压缩设计定稿（A-1081） | 有效（部分已被 D1–D10 超越） |
| [handoff-context-compaction-p1.md](handoff-context-compaction-p1.md) | 压缩 P1 交接文档 | 交接件，已完成 |

### 三、心智与记忆

| 文档 | 定位 |
| --- | --- |
| [Intelligence.md](Intelligence.md) | 心智分层白皮书（L1/L2/L3） |
| [身份移民协议规格.md](身份移民协议规格.md) | `.slimeagent` 身份包格式 v1.2（规格定案） |
| [SILAM_INTEGRATION.md](SILAM_INTEGRATION.md) | SILAM-Σ 集成记录（4C 阶段） |

### 四、子代理与多 Agent

| 文档 | 定位 | 状态 |
| --- | --- | --- |
| [subagent-delegation-research.md](subagent-delegation-research.md) | 子代理派发机制的一手来源调研 | 调研基准，仍有效 |
| [A-1116-handover-todo.md](A-1116-handover-todo.md) | 子代理交接记录 | ✅ 已闭环（完成记录） |

> ⚠️ **SwarmExecutor 已于 2026-10-06 退役**：TS 侧 `executor.ts` / `swarm.ts` / `services/swarm.ts` 已删除，
> 编排能力迁入 `core-ts/src/services/subagent_batch.ts`（拆解 / 共享规格 / 产物合并）。
> Python 侧 `core/executor.py` 仍供 CLI 使用。历史设计见 [_archive/](_archive/archive.md)。

### 五、工具与界面

| 文档 | 定位 | 状态 |
| --- | --- | --- |
| [search_engine.md](search_engine.md) | 内置 web_fetch / web_search 方案 | 规格冻结（部分已实现，架构已变） |
| [slime-browser-adblock.md](slime-browser-adblock.md) | 内嵌浏览器广告拦截落地方案 | 方案 |
| [A-1136-office-render-plan.md](A-1136-office-render-plan.md) | Office 保真渲染双通道 | 进行中 |
| [A-1095-chat-orchestration-plan.md](A-1095-chat-orchestration-plan.md) | 聊天界面编排重构 | ✅ 已落地（完成记录） |
| [CLI-GUI-MAPPING.md](CLI-GUI-MAPPING.md) | CLI → GUI 功能映射 | 有效 |

### 六、调研与设计输入

| 文档 | 定位 |
| --- | --- |
| [slime-agent-ui-research.md](slime-agent-ui-research.md) | 主流 Agent 产品思考/正文/工具 UI 编排调研 |
| [design_research_2026-09-08.md](design_research_2026-09-08.md) | Agent 应用前沿设计方案调研 |
| [漏洞修复清单.md](漏洞修复清单.md) | 2026-08-16 四路并行安全审查清单 |
| [research/](research/) | 专题调研（Agent 过程 UI、Office 预览） |
| [specs/](specs/) | SILAM-Σ 规格（silam-sigma.md） |

### 七、问题追踪

| 文档 | 定位 |
| --- | --- |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | 已确认未修复问题登记（**唯一在用的问题登记处**） |
| [REVIEW_AGENT.md](REVIEW_AGENT.md) | 审查框架 + 问题登记表 + 项目约定速查 |

### 八、手抄 UI 预览（⚠️ 非现状，勿当设计依据）

这三份是 2026-09 的**手抄 HTML 预览**：自含样式、**不读真实 CSS**，因此与实际实现必然有偏差。
留着只为对照"当时设想的样子"；**任何实现决策都不得以它们为准**。

| 文件 | 对应 | 状态 |
| --- | --- | --- |
| `A-1115-topic-rail-preview.html` | 话题卷轴 | 已列入已知债务（见 `releases/v0.0.8.md`） |
| `A-1117-md-scroll-bulge.html` | Markdown 滚动条 | 零引用 |
| `todo-mark-preview.html` | 待办标记 | 零引用 |

---

## 约定与规则

- **约定速查**在 [REVIEW_AGENT.md §六](REVIEW_AGENT.md)；Git 行为硬契约在仓库根 [`AGENTS.md`](../AGENTS.md)。
- **文档状态标注约定**：文档开头若带 `⚠️ 时点说明` 或 `已归档`，说明它**不反映当前代码**，
  交叉引用前先核对文件是否存在。

---

## 待统一项（已知的双栈重复，**尚未合并**）

> 记录在此是为了避免"下次又被当成遗漏"。每项都写明了当前决策与将来统一时要动什么。

### 1. 并行 / 子代理能力（两条独立实现）

| | TS 侧（GUI 主链路） | Python 侧（CLI） |
| --- | --- | --- |
| 入口 | `delegate_subagent` 工具，可选 `subtasks` 参数触发批量 | `slime_cli.py` 的 `swarm` 命令 + `/auto` 自动检测 |
| 实现 | `core-ts/src/services/subagent.ts` + `services/subagent_batch.ts` | `core/executor.py` 的 `SwarmExecutor`（配 `core/swarm.py`、`core/process_worker.py`） |
| 拆解权 | **主 Agent 自己判断**（模型填 `subtasks`，系统不猜） | LLM 拆解器 `_decompose_task_sync` |
| 状态 | 活跃（2026-10-06 编排能力已并入子代理） | 活跃，**保留不动** |

**决策（2026-10-06）：暂不动，标注待统一。**

- TS 侧已**退役同名 `SwarmExecutor`**（`core-ts/src/{executor,swarm}.ts`、`services/swarm.ts` 已删，能力并入 `subagent_batch.ts`）。
- Python 侧**不删**：CLI 该功能完好、测试充分（`test_executor_loop.py` 等），且 Python 侧**没有**子代理能力，删了 CLI 会断功能。
- `core-ts/src/services/subagent_batch.ts` 里保留的 `decomposeTask` / `planMaxSubtasks` / `groupByRound`
  **不是死代码，是为将来 CLI 走 TS 时预留的 LLM 拆解器**（CLI 没有主 Agent 拆解能力，正需要它）。

**将来统一时需一并评估**：`core/executor.py`、`core/swarm.py`、`core/process_worker.py`，
以及 `slime_cli.py` 的两处调用点（`swarm` 命令 ~:3259、`/auto` 检测 ~:1396）。

### 2. `RiskLevel` 类型名撞车（第二产地）

同名不同义，且其中之一还重复定义：

| 位置 | 含义 |
| --- | --- |
| 风险分级（原 `merger.ts`，现已迁为 `BatchRiskLevel`） | `low` / `medium` / `high` / `critical` |
| `tools/classifier.ts` | 工具权限档 `auto` / `confirm` / `block` |
| `tools/policy.ts` | 同上 —— **与 classifier.ts 各定义一份，逐字相同** |

建议：收归到共享契约（或改名区分）。属铁律 11「同一事实写 N 处必漂」的待处理项。

---

## 维护规则（避免再次膨胀）

1. **修复流水不写进框架文档** —— `REVIEW_AGENT.md` 只留框架，新修复记录追加到 `_archive/REVIEW_AGENT-fixlog.md`。
   （2026-06 前它涨到 530KB，导致框架部分完全无法阅读，已拆分。）
2. **一次性的探针输出不进库** —— 截图、smoke 输出、临时预览 html 属取证产物，
   结论写进文档后即删。历史教训见 `A-1115-topic-rail-preview.html`（手抄常量，无人维护）。
3. **安装包不进 docs** —— 含绝对路径、会被现役代码超越的补丁包应归档或删除
   （原 `subagent-gap-closure/` 即此类）。
4. **删除模块时同步清文档与守卫** —— 路径字符串引用（不只是符号名）也要 grep
   （参见 `a1035-guards.spec.ts` 锚 `services/swarm.ts` 被删后 ENOENT 的教训）。