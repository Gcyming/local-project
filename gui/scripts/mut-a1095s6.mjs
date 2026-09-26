#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095s6.mjs — A-1095 #6（S6：吐字渐入节拍稳定化 / 闪烁根治）守卫的变异验证。
 *
 * 用户原话：「挤字问题看不到了（以后也不要让我看到），但**闪烁问题还是时有发生**」。
 * 属于**静默失效**类（过 tsc / 过构建 / 过逻辑测试，只在用户眼里翻车）。各变异锁一条判据：
 *   ① 水位判定失效（恒播）⇒ 回到每帧重挂重播 = 闪烁；
 *   ② 水位不推进（每帧都当新字符）⇒ 同上；
 *   ③ 去掉换轮重置 ⇒ 新一轮整轮漏播渐入；
 *   ④ 水位初值写成 0（`at` 从 0 起）⇒ 首字符不播；
 *   ⑤ 净化"被改成单调"（把断词拼合的 `{2,}` 放宽成 `+`）⇒ 引入误拼（`b c`→`bc`），
 *      本变异验证"A 组已知事实"守卫能抓住这类"顺手优化"。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）；模板字面量里的 `${` 必须转义为 `\${`。
 * ⚠️ 快照/还原走**字节**；还原后比 sha256，带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/gui/a1095-fade-stability.spec.ts",
  "tests/gui/a1065-fade-text.spec.ts",
  "tests/gui/a1061-visual.spec.ts",
];

const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_THINK = "gui/src/renderer/pages/thinkingText.ts";
const TARGETS = [F_PANEL, F_THINK];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095s6");

const MUTATIONS = [
  {
    name: "1 水位判定失效：恒挂渐入类（每帧重挂重播 = 闪烁）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "className={u.at > seenAt ? \"stream-fade-unit\" : undefined}",
      "className=\"stream-fade-unit\"",
    ),
  },
  {
    name: "2 水位不推进（每帧都当成新字符 ⇒ 全部重播）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "for (const u of units) { if (u.at > maxAtRef.current) { maxAtRef.current = u.at; } }",
      "for (const u of units) { if (u.at > maxAtRef.current) { /* 水位不推进 */ } }",
    ),
  },
  {
    name: "3 去掉换轮重置（新一轮整轮漏播渐入）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "if (!text.startsWith(prevTextRef.current)) { maxAtRef.current = -1; }",
      "",
    ),
  },
  {
    name: "4 水位初值写成 0（`at` 从 0 起 ⇒ 首字符不播渐入）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "const maxAtRef = React.useRef(-1);",
      "const maxAtRef = React.useRef(0);",
    ),
  },
  {
    name: "5 净化被改成「单调」：断词拼合 `{2,}` 放宽成 `+`（引入误拼 b c→bc）",
    file: F_THINK,
    mutate: (t) => sub(
      t,
      "\\b([b-hj-zB-HJ-Z])\\s+([a-z]{2,})\\b",
      "\\b([b-hj-zB-HJ-Z])\\s+([a-z]+)\\b",
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095s6")) { process.exit(1); }
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
