








import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export { PROJECT_ROOT };
export const SESSIONS_PATH = join(PROJECT_ROOT, "config", "sessions.json");


export type MemberEntry = string | { id: string; model?: string; effort?: string };


export function memberIdsOf(entries?: MemberEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries ?? []) {
    const id = typeof e === "string" ? e : e.id;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}


export function memberModelsOf(entries?: MemberEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries ?? []) {
    if (typeof e === "object" && e && e.model) { out[e.id] = e.model; }
  }
  return out;
}


export function memberEffortsOf(entries?: MemberEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries ?? []) {
    if (typeof e === "object" && e && e.effort) { out[e.id] = e.effort; }
  }
  return out;
}






export function applyMemberEffort(entries: MemberEntry[] | undefined, memberId: string, effort: string | null): MemberEntry[] | null {
  const src = entries ?? [];
  let hit = false;
  const next = src.map((e) => {
    const isObj = typeof e === "object" && e !== null;
    const id = isObj ? e.id : e;
    if (id !== memberId) { return e; } 
    hit = true;
    if (!effort) {
      
      if (!isObj) { return e; }
      if (e.model) { return { id: e.id, model: e.model }; }
      return e.id;
    }
    
    if (!isObj) { return { id: memberId, effort }; }
    return { ...e, effort };
  });
  if (!hit) { return null; }
  return next;
}


function withoutMember(entries: MemberEntry[], agentId: string): MemberEntry[] {
  return (entries ?? []).filter((e) => e !== agentId && (typeof e === "string" ? e !== agentId : e.id !== agentId));
}

export interface SessionMeta {
  id: string;
  
  agentId: string;
  
  workspace?: string;
  
  members?: MemberEntry[];
  
  leaderModel?: string;
  















  modelChoice?: string;
  
  leaderEffort?: string;
  
  type?: "normal" | "brainstorm";
  title: string;
  createdAt: string;
  updatedAt: string;
  
  contextSummary?: string;
  



  summaryCount?: number;
  
  contextComprehend?: string;
  
  summaryGeneration?: number;
}

const DEFAULT_TITLE = "新对话";

let writeChain: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function ensureParent(): Promise<void> {
  await mkdir(dirname(SESSIONS_PATH), { recursive: true });
}

