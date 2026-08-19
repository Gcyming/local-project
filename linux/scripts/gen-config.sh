#!/usr/bin/env bash
# linux/scripts/gen-config.sh — 从 slime.toml.linux 模板生成项目根 slime.toml。
# 用法：
#   bash linux/scripts/gen-config.sh [--force] [--root <仓库根>]
#   --force    覆盖已存在的 slime.toml（默认备份为 slime.toml.bak 后生成）
#   --root     指定仓库根（默认取本脚本所在目录的上一级）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ "${1:-}" == "--root" ]]; then
  ROOT="$(cd "$2" && pwd)"
  shift 2
fi

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

TEMPLATE="$(dirname "$SCRIPT_DIR")/slime.toml.linux"
TARGET="$ROOT/slime.toml"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[gen-config] ERROR: 模板不存在: $TEMPLATE" >&2
  exit 1
fi

if [[ -f "$TARGET" ]]; then
  if [[ "$FORCE" -eq 0 ]]; then
    echo "[gen-config] 已存在 $TARGET，跳过（用 --force 覆盖，原文件备份为 slime.toml.bak）"
    exit 0
  fi
  cp "$TARGET" "$TARGET.bak"
  echo "[gen-config] 已备份原配置 → $TARGET.bak"
fi

# 模板内 @PROJECT_ROOT@ → 仓库根绝对路径（转义 & 防止 sed 误解析）
ESCAPED_ROOT=$(printf '%s' "$ROOT" | sed 's/[&\\/]/\\&/g')
sed "s|@PROJECT_ROOT@|$ESCAPED_ROOT|g" "$TEMPLATE" > "$TARGET"

# 创建模型目录约定
mkdir -p "$ROOT/models/BGE-M3" "$ROOT/models/chat" "$ROOT/llama.cpp/build/bin" 2>/dev/null || true

echo "[gen-config] 已生成: $TARGET"
echo "[gen-config] 模型目录约定（请放置文件）："
echo "  $ROOT/models/BGE-M3/bge-m3-q8_0.gguf   （嵌入模型）"
echo "  $ROOT/models/chat/*.gguf               （Chat 模型）"
echo "  $ROOT/llama.cpp/build/bin/llama-server （llama.cpp 构建产物，setup.sh 自动处理）"