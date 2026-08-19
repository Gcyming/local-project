#!/usr/bin/env bash
# linux/setup.sh — 一键 Linux 环境引导（在 Linux/WSL 中运行）。
#
# 自动完成（无需手动装任何东西）：
#   1. 系统依赖自动安装（Debian/Ubuntu：apt 装 python3/gcc/cmake/git/curl 等）
#   2. Node.js >=20 自动安装（nodesource 官方源）
#   3. pnpm 自动安装（corepack 优先，npm -g 兜底）
#   4. Python venv + requirements.txt
#   5. pnpm install（自动拉取 Linux 版 lancedb / electron 二进制）
#   6. llama.cpp llama-server（预编译下载优先，源码编译回退）
#   7. 从模板生成 slime.toml（可移植路径）
#
# 用法：
#   bash linux/setup.sh                 # 完整引导（推荐）
#   bash linux/setup.sh --skip-llama    # 跳过 llama.cpp 构建
#   bash linux/setup.sh --no-venv       # 不建 venv，直接用系统 python
#   bash linux/setup.sh --no-system     # 不自动安装系统依赖（仅检测提示）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_LLAMA=0
USE_VENV=1
AUTO_SYSTEM=1
for arg in "$@"; do
  case "$arg" in
    --skip-llama) SKIP_LLAMA=1 ;;
    --no-venv) USE_VENV=0 ;;
    --no-system) AUTO_SYSTEM=0 ;;
  esac
done

cd "$ROOT"

echo "================================================================"
echo "  slime Linux 环境引导"
echo "  仓库根: $ROOT"
echo "================================================================"

# ── 工具函数 ─────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1; }

node_major() { node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }

have_sudo() {
  command -v sudo >/dev/null 2>&1
}

