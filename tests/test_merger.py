"""
slime Merger 试运行验证单元测试
"""

import pytest
import asyncio
from unittest.mock import MagicMock

from core.merger import Merger, MergeResult, RiskLevel
from core.swarm import SubTask, TaskState


class TestMerger:
    """Merger 合并器测试"""

    def setup_method(self):
        """每个测试前的初始化"""
        self.task_id = "test-task-001"
        self.original_task = "实现一个用户认证系统"
        self.merger = Merger(self.task_id, self.original_task)

    def _create_subtask(self, name: str, state: str = "done",
                       result: str = "", error: str = "") -> SubTask:
        """创建测试用子任务"""
        st = MagicMock(spec=SubTask)
        st.name = name
        st.state = MagicMock()
        st.state.value = state
        st.description = f"子任务 {name}"
        st.result = result
        st.error = error
        st.rounds = 1
        st.provider_key = "test"
        return st

    # ── collect_results ──────────────────────────────────

    def test_collect_results_empty(self):
        """空子任务列表"""
        context = self.merger.collect_results([])
        assert self.original_task in context
        assert "子 Agent 执行结果" in context

    def test_collect_results_with_subtasks(self):
        """有子任务的结果"""
        subtasks = [
            self._create_subtask("auth_module", "done", "认证模块实现完成"),
            self._create_subtask("db_module", "failed", "", "数据库连接失败"),
        ]
        context = self.merger.collect_results(subtasks)
        assert "auth_module" in context
        assert "db_module" in context
        assert "认证模块实现完成" in context
        assert "数据库连接失败" in context

    # ── analyze_errors ──────────────────────────────────

    def test_analyze_errors_no_errors(self):
        """无错误"""
        subtasks = [
            self._create_subtask("task1", "done", "成功"),
            self._create_subtask("task2", "done", "成功"),
        ]
        errors = self.merger.analyze_errors(subtasks)
        assert errors == []
        assert self.merger.result.errors == []

    def test_analyze_errors_with_failures(self):
        """有失败任务"""
        subtasks = [
            self._create_subtask("task1", "done", "成功"),
            self._create_subtask("task2", "failed", "", "连接超时"),
        ]
        errors = self.merger.analyze_errors(subtasks)
        assert len(errors) == 1
        assert "task2" in errors[0]
        assert "连接超时" in errors[0]

    # ── assess_risks ─────────────────────────────────────

    def test_assess_risks_all_success(self):
        """全部成功"""
        subtasks = [
            self._create_subtask("task1", "done", "成功"),
            self._create_subtask("task2", "done", "成功"),
        ]
        risks = self.merger.assess_risks(subtasks)
        assert len(risks) == 1
        assert risks[0]["level"] == RiskLevel.LOW.value

    def test_assess_risks_some_failure(self):
        """部分失败"""
        subtasks = [
            self._create_subtask("task1", "done", "成功"),
            self._create_subtask("task2", "failed", "", "错误"),
        ]
        risks = self.merger.assess_risks(subtasks)
        assert len(risks) == 1
        assert risks[0]["level"] in [RiskLevel.MEDIUM.value, RiskLevel.HIGH.value]

    def test_assess_risks_all_failure(self):
        """全部失败"""
        subtasks = [
            self._create_subtask("task1", "failed", "", "错误1"),
            self._create_subtask("task2", "failed", "", "错误2"),
        ]
        risks = self.merger.assess_risks(subtasks)
        assert risks[0]["level"] == RiskLevel.CRITICAL.value

    def test_assess_risks_empty(self):
        """无子任务"""
        risks = self.merger.assess_risks([])
        assert risks[0]["level"] == RiskLevel.HIGH.value

    # ── trial_run ────────────────────────────────────────

    def test_trial_run_all_success(self):
        """全部成功，基础检查通过"""
        subtasks = [
            self._create_subtask("task1", "done", "结果1"),
            self._create_subtask("task2", "done", "结果2"),
        ]
        result = asyncio.run(self.merger.trial_run("这是一份好的总结", subtasks))
        assert result["passed"] is True
        assert "基础检查通过" in result["log"]

    def test_trial_run_with_errors(self):
        """有错误，验证失败"""
        self.merger.analyze_errors([
            self._create_subtask("task1", "failed", "", "错误"),
        ])
        subtasks = [
            self._create_subtask("task1", "failed", "", "错误"),
        ]
        result = asyncio.run(self.merger.trial_run("总结", subtasks))
        assert result["passed"] is False
        assert "错误" in result["log"]

    def test_trial_run_with_critical_risk(self):
        """有高风险，验证失败"""
        subtasks = [
            self._create_subtask("task1", "failed", "", "错误1"),
            self._create_subtask("task2", "failed", "", "错误2"),
        ]
        self.merger.analyze_errors(subtasks)
        self.merger.assess_risks(subtasks)
        result = asyncio.run(self.merger.trial_run("总结", subtasks))
        assert result["passed"] is False

    def test_trial_run_no_summary(self):
        """无总结，验证失败"""
        subtasks = [
            self._create_subtask("task1", "done", "结果"),
        ]
        result = asyncio.run(self.merger.trial_run("", subtasks))
        assert result["passed"] is False
        assert "未生成有效总结" in result["log"]

    def test_trial_run_consistency_check(self):
        """一致性检查：矛盾结果"""
        subtasks = [
            self._create_subtask("task1", "done", "认证成功，用户可用"),
            self._create_subtask("task2", "done", "认证失败，服务拒绝访问"),
        ]
        result = asyncio.run(self.merger.trial_run("总结", subtasks))
        # 一致性警告应被记录
        assert "一致性" in result["log"] or "通过" in result["log"]

    def test_trial_run_with_llm_fn(self):
        """带 LLM 函数的质量评估"""
        async def mock_llm_fn(prompt):
            return "8"

        subtasks = [
            self._create_subtask("task1", "done", "结果1"),
            self._create_subtask("task2", "done", "结果2"),
        ]
        result = asyncio.run(self.merger.trial_run("好的总结", subtasks, llm_fn=mock_llm_fn))
        # 应该有质量评分
        assert result["score"] >= 0
        assert result["score"] <= 10

    # ── finalize ─────────────────────────────────────────

    def test_finalize_success(self):
        """完整合并流程：成功"""
        subtasks = [
            self._create_subtask("task1", "done", "结果1"),
            self._create_subtask("task2", "done", "结果2"),
        ]
        result = self.merger.finalize("任务完成，所有模块实现成功", subtasks)
        assert result.trial_passed is True
        assert "✓ 任务完成" in result.final_verdict
        assert result.trial_score > 0

    def test_finalize_with_errors(self):
        """完整合并流程：有错误"""
        subtasks = [
            self._create_subtask("task1", "done", "结果1"),
            self._create_subtask("task2", "failed", "", "错误"),
        ]
        result = self.merger.finalize("部分完成", subtasks)
        assert result.trial_passed is False
        assert "⚠ 任务部分完成" in result.final_verdict

    def test_finalize_result_structure(self):
        """验证结果结构"""
        subtasks = [
            self._create_subtask("task1", "done", "结果1"),
        ]
        result = self.merger.finalize("总结", subtasks)

        # 验证字段
        assert result.task_id == self.task_id
        assert result.original_task == self.original_task
        assert result.summary == "总结"
        assert len(result.subtask_results) == 1
        assert hasattr(result, "trial_passed")
        assert hasattr(result, "trial_score")
        assert hasattr(result, "trial_details")


