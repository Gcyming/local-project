/**
 * brainstormFlow.ts — 群聊右栏「思考碰撞」流的状态机 + 持久化**纯函数集**（A-1013）。
 *
 * ## 为什么必须有这个模块
 *
 * 用户报告两条症状：
 *   ①「退出重启后，思考碰撞的内容一直都是消失的」
 *   ②「每次 Agent 输出完，思考碰撞都会消失得七七八八，只有类似总结的部分」
 *
 * 根因是**三个独立缺陷叠在一起**（只修一个都不够，这正是本项目"修一个坏一个"的典型土壤）：
 *
 *   **A. 两条写入路径语义不一致（症状②的直接原因）**
 *   `BrainstormPanel` 里 thinking 走 `setFlow(prev => …)`（追加），
 *   而 idea（成员说完）走 `flushFlow(...)` → `setFlow(snap)`（**用本批数据整体覆盖**）。
 *   于是每个成员一说完，累积的思考行被整批抹掉，只剩刚 push 的那条"观点/总结"。
 *   → 本模块只提供**一个** reducer（`applyFlowEvent`），两种事件走同一条路，不可能再不一致。
 *
 *   **B. 无持久化（症状①）**
 *   flow 只活在 React state 里 → 重启即空。同目录 `sessionCtxMeta.ts` 已有成熟约定
 *   （localStorage key 前缀 + 零依赖纯模块 + vitest 直测），本模块沿用同一约定。
 *   注意：这**不是**可选优化 —— `sessionCtxMeta.ts` 的注释里写着同一类事故：
 *   「必须一起持久化，否则重启后…规划卡凭空消失、只剩一堆工具调用行」。
 *
 *   **C. 静默截断（症状②的第二个来源）**
 *   原来 `slice(-120)` 直接丢掉更早条目，**界面不做任何提示**。本模块改为：
 *   记得丢弃了多少条（`dropped`），界面据此显示「更早 N 条已折叠」——
 *   宁可显式折叠，也不要让用户以为内容坏了。
 *
 * ## 边界
 * 零 React / 零 import（守卫见 `tests/core-ts/brainstorm-flow.spec.ts`）——
 * 所以它可以被渲染进程直接导入、也可以被 vitest 直测。
 */

/** 流的一条记录：成员的一段思考，或成员说完的一个观点 */
export type FlowKind = "thinking" | "idea";

export interface FlowEntry {
  /** 稳定且唯一（React key）；由 reducer 用 `nextId` 单调分配，**不用 Date.now()**——
   *  同一毫秒内的 `Date.now() + Math.random()` 仍可能撞 key（会触发 React 重复 key 警告与错渲染）。 */
  id: number;
  name: string;
  text: string;
  kind: FlowKind;
}

export interface FlowState {
  entries: FlowEntry[];
  /** 因超出上限而被折叠掉的更早条目数（界面显式提示，不静默丢弃） */
  dropped: number;
  /** 下一条记录的 id（单调递增，保证 key 稳定唯一） */
  nextId: number;
  /** 最后一次写入时间（用于多会话存储的老化清理，见 `pruneFlowStorage`） */
  updatedAt: number;
}

/**
 * 单个会话最多保留多少条流记录。
 * 400 条 ≈ 一段多轮群聊的完整往返（每位成员每轮的思考被合并成若干条，每条约 600 字符）。
 * 超过则折叠最早的（并计入 `dropped`），单会话存储体积上界约 250KB。
 */
export const FLOW_MAX_ENTRIES = 400;

/** 同一成员的连续思考合并进同一条时的字符上限（超出部分另起新条，**不丢字**） */
export const FLOW_THINKING_COALESCE_CHARS = 600;

/** localStorage key 前缀（与 `slime_ctxmeta_` 同级约定） */
export const FLOW_STORE_PREFIX = "slime_bsflow_";

/** 最多保留多少个会话的流（超出按 updatedAt 淘汰最旧的，避免 localStorage 无限膨胀） */
export const FLOW_MAX_SESSIONS = 30;

