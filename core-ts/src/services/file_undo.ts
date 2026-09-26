/**
 * core-ts/src/services/file_undo.ts — A-1122（③）：**「改动账本」的唯一出处**。
 *
 * ## 它解决的是什么
 *
 * 回滚（`rollbackTo`）此前只做两件事：改前端 `messages` + 截断 `history.jsonl`。
 * **磁盘上的文件一个都没动** —— 于是「回滚了消息，但 Agent 改过的文件还是改过的」，
 * 用户以为回滚干净了。这是本模块存在的唯一理由。
 *
 * ## 为什么需要一个账本，而不是"回滚时去猜"
 *
 * 改前内容只有**写入那一刻**才知道（`file_write` 覆盖前读过旧内容，但此前只喂给 diff 显示、
 * 不落盘）。事后无法重建 ⇒ 必须在写入时留痕。对话里其实已经有一份 base64 的 diff 标记
 * （`[__slime_diff__]old|new`），但它**不是结构化数据**、还会被 `TRACE_DIFF_MAX` 截断
 * （超限只留一个占位标记）⇒ 拿它还原必然出现"有些文件还原不了，而且没人知道"。
 *
 * ## 切分线怎么定（关键设计，别改错）
 *
 * 账本按 **时间** 与「上一轮结束的时刻」比较：`history.jsonl` 的每条记录是在**该轮工具跑完之后**
 * 追加的（`chat.ts` 的 `recordInteraction`）。因此
 *
 *     prevRecord.timestamp  <=  第 N 轮的所有写盘   <=   record[N].timestamp
 *
 * ⇒ 「回滚到消息 M」= 还原所有 `t >= prevRecord(M).timestamp` 的条目。
 *   · 第 M 轮**没有改动**时也成立（不需要"这一轮有账本记录"才能定位）；
 *   · `findRollbackCut` 与历史截断**共用同一个锚点**（不允许两份口径）。
 *
 * ⚠️ **两个已知边界，都写在这里而不是留给后人猜**：
 *   ① 子代理有自己的会话 id（`__subagent__:<runId>`，见 `SUBAGENT_SESSION_PREFIX`）。
 *      前台子代理在**本轮之内**跑，改动确实属于本轮 ⇒ 按前缀一并纳入。
 *      但**后台**子代理会跑出本轮之外，它在那之后写的文件会被算到"后面那一轮"头上
 *      （时间线上确实如此）——所以纳入了前缀，却仍可能晚于切分线，这是刻意接受的近似。
 *   ② 同一时间窗内**别的会话**的改动**不纳入**，但要**报数**（`foreign`）——
 *      宁可让界面说"另有 N 处改动属于其它会话、未还原"，也不要假装回滚干净了。
 *
 * ## 三条纪律
 *
 * 1. **还原失败必须出声**：`applyFileUndo` 返回 `failed[]`，调用方（渲染层横幅）必须展示。
 * 2. **无法留痕也必须出声**：例如 `file_delete` 递归删掉的目录过大 ⇒ 写一条 `skip` 条目，
 *    由 `plan` 的 `blocked[]` 如实告诉用户"这一处还原不了"。绝不静默跳过。
 * 3. **不猜**：`plan` 拿不出切分线（历史里找不到那条用户消息）时返回 `ok:false` 且 `count:0`，
 *    由调用方决定是否继续回滚对话 —— 不假称"没有文件需要还原"。
 */

import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { HISTORY_PATH, findRollbackCut, readHistoryRecords } from "./history.js";
import { isSubagentSessionId } from "./subagent.js";

/** 账本路径：默认与 history 同目录（于是测试的 `SLIME_HISTORY_PATH` 隔离自动生效） */
export const UNDO_JOURNAL_PATH = (() => {
  const env = typeof process !== "undefined" ? process.env.SLIME_FILE_UNDO_PATH : undefined;
  if (env) { return env; }
  return join(dirname(HISTORY_PATH), "file-undo.jsonl");
})();

/** 快照目录（超限内容落盘在这里 —— 这才是"能还原的那一份"） */
export const UNDO_SNAPSHOT_DIR = join(dirname(UNDO_JOURNAL_PATH), "file-undo-snapshots");

/**
 * 内联保存的旧内容上限。超过则落盘快照。
 * ⚠️ 与 `chat.ts` 的 `TRACE_DIFF_MAX`(60000) **不是一回事**：那个限的是"写进思考记录的
 * 显示标记"（超限就只留占位），这里限的是"能不能还原"。用显示限额当还原限额
 * = 大文件永远还原不了（且界面看不出来）。
 */
export const UNDO_INLINE_MAX = 64 * 1024;

/** 一次 `file_delete` 允许快照的文件数上限（超过则该次删除**不可还原**并如实报出） */
export const UNDO_DELETE_MAX_FILES = 300;

