/**
 * gui/src/renderer/pages/liveStatus.ts — 底部「实时状态行」的文案推导（**纯逻辑**）。
 *
 * ── 要解决的体验 ──
 * Agent 长时间**不输出正文**（在跑工具循环 / 等上游首包 / 等用户审批）时，对话区没有任何东西
 * 在长。用户看到的是"右边活动记录一直在刷新，中间一片安静"，于是认定"卡住了"。
 * 底部那行原来只会说「💭 思考中… / 🔧 调用工具中…」——**没有具体在做什么、也没进度**。
 * 本模块把它换成一句**跟着当前阶段走**的状态（正在调用哪个工具 / 正在输出回复 / 在等谁），
 * 外加可核对的数字（已用时、工具次数、在途 token 估算、上下文占用）。
 *
 * ── 为什么独立成模块 ──
 * 判定顺序（等用户 > 压缩 > 停止 > 输出 > 工具 > 思考 > 等首包）就是这段功能的全部内容，
 * 而且是**用户直接读到的文案**。住在 `.tsx` 里就只能靠肉眼比对；这里可以逐条断言，
 * 特别是两条最容易被改坏的：① 等待用户时必须**不播扫光**（播了就是在骗人说"还在跑"）；
 * ② 优先级顺序被调换（例如把"思考中"提到"调用工具"之前 → 明明在跑工具却显示思考中）。
 * 回归守卫见 `tests/core-ts/a1054-livestatus.spec.ts`。
 *
 * ⚠️ 数据源必须与右栏「活动记录」同源（工具名走 `resolveToolLabel`，由调用方解析后传
 *    `lastToolLabel` 进来）。两边各写一套映射 = 再次出现"同一个工具两种说法"。
 * ⚠️ 本模块**只做文案**，不碰 DOM、不碰 React、不知道图标。图标由组件按 `kind` 选。
 */

/** 状态语义（组件据此选图标；测试据此做行为断言，避免锚死中文文案）。 */
export type LiveStatusKind =
  /** 等用户审批（模型**没有**在推进） */
  | "awaiting-approval"
  /** 等用户回答问题（模型**没有**在推进） */
  | "awaiting-answer"
  /** 上下文压缩（发送前体检触发） */
  | "compress"
  /** 正在停止生成（已发 cancel，等当前阶段收尾） */
  | "stopping"
  /** 正在输出正文 */
  | "writing"
  /** 正在调用工具 */
  | "tool"
  /** 正在思考（有 reasoning 产出但还没有正文） */
  | "thinking"
  /** 请求已发出、上游还没吐第一个字 */
  | "preparing";

export interface LiveStatusInput {
  /** 本会话是否有一轮在跑 */
  loading: boolean;
  /** 已发出停止指令、等收尾 */
  stopping?: boolean;
  /** 有未决的审批请求（用户没点之前，模型确实停着） */
  awaitingApproval?: boolean;
  /** 有未决的提问请求 */
  awaitingAnswer?: boolean;
  /** 上下文压缩过渡态（`compressUi.stage`） */
  compressStage?: "prep" | "summarize" | "done" | "trunc" | null;
  /** 最近一次工具调用的**人类可读名**（调用方用 resolveToolLabel 解析后传入） */
  lastToolLabel?: string;
  /** 本轮已发生的工具调用次数 */
  toolCount?: number;
  /** 在途正文字符数（partial.length） */
  replyChars?: number;
  /** 在途思考字符数（reasoningTmp.length） */
  reasonChars?: number;
  /** 本轮已用时（ms） */
  elapsedMs?: number;
  /** 上下文占用（token）与上限，用于显示百分比进度 */
  ctxUsed?: number;
  ctxCap?: number;
}

export interface LiveStatus {
  kind: LiveStatusKind;
  /** 主文案：这一行**唯一**要读清的东西 */
  text: string;
  /** 次要信息（可空串）：已用时 / 工具次数 / 在途 token / 上下文占比 */
  detail: string;
  /**
   * 是否播扫光。
   * ⚠️ 判据是「模型是否还在自己往前推进」，不是"有没有 loading"——
   *    等用户审批/回答时模型停着，播扫光等于告诉用户"它在干活，再等等"（骗人，且会让人干等）。
   */
  animated: boolean;
}