export function emptyFlowState(): FlowState {
  return { entries: [], dropped: 0, nextId: 1, updatedAt: 0 };
}

/* ══════════════════════ 状态机（唯一的写入路径） ══════════════════════ */

/** 一条待入流的事件（由组件把广播事件翻译成这个形状——翻译逻辑留在组件，状态机保持纯粹） */
export interface FlowEvent {
  kind: FlowKind;
  name: string;
  text: string;
}

/**
 * 把一条事件并入状态。**这是流唯一的写入路径**（thinking 与 idea 共用），
 * 从结构上消除"两个 setState 语义不一致"这类 bug。
 *
 * 规则：
 *  - `thinking`：若上一条是**同一成员**的 thinking 且未满 {@link FLOW_THINKING_COALESCE_CHARS}，
 *    则并入该条（流式思考自然成段）；**放不下的部分另起新条**，绝不截断丢字。
 *  - `idea`：永远新起一条（观点是离散事件，合并会把它埋进思考里）。
 *  - 超出 {@link FLOW_MAX_ENTRIES} 时折叠最早的，并把条数累加进 `dropped`。
 */
export function applyFlowEvent(state: FlowState, ev: FlowEvent): FlowState {
  const text = typeof ev.text === "string" ? ev.text : "";
  if (!text.trim()) { return state; } // 空/纯空白不进流（A-956 同款：杜绝"想"空行噪音）

  const entries = state.entries;
  const last = entries[entries.length - 1];
  if (ev.kind === "thinking" && last && last.kind === "thinking" && last.name === ev.name) {
    const room = FLOW_THINKING_COALESCE_CHARS - last.text.length;
    if (room > 0) {
      const filled = { ...last, text: last.text + text.slice(0, room) };
      const rest = text.slice(room);
      if (!rest) {
        const next = entries.slice();
        next[next.length - 1] = filled;
        return { ...state, entries: next };
      }
      // 本行填满了 → 余下另起一条（不丢字）
      return pushEntry({ ...state, entries: [...entries.slice(0, -1), filled] }, ev.kind, ev.name, rest);
    }
  }
  return pushEntry(state, ev.kind, ev.name, text);
}

/** 入流一条新记录（含上限折叠）。内部使用。
 *
 *  ⚠️ `text` 超长时**切成多条**，不做 `slice` 截断 —— 本模块的对外承诺就是"绝不静默丢字"
 *  （`applyFlowEvent` 的注释写着"放不下的部分另起新条，绝不截断丢字"）。
 *  曾经的实现这里写着 `text.slice(0, 600)`：正常逐 chunk 到达时看不出来，
 *  但上游一次性给一大段思考（或某次 chunk 特别大）就会静默吃掉尾巴 —— 正是用户报的
 *  「内容消失」那一类，只是发生在单条事件内部。由 `brainstorm-flow.spec.ts` 锁死。 */
function pushEntry(state: FlowState, kind: FlowKind, name: string, text: string): FlowState {
  const added: FlowEntry[] = [];
  for (let off = 0; off < text.length; off += FLOW_THINKING_COALESCE_CHARS) {
    added.push({
      id: state.nextId + added.length,
      name,
      text: text.slice(off, off + FLOW_THINKING_COALESCE_CHARS),
      kind,
    });
  }
  let next = [...state.entries, ...added];
  let dropped = state.dropped;
  if (next.length > FLOW_MAX_ENTRIES) {
    const cut = next.length - FLOW_MAX_ENTRIES;
    next = next.slice(cut);
    dropped += cut;
  }
  return { entries: next, dropped, nextId: state.nextId + added.length, updatedAt: state.updatedAt };
}

/** 批量并入（组件的 rAF 合批用）——语义等价于逐条调用 `applyFlowEvent`。 */
export function appendFlowEvents(state: FlowState, evs: readonly FlowEvent[]): FlowState {
  let next = state;
  for (const ev of evs) { next = applyFlowEvent(next, ev); }
  return next;
}

/* ══════════════════════ 持久化 ══════════════════════ */

