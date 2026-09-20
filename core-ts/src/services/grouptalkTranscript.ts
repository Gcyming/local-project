/**
 * core-ts/src/services/grouptalkTranscript.ts — 群聊发言的**结构化**记录与还原（A-1008）。
 *
 * ## 这个文件为什么存在（两个"历时很久、反复修还是这样"的故障的同一根因）
 *
 * 群聊（brainstorm）落库走的是 `【成员名】发言内容` 拼成**一个大字符串**、只写**一条** history 记录。
 * 这一个实现选择同时制造了两个用户可见故障：
 *
 *   ① 「总有一个 Agent 出来把所有内容总结重复一遍」——
 *      历史记录在 GUI 里渲染成**一条** assistant 气泡。而 `sessions:load` 产出的消息**不带
 *      agentName/agentId**，气泡头部就退回会话归属 Agent 的名字。于是"一条把所有人说的话揉在
 *      一起、署名却是某个 Agent"的消息，读起来就是"有个 Agent 出来总结复述了一遍"。
 *      （用户截图自证：那条气泡的头像是 `test1`，而 `test1` 根本不在群成员里 —— 它只是会话归属
 *      Agent。凡"看起来像总结者"的身份异常，先查是不是这个归属回退。）
 *
 *      ⚠️ **这一条有两个产地，别只修一个**：上面说的是"读旧记录"。但用户实测过 A 修完之后
 *      **当场**依旧多出一条同样的假气泡 —— 那条根本没落库，是 `createStreamSession` 的
 *      `fullReply` 被 `member`/`speech-end` 事件污染后，经 done 回退
 *      （`reply: cleanReply ?? session.fullReply`）渲染出来的。
 *      见 `gui/src/main/index.ts` 里 `createStreamSession` 上方的 A-1008 注释；
 *      源码守卫在 `tests/core-ts/grouptalk-transcript.spec.ts` 末段（B 根因）。
 *
 *   ② 「退出重启后历史会话消失，只剩那个总结的 Agent」——
 *      群聊只写 1 条记录 → 重启后按 session_id 读回，只能重建出 1 条消息。成员各自的气泡
 *      从来没被持久化过（它们只活在渲染层内存 + per-session cache 里）。
 *
 * 修法是**只改存储的形状**，不改引擎调度：把每个成员的发言作为一个 turn 一并落进同一条记录，
 * 读取时按 turn 展开成多条气泡（各带自己的 agentName/agentId）。一个群聊轮次在存储上仍然
 * 是"一条记录"，但不再是"一坨文本"。
 *
 * 顺带：旧记录（已经写成大字符串的那些）用 `parseSpeakerBlob` 还原 —— 不必等用户重开一轮，
 * 历史里已有的记录也能恢复成逐成员气泡。
 */

/** 群聊里的一次发言（结构化的最小单元）。 */
export interface SpeakerTurn {
  /** 发言者显示名（= Agent.name，历史记录里就是这个） */
  name: string;
  /** 发言者 Agent id（可缺：旧记录只有名字；缺则渲染层按名字反查） */
  agentId?: string;
  /** 正文 */
  content: string;
  /** A-1008：该条实为「发言失败」的占位文本，不是这位成员真说过的话（UI 降级为错误样式） */
  failed?: boolean;
}

/** 标记：`【名字】`。名字不含 `】` 与换行，长度设上限防正文里的书名号误判。 */
const SPEAKER_MARKER = /【([^】\n]{1,80})】/g;

/**
 * 把 turn 列表拼成**兼容旧格式**的文本（`【名字】内容` 空行分隔）。
 *
 * 为什么仍然要拼：这条文本同时是**模型侧的对话历史**（`loadSessionHistory` 直接拿 `ai` 当
 * assistant 内容喂给下一轮），保留原格式 = 模型侧行为零变化，不必回归整条 prompt 链路。
 * 结构化数据只多存一份给 UI 用。
 */
export function formatSpeakerBlob(turns: SpeakerTurn[]): string {
  return turns.map((t) => `【${t.name}】${t.content}`).join("\n\n");
}

/**
 * 反向解析（旧记录 / 兜底）：把 `【名字】内容` 大字符串还原为 turn 列表。
 *
 * 判据刻意保守 —— 宁可返回 null（调用方退回"单条消息"的旧行为），也不要把普通正文
 * 里偶然出现的 `【…】` 切成假发言：
 *   - 第一个标记必须出现在**文本开头**（群聊落库必然以 `【名字】` 起头）；
 *   - 至少 2 个标记（单人那一条没有解析价值，交给调用方按会话类型决定）。
 *
 * @param text 待解析文本（通常是 HistoryRecord.ai）
 * @param opts.minTurns 最少标记数（默认 2）；按会话类型确知是群聊时可传 1
 */
export function parseSpeakerBlob(text: string, opts?: { minTurns?: number }): SpeakerTurn[] | null {
  const s = (text ?? "").replace(/\r\n/g, "\n");
  if (!s.trim()) { return null; }
  const min = Math.max(1, opts?.minTurns ?? 2);

  SPEAKER_MARKER.lastIndex = 0;
  const hits: Array<{ name: string; start: number; end: number }> = [];
  for (let m = SPEAKER_MARKER.exec(s); m !== null; m = SPEAKER_MARKER.exec(s)) {
    hits.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  // 必须以标记起头（允许前导空白）
  if (hits.length < min || s.slice(0, hits[0].start).trim() !== "") { return null; }

  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < hits.length; i++) {
    const to = i + 1 < hits.length ? hits[i + 1].start : s.length;
    const content = s.slice(hits[i].end, to).trim();
    if (!content) { continue; }
    turns.push({ name: hits[i].name, content });
  }
  return turns.length > 0 ? turns : null;
}

