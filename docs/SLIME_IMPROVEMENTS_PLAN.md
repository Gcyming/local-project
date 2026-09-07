# slime 平台 Agent 能力完善规划（A-F）

> 生成时间：2026-08-24  
> 依据：三篇调研报告（头部闭源/Claude Code Cursor Copilot/Devin/Manus；开源框架 LangGraph CrewAI AutoGen；前沿研究 AWM/Reflexion/MemGPT）  
> 优先级：P0 必做 / P1 建议 / P2 锦上添花

---

## A. 上下文分桶托盘（Context Buckets Tray）

**来源**：Cursor 3.3 创新 + Claude Code context-window 分来源计量  
**优先级**：P0  
**目标**：让用户看清一次请求的 token 去了哪（8 来源：system/rules/memory/workspace/planning/tools/history/message），对齐 Cursor 的"Context Buckets"理念

### 已完成 ✅

| 组件 | 文件 | 状态 |
|---|---|---|
| 契约层 | gui/src/shared/ipc.ts — CtxBuckets 接口 | ✅ |
| 引擎层 | core-ts/src/services/chat.ts — ContextBuckets 类型 + EngineChunk/ChatEngineResult 加 ctxBuckets 可选字段 | ✅ |
| 引擎计算 | core-ts/src/services/engine.ts — computeContextBuckets 纯函数 + stream() 两个 done 事件注入 | ✅ |
| 主进程透传 | gui/src/main/index.ts — CtxBuckets 类型定义 + 两个 stream 循环捕获 + slime:chat:done 转发 | ✅ |
| 渲染层订阅 | gui/src/preload/index.ts — onDone 类型加 ctxBuckets | ✅ |
| 渲染层状态 | gui/src/renderer/pages/ChatPanel.tsx — CtxUpdatePayload 加 buckets 字段 + dispatch 透传 | ✅ |
| GUI 展示 | gui/src/renderer/pages/RightSidebar.tsx — liveBuckets 状态 + onCtxUpdate 订阅 + ContextWindowBar 新增"来源"8 源分桶微条 | ✅ |
| 单元测试 | tests/core-ts/context-buckets.spec.ts — 7 个用例全部通过 | ✅ 7/7 pass |

编译验证：gui tsc exit 0 · core-ts tsc exit 0

已知风险：core-ts/ 被 .gitignore:11 忽略，engine.ts/chat.ts 改动不在 git 追踪范围。

---

## B. 工具权限细化 + 分类器审查

**来源**：头部闭源（Claude Code 工具调用前分类器）、开源框架（Agent 权限分层）  
**优先级**：P1  
**目标**：将粗粒度 4 类权限（read/write/terminal/network）细化到工具级，增加会话级审批 + 调用前分类器复核

### 已完成：无

### 2026-09-06 实施情况（B 批次）
- `core-ts/src/tools/classifier.ts` **新增**：调用前权限分类器（纯函数，12 例单测）——terminal 只读命令白名单自动放行 / 写·变更命令需确认 / 高危特征（rm -rf /、sudo rm、curl|sh、内网与云元数据地址）直接阻断 / write 路径越权与敏感文件阻断 / network HTTPS 放行、明文与内网阻断
- `gui/src/main/index.ts` **挂接**：sandbox 审批回调前置预检（block 直拒不进弹窗、全 auto 直放、其余走既有 ask_user/approvalMode 弹窗），拒绝/放行 reason 携带分类器依据

### 待完成
- registry 工具级 policy 字段结构化（与 classifier 合并策略）
- PermissionDialog 独立页（现复用输入框内嵌 ask_user 审批，不重复造）

### 待完成（原清单）
1. ~~调研 Claude Code/Cursor 工具权限模型~~（已含于分类器设计：（web_search））
2. 设计权限粒度细化方案：
   - file.write → 按路径前缀/扩展名/文件大小分层
   - terminal → 命令白名单（ls/cat 自动批，rm/sudo 需确认）
   - network → 域名白名单 + 协议限制
