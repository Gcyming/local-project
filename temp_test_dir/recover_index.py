"""从 GBK 乱码中恢复 gui/src/main/index.ts —— 写出旁路文件 + 量化损失。

⚠️ 不覆盖原文件。产出 gui/src/main/index.ts.recovered 供人工比对。

成因：文件原为**无 BOM 的 UTF-8**，PowerShell `Get-Content -Raw` 按系统 ANSI(CP936/GBK)
读取 → 乱码字符串 → `Set-Content -Encoding utf8` 写成「BOM + 乱码」。
反向变换：乱码字符串 --encode(gbk)--> 原始 UTF-8 字节 --decode(utf-8)--> 原文。
GBK 对非法字节对会顶替，**那部分不可逆**（下面逐处量化）。
"""
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "gui/src/main/index.ts"
SRC = ROOT / REL
OUT = SRC.with_suffix(".ts.recovered")

cur = SRC.read_text(encoding="utf-8-sig")

# 反向变换
gbk_bytes = cur.encode("gbk", errors="replace")
rec = gbk_bytes.decode("utf-8", errors="replace")
rec = rec.replace("\r\n", "\n")

OUT.write_text(rec, encoding="utf-8", newline="\n")

n_bad = rec.count("\uFFFD")
lines = rec.split("\n")
bad_lines = [(i + 1, ln) for i, ln in enumerate(lines) if "\uFFFD" in ln]

print(f"还原文本已写出: {OUT.name}")
print(f"  行数 {len(lines)}   字符数 {len(rec)}")
print(f"  不可恢复字符（U+FFFD）: {n_bad}")
print(f"  受影响行数: {len(bad_lines)} / {len(lines)}  ({len(bad_lines)/max(1,len(lines)):.1%})")
print()

# 受影响行里，有多少看起来是注释/字符串（修复成本低）vs 代码
comment_like = 0
code_like = 0
for _, ln in bad_lines:
    s = ln.strip()
    if s.startswith(("//", "*", "/*", "*/")) or s.count("//") > 0 and s.index("//") < 12:
        comment_like += 1
    elif s.startswith(("import", "export", "const", "let", "function", "if", "return", "}", ")")):
        code_like += 1
    else:
        comment_like += 1
print(f"  受影响行中：注释/文本类约 {comment_like} 行，疑似代码行约 {code_like} 行")
print()

print("=== 受影响最严重的 15 行（按 U+FFFD 数量）===")
for i, ln in sorted(bad_lines, key=lambda t: -t[1].count("\uFFFD"))[:15]:
    print(f"  L{i:<6} ×{ln.count(chr(0xFFFD)):<3} {ln.strip()[:110]}")

print()
print("=== 对照：HEAD 版本行数 ===")
head = subprocess.run(
    ["git", "-C", str(ROOT), "show", f"HEAD:{REL}"],
    capture_output=True, check=True,
).stdout.decode("utf-8-sig").replace("\r\n", "\n")
print(f"  HEAD 行数 {len(head.split(chr(10)))}   还原行数 {len(lines)}")
print()

# 检查还原文本是否保留了用户的新标识符（证明恢复到了「用户版本」而非 HEAD）
markers = ["TermProfile", "convertToPdf", "docRenderPage", "ensureSearchPage", "AX_FORK_DEPTH",
           "libreOfficeConvert", "termProfiles", "searchBridge"]
print("=== 用户新增标识符在还原文本中的出现次数（应 > 0，证明恢复的是用户版本）===")
for m in markers:
    print(f"  {m:<22} {rec.count(m)}")
print()
print("=== 同上，在 HEAD 中（应为 0）===")
for m in markers:
    print(f"  {m:<22} {head.count(m)}")