class TestMergerEdgeCases:
    """边界情况测试"""

    def _make_subtask(self, name: str, state: str, result: str = ""):
        """辅助方法：创建测试用子任务"""
        class SimpleSubtask:
            def __init__(s):
                s.name = name
                s.state = type('obj', (object,), {'value': state})()
                s.description = f"子任务 {name}"
                s.result = result
                s.error = None
                s.rounds = 1
                s.provider_key = "test"
        return SimpleSubtask()

    def test_empty_subtasks(self):
        """空子任务列表"""
        merger = Merger("task-1", "原始任务")
        result = merger.finalize("总结", [])
        assert result.trial_passed is False
        assert "无子任务" in result.trial_log

    def test_very_long_summary(self):
        """超长总结"""
        merger = Merger("task-1", "任务")
        long_summary = "x" * 10000
        subtasks = [self._make_subtask("t1", "done", "结果")]
        result = merger.finalize(long_summary, subtasks)
        assert result.trial_passed is True

    def test_special_characters_in_result(self):
        """结果中包含特殊字符"""
        merger = Merger("task-1", "任务")
        subtasks = [
            self._make_subtask("t1", "done", "结果\n包含\r特殊\t字符"),
        ]
        result = merger.finalize("总结", subtasks)
        assert result.trial_passed is True


