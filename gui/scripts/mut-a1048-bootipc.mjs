#!/usr/bin/env node
/**
 * gui/scripts/mut-a1048-bootipc.mjs — A-1048 守卫（tests/gui/a1048-guards.spec.ts）的变异验证。
 *
 * 改坏方向都是"下一个人顺手就会写回去"的样子：把通道注册搬回惰性初始化、
 * 把提供者初始值写成抛错、超时直接判死、去掉日志去重。它们**都不报错**，
 * 只在真机上表现为：冷启动控制台刷屏 / 后端明明起来了却永久显示"可用性受限" / 日志噪音。
 *
 * ⚠️ 全程快照 + 还原；行尾自适应（这些文件在 Windows 上是 CRLF）。
 * 用法：node gui/scripts/mut-a1048-bootipc.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARDS = ["tests/gui/a1048-guards.spec.ts"];
const F_MAIN = "gui/src/main/index.ts";
const F_SKILLS = "core-ts/src/skills.ts";
const FILES = [F_MAIN, F_SKILLS];

const MUTATIONS = [
  {
    name: "M1 resident:state 注册点搬回惰性初始化（冷启动刷屏回归）",
    file: F_MAIN,
    from: `  ipcMain.handle("slime:resident:state", () => residentStateProvider());`,
    to: `  ipcMain.handle("slime:boot:status", () => bootQuery ?? { phase: "starting", backendReady: false, message: "正在初始化…" });`,
  },
  {
    name: "M2 requests:get 注册点搬回惰性初始化",
    file: F_MAIN,
    from: `  ipcMain.handle("slime:requests:get", () => readRequests());`,
    to: `  ipcMain.handle("slime:app:version", () => app.getVersion());`,
  },
  {
    name: "M3 提供者初始值改成抛错（渲染层轮询直接红，比空态更糟）",
    file: F_MAIN,
    from: `let residentStateProvider: () => ResidentState = () => ({ scheduler: [], subagents: [], defaultModel: undefined });`,
    to: `let residentStateProvider: () => ResidentState = () => { throw new Error("未就绪"); };`,
  },
  {
    name: "M4 初始化完成后不换提供者（界面永远空白）",
    file: F_MAIN,
    from: `      residentStateProvider = () => ({`,
    to: `      const _deadProvider = () => ({`,
  },
  {
    name: "M5 后端超时直接判死（12 秒才就绪的后端被永久标 degraded）",
    file: F_MAIN,
    from: `  emitBoot({ phase: "backend", backendReady: false, message: "后端服务仍在启动（首次导入较慢）…" });`,
    to: `  emitBoot({ phase: "degraded", backendReady: false, message: "后端服务启动超时（可用性受限）" });`,
  },
  {
    name: "M6 去掉后台续探（等于改回一次性判定）",
    file: F_MAIN,
    from: `  void (async () => {\n    for (let i = 0; i < 100; i++) {`,
    to: `  void (async () => {\n    for (let i = 0; i < 0; i++) {`,
  },
  {
    name: "M7 技能目录缺失不去重（刷新时刷屏）",
    file: F_SKILLS,
    from: `        if (!MISSING_SKILL_DIR_REPORTED.has(root)) {\n          MISSING_SKILL_DIR_REPORTED.add(root);\n          console.info(\`[skills] 技能目录不存在（跳过，只报一次）: \${root}\`);\n        }`,
    to: `        console.info(\`[skills] 技能目录不存在: \${root}\`);`,
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
    console.error("[mut-a1048] 基线守卫未通过\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info("[mut-a1048] 基线守卫通过\n");

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
      console.error(`[mut-a1048] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, original.replace(from, to));
    if (runGuards().ok) {
      console.error(`[mut-a1048] ${m.name}\n  ✗ 守卫仍绿 —— 没锁住`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1048] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }
  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before;
  console.info("");
  if (survivors.length) {
    console.error(`[mut-a1048] ${survivors.length}/${MUTATIONS.length} 条未被捕获：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1048] 全部 ${MUTATIONS.length} 条变异均让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
