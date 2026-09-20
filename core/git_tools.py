"""
core/git_tools.py — Agent 分裂/Swarm 并行场景下的高层 Git 治理原语。

对外暴露：
- ensure_agent_worktree(session_id, worker_id, fork_depth, agent_id, base_branch)
  → 创建/返回一个子 Agent 独占的 worktree（路径、分支、fork_depth 校验）
- cleanup_agent_worktree(worktree_path) → Worker 完成后清理

底层实现调用 tools/git.py 里注册的同名工具（保证沙箱/权限/日志链路一致）。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from core.agent_context import GitAgentContext, git_agent_ctx

log = logging.getLogger("slime.core.git_tools")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WORKTREES_DIR = PROJECT_ROOT / ".slime-worktrees"
MAX_FORK_DEPTH = 2  # CLAUDE.md 硬上限


@dataclass
class AgentWorktree:
    worktree_path: Path
    branch_name: str
    session_id: str
    worker_id: str
    fork_depth: int

    def dict_for_context(self) -> dict:
        return {
            "worktree_path": str(self.worktree_path),
            "branch_name": self.branch_name,
            "session_id": self.session_id,
            "worker_id": self.worker_id,
            "fork_depth": self.fork_depth,
        }


_AGENT_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9_\-]+")


def _slug_agent_id(agent_id: str) -> str:
    return _AGENT_ID_SAFE_RE.sub("-", (agent_id or "anon").strip())[:64]


async def ensure_agent_worktree(
    *,
    session_id: str,
    worker_id: str,
    fork_depth: int,
    agent_id: str,
    task_slug: str = "",
    base_branch: str | None = None,
) -> AgentWorktree:
    """
    为分裂出的子 Worker 创建独占 worktree。

    步骤：
    1. 校验 MAX_FORK_DEPTH（>2 直接抛 ValueError，交由上层回滚）
    2. 构造分支名 slime/{agent_id}/subtask/{worker_id}-{slug}
    3. 调用 git_worktree_create（通过 tools.git 模块的函数实现，绕开沙箱注册路径）
    """
    from tools.git import git_worktree_create

    if fork_depth > MAX_FORK_DEPTH:
        raise ValueError(
            f"MAX_FORK_DEPTH={MAX_FORK_DEPTH}：当前 fork_depth={fork_depth}，禁止继续创建子 Worker worktree"
        )
    if not session_id or not worker_id:
        raise ValueError("ensure_agent_worktree 需要 session_id + worker_id")
    if not agent_id:
        raise ValueError("ensure_agent_worktree 需要 agent_id（用于构建分支名 slime/<agent_id>/...）")

    agent_slug = _slug_agent_id(agent_id)
    sess_slug = re.sub(r"[^A-Za-z0-9_\-]+", "-", session_id)[:32]
    task_slug_safe = re.sub(r"[^a-z0-9\-]+", "-", (task_slug or worker_id).lower())[:40]
    branch = base_branch or f"slime/{agent_slug}/subtask/{sess_slug}-{task_slug_safe}"

    msg = await git_worktree_create({
        "session_id": sess_slug,
        "worker_id": re.sub(r"[^A-Za-z0-9_\-]+", "-", worker_id)[:64] or worker_id,
        "base_branch": branch if branch.startswith("slime/") else "",
        "fork_depth": fork_depth,
    })
    if "[拒绝]" in msg or "[失败]" in msg:
        raise RuntimeError(msg)

    # 解析返回的 worktree 路径（第一行 ✅ 后面不解析，直接按约定拼回来）
    expected = WORKTREES_DIR / sess_slug / (re.sub(r"[^A-Za-z0-9_\-]+", "-", worker_id)[:64] or worker_id)
    return AgentWorktree(
        worktree_path=expected,
        branch_name=branch,
        session_id=sess_slug,
        worker_id=worker_id,
        fork_depth=fork_depth,
    )


async def cleanup_agent_worktree(worktree_path: str | Path, *, force: bool = False) -> None:
    from tools.git import git_worktree_remove
    msg = await git_worktree_remove({"worktree_path": str(worktree_path), "force": force})
    if "[失败]" in msg and force is False:
        # 自动重试一次 force
        msg2 = await git_worktree_remove({"worktree_path": str(worktree_path), "force": True})
        if "[失败]" in msg2:
            raise RuntimeError(msg2)
    elif "[失败]" in msg:
        raise RuntimeError(msg)


def bind_git_context_for_worker(
    *,
    agent_id: str,
    agent_name: str,
    agent_role: str,
    model_choice_resolved: str,
    session_id: str,
    subtask_id: str,
    parent_agent_id: str,
    fork_depth: int,
    task_summary: str = "",
    key_decisions: list[str] | None = None,
    transcript_ref: str = "",
) -> object:
    """
    在调用任何 git_commit / git_stage 等之前，把当前 Worker 的身份注入 contextvar。
    返回 token（caller 负责 ctx.reset(token) 或用 try/finally）。

    用法：
        token = bind_git_context_for_worker(...)
        try:
            ... 调工具 ...
        finally:
            git_agent_ctx.reset(token)
    """
    ctx = GitAgentContext(
        agent_id=agent_id,
        agent_name=agent_name,
        agent_role=agent_role,
        model_choice_resolved=model_choice_resolved,
        session_id=session_id,
        subtask_id=subtask_id,
        parent_agent_id=parent_agent_id,
        fork_depth=fork_depth,
        task_summary=task_summary,
        key_decisions=key_decisions or [],
        transcript_ref=transcript_ref,
    )
    return git_agent_ctx.set(ctx)
