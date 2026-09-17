"""内部选择机制：Meaning_Score、λ 权重演替、熵预算、好奇心分裂、静默冥想。

对应 silam-sigma.md §4.3、§4.4。
核心哲学：
- 变异必须有选择；选择标准本身也在演化（无硬编码阶段切换，只有权重的自然演替）；
- 被排除的变异有 5% 进入休眠——隐性多样性是突破的种子。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import SilamConfig
from .dendrites import Dendrites

MEANING_PASS_THRESHOLD = 0.3   # §4.3 判定线
BUDGET_RATIO = 0.01            # 熵预算总量 = 当前节点数 × 0.01
MEDITATION_STEPS = 100         # 静默冥想时长
MEDITATION_RECOVER_RATE = 0.01 # 预算恢复 1%/步


@dataclass
class SplitOutcome:
    kind: str          # "normal" | "dormant" | "pruned" | None
    child_idx: int | None
    meaning_score: float


class Selector:
    def __init__(self, cfg: SilamConfig, rng: np.random.Generator,
                 dendrites: Dendrites) -> None:
        self.cfg = cfg
        self.rng = rng
        self.dend = dendrites
        # ---- 好奇心分裂状态 ----
        self.steps_since_new_node = 0
        self.budget_units = 0.0        # 熵预算余量（单位：次分裂）
        self.meditation_left = 0       # 静默冥想倒计时
        # ---- 扰动方向（冥想中回顾有意义分裂的共同特征后调整）----
        self.perturb_dir: np.ndarray | None = None
        self.meaning_centroid: np.ndarray | None = None  # 有意义子节点的 EMA 质心
        # ---- 先天质心（由主干提取，见 set_trunk_centroids）----
        self.trunk_centroids: np.ndarray | None = None

    # ------------------------------------------------------------------
    def set_trunk_centroids(self, centroids: np.ndarray) -> None:
        """§4 阶段一步骤5：先天偏好提取。mock 阶段由主干主方向 SVD 得出。"""
        self.trunk_centroids = centroids.copy()

    # ------------------------------------------------------------------
    def lambda_weights(self) -> tuple[float, float, float]:
        """发育式权重演替（§4.3 公式，连续函数而非阶段查表）。

        λ₁ = 0.2 + 0.8×(1 - r)      先天偏好：1.0 → 0.2
        λ₂ = 0.6×r                  后天经验：0 → 0.6
        λ₃ = 0.2×forgotten_fill     丧失之物的参照：0 → 0.2
        """
        r = self.dend.capacity_ratio
        l1 = self.cfg.lambda1_final + (self.cfg.lambda1_init -
                                       self.cfg.lambda1_final) * (1.0 - r)
        l2 = self.cfg.lambda2_final * r
        l3 = self.cfg.lambda3_final * self.dend.forgotten_fill_ratio()
        return float(l1), float(l2), float(l3)

    # ------------------------------------------------------------------
    def meaning_score(self, key: np.ndarray) -> float:
        """Meaning_Score = λ₁·sim(主干质心) + λ₂·sim(已有节点) + λ₃·sim(遗忘)。"""
        q = key / max(float(np.linalg.norm(key)), 1e-9)
        l1, l2, l3 = self.lambda_weights()

        s_trunk = 0.0
        if self.trunk_centroids is not None and self.trunk_centroids.size:
            c = self.trunk_centroids
            sims = (c @ q) / np.maximum(np.linalg.norm(c, axis=1), 1e-9)
            s_trunk = float(sims.max())

        s_dynamic = 0.0
        if self.dend.n:
            sims = (self.dend.keys @ q) / np.maximum(
                np.linalg.norm(self.dend.keys, axis=1), 1e-9)
            s_dynamic = float(sims.max())

        s_forgotten = self.dend.forgotten_similarity(q)
        return _c01(l1 * max(s_trunk, 0.0) + l2 * max(s_dynamic, 0.0) +
                    l3 * max(s_forgotten, 0.0))

    # ------------------------------------------------------------------
    def tick_budget(self) -> None:
        """每步调用：冥想恢复预算；否则随节点增长自然获得容量。"""
        capacity = BUDGET_RATIO * max(self.dend.n, 1)
        if self.meditation_left > 0:
            self.budget_units = min(capacity,
                                    self.budget_units + capacity * MEDITATION_RECOVER_RATE)
            self.meditation_left -= 1
            return
        # 正常态：预算上限跟随当前节点数
        self.budget_units = min(capacity, self.budget_units)

    def grant_growth_budget(self) -> None:
        """新节点诞生带来新的熵预算容量（engine 在 grow 后调用）。"""
        self.budget_units = min(BUDGET_RATIO * max(self.dend.n, 1),
                                self.budget_units + 1.0)

    # ------------------------------------------------------------------
    def maybe_split(self, step: int, fear_total: float,
                    anchor_key: np.ndarray) -> SplitOutcome | None:
        """好奇心分裂评估。触发：连续 N 步无新增且 Fear<0.3。

        分裂 = 对锚点施加定向扰动生成变异体，经内部选择判定去留：
        - ≥0.3 → 正常节点（预算消耗）
        - <0.3 → 95% 待修剪 / 5% 盲选保留为休眠节点
        """
        if self.meditation_left > 0:
            return None
        need = int(self.cfg.curiosity_interval *
                   (0.1 if getattr(self, "_recovery_mode", False) else 1.0))
        if (self.steps_since_new_node < need or fear_total >= 0.3):
            return None
        if self.budget_units < 1.0:
            # 预算耗尽 → 静默冥想（§4.4）
            self.meditation_left = MEDITATION_STEPS
            return None
        if self.dend.n >= self.cfg.max_nodes:
            return None

        self.budget_units -= 1.0
        child = self._perturb(anchor_key)
        score = self.meaning_score(child)

        if score >= MEANING_PASS_THRESHOLD:
            idx = self.dend.grow(child, self._child_value(child, score),
                                 fear_total, step, dormant=False)
            # 回顾共同特征：有意义质心 EMA，扰动方向向其靠拢
            self._absorb_meaning(child)
            return SplitOutcome("normal", idx, score)

        # 分裂失败分流
        if self.rng.random() < self.cfg.blind_retain_rate:
            idx = self.dend.grow(child, self._child_value(child, score),
                                 fear_total, step, dormant=True)
            return SplitOutcome("dormant", idx, score)
        return SplitOutcome("pruned", None, score)  # 引擎负责标记修剪

    # ------------------------------------------------------------------
    def _perturb(self, anchor: np.ndarray) -> np.ndarray:
        """变异 = 定向分量（演化中的扰动方向）+ 随机游走分量。"""
        dim = anchor.shape[0]
        noise = self.rng.normal(0, 0.15, size=dim).astype(np.float32)
        directed = np.zeros(dim, dtype=np.float32)
        if self.perturb_dir is not None:
            directed = 0.35 * self.perturb_dir.astype(np.float32)
        child = anchor + directed + noise
        return (child / max(float(np.linalg.norm(child)), 1e-9)).astype(np.float32)

    def _absorb_meaning(self, child: np.ndarray) -> None:
        if self.meaning_centroid is None:
            self.meaning_centroid = child.copy()
        else:
            self.meaning_centroid = (
                0.9 * self.meaning_centroid + 0.1 * child).astype(np.float32)
        d = self.meaning_centroid - child
        n = float(np.linalg.norm(d))
        self.perturb_dir = (d / n if n > 1e-9 else np.zeros_like(d)).astype(np.float32)

    def _child_value(self, key: np.ndarray, score: float) -> np.ndarray:
        """新节点的 Value：以 key 的重复编码为主体（联想内容的最小实现）。"""
        v = np.tile((key * 0.5).astype(np.float32), self.cfg.value_dim // key.shape[0])
        v[: key.shape[0]] = key
        return v * min(score / MEANING_PASS_THRESHOLD, 1.5)

    def note_new_node(self) -> None:
        self.steps_since_new_node = 0

    def tick_no_growth(self) -> None:
        self.steps_since_new_node += 1


def _c01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))
