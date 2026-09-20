"""
slime 技能引擎
- 加载 config/skills/ 下的 SKILL.md + manifest.yaml
- 权限检查（基于 sandbox 配置）
- 注册为工具到 ToolRegistry
- 注入到 Agent system prompt
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Awaitable

import yaml
import asyncio

from tools.registry import Tool

logger = logging.getLogger(__name__)
# A-096: 指导正文注入上限 12000 字符（原 2000 会把 ponytail 类 4KB 指导砍半）
_SKILL_BODY_LIMIT = 12000

# 技能默认配置
DEFAULT_SKILL_DIR = Path(__file__).resolve().parent.parent / "config" / "skills"
MAX_SKILL_DESCRIPTION_LENGTH = 500  # system prompt 中截断长度


# ── 权限级别映射 ──────────────────────────────────────────

PERMISSION_LEVELS = {
    "read": 0,
    "write": 2,
    "terminal": 3,
    "network": 4,
    "system": 5,
}

# 沙箱配置中的权限级别映射
SANDBOX_APPROVE = {0, 1}  # 自动批准
SANDBOX_REQUIRE = {2, 3, 4}  # 需确认
SANDBOX_DENY = {5}  # 强制拒绝


@dataclass
class SkillManifest:
    """技能清单（从 manifest.yaml 加载）"""
    name: str = ""
    version: str = "1.0"
    description: str = ""
    author: str = ""
    tags: list[str] = field(default_factory=list)
    permissions: dict[str, bool] = field(default_factory=lambda: {"read": True})
    args_schema: dict = field(default_factory=dict)  # JSON Schema 格式参数定义
    trigger_patterns: list[str] = field(default_factory=list)  # 触发关键词

    @classmethod
    def from_dict(cls, data: dict) -> "SkillManifest":
        return cls(
            name=data.get("name", ""),
            version=data.get("version", "1.0"),
            description=data.get("description", ""),
            author=data.get("author", ""),
            tags=data.get("tags", []),
            permissions=data.get("permissions", {"read": True}),
            args_schema=data.get("args_schema", {}),
            trigger_patterns=data.get("trigger_patterns", []),
        )

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "author": self.author,
            "tags": self.tags,
            "permissions": self.permissions,
            "args_schema": self.args_schema,
        }


@dataclass
class Skill:
    """单个技能"""
    name: str
    description: str
    manifest: SkillManifest
    body: str = ""  # SKILL.md 的正文部分（不含 frontmatter）
    path: Path = field(default_factory=Path)
    execute_fn: Callable | None = None  # 自定义执行函数（可选）

    def to_llm_schema(self) -> dict:
        """输出给 LLM 的统一格式"""
        schema = {
            "type": "function",
            "function": {
                "name": f"skill_{self.name}",
                "description": self.description[:MAX_SKILL_DESCRIPTION_LENGTH],
                "parameters": self.manifest.args_schema or {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目标文件/目录路径",
                        },
                    },
                    "required": ["path"],
                },
            },
        }
        return schema


class SkillRegistry:
    """技能注册表（单例模式）"""

    def __init__(self, skill_dir: Path | None = None):
        self.skill_dir = skill_dir or DEFAULT_SKILL_DIR
        self._skills: dict[str, Skill] = {}
        self._loaded = False

    def load_skills(self) -> list[str]:
        """扫描并加载所有技能，返回加载的技能名列表"""
        if not self.skill_dir.exists():
            logger.info(f"[skills] 技能目录不存在: {self.skill_dir}")
            return []

        self._skills.clear()
        loaded = []
        # N11-P0-3: 拒绝 symlink，防任意目录代码执行
        for skill_dir in sorted(self.skill_dir.iterdir()):
            if skill_dir.is_symlink():
                logger.warning(f"[skills] 拒绝符号链接: {skill_dir.name}")
                continue
            if not skill_dir.is_dir() or skill_dir.name.startswith("__"):
                continue

            skill = self._load_single_skill(skill_dir)
            if skill:
                self._skills[skill.name] = skill
                loaded.append(skill.name)
                logger.info(f"[skills] 加载技能: {skill.name}")

        self._loaded = True
        return loaded

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def _load_single_skill(self, skill_dir: Path) -> Skill | None:
        """加载单个技能目录"""
        # 1. 加载 manifest.yaml/json（可选增强，A-096：缺失时回退 SKILL.md frontmatter）
        manifest = None
        manifest_path = skill_dir / "manifest.yaml"
        if not manifest_path.exists():
            manifest_path = skill_dir / "manifest.json"
        if manifest_path.exists():
            try:
                if manifest_path.suffix == ".json":
                    import json
                    data = json.loads(manifest_path.read_text(encoding="utf-8"))
                else:
                    data = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
                manifest = SkillManifest.from_dict(data or {})
            except Exception as e:
                logger.warning(f"[skills] 加载 {skill_dir.name}/{manifest_path.name} 失败: {e}")
                manifest = None
        if manifest is None:
            manifest = SkillManifest(name=skill_dir.name)  # frontmatter 回退兜底

        if not manifest.name:
            manifest.name = skill_dir.name

        # 2. 加载 SKILL.md（唯一硬要求；A-096：frontmatter 回填 manifest——标准 Agent Skills
        #    技能（仅 SKILL.md frontmatter）零适配直接可用）
        skill_md = skill_dir / "SKILL.md"
        description = manifest.description
        body = ""
        if skill_md.exists():
            try:
                content = skill_md.read_text(encoding="utf-8")
                # 解析 frontmatter（YAML 头）
                fm_match = re.match(r"^---\n(.*?)\n---\n?(.*)$", content, re.DOTALL)
                if fm_match:
                    body = fm_match.group(2).strip()
                    try:
                        fm_data = yaml.safe_load(fm_match.group(1)) or {}
                        if isinstance(fm_data, dict):
                            if not manifest.name or manifest.name == skill_dir.name:
                                manifest.name = str(fm_data.get("name") or skill_dir.name)
                            if not description:
                                description = str(fm_data.get("description") or "") or None
                            if not manifest.tags and fm_data.get("tags"):
                                tags = fm_data["tags"]
                                manifest.tags = tags if isinstance(tags, list) else str(tags).split(",")
                    except Exception:
                        pass  # frontmatter 解析失败不影响加载（有正文兜底）
                else:
                    body = content.strip()
                if not description:
                    description = self._extract_description(body) if body else body[:200]
            except Exception as e:
                logger.warning(f"[skills] 读取 {skill_dir.name}/SKILL.md 失败: {e}")
                return None

        skill = Skill(
            name=manifest.name,
            description=description,
            manifest=manifest,
            body=body,
            path=skill_dir,
        )

        # 3. skill.py 自定义执行函数
        # N11-P0-2: 禁用 exec_module —— 顶层代码会在权限检查前以全权限执行（RCE）。
        # 仅允许 SKILL.md 指导模式；自定义执行函数需子进程沙箱隔离后方可重新启用。
        skill_py = skill_dir / "skill.py"
        if skill_py.exists():
            logger.warning(
                f"[skills] 技能 {manifest.name} 含 skill.py，"
                f"自定义执行函数已禁用（安全），仅使用 SKILL.md 指导模式"
            )

        return skill

    def _extract_description(self, body: str) -> str:
        """从 SKILL.md 正文提取描述"""
        # 尝试匹配 ## 功能 或 # 后面的第一段
        for pattern in [r"^##\s+功能\s*\n+(.*?)(?=\n##|\Z)", r"^#\s+(.*?)(?=\n\n)"]:
            match = re.search(pattern, body, re.MULTILINE | re.DOTALL)
            if match:
                desc = match.group(1).strip()
                # 清理 markdown
                desc = re.sub(r"\*\*(.*?)\*\*", r"\1", desc)
                desc = re.sub(r"`(.*?)`", r"\1", desc)
                return desc[:MAX_SKILL_DESCRIPTION_LENGTH]
        return body[:MAX_SKILL_DESCRIPTION_LENGTH]

    def get(self, name: str) -> Skill | None:
        """获取技能"""
        return self._skills.get(name)

    def list_skills(self) -> list[dict]:
        """列出所有技能（LLM 统一 Schema）"""
        return [s.to_llm_schema() for s in self._skills.values()]

    def list_skill_names(self) -> list[str]:
        """列出所有技能名"""
        return list(self._skills.keys())

    def list_skill_descriptions(self) -> list[str]:
        """列出技能描述（用于 system prompt）"""
        return [s.description for s in self._skills.values()]

    async def call_skill(self, name: str, args: dict) -> str:
        """
        调用技能。
        返回执行结果字符串。
        """
        skill = self._skills.get(name)
        if not skill:
            return f"[错误] 技能 '{name}' 未找到"

        # A-038: 权限检查只约束【执行】——无 execute_fn 的指导模式仅返回
        # SKILL.md 正文（纯读操作），不应被 manifest 的执行权限（write/terminal/network）
        # 拦截。此前 network 类技能（如媒体生成类技能）的 skill_lookup 恒被
        # "权限不足"拒绝，模型读不到指导 → 永远走不到真正的工具调用（用户实测）。
        if skill.execute_fn and not self._check_permissions(skill.manifest.permissions):
            return f"[错误] 技能 '{name}' 权限不足（需要写/终端/网络权限）"

        # 执行
        if skill.execute_fn:
            try:
                result = skill.execute_fn(args)
                if asyncio.iscoroutine(result):
                    result = await result
                return str(result)
            except Exception as e:
                logger.error(f"[skills] 技能 '{name}' 执行失败: {e}")
                return f"[错误] 技能执行失败: {e}"
        else:
            # 无自定义执行函数，返回 SKILL.md 正文作为指导
            if skill.body:
                return f"[技能 {name} 指导]\n{skill.body[:_SKILL_BODY_LIMIT]}"
            return f"[技能 {name}] 无执行函数，请查看 SKILL.md 获取指导。"

    def _check_permissions(self, permissions: dict[str, bool]) -> bool:
        """检查权限是否满足沙箱配置。无审批回调时，REQUIRE 级能力默认拒绝（fail-closed）。"""
        for perm, required in permissions.items():
            if not required:
                continue
            # N11-P2-18: 未知权限默认最高级（fail-closed），而非 0（自动放行）
            level = PERMISSION_LEVELS.get(perm, max(PERMISSION_LEVELS.values()))
            if level in SANDBOX_DENY:
                return False
            if level in SANDBOX_REQUIRE:
                # 无显式审批回调 → 拒绝（安全纵深，fail-closed）
                # 调用方应在传入前设置审批逻辑
                logger.warning(
                    f"[skills] 技能权限 '{perm}' (L{level}) 需要审批，"
                    f"但未配置审批回调，默认拒绝"
                )
                return False
        return True

    def search(self, query: str, limit: int = 10) -> list[dict]:
        """关键词检索技能（A-004）。名称命中权重 > 描述/tags 命中；空查询返回全部（截断）。"""
        q = (query or "").strip().lower()
        limit = max(1, min(int(limit) if limit else 10, 50))
        scored: list[tuple[int, str, Skill]] = []
        for s in self._skills.values():
            if not q:
                scored.append((0, s.name, s))
                continue
            name_l = s.name.lower()
            desc_l = (s.description or "").lower()
            tags_l = " ".join(s.manifest.tags or []).lower()
            score = 0
            if q in name_l:
                score += 3
            if q in desc_l:
                score += 1
            if q in tags_l:
                score += 1
            if score > 0:
                scored.append((score, s.name, s))
        scored.sort(key=lambda t: (-t[0], t[1]))
        return [
            {"name": s.name, "description": (s.description or "")[:200]}
            for _, _, s in scored[:limit]
        ]

    def clear(self):
        """清空所有技能"""
        self._skills.clear()
        self._loaded = False


# ── 全局注册表 ────────────────────────────────────────────

_registry: SkillRegistry | None = None


def get_registry() -> SkillRegistry:
    """获取全局技能注册表"""
    global _registry
    if _registry is None:
        _registry = SkillRegistry()
    return _registry


def reset_registry():
    """重置全局注册表（用于测试）"""
    global _registry
    _registry = SkillRegistry()


def load_all_skills(skill_dir: Path | None = None) -> list[str]:
    """加载技能并注册精简工具面（A-004）。

    只注册两个工具：
    - skill_search：关键词检索技能（名/描述/tags），返回技能名+简介
    - skill_lookup：按名读取 SKILL.md 完整指导正文

    不再为每个技能注册 skill_<name> 工具 —— 417 个技能全量注入 tools 数组
    曾导致单请求 5-12 万 token 开销并稀释模型工具选择注意力。
    技能检索/调用语义不变（原 skill_<name> 工具本就只返回 SKILL.md 指导）。
    热更新安全：先注销旧工具再注册（同名拒绝覆盖）。"""
    from tools.registry import get_registry as get_tool_registry

    skill_reg = get_registry()
    if skill_dir:
        skill_reg.skill_dir = skill_dir
    loaded = skill_reg.load_skills()

    tool_reg = get_tool_registry()
    for old in ("skill_search", "skill_lookup"):
        tool_reg.unregister(old)

    async def _search_tool(args: dict) -> str:
        q = str(args.get("query", "")).strip()
        limit = args.get("limit", 10)
        try:
            limit = max(1, min(int(limit), 50))
        except (TypeError, ValueError):
            limit = 10
        items = skill_reg.search(q, limit)
        if not items:
            return "未找到匹配的技能。可不带关键词调用 skill_search 查看全部可用技能。"
        lines = [f"- {it['name']}: {it['description']}" for it in items]
        head = f"匹配 '{q}' 的技能（{len(items)} 个）" if q else f"可用技能（前 {len(items)} 个）"
        return head + "：\n" + "\n".join(lines)

    async def _lookup_tool(args: dict) -> str:
        name = str(args.get("name", "")).strip()
        if not name:
            return "[错误] 缺少 name 参数（先用 skill_search 查询技能名）"
        return await skill_reg.call_skill(name, {})

    tool_reg.register(Tool(
        name="skill_search",
        description="检索可用技能：按关键词在技能名/描述/标签中匹配（名称命中优先），返回技能名与简介。找到目标技能后用 skill_lookup 读取完整指导。不带关键词可列出全部技能。",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词（如 '浏览器'、'amazon'）；留空列出全部"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 10，上限 50", "default": 10},
            },
            "required": ["query"],
        },
        execute_fn=_search_tool,
        permissions=["read"],
    ))
    tool_reg.register(Tool(
        name="skill_lookup",
        description="读取指定技能的完整指导正文（SKILL.md）。技能名来自 skill_search 的返回结果。",
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "技能名（skill_search 返回的 name 字段）"},
            },
            "required": ["name"],
        },
        execute_fn=_lookup_tool,
        permissions=["read"],
    ))

    logger.info(f"[skills] 已加载 {len(loaded)} 个技能，注册 skill_search/skill_lookup 工具")
    return loaded
