/**
 * tests/core-ts/a1122-file-undo.spec.ts — ③「回滚产物改动的磁盘状态」的守卫（A-1122）。
 *
 * ## 这一条要守住的**判据**（逐字）
 * 「让 Agent 改 2 个文件 → 回滚该消息 → 两个文件内容都回到改动前；新建的文件被删掉。」
 *
 * ## 为什么不是"功能能跑"就算过关
 *
 * 回滚的危险全在**静默**里 —— 每一项失败都不会报错：
 *  · 切分线取错 ⇒ 该还原的没还原 / 不该动的被动了（两边都不出声）；
 *  · 旧内容只在"写入那一刻"才知道 ⇒ 事后无法重建（所以必须在写入前记账）；
 *  · 二进制文件当文本 `toString("utf8")` 存 ⇒ 还原出来是**损坏的文件**，界面却说成功；
 *  · 留不下痕（目录过大 / 读不到内容）⇒ 记一条 `skip` 让界面**报数**，而不是假装回滚干净了。
 * ⇒ 本守卫的重点是：**每一种"还原不了"都必须能说出来**，且**说出来的数字是真的**。
 *
 * ## ⚠️ 隔离方式（这里踩过一个真坑，别改回"静态 import builtin"）
 *
 * 账本路径 `UNDO_JOURNAL_PATH` 是**模块级常量**，在 `file_undo.js` 加载时就从
 * `SLIME_HISTORY_PATH` / `SLIME_FILE_UNDO_PATH` 算好了。而 `builtin.js` 是**静态 import**
 * `file_undo.js` 的 ⇒ 它的那个实例在 spec 加载时就冻住了路径。
 * 于是「先 `vi.resetModules()` 再动态 import file_undo，然后调**静态**的 builtin 工具」
 * 会让两边写**不同的文件**：
 *   · 动态实例写临时目录（测试自己 `plan/apply` 读它） ⇒ 读不到 builtin 写的东西；
 *   · builtin 的旧实例写**真实工作区** `config/file-undo.jsonl` ⇒ **污染用户仓库**（实测发生过）。
 * ⇒ 所以本 spec **不静态 import** `builtin`/`registry`，改为每个沙箱设好环境变量后
 *   一起动态 import（`file_undo` / `registry` / `builtin` 取到同一份模块图）。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat, appendFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";

// ── 纯函数（不碰路径常量，可静态导入）──────────────────────────────────────────
import { isRoundTrippableUtf8 } from "../../core-ts/src/services/file_undo.js";
import { findRollbackCut } from "../../core-ts/src/services/history.js";
import type { HistoryRecord } from "../../core-ts/src/services/history.js";
import type { UndoPlan, UndoResult, UndoScope } from "../../core-ts/src/services/file_undo.js";
import type { ToolRegistry } from "../../core-ts/src/tools/registry.js";

function codeOf(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}
const BUILTIN = codeOf("core-ts/src/tools/builtin.ts");
const TOOL_LOOP = codeOf("core-ts/src/tool_loop.ts");
const MAIN = codeOf("gui/src/main/index.ts");
const PRELOAD = codeOf("gui/src/preload/index.ts");
const IPC_SHARED = codeOf("gui/src/shared/ipc.ts");

const AGENT = "a1";
const SESSION = "s1";
/** 账本归属（`UndoScope` 的字段名是 `agent_id`/`session_id`，别和入参里的 `_undo_scope` 混） */
const S = (sessionId: string, agentId = AGENT): UndoScope => ({ agent_id: agentId, session_id: sessionId });

interface Sandbox {
  dir: string;
  ws: string;
  journalPath: string;
  /** 「现在」的毫秒时间戳 —— 用来手工构造**早于切分线**的账本条目（测"上一轮的改动不该被还原"） */
  now: number;
  /** 工具注册表（**与账本同一个模块实例**，见文件头注释） */
  tools: ToolRegistry;
  setTrash: (t: { trash: (p: string) => Promise<{ ok: boolean; error?: string }> } | null) => void;
  record: (abs: string, existed: boolean, old: string | Buffer | null, scope?: UndoScope | null) => Promise<boolean>;
  unundoable: (abs: string, reason: string, scope?: UndoScope) => Promise<void>;
  plan: (sessionId: string | undefined, userMsg: string) => Promise<UndoPlan>;
  apply: (sessionId: string | undefined, userMsg: string) => Promise<UndoResult>;
  cleanup: () => Promise<void>;
}

