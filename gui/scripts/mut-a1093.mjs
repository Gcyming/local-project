#!/usr/bin/env node
/**
 * gui/scripts/mut-a1093.mjs — A-1093 守卫的变异验证。
 *
 * 本轮根除的是「文件改动卡片时有时无 +/- 徽标」——用户要求**写死**、**根除**。
 * 它有两个独立产地，各自都能单独让功能静默失效：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | 判据 | `hasVisibleDiff` 用 `&&`（要同时有增有删） | 新建/纯追加/纯删除**全都不显示** |
 * | 正则 | 标记两侧用 `+`（不允许空 base64） | 新建文件**匹配不上** → 徽标照样没有 |
 * | 构造 | `buildDiffMarker` 无改动也产出标记 | 内容没变却报"有改动" |
 * | 同源 | 渲染层副本漂离 core | 展开的 diff 块与徽标口径打架 |
 * | 同源 | 截断占位两处字面量漂移 | 「详情未保存」提示看不出来 |
 *
 * ## 覆盖的十条
 *
 *   1     `hasVisibleDiff` 退回 `&&`（只解决"算得出"，回到"不显示"）
 *   2     `hasVisibleDiff` 丢掉 null 兜底（undefined 直接抛 → 整卡炸）
 *   3     core 侧 `DIFF_MARKER_RE` 退回 `+`（新建文件匹配不上）
 *   4     渲染层 `parseDiffStat` 副本退回 `+`（与 core 漂离）
 *   5     渲染层 `parseDiffFull` 副本退回 `+`（展开的红绿块消失）
 *   6     `buildDiffMarker` 不再对"未改动"短路（内容没变也报改动）
 *   7     `parseDiffStatCore` 不再收口"无改动 → null"（调用方得各判一次）
 *   8     `builtin.ts` 不再用唯一构造器（回退内联模板串）
 *   9     `tool_loop.ts` 重新自己写一份正则（不再从 diff_marker 导出）
 *   10    留痕剥离正则（thinkingText）退回 `+`（新建文件标记漏剥 → base64 漏进界面）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1093.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1093.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1093.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1093.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1093-diff-marker.spec.ts"];

const F_MARKER = "core-ts/src/diff_marker.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_LOOP = "core-ts/src/tool_loop.ts";
const F_PRODUCTS = "gui/src/renderer/pages/chatProducts.ts";
const F_THINK = "gui/src/renderer/pages/thinkingText.ts";
const TARGETS = [F_MARKER, F_BUILTIN, F_LOOP, F_PRODUCTS, F_THINK];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1093");

/* ── ③④⑤⑩ 的锚点常量（2026-10-08 补：把「`from` 藏在 `mutate:` 闭包里」改成可静态核验）──
 *
 * 这四条原先把锚点写成 `` sub(t, `…${RE_STAR}…`, `…${RE_PLUS}…`) `` —— **模板字面量 + 插值**。
 * `check-mut-anchors.mjs` 的 `constMap` 对含 `${…}` 的锚点**故意拒登记**
 * （插值求不出静态值，硬放过去会拿一个"看着像"的串去数命中数 ⇒ 假绿），
 * 于是这四条**一条都没被数过** ⇒ 报「未核验」。按铁律「没人核验 = 没有保护」，
 * 那四条守卫的保护强度是 0，且比「未命中」更隐蔽（未命中至少会响）。
 *
 * ⇒ 改成把两种形态（`*` / `+`）各自写成**模块级单个双引号字面量**，条目补显式的 from 与 to 字段：核验器的 `constMap` 与运行期（`_run-mut-one.mjs` 的常量表）
 *   读的是**同一份常量**，不会出现「核验器说命中、运行期说未命中」的两边打架。
 *
 * ⚠️⚠️ 每条必须各自是**单个**字面量，**不许用 `+` 拼接**（实测）：
 *   拼接形态会让 `constMap` 落到「常量字面量解析失败」⇒ `from` 解析不出来 ⇒ 又变未核验。
 * ⚠️ 四条常量都是**逐字节抄自当前源码**的连续片段，且各自在目标文件里**唯一命中**
 *   （已实测：#3 命中 1、#5 命中 1、#10 命中 1；#4 原锚点命中 **2** —— 那是
 *   `parseDiffStat` 与 `parseDiffFull` 两个函数的公共前缀，已补足 `const oldLines`
 *   那一行收窄到唯一）。改源码形状时必须重新抄，否则这里报「未命中」—— 那正是它该报的。
 * ⚠️ 变异语义**完全没变**：仍是把正字符类里的 `*` 换成 `+`（`RE_STAR` → `RE_PLUS`）。
 *   `RE_STAR` / `RE_PLUS` 两个常量**已无人引用**，保留会让人误以为还有条目在用插值形态。 */
