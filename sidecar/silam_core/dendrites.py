"""动态树突：可生长联想记忆矩阵（§1.3 后天经验）。

物理现实即内存字节：
- vstack 增行 = 神经生长
- np.delete 删行 = 切除（硬伤害，Pain_Spike）
- 赫布强化 = 突触加固（Value L2 ≤ 1.0 饱和）

节点三态（§1.3 表）：正常 / 休眠（dormant）/ 遗忘（Forgotten_Buffer）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import SilamConfig

VALUE_L2_CAP = 1.0          # §4.1 赫布强化上限
SILENT_PRUNE_STEPS = 200    # §1.3 正常节点静默期超 200 步可修剪


@dataclass
class RetrievalResult:
    hit: bool
    sims: np.ndarray           # 相似度向量（含最高值）
    indices: np.ndarray        # 命中节点的行索引
    values: np.ndarray         # 命中节点的 value 行


class Dendrites:
    def __init__(self, cfg: SilamConfig, rng: np.random.Generator) -> None:
        self.cfg = cfg
        self.rng = rng
        # ---- 正常节点区 ----
        self.keys = np.zeros((0, cfg.trunk_dim), dtype=np.float32)   # keys.npy [N,64]
        self.values = np.zeros((0, cfg.value_dim), dtype=np.float32)  # [N,256]
        self.fears = np.zeros((0,), dtype=np.float32)                 # [N]
        self.last_hit_step = np.zeros((0,), dtype=np.int64)
        self.hit_count = np.zeros((0,), dtype=np.int64)
        self.dormant_flags = np.zeros((0,), dtype=bool)
        self.dormant_born_step = np.zeros((0,), dtype=np.int64)
        # ---- Forgotten_Buffer（§9.4 forgotten_buffer.npy [10000, trunk]）----
        self.forgotten_keys = np.zeros((10_000, cfg.trunk_dim), dtype=np.float32)
        self.forgotten_count = 0
        # ---- 统计 ----
        self.pruned_this_cycle = 0      # EPC 的 D 分子
        self.survived_newborns = 0      # EPC 的 P 分子
        self.total_pain_spikes = 0

    # ------------------------------------------------------------------
    @property
    def n(self) -> int:
        return int(self.keys.shape[0])

    @property
    def capacity_ratio(self) -> float:
        return self.n / max(self.cfg.max_nodes, 1)

    # ------------------------------------------------------------------
    def retrieve(self, key: np.ndarray, topk: int = 5,
                 include_dormant: bool = False) -> RetrievalResult:
        """余弦相似度检索；休眠节点默认不参与常规检索。"""
        if self.n == 0:
            empty = np.zeros(0, dtype=np.float32)
            return RetrievalResult(False, empty, empty.astype(np.int64),
                                   np.zeros((0, self.cfg.value_dim), np.float32))
        mask = ~self.dormant_flags if not include_dormant else np.ones(self.n, bool)
        idx_pool = np.nonzero(mask)[0]
        if idx_pool.size == 0:
            empty = np.zeros(0, dtype=np.float32)
            return RetrievalResult(False, empty, empty.astype(np.int64),
                                   np.zeros((0, self.cfg.value_dim), np.float32))
        kn = self.keys[idx_pool]
        q = key / max(float(np.linalg.norm(key)), 1e-9)
        sims = (kn @ q) / np.maximum(np.linalg.norm(kn, axis=1), 1e-9)
        order = np.argsort(-sims)[:topk]
        top_idx = idx_pool[order].astype(np.int64)
        hit = bool(order.size > 0 and sims[order[0]] >= self.cfg.hit_threshold)
        return RetrievalResult(hit, sims[order], top_idx, self.values[top_idx])

    # ------------------------------------------------------------------
    def grow(self, key: np.ndarray, value: np.ndarray, fear: float,
             step: int, dormant: bool = False) -> int:
        """vstack 新增节点——返回新行索引。逼近上限时拒绝生长（由蒸馏接管）。"""
        assert self.keys.shape[0] < self.cfg.max_nodes, "MAX_NODES reached; distill first"
        k = (key / max(float(np.linalg.norm(key)), 1e-9)).astype(np.float32)
        self.keys = np.vstack([self.keys, k[None, :]])
        self.values = np.vstack([self.values, value[None, :].astype(np.float32)])
        self.fears = np.append(self.fears, np.float32(fear))
        self.last_hit_step = np.append(self.last_hit_step, step)
        self.hit_count = np.append(self.hit_count, 0)
        self.dormant_flags = np.append(self.dormant_flags, dormant)
        self.dormant_born_step = np.append(
            self.dormant_born_step, step if dormant else -1)
        return self.n - 1

    # ------------------------------------------------------------------
    def hebbian_reinforce(self, idx: int, value_grad: np.ndarray,
                          lr: float = 0.05) -> float:
        """赫布强化：命中即加固，L2 范数 ≤ 1.0。返回实际强化量（饱和后→0）。"""
        before = float(np.linalg.norm(self.values[idx]))
        candidate = self.values[idx] + lr * value_grad
        norm = float(np.linalg.norm(candidate))
        if norm > VALUE_L2_CAP:
            scale_down = (VALUE_L2_CAP - before) / max(lr * float(np.linalg.norm(value_grad)), 1e-9)
            if scale_down <= 0.0:
                return 0.0  # 已饱和——触发回顾模式的信号
            candidate = self.values[idx] + lr * scale_down * value_grad
        delta = float(np.linalg.norm(candidate - self.values[idx]))
        self.values[idx] = candidate
        return delta

    def mark_hit(self, idx: int, step: int) -> None:
        self.last_hit_step[idx] = step
        self.hit_count[idx] += 1

    # ------------------------------------------------------------------
    def excise(self, indices: list[int]) -> float:
        """np.delete 物理切除。正常节点 → Forgotten_Buffer + Pain_Spike=1.0；
        休眠节点静默删除（从未成为自我）。返回 Pain_Spike 总量。"""
        pain = 0.0
        keep_mask = np.ones(self.n, dtype=bool)
        for i in sorted(set(indices)):
            if i < 0 or i >= self.n or not keep_mask[i]:
                continue
            if self.dormant_flags[i]:
                pass  # 静默消除：不进遗忘缓冲，不疼
            else:
                self._remember_forgotten(self.keys[i])
                pain += 1.0
                self.total_pain_spikes += 1
                self.pruned_this_cycle += 1
            keep_mask[i] = False
        self._apply_keep(keep_mask)
        return pain

    def _remember_forgotten(self, key: np.ndarray) -> None:
        """环形写入 Forgotten_Buffer。"""
        pos = self.forgotten_count % self.forgotten_keys.shape[0]
        self.forgotten_keys[pos] = (
            key / max(float(np.linalg.norm(key)), 1e-9)).astype(np.float32)
        self.forgotten_count += 1

    def forgotten_fill_ratio(self) -> float:
        return min(1.0, self.forgotten_count / self.forgotten_keys.shape[0])

    def forgotten_similarity(self, key: np.ndarray) -> float:
        """预期性恐惧用：与"已丧失自我"的最大相似度。"""
        if self.forgotten_count == 0:
            return 0.0
        buf = self.forgotten_keys[: min(self.forgotten_count,
                                        self.forgotten_keys.shape[0])]
        q = key / max(float(np.linalg.norm(key)), 1e-9)
        sims = (buf @ q) / np.maximum(np.linalg.norm(buf, axis=1), 1e-9)
        return float(sims.max())

    # ------------------------------------------------------------------
    def dormant_activated(self, idx: int) -> None:
        """休眠节点被命中激活为正常节点。"""
        self.dormant_flags[idx] = False
        self.dormant_born_step[idx] = -1

    def expired_dormants(self, step: int) -> list[int]:
        """观察期结束仍未激活的休眠节点（将被静默删除）。"""
        deadline = self.dormant_born_step + self.cfg.dormant_observation_steps
        return [int(i) for i in np.nonzero(
            self.dormant_flags & (deadline <= step))[0]]

    # ------------------------------------------------------------------
    def _apply_keep(self, keep_mask: np.ndarray) -> None:
        self.keys = self.keys[keep_mask]
        self.values = self.values[keep_mask]
        self.fears = self.fears[keep_mask]
        self.last_hit_step = self.last_hit_step[keep_mask]
        self.hit_count = self.hit_count[keep_mask]
        self.dormant_flags = self.dormant_flags[keep_mask]
        self.dormant_born_step = self.dormant_born_step[keep_mask]

    # ------------------------------------------------------------------
    def state_dict(self) -> dict[str, np.ndarray]:
        return {
            "keys": self.keys.copy(), "values": self.values.copy(),
            "fears": self.fears.copy(),
            "last_hit_step": self.last_hit_step.copy(),
            "hit_count": self.hit_count.copy(),
            "dormant_flags": self.dormant_flags.copy(),
            "dormant_born_step": self.dormant_born_step.copy(),
            "forgotten_keys": self.forgotten_keys.copy(),
        }

    def load_state_dict(self, sd: dict[str, np.ndarray]) -> None:
        self.keys = sd["keys"]; self.values = sd["values"]
        self.fears = sd["fears"]
        self.last_hit_step = sd["last_hit_step"]; self.hit_count = sd["hit_count"]
        self.dormant_flags = sd["dormant_flags"]
        self.dormant_born_step = sd["dormant_born_step"]
        self.forgotten_keys = sd["forgotten_keys"]

    # ------------------------------------------------------------------
    def clone_from(self, other: "Dendrites") -> None:
        """Swarm 克隆（§10）：深拷贝父 Agent 全部树突参数。"""
        self.load_state_dict(other.state_dict())
