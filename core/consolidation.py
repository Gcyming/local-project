"""
slime 沉淀引擎（L3 → L2）
- 把 L3 动态心性中反复出现的模式，沉淀为 L2 半固定行为模式
- 对应 Intelligence.md 12.6「习惯成自然」：量变到质变
- 触发：每 N 次交互；过程：高频 pattern 强化/新建 + 长期未用弱化
"""

import logging

logger = logging.getLogger(__name__)


class ConsolidationEngine:
    """沉淀引擎：L3 高频模式 → L2 行为习惯。"""

    # 每 N 次交互触发一次沉淀（量变到质变）
    CONSOLIDATE_INTERVAL = 50
    # 长期未强化（天）则弱化
    DECAY_DAYS = 30

    def should_consolidate(self, agent) -> bool:
        """判断是否触发沉淀。"""
        total = (agent.evolution or {}).get("total_interactions", 0)
        return total > 0 and total % self.CONSOLIDATE_INTERVAL == 0

    def consolidate(self, agent, knowledge_engine=None, existing_scenarios: set | None = None):
        """沉淀过程：
        1. 知识引擎的高频 pattern → 行为模式（跳过已存在的 scenario，避免与 LLM 提取重复）
        2. 弱化长期未用的模式（艾宾浩斯）
        返回 (reinforced, decayed) 计数。
        """
        existing_scenarios = existing_scenarios or set()
        reinforced = 0

        # 1. 高频 pattern → 行为模式（知识引擎兜底，仅补 LLM 未覆盖的）
        if knowledge_engine is not None:
            try:
                for pt in knowledge_engine.get_promotable_traits()[:3]:
                    if pt["name"] not in existing_scenarios:
                        agent.behavior.reinforce(
                            scenario=pt["name"],
                            steps=["检测模式", "应用规则", "验证结果"],
                            source=f"knowledge-engine:{pt['source']}",
                        )
                        reinforced += 1
            except Exception as e:
                logger.debug(f"[consolidation] 知识引擎沉淀失败: {e}")

        # 2. 弱化长期未用的模式
        # Soul-Plan 第 6 步：decay 返回 (weakened, archived)——归档条目写入记忆
        # （lessons + tags=["behavior_archive"] + importance=6 + 原 confidence/usage_count），
        # 从活跃层移除（记忆层只增不删；再巩固起点 max(0.3, 原confidence×0.5)）
        decayed, archived = agent.behavior.decay(days=self.DECAY_DAYS)
        for pat in archived:
            try:
                from core.memory import load_memory
                mem = load_memory(agent.id)
                mem._store_categorized(
                    "lesson",
                    f"行为归档：场景「{pat.scenario}」的步骤 {pat.steps[:3]}（现已不是习惯，仅供参考）",
                    tags=["behavior_archive"],
                    importance=6,
                    extra={"success": True,
                           "archived_confidence": getattr(pat, "confidence", 0.0),
                           "usage_count": getattr(pat, "usage_count", 0)},
                )
                agent.behavior.archive(pat)
                logging.info(f"[consolidation] 行为归档: {pat.scenario}")
            except Exception as e:
                logging.warning(f"[consolidation] 行为归档失败: {e}")
        if reinforced or decayed or archived:
            logger.info(
                f"[consolidation] 沉淀: 新建/强化 {reinforced} 个模式，弱化 {decayed} 个"
            )
        return reinforced, decayed
