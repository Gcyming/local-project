#!/usr/bin/env node
/**
 * gui/scripts/mut-a1156-right-content-fill.mjs — A-1156 守卫的变异验证。
 *
 * 本轮修的是「浮层态下右栏**内容列**一直是窄窄一条，用户原话『右侧边栏内容**一直是只有一段**』」。
 * 真机证据（`gui/scripts/probe-a1155-cdp.mjs`，1332px 窗口 / 左栏 240px）：
 *   修前 `.right-sidebar` 已铺满 1092px，而 `.right-body` 被 `max-width` 卡在 620px
 *   ⇒ `fillRatio = 620/1092 = 0.568`，左右各空 236px（截图 `gui/out/_r7-shots-before/s1-float-settled.png`）。
 *
 * 缺陷由**两个产地**共同造成，去掉任何一个都不算修好：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | 稳态 | CSS `.right-body` 的 `max-width` 封顶 620px | 内容只占右栏 57%，两侧留白 |
 * | 过渡 | JS 的 `--right-body-pin` 用另一套公式（且夹了非浮层上限） | 过渡结束时内容宽度突跳 |
 * | 同步 | `--left-w` 只有三个主动写点，失同步后无人纠偏 | 现象④：右栏右缘越窗 239px |
 *
 * ## 覆盖的六条
 *
 *   1  CSS 上限退回 `min(620px, 62%)`（缺陷原样复现）
 *   2  CSS 上限退回 620px（形态对、数值错 ⇒ 大窗口上又只剩一小段）
 *   3  CSS 上限与 JS 常量**脱钩**（改成 2600px ⇒ 过渡 pin 与稳态不同式）
 *   4  JS pin 退回 `min(620, targetW × 0.62)`（与稳态不同式 ⇒ 过渡结束突跳）
 *   5  JS 浮层支重新夹 `rightSidebarMaxW()`（那一刻 `floatStateRef` 还是 "none" ⇒ 夹回非浮层上限）
 *   6  去掉 `:not(:has(webview))`（浏览器页被限宽 ⇒ 网页缩成中间一列）
 *   7  删掉 `ResizeObserver` 兜底（`--left-w` 停在旧值 ⇒ 现象④ 右栏越窗）
 *   8  观察器改回 `useEffect + []`（启动门内 ref 为 null ⇒ **永远装不上**，第一版真踩过）
 *   9  RO 观察错对象（盯 wrapper 而不是左栏 ⇒ 收不到宽度变化的通知）
 *
 * ⚠️ **锚点用 `sub()`（行尾无关）** —— 本仓行尾是混的，裸 `\n` 多行锚点会静默失效。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险（_mut-eol 提供）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1156-right-content-fill.mjs             # 全量
 *   node gui/scripts/mut-a1156-right-content-fill.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1156-right-content-fill.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1156-right-content-fill.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1156-right-content-fill.spec.ts"];

const F_APP = "gui/src/renderer/App.tsx";
const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_APP, F_CSS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1156");

/** CSS 里那条规则的**唯一**形态（值在 MUTATIONS 里各改一处） */
const CSS_DECL = "  max-width: min(1600px, 100%);";
const CSS_SEL = "body.float-layout .right-sidebar:not(:has(webview)) .right-body {";

