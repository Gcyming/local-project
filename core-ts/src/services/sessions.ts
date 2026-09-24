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

/** A-1011 成员条目：纯 id（旧数据/普通团队）或 { id, model?, effort? }（群聊步进选择——模型/推理强度在入群后可在会话内调整） */
export type MemberEntry = string | { id: string; model?: string; effort?: string };

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

/** A-1011 成员条目 → id→effort 映射（仅 { id, effort } 形态参与；缺省 = 该成员用群聊默认强度） */
export function memberEffortsOf(entries?: MemberEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries ?? []) {
    if (typeof e === "object" && e && e.effort) { out[e.id] = e.effort; }
  }
  return out;
}

/** A-1011 对成员条目列表应用/清除某成员的推理强度覆盖（纯函数，不碰 fs）。
 *  - effort 非空 → 写入该成员条目（string 条目升级为对象条目）
 *  - effort 为空/null → 清除覆盖；清除后条目若既无 model 也无 effort → 还原为纯 id 字符串（保持 JSON 干净、不改变旧数据形态）
 *  - 该 id 不在列表中 → 返回 null（调用方据此报错，绝不静默丢弃用户操作）
 *  - 不修改入参数组（返回新数组；未命中/未变化时也要返回新数组，语义由 null 表达"未命中"） */
export function applyMemberEffort(entries: MemberEntry[] | undefined, memberId: string, effort: string | null): MemberEntry[] | null {
  const src = entries ?? [];
  let hit = false;
  const next = src.map((e) => {
    const isObj = typeof e === "object" && e !== null;
    const id = isObj ? e.id : e;
    if (id !== memberId) { return e; } // 其余条目保持原对象/原字符串引用
    hit = true;
    if (!effort) {
      // 清除覆盖：原 string 直接保持 string；原对象剔除 effort，若 model 也空则还原为纯 id 字符串
      if (!isObj) { return e; }
      if (e.model) { return { id: e.id, model: e.model }; }
      return e.id;
    }
    // 写入覆盖：string → 对象；对象 → 补/改 effort
    if (!isObj) { return { id: memberId, effort }; }
    return { ...e, effort };
  });
  if (!hit) { return null; }
  return next;
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
  /** A-1011 群聊组长（会话归属 Agent）的推理强度覆盖（群聊专属；缺省 = 群聊默认 high） */
  leaderEffort?: string;
  /** A-943 会话模式：brainstorm = 群聊头脑风暴（发议题→全员并行发言→组长收束）；缺省 = 普通（保留 <DELEGATE> 传唤） */
  type?: "normal" | "brainstorm";
  title: string;
  createdAt: string;
  updatedAt: string;
  /** A-969 上下文自动压缩：早期对话的压缩摘要（写入后 loadSessionHistory 将旧轮替换为摘要头 + 最近 K 轮） */
  contextSummary?: string;
  /** 压缩后保留的尾部**轮数**（K；A-1082 起单位为「轮」而非「消息条数」）。
   *  ⚠️ 与 `contextSummary` **互相独立**：摘要不可用时（trim 档）仍会写 summaryCount，
   *  此时 loadSessionHistory 走「只裁不摘要」——这是 A-1082 修掉「假压缩」的关键：
   *  旧实现把两者绑死（summary=null ⇒ 连带删掉 summaryCount），导致降级路径**什么都没裁**。 */
  summaryCount?: number;
  /** A-1082 压缩后「理解总结」环产出的续接认知（5 字段自述；随摘要一并注入） */
  contextComprehend?: string;
  /** A-1082 压缩代次（单调 +1）。压缩是异步的，写入侧用它做 skip-stale（防止过期压缩覆盖新结果） */
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

/** 团队会话成员更新（组长=meta.agentId，自动排除；空数组 = 退回单人会话）。群聊条目可带 { id, model?, effort? } */
export async function setSessionMembers(sessionId: string, memberIds: MemberEntry[]): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    // A-1011 防护：成员名单一旦重发就会把用户调好的推理强度静默抹掉。
    // 入参条目若未携带 effort，但旧 meta.members 里该 id 已有 effort，则沿用旧值（string 条目升级为对象条目）。
    const oldEffort = memberEffortsOf(meta.members);
    // 按 id 去重（保留后出现的条目，即模型选择最新态）
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

/** A-1011 群聊成员推理强度（仅群聊用；memberId === meta.agentId 时写 leaderEffort，否则写 members 对应条目）。
 *  effort=null → 清除覆盖（回落群聊默认 high）。返回 null 表示会话不存在或该成员不在群聊中。 */
export async function setSessionMemberEffort(sessionId: string, memberId: string, effort: string | null): Promise<SessionMeta | null> {
  let updated: SessionMeta | null = null;
  await withWriteLock(async () => {
    const all = await readAll();
    const meta = all[sessionId];
    if (!meta) { return; }
    const clean = typeof effort === "string" && effort.trim() ? effort.trim() : null;
    if (memberId === meta.agentId) {
      // 组长（会话归属 Agent）走 leaderEffort
      if (clean) { meta.leaderEffort = clean; } else { delete meta.leaderEffort; }
    } else {
      // 其余成员走 members 条目；未命中（不在群聊）直接 return（不写盘），外层 updated 保持 null
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

/**
 * A-969/A-1082 上下文自动压缩：写入会话压缩产物。
 *
 * ⚠️ **语义修正（A-1082）**：`summary` 为 null 时**不再连带删除 `summaryCount`**。
 * 旧实现把两者绑死，而 `loadSessionHistory` 的注入条件是 `if (meta.contextSummary && …)` ⇒
 * 摘要不可用的「降级硬裁剪」路径被判为假 ⇒ **返回完整未裁剪历史**：界面报「已压缩 N 轮」，
 * 实际一个字符都没少 ⇒ 原样重发再次超限（用户症状「压缩并非真压缩」的根因）。
 *
 * @param keep         保留的尾部轮数（K，单位=轮）；任何一次压缩都必须写，无论摘要是否成功
 * @param comprehend   「理解总结」环产出的续接认知（无则清空）
 * @param bumpGeneration 是否推进 `summaryGeneration`（每次真实压缩落地时 +1）
 */
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
      // 只清摘要文本：summaryCount 必须保留，否则 trim 档失效（见函数头说明）
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
