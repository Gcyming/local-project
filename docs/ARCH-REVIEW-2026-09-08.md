# slime 修复与架构评估报告（2026-09-08）

> 范围：已确认问题修复 + 架构优化建议 + 新功能清单 + 前沿设计灵感
> 验证基线：全仓 tsc 0 / vitest **852/852 全绿** / pytest tests/test_tools.py **76/76**
>
> **落地进度**：§2.2（安全清单收敛 shared/）✅、§2.3（记忆三件套）✅、§2.4（预算护栏）✅ 均已实现并回归；
> §2.1（拆 main 上帝文件）、§2.5（Git 契约运行时化）仍为提案（未选中落地）。

---

## 1）问题修复的内容与说明

本轮修复了审计确认的 **7 处真实缺陷**，全部附带回归测试与验证。

### 1.1 生产包默认开放 CDP 调试端口 9222（本地提权，最高危）

- **位置**：`gui/src/main/index.ts`
- **改动**：`if (process.env.NODE_ENV !== "production")` → `if (!app.isPackaged)`
- **原理**：构建产物中 `process.env.NODE_ENV` 未被静态替换且运行时无人赋值（已核实
  `gui/out/main/index.js` 中原判定原样保留），旧写法在正式包里条件恒真 → 9222 端口默认开放，
  本机任意进程可附到渲染层执行任意 JS、读取全部 IPC 流量（含解密后的 API Key）。
  `app.isPackaged` 是 Electron 官方推荐的打包判定，不依赖环境变量。

### 1.2 子 Agent 沙箱逃逸（workspace 被清空 = 全放行）

- **位置**：`core-ts/src/sandbox.ts` `getAgentConfig()`
- **改动**：`{ ...parentCfg, workspace: "" }` →
  `{ ...parentCfg, workspace: parentCfg.workspace || this.config.workspace }`
- **原理**：`validateWorkspace()` 语义是「空 workspace = 不限制」，原代码把继承来的
  workspace 显式清空，导致所有带 parent_id 的子 Agent（fork / swarm / delegate_subagent）
  文件路径隔离完全失效。修复后子代权限 ⊆ 父代——与 Claude Code subagent 官方语义对齐
  （父代运行时授权不向子代传播，子代只能更严）。
- **回归测试**：子代继承父代 workspace / 子代越界写入被拒 / 父代未设时回退全局（3 条）。

### 1.3 ChatPanel 每次渲染泄漏一个 IPC 监听器

- **位置**：`gui/src/renderer/pages/ChatPanel.tsx`
- **改动**：`off4`（`slime:chat:streamEnded` 订阅）从组件函数体挪进 useEffect 内部。
- **原理**：原代码在组件函数体里执行订阅 IIFE，effect cleanup 只解绑首渲染那次；
  流式期间每 50ms 一次 setState → 每分钟新增上千个永不回收的监听器，事件派发 O(n) 累积，
  长会话必然卡死。挪进 effect 后随 deps 重建并正确解绑。

### 1.4 主进程无 unhandledRejection 兜底 + 两处裸 Promise

- **位置**：`gui/src/main/index.ts`
- **改动**：① 注册全局 `process.on("unhandledRejection")`（记录日志、主进程不退出）；
  ② statsPoll 的 3 秒轮询包 try/catch 并去掉 `statsService!` 非空断言（改为空值守卫跳过本轮）；
  ③ `startEmbedding()` 链尾补 `.catch()`。
- **原理**：Node 默认 throw 模式下任何未捕获 rejection 直接终止主进程（用户感知为
  "软件自己关了"）。后端 sidecar 挂掉/重启期间原代码每 3 秒触发一次，必崩。

### 1.5 主链路无引擎源码写入保护（双栈迁移回归）

- **位置**：`core-ts/src/tools/classifier.ts` + `gui/src/main/index.ts`
- **改动**：classifier 新增 `PROTECTED_SOURCE_DIRS`（core-ts/core/tools/social/sidecar/
  shared/gateway-ts/config/configs/scripts/gui/linux/windows/runtime/skills/tests/.git）与
  纯函数 `isProtectedSourcePath(target, root)`；main 的 `classifyPermissions` 写入分支接线，
  命中即 block。
- **原理**：原 `SENSITIVE_FILES` 只按文件名挡密钥/配置，写 `core-ts/src/sandbox.ts` 这类
  引擎源码走"普通写入"自动放行——Agent 可改写自身护栏。被替换的 Python 侧本有目录级
  `_WRITE_BLOCKED_DIRS`，TS 侧缺失，属迁移回归。判定**锚定 PROJECT_ROOT 内部**，
  用户工作区里的同名目录（如用户自己的 `core/`、`gui/`）不受影响。
