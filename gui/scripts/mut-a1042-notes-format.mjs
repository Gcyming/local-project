#!/usr/bin/env node
/**
 * gui/scripts/mut-a1042-notes-format.mjs — A-1042 守卫的变异验证。
 *
 * 守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。这里把**发布说明源文件**逐条改坏
 * （退回本次事故的 HTML 写法 + 结构缺失 + 跨文件漏扫 + 空转假绿），要求守卫**必须变红**。
 *
 * 与 mut-a1037 的分工：那条变异改的是**解析器代码**（src/shared/releaseNotes.ts），
 * 这条改的是**数据**（docs/releases/v<版本>.md 正本，以及 gui/release-v<版本>/RELEASE_NOTES.md 副本）
 * —— 事故的两半各锁一半。
 *
 * ⚠️ 全程快照 + 还原：任何时刻中断，源文件内容都必须回到原样（末尾核对哈希）。
 *
 * 用法：node gui/scripts/mut-a1042-notes-format.mjs
 */
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/gui/release-notes.spec.ts";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (rel) => resolve(ROOT, rel);
/* ⚠️ 2026-10-07：这三个目标原先写成 `notes("v0.0.4")` / `copy("v0.0.4")` 这样的**函数调用**。
   `check-mut-anchors.mjs` 的 `constMap` 只能解析**常量声明**（`const X = "字面量"`），
   解析不出调用式 ⇒ 8 条全部落进「目标文件写法未识别」⇒ **这份脚本一条锚点都没被核验过**
   （输出里只是"未核验"，读起来像"这种写法本来没法核验"，实际是**没人核验**）。
   ⇒ 照 mut-a1023 ⑬ 的先例**抽成模块级常量**：字面量搬进 const，路径一字未改，
   既能被核验器解析，运行期行为与原来逐字一致。 */

/** 正本：受版本控制的发布说明（守卫就是读这里） */
const NOTES_V004 = "docs/releases/v0.0.4.md";
const NOTES_V002 = "docs/releases/v0.0.2.md";
/** 副本：打包目录里的同名说明（`.gitignore` 忽略，仅本机存在） */
const COPY_V004 = "gui/release-v0.0.4/RELEASE_NOTES.md";

/**
 * 逐条变异。三种形态：
 *   { name, file, from, to }        —— 单点文本替换（锚点未命中会被判失败）
 *   { name, file, re, to }          —— 正则替换（用于"整类标记一起消失"的场景）
 *   { name, file, renameTo }        —— 文件改名（用于验证"扫不到文件"不会被当成通过）
 *
 * ⚠️ `file:` 一律写**模块级常量名**（不是路径字面量、也不是调用式）——
 *   这样核验器才能解析出目标，本份 8 条才真的进入核验（判据：没人核验 = 没有保护）。
 */
const MUTATIONS = [
  {
    name: "M1 标题退回 HTML（v0.0.4 事故原样：<h2> 进正文）",
    file: NOTES_V004,
    from: "## 本版重点修复",
    to: "<h2>本版重点修复</h2>",
  },
  {
    name: "M2 表格退回 HTML（<table>/<tr>/<td> 一整套）",
    file: NOTES_V004,
    from: "| 文件 | 修复前 | 修复后 |",
    to: "<table><tr><td>文件</td><td>修复前</td><td>修复后</td></tr>",
  },
  {
    name: "M3 全篇标题记号被抹掉（整篇退化成段落）",
    file: NOTES_V004,
    /* ⚠️ 本条是**正则整篇替换**（`re` 带 `g` 标志，运行期不读 `from`）。
       下面的 `from` + `all: true` 是**给核验器看的声明**，不参与运行期变异：
       它声明"我要改的就是文件里所有 `## ` 记号"，故 `all: true`（整组替换，命中 ≥1 即合格）。
       ⚠️ 不写它 ⇒ 本条落进「未核验」，而它其实**完全可证**（`re` 的匹配对象就在文件里）。
       ⚠️ `all: true` 不是"放宽判据"来糊弄 —— 命中 0 仍然报未命中。 */
    from: "## ",
    all: true,
    re: /^#{2,3} /gm,
    to: "",
  },
  {
    name: "M4 表头被改坏（列名不再对应）",
    file: NOTES_V004,
    from: "| 文件 | 修复前 | 修复后 |",
    to: "| 文件 | 修复后 | 修复后 |",
  },
  {
    name: "M5 首格反引号被去掉（code 片段丢失，只剩纯文本）",
    file: NOTES_V004,
    from: "| `12561-1.xls` |",
    to: "| 12561-1.xls |",
  },
  {
    name: "M6 只污染 v0.0.2（验证守卫扫的是全部 release，不是只盯 0.0.4）",
    file: NOTES_V002,
    from: "## 体积分层：安装包瘦身 43%",
    to: "<h3>体积分层：安装包瘦身 43%</h3>",
  },
  {
    name: "M7 说明文件被改名（扫不到文件 = 守卫空转，必须被数量守恒抓住）",
    file: NOTES_V002,
    renameTo: "RELEASE_NOTES.md.bak",
    unverifiable: "文件改名型（renameTo）—— 没有文本锚点可供静态核验（保护由真跑提供）",
  },
  {
    name: "M8 只改打包目录里的副本（正本没动 → 必须被防漂移断言抓住）",
    file: COPY_V004,
    from: "## 本版重点修复",
    to: "## 本版重点修复（偷偷改副本）",
  },
];

