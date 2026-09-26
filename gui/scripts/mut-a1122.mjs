#!/usr/bin/env node
/**
 * gui/scripts/mut-a1122.mjs — A-1122（③ 回滚产物改动的磁盘状态）的变异验证。
 *
 * 每条变异都要证明"守卫真的锁住了那件事"，尤其是**静默类**缺陷 —— 它们不报错、不崩溃，
 * 只是让用户以为回滚干净了：
 *
 *   1  切分线过滤恒真（把**上一轮**的改动也还原回去）
 *   2  归属判据失效（别的会话的改动被纳入回滚）
 *   3  `foreign` 不报数（用户不知道有别的东西被漏下）
 *   4  `skip` 条目不进 `blocked`（"还原不了"变成无声）
 *   5  同一文件保留**最后**一条（还原到中间态，不是"这一轮开始前"）
 *   6  二进制也内联（PNG 被当文本存 → 还出来是坏文件）
 *   7  快照 `bin` 标记恒 false（同上，走快照那条路也丢标记）
 *   8  新建文件还原时不删（判据本体："新建的文件被删掉"）
 *   9  目录不重建（空目录静默消失）
 *  10  快照读不到不进 `failed`（半途而废而不出声）
 *  11  锚点取**第一条**匹配（回滚后重发同一条消息时切错位置）
 *  12  删除前不读改前内容（事后无法重建）
 *  13  删除不留痕（`commitDeleteUndo` 结果被丢弃）
 *  14  `file_write` 记账时不传归属（账本里没有这条 → 回滚动不了它）
 *  15  `file_write` 账本失败不出声（静默变成"回滚不了但用户不知道"）
 *  16  `file_delete` 不再注入 `_undo_scope`（删除不可回滚）
 *  17  注入前不 `delete`（模型可伪造"别的会话"的 scope）
 *  18  把 `file_read` 也纳入注入（污染只读工具入参）
 *  19  确认框不报文件数（退化成弹不出来的假确认）
 *  20  横幅不报 `failed`
 *  21  横幅不报 `foreign`
 *  22  超 `MAX_LISTED` 不折叠（只列前几条，用户以为就这些）
 *  23  `rollbackTo` 丢掉终局 `commit()`（对话回滚整段失效）
 *  24  取消确认后仍然继续（点了取消却还是把对话撤了）
 *  25  主进程 channel 改名（渲染层调不到 → 文件永不还原）
 *  26  preload 的 `apply` 退化成 `plan`（只预演、不动盘）
 *  27  渲染层手抄一份形状（主进程多一类 ⇒ 静默不显示）
 *
 * 用法：--list / --apply N / --restore / --specs N / 全量。
 * 本环境禁止 node→node 孙进程 ⇒ 全量跑不了，用 shell 循环（见 a1115 / a1116 同款）：
 *
 *   for i in $(seq 1 27); do
 *     node gui/scripts/mut-a1122.mjs --apply $i || break
 *     npx vitest run --config vitest.config.ts $(node gui/scripts/mut-a1122.mjs --specs $i) --reporter=dot > /tmp/m$i.txt 2>&1
 *     echo "M$i exit=$?"; grep -aE 'Tests +[0-9]' /tmp/m$i.txt
 *     node gui/scripts/mut-a1122.mjs --restore
 *   done
 *
 * ⚠️ `--specs $i` 别省（也别手写 spec 名）：每条变异要跑的守卫文件由脚本自己声明，
 * 手写就会漏掉跨文件的守卫 ⇒ **假存活**（见 a1115 §3.1 的教训）。
 * ⚠️ 判据 = `exit≠0` **且**输出里真有 `Tests N` 汇总行（没有汇总行 = 测量工具本身坏了）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 默认守卫（core-ts 侧：账本 / 工具挂钩 / 注入 / IPC 三步链路） */
const SPEC_CORE = "tests/core-ts/a1122-file-undo.spec.ts";
/** 渲染层守卫（文案 + `rollbackTo` 顺序约束） */
const SPEC_GUI = "tests/gui/a1122-undo-report.spec.ts";

const F_UNDO = "core-ts/src/services/file_undo.ts";
const F_HIST = "core-ts/src/services/history.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_LOOP = "core-ts/src/tool_loop.ts";
const F_REPORT = "gui/src/renderer/pages/fileUndoReport.ts";
const F_CHAT = "gui/src/renderer/pages/ChatPanel.tsx";
const F_MAIN = "gui/src/main/index.ts";
const F_PRELOAD = "gui/src/preload/index.ts";

