"""动作解码器（§8A，v4.1/v4.2）：64 维动作向量 → 工具调用。

核心区分：动作码 ≠ 工具。动作码是决策层高阶抽象
（abort / retry / escalate / proceed / inspect ...），
工具调用是执行层下一级映射——二者不一一对应。

- 锚点：Walsh-Hadamard 构造，两两正交；预留扩展至 16/32。
- 参数生成 MVP：检索参数记忆库中最相似历史调用的参数模板；
  零匹配 → fallback 空参 {} 不抛错（v4.2 兜底规则）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def hadamard_matrix(n: int) -> np.ndarray:
    """Syevogladow 递归构造 Walsh-Hadamard 矩阵（n=2^k）。"""
    assert n & (n - 1) == 0 and n >= 2, "n 必须为 2 的幂"
    m = np.array([[1.0, 1.0], [1.0, -1.0]], dtype=np.float32)
    while m.shape[0] < n:
        m = np.block([[m, m], [m, -m]])
    return m


@dataclass
class ActionAnchor:
    code: str                 # 动作码（决策层抽象）
    tool: str                 # 映射的工具名（执行层）
    vector: np.ndarray        # Hadamard 锚点向量


# 固定映射表：动作码 → 工具名（§8A 两层结构：动作码≠工具）
# 动作码表与《100 万条数据生成·最终敲定方案》的教师标签空间严格一致；
# 工具名为执行层默认映射，可由宿主配置覆盖。
DEFAULT_ACTION_TABLE: list[tuple[str, str]] = [
    ("abort", "task_abort"),
    ("retry", "task_retry"),
    ("save", "file_write"),
    ("escalate", "ask_user"),
    ("file_cleanup", "disk_cleanup"),
    ("memory_store", "memory_write"),
    ("memory_query", "memory_read"),
    ("tool_call", "core_continue"),
    ("wait", "timer_wait"),
    ("terminate", "session_end"),
    ("notify", "status_report"),
    ("ignore", "noop"),
]


class ActionDecoder:
    def __init__(self, action_dim: int = 64,
                 table: list[tuple[str, str]] | None = None) -> None:
        self.action_dim = action_dim
        rows = hadamard_matrix(action_dim)[: len(table or DEFAULT_ACTION_TABLE)]
        self.anchors: list[ActionAnchor] = []
        for k, (code, tool) in enumerate(table or DEFAULT_ACTION_TABLE):
            v = rows[k].copy()
            self.anchors.append(ActionAnchor(code, tool, v))
        # 参数记忆库：LanceDB 的 4A 内存替身（key=thought 向量，args=模板）
        self._param_keys = np.zeros((0, action_dim), dtype=np.float32)
        self._param_args: list[dict] = []

    # ------------------------------------------------------------------
    def decode(self, action_vec: np.ndarray) -> dict:
        """动作向量 → {code, tool, args}。"""
        v = np.asarray(action_vec, dtype=np.float32)
        sims = np.array([_cos(v, a.vector) for a in self.anchors], dtype=np.float32)
        best = int(np.argmax(sims))
        anchor = self.anchors[best]
        return {"code": anchor.code, "tool": anchor.tool,
                "args": self.retrieve_args(v), "similarity": float(sims[best])}

    # ------------------------------------------------------------------
    def retrieve_args(self, thought: np.ndarray) -> dict:
        """参数生成：最相似历史调用模板；零匹配 → {}（不抛错）。"""
        if self._param_keys.shape[0] == 0:
            return {}
        q = thought / max(float(np.linalg.norm(thought)), 1e-9)
        kn = self._param_keys / np.maximum(
            np.linalg.norm(self._param_keys, axis=1, keepdims=True), 1e-9)
        best = int(np.argmax(kn @ q))
        return dict(self._param_args[best])

    def remember_params(self, thought: np.ndarray, args: dict) -> None:
        self._param_keys = np.vstack([self._param_keys, np.asarray(
            thought, dtype=np.float32)[None, :]])
        self._param_args.append(dict(args))


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    na = max(float(np.linalg.norm(a)), 1e-9)
    nb = max(float(np.linalg.norm(b)), 1e-9)
    return float(a @ b / (na * nb))
