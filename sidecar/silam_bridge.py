"""SILAM Engine HTTP 端点（4C 接入层）。

桥接 Slime sidecar HTTP 协议 ↔ SILAM stdin JSONL 协议。
新增路由 /silam/inference，不破坏现有 /chat/completions。

设计原则（非破坏性）：
- 所有新增代码在 sidecar/silam_* 模块，不修改 infer_server.py 现有逻辑
- 通过 slime.toml [silam] enabled 开关控制，默认关闭
- 请求格式兼容 §8.1 IPC 协议，响应兼容 §8.2
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# 注入 SILAM-Σ 项目路径（D:\pilot model）到 sys.path
_SILAM_ROOT = Path(__file__).resolve().parent.parent.parent / "pilot model"
if str(_SILAM_ROOT) not in sys.path:
    sys.path.insert(0, str(_SILAM_ROOT))

from silam_core.engine import SILAMEngine  # noqa: E402
from silam_core.config import SilamConfig  # noqa: E402
from silam_core.pretrained import load_pretrained  # noqa: E402


class SilamBridge:
    """SILAM 桥接器：持有引擎实例，处理 HTTP 请求。"""

    def __init__(self, agent_id: str, cfg: SilamConfig | None = None,
                 backbone_path: str | None = None) -> None:
        self.agent_id = agent_id
        self.cfg = cfg or SilamConfig()
        self.engine = SILAMEngine(cfg=self.cfg)
        if backbone_path:
            bp = Path(backbone_path)
            if bp.exists():
                load_pretrained(self.engine, str(bp))
                print(f"[silam] 已装载蒸馏权重 {bp}", file=sys.stderr, flush=True)
        # 大脑目录：复用 Slime 的 .slimeagent 结构
        self.brain_dir = Path.home() / ".slimeagent" / agent_id / "brain"
        self.brain_dir.mkdir(parents=True, exist_ok=True)

    def inference(self, payload: dict) -> dict:
        """处理单次 forward，返回 §8.2 格式的响应负载。"""
        state_text = str(payload.get("state_text", ""))
        fear = payload.get("fear_level")
        desire = payload.get("desire_level")
        latency = float(payload.get("latency_ratio", 0.0))

        r = self.engine.forward(
            state_text,
            fear_level=fear,
            desire_level=desire,
            latency_ratio=latency,
        )

        return {
            "tool_call": r.tool_call,
            "thought_vector": r.thought_vector,
            "new_fear": r.new_fear,
            "new_desire": r.new_desire,
            "activated_nodes": r.activated_nodes,
            "grew_node_idx": r.grew_node_idx,
            "n_nodes": r.n_nodes,
            "max_nodes": r.max_nodes,
            "step": r.step,
            "status_line": r.status_line if hasattr(r, 'status_line') else self.engine.status_line(),
        }

    def status(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "step": self.engine.step_count,
            "n_nodes": self.engine.dendrites.n,
            "fear": self.engine.affect_state.fear_total,
            "desire": self.engine.affect_state.desire,
            "status_line": self.engine.status_line(),
        }

    def save(self) -> dict:
        """持久化到 .npy + meta.json（4D WAL 联调前用最小实现）。"""
        import numpy as np
        sd = self.engine.state_dict()
        for name, arr in [
            ("keys", sd["dendrites"]["keys"]),
            ("values", sd["dendrites"]["values"]),
            ("fears", sd["dendrites"]["fears"]),
            ("forgotten_buffer", sd["dendrites"]["forgotten_keys"]),
        ]:
            np.save(self.brain_dir / f"{name}.npy", arr)
        import json as _json
        meta = {
            "agent_id": self.agent_id,
            "step_count": self.engine.step_count,
            "forgotten_count": sd["forgotten_count"],
        }
        (self.brain_dir / "meta.json").write_text(
            _json.dumps(meta, ensure_ascii=False, indent=2))
        return {"saved_step": self.engine.step_count,
                "n_nodes": self.engine.dendrites.n}


# 模块级单例（FastAPI 启动时初始化）
_bridge: SilamBridge | None = None


def init_bridge(agent_id: str, cfg: SilamConfig | None = None,
                backbone_path: str | None = None) -> SilamBridge:
    global _bridge
    _bridge = SilamBridge(agent_id, cfg, backbone_path)
    return _bridge


def get_bridge() -> SilamBridge | None:
    return _bridge
