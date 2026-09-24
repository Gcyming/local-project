/**
 * core-ts/src/llm/upstreamNotice.ts — 「上游正在重试 / 正在切模型」的**如实上报**（A-1061④）。
 *
 * ## 它修的是什么
 *
 * 用户原话：「现在经常出现 agent 什么都没有，自己加载半天才输出，你给我优化一下」。
 *
 * 取证结论（不是猜）：本项目在**上游失败时是静默重试**的 ——
 *   · `client.ts` 的 429 退避表 `RETRY_429_BACKOFF = [5, 15, 30, 60]`（累计最长 ≈110 秒）；
 *   · 瞬时错误另走 1/3/7 秒级退避；
 *   · `router.recordFallback` 还会**静默换一个备用模型**。
 * 整个过程界面只有一句「已发出请求，等待上游返回…」—— 用户看到的正是"什么都没有、加载半天"。
 *
 * 权威做法（对齐 Claude Code 的状态栏）：它把这类情况**如实显示**出来 ——
 * `API error · Retrying in Xs · attempt N/10`、`Rate limited · Retrying in Xs`。
 * 用户由此知道"不是卡死，是在等上游"，也能据此决定要不要换模型。
 *
 * ## 设计（单槽 + 取走即清）
 *
 * 这份通知是**瞬时状态**，不是队列：同一时刻只可能有"当前正在等什么"这一件事。
 * 因此用**单槽**而不是列表 —— 槽里永远只放最新一条，被消费（`takeUpstreamNotice`）即清空。
 * `at` 时间戳随通知一起带上：引擎据此丢弃"上一次请求遗留的陈旧通知"，
 * 避免并发会话/上一次请求的残留串到这一次的状态行上。
 *
 * ⚠️ 纯内存、不碰 IPC、不碰 React —— 可单测可变异。装配层只负责"推进去"与"取出来"。
 */

export interface UpstreamNotice {
  kind: "retry" | "fallback" | "prefill";
  /** 可直接展示的一句话（文案唯一出处在本文件的 format* 函数） */
  text: string;
  /** 写入时刻（ms）。消费方据此判断是否属于本次请求 */
  at: number;
}

let slot: UpstreamNotice | null = null;

/** 上游状态码 → 人话（429 单独说清是限流，其余按 HTTP 码如实报）。 */
export function describeUpstreamStatus(status: number | undefined): string {
  if (status === 429) { return "被限流（429）"; }
  if (typeof status === "number" && status > 0) { return `HTTP ${status}`; }
  return "网络抖动";
}

/**
 * 重试通知文案。`waitMs` 四舍五入到秒（如实告诉用户还要等多久）。
 *
 * ⚠️ `attempt` 是**从 0 开始**的循环下标，展示时 +1 —— 用户看到的必须是"第几次"，
 *    不是程序员的下标（差一是最容易被当成"重试次数不对"的缺陷）。
 */
export function formatRetryNotice(info: { attempt: number; maxAttempts: number; waitMs: number; status?: number }): string {
  const secs = Math.max(1, Math.round(info.waitMs / 1000));
  const nth = Math.min(info.attempt + 1, info.maxAttempts);
  return `上游${describeUpstreamStatus(info.status)}，${secs}s 后重试（第 ${nth}/${info.maxAttempts} 次）`;
}

/** 切换备用模型的通知文案（模型名直接给用户看，便于他自己判断该不该换回来）。 */
export function formatFallbackNotice(from: string, to: string): string {
  const f = (from || "").trim() || "当前模型";
  const t = (to || "").trim();
  return t ? `主模型不可用，已切换备用模型：${f} → ${t}` : `主模型不可用，已切换备用模型（原：${f}）`;
}

/**
 * A-1088：**首包长静默**的上报文案（大 prompt 冷缓存时，prefill 期间一个字节都不来）。
 *
 * 为什么必须说：用户取证里 29 条失败**全是 user-aborted**、无一上游错误 ——
 * 即「不是超时杀的，是人等不下去自己按了停止」。只把超时放宽而**不告诉他在等什么**，
 * 只会把「等 5 分钟然后失败」变成「等 15 分钟然后失败」。
 *
 * 文案要把三件事说全：**在干什么**（预填充）、**大概多大**（≈N tokens）、**最多等多久**（上限 M）。
 * 有这三个数，用户才能判断"该继续等"还是"该换模型/停掉"。
 */
export function formatPrefillNotice(inputTokens: number, budgetMs: number): string {
  const k = Math.max(1, Math.round(inputTokens / 1000));
  const totalS = Math.max(1, Math.round(budgetMs / 1000));
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  const human = m > 0 ? `${m} 分${s > 0 ? ` ${s} 秒` : ""}` : `${s} 秒`;
  return `上游正在预填充 ≈${k}K tokens（冷缓存时较慢，此阶段不产生任何输出），首包最多等 ${human}`;
}

/** 记一条通知（覆盖槽里旧的 —— 瞬时状态只保留最新）。 */
export function noteUpstream(kind: UpstreamNotice["kind"], text: string): void {
  const t = (text ?? "").trim();
  if (!t) { return; }
  slot = { kind, text: t, at: Date.now() };
}

/** 取走并清空（消费方：引擎的流式轮询循环）。没有 → null。 */
export function takeUpstreamNotice(): UpstreamNotice | null {
  const v = slot;
  slot = null;
  return v;
}

/** 只读一眼（不清空；供测试与诊断）。 */
export function peekUpstreamNotice(): UpstreamNotice | null {
  return slot;
}

/** 仅供测试：清空单槽（进程内单例，测试之间必须隔离）。 */
export function resetUpstreamNoticeForTest(): void {
  slot = null;
}
