#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095.mjs — A-1095 S0（激励语独占最后一行）守卫的变异验证。
 *
 * 用户原话：「你把激励语换个行，换到最后一行，现在跟状态返回一行的话，有时候激励语过长
 * 会出现自动换行的问题，干脆直接换到最后一行吧。」
 *
 * 改前形态：`LiveStatusLine` 是一行 `flex + flexWrap:"wrap"`，主句 / 副句 / 激励语同级 ——
 * 激励语一长就把主句挤到下一行，观感是"状态行莫名断行"。
 * 改后形态：外层 `flexDirection:"column"`，第一行只放主句+副句（仍可 wrap），激励语独占第二行。
 *
 * 这属于**静默失效**类：改回去过 tsc、过构建、过所有逻辑测试，只在用户眼里翻车。
 * 三条变异各锁一个判据：
 *   ① 两行式容器被改回单行 → 激励语重新进入主句行内流（挤跑主句的根因回来）；
 *   ② 激励语被搬回主句 flex-wrap 行内（结构撤销）；
 *   ③ 激励语字号回退到 11.5px（"又细又小"回归）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1095.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1095.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1095.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1095.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1061-visual.spec.ts"];

const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095");

const MUTATIONS = [
  /* ── ① 两行式容器（flexDirection: "column"）被改回单行 ─────────────── */
  {
    name: "1 外层改回单行 flex-wrap（激励语重入主句行内流 → 长文本挤跑主句）",
    file: F_PANEL,
    /* ⚠️ A-1106（问题 3）在 `padding` 那行**之前**插了三行注释、字号 13 → 14.5：
       旧锚点（三行连续文本）随之漂移、**本条目从"已核验"变成"未命中"**。
       现改锚到**容器那一行**（单行、与字号无关）—— 本条的判据是"外层是不是两行式"，
       与字号没有关系；锚在字号上只会被无关改动反复打红（这正是上一版踩到的那类**装饰性耦合**）。 */
    mutate: (t) => sub(
      t,
      '      display: "flex", flexDirection: "column", gap: 2,',
      '      display: "flex", flexWrap: "wrap", gap: 2,',
    ),
  },

  /* ── ② 激励语被搬回主句 flex-wrap 行内 ─────────────────────────────── */
  {
    name: "2 激励语被搬回主句行内（独占最后一行的结构被撤销）",
    file: F_PANEL,
    /* A-1106（问题 3）：副句 11.5 → 13、激励语 13 → 14 ⇒ 锚点两处一起跟随（判据不变）。 */
    mutate: (t) => sub(
      t,
      '        {status.detail && (\n          <span style={{ color: "var(--text-dim)", fontSize: 13 }}>· {status.detail}</span>\n        )}\n      </div>',
      '        {status.detail && (\n          <span style={{ color: "var(--text-dim)", fontSize: 13 }}>· {status.detail}</span>\n        )}\n        {cheer && (\n          <span style={{ color: "var(--text-secondary)", fontSize: 14, fontWeight: 500, minWidth: 0 }}>\n            {cheer}\n          </span>\n        )}\n      </div>',
    ),
  },

  /* ── ③ 激励语字号回退 ──────────────────────────────────────────────── */
  {
    name: "3 激励语字号回退到 11.5px（「又细又小」回归）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '        <span style={{ color: "var(--text-secondary)", fontSize: 14, fontWeight: 500, minWidth: 0 }}>\n          {cheer}',
      '        <span style={{ color: "var(--text-dim)", fontSize: 11.5, minWidth: 0 }}>\n          {cheer}',
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
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095")) { process.exit(1); }
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
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
