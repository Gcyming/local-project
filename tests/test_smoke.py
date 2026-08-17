"""
slime 冒烟测试
覆盖核心模块的关键路径：Agent、A2A、Swarm 状态机、Merger、LLM 常量、加密
"""

import pytest

# ── Agent 测试 ──────────────────────────────────────────────


class TestAgent:
    """Agent 核心类测试"""

    def test_create_agent(self):
        from core.agent import Agent
        a = Agent(name="Slime", role="测试助手")
        assert a.name == "Slime"
        assert a.role == "测试助手"
        assert a.id.startswith("agent_")
        assert a.children == []
        assert a.parent_id is None
        assert a.model_choice == "inherit"

    def test_agent_serialization_roundtrip(self):
        from core.agent import Agent
        a = Agent(name="Slime", role="CEO", max_context=65536, max_output=4096)
        a.children = ["agent_001", "agent_002"]
        d = a.to_dict()
        b = Agent.from_dict(d)
        assert b.name == a.name
        assert b.role == a.role
        assert b.children == a.children
        assert b.max_context == a.max_context
        assert b.max_output == a.max_output

    def test_agent_tree(self):
        from core.agent import Agent, agent_tree
        a = Agent(name="Slime", role="CEO")
        b = Agent(name="Worker1", role="Worker", parent_id=a.id)
        a.children.append(b.id)
        tree = agent_tree([a, b])
        assert "roots" in tree
        assert len(tree["roots"]) == 1
        root = tree["roots"][0]
        assert root["name"] == "Slime"
        assert len(root["children"]) == 1
        assert root["children"][0]["name"] == "Worker1"

    def test_find_agent(self):
        from core.agent import Agent, find_agent
        a = Agent(name="Slime", role="CEO")
        b = Agent(name="Worker", role="Worker")
        found = find_agent([a, b], a.id)
        assert found is not None
        assert found.name == "Slime"
        not_found = find_agent([a, b], "nonexistent")
        assert not_found is None

    def test_identity_constraint_includes_name(self):
        from core.agent import IDENTITY_CONSTRAINT
        assert "{name}" in IDENTITY_CONSTRAINT
        assert "{role}" in IDENTITY_CONSTRAINT


# ── A2A 通信测试 ───────────────────────────────────────────


class TestA2A:
    """A2A 通信总线测试"""

    @pytest.mark.asyncio
    async def test_register_and_send(self):
        from core.a2a import A2ABus
        bus = A2ABus()
        bus.register("AgentA")
        bus.register("AgentB")
        result = await bus.send("AgentA", "AgentB", "Hello", msg_type="info")
        assert result["delivered"] is True

    @pytest.mark.asyncio
    async def test_send_to_nonexistent(self):
        from core.a2a import A2ABus
        bus = A2ABus()
        bus.register("AgentA")
        result = await bus.send("AgentA", "Ghost", "Hello")
        assert result["delivered"] is False

    @pytest.mark.asyncio
    async def test_broadcast(self):
        from core.a2a import A2ABus
        bus = A2ABus()
        bus.register("AgentA")
        bus.register("AgentB")
        bus.register("AgentC")
        result = await bus.send("AgentA", "broadcast", "Hi all", msg_type="info")
        # 广播给所有其他 Agent（不包括自己）
        assert result["delivered"] is True

    @pytest.mark.asyncio
    async def test_receive_message(self):
        from core.a2a import A2ABus
        bus = A2ABus()
        bus.register("AgentA")
        bus.register("AgentB")
        await bus.send("AgentA", "AgentB", "Hello")
        msg = await bus.receive("AgentB", timeout=1.0)
        assert msg is not None
        assert msg.from_agent == "AgentA"
        assert msg.content == "Hello"

    @pytest.mark.asyncio
    async def test_message_history(self):
        from core.a2a import A2ABus
        bus = A2ABus()
        bus.register("AgentA")
        bus.register("AgentB")
        await bus.send("AgentA", "AgentB", "msg1")
        await bus.send("AgentB", "AgentA", "msg2")
        assert len(bus._history) == 2

    @pytest.mark.asyncio
    async def test_msg_fields(self):
        from core.a2a import A2AMessage
        msg = A2AMessage(
            id="test_id",
            from_agent="A",
            to_agent="B",
            content="test",
            msg_type="request",
            request_id="req_001",
            in_reply_to="msg_001",
        )
        assert msg.msg_type == "request"
        assert msg.request_id == "req_001"
        assert msg.in_reply_to == "msg_001"


# ── Swarm 状态机测试 ───────────────────────────────────────


class TestSwarm:
    """Swarm 编排器状态机测试"""

    def test_task_state_enum(self):
        from core.swarm import TaskState
        states = {s.value for s in TaskState}
        assert "pending" in states
        assert "queued" in states
        assert "running" in states
        assert "done" in states
        assert "failed" in states

    def test_subtask_lifecycle(self):
        from core.swarm import SubTask, TaskState
        t = SubTask(id="t1", name="Worker", description="test task")
        assert t.state == TaskState.PENDING
        t.state = TaskState.QUEUED
        assert t.state == TaskState.QUEUED
        t.state = TaskState.RUNNING
        assert t.state == TaskState.RUNNING
        t.state = TaskState.DONE
        t.result = "done"
        assert t.state == TaskState.DONE
        assert t.result == "done"

    def test_subtask_failed(self):
        from core.swarm import SubTask, TaskState
        t = SubTask(id="t1", name="Worker", description="test")
        t.state = TaskState.FAILED
        t.error = "something went wrong"
        assert t.state == TaskState.FAILED
        assert t.error == "something went wrong"

    def test_swarm_plan_creation(self):
        from core.swarm import SwarmPlan, SubTask
        plan = SwarmPlan(
            task_id="plan_001",
            original_task="测试任务",
            max_splits=4,
            max_workers=2,
        )
        plan.subtasks.append(SubTask(id="t1", name="W1", description="子任务1"))
        plan.subtasks.append(SubTask(id="t2", name="W2", description="子任务2"))
        assert len(plan.subtasks) == 2
        assert plan.max_splits == 4
        assert plan.max_workers == 2

    def test_orchestrator_round_robin(self):
        from core.swarm import SwarmOrchestrator
        providers = {"p1": {}, "p2": {}, "p3": {}}
        orch = SwarmOrchestrator(providers)
        keys = orch.get_provider_keys()
        assert len(keys) == 3
        assert set(keys) == {"p1", "p2", "p3"}


# ── Merger 测试 ────────────────────────────────────────────


class TestMerger:
    """Merger 合并器测试"""

    def test_merge_result_defaults(self):
        from core.merger import MergeResult
        mr = MergeResult(task_id="t1", original_task="test")
        assert mr.summary == ""
        assert mr.subtask_results == []
        assert mr.errors == []
        assert mr.trial_passed is False

    def test_risk_levels(self):
        from core.merger import RiskLevel
        levels = {r.value for r in RiskLevel}
        assert "low" in levels
        assert "medium" in levels
        assert "high" in levels
        assert "critical" in levels

    def test_merge_result_with_errors(self):
        from core.merger import MergeResult
        mr = MergeResult(
            task_id="t1",
            original_task="test",
            summary="部分完成",
            errors=["子任务2超时"],
            risks=[{"level": "medium", "description": "网络延迟"}],
        )
        assert len(mr.errors) == 1
        assert len(mr.risks) == 1
        assert mr.risks[0]["level"] == "medium"


# ── LLM 常量测试 ───────────────────────────────────────────


class TestLLMConstants:
    """LLM 常量上限测试"""

    def test_max_output_limit(self):
        from core.llm import MAX_OUTPUT_LIMIT
        assert MAX_OUTPUT_LIMIT == 65536

    def test_max_context_limit(self):
        from core.llm import MAX_CONTEXT_LIMIT
        assert MAX_CONTEXT_LIMIT == 524288

    def test_cli_imports_from_llm(self):
        """验证 CLI 的常量来自 core.llm 而非重复定义"""
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parents[1]))
        # 通过检查 slime_cli 模块的 MAX_OUTPUT_LIMIT 是否与 core.llm 相同
        from core.llm import MAX_OUTPUT_LIMIT as llm_max_output
        from core.llm import MAX_CONTEXT_LIMIT as llm_max_context
        from slime_cli import MAX_OUTPUT_LIMIT, MAX_CONTEXT_LIMIT
        assert MAX_OUTPUT_LIMIT is llm_max_output
        assert MAX_CONTEXT_LIMIT is llm_max_context


