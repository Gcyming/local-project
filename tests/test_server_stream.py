"""server 端点集成测试（A-011 最后缺口）：/chat/stream SSE 协议 / 认证 / /chat / /chat/analyze

用 fastapi TestClient 进程内直测端点（不用 with → 不触发 lifespan，无模型/MCP 副作用）。
decrypt 打桩为 {} → 走无 Provider 默认回复路径，零网络依赖、零外部写入
（history_append / _spawn_background / _post_process_chat 全部打桩，不污染 config/history.jsonl 与 Knowledge 目录）。

对齐 run_tests.py 约定：仅 Test* 类 / test_* 方法，不依赖 conftest。
"""

import json
from unittest.mock import patch


class TestChatStreamEndpoint:
    """SSE 协议 / 认证 / 端点回归（A-005 单 done 收尾、A-018 NameError 回归）"""

    def _env(self):
        import slime_server
        from core.agent import Agent
        from core.a2a import ServerA2ABus
        from fastapi.testclient import TestClient
        ServerA2ABus._instance = None  # 无 lifespan → 无总线（端点应安全跳过）
        agent = Agent(name="TestSlime", role="测试角色")
        slime_server.agents.append(agent)
        client = TestClient(slime_server.app)
        return slime_server, agent, client

    def _cleanup(self, slime_server, agent):
        slime_server.agents = [a for a in slime_server.agents if a.id != agent.id]

    def _auth(self, slime_server):
        return {"Authorization": "Bearer " + slime_server.AUTH_TOKEN}

    def _noop_patches(self, slime_server):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(slime_server, "decrypt", return_value={}))
        stack.enter_context(patch.object(slime_server, "history_append", return_value=None))
        stack.enter_context(patch.object(slime_server, "_spawn_background", side_effect=lambda coro: None))
        # _post_process_chat 是 async 函数：patch.object 默认会造 AsyncMock（调用产生
        # 无人 await 的协程泄漏）；用 new= 显式同步打桩，杜绝 RuntimeWarning
        stack.enter_context(patch.object(slime_server, "_post_process_chat",
                                         new=lambda *a, **k: None))
        return stack

    def test_stream_single_done_protocol(self):
        """chunk* → 单 done 收尾（A-005 协议），默认回复含身份"""
        slime_server, agent, client = self._env()
        try:
            with self._noop_patches(slime_server):
                r = client.post(
                    f"/agents/{agent.id}/chat/stream",
                    json={"message": "你好", "history": []},
                    headers=self._auth(slime_server),
                )
            assert r.status_code == 200
            assert "text/event-stream" in r.headers["content-type"]
            lines = [l for l in r.text.splitlines() if l.startswith("data:")]
            assert lines, "SSE 至少一个事件"
            events = [json.loads(l[5:].strip()) for l in lines]
            types = [e["type"] for e in events]
            assert types.count("done") == 1
            assert types[-1] == "done"  # done 必为收尾事件
            assert "TestSlime" in events[-1]["reply"]
        finally:
            self._cleanup(slime_server, agent)

    def test_stream_requires_auth(self):
        slime_server, agent, client = self._env()
        try:
            r = client.post(
                f"/agents/{agent.id}/chat/stream",
                json={"message": "hi", "history": []},
            )
            assert r.status_code == 401
        finally:
            self._cleanup(slime_server, agent)

    def test_stream_unknown_agent_404(self):
        slime_server, agent, client = self._env()
        try:
            r = client.post(
                "/agents/agent_nonexistent/chat/stream",
                json={"message": "hi", "history": []},
                headers=self._auth(slime_server),
            )
            assert r.status_code == 404
        finally:
            self._cleanup(slime_server, agent)

    def test_stream_delegation_emits_heartbeat(self):
        """A-045: 慢委托（生图类）期间 SSE 持续发心跳，防客户端读超时"""
        import asyncio
        import slime_server
        from core.agent import Agent
        slime_server, agent, client = self._env()
        child = Agent(name="Child", role="子")
        slime_server.agents.append(child)
        call_count = [0]

        async def fake_stream(a, msg, history=None, providers=None,
                              registry=None, system_prompt=None):
            call_count[0] += 1
            if call_count[0] == 1:
                yield {"type": "chunk", "content": '好的：<DELEGATE name="Child">执行任务</DELEGATE>'}
                yield {"type": "done", "reply": '好的：<DELEGATE name="Child">执行任务</DELEGATE>',
                       "model": "x", "prompt_tokens": 1, "completion_tokens": 1, "elapsed_ms": 1}
            else:
                yield {"type": "chunk", "content": "已整合子结果。"}
                yield {"type": "done", "reply": "已整合子结果。", "model": "x",
                       "prompt_tokens": 1, "completion_tokens": 1, "elapsed_ms": 1}

        async def slow_child(a, msg, history, providers, registry):
            await asyncio.sleep(0.3)  # 慢委托 → 静默期触发心跳
            return {"reply": "子 Agent 结果"}

        try:
            with self._noop_patches(slime_server), \
                 patch.object(slime_server, "call_llm_stream", new=fake_stream), \
                 patch.object(slime_server, "call_llm_with_meta", new=slow_child), \
                 patch.object(slime_server, "_HEARTBEAT_INTERVAL", 0.05):
                r = client.post(f"/agents/{agent.id}/chat/stream",
                                json={"message": "委托任务", "history": []},
                                headers=self._auth(slime_server))
            assert r.status_code == 200
            lines = [l for l in r.text.splitlines() if l.startswith("data:")]
            events = [json.loads(l[5:].strip()) for l in lines]
            types = [e["type"] for e in events]
            assert "heartbeat" in types   # 委托静默期有心跳
            assert "tool" in types        # 委托工具事件
            assert types.count("done") == 1
            assert types[-1] == "done"
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != child.id]
            self._cleanup(slime_server, agent)

    def test_chat_endpoint_no_name_error(self):
        """A-018 回归：/chat 曾因 ServerA2ABus 未导入而 NameError"""
        slime_server, agent, client = self._env()
        try:
            with self._noop_patches(slime_server):
                r = client.post(
                    f"/agents/{agent.id}/chat",
                    json={"message": "你好", "history": []},
                    headers=self._auth(slime_server),
                )
            assert r.status_code == 200
            body = r.json()
            assert "TestSlime" in body["reply"]
            assert body["model"] == "none"  # 无 provider 默认回复路径
            assert body["elapsed_ms"] >= 0
        finally:
            self._cleanup(slime_server, agent)

    def test_chat_requires_auth(self):
        slime_server, agent, client = self._env()
        try:
            r = client.post(
                f"/agents/{agent.id}/chat",
                json={"message": "hi", "history": []},
            )
            assert r.status_code == 401
        finally:
            self._cleanup(slime_server, agent)

    def test_chat_analyze_explicit_fallback(self):
        """A-015：默认回复非 JSON → parse_ok=False 显式降级（不再静默）"""
        slime_server, agent, client = self._env()
        try:
            with patch.object(slime_server, "decrypt", return_value={}):
                r = client.post(
                    f"/agents/{agent.id}/chat/analyze",
                    json={"message": "你好", "history": []},
                    headers=self._auth(slime_server),
                )
            assert r.status_code == 200
            body = r.json()
            assert body["action"] == "chat"
            assert body["parse_ok"] is False
            assert body["subtasks"] == []
        finally:
            self._cleanup(slime_server, agent)

    def test_chat_analyze_requires_auth(self):
        slime_server, agent, client = self._env()
        try:
            r = client.post(
                f"/agents/{agent.id}/chat/analyze",
                json={"message": "hi", "history": []},
            )
            assert r.status_code == 401
        finally:
            self._cleanup(slime_server, agent)


