# Slime

本地优先的 AI Agent 平台：Electron 桌面客户端 + TypeScript 调度核心 + Python 后端，内置 llama.cpp 本地推理。

- 当前版本：**v0.0.2** —— [Releases](https://github.com/Gcyming/local-project/releases/tag/v0.0.2)
- 平台：Windows x64（安装包 / 便携版）。Linux 仅有子项目脚本，未发布二进制。

## 它解决什么

Slime 把「Agent」当成持久对象管理：身份、记忆、人格参数、知识沉淀都落在本地磁盘。换模型或换机器时，迁移的是这个对象本身，而不是某家模型的会话记录。

模型是可替换的执行后端，Agent 是被保存的那一层。

## 仓库结构

```
core-ts/    TypeScript 调度核心：会话 / 工具轮 / 沙箱 / 记忆 / 心智 / 模型服务 / MCP / Swarm / 技能
gui/        Electron 客户端（主进程内嵌 core-ts；渲染层 React 19 + TypeScript）
core/       Python 业务核心：LLM 客户端、Agent、执行器
sidecar/    Python 推理侧车（llama-server / BGE-M3 嵌入）
tools/      Python 工具实现（含 agnes 媒体生成）
shared/     契约层：openapi.yaml + zod / pydantic
tests/      pytest（Python）+ vitest（TypeScript 守卫）
linux/      Linux 兼容子项目脚本
```

两条调用路径并存：

- **主链路**：GUI 主进程直接加载 core-ts，渲染层经 preload 走 IPC（`slime:*` 通道，main 侧注册约 210 个），不过 HTTP。
- **Python 后端**：GUI spawn `slime_server.py`（默认端口 19000，可用 `SLIME_PORT` 调整），负责 LLM 客户端与 Python 侧工具执行。

## 能力清单

以下每一项都能在 `core-ts/src` 或 `core/` 中找到对应实现。

### Agent 与身份

| 能力 | 实现位置 |
| --- | --- |
| 身份铁律：`name` 完全不可变，`role` 仅可经 `set_role()` 修改，演化引擎无权直接赋值 | `core/agent.py` |
| 输出过滤：不暴露底层模型名与 `agnes-*` 一类技术标识符 | `core-ts/src/filter.ts` |
| 分裂：继承 / 指定 API / 本地模型三种来源，深度上限 2 | `gui/src/main/index.ts`、`core-ts/src/services/subagent.ts` |
| `.slimeagent` 身份包导出 / 导入（协议 v1.2） | `core-ts/src/services/{export,import}.ts` |
| 多 Agent 协作与结果合并、幻觉声称核验 | `core-ts/src/merger.ts`、`claims.ts`、`a2a.ts` |
| 群聊会话与记录 | `core-ts/src/services/grouptalk.ts` |

### 心智与记忆

| 能力 | 实现位置 |
| --- | --- |
| 情绪状态（动态层） | `core-ts/src/mind/emotion.ts` |
| 行为模式沉淀 + 艾宾浩斯衰减 + 归档 | `core-ts/src/mind/behavior.ts` |
| 分层提示注入（行为 / 情绪风格 / 自我叙事） | `core-ts/src/mind/hooks.ts` |
| 向量记忆（LanceDB）+ 双向链接 + 多阶段检索 | `core-ts/src/memory/` |
| 知识晋升：Pattern → Rule → Skill → Persona trait | `core-ts/src/memory/knowledge.ts` |

### 工具与权限

| 能力 | 实现位置 |
| --- | --- |
| 工具注册表（权限位 read / write / terminal / network） | `core-ts/src/tools/registry.ts` |
| 内置工具：文件、命令、`web_fetch`、`web_search`（Bing 主 + 百度兜底）、adb 系列、浏览器、`ask_user` 等 | `core-ts/src/tools/builtin.ts` |
| MCP 客户端：stdio + Streamable HTTP(SSE) 双传输，重连上限 10 次 | `core-ts/src/mcp.ts` |
| 沙箱：L0–L5 分级决策链，默认只读，支持会话级白名单 | `core-ts/src/sandbox.ts` |
| 技能装配：外部 `SKILL.md` 装入 Agent 上下文 | `core-ts/src/skills.ts` |
| 屏幕捕获与 Android（adb）控制 | `core-ts/src/screen/`、`tools/builtin.ts` |

### 本地模型

- 随包自带 llama.cpp（CPU 版）与 BGE-M3 嵌入模型；对话用的 GGUF 需自备或由内置下载器获取（仓库内示例为 Qwen3-1.7B-Q8_0）。
- 模型服务生命周期、上下文窗口探测、GGUF 元数据与 KV 显存估算：`core-ts/src/model_server.ts`、`model_introspect.ts`、`gguf_meta.ts`。
- 定价与用量统计：`core-ts/src/services/usage.ts`。

### 客户端界面

- 对话：流式 Markdown、思考 / 工具折叠卡片、token 与上下文窗口统计、产物卡与变更 diff。
- 面板：状态、Agent 管理、计划、头脑风暴、用量统计、子代理、MCP、技能、供应商、权限、运行时、心智中枢。
- 右侧栏：会话概览 → 待办 → 上下文文件 → 活动记录。
- 内嵌浏览器、终端（非 PTY）、文件查看器。

## 快速上手

### 安装（Windows x64）

1. 下载 `Slime.Setup.0.0.2.exe`（559.8 MB）安装，或直接用 `Slime.0.0.2.exe` 便携版。
2. 首次启动会引导添加 Provider（api_base / api_key / 默认模型），配置加密后存于本地。
3. **需要 GPU 本地推理时**：另下载 `Slime-CUDA-Runtime-0.0.2.7z`（307.9 MB），把包内的 `llama.cpp` 目录解压覆盖到安装目录（默认 `%LOCALAPPDATA%\Programs\Slime`）。没有 NVIDIA 显卡就不需要它，缺这些 DLL 时 llama-server 会自动回落 CPU。

### 开发

```bash
py slime_server.py            # Python 后端，默认 19000
py slime_cli.py               # 交互式 CLI
cd gui && pnpm install && pnpm dev
py qa.py                      # 一站式 QA：compileall + run_tests.py + pytest
```

### 打包

```bash
cd gui
npm run dist:win              # 产出到 electron-builder.json 的 directories.output
npm run dist:win:publish      # 同上，并发布到 GitHub Release
```

体积已分层：主安装包只带 CPU 运行时，CUDA 运行时在打包前单独压成增补包随 Release 分发。
若输出目录被占用导致 `EBUSY`，用 `SLIME_OUT_DIR=<新目录>` 换一个输出目录即可，无需改配置。

## 测试基线

| 套件 | 规模 | 命令 |
| --- | --- | --- |
| pytest | 877 条（873 通过 / 4 跳过） | `py -m pytest` |
| vitest | 118 个 spec 文件 / 2138 条用例通过（6 条跳过） | `pnpm test`（根 `vitest run`） |

一键跑通：`py qa.py`（compileall → `run_tests.py` → pytest，报告落盘 `data/qa_report.json`）。
若 pytest 报 `PermissionError: ... pytest-of-MR\pytest-current`（Windows 上 `%TEMP%` 残留了死符号链接），
用 `PYTEST_DEBUG_TEMPROOT=<某个干净目录>` 换临时根即可，与代码无关。

打包产物另有断言脚本 `gui/scripts/assert-*.mjs|cjs`，以及配套的变异脚本 `gui/scripts/mut-a10*.mjs`（用于验证守卫确实会变红）。

## 文档

| 文档 | 作用 |
| --- | --- |
| [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md) | 项目总览：改动时间线 + 功能/代码对照 |
| [docs/长存架构规划.md](docs/长存架构规划.md) | 架构总纲：双栈架构、数据契约、身份移民协议 |
| [docs/阶段日志.md](docs/阶段日志.md) | 阶段级里程碑与验收记录 |
| [docs/Intelligence.md](docs/Intelligence.md) | 心智分层设计 |
| [docs/sandbox_design.md](docs/sandbox_design.md) | 沙箱 L0–L5 设计 |
| [docs/身份移民协议规格.md](docs/身份移民协议规格.md) | `.slimeagent` 包格式 v1.2 |
| [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) | 已知问题登记 |
| [docs/REVIEW_AGENT.md](docs/REVIEW_AGENT.md) | 问题登记表与修复日志 |
| [linux/README.md](linux/README.md) | Linux 子项目 |
| [AGENTS.md](AGENTS.md) | Agent 的 Git 行为契约（提交粒度 / 分支 / 回滚） |

## 已知限制

- 只发布 Windows x64 二进制；Linux 子项目有脚本但未产出 Release 二进制。
- 便携版每次启动都会把内容解压到临时目录（electron-builder portable target 的固有行为），首次启动偏慢。
- 安装包不含大模型 GGUF 权重，本地对话模型需自备或使用内置下载器。
- Python 与 TypeScript 双栈并存：GUI 主链路走 core-ts，Python 侧仍保留 `slime_server.py` / `slime_cli.py` 与部分工具实现。
- 仓库当前**没有 LICENSE 文件**，尚未声明开源许可；对外以开源方式发布前需先补上。
