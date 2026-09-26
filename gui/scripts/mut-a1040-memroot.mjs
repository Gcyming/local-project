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
/* ⚠️ **行尾无关的替换**（2026-09-24 补，A-1098 实测踩到）：本脚本此前用裸
   `src.replace(m.from, m.to)`，而它自己**是 CRLF 文件** ⇒ 跨行模板字面量里的换行是 `\r\n`，
   于是只有"目标恰好也是 CRLF"时才命中（此后门禁全绿，看不出问题）。
   一旦有人在 LF 的编辑器里改一行锚点，该条就**静默失效**（报"锚点未命中"还算是出声的，
   更糟的是有时前缀恰好命中、改错对象）。`_mut-eol.mjs` 的 `sub` 把行间换成 `\r?\n`、
   替换体按**目标文件自己的**行尾拼，两侧都不敏感。
   （本仓规矩：新脚本一律直接用 `sub`，不要自己再写一个 —— 详见 `_mut-eol.mjs` 文档。） */
import { sub } from "./_mut-eol.mjs";

/** 锚点行尾归一到 `\n`：`sub` 按 `\n` 切分锚点，若段尾残留 `\r` 会拼出匹配不上的正则 */
const nl = (s) => s.replace(/\r\n/g, "\n");

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
    /* ⚠️ 锚点必须带**下一行**（2026-09-24 修，静态核验实测「命中 2 次」）：`configGet: (agentId?: string) =>`
       在 `gui/src/preload/index.ts` 里有**两处** —— 实现（约 463 行）与 `SlimeApi` 的**类型声明**（约 883 行，
       形如 `configGet: (agentId?: string) => Promise<MindConfigInfo>;`）。裸打这一行的话，
       `sub`（单次 `replace`）只改到**先出现的那一处**，而核验器**无法确定**改的是不是想改的那处
       （两者文本上无法区分）⇒ 「不唯一」= 真歧义。补上紧随的实现行后锚点唯一，
       变异仍然精确命中"preload **实现侧**"这个意图。 */
    from: `configGet: (agentId?: string) =>\n      ipcRenderer.invoke("slime:mind:configGet", agentId ? { agentId } : undefined) as Promise<MindConfigInfo>,`,
    to: `configGet: () =>\n      ipcRenderer.invoke("slime:mind:configGet", undefined) as Promise<MindConfigInfo>,`,
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
    /* ⚠️ 锚点必须带上**读的是哪一行**（2026-09-24 修，静态核验实测「命中 2 次」）：
       `"（先选择 Agent）"` 在面板里出现**两处**（记忆本体行 / 向量库行，同一个三元表达式各一份）。
       裸打这个字符串时 `sub` 只改第一处 —— 而守卫是**数量守恒**闸门（`hits.length === 2`），
       所以改一处确实能让它红；但核验器从文本上**分不出**"作者想改任意一处"还是"想改这两处之一"，
       它只能如实报「不唯一」。把字段名一起锚上 ⇒ 唯一，且意图（让**这一行**不再如实提示）更明确。 */
    from: `cfg?.memoryPaths?.memoryJson ?? (agentId ? "读取中…" : "（先选择 Agent）")`,
    to: `cfg?.memoryPaths?.memoryJson ?? ""`,
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
    /* ⚠️ 匹配判定走**归一后**的文本（见 `nl` 的注释）：锚点里的行尾形态与目标文件无关，
       否则"CRLF 脚本 + LF 锚点"会误报「锚点未命中」（假警报指向"源码漂移"这个错误对象）。 */
    if (!nl(src).includes(nl(m.from))) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）: ${m.from.slice(0, 60)}…`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, sub(src, nl(m.from), nl(m.to)));
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
