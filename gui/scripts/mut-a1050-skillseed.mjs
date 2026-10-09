#!/usr/bin/env node
/**
 * gui/scripts/mut-a1050-skillseed.mjs — A-1050 守卫（tests/core-ts/a1050-guards.spec.ts）的变异验证。
 *
 * 改坏方向都是"下一个人顺手就会写回去"的样子：省掉台账判断（技能每次启动都复活）、
 * 无条件覆盖（用户改过的技能被冲掉）、把「跳过」也记账（用户删掉自己那份后默认补不上）、
 * 忘记过滤隐藏目录、复制不递归、把播种挪出打包分支、从 extraFiles 里漏掉种子目录。
 * 它们**全都不报错** —— 表现只是"技能库少几个 / 用户改动丢了 / 打包版空库"。
 *
 * ⚠️ 全程快照 + 还原；行尾自适应（这些文件在 Windows 上是 CRLF）。
 * 用法：node gui/scripts/mut-a1050-skillseed.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* A-1200 · B4：skill_seed.ts 的实现被升级路径重写，判定它要**同时**看两份守卫 ——
   a1050（播种/不覆盖/不复活/幂等的原始语义）+ a1200-plugin-seed-upgrade（升级语义）。
   只挂 a1050 会让「无条件覆盖用户目录」这类变异在两份守卫的缝里存活。 */
const GUARDS = [
  "tests/core-ts/a1050-guards.spec.ts",
  "tests/core-ts/a1200-plugin-seed-upgrade.spec.ts",
];
const F_SEED = "gui/src/main/skill_seed.ts";
const F_BOOT = "gui/src/main/boot.ts";
const F_EB = "gui/electron-builder.json";
const FILES = [F_SEED, F_BOOT, F_EB];

const MUTATIONS = [
  {
    name: "M1 省掉台账判断 → 用户删掉的默认技能每次启动都复活",
    file: F_SEED,
    /* ⚠️ 2026-10-09 锚点重打（A-1200 · B4）：决策从 known.has(name) 重写为
       「台账没有 + 目录没有 ⇒ 首次播种」两段式（升级路径引入）。变异意图不变：
       废掉「台账里有记录 ⇒ 不复活」这半条 —— 用户删过的示例/技能每次启动都回来。 */
    from: `      if (!entry && !existsSync(targetChild)) {`,
    to: `      if (!existsSync(targetChild)) {`,
  },
  {
    name: "M2 无条件覆盖 → 用户改过的同名目录被随包版本冲掉",
    file: F_SEED,
    /* ⚠️ 2026-10-09 锚点重打 + **换点**（A-1200 · B4）：原变异打的是第二个 if 里的
       `!existsSync` 那半条 —— 实测**存活**，读码核实为**等价变异**：
       目录不存在时 `from = readPluginVersion(不存在)` 本就是 null ⇒ 版本判据会自己 continue
       （「不复活」有第二道防线）。⇒ 换点打真正承重的 `!entry`（「用户自建目录不认领」）：
       废掉它之后，用户自建的目录会被当"可升级"处理（版本更高就覆盖）。
       ⚠️ 这条只有 a1200 的守卫能抓（a1050 的技能目录没有 plugin.json ⇒ 版本判据永远拦下），
       所以本脚本的 GUARDS 必须同时挂两份 —— 见文件头 GUARDS 处的说明。 */
    from: `      if (!entry || !existsSync(targetChild)) { continue; }`,
    to: `      if (!existsSync(targetChild)) { continue; }`,
  },
  {
    name: "M3 把「用户自建目录」也记账 → 用户删掉自己那份后默认再也补不上",
    file: F_SEED,
    /* ⚠️ 2026-10-09 锚点重打（A-1200 · B4）：新实现里"记账"发生在首次播种之后。
       变异意图不变：把**不该记的也记上** —— 在「用户自建目录」那一支跳过前先记账，
       于是台账里出现一个我们从未播过的名字；用户随后删掉自己那份时会被「不复活」挡住。 */
    from: `      if (!entry || !existsSync(targetChild)) { continue; }`,
    to: `      known.set(name, { name, version: null });\nif (!entry || !existsSync(targetChild)) { continue; }`,
  },
  {
    name: "M4 不过滤隐藏目录 → .disabled 之类的状态目录被当技能复制",
    file: F_SEED,
    from: `    if (e.startsWith(".")) { return false; }`,
    to: `    if (false) { return false; }`,
  },
  {
    name: "M5 播种复制不递归 → 带 scripts/ references/ 的技能只进来一个空壳目录",
    file: F_SEED,
    /* ⚠️ 2026-10-09 锚点重打（A-1200 · B4）：新实现里播种的 cpSync 写成
       cpSync(seedChild, targetChild, { recursive: true })。变异意图不变。 */
    from: `        cpSync(seedChild, targetChild, { recursive: true });`,
    to: `        cpSync(seedChild, targetChild, { recursive: false });`,
  },
  {
    name: "M6 把播种挪出打包分支（回归：开发模式播种会遮蔽「打包版空库」故障）",
    file: F_BOOT,
    /* ⚠️ 2026-10-09 锚点重打（A-1198）：示例扩展播种 bootstrapPlugins() 插在 bootstrapSkills 之后，
       原锚第三行漂移。变异意图不变：把技能播种从打包分支摘掉。 */
    from: `  bootstrapSkills(slimeRoot);\n  bootstrapPlugins();\n} else {`,
    to: `  bootstrapPlugins();\n} else {`,
  },
  {
    name: "M7 extraFiles 漏掉种子目录 → 安装包里没有默认技能",
    file: F_EB,
    from: `    {\n      "from": "template/skills",\n      "to": "template/skills"\n    },\n`,
    to: ``,
  },
];

function runGuards() {
  const r = spawnSync(
    process.execPath,
    [resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...GUARDS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const snapshot = (files) => {
  const m = new Map();
  for (const rel of files) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { m.set(p, readFileSync(p, "utf8")); }
  }
  return m;
};
const restore = (snap) => { for (const [p, t] of snap) { writeFileSync(p, t); } };
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const eolOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");
const adapt = (s, eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

function main() {
  const snap = snapshot(FILES);
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");
  const base = runGuards();
  if (!base.ok) {
    console.error("[mut-a1050] 基线守卫未通过\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info("[mut-a1050] 基线守卫通过\n");

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = snap.get(path);
    if (original === undefined) { survivors.push(m.name); continue; }
    const eol = eolOf(original);
    const from = adapt(m.from, eol);
    const to = adapt(m.to, eol);
    if (!original.includes(from)) {
      console.error(`[mut-a1050] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, original.replace(from, to));
    if (runGuards().ok) {
      console.error(`[mut-a1050] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1050] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1050] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1050] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