/**
 * 发言失败标记：引擎在成员发言抛错时把失败原因写进该成员的正文（`（名字 本次发言失败：…）`）。
 * 这里只做**识别**，供 UI 把该气泡降级为错误样式 —— 而不是当成该成员真的说了这话。
 */
export function isSpeechFailure(content: string): boolean {
  return /本次发言失败/.test(content ?? "");
}

/* ═══════════════ 历史记录 → GUI 消息（A-1008） ═══════════════
 *
 * 这段逻辑原本内联在 `gui/src/main/index.ts` 的 `sessions:load` handler 里。
 * 搬到这里的原因不是"文件太长"，而是**它只能被 IPC handler 调用 = 测不到**：
 * 而它恰好是那个历时很久的故障的最后一环 —— 一条群聊记录该展开成几条气泡。
 * 现在它是纯函数，`tests/core-ts/grouptalk-transcript.spec.ts` 直接测。
 */

/** 记录里可选的 `turns`（结构化发言）——与 history.ts 的 HistoryRecord.turns 同形。 */
export interface HistoryTurnLike {
  name: string;
  agentId?: string;
  content: string;
  failed?: boolean;
}

/** 展开所需的最小字段集（用结构化类型而非 import HistoryRecord：本模块保持零依赖） */
export interface ExpandableRecord {
  /** 用户侧文本 */
  user?: string;
  /** 助手侧文本（群聊旧记录 = `【名字】内容` 拼成的大字符串） */
  ai?: string;
  /** 记录时间戳（直接作为消息 time/ts） */
  timestamp: string;
  reasoning?: string;
  elapsed_ms?: number;
  timeline?: unknown;
  /** A-1008：结构化发言（新记录有；旧记录缺） */
  turns?: HistoryTurnLike[];
}

/** 展开出的 GUI 消息（字段名与 shared/ipc.ts 的 ConversationMessage 对齐） */
export interface ExpandedMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
  ts?: string;
  reasoning?: string;
  elapsedMs?: number;
  timeline?: unknown[];
  agentName?: string;
  agentId?: string;
  failed?: boolean;
}

/**
 * 群聊专用反解：**先确认这是群聊记录**，再按发言块切。
 *
 * 为什么不能直接调 `parseSpeakerBlob`：
 * 模型很爱用 `【小标题】` 写正文（「【结论】…【建议】…」）。若只要"以标记起头 + 有 2 个标记"
 * 就切，一条**普通的单人回复**会被切成两条假的成员气泡（署名"结论""建议"）——
 * 这是本次修复自己会引入的新故障，必须在唯一入口处堵死。
 *
 * 判据：解析出的发言者里**至少有一个真的在成员名单里**。名单命中不了就退回
 * "单条消息"的旧行为（宁可少切，不可错切）。群聊里 @ 单人时一轮只有一条发言，
 * 所以这里用 `minTurns: 1`（默认的 2 会解析不出来）。
 */
export function parseSpeakerBlobForGroup(text: string, memberNames: ReadonlySet<string>): SpeakerTurn[] | null {
  const parsed = parseSpeakerBlob(text, { minTurns: 1 });
  if (!parsed) { return null; }
  return parsed.some((t) => memberNames.has(t.name)) ? parsed : null;
}

/**
 * 一条历史记录 → GUI 消息列表。
 *
 * - 普通记录：`user` 一条 + `ai` 一条（与旧行为一致）。
 * - 群聊记录：`ai` 按 `turns`（新记录）或 `parseSpeakerBlobForGroup`（旧记录）展开成
 *   **逐成员多条**，每条带自己的 `agentName/agentId`，发言失败的那条带 `failed`。
 * - 展开时 `reasoning/elapsedMs/timeline` 只挂**首条**（一条记录只存了一份，重复挂会重复渲染）。
 *
 * @param groupNames 该会话已知的成员名集合（**只有群聊会话才传**）。
 *        没有它就**完全不做文本切分** —— 非群聊会话里出现的 `【…】` 只是排版，不是发言人。
 */
export function expandHistoryRecord(r: ExpandableRecord, groupNames?: ReadonlySet<string>): ExpandedMessage[] {
  const out: ExpandedMessage[] = [];
  if (r.user) {
    out.push({ role: "user", content: r.user, time: r.timestamp, ts: r.timestamp });
  }
  if (!r.ai) { return out; }
  const hasFirstAssistant = (): boolean => out.some((m) => m.role === "assistant");

  const turns: SpeakerTurn[] | null = r.turns?.length
    ? r.turns.map((t) => ({ name: t.name, agentId: t.agentId, content: t.content, failed: t.failed }))
    : (groupNames && groupNames.size > 0 ? parseSpeakerBlobForGroup(r.ai, groupNames) : null);

  if (!turns) {
    out.push({
      role: "assistant", content: r.ai, time: r.timestamp, ts: r.timestamp,
      reasoning: r.reasoning, elapsedMs: r.elapsed_ms, timeline: r.timeline as unknown[] | undefined,
    });
    return out;
  }

  for (const t of turns) {
    const first = !hasFirstAssistant();
    out.push({
      role: "assistant", content: t.content, time: r.timestamp, ts: r.timestamp,
      reasoning: first ? r.reasoning : undefined,
      elapsedMs: first ? r.elapsed_ms : undefined,
      timeline: first ? (r.timeline as unknown[] | undefined) : undefined,
      agentName: t.name,
      agentId: t.agentId,
      // 发言失败：新记录按 turns.failed，旧记录只能靠文本判定 —— 两条路都要认
      ...((t.failed ?? isSpeechFailure(t.content)) ? { failed: true } : {}),
    });
  }
  return out;
}

