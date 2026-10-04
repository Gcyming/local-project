"""量化 index.ts 残余损伤的可修复性。只读。

把含 U+FFFD 的**代码行**（非纯注释）分成两类：
  · HEAD 里有近似对应行 → 可从 HEAD 取回原文（自动可修）
  · HEAD 里没有对应行     → 用户新代码，无参照（需人工/用户确认）
近似判据：剥掉非 ASCII 后的 ASCII 骨架相同。
"""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "gui/src/main/index.ts"
SRC = ROOT / REL

cur = SRC.read_text(encoding="utf-8")
head = subprocess.run(
    ["git", "-C", str(ROOT), "show", f"HEAD:{REL}"],
    capture_output=True, check=True,
).stdout.decode("utf-8-sig").replace("\r\n", "\n")

cur_lines = cur.replace("\r\n", "\n").split("\n")
head_lines = head.split("\n")


def skel(s: str) -> str:
    """ASCII 骨架：去掉非 ASCII 与丢失位，只留代码结构"""
    return "".join(ch for ch in s if 0x20 <= ord(ch) <= 0x7E and ch not in "?").strip()


head_skels = {}
for ln in head_lines:
    k = skel(ln)
    if k:
        head_skels.setdefault(k, ln)

bad_code = []
for n, ln in enumerate(cur_lines, 1):
    if "\uFFFD" not in ln:
        continue
    s = ln.strip()
    if s.startswith(("//", "*", "/*", "*/")):
        continue
    code_part = s.split("//")[0]
    if "\uFFFD" not in code_part:
        continue
    bad_code.append((n, ln))

recoverable = []
lost = []
for n, ln in bad_code:
    k = skel(ln)
    if k and k in head_skels:
        recoverable.append((n, ln, head_skels[k]))
    else:
        lost.append((n, ln))

print(f"含损伤的代码行总数: {len(bad_code)}")
print(f"  · 能从 HEAD 取回原文（骨架命中）: {len(recoverable)}")
print(f"  · HEAD 无对应（你的新代码/已改动）: {len(lost)}")
print()

print("=== 可从 HEAD 恢复的样例（前 8 条）===")
for n, bad, good in recoverable[:8]:
    print(f"  L{n}")
    print(f"    坏: {bad.strip()[:120]}")
    print(f"    好: {good.strip()[:120]}")
print()

print("=== 无参照、需人工确认的样例（前 25 条）===")
for n, ln in lost[:25]:
    print(f"  L{n:<6} {ln.strip()[:130]}")
if len(lost) > 25:
    print(f"  ...（还有 {len(lost)-25} 条）")
print()

# 纯注释行的损伤量（不影响编译）
comment_bad = 0
for ln in cur_lines:
    if "\uFFFD" not in ln:
        continue
    s = ln.strip()
    if s.startswith(("//", "*", "/*", "*/")):
        comment_bad += 1
    elif "\uFFFD" not in s.split("//")[0]:
        comment_bad += 1
print(f"纯注释/行尾注释受损行数: {comment_bad}（不影响编译，但可读性受损）")
print(f"合计受损行: {comment_bad + len(bad_code)} / {len(cur_lines)}")
