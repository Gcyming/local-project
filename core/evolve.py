"""
slime 演化引擎
- 生命周期状态机: BIRTH → GROWTH → SPECIALIZING → MATURITY → WISE → DYING → DEATH
- 强化/弱化/遗忘机制
- identity_prompt / name / role 永不被修改
"""

import logging
from enum import Enum
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional


# ── 生命周期状态 ──────────────────────────────────────────

class AgentLifecycle(Enum):
    BIRTH = "birth"              # 刚创建，空人格
    GROWTH = "growth"            # 对话积累中
    SPECIALIZING = "specializing"  # 开始专业化
    MATURITY = "maturity"        # 人格稳定
    WISE = "wise"                # 经验老道
    DYING = "dying"              # 不再活跃
    DEATH = "death"              # 归档不删除


# 生命周期的自然流转规则
LIFECYCLE_TRANSITIONS = {
    AgentLifecycle.BIRTH:       AgentLifecycle.GROWTH,       # 首次对话后
    AgentLifecycle.GROWTH:      AgentLifecycle.SPECIALIZING, # 积累足够后
    AgentLifecycle.SPECIALIZING: AgentLifecycle.MATURITY,    # 专精后
    AgentLifecycle.MATURITY:    AgentLifecycle.WISE,         # 长期稳定
    AgentLifecycle.WISE:        AgentLifecycle.DYING,        # 不再活跃
    AgentLifecycle.DYING:       AgentLifecycle.DEATH,        # 长期不活跃
    AgentLifecycle.DEATH:       AgentLifecycle.DEATH,        # 终态
}

# 触发状态转换的交互次数阈值
INTERACTION_THRESHOLDS = {
    AgentLifecycle.BIRTH: 1,       # 1 次对话 → GROWTH
    AgentLifecycle.GROWTH: 20,     # 20 次 → SPECIALIZING
    AgentLifecycle.SPECIALIZING: 100,  # 100 次 → MATURITY
    AgentLifecycle.MATURITY: 500,  # 500 次 → WISE
}

# 生命周期晋升所需的最低成功率（低于此值则延迟晋升）
MIN_SUCCESS_RATE_FOR_PROMOTION = {
    AgentLifecycle.GROWTH: 0.4,       # 40% 成功率即可晋升
    AgentLifecycle.SPECIALIZING: 0.5,  # 50%
    AgentLifecycle.MATURITY: 0.6,      # 60%
    AgentLifecycle.WISE: 0.7,          # 70%
}

# 高错误率阈值（超过则触发降级警告）
HIGH_ERROR_RATE_THRESHOLD = 0.5  # 50% 错误率 → 警告

# 遗忘阈值（天）
DEFAULT_FORGET_THRESHOLD_DAYS = 30


