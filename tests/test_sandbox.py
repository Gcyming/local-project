"""
slime 沙箱系统专项测试
覆盖：权限分级、SandboxManager、异常检测、审计日志、权限继承、
      工作目录隔离、确认回调、权限提升、Agent 配置加载
"""

import pytest
import tempfile
import os
from pathlib import Path


# ── 权限分级模型 ───────────────────────────────────────────


class TestPermissionLevel:
    """PermissionLevel 枚举测试"""

    def test_level_values(self):
        from core.sandbox import PermissionLevel
        assert PermissionLevel.L0 == 0
        assert PermissionLevel.L1 == 1
        assert PermissionLevel.L2 == 2
        assert PermissionLevel.L3 == 3
        assert PermissionLevel.L4 == 4
        assert PermissionLevel.L5 == 5

    def test_from_string_l_prefix(self):
        from core.sandbox import PermissionLevel
        assert PermissionLevel.from_string("L0") == PermissionLevel.L0
        assert PermissionLevel.from_string("L3") == PermissionLevel.L3
        assert PermissionLevel.from_string("L5") == PermissionLevel.L5

    def test_from_string_numeric(self):
        from core.sandbox import PermissionLevel
        assert PermissionLevel.from_string("0") == PermissionLevel.L0
        assert PermissionLevel.from_string("4") == PermissionLevel.L4

    def test_from_string_invalid(self):
        from core.sandbox import PermissionLevel
        assert PermissionLevel.from_string("abc") == PermissionLevel.L0

    def test_display_name(self):
        from core.sandbox import PermissionLevel
        assert "纯读取" in PermissionLevel.L0.display_name()
        assert "查看信息" in PermissionLevel.L1.display_name()
        assert "修改文件" in PermissionLevel.L2.display_name()
        assert "执行命令" in PermissionLevel.L3.display_name()
        assert "网络访问" in PermissionLevel.L4.display_name()
        assert "系统操作" in PermissionLevel.L5.display_name()


# ── SandboxConfig ─────────────────────────────────────────


class TestSandboxConfig:
    """沙箱配置测试"""

    def test_default_config(self):
        from core.sandbox import SandboxConfig
        cfg = SandboxConfig()
        assert cfg.default_level == "strict"
        assert cfg.auto_approve_levels == [0, 1]
        assert cfg.require_approval_levels == [2, 3, 4]
        assert cfg.deny_levels == [5]
        assert cfg.anomaly_detection_enabled is True
        assert cfg.audit_enabled is True
        assert cfg.workspace == ""

    def test_config_with_workspace(self):
        from core.sandbox import SandboxConfig
        cfg = SandboxConfig(workspace="/tmp/slime_task_001")
        assert cfg.workspace == "/tmp/slime_task_001"

    def test_config_roundtrip(self):
        from core.sandbox import SandboxConfig
        cfg = SandboxConfig(
            default_level="moderated",
            auto_approve_tools=["file_read", "git_status"],
            deny_tools=["sudo", "rm"],
            workspace="/tmp/work",
        )
        d = cfg.to_dict()
        cfg2 = SandboxConfig.from_dict(d)
        assert cfg2.default_level == "moderated"
        assert "file_read" in cfg2.auto_approve_tools
        assert "sudo" in cfg2.deny_tools
        assert cfg2.workspace == "/tmp/work"

    def test_default_level_as_int(self):
        from core.sandbox import SandboxConfig
        assert SandboxConfig(default_level="strict").default_level_as_int() == 1
        assert SandboxConfig(default_level="moderated").default_level_as_int() == 3
        assert SandboxConfig(default_level="relaxed").default_level_as_int() == 5


# ── SandboxManager 核心功能 ───────────────────────────────


