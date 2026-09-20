# -*- coding: utf-8 -*-
"""识图链路（images → OpenAI 兼容 content 数组）单测。

覆盖：_sanitize_image_data_url 过滤、_build_user_content 组装（无图=纯字符串、
有图=content-blocks 数组）、_content_to_text 对数组 content 的截断防御、
call_api_provider 实际请求 payload 含 image_url 块、ChatRequest.images 服务端校验。

对齐 run_tests.py 约定：仅 Test* 类 / test_* 方法，不依赖 conftest。
"""

import json
from contextlib import ExitStack
from unittest.mock import patch, MagicMock

import pytest

from core.agent import Agent
from core.llm import (
    _sanitize_image_data_url,
    _build_user_content,
    _content_to_text,
    call_api_provider,
)

VALID_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
DATA_PNG = f"data:image/png;base64,{VALID_B64}"


def _agent(**kw):
    base = dict(name="T", role="t", model_choice="api:x", max_context=4096)
    base.update(kw)
    return Agent(**base)


class _FakeResp:
    """模拟 _post_chat_with_retry 返回（非流式）"""

    def __init__(self, content="ok"):
        self._content = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


def _patch_ctx(payload_capture=None):
    """组合 patch：system prompt 固定、psyche 恒等、GET client → 捕获最终 payload。

    返回 (ExitStack, captured)。需要 with stack: 包裹调用。"""
    stack = ExitStack()
    stack.enter_context(patch("core.llm._compose_system_prompt", return_value="sys"))

    def _identity(agent_, msg, history, memory_agent_id=None):
        return msg

    stack.enter_context(patch("core.llm._inject_psyche", side_effect=_identity))
    stack.enter_context(patch("core.llm._filter_tools_schema", return_value=[]))

    captured = {"payload": None}

    async def _post(url, headers=None, json=None):
        captured["payload"] = json
        return _FakeResp()

    client = MagicMock()
    client.post = _post
    stack.enter_context(patch("core.llm._get_shared_client", return_value=client))
    return stack, captured


class TestSanitizeImageDataUrl:
    def test_reject_non_image_prefix(self):
        assert _sanitize_image_data_url(["https://a.com/b.png", "DATA:image/png;base64,x"]) == []
        assert _sanitize_image_data_url(["file:///tmp/a.png"]) == []

    def test_keep_data_url_with_payload(self):
        # 合法的 data:image/ 前缀 + 逗号分隔 + 非空数据 → 保留（宽容匹配，适配各类网关）
        assert _sanitize_image_data_url(["data:image/png;charset=utf-8,abc"]) == ["data:image/png;charset=utf-8,abc"]
        # 逗号后为空 → 非法
        assert _sanitize_image_data_url(["data:image/png;base64,"]) == []

    def test_keep_valid_and_limit_4(self):
        five = [DATA_PNG] * 5
        out = _sanitize_image_data_url(five)
        assert len(out) == 4
        assert all(x.startswith("data:image/") for x in out)

    def test_reject_oversize(self):
        # base64 长度 ≈ 11MB → 原始 ≈ 8.25MB（> 8MB 阈值被丢弃）
        big_b64 = "A" * (11 * 1024 * 1024)
        big = f"data:image/png;base64,{big_b64}"
        assert _sanitize_image_data_url([big]) == []

    def test_non_list_returns_empty(self):
        assert _sanitize_image_data_url(None) == []
        assert _sanitize_image_data_url("data:image/png;base64,x") == []


