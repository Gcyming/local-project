"""Swarm 写操作串行化（设计文档 §6.1「写操作必须单线程 / 只读子 agent 才能并行」）。

覆盖四条真行为：
1. 只读/会写子任务判定（core/swarm.py，fail-closed）
2. 协程执行器调度：只读并行、会写串行（core/executor.py _dispatch_subs）
3. 多进程执行器同策略（core/executor.py _pump + core/process_worker.py 只读标记）
4. 只读判定在工具层被真正执行（core/llm.py _execute_pending_tools 拦截写工具）
"""

import asyncio
import json
from unittest.mock import MagicMock, patch


def _make_executor():
    from core.agent import Agent
    from core.executor import SwarmExecutor
    providers = {"p1": {"api_base": "http://x", "api_key": "k", "model": "m"},
                 "p2": {"api_base": "http://y", "api_key": "k", "model": "m"}}
    main_agent = Agent(name="Main", role="main")
    return SwarmExecutor(providers, main_agent, agent_registry=[main_agent])


def _write_desc(i):
    return f"保存第 {i} 段的调研结论到 docs/seg{i}.md"


def _read_desc(i):
    return f"调研 core/swarm.py 第 {i} 段的编排逻辑并给出结论"


class _ConcurrencyProbe:
    def __init__(self):
        self.events = []
        self.live = 0
        self.peak = 0

    def enter(self, name):
        self.events.append(("start", name))
        self.live += 1
        if self.live > self.peak:
            self.peak = self.live

    def leave(self, name):
        self.events.append(("end", name))
        self.live -= 1


class _AllowAllSandbox:
    """只放行不拦截——让「谁拦的」只能是 Swarm 只读闸本身，而不是沙箱。"""

    def __init__(self):
        self.violations = []

    def check_permission(self, agent_id, action, target, level=4):
        return MagicMock(allowed=True, anomaly_detected=False, anomaly_alerts=[])

    def grant_permission(self, *a, **k):
        pass

    def record_violation(self, agent_id):
        self.violations.append(agent_id)


class TestSubtaskWriteClassification:
    def test_write_intent_subtask_is_not_readonly(self):
        from core.swarm import classify_subtask_readonly
        assert classify_subtask_readonly(_write_desc(1)) is False

    def test_read_only_intent_subtask_is_readonly(self):
        from core.swarm import classify_subtask_readonly
        assert classify_subtask_readonly(_read_desc(1)) is True

    def test_mixed_read_then_write_is_write(self):
        from core.swarm import classify_subtask_readonly
        assert classify_subtask_readonly("先调研再修复 core/swarm.py 的竞态") is False

    def test_unknown_intent_fails_closed_to_write(self):
        from core.swarm import classify_subtask_readonly
        assert classify_subtask_readonly("") is False
        assert classify_subtask_readonly("随便搞点事情") is False

    def test_write_tool_name_in_description_is_write(self):
        from core.swarm import classify_subtask_readonly
        assert classify_subtask_readonly("阅读现状后用 file_write 输出结论") is False

    def test_plan_marks_each_subtask(self):
        from core.swarm import SwarmOrchestrator
        orch = SwarmOrchestrator({"p1": {"api_base": "http://x", "api_key": "k", "model": "m"}})
        plan = orch.create_plan("t1", "任务", [_read_desc(1), _write_desc(2)], ["A", "B"])
        assert [st.read_only for st in plan.subtasks] == [True, False]


