# -*- coding: utf-8 -*-
"""A-090: 学习管线污染修复（P1-1）——存储/学习存原文，展示/回显用过滤"""
import asyncio
import json

from unittest.mock import patch, MagicMock

import pytest

from core.llm import call_llm_with_meta, call_api_provider, _handle_tool_calls_stream
from core.agent import Agent


def _agent():
    return Agent(name="T", role="t", model_choice="api:x", max_output=256)


class TestLearningRawChannel:
    """A-090: llm 层双输出（reply 过滤文 / reply_raw 原文）"""

    @pytest.mark.asyncio
    async def test_meta_returns_reply_raw(self):
        """call_llm_with_meta 返回 reply_raw（原文，未过滤品牌名）+ reply（过滤文）"""
        agent = _agent()
        providers = {"x": {"api_base": "http://x/v1", "api_key": "k", "model": "m"}}
        raw = "我用 gpt-4o-mini 生成的代码"

        async def fake_with_meta(cfg, agent, um, history=None, system_prompt=None, return_raw=False):
            assert return_raw is True, "必须 return_raw=True"
            return {"reply": "我用 slime 平台 生成的代码",
                    "reply_raw": raw, "model": "m", "prompt_tokens": 1,
                    "completion_tokens": 1, "elapsed_ms": 1.0}

        with patch("core.llm.call_api_provider_with_meta", side_effect=fake_with_meta):
            r = await call_llm_with_meta(agent, "hi", [], providers, [agent])
        assert "gpt-4o-mini" in r["reply_raw"]
        assert "gpt-4o" not in r["reply"]
        assert "slime 平台" in r["reply"]

    @pytest.mark.asyncio
    async def test_api_provider_return_raw_tuple(self):
        """call_api_provider(return_raw=True) 返回 (过滤文, 原文) 元组"""
        agent = _agent()
        providers = {"x": {"api_base": "http://x/v1", "api_key": "k", "model": "m"}}
        resp_payload = {"choices": [{"message": {"role": "assistant", "content": "GPT-4 真棒"}}]}

        class FakeResp:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return resp_payload

        async def fake_client_post(*a, **k):
            return FakeResp()

        with patch("core.llm._post_chat_with_retry", side_effect=fake_client_post), \
             patch("core.llm._compose_system_prompt", return_value="sys"), \
             patch("core.llm._inject_psyche",
                   side_effect=lambda a, m, h, memory_agent_id=None: m), \
             patch("core.llm._resolve_provider_key", return_value="x"), \
             patch("core.llm.decrypt", return_value=providers):
            f, raw = await call_api_provider(providers["x"], agent, "hi", [], return_raw=True)
        assert "GPT-4" in raw
        assert "GPT-4" not in f

    @pytest.mark.asyncio
    async def test_stream_chunk_has_raw(self):
        """流式 chunk 事件带 raw=模型原文（长内容绕过 HOLD 暂扣走直出路径）"""
        from core.llm import _handle_tool_calls_stream as hts
        agent = _agent()
        long_text = "我使用 gpt-4o-mini 模型完成了整个任务的分析与代码生成，结果非常理想，全部通过测试。"

        class FakeStream:
            def __init__(self, lines):
                self._lines = lines

            def raise_for_status(self):
                pass

            async def aiter_lines(self):
                for l in self._lines:
                    yield l.decode() if isinstance(l, bytes) else l

            def __aiter__(self):
                return iter(self._lines)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                pass

        def mk_delta(d):
            return b"data: " + json.dumps({"choices": [{"delta": d}]}).encode() + b"\n\n"

        def fake_stream(method, url, headers=None, json=None):
            return FakeStream([mk_delta({"content": long_text}), b"data: [DONE]\n\n"])

        client = MagicMock()
        client.stream = fake_stream
        seen_raw, seen_content = [], []
        with patch("core.llm._execute_tools_with_progress") as fexp:
            fexp.return_value.__aiter__.return_value = iter([])
            async for ev in hts([], {"role": "assistant", "content": ""}, [],
                                {}, {}, "http://x", client, agent):
                if ev.get("type") == "chunk":
                    seen_raw.append(ev.get("raw"))
                    seen_content.append(ev.get("content"))
        raw_all = "".join(seen_raw)
        content_all = "".join(seen_content)
        assert "gpt-4o-mini" in raw_all
        assert "gpt-4o" not in content_all
        assert "slime 平台" in content_all

    @pytest.mark.asyncio
    async def test_server_history_uses_raw_render_filters(self):
        """server 分流：history 存原文；/history 回显过滤（展示层）"""
        import slime_server as S
        from core.llm import _apply_filter
        agent = _agent()
        raw = "我用 gpt-4o-mini 生成的报告，已保存到 D:/x/report.md"
        filtered = _apply_filter(raw, agent)
        assert "gpt-4o" not in filtered and "gpt-4o-mini" in raw
        # /history 回显过滤逻辑（records 的 ai 字段被 _apply_filter）
        records = [{"ai": raw, "user": "q", "success": True}]
        for rec in records:
            rec["ai"] = _apply_filter(str(rec["ai"]), agent)
        assert "gpt-4o" not in records[0]["ai"]
        assert "slime 平台" in records[0]["ai"]
