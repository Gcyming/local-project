# slime 平台 Agent 能力完善 — 进度状态（2026-09-06）

## 已完成 ✅

### A-942. 子代理模型档位定制（贵模型统筹、廉价模型执行）
- 全局默认模型：设置→后台任务「子代理默认模型」下拉（继承/各供应商启用模型/本地模型），即设即存（userData/subagent-model.json）
- 路由优先级：对话显式指定 > 专家定义 > 全局默认 > 继承（对齐 Claude Code subagents model: frontmatter）
- 聊天栏自然说明：delegate_subagent 工具新增 model 参数，模型理解"用便宜的/XX 执行"并携带，零新 UI
- 测试 +5（subagent 4 + delegate 透传 1）；vitest 全量 767/767

### A. 上下文分桶托盘（P0）
- 引擎层：computeContextBuckets 纯函数 + stream() done 事件注入
- 主进程：CtxBuckets 类型 + 两个 stream 循环捕获 + slime:chat:done 转发
- 渲染层：CtxUpdatePayload 加 buckets + ContextWindowBar 新增"来源"8 源分桶微条
- 测试：7 个单元测试全部通过

### B. 工具权限细化 + 分类器审查（P1）
- 调用前分类器（core-ts/src/tools/classifier.ts）：只读白名单 auto / 变更类 confirm / rm -rf·curl|sh·内网云元数据·写越权·敏感文件 block
- 主进程 sandbox 审批回调节点前置预检（block 直拒、全 auto 直放、confirm 走弹窗）；classifyPermissions 按 action 名分型
- 会话级审批（ask_user/approvalMode/sandbox 白名单）原有能力已复核

### C. 记忆三层 + 实体图谱（P1）
- 三层调度（memory/three_layer.ts）+ 图谱 CRUD（memory/graph.ts）纯函数骨架
- **存储层接入（A-940）**：MemoryFact 新增 layer/access_count/entity_keys 持久化、写入即分层；
  consolidateLayers（working→episodic→semantic / prune）与演化 ConsolidationEngine 同频调度（chat/swarm）；
  实体图谱旁路持久化 memory_graph.json + factsByGraphNeighbors
- **多路召回（A-940）**：retrieveFromStore 汇流「向量种子→链接遍历→图谱邻居通道→标签过滤→分layer过滤→排序」，
  返回 item.layer 与 stages.graph_walked

### D. 可观测性 + 评估门禁（P1）
- trace/span 全链路骨架（observability/trace.ts）：route→tool_call→tool_result→reasoning→reply→done + eval
- **引擎 stream 真实事件点埋点（A-940）**：主进程 TraceRecorder（chat:stream/chat:retry 两通道）、
  slime:trace:get/update IPC + preload、失败挂 completion eval=false
- **TraceViewer 可视化（A-940）**：StatusPanel「链路视图」卡（分类徽章/耗时/入参结果摘要/失败红标）

### E. Plan 一等对象（P2）
- Plan 状态机（planning/plan.ts）+ builtin 注册 plan_create/plan_update（模型可调用，返回 Plan JSON）
- **UI 与 IPC（A-940）**：主进程 planStore + 工具轮拦截（plan_create/plan_update 还原 JSON；
  todo_write 落盘文件构造轻量 Plan → todo_write 返回 Plan JSON 语义）、slime:plan:get/update IPC + preload
- **PlanPanel（A-940）**：StatusPanel「任务进度」卡（进度条 + 阶段状态，全会话聚合）

### F. GUI 单元测试（P2）
- contextMath 纯函数（ContextRing/ContextWindowBar 已接线）8 例
- **ask_state（A-941）**：ask_user 决策分叉窗口状态机纯逻辑抽离为 `askState.ts`
  （buildAskDecision/initialAskSelection/canSubmitAsk/safeRecommendation/consequenceAt），
  **已接入 ChatPanel 三处**（初始选中/决策构造/提交可用性）+ 12 例
- **PlanPanel（A-941）**：planProgress/PlanCard（进度条宽度/删除线/状态文本/失败红条）/空态 10 例
- **TraceViewer（A-941）**：TraceBody 纯渲染（事件计数/封闭数/时长/失败归因）+ 空态 4 例
- classifier 12 例 + plan 8 例 + observability-memory（C/D 集成）19 例

## 未完成 🔴

### F（余）。非阻塞收尾项
- usePlanStore/useTraceStore 为 window 订阅 hook，node 环境仅测纯渲染路径（hook 交互留待 jsdom/组件测试框架引入）
- PermissionDialog（审批四档弹窗）离散在 ChatPanel 内联，决策与渲染逻辑随 plan/contextMath 纯函数已覆盖主体

## 已知风险

1. core-ts/ 被 .gitignore 忽略，C/D/E 引擎改动不在 git 追踪范围（私有 IP 策略）
2. trace/planStore 为内存驻留（重启清空，plan 可由工具输出重建）
3. chunk/reasoning trace 为 40 采样封顶（防 spans 膨胀，非全量）

## 详细规划

完整规划见：docs/SLIME_IMPROVEMENTS_PLAN.md