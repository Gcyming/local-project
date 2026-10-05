"""
slime 上下文压缩引擎
- Per-Agent 配置：head + tail + window
- 对话超过 window（或估算 token 越过上下文预算）时自动压缩
- 前 head 轮 + 后 tail 轮完整保留，中间用 LLM 摘要替代
- 压缩产物严格 turn 对齐、严格 user/assistant 交替（Anthropic 系连发同角色直接 400）
- 中间段摘要按前缀增量续写（同一段历史不重复发摘要请求）

对齐 core-ts/src/services/context_compress.ts（countTurns / needsCompress /
trimTurnAligned / buildCompactedHistory）。
"""

import hashlib
import logging



DEFAULT_CONTEXT_CONFIG = {
    "head": 3,
    "tail": 10,
    "window": 30,
    "token_ratio": 0.85,
    "min_turns": 2,
}


_TOKEN_RATIO_MIN = 0.5
_TOKEN_RATIO_MAX = 0.97

_MESSAGE_OVERHEAD_TOKENS = 30
_CJK_RANGES = (
    (0x3000, 0x303F),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0xFF00, 0xFFEF),
)

_MERGEABLE_ROLES = ("user", "assistant")

_SUMMARY_MAX_CHARS = 6000
_SUMMARY_INPUT_MAX_MESSAGES = 24
_SUMMARY_FINGERPRINTS_MAX = 400
_SUMMARY_MEMO_MAX_OWNERS = 64

_SUMMARY_USER_HEADER = "[上下文压缩] 以下是之前对话的摘要:"
_SUMMARY_ACK = "（已收录以上摘要，在此基础上继续当前任务）"


_SUMMARY_MEMO: dict = {}


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    for lo, hi in _CJK_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def estimate_tokens(text: str) -> int:
    """本地 token 估算：CJK 按 1 字 1 token，其余按 4 字符 1 token。
    与 core-ts estimateTokensLocal 同一口径。"""
    if not text:
        return 0
    cjk = 0
    for ch in text:
        if _is_cjk(ch):
            cjk += 1
    other = len(text) - cjk
    return int(round(cjk + other / 4))


