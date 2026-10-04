
















import type { Tool } from "./registry.js";


export type GrantCategory = "read" | "write" | "terminal" | "network" | "screen" | "mcp" | "skill";


export interface GrantSwitches {
  toolRead: boolean;
  toolWrite: boolean;
  toolTerminal: boolean;
  screenEnabled: boolean;
  mcpEnabled: boolean;
  skillsEnabled: boolean;
}









export function categoryOf(tool: Pick<Tool, "name" | "permissions">): GrantCategory {
  const n = tool.name ?? "";
  if (n.startsWith("screen_")) { return "screen"; }
  if (n.startsWith("mcp_")) { return "mcp"; }
  if (n.startsWith("skill_")) { return "skill"; }
  const order = ["read", "write", "terminal", "network"] as const;
  let best: GrantCategory = "read";
  for (const p of tool.permissions ?? []) {
    const i = order.indexOf(p as (typeof order)[number]);
    if (i > order.indexOf(best as (typeof order)[number])) { best = p as GrantCategory; }
  }
  return best;
}





export function isGranted(sw: GrantSwitches, cat: GrantCategory): boolean {
  switch (cat) {
    case "read": return sw.toolRead;
    case "write": return sw.toolWrite;
    case "terminal": return sw.toolTerminal;
    case "screen": return sw.screenEnabled;
    case "mcp": return sw.mcpEnabled;
    case "skill": return sw.skillsEnabled;
    case "network": return true;
  }
}


export function isGrantedTool(sw: GrantSwitches, tool: Pick<Tool, "name" | "permissions">): boolean {
  return isGranted(sw, categoryOf(tool));
}
