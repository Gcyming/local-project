"""知识引擎 + 沉淀引擎测试（A-011：补齐 knowledge/consolidation 直接测试缺口）

对齐 run_tests.py 约定：仅 Test* 类 / test_* 方法 / tmp_path。
所有 KnowledgeEngine 实例使用 tmp_path 作为 data_dir，验证输出隔离
（A-011 修复：rules/generated_skills 尊重 data_dir，不污染生产 Knowledge/ 目录）。
"""


class TestKnowledgeEngine:
    def test_record_pattern_recurrence_and_escalation(self, tmp_path):
        from core.knowledge import KnowledgeEngine
        ke = KnowledgeEngine(agent_id="t1", data_dir=str(tmp_path))
        r1 = ke.record_pattern("task.file-write.fail", "task", "写文件失败", "low")
        assert r1["recurrence"] == 1
        assert r1["action"] is None
        ke.record_pattern("task.file-write.fail", "task", "写文件失败", "low")
        r3 = ke.record_pattern("task.file-write.fail", "task", "写文件失败", "low")
        assert r3["recurrence"] == 3
        assert r3["action"] == "escalate"
        assert r3["new_priority"] == "medium"

    def test_promote_pipeline_thresholds(self, tmp_path):
        """第 5 次晋升 rule、第 8 次晋升 trait 信号、统计正确"""
        from core.knowledge import KnowledgeEngine
        ke = KnowledgeEngine(agent_id="t2", data_dir=str(tmp_path))
        result = None
        for _ in range(8):
            result = ke.record_pattern("task.code-review.success", "task", "审查成功", "medium")
        assert result["action"] == "promote_to_trait"
        assert result["trait_name"] == "Code Review"
        stats = ke.get_stats()
        assert stats["total_patterns"] == 1
        assert stats["total_rules"] == 1  # 第 5 次已晋升 rule
        promotable = ke.get_promotable_traits()
        assert len(promotable) == 1
        assert promotable[0]["name"] == "Code Review"

    def test_invalid_key_rejected(self, tmp_path):
        from core.knowledge import KnowledgeEngine
        ke = KnowledgeEngine(agent_id="t3", data_dir=str(tmp_path))
        r = ke.record_pattern("../etc/passwd", "task", "恶意 key")
        assert r["action"] is None
        assert r.get("error") == "invalid_key"
        assert ke.get_stats()["total_patterns"] == 0

    def test_invalid_category_falls_back_to_task(self, tmp_path):
        from core.knowledge import KnowledgeEngine
        ke = KnowledgeEngine(agent_id="t4", data_dir=str(tmp_path))
        r = ke.record_pattern("ok.key", "hacker", "描述")
        assert r["recurrence"] == 1
        assert ke._patterns["ok.key"].category == "task"

    def test_persistence_roundtrip(self, tmp_path):
        from core.knowledge import KnowledgeEngine
        ke1 = KnowledgeEngine(agent_id="t5", data_dir=str(tmp_path))
        for _ in range(3):
            ke1.record_pattern("task.retry.success", "task", "重试成功")
        ke2 = KnowledgeEngine(agent_id="t5", data_dir=str(tmp_path))
        stats = ke2.get_stats()
        assert stats["total_patterns"] == 1
        assert ke2._patterns["task.retry.success"].recurrence == 3

    def test_rule_markdown_isolated_to_data_dir(self, tmp_path):
        """A-011: 晋升产生的 rules/*.md 写进 data_dir，不污染生产 Knowledge/ 目录"""
        from core.knowledge import KnowledgeEngine
        from pathlib import Path
        ke = KnowledgeEngine(agent_id="t6", data_dir=str(tmp_path))
        result = None
        for _ in range(5):
            result = ke.record_pattern("task.build.fail", "task", "构建失败")
        assert result["action"] == "promote_to_rule"
        rule_id = result["rule"]
        assert (tmp_path / "rules" / f"{rule_id}.md").exists()
        # 生产目录不新增该规则文件
        proj_rules = Path(__file__).resolve().parent.parent / "Knowledge" / "Agent Memory" / "rules"
        if proj_rules.exists():
            assert not (proj_rules / f"{rule_id}.md").exists()

    def test_generate_skill_isolated_to_data_dir(self, tmp_path):
        """A-011: 技能模板写进 data_dir/generated_skills，不污染生产目录"""
        from core.knowledge import KnowledgeEngine
        from pathlib import Path
        ke = KnowledgeEngine(agent_id="t7", data_dir=str(tmp_path))
        for _ in range(10):
            ke.record_pattern("task.foo.bar", "task", "高频成功模式")
        out = ke.generate_skill("task.foo.bar")
        assert out is not None
        skill_dir = Path(out["dir"])
        assert skill_dir.exists()
        assert (skill_dir / "manifest.json").exists()
        assert (skill_dir / "SKILL.md").exists()
        assert "generated_skills" in str(skill_dir)
        assert str(tmp_path) in str(skill_dir)

    def test_generate_skill_below_threshold_returns_none(self, tmp_path):
        from core.knowledge import KnowledgeEngine
        ke = KnowledgeEngine(agent_id="t8", data_dir=str(tmp_path))
        for _ in range(3):
            ke.record_pattern("task.low.count", "task", "次数不足")
        assert ke.generate_skill("task.low.count") is None


class TestConsolidationEngine:
    def test_should_consolidate_interval(self):
        from core.consolidation import ConsolidationEngine
        from core.agent import Agent
        ce = ConsolidationEngine()
        a = Agent(name="a", role="r")
        assert ce.should_consolidate(a) is False  # 0 次交互
        a.evolution["total_interactions"] = 50
        assert ce.should_consolidate(a) is True
        a.evolution["total_interactions"] = 51
        assert ce.should_consolidate(a) is False
        a.evolution["total_interactions"] = 100
        assert ce.should_consolidate(a) is True

    def test_consolidate_reinforces_from_knowledge(self, tmp_path):
        """高频 pattern → L2 行为模式；已有 scenario 跳过避免重复"""
        from core.agent import Agent
        from core.consolidation import ConsolidationEngine
        from core.knowledge import KnowledgeEngine
        ke = KnowledgeEngine(agent_id="c1", data_dir=str(tmp_path))
        for _ in range(8):
            ke.record_pattern("task.code-review.success", "task", "审查成功")
        a = Agent(name="a", role="r")
        ce = ConsolidationEngine()
        reinforced, decayed = ce.consolidate(a, knowledge_engine=ke)
        assert reinforced >= 1
        assert len(a.behavior.patterns) >= 1
        # 已有 scenario 跳过（与 LLM 提取互斥防重复）
        existing = {p.scenario for p in a.behavior.patterns}
        r2, _ = ce.consolidate(a, knowledge_engine=ke, existing_scenarios=existing)
        assert r2 == 0

    def test_consolidate_without_knowledge_engine(self):
        """无知识引擎时只做衰减，不崩溃"""
        from core.agent import Agent
        from core.consolidation import ConsolidationEngine
        a = Agent(name="a", role="r")
        reinforced, decayed = ConsolidationEngine().consolidate(a, knowledge_engine=None)
        assert reinforced == 0
        assert decayed >= 0
