/**
 * A-1066 变异测试：把「本轮跑完清空待办」的判据与接线逐个改坏，要求守卫变红。
 *
 * 这条需求最容易的错法是**把三种结束原因"统一"掉**（于是自动续跑丢计划提醒），
 * 其次是把竞态判定写到注销之后（于是"刚规划好就没了"）。故两者各配一条独立变异 ——
 * 守卫"通过"不算数，能被弄红才算数。
 *
 * ⚠️ 本文件里**不许**在中文句子中夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 *
 * 用法：node gui/scripts/mut-a1066.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1066-todo-turnend.spec.ts";
const MAIN = "gui/src/main/index.ts";
const LIFECYCLE = "core-ts/src/services/todoLifecycle.ts";
const TARGETS = [MAIN, LIFECYCLE];

const MUTATIONS = [
  {
    name: "1 判据退化成「三种结束都清」（顺手统一的错法 → 自动续跑丢计划提醒）",
    file: LIFECYCLE,
    mutate: (t) => sub(t, '  return ev.reason === "done";', "  return true;"),
  },
  {
    name: "2 判据只对 error 清（口径做偏）",
    file: LIFECYCLE,
    mutate: (t) => sub(t, '  return ev.reason === "done";', '  return ev.reason === "error";'),
  },
  {
    name: "3 判据丢掉「已被新一轮接管」那一支（会误清新一轮刚写下的清单）",
    file: LIFECYCLE,
    mutate: (t) => sub(t, "  if (ev.stillActive) { return false; }\n", ""),
  },
  {
    name: "4 竞态判定挪到注销之后（读完就是新一轮的 controller，防护失效）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      "        const superseded = activeChats.get(cancelKey) !== controller;\n        activeChats.delete(cancelKey);",
      "        activeChats.delete(cancelKey);\n        const superseded = activeChats.get(cancelKey) !== controller;",
    ),
  },
  {
    name: "5 清空键用 cancelKey（待办文件名按 sessionId 命名 → 删错/删不掉）",
    file: MAIN,
    mutate: (t) => sub(t, "clearTodosOnTurnEnd(input.sessionId)", "clearTodosOnTurnEnd(cancelKey)"),
  },
  {
    name: "6 去掉「本来就空就不动」的短路（每轮结束都白广播一次空列表）",
    file: MAIN,
    mutate: (t) => sub(t, "  if (readTodos(sessionId).length === 0) { return; }\n", ""),
  },
  {
    name: "7 清盘后不广播（界面留着旧项 = 用户看到的「没清掉」）",
    file: MAIN,
    mutate: (t) => sub(t, "broadcastTodos(sessionId);\n}", "}"),
  },
  {
    name: "8 出错标志不置真（error 被误报成 done → 出错时也清空）",
    file: MAIN,
    /* 2026-10-07 重打锚点：原锚点行尾带了**中文行尾注释原文**（A-1066：本轮以出错收场…）
       + 精确的换行，注释被系统剥离成空白后必然断裂。
       改为**只锚代码行**（纯赋值语句）—— 不含注释文本，实测唯一。
       ⚠️ `to` 只去**这一行**（不含换行），不吞掉后续代码行。 */
    mutate: (t) => sub(t, "        hadError = true;", ""),
  },
  {
    name: "9 三种结束原因不再如实上报（reason 恒为 done）",
    file: MAIN,
    mutate: (t) => sub(
      t,
      'reason: controller.signal.aborted ? "cancelled" : hadError ? "error" : "done",',
      'reason: "done",',
    ),
  },
];

/* ── 骨架：--list / --apply N / --restore ──────────────────────────────────
 * 与 mut-a1091 / mut-a1037 / mut-a1042 / mut-a1053 / mut-a1064 同款约定（全仓一致）。
 * ⚠️ --restore **无参可用**，且**变异态下也能跑**。
 * ⚠️ 本脚本条目是 `{ name, file, mutate }`（没有 from/to），所以 `--apply` 必须调
 *   **同一个** `m.mutate` —— 绝不能自己拼锚点，否则两套判据打架（假绿）。
 */
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1066");
const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    const path = join(ROOT, m.file);
    const src = readFileSync(path, "utf8");
    mkdirSync(SAVE_DIR, { recursive: true });
    writeFileSync(join(SAVE_DIR, "orig.txt"), src);
    const next = m.mutate(src);          // ← 与全量模式**同一个** mutate
    if (next === src) {
      console.error(`锚点未命中（源码已漂移）：${m.name}`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
    writeFileSync(path, next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 ${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(join(ROOT, man.file), readFileSync(join(SAVE_DIR, "orig.txt")));
  const now = createHash("sha256").update(readFileSync(join(ROOT, man.file))).digest("hex");
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map();
for (const t of TARGETS) { originals.set(t, readFileSync(join(ROOT, t), "utf8")); }
const hashes = new Map([...originals.keys()].map((t) => [t, hash(join(ROOT, t))]));

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1066")) { process.exit(1); }
console.log("行尾检测器自检 + 锚点自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    writeFileSync(path, src);
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  for (const [t, src] of originals) { writeFileSync(join(ROOT, t), src); }
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
