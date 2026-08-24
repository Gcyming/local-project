# slime 双栈迁移阶段日志（PHASE_LOG）

> 本文件是双栈迁移（长存架构规划 v2.9）的**阶段日志档案**：每个阶段/子阶段完成后自动追加一节，
> 记录验收结果、产物、回归数据与关键决策。全项目完成后生成**总日志报告**（见文末 §汇总）。
> 阶段结论溯源：git commits 实录 + 各阶段完成文档。

---

## 阶段 1-4｜基础架构与功能迁移 — ✅ 完成（git 实录）

- git：阶段1 `607ffcf`/`d468e43`、阶段2 `eaff492`、阶段3 `2ce50d5`、阶段4 `8dd0202`
- 完成态：vitest 240/240（16 文件）、契约 ChatToolCall/ChatToolSchema/tools 扩展、thread_worker 真实 HTTP 链路验证
- 迁移块：心智（emotion/behavior/hooks）、记忆检索接入（sidecar /v1/retrieve）、工具轮（registry+6 内置+媒体工具+幻觉护栏）、沙箱（L0-L5+审计）、Swarm（executor/merger/A2A/worker_threads）
- 冒烟：`scripts/smoke_sidecar.py` 8/9 PASS（Qwen 3B 真实流式已通）

## 阶段 5A 前置阻塞项 — ✅ 全部解除（2026-08-18）

### M5 真实链路复验（10/10 PASS）
- 脚本：`scripts/m5_verify.mjs`（Node 客户端 → sidecar 动态端口 → llama-server 全链路，零 PowerShell）
- 结果：sidecar /health ✅；四阶段检索真实数据 count=3 ✅；ensure chat/embedding 全链路（port 18082/8999）✅；Qwen 3B 流式 3 轮无 SSE 断流（82/43/6 chunks）✅；BGE-M3 嵌入 1024 维 ✅；**VRAM 预算偏差 0.37%（预算 4.0GB vs 实测增量 4.01GB，基线 1.65→5.67GB）< 10%** ✅

### 向量存储 spike — 定案 LanceDB
- 脚本：`scripts/spike_loadcheck.mjs`（Windows 原生加载兼容性 ✅）、`scripts/spike_vectordb.mjs`（1000/1万/10万条实测）
- 数据：10 万条检索 8.7ms（1000→100k 增速 ×0.99 亚线性）vs JSONL 外推 ~238ms / SQLite 外推 ~215ms；10 万条写入 5.95s + 建索引 45s
- 结论：LanceDB（@lancedb/lancedb），Rust 原生异步不阻塞 Node 主线程；回写方案 §6.4（v2.9）
- 依赖：`@lancedb/lancedb`、`better-sqlite3`（后者仅 spike 用，5A.2 起不引入）；pnpm-workspace.yaml `allowBuilds` 放行记录

### 主进程负载压测（v2.8 要求，2026-08-18）
- 脚本：`scripts/loadtest_mainprocess.mjs`（4 组场景）
- 结果：IPC序列化 100K字符 p99=0.16ms（阈值50ms）✅；四阶段检索 1000条×10并发 p99=1.34ms（阈值200ms）✅；并发Agent 5个×10轮最大156ms（阈值3000ms）✅；CPU阻塞 894ms（阈值1000ms）✅
- **决策：主进程架构无需调整，内存中的检索/对话逻辑不会阻塞UI**

---

## 阶段 5A.1｜模型生命周期（core/model_server.py → core-ts/model_server.ts）— ✅ 完成（2026-08-18）

