











































import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { HISTORY_PATH, findRollbackCut, readHistoryRecords } from "./history.js";
import { isSubagentSessionId } from "./subagent.js";


export const UNDO_JOURNAL_PATH = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_FILE_UNDO_PATH : undefined;
  if (env) { return env; }
  return join(dirname(HISTORY_PATH), "file-undo.jsonl");
})();


export const UNDO_SNAPSHOT_DIR = join(dirname(UNDO_JOURNAL_PATH), "file-undo-snapshots");







export const UNDO_INLINE_MAX = 64 * 1024;


export const UNDO_DELETE_MAX_FILES = 300;


interface UndoEntry {
  
  t: number;
  agent_id: string;
  
  session_id: string;
  
  abs: string;
  
  existed: boolean;
  
  old?: string;
  
  snap?: string;
  




  snapBin?: boolean;
  






  dir?: boolean;
  
  skip?: string;
}

export interface UndoScope { agent_id: string; session_id: string }


export function undoScopeOf(args: Record<string, unknown>): UndoScope | null {
  const raw = args._undo_scope as { agentId?: unknown; sessionId?: unknown } | undefined;
  if (!raw || typeof raw !== "object") { return null; }
  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";
  if (!agentId) { return null; }
  return { agent_id: agentId, session_id: typeof raw.sessionId === "string" ? raw.sessionId : "" };
}








export async function recordFileChange(
  scope: UndoScope | null,
  abs: string,
  existed: boolean,
  oldContent: string | Buffer | null,
): Promise<boolean> {
  if (!scope || !abs) { return false; }
  try {
    const entry: UndoEntry = {
      t: Date.now(), agent_id: scope.agent_id, session_id: scope.session_id,
      abs, existed,
    };
    if (existed) {
      const bytes = oldContent === null
        ? Buffer.alloc(0)
        : (Buffer.isBuffer(oldContent) ? oldContent : Buffer.from(oldContent, "utf8"));
      
      if (isRoundTrippableUtf8(bytes) && bytes.byteLength <= UNDO_INLINE_MAX) {
        entry.old = bytes.toString("utf8");
      } else {
        const snap = await writeSnapshot(bytes);
        entry.snap = snap.name;
        if (snap.bin) { entry.snapBin = true; }
      }
    }
    await appendEntry(entry);
    return true;
  } catch {
    return false;
  }
}


async function appendEntry(entry: UndoEntry): Promise<void> {
  await mkdir(dirname(UNDO_JOURNAL_PATH), { recursive: true });
  await appendFile(UNDO_JOURNAL_PATH, JSON.stringify(entry) + "\n", "utf8");
}





export async function recordDirEntry(scope: UndoScope | null, abs: string): Promise<boolean> {
  if (!scope || !abs) { return false; }
  try {
    const entry: UndoEntry = {
      t: Date.now(), agent_id: scope.agent_id, session_id: scope.session_id,
      abs, existed: true, dir: true,
    };
    await appendEntry(entry);
    return true;
  } catch {
    return false;
  }
}








export async function recordUnundoable(
  scope: UndoScope | null,
  abs: string,
  reason: string,
): Promise<void> {
  if (!scope || !abs) { return; }
  try {
    const entry: UndoEntry = {
      t: Date.now(), agent_id: scope.agent_id, session_id: scope.session_id,
      abs, existed: false, skip: reason,
    };
    await appendEntry(entry);
  } catch {  }
}








export function isRoundTrippableUtf8(buf: Buffer): boolean {
  if (buf.length === 0) { return true; }
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}


