#!/usr/bin/env node
/**
 * gui/scripts/mut-a1143-search-fuzzy.mjs — A-1143（**近似项检索**）的变异验证。
 *
 * ## 这一组要护什么
 * 用户原话：「只能定向搜索符合所有文本的内容……太死板了，用户会记错一两个内容（cloud→clude、
 * flare→fare）⇒ 引进近似项检索」。本组守两条线：
 *   · **兜底真的生效**：记错的词能搜到、太短的词不瞎扩、候选有封顶、分数按距离衰减；
 *   · **兜底不许污染**：精确命中的查询结果**逐字不变**（这是"默认开着却不动老结果"的承诺）。
 *
 * ## 逐条
 *  1  `editDistance` 去掉换位（`teh`/`the` 从 1 变 2 ⇒ 打反字母就搜不到了）
 *  2  `editDistance` 去掉上界早停（返回真实距离 ⇒ 词典扫描的剪枝失效）
 *  3  **精确优先的闸门**被拆（精确词也走近似 ⇒ 搜得准的词反而搜不到）
 *  4  去掉 `fuzzyMinTermLen` 门槛（中文 bigram / 2 字母词开始瞎扩展）
 *  5  去掉候选封顶（词典一大，扩展词爆炸）
 *  6  `src` 不映射回用户词（AND 优先按词典词计数 ⇒ 覆盖最全的页反而掉下去）
 *  7  AND 判据改回数**词典词**（同上，两种实现的分歧点）
 *  8/9 权重不生效（近似命中与精确命中**同分** ⇒ "越像的越前"失效）
 * 10  `terms` 被替换成词典词（页面高亮用户根本没打过的词）
 * 11  夹取上限被放宽到 5（突破 Lucene 的硬约束）
 * 12  `fuzzyMaxExpansions` 下界被放到 0（功能被悄悄关掉）
 * 13  `/search` 回包不带 `expansions`（"这是近似结果"看不见）
 * 14  面板输入框绑错字段（参数可调承诺半途而废）
 *
 * ⚠️ 本组只跑 `tests/gui/a1143-search-fuzzy.spec.ts`（纯函数 + 源码形状）。
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 `_run-mut-batch.sh` 逐条跑。
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（剥 ANSI 之后）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号 —— 一律「」（本仓已重复踩这个坑）。
 * ⚠️ 本文件必须是 **LF**（`check-mut-anchors.mjs` 按字节切锚点）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1143-search-fuzzy.spec.ts"];

const F_ENGINE = "core-ts/src/websearch/engine.ts";
const F_SVC = "gui/src/main/searchIndexService.ts";
const F_PANEL = "gui/src/renderer/pages/SearchIndexPanel.tsx";

const TARGETS = [F_ENGINE, F_SVC, F_PANEL];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1143");

const MUTATIONS = [
  /* ───── ① 编辑距离本身 ───── */
  {
    name: "1 engine：`editDistance` 去掉换位（`teh`/`the` 从 1 变 2 ⇒ 打反字母搜不到）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      if (prev2 && i > 1 && j > 1", "      if (false && i > 1 && j > 1"),
  },
  {
    name: "2 engine：`editDistance` 丢掉「上界」语义（返回真实距离 ⇒ 词典扫描的剪枝失效）",
    file: F_ENGINE,
    /* ⚠️ 这里必须**同时**改两处：行级早停（为性能）+ 末行夹取（为语义）互为兜底 ——
       单改任一处，另一处照样把返回值夹到 `max + 1` ⇒ 实测两条都「存活」过（铁律 9 的等价变异体）。
       两处一起关，才真的把"超过就返回 max+1"这条契约拆掉。 */
    mutate: (t) => {
      const a = sub(t, "    if (rowMin > max) { return max + 1; }", "    if (false) { return max + 1; }");
      return sub(a, "  return prev[n] > max ? max + 1 : prev[n];", "  return prev[n];");
    },
  },

  /* ───── ② 展开策略：精确优先 / 门槛 / 封顶 ───── */
  {
    name: "3 engine：**精确优先的闸门**被拆（精确词也走近似 ⇒ 本来搜得准的词反而搜不到）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (index.df[t] !== undefined) { push(t, t, 1); continue; }",
      "    if (false) { push(t, t, 1); continue; }"),
  },
  {
    name: "4 engine：去掉 `fuzzyMinTermLen` 门槛（中文 bigram / 2 字母词开始瞎扩展）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    if (maxEdits <= 0 || t.length < minLen) { continue; }",
      "    if (maxEdits <= 0) { continue; }"),
  },
  {
    name: "5 engine：去掉候选封顶（词典一大，扩展词就爆炸）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    for (const c of cands.slice(0, maxExp)) {", "    for (const c of cands) {"),
  },
  {
    name: "6 engine：`src` 不映射回用户词（AND 优先改按**词典词**计数）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    src.set(term, from);", "    src.set(term, term);"),
  },
  {
    name: "7 engine：AND 判据改回数**词典词**（覆盖最全的页反而掉到后面）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "  const full = eligible.filter(([doc]) => srcHitCount(doc) === terms.length);",
      "  const full = eligible.filter(([doc]) => (hitTerms.get(doc)?.size ?? 0) === terms.length);"),
  },

  /* ───── ③ 权重：近似必须降权 ───── */
  {
    name: "8 engine：近似扩展被整体短路（功能形同关闭，而面板上显示的还是「已开启」）",
    file: F_ENGINE,
    /* ⚠️ 原写的是「粗排不乘近似权重」—— 实测**存活**，而且那不是守卫漏了：
       粗排的分数会被精排**整段覆盖**（`scores.set(doc, s)`）⇒ 乘不乘都一样，
       属等价变异体（铁律 9）。那句权重乘法已从实现里删掉。 */
    mutate: (t) => sub(t, "    if (maxEdits <= 0 || t.length < minLen) { continue; }", "    if (true) { continue; }"),
  },
  {
    name: "9 engine：近似权重在**精排**不生效（最终分数不再体现「越像越前」）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "      s += (idfOf(index, df) * (effTf * (o.k1 + 1))) / denom * (plan.weight.get(t) ?? 1);",
      "      s += (idfOf(index, df) * (effTf * (o.k1 + 1))) / denom;"),
  },
  {
    name: "10 engine：返回值里的 `terms` 被替换成**词典词**（页面高亮用户没打过的词）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    return { total: ordered.length, items, terms, expansions: plan.expansions };",
      "    return { total: ordered.length, items, terms: plan.effective, expansions: plan.expansions };"),
  },

  /* ───── ④ 夹取（Lucene 的硬约束）───── */
  {
    name: "11 engine：夹取上限被放宽到 5（突破 Lucene 的 `maxEdits <= 2` 硬约束）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    fuzzyMaxEdits: Math.floor(num(o.fuzzyMaxEdits, DEFAULT_INDEX_OPTIONS.fuzzyMaxEdits, 0, 2)),",
      "    fuzzyMaxEdits: Math.floor(num(o.fuzzyMaxEdits, DEFAULT_INDEX_OPTIONS.fuzzyMaxEdits, 0, 5)),"),
  },
  {
    name: "12 engine：`fuzzyMaxExpansions` 下界被放到 0（功能被悄悄关掉，而界面上看不出）",
    file: F_ENGINE,
    mutate: (t) => sub(t, "    fuzzyMaxExpansions: Math.floor(num(o.fuzzyMaxExpansions, DEFAULT_INDEX_OPTIONS.fuzzyMaxExpansions, 1, 200)),",
      "    fuzzyMaxExpansions: Math.floor(num(o.fuzzyMaxExpansions, DEFAULT_INDEX_OPTIONS.fuzzyMaxExpansions, 0, 200)),"),
  },

  /* ───── ⑤ 接线 ───── */
  {
    name: "13 service：`/search` 回包不带 `expansions`（「这是近似结果」看不见 ⇒ 用户以为索引里有那个词）",
    file: F_SVC,
    mutate: (t) => sub(t, "      expansions: r.expansions,", "      expansions: [],"),
  },
  {
    name: "14 panel：输入框绑错字段（参数可调承诺半途而废）",
    file: F_PANEL,
    mutate: (t) => sub(t, "value={form.fuzzyMinTermLen}", "value={form.minTermLen}"),
  },
];