const A1093_MARKER_RE = "export const DIFF_MARKER_RE = /\\[__slime_diff__\\]([A-Za-z0-9+/=]*)\\|([A-Za-z0-9+/=]*)\\[\\/__slime_diff__\\]/;";
const A1093_MARKER_RE_PLUS = "export const DIFF_MARKER_RE = /\\[__slime_diff__\\]([A-Za-z0-9+/=]+)\\|([A-Za-z0-9+/=]+)\\[\\/__slime_diff__\\]/;";
const A1093_PARSE_STAT = "  const m = /\\[__slime_diff__\\]([A-Za-z0-9+/=]*)\\|([A-Za-z0-9+/=]*)\\[\\/__slime_diff__\\]/.exec(result);\n  if (!m) { return null; }\n  const oldTxt = b64ToText(m[1]);\n  const newTxt = b64ToText(m[2]);\n  if (!oldTxt && !newTxt) { return null; }\n  const oldLines = new Set(oldTxt.split(\"\\n\"));";
const A1093_PARSE_STAT_PLUS = "  const m = /\\[__slime_diff__\\]([A-Za-z0-9+/=]+)\\|([A-Za-z0-9+/=]+)\\[\\/__slime_diff__\\]/.exec(result);\n  if (!m) { return null; }\n  const oldTxt = b64ToText(m[1]);\n  const newTxt = b64ToText(m[2]);\n  if (!oldTxt && !newTxt) { return null; }\n  const oldLines = new Set(oldTxt.split(\"\\n\"));";
const A1093_PARSE_FULL = "  const m = /\\[__slime_diff__\\]([A-Za-z0-9+/=]*)\\|([A-Za-z0-9+/=]*)\\[\\/__slime_diff__\\]/.exec(result);\n  if (!m) { return null; }\n  const oldTxt = b64ToText(m[1]);\n  const newTxt = b64ToText(m[2]);\n  if (!oldTxt && !newTxt) { return null; }\n  if (oldTxt.length + newTxt.length > maxChars) { return null; }";
const A1093_PARSE_FULL_PLUS = "  const m = /\\[__slime_diff__\\]([A-Za-z0-9+/=]+)\\|([A-Za-z0-9+/=]+)\\[\\/__slime_diff__\\]/.exec(result);\n  if (!m) { return null; }\n  const oldTxt = b64ToText(m[1]);\n  const newTxt = b64ToText(m[2]);\n  if (!oldTxt && !newTxt) { return null; }\n  if (oldTxt.length + newTxt.length > maxChars) { return null; }";
const A1093_TRACE_MARKER_RE = "const TRACE_MARKER_RE = /\\[__slime_diff__\\][A-Za-z0-9+/=]*\\|[A-Za-z0-9+/=]*\\[\\/__slime_diff__\\]|\\[__slime_diff_trimmed__\\]/;";
const A1093_TRACE_MARKER_RE_PLUS = "const TRACE_MARKER_RE = /\\[__slime_diff__\\][A-Za-z0-9+/=]+\\|[A-Za-z0-9+/=]+\\[\\/__slime_diff__\\]|\\[__slime_diff_trimmed__\\]/;";

