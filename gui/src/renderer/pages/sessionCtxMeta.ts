/**
 * sessionCtxMeta.ts — 会话级「思考时间线 + 窗口占用」持久化/恢复的**纯函数集**。
 * 零 React 依赖（ChatPanel / RightSidebar 共用，vitest 可直测）：
 *  - 存储：localStorage key `slime_ctxmeta_<agentId>_<sessionId>`，存最近一次输入侧占用 (used)、
 *    权威窗口上限 (cap)、按 assistant 消息序数的交错时间线 (timelineByAssistantIdx)。
 *  - 序数语义：assistant 消息序数从 1 起，单增，与历史 records 中 ai 记录的排列顺序严格同序；
 *    retry（popLast 替换同 turn）后序数不变，仍对齐。
 */

/** 规划项（结构对齐 ChatPanel.TodoPanoramaItem） */
export interface PlanItemLite {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 时间线节点（结构对齐 ChatPanel.TimelineStep，独立类型避免跨组件耦合） */
export interface TimelineStepLite {
  kind: "think" | "tool" | "plan" | "todo";
  text?: string;
  name?: string;
  label?: string;
  detail?: string;
  result?: string;
  /** A-980-R32：kind=plan —— 任务规划全景快照。
   *  必须一起持久化，否则重启后「思考历程里有规划与进度」这条承诺只在当次会话成立：
   *  用户回看历史消息时会发现规划卡凭空消失、只剩一堆工具调用行。 */
  items?: PlanItemLite[];
  /** kind=todo：该项是「开始做」还是「做完了」 */
  state?: "start" | "done";
}

export interface SessionCtxMeta {
  used: number;
  cap: number;
  /** assistant 消息序数（1 起）→ 该条回复的交错时间线 */
  timelineByAssistantIdx: Record<number, TimelineStepLite[]>;
}

export function sessionCtxStorageKey(agentId: string, sessionId: string): string {
  return `slime_ctxmeta_${agentId}_${sessionId}`;
}

export function readSessionCtxMeta(agentId: string, sessionId: string): SessionCtxMeta | null {
  try {
    const raw = localStorage.getItem(sessionCtxStorageKey(agentId, sessionId));
    if (!raw) { return null; }
    const parsed = JSON.parse(raw) as SessionCtxMeta;
    if (typeof parsed !== "object" || parsed === null) { return null; }
    return parsed;
  } catch { return null; }
}

export function writeSessionCtxMeta(agentId: string, sessionId: string, meta: SessionCtxMeta): void {
  try { localStorage.setItem(sessionCtxStorageKey(agentId, sessionId), JSON.stringify(meta)); } catch { /* ignore */ }
}

export function clearSessionCtxMeta(agentId: string, sessionId: string): void {
  try { localStorage.removeItem(sessionCtxStorageKey(agentId, sessionId)); } catch { /* ignore */ }
}

/** 持久化更新助手：读旧 → 合并本次占用快照与序数时间线 → 写回。
 *  @param agentId / sessionId 会话锚点
 *  @param ordinal 本次 commit 的 assistant 序数（1 起）
 *  @param payload 最近一次输入侧占用（>0 覆盖）、权威上限（>0 覆盖）、committed 前快照的时间线
 *  @returns 合并后的 meta（供调用方联调/测试断言） */
export function updateSessionCtxMeta(
  agentId: string,
  sessionId: string,
  ordinal: number,
  payload: { used?: number; cap?: number; timeline?: TimelineStepLite[] },
): SessionCtxMeta {
  const prev = readSessionCtxMeta(agentId, sessionId) ?? { used: 0, cap: 0, timelineByAssistantIdx: {} };
  if (payload.used && payload.used > 0) { prev.used = payload.used; }
  if (payload.cap && payload.cap > 0) { prev.cap = payload.cap; }
  if (payload.timeline && payload.timeline.length > 0 && ordinal > 0) {
    prev.timelineByAssistantIdx[ordinal] = payload.timeline;
  }
  writeSessionCtxMeta(agentId, sessionId, prev);
  return prev;
}

/** 历史记录里 timeline 的**宽松形态**：落盘 JSON 里 `kind` 就是 string（见 shared/ipc.ts 的
 *  `ConversationMessage.timeline`），与 `TimelineStepLite.kind` 的联合类型不同名。
 *  之所以要收下来而不是把入参直接声明成 `TimelineStepLite[]`：那样 `ConversationMessage[]`
 *  会因为 `kind: string` 不可赋值而**编译不过**，于是调用方只能先自行断言——
 *  把"边界断言"推到每个调用点，哪天多一个调用点就多一处漏断言的机会。
 *  收窄只做一次，就在下面 `adoptRecordTimeline`。 */
export interface LooseTimelineStep {
  kind: string;
  text?: string;
  name?: string;
  label?: string;
  detail?: string;
  result?: string;
  items?: PlanItemLite[];
  state?: "start" | "done";
}

/** 磁盘 timeline → 内部 TimelineStepLite。仅收窄 `kind` 的字面量类型，运行期不改数据。 */
function adoptRecordTimeline(tl: readonly LooseTimelineStep[] | undefined): TimelineStepLite[] | undefined {
  if (!tl || tl.length === 0) { return undefined; }
  return tl as unknown as TimelineStepLite[];
}

/** 加载历史消息时按 assistant 序数回填持久化的交错时间线。
 *  返回每条消息应挂载的 stages 骨架：{ timeline?, reasoning?, assistantOrdinal }。
 *  @param msgs 历史加载消息（main 的 conversations.load 结构：role/content/time/reasoning/elapsedMs/timeline…）
 *  @param meta 持久化的会话元数据（无 → 回退到消息自带的 timeline，再退到文本形态）
 *  @param totalLink 需要工具留痕时由调用方补 stages.tools（本函数只给 timeline/reasoning/序数）
 *
 *  ⚠️ A-1021b：**两个来源，缺一不可**。
 *   ① localStorage（`timelineByAssistantIdx`，按 assistant 序数）—— 增量、便宜，但有两条已知失效路径：
 *      序数漂移（失败轮/群聊成员发言/恢复占位都参与计数）与「流式期间切走会话」（写盘被 onDone 的
 *      非当前会话分支早退跳过）。
 *   ② **消息自带的 `timeline`**（A-966 落在 history.jsonl 的同一份数据）—— 与记录同生共死，不受上述
 *      两条路径影响。**此前这一路完全没被读**（写进去了、加载时不看），所以那两条路径一旦命中就必然
 *      丢掉整条时间线，思考历程塌成"一大段无节点文本"。这里补上兜底顺序：localStorage 优先，其次记录自带。 */
export function attachTimelineToHistory(
  msgs: Array<{ role: string; reasoning?: string; content?: string; timeline?: readonly LooseTimelineStep[] }>,
  meta: SessionCtxMeta | null,
): Array<{ timeline?: TimelineStepLite[]; reasoning?: string; assistantOrdinal?: number }> {
  let aiOrd = 0;
  return msgs.map((m) => {
    if (m.role !== "assistant") { return { assistantOrdinal: undefined }; }
    aiOrd += 1;
    const stored = meta?.timelineByAssistantIdx?.[aiOrd];
    const fromMeta = stored && stored.length > 0 ? stored : undefined;
    return {
      timeline: fromMeta ?? adoptRecordTimeline(m.timeline),
      reasoning: m.reasoning,
      assistantOrdinal: aiOrd,
    };
  });
}

/** 会话切换时的 used 复位语义（防残留上一会话）：
 *  有持久化占用 → 恢复；无 → 0（该会话当前无已确认占用，首条回复后重新建立）。 */
export function restoreUsed(meta: SessionCtxMeta | null): number {
  return meta && meta.used > 0 ? meta.used : 0;
}