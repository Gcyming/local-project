"""pytest 全局 fixture"""

import pytest


@pytest.fixture(autouse=True)
def _disable_sandbox_audit():
    """每个测试前禁用沙箱审计日志，防止污染生产 data/audit.jsonl"""
    try:
        from core.sandbox import reset_sandbox_manager, SandboxConfig
        reset_sandbox_manager(config=SandboxConfig(audit_enabled=False))
    except Exception:
        pass
    yield


@pytest.fixture(autouse=True)
def _ensure_tools_registered():
    """每个测试运行前确保内置工具已注册（防止 reset_registry 导致工具丢失）"""
    try:
        from tools.builtin import register_builtin_tools
        from tools.registry import get_registry
        # 如果注册表为空，重新注册
        reg = get_registry()
        if not reg.list_tool_names():
            register_builtin_tools()
    except Exception:
        pass
    yield
