"""
将 Claude 风格 skill 包（skills/<name>/SKILL.md 含 frontmatter）导入 slime 技能系统。
用法: py tools/import_skills.py <源skills目录> [--prefix 包名前缀] [--dry-run]

规则：
- 目标 config/skills/<skill_name>/：生成 manifest.yaml（name/description/permissions=read）
  + 复制 SKILL.md 及 references/ scripts/ 等附属文件
- 去重：目标已存在同名目录 → 跳过并统计；同一批内同名 → 后者跳过（先到先得）
- SKILL.md 无 frontmatter 或无 name → 跳过并统计
- 不复制可执行脚本的权限：skill 引擎已禁用 skill.py 执行（安全），只复制指导文件
"""
import re
import shutil
import sys
from pathlib import Path

import yaml

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TARGET = _PROJECT_ROOT / "config" / "skills"


def _frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    try:
        data = yaml.safe_load(m.group(1)) or {}
        return (data if isinstance(data, dict) else {}), m.group(2).strip()
    except Exception:
        return {}, text


def _safe_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_-]", "_", name.strip()).strip("_")
    return name or "unnamed"


def import_pack(src_dir: Path, prefix: str = "", dry_run: bool = False,
                exclude: set[str] | None = None) -> dict:
    seen: set[str] = set()          # 本批已用名
    exclude = exclude or set()
    skipped_existing: list[str] = []
    skipped_dup: list[str] = []
    skipped_invalid: list[str] = []
    imported: list[str] = []

    for skill_dir in sorted(src_dir.iterdir()):
        if not skill_dir.is_dir() or skill_dir.name.startswith("."):
            continue
        if skill_dir.name in exclude:
            skipped_invalid.append(f"{skill_dir.name} (exclude)")
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            skipped_invalid.append(f"{skill_dir.name} (无 SKILL.md)")
            continue
        fm, _body = _frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
        name = _safe_name(str(fm.get("name") or skill_dir.name))
        if prefix:
            name = f"{prefix}_{name}"
        if name in seen:
            skipped_dup.append(name)
            continue
        seen.add(name)
        desc = fm.get("description")
        if desc:
            description = str(desc).strip()
        else:
            description = f"来自 {skill_dir.name} 的技能（无描述）"
        target = _TARGET / name
        if target.exists():
            skipped_existing.append(name)
            continue
        if not dry_run:
            shutil.copytree(skill_dir, target,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            manifest = {
                "name": name,
                "version": "1.0",
                "description": description[:500],
                "permissions": {"read": True, "write": False, "terminal": False, "network": False},
                "tags": [],
            }
            (target / "manifest.yaml").write_text(
                yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False),
                encoding="utf-8")
        imported.append(name)
    return {
        "imported": imported,
        "skipped_existing": skipped_existing,
        "skipped_dup": skipped_dup,
        "skipped_invalid": skipped_invalid,
    }


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    if not args:
        print(__doc__)
        return
    src = Path(args[0]).resolve()
    prefix = ""
    if len(args) >= 3 and args[1] == "--prefix":
        prefix = args[2]
    exclude = set()
    if "--exclude" in args:
        i = args.index("--exclude")
        if i + 1 < len(args):
            exclude = set(args[i + 1].split(","))
    if not src.is_dir():
        print(f"源目录不存在: {src}")
        return
    r = import_pack(src, prefix=prefix, dry_run=dry_run, exclude=exclude)
    print(f"[{'dry-run' if dry_run else 'import'}] {src.name} → {_TARGET}")
    print(f"  导入 {len(r['imported'])}: {', '.join(r['imported']) or '-'}")
    for k in ("skipped_existing", "skipped_dup", "skipped_invalid"):
        if r[k]:
            print(f"  跳过[{k}]: {', '.join(r[k])}")


if __name__ == "__main__":
    main()