const MUTATIONS = [
  /* ── ① 判据：`||` 退回 `&&`（本轮的核心）───────────────────────── */
  {
    name: "1 hasVisibleDiff 退回 `&&`（新建/纯追加/纯删除全都不显示 —— 用户报的那条缺陷）",
    file: F_MARKER,
    mutate: (t) => sub(
      t,
      "  return !!stat && (stat.add > 0 || stat.del > 0);",
      "  return !!stat && (stat.add > 0 && stat.del > 0);",
    ),
  },
  {
    name: "2 hasVisibleDiff 丢掉 null 兜底（undefined 直接抛 → 整张产物卡炸掉）",
    file: F_MARKER,
    mutate: (t) => sub(
      t,
      "  return !!stat && (stat.add > 0 || stat.del > 0);",
      "  return (stat as { add: number; del: number }).add > 0 || (stat as { add: number; del: number }).del > 0;",
    ),
  },

  /* ── ② 正则：`*` 退回 `+`（第二个产地 —— 判据修好了也没用）────── */
  {
    name: "3 core 侧 DIFF_MARKER_RE 退回 `+`（新建文件 base64 为空 ⇒ 标记匹配不上）",
    file: F_MARKER,
    /* ⚠️ 2026-10-08：锚点从「模板字面量 + `${RE_STAR}` 插值」改成**字面量常量**（见文件头）。
       语义不变：`RE_STAR` 形态 → `RE_PLUS` 形态（正字符类里 `*` → `+`）。 */
    from: A1093_MARKER_RE,
    to: A1093_MARKER_RE_PLUS,
    mutate: (t) => sub(t, A1093_MARKER_RE, A1093_MARKER_RE_PLUS),
  },
  {
    name: "4 渲染层 parseDiffStat 副本退回 `+`（与 core 漂离 ⇒ 徽标算不出）",
    file: F_PRODUCTS,
    /* ⚠️ 2026-10-08：锚点提成模块级字面量常量（见文件头）。
       ⚠️⚠️ 锚点比原写法**多带了一行** `const oldLines = new Set(oldTxt.split("\n"));`：
         只带公共前缀（`exec` + `if (!m)` + `oldTxt`/`newTxt` + `if (!oldTxt && !newTxt)`）时
         它在 `chatProducts.ts` 里**命中 2 次**（`parseDiffStat` 与 `parseDiffFull` 两个函数同开头）——
         而 `sub` 只改**第一处**，也就是改到了 `parseDiffStat`（本条的目标，方向对），
         但核验器会报「不唯一」⇒ 又是一条**没人核验**的守卫。补足那一行后**唯一命中**。 */
    from: A1093_PARSE_STAT,
    to: A1093_PARSE_STAT_PLUS,
    mutate: (t) => sub(t, A1093_PARSE_STAT, A1093_PARSE_STAT_PLUS),
  },
  {
    name: "5 渲染层 parseDiffFull 副本退回 `+`（展开的红绿 diff 块对新建文件消失）",
    file: F_PRODUCTS,
    /* ⚠️ 2026-10-08：锚点提成模块级字面量常量（见文件头）；补足 `maxChars` 那一行
       以与 `parseDiffStat` 区分（实测唯一命中）。语义不变：`*` → `+`。 */
    from: A1093_PARSE_FULL,
    to: A1093_PARSE_FULL_PLUS,
    mutate: (t) => sub(t, A1093_PARSE_FULL, A1093_PARSE_FULL_PLUS),
  },

  /* ── ③ 构造器：未改动短路被删 ─────────────────────────────────── */
  {
    name: "6 buildDiffMarker 不再对「未改动」短路（内容没变也报有改动）",
    file: F_MARKER,
    mutate: (t) => sub(
      t,
      '  if (oldText === newText) { return ""; }\n',
      "",
    ),
  },

  /* ── ④ 解析器收口 ─────────────────────────────────────────────── */
  {
    name: "7 parseDiffStatCore 不再收口「无改动 → null」（调用方各判一次 ⇒ 必有一处写反）",
    file: F_MARKER,
    mutate: (t) => sub(
      t,
      "  const stat = diffStatOf(oldTxt, newTxt);\n  return hasVisibleDiff(stat) ? stat : null;",
      "  const stat = diffStatOf(oldTxt, newTxt);\n  return stat;",
    ),
  },

  /* ── ⑤ 唯一产地被绕过 ────────────────────────────────────────── */
  {
    name: "8 builtin.ts 不再用唯一构造器（回退内联模板串 ⇒ 格式散成两处）",
    file: F_BUILTIN,
    mutate: (t) => sub(
      t,
      "    const diffTag = buildDiffMarker(oldContent, content);",
      "    const b64 = (s: string): string => Buffer.from(s, \"utf-8\").toString(\"base64\");\n    const diffTag = oldContent !== content ? `\\n[__slime_diff__]${b64(oldContent)}|${b64(content)}[/__slime_diff__]` : \"\";",
    ),
  },
  {
    name: "9 tool_loop.ts 重新自己写一份正则（不再从 diff_marker 导出 ⇒ 两处会漂）",
    file: F_LOOP,
    mutate: (t) => sub(
      t,
      'export { DIFF_MARKER_RE as DIFF_TAG_RE } from "./diff_marker.js";\nimport { DIFF_MARKER_RE as DIFF_TAG_RE } from "./diff_marker.js";',
      'export const DIFF_TAG_RE = /\\[__slime_diff__\\]([A-Za-z0-9+/=]+)\\|([A-Za-z0-9+/=]+)\\[\\/__slime_diff__\\]/;',
    ),
  },

  /* ── ⑥ 留痕剥离（同族兄弟）────────────────────────────────────── */
  {
    name: "10 留痕剥离正则退回 `+`（新建文件标记漏剥 ⇒ 整段 base64 漏进界面）",
    file: F_THINK,
    /* ⚠️ 2026-10-08：锚点提成模块级字面量常量（见文件头）。语义不变：`*` → `+`。 */
    from: A1093_TRACE_MARKER_RE,
    to: A1093_TRACE_MARKER_RE_PLUS,
    mutate: (t) => sub(t, A1093_TRACE_MARKER_RE, A1093_TRACE_MARKER_RE_PLUS),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1093")) { process.exit(1); }
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
