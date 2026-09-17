"""tests/test_security_policy.py — 安全策略单一来源的一致性守护。

目标：TS 侧（core-ts/src/tools/classifier.ts）与 Python 侧（tools/builtin.py）
共用 shared/security-policy.yaml 生成物。历史上双端各写一份，导致主链路缺失
引擎源码写入保护。本文件把「漂移」变成测试失败：
  1. 生成物与源是否一致（忘记重跑生成器 → 失败）
  2. Python 侧实际生效的清单是否来自共享源（而非回退镜像）
  3. builtin.py 内嵌回退镜像是否与源一致（改了 yaml 忘了改镜像 → 失败）
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
POLICY = ROOT / "shared" / "security-policy.yaml"
TS_GEN = ROOT / "shared" / "gen" / "security-policy.ts"
PY_GEN = ROOT / "shared" / "gen" / "security_policy.py"


def test_generator_is_idempotent() -> None:
    """生成物与源一致（--check 幂等）"""
    r = subprocess.run(
        [sys.executable, "scripts/gen_security_policy.py", "--check"],
        cwd=ROOT, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"生成物与 shared/security-policy.yaml 不一致，请重跑生成器：\n{r.stderr}"


def test_generated_files_exist() -> None:
    assert POLICY.exists(), "缺少单一真相源 shared/security-policy.yaml"
    assert TS_GEN.exists(), "缺少 TS 生成物，请运行 py scripts/gen_security_policy.py"
    assert PY_GEN.exists(), "缺少 Python 生成物，请运行 py scripts/gen_security_policy.py"


def test_python_side_uses_shared_source() -> None:
    """builtin 实际生效的清单必须与生成物一致（证明走的是共享源而非回退镜像）"""
    try:
        from tools.builtin import (
            _WRITE_BLOCKED_DIRS,
            _WRITE_BLOCKED_NAMES,
            _WRITE_BLOCKED_SUFFIXES,
        )
    except Exception as e:  # pragma: no cover - 环境异常
        pytest.skip(f"无法导入 tools.builtin：{e}")

    import importlib.util

    spec = importlib.util.spec_from_file_location("_slime_security_policy_probe", PY_GEN)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert _WRITE_BLOCKED_DIRS == frozenset(str(x).lower() for x in mod.PROTECTED_DIRS)
    assert _WRITE_BLOCKED_NAMES == frozenset(str(x).lower() for x in mod.SENSITIVE_FILENAMES)
    assert tuple(_WRITE_BLOCKED_SUFFIXES) == tuple(str(x).lower() for x in mod.WRITE_BLOCK_SUFFIXES)


def _fallback_literals_from_builtin() -> tuple[set[str], set[str], tuple[str, ...]]:
    """从 builtin.py 的 _load_security_policy 回退分支提取内嵌镜像常量"""
    src = (ROOT / "tools" / "builtin.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next(
        (n for n in ast.walk(tree)
         if isinstance(n, ast.FunctionDef) and n.name == "_load_security_policy"),
        None,
    )
    assert fn is not None, "builtin.py 中未找到 _load_security_policy"

    sets: list[set[str]] = []
    suffixes: tuple[str, ...] = ()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "frozenset":
            if node.args and isinstance(node.args[0], ast.Set):
                sets.append({e.value for e in node.args[0].elts if isinstance(e, ast.Constant)})
        if isinstance(node, ast.Tuple) and all(isinstance(e, ast.Constant) for e in node.elts) and node.elts:
            if all(isinstance(e.value, str) and e.value.startswith(".") for e in node.elts):
                suffixes = tuple(e.value for e in node.elts)
    assert len(sets) >= 2, "未解析到回退镜像的目录/文件名集合"
    return sets[0], sets[1], suffixes


def test_fallback_mirror_matches_source() -> None:
    """内嵌回退镜像必须与共享源一致（改了 yaml 忘了同步镜像 → 失败）"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("_slime_security_policy_probe2", PY_GEN)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    mirror_dirs, mirror_names, mirror_suffixes = _fallback_literals_from_builtin()
    assert mirror_dirs == {str(x).lower() for x in mod.PROTECTED_DIRS}
    assert mirror_names == {str(x).lower() for x in mod.SENSITIVE_FILENAMES}
    assert mirror_suffixes == tuple(str(x).lower() for x in mod.WRITE_BLOCK_SUFFIXES)


def test_ts_side_covers_protected_dirs() -> None:
    """TS 生成物必须包含全部受保护目录（防止只改了 yaml 没重新生成）"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("_slime_security_policy_probe3", PY_GEN)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    ts = TS_GEN.read_text(encoding="utf-8")
    for d in mod.PROTECTED_DIRS:
        assert f'"{d}"' in ts, f"TS 生成物缺少受保护目录 {d}，请重跑生成器"
