"""从构建产物修复 gui/src/main/index.ts 的乱码残留。

背景
----
`gui/src/main/index.ts` 曾被以错误编码往返一次（UTF-8 被按 GBK 读入再写回），
中文全部变成乱码。已用 GBK 反变换还原了绝大部分，但仍有约 14.7k 个 **U+FFFD**
（不可逆的丢字节处）。

`gui/out/main/index.js` 是同一份源码的构建产物（打包器保留了注释），
里面的中文是**正确的**，因此可作为修复参照。

用法
----
    py temp_test_dir/fix_index_from_bundle.py              # 干跑，只报告
    py temp_test_dir/fix_index_from_bundle.py --apply      # 产出 index.ts.repaired

⚠️ **绝不覆盖 index.ts** —— 永远只写 `gui/src/main/index.ts.repaired`，
   由你比对后再决定是否替换。这样即使脚本判断有误也不会造成二次损失。

⚠️ 本脚本未经实际运行验证（编写时环境禁止执行命令），请务必先看干跑报告。
"""
import difflib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "gui" / "src" / "main" / "index.ts"
# A-1141：**参照物已换**。
# 原来用 `gui/out/main/index.js`（构建产物）—— 但应用修好后每次 pnpm dev 都会重新构建，
# 那个文件已被覆盖成「当前仍带损伤的源码」的产物，**不再是事故前的样子**。
# 现在改用 `gui/out/_full-a1170.txt`（变异测试日志）：里面以 `+` 前缀的 diff 行含
# **事故前 index.ts 的完整源码**，首尾均已核实（从 `import "./boot.js"` 到文件末尾）。
BUNDLE = ROOT / "gui" / "out" / "_full-a1170.txt"
OUT = SRC.with_name("index.ts.repaired")

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def extract_reference(text: str) -> str:
    """从变异测试日志里抽出源码行。

    日志格式：`ESC[31m+ <源码行>ESC[39m`。只取 `+` 行 —— 那是变异脚本**写入的完整源码行**；
    `-` 行是被替换掉的旧内容、` ` 行是上下文，两者都可能混入**别的文件**的内容。
    """
    out = []
    for raw in text.split("\n"):
        s = ANSI.sub("", raw)
        if s.startswith("+ "):
            out.append(s[2:])
        elif s.startswith("+"):
            out.append(s[1:])
    return "\n".join(out)

APPLY = "--apply" in sys.argv
FFFD = "\uFFFD"

# 会被那次编码往返破坏的字符范围（非 ASCII 基本都中招）
NOISE_RANGES = (
    (0x00A0, 0x00FF),   # 拉丁补充（含 × ÷ 等）
    (0x2010, 0x203B),   # 破折号/引号/省略号
    (0x2190, 0x21FF),   # 箭头
    (0x2500, 0x257F),   # 制表符（注释里的 ──── 分隔线）
    (0x25A0, 0x25FF),   # 几何图形
    (0x2600, 0x27BF),   # 杂项符号 / emoji
    (0x3000, 0x303F),   # CJK 标点
    (0x3040, 0x30FF),   # 假名
    (0x3400, 0x4DBF),   # CJK 扩展 A
    (0x4E00, 0x9FFF),   # CJK 基本区
    (0xAC00, 0xD7AF),   # 谚文
    (0xF900, 0xFAFF),   # CJK 兼容
    (0xFE30, 0xFE4F),   # CJK 兼容形式
    (0xFF00, 0xFFEF),   # 全角
    (0x1F300, 0x1FAFF),  # emoji
)


def is_noise(ch: str) -> bool:
    """该字符属于「会被那次编码往返破坏」的类别"""
    if ch == FFFD:
        return True
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in NOISE_RANGES)


def mask(line: str) -> str:
    """结构指纹：把噪声字符折成单个 #，丢掉引号与 '?'，压掉空白。

    两侧都这么算 ⇒ 只要代码骨架相同，指纹就相同，与中文内容无关。

    ⚠️ **引号必须丢**：本次事故最典型、也最要命的一类损伤就是「闭引号被吃掉」——

        throw new Error("引擎未就绪");      ← 正确
        throw new Error("引擎�?���?);        ← 受损（闭引号 + 分号前的字节丢了）

    结果就是 `Unterminated string literal`，整个构建起不来。若不把引号从指纹里去掉，
    恰好这批**最需要修**的行会全部匹配失败（两侧指纹只差一个 `"`）。
    全仓此类受损行共 71 处（grep `�\\?[,);}\\]` 可复现），逐个手工修不现实。
    """
    out = []
    for ch in line:
        if ch in "?\"'`":
            continue          # 丢失位残留 / 三元运算符 / 各种引号 —— 两侧一致地丢掉
        if is_noise(ch):
            out.append("#")
        elif ch in "\t":
            out.append(" ")
        else:
            out.append(ch)
    s = "".join(out)
    s = re.sub(r"#+", "#", s)
    s = re.sub(r" +", " ", s)
    return s.strip()