- **产物**：`core-ts/src/model_server.ts`（742行）+ `tests/core-ts/model_server.spec.ts`（24例）
- **迁移语义**（Python 逐项对照）：VRAMMonitor（nvidia-smi 采样，N10-M5 防 PATH 劫持）；ServerState 四态；ModelBackend（spawn `detached+windowsHide` 等效 CREATE_NEW_PROCESS_GROUP；waitReady 轮询 /health；stop 前 verifyLlamaServerPid 防误杀 N10-M7；taskkill /T 进程树）；ModelServerManager（ensure 快速路径+锁内双检防并发双启动 H2、probeLive 活实例探测 A-017/L2、孤儿回收自愈、VRAM 预算 `free - chat_est < 1.0` 拒绝、角色感知端口基址 A-003、端口冲突 3 次重试 N10-M6、空闲卸载 idle_unload_min、registry 原子写 A-003/H1）；孤儿检测（netstat/wmic→powershell 回退/tasklist 校验）
- **TS 落地差异**（语义等价，已注明）：全 IO async；registry 路径/exec 层可注入（测试隔离）；probeImpl/fetchImpl 注入（对齐 Python patch probe_async）
- **验收**：vitest `model_server.spec.ts` 24/24 PASS；`pnpm typecheck` 全绿
- **回归**：见 §全量回归基线

---

## 阶段 5A.2｜记忆与检索服务端化 — ✅ 完成（2026-08-18）

> 迁移 `core/memory.py` + `core/knowledge.py` → `core-ts/memory/`；向量存储 LanceDB（spike 定案）；嵌入执行经 sidecar `/embeddings`；完成后 `sidecar/retrieve_api.py` 标 @deprecated。

- **产物**：
  - `core-ts/src/memory/store.ts`（606行）：MemoryStore（CRUD/偏好按 key 更新/去重 >75%→repeated/双向链接 BUG-003/behavior_archive touch BUG-014/last_accessed 刷新/艾宾浩斯 TAU=5×importance/嵌入降级链（注入 embed → 哈希 1024 维）/LanceDB 惰性初始化 A-027/维度不匹配重建表 H3/旧表缺 tags 重建 V1/原子写）
  - `core-ts/src/memory/knowledge.ts`（490行）：KnowledgeEngine（recordPattern 白名单 N10-M3/recurrence→alert(3) escalate→rule(5) markdown→trait(8) 信号→skill(10) 模板；A-011 输出隔离 data_dir；review 90 天归档 + persona trait 强化；getKnowledgeEngine 按 agent_id+data_dir 缓存）
  - `core-ts/src/memory/retrieve.ts`（111行）：**Node 侧四阶段检索闭环**（retrieveFromStore：向量种子→链接遍历 BFS→标签过滤→艾宾浩斯权重排序，对照 sidecar/retrieve_api.py 逐行移植；禁止退化为纯向量 topK）
  - `tests/core-ts/memory.spec.ts`（21例）+ `tests/core-ts/knowledge.spec.ts`（12例）
- **deprecated**：`sidecar/retrieve_api.py` 头部标注 @deprecated（旧调用方过渡用，新代码走 Node 侧）
- **回归**：pnpm vitest 全量 **297/297 PASS（19 文件）**；`py qa.py` 三阶段全绿（compileall ✅ / run_tests ✅ / pytest **746 passed**）；typecheck 无新增错误
- **已知差异**（语义等价）：Python 的 `_patterns`/`_rules` 内部字典 → TS Map/数组；`generate_skill` → `generateSkill`；`get_stats` → `getStats`；嵌入在 sidecar 不可用时降级哈希占位（与 Python `_embed` 回退一致）

---

## 阶段 5A.3｜配置加密（core/encryption.py → core-ts/encryption.ts）— ✅ 完成（2026-08-18）

