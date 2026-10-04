"""落地恢复：把 index.ts.recovered 写回 gui/src/main/index.ts（CRLF + 无 BOM）。

顺序：
  1. 先把当前乱码版原样备份为 index.ts.corrupted-bak（保留现场证据，不删）
  2. 再把还原文本按仓库规范（CRLF / 无 BOM / UTF-8）写回 index.ts
  3. 复核写回后的行尾与 BOM

⚠️ 还原文本仍有 ~14.7k 个不可恢复字符（U+FFFD），集中在注释；代码行仅约 144 行受影响。
   本步骤只修复「编码」，不修复那些残余 U+FFFD（那需要逐处人工/上下文补齐）。
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "gui" / "src" / "main" / "index.ts"
REC = SRC.with_suffix(".ts.recovered")
BAK = SRC.with_name("index.ts.corrupted-bak")

if not REC.exists():
    raise SystemExit("找不到 index.ts.recovered，先跑 temp_test_dir/recover_index.py")

# 1. 备份乱码版（原始字节，不做任何转换）
shutil.copy2(SRC, BAK)
print(f"[1] 已备份乱码版 -> {BAK.name}  ({BAK.stat().st_size:,} B)")

# 2. 读还原文本，规范化行尾为 CRLF，写 UTF-8 无 BOM
text = REC.read_text(encoding="utf-8")
text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
SRC.write_bytes(text.encode("utf-8"))  # write_bytes => 绝不加 BOM

print(f"[2] 已写回 {SRC.name}  ({SRC.stat().st_size:,} B)")

# 3. 复核
raw = SRC.read_bytes()
crlf = raw.count(b"\r\n")
lf_total = raw.count(b"\n")
bom = raw[:3] == b"\xef\xbb\xbf"
print()
print("[3] 复核")
print(f"    BOM: {'有（错误！）' if bom else '无 ✓'}")
print(f"    CRLF={crlf}  裸LF={lf_total - crlf}  {'✓ 全 CRLF' if lf_total - crlf == 0 else '✗ 仍有裸 LF'}")
print(f"    残留 U+FFFD: {text.count(chr(0xFFFD))}")
print(f"    行数: {len(text.split(chr(13) + chr(10)))}")
