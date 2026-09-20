"""静态主干：纯 MLP，无注意力（§1.2 先天智力）。

4A 阶段为随机初始化 mock（128→192→192→64），仅验证
"恐惧/渴望循环驱动节点生长"生命主线；蒸馏权重（backbone_v1.pt）
后置到 4E 之后替换，接口保持不变。
"""

from __future__ import annotations

import numpy as np

from .config import SilamConfig


class Backbone:
    """state(128) → trunk(64)。冻结——先天智力上限固定。"""

    def __init__(self, cfg: SilamConfig, rng: np.random.Generator) -> None:
        d_s, d_t = cfg.state_dim, cfg.trunk_dim
        h = 192
        self.w1 = _xavier(rng, d_s, h)
        self.w2 = _xavier(rng, h, h)
        self.w3 = _xavier(rng, h, d_t)

    def forward(self, state: np.ndarray) -> np.ndarray:
        """表征升维 + 先天偏好来源：输出即主干流形上的坐标。"""
        h = np.tanh(state @ self.w1)
        h = np.tanh(h @ self.w2)
        return (h @ self.w3).astype(np.float32)

    def state_dict(self) -> dict[str, np.ndarray]:
        return {"w1": self.w1.copy(), "w2": self.w2.copy(), "w3": self.w3.copy()}

    def load_state_dict(self, sd: dict[str, np.ndarray]) -> None:
        self.w1, self.w2, self.w3 = sd["w1"], sd["w2"], sd["w3"]


def _xavier(rng: np.random.Generator, fan_in: int, fan_out: int) -> np.ndarray:
    """正交初始化：保持映射各向同性，避免随机投影向主奇异方向塌缩。

    （先天感觉能力应均匀覆盖流形，而非把一切挤进同一方向。）
    """
    m = max(fan_in, fan_out)
    g = rng.normal(size=(m, m))
    q, r = np.linalg.qr(g)
    q = q * np.sign(np.diag(r))          # 确定性符号修正
    return q[:fan_in, :fan_out].astype(np.float32)
