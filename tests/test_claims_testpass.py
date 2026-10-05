import json
from pathlib import Path
from unittest.mock import MagicMock

from core.claims import _PROJECT_ROOT, audit_test_claims, find_unverified_claims
from core.merger import Merger

_GATE_PREFIX = "[开始 2026-10-05T20:01:05] timeout=1200s cmd=-m pytest -q\n.........\n"
_GATE_SUFFIX = "\n[结束 2026-10-05T20:05:33] exit=0\n"


def _gate_log(path, summary, cmd="-m pytest -q"):
    prefix = f"[开始 2026-10-05T20:01:05] timeout=1200s cmd={cmd}\n.........\n"
    path.write_text(prefix + summary + _GATE_SUFFIX, encoding="utf-8")
    return path


def _st(name, result):
    from core.swarm import SubTask
    st = MagicMock(spec=SubTask)
    st.name = name
    st.state = MagicMock()
    st.state.value = "done"
    st.description = f"子任务 {name}"
    st.result = result
    st.error = ""
    st.rounds = 1
    return st


class TestTestPassClaimDetector:
    def test_detector_really_fires(self):
        audit = audit_test_claims("所有测试通过，回归也全绿")
        assert [i.kind for i in audit.issues] == ["test_claim_unverifiable"], audit.issues
        assert audit.issues[0].path == ""
        assert "无法自动判定" in audit.issues[0].detail

    def test_no_test_claim_no_issue(self):
        assert audit_test_claims("报告已保存到 docs/a.md").issues == []
        assert audit_test_claims("测试一下这个模块能不能加载").issues == []
        assert audit_test_claims("任务完成！").issues == []
        assert audit_test_claims("").issues == []

    def test_negated_pass_is_not_a_claim(self):
        assert audit_test_claims("测试尚未通过，仍有 1 个失败").issues == []
        assert audit_test_claims("单测没通过").issues == []

    def test_path_naming_does_not_create_a_test_claim(self, tmp_path):
        target = tmp_path / "tests" / "test_foo.py"
        assert audit_test_claims(f"已保存 {target}（复核通过）").issues == []

    def test_sensitive_file_is_not_parsed_as_evidence(self, tmp_path):
        secret = tmp_path / "auth_token.json"
        secret.write_text('{"token": "s3cr3t", "tail": "999 passed, 7 failed"}', encoding="utf-8")
        issues = audit_test_claims(f"测试全部通过，配置见 {secret}").issues
        assert [i.kind for i in issues] == ["test_claim_unverifiable"], issues
        assert "s3cr3t" not in issues[0].detail
        assert "999 passed" not in issues[0].detail


