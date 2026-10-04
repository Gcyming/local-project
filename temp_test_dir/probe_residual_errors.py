"""定位恢复后 index.ts 的 4 处残余错误。只读。"""
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "gui" / "src" / "main" / "index.ts"
raw = SRC.read_bytes()

print("=== 1. 前 16 字节（查 TS1490 'File appears to be binary'）===")
print("   ", " ".join(f"{b:02x}" for b in raw[:16]))
print("   ", repr(raw[:60]))

print()
print("=== 2. 全文件控制字符扫描（除 CR/LF/TAB）===")
bad_positions = []
for i, b in enumerate(raw):
    if b < 0x20 and b not in (0x09, 0x0A, 0x0D):
        bad_positions.append((i, b))
    if b == 0x7F:
        bad_positions.append((i, 0x7F))
# U+FFFD 的 UTF-8 编码是 EF BF BD
i = 0
fffd_positions = []
while True:
    i = raw.find(b"\xef\xbf\xbd", i)
    if i < 0:
        break
    fffd_positions.append(i)
    i += 3
print(f"    控制字符位置数: {len(bad_positions)}")
for pos, b in bad_positions[:10]:
    line = raw[:pos].count(b"\n") + 1
    print(f"      offset {pos} byte 0x{b:02x}  -> 行 {line}")
print(f"    U+FFFD(EF BF BD) 出现次数: {len(fffd_positions)}")

text = raw.decode("utf-8")
lines = text.split("\r\n")

print()
print("=== 3. 出错行 215 上下文 ===")
for n in range(211, 219):
    if n <= len(lines):
        mark = ">>" if n == 215 else "  "
        print(f"  {mark} L{n}: {lines[n-1][:160]}")

print()
print("=== 4. 末行（7790）上下文 ===")
for n in range(max(1, len(lines) - 3), len(lines) + 1):
    mark = ">>" if n == len(lines) else "  "
    print(f"  {mark} L{n}: {lines[n-1][:160]}")
print(f"    实际行数: {len(lines)}")

print()
print("=== 5. 含 U+FFFD 的『疑似代码行』全清单（非注释开头）===")
code_bad = []
for n, ln in enumerate(lines, 1):
    if "\uFFFD" not in ln:
        continue
    s = ln.strip()
    if s.startswith(("//", "*", "/*", "*/", "─", "═")):
        continue
    # 去掉行内注释后再看是否还残留
    code_part = s.split("//")[0]
    if "\uFFFD" in code_part:
        code_bad.append((n, ln))

print(f"    共 {len(code_bad)} 行")
for n, ln in code_bad[:40]:
    print(f"      L{n:<6} {ln.strip()[:140]}")
if len(code_bad) > 40:
    print(f"      ...（还有 {len(code_bad)-40} 行）")
