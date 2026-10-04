"""剥离源码注释（状态机实现，不是正则）。

为什么必须用状态机：字符串与模板里就含 `//` `/*` `#`——
    "https://git-scm.com"          ← 正则会把 // 之后当注释切掉
    `[gui:main] 服务已就绪`         ← 同理
    "C:\\path\\#hash"               ← Python 同理
一律用**逐字符状态机**跟踪「当前是否在字符串 / 模板 / 注释 / 正则」里，只在代码态识别注释起始。
这正是本次编码事故的同款教训：文本层面的偷懒替换会毁掉代码。

用法：
    py temp_test_dir/strip_comments.py                      # 干跑：只报告将删多少行
    py temp_test_dir/strip_comments.py --apply              # 写出 <名>.stripped（**不动原文件**）
    py temp_test_dir/strip_comments.py --apply --in-place   # 真正写回（先备份 *.bak-comments）
    py temp_test_dir/strip_comments.py --apply --docstrings # Python 连 docstring 一起删

⚠️ A-1142 改动：`--apply` 不再直接覆盖原文件，只产出 `<名>.stripped` 候选。
   理由就是本次编码事故的教训 —— 全仓覆盖一次不可逆，**先产出候选、比对后再替换**。
   确认无误后用 `--in-place` 落地（或自行把 .stripped 移回原名）。

目标扩展名：.ts .tsx .js .mjs .cjs .py
默认目录：gui/src、core-ts/src、core、tests、temp_test_dir 之外的项目根脚本

⚠️ 含 U+FFFD（本次事故残留）的行**整行跳过**：那些行的字符串可能未闭合，
   状态机会被带偏；先跑 fix_index_from_bundle.py 修好字符串，再跑本脚本。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPLY = "--apply" in sys.argv
IN_PLACE = "--in-place" in sys.argv
DOCSTRINGS = "--docstrings" in sys.argv

TARGETS = [
    ROOT / "gui" / "src" / "main",
    ROOT / "gui" / "src" / "renderer",
    ROOT / "gui" / "src" / "shared",
    ROOT / "gui" / "src" / "preload",
    ROOT / "core-ts" / "src",
    ROOT / "core",
    ROOT / "tests",
]
EXTS = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}
SKIP_DIRS = {"node_modules", "out", "dist", ".git", "__pycache__", "release-linux", "release-final"}
FFFD = "\uFFFD"


# ── TS / JS ────────────────────────────────────────────────────────────────

def strip_js(text: str):
    """返回 (新文本, 删除的注释行数)。逐字符状态机。"""
    out = []
    i, n = 0, len(text)
    removed_lines = 0
    line_has_comment = False
    # A-1142：正则字面量判据 —— `/` 前面是运算符/左括号/行首时它是正则，否则是除号。
    REGEX_PREV = set("(,=:[!&|?{};+-*%~^<>")
    prev_sig = None
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        # 行注释
        if ch == "/" and nxt == "/":
            j = text.find("\n", i)
            if j < 0:
                j = n
            out.append("")                       # 注释整段丢掉（保留换行）
            line_has_comment = True
            i = j
            continue

        # 块注释
        if ch == "/" and nxt == "*":
            j = text.find("*/", i + 2)
            # A-1142 安全网：正则里也可能出现 `/*`（如 /[*]/）。若 5000 字符内找不到闭合的
            # `*/`，它几乎不可能是块注释 —— 按块注释处理会**吞掉后面几千字符的真代码**。
            # 宁可漏删这一处注释，也绝不删错代码。落空则往下走正则分支。
            if j >= 0 and (j - i) <= 5000:
                seg = text[i:j + 2]
                # 块注释独占的行整行删掉；行内块注释只删注释体
                if "\n" in seg:
                    removed_lines += seg.count("\n")
                    # 保留与注释内部等量的换行，避免行号漂移
                    out.append("\n" * seg.count("\n"))
                line_has_comment = True
                i = j + 2
                continue

        # 正则字面量：**必须整段跳过**。
        # A-1142（关键修复）：此前没有这一段，正则里的引号（如 /^['"\s]+/）会被当成
        # 字符串开引号 ⇒ 状态机错位 ⇒ 之后**把真代码当注释删掉**。实测触发路径：
        #     const a = /['"]/;  const b = "http://x";
        #   `'` 开引号后一路吞到行尾换行，机器回到「代码态」时正停在 `http://x";` 上，
        #   于是 `//x";` 被判定为行注释而**删除**。那是数据损坏，不是格式问题。
        if ch == "/" and (prev_sig is None or prev_sig in REGEX_PREV):
            k = i + 1
            in_class = False
            while k < n:
                c = text[k]
                if c == "\\":
                    k += 2
                    continue
                if c == "\n":
                    break
                if c == "[":
                    in_class = True
                elif c == "]":
                    in_class = False
                elif c == "/" and not in_class:
                    k += 1
                    break
                k += 1
            out.append(text[i:k])
            prev_sig = "/"
            i = k
            continue

        # 字符串
        if ch in "\"'":
            q = ch
            k = i + 1
            buf = [ch]
            while k < n:
                c = text[k]
                if c == "\\":
                    buf.append(text[k:k + 2])
                    k += 2
                    continue
                buf.append(c)
                if c == q:
                    k += 1
                    break
                if c == "\n":                    # 未闭合（可能正是事故残留）——原样保留
                    k += 1
                    break
                k += 1
            out.append("".join(buf))
            prev_sig = q
            i = k
            continue

        # 模板字符串（整段原样保留，含 ${} 内的表达式）
        if ch == "`":
            k = i + 1
            depth = 0
            buf = ["`"]
            while k < n:
                c = text[k]
                if c == "\\":
                    buf.append(text[k:k + 2])
                    k += 2
                    continue
                if c == "$" and k + 1 < n and text[k + 1] == "{":
                    depth += 1
                    buf.append("${")
                    k += 2
                    continue
                if c == "}" and depth > 0:
                    depth -= 1
                    buf.append("}")
                    k += 1
                    continue
                buf.append(c)
                if c == "`" and depth == 0:
                    k += 1
                    break
                k += 1
            out.append("".join(buf))
            prev_sig = "`"
            i = k
            continue

        out.append(ch)
        if not ch.isspace():
            prev_sig = ch
        i += 1

    return "".join(out), line_has_comment


# ── Python ─────────────────────────────────────────────────────────────────

def strip_py(text: str):
    """剥 Python 注释。逐字符状态机，处理 ' " ''' \"\"\"，可选连 docstring 一起删。"""
    out = []
    i, n = 0, len(text)
    at_line_start = True
    while i < n:
        ch = text[i]
        # 三引号（docstring 或普通多行字符串）
        if ch in "\"'" and text[i:i + 3] == ch * 3:
            j = text.find(ch * 3, i + 3)
            j = n if j < 0 else j + 3
            seg = text[i:j]
            if DOCSTRINGS and at_line_start:
                out.append("\n" * seg.count("\n"))   # 当 docstring 删掉
            else:
                out.append(seg)
            i = j
            at_line_start = False
            continue
        # 单行字符串
        if ch in "\"'":
            q = ch
            k = i + 1
            buf = [ch]
            while k < n:
                c = text[k]
                if c == "\\":
                    buf.append(text[k:k + 2])
                    k += 2
                    continue
                buf.append(c)
                if c == q:
                    k += 1
                    break
                if c == "\n":
                    k += 1
                    break
                k += 1
            out.append("".join(buf))
            i = k
            at_line_start = False
            continue
        # '#' 注释（只在代码态）
        if ch == "#":
            j = text.find("\n", i)
            if j < 0:
                j = n
            i = j
            continue
        out.append(ch)
        at_line_start = ch in "\n"
        i += 1
    return "".join(out)


