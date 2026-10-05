"""
slime Swarm 三闸（docs/slime-agent-loop-design.md §1.2）测试

覆盖点：
- 阈值可配置：slime.toml [swarm_gates] 解析 + 缺省回退 + 单闸关闭入口
- 花费闸取价：provider 存值价 / 自定义定价表 / 仓库价格快照；**读不到定价 → 禁用并告警**（不编价）
- 花费折算：USD/1M tokens 口径、token 估算标记、触发时的归因文案
- 墙钟闸：从子任务开始计时、超限归因、关闭时不做限时等待
- executor / process_worker 接线：闸门触发 → **显式终止**（不再调用模型）+ 明确归因
- 轮次闸语义不动：轮次耗尽未收到 <DONE> 仍一律 failed
"""

import asyncio
import json
from unittest.mock import MagicMock, patch

from core.agent import Agent
from core.budget import (
    GATE_COST,
    GATE_WALL,
    GateLimits,
    PriceInfo,
    SubtaskBudget,
    _read_toml_section,
    _snapshot_table,
    load_gate_limits,
    normalize_model_id,
    resolve_price,
)
from core.executor import SwarmExecutor, MAX_ROUNDS
from core.swarm import TaskState


TOML_SECTION = """
[other]
x = 1

[swarm_gates]
enabled = true
cost_limit_usd = 0.25
wall_clock_seconds = 30
pricing_file = ""
"""


def _limits(cost=1.0, wall=3600.0, enabled=True, pricing_file=""):
    return GateLimits(
        enabled=enabled,
        cost_limit_usd=cost,
        wall_clock_seconds=wall,
        pricing_file=pricing_file,
    )


def _priced_budget(cost_limit=0.01, price_in=1.0, price_out=1.0, wall=3600.0, clock=None):
    return SubtaskBudget(
        model="m",
        provider_cfg={"model": "m"},
        limits=_limits(cost=cost_limit, wall=wall),
        pricing=PriceInfo(price_in=price_in, price_out=price_out, source="provider 存值价"),
        clock=clock,
    )


class _FakeQueue:
    """result_queue / progress_queue 的最小桩（_worker_main 只需 put）"""

    def __init__(self):
        self.items = []

    def put(self, item):
        self.items.append(item)


class TestGateConfig:
    """阈值必须可配置（slime.toml [swarm_gates]），缺省有合理默认值"""

    def test_defaults_when_section_missing(self, tmp_path):
        p = tmp_path / "slime.toml"
        p.write_text("[memory]\nenabled = true\n", encoding="utf-8")
        limits = load_gate_limits(p)
        assert limits.enabled is True
        assert limits.cost_limit_usd == 1.0
        assert limits.wall_clock_seconds == 3600.0
        assert limits.cost_enabled and limits.wall_enabled

    def test_reads_thresholds_from_toml(self, tmp_path):
        p = tmp_path / "slime.toml"
        p.write_text(TOML_SECTION, encoding="utf-8")
        limits = load_gate_limits(p)
        assert limits.cost_limit_usd == 0.25
        assert limits.wall_clock_seconds == 30.0

    def test_missing_file_uses_defaults(self, tmp_path):
        limits = load_gate_limits(tmp_path / "nope.toml")
        assert limits.cost_limit_usd == 1.0 and limits.wall_clock_seconds == 3600.0

    def test_zero_limit_disables_only_that_gate(self, tmp_path):
        p = tmp_path / "slime.toml"
        p.write_text("[swarm_gates]\ncost_limit_usd = 0\nwall_clock_seconds = 60\n",
                     encoding="utf-8")
        limits = load_gate_limits(p)
        assert limits.cost_enabled is False
        assert limits.wall_enabled is True

    def test_enabled_false_disables_both_gates(self, tmp_path):
        p = tmp_path / "slime.toml"
        p.write_text("[swarm_gates]\nenabled = false\ncost_limit_usd = 5\nwall_clock_seconds = 5\n",
                     encoding="utf-8")
        limits = load_gate_limits(p)
        assert limits.cost_enabled is False and limits.wall_enabled is False

    def test_invalid_value_falls_back_to_default(self, tmp_path):
        p = tmp_path / "slime.toml"
        p.write_text('[swarm_gates]\ncost_limit_usd = "abc"\n', encoding="utf-8")
        assert load_gate_limits(p).cost_limit_usd == 1.0

    def test_shipped_slime_toml_has_section(self):
        """仓库自带的 slime.toml 必须真的带这一段（否则"可配置"只是默认值巧合）"""
        from core.budget import _TOML_PATH
        sec = _read_toml_section(_TOML_PATH, "swarm_gates")
        assert "cost_limit_usd" in sec and "wall_clock_seconds" in sec, sec
        limits = load_gate_limits()
        assert limits.cost_enabled and limits.wall_enabled
        assert limits.cost_limit_usd > 0 and limits.wall_clock_seconds > 0


