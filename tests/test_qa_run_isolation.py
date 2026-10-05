"""并发 qa.py 的日志与报告隔离（真实多进程行为测试）。

`_run` 以 "w" 打开日志路径，两个并发 qa.py 写同一个 data/qa_<phase>.log 与
data/qa_report.json 就是互相覆盖。判据不看源码字符串，直接起真实 qa.py 子进程并发跑，
再逐份比对内容归属：每份产物只能出现自己那次的 marker，且「最近一次」稳定路径必须是
某一完整运行的逐字节副本（写了一半或两人交错出来的文件都对不上）。

marker 带随机 nonce，所以扫描全部历史 run 目录也不会撞上别的运行或别的工人。
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_DATA = _ROOT / "data"
_RUNS = _DATA / "qa-runs"
_RUN_PREFIX = "qa-"
_LATEST_REPORT = _DATA / "qa_report.json"
_LATEST_LOG = _DATA / "qa_pytest.log"
_NODE = "tests/test_subproc.py::TestNoBareTextMode"
_PHASE_TIMEOUT = 300


def _inner(marker: str, rc: int) -> str:
    lines = [
        "import sys, time, pytest",
        "time.sleep(0.6)",
        f"pytest.main({json.dumps(['-q', _NODE])})",
        f"print({marker!r})",
        "time.sleep(0.6)",
        f"sys.exit({rc})",
    ]
    return "\n".join(lines)


def _driver(marker: str, rc: int) -> str:
    phase = {
        "name": "pytest",
        "timeout": _PHASE_TIMEOUT,
        "cmd": ["-c", _inner(marker, rc)],
        "unique_basetemp": True,
    }
    return "\n".join([
        "import sys",
        f"sys.path.insert(0, {str(_ROOT)!r})",
        "import qa",
        f"qa.PHASES = [{phase!r}]",
        "sys.exit(qa.main())",
    ])


class TestConcurrentQaRunIsolation:
    def _launch(self, drivers):
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", d],
                cwd=str(_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
            )
            for d in drivers
        ]
        return [(p, *p.communicate(timeout=900)) for p in procs]

    def _collect(self, markers):
        found = {}
        for d in sorted(_RUNS.glob(f"{_RUN_PREFIX}*")) if _RUNS.is_dir() else []:
            report = d / "qa_report.json"
            if not report.is_file():
                continue
            text = report.read_text(encoding="utf-8")
            hit = [m for m in markers if m in text]
            if len(hit) != 1:
                continue
            found[hit[0]] = (d.name, json.loads(text))
        return found

    def test_并发运行的日志与报告互不覆盖(self):
        nonce = f"{os.getpid():x}{int(time.time() * 1000) % 0xFFFFFF:06x}"
        markers = [f"QAISO-{nonce}-{i}" for i in range(3)]
        results = [(p.returncode, out) for p, out, _ in self._launch(
            [_driver(m, 0) for m in markers]
        )]

        assert [rc for rc, _ in results] == [0, 0, 0], results
        assert all("QA ALL GREEN" in out for _, out in results), results

        found = self._collect(markers)
        assert sorted(found) == sorted(markers), (
            f"三份运行产物没各自落进独占 run 目录，认领到的只有 {sorted(found)}"
        )
        assert len({name for name, _ in found.values()}) == 3, found

        report_blobs = {}
        log_blobs = {}
        for marker in markers:
            name, data = found[marker]
            assert data["run_id"] == name, data
            assert Path(data["run_dir"]).as_posix() == f"data/qa-runs/{name}", data
            assert data["overall"] == "pass", data
            assert len(data["phases"]) == 1, data
            phase = data["phases"][0]
            assert phase["name"] == "pytest" and phase["status"] == "pass", phase
            assert phase["exit_code"] == 0, phase
            assert Path(phase["log"]).as_posix() == f"data/qa-runs/{name}/qa_pytest.log", phase
            assert Path(phase["log_latest"]).as_posix() == "data/qa_pytest.log", phase

            log_path = _ROOT / phase["log"]
            assert log_path.is_file(), log_path
            log_text = log_path.read_text(encoding="utf-8")
            assert [m for m in markers if m in log_text] == [marker], (
                f"{name} 的日志混进了别人的输出"
            )
            assert [m for m in markers if m in phase["tail"]] == [marker], phase
            assert log_text.count("[开始 ") == 1, "同一日志里出现了两次开头 = 被并写"
            assert log_text.rstrip().endswith("exit=0"), log_text[-200:]

            report_blobs[name] = (
                _RUNS / name / "qa_report.json"
            ).read_bytes()
            log_blobs[name] = log_path.read_bytes()

        assert len(set(report_blobs.values())) == 3, "三次运行的报告内容竟逐字节相同"
        assert len(set(log_blobs.values())) == 3, "三次运行的日志内容竟逐字节相同"
        assert _LATEST_REPORT.read_bytes() in set(report_blobs.values()), (
            "稳定路径不是任一运行的完整报告（写了一半或被覆盖）"
        )
        assert _LATEST_LOG.read_bytes() in set(log_blobs.values()), (
            "稳定路径不是任一运行的完整日志（交错或写了一半）"
        )

    def test_失败运行不污染成功运行的退出码与报告(self):
        nonce = f"{os.getpid():x}{int(time.time() * 1000) % 0xFFFFFF:06x}"
        pass_marker, fail_marker = f"QAOK-{nonce}", f"QABAD-{nonce}"
        results = [(p.returncode, out) for p, out, _ in self._launch([
            _driver(pass_marker, 0), _driver(fail_marker, 3),
        ])]

        assert sorted(rc for rc, _ in results) == [0, 1], results
        ok_out = next(out for rc, out in results if rc == 0)
        bad_out = next(out for rc, out in results if rc == 1)
        assert "QA ALL GREEN" in ok_out and "QA FAILED" not in ok_out, ok_out
        assert "QA FAILED" in bad_out and "QA ALL GREEN" not in bad_out, bad_out

        found = self._collect([pass_marker, fail_marker])
        assert sorted(found) == sorted([pass_marker, fail_marker]), sorted(found)
        assert found[pass_marker][0] != found[fail_marker][0], found

        ok = found[pass_marker][1]
        bad = found[fail_marker][1]
        assert ok["overall"] == "pass", ok
        assert ok["phases"][0]["exit_code"] == 0, ok
        assert bad["overall"] == "fail", bad
        assert bad["phases"][0]["exit_code"] == 3, bad
        assert [m for m in (pass_marker, fail_marker) if m in ok["phases"][0]["tail"]] \
            == [pass_marker], ok["phases"][0]["tail"]
        assert [m for m in (pass_marker, fail_marker) if m in bad["phases"][0]["tail"]] \
            == [fail_marker], bad["phases"][0]["tail"]

        blobs = [
            (_RUNS / name / "qa_report.json").read_bytes()
            for name, _ in found.values()
        ]
        assert len(set(blobs)) == 2, "一过一失败的报告竟逐字节相同"
        assert _LATEST_REPORT.read_bytes() in set(blobs), (
            "稳定路径不是任一运行的完整报告"
        )