# Slime 沙箱架构设计方案

**版本：** v1.0  
**日期：** 2026-08-10  
**状态：** 待实现

---

## 1. 设计目标

1. **安全优先**：所有模型操作默认在沙箱内执行
2. **权限隔离**：主 Agent 与子 Agent 沙箱独立
3. **动态授权**：实时确认 + 默认批准策略
4. **行为审计**：完整记录所有操作，检测异常行为
5. **可追溯**：权限生命周期管理，任务结束自动回收

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    SandboxManager (中央控制器)                │
├─────────────────────────────────────────────────────────────┤
│  全局策略 ──┐                                                │
│  Agent配置  ├─► 权限决策引擎                                  │
│  任务上下文 ─┘                                                │
└─────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │   主 Agent  │ │  子 Agent 1 │ │  子 Agent 2 │
    │  Sandbox_A  │ │  Sandbox_B  │ │  Sandbox_C  │
    │  (strict)   │ │  (scoped)   │ │  (scoped)   │
    └─────────────┘ └─────────────┘ └─────────────┘
            │               │               │
            ▼               ▼               ▼
    ┌─────────────────────────────────────────────────┐
    │              隔离执行层                           │
    │  ├── 文件系统命名空间 (symlink/chroot)          │
    │  ├── 命令白名单 (command whitelist)              │
    │  ├── 网络拦截 (DNS/HTTP proxy)                   │
    │  └── 环境变量隔离 (env filter)                   │
    └─────────────────────────────────────────────────┘
```

---

## 3. 配置体系

### 3.1 全局配置 (slime.toml)

```toml
[sandbox]
# 全局默认策略
default_level = "strict"        # strict | moderated | relaxed

# 默认批准策略
auto_approve_levels = [0, 1]    # L0/L1 自动批准
require_approval_levels = [2, 3, 4]  # L2-L4 需确认
deny_levels = [5]               # L5 强制拒绝

# 子 Agent 默认配置
child_default = {
    inherit_from_parent = true,
    timeout_seconds = 300,
    max_concurrent_permissions = 10,
}

# 异常行为检测
anomaly_detection = {
    enabled = true,
    write_rate_limit = 100,      # 次/分钟
    file_size_limit_mb = 50,
    suspicious_patterns = [
        "rm -rf /",
        "chmod 777",
        "curl | bash",
    ]
}

# 审计日志
audit = {
    enabled = true,
    log_path = "data/audit.jsonl",
    retention_days = 90,
}
```

### 3.2 Agent 级覆盖

```toml
# config/agents.json
{
  "agents": [
    {
      "id": "agent_main",
      "name": "主 Agent",
      "sandbox_override": {
        "default_level": "moderated",
        "auto_approve_tools": ["file_read", "git_status"],
        "deny_tools": ["sudo", "rm"]
      }
    },
    {
      "id": "agent_child_001",
      "name": "代码审查子 Agent",
      "sandbox_override": {
        "inherit_from_parent": true,
        "timeout_seconds": 600,
        "auto_approve_tools": ["file_read"],
        "require_approval_tools": ["file_write", "pytest"]
      }
    }
  ]
}
```

---

## 4. 权限分级模型

| 级别 | 操作类型 | 示例 | 默认策略 | 确认方式 |
|------|---------|------|---------|---------|
| **L0** | 纯读取 | `cat`, `ls`, `file_read` | ✓ 自动允许 | 无 |
| **L1** | 查看信息 | `git log`, `pytest --collect-only` | ✓ 自动允许 | 无 |
| **L2** | 修改文件 | `vim`, `file_write`, `git add` | ✗ 需确认 | 单条确认 |
| **L3** | 执行命令 | `pytest`, `python -m test` | ✗ 需确认 | 批量确认 |
| **L4** | 网络访问 | `pip install`, `git push` | ✗ 需确认 | 单条确认 |
| **L5** | 系统操作 | `sudo`, `kill`, `rm -rf` | ✗ 禁止 | 强制拒绝 |

### 4.1 工具权限声明

```python
# tools/builtin.py
registry.register(Tool(
    name="file_read",
    description="读取文件内容",
    permissions=["read"],           # L0
    command_whitelist=["cat", "head", "tail"],
))