3. 设计会话级审批工作流（结合 slime 现有 ask_user + sandbox L0-L5）
4. 设计调用前分类器复核（触发条件、输入特征、输出决策）
5. 落地文件：
   - core-ts/src/tools/registry.ts — 权限字段细化
   - core-ts/src/tools/classifier.ts — 新文件：调用前分类器
   - gui/src/renderer/pages/PermissionDialog.tsx — 新文件：会话级审批 UI
   - shared/ipc.ts — 新增 PermissionDecision 扩展

### 预估工时：2-3 天
### 状态：待设计文档 → 待实施

---

## C. 记忆三层架构 + 实体图谱

**来源**：MemGPT（working/long-term 分层）、LangGraph（memory graph/relationship layer）  
**优先级**：P1  
**目标**：将现有扁平记忆注入（retrieveSegments）升级为三层架构 + 实体关系图谱

### 已完成：无

### 待完成

1. 调研 LangGraph/CrewAI/AutoGen 的记忆层设计 + MemGPT 的 Memory 管理
2. 设计记忆三层架构：
   - Working Memory（工作记忆）：当前会话上下文，TTL = 会话生命周期
   - Episodic Memory（情景记忆）：关键交互事件，TTL = 30 天
   - Semantic Memory（语义记忆）：用户偏好/知识事实，TTL = 永久
3. 设计实体-关系图谱层：
   - 实体类型：user/task/file/tool/concept
   - 关系存储：LanceDB（向量）+ SQLite（图谱关系表 memories_entities）
4. 设计记忆写入/演进时机（结合 slime 演化引擎、consolidation 流程）
5. 落地文件：
   - core-ts/src/memory/graph.ts — 新文件：实体图谱 CRUD
   - core-ts/src/memory/consolidation.ts — 新文件：三层迁移调度
   - core-ts/src/session.ts — 修改：retrieveSegments 升级多路召回

### 预估工时：3-4 天
### 状态：待设计文档 → 待实施

---

## D. 可观测性 + 评估门禁

**来源**：LangSmith/LangGraph 全链路追踪、TrajectoryEval/SWE-bench 评估框架、Reflexion 自反思  
**优先级**：P1  
**目标**：一次 Agent 任务的全链路可观测（trace/span 关联）+ 关键节点评估门禁

### 已完成：无

### 待完成

1. 调研 LangGraph/LangSmith/AgentOps 的可观测性与评估门禁做法
2. 设计全链路可观测事件 schema：
   - 事件流：route_select → memory_retrieve → tool_call → tool_result → reasoning_chunk → reply_chunk → done
   - Trace ID：每次请求唯一 trace_id，所有事件携带
   - Span 关联：工具轮父子 span
3. 设计评估门禁（eval gate）：
   - 触发点：工具调用后、任务完成声明后、记忆写入前
   - 评估指标：成功判定、幻觉检测（增强 A-049）、轨迹质量
4. 落地文件：
   - core-ts/src/observability/trace.ts — 新文件：trace/span 管理
   - core-ts/src/services/events.ts — 修改：EventSequence 加 trace_id
   - gui/src/renderer/components/TraceViewer.tsx — 新文件：trace 可视化（可选）
   - docs/observability_eval_gate_design.md — 设计文档

### 预估工时：2-3 天
### 状态：待设计文档 → 待实施

---

## E. Plan 一等对象（Plan as First-Class）

**来源**：Claude Code Task System、Cursor todo 状态机、Devin 任务拆解  
**优先级**：P2  
**目标**：将"任务拆解"从提示词引导升级为结构化 Plan 对象，支持进度追踪、子任务委派、失败重试

### 已完成：无

### 待完成

1. 设计 Plan 数据结构（id/sessionId/description/stages/createdAt/updatedAt）
2. 设计 Plan 生命周期（创建→执行→完成/失败→重新规划）
3. 升级 todo_write 工具返回结构化 Plan JSON
4. StatusPanel 新增"任务进度"卡片（显示 stages 列表 + 进度条）
5. 落地文件：
   - core-ts/src/planning/plan.ts — 新文件：Plan 类型 + 状态机
   - core-ts/src/tools/builtin.ts — 修改：todo_write 升级
   - gui/src/renderer/pages/PlanPanel.tsx — 新文件：Plan 管理 UI
   - gui/src/renderer/pages/StatusPanel.tsx — 修改：新增"任务进度"卡片