def split_keepends(text: str):
    """按行切分但保留行尾（处理 CRLF）"""
    return text.splitlines(keepends=True)


def scan_unterminated(text: str):
    """状态机扫描：返回所有「字符串/模板未闭合」的行号。

    这是 esbuild 报 `Unterminated string literal` / `Expected "}" but found "$"`
    的同一判据，但**一次列全**（esbuild 一次只报第一处）。
    跟踪：行注释 //、块注释 /* */、字符串 " '、模板 ` 及其 ${} 嵌套。
    """
    out = []
    in_block = False
    quote = None
    template_depth = 0
    for ln_no, line in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        i, n = 0, len(line)
        while i < n:
            ch = line[i]
            nxt = line[i + 1] if i + 1 < n else ""
            if in_block:
                if ch == "*" and nxt == "/":
                    in_block = False
                    i += 2
                else:
                    i += 1
                continue
            if quote == "`" and ch == "$" and nxt == "{":
                template_depth += 1
                i += 2
                continue
            if quote == "`" and ch == "}" and template_depth > 0:
                template_depth -= 1
                i += 1
                continue
            if quote is None:
                if ch == "/" and nxt == "/":
                    break
                if ch == "/" and nxt == "*":
                    in_block = True
                    i += 2
                    continue
                if ch in "\"'`":
                    quote = ch
                    i += 1
                    continue
                i += 1
                continue
            # 在字符串里
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
                i += 1
                continue
            if quote != "`" and ch == "\n":
                quote = None
                i += 1
                continue
            i += 1
        # 行尾：非模板的单/双引号未闭合 = 语法错误；模板可跨行，合法
        if quote is not None and quote != "`":
            out.append(ln_no)
            quote = None          # 不把状态带到下一行（否则全线飘红）
        elif quote == "`" and template_depth == 0 and line.rstrip().endswith("`") is False:
            # 模板开着且本行没闭合 —— 记录但不重置（模板跨行合法）
            pass
    return out


