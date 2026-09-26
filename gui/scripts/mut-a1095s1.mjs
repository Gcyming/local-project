#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095s1.mjs — A-1095（侧栏「Token 构成 / 明细」口径）守卫的变异验证。
 *
 * ## 这一条守的是什么
 *
 * 用户诉求（原话）：「我让你优化的是 **token 构成的明细展开部分**。」
 * 他闻到的"假信息"味来自两处**算术**缺陷：
 *   ① 「合计」写的是 `prompt + reply + reasoning + cache` —— 把两个**子集**又加了一遍
 *      （缓存读 ⊂ 输入、思考 ⊂ 回复；实测 47/47 条记录里 reasoning < completion），
 *      于是合计虚高约 86%（用户截图：17,007,635 vs 真实约 8.96M）；
 *   ② 图例第 4 项把「缓存读」错标成「其他」（值却是缓存读）—— 标签与值不同源。
 *
 * 判据一律收敛到纯函数 `contextMath.usageComposition`（与记账层 `computeRecordCost` **同源**）：
 *   · 输入侧 = `cacheReadInPrompt ? prompt : prompt + cacheRead`
 *   · 输出侧 = `max(completion, reasoning)`
 *   · 合计   = 输入侧 + 输出侧
 *
 * 属于**静默失效**类（过 tsc / 过构建 / 过所有逻辑测试，只在用户眼里翻车）。
 *
 * ## 变异各锁一根支柱
 *   1 输入侧不再剔除命中 → 缓存读被并计，合计虚高；
 *   2 输出侧退回 completion + reasoning → 思考被并计；
 *   3 协议语义缺省反了（true → false）→ OpenAI 系被当成 Anthropic，输入侧又虚高；
 *   4 构成微条退回"重叠四段"（分母仍含子集）→ 占比之和 ≠ 100%、条长不守恒；
 *   5 侧栏图例第 4 项错标回「其他」→ 值仍是缓存读，标签与值不同源；
 *   6 侧栏「合计」在 JSX 里现算一个和（不用 `c.total`）→ 换种写法照样重复计。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原走**字节**；还原后比 sha256，带 SIGINT 保险。
 * ⚠️ 目标文件行尾是**混的**（`RightSidebar.tsx` 是 CRLF、`contextMath.ts` 是 LF）⇒
 *    多行锚点一律走 `sub`（行尾无关），不要写裸 `"...\n..."`。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/context-math.spec.ts"];

const F_MATH = "gui/src/renderer/pages/contextMath.ts";
const F_SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const TARGETS = [F_MATH, F_SIDEBAR];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095s1");

const MUTATIONS = [
  {
    name: "1 输入侧不再剔除命中（缓存读被并计 → 合计虚高）",
    file: F_MATH,
    mutate: (t) => sub(
      t,
      "const inputSide = prompt + (cacheInPrompt ? 0 : cacheRead);",
      "const inputSide = prompt + cacheRead;",
    ),
  },
  {
    name: "2 输出侧退回 completion + reasoning（思考被并计）",
    file: F_MATH,
    mutate: (t) => sub(
      t,
      "const outputSide = Math.max(completion, reasoning);",
      "const outputSide = completion + reasoning;",
    ),
  },
  {
    name: "3 协议语义缺省反了（?? true → ?? false）：OpenAI 系被当成 Anthropic",
    file: F_MATH,
    mutate: (t) => sub(
      t,
      "const cacheInPrompt = t.cacheReadInPrompt ?? true;",
      "const cacheInPrompt = t.cacheReadInPrompt ?? false;",
    ),
  },
  {
    name: "4 构成微条退回重叠四段（分母仍含子集 → 占比之和 ≠ 100%）",
    file: F_MATH,
    mutate: (t) => sub(
      t,
      '{ label: "输入", pct: seg(missIn), color: "#4b9eff", n: missIn },',
      '{ label: "输入", pct: seg(c.inputSide), color: "#4b9eff", n: missIn },',
    ),
  },
  {
    name: "5 侧栏图例第 4 项错标回「其他」（值仍是缓存读 → 标签与值不同源）",
    file: F_SIDEBAR,
    mutate: (t) => sub(
      t,
      '<LegendDot color={C_CACHE} label="缓存读" value={dashOr(c.cacheRead)} pct={pctOf(c.cacheRead)} />',
      '<LegendDot color={C_CACHE} label={`其他 ${pct(pctOf(c.cacheRead))}`} value={dashOr(c.cacheRead)} pct={pctOf(c.cacheRead)} />',
    ),
  },
  {
    name: "6 侧栏「合计」在 JSX 里现算一个和（不用 c.total → 照样重复计）",
    file: F_SIDEBAR,
    mutate: (t) => sub(
      t,
      "{c.total.toLocaleString()}",
      "{(c.inputSide + c.cacheRead + c.outputSide + c.reasoning).toLocaleString()}",
    ),
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
    if (existsSync(manifestPath)) { console.error("上一轮的变异还没还原 —— 先跑 --restore。"); process.exit(1); }
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
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，全量模式跑不了。"); process.exit(1); }
if (!base.ok) { console.error(`基线未通过（${base.spec}）。`); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败。"); process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095s1")) { process.exit(1); }
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
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
