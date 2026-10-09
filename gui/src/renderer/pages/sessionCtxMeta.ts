









export interface PlanItemLite {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}


export interface TimelineStepLite {
  kind: "think" | "body" | "tool" | "plan" | "todo" | "steer";
  




  text?: string;
  name?: string;
  label?: string;
  detail?: string;
  result?: string;
  


  items?: PlanItemLite[];
  
  state?: "start" | "done";
  



  /**
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
  







  capModel?: string;
  
  timelineByAssistantIdx: Record<number, TimelineStepLite[]>;
  /**
   * A-1197：**回复指纹 → 时间线**（真正的主键；序数只是遗留兜底）。
   *
   *  为什么必须有它：序数是「按位置数出来的」，而写序数的那一端**不是每轮都写**——
   *  「切走会话期间在后台结束」的那一轮走`onDone` 的后台早退分支（它必须早退：
   *  面板不在场，不能碰当前会话的 UI 状态），那条路径**不自增序数**。
   *  于是写侧序数里出现**空洞**，而读侧 `attachTimelineToHistory` 是把历史里的 assistant
   *  消息从头数到尾（`aiOrd += 1`）——两边数的东西不是一回事，空洞之后**整体错位一格**：
   *  此后每一条回复的思考历程都会挂到**前一轮**的卡片上，而它自己那条是空的
   *  （这正是用户报的「抢占下一个对话的思考历程」）。
   *
   *  语义：
   *  · 键 = 回复正文的**归一化指纹**（去空白 + 剥收尾标记 + 取前缀），
   *    读侧拿历史消息正文算同一个指纹来取 ⇒ **与位置无关，天然免疫空洞**。
   *  · 值是**数组**：同一段回复文本可能出现多次（如「好的」），按写入顺序入队、
   *    按读取顺序出队，重复文本也能一一对上。
   *  · 写侧无需序数也能落盘（后台分支正是如此）—— 这是它能替代序数的关键。
   */
  timelineByReplyKey?: Record<string, TimelineStepLite[][]>;
  /**
   * A-1197：**回复指纹 → 思考原文**（与 `timelineByReplyKey` 同键，同队列语义）。
   *
   *  为什么连思考原文也要走指纹通道：`history.jsonl` 那条路只在「done 正常走完」时
   *  才带上 reasoning（chat.ts 的 `recordInteraction(..., reasoningBuf || undefined, ...)`）。
   *  一旦那条记录因为任何原因没落上思考（上游没给、截断、错误收尾），切回/重载时就只剩
   *  一个空思考区—— 而 localStorage 这条通道是**按回复定位**的，不依赖那条记录。
   */
  reasoningByReplyKey?: Record<string, string[]>;
}

/**
 * A-1197：回复正文的**归一化指纹**（写读两侧必须算出同一个值，否则会静默退化成「没命中」）。
 *
 *  两侧拿到的正文不完全一样，差在**收尾标记**与**思考标签**上：
 *  · 渲染层 `onDone` 的 `reply` 可能还带着 `<thinking>…</thinking>`（写侧用 cleanReply 剥过）；
 *  · 落库侧 `history.jsonl` 的 `ai` 可能被追加 `\n[截断]`，渲染层又会追加
 *    `\n\n> ⏹ 已中断（停止生成）`。
 *  这些都是**尾部**标记，所以：先剥掉已知标记，再**只取前缀**。
 *  取前缀而非全量，是因为追加只发生在尾部 —— 前缀天然对尾部追加免疫。
 *
 * ⚠️ 指纹算错的后果是**静默退化成「没命中」**（＝退回序数＝原bug），所以宁可多剥。
 */