class TestPricingResolution:
    """取价：读得到才算（provider 存值价 > 自定义定价表 > 仓库快照），读不到 = None"""

    def test_normalize_model_id(self):
        assert normalize_model_id("~deepseek/DeepSeek-Flash") == "deepseek-flash"
        assert normalize_model_id("") == ""

    def test_provider_stored_price(self):
        cfg = {"model": "deepseek-flash", "price_in_usd": 0.3, "price_out_usd": 1.2}
        price = resolve_price("deepseek-flash", cfg, _limits())
        assert price is not None
        assert (price.price_in, price.price_out) == (0.3, 1.2)
        assert "存值价" in price.source

    def test_provider_models_entry_matched_by_id(self):
        cfg = {
            "model": "b",
            "models": [
                {"id": "a", "price_in_usd": 9.0, "price_out_usd": 9.0},
                {"id": "b", "price_in_usd": 0.5, "price_out_usd": 1.5},
            ],
        }
        price = resolve_price("b", cfg, _limits())
        assert (price.price_in, price.price_out) == (0.5, 1.5)

    def test_zero_price_is_free_not_unpriced(self):
        """0 = 免费（有效价），缺失 = 未定价 —— 两者绝不可合并"""
        cfg = {"model": "local-model", "price_in_usd": 0, "price_out_usd": 0}
        price = resolve_price("local-model", cfg, _limits())
        assert price is not None and price.price_in == 0.0 and price.price_out == 0.0

    def test_partial_price_is_unpriced(self, tmp_path):
        cfg = {"model": "zz-no-such-model", "price_in_usd": 0.3}
        limits = _limits(pricing_file=str(tmp_path / "empty.json"))
        (tmp_path / "empty.json").write_text('{"models": {}}', encoding="utf-8")
        with patch("core.budget._PRICING_JSON_PATH", tmp_path / "absent.json"), \
             patch("core.budget._snapshot_table", return_value={}):
            assert resolve_price("zz-no-such-model", cfg, limits) is None

    def test_pricing_file_beats_provider_stored(self, tmp_path):
        table = tmp_path / "pricing.json"
        table.write_text(json.dumps({"models": {"m": {"price_in_usd": 7, "price_out_usd": 8}}}),
                         encoding="utf-8")
        cfg = {"model": "m", "price_in_usd": 0.1, "price_out_usd": 0.2}
        price = resolve_price("m", cfg, _limits(pricing_file=str(table)))
        assert (price.price_in, price.price_out) == (7.0, 8.0)
        assert "自定义定价表" in price.source

    def test_pricing_file_alt_key_names(self, tmp_path):
        table = tmp_path / "pricing.json"
        table.write_text('{"m2": {"price_in": 1.5, "price_out": 2.5}}', encoding="utf-8")
        price = resolve_price("m2", {}, _limits(pricing_file=str(table)))
        assert (price.price_in, price.price_out) == (1.5, 2.5)

    def test_repo_snapshot_gives_real_price_without_inventing(self):
        """仓库自带价格快照必须能被解析出真实价（Python 侧没有自己的价目表）"""
        price = resolve_price("deepseek-flash", {}, _limits())
        assert price is not None, "仓库快照里应有 deepseek-flash 的价"
        assert price.price_in > 0 and price.price_out > 0
        assert "快照" in price.source

    def test_snapshot_prefix_must_stay_on_token_boundary(self):
        """`glm-4.6x` 不是 `glm-4.6`（对齐 TS findSnapshotPricing 的 token 边界规则）"""
        assert resolve_price("glm-4.6x", {}, _limits()) is None

    def test_unknown_model_is_unpriced(self):
        assert resolve_price("zz-totally-unknown-model-12345", {}, _limits()) is None

    def test_snapshot_parser_tiers_and_free(self, tmp_path):
        snap = tmp_path / "pricing-snapshot.ts"
        snap.write_text(
            'export const PRICING_SNAPSHOT: PricingSnapshotEntry[] = [\n'
            '  { id: "free-model", vendor: "x", priceIn: 0, priceOut: 0, source: "litellm" },\n'
            '  { id: "tiered-model", vendor: "y", priceIn: 3, priceOut: 15, '
            'contextTiers: [{ fromInputTokens: 200000, prompt: 6, completion: 22.5 }], source: "litellm" },\n'
            '];\n',
            encoding="utf-8",
        )
        table = _snapshot_table(snap)
        assert table["free-model"].price_in == 0.0
        assert table["tiered-model"].tiered is True
        assert table["tiered-model"].price_out == 15.0


