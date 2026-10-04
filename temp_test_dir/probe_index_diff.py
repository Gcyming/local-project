"""诊断 gui/src/main/index.ts 相对 HEAD 的真实差异（剥离行尾与 BOM 的干扰）。

用途：判断该文件在我用 PowerShell 做字符串替换后，除了预期的 5 处类型改动之外
是否还有内容损伤。只读，不改任何文件。
"""
import difflib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "gui/src/main/index.ts"
PATH = ROOT / REL


def norm(s: str) -> str:
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    return s


head_raw = subprocess.run(
    ["git", "-C", str(ROOT), "show", f"HEAD:{REL}"],
    capture_output=True, check=True,
).stdout.decode("utf-8-sig")
cur_raw = PATH.read_text(encoding="utf-8-sig")

head = norm(head_raw)
cur = norm(cur_raw)

h_lines = head.split("\n")
c_lines = cur.split("\n")

print(f"HEAD 行数: {len(h_lines):>6}   当前行数: {len(c_lines):>6}   差: {len(c_lines) - len(h_lines):+d}")
print(f"HEAD 字符数: {len(head):>8}   当前字符数: {len(cur):>8}")
print()

# 原始字节层面的行尾统计
raw = PATH.read_bytes()
print(f"BOM: {'有' if raw[:3] == b'\xef\xbb\xbf' else '无'}")
crlf = raw.count(b"\r\n")
lf_total = raw.count(b"\n")
print(f"CRLF={crlf}  LF总数={lf_total}  裸LF={lf_total - crlf}")
print()

sm = difflib.SequenceMatcher(None, h_lines, c_lines, autojunk=False)
ops = [op for op in sm.get_opcodes() if op[0] != "equal"]
print(f"差异块数量: {len(ops)}")
print()

total_del = sum(o[2] - o[1] for o in ops)
total_ins = sum(o[4] - o[3] for o in ops)
print(f"删除行 {total_del} / 新增行 {total_ins}")
print()

for tag, i1, i2, j1, j2 in ops[:25]:
    print(f"--- {tag}  HEAD[{i1+1}:{i2}] -> CUR[{j1+1}:{j2}] ---")
    for ln in h_lines[i1:min(i2, i1 + 3)]:
        print(f"    - {ln[:150]}")
    if i2 - i1 > 3:
        print(f"    - ...（还有 {i2-i1-3} 行）")
    for ln in c_lines[j1:min(j2, j1 + 3)]:
        print(f"    + {ln[:150]}")
    if j2 - j1 > 3:
        print(f"    + ...（还有 {j2-j1-3} 行）")
    print()

if len(ops) > 25:
    print(f"（差异块过多，仅显示前 25 个，共 {len(ops)} 个）")
