/**
 * A-1041 变异测试：「LanceDB 不再误打包 + 能力不砍 + 未就位如实告知」的每一处关键实现**逐个改坏**，
 * 要求 tests/gui/a1041-guards.spec.ts 变红。红不出来的那条，说明守卫锁错了对象或根本没锁。
 *
 * 为什么必须做：这些结构性事实**改回去都不报错**，只在真机上表现为
 *   「安装包又变 1GB」或「向量检索静默失效」——两者都是本项目反复踩过的精度杀手。
 *
 * 用法：node gui/scripts/mut-a1041-bundle.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能用 `new URL(...).pathname` —— 项目根含空格（"…pilot project"），
// pathname 会把空格编码成 %20，拼出来的路径直接 ENOENT。fileURLToPath 才正确解码。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1041-guards.spec.ts"];

const F_STORE = "core-ts/src/memory/store.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_STUB = "gui/src/main/__stubs/lancedb-stub.ts";
const F_VITE = "gui/vite.config.ts";
const F_IPC = "gui/src/shared/ipc.ts";
const F_PANEL = "gui/src/renderer/pages/MindHubPanel.tsx";
const F_FULL = "gui/electron-builder-full.json";
const F_BASE = "gui/electron-builder.json";

const TARGETS = [F_STORE, F_MAIN, F_STUB, F_VITE, F_IPC, F_PANEL, F_FULL, F_BASE];

const MUTATIONS = [
  {
    name: "M1 退回字面量动态 import（rollup 静态分析 → 297MB 重新内联）",
    file: F_STORE,
    from: `  const spec = "@lancedb/lancedb";
  const mod = (await import(/* @vite-ignore */ spec)) as unknown as LancedbModuleLike;`,
    to: `  const mod = (await import("@lancedb/lancedb")) as unknown as LancedbModuleLike;`,
  },
  {
    name: "M2 去掉 @vite-ignore（vite 又去解析裸 specifier）",
    file: F_STORE,
    from: `await import(/* @vite-ignore */ spec)`,
    to: `await import(spec)`,
  },
  {
    name: "M3 删掉注入分支（桌面端向量能力直接丧失）",
    file: F_STORE,
    from: `  if (lancedbModuleLoader) {
    const mod = await lancedbModuleLoader();
    return (await mod.connect(uri)) as unknown as LanceDbLike;
  }
`,
    to: ``,
  },
  {
    name: "M4 注入点不再导出（主进程无从注入，等于没做）",
    file: F_STORE,
    from: `export function setLancedbModuleLoader`,
    to: `export function setLancedbLoader`,
  },
  {
    name: "M5 主进程不再注入加载器（只声明不接线）",
    file: F_MAIN,
    from: `setLancedbModuleLoader(async () => requireLancedb() as { connect: (uri: string) => Promise<unknown> });`,
    to: `void 0;`,
  },
  {
    name: "M6 回到硬编码 `lancedbEnabled: true`（与组件是否真在磁盘上脱钩）",
    file: F_MAIN,
    from: `      lancedbEnabled: lancedbComponent().ok,`,
    to: `      lancedbEnabled: true,`,
  },
  {
    name: "M7 刷新状态但不清 store 缓存（旧的仍是降级态，下载完也不生效）",
    file: F_MAIN,
    from: `  // 已缓存的 store 是在旧结论下构造的（可能已被降级）→ 全部作废重建
  memoryStores.clear();`,
    to: `  // 已缓存的 store 是在旧结论下构造的（可能已被降级）→ 全部作废重建
  void 0;`,
  },
  {
    name: "M8 配置接口不再如实返回组件状态（界面无从告知降级）",
    file: F_MAIN,
    from: `      lancedb: lancedbComponent(),`,
    to: `      lancedb: { ok: true, candidates: [] },`,
  },
  {
    name: "M9 组件未就位时抛无信息错误（静默失败）",
    file: F_STUB,
    from: `      \`LanceDB 运行时组件未就位。候选目录：\${lancedbCandidates().join(" / ")}；\` +`,
    to: `      \`加载失败；\` +`,
  },
  {
    name: "M10 组件目录常量不再导出（界面/打包脚本无从对齐同一路径）",
    file: F_STUB,
    from: `export const LANCEDB_COMPONENT_DIR = "components/lancedb";`,
    to: `const LANCEDB_COMPONENT_DIR = "components/lancedb";`,
  },
  {
    name: "M11 main target 不再自带 alias（顶层 alias 不被继承 → 297MB 回来）",
    file: F_VITE,
    from: `        resolve: { alias: { "@lancedb/lancedb": LANCEDB_STUB } },`,
    to: `        resolve: { alias: {} },`,
  },
  {
    name: "M11b 顶层 alias 不再指向桩（共享解析阶段拿不到桩）",
    file: F_VITE,
    from: `      "@lancedb/lancedb": LANCEDB_STUB,\n`,
    to: `      "@lancedb/other": LANCEDB_STUB,\n`,
  },
  {
    name: "M12 IPC 契约丢掉 lancedb 状态字段（面板拿不到 → 只能静默）",
    file: F_IPC,
    from: `  lancedb: { ok: boolean; dir?: string; error?: string; candidates: string[] };`,
    to: `  lancedb: unknown;`,
  },
  {
    name: "M13 面板不再说明「已降级为 JSON 检索」（用户只看到没结果）",
    file: F_PANEL,
    from: `未就位 —— 向量记忆已降级为 JSON 检索`,
    to: `未就位`,
  },
  {
    name: "M14 面板不再给候选目录（用户不知道该放哪，也没有生成脚本提示）",
    file: F_PANEL,
    from: `prepare-lancedb-component.mjs`,
    to: `prepare-component.mjs`,
  },
  {
    name: "M15 完整版把组件打进别的目录（体积付了，运行时永远找不到 → 静默降级）",
    file: F_FULL,
    from: `"to": "components/lancedb"`,
    to: `"to": "components/lancedb-runtime"`,
  },
  {
    name: "M16 完整版配置不再扩展默认配置（两份各自漂移，默认包的行为也跟着变）",
    file: F_FULL,
    from: `"extends": "./electron-builder.json",`,
    to: `"extends": "./electron-builder-legacy.json",`,
  },
  {
    name: "M17 默认包把 lancedb 重新塞进 asarUnpack（293MB 悄悄回到每个安装包里）",
    file: F_BASE,
    from: `"out/main/chunks/*.node",`,
    to: `"out/main/chunks/*.node",\n    "node_modules/@lancedb/lancedb-win32-x64-msvc/**/*",`,
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