/** 建沙箱：history 两条记录（问1 / 问2）⇒ 滚到问2 时切分线 = 问1 结束时刻（now-60s） */
async function makeSandbox(): Promise<Sandbox> {
  const prevHist = process.env.SLIME_HISTORY_PATH;
  const prevUndo = process.env.SLIME_FILE_UNDO_PATH;
  const dir = await mkdtemp(join(tmpdir(), "slime-a1122-"));
  const ws = join(dir, "ws");
  await mkdir(ws, { recursive: true });
  const historyPath = join(dir, "history.jsonl");
  const journalPath = join(dir, "file-undo.jsonl");
  const now = Date.now();
  const recs: Array<Record<string, unknown>> = [
    { agent_id: AGENT, session_id: SESSION, user: "问1", ai: "答1", success: true, timestamp: new Date(now - 60_000).toISOString() },
    { agent_id: AGENT, session_id: SESSION, user: "问2", ai: "答2", success: true, timestamp: new Date(now - 30_000).toISOString() },
  ];
  await writeFile(historyPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  process.env.SLIME_HISTORY_PATH = historyPath;
  process.env.SLIME_FILE_UNDO_PATH = journalPath; // 显式给，避免派生到真实 config 目录
  vi.resetModules();
  const mod = await import("../../core-ts/src/services/file_undo.js");
  const registry = await import("../../core-ts/src/tools/registry.js");
  const builtin = await import("../../core-ts/src/tools/builtin.js");
  registry.resetRegistry();
  builtin.setTrashService(null);   // 未装配回收站 ⇒ 走永久删除（正好用来测还原）
  builtin.setHttpServer(null);
  builtin.registerBuiltinTools();

  return {
    dir, ws, journalPath, now,
    tools: registry.getRegistry(),
    setTrash: builtin.setTrashService,
    record: (abs, existed, old, scope = S(SESSION)) => mod.recordFileChange(scope, abs, existed, old),
    unundoable: (abs, reason, scope = S(SESSION)) => mod.recordUnundoable(scope, abs, reason),
    plan: (sessionId, userMsg) => mod.planFileUndo(AGENT, sessionId, userMsg),
    apply: (sessionId, userMsg) => mod.applyFileUndo(AGENT, sessionId, userMsg),
    cleanup: async () => {
      if (prevHist === undefined) { delete process.env.SLIME_HISTORY_PATH; } else { process.env.SLIME_HISTORY_PATH = prevHist; }
      if (prevUndo === undefined) { delete process.env.SLIME_FILE_UNDO_PATH; } else { process.env.SLIME_FILE_UNDO_PATH = prevUndo; }
      vi.resetModules();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function writeText(p: string, text: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, "utf8");
}
async function readText(p: string): Promise<string> { return readFile(p, "utf8"); }
async function exists(p: string): Promise<boolean> { return (await stat(p).catch(() => null)) !== null; }
const scopeArgs = (sessionId = SESSION): Record<string, unknown> => ({ agentId: AGENT, sessionId });

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 锚点：`findRollbackCut` 是对话截断与文件回滚的**唯一**切分线", () => {
  const rec = (agent: string, session: string, user: string, tsMs: number): HistoryRecord => ({
    agent_id: agent, session_id: session, user, ai: "x", success: true,
    timestamp: new Date(tsMs).toISOString(),
  });

  it("找到目标消息 → 返回它的下标 + **上一轮结束时刻**", () => {
    const t0 = 1_700_000_000_000;
    const recs = [rec("a1", "s1", "问1", t0), rec("a1", "s1", "问2", t0 + 5000)];
    expect(findRollbackCut(recs, "a1", "s1", "问2")).toEqual({ index: 1, prevTimestamp: t0 });
  });

  it("第一条消息（前面没有同会话记录）→ `prevTimestamp = 0`（= 从最早开始还原）", () => {
    const recs = [rec("a1", "s1", "问1", 1_700_000_000_000)];
    expect(findRollbackCut(recs, "a1", "s1", "问1")).toEqual({ index: 0, prevTimestamp: 0 });
  });

  it("找不到（内容不符 / 别的会话）→ `index: -1`（调用方据此**拒绝**回滚，不许退化成「全还原」）", () => {
    const recs = [rec("a1", "s1", "问1", 1), rec("a2", "s9", "问2", 2)];
    expect(findRollbackCut(recs, "a1", "s1", "不存在").index).toBe(-1);
    expect(findRollbackCut(recs, "a1", "s1", "问2").index).toBe(-1); // 跨会话不认
  });

  it("同内容出现两次 → 取**最后一条**（回滚后重发同一条消息的场景）", () => {
    const t0 = 1_700_000_000_000;
    const recs = [rec("a1", "s1", "同样的", t0), rec("a1", "s1", "中间", t0 + 1), rec("a1", "s1", "同样的", t0 + 2)];
    expect(findRollbackCut(recs, "a1", "s1", "同样的").index).toBe(2);
  });

  it("`prevTimestamp` 跳过**别的会话**的记录（只认同一 agent+session 的上一条）", () => {
    const t0 = 1_700_000_000_000;
    const recs = [
      rec("a1", "s1", "问1", t0),
      rec("a2", "s9", "别的", t0 + 100),   // 不该被当成「上一轮」
      rec("a1", "s1", "问2", t0 + 200),
    ];
    expect(findRollbackCut(recs, "a1", "s1", "问2").prevTimestamp).toBe(t0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 记账前提：路径归属与二进制判据", () => {
  it("账本默认落在 `history` **同目录**（测试隔离靠这条；别改成别处）", async () => {
    const sb = await makeSandbox();
    const keep = process.env.SLIME_FILE_UNDO_PATH;
    try {
      delete process.env.SLIME_FILE_UNDO_PATH;
      vi.resetModules();
      const mod = await import("../../core-ts/src/services/file_undo.js");
      expect(mod.UNDO_JOURNAL_PATH).toBe(join(sb.dir, "file-undo.jsonl"));
    } finally {
      process.env.SLIME_FILE_UNDO_PATH = keep;
      await sb.cleanup();
    }
  });

  it("没有归属（CLI / 未注入）→ 不记账也不报错（返回 false）", async () => {
    const sb = await makeSandbox();
    try {
      expect(await sb.record(join(sb.ws, "a.txt"), false, null, null)).toBe(false);
      expect(await exists(sb.journalPath)).toBe(false); // 连账本文件都不该被创建
    } finally { await sb.cleanup(); }
  });

  it("`undoScopeOf`：无 `agentId` = 无归属；`sessionId` 非字符串 → 归一成空串", async () => {
    const sb = await makeSandbox();
    try {
      const mod = await import("../../core-ts/src/services/file_undo.js");
      expect(mod.undoScopeOf({ _undo_scope: { agentId: "a1" } })).toEqual({ agent_id: "a1", session_id: "" });
      expect(mod.undoScopeOf({ _undo_scope: { agentId: "a1", sessionId: 42 } })).toEqual({ agent_id: "a1", session_id: "" });
      expect(mod.undoScopeOf({ _undo_scope: { sessionId: "s1" } })).toBeNull();
      expect(mod.undoScopeOf({})).toBeNull();
    } finally { await sb.cleanup(); }
  });

  it("UTF-8 往返判据：合法文本 true；非法字节 false（**否则 PNG 会被当文本存坏**）", () => {
    expect(isRoundTrippableUtf8(Buffer.from("", "utf8"))).toBe(true);
    expect(isRoundTrippableUtf8(Buffer.from("hello 世界\n", "utf8"))).toBe(true);
    // 0x89 0x50 0x4E 0x47 是 PNG 魔数 —— 不是合法 UTF-8 序列
    expect(isRoundTrippableUtf8(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(isRoundTrippableUtf8(Buffer.from([0xff, 0xfe, 0x00]))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 判据本体：改 2 个文件 + 新建 1 个 → 回滚后两个回到改前、新建的被删掉", () => {
  it("端到端：plan 报 3，apply 后内容回到改前、新建文件消失", async () => {
    const sb = await makeSandbox();
    try {
      const f1 = join(sb.ws, "a.txt");
      const f2 = join(sb.ws, "sub", "b.md");
      const f3 = join(sb.ws, "new.txt");
      await writeText(f1, "旧内容A");
      await writeText(f2, "旧内容B");
      // 模拟 file_write：写入**之前**记账（existed/old 是改前状态）
      await sb.record(f1, true, "旧内容A");
      await writeText(f1, "新内容A");
      await sb.record(f2, true, "旧内容B");
      await writeText(f2, "新内容B");
      // 新建：改前不存在 ⇒ existed=false ⇒ 还原时删除
      await sb.record(f3, false, null);
      await writeText(f3, "凭空出现");

      const plan = await sb.plan(SESSION, "问2");
      expect(plan.ok).toBe(true);
      expect(plan.count).toBe(3);
      expect(plan.items.map((i) => i.action).sort()).toEqual(["delete", "restore", "restore"]);

      const res = await sb.apply(SESSION, "问2");
      expect(res.ok).toBe(true);
      expect(res.restored).toBe(2);
      expect(res.deleted).toBe(1);
      expect(res.failed).toEqual([]);
      expect(await readText(f1)).toBe("旧内容A");
      expect(await readText(f2)).toBe("旧内容B");
      expect(await exists(f3)).toBe(false);
    } finally { await sb.cleanup(); }
  });

  it("同一文件改两次 → 只算**一条**，且还原到**最早**的旧内容（不是中间那次）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "x.txt");
      await writeText(f, "v0");
      await sb.record(f, true, "v0");
      await writeText(f, "v1");
      await sb.record(f, true, "v1");   // 第二次改动
      await writeText(f, "v2");

      const plan = await sb.plan(SESSION, "问2");
      expect(plan.count).toBe(1);       // 不是 2
      expect((await sb.apply(SESSION, "问2")).restored).toBe(1);
      expect(await readText(f)).toBe("v0");
    } finally { await sb.cleanup(); }
  });

  it("二进制文件按**快照**存、按字节还（还原后与原字节完全一致）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "logo.bin");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
      await writeFile(f, png);
      await sb.record(f, true, png);          // 传 Buffer（file_delete 那条路）
      await writeFile(f, Buffer.from([0x00, 0x01]));

      const journal = await readText(sb.journalPath);
      expect(journal).toContain("snapBin");   // 必须标记为二进制
      expect(journal).toContain(".bin");      // 快照扩展名体现二进制
      expect((await sb.apply(SESSION, "问2")).restored).toBe(1);
      expect(await readFile(f)).toEqual(png); // ⚠️ 不是被 utf8 洗过的字符串
    } finally { await sb.cleanup(); }
  });

  it("文本超 `UNDO_INLINE_MAX` → 走快照（内容不内联），仍能完整还原", async () => {
    const sb = await makeSandbox();
    try {
      const mod = await import("../../core-ts/src/services/file_undo.js");
      const f = join(sb.ws, "big.txt");
      const big = "x".repeat(mod.UNDO_INLINE_MAX + 1024);
      await sb.record(f, true, big);
      const journal = await readText(sb.journalPath);
      expect(journal).toContain(".txt");
      expect(journal.includes("x".repeat(100))).toBe(false); // 内容没被内联进账本
      await sb.apply(SESSION, "问2");
      expect((await readText(f)).length).toBe(big.length);
    } finally { await sb.cleanup(); }
  });

  it("还原新建文件 = **删掉**它（含它落在新建子目录里的情况）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "brand-new", "deep", "n.txt");
      await sb.record(f, false, null);
      await writeText(f, "内容");
      expect(await exists(f)).toBe(true);
      const res = await sb.apply(SESSION, "问2");
      expect(res.deleted).toBe(1);
      expect(await exists(f)).toBe(false);
    } finally { await sb.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 边界：切分线、别的会话、还原不了的条目", () => {
  it("切分线**之前**的改动不动（回滚只退这一轮）", async () => {
    const sb = await makeSandbox();
    try {
      const before = join(sb.ws, "before.txt");
      await writeText(before, "本轮之前");
      // 手动写一条 t 早于切分线的账本记录（模拟上一轮的写入）
      await appendFile(sb.journalPath, JSON.stringify({
        t: sb.now - 120_000, agent_id: AGENT, session_id: SESSION, abs: before, existed: true, old: "更早的内容",
      }) + "\n", "utf8");

      const plan = await sb.plan(SESSION, "问2");
      expect(plan.count).toBe(0);            // 不该把上一轮的写入算进来
      expect(plan.items).toEqual([]);
    } finally { await sb.cleanup(); }
  });

  it("切分线拿不到（历史里没有这条消息）→ `ok:false`，**不许**退化成「全还原」或「无事可做」", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "a.txt");
      await sb.record(f, false, null);
      const plan = await sb.plan(SESSION, "历史里没有这句话");
      expect(plan.ok).toBe(false);
      expect(plan.count).toBe(0);
      expect(plan.error).toContain("找不到");
      // apply 也不能假装成功
      const res = await sb.apply(SESSION, "历史里没有这句话");
      expect(res.ok).toBe(false);
      expect(res.restored).toBe(0);
    } finally { await sb.cleanup(); }
  });

  it("同一时间窗内**别的会话**的改动 → 只报数（`foreign`），不还原、也不静默吞掉", async () => {
    const sb = await makeSandbox();
    try {
      const mine = join(sb.ws, "mine.txt");
      const other = join(sb.ws, "other.txt");
      await writeText(mine, "改前");
      await writeText(other, "别人的改前");
      await sb.record(mine, true, "改前", S(SESSION));
      await sb.record(other, true, "别人的改前", S("s-other"));

      const plan = await sb.plan(SESSION, "问2");
      expect(plan.count).toBe(1);
      expect(plan.foreign).toBe(1);
      const res = await sb.apply(SESSION, "问2");
      expect(res.foreign).toBe(1);
      expect(await readText(other)).toBe("别人的改前"); // 一个字没动
    } finally { await sb.cleanup(); }
  });

  it("子代理会话的改动**纳入**本轮（前台子代理在本轮之内跑）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "by-sub.txt");
      await writeText(f, "父会话改前");
      await sb.record(f, true, "父会话改前", S("__subagent__:run-1"));
      const plan = await sb.plan(SESSION, "问2");
      expect(plan.count).toBe(1);
      expect(plan.foreign).toBe(0);
    } finally { await sb.cleanup(); }
  });

  it("`skip` 条目（留不下痕）→ 进 `blocked` 出声，且**不进** `items`/`count`", async () => {
    const sb = await makeSandbox();
    try {
      await sb.unundoable(join(sb.ws, "huge"), "目录过大（超过 300 个条目）或读取失败");
      const plan = await sb.plan(SESSION, "问2");
      expect(plan.count).toBe(0);
      expect(plan.blocked).toHaveLength(1);
      expect(plan.blocked[0].reason).toContain("目录过大");
      // apply 也要把 blocked 带回去（失败清单必须展示）
      const res = await sb.apply(SESSION, "问2");
      expect(res.blocked).toHaveLength(1);
    } finally { await sb.cleanup(); }
  });

  it("快照文件被人为删除 → 该条进 `failed` 出声，其余照常还原（半途而废也必须报）", async () => {
    const sb = await makeSandbox();
    try {
      const mod = await import("../../core-ts/src/services/file_undo.js");
      const f = join(sb.ws, "big.txt");
      const big = "y".repeat(mod.UNDO_INLINE_MAX + 10);
      await sb.record(f, true, big);
      const snapDir = join(sb.dir, "file-undo-snapshots");
      for (const n of await readdir(snapDir)) { await rm(join(snapDir, n), { force: true }); }
      const okFile = join(sb.ws, "ok.txt");
      await sb.record(okFile, true, "旧的");

      const res = await sb.apply(SESSION, "问2");
      expect(res.failed).toHaveLength(1);
      expect(res.failed[0].abs).toBe(f);
      expect(res.failed[0].error).toContain("快照");
      expect(res.restored).toBe(1);       // 其余尽力还原
    } finally { await sb.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 工具挂钩：`file_write` / `file_delete` 都要记账", () => {
  it("`file_write` 覆盖前记账：回执正常、账本里有一条（旧内容 = 改前）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "w.txt");
      await writeText(f, "改前内容");
      const r = await sb.tools.get("file_write")!.executeFn({
        path: f, content: "改后内容", _workspace: sb.ws, _undo_scope: scopeArgs(),
      });
      expect(r).toContain("已保存");
      expect(r).not.toContain("未纳入回滚账本");
      expect((await sb.plan(SESSION, "问2")).count).toBe(1);
      expect((await sb.apply(SESSION, "问2")).restored).toBe(1);
      expect(await readText(f)).toBe("改前内容");
    } finally { await sb.cleanup(); }
  });

  it("⚠️ 账本**写不进去**时回执必须出声（不许静默变成「回滚不了但用户不知道」）", async () => {
    const sb = await makeSandbox();
    try {
      // 把账本路径本身变成一个**目录** ⇒ appendFile 报 EISDIR ⇒ 记账失败
      await rm(sb.journalPath, { force: true });
      await mkdir(sb.journalPath, { recursive: true });
      const f = join(sb.ws, "w2.txt");
      await writeText(f, "旧");
      const r = await sb.tools.get("file_write")!.executeFn({
        path: f, content: "新", _workspace: sb.ws, _undo_scope: scopeArgs(),
      });
      expect(r).toContain("已保存");          // 写入本身不阻断
      expect(r).toContain("未纳入回滚账本");  // 但必须说出来
      expect(await readText(f)).toBe("新");   // 内容确实写进去了
    } finally { await sb.cleanup(); }
  });

  it("`file_delete`（单文件）→ 记账，回滚把它**放回去**（内容一模一样）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "del-me.txt");
      await writeText(f, "很重要的一段");
      const r = await sb.tools.get("file_delete")!.executeFn({
        path: f, _workspace: sb.ws, _undo_scope: scopeArgs(),
      });
      expect(await exists(f)).toBe(false);
      expect(r).not.toContain("未纳入回滚账本");
      expect((await sb.plan(SESSION, "问2")).count).toBe(1);
      expect((await sb.apply(SESSION, "问2")).restored).toBe(1);
      expect(await readText(f)).toBe("很重要的一段");
    } finally { await sb.cleanup(); }
  });

  it("`file_delete`（递归目录）→ 文件内容 + **空目录骨架**都还原（目录不进 count）", async () => {
    const sb = await makeSandbox();
    try {
      const dir = join(sb.ws, "tree");
      const deep = join(dir, "empty-sub");     // 空目录：还原时最容易静默丢失的那个
      await mkdir(deep, { recursive: true });
      await writeText(join(dir, "f1.txt"), "一");
      await writeText(join(dir, "sub", "f2.txt"), "二");
      const r = await sb.tools.get("file_delete")!.executeFn({
        path: dir, recursive: true, _workspace: sb.ws, _undo_scope: scopeArgs(),
      });
      expect(await exists(dir)).toBe(false);
      expect(r).not.toContain("未纳入回滚账本");

      const plan = await sb.plan(SESSION, "问2");
      expect(plan.count).toBe(2);                  // 只数文件
      expect(plan.dirs).toBeGreaterThanOrEqual(2); // tree/sub + tree/empty-sub
      const res = await sb.apply(SESSION, "问2");
      expect(res.restored).toBe(2);
      expect(await readText(join(dir, "f1.txt"))).toBe("一");
      expect(await readText(join(dir, "sub", "f2.txt"))).toBe("二");
      expect(await exists(deep)).toBe(true);       // ⚠️ 空目录必须回来
    } finally { await sb.cleanup(); }
  });

  it("`file_delete` 未被注入归属 → 正常删除、不记账、也不误报（CLI / 测试环境）", async () => {
    const sb = await makeSandbox();
    try {
      const f = join(sb.ws, "no-scope.txt");
      await writeText(f, "x");
      const r = await sb.tools.get("file_delete")!.executeFn({ path: f, _workspace: sb.ws });
      expect(await exists(f)).toBe(false);
      expect(r).not.toContain("未纳入回滚账本"); // 无归属 = 本来就没打算记账，不是失败
      expect(await exists(sb.journalPath)).toBe(false);
    } finally { await sb.cleanup(); }
  });

  it("⚠️ 回收站**失败**时提前返回 ⇒ 账本里**不许**留下「凭空出现的还原项」", async () => {
    const sb = await makeSandbox();
    try {
      sb.setTrash({ trash: async () => ({ ok: false, error: "模拟回收站故障" }) });
      const f = join(sb.ws, "trash-fail.txt");
      await writeText(f, "还在");
      const r = await sb.tools.get("file_delete")!.executeFn({
        path: f, _workspace: sb.ws, _undo_scope: scopeArgs(),
      });
      expect(r).toContain("[错误]");
      expect(await readText(f)).toBe("还在");   // 没删
      expect((await sb.plan(SESSION, "问2")).count).toBe(0); // 也不该记一条「要还原」
    } finally { await sb.cleanup(); }
  });

  it("`file_write` 参数缺失时提前返回 → 不记账（失败路径不许污染账本）", async () => {
    const sb = await makeSandbox();
    try {
      const r = await sb.tools.get("file_write")!.executeFn({
        path: "", _workspace: sb.ws, _undo_scope: scopeArgs(),
      });
      expect(r).toContain("[错误]");
      expect(await exists(sb.journalPath)).toBe(false);
    } finally { await sb.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("A-1122 接线：受信注入 / IPC 三步链路", () => {
  it("`tool_loop` 只为**会改盘**的工具注入 `_undo_scope`（只读工具不注入）", () => {
    expect(TOOL_LOOP).toMatch(/UNDO_SCOPED_TOOLS\s*=\s*new\s+Set\(\[[^\]]*"file_write"[^\]]*"file_delete"[^\]]*\]\)/);
    expect(TOOL_LOOP).not.toMatch(/UNDO_SCOPED_TOOLS\s*=\s*new\s+Set\(\[[^\]]*"file_read"/);
    expect(TOOL_LOOP).toContain("UNDO_SCOPED_TOOLS.has(tc.name)");
  });

  it("⚠️ 注入必须**先 delete 再写**（否则模型能伪造一个「别的会话」的 scope，把改动记到别人头上）", () => {
    const at = TOOL_LOOP.indexOf("UNDO_SCOPED_TOOLS.has(tc.name)");
    expect(at).toBeGreaterThan(-1);
    const body = TOOL_LOOP.slice(at, at + 400);
    expect(body).toContain("delete args._undo_scope");
    expect(body.indexOf("delete args._undo_scope")).toBeLessThan(body.indexOf("args._undo_scope ="));
  });

  it("`file_write` / `file_delete` 都走到账本；且**采集在删除之前、提交在删除之后**", () => {
    expect(BUILTIN).toContain("recordFileChange(");
    expect(BUILTIN).toContain("commitDeleteUndo(captured)");
    expect(BUILTIN.indexOf("await captureDeleteUndo(")).toBeLessThan(BUILTIN.indexOf("await commitDeleteUndo("));
  });

  it("主进程提供 `slime:file:undo`，plan 与 apply 都走 core-ts 的同一份实现", () => {
    expect(MAIN).toContain('"slime:file:undo"');
    expect(MAIN).toContain("planFileUndo(");
    expect(MAIN).toContain("applyFileUndo(");
  });

  it("preload 暴露 `fileUndo.plan/apply`，channel 与主进程一致", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("slime:file:undo"');
    expect(PRELOAD).toContain('mode: "plan"');
    expect(PRELOAD).toContain('mode: "apply"');
  });

  it("形状**只借不抄**：`FileUndoPlan`/`FileUndoResult` 从 core-ts 转发", () => {
    expect(IPC_SHARED).toMatch(/export type \{ UndoPlan as FileUndoPlan, UndoResult as FileUndoResult \}/);
    // 反面：手抄一份形状 ⇒ 主进程多一类（例如 dirs）而渲染层静默看不见
    expect(IPC_SHARED).not.toMatch(/interface FileUndoPlan\s*\{/);
  });

  it("`SUBAGENT_SESSION_PREFIX` 是唯一出处（主进程不再自己写一份字面量）", () => {
    expect(MAIN).toMatch(/from\s+"\.\.\/\.\.\/\.\.\/core-ts\/src\/services\/subagent\.js"/);
    expect(MAIN).not.toMatch(/const SUBAGENT_SESSION_PREFIX\s*=/);
  });
});
