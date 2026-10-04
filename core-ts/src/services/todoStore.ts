


















import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface StoredTodo {
  id: string;
  content: string;
  status: TodoStatus;
  
  blockedBy?: string[];
  blocks?: string[];
  
  completedAt?: string;
}

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];


export const TODO_CONTENT_MAX = 500;

export const TODO_RENDER_MAX = 30;

function dataDir(): string {
  return join(PROJECT_ROOT, "data");
}

























function encodeSessionId(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}







export function todoPath(sessionId: string): string | null {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return null; }
  try { mkdirSync(dataDir(), { recursive: true }); } catch {  }
  return join(dataDir(), `todos_${encodeSessionId(sid)}.json`);
}


function sanitize(raw: Record<string, unknown>): StoredTodo | null {
  const content = String(raw.content ?? "").trim().slice(0, TODO_CONTENT_MAX);
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  
  if (!content && !id) { return null; }
  const statusRaw = String(raw.status ?? "");
  return {
    id,
    content,
    status: TODO_STATUSES.includes(statusRaw as TodoStatus) ? statusRaw as TodoStatus : "pending",
    blockedBy: Array.isArray(raw.blockedBy) ? (raw.blockedBy as string[]).filter((x) => typeof x === "string").slice(0, 10) : undefined,
    blocks: Array.isArray(raw.blocks) ? (raw.blocks as string[]).filter((x) => typeof x === "string").slice(0, 10) : undefined,
    completedAt: typeof raw.completedAt === "string" && raw.completedAt ? raw.completedAt : undefined,
  };
}









export function normalizeTodos(items: StoredTodo[]): StoredTodo[] {
  let seenActive = false;
  return items.map((it) => {
    let status = it.status;
    if (status === "in_progress") {
      if (seenActive) { status = "pending"; } else { seenActive = true; }
    }
    if (status === "completed") {
      return it.completedAt ? { ...it, status } : { ...it, status, completedAt: new Date().toISOString() };
    }
    
    return it.completedAt ? { ...it, status, completedAt: undefined } : { ...it, status };
  });
}















export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {  } }
  }
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bak`); } catch {  }
  }
  renameSync(tmp, path);
}


export function readTodos(sessionId: string): StoredTodo[] {
  const p = todoPath(sessionId);
  if (!p) { return []; }
  
  
  const candidates = [p, `${p}.bak`];
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const parsed = JSON.parse(readFileSync(candidates[i], "utf8")) as { items?: unknown };
      if (!Array.isArray(parsed.items)) { continue; }
      return parsed.items
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map(sanitize)
        .filter((x): x is StoredTodo => x !== null)
        .map((x) => ({ ...x, id: x.id || randomId() }));
    } catch {
      if (i === 0 && existsSync(candidates[0])) {
        try { renameSync(candidates[0], `${candidates[0]}.corrupt`); } catch {  }
      }
    }
  }
  return [];
}


export function writeTodos(sessionId: string, items: StoredTodo[]): StoredTodo[] | null {
  const p = todoPath(sessionId);
  if (!p) { return null; }
  const normalized = normalizeTodos(items);
  writeFileAtomic(p, JSON.stringify({ updated_at: new Date().toISOString(), schema: 2, items: normalized }, null, 2));
  return normalized;
}












export function removeTodos(sessionId: string): void {
  const p = todoPath(sessionId);
  if (!p) { return; }
  for (const suffix of ["", ".bak", ".corrupt"]) {
    try { rmSync(`${p}${suffix}`, { force: true }); } catch {  }
  }
  try {
    const prefix = `${basename(p)}.`;
    for (const name of readdirSync(dataDir())) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        try { rmSync(join(dataDir(), name), { force: true }); } catch {  }
      }
    }
  } catch {  }
}


export function hasTodos(sessionId: string): boolean {
  const p = todoPath(sessionId);
  return p !== null && existsSync(p);
}


export function todoProgress(items: StoredTodo[]): { done: number; total: number; pct: number } {
  const total = items.length;
  const done = items.filter((t) => t.status === "completed").length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}























export function demoteStaleInProgress(sessionId: string): number {
  const items = readTodos(sessionId);
  if (items.length === 0) { return 0; }
  const stale = items.filter((t) => t.status === "in_progress");
  if (stale.length === 0) { return 0; }
  const next = items.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" as const } : t));
  writeTodos(sessionId, next);
  return stale.length;
}







export function renderTodos(items: StoredTodo[]): string {
  if (items.length === 0) { return "（待办列表为空）"; }
  const shown = items.slice(0, TODO_RENDER_MAX);
  const lines = shown.map((it) => {
    const mark = it.status === "completed" ? "[x]" : "[ ]";
    const tail = it.status === "in_progress" ? "   ← 进行中" : "";
    return `- ${mark} ${it.content}${tail}`;
  });
  if (items.length > shown.length) { lines.push(`…（其余 ${items.length - shown.length} 项略）`); }
  const { done, total } = todoProgress(items);
  const active = items.find((i) => i.status === "in_progress");
  const head = `进度 ${done}/${total}` + (active ? ` · 当前进行中：${active.content}` : " · 当前无进行中项");
  return `${head}\n\n${lines.join("\n")}`;
}


export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}


export function todosToPlanStatus(items: StoredTodo[]): "planning" | "active" | "done" {
  if (items.length === 0) { return "planning"; }
  const done = items.filter((t) => t.status === "completed").length;
  if (done === items.length) { return "done"; }
  return items.some((t) => t.status !== "pending") ? "active" : "planning";
}
























export function planReminderText(items: StoredTodo[]): string | null {
  if (items.length === 0) { return null; }
  const { done, total } = todoProgress(items);
  if (done >= total && total > 0) { return null; }
  return [
    "[当前任务计划 · 请接着未完成的项继续]",
    renderTodos(items),
    "要求：接着上面未完成的项继续推进；已完成的**不要重做**；" +
    "如果计划本身需要调整，调用 todo_write 更新它（不要只在正文里口头改）。",
    



    "收尾要求：在宣布本阶段完成**之前**，必须调用 todo_write 把确实做完的项改成 completed、" +
    "仍在做的保持 in_progress —— 用户正看着这张清单，别让它停在半途。",
  ].join("\n\n");
}















export function planReconcileText(sessionId: string): string | null {
  if (!sessionId) { return null; }
  return planReconcileFromTodos(readTodos(sessionId));
}


export function planReconcileFromTodos(items: StoredTodo[]): string | null {
  const open = items.filter((t) => t.status !== "completed");
  if (open.length === 0) { return null; }
  return [
    "[计划收尾核对 · 本轮运行即将结束]",
    renderTodos(items),
    `还有 ${open.length} 项没标完成：${open.map((t) => `「${t.content}」(${t.status})`).join("、")}。`,
    "现在二选一，**不要沉默地跳过**：",
    "· 已经真正做完的 → 立刻调 todo_write 把它改成 completed；",
    "· 确实没做完 / 确实不打算做的 → 保持或调整状态，并用一句话说清为什么留到下一轮。",
  ].join("\n\n");
}
