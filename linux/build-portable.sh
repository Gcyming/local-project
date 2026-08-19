#!/usr/bin/env bash
# linux/build-portable.sh — 产出自包含便携发行包（免安装任何依赖）。
#
# 产物：dist/slime-linux-x64.tar.gz
# 解压即用：内置 Node 运行时 + Python 运行时 + venv（requirements 已装）+
#          node_modules（Linux 原生 lancedb/electron 已装）+ llama-server + 源码。
# 接收方只需：tar 解压 → ./run-cli.sh（或 ./run-server.sh / ./run-gui.sh）。
# 唯一仍需自备：模型 GGUF 文件（体积大 + 许可证，不入包）。
#
# 构建机要求：linux x64 + python3(3.10+，解析 JSON/建 venv) + curl + git + tar + gcc/cmake（仅 llama 编译回退时）
# 用法：
#   bash linux/build-portable.sh                    # 完整构建
#   bash linux/build-portable.sh --skip-llama       # 跳过 llama-server（需自带）
#   bash linux/build-portable.sh --keep-staging     # 保留 dist/slime-linux-x64 便于调试
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_LLAMA=0
KEEP_STAGING=0
for arg in "$@"; do
  case "$arg" in
    --skip-llama) SKIP_LLAMA=1 ;;
    --keep-staging) KEEP_STAGING=1 ;;
  esac
done

DIST="$ROOT/dist"
KIT="$DIST/slime-linux-x64"

# 网络下载代理（国内网络可设 ELECTRON_MIRROR/镜像，默认直连官方源）
ELECTRON_MIRROR="${ELECTRON_MIRROR:-}"
GH_PROXY="${GH_PROXY:-}"   # 例：https://ghproxy.com/ 前缀

cd "$ROOT"
echo "================================================================"
echo "  slime 便携发行包构建"
echo "  输出: $KIT -> $DIST/slime-linux-x64.tar.gz"
echo "================================================================"

for t in python3 curl git tar; do
  command -v "$t" >/dev/null 2>&1 || { echo "[portable] ERROR: 缺少 $t" >&2; exit 1; }
done

# ── 1. 源码（git archive：仅已提交文件，干净无垃圾） ────────────────
rm -rf "$KIT"
mkdir -p "$KIT"
git archive HEAD | tar -x -C "$KIT"
echo "[portable] 源码就绪（git archive HEAD）"

# ── 2. Node 运行时（最新 LTS，x64 linux） ──────────────────────────
NODE_DIR="$KIT/runtime/node"
mkdir -p "$KIT/runtime"
NODE_VER=$(python3 - <<'PY'
import json, urllib.request
d = json.load(urllib.request.urlopen("https://nodejs.org/dist/index.json", timeout=30))
for e in d:
    if e.get("lts"):
        print(e["version"]); break
PY
)
NODE_URL="https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
echo "[portable] 下载 Node $NODE_VER ..."
curl -fSL --max-time 300 -o /tmp/node.tar.xz "$NODE_URL"
mkdir -p "$NODE_DIR"
tar -xJf /tmp/node.tar.xz -C "$NODE_DIR" --strip-components=1
rm -f /tmp/node.tar.xz
# 只保留可执行运行时（node/npm/npx），清掉文档体积
rm -rf "$NODE_DIR/include" "$NODE_DIR/share" "$NODE_DIR/lib/node_modules/npm/docs" 2>/dev/null || true
echo "[portable] Node 就绪: $("$NODE_DIR/bin/node" -v)"

# ── 3. pnpm（装进 runtime node 前缀，随包分发） ────────────────────
"$NODE_DIR/bin/npm" install -g pnpm
export PATH="$NODE_DIR/bin:$PATH"
echo "[portable] pnpm 就绪: $(pnpm -v)"

# ── 4. Python 运行时（python-build-standalone 可移植解释器） ────────
PYTHON_DIR="$KIT/runtime/python"
PY_URL=""
PY_URL=$(python3 - <<'PY'
import json, urllib.request
try:
    d = json.load(urllib.request.urlopen(
        "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest",
        timeout=30))
    for a in d["assets"]:
        n = a["name"]
        if n.startswith("cpython-3.10.") and "x86_64-unknown-linux-gnu-install_only" in n and n.endswith(".tar.gz"):
            print(a["browser_download_url"]); break
except Exception:
    pass
PY
)
BASE_PY=python3   # venv 基础解释器（standalone 下载失败时回退系统 python）
if [[ -n "$PY_URL" ]]; then
  echo "[portable] 下载便携 Python ..."
  curl -fSL --max-time 600 -o /tmp/py.tar.gz "$PY_URL" || PY_URL=""
  if [[ -n "$PY_URL" ]]; then
    mkdir -p "$PYTHON_DIR"
    tar -xzf /tmp/py.tar.gz -C "$PYTHON_DIR" --strip-components=1
    rm -f /tmp/py.tar.gz
    BASE_PY="$PYTHON_DIR/bin/python3"
    echo "[portable] Python 就绪: $("$BASE_PY" --version)"
  fi
fi

# ── 5. venv（--copies：standalone 解释器 + 完整拷贝 = 可迁移） ──────
"$BASE_PY" -m venv --copies "$KIT/runtime/venv"
export PATH="$KIT/runtime/venv/bin:$PATH"
python -m pip install --upgrade pip
python -m pip install -r "$KIT/requirements.txt"
echo "[portable] venv 就绪: $(python --version)"

