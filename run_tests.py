"""
slime 独立测试运行器
用法: python run_tests.py
（测试模块须已安装 pytest，运行器不做依赖校验）
"""

import sys
import os
import asyncio
import enum
import tempfile
import traceback
import inspect
from pathlib import Path

# 确保项目根目录在 sys.path 中
_PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_PROJECT_ROOT))


_INJECTED_PARAMS = ("tmp_path",)
_SUPPORTED_PARAM_MARKS = ("skip", "skipif")


def _split_argnames(argnames) -> list[str]:
    if isinstance(argnames, str):
        raw = argnames.split(",")
    else:
        raw = [str(n) for n in argnames]
    names = [n.strip() for n in raw]
    names = [n for n in names if n]
    if not names:
        raise ValueError("parametrize 的 argnames 为空")
    return names


def _escape_id(text: str) -> str:
    if text.isascii():
        return text
    return text.encode("unicode_escape").decode("ascii")


def _auto_id(value) -> str | None:
    if isinstance(value, bytes):
        return _escape_id(value.decode("utf-8", "replace"))
    if isinstance(value, str):
        return _escape_id(value)
    if value is None or isinstance(value, (bool, int, float, complex)):
        return str(value)
    if isinstance(value, enum.Enum):
        return _escape_id(str(value))
    return None


def _explicit_id(explicit_ids, index: int, vals: tuple):
    if explicit_ids is None:
        return None
    if callable(explicit_ids):
        try:
            got = explicit_ids(vals[0] if len(vals) == 1 else vals)
        except Exception:
            return None
        return None if got is None else str(got)
    if isinstance(explicit_ids, (list, tuple)):
        if index < len(explicit_ids):
            got = explicit_ids[index]
            return None if got is None else str(got)
    return None


def _make_param_id(names: list[str], vals: tuple, index: int, explicit_ids) -> str:
    given = _explicit_id(explicit_ids, index, vals)
    if given is not None:
        return _escape_id(given)
    parts = []
    for name, value in zip(names, vals):
        auto = _auto_id(value)
        parts.append(auto if auto is not None else f"{name}{index}")
    return "-".join(parts)


def _mark_is_skip(mark) -> bool:
    name = getattr(mark, "name", None)
    if name == "skip":
        return True
    if name == "skipif":
        args = getattr(mark, "args", ())
        return bool(args) and bool(args[0])
    return False


def _mark_name(mark) -> str:
    return str(getattr(mark, "name", None) or "?")


def _unpack_entry(entry, n_names: int):
    if type(entry).__name__ == "ParameterSet" and hasattr(entry, "values"):
        return tuple(entry.values), list(entry.marks or []), entry.id
    if n_names > 1 and isinstance(entry, (tuple, list)):
        return tuple(entry), [], None
    return (entry,), [], None


def _parametrize_marks(cls, method_name: str) -> list:
    method = getattr(cls, method_name, None)
    method_marks = [
        m for m in (getattr(method, "pytestmark", None) or [])
        if getattr(m, "name", None) == "parametrize"
    ]
    class_marks = [
        m for m in (getattr(cls, "pytestmark", None) or [])
        if getattr(m, "name", None) == "parametrize"
    ]
    return list(method_marks) + list(class_marks)