### 预估工时：2 天
### 依赖：B 完成（todo_write 升级）
### 状态：未开始

---

## F. GUI React 单元测试

**来源**：工程加固要求（README 阶段表）  
**优先级**：P2  
**目标**：覆盖核心 UI 组件的单测，防回归

### 已完成：无

### 待完成

1. 测试框架：vitest + @testing-library/react（项目已用 vitest）
2. 覆盖范围：
   - ContextRing：used/cap 比例计算、颜色阈值
   - ContextWindowBar：compose 四项构成、buckets 八源分桶、detail 折叠
   - PermissionDialog：ask_user 弹窗状态机
   - PlanPanel：stage 状态切换、进度计算
3. Mock 策略：window.dispatchEvent、React.lazy、electron ipcRenderer
4. 落地文件：
   - tests/gui/ContextRing.spec.tsx
   - tests/gui/ContextWindowBar.spec.tsx
   - tests/gui/PermissionDialog.spec.tsx
   - tests/gui/PlanPanel.spec.tsx

### 预估工时：1-2 天
### 依赖：E 完成（PlanPanel 可用）
### 状态：未开始

---

## 2026-09-06 实施批次（C/D/E/F 骨架交付，验证全过）

| 方向 | 交付 | 状态 |
|---|---|---|
| C. 记忆三层 + 图谱 | `core-ts/src/memory/three_layer.ts`（层分类/TTL/迁移调度/剪枝，accessCount 沉淀判据）+ `memory/graph.ts`（实体/双向边/邻居召回/权重叠加 CRUD，值语义） | ✅ 骨架+10 例测试 |
| D. 可观测性 | `core-ts/src/observability/trace.ts`（trace/span 父子/评估门禁挂载/summarize/序列化，事件流 route→tool→reply→done） | ✅ 骨架+测试 |
| E. Plan 一等对象 | `core-ts/src/planning/plan.ts`（Plan 类型+状态机+按 label 推进+进度计算）+ `builtin.ts` 注册 `plan_create`/`plan_update`（模型可调用） | ✅ 核心 8 例测试 |
| F. GUI 单测 | `gui/src/renderer/pages/contextMath.ts`（环色阶/构成段/分桶占比纯计算）+ ContextRing/ContextWindowBar/bucketComps 全部接线 | ✅ 8 例测试 |

接续剩余（下一批）：C 接入既有 store/retrieve 多路召回与演化引擎 consolidation；D 引擎 stream 事件点埋点 + TraceViewer；E StatusPanel「任务进度」卡与 PlanPanel UI、todo_write 返回 Plan JSON；F PermissionDialog/PlanPanel 组件测试。

---

## 优先级排序与执行顺序

| 优先级 | 方向 | 预估工时 | 依赖 |
|---|---|---|---|
| P0 | A. 上下文分桶托盘 | 已完成 | 无 |
| P1 | B. 工具权限细化 + 分类器 | 2-3 天 | 设计文档 |
| P1 | C. 记忆三层 + 实体图谱 | 3-4 天 | 设计文档 |
| P1 | D. 可观测性 + 评估门禁 | 2-3 天 | 设计文档 |
| P2 | E. Plan 一等对象 | 2 天 | B 完成 |
| P2 | F. GUI 单元测试 | 1-2 天 | E 完成 |

建议执行顺序：
1. 先写 B/C/D 设计文档（并行，每个 0.5 天）
2. 按 B → C → D 顺序实施（各有独立模块，可串行）
3. E 依赖 B（todo_write 升级）
4. F 最后（需要 E 的 PlanPanel 可用）

---

## 已知风险与待决策

1. **core-ts gitignore 问题**：core-ts/ 被 .gitignore:11 忽略，A 的改动不在 git 追踪范围。建议：移除 gitignore 规则或将改动归档到非 ignore 目录。
2. **B/C/D 设计文档缺失**：subagent 失败未写入。建议：手动补充或让新 agent 接力。
3. **并发写冲突**：AGENTS.md 第 1.3 条要求多 agent 并发时用 git worktree 隔离，本环境无 git_* 工具。建议：串行实施，避免同一文件被多个 agent 修改。
