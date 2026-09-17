"""SILAMEngine：全生命周期编排（4A 主线）。

一次 forward = 一"步"生命活动：
  感觉 → 升维 → 检索 → 命中强化/未命中生长 → 情绪更新 →
  好奇心分裂/回顾/冥想 → 修剪/蒸馏/核爆 → 输出动作向量

对应 silam-sigma.md §2、§3、§4、§5、§8.2。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .affect import Affect, AffectState, EPC_INTERVAL
from .backbone import Backbone
from .config import SilamConfig
from .decoder import ActionDecoder
from .dendrites import Dendrites, SILENT_PRUNE_STEPS
from .encoder import Encoder
from .evolution import (hierarchical_distill,
                        nuclear_reorganization, prune_silent_nodes,
                        replay_review)
from .selection import Selector

RECOVERY_SPLIT_RATE = 0.10      # §5.2 核爆恢复期分裂速率降至 10%
RECOVERY_STEPS = 500
SATURATION_STREAK_TRIGGER = 50  # §4.2 回顾模式触发
DESIRE_FAIL_CYCLES_TO_DETONATE = 3


@dataclass
class StepReport:
    """§8.2 响应负载 + 裸数据诊断（§11A 状态行的数据源）。"""

    step: int
    activated_nodes: list[int]
    grew_node_idx: int | None
    tool_call: dict | None
    code: str
    thought_vector: list[float]
    new_fear: float
    new_desire: float
    n_nodes: int
    max_nodes: int
    events: dict = field(default_factory=dict)
    novelty: float = 0.5   # 里程碑 C：1−检索最大相似度（语言核条件槽位 [1]）


class SILAMEngine:
    def __init__(self, cfg: SilamConfig | None = None,
                 seed: int = 42) -> None:
        self.cfg = cfg or SilamConfig()
        self.rng = np.random.default_rng(seed)
        # ---- 三层物理结构 ----
        self.encoder = Encoder(self.cfg, self.rng)
        self.backbone = Backbone(self.cfg, self.rng)
        self.dendrites = Dendrites(self.cfg, self.rng)
        self.decoder = ActionDecoder(action_dim=64)
        self.selector = Selector(self.cfg, self.rng, self.dendrites)
        self.affect = Affect(self.cfg.fear_weights, self.cfg.desire_weights)
        # 先天偏好提取（mock 阶段：主干输出空间的主方向）
        self._init_trunk_centroids()
        # ---- 生命状态 ----
        self.step_count = 0
        self.affect_state = AffectState()
        self.pain_reservoir = 0.0       # Internal_Pain 库存（衰减制）
        self.desire_fail_streak = 0     # 连续渴望失败周期数
        self.recovery_until = -1        # 核爆恢复期截止步
        self.saturation_streak = 0      # 赫布强化量连续低落计数（回顾模式）
        self.last_hebbian_delta = 0.0
        self.review_cooldown_until = -1
        self.epc_cycle_pain = 0.0
        self.chronic_damage = 0.0
        self._last_hit_idx: int | None = None
        # 动作投影（key→64 维动作向量；先天固定，非学习对象）
        self.action_proj = self.rng.normal(
            0, 1 / np.sqrt(self.cfg.trunk_dim),
            size=(self.cfg.trunk_dim, 64)).astype(np.float32)

    # ------------------------------------------------------------------
    def _init_trunk_centroids(self) -> None:
        """§4 阶段一步骤5 的最小实现：主干流形主方向作为先天质心。"""
        probes = self.rng.normal(size=(64, self.cfg.state_dim)).astype(np.float32)
        outs = np.stack([self.backbone.forward(p) for p in probes])
        c = outs / np.maximum(np.linalg.norm(outs, axis=1, keepdims=True), 1e-9)
        u, s, vt = np.linalg.svd(c, full_matrices=False)
        comps = vt[:8].astype(np.float32)          # 前 8 主方向
        self.selector.set_trunk_centroids(comps)

    # ==================================================================
    def forward(self, state_text: str, fear_level: float | None = None,
                desire_level: float | None = None,
                latency_ratio: float = 0.0) -> StepReport:
        """一次生命活动。fear/desire 可由宿主(core-ts)外部注入覆盖。"""
        cfg = self.cfg
        self.step_count += 1
        step = self.step_count
        events: dict = {}

        # ---- 1-2. 感觉与升维 ----
        state = self.encoder.encode(state_text)
        key = self.backbone.forward(state)

        # ---- 3. 检索 ----
        ret = self.dendrites.retrieve(key)

        # ---- 4. 命中 → 赫布强化；未命中且恐惧高 → 生长 ----
        grew_idx: int | None = None
        activated: list[int] = []
        prediction_success = 0.0
        info_gain_proxy = 1.0 - float(ret.sims[0]) if ret.hit else 1.0
        if ret.hit:
            idx = int(ret.indices[0])
            grad = state.repeat(cfg.value_dim // cfg.state_dim)[: cfg.value_dim]
            self.last_hebbian_delta = self.dendrites.hebbian_reinforce(idx, grad)
            self.dendrites.mark_hit(idx, step)
            self._last_hit_idx = idx
            activated = [int(i) for i in ret.indices[:3]]
            if self.dendrites.dormant_flags[idx]:
                self.dendrites.dormant_activated(idx)   # 意外匹配激活休眠节点
                events["dormant_activated"] = idx
            # 饱和追踪（§4.2 触发条件）
            self.saturation_streak = (
                self.saturation_streak + 1
                if self.last_hebbian_delta < 1e-4 else 0)
            prediction_success = float(ret.sims[0])
            info_gain_proxy = max(0.0, 1.0 - prediction_success) * 0.5
        else:
            self.saturation_streak = 0
            fear_guess = self.affect.compute_fear(
                0.0, self.dendrites.forgotten_similarity(key),
                self._internal_pain())[0]
            if fear_guess > 0.3 and self.dendrites.n < cfg.max_nodes:
                grew_idx = self.dendrites.grow(key, self._make_value(state),
                                               fear_guess, step)
                self.selector.note_new_node()
                self.dendrites.survived_newborns += 1
        self.selector.tick_no_growth()

        # ---- 5. 情绪更新 ----
        forgotten_sim = self.dendrites.forgotten_similarity(key)
        fear, fr, fa = self.affect.compute_fear(
            float(ret.sims[0]) if ret.hit else 0.0,
            forgotten_sim, self._internal_pain())
        self.affect_state.fear_reactive, self.affect_state.fear_anticipatory = fr, fa
        desire = self.affect.compute_desire(info_gain_proxy, prediction_success
                                            if ret.hit else 0.0)
        if self.selector.steps_since_new_node > cfg.curiosity_interval * 2:
            desire = max(desire, 0.05)   # 内部自我刺激的最低激活水平
        if fear_level is not None:
            fear = float(min(max(fear_level, 0.0), 1.0))
        if desire_level is not None:
            desire = float(min(max(desire_level, 0.0), 1.0))
        self.affect_state.fear_total, self.affect_state.desire = fear, desire

        # ---- 6. 好奇心分裂（恢复期速率降至 10%）----
        in_recovery = step <= self.recovery_until
        if not in_recovery:
            split = self.selector.maybe_split(step, fear, key)
            if split is not None:
                events["split"] = split.kind
                if split.kind in {"normal", "dormant"}:
                    self.dendrites.survived_newborns += 1

        # ---- 7. 休眠观察期到期 → 静默删除 ----
        expired = self.dendrites.expired_dormants(step)
        if expired:
            self.dendrites.excise(expired)           # 不疼，不入遗忘缓冲
            events["dormant_expired"] = len(expired)

        # ---- 8. 周期性修剪扫描（硬伤害）----
        if step % cfg.prune_interval == 0:
            ev = prune_silent_nodes(self.dendrites, step, SILENT_PRUNE_STEPS)
            if ev.pruned:
                self.pain_reservoir += ev.pain_spikes
                events["pruned"] = len(ev.pruned)

        # ---- 9. 分层概念蒸馏 ----
        if self.dendrites.n > int(cfg.max_nodes * cfg.distill_threshold):
            ev = hierarchical_distill(self.dendrites, cfg)
            events["distilled_pairs"] = ev.distilled_pairs

        # ---- 10. EPC 周期 ----
        if step % EPC_INTERVAL == 0:
            verdict = self.affect.epc_evaluate(
                self.dendrites.pruned_this_cycle,
                self.dendrites.survived_newborns,
                self.dendrites.n, desire, fear)
            self.dendrites.pruned_this_cycle = 0
            self.dendrites.survived_newborns = 0
            events["epc"] = {"potential": verdict.potential,
                             "D": verdict.d_rate, "P": verdict.p_rate}
            if verdict.net_death:
                self.pain_reservoir += 1.0           # 强制注入 Internal_Pain
                self.desire_fail_streak += 1
            else:
                self.desire_fail_streak = 0

        # ---- 11. 核爆式重组 ----
        if (fear > 0.9 and
                self.desire_fail_streak >= DESIRE_FAIL_CYCLES_TO_DETONATE and
                not in_recovery):
            ev, recover = nuclear_reorganization(self.dendrites, cfg, self.rng)
            self.recovery_until = step + RECOVERY_STEPS
            self.desire_fail_streak = 0
            self.pain_reservoir = 1.0
            events["detonation"] = {"removed": len(ev.pruned),
                                    "kept": self.dendrites.n}

        # ---- 12. 回顾模式（饱和 → 向内深化）----
        if (self.saturation_streak >= SATURATION_STREAK_TRIGGER and
                step > self.review_cooldown_until and
                self.dendrites.forgotten_count > 0):
            window_start = max(0, (self.dendrites.forgotten_count %
                                   self.dendrites.forgotten_keys.shape[0]) - 64)
            buf = np.roll(self.dendrites.forgotten_keys,
                          -window_start, axis=0)
            children = replay_review(self.dendrites, buf, key, cfg.value_dim)
            for ch in children:
                if self.dendrites.n < cfg.max_nodes:
                    self.dendrites.grow(ch, self._make_value_from_key(ch),
                                        fear, step)
                    self.dendrites.survived_newborns += 1
            self.review_cooldown_until = step + 100
            self.saturation_streak = 0
            events["review_children"] = len(children)

        # ---- 13. 冥想推进 / 疼痛衰减 / 感官适应 ----
        self.selector.tick_budget()
        self.pain_reservoir *= 0.95
        self.chronic_damage = min(1.0, max(0.0, latency_ratio))
        if ret.hit:
            self.encoder.adapt(self.encoder.adapt_delta())

        # ---- 14. 动作解码 ----
        action_vec = (key @ self.action_proj).astype(np.float32)
        decision = self.decoder.decode(action_vec)

        # 里程碑 C：novelty（好奇心第三维）= 1 − 检索最大相似度（§3.5 规划，
        # 供语言核条件槽位 [1]；未命中 → 1.0 全新）
        novelty = float(1.0 - ret.sims[0]) if ret.hit else 1.0

        return StepReport(
            step=step, activated_nodes=activated, grew_node_idx=grew_idx,
            tool_call={"tool": decision["tool"], "args": decision["args"]},
            code=decision["code"],
            thought_vector=[float(x) for x in action_vec[:8]],
            new_fear=fear, new_desire=desire,
            n_nodes=self.dendrites.n, max_nodes=cfg.max_nodes, events=events,
            novelty=novelty)

    # ------------------------------------------------------------------
    def injure_soft(self, severity: float = 0.8) -> None:
        """§3 软伤害：工具调用 ERROR → 最近命中节点 Value += -0.8·noise。"""
        if self._last_hit_idx is None:
            return
        noise = self.rng.normal(size=self.cfg.value_dim).astype(np.float32)
        v = self.dendrites.values[self._last_hit_idx] - severity * noise * 0.01
        self.dendrites.values[self._last_hit_idx] = v.astype(np.float32)

    @property
    def chronic(self) -> float:
        return self.chronic_damage

    def status_line(self) -> str:
        """§11A 裸数据状态行：🧬 Fear=x.xx Desire=x.xx Nodes=n/max。"""
        return (f"\U0001F9EC Fear={self.affect_state.fear_total:.2f} "
                f"Desire={self.affect_state.desire:.2f} "
                f"Nodes={self.dendrites.n}/{self.cfg.max_nodes}")

    # ------------------------------------------------------------------
    def _internal_pain(self) -> float:
        return float(min(1.0, self.pain_reservoir))

    def _make_value(self, state: np.ndarray) -> np.ndarray:
        rep = max(1, self.cfg.value_dim // self.cfg.state_dim)
        v = np.tile(state, rep)[: self.cfg.value_dim]
        return (v / max(float(np.linalg.norm(v)), 1e-9)).astype(np.float32)

    def _make_value_from_key(self, key: np.ndarray) -> np.ndarray:
        rep = max(1, self.cfg.value_dim // self.cfg.trunk_dim)
        v = np.tile(key, rep)[: self.cfg.value_dim]
        return (v / max(float(np.linalg.norm(v)), 1e-9)).astype(np.float32)

    # ------------------------------------------------------------------
    def state_dict(self) -> dict[str, object]:
        return {
            "encoder": self.encoder.state_dict(),
            "backbone": self.backbone.state_dict(),
            "dendrites": self.dendrites.state_dict(),
            "step_count": self.step_count,
            "forgotten_count": self.dendrites.forgotten_count,
        }

    def load_state_dict(self, sd: dict[str, object]) -> None:
        self.encoder.load_state_dict(sd["encoder"])
        self.backbone.load_state_dict(sd["backbone"])
        self.dendrites.load_state_dict(sd["dendrites"])
        self.dendrites.forgotten_count = sd["forgotten_count"]
        self.step_count = sd["step_count"]
