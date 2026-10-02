#!/usr/bin/env node
/**
 * gui/scripts/mut-a1149-float-gap.mjs — A-1149 守卫的变异验证。
 *
 * 本轮修的是「左栏收起 + 聊天悬浮 + 右栏占满 → 左边缘多出一小块空白」。
 * 它由**两个独立产地**共同造成，去掉任何一个都不算修好（这正是变异要逐条证明的）：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | 取值 | `rightSidebarMaxW` 悬浮分支仍减 48 | 那 48px 变成 `.main` 的实宽（左边缘空白） |
 * | 入口 | `handleToggleFloat` 仍请求 `innerWidth - 48` | 点「窗口化」立刻复现同一条空白 |
 * | 上限 | CSS `max-width: min(100%, calc(100vw - 48px))` | 即使请求整窗宽也够不到 → 缺口跑到右边 |
 * | 前提 | `.main.main-float { min-width: 0 }` 被删 | 悬浮态主区不让位 → 右栏被挤 / 溢出 |
 * | 前提 | 右栏 wrapper 不再 `flexShrink: 1` | 左栏展开时右栏不让位 → 整行溢出 |
 * | 回归 | `.sidebar.collapsed` 不再 0 宽 | 收起的左栏又占位（用户最初报的那条） |
 *
 * ## 覆盖的六条
 *
 *   1     `rightSidebarMaxW` 悬浮分支退回 `innerWidth - 48`
 *   2     `handleToggleFloat` 退回 `Math.max(560, innerWidth - 48)`
 *   3     `.right-sidebar` 的 max-width 退回 `min(100%, calc(100vw - 48px))`
 *   4     `.main.main-float` 的 `min-width: 0` 退回非零
 *   5     right-wrapper 内联样式 `flexShrink: 1` → 0（不再让位）
 *   6     `.sidebar.collapsed` 的 `width: 0 !important` 退回比例宽
 *
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险（_mut-eol 提供）。
 * ⚠️ 锚点用 `sub()`（行尾无关）——本仓行尾是混的，裸 `\n` 多行锚点会静默失效。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1149-float-gap.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1149-float-gap.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1149-float-gap.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1149-float-gap.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1149-float-gap.spec.ts"];

const F_APP = "gui/src/renderer/App.tsx";
const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_APP, F_CSS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1149");

const MUTATIONS = [
  /* ── ① 取值：悬浮上限又减 48（核心缺陷原样复现）────────────────── */
  {
    name: "1 rightSidebarMaxW 悬浮分支退回 innerWidth - 48（左边缘那条空白回来了）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      ? window.innerWidth\n      : Math.min(window.innerWidth - 48, window.innerWidth - leftW - CHAT_MIN_W));",
      "      ? window.innerWidth - 48\n      : Math.min(window.innerWidth - 48, window.innerWidth - leftW - CHAT_MIN_W));",
    ),
  },
  {
    name: "2 handleToggleFloat 退回 innerWidth - 48（点「窗口化」就复现同一条空白）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    animateRightSidebar(true, Math.max(560, window.innerWidth));",
      "    animateRightSidebar(true, Math.max(560, window.innerWidth - 48));",
    ),
  },

  /* ── ② 上限：CSS 里那第二份拷贝回来了 ─────────────────────────── */
  {
    name: "3 .right-sidebar 的 max-width 退回 min(100%, calc(100vw - 48px))（缺口跑到右边）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  max-width: 100%;\n  background: var(--bg-secondary);",
      "  max-width: min(100%, calc(100vw - 48px));\n  background: var(--bg-secondary);",
    ),
  },

  /* ── ③ 几何前提：三条支撑（去掉任一条，取值对了也白搭）────────── */
  {
    name: "4 .main.main-float 不再允许收成 0（主区不让位 ⇒ 右栏被挤 / 溢出）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      ".main.main-float {\n  min-width: 0;\n}",
      ".main.main-float {\n  min-width: 380px;\n}",
    ),
  },
  {
    name: "5 right-wrapper 不再 flexShrink: 1（左栏展开时右栏不让位 ⇒ 整行溢出）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'style={{ display: "flex", flexShrink: 1, minWidth: 0 }}',
      'style={{ display: "flex", flexShrink: 0, minWidth: 0 }}',
    ),
  },
  {
    name: "6 .sidebar.collapsed 退回比例宽（收起的左栏又占位 —— 用户最初报的那条）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      ".sidebar.collapsed {\n  width: 0 !important;",
      ".sidebar.collapsed {\n  width: var(--sidebar-w) !important;",
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1149")) { process.exit(1); }
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