# ── A-013: LLM 矛盾裁定 ────────────────────────────────────


class TestConflictAdjudication:
    """启发式冲突 → LLM 裁定（真实矛盾/解除误报/失败保守/无 llm_fn 不裁定）"""

    def setup_method(self):
        self.merger = Merger("t1", "原始任务")

    def _conflict_subtasks(self):
        # 1 正 2 负 → ratio 2/3 > 0.5，触发关键词启发式
        def _st(name, result):
            st = MagicMock(spec=SubTask)
            st.name = name
            st.state = MagicMock(); st.state.value = "done"
            st.result = result; st.error = ""; st.rounds = 1
            return st

        return [
            _st("A", "全部成功，功能完成"),
            _st("B", "编译失败，无法继续"),
            _st("C", "构建出错，存在异常"),
        ]

    def test_heuristic_detects_conflict(self):
        r = self.merger._check_consistency(self._conflict_subtasks())
        assert r["consistent"] is False
        assert r["issue"]

    def test_adjudicate_conflict_true(self):
        async def fake_llm(prompt):
            return '{"is_conflict": true, "reason": "两者对同一构建的结论相反"}'

        r = asyncio.run(self.merger._adjudicate_conflict(fake_llm, self._conflict_subtasks()))
        assert r["is_conflict"] is True
        assert "结论相反" in r["reason"]

    def test_adjudicate_conflict_false(self):
        async def fake_llm(prompt):
            return '分析：{"is_conflict": false, "reason": "一个说功能、一个说编译，不同侧面"}'

        r = asyncio.run(self.merger._adjudicate_conflict(fake_llm, self._conflict_subtasks()))
        assert r["is_conflict"] is False

    def test_adjudicate_invalid_reply_returns_none(self):
        async def fake_llm(prompt):
            return "抱歉无法判断"

        r = asyncio.run(self.merger._adjudicate_conflict(fake_llm, self._conflict_subtasks()))
        assert r["is_conflict"] is None

    def test_trial_run_adjudicates_false_conflict(self):
        """LLM 判定不同侧面 → 解除启发式误报，consistent 变 True"""
        subtasks = self._conflict_subtasks()

        async def fake_llm(prompt):
            return '{"is_conflict": false, "reason": "不同侧面"}'

        result = asyncio.run(self.merger.trial_run("总结内容", subtasks, llm_fn=fake_llm))
        cons = result["details"]["consistency"]
        assert cons["consistent"] is True
        assert cons["llm_adjudication"]["is_conflict"] is False

    def test_trial_run_adjudication_failure_keeps_conflict(self):
        """裁定异常 → 保守保留启发式冲突标记"""
        subtasks = self._conflict_subtasks()

        async def bad_llm(prompt):
            raise RuntimeError("boom")

        result = asyncio.run(self.merger.trial_run("总结", subtasks, llm_fn=bad_llm))
        cons = result["details"]["consistency"]
        assert cons["consistent"] is False
        assert cons["llm_adjudication"]["is_conflict"] is None

    def test_trial_run_without_llm_fn_no_adjudication(self):
        subtasks = self._conflict_subtasks()
        result = asyncio.run(self.merger.trial_run("总结", subtasks))
        cons = result["details"]["consistency"]
        assert cons["consistent"] is False
        assert "llm_adjudication" not in cons


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
