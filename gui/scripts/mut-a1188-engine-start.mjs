#!/usr/bin/env node
/**
 * gui/scripts/mut-a1188-engine-start.mjs — A-1188 守卫的变异验证。
 *
 * 被验证的守卫：`tests/core-ts/a1188-fade-engine-starts.spec.ts`
 * 它锁的不变量是「`runGeometrySyncFade` 必须在 `return` 之前做一次**首帧启动调度**」。
 *
 * ## 为什么这条不变量值得单独一个变异脚本
 * 它是**唯一**能拦住"引擎根本没跑起来"这类静默失效的守卫：
 * 本轮用户现象「侧边栏淡入淡出效果都没了」+「左侧边栏展开甚至都异常了」，
 * 根因就是源码里那行启动调用被误删 —— 常量全对、窗口全对、结构完备、语法合法、
 * 既有 4 份动画守卫**全部照绿**，只有真机探针（`probe-a1187-sidebar-fade.mjs`）看得出
 * 「内联 opacity 全程 `-` / 展开后恒 0」。⇒ 必须有变异证明这条守卫不是摆设。
 *
 * | # | 变异 | 应被抓住 |
 * |---|---|---|
 * | M1 | 删掉函数体内那行**启动**调度 | ① 计数=2 / ② 启动紧邻 return |
 * | M2 | 启动调度换成 `void step;`（保留引用但不调度） | ① |
 * | M3 | 删掉 `step` 内的**续播**调度（只跑第一帧） | ① |
 * | M4 | cancel 回调里补跑 `onFrame(1, true);`（A-1186 的回归） | ③ |
 *
 * ⚠️ 快照/还原一律走**字节** + manifest（sha256 校验）；`--restore` **必须无参可用**。
 * ⚠️ 判据 spec 清单从下面的 `SPECS` 读（`_run-mut-batch.sh` 不传参时自动取）。
 *    **别把已删除的 spec 留在清单里** —— vitest 找不到文件会报 "no tests" ⇒ 整批被判成
 *    "基线异常" ⇒ 后面所有变异都**假存活却不报错**（A-1173 踩过）。
 *
 * 用法：
 *   node gui/scripts/mut-a1188-engine-start.mjs --list
 *   node gui/scripts/mut-a1188-engine-start.mjs --apply 1
 *   node gui/scripts/mut-a1188-engine-start.mjs --restore
 *   全量：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1188-engine-start.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1188-fade-engine-starts.spec.ts",
];
const F_APP = "gui/src/renderer/App.tsx";
const TARGETS = [F_APP];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1188");

/* 启动调度那一行（2 空格缩进，紧邻 `return`）与 step 内续播那一行（4 空格缩进）在文本上
   是**不同的锚点** —— 这正是守卫 ① 用**计数**判据的原因：删掉任意一处都只剩 1。 */
const START_ANCHOR = "  raf = window.requestAnimationFrame(step);\n\n  return () => {";

const MUTATIONS = [
  {
    name: "M1 删掉函数体内的**启动**调度（只剩 step 内的续播 ⇒ 引擎一帧都不跑）",
    file: F_APP,
    mutate: (t) => sub(t, START_ANCHOR, "  return () => {"),
  },
  {
    name: "M2 启动调度换成 `void step;`（保留引用但不调度 ⇒ 同上）",
    file: F_APP,
    mutate: (t) => sub(t, START_ANCHOR, "  void step;\n\n  return () => {"),
  },
  {
    name: "M3 删掉 step 内的**续播**调度（只跑第一帧 ⇒ 进度停在第一帧、done 永不触发）",
    file: F_APP,
    mutate: (t) => sub(t, "    raf = window.requestAnimationFrame(step);\n  };", "  };"),
  },
  {
    name: "M4 cancel 回调里补跑 `onFrame(1, true);`（A-1186 的回归：新动画刚启动就被上一次的 cancel 写死）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    cancelled = true;\n    if (raf) { window.cancelAnimationFrame(raf); }",
      "    cancelled = true;\n    onFrame(1, true);\n    if (raf) { window.cancelAnimationFrame(raf); }",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  if (r.status !== 0) { return { ok: false, spawnBlocked: false }; }
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
    let next;
    try { next = m.mutate(text); }
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
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

/* ── full 模式 ── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t))]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = () => { for (const [t, buf] of originals) { writeFileSync(abs(t), buf); } };
process.on("SIGINT", () => { restoreAll(); process.exit(1); });
process.on("SIGTERM", () => { restoreAll(); process.exit(1); });

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 请用 --apply/--restore + shell 循环。");
  process.exit(1);
}
if (!base.ok) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

let caught = 0; const missed = [];
try {
  for (const m of MUTATIONS) {
    const src = originals.get(m.file).toString("utf8");
    let next;
    try { next = m.mutate(src); }
    catch (e) { console.error(`⚠️  ${m.name}\n    锚点未命中：${e.message}`); missed.push(m.name); continue; }
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中（变异体没落地）`); missed.push(m.name); continue; }
    writeFileSync(abs(m.file), next);
    const res = runSpecs();
    writeFileSync(abs(m.file), originals.get(m.file));
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
