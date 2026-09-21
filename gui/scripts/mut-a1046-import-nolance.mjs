#!/usr/bin/env node
/**
 * gui/scripts/mut-a1046-import-nolance.mjs — A-1046 守卫的变异验证。
 *
 * 守卫"通过"只说明它没报错。这里把「import.spec.ts 不拉起真实 LanceDB」的每一处关键实现
 * **逐个改坏**，要求守卫变红。改坏方向刻意选成"下一个人顺手就会写回去"的形态：
 *
 *   · 新增用例时漏掉 rebuildDeps（最典型：只想加一条冲突策略用例，忘了注入依赖）
 *   · 把 stub 的 connect 写成一个"什么都不做"的空实现（看起来更干净，实则仍然走真实加载）
 *   · 把 stub 重命名/删掉（定义还在用，只是名字对不上了）
 *
 * 这几种**都不报错**，只在**全量并发**时表现为"偶发 5s 超时" —— 单跑永远过，误导性极强。
 *
 * ⚠️ 全程快照 + 还原：任何时刻中断，源文件内容都必须回到原样（末尾核对哈希）。
 * 用法：node gui/scripts/mut-a1046-import-nolance.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"…pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/core-ts/a1046-guards.spec.ts";
const F_SPEC = "tests/core-ts/import.spec.ts";

const FILES = [F_SPEC];

const MUTATIONS = [
  {
    name: "M1 新增/改回一处裸 importAgent（漏掉 rebuildDeps → 默认实现拉起 297MB 原生模块）",
    file: F_SPEC,
    from: `const res = await importAgent({ input: pack, targetRoot: target, rebuildDeps: NO_LANCE_REBUILD });`,
    to: `const res = await importAgent({ input: pack, targetRoot: target });`,
  },
  {
    name: "M2 全部注入点被撤回（8 处一起退回默认重活路径）",
    file: F_SPEC,
    from: `, rebuildDeps: NO_LANCE_REBUILD`,
    to: ``,
    all: true,
  },
  {
    name: "M3 stub 的 connect 改成空实现（不抛 → initLancedb 照常走真实加载，等于没修）",
    file: F_SPEC,
    from:
      `    connect: async (): Promise<never> => {\n` +
      `      throw new Error("测试中禁用真实 LanceDB（避免加载 297MB 原生模块）");\n` +
      `    },`,
    to: `    connect: async (): Promise<never> => (undefined as never),`,
  },
  {
    name: "M4 stub 定义被改名（用法还在，定义对不上 → 守卫必须当场发现）",
    file: F_SPEC,
    from: `const NO_LANCE_REBUILD: RebuildDeps = {`,
    to: `const NO_LANCE_STUB_RENAMED: RebuildDeps = {`,
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

function snapshot(files) {
  const out = new Map();
  for (const rel of files) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { out.set(p, readFileSync(p, "utf8")); }
  }
  return out;
}

function restore(snap) {
  for (const [p, text] of snap) { writeFileSync(p, text); }
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * ⚠️ 行尾自适应：`tests/core-ts/import.spec.ts` 在 Windows 上是 **CRLF**。
 * 锚点里写 `\n` 对着 CRLF 文件会**静默不命中**（M1/M2/M4 是单行锚点所以没暴露，
 * M3 是唯一跨行锚点，当场暴露）。不处理的话脚本会报"锚点未命中"，
 * 但这句报错也可以被误读成"守卫没锁住"，白白多绕一圈。
 */
const eolOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n");
const adapt = (s, eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);

function main() {
  const snap = snapshot(FILES);
  if (snap.size !== FILES.length) {
    console.error(`[mut-a1046] 快照不全（${snap.size}/${FILES.length}），先确认路径`);
    process.exit(1);
  }
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");

  const base = runGuard();
  if (!base.ok) {
    console.error("[mut-a1046] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-2000));
    process.exit(1);
  }
  console.info(`[mut-a1046] 基线守卫通过（1 份守卫 / 快照 ${snap.size} 个文件）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = resolve(ROOT, m.file);
    const original = snap.get(path);
    if (original === undefined) {
      console.error(`[mut-a1046] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }
    const eol = eolOf(original);
    const from = adapt(m.from, eol);
    const to = adapt(m.to, eol);
    if (!original.includes(from)) {
      console.error(`[mut-a1046] ${m.name}\n  ✗ 锚点未命中（行尾 ${JSON.stringify(eol)}）`);
      survivors.push(m.name);
      continue;
    }
    const next = m.all ? original.split(from).join(to) : original.replace(from, to);
    if (next === original) {
      console.error(`[mut-a1046] ${m.name}\n  ✗ 变异无效果（改了等于没改）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, next);

    const r = runGuard();
    if (r.ok) {
      console.error(`[mut-a1046] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1046] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }

  restore(snap);
  const after = snapshot(FILES);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before
    && after.size === snap.size;

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1046] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1046] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "源文件还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
