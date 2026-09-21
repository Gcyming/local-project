#!/usr/bin/env node
/**
 * gui/scripts/mut-a1043-startup.mjs — A-1043 守卫的变异验证。
 *
 * 守卫"通过"只说明它没报错，不说明它**锁住了正确的对象**。这里把「启动即空白」的修法逐条改坏，
 * 要求守卫**必须变红**。改坏的方向刻意选成"看起来更省事/更直觉"的写法（退回 await 重初始化、
 * 去掉单飞、去掉预热），因为这些正是下一个人会顺手写回去的形态。
 *
 * ⚠️ 全程快照 + 还原：任何时刻中断，源文件内容都必须回到原样（末尾核对哈希）。
 * 用法：node gui/scripts/mut-a1043-startup.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "tests/gui/a1043-guards.spec.ts";
const MAIN = "gui/src/main/index.ts";
const FLY = "gui/src/main/singleFlight.ts";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const abs = (rel) => resolve(ROOT, rel);

const WARM_BLOCK = `      void ensureServices().catch((e) => {
        console.warn("[gui:main] 后台预热失败（首屏不受影响，对话时会按需重试）:", e);
      });`;

const MUTATIONS = [
  {
    name: "M1 会话列表退回 await 重初始化（回到本次病灶：左栏被整条初始化链挡住）",
    file: MAIN,
    from: `    await ensureRegistry();
    const [metas, records] = await Promise.all([`,
    to: `    await ensureServices();
    const [metas, records] = await Promise.all([`,
  },
  {
    name: "M2 Agent 列表退回 await 重初始化",
    file: MAIN,
    from: `    await ensureRegistry();
    return (agentRegistry?.loadedAgents ?? []).map((a): AgentInfo => ({`,
    to: `    await ensureServices();
    return (agentRegistry?.loadedAgents ?? []).map((a): AgentInfo => ({`,
  },
  {
    name: "M3 只改 sessions:list 的兜底为 `agentRegistry!`（静默 TypeError → 空列表）",
    file: MAIN,
    from: `    const names = new Map((agentRegistry?.loadedAgents ?? []).map((a) => [a.id, a.name]));`,
    to: `    const names = new Map(agentRegistry!.loadedAgents.map((a) => [a.id, a.name]));`,
  },
  {
    name: "M4 去掉重初始化的单飞包装（并发调用又各跑一遍整条链）",
    file: MAIN,
    from: `const ensureServicesOnce = singleFlight<void>(async () => {`,
    to: `const ensureServicesOnce = (async () => {`,
  },
  {
    name: "M5 去掉轻量注册表的单飞包装",
    file: MAIN,
    from: `const ensureRegistryOnce = singleFlight<AgentRegistry>(async () => {`,
    to: `const ensureRegistryOnce = (async () => {`,
  },
  {
    name: "M6 重初始化不再复用轻量注册表（自己又读一份 agents.json）",
    file: MAIN,
    from: `const ensureServicesOnce = singleFlight<void>(async () => {
  if (chatService) {
    return;
  }
  const registry = await ensureRegistry();`,
    to: `const ensureServicesOnce = singleFlight<void>(async () => {
  if (chatService) {
    return;
  }
  const regLegacy = new AgentRegistry();
  await regLegacy.load();
  const registry = regLegacy;`,
  },
  {
    name: "M7 薄包装里塞回重活（单飞被绕过，40 处调用点直接跑链内逻辑）",
    file: MAIN,
    from: `async function ensureServices(): Promise<void> {
  await ensureServicesOnce();
}`,
    to: `async function ensureServices(): Promise<void> {
  await ensureServicesOnce();
  agentRegistry = new AgentRegistry();
  await agentRegistry.load();
}`,
  },
  {
    name: "M8 删掉启动期后台预热（重活退回「首次对话才发生」）",
    file: MAIN,
    from: WARM_BLOCK,
    to: ``,
  },
  {
    name: "M9 预热改成 await（首屏重新被重初始化拖住）",
    file: MAIN,
    from: WARM_BLOCK,
    to: `      await ensureServices();`,
  },
  {
    name: "M10 单飞失败后**缓存**失败（一次瞬时失败永久废掉初始化）",
    file: FLY,
    from: `    p.catch(() => { inflight = null; });`,
    to: `    p.catch(() => { /* 不清空：失败被永久缓存 */ });`,
  },
  {
    name: "M11 单飞成功后清掉 inflight（缓存失效 → 每次都重跑整条初始化）",
    file: FLY,
    from: `    p.catch(() => { inflight = null; });
    return p;`,
    to: `    p.catch(() => { inflight = null; });
    p.then(() => { inflight = null; });
    return p;`,
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
    const p = abs(rel);
    if (existsSync(p)) { out.set(p, readFileSync(p, "utf8")); }
  }
  return out;
}

function restore(snap) {
  for (const [p, text] of snap) { writeFileSync(p, text); }
}

function main() {
  const files = [MAIN, FLY];
  const snap = snapshot(files);
  if (snap.size !== files.length) {
    console.error(`[mut-a1043] 快照不全（${snap.size}/${files.length}），先确认路径`);
    process.exit(1);
  }
  const before = [...snap.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|");

  const base = runGuard();
  if (!base.ok) {
    console.error("[mut-a1043] 基线守卫未通过，先修守卫再跑变异\n" + base.out.slice(-1500));
    process.exit(1);
  }
  console.info(`[mut-a1043] 基线守卫通过（快照 ${snap.size} 个文件）\n`);

  const survivors = [];
  let red = 0;
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const original = snap.get(path);
    if (original === undefined) {
      console.error(`[mut-a1043] ${m.name}\n  ✗ 快照里没有 ${m.file}`);
      survivors.push(m.name);
      continue;
    }
    const next = original.includes(m.from) ? original.replace(m.from, m.to) : null;
    if (next === null) {
      console.error(`[mut-a1043] ${m.name}\n  ✗ 锚点未命中`);
      survivors.push(m.name);
      continue;
    }
    if (next === original) {
      console.error(`[mut-a1043] ${m.name}\n  ✗ 变异无效果（改了等于没改）`);
      survivors.push(m.name);
      continue;
    }
    writeFileSync(path, next);

    const r = runGuard();
    if (r.ok) {
      console.error(`[mut-a1043] ${m.name}\n  ✗ 守卫仍绿 —— 这条守卫没锁住它`);
      survivors.push(m.name);
    } else {
      red += 1;
      console.info(`[mut-a1043] ✓ 变红：${m.name}`);
    }
    restore(snap);
  }

  restore(snap);
  const after = snapshot(files);
  const restored = [...after.entries()].map(([p, t]) => `${p}:${sha(t)}`).join("|") === before
    && after.size === snap.size;

  console.info("");
  if (survivors.length > 0) {
    console.error(`[mut-a1043] ${survivors.length}/${MUTATIONS.length} 条变异**未被守卫捕获**：`);
    for (const s of survivors) { console.error(`  - ${s}`); }
    process.exit(1);
  }
  console.info(`[mut-a1043] 全部 ${MUTATIONS.length} 条变异均成功让守卫变红（${red} 红），`
    + `${restored ? "源文件哈希已还原 ✓" : "源文件还原失败 ✗"}`);
  process.exit(restored ? 0 : 1);
}

main();
