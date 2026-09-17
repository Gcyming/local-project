"""预训练权重装载：把云端蒸馏产出的 backbone_v1.npz 灌入引擎。

替换"随机 mock 先天智力"为真实蒸馏权重（§9.1 启动流程第 2 步的
"主干从 base_backbone.pt 加载"的最小实现）。形状不匹配立即报错，
绝不静默错位加载——先天智力容不得半点含糊。
"""

from __future__ import annotations

import numpy as np


def load_pretrained(engine, npz_path: str) -> None:
    """从 .npz 读取并写入 engine.encoder / engine.backbone。

    键约定（由 tools/train_backbone.py 导出）：
      enc_w1, enc_w2, enc_w3 —— 编码器三层（前两层冻结，第三层仍可在线适应）
      bb_w1, bb_w2, bb_w3   —— 主干三层（永久冻结）
    """
    sd = np.load(npz_path)
    cfg = engine.cfg

    enc = {"w1": sd["enc_w1"], "w2": sd["enc_w2"], "w3": sd["enc_w3"]}
    bb = {"w1": sd["bb_w1"], "w2": sd["bb_w2"], "w3": sd["bb_w3"]}

    expect_enc = {
        "w1": (cfg.enc_dim_in, cfg.enc_dim_hidden),
        "w2": (cfg.enc_dim_hidden, cfg.enc_dim_hidden),
        "w3": (cfg.enc_dim_hidden, cfg.state_dim),
    }
    expect_bb = {
        "w1": (cfg.state_dim, 192),
        "w2": (192, 192),
        "w3": (192, cfg.trunk_dim),
    }
    for name, arr in {**{f"enc_{k}": v for k, v in enc.items()},
                      **{f"bb_{k}": v for k, v in bb.items()}}.items():
        key = name.split("_", 1)[1]   # "enc_w2"→"w2", "bb_w3"→"w3"
        want = (expect_enc if name.startswith("enc_") else expect_bb)[key]
        got = tuple(arr.shape)
        if got != want:
            raise ValueError(
                f"权重形状不匹配: {name} 期望 {want}, 实际 {got} "
                f"— 请确认 npz 由相同配置的 train_backbone.py 导出")
        if arr.dtype != np.float32:
            raise ValueError(f"权重 dtype 必须为 float32: {name} 是 {arr.dtype}")

    engine.encoder.load_state_dict(enc)
    engine.backbone.load_state_dict(bb)


def save_random_baseline(engine, npz_path: str) -> None:
    """调试辅助：把引擎当前的编码器/主干导出为同格式 npz。"""
    e = engine.encoder.state_dict()
    b = engine.backbone.state_dict()
    np.savez_compressed(
        npz_path,
        enc_w1=e["w1"], enc_w2=e["w2"], enc_w3=e["w3"],
        bb_w1=b["w1"], bb_w2=b["w2"], bb_w3=b["w3"],
    )
