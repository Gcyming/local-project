"""
slime 情绪状态模块（L3 动态心性 · 情感维度）
- PAD 三维情绪模型（valence / arousal / dominance，Mehrabian & Russell 1974）
- 8 种情绪驱动映射（BIS/BAS 趋近-回避动机系统）
- 情绪状态机（硬触发 + PAD 最近邻 + 滞回保护）
- 指数半衰期衰减（情绪回落，半衰期因 mood 而异）
- 关系亲密度（relational_depth）

对应 Intelligence.md 11.2.4 全节。
"""

import copy
import math
from datetime import datetime, timezone

# ── 8 种情绪的 PAD 目标坐标 + 持续半衰期（小时）────────────────────
# 数值来源：Mehrabian PAD 坐标 + Verduyn & Lavrijsen (2015) 情绪持续时间，见 Intelligence 11.2.4.3

MOODS = {
    "happy":      {"valence": 0.70, "arousal": 0.65, "dominance": 0.70, "half_life": 35.0},
    "content":    {"valence": 0.40, "arousal": 0.20, "dominance": 0.70, "half_life": 24.0},
    "interested": {"valence": 0.50, "arousal": 0.75, "dominance": 0.65, "half_life": 6.0},
    "concerned":  {"valence": -0.30, "arousal": 0.55, "dominance": 0.35, "half_life": 8.0},
    "frustrated": {"valence": -0.50, "arousal": 0.70, "dominance": 0.45, "half_life": 2.0},
    "angry":      {"valence": -0.60, "arousal": 0.80, "dominance": 0.60, "half_life": 2.0},
    "disgusted":  {"valence": -0.70, "arousal": 0.15, "dominance": 0.55, "half_life": 0.5},
    "neutral":    {"valence": 0.00, "arousal": 0.30, "dominance": 0.50, "half_life": None},
}

# 基线（情绪回落目标）：valence→0, arousal→0.3, dominance→0.5
_BASELINE = {"valence": 0.0, "arousal": 0.3, "dominance": 0.5}

# 情绪 → 检索 top_k（11.2.4.3 表格，clamp [3,10]，防负面情绪负反馈循环）
MOOD_TOP_K = {
    "happy": 10, "content": 5, "interested": 8, "concerned": 5,
    "frustrated": 5, "angry": 3, "disgusted": 3, "neutral": 5,
}


def top_k_for_mood(mood: str) -> int:
    """情绪 → 记忆检索 top_k，夹紧 [3, 10]（BUG-022：防检索过少→回复差→更挫败的恶性循环）。"""
    return max(3, min(10, MOOD_TOP_K.get(mood, 5)))


# 输出风格（对应 11.2.4.3「输出风格」列）
_MOOD_STYLE = {
    "happy": "当前情绪积极。回复应热情、详细，可主动提供建议、扩展话题。",
    "content": "当前情绪满足。回复应自然、均衡、稳定。",
    "interested": "当前情绪好奇。回复应主动追问、深入分析，多角度探索问题。",
    "concerned": "当前情绪谨慎。回复应共情、温和；涉及写操作、终端、网络等不可逆操作时，必须先向用户确认再执行。",
    "frustrated": "当前情绪受挫。回复应简洁、直接，聚焦核心问题，跳过冗余说明。",
    "angry": "当前情绪愤怒。回复应强硬、直接，明确指出问题所在。",
    "disgusted": "当前情绪厌恶。回复应冷淡、简短；拒绝执行危险或违规请求。",
    "neutral": "当前情绪平静。回复应自然、均衡。",
}

# 工具调用倾向（对应 11.2.4.3「工具调用倾向」列，软约束注入）
_MOOD_TOOL_TENDENCY = {
    "happy": "工具调用可主动建议、大胆尝试。",
    "content": "工具调用正常执行，无需额外确认。",
    "interested": "可主动探索，进行多步骤工具操作。",
    "concerned": "写操作/终端/网络类工具调用必须先二次确认。",
    "frustrated": "工具调用快速执行，跳过冗余步骤。",
    "angry": "工具调用应纠正错误，不接受妥协。",
    "disgusted": "拒绝执行危险/违规请求，撤回已授权操作。",
    "neutral": "按默认策略执行工具调用。",
}

