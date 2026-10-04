#!/usr/bin/env bash
# gui/scripts/_run-mut-batch.sh —— 批量跑一个 `mut-*.mjs` 的**全部**变异，
# 逐条判「被守卫抓住」并打印**红了哪一条**（供人工对名）。
#
# ## 用法
#   bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1137-search-bridge.mjs \
#        tests/gui/a1137-search-bridge.spec.ts [更多 spec…]
#   条数默认从 `--list` 数出来；要覆盖就 `MUT_COUNT=42 bash …`。
#
# ## 为什么必须走这个套路（本环境 / 本仓的三个硬约束，全是踩过的）
#  1. **禁 node→node 孙进程**（shim 直接 `EBUSY`）⇒ 变异脚本不能自己 spawn vitest。
#     ⇒ 只能由 **shell 顶层**逐条跑：`--apply N` → vitest → `--restore`。
#  2. ⚠️ **vitest 输出带 ANSI 颜色码** ⇒ `grep -E '^ *Tests'` 匹配不到 ⇒
#     会把**每一条**变异都误判成「存活」（实测：42 条全绿却报 `42/42 存活`，白跑一整轮）。
#     ⇒ 必须先剥 ANSI（`STRIP`）。
#  3. ⚠️ **退出码 ≠ 0 也可能不是「被抓住」**：变异把文件改到编译不过时同样是红。
#     ⇒ 判据要**两个条件同时成立**：退出码 ≠ 0 **且** 真有 `Tests … failed` 汇总行。
#  4. ⚠️ 「跑出来是红的」≠「红的是那一条」（铁律 30）⇒ 每条都打印失败用例名。
#  5. ⚠️ 基线不绿时后面所有判读都不可信（一条过期的锚会污染多条变异）⇒ 先卡基线。
set -u
cd "$(dirname "$0")/../.." || exit 1

MUT=${1:?用法：_run-mut-batch.sh <mut脚本> [spec…]}
shift

VITEST=node_modules/vitest/vitest.mjs
STRIP='s/\x1b\[[0-9;]*m//g'

# ⚠️⚠️ 判据 spec 清单**默认从 mut 脚本自己的 `const SPECS = [...]` 读**。
#   为什么必须这样：手写清单漏一份时，变异会**"假存活"却不报错** ——
#   比"没有守卫"更危险（它会让人误以为守住了）。
#   实测事故：`mut-a1155` 的 SPECS 里含 `a1152-float-stability.spec.ts`
#   （退场相关的断言落在那里），而调用方只传了 a1155 自己那份
#   ⇒ M18~M21 四条全部报"存活"，手动补上 a1152 后立刻 19/19 全红。
#   ⇒ 想覆盖就在**脚本里**改 `SPECS`（那是唯一产地）；显式传参仍然优先。
if [ $# -ge 1 ]; then
  SPECS="$*"
else
  SPECS=$(node -e '
    const fs = require("fs");
    const t = fs.readFileSync(process.argv[1], "utf8");
    const m = /const\s+SPECS\s*=\s*\[([\s\S]*?)\]/.exec(t);
    if (!m) { process.exit(1); }
    const files = [...m[1].matchAll(/"([^"]+\.spec\.ts)"/g)].map((x) => x[1]);
    if (!files.length) { process.exit(1); }
    process.stdout.write([...new Set(files)].join(" "));
  ' "$MUT") || { echo "!! 没传 spec，且无法从 $MUT 读出 const SPECS（请显式传 spec）"; exit 2; }
  echo "（未传 spec ⇒ 自动读脚本 SPECS：$SPECS）"
fi

N=${MUT_COUNT:-}
[ -n "$N" ] || N=$(node "$MUT" --list 2>/dev/null | wc -l | tr -d ' ')
[ "${N:-0}" -ge 1 ] || { echo "!! 数不出变异条数（试 MUT_COUNT=<n>）"; exit 2; }

echo "════════ 目标：$MUT（$N 条）"
echo "════════ 判据 spec：$SPECS"
echo "════════ 基线（必须先全绿）════════"
RAW=$(timeout 900 node "$VITEST" run --config vitest.config.ts $SPECS --reporter=dot 2>&1); RC=$?
BASE=$(printf '%s\n' "$RAW" | sed "$STRIP")
if [ "$RC" -ne 0 ] || ! printf '%s\n' "$BASE" | grep -qE "^ *Tests +[0-9]+ passed"; then
  printf '%s\n' "$BASE" | tail -20
  echo "!! 基线不是绿的 ⇒ 后面的「红」全都不可信（铁律 30）"; exit 3
fi
printf '%s\n' "$BASE" | grep -E "Test Files|Tests " | sed 's/^/  /'

CAUGHT=0; SURVIVED=""; ODD=""
for i in $(seq 1 "$N"); do
  if ! node "$MUT" --apply "$i" >/dev/null 2>&1; then
    echo "!! M$i  --apply 失败"; ODD="$ODD $i"; continue
  fi
  # ⚠️⚠️ 兜底还原：apply 成功后**任何**异常路径（timeout 杀 vitest / 用户 Ctrl-C /
  #    本函数被 kill）都必须把源码还原，否则残留的变异体会被当成基线继续开发
  #    （实测事故：a1153 的 M2/M3/M4/M8/M9/M10 六条同时残留，导致 A-1153 四个已修缺陷回归）。
  trap 'node "$MUT" --restore >/dev/null 2>&1' EXIT INT TERM
  RAW=$(timeout 900 node "$VITEST" run --config vitest.config.ts $SPECS --reporter=default 2>&1); RC=$?
  OUT=$(printf '%s\n' "$RAW" | sed "$STRIP")
  if [ "$RC" -ne 0 ] && printf '%s\n' "$OUT" | grep -qE "^ *Tests +[0-9]+ failed"; then
    WHO=$(printf '%s\n' "$OUT" | grep -E "^ *(FAIL|×) " | head -1 | sed -E 's/^ *(FAIL|×) +//' | cut -c1-110)
    echo "✓ M$i  红 → $WHO"; CAUGHT=$((CAUGHT + 1))
  elif [ "$RC" -ne 0 ]; then
    echo "⚠ M$i  退出码 $RC 但**没有** Tests 汇总行（大概改成了编译不过，不算抓住）"; ODD="$ODD $i"
  else
    echo "✗✗ M$i  **存活**"; SURVIVED="$SURVIVED $i"
  fi
  node "$MUT" --restore >/dev/null 2>&1
  trap - EXIT INT TERM
done

echo "════════ 汇总：抓住 $CAUGHT / $N"
echo "     存活：${SURVIVED:-无}"
echo "     异常（无 Tests 行 / apply 失败）：${ODD:-无}"
# ⚠️⚠️ 收尾校验：任何 `_tmp-mut-*` 备份目录残留 = 有变异体没还原 ⇒ 源码停在变异态，
#     绝不能让调用者把它当基线（实测事故见循环里的 trap 注释）。
LEFTOVER=$(ls -d gui/scripts/_tmp-mut-* 2>/dev/null)
if [ -n "$LEFTOVER" ]; then
  echo "❌❌ 检测到未还原的变异备份：$LEFTOVER"
  echo "    ⇒ 源码可能停在变异态。跑 <mut脚本> --restore 后再继续，禁止在此状态开发。"
  exit 4
fi
if [ -z "$SURVIVED" ] && [ -z "$ODD" ]; then
  echo "✅ 全部变异都被守卫抓住"
else
  echo "❌ 有变异没被抓住 —— 换变异点或补守卫（铁律 9/30）"
fi