- **回归测试**：5 条（根下受保护命中 / 绝对路径命中 / 普通路径放行 / 根外同名放行 / 空值）。

### 1.6 审计日志重启后被静默清空

- **位置**：`core-ts/src/sandbox.ts` `rotateAuditLog()`
- **改动**：轮转数据源从「内存镜像」改为「磁盘文件本身」；轮转串入 `auditQueue` 与追加写
  严格串行；失败改 `console.warn`（不再静默吞）。
- **原理**：`auditLog` 从不从磁盘回载，进程重启后内存为空，攒到 200 条时首次轮转用
  内存 kept 全量覆写磁盘 → 历史审计瞬间清空。审计日志必须 append-only 且跨重启存活。
- **回归测试**：全新实例（模拟重启）轮转保留磁盘近期记录、过期记录正确淘汰（1 条）。

### 1.7 Python 侧写入黑名单覆盖不全

- **位置**：`tools/builtin.py` `_WRITE_BLOCKED_DIRS`
- **改动**：`("config","core","tools","social","tests")` 扩面至 sidecar/shared/gui/scripts/
  runtime/linux/windows/gateway-ts/core-ts，与 TS 侧 `PROTECTED_SOURCE_DIRS` 对齐。
- **原理**：原名单漏掉 `shared/openapi.yaml`（双端契约单源）与 `sidecar/*.py`，
  Agent 覆写契约会污染双端。

### 顺带修复：1 条非幂等测试

`tests/core-ts/sandbox.spec.ts`「审计落盘 JSONL」断言文件恰好 2 行，但失败时残留文件、
后续运行累加必挂。开头补 `rm` 幂等化（这正是本轮全量测试一度 10 连挂的根因，非代码回归）。

### 验证矩阵

| 项 | 结果 |
|---|---|
| 全仓 `tsc -p tsconfig.base.json --noEmit` | 0 错误 |
| `npx vitest run`（56 文件，含 7+11+4 条新回归） | **852/852 全绿** |
| `py -m pytest tests/test_tools.py` | **76/76** |
| `py -m pytest tests/test_security_policy.py` | **5/5** |

> 未修：MCP OAuth 2.1 的 TS 移植（Python 侧已有完整 RFC 8252+PKCE 实现，
> TS 侧为 stub）——工程量大，列入路线（见 §3）。

---

## 2）架构层面的优化建议及理由

### 2.1 拆解 `gui/src/main/index.ts` 上帝文件（最优先）

**现状**：单文件约 3600 行，承载 70 个 IPC handler + TraceRecorder + planStore +
会话管理 + 群聊编排 + 权限弹窗 + Git + 终端 + 下载器接线。每个新功能都往这里堆。

**建议**：按域拆分为 `main/ipc/*.ts`（chat.ipc / git.ipc / workspace.ipc / stats.ipc /
plan.ipc / trace.ipc）+ `main/services/*.ts`（SessionManager / TraceStore / PlanStore）。
每个 ipc 文件只负责参数校验与转发，业务留在 core-ts。

**理由**：① main 进程任何异常=全应用崩（本轮 3 处崩溃点都出自这里），文件越大爆炸半径
越难控；② 拆分后才能对单域做单测——目前 main 层几乎零测试覆盖，所有质量保障都压在
core-ts 层；③ 拆分时把 32 处无 `isDestroyed()` 守卫的 `webContents.send`、16 个绕过
sender 白名单的裸 `ipcMain.handle`、无界 Map（traceStore/planStore）一并收编。

### 2.2 明确双栈终局：TS 为唯一引擎，Python 收敛为 CLI/服务端薄壳 ✅ 已落地（短期项）

**现状**：TS 与 Python 双栈语义平行实现（executor/sandbox/guardrails 各一份），行为对齐
靠人肉+测试维持。本轮"写入保护回归"就是双栈漂移的实锤——Python 有目录保护、TS 没有。

**建议**：① 短期——把安全类清单（保护目录、敏感文件、命令黑名单）收敛到 `shared/`
单一来源，双端各自 import 同一份 JSON，杜绝再漂移；② 中期——冻结 Python 引擎语义演进，
新能力只在 core-ts 落地；Python 侧的 slime_server/slime_cli 改为经由 core-ts（或契约层）
复用逻辑，不再平行实现。

**落地**：短期项已完成——`shared/security-policy.yaml`（单一来源）+ `scripts/gen_security_policy.py`
（生成 `shared/gen/security-policy.ts` / `.py`，`--check` 幂等）；core-ts `classifier.ts` /
`builtin.ts` 与 Python `tools/builtin.py` 三处硬编码副本全部改为 import 同一来源，并由
`tests/test_security_policy.py`（5 条）跨栈锁死「漂移即挂」。中期项按计划冻结。

