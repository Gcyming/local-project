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
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/gui/release-notes.spec.ts";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (rel) => resolve(ROOT, rel);
/** 正本：受版本控制的发布说明（守卫就是读这里） */
const notes = (ver) => `docs/releases/${ver}.md`;
/** 副本：打包目录里的同名说明（`.gitignore` 忽略，仅本机存在） */
const copy = (ver) => `gui/release-${ver}/RELEASE_NOTES.md`;

/**
 * 逐条变异。三种形态：
 *   { name, file, from, to }        —— 单点文本替换（锚点未命中会被判失败）
 *   { name, file, re, to }          —— 正则替换（用于"整类标记一起消失"的场景）
 *   { name, file, renameTo }        —— 文件改名（用于验证"扫不到文件"不会被当成通过）
 */
const MUTATIONS = [
  {
    name: "M1 标题退回 HTML（v0.0.4 事故原样：<h2> 进正文）",
    file: notes("v0.0.4"),
    from: "## 本版重点修复",
    to: "<h2>本版重点修复</h2>",
  },
  {
    name: "M2 表格退回 HTML（<table>/<tr>/<td> 一整套）",
    file: notes("v0.0.4"),
    from: "| 文件 | 修复前 | 修复后 |",
    to: "<table><tr><td>文件</td><td>修复前</td><td>修复后</td></tr>",
  },
  {
    name: "M3 全篇标题记号被抹掉（整篇退化成段落）",
    file: notes("v0.0.4"),
    re: /^#{2,3} /gm,
    to: "",
  },
  {
    name: "M4 表头被改坏（列名不再对应）",
    file: notes("v0.0.4"),
    from: "| 文件 | 修复前 | 修复后 |",
    to: "| 文件 | 修复后 | 修复后 |",
  },
  {
    name: "M5 首格反引号被去掉（code 片段丢失，只剩纯文本）",
    file: notes("v0.0.4"),
    from: "| `12561-1.xls` |",
    to: "| 12561-1.xls |",
  },
  {
    name: "M6 只污染 v0.0.2（验证守卫扫的是全部 release，不是只盯 0.0.4）",
    file: notes("v0.0.2"),
    from: "## 体积分层：安装包瘦身 43%",
    to: "<h3>体积分层：安装包瘦身 43%</h3>",
  },
  {
    name: "M7 说明文件被改名（扫不到文件 = 守卫空转，必须被数量守恒抓住）",
    file: notes("v0.0.2"),
    renameTo: "RELEASE_NOTES.md.bak",
  },
  {
    name: "M8 只改打包目录里的副本（正本没动 → 必须被防漂移断言抓住）",
    file: copy("v0.0.4"),
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
