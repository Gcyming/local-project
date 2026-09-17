/**
 * core-ts/src/services/history.ts — 对话历史持久化（core/history.py 语义移植）。
 * - config/history.jsonl JSONL 追加；记录 { agent_id, user, ai, success, timestamp }
 * - BUG-027 轮转：超 10MB 只保留最近 5000 条
 * - popLast：/retry 去重（锁内读改写；A-019 换行收尾防 "}{" 拼接行）
 * - load：按 agent 过滤，最近 limit 条按时间升序
 */

import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export { PROJECT_ROOT };
/** history 路径（支持 SLIME_HISTORY_PATH 覆盖——测试隔离注入；缺省 config/history.jsonl） */
export const HISTORY_PATH = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_HISTORY_PATH : undefined;
  if (env) { return env; }
  return join(PROJECT_ROOT, "config", "history.jsonl");
})();

const MAX_HISTORY_BYTES = 10 * 1024 * 1024;
const KEEP_RECORDS = 5000;

export interface HistoryRecord {
  agent_id: string;
  user: string;
  ai: string;
  success: boolean;
  timestamp: string;
  /** 会话 ID（GUI 项目内独立会话；旧记录无此字段归入该 Agent 首个会话） */
  session_id?: string;
  /** 该条回复的推理/思考过程（assistant，Markdown；旧记录无此字段） */
  reasoning?: string;
  /** 该条回复的耗时（毫秒，assistant；旧记录无此字段） */
  elapsed_ms?: number;
  /** A-966：交错思考时间线（思考/工具调用顺序；结构对齐 GUI TimelineStepLite，见 gui/src/renderer/pages/sessionCtxMeta.ts）。
   *  随历史落库，重启后思考历程可恢复「时间线」展示，不依赖 localStorage。 */
  timeline?: Array<{ kind: string; text?: string; name?: string; label?: string; detail?: string; result?: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureParent(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
}

/** A-968：history 读取缓存 —— 以文件 stat(mtimeMs+size) 为指纹，未变化则复用已解析的行。
 *  避免每次 loadHistory/loadHistoryForSession 都全量读盘 + 逐行 JSON.parse（对话一多 cost 线性放大）。
 *  所有写路径（append/popLast/remove/clear/truncate/rotate）都会失效本缓存。 */
let cachedStat: { mtimeMs: number; size: number } | null = null;
let cachedLines: string[] | null = null;

/** 任何写路径后调用，强制下次 readLines 重新读盘。 */
function invalidateHistoryCache(): void {
  cachedStat = null;
  cachedLines = null;
}

async function readLines(): Promise<string[]> {
  let s: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await stat(HISTORY_PATH);
    s = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // 文件不存在：命中空缓存则复用，否则回空并记住
  }
  if (cachedStat && cachedLines && s && cachedStat.mtimeMs === s.mtimeMs && cachedStat.size === s.size) {
    return cachedLines;
  }
  let lines: string[];
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    lines = [];
  }
  cachedStat = s;
  cachedLines = lines;
  return lines;
}