const TARGETS = [F_UNDO, F_HIST, F_BUILTIN, F_LOOP, F_REPORT, F_CHAT, F_MAIN, F_PRELOAD];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1122");

const MUTATIONS = [
  // ── file_undo.ts：账本语义 ─────────────────────────────────────────────
  {
    name: "1 切分线过滤恒真（把上一轮的改动也还原回去）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "const entries = (await readUndoJournal()).filter((e) => e.t >= cut);",
      "const entries = (await readUndoJournal()).filter(() => true);"),
  },
  {
    name: "2 归属判据失效（别的会话的改动被纳入回滚）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "if (!inRollbackScope(e, agentId, sessionId)) { foreign += 1; continue; }",
      "if (false) { foreign += 1; continue; }"),
  },
  {
    name: "3 foreign 不报数（别的会话的改动被静默吞掉）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "foreign += 1;", "void 0;"),
  },
  {
    name: "4 skip 条目不进 blocked（还原不了却不出声）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "if (e.skip) { blocked.set(e.abs, e.skip); continue; }",
      "if (false) { blocked.set(e.abs, e.skip); continue; }"),
  },
  {
    name: "5 同一文件保留最后一条（还原到中间态而非改前）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "if (!first.has(e.abs)) { first.set(e.abs, e); }", "first.set(e.abs, e);"),
  },
  {
    name: "6 二进制也内联（PNG 被当文本存 → 还原出来是坏文件）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "if (isRoundTrippableUtf8(bytes) && bytes.byteLength <= UNDO_INLINE_MAX) {",
      "if (bytes.byteLength <= UNDO_INLINE_MAX) {"),
  },
  {
    name: "7 快照 bin 标记恒 false（快照路径上也丢了二进制标记）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "const bin = !isRoundTrippableUtf8(buf);", "const bin = false;"),
  },
  {
    name: "8 新建文件还原时不删（判据本体：新建的文件被删掉）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "await rm(item.abs, { force: true, recursive: true });", "void 0;"),
  },
  {
    name: "9 目录不重建（空目录静默消失）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t,
      "const dirs = [...first.values()].filter((e) => e.dir).map((e) => e.abs).sort((a, b) => depthOf(a) - depthOf(b));",
      "const dirs: string[] = [];"),
  },
  {
    name: "10 快照读不到不进 failed（半途而废而不出声）",
    file: F_UNDO, specs: [SPEC_CORE],
    mutate: (t) => sub(t,
      'res.failed.push({ abs: item.abs, error: "改前快照读不到（账本里没有内联内容，快照文件缺失）" });',
      "void 0;"),
  },

  // ── history.ts：锚点唯一出处 ───────────────────────────────────────────
  {
    name: "11 锚点取第一条匹配（回滚后重发同一条消息时切错位置）",
    file: F_HIST, specs: [SPEC_CORE],
    mutate: (t) => sub(t,
      "let cutIdx = -1;\n  for (let i = records.length - 1; i >= 0; i--) {",
      "let cutIdx = -1;\n  for (let i = 0; i < records.length; i++) {"),
  },

  // ── builtin.ts：两个工具的记账挂钩 ─────────────────────────────────────
  {
    name: "12 删除前不读改前内容（事后无法重建）",
    file: F_BUILTIN, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "const data = await readFile(abs).catch(() => null);", "const data = null;"),
  },
  {
    name: "13 删除不留痕（`commitDeleteUndo` 的结果被丢弃）",
    file: F_BUILTIN, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "const undoNote = await commitDeleteUndo(captured);", 'const undoNote = "";'),
  },
  {
    name: "14 `file_write` 记账时不传归属（账本里没有这条 → 回滚动不了它）",
    file: F_BUILTIN, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "      undoScopeOf(args),", "      null,"),
  },
  {
    name: "15 `file_write` 账本失败不出声（静默变成「回滚不了但用户不知道」）",
    file: F_BUILTIN, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "const undoNote = (!undoOk && undoScopeOf(args))", "const undoNote = (false)"),
  },

  // ── tool_loop.ts：受信注入 ─────────────────────────────────────────────
  {
    name: "16 `file_delete` 不再注入 `_undo_scope`（删除不可回滚）",
    file: F_LOOP, specs: [SPEC_CORE],
    mutate: (t) => sub(t, 'const UNDO_SCOPED_TOOLS = new Set(["file_write", "file_delete"]);',
      'const UNDO_SCOPED_TOOLS = new Set(["file_write"]);'),
  },
  {
    name: "17 注入前不 delete（模型可伪造「别的会话」的 scope）",
    file: F_LOOP, specs: [SPEC_CORE],
    mutate: (t) => sub(t, "delete args._undo_scope;", "void 0;"),
  },
  {
    name: "18 把 `file_read` 也纳入注入（污染只读工具入参）",
    file: F_LOOP, specs: [SPEC_CORE],
    mutate: (t) => sub(t, 'const UNDO_SCOPED_TOOLS = new Set(["file_write", "file_delete"]);',
      'const UNDO_SCOPED_TOOLS = new Set(["file_write", "file_delete", "file_read"]);'),
  },

  // ── 渲染层文案 ────────────────────────────────────────────────────────
  {
    name: "19 确认框不报文件数（退化成弹不出来的假确认）",
    file: F_REPORT, specs: [SPEC_GUI],
    mutate: (t) => sub(t, "if (plan.count > 0) { parts.push(`还原 ${plan.count} 个文件`); }",
      "if (false) { parts.push(``); }"),
  },
  {
    name: "20 横幅不报 failed（还原失败被吞掉）",
    file: F_REPORT, specs: [SPEC_GUI],
    mutate: (t) => sub(t, "if (res.failed.length > 0) {", "if (false) {"),
  },
  {
    name: "21 横幅不报 foreign（不假装干净这条失守）",
    file: F_REPORT, specs: [SPEC_GUI],
    mutate: (t) => sub(t, "if (res.foreign > 0) {", "if (false) {"),
  },
  {
    name: "22 超 MAX_LISTED 不折叠（只列前几条，用户以为就这些）",
    file: F_REPORT, specs: [SPEC_GUI],
    mutate: (t) => sub(t,
      "if (res.failed.length > MAX_LISTED) { lines.push(`· …还有 ${res.failed.length - MAX_LISTED} 个`); }", ""),
  },
  {
    name: "23 `rollbackTo` 丢掉终局 `commit()`（对话回滚整段失效）",
    file: F_CHAT, specs: [SPEC_GUI],
    mutate: (t) => sub(t, "      commit();\n", "      void 0;\n"),
  },
  {
    name: "24 取消确认后仍然继续（点了取消却还是把对话撤了）",
    file: F_CHAT, specs: [SPEC_GUI],
    mutate: (t) => sub(t, "if (!(await confirmAsync(ask.message, ask.detail))) { return; }",
      "await confirmAsync(ask.message, ask.detail);"),
  },

  // ── IPC 三步链路 ──────────────────────────────────────────────────────
  {
    name: "25 主进程 channel 改名（渲染层调不到 → 文件永不还原）",
    file: F_MAIN, specs: [SPEC_CORE],
    mutate: (t) => sub(t, '"slime:file:undo", async (_event, payload) => {',
      '"slime:file:undo-renamed", async (_event, payload) => {'),
  },
  {
    name: "26 preload 的 `apply` 退化成 `plan`（只预演、不动盘）",
    file: F_PRELOAD, specs: [SPEC_CORE],
    mutate: (t) => sub(t, 'mode: "apply" }) as Promise<FileUndoResult>', 'mode: "plan" }) as Promise<FileUndoResult>'),
  },
  {
    name: "27 渲染层手抄一份形状（主进程多一类 ⇒ 静默不显示）",
    file: F_REPORT, specs: [SPEC_GUI],
    mutate: (t) => sub(t, 'import type { FileUndoPlan, FileUndoResult } from "../../shared/ipc.js";',
      "interface FileUndoPlan { ok: boolean; count: number; items: Array<{ abs: string; action: string }>; dirs: number; blocked: Array<{ abs: string; reason: string }>; foreign: number }\n"
      + "interface FileUndoResult { ok: boolean; restored: number; deleted: number; dirs: number; failed: Array<{ abs: string; error: string }>; blocked: Array<{ abs: string; reason: string }>; foreign: number; error?: string }"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** 跑一组 spec（`specs` 由变异自己声明 —— **唯一出处**，别在 shell 里手写） */
function runSpecs(specs) {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...specs, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const specsOf = (m) => (m.specs && m.specs.length ? m.specs : [SPEC_CORE]);

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--specs") ? "specs"
    : argv.includes("--restore") ? "restore"
      : argv.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

/** 打印第 i 条变异该跑的守卫文件（shell 循环用） */
if (mode === "specs") {
  const idx = Number(argv[argv.indexOf("--specs") + 1]);
  const m = MUTATIONS[idx - 1];
  if (!m) { console.error(`--specs 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
  console.log(specsOf(m).join(" "));
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs([SPEC_CORE, SPEC_GUI]);
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1122")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpecs(specsOf(m));
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
