













import { assessAction, splitCommand } from "./classifier.js";
import { categoryOf, isGrantedTool, type GrantSwitches } from "./grant.js";
import { hardRuleCheck } from "./hard_rules.js";
import type { ToolPermission } from "./registry.js";


export interface ToolShape {
  name: string;
  permissions: ToolPermission[];
}

export interface GateVerdict {
  allowed: boolean;
  
  kind?: "category" | "safety";
  reason?: string;
}

export interface GateInput {
  tool: ToolShape;
  riskKind: ToolPermission;
  
  target: string;
  switches: GrantSwitches;
  projectRoot?: string;
}







export function gateToolCall(input: GateInput): GateVerdict {
  const { tool, switches } = input;
  const n = tool.name ?? "";

  
  if (!switches.screenEnabled && n.startsWith("screen_")) {
    return { allowed: false, kind: "category", reason: "图形控制已在「设置 → 权限」中关闭" };
  }
  if (!switches.mcpEnabled && n.startsWith("mcp_")) {
    return { allowed: false, kind: "category", reason: "MCP 已在「设置 → 权限」中关闭" };
  }
  if (!switches.skillsEnabled && n.startsWith("skill_")) {
    return { allowed: false, kind: "category", reason: "技能已在「设置 → 权限」中关闭" };
  }
  const perms = tool.permissions ?? [];
  const has = (p: ToolPermission): boolean => perms.includes(p);
  
  if (!has("write") && !has("terminal") && !has("network")) {
    return switches.toolRead
      ? { allowed: true }
      : { allowed: false, kind: "category", reason: "「读」类别已关闭" };
  }
  
  
  if (!switches.toolWrite && has("write")) {
    return { allowed: false, kind: "category", reason: "「写」类别已关闭" };
  }
  if (!switches.toolTerminal && has("terminal")) {
    return { allowed: false, kind: "category", reason: "「终端」类别已关闭（ADB shell / 命令执行需开启此项）" };
  }

  
  const hard = hardRuleCheck({
    name: n,
    riskKind: input.riskKind,
    target: input.target,
    projectRoot: input.projectRoot,
  });
  if (hard.blocked) {
    return { allowed: false, kind: "safety", reason: hard.reason };
  }
  return { allowed: true };
}

export type RiskLevel = "auto" | "confirm" | "block";

export interface ClassifyOutcome {
  level: RiskLevel;
  reason: string;
  matched: string;
}

export interface ClassifyInput {
  name: string;
  permissions: ToolPermission[];
  riskKind: ToolPermission;
  
  autoApprovable: boolean;
  target: string;
  switches: GrantSwitches;
  projectRoot?: string;
}





export function classifyToolCall(input: ClassifyInput): ClassifyOutcome {
  const tool: ToolShape = { name: input.name, permissions: input.permissions };

  const hard = hardRuleCheck({
    name: input.name,
    riskKind: input.riskKind,
    target: input.target,
    projectRoot: input.projectRoot,
  });
  if (hard.blocked) {
    return { level: "block", reason: hard.reason, matched: hard.matched };
  }

  
  if (isGrantedTool(input.switches, tool)) {
    return {
      level: "auto",
      reason: `${categoryOf(tool)} 类别已在「设置 → 权限」放行（硬规则仍生效）`,
      matched: "switch-grant",
    };
  }

  const kind = input.riskKind;
  let r: ClassifyOutcome;
  if (kind === "read") {
    r = { level: "auto", reason: `只读工具 ${input.name}`, matched: "read" };
  } else if (kind === "terminal") {
    const { command, commandArgs } = splitCommand(input.target);
    r = assessAction({ kind: "terminal", command, commandArgs });
  } else if (kind === "write") {
    r = assessAction({ kind: "write", path: input.target });
  } else {
    r = assessAction({ kind: "network", url: input.target });
  }

  
  
  if (kind !== "read" && r.level === "auto" && !input.autoApprovable) {
    r = {
      level: "confirm",
      reason: `${input.name}（${kind} 类）未声明可自动放行，且对应类别未在设置中放行，需用户确认`,
      matched: "policy-confirm",
    };
  }
  return r;
}