export function replyFingerprint(reply: string | null | undefined): string {
  const s = typeof reply === "string" ? reply : "";
  if (!s) { return ""; }
  /*
 * 尾部标记一律用「截断」而不是「替换」** —— 标记本身带前缀符号（`> ⏹ 已中断（停止生成）`），
 * 符号与标记之间还有空格，用正则「替换掉标记」必然漏掉符号（实测漏成 `答案>⏹`）。
 * 而这些标记**只会出现在尾部**，所以从标记处截断既简单又必然正确。
 */
  const rawHead = s.split(/已中断（停止生成）/)[0].split(/截断/)[0];
  /*
 * 切标记会留下**孤立的前缀符号**（`答案\n[截断]` → `答案\n[`；`答案\n\n> ⏹ 已中断…` → `答案\n\n> ⏹`）。
 * 只有「真的切过」才去收拾这些残尾 —— 否则会误伤正文本来就以 `>` 开头的正常回复。
 * 收尾用`[\s…\]]+$`（**含 `[`**）：`[截断]` 的`[` 落在换行**之后**，不在字符串末尾。
 */
  const head = rawHead === s ? rawHead : rawHead.replace(/[\s>▶⏹⏸(（【\]\[]+$/, "");
  return head
    .replace(/<(thinking|thought|reasoning|reason)>[\s\S]*?<\/\1>/gi, "")
    .replace(/\s+/g, "")
    .slice(0, 120);
}




export function normalizeCapModel(modelChoice: string | undefined | null): string {
  const s = typeof modelChoice === "string" ? modelChoice.trim() : "";
  return s || "inherit";
}







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
  try { localStorage.setItem(sessionCtxStorageKey(agentId, sessionId), JSON.stringify(meta)); } catch {  }
}

export function clearSessionCtxMeta(agentId: string, sessionId: string): void {
  try { localStorage.removeItem(sessionCtxStorageKey(agentId, sessionId)); } catch {  }
}






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
    

    prev.capModel = normalizeCapModel(payload.capModel);
  }
  if (payload.timeline && payload.timeline.length > 0 && ordinal > 0) {
    prev.timelineByAssistantIdx[ordinal] = payload.timeline;
  }
  writeSessionCtxMeta(agentId, sessionId, prev);
  return prev;
}

/**
 * A-1197：按**回复指纹**落盘一条回复的时间线（序数无关）。
 *
 *  为什么必须与 `updateSessionCtxMeta` 并存而不是替换它：
 *  · 序数通道要 `ordinal > 0`，而后台分支（切走期间结束）**拿不到序数**——它必须早退，
 *    不能去猜「本会话此刻是第几轮」，猜错就是把思考挂到别人的卡片上（比不挂更糟）。
 *  · 指纹通道只需要正文，天然与位置无关。
 *  两条通道都写、读侧指纹优先 ⇒ 老数据（只有序数）继续按序数读，行为不回退。
 */
export function writeTurnTimeline(
  agentId: string,
  sessionId: string,
  reply: string | null | undefined,
  timeline: TimelineStepLite[],
  reasoning?: string,
): SessionCtxMeta {
  const prev = readSessionCtxMeta(agentId, sessionId) ?? { used: 0, cap: 0, timelineByAssistantIdx: {} };
  const key = replyFingerprint(reply);
  if (key && timeline.length > 0) {
    const store = prev.timelineByReplyKey ?? (prev.timelineByReplyKey = {});
    const q = store[key] ?? (store[key] = []);
    q.push(timeline);
  }
  if (key && reasoning && reasoning.trim()) {
    const rstore = prev.reasoningByReplyKey ?? (prev.reasoningByReplyKey = {});
    const rq = rstore[key] ?? (rstore[key] = []);
    rq.push(reasoning);
  }
  writeSessionCtxMeta(agentId, sessionId, prev);
  return prev;
}







export interface LooseTimelineStep {
  kind: string;
  text?: string;
  name?: string;
  label?: string;
  detail?: string;
  result?: string;
  items?: PlanItemLite[];
  state?: "start" | "done";
  


  running?: boolean;
}


function adoptRecordTimeline(tl: readonly LooseTimelineStep[] | undefined): TimelineStepLite[] | undefined {
  if (!tl || tl.length === 0) { return undefined; }
  return tl as unknown as TimelineStepLite[];
}


















export function settleRunning(steps: readonly TimelineStepLite[] | undefined): TimelineStepLite[] | undefined {
  if (!steps || steps.length === 0) { return steps as TimelineStepLite[] | undefined; }
  if (!steps.some((s) => s.running)) { return steps as TimelineStepLite[]; }
  return steps.map((s) => (s.running ? { ...s, running: false } : s));
}














