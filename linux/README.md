# slime Linux 兼容子项目

让 slime 在 Linux（含 WSL / 虚拟机）上原生运行与打包。核心代码零侵入——平台特定逻辑均已按 `os.name` / `IS_WINDOWS` 分支隔离，本目录只提供：**一键引导 + 模型下载 + Linux 打包配置**。

## 新用户一条命令搞定（推荐）

```bash
# 仓库里直接跑：环境 + llama-server + 模型全部装好
bash linux/setup.sh --with-models

# 然后启动
bash linux/run-server.sh      # 终端 1：后端
bash linux/run-cli.sh wizard  # 终端 2：首次向导
bash linux/run-cli.sh         # 终端 2：日常 CLI
```

## 给别人用：一键出包，接收方解压即玩

**构建机**（linux x64 + python3 + curl + git）：

```bash
bash linux/build-portable.sh              # 含模型，约 4GB（开箱即用）
bash linux/build-portable.sh --skip-models  # 不含模型，约 1.5GB（接收方再下模型）
# 产出 dist/slime-linux-x64.tar.gz
```

**接收方**（任何 linux x64，零依赖）：

```bash
tar -xzf dist/slime-linux-x64.tar.gz && cd slime-linux-x64
./run-cli.sh wizard     # 首次向导
./run-cli.sh            # 日常用（run-server.sh 后端 / run-gui.sh GUI）
```

## 分步使用（高级用户）

```bash
bash linux/setup.sh              # 只装环境（系统依赖 / Node 22 / pnpm / venv / llama.cpp / 配置）
bash linux/fetch-models.sh       # 只下模型（hf-mirror 国内镜像，断点续传）
bash linux/run-server.sh         # 启动后端
bash linux/run-cli.sh            # 启动 CLI
bash linux/build-gui.sh          # 构建 GUI（产出 gui/release-linux/Slime-*.AppImage / .deb）
```

## setup.sh 常用选项

| 选项 | 说明 |
|------|------|
| `--with-models` | 环境装好后自动下载模型（新用户首选） |
| `--skip-llama` | 跳过 llama.cpp（已有 llama-server 时） |
| `--no-venv` | 直接用系统 python，不建 venv |
| `--no-system` | 不自动装 apt 系统依赖（仅检测提示） |

## fetch-models.sh 选项

| 选项 | 说明 |
|------|------|
| 默认 | 下载全部（BGE-M3 + Qwen3-1.7B） |
| `--bge-only` | 只下嵌入模型（已有对话模型时） |
| `--chat-only` | 只下对话模型（已有嵌入模型时） |

## 兼容性状态

| 组件 | 状态 | 说明 |
|------|------|------|
| 后端 `slime_server.py` / `slime_cli.py` | ✅ | 全部平台分支有 Unix 实现；`python3` 替代 Windows 的 `py` 启动器 |
| core-ts / gateway-ts | ✅ | 纯 Node.js，无平台绑定 |
| LanceDB 向量库 | ✅ | `@lancedb/lancedb` 官方发布 7 平台 napi 包（linux-x64-gnu 等） |
| 孤儿进程回收 | ✅ | 新增 `/proc/{pid}/status` + `ps` 回退（Python + TS 双端，见 `core/model_server.py` / `core-ts/src/model_server.ts`） |
| 权限保护 | ✅ | Unix 自动走 `chmod 0o600`（Windows 走 icacls） |
| Electron GUI | ✅ | 新增 `linux` 目标（AppImage + deb），`gui/release-linux/` |
| 自动更新 | ✅ | electron-updater 支持 AppImage/Deb/RPM |
| 本地模型 | ✅ | `setup.sh` 自动编译 llama-server；`fetch-models.sh` 下载 GGUF（hf-mirror 国内镜像） |
| VRAM 监控 | ⚠️ | 仅 NVIDIA 原生日志解析；无 GPU / AMD 时跳过（fail-safe） |

## 目录结构

