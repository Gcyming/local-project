#!/usr/bin/env bash
# linux/run-server.sh — 启动 slime 后端（FastAPI + Bearer 认证）。
# 首启自动生成 config/auth_token.json，后续 API 需携带该 token。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

if [[ -d .venv ]]; then
  source .venv/bin/activate
fi

exec python slime_server.py "$@"