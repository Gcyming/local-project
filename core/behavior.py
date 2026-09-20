"""
slime 行为模式模块（L2 半固定层）
- BehaviorPattern：场景 → 步骤（习惯/做事方式）
- BehaviorStore：管理行为模式，沉淀（L3→L2）+ 艾宾浩斯衰减
- 对应「夺舍」核心：行为模式属于 Agent，不随模型切换而丢失
"""

import copy
import uuid
from datetime import datetime, timezone

# 艾宾浩斯衰减（行为模式同样遵循「不用就淡」）
_BEHAVIOR_DECAY_DAYS = 30


class BehaviorPattern:
    """单个行为模式：某个场景下养成的做事步骤。"""

    def __init__(self, pattern_id: str, scenario: str, steps: list[str],
                 confidence: float = 0.3, usage_count: int = 0,
                 last_reinforced: str = "", source: str = "",
                 decision_rationale: str = ""):
        self.id = pattern_id
        self.scenario = scenario
        self.steps = steps if isinstance(steps, list) else []
        self.confidence = confidence
        self.usage_count = usage_count
        self.last_reinforced = last_reinforced
        self.source = source
        self.decision_rationale = decision_rationale  # BUG-019: 为什么这样做（夺舍继承推理）

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "scenario": self.scenario,
            "steps": self.steps,
            "confidence": round(self.confidence, 3),
            "usage_count": self.usage_count,
            "last_reinforced": self.last_reinforced,
            "source": self.source,
            "decision_rationale": self.decision_rationale,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "BehaviorPattern":
        return cls(
            pattern_id=data.get("id", ""),
            scenario=data.get("scenario", ""),
            steps=data.get("steps", []),
            confidence=data.get("confidence", 0.3),
            usage_count=data.get("usage_count", 0),
            last_reinforced=data.get("last_reinforced", ""),
            source=data.get("source", ""),
            decision_rationale=data.get("decision_rationale", ""),
        )


class BehaviorStore:
    """行为模式存储（L2）。半固定：低频更新，不随单次交互剧变。"""

    def __init__(self, patterns: list[BehaviorPattern] | None = None):
        self.patterns: list[BehaviorPattern] = patterns or []

    # ── 沉淀（L3 → L2）────────────────────────────────

    def reinforce(self, scenario: str, steps: list[str], source: str = "",
                  rationale: str = "") -> BehaviorPattern:
        """强化已有模式或新建模式。返回模式对象。BUG-019: 携带 decision_rationale。"""
        now = datetime.now(timezone.utc).isoformat()
        for p in self.patterns:
            if p.scenario == scenario:
                p.usage_count += 1
                p.confidence = min(1.0, p.confidence + 0.05)
                p.last_reinforced = now
                if steps:
                    p.steps = steps  # 更新步骤（习惯可能微调）
                if rationale:
                    p.decision_rationale = rationale
                return p
        # 新模式（初始 confidence 较低，需多次重复才稳定）
        pattern = BehaviorPattern(
            pattern_id=f"pat_{uuid.uuid4().hex[:8]}",
            scenario=scenario,
            steps=steps,
            confidence=0.3,
            usage_count=1,
            last_reinforced=now,
            source=source,
            decision_rationale=rationale,
        )
        self.patterns.append(pattern)
        return pattern

    def decay(self, days: int = _BEHAVIOR_DECAY_DAYS) -> tuple[int, list]:
        """Soul-Plan 第 6 步：艾宾浩斯衰减 + 归档标记。
        长期未强化 → confidence 下降；confidence < 0.15 → 标记待归档
        （返回 archived 列表，调用方写入记忆后从活跃层移除——"遗忘"= 归档不是删除）。
        返回 (weakened, archived)。"""
        now = datetime.now(timezone.utc)
        weakened = 0
        archived = []
        for p in self.patterns:
            if not p.last_reinforced:
                continue
            try:
                age = (now - datetime.fromisoformat(p.last_reinforced)).days
            except (ValueError, TypeError):
                continue
            if age > days:
                p.confidence = max(0.1, p.confidence - 0.1)
                weakened += 1
            if p.confidence < 0.15:
                archived.append(p)
        return weakened, archived

    def archive(self, pattern) -> None:
        """Soul-Plan 第 6 步：从活跃层移除（降级到记忆层，非删除）。"""
        try:
            self.patterns.remove(pattern)
        except ValueError:
            pass

    def reconsolidate(self, scenario: str, steps: list[str],
                      archived_confidence: float = 0.0, source: str = "",
                      rationale: str = "") -> "BehaviorPattern":
        """Soul-Plan 第 6 步：归档条目再巩固回活跃层，起点 max(0.3, 原confidence × 0.5)。
        A-103：先查重——scenario 已存在则强化（usage_count+1、confidence 提升）而非新建，
        防同一归档条目多次召回在活跃层堆重复模式。"""
        now = datetime.now(timezone.utc).isoformat()
        for p in self.patterns:
            if p.scenario == scenario:
                p.usage_count += 1
                p.confidence = min(1.0, p.confidence + 0.05)
                p.last_reinforced = now
                if steps:
                    p.steps = steps
                return p
        pattern = BehaviorPattern(
            pattern_id=f"pat_{uuid.uuid4().hex[:8]}",
            scenario=scenario,
            steps=steps,
            confidence=max(0.3, archived_confidence * 0.5),
            usage_count=1,
            last_reinforced=now,
            source=source or "reconsolidated",
            decision_rationale=rationale,
        )
        self.patterns.append(pattern)
        return pattern

    # ── 注入 ─────────────────────────────────────────

    def to_prompt(self, max_patterns: int = 5) -> str:
        """生成 L2 行为模式提示（只注入高置信度的稳定习惯）。BUG-019: 携带决策理由。"""
        stable = [p for p in self.patterns if p.confidence >= 0.5 and p.steps]
        if not stable:
            return ""
        stable = sorted(stable, key=lambda p: p.confidence, reverse=True)[:max_patterns]
        lines = ["## 行为模式（已养成的做事习惯）"]
        for p in stable:
            line = f"- {p.scenario}：{' → '.join(p.steps)}"
            if p.decision_rationale:
                line += f"（缘由：{p.decision_rationale}）"
            lines.append(line)
        return "\n".join(lines)

    def get_high_confidence(self, threshold: float = 0.5) -> list[BehaviorPattern]:
        return [p for p in self.patterns if p.confidence >= threshold]

    # ── 序列化 ───────────────────────────────────────

    def to_dict(self) -> dict:
        return {"patterns": [p.to_dict() for p in self.patterns]}

    @classmethod
    def from_dict(cls, data: dict) -> "BehaviorStore":
        raw = data.get("patterns", []) if isinstance(data, dict) else []
        patterns = [BehaviorPattern.from_dict(p) for p in raw if isinstance(p, dict)]
        return cls(patterns)

    def clone(self) -> "BehaviorStore":
        return BehaviorStore(copy.deepcopy(self.patterns))
