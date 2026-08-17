"""
slime 知识引擎 — Pattern-Key 追踪 + 知识晋升 + 周期性审查
- 借鉴 OpenClaw 的 LEARNING → RULE → SKILL → PERSONA 晋升管线
- 持久化到 Knowledge/ 目录（Obsidian vault）
- 与 Memory、Evolve、Sandbox 联动
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_KNOWLEDGE_DIR = _PROJECT_ROOT / "Knowledge" / "Agent Memory"
_DATA_DIR = _PROJECT_ROOT / "data"

# 晋升阈值
PROMOTE_THRESHOLDS = {
    "alert": 3,     # 第 3 次出现 → 升级为高风险
    "rule": 5,      # 第 5 次出现 → 晋升为行为规则
    "trait": 8,     # 第 8 次出现 → 晋升为 persona 特征
    "skill": 10,    # 第 10 次成功 → 生成为可复用技能
}

# 输入校验（N10-M3）
_VALID_CATEGORIES = {"task", "security", "learning", "skill", "behavior", "preference"}
_VALID_PRIORITIES = {"low", "medium", "high", "critical"}
_KEY_RE = re.compile(r"^[a-zA-Z0-9_.\-]+$")
# A-112: agent_id 仅允许安全字符（防御路径遍历；空串放行 = global 语义）
_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_agent_id(agent_id: str):
    """agent_id 格式校验：非法立即抛错，避免拼接路径逃逸出 agent 目录"""
    if agent_id and not _AGENT_ID_RE.match(agent_id):
        raise ValueError(f"[knowledge] 非法 agent_id: {agent_id!r}")

# 优先级权重
PRIORITY_WEIGHTS = {"critical": 100, "high": 50, "medium": 20, "low": 5}


@dataclass
class PatternEntry:
    """单个 Pattern-Key 条目"""
    key: str                    # 例: task.file-write.fail
    category: str = ""           # task / security / learning / skill
    priority: str = "medium"     # critical / high / medium / low
    recurrence: int = 0          # 重复次数
    first_seen: str = ""         # ISO timestamp
    last_seen: str = ""
    description: str = ""        # 人类可读描述
    related_rules: list[str] = field(default_factory=list)   # 关联的晋升规则 ID
    resolved: bool = False       # 是否已处理

    def to_dict(self) -> dict:
        return {
            "key": self.key, "category": self.category,
            "priority": self.priority, "recurrence": self.recurrence,
            "first_seen": self.first_seen, "last_seen": self.last_seen,
            "description": self.description, "related_rules": self.related_rules,
            "resolved": self.resolved,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PatternEntry":
        return cls(
            key=data.get("key", ""), category=data.get("category", ""),
            priority=data.get("priority", "medium"),
            recurrence=data.get("recurrence", 0),
            first_seen=data.get("first_seen", ""),
            last_seen=data.get("last_seen", ""),
            description=data.get("description", ""),
            related_rules=data.get("related_rules", []),
            resolved=data.get("resolved", False),
        )


@dataclass
class KnowledgeRule:
    """晋升后的持久规则"""
    id: str
    title: str
    category: str               # behavior / security / skill / preference
    content: str
    source_pattern: str = ""     # 来源 Pattern-Key
    created_at: str = ""
    active: bool = True

    def to_markdown(self) -> str:
        """渲染为 Obsidian markdown"""
        tags = " ".join(f"#{t}" for t in [self.category, "rule"])
        return (
            f"---\n"
            f"id: {self.id}\n"
            f"category: {self.category}\n"
            f"source: {self.source_pattern}\n"
            f"created: {self.created_at}\n"
            f"active: {self.active}\n"
            f"tags: [{self.category}, rule]\n"
            f"---\n\n"
            f"# {self.title}\n\n"
            f"{self.content}\n"
        )


class KnowledgeEngine:
    """
    知识引擎：Pattern-Key 追踪 + 晋升管线。

    管线流程：
    1. 事件触发 → record_pattern(key, category, description)
    2. 达到阈值 → promote() 生成 Rule
    3. Rule 积累 → generate_skill() 生成可复用技能
    4. 长期稳定 → 写入 Persona trait
    """

    def __init__(self, agent_id: str = "", data_dir: str = ""):
        _validate_agent_id(agent_id)
        self.agent_id = agent_id
        self._patterns: dict[str, PatternEntry] = {}
        self._rules: list[KnowledgeRule] = []
        base = Path(data_dir) if data_dir else _KNOWLEDGE_DIR
        if not base.is_absolute():
            base = _PROJECT_ROOT / base
        # A-011: 所有输出（knowledge.json / rules/ / generated_skills/）都锚定 base 目录，
        # 修复此前 _write_rule_markdown/generate_skill 无视 data_dir 恒写项目目录的隔离缺陷
        # （测试污染生产 Knowledge/ 目录的隐患）。默认无 data_dir 时行为不变。
        self._base_dir = base
        self._json_path = base / (agent_id or "global") / "knowledge.json"
        self._load()

    # ── 持久化 ──────────────────────────────────────────────

    def _load(self):
        # 迁移：旧 data/ 位置有数据但新位置没有 → 复制
        old_path = _DATA_DIR / (self.agent_id or "global") / "knowledge.json"
        if old_path.exists() and not self._json_path.exists():
            try:
                self._json_path.parent.mkdir(parents=True, exist_ok=True)
                import shutil
                shutil.move(str(old_path), str(self._json_path))
                logger.info(f"[knowledge] 已从 {old_path} 迁移到 {self._json_path}")
            except OSError as e:
                logger.warning(f"[knowledge] 迁移失败: {e}")
        if self._json_path.exists():
            try:
                data = json.loads(self._json_path.read_text(encoding="utf-8"))
                self._patterns = {
                    k: PatternEntry.from_dict(v)
                    for k, v in data.get("patterns", {}).items()
                }
                self._rules = [
                    KnowledgeRule(
                        id=r.get("id", ""), title=r.get("title", ""),
                        category=r.get("category", ""), content=r.get("content", ""),
                        source_pattern=r.get("source_pattern", ""),
                        created_at=r.get("created_at", ""),
                        active=r.get("active", True),
                    ) if isinstance(r, dict) else r
                    for r in data.get("rules", [])
                ]
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"[knowledge] 加载失败: {e}")

    def _save(self):
        self._json_path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "patterns": {k: v.to_dict() for k, v in self._patterns.items()},
            "rules": [r.__dict__ if hasattr(r, '__dict__') else r for r in self._rules],
        }
        import os, tempfile
        raw = json.dumps(data, ensure_ascii=False, indent=2)
        tmp = self._json_path.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(raw, encoding="utf-8")
        os.replace(tmp, self._json_path)

    # ── Pattern 追踪 ────────────────────────────────────────

    def record_pattern(self, key: str, category: str = "task",
                       description: str = "", priority: str = "medium") -> dict:
        """
        记录一个 Pattern 出现。返回 {action, ...} 指示触发晋升则 action 不为空。
        N10-M3: key/category/priority 白名单校验，非法输入降级为 safe defaults。
        """
        # 输入校验
        if not isinstance(key, str) or not _KEY_RE.match(key):
            logger.warning(f"[knowledge] 非法 pattern key: {key!r}")
            return {"action": None, "error": "invalid_key"}
        if category not in _VALID_CATEGORIES:
            category = "task"
        if priority not in _VALID_PRIORITIES:
            priority = "medium"
        now = datetime.now(timezone.utc).isoformat()
        if key in self._patterns:
            p = self._patterns[key]
            p.recurrence += 1
            p.last_seen = now
            if description and not p.description:
                p.description = description
        else:
            p = PatternEntry(
                key=key, category=category, priority=priority,
                recurrence=1, first_seen=now, last_seen=now,
                description=description,
            )
            self._patterns[key] = p

        result = {"action": None, "key": key, "recurrence": p.recurrence}

        # 检查晋升阈值
        if p.recurrence >= PROMOTE_THRESHOLDS["alert"] and p.priority != "critical":
            _escalate = {"low": "medium", "medium": "high", "high": "critical"}
            p.priority = _escalate.get(p.priority, "high")
            result["action"] = "escalate"
            result["new_priority"] = p.priority
            logger.info(f"[knowledge] Pattern 升级: {key} → {p.priority} (×{p.recurrence})")

        if p.recurrence >= PROMOTE_THRESHOLDS["rule"] and not p.related_rules:
            rule = self.promote_to_rule(p)
            if rule:
                p.related_rules.append(rule.id)
                result["action"] = "promote_to_rule"
                result["rule"] = rule.id

        if p.recurrence >= PROMOTE_THRESHOLDS["trait"]:
            result["action"] = "promote_to_trait"
            result["trait_name"] = self._key_to_trait_name(key)

        if p.recurrence >= PROMOTE_THRESHOLDS["skill"] and category in ("task", "learning"):
            result["action"] = "promote_to_skill"
            result["skill_name"] = self._key_to_skill_name(key)

        self._save()
        return result

    def _key_to_trait_name(self, key: str) -> str:
        """从 Pattern-Key 提取 trait 名。例: task.code-review.success → 代码审查"""
        parts = key.split(".")
        # 取倒数第二个有意义的部分
        for part in reversed(parts):
            if part not in ("success", "fail", "task", "security", "learning"):
                return part.replace("-", " ").title()
        return parts[-1].replace("-", " ").title() if parts else key

    def _key_to_skill_name(self, key: str) -> str:
        """从 Pattern-Key 提取技能名"""
        parts = key.split(".")
        return "_".join(p.replace("-", "_") for p in parts[1:3] if p not in ("success", "fail"))

    # ── 晋升管线 ────────────────────────────────────────────

    def promote_to_rule(self, pattern: PatternEntry) -> KnowledgeRule | None:
        """将高频 Pattern 晋升为持久行为规则，写入 Knowledge/ 目录"""
        now = datetime.now(timezone.utc).isoformat()
        rule_id = f"rule_{uuid.uuid4().hex[:8]}"

        # 根据 category 生成 rule 内容
        templates = {
            "security": (
                f"## 安全规则\n"
                f"模式 `{pattern.key}` 触发了 {pattern.recurrence} 次。\n"
                f"**规则**: {pattern.description or '检测到重复的危险操作模式'}。\n"
                f"**建议**: 自动收紧该操作的权限要求，要求显式用户确认。"
            ),
            "task": (
                f"## 任务规则\n"
                f"模式 `{pattern.key}` 重复出现 {pattern.recurrence} 次。\n"
                f"**规则**: {pattern.description or '该任务类型需要特殊处理'}。\n"
                f"**建议**: 委托给专门的子 Agent 或在执行前进行预检查。"
            ),
            "learning": (
                f"## 学习规则\n"
                f"从 {pattern.recurrence} 次经验中总结。\n"
                f"**规则**: {pattern.description or '重复遇到的经验教训'}。\n"
                f"**建议**: 将此规则注入 Agent system prompt 以预防复发。"
            ),
        }
        content = templates.get(pattern.category, templates["learning"])

        rule = KnowledgeRule(
            id=rule_id,
            title=f"{pattern.category.title()} Rule: {pattern.key}",
            category=pattern.category,
            content=content,
            source_pattern=pattern.key,
            created_at=now,
        )
        self._rules.append(rule)
        self._save()

        # 写入 Knowledge 目录（Obsidian markdown）
        self._write_rule_markdown(rule)

        # 向量化：存入 LanceDB 供语义召回
        self._vectorize(rule)

        logger.info(f"[knowledge] 新规则已晋升: {rule.title}")
        return rule

    def _vectorize(self, rule: KnowledgeRule):
        """将晋升产物向量化存入 LanceDB（供语义召回）。
        N10-M1: 兼容 Python<3.11 的 TOML 读取（无 tomllib 时走简易解析）。
        """
        try:
            from core.memory import vectorize_knowledge
            lancedb_enabled, lancedb_uri = False, ""
            toml_path = _PROJECT_ROOT / "slime.toml"
            if toml_path.exists():
                mem_cfg = _read_toml_memory_section(toml_path)
                lancedb_enabled = mem_cfg.get("enabled", False)
                lancedb_uri = mem_cfg.get("uri", "")
            vectorize_knowledge(
                self.agent_id, f"rule:{rule.category}",
                f"{rule.title}\n{rule.content}",
                lancedb_enabled=lancedb_enabled, lancedb_uri=lancedb_uri,
            )
        except Exception:
            pass  # 向量化失败不影响晋升主流程

    def _write_rule_markdown(self, rule: KnowledgeRule):
        """将规则写入 rules/ 目录（A-011: 锚定实例 base 目录，尊重 data_dir 隔离）"""
        target_dir = self._base_dir / "rules"
        target_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{rule.id}.md"
        (target_dir / filename).write_text(rule.to_markdown(), encoding="utf-8")

    def generate_skill(self, pattern_key: str,
                       skill_registry=None) -> dict | None:
        """
        从成功的 Pattern 生成可复用技能模板。
        写入 config/skills/ 目录。
        """
        pattern = self._patterns.get(pattern_key)
        if not pattern or pattern.recurrence < PROMOTE_THRESHOLDS["skill"]:
            return None

        skill_name = self._key_to_skill_name(pattern_key)
        # A-011: 锚定实例 base 目录（尊重 data_dir 隔离）
        skill_dir = self._base_dir / "generated_skills" / skill_name
        skill_dir.mkdir(parents=True, exist_ok=True)

        manifest = {
            "name": skill_name,
            "version": "1.0",
            "description": f"自动生成: {pattern.description or pattern.key} (×{pattern.recurrence})",
            "author": "slime-knowledge-engine",
            "tags": [pattern.category, "auto-generated"],
            "permissions": {"read": True, "write": False},
            "trigger_patterns": [pattern.key],
        }

        (skill_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        skill_md = (
            f"# {skill_name}\n\n"
            f"## 功能\n"
            f"从 {pattern.recurrence} 次成功经验中自动生成的技能。\n\n"
            f"## 触发模式\n"
            f"`{pattern.key}`\n\n"
            f"## 经验来源\n"
            f"{pattern.description}\n\n"
            f"## 使用方式\n"
            f"当检测到相似任务时，该技能会被自动推荐。\n"
            f"人工审查后可将 skill_dir 移动到 config/skills/ 以正式激活。\n"
        )
        (skill_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")

        logger.info(f"[knowledge] 技能模板已生成: {skill_name} → {skill_dir}")
        return {"name": skill_name, "dir": str(skill_dir)}

    # ── 审查与整理 ──────────────────────────────────────────

    def review(self, agent_persona=None, evolution_engine=None) -> dict:
        """
        周期性审查：整理过时记忆、强化高频 trait、清理已解决的 pattern。
        返回审查摘要。
        """
        now = datetime.now(timezone.utc)
        result = {
            "patterns_reviewed": 0,
            "patterns_resolved": 0,
            "rules_updated": 0,
            "traits_reinforced": 0,
            "memories_decayed": 0,
            "summary": [],
        }

        # 1. 检查 pattern — 超过 90 天未出现的标记为 resolved
        for key, p in list(self._patterns.items()):
            result["patterns_reviewed"] += 1
            if p.last_seen:
                try:
                    age = (now - datetime.fromisoformat(p.last_seen)).days
                except (ValueError, TypeError):
                    age = 0
                if age > 90:
                    p.resolved = True
                    result["patterns_resolved"] += 1
                    result["summary"].append(f"归档旧 Pattern: {key}（{age} 天未出现）")

        # 2. 高 recurrence 的 pattern → 强化对应 trait
        if agent_persona:
            for key, p in self._patterns.items():
                if p.recurrence >= PROMOTE_THRESHOLDS["trait"] and not p.resolved:
                    trait_name = self._key_to_trait_name(key)
                    found = False
                    for t in agent_persona.traits:
                        if isinstance(t, dict) and t.get("name", "").lower() == trait_name.lower():
                            t["weight"] = min(1.0, t.get("weight", 0.5) + 0.1)
                            found = True
                            break
                    if not found:
                        agent_persona.traits.append({
                            "name": trait_name, "weight": 0.45,
                            "last_used": now.isoformat(),
                            "source": f"knowledge-pattern:{key}",
                        })
                    result["traits_reinforced"] += 1
                    result["summary"].append(f"强化 trait: {trait_name}（来自 pattern {key} ×{p.recurrence}）")
                    agent_persona._touch()

        # 3. 写审查日志到 Knowledge 目录
        review_md = (
            f"# Review {now.strftime('%Y-%m-%d %H:%M')}\n\n"
            + "\n".join(f"- {s}" for s in result["summary"])
            + f"\n\n> 自动生成，{result['patterns_reviewed']} 个 pattern 已审查。"
        )
        review_dir = _KNOWLEDGE_DIR / "reviews"
        review_dir.mkdir(parents=True, exist_ok=True)
        (review_dir / f"review_{now.strftime('%Y%m%d_%H%M')}.md").write_text(
            review_md, encoding="utf-8",
        )

        # 向量化审查摘要（供语义召回）
        self._vectorize_text("review", review_md[:500])

        self._save()
        return result

    def get_promotable_traits(self) -> list[dict]:
        """返回所有达到 trait 晋升阈值的 pattern 对应的 trait 信号"""
        signals = []
        for key, p in self._patterns.items():
            if p.recurrence >= PROMOTE_THRESHOLDS["trait"] and not p.resolved:
                signals.append({
                    "name": self._key_to_trait_name(key),
                    "signal": 1,
                    "source": key,
                    "recurrence": p.recurrence,
                })
        return signals

    def get_high_priority_patterns(self) -> list[PatternEntry]:
        """获取所有高优先级未解决的 pattern"""
        return [p for p in self._patterns.values()
                if p.priority in ("high", "critical") and not p.resolved]

    def get_stats(self) -> dict:
        return {
            "total_patterns": len(self._patterns),
            "high_priority": len(self.get_high_priority_patterns()),
            "total_rules": len(self._rules),
            "pending_review": sum(
                1 for p in self._patterns.values()
                if p.recurrence >= PROMOTE_THRESHOLDS["rule"] and not p.resolved
            ),
        }


# ── TOML 兼容解析（N10-M1）──


def _read_toml_memory_section(toml_path: Path) -> dict:
    """读取 slime.toml 中 [memory.lancedb] 段，兼容 Python<3.11。
    ponytail: 只提取 lancedb 子段的 enabled + uri，不做完整解析。"""
    try:
        import tomllib
        data = tomllib.load(toml_path)
        return data.get("memory", {}).get("lancedb", {})
    except ImportError:
        pass
    # 简易 line-by-line 解析
    result = {}
    in_memory = False
    in_lancedb = False
    try:
        for line in toml_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line == "[memory]":
                in_memory, in_lancedb = True, False
            elif line == "[memory.lancedb]":
                in_memory, in_lancedb = False, True
            elif line.startswith("[") and line.endswith("]"):
                in_memory, in_lancedb = False, False
            elif in_lancedb and "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"')
                result[k] = v.lower() == "true" if v.lower() in ("true", "false") else (
                    int(v) if v.isdigit() else v
                )
    except Exception:
        pass
    return result


# ── 全局缓存（按 agent_id+data_dir 键控，非单例）──

_knowledge_cache: dict[str, KnowledgeEngine] = {}


def _cache_key(agent_id: str, data_dir: str) -> str:
    return f"{agent_id}::{data_dir}"


def get_knowledge_engine(agent_id: str = "", data_dir: str = "") -> KnowledgeEngine:
    key = _cache_key(agent_id, data_dir)
    if key not in _knowledge_cache:
        _knowledge_cache[key] = KnowledgeEngine(agent_id, data_dir)
    return _knowledge_cache[key]


def reset_knowledge_engine(agent_id: str = "", data_dir: str = ""):
    key = _cache_key(agent_id, data_dir)
    _knowledge_cache.pop(key, None)
