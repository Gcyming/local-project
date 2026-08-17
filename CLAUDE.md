# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# slime

从零构建的专属 AI Agent 平台，支持分裂、记忆、进化、技能、MCP、社交接入。

## 技术栈

- Python 3.10+ / FastAPI / Rich CLI / LanceDB / llama.cpp（PySide6 规划中，见阶段三-遗留）
- 参考项目：Mybutler（记忆/进化）、A-C-C（多 Agent 调度）、Campanula（主题风格）

## 核心设计原则

1. **身份铁律**：Agent 不暴露底层模型名，回答"我是{name}，{role}"
2. **人格演化**：空骨架 → 交互中自然形成
3. **加密配置**：PBKDF2-HMAC-SHA256 + AES-256-GCM
4. **分裂机制**：支持 inherit / api / local 三种模型选择

## 启动方式

```bash
# 端口支持 SLIME_PORT 环境变量（默认 19000）
# Windows 下用 py 启动器（bash 里 python 可能不在 PATH）

# 后端服务（首启自动生成 config/auth_token.json，后续所有 API 需 Bearer 认证）
py slime_server.py

# CLI 终端（自动读取 auth_token 携带认证）
py slime_cli.py

# 首次向导
py slime_cli.py wizard
```

## 测试

```bash
py qa.py                                                # 一站式 QA：compileall → run_tests.py → pytest（推荐全量入口）
py run_tests.py                                         # 全量（自定义 runner，非 pytest）
py -m pytest tests/test_mcp.py::TestMCPPermissions -q    # 单文件/单类/单用例（pytest 直跑）
py -m pytest -q                                         # pytest 全量（根目录 pytest.ini 已限定 testpaths=tests）
```

- **`py qa.py` 是全量校验入口**（compileall 语法编译 + run_tests.py + pytest 三阶段，报告落盘 `data/qa_report.json`）。**测验/编译严禁走 PowerShell 管道与引号**（转义/编码损坏风险），PowerShell 仅作零参数启动器。
- `run_tests.py` 是**项目约定跑全量的入口**，自己实现发现与执行：只收集 `Test*` 类的 `test_*` 方法，支持 `setup_method` 和 `tmp_path` 参数、`async def` 方法。
- **关键坑**：`run_tests.py` 只注入 `tmp_path`（和 `setup_method`），**不注入 `monkeypatch`/`capsys`/`tmpdir` 等任何其他 pytest fixture**——写了会用这些 fixture 的用例在 run_tests.py 下会 TypeError，必须改用 pytest 直跑或换写法。当前 tests/ 里没有用例用这些 fixture。
- 单测/筛选用 `py -m pytest`（pytest 9.x 已装，`tests/conftest.py` 的 autouse fixture 会禁用沙箱审计、兜底注册内置工具）。`pytest.ini` 的 `testpaths=tests` 隔离了 config/skills 下第三方技能库测试（避免 core 模块名冲突）。
- 审查/改进/验收的常驻工作框架：`docs/REVIEW_AGENT.md`（问题登记表 + 验收门 + 修复日志）。

## 架构总览

### 请求流（一次 Swarm 任务）

```
slime_server.py (FastAPI + Bearer 认证中间件)
  └─ core/swarm.py  SwarmOrchestrator：主 Agent 拆解任务 → SwarmPlan/SubTask
        max_workers = min(并发上限, provider 数)，排队分批，不丢任务
     └─ core/executor.py  异步执行器：按 max_workers 并发跑 SubTask
          每个 SubTask → core/llm.py 调模型（工具调用走统一注册表）
          Worker 完成协议：模型回复末尾输出 <DONE> 才视为完成；
          轮次耗尽（MAX_ROUNDS=3）未收到 <DONE> → 标记 failed，绝不虚报成功
     └─ core/merger.py  合并子任务结果（幻觉护栏：声称"已保存/已生成"的
          文件路径真实不存在 → 记错误，trial 不通过，不虚报"任务完成"）
  └─ core/a2a.py / ipc_bus.py / process_worker.py  子 Agent 间通信 + 多进程分裂
```