/* ---------------- 以下与 mut-a1141-search-gateway.mjs 同构（同一套校准逻辑） ---------------- */
const arg = process.argv;
const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const p = spawnSync(process.execPath, [
    join(ROOT, "node_modules/.pnpm/vitest@2.1.0_@types+node@24.13.3_supports-color@7.1.0/node_modules/vitest/vitest.mjs"),
    "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot",
  ], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = (p.stdout || "") + (p.stderr || "");
  const spawnBlocked = /EBUSY|EINVAL.*spawn/i.test(out) && /node_modules/.test(out);
  const hasSummary = /Tests\s+\d+\s+(failed|passed)/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
  return { ok: p.status === 0, out, spawnBlocked, measurementFailed: !hasSummary };
}

const mode = arg.includes("--list") ? "list"
  : arg.includes("--restore") ? "restore"
    : arg.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(arg[arg.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) { console.error("上一轮变异还没还原 —— 先 --restore。"); process.exit(1); }
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
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* ⚠️ 签名是 `installRestoreOnSignal(targets, root)`（传**路径数组**，不是回调）——
   传回调时它内部 `targets.map` 直接抛，而本环境全量模式本来就跑不到那一行 ⇒ 缺陷会一直潜伏。 */
installRestoreOnSignal(TARGETS, ROOT);

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1143")) { process.exit(1); }
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
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { for (const t of TARGETS) { writeFileSync(abs(t), originals.get(t)); } }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
