/**
 * core-ts/src/services/todoStore.ts — 会话级待办存储：**唯一真源**。
 *
 * 为什么单独抽这一层（A-980-R29）：
 * 待办文件原先由两个进程各自手搓——`tools/builtin.ts` 自己的 `todoPath()` + 解析 + 归一化，
 * `gui/src/main/index.ts` 又在**三处**（planFromToolResult / loadTodos / broadcastTodos）
 * 重复拼 `join(PROJECT_ROOT, "data", `todos_${sid}.json`)` 并各写一遍容错解析。
 * 后果：格式一变就要改四处、漏一处也不报错（R27 的"两条链路读的不是同一个文件"就是这么来的）。
 * 现在路径、容错读取、归一化（单一 in_progress / completedAt 打戳）、渲染全在这一个文件里。
 *
 * ⚠️ 三条铁律（都踩过坑）：
 * ① **sessionId 为空必须拒绝**。`todos_` + `""` + `.json` 会拼出一个看似正常的文件名
 *    `data/todos_.json`，那正是 R27 遗留孤儿文件的名字——空值当路径片段＝静默读到别人的数据。
 * ② 状态归一化（最多一个 in_progress、completedAt 自动打/撤戳）**只能在这里做一次**，
 *    否则工具写的和主进程读的口径会漂移。
 * ③ **sessionId 绝不能直接当路径片段用**（A-987）。子代理 id `__subagent__:<runId>` 含冒号，
 *    在 NTFS 上会被解析成备用数据流 → `data/` 里冒出 0 字节幽灵文件、不同 runId 共用同一个
 *    基名文件、打包备份丢流。必须经 `encodeSessionId()` 转成单段合法文件名（`%XX` 转义）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, openSync, writeSync, closeSync, fsyncSync, renameSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROJECT_ROOT } from "../paths.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface StoredTodo {
  id: string;
  content: string;
  status: TodoStatus;
  /** 前置依赖的任务 id（目前仅存储与展示，不做阻塞计算） */
  blockedBy?: string[];
  blocks?: string[];
  /** 完成时刻（ISO）——状态转入 completed 时自动打戳，界面据此展示"何时完成" */
  completedAt?: string;
}

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** 单条内容长度上限（防止模型把整段正文塞进一条任务） */
export const TODO_CONTENT_MAX = 500;
/** 渲染/回填上下文时最多列出的条数（避免复述把上下文撑爆） */
export const TODO_RENDER_MAX = 30;

function dataDir(): string {
  return join(PROJECT_ROOT, "data");
}

/**
 * 会话 id → **单段合法文件名**（A-987）。
 *
 * ⚠️ 千万别把 `todos_${sid}.json` 直接拼回去。子代理的会话 id 形如
 * `__subagent__:<runId>`（见 gui/src/main/index.ts 的 `SUBAGENT_SESSION_PREFIX`），**含冒号**；
 * 而 NTFS 上 `a:b` 的 `:` 表示**备用数据流（ADS）**。实测复现（本机 node，2026-09-17）：
 *
 * ```
 * fs.writeFileSync("data/ads_probe___subagent__:RUNID123.json", "…")   // 不报错
 * → 目录里冒出 ads_probe___subagent__（size=0）
 * → fs.readFileSync("…:RUNID123.json") 却能把内容读回来
 * ```
 *
 * 也就是说本地"看起来是对的"，直到三个后果陆续兑现：
 *   ① `data/` 里堆出一个 **0 字节幽灵文件** —— 这正是用户截图上看到的"不存在的任务"残留物
 *      （现场遗留物：`data/todos___subagent__`，0 字节，而任何代码路径都读不到它）；
 *   ② **所有子代理共用同一个基名文件**，不同 runId 只是同一文件上的不同数据流 ——
 *      `removeTodos` 删基名会把别人正在跑的流一起抹掉；
 *   ③ 备份/打包/同步（zip、git、rsync、拷到别的盘）只带走基名文件，**数据流全部丢失且不报错**。
 *
 * 做法：把 `[A-Za-z0-9._-]` 之外的一切按 `%XX` 转义。结果仍是**单段**文件名（不含 `/\`，
 * 也不含转义歧义，因为 `%` 自身也会被编码成 `%25`）。普通会话 id（`s_9ca48dbc9acc` 这类）
 * 编码前后一字不变 → **既有文件不需要迁移**。
 */
