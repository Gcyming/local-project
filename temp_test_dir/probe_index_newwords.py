"""决定性检验：当前(乱码) index.ts 里是否存在 HEAD 中不存在的「新标识符」。

逻辑：
  · 乱码会**吃掉**字符（把 ASCII 字母吞进 GBK 字节对），所以「HEAD 有、当前没有」
    不能证明删改 —— 那是假阳性。
  · 但反过来：**当前文件里出现一个 HEAD 完全没有的长 ASCII 标识符**，
    乱码不可能凭空造出标识符 ⇒ 那必然是用户新增的代码。
所以：只找 cur - head 方向的「新词」，就能判定是否存在未提交改动。
只读。
"""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "gui/src/main/index.ts"

head = subprocess.run(
    ["git", "-C", str(ROOT), "show", f"HEAD:{REL}"],
    capture_output=True, check=True,
).stdout.decode("utf-8-sig")
cur = (ROOT / REL).read_text(encoding="utf-8-sig")

WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]{7,}")  # ≥8 字符的 ASCII 标识符


def words(text: str) -> set:
    return set(WORD.findall(text))


hw = words(head)
cw = words(cur)

print(f"HEAD 长标识符种类: {len(hw)}")
print(f"当前 长标识符种类: {len(cw)}")
print()

new_in_cur = sorted(cw - hw)
print(f"=== 当前有、HEAD 没有的长标识符: {len(new_in_cur)} 个 ===")
if new_in_cur:
    for w in new_in_cur[:60]:
        print(f"    {w}")
    if len(new_in_cur) > 60:
        print(f"    ...（还有 {len(new_in_cur)-60} 个）")
else:
    print("    （无）")
print()

# 噪音基线：反向（HEAD 有、当前没有）必然很多，那是乱码吃字，用来做对照
miss = sorted(hw - cw)
print(f"=== 对照：HEAD 有、当前没有的长标识符: {len(miss)} 个（乱码吃字造成，属噪音）===")
for w in miss[:15]:
    print(f"    {w}")
if len(miss) > 15:
    print(f"    ...（还有 {len(miss)-15} 个）")
print()

# 逐个核验「新词」是否只是某个 HEAD 词的吃字变体
def is_corruption_of(word: str, pool: set) -> bool:
    """word 去掉若干字符后能否等于 pool 里某个词（吃字方向）。"""
    if word in pool:
        return True
    for p in pool:
        if len(p) < len(word):
            continue
        # word 是 p 的子序列（允许吃字）
        it = iter(p)
        if all(ch in it for ch in word):
            return True
    return False


real_new = [w for w in new_in_cur if not is_corruption_of(w, hw)]
print(f"=== 剔除「吃字变体」后，真正的新标识符: {len(real_new)} 个 ===")
if real_new:
    for w in real_new[:60]:
        print(f"    {w}")
    print()
    print(">>> 结论：存在新标识符 ⇒ 该文件在我改动前**有用户未提交的改动，不可从 HEAD 回滚**")
else:
    print("    （无）")
    print()
    print(">>> 结论：未发现任何新标识符 ⇒ 该文件在我改动前 == HEAD，可从 HEAD 安全恢复")