def main() -> int:
    if not SRC.exists():
        print(f"找不到 {SRC}")
        return 2
    if not BUNDLE.exists():
        print(f"找不到参照物 {BUNDLE}")
        return 2

    src_text = SRC.read_text(encoding="utf-8")
    bundle_text = BUNDLE.read_text(encoding="utf-8", errors="replace")
    if BUNDLE.suffix == ".txt":
        bundle_text = extract_reference(bundle_text)

    src_lines = split_keepends(src_text)
    bundle_lines = split_keepends(bundle_text)

    # 预筛：候选必须有足够长的结构骨架（丢掉引号后，短行的指纹会退化成
    # `//`、`}`、`#` 这类毫无判别力的串，纳入进来只会制造假匹配）
    bundle_masked = []
    for bl in bundle_lines:
        body = bl.rstrip("\r\n")
        m = mask(body)
        if len(m) >= 6 and not set(m) <= {"#", "/", "*", " ", "(", ")", "{", "}", ",", ";", "="}:
            bundle_masked.append((m, body))

    idx_by_mask = {}
    for m, body in bundle_masked:
        idx_by_mask.setdefault(m, []).append(body)

    damaged_idx = [i for i, ln in enumerate(src_lines) if FFFD in ln]

    exact, fuzzy, unmatched = [], [], []
    for i in damaged_idx:
        body = src_lines[i].rstrip("\r\n")
        m = mask(body)
        cands = idx_by_mask.get(m, [])
        # 去重（bundle 里同一行可能多处出现）
        uniq = list(dict.fromkeys(cands))
        if len(uniq) == 1:
            exact.append((i, body, uniq[0]))
            continue
        if len(uniq) > 1:
            # 多候选且内容一致 ⇒ 仍可安全采用
            if len(set(uniq)) == 1:
                exact.append((i, body, uniq[0]))
                continue
        # 模糊兜底：在掩码接近的候选里找最佳
        pool = [b for mm, b in bundle_masked if abs(len(mm) - len(m)) <= 4]
        best, best_r = None, 0.0
        for b in pool:
            r = difflib.SequenceMatcher(None, m, mask(b)).ratio()
            if r > best_r:
                best, best_r = b, r
        if best is not None and best_r >= 0.93:
            fuzzy.append((i, body, best, best_r))
        else:
            unmatched.append((i, body, best_r))

    print(f"源文件行数           : {len(src_lines)}")
    print(f"含 U+FFFD 的行        : {len(damaged_idx)}")
    broken_before = scan_unterminated(src_text)
    print(f"未闭合字符串（语法错误）: {len(broken_before)} 处   ← esbuild 逐个报的就是这些")
    for ln in broken_before:
        print(f"      L{ln}: {src_lines[ln - 1].strip()[:110]}")
    print(f"  ✓ 精确匹配可修       : {len(exact)}")
    print(f"  ~ 模糊匹配可修(≥0.93): {len(fuzzy)}")
    print(f"  ✗ 无法匹配           : {len(unmatched)}")
    print()

    print("=== 精确匹配样例（前 12 条）===")
    for i, bad, good in exact[:12]:
        print(f"  L{i+1}")
        print(f"    坏: {bad.strip()[:120]}")
        print(f"    好: {good.strip()[:120]}")
    print()

    print("=== 模糊匹配样例（前 8 条，附相似度）===")
    for i, bad, good, r in fuzzy[:8]:
        print(f"  L{i+1}  (相似度 {r:.3f})")
        print(f"    坏: {bad.strip()[:120]}")
        print(f"    好: {good.strip()[:120]}")
    print()

    print("=== 无法匹配样例（前 20 条，需人工）===")
    for i, bad, r in unmatched[:20]:
        print(f"  L{i+1}  (最佳 {r:.3f})  {bad.strip()[:110]}")
    if len(unmatched) > 20:
        print(f"  ...（还有 {len(unmatched)-20} 条）")
    print()

    if not APPLY:
        print("（干跑模式，未写任何文件。加 --apply 产出 index.ts.repaired）")
        return 0

    # ── 应用：**只应用精确匹配**（指纹完全相同）──
    # 为什么敢整行替换：指纹里保留了 `:`、标识符、括号等**全部结构字符**，
    # 只丢掉了引号 / '?' / 噪声字符。指纹相同 ⇒ 两侧差异只可能落在被丢掉的那几类上
    # ⇒ 替换不会抹掉源码的 TS 类型标注。（反证：若 bundle 少了类型标注，
    #   指纹必然不同 ⇒ 落入 fuzzy ⇒ 不会被这里改。）
    #
    # 模糊匹配**默认不自动应用**：它无法区分「只是丢了个闭引号」与
    # 「构建产物确实少了类型标注」，整行替换会静默抹掉类型。宁可留给你人工过。
    out_lines = list(src_lines)
    replaced = 0
    for i, bad, good in exact:
        eol = "\r\n" if src_lines[i].endswith("\r\n") else "\n"
        indent = re.match(r"[ \t]*", bad).group(0)
        out_lines[i] = indent + good.strip() + eol
        replaced += 1

    OUT.write_text("".join(out_lines), encoding="utf-8", newline="")
    print(f"已写出 {OUT.name}")
    print(f"  自动替换（精确匹配）: {replaced} 行")
    print(f"  保持原样待人工      : {len(fuzzy)} 行（模糊）+ {len(unmatched)} 行（无法匹配）")

    # ── 自证：修完之后还有没有未闭合字符串 ──
    broken_after = scan_unterminated("".join(out_lines))
    print()
    print("=" * 70)
    print(f"自检：未闭合字符串  {len(broken_before)} 处  →  {len(broken_after)} 处")
    if not broken_after:
        print("  ✅ 0 处 —— 语法错误已清空，可以直接替换原文件后跑 pnpm dev")
    else:
        print("  ⚠️ 仍有剩余，需人工处理（下面列出，可直接贴给我）：")
        for ln in broken_after[:60]:
            print(f"      L{ln}: {out_lines[ln - 1].rstrip()[:130]}")
        if len(broken_after) > 60:
            print(f"      ...（还有 {len(broken_after) - 60} 处）")
    print("=" * 70)
    print()
    print("下一步：")
    print(f"  1. 对比 {SRC.name} 与 {OUT.name}")
    print("  2. 确认无误后再自行替换原文件（脚本不会替你覆盖）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