# ── 0. 系统依赖自动安装 ─────────────────────────────────────────────
if [[ "$AUTO_SYSTEM" -eq 1 ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "[setup] 安装系统依赖（apt-get: python3/gcc/cmake/git/curl ...）..."
    if have_sudo; then
      sudo apt-get update
      sudo apt-get install -y python3 python3-venv python3-pip git cmake gcc g++ make curl
    else
      apt-get update
      apt-get install -y python3 python3-venv python3-pip git cmake gcc g++ make curl
    fi
    echo "[setup] 系统依赖 OK"
  else
    echo "[setup] 非 Debian/Ubuntu 发行版，请自行安装：python3(3.10+) venv pip git cmake gcc g++ make curl"
  fi
fi

# ── 1. Node.js（>=20）───────────────────────────────────────────────
if ! need node || [[ "$(node_major)" -lt 20 ]]; then
  echo "[setup] 安装 Node.js 22（nodesource 官方源）..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "[setup] ERROR: 请手动安装 Node.js >=20（https://nodejs.org）" >&2
    exit 1
  fi
fi
echo "[setup] node: $(node -v)"

# ── 2. pnpm ─────────────────────────────────────────────────────────
if ! need pnpm; then
  echo "[setup] 安装 pnpm（corepack 优先）..."
  if need corepack; then
    sudo corepack enable 2>/dev/null || corepack enable
    corepack prepare pnpm@latest --activate || true
  fi
  if ! need pnpm; then
    npm install -g pnpm
  fi
fi
echo "[setup] pnpm: $(pnpm -v)"

# ── 3. Python 依赖 ──────────────────────────────────────────────────
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

# ── 4. pnpm install（Linux 原生二进制）──────────────────────────────
# 国内镜像自动适配：apt 源是清华/阿里/中科大/华为等镜像 → 判定国内网络，
# pnpm registry 换 npmmirror + electron 二进制走 npmmirror（防 npmjs 超时）
if grep -rEq "mirrors\.(tuna|aliyun|ustc|huaweicloud)\.com" /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null; then
  echo "[setup] 检测到国内 apt 镜像源，pnpm registry → npmmirror（electron 镜像同步写入 ~/.bashrc）..."
  pnpm config set registry https://registry.npmmirror.com || true
  grep -q 'ELECTRON_MIRROR=' "$HOME/.bashrc" 2>/dev/null || \
    echo 'export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"' >> "$HOME/.bashrc"
  grep -q 'ELECTRON_BUILDER_BINARIES_MIRROR=' "$HOME/.bashrc" 2>/dev/null || \
    echo 'export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"' >> "$HOME/.bashrc"
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
fi
echo "[setup] pnpm install（拉取 Linux 版 lancedb / electron）..."
pnpm install
echo "[setup] pnpm install OK"

# ── 5. llama.cpp ────────────────────────────────────────────────────
if [[ "$SKIP_LLAMA" -eq 1 ]]; then
  echo "[setup] --skip-llama：跳过 llama.cpp 构建"
else
  echo "[setup] 准备 llama.cpp（Linux 版 llama-server）..."
  mkdir -p llama.cpp/build/bin
  LLAMA_BIN="$ROOT/llama.cpp/build/bin/llama-server"
  if [[ -x "$LLAMA_BIN" ]]; then
    echo "[setup] 已存在 $LLAMA_BIN，跳过"
  else
    # 5a. 优先下载官方预编译 CPU 版（GitHub 直连失败 → 自动试国内代理前缀）
    DL_OK=0
    if need curl; then
      echo "[setup] 尝试下载 llama.cpp 预编译二进制..."
      GH_BASE="https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
      GH_PREFIX=""
      LATEST=$(curl -fsSL --max-time 30 "$GH_BASE" 2>/dev/null || true)
      if [[ -z "$LATEST" ]]; then
        for proxy in "${GH_PROXY:-}" "https://ghfast.top/" "https://gh-proxy.com/" "https://ghproxy.net/"; do
          [[ -z "$proxy" ]] && continue
          LATEST=$(curl -fsSL --max-time 30 "${proxy}${GH_BASE}" 2>/dev/null || true)
          if [[ -n "$LATEST" ]]; then GH_PREFIX="$proxy"; break; fi
        done
      fi
      ASSET=$(printf '%s' "$LATEST" | grep -o '"browser_download_url": *"[^"]*bin-ubuntu-x64.zip"' | head -1 | cut -d'"' -f4 || true)
      if [[ -n "$ASSET" ]]; then
        TMPZIP="$(mktemp -d)/llama.zip"
        URL="$ASSET"
        [[ -n "$GH_PREFIX" ]] && URL="${GH_PREFIX}${ASSET}"
        if curl -fSL --max-time 300 -o "$TMPZIP" "$URL" 2>/dev/null; then
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
    # 5b. 回退：源码编译（github 克隆失败 → gitee 官方镜像）
    if [[ "$DL_OK" -eq 0 ]]; then
      echo "[setup] 预编译下载失败，改源码编译..."
      if ! need git || ! need cmake || ! need make; then
        echo "[setup] ERROR: 缺少 git/cmake/make，源码编译不可用（--skip-llama 可跳过）" >&2
      else
        if [[ ! -d llama.cpp/.git ]]; then
          rm -rf .llama-src
          echo "[setup] git clone llama.cpp（github 优先，gitee 兜底）..."
          if git clone --depth 1 https://github.com/ggml-org/llama.cpp.git .llama-src 2>/dev/null \
             || git clone --depth 1 https://gitee.com/mirrors/llama.cpp.git .llama-src 2>/dev/null; then
            # llama.cpp/ 里已有 setup 预建的 build/bin 空目录，git clone 无法写入非空目录，
            # 整体替换后再补回 build/bin
            mv .llama-src llama.cpp.new
            rm -rf llama.cpp
            mv llama.cpp.new llama.cpp
            mkdir -p llama.cpp/build/bin
          else
            echo "[setup] 源码克隆失败（网络受限时请手动放置 llama-server 到 $LLAMA_BIN）" >&2
          fi
        fi
        if [[ -d llama.cpp/.git ]]; then
          cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF
          cmake --build llama.cpp/build --target llama-server -j"$(nproc)"
        fi
      fi
    fi
    if [[ -x "$LLAMA_BIN" ]]; then
      echo "[setup] llama-server 就绪: $LLAMA_BIN"
    else
      echo "[setup] WARNING: llama-server 未就绪。请手动放置 Linux 版二进制到 $LLAMA_BIN"
    fi
  fi
fi

# ── 6. 生成 slime.toml ─────────────────────────────────────────────
bash "$SCRIPT_DIR/scripts/gen-config.sh" --root "$ROOT" --force

# ── 7. 模型放置指引 ────────────────────────────────────────────────
echo ""
echo "================================================================"
echo "  下一步：下载模型（一键脚本，hf-mirror 国内镜像 + 断点续传）"
echo "    bash linux/fetch-models.sh"
echo "  将下载："
echo "    $ROOT/models/BGE-M3/bge-m3-q8_0.gguf    （嵌入模型 635MB，必需）"
echo "    $ROOT/models/chat/qwen3-1.7b-q8_0.gguf  （对话模型 1.83GB）"
echo ""
echo "  启动方式（在仓库根执行）："
echo "    后端:  python slime_server.py          # 或 bash linux/run-server.sh"
echo "    CLI:   python slime_cli.py             # 或 bash linux/run-cli.sh"
echo "    GUI:   bash linux/build-gui.sh         # 构建 AppImage + deb"
echo "  分发别人用时（免装任何依赖）："
echo "    bash linux/build-portable.sh           # 产出 dist/slime-linux-x64.tar.gz"
echo "================================================================"