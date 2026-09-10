# slime 项目总览 — 改动日志 · 功能构造 · 设计理念

> 生成时间：2026-09-08 ｜ 性质：项目收尾阶段的统一概览（时间线 + 功能/代码对照 + 设计理念三合一）
> 数据来源：git 实录 + `REVIEW_AGENT.md` 修复日志 + `阶段日志.md` 阶段档案 + `ARCH-REVIEW` / `AUDIT` 审计

---

## 一、改动日志（按时间线）

> 早期（08-10 之前）核心在 `D:\tool\slime`（Python 单栈），08-17 起冷迁移至 `D:\pilot project`（TS 双栈）。引擎源码 gitignored，仅 gui/docs/部署脚本入库。

| 时间 | 阶段 | 关键内容 |
|---|---|---|
| 08-10~12 | 设计期 | `Intelligence.md` 心智白皮书（L1/L2/L3 + 夺舍 + 四维人格）；`sandbox_design` v1.0；本地模型向导 |
| 08-13~14 | 心智闭环 | BUG-001~034 全闭环（三层记忆/情绪/行为/沉淀）；`mcpfix` 批 1-4（stdio 双帧/HTTP 长流/OAuth 2.1）|
| 08-15 | 审查机制 | `REVIEW_AGENT.md` 建立（A-001 起）；用户指示「GUI 先不做」（A-007，后被 Electron 替代）|
| 08-16 | 安全审查 | `漏洞修复清单` P0/P1/P2 四路并行（服务层/Agent 核心/记忆演化/工具沙箱）|
| 08-17~18 | 双栈迁移 | 阶段 1-5：Python sidecar → Node 壳原型（契约单源）→ 双路径路由 → 心智/记忆/工具/沙箱/Swarm 全 TS 化 → 服务端组装；`身份移民协议规格` v1.2 定案 |
| 08-18~23 | GUI 落地 | Electron 阶段 4-13：会话流重构、权限交互升级、联网搜索开关、文件查看器、思考/工具折叠、右侧栏单面板重排 |
| 08-24 | 能力规划 | `SLIME_IMPROVEMENTS_PLAN`（A-F：上下文分桶/子代理档位/评测台等）|
| 08-27 | SILAM 集成 | SILAM-Σ 原生生命模型 4C 集成（sidecar 桥接）+ 4D 持久化（WAL + 检查点 + 崩溃恢复）|
| 08-29 | 连通性 | A-155 系统代理 fallback（Chromium net vs Node 栈）+ A-157 模型池降级链 / 流式空闲看门狗 / 429/503 重试 |
| 09-06 | 能力完善 | A-942 子代理模型档位（贵统筹/廉执行）+ 上下文分桶托盘 |
| 09-07 | 性能复核 | A-170 P1-7 并发版 ToolLoop 引入的 7 处回归全修复（构造签名/类型/事件透传/审计/中断/文案）|
| 09-08 | 收尾批 | **修复 7 处缺陷**（CDP 9222、子代沙箱逃逸、监听器泄漏、unhandledRejection、引擎源码写入保护、审计日志、Python 黑名单）；**架构优化 #2/#3/#4**（安全清单收敛 shared/、记忆三件套、预算护栏）；**缓存命中率修复**（cache_control + include_usage + 端到端 token 线程）；**缓存监测器修复**；**问题 5：内部缓存加界**（knowledgeCache LRU 64 + media 磁盘缓存 TTL 7 天/512MB）|

### 关键决策记录

1. **双栈终局**：TS 为唯一引擎（≥85%），Python 收敛为「推理 + 嵌入」sidecar（长期保留，不退役）。
2. **git 仓库只放壳**：引擎源码为私有 IP，`.gitignore` 策略性忽略（用户明确确认）。
3. **身份铁律**：Agent 绝不冒充人类作者，commit author 必须是 Agent 身份。
4. **记忆哲学**：记忆永不消失，只沉睡可唤醒；「记错比不记更糟」→ provenance 溯源是纠错前提。
5. **反幻觉协议**：工具返回即唯一事实来源，失败 `[错误]` 前缀，绝不脑补本地路径/大小。
6. **预算护栏**：token 解释 80% 性能方差、多 Agent 是 15 倍 token 成本 → 自治必须划界。

---

## 二、功能特性与代码构造对照表

