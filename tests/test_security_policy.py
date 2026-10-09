"""tests/test_security_policy.py — 安全策略单一来源的一致性守护。

目标：TS 侧（core-ts/src/tools/classifier.ts）与 Python 侧（tools/builtin.py）
共用 shared/security-policy.yaml 生成物。历史上双端各写一份，导致主链路缺失
引擎源码写入保护。本文件把「漂移」变成测试失败：
  1. 生成物与源是否一致（忘记重跑生成器 → 失败）
  2. Python 侧实际生效的清单是否来自共享源（而非回退镜像）
  3. builtin.py 内嵌回退镜像是否与源一致（改了 yaml 忘了改镜像 → 失败）
     —— 含 A-1197 §⑤ 的 30 条保留资产目录：builtin.py 的注释写着「由本文件断言」，
        但此前**只有注释没有断言**（grep RESERVED/OWNER 零命中）。现已接上。
⚠️ 铁律：任何「提取镜像再与之相等」的断言都必须先钉死**条数 > 0** ——
   提取器定位错会返回空集合，而 `空 == 空` 的断言**永远绿**（守卫静默失效且不响）。
   见 test_fallback_mirror_extraction_is_not_silent。
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
            _WRITE_DIR_EXEMPTIONS,
        )
    except Exception as e:  
        pytest.skip(f"无法导入 tools.builtin：{e}")

    import importlib.util

    spec = importlib.util.spec_from_file_location("_slime_security_policy_probe", PY_GEN)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert _WRITE_BLOCKED_DIRS == frozenset(str(x).lower() for x in mod.PROTECTED_DIRS)
    assert _WRITE_BLOCKED_NAMES == frozenset(str(x).lower() for x in mod.SENSITIVE_FILENAMES)
    assert tuple(_WRITE_BLOCKED_SUFFIXES) == tuple(str(x).lower() for x in mod.WRITE_BLOCK_SUFFIXES)
    # A-1197：受保护目录的豁免子路径也必须来自共享源（TS 侧同源于同一份 yaml）
    assert tuple(_WRITE_DIR_EXEMPTIONS) == tuple(str(x).lower() for x in mod.PROTECTED_PATH_EXEMPTIONS)


def _fallback_literals_from_builtin() -> tuple[
    set[str], set[str], tuple[str, ...], tuple[str, ...], tuple[str, ...]
]:
    """从 builtin.py 的 _load_security_policy 回退分支提取内嵌镜像常量。

    返回 (目录集, 文件名集, 写阻断后缀, 豁免子路径, 保留资产目录)。

    ⚠️ 各项靠**结构特征**区分（与既有解析同口径，不要改成"按位置取第 N 个"）：
    · frozenset({...}) 的 Set 字面量 → 目录集 / 文件名集（按出现顺序）
    · 全元素以 "." 开头**且**长度 <= 4 的 Tuple → 写阻断后缀（.enc/.toml/…）
    · 全元素是「小写、含 /、且不以 . 开头」的 Tuple → 豁免子路径（config/skills…）
    · ast.Call(func=tuple, args=[GeneratorExp]) 且元素形如 "config/plugins/" + name
      → 保留资产目录（30 条内置插件目录，builtin.py:166-175）——
      **不是**普通 Tuple 字面量，是 tuple(生成式)，所以前三条分支都匹配不到它。
    """
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
    exemptions: tuple[str, ...] = ()
    reserved: tuple[str, ...] = ()
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "frozenset":
            if node.args and isinstance(node.args[0], ast.Set):
                sets.append({e.value for e in node.args[0].elts if isinstance(e, ast.Constant)})
        # A-1197：保留资产目录镜像是 tuple("config/plugins/" + n for n in (...))
        #   结构：Call(tuple) → args[0] 是 GeneratorExp，
        #     · elt = BinOp(left=前缀常量, right=迭代变量 name)
        #     · generators[0].iter = 名字元组（30 个 str 常量）
        elif (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "tuple"
              and node.args and isinstance(node.args[0], ast.GeneratorExp)):
            gen = node.args[0]
            elt = gen.elt
            prefix = elt.left.value if (isinstance(elt, ast.BinOp) and isinstance(elt.left, ast.Constant)) else None
            names = [
                e.value for e in gen.generators[0].iter.elts
                if isinstance(e, ast.Constant) and isinstance(e.value, str)
            ] if (gen.generators and isinstance(gen.generators[0].iter, ast.Tuple)) else []
            if names and isinstance(prefix, str):
                reserved = tuple(f"{prefix}{n}" for n in names)
        if isinstance(node, ast.Tuple) and all(isinstance(e, ast.Constant) for e in node.elts) and node.elts:
            vals = tuple(e.value for e in node.elts if isinstance(e.value, str))
            if vals and all(v.startswith(".") for v in vals):
                suffixes = vals
            # A-1197：豁免子路径的特征是「小写目录相对路径，含 /」（不是后缀、也不是保留资产）
            elif vals and all("/" in v for v in vals):
                exemptions = vals
    assert len(sets) >= 2, "未解析到回退镜像的目录/文件名集合"
    return sets[0], sets[1], suffixes, exemptions, reserved


def test_fallback_mirror_matches_source() -> None:
    """内嵌回退镜像必须与共享源一致（改了 yaml 忘了同步镜像 → 失败）"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("_slime_security_policy_probe2", PY_GEN)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    (
        mirror_dirs,
        mirror_names,
        mirror_suffixes,
        mirror_exemptions,
        mirror_reserved,
    ) = _fallback_literals_from_builtin()

    # ⚠️⚠️ **计数自检必须写在断言之前**（项目铁律「空 == 空 永远绿」）：
    #   解析函数定位错了会返回空 tuple，而 `() == ()` 恒成立 ⇒ 守卫静默失效且**不响**。
    #   所以这里先钉死「解析出来的条数 > 0 且等于生成物的条数」，
    #   让"提取器定位失败/生成物被清空"两类都变成响亮的红。
    assert len(mirror_reserved) > 0, (
        "未能从 builtin.py 回退镜像解析出保留资产目录"
        "（提取器定位失效 ⇒ 下面的相等断言会变成『空 == 空』恒绿）"
    )
    assert len(mirror_reserved) == len(mod.CONTRIBUTION_RESERVED_ASSETS), (
        f"保留资产目录条数不符：镜像 {len(mirror_reserved)} vs 生成物 "
        f"{len(mod.CONTRIBUTION_RESERVED_ASSETS)}"
    )

    assert mirror_dirs == {str(x).lower() for x in mod.PROTECTED_DIRS}
    assert mirror_names == {str(x).lower() for x in mod.SENSITIVE_FILENAMES}
    assert mirror_suffixes == tuple(str(x).lower() for x in mod.WRITE_BLOCK_SUFFIXES)
    # A-1197：豁免清单同样不许漂移 —— 换了 shared/ 不可达的环境，放行的目录还是那两个
    assert mirror_exemptions == tuple(str(x).lower() for x in mod.PROTECTED_PATH_EXEMPTIONS)
    # A-1197 §⑤：30 条内置插件保留资产目录逐条相等（builtin.py 注释承诺了这条断言，
    # 此前**只有注释没有断言** ⇒ 改了 yaml 忘了改镜像，装包形态下内置插件目录会被当自建目录放行）
    assert mirror_reserved == tuple(str(x).lower() for x in mod.CONTRIBUTION_RESERVED_ASSETS)