/** 一轮写入留下的账本条目 */
interface UndoEntry {
  /** 写入时刻（ms）—— 与 `findRollbackCut` 给的切分线比较 */
  t: number;
  agent_id: string;
  /** 空串 = 无会话（CLI / 测试） */
  session_id: string;
  /** 绝对路径 */
  abs: string;
  /** 改前是否存在（false ⇒ 还原时**删除**这个文件） */
  existed: boolean;
  /** 改前内容（`existed=true` 且未超限时内联） */
  old?: string;
  /** 改前内容的落盘快照文件名（超限或二进制时用；与 `old` 二选一） */
  snap?: string;
  /**
   * 快照是**二进制**（UTF-8 不可往返）⇒ 还原时必须按 Buffer 写回。
   * ⚠️ 不做这个区分就是把 PNG 当文本 `toString("utf8")` 再写回 = **静默损坏**：
   * 界面显示"回滚成功"，用户打开图片才发现坏了。
   */
  snapBin?: boolean;
  /**
   * 这一条代表一个**目录**（`file_delete` 递归删目录时记的），不是文件。还原 = `mkdir -p`。
   *
   * ⚠️ 目录**不进 `plan.items`**：用户看到的"将还原 N 个文件"必须数得清是文件；
   *   但 `applyFileUndo` 会**先**把它们重建 —— 不收目录的话，"递归删掉一个只含
   *   空子目录的目录"回滚后，那些**空目录会静默消失**（内容回来了、骨架没了）。
   */
  dir?: boolean;
  /** 这一处**无法还原**的原因（例如"递归删除的目录过大"）—— 有它就是出声 */
  skip?: string;
}

export interface UndoScope { agent_id: string; session_id: string }

/** 从工具入参里取**受信注入**的归属（`tool_loop` 先 delete 再写，模型伪造不了真对象） */
export function undoScopeOf(args: Record<string, unknown>): UndoScope | null {
  const raw = args._undo_scope as { agentId?: unknown; sessionId?: unknown } | undefined;
  if (!raw || typeof raw !== "object") { return null; }
  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";
  if (!agentId) { return null; }
  return { agent_id: agentId, session_id: typeof raw.sessionId === "string" ? raw.sessionId : "" };
}

/**
 * 记录一次「即将发生的改动」。
 *
 * ⚠️ 必须在**真正写入之前**调用（`existed` / `old` 都是改前的状态）。
 * 写账本失败**不阻断**业务写入（返回 false 让调用方知情），但**不吞**：调用方据此在回执里
 * 说明"这次改动未纳入回滚账本"。静默失败 = 用户以为能回滚、实际不能。
 */
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
      // 二进制一律落快照（JSON 字符串化会损坏内容）；文本超限也落快照
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

/** 追加一条账本记录（**唯一写入点**：目录不存在时先建 —— 别在三处各写一遍） */
async function appendEntry(entry: UndoEntry): Promise<void> {
  await mkdir(dirname(UNDO_JOURNAL_PATH), { recursive: true });
  await appendFile(UNDO_JOURNAL_PATH, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * 记录一个**被删除的目录**（还原时 `mkdir -p`）。
 * 目录不进 `plan.items`（不计数"将还原 N 个文件"），但 `applyFileUndo` 会先重建它们。
 */
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

/**
 * 记录一次「无法完整留痕的改动」（例如递归删除的目录超过 `UNDO_DELETE_MAX_FILES`）。
 *
 * 为什么要有它：这种情况**没有** `old`，回滚时删掉的文件就回不来了。若不记账，
 * 用户回滚后看到的是"有些文件没了、界面却说回滚成功"。记一条 `skip` ⇒ `plan` 会把它
 * 放进 `blocked[]`，界面如实说"这一处还原不了，原因：…"。
 */
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
  } catch { /* 连"记不下来"都记不下来时只能放弃，但调用方仍会因 skip 缺失而少报一项 —— 已是最优 */ }
}

/**
 * 这份字节能不能当 UTF-8 文本**安全往返**？不能 ⇒ 按二进制快照存。
 *
 * 判据：解码再编码后字节是否与原来完全相同。UTF-8 非法序列会被替换成 U+FFFD，
 * 重新编码必然与原字节不等 ⇒ 被识别为二进制。
 * ⚠️ 不做这个判断的后果是**静默损坏**（PNG 被当文本 toString→写回，文件废了但没人报错）。
 */
