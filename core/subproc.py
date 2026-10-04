"""core/subproc.py — 调用**外部命令**的唯一产地（A-1134）。

## 为什么必须收口：一次真实崩溃（用户 2026-09-28 截图）

    [slime-server:err] Exception in thread Thread-3 (_readerthread):
    [slime-server:err] Traceback (most recent call last):
    [slime-server:err]   File ".../subprocess.py", line 1601, in _readerthread
    [slime-server:err]     buffer.append(fh.read())
    [slime-server:err]   File "<frozen codecs>", line 322, in decode
    [slime-server:err] UnicodeDecodeError: 'utf-8' codec can't decode byte 0xbb in position 2

根因**不是**某个字符串写错，而是 `subprocess.run(..., text=True)` 的**解码位置**：

1. `text=True`（或显式 `encoding=`）时，CPython 会起一个 `Thread-N (_readerthread)`
   专门去 `fh.read()` —— **解码是在那个线程里做的**；
2. Python 处于 UTF-8 模式（PEP 540：`PYTHONUTF8=1` / `-X utf8` / 3.15+ 默认）时，
   `locale.getpreferredencoding(False)` 返回 `"utf-8"`；
3. 而 Windows 原生工具（`tasklist` / `netstat` / `wmic` / `powershell` / `nvidia-smi`）
   在**中文 Windows 上按控制台 OEM 代码页（cp936）输出**，不是 UTF-8；
⇒ reader 线程撞上非 UTF-8 字节（`0xbb` 是 GBK 的常见首字节）⇒ **抛异常、线程当场死掉**。

## 为什么"报错"还不是最坏的部分（这才是必须结构性修的真正原因）

线程死了之后有两个**静默**后果，它们比那条 traceback 危险得多：

- **① 白等一个 timeout**：`communicate()` 只能等 reader 线程 join 到 `timeout` 到期，
  异常在**别的线程**里 ⇒ 调用方那个 `except Exception` **抓不到**，每次调用白等 5 秒。
- **② 判据静默失效**：`result.stdout` 拿不到 ⇒ 依赖它的**安全校验全部失效**。具体到本项目：
  `_verify_llama_server_pid`（防 PID 复用误杀）与 `_pid_for_port`（端口归属判断）
  都靠"输出里有没有 `llama-server` / 那个 PID"。它们写的是"无法确认时**不杀**"，
  而解码失败让"不杀"变成了**永远不杀** —— 孤儿 llama-server 从此不会被回收。
  ⚠️ 这类"守卫自己失效"是本项目最贵的失效模式，所以它必须有守卫 + 变异（见文件末）。

## 本仓自带的对照证据（同一项目、同一台机器）

| 位置 | 写法 | 结果 |
|---|---|---|
| `slime_launcher.py::_kill_port`（`netstat -ano`） | `text=True` **+ `errors='replace'`** | ✓ 不崩（只可能中文乱码） |
| **`slime_launcher.py::_is_python_process`**（`tasklist`） | `text=True`，**漏了 `errors`** | ✗ 崩 —— **同一个文件里两种口径并存** |
| `core/model_server.py` 9 处 Windows 命令 | `text=True`，既无 `encoding` 也无 `errors` | ✗ 崩 |
| `tools/agnes_media.py` ffmpeg ×3 / `tools/builtin.py` `node --check` ×2 / `tools/git.py` git-notes ×1 | 同上 | ✗ 崩（**同文件别处却写了 `errors=`**） |

⇒ 结论一：**崩与不崩只差一个"解码失败怎么处理"**，而不是命令本身有问题。
⇒ 结论二（更值得记）：**同一个 bug 会逐文件重犯** —— 一次排查在 **4 个文件**里各抓到一个，
   而且每个文件里都**另有**写对的地方。**单点复验必然漏同族其余文件**（这也是 A-1133 的教训）。
   ⇒ 所以判据必须是**跨文件**的：`tests/test_subproc.py::TestNoBareTextMode`
     （用 `ast` 判"**这一次调用**有没有 `errors=`"；正则会看到别处的 `errors=` ⇒ 假绿）。

## 本模块已接管的范围（2026-09-28）

| 文件 | 处数 | 说明 |
|---|---|---|
| `core/model_server.py` | 9 | nvidia-smi / tasklist ×2 / wmic ×2 / netstat / lsof / powershell / taskkill ×2 |
| `tools/agnes_media.py` | 3 | ffmpeg（抽末帧 / 拼接 copy / 拼接重编码） |
| `tools/builtin.py` | 2 | `node --check`（.js / .ts） |
| `tools/git.py` | 1 | `git notes add`（同文件 3 处 `_run_git` 保留 `text=True + errors=`，本次不动） |
| `slime_launcher.py` | 0 | **不引本模块**（它可能在没有 `core` 的 sys.path 下被直接执行）⇒ 补 `errors="replace"` 即可 |

⚠️ 故意**不动**的：`qa.py`（已有 `encoding`+`errors`）、`gui/template/skills/**`（第三方技能模板，
会被技能更新覆盖）、`.tools/**`（开发脚本，显式 `encoding="utf-8"`）。

## 修法（本模块的存在意义）

**一律 `text=False` 收 bytes，解码搬到调用方（这里）** —— 解码不在 reader 线程里做，
线程就永远不会因为编码而死。剩下的编码选择是一次**纯函数**判断（可单测、可变异）：

    OEM 代码页严格  →  UTF-8 严格  →  OEM `errors="replace"`     （**永不抛**）

### 顺序为什么是「OEM 优先」（2026-09-28 实测，别凭直觉重推）

⚠️ 这里原本写着「UTF-8 优先」，理由是「cp936 是双字节表、几乎任何字节对都能凑出汉字」。
**实测把这个理由否掉了**，而且结论正好相反 —— 见下表（全 BMP 63456 字符 / GBK 双字节 21791 码位）：

| 重叠方向 | 数量 | 举例 | 谁出错 |
|---|---|---|---|
| UTF-8 字节能被 cp936 合法解出 | 1920，全在 `U+0080–U+07FF` | `é`(`c3 a9`) → 「茅」 | **OEM 优先** |
| GBK 汉字能被 UTF-8 合法解出 | **1920 / 21791 = 8.8%** | **「一」(`d2 bb`) → `һ`** | **UTF-8 优先** |

- 汉字区间 `U+4E00–U+9FFF` 的 UTF-8 字节**不是**合法 cp936（cp936 直接拒绝，从而退到 UTF-8，
  结果照样正确）⇒ 用「中文样本」去证明顺序**挡不住**反转 —— 那是等价变异体，别在它上面加断言，
  换变异点（见 `tests/test_subproc.py` 的说明）。
- 但反向有 **8.8%** 的 GBK 汉字字节同时是合法 UTF-8（`d2 bb` 既是「一」也是 `U+04BB`）
  ⇒ 若 UTF-8 优先，Windows 原生命令吐出的中文会被**静默**解成西里尔字母等怪字。
- 本模块的调用方**全是 Windows 原生命令**（`tasklist` / `netstat` / `wmic` / `powershell` /
  `nvidia-smi` / `ffmpeg` …），它们吐的就是 OEM 代码页 ⇒ **取 OEM 优先**（错误面 **0/21791**）。
- **已知取舍（写清楚，不要假装没有）**：UTF-8 工具（`node` / `python`）的输出里若含
  `U+0080–U+07FF`（`é ü © ° ± ×` …）会被静默乱码。将来若要服务这类调用方，
  **必须显式传编码**，不要靠「顺序碰运气」。
- 最后必须 `replace` 兜底：宁可出现 `￼`，**绝不能抛** —— 抛就等于 `result.stdout` 拿不到，
  `_verify_llama_server_pid` 的「无法确认时不杀」立刻退化成「**永远不杀**」。

## 用法

    from .subproc import run_text

    r = run_text(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], timeout=5)
    return "llama-server" in r.stdout          # stdout 一定是 str，且**一定有值**

⚠️ 不要再传 `text=` / `encoding=` / `errors=` —— 本函数自己负责解码，传了就抛 `TypeError`
   （宁可当场报错，也不要有人绕回来把 reader 线程崩溃重新引入）。

⚠️ 判据在 `tests/test_subproc.py`（23 条）。其中 `TestNoBareTextMode` 是**跨文件**的：
   它用 `ast` 遍历 `core/` + `tools/` + `slime_launcher.py` + `qa.py`，任何
   `text=True` 而**同一次调用**没有 `errors=` 的写法都会被打红（并报出 `文件:行号`）。
   ⇒ 想加新的外部命令调用，要么用 `run_text`，要么至少补 `errors="replace"`；否则门禁红。
"""