class TestCostGate:
    """花费闸：按 provider 定价折算 token → 超阈值即触发（带金额归因）"""

    def test_cost_trip_attribution(self):
        budget = _priced_budget(cost_limit=1.0, price_in=1.0, price_out=1.0)
        budget.start()
        budget.record_round(prompt_tokens=1_000_000, completion_tokens=0)
        trip = budget.check()
        assert trip is not None and trip.gate == GATE_COST
        assert "花费超限终止" in trip.reason
        assert "$1.0000" in trip.reason and "上限 $1" in trip.reason
        assert "1000000 输入" in trip.reason
        assert "估算" not in trip.reason

    def test_no_trip_below_limit(self):
        budget = _priced_budget(cost_limit=1.0)
        budget.start()
        budget.record_round(prompt_tokens=1000, completion_tokens=1000)
        assert budget.check() is None

    def test_estimated_tokens_marked_in_reason(self):
        budget = _priced_budget(cost_limit=0.0001, price_in=1.0, price_out=1.0)
        budget.start()
        budget.record_round(prompt_text="x" * 3000, reply_text="y" * 3000)
        trip = budget.cost_trip()
        assert trip is not None
        assert "本地估算" in trip.reason
        assert budget.estimated is True

    def test_unpriced_model_disables_cost_gate_with_warning(self):
        with patch("core.budget.resolve_price", return_value=None):
            budget = SubtaskBudget(
                model="zz-unpriced", provider_cfg={"model": "zz-unpriced"},
                limits=_limits(cost=0.000001, wall=3600.0),
            )
        budget.start()
        budget.record_round(prompt_tokens=10_000_000, completion_tokens=10_000_000)
        assert budget.cost_tracking is False
        assert budget.check() is None, "读不到定价 → 花费闸禁用，绝不能凭空折算"
        assert "禁用" in budget.cost_disabled_reason and "告警" in budget.cost_disabled_reason
        assert "读不到定价" in budget.cost_disabled_reason
        assert budget.spent_usd == 0.0

    def test_zero_cost_limit_disables_gate(self):
        budget = _priced_budget(cost_limit=0.0)
        budget.start()
        budget.record_round(prompt_tokens=10_000_000, completion_tokens=10_000_000)
        assert budget.cost_tracking is False and budget.cost_trip() is None

    def test_enabled_false_disables_cost_gate(self):
        budget = SubtaskBudget(
            model="m", provider_cfg={"model": "m"},
            limits=_limits(cost=0.0001, wall=3600.0, enabled=False),
            pricing=PriceInfo(1.0, 1.0, "provider 存值价"),
        )
        budget.start()
        budget.record_round(prompt_tokens=1_000_000, completion_tokens=1_000_000)
        assert budget.check() is None

    def test_cost_reported_first_when_both_gates_exceeded(self):
        clock = {"t": 0.0}
        budget = _priced_budget(cost_limit=0.001, wall=1.0, clock=lambda: clock["t"])
        budget.start()
        clock["t"] = 10.0
        budget.record_round(prompt_tokens=100_000, completion_tokens=0)
        trip = budget.check()
        assert trip.gate == GATE_COST
        assert "墙钟亦超限" in trip.reason

    def test_price_describe_mentions_tiered_underestimate(self):
        price = PriceInfo(3.0, 15.0, "仓库价格快照", detail="claude-sonnet-4-5", tiered=True)
        assert "分档" in price.describe() and "低估" in price.describe()

    def test_cost_usd_matches_repo_unit(self):
        """口径 = USD / 1M tokens（与 core-ts computeRecordCost 一致）"""
        price = PriceInfo(0.3, 1.2, "provider 存值价")
        assert abs(price.cost_usd(1_000_000, 1_000_000) - 1.5) < 1e-9