class TestForcedToolRound:
    """A-049: 编造检测 → 强制工具轮（生成类请求 + 零工具 + 完成态声称 → 自动追加强制调用）"""

    def _env(self):
        import slime_server
        from core.agent import Agent
        from core.a2a import ServerA2ABus
        from fastapi.testclient import TestClient
        ServerA2ABus._instance = None
        agent = Agent(name="TestSlime", role="测试角色")
        slime_server.agents.append(agent)
        client = TestClient(slime_server.app)
        return slime_server, agent, client

    def test_fabrication_triggered_forced_tool_round(self):
        """第一轮模型零工具+声称完成（表格形式）→ 强制轮真实调用工具 → SSE 出现工具事件"""
        import slime_server
        from contextlib import ExitStack
        from unittest.mock import patch
        slime_server, agent, client = self._env()
        stack = ExitStack()
        stack.enter_context(patch.object(slime_server, "decrypt", return_value={}))
        stack.enter_context(patch.object(slime_server, "history_append", return_value=None))
        stack.enter_context(patch.object(slime_server, "_spawn_background", side_effect=lambda coro: None))
        stack.enter_context(patch.object(slime_server, "_post_process_chat", new=lambda *a, **k: None))
        try:
            calls = {"n": 0}
            bs = chr(92)

            async def fake_stream(agent, user_message, history, providers, agents, **kw):
                calls["n"] += 1
                if calls["n"] == 1:
                    # 第一轮：编造完成（表格形式，无工具）
                    fake = f"D:{bs}x{bs}fake.mp4"
                    yield {"type": "chunk", "content": "视频已生成！"}
                    yield {"type": "chunk", "content": f"完整路径 `{fake}` 文件大小 1,034,594 字节"}
                    yield {"type": "done", "reply": f"视频已生成！完整路径 `{fake}` 文件大小 1,034,594 字节"}
                else:
                    # 强制轮：先报进度，再真实调用工具（A-050-R：进度事件必须透传）
                    yield {"type": "progress", "name": "视频生成", "progress": 30}
                    yield {"type": "progress", "name": "视频生成", "progress": 100}
                    yield {"type": "tool", "name": "agnes_generate_video", "args": "{}", "result": "本地文件: D:/real.mp4（100 字节）"}
                    yield {"type": "chunk", "content": "视频已真实生成：D:/real.mp4"}
                    yield {"type": "done", "reply": "视频已真实生成：D:/real.mp4（100 字节）"}

            with patch.object(slime_server, "call_llm_stream", new=fake_stream):
                r = client.post(
                    f"/agents/{agent.id}/chat/stream",
                    json={"message": "帮我生成一个视频", "history": []},
                    headers={"Authorization": "Bearer " + slime_server.AUTH_TOKEN},
                )
            assert r.status_code == 200
            events = [json.loads(l[5:].strip()) for l in r.text.splitlines() if l.startswith("data:")]
            types = [e["type"] for e in events]
            assert calls["n"] == 2, "应触发强制工具轮（第二轮）"
            assert types.count("tool") == 1, "强制轮工具事件应输出"
            assert types.count("progress") == 2, "A-050-R: 强制轮进度事件应透传"
            assert "真实生成" in events[-1]["reply"]
            assert types.count("done") == 1
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != agent.id]
            stack.close()

    def test_no_forced_round_when_tools_were_called(self):
        """正常路径：模型已调用工具（tool 事件）→ 不触发强制轮"""
        import slime_server
        from contextlib import ExitStack
        from unittest.mock import patch
        slime_server, agent, client = self._env()
        stack = ExitStack()
        stack.enter_context(patch.object(slime_server, "decrypt", return_value={}))
        stack.enter_context(patch.object(slime_server, "history_append", return_value=None))
        stack.enter_context(patch.object(slime_server, "_spawn_background", side_effect=lambda coro: None))
        stack.enter_context(patch.object(slime_server, "_post_process_chat", new=lambda *a, **k: None))
        try:
            calls = {"n": 0}

            async def fake_stream(agent, user_message, history, providers, agents, **kw):
                calls["n"] += 1
                if calls["n"] == 1:
                    yield {"type": "tool", "name": "web_search", "args": "{}", "result": "结果"}
                    yield {"type": "chunk", "content": "查到了"}
                    yield {"type": "done", "reply": "查到了"}
                else:
                    raise AssertionError("不应触发强制轮")

            with patch.object(slime_server, "call_llm_stream", new=fake_stream):
                r = client.post(
                    f"/agents/{agent.id}/chat/stream",
                    json={"message": "帮我生成一个视频", "history": []},
                    headers={"Authorization": "Bearer " + slime_server.AUTH_TOKEN},
                )
            assert r.status_code == 200
            events = [json.loads(l[5:].strip()) for l in r.text.splitlines() if l.startswith("data:")]
            types = [e["type"] for e in events]
            assert calls["n"] == 1, "有工具调用不应触发强制轮"
            assert types.count("tool") == 1
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != agent.id]
            stack.close()

    def test_non_generation_request_no_forced_round(self):
        """非生成类请求（闲聊）→ 不触发强制轮"""
        import slime_server
        from contextlib import ExitStack
        from unittest.mock import patch
        slime_server, agent, client = self._env()
        stack = ExitStack()
        stack.enter_context(patch.object(slime_server, "decrypt", return_value={}))
        stack.enter_context(patch.object(slime_server, "history_append", return_value=None))
        stack.enter_context(patch.object(slime_server, "_spawn_background", side_effect=lambda coro: None))
        stack.enter_context(patch.object(slime_server, "_post_process_chat", new=lambda *a, **k: None))
        try:
            calls = {"n": 0}

            async def fake_stream(agent, user_message, history, providers, agents, **kw):
                calls["n"] += 1
                if calls["n"] == 1:
                    yield {"type": "chunk", "content": "你好"}
                    yield {"type": "done", "reply": "你好"}
                else:
                    raise AssertionError("不应触发强制轮")

            with patch.object(slime_server, "call_llm_stream", new=fake_stream):
                r = client.post(
                    f"/agents/{agent.id}/chat/stream",
                    json={"message": "你好", "history": []},
                    headers={"Authorization": "Bearer " + slime_server.AUTH_TOKEN},
                )
            assert calls["n"] == 1
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != agent.id]
            stack.close()