class TestStreamToolCalls:
    """BUG-031: 流式 tool_calls 片段累积"""

    def test_accumulate_fragmented(self):
        from core.llm import _accumulate_tool_calls
        tcs = []
        # 第 1 块：index 0 的 id + name
        _accumulate_tool_calls(tcs, {"tool_calls": [
            {"index": 0, "id": "call_1", "function": {"name": "file_read", "arguments": ""}},
        ]})
        # 第 2/3 块：arguments 分片
        _accumulate_tool_calls(tcs, {"tool_calls": [
            {"index": 0, "function": {"arguments": '{"path": "a'}},
        ]})
        _accumulate_tool_calls(tcs, {"tool_calls": [
            {"index": 0, "function": {"arguments": '.txt"}'}},
        ]})
        assert len(tcs) == 1
        assert tcs[0]["id"] == "call_1"
        assert tcs[0]["function"]["name"] == "file_read"
        assert tcs[0]["function"]["arguments"] == '{"path": "a.txt"}'

    def test_accumulate_multi_index(self):
        from core.llm import _accumulate_tool_calls
        tcs = []
        # index 1 先到（乱序），index 0 后到
        _accumulate_tool_calls(tcs, {"tool_calls": [
            {"index": 1, "id": "call_2", "function": {"name": "file_list", "arguments": "{}"}},
        ]})
        _accumulate_tool_calls(tcs, {"tool_calls": [
            {"index": 0, "id": "call_1", "function": {"name": "file_read", "arguments": '{"path": "x"}'}},
        ]})
        assert len(tcs) == 2
        assert tcs[0]["function"]["name"] == "file_read"
        assert tcs[1]["function"]["name"] == "file_list"

    def test_accumulate_no_tool_calls(self):
        from core.llm import _accumulate_tool_calls
        tcs = []
        _accumulate_tool_calls(tcs, {"content": "普通文本块"})
        assert tcs == []


class TestToolLoop:
    """BUG-032: 多轮工具循环（依赖链）"""

    def _fake_registry(self):
        from tools.registry import Tool, get_registry

        async def _echo(args):
            return f"echo:{args.get('text', '')}"

        reg = get_registry()
        reg.register(Tool("fake_echo", "测试", {"type": "object", "properties": {}},
                          execute_fn=_echo, permissions=[]), force=True)
        return reg

    @staticmethod
    def _fake_client(responses):
        """post 依次返回 responses 列表中的 dict。"""
        class FakeResp:
            def __init__(self, data):
                self._data = data
            def raise_for_status(self):
                pass
            def json(self):
                return self._data

        calls = {"n": 0}

        class FakeClient:
            async def post(self, url, headers=None, json=None, **kw):
                idx = min(calls["n"], len(responses) - 1)
                calls["n"] += 1
                return FakeResp(responses[idx])

        return FakeClient(), calls

    def _tc(self, call_id, text):
        return {"id": call_id, "type": "function",
                "function": {"name": "fake_echo", "arguments": f'{{"text": "{text}"}}'}}

    def test_chain_two_rounds(self):
        import asyncio
        from core.llm import _handle_tool_calls
        from core.agent import Agent

        reg = self._fake_registry()
        try:
            client, calls = self._fake_client([
                # 第 1 轮：模型继续要工具（依赖链 web_search → web_fetch 形态）
                {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [self._tc("call_2", "chain")]}}]},
                # 第 2 轮：最终文本
                {"choices": [{"message": {"content": "完成"}}]},
            ])
            agent = Agent(name="t", role="测试")
            messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
            reply = asyncio.run(_handle_tool_calls(
                [self._tc("call_1", "first")],
                {"role": "assistant", "content": None, "tool_calls": [self._tc("call_1", "first")]},
                messages, {"messages": messages}, {}, "http://test", client, agent))
            assert calls["n"] == 2
            assert reply == "完成"
            # 历史链：assistant(tool)→tool→assistant(tool)→tool；最终回复不入历史
            assert [m["role"] for m in messages] == \
                ["system", "user", "assistant", "tool", "assistant", "tool"]
        finally:
            reg.unregister("fake_echo")

    def test_round_cap(self):
        import asyncio
        from core.llm import _handle_tool_calls, _TOOL_MAX_ROUNDS
        from core.agent import Agent

        reg = self._fake_registry()
        try:
            # 模型永远要工具 → 循环到上限
            always_tool = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [self._tc("call_x", "again")]}}]}
            client, calls = self._fake_client([always_tool] * 10)
            agent = Agent(name="t", role="测试")
            messages = [{"role": "user", "content": "u"}]
            reply = asyncio.run(_handle_tool_calls(
                [self._tc("call_0", "start")],
                {"role": "assistant", "content": None, "tool_calls": [self._tc("call_0", "start")]},
                messages, {"messages": messages}, {}, "http://test", client, agent))
            assert calls["n"] == _TOOL_MAX_ROUNDS
            assert reply.startswith("[工具调用轮次已达上限（3 轮）]")
            assert "第1轮: fake_echo" in reply  # A4: 附工具链摘要
        finally:
            reg.unregister("fake_echo")

    def test_empty_content_fallback(self):
        import asyncio
        from core.llm import _handle_tool_calls
        from core.agent import Agent

        reg = self._fake_registry()
        try:
            # 第 2 轮 content=None 且无 tool_calls → 不再产出空回复
            client, _ = self._fake_client([
                {"choices": [{"message": {"role": "assistant", "content": None}}]},
            ])
            agent = Agent(name="t", role="测试")
            messages = [{"role": "user", "content": "u"}]
            reply = asyncio.run(_handle_tool_calls(
                [self._tc("call_0", "x")],
                {"role": "assistant", "content": None, "tool_calls": [self._tc("call_0", "x")]},
                messages, {"messages": messages}, {}, "http://test", client, agent))
            assert reply == "[工具调用后无文本回复]"
        finally:
            reg.unregister("fake_echo")


# ── 加密模块测试 ───────────────────────────────────────────


class TestEncryption:
    """加密配置模块测试"""

    def test_encrypt_decrypt_roundtrip(self):
        from core.encryption import encrypt, decrypt, _resolve_config_path
        original = {"api_key": "sk-test-12345", "model": "gpt-4"}
        test_path = _resolve_config_path("config/test_roundtrip.enc.json")
        encrypted = encrypt(original, config_path=str(test_path))
        assert isinstance(encrypted, str)
        decrypted = decrypt(config_path=str(test_path))
        assert decrypted is not None
        assert decrypted["api_key"] == original["api_key"]
        assert decrypted["model"] == original["model"]
        # 清理
        test_path.unlink(missing_ok=True)

    def test_encrypt_empty_dict(self):
        from core.encryption import encrypt, decrypt, _resolve_config_path
        test_path = _resolve_config_path("config/test_empty.enc.json")
        encrypted = encrypt({}, config_path=str(test_path))
        decrypted = decrypt(config_path=str(test_path))
        assert decrypted == {}
        # 清理
        test_path.unlink(missing_ok=True)


# ── Persona 测试 ───────────────────────────────────────────


class TestPersona:
    """Persona 人格模块测试"""

    def test_persona_defaults(self):
        from core.persona import Persona
        p = Persona()
        assert p.traits == []
        assert p.preferences == []
        assert p.skill_ownership == []
        assert p.interactions == []

    def test_persona_add_interaction(self):
        from core.persona import Persona
        p = Persona()
        p.add_interaction("你好", "你好！我是 Slime。", True)
        assert len(p.interactions) == 1
        assert p.interactions[0]["user"] == "你好"
        assert p.interactions[0]["success"] is True

    def test_persona_serialization(self):
        from core.persona import Persona
        p = Persona()
        p.traits = ["helpful", "precise"]
        p.add_interaction("test", "ok", True)
        d = p.to_dict()
        p2 = Persona.from_dict(d)
        assert p2.traits == p.traits
        assert len(p2.interactions) == 1


# ── Phase 2 测试 ────────────────────────────────────────────


class TestMemory:
    """记忆系统测试"""

    def test_memory_store_crud(self, tmp_path):
        from core.memory import MemoryStore
        import core.memory as mem_mod
        # 临时替换数据目录
        original_data_dir = mem_mod._DATA_DIR
        original_knowledge_dir = mem_mod._KNOWLEDGE_MEMORY_DIR
        mem_mod._DATA_DIR = tmp_path
        mem_mod._KNOWLEDGE_MEMORY_DIR = tmp_path
        try:
            m = MemoryStore("test_mem_agent")
            m.add_fact("用户喜欢 Python")
            m.add_preference("theme", "dark")
            m.add_skill("code_review")
            m.add_lesson("要使用 async", True)

            assert len(m.get_facts()) == 3  # fact + preference + lesson → 统一 facts 列表
            assert m.get_preferences()["theme"] == "dark"
            assert "code_review" in m.get_skills()
            assert len(m.get_lessons()) == 1

            summary = m.summary()
            assert "Python" in summary
            assert "dark" in summary
        finally:
            mem_mod._DATA_DIR = original_data_dir
            mem_mod._KNOWLEDGE_MEMORY_DIR = original_knowledge_dir

    def test_memory_preference_update(self, tmp_path):
        from core.memory import MemoryStore
        import core.memory as mem_mod
        original_data_dir = mem_mod._DATA_DIR
        original_knowledge_dir = mem_mod._KNOWLEDGE_MEMORY_DIR
        mem_mod._DATA_DIR = tmp_path
        mem_mod._KNOWLEDGE_MEMORY_DIR = tmp_path
        try:
            m = MemoryStore("test_pref_agent")
            m.add_preference("lang", "Python")
            m.add_preference("lang", "Rust")  # 更新已有
            assert m.get_preferences()["lang"] == "Rust"
        finally:
            mem_mod._DATA_DIR = original_data_dir
            mem_mod._KNOWLEDGE_MEMORY_DIR = original_knowledge_dir