class TestWallClockGate:
    """墙钟闸：从子任务开始计时（注入 clock），超阈值即触发（带耗时归因）"""

    def test_wall_trip_after_limit(self):
        clock = {"t": 100.0}
        budget = _priced_budget(cost_limit=1000.0, wall=60.0, clock=lambda: clock["t"])
        budget.start()
        clock["t"] = 100.0 + 61.5
        trip = budget.check()
        assert trip is not None and trip.gate == GATE_WALL
        assert "墙钟超限终止" in trip.reason
        assert "已耗时 61.5s" in trip.reason and "上限 60s" in trip.reason

    def test_no_trip_before_limit(self):
        clock = {"t": 0.0}
        budget = _priced_budget(cost_limit=1000.0, wall=60.0, clock=lambda: clock["t"])
        budget.start()
        clock["t"] = 59.9
        assert budget.check() is None
        assert 0 < budget.remaining_seconds() <= 0.2

    def test_remaining_seconds_none_when_wall_disabled(self):
        budget = _priced_budget(cost_limit=1.0, wall=0.0)
        budget.start()
        assert budget.remaining_seconds() is None
        assert budget.wall_trip() is None

    def test_wall_trip_force_for_interrupted_call(self):
        clock = {"t": 0.0}
        budget = _priced_budget(cost_limit=1000.0, wall=60.0, clock=lambda: clock["t"])
        budget.start()
        clock["t"] = 59.99
        assert budget.wall_trip() is None
        forced = budget.wall_trip(force=True)
        assert forced is not None and forced.gate == GATE_WALL

    def test_elapsed_seconds_zero_before_start(self):
        budget = _priced_budget(cost_limit=1.0)
        assert budget.elapsed_seconds == 0.0


def _make_executor(providers=None):
    providers = providers or {"p1": {"api_base": "http://x", "api_key": "k", "model": "m"}}
    main_agent = Agent(name="Main", role="main")
    return SwarmExecutor(providers, main_agent)


def _make_subtask(executor, description="子任务1"):
    plan = executor.orchestrator.create_plan(
        "task_test", "原始任务", [description], ["W1"], max_workers=1,
    )
    st = plan.subtasks[0]
    executor.bus.register(st.name)
    return "task_test", st


def _clock_budget_factory(clock: dict):
    """把 core.executor 里构造的 SubtaskBudget 换成可控假钟（墙钟测试用）"""
    from core.budget import SubtaskBudget as _Real

    def _factory(**kwargs):
        kwargs["clock"] = lambda: clock["t"]
        return _Real(**kwargs)

    return _factory