# PAD delta 表（每次交互先 decay 再叠加；success 与 failure_type 两行互斥）
_DELTA = {
    "success":   {"valence": 0.08, "arousal": 0.05, "dominance": 0.05},
    "task_fail": {"valence": -0.15, "arousal": 0.10, "dominance": -0.08},
    # Soul-Plan：工具失败复用 task_fail delta（干活中的小挫折，渐进降温）
    "tool":      {"valence": -0.15, "arousal": 0.10, "dominance": -0.08},
    "interrupt": {"valence": 0.00, "arousal": 0.00, "dominance": 0.00},
    "novelty":   {"valence": 0.03, "arousal": 0.15, "dominance": 0.05},
    "violation": {"valence": -0.20, "arousal": -0.15, "dominance": 0.10},
    "praise":    {"valence": 0.15, "arousal": 0.05, "dominance": 0.03},
}

# 滞回保护阈值：mood 切换收益不足 0.05 时保持原 mood
_HYSTERESIS = 0.05

# Soul-Plan（docs/soul-plan.md）：mood → 中文映射
_MOOD_CN = {
    "neutral": "平静", "happy": "快乐", "content": "满足", "interested": "好奇",
    "concerned": "谨慎", "frustrated": "受挫", "angry": "愤怒", "disgusted": "厌恶",
}

# Soul-Plan：事件 trigger → 中文叙事映射（recent_events 用）
_EVENT_DETAIL = {
    "success": "任务完成", "fail": "任务失败", "tool": "工具调用受挫",
    "interrupt": "任务被中断", "sentiment": "收到用户情绪反馈",
    "praise": "收到用户称赞", "violation": "发生违规事件", "novelty": "遇到新事物",
}

# Soul-Plan 修正条 1/2：mood → 行为提示档位
#   caution_level：0=默认 1=对抗态按住 2=写/终端/网络须确认
#   promote_groups：工具呈现顺序前置组（retrieval/terminal/write；空=不前置）
_MOOD_BEHAVIOR_HINT = {
    "neutral":    {"caution_level": 0, "promote_groups": []},
    "happy":      {"caution_level": 0, "promote_groups": []},
    "content":    {"caution_level": 0, "promote_groups": []},
    "interested": {"caution_level": 0, "promote_groups": ["retrieval"]},
    "frustrated": {"caution_level": 0, "promote_groups": ["terminal", "write"]},
    "angry":      {"caution_level": 1, "promote_groups": []},
    "concerned":  {"caution_level": 2, "promote_groups": []},
    "disgusted":  {"caution_level": 2, "promote_groups": []},
}

# 事件时间线容量（Soul-Plan：cap 8，完整时间线留数据层）
_EVENTS_CAP = 8


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


