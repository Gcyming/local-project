"""SILAM-Σ 配置（对应 silam-sigma.md §13 配置扩展，v4.2-final 全参数）。

支持 TOML 覆盖：config = SilamConfig.from_toml("silam.toml")。
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field


@dataclass
class FearWeights:
    """§2.1 恐惧三层权重（4A 阶段网格搜索微调）。"""

    alpha: float = 0.5  # 反应性恐惧
    beta: float = 0.3   # 预期性恐惧
    gamma: float = 0.2  # 内源性恐惧（EPC 注入）


@dataclass
class DesireWeights:
    """§2.2 渴望权重。"""

    delta: float = 0.6    # 外部信息增益
    epsilon: float = 0.4  # 预测成功


@dataclass
class WalConfig:
    """§9.4 Write-Ahead Log（4B/4D 启用，4A 预留）。"""

    enabled: bool = True
    log_path: str = "./.slimeagent/{agent_id}/brain/wal.log"
    max_log_size: str = "10MB"  # 达到上限 → 强制检查点 → 清空 WAL


@dataclass
class SilamConfig:
    # --- §13 [silam] ---
    enabled: bool = True
    max_nodes: int = 200_000            # 硬上限（非寿命，由 RAM 推导时可覆盖）
    distill_threshold: float = 0.85     # 分层概念蒸馏触发线
    prune_interval: int = 200           # 修剪扫描周期（步）
    curiosity_interval: int = 50        # 好奇心分裂评估周期（步）
    blind_retain_rate: float = 0.05     # 分裂失败盲选保留率（休眠种子）
    dormant_observation_steps: int = 500  # 休眠观察期
    lambda1_init: float = 1.0           # λ₁ 先天偏好初始值
    lambda1_final: float = 0.2          # λ₁ 终值
    lambda2_final: float = 0.6          # λ₂ 后天经验终值
    lambda3_final: float = 0.2          # λ₃ 遗忘终值
    checkpoint_interval_steps: int = 50
    backbone_path: str = "./data/backbone_v1.pt"

    # --- 内核尺寸（4A 用 mock；主干蒸馏后替换真实权重） ---
    enc_dim_in: int = 256     # 编码器输入 token 维度
    enc_dim_hidden: int = 192
    state_dim: int = 128      # 感觉器官输出 / 状态向量维度（§1.1）
    trunk_dim: int = 64       # 主干输出维度 = 树突 key 维度（mock 128→256→64 的末端）
    value_dim: int = 256      # values.npy [N, 256]（§9.4）
    hit_threshold: float = 0.35  # 检索命中判定线（§4.1 "检索命中？"的最小实现）

    # --- §13 子节 ---
    fear_weights: FearWeights = field(default_factory=FearWeights)
    desire_weights: DesireWeights = field(default_factory=DesireWeights)
    wal: WalConfig = field(default_factory=WalConfig)

    @classmethod
    def from_toml(cls, path: str) -> "SilamConfig":
        with open(path, "rb") as f:
            data = tomllib.load(f)
        cfg = cls()
        for k, v in (data.get("silam") or {}).items():
            if k in {"fear_weights", "desire_weights", "wal"}:
                sub = getattr(cfg, k)
                for sk, sv in v.items():
                    setattr(sub, sk, sv)
            elif hasattr(cfg, k):
                setattr(cfg, k, v)
        return cfg
