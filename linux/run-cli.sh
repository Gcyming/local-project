#!/usr/bin/env bash
# linux/run-cli.sh — 启动 slime CLI 终端。
# 自动读取 auth_token 携带认证；首次使用可先运行 `python slime_cli.py wizard`。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

if [[ -d .venv ]]; then
  source .venv/bin/activate
fi

exec python slime_cli.py "$@"