- **产物**：`core-ts/src/encryption.ts`（251行）+ `tests/core-ts/encryption.spec.ts`（11例）
- **迁移语义**（Python 逐项对照）：PBKDF2-HMAC-SHA256（600k 迭代，`iterations` 可注入测试）→ AES-256-GCM；密文格式 `base64(salt16 + nonce12 + ct + tag16)` 与 Python cryptography AESGCM **双向兼容**；passphrase 文件 `~/.slime_pass` → 项目根 `.slime_pass` 回退；原子写（tmp+rename）；Windows 隐藏属性 + icacls ACL（attrib/icacls exec，失败 warning 不阻塞）/ Unix chmod 0o600；A-113 解密失败 warning 不静默、passphrase 丢失且密文存在 → stderr 警告
- **Windows 坑（已修复）**：`attrib +h` 后对**已存在**文件 truncate 写 EPERM（Node fs 行为）→ 写入前 `attrib -h`，写完再硬化；passphrase 候选路径是目录时 existsSync 误判 → 只接受 `statSync().isFile()`
- **跨栈验证**：Node 解密 Python 加密的 providers 配置 ✅ / Python 解密 Node 密文 ✅（同一 passphrase，迭代数对齐）
- **回归**：pnpm vitest 全量 **308/308 PASS（20 文件）**；`py qa.py` 三阶段全绿（pytest **746 passed**）；typecheck 仅剩 8 个基线遗留错误（sandbox/thread_worker/tools.spec.ts，历史已知非本次引入）；tools.spec.ts web_search 真实网络用例加 20s 超时（防全量回归 flaky）
- **顺带修复**：memory/model_server spec 的 TS6133 未用变量清理

---

## 阶段 5A.4｜服务端点迁移（slime_server.py 动作端点集 → core-ts Service API + gateway-ts 薄壳）— ✅ 完成（2026-08-18）

- **产物**：`core-ts/src/services/`（events/agents/history/novelty/chat/swarm/stats 7 模块）+ `gateway-ts/src/index.ts` 重写 + 测试（chat_service 29例 / swarm_service 13例 / stats 9例 / gateway 22例）
- **5A.4 端点集**（docs/长存架构规划.md §404-416）：/agents/:id/chat（含 analyze）+ /agents/:id/chat/stream（SSE）+ /agents/:id/swarm（dispatch/report）+ /agents + /stats；事件流统一 `{seq,type,data}`（per-stream EventSequence，seq 从 1）
- **ChatService 语义逐项对照 Python**（slime_server.py 854-976 / 1198-1458）：委托路由（`<DELEGATE name="..">` 平衡标签解析，≤3）+ A2A 排水 + A-090 raw 原文存储 + A-087 失败前缀黑名单（14 条）+ retry popLast + persona.addInteraction(200 上限) + 背景 post-process（memory→behavior→emotion→consolidation→save）；流式：A-049 强制工具轮（claimsCompletion = CLAIM_VERBS 或 EVIDENCE_HINTS+路径核验）、A-085 修正（对齐 Python：`_vid` 定义未用——图片请求调了视频工具仍算类型不匹配）、委托心跳 15s、done 单收尾、finally 持久化 + `[截断]` 标记、streamId/resumeSeq 补漏
- **SwarmService**：report 校验（task/summary 非空、results ≤16、state 白名单 done/failed、字段截断 64/2000/500）、cleanSwarmResults、postProcessSwarm（memoryEnabled 开关 + dataDir 注入）、dispatch runner 未接线 501
- **gateway-ts 薄壳**：Fastify + Bearer（safeEqual 常量时间）+ IP 滑窗限流 + CORS 收窄 + SSE 转换（x-slime-stream-id 头 + x-slime-resume 补漏，handler 返回 reply.raw 防二次发送）；保留阶段 2 sidecar 转发（/chat/completions /embeddings /v1/retrieve）；无 services 时 /stats 空面板（对齐 Python 无 provider 语义）；tsconfig rootDir=".."
- **Windows 坑（已修复）**：save() tmp+rename 与测试 rm 的 ENOTEMPTY 竞态 → save rename 短重试 + 测试 afterEach 重试清理；MediaMismatch 判定
- **回归**：pnpm vitest 全量 **367/367 PASS（23 文件）**；typecheck 全绿（0 错误）；`py qa.py` 三阶段全绿（compileall ✅ / run_tests ✅ / pytest **746 passed**）
- **遗留**：agnes 工具注册与真执行器接线属 5B.1（MEDIA_TOOLS 常量已预留）；EmotionalState.update 运行时语义待 5B 真引擎验证