class TestToolsOnlyFilter:
    """A-049: call_llm_stream tools_only 限制工具子集注入（纯函数测试）"""

    def test_filter_tools_schema_by_name(self):
        from core.llm import _filter_tools_schema
        schemas = [
            {"function": {"name": "agnes_generate_image", "description": "d"}},
            {"function": {"name": "agnes_generate_video", "description": "d"}},
            {"function": {"name": "file_write", "description": "d"}},
            {"function": {"name": "web_search", "description": "d"}},
        ]
        out = _filter_tools_schema(schemas, ["agnes_generate_image", "agnes_generate_video"])
        names = [t["function"]["name"] for t in out]
        assert names == ["agnes_generate_image", "agnes_generate_video"]
        # 其余工具被过滤
        assert "file_write" not in names and "web_search" not in names

    def test_filter_none_keeps_all(self):
        from core.llm import _filter_tools_schema
        schemas = [{"function": {"name": "a"}}, {"function": {"name": "b"}}]
        assert len(_filter_tools_schema(schemas, None)) == 2
        assert len(_filter_tools_schema(schemas, [])) == 2


class TestProviderValidation:
    """A-024: /providers 输入校验（key 字符集 / api_base 协议 / 数值钳制）"""

    def _client(self):
        import slime_server
        from fastapi.testclient import TestClient
        from core.a2a import ServerA2ABus
        ServerA2ABus._instance = None
        return slime_server, TestClient(slime_server.app)

    def _auth(self, slime_server):
        return {"Authorization": "Bearer " + slime_server.AUTH_TOKEN}

    def test_invalid_key_rejected(self):
        slime_server, client = self._client()
        with patch.object(slime_server, "decrypt", return_value={}), \
             patch.object(slime_server, "encrypt") as enc:
            r = client.post("/providers", headers=self._auth(slime_server), json={
                "key": "bad key!",
                "api_base": "https://api.example.com",
                "api_key": "k",
                "model": "m",
            })
            assert r.status_code == 400
            enc.assert_not_called()

    def test_empty_key_rejected(self):
        slime_server, client = self._client()
        with patch.object(slime_server, "decrypt", return_value={}), \
             patch.object(slime_server, "encrypt") as enc:
            r = client.post("/providers", headers=self._auth(slime_server), json={
                "key": "   ",
                "api_base": "https://api.example.com",
                "api_key": "k",
                "model": "m",
            })
            assert r.status_code == 400
            enc.assert_not_called()

    def test_non_http_api_base_rejected(self):
        slime_server, client = self._client()
        with patch.object(slime_server, "decrypt", return_value={}), \
             patch.object(slime_server, "encrypt") as enc:
            r = client.post("/providers", headers=self._auth(slime_server), json={
                "key": "ok-key",
                "api_base": "ftp://example.com",
                "api_key": "k",
                "model": "m",
            })
            assert r.status_code == 400
            enc.assert_not_called()

    def test_valid_provider_saved_normalized(self):
        slime_server, client = self._client()
        with patch.object(slime_server, "decrypt", return_value={}), \
             patch.object(slime_server, "encrypt") as enc:
            r = client.post("/providers", headers=self._auth(slime_server), json={
                "key": "my-provider",
                "api_base": "https://api.example.com/v1",
                "api_key": " sk-123 ",
                "model": "gpt-x",
                "max_context": -500,
                "max_output": 0,
            })
            assert r.status_code == 200
            saved = enc.call_args[0][0]
            cfg = saved["my-provider"]
            assert cfg["api_base"] == "https://api.example.com/v1"
            assert cfg["api_key"] == "sk-123"      # 空白剥离
            assert cfg["max_context"] == 0         # 负数钳制为 0
            assert cfg["max_output"] == 0


