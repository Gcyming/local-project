"""
slime 技能目录
每个技能是一个 Python 文件 + 可选 manifest.json
默认只读沙箱：仅允许文件读取 + LLM 输出
需显式声明才能执行终端/网络/写入操作
"""

from core.sandbox import (
    Sandbox, SkillManifest, create_default_sandbox, create_from_manifest,
)


def load_skill_manifest(skill_name: str) -> SkillManifest | None:
    """加载技能清单文件，不存在则返回 None（使用默认沙箱）"""
    import json
    from pathlib import Path
    manifest_path = Path(__file__).parent / skill_name / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return SkillManifest(
            read=data.get("read", True),
            write=data.get("write", False),
            terminal=data.get("terminal", False),
            network=data.get("network", False),
            llm_output=data.get("llm_output", True),
            description=data.get("description", ""),
        )
    except (json.JSONDecodeError, OSError):
        return None


def get_sandbox(skill_name: str) -> Sandbox:
    """获取技能对应的沙箱（默认只读）"""
    manifest = load_skill_manifest(skill_name)
    if manifest:
        return Sandbox(manifest)
    return create_default_sandbox()