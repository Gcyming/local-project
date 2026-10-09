













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

/** A-1197：把「沙箱/策略拒绝」的原因翻成模型能直接照做的说明。
 *
 * 缺陷现场（用户实测）：聊天里反复出现同一句「被拒绝」。原因是模型拿到的是
 * **面向审计**的短句（受保护源码目录禁止写入 / 敏感文件禁止写入），既不知道为什么、
 * 也不知道该怎么办，只能原样重试 —— 一轮对话里同一条拒绝能刷三遍。
 * 这里做两件事：① 说清「这是硬规则还是可审批」② 给出下一步该做什么。
 */
export interface DenialAdvice {
  /** true = 硬规则/黑名单：任何权限开关与审批档位都放行不了，重试同一目标只会再被拒一次 */
  hard: boolean;
  /** 给模型的补救指引（会原样进工具结果，务必是可执行的动作） */
  advice: string;
}

export function explainDenial(reason: string): DenialAdvice {
  const r = String(reason ?? "").trim();
  if (/受保护源码目录禁止写入/.test(r)) {
    return {
      hard: true,
      advice:
        "这是 slime 的硬规则（保护 slime 自身源码与关键数据），「设置 → 权限」里任何开关都放行不了，"
        + "用户也批准不了 —— **不要换个写法重试同一个目标**。请改为写到会话工作目录内的路径；"
        + "若你要落的是技能或插件，就写进上面导引给出的数据目录（skill/插件根），其它位置一律不适用。",
    };
  }
  if (/敏感文件\/目录禁止写入/.test(r)) {
    return {
      hard: true,
      advice:
        "写入在执行层就被拦下了：目标命中 slime 的敏感文件/受保护目录黑名单，这是硬规则，"
        + "「设置 → 权限」里任何开关与审批档位都放行不了。"
        + "**不要换个写法重试同一个目标**（改大小写、加 ./、换绝对路径或换工具一律同样被拒）。"
        + "请改为写到会话工作目录内的路径；若要落的是自己的插件/技能，写进 config/skills 或 "
        + "config/plugins 下**你自己新建**的目录（内置插件目录是保留资产，永不放行）。",
    };
  }
  if (/敏感文件禁止写入/.test(r)) {
    return {
      hard: true,
      advice:
        "该文件名/后缀在 slime 的敏感清单里（凭据、主配置、审计日志等），写操作一律阻断且不可审批。"
        + "**不要改文件名大小写或路径写法绕望去撞同一个文件**；确实需要改配置就明确告诉用户由他去改。",
    };
  }
  if (/\[分类器预检拦截\]/.test(r)) {
    return {
      hard: true,
      advice:
        "用户侧的写入预检已判定为硬阻断（命中硬规则），重试同一目标只会再被拒一次。"
        + "先看清上面的具体原因再换做法；如果不确定该写到哪，先用只读工具确认目录结构再动手。",
    };
  }
  if (/超出工作目录范围/.test(r)) {
    return {
      hard: false,
      advice:
        "目标在会话当前绑定的工作目录之外。两条正路：① 把产出写在工作目录内；"
        + "② 明确告诉用户需要访问的绝对路径，请他把会话工作目录切到那里（或在项目设置里改绑定）后再继续。"
        + "不要反复用绝对路径重试。",
    };
  }
  if (/\(\s*L\d\s*\)\s*被禁止|的工具/.test(r) || /\) 被禁止/.test(r)) {
    return {
      hard: false,
      advice:
        "该工具或该权限等级在当前权限配置里被禁用。请告诉用户到「设置 → 权限 → 工具权限类别/审批档位」开启后继续，"
        + "**不要改用别的高危工具或让用户手敲命令来绕开**。",
    };
  }
  if (/需要用户确认/.test(r) || /超时（未收到用户决策）/.test(r)) {
    return {
      hard: false,
      advice:
        "该动作需要用户当面批准（弹窗可能超时或未答复）。请向用户说明你要做的一步是什么、"
        + "为什么要做，等他批准后再调用一次；不要用功能等价的其它工具偷偷绕过。",
    };
  }
  return {
    hard: false,
    advice: "该操作未获授权。请向用户说明被拒的原因与你想达成的目的，并尝试其它方案；不要反复重试同一个调用。",
  };
}

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