/** 已用时格式化：<60s 显示 "12s"；否则 "3m04s"。0/负值 → ""（没开始计时就不显示）。 */
export function formatElapsed(ms: number | undefined): string {
  if (!ms || ms <= 0) { return ""; }
  const total = Math.floor(ms / 1000);
  if (total < 60) { return `${total}s`; }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** 字符数 → token 粗估（与右栏 `liveReplyTokens` 同口径：4 字符 ≈ 1 token）。 */
export function estimateTokens(chars: number | undefined): number {
  if (!chars || chars <= 0) { return 0; }
  return Math.round(chars / 4);
}

/** 组装次要信息行。全部为空 → ""（调用方据此不渲染那一段）。 */
export function buildDetail(input: LiveStatusInput): string {
  const parts: string[] = [];
  const elapsed = formatElapsed(input.elapsedMs);
  if (elapsed) { parts.push(`已 ${elapsed}`); }
  if ((input.toolCount ?? 0) > 0) { parts.push(`工具 ${input.toolCount} 次`); }

  const tok = estimateTokens((input.replyChars ?? 0) + (input.reasonChars ?? 0));
  if (tok > 0) { parts.push(`≈${tok} tok`); }

  const used = input.ctxUsed ?? 0;
  const cap = input.ctxCap ?? 0;
  // 上限未知（cap=0）时**不显示百分比**：0%/∞ 这种数字比没有更糟（右栏同一口径）。
  if (cap > 0 && used > 0) { parts.push(`上下文 ${Math.min(99, Math.round((used / cap) * 100))}%`); }

  return parts.join(" · ");
}

/**
 * 推导当前状态行。返回 `null` = **不该显示这一行**（空闲、且没有任何在途阶段）。
 *
 * 优先级顺序（自上而下，先命中先返回）就是这段功能的规格：
 *   等用户（审批/回答）> 压缩 > 停止 > 输出正文 > 工具 > 思考 > 等首包
 *
 * 为什么"等用户"必须最前：此时模型**停着**，任何"正在思考/正在调用工具"都是错的，
 * 而且用户会因此不去点确认（以为它会自己继续）。
 * 为什么"输出正文"排在"工具"之前：两者可以同时为真（上一工具的结果正在被写成正文），
 * 此刻用户真正关心的是"它开始说话了"。
 */
export function deriveLiveStatus(input: LiveStatusInput): LiveStatus | null {
  const detail = buildDetail(input);

  if (input.awaitingApproval) {
    return { kind: "awaiting-approval", text: "等待你审批：Agent 请求执行操作", detail, animated: false };
  }
  if (input.awaitingAnswer) {
    return { kind: "awaiting-answer", text: "等待你回答 Agent 的问题", detail, animated: false };
  }

  const stage = input.compressStage;
  if (stage === "prep") {
    return { kind: "compress", text: "正在整理会话上下文…", detail, animated: true };
  }
  if (stage === "summarize") {
    return { kind: "compress", text: "上下文接近上限，正在生成摘要…", detail, animated: true };
  }
  if (stage === "trunc") {
    return { kind: "compress", text: "摘要不可用，正在保留最近若干轮…", detail, animated: true };
  }
  // stage === "done" 是"已压缩完成"的收尾态（压缩条自己会播完），不算在途阶段 → 继续往下判

  if (input.stopping) {
    return { kind: "stopping", text: "正在停止生成…", detail, animated: true };
  }

  if (!input.loading) { return null; }

  if ((input.replyChars ?? 0) > 0) {
    return { kind: "writing", text: "正在输出回复", detail, animated: true };
  }
  if (input.lastToolLabel) {
    return { kind: "tool", text: `正在调用「${input.lastToolLabel}」`, detail, animated: true };
  }
  if ((input.reasonChars ?? 0) > 0) {
    return { kind: "thinking", text: "思考中", detail, animated: true };
  }
  return { kind: "preparing", text: "已发出请求，等待上游返回…", detail, animated: true };
}