function encodeSessionId(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * 待办文件路径。`sessionId` 为空时返回 `null`（**不抛**，让调用方走"无待办"分支）。
 *
 * 返回 null 而不是拼出 `todos_.json`：空值当路径片段是最隐蔽的一类越权/脏读，
 * 宁可在类型上强制调用方处理。
 */
export function todoPath(sessionId: string): string | null {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) { return null; }
  try { mkdirSync(dataDir(), { recursive: true }); } catch { /* 目录创建失败交给后续读写如实报错 */ }
  return join(dataDir(), `todos_${encodeSessionId(sid)}.json`);
}

/** 清洗单条（模型给什么都能收，但落盘的必须合法） */
function sanitize(raw: Record<string, unknown>): StoredTodo | null {
  const content = String(raw.content ?? "").trim().slice(0, TODO_CONTENT_MAX);
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  // content 与 id 双空 = 完全无信息的项，丢弃
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

/**
 * 归一化：收敛成"可直接落盘 + 可直接渲染"的合法状态。
 *
 * 两条硬规则（Anthropic TodoWrite / OpenAI update_plan / LangChain write_todos 的共识）：
 * ① **同时最多一个 in_progress**——多个会让"现在在做什么"变含糊；这里保留第一个、其余降 pending
 *    （**不报错**：报错会让模型反复试探，浪费往返）。
 * ② **completedAt 自动打/撤戳**——转入 completed 补时间戳，退回未完成清掉，模型不必自己算时间。
 */
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
    // 非 completed：清掉残留的 completedAt（JSON.stringify 会丢弃 undefined 键）
    return it.completedAt ? { ...it, status, completedAt: undefined } : { ...it, status };
  });
}

/**
 * **原子写文件**（A-986 意外退出防护）。
 *
 * 为什么不能直接 `writeFileSync` 覆盖：那一步在"写出新内容"的瞬间就**先截断了旧文件**，
 * 进程若在此刻被强杀 / 断电，盘上留下的是**半个 JSON** —— 而 `readTodos` 解析失败会返回 `[]`，
 * 于是"待办全没了"，且用户完全不知道为什么。待办是用户手工积累的进度账，这是最不能丢的数据之一。
 *
 * 三步保证"要么是旧内容、要么是新内容，永远不会是半截"：
 *   ① 写临时文件 + **fsync**（内容真正落盘，而不是停在 OS 缓存里等着被丢）；
 *   ② 把**旧的完好内容**留一份 `.bak`（新内容万一损坏，还有一份可回退）；
 *   ③ 同目录 `rename` 覆盖 —— POSIX 与 NTFS 上都是**原子**操作，不存在"写到一半"的中间态。
 *
 * 残留的 `.tmp` 由启动时的 `sweepStaleTempFiles()` 清理（见 gui/src/main/crashGuard.ts）。
 */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 关闭失败也要继续走 rename */ } }
  }
  if (existsSync(path)) {
    try { copyFileSync(path, `${path}.bak`); } catch { /* 备份失败不阻断主流程 */ }
  }
  renameSync(tmp, path);
}

/** 读取会话待办（文件缺失/损坏/空 sessionId 一律返回空表，绝不抛） */
export function readTodos(sessionId: string): StoredTodo[] {
  const p = todoPath(sessionId);
  if (!p) { return []; }
  // A-986：主文件解析失败 → 回退 `.bak`（原子写留下的上一份完好内容）。
  // 两份都读不出来才返回空表，并把损坏文件**改名留证**（静默丢弃会让"为什么没了"变成悬案）。
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
        try { renameSync(candidates[0], `${candidates[0]}.corrupt`); } catch { /* 留证失败不阻断 */ }
      }
    }
  }
  return [];
}

/** 写入会话待办（自动归一化 + **原子落盘**）；返回真正落盘的归一化结果。sessionId 为空 / 路径不可写 → null */
export function writeTodos(sessionId: string, items: StoredTodo[]): StoredTodo[] | null {
  const p = todoPath(sessionId);
  if (!p) { return null; }
  const normalized = normalizeTodos(items);
  writeFileAtomic(p, JSON.stringify({ updated_at: new Date().toISOString(), schema: 2, items: normalized }, null, 2));
  return normalized;
}

