"""
slime 统一工具注册表
- 运行时工具注册/注销
- 统一 Schema 输出给 LLM
- 工具调用执行接口
- 默认只读沙箱约束
- 线程安全（threading.Lock），同名拒绝覆盖
"""

import logging
import threading
from typing import Any, Callable, Awaitable


class Tool:
    """单个工具定义"""

    def __init__(
        self,
        name: str,
        description: str,
        parameters: dict,
        execute_fn: Callable[..., Awaitable[str]],
        permissions: list[str] | None = None,
    ):
        """
        参数:
        - name: 工具名（唯一）
        - description: 工具描述（给 LLM 看）
        - parameters: JSON Schema 格式的参数定义
        - execute_fn: 异步执行函数 async fn(args: dict) -> str
        - permissions: 所需权限列表 ["read", "write", "terminal", "network"]
        """
        self.name = name
        self.description = description
        self.parameters = parameters
        self.execute_fn = execute_fn
        self.permissions = permissions if permissions is not None else ["read"]  # 默认只读

    def to_llm_schema(self) -> dict:
        """输出给 LLM 的统一格式"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    """统一工具注册表（单例模式，线程安全）"""

    def __init__(self):
        self._tools: dict[str, Tool] = {}
        self._lock = threading.Lock()  # N11-P1-6: 保护并发读写

    def register(self, tool: Tool, force: bool = False) -> bool:
        """注册工具。N11-P1-5: 同名非 force 时拒绝（不覆盖）。返回是否成功。"""
        with self._lock:
            if tool.name in self._tools and not force:
                logging.error(f"[tools] 工具 '{tool.name}' 已存在，拒绝覆盖（force=True 可强制）")
                return False
            self._tools[tool.name] = tool
            logging.info(f"[tools] 注册工具: {tool.name} (权限: {tool.permissions})")
            return True

    def unregister(self, name: str) -> bool:
        """注销工具"""
        with self._lock:
            if name in self._tools:
                del self._tools[name]
                return True
            return False

    def get(self, name: str) -> Tool | None:
        """获取工具"""
        with self._lock:
            return self._tools.get(name)

    def list_tools(self) -> list[dict]:
        """列出所有工具（LLM 统一 Schema）"""
        with self._lock:
            return [t.to_llm_schema() for t in self._tools.values()]

    def list_tool_names(self) -> list[str]:
        """列出所有工具名"""
        with self._lock:
            return list(self._tools.keys())

    async def call_tool(self, name: str, args: dict) -> str:
        """
        调用工具。
        返回执行结果字符串。
        """
        tool = self.get(name)
        if tool is None:
            return f"[错误] 工具 '{name}' 未注册"

        try:
            result = await tool.execute_fn(args)
            return str(result)
        except Exception as e:
            logging.error(f"[tools] 工具 '{name}' 执行失败: {e}")
            return f"[错误] 工具 '{name}' 执行失败: {e}"


# ── 全局注册表 ────────────────────────────────────────────

_registry: ToolRegistry | None = None
_registry_lock = threading.Lock()  # N11-P1-6: 单例初始化锁


def get_registry() -> ToolRegistry:
    """获取全局工具注册表"""
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = ToolRegistry()
        return _registry


def reset_registry():
    """重置全局注册表（用于测试）"""
    global _registry
    with _registry_lock:
        _registry = ToolRegistry()
