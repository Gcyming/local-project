
















import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";


export type ApprovalMode = "manual" | "auto" | "none" | "custom";

export interface GuiPermissions {
  
  globalApproval: ApprovalMode;
  
  approvalAllowPaths: string[];
  
  toolRead: boolean;
  toolWrite: boolean;
  
  toolTerminal: boolean;
  
  screenEnabled: boolean;
  
  mcpEnabled: boolean;
  skillsEnabled: boolean;
}

const DEFAULTS: GuiPermissions = {
  globalApproval: "auto",
  approvalAllowPaths: [],
  toolRead: true,
  toolWrite: true,
  toolTerminal: false,
  screenEnabled: false,
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
      screenEnabled: typeof o.screenEnabled === "boolean" ? o.screenEnabled : DEFAULTS.screenEnabled,
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
  for (const k of ["toolRead", "toolWrite", "toolTerminal", "screenEnabled", "mcpEnabled", "skillsEnabled"] as const) {
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