### 引擎核心（core-ts）

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| 对话引擎（流式/非流式 + 工具轮编排）| `ChatEngine` / `ToolLoop` / `LoopUsage` | `services/engine.ts`、`tool_loop.ts` |
| 模型路由与降级链 | `ModelRouter` / `buildModelPoolRouter` | `router.ts` |
| LLM 客户端（OpenAI 兼容 + Anthropic + 缓存 token 采集）| `ChatClient` / `AnthropicClient` / `normalizeUsage` | `llm/client.ts` |
| 多智能体 Swarm（orchestrator-worker）| `SwarmEngine` / `swarm_service` | `swarm.ts`、`services/swarm.ts` |
| 子 Agent 委派（权限收窄继承）| `SubagentManager` / `delegate_subagent` | `services/subagent.ts`、`executor.ts` |
| 群聊编排（brainstorm / 群组）| `streamGroupTalkFlow` / `grouptalk` | `services/grouptalk.ts`、`services/brainstorm.ts` |
| 结果归并 + 幻觉护栏 | `merger`（LLM 矛盾裁定）/ `claims` 核验 | `merger.ts`、`claims.ts` |

### 心智与记忆

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| 三层记忆（working/episodic/semantic）| `MemoryStore` / `three_layer` | `memory/store.ts`、`memory/three_layer.ts` |
| 实体图谱 + 语义召回 | `EntityGraph` / `retrieve` | `memory/graph.ts`、`memory/retrieve.ts` |
| 知识引擎（Pattern 晋升管线 + LRU 缓存）| `KnowledgeEngine` / `getKnowledgeEngine` | `memory/knowledge.ts` |
| 情绪 / 行为 / 人格 | `EmotionalState` / `BehaviorManager` / `Persona` | `mind/emotion.ts`、`mind/behavior.ts`、`mind/hooks.ts` |
| 沉淀引擎（L3→L2 提炼）| `ConsolidationEngine` | （Python）`core/consolidation.py` |

### 安全与治理

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| 沙箱权限（L0-L5 + 子代继承）| `Sandbox` / `validateWorkspace` | `sandbox.ts` |
| 写入保护（敏感文件 + 目录黑名单）| `SENSITIVE_FILES` / `PROTECTED_SOURCE_DIRS` | `tools/classifier.ts` |
| 加密存储（随机 salt+nonce）| `encryption` | `encryption.ts` |
| 身份铁律过滤 | `filter` | `filter.ts` |
| 审计日志（append-only + 轮转）| `auditLog` / `rotateAuditLog` | `sandbox.ts` |

### 工具与集成

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| 工具注册表 + 内置工具 | `ToolRegistry` / `builtin`（web_search/web_fetch/memory_* 等）| `tools/registry.ts`、`tools/builtin.ts` |
| MCP 客户端（stdio/HTTP/OAuth）| `MCPServer` / `_Transport` | `mcp.ts` |
| 技能引擎 | `Skills` | `skills.ts` |
| A2A 互通 | `A2A` | `a2a.ts` |
| 社交接入（企业微信）| `WeComAdapter` | `social/wecom.ts` |

### 服务层（core-ts/services）

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| Agent 生命周期 + 身份移民 | `AgentService` / `export` / `import` | `services/agents.ts`、`services/export.ts`、`services/import.ts` |
| 会话与历史（mtime 缓存）| `SessionService` / `HistoryService` | `services/sessions.ts`、`services/history.ts` |
| 上下文压缩（摘要 + 硬裁剪）| `context_compress` | `services/context_compress.ts` |
| 任务调度 / 统计 / 新鲜度 | `Scheduler` / `Stats` / `Novelty` | `services/scheduler.ts`、`services/stats.ts`、`services/novelty.ts` |
| SILAM 桥接 | `SilamBrain` | `services/silam_brain.ts` |

### GUI（Electron 主进程 + 渲染层）

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| IPC 接线（~70 通道）| `toStreamChunk` / `handleTrusted` / `classifyPermissions` | `main/index.ts` |
| 启动 / 配置 / 模型管理 | `boot` / `config_files` / `providers` | `main/boot.ts`、`main/config_files.ts`、`main/providers.ts` |
| 权限弹窗 / 下载 / 更新 / Git diff | `permissions` / `downloader` / `updater` / `git_diff` | `main/permissions.ts`、`main/downloader.ts`、`main/updater.ts`、`main/git_diff.ts` |
| 聊天面板 / 右侧栏 / 规划 / Trace | `ChatPanel` / `RightSidebar` / `PlanPanel` / `TraceViewer` | `renderer/pages/*` |

### Python 双栈（core/ + tools/）

