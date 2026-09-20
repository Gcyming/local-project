"""Soul-Plan 修正条 3/4/6：A/B 影子模式统计聚合点（docs/soul-plan.md）。

四指标：①任务成功率 ②工具调用有效率 ③用户情绪均值 ④A-049 强制轮触发次数
交错式多窗口：on17 / off17 / on16 三段交替，报告周期 50 次交互。
转正判定与否决条款由外部消费方（报告）执行；本实体只负责记录与 dump。
软开关：[emotion] ab_enabled / ab_report_after（slime.toml）。
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# 交错窗口模式（修正条 6：on17 / off17 / on16，共 50 次）
_AB_WINDOWS = [("on", 17), ("off", 17), ("on", 16)]


class AbStats:
    """每 Agent A/B 影子统计。窗口按 _AB_WINDOWS 轮转。"""

    def __init__(self, agent_id: str, ab_enabled: bool = True,
                 report_after: int = 50, data_dir: str = "data"):
        self.agent_id = agent_id
        self.ab_enabled = ab_enabled
        self.report_after = max(10, int(report_after or 50))
        self.data_dir = Path(data_dir)
        self.interactions = 0
        self.task_success = 0
        self.tool_ok = 0
        self.tool_total = 0
        self.sentiment_sum = 0.0
        self.a049_triggers = 0
        self.window_idx = 0
        self.window_used = 0
        self.windows: list[dict] = []
        # A-102：窗口内独立统计（on17/off17/on16 可比——非全量累计）
        self._win_task_success = 0
        self._win_tool_ok = 0
        self._win_tool_total = 0
        self._win_sentiment_sum = 0.0
        self._win_a049 = 0

    @property
    def current_mode(self) -> str:
        return _AB_WINDOWS[self.window_idx][0] if self.ab_enabled else "off"

    def record(self, success: bool = True, tool_ok: bool | None = None,
               sentiment: float = 0.0, a049: bool = False) -> dict | None:
        """记录一次交互。返回 dump 报告（满 report_after 次时），否则 None。"""
        self.interactions += 1
        if success:
            self.task_success += 1
            self._win_task_success += 1
        if tool_ok is not None:
            self.tool_total += 1
            self._win_tool_total += 1
            if tool_ok:
                self.tool_ok += 1
                self._win_tool_ok += 1
        self.sentiment_sum += sentiment
        self._win_sentiment_sum += sentiment
        if a049:
            self.a049_triggers += 1
            self._win_a049 += 1
        # 窗口轮转（修正条 6：17/17/16；A-102：窗口记录独立统计，非全量累计）
        self.window_used += 1
        mode = self.current_mode
        if self.window_used >= _AB_WINDOWS[self.window_idx][1]:
            win_total = self._win_tool_total
            self.windows.append({
                "mode": mode,
                "n": self.window_used,
                "task_success": self._win_task_success,
                "tool_effective": (self._win_tool_ok / win_total) if win_total else 0.0,
                "sentiment_mean": (self._win_sentiment_sum / self.window_used) if self.window_used else 0.0,
                "a049_triggers": self._win_a049,
            })
            self.window_used = 0
            self.window_idx = (self.window_idx + 1) % len(_AB_WINDOWS)
            self._win_task_success = 0
            self._win_tool_ok = 0
            self._win_tool_total = 0
            self._win_sentiment_sum = 0.0
            self._win_a049 = 0
        if self.interactions >= self.report_after:
            return self.dump()
        return None

    def dump(self) -> dict:
        """生成 A/B 报告并落盘 data/ab_report_{agent}.json（四指标 + 窗口切片）。"""
        report = {
            "agent_id": self.agent_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "interactions": self.interactions,
            "task_success_rate": self.task_success / self.interactions if self.interactions else 0.0,
            "tool_effective_rate": (self.tool_ok / self.tool_total) if self.tool_total else 0.0,
            "sentiment_mean": self.sentiment_sum / self.interactions if self.interactions else 0.0,
            "a049_triggers": self.a049_triggers,
            "windows": self.windows,
        }
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            path = self.data_dir / f"ab_report_{self.agent_id}.json"
            path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            logger.info(f"[ab_stats] {self.agent_id} A/B 报告已 dump: {path}")
        except Exception as e:
            logger.warning(f"[ab_stats] dump 失败: {e}")
        return report
