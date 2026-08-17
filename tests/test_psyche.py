"""slime 情绪 + 行为模式模块测试（L2/L3 心性架构）"""


class TestEmotionalState:
    def test_init_defaults(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        assert e.valence == 0.0
        assert e.arousal == 0.3
        assert e.dominance == 0.5
        assert e.mood == "neutral"
        assert e.relational_depth == 0.0

    def test_update_success_raises_valence(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        for _ in range(5):
            e.update(success=True)
        assert e.valence > 0.0
        assert e.relational_depth > 0.0

    def test_update_failure_triggers_angry(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        for _ in range(5):
            e.update(success=False)
        assert e.valence < 0.0
        # 连续失败 ≥3 → 硬触发 angry
        assert e.mood == "angry"

    def test_praise_hard_trigger(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        e.update(success=False, user_sentiment=-0.8, praise=True)
        # praise 覆盖 user_sentiment 通道，硬触发 happy
        assert e.mood == "happy"
        assert e.valence == 0.0  # -0.15(task_fail) + 0.15(praise)，sentiment 被跳过

    def test_violation_hard_trigger(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        e.update(success=True, violation=True)
        assert e.mood == "disgusted"

    def test_interrupt_zero_semantics(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        v, a, d, r = e.valence, e.arousal, e.dominance, e.relational_depth
        e.update(success=False, failure_type="interrupt")
        assert e.valence == v
        assert e.arousal == a
        assert e.dominance == d
        assert e.relational_depth == r
        assert e.consecutive_failures == 0

    def test_decay_returns_to_baseline(self):
        from core.emotion import EmotionalState
        from datetime import datetime, timezone, timedelta
        e = EmotionalState()
        e.valence = 0.8
        e.arousal = 0.9
        e.dominance = 0.9
        e.mood = "happy"  # half_life 35h
        e.last_updated = (datetime.now(timezone.utc) - timedelta(hours=35)).isoformat()
        e.decay()
        # factor = 0.5^(35/35) = 0.5
        assert abs(e.valence - 0.4) < 0.001
        assert abs(e.arousal - 0.6) < 0.001
        assert abs(e.dominance - 0.7) < 0.001

    def test_top_k_for_mood(self):
        from core.emotion import top_k_for_mood
        assert top_k_for_mood("happy") == 10
        assert top_k_for_mood("angry") == 3
        assert top_k_for_mood("frustrated") == 5
        assert top_k_for_mood("unknown") == 5

    def test_novelty_positive_triggers_interested(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        # success(+0.08) + novelty(+0.03) → valence 0.11 > 0.1，硬触发 interested
        e.update(success=True, novelty=True)
        assert e.mood == "interested"

    def test_hysteresis_no_flip_near_boundary(self):
        from core.emotion import EmotionalState, MOODS
        e = EmotionalState()
        e.update(success=True, praise=True)
        assert e.mood == "happy"
        h, i = MOODS["happy"], MOODS["interested"]
        # PAD 移到 happy↔interested 中点略偏 interested：切换收益 < 0.05 → 保持 happy
        eps = 0.01
        e.valence = (h["valence"] + i["valence"]) / 2 - eps
        e.arousal = (h["arousal"] + i["arousal"]) / 2 + eps
        e.dominance = (h["dominance"] + i["dominance"]) / 2 - eps
        e._resolve_mood()
        assert e.mood == "happy"
        # 大偏移（直接到 interested 目标）→ 切换收益 ≥ 0.05 → 切到 interested
        e.valence = i["valence"]
        e.arousal = i["arousal"]
        e.dominance = i["dominance"]
        e._resolve_mood()
        assert e.mood == "interested"

    def test_nearest_mood_reaches_all_eight(self):
        from core.emotion import EmotionalState, MOODS
        e = EmotionalState()
        # PAD 精确落在每个 mood 目标坐标 → 最近邻应回到该 mood（8 种均可被触发）
        for name, target in MOODS.items():
            e.valence = target["valence"]
            e.arousal = target["arousal"]
            e.dominance = target["dominance"]
            assert e._nearest_mood() == name, f"{name} 不可达"

    def test_to_prompt_nonempty(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        assert e.to_prompt()

    def test_roundtrip(self):
        from core.emotion import EmotionalState
        e = EmotionalState()
        e.update(success=True)
        data = e.to_dict()
        e2 = EmotionalState.from_dict(data)
        assert e2.valence == e.valence
        assert e2.dominance == e.dominance
        assert e2.mood == e.mood


class TestBehaviorStore:
    def test_reinforce_new(self):
        from core.behavior import BehaviorStore
        bs = BehaviorStore()
        p = bs.reinforce("代码审查", ["读代码", "查边界", "给建议"])
        assert len(bs.patterns) == 1
        assert p.confidence == 0.3
        assert p.usage_count == 1

    def test_reinforce_existing_raises_confidence(self):
        from core.behavior import BehaviorStore
        bs = BehaviorStore()
        bs.reinforce("代码审查", ["读代码"])
        p = bs.reinforce("代码审查", ["读代码", "查边界"])
        assert len(bs.patterns) == 1
        assert p.usage_count == 2
        assert p.confidence > 0.3

    def test_to_prompt_filters_low_confidence(self):
        from core.behavior import BehaviorStore
        bs = BehaviorStore()
        bs.reinforce("低置信模式", ["a"])
        # 低置信度（0.3）不应注入
        assert bs.to_prompt() == ""

    def test_to_prompt_includes_stable(self):
        from core.behavior import BehaviorStore
        bs = BehaviorStore()
        p = bs.reinforce("代码审查", ["读代码", "查边界"])
        p.confidence = 0.8
        assert "代码审查" in bs.to_prompt()

    def test_decay_weakens_stale(self):
        from core.behavior import BehaviorStore
        from datetime import datetime, timezone, timedelta
        bs = BehaviorStore()
        p = bs.reinforce("代码审查", ["读代码"])
        p.confidence = 0.8
        p.last_reinforced = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        bs.decay()
        assert p.confidence < 0.8

    def test_roundtrip(self):
        from core.behavior import BehaviorStore
        bs = BehaviorStore()
        bs.reinforce("代码审查", ["读代码", "查边界"])
        data = bs.to_dict()
        bs2 = BehaviorStore.from_dict(data)
        assert len(bs2.patterns) == 1
        assert bs2.patterns[0].scenario == "代码审查"


class TestNoveltyDetection:
    """novelty 信号检测：bigrams 纯函数 + 短消息守卫（Intelligence 11.2.4.6）"""

    def test_bigrams_short_input(self):
        from core.novelty import bigrams
        assert bigrams("") == set()      # 空串
        assert bigrams("好") == set()     # 单字：len < 2 → 空集合

    def test_bigrams_normal(self):
        from core.novelty import bigrams
        assert bigrams("ab") == {"ab"}
        assert bigrams("abc") == {"ab", "bc"}
        assert bigrams("帮我写") == {"帮我", "我写"}  # 中文 bigram

    def test_bigrams_lowercase(self):
        from core.novelty import bigrams
        assert bigrams("Hello") == bigrams("hello")

    def test_guard_short_confirmation(self):
        from core.novelty import is_short_confirmation
        assert is_short_confirmation("好") is True     # 单字确认语
        assert is_short_confirmation("好的") is True    # 双字确认语
        assert is_short_confirmation("帮我写") is False  # 3 字符，非短确认语

    def test_detect_novelty_guard_short_circuit(self):
        """入口守卫：空串/单字/双字确认语在 _detect_novelty 入口提前 return False，
        不触达 history_load（DB 查询），避免每次短确认语都触发 novelty 叠加。"""
        from unittest.mock import patch
        from slime_server import _detect_novelty

        def fail_if_called(*a, **k):
            raise AssertionError("守卫应拦截，不应触达 history_load")

        with patch("slime_server.history_load", fail_if_called):
            for msg in ("", "好", "好的"):
                assert _detect_novelty("any_agent", msg) is False


# ── A-008: Swarm Worker 心性继承 ────────────────────────────


class TestWorkerPsycheInheritance:
    """Worker 分身继承主 Agent 记忆与心性（不再是无记忆白板）"""

    def test_retrieve_psyche_uses_memory_agent_id(self):
        """memory_agent_id 覆盖时以主 Agent id 检索记忆"""
        from core.agent import Agent
        from unittest.mock import patch, MagicMock
        from core.llm import _retrieve_psyche_context
        main = Agent(name="Main", role="主")
        worker = Agent(name="W", role="分身")
        fake_mem = MagicMock()
        fake_mem.summary.return_value = "主记忆摘要内容"
        fake_mem.get_facts.return_value = []
        with patch("core.memory.load_memory", return_value=fake_mem) as m:
            ctx = _retrieve_psyche_context(worker, "任务", memory_agent_id=main.id)
            assert m.call_args[0][0] == main.id  # 以主 Agent id 检索
        assert "主记忆摘要内容" in ctx

    def test_retrieve_psyche_defaults_to_own_id(self):
        """未覆盖时仍以自身 id 检索（原有行为不退化）"""
        from core.agent import Agent
        from unittest.mock import patch, MagicMock
        from core.llm import _retrieve_psyche_context
        agent = Agent(name="A", role="r")
        fake_mem = MagicMock()
        fake_mem.summary.return_value = "自己的记忆"
        fake_mem.get_facts.return_value = []
        with patch("core.memory.load_memory", return_value=fake_mem) as m:
            _retrieve_psyche_context(agent, "任务")
            assert m.call_args[0][0] == agent.id

    def test_restore_psyche_snapshot(self):
        """多进程 Worker：从 agent_config 恢复 persona/emotion/behavior/lifecycle"""
        from core.agent import Agent
        from core.process_worker import _restore_psyche_snapshot
        main = Agent(name="Main", role="主")
        main.persona.traits = [{"name": "谨慎", "weight": 0.8}]
        main.emotion.update(success=True)
        main.behavior.reinforce("code_review", ["先读代码", "再给建议"])
        from core.evolve import AgentLifecycle
        main.lifecycle = AgentLifecycle.SPECIALIZING

        worker = Agent(name="W", role="分身")
        _restore_psyche_snapshot(worker, {
            "persona": main.persona.to_dict(),
            "emotion": main.emotion.to_dict(),
            "behavior": main.behavior.to_dict(),
            "lifecycle": main.lifecycle.value,
            "context_config": dict(main.context_config),
        })
        trait_names = [t["name"] for t in worker.persona.traits if isinstance(t, dict)]
        assert "谨慎" in trait_names
        assert worker.lifecycle == AgentLifecycle.SPECIALIZING
        assert worker.emotion.valence == main.emotion.valence
        assert len(worker.behavior.patterns) == 1

    def test_restore_psyche_snapshot_partial_safe(self):
        """空/部分 agent_config 不崩溃（兼容旧调用方）"""
        from core.agent import Agent
        from core.process_worker import _restore_psyche_snapshot
        worker = Agent(name="W", role="分身")
        _restore_psyche_snapshot(worker, {})
        _restore_psyche_snapshot(worker, {"lifecycle": "wise"})
        from core.evolve import AgentLifecycle
        assert worker.lifecycle == AgentLifecycle.WISE
        _restore_psyche_snapshot(worker, {"lifecycle": "not-a-stage"})  # 非法值兜底
        assert worker.lifecycle == AgentLifecycle.WISE  # 保持原值不崩溃
