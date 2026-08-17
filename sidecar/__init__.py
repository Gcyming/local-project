"""sidecar/ — Python sidecar（推理 + 嵌入 + 四阶段检索）。

命名记录：曾用 py/，与 PyPI `py` 库（pytest 依赖）同名冲突——
无 __init__.py 时 namespace 包输给 site-packages，有 __init__.py 时
pytest 自身 import py 崩溃。改名 sidecar/ 根治（A-115）。
"""
