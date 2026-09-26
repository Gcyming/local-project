#!/usr/bin/env node
/**
 * gui/scripts/mut-a1105.mjs — A-1105 守卫的变异验证（子代理弹层 markdown 渲染失效）。
 *
 * 事故本体两处，都在 `gui/src/renderer/pages/Markdown.tsx` 的 `normalizeMarkdownBlocks` 链上：
 *
 *   ① 行内标题解塞把**表格表头单元格里的 `#`** 当成标题标记
 *        `| # | 目标 | 结果 |`  →  `| ` + `# | 目标 | 结果 |`
 *      ⇒ 表头行变标题、分隔行+数据行并成段落 ⇒ 表格解体、管道符裸露。
 *      该正则有两道边界，**各自独立**：左（最近非空白不是 `|`）+ 右（标记后不是 空白+`|`）。
 *   ② 给**每一个**块标记行前补空行 ⇒ 每个列表项被切成单元素列表
 *      ⇒ 10 项编号 = 10 个 `<ol>`（每行都从「1.」重编号）。
 *      修法是「同类列表项之间不补空行」+「列表块结束处要补空行」——**两者缺一不可**：
 *      只做前者，`1. a\n2. b\n结束。` 会把正文并进列表 para ⇒ 整块退化成段落（本修复第二轮实测到）。
 *
 * 守卫 `tests/gui/a1105-md-guards.spec.ts` 的判据是**端到端 HTML 上的计数**（table/td/ol/ul/li
 * 个数 + 伪标题个数），不是 `toContain` —— 因为事故形态的特征就是「数量不对」。
 *
 * ## 覆盖的五条（每条都要让守卫变红）
 *
 *   1  【事故本体】抹掉正则的**左**边界 ⇒ 表头 `#` 再次被当标题（表格解体）
 *   2  同族·**另一道边界**：抹掉**右**边界（`#` 独占单元格的判据）
 *      —— 若这条逃逸，说明右边界是死代码，可删；删掉它 `| # |` 又会解体。
 *   3  列表：`sameListKind` 恒 false（= 退回「每项都补空行」的旧行为）⇒ N 个单元素列表
 *   4  列表：`listEnds` 恒 false ⇒ 列表后接正文整块退化成段落（**我这次差点引入的回归**）
 *   5  判据空转：spec 的 `heads()` 改成恒 0（伪标题判据瞎了）
 *      —— 必须由 spec 自己的自检（③）打红；若逃逸，说明「守卫绿」只是判据瞎了（§15①）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 目标文件行尾是**混的**：`Markdown.tsx` = CRLF，新 spec = LF ⇒ 一律走共享模块
 *    `_mut-eol.mjs` 的 `sub()`（它自己做行尾无关）。
 * ⚠️ 每条变异的**首** `sub(t, CONST, …)` 必须锚在一个顶层常量上（`check-mut-anchors.mjs`
 *    只核验首条锚点）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1105.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1105.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1105.mjs --apply 3   # 只改第 3 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1105.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   set -o pipefail                      # ⚠️ 没有它，$? 取到的是 sed 的退出码（恒 0）⇒ 全部误报
 *   for n in 1 2 3 4 5; do
 *     node gui/scripts/mut-a1105.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     out=$(node node_modules/vitest/vitest.mjs run tests/gui/a1105-md-guards.spec.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
 *     red=$?
 *     node gui/scripts/mut-a1105.mjs --restore >/dev/null
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
const SPECS = ["tests/gui/a1105-md-guards.spec.ts"];

const F_MD = "gui/src/renderer/pages/Markdown.tsx"; // CRLF
const F_SPEC = "tests/gui/a1105-md-guards.spec.ts"; // LF
const TARGETS = [F_MD, F_SPEC];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1105");

/* ── 锚点：一律顶层常量（`check-mut-anchors.mjs` 的 constMap 才能解析） ── */

/** ① 行内标题解塞正则（**正确**形态：左右两道边界都在） */
const HEAD_RE = "const INLINE_HEADING_RE_TARGET = /([^A-Za-z0-9_#])(?<!\\|[\\s]*)(#{1,6})(?!\\s*\\|)(?=\\s+\\S)/g;";
/** ① 抹掉**左**边界（`(?<!\|[\s]*)`）—— 表头 `#` 再次被当标题 */
const HEAD_RE_NO_LEFT = "const INLINE_HEADING_RE_TARGET = /([^A-Za-z0-9_#])(#{1,6})(?!\\s*\\|)(?=\\s+\\S)/g;";
/** ② 抹掉**右**边界（`(?!\s*\|)`）—— 单元格独占 `#` 的判据消失 */
const HEAD_RE_NO_RIGHT = "const INLINE_HEADING_RE_TARGET = /([^A-Za-z0-9_#])(?<!\\|[\\s]*)(#{1,6})(?=\\s+\\S)/g;";

/** ③ 同类列表项判定（正确形态：按 `ol`/`ul` 分类比较） */
const LIST_SAME = "      const sameListKind = kind !== null && kind === prevKind;";
const LIST_SAME_OFF = "      const sameListKind = false;";
/** ④ 列表块结束隔断（正确形态：列表项后紧跟正文行 ⇒ 补空行） */
const LIST_END = "      const listEnds = kind === null && prevKind !== null && l.trim() !== \"\";";
const LIST_END_OFF = "      const listEnds = false;";

/** ⑤ 伪标题判据（spec 侧）：改成恒 0 ⇒ 判据空转，只能靠 spec 自己的自检（③）打红 */
const HEADS_FN = "const heads = (h: string): number => (h.match(/font-weight:700/g) ?? []).length;";
const HEADS_FN_DEAD = "const heads = (_h: string): number => 0;";

const MUTATIONS = [
  /* ── ① 事故本体：表格表头里的 `#` ────────────────────────────── */
  {
    name: "1 【事故本体】抹掉标题解塞正则的**左**边界 ⇒ 表头 `#` 再次被当标题、表格解体",
    file: F_MD,
    mutate: (t) => sub(t, HEAD_RE, HEAD_RE_NO_LEFT),
  },
  {
    name: "2 同族·另一道边界：抹掉**右**边界（`#` 独占单元格）⇒ 若逃逸则说明它是死代码",
    file: F_MD,
    mutate: (t) => sub(t, HEAD_RE, HEAD_RE_NO_RIGHT),
  },

  /* ── ② 列表：块级 vs 行级 ───────────────────────────────────── */
  {
    name: "3 列表退回「每项都补空行」（sameListKind 恒 false）⇒ 10 项编号变成 10 个单元素 `<ol>`",
    file: F_MD,
    mutate: (t) => sub(t, LIST_SAME, LIST_SAME_OFF),
  },
  {
    name: "4 关掉「列表块结束隔断」（listEnds 恒 false）⇒ 列表后接正文整块退化成段落、编号裸露",
    file: F_MD,
    mutate: (t) => sub(t, LIST_END, LIST_END_OFF),
  },

  /* ── ③ 判据自己空转 ─────────────────────────────────────────── */
  {
    name: "5 判据空转：spec 的 `heads()` 恒 0（伪标题判据瞎了 —— 必须被 spec 自检 ③ 打红）",
    file: F_SPEC,
    mutate: (t) => sub(t, HEADS_FN, HEADS_FN_DEAD),
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
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿。 */
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1105")) { process.exit(1); }
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
