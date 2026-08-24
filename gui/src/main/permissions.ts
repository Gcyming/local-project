/**
 * gui/src/main/permissions.ts — 全局权限控制（设置「权限」专栏后端）。
 * - 独立于引擎关键配置：写入 config/gui_permissions.json（备份 + 原子写），绝不触碰
 *   slime.toml / providers.enc.json / agents.json 等权威配置。
 * - globalApproval 作为会话级审批的兜底默认（无 sandbox_override 时使用）。
 * - 工具权限与 MCP/技能开关作为「面向用户的全局控制台」持久化，供后续接入引擎审计/启用。
 */
import { PROJECT_ROOT } from "../../../core-ts/src/paths.js";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

export type ApprovalMode = "auto" | "confirm" | "strict";

export interface GuiPermissions {
  /** 全局默认审批模式（会话未单独配置时使用） */
  globalApproval: ApprovalMode;
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
  toolRead: true,
  toolWrite: true,
  toolTerminal: false,
  toolNetwork: false,
  mcpEnabled: true,
  skillsEnabled: true,
};

const VALID_APPROVALS: ApprovalMode[] = ["auto", "confirm", "strict"];

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
  return typeof v === "string" && (VALID_APPROVALS as string[]).includes(v);
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
    return {
      globalApproval: isApproval(o.globalApproval) ? o.globalApproval : DEFAULTS.globalApproval,
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
    if (!isApproval(patch.globalApproval)) {
      return { ok: false, permissions: next, error: "非法的审批模式" };
    }
    next.globalApproval = patch.globalApproval;
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