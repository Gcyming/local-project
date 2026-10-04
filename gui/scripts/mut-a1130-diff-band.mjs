#!/usr/bin/env node
/**
 * gui/scripts/mut-a1130-diff-band.mjs — A-1130（diff 行底色铺到极限位置）的变异验证。
 *
 *   1  `.diff-rows-fit` 不再 grid（行宽各按自己的字宽 ⇒ 用户报的「只加在字后面」）
 *   2  列宽换成裸 `max-content`（没有弹性 ⇒ 内容比可视区窄时右侧缺一块底色）
 *   3  行上写回 `width: max-content`（definite width ⇒ grid item 不再 stretch）
 *   4  行上写回 `min-width: 100%`（只兜到可视宽，横向滚动后短行右侧露白）
 *   5  工具卡 / 思考历程的 diff 容器没戴这个类（接线断）
 *   6  右栏逐行 diff 容器没戴（同物异形：这儿到边、那儿不到）
 *   7  给**换行型** diff（`.prod-diff`）也戴上（取消换行、长行改为横向溢出）
 *   8  退回 `minmax(100%, max-content)`（**2026-09-28 实测过的真回归**：`100%` 吃掉 free space
 *      ⇒ 列轨涨不到最宽行 ⇒ 有长行时行盒停在可视宽、文字溢出轨道外 ⇒ 底色断掉、向右滚露白）
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环：
 *      for i in $(seq 1 8); do node gui/scripts/mut-a1130-diff-band.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run tests/gui/a1130-diff-row-band.spec.ts \
 *             --config vitest.config.ts --reporter=dot; node gui/scripts/mut-a1130-diff-band.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行。
 *   ⚠️ 第 8 条的**真判据**是几何（`gui/scripts/probe-diff-band.mjs` 用真实 Chromium 量），
 *      spec 里那条"不许出现 `minmax(100%`"只是它的**漂移守卫**（静态、快、能被变异弄红）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1130-diff-row-band.spec.ts";
const F_CSS = "gui/src/renderer/index.css";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const TARGETS = [F_CSS, F_PANEL, F_SIDEBAR];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1130");

const MUTATIONS = [
  {
    name: "1 `.diff-rows-fit` 不再 grid（行宽各按自己的字宽 ⇒ 只加在字后面）",
    file: F_CSS,
    mutate: (t) => sub(t, "  display: grid;\n  grid-template-columns: minmax(min-content, 1fr);", "  display: block;\n  grid-template-columns: minmax(min-content, 1fr);"),
  },
  {
    name: "2 列宽换成裸 max-content（没有弹性 ⇒ 内容比可视区窄时右侧缺一块底色）",
    file: F_CSS,
    mutate: (t) => sub(t, "  grid-template-columns: minmax(min-content, 1fr);", "  grid-template-columns: max-content;"),
  },
  {
    name: "3 行上写回 `width: max-content`（definite width ⇒ grid item 不再 stretch）",
    file: F_CSS,
    mutate: (t) => sub(t, "  /* ⚠️ 不写 width / min-width：宽度由容器的列轨统一决定（见 `.diff-rows-fit`）。\n     `min-width: 0` 只是保证长行不把行盒撑破、交由容器横向滚动。 */\n  min-width: 0;", "  width: max-content;\n  min-width: 0;"),
  },
  {
    name: "4 行上写回 `min-width: 100%`（只兜到可视宽，横向滚动后露白）",
    file: F_CSS,
    mutate: (t) => sub(t, "  min-width: 0;\n}\n.think-diff-row.diff-add", "  min-width: 100%;\n}\n.think-diff-row.diff-add"),
  },
  {
    name: "5 工具卡 / 思考历程的 diff 容器没戴这个类（接线断）",
    file: F_PANEL,
    mutate: (t) => sub(t, 'className="think-diff-body diff-rows-fit"', 'className="think-diff-body"'),
  },
  {
    name: "6 右栏逐行 diff 容器没戴（同物异形：这儿到边、那儿不到）",
    file: F_SIDEBAR,
    mutate: (t) => sub(t, 'className="diff-rows-fit"', 'className="diff-rows-x"'),
  },
  {
    name: "7 给换行型 diff（`.prod-diff`）也戴上（取消换行、长行横向溢出）",
    file: F_PANEL,
    mutate: (t) => sub(t, 'className="prod-diff"', 'className="prod-diff diff-rows-fit"'),
  },
  {
    /* ⚠️ 这条**不是假想** —— 它就是 A-1130 首版写下的写法，2026-09-28 被用户截图打回。
       几何后果（真实 Chromium 量过）：列轨 = 可视宽 874，而滚动内容 1243 ⇒
       有长行的 diff 一旦向右滚，底色就断在半路、文字露在带子外面。
       ⇒ 它必须被"不许出现 `minmax(100%`"这条漂移守卫弄红。 */
    name: "8 退回 `minmax(100%, max-content)`（100% 吃掉 free space ⇒ 有长行时底色断掉）",
    file: F_CSS,
    mutate: (t) => sub(t, "  grid-template-columns: minmax(min-content, 1fr);", "  grid-template-columns: minmax(100%, max-content);"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

function runSpec() {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply" : "full";

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

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1130")) { process.exit(1); }
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
    const res = runSpec();
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
