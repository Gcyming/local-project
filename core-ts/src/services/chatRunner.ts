/**
 * A-1197 · B3（L4c）：「谁来跑这个会话」从写死的 `if` 提升为**一层可注册的运行器**。
 *
 * ## 为什么不是造第三套引擎（设计 §4.3 的原话）
 * slime 已经有「非 ToolLoop 的第二种运行范式」（brainstorm 走 `streamGroupTalkFlow`）——
 * 只是它写死在代码里、不由用户定义。L4c 的正确做法是**加分派分支**，不是 fork：
 *   · `agent-loop`：默认实现（ToolLoop），**一行不改**；
 *   · `brainstorm`：既有第二范式（注册进来，行为不变）；
 *   · `mode:<插件>`：插件 `provides: ["mode"]` 声明的**纯用户定义阶段清单**（第三种分派）。
 *
 * ## 优先级（设计 §4.3 的硬口径）
 * **显式 mode 会话 > brainstorm > agent-loop**。mode 是**会话级**的（随会话创建/切换选定）⇒
 * 新请求立即生效，不需重启（与 `loop_config` 同口径：都在请求组装时读）。
 *
 * ## 回落不静默
 * 显式 mode 的扩展被禁用/卸载 ⇒ 回落到 `agent-loop`，**并带回原因**——调用方必须把
 * 「扩展已停用，回落到默认模式」写进对话（设计兜底表：「不静默换模式」）。
 */

export interface ChatRunner {
  kind: string;
  /** 展示名（会话头 / 模式下拉显示；缺省用 kind）。 */
  title?: string;
}

/** 内置运行器的展示名（插件 mode 的展示名来自其声明 `title`）。 */
export const RUNNER_LABELS: Record<string, string> = {
  "agent-loop": "模型 + 工具",
  brainstorm: "多成员协作",
};

export interface ResolveRunnerInput {
  /** 会话 meta 上的显式运行模式 key（来自插件 mode 声明；形如 `my-pipeline`）。 */
  sessionMode?: string | null;
  /** 会话是否是 brainstorm 型（既有第二范式）。 */
  isBrainstorm?: boolean;
  /** 该 mode 当前是否可用（插件 `status === "loaded"`）——**禁用/卸载的插件不出现在下拉**，
   *  解析时再查一次同一份状态（不做第二套）。 */
  isModeAvailable?: (modeKey: string) => boolean;
}

export interface ResolvedRunner {
  kind: string;
  reason: string;
  /** 是否因「显式模式不可用」而回落（调用方据此把原因写进对话——不静默）。 */
  fellBack: boolean;
}

export function resolveRunnerKind(input: ResolveRunnerInput): ResolvedRunner {
  const m = (input.sessionMode ?? "").trim();
  if (m) {
    if (input.isModeAvailable && !input.isModeAvailable(m)) {
      return {
        kind: "agent-loop",
        reason: `显式运行模式「${m}」当前不可用（扩展未装载/被禁用），已回落到默认模式`,
        fellBack: true,
      };
    }
    return { kind: `mode:${m}`, reason: `显式运行模式 ${m}`, fellBack: false };
  }
  if (input.isBrainstorm) {
    return { kind: "brainstorm", reason: "会话为多成员协作型", fellBack: false };
  }
  return { kind: "agent-loop", reason: "默认：模型 + 工具", fellBack: false };
}

/** 运行器展示名（下拉/会话头用；未知 kind 如实回原串，不编造）。 */
export function runnerLabel(kind: string, modeTitle?: string): string {
  if (kind.startsWith("mode:")) {
    return modeTitle ?? kind.slice("mode:".length);
  }
  return RUNNER_LABELS[kind] ?? kind;
}
