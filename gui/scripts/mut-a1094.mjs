#!/usr/bin/env node
/**
 * gui/scripts/mut-a1094.mjs — A-1094 守卫的变异验证。
 *
 * 本轮根除的是「流式期正文里表格 markdown 语法裸露」——用户截图 image#5：
 * `|---|------|`、`| 1 | cd /d "D:..." |` 全部原文直出。它有两个独立产地：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | 渲染 | Pre 修复（半成品分隔行）被摘掉 | `|---` 变孤立 `<hr>`，表头行裸露 `|` |
 * | 渲染 | Pre 修复改「追加」而非「替换」 | `|---` 被净化链拆成 `|`+空行+`---`，表格劈成三段 |
 * | 渲染 | After 修复（表头无分隔行）被摘掉 | 表头行退化成段落 → `|` 裸露 |
 * | 渲染 | After 末尾换行不剥 → 永远判不出表格 | 同上（修复形同虚设） |
 * | 渲染 | After 的「上一行是分隔行」守卫被删 | 数据行被当新表头 → 每行都补分隔行 |
 * | 尾巴 | `fadeUnitText` 不再抹 `|` | 吐字期可见裸 `|` |
 * | 尾巴 | `TABLE_SEP_MARKER` 不存在 → `|---|---|` 整块显示 | 吐字期看到一排 `-----` |
 * | 尾巴 | `visibleTailUnits` 不做跨单元收尾 | `| 序号 |` 拼出前导/双空格 |
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1094.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1094.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1094.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1094.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1094-stream-table.spec.ts", "tests/gui/a1065-fade-text.spec.ts"];

const F_MD = "gui/src/renderer/pages/Markdown.tsx";
const F_FADE = "gui/src/renderer/pages/streamFade.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_MD, F_FADE, F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1094");

const MUTATIONS = [
  /* ── ① Pre 修复（半成品分隔行）─────────────────────────────────── */
  {
    name: "1 repairStreamingTablePre 被摘掉（`|---` 变孤立 hr，表头行裸露 `|`）",
    file: F_MD,
    mutate: (t) => sub(
      t,
      "  // 3) 表格半成品（打字中的分隔行）补全 —— 必须在净化链**之前**（见 repairStreamingTablePre）\n  text = repairStreamingTablePre(text);\n\n  return text;",
      "  return text;",
    ),
  },
  {
    name: "2 Pre 修复改「追加」而非「替换」（`|---` 被净化链拆散 → 表格劈成三段）",
    file: F_MD,
    mutate: (t) => sub(
      t,
      "  const head = nl >= 0 ? body.slice(0, nl + 1) : \"\";\n  return head + sep + trail;",
      "  return body + \"\\n\" + sep + trail;",
    ),
  },

  /* ── ② After 修复（表头无分隔行）───────────────────────────────── */
  {
    name: "3 repairStreamingTableAfter 被摘掉（表头行退化成段落 → `|` 裸露）",
    file: F_MD,
    mutate: (t) => sub(
      t,
      "  if (streaming) { src = repairStreamingTableAfter(src); }",
      "",
    ),
  },
  {
    name: "4 After 不剥末尾换行（流式正文常以 \\n 收尾 → 永远判不出表格，修复形同虚设）",
    file: F_MD,
    mutate: (t) => sub(
      t,
      "  const m = /(\\n+)$/.exec(body);\n  if (m) { trail = m[1]; body = body.slice(0, body.length - trail.length); }\n  const nl = body.lastIndexOf(\"\\n\");\n  const last = body.slice(nl + 1);\n  const prevText = nl >= 0 ? body.slice(0, nl) : \"\";",
      "  const nl = body.lastIndexOf(\"\\n\");\n  const last = body.slice(nl + 1);\n  const prevText = nl >= 0 ? body.slice(0, nl) : \"\";",
    ),
  },
  {
    name: "5 After 的「上一行是分隔行」守卫被删（数据行被当新表头 → 每行都补分隔行）",
    file: F_MD,
    mutate: (t) => sub(
      t,
      "  if (prevLine && looksLikeTableSep(prevLine)) { return text; }",
      "",
    ),
  },
  {
    name: "6 After 的列数下限被删（cols 可能为 0 → 补出 `||` 空分隔行）",
    file: F_MD,
    mutate: (t) => sub(
      t,
      "  const cols = Math.max(1, head.split(\"|\").filter((s) => s.trim() !== \"\").length);\n  const sep = `|${Array.from({ length: cols }, () => \"---\").join(\"|\")}|`;\n  return body + \"\\n\" + sep + trail;",
      "  const cols = head.split(\"|\").filter((s) => s.trim() !== \"\").length;\n  const sep = `|${Array.from({ length: cols }, () => \"---\").join(\"|\")}|`;\n  return body + \"\\n\" + sep + trail;",
    ),
  },

  /* ── ③ 尾巴净化 ────────────────────────────────────────────────── */
  {
    name: "7 fadeUnitText 不再抹 `|`（吐字期可见裸 `|`）",
    file: F_FADE,
    mutate: (t) => sub(
      t,
      "    .replace(/[*#|`]/g, \"\")",
      "    .replace(/[*#`]/g, \"\")",
    ),
  },
  {
    name: "8 TABLE_SEP_MARKER 判据被摘掉（`|---|---|` 整块显示成一排 `-----`）",
    file: F_FADE,
    mutate: (t) => sub(
      t,
      "  if (TABLE_SEP_MARKER.test(raw) && /-/.test(raw)) { return \"\"; }",
      "",
    ),
  },
  {
    name: "9 PURE_MARKER / TABLE_SEP_MARKER 早退被删（`**` `#` `|---|---|` 整块不再隐藏）",
    file: F_FADE,
    mutate: (t) => sub(
      t,
      "  if (PURE_MARKER.test(raw)) { return \"\"; }\n  if (ORDERED_MARKER.test(raw)) { return \"\"; }\n  // 表格分隔单元（如 `---`、`|---|---|`）——`PURE_MARKER` 已挡纯 `-`，这里挡带 `:`/`|` 的变体\n  if (TABLE_SEP_MARKER.test(raw) && /-/.test(raw)) { return \"\"; }",
      "",
    ),
  },
  {
    name: "10 visibleTailUnits 不做跨单元收尾（`| 序号 |` 拼出前导/双空格）",
    file: F_FADE,
    mutate: (t) => sub(
      t,
      "  const visible = joined.replace(/[ \\t]{2,}/g, \" \").replace(/^[ \\t]+/, \"\").replace(/[ \\t]+$/, \"\");",
      "  const visible = joined;",
    ),
  },
  {
    name: "11 visibleTailText 的跨单元收尾被摘掉（同 10，另一产地）",
    file: F_FADE,
    mutate: (t) => sub(
      t,
      "    .join(\"\")\n    .replace(/[ \\t]{2,}/g, \" \")\n    .replace(/^[ \\t]+/, \"\")\n    .replace(/[ \\t]+$/, \"\");",
      "    .join(\"\");",
    ),
  },

  /* ── ④ 接线（净化结果真的被用起来）─────────────────────────────── */
  {
    name: "12 ChatPanel 不用 visibleTailUnits（渲染原始单元 → 净化形同虚设）",
    file: F_PANEL,
    /* A-1095 S6 迁移：渲染块重写成「先 `visibleTailUnits(...).filter(...)` 取 units，
       再 `units.map`」。判据（绕过 `visibleTailUnits` ⇒ 净化形同虚设）不变，
       锚点更新到新形态。 */
    mutate: (t) => sub(
      t,
      "  const units = visibleTailUnits(fade.units).filter((u) => u.text);",
      "  const units = fade.units.filter((u) => u.text);",
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1094")) { process.exit(1); }
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