def main() -> int:
    files = []
    for t in TARGETS:
        if not t.exists():
            continue
        for p in t.rglob("*"):
            if not p.is_file() or p.suffix not in EXTS:
                continue
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            files.append(p)

    total_before = 0
    total_after = 0
    skipped = []
    changed = []

    for p in sorted(files):
        raw = p.read_text(encoding="utf-8")
        # 含事故残留的文件整份跳过 —— 字符串可能未闭合，状态机会被带偏
        if FFFD in raw:
            skipped.append(p)
            continue
        if p.suffix == ".py":
            new = strip_py(raw)
        else:
            new, _ = strip_js(raw)
        total_before += len(raw)
        total_after += len(new)
        if new != raw:
            changed.append((p, len(raw), len(new)))
            if IN_PLACE:
                bak = p.with_suffix(p.suffix + ".bak-comments")
                if not bak.exists():
                    bak.write_text(raw, encoding="utf-8", newline="")
                p.write_text(new, encoding="utf-8", newline="")
            elif APPLY:
                # A-1142：默认**不覆盖原文件**，只写出 `<名>.stripped` 候选。
                p.with_name(p.name + ".stripped").write_text(new, encoding="utf-8", newline="")

    print(f"扫描文件: {len(files)}")
    print(f"跳过（含 U+FFFD 事故残留，请先跑 fix_index_from_bundle.py）: {len(skipped)}")
    for p in skipped:
        print(f"    {p.relative_to(ROOT)}")
    print()
    print(f"有改动: {len(changed)} 个文件")
    print(f"  总字节: {total_before:,} → {total_after:,}（删掉 {total_before - total_after:,}，"
          f"{(total_before - total_after) / max(1, total_before):.1%}）")
    print()
    print("改动最大的 20 个文件：")
    for p, b, a in sorted(changed, key=lambda t: t[1] - t[2], reverse=True)[:20]:
        print(f"  {p.relative_to(ROOT)!s:<58} {b:>9,} → {a:>9,}")
    print()
    if IN_PLACE:
        print("已就地写回（原文件备份为 *.bak-comments，已存在则不覆盖）")
    elif APPLY:
        print("已写出 *.stripped 候选文件（**原文件未改动**）")
        print()
        print("下一步：")
        print("  1. 比对原文件与 .stripped（例如 git diff --no-index 原文件 原文件.stripped）")
        print("  2. 确认无误后落地：加 --in-place 重跑，或自行把 .stripped 移回原名")
        print("  3. 落地后跑一次 py qa.py 与 pnpm dev 验证")
    else:
        print("（干跑模式，未写任何文件。加 --apply 产出 .stripped 候选）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