class TestSwarmWriteDenial:
    def _tool(self, name, perms):
        tool = MagicMock()
        tool.name = name
        tool.permissions = perms
        return tool

    def test_write_permission_denied(self):
        from core.swarm import swarm_write_denial
        msg = swarm_write_denial(self._tool("zz_probe_write", ["write"]))
        assert msg.startswith("[Swarm 串行闸]")
        assert "zz_probe_write" in msg

    def test_terminal_permission_denied(self):
        from core.swarm import swarm_write_denial
        assert swarm_write_denial(self._tool("zz_probe_shell", ["terminal"])) != ""

    def test_media_tool_denied_despite_network_only(self):
        from core.swarm import swarm_write_denial
        assert swarm_write_denial(self._tool("agnes_generate_image", ["network"])) != ""

    def test_mcp_tool_denied_unknown_side_effect(self):
        from core.swarm import swarm_write_denial
        assert swarm_write_denial(self._tool("mcp_something_do", ["network"])) != ""

    def test_read_tool_allowed(self):
        from core.swarm import swarm_write_denial
        assert swarm_write_denial(self._tool("file_read", ["read"])) == ""

    def test_web_fetch_allowed(self):
        from core.swarm import swarm_write_denial
        assert swarm_write_denial(self._tool("web_fetch", ["network"])) == ""


class TestReadonlyGateAtToolLayer:
    def setup_method(self):
        from tools.registry import Tool, get_registry
        self.calls = []

        async def _exec(args):
            self.calls.append(dict(args))
            return "probe-ok"

        get_registry().register(
            Tool(name="zz_swarm_probe_write", description="probe",
                 parameters={"type": "object", "properties": {}},
                 permissions=["write"], execute_fn=_exec),
            force=True)

    def _run(self, readonly, messages):
        from core.agent import Agent
        from core.agent_context import swarm_readonly_mode
        from core.llm import _execute_pending_tools
        agent = Agent(name="ProbeWorker", role="probe")
        pending = [{"id": "call_1", "type": "function",
                    "function": {"name": "zz_swarm_probe_write", "arguments": "{}"}}]
        self.sandbox = _AllowAllSandbox()
        token = swarm_readonly_mode.set(readonly)
        try:
            with patch("core.sandbox.get_sandbox_manager", return_value=self.sandbox):
                return asyncio.run(_execute_pending_tools(agent, messages, pending))
        finally:
            swarm_readonly_mode.reset(token)

    def test_write_tool_denied_inside_readonly_worker(self):
        messages = []
        details = self._run(True, messages)
        assert self.calls == [], f"只读 Worker 不该真执行写工具：{self.calls}"
        assert len(details) == 1 and details[0][0] == "zz_swarm_probe_write"
        assert details[0][2].startswith("[Swarm 串行闸]")
        assert messages[-1]["role"] == "tool"
        assert messages[-1]["content"].startswith("[Swarm 串行闸]")

    def test_same_write_tool_executes_in_write_worker(self):
        messages = []
        details = self._run(False, messages)
        assert self.calls == [{}], f"非只读 Worker 必须照常执行：{self.calls}"
        assert details[0][2] == "probe-ok"
        assert "[Swarm 串行闸]" not in messages[-1]["content"]

    def test_denial_counts_sandbox_violation(self):
        self._run(True, [])
        assert self.sandbox.violations, "只读 Worker 调写工具应记一次违规"

    def test_no_violation_when_write_worker_runs(self):
        self._run(False, [])
        assert self.sandbox.violations == [], "非只读 Worker 不该记违规"


def _video_desc(i):
    return f"调用 agnes_generate_video 生成第 {i} 段视频"