class TestEvolve:
    """演化引擎测试"""

    def test_lifecycle_transitions(self):
        from core.evolve import EvolutionEngine, AgentLifecycle
        e = EvolutionEngine("test_evolve")
        assert e.lifecycle == AgentLifecycle.BIRTH
        e.record_interaction(True)
        assert e.lifecycle == AgentLifecycle.GROWTH

    def test_evolution_persistence(self):
        from core.evolve import EvolutionEngine, AgentLifecycle
        e = EvolutionEngine("test_persist")
        e.lifecycle = AgentLifecycle.GROWTH
        for _ in range(20):
            e.record_interaction(True)
        d = e.to_dict()
        e2 = EvolutionEngine.from_dict(d)
        assert e2.lifecycle == e.lifecycle
        assert e2.stats["total_interactions"] == 20

    def test_trait_strength_weaken(self):
        from core.persona import Persona
        from core.evolve import EvolutionEngine
        p = Persona()
        p.traits = ["helpful", "precise"]
        e = EvolutionEngine("test_traits")
        e.strength_trait(p, 0, 0.3)
        assert p.traits[0]["weight"] == pytest.approx(0.8)
        e.weaken_trait(p, 1, 0.4)
        assert p.traits[1]["weight"] == pytest.approx(0.1)

    def test_trait_forget_stale(self):
        from core.persona import Persona
        from core.evolve import EvolutionEngine
        p = Persona()
        p.traits = ["helpful", "precise"]
        e = EvolutionEngine("test_forget")
        e.weaken_trait(p, 0, 0.5)  # weight → 0.0
        removed = e.forget_stale(p)
        assert removed == 1
        assert len(p.traits) == 1

    def test_traits_dict_format_migration(self):
        from core.persona import Persona
        p = Persona({"traits": ["old_string_trait"]})
        assert isinstance(p.traits[0], dict)
        assert p.traits[0]["name"] == "old_string_trait"
        assert "last_used" in p.traits[0]


class TestContext:
    """上下文压缩测试"""

    def test_no_compression_under_window(self):
        from core.context import ContextCompressor
        c = ContextCompressor({"head": 2, "tail": 2, "window": 10})
        history = [{"role": "user", "content": f"msg{i}"} for i in range(5)]
        result = c.compress(history)
        assert len(result) == 5

    def test_compression_over_window(self):
        from core.context import ContextCompressor
        c = ContextCompressor({"head": 2, "tail": 2, "window": 5})
        history = [{"role": "user", "content": f"msg{i}"} for i in range(10)]
        result = c.compress(history)
        assert len(result) <= 5  # head + 1 summary + tail

    def test_head_tail_validation(self):
        from core.context import ContextCompressor
        c = ContextCompressor({"head": 3, "tail": 10, "window": 30})
        assert c.config["head"] + c.config["tail"] <= c.config["window"]


class TestRegistry:
    """工具注册表测试"""

    def test_register_and_call(self):
        import asyncio
        from tools.registry import Tool, ToolRegistry

        async def echo(args):
            return f"echo: {args.get('text', '')}"

        registry = ToolRegistry()
        registry.register(Tool(
            name="echo",
            description="回显工具",
            parameters={"type": "object", "properties": {"text": {"type": "string"}}},
            execute_fn=echo,
        ))
        assert "echo" in registry.list_tool_names()
        result = asyncio.run(registry.call_tool("echo", {"text": "hello"}))
        assert "hello" in result

    def test_call_nonexistent(self):
        import asyncio
        from tools.registry import ToolRegistry
        registry = ToolRegistry()
        result = asyncio.run(registry.call_tool("nonexistent", {}))
        assert "未注册" in result

    def test_llm_schema_format(self):
        from tools.registry import Tool, ToolRegistry
        async def fn(args): return ""
        registry = ToolRegistry()
        registry.register(Tool(
            name="test",
            description="测试",
            parameters={"type": "object"},
            execute_fn=fn,
        ))
        schema = registry.list_tools()[0]
        assert schema["type"] == "function"
        assert schema["function"]["name"] == "test"


class TestSandbox:
    """沙箱权限测试（向后兼容层）"""

    def test_default_readonly(self):
        from core.sandbox import create_default_sandbox
        s = create_default_sandbox()
        assert not s.allows_write
        assert not s.allows_terminal
        assert not s.allows_network

    def test_denied_summary(self):
        from core.sandbox import create_default_sandbox
        s = create_default_sandbox()
        s.require_write("test_tool")
        s.require_terminal("test_tool")
        denied = s.get_denied_summary()
        assert len(denied) == 2
        assert "write" in denied[0]
        assert "terminal" in denied[1]

    def test_clear_denied(self):
        from core.sandbox import create_default_sandbox
        s = create_default_sandbox()
        s.require_write("test")
        assert len(s.get_denied_summary()) == 1
        s.clear_denied()
        assert len(s.get_denied_summary()) == 0


class TestSandboxPermissionLevel:
    """权限分级模型测试"""

    def test_level_values(self):
        from core.sandbox import PermissionLevel
        assert PermissionLevel.L0 == 0
        assert PermissionLevel.L1 == 1
        assert PermissionLevel.L2 == 2
        assert PermissionLevel.L3 == 3
        assert PermissionLevel.L4 == 4
        assert PermissionLevel.L5 == 5

    def test_from_string(self):
        from core.sandbox import PermissionLevel
        assert PermissionLevel.from_string("L0") == PermissionLevel.L0
        assert PermissionLevel.from_string("0") == PermissionLevel.L0
        assert PermissionLevel.from_string("L5") == PermissionLevel.L5
        assert PermissionLevel.from_string("5") == PermissionLevel.L5

    def test_display_name(self):
        from core.sandbox import PermissionLevel
        assert "纯读取" in PermissionLevel.L0.display_name()
        assert "系统操作" in PermissionLevel.L5.display_name()


class TestSandboxConfig:
    """沙箱配置测试"""

    def test_default_config(self):
        from core.sandbox import SandboxConfig
        cfg = SandboxConfig()
        assert cfg.default_level == "strict"
        assert cfg.auto_approve_levels == [0, 1]
        assert cfg.deny_levels == [5]
        assert cfg.anomaly_detection_enabled is True
        assert cfg.audit_enabled is True

    def test_config_roundtrip(self):
        from core.sandbox import SandboxConfig
        cfg = SandboxConfig(
            default_level="moderated",
            auto_approve_tools=["file_read", "git_status"],
            deny_tools=["sudo", "rm"],
        )
        d = cfg.to_dict()
        cfg2 = SandboxConfig.from_dict(d)
        assert cfg2.default_level == "moderated"
        assert "file_read" in cfg2.auto_approve_tools
        assert "sudo" in cfg2.deny_tools