def content_to_text(content) -> str:
    """content 统一转纯文本：字符串原样；content-blocks 数组拼接各 text 块。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                parts.append(b["text"])
        return "".join(parts)
    if content is None:
        return ""
    return str(content)


def estimate_history_tokens(history: list[dict]) -> int:
    """整段历史的 token 估算（含每条消息的固定开销）。"""
    total = 0
    for m in history or []:
        if not isinstance(m, dict):
            continue
        total += _MESSAGE_OVERHEAD_TOKENS + estimate_tokens(content_to_text(m.get("content")))
    return total


def count_turns(history: list[dict]) -> int:
    """对话轮数 = user 消息条数（对齐 core-ts countTurns）。"""
    n = 0
    for m in history or []:
        if isinstance(m, dict) and m.get("role") == "user":
            n += 1
    return n


def trim_turn_aligned(history: list[dict], keep: int) -> list[dict]:
    """从尾部取至多 keep 条，并向左对齐到 user 消息边界（一个完整轮次）。
    对齐 core-ts trimTurnAligned 的语义，但 keep 的单位仍是消息条数（Python 侧原口径）。"""
    if not history:
        return []
    start = max(0, len(history) - max(1, int(keep)))
    while start < len(history):
        m = history[start]
        if isinstance(m, dict) and m.get("role") == "user":
            break
        start += 1
    return list(history[start:])


def _trim_head_aligned(head_msgs: list[dict]) -> list[dict]:
    """head 段右对齐到 assistant：只保留收尾完整的轮次，避免半轮悬空。"""
    out = list(head_msgs)
    while out and not (isinstance(out[-1], dict) and out[-1].get("role") == "assistant"):
        out.pop()
    return out


def align_roles(messages: list[dict]) -> list[dict]:
    """强制 user/assistant 严格交替（首条必须是 user）。

    相邻同角色的 user/assistant 合并为一条（内容以空行拼接，不丢任何正文）；
    其他角色的相邻重复只保留首条。history 里的 system 条目直接剔除——
    system 已经在第 0 条消息位置，重复出现会被 Anthropic 系判为非法。
    """
    out: list[dict] = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if not role or role == "system":
            continue
        if not out:
            if role != "user":
                continue
            out.append(m)
            continue
        prev = out[-1]
        if prev.get("role") != role:
            out.append(m)
            continue
        if role in _MERGEABLE_ROLES:
            body = content_to_text(prev.get("content"))
            add = content_to_text(m.get("content"))
            merged = dict(prev)
            merged["content"] = f"{body}\n\n{add}" if add else body
            out[-1] = merged
    return out


def _fingerprint(message: dict) -> str:
    role = str(message.get("role", "")) if isinstance(message, dict) else ""
    body = content_to_text(message.get("content")) if isinstance(message, dict) else ""
    return hashlib.sha1(f"{role}\x00{body}".encode("utf-8")).hexdigest()


def _memo_put(owner_id: str, fingerprints: list[str], text: str) -> None:
    if not owner_id:
        return
    if owner_id not in _SUMMARY_MEMO and len(_SUMMARY_MEMO) >= _SUMMARY_MEMO_MAX_OWNERS:
        _SUMMARY_MEMO.pop(next(iter(_SUMMARY_MEMO)), None)
    _SUMMARY_MEMO[owner_id] = {
        "fingerprints": list(fingerprints[-_SUMMARY_FINGERPRINTS_MAX:]),
        "text": text[:_SUMMARY_MAX_CHARS],
    }


def reset_summary_memo(owner_id: str | None = None) -> None:
    """清空摘要增量缓存（owner_id 为空则全清）。"""
    if owner_id is None:
        _SUMMARY_MEMO.clear()
    else:
        _SUMMARY_MEMO.pop(owner_id, None)


class ContextCompressor:
    """Per-Agent 上下文压缩器"""

    def __init__(self, config: dict | None = None, token_budget: int = 0,
                 owner_id: str = ""):
        self.config = {**DEFAULT_CONTEXT_CONFIG, **(config or {})}
        self.token_budget = int(token_budget or 0)
        self.owner_id = owner_id or ""

    def update_config(self, config: dict):
        """更新压缩配置"""
        self.config.update(config)

    def effective_token_ratio(self) -> float:
        """生效的 token 触发比例（夹到 GUI 的 [RATIO_MIN, RATIO_MAX] 区间）。"""
        ratio = self.config.get("token_ratio", 0.85)
        try:
            ratio = float(ratio)
        except (TypeError, ValueError):
            ratio = 0.85
        return min(max(ratio, _TOKEN_RATIO_MIN), _TOKEN_RATIO_MAX)

    def needs_compression(self, history: list[dict]) -> bool:
        """判断是否需要压缩。

        两条触发口径（向 GUI 侧对齐）：
        - 条数：len(history) > window；
        - token：估算 token 越过 token_budget * token_ratio（GUI 的 needsCompress）。
        token_budget <= 0 时只走条数口径（保持旧构造方式的行为不变）。
        两条口径都要求「确实有中间段可摘」：轮数不足 head + tail 时压缩只会重复消息。
        """
        if not history:
            return False
        head = max(0, int(self.config["head"]))
        tail = max(1, int(self.config["tail"]))
        if len(history) <= head + tail:
            return False
        if len(history) > int(self.config["window"]):
            return True
        if self.token_budget <= 0:
            return False
        if count_turns(history) < max(1, int(self.config.get("min_turns", 2))):
            return False
        return estimate_history_tokens(history) >= self.token_budget * self.effective_token_ratio()

    def _plan(self, history: list[dict]) -> tuple[list[dict], list[dict], list[dict] | None]:
        """拆 head / tail / middle。middle=None 表示无需压缩。"""
        if not self.needs_compression(history):
            return [], [], None
        head_n = max(0, int(self.config["head"]))
        tail_n = max(1, int(self.config["tail"]))
        history = list(history)
        head_msgs = _trim_head_aligned(history[:head_n])
        tail_msgs = trim_turn_aligned(history, tail_n)
        if not tail_msgs:
            tail_msgs = history[-tail_n:]
        cut = max(len(head_msgs), len(history) - len(tail_msgs))
        middle = history[len(head_msgs):cut]
        return head_msgs, tail_msgs, middle

    def compress(self, history: list[dict],
                 summary_fn=None) -> list[dict]:
        """
        压缩对话历史（同步版本，无摘要或无事件循环时使用）。
        - 保留前 head 条完整（尾部对齐到 assistant 的完整轮次）
        - 保留后 tail 条完整（头部对齐到 user 的完整轮次）
        - 中间部分直接丢弃（无摘要）
        - 产物经 align_roles 规整，除 system 外不存在连续同角色

        参数:
        - history: 完整对话历史 [{role, content}, ...]
        - summary_fn: 异步摘要函数 async fn(messages) -> str（同步版本中不调用）

        返回: 压缩后的消息列表
        """
        head_msgs, tail_msgs, middle = self._plan(history)
        if middle is None:
            return history
        compressed = head_msgs + tail_msgs
        aligned = align_roles(compressed)
        return aligned if aligned else compressed

    async def compress_async(self, history: list[dict],
                             summary_fn=None) -> list[dict]:
        """
        压缩对话历史（异步版本，在事件循环中使用）。
        - 保留前 head 轮 + 后 tail 轮（均 turn 对齐）
        - 中间部分用 LLM 摘要替代，摘要落成 user + assistant 一对完整轮次
        - 产物经 align_roles 规整，除 system 外不存在连续同角色
        - 摘要按「已覆盖前缀」增量续写：中间段没变就不再发摘要请求

        参数:
        - history: 完整对话历史 [{role, content}, ...]
        - summary_fn: 异步摘要函数 async fn(prompt) -> str

        返回: 压缩后的消息列表
        """
        head_msgs, tail_msgs, middle = self._plan(history)
        if middle is None:
            return history

        compressed = head_msgs + tail_msgs
        if summary_fn and middle:
            summary = await self._summarize_middle(middle, summary_fn)
            compressed = head_msgs + [
                {"role": "user", "content": f"{_SUMMARY_USER_HEADER}\n{summary}"},
                {"role": "assistant", "content": _SUMMARY_ACK},
            ] + tail_msgs

        aligned = align_roles(compressed)
        return aligned if aligned else compressed

    async def _summarize_middle(self, middle: list[dict], summary_fn) -> str:
        """摘要中间段：命中增量缓存前缀时只续写新增部分，否则整段重摘要。"""
        fingerprints = [_fingerprint(m) for m in middle]
        memo = _SUMMARY_MEMO.get(self.owner_id) if self.owner_id else None
        covered = 0
        if memo:
            prev = memo.get("fingerprints") or []
            limit = min(len(prev), len(fingerprints))
            while covered < limit and prev[covered] == fingerprints[covered]:
                covered += 1
            if covered == len(fingerprints) and covered:
                return memo.get("text") or ""
        prior = (memo.get("text") or "") if covered else ""
        pending = middle[covered:]
        delta = await summary_fn(self._build_summary_prompt(pending, prior))
        text = delta if not prior else f"{prior}\n{delta}".strip()
        _memo_put(self.owner_id, fingerprints, text)
        return text

    def _build_summary_prompt(self, messages: list[dict], prior: str = "") -> str:
        conversation = "\n".join(
            f"[{m.get('role', '')}]: {content_to_text(m.get('content'))[:500]}"
            for m in messages[:_SUMMARY_INPUT_MAX_MESSAGES]
        )
        if not prior:
            return f"请用 2-3 句话总结以下对话的核心内容:\n\n{conversation}"
        return (
            "以下是此前已压缩过的摘要（必须完整保留其全部要点，不许丢弃或改写）:\n"
            f"{prior}\n\n"
            "以及此后新增的对话:\n"
            f"{conversation}\n\n"
            "请输出**一份完整**的中文摘要：在原摘要基础上扩充新增信息，"
            "不是补丁、不是差异。"
        )

    def get_compression_stats(self) -> dict:
        """获取压缩统计信息"""
        return {
            "head": self.config["head"],
            "tail": self.config["tail"],
            "window": self.config["window"],
            "token_ratio": self.config.get("token_ratio", 0.85),
            "token_budget": self.token_budget,
            "trigger": "count_or_token",
        }


def compress_history(history: list[dict], config: dict | None = None) -> list[dict]:
    """便捷函数：压缩对话历史（无摘要版本）"""
    compressor = ContextCompressor(config)
    return compressor.compress(history)
