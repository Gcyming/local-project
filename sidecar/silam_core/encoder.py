"""感觉器官：3 层线性编码器（§1.1 可微编码器）。

- 前两层 = 视网膜/耳蜗：先天发育，云端蒸馏后永久冻结。
- 第三层 = 瞳孔调节：在线极低学习率（1e-6）适应性微调，无结构重塑。

纯 NumPy 实现；冻结通过 requires_grad 式开关模拟——4A 无 BP，
第三层"微调"由 engine 以 EMA/低速率更新方式实现（非梯度）。
"""

from __future__ import annotations

import numpy as np

from .config import SilamConfig


def _xavier(rng: np.random.Generator, fan_in: int, fan_out: int) -> np.ndarray:
    """正交初始化：保持映射各向同性，避免随机投影向主奇异方向塌缩。

    （先天感觉能力应均匀覆盖流形，而非把一切挤进同一方向。）
    """
    m = max(fan_in, fan_out)
    g = rng.normal(size=(m, m))
    q, r = np.linalg.qr(g)
    q = q * np.sign(np.diag(r))          # 确定性符号修正
    return q[:fan_in, :fan_out].astype(np.float32)


class Encoder:
    """text → token 序列 → 128 维状态向量。"""

    def __init__(self, cfg: SilamConfig, rng: np.random.Generator) -> None:
        self.cfg = cfg
        d_in, d_h, d_s = cfg.enc_dim_in, cfg.enc_dim_hidden, cfg.state_dim
        # 前两层（先天，冻结）
        self.w1 = _xavier(rng, d_in, d_h)
        self.w2 = _xavier(rng, d_h, d_h)
        self.frozen = True
        # 第三层（适应层，可微调）
        self.w3 = _xavier(rng, d_h, d_s)
        self.lr_adapt: float = 1e-6  # §1.1 在线极低学习率

    # ------------------------------------------------------------------
    def encode(self, text: str) -> np.ndarray:
        """原始文本 → 128 维状态向量（确定性哈希嵌入 + 三层线性）。"""
        toks = _tokenize(text)
        x = np.zeros(self.cfg.enc_dim_in, dtype=np.float32)
        for t in toks:
            idx = _stable_hash(t) % self.cfg.enc_dim_in
            sign = 1.0 if (_stable_hash(t) >> 31) & 1 else -1.0
            x[idx] += sign
        h = np.tanh(x @ self.w1)
        h = np.tanh(h @ self.w2)
        self.last_hidden = h.astype(np.float32)   # 第三层适应信号的来源
        out = (h @ self.w3).astype(np.float32)
        self.last_state = out
        return out

    def adapt_delta(self) -> np.ndarray:
        """感官适应的更新方向：outer(末隐层, 状态)，形状与 w3 一致。"""
        return np.outer(self.last_hidden, self.last_state)

    def adapt(self, delta_w3: np.ndarray) -> None:
        """感官适应：仅第三层，速率 1e-6 量级，永不触及前两层。"""
        self.w3 += self.lr_adapt * delta_w3

    def state_dict(self) -> dict[str, np.ndarray]:
        return {"w1": self.w1.copy(), "w2": self.w2.copy(), "w3": self.w3.copy()}

    def load_state_dict(self, sd: dict[str, np.ndarray]) -> None:
        self.w1, self.w2, self.w3 = sd["w1"], sd["w2"], sd["w3"]


def _tokenize(text: str) -> list[str]:
    """轻量分词：小写化后按非字母数字切分（中文按单字切分）。"""
    out: list[str] = []
    buf: list[str] = []
    for ch in text.lower():
        if ch.isalnum() and not ("\u4e00" <= ch <= "\u9fff"):
            buf.append(ch)
            continue
        if buf:
            out.append("".join(buf))
            buf.clear()
        if "\u4e00" <= ch <= "\u9fff":
            out.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def _stable_hash(s: str) -> int:
    import hashlib

    return int.from_bytes(hashlib.md5(s.encode("utf-8")).digest()[:8], "little")
