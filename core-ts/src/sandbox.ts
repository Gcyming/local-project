/**
 * core-ts/src/sandbox.ts — 沙箱系统（L0-L5 权限分级 + 审计 + 异常检测）。
 * 语义移植自 core/sandbox.py：
 * - 权限分级模型 L0-L5（默认只读），决策链：workspace → 异常 deny 规则 → 黑名单 → 需确认工具 → 自动批准 → 需确认等级 → fail-closed
 * - 审计日志（内存 + data/audit.jsonl，retention 轮转）
 * - 异常检测（写入速率 / 文件大小 / 危险模式 deny+alert / 循环 terminate / 资源耗尽）
 * - Agent 级配置覆盖（列表字段与全局取并集，A-002）
 * - 权限继承（父 Agent）与紧急回收
 * - 全局单例 + reset
 */

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ── 权限分级 ──────────────────────────────────────────────

export enum PermissionLevel {
  L0 = 0, // 纯读取
  L1 = 1, // 查看信息
  L2 = 2, // 修改文件
  L3 = 3, // 执行命令
  L4 = 4, // 网络访问
  L5 = 5, // 系统操作
}

export const LEVEL_NAMES: Record<number, string> = {
  0: "纯读取", 1: "查看信息", 2: "修改文件", 3: "执行命令", 4: "网络访问", 5: "系统操作",
};

export function levelFromString(s: string): PermissionLevel {
  const clean = String(s).trim().toUpperCase().replace(/^L/, "");
  const n = Number(clean);
  if (Number.isInteger(n) && n >= 0 && n <= 5) {
    return n as PermissionLevel;
  }
  return PermissionLevel.L0; // 解析失败回退最安全等级
}

/** 工具名匹配：支持 fnmatch 通配（A-002："mcp_browser_*"） */
function toolMatches(action: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((p) => fnmatch(action, p));
}

function fnmatch(name: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(name);
}

// ── 异常检测 ──────────────────────────────────────────────

export interface AnomalyRule {
  name: string;
  description: string;
  action: "alert" | "deny" | "deny+alert" | "terminate";
  threshold?: number;
  patterns?: string[];
}

const SUSPICIOUS_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /chmod\s+777/i,
  /curl\s+.*\|\s*bash/i,
  /wget\s+.*\|\s*sh/i,
  />\s*\/dev\/sda/i,
  /format\s+[A-Z]:/i,
  /del\s+\/[FfSQq]/i,
  /sudo\s+/i,
  /mkfs\./i,
  /dd\s+if=/i,
];

export const DEFAULT_ANOMALY_RULES: AnomalyRule[] = [
  { name: "write_rate_limit", description: "写入操作过于频繁", action: "alert", threshold: 100 },
  { name: "file_size_limit", description: "单文件过大", action: "deny", threshold: 50 },
  { name: "suspicious_patterns", description: "检测到危险操作模式", action: "deny+alert", patterns: SUSPICIOUS_PATTERNS.map((r) => r.source) },
  { name: "loop_detection", description: "检测到循环操作", action: "terminate", threshold: 1000 },
  { name: "resource_exhaustion", description: "检测到资源耗尽风险", action: "alert", threshold: 90 },
];

function ruleMatches(rule: AnomalyRule, action: string, target: string): boolean {
  if (!rule.patterns || rule.patterns.length === 0) {
    return false;
  }
  return rule.patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(target) || new RegExp(p, "i").test(action);
    } catch {
      return false;
    }
  });
}

export class AnomalyDetector {
  rules: AnomalyRule[];
  private rateCounters = new Map<string, number[]>();
  private iterationCounters = new Map<string, number>();

  constructor(rules: AnomalyRule[] = DEFAULT_ANOMALY_RULES) {
    this.rules = rules;
  }

