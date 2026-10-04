#!/usr/bin/env node
/**
 * gui/scripts/mut-a1127-subagent-panel.mjs — A-1127（子代理悬浮面板只看最近 5 条）的变异验证。
 *
 *   1  `latestSubagentRuns` 取**最旧**的 5 条（"最近跑的不在列表里"，tsc 不报）
 *   2  取对了但不反转（最旧的在最上面 —— 用户要的是"最新的"）
 *   3  上限常量被放大成 100（面板又回到"一直积累、无限长高"）
 *   4  组件不再走唯一判据（全量列出）
 *   5  组件又自己反转全量列表（同 4，另一条来路）
 *   6  列表容器去掉高度上限（条目一多就把输入框往上顶）
 *   7  列表容器去掉滚动（超出的条目直接看不到）
 *   8  计数文案不走唯一出处（与设置页口径分家）
 *   9  **设置页**也被套上 5 条上限（用户的历史被静默砍掉 —— 最严重的一条）
 *   10 设置页的「清空历史」入口没接线（用户要的"可主动删除"点了没反应）
 *   11 存储上限也从 100 砍到 5（用户裁决是"保持 100 条 + 手动清空"）
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环：
 *      for i in $(seq 1 11); do node gui/scripts/mut-a1127-subagent-panel.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run tests/gui/a1127-subagent-panel.spec.ts \
 *             --config vitest.config.ts --reporter=dot; node gui/scripts/mut-a1127-subagent-panel.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（否则是"没跑到"而不是"被抓到"）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1127-subagent-panel.spec.ts";
const F_MODULE = "gui/src/renderer/pages/subAgentPanel.ts";
const F_BTN = "gui/src/renderer/pages/SubAgentExpandButton.tsx";
const F_SETTINGS = "gui/src/renderer/pages/ResidentPanel.tsx";
const F_STORE = "gui/src/main/subagentStore.ts";
const TARGETS = [F_MODULE, F_BTN, F_SETTINGS, F_STORE];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1127");

const MUTATIONS = [
  {
    name: "1 latestSubagentRuns 取最旧的 N 条（最近跑的反而不在列表里）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  return runs.slice(runs.length - n).reverse();", "  return runs.slice(0, n).reverse();"),
  },
  {
    name: "2 取对了尾部但不反转（最旧的在最上面 —— 用户要的是「最新的」）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  return runs.slice(runs.length - n).reverse();", "  return runs.slice(runs.length - n);"),
  },
  {
    name: "3 上限常量放大成 100（面板又回到一直积累、无限长高）",
    file: F_MODULE,
    mutate: (t) => sub(t, "export const SUBAGENT_PANEL_LIMIT = 5;", "export const SUBAGENT_PANEL_LIMIT = 100;"),
  },
  {
    name: "4 组件不再走唯一判据（全量列出）",
    file: F_BTN,
    mutate: (t) => sub(t, "  const visible = latestSubagentRuns(runs);", "  const visible = runs;"),
  },
  {
    name: "5 组件又自己反转全量列表（另一条来路：上限没接上）",
    file: F_BTN,
    mutate: (t) => sub(t, "              {visible.map((r) => {", "              {runs.slice().reverse().map((r) => {"),
  },
  {
    name: "6 列表容器去掉高度上限（条目一多就把输入框往上顶）",
    file: F_BTN,
    mutate: (t) => sub(
      t,
      'style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 340, overflow: "auto" }}',
      'style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}',
    ),
  },
  {
    name: "7 列表容器去掉滚动（超出的条目直接看不到，用户要的是滚动）",
    file: F_BTN,
    mutate: (t) => sub(
      t,
      'style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 340, overflow: "auto" }}',
      'style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 340 }}',
    ),
  },
  {
    name: "8 计数文案不走唯一出处（显示数与总数两处各写一份）",
    file: F_BTN,
    mutate: (t) => sub(t, "{subagentPanelCountLabel(runs.length, visible.length)}", "{`子代理 (${runs.length})`}"),
  },
  {
    name: "9 **设置页**也被套上 5 条上限（用户的历史被静默砍掉 —— 最严重的一条）",
    file: F_SETTINGS,
    mutate: (t) => sub(t, "{[...runs].reverse().map((r) => {", "{latestSubagentRuns(runs).map((r) => {"),
  },
  {
    name: "10 设置页的「清空历史」入口没接线（用户要的「可主动删除」点了没反应）",
    file: F_SETTINGS,
    mutate: (t) => sub(t, "onClick={() => void clearRuns()}", "onClick={() => void 0}"),
  },
  {
    name: "11 存储上限也从 100 砍到 5（用户裁决是「保持 100 条 + 手动清空」）",
    file: F_STORE,
    mutate: (t) => sub(t, "export const SUBAGENT_RUN_CAP = 100;", "export const SUBAGENT_RUN_CAP = 5;"),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1127")) { process.exit(1); }
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
