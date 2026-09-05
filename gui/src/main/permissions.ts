/**
 * gui/src/main/permissions.ts — 全局权限控制（设置「权限」专栏后端）。
 * - 独立于引擎关键配置：写入 config/gui_permissions.json（备份 + 原子写），绝不触碰
 *   slime.toml / providers.enc.json / agents.json 等权威配置。
 * - globalApproval 作为会话级审批的兜底默认（无 sandbox_override 时使用）。
 * - approvalAllowPaths：自定义审批白名单（目录/仓库命中免审批，custom 档生效）。
 * - 工具权限与 MCP/技能开关作为「面向用户的全局控制台」持久化，供后续接入引擎审计/启用。
 */
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** 审批档位：manual 手动 / auto 自动 / none 无需 / custom 自定义（旧值 strict/confirm 兼容为 manual） */
export type ApprovalMode = "manual" | "auto" | "none" | "custom";

export interface GuiPermissions {
  /** 全局默认审批模式（会话未单独配置时使用）；旧值 strict/confirm 读入时按 manual 兼容 */
  globalApproval: ApprovalMode;
  /** 自定义审批白名单（设置·权限·预设放行目录/仓库）：命中路径免审批 */
  approvalAllowPaths: string[];
  /** 工具权限类别（对应 Tool.permissions ∈ {read,write,terminal,network}） */
  toolRead: boolean;
  toolWrite: boolean;
  toolTerminal: boolean;
  toolNetwork: boolean;
  /** 全局功能开关 */
  mcpEnabled: boolean;
  skillsEnabled: boolean;
}

const DEFAULTS: GuiPermissions = {
  globalApproval: "auto",
  approvalAllowPaths: [],
  toolRead: true,
  toolWrite: true,
  toolTerminal: false,
  toolNetwork: false,
  mcpEnabled: true,
  skillsEnabled: true,
};

const VALID_APPROVALS: ApprovalMode[] = ["manual", "auto", "none", "custom"];
const LEGACY_APPROVALS: Record<string, ApprovalMode> = { strict: "manual", confirm: "manual" };

let rootOverride: string | null = null;
export function setRootOverrideForTest(root: string | null): void {
  rootOverride = root;
}
function projectRoot(): string {
  return rootOverride ?? PROJECT_ROOT;
}
function permPath(): string {
  return join(projectRoot(), "config", "gui_permissions.json");
}

function isApproval(v: unknown): v is ApprovalMode {
  if (typeof v !== "string") {
    return false;
  }
  return (VALID_APPROVALS as string[]).includes(v) || v in LEGACY_APPROVALS;
}

function normalizeApproval(v: unknown): ApprovalMode {
  if (typeof v === "string") {
    return LEGACY_APPROVALS[v] ?? (isApproval(v) ? (v as ApprovalMode) : DEFAULTS.globalApproval);
  }
  return DEFAULTS.globalApproval;
}

export function getPermissions(): GuiPermissions {
  const p = permPath();
  if (!existsSync(p)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return { ...DEFAULTS };
    }
    const o = raw as Record<string, unknown>;
    const allowRaw = Array.isArray(o.approvalAllowPaths)
      ? (o.approvalAllowPaths as unknown[]).filter((x): x is string => typeof x === "string")
      : DEFAULTS.approvalAllowPaths;
    return {
      globalApproval: normalizeApproval(o.globalApproval),
      approvalAllowPaths: allowRaw,
      toolRead: typeof o.toolRead === "boolean" ? o.toolRead : DEFAULTS.toolRead,
      toolWrite: typeof o.toolWrite === "boolean" ? o.toolWrite : DEFAULTS.toolWrite,
      toolTerminal: typeof o.toolTerminal === "boolean" ? o.toolTerminal : DEFAULTS.toolTerminal,
      toolNetwork: typeof o.toolNetwork === "boolean" ? o.toolNetwork : DEFAULTS.toolNetwork,
      mcpEnabled: typeof o.mcpEnabled === "boolean" ? o.mcpEnabled : DEFAULTS.mcpEnabled,
      skillsEnabled: typeof o.skillsEnabled === "boolean" ? o.skillsEnabled : DEFAULTS.skillsEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPermissions(patch: Partial<GuiPermissions>): { ok: boolean; permissions: GuiPermissions; error?: string } {
  const next = { ...getPermissions() };
  if (patch.globalApproval !== undefined) {
    const norm = normalizeApproval(patch.globalApproval);
    if (!isApproval(norm)) {
      return { ok: false, permissions: next, error: "非法的审批模式" };
    }
    next.globalApproval = norm;
  }
  if (patch.approvalAllowPaths !== undefined) {
    if (!Array.isArray(patch.approvalAllowPaths)) {
      return { ok: false, permissions: next, error: "审批白名单必须是路径数组" };
    }
    next.approvalAllowPaths = patch.approvalAllowPaths.filter((x) => typeof x === "string");
  }
  for (const k of ["toolRead", "toolWrite", "toolTerminal", "toolNetwork", "mcpEnabled", "skillsEnabled"] as const) {
    if (patch[k] !== undefined) {
      next[k] = Boolean(patch[k]);
    }
  }
  try {
    const dir = dirname(permPath());
    mkdirSync(dir, { recursive: true });
    const p = permPath();
    if (existsSync(p)) {
      copyFileSync(p, `${p}.bak`);
    }
    const tmp = `${p}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    renameSync(tmp, p);
    return { ok: true, permissions: next };
  } catch (e) {
    return { ok: false, permissions: next, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}