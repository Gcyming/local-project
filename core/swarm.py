"""
slime Swarm 编排器
- 自动按任务拆解分裂子 Agent
- Provider 数量决定并发上限，队列排队分批执行
- 并行执行子任务
"""

import asyncio
import uuid
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable


class TaskState(Enum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass
class SubTask:
    """子任务"""
    id: str
    name: str           # 子 Agent 名称（用户可命名）
    description: str    # 任务描述
    state: TaskState = TaskState.PENDING
    result: str = ""
    error: str = ""
    progress: str = ""  # 实时进度文本
    started_at: float = 0.0
    finished_at: float = 0.0
    agent_id: str = ""  # 执行该任务的 Agent ID
    provider_key: str = ""  # 使用的 Provider
    rounds: int = 0     # 已执行轮次
    agent_name: str = ""  # A-053: 角色路由命中的持久子 Agent 名（空=临时 Worker）
    round: int = 1        # A-055: 轮次编号（轮次分工制：前一轮全部完成后才执行下一轮）
    ref_frame: str = ""  # A-063: 链式参考帧（前一段视频末帧，本段图生视频参考图）


@dataclass
class SwarmPlan:
    """分裂计划"""
    task_id: str
    original_task: str       # 用户原始任务
    subtasks: list[SubTask] = field(default_factory=list)
    max_splits: int = 1      # Provider 数量上限
    max_workers: int = 1     # 最大并发数
    created_at: float = field(default_factory=time.time)
    global_spec: str = ""    # A-057: 全局规格（风格/光线/色调/场景/人物/镜头语言），所有段共享保证联动


class SwarmOrchestrator:
    """
    Swarm 编排器：
    1. 接收用户任务
    2. 调用主 Agent 分析拆解任务
    3. 按 Provider 数量上限 + 并发限制分裂子 Agent
    4. 排队分批执行
    5. 收集结果交给 Merger
    """

    def __init__(self, providers: dict):
        """
        providers: {key: {api_base, api_key, model}} 从 encryption.decrypt() 获取
        """
        self.providers = providers
        self.max_splits = max(1, len(providers))
        self.plans: dict[str, SwarmPlan] = {}

    def get_provider_keys(self) -> list[str]:
        """返回所有可用的 provider key"""
        return list(self.providers.keys())

    def create_plan(self, task_id: str, original_task: str,
                    subtask_descriptions: list[str],
                    subtask_names: list[str] | None = None,
                    subtask_agents: list[str] | None = None,
                    subtask_rounds: list[int] | None = None,
                    max_workers: int = 2) -> SwarmPlan:
        """
        创建分裂计划。
        subtask_descriptions: 主 Agent 拆解后的子任务描述列表
        subtask_names: 用户为每个子 Agent 起的名字（可选）
        subtask_agents: A-053 角色路由——每个子任务命中的持久子 Agent 名（可选，空=临时 Worker）
        max_workers: 最大并发数（排队分批，不截断任务）
        """
        if not subtask_descriptions:
            raise ValueError("子任务列表不能为空")

        if not subtask_names:
            subtask_names = []

        plan = SwarmPlan(
            task_id=task_id,
            original_task=original_task,
            max_splits=self.max_splits,
            max_workers=min(max_workers, self.max_splits),
        )

        provider_keys = self.get_provider_keys()

        # 保留全部子任务，只用 max_workers 限并发（排队分批，不丢任务）
        for i, desc in enumerate(subtask_descriptions):
            name = subtask_names[i] if i < len(subtask_names) else f"Worker-{i + 1}"
            provider_key = provider_keys[i % len(provider_keys)] if provider_keys else ""
            agent_name = subtask_agents[i] if subtask_agents and i < len(subtask_agents) else ""
            # A-055: 轮次编号（rounds 拆解时传入；默认 1）
            round_no = int(subtask_rounds[i]) if subtask_rounds and i < len(subtask_rounds) else 1

            subtask = SubTask(
                id=f"st_{uuid.uuid4().hex[:8]}",
                name=name,
                description=desc,
                provider_key=provider_key,
                agent_name=agent_name,
                round=round_no,
            )
            plan.subtasks.append(subtask)

        self.plans[task_id] = plan
        return plan

    def mark_queued(self, task_id: str, subtask_id: str):
        """标记子任务排队中"""
        plan = self.plans.get(task_id)
        if not plan:
            return
        for st in plan.subtasks:
            if st.id == subtask_id:
                st.state = TaskState.QUEUED
                break

    def mark_running(self, task_id: str, subtask_id: str):
        """标记子任务运行中"""
        plan = self.plans.get(task_id)
        if not plan:
            return
        for st in plan.subtasks:
            if st.id == subtask_id:
                st.state = TaskState.RUNNING
                st.started_at = time.time()
                break

    def update_progress(self, task_id: str, subtask_id: str, progress: str):
        """更新子任务进度"""
        plan = self.plans.get(task_id)
        if not plan:
            return
        for st in plan.subtasks:
            if st.id == subtask_id:
                st.progress = progress
                break

    def increment_rounds(self, task_id: str, subtask_id: str):
        """增加轮次计数"""
        plan = self.plans.get(task_id)
        if not plan:
            return
        for st in plan.subtasks:
            if st.id == subtask_id:
                st.rounds += 1
                break

    def mark_done(self, task_id: str, subtask_id: str, result: str):
        """标记子任务完成"""
        plan = self.plans.get(task_id)
        if not plan:
            return
        for st in plan.subtasks:
            if st.id == subtask_id:
                st.state = TaskState.DONE
                st.result = result
                st.finished_at = time.time()
                break

    def mark_failed(self, task_id: str, subtask_id: str, error: str):
        """标记子任务失败"""
        plan = self.plans.get(task_id)
        if not plan:
            return
        for st in plan.subtasks:
            if st.id == subtask_id:
                st.state = TaskState.FAILED
                st.error = error
                st.finished_at = time.time()
                break

    def is_complete(self, task_id: str) -> bool:
        """检查所有子任务是否完成（成功或失败）"""
        plan = self.plans.get(task_id)
        if not plan:
            return True
        return all(st.state in (TaskState.DONE, TaskState.FAILED) for st in plan.subtasks)

    def get_running_count(self, task_id: str) -> int:
        """获取正在运行的子任务数"""
        plan = self.plans.get(task_id)
        if not plan:
            return 0
        return sum(1 for st in plan.subtasks if st.state == TaskState.RUNNING)

    def get_queued_count(self, task_id: str) -> int:
        """获取排队中的子任务数"""
        plan = self.plans.get(task_id)
        if not plan:
            return 0
        return sum(1 for st in plan.subtasks if st.state == TaskState.QUEUED)

    def get_done_count(self, task_id: str) -> int:
        """获取已完成的子任务数"""
        plan = self.plans.get(task_id)
        if not plan:
            return 0
        return sum(1 for st in plan.subtasks
                   if st.state in (TaskState.DONE, TaskState.FAILED))

    def get_results(self, task_id: str) -> list[SubTask]:
        """获取所有子任务结果"""
        plan = self.plans.get(task_id)
        if not plan:
            return []
        return plan.subtasks

    def get_plan(self, task_id: str) -> SwarmPlan | None:
        return self.plans.get(task_id)

    def cleanup(self, task_id: str):
        """清理已完成的任务计划"""
        self.plans.pop(task_id, None)