class TestAsyncSchedulerWriteSerialization:
    def _run(self, descs, max_workers):
        from core.agent_context import swarm_readonly_mode
        executor = _make_executor()
        probe = _ConcurrencyProbe()
        readonly_seen = {}

        async def fake_call(cfg, agent, message, history, **kwargs):
            readonly_seen[agent.name] = swarm_readonly_mode.get()
            probe.enter(agent.name)
            try:
                await asyncio.sleep(0.6)
            finally:
                probe.leave(agent.name)
            return "完成\n<DONE>"

        payload = json.dumps({"subtasks": [{"desc": d, "agent": ""} for d in descs]},
                             ensure_ascii=False)

        async def fake_llm(agent, prompt, history, providers, registry):
            return payload

        with patch("core.executor.Multiplexer", MagicMock()), \
             patch("core.executor.call_llm", side_effect=fake_llm), \
             patch("core.executor.call_api_provider", side_effect=fake_call):
            asyncio.run(executor._run_async("任务", max_workers, None, None, None, None, None))

        return probe, readonly_seen

    def test_write_subtasks_never_overlap(self):
        probe, readonly_seen = self._run([_write_desc(i) for i in range(1, 4)], 3)
        assert len(probe.events) == 6, probe.events
        assert probe.peak == 1, f"会写子任务必须串行，实测峰值并发 {probe.peak}：{probe.events}"
        assert readonly_seen == {"Worker-1": False, "Worker-2": False, "Worker-3": False}

    def test_readonly_subtasks_overlap(self):
        probe, readonly_seen = self._run([_read_desc(i) for i in range(1, 4)], 3)
        assert len(probe.events) == 6, probe.events
        assert probe.peak >= 2, f"只读子任务应当并行，实测峰值 {probe.peak}：{probe.events}"
        assert readonly_seen == {"Worker-1": True, "Worker-2": True, "Worker-3": True}

    def test_readonly_pool_finishes_before_write_chain_starts(self):
        probe, _ = self._run([_read_desc(1), _write_desc(2), _read_desc(3)], 3)
        order = probe.events
        last_read_end = max(i for i, e in enumerate(order)
                            if e == ("end", "Worker-1"))
        write_start = min(i for i, e in enumerate(order)
                          if e == ("start", "Worker-2"))
        assert write_start > last_read_end, order


class TestVideoChainSharesWriteGate:
    def _run(self, descs, max_workers):
        executor = _make_executor()
        probe = _ConcurrencyProbe()

        async def fake_call(cfg, agent, message, history, **kwargs):
            probe.enter(agent.name)
            try:
                await asyncio.sleep(0.6)
            finally:
                probe.leave(agent.name)
            return "完成\n<DONE>"

        payload = json.dumps({"subtasks": [{"desc": d, "agent": ""} for d in descs]},
                             ensure_ascii=False)

        async def fake_llm(agent, prompt, history, providers, registry):
            return payload

        with patch("core.executor.Multiplexer", MagicMock()), \
             patch("core.executor.call_llm", side_effect=fake_llm), \
             patch("core.executor.call_api_provider", side_effect=fake_call):
            asyncio.run(executor._run_async("任务", max_workers, None, None, None, None, None))

        return probe

    def test_video_segment_never_overlaps_write_subtask(self):
        probe = self._run([_video_desc(1), _write_desc(2)], 3)
        assert len(probe.events) == 4, probe.events
        assert probe.peak == 1, \
            f"视频段（会写）必须与写子任务互斥，实测峰值并发 {probe.peak}：{probe.events}"

    def test_video_segments_stay_sequential_within_chain(self):
        probe = self._run([_video_desc(1), _video_desc(2)], 3)
        assert len(probe.events) == 4, probe.events
        assert probe.peak == 1, \
            f"视频链各段必须逐段串行（末帧依赖），实测峰值并发 {probe.peak}：{probe.events}"

    def test_video_segment_still_parallel_with_readonly(self):
        probe = self._run([_video_desc(1), _read_desc(2)], 3)
        assert len(probe.events) == 4, probe.events
        assert probe.peak == 2, \
            f"只读子任务应与视频段并行，实测峰值并发 {probe.peak}：{probe.events}"


class _FakeProcessWorker:
    instances = []
    active = []
    peak = 0

    def __init__(self, worker_input, receive_queue=None, peer_queues=None):
        self.input = worker_input
        self._alive = False
        self._settled = False
        self._result = None
        _FakeProcessWorker.instances.append(self)

    @classmethod
    def _leave(cls, name):
        if name in cls.active:
            cls.active.remove(name)

    def start(self):
        self._alive = True
        _FakeProcessWorker.active.append(self.input.subtask_name)
        if len(_FakeProcessWorker.active) > _FakeProcessWorker.peak:
            _FakeProcessWorker.peak = len(_FakeProcessWorker.active)

    def is_alive(self):
        return self._alive and not self._settled

    def stop(self, timeout=5.0):
        self._alive = False
        self._settled = True
        self._leave(self.input.subtask_name)

    def drain_progress(self):
        return []

    def get_result(self, timeout=600, kill_on_timeout=True):
        if not self._alive:
            return self._result
        self._settled = True
        self._alive = False
        self._leave(self.input.subtask_name)
        self._result = MagicMock(state="done", result="ok", error="", rounds=1)
        return self._result

    def cleanup(self):
        self._alive = False