class TestTestPassClaimAttribution:
    def test_numbers_of_another_suite_do_not_accuse(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_pytest_ok.log", "1034 passed, 4 skipped in 266.33s")
        issues = audit_test_claims(f"run_tests 全部通过（2000 passed），详见 {log}").issues
        assert [i.kind for i in issues] == ["test_claim_unverifiable"], issues

    def test_mixed_suite_claim_is_not_attributed(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_run_tests.log",
            "FAIL 982 passed, 1 failed (100%) -- 983 total",
            cmd="run_tests.py",
        )
        reply = f"run_tests 1 failed 是既有缺陷，pytest 1034 passed 全绿，全部门禁通过，见 {log}"
        issues = audit_test_claims(reply).issues
        assert [i.kind for i in issues] == ["test_claim_unverifiable"], issues

    def test_same_suite_claim_is_still_checked(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_run_tests.log",
            "FAIL 982 passed, 1 failed (100%) -- 983 total",
            cmd="run_tests.py",
        )
        reply = f"run_tests 全部通过（982 passed），详见 {log}"
        assert [i.kind for i in audit_test_claims(reply).issues] == ["test_claim_contradicted"]

    def test_record_time_is_reported(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_pytest_probe.log",
            "FAIL 982 passed, 1 failed (100%) -- 983 total",
        )
        detail = audit_test_claims(f"全量测试已通过，见 {log}").issues[0].detail
        assert "2026-10-05T20:01:05" in detail, detail


class TestTestPassClaimEvidence:
    def test_cited_log_with_failures_contradicts_pass_claim(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_pytest_probe.log",
            "FAIL 982 passed, 1 failed (100%) -- 983 total",
        )
        issues = audit_test_claims(f"全量测试已通过，见 {log}").issues
        assert [i.kind for i in issues] == ["test_claim_contradicted"], issues
        assert issues[0].severity == "high"
        assert "1 failed" in issues[0].detail
        assert str(log) in issues[0].detail
        assert find_unverified_claims(f"全量测试已通过，见 {log}") == [issues[0].detail]

    def test_cited_log_matching_claim_passes(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_pytest_ok.log",
            "1034 passed, 4 skipped in 266.33s (0:04:26)",
        )
        assert audit_test_claims(f"pytest 全部通过（1034 passed），详见 {log}").issues == []

    def test_cited_log_with_mismatched_numbers_contradicts(self, tmp_path):
        log = _gate_log(tmp_path / "qa_pytest_ok.log", "1034 passed, 4 skipped in 266.33s")
        issues = audit_test_claims(f"全量测试通过，共 2000 passed，详见 {log}").issues
        assert [i.kind for i in issues] == ["test_claim_contradicted"], issues
        assert "2000" in issues[0].detail and "1034" in issues[0].detail

    def test_cited_log_with_mismatched_failed_count_contradicts(self, tmp_path):
        log = _gate_log(tmp_path / "qa_pytest_ok.log", "1034 passed, 4 skipped in 266.33s")
        issues = audit_test_claims(f"回归通过，只有 2 个失败，详见 {log}").issues
        assert [i.kind for i in issues] == ["test_claim_contradicted"], issues
        assert "2 failed" in issues[0].detail and "1034 passed" in issues[0].detail

    def test_missing_evidence_file_is_hard_signal(self, tmp_path):
        ghost = tmp_path / "qa_pytest_never_written.log"
        assert not ghost.exists()
        issues = audit_test_claims(f"全量测试已通过，输出见 {ghost}").issues
        assert [i.kind for i in issues] == ["test_claim_evidence_missing"], issues
        assert issues[0].severity == "high"
        assert str(ghost) in issues[0].detail

    def test_evidence_without_parsable_summary_is_unverifiable(self, tmp_path):
        log = tmp_path / "qa_pytest_nothing.log"
        log.write_text("开始运行\n还没有结果\n", encoding="utf-8")
        issues = audit_test_claims(f"全量测试已通过，见 {log}").issues
        assert [i.kind for i in issues] == ["test_claim_unverifiable"], issues
        assert issues[0].severity == "low"

    def test_qa_report_json_evidence_reads_the_named_phase(self, tmp_path):
        report = tmp_path / "qa_report_probe.json"
        report.write_text(json.dumps({
            "generated_at": "2026-10-05T11:56:16+00:00",
            "overall": "fail",
            "phases": [
                {"name": "compile", "status": "pass", "tail": "exit=0"},
                {"name": "run_tests", "status": "fail", "tail": "FAIL 982 passed, 1 failed (100%)"},
                {"name": "pytest", "status": "pass", "tail": "1034 passed, 4 skipped in 266.33s"},
            ],
        }, ensure_ascii=False), encoding="utf-8")
        assert audit_test_claims(f"pytest 全量通过，报告见 {report}").issues == []
        issues = audit_test_claims(f"run_tests 全量通过，报告见 {report}").issues
        assert [i.kind for i in issues] == ["test_claim_contradicted"], issues
        assert "982 passed" in issues[0].detail and "1 failed" in issues[0].detail

    def test_unverifiable_claim_never_becomes_a_hard_signal(self):
        reply = "所有测试通过，回归也全绿"
        issues = audit_test_claims(reply).issues
        assert [i.kind for i in issues] == ["test_claim_unverifiable"]
        assert issues[0].severity == "low"
        assert find_unverified_claims(reply) == []

    def test_unverifiable_detail_carries_last_recorded_gate(self):
        detail = audit_test_claims("所有测试通过").issues[0].detail
        if (_PROJECT_ROOT / "data" / "qa_report.json").is_file():
            assert "最近一次落盘门禁" in detail, detail
        else:
            assert "无法自动判定" in detail, detail

    def test_real_repo_gate_log_verdict_follows_its_own_numbers(self):
        from core.claims import _outcome_for_evidence
        log = _PROJECT_ROOT / "data" / "qa_run_tests.log"
        if not log.is_file():
            return
        reply = "run_tests 全部通过，见 data/qa_run_tests.log"
        outcome = _outcome_for_evidence(log, reply)
        assert outcome is not None and outcome["failed"] is not None, outcome
        issues = audit_test_claims(reply).issues
        if outcome["failed"] > 0:
            assert [i.kind for i in issues] == ["test_claim_contradicted"], issues
            assert f"{outcome['failed']} 个失败" in issues[0].detail
        else:
            assert issues == [], issues


class TestMergerTestClaimGuard:
    def setup_method(self):
        self.merger = Merger("task-1", "跑一遍全量门禁并修掉失败用例")

    def test_contradicted_claim_fails_trial(self, tmp_path):
        log = _gate_log(
            tmp_path / "qa_pytest_probe.log",
            "FAIL 982 passed, 1 failed (100%) -- 983 total",
        )
        st = _st("w1", f"全量测试已通过，见 {log}")
        result = self.merger.finalize("本轮任务执行完毕，下面是本轮的执行说明与产出清单。", [st])
        assert result.trial_passed is False
        assert sum("[test_claim_contradicted]" in e for e in result.errors) == 1
        assert any("1 failed" in e for e in result.errors), result.errors

    def test_missing_evidence_fails_trial(self, tmp_path):
        ghost = tmp_path / "qa_pytest_never_written.log"
        st = _st("w1", f"全量测试已通过，输出见 {ghost}")
        result = self.merger.finalize("本轮任务执行完毕，下面是本轮的执行说明与产出清单。", [st])
        assert result.trial_passed is False
        assert any("[test_claim_evidence_missing]" in e for e in result.errors)

    def test_supported_claim_passes(self, tmp_path):
        log = _gate_log(tmp_path / "qa_pytest_ok.log", "1034 passed, 4 skipped in 266.33s")
        st = _st("w1", f"pytest 全部通过（1034 passed），详见 {log}")
        result = self.merger.finalize("本轮任务执行完毕，下面是本轮的执行说明与产出清单。", [st])
        assert result.trial_passed is True
        assert not any("幻觉护栏" in e for e in result.errors)

    def test_unverifiable_claim_is_risk_not_failure(self):
        st = _st("w1", "所有测试通过，回归也全绿")
        result = self.merger.finalize("本轮任务执行完毕，下面是本轮的执行说明与产出清单。", [st])
        assert result.trial_passed is True
        assert not any("幻觉护栏" in e for e in result.errors)
        flagged = [r for r in result.risks if "无法自动核验" in r["description"]]
        assert [r["level"] for r in flagged] == ["medium"], result.risks
        assert result.risks[-1] is flagged[0]
        assert "无法自动核验" in result.final_verdict
