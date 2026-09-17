# -*- coding: utf-8 -*-
"""A-149 补漏：上游忽略 stream:true（非流式完整 JSON / message 形态 SSE 块）时
正文/思考/工具调用恢复——此前静默返回空回复（GUI 只显示耗时无内容）。

覆盖：_chunk_fields 三形态、_content_text 展开、_extract_nonstream_message 兜底、
_merge_complete_tool_calls 整体并入、call_api_provider_stream 与
_handle_tool_calls_stream 的真实事件流恢复。"""
import json
from contextlib import ExitStack

from unittest.mock import patch, MagicMock

import pytest

from core.llm import (
    call_api_provider_stream,
    _handle_tool_calls_stream,
    _chunk_fields,
    _content_text,
    _extract_nonstream_message,
    _merge_complete_tool_calls,
    _accumulate_tool_calls,
)
from core.agent import Agent


def _agent(**kw):
    base = dict(name="T", role="t", model_choice="api:x", max_output=256)
    base.update(kw)
    return Agent(**base)


class FakeStream:
    """模拟 httpx 流式响应：aiter_lines 逐行产出，async with 可进入。"""

    def __init__(self, lines):
        self._lines = lines

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for l in self._lines:
            yield l.decode() if isinstance(l, bytes) else l

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        pass


def _sse_lines(payloads, done=True):
    out = [b"data: " + json.dumps(p).encode() + b"\n\n" for p in payloads]
    if done:
        out.append(b"data: [DONE]\n\n")
    return out


def _stream_client(lines):
    client = MagicMock()
    client.stream = lambda *a, **k: FakeStream(lines)
    return client


_STREAM_PATCHES = [
    "core.llm._compose_system_prompt",
    "core.llm._inject_psyche",
    "core.llm._filter_tools_schema",
]


def _patch_ctx(client):
    """组合多个 patch 为单个上下文管理器（ExitStack）——裸元组不支持 with 协议（A-149 回归修复）。"""
    stack = ExitStack()
    stack.enter_context(patch("core.llm._get_shared_client", return_value=client))
    stack.enter_context(patch("core.llm._compose_system_prompt", return_value="sys"))
    stack.enter_context(patch("core.llm._inject_psyche",
                              side_effect=lambda a, m, h, memory_agent_id=None: m))
    stack.enter_context(patch("core.llm._filter_tools_schema", return_value=[]))
    return stack


class TestChunkFields:
    """_chunk_fields：delta / message / messages 三形态内容源提取"""

    def test_delta_shape(self):
        assert _chunk_fields({"choices": [{"delta": {"content": "a"}}]}) == ({"content": "a"}, {})

    def test_message_shape(self):
        assert _chunk_fields({"choices": [{"message": {"content": "b"}}]}) == ({}, {"content": "b"})

    def test_messages_array_uses_last(self):
        assert _chunk_fields(
            {"choices": [{"messages": [{"content": "x"}, {"content": "y"}]}]}
        ) == ({}, {"content": "y"})

    def test_empty(self):
        assert _chunk_fields({}) == ({}, {})
        assert _chunk_fields({"choices": []}) == ({}, {})


class TestContentText:
    """_content_text：正文统一转字符串"""

    def test_str(self):
        assert _content_text("hello") == "hello"

    def test_blocks(self):
        assert _content_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "ab"

    def test_other(self):
        assert _content_text(None) == ""
        assert _content_text(123) == ""