class _FakeIPCBus:
    def __init__(self):
        self._queues = {}
        self._warnings = []

    def register(self, name):
        self._queues[name] = object()

    def get_all_agent_names(self):
        return list(self._queues)

    def get_warnings(self):
        return list(self._warnings)

    def shutdown(self):
        pass


class TestMultiprocessSchedulerWriteSerialization:
    def setup_method(self):
        _FakeProcessWorker.instances = []
        _FakeProcessWorker.active = []
        _FakeProcessWorker.peak = 0

    def _run(self, descs, max_workers):
        executor = _make_executor()
        names = [f"W{i + 1}" for i in range(len(descs))]

        async def fake_llm(agent, prompt, history, providers, registry):
            return "合并完成"

        with patch("core.executor.Multiplexer", MagicMock()), \
             patch("core.ipc_bus.IPCBus", _FakeIPCBus), \
             patch("core.process_worker.ProcessWorker", _FakeProcessWorker), \
             patch("core.executor.call_llm", side_effect=fake_llm):
            executor._run_multiprocess("任务", max_workers, names, descs,
                                       None, None, None)

        return {pw.input.subtask_name: pw.input.agent_config
                for pw in _FakeProcessWorker.instances}

    def test_write_subtasks_start_one_at_a_time(self):
        inputs = self._run([_write_desc(i) for i in range(1, 4)], 3)
        assert _FakeProcessWorker.peak == 1, \
            f"多进程会写子任务必须串行，实测峰值 {_FakeProcessWorker.peak}"
        assert {n: cfg["readonly"] for n, cfg in inputs.items()} == {
            "W1": False, "W2": False, "W3": False}

    def test_readonly_subtasks_start_concurrently(self):
        inputs = self._run([_read_desc(i) for i in range(1, 4)], 3)
        assert _FakeProcessWorker.peak >= 2, \
            f"多进程只读子任务应当并行，实测峰值 {_FakeProcessWorker.peak}"
        assert {n: cfg["readonly"] for n, cfg in inputs.items()} == {
            "W1": True, "W2": True, "W3": True}


class TestProcessWorkerReadonlyFlag:
    def _run_main(self, readonly):
        from core.agent_context import swarm_readonly_mode
        from core.process_worker import WorkerInput, _worker_main

        class _Q:
            def __init__(self):
                self.items = []

            def put(self, x):
                self.items.append(x)

        wi = WorkerInput(
            task_id="t1", subtask_id="st1", subtask_name="W1",
            subtask_description=_read_desc(1) if readonly else _write_desc(1),
            provider_key="p1",
            provider_config={"api_base": "http://x", "api_key": "k", "model": "m"},
            agent_config={
                "identity_prompt": "你是 W1",
                "max_context": 4096,
                "max_output": 2048,
                "readonly": readonly,
            },
        )
        seen = {}

        async def fake_call(cfg, agent, message, history, **kwargs):
            seen["readonly"] = swarm_readonly_mode.get()
            return "完成\n<DONE>"

        q = _Q()
        with patch("core.llm.call_api_provider", side_effect=fake_call):
            _worker_main(wi.to_dict(), q, None, None, None, None)
        return seen, q

    def test_readonly_worker_enters_readonly_mode(self):
        seen, q = self._run_main(True)
        assert seen.get("readonly") is True
        assert q.items and q.items[0]["state"] == "done", q.items

    def test_write_worker_not_in_readonly_mode(self):
        seen, q = self._run_main(False)
        assert seen.get("readonly") is False
        assert q.items and q.items[0]["state"] == "done", q.items
