/**
 * resumeOutcome.ts — 会话切回时「（恢复中…）」态的收尾判定（纯函数，无 React 依赖，vitest 可直测）。
 *
 * 锁死的用户症状：**切换会话后永久停在「恢复中」**（stall），以及回复凭空消失
 * （观感像"被回滚了"）—— 两者都是同一个判定写错的两个面。
 *
 * 为什么必须独立成模块（A-1051）：
 *   这段判定原先内联在 ChatPanel 的 restore 异步块里，含有两个**判据错配**，
 *   而它们都只能通过"读代码 + 真机复现"发现，没有一处会报错：
 *
 *   ① **查询失败被当作"仍活跃"**。`isActive` 是唯一的权威判死来源，但取结果写的是
 *      `const r = await api.chat?.isActive?.(sid).catch(() => null); if (!r || r.active) return;`
 *      —— 方法缺失、IPC 抖动、权限拒绝全被 `.catch(() => null)` 吞成 `null`，与"仍在活跃"
 *      走同一分支**直接 return**：没有重试、没有超时、没有兜底 → loading 永久保持。
 *      A-972 删掉旧「6s 无字 → 整条重发」定时器时的理由是"会误判整条重发"，
 *      但替代方案比被替换者更糟：从**偶尔误判**变成**一次失败即永久卡死**。
 *
 *   ② **结束 loading 被绑在「用户是否点过停止」上**。原条件
 *      `if (streamActiveRef.current && !stoppingRef.current) { …; setLoading(false); }`
 *      —— `stoppingRef` 的语义是"别再自动重连"（见 onError 分支），与"loading 该不该结束"
 *      毫不相干；而它又是**粘性**的：`onDone` 有两条早退路径（流在切走期间结束）只复位了
 *      两个压缩闸门（A-982 当时只盯"压缩失效"这个症状），`stoppingRef` 漏了。
 *      一旦残留 `true`，此后每次切回都跳过 `setLoading(false)` → **永久「恢复中」**。
 *
 *   本模块用**签名**消灭 ②：入参里根本没有"用户是否点过停止"这种东西，
 *   结构上不可能再把它混进判据。①则改为「重试到上限后结束 loading 但保留气泡」——
 *   宁可让用户能继续操作（哪怕流其实还活着，气泡仍在、chunk 到了照样续长），
 *   也不接受永久卡死。
 */

/**
 * `isActive` 查询失败时的重试上限。
 * 取值理由：IPC 抖动/主进程忙是毫秒~百毫秒级现象，3 次 × 700ms 覆盖约 2s 窗口；
 * 再多就会让"流真的已死"的会话多挂几秒空白 loading，得不偿失。
 */
export const RESUME_MAX_ATTEMPTS = 3;

/** 两次重试之间的等待（毫秒）。见 `RESUME_MAX_ATTEMPTS` 的取值理由。 */
export const RESUME_QUERY_RETRY_MS = 700;

/** `isActive` 的查询结果：`{active}` 为有效答复；`null`/`undefined` 表示**查询失败**（非"不活跃"）。 */
export type ResumeQueryResult = { active: boolean } | null | undefined;

/** 占位气泡的处置：`settle` 转结算气泡 / `drop` 移除（无正文可留）/ `keep` 原样等待 chunk 续长。 */
export type ResumeBubbleAction = "settle" | "drop" | "keep";

export interface ResumeOutcome {
  /** 是否结束「恢复中」loading 态（false 只应出现在"确有证据表明流还活着"时）。 */
  endLoading: boolean;
  /** 占位气泡怎么处置。 */
  bubble: ResumeBubbleAction;
  /** 是否应稍后重试查询（仅"查询失败且未达上限"时为 true）。 */
  retry: boolean;
  /**
   * 主进程**权威确认**流已死。调用方据此丢弃 stale 占位气泡（见 restoreDedup 的 `streamConfirmedDead`）。
   * ⚠️ 与 `endLoading` 是**两个不同的判断**：重试耗尽时 endLoading 为 true 但 confirmedDead 仍为 false
   * （我们只是放弃等待证据，并没有拿到"流已死"的证据）。
   */
  confirmedDead: boolean;
}

export interface ResumeOutcomeInput {
  /** `isActive` 查询结果；`null`/`undefined` = 查询失败。 */
  query: ResumeQueryResult;
  /** 本判定**已经**历的失败重试次数（首次调用传 0）。 */
  attempts: number;
  /** 失败重试上限（达到上限即放弃等待，见下方第 4 支）。 */
  maxAttempts: number;
  /** cache 中的在途正文（占位气泡内容源）。 */
  partial: string;
  /** 是否已有错误横幅 —— 错误/截断收尾不建结算气泡（落库文本会追加后缀，会与历史双份）。 */
  hasTailError: boolean;
}

/**
 * 判定「恢复中」态该怎么收尾。
 *
 * 四支（顺序即优先级）：
 *   1. `active === true`        → 流还在跑：保持 loading，气泡等 chunk 续长。
 *   2. `active === false`       → **权威判死**：必须结束 loading（这是用户看到卡死的那条路）。
 *                                 有正文且非错误收尾 → 转结算气泡；否则移除占位气泡。
 *   3. 查询失败且未达上限        → 保持现状 + 请求重试（给瞬时抖动留机会）。
 *   4. 查询失败且已达上限        → **结束 loading，但保留气泡**（bubble=keep）。
 *                                 这是刻意的取舍：没有证据支撑"流还活着"，就不该让用户
 *                                 无限期看着「恢复中」；但也没有证据支撑"流已死"，
 *                                 所以**不删气泡、不改判死标记** —— 万一流真的还活着，
 *                                 后续 chunk 到达照样把气泡续长，不丢内容。
 */
export function decideResumeOutcome(input: ResumeOutcomeInput): ResumeOutcome {
  const partial = (input.partial ?? "").trim();
  const settledOk = partial.length > 0 && !input.hasTailError;

  if (input.query && input.query.active) {
    return { endLoading: false, bubble: "keep", retry: false, confirmedDead: false };
  }
  if (input.query) {
    // 权威判死：结束 loading 与"气泡怎么处置"是同一决定的两半，必须一起生效 ——
    // 只结束 loading 不处置气泡会留下一个永不再更新的空壳，反之则会让 loading 悬着。
    return {
      endLoading: true,
      bubble: settledOk ? "settle" : "drop",
      retry: false,
      confirmedDead: true,
    };
  }
  // 查询失败（null/undefined）—— 绝不当成"不活跃"
  if (input.attempts < input.maxAttempts) {
    return { endLoading: false, bubble: "keep", retry: true, confirmedDead: false };
  }
  return { endLoading: true, bubble: "keep", retry: false, confirmedDead: false };
}
