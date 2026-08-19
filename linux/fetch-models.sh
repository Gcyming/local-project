#!/usr/bin/env bash
# linux/fetch-models.sh — 一键下载模型（国内走 hf-mirror.com 镜像，支持断点续传）。
#
#   bash linux/fetch-models.sh              # 下载全部（推荐）
#   bash linux/fetch-models.sh --chat-only  # 只下对话模型（已有嵌入模型时）
#   bash linux/fetch-models.sh --bge-only   # 只下嵌入模型
#
# 模型来源（官方仓库，仅换镜像域名）：
#   BGE-M3  Q8_0  → ggml-org/bge-m3-Q8_0-GGUF   （635 MB，嵌入/检索必需）
#   Qwen3 1.7B Q8_0 → Qwen/Qwen3-1.7B-GGUF      （1.83 GB，对话推理）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

FETCH_BGE=1
FETCH_CHAT=1
for arg in "$@"; do
  case "$arg" in
    --chat-only) FETCH_BGE=0 ;;
    --bge-only) FETCH_CHAT=0 ;;
  esac
done

mkdir -p models/BGE-M3 models/chat

fetch() {
  local url="$1" out="$2"
  echo "[models] $out"
  local remote=""
  remote=$(curl -sIL --max-time 15 "$url" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{len=$2} END{print len}')
  if [[ -f "$out" ]]; then
    local local_size
    local_size=$(stat -c%s "$out")
    if [[ -n "$remote" ]] && [[ "$local_size" -ge "$remote" ]] && [[ "$local_size" -gt 0 ]]; then
      echo "  已完整存在（$local_size 字节），跳过"
      return 0
    fi
    echo "  续传（本地 $local_size / 远端 ${remote:-未知} 字节）..."
  fi
  curl -fL --retry 5 --retry-delay 3 -C - -o "$out" "$url"
  echo "  完成: $(du -h "$out" | cut -f1)"
}

if [[ "$FETCH_BGE" -eq 1 ]]; then
  fetch "https://hf-mirror.com/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf" \
        "models/BGE-M3/bge-m3-q8_0.gguf"
fi

if [[ "$FETCH_CHAT" -eq 1 ]]; then
  fetch "https://hf-mirror.com/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf" \
        "models/chat/qwen3-1.7b-q8_0.gguf"
fi

echo ""
echo "[models] 全部就绪："
du -h models/BGE-M3/*.gguf models/chat/*.gguf
echo "启动：bash linux/run-server.sh（后端）+ bash linux/run-cli.sh（CLI）"