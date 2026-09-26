/**
 * A-1061② 变异测试：把「工具执行实时状态」的每处关键实现逐个改坏，要求守卫变红。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061-livetool.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1061-livetool.spec.ts";

const LOOP = "core-ts/src/tool_loop.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const MAIN = "gui/src/main/index.ts";
const THINK = "gui/src/renderer/pages/thinkingText.ts";
const PRODUCTS = "gui/src/renderer/pages/chatProducts.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [LOOP, ENGINE, MAIN, THINK, PRODUCTS, PANEL];

const RAW_MUTATIONS = [
  {
    name: "1 执行前不再播「开始」事件（界面永远看不到执行中）",
    file: LOOP,
    from: '      for (const tc of pending) {\n        onEvent({ type: "tool-start", id: tc.id, name: tc.name, args: tc.arguments ?? "" });\n      }\n',
    to: "",
  },
  {
    name: "2 完成事件丢掉调用 id（无法配对，那一行永远停在执行中）",
    file: LOOP,
    from: 'onEvent({ type: "tool", id: tc.id, name: tc.name, args: tc.arguments ?? "", result: truncateWithDiffTag(clean, displayLimit)',
    to: 'onEvent({ type: "tool", name: tc.name, args: tc.arguments ?? "", result: truncateWithDiffTag(clean, displayLimit)',
  },
  {
    name: "3 running 判定排在「未记录」之后（正在跑落进空串 → 哑行）",
    file: THINK,
    from: "  if (running === true) { return \"执行中\"; }\n  if (typeof result !== \"string\") { return \"\"; }",
    to: "  if (typeof result !== \"string\") { return \"\"; }\n  if (running === true) { return \"执行中\"; }",
  },
  {
    name: "4 running 参数被架空（写了但永远不生效）",
    file: THINK,
    from: '  if (running === true) { return "执行中"; }',
    to: '  if (false) { return "执行中"; }',
  },
  {
    name: "5 引擎的 tool-start 分支被删（落进 tool 兜底 = 一张空工具卡）",
    file: ENGINE,
    from: '            } else if (ev.type === "tool-start") {\n              // A-1061②：工具开始执行 → 界面立刻显示「执行中…」（toolId 用于与完成事件配对）\n              liveQueue.push({ type: "tool-start", name: ev.name, args: ev.args, toolId: ev.id });\n',
    to: "",
  },
  {
    name: "6 白名单漏掉 toolId（界面永远翻不过状态）",
    file: MAIN,
    from: '      // A-1061②：工具调用 id 必须显式透传 —— 白名单构造漏一行就会被静默丢掉，\n      // 界面于是无法把「执行中…」翻成「成功/失败」（那一行会永远停在执行中）。\n      toolId: typeof d.toolId === "string" ? d.toolId : undefined,\n',
    to: "",
  },
  {
    name: "7 界面不再处理 tool-start（没有「执行中」行）",
    file: PANEL,
    from: '      if (c.type === "tool-start" && c.data?.name) {',
    to: '      if (false && c.data?.name) {',
  },
  {
    name: "8 界面不再留住 toolId（实时行无法判定哪一条在跑）",
    file: PANEL,
    from: '          // A-1061②：留住调用 id —— 实时列表靠它把「执行中」翻成「成功/失败」\n          toolId: typeof c.data.toolId === "string" ? c.data.toolId : undefined,\n',
    to: "",
  },
  {
    name: "9 实时行不再把 running 传给状态词（在跑的那条没有状态列）",
    file: PANEL,
    /* A-1095 #8′ 迁移：调用点重命名为
       `const statusLabel = toolStatusLabel(tool.result, isFail, isRunning);`
       （`status`→`statusLabel`、`t`→`tool`、`running`→`isRunning`；`toolStatusPhase` 是另一处调用）。
       意图逐字保留：把"正在跑"这一位丢掉 ⇒ 运行中的卡片没有状态词。 */
    from: "const statusLabel = toolStatusLabel(tool.result, isFail, isRunning);",
    to: "const statusLabel = toolStatusLabel(tool.result, isFail);",
  },
  {
    name: "10 复位现场不再清「执行中」行（上一轮的命令会在新一轮假装在跑）",
    file: PANEL,
    /* ⚠️ 本条闸门是**计数闸门**：`a1061-livetool.spec` 数的是 `setRunningTool(null);` 的出现
       次数（≥3），所以忠实复现"复位时不再清"必须把**三处复位点一起**去掉。只去掉一处虽然也会
       让计数降到 2、守卫照样红，但那**不是本条名字说的那个缺陷**（弱化变异体：红了，却不因为
       你要证明的这件事）。⇒ 用 `subAll` 整组替换，并显式声明 `all: true` 让
       `check-mut-anchors.mjs` 别再判"不唯一（可能改错对象）"。
       ⚠️ 双引号字面量：静态核验器只认双引号锚点，写单引号会被报成「未核验」（那就等于没人查）。 */
    all: true,
    mutate: (t) => subAll(t, "    setRunningTool(null);\n", ""),
  },
  {
    name: "11 失败判定退回内联双产地（执行中与卡片会判得不一样）",
    file: PANEL,
    from: "  const isFail = isToolFailResult(r);",
    to: "  const isSuccessPrefix = /^\\[(已委派|提示|成功)\\]/i.test(r);\n  const isFail = !isSuccessPrefix;",
  },
  {
    name: "12 失败判定恒为 false（失败的工具显示成成功）",
    file: PRODUCTS,
    /* 迁移（2026-09-24 复核实测）：内联正则已抽成模块常量 `FAIL_PREFIX_RE`。
       原锚点 `return /^(...)/i.test(r);` 在源码里已不存在 ⇒ 本守卫**静默失效**。
       判据不变：失败判据一旦恒 false，失败的工具会被显示成成功。
       改成把该常量整体替换为"永不匹配"（等价于恒 false，但保留常量名以免下游报错）。 */
    from: "const FAIL_PREFIX_RE = /^(\\[错误\\]|\\[失败\\]|💥|❌|✕|错误|失败|拒绝|未找到|no such|not found|error|failed|denied|exception)/i;",
    to: "const FAIL_PREFIX_RE = /(?!)x/i;",
  },
];

const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map();
for (const t of TARGETS) { originals.set(t, readFileSync(join(ROOT, t), "utf8")); }
const hashes = new Map([...originals.keys()].map((t) => [t, hash(join(ROOT, t))]));

if (!runSpec()) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061-livetool")) { process.exit(1); }
console.log("行尾检测器自检 + 锚点自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）: ${m.from.slice(0, 60)}…`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    writeFileSync(path, src);
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
  console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
