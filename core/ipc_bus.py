"""
slime IPC A2A 总线 - 多进程安全通信
- 基于 multiprocessing.Queue 和 Manager 实现跨进程 A2A 消息传递
- 与内存版 A2ABus 接口兼容，Swarm 执行器可无缝切换
- 支持广播、点对点、消息历史、共享上下文
"""

from __future__ import annotations

import time
import uuid
import logging
from dataclasses import dataclass, field
from typing import Optional
from multiprocessing import Queue, Manager, Event


# 历史消息上限
MAX_HISTORY = 500
# 队列超时（秒）
QUEUE_TIMEOUT = 0.5


@dataclass
class IPCMessage:
    """IPC A2A 消息（可序列化）"""
    id: str
    from_agent: str
    to_agent: str
    content: str
    msg_type: str = "info"
    timestamp: float = field(default_factory=time.time)
    request_id: str = ""
    in_reply_to: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "from_agent": self.from_agent,
            "to_agent": self.to_agent,
            "content": self.content,
            "msg_type": self.msg_type,
            "timestamp": self.timestamp,
            "request_id": self.request_id,
            "in_reply_to": self.in_reply_to,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "IPCMessage":
        return cls(
            id=data.get("id", ""),
            from_agent=data.get("from_agent", ""),
            to_agent=data.get("to_agent", ""),
            content=data.get("content", ""),
            msg_type=data.get("msg_type", "info"),
            timestamp=data.get("timestamp", time.time()),
            request_id=data.get("request_id", ""),
            in_reply_to=data.get("in_reply_to", ""),
        )


class IPCBus:
    """
    多进程安全的 A2A 通信总线。
    使用 multiprocessing.Manager 共享状态，Queue 传递消息。
    
    用法：
    - 主进程创建 IPCBus，register 所有 Agent
    - 子进程通过 get_worker_queue(name) 获取自己的消息队列
    - 子进程通过 send() 发送消息到其他 Agent
    - 主进程通过 get_history() / get_shared_context() 获取全局状态
    """

    def __init__(self):
        self._manager = Manager()
        self._queues: dict[str, Queue] = {}           # agent_name -> 消息队列
        self._history: list[dict] = self._manager.list()  # 共享消息历史
        self._warnings: list[str] = self._manager.list()  # 共享警告
        self._agent_names: list[str] = self._manager.list()  # 已注册 Agent 名

    def register(self, agent_name: str):
        """注册 Agent 到总线"""
        if agent_name not in self._queues:
            self._queues[agent_name] = Queue()
            self._agent_names.append(agent_name)

    def unregister(self, agent_name: str):
        """注销 Agent"""
        self._queues.pop(agent_name, None)
        if agent_name in self._agent_names:
            self._agent_names.remove(agent_name)

    def get_worker_queue(self, agent_name: str) -> Queue | None:
        """获取 Worker 的消息队列（子进程使用）"""
        return self._queues.get(agent_name)

    def get_all_agent_names(self) -> list[str]:
        """获取所有已注册 Agent 名"""
        return list(self._agent_names)

    def send(self, from_agent: str, to_agent: str, content: str,
             msg_type: str = "info", request_id: str = "",
             in_reply_to: str = "") -> dict:
        """
        发送消息（主进程或子进程均可调用）。
        返回 {msg_id, delivered}。
        """
        msg = IPCMessage(
            id=f"msg_{uuid.uuid4().hex[:8]}",
            from_agent=from_agent,
            to_agent=to_agent,
            content=content,
            msg_type=msg_type,
            request_id=request_id,
            in_reply_to=in_reply_to,
        )
        msg_dict = msg.to_dict()

        # 记录历史
        self._history.append(msg_dict)
        if len(self._history) > MAX_HISTORY:
            # 截断历史（Manager list 不支持切片赋值，需要逐个删除）
            overflow = len(self._history) - MAX_HISTORY
            for _ in range(overflow):
                self._history.pop(0)

        delivered = False

        if to_agent == "broadcast":
            for name in self._agent_names:
                if name != from_agent:
                    q = self._queues.get(name)
                    if q:
                        q.put(msg_dict)
            delivered = len(self._agent_names) > 1
            if not delivered:
                self._warnings.append(f"[broadcast] {from_agent} → 无其他 Agent 在线")
        else:
            q = self._queues.get(to_agent)
            if q:
                q.put(msg_dict)
                delivered = True
            else:
                self._warnings.append(f"[{from_agent} → {to_agent}] 接收方未注册")

        return {"msg_id": msg.id, "delivered": delivered}

    def receive(self, agent_name: str, timeout: float = QUEUE_TIMEOUT) -> dict | None:
        """
        接收消息（非阻塞，超时返回 None）。
        子进程调用此方法获取发给自己的消息。
        """
        q = self._queues.get(agent_name)
        if not q:
            return None
        try:
            return q.get(timeout=timeout)
        except Exception:
            return None

    def drain_all(self, agent_name: str) -> list[dict]:
        """一次性取出所有待处理消息（非阻塞）"""
        q = self._queues.get(agent_name)
        if not q:
            return []
        msgs = []
        while not q.empty():
            try:
                msgs.append(q.get_nowait())
            except Exception:
                break
        return msgs

    def get_history(self, agent_name: str | None = None) -> list[dict]:
        """获取消息历史"""
        if agent_name:
            return [
                m for m in self._history
                if m.get("from_agent") == agent_name
                or m.get("to_agent") == agent_name
                or m.get("to_agent") == "broadcast"
            ]
        return list(self._history)

    def get_shared_context(self, agent_name: str = "") -> str:
        """获取所有 Agent 共享的上下文摘要"""
        if not self._history:
            return ""

        relevant = []
        for msg in self._history[-30:]:
            if agent_name and msg.get("from_agent") == agent_name:
                continue
            msg_type = msg.get("msg_type", "info")
            from_agent = msg.get("from_agent", "")
            content = msg.get("content", "")
            if msg_type == "done":
                relevant.append(f"- [{from_agent}] 已完成: {content}")
            elif msg_type == "alert":
                relevant.append(f"- [{from_agent}] 警告: {content}")
            elif msg_type == "request":
                relevant.append(f"- [{from_agent}] 请求: {content}")
            elif msg_type == "response":
                relevant.append(f"- [{from_agent}] 回复: {content}")
            else:
                relevant.append(f"- [{from_agent}] {content}")

        if not relevant:
            return ""

        lines = ["## 其他 Agent 的进展："]
        lines.extend(relevant[-20:])
        return "\n".join(lines)

    def get_warnings(self) -> list[str]:
        """获取投递警告"""
        return list(self._warnings)

    def clear(self):
        """清空所有状态"""
        for q in self._queues.values():
            while not q.empty():
                try:
                    q.get_nowait()
                except Exception:
                    break
        self._queues.clear()
        # Manager list 的 clear 需要逐个 pop
        while len(self._history) > 0:
            self._history.pop()
        while len(self._warnings) > 0:
            self._warnings.pop()
        while len(self._agent_names) > 0:
            self._agent_names.pop()

    def shutdown(self):
        """关闭总线，释放 Manager 资源"""
        self.clear()
        self._manager.shutdown()