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
const GUARDS = ["tests/core-ts/a1050-guards.spec.ts"];
const F_SEED = "gui/src/main/skill_seed.ts";
const F_BOOT = "gui/src/main/boot.ts";
const F_EB = "gui/electron-builder.json";
const FILES = [F_SEED, F_BOOT, F_EB];

const MUTATIONS = [
  {
    name: "M1 省掉台账判断 → 用户删掉的默认技能每次启动都复活",
    file: F_SEED,
    from: `      if (known.has(name)) { continue; }`,
    to: `      if (false) { continue; }`,
  },
  {
    name: "M2 无条件覆盖 → 用户改过的同名技能被随包版本冲掉",
    file: F_SEED,
    from: `      if (existsSync(target)) { continue; }`,
    to: `      if (false) { continue; }`,
  },
  {
    name: "M3 把「因用户已有而跳过」也记账 → 用户删掉自己那份后默认再也补不上",
    file: F_SEED,
    from: `      if (existsSync(target)) { continue; }\n      cpSync(join(seedDir, name), target, { recursive: true });\n      known.add(name);`,
    to: `      known.add(name);\n      if (existsSync(target)) { continue; }\n      cpSync(join(seedDir, name), target, { recursive: true });`,
  },
  {
    name: "M4 不过滤隐藏目录 → .disabled 之类的状态目录被当技能复制",
    file: F_SEED,
    from: `    if (e.startsWith(".")) { return false; }`,
    to: `    if (false) { return false; }`,
  },
  {
    name: "M5 复制不递归 → 带 scripts/ references/ 的技能只进来一个空壳目录",
    file: F_SEED,
    from: `      cpSync(join(seedDir, name), target, { recursive: true });`,
    to: `      cpSync(join(seedDir, name), target, { recursive: false });`,
  },
  {
    name: "M6 把播种挪出打包分支（回归：开发模式播种会遮蔽「打包版空库」故障）",
    file: F_BOOT,
    from: `  bootstrapToml(slimeRoot);\n  bootstrapSkills(slimeRoot);\n} else {`,
    to: `  bootstrapToml(slimeRoot);\n} else {`,
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
