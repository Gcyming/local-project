

















import { assessAction, splitCommand, isProtectedSourcePath } from "./classifier.js";
import { PROJECT_ROOT } from "../paths.js";
import type { ToolPermission } from "./registry.js";

export interface HardRuleInput {
  
  name: string;
  
  riskKind: ToolPermission;
  
  target: string;
  
  projectRoot?: string;
}

export interface HardRuleVerdict {
  
  blocked: boolean;
  reason: string;
  matched: string;
}

const OK: HardRuleVerdict = { blocked: false, reason: "", matched: "" };


export function hardRuleCheck(input: HardRuleInput): HardRuleVerdict {
  const target = (input.target ?? "").trim();
  const kind = input.riskKind;

  if (kind === "read") { return { ...OK, reason: "只读动作不受硬规则限制", matched: "read" }; }
  
  if (!target) { return { ...OK, reason: "无可判定目标", matched: "no-target" }; }

  if (kind === "terminal") {
    const { command, commandArgs } = splitCommand(target);
    const r = assessAction({ kind: "terminal", command, commandArgs });
    return r.level === "block"
      ? { blocked: true, reason: r.reason, matched: r.matched }
      : { ...OK, reason: r.reason, matched: r.matched };
  }

  if (kind === "write") {
    const r = assessAction({ kind: "write", path: target });
    if (r.level === "block") { return { blocked: true, reason: r.reason, matched: r.matched }; }
    
    if (isProtectedSourcePath(target, input.projectRoot ?? PROJECT_ROOT)) {
      return { blocked: true, reason: `受保护源码目录禁止写入：${target.slice(0, 60)}`, matched: "protected-dir" };
    }
    return { ...OK, reason: r.reason, matched: r.matched };
  }

  
  const r = assessAction({ kind: "network", url: target });
  return r.level === "block"
    ? { blocked: true, reason: r.reason, matched: r.matched }
    : { ...OK, reason: r.reason, matched: r.matched };
}










export function targetFromArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") { return ""; }
  for (const k of ["url", "path", "file", "target", "command", "cmd"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) { return v.trim(); }
  }
  return "";
}