async function readAll(): Promise<Record<string, SessionMeta>> {
  try {
    const raw = await readFile(SESSIONS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { sessions?: Record<string, SessionMeta> };
    return parsed.sessions ?? {};
  } catch {
    return {};
  }
}

async function atomicWrite(all: Record<string, SessionMeta>): Promise<void> {
  await ensureParent();
  const tmp = join(dirname(SESSIONS_PATH), `${randomUUID().slice(0, 8)}.sess.tmp`);
  await writeFile(tmp, JSON.stringify({ sessions: all }, null, 2) + "\n", "utf8");
  await rename(tmp, SESSIONS_PATH);
}

export async function listSessions(): Promise<SessionMeta[]> {
  return Object.values(await readAll())
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getSession(sessionId: string): Promise<SessionMeta | null> {
  const all = await readAll();
  return all[sessionId] ?? null;
}

export interface CreateSessionOpts {
  title?: string;
  
  workspace?: string;
  
  memberIds?: MemberEntry[];
  
  leaderModel?: string;
  
  type?: "normal" | "brainstorm";
}

export async function createSession(agentId: string, opts?: CreateSessionOpts): Promise<SessionMeta> {
  const members = withoutMember(opts?.memberIds ?? [], agentId);
  const meta: SessionMeta = {
    id: `s_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    agentId,
    workspace: opts?.workspace?.trim() || undefined,
    members: members.length > 0 ? members : undefined,
    leaderModel: opts?.leaderModel?.trim() || undefined,
    type: opts?.type,
    title: (opts?.title ?? "").trim() || DEFAULT_TITLE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await withWriteLock(async () => {
    const all = await readAll();
    all[meta.id] = meta;
    await atomicWrite(all);
  });
  return meta;
}


export async function setSessionType(sessionId: string, type: "normal" | "brainstorm" | null): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    if (type === "brainstorm") {
      meta.type = "brainstorm";
    } else {
      delete meta.type;
    }
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}


export async function setSessionAgent(sessionId: string, agentId: string): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    meta.agentId = agentId;
    
    const members = withoutMember(meta.members ?? [], agentId);
    meta.members = members.length > 0 ? members : undefined;
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}









export function effectiveModelChoice(sessionChoice: string | undefined, agentChoice: string | undefined): string {
  const s = (sessionChoice ?? "").trim();
  if (s) { return s; }
  return (agentChoice ?? "").trim();
}





export async function setSessionModelChoice(sessionId: string, modelChoice: string | null): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    const next = (modelChoice ?? "").trim();
    if (next) { meta.modelChoice = next; } else { delete meta.modelChoice; }
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}

export async function setSessionWorkspace(sessionId: string, workspace: string | null): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    meta.workspace = (workspace ?? "").trim() || undefined;
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}


export async function setSessionMembers(sessionId: string, memberIds: MemberEntry[]): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    
    
    const oldEffort = memberEffortsOf(meta.members);
    
    const seen = new Set<string>();
    const members = withoutMember(memberIds ?? [], meta.agentId)
      .filter((e) => {
        const id = typeof e === "string" ? e : e.id;
        if (seen.has(id)) { return false; }
        seen.add(id);
        return true;
      })
      .map((e) => {
        const id = typeof e === "string" ? e : e.id;
        const carry = oldEffort[id];
        if (!carry) { return e; }
        if (typeof e === "string") { return { id, effort: carry }; }
        return e.effort ? e : { ...e, effort: carry };
      });
    meta.members = members.length > 0 ? members : undefined;
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}



export async function setSessionMemberEffort(sessionId: string, memberId: string, effort: string | null): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    const clean = typeof effort === "string" && effort.trim() ? effort.trim() : null;
    if (memberId === meta.agentId) {
      
      if (clean) { meta.leaderEffort = clean; } else { delete meta.leaderEffort; }
    } else {
      
      const next = applyMemberEffort(meta.members, memberId, clean);
      if (!next) { return; }
      meta.members = next.length > 0 ? next : undefined;
    }
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}













export async function setSessionSummary(
  sessionId: string,
  summary: string | null,
  keep = 6,
  opts?: { comprehend?: string | null; bumpGeneration?: boolean },
): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    if (summary && summary.trim()) {
      meta.contextSummary = summary.trim();
    } else {
      
      delete meta.contextSummary;
    }
    meta.summaryCount = Math.max(1, Math.floor(keep));
    const comprehend = opts?.comprehend;
    if (comprehend && comprehend.trim()) {
      meta.contextComprehend = comprehend.trim();
    } else {
      delete meta.contextComprehend;
    }
    if (opts?.bumpGeneration !== false) {
      meta.summaryGeneration = (meta.summaryGeneration ?? 0) + 1;
    }
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}


export async function ensureDefaultSession(agentId: string): Promise<SessionMeta> {
  const all = await readAll();
  const existing = Object.values(all)
    .filter((s) => s.agentId === agentId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (existing.length > 0) {
    return existing[0];
  }
  return createSession(agentId);
}

export async function renameSession(sessionId: string, title: string): Promise<SessionMeta | null> {
  const clean = title.trim();
  if (!clean) {
    return null;
  }
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) {
      return;
    }
    meta.title = clean.slice(0, 80);
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}


export async function touchSessionWithMessage(sessionId: string, firstUserMsg: string): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) {
      return;
    }
    meta.updatedAt = new Date().toISOString();
    if (meta.title === DEFAULT_TITLE) {
      const hint = firstUserMsg.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 12) || DEFAULT_TITLE;
      meta.title = hint;
    }
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}

export async function removeSession(sessionId: string): Promise<boolean> {
  let removed = false;
  await withWriteLock(async () => {
    const all = await readAll();
    if (all[sessionId]) {
      delete all[sessionId];
      await atomicWrite(all);
      removed = true;
    }
  });
  return removed;
}


export async function removeSessionsForAgent(agentId: string): Promise<number> {
  let removed = 0;
  await withWriteLock(async () => {
    const all = await readAll();
    let changed = false;
    for (const [id, meta] of Object.entries(all)) {
      if (meta.agentId === agentId) {
        delete all[id];
        changed = true;
        removed++;
      }
    }
    if (changed) {
      await atomicWrite(all);
    }
  });
  return removed;
}


export async function removeSessionsForWorkspace(workspace: string): Promise<Array<{ sessionId: string; agentId: string }>> {
  const removed: Array<{ sessionId: string; agentId: string }> = [];
  await withWriteLock(async () => {
    const all = await readAll();
    let changed = false;
    for (const [id, meta] of Object.entries(all)) {
      if (meta.workspace === workspace) {
        removed.push({ sessionId: id, agentId: meta.agentId });
        delete all[id];
        changed = true;
      }
    }
    if (changed) {
      await atomicWrite(all);
    }
  });
  return removed;
}
