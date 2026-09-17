"""
core/checkpoints.py — Agent SubTask 级"后悔药"影子仓库（A-126 P1）。

本文件是 tools/git.py checkpoint 实现的 core 层薄包装：
- save_checkpoint(label) → git_checkpoint_save
- list_checkpoints(max) → git_checkpoint_list
- restore_checkpoint(id, mode) → git_checkpoint_restore

核心约束（与 tools/git.py 对齐）：
1. 还原前会自动再 save 一次 restore-before-<id> checkpoint，确保"还原操作本身"也可回滚；
2. 默认保留最近 50 个 checkpoint，旧的 bundle/patch 自动 rotate 清理；
3. checkpoint 不重写 Git 历史；不修改任何 refs/heads/*；不 push 远端。
"""

from __future__ import annotations

from tools.git import (
    git_checkpoint_list,
    git_checkpoint_restore,
    git_checkpoint_save,
)


async def save_checkpoint(label: str) -> str:
    """保存 SubTask 开始前的工作区+暂存区影子快照，返回 id 等信息的富文本。"""
    return await git_checkpoint_save({"label": label})


async def list_checkpoints(max_items: int = 20) -> str:
    """列出最近 N 条 checkpoint（默认 20，最大 100）。"""
    return await git_checkpoint_list({"max": max_items})


async def restore_checkpoint(cp_id: str, *, mode: str = "files") -> str:
    """还原 checkpoint：mode=files（仅文件，最常用）| task（仅还原 intent git note）| both。"""
    if mode not in {"files", "task", "both"}:
        raise ValueError(f"restore_checkpoint mode 必须是 files/task/both，收到：{mode!r}")
    return await git_checkpoint_restore({"id": cp_id, "mode": mode})


__all__ = ["save_checkpoint", "list_checkpoints", "restore_checkpoint"]
