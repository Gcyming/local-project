# -*- coding: utf-8 -*-
"""Soul-Plan 第 7 步：情绪身份叙事测试（docs/soul-plan.md）"""
from core.emotion import EmotionalState


class TestEmotionIdentity:
    """Soul-Plan：events 时间线 / 行为档位 / 自我认知叙事 / 序列化兼容"""

    def test_events_recorded_with_triggers(self):
        e = EmotionalState()
        e.update(success=True, praise=True)
        e.update(success=False, failure_type="tool")
        e.update(novelty=True)
        triggers = [ev["trigger"] for ev in e.events]
        assert triggers == ["praise", "tool", "novelty"], triggers
        assert all("mood_before" in ev and "mood_after" in ev for ev in e.events)

    def test_events_capped_at_8(self):
        e = EmotionalState()
        for _ in range(12):
            e.update(success=True)
        assert len(e.events) == 8, "cap 8"

    def test_serialization_roundtrip_and_old_data(self):
        e = EmotionalState()
        e.update(success=False, failure_type="tool")
        e.update(success=True, praise=True)
        e2 = EmotionalState.from_dict(e.to_dict())
        assert e2.events == e.events
        # 旧数据（无 events）兼容
        old = {"valence": 0.1, "arousal": 0.3, "dominance": 0.5, "mood": "neutral",
               "relational_depth": 0.0, "last_updated": None}
        e3 = EmotionalState.from_dict(old)
        assert e3.events == []
        assert e.clone().events == e.events

    def test_behavior_hint_levels(self):
        # 修正条 1/2：frustrated=0（聚焦）、angry=1（抑制）、concerned/disgusted=2（确认）
        def mk(fails, ftype="tool"):
            e = EmotionalState()
            for _ in range(fails):
                e.update(success=False, failure_type=ftype)
            return e
        fr = mk(6)  # tool 渐进 → frustrated
        assert fr.current_behavior_hint["caution_level"] == 0
        assert "terminal" in fr.current_behavior_hint["promote_groups"]
        ag = EmotionalState()
        for _ in range(3):
            ag.update(success=False, failure_type="task")
        assert ag.mood == "angry"
        assert ag.current_behavior_hint["caution_level"] == 1
        assert ag.current_behavior_hint["promote_groups"] == []
        co = EmotionalState()
        co.update(violation=True)
        assert co.current_behavior_hint["caution_level"] == 2

    def test_identity_prompt_contains_self_narrative(self):
        e = EmotionalState()
        e.update(success=True, praise=True)
        ip = e.to_identity_prompt()
        assert "当前情绪" in ip and "最近感受" in ip
        # frustrated 聚焦台词
        fr = EmotionalState()
        for _ in range(6):
            fr.update(success=False, failure_type="tool")
        assert "聚焦关键路径" in fr.to_identity_prompt()

    def test_tool_failures_do_not_hard_trigger_angry(self):
        """语义裁决：tool 失败不计 consecutive_failures（不参与 ≥3→angry 硬跳闸）"""
        e = EmotionalState()
        for _ in range(5):
            e.update(success=False, failure_type="tool")
        assert e.consecutive_failures == 0
        assert e.mood != "angry"
        # None=默认 task 语义仍计入
        e2 = EmotionalState()
        for _ in range(3):
            e2.update(success=False)
        assert e2.consecutive_failures == 3 and e2.mood == "angry"