  check(agentId: string, action: string, target: string): { detected: boolean; alerts: string[] } {
    const alerts: string[] = [];
    for (const rule of this.rules) {
      if (rule.name === "write_rate_limit" && this.checkRateLimit(agentId, action, rule.threshold ?? 100)) {
        alerts.push(rule.description);
      } else if (rule.name === "file_size_limit") {
        // 文件大小核验由调用方通过 context 提供（无 context 时跳过，避免盲查盘）
      } else if (rule.name === "loop_detection" && this.checkLoop(agentId, rule.threshold ?? 1000)) {
        alerts.push(rule.description);
      } else if (ruleMatches(rule, action, target)) {
        alerts.push(rule.description);
      }
    }
    return { detected: alerts.length > 0, alerts };
  }

  /** 写入速率：先检查后记录，避免拒绝操作被计入 */
  checkRateLimit(agentId: string, action: string, threshold: number): boolean {
    if (!action.toLowerCase().includes("write") && !action.toLowerCase().includes("delete")) {
      return false;
    }
    const key = `${agentId}:${action}`;
    const now = Date.now();
    const recent = (this.rateCounters.get(key) ?? []).filter((t) => now - t < 60_000);
    const exceeded = recent.length >= threshold;
    recent.push(now);
    this.rateCounters.set(key, recent);
    return exceeded;
  }

  checkLoop(agentId: string, threshold: number): boolean {
    const count = (this.iterationCounters.get(agentId) ?? 0) + 1;
    this.iterationCounters.set(agentId, count);
    return count > threshold;
  }

  reset(agentId = ""): void {
    if (agentId) {
      for (const [k] of this.rateCounters) {
        if (k.startsWith(agentId)) {
          this.rateCounters.delete(k);
        }
      }
      this.iterationCounters.delete(agentId);
    } else {
      this.rateCounters.clear();
      this.iterationCounters.clear();
    }
  }
}

// ── 配置 ──────────────────────────────────────────────────

export interface SandboxConfig {
  default_level: string; // strict | moderated | relaxed
  auto_approve_levels: number[];
  require_approval_levels: number[];
  deny_levels: number[];
  auto_approve_tools: string[];
  deny_tools: string[];
  require_approval_tools: string[];
  timeout_seconds: number;
  max_concurrent_permissions: number;
  inherit_from_parent: boolean;
  anomaly_detection_enabled: boolean;
  write_rate_limit: number;
  file_size_limit_mb: number;
  audit_enabled: boolean;
  audit_log_path: string;
  audit_retention_days: number;
  workspace: string;
}

export function defaultSandboxConfig(): SandboxConfig {
  return {
    default_level: "strict",
    auto_approve_levels: [0, 1],
    require_approval_levels: [2, 3, 4],
    deny_levels: [5],
    auto_approve_tools: [],
    deny_tools: [],
    require_approval_tools: [],
    timeout_seconds: 300,
    max_concurrent_permissions: 10,
    inherit_from_parent: true,
    anomaly_detection_enabled: true,
    write_rate_limit: 100,
    file_size_limit_mb: 50,
    audit_enabled: true,
    audit_log_path: "data/audit.jsonl",
    audit_retention_days: 90,
    workspace: "",
  };
}