registry.register(Tool(
    name="file_write",
    description="写入文件内容",
    permissions=["write"],          # L2
    command_whitelist=["echo", "tee"],
))

registry.register(Tool(
    name="run_command",
    description="执行命令",
    permissions=["terminal"],       # L3
    command_whitelist=["pytest", "python", "git"],
))
```

---

## 5. 授权确认机制

### 5.1 实时弹窗流程

```
时间线：

0s    ┌─────────────────────────────────────────────────────────┐
      │  子 Agent 发起操作请求                                  │
      │  → 沙箱拦截，生成授权请求                               │
      └─────────────────────────────────────────────────────────┘
      │
1s    │  用户收到弹窗                                          │
      │  ┌─────────────────────────────────────┐               │
      │  │  [沙箱授权请求]                      │               │
      │  │  子 Agent: agent_child_001           │               │
      │  │  任务: 修复 main.py 的 bug           │               │
      │  │                                      │               │
      │  │  请求操作:                           │               │
      │  │  ✗ file_write: src/main.py         │               │
      │  │  ✓ file_read: src/test_utils.py    │               │
      │  │  ✗ cmd_run: pytest -k test_bug     │               │
      │  │                                      │               │
      │  │  [批准全部]  [拒绝全部]  [逐个确认]   │               │
      │  └─────────────────────────────────────┘               │
      └─────────────────────────────────────────────────────────┘
      │
2s    │  用户选择 "批准全部"                                    │
      │  → 记录授权：{task_id, action, granted_at, granted_by}  │
      │  → 子 Agent 获得临时权限                                │
      └─────────────────────────────────────────────────────────┘
```

### 5.2 默认批准策略

用户可配置默认行为：

```
用户: "L0/L1 操作自动批准"
系统: "已设置：L0-L1 操作自动允许"

用户: "file_write 默认需确认"
系统: "已设置：file_write 操作需用户确认"

用户: "只显示 L3 及以上操作的授权请求"
系统: "已设置：仅 L3+ 操作触发授权请求"
```

**配置方式：**
```toml
[sandbox.user_preferences]
auto_approve = ["L0", "L1"]
always_ask = ["L2:file_write", "L3:pytest"]
hide_levels = ["L0", "L1"]  # 不显示这些级别的请求
```

---

## 6. 子 Agent 权限管理

### 6.1 权限继承规则

```
主 Agent Sandbox (strict)
    │
    ├─► 继承配置 (inherit_from_parent = true)
    │     ├── default_level = "strict"
    │     ├── auto_approve = ["L0", "L1"]
    │     └── deny_list = ["sudo", "rm"]
    │
    └─► 任务级覆盖 (scoped)
          ├── timeout = 300s
          ├── max_permissions = 10
          └── workspace = /tmp/slime_task_001
```

### 6.2 权限提升流程

子 Agent **不能自主提升权限**，必须通过主 Agent 显式授权：

```python
# 子 Agent 申请权限提升
async def request_permission_upgrade(agent_id: str, target_level: int):
    # 1. 主 Agent 收到请求
    # 2. 主 Agent 评估风险
    # 3. 主 Agent 决定是否授权
    # 4. 记录审计日志
    
    if main_agent.approve_upgrade(agent_id, target_level):
        sandbox.grant_permission(agent_id, target_level)
        audit_log("permission_upgrade", agent_id, target_level, "approved")
    else:
        audit_log("permission_upgrade", agent_id, target_level, "denied")