```
linux/
├── README.md              本说明
├── setup.sh               一键引导（环境 + 可选模型）
├── fetch-models.sh        模型下载（hf-mirror 国内镜像 + 断点续传）
├── build-portable.sh      便携发行包构建（默认含模型，解压即用）
├── build-gui.sh           Linux 版 Electron GUI 构建
├── run-server.sh          后端启动
├── run-cli.sh             CLI 启动
├── slime.toml.linux       可移植配置模板（@PROJECT_ROOT@ 占位符）
└── scripts/
    └── gen-config.sh      模板 → 项目根 slime.toml（备份已有配置）
```

## 模型清单

| 模型 | 用途 | 大小 | 来源 |
|------|------|------|------|
| BGE-M3 Q8_0 | 嵌入（检索/记忆必需） | 635 MB | ggml-org/bge-m3-Q8_0-GGUF |
| Qwen3-1.7B Q8_0 | 对话推理 | 1.83 GB | Qwen/Qwen3-1.7B-GGUF |

下载走 hf-mirror.com 镜像，断点续传；中断后重跑 `fetch-models.sh` 继续即可。

## 与 Windows 版的差异

| 项 | Windows | Linux |
|----|---------|-------|
| Python 启动 | `py slime_server.py` | `python3 slime_server.py`（`linux/run-*.sh` 已封装） |
| llama-server | `D:\tool\slime\llama.cpp\llama-server.exe` | `{仓库根}/llama.cpp/build/bin/llama-server`（源码编译或官方预编译） |
| 配置路径 | 硬编码 `D:\tool\...` | 相对仓库根（模板自动生成） |
| 浏览器 MCP | msedge | chromium（模板已附 playwright-mcp 示例） |
| 孤儿检测 | wmic/tasklist/PowerShell | `/proc/{pid}` + `ps`（本次补齐） |
| GUI 打包 | NSIS + portable (.exe) | AppImage + deb |

## 说明

- **非破坏性原则**：本目录全部为新增文件；对现有代码仅做了两处最小修改——`core/model_server.py` 与 `core-ts/src/model_server.ts` 的 `parentPid` 补 Linux 分支（原实现非 Windows 直接返回 null，崩溃残留不自愈）。
- **国内网络适配**：setup.sh 自动探测 apt 源（清华/阿里/中科大/华为），命中则切 npmmirror + electron 镜像。GitHub 直连失败时自动试 ghfast.top / gh-proxy.com / ghproxy.net 代理（gh-proxy 站不稳定，优先 gitee 镜像回退）。
- **便携包体积**：默认含模型约 4 GB（Node 120MB + Python 60MB + venv 150MB + node_modules 1.2GB + llama.cpp 150MB + GUI 100MB + 模型 2.5GB）。`--skip-models` 约 1.5GB。tar.gz 中 GGUF 不可压缩所以接近原始体积。
- **macOS**：同套代码基本可运行，额外需 Apple Silicon 二进制（LanceDB 已支持 darwin-arm64）+ 签名/公证；未在本次范围。

## 路线图

- [x] 孤儿检测 Linux 分支（Python + TS）
- [x] Linux 打包配置（electron-builder + dist:linux 脚本）
- [x] 一键引导脚本 + 可移植配置模板
- [x] 国内镜像自动适配（pnpm registry + electron 二进制）
- [x] llama.cpp 源码克隆 bug 修复（git clone 拒绝非空目录）
- [x] fetch-models.sh 模型一键下载（hf-mirror + 断点续传）
- [x] build-portable.sh 默认含模型打包（开箱即用）
- [ ] 在真实 Linux/WSL 环境跑通全量 `py qa.py`（当前 Windows 上已验证 Python 单测不受影响）
- [ ] Linux CI（GitHub Actions ubuntu runner）发布 AppImage/deb
- [ ] AMD GPU 的 ROCm VRAM 监控回退
- [ ] GUI 桌面客户端（PySide6）——见 docs/REVIEW_AGENT.md A-007
