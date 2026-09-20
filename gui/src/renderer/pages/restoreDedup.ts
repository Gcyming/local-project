/**
 * restoreDedup.ts — 会话切回恢复时的「历史 ↔ 在途气泡」去重纯函数（无 React 依赖，vitest 可直测）。
 *
 * 为什么独立成模块（A-974-R4）：
 *   切走期间流会在后台继续跑（主进程按 sessionId 键控，不取消），跑完即落库。此后再切回来，
 *   历史里已经有**完整**回复，而渲染层的在途快照（占位气泡 liveMsg / 结算气泡 settledMsg）
 *   仍持有**较早或较短**的 cached.partial。二者若同时渲染，用户就会看到
 *   「一条完整 + 一条截断」——这正是用户反复反馈的"切换会话后像被截断了又重新输出一遍"。
 *   旧实现只给 settledMsg 做了去重，且用**精确字符串相等**（任何空白/截断差异都会漏成双份），
 *   liveMsg 则**完全没有去重**。
 *
 * 本模块把该判定收敛为「归一化（去空白）+ 双向包含」，并把流是否已被主进程确认结束
 * （isActive=false）作为幽灵占位气泡的兜底剔除条件。
 */

/** 归一化：抹掉所有空白（换行/空格/全角空格差异在渲染上等价，不应导致去重失败） */
export function normalizeForCompare(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, "");
}

/**
 * 候选文本是否已被历史里的某条回复覆盖（等价 / 互为子串即视为同一条逻辑消息）。
 * 空文本一律视为"未被覆盖"（空内容没有可去重的对象，不能误删活泼的占位气泡）。
 */
export function isCoveredByHistory(candidate: string | undefined | null, historyAssistantTexts: string[]): boolean {
  const c = normalizeForCompare(candidate);
  if (!c) { return false; }
  for (const h of historyAssistantTexts) {
    const n = normalizeForCompare(h);
    if (!n) { continue; }
    if (n === c || n.includes(c) || c.includes(n)) { return true; }
  }
  return false;
}

export interface RestoreDedupInput {
  /** 在途占位气泡内容（进行中流；可能只是"（恢复中…）"占位） */
  liveContent?: string | null;
  /** 结算气泡内容（流已终态、done 已把完整 reply 镜像进快照） */
  settledContent?: string | null;
  /** 历史中所有 assistant 消息正文（原文数组，函数内自行归一化） */
  historyAssistantTexts: string[];
  /** 主进程 isActive 查询结果：true = 已确认该会话没有进行中的流 */
  streamConfirmedDead?: boolean;
}

export interface RestoreDedupResult {
  /** 是否保留在途占位气泡 */
  keepLive: boolean;
  /** 是否保留结算气泡 */
  keepSettled: boolean;
}

/** 恢复时的保留判定（keepLive / keepSettled） */
export function decideRestoreKeep(input: RestoreDedupInput): RestoreDedupResult {
  const live = input.liveContent ?? "";
  const settled = input.settledContent ?? "";
  const keepLive =
    normalizeForCompare(live).length > 0
    && !input.streamConfirmedDead
    && !isCoveredByHistory(live, input.historyAssistantTexts);
  const keepSettled =
    normalizeForCompare(settled).length > 0
    && !isCoveredByHistory(settled, input.historyAssistantTexts);
  return { keepLive, keepSettled };
}