# ── 6. pnpm install（Linux 原生二进制：lancedb/electron 等） ───────
cd "$KIT"
echo "[portable] pnpm install（若 Electron 下载慢，可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）..."
pnpm install
echo "[portable] pnpm install OK"

# ── 7. GUI 预构建（out/ 不入库，此处产出） ─────────────────────────
echo "[portable] 构建 GUI 渲染产物（electron-vite build）..."
cd "$KIT/gui"
"$KIT/node_modules/.bin/electron-vite" build
cd "$KIT"

# ── 8. llama-server（复用 setup.sh 策略：预编译优先，源码回退） ─────
if [[ "$SKIP_LLAMA" -eq 1 ]]; then
  echo "[portable] --skip-llama：跳过"
else
  echo "[portable] 获取 llama-server ..."
  mkdir -p "$KIT/llama.cpp/build/bin"
  LLAMA_BIN="$KIT/llama.cpp/build/bin/llama-server"
  DL_OK=0
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
    if curl -fSL --max-time 600 -o "$TMPZIP" "$URL" 2>/dev/null; then
      python - "$TMPZIP" "$KIT/llama.cpp/build/bin" <<'PY'
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
  if [[ "$DL_OK" -eq 0 ]]; then
    echo "[portable] 预编译下载失败 → 源码编译（需 gcc/cmake/git/make）..."
    if [[ ! -d "$KIT/llama.cpp/.git" ]]; then
      rm -rf "$KIT/.llama-src"
      git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$KIT/.llama-src" 2>/dev/null \
        || git clone --depth 1 https://gitee.com/mirrors/llama.cpp.git "$KIT/.llama-src" 2>/dev/null || true
      if [[ -d "$KIT/.llama-src/.git" ]]; then
        mv "$KIT/.llama-src" "$KIT/llama.cpp.new"
        rm -rf "$KIT/llama.cpp"
        mv "$KIT/llama.cpp.new" "$KIT/llama.cpp"
        mkdir -p "$KIT/llama.cpp/build/bin"
      fi
    fi
    if [[ -d "$KIT/llama.cpp/.git" ]]; then
      cmake -S "$KIT/llama.cpp" -B "$KIT/llama.cpp/build" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF
      cmake --build "$KIT/llama.cpp/build" --target llama-server -j"$(nproc)"
    fi
  fi
  [[ -x "$LLAMA_BIN" ]] && echo "[portable] llama-server 就绪" || echo "[portable] WARNING: llama-server 缺失"
fi

# ── 9. 配置 + 模型目录 + 入口脚本 ─────────────────────────────────
bash "$KIT/linux/scripts/gen-config.sh" --root "$KIT" --force
mkdir -p "$KIT/models/BGE-M3" "$KIT/models/chat"
echo "把模型放到这里后生效：" > "$KIT/models/README.txt"
echo "  models/BGE-M3/bge-m3-q8_0.gguf   （嵌入模型，必需）" >> "$KIT/models/README.txt"
echo "  models/chat/*.gguf               （对话模型）" >> "$KIT/models/README.txt"

cat > "$KIT/run-cli.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$KIT/runtime/node/bin:$KIT/runtime/venv/bin:$PATH"
if [[ ! -f "$KIT/slime.toml" ]]; then
  bash "$KIT/linux/scripts/gen-config.sh" --root "$KIT" --force
fi
cd "$KIT"
exec python slime_cli.py "$@"
EOF

cat > "$KIT/run-server.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$KIT/runtime/node/bin:$KIT/runtime/venv/bin:$PATH"
if [[ ! -f "$KIT/slime.toml" ]]; then
  bash "$KIT/linux/scripts/gen-config.sh" --root "$KIT" --force
fi
cd "$KIT"
exec python slime_server.py "$@"
EOF

cat > "$KIT/run-gui.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$KIT/runtime/node/bin:$KIT/runtime/venv/bin:$PATH"
export ELECTRON_DISABLE_SANDBOX=1
if [[ ! -f "$KIT/slime.toml" ]]; then
  bash "$KIT/linux/scripts/gen-config.sh" --root "$KIT" --force
fi
cd "$KIT/gui"
exec "$KIT/runtime/node/bin/node" "$KIT/node_modules/electron/cli.js" .
EOF

chmod +x "$KIT/run-cli.sh" "$KIT/run-server.sh" "$KIT/run-gui.sh"
echo "[portable] 入口脚本就绪: run-cli.sh / run-server.sh / run-gui.sh"

# ── 10. 打包 ──────────────────────────────────────────────────────
cd "$DIST"
tar -czf slime-linux-x64.tar.gz slime-linux-x64
if [[ "$KEEP_STAGING" -eq 0 ]]; then
  rm -rf "$KIT"
fi
echo ""
echo "================================================================"
echo "  构建完成: $DIST/slime-linux-x64.tar.gz"
ls -lh "$DIST/slime-linux-x64.tar.gz"
echo ""
echo "  接收方使用（零依赖）："
echo "    tar -xzf slime-linux-x64.tar.gz && cd slime-linux-x64"
echo "    ./run-cli.sh wizard      # 首次向导"
echo "    ./run-cli.sh             # CLI"
echo "    模型放入 models/ 后即可对话"
echo "================================================================"