def test_fallback_mirror_extraction_is_not_silent() -> None:
    """解析器的**反空转**自检：每一项都必须真的提取到东西。

    ⚠️ 本项目前科：定位错 ⇒ 返回空集合，而 `空 == 空` 的相等断言**永远绿**，
    守卫就此静默失效。本测试把"提取到了多少条"显式钉出来，
    任何人改坏提取逻辑都会在这里**响**，而不是变成一条永远绿的假守卫。
    """
    mirror_dirs, mirror_names, mirror_suffixes, mirror_exemptions, mirror_reserved = (
        _fallback_literals_from_builtin()
    )
    # 期望条数（与 shared/gen/security_policy.py 单一真相源一致）
    assert len(mirror_dirs) == 17, f"受保护目录镜像是 17 条，实得 {len(mirror_dirs)}"
    assert len(mirror_names) == 21, f"敏感文件名镜像是 21 条，实得 {len(mirror_names)}"
    assert len(mirror_suffixes) == 6, f"写阻断后缀镜像是 6 条，实得 {len(mirror_suffixes)}"
    assert len(mirror_exemptions) == 2, f"豁免子路径镜像是 2 条，实得 {len(mirror_exemptions)}"
    assert len(mirror_reserved) == 30, (
        f"保留资产目录镜像是 30 条，实得 {len(mirror_reserved)}"
        " —— 提取器没定位到 tuple 生成式（builtin.py:166-175）"
    )
    # 特征抽查（防止把 .toml 后缀元组 / 豁免元组误当成保留资产）
    assert all(v.startswith("config/plugins/") for v in mirror_reserved)
    assert not any(v.startswith(".") for v in mirror_reserved)


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
    for ex in mod.PROTECTED_PATH_EXEMPTIONS:
        assert f'"{ex}"' in ts, f"TS 生成物缺少豁免子路径 {ex}，请重跑生成器"


def test_exemptions_unblock_contribution_dirs_only() -> None:
    """A-1197：Python 侧必须与 TS 侧同口径 —— 只放行 config/skills 与 config/plugins。

    这是「Agent 造插件被判风险项 / 总被拒绝」的 Python 侧对照组：
    · 放行的是**目录及其下全部**（用户自助贡献资产目录）
    · 父级 config/ 下的主配置、以及前缀邻居（skills-2）依旧照封
    · 敏感后缀不受豁免影响
    """
    try:
        from tools.builtin import _is_blocked_write_path
    except Exception as e:  # pragma: no cover - 环境缺依赖时不误报
        pytest.skip(f"无法导入 tools.builtin：{e}")

    cfg = ROOT / "config"
    # ① 放行的：技能 / 插件目录内的资产
    assert _is_blocked_write_path(cfg / "skills" / "demo" / "SKILL.md") is False
    assert _is_blocked_write_path(cfg / "plugins" / "demo" / "plugin.json") is False
    assert _is_blocked_write_path(cfg / "plugins" / "demo" / "skills" / "d" / "SKILL.md") is False
    # ② 不许外溢：前缀邻居仍是禁区
    assert _is_blocked_write_path(cfg / "skills-2" / "x.md") is True
    assert _is_blocked_write_path(cfg / "plugins-old" / "x.json") is True
    # ③ 真正的敏感项一个都没松
    assert _is_blocked_write_path(cfg / "agents.json") is True
    assert _is_blocked_write_path(cfg / "providers.enc.json") is True
    assert _is_blocked_write_path(cfg / "skills" / "demo" / "secret.enc") is True
