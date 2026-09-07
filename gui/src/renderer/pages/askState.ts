/**
 * gui/src/renderer/pages/askState.ts — ask_user 决策分叉窗口的纯状态逻辑（F 批次单测载体）。
 * 从 ChatPanel 弹窗 JSX 中抽取的原子决策语义，生产与测试同源，防"测试未接生产"偏差：
 * - buildAskDecision：选项/自定义/跳过 → AskUserDecision（保留既有「跳过=未填写」语义）
 * - initialAskSelection：有选项默认选第一个，无选项进自定义
 * - canSubmitAsk：与 ChatPanel 提交按钮 disabled 判定一致
 * - safeRecommendation：模型自评推荐下标钳制到合法范围（越界不渲染，UI 不崩）
 */
import type { AskUserDecision } from "../../shared/ipc.js";

/** 选项选择 → 决策（choice="__custom" 时取自定义文本；空文本兜底「（未填写）」） */
export function buildAskDecision(requestId: string, choice: string, custom?: string): AskUserDecision {
  const text = choice === "__custom" ? (custom ?? "").trim() : choice;
  return { requestId, answer: text || "（未填写）", skipped: false };
}

/** 初始选中项：有选项默认第一个，空选项进自定义输入 */
export function initialAskSelection(options: string[]): string {
  return options.length > 0 ? options[0] : "__custom";
}

/** 提交可用性：提交中不可点；自定义模式且文本为空不可点 */
export function canSubmitAsk(submitting: boolean, selected: string, custom: string): boolean {
  if (submitting) { return false; }
  return !(selected === "__custom" && !custom.trim());
}

/** 推荐下标钳制：undefined/越界/非整数 → undefined（UI 不标注推荐，不崩溃） */
export function safeRecommendation(
  options: string[],
  recommendation: number | undefined,
): number | undefined {
  if (recommendation === undefined || options.length === 0) { return undefined; }
  if (Number.isInteger(recommendation) && recommendation >= 0 && recommendation < options.length) {
    return recommendation;
  }
  return undefined;
}

/** 后果说明读取：缺省/越界 → undefined（JSX 用 ?. 安全处之） */
export function consequenceAt(consequences: string[] | undefined, index: number): string | undefined {
  return Array.isArray(consequences) ? consequences[index] : undefined;
}