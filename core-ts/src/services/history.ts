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
export const HISTORY_PATH = join(PROJECT_ROOT, "config", "history.jsonl");

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
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureParent(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
}

async function readLines(): Promise<string[]> {
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    return raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function atomicRewrite(lines: string[]): Promise<void> {
  await ensureParent();
  const tmp = join(dirname(HISTORY_PATH), `${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(tmp, lines.join("\n") + "\n", "utf8"); // A-019: 换行收尾
  await rename(tmp, HISTORY_PATH);
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
): Promise<void> {
  const record: HistoryRecord = {
    agent_id: agentId,
    user: userMsg,
    ai: aiReply,
    success,
    timestamp: nowIso(),
    session_id: sessionId,
  };
  await withWriteLock(async () => {
    await ensureParent();
    await appendFile(HISTORY_PATH, JSON.stringify(record) + "\n", "utf8");
    await rotateIfNeeded();
  });
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

/** HistoryUserLoader 适配（novelty 检测注入点） */
export const historyUserLoader: (
  agentId: string,
  limit: number,
) => Promise<Array<{ user: string }>> = (agentId, limit) =>
  loadHistory(agentId, limit).then((rs) => rs.map((r) => ({ user: r.user })));

/** 历史存储接口（服务层注入点；测试可用内存实现） */
export interface HistoryStore {
  append(agentId: string, userMsg: string, aiReply: string, success?: boolean, sessionId?: string): Promise<void>;
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

/** P0: 辅助导出（主进程使用） */
export { popLastRecordForAgent as popLastRecordForAgentExport };
export { clearHistoryForAgent as clearHistoryForAgentExport };