class TestExecutorGates:
    """接线：闸门触发必须**显式终止**（不再进入下一轮）并写清归因"""

    def test_cost_gate_terminates_with_attribution(self):
        providers = {"p1": {"api_base": "http://x", "api_key": "k", "model": "m",
                            "price_in_usd": 1.0, "price_out_usd": 1.0}}
        executor = _make_executor(providers)
        task_id, st = _make_subtask(executor)
        calls = {"n": 0}

        async def fake_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            kwargs["usage_sink"].update({"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000})
            return "还在做，没完成"

        with patch("core.executor.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=0.5, wall=3600.0)):
            asyncio.run(executor._worker_loop(task_id, st, MagicMock()))

        assert calls["n"] == 1, "花费超限后不得再调用模型（显式终止）"
        assert st.state == TaskState.FAILED
        assert "花费超限终止" in st.error
        assert "2000000" in st.error or "1000000 输入" in st.error

    def test_wall_clock_gate_starts_at_subtask_start(self):
        """墙钟从子任务开始计时：连 Worker 自身准备时间也计入（准备期就超限 → 一次模型都不调）"""
        executor = _make_executor()
        task_id, st = _make_subtask(executor)
        calls = {"n": 0}

        async def fake_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            return "不该被调用"

        with patch("core.executor.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=1.0, wall=0.05)):
            asyncio.run(executor._worker_loop(task_id, st, MagicMock()))

        assert calls["n"] == 0, "准备期已超墙钟 → 不得再发起模型调用"
        assert st.state == TaskState.FAILED
        assert "墙钟超限终止" in st.error and "已耗时" in st.error

    def test_wall_clock_gate_interrupts_in_flight_call(self):
        """墙钟闸必须能打断正在进行的模型调用（不是等它自己回来才检查）"""
        executor = _make_executor()
        task_id, st = _make_subtask(executor)
        clock = {"t": 0.0}
        calls = {"n": 0}

        async def slow_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            clock["t"] = 5.0          
            await asyncio.sleep(5)    
            return "永远不返回"

        with patch("core.executor.call_api_provider", side_effect=slow_call), \
             patch("core.executor.SubtaskBudget", _clock_budget_factory(clock)), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=1.0, wall=1.0)):
            asyncio.run(executor._worker_loop(task_id, st, MagicMock()))

        assert calls["n"] == 1
        assert st.state == TaskState.FAILED
        assert "墙钟超限终止" in st.error
        assert "已耗时 5.0s" in st.error and "上限 1s" in st.error

    def test_unpriced_provider_keeps_cost_gate_off_and_task_can_finish(self):
        executor = _make_executor({"p1": {"api_base": "http://x", "api_key": "k",
                                          "model": "zz-unpriced"}})
        task_id, st = _make_subtask(executor)

        async def fake_call(cfg, agent, message, history, **kwargs):
            return "完成了\n<DONE>"

        with patch("core.executor.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=0.000001, wall=3600.0)):
            asyncio.run(executor._worker_loop(task_id, st, MagicMock()))

        assert st.state == TaskState.DONE, "读不到定价只关花费闸，不得阻断任务"

    def test_round_gate_semantics_unchanged_with_gates_on(self):
        """硬约束回归：轮次耗尽未收到 <DONE> 一律 failed（三闸开启也不改这条）"""
        executor = _make_executor({"p1": {"api_base": "http://x", "api_key": "k",
                                          "model": "deepseek-flash"}})
        task_id, st = _make_subtask(executor)
        calls = {"n": 0}

        async def fake_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            return "还在处理中"

        with patch("core.executor.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits",
                   return_value=_limits(cost=1000.0, wall=3600.0)):
            asyncio.run(executor._worker_loop(task_id, st, MagicMock()))

        assert calls["n"] == MAX_ROUNDS
        assert st.state == TaskState.FAILED
        assert "未确认完成" in st.error and f"{MAX_ROUNDS} 轮上限" in st.error
        assert st.rounds == MAX_ROUNDS

    def test_done_still_wins_when_cost_within_limit(self):
        """花费闸只是闸门：<DONE> 且未超限 → 仍 done，不因新增闸门改变完成语义"""
        providers = {"p1": {"api_base": "http://x", "api_key": "k", "model": "m",
                            "price_in_usd": 1.0, "price_out_usd": 1.0}}
        executor = _make_executor(providers)
        task_id, st = _make_subtask(executor)

        async def fake_call(cfg, agent, message, history, **kwargs):
            kwargs["usage_sink"].update({"prompt_tokens": 100, "completion_tokens": 100})
            return "任务已完成\n<DONE>"

        with patch("core.executor.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=1.0, wall=3600.0)):
            asyncio.run(executor._worker_loop(task_id, st, MagicMock()))

        assert st.state == TaskState.DONE and "任务已完成" in st.result


class TestProcessWorkerGates:
    """多进程 Worker 路径同样有花费闸（否则只有协程模式受闸）"""

    def _worker_input(self, model="m", extra=None):
        cfg = {"api_base": "http://x", "api_key": "k", "model": model}
        cfg.update(extra or {})
        return {
            "task_id": "t1",
            "subtask_id": "s1",
            "subtask_name": "W1",
            "subtask_description": "写一段文字",
            "provider_key": "p1",
            "provider_config": cfg,
            "agent_config": {"max_context": 4096, "max_output": 2048},
        }

    def test_cost_gate_terminates_worker(self):
        from core.process_worker import _worker_main
        result_queue = _FakeQueue()
        calls = {"n": 0}

        async def fake_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            kwargs["usage_sink"].update({"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000})
            return "还在做"

        with patch("core.llm.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=0.5, wall=3600.0)):
            _worker_main(self._worker_input(extra={"price_in_usd": 1.0, "price_out_usd": 1.0}),
                         result_queue)

        out = result_queue.items[-1]
        assert calls["n"] == 1, "花费超限后不得再调用模型"
        assert out["state"] == "failed"
        assert "花费超限终止" in out["error"]

    def test_wall_clock_gate_terminates_worker(self):
        """多进程 Worker 也要有墙钟闸（准备期即超限 → 一次模型都不调）"""
        from core.process_worker import _worker_main
        result_queue = _FakeQueue()
        calls = {"n": 0}

        async def fake_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            return "不该被调用"

        with patch("core.llm.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=1.0, wall=0.05)):
            _worker_main(self._worker_input(), result_queue)

        out = result_queue.items[-1]
        assert calls["n"] == 0
        assert out["state"] == "failed"
        assert "墙钟超限终止" in out["error"]

    def test_round_gate_semantics_unchanged_in_worker(self):
        from core.process_worker import _worker_main, MAX_ROUNDS as WORKER_MAX_ROUNDS
        result_queue = _FakeQueue()
        calls = {"n": 0}

        async def fake_call(cfg, agent, message, history, **kwargs):
            calls["n"] += 1
            return "还在做"

        with patch("core.llm.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=1000.0, wall=3600.0)):
            _worker_main(self._worker_input(model="deepseek-flash"), result_queue)

        out = result_queue.items[-1]
        assert calls["n"] == WORKER_MAX_ROUNDS == MAX_ROUNDS
        assert out["state"] == "failed"
        assert "未确认完成" in out["error"] and f"{WORKER_MAX_ROUNDS} 轮上限" in out["error"]

    def test_done_marker_still_succeeds_in_worker(self):
        from core.process_worker import _worker_main
        result_queue = _FakeQueue()

        async def fake_call(cfg, agent, message, history, **kwargs):
            return "完成\n<DONE>"

        with patch("core.llm.call_api_provider", side_effect=fake_call), \
             patch("core.budget.load_gate_limits", return_value=_limits(cost=0.000001, wall=3600.0)):
            _worker_main(self._worker_input(model="zz-unpriced"), result_queue)

        out = result_queue.items[-1]
        assert out["state"] == "done" and "<DONE>" not in out["result"]
