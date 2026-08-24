# Slime

一个从零构建的专属 AI Agent 平台——让 Agent 的人格、记忆与成长跨越模型、设备与运行时的更迭而**长存**。

项目当前对外版本：**v0.0.1**（Windows 安装包/便携版见 [Releases](https://github.com/Gcyming/local-project/releases/tag/v0.0.1)）。

---

## 核心设计理念

```
模型是硬件，Agent 是软件。
换模型 = 换大脑，不换人。
```

- **身份铁律**：Agent 永远回答"我是{name}，{role}"，不暴露底层模型
- **人格演化**：空骨架 → 交互中自然形成；情绪 / 行为 / 人格随时间沉淀（L1/L2/L3 三层心智架构）
- **数据永存**：记忆、行为模式、知识图谱跨设备/跨运行时保留（支持 `.slimeagent` 包迁移）
- **加密配置**：Passphrase + AES-256-GCM 守护所有密钥与个人数据

## 平台功能全景

### 🧠 Agent 生命周期

| 能力 | 说明 |
|---|---|
| 创建与分裂 | `split()` 三选一模型（inherit / api:key / local:path），自分裂经 SwarmExecutor 并行实现；`MAX_FORK_DEPTH=2` 硬上限 |
| 身份铁律 | `name` 完全不可变，`role` 仅可经 `set_role()` 修改，演化引擎/Persona 无权直改 |
| 人格档案 | identity_prompt + persona + evolution；演化引擎与 AffectManager 按 L1/L2/L3 分层操作 |
| 记忆系统 | 向量存储（LanceDB）+ 双向链接 + 艾宾浩斯权重排序；四阶段检索 Node 侧闭环（向量→链接遍历→标签过滤→排序） |
| 知识晋升 | Pattern → Alert → Rule → Trait → Skill 五级跃迁，自动审查（90 天归档） |
| 技能引擎 | 外部 SKILL.md 装配到 `.agents/skills/`，工具按需注入到 Agent 上下文 |

### 🔀 Swarm 协作

| 能力 | 说明 |
|---|---|
| 并行分裂 | `max_workers = min(并发上限, provider 数)`，排队分批不丢任务 |
| Worker 完成协议 | 模型回复末尾输出 `<DONE>` 才视为完成；轮次耗尽（`MAX_ROUNDS=3`）未收到则标记 failed |
| 幻觉护栏 | merger 核验"已保存/已生成"等声称路径真实存在，文件裸文件名查 `data/generated/` |
| 身份裁决 | LLM 矛盾裁定（启发式命中才调用）；工具成败归因写入 knowledge |

### 🛠 工具与扩展

| 能力 | 说明 |
|---|---|
| 工具统一注册表 | 单例 `ToolRegistry`，线程安全；同名拒绝覆盖（`force=True` 才覆盖）；`permissions ∈ {read, write, terminal, network}` |
| 内置工具 | `web_fetch` / `web_search` / 媒体生成（Agnes 图片/视频，A-050 限 1 次/请求）/ MCP 桥接工具前缀 `mcp_` / `mcp_res_` / `mcp_prompt_` |
| MCP 双传输 | stdio（双帧嗅探 JSONL/Content-Length + 后台 reader 循环 + 自动重连）/ HTTP（SSE，OpenAI 兼容） |
| 本地模型 | llama.cpp sidecar：BGE-M3 嵌入常驻（端口 8999）、Qwen 3B chat 懒加载静默（端口 18082 起）；VRAM 预算 7GB，偏差 <10% 实测通过 |
| 沙箱权限 | L0–L5 五级（read/write/terminal/network 等），`slime.toml [sandbox]` 配置自动批准/需确认/强制拒绝；agent 级 sandbox_override 与 auto_approve_tools 名单取并集 |

### 📡 社交接入

| 能力 | 说明 |
|---|---|
| 企业微信 | 官方 API（TS 直连）；`wechat_webhook_url` + `wechat_verify_token`（SHA1 验签） |
| 个人微信 | 桥接服务 `wechat_bridge_url/token`；TS 无可用库时回退 sidecar（仅此例外） |
| webhook 验签 | 固定 sha1 + 重试 3 次；social/base.py:190-227 |

### 🔌 双栈架构（TS 主控 + Python 优点面）

```
pilot project/
├── core-ts/       TS 主控：调度/会话/工具轮/沙箱决策/记忆/心智/模型生命周期（Node 业务核心）
├── gateway-ts/    TS：HTTP 网关薄壳（Fastify + Bearer + 限流 + CORS + SSE 转换）
├── gui/           Electron（主进程核心调度 + 渲染层 React + TypeScript）
├── sidecar/       Python（推理 + 嵌入执行优点面，长期保留；llama-server/BGE-M3）
├── shared/        ★契约层：openapi.yaml + zod/pydantic 双端共享
└── scripts/       双栈启动/构建/打包编排
```

- **通信协议**：单协议原则，`/chat/completions`（流式，OpenAI 兼容）+ `/embeddings` + `/health` + `/load_model` + `/unload_model` + `/stats`
- **动态端口**：Node 启动前 `net.createServer` 探测空闲端口，以 `INFER_PORT=xxxxx` 传入，零冲突、支持多实例并行
- **测试基线**：Python pytest 777 passed + TypeScript vitest 535+ 全绿（`py qa.py` 一站式入口）

### 🖥️ GUI（Electron + React + TypeScript）

| 面板 | 功能 |
|---|---|
| 对话（ChatPanel） | 流式渲染、Markdown 渲染、思考过程实时显示、Token 统计、历史搜索、导出 MD、重试、新对话 |
| 状态（StatusPanel） | sidecar 健康、VRAM 使用、Agent 统计/生命周期分布、告警、工具清单（内置/MCP/技能） |
| Agent 管理（AgentsPanel） | 列表/创建/分裂、子 Agent 树形视图、人格详情（traits/preferences/skill_ownership）、会话创建流重构 |
| 设置 | Provider 管理（加密存 `providers.enc.json`，脱敏展示）、MCP 服务器配置、上下文长度/最大输出、自动更新开关 |
| 右侧栏 | 系统终端（命令运行器，非 PTY，限时执行）、Git 集成、任务面板 |

- 启动器 `boot.ts`：首启自动矫正 `llama_bin` / `model_path` / `models_dir` 到安装根与用户数据目录，无需手工填路径
- 自动更新：`electron-updater` 支持，默认关闭（`feed_url` 留空时回退 `publish.github`）

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

## 设计历程（阶段总览）

> 详细路线图见 [docs/长存架构规划.md](docs/长存架构规划.md)（v2.11 终局版）；里程碑对照见 [docs/PHASE_LOG.md](docs/PHASE_LOG.md)。

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段一 | 基础架构：Agent、Provider、对话、加密配置、CLI、分屏、Swarm | ✅ 完成 |
| 阶段一-补丁 | 认证中间件、CORS 收窄、SLIME_PORT、输入校验、promote 走 API | ✅ 完成 |
| 阶段二 | 自我分裂（多进程）、身份铁律输出过滤、对话持久化、记忆、进化、上下文压缩、工具注册表、沙箱权限、社交接入、技能引擎 | ✅ 完成 |
| 阶段三 | MCP 协议支持（stdio/HTTP/OAuth 2.1）、社交接入增强、本地模型管理（llama.cpp BGE-M3 + Qwen 3B） | ✅ 完成 |
| 阶段 4 | GUI 四问题 + 六建议落地（聊天窗、状态面板、侧边栏、设置） | ✅ 完成 |
| 阶段 5 | 会话创建流重构、TasksTab 四面板布局、权限面板增强 | ✅ 完成 |
| 阶段 5A | 双栈迁移：模型生命周期/记忆检索/加密/服务端点（core-ts 调度核心成型） | ✅ 完成 |
| 阶段 5B | MCP/Skill/进化压缩/社交接入 TS 化；身份移民协议规格定案（v1.2） | ✅ 完成 |
| 阶段 6-10 | 本地模型真根因定位、安装版启动修复、下载进度实时化、右侧栏、权限工作目录外授权、思考过程真流式 | ✅ 完成 |
| 阶段 A-800~805 | 终局优化批：连接池、V8 缓存、权限收敛、仓库精简、历史清源（git-filter-repo 全重写） | ✅ 完成 |
| 阶段三-遗留 | GUI 桌面客户端（PySide6）——`gui/` 目录未开工（见 [docs/REVIEW_AGENT.md](docs/REVIEW_AGENT.md) A-007） | ❌ 未开工 |

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
| [docs/sandbox_design.md](docs/sandbox_design.md) | 沙箱架构设计方案 v1.0 |
| [docs/Evolution.md](docs/Evolution.md) | 本地模型管理任务向导 |
| [docs/BUGS.md](docs/BUGS.md) | 已知 Bug 清单 |
| [docs/阶段日志.md](docs/阶段日志.md) | 日常迭代快照（供回溯） |
| [docs/search_engine.md](docs/search_engine.md) | 内置网络工具方案（web_fetch/web_search） |
| [linux/README.md](linux/README.md) | Linux 兼容子项目说明 |
| [AGENTS.md](AGENTS.md) | Agent Git 行为硬契约（提交粒度 / 身份铁律 / 回滚策略） |
| [CLAUDE.md](CLAUDE.md) | Claude Code 上下文工作指引 |
| [docs/REVIEW_AGENT.md](docs/REVIEW_AGENT.md) | 问题登记表 + 修复日志（A-001 起，含终局 A-800~A-805） |

## 技术栈

- **后端**：Python 3.10+ / FastAPI / httpx（连接池）/ uvicorn
- **编排/调度/UI**：TypeScript / Electron（React 19）/ Vite / electron-builder / electron-updater
- **数据库**：LanceDB（向量存储，JS 原生，10 万条检索 8.7ms）
- **推理/嵌入**：llama.cpp（Qwen 3B chat / BGE-M3 embedding）、Agnes 媒体生成（图片/视频）
- **测试**：pytest（777 用例）+ vitest（535+ 用例）
- **参考项目**：Mybutler（记忆/进化）、A-C-C（多 Agent 调度）、Campanula（主题风格）

## 开源协议

本仓库对外发布部分采用 [MIT License](../LICENSE)。

内部组件归属与使用许可请参见 [docs/长存架构规划.md §8.5 打包门禁](docs/长存架构规划.md)。

---

> 当前版本：v0.0.1 ｜ 构建时间：2026-08-24 ｜ 远端 main：[Gcyming/local-project](https://github.com/Gcyming/local-project)
