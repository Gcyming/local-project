"""
SILAM 权重进程级缓存回归测试

覆盖三件事：
1. 连续构造 N 个 Agent，304MB 蒸馏权重 npz 只解码一次；
2. 缓存只覆盖权重数组，引擎本体与可变状态逐一独立，互不污染；
3. 无 npz / npz 键缺失或形状不符时，回退随机初始化这条路径仍然可用。
"""

import threading
import time

import numpy as np
import pytest

import core.agent as agent_mod
from core.agent import Agent, build_silam_engine, backbone_npz_candidates


REAL_NPZ = backbone_npz_candidates()[0]


class _CountingLoad:
    """统计 np.load 的调用次数（临时替换全局 np.load，finally 里还原）。"""

    def __init__(self):
        self.calls = []

    def __enter__(self):
        self._real = np.load
        calls = self.calls

        def _load(*args, **kwargs):
            target = args[0] if args else kwargs.get("file")
            calls.append(str(target))
            return self._real(*args, **kwargs)

        np.load = _load
        return self

    def __exit__(self, *exc):
        np.load = self._real
        return False

    def npz_calls(self):
        return [c for c in self.calls if c.endswith(".npz")]


class TestWeightDecodeHappensOnce:
    """缓存的核心收益：npz 只解压一次。"""

    def setup_method(self):
        agent_mod._SILAM_WEIGHT_CACHE.clear()

    def test_many_agents_decode_npz_once(self):
        with _CountingLoad() as counter:
            agents = [Agent(name=f"a{i}", role="测试") for i in range(4)]

        assert len(agents) == 4
        assert counter.npz_calls() == [str(REAL_NPZ)]

    def test_llm_fallback_engine_shares_the_same_cache(self):
        import core.llm as llm_mod

        llm_mod._silam_engine = None
        llm_mod._silam_initialized = False
        with _CountingLoad() as counter:
            Agent(name="a0", role="测试")
            first = llm_mod._init_silam_engine()
            second = llm_mod._init_silam_engine()

        assert first is not None
        assert first is second
        assert counter.npz_calls() == [str(REAL_NPZ)]

    def test_cache_holds_one_entry_after_many_builds(self):
        with _CountingLoad():
            for _ in range(3):
                build_silam_engine()

        assert list(agent_mod._SILAM_WEIGHT_CACHE) == [str(REAL_NPZ)]
        arrays = agent_mod._SILAM_WEIGHT_CACHE[str(REAL_NPZ)]
        assert sum(v.size for v in arrays.values()) == 81_305_600

    def test_cached_build_beats_a_fresh_npz_decode(self):
        build_silam_engine()

        start = time.perf_counter()
        build_silam_engine()
        cached = time.perf_counter() - start

        start = time.perf_counter()
        with np.load(str(REAL_NPZ)) as data:
            fresh = {k: data[k] for k in data.files}
        decode = time.perf_counter() - start

        assert sum(v.size for v in fresh.values()) == 81_305_600
        assert cached < decode / 2, (cached, decode)


class TestEnginesDoNotShareState:
    """缓存的是权重，不是引擎：两个 Agent 的可变状态必须互不可见。"""

    def setup_method(self):
        self.a1 = Agent(name="one", role="测试")
        self.a2 = Agent(name="two", role="测试")

    def test_engines_are_distinct_objects(self):
        assert self.a1.silam_engine is not None
        assert self.a1.silam_engine is not self.a2.silam_engine
        assert self.a1.silam_engine.backbone is not self.a2.silam_engine.backbone
        assert self.a1.silam_engine.backbone.w2 is not self.a2.silam_engine.backbone.w2
        assert self.a1.silam_engine.dendrites is not self.a2.silam_engine.dendrites
        assert self.a1.silam_engine.rng is not self.a2.silam_engine.rng

    def test_weights_are_equal_but_not_aliased(self):
        w1 = self.a1.silam_engine.backbone.w2
        w2 = self.a2.silam_engine.backbone.w2
        cached = agent_mod._SILAM_WEIGHT_CACHE[str(REAL_NPZ)]["bb_w2"]

        assert np.array_equal(w1, w2)
        assert np.array_equal(w1, cached)
        assert w1 is not w2
        assert w1 is not cached

    def test_in_place_adapt_on_one_agent_leaves_the_other_untouched(self):
        e1, e2 = self.a1.silam_engine, self.a2.silam_engine
        before2 = e2.encoder.w3.copy()
        before_cache = agent_mod._SILAM_WEIGHT_CACHE[str(REAL_NPZ)]["enc_w3"]

        e1.encoder.w3 += 1.0

        assert not np.array_equal(e1.encoder.w3, before_cache)
        assert np.array_equal(e2.encoder.w3, before2)
        assert np.array_equal(agent_mod._SILAM_WEIGHT_CACHE[str(REAL_NPZ)]["enc_w3"],
                              before_cache)

    def test_lifecycle_state_is_per_agent(self):
        e1, e2 = self.a1.silam_engine, self.a2.silam_engine

        assert e1.step_count == 0 and e2.step_count == 0
        e1.step_count = 77
        e1.pain_reservoir = 3.5
        e1._mem_register("只有 one 记得")

        assert e2.step_count == 0
        assert e2.pain_reservoir == 0.0
        assert e2._mem_texts == []

    def test_forward_on_one_agent_advances_only_its_own_step_count(self):
        e1, e2 = self.a1.silam_engine, self.a2.silam_engine

        e1.forward("只给 one 的一句话")

        assert e1.step_count == 1
        assert e2.step_count == 0

    def test_two_agents_forked_from_one_parent_stay_independent(self):
        parent = Agent(name="root", role="测试")
        child_a = Agent(name="ca", role="测试", parent_id=parent.id)
        child_b = Agent(name="cb", role="测试", parent_id=parent.id)

        child_a.silam_engine.step_count = 5
        child_a.silam_engine.encoder.w3 += 2.0

        assert child_b.silam_engine.step_count == 0
        assert parent.silam_engine.step_count == 0
        assert child_a.silam_engine is not child_b.silam_engine
        assert not np.array_equal(child_b.silam_engine.encoder.w3,
                                  child_a.silam_engine.encoder.w3)


