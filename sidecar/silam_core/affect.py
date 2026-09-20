"""情绪生理学：恐惧三层生成 / 渴望对称引擎 / EPC 进化势能控制器。

对应 silam-sigma.md §2.1、§2.2、§2.3。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import DesireWeights, FearWeights

EPC_INTERVAL = 100          # §2.3 每 100 步计算
EPC_NET_DEATH_MARGIN = 0.01  # D > P + 0.01 → 净消亡 → 强制 Internal_Pain


@dataclass
class AffectState:
    fear_total: float = 0.0
    desire: float = 0.0
    fear_reactive: float = 0.0
    fear_anticipatory: float = 0.0
    internal_pain: float = 0.0   # EPC 注入的 γ 分量来源


class Affect:
    """无状态计算器：给定输入，产出情绪数值。状态由 engine 持有。"""

    def __init__(self, fw: FearWeights, dw: DesireWeights) -> None:
        self.fw = fw
        self.dw = dw

    # ------------------------------------------------------------------
    def compute_fear(self, max_retrieval_sim: float,
                     forgotten_sim: float,
                     internal_pain: float) -> tuple[float, float, float]:
        """Fear_Total = clamp(α·Reactive + β·Anticipatory + γ·Internal_Pain)

        Reactive     = 1 - max(检索相似度)   —— 陌生环境的先天恐慌
        Anticipatory = sim(Current, Forgotten_Buffer) × 1.5 —— 对已丧失自我的预判
        """
        fr = 1.0 - float(max_retrieval_sim)
        fa = min(1.5 * float(forgotten_sim), 1.0)
        total = (self.fw.alpha * fr + self.fw.beta * fa +
                 self.fw.gamma * internal_pain)
        return _clamp01(total), fr, fa

    # ------------------------------------------------------------------
    def compute_desire(self, info_gain: float, prediction_success: float) -> float:
        """Desire = δ·Info_Gain + ε·Prediction_Success（外部来源）。"""
        d = self.dw.delta * float(info_gain) + self.dw.epsilon * float(prediction_success)
        return _clamp01(d)

    # ------------------------------------------------------------------
    def epc_evaluate(self, pruned_this_cycle: int, survived_newborns: int,
                     n_nodes: int, desire: float, fear_total: float
                     ) -> "EPCVerdict":
        """净进化势能 = Desire × (1 - Fear) × (P - D)。D>P+0.01 触发核爆。"""
        n = max(int(n_nodes), 1)
        d_rate = pruned_this_cycle / n
        p_rate = survived_newborns / n
        potential = desire * (1.0 - fear_total) * (p_rate - d_rate)
        net_death = d_rate > p_rate + EPC_NET_DEATH_MARGIN
        return EPCVerdict(potential=potential, d_rate=d_rate, p_rate=p_rate,
                          net_death=net_death)


@dataclass
class EPCVerdict:
    potential: float
    d_rate: float
    p_rate: float
    net_death: bool


def _clamp01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))
