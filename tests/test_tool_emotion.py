# -*- coding: utf-8 -*-
"""Soul-Plan 第 7 步：工具情绪闭环测试（环 2/3，docs/soul-plan.md）+ P1-14 工具去重"""
import asyncio
from unittest.mock import patch

import pytest

from core.agent import Agent
from core.llm import _execute_pending_tools, _retrieve_tool_experience


class TestToolEmotion:
    """Soul-Plan 环 2（工具成败→情绪）+ 环 3（经验沉淀/注入）"""

    def _agent(self):
        return Agent(name="T", role="t", model_choice="api:x")

    @pytest.mark.asyncio
    async def test_two_consecutive_failures_trigger_tool_signal(self):
        agent = self._agent()
        from tools.registry import get_registry
        from tools.builtin import register_builtin_tools
        register_builtin_tools()
        reg = get_registry()
        from core.sandbox import get_sandbox_manager
        mgr = get_sandbox_manager()
        mgr.config.auto_approve_tools = ["file_read"]

        async def fake_call(name, args):
            return "[错误] 模拟失败"

        with patch.object(reg, "call_tool", side_effect=fake_call):
            await _execute_pending_tools(agent, [], [
                {"id": "c1", "type": "function", "function": {"name": "file_read", "arguments": '{"path": "x"}'}},
                {"id": "c2", "type": "function", "function": {"name": "file_read", "arguments": '{"path": "y"}'}},
            ])
        triggers = [ev["trigger"] for ev in agent.emotion.events]
        assert "tool" in triggers
        assert agent.emotion.consecutive_failures == 0  # 不计硬跳闸

    @pytest.mark.asyncio
    async def test_success_after_failure_resets_streak(self):
        """双计归并：轮内一成一败 → 不触发 tool 信号（连续失败被打断即重置）"""
        agent = self._agent()
        from tools.registry import get_registry
        from tools.builtin import register_builtin_tools
        register_builtin_tools()
        reg = get_registry()
        from core.sandbox import get_sandbox_manager
        mgr = get_sandbox_manager()
        mgr.config.auto_approve_tools = ["file_read"]
        calls = {"n": 0}

        async def fake_call(name, args):
            calls["n"] += 1
            return "[错误] 模拟失败" if calls["n"] == 1 else "ok"

        with patch.object(reg, "call_tool", side_effect=fake_call):
            await _execute_pending_tools(agent, [], [
                {"id": "c1", "type": "function", "function": {"name": "file_read", "arguments": '{"path": "x"}'}},
                {"id": "c2", "type": "function", "function": {"name": "file_read", "arguments": '{"path": "y"}'}},
            ])
        triggers = [ev["trigger"] for ev in agent.emotion.events]
        assert "tool" not in triggers, "一成一败不触发（连续失败被成功打断）"

    def test_ring3_deposit_and_inject(self):
        """环 3：工具经验沉淀入库 + 按场景命中注入（标注历史记录非指令）"""
        agent = self._agent()
        from core.memory import load_memory
        mem = load_memory(agent.id)
        mem.add_lesson("用 web_search 处理 查询类请求成功", True, importance=4)
        exp = _retrieve_tool_experience(agent, "帮我查询天气")
        assert "工具经验" in (exp or "")
        assert "历史记录，仅供参考" in (exp or "")


class TestToolDedup:
    """P1-14：请求级重复调用去重（相同 name+args 只执行一次）"""

    def _agent(self):
        return Agent(name="D", role="r", model_choice="api:x")

    def _setup(self):
        from tools.registry import get_registry
        from tools.builtin import register_builtin_tools
        register_builtin_tools()
        reg = get_registry()
        from core.sandbox import get_sandbox_manager
        mgr = get_sandbox_manager()
        mgr.config.auto_approve_tools = ["file_read"]
        return reg

    def _tc(self, call_id, path):
        return {"id": call_id, "type": "function",
                "function": {"name": "file_read", "arguments": '{"path": "%s"}' % path}}

    @pytest.mark.asyncio
    async def test_same_call_deduped_within_request(self):
        agent = self._agent()
        reg = self._setup()
        from core.agent_context import dedup_tools_log
        calls = {"n": 0}

        async def fake_call(name, args):
            calls["n"] += 1
            return "ok"

        token = dedup_tools_log.set([])
        try:
            with patch.object(reg, "call_tool", side_effect=fake_call):
                msgs = []
                await _execute_pending_tools(agent, msgs, [
                    self._tc("c1", "x"),
                    self._tc("c2", "x"),
                ])
        finally:
            dedup_tools_log.reset(token)
        assert calls["n"] == 1, "相同 name+args 的重复调用应只执行一次"
        assert any("[提示]" in m.get("content", "") for m in msgs)

    @pytest.mark.asyncio
    async def test_different_args_not_deduped(self):
        agent = self._agent()
        reg = self._setup()
        from core.agent_context import dedup_tools_log
        calls = {"n": 0}

        async def fake_call(name, args):
            calls["n"] += 1
            return "ok"

        token = dedup_tools_log.set([])
        try:
            with patch.object(reg, "call_tool", side_effect=fake_call):
                await _execute_pending_tools(agent, [], [
                    self._tc("c1", "x"),
                    self._tc("c2", "y"),
                ])
        finally:
            dedup_tools_log.reset(token)
        assert calls["n"] == 2, "参数不同不拦截"

    @pytest.mark.asyncio
    async def test_dedup_spans_rounds(self):
        """跨轮（两次 _execute_pending_tools 调用）共享同一请求级集合"""
        agent = self._agent()
        reg = self._setup()
        from core.agent_context import dedup_tools_log
        calls = {"n": 0}

        async def fake_call(name, args):
            calls["n"] += 1
            return "ok"

        token = dedup_tools_log.set([])
        try:
            with patch.object(reg, "call_tool", side_effect=fake_call):
                tcs = [self._tc("c1", "x")]
                await _execute_pending_tools(agent, [], tcs)
                msgs = []
                await _execute_pending_tools(agent, msgs, tcs)
        finally:
            dedup_tools_log.reset(token)
        assert calls["n"] == 1, "第二轮重复调用应被去重"
        assert any("[提示]" in m.get("content", "") for m in msgs)

    @pytest.mark.asyncio
    async def test_no_context_no_dedup(self):
        """直调（无请求上下文）不去重，兼容旧行为"""
        agent = self._agent()
        reg = self._setup()
        calls = {"n": 0}

        async def fake_call(name, args):
            calls["n"] += 1
            return "ok"

        with patch.object(reg, "call_tool", side_effect=fake_call):
            await _execute_pending_tools(agent, [], [
                self._tc("c1", "x"),
                self._tc("c2", "x"),
            ])
        assert calls["n"] == 2, "无请求上下文时保持原行为"

    @pytest.mark.asyncio
    async def test_failed_call_still_deduped(self):
        """真实执行过（即使失败）也记录去重——失败结果已回填，重复调用无意义"""
        agent = self._agent()
        reg = self._setup()
        from core.agent_context import dedup_tools_log
        calls = {"n": 0}

        async def fake_call(name, args):
            calls["n"] += 1
            return "[错误] 模拟失败"

        token = dedup_tools_log.set([])
        try:
            with patch.object(reg, "call_tool", side_effect=fake_call):
                await _execute_pending_tools(agent, [], [
                    self._tc("c1", "x"),
                    self._tc("c2", "x"),
                ])
        finally:
            dedup_tools_log.reset(token)
        assert calls["n"] == 1, "失败调用同样记录去重（结果已回填）"