/**
 * core-ts/src/services/sessions.ts — 会话元数据存储（GUI 项目内独立会话）。
 * - config/sessions.json：{ sessions: { [id]: { id, agentId, workspace, title, createdAt, updatedAt } } }
 * - 会话 = 目标工作文件夹（项目）内独立对话，会话内指定调用哪个 Agent（可随时切换）；
 *   标题默认"新对话"，首条用户消息后自动命名，用户可随时重命名
 * - workspace：会话级工作目录锚点（"以文件夹为主"模型：新建会话选文件夹，工具操作限定在文件夹内）
 * - 历史记录（history.jsonl）携带 session_id；旧记录无 session_id 归入该 Agent 首个会话
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export { PROJECT_ROOT };
export const SESSIONS_PATH = join(PROJECT_ROOT, "config", "sessions.json");

/** A-954 成员条目：纯 id（旧数据/普通团队）或 { id, model }（群聊步进选择——模型在入群时确定） */
export type MemberEntry = string | { id: string; model?: string };

/** 成员条目 → id 列表（去重保序） */
export function memberIdsOf(entries?: MemberEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries ?? []) {
    const id = typeof e === "string" ? e : e.id;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** 成员条目 → id→model 映射（仅 { id, model } 形态参与） */
export function memberModelsOf(entries?: MemberEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries ?? []) {
    if (typeof e === "object" && e && e.model) { out[e.id] = e.model; }
  }
  return out;
}

/** 剔除指定成员（组长切换/删员共用；兼容对象条目） */
function withoutMember(entries: MemberEntry[], agentId: string): MemberEntry[] {
  return (entries ?? []).filter((e) => e !== agentId && (typeof e === "string" ? e !== agentId : e.id !== agentId));
}

export interface SessionMeta {
  id: string;
  /** 会话当前调用的 Agent（会话内可随时切换；团队会话中为组长） */
  agentId: string;
  /** 目标工作文件夹（会话级；Agent 的工具操作锚定到该目录）。旧数据可能为空 → 归入「未绑定文件夹」组 */
  workspace?: string;
  /** 团队成员条目（组长=agentId；不含组长；空/缺省 = 单人会话）。string=旧数据；{id,model}=群聊带模型入群 */
  members?: MemberEntry[];
  /** A-954 群聊组长的入群模型（会话归属 Agent=组长；缺省用其 agent.model_choice） */
  leaderModel?: string;
  /** A-943 会话模式：brainstorm = 群聊头脑风暴（发议题→全员并行发言→组长收束）；缺省 = 普通（保留 <DELEGATE> 传唤） */
  type?: "normal" | "brainstorm";
  title: string;
  createdAt: string;
  updatedAt: string;
  /** A-969 上下文自动压缩：早期对话的压缩摘要（写入后 loadSessionHistory 将旧轮替换为摘要头 + 最近 K 轮） */
  contextSummary?: string;
  /** 压缩后保留的尾部轮数（K；伴随 contextSummary 写入） */
  summaryCount?: number;
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
  /** 目标工作文件夹（以文件夹为主的会话模型）；缺省为空（归入「未绑定文件夹」组） */
  workspace?: string;
  /** 团队成员条目（组长=agentId；不含组长；可选，空=单人会话）。群聊可带 { id, model } */
  memberIds?: MemberEntry[];
  /** A-954 群聊组长入群模型（会话归属 Agent=组长） */
  leaderModel?: string;
  /** A-943 会话模式：brainstorm = 群聊头脑风暴；缺省 normal */
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

/** A-943：切换会话模式（normal 普通 / brainstorm 群聊头脑风暴）；持久化 + 更新排序 */
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

/** 会话内切换调用的 Agent（保留工作文件夹/标题/历史；更新 updatedAt 刷新排序） */
export async function setSessionAgent(sessionId: string, agentId: string): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    meta.agentId = agentId;
    // 组长切换后，从成员列表剔除新组长（避免"组长同时是成员"的展示歧义；引擎侧 teamContextFor 已过滤，此处同步清理持久化）
    const members = withoutMember(meta.members ?? [], agentId);
    meta.members = members.length > 0 ? members : undefined;
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}

/** 会话级工作目录更新（"以文件夹为主"模型：workspace 存会话 meta，不再写 Agent sandbox_override） */
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

/** 团队会话成员更新（组长=meta.agentId，自动排除；空数组 = 退回单人会话）。群聊条目可带 { id, model } */
export async function setSessionMembers(sessionId: string, memberIds: MemberEntry[]): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    // 按 id 去重（保留后出现的条目，即模型选择最新态）
    const seen = new Set<string>();
    const members = withoutMember(memberIds ?? [], meta.agentId).filter((e) => {
      const id = typeof e === "string" ? e : e.id;
      if (seen.has(id)) { return false; }
      seen.add(id);
      return true;
    });
    meta.members = members.length > 0 ? members : undefined;
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
}

/** A-969 上下文自动压缩：写入会话压缩摘要（summary=null 时清空旧摘要——会话已压缩但摘要不可用时避免陈旧摘要误导模型） */
export async function setSessionSummary(sessionId: string, summary: string | null, keep = 12): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    if (summary && summary.trim()) {
      meta.contextSummary = summary.trim();
      meta.summaryCount = Math.max(2, keep);
    } else {
      delete meta.contextSummary;
      delete meta.summaryCount;
    }
    meta.updatedAt = new Date().toISOString();
    await atomicWrite(all);
    updated = meta;
  });
  return updated;
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

/** 删除文件夹项目时清理该工作目录下全部会话元数据（新模型：以文件夹为主分组） */
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
