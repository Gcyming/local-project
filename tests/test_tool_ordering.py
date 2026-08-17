# -*- coding: utf-8 -*-
"""Soul-Plan 第 7 步：工具排序 + 审慎承诺测试（三杠杆，docs/soul-plan.md）"""
from core.agent import Agent
from core.emotion import EmotionalState
from core.llm import _order_tools_schema, _compose_system_prompt


class TestToolOrdering:
    """Soul-Plan 第 4 步：promote 排序 + caution 注入"""

    SCHEMA = [{"function": {"name": n}} for n in
              ["file_write", "web_search", "file_read", "skill_search"]]

    def _agent_with_mood(self, mood):
        a = Agent(name="T", role="t")
        a.emotion = EmotionalState()
        a.emotion.mood = mood
        return a

    def test_interested_promotes_retrieval(self):
        a = self._agent_with_mood("interested")
        names = [t["function"]["name"] for t in _order_tools_schema(self.SCHEMA, a)]
        assert names[0] == "web_search" and names[1] == "skill_search"

    def test_frustrated_promotes_terminal_write(self):
        a = self._agent_with_mood("frustrated")
        names = [t["function"]["name"] for t in _order_tools_schema(self.SCHEMA, a)]
        assert names[0] == "file_write"

    def test_angry_no_promote(self):
        a = self._agent_with_mood("angry")
        assert [t["function"]["name"] for t in _order_tools_schema(self.SCHEMA, a)] == \
               [t["function"]["name"] for t in self.SCHEMA]

    def test_neutral_no_reorder(self):
        a = self._agent_with_mood("neutral")
        assert [t["function"]["name"] for t in _order_tools_schema(self.SCHEMA, a)] == \
               [t["function"]["name"] for t in self.SCHEMA]

    def test_caution_injection(self):
        # angry(caution=1) → 审慎承诺注入；neutral(0) → 无
        a1 = self._agent_with_mood("angry")
        assert "先向用户确认" in _compose_system_prompt(a1)
        a2 = self._agent_with_mood("neutral")
        assert "行为承诺" not in _compose_system_prompt(a2)