const MUTATIONS = [
  /* ── ① 稳态：内容列封顶回来了 ───────────────────────────────────── */
  {
    name: "1 CSS 内容列上限退回 min(620px, 62%)（缺陷原样复现：fillRatio 0.568）",
    file: F_CSS,
    mutate: (t) => sub(t, CSS_DECL, "  max-width: min(620px, 62%);"),
  },
  {
    name: "2 CSS 上限退回 620px（形态对、数值错 ⇒ 常规窗口上仍只剩一小段）",
    file: F_CSS,
    mutate: (t) => sub(t, CSS_DECL, "  max-width: min(620px, 100%);"),
  },
  {
    name: "3 CSS 上限与 JS 常量脱钩（2600px ⇒ 过渡 pin 与稳态不同式）",
    file: F_CSS,
    mutate: (t) => sub(t, CSS_DECL, "  max-width: min(2600px, 100%);"),
  },

  /* ── ② 过渡：pin 与稳态不同源 ──────────────────────────────────── */
  {
    name: "4 JS pin 退回 min(620, targetW × 0.62)（与稳态不同式 ⇒ 过渡结束内容宽度突跳）",
    file: F_APP,
    mutate: (t) => sub(t, "Math.min(RIGHT_CONTENT_MAX_W, targetW)", "Math.min(620, targetW * 0.62)"),
  },
  {
    /* ⚠️ 这一条是 A-1155 刚清掉的错、这轮又差点写回去：
       `handleToggleFloat` 是「先调 animateRightSidebar、后 setFloatState("float")」，
       调用那一刻 `floatStateRef.current` 还是 "none" ⇒ `rightSidebarMaxW()` 返回的是
       **非浮层**上限（实测把 1092 夹回 712）⇒ 派生猜测代替真状态（铁律 11）。 */
    name: "5 JS 浮层支重新夹 rightSidebarMaxW()（拿到非浮层上限 ⇒ pin 目标宽被砍）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "        const targetW = isFloatExpand\n          ? (nextWidth ?? rightWidth)",
      "        const targetW = isFloatExpand\n          ? Math.min(nextWidth ?? rightWidth, rightSidebarMaxW())",
    ),
  },

  /* ── ③ 前提：浏览器页豁免没了 ──────────────────────────────────── */
  {
    name: "6 去掉 :not(:has(webview))（浏览器页被限宽 ⇒ 网页缩成中间一列）",
    file: F_CSS,
    mutate: (t) => sub(t, CSS_SEL, "body.float-layout .right-sidebar .right-body {"),
  },

  /* ── ④ `--left-w` 失去自愈（用户现象④：右栏被挤压到屏幕外）────── */
  {
    /* ⚠️ 真机轨迹：点「展开左栏」后前 507ms 左栏实测 1px、631ms 才跳到 240px；
       逐帧同步在 1px 上就收工 ⇒ `--left-w` 停在 1px ⇒ wrapper = calc(100% − 1px)
       ⇒ `rw.r = 1571 > vw = 1332`（越窗 239px）。RO 是唯一能在"宽度真的变了"那一刻
       把它纠回来的东西，删掉就等于把现象④放回去。 */
    name: "7 删掉 ResizeObserver 兜底（--left-w 停在旧值 ⇒ 右栏越窗 = 现象④）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    const ro = new ResizeObserver(sync);\n    ro.observe(el);\n    sync();\n    leftWidthObserverRef.current = ro;",
      "    sync();",
    ),
  },
  {
    /* ⚠️⚠️ 这一条是第一版**真实踩过**的坑，不是假想：观察器装在
       `useEffect(..., [])` 里，而 App 首帧可能还停在启动门内（`.sidebar` 未挂载）
       ⇒ `leftSidebarRef.current === null` ⇒ return ⇒ **观察器永远装不上**
       ⇒ 实测 `--left-w` 仍停在 1px、`rw.r=1571` 越窗照旧。
       改成「回调 ref」才真正装得上。 */
    name: "8 观察器改回 useEffect + 空依赖（启动门内 leftSidebarRef 为 null ⇒ 永远装不上）",
    file: F_APP,
    mutate: (t) => sub(t, "ref={attachLeftWidthObserver}", "ref={leftSidebarRef}"),
  },
  {
    name: "9 RO 观察错对象（盯 wrapper 而不是左栏 ⇒ 宽度变化收不到通知）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    leftSidebarRef.current = el;\n    leftWidthObserverRef.current?.disconnect();",
      "    rightWrapperRef.current = el;\n    leftWidthObserverRef.current?.disconnect();",
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
    if (next === text) {
      console.error(`锚点未命中：${m.name}`);
      rmSync(SAVE_DIR, { recursive: true, force: true });
      process.exit(1);
    }
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1156")) { process.exit(1); }
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
  console.error(`\n⚠️  还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);