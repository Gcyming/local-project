#!/usr/bin/env node
/**
 * gui/scripts/mut-a1104.mjs — A-1104 守卫的变异验证（「保存按钮点了没反应、弹层不关、值不落盘」）。
 *
 * 事故本体：`gui/src/renderer/pages/ResidentPanel.tsx` 的保存按钮，`onClick` 写成
 *
 *     onClick={() => void (async () => { … })}
 *                                       ↑ 少了尾部这一对括号
 *
 * —— **构造**了一个 async 函数、`void` 掉、**从不调用**。于是 handler 体一行都不执行：
 * 弹层卡住不关、选中模型不落盘、**连报错都没有**（静默失效家族，只在用户眼里翻车）。
 *
 * 守卫 `tests/gui/a1104-async-iife-call.spec.ts` **不查文本、查 AST**：
 *   `void` 的操作数是不是一个「从未被调用」的函数（只有语法树能答这个问题）。
 *
 * ## 覆盖的五条（每条都要让守卫变红）
 *
 *   1  【事故本体】保存按钮退回「从不调用」形态（`})()}>` → `})}>`）
 *      —— 这正是用户报的那一处，锁住修复本身。
 *   2  同族·**渲染层另一产地**：`RuntimePanel` 的加载 IIFE 退回「从不调用」
 *      —— 防「守卫只认 ResidentPanel 那一行」这种锁错对象的假守卫。
 *   3  同族·**主进程另一扫描根**：`adb.ts` 的命令执行 IIFE 退回「从不调用」
 *      —— 若这条逃逸，说明全仓扫描根本没遍历到 `gui/src/main`（等于半个仓库没守）。
 *   4  形状②：**裸 IIFE 从不调用**（去掉 `void` + 去掉尾部调用 ⇒ 表达式语句）
 *      —— 证明检测器的第二支不是死代码。
 *   5  **检测器空转**（`scanText` 永远返回 0 命中）
 *      —— 必须由 spec 自己的自检（S1 喂已知坏样本）打红；
 *         这一条若逃逸，说明「守卫绿」只是检测器瞎了（§15① 最危险的一种）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 目标文件行尾是**混的**（ResidentPanel / RuntimePanel / adb.ts = CRLF；spec = LF）
 *    ⇒ 一律走共享模块 `sub()`（它自己做行尾无关）。
 * ⚠️ 每条变异的**首** `sub(t, CONST, …)` 必须锚在一个顶层常量上（`check-mut-anchors.mjs`
 *    只核验首条锚点）。同族语句的锚点**必须带上文**（后缀陷阱 A-1088）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1104.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1104.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1104.mjs --apply 2   # 只改第 2 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1104.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   set -o pipefail                      # ⚠️ 没有它，$? 取到的是 sed 的退出码（恒 0）⇒ 全部误报
 *   for n in 1 2 3 4 5; do
 *     node gui/scripts/mut-a1104.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     out=$(node node_modules/vitest/vitest.mjs run tests/gui/a1104-async-iife-call.spec.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
 *     red=$?
 *     node gui/scripts/mut-a1104.mjs --restore >/dev/null
 *     if [ "$red" = "1" ] && printf '%s' "$out" | grep -q "Tests" && printf '%s' "$out" | grep -q "AssertionError"; then
 *       echo "M$n ✅ 被捕获"; else echo "M$n ❌ 未被捕获"; fi
 *   done
 *   ```
 *   ⚠️ 判捕获必须**同时**确认输出里有 `Tests` 汇总行与 `AssertionError` ——
 *   否则「零测试执行」（收集失败）会被当成捕获。
 *   ⚠️ 必须**从仓库根**跑 vitest（从 `gui/` 跑会加载 `gui/vite.config.ts` ⇒ Startup Error、零测试执行）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1104-async-iife-call.spec.ts"];

const F_RESIDENT = "gui/src/renderer/pages/ResidentPanel.tsx"; // CRLF
const F_RUNTIME = "gui/src/renderer/pages/RuntimePanel.tsx"; // CRLF
const F_ADB = "gui/src/main/adb.ts"; // CRLF
const F_SPEC = "tests/gui/a1104-async-iife-call.spec.ts"; // LF
const TARGETS = [F_RESIDENT, F_RUNTIME, F_ADB, F_SPEC];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1104");

/* ── 锚点：一律顶层常量（`check-mut-anchors.mjs` 的 constMap 才能解析） ── */

