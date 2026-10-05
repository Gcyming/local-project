"""
当前调用 Agent 上下文（A-048-R4：按 Agent 分配 Agnes 账号）
- 工具执行期间（core/llm.py 的 _execute_pending_tools）设置当前 Agent 的 model_choice，
  工具模块（tools/agnes_media.py）据此解析该 Agent 自己配置的 provider 密钥。
- 使用 contextvars：异步工具调用在 await 边界自动传递，无全局状态污染。
- swarm_readonly_mode：该 Worker 被调度器判定为纯只读并与他人并行时为 True，
  core/llm.py 的 _execute_pending_tools 据此拦截写工具（见 core/swarm.py 的判定表）。
"""

from contextvars import ContextVar



current_model_choice: ContextVar[str] = ContextVar("slime_current_model_choice", default="")





tool_progress_q: ContextVar = ContextVar("slime_tool_progress_q", default=None)






media_calls_log: ContextVar = ContextVar("slime_media_calls_log", default=None)







dedup_tools_log: ContextVar = ContextVar("slime_dedup_tools_log", default=None)




current_ref_frame: ContextVar[str] = ContextVar("slime_current_ref_frame", default="")


swarm_readonly_mode: ContextVar[bool] = ContextVar("slime_swarm_readonly_mode", default=False)




class GitAgentContext:
    __slots__ = ("agent_id", "agent_name", "agent_role", "model_choice_resolved",
                 "session_id", "subtask_id", "parent_agent_id", "fork_depth",
                 "task_summary", "key_decisions", "transcript_ref")

    def __init__(self, *, agent_id: str, agent_name: str = "", agent_role: str = "",
                 model_choice_resolved: str = "", session_id: str = "",
                 subtask_id: str = "-", parent_agent_id: str = "-",
                 fork_depth: int = 0, task_summary: str = "",
                 key_decisions: list[str] | None = None,
                 transcript_ref: str = ""):
        self.agent_id = agent_id
        self.agent_name = agent_name or agent_id
        self.agent_role = agent_role or "未设定角色"
        self.model_choice_resolved = model_choice_resolved
        self.session_id = session_id
        self.subtask_id = subtask_id or "-"
        self.parent_agent_id = parent_agent_id or "-"
        self.fork_depth = fork_depth if fork_depth >= 0 else 0
        self.task_summary = task_summary
        self.key_decisions = key_decisions if key_decisions is not None else []
        self.transcript_ref = transcript_ref


git_agent_ctx: ContextVar[GitAgentContext | None] = ContextVar("slime_git_agent_ctx", default=None)