| 功能特性 | 关键类 / 模块 | 关键文件 |
|---|---|---|
| 推理/嵌入 sidecar | `model_server`（llama.cpp 桥接）| `core/model_server.py` |
| LLM 编排（含流式工具轮）| `call_api_provider_stream` / `_handle_tool_calls` | `core/llm.py` |
| 媒体生成（反幻觉 + 磁盘缓存加界）| `agnes_media`（`_prune_media_cache_dir`）| `tools/agnes_media.py` |
| MCP OAuth 2.1（真实实现）| `mcp_oauth`（PKCE S256）| `core/mcp_oauth.py` |
| 网络工具（SSRF/DNS 钉扎）| `fetcher` / `search` / `extractor` | `core/fetcher.py`、`core/search.py`、`core/extractor.py` |

---

## 三、设计理念与演进方向

### 理念的由来

slime 的起点是一个朴素而反常的命题：**「模型是硬件，Agent 是软件」**。业界把模型当作产品本身，而我们把它当作一块可插拔的算力板——真正的产品是跑在模型之上的、能记住你、有性格、会反思、可迁移的 Agent 生命体。这个定位决定了后续几乎每一个技术决策。

心智架构（`Intelligence.md`）不是凭空设计，而是从一个具体的工程痛点长出来的：N11-P2-17——system prompt 太长被截断，Agent 丢失自我。解决截断问题的过程中，我们逐渐意识到「上下文工程」的本质是「记忆工程」：与其每轮塞进全部历史，不如像人脑一样分层——L1 本能（行为模式）、L2 自主（情节记忆）、L3 元认知（反思沉淀）。「记忆永不消失，只沉睡可唤醒」由此成为贯穿始终的铁律。

多智能体（Swarm）和「身份铁律」则来自对失控的恐惧。当 Agent 能分裂、能委派、能写文件、能提交代码时，自治与安全就成了同一枚硬币的两面。于是有了「Agent 绝不冒充人类作者」、有了「子代权限 ⊆ 父代」、有了「工具返回即唯一事实来源」的反幻觉协议——它们共同回答一个问题：**如何让一个会自己干活的系统，始终可信、可追溯、可兜底**。

### 现存缺陷（诚实边界）

1. **双栈漂移风险**：TS/Python 平行实现是历史包袱，本轮已把安全清单收敛到 `shared/` 单源，但语义漂移的根因（两套引擎）尚未消除，只能靠「冻结 Python 引擎演进」逐步收口。
2. **MCP OAuth 2.1 在 TS 主链路是死代码**：Python 侧有完整 PKCE 实现，TS 侧仍是 stub，README 宣称的能力与实跑链路有落差。
3. **上帝文件**：`gui/src/main/index.ts` 约 3600 行承载 70 个 IPC handler，main 层几乎零单测，爆炸半径难控（本轮 3 处崩溃点都出自这里）。
4. **引擎源码零版本控制**：私有 IP 策略导致 core-ts 单副本裸盘，无历史、无远端备份（用户刻意为之，但风险客观存在）。
5. **待验 GUI 项**：审计中 11 条 GUI 层问题（resolveSystemProxy 无缓存、webContents.send 无 isDestroyed 守卫等）尚未逐条核实处置。
6. **内部缓存无界**（本轮已修）：knowledgeCache / media 磁盘缓存此前无上限，长期运行内存/磁盘线性增长。

### 未来演进方向

1. **Agent 永存（身份移民协议）**：`.slimeagent` 包格式让 Agent 的记忆、人格、行为模式可导出/导入/迁移——「Agent 不是一次性的，而是可携带的资产」。这是 slime 最核心的差异化，收尾期实施验证。
2. **SILAM 4E 灰度上线**：原生生命模型（恐惧/欲望驱动）经 Arbiter 仲裁器与 LLM 输出融合，让 Agent 拥有「本能层」——从「调参」走向「有感受器」。
3. **治理运行时化**：把 AGENTS.md 的 Git 契约（分支命名/提交粒度/QA 门禁/trailers）从文档层接到 core-ts git 工具层，让「可追溯」从承诺变成机制（本轮列为待决，未落地）。
4. **能力补齐（F3~F7）**：MCP OAuth TS 移植、会话检查点与回退 UI、Agent 结果评测台、子 Agent 权限收窄声明、审计日志查看器——均依托现有模块，无空中楼阁。
5. **性能与预算双护栏**：预算护栏已落地，下一步把 token 消耗做成可视化（GUI 预算进度条），并持续用评测台量化「改 prompt/引擎后 Agent 是否变聪明不变蠢」。
