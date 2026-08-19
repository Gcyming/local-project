# slime Linux 兼容项目

让 slime 在 Linux（含 WSL / 虚拟机）上原生运行与打包的子项目。核心代码零侵入——平台特定逻辑均已按 `os.name` / `IS_WINDOWS` 分支隔离，本目录只提供：**可移植配置模板 + 一键引导脚本 + Linux 打包配置**。

## 兼容性状态

| 组件 | 状态 | 说明 |
|------|------|------|
| 后端 `slime_server.py` / `slime_cli.py` | ✅ 可直接运行 | 全部平台分支有 Unix 实现；`python3` 替代 Windows 的 `py` 启动器 |
| core-ts / gateway-ts | ✅ 纯 Node.js | 无平台绑定 |
| LanceDB 向量库 | ✅ pnpm 自动装 Linux 版 | `@lancedb/lancedb` 官方发布 7 平台 napi 包（linux-x64-gnu 等） |
| 孤儿进程回收 | ✅ 已补齐 | 本次新增 `/proc/{pid}/status` + `ps` 回退（Python + TS 双端，见 `core/model_server.py` / `core-ts/src/model_server.ts`） |
| 权限保护 | ✅ | Unix 自动走 `chmod 0o600`（Windows 走 icacls） |
| Electron GUI | ✅ 可打包 | 新增 `linux` 目标（AppImage + deb），`gui/release-linux/` |
| 自动更新 | ✅ | electron-updater 支持 AppImage/Deb/RPM |
| 本地模型 | ⚠️ 需引导 | 需 Linux 版 llama-server + GGUF 模型（`setup.sh` 自动处理） |
| VRAM 监控 | ⚠️ 仅 NVIDIA | 无 GPU / AMD 时跳过（fail-safe，不影响运行） |

## 快速开始

```bash
# 1. 一键引导（venv + 依赖 + llama.cpp + 配置生成）
bash linux/setup.sh

# 2. 放置模型（setup.sh 会提示路径）
#    models/BGE-M3/bge-m3-q8_0.gguf   （嵌入，检索/记忆必需）
#    models/chat/*.gguf               （对话推理）

# 3. 启动
bash linux/run-server.sh      # 后端（首启生成 config/auth_token.json）
bash linux/run-cli.sh         # CLI 终端（另一个终端）
bash linux/run-cli.sh wizard  # 首次向导

# 4. （可选）构建 Linux GUI
bash linux/build-gui.sh       # 产物：gui/release-linux/Slime-*.AppImage / .deb
```

## 目录结构

```
linux/
├── README.md              本说明
├── setup.sh               一键引导（工具链检查 / venv / pnpm / llama.cpp / 配置生成）
├── build-gui.sh           Linux 版 Electron GUI 构建
├── run-server.sh          后端启动
├── run-cli.sh             CLI 启动
├── slime.toml.linux       可移植配置模板（@PROJECT_ROOT@ 占位符）
└── scripts/
    └── gen-config.sh      模板 → 项目根 slime.toml（备份已有配置）
```

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
- **模型下载**：不在脚本内硬编码下载 URL（避免失效），引导脚本打印建议的 HuggingFace 仓库名，模型文件由你放置。
- **macOS**：同套代码基本可运行，额外需 Apple Silicon 二进制（LanceDB 已支持 darwin-arm64）+ 签名/公证；未在本次范围。

## 路线图

- [x] 孤儿检测 Linux 分支（Python + TS）
- [x] Linux 打包配置（electron-builder + dist:linux 脚本）
- [x] 一键引导脚本 + 可移植配置模板
- [ ] 在真实 Linux/WSL 环境跑通全量 `py qa.py`（当前 Windows 上已验证 Python 单测不受影响）
- [ ] Linux CI（GitHub Actions ubuntu runner）发布 AppImage/deb
- [ ] AMD GPU 的 ROCm VRAM 监控回退