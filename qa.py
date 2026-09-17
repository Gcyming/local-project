"""
slime QA 一站式校验入口（纯 Python，无 shell 依赖）

用法: py qa.py

阶段（顺序执行，全部通过才 exit 0）：
  1. compile     — compileall 语法编译检查（core/ tools/ social/ tests/ + 顶层入口）
  2. run_tests   — py run_tests.py（项目约定全量入口）
  3. pytest      — py -m pytest -q（pytest 入口）

报告：data/qa_report.json（汇总）+ data/qa_<phase>.log（每阶段完整输出，UTF-8）

设计动机（2026-08-15）：测验/编译不再经由 PowerShell 管道与引号，
消除转义/编码损坏风险（PowerShell 仅作为零参数启动器 py qa.py）。
子进程以 PYTHONUTF8=1 运行并用 errors=replace 解码，任何编码问题都不会
反写项目文件，只会出现在只读报告里。
"""

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
_DATA = _ROOT / "data"
_REPORT = _DATA / "qa_report.json"

PHASES = [
    {
        "name": "compile",
        "cmd": [
            "-m", "compileall", "-q",
            "core", "tools", "social", "tests",
            "slime_server.py", "slime_cli.py", "slime_launcher.py", "run_tests.py",
        ],
    },
    {"name": "run_tests", "cmd": ["run_tests.py"]},
    {"name": "pytest", "cmd": ["-m", "pytest", "-q"]},
]


def _run(cmd: list[str], timeout: int = 1200) -> tuple[int, str]:
    """运行子进程，捕获 UTF-8 输出。失败不抛异常，返回 (exit_code, output)。"""
    env = dict(__import__("os").environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        proc = subprocess.run(
            [sys.executable] + cmd,
            cwd=str(_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        return -1, f"[超时] {timeout}s 内未完成"
    except OSError as e:
        return -1, f"[启动失败] {e}"


def _tail(text: str, n: int = 12) -> str:
    lines = [l for l in text.splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def main() -> int:
    _DATA.mkdir(parents=True, exist_ok=True)
    print("=" * 60)
    print("  slime QA runner（compile → run_tests → pytest）")
    print("=" * 60)

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "overall": "pass",
        "phases": [],
    }

    for phase in PHASES:
        name = phase["name"]
        started = time.time()
        print(f"\n  ── {name} ──")
        exit_code, output = _run(phase["cmd"])
        duration = round(time.time() - started, 1)

        status = "pass" if exit_code == 0 else "fail"
        log_path = _DATA / f"qa_{name}.log"
        log_path.write_text(output, encoding="utf-8")

        entry = {
            "name": name,
            "status": status,
            "exit_code": exit_code,
            "duration_s": duration,
            "log": str(log_path.relative_to(_ROOT)),
            "tail": _tail(output),
        }
        summary["phases"].append(entry)
        if exit_code != 0:
            summary["overall"] = "fail"

        print(f"    [{status.upper()}] exit={exit_code} {duration}s → {entry['log']}")
        print("    " + _tail(output, 6).replace("\n", "\n    "))

    _REPORT.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("\n" + "=" * 60)
    if summary["overall"] == "pass":
        print(f"  QA ALL GREEN → {_REPORT}")
    else:
        failed = [p["name"] for p in summary["phases"] if p["status"] != "pass"]
        print(f"  QA FAILED: {failed} → 详见 {_REPORT}")
    print("=" * 60)
    return 0 if summary["overall"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
