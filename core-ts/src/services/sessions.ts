/**
 * core-ts/src/services/sessions.ts — 会话元数据存储（GUI 项目内独立会话）。
 * - config/sessions.json：{ sessions: { [id]: { id, agentId, title, createdAt, updatedAt } } }
 * - 会话 = 项目（Agent）内独立对话；标题默认"新对话"，首条用户消息后自动命名，
 *   用户可随时重命名
 * - 历史记录（history.jsonl）携带 session_id；旧记录无 session_id 归入该 Agent 首个会话
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export { PROJECT_ROOT };
export const SESSIONS_PATH = join(PROJECT_ROOT, "config", "sessions.json");

export interface SessionMeta {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

export async function createSession(agentId: string, title?: string): Promise<SessionMeta> {
  const meta: SessionMeta = {
    id: `s_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    agentId,
    title: (title ?? "").trim() || DEFAULT_TITLE,
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

/** 确保 Agent 至少有一个会话（无则创建默认会话；旧数据惰性迁移） */
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

/** 首条用户消息到达：若标题仍为默认名则自动命名（前 12 字，去标点） */
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

/** 删除 Agent 时清理其全部会话元数据 */
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
