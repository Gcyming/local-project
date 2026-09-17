"""
slime A2A (Agent-to-Agent) 通信总线
- 子 Agent 间共享信息、相互交流
- 基于 asyncio.Queue 的内存消息总线
"""

import asyncio
import logging
import re as _re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

# 历史消息上限（防御性限制，防止极端场景内存泄漏）
MAX_HISTORY = 500
# 消息 TTL（秒），超过此时间的消息自动回收（N10-L1）
HISTORY_TTL = 86400  # 24h
# 单条消息内容上限（A-112: 防超长内容占满队列/内存；LLM 输出受 MAX_OUTPUT 间接约束，此处兜底）
MAX_CONTENT = 100_000


def _truncate_content(content: str, from_agent: str) -> str:
    """超限消息截断并打 warning（不丢消息，只裁剪内容）"""
    if len(content) > MAX_CONTENT:
        logging.warning(
            f"[a2a] 消息超限截断: {len(content)} → {MAX_CONTENT} 字符（from={from_agent}）"
        )
        return content[:MAX_CONTENT]
    return content


@dataclass
class A2AMessage:
    """A2A 消息"""
    id: str
    from_agent: str       # 发送者 Agent 名称
    to_agent: str         # 接收者（"broadcast" = 广播给所有人）
    content: str          # 消息内容
    msg_type: str = "info"  # info / request / response / alert / done
    timestamp: float = field(default_factory=time.time)
    request_id: str = ""    # 关联的请求 ID（response 用）
    in_reply_to: str = ""   # 回复哪条消息