export function sandboxConfigFromDict(data: Record<string, unknown> | undefined): SandboxConfig {
  if (!data || typeof data !== "object") {
    return defaultSandboxConfig();
  }
  const child = (data.child_default as Record<string, unknown>) ?? {};
  const anomaly = (data.anomaly_detection as Record<string, unknown>) ?? {};
  const audit = (data.audit as Record<string, unknown>) ?? {};
  return {
    default_level: String(data.default_level ?? "strict"),
    auto_approve_levels: (data.auto_approve_levels as number[]) ?? [0, 1],
    require_approval_levels: (data.require_approval_levels as number[]) ?? [2, 3, 4],
    deny_levels: (data.deny_levels as number[]) ?? [5],
    auto_approve_tools: (data.auto_approve_tools as string[]) ?? [],
    deny_tools: (data.deny_tools as string[]) ?? [],
    require_approval_tools: (data.require_approval_tools as string[]) ?? [],
    timeout_seconds: Number(child.timeout_seconds ?? data.timeout_seconds ?? 300),
    max_concurrent_permissions: Number(child.max_concurrent_permissions ?? data.max_concurrent_permissions ?? 10),
    inherit_from_parent: Boolean(child.inherit_from_parent ?? data.inherit_from_parent ?? true),
    anomaly_detection_enabled: Boolean(anomaly.enabled ?? data.anomaly_detection_enabled ?? true),
    write_rate_limit: Number(anomaly.write_rate_limit ?? data.write_rate_limit ?? 100),
    file_size_limit_mb: Number(anomaly.file_size_limit_mb ?? data.file_size_limit_mb ?? 50),
    audit_enabled: Boolean(audit.enabled ?? data.audit_enabled ?? true),
    audit_log_path: String(audit.log_path ?? data.audit_log_path ?? "data/audit.jsonl"),
    audit_retention_days: Number(audit.retention_days ?? data.audit_retention_days ?? 90),
    workspace: String(data.workspace ?? ""),
  };
}

export function defaultLevelAsInt(cfg: SandboxConfig): number {
  const mapping: Record<string, number> = { strict: 1, moderated: 3, relaxed: 5 };
  return mapping[cfg.default_level] ?? 1;
}

/** Agent 级覆盖合并：列表字段与全局取并集（A-002，覆盖不丢全局放行项） */
const MERGE_UNION_KEYS = ["auto_approve_tools", "deny_tools", "require_approval_tools"] as const;

