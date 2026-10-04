







import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export { PROJECT_ROOT };

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
  
  session_id?: string;
  
  reasoning?: string;
  
  elapsed_ms?: number;
  

  timeline?: Array<{ kind: string; text?: string; name?: string; label?: string; detail?: string; result?: string }>;
  









  turns?: Array<{ name: string; agentId?: string; content: string; failed?: boolean }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureParent(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
}




let cachedStat: { mtimeMs: number; size: number } | null = null;
let cachedLines: string[] | null = null;


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
  await writeFile(tmp, lines.join("\n") + "\n", "utf8"); 
  await rename(tmp, HISTORY_PATH);
  invalidateHistoryCache(); 
}


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
  
  turns?: Array<{ name: string; agentId?: string; content: string; failed?: boolean }>,
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
    
    ...(turns && turns.length > 0 ? { turns } : {}),
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
        kept.push(l); 
      }
    }
    await atomicRewrite(kept);
    return removed;
  });
}















export function tailLimit<T>(records: T[], limit: number): T[] {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 0;
  return n > 0 ? records.slice(-n) : records;
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
      
    }
  }
  return tailLimit(records, limit);
}







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
      
    }
  }
  return tailLimit(records, limit);
}



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
      
    }
  }
  const slice = records.slice(-limit);
  return { records: slice, hasMore: records.length > limit };
}


export const historyUserLoader: (
  agentId: string,
  limit: number,
) => Promise<Array<{ user: string }>> = (agentId, limit) =>
  loadHistory(agentId, limit).then((rs) => rs.map((r) => ({ user: r.user })));


export interface HistoryStore {
  append(
    agentId: string,
    userMsg: string,
    aiReply: string,
    success?: boolean,
    sessionId?: string,
    reasoning?: string,
    elapsedMs?: number,
    
    turns?: Array<{ name: string; agentId?: string; content: string; failed?: boolean }>,
  ): Promise<void>;
  load(agentId?: string | null, limit?: number, sessionId?: string): Promise<HistoryRecord[]>;
  popLast(agentId: string, sessionId?: string): Promise<boolean>;
}

export const fileHistoryStore: HistoryStore = {
  append: appendHistory,
  load: loadHistory,
  popLast: popLastHistory,
};


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











export async function clearLegacySessionHistory(agentId: string): Promise<number> {
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
        if (r.agent_id === agentId && !r.session_id) {
          removed++;
          continue;
        }
        kept.push(JSON.stringify(r));
      } catch {
        kept.push(l);
      }
    }
    if (removed > 0) { await atomicRewrite(kept); }
    return removed;
  });
}


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














export function findRollbackCut(
  records: readonly HistoryRecord[],
  agentId: string,
  sessionId: string | undefined,
  targetUserMsg: string,
): { index: number; prevTimestamp: number } {
  let cutIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.agent_id === agentId && (sessionId === undefined || r.session_id === sessionId)) {
      if (r.user === targetUserMsg) { cutIdx = i; break; }
    }
  }
  if (cutIdx < 0) { return { index: -1, prevTimestamp: 0 }; }
  let prevTimestamp = 0;
  for (let i = cutIdx - 1; i >= 0; i--) {
    const r = records[i];
    if (r.agent_id === agentId && (sessionId === undefined || r.session_id === sessionId)) {
      const t = Date.parse(r.timestamp ?? "");
      prevTimestamp = Number.isFinite(t) ? t : 0;
      break;
    }
  }
  return { index: cutIdx, prevTimestamp };
}









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
        
      }
    }
    
    const cutIdx = findRollbackCut(records, agentId, sessionId, targetUserMsg).index;
    if (cutIdx < 0) {
      return 0;
    }
    
    
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


export async function readHistoryRecords(): Promise<HistoryRecord[]> {
  if (!(await stat(HISTORY_PATH).catch(() => null))) { return []; }
  const lines = await readLines();
  const out: HistoryRecord[] = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l) as HistoryRecord); } catch {  }
  }
  return out;
}



export { popLastRecordForAgent as popLastRecordForAgentExport };
export { clearHistoryForAgent as clearHistoryForAgentExport };
export { truncateHistoryFrom as truncateHistoryFromExport };