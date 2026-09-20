"""进化突围机制：修剪、分层概念蒸馏、核爆式重组、回顾模式。

对应 silam-sigma.md §3（硬伤害）、§4.2（回顾模式）、§5.1（蒸馏）、§5.2（核爆）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import SilamConfig
from .dendrites import Dendrites


@dataclass
class EvolutionEvents:
    pruned: list[int] = field(default_factory=list)
    pain_spikes: float = 0.0
    distilled_pairs: int = 0
    detonation: bool = False


def prune_silent_nodes(dend: Dendrites, step: int,
                       silent_after: int = 200) -> EvolutionEvents:
    """§1.3/§3 硬伤害：静默期超阈值的正常节点被切除（np.delete 物理释放）。

    休眠节点不在此列——它们由 engine 按观察期规则静默删除。
    返回事件（Pain_Spike 总量 = 被切除的正常节点数）。
    """
    ev = EvolutionEvents()
    if dend.n == 0:
        return ev
    stale = np.nonzero((~dend.dormant_flags) &
                       (step - dend.last_hit_step > silent_after))[0]
    if stale.size:
        idxs = [int(i) for i in stale]
        ev.pain_spikes = dend.excise(idxs)
        ev.pruned = idxs
    return ev


def hierarchical_distill(dend: Dendrites, cfg: SilamConfig) -> EvolutionEvents:
    """§5.1 分层概念蒸馏。触发：节点数 > MAX_NODES × distill_threshold(0.85)。

    行为：合并相似度最高的节点对 (A,B) 为父节点 P：
      - key：命中数加权的平均方向；
      - value：加权均值（抽象层）+ 偏差压缩表示（具体层的可恢复细节）；
      - 删除 A、B 之一槽位覆盖父节点 → 净减一行，信息近似无损。
    """
    ev = EvolutionEvents()
    threshold = int(cfg.max_nodes * cfg.distill_threshold)
    while dend.n > max(threshold, 1):
        kn = dend.keys / np.maximum(
            np.linalg.norm(dend.keys, axis=1, keepdims=True), 1e-9)
        sims = kn @ kn.T
        np.fill_diagonal(sims, -np.inf)
        i, j = np.unravel_index(int(np.argmax(sims)), sims.shape)
        i, j = int(i), int(j)
        wi = float(dend.hit_count[i]) + 1.0
        wj = float(dend.hit_count[j]) + 1.0
        # ---- 父节点 key（加权平均特征）----
        parent = (wi * dend.keys[i] + wj * dend.keys[j]) / (wi + wj)
        parent /= max(float(np.linalg.norm(parent)), 1e-9)
        # ---- 父节点 value：抽象层 + 偏差压缩表示 ----
        mean_v = (wi * dend.values[i] + wj * dend.values[j]) / (wi + wj)
        dev = 0.25 * ((dend.values[i] - mean_v) + (dend.values[j] - mean_v))
        merged_value = (mean_v + dev).astype(np.float32)
        # ---- 覆盖保留槽位，切除另一行 ----
        keep, drop = (i, j) if wi >= wj else (j, i)
        dend.keys[keep] = parent.astype(np.float32)
        dend.values[keep] = merged_value
        dend.hit_count[keep] = int((wi - 1.0) + (wj - 1.0))   # 命中质量守恒
        ev.pain_spikes += dend.excise([drop])
        ev.distilled_pairs += 1
    return ev


def nuclear_reorganization(dend: Dendrites, cfg: SilamConfig,
                           rng: np.random.Generator) -> tuple[EvolutionEvents, int]:
    """§5.2 核爆式重组。触发条件由 engine 判定（Fear>0.9 且 Desire 连续失败）。

    行为：保留 Top-5% 高频节点 + 全部休眠节点（隐性多样性种子），
    其余物理切除。返回 (事件, 恢复期步数=500)。
    """
    ev = EvolutionEvents(pain_spikes=float("nan"), detonation=True)
    if dend.n == 0:
        return ev, 500
    # Top-5% 在"正常节点"中选取；休眠节点作为隐性多样性整体保留（§5.2）
    normal_idx = np.nonzero(~dend.dormant_flags)[0]
    k = max(1, int(round(normal_idx.size * 0.05)))
    top = set(int(i) for i in normal_idx[np.argsort(-dend.hit_count[normal_idx])[:k]])
    dormant_idx = set(np.nonzero(dend.dormant_flags)[0].tolist())
    doomed = [i for i in range(dend.n) if i not in top and i not in dormant_idx]
    if doomed:
        ev.pruned = doomed
        ev.pain_spikes = dend.excise(doomed)
    return ev, 500


def replay_review(dend: Dendrites, forgotten_window: np.ndarray,
                  anchor_key: np.ndarray, value_dim: int,
                  max_new: int = 3) -> list[np.ndarray]:
    """§4.2 回顾模式：饱和后与 Forgotten_Buffer 对比，差异编码为子节点候选。

    返回待插入的子节点 key 列表（engine 以正常路径 grow 并计入进步率 P）。
    """
    out: list[np.ndarray] = []
    n = min(forgotten_window.shape[0], 64)
    if n == 0 or dend.n == 0:
        return out
    buf = forgotten_window[:n]
    q = anchor_key / max(float(np.linalg.norm(anchor_key)), 1e-9)
    sims = (buf @ q) / np.maximum(np.linalg.norm(buf, axis=1), 1e-9)
    for pos in np.argsort(-sims)[:max_new]:
        diff = buf[pos] - q
        norm = float(np.linalg.norm(diff))
        if norm < 1e-6:      # 无差异 → 不产生子节点
            continue
        child = q + 0.8 * diff / norm
        out.append((child / max(float(np.linalg.norm(child)), 1e-9)).astype(np.float32))
    return out
