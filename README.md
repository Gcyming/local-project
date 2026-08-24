# Slime

一个从零构建的专属 AI Agent 平台——让 Agent 的人格、记忆与成长跨越模型、设备与运行时的更迭而**长存**。

项目当前对外版本：**v0.0.1**（Windows 安装包/便携版见 [Releases](https://github.com/Gcyming/local-project/releases/tag/v0.0.1)）。

---

## 核心理念

```
模型是硬件，Agent 是软件。
换模型 = 换大脑，不换人。
```

- **身份铁律**：Agent 永远回答"我是{name}，{role}"，不暴露底层模型
- **人格演化**：空骨架 → 交互中自然形成；情绪 / 行为 / 人格随时间沉淀（L1/L2/L3 三层心智架构）
- **数据永存**：记忆、行为模式、知识图谱跨设备/跨运行时保留（支持 `.slimeagent` 包迁移）
- **加密配置**：Passphrase + AES-256-GCM 守护所有密钥与个人数据

## 功能总览

### 🧠 Agent 生命周期

| 能力 | 说明 |
|---|---|
| 创建与分裂 | `split()` 三选一模型（inherit / api:key / local:path）；自分裂经 SwarmExecutor 同 provider 并行实现；`MAX_FORK_DEPTH=2` 硬上限 |
| 身份铁律 | `name` 完全不可变，`role` 仅可经 `set_role()` 修改；演化引擎/Persona 无权直改 |
| 人格档案 | identity_prompt + persona + evolution；演化引擎与 AffectManager 按 L1/L2/L3 分层操作 |
| 记忆系统 | 向量存储（LanceDB）+ 双向链接 + 艾宾浩斯权重排序；四阶段检索 Node 侧闭环（向量→链接遍历→标签过滤→排序） |
| 知识晋升 | Pattern → Alert → Rule → Trait → Skill 五级跃迁，自动审查（90 天归档） |
| 技能引擎 | 外部 SKILL.md 装配到 `.agents/skills/`，工具按需注入到 Agent 上下文 |
| 身份移民 | `.slimeagent` ZIP 包导出/导入；SHA-256 校验；向前/向后兼容；向量索引永不入包（导入后重建） |

### 🔀 Swarm 协作

| 能力 | 说明 |
|---|---|
| 并行分裂 | `max_workers = min(并发上限, provider 数)`，排队分批不丢任务 |
| Worker 完成协议 | 模型回复末尾输出 `<DONE>` 才视为完成；轮次耗尽（`MAX_ROUNDS=5`）未收到则标记 failed |
| 幻觉护栏 | merger 核验"已保存/已生成"类声称路径真实存在；媒体产物裸文件名查 `data/generated/`；URL 残片跳过 |
| 身份裁决 | LLM 矛盾裁定（启发式命中才调用）；工具成败归因写入 knowledge |

### 🛠 工具与扩展

| 能力 | 说明 |
|---|---|
| 工具统一注册表 | 单例 `ToolRegistry`，线程安全；同名拒绝覆盖（`force=True` 才覆盖）；`permissions ∈ {read, write, terminal, network}` |
| 内置工具 | `web_fetch` / `web_search`（Bing 主 + 百度兜底，SSRF 校验，反爬节奏控制）/ 媒体生成（Agnes 图片/视频，单请求限 1 次）/ MCP 桥接工具前缀 `mcp_` / `mcp_res_` / `mcp_prompt_` |
| MCP 双传输 | stdio（双帧嗅探 JSONL/Content-Length + 后台 reader 循环 + 自动重连）/ HTTP（SSE，OpenAI 兼容）；resources/prompts 固定 `read` 权限，工具默认 `network` |
| 沙箱权限 | L0–L5 五级（read/write/terminal/network 等）；会话级白名单（「本次会话总是允许」后同 Agent 同工具不再询问）；工作目录外路径转用户确认弹窗（非硬拒）；敏感文件 .slime_pass/providers.enc.json/auth_token/*/.enc 防护降级 |
| ask_user | 方向分歧/关键决策时向用户提问（无 UI 环境回退内置提示、不编造用户回答）；超时自动收起恢复输入框 |
| 联网开关 | 聊天输入框一键切换 `web_search/web_fetch` 调用开关，关闭时工具轮次拦截两类工具 |

### 🖥️ GUI（Electron + React + TypeScript）

| 面板 | 功能 |
|---|---|
| 对话（ChatPanel） | 流式 Markdown 渲染（streaming 实时补全未闭合围栏/反引号/粗体/斜体）；思考/工具折叠卡片（参考 Cursor/Claude Code）；Token 统计；历史搜索；导出 MD；重试；新对话；联网开关；推理强度调节；模式切换（build/auto） |
| 状态（StatusPanel） | 数字卡：Agent 树 / 会话 / 服务器概览；SVG 迷你折线图（Agent 数/记录数/服务器数 趋势）；模型服务器实例表；告警；3s 轮询推送 |
| Agent 管理（AgentsPanel） | 卡片列表（名称/角色/生命周期徽章/子代数量）；右侧属性面板（身份卡片 / 模型卡片 inherit/api/local 三选一 / 推理强度 / 最大上下文与输出）；创建/分裂/导出/导入；子代树形展开 |
| 设置 | **心智中枢**（PAD 情绪三轴滑块 + 8 种情绪编码表 / 向量工具选择 bge/basic / 记忆根目录配置 / book-to-skill 拖入文档生成 SKILL.md） / **Agent 管理** / **供应商管理**（OpenAI 兼容自动探测 + 模型列表 / 本地模型管理 gguf 扫描 / 参数文件调试 slime.toml/MCP/技能库） / **权限**（全局审批模式 + 工具类别开关 + MCP/技能全局开关） / **MCP 接入** / **技能库**（启用/停用/删除） / **通用**（双主题 Alpha/Beta 切换 + 开机自启 + 卸载向导） |
| 右侧栏（RightSidebar） | 单面板垂直布局：会话概览（MetricsGrid + UsageBreakdown + ContextWindowBar）→ 待办任务（可折叠 TodoList 三态 pending/in_progress/completed + 进度条 + 添加框）→ 上下文文件（当前会话文件列表）→ 活动记录/事件流（滚动列表） |
| 文件查看器 | 点击任意文件新建标签页；文本/图片/二进制三种渲染模式；懒加载（点击先创建 tab 显示加载中再异步读取） |
| 终端 | 命令运行器（非 PTY，30s 限时 + 8MB 缓冲），cwd 默认工作目录 |
| 浏览器 | 内嵌 webview（webviewTag: true），新建标签页导航 |
| Git | 检测/初始化/提交/推送/拉取/切换分支/克隆（slime:// 自定义协议加载） |

- 启动器 `boot.ts`：首启自动矫正 `llama_bin` / `model_path` / `models_dir` 到安装根与用户数据目录，无需手工填路径
- 自动更新：`electron-updater` 支持，默认关闭（`feed_url` 留空时回退 `publish.github`）
- 自定义卸载：勾选是否保留用户数据（默认保留）

## 快速上手

### Windows

```bash
# 1. 安装
双击运行 `Slime.Setup.0.0.1.exe`（约 692 MB），或直接用 `Slime.0.0.1.exe` 便携版

# 2. 首次启动
GUI 会自动引导添加 Provider（填写 api_base / api_key / 默认模型），配置加密后存储在 `~/.slime/`

# 3. CLI（可选）
py slime_cli.py                    # 交互式终端
py slime_cli.py wizard             # 首次向导
py slime_cli.py /help              # 查看所有斜杠命令
```

### Linux（含 WSL）

详见 [linux/README.md](linux/README.md)。核心能力：一键安装脚本 + 模型下载 + 便携版构建，平台特定逻辑按 `os.name` / `IS_WINDOWS` 分支隔离。

### 开发环境

```bash
# 后端（Python FastAPI）
py slime_server.py                 # 默认端口 19000（可通过 SLIME_PORT 调整）

# CLI 终端（自动读取 auth_token 携带认证）
py slime_cli.py

# 前端（Electron + React）
cd gui && pnpm install && pnpm dev

# 一站式 QA
py qa.py                           # compileall + run_tests.py + pytest（报告落盘 data/qa_report.json）
```

## 技术架构

```
pilot project/
├── core-ts/       TS 主控：调度/会话/工具轮/沙箱决策/记忆/心智/模型生命周期（Node 业务核心，2167 行 index.ts + 32 vitest spec）
├── gui/           Electron（主进程内嵌 core-ts 调度核心 + sidecar 管理；渲染层 React 19 + TypeScript；IPC 不经过 HTTP）
├── sidecar/       Python（推理 + 嵌入执行优点面，长期保留；llama-server/BGE-M3）
├── shared/        ★契约层：openapi.yaml + zod/pydantic 双端共享
└── linux/         Linux 兼容子项目
```

- **进程模型**：主进程内嵌 core-ts 调度核心 + sidecar spawn 管理；渲染进程纯 React 本地内容；GUI ↔ 调度走 IPC（约 70 个 `slime:*` 通道），不经过 HTTP/gateway-ts
- **安全基线**：contextIsolation ✅ / sandbox ✅ / webSecurity ✅ / CSP `default-src 'self'` ✅ / IPC sender 白名单 ✅ / preload 仅 electron 子集 ✅ / `slime://` 自定义协议替代 file:// ✅
- **通信协议**：单协议原则，`/chat/completions`（流式，OpenAI 兼容）+ `/embeddings` + `/health` + `/load_model` + `/unload_model` + `/stats`；动态端口（Node 启动前 `net.createServer` 探测空闲端口，以 `INFER_PORT` 传入）
- **测试基线**：pytest 777 passed + TypeScript vitest 535+ 全绿（`py qa.py` 一站式入口，报告落盘 `data/qa_report.json`）

## 设计历程（阶段总览）

> 详细里程碑见 [docs/PHASE_LOG.md](docs/PHASE_LOG.md)；问题登记表与修复日志见 [docs/REVIEW_AGENT.md](docs/REVIEW_AGENT.md)。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段一 | 基础架构：Agent、Provider、对话、加密配置、CLI、分屏、Swarm | ✅ 完成 |
| 阶段一-补丁 | 认证中间件、CORS 收窄、SLIME_PORT、输入校验、promote 走 API | ✅ 完成 |
| 阶段二 | 自我分裂（多进程）、身份铁律输出过滤、对话持久化、记忆、进化、上下文压缩、工具注册表、沙箱权限、社交接入、技能引擎 | ✅ 完成 |
| 阶段三 | MCP 协议支持（stdio/HTTP/OAuth 2.1）、社交接入增强、本地模型管理（llama.cpp BGE-M3 + Qwen 3B） | ✅ 完成 |
| 阶段 1–4 | 双栈迁移：sidecar 化 → Node 壳原型（契约单源）→ 双路径路由（OOM 降级链）→ 心智/记忆/工具/沙箱/Swarm 全模块 TS 化 | ✅ 完成 |
| 阶段 5A | 模型生命周期 / 记忆检索 / 配置加密 / 服务端点（gateway-ts 薄壳 + core-ts Service API） | ✅ 完成 |
| 阶段 5B | MCP/Skill/进化压缩/社交接入 TS 化；身份移民协议规格定案（v1.2） | ✅ 完成 |
| 阶段 5C | Electron 官方文档对齐 + 打包分发（Windows 双形态：安装版 + 便携版） | ✅ 完成 |
| 阶段 5D | 工程加固（安全扫描 + 并发压测 + Fuse 加固 + 自动更新） | ✅ 完成 |
| 阶段 4–10（GUI） | GUI 四问题/六建议落地、会话创建流重构、TasksTab 四面板布局、权限交互升级（工作目录外授权 + ask_user + 会话白名单）、模型兼容/列表优化、右侧栏工作树/终端/浏览器/Git | ✅ 完成 |
| 阶段 8–12（GUI） | 下载进度实时化、模型加载反馈、向量模型 idle 解释、数据重置安全加固、安装版启动修复、联网搜索开关、文件查看器、思考/工具折叠卡片重构 | ✅ 完成 |
| 阶段 9–11（GUI） | 自动更新、依赖图标、思考实时显示、安装包自启与卸载、上下文圆环、UI 图标全面换新 + 双主题（Alpha/Beta）、流式 Markdown 符号暴露修复 | ✅ 完成 |
| 阶段 13（GUI） | 右侧栏单面板重排（概览→待办→上下文→事件流 四区合一） | ✅ 完成 |
| 阶段 A-800~805 | 终局优化批：HTTP 连接池（TCP/TLS 握手从每请求一次降为进程级一次）/ V8 代码缓存 + spellcheck 关闭 / 权限收敛 / 仓库精简 / 历史清源（git-filter-repo 全重写） | ✅ 完成 |
| 遗留 | PySide6 桌面客户端——`gui/` 目录未开工（见 [docs/REVIEW_AGENT.md](docs/REVIEW_AGENT.md) A-007） | ❌ 未开工 |

## 文档索引

| 文档 | 作用 |
|---|---|
| [docs/长存架构规划.md](docs/长存架构规划.md) | 架构总纲 v2.11：核心理念、双栈架构、数据契约、身份移民协议 |
| [docs/PHASE_LOG.md](docs/PHASE_LOG.md) | 阶段级里程碑日志（含验收数据） |
| [docs/Intelligence.md](docs/Intelligence.md) | L1/L2/L3 三层心智架构设计（1170 行白皮书） |
| [docs/soul-plan.md](docs/soul-plan.md) | 三层心智 + 夺舍机制 + 四维人格模型（精简版） |
| [docs/身份移民协议规格.md](docs/身份移民协议规格.md) | Agent 永存载体 `.slimeagent` 包格式 v1.2 |
| [docs/CLI-GUI-MAPPING.md](docs/CLI-GUI-MAPPING.md) | CLI→GUI 命令映射表（MVP 定案） |
| [docs/mcpfix.md](docs/mcpfix.md) | MCP 客户端优化方案（双帧 stdio / HTTP 长流） |
| [docs/sandbox_design.md](docs/sandbox_design.md) | 沙箱 L0-L5 架构设计方案 v1.0 |
| [docs/Evolution.md](docs/Evolution.md) | 本地模型管理任务向导 |
| [docs/BUGS.md](docs/BUGS.md) | 已知 Bug 清单（BUG-001~034 全部闭环 + S3 遗留） |
| [docs/阶段日志.md](docs/阶段日志.md) | 日常迭代快照（供回溯） |
| [docs/search_engine.md](docs/search_engine.md) | 内置网络工具方案（web_fetch/web_search） |
| [linux/README.md](linux/README.md) | Linux 兼容子项目说明 |
| [AGENTS.md](AGENTS.md) | Agent Git 行为硬契约（提交粒度 / 身份铁律 / 回滚策略） |
| [CLAUDE.md](CLAUDE.md) | Claude Code 上下文工作指引 |
| [docs/REVIEW_AGENT.md](docs/REVIEW_AGENT.md) | 问题登记表 + 修复日志（A-001 起，含终局 A-800~A-805） |

## 技术栈

- **后端**：Python 3.10+ / FastAPI / httpx（连接池）/ uvicorn
- **编排/调度/UI**：TypeScript / Electron 35（React 19）/ electron-vite / electron-builder / electron-updater
- **数据库**：LanceDB（向量存储，JS 原生，10 万条检索 8.7ms）
- **推理/嵌入**：llama.cpp（Qwen 3B chat / BGE-M3 embedding）、Agnes 媒体生成（图片/视频）
- **测试**：pytest（777 用例）+ vitest（535+ 用例）
- **参考项目**：Mybutler（记忆/进化）、A-C-C（多 Agent 调度）、Campanula（主题风格）

## 开源协议

本仓库对外发布部分采用 [MIT License](../LICENSE)。

内部组件归属与使用许可请参见 [docs/长存架构规划.md §8.5 打包门禁](docs/长存架构规划.md)。

---

> 当前版本：v0.0.1 ｜ 构建时间：2026-08-24 ｜ 远端 main：[Gcyming/local-project](https://github.com/Gcyming/local-project)
