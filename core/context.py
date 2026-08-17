"""
slime 上下文压缩引擎
- Per-Agent 配置：head + tail + window
- 对话超过 window 时自动压缩
- 前 head 条 + 后 tail 条完整保留，中间用 LLM 摘要
"""

import logging
from typing import Optional


# ── 默认配置 ──────────────────────────────────────────────

DEFAULT_CONTEXT_CONFIG = {
    "head": 3,     # 保留开头 N 条完整对话
    "tail": 10,    # 保留结尾 M 条完整对话
    "window": 30,  # 超过此阈值触发压缩
}


class ContextCompressor:
    """Per-Agent 上下文压缩器"""

    def __init__(self, config: dict | None = None):
        self.config = {**DEFAULT_CONTEXT_CONFIG, **(config or {})}

    def update_config(self, config: dict):
        """更新压缩配置"""
        self.config.update(config)

    def needs_compression(self, history: list[dict]) -> bool:
        """判断是否需要压缩"""
        return len(history) > self.config["window"]

    def compress(self, history: list[dict],
                 summary_fn=None) -> list[dict]:
        """
        压缩对话历史（同步版本，无摘要或无事件循环时使用）。
        - 保留前 head 条完整
        - 保留后 tail 条完整
        - 中间部分直接丢弃（无摘要）或用 LLM 摘要替代

        参数:
        - history: 完整对话历史 [{role, content}, ...]
        - summary_fn: 异步摘要函数 async fn(messages) -> str（同步版本中不调用）

        返回: 压缩后的消息列表
        """
        head = self.config["head"]
        tail = self.config["tail"]
        window = self.config["window"]

        if len(history) <= window:
            return history

        head_msgs = history[:head]
        tail_val = max(1, tail)
        tail_msgs = history[-tail_val:]

        # 同步版本：无摘要时直接丢弃中间部分
        compressed = head_msgs + tail_msgs
        return compressed

    async def compress_async(self, history: list[dict],
                             summary_fn=None) -> list[dict]:
        """
        压缩对话历史（异步版本，在事件循环中使用）。
        - 保留前 head 条完整
        - 保留后 tail 条完整
        - 中间部分用 LLM 摘要替代

        参数:
        - history: 完整对话历史 [{role, content}, ...]
        - summary_fn: 异步摘要函数 async fn(prompt) -> str

        返回: 压缩后的消息列表
        """
        head = self.config["head"]
        tail = self.config["tail"]
        window = self.config["window"]

        if len(history) <= window:
            return history

        head_msgs = history[:head]
        tail_val = max(1, tail)
        tail_msgs = history[-tail_val:]
        middle = history[head:-tail_val] if tail_val < len(history) else []

        if summary_fn and middle:
            summary = await self._build_summary_async(middle, summary_fn)
            compressed = head_msgs + [{
                "role": "user",
                "content": f"[上下文压缩] 以下是之前对话的摘要:\n{summary}",
            }] + tail_msgs
        else:
            compressed = head_msgs + tail_msgs

        return compressed

    async def _build_summary_async(self, messages: list[dict], summary_fn) -> str:
        """使用 LLM 生成中间对话摘要（异步，直接 await）"""
        try:
            conversation = "\n".join(
                f"[{m['role']}]: {m.get('content', '')[:500]}" for m in messages[:20]
            )
            prompt = f"请用 2-3 句话总结以下对话的核心内容:\n\n{conversation}"
            return await summary_fn(prompt)
        except Exception as e:
            logging.warning(f"[context] 摘要生成失败: {e}，使用截断策略")
            return f"省略了 {len(messages)} 条对话"

    def get_compression_stats(self) -> dict:
        """获取压缩统计信息"""
        return {
            "head": self.config["head"],
            "tail": self.config["tail"],
            "window": self.config["window"],
        }


def compress_history(history: list[dict], config: dict | None = None) -> list[dict]:
    """便捷函数：压缩对话历史（无摘要版本）"""
    compressor = ContextCompressor(config)
    return compressor.compress(history)