def _expand_cases(cls, method_name: str, sig_params: list[str]):
    """展开 parametrize，返回 (cases, notices)"""
    cases = [({}, [], False)]
    notices = []
    for mark in _parametrize_marks(cls, method_name):
        if mark.kwargs.get("indirect"):
            raise ValueError("indirect=True 不支持（run_tests.py 不提供 pytest fixture）")
        if len(mark.args) < 2:
            raise ValueError("parametrize 缺少 argnames / argvalues")
        names = _split_argnames(mark.args[0])
        for name in names:
            if name in _INJECTED_PARAMS:
                raise ValueError(
                    f"parametrize 参数名 {name!r} 与 run_tests.py 注入的参数冲突"
                )
            if sig_params and name not in sig_params:
                raise ValueError(f"parametrize 参数名 {name!r} 不在方法签名中")
        explicit_ids = mark.kwargs.get("ids")
        entries = [_unpack_entry(e, len(names)) for e in list(mark.args[1])]
        new_cases = []
        for kwargs, id_parts, skipped in cases:
            for index, (values, entry_marks, entry_id) in enumerate(entries):
                if len(names) == 1:
                    if len(values) != 1:
                        raise ValueError(
                            f"argnames={names!r} 期望 1 个值，实际 {len(values)} 个"
                        )
                    vals = (values[0],)
                else:
                    if len(values) != len(names):
                        raise ValueError(
                            f"argnames={names!r} 期望 {len(names)} 个值，实际 {len(values)} 个"
                        )
                    vals = values
                child = dict(kwargs)
                child.update(dict(zip(names, vals)))
                if entry_id is None:
                    part = _make_param_id(names, vals, index, explicit_ids)
                else:
                    part = _escape_id(str(entry_id))
                child_skipped = skipped or any(_mark_is_skip(m) for m in entry_marks)
                for m in entry_marks:
                    if _mark_name(m) not in _SUPPORTED_PARAM_MARKS:
                        notices.append(
                            f"  {cls.__name__}::{method_name}: parametrize mark "
                            f"{_mark_name(m)!r} 不支持（已忽略）"
                        )
                new_cases.append((child, id_parts + [part], child_skipped))
        cases = new_cases
    return cases, notices


def _run_test_class(cls, verbose: bool = False, keywords=None) -> tuple:
    """运行一个测试类的所有 test_ 方法，返回 (通过, 失败, 跳过, 失败信息, 提示)"""
    passed = 0
    failed = 0
    skipped = 0
    failures = []
    notices = []

    kws = list(keywords) if keywords else []

    # 收集所有 test_ 开头的方法
    methods = sorted([
        name for name, _ in inspect.getmembers(cls, predicate=inspect.isfunction)
        if name.startswith("test_")
    ])
    if kws:
        methods = [
            n for n in methods
            if any(k in n or k in cls.__name__ or k in cls.__module__ for k in kws)
        ]

    if not methods:
        return 0, 0, 0, [], []

    for method_name in methods:
        try:
            sig_params = list(inspect.signature(getattr(cls, method_name)).parameters)
        except (TypeError, ValueError):
            sig_params = []
        try:
            cases, expand_notices = _expand_cases(cls, method_name, sig_params)
        except Exception as e:
            failed += 1
            failures.append(f"  {cls.__name__}::{method_name} [PARAMETRIZE]: {e}")
            continue
        notices.extend(expand_notices)
        if not cases:
            notices.append(f"  {cls.__name__}::{method_name}: parametrize 展开后无用例（argvalues 为空）")
            continue

        for case_kwargs, id_parts, is_skipped in cases:
            label = method_name + (f"[{'-'.join(id_parts)}]" if id_parts else "")
            if is_skipped:
                skipped += 1
                if verbose:
                    print(f"      SKIP {cls.__name__}::{label}")
                continue

            # 为每个测试用例创建实例
            instance = cls()

            # 运行 setup_method（如果有）
            if hasattr(instance, "setup_method"):
                try:
                    instance.setup_method()
                except Exception as e:
                    failed += 1
                    failures.append(f"  {cls.__name__}::{label} [SETUP FAILED]: {e}")
                    continue

            method = getattr(instance, method_name)
            sig = inspect.signature(method)
            kwargs = dict(case_kwargs)
            tmp_dirs = []
            for param_name in sig.parameters:
                if param_name == "self" or param_name in kwargs:
                    continue
                if param_name == "tmp_path":
                    injected = Path(tempfile.mkdtemp())
                    kwargs[param_name] = injected
                    tmp_dirs.append(injected)

            # 运行测试（支持 async 方法）
            try:
                result = method(**kwargs)
                if inspect.iscoroutine(result):
                    asyncio.run(result)
                passed += 1
                if verbose:
                    print(f"      PASS {cls.__name__}::{label}")
            except AssertionError as e:
                failed += 1
                failures.append(f"  {cls.__name__}::{label} [ASSERT]: {e}")
            except Exception as e:
                failed += 1
                tb_lines = traceback.format_exception(type(e), e, e.__traceback__)
                short_tb = "".join(tb_lines[-3:]).strip()
                failures.append(f"  {cls.__name__}::{label} [ERROR]: {short_tb}")
            finally:
                import shutil
                for d in tmp_dirs:
                    shutil.rmtree(str(d), ignore_errors=True)

    return passed, failed, skipped, failures, notices