class TestSwarmReportEndpoint:
    """A-031: /agents/{id}/swarm/report —— Swarm 经验沉淀上报（校验 + 归一化）"""

    def _env(self):
        import slime_server
        from core.agent import Agent
        from core.a2a import ServerA2ABus
        from fastapi.testclient import TestClient
        ServerA2ABus._instance = None
        agent = Agent(name="TestSlime", role="测试角色")
        slime_server.agents.append(agent)
        return slime_server, agent, TestClient(slime_server.app)

    def _cleanup(self, slime_server, agent):
        slime_server.agents = [a for a in slime_server.agents if a.id != agent.id]

    def _auth(self, slime_server):
        return {"Authorization": "Bearer " + slime_server.AUTH_TOKEN}

    def test_validation_errors(self):
        slime_server, agent, client = self._env()
        try:
            with patch.object(slime_server, "decrypt", return_value={}):
                r = client.post(f"/agents/{agent.id}/swarm/report",
                                headers=self._auth(slime_server),
                                json={"task": "", "summary": "s"})
                assert r.status_code == 400
                r = client.post(f"/agents/{agent.id}/swarm/report",
                                headers=self._auth(slime_server),
                                json={"task": "t", "summary": "s", "results": "not-list"})
                assert r.status_code == 400
                r = client.post(f"/agents/{agent.id}/swarm/report",
                                headers=self._auth(slime_server),
                                json={"task": "t", "summary": "s", "results": [{}] * 17})
                assert r.status_code == 400
            r = client.post("/agents/agent_nonexistent/swarm/report",
                            headers=self._auth(slime_server),
                            json={"task": "t", "summary": "s"})
            assert r.status_code == 404
        finally:
            self._cleanup(slime_server, agent)

    def test_report_calls_post_process_with_normalized_results(self):
        slime_server, agent, client = self._env()
        try:
            calls = []

            async def fake_post(a, task, summary, results, providers):
                calls.append(results)
                return {"success": True, "lifecycle": "growth"}

            with patch.object(slime_server, "decrypt", return_value={}), \
                 patch.object(slime_server, "_post_process_swarm", new=fake_post):
                r = client.post(f"/agents/{agent.id}/swarm/report",
                                headers=self._auth(slime_server),
                                json={
                                    "task": "任务", "summary": "总结",
                                    "results": [
                                        {"name": "W1", "state": "done", "result": "r1"},
                                        {"name": "W2", "state": "hacked", "result": "r2"},
                                    ],
                                })
                assert r.status_code == 200
                body = r.json()
                assert body["ok"] is True
                assert body["lifecycle"] == "growth"
                assert len(calls) == 1
                called_results = calls[0]
                assert called_results[0]["state"] == "done"
                assert called_results[1]["state"] == "failed"  # 非法状态归一化
        finally:
            self._cleanup(slime_server, agent)