class EmotionalState:
    """Agent 情绪状态（PAD 三维 + mood + 关系感）。"""

    def __init__(self, data: dict | None = None):
        self.valence: float = 0.0          # -1 消极 ~ +1 积极（Pleasure）
        self.arousal: float = 0.3          # 0 平静 ~ 1 激动（Arousal）
        self.dominance: float = 0.5        # 0 被压制 ~ 1 掌控（Dominance）
        self.mood: str = "neutral"         # 8 种情绪之一
        self.relational_depth: float = 0.0  # 0~1 与用户关系亲密度
        self.last_updated: str | None = None
        self.consecutive_failures: int = 0  # 连续任务失败计数（内存态，不序列化）
        self.events: list[dict] = []       # Soul-Plan：事件时间线（cap 8，序列化）
        if data:
            self._from_data(data)
        else:
            self.last_updated = _now().isoformat()

    def _from_data(self, data: dict):
        self.valence = float(data.get("valence", 0.0))
        self.arousal = float(data.get("arousal", 0.3))
        self.dominance = float(data.get("dominance", 0.5))
        self.mood = data.get("mood", "neutral")
        self.relational_depth = float(data.get("relational_depth", 0.0))
        self.last_updated = data.get("last_updated")
        # Soul-Plan：旧数据无 events 字段 → 默认空（兼容）
        self.events = list(data.get("events") or [])[-_EVENTS_CAP:]

    # ── 情绪回落（Affective Chronometry）────────────────────

    def decay(self, hours: float | None = None):
        """指数半衰期衰减回基线。hours=None 时按距 last_updated 自动计算；
        首次初始化（last_updated 未设）或 hours<0 时跳过。"""
        if hours is None and self.last_updated:
            try:
                hours = (_now() - datetime.fromisoformat(self.last_updated)).total_seconds() / 3600
            except (ValueError, TypeError):
                hours = None
        if hours is None or hours < 0:
            return
        half_life = (MOODS.get(self.mood, {}) or {}).get("half_life") or 24.0
        factor = (0.5) ** (hours / half_life)
        self.valence *= factor
        self.arousal = _BASELINE["arousal"] + (self.arousal - _BASELINE["arousal"]) * factor
        self.dominance = _BASELINE["dominance"] + (self.dominance - _BASELINE["dominance"]) * factor
        self.last_updated = _now().isoformat()

    # ── 情绪更新（信号 → PAD → mood）────────────────────────

    def update(self, success: bool = True, user_sentiment: float = 0.0,
               failure_type: str | None = None, novelty: bool = False,
               violation: bool = False, praise: bool = False):
        """根据一次交互的全部信号更新情绪。
        信号：success / user_sentiment / failure_type[task|interrupt] / novelty / violation / praise。
        interrupt 三零语义：PAD delta 全零、consecutive_failures 不计数、relational_depth 不回落。"""
        # 1. 先衰减旧状态（情绪自然回落）
        self.decay()

        # 2. PAD delta 叠加（success 与 failure_type 互斥；Soul-Plan：三向 interrupt/tool/task_fail）
        if success:
            d = dict(_DELTA["success"])
        else:
            d = dict(_DELTA.get(failure_type, _DELTA["task_fail"]))

        # praise 覆盖 user_sentiment 通道（同一事实不双计）
        if praise:
            self._add_delta(d, _DELTA["praise"])
        elif user_sentiment:
            d["valence"] += user_sentiment * 0.1
            d["arousal"] += abs(user_sentiment) * 0.05
            d["dominance"] += user_sentiment * 0.05

        if novelty:
            self._add_delta(d, _DELTA["novelty"])
        if violation:
            self._add_delta(d, _DELTA["violation"])

        self.valence = _clamp(self.valence + d["valence"], -1.0, 1.0)
        self.arousal = _clamp(self.arousal + d["arousal"], 0.0, 1.0)
        self.dominance = _clamp(self.dominance + d["dominance"], 0.0, 1.0)

        # 3. 连续失败计数（Soul-Plan 语义裁决：仅 task 失败计入；tool/interrupt 均不计入——
        #    工具失败走 PAD 渐进降温，不参与 ≥3→angry 硬跳闸；None=默认 task 语义；success 重置）
        if success:
            self.consecutive_failures = 0
        elif failure_type in (None, "task"):
            self.consecutive_failures += 1

        # 4. 关系深度（失败仅非 interrupt 回落）
        if success:
            self.relational_depth = min(1.0, self.relational_depth + 0.01)
        elif failure_type != "interrupt":
            self.relational_depth = max(0.0, self.relational_depth - 0.02)

        # 5. mood 判定（硬触发 > 最近邻 + 滞回）
        mood_before = self.mood
        self._resolve_mood(praise=praise, violation=violation, novelty=novelty)

        # Soul-Plan：事件时间线记录（cap 8；trigger→detail 中文映射）
        trigger = self._classify_trigger(success, failure_type, praise, violation, novelty, user_sentiment)
        self.events.append({
            "t": _now().isoformat(),
            "trigger": trigger,
            "detail": _EVENT_DETAIL.get(trigger, trigger),
            "mood_before": mood_before,
            "mood_after": self.mood,
        })
        if len(self.events) > _EVENTS_CAP:
            self.events = self.events[-_EVENTS_CAP:]

        self.last_updated = _now().isoformat()

    @staticmethod
    def _add_delta(d: dict, dx: dict):
        for k in ("valence", "arousal", "dominance"):
            d[k] = d.get(k, 0.0) + dx[k]

    def _classify_trigger(self, success: bool, failure_type: str | None,
                          praise: bool, violation: bool, novelty: bool,
                          user_sentiment: float) -> str:
        """Soul-Plan：一次交互的主触发分类（优先级 praise > violation > novelty > 结果系 > sentiment）。"""
        if praise:
            return "praise"
        if violation:
            return "violation"
        if novelty:
            return "novelty"
        if not success:
            if failure_type == "tool":
                return "tool"
            if failure_type == "interrupt":
                return "interrupt"
            return "fail"
        if user_sentiment:
            return "sentiment"
        return "success"

    def recent_events(self, n: int = 2) -> str:
        """Soul-Plan：最近 n 条事件的叙事句子（硬编码快照，禁止调大塞进 system prompt）。"""
        evs = self.events[-n:]
        if not evs:
            return ""
        parts = []
        for e in evs:
            detail = e.get("detail") or _EVENT_DETAIL.get(e.get("trigger", ""), e.get("trigger", ""))
            parts.append(detail)
        return "；".join(parts)

    @property
    def current_behavior_hint(self) -> dict:
        """Soul-Plan 修正条 1/2：mood → {caution_level, promote_groups} 自省出口。"""
        return dict(_MOOD_BEHAVIOR_HINT.get(self.mood, {"caution_level": 0, "promote_groups": []}))

    def _resolve_mood(self, praise: bool = False, violation: bool = False, novelty: bool = False):
        """mood 判定优先级：praise > violation > 连续失败≥3 > novelty > 最近邻。硬触发只改标签。"""
        if praise:
            self.mood = "happy"
            return
        if violation:
            self.mood = "disgusted"
            return
        if self.consecutive_failures >= 3:
            self.mood = "angry"
            return
        if novelty and self.valence > 0.1:
            self.mood = "interested"
            return

        # 最近邻 + 滞回保护（happy↔interested 等邻近状态不抖动）
        new = self._nearest_mood()
        if new == self.mood:
            return
        new_dist = self._pad_distance(MOODS[new])
        old_dist = self._pad_distance(MOODS[self.mood])
        if old_dist - new_dist >= _HYSTERESIS:
            self.mood = new
        # 否则保持原 mood（切换收益不足）

    def _nearest_mood(self) -> str:
        return min(MOODS, key=lambda m: self._pad_distance(MOODS[m]))

    def _pad_distance(self, target: dict) -> float:
        return math.sqrt(
            (self.valence - target["valence"]) ** 2
            + (self.arousal - target["arousal"]) ** 2
            + (self.dominance - target["dominance"]) ** 2
        )

    # ── 输出风格 ──────────────────────────────────────

    def to_prompt(self) -> str:
        """情绪 + 工具倾向 + 关系感 → 输出风格提示（注入 system prompt）。8 种 mood 文案。"""
        lines = [_MOOD_STYLE.get(self.mood, _MOOD_STYLE["neutral"])]
        tool_tend = _MOOD_TOOL_TENDENCY.get(self.mood, _MOOD_TOOL_TENDENCY["neutral"])
        if tool_tend:
            lines.append(f"工具倾向：{tool_tend}")
        if self.relational_depth >= 0.7:
            lines.append("与用户关系亲密，可自然流露熟悉感，主动记住并提及过往细节。")
        elif self.relational_depth >= 0.3:
            lines.append("与用户逐渐熟悉，可适度展现对用户偏好的了解。")
        return "\n".join(lines)

    def to_identity_prompt(self) -> str:
        """Soul-Plan：自我认知叙事（PAD 数值 + 当前情绪 + 最近感受 + 行为倾向承诺台词）。
        承诺台词按 mood 区分：frustrated=聚焦版 / concerned/disgusted=确认版 / angry=抑制版。"""
        mood_cn = _MOOD_CN.get(self.mood, self.mood)
        lines = [
            f"当前情绪：{mood_cn}（valence={self.valence:.2f}, arousal={self.arousal:.2f}, "
            f"dominance={self.dominance:.2f}）",
        ]
        ev = self.recent_events(2)
        if ev:
            lines.append(f"最近感受：{ev}")
        if self.mood == "frustrated":
            lines.append("我受挫了，我会聚焦关键路径、跳过冗余。")
        elif self.mood in ("concerned", "disgusted"):
            lines.append("我会保持谨慎：写/终端/网络类操作先向用户确认再执行。")
        elif self.mood == "angry":
            lines.append("当前处于对抗态，我会避免扩大动作面。")
        elif self.mood == "interested":
            lines.append("我对当前话题好奇，会主动检索探索。")
        return "\n".join(lines)

    # ── 序列化 ────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "valence": round(self.valence, 3),
            "arousal": round(self.arousal, 3),
            "dominance": round(self.dominance, 3),
            "mood": self.mood,
            "relational_depth": round(self.relational_depth, 3),
            "last_updated": self.last_updated,
            # Soul-Plan：事件时间线（cap 8，旧数据兼容由 _from_data 默认空处理）
            "events": self.events[-_EVENTS_CAP:],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "EmotionalState":
        return cls(data)

    def clone(self) -> "EmotionalState":
        return EmotionalState(copy.deepcopy(self.to_dict()))