**理由**：双栈平行的成本不是"写两遍"，而是"每处安全语义都要记得改两遍"——漏一处就是
安全洞。业界没有成功案例长期维持两套全功能引擎。

### 2.3 记忆系统已对齐前沿，补三个小件 ✅ 已落地

**现状**：三层记忆（working/episodic/semantic）+ 实体图谱 + consolidation 调度 +
艾宾浩斯权重——这正是 2026 年 Letta/LangMem 学派的落地形态，方向完全正确，不用改架构。

**建议补强**（都是小工程）：
- **provenance（溯源）**：每条记忆带 `source/confidence/created_at` 字段。前沿共识是
  "记错比不记更糟"（bad memory compounds faster than bad prompts），溯源是纠错的前提。
- **遗忘策略显式化**：目前 decay 靠权重衰减排序，但没有"硬遗忘"出口。提供
  `memory_forget`（按 id/按主题/按时间段删除）——也是数据合规的基本要求。
- **Agent 自助记忆工具**：目前记忆写入是引擎提取式（post-process），Agent 自己无法
  主动记/改/删。Letta 的核心洞察是"让 Agent 用工具管自己的记忆"（memory_insert/
  memory_search/memory_replace）。slime 已有 `plan_create/plan_update` 工具先例，
  照搬接线即可。

**落地**：三件全完成——① `MemoryFact` 增 `source/confidence/created_at` 溯源字段，
`storeCategorized` 夹取并落盘、load 时对老数据补填；② `MemoryStore.forget({ids,topic,before})`
硬遗忘出口（按 id/主题/时间并清理 links/backlinks 悬空引用）+ `search()` 检索方法；
③ `memory_insert / memory_search / memory_forget` 三工具注册进内置注册表，经
`setMemoryStoreProvider` 注入（对齐 `setSubagentManager` 模式），工具循环对 memory_* 工具
注入 `_agent_id` 定位当前 Agent 记忆（模型不可伪造）。回归 `tests/core-ts/memory-tools.spec.ts`
（11 条）。

### 2.4 给 Agent 运行加预算护栏（budget-aware）✅ 已落地（引擎/工具循环层）

**现状**：`TOOL_MAX_ROUNDS=500` 是唯一硬上限；无 token 预算、无墙钟预算、无单工具超时。

**建议**：engine 增加 `{ maxTotalTokens, maxToolCalls, maxWallClockMs }` 可选预算，
超限优雅收尾（保留已产出内容 + 如实说明"预算耗尽"）；GUI 右侧栏加预算进度条。

**落地**：引擎/工具循环层完成——`ToolLoopOptions/StreamOptions` 与 `ChatEngineCall` 增三项
可选预算；`ToolLoop.run/runStream` 每轮累计工具次数/token（种子消息 + 工具结果 + 正文 +
思考），第 2 轮起任一超限即熔断，返回 `budgetExhausted=true` + `budgetReason`，已产出内容
保留、末尾附诚实预算提示（不进 `raw` 的丢弃路径）。engine `chat()/stream()` 透传三项。
回归 `tests/core-ts/tool-budget.spec.ts`（4 条）。GUI 预算进度条为可选延后项（未做）。

**理由**：Anthropic 多智能体研究系统复盘的核心结论之一是 token 消耗解释 80% 的性能
方差、多 Agent 是 15 倍 token 成本——没有预算护栏的 Agent 平台在生产上就是账单事故
和失控轮次的发源地。这与 slime 现有的"绝不虚报成功"幻觉护栏是同一哲学：给自治划界。

### 2.5 治理面：把 AGENTS.md 的 Git 契约接到运行时

**现状**：AGENTS.md 定义了分支命名/提交粒度/QA 门禁/trailers，但它是给人读的约定，
运行时没有强制层。

**建议**：core-ts 的 git 工具在 commit 前做 lint gate（分支名校验、message 格式、
受保护模块二次确认、单提交 diff 行数上限），不通过直接拒绝。

**理由**：slime 的差异化卖点就是"多 Agent 自治但可追溯"，契约写进文档不如写进工具层。
这也是把"Agent 不冒充人类作者"的身份铁律从承诺变成机制。

---

## 3）建议新增的功能清单及其价值

按投入产出排序，均可结合现有模块落地，无空中楼阁：

