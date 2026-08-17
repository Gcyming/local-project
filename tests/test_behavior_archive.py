# -*- coding: utf-8 -*-
"""Soul-Plan 第 7 步：行为生命周期测试（归档→召回→再巩固，docs/soul-plan.md）"""
from core.agent import Agent
from core.behavior import BehaviorStore
from core.llm import _retrieve_archived_behavior


class TestBehaviorArchive:
    """Soul-Plan 第 6 步：归档转移 / 双轨召回 / 再巩固起点 / 旧数据兼容"""

    def test_decay_marks_archive(self):
        bs = BehaviorStore()
        p = bs.reinforce("处理批量文件", ["file_read", "file_write"], source="x")
        p.confidence = 0.1  # 模拟衰减至低置信度
        from datetime import datetime, timedelta, timezone
        p.last_reinforced = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        weakened, archived = bs.decay(days=30)
        assert len(archived) == 1 and archived[0].scenario == "处理批量文件"

    def test_archive_removes_from_active(self):
        bs = BehaviorStore()
        p = bs.reinforce("场景A", ["s1"], source="x")
        p.confidence = 0.1
        bs.archive(p)
        assert len(bs.patterns) == 0

    def test_reconsolidate_starting_point(self):
        bs = BehaviorStore()
        rp = bs.reconsolidate("场景A", ["s1"], archived_confidence=0.8)
        assert rp.confidence == max(0.3, 0.8 * 0.5)
        rp2 = bs.reconsolidate("场景B", ["s2"], archived_confidence=0.2)
        assert rp2.confidence == 0.3  # 下限 0.3

    def test_archive_recall_with_overlap(self):
        agent = Agent(name="T", role="t")
        from core.memory import load_memory
        mem = load_memory(agent.id)
        mem._store_categorized(
            "lesson",
            "行为归档：场景「处理批量文件」的步骤 file_read file_write（现已不是习惯）",
            tags=["behavior_archive"], importance=6, extra={"success": True},
        )
        r = _retrieve_archived_behavior(agent, "帮我处理批量文件")
        assert "曾经的行为模式" in (r or "")
        assert "历史记录，仅供参考" in (r or "")

    def test_archive_recall_no_false_hit(self):
        agent = Agent(name="T2", role="t")
        from core.memory import load_memory
        mem = load_memory(agent.id)
        mem._store_categorized(
            "lesson",
            "行为归档：场景「做饭」的步骤（现已不是习惯）",
            tags=["behavior_archive"], importance=6, extra={"success": True},
        )
        r = _retrieve_archived_behavior(agent, "帮我写代码")
        assert r is None or r == ""
