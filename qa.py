"""
slime QA 一站式校验入口（纯 Python，无 shell 依赖）

用法: py qa.py

阶段（顺序执行，全部通过才 exit 0）：
  1. compile     — compileall 语法编译检查（core/ tools/ social/ tests/ + 顶层入口）
  2. run_tests   — py run_tests.py（项目约定全量入口）
  3. pytest      — py -m pytest -q（pytest 入口）

报告与日志：本次运行独占 data/qa-runs/qa-<pid>-<时间戳>/qa_<phase>.log（每阶段完整输出，
UTF-8）与同目录 qa_report.json（汇总）；运行结束再把两者原子发布到「最近一次」稳定路径
data/qa_<phase>.log 与 data/qa_report.json。

为什么两层：稳定路径是既有读取方（tools/git.py 的门禁细节、core/claims.py 的幻觉护栏、
tests/ 的证据用例）唯一认的落点，不能改名也不能消失；而它天生只有一份，两个并发运行
写同一名字就是互相覆盖 —— 稳定路径按「最后一次跑完的运行」语义做，写入走同目录暂存名
+ os.replace，读者不会读到写了一半的文件。真正的本次运行证据只认独占 run 目录，
互不干扰；并发运行互踩的根因（`_run` 以 "w" 打开共享日志路径）由此消除。

遗留 run 目录按与 basetemp 相同的年龄策略回收（阈值 2× 最长阶段超时且不低于 1 小时，
仍在跑的并发运行 age < 阈值恒成立，不可能被误删）。

pytest 阶段的 basetemp 每次运行独占一个 data/pytest_tmp/qa-<pid>-<时间戳>/ 目录，
阶段结束即删除（超时被 kill 时由下次运行按年龄回收）。固定 basetemp 会让并发运行的
pytest 互相 rm_rf 对方的目录，必须每次唯一。根因与 addopts 默认值的分工见 pytest.ini。

每阶段的 data/qa_<phase>.log 是增量落盘的：子进程每产出一批输出立即写入并 flush，
运行中直接看文件就知道卡到哪一步；连续 HEARTBEAT_INTERVAL 秒没有输出时补一行心跳
（时间戳 + 已耗时 + 静默时长）。阶段超时被 kill 时，被杀前捕获到的输出全部保留在
日志和报告 tail 里，不会只剩一句「超时」。

每阶段超时上限取 PHASES[].timeout（默认 1200s）；环境变量 SLIME_QA_TIMEOUT 可全局
覆盖，必须是正整数，否则忽略并沿用默认。

设计动机（2026-08-15）：测验/编译不再经由 PowerShell 管道与引号，
消除转义/编码损坏风险（PowerShell 仅作为零参数启动器 py qa.py）。
子进程以 PYTHONUTF8=1 运行并用 errors=replace 解码，任何编码问题都不会
反写项目文件，只会出现在只读报告里。
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
_DATA = _ROOT / "data"
_REPORT = _DATA / "qa_report.json"

DEFAULT_TIMEOUT = 1200
HEARTBEAT_INTERVAL = 15.0
READ_CHUNK = 65536
TIMEOUT_ENV = "SLIME_QA_TIMEOUT"

BASETEMP_DIRNAME = "pytest_tmp"
BASETEMP_PREFIX = "qa-"
STALE_AGE_FLOOR = 3600.0
STALE_AGE_FACTOR = 2

RUNS_DIRNAME = "qa-runs"
RUN_PREFIX = "qa-"
REPORT_NAME = "qa_report.json"

PHASES = [
    {
        "name": "compile",
        "timeout": DEFAULT_TIMEOUT,
        "cmd": [
            "-m", "compileall", "-q",
            "core", "tools", "social", "tests",
            "slime_server.py", "slime_cli.py", "slime_launcher.py", "run_tests.py",
        ],
    },
    {"name": "run_tests", "timeout": DEFAULT_TIMEOUT, "cmd": ["run_tests.py"]},
    {
        "name": "pytest",
        "timeout": DEFAULT_TIMEOUT,
        "cmd": ["-m", "pytest", "-q"],
        "unique_basetemp": True,
    },
]


def _new_pytest_basetemp() -> Path:
    """本次运行独占的 basetemp 目录（已创建；pytest 接管后会自行 rm -rf 重建）。"""
    root = _DATA / BASETEMP_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    tag = f"{os.getpid()}-{datetime.now().strftime('%H%M%S-%f')}"
    path = root / f"{BASETEMP_PREFIX}{tag}"
    suffix = 0
    while True:
        try:
            path.mkdir(parents=True, exist_ok=False)
            return path
        except FileExistsError:
            suffix += 1
            path = root / f"{BASETEMP_PREFIX}{tag}-{suffix}"


def _discard(path: Path) -> bool:
    try:
        shutil.rmtree(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _prune_stale_basetemps(keep: Path | None, age: float) -> list[str]:
    """回收上一批被 kill 的运行遗留目录。

    basetemp 的 mtime 只会变新，故 age ≤ 本次运行已耗时；阈值取 2× 阶段超时（且不低于
    1 小时）时，age < 阈值恒成立，仍在跑的并发运行不可能被误删。
    """
    removed: list[str] = []
    root = _DATA / BASETEMP_DIRNAME
    now = time.time()
    try:
        children = list(root.glob(f"{BASETEMP_PREFIX}*"))
    except OSError:
        return removed
    for child in children:
        if child == keep:
            continue
        try:
            if child.is_dir() and now - child.stat().st_mtime > age:
                _discard(child)
                removed.append(child.name)
        except OSError:
            continue
    return removed


def _unlink(path: Path) -> bool:
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _new_run_dir() -> Path:
    """本次运行独占的产物目录（已创建）。

    与 basetemp 同理：并发 qa.py 写同一个 data/qa_<phase>.log 会互相覆盖（"w" 打开，
    谁的进程后调度谁的内容就盖掉谁的），所以权威产物必须落进各自独占的目录。
    """
    root = _DATA / RUNS_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    tag = f"{os.getpid()}-{datetime.now().strftime('%H%M%S-%f')}"
    path = root / f"{RUN_PREFIX}{tag}"
    suffix = 0
    while True:
        try:
            path.mkdir(parents=True, exist_ok=False)
            return path
        except FileExistsError:
            suffix += 1
            path = root / f"{RUN_PREFIX}{tag}-{suffix}"


def _publish(src: Path, dst: Path) -> bool:
    """把本次运行的产物发布到「最近一次」稳定路径（不碰 `_run` 的落盘时机）。

    先写同目录暂存名再 os.replace：读者要么看到旧文件要么看到完整新文件，不会读到
    写了一半的报告或半截日志；两个并发运行各自用自己的暂存名，replace 之间也不会串味。
    Windows 上读者正开着目标文件时 os.replace 抛 WinError 32，退回非原子直写。
    """
    tmp = dst.with_name(f"{dst.name}.{os.getpid()}.tmp")
    try:
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)
        return True
    except OSError:
        _unlink(tmp)
        try:
            shutil.copyfile(src, dst)
            return True
        except OSError:
            return False


def _touch(path: Path) -> None:
    """刷新 mtime，让年龄回收判据不依赖「写已有文件是否更新父目录 mtime」的语义差异。"""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _prune_stale_runs(keep: Path | None, age: float) -> list[str]:
    """回收上一批运行（含被 kill 的）遗留的 run 目录，判据与 _prune_stale_basetemps 同源。"""
    removed: list[str] = []
    root = _DATA / RUNS_DIRNAME
    now = time.time()
    try:
        children = list(root.glob(f"{RUN_PREFIX}*"))
    except OSError:
        return removed
    for child in children:
        if child == keep:
            continue
        try:
            if child.is_dir() and now - child.stat().st_mtime > age:
                _discard(child)
                removed.append(child.name)
        except OSError:
            continue
    return removed


def _env_timeout() -> int | None:
    raw = os.environ.get(TIMEOUT_ENV, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _resolve_timeout(phase: dict) -> int:
    override = _env_timeout()
    if override is not None:
        return override
    try:
        declared = int(phase.get("timeout") or DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return declared if declared > 0 else DEFAULT_TIMEOUT


def _run(
    cmd: list[str],
    timeout: int = DEFAULT_TIMEOUT,
    log_path: Path | None = None,
) -> tuple[int, str]:
    """运行子进程，输出实时落盘。失败不抛异常，返回 (exit_code, output)。"""
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    if log_path is None:
        log_path = _DATA / "qa_phase.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    started = time.time()
    collected: list[str] = []
    lock = threading.Lock()
    stop = threading.Event()
    state = {"last_output": started, "ends_with_nl": True}

    with log_path.open("w", encoding="utf-8", newline="") as log:

        def emit(text: str) -> None:
            with lock:
                collected.append(text)
                log.write(text)
                log.flush()
                state["last_output"] = time.time()
                state["ends_with_nl"] = text.endswith("\n")

        def heartbeat() -> None:
            while not stop.wait(HEARTBEAT_INTERVAL):
                now = time.time()
                with lock:
                    if proc.poll() is not None:
                        return
                    stamp = datetime.now().isoformat(timespec="seconds")
                    idle = int(now - state["last_output"])
                    head = "" if state["ends_with_nl"] else "\n"
                    log.write(
                        f"{head}[心跳 {stamp}] 已耗时 {int(now - started)}s 无输出 {idle}s\n"
                    )
                    log.flush()
                    state["ends_with_nl"] = True

        def drain() -> None:
            stream = proc.stdout
            while True:
                try:
                    chunk = stream.read1(READ_CHUNK)
                except (OSError, ValueError):
                    return
                if not chunk:
                    return
                emit(chunk.decode("utf-8", "replace"))

        emit(
            f"[开始 {datetime.now().isoformat(timespec='seconds')}] "
            f"timeout={timeout}s cmd={' '.join(cmd)}\n"
        )

        try:
            proc = subprocess.Popen(
                [sys.executable] + cmd,
                cwd=str(_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
            )
        except OSError as e:
            stop.set()
            emit(f"[启动失败] {e}\n")
            return -1, "".join(collected)

        reader = threading.Thread(target=drain, daemon=True)
        pulse = threading.Thread(target=heartbeat, daemon=True)
        reader.start()
        pulse.start()

        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            proc.wait()
        finally:
            reader.join(timeout=30)
            stop.set()
            pulse.join(timeout=1)
            try:
                proc.stdout.close()
            except (OSError, ValueError):
                pass

        if timed_out:
            emit(
                f"[超时] {timeout}s 内未完成，已 kill PID {proc.pid}；"
                f"以上为被杀前捕获到的全部输出\n"
            )
            return -1, "".join(collected)

        emit(
            f"[结束 {datetime.now().isoformat(timespec='seconds')}] "
            f"exit={proc.returncode}\n"
        )
        return proc.returncode, "".join(collected)


def _tail(text: str, n: int = 12) -> str:
    lines = [l for l in text.splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def main() -> int:
    _DATA.mkdir(parents=True, exist_ok=True)
    run_dir = _new_run_dir()
    stale_runs = _prune_stale_runs(
        run_dir, max(STALE_AGE_FLOOR, STALE_AGE_FACTOR * max(
            (_resolve_timeout(p) for p in PHASES), default=DEFAULT_TIMEOUT))
    )
    override = _env_timeout()
    print("=" * 60)
    print("  slime QA runner（compile → run_tests → pytest）")
    print(f"  本次运行产物目录：{run_dir.relative_to(_ROOT)}")
    if override is not None:
        print(f"  超时上限由 {TIMEOUT_ENV} 覆盖为 {override}s")
    if stale_runs:
        print(f"  回收遗留 run 目录 {len(stale_runs)} 个：{', '.join(stale_runs[:3])}")
    print("=" * 60)

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "run_id": run_dir.name,
        "run_dir": str(run_dir.relative_to(_ROOT)),
        "overall": "pass",
        "phases": [],
    }

    for phase in PHASES:
        name = phase["name"]
        timeout = _resolve_timeout(phase)
        log_path = run_dir / f"qa_{name}.log"
        latest_log = _DATA / f"qa_{name}.log"
        cmd = list(phase["cmd"])
        basetemp = _new_pytest_basetemp() if phase.get("unique_basetemp") else None
        if basetemp is not None:
            cmd.append(f"--basetemp={basetemp}")
            stale = _prune_stale_basetemps(
                basetemp, max(STALE_AGE_FLOOR, STALE_AGE_FACTOR * timeout)
            )
            if stale:
                print(f"    回收遗留 basetemp {len(stale)} 个：{', '.join(stale[:3])}")
        _touch(run_dir)
        print(f"\n  ── {name} ──（超时上限 {timeout}s，日志实时写入）")
        started = time.time()
        try:
            exit_code, output = _run(cmd, timeout, log_path)
        finally:
            if basetemp is not None and not _discard(basetemp):
                print(f"    [警告] basetemp 未能删除（可能被占用）：{basetemp}")
        duration = round(time.time() - started, 1)
        if not _publish(log_path, latest_log):
            print(f"    [警告] 「最近一次」日志未能更新：{latest_log}")

        status = "pass" if exit_code == 0 else "fail"

        entry = {
            "name": name,
            "status": status,
            "exit_code": exit_code,
            "timeout_s": timeout,
            "duration_s": duration,
            "log": str(log_path.relative_to(_ROOT)),
            "log_latest": str(latest_log.relative_to(_ROOT)),
            "tail": _tail(output),
        }
        summary["phases"].append(entry)
        if exit_code != 0:
            summary["overall"] = "fail"

        print(f"    [{status.upper()}] exit={exit_code} {duration}s → {entry['log']}")
        print("    " + _tail(output, 6).replace("\n", "\n    "))

    run_report = run_dir / REPORT_NAME
    run_report.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if not _publish(run_report, _REPORT):
        print(f"    [警告] 「最近一次」报告未能更新：{_REPORT}")

    print("\n" + "=" * 60)
    if summary["overall"] == "pass":
        print(f"  QA ALL GREEN → {run_report}")
    else:
        failed = [p["name"] for p in summary["phases"] if p["status"] != "pass"]
        print(f"  QA FAILED: {failed} → 详见 {run_report}")
    print(f"  「最近一次」稳定路径：{_REPORT} / data/qa_<phase>.log")
    print("=" * 60)
    return 0 if summary["overall"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())