def _discover_test_classes():
    """发现 tests/ 目录下所有 test_*.py 中的测试类"""
    test_dir = _PROJECT_ROOT / "tests"
    if not test_dir.exists():
        print("tests/ 目录不存在")
        return []

    classes = []
    for py_file in sorted(test_dir.glob("test_*.py")):
        module_name = py_file.stem
        try:
            # 动态导入模块
            import importlib
            mod = importlib.import_module(f"tests.{module_name}")

            # 收集模块中的测试类（以 Test 开头）
            for name, obj in inspect.getmembers(mod, inspect.isclass):
                if name.startswith("Test") and obj.__module__ == mod.__name__:
                    classes.append((module_name, obj))
        except Exception as e:
            print(f"  [加载失败] tests/{py_file.name}: {e}")

    return classes


def _parse_args(argv):
    verbose = False
    keywords = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-v", "--verbose"):
            verbose = True
        elif arg in ("-k", "--filter"):
            i += 1
            if i < len(argv):
                for part in argv[i].split(","):
                    if part:
                        keywords.append(part)
        elif arg in ("-h", "--help"):
            print("用法: python run_tests.py [-v] [-k 关键字]  （-k 按 模块/类/方法 名过滤，可逗号分隔）")
            sys.exit(0)
        i += 1
    return verbose, keywords


def main():
    verbose, keywords = _parse_args(sys.argv[1:])

    print()
    print("=" * 60)
    print("  slime 独立测试运行器（需 pytest）")
    if keywords:
        print(f"  过滤: {', '.join(keywords)}")
    print("=" * 60)
    print()

    # A-033: 忽略 starlette.testclient 的 httpx 弃用警告（与 pytest.ini 的 filterwarnings 对齐）
    import warnings
    warnings.filterwarnings(
        "ignore", message=r"Using `httpx` with `starlette.testclient` is deprecated"
    )

    # 注册内置工具（测试可能依赖）
    try:
        from tools.builtin import register_builtin_tools
        from tools.registry import get_registry
        reg = get_registry()
        if not reg.list_tool_names():
            register_builtin_tools()
    except Exception:
        pass

    # 发现测试
    test_classes = _discover_test_classes()
    if not test_classes:
        print("未发现任何测试类")
        return

    total_passed = 0
    total_failed = 0
    total_skipped = 0
    all_failures = []
    all_notices = []
    current_module = ""

    for module_name, cls in test_classes:
        if module_name != current_module:
            current_module = module_name
            print(f"\n  -- {module_name} --")

        passed, failed, skipped, failures, notices = _run_test_class(
            cls, verbose=verbose, keywords=keywords
        )
        total_passed += passed
        total_failed += failed
        total_skipped += skipped
        all_failures.extend(failures)
        for n in notices:
            if n not in all_notices:
                all_notices.append(n)

        if not (passed or failed or skipped):
            continue

        # 打印类结果
        status = "OK" if failed == 0 else "FAIL"
        line = f"    {cls.__name__:<40} {passed:>3} passed  {failed:>3} failed  [{status}]"
        if skipped:
            line += f"  {skipped:>3} skipped"
        print(line)

    if all_notices:
        print()
        print("  " + "-" * 58)
        print("  提示:")
        for n in all_notices:
            print(n)

    # 打印失败详情
    if all_failures:
        print()
        print("  " + "-" * 58)
        print("  失败详情:")
        for f in all_failures:
            print(f)
    else:
        print()
        print("  " + "-" * 58)
        print("  全部通过！")

    # 汇总
    print()
    print("=" * 60)
    total = total_passed + total_failed + total_skipped
    pct = (total_passed / total * 100) if total else 0
    status_icon = "OK" if total_failed == 0 else "FAIL"
    print(f"  {status_icon} {total_passed} passed, {total_failed} failed ({pct:.0f}%) -- {total} total")
    if total_skipped:
        print(f"     ({total_skipped} skipped)")
    print("=" * 60)
    print()

    sys.exit(0 if total_failed == 0 else 1)


if __name__ == "__main__":
    main()