```

**授权方式：**
- 主 Agent 自动决策（基于预设策略）
- 主 Agent 请求用户确认
- 主 Agent 直接拒绝

### 6.3 权限回收

```python
# 任务结束自动回收
async def revoke_task_permissions(task_id: str):
    for agent_id in agents_in_task(task_id):
        sandbox.revoke_all(agent_id)
        audit_log("permission_revoke", agent_id, task_id, "task_end")

# 主 Agent 紧急召回
async def emergency_revoke(agent_id: str, reason: str):
    sandbox.revoke_all(agent_id)
    audit_log("emergency_revoke", agent_id, reason, "main_agent")
```

---

## 7. 异常行为检测

### 7.1 检测规则

```python
ANOMALY_RULES = {
    # 写入速率限制
    "write_rate_limit": {
        "threshold": 100,      # 次/分钟
        "action": "alert",
        "description": "写入操作过于频繁"
    },
    
    # 文件大小限制
    "file_size_limit": {
        "threshold_mb": 50,
        "action": "deny",
        "description": "单文件过大"
    },
    
    # 危险操作模式
    "suspicious_patterns": {
        "patterns": [
            r"rm\s+-rf\s+/",
            r"chmod\s+777",
            r"curl\s+.*\|\s*bash",
            r"wget\s+.*\|\s*sh",
            r">\s*/dev/sda",
        ],
        "action": "deny+alert",
        "description": "检测到危险操作模式"
    },
    
    # 循环检测
    "loop_detection": {
        "max_iterations": 1000,
        "action": "terminate",
        "description": "检测到循环操作"
    },
    
    # 资源耗尽检测
    "resource_exhaustion": {
        "disk_usage_threshold": 90,  # 百分比
        "memory_threshold_mb": 2048,
        "action": "alert",
        "description": "检测到资源耗尽风险"
    }
}
```

### 7.2 检测流程

```
操作请求 → 规则匹配 → 风险评分 → 决策
                │           │        │
                ▼           ▼        ▼
           触发告警    计算分数   允许/拒绝/确认
```

**风险评分模型：**
```python
def calculate_risk_score(action: str, context: dict) -> float:
    base_score = RISK_BASE.get(action, 0)
    
    # 时间因素：非工作时间加分
    if is_off_hours():
        base_score += 0.2
    
    # 频率因素：近期操作频繁加分
    recent_ops = get_recent_operations(action)
    if len(recent_ops) > 50:
        base_score += 0.3
    
    # 目标因素：系统文件加分
    if is_system_path(context.get("target", "")):
        base_score += 0.4
    
    return min(base_score, 1.0)
```

---

## 8. 审计日志

### 8.1 日志结构

```json
{
  "entry_id": "audit_20260810_001",
  "timestamp": "2026-08-10T15:30:00Z",
  "agent_id": "agent_child_001",
  "task_id": "task_001",
  "action": "file_write",
  "target": "/project/src/main.py",
  "level": 2,
  "status": "allowed",
  "granted_by": "user",
  "grant_id": "grant_abc123",
  "details": {
    "content_hash": "sha256:abc123...",
    "lines_changed": 45,
    "file_size_before": 1024,
    "file_size_after": 1200
  },
  "risk_score": 0.3,
  "anomaly_detected": false
}
```

### 8.2 审计查询

```python
# 查询某 Agent 的所有操作
def query_audit(agent_id: str, limit: int = 100):
    return [e for e in audit_log if e.agent_id == agent_id][-limit:]

# 获取审计摘要
def get_audit_summary() -> dict:
    return {
        "total_operations": len(audit_log),
        "allowed": sum(1 for e in audit_log if e.status == "allowed"),
        "denied": sum(1 for e in audit_log if e.status == "denied"),
        "revoked": sum(1 for e in audit_log if e.status == "revoked"),
        "anomalies": sum(1 for e in audit_log if e.anomaly_detected),
        "recent_denials": [
            e for e in audit_log[-10:] if e.status == "denied"
        ]
    }
