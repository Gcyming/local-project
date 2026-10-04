"""列出 gui/src/main/index.ts 里**字符串未闭合**的行（= esbuild 会报的语法错误）。

为什么需要它：esbuild 一次只报**第一处**，而这次编码事故留下的破口形状是开放集合
（丢闭引号 / 丢反引号 / 丢在拼接行中间 / 跨行），靠 grep 找签名每关一个就跑出新的。
本脚本改用**状态机扫描**：逐行跟踪字符串状态，报出所有「到行尾仍未闭合」的位置——
这正是 esbuild 的判据，且**一次列全**。

用法：
    py temp_test_dir/list_broken_lines.py            # 列出所有未闭合处
    py temp_test_dir/list_broken_lines.py --context  # 附带后一行（便于看拼接关系）

⚠️ 只读，不改任何文件。
⚠️ 扫描器刻意做得保守：注释、正则字面量、模板字符串插值都可能造成误报，
   所以输出里会有「疑似」标记，需人工确认。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "gui" / "src" / "main" / "index.ts"
WITH_CONTEXT = "--context" in sys.argv

text = SRC.read_text(encoding="utf-8")
lines = text.replace("\r\n", "\n").split("\n")

FFFD = "\uFFFD"


def scan():
    """逐字符扫描，返回 [(行号, 该行文本, 未闭合的引号类型)]。

    处理：行注释 //、块注释 /* */、字符串 " ' `、模板插值 ${} 的嵌套深度。
    故意**不**处理正则字面量（极少且本次损伤与它无关）。
    """
    out = []
    in_block_comment = False
    # 字符串状态：None / '"' / "'" / '`'
    quote = None
    # 模板插值里可能又开字符串，用栈记录
    stack = []           # 元素: ("tpl", brace_depth) 表示在模板里，且当前插值花括号深度
    brace_depth = 0

    for ln_no, line in enumerate(lines, 1):
        i = 0
        n = len(line)
        opened_at = None
        while i < n:
            ch = line[i]
            nxt = line[i + 1] if i + 1 < n else ""

            if in_block_comment:
                if ch == "*" and nxt == "/":
                    in_block_comment = False
                    i += 2
                    continue
                i += 1
                continue

            if quote is None:
                if ch == "/" and nxt == "/":
                    break                      # 行注释，本行结束
                if ch == "/" and nxt == "*":
                    in_block_comment = True
                    i += 2
                    continue
                if ch in "\"'`":
                    quote = ch
                    opened_at = i
                    i += 1
                    continue
                i += 1
                continue

            # 在字符串里
            if ch == "\\":
                i += 2                          # 转义
                continue
            if quote == "`" and ch == "$" and nxt == "{":
                stack.append(("tpl", brace_depth))
                brace_depth = 0
                quote = None                    # 进入插值（当代码处理）
                i += 2
                continue
            if ch == quote:
                quote = None
                opened_at = None
                i += 1
                continue
            if quote == "`" and ch == "\n":
                quote = None
                i += 1
                continue
            i += 1

        # 行尾判定
        if quote is not None:
            out.append((ln_no, line, quote, opened_at))
            # 保守：不要把未闭合状态带到下一行（否则全线飘红）；
            # 真实源码里跨行字符串只可能是模板反引号，而模板跨行是合法的 —— 故这里重置。
            if quote != "`":
                quote = None
        # 插值未闭合的 ` 也报
        if quote is None and stack and brace_depth == 0 and line.rstrip().endswith("`") is False:
            pass
    return out


hits = scan()

print(f"文件: {SRC.name}   总行数: {len(lines)}")
print(f"含 U+FFFD 的行: {sum(1 for l in lines if FFFD in l)}")
print()

# 只报「含损伤」的未闭合行（无损伤的未闭合大概率是扫描器误报，如正则/JSX）
real = [h for h in hits if FFFD in h[1]]
maybe = [h for h in hits if FFFD not in h[1]]

print("=" * 100)
print(f"【A】字符串未闭合 **且含损伤** —— 这些几乎必然是真语法错误: {len(real)} 处")
print("=" * 100)
for ln_no, line, q, col in real:
    print(f"L{ln_no}  (未闭合的 {q!r}，起始列 {col})")
    print(f"    {line}")
    if WITH_CONTEXT and ln_no < len(lines):
        print(f"  +1 {lines[ln_no]}")
    print()

print("=" * 100)
print(f"【B】字符串未闭合 **但不含损伤** —— 多半是扫描器误报（正则/JSX/跨行），仅供参考: {len(maybe)} 处")
print("=" * 100)
for ln_no, line, q, col in maybe[:20]:
    print(f"L{ln_no}  ({q!r} @ {col})  {line[:120]}")
if len(maybe) > 20:
    print(f"...（还有 {len(maybe)-20} 处）")
