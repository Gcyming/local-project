"""SILAM 原生模型适配器（4E 阶段：内置模型）。

设计原则：
- SILAM 是 Slime Agent 的**默认原生模型**
- llama/Qwen 等外部模型作为**可选插件**（可加可不加）
- 通过 Provider 配置系统切换，无需修改核心推理逻辑

集成方式：
1. 新增 core/silam.py：SILAM 模型适配器
2. 修改 core/llm.py：检测 silam provider 时走本地引擎
3. 保留现有 provider 系统（agnes/deepseek/llama 等）
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import AsyncIterator

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "pilot model"))
from silam_core.engine import SILAMEngine  # noqa: E402
from silam_core.config import SilamConfig  # noqa: E402
from silam_core.pretrained import load_pretrained  # noqa: E402

logger = logging.getLogger("slime.silam")


class SilamProvider:
    """SILAM 原生模型 Provider。

    用法（slime.toml）：
    ```toml
    [[providers]]
    key = "silam"
    name = "SILAM-Σ"
    api_base = "local"
    models = ["silam-v1"]
    ```
    """

    def __init__(self, cfg: SilamConfig | None = None,
                 backbone_path: str | None = None):
        self.cfg = cfg or SilamConfig()
        self.engine: SILAMEngine | None = None
        self._backbone_path = backbone_path
        self._initialized = False

    def initialize(self) -> bool:
        """延迟初始化引擎（首次调用时加载权重）。"""
        if self._initialized:
            return self.engine is not None

        self._initialized = True
        try:
            self.engine = SILAMEngine(cfg=self.cfg)
            if self._backbone_path:
                bp = Path(self._backbone_path)
                if bp.exists():
                    load_pretrained(self.engine, str(bp))
                    logger.info(f"[silam] 已装载蒸馏权重 {bp}")
                else:
                    logger.warning(f"[silam] 权重文件不存在: {bp}，使用随机初始化")
            else:
                logger.info("[silam] 使用随机初始化 mock 主干")
            return self.engine is not None
        except Exception as e:
            logger.error(f"[silam] 初始化失败: {e}")
            self.engine = None
            return False

    async def chat_completion(self, messages: list[dict], **kwargs) -> dict:
        """模拟 OpenAI chat/completions 接口，返回 SILAM 决策。"""
        if not self.initialize():
            return {"error": "SILAM 未初始化", "choices": []}

        # 提取状态文本（从 last user message）
        state_text = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                state_text = msg.get("content", "")
                break

        # 调用 SILAM 引擎
        fear = kwargs.get("fear_level")
        desire = kwargs.get("desire_level")
        r = self.engine.forward(state_text, fear_level=fear, desire_level=desire)

        # 构建 OpenAI 兼容响应
        action = r.tool_call
        response_text = self._format_response(r)

        return {
            "id": f"chatcmpl-silam-{r.step}",
            "object": "chat.completion",
            "created": int(asyncio.get_event_loop().time()),
            "model": "silam-v1",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": response_text,
                    "action_code": r.code,
                    "tool_call": action,
                    "fear": r.new_fear,
                    "desire": r.new_desire,
                    "nodes": r.n_nodes,
                },
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": len(state_text),
                "completion_tokens": 1,
                "total_tokens": len(state_text) + 1,
            },
        }

    async def chat_completion_stream(self, messages: list[dict], **kwargs) -> AsyncIterator[str]:
        """流式版本（SILAM 决策是即时的，这里模拟流式输出）。"""
        result = await self.chat_completion(messages, **kwargs)
        choice = result["choices"][0]["message"]
        content = choice["content"]

        # 模拟流式输出（实际是即时返回）
        yield self._sse_event("chat.completion.chunk", result["id"], content[:50])
        yield self._sse_event("chat.completion.chunk", result["id"], content[50:])
        yield self._sse_event("chat.completion.chunk", result["id"], "")

    def _format_response(self, r) -> str:
        """将 SILAM 决策格式化为自然语言响应。"""
        lines = [
            f"[SILAM 本能决策]",
            f"动作: {r.code}",
            f"工具: {r.tool_call['tool']}",
            f"恐惧: {r.new_fear:.2f} | 渴望: {r.new_desire:.2f}",
            f"节点: {r.n_nodes}/{r.max_nodes}",
        ]
        if r.grew_node_idx is not None:
            lines.append(f"新记忆节点: #{r.grew_node_idx}")
        if r.activated_nodes:
            lines.append(f"激活节点: {r.activated_nodes[:3]}")
        return "\n".join(lines)

    def _sse_event(self, event: str, id: str, data: str) -> str:
        """构建 SSE 事件。"""
        return f"event: {event}\ndata: {data}\n\n"

    def health(self) -> dict:
        """健康检查。"""
        return {
            "status": "ok" if self.engine else "error",
            "service": "silam",
            "step": self.engine.step_count if self.engine else 0,
            "n_nodes": self.engine.dendrites.n if self.engine else 0,
        }


# 模块级单例
_silam_provider: SilamProvider | None = None


def get_silam_provider() -> SilamProvider | None:
    """获取全局 SILAM Provider 实例。"""
    return _silam_provider


def init_silam_provider(cfg_path: str | None = None,
                        backbone_path: str | None = None) -> SilamProvider:
    """初始化全局 SILAM Provider。"""
    global _silam_provider
    if _silam_provider is None:
        from silam_core.config import SilamConfig
        cfg = SilamConfig.from_toml(cfg_path) if cfg_path else SilamConfig()
        _silam_provider = SilamProvider(cfg=cfg, backbone_path=backbone_path)
    return _silam_provider