export function isRoundTrippableUtf8(buf: Buffer): boolean {
  if (buf.length === 0) { return true; }
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/** 内容寻址的快照文件名（同内容只存一份，多次改同一文件不炸体积） */
async function writeSnapshot(data: string | Buffer): Promise<{ name: string; bin: boolean }> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const bin = !isRoundTrippableUtf8(buf);
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 24)}.${bin ? "bin" : "txt"}`;
  await mkdir(UNDO_SNAPSHOT_DIR, { recursive: true });
  const p = join(UNDO_SNAPSHOT_DIR, name);
  if (!(await stat(p).catch(() => null))) { await writeFile(p, buf); }
  return { name, bin };
}

/** 读快照**按字节**（文本/二进制统一；调用方不要自己 `toString`） */
async function readSnapshot(name: string): Promise<Buffer | null> {
  try { return await readFile(join(UNDO_SNAPSHOT_DIR, name)); } catch { return null; }
}

/** 读账本（损坏行跳过 —— 与 `readHistoryRecords` 同口径，不让一行坏数据废掉整次回滚） */
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
    } catch { /* 损坏行跳过 */ }
  }
  return out;
}

export interface UndoPlanItem { abs: string; action: "restore" | "delete" }
export interface UndoPlan {
  /** 切分线拿到了吗（拿不到 ⇒ 本次回滚的文件还原部分**不成立**，调用方必须出声） */
  ok: boolean;
  /** **文件**条数（`items.length`）。界面的"将还原 N 个文件"数的是它，不含目录 */
  count: number;
  /**
   * `items` 的**应用顺序**：账本里出现的最早 → 最晚（同一文件只留最早那条）。
   * 之所以是正序而不是逆序：跨文件存在依赖（先 `mkdir` 目录再往里写文件），
   * 正序正好满足。⚠️ 此前这里是"构建时 reverse + 应用时再 reverse"的**双重取反**，
   * 净效果与正序相同但读起来像有意图 —— 已改成显式正序，别再加 reverse。
   */
  items: UndoPlanItem[];
  /** 需要**重建的目录**数（不进 `count`：用户要数的是文件） */
  dirs: number;
  /** 账本里有、但**还原不了**的条目（原因已记） */
  blocked: Array<{ abs: string; reason: string }>;
  /** 同一时间窗内**属于其它会话**的改动条数（未纳入回滚 —— 用来"不假装干净"） */
  foreign: number;
  error?: string;
}

/** 归属判据（唯一出处）：本会话的、或无会话时本 Agent 的，或**子代理会话**的 */
function inRollbackScope(e: UndoEntry, agentId: string, sessionId: string | undefined): boolean {
  if (sessionId) {
    if (e.session_id === sessionId) { return true; }
    return isSubagentSessionId(e.session_id);
  }
  return e.session_id === "" && e.agent_id === agentId;
}

/** 切分线：`history.jsonl` 里目标用户消息所属轮的**上一轮结束时刻**（ms）；找不到返回 null */
async function cutLine(agentId: string, sessionId: string | undefined, userMsg: string): Promise<number | null> {
  const recs = await readHistoryRecords();
  const cut = findRollbackCut(recs, agentId, sessionId, userMsg);
  return cut.index >= 0 ? cut.prevTimestamp : null;
}

/**
 * 算出「回滚到这条消息会还原哪些文件」——**只读**，供界面先给用户一个确认。
 *
 * 同一个文件在同一时间窗内被改多次时，**保留最早那条**（那才是"这一轮开始前的样子"）。
 *
 * ⚠️ `selectUndo()` 是**选择的唯一实现**：`plan` 与 `apply` 都调它 ——
 * 两边各写一份"哪些条目算数"必然分家，症状是**界面说还原 3 个、实际动了 2 个**。
 */
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
    // 历史里找不到这条用户消息 ⇒ 切分线拿不到。**不许**退化成"全部还原"或"什么都不用还原"
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
  // 正序 = 账本里的先后顺序（每个文件只留最早那条）。目录**不进 items** —— 见 `UndoPlan.dirs`。
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
  /** 重建的目录数 */
  dirs: number;
  /** **必须展示**：还原失败清单（半途而废而不出声 = 用户以为回滚干净了） */
  failed: Array<{ abs: string; error: string }>;
  blocked: Array<{ abs: string; reason: string }>;
  foreign: number;
  error?: string;
}

/** 目录深度（越浅越靠前）—— 重建时父目录必须先于子目录 */
function depthOf(p: string): number {
  return p.split(/[\\/]/).filter(Boolean).length;
}

/**
 * 按账本还原（`plan.items` 已是应用顺序）。单条失败**不中断**后续
 * （继续尽力还原其它文件），但每一条失败都进 `failed[]` 并返回给调用方展示。
 */
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
  // 先重建目录（浅 → 深）：`writeFile` 会自动补父目录，但**空目录**没人补。
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
      // `old` 是内联文本；`snap` 是落盘快照（可能二进制）⇒ 统一取成 Buffer 再写
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