from __future__ import annotations

import ctypes
import locale
import os
import subprocess
import sys
from typing import Any, Sequence


def _console_encoding() -> str:
    """Windows **控制台程序**的输出编码 = 控制台 OEM 代码页（中文 Windows = `cp936`）。

    ⚠️ 故意**不用** `locale.getpreferredencoding(False)`：它描述的是"Python 想要什么编码"，
       在 UTF-8 模式（PEP 540）下会返回 `"utf-8"` —— 那正是本次崩溃的来源。
       `GetOEMCP()` 拿的才是"控制台程序实际吐出的编码"。
    """
    if sys.platform == "win32":
        try:
            return f"cp{ctypes.windll.kernel32.GetOEMCP()}"
        except Exception:
            pass  # ctypes 不可用（极少见）→ 退回 locale
    try:
        return locale.getpreferredencoding(False)
    except Exception:
        return "utf-8"


def decode_console(raw: bytes | str | None) -> str:
    """把外部命令的输出**宽容**解成文本 —— **本函数永不抛 `UnicodeDecodeError`**。

    这是整个 A-1134 的判据所在（纯函数，可单测）：只要它不抛，reader 线程就不会死，
    守卫就不会因为"拿不到 stdout"而静默失效。
    """
    if raw is None:
        return ""
    if isinstance(raw, str):
        # 已经解码过（例如被 mock 替换成 text 模式的返回值）⇒ 原样放行，别重复解。
        return raw
    for enc in (_console_encoding(), "utf-8"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    # 兜底：两个都不成立时也只换字符，不抛（抛 = 整条调用链的判据作废）。
    try:
        return raw.decode(_console_encoding(), "replace")
    except Exception:
        return raw.decode("utf-8", "replace")


def run_text(
    cmd: Sequence[str] | str,
    *,
    timeout: float | None = None,
    cwd: str | os.PathLike | None = None,
    env: dict | None = None,
    check: bool = False,
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    """跑一条外部命令，返回 `stdout` / `stderr` **一定已解码成 `str`** 的结果。

    - Windows 上默认加 `CREATE_NO_WINDOW`（不弹黑框；调用方可显式覆盖）；
    - `timeout` / `FileNotFoundError` 等异常语义与 `subprocess.run` **完全一致**
      （调用方现有的 `except Exception` 照旧有效）；
    - `check=True` 时抛 `subprocess.CalledProcessError`（`output`/`stderr` 也是 str）。
    """
    for banned in ("text", "encoding", "errors", "universal_newlines"):
        if banned in kwargs:
            raise TypeError(
                f"run_text 自己负责解码，不要再传 {banned}=；"
                "需要原始字节请直接用 subprocess.run（但要清楚 Windows 上 reader 线程会崩，见模块头注释）"
            )
    if sys.platform == "win32":
        kwargs.setdefault("creationflags", subprocess.CREATE_NO_WINDOW)

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=False,          # ← 关键：解码不发生在 reader 线程里
        timeout=timeout,
        cwd=cwd,
        env=env,
        check=False,         # check 由本函数自己做（要带上已解码的 output）
        **kwargs,
    )
    out = decode_console(proc.stdout)
    err = decode_console(proc.stderr)
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, proc.args, out, err)
    return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)
