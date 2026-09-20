"""
tests/test_infer_server.py — sidecar 推理服务 + 四阶段检索 API 测试。

run_tests.py 兼容（仅用 setup_method / tmp_path；模型层全部替换为 fake）。
"""

import json
import sys
import time
from pathlib import Path

import httpx
import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from sidecar import infer_server
from sidecar import retrieve_api


class _FakeManager:
    """替换 ModelServerManager：ensure 恒成功，端口 9999。"""

    def __init__(self):
        self.touched = []

    async def startup(self):
        pass

    async def shutdown(self):
        pass

    async def ensure(self, role):
        return {"ok": True, "port": 9999, "state": "ready"}

    def release(self, role):
        return {"ok": True, "state": "idle"}

    def touch(self, role):
        self.touched.append(role)

    def status(self):
        return [{"role": "chat", "port": 9999, "state": "ready"}]


class _FakeManagerFail(_FakeManager):
    async def ensure(self, role):
        return {"ok": False, "error": "显存不足"}


async def _fake_chat_ok(port, payload):
    return httpx.Response(200, json={
        "id": "fake", "object": "chat.completion", "model": "qwen",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "我是测试"},
                     "finish_reason": "stop"}],
    })


async def _fake_embed_ok(port, payload):
    n = len(payload["input"])
    return httpx.Response(200, json={
        "object": "list", "model": "bge-m3",
        "data": [{"index": i, "embedding": [0.1] * 4} for i in range(n)],
    })


def _now(days_ago: float = 0) -> str:
    from datetime import datetime, timezone, timedelta
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _make_memory(memory_dir: Path, agent_id: str):
    """构造带链接/标签/重要度的 memory.json。"""
    f1 = {"id": "mem_a1", "content": "用户喜欢喝咖啡", "category": "preference",
          "tags": ["pref"], "importance": 7, "timestamp": _now(), "last_accessed": _now(),
          "links": ["mem_a2"], "backlinks": [], "repeated": 0}
    f2 = {"id": "mem_a2", "content": "咖啡店在楼下", "category": "fact",
          "tags": ["place"], "importance": 5, "timestamp": _now(), "last_accessed": _now(),
          "links": ["mem_a3"], "backlinks": ["mem_a1"], "repeated": 0}
    f3 = {"id": "mem_a3", "content": "咖啡店老板是老王", "category": "fact",
          "tags": ["place"], "importance": 4, "timestamp": _now(), "last_accessed": _now(),
          "links": [], "backlinks": ["mem_a2"], "repeated": 0}
    f4 = {"id": "mem_b1", "content": "BGE-M3 向量维度 1024", "category": "fact",
          "tags": ["tech"], "importance": 8, "timestamp": _now(), "last_accessed": _now(),
          "links": [], "backlinks": [], "repeated": 0}
    f5 = {"id": "mem_c1", "content": "三十天前的旧教训", "category": "lesson",
          "tags": [], "importance": 9, "timestamp": _now(30), "last_accessed": _now(30),
          "links": [], "backlinks": [], "repeated": 0, "success": False}
    agent_dir = memory_dir / agent_id
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "memory.json").write_text(json.dumps({
        "facts": [f1, f2, f3, f4, f5],
        "preferences": [], "skills_unlocked": [], "lessons": [],
        "created_at": _now(), "updated_at": _now(),
    }, ensure_ascii=False), encoding="utf-8")


class TestSidecarHealth:
    def setup_method(self):
        infer_server._manager = _FakeManager()

    def teardown_method(self):
        infer_server._manager = None
        infer_server._forward_chat = None
        infer_server._forward_embed = None

    @pytest.mark.asyncio
    async def test_health_ok(self, tmp_path):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.get("/health")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "ok"
            assert data["port"] == infer_server.INFER_PORT


