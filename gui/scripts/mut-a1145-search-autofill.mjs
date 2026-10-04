#!/usr/bin/env node
/**
 * gui/scripts/mut-a1145-search-autofill.mjs — A-1145（「本地命中不足 ⇒ 自动联网补量」）的变异验证。
 *
 * ## 用户原话
 * 「每次用户搜索后，调度相关功能全网检索、爬取相关、相似内容，按相关性排列，最符合要求的
 *  放在第一位，依次类推，直到检索完全网相关项。」
 *
 * ## ⚠️ 本组的目标文件是一个**独立页面**（`apps/local-search-engine/index.html`）
 * 它跑在右栏 webview 里、不是模块 ⇒ vitest 加载不到它的函数，所以守卫只能是**形状断言**。
 * 这里的 8 条变异，逐条对着那三条不变量：
 *   · 只在命中不足时补（阈值 / 冷却 / 联网能力三道闸门，缺一条都会变成"每次搜索都打全网"）；
 *   · 补量**绝不覆盖**本地结果；
 *   · 降级看得见（写明来源条数 / 如实说已收录 / 只提交真 http 地址）。
 *
 * ⚠️ **已知覆盖边界**：形状断言证明不了运行时行为（例如"冷却真的生效"）。要补这一层，
 *    得照 A-1137 的 `probe-search-host.mjs` 起一个真页面跑 —— 那是另一个量级的成本，本轮没做。
 *
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
const SPECS = ["tests/gui/a1145-search-autofill.spec.ts"];

const F_PAGE = "apps/local-search-engine/index.html";
const TARGETS = [F_PAGE];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1145");

const MUTATIONS = [
  /* ───── ① 判据的三道闸门 ───── */
  {
    name: "1 page：冷却改成 0（**每次搜索都发收录请求**，索引服务被自己的用户冲垮）",
    file: F_PAGE,
    mutate: (t) => sub(t, "  var CRAWL_COOLDOWN_MS = 30000;", "  var CRAWL_COOLDOWN_MS = 0;"),
  },
  {
    name: "2 page：去掉**索引在线**检查（索引没连也发 `/crawl` ⇒ 请求全打空，而界面上看不出）",
    file: F_PAGE,
    mutate: (t) => sub(t, "    if (!web.online) { return false; }", "    if (false) { return false; }"),
  },
  {
    name: "3 page：收录**又被挂回 `runWeb`**（探针实测：那里与「有联网能力」互斥 ⇒ 死分支）",
    file: F_PAGE,
    /* ⚠️ 这是本次修复那条**核心回归**的变异：把落点挪回不可达处，功能就悄悄没了。 */
    mutate: (t) => {
      const a = sub(t, "      autoCrawlOnline(r.items, state.query);\n", "");
      return sub(a, "      renderWebResults();\n", "      renderWebResults();\n      autoCrawlOnline(null, state.query);\n");
    },
  },
  {
    name: "4 page：调用点排在 `renderOnlineResults()` **之前**（收录挡在结果前面）",
    file: F_PAGE,
    /* ⚠️ 必须**先删后加**：只在前面插一次调用的话，原来那处还在 ⇒ 守卫的正则照样匹配（实测存活过）。 */
    mutate: (t) => {
      const a = sub(t, "      autoCrawlOnline(r.items, state.query);\n", "");
      return sub(a, "      renderOnlineResults();\n", "      autoCrawlOnline(r.items, state.query);\n      renderOnlineResults();\n");
    },
  },

  /* ───── ② 不许覆盖搜索结果 ───── */
  {
    name: "5 page：收录**覆盖**搜索结果（用户刚搜到的东西被一行提示顶掉）",
    file: F_PAGE,
    mutate: (t) => sub(t, "    hostNotify('autocrawl'",
      "    el.resultList.innerHTML = '<div class=\"svc-note\">提交收录中…</div>';\n    hostNotify('autocrawl'"),
  },

  /* ───── ③ 降级看得见 + 只提交真地址 ───── */
  {
    name: "6 page：不提示「已提交收录」（自我改善那一层用户看不见 ⇒ 等于没做）",
    file: F_PAGE,
    /* ⚠️ 变异体里**不许留下那几个字**：第一版把"已把 … 提交收录"那串留在了旁边的一行表达式里，
       于是"页面仍含『提交收录』"的断言照样绿（= 变异体自己喂绿了判据）。整段替换掉才干净。 */
    mutate: (t) => sub(t,
      "      box.innerHTML = '<div class=\"svc-note\">已把 ' + urls.length +\n        ' 个网页提交收录 —— 下次同一个问题本地索引就能直接命中。</div>';",
      "      box.innerHTML = '';"),
  },
  {
    name: "7 page：提交收录前不做 http 过滤（站内路径 / 空串被丢给爬虫）",
    file: F_PAGE,
    /* ⚠️ 缩进随落点变过（`autoFillOnline` 的 then 回调里是 8 空格，如今在 `autoCrawlOnline` 里是 6 空格）。 */
    mutate: (t) => sub(t, "      if (/^https?:\\/\\//i.test(u)) { urls.push(u); }", "      urls.push(u);"),
  },
  {
    name: "8 page：`/crawl` 路径漂（收录请求打在 404 上，而界面「看着还在」）",
    file: F_PAGE,
    mutate: (t) => sub(t, "      fetch(web.base + '/crawl', {", "      fetch(web.base + '/crawler', {"),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1145")) { process.exit(1); }
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
