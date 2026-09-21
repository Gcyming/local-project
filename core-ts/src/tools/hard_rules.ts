/**
 * core-ts/src/tools/hard_rules.ts — **不可绕过的硬规则**唯一实现（内容级安全判定）。
 *
 * 【为什么必须独立成模块、且被闸门调用】
 * 这套规则原本只住在 `gui/src/main/index.ts` 的 `classifyPermissions` 里，而它只在
 * **沙箱决定要问用户**（approvalPath）时才被调用。于是出现一个结构性漏洞：
 *   `globalApproval=auto` → sandbox `auto_approve_levels=[0..5]` → 直接放行 →
 *   审批回调根本不执行 → **受保护源码目录 / 敏感文件 / 越权路径 / 终端黑名单全部没跑**。
 * 也就是"免审批档位顺手把安全边界也免掉了"。对一个 Agent 能写自己护栏目录的应用，
 * 这是比"多问几次"严重得多的缺陷。
 *
 * 现在两份调用者共用本模块：
 *   ① `registry.callTool` 注入的闸门（装配层）——**每次调用都跑**，不受审批档位影响；
 *   ② 审批回调 —— 决定要不要弹窗时的同一批评据。
 * 一处实现、两处调用 ⇒ 不存在"闸门放过了但回调拦住了"或反之的漂移。
 *
 * 【与开关的关系】硬规则**不随开关降级**：开关开启只免除逐次审批，不解锁这些边界。
 */
import { assessAction, splitCommand, isProtectedSourcePath } from "./classifier.js";
import { PROJECT_ROOT } from "../paths.js";
import type { ToolPermission } from "./registry.js";

export interface HardRuleInput {
  /** 工具名（仅用于文案，不参与判据——判据只认 riskKind + target，杜绝"按名字猜"） */
  name: string;
  /** 工具自述的动作本质（Tool.effectiveRiskKind()） */
  riskKind: ToolPermission;
  /** 动作目标：写入路径 / 终端命令 / 目标 URL；其余工具为空串 */
  target: string;
  /** 受保护源码目录的锚定根（缺省 PROJECT_ROOT；测试可注入，避免误伤真实仓库） */
  projectRoot?: string;
}

export interface HardRuleVerdict {
  /** true = 命中硬规则，必须拒绝（任何审批档位/任何开关都不可放行） */
  blocked: boolean;
  reason: string;
  matched: string;
}

const OK: HardRuleVerdict = { blocked: false, reason: "", matched: "" };

/** 硬规则判定（纯函数，零副作用，可单测）。 */
export function hardRuleCheck(input: HardRuleInput): HardRuleVerdict {
  const target = (input.target ?? "").trim();
  const kind = input.riskKind;

  if (kind === "read") { return { ...OK, reason: "只读动作不受硬规则限制", matched: "read" }; }
  // 无目标（如纯参数类工具）→ 无内容可判；不因此放行，交给审批档位与类别闸门
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
    // 引擎源码/契约/宿主目录写入一律拦（防 Agent 自我改写护栏）：仅锚定 root 内，不误伤用户工作区
    if (isProtectedSourcePath(target, input.projectRoot ?? PROJECT_ROOT)) {
      return { blocked: true, reason: `受保护源码目录禁止写入：${target.slice(0, 60)}`, matched: "protected-dir" };
    }
    return { ...OK, reason: r.reason, matched: r.matched };
  }

  // network
  const r = assessAction({ kind: "network", url: target });
  return r.level === "block"
    ? { blocked: true, reason: r.reason, matched: r.matched }
    : { ...OK, reason: r.reason, matched: r.matched };
}

/** 从工具实参里取出「动作目标」——**闸门 / 沙箱 / 分类器必须共用同一口径**，
 *  否则同一调用在三处被喂不同的字符串，边界就会从缝里漏掉。
 *  取值顺序：url → path → file → target（路径/网络类）→ command → cmd（终端类）。
 *
 *  ⚠ 终端类必须取到**命令本体**：`adb_shell` 的参数字段是 `command`。此前三处都只认
 *  url/path/file/target，于是 adb_shell 的 target 一路退化成 `JSON.stringify(args)`
 *  （形如 `{"serial":"…","command":"pm list packages"}`），分类器拿它 `splitCommand`
 *  得到的"命令"是整个 JSON 串 —— 既不匹配只读白名单、也不可能匹配黑名单，
 *  每条 ADB 命令都被判成「未知命令 → 需确认」，这正是"每次都要找我要这要那"的机械成因。 */
export function targetFromArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") { return ""; }
  for (const k of ["url", "path", "file", "target", "command", "cmd"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) { return v.trim(); }
  }
  return "";
}
