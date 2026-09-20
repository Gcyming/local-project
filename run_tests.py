"""
slime 独立测试运行器
用法: python run_tests.py
（测试模块须已安装 pytest，运行器不做依赖校验）
"""

import sys
import os
import asyncio
import tempfile
import traceback
import inspect
from pathlib import Path

# 确保项目根目录在 sys.path 中
_PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_PROJECT_ROOT))


def _run_test_class(cls) -> tuple[int, int, list[str]]:
    """运行一个测试类的所有 test_ 方法，返回 (通过数, 失败数, 失败信息)"""
    passed = 0
    failed = 0
    failures = []

    # 收集所有 test_ 开头的方法
    methods = sorted([
        name for name, _ in inspect.getmembers(cls, predicate=inspect.isfunction)
        if name.startswith("test_")
    ])

    if not methods:
        return 0, 0, []

    for method_name in methods:
        # 为每个测试创建实例
        instance = cls()

        # 运行 setup_method（如果有）
        if hasattr(instance, "setup_method"):
            try:
                instance.setup_method()
            except Exception as e:
                failed += 1
                failures.append(f"  {cls.__name__}::{method_name} [SETUP FAILED]: {e}")
                continue

        # 检查方法签名，处理 tmp_path 参数
        method = getattr(instance, method_name)
        sig = inspect.signature(method)
        kwargs = {}
        for param_name, param in sig.parameters.items():
            if param_name == "self":
                continue
            # pytest 的 tmp_path fixture
            if param_name == "tmp_path":
                kwargs[param_name] = Path(tempfile.mkdtemp())

        # 运行测试（支持 async 方法）
        tmp_dirs = [v for v in kwargs.values() if isinstance(v, Path)]
        try:
            result = method(**kwargs)
            if inspect.iscoroutine(result):
                asyncio.run(result)
            passed += 1
        except AssertionError as e:
            failed += 1
            failures.append(f"  {cls.__name__}::{method_name} [ASSERT]: {e}")
        except Exception as e:
            failed += 1
            tb_lines = traceback.format_exception(type(e), e, e.__traceback__)
            short_tb = "".join(tb_lines[-3:]).strip()
            failures.append(f"  {cls.__name__}::{method_name} [ERROR]: {short_tb}")
        finally:
            import shutil
            for d in tmp_dirs:
                shutil.rmtree(str(d), ignore_errors=True)

    return passed, failed, failures


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


def main():
    print()
    print("=" * 60)
    print("  slime 独立测试运行器（需 pytest）")
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
    all_failures = []
    current_module = ""

    for module_name, cls in test_classes:
        if module_name != current_module:
            current_module = module_name
            print(f"\n  -- {module_name} --")

        passed, failed, failures = _run_test_class(cls)
        total_passed += passed
        total_failed += failed
        all_failures.extend(failures)

        # 打印类结果
        status = "OK" if failed == 0 else "FAIL"
        print(f"    {cls.__name__:<40} {passed:>3} passed  {failed:>3} failed  [{status}]")

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
    total = total_passed + total_failed
    pct = (total_passed / total * 100) if total else 0
    status_icon = "OK" if total_failed == 0 else "FAIL"
    print(f"  {status_icon} {total_passed} passed, {total_failed} failed ({pct:.0f}%) -- {total} total")
    print("=" * 60)
    print()

    sys.exit(0 if total_failed == 0 else 1)


if __name__ == "__main__":
    main()