export function attachTimelineToHistory(
  msgs: Array<{ role: string; reasoning?: string; content?: string; timeline?: readonly LooseTimelineStep[] }>,
  meta: SessionCtxMeta | null,
): Array<{ timeline?: TimelineStepLite[]; reasoning?: string; assistantOrdinal?: number }> {
  let aiOrd = 0;
  /**
   * A-1197：指纹队列的消费游标（每个指纹一条独立队列）。
   * 同一段回复文本可能出现多次（「好的」「已完成」这类），所以按**写入顺序入队、
   * 读取顺序出队**，而不是「一次命中就永远命中」—— 后者会把第 3 次的思考挂到第 1 条上。
   * 用Map 记游标而不是就地shift，是为了不改动 meta 本身（它可能是 localStorage 读出的对象，
   * 也可能被同一次渲染复用于产物回填）。
   */
  const cursors = new Map<string, number>();
  /** 思考原文的游标与时间线游标**分开记**：两条通道各自入队，共享游标会互相错位取。 */
  const R_REASON_CURSOR = "reasoning::";
  return msgs.map((m) => {
    if (m.role !== "assistant") { return { assistantOrdinal: undefined }; }
    aiOrd += 1;
    /**
     * 取源优先级：**指纹 → 序数 → 记录自带**。
     *
     * 指纹在前，是因为它与位置无关：写侧只有「前台 onDone」才写序数（后台那条早退了），
     * 两者数的东西不一样，序数在有空洞之后会整体错位。指纹命中不了（老数据没有指纹通道）
     * 才退回序数，因此老会话的行为**逐字节不变**。
     */
    const fp = replyFingerprint(m.content);
    const queue = fp ? meta?.timelineByReplyKey?.[fp] : undefined;
    let fromKey: TimelineStepLite[] | undefined;
    if (queue && queue.length > 0) {
      const at = cursors.get(fp!) ?? 0;
      if (at < queue.length) {
        fromKey = queue[at];
        cursors.set(fp!, at + 1);
      }
    }
    const stored = meta?.timelineByAssistantIdx?.[aiOrd];
    const byOrdinal = stored && stored.length > 0 ? stored : undefined;
    /*
     * A-1197：指纹来源**优先**，并入 `fromMeta` 这个名字，让下游那一行保持唯一出处。
     *
     * 为什么不写成 `fromKey ?? fromMeta`：
     * `timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline))`
     * 是 A-1021b / A-1068 两条既有守卫**逐字**要求的形状（它们锚的是
     * 「序数与记录自带两个来源都必须过 settleRunning」这条不变量）。
     * 直接改那个形状等于单方面撕掉别人的守卫；所以让 `fromMeta` 本身
     * 优先承载指纹结果，既有守卫的形状与语义都完整保留。
     */
    const fromMeta = fromKey ?? byOrdinal;
    /**
     * 思考原文：记录自带的 reasoning 优先（它是**落过库**的那份，最权威）；
     * 缺失时用指纹通道补（后台结束那条记录可能没落 reasoning，但内存快照里有）。
     * 两者都没有就保持 undefined —— 调用方据此退回「文本平铺」，不造空折叠卡。
     */
    let reasoning = m.reasoning;
    if ((!reasoning || !reasoning.trim()) && fp) {
      const rq = meta?.reasoningByReplyKey?.[fp];
      const ri = cursors.get(R_REASON_CURSOR + fp) ?? 0;
      if (rq && ri < rq.length) {
        reasoning = rq[ri];
        cursors.set(R_REASON_CURSOR + fp, ri + 1);
      }
    }
    return {
      



      timeline: settleRunning(fromMeta ?? adoptRecordTimeline(m.timeline)),
      reasoning,
      assistantOrdinal: aiOrd,
    };
  });
}



export function restoreUsed(meta: SessionCtxMeta | null): number {
  return meta && meta.used > 0 ? meta.used : 0;
}