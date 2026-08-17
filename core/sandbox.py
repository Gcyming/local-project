"""
slime 沙箱系统
- 权限分级模型 (L0-L5)，默认只读
- 审计日志记录所有操作
- 异常行为检测（危险模式、速率限制、资源耗尽）
- Agent 级沙箱配置覆盖
- 权限继承与回收
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from enum import IntEnum, auto
from pathlib import Path
from typing import Callable

# ── 项目根目录 ────────────────────────────────────────────

def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


# ── 权限分级 ──────────────────────────────────────────────

class PermissionLevel(IntEnum):
    """权限分级模型"""
    L0 = 0  # 纯读取：cat, ls, file_read
    L1 = 1  # 查看信息：git log, pytest --collect-only
    L2 = 2  # 修改文件：vim, file_write, git add
    L3 = 3  # 执行命令：pytest, python -m test
    L4 = 4  # 网络访问：pip install, git push
    L5 = 5  # 系统操作：sudo, kill, rm -rf

    @classmethod
    def from_string(cls, s: str) -> "PermissionLevel":
        """从字符串解析，支持 'L0' 和 '0' 两种格式"""
        s = s.strip().upper().lstrip("L")
        try:
            return cls(int(s))
        except (ValueError, KeyError):
            return cls.L0  # 解析失败回退最安全等级

    def display_name(self) -> str:
        names = {
            PermissionLevel.L0: "纯读取",
            PermissionLevel.L1: "查看信息",
            PermissionLevel.L2: "修改文件",
            PermissionLevel.L3: "执行命令",
            PermissionLevel.L4: "网络访问",
            PermissionLevel.L5: "系统操作",
        }
        return names.get(self, "未知")


def _tool_matches(action: str, patterns: list[str]) -> bool:
    """工具名匹配（A-002）：支持 fnmatch 通配，如 "mcp_browser_*"。
    精确名与通配符混合使用；空列表恒 False。"""
    if not patterns:
        return False
    return any(fnmatch.fnmatchcase(action, p) for p in patterns)


# ── 审计日志 ──────────────────────────────────────────────

@dataclass
class AuditEntry:
    """审计日志条目"""
    entry_id: str = field(default_factory=lambda: f"audit_{uuid.uuid4().hex[:12]}")
    timestamp: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    agent_id: str = ""
    task_id: str = ""
    action: str = ""
    target: str = ""
    level: int = 0
    status: str = "allowed"  # allowed | denied | revoked
    granted_by: str = "auto"  # auto | user | main_agent
    grant_id: str = ""
    details: dict = field(default_factory=dict)
    risk_score: float = 0.0
    anomaly_detected: bool = False

    def to_dict(self) -> dict:
        return {
            "entry_id": self.entry_id,
            "timestamp": self.timestamp,
            "agent_id": self.agent_id,
            "task_id": self.task_id,
            "action": self.action,
            "target": self.target,
            "level": self.level,
            "status": self.status,
            "granted_by": self.granted_by,
            "grant_id": self.grant_id,
            "details": self.details,
            "risk_score": self.risk_score,
            "anomaly_detected": self.anomaly_detected,
        }


# ── 异常检测规则 ──────────────────────────────────────────

@dataclass
class AnomalyRule:
    """异常检测规则"""
    name: str
    description: str
    action: str  # alert | deny | deny+alert | terminate
    threshold: int | float = 0
    patterns: list[str] = field(default_factory=list)

    def check(self, action: str, target: str, context: dict | None = None) -> bool:
        """检查是否触发此规则"""
        if self.patterns:
            for pattern in self.patterns:
                if re.search(pattern, target, re.IGNORECASE) or re.search(pattern, action, re.IGNORECASE):
                    return True
        return False


# ── 默认异常检测规则 ──────────────────────────────────────

DEFAULT_ANOMALY_RULES: list[AnomalyRule] = [
    AnomalyRule(
        name="write_rate_limit",
        description="写入操作过于频繁",
        action="alert",
        threshold=100,
    ),
    AnomalyRule(
        name="file_size_limit",
        description="单文件过大",
        action="deny",
        threshold=50,
    ),
    AnomalyRule(
        name="suspicious_patterns",
        description="检测到危险操作模式",
        action="deny+alert",
        patterns=[
            r"rm\s+-rf\s+/",
            r"chmod\s+777",
            r"curl\s+.*\|\s*bash",
            r"wget\s+.*\|\s*sh",
            r">\s*/dev/sda",
            r"format\s+[A-Z]:",
            r"del\s+/[FfSQq]",
            r"sudo\s+",
            r"mkfs\.",
            r"dd\s+if=",
        ],
    ),
    AnomalyRule(
        name="loop_detection",
        description="检测到循环操作",
        action="terminate",
        threshold=1000,
    ),
    AnomalyRule(
        name="resource_exhaustion",
        description="检测到资源耗尽风险",
        action="alert",
        threshold=90,
    ),
]


class AnomalyDetector:
    """异常行为检测器"""

    def __init__(self, rules: list[AnomalyRule] | None = None):
        self.rules = rules or DEFAULT_ANOMALY_RULES
        self._rate_counters: dict[str, list[float]] = {}  # action -> timestamps
        self._iteration_counters: dict[str, int] = {}  # agent_id -> count

    def check(self, agent_id: str, action: str, target: str,
              context: dict | None = None) -> tuple[bool, list[str]]:
        """检查操作是否异常，返回 (是否有异常, 告警列表)"""
        alerts: list[str] = []

        for rule in self.rules:
            if rule.name == "write_rate_limit":
                if self._check_rate_limit(agent_id, action, rule.threshold):
                    alerts.append(rule.description)
            elif rule.name == "file_size_limit":
                if self._check_file_size(target, context, rule.threshold):
                    alerts.append(rule.description)
            elif rule.name == "loop_detection":
                if self._check_loop(agent_id, rule.threshold):
                    alerts.append(rule.description)
            elif rule.check(action, target, context):
                alerts.append(rule.description)

        return len(alerts) > 0, alerts

    def _check_rate_limit(self, agent_id: str, action: str, threshold: float) -> bool:
        """检查写入速率。先检查后记录，避免拒绝操作被计入。"""
        if "write" not in action.lower() and "delete" not in action.lower():
            return False
        key = f"{agent_id}:{action}"
        now = time.time()
        self._rate_counters.setdefault(key, [])
        # 先清理旧记录再判断（不计入本次调用）
        recent = [t for t in self._rate_counters[key] if now - t < 60]
        exceeded = len(recent) >= threshold
        # 记录本次（即使超限也记录，防止持续冲击）
        recent.append(now)
        self._rate_counters[key] = recent
        return exceeded

    def _check_loop(self, agent_id: str, threshold: int) -> bool:
        """检查循环操作"""
        self._iteration_counters[agent_id] = self._iteration_counters.get(agent_id, 0) + 1
        return self._iteration_counters[agent_id] > threshold

    def _check_file_size(self, target: str, context: dict | None, threshold_mb: float) -> bool:
        """检查文件大小是否超过限制。context 优先；无 context 时尝试 stat target 路径。"""
        size_bytes = 0
        if context:
            size_bytes = context.get("file_size", 0)
        if not size_bytes and target:
            try:
                p = Path(target)
                if p.exists() and p.is_file():
                    size_bytes = p.stat().st_size
            except OSError:
                pass
        if not size_bytes or not isinstance(size_bytes, (int, float)):
            return False
        return size_bytes > threshold_mb * 1024 * 1024

    def reset(self, agent_id: str = ""):
        """重置计数器"""
        if agent_id:
            self._rate_counters = {k: v for k, v in self._rate_counters.items()
                                   if not k.startswith(agent_id)}
            self._iteration_counters.pop(agent_id, None)
        else:
            self._rate_counters.clear()
            self._iteration_counters.clear()


# ── 沙箱配置 ──────────────────────────────────────────────

@dataclass
class SandboxConfig:
    """沙箱配置（支持全局和 Agent 级覆盖）"""
    default_level: str = "strict"  # strict | moderated | relaxed
    auto_approve_levels: list[int] = field(default_factory=lambda: [0, 1])
    require_approval_levels: list[int] = field(default_factory=lambda: [2, 3, 4])
    deny_levels: list[int] = field(default_factory=lambda: [5])
    auto_approve_tools: list[str] = field(default_factory=list)
    deny_tools: list[str] = field(default_factory=list)
    require_approval_tools: list[str] = field(default_factory=list)
    timeout_seconds: int = 300
    max_concurrent_permissions: int = 10
    inherit_from_parent: bool = True
    anomaly_detection_enabled: bool = True
    write_rate_limit: int = 100
    file_size_limit_mb: int = 50
    audit_enabled: bool = True
    audit_log_path: str = "data/audit.jsonl"
    audit_retention_days: int = 90
    workspace: str = ""  # Agent 工作目录隔离（空字符串=不限制）

    def to_dict(self) -> dict:
        return {
            "default_level": self.default_level,
            "auto_approve_levels": self.auto_approve_levels,
            "require_approval_levels": self.require_approval_levels,
            "deny_levels": self.deny_levels,
            "auto_approve_tools": self.auto_approve_tools,
            "deny_tools": self.deny_tools,
            "require_approval_tools": self.require_approval_tools,
            "timeout_seconds": self.timeout_seconds,
            "max_concurrent_permissions": self.max_concurrent_permissions,
            "inherit_from_parent": self.inherit_from_parent,
            "anomaly_detection_enabled": self.anomaly_detection_enabled,
            "write_rate_limit": self.write_rate_limit,
            "file_size_limit_mb": self.file_size_limit_mb,
            "audit_enabled": self.audit_enabled,
            "audit_log_path": self.audit_log_path,
            "audit_retention_days": self.audit_retention_days,
            "workspace": self.workspace,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SandboxConfig":
        if not isinstance(data, dict):
            return cls()
        # 解析嵌套配置
        child_default = data.get("child_default", {})
        anomaly = data.get("anomaly_detection", {})
        audit = data.get("audit", {})
        return cls(
            default_level=data.get("default_level", "strict"),
            auto_approve_levels=data.get("auto_approve_levels", [0, 1]),
            require_approval_levels=data.get("require_approval_levels", [2, 3, 4]),
            deny_levels=data.get("deny_levels", [5]),
            auto_approve_tools=data.get("auto_approve_tools", []),
            deny_tools=data.get("deny_tools", []),
            require_approval_tools=data.get("require_approval_tools", []),
            timeout_seconds=child_default.get("timeout_seconds", data.get("timeout_seconds", 300)),
            max_concurrent_permissions=child_default.get("max_concurrent_permissions", data.get("max_concurrent_permissions", 10)),
            inherit_from_parent=child_default.get("inherit_from_parent", data.get("inherit_from_parent", True)),
            anomaly_detection_enabled=anomaly.get("enabled", data.get("anomaly_detection_enabled", True)),
            write_rate_limit=anomaly.get("write_rate_limit", data.get("write_rate_limit", 100)),
            file_size_limit_mb=anomaly.get("file_size_limit_mb", data.get("file_size_limit_mb", 50)),
            audit_enabled=audit.get("enabled", data.get("audit_enabled", True)),
            audit_log_path=audit.get("log_path", data.get("audit_log_path", "data/audit.jsonl")),
            audit_retention_days=audit.get("retention_days", data.get("audit_retention_days", 90)),
            workspace=data.get("workspace", ""),
        )

    def default_level_as_int(self) -> int:
        """将 default_level 字符串转为等级数值"""
        mapping = {"strict": 1, "moderated": 3, "relaxed": 5}
        return mapping.get(self.default_level, 1)


# ── 权限请求 ──────────────────────────────────────────────

@dataclass
class PermissionRequest:
    """权限请求"""
    request_id: str = field(default_factory=lambda: f"perm_{uuid.uuid4().hex[:8]}")
    agent_id: str = ""
    agent_name: str = ""
    task_id: str = ""
    task_description: str = ""
    actions: list[dict] = field(default_factory=list)  # [{action, target, level}]
    timestamp: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    def to_dict(self) -> dict:
        return {
            "request_id": self.request_id,
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "task_id": self.task_id,
            "task_description": self.task_description,
            "actions": self.actions,
            "timestamp": self.timestamp,
        }


# ── 授权决策 ──────────────────────────────────────────────

@dataclass
class ApprovalDecision:
    """授权决策"""
    request_id: str = ""
    approved: bool = False
    approved_actions: list[str] = field(default_factory=list)
    denied_actions: list[str] = field(default_factory=list)
    reason: str = ""
    auto_approved: bool = False


# ── 权限检查结果 ──────────────────────────────────────────

@dataclass
class PermissionCheckResult:
    """权限检查结果"""
    allowed: bool
    reason: str = ""
    level: int = 0
    anomaly_detected: bool = False
    anomaly_alerts: list[str] = field(default_factory=list)


# ── SandboxManager ────────────────────────────────────────

class SandboxManager:
    """沙箱中央控制器"""

    def __init__(self, config: SandboxConfig | None = None,
                 approval_callback: Callable[[PermissionRequest], ApprovalDecision] | None = None):
        self.config = config or SandboxConfig()
        self._approval_callback = approval_callback
        self._active_grants: dict[str, dict] = {}  # grant_id -> grant info
        self._agent_grants: dict[str, list[str]] = {}  # agent_id -> [grant_id, ...]
        self._active_sandboxes: dict[str, "Sandbox"] = {}  # agent_id -> Sandbox
        self._audit_log: list[AuditEntry] = []
        self._anomaly_detector = AnomalyDetector()
        self._agent_configs: dict[str, SandboxConfig] = {}  # agent_id -> SandboxConfig
        self._agent_registry: dict[str, dict] = {}  # agent_id -> {parent_id, name, task_id}
        self._violations: dict[str, int] = {}  # agent_id -> 未读违规次数（供情绪 violation 信号消费）
        self._audit_log_path = self._resolve_audit_path()
        self._upgrade_expiry: dict[str, list] = {}  # B4: {agent_id: [(level, expires_at), ...]}

    def set_approval_callback(self, callback: Callable[[PermissionRequest], ApprovalDecision]):
        """设置用户确认回调函数"""
        self._approval_callback = callback

    def record_violation(self, agent_id: str):
        """记录一次权限拒绝事件（供情绪 violation 信号消费，见 Intelligence 11.2.4.6）。
        A-088（漏洞清单 P1-8）：拒绝路径同时写审计（此前仅计数、审计只发生在允许时，
        攻击尝试不可见）。"""
        self._violations[agent_id] = self._violations.get(agent_id, 0) + 1
        try:
            self._write_audit(AuditEntry(
                agent_id=agent_id,
                action="permission_denied",
                target="",
                status="denied",
                granted_by="auto",
                details={"violation_count": self._violations[agent_id]},
            ))
        except Exception:
            pass  # 审计失败不影响主流程

    def pop_violations(self, agent_id: str) -> bool:
        """读取并清除该 Agent 的未读违规标记，返回是否有违规。"""
        return self._violations.pop(agent_id, 0) > 0

    def register_agent(self, agent_id: str, parent_id: str = "", name: str = "", task_id: str = ""):
        """注册 Agent 信息到沙箱（用于权限继承和工作目录隔离）"""
        self._agent_registry[agent_id] = {
            "parent_id": parent_id,
            "name": name,
            "task_id": task_id,
        }

    def _resolve_audit_path(self) -> Path:
        """解析审计日志路径"""
        path = self.config.audit_log_path
        if not os.path.isabs(path):
            path = _project_root() / path
        return Path(path)

    # ── 权限管理 ────────────────────────────────────────

    def grant_permission(self, agent_id: str, action: str, target: str,
                         level: int = 0, granted_by: str = "auto",
                         task_id: str = "") -> tuple[bool, str]:
        """
        授予权限，返回 (是否允许, 原因)。
        决策流程：
        1. 工作目录隔离检查
        2. L0/L1 → 自动允许
        3. L5 → 强制拒绝
        4. 白名单工具 → 自动允许
        5. 黑名单工具 → 强制拒绝
        6. L2-L4 → 调用 approval_callback 确认（无回调则拒绝）
        """
        agent_config = self._get_agent_config(agent_id)

        # 工作目录隔离检查
        if agent_config.workspace and target:
            if not self._validate_workspace(agent_config.workspace, target):
                self._write_audit(AuditEntry(
                    agent_id=agent_id, task_id=task_id, action=action, target=target,
                    level=level, status="denied", granted_by=granted_by,
                    details={"reason": f"目标路径不在工作目录 {agent_config.workspace} 内"},
                ))
                return False, f"目标 '{target}' 超出工作目录范围"

        # 检查异常行为
        anomaly_detected, anomaly_alerts = False, []
        if agent_config.anomaly_detection_enabled:
            anomaly_detected, anomaly_alerts = self._anomaly_detector.check(
                agent_id, action, target
            )
        # 权限决策
        # 1. 黑名单优先
        if level in agent_config.deny_levels or _tool_matches(action, agent_config.deny_tools):
            self._write_audit(AuditEntry(
                agent_id=agent_id, task_id=task_id, action=action, target=target,
                level=level, status="denied", granted_by=granted_by,
                risk_score=1.0 if anomaly_detected else 0.0,
                anomaly_detected=anomaly_detected,
            ))
            return False, f"操作 '{action}' (L{level}) 被禁止"

        # B1: 异常检测 (deny 级 rule 强制执行)
        if anomaly_detected:
            for rule in self._anomaly_detector.rules:
                if rule.check(action, target) and rule.action in ("deny", "deny+alert", "terminate"):
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, task_id=task_id, action=action, target=target,
                        level=level, status="denied", granted_by=granted_by,
                        risk_score=1.0, anomaly_detected=True,
                        details={"rule": rule.name, "action": rule.action},
                    ))
                    return False, f"异常操作被拒绝: {rule.description}"

        # 2. 需确认的工具优先于等级自动批准
        if _tool_matches(action, agent_config.require_approval_tools):
            if self._approval_callback:
                agent_info = self._agent_registry.get(agent_id, {})
                req = PermissionRequest(
                    agent_id=agent_id,
                    agent_name=agent_info.get("name", agent_id),
                    task_id=task_id or agent_info.get("task_id", ""),
                    actions=[{"action": action, "target": target, "level": level}],
                )
                decision = self._approval_callback(req)
                if decision.approved:
                    grant_id = self._record_grant(agent_id, action, target, level, "user")
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, task_id=task_id, action=action, target=target,
                        level=level, status="allowed", granted_by="user",
                        grant_id=grant_id, risk_score=0.0,
                        anomaly_detected=anomaly_detected,
                    ))
                    return True, "用户批准"
                else:
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, task_id=task_id, action=action, target=target,
                        level=level, status="denied", granted_by="user",
                        risk_score=0.0, anomaly_detected=anomaly_detected,
                    ))
                    return False, f"用户拒绝: {decision.reason}"
            else:
                return False, f"工具 '{action}' 需要用户确认（未配置确认回调）"

        # 3. 自动批准
        if level in agent_config.auto_approve_levels or _tool_matches(action, agent_config.auto_approve_tools):
            grant_id = self._record_grant(agent_id, action, target, level, granted_by)
            self._write_audit(AuditEntry(
                agent_id=agent_id, task_id=task_id, action=action, target=target,
                level=level, status="allowed", granted_by=granted_by,
                grant_id=grant_id, risk_score=0.0,
                anomaly_detected=anomaly_detected,
            ))
            return True, "自动批准"

        # 4. L2-L4 需要确认
        if level in agent_config.require_approval_levels:
            # 如果有确认回调，调用它
            if self._approval_callback:
                agent_info = self._agent_registry.get(agent_id, {})
                req = PermissionRequest(
                    agent_id=agent_id,
                    agent_name=agent_info.get("name", agent_id),
                    task_id=task_id or agent_info.get("task_id", ""),
                    actions=[{"action": action, "target": target, "level": level}],
                )
                decision = self._approval_callback(req)
                if decision.approved:
                    grant_id = self._record_grant(agent_id, action, target, level, "user")
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, task_id=task_id, action=action, target=target,
                        level=level, status="allowed", granted_by="user",
                        grant_id=grant_id, risk_score=0.0,
                        anomaly_detected=anomaly_detected,
                    ))
                    return True, "用户批准"
                else:
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, task_id=task_id, action=action, target=target,
                        level=level, status="denied", granted_by="user",
                        risk_score=0.0, anomaly_detected=anomaly_detected,
                    ))
                    return False, f"用户拒绝: {decision.reason}"
            else:
                # 无回调，默认拒绝
                return False, f"操作 '{action}' (L{level}) 需要用户确认（未配置确认回调）"

        # 默认：拒绝未知 level（fail-closed）
        return False, f"未知权限等级 L{level}，已拒绝"

    def revoke_permission(self, agent_id: str, action: str):
        """撤销单个权限"""
        grants = self._agent_grants.get(agent_id, [])
        for gid in grants:
            grant = self._active_grants.get(gid)
            if grant and grant["action"] == action:
                self._write_audit(AuditEntry(
                    agent_id=agent_id, action=action, target=grant.get("target", ""),
                    level=grant.get("level", 0), status="revoked",
                    granted_by="main_agent", grant_id=gid,
                ))
                del self._active_grants[gid]
        self._agent_grants[agent_id] = [g for g in grants if g in self._active_grants]

    def revoke_all(self, agent_id: str, reason: str = ""):
        """紧急回收某 Agent 所有权限（含升级配置）"""
        grants = self._agent_grants.get(agent_id, [])
        for gid in grants:
            grant = self._active_grants.get(gid)
            if grant:
                self._write_audit(AuditEntry(
                    agent_id=agent_id, action=grant.get("action", ""),
                    target=grant.get("target", ""), level=grant.get("level", 0),
                    status="revoked", granted_by="main_agent",
                    grant_id=gid,
                    details={"reason": reason} if reason else {},
                ))
                del self._active_grants[gid]  # B8: 同步清理活跃 grant
        self._agent_grants.pop(agent_id, None)
        self._agent_configs.pop(agent_id, None)  # B4: 回收临时提升的配置
        self._upgrade_expiry.pop(agent_id, None)
        self._anomaly_detector.reset(agent_id)

    def _record_grant(self, agent_id: str, action: str, target: str,
                      level: int, granted_by: str) -> str:
        """记录授权，返回 grant_id"""
        grant_id = f"grant_{uuid.uuid4().hex[:8]}"
        self._active_grants[grant_id] = {
            "agent_id": agent_id,
            "action": action,
            "target": target,
            "level": level,
            "granted_by": granted_by,
            "granted_at": time.time(),
        }
        self._agent_grants.setdefault(agent_id, []).append(grant_id)
        return grant_id

    # ── 权限查询 ────────────────────────────────────────

    def check_permission(self, agent_id: str, action: str, target: str,
                         level: int = 0) -> PermissionCheckResult:
        """
        检查权限，返回 PermissionCheckResult。
        不记录审计日志，仅用于预检查。
        """
        agent_config = self._get_agent_config(agent_id)

        # 工作目录隔离检查
        if agent_config.workspace and target:
            if not self._validate_workspace(agent_config.workspace, target):
                return PermissionCheckResult(
                    allowed=False, reason=f"目标 '{target}' 超出工作目录范围",
                    level=level,
                )

        # 异常检测
        anomaly_detected, anomaly_alerts = False, []
        if agent_config.anomaly_detection_enabled:
            anomaly_detected, anomaly_alerts = self._anomaly_detector.check(
                agent_id, action, target
            )

        # 1. 黑名单优先
        if level in agent_config.deny_levels or _tool_matches(action, agent_config.deny_tools):
            return PermissionCheckResult(
                allowed=False, reason=f"操作 '{action}' (L{level}) 被禁止",
                level=level, anomaly_detected=anomaly_detected,
                anomaly_alerts=anomaly_alerts,
            )

        # B1: 异常检测拒绝
        if anomaly_detected:
            for rule in self._anomaly_detector.rules:
                if rule.check(action, target) and rule.action in ("deny", "deny+alert", "terminate"):
                    return PermissionCheckResult(
                        allowed=False, reason=f"异常操作被拒绝: {rule.description}",
                        level=level, anomaly_detected=True,
                        anomaly_alerts=anomaly_alerts + [rule.description],
                    )

        # 2. 需确认的工具优先于等级自动批准
        if _tool_matches(action, agent_config.require_approval_tools):
            return PermissionCheckResult(
                allowed=False, reason=f"工具 '{action}' 需要用户确认",
                level=level, anomaly_detected=anomaly_detected,
                anomaly_alerts=anomaly_alerts,
            )

        # 3. 自动批准
        if level in agent_config.auto_approve_levels or _tool_matches(action, agent_config.auto_approve_tools):
            # A-088（漏洞清单 P1-9）：mcp_* 通配只自动批准低权限（read/write）；
            # network/terminal 级 MCP 工具（缺省 network=L4）仍需确认/拒绝——防权限声明失效
            if (_tool_matches(action, agent_config.auto_approve_tools)
                    and action.startswith("mcp_") and level >= 3):
                pass  # 落入后续等级判定（不自动批准高权限 MCP）
            else:
                return PermissionCheckResult(
                    allowed=True, reason="自动批准", level=level,
                    anomaly_detected=anomaly_detected,
                    anomaly_alerts=anomaly_alerts,
                )

        # 4. 需确认的等级
        if level in agent_config.require_approval_levels:
            return PermissionCheckResult(
                allowed=False, reason=f"操作 '{action}' (L{level}) 需要用户确认",
                level=level, anomaly_detected=anomaly_detected,
                anomaly_alerts=anomaly_alerts,
            )

        # 默认：拒绝未知 level
        return PermissionCheckResult(
            allowed=False, reason=f"未知权限等级 L{level}，已拒绝", level=level,
            anomaly_detected=anomaly_detected,
            anomaly_alerts=anomaly_alerts,
        )

    def get_permission_status(self, agent_id: str) -> dict:
        """获取 Agent 当前权限状态"""
        grants = self._agent_grants.get(agent_id, [])
        return {
            "agent_id": agent_id,
            "active_grants": len(grants),
            "grants": [self._active_grants[g] for g in grants if g in self._active_grants],
            "config": self._get_agent_config(agent_id).to_dict(),
        }

    # ── Agent 配置管理 ──────────────────────────────────

    def set_agent_config(self, agent_id: str, config: SandboxConfig):
        """设置 Agent 级沙箱配置"""
        self._agent_configs[agent_id] = config

    def _get_agent_config(self, agent_id: str) -> SandboxConfig:
        """
        获取 Agent 级沙箱配置。
        优先级：Agent 自身覆盖 > 父 Agent 继承 > 全局默认。
        B4: 合并临时权限提升，自动清除过期的。
        """
        # 1. Agent 自身有覆盖配置
        if agent_id in self._agent_configs:
            cfg = self._agent_configs[agent_id]
        else:
            agent_info = self._agent_registry.get(agent_id, {})
            parent_id = agent_info.get("parent_id", "")
            if parent_id:
                parent_config = self._get_agent_config(parent_id)
                if parent_config.inherit_from_parent:
                    cfg = SandboxConfig.from_dict(parent_config.to_dict())
                    cfg.workspace = ""  # 子 Agent 不继承工作目录
                else:
                    cfg = self.config
            else:
                cfg = self.config

        # B4: 合并临时权限提升，清理过期项
        upgrades = self._upgrade_expiry.get(agent_id, [])
        if upgrades:
            now = time.time()
            active = [u for u in upgrades if u[1] > now]
            if active != upgrades:
                self._upgrade_expiry[agent_id] = active
            if active:
                cfg = SandboxConfig.from_dict(cfg.to_dict())
                for level, _ in active:
                    if level not in cfg.auto_approve_levels:
                        cfg.auto_approve_levels = cfg.auto_approve_levels + [level]
        return cfg

    def remove_agent_config(self, agent_id: str):
        """移除 Agent 级沙箱配置"""
        self._agent_configs.pop(agent_id, None)

    def _validate_workspace(self, workspace: str, target: str) -> bool:
        """
        验证目标路径是否在工作目录范围内。
        workspace 为 Agent 的工作目录，target 为操作目标路径。
        支持两种形式：
        1. target 是直接路径字符串
        2. target 是 JSON 字符串（从中提取 path 字段）
        注意：JSON 参数中无路径字段时拒绝（不能确定目标，宁严勿放）。
        """
        try:
            ws = Path(workspace).resolve()
            # 尝试解析 target 为 JSON（工具参数通常是 JSON 字符串）
            import json
            try:
                target_obj = json.loads(target)
                if isinstance(target_obj, dict):
                    # 网络目标（url）归 SSRF 防护管，不归工作目录隔离管（search_engine.md 七.5）
                    if target_obj.get("url"):
                        return True
                    # 从 JSON 中提取路径字段
                    target_path = target_obj.get("path") or target_obj.get("file") or target_obj.get("target")
                    if not target_path:
                        return False  # 无路径字段，拒绝（隔离范围内必须明确目标）
                    tp = Path(target_path).resolve()
                else:
                    tp = Path(target).resolve()
            except (json.JSONDecodeError, TypeError):
                # 不是 JSON，直接当作路径处理
                tp = Path(target).resolve()

            # 检查 target 是否在 workspace 内（或就是 workspace 本身）
            tp.relative_to(ws)
            return True
        except (ValueError, OSError):
            return False

    def request_permission_upgrade(self, agent_id: str, target_level: int,
                                   reason: str = "") -> tuple[bool, str]:
        """
        子 Agent 申请权限提升。
        子 Agent 不能自主提升权限，必须通过此方法向主 Agent/用户申请。
        """
        agent_info = self._agent_registry.get(agent_id, {})
        parent_id = agent_info.get("parent_id", "")

        # 无父 Agent 的主 Agent 无需提升
        if not parent_id:
            return True, "主 Agent 无需权限提升"

        # 检查目标等级是否被禁止
        agent_config = self._get_agent_config(agent_id)
        if target_level in agent_config.deny_levels:
            self._write_audit(AuditEntry(
                agent_id=agent_id, action="permission_upgrade",
                target=f"L{target_level}", level=target_level,
                status="denied", granted_by="main_agent",
                details={"reason": f"L{target_level} 被禁止"},
            ))
            return False, f"L{target_level} 操作被禁止"

        # 需要用户确认
        if target_level in agent_config.require_approval_levels:
            if self._approval_callback:
                req = PermissionRequest(
                    agent_id=agent_id,
                    agent_name=agent_info.get("name", agent_id),
                    actions=[{"action": "permission_upgrade", "target": f"L{target_level}", "level": target_level}],
                    task_description=reason,
                )
                decision = self._approval_callback(req)
                if decision.approved:
                    # B4: 记录临时提升（5 分钟有效），不在 config 上永久修改
                    self._upgrade_expiry.setdefault(agent_id, []).append(
                        (target_level, time.time() + 300))
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, action="permission_upgrade",
                        target=f"L{target_level}", level=target_level,
                        status="allowed", granted_by="user",
                    ))
                    return True, "权限提升已批准"
                else:
                    self._write_audit(AuditEntry(
                        agent_id=agent_id, action="permission_upgrade",
                        target=f"L{target_level}", level=target_level,
                        status="denied", granted_by="user",
                    ))
                    return False, f"权限提升被拒绝: {decision.reason}"
            else:
                return False, "权限提升需要用户确认（未配置确认回调）"

        # 未列等级拒绝（fail-closed）
        return False, f"L{target_level} 未在审批规则中列出，默认拒绝"

    # ── 审计日志 ────────────────────────────────────────

    def _write_audit(self, entry: AuditEntry):
        """记录审计日志（内存 + 文件），定期按 retention_days 轮转"""
        if not self.config.audit_enabled:
            return
        self._audit_log.append(entry)

        # 写入文件
        try:
            self._audit_log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._audit_log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        except Exception as e:
            logging.warning(f"[SLIME Sandbox] 审计日志写入失败: {e}")

        # 定期轮转：每 200 条清理超过 retention_days 的旧记录
        if len(self._audit_log) % 200 == 0:
            self._rotate_audit_log()

    def _rotate_audit_log(self):
        """清理超过 retention_days 的旧审计记录（内存 + 文件）"""
        retention = getattr(self.config, 'audit_retention_days', 90)
        cutoff = (datetime.now(timezone.utc) - timedelta(days=retention)).isoformat()
        old_count = len(self._audit_log)
        self._audit_log = [
            e for e in self._audit_log
            if getattr(e, 'timestamp', '') >= cutoff
        ]
        removed = old_count - len(self._audit_log)
        if removed > 0:
            logging.info(f"[SLIME Sandbox] 审计日志轮转: 移除 {removed} 条 >{retention} 天旧记录")
            # 重写文件
            try:
                lines = [
                    json.dumps(e.to_dict(), ensure_ascii=False) + "\n"
                    for e in self._audit_log
                ]
                self._audit_log_path.write_text("".join(lines), encoding="utf-8")
            except Exception as e:
                logging.warning(f"[SLIME Sandbox] 审计日志轮转写入失败: {e}")

    def query_audit(self, agent_id: str | None = None,
                    limit: int = 100) -> list[dict]:
        """查询审计日志"""
        entries = self._audit_log
        if agent_id:
            entries = [e for e in entries if e.agent_id == agent_id]
        return [e.to_dict() for e in entries[-limit:]]

    def get_audit_summary(self) -> dict:
        """获取审计摘要"""
        entries = self._audit_log
        allowed = sum(1 for e in entries if e.status == "allowed")
        denied = sum(1 for e in entries if e.status == "denied")
        revoked = sum(1 for e in entries if e.status == "revoked")
        anomalies = sum(1 for e in entries if e.anomaly_detected)
        recent_denials = [
            e.to_dict() for e in entries[-10:] if e.status == "denied"
        ]
        return {
            "total_operations": len(entries),
            "allowed": allowed,
            "denied": denied,
            "revoked": revoked,
            "anomalies": anomalies,
            "recent_denials": recent_denials,
        }

    # ── 配置更新 ────────────────────────────────────────

    def update_config(self, config: dict | SandboxConfig):
        """更新全局沙箱配置"""
        if isinstance(config, dict):
            self.config = SandboxConfig.from_dict(config)
        else:
            self.config = config

    # ── 风险评分 ────────────────────────────────────────

    def calculate_risk_score(self, action: str, context: dict | None = None) -> float:
        """计算操作风险评分 (0.0 - 1.0)"""
        RISK_BASE = {
            "file_read": 0.0,
            "file_write": 0.3,
            "rm": 0.7,
            "pip": 0.5,
            "git_push": 0.4,
            "sudo": 0.9,
            "chmod": 0.8,
            "curl": 0.6,
        }
        base_score = RISK_BASE.get(action, 0.2)

        # 时间因素
        if not _is_work_hours():
            base_score += 0.2

        # 目标因素：系统路径
        if context and _is_system_path(context.get("target", "")):
            base_score += 0.4

        return min(base_score, 1.0)


# ── 辅助函数 ──────────────────────────────────────────────

def _is_work_hours() -> bool:
    """检查是否在工作时间（9:00-18:00）"""
    hour = time.localtime().tm_hour
    return 9 <= hour < 18


def _is_system_path(path: str) -> bool:
    """检查是否为系统路径"""
    system_prefixes = [
        "/etc", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
        "/boot", "/dev", "/proc", "/sys",
        "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
        "/System", "/Library",
    ]
    path_lower = path.lower()
    return any(path_lower.startswith(p.lower()) for p in system_prefixes)


# ── 全局单例 ──────────────────────────────────────────────

_global_manager: SandboxManager | None = None


def get_sandbox_manager() -> SandboxManager:
    """获取全局 SandboxManager 单例"""
    global _global_manager
    if _global_manager is None:
        _global_manager = SandboxManager()
    return _global_manager


def reset_sandbox_manager(config: SandboxConfig | None = None,
                          approval_callback: Callable[[PermissionRequest], ApprovalDecision] | None = None):
    """重置全局 SandboxManager"""
    global _global_manager
    _global_manager = SandboxManager(config=config, approval_callback=approval_callback)


# ── Agent 配置加载 ────────────────────────────────────────

# A-002: Agent 级覆盖中与全局取并集的列表字段（白名单语义，覆盖不应丢失全局放行项）
_MERGE_UNION_KEYS = ("auto_approve_tools", "deny_tools", "require_approval_tools")


def _merge_agent_override(base: SandboxConfig, override: dict) -> SandboxConfig:
    """把 Agent 级 sandbox_override 合并到全局默认配置上。

    修复前：override 整体替换全局配置 —— 部分覆盖（如只写 auto_approve_tools）
    会丢掉全局的 auto_approve_levels 等默认值，改 slime.toml 全局配置对已有
    Agent 完全无效（配置陷阱）。
    现在：只应用 override 中显式出现的键；列表字段与全局取并集。"""
    if not isinstance(override, dict):
        return base
    data = base.to_dict()
    for key in _MERGE_UNION_KEYS:
        if key in override:
            data[key] = sorted(set(data.get(key, [])) | set(override[key]))
    for key, value in override.items():
        if key in _MERGE_UNION_KEYS:
            continue
        data[key] = value
    return SandboxConfig.from_dict(data)


def load_agent_sandbox_configs(agents: list) -> int:
    """
    从 Agent 列表加载沙箱配置到全局 SandboxManager。
    在 CLI/Server 启动时调用。
    返回加载的配置数量。
    """
    mgr = get_sandbox_manager()
    count = 0
    for agent in agents:
        # 注册 Agent 信息（用于权限继承）
        mgr.register_agent(
            agent_id=agent.id,
            parent_id=agent.parent_id or "",
            name=agent.name,
        )
        # 如果有 sandbox_override，合并为 Agent 级配置（A-002：与全局默认合并）
        if hasattr(agent, "sandbox_override") and agent.sandbox_override:
            cfg = _merge_agent_override(mgr.config, agent.sandbox_override)
            mgr.set_agent_config(agent.id, cfg)
            count += 1
    return count


# ── CLI 确认回调 ──────────────────────────────────────────

def cli_approval_callback(request: PermissionRequest) -> ApprovalDecision:
    """
    CLI 环境下的用户确认回调。
    同步模式（wizard/直接命令）：通过 input() 阻塞等待用户输入。
    异步模式（Swarm 协程）：自动拒绝，避免 input() 阻塞事件循环。
    """
    # B5: 检测异步上下文，避免 input() 冻结事件循环
    import asyncio as _aio
    try:
        _aio.get_running_loop()
        first_action = request.actions[0].get('action', '') if request.actions else ''
        print(f"\n  [沙箱] 工具 '{first_action}' 需要授权"
              f"，当前异步模式自动拒绝")
        return ApprovalDecision(
            request_id=request.request_id,
            approved=False,
            reason="异步模式不交互，请使用同步模式或预先配置白名单",
        )
    except RuntimeError:
        pass  # 无事件循环，同步交互模式

    print("\n" + "=" * 60)
    print(f"  [沙箱授权请求] {request.agent_name}")
    if request.task_description:
        print(f"  任务: {request.task_description}")
    print("-" * 60)
    for i, act in enumerate(request.actions):
        level = act.get("level", 0)
        action = act.get("action", "")
        target = act.get("target", "")
        print(f"  {'✗' if level >= 2 else '✓'} {action} (L{level}): {target}")
    print("-" * 60)
    print("  [1] 批准  [2] 拒绝  [3] 逐个确认")

    try:
        choice = input("\n  请选择 (1/2/3): ").strip()
    except (EOFError, KeyboardInterrupt):
        return ApprovalDecision(
            request_id=request.request_id,
            approved=False,
            reason="用户取消",
        )

    if choice == "1":
        return ApprovalDecision(
            request_id=request.request_id,
            approved=True,
            approved_actions=[a["action"] for a in request.actions],
            reason="用户批准全部",
        )
    elif choice == "3":
        approved_actions = []
        denied_actions = []
        for act in request.actions:
            action = act.get("action", "")
            target = act.get("target", "")
            level = act.get("level", 0)
            try:
                ans = input(f"  批准 {action} (L{level}): {target}? (y/n): ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                ans = "n"
            if ans == "y":
                approved_actions.append(action)
            else:
                denied_actions.append(action)
        return ApprovalDecision(
            request_id=request.request_id,
            approved=len(approved_actions) > 0,
            approved_actions=approved_actions,
            denied_actions=denied_actions,
            reason="逐个确认",
        )
    else:
        return ApprovalDecision(
            request_id=request.request_id,
            approved=False,
            reason="用户拒绝",
        )


# ==============================================================
# 向后兼容层：保留旧的 SkillManifest 和 Sandbox 类
# ==============================================================

@dataclass
class SkillManifest:
    """技能权限声明（向后兼容）"""
    read: bool = True
    write: bool = False
    terminal: bool = False
    network: bool = False
    llm_output: bool = True
    description: str = ""


class Sandbox:
    """
    技能沙箱执行器（向后兼容）。
    默认策略：只读沙箱（read + llm_output），其他操作需 manifest 声明 + 用户确认。
    """

    def __init__(self, manifest: SkillManifest | None = None,
                 agent_id: str = "", sandbox_manager: SandboxManager | None = None):
        self.manifest = manifest or SkillManifest()
        self._denied: list[str] = []
        self.agent_id = agent_id
        self._manager = sandbox_manager or get_sandbox_manager()

    @property
    def allows_write(self) -> bool:
        return self.manifest.write

    @property
    def allows_terminal(self) -> bool:
        return self.manifest.terminal

    @property
    def allows_network(self) -> bool:
        return self.manifest.network

    def require_write(self, reason: str = "") -> bool:
        """请求写入权限，返回是否允许"""
        if self.manifest.write:
            return True
        # 通过 SandboxManager 检查
        if self.agent_id:
            result = self._manager.check_permission(
                self.agent_id, "file_write", reason, level=2
            )
            if result.allowed:
                return True
        self._denied.append(f"write" + (f" ({reason})" if reason else ""))
        return False

    def require_terminal(self, reason: str = "") -> bool:
        """请求终端权限，返回是否允许"""
        if self.manifest.terminal:
            return True
        if self.agent_id:
            result = self._manager.check_permission(
                self.agent_id, "terminal", reason, level=3
            )
            if result.allowed:
                return True
        self._denied.append(f"terminal" + (f" ({reason})" if reason else ""))
        return False

    def require_network(self, reason: str = "") -> bool:
        """请求网络权限，返回是否允许"""
        if self.manifest.network:
            return True
        if self.agent_id:
            result = self._manager.check_permission(
                self.agent_id, "network", reason, level=4
            )
            if result.allowed:
                return True
        self._denied.append(f"network" + (f" ({reason})" if reason else ""))
        return False

    def get_denied_summary(self) -> list[str]:
        return list(self._denied)

    def clear_denied(self):
        self._denied.clear()


def create_default_sandbox(agent_id: str = "") -> Sandbox:
    """创建默认只读沙箱"""
    return Sandbox(SkillManifest(
        read=True, write=False, terminal=False, network=False, llm_output=True,
    ), agent_id=agent_id)


def create_from_manifest(manifest_dict: dict, agent_id: str = "") -> Sandbox:
    """从 dict 创建沙箱"""
    return Sandbox(SkillManifest(
        read=manifest_dict.get("read", True),
        write=manifest_dict.get("write", False),
        terminal=manifest_dict.get("terminal", False),
        network=manifest_dict.get("network", False),
        llm_output=manifest_dict.get("llm_output", True),
        description=manifest_dict.get("description", ""),
    ), agent_id=agent_id)