async function atomicRewrite(lines: string[]): Promise<void> {
  await ensureParent();
  const tmp = join(dirname(HISTORY_PATH), `${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(tmp, lines.join("\n") + "\n", "utf8"); // A-019: 换行收尾
  await rename(tmp, HISTORY_PATH);
  invalidateHistoryCache(); // A-968：重写后失效缓存，避免读到旧内容
}

/** 进程内写锁（对齐 Python _write_lock：保护 append/popLast/removeAgent 读改写） */
let writeChain: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function appendHistory(
  agentId: string,
  userMsg: string,
  aiReply: string,
  success = true,
  sessionId?: string,
  reasoning?: string,
  elapsedMs?: number,
): Promise<void> {
  const record: HistoryRecord = {
    agent_id: agentId,
    user: userMsg,
    ai: aiReply,
    success,
    timestamp: nowIso(),
    session_id: sessionId,
    reasoning,
    elapsed_ms: elapsedMs,
  };
  await withWriteLock(async () => {
    await ensureParent();
    await appendFile(HISTORY_PATH, JSON.stringify(record) + "\n", "utf8");
    await rotateIfNeeded();
  });
  invalidateHistoryCache();
}

export async function rotateIfNeeded(): Promise<void> {
  let size: number;
  try {
    size = (await stat(HISTORY_PATH)).size;
  } catch {
    return;
  }
  if (size <= MAX_HISTORY_BYTES) {
    return;
  }
  const lines = await readLines();
  if (lines.length <= KEEP_RECORDS) {
    return;
  }
  await atomicRewrite(lines.slice(-KEEP_RECORDS));
}

export async function popLastHistory(agentId: string, sessionId?: string): Promise<boolean> {
  if (!(await stat(HISTORY_PATH).catch(() => null))) {
    return false;
  }
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return false;
    }
    const records: HistoryRecord[] = [];
    for (const l of lines) {
      try {
        records.push(JSON.parse(l) as HistoryRecord);
      } catch {
        // 损坏行跳过（对齐 Python）
      }
    }
    if (records.length === 0) {
      return false;
    }
    let idx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.agent_id === agentId && (sessionId === undefined || r.session_id === sessionId)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      return false;
    }
    records.splice(idx, 1);
    await atomicRewrite(records.map((r) => JSON.stringify(r)));
    return true;
  });
}

/** A-966：为指定 Agent+会话的「最后一条 assistant 记录」回填交错时间线（渲染层 done 后调用）。
 *  使思考历程随 history.jsonl 落库——重启后恢复时间线而不依赖 localStorage 存活。
 *  幂等：重复调用覆盖同一记录的 timeline；找不到匹配记录返回 false。失败不抛错。 */
export async function attachTimelineToRecord(
  agentId: string,
  sessionId: string,
  timeline: HistoryRecord["timeline"],
): Promise<boolean> {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return false;
  }
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return false;
    }
    const records: HistoryRecord[] = [];
    for (const l of lines) {
      try {
        records.push(JSON.parse(l) as HistoryRecord);
      } catch {
        continue;
      }
    }
    let target = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.agent_id === agentId && (sessionId === "" || r.session_id === sessionId)) {
        target = i;
        break;
      }
    }
    // 回退：session_id 未落库（旧链路）→ 附到该 agent 最近一条记录
    if (target < 0 && sessionId) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].agent_id === agentId) {
          target = i;
          break;
        }
      }
    }
    if (target < 0) {
      return false;
    }
    records[target] = { ...records[target], timeline };
    await atomicRewrite(records.map((r) => JSON.stringify(r)));
    return true;
  });
}

export async function removeAgentHistory(agentId: string): Promise<number> {
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return 0;
    }
    const kept: string[] = [];
    let removed = 0;
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as HistoryRecord;
        if (r.agent_id === agentId) {
          removed++;
          continue;
        }
        kept.push(JSON.stringify(r));
      } catch {
        kept.push(l); // 无法解析的行保留原文
      }
    }
    await atomicRewrite(kept);
    return removed;
  });
}

export async function loadHistory(
  agentId: string | null = null,
  limit = 200,
  sessionId?: string,
): Promise<HistoryRecord[]> {
  const lines = await readLines();
  const records: HistoryRecord[] = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as HistoryRecord;
      if (agentId === null || r.agent_id === agentId) {
        if (sessionId === undefined || r.session_id === sessionId) {
          records.push(r);
        }
      }
    } catch {
      // 损坏行跳过
    }
  }
  return records.slice(-limit);
}

/** 按会话加载（旧记录无 session_id → 归入该 Agent 的首个会话） */
export async function loadHistoryForSession(
  agentId: string,
  sessionId: string,
  limit = 500,
  firstSession = false,
): Promise<HistoryRecord[]> {
  const lines = await readLines();
  const records: HistoryRecord[] = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as HistoryRecord;
      if (r.agent_id !== agentId) {
        continue;
      }
      if (r.session_id === sessionId || (firstSession && !r.session_id)) {
        records.push(r);
      }
    } catch {
      // 损坏行跳过
    }
  }
  return records.slice(-limit);
}

/** A-980-R18：分页加载更早历史——返回 beforeTs（ISO，字典序可比）之前的最近 limit 条 + 是否还有更早。
 *  供聊天「加载更早的消息」分段胶囊使用（历史首屏只载最近 500 条，超出部分点击再载）。 */
export async function loadHistoryForSessionBefore(
  agentId: string,
  sessionId: string,
  limit: number,
  firstSession: boolean,
  beforeTs: string,
): Promise<{ records: HistoryRecord[]; hasMore: boolean }> {
  const lines = await readLines();
  const records: HistoryRecord[] = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as HistoryRecord;
      if (r.agent_id !== agentId) {
        continue;
      }
      if (r.session_id === sessionId || (firstSession && !r.session_id)) {
        if (r.timestamp < beforeTs) {
          records.push(r);
        }
      }
    } catch {
      // 损坏行跳过
    }
  }
  const slice = records.slice(-limit);
  return { records: slice, hasMore: records.length > limit };
}

/** HistoryUserLoader 适配（novelty 检测注入点） */
export const historyUserLoader: (
  agentId: string,
  limit: number,
) => Promise<Array<{ user: string }>> = (agentId, limit) =>
  loadHistory(agentId, limit).then((rs) => rs.map((r) => ({ user: r.user })));

/** 历史存储接口（服务层注入点；测试可用内存实现） */
export interface HistoryStore {
  append(
    agentId: string,
    userMsg: string,
    aiReply: string,
    success?: boolean,
    sessionId?: string,
    reasoning?: string,
    elapsedMs?: number,
  ): Promise<void>;
  load(agentId?: string | null, limit?: number, sessionId?: string): Promise<HistoryRecord[]>;
  popLast(agentId: string, sessionId?: string): Promise<boolean>;
}

export const fileHistoryStore: HistoryStore = {
  append: appendHistory,
  load: loadHistory,
  popLast: popLastHistory,
};

/** P0: 清空指定 agent 的全部历史 */
export async function clearHistoryForAgent(agentId: string): Promise<number> {
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return 0;
    }
    const kept: string[] = [];
    let removed = 0;
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as HistoryRecord;
        if (r.agent_id === agentId) {
          removed++;
          continue;
        }
        kept.push(JSON.stringify(r));
      } catch {
        kept.push(l);
      }
    }
    await atomicRewrite(kept);
    return removed;
  });
}

/** 清空指定会话的历史（保留会话条目与其余会话） */
export async function clearSessionHistory(agentId: string, sessionId: string): Promise<number> {
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return 0;
    }
    const kept: string[] = [];
    let removed = 0;
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as HistoryRecord;
        if (r.agent_id === agentId && r.session_id === sessionId) {
          removed++;
          continue;
        }
        kept.push(JSON.stringify(r));
      } catch {
        kept.push(l);
      }
    }
    await atomicRewrite(kept);
    return removed;
  });
}

/** P0: 弹出最后一条记录并返回（用于 retry 重发） */
export async function popLastRecordForAgent(agentId: string, sessionId?: string): Promise<HistoryRecord | null> {
  if (!(await stat(HISTORY_PATH).catch(() => null))) {
    return null;
  }
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return null;
    }
    const records: HistoryRecord[] = [];
    for (const l of lines) {
      try {
        records.push(JSON.parse(l) as HistoryRecord);
      } catch {
        // 损坏行跳过
      }
    }
    if (records.length === 0) {
      return null;
    }
    let idx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.agent_id === agentId && (sessionId === undefined || r.session_id === sessionId)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      return null;
    }
    const record = records[idx];
    records.splice(idx, 1);
    await atomicRewrite(records.map((r) => JSON.stringify(r)));
    return record;
  });
}

/**
 * A-161：截断历史到指定用户消息之前 —— 回滚（rollback）持久化一致性修复。
 * 此前 rollbackTo 只改前端 messages 与输入框，从不删除 history.jsonl 中的历史记录，
 * 重启后 loadHistoryForSession 从文件加载 → 回滚前的旧消息原样复现。
 * 语义：删除该 agent+session 中「从目标用户消息（含）往后的全部记录」，保留其前面的一切。
 * 定位：从后往前找该会话内最后一条 user 内容 === targetUserMsg 的记录；找不到返回 0。
 * 返回实际删除条数。
 */
export async function truncateHistoryFrom(
  agentId: string,
  sessionId: string | undefined,
  targetUserMsg: string,
): Promise<number> {
  if (!(await stat(HISTORY_PATH).catch(() => null))) {
    return 0;
  }
  return withWriteLock(async () => {
    const lines = await readLines();
    if (lines.length === 0) {
      return 0;
    }
    const records: HistoryRecord[] = [];
    for (const l of lines) {
      try {
        records.push(JSON.parse(l) as HistoryRecord);
      } catch {
        // 损坏行跳过
      }
    }
    let cutIdx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.agent_id === agentId && (sessionId === undefined || r.session_id === sessionId)) {
        if (r.user === targetUserMsg) {
          cutIdx = i;
          break;
        }
      }
    }
    if (cutIdx < 0) {
      return 0;
    }
    // 删除「该 agent+session 内」目标消息及其之后的所有记录；其他 agent/session 的记录
    // 无论位置都保留（回滚只影响本会话，不牵连其他会话/Agent）。
    const kept: HistoryRecord[] = [];
    let removed = 0;
    const isTargetScope = (r: HistoryRecord): boolean =>
      r.agent_id === agentId && (sessionId === undefined || r.session_id === sessionId);
    for (let i = 0; i < records.length; i++) {
      if (i >= cutIdx && isTargetScope(records[i])) {
        removed++;
        continue;
      }
      kept.push(records[i]);
    }
    await atomicRewrite(kept.map((r) => JSON.stringify(r)));
    return removed;
  });
}

/** P0: 辅助导出（主进程使用） */
export { popLastRecordForAgent as popLastRecordForAgentExport };
export { clearHistoryForAgent as clearHistoryForAgentExport };
export { truncateHistoryFrom as truncateHistoryFromExport };