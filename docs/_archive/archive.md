# 归档索引（`_archive/`）

> 建立：2026-10-06 ｜ 归档原则：**不删历史，但必须标明"已过时"**
>
> ⚠️ **本目录内所有文档都不反映当前代码状态。** 仅作历史追溯与决策依据查阅，
> 不可作为「现状如何」的依据。当前文档见上级目录的 [README.md](../README.md)。

---

## 归档清单

### 已完成 / 进度报告（内容已被实现超越）

| 文件 | 原位置 | 归档原因 |
| --- | --- | --- |
| `SLIME_STATUS_SUMMARY.md` | docs/ 根 | 2026-09-06 的 A–F 进度报告，六项**全部已实现并大幅超越**（记忆三层已升级为混合检索 RRF、plan/trace/classifier 均已落地） |
| `SLIME_IMPROVEMENTS_PLAN.md` | docs/ 根 | 上一份的**规划源**（A–F 能力规划），同样全部落地 |
| `A-1116-handover-todo.md` | docs/ 根 | 交接件，标题已自述「①②③⑤ 全部闭环」（留在主目录作为完成记录） |
| `A-1095-chat-orchestration-plan.md` | docs/ 根 | 聊天编排方案，状态已标「S0–S6 全部落地」 |

### 旧时点评估 / 审计（结论已被超越）

| 文件 | 原位置 | 归档原因 |
| --- | --- | --- |
| `AUDIT-2026-09-08.md` | docs/ 根 | 2026-09-08 时点的引擎问题审计，问题基本都已修复 |
| `ARCH-REVIEW-2026-09-08.md` | docs/ 根 | 同上，架构评估报告；其结论已被后续大量实现超越 |

### 设计定稿（实现已大幅演进）

| 文件 | 原位置 | 归档原因 |
| --- | --- | --- |
| `soul-plan.md` | docs/ 根 | 情绪进化/行为生命周期定稿（2026-08-16）。参数已定稿，但实现在 `core-ts/src/mind/` 已重构 |
| `sandbox_design.md` | docs/ 根 | 沙箱 L0–L5 设计（v1.0）。现役实现为 `core-ts/src/sandbox.ts`（L0–L4 + fail-closed），级别数已变 |

### 修复流水（拆分自 REVIEW_AGENT.md）

| 文件 | 说明 |
| --- | --- |
| `REVIEW_AGENT-fixlog.md` | 2026-08 ~ 2026-10 的逐条 Fix Log（220KB / 200+ 条 A-xxx）。**含失效声明** —— 部分路径已删除、行号已失准，仅作历史追溯 |

### 安装包（已被现役代码超越）

| 目录 | 归档原因 |
| --- | --- |
| `subagent-gap-closure/` | 2026-09-05 的子代理增强**安装包**（含 `D:\pilot project` 绝对路径、要覆盖 `subagent.ts`）。现役 `core-ts/src/services/subagent.ts` 已达 954 行并新增批量编排能力，安装包内容全部过时 |

### 跨项目文档（不属于 slime）

| 文件 | 归档原因 |
| --- | --- |
| `ISSUE-002-bash-tool-env-broken.md` | 描述的是 **WorkBuddy 桌面端 Bash 工具**的 PATH 问题，作者原文即注明「不影响 slime 自身运行」 |

---

## 已删除（未归档，git 历史可找回）

| 内容 | 删除理由 |
| --- | --- |
| 17 张探针截图（727KB）：`A-1115-*.png`（7 张）、`A-1130-diff-row-band-新旧对照.png`、`a1136-probe-out/` 9 张 | 零引用的取证产物；结论已写入 A-1115 / A-1136 文档 |
| `a1136-probe-out/` 整个目录 | Office 渲染探针输出，一次性 |
| （另一分类下的手抄 html 预览与 ISSUE-002 见本文件对应条目） | — |

---

## 归档后如何查找历史

- git 历史：`git log --diff-filter=D --name-only -- docs/` 列出所有已删文件。
- 修复流水：`_archive/REVIEW_AGENT-fixlog.md`（框架与问题登记表仍在主目录 `REVIEW_AGENT.md`）。
- 阶段里程碑：`../阶段日志.md`（历史记录，**不改写**，刻意留在主目录）。