class TestChatCompletions:
    def setup_method(self):
        infer_server._manager = _FakeManager()
        infer_server._forward_chat = _fake_chat_ok

    def teardown_method(self):
        infer_server._manager = None
        infer_server._forward_chat = None
        infer_server._forward_embed = None

    @pytest.mark.asyncio
    async def test_chat_non_stream(self, tmp_path):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/chat/completions", json={
                "model": "qwen", "messages": [{"role": "user", "content": "hi"}],
                "stream": False,
            })
            assert resp.status_code == 200
            data = resp.json()
            assert data["choices"][0]["message"]["content"] == "我是测试"

    @pytest.mark.asyncio
    async def test_chat_stream_transparent(self, tmp_path):
        fake_sse = b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata: [DONE]\n\n"
        async def _fake_stream(port, payload):
            return httpx.Response(200, content=fake_sse)
        infer_server._forward_chat = _fake_stream
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/chat/completions", json={
                "model": "qwen", "messages": [{"role": "user", "content": "hi"}],
                "stream": True,
            })
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            assert b"[DONE]" in resp.content
            assert "我是测试".encode("utf-8") not in resp.content  # 透传原始 SSE，不做二次包装

    @pytest.mark.asyncio
    async def test_chat_model_unavailable(self, tmp_path):
        infer_server._manager = _FakeManagerFail()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/chat/completions", json={
                "model": "qwen", "messages": [{"role": "user", "content": "hi"}],
            })
            assert resp.status_code == 503
            assert "显存不足" in resp.json()["error"]["message"]


class TestEmbeddings:
    def setup_method(self):
        infer_server._manager = _FakeManager()
        infer_server._forward_embed = _fake_embed_ok

    def teardown_method(self):
        infer_server._manager = None
        infer_server._forward_chat = None
        infer_server._forward_embed = None

    @pytest.mark.asyncio
    async def test_embeddings_single_and_batch(self, tmp_path):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/embeddings", json={"model": "bge-m3", "input": "hello"})
            assert resp.status_code == 200
            assert len(resp.json()["data"]) == 1
            resp2 = await client.post("/embeddings", json={"input": ["a", "b", "c"]})
            assert len(resp2.json()["data"]) == 3

    @pytest.mark.asyncio
    async def test_embeddings_missing_input(self, tmp_path):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/embeddings", json={})
            assert resp.status_code == 400


class TestRetrieve:
    @pytest.mark.asyncio
    async def test_retrieve_link_walk_and_rank(self, tmp_path):
        retrieve_api._MEMORY_CFG["dir"] = str(tmp_path)
        agent_id = "agent_test"
        _make_memory(tmp_path, agent_id)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/v1/retrieve", json={
                "agent_id": agent_id, "query": "咖啡", "top_k": 10, "max_hops": 2,
            })
            assert resp.status_code == 200
            data = resp.json()
            contents = {i["content"] for i in data["items"]}
            assert "用户喜欢喝咖啡" in contents
            assert "咖啡店在楼下" in contents
            assert "咖啡店老板是老王" in contents  # 2 跳链接遍历到达
            assert "三十天前的旧教训" not in contents  # 无关条目不召回
            assert data["stages"]["link_walked"] >= 3
            for item in data["items"]:
                assert "weight" in item
                assert "links" in item

    @pytest.mark.asyncio
    async def test_retrieve_tag_filter(self, tmp_path):
        retrieve_api._MEMORY_CFG["dir"] = str(tmp_path)
        agent_id = "agent_test"
        _make_memory(tmp_path, agent_id)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/v1/retrieve", json={
                "agent_id": agent_id, "query": "", "top_k": 10, "max_hops": 1,
                "tags": "tech",
            })
            assert resp.status_code == 200
            contents = [i["content"] for i in resp.json()["items"]]
            assert contents == ["BGE-M3 向量维度 1024"]

    @pytest.mark.asyncio
    async def test_retrieve_importance_rank_without_query(self, tmp_path):
        retrieve_api._MEMORY_CFG["dir"] = str(tmp_path)
        agent_id = "agent_test"
        _make_memory(tmp_path, agent_id)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/v1/retrieve", json={
                "agent_id": agent_id, "query": "", "top_k": 3, "max_hops": 1,
            })
            contents = [i["content"] for i in resp.json()["items"]]
            assert contents[0] == "BGE-M3 向量维度 1024"  # importance 8 无衰减

    @pytest.mark.asyncio
    async def test_retrieve_invalid_agent_id(self, tmp_path):
        retrieve_api._MEMORY_CFG["dir"] = str(tmp_path)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=infer_server.app), base_url="http://t"
        ) as client:
            resp = await client.post("/v1/retrieve", json={"agent_id": "../../etc"})
            assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_stage2_no_hop_when_max_hops_zero(self, tmp_path):
        from sidecar.retrieve_api import _stage2_link_walk
        retrieve_api._MEMORY_CFG["dir"] = str(tmp_path)
        agent_id = "agent_test"
        _make_memory(tmp_path, agent_id)
        store = retrieve_api._load_memory_store(agent_id)
        items = _stage2_link_walk(store, [{"id": "mem_a1"}], 0, 10)
        assert {i["id"] for i in items} == {"mem_a1"}