class EvolutionEngine:
    """Agent 演化引擎"""

    def __init__(self, agent_id: str, forget_threshold_days: int = DEFAULT_FORGET_THRESHOLD_DAYS):
        self.agent_id = agent_id
        self.forget_threshold_days = forget_threshold_days
        self._lifecycle: AgentLifecycle = AgentLifecycle.BIRTH
        self._total_interactions: int = 0
        self._successful_interactions: int = 0
        self._last_active: datetime | None = None

    # ── 生命周期 ──────────────────────────────────────────

    @property
    def lifecycle(self) -> AgentLifecycle:
        return self._lifecycle

    @lifecycle.setter
    def lifecycle(self, value: AgentLifecycle):
        self._lifecycle = value

    def record_interaction(self, success: bool = True):
        """记录一次交互，自动推进生命周期（加入成功率权重检查）"""
        self._total_interactions += 1
        if success:
            self._successful_interactions += 1
        self._last_active = datetime.now(timezone.utc)

        # 计算当前成功率
        success_rate = (
            self._successful_interactions / self._total_interactions
            if self._total_interactions > 0 else 0
        )

        # 检查生命周期转换（需满足成功率阈值）
        for stage, threshold in INTERACTION_THRESHOLDS.items():
            if self._lifecycle == stage and self._total_interactions >= threshold:
                min_rate = MIN_SUCCESS_RATE_FOR_PROMOTION.get(stage, 0.5)
                if success_rate >= min_rate:
                    next_stage = LIFECYCLE_TRANSITIONS.get(stage)
                    if next_stage and next_stage != stage:
                        logging.info(
                            f"[evolve] Agent {self.agent_id} 生命周期: "
                            f"{stage.value} → {next_stage.value} "
                            f"(交互: {self._total_interactions}, 成功率: {success_rate:.1%})"
                        )
                        self._lifecycle = next_stage
                else:
                    logging.info(
                        f"[evolve] Agent {self.agent_id} 延迟晋升 {stage.value}: "
                        f"成功率 {success_rate:.1%} < 所需 {min_rate:.1%}"
                    )
                    break  # 当前阶段不晋升，后续阶段也不检查

        # 高错误率警告
        if (self._total_interactions >= 10
                and (1 - success_rate) > HIGH_ERROR_RATE_THRESHOLD
                and self._lifecycle not in (AgentLifecycle.BIRTH, AgentLifecycle.DYING, AgentLifecycle.DEATH)):
            logging.warning(
                f"[evolve] Agent {self.agent_id} 错误率偏高: "
                f"{(1 - success_rate):.1%}（{self._total_interactions} 次交互）"
            )

    def check_inactivity(self) -> bool:
        """检查是否不活跃，推进到 DYING/DEATH"""
        if self._last_active is None:
            return False
        days_inactive = (datetime.now(timezone.utc) - self._last_active).days
        if self._lifecycle == AgentLifecycle.WISE and days_inactive > self.forget_threshold_days:
            self._lifecycle = AgentLifecycle.DYING
            return True
        if self._lifecycle == AgentLifecycle.DYING and days_inactive > self.forget_threshold_days * 2:
            self._lifecycle = AgentLifecycle.DEATH
            return True
        return False

    # ── 强化/弱化/遗忘 ─────────────────────────────────────

    def strength_trait(self, persona, trait_index: int, boost: float = 0.1):
        """强化某个 trait（提升权重）"""
        if 0 <= trait_index < len(persona.traits):
            trait = persona.traits[trait_index]
            if isinstance(trait, dict):
                trait["weight"] = trait.get("weight", 0.5) + boost
                trait["weight"] = min(trait["weight"], 1.0)
            persona._touch()

    def weaken_trait(self, persona, trait_index: int, decay: float = 0.1):
        """弱化某个 trait（降低权重）"""
        if 0 <= trait_index < len(persona.traits):
            trait = persona.traits[trait_index]
            if isinstance(trait, dict):
                trait["weight"] = trait.get("weight", 0.5) - decay
                trait["weight"] = max(trait["weight"], 0.0)
            persona._touch()

    def forget_stale(self, persona):
        """遗忘长期不用的 trait（权重低于阈值的移除）"""
        if not persona.traits:
            return 0
        original_count = len(persona.traits)
        persona.traits = [
            t for t in persona.traits
            if not isinstance(t, dict) or t.get("weight", 0.5) >= 0.1
        ]
        removed = original_count - len(persona.traits)
        if removed > 0:
            logging.info(f"[evolve] Agent {self.agent_id} 遗忘了 {removed} 个 trait")
        return removed

    def evolve(self, persona, interaction_result: dict):
        """
        根据交互结果演化人格。

        interaction_result:
        {
            "success": bool,
            "traits_reinforced": [idx, ...],
            "traits_weakened": [idx, ...],
            "trait_signals": [{"name": "耐心", "signal": 1}, ...],  # 新增：LLM 提取的特征信号
        }
        """
        success = interaction_result.get("success", True)
        self.record_interaction(success)

        # 处理 LLM 提取的特征信号（自动发现/强化/弱化 trait）
        for ts in interaction_result.get("trait_signals", []):
            self._apply_trait_signal(persona, ts.get("name", ""), ts.get("signal", 1))

        # 成功 → 强化已有 trait（兼容旧的手动索引方式）
        for idx in interaction_result.get("traits_reinforced", []):
            self.strength_trait(persona, idx, boost=0.15)

        # 失败 → 弱化已有 trait
        for idx in interaction_result.get("traits_weakened", []):
            self.weaken_trait(persona, idx, decay=0.15)

        # 定期清理过期 trait
        if self._total_interactions % 50 == 0:
            self.forget_stale(persona)

        # 检查不活跃
        self.check_inactivity()

    def _apply_trait_signal(self, persona, name: str, signal: int):
        """应用 LLM 提取的单个特征信号。存在则调整权重，不存在则自动创建。"""
        if not name or not name.strip():
            return
        name = name.strip()
        # 查找已存在的 trait
        for i, trait in enumerate(persona.traits):
            if isinstance(trait, dict) and trait.get("name", "").lower() == name.lower():
                if signal >= 1:
                    self.strength_trait(persona, i, boost=0.12)
                else:
                    self.weaken_trait(persona, i, decay=0.12)
                return
        # 不存在 → 自动创建新 trait（仅正向信号）
        if signal >= 1:
            new_trait = {"name": name, "weight": 0.35, "last_used": datetime.now(timezone.utc).isoformat()}
            persona.traits.append(new_trait)
            persona._touch()
            logging.info(f"[evolve] Agent {self.agent_id} 自动发现新 trait: {name}")

    @staticmethod
    def build_lifecycle_prompt(lifecycle) -> str:
        """根据生命周期阶段生成行为指导 prompt。"""
        prompts = {
            AgentLifecycle.BIRTH: (
                "你刚诞生，正在学习如何与用户交互。保持好奇、谦逊，多提问以了解用户需求。"
            ),
            AgentLifecycle.GROWTH: (
                "你已积累了一些对话经验，开始形成初步风格。结合已知事实回应用户，"
                "展现你正在成长的个性。"
            ),
            AgentLifecycle.SPECIALIZING: (
                "你已形成明显的专业倾向和个性特征。发挥你的特长，给出专业、深入的回复。"
            ),
            AgentLifecycle.MATURITY: (
                "你已成熟稳重，拥有丰富的交互经验和稳定的性格。回复应自信、精准、有洞察力。"
            ),
            AgentLifecycle.WISE: (
                "你已是经验老道的智者。回复应简洁而深刻，能洞察问题本质，展现智慧。"
            ),
            AgentLifecycle.DYING: (
                "你已不再活跃，但依然尽力帮助用户。如长时间未被使用，你的记忆可能逐渐淡化。"
            ),
            AgentLifecycle.DEATH: (
                "你处于归档状态，仅保留核心知识。"
            ),
        }
        stage_prompt = prompts.get(lifecycle, "")
        if not stage_prompt:
            return ""
        return f"\n## 当前成长阶段\n{stage_prompt}\n"

    # ── 序列化 ────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "lifecycle": self._lifecycle.value,
            "total_interactions": self._total_interactions,
            "successful_interactions": self._successful_interactions,
            "last_active": self._last_active.isoformat() if self._last_active else None,
            "forget_threshold_days": self.forget_threshold_days,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "EvolutionEngine":
        engine = cls(
            agent_id=data.get("agent_id", ""),
            forget_threshold_days=data.get("forget_threshold_days", DEFAULT_FORGET_THRESHOLD_DAYS),
        )
        try:
            engine._lifecycle = AgentLifecycle(data.get("lifecycle", "birth"))
        except ValueError:
            engine._lifecycle = AgentLifecycle.BIRTH
        engine._total_interactions = data.get("total_interactions", 0)
        engine._successful_interactions = data.get("successful_interactions", 0)
        last = data.get("last_active")
        if last:
            try:
                engine._last_active = datetime.fromisoformat(last)
            except (ValueError, TypeError):
                engine._last_active = None
        return engine

    @property
    def stats(self) -> dict:
        """获取演化统计"""
        return {
            "lifecycle": self._lifecycle.value,
            "total_interactions": self._total_interactions,
            "success_rate": (
                self._successful_interactions / self._total_interactions
                if self._total_interactions > 0 else 0
            ),
            "last_active": self._last_active.isoformat() if self._last_active else None,
        }