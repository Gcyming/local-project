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
  kind: "think" | "body" | "tool" | "plan" | "todo" | "steer";
  /**
   * A-1095 #8′：kind=body —— 该阶段的**正文片段**（Markdown），即「思考历程里穿插的正文」。
   * 必须一起持久化：否则重启后回看历史，思考历程里的正文整段消失、只剩思考与工具
   * （与 `items` 不能丢是同一个理由 —— 当次会话成立、回看就没了，用户会认为功能不存在）。
   */
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
  /**
   * A-1061②′：kind=tool —— 这一调用**正在执行**（`tool-start` 已到、结果还没到）。
   * 用户原话：「我希望是直接在思考历程的卡片中显示……在运行期间就显示“执行中”“运行中”之类的，
   * 成功了就实时反馈出来」。思考历程的工具卡是用户真正盯着看的地方，
   * 只在"工具调用摘要"那一小行显示实时状态是不够的。
   * ⚠️ A-1068 更正：这里原先写着「持久化时它必然已是 false/缺省」—— **那是错的**。
   *   本字段确实会被落盘，而落盘发生在流式过程中，所以进程在工具执行途中消失时会
   *   留下 `running: true`。回看历史（`attachTimelineToHistory`）必须过一遍
   *   `settleRunning` 把它清掉，否则那张卡会永久显示「执行中」。
   */
  running?: boolean;
}

export interface SessionCtxMeta {
  used: number;
  cap: number;
  /**
   * A-1089：`cap` 是**哪个模型**测出来的（`modelChoice` 原样，缺省归一为 `"inherit"`）。
   *
   * ⚠️ 没有这个字段时，`cap` 会被当成"这条会话的上限"永久沿用 ——
   * 用户切到别的模型后环/右栏仍按**旧模型**的窗口显示（实测：切了模型，上限还停在 65K），
   * 而 `cap` 又是压缩阈值（`maybeAutoCompress`）与首包预算量级的输入 ⇒ 判据一起失真。
   * 上限是**模型属性**，不是会话属性 —— 会话只负责记住"上次测的是谁"。
   */
  capModel?: string;
  /** assistant 消息序数（1 起）→ 该条回复的交错时间线 */
  timelineByAssistantIdx: Record<number, TimelineStepLite[]>;
}

/** `modelChoice` 的归一形态：空/缺省一律按 `"inherit"`（Agent 自选模型）。
 *  两侧（写入时 / 读取时）都必须过它，否则 `undefined` 与 `"inherit"` 会被判成"换了模型"，
 *  于是每次切会话都重算一遍上限 —— 那会把 A-934「重启后权威上限可恢复」的收益抹掉。 */
export function normalizeCapModel(modelChoice: string | undefined | null): string {
  const s = typeof modelChoice === "string" ? modelChoice.trim() : "";
  return s || "inherit";
}

/**
 * 取「**属于当前所选模型**的持久化上限」——模型对不上就返回 0（调用方据此按当前模型重算）。
 *
 * 纯函数（可穷举）。这是 A-1089 的核心判据：把"上限该不该沿用持久化值"从
 * 内联的 `meta?.cap ?? 0` 收口到一处，避免渲染层两个读取点各写一份。
 */
export function capForModel(meta: SessionCtxMeta | null | undefined, modelChoice: string | undefined | null): number {
  if (!meta || !(meta.cap > 0)) { return 0; }
  return normalizeCapModel(meta.capModel) === normalizeCapModel(modelChoice) ? meta.cap : 0;
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
  payload: { used?: number; cap?: number; capModel?: string; timeline?: TimelineStepLite[] },
): SessionCtxMeta {
  const prev = readSessionCtxMeta(agentId, sessionId) ?? { used: 0, cap: 0, timelineByAssistantIdx: {} };
  if (payload.used && payload.used > 0) { prev.used = payload.used; }
  if (payload.cap && payload.cap > 0) {
    prev.cap = payload.cap;
    /* A-1089：上限必须与「测它的那个模型」一起落盘 —— 只写 cap 不写 capModel，
       下次读回来就无从判断它是否还适用于当前所选模型（那正是「上限不跟随模型」的根因）。 */
    prev.capModel = normalizeCapModel(payload.capModel);
  }
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
  /** A-1068：`running` **确实会落在盘上**（见 `TimelineStepLite.running` 的更正说明），
   *  所以宽松形态必须认它 —— 否则读回时类型上"没有这个字段"，而运行期它就在那里，
   *  `settleRunning` 的判断会被类型系统当成永远不成立（TS 无法从这个形状推出来）。 */
  running?: boolean;
}

/** 磁盘 timeline → 内部 TimelineStepLite。仅收窄 `kind` 的字面量类型，运行期不改数据。 */
function adoptRecordTimeline(tl: readonly LooseTimelineStep[] | undefined): TimelineStepLite[] | undefined {
  if (!tl || tl.length === 0) { return undefined; }
  return tl as unknown as TimelineStepLite[];
}

/**
 * A-1068：把落盘时间线里**粘住的** `running` 清掉（回看历史时"没有任何调用在跑"）。
 *
 * 为什么必须有这一步 —— 上一条注释里那句"持久化时它必然已是 false/缺省"是**假设，不是保证**：
 * `running` 是跟着 localStorage 落盘的普通字段，而落盘发生在**流式过程中**（增量写）。
 * 于是只要进程在"工具执行中"这一刻消失（崩溃 / 被结束 / 用户关窗），磁盘上最后一份时间线
 * 就留下 `running: true`。下次打开这条会话：那张卡**永久**显示「执行中」+ 扫光动画
 * —— 一个没有任何东西在跑的假状态。
 *
 * 这与本仓已有的取舍直接冲突（见 ChatPanel 的配对收尾注释：「宁可提前收起，也不留一行
 * 永远停在"执行中"的假状态 —— 那比没显示更糟，用户会以为它卡住了」）。
 * 而且 `running` 的**唯一合法产地**是运行期事件（`tool-start` 到达、结果未到）——
 * 从磁盘读回来的数据**不可能**处于这个状态，所以清掉它无损任何合法信息。
 *
 * ⚠️ 只在**收编/回看**这一步做（本函数），绝不在渲染层做 —— 那样会把运行期真正在执行中的
 *   卡片也一起抹平，「实时状态」当场失效。
 */
export function settleRunning(steps: readonly TimelineStepLite[] | undefined): TimelineStepLite[] | undefined {
  if (!steps || steps.length === 0) { return steps as TimelineStepLite[] | undefined; }
  if (!steps.some((s) => s.running)) { return steps as TimelineStepLite[]; }
  return steps.map((s) => (s.running ? { ...s, running: false } : s));
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
      /* ⚠️ A-1068：`settleRunning` 必须包在**两个来源之外**（这里是唯一收口）。
         只包其中一路（例如只包磁盘那一路）会漏掉另一路，而两路都会带着粘住的 running：
         `fromMeta` 来自 localStorage、`adoptRecordTimeline(m.timeline)` 来自消息记录 —— 两者
         都是"上一次运行留下的字节"。判据要落在"回看历史"这个语义上，而不是落在某个数据源上。 */
      timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),
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