| # | 功能 | 价值 | 依托现状 |
|---|---|---|---|
| F1 | **任务预算护栏**（token/工具调用/墙钟三上限 + 超限优雅收尾）✅ 已落地（GUI 预算条延后） | 防账单事故与失控轮次；让"自治"可托付 | engine 选项 + 已有 usage 统计链路 |
| F2 | **Agent 自助记忆工具**（memory_insert / memory_search / memory_forget）+ 记忆溯源字段 ✅ 已落地 | 从"引擎替你记"升级为"Agent 自己管记忆"；记错可纠正；合规有删除出口 | memory/store 三层已就绪，照搬 plan_create 工具接线模式 |
| F3 | **MCP OAuth 2.1 TS 移植**（复用 Python `core/mcp_oauth.py` 已验证逻辑 + Electron loopback） | 兑现 README 宣称的能力；远程 MCP 服务器（GitHub/Notion 等）才能接入 | Python 侧实现可作行为参照，验收用例可平移 |
| F4 | **会话检查点与回退 UI**（checkpoint 列表 + "回到这条消息之前"一键还原文件与上下文） | Agent 改错时的后悔药；Python 侧 checkpoints.py 已有机制，只差 TS 化与 UI | core/checkpoints.py 语义可参照，GUI 有现成消息列表挂载点 |
| F5 | **Agent 结果评测台**（内置任务集 + 定期跑分 + 趋势图，Letta Evals 思路） | 837 个单测保"代码不挂"，评测台保"Agent 变聪明不变蠢"；每次改 prompt/引擎后量化对比 | StatusPanel 已有图表与轮询基建；tasks 目录可承载任务集 |
| F6 | **子 Agent 权限收窄声明**（spawn 时可指定 permissionMode，如只读 plan 模式） | 配合本轮修好的继承语义，让"子代更严"可表达——对齐 Claude Code subagent frontmatter | sandbox 按 Agent 覆盖配置的机制已存在，只缺 spawn 参数透传 |
| F7 | **审计日志查看器**（GUI 面板：按 Agent/动作/状态筛选，异常事件高亮） | 安全事件看得见才用得上；本轮已把审计数据修可靠，就差消费端 | queryAudit/getAuditSummary API 已就绪 |

> F1/F2 是我认为最该先做的两个：一个管住成本与失控，一个放大 slime 最核心的
> "记忆长存"差异化。

---

## 4）参考的前沿设计灵感来源

| 来源 | 借鉴点 | 用在哪 |
|---|---|---|
| **Anthropic《Building Effective Agents》+ 多智能体研究系统复盘** | token 解释 80% 性能方差；多 Agent=15 倍 token 成本，只在"广度优先并行检索/超单窗口/多复杂工具"三类场景才划算；编排者委派必须给明确任务边界 | F1 预算护栏；Swarm 已是 orchestrator-workers 形态，验证了路线正确 |
| **Anthropic 多 Agent 协调五模式**（Generator-Verifier / Orchestrator-Subagent / Agent Teams / Message Bus / Shared State） | 大多数场景从 Orchestrator-Subagent 起步，观察瓶颈再演进 | slime 现状（Swarm+merger）正处于第二模式；群聊 brainstorm 实质在向 Shared State 演进，可用其"反应性循环"失败模式审视 |
| **Cognition《Don't Build Multi-Agents》** | 多 Agent 失败根因是交接丢上下文 | slime 的 merger+claims 幻觉护栏正是对这个问题的正面回应，值得坚持 |
| **Claude Code subagents 官方文档** | 子代权限 ⊆ 父代、父代运行时授权不传播、permissionMode 可按子代理声明 | §1.2 修复的直接依据；F6 的样板 |
| **Letta/MemGPT（~22K star）** | OS 式三层记忆；**Agent 用工具自管记忆**（memory blocks + core_append/replace）；sleep-time compute | F2 的直接样板；slime 三层+图谱已对齐其形态，差的只是"自助工具"这层 |
| **2026 AI Memory 六大学派综述（Zep/Graphiti/Mem0/Letta 等）** | "记错比不记更糟"；provenance + 定期 consolidation + 人工纠正是防错三件套；名字空间记忆（per agent/user/project）+ 显式交接协议 | F2 溯源字段与遗忘出口；slime 已按 Agent 隔离记忆（做对了） |
| **Graphiti 的 entropy-gated 实体去重** | 经典 IR 先行、低置信才调 LLM——把"每次写都是一次 LLM 调用"降到可规模化 | slime 实体图谱建边时可用同样思路降本 |
| **MCP 官方授权规范（OAuth 2.1 + PKCE S256 + RFC 9728/8414 发现链）** | 桌面客户端标准姿势：动态注册 + 系统浏览器 + loopback 回调 + token 缓存 | F3 的实现规格；Python 侧已符合规范，TS 照抄即可 |
| **Karpathy「Context Engineering」** | 上下文是系统工程：每轮该放什么、为什么放 | 印证 A-969 压缩方案（摘要+硬上限降级）方向正确；F1 预算条是其延伸 |

---

> 关联文档：`docs/AUDIT-2026-09-08.md`（缺陷审计与修复状态）、
> `docs/REVIEW_AGENT.md`（功能迭代史 A-001~A-969）。