export function flowStorageKey(sessionId: string): string {
  return `${FLOW_STORE_PREFIX}${sessionId}`;
}

/**
 * 读回某会话的流。**必须防御性校验**：localStorage 里可能有旧版本结构、
 * 手改过的值、或别的模块误写的 key —— 任何异常都回退到空状态，绝不让坏数据把右栏整个打挂。
 */
export function readFlowState(sessionId: string): FlowState | null {
  if (!sessionId) { return null; }
  try {
    const raw = localStorage.getItem(flowStorageKey(sessionId));
    if (!raw) { return null; }
    const p = JSON.parse(raw) as Partial<FlowState>;
    if (!p || typeof p !== "object" || !Array.isArray(p.entries)) { return null; }
    const entries: FlowEntry[] = [];
    for (const raw2 of p.entries) {
      const e = raw2 as Partial<FlowEntry>;
      if (!e || typeof e.text !== "string" || typeof e.name !== "string") { continue; }
      if (e.kind !== "thinking" && e.kind !== "idea") { continue; }
      if (typeof e.id !== "number" || !Number.isFinite(e.id)) { continue; }
      entries.push({ id: e.id, name: e.name, text: e.text, kind: e.kind });
    }
    if (entries.length === 0) { return null; }
    const maxId = entries.reduce((m, e) => (e.id > m ? e.id : m), 0);
    const nextId = typeof p.nextId === "number" && p.nextId > maxId ? p.nextId : maxId + 1;
    return {
      entries,
      dropped: typeof p.dropped === "number" && p.dropped > 0 ? Math.floor(p.dropped) : 0,
      nextId,
      updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
    };
  } catch { return null; }
}

/** 写回某会话的流（自动补 updatedAt；顺手按会话数上限老化清理）。 */
export function writeFlowState(sessionId: string, state: FlowState, now: number = Date.now()): void {
  if (!sessionId) { return; }
  const payload: FlowState = { ...state, updatedAt: now };
  try {
    localStorage.setItem(flowStorageKey(sessionId), JSON.stringify(payload));
  } catch { /* 配额不足/被禁用：静默降级为"本次会话可见但重启不保留"，不影响功能 */ }
  pruneFlowStorage(FLOW_MAX_SESSIONS, sessionId);
}

export function clearFlowState(sessionId: string): void {
  if (!sessionId) { return; }
  try { localStorage.removeItem(flowStorageKey(sessionId)); } catch { /* ignore */ }
}

/**
 * 老化清理：本模块的 key 数量超过 `maxSessions` 时，按 `updatedAt` 淘汰最旧的
 * （`keepSessionId` 永不被淘汰——它是刚写入的那个）。
 * 为什么要做：群聊可以建很多个，每个都会写一份流；不清理会让 localStorage 无限增长，
 * 最终"某天突然谁都存不进去"（而且报错发生在无关的写入点，极难定位）。
 */
export function pruneFlowStorage(maxSessions: number = FLOW_MAX_SESSIONS, keepSessionId?: string): number {
  try {
    const found: Array<{ key: string; updatedAt: number }> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(FLOW_STORE_PREFIX)) { continue; }
      if (keepSessionId && k === flowStorageKey(keepSessionId)) { continue; }
      let updatedAt = 0;
      try {
        const p = JSON.parse(localStorage.getItem(k) ?? "") as { updatedAt?: unknown };
        if (typeof p?.updatedAt === "number") { updatedAt = p.updatedAt; }
      } catch { /* 坏数据当作最旧，优先淘汰 */ }
      found.push({ key: k, updatedAt });
    }
    // keepSessionId 也计入总数，所以上限要减 1
    const allowed = Math.max(0, maxSessions - (keepSessionId ? 1 : 0));
    if (found.length <= allowed) { return 0; }
    found.sort((a, b) => a.updatedAt - b.updatedAt);
    const victims = found.slice(0, found.length - allowed);
    for (const v of victims) { localStorage.removeItem(v.key); }
    return victims.length;
  } catch { return 0; }
}
