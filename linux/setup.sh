#!/usr/bin/env bash
# linux/setup.sh — 一键 Linux 环境引导（在 Linux/WSL 中运行）。
#
# 作用：
#   1. 检查基础工具链（python3/node/pnpm/git/cmake/gcc）
#   2. 创建 Python venv 并安装 requirements.txt
#   3. pnpm install（自动拉取 Linux 版 lancedb / electron 二进制）
#   4. 构建/下载 llama.cpp llama-server（Linux 版本地推理引擎）
#   5. 从模板生成 slime.toml（可移植路径）
#   6. 输出模型放置指引与启动命令
#
# 用法：
#   bash linux/setup.sh                 # 完整引导
#   bash linux/setup.sh --skip-llama    # 跳过 llama.cpp 构建（仅装依赖+生成配置）
#   bash linux/setup.sh --no-venv       # 不建 venv，直接用系统 python
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_LLAMA=0
USE_VENV=1
for arg in "$@"; do
  case "$arg" in
    --skip-llama) SKIP_LLAMA=1 ;;
    --no-venv) USE_VENV=0 ;;
  esac
done

cd "$ROOT"

echo "================================================================"
echo "  slime Linux 环境引导"
echo "  仓库根: $ROOT"
echo "================================================================"

# ── 1. 工具链检查 ────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "[setup] 缺少 $1（$2）" >&2; return 1; }; }
need python3 "Python 3.10+，如 apt install python3 python3-venv" || exit 1
need node "Node.js 20.19+，如 https://nodejs.org 或 apt install nodejs" || exit 1
need pnpm "pnpm 9+，如 npm i -g pnpm 或 corepack enable" || exit 1

PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
if [[ "$PY_MAJOR" -lt 3 || "$PY_MINOR" -lt 10 ]]; then
  echo "[setup] ERROR: 需要 Python 3.10+，当前 $PY_MAJOR.$PY_MINOR" >&2
  exit 1
fi

# ── 2. Python 依赖 ───────────────────────────────────────────────
if [[ "$USE_VENV" -eq 1 ]]; then
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  echo "[setup] 已激活 venv: $(python -c 'import sys; print(sys.executable)')"
fi
echo "[setup] 安装 Python 依赖（requirements.txt）..."
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo "[setup] Python 依赖 OK"

# ── 3. pnpm install（Linux 原生二进制）─────────────────────────
echo "[setup] pnpm install（拉取 Linux 版 lancedb / electron）..."
pnpm install
echo "[setup] pnpm install OK"

# ── 4. llama.cpp ────────────────────────────────────────────────
if [[ "$SKIP_LLAMA" -eq 1 ]]; then
  echo "[setup] --skip-llama：跳过 llama.cpp 构建"
else
  echo "[setup] 准备 llama.cpp（Linux 版 llama-server）..."
  mkdir -p llama.cpp/build/bin
  LLAMA_BIN="$ROOT/llama.cpp/build/bin/llama-server"
  if [[ -x "$LLAMA_BIN" ]]; then
    echo "[setup] 已存在 $LLAMA_BIN，跳过"
  else
    # 4a. 优先下载官方预编译 CPU 版
    DL_OK=0
    if need curl "curl（下载预编译包，如 apt install curl）" 2>/dev/null; then
      echo "[setup] 尝试下载 llama.cpp 预编译二进制..."
      LATEST=$(curl -fsSL --max-time 30 https://api.github.com/repos/ggml-org/llama.cpp/releases/latest 2>/dev/null || true)
      ASSET=$(printf '%s' "$LATEST" | grep -o '"browser_download_url": *"[^"]*bin-ubuntu-x64.zip"' | head -1 | cut -d'"' -f4 || true)
      if [[ -n "$ASSET" ]]; then
        TMPZIP="$(mktemp -d)/llama.zip"
        if curl -fSL --max-time 300 -o "$TMPZIP" "$ASSET" 2>/dev/null; then
          python - "$TMPZIP" "$ROOT/llama.cpp/build/bin" <<'PY'
import sys, zipfile, shutil, os
zp, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zp) as z:
    for name in z.namelist():
        if os.path.basename(name) == "llama-server":
            with z.open(name) as src, open(os.path.join(out, "llama-server"), "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(os.path.join(out, "llama-server"), 0o755)
PY
          if [[ -x "$LLAMA_BIN" ]]; then DL_OK=1; fi
        fi
      fi
    fi
    # 4b. 回退：源码编译
    if [[ "$DL_OK" -eq 0 ]]; then
      echo "[setup] 预编译下载失败，改源码编译..."
      need git "git（源码编译用，如 apt install git）" || exit 1
      need cmake "cmake（如 apt install cmake）" || exit 1
      need make "make（如 apt install build-essential）" || exit 1
      if [[ ! -d llama.cpp/.git ]]; then
        git clone --depth 1 https://github.com/ggml-org/llama.cpp.git llama.cpp 2>/dev/null \
          || { echo "[setup] 源码克隆失败（网络受限时请手动放置 llama-server 到 $LLAMA_BIN）" >&2; }
      fi
      if [[ -d llama.cpp/.git ]]; then
        cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF
        cmake --build llama.cpp/build --target llama-server -j"$(nproc)"
      fi
    fi
    if [[ -x "$LLAMA_BIN" ]]; then
      echo "[setup] llama-server 就绪: $LLAMA_BIN"
    else
      echo "[setup] WARNING: llama-server 未就绪。请手动放置 Linux 版二进制到 $LLAMA_BIN"
    fi
  fi
fi

# ── 5. 生成 slime.toml ─────────────────────────────────────────
bash "$SCRIPT_DIR/scripts/gen-config.sh" --root "$ROOT" --force

# ── 6. 模型放置指引 ────────────────────────────────────────────
echo ""
echo "================================================================"
echo "  下一步：放置模型文件"
echo "  嵌入模型（必须，检索/记忆依赖）："
echo "  $ROOT/models/BGE-M3/bge-m3-q8_0.gguf"
echo "    建议来源：HuggingFace 的 bge-m3 量化仓库（Q8_0 版本，如 plamoai/bge-m3-gguf）"
echo "  Chat 模型（对话推理，任选一个 GGUF）："
echo "    $ROOT/models/chat/qwen3-1.7b-q8_0.gguf 等"
echo "    建议来源：Qwen/Qwen3-1.7B-GGUF 等官方量化仓库"
echo ""
echo "  启动方式（在仓库根执行）："
echo "    后端:  python slime_server.py          # 或 bash linux/run-server.sh"
echo "    CLI:   python slime_cli.py             # 或 bash linux/run-cli.sh"
echo "    GUI:   bash linux/build-gui.sh         # 构建 AppImage + deb"
echo "================================================================"