- **Agent**（`core/agent.py`）：`name`/`role`/`identity_prompt` 是受保护字段——`name` 完全不可变，`role` 只能经 `set_role()` 改（`__setattr__` 架构级拦截，演化引擎/Persona 无权直改）。`split()` 三选一模型（inherit / api:key / local:path）；自分裂（fork 语义）经 SwarmExecutor 同 provider 并行实现（CLI `/auto` action="fork"，max_workers=2），`MAX_FORK_DEPTH=2` 硬上限（`fork_depth` 由 Worker/CLI 校验），临时 Worker 不入库。序列化到 `config/agents.json`（原子写入）。
- **工具统一注册表**（`tools/registry.py`）：单例 `ToolRegistry`，线程安全，**同名拒绝覆盖**（`force=True` 才覆盖）。每个 `Tool` 带 `permissions ∈ {read, write, terminal, network}`（默认 read），`to_llm_schema()` 输出给 LLM。内置工具在 `tools/builtin.py`。
- **媒体生成工具**（`tools/agnes_media.py`，A-035/A-048 起）：`agnes_prompt_build`（规则式提示词构建）/ `agnes_generate_image` / `agnes_generate_video` / `agnes_video_status`。真实生成 + 真实字节数证据 + 进度事件（A-050：CLI 进度条）；**同请求媒体生成合计限 1 次**（A-050-R3 防乱调）；密钥按调用方 Agent 的 provider 分配（A-048-R4，各 Agent 独立 Agnes 账号）。**编造检测 → 强制工具轮**（A-049，`slime_server.py`）：生成类请求 + 零工具调用 + 完成态声称 → 自动追加强制轮（只注入媒体工具子集 + 精简提示词），逼模型真实调用。
- **幻觉护栏**（`core/claims.py`，A-044 起）：CLI 每次回复后核验"已保存/已生成"类声称（含证据性描述如"文件大小/完整路径/字节"，A-048-R6）引用的路径真实存在；媒体产物裸文件名查 `data/generated/`（A-050-R2），URL 残片与域名样式片段跳过（A-050-R），编造路径红字警告。
- **沙箱**（`core/sandbox.py`）：权限分 L0–L5，`slime.toml [sandbox]` 配置自动批准/需确认/强制拒绝级别；全局单例 + 按 Agent 覆盖。
- **MCP**（`core/mcp_client.py`）：自研传输抽象 `_Transport → _StdioTransport / _HTTPTransport`，把外部 MCP server 的工具桥接为 `mcp_` / `mcp_res_` / `mcp_prompt_` 前缀注入同一注册表。stdio 双帧嗅探（JSONL / Content-Length）+ 后台 reader 循环 + 自动重连；详见 `docs/mcpfix.md`。
- **配置**：Provider 加密存 `config/providers.enc.json`（`core/encryption.py`）；全局默认值 `config/global_config.json`（`core/global_config.py`）；`slime.toml` 管功能开关与 MCP/模型/沙箱参数。

## 阶段实现状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| 阶段一 | 基础架构：Agent、Provider、对话、加密配置、CLI、分屏、Swarm | ✅ 完成 |
| 阶段一-补丁 | 认证中间件、CORS 收窄、SLIME_PORT、输入校验、promote 走 API | ✅ 完成 |
| 阶段二 | 自我分裂（多进程）、身份铁律输出过滤、对话持久化、记忆、进化、上下文压缩、工具注册表、沙箱权限、社交接入、技能引擎 | ✅ 完成 |
| 阶段三 | MCP 协议支持（stdio/HTTP/OAuth 2.1）、社交接入增强（企业微信+个人微信桥接）、本地模型管理（llama.cpp BGE-M3 + Qwen 3B） | ✅ 完成 |
| 阶段三-遗留 | GUI 桌面客户端（PySide6）——`gui/` 目录未开工；requirements.txt 无 PySide6 | ❌ 未开工（见 docs/REVIEW_AGENT.md A-007） |

## 关键约束

- **promote 必须走 server API**（POST /agents + PATCH children），禁止直写 agents.json，否则 server 退出时内存旧数据会覆盖 CLI 改动
- **max_output 安全上限 65536**（llm.py 常量），超限不发送 max_tokens 参数并打 warning
- **_parse_subtasks 优先整体 json.loads**，正则作兜底（处理嵌套 `}` 截断）
- **auth_token.json** 与 passphrase 文件同等级保护：Windows 隐藏+icacls，Unix 0o600
- **MCP 权限语义**：缺省 MCP 工具 `network`，resources/prompts 固定 `read`；`slime.toml` 可 `tool_permissions` 按名覆写（非法值回退 network）