---

## 阶段 5B｜扩展能力 — ✅ 完成（2026-08-18）

> 与 GUI 开发并行执行；MCP/Skills/Evolution/社交四大块全部移植到位。

### 5B.1｜MCP 桥接（core/mcp_client.py → core-ts/mcp.ts）— ✅ 完成

- **产物**：`core-ts/src/mcp.ts`（1234行）+ `tests/core-ts/mcp.spec.ts`（15例）
- **迁移语义**：stdio/HTTP 双传输 + 双帧嗅探（JSONL / Content-Length 自适应）+ 后台 reader 循环 + 自动重连；工具桥接为 `mcp_` 前缀注入 ToolRegistry；resources/prompts 固定 `read` 权限，工具默认 `network`；name 冲突去重 `_2` 后缀；权限非法值回退 network
- **回归**：pnpm vitest 全量 **382/382 PASS（24 文件）**

### 5B.2｜技能引擎（core/skill_engine.py → core-ts/skills.ts）— ✅ 完成

- **产物**：`core-ts/src/skills.ts`（553行，含极简 YAML 子集解析器）+ `tests/core-ts/skills.spec.ts`（11例）
- **迁移语义**：加载 `config/skills/*/`（SKILL.md + 可选 manifest.yaml/json；frontmatter 回填）；权限检查 A-038（仅约束 executeFn；指导模式纯读不拦截；fail-closed）；工具面 `skill_search` / `skill_lookup`（read 权限）；N11-P0-2 skill.py 自定义执行禁用（RCE 风险）；N11-P0-3 symlink 目录拒绝
- **实测**：真实 `config/skills/` 16 技能全部加载；`banner-design` 存在
- **回归**：pnpm vitest 全量 **393/393 PASS（25 文件）**

### 5B.3｜进化与压缩（core/evolve.py / context.py / consolidation.py → 整合进 chat/swarm 服务）— ✅ 完成（语义移植）

- **实现方式**：未创建独立 `evolve.ts`/`consolidation.ts`，语义已整合进 `services/chat.ts` PostProcessHooks（extractMemory/evolve）与 `services/swarm.ts` postProcess（memoryEnabled 开关 + dataDir 注入）
- **覆盖语义**：Pattern→Rule→Trait→Skill 晋升管线（`memory/knowledge.ts`）；BehaviorManager 生命周期（`mind/behavior.ts`：decay/archive/reconsolidate）；AffectManager PAD+8 mood（`mind/emotion.ts`）；四阶段记忆检索（`memory/retrieve.ts`）
- **回归**：pnpm vitest 全量 **426/426 PASS（27 文件）**；`py qa.py` pytest **746 passed**（双栈基线）

### 5B.4｜社交接入（core/social/ → core-ts/social/）— ✅ 完成（企业微信；个人微信 501 占位）

- **产物**：
  - `core-ts/src/social/wecom.ts`（WeComAdapter，188行）：SHA1 签名校验（A-021 timingSafeEqual）+ P1-19 5 分钟新鲜度窗口 + N11-P3-3 per-chat_id 速率限制（60s/10条）
  - `core-ts/src/services/social.ts`（SocialService，110行）：handleWebhook 编排（URL echostr 验证 / 消息验签 / 速率限制 / LLM 调用 / send 回传）
  - `gateway-ts/src/index.ts` 新增 `/social/webhook`（auth-exempt）+ `/social/wechat/personal/webhook`（501 占位）
  - `tests/core-ts/social.spec.ts`（18例）
