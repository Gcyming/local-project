#!/usr/bin/env bash
# gui/scripts/capture-llama-fixtures.sh
#
# 抓取 llama-server 的**就绪态 / 加载态**真实夹具，供 tests/core-ts/model-introspect.spec.ts 使用。
#
# 为什么要脚本而不是手抄：夹具必须**逐字节来自真实响应**（含 HTTP 状态码），
# 手写会把"我以为的字段名"当成事实 —— 正是 A-1018 ③ 的成因。
#
# 用法（在仓库根）：
#   bash gui/scripts/capture-llama-fixtures.sh <llama-server.exe> <model.gguf> [port]
#
# ⚠️ 路径坑：仓库根是 "…/pilot project"（**含空格**）。msys 把 `/d/...` 形态的绝对路径
#    传给 Windows 版 curl 时会翻译失败 —— 表现是 curl 静默不落盘、紧接着 cp 报
#    `cannot stat`。所以本脚本 `cd "$ROOT"` 后**一律用相对路径**。
#
# ⚠️ `*.loading.*` 只有在**加载真的还没结束**时才拿得到：脚本先抢加载态窗口，再等就绪态。
#    若先看到 200 说明窗口已错过（脚本会明确报错而不是拿就绪态冒充加载态）。

set -u
BIN="$1"
MODEL="$2"
PORT="${3:-8871}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
OUT="tests/fixtures/llama"
TMP=".workbuddy/_cap.$$"
mkdir -p "$OUT"

# 端口占用则先清掉（PID 提取失败就放弃，别误杀别人）
OLD=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | head -1 | awk '{print $NF}')
if [ -n "${OLD:-}" ]; then MSYS_NO_PATHCONV=1 taskkill /PID "$OLD" /T /F >/dev/null 2>&1 || true; sleep 1; fi

"$BIN" -m "$MODEL" -c 8192 --port "$PORT" -ngl 0 >".workbuddy/llama-capture.log" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

SNAP() { # SNAP <tag>  —— 把三个端点**同一瞬间**各抓一次（状态码与响应体同批落盘，杜绝错位）
  for ep in props:props models:v1/models health:health; do
    name="${ep%%:*}"; path="${ep##*:}"
    code=$(curl -s -m 2 -o "$OUT/$name.$1.json" -w "%{http_code}" "http://127.0.0.1:$PORT/$path" 2>/dev/null)
    echo "$code" > "$OUT/$name.$1.status"
  done
}

LOADING_OK=0; READY_OK=0
for i in $(seq 1 1200); do
  pcode=$(curl -s -m 1 -o "$TMP.p" -w "%{http_code}" "http://127.0.0.1:$PORT/props" 2>/dev/null)
  if [ "$pcode" = "503" ] && [ "$LOADING_OK" = "0" ]; then
    SNAP loading
    LOADING_OK=1
    echo "loading @poll $i  props=$(cat "$OUT/props.loading.status") models=$(cat "$OUT/models.loading.status") health=$(cat "$OUT/health.loading.status")"
    echo "  props  $(cat "$OUT/props.loading.json")"
    echo "  health $(cat "$OUT/health.loading.json")"
  fi
  if [ "$pcode" = "200" ]; then
    SNAP ready
    READY_OK=1
    echo "ready @poll $i"
    break
  fi
done
rm -f "$TMP".p

[ "$LOADING_OK" = "1" ] || echo "ERROR: 没抓到加载态（窗口被错过）" >&2
[ "$READY_OK"   = "1" ] || echo "ERROR: 没抓到就绪态" >&2
[ "$LOADING_OK" = "1" ] && [ "$READY_OK" = "1" ] || exit 2
ls -la "$OUT"
