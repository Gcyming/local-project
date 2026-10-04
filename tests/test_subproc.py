"""A-1134：外部命令调用的**解码**判据（`core/subproc.py`）。

## 为什么这几条用例是"守卫的守卫"

用户 2026-09-28 截图报的崩溃**不是**某个字符串写错，而是 `subprocess.run(text=True)`
把解码放进了 CPython 的 `Thread-N (_readerthread)`；PEP 540 下 Python 认为编码是 UTF-8，
而中文 Windows 的原生命令（`tasklist` / `netstat` / `wmic` / `powershell` / `nvidia-smi`）
按控制台 OEM 代码页（cp936）输出 ⇒ reader 线程抛 `UnicodeDecodeError` 后**当场死掉**。

线程死掉之后有两个**静默**后果，比那条 traceback 危险得多：

1. **白等一个 timeout** —— 异常在别的线程里，调用方的 `except Exception` 抓不到；
2. **判据静默失效** —— `result.stdout` 拿不到 ⇒ `_verify_llama_server_pid` /
   `_pid_for_port` 这些"无法确认时不杀"的安全校验，退化成"**永远不杀**"。

⇒ 所以本文件的核心断言只有一句意思：**`decode_console` 对任何字节都不许抛**。
   它一旦抛，上面两条静默后果立刻复活，而且是"一片绿"的那种复活。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from core.subproc import decode_console, run_text


CRASH_BYTES = b"\x01\x02\xbb\x03"

GBK_ZHONGWEN = b"\xd6\xd0\xce\xc4"

UTF8_ZHONGWEN = "中文".encode("utf-8")


GBK_YI = "一".encode("gbk")

IS_WINDOWS = sys.platform == "win32"


class TestDecodeConsoleNeverRaises:
    """① 永不抛：这是整个 A-1134 的判据本身。"""

    def test_真实崩溃字节不再抛(self):
        """截图里那条 `0xbb` —— 旧写法在这一步抛 UnicodeDecodeError，线程死。"""
        out = decode_console(CRASH_BYTES)          
        assert isinstance(out, str)

    def test_属性穷举_任意单字节都不抛(self):
        for b in range(256):
            assert isinstance(decode_console(bytes([b])), str)

    def test_属性穷举_任意双字节组合都不抛(self):
        """65536 组——比手写几个样本强得多：漏掉的那一组就是下次崩溃。

        ⚠️ `cp936` 是双字节表，几乎任何字节对都能凑出汉字；这里要的不是"解对"，
           而是"**绝不抛**"（解错只会显示乱码，抛了则整条判据作废）。
        """
        for hi in range(256):
            for lo in range(256):
                assert isinstance(decode_console(bytes([hi, lo])), str)

    def test_两者都不成立时退_replace_且不抛(self):
        """`0x80` 单字节：既非合法 UTF-8 也非合法 cp936 ⇒ 走到最后的 replace 兜底。

        ⚠️ 断言的是**非空**，不只是"不抛"：空串正是"判据静默失效"的形态 ——
           `_verify_llama_server_pid` 拿到 "" 就会得出"输出里没有 llama-server"，
           于是"无法确认时不杀"退化成"永远不杀"。宁可给 `￼`，也不能给空。
        """
        out = decode_console(b"\x80")
        assert isinstance(out, str)
        assert out, "兜底路径返回了空串 —— 那正是安全校验静默失效的形态"


class TestDecodeConsoleOrder:
    """② 编码顺序本身是一条**策略**判据：OEM 严格 → UTF-8 严格 → OEM replace。

    ⚠️ 这里踩过一次坑，记下来免得重犯：最初我用「中文」样本去守顺序，结果**变异存活**。
       实测原因 ——「中文」的 UTF-8 字节被 cp936 **拒绝**，两种顺序结果一样 ⇒ 那是**等价变异体**。
       真正能区分顺序的是下面那种"**两边都合法**"的字节（GBK「一」= `d2 bb` 也是 UTF-8 `һ`）。
    """

    def test_utf8_中文必须解对_但它挡不住顺序反转(self):
        """**不是**顺序的判据（两种顺序都对），只固定"真 UTF-8 中文必须解对"这件事。"""
        assert decode_console(UTF8_ZHONGWEN) == "中文"

    def test_oem_优先_才是顺序的判据_GBK汉字不许被解成西里尔字母(self):
        """`d2 bb` 既是 GBK「一」也是合法 UTF-8（`U+04BB һ`）—— 顺序唯一的试金石。

        本项目输出方是 Windows 原生命令（OEM = cp936）⇒ 必须取「一」。
        一旦顺序被反转成 UTF-8 优先，这里会**静默**变成 `һ`（不抛、不报错、内容错）。
        """
        assert decode_console(GBK_YI) == "一"

    @pytest.mark.skipif(not IS_WINDOWS, reason="OEM 代码页只在 Windows 有意义")
    def test_gbk_中文走_OEM_解出正确汉字(self):
        assert decode_console(GBK_ZHONGWEN) == "中文"

    @pytest.mark.skipif(not IS_WINDOWS, reason="取舍只在「OEM 优先」成立时才存在")
    def test_已知取舍_utf8_西文会被_oem_优先吃掉_这是有意的(self):
        """把取舍**显式化**，不是"保护错误"。

        实测（GBK 双字节 21791 个合法码位）：
          · **OEM 优先**：GBK 流错误面 0/21791；代价是 UTF-8 流里的 `U+0080–U+07FF` 乱码
          · UTF-8 优先：把 1920/21791（8.8%）的 GBK 汉字解错
        调用方全是 Windows 原生命令 ⇒ 选 OEM 优先。将来要服务 UTF-8 工具（node/python）
        必须**显式传编码**；那时这条会红，正好提醒去加参数而不是改顺序。
        """
        assert decode_console("café".encode("utf-8")) == "caf茅"

    def test_str_直通_不重复解(self):
        """mock 成 text 模式的返回值时是 str —— 再解一次会毁掉内容。"""
        assert decode_console("已经是文本了") == "已经是文本了"

    def test_None_变成空串(self):
        """`stderr` 为 None（没开 capture）时必须给 ""，调用方才能安全地 `in`。"""
        assert decode_console(None) == ""


class TestRunTextContract:
    """③ `run_text` 的契约：解码必须由**本函数**做，不许再委托给 subprocess。"""

    def test_必须把_text_False_交给_subprocess(self):
        """这是结构性判据：`text=True` 就等于把解码塞回 reader 线程（= 恢复那个 bug）。"""
        captured = {}

        def fake_run(cmd, **kwargs):
            captured.update(kwargs)
            return subprocess.CompletedProcess(cmd, 0, b"ok", b"")

        with patch.object(subprocess, "run", side_effect=fake_run):
            r = run_text(["whatever"])

        assert captured.get("text") is False
        assert "encoding" not in captured
        assert r.stdout == "ok"
        assert isinstance(r.stdout, str)

    @pytest.mark.parametrize("banned", ["text", "encoding", "errors", "universal_newlines"])
    def test_禁传会重新引入崩溃的参数(self, banned):
        """宁可当场 TypeError，也不要有人绕回来把 reader 线程崩溃重新引入。"""
        with pytest.raises(TypeError):
            run_text(["whatever"], **{banned: True})

    def test_喂_gbk_字节时_stdout_一样有值(self):
        """静默失效的**正向**判据：旧写法这里 stdout 是空 ⇒ 安全校验作废。"""
        with patch.object(
            subprocess, "run",
            return_value=subprocess.CompletedProcess(["x"], 0, GBK_ZHONGWEN, b""),
        ):
            r = run_text(["x"])
        assert r.stdout != ""            
        assert isinstance(r.stdout, str)

    def test_timeout_语义与_subprocess_一致(self):
        """调用方现有的 `except subprocess.TimeoutExpired` 必须照旧有效。"""
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("x", 1)):
            with pytest.raises(subprocess.TimeoutExpired):
                run_text(["x"], timeout=1)

    def test_FileNotFoundError_语义与_subprocess_一致(self):
        """调用方现有的 `except FileNotFoundError` 必须照旧有效。"""
        with patch.object(subprocess, "run", side_effect=FileNotFoundError):
            with pytest.raises(FileNotFoundError):
                run_text(["不存在的命令"])

    def test_check_True_时抛_CalledProcessError_且_output_是_str(self):
        with patch.object(
            subprocess, "run",
            return_value=subprocess.CompletedProcess(["x"], 3, GBK_ZHONGWEN, b"bad"),
        ):
            with pytest.raises(subprocess.CalledProcessError) as ei:
                run_text(["x"], check=True)
        assert ei.value.returncode == 3
        assert isinstance(ei.value.output, str)
        assert isinstance(ei.value.stderr, str)

    @pytest.mark.skipif(not IS_WINDOWS, reason="CREATE_NO_WINDOW 只在 Windows 存在")
    def test_windows_默认不弹黑框_且可被调用方覆盖(self):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured.update(kwargs)
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with patch.object(subprocess, "run", side_effect=fake_run):
            run_text(["x"])
        assert captured.get("creationflags") == subprocess.CREATE_NO_WINDOW

        captured.clear()
        with patch.object(subprocess, "run", side_effect=fake_run):
            run_text(["x"], creationflags=0)
        assert captured.get("creationflags") == 0


class TestRealChild:
    """④ 真实子进程端到端：mock 复现不了这个 bug（崩溃发生在真 subprocess 内部线程里）。"""

    def test_真实子进程吐_gbk_字节时不崩_且有输出(self):
        code = "import sys;sys.stdout.buffer.write(b'\\xd6\\xd0\\xce\\xc4')"
        r = run_text([sys.executable, "-c", code], timeout=20)
        assert r.stdout != ""            
        assert isinstance(r.stdout, str)
        if IS_WINDOWS:
            assert r.stdout == "中文"


class TestStructuralInvariant:
    """⑤ 结构判据：`core/model_server.py` 只能通过 `run_text` 跑外部命令。

    ⚠️ 这是**补充**判据，不是主判据：上面的行为用例才是真的。它挡的是"有人以后
       又在该文件里新写一个裸 `subprocess.run(..., text=True)`"——那种情况行为用例看不见。
    """

    def test_model_server_不直接调_subprocess_run(self):
        src = (Path(__file__).resolve().parents[1] / "core" / "model_server.py").read_text(
            encoding="utf-8"
        )
        assert "subprocess.run" not in src, (
            "core/model_server.py 又出现了裸 subprocess.run —— "
            "外部命令请走 core/subproc.py 的 run_text（否则 reader 线程会因编码崩溃）"
        )


class TestNoBareTextMode:
    """⑥ A-1134 跨文件判据：`text=True`（或 `universal_newlines=True`）**必须同时给 `errors=`**。

    这是"同一个 bug 会**逐文件重犯**"的判据 —— 本次就在 4 个文件里各抓到一个：
    `tools/agnes_media.py`（ffmpeg ×3）、`tools/git.py`（git notes）、`tools/builtin.py`（node --check ×2）、
    `slime_launcher.py`（tasklist；**同文件 `_kill_port` 却写了 `errors=`**，两种口径并存）。

    ⚠️ 为什么用 `ast` 而不是文本/正则：要判的是"**这一次调用**有没有 `errors=`"。
       正则只能看"文件里（或附近）有没有"，会把**别处**的 `errors=` 当成本处的 ⇒ 假绿。
       本仓已经因为"锚在文件里第 N 处"吃过亏（见项目铁律 §3）。

    ⚠️ 为什么允许 `text=True + errors=` 而不一律禁用 `text=True`：
       `errors=` 已经把"解不了"变成"换字符"，**reader 线程不会死**（本次崩溃的直接原因就是"解不了就抛"）。
       一刀切强制全仓改 `run_text` 会牵动 `qa.py` / `tools/git.py` 这些已有测试的模块，风险大于收益。
       ⇒ 规则是「**不许出现「解不了就抛」的写法**」，不是「只许一种写法」。
    """

    ROOTS = ("core", "tools")
    EXTRA = ("slime_launcher.py", "qa.py")

    def _sources(self):
        root = Path(__file__).resolve().parents[1]
        for d in self.ROOTS:
            yield from sorted((root / d).rglob("*.py"))
        for name in self.EXTRA:
            p = root / name
            if p.is_file():
                yield p

    def test_没有_解不了就抛_的外部命令调用(self):
        import ast

        bad = []
        for p in self._sources():
            tree = ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                kw = {k.arg: k.value for k in node.keywords if k.arg}
                textish = [
                    n for n in ("text", "universal_newlines")
                    if isinstance(kw.get(n), ast.Constant) and kw[n].value is True
                ]
                if textish and "errors" not in kw:
                    bad.append(f"{p.name}:{node.lineno}  {textish[0]}=True 但没有 errors=")
        assert not bad, (
            "外部命令用了 `text=True` 却没给 `errors=` —— 解码失败会在 CPython 的 reader 线程里抛异常、"
            "线程当场死掉（本次崩溃即此），且调用方的 except 抓不到。正解：改用 core/subproc.py 的 "
            '`run_text`，或至少补 `errors="replace"`。命中：\n  ' + "\n  ".join(bad)
        )
