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
        from tools.agnes_media import register_agnes_media_tools
        from tools.git import register_git_tools
        from tools.registry import get_registry
        reg = get_registry()
        if not reg.list_tool_names():
            register_builtin_tools()
            try:
                register_agnes_media_tools()
            except Exception:
                pass
            try:
                register_git_tools()
            except Exception:
                pass
    except Exception:
        pass
    yield