/** ① 保存按钮：尾部**调用**（正确形态）—— 事故本体就是这里少了 `()` */
const SAVE_TAIL = "})()}>保存</button>";
/** ① 退回「从不调用」形态 */
const SAVE_TAIL_UNCALLED = "})}>保存</button>";

/** ② RuntimePanel 加载 IIFE 的尾部（单行 `await load();` 在文件里有 4 处，
 *  故锚点**必须带上一行上下文**，否则改的可能是别处 —— A-1088 后缀陷阱） */
const RP_TAIL =
  "      await load();\n"
  + "    })();";
const RP_TAIL_UNCALLED =
  "      await load();\n"
  + "    });";

/** ④ 形状②要把 `void ` 摘掉（让 IIFE 变成裸表达式语句）；该串在 RuntimePanel 里唯一 */
const RP_VOID_OPEN = "void (async () => {";

/** ③ adb.ts 命令执行 IIFE 的尾部（`      })();` 这类缩进在文件里不唯一 ⇒ 带三行上下文） */
const ADB_TAIL =
  "            buffer: Buffer.isBuffer(stdout) ? stdout : undefined,\n"
  + "          });\n"
  + "        });\n"
  + "      })();";
const ADB_TAIL_UNCALLED =
  "            buffer: Buffer.isBuffer(stdout) ? stdout : undefined,\n"
  + "          });\n"
  + "        });\n"
  + "      });";

/** ⑤ 检测器的返回（把它改成恒空 ⇒ 检测器空转，只能靠 spec 自己的 S1 自检打红） */
const DETECTOR_RETURN = "  return { uncalled, called };";
const DETECTOR_RETURN_DEAD = "  return { uncalled: [], called };";

const MUTATIONS = [
  /* ── ① 事故本体 ─────────────────────────────────────────────── */
  {
    name: "1 【事故本体】保存按钮退回「从不调用」（`})()}>` → `})}>`）⇒ 弹层不关 + 值不落盘 + 零报错",
    file: F_RESIDENT,
    mutate: (t) => sub(t, SAVE_TAIL, SAVE_TAIL_UNCALLED),
  },

  /* ── ② 同族：另一处产地 / 另一个扫描根 ───────────────────────── */
  {
    name: "2 同族·渲染层另一产地：RuntimePanel 加载 IIFE 退回「从不调用」（防守卫只认 ResidentPanel）",
    file: F_RUNTIME,
    mutate: (t) => sub(t, RP_TAIL, RP_TAIL_UNCALLED),
  },
  {
    name: "3 同族·主进程另一扫描根：adb.ts 命令执行 IIFE 退回「从不调用」（逃逸=半个仓库没扫）",
    file: F_ADB,
    mutate: (t) => sub(t, ADB_TAIL, ADB_TAIL_UNCALLED),
  },

  /* ── ③ 形状②：裸 IIFE 从不调用 ──────────────────────────────── */
  {
    name: "4 形状②（无 `void`）：摘掉 `void ` + 去掉尾部调用 ⇒ 裸 IIFE 从不调用（证明第二支不是死代码）",
    file: F_RUNTIME,
    mutate: (t) => sub(sub(t, RP_VOID_OPEN, "(async () => {"), RP_TAIL, RP_TAIL_UNCALLED),
  },

  /* ── ④ 检测器自己空转 ───────────────────────────────────────── */
  {
    name: "5 检测器空转：`scanText` 恒返回 0 命中（守卫只会「绿」——必须被 spec 自检 S1 打红）",
    file: F_SPEC,
    mutate: (t) => sub(t, DETECTOR_RETURN, DETECTOR_RETURN_DEAD),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

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
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);           // **字节**备份
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* 中断即还原：`finally` 在 Ctrl+C（SIGINT 直接终止、不展开栈）下**不执行** ——
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（本仓实测踩到过）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1104")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) {
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

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
