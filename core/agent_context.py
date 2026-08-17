"""
当前调用 Agent 上下文（A-048-R4：按 Agent 分配 Agnes 账号）
- 工具执行期间（core/llm.py 的 _execute_pending_tools）设置当前 Agent 的 model_choice，
  工具模块（tools/agnes_media.py）据此解析该 Agent 自己配置的 provider 密钥。
- 使用 contextvars：异步工具调用在 await 边界自动传递，无全局状态污染。
"""

from contextvars import ContextVar

# 当前正在执行工具调用的 Agent 的 model_choice（如 "api:Elysia" / "api:Agnes-5"）
# 默认空串 = 无 Agent 上下文（如 CLI 直调工具场景），工具侧回退环境变量/首匹配
current_model_choice: ContextVar[str] = ContextVar("slime_current_model_choice", default="")

# A-050: 工具执行期间的进度上报队列（asyncio.Queue | None）。
# 长耗时工具（如视频生成轮询）把 0-100 进度 put 进来，core/llm.py 的流式工具循环
# 并发读取并转发为 {"type": "progress"} 事件 → CLI 渲染进度条。
# 无执行上下文（直调）时为 None，工具侧忽略上报。
tool_progress_q: ContextVar = ContextVar("slime_tool_progress_q", default=None)

# A-050-R3: 单请求内已执行的媒体生成工具记录（list[str] | None）。
# 由 call_api_provider / call_api_provider_stream 在请求生命周期设置；
# core/llm._execute_pending_tools 据此限制 agnes_generate_image / agnes_generate_video
# 同请求合计最多 1 次（防模型"贪心"乱调：图生图时多生视频、一个视频生成两个等混乱）。
# None = 无请求上下文（直调），不限制。
media_calls_log: ContextVar = ContextVar("slime_media_calls_log", default=None)

# P1-14: 单请求内已执行过的工具调用（list[(name, args_str)] | None）。
# 由 call_api_provider / call_api_provider_stream 在请求生命周期设置；
# core/llm._execute_pending_tools 对**相同工具名+相同参数**的重复调用跳过执行
# （回填"已执行过"提示），防模型循环重复调用产生重复副作用（写入/网络请求）。
# 只在真实执行后记录：沙箱拒绝/媒体拦截/参数解析失败的调用不记录，允许重试。
# None = 无请求上下文（直调），不去重。
dedup_tools_log: ContextVar = ContextVar("slime_dedup_tools_log", default=None)

# A-083: 链式参考帧（前段末帧路径）——由 executor._worker_loop 在调用 LLM 前设置，
# core/llm._execute_pending_tools 执行 agnes_generate_video 时**强制注入** image 参数
# （模型常忘记传 image，软提示不可靠——参考帧必须硬生效才能保证画面/人物连续）。
current_ref_frame: ContextVar = ContextVar("slime_current_ref_frame", default="")