class TestConcurrentConstruction:
    """仓库是异步 + 多线程混用：并发构造必须无竞态。"""

    def setup_method(self):
        self.results = []
        self.errors = []

    def _worker(self, idx):
        try:
            self.results.append((idx, Agent(name=f"t{idx}", role="测试")))
        except Exception as exc:  # noqa: BLE001
            self.errors.append(exc)

    def test_four_threads_get_correct_distinct_engines(self):
        threads = [threading.Thread(target=self._worker, args=(i,))
                   for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert self.errors == []
        assert len(self.results) == 4

        engines = [a.silam_engine for _, a in sorted(self.results)]
        cached = agent_mod._SILAM_WEIGHT_CACHE[str(REAL_NPZ)]["bb_w2"]
        for eng in engines:
            assert eng is not None
            assert np.array_equal(eng.backbone.w2, cached)
        assert len({id(e) for e in engines}) == 4


class TestRandomInitFallback:
    """没有可用权重时，必须仍能随机初始化出一条可用的 80M 宽体。"""

    def test_missing_npz_builds_random_engine(self, tmp_path):
        engine, cfg, backbone_path, report = build_silam_engine(
            [tmp_path / "absent.npz"])

        assert backbone_path is None
        assert report == {"loaded": [], "skipped": [], "total": 0}
        assert engine.backbone.w2.shape == (cfg.trunk_hidden, cfg.trunk_hidden)
        assert engine.backbone.w1.shape == (cfg.state_dim, cfg.trunk_hidden)
        assert engine.encoder.w1.shape == (cfg.enc_dim_in, cfg.enc_dim_hidden)
        assert float(np.abs(engine.backbone.w2).sum()) > 0.0
        engine.forward("随机初始化也要能跑")

    def test_two_random_engines_stay_separate_objects(self, tmp_path):
        missing = [tmp_path / "absent.npz"]
        first, _, _, _ = build_silam_engine(missing)
        second, _, _, _ = build_silam_engine(missing)

        assert first is not second
        assert first.backbone.w2 is not second.backbone.w2
        assert first.dendrites is not second.dendrites

        first.step_count = 12
        assert second.step_count == 0

    def test_partial_npz_reports_every_key(self, tmp_path):
        part = tmp_path / "partial.npz"
        np.savez(part, bb_w2=np.ones((4, 4), dtype=np.float32),
                 enc_w1=np.ones((8, 8), dtype=np.float32))

        engine, _, backbone_path, report = build_silam_engine([part])

        assert backbone_path == part
        assert report["total"] == 9
        assert report["loaded"] == []
        reasons = {k: reason for k, reason, _ in report["skipped"]}
        assert reasons["bb_w2"] == "形状不匹配"
        assert reasons["enc_w1"] == "形状不匹配"
        assert reasons["bb_w1"] == "缺失"
        assert engine.backbone.w2.shape == (4480, 4480)
        assert engine.encoder.w1.shape == (256, 256)

    def test_agent_without_weights_still_constructs(self, tmp_path):
        original = agent_mod.backbone_npz_candidates
        agent_mod.backbone_npz_candidates = lambda: [tmp_path / "absent.npz"]
        try:
            agent = Agent(name="noweight", role="测试")
        finally:
            agent_mod.backbone_npz_candidates = original

        assert agent.silam_engine is not None
        assert agent.silam_engine.step_count == 0


class TestLoadedWeightsAreReal:
    """跳过随机初始化之后，装进来的必须仍然是 npz 里的那份权重。"""

    def setup_method(self):
        self.engine, _, self.backbone_path, self.report = build_silam_engine()

    def test_report_lists_every_contract_key(self):
        assert self.backbone_path == REAL_NPZ
        assert self.report["loaded"] == [
            "enc_w1", "enc_w2", "enc_w3",
            "bb_w1", "bb_w2", "bb_w3", "bb_w4", "bb_w5", "bb_w6"]
        assert self.report["skipped"] == []
        assert self.report["total"] == 9

    def test_engine_weights_match_the_npz(self):
        with np.load(str(REAL_NPZ)) as data:
            assert np.array_equal(self.engine.encoder.w1, data["enc_w1"])
            assert np.array_equal(self.engine.encoder.w3, data["enc_w3"])
            assert np.array_equal(self.engine.backbone.w1, data["bb_w1"])
            assert np.array_equal(self.engine.backbone.w2, data["bb_w2"])

    def test_xavier_is_restored_after_construction(self):
        import importlib
        import sys
        from pathlib import Path

        stage = str(Path(agent_mod.__file__).resolve().parent.parent / "_model_stage")
        if stage not in sys.path:
            sys.path.insert(0, stage)
        pkg = "silam_" + "core"
        backbone_mod = importlib.import_module(pkg + ".backbone")
        encoder_mod = importlib.import_module(pkg + ".encoder")

        def _is_original(fn):
            return (fn.__module__.endswith(("core.backbone", "core.encoder"))
                    and getattr(fn, "__name__", "") == "_xavier")

        assert _is_original(backbone_mod._xavier)
        assert _is_original(encoder_mod._xavier)