class TestSandboxManager:
    """SandboxManager 测试"""

    def test_auto_approve_l0(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        allowed, reason = mgr.grant_permission("agent_test", "file_read", "/tmp/test.txt", level=0)
        assert allowed
        assert "自动批准" in reason or "默认允许" in reason

    def test_deny_l5(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        allowed, reason = mgr.grant_permission("agent_test", "sudo", "rm -rf /", level=5)
        assert not allowed
        assert "禁止" in reason

    def test_check_permission_l0(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        result = mgr.check_permission("agent_test", "file_read", "/tmp/test.txt", level=0)
        assert result.allowed

    def test_check_permission_l5(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        result = mgr.check_permission("agent_test", "sudo", "rm -rf /", level=5)
        assert not result.allowed

    def test_agent_config_override(self):
        from core.sandbox import SandboxManager, SandboxConfig, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        # 设置 Agent 级配置：允许 L2 自动通过
        agent_cfg = SandboxConfig(auto_approve_levels=[0, 1, 2])
        mgr.set_agent_config("agent_special", agent_cfg)
        result = mgr.check_permission("agent_special", "file_write", "/tmp/test.txt", level=2)
        assert result.allowed

    def test_revoke_all(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_test", "file_write", "/tmp/b.txt", level=2)
        mgr.revoke_all("agent_test", reason="测试回收")
        status = mgr.get_permission_status("agent_test")
        assert status["active_grants"] == 0

    def test_audit_logging(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        # L0 自动批准，L1 也自动批准，都会记录审计
        mgr.grant_permission("agent_test", "file_read", "/tmp/test.txt", level=0)
        mgr.grant_permission("agent_test", "git_status", "/tmp/repo", level=1)
        summary = mgr.get_audit_summary()
        assert summary["total_operations"] >= 2

    def test_audit_query_by_agent(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        mgr.grant_permission("agent_a", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_b", "file_read", "/tmp/b.txt", level=0)
        entries = mgr.query_audit(agent_id="agent_a")
        assert len(entries) >= 1
        assert all(e["agent_id"] == "agent_a" for e in entries)

    def test_risk_score(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        score = mgr.calculate_risk_score("file_read")
        # file_read 基础分 0.0，非工作时间 +0.2
        assert 0.0 <= score <= 0.3
        score = mgr.calculate_risk_score("sudo")
        assert score >= 0.9

    def test_sandbox_global_singleton(self):
        from core.sandbox import get_sandbox_manager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr1 = get_sandbox_manager()
        mgr2 = get_sandbox_manager()
        assert mgr1 is mgr2


class TestAnomalyDetector:
    """异常检测器测试"""

    def test_suspicious_pattern(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, alerts = detector.check("agent_test", "terminal", "rm -rf /")
        assert detected
        assert any("危险操作" in a for a in alerts)

    def test_safe_operation(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, alerts = detector.check("agent_test", "file_read", "/tmp/test.txt")
        assert not detected

    def test_sudo_detected(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, alerts = detector.check("agent_test", "terminal", "sudo rm file.txt")
        assert detected

    def test_loop_detection(self):
        from core.sandbox import AnomalyDetector, AnomalyRule
        detector = AnomalyDetector(rules=[
            AnomalyRule(
                name="loop_detection",
                description="检测到循环操作",
                action="terminate",
                threshold=5,
            ),
        ])
        # 5 次以内不触发
        for i in range(5):
            detected, _ = detector.check("agent_test", "any_action", f"target_{i}")
            assert not detected
        # 超过阈值触发
        detected, alerts = detector.check("agent_test", "any_action", "target_6")
        assert detected

    def test_anomaly_detector(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, alerts = detector.check("agent_test", "terminal", "rm -rf /")
        assert detected
        assert any("危险操作" in a for a in alerts)

    def test_reset(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        for i in range(10):
            detector.check("agent_test", "write", f"target_{i}")
        detector.reset("agent_test")
        detected, _ = detector.check("agent_test", "write", "new_target")
        assert not detected  # 计数器已重置


class TestSandboxAudit:
    """审计日志测试"""

    def test_audit_entry(self):
        from core.sandbox import AuditEntry
        entry = AuditEntry(
            agent_id="agent_test",
            action="file_write",
            target="/tmp/test.txt",
            level=2,
            status="allowed",
            risk_score=0.3,
        )
        d = entry.to_dict()
        assert d["agent_id"] == "agent_test"
        assert d["action"] == "file_write"
        assert d["status"] == "allowed"

    def test_audit_summary(self):
        from core.sandbox import SandboxManager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr = SandboxManager()
        # L0 和 L1 都自动批准并记录审计
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_test", "git_log", "/tmp/repo", level=1)
        summary = mgr.get_audit_summary()
        assert "total_operations" in summary
        assert "allowed" in summary
        assert summary["allowed"] >= 2

    def test_permission_request(self):
        from core.sandbox import PermissionRequest
        req = PermissionRequest(
            agent_id="agent_test",
            agent_name="测试Agent",
            task_id="task_001",
            task_description="修复bug",
            actions=[
                {"action": "file_write", "target": "src/main.py", "level": 2},
                {"action": "file_read", "target": "src/test.py", "level": 0},
            ],
        )
        d = req.to_dict()
        assert len(d["actions"]) == 2
        assert d["agent_name"] == "测试Agent"
        assert d["task_description"] == "修复bug"

    def test_approval_decision(self):
        from core.sandbox import ApprovalDecision
        decision = ApprovalDecision(
            request_id="perm_001",
            approved=True,
            approved_actions=["file_read", "file_write"],
            reason="用户批准",
        )
        assert decision.approved
        assert len(decision.approved_actions) == 2


class TestAgentSandboxOverride:
    """Agent 沙箱字段测试"""

    def test_agent_sandbox_override(self):
        from core.agent import Agent
        a = Agent(name="Test", role="tester", sandbox_override={
            "default_level": "moderated",
            "auto_approve_tools": ["file_read"],
        })
        assert a.sandbox_override["default_level"] == "moderated"
        assert "file_read" in a.sandbox_override["auto_approve_tools"]

    def test_agent_sandbox_serialization(self):
        from core.agent import Agent
        a = Agent(name="Test", role="tester", sandbox_override={
            "default_level": "moderated",
        })
        d = a.to_dict()
        assert "sandbox_override" in d
        b = Agent.from_dict(d)
        assert b.sandbox_override["default_level"] == "moderated"


class TestAgentPhase2:
    """Agent Phase 2 字段测试"""

    def test_lifecycle_persistence(self):
        from core.agent import Agent
        from core.evolve import AgentLifecycle
        a = Agent(name="Test", role="tester")
        a.lifecycle = AgentLifecycle.MATURITY
        a.evolution = {"total_interactions": 100, "lifecycle": "maturity"}
        d = a.to_dict()
        b = Agent.from_dict(d)
        assert b.lifecycle == AgentLifecycle.MATURITY
        assert b.evolution["total_interactions"] == 100

    def test_context_config_persistence(self):
        from core.agent import Agent
        a = Agent(name="Test", role="tester")
        a.context_config = {"head": 5, "tail": 15, "window": 50}
        d = a.to_dict()
        b = Agent.from_dict(d)
        assert b.context_config["head"] == 5
        assert b.context_config["window"] == 50

    def test_get_system_prompt_with_dict_traits(self):
        from core.agent import Agent
        a = Agent(name="Test", role="tester")
        a.persona.traits = [{"name": "helpful", "weight": 0.8}, {"name": "weak_trait", "weight": 0.2}]
        prompt = a.get_system_prompt()
        assert "helpful" in prompt
        assert "显著" in prompt  # weight >= 0.7
        assert "弱" in prompt     # weight < 0.3


# ── 输出过滤层测试 ──────────────────────────────────────────


class TestFilter:
    """输出过滤层测试"""

    def test_filter_model_name_exposure(self):
        from core.filter import OutputFilter, FilterRule, FilterAction
        f = OutputFilter()
        result = f.filter("我是 GPT-4 模型", agent_name="Slime")
        assert "GPT-4" not in result.filtered
        assert "slime 平台" in result.filtered
        assert len(result.violations) >= 1

    def test_filter_chinese_ai_identity(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        result = f.filter("作为一个 AI 语言模型，我可以帮你", agent_name="Slime")
        assert "作为一个 AI" not in result.filtered
        assert "slime 平台" in result.filtered

    def test_filter_english_ai_identity(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        result = f.filter("As an AI language model, I can help you", agent_name="Slime")
        assert "As an AI" not in result.filtered
        assert "slime platform" in result.filtered

    def test_filter_clean_text_passes(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        result = f.filter("你好，我是 Slime，我可以帮你做什么？", agent_name="Slime")
        assert result.filtered == "你好，我是 Slime，我可以帮你做什么？"
        assert len(result.violations) == 0
        assert not result.blocked

    def test_filter_strict_mode_blocks(self):
        from core.filter import OutputFilter
        f = OutputFilter(strict_mode=True)
        result = f.filter("我是 GPT-4", agent_name="Slime")
        assert result.blocked
        assert "无法提供" in result.filtered

    def test_filter_agnes_model_name(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        result = f.filter("我运行在 Agnes 2.5 Flash 上", agent_name="Slime")
        assert "Agnes" not in result.filtered
        assert "slime 平台" in result.filtered

    def test_filter_provider_exposure(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        result = f.filter("我使用 OpenAI API 来生成回复", agent_name="Slime")
        assert "OpenAI" not in result.filtered

    def test_filter_add_remove_rule(self):
        from core.filter import OutputFilter, FilterRule, FilterAction
        f = OutputFilter()
        f.add_rule(FilterRule(
            pattern=r'测试违规词',
            action=FilterAction.REPLACE,
            replacement="已过滤",
            description="测试规则",
        ))
        result = f.filter("这是一个测试违规词的例子", agent_name="Slime")
        assert "测试违规词" not in result.filtered
        assert "已过滤" in result.filtered
        # 移除规则
        removed = f.remove_rule(r'测试违规词')
        assert removed
        result2 = f.filter("这是一个测试违规词的例子", agent_name="Slime")
        assert "测试违规词" in result2.filtered

    def test_filter_stats(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        f.filter("我是 GPT-4", agent_name="Slime")
        f.filter("As an AI language model", agent_name="Slime")
        stats = f.stats
        assert stats["total_violations"] >= 2
        assert "rules_count" in stats

    def test_filter_reset(self):
        from core.filter import reset_filter, get_filter
        reset_filter(strict_mode=True)
        f = get_filter()
        assert f.strict_mode
        reset_filter(strict_mode=False)
        f2 = get_filter()
        assert not f2.strict_mode


# ── A-042: 反幻觉协议 ───────────────────────────────────────


class TestAntiHallucinationProtocol:
    def test_system_prompt_contains_protocol(self):
        from core.agent import Agent
        a = Agent(name="Slime", role="测试")
        prompt = a.get_system_prompt()
        assert "诚实与验证铁律" in prompt
        assert "禁止编造" in prompt
        assert "失败必须如实报告" in prompt
        assert "报告前验证" in prompt
        assert "能力边界诚实" in prompt
        assert "名称不改写" in prompt
        assert "工具必用" in prompt  # A-046: 第 7 条"先调用工具再回答"

    def test_protocol_is_second_section(self):
        """协议紧邻身份铁律之后（同为最高优先级区）"""
        from core.agent import Agent
        a = Agent(name="Slime", role="测试")
        prompt = a.get_system_prompt()
        idx_identity = prompt.find("身份铁律")
        idx_protocol = prompt.find("诚实与验证铁律")
        assert 0 <= idx_identity < idx_protocol


# ── A-039: 身份过滤不破坏功能性文本 ─────────────────────────


class TestFilterFunctionalTextProtection:
    def test_url_with_agnes_domain_preserved(self):
        """URL 域名含 agnes-ai 不被替换（此前图片链接被破坏成 'slime 平台-ai.space'）"""
        from core.filter import OutputFilter
        f = OutputFilter()
        reply = "图片链接：https://platform-outputs.agnes-ai.space/images/t2i/x.png"
        out = f.filter(reply, agent_name="Slime").filtered
        assert "platform-outputs.agnes-ai.space" in out
        assert "slime 平台-ai.space" not in out

    def test_model_identifier_preserved(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        reply = "模型：agnes-image-2.1-flash 与 agnes-video-v2.0"
        out = f.filter(reply, agent_name="Slime").filtered
        assert "agnes-image-2.1-flash" in out
        assert "agnes-video-v2.0" in out

    def test_prose_agnes_still_filtered(self):
        """散文中的品牌名照常过滤（保护不破坏身份铁律）"""
        from core.filter import OutputFilter
        f = OutputFilter()
        reply = "我运行在 Agnes 2.5 Flash 上"
        out = f.filter(reply, agent_name="Slime").filtered
        assert "Agnes" not in out
        assert "slime 平台" in out

    def test_dashed_brand_word_still_filtered(self):
        """不含数字的连字符品牌词（Agnes-based）不遮蔽，照常过滤"""
        from core.filter import OutputFilter
        f = OutputFilter()
        reply = "这是一个 Agnes-based 的模型"
        out = f.filter(reply, agent_name="Slime").filtered
        assert "Agnes-based" not in out

    def test_combined_url_and_prose(self):
        from core.filter import OutputFilter
        f = OutputFilter()
        reply = "我用 Agnes 2.5 Flash 生成了 https://platform-outputs.agnes-ai.space/a.png"
        out = f.filter(reply, agent_name="Slime").filtered
        assert "Agnes 2.5 Flash" not in out
        assert "platform-outputs.agnes-ai.space" in out
        assert "slime 平台" in out


# ── A-010: 跨 chunk 流式过滤缓冲 ─────────────────────────────


class TestToolProgressEvents:
    """A-050: 工具进度上报 → 流式 progress 事件转发"""

    def test_progress_forwarded_with_details(self):
        from unittest.mock import patch
        from core.llm import _execute_tools_with_progress
        import asyncio

        async def fake_execute(agent, messages, pending):
            from core.agent_context import tool_progress_q
            q = tool_progress_q.get()
            assert q is not None, "工具应能看到进度队列"
            q.put_nowait({"progress": 30, "tool": "视频生成"})
            await asyncio.sleep(0.01)
            q.put_nowait({"progress": 70, "tool": "视频生成"})
            await asyncio.sleep(0.01)
            return [("agnes_generate_video", "{}", "ok")]

        events = []

        async def consume():
            with patch("core.llm._execute_pending_tools", side_effect=fake_execute):
                async for item in _execute_tools_with_progress(None, [], []):
                    events.append(item)

        asyncio.run(consume())
        types = [e["type"] for e in events]
        assert types.count("progress") == 2
        assert events[0]["type"] == "progress" and events[0]["progress"] == 30
        assert events[1]["progress"] == 70
        assert events[0]["name"] == "视频生成"
        assert types[-1] == "_details"
        assert events[-1]["details"] == [("agnes_generate_video", "{}", "ok")]

    def test_no_progress_still_returns_details(self):
        from unittest.mock import patch
        from core.llm import _execute_tools_with_progress
        import asyncio

        async def fake_execute(agent, messages, pending):
            return [("file_read", "{}", "content")]

        events = []

        async def consume():
            with patch("core.llm._execute_pending_tools", side_effect=fake_execute):
                async for item in _execute_tools_with_progress(None, [], []):
                    events.append(item)

        asyncio.run(consume())
        assert [e["type"] for e in events] == ["_details"]
        assert events[-1]["details"] == [("file_read", "{}", "content")]

    def test_tool_exception_propagates(self):
        from unittest.mock import patch
        from core.llm import _execute_tools_with_progress
        import asyncio

        async def fake_execute(agent, messages, pending):
            raise RuntimeError("boom")

        async def consume():
            with patch("core.llm._execute_pending_tools", side_effect=fake_execute):
                async for _item in _execute_tools_with_progress(None, [], []):
                    pass

        try:
            asyncio.run(consume())
            assert False, "应抛出工具异常"
        except RuntimeError as e:
            assert "boom" in str(e)


class TestMediaCallDedup:
    """A-050-R3: 同请求内媒体生成工具合计最多 1 次（防生成混乱）"""

    def _run_batch(self, names):
        """在请求级 media_calls_log 上下文中执行一批工具调用，返回执行结果列表"""
        from core.agent_context import media_calls_log
        from core.llm import _execute_pending_tools
        from tools.registry import reset_registry, get_registry, Tool
        from unittest.mock import patch
        from core.agent import Agent
        import asyncio

        reset_registry()
        try:
            called = []

            async def fake_media(args):
                called.append(args.get("_name", "?"))
                return "ok"

            reg = get_registry()
            for n in names:
                reg.register(Tool(name=n, description="d",
                                  parameters={"type": "object", "properties": {}},
                                  execute_fn=fake_media, permissions=[]))

            def make_tc(n):
                return {"id": f"t_{n}", "function": {"name": n, "arguments": "{}"}}

            results = []

            async def consume():
                token = media_calls_log.set([])
                try:
                    await _execute_pending_tools(Agent(name="A", role="r"),
                                                 [], [make_tc(n) for n in names])
                finally:
                    media_calls_log.reset(token)

            asyncio.run(consume())
            # 从 messages 无法取结果，改直接验证：第二个工具被拦（未执行）
            return called
        finally:
            reset_registry()

    def test_same_request_second_media_blocked(self):
        """同请求连续两次 agnes_generate_video → 只执行一次"""
        from core.agent_context import media_calls_log
        from core.llm import _execute_pending_tools, _MEDIA_GENERATOR_TOOLS
        from tools.registry import reset_registry, get_registry, Tool
        from core.agent import Agent
        import asyncio

        reset_registry()
        try:
            called = []

            async def fake_video(args):
                called.append("video")
                return "ok"

            reg = get_registry()
            reg.register(Tool(name="agnes_generate_video", description="d",
                              parameters={"type": "object", "properties": {}},
                              execute_fn=fake_video, permissions=[]))
            msgs = []
            tcs = [
                {"id": "t1", "function": {"name": "agnes_generate_video", "arguments": "{}"}},
                {"id": "t2", "function": {"name": "agnes_generate_video", "arguments": "{}"}},
            ]

            async def consume():
                token = media_calls_log.set([])
                try:
                    await _execute_pending_tools(Agent(name="A", role="r"), msgs, tcs)
                finally:
                    media_calls_log.reset(token)

            asyncio.run(consume())
            assert called == ["video"], "第二次调用应被拦截不执行"
            assert any("同一请求内禁止再次生成" in m["content"] for m in msgs),                 "拦截应回填明确错误"
        finally:
            reset_registry()

    def test_image_then_video_second_blocked(self):
        """同请求图生图后又调视频 → 视频被拦截（合计 1 次）"""
        from core.agent_context import media_calls_log
        from core.llm import _execute_pending_tools
        from tools.registry import reset_registry, get_registry, Tool
        from core.agent import Agent
        import asyncio

        reset_registry()
        try:
            called = []

            async def fake(args):
                called.append("x")
                return "ok"

            reg = get_registry()
            for n in ("agnes_generate_image", "agnes_generate_video"):
                reg.register(Tool(name=n, description="d",
                                  parameters={"type": "object", "properties": {}},
                                  execute_fn=fake, permissions=[]))
            msgs = []
            tcs = [
                {"id": "t1", "function": {"name": "agnes_generate_image", "arguments": "{}"}},
                {"id": "t2", "function": {"name": "agnes_generate_video", "arguments": "{}"}},
            ]

            async def consume():
                token = media_calls_log.set([])
                try:
                    await _execute_pending_tools(Agent(name="A", role="r"), msgs, tcs)
                finally:
                    media_calls_log.reset(token)

            asyncio.run(consume())
            assert called == ["x"], "视频调用应被拦截"
        finally:
            reset_registry()

    def test_failed_media_allows_retry(self):
        """A-060: 上次媒体生成失败（429 等）→ 同一 Worker 下轮重试放行（不误拦）"""
        from core.agent_context import media_calls_log
        from core.llm import _execute_pending_tools
        from tools.registry import reset_registry, get_registry, Tool
        from core.agent import Agent
        import asyncio

        reset_registry()
        try:
            called = {"n": 0}

            async def fake_video(args):
                called["n"] += 1
                if called["n"] == 1:
                    return "[错误] API 调用失败: 429"
                return "视频生成完成（真实证据：本地文件已保存）"

            reg = get_registry()
            reg.register(Tool(name="agnes_generate_video", description="d",
                              parameters={"type": "object", "properties": {}},
                              execute_fn=fake_video, permissions=[]))
            msgs = []

            async def one_request():
                token = media_calls_log.set([])
                try:
                    # 第 1 轮：失败；第 2 轮：重试（同一请求，模拟 Worker 下轮）
                    await _execute_pending_tools(Agent(name="A", role="r"), msgs, [
                        {"id": "t1", "function": {"name": "agnes_generate_video", "arguments": "{}"}}])
                    await _execute_pending_tools(Agent(name="A", role="r"), msgs, [
                        {"id": "t2", "function": {"name": "agnes_generate_video", "arguments": "{}"}}])
                finally:
                    media_calls_log.reset(token)

            asyncio.run(one_request())
            assert called["n"] == 2, "失败后重试应放行（此前被误拦）"
            assert not any("同一请求内禁止再次" in m["content"] for m in msgs),                 "重试不应被拦截"
        finally:
            reset_registry()

    def test_success_then_media_blocked(self):
        """A-060: 成功生成后再调用 → 拦截（防乱调保持）"""
        from core.agent_context import media_calls_log
        from core.llm import _execute_pending_tools
        from tools.registry import reset_registry, get_registry, Tool
        from core.agent import Agent
        import asyncio

        reset_registry()
        try:
            called = {"n": 0}

            async def fake_video(args):
                called["n"] += 1
                return "视频生成完成（真实证据：本地文件已保存）"

            reg = get_registry()
            reg.register(Tool(name="agnes_generate_video", description="d",
                              parameters={"type": "object", "properties": {}},
                              execute_fn=fake_video, permissions=[]))
            msgs = []

            async def one_request():
                token = media_calls_log.set([])
                try:
                    await _execute_pending_tools(Agent(name="A", role="r"), msgs, [
                        {"id": "t1", "function": {"name": "agnes_generate_video", "arguments": "{}"}}])
                    await _execute_pending_tools(Agent(name="A", role="r"), msgs, [
                        {"id": "t2", "function": {"name": "agnes_generate_video", "arguments": "{}"}}])
                finally:
                    media_calls_log.reset(token)

            asyncio.run(one_request())
            assert called["n"] == 1, "成功后再次调用应被拦截"
            assert any("同一请求内禁止再次" in m["content"] for m in msgs)
        finally:
            reset_registry()

    def test_new_request_allowed(self):
        """不同请求（各自新日志）→ 各允许一次"""
        from core.agent_context import media_calls_log
        from core.llm import _execute_pending_tools
        from tools.registry import reset_registry, get_registry, Tool
        from core.agent import Agent
        import asyncio

        reset_registry()
        try:
            called = []

            async def fake(args):
                called.append(1)
                return "ok"

            reg = get_registry()
            reg.register(Tool(name="agnes_generate_video", description="d",
                              parameters={"type": "object", "properties": {}},
                              execute_fn=fake, permissions=[]))

            async def one_request():
                token = media_calls_log.set([])
                try:
                    await _execute_pending_tools(Agent(name="A", role="r"), [],
                                                 [{"id": "t", "function": {"name": "agnes_generate_video", "arguments": "{}"}}])
                finally:
                    media_calls_log.reset(token)

            asyncio.run(one_request())
            asyncio.run(one_request())  # 新请求
            assert len(called) == 2, "跨请求各允许一次"
        finally:
            reset_registry()


class TestRetry429:
    """A-056: 429 限流退避重试"""

    def test_retry_429_then_success(self):
        from unittest.mock import MagicMock, patch
        from core.llm import _post_chat_with_retry
        import asyncio

        calls = {"n": 0}

        class _Resp:
            def __init__(self, code):
                self.status_code = code

        async def fake_post(url, headers=None, json=None):
            calls["n"] += 1
            if calls["n"] < 3:
                return _Resp(429)
            return _Resp(200)

        client = MagicMock()
        client.post.side_effect = fake_post
        with patch("core.llm._RETRY_429_BACKOFF", (0.01, 0.01, 0.01)):
            resp = asyncio.run(_post_chat_with_retry(client, "u", {}, {}))
        assert resp.status_code == 200
        assert calls["n"] == 3  # 429×2 + 成功

    def test_no_retry_on_success(self):
        from unittest.mock import MagicMock
        from core.llm import _post_chat_with_retry
        import asyncio

        class _Resp:
            status_code = 200

        async def fake_post(url, headers=None, json=None):
            return _Resp()

        client = MagicMock()
        client.post.side_effect = fake_post
        resp = asyncio.run(_post_chat_with_retry(client, "u", {}, {}))
        assert resp.status_code == 200
        assert client.post.call_count == 1

    def test_give_up_after_backoff(self):
        from unittest.mock import MagicMock, patch
        from core.llm import _post_chat_with_retry
        import asyncio

        class _Resp:
            status_code = 429

        async def fake_post(url, headers=None, json=None):
            return _Resp()

        client = MagicMock()
        client.post.side_effect = fake_post
        with patch("core.llm._RETRY_429_BACKOFF", (0.01, 0.01, 0.01)):
            resp = asyncio.run(_post_chat_with_retry(client, "u", {}, {}))
        assert resp.status_code == 429  # 重试耗尽后返回 429（由调用方 raise_for_status）
        assert client.post.call_count == 3


class TestStreamFilter:
    """_StreamFilter 跨 chunk 身份铁律过滤（防边界拆分绕过）"""

    def _make_agent(self):
        from core.agent import Agent
        return Agent(name="Slime", role="测试")

    def test_cross_chunk_short_phrase(self):
        """'作为 ' + 'AI' 跨 chunk 拆分也能被拦截"""
        from core.llm import _StreamFilter
        sf = _StreamFilter()
        agent = self._make_agent()
        out1 = sf.feed("我是一个助手，作为 ", agent)
        out2 = sf.feed("AI 语言模型", agent)
        tail = sf.flush(agent)
        combined = out1 + out2 + tail
        assert "AI 语言模型" not in combined
        assert "slime 平台" in combined

    def test_cross_chunk_long_gap_rule(self):
        """'训练数据' 与 '模型' 相距跨块（规则 .{0,20} 间距）也能命中"""
        from core.llm import _StreamFilter
        sf = _StreamFilter()
        agent = self._make_agent()
        out1 = sf.feed("我的训练数", agent)
        out2 = sf.feed("据来自公开数据，这是模型", agent)
        tail = sf.flush(agent)
        combined = out1 + out2 + tail
        assert "训练数据" not in combined
        assert "模型" not in combined

    def test_short_reply_flushed_whole(self):
        """短回复（< HOLD）先暂扣，flush 后完整输出且无违规"""
        from core.llm import _StreamFilter
        sf = _StreamFilter()
        agent = self._make_agent()
        assert sf.feed("你好，我是 Slime", agent) == ""
        assert sf.flush(agent) == "你好，我是 Slime"

    def test_clean_long_stream_roundtrip(self):
        """无违规长流：分块输出拼接后与原文一致（覆盖边暂扣边输出路径）"""
        from core.llm import _StreamFilter
        sf = _StreamFilter()
        agent = self._make_agent()
        parts = ["今天天气不错，", "我们来聊聊", "项目进展。", "你最近在忙什么？",
                 "这周的任务清单我已经整理好了。", "要不要我帮你安排会议时间？"]
        out = "".join(sf.feed(p, agent) for p in parts)
        out += sf.flush(agent)
        assert out == "".join(parts)

    def test_violation_inside_chunk_still_caught(self):
        """同块内违规（原有能力不退化）"""
        from core.llm import _StreamFilter
        sf = _StreamFilter()
        agent = self._make_agent()
        out = sf.feed("我是 GPT-4 模型", agent)
        out += sf.flush(agent)
        assert "GPT-4" not in out


# ── IPC 总线测试 ────────────────────────────────────────────


class TestIPCBus:
    """IPC A2A 总线测试"""

    def test_register_and_send(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        bus.register("AgentB")
        result = bus.send("AgentA", "AgentB", "Hello", msg_type="info")
        assert result["delivered"] is True

    def test_send_to_nonexistent(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        result = bus.send("AgentA", "Ghost", "Hello")
        assert result["delivered"] is False

    def test_broadcast(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        bus.register("AgentB")
        bus.register("AgentC")
        result = bus.send("AgentA", "broadcast", "Hi all", msg_type="info")
        assert result["delivered"] is True

    def test_receive_message(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        bus.register("AgentB")
        bus.send("AgentA", "AgentB", "Hello")
        msg = bus.receive("AgentB", timeout=1.0)
        assert msg is not None
        assert msg["from_agent"] == "AgentA"
        assert msg["content"] == "Hello"

    def test_drain_all(self):
        from core.ipc_bus import IPCBus
        import time
        bus = IPCBus()
        bus.register("AgentA")
        bus.register("AgentB")
        bus.send("AgentA", "AgentB", "msg1")
        bus.send("AgentA", "AgentB", "msg2")
        bus.send("AgentA", "AgentB", "msg3")
        # multiprocessing.Queue put→get 有缓冲延迟：send 后短暂等待再 drain（防偶发 0 条）
        time.sleep(0.05)
        msgs = bus.drain_all("AgentB")
        assert len(msgs) == 3

    def test_history(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        bus.register("AgentB")
        bus.send("AgentA", "AgentB", "msg1")
        bus.send("AgentB", "AgentA", "msg2")
        history = bus.get_history("AgentA")
        assert len(history) == 2

    def test_shared_context(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        bus.register("AgentB")
        bus.send("AgentA", "AgentB", "Hello from A", "info")
        bus.send("AgentB", "AgentA", "Hello from B", "info")
        ctx = bus.get_shared_context("AgentA")
        assert "AgentB" in ctx

    def test_clear_and_shutdown(self):
        from core.ipc_bus import IPCBus
        bus = IPCBus()
        bus.register("AgentA")
        bus.send("AgentA", "broadcast", "test")
        bus.clear()
        assert len(bus.get_history()) == 0
        bus.shutdown()


# ── A-009: CLI 流式渲染纯函数 ───────────────────────────────


class TestCLIStreamHelpers:
    """CLI 流式渲染纯函数：ANSI 清理 / 工具事件格式化 / 思考冲刷"""

    def test_clean_ansi_strips_escape_sequences(self):
        from slime_cli import _clean_ansi
        assert _clean_ansi("\x1b[31mred\x1b[0m text") == "red text"
        assert _clean_ansi("plain") == "plain"
        assert _clean_ansi("") == ""
        assert _clean_ansi(None) == ""

    def test_format_tool_event_truncates_long_args(self):
        from slime_cli import _format_tool_event
        call_line, result_line = _format_tool_event("web_search", "x" * 500, "r" * 300)
        assert "web_search" in call_line
        assert len(call_line) < 350  # args 截断到 300 + 前后缀
        assert "参数过长已截断" in call_line
        assert "r" * 200 in result_line  # 结果截断 200
        assert len(result_line) < 240

    def test_format_tool_event_sanitizes_ansi(self):
        from slime_cli import _format_tool_event
        call_line, result_line = _format_tool_event("mcp_tool", "\x1b[31mA\x1b[0m", "\x1b]0;evil\x07B")
        assert "\x1b" not in call_line
        assert "\x1b" not in result_line
        assert "A" in call_line
        assert "B" in result_line

    def test_format_tool_event_empty_result(self):
        from slime_cli import _format_tool_event
        call_line, result_line = _format_tool_event("t", "{}", "")
        assert call_line.startswith("  🔧 t({})")
        assert result_line == ""

    def test_flush_thinking_panel_semantics(self):
        from slime_cli import _flush_thinking_panel
        assert _flush_thinking_panel([], False) is False        # 无缓冲无渲染
        assert _flush_thinking_panel(["x"], True) is True       # 已渲染不重复
        assert _flush_thinking_panel(["已思考"], False) is True  # 未渲染则冲刷

    def test_find_unverified_claims_fabricated(self, tmp_path):
        """A-044: 声称已保存但不存在的文件 → 命中护栏"""
        from slime_cli import _find_unverified_claims
        missing = str(tmp_path / "不存在.png")
        claims = _find_unverified_claims(f"图片已保存到 {missing}，大小 21KB")
        assert claims == [missing]

    def test_find_unverified_claims_existing_file_ok(self, tmp_path):
        from slime_cli import _find_unverified_claims
        p = tmp_path / "real.txt"
        p.write_text("x")
        assert _find_unverified_claims(f"已保存到 {p}") == []

    def test_find_unverified_claims_future_tense_ignored(self):
        """无"已保存"类动词的未来式表述不误报"""
        from slime_cli import _find_unverified_claims
        assert _find_unverified_claims("我将把文件命名为 output.png") == []

    def test_find_unverified_claims_plain_text_no_flag(self):
        from slime_cli import _find_unverified_claims
        assert _find_unverified_claims("任务完成！") == []
        assert _find_unverified_claims("") == []

    def test_find_unverified_claims_chinese_filename(self):
        """中文文件名（清纯女大学生.jpg 类）也能命中"""
        from slime_cli import _find_unverified_claims
        claims = _find_unverified_claims("已生成 清纯女大学生.jpg 在根目录")
        assert claims == ["清纯女大学生.jpg"]

    def test_find_unverified_claims_table_layout_far_from_verb(self, tmp_path):
        """A-046: 声称动词与路径相距很远（表格排版，如"完整路径 | 不存在.mp4 |"）也命中"""
        from slime_cli import _find_unverified_claims
        missing = str(tmp_path / "不存在.mp4")
        reply = f"视频已成功保存到本地！\n\n| 项目 | 值 |\n| 完整路径 | {missing} |\n"
        claims = _find_unverified_claims(reply)
        assert claims == [missing]

    def test_find_unverified_claims_windows_path_claimed(self, tmp_path):
        """Windows 盘符路径（C:\\...\\x.png）也走存在性核验"""
        from slime_cli import _find_unverified_claims
        missing = str(tmp_path / "视频.mp4")
        claims = _find_unverified_claims(f"已下载 视频文件: {missing}")
        assert claims == [missing]


# ── A-032: 委托/广播标记解析（此前零直接测试） ────────────────


class TestDelegationParsing:
    def test_parse_single_delegation(self):
        from core.a2a import parse_delegations
        reply = '我来处理。\n<DELEGATE name="代码审查员">请审查这段代码</DELEGATE>\n以上。'
        ds = parse_delegations(reply)
        assert ds == [{"name": "代码审查员", "task": "请审查这段代码"}]

    def test_parse_multiple_delegations(self):
        from core.a2a import parse_delegations
        reply = '<DELEGATE name="A">任务甲</DELEGATE> <DELEGATE name="B">任务乙</DELEGATE>'
        ds = parse_delegations(reply)
        assert [d["name"] for d in ds] == ["A", "B"]
        assert [d["task"] for d in ds] == ["任务甲", "任务乙"]

    def test_parse_unclosed_ignored(self):
        from core.a2a import parse_delegations
        assert parse_delegations('<DELEGATE name="A">没有闭合标签') == []

    def test_parse_empty_name_skipped(self):
        from core.a2a import parse_delegations
        reply = '<DELEGATE name="">任务</DELEGATE><DELEGATE name="B">任务B</DELEGATE>'
        ds = parse_delegations(reply)
        assert len(ds) == 1 and ds[0]["name"] == "B"

    def test_false_open_tag_conservative_drop(self):
        """任务文本含 <DELEGATE 字串破坏平衡 → 保守整体放弃（不误路由子任务）"""
        from core.a2a import parse_delegations
        reply = ('<DELEGATE name="A">提到 <DELEGATE 字样</DELEGATE>'
                 '<DELEGATE name="B">任务B</DELEGATE>')
        assert parse_delegations(reply) == []

    def test_parse_broadcast(self):
        from core.a2a import parse_broadcast
        assert parse_broadcast("正文\n<BROADCAST>大家好</BROADCAST>\n完") == "大家好"
        assert parse_broadcast("没有广播") is None

    def test_strip_tags_clean(self):
        from core.a2a import strip_delegation_tags
        text = ('我先委托。\n<DELEGATE name="A">任务</DELEGATE>\n'
                '<BROADCAST>通知大家</BROADCAST>\n'
                '<DELEGATE_RESULT name="A">结果</DELEGATE_RESULT>\n结尾。')
        out = strip_delegation_tags(text)
        assert "<DELEGATE" not in out and "<BROADCAST" not in out
        assert "我先委托。" in out and "结尾。" in out

    def test_strip_orphan_close_tags(self):
        """孤立闭合标签（注入遗留）被清理"""
        from core.a2a import strip_delegation_tags
        out = strip_delegation_tags("正文 </DELEGATE> 尾")
        assert "</DELEGATE>" not in out
        assert "正文  尾" in out


# ── A-011: extract_memories_from_chat（LLM 提取链路） ────────


class TestExtractMemories:
    """extract_memories_from_chat：注入 llm_call_fn 测试提取/降级/清洗链路"""

    def _make_memory(self, tmp_path):
        from core.memory import MemoryStore
        return MemoryStore(agent_id="em1", lancedb_enabled=False, data_dir=str(tmp_path))

    def test_no_llm_fn_returns_empty(self, tmp_path):
        import asyncio
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)
        r = asyncio.run(extract_memories_from_chat(mem, "hi", "hello", True, llm_call_fn=None))
        assert r["count"]["facts"] == 0
        assert r["user_sentiment"] == 0.0
        assert r["behavior_patterns"] == []

    def test_entries_extracted_and_stored(self, tmp_path):
        import asyncio, json
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)

        async def fake_llm(prompt):
            return json.dumps({
                "entries": [
                    {"content": "用户喜欢用 Python", "category": "preference", "tags": ["lang"], "importance": 8},
                    {"content": "每次评审都要先跑测试", "category": "lesson", "tags": [], "importance": 6},
                ],
                "traits_observed": [{"name": "严谨", "signal": 1}],
                "user_sentiment": 0.5,
                "behavior_patterns": [
                    {"scenario": "代码评审", "steps": ["先跑测试", "再读 diff"], "rationale": "避免返工"},
                ],
            })

        r = asyncio.run(extract_memories_from_chat(mem, "帮我评审", "好的", True, llm_call_fn=fake_llm))
        assert r["count"]["facts"] == 2
        assert r["count"]["traits"] == 1
        assert r["trait_signals"] == [{"name": "严谨", "signal": 1}]
        assert r["user_sentiment"] == 0.5
        assert r["behavior_patterns"][0]["scenario"] == "代码评审"
        assert r["behavior_patterns"][0]["rationale"] == "避免返工"
        # 实际写入 store
        facts = mem.get_facts()
        contents = [f.get("content", "") for f in facts]
        assert "用户喜欢用 Python" in contents

    def test_unknown_category_falls_back_to_fact(self, tmp_path):
        import asyncio, json
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)

        async def fake_llm(prompt):
            return json.dumps({"entries": [{"content": "x", "category": "hacker", "tags": []}]})

        r = asyncio.run(extract_memories_from_chat(mem, "u", "a", True, llm_call_fn=fake_llm))
        assert r["count"]["facts"] == 1

    def test_code_fence_json_stripped(self, tmp_path):
        import asyncio, json
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)

        async def fake_llm(prompt):
            payload = json.dumps({"entries": [{"content": "fenced", "category": "fact", "tags": []}]})
            return "```json\n" + payload + "\n```"

        r = asyncio.run(extract_memories_from_chat(mem, "u", "a", True, llm_call_fn=fake_llm))
        assert r["count"]["facts"] == 1

    def test_invalid_json_returns_empty_without_crash(self, tmp_path):
        import asyncio
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)

        async def fake_llm(prompt):
            return "抱歉，我无法分析这段对话。"

        r = asyncio.run(extract_memories_from_chat(mem, "u", "a", True, llm_call_fn=fake_llm))
        assert r["count"]["facts"] == 0
        assert r["user_sentiment"] == 0.0

    def test_sentiment_clamped(self, tmp_path):
        import asyncio, json
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)

        async def fake_llm(prompt):
            return json.dumps({"entries": [], "user_sentiment": 2.5})

        r = asyncio.run(extract_memories_from_chat(mem, "u", "a", True, llm_call_fn=fake_llm))
        assert r["user_sentiment"] == 1.0

        async def fake_llm2(prompt):
            return json.dumps({"entries": [], "user_sentiment": "not-a-number"})

        r2 = asyncio.run(extract_memories_from_chat(mem, "u", "a", True, llm_call_fn=fake_llm2))
        assert r2["user_sentiment"] == 0.0

    def test_behavior_patterns_sanitized(self, tmp_path):
        import asyncio, json
        from core.memory import extract_memories_from_chat
        mem = self._make_memory(tmp_path)

        async def fake_llm(prompt):
            return json.dumps({
                "entries": [],
                "behavior_patterns": [
                    {"scenario": "有效", "steps": ["a", "", "b", 123], "rationale": "r" * 300},
                    {"scenario": "  ", "steps": ["a"]},
                    "not-a-dict",
                ],
            })

        r = asyncio.run(extract_memories_from_chat(mem, "u", "a", True, llm_call_fn=fake_llm))
        assert len(r["behavior_patterns"]) == 1
        assert r["behavior_patterns"][0]["steps"] == ["a", "b"]
        assert len(r["behavior_patterns"][0]["rationale"]) == 200


# ── A-020: launcher 进程身份校验 ─────────────────────────────


class TestCodeCheckTool:
    """A-084: 代码语法校验工具（.py→py_compile，.js→node --check）"""

    def _mk(self):
        """项目内临时目录（code_check 限项目范围）"""
        import os
        from tools.agnes_media import _PROJECT_ROOT
        td = _PROJECT_ROOT / "data" / f"codecheck_{os.getpid()}_{id(self)}"
        td.mkdir(parents=True, exist_ok=True)
        return td

    def test_python_valid(self):
        from tools.builtin import _code_check
        td = self._mk()
        try:
            p = td / "good.py"
            p.write_text("def foo(x):\n    return x + 1\nprint(foo(1))\n", encoding="utf-8")
            r = __import__("asyncio").run(_code_check({"path": str(p)}))
            assert "通过" in r and "Python" in r
        finally:
            __import__("shutil").rmtree(td, ignore_errors=True)

    def test_python_invalid(self):
        from tools.builtin import _code_check
        td = self._mk()
        try:
            p = td / "bad.py"
            p.write_text("def foo(:\n    return\n", encoding="utf-8")
            r = __import__("asyncio").run(_code_check({"path": str(p)}))
            assert "Python 语法错误" in r
        finally:
            __import__("shutil").rmtree(td, ignore_errors=True)

    def test_js_valid(self):
        from tools.builtin import _code_check
        td = self._mk()
        try:
            p = td / "app.js"
            p.write_text("function add(a, b) { return a + b; }\nconsole.log(add(1, 2));\n", encoding="utf-8")
            r = __import__("asyncio").run(_code_check({"path": str(p)}))
            assert "通过" in r and "JavaScript" in r
        finally:
            __import__("shutil").rmtree(td, ignore_errors=True)

    def test_unsupported_skips(self):
        from tools.builtin import _code_check
        td = self._mk()
        try:
            p = td / "note.txt"
            p.write_text("hello", encoding="utf-8")
            r = __import__("asyncio").run(_code_check({"path": str(p)}))
            assert "跳过" in r
        finally:
            __import__("shutil").rmtree(td, ignore_errors=True)

    def test_missing_file(self):
        from tools.builtin import _code_check
        td = self._mk()
        try:
            r = __import__("asyncio").run(_code_check({"path": str(td / "nope.py")}))
            assert "文件不存在" in r
        finally:
            __import__("shutil").rmtree(td, ignore_errors=True)


class TestWritePathBlocklist:
    """A-087（漏洞清单 P1-6/P1-7）：file_write 关键文件黑名单 + 大小写变体"""

    def test_critical_files_blocked(self):
        from tools.builtin import _file_write
        for target in ("slime.toml", "config/agents.json", "core/agent.py",
                       "tools/builtin.py", "data/audit.jsonl", "slime_server.py"):
            r = __import__("asyncio").run(_file_write({"path": target, "content": "x"}))
            assert "禁止写入" in r, (target, r)

    def test_case_variant_blocked(self):
        """P1-6: Windows 大小写不敏感——AUTH_TOKEN.JSON / PROVIDERS.ENC.JSON 变体同样拦截"""
        from tools.builtin import _file_write
        r = __import__("asyncio").run(_file_write({"path": "config/AUTH_TOKEN.JSON", "content": "x"}))
        assert "禁止写入" in r
        r2 = __import__("asyncio").run(_file_write({"path": "config/PROVIDERS.ENC.JSON", "content": "x"}))
        assert "禁止写入" in r2

    def test_output_dir_still_writable(self):
        from tools.builtin import _file_write
        r = __import__("asyncio").run(_file_write({"path": "data/generated/write_test_ok.md", "content": "hi"}))
        assert "已保存" in r


class TestLauncherHelpers:
    """slime_launcher 辅助函数（_kill_port 的 python 身份校验，防误杀）"""

    def test_is_python_process_positive(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from slime_launcher import _is_python_process
        m = MagicMock()
        m.stdout = '"python.exe","1234","Console","1","100,000 K"\n'
        with patch.object(subprocess, "run", return_value=m):
            assert _is_python_process("1234") is True

    def test_is_python_process_negative(self):
        import subprocess
        from unittest.mock import patch, MagicMock
        from slime_launcher import _is_python_process
        m = MagicMock()
        m.stdout = '"nginx.exe","1234","Console","1","10 K"\n'
        with patch.object(subprocess, "run", return_value=m):
            assert _is_python_process("1234") is False

    def test_is_python_process_query_failure(self):
        """查询失败保守 False（不误杀）"""
        import subprocess
        from unittest.mock import patch
        from slime_launcher import _is_python_process
        with patch.object(subprocess, "run", side_effect=OSError("boom")):
            assert _is_python_process("1234") is False


# ── A-026: Multiplexer 输出编码安全 ─────────────────────────


class TestMultiplexerEncoding:
    def test_ensure_output_encoding_safe(self):
        """GBK 管道下 reconfigure(errors=replace)，图标输出不再崩溃"""
        import sys
        from core.multiplexer import _ensure_output_encoding_safe
        if not hasattr(sys.stdout, "reconfigure"):
            return  # 捕获流环境（pytest 默认）不支持重配，跳过
        orig = sys.stdout.errors
        try:
            _ensure_output_encoding_safe()
            assert sys.stdout.errors == "replace"
        finally:
            sys.stdout.reconfigure(errors=orig)