class TestSandboxManagerCore:
    """SandboxManager 核心权限管理测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_auto_approve_l0(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        allowed, reason = mgr.grant_permission("agent_test", "file_read", "/tmp/test.txt", level=0)
        assert allowed
        assert "自动批准" in reason or "默认允许" in reason

    def test_auto_approve_l1(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        allowed, reason = mgr.grant_permission("agent_test", "git_log", "/tmp/repo", level=1)
        assert allowed

    def test_deny_l5(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        allowed, reason = mgr.grant_permission("agent_test", "sudo", "rm -rf /", level=5)
        assert not allowed
        assert "禁止" in reason

    def test_check_permission_l0(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        result = mgr.check_permission("agent_test", "file_read", "/tmp/test.txt", level=0)
        assert result.allowed

    def test_check_permission_l5(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        result = mgr.check_permission("agent_test", "sudo", "rm -rf /", level=5)
        assert not result.allowed

    def test_deny_tools(self):
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(deny_tools=["dangerous_tool"])
        mgr = SandboxManager(config=cfg)
        allowed, _ = mgr.grant_permission("agent_test", "dangerous_tool", "/tmp", level=0)
        assert not allowed

    def test_auto_approve_tools(self):
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(auto_approve_tools=["safe_tool"])
        mgr = SandboxManager(config=cfg)
        allowed, reason = mgr.grant_permission("agent_test", "safe_tool", "/tmp", level=3)
        assert allowed
        assert "自动批准" in reason

    def test_require_approval_tools(self):
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(require_approval_tools=["sensitive_tool"])
        mgr = SandboxManager(config=cfg)
        # 无回调时，需确认的操作返回 False
        allowed, reason = mgr.grant_permission("agent_test", "sensitive_tool", "/tmp", level=0)
        assert not allowed
        assert "确认" in reason

    def test_revoke_all(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_test", "file_read", "/tmp/b.txt", level=1)
        mgr.revoke_all("agent_test", reason="测试回收")
        status = mgr.get_permission_status("agent_test")
        assert status["active_grants"] == 0

    def test_revoke_single_permission(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_test", "git_log", "/tmp/repo", level=1)
        mgr.revoke_permission("agent_test", "file_read")
        status = mgr.get_permission_status("agent_test")
        assert status["active_grants"] == 1

    def test_get_permission_status(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        status = mgr.get_permission_status("agent_test")
        assert status["agent_id"] == "agent_test"
        assert status["active_grants"] == 1
        assert "config" in status

    def test_global_singleton(self):
        from core.sandbox import get_sandbox_manager, reset_sandbox_manager
        reset_sandbox_manager()
        mgr1 = get_sandbox_manager()
        mgr2 = get_sandbox_manager()
        assert mgr1 is mgr2


# ── Agent 级配置覆盖 ──────────────────────────────────────


class TestAgentConfigOverride:
    """Agent 级沙箱配置覆盖测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_agent_config_override(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        # Agent 级配置允许 L2 自动通过
        agent_cfg = SandboxConfig(auto_approve_levels=[0, 1, 2])
        mgr.set_agent_config("agent_special", agent_cfg)
        result = mgr.check_permission("agent_special", "file_write", "/tmp/test.txt", level=2)
        assert result.allowed

    def test_agent_config_isolation(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        agent_cfg = SandboxConfig(deny_levels=[5, 4])  # 更严格
        mgr.set_agent_config("agent_strict", agent_cfg)
        # agent_strict 的 L4 被禁止
        result = mgr.check_permission("agent_strict", "pip", "install", level=4)
        assert not result.allowed
        # 其他 Agent 的 L4 仍需确认（不在 deny 中）
        result2 = mgr.check_permission("agent_normal", "pip", "install", level=4)
        assert not result2.allowed  # 需确认=不允许

    def test_remove_agent_config(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        agent_cfg = SandboxConfig(auto_approve_levels=[0, 1, 2, 3])
        mgr.set_agent_config("agent_test", agent_cfg)
        assert mgr.check_permission("agent_test", "pytest", "/tmp", level=3).allowed
        mgr.remove_agent_config("agent_test")
        # 移除后回退到全局默认
        result = mgr.check_permission("agent_test", "pytest", "/tmp", level=3)
        assert not result.allowed  # L3 需确认


# ── 权限继承 ───────────────────────────────────────────────


class TestPermissionInheritance:
    """子 Agent 权限继承测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_child_inherits_parent_config(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        # 父 Agent 允许 L2
        parent_cfg = SandboxConfig(auto_approve_levels=[0, 1, 2], inherit_from_parent=True)
        mgr.set_agent_config("parent_agent", parent_cfg)
        mgr.register_agent("child_agent", parent_id="parent_agent", name="子Agent")
        # 子 Agent 应继承父 Agent 的 L2 自动批准
        result = mgr.check_permission("child_agent", "file_write", "/tmp/test.txt", level=2)
        assert result.allowed

    def test_child_no_inherit_when_disabled(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        parent_cfg = SandboxConfig(auto_approve_levels=[0, 1, 2], inherit_from_parent=False)
        mgr.set_agent_config("parent_agent", parent_cfg)
        mgr.register_agent("child_agent", parent_id="parent_agent", name="子Agent")
        # 继承被禁止，子 Agent 使用全局默认
        result = mgr.check_permission("child_agent", "file_write", "/tmp/test.txt", level=2)
        assert not result.allowed  # 全局默认 L2 需确认

    def test_child_override_takes_precedence(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        # 父 Agent 允许 L2-L4
        parent_cfg = SandboxConfig(auto_approve_levels=[0, 1, 2, 3, 4], inherit_from_parent=True)
        mgr.set_agent_config("parent_agent", parent_cfg)
        mgr.register_agent("child_agent", parent_id="parent_agent", name="子Agent")
        # 子 Agent 自己的配置更严格
        child_cfg = SandboxConfig(auto_approve_levels=[0, 1], deny_levels=[5, 4])
        mgr.set_agent_config("child_agent", child_cfg)
        result = mgr.check_permission("child_agent", "pip", "install", level=4)
        assert not result.allowed  # 子 Agent 自己禁止 L4

    def test_child_workspace_not_inherited(self):
        from core.sandbox import SandboxManager, SandboxConfig
        mgr = SandboxManager()
        parent_cfg = SandboxConfig(workspace="/tmp/parent_work", inherit_from_parent=True)
        mgr.set_agent_config("parent_agent", parent_cfg)
        mgr.register_agent("child_agent", parent_id="parent_agent")
        child_config = mgr._get_agent_config("child_agent")
        assert child_config.workspace == ""  # 子 Agent 不继承工作目录


# ── 工作目录隔离 ───────────────────────────────────────────


class TestWorkspaceIsolation:
    """工作目录隔离测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_workspace_allows_inside(self, tmp_path):
        from core.sandbox import SandboxManager, SandboxConfig
        work_dir = str(tmp_path / "workspace")
        os.makedirs(work_dir, exist_ok=True)
        cfg = SandboxConfig(workspace=work_dir, auto_approve_levels=[0, 1, 2])
        mgr = SandboxManager(config=cfg)
        target = os.path.join(work_dir, "test.txt")
        allowed, _ = mgr.grant_permission("agent_test", "file_write", target, level=2)
        assert allowed

    def test_workspace_blocks_outside(self, tmp_path):
        from core.sandbox import SandboxManager, SandboxConfig
        work_dir = str(tmp_path / "workspace")
        os.makedirs(work_dir, exist_ok=True)
        cfg = SandboxConfig(workspace=work_dir)
        mgr = SandboxManager(config=cfg)
        # 尝试访问工作目录外的路径
        outside = str(tmp_path / "outside.txt")
        allowed, reason = mgr.grant_permission("agent_test", "file_write", outside, level=0)
        assert not allowed
        assert "工作目录" in reason or "超出" in reason

    def test_workspace_empty_no_restriction(self):
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(workspace="")
        mgr = SandboxManager(config=cfg)
        # workspace 为空，不限制路径
        allowed, _ = mgr.grant_permission("agent_test", "file_read", "/anywhere/test.txt", level=0)
        assert allowed

    def test_workspace_nested_path(self, tmp_path):
        from core.sandbox import SandboxManager, SandboxConfig
        work_dir = str(tmp_path / "workspace")
        os.makedirs(work_dir, exist_ok=True)
        cfg = SandboxConfig(workspace=work_dir, auto_approve_levels=[0, 1, 2])
        mgr = SandboxManager(config=cfg)
        target = os.path.join(work_dir, "subdir", "nested", "file.txt")
        allowed, _ = mgr.grant_permission("agent_test", "file_write", target, level=2)
        assert allowed

    def test_workspace_agent_level(self, tmp_path):
        from core.sandbox import SandboxManager, SandboxConfig
        work_dir = str(tmp_path / "agent_workspace")
        os.makedirs(work_dir, exist_ok=True)
        mgr = SandboxManager()
        mgr.set_agent_config("isolated_agent", SandboxConfig(
            workspace=work_dir,
            auto_approve_levels=[0, 1, 2],
        ))
        # 工作目录内允许
        inside = os.path.join(work_dir, "file.txt")
        assert mgr.check_permission("isolated_agent", "file_write", inside, level=2).allowed
        # 工作目录外拒绝
        outside = str(tmp_path / "outside.txt")
        assert not mgr.check_permission("isolated_agent", "file_write", outside, level=2).allowed


# ── 确认回调 ───────────────────────────────────────────────


class TestApprovalCallback:
    """用户确认回调测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_approval_callback_approved(self):
        from core.sandbox import SandboxManager, ApprovalDecision, PermissionRequest
        def approve_all(req: PermissionRequest) -> ApprovalDecision:
            return ApprovalDecision(
                request_id=req.request_id,
                approved=True,
                approved_actions=[a["action"] for a in req.actions],
            )
        mgr = SandboxManager(approval_callback=approve_all)
        allowed, reason = mgr.grant_permission("agent_test", "file_write", "/tmp/test.txt", level=2)
        assert allowed
        assert "用户批准" in reason

    def test_approval_callback_denied(self):
        from core.sandbox import SandboxManager, ApprovalDecision, PermissionRequest
        def deny_all(req: PermissionRequest) -> ApprovalDecision:
            return ApprovalDecision(
                request_id=req.request_id,
                approved=False,
                reason="测试拒绝",
            )
        mgr = SandboxManager(approval_callback=deny_all)
        allowed, reason = mgr.grant_permission("agent_test", "file_write", "/tmp/test.txt", level=2)
        assert not allowed
        assert "用户拒绝" in reason

    def test_no_callback_denies_l2(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()  # 无回调
        allowed, reason = mgr.grant_permission("agent_test", "file_write", "/tmp/test.txt", level=2)
        assert not allowed
        assert "确认" in reason

    def test_set_callback_after_init(self):
        from core.sandbox import SandboxManager, ApprovalDecision, PermissionRequest
        mgr = SandboxManager()
        # 初始无回调，L2 被拒
        allowed, _ = mgr.grant_permission("agent_test", "file_write", "/tmp", level=2)
        assert not allowed
        # 设置回调后允许
        mgr.set_approval_callback(lambda req: ApprovalDecision(approved=True, request_id=req.request_id))
        allowed, reason = mgr.grant_permission("agent_test", "file_write", "/tmp", level=2)
        assert allowed
        assert "用户批准" in reason

    def test_callback_receives_request_info(self):
        from core.sandbox import SandboxManager, ApprovalDecision, PermissionRequest
        received_request = {}
        def capture_callback(req: PermissionRequest) -> ApprovalDecision:
            received_request["agent_id"] = req.agent_id
            received_request["actions"] = req.actions
            return ApprovalDecision(approved=True, request_id=req.request_id)
        mgr = SandboxManager(approval_callback=capture_callback)
        mgr.register_agent("agent_test", name="测试Agent")
        mgr.grant_permission("agent_test", "file_write", "/tmp/test.txt", level=2)
        assert received_request.get("agent_id") == "agent_test"
        assert len(received_request.get("actions", [])) == 1


# ── 权限提升 ───────────────────────────────────────────────


class TestPermissionUpgrade:
    """权限提升流程测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_main_agent_no_upgrade_needed(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        # 主 Agent（无 parent_id）无需提升
        mgr.register_agent("main_agent", parent_id="")
        allowed, reason = mgr.request_permission_upgrade("main_agent", 3)
        assert allowed
        assert "无需" in reason

    def test_child_upgrade_approved(self):
        from core.sandbox import SandboxManager, ApprovalDecision, PermissionRequest
        def approve(req: PermissionRequest) -> ApprovalDecision:
            return ApprovalDecision(approved=True, request_id=req.request_id)
        mgr = SandboxManager(approval_callback=approve)
        mgr.register_agent("child_agent", parent_id="main_agent", name="子Agent")
        # L3 原本需确认
        assert not mgr.check_permission("child_agent", "pytest", "/tmp", level=3).allowed
        # 申请提升
        allowed, reason = mgr.request_permission_upgrade("child_agent", 3, reason="需要运行测试")
        assert allowed
        assert "批准" in reason
        # 提升后 L3 自动批准
        assert mgr.check_permission("child_agent", "pytest", "/tmp", level=3).allowed

    def test_child_upgrade_denied(self):
        from core.sandbox import SandboxManager, ApprovalDecision, PermissionRequest
        def deny(req: PermissionRequest) -> ApprovalDecision:
            return ApprovalDecision(approved=False, request_id=req.request_id, reason="不允许")
        mgr = SandboxManager(approval_callback=deny)
        mgr.register_agent("child_agent", parent_id="main_agent")
        allowed, reason = mgr.request_permission_upgrade("child_agent", 3)
        assert not allowed
        assert "拒绝" in reason

    def test_child_upgrade_denied_level(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.register_agent("child_agent", parent_id="main_agent")
        # L5 被禁止
        allowed, reason = mgr.request_permission_upgrade("child_agent", 5)
        assert not allowed
        assert "禁止" in reason

    def test_child_upgrade_no_callback(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()  # 无回调
        mgr.register_agent("child_agent", parent_id="main_agent")
        allowed, reason = mgr.request_permission_upgrade("child_agent", 3)
        assert not allowed
        assert "确认" in reason


# ── 异常检测 ───────────────────────────────────────────────


class TestAnomalyDetector:
    """异常行为检测器测试"""

    def test_suspicious_pattern_rm_rf(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, alerts = detector.check("agent_test", "terminal", "rm -rf /")
        assert detected
        assert any("危险操作" in a for a in alerts)

    def test_suspicious_pattern_sudo(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, _ = detector.check("agent_test", "terminal", "sudo rm file.txt")
        assert detected

    def test_suspicious_pattern_chmod(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, _ = detector.check("agent_test", "terminal", "chmod 777 /etc/passwd")
        assert detected

    def test_safe_operation(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detected, alerts = detector.check("agent_test", "file_read", "/tmp/test.txt")
        assert not detected

    def test_loop_detection(self):
        from core.sandbox import AnomalyDetector, AnomalyRule
        detector = AnomalyDetector(rules=[
            AnomalyRule(name="loop_detection", description="循环操作", action="terminate", threshold=5),
        ])
        for i in range(5):
            detected, _ = detector.check("agent_test", "any", f"target_{i}")
            assert not detected
        detected, alerts = detector.check("agent_test", "any", "target_6")
        assert detected

    def test_reset_agent(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        for i in range(10):
            detector.check("agent_test", "write", f"target_{i}")
        detector.reset("agent_test")
        detected, _ = detector.check("agent_test", "write", "new_target")
        assert not detected

    def test_reset_all(self):
        from core.sandbox import AnomalyDetector
        detector = AnomalyDetector()
        detector.check("agent_a", "write", "target")
        detector.check("agent_b", "write", "target")
        detector.reset()
        assert len(detector._rate_counters) == 0
        assert len(detector._iteration_counters) == 0


# ── 审计日志 ───────────────────────────────────────────────


class TestAuditLog:
    """审计日志测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_audit_entry_creation(self):
        from core.sandbox import AuditEntry
        entry = AuditEntry(
            agent_id="agent_test",
            action="file_write",
            target="/tmp/test.txt",
            level=2,
            status="allowed",
            risk_score=0.3,
        )
        d = entry.to_dict()
        assert d["agent_id"] == "agent_test"
        assert d["action"] == "file_write"
        assert d["status"] == "allowed"
        assert d["risk_score"] == 0.3
        assert "entry_id" in d
        assert "timestamp" in d

    def test_audit_logged_on_grant(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        entries = mgr.query_audit(agent_id="agent_test")
        assert len(entries) >= 1
        assert entries[0]["action"] == "file_read"
        assert entries[0]["status"] == "allowed"

    def test_audit_logged_on_deny(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "sudo", "rm -rf /", level=5)
        entries = mgr.query_audit(agent_id="agent_test")
        assert len(entries) >= 1
        assert entries[0]["status"] == "denied"

    def test_audit_logged_on_revoke(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        mgr.revoke_all("agent_test", reason="测试")
        entries = mgr.query_audit(agent_id="agent_test")
        statuses = [e["status"] for e in entries]
        assert "revoked" in statuses

    def test_audit_summary(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_test", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_test", "git_log", "/tmp/repo", level=1)
        mgr.grant_permission("agent_test", "sudo", "rm", level=5)
        summary = mgr.get_audit_summary()
        assert summary["total_operations"] >= 3
        assert summary["allowed"] >= 2
        assert summary["denied"] >= 1

    def test_audit_query_limit(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        for i in range(20):
            mgr.grant_permission("agent_test", "file_read", f"/tmp/{i}.txt", level=0)
        entries = mgr.query_audit(limit=5)
        assert len(entries) <= 5

    def test_audit_query_by_different_agents(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.grant_permission("agent_a", "file_read", "/tmp/a.txt", level=0)
        mgr.grant_permission("agent_b", "file_read", "/tmp/b.txt", level=0)
        a_entries = mgr.query_audit(agent_id="agent_a")
        b_entries = mgr.query_audit(agent_id="agent_b")
        assert all(e["agent_id"] == "agent_a" for e in a_entries)
        assert all(e["agent_id"] == "agent_b" for e in b_entries)


# ── 风险评分 ───────────────────────────────────────────────


class TestRiskScore:
    """风险评分测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_low_risk_read(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        score = mgr.calculate_risk_score("file_read")
        assert 0.0 <= score <= 0.3

    def test_high_risk_sudo(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        score = mgr.calculate_risk_score("sudo")
        assert score >= 0.9

    def test_system_path_risk(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        score = mgr.calculate_risk_score("file_write", {"target": "/etc/passwd"})
        assert score > 0.3  # 系统路径加分

    def test_score_capped_at_1(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        score = mgr.calculate_risk_score("sudo", {"target": "/etc/shadow"})
        assert score <= 1.0


# ── Agent 配置加载 ────────────────────────────────────────


class TestAgentConfigLoading:
    """Agent 沙箱配置加载测试"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_load_agent_sandbox_configs(self):
        from core.sandbox import load_agent_sandbox_configs, get_sandbox_manager, SandboxConfig

        class MockAgent:
            def __init__(self, agent_id, parent_id="", name="", sandbox_override=None):
                self.id = agent_id
                self.parent_id = parent_id
                self.name = name
                self.sandbox_override = sandbox_override or {}

        agents = [
            MockAgent("agent_main", name="主Agent", sandbox_override={
                "default_level": "moderated",
                "auto_approve_tools": ["file_read"],
            }),
            MockAgent("agent_child", parent_id="agent_main", name="子Agent"),
        ]
        count = load_agent_sandbox_configs(agents)
        assert count == 1  # 只有主 Agent 有 override

        mgr = get_sandbox_manager()
        # 主 Agent 配置已加载
        config = mgr._get_agent_config("agent_main")
        assert config.default_level == "moderated"
        assert "file_read" in config.auto_approve_tools

        # 子 Agent 已注册
        assert "agent_child" in mgr._agent_registry
        assert mgr._agent_registry["agent_child"]["parent_id"] == "agent_main"

    def test_register_agent(self):
        from core.sandbox import SandboxManager
        mgr = SandboxManager()
        mgr.register_agent("agent_001", parent_id="agent_000", name="测试", task_id="task_001")
        info = mgr._agent_registry["agent_001"]
        assert info["parent_id"] == "agent_000"
        assert info["name"] == "测试"
        assert info["task_id"] == "task_001"


# ── A-002: 工具名单通配匹配 ────────────────────────────────


class TestToolGlobMatching:
    """工具名单 fnmatch 通配（A-002：MCP 工具 server 模式可用性）"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_tool_matches_helper(self):
        from core.sandbox import _tool_matches
        assert _tool_matches("mcp_browser_navigate", ["mcp_*"])
        assert _tool_matches("mcp_browser_navigate", ["mcp_browser_*"])
        assert not _tool_matches("mcp_browser_navigate", ["mcp_res_*"])
        assert not _tool_matches("mcp_browser_navigate", [])
        # 精确名与通配混合
        assert _tool_matches("web_fetch", ["web_fetch", "mcp_*"])

    def test_auto_approve_glob(self):
        """A-088（漏洞清单 P1-9）：mcp_* 通配 + L4（network）→ 不自动批准（需确认），
        防权限声明失效（此前 mcp_* 无条件自动批准 network 级工具）"""
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(auto_approve_tools=["mcp_*"])
        mgr = SandboxManager(config=cfg)
        result = mgr.check_permission("agent_a", "mcp_browser_navigate",
                                      "https://example.com", level=4)
        assert not result.allowed, "L4 MCP 工具不应被 mcp_* 通配自动批准"
        assert "需要用户确认" in result.reason
        # 低权限（read/L0）MCP 工具仍自动批准（保留 MCP 可用性）
        r2 = mgr.check_permission("agent_a", "mcp_read_file", "x", level=0)
        assert r2.allowed, "低权限 MCP 工具应自动批准"

    def test_auto_approve_glob_not_match_others(self):
        """非匹配名不受通配影响（fail-closed 保持）"""
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(auto_approve_tools=["mcp_browser_*"])
        mgr = SandboxManager(config=cfg)
        result = mgr.check_permission("agent_a", "mcp_other_tool", "/x", level=4)
        assert not result.allowed

    def test_deny_glob(self):
        """deny_tools 通配优先于自动批准"""
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(auto_approve_tools=["mcp_*"], deny_tools=["mcp_browser_kill*"])
        mgr = SandboxManager(config=cfg)
        result = mgr.check_permission("agent_a", "mcp_browser_kill_all", "/x", level=4)
        assert not result.allowed

    def test_require_approval_glob(self):
        """require_approval_tools 通配无回调时拒绝"""
        from core.sandbox import SandboxManager, SandboxConfig
        cfg = SandboxConfig(require_approval_tools=["mcp_terminal_*"])
        mgr = SandboxManager(config=cfg)
        result = mgr.check_permission("agent_a", "mcp_terminal_exec", "/x", level=0)
        assert not result.allowed
        assert "确认" in result.reason


class TestAgentOverrideMerge:
    """A-002: Agent 级 override 与全局默认合并（部分覆盖不再整体替换）"""

    def setup_method(self):
        from core.sandbox import reset_sandbox_manager
        reset_sandbox_manager()

    def test_override_keeps_global_defaults(self):
        """只写 auto_approve_tools 的 override 不丢全局 auto_approve_levels"""
        from core.sandbox import reset_sandbox_manager, SandboxConfig, get_sandbox_manager
        from core.sandbox import load_agent_sandbox_configs
        reset_sandbox_manager(config=SandboxConfig(auto_approve_tools=["mcp_*"]))

        class MockAgent:
            def __init__(self):
                self.id = "agent_m"
                self.parent_id = None
                self.name = "M"
                self.sandbox_override = {"auto_approve_tools": ["web_fetch"]}

        load_agent_sandbox_configs([MockAgent()])
        mgr = get_sandbox_manager()
        cfg = mgr._get_agent_config("agent_m")
        # 全局默认等级保留
        assert cfg.auto_approve_levels == [0, 1]
        # 列表字段并集：全局 mcp_* + override web_fetch 都在
        assert "web_fetch" in cfg.auto_approve_tools
        assert "mcp_*" in cfg.auto_approve_tools

    def test_override_scalar_replaces(self):
        """标量字段（default_level）override 生效"""
        from core.sandbox import reset_sandbox_manager, get_sandbox_manager
        from core.sandbox import load_agent_sandbox_configs

        class MockAgent:
            def __init__(self):
                self.id = "agent_m"
                self.parent_id = None
                self.name = "M"
                self.sandbox_override = {"default_level": "moderated"}

        load_agent_sandbox_configs([MockAgent()])
        mgr = get_sandbox_manager()
        cfg = mgr._get_agent_config("agent_m")
        assert cfg.default_level == "moderated"
        assert cfg.auto_approve_levels == [0, 1]  # 全局默认保留


# ── 数据类测试 ────────────────────────────────────────────


class TestDataClasses:
    """数据类序列化测试"""

    def test_permission_request(self):
        from core.sandbox import PermissionRequest
        req = PermissionRequest(
            agent_id="agent_test",
            agent_name="测试Agent",
            task_id="task_001",
            task_description="修复bug",
            actions=[
                {"action": "file_write", "target": "src/main.py", "level": 2},
                {"action": "file_read", "target": "src/test.py", "level": 0},
            ],
        )
        d = req.to_dict()
        assert d["agent_name"] == "测试Agent"
        assert len(d["actions"]) == 2
        assert d["actions"][0]["level"] == 2

    def test_approval_decision(self):
        from core.sandbox import ApprovalDecision
        decision = ApprovalDecision(
            request_id="perm_001",
            approved=True,
            approved_actions=["file_read", "file_write"],
            denied_actions=[],
            reason="用户批准",
        )
        assert decision.approved
        assert len(decision.approved_actions) == 2

    def test_permission_check_result(self):
        from core.sandbox import PermissionCheckResult
        result = PermissionCheckResult(
            allowed=False,
            reason="需要确认",
            level=2,
            anomaly_detected=True,
            anomaly_alerts=["危险操作"],
        )
        assert not result.allowed
        assert result.level == 2
        assert result.anomaly_detected
        assert "危险操作" in result.anomaly_alerts


# ── 向后兼容层测试 ────────────────────────────────────────


class TestBackwardCompat:
    """向后兼容层测试"""

    def test_create_default_sandbox(self):
        from core.sandbox import create_default_sandbox
        s = create_default_sandbox()
        assert not s.allows_write
        assert not s.allows_terminal
        assert not s.allows_network

    def test_create_from_manifest(self):
        from core.sandbox import create_from_manifest
        s = create_from_manifest({"read": True, "write": True, "terminal": False})
        assert s.allows_write
        assert not s.allows_terminal

    def test_sandbox_denied_summary(self):
        from core.sandbox import create_default_sandbox
        s = create_default_sandbox()
        s.require_write("test")
        s.require_terminal("test")
        denied = s.get_denied_summary()
        assert len(denied) == 2

    def test_sandbox_clear_denied(self):
        from core.sandbox import create_default_sandbox
        s = create_default_sandbox()
        s.require_write("test")
        assert len(s.get_denied_summary()) == 1
        s.clear_denied()
        assert len(s.get_denied_summary()) == 0

    def test_sandbox_with_agent_id(self):
        from core.sandbox import create_default_sandbox, get_sandbox_manager, SandboxConfig, reset_sandbox_manager
        reset_sandbox_manager()
        # 使用全局单例设置 Agent 配置
        mgr = get_sandbox_manager()
        mgr.set_agent_config("agent_test", SandboxConfig(auto_approve_levels=[0, 1, 2]))
        # 创建带 agent_id 的沙箱（使用全局 manager）
        s = create_default_sandbox(agent_id="agent_test")
        # 通过全局 SandboxManager 检查 L2
        assert s.require_write("test_tool")
