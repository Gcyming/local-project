/**
 * A-1072 变异测试（#231 收口）：「file_delete 必须真的进回收站」，逐环改坏要求守卫变红。
 *
 * 覆盖 `tests/core-ts/a1072-trash.spec.ts`。用户原话（Issue）：权限已经给了，但「无法删除文件 /
 * 脚本无法执行」。工具面补齐后，回收站能力由主进程注入（core-ts 不许 import electron）。
 *
 * 这一类危险是**静默退化**：没注入 → 工具照常"能用"，只是走永久删除 —— 门禁全绿、
 * 用户不可还原地丢文件。2026-09-23 实测踩到：`setTrashService` 只加了 import、调用没落地，
 * 只有 TS6133 恰好抓住"导入未使用"；import 与调用**一起**删掉就没人抓了 ⇒ 本脚本锁它。
 *
 * T 组：行为三态（进回收站 / 未注入走永久 / 回收站失败不许改永久）
 * W 组：接线事实（主进程确实调用、且实现用的是 shell.trashItem）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 * ⚠️ `builtin.ts` 是 **CRLF**、`main/index.ts` 是 **LF** —— 一律走共享 `sub`，不要自己写替换。
 * ⚠️ W 组不许写「诱饵」（保留 `setTrashService({` 只加 `if (false)`）—— 守卫按**文本**判，
 *   字串还在就照样绿，等于没测（见 mut-a1069 B10 教训）。必须真的把那一段删掉。
 *
 * 用法：node gui/scripts/mut-a1072-trash.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1072-trash.spec.ts";
const BUILTIN = "core-ts/src/tools/builtin.ts";
const MAIN = "gui/src/main/index.ts";
const TARGETS = [BUILTIN, MAIN];

/** 主进程里那段回收站注入（整块）—— W1 需要把它**真的删掉**，不能只加条件。 */
const TRASH_INJECTION = [
  "  setTrashService({",
  "    trash: async (absPath: string) => {",
  "      try {",
  "        await shell.trashItem(absPath);",
  "        return { ok: true };",
  "      } catch (e) {",
  "        return { ok: false, error: e instanceof Error ? e.message : String(e) };",
  "      }",
  "    },",
  "  });",
].join("\n");

const MUTATIONS = [
  // ── T 行为三态（file_delete）────────────────────────────────────────────────
  {
    name: "T1 回收站装配了却没用（`trash` 恒 null → 静默走永久删除）",
    file: BUILTIN,
    mutate: (t) => sub(t, "    const trash = trashServiceRef;", "    const trash = null;"),
  },
  {
    name: "T2 回收站失败时不再保守（退化为「永久删除」的语义，而文件其实还在）",
    file: BUILTIN,
    mutate: (t) => sub(t, "        if (!viaTrash && r?.error) {", "        if (false) {"),
  },
  {
    name: "T3 未注入时**谎报**已进回收站（用户以为能还原，实际不可还原）",
    file: BUILTIN,
    /* ⚠️ A-1122（③）改过这一行的形状：末尾从 `…`;` 变成 `…) + undoNote;`
       （`file_delete` 现在要把回滚账本的告警拼在回执尾部）⇒ 锚点必须跟着走，
       否则这条变异静默未命中 = 守卫**已失去保护**而没人知道（`check-mut-anchors` 会报未命中）。 */
    mutate: (t) => sub(
      t,
      "      : `已永久删除${what}：${abs}（未进回收站：当前环境未装配回收站能力，此操作不可还原）`) + undoNote;",
      "      : `已把${what}移入回收站：${abs}（可从系统回收站还原）`) + undoNote;",
    ),
  },

  // ── W 接线事实（主进程）─────────────────────────────────────────────────────
  {
    name: "W1 注入整块被移除（主进程忘了调用 → 回收站能力从未装配，而门禁全绿）",
    file: MAIN,
    mutate: (t) => sub(t, TRASH_INJECTION, "  /* A-1072 变异：注入被移除 */"),
  },
  {
    name: "W2 装配的是个空实现（调用了 setTrashService，但删的机制根本不是回收站）",
    file: MAIN,
    mutate: (t) => sub(t, "        await shell.trashItem(absPath);", "        void absPath; /* A-1072 变异：假装配 */"),
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

const originals = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(join(ROOT, t))]));
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 不给这道保险，变异会留在源码里，
   下一次跑脚本就会把「变异后的源码」当基线 → 整批变异静默假绿（2026-09-23 实测踩到）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1072-trash")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。
 *  ⚠️ 判据必须**两侧都 CJK**（单侧命中是合法的 `it("中文…")`），且必须**先剥注释**。
 *  ⚠️ 只扫**本次写的东西**（新守卫 + 本脚本）：整文件扫 `builtin.ts` 会把
 *     一堆**早就在那儿**的模板串报出来 —— 那是既有代码，不属于本次改动（范围蔓延）。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of [SPEC, "gui/scripts/mut-a1072-trash.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 引号自伤自检均通过\n");

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
  restoreAll();
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