async function writeSnapshot(data: string | Buffer): Promise<{ name: string; bin: boolean }> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const bin = !isRoundTrippableUtf8(buf);
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 24)}.${bin ? "bin" : "txt"}`;
  await mkdir(UNDO_SNAPSHOT_DIR, { recursive: true });
  const p = join(UNDO_SNAPSHOT_DIR, name);
  if (!(await stat(p).catch(() => null))) { await writeFile(p, buf); }
  return { name, bin };
}


async function readSnapshot(name: string): Promise<Buffer | null> {
  try { return await readFile(join(UNDO_SNAPSHOT_DIR, name)); } catch { return null; }
}


export async function readUndoJournal(): Promise<UndoEntry[]> {
  if (!(await stat(UNDO_JOURNAL_PATH).catch(() => null))) { return []; }
  const raw = await readFile(UNDO_JOURNAL_PATH, "utf8").catch(() => "");
  const out: UndoEntry[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) { continue; }
    try {
      const o = JSON.parse(s) as UndoEntry;
      if (o && typeof o.abs === "string" && typeof o.t === "number") { out.push(o); }
    } catch {  }
  }
  return out;
}

export interface UndoPlanItem { abs: string; action: "restore" | "delete" }
export interface UndoPlan {
  
  ok: boolean;
  
  count: number;
  





  items: UndoPlanItem[];
  
  dirs: number;
  
  blocked: Array<{ abs: string; reason: string }>;
  
  foreign: number;
  error?: string;
}


function inRollbackScope(e: UndoEntry, agentId: string, sessionId: string | undefined): boolean {
  if (sessionId) {
    if (e.session_id === sessionId) { return true; }
    return isSubagentSessionId(e.session_id);
  }
  return e.session_id === "" && e.agent_id === agentId;
}


async function cutLine(agentId: string, sessionId: string | undefined, userMsg: string): Promise<number | null> {
  const recs = await readHistoryRecords();
  const cut = findRollbackCut(recs, agentId, sessionId, userMsg);
  return cut.index >= 0 ? cut.prevTimestamp : null;
}









export async function planFileUndo(
  agentId: string,
  sessionId: string | undefined,
  userMsg: string,
): Promise<UndoPlan> {
  return (await selectUndo(agentId, sessionId, userMsg)).plan;
}

interface Selection { plan: UndoPlan; first: Map<string, UndoEntry> }

async function selectUndo(
  agentId: string,
  sessionId: string | undefined,
  userMsg: string,
): Promise<Selection> {
  const empty: UndoPlan = { ok: false, count: 0, items: [], dirs: 0, blocked: [], foreign: 0 };
  const fail = (error: string): Selection => ({ plan: { ...empty, error }, first: new Map() });
  if (!agentId || !userMsg) { return fail("参数不完整"); }
  const cut = await cutLine(agentId, sessionId, userMsg);
  if (cut === null) {
    
    return fail("历史里找不到这条用户消息，无法确定回滚边界");
  }
  const entries = (await readUndoJournal()).filter((e) => e.t >= cut);
  const first = new Map<string, UndoEntry>();
  const blocked = new Map<string, string>();
  let foreign = 0;
  for (const e of entries) {
    if (!inRollbackScope(e, agentId, sessionId)) { foreign += 1; continue; }
    if (e.skip) { blocked.set(e.abs, e.skip); continue; }
    if (!first.has(e.abs)) { first.set(e.abs, e); }
  }
  
  const all = [...first.values()];
  const items: UndoPlanItem[] = all
    .filter((e) => !e.dir)
    .map((e) => ({ abs: e.abs, action: e.existed ? "restore" as const : "delete" as const }));
  return {
    plan: {
      ok: true, count: items.length, items,
      dirs: all.filter((e) => e.dir).length,
      blocked: [...blocked].map(([abs, reason]) => ({ abs, reason })),
      foreign,
    },
    first,
  };
}

export interface UndoResult {
  ok: boolean;
  restored: number;
  deleted: number;
  
  dirs: number;
  
  failed: Array<{ abs: string; error: string }>;
  blocked: Array<{ abs: string; reason: string }>;
  foreign: number;
  error?: string;
}


function depthOf(p: string): number {
  return p.split(/[\\/]/).filter(Boolean).length;
}





export async function applyFileUndo(
  agentId: string,
  sessionId: string | undefined,
  userMsg: string,
): Promise<UndoResult> {
  const { plan, first } = await selectUndo(agentId, sessionId, userMsg);
  const res: UndoResult = {
    ok: plan.ok, restored: 0, deleted: 0, dirs: 0,
    failed: [], blocked: plan.blocked, foreign: plan.foreign, error: plan.error,
  };
  if (!plan.ok) { return res; }
  
  const dirs = [...first.values()].filter((e) => e.dir).map((e) => e.abs).sort((a, b) => depthOf(a) - depthOf(b));
  for (const d of dirs) {
    try { await mkdir(d, { recursive: true }); res.dirs += 1; }
    catch (err) { res.failed.push({ abs: d, error: err instanceof Error ? err.message : String(err) }); }
  }
  for (const item of plan.items) {
    const e = first.get(item.abs);
    if (!e) { continue; }
    try {
      if (!e.existed) {
        await rm(item.abs, { force: true, recursive: true });
        res.deleted += 1;
        continue;
      }
      
      const content = e.old !== undefined
        ? Buffer.from(e.old, "utf8")
        : (e.snap ? await readSnapshot(e.snap) : null);
      if (content === null) {
        res.failed.push({ abs: item.abs, error: "改前快照读不到（账本里没有内联内容，快照文件缺失）" });
        continue;
      }
      await mkdir(dirname(item.abs), { recursive: true });
      await writeFile(item.abs, content);
      res.restored += 1;
    } catch (err) {
      res.failed.push({ abs: item.abs, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return res;
}