/**
 * 删除会话待办（会话/Agent/工作区删除、用户「清空」、全部完成自动清空时调用）。
 *
 * A-987（用户实测"删了又回来"）：只删主文件是**语义上的假删除**。`readTodos` 的候选列表是
 * `[主文件, 主文件.bak]`——主文件一没，就会**从 `.bak` 把刚清掉的整张清单原样读回来**：
 *   清空 → 切会话 / 重启 → 幽灵任务原地复活，用户看到的就是"不存在的任务依旧排在列表里"。
 * 原子写留下的**每一份派生物都必须跟着一起走**，删除才成立：
 *   - `.bak`：`writeFileAtomic` 每次写入前留的上一份完好内容（复活源头）；
 *   - `.corrupt`：`readTodos` 对损坏主文件的**改名留证**（不删就一直挂在 data/ 里）；
 *   - `todos_x.json.<pid><ts>.tmp`：落盘途中被强杀留下的半成品（crashGuard 只清 60s 以上的）。
 */
export function removeTodos(sessionId: string): void {
  const p = todoPath(sessionId);
  if (!p) { return; }
  for (const suffix of ["", ".bak", ".corrupt"]) {
    try { rmSync(`${p}${suffix}`, { force: true }); } catch { /* 删不掉不影响调用方流程 */ }
  }
  try {
    const prefix = `${basename(p)}.`;
    for (const name of readdirSync(dataDir())) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        try { rmSync(join(dataDir(), name), { force: true }); } catch { /* 占用中则下次再说 */ }
      }
    }
  } catch { /* 列目录失败不影响删除本身 */ }
}

/** 会话是否已有待办文件 */
export function hasTodos(sessionId: string): boolean {
  const p = todoPath(sessionId);
  return p !== null && existsSync(p);
}

/** 进度统计（界面进度条 / "全部完成" 徽标共用） */
export function todoProgress(items: StoredTodo[]): { done: number; total: number; pct: number } {
  const total = items.length;
  const done = items.filter((t) => t.status === "completed").length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/**
 * 把"没有流在跑却停在 in_progress"的项降级为 `pending`（A-985）。
 *
 * 为什么必须做这件事：`in_progress` 的语义是 **"此刻有人在干这一项"**，
 * 界面据此渲染**转圈的加载图标 + 高亮行 + 「进行中 N」**。而待办是**落盘**的真源，
 * 没有任何机制会在"干活的进程没了"时把它收回来 —— 于是：
 *   - App 卡死 → 任务管理器强杀 → 重启后，那一项**永远停在"进行中"**，
 *     转圈图标一直转、行一直高亮，但根本没人在跑（用户实测："我并未输入任何命令，
 *     列表却显示一个任务在进行中"）；
 *   - 模型中途放弃/被打断同理。
 *
 * 这与"全部完成 → 自动清空"是**两件不同的事**：那个管的是"做完的收走"，
 * 这个管的是"没人在做的别假装在做"。二者都必须落在**存储层**（渲染层改内存镜像
 * 会被下一次读盘原样覆盖回来，症状是"重启后僵尸又回来了"）。
 *
 * ⚠️ **只在确证"该会话没有活跃流"时调用**：否则会把正在跑的任务误降级。
 * 调用点（`slime:sessions:loadTodos` 首次读盘）用 `activeChats` 判定，见 gui/src/main/index.ts。
 *
 * 降级只改状态、不动内容：进度信息（哪些已完成）完整保留，用户不会丢东西。
 *
 * @returns 实际被降级的条数（0 = 无需改动，此时不写盘，避免无谓的文件抖动）
 */
export function demoteStaleInProgress(sessionId: string): number {
  const items = readTodos(sessionId);
  if (items.length === 0) { return 0; }
  const stale = items.filter((t) => t.status === "in_progress");
  if (stale.length === 0) { return 0; }
  const next = items.map((t) => (t.status === "in_progress" ? { ...t, status: "pending" as const } : t));
  writeTodos(sessionId, next);
  return stale.length;
}

/**
 * 渲染成复选框清单——**回填进上下文**，起 Manus「目标复述（recitation）」的作用。
 *
 * 长任务平均几十次工具调用，早期写下的计划会沉到上下文中段（lost-in-the-middle）而失效；
 * 每次调用把计划重写到上下文末尾，就是用 recency 偏置把目标顶回高注意力区。
 */
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

/** 任务 id（工具与主进程共用一套生成规则，便于日志对齐） */
export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 由待办表推导计划状态（供 Plan 派生使用；不再是恒定的 "planning"） */
export function todosToPlanStatus(items: StoredTodo[]): "planning" | "active" | "done" {
  if (items.length === 0) { return "planning"; }
  const done = items.filter((t) => t.status === "completed").length;
  if (done === items.length) { return "done"; }
  return items.some((t) => t.status !== "pending") ? "active" : "planning";
}
