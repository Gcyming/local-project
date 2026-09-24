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
import { readFileSync, writeFileSync } from "node:fs";
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
    mutate: (t) => sub(t, "        hadError = true; // A-1066：本轮以出错收场（判据在流结束处如实报因）\n", ""),
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
