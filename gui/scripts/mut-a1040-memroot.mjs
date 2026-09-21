/**
 * A-1040 变异测试：「记忆（存储位置）= 一根管两处 + 显示真话」的每一处关键实现**逐个改坏**，
 * 要求对应守卫变红。红不出来的那条，说明守卫锁错了对象或根本没锁。
 *
 * 本项目已有前科：守卫"全绿"但锁的是无关代码（A-1019 的隐形地板、A-1034 的假防线），
 * 所以变异测试是**验收标准**，不是可选步骤。
 *
 * 覆盖两个 spec：结构性守卫（tests/gui）+ 真行为守卫（tests/core-ts）。
 *
 * 用法：node gui/scripts/mut-a1040-memroot.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"…pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1040-guards.spec.ts", "tests/core-ts/a1040-guards.spec.ts"];

const F_MAIN = "gui/src/main/index.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
const F_PANEL = "gui/src/renderer/pages/MindHubPanel.tsx";
const F_STORE = "core-ts/src/memory/store.ts";

const TARGETS = [F_MAIN, F_PRELOAD, F_PANEL, F_STORE];

const MUTATIONS = [
  {
    name: "M1 configGet 退回字面 `<agentId>` 模板（假路径，且永不随设置变化）",
    file: F_MAIN,
    from: `        ? resolveMemoryPaths(agentId, { dataDir: cfg.memoryRoot || undefined })`,
    to: `        ? { memoryJson: resolve(PROJECT_ROOT, "Knowledge", "Agent Memory"), lanceDir: resolve(PROJECT_ROOT, "data", "<agentId>", "lancedb") }`,
  },
  {
    name: "M2 agentId 不再经白名单校验（路径遍历面打开）",
    file: F_MAIN,
    from: `/^[A-Za-z0-9_-]{1,64}$/.test(payload.agentId)`,
    to: `true`,
  },
  {
    name: "M3 configSet 无条件写 memoryRoot（undefined 会丢键 → 自定义根被静默清空）",
    file: F_MAIN,
    from: `    if (typeof payload.memoryRoot === "string") {
      patch.memoryRoot = payload.memoryRoot;
    }`,
    to: `    patch.memoryRoot = payload.memoryRoot as string;`,
  },
  {
    name: "M4 preload 实现侧不再接受 agentId（契约只剩一半，拿不到真实路径）",
    file: F_PRELOAD,
    from: `configGet: (agentId?: string) =>`,
    to: `configGet: () =>`,
  },
  {
    name: "M5 面板第二行退回旧字段 memoryPaths.lance（向量库地址又变成不动的那个）",
    file: F_PANEL,
    from: `cfg?.memoryPaths?.lanceDir`,
    to: `cfg?.memoryPaths?.lance`,
  },
  {
    name: "M6 改完存储位置不重新拉取（第二条路径当场不变 = 用户看到「只能改一个」）",
    file: F_PANEL,
    from: `      await reloadConfig(agentId);`,
    to: `      void 0;`,
  },
  {
    name: "M7 「恢复默认位置」出口消失（自定义根变单向门）",
    file: F_PANEL,
    from: `恢复默认位置`,
    to: `恢复位置`,
  },
  {
    name: "M8 无目标 Agent 时不再如实提示（又回到显示一条不存在的路径）",
    file: F_PANEL,
    from: `"（先选择 Agent）"`,
    to: `""`,
  },
  {
    name: "M9 MemoryStore 把向量库钉回默认 data/（本次用户报的那一行）",
    file: F_STORE,
    from: `    this.lancedbUri = opts.lancedbUri ?? paths.lanceDir;`,
    to: `    this.lancedbUri = opts.lancedbUri ?? resolve(DATA_DIR, agentId, "lancedb");`,
  },
  {
    name: "M10 resolveMemoryPaths 自定义分支里向量库不跟着根目录走",
    file: F_STORE,
    from: `      lanceDir: resolve(base, agentId, "lancedb"),`,
    to: `      lanceDir: resolve(root, "data", agentId, "lancedb"),`,
  },
  {
    name: "M11 旧向量库不迁移（改了根目录 = 既有向量静默消失）",
    file: F_STORE,
    from: `      migrateDirIfNeeded(this.defaultLanceUri, uri);`,
    to: `      void 0;`,
  },
  {
    name: "M12 迁移退化成删除旧目录（跨盘时直接毁掉用户的向量库）",
    file: F_STORE,
    from: `    cpSync(oldDir, newDir, { recursive: true });`,
    to: `    rmSync(oldDir, { recursive: true, force: true });`,
  },
  {
    name: "M13 维度探测读回 `vec` 列（永远 undefined → 每次初始化都重建表）",
    file: F_STORE,
    from: `          const raw = (rows[0] as Record<string, unknown>).vector;`,
    to: `          const raw = (rows[0] as Record<string, unknown>).vec;`,
  },
];

function hash(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function runSpecs() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map();
for (const t of TARGETS) { originals.set(t, readFileSync(join(ROOT, t), "utf8")); }
const hashes = new Map([...originals.keys()].map((t) => [t, hash(join(ROOT, t))]));

// 前置：基线必须绿（否则变异"红"毫无意义）
if (!runSpecs()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    if (!src.includes(m.from)) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）: ${m.from.slice(0, 60)}…`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, src.replace(m.from, m.to));
    const green = runSpecs();
    writeFileSync(path, src); // 立即还原，防后续变异叠加
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  for (const [t, src] of originals) { writeFileSync(join(ROOT, t), src); }
}

// 还原校验：哈希必须回到原值（否则会污染工作树）
const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
