/**
 * core-ts/src/tools/grant.ts — 「设置 → 权限」开关的**放行语义唯一实现**。
 *
 * 【为什么单独成模块】
 * 开关的语义此前散落在两处、且互不一致：
 *   ① `registry.callTool` 的类别闸门只认「关闭 = 否决」，对「开启」不表态；
 *   ② `index.ts` 的审批回调按「工具是否声明 autoApprovable」决定要不要弹窗，
 *      完全不看开关 —— 于是用户在设置里打开「终端 / 写」之后，仍然每次都要被问
 *      （adb_shell / adb_push / adb_uninstall / http_create_app … 全在弹窗）。
 * 用户要求的是「开关打开 = 该类别直接放行」，所以放行判据必须是**同一份**实现、
 * 同一份被闸门与审批回调共用；否则两处判据一漂移，就又变成"改了设置没反应"。
 *
 * 【边界】
 * 本模块只回答「用户是否已用开关放行该类能力」，**不做**任何安全判定。
 * 硬规则（越权路径 / 敏感文件 / 受保护源码目录 / 终端黑名单 / 内网地址）在
 * `hard_rules.ts`，且**不随开关降级** —— 开关放行的是"免逐次审批"，不是"免安全边界"。
 */
import type { Tool } from "./registry.js";

/** 开关能放行的能力类别（= 设置面板里的每一项） */
export type GrantCategory = "read" | "write" | "terminal" | "network" | "screen" | "mcp" | "skill";

/** 设置面板的六个开关（结构兼容 GuiPermissions，避免 core-ts 依赖 GUI 层类型） */
export interface GrantSwitches {
  toolRead: boolean;
  toolWrite: boolean;
  toolTerminal: boolean;
  screenEnabled: boolean;
  mcpEnabled: boolean;
  skillsEnabled: boolean;
}

/** 工具所属的能力类别。
 *  判据顺序（**必须稳定**，否则「属于哪一类」会随集合顺序漂移）：
 *    ① 名字前缀 —— MCP / 技能 / 图形控制是运行时唯一可靠判据（工具由运行期注册，
 *       无法靠 permissions 区分；`mcp_*` 见 core-ts/src/mcp.ts，`skill_*` 见 core-ts/src/skills.ts）；
 *    ② permissions 里风险最高的一类 —— 与 `Tool.effectiveRiskKind()` 同一 order
 *       （read < write < terminal < network），避免"读+写"工具被当成只读而漏放行/漏拦截。
 *  network 无对应设置开关（联网由输入栏「联网搜索」开关 + ToolLoop 逐调用判定），
 *  本函数仍如实把它归为 network —— 放行判定里单独说明，不在这里吞掉。 */
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

/** 该类别是否已被用户在「设置 → 权限」中放行（开启 = 免逐次审批，直接执行）。
 *  network 恒为 true：它没有设置开关，联网策略由输入栏开关与沙箱硬规则承担；
 *  若在这里返回 false，会在审批回调里把 adb_connect / http_serve 这类
 *  "非只读但无破坏性"的网络工具重新变回逐次弹窗 —— 与用户「别再问」的要求相反。 */
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

/** 便捷组合：该工具是否已被开关放行 */
export function isGrantedTool(sw: GrantSwitches, tool: Pick<Tool, "name" | "permissions">): boolean {
  return isGranted(sw, categoryOf(tool));
}