class A2ABus:
    """
    A2A 通信总线。
    每个 Swarm 任务创建一个独立实例，任务结束后销毁。
    """

    def __init__(self):
        self._queues: dict[str, asyncio.Queue] = {}  # agent_name -> queue
        self._history: list[A2AMessage] = []         # 所有消息历史
        self._warnings: list[str] = []               # 未投递警告

    def register(self, agent_name: str):
        """注册一个 Agent 到总线"""
        if agent_name not in self._queues:
            self._queues[agent_name] = asyncio.Queue()

    def unregister(self, agent_name: str):
        """注销 Agent"""
        self._queues.pop(agent_name, None)

    async def send(self, from_agent: str, to_agent: str, content: str,
                   msg_type: str = "info", request_id: str = "",
                   in_reply_to: str = "") -> dict:
        """
        发送消息。返回 {msg, delivered}。
        delivered 为 True 表示至少有一个接收方成功投递。
        """
        msg = A2AMessage(
            id=f"msg_{uuid.uuid4().hex[:8]}",
            from_agent=from_agent,
            to_agent=to_agent,
            content=content,
            msg_type=msg_type,
            request_id=request_id,
            in_reply_to=in_reply_to,
        )
        self._history.append(msg)
        # 防御性截断 + TTL 清理（N10-L1）
        self._prune_history()
        delivered = False

        if to_agent == "broadcast":
            # 广播给所有已注册的 Agent（除发送者）
            for name, q in self._queues.items():
                if name != from_agent:
                    await q.put(msg)
            delivered = len(self._queues) > 1  # 有除自己外的 Agent
            if not delivered:
                self._warnings.append(f"[broadcast] {from_agent} → 无其他 Agent 在线")
        else:
            # 点对点
            q = self._queues.get(to_agent)
            if q:
                await q.put(msg)
                delivered = True
            else:
                self._warnings.append(f"[{from_agent} → {to_agent}] 接收方未注册")

        return {"msg": msg, "delivered": delivered}

    async def receive(self, agent_name: str, timeout: float = 0.5) -> A2AMessage | None:
        """接收消息（非阻塞，超时返回 None）"""
        q = self._queues.get(agent_name)
        if not q:
            return None
        try:
            return await asyncio.wait_for(q.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    def drain_all(self, agent_name: str) -> list[A2AMessage]:
        """一次性取出所有待处理消息（非阻塞）"""
        q = self._queues.get(agent_name)
        if not q:
            return []
        msgs = []
        while not q.empty():
            try:
                msgs.append(q.get_nowait())
            except asyncio.QueueEmpty:
                break
        return msgs

    def get_history(self, agent_name: str | None = None) -> list[A2AMessage]:
        """
        获取消息历史。
        如果指定 agent_name，返回该 Agent 发送或接收的所有消息（含广播）。
        """
        if agent_name:
            return [m for m in self._history
                    if m.from_agent == agent_name
                    or m.to_agent == agent_name
                    or m.to_agent == "broadcast"]  # 广播也属于该 Agent 的可见范围
        return list(self._history)

    def get_shared_context(self, agent_name: str = "") -> str:
        """
        获取所有 Agent 共享的上下文摘要。
        用于让每个子 Agent 了解其他 Agent 的进展。
        所有 msg_type 的消息都纳入上下文。
        """
        if not self._history:
            return ""

        # 筛选不属于当前 Agent 自己的消息（避免重复）
        relevant = []
        for msg in self._history[-30:]:
            if agent_name and msg.from_agent == agent_name:
                continue  # 不发自己的消息
            if msg.msg_type == "done":
                relevant.append(f"- [{msg.from_agent}] ✓ 已完成: {msg.content}")
            elif msg.msg_type == "alert":
                relevant.append(f"- [{msg.from_agent}] ⚠ 警告: {msg.content}")
            elif msg.msg_type == "request":
                relevant.append(f"- [{msg.from_agent}] 请求: {msg.content}")
            elif msg.msg_type == "response":
                relevant.append(f"- [{msg.from_agent}] 回复: {msg.content}")
            else:
                relevant.append(f"- [{msg.from_agent}] {msg.content}")

        if not relevant:
            return ""

        lines = ["## 其他 Agent 的进展："]
        lines.extend(relevant[-20:])  # 最近 20 条
        return "\n".join(lines)

    def get_warnings(self) -> list[str]:
        """获取投递警告"""
        return list(self._warnings)

    def _prune_history(self):
        """TTL 清理 + 上限截断（N10-L1）"""
        now = time.time()
        self._history = [m for m in self._history if now - m.timestamp < HISTORY_TTL]
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

    def clear(self):
        """清空所有状态"""
        self._queues.clear()
        self._history.clear()
        self._warnings.clear()


# ── 常驻 A2A 总线（服务级生命周期）────────────────────────────

# 委托标记协议：Agent 回复中的 <DELEGATE> 会被解析并路由到子 Agent
# 格式：<DELEGATE name="子Agent名">子任务描述</DELEGATE>
# 子 Agent 完成后，结果通过 <DELEGATE_RESULT name="子Agent名">结果</DELEGATE_RESULT> 回传

_DELEGATE_RE = _re.compile(
    r'<DELEGATE\s+name="([^"]+)"\s*>(.*?)</DELEGATE>',
    _re.DOTALL,
)
_DELEGATE_RESULT_RE = _re.compile(
    r'<DELEGATE_RESULT\s+name="([^"]+)"\s*>(.*?)</DELEGATE_RESULT>',
    _re.DOTALL,
)


def parse_delegations(reply: str) -> list[dict]:
    """从 Agent 回复中解析委托指令。返回 [{name, task}, ...]。
    N10-S1: 平衡标签解析器——逐个字符计数嵌套深度，匹配正确的闭合标签。
    """
    results = []
    pos = 0
    open_tag = "<DELEGATE"
    close_tag = "</DELEGATE>"
    while True:
        # 找开标签 <DELEGATE name="...">
        idx = reply.find(open_tag, pos)
        if idx == -1:
            break
        # 提取 name 属性
        tag_end = reply.find(">", idx)
        if tag_end == -1:
            break
        tag_content = reply[idx + len(open_tag):tag_end]
        name_match = _re.search(r'name="([^"]*)"', tag_content)
        if not name_match:
            pos = tag_end + 1
            continue
        name = name_match.group(1).strip()[:64]
        if not name:
            pos = tag_end + 1
            continue
        # 从 > 之后开始计数嵌套深度，找平衡闭合标签
        depth = 1
        scan = tag_end + 1
        while depth > 0 and scan < len(reply):
            next_open = reply.find(open_tag, scan)
            next_close = reply.find(close_tag, scan)
            if next_close == -1:
                break  # 无闭合标签，放弃
            if next_open != -1 and next_open < next_close:
                depth += 1
                scan = next_open + len(open_tag)
            else:
                depth -= 1
                if depth == 0:
                    task = reply[tag_end + 1:next_close].strip()[:2000]
                    if task:
                        results.append({"name": name, "task": task})
                    scan = next_close + len(close_tag)
                    break
                scan = next_close + len(close_tag)
        pos = max(scan, tag_end + 1)
    return results


def parse_delegation_results(reply: str) -> list[dict]:
    """从 Agent 回复中解析委托结果。返回 [{name, result}, ...]"""
    return [{"name": m.group(1).strip(), "result": m.group(2).strip()}
            for m in _DELEGATE_RESULT_RE.finditer(reply)]


def build_delegation_prompt(children: list[dict], all_agents: list[str] | None = None) -> str:
    """构建委托能力的 system prompt 片段，告知父 Agent 可用子 Agent 列表和广播能力"""
    lines = [
        "\n## Agent 通信能力",
        "你可以通过以下方式与其他 Agent 协作：",
        "",
    ]

    # 点对点委托
    if children:
        lines.append("### 点对点委托")
        lines.append("将子任务委托给特定子 Agent：")
        lines.append("")
        for c in children:
            lines.append(f"- **{c['name']}**（{c.get('role', '')}）→ `<DELEGATE name=\"{c['name']}\">具体子任务</DELEGATE>`")
        lines.append("")

    # 广播
    if all_agents:
        other_agents = [n for n in all_agents if n not in {c.get('name', '') for c in children}]
        all_names = [c['name'] for c in children] + other_agents
        if len(all_names) > 1:
            lines.append("### 广播")
            lines.append("需要通知所有 Agent 或征集意见时，使用广播：")
            lines.append(f"`<BROADCAST>消息内容</BROADCAST>`")
            lines.append(f"可广播的 Agent：{', '.join(all_names)}")
            lines.append("")

    lines.append("### 使用规则：")
    lines.append("1. 点对点委托：当子任务明显属于特定子 Agent 的专业领域时使用")
    lines.append("2. 广播：当需要多个 Agent 的意见、或需要通知全体时使用")
    lines.append("3. 一次回复最多 3 个委托标记 + 1 个广播标记")
    lines.append("4. 所有标记会从显示文本中自动移除，用户看不到")
    lines.append("5. 委托/广播结果会自动回填，你可以基于结果继续回复用户")
    return "\n".join(lines)

# 广播标记正则
_BROADCAST_RE = _re.compile(
    r'<BROADCAST\s*>(.*?)</BROADCAST>',
    _re.DOTALL,
)


def parse_broadcast(reply: str) -> str | None:
    """从 Agent 回复中解析广播内容。返回广播消息文本或 None。"""
    m = _BROADCAST_RE.search(reply)
    return m.group(1).strip() if m else None


def strip_delegation_tags(text: str) -> str:
    """移除委托和广播标记，返回干净的显示文本。
    N10-S1: 平衡标签移除——逐对匹配开闭标签，不依赖非贪婪正则。
    """
    # 移除 <DELEGATE>...</DELEGATE>（平衡解析）
    while True:
        idx = text.find("<DELEGATE")
        if idx == -1:
            break
        tag_end = text.find(">", idx)
        if tag_end == -1:
            break
        # 找平衡闭合标签
        depth = 1
        scan = tag_end + 1
        found = False
        while depth > 0 and scan < len(text):
            no = text.find("<DELEGATE", scan)
            nc = text.find("</DELEGATE>", scan)
            if nc == -1:
                break
            if no != -1 and no < nc:
                depth += 1
                scan = no + len("<DELEGATE")
            else:
                depth -= 1
                if depth == 0:
                    text = text[:idx] + text[nc + len("</DELEGATE>"):]
                    found = True
                    break
                scan = nc + len("</DELEGATE>")
        if not found:
            break
    # 移除 <DELEGATE_RESULT>...</DELEGATE_RESULT>
    text = _DELEGATE_RESULT_RE.sub("", text)
    # 移除 <BROADCAST>...</BROADCAST>
    text = _BROADCAST_RE.sub("", text)
    # 清理残留的孤立闭合标签（如绕过攻击遗留的 </DELEGATE>）
    text = text.replace("</DELEGATE>", "").replace("</DELEGATE_RESULT>", "")
    return text.strip()


class ServerA2ABus:
    """
    常驻 A2A 消息总线（服务级生命周期）。

    与任务级 A2ABus 不同，ServerA2ABus 在 server 启动时创建、关闭时销毁。
    持久 Agent 通过此总线进行跨会话通信。

    用法：
    - server 启动时创建单例
    - Agent 加载后 register()
    - 委托任务通过 delegate() 发送
    - 接收方通过 receive() / drain_all() 获取消息
    """

    _instance: "ServerA2ABus | None" = None
    _instance_lock = threading.Lock()  # N10-M4: 竞态保护

    def __init__(self):
        import asyncio
        self._queues: dict[str, asyncio.Queue] = {}
        self._history: list[A2AMessage] = []
        self._warnings: list[str] = []
        with ServerA2ABus._instance_lock:
            ServerA2ABus._instance = self

    @classmethod
    def get(cls) -> "ServerA2ABus | None":
        return cls._instance

    def register(self, agent_name: str):
        import asyncio
        if agent_name not in self._queues:
            self._queues[agent_name] = asyncio.Queue()

    def unregister(self, agent_name: str):
        self._queues.pop(agent_name, None)

    async def delegate(self, from_agent: str, to_agent: str,
                       task: str) -> dict:
        """委托任务给子 Agent。返回 {msg_id, delivered}。"""
        task = _truncate_content(task, from_agent)
        msg = A2AMessage(
            id=f"msg_{uuid.uuid4().hex[:8]}",
            from_agent=from_agent,
            to_agent=to_agent,
            content=task,
            msg_type="request",
        )
        self._history.append(msg)
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

        q = self._queues.get(to_agent)
        if q:
            await q.put(msg)
            return {"msg_id": msg.id, "delivered": True}
        self._warnings.append(f"[delegate] {from_agent} → {to_agent}: 接收方未注册")
        return {"msg_id": msg.id, "delivered": False}

    async def send(self, from_agent: str, to_agent: str, content: str,
                   msg_type: str = "info", request_id: str = "") -> dict:
        """通用发送：点对点或广播。to_agent="broadcast" 时发给所有已注册 Agent。"""
        content = _truncate_content(content, from_agent)
        msg = A2AMessage(
            id=f"msg_{uuid.uuid4().hex[:8]}",
            from_agent=from_agent,
            to_agent=to_agent,
            content=content,
            msg_type=msg_type,
            request_id=request_id,
        )
        self._history.append(msg)
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

        if to_agent == "broadcast":
            delivered = 0
            for name, q in self._queues.items():
                if name != from_agent:
                    await q.put(msg)
                    delivered += 1
            if delivered == 0:
                self._warnings.append(f"[broadcast] {from_agent} → 无其他 Agent 在线")
            return {"msg_id": msg.id, "delivered": delivered > 0, "count": delivered}
        else:
            q = self._queues.get(to_agent)
            if q:
                await q.put(msg)
                return {"msg_id": msg.id, "delivered": True}
            self._warnings.append(f"[send] {from_agent} → {to_agent}: 接收方未注册")
            return {"msg_id": msg.id, "delivered": False}

    async def send_result(self, from_agent: str, to_agent: str,
                          result: str, request_id: str = "") -> dict:
        """子 Agent 回传委托结果。等同于 send(..., msg_type="response")。"""
        return await self.send(from_agent, to_agent, result, msg_type="response", request_id=request_id)

    async def broadcast(self, from_agent: str, content: str,
                        msg_type: str = "info") -> dict:
        """广播消息给所有已注册 Agent（除发送者外）。返回 {msg_id, delivered, count}。"""
        return await self.send(from_agent, "broadcast", content, msg_type)

    def get_registered_names(self) -> list[str]:
        """返回所有已注册 Agent 名称列表"""
        return list(self._queues.keys())

    async def receive(self, agent_name: str, timeout: float = 0.3) -> A2AMessage | None:
        """接收消息（非阻塞，超时返回 None）"""
        q = self._queues.get(agent_name)
        if not q:
            return None
        try:
            import asyncio
            return await asyncio.wait_for(q.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    def drain_all(self, agent_name: str) -> list[A2AMessage]:
        """一次性取出所有待处理消息（同步，仅限无事件循环时使用）"""
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

    async def drain_all_async(self, agent_name: str) -> list[A2AMessage]:
        """一次性取出所有待处理消息（异步安全）"""
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

    def get_history(self, agent_name: str | None = None) -> list[A2AMessage]:
        if agent_name:
            return [m for m in self._history
                    if m.from_agent == agent_name
                    or m.to_agent == agent_name
                    or m.to_agent == "broadcast"]
        return list(self._history)

    def get_warnings(self) -> list[str]:
        return list(self._warnings)

    def _prune_history(self):
        """TTL 清理 + 上限截断（N10-L1）"""
        now = time.time()
        self._history = [m for m in self._history if now - m.timestamp < HISTORY_TTL]
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

    def clear(self):
        self._queues.clear()
        self._history.clear()
        self._warnings.clear()