```

---

## 9. 实现计划

### 9.1 文件修改清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `core/sandbox.py` | 重构 | 扩展为完整沙箱系统 |
| `core/agent.py` | 修改 | 添加 sandbox 字段 |
| `core/llm.py` | 修改 | 完善权限检查逻辑 |
| `tools/builtin.py` | 修改 | 添加权限声明 |
| `slime.toml` | 修改 | 添加沙箱配置 |
| `config/sandbox.json` | 新增 | Agent 级沙箱配置 |
| `data/audit.jsonl` | 新增 | 审计日志文件 |

### 9.2 优先级

| 阶段 | 功能 | 预估工作量 |
|------|------|-----------|
| **P0** | 基础沙箱 + L0/L1 自动允许 | 2h |
| **P1** | L2-L4 确认机制 + 实时弹窗 | 4h |
| **P2** | 子 Agent 隔离 + 权限继承 | 6h |
| **P3** | 审计日志 + 异常检测 | 4h |
| **P4** | 配置文件完善 + 文档 | 2h |
| **总计** | | **18h** |

---

## 10. 接口设计

### 10.1 SandboxManager API

```python
class SandboxManager:
    """沙箱中央控制器"""
    
    def __init__(self, config: dict):
        self.config = config
        self.active_sandboxes: dict[str, Sandbox] = {}
        self.audit_log: list[AuditEntry] = []
    
    # 权限管理
    def grant_permission(self, agent_id: str, action: str, target: str) -> bool:
        """授予权限，返回是否允许"""
        
    def revoke_permission(self, agent_id: str, action: str):
        """撤销权限"""
        
    def revoke_all(self, agent_id: str, reason: str = ""):
        """紧急召回"""
    
    # 权限查询
    def check_permission(self, agent_id: str, action: str, target: str) -> tuple[bool, str]:
        """检查权限，返回 (允许, 原因)"""
        
    def get_permission_status(self, agent_id: str) -> dict:
        """获取 Agent 当前权限状态"""
    
    # 审计
    def log_audit(self, entry: AuditEntry):
        """记录审计日志"""
        
    def query_audit(self, agent_id: str | None = None, limit: int = 100) -> list:
        """查询审计日志"""
    
    # 配置
    def update_config(self, config: dict):
        """更新沙箱配置"""
        
    def get_agent_config(self, agent_id: str) -> dict:
        """获取 Agent 级沙箱配置"""
```

### 10.2 用户交互 API

```python
class SandboxUI:
    """沙箱用户交互界面"""
    
    def request_approval(self, request: PermissionRequest) -> ApprovalDecision:
        """请求用户授权，返回决策"""
        
    def show_audit_summary(self) -> str:
        """显示审计摘要"""
        
    def configure_auto_approve(self, levels: list[str], tools: list[str]):
        """配置默认批准策略"""
```

---

## 11. 开放问题（待确认）

- [ ] 是否需要支持"免确认"工具列表（白名单）？
- [ ] 沙箱配置是否需要版本控制？
- [ ] 审计日志是否需要加密存储？
- [ ] 是否支持沙箱配置的导入/导出？
- [ ] 是否需要沙箱使用统计报告？

---

## 12. 附录

### A. 权限决策流程图

```
操作请求
    │
    ▼
L0/L1 级别？───YES───► 自动允许 ──► 执行操作
    │
    NO
    ▼
L5 级别？───YES───► 强制拒绝 ──► 记录审计
    │
    NO
    ▼
是否在白名单？───YES───► 自动允许 ──► 执行操作
    │
    NO
    ▼
用户确认？───YES───► 授权并执行 ──► 记录审计
    │
    NO
    ▼
拒绝 ──► 记录审计
```

### B. 子 Agent 权限生命周期

```
创建 ──► 初始化沙箱 ──► 继承配置 ──► 执行任务 ──► 回收权限 ──► 销毁
                                         │
                                         ▼
                                   申请权限提升
                                         │
                                    主 Agent 审批
                                         │
                                    授权/拒绝
```

---

**方案完成，等待实现。**
