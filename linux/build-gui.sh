#!/usr/bin/env bash
# linux/build-gui.sh — 构建 Linux 版 Electron GUI（AppImage + deb）。
# 在 Linux/WSL 内运行；在 Windows 主机也可用 `cd gui && pnpm run dist:linux`。
# 产物输出到 gui/release-linux/。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT/gui"

# 无头构建（CI/虚拟机无 X 环境时）跳过图标等需要图形栈的步骤
export ELECTRON_DISABLE_SANDBOX=1

echo "[build-gui] 构建 Linux 版（AppImage + deb）..."
if [[ "${1:-}" == "publish" ]]; then
  pnpm run dist:linux:publish
else
  pnpm run dist:linux
fi

echo "[build-gui] 产物："
ls -lh "$ROOT/gui/release-linux/"*.AppImage "$ROOT/gui/release-linux/"*.deb 2>/dev/null || true