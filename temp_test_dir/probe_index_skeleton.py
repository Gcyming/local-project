"""决定性判定：gui/src/main/index.ts 在我改动前是否与 HEAD 一致？

思路：乱码只影响**非 ASCII 字符**。把两边都剥成「ASCII 骨架」（丢掉所有非 ASCII
与丢失位 '?'），逐行比对：
  · 若骨架逐行一致（除我预期的 5 处纯 ASCII 类型串改动）→ 该文件原本 == HEAD，可安全从 HEAD 恢复
  · 若骨架出现结构性差异 → 存在用户未提交的真实改动，**不可回滚**
只读。
"""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "gui/src/main/index.ts"
PATH = ROOT / REL

head_raw = subprocess.run(
    ["git", "-C", str(ROOT), "show", f"HEAD:{REL}"],
    capture_output=True, check=True,
).stdout.decode("utf-8-sig")
head = head_raw.replace("\r\n", "\n").replace("\r", "\n")

cur = PATH.read_text(encoding="utf-8-sig")


def skeleton(line: str) -> str:
    """保留 ASCII 可见字符，丢掉非 ASCII、丢掉丢失位 '?' 与替换符。

    这样「中文内容」在两边都被抹平 —— 剩下的就是代码结构。
    """
    out = []
    for ch in line:
        o = ord(ch)
        if 0x20 <= o <= 0x7E and ch not in "?\uFFFD":
            out.append(ch)
    return "".join(out).strip()


h = [skeleton(x) for x in head.split("\n")]
c = [skeleton(x) for x in cur.split("\n")]

print(f"HEAD 行数={len(h)}  当前行数={len(c)}")
print()

# 去掉两侧的空骨架行做序列比对（空行位置会因为丢字而漂移）
h_nz = [(i, s) for i, s in enumerate(h) if s]
c_nz = [(i, s) for i, s in enumerate(c) if s]
print(f"非空骨架行：HEAD={len(h_nz)}  当前={len(c_nz)}")
print()

import difflib  # noqa: E402

sm = difflib.SequenceMatcher(None, [s for _, s in h_nz], [s for _, s in c_nz], autojunk=False)
ops = [o for o in sm.get_opcodes() if o[0] != "equal"]

print(f"骨架差异块: {len(ops)}")
print()

if not ops:
    print(">>> 结论：骨架完全一致 —— 该文件在我改动前 == HEAD，可安全从 HEAD 恢复")
else:
    total_del = sum(o[2] - o[1] for o in ops)
    total_ins = sum(o[4] - o[3] for o in ops)
    print(f"骨架删除行 {total_del} / 骨架新增行 {total_ins}")
    print()
    for tag, i1, i2, j1, j2 in ops[:15]:
        print(f"[{tag}] HEAD非空行#{i1+1}..{i2} -> CUR非空行#{j1+1}..{j2}")
        for k in range(i1, min(i2, i1 + 3)):
            print(f"   - {h_nz[k][1][:120]}")
        for k in range(j1, min(j2, j1 + 3)):
            print(f"   + {c_nz[k][1][:120]}")
        print()
    if len(ops) > 15:
        print(f"（仅显示前 15 块，共 {len(ops)} 块）")
