/**
 * core-ts/src/tools/policy.ts — 工具调用的**两个对外决策**（纯函数，装配层只负责接线）。
 *
 * 一次工具调用在两个地方需要判定，历史上两处各自内联、互不知情，于是漂移出三类真实故障：
 *   ① 闸门只答"类别是否关闭"，对"开关已开启"不表态 → 开关打开后照样逐次弹窗；
 *   ② 硬规则只住在审批回调里，而回调仅在沙箱决定要问用户时才跑
 *      → `自动 / 无需` 档把安全边界一起免掉；
 *   ③ 两边的判据顺序不同（闸门先类别、回调先硬规则），"先放行还是先拦"随调用路径变化。
 *
 * 本模块把顺序**固定下来、并且可单测**：
 *   闸门 `gateToolCall`：类别否决 → 硬规则拦截 → 放行（不做"批准"，批准是审批层的事）
 *   审批 `classifyToolCall`：硬规则拦截 → 开关放行 → 内容分级 → 未声明无副作用则需确认
 * 两条链都以「硬规则」为最高优先级，任何档位与开关都不能越过。
 */
import { assessAction, splitCommand } from "./classifier.js";
import { categoryOf, isGrantedTool, type GrantSwitches } from "./grant.js";
import { hardRuleCheck } from "./hard_rules.js";
import type { ToolPermission } from "./registry.js";

/** 决策所需的最小工具描述（避免依赖 Tool 实例，纯函数可单测） */
export interface ToolShape {
  name: string;
  permissions: ToolPermission[];
}

export interface GateVerdict {
  allowed: boolean;
  /** category=类别开关关闭（可引导用户去设置开启）；safety=硬规则命中（不可绕过） */
  kind?: "category" | "safety";
  reason?: string;
}

export interface GateInput {
  tool: ToolShape;
  riskKind: ToolPermission;
  /** 内容级判定的目标（终端=命令本体 / 写=路径 / 网络=URL）；无则为空串 */
  target: string;
  switches: GrantSwitches;
  projectRoot?: string;
}

/** 调用前闸门：每次调用都跑，**实时**读取开关 —— 改设置无需重启。
 *
 *  第 1 层「类别否决」：开关关闭 = 该类工具直接拒绝，模型无法绕过。
 *  第 2 层「硬规则拦截」：越权路径 / 敏感文件 / 受保护源码目录 / 终端黑名单 / 内网地址。
 *      这一层必须挂在**逐调用**的位置，绝不能只挂在审批回调里 ——
 *      否则免审批档位会把安全边界一并免掉。 */
export function gateToolCall(input: GateInput): GateVerdict {
  const { tool, switches } = input;
  const n = tool.name ?? "";

  // ── 第 1 层：类别否决 ──
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
  // 只读工具：仅当「读」类别被关闭时才拦（避免误伤纯检索）
  if (!has("write") && !has("terminal") && !has("network")) {
    return switches.toolRead
      ? { allowed: true }
      : { allowed: false, kind: "category", reason: "「读」类别已关闭" };
  }
  // 触碰到多类能力的工具（如 network+write 的 http_create_app）：任一相关类别关闭即拦 ——
  // 用集合判定而不是"取主导类别"，否则关掉「写」也挡不住一个同时声明了 network 的写工具。
  if (!switches.toolWrite && has("write")) {
    return { allowed: false, kind: "category", reason: "「写」类别已关闭" };
  }
  if (!switches.toolTerminal && has("terminal")) {
    return { allowed: false, kind: "category", reason: "「终端」类别已关闭（ADB shell / 命令执行需开启此项）" };
  }

  // ── 第 2 层：硬规则 ──
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
  /** 工具是否声明了「无副作用可免审批」（见 Tool.autoApprovable） */
  autoApprovable: boolean;
  target: string;
  switches: GrantSwitches;
  projectRoot?: string;
}

/** 调用前分类（审批回调用）：决定要不要弹窗。
 *  顺序 = 硬规则（block）→ 开关放行（auto）→ 内容分级 → autoApprovable 降级。
 *  「开关放行」放在硬规则之后是**本模块最关键的顺序约束**：
 *  开关给的是"免逐次审批"，不是"免安全边界"。 */
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

  // 开关放行：用户明确要求「给就直接给」—— 开启即免逐次审批
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

  // 未声明 autoApprovable 且类别未放行 → 分类器的 auto 一律降级为「需确认」（fail-closed）。
  // 只读类不参与降级：纯读取无副作用，不需要每次审批。
  if (kind !== "read" && r.level === "auto" && !input.autoApprovable) {
    r = {
      level: "confirm",
      reason: `${input.name}（${kind} 类）未声明可自动放行，且对应类别未在设置中放行，需用户确认`,
      matched: "policy-confirm",
    };
  }
  return r;
}