class TestBuildUserContent:
    # run_tests.py 不注入 pytest fixture（autouse fixture 失效）；用 xunit setup/teardown 保双跑器兼容
    def setup_method(self):
        from unittest.mock import patch as _p

        def _identity(agent_, msg, history, memory_agent_id=None):
            return msg

        self._psyche_patch = _p("core.llm._inject_psyche", side_effect=_identity)
        self._psyche_patch.start()

    def teardown_method(self):
        self._psyche_patch.stop()

    def test_no_images_returns_plain_str(self):
        content = _build_user_content(_agent(), "你好", None, [])
        assert isinstance(content, str)
        assert content == "你好"

    def test_with_images_returns_blocks_array(self):
        content = _build_user_content(_agent(), "这是什么？", [DATA_PNG], [])
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "这是什么？"}
        assert content[1] == {"type": "image_url", "image_url": {"url": DATA_PNG}}

    def test_invalid_images_dropped(self):
        # 非法项被过滤后退回纯字符串
        content = _build_user_content(_agent(), "看看", ["not-a-url", "data:image/jpeg;base64,AAAA"])
        assert isinstance(content, list)
        assert len(content) == 2  # text + 仅保留 jpeg
        assert content[1]["image_url"]["url"].startswith("data:image/jpeg")

    def test_psyche_injected_into_text_block(self):
        from unittest.mock import patch as _p

        def _fake_psyche(a, m, h, memory_agent_id=None):
            return f"[心性上下文]\n...\n\n{m}"

        with _p("core.llm._inject_psyche", side_effect=_fake_psyche):
            content = _build_user_content(_agent(), "看图", [DATA_PNG], [])
        assert content[0] == {"type": "text", "text": "[心性上下文]\n...\n\n看图"}


class TestContentToText:
    def test_str_passthrough(self):
        assert _content_to_text("abc") == "abc"

    def test_block_array_extracts_text(self):
        assert _content_to_text([
            {"type": "text", "text": "a"},
            {"type": "image_url", "image_url": {"url": DATA_PNG}},
        ]) == "a"

    def test_none_and_malformed(self):
        assert _content_to_text(None) == ""
        assert _content_to_text([{"type": "text"}]) == ""
        assert _content_to_text(123) == ""


class TestCallApiProviderPayload:
    def _run_call(self, **kw):
        import asyncio
        stack, captured = _patch_ctx()
        with stack:

            async def _inner():
                return await call_api_provider(
                    {"api_base": "https://mock.local/v1", "api_key": "k", "model": "m"},
                    _agent(), kw.get("message", "hi"), kw.get("history"), images=kw.get("images"),
                )
            reply = asyncio.run(_inner())
        return reply, captured

    def test_payload_contains_image_url_block(self):
        reply, captured = self._run_call(message="描述这张图", images=[DATA_PNG])
        assert reply == "ok"
        payload = captured["payload"]
        assert payload["model"] == "m"
        last = payload["messages"][-1]
        assert last["role"] == "user"
        assert isinstance(last["content"], list)
        assert last["content"][-1] == {"type": "image_url", "image_url": {"url": DATA_PNG}}

    def test_no_images_keeps_string_payload(self):
        reply, captured = self._run_call(message="你好", images=None)
        assert reply == "ok"
        last = captured["payload"]["messages"][-1]
        assert isinstance(last["content"], str)

    def test_history_with_block_content_does_not_crash(self):
        # 历史中出现 content 数组（防御场景）不应在截断计数处崩溃
        history = [
            {"role": "user", "content": [{"type": "text", "text": "旧图提问"}]},
            {"role": "assistant", "content": "回答"},
        ]
        reply, captured = self._run_call(message="再看这张", history=history, images=[DATA_PNG])
        assert reply == "ok"
        msgs = captured["payload"]["messages"]
        # 防御生效：历史保留 + 最新 user 为 blocks 数组
        assert msgs[-1]["role"] == "user"
        assert isinstance(msgs[-1]["content"], list)


class TestChatRequestImagesValidation:
    """服务端 ChatRequest.images 形态校验（pydantic field_validator）"""

    def _make(self):
        import slime_server
        slime_server.AUTH_TOKEN = "t"  # 防认证中间件对未初始化 token 报错
        return slime_server.ChatRequest

    def test_valid_images_kept(self):
        ChatRequest = self._make()
        req = ChatRequest(message="看图", images=[DATA_PNG, "data:image/jpeg;base64,AAAA"])
        assert len(req.images) == 2

    def test_invalid_prefix_filtered(self):
        ChatRequest = self._make()
        req = ChatRequest(message="看图", images=["http://a/b.png", "data:image/png;base64,AAAA"])
        assert "http://a/b.png" not in req.images
        assert len(req.images) == 1

    def test_over_8_capped(self):
        ChatRequest = self._make()
        req = ChatRequest(message="看图", images=[DATA_PNG] * 12)
        assert len(req.images) == 8