function runGuard() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", GUARD, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 快照正本 + 打包目录副本（内容 + 位置），供逐条变异后还原 */
function snapshot() {
  const out = new Map();
  for (const [dir, name] of [[abs("docs/releases"), null], [abs("gui"), "release"]]) {
    if (!existsSync(dir)) { continue; }
    for (const entry of readdirSync(dir)) {
      let p = null;
      if (name === null) {
        if (entry.endsWith(".md")) { p = join(dir, entry); }
      } else if (entry.startsWith(name)) {
        const cand = join(dir, entry, "RELEASE_NOTES.md");
        if (existsSync(cand)) { p = cand; }
      }
      if (p && existsSync(p)) { out.set(p, readFileSync(p, "utf8")); }
    }
  }
  return out;
}

function restore(snap) {
  // 先把被改名的挪回来（否则内容还原不到原路径）
  for (const p of snap.keys()) {
    if (existsSync(`${p}.bak`)) { renameSync(`${p}.bak`, p); }
  }
  for (const [p, text] of snap) { writeFileSync(p, text); }
}

/* ── 骨架：--list / --apply N / --restore ──────────────────────────────────
 * 与 mut-a1091 / mut-a1037 同款约定（全仓一致）。
 * ⚠️ --restore **无参可用**，且**变异态下也能跑**（manifest 与备份都在 SAVE_DIR）。
 * ⚠️ M7 是**改名**变异：改名后原路径已不存在，`--restore` 必须知道改成了什么名字 ——
 *   manifest 里记下确切的新文件名，还原时**只动这一个**。
 *   ⚠️ 早先写成"扫目录、把所有 `.bak` 尾的文件挪回去"，那会在目录里**本来就有的**
 *   `.bak`/`.md.bak` 上误操作（实测还原后凭空多出一个 `v0.0.2.md.RELEASE_NOTES.md`）。
 */
const SAVE_DIR = resolve(ROOT, "gui", "scripts", "_tmp-mut-a1042");
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
  const manifestPath = resolve(SAVE_DIR, "manifest.json");

  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    const p = abs(m.file);
    if (!existsSync(p)) { console.error(`目标不存在：${m.file}`); process.exit(1); }
    const src = readFileSync(p);
    mkdirSync(SAVE_DIR, { recursive: true });
    writeFileSync(resolve(SAVE_DIR, "orig.txt"), src);

    if (m.renameTo) {
      renameSync(p, `${p}.${m.renameTo}`);
    } else {
      const text = src.toString("utf8");
      let next;
      if (m.re) {
        next = text.replace(m.re, m.to);
      } else {
        if (!text.includes(m.from)) {
          console.error(`锚点未命中：${m.name}`);
          rmSync(SAVE_DIR, { recursive: true, force: true });
          process.exit(1);
        }
        next = text.replace(m.from, m.to);
      }
      if (next === text) {
        console.error(`变异无效果（改了等于没改）：${m.name}`);
        rmSync(SAVE_DIR, { recursive: true, force: true });
        process.exit(1);
      }
      writeFileSync(p, next);
    }

    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      /* 改名型记下确切的新文件名；还原只动它一个（不扫目录 —— 会误伤既有 .bak 文件） */
      renamedTo: m.renameTo ? `${m.file}.${m.renameTo}` : null,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }

  /* ── restore：无参可用；manifest 不在就是"没变异过"，直接报无事可做 ── */
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const p = abs(man.file);
  if (man.renamedTo && existsSync(abs(man.renamedTo))) {
    renameSync(abs(man.renamedTo), p);      // 改名型：先挪回原路径
  }
  writeFileSync(p, readFileSync(resolve(SAVE_DIR, "orig.txt")));
  const now = createHash("sha256").update(readFileSync(p)).digest("hex");
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

function main() {
  const snap = snapshot();
  const canon = [...snap.keys()].filter((p) => p.includes(`${join("docs", "releases")}`));
  if (canon.length < 3) {
    console.error(`[mut-a1042] 正本只找到 ${canon.length} 个（应 >= 3），先跑守卫确认环境`);
    process.exit(1);
  }
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");

  const base = runGuard();
  if (!base.ok) {
    console.error("[mut-a1042] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info(`[mut-a1042] 基线守卫通过（正本 ${canon.length} 个 · 快照文件 ${snap.size} 个）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const original = snap.get(path);
    if (original === undefined) {
      console.error(`[mut-a1042] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }

    if (m.renameTo) {
      renameSync(path, `${path}.bak`);
    } else {
      const next = m.re
        ? original.replace(m.re, m.to)
        : (original.includes(m.from) ? original.replace(m.from, m.to) : null);
      if (next === null) {
        console.error(`[mut-a1042] ${m.name}\n  ✗ 锚点未命中`);
        survivors.push(m.name);
        continue;
      }
      if (next === original) {
        console.error(`[mut-a1042] ${m.name}\n  ✗ 变异无效果（改了等于没改）`);
        survivors.push(m.name);
        continue;
      }
      writeFileSync(path, next);
    }

    const r = runGuard();
    if (r.ok) {
      console.error(`[mut-a1042] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1042] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }

  restore(snap);
  const after = snapshot();
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before
    && after.size === snap.size;

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1042] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1042] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "说明文件哈希已还原 ✓" : "说明文件还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