class TestNonstreamMessage:
    """_extract_nonstream_message：非 data: 行文本中恢复 message 形态"""

    def _completion(self, message):
        return {
            "id": "x", "object": "chat.completion", "created": 1,
            "model": "ling-3.0-flash-fin-free",
            "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        }

    def test_full_json(self):
        body = self._completion({"role": "assistant", "content": "test1"})
        out = _extract_nonstream_message(json.dumps(body))
        assert out["content"] == "test1"
        assert out["model"] == "ling-3.0-flash-fin-free"

    def test_gunk_around_json(self):
        body = self._completion({"role": "assistant", "content": "gunk正文", "reasoning_content": "思考"})
        raw = "HTTP/1.1 200 OK\ncontent-type: application/json\n" + json.dumps(body) + "\n\n"
        out = _extract_nonstream_message(raw)
        assert out["content"] == "gunk正文"
        assert out["reasoning_content"] == "思考"

    def test_raw_garbage(self):
        assert _extract_nonstream_message("<html>502 Bad Gateway</html>") == {}
        assert _extract_nonstream_message("") == {}

    def test_tool_calls(self):
        body = self._completion({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": "web_search", "arguments": '{"q":"x"}'}}],
        })
        out = _extract_nonstream_message(json.dumps(body))
        assert out["tool_calls"][0]["function"]["name"] == "web_search"


class TestMergeCompleteToolCalls:
    """message 形态完整 tool_calls 整体并入（不重复增量拼接）"""

    def test_append_complete(self):
        calls = []
        _merge_complete_tool_calls(calls, [{
            "id": "c1", "type": "function",
            "function": {"name": "web_search", "arguments": '{"q":"x"}'},
        }])
        assert calls[0]["id"] == "c1"
        assert calls[0]["function"]["name"] == "web_search"
        assert calls[0]["function"]["arguments"] == '{"q":"x"}'

    def test_interop_with_incremental(self):
        calls = []
        _accumulate_tool_calls(calls, {"tool_calls": [
            {"index": 0, "id": "c1", "type": "function", "function": {"name": "a", "arguments": ""}},
        ]})
        _merge_complete_tool_calls(calls, [{
            "id": "c1", "type": "function",
            "function": {"name": "a", "arguments": '{"x":1}'},
        }])
        # 增量已拼 name；完整对象不覆盖已有 name/arguments 中的非空部分
        assert calls[0]["function"]["name"] == "a"
        assert calls[0]["function"]["arguments"] == '{"x":1}'


class TestStreamMessageShape:
    """call_api_provider_stream：message 形态 SSE 块 / 非流式 JSON 恢复正文"""

    _CFG = {"api_base": "http://x/v1", "api_key": "k", "model": "ling-3.0-flash-fin-free"}

    @pytest.mark.asyncio
    async def test_message_shape_sse_recovers_content(self):
        """message 形态单块 + [DONE]（model 在行内）→ 正文恢复（此前静默空回复）"""
        agent = _agent()
        lines = _sse_lines([{
            "id": "s1", "object": "chat.completion.chunk", "created": 1,
            "model": "ling-3.0-flash-fin-free",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "test1"},
                         "finish_reason": "stop"}],
        }])
        chunks, done = [], None
        with _patch_ctx(_stream_client(lines)):
            async for ev in call_api_provider_stream(self._CFG, agent, "t", []):
                if ev["type"] == "chunk":
                    chunks.append(ev["content"])
                elif ev["type"] == "done":
                    done = ev
        assert "".join(chunks) == "test1"
        assert done["reply"] == "test1"
        assert done["model"] == "ling-3.0-flash-fin-free"

    @pytest.mark.asyncio
    async def test_nonstream_json_recovers_content(self):
        """全程无 data: 行（完整非流式 JSON）→ 兜底恢复正文"""
        agent = _agent()
        blob = json.dumps({
            "id": "x", "object": "chat.completion", "created": 1,
            "model": "ling-3.0-flash-fin-free",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "非流式正文"},
                         "finish_reason": "stop"}],
        })
        chunks, done = [], None
        with _patch_ctx(_stream_client([blob.encode()])):
            async for ev in call_api_provider_stream(self._CFG, agent, "t", []):
                if ev["type"] == "chunk":
                    chunks.append(ev["content"])
                elif ev["type"] == "done":
                    done = ev
        assert "".join(chunks) == "非流式正文"
        assert done["reply"] == "非流式正文"

    @pytest.mark.asyncio
    async def test_message_shape_reasoning_yielded(self):
        """message 形态携带 reasoning_content → 思考事件 + 正文恢复"""
        agent = _agent(show_thinking="on")
        lines = _sse_lines([{
            "id": "s1", "object": "chat.completion.chunk", "created": 1,
            "model": "ling-3.0-flash-fin-free",
            "choices": [{"index": 0,
                         "message": {"role": "assistant", "content": "正文X",
                                     "reasoning_content": "缓冲思考"},
                         "finish_reason": "stop"}],
        }])
        reasonings, chunks = [], []
        with _patch_ctx(_stream_client(lines)):
            async for ev in call_api_provider_stream(self._CFG, agent, "t", []):
                if ev["type"] == "reasoning":
                    reasonings.append(ev["content"])
                elif ev["type"] == "chunk":
                    chunks.append(ev["content"])
        assert "缓冲思考" in "".join(reasonings)
        assert "正文X" in "".join(chunks)


class TestToolRoundMessageShape:
    """_handle_tool_calls_stream：工具循环各轮同样兼容 message 形态"""

    @pytest.mark.asyncio
    async def test_round_message_shape_content(self):
        agent = _agent()
        lines = _sse_lines([{
            "id": "s1", "object": "chat.completion.chunk", "created": 1,
            "model": "ling-3.0-flash-fin-free",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "round正文"},
                         "finish_reason": "stop"}],
        }])
        client = _stream_client(lines)
        chunks = []
        with patch("core.llm._execute_tools_with_progress") as fexp:
            fexp.return_value.__aiter__.return_value = iter([])
            async for ev in _handle_tool_calls_stream(
                [], {"role": "assistant", "content": ""}, [], {},
                {}, "http://x", client, agent,
            ):
                if ev["type"] == "chunk" and not ev["content"].startswith("["):
                    chunks.append(ev["content"])
        assert any("round正文" in c for c in chunks)

    @pytest.mark.asyncio
    async def test_round_nonstream_json_recovery(self):
        agent = _agent()
        blob = json.dumps({
            "id": "x", "object": "chat.completion", "created": 1,
            "model": "ling-3.0-flash-fin-free",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "兜底正文"},
                         "finish_reason": "stop"}],
        })
        client = _stream_client([blob.encode()])
        chunks = []
        with patch("core.llm._execute_tools_with_progress") as fexp:
            fexp.return_value.__aiter__.return_value = iter([])
            async for ev in _handle_tool_calls_stream(
                [], {"role": "assistant", "content": ""}, [], {},
                {}, "http://x", client, agent,
            ):
                if ev["type"] == "chunk" and "兜底正文" in ev["content"]:
                    chunks.append(ev["content"])
        assert chunks == ["兜底正文"]