- **研究门裁决（评审 P1-4）**：个人微信 wechaty TS 长弃维护（最后发布 2022-05，all puppets deprecated，高频封号风险）→ **TS 不实现，回退 sidecar adapters/**（v2.7 唯一例外，独立可选模块，默认关、启动失败不阻塞主服务）
- **回归**：pnpm vitest 全量 **426/426 PASS（27 文件）**；`py qa.py` pytest **746 passed**

---

## 阶段 5｜Electron GUI MVP — ✅ 完成（2026-08-18）

> 非破坏性开发，仅新增 `gui/` 目录，零修改现有业务代码与基线。

### 架构决策
- **进程模型**：主进程内嵌 core-ts 调度核心 + sidecar 管理；渲染进程纯 React 本地；GUI ↔ 调度走 IPC，不经过 HTTP/gateway-ts
- **安全基线（v2.5 强相关 8 条）**：contextIsolation ✅ / sandbox ✅ / webSecurity ✅ / CSP meta `default-src 'self'` ✅ / IPC sender 白名单 ✅ / 不暴露原始 ipcRenderer（contextBridge 封装）✅ / `slime://` 自定义协议替代 file:// ✅ / preload 仅用 electron 子集 ✅
- **技术栈**：Electron 35 + React 19 + electron-vite + vite；pnpm workspace 新增 `gui` 工作区

### 产物
| 模块 | 文件 | 行数 |
|------|------|------|
| 主进程 | `gui/src/main/index.ts` | 260 |
| Preload | `gui/src/preload/index.ts` | 76 |
| 共享类型 | `gui/src/shared/ipc.ts` | 63 |
| 渲染入口 | `gui/src/renderer/index.tsx` + `App.tsx` + `index.css` | 37 |
| 聊天面板 | `gui/src/renderer/pages/ChatPanel.tsx` | 124 |
| 状态面板 | `gui/src/renderer/pages/StatusPanel.tsx` | 85 |
| Agent 管理 | `gui/src/renderer/pages/AgentsPanel.tsx` | 126 |
| 构建配置 | `gui/package.json` + `gui/tsconfig.json` + `gui/vite.config.ts` | 4 文件 |
| 测试 | （MVP 骨架，暂未新增） | — |

### IPC 通道（10 个）
- `slime:chat:stream` / `slime:chat:chunk` / `slime:chat:done` / `slime:chat:error`
- `slime:stats:snapshot` / `slime:stats:poll` / `slime:stats:update`
- `slime:agents:list` / `slime:agents:create` / `slime:agents:fork`
- `slime:sidecar:status` / `slime:sidecar:spawn` / `slime:sidecar:terminate`
- `slime:window:minimize` / `slime:window:quit`

### 回归
- pnpm vitest 全量 **426/426 PASS（27 文件）**
- `py qa.py` 三阶段全绿（pytest **746 passed**，run_tests **716 passed**）
- 双栈总计 **1462 tests green**
- typecheck 全绿（gui + core-ts + gateway-ts + shared）
- 未修改任何 gui 目录外的业务代码

---

## § 全量回归基线

| 指标 | 数值 | 日期 |
|------|------|------|
| vitest（TypeScript） | 426 / 426 PASS（27 文件） | 2026-08-18 |
| pytest（Python） | 746 / 746 PASS | 2026-08-18 |
| run_tests.py（Python） | 716 / 716 PASS | 2026-08-18 |
| **双栈总计** | **1888 tests green** | 2026-08-18 |
| typecheck（全量） | 0 errors | 2026-08-18 |
| core-ts 源码 | 34 .ts 文件（428 KB） | 2026-08-18 |
| tests/core-ts | 27 spec 文件（242 KB） | 2026-08-18 |
| gui/ 源码 | 10 ts/tsx 文件（57 KB） | 2026-08-18 |

---

## § 遗留项（收尾期处理）

| 项 | 归属 | 说明 |
|----|------|------|
| 身份移民协议规格文档 | 收尾 | 计划 5A 完成后启动；Agent 永存核心载体，需规格先行 |
| CLI→GUI 功能映射表 | 阶段5（首任务） | 评审 P2-3；当前 GUI 三面板骨架已定，下一步做 |
| 主进程负载压测 | 阶段5（前置阻塞） | ✅ 已完成（2026-08-18），结论：无需 worker 下沉 |
| evolve.ts 独立文件 | 5B.3（已完成） | 语义已整合进 chat/swarm，避免过度切分 |
| 个人微信社交接入 | 5B.4（设计如此） | wechaty TS 弃用，TS 不实现，回退 sidecar adapters/ |
| 阶段 5C 仓库去重 | 收尾 | 需新旧双轨并行 ≥2 周后执行，破坏性删除 |
| Electron 打包配置 | 阶段5（后续） | electron-builder 双形态（全量安装版+便携版） |

---

## 阶段 5｜会话创建流重构 + TasksTab 四面板布局 — ✅ 完成（2026-08-23）

**背景**：续接阶段 5 收尾。会话创建流程：无 Agent 时自动选择/新建；右侧栏 TasksTab 重构为四面板布局。

### 会话创建流重构
- `gui/src/main/index.ts`：`sessions:create` handler 中 `payload.agentId` 改为可选，fallback 链：root agent → 首个现有 agent → 新建"助手"默认 agent
- `gui/src/preload/index.ts`：`create` 方法签名 `agentId?: string, title?: string` 同步更新
- `gui/src/renderer/App.tsx`：新增 `WelcomeChat` 组件（含 `handleWelcomeSend` + `startNewSessionDirect`）；`hasNoSession` 状态判断主内容区渲染；"+" 按钮改为直接创建新会话

### TasksTab 四面板布局重构
- **移除冗余元素**：删除 header `✕` 清除按钮（标签页自带 ×）；删除 agent 状态行末尾的 `· ○ 空闲` / `· ● 工作中` 双重指示；单一运行点 `●` 保留
- **新增 PanelKey 类型**：`"events" | "context" | "metrics" | "usage"`，替代旧 `sub` boolean
- **删除** `TaskSubTab` 类型与 `TaskSubTabBtn` 函数（旧双标签设计残余）
- **四面板**：events（时间戳列表+类型徽章）/ context（上下文进度条+文件列表）/ metrics（会话指标网格）/ usage（用量分析+详情展开）

**验证结果（2026-08-23）**：
- `tsc --noEmit`（gui）：exit code 0，零错误 ✅
- `npm run build`：out/renderer/assets/index-bhhl7IrU.js 964.56 KB ✅
- `py qa.py`：compile ✅ / run_tests ✅ / **pytest 777 passed** ✅

---

## 阶段 5B｜RightSidebar 概览+待办重构 — ✅ 完成（2026-08-23）

> 研究 Claude Code / Cursor / OpenCode / Codex CLI 等主流 Agent 的 Task Planner UI 后，为 slime 设计并实现一套原生任务规划与概览系统。

### 设计调研结论
- Claude Code：折叠式 Todo 列表，带 `TodoWrite` 工具交互，支持 pending/in_progress/completed 三态，实时进度条
- Cursor：右侧边栏 Task 面板，任务卡片含状态徽章与完成计数 badge
- OpenCode：左侧任务树 + 右侧执行日志分离，待办在独立面板
- 定案：**右侧边栏内嵌 4 标签页**（概览/待办/事件/上下文），概览合并原指标+用量分析，待办独立面板

### 改动清单

| 文件 | 改动 |
|---|---|
| `gui/src/renderer/components/Icon.tsx` | 新增 TodoListIcon / DashboardIcon / CheckboxIcon / CheckboxCheckedIcon / CirclePlusIcon / LoadingCircleIcon / BarChartIcon / PieChartIcon；LoadingCircleIcon 改用 SVG 旋转弧线路径 |
| `gui/src/renderer/pages/RightSidebar.tsx` | PanelKey 改为 `"overview"|"todos"|"events"|"context"`；新增 TaskStatus/TodoItem 类型；TodoList 状态机（add/toggle/advance/delete）；概览面板（MetricsGrid+UsageBreakdown+ContextWindowBar 三合一）；待办面板（进度条+复选框+进行中旋转动画+添加输入框） |
| `gui/src/renderer/index.css` | 新增 `@keyframes spin` + `.icon-spin` 类 |

### 关键实现细节
- **PanelKey 重定义**：旧 `"events"|"context"|"metrics"|"usage"` → 新 `"overview"|"todos"|"events"|"context"`，defaultPanel 从 `"events"` 改为 `"overview"`
- **TodoItem 三态**：pending / in_progress / completed；advanceTodo 仅允许 pending→in_progress（防止跳状态）
- **进度条**：`completedCount/todos.length` 实时计算，CSS transition 0.3s ease
- **旋转图标**：LoadingCircleIcon 使用 SVG `stroke-dasharray` 半圆路径，配合 `.icon-spin` 动画
- **侧边栏 header**：DashboardIcon + "会话概览"标题（替代旧"任务进度"）
- **onNewConversation 重置**：切换会话时清空 todos

### 验收
- `tsc --noEmit`（gui）：exit code 0，零错误 ✅
- `npm run build`：exit 0，产物 993.26 KB ✅
- `py qa.py`：compile ✅ / run_tests ✅ / **pytest 777 passed** ✅

---

## 阶段 5B.1｜RightSidebar 单面板重排（概览→待办→上下文→事件流）— ✅ 完成（2026-08-23）

> 用户反馈：原 4 标签页设计割裂了各信息区域，参考 Claude Code「任务摘要」面板，将概览/待办/上下文/事件流合并为单一垂直滚动面板。

### 改动清单

| 文件 | 改动 |
|---|---|
| `gui/src/renderer/pages/RightSidebar.tsx` | 移除 `PanelKey` 类型与 `panel` 状态；删除 4 标签切换按钮栏；将内容从 `{panel === "xxx" && ...}` 条件渲染改为单一垂直布局（概览→待办→上下文→事件流）；移除未使用的 `OverviewCard` 辅助组件 |
| `gui/src/main/index.ts` | dev 模式启用 CDP 调试端口 9222（`app.commandLine.appendSwitch("remote-debugging-port", "9222")`） |

### 关键实现细节
- **单面板垂直布局**：顶部标题栏（会话概览 + 脉冲点）→ Agent 标识 → 下载进度条 → 可滚动区域
- **四个区块**：① 概览（MetricsGrid + UsageBreakdown + ContextWindowBar）→ ② 待办任务（可折叠 TodoList + 进度条 + 添加框）→ ③ 上下文文件（当前会话文件列表）→ ④ 活动记录/事件流（滚动列表，flex:1）
- **顺序**：待办在上，上下文在中，事件流压底（用户明确指定的顺序）
- **清理**：移除 `PanelKey`、`panel` state、`setPanel`，删除未使用的 `OverviewCard` 组件定义

### 验收
- `tsc --noEmit`（gui）：exit code 0，零错误 ✅
- `npm run build`：exit 0，产物 990.28 KB ✅
- `py qa.py`：compile ✅ / run_tests ✅ / **pytest 777 passed** ✅

---

## §汇总（总日志报告）

> 待全项目完成后生成：各阶段验收汇总表 + 回归趋势 + 遗留事项 + 验收门对照。
> 当前进度：**阶段 1-5 主体完成，双栈 1888 tests green，主进程压测通过，可进入收尾期。**

---

## 2026-08-22｜聊天正文净化 + 设置默认页 + 卸载数据勾选（QA 记录）

**改动**
- `core-ts/src/services/chat.ts` `splitUntaggedThinking`（0.1.4 增强）：思考特征计权（强信号 +2 / 弱信号 +1，阈值 ≥3）+ 行内正文锚点切分（你好/以下是/总结是…）+ 列表项延续，修复「同行密集思考 / 思考与正文同行 / 第一人称分析型思考」剥不掉的实测案例。完成时经 `extractThinkingFromReply` 兜底剥离。
- `tests/core-ts/chat_service.spec.ts`：新增 3 例实证回归（test1 问候同行 / Mybutler 长分析内嵌 / 思考句含「所以」不误切）。
- `gui/src/renderer/App.tsx`：设置弹窗默认标签页 `mind → general`（打开即「通用设置」）。
- `gui/installer.nsh`：卸载不再弹 MessageBox 询问，改为自定义卸载欢迎页勾选框（`customUnWelcomePage` + `UninstPage`，`un.slimeUninstallCheckPage/Leave` 包在 `!ifdef BUILD_UNINSTALLER` 内）；`customUnInstall` 按下一次卸载前勾选框结果决定是否 `RMDir` 用户数据，默认**保留**。

**回归**
- vitest 全量：**521 / 521 PASS（32 文件，含 chat_service 73 例）**，0 失败。
- GUI `electron-vite build`：main / preload / renderer 三端编译成功。
- `npm run dist:win` 全量打包：**exit 0**，NSIS 安装包 + 卸载器 + 便携版生成成功；NSIS `-WX` 严苛模式下 0 警告（此前依次修复 `create-page un.* 解析`→`6020 Uninstaller code`→`6001 未引用变量`，用 `UninstPage` + `!ifdef BUILD_UNINSTALLER` 收口）。
- 产物内代码落位核验：renderer 包 `useState("general")` 已生效；main 包含 `splitUntaggedThinking`/`findBodyAnchor`。

**产物**
- `gui/release/Slime Setup 0.0.1.exe`（660 MB，安装版）、`Slime 0.0.1.exe`（659.6 MB，便携版）。
- 迭代跑通 `dist:win` 全过程（build-safety-check 内容闸门 + prepare-runtime + electron-builder）。

---

## 阶段12｜联网搜索开关 + 文件查看器 + 思考格式重构 + "+"按钮外部关闭（2026-08-23）

**用户需求**：
1. 输入框加联网搜索开关（灰色默认，绿色激活）
2. 右侧边栏支持打开所有格式文件，点击新建标签页
3. 思考/工具调用展示格式重构（参考 Cursor/Copilot/Claude Code 折叠分组）
4. "+"按钮点击外部区域关闭菜单

**改动清单**：

| 文件 | 改动 |
|---|---|
| `core-ts/src/tool_loop.ts` | `ToolLoopOptions` 新增 `networkEnabled?: boolean`；执行时拦截 `web_search`/`web_fetch` |
| `gui/src/shared/ipc.ts` | `ChatInput` 新增 `networkEnabled`；新增 `FileMime` 类型；新增 `WorkspaceReadFileResult` 接口 |
| `core-ts/src/services/engine.ts` | `stream()` 传 `networkEnabled` 给 ToolLoop |
| `gui/src/renderer/pages/ChatPanel.tsx` | `send()` 传递 `networkEnabled`；**思考/工具展示完全重构**：折叠卡片+脉冲点动画 |
| `gui/src/renderer/pages/RightSidebar.tsx` | `FileTab` 组件（文本/图片/二进制三种渲染）；`openFileTab` 异步懒加载；`menuRef` + `useEffect` 外部点击关闭；`detectLang` 修复 `??` 优先级 |
| `gui/src/main/index.ts` | `workspace:readFile` handler；补全 `WorkspaceReadFileResult` 与 `readFileSync` 导入 |
| `gui/src/renderer/index.css` | 新增 `@keyframes pulse` |

**验证**：
- `pnpm typecheck`：零错误
- `pnpm build`：exit 0（产物含 pulse/FileTab/repairStreamingMarkdown）
- vitest 全量：**521 passed**（32 files）
- `py qa.py`：**777 passed**（QA ALL GREEN）

**需用户实测**：
- 联网开关灰/绿切换生效，关闭时 web 工具不被调用
- 右侧边栏点击文件新建标签页正常渲染
- "+"菜单外部点击/Escape 关闭
- 思考/工具以折叠卡片呈现