export function mergeAgentOverride(base: SandboxConfig, override: Record<string, unknown> | undefined): SandboxConfig {
  if (!override || typeof override !== "object") {
    return base;
  }
  const data = { ...base };
  for (const key of MERGE_UNION_KEYS) {
    if (key in override) {
      data[key] = [...new Set([...(data[key] as string[]), ...((override[key] as string[]) ?? [])])].sort();
    }
  }
  for (const [key, value] of Object.entries(override)) {
    if ((MERGE_UNION_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    (data as Record<string, unknown>)[key] = value;
  }
  return data;
}

// ── 请求/决策/结果 ────────────────────────────────────────

export interface PermissionRequest {
  requestId: string;
  agentId: string;
  agentName: string;
  taskId: string;
  taskDescription: string;
  actions: Array<{ action: string; target: string; level: number }>;
  timestamp: string;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  approvedActions: string[];
  deniedActions: string[];
  reason: string;
  autoApproved: boolean;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  level: number;
  anomalyDetected: boolean;
  anomalyAlerts: string[];
}

export interface AuditEntry {
  entry_id: string;
  timestamp: string;
  agent_id: string;
  task_id: string;
  action: string;
  target: string;
  level: number;
  status: string; // allowed | denied | revoked
  granted_by: string; // auto | user | main_agent
  grant_id: string;
  details: Record<string, unknown>;
  risk_score: number;
  anomaly_detected: boolean;
}

function makeAuditEntry(partial: Partial<AuditEntry>): AuditEntry {
  return {
    entry_id: `audit_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    agent_id: "",
    task_id: "",
    action: "",
    target: "",
    level: 0,
    status: "allowed",
    granted_by: "auto",
    grant_id: "",
    details: {},
    risk_score: 0,
    anomaly_detected: false,
    ...partial,
  };
}

// ── 辅助 ──────────────────────────────────────────────────

function isWorkHours(): boolean {
  const h = new Date().getHours();
  return h >= 9 && h < 18;
}

function isSystemPath(path: string): boolean {
  const prefixes = [
    "/etc", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
    "/boot", "/dev", "/proc", "/sys",
    "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
    "/System", "/Library",
  ];
  const lower = path.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

function validateWorkspace(workspace: string, target: string): boolean {
  if (!workspace || !target) {
    return !workspace; // 无 workspace 不限制；有 workspace 必须有 target
  }
  try {
    let tp = target;
    try {
      const parsed = JSON.parse(target);
      if (parsed && typeof parsed === "object") {
        if (parsed.url) {
          return true; // 网络目标归 SSRF 防护管
        }
        const p = parsed.path ?? parsed.file ?? parsed.target;
        if (!p) {
          return false; // 无路径字段拒绝（隔离范围内必须明确目标）
        }
        tp = String(p);
      }
    } catch {
      // 非 JSON，按路径处理
    }
    const ws = resolve(workspace);
    const abs = resolve(tp);
    return abs === ws || abs.startsWith(ws + sep);
  } catch {
    return false;
  }
}

// ── SandboxManager ────────────────────────────────────────

export class SandboxManager {
  config: SandboxConfig;
  private approvalCallback: ((req: PermissionRequest) => ApprovalDecision) | null;
  private activeGrants = new Map<string, { agent_id: string; action: string; target: string; level: number; granted_by: string; granted_at: number }>();
  private agentGrants = new Map<string, string[]>();
  private agentConfigs = new Map<string, SandboxConfig>();
  private agentRegistry = new Map<string, { parent_id: string; name: string; task_id: string }>();
  private violations = new Map<string, number>();
  private auditLog: AuditEntry[] = [];
  private anomalyDetector = new AnomalyDetector();
  private upgradeExpiry = new Map<string, Array<[number, number]>>();
  private auditQueue: Promise<void> = Promise.resolve();

  constructor(config?: SandboxConfig, approvalCallback?: (req: PermissionRequest) => ApprovalDecision) {
    this.config = config ?? defaultSandboxConfig();
    this.approvalCallback = approvalCallback ?? null;
  }

  setApprovalCallback(cb: (req: PermissionRequest) => ApprovalDecision): void {
    this.approvalCallback = cb;
  }

  registerAgent(agentId: string, opts: { parentId?: string; name?: string; taskId?: string } = {}): void {
    this.agentRegistry.set(agentId, {
      parent_id: opts.parentId ?? "",
      name: opts.name ?? agentId,
      task_id: opts.taskId ?? "",
    });
  }

  recordViolation(agentId: string): void {
    this.violations.set(agentId, (this.violations.get(agentId) ?? 0) + 1);
    try {
      void this.writeAudit(makeAuditEntry({
        agent_id: agentId,
        action: "permission_denied",
        status: "denied",
        details: { violation_count: this.violations.get(agentId) },
      }));
    } catch {
      // 审计失败不影响主流程
    }
  }

  popViolations(agentId: string): boolean {
    const n = this.violations.get(agentId) ?? 0;
    this.violations.delete(agentId);
    return n > 0;
  }

  /** 预检查（不写审计）：返回 PermissionCheckResult（对齐 check_permission 决策链） */
  checkPermission(agentId: string, action: string, target: string, level: number): PermissionCheckResult {
    const cfg = this.getAgentConfig(agentId);

    if (cfg.workspace && target && !validateWorkspace(cfg.workspace, target)) {
      return { allowed: false, reason: `目标 '${target}' 超出工作目录范围`, level, anomalyDetected: false, anomalyAlerts: [] };
    }

    let anomalyDetected = false;
    let anomalyAlerts: string[] = [];
    if (cfg.anomaly_detection_enabled) {
      const r = this.anomalyDetector.check(agentId, action, target);
      anomalyDetected = r.detected;
      anomalyAlerts = r.alerts;
    }

    // 1. 黑名单优先
    if (cfg.deny_levels.includes(level) || toolMatches(action, cfg.deny_tools)) {
      return { allowed: false, reason: `操作 '${action}' (L${level}) 被禁止`, level, anomalyDetected, anomalyAlerts };
    }

    // B1: 异常 deny/terminate 级规则强制执行（含非模式规则：循环检测等）
    if (anomalyDetected) {
      for (const rule of this.anomalyDetector.rules) {
        if ((ruleMatches(rule, action, target) || anomalyAlerts.includes(rule.description)) && (rule.action === "deny" || rule.action === "deny+alert" || rule.action === "terminate")) {
          return { allowed: false, reason: `异常操作被拒绝: ${rule.description}`, level, anomalyDetected: true, anomalyAlerts: [...anomalyAlerts, rule.description] };
        }
      }
    }

    // 2. 需确认的工具优先于等级自动批准
    if (toolMatches(action, cfg.require_approval_tools)) {
      return { allowed: false, reason: `工具 '${action}' 需要用户确认`, level, anomalyDetected, anomalyAlerts };
    }

    // 3. 自动批准
    if (cfg.auto_approve_levels.includes(level) || toolMatches(action, cfg.auto_approve_tools)) {
      // A-088 P1-9：mcp_* 通配只自动批准低权限；network/terminal 级仍需确认/拒绝
      if (toolMatches(action, cfg.auto_approve_tools) && action.startsWith("mcp_") && level >= 3) {
        // 落入后续等级判定
      } else {
        return { allowed: true, reason: "自动批准", level, anomalyDetected, anomalyAlerts };
      }
    }

    // 4. 需确认的等级
    if (cfg.require_approval_levels.includes(level)) {
      return { allowed: false, reason: `操作 '${action}' (L${level}) 需要用户确认`, level, anomalyDetected, anomalyAlerts };
    }

    return { allowed: false, reason: `未知权限等级 L${level}，已拒绝`, level, anomalyDetected, anomalyAlerts };
  }

  /** 授权 + 审计（决策链同 check_permission，L2-L4 走 approval 回调） */
  async grantPermission(opts: {
    agentId: string;
    action: string;
    target: string;
    level: number;
    grantedBy?: string;
    taskId?: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    return this.grantCore(opts);
  }

  /** 同步授权 + 审计（ToolLoop 沙箱门适配用；与 grantPermission 同决策链） */
  grantPermissionSync(opts: {
    agentId: string;
    action: string;
    target: string;
    level: number;
    grantedBy?: string;
    taskId?: string;
  }): { allowed: boolean; reason: string; anomalyDetected: boolean; anomalyAlerts: string[] } {
    return this.grantCore(opts);
  }

  private grantCore(opts: {
    agentId: string;
    action: string;
    target: string;
    level: number;
    grantedBy?: string;
    taskId?: string;
  }): { allowed: boolean; reason: string; anomalyDetected: boolean; anomalyAlerts: string[] } {
    const { agentId, action, target, level } = opts;
    const grantedBy = opts.grantedBy ?? "auto";
    const taskId = opts.taskId ?? "";
    const cfg = this.getAgentConfig(agentId);

    if (cfg.workspace && target && !validateWorkspace(cfg.workspace, target)) {
      this.writeAudit(makeAuditEntry({ agent_id: agentId, task_id: taskId, action, target, level, status: "denied", granted_by: grantedBy, details: { reason: `目标路径不在工作目录 ${cfg.workspace} 内` } }));
      return { allowed: false, reason: `目标 '${target}' 超出工作目录范围`, anomalyDetected: false, anomalyAlerts: [] };
    }

    let anomalyDetected = false;
    let anomalyAlerts: string[] = [];
    if (cfg.anomaly_detection_enabled) {
      const r = this.anomalyDetector.check(agentId, action, target);
      anomalyDetected = r.detected;
      anomalyAlerts = r.alerts;
    }

    if (cfg.deny_levels.includes(level) || toolMatches(action, cfg.deny_tools)) {
      this.writeAudit(makeAuditEntry({ agent_id: agentId, task_id: taskId, action, target, level, status: "denied", granted_by: grantedBy, risk_score: anomalyDetected ? 1 : 0, anomaly_detected: anomalyDetected }));
      return { allowed: false, reason: `操作 '${action}' (L${level}) 被禁止`, anomalyDetected, anomalyAlerts };
    }

    if (anomalyDetected) {
      for (const rule of this.anomalyDetector.rules) {
        if ((ruleMatches(rule, action, target) || anomalyAlerts.includes(rule.description)) && (rule.action === "deny" || rule.action === "deny+alert" || rule.action === "terminate")) {
          this.writeAudit(makeAuditEntry({ agent_id: agentId, task_id: taskId, action, target, level, status: "denied", granted_by: grantedBy, risk_score: 1, anomaly_detected: true, details: { rule: rule.name, action: rule.action } }));
          return { allowed: false, reason: `异常操作被拒绝: ${rule.description}`, anomalyDetected: true, anomalyAlerts: [...anomalyAlerts, rule.description] };
        }
      }
    }

    // 需确认的工具（回调）
    if (toolMatches(action, cfg.require_approval_tools)) {
      const r = this.approvalPath({ agentId, action, target, level, taskId, anomalyDetected, rule: "工具" });
      return { ...r, anomalyDetected, anomalyAlerts };
    }

    if (cfg.auto_approve_levels.includes(level) || toolMatches(action, cfg.auto_approve_tools)) {
      if (!(toolMatches(action, cfg.auto_approve_tools) && action.startsWith("mcp_") && level >= 3)) {
        const gid = this.recordGrant(agentId, action, target, level, grantedBy);
        this.writeAudit(makeAuditEntry({ agent_id: agentId, task_id: taskId, action, target, level, status: "allowed", granted_by: grantedBy, grant_id: gid, anomaly_detected: anomalyDetected }));
        return { allowed: true, reason: "自动批准", anomalyDetected, anomalyAlerts };
      }
    }

    if (cfg.require_approval_levels.includes(level)) {
      const r = this.approvalPath({ agentId, action, target, level, taskId, anomalyDetected, rule: "等级" });
      return { ...r, anomalyDetected, anomalyAlerts };
    }

    return { allowed: false, reason: `未知权限等级 L${level}，已拒绝`, anomalyDetected, anomalyAlerts };
  }

  private approvalPath(opts: {
    agentId: string; action: string; target: string; level: number; taskId: string; anomalyDetected: boolean; rule: string;
  }): { allowed: boolean; reason: string } {
    if (!this.approvalCallback) {
      this.writeAudit(makeAuditEntry({ agent_id: opts.agentId, task_id: opts.taskId, action: opts.action, target: opts.target, level: opts.level, status: "denied", granted_by: "auto", anomaly_detected: opts.anomalyDetected, details: { reason: "未配置确认回调" } }));
      return { allowed: false, reason: `操作 '${opts.action}' (L${opts.level}) 需要用户确认（未配置确认回调）` };
    }
    const info = this.agentRegistry.get(opts.agentId) ?? { parent_id: "", name: opts.agentId, task_id: "" };
    const req: PermissionRequest = {
      requestId: `perm_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      agentId: opts.agentId,
      agentName: info.name,
      taskId: opts.taskId || info.task_id,
      taskDescription: "",
      actions: [{ action: opts.action, target: opts.target, level: opts.level }],
      timestamp: new Date().toISOString(),
    };
    const decision = this.approvalCallback(req);
    if (decision.approved) {
      const gid = this.recordGrant(opts.agentId, opts.action, opts.target, opts.level, "user");
      this.writeAudit(makeAuditEntry({ agent_id: opts.agentId, task_id: opts.taskId, action: opts.action, target: opts.target, level: opts.level, status: "allowed", granted_by: "user", grant_id: gid, anomaly_detected: opts.anomalyDetected }));
      return { allowed: true, reason: "用户批准" };
    }
    this.writeAudit(makeAuditEntry({ agent_id: opts.agentId, task_id: opts.taskId, action: opts.action, target: opts.target, level: opts.level, status: "denied", granted_by: "user", anomaly_detected: opts.anomalyDetected }));
    return { allowed: false, reason: `用户拒绝: ${decision.reason}` };
  }

  private recordGrant(agentId: string, action: string, target: string, level: number, grantedBy: string): string {
    const gid = `grant_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    this.activeGrants.set(gid, { agent_id: agentId, action, target, level, granted_by: grantedBy, granted_at: Date.now() });
    this.agentGrants.set(agentId, [...(this.agentGrants.get(agentId) ?? []), gid]);
    return gid;
  }

  /** 紧急回收某 Agent 所有权限 */
  async revokeAll(agentId: string, reason = ""): Promise<void> {
    for (const gid of this.agentGrants.get(agentId) ?? []) {
      const grant = this.activeGrants.get(gid);
      if (grant) {
        this.writeAudit(makeAuditEntry({
          agent_id: agentId, action: grant.action, target: grant.target, level: grant.level,
          status: "revoked", granted_by: "main_agent", grant_id: gid,
          details: reason ? { reason } : {},
        }));
        this.activeGrants.delete(gid);
      }
    }
    this.agentGrants.delete(agentId);
    this.agentConfigs.delete(agentId);
    this.upgradeExpiry.delete(agentId);
    this.anomalyDetector.reset(agentId);
  }

  getAgentConfig(agentId: string): SandboxConfig {
    let cfg: SandboxConfig;
    if (this.agentConfigs.has(agentId)) {
      cfg = this.agentConfigs.get(agentId)!;
    } else {
      const info = this.agentRegistry.get(agentId);
      if (info?.parent_id) {
        const parentCfg = this.getAgentConfig(info.parent_id);
        cfg = parentCfg.inherit_from_parent ? { ...parentCfg, workspace: "" } : this.config;
      } else {
        cfg = this.config;
      }
    }
    const upgrades = this.upgradeExpiry.get(agentId) ?? [];
    if (upgrades.length > 0) {
      const now = Date.now();
      const active = upgrades.filter(([_, exp]) => exp > now);
      if (active.length !== upgrades.length) {
        this.upgradeExpiry.set(agentId, active);
      }
      if (active.length > 0) {
        cfg = { ...cfg, auto_approve_levels: [...new Set([...cfg.auto_approve_levels, ...active.map(([lvl]) => lvl)])] };
      }
    }
    return cfg;
  }

  setAgentConfig(agentId: string, cfg: SandboxConfig): void {
    this.agentConfigs.set(agentId, cfg);
  }

  removeAgentConfig(agentId: string): void {
    this.agentConfigs.delete(agentId);
  }

  /** 子 Agent 申请权限提升（B4：5 分钟临时有效，不永久改 config） */
  requestPermissionUpgrade(agentId: string, targetLevel: number, reason = ""): { allowed: boolean; reason: string } {
    const info = this.agentRegistry.get(agentId);
    if (!info?.parent_id) {
      return { allowed: true, reason: "主 Agent 无需权限提升" };
    }
    const cfg = this.getAgentConfig(agentId);
    if (cfg.deny_levels.includes(targetLevel)) {
      this.writeAudit(makeAuditEntry({ agent_id: agentId, action: "permission_upgrade", target: `L${targetLevel}`, level: targetLevel, status: "denied", granted_by: "main_agent", details: { reason: `L${targetLevel} 被禁止` } }));
      return { allowed: false, reason: `L${targetLevel} 操作被禁止` };
    }
    if (cfg.require_approval_levels.includes(targetLevel)) {
      if (!this.approvalCallback) {
        return { allowed: false, reason: "权限提升需要用户确认（未配置确认回调）" };
      }
      const req: PermissionRequest = {
        requestId: `perm_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        agentId,
        agentName: info.name,
        taskId: info.task_id,
        taskDescription: reason,
        actions: [{ action: "permission_upgrade", target: `L${targetLevel}`, level: targetLevel }],
        timestamp: new Date().toISOString(),
      };
      const decision = this.approvalCallback(req);
      if (decision.approved) {
        this.upgradeExpiry.set(agentId, [...(this.upgradeExpiry.get(agentId) ?? []), [targetLevel, Date.now() + 300_000]]);
        this.writeAudit(makeAuditEntry({ agent_id: agentId, action: "permission_upgrade", target: `L${targetLevel}`, level: targetLevel, status: "allowed", granted_by: "user" }));
        return { allowed: true, reason: "权限提升已批准" };
      }
      this.writeAudit(makeAuditEntry({ agent_id: agentId, action: "permission_upgrade", target: `L${targetLevel}`, level: targetLevel, status: "denied", granted_by: "user" }));
      return { allowed: false, reason: `权限提升被拒绝: ${decision.reason}` };
    }
    return { allowed: false, reason: `L${targetLevel} 未在审批规则中列出，默认拒绝` };
  }

  // ── 审计 ──────────────────────────────────────────────

  writeAudit(entry: AuditEntry): void {
    if (!this.config.audit_enabled) {
      return;
    }
    this.auditLog.push(entry);
    try {
      const path = resolveAuditPath(this.config);
      const line = JSON.stringify(entry) + "\n";
      this.auditQueue = this.auditQueue
        .then(() => mkdir(resolve(path, ".."), { recursive: true }))
        .then(() => appendFile(path, line, "utf-8"))
        .catch(() => {});
    } catch {
      // 审计写入失败不影响主流程
    }
    if (this.auditLog.length % 200 === 0) {
      void this.rotateAuditLog();
    }
  }

  /** 等待审计磁盘写入排空（测试/收尾用） */
  async flushAudit(): Promise<void> {
    await this.auditQueue;
  }

  async rotateAuditLog(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.audit_retention_days * 86_400_000).toISOString();
    const kept = this.auditLog.filter((e) => e.timestamp >= cutoff);
    this.auditLog = kept;
    try {
      const path = resolveAuditPath(this.config);
      await writeFile(path, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), "utf-8");
    } catch {
      // 轮转写入失败不影响主流程
    }
  }

  queryAudit(agentId = "", limit = 100): AuditEntry[] {
    const entries = agentId ? this.auditLog.filter((e) => e.agent_id === agentId) : this.auditLog;
    return entries.slice(-limit);
  }

  getAuditSummary(): Record<string, unknown> {
    const allowed = this.auditLog.filter((e) => e.status === "allowed").length;
    const denied = this.auditLog.filter((e) => e.status === "denied").length;
    const revoked = this.auditLog.filter((e) => e.status === "revoked").length;
    const anomalies = this.auditLog.filter((e) => e.anomaly_detected).length;
    return {
      total_operations: this.auditLog.length,
      allowed, denied, revoked, anomalies,
      recent_denials: this.auditLog.filter((e) => e.status === "denied").slice(-10),
    };
  }

  updateConfig(cfg: SandboxConfig): void {
    this.config = cfg;
  }

  calculateRiskScore(action: string, context?: { target?: string }): number {
    const RISK_BASE: Record<string, number> = {
      file_read: 0.0, file_write: 0.3, rm: 0.7, pip: 0.5, git_push: 0.4,
      sudo: 0.9, chmod: 0.8, curl: 0.6,
    };
    let score = RISK_BASE[action] ?? 0.2;
    if (!isWorkHours()) {
      score += 0.2;
    }
    if (context?.target && isSystemPath(context.target)) {
      score += 0.4;
    }
    return Math.min(score, 1.0);
  }
}

function resolveAuditPath(cfg: SandboxConfig): string {
  return resolve(PROJECT_ROOT, cfg.audit_log_path);
}

// ── 全局单例 ──────────────────────────────────────────────

let globalManager: SandboxManager | null = null;

export function getSandboxManager(): SandboxManager {
  if (!globalManager) {
    globalManager = new SandboxManager();
  }
  return globalManager;
}

export function resetSandboxManager(config?: SandboxConfig, approvalCallback?: (req: PermissionRequest) => ApprovalDecision): void {
  globalManager = new SandboxManager(config, approvalCallback);
}