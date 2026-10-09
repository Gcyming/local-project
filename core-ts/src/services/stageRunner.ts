/**
 * A-1197 · B3（L4c 阶段机）：**执行侧的纯逻辑**（IO 循环在 main 侧 —— 那层能拿到 chatService）。
 *
 * ## 阶段间裁剪的死口径（设计 §4.3 第 3 条）
 * 「只保留上一阶段的**最终文本** + 工具调用摘要，**不**保留完整工具输出」——
 * 否则 4 阶段 = 4 倍 token。本文件把它落成两个函数：
 *   · `clipCarry`  —— 收束段裁剪（硬上限，超长如实截断并标注）；
 *   · `buildStageMessage` —— 每阶段消息 = 目标（截断）+ 上一阶段结论 + 本阶段 prompt。
 * 主循环侧把 `history` **置空**（这是「裁剪」的另一半：不带完整会话历史）。
 *
 * ## 只换「跑什么」，不换「怎么判权限」
 * 工具白名单 / 轮次上限经 `ChatRequest.stageOverride` 透传（见 chat.ts 的注释）；
 * 沙箱 / 硬规则 / 去重 / 预算 / abort 全链路照旧 —— 本文件不碰任何权限判定。
 */
import type { StageDecl } from "../plugin/mode.js";

/** 阶段收束段的裁剪上限（字符）——只留上一阶段的最终文本。 */
export const STAGE_CARRY_MAX = 8000;
/** 任务目标在每阶段消息里的上限（防目标本身超长把上下文撑爆）。 */
export const STAGE_GOAL_MAX = 2000;

export function clipCarry(text: string, max = STAGE_CARRY_MAX): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…（已截断：阶段结论超过 ${max} 字符，只保留前段）`;
}

/** 组每阶段的消息文本（目标 + 上一阶段结论 + 本阶段 prompt；三者都可读地分区）。 */
export function buildStageMessage(input: {
  goal: string;
  carried?: string;
  stage: StageDecl;
  index: number;
  total: number;
}): string {
  const goal = clipCarry(input.goal, STAGE_GOAL_MAX);
  const carried = clipCarry(input.carried ?? "");
  const title = input.stage.title ?? input.stage.id;
  const parts: string[] = [];
  parts.push(`【任务目标】${goal}`);
  if (carried) {
    parts.push(`【上一阶段结论】\n${carried}`);
  }
  parts.push(`【当前阶段（第 ${input.index}/${input.total} 步）：${title}】\n${input.stage.prompt}`);
  return parts.join("\n\n");
}

/** 阶段进度文案（notice 事件用；UI 靠它显示「第 n / N 步」）。 */
export function stageProgressText(title: string, index: number, total: number): string {
  return `▶ 阶段 ${index}/${total}：${title}`;
}