class TestDeleteAgentCleansParentChildren:
    """A-034: 删除子 Agent 后清理父 Agent 的悬空 children 引用"""

    def test_delete_child_removes_from_parent_children(self):
        import slime_server
        from core.agent import Agent
        from core.a2a import ServerA2ABus
        from fastapi.testclient import TestClient
        ServerA2ABus._instance = None
        parent = Agent(name="P", role="父")
        slime_server.agents.append(parent)
        auth = {"Authorization": "Bearer " + slime_server.AUTH_TOKEN}
        try:
            with patch.object(slime_server, "save_agents"), \
                 patch("core.history.remove_agent", return_value=0):
                client = TestClient(slime_server.app)
                r = client.post(f"/agents/{parent.id}/split",
                                headers=auth,
                                json={"name": "Child1", "role": "子",
                                      "model_choice": "inherit"})
                assert r.status_code == 200
                child_id = r.json()["id"]
                assert child_id in parent.children
                r2 = client.delete(f"/agents/{child_id}", headers=auth)
                assert r2.status_code == 200
                assert child_id not in parent.children  # A-034 悬空引用已清理
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != parent.id]


class TestSplitForkDepth:
    """P1-15: split API fork_depth 硬上限校验（CLI /auto 已有，API 直连此前可绕过）"""

    def test_split_beyond_max_depth_rejected(self):
        import slime_server
        from core.agent import Agent
        from core.a2a import ServerA2ABus
        from fastapi.testclient import TestClient
        ServerA2ABus._instance = None
        parent = Agent(name="Deep", role="r", fork_depth=Agent.MAX_FORK_DEPTH)
        slime_server.agents.append(parent)
        auth = {"Authorization": "Bearer " + slime_server.AUTH_TOKEN}
        try:
            with patch.object(slime_server, "save_agents"):
                client = TestClient(slime_server.app)
                r = client.post(f"/agents/{parent.id}/split",
                                headers=auth,
                                json={"name": "C", "role": "子", "model_choice": "inherit"})
                assert r.status_code == 400
                assert "MAX_FORK_DEPTH" in r.json()["detail"]
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != parent.id]

    def test_split_within_depth_allowed(self):
        import slime_server
        from core.agent import Agent
        from core.a2a import ServerA2ABus
        from fastapi.testclient import TestClient
        ServerA2ABus._instance = None
        parent = Agent(name="Shallow", role="r", fork_depth=1)
        slime_server.agents.append(parent)
        auth = {"Authorization": "Bearer " + slime_server.AUTH_TOKEN}
        try:
            with patch.object(slime_server, "save_agents"):
                client = TestClient(slime_server.app)
                r = client.post(f"/agents/{parent.id}/split",
                                headers=auth,
                                json={"name": "C", "role": "子", "model_choice": "inherit"})
                assert r.status_code == 200
                assert r.json()["fork_depth"] == 2
        finally:
            slime_server.agents = [a for a in slime_server.agents if a.id != parent.id]


class TestSkillEvidenceInjection:
    """A-098: 动态命令消息平台证据注入（结构性修复——模型无法忽略平台证据）"""

    def test_skill_hit(self):
        import slime_server as S
        r = S._inject_skill_evidence("使用技能 ponytail 处理：ultra")
        assert "[平台证据] 技能 ponytail 已确认存在" in r
        assert "skill_search 实时查询命中" in r

    def test_skill_miss(self):
        import slime_server as S
        r = S._inject_skill_evidence("使用技能 nonexist_xyz 处理：x")
        assert "不存在" in r and "不要编造" in r

    def test_mcp(self):
        import slime_server as S
        r = S._inject_skill_evidence("使用 MCP 服务器 browser 的工具处理：打开 example.com")
        assert "[平台证据] MCP 服务器 browser" in r
        assert "查询失败" not in r

    def test_normal_message_unchanged(self):
        import slime_server as S
        assert S._inject_skill_evidence("你好，帮我写个函数") == "你好，帮我写个函数"
