/**
 * A-1065 变异测试：把「吐字方向」与「尾巴符号净化」逐个改坏，要求守卫变红。
 *
 * 覆盖两个 spec（它们各锁一半，缺一个都会漏）：
 *   · tests/gui/a1065-fade-text.spec.ts —— 行为级（fadeUnitText 净化 + 接线 + 方向交叉检查）
 *   · tests/gui/a1061-visual.spec.ts   —— 既有渐入用例（本次**迁移**而非删除，见 §迁移纪律）
 *
 * 红不出来 = 守卫锁错了对象。故变异是**验收标准**，不是可选步骤。
 *
 * ⚠️ 本文件里**不许**在中文句子中夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 *
 * 用法：node gui/scripts/mut-a1065.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1065-fade-text.spec.ts", "tests/gui/a1061-visual.spec.ts"];
const CSS = "gui/src/renderer/index.css";
const FADE = "gui/src/renderer/pages/streamFade.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [CSS, FADE, PANEL];

/** fadeUnitText 的判据体（多行锚点：行尾无关由 `sub` 保证） */
const BODY =
  '  if (!raw) { return raw; }\n'
  + '  if (/^\\s+$/.test(raw)) { return raw; }\n'
  + '  if (PURE_MARKER.test(raw)) { return ""; }\n'
  + '  if (ORDERED_MARKER.test(raw)) { return ""; }\n'
  + '  return raw.replace(/\\*\\*|~~/g, "").replace(/[*#`]/g, "");';

const MUTATIONS = [
  {
    name: "1 渐入方向翻转回旧的从左滑入（-3px）—— 用户已明确否掉的那一版",
    file: CSS,
    /* A-1076 迁移：位移机制从 `transform` 换成 `left`（尾巴单元是 inline 盒子，
       transform 会被静默忽略）。方向判据与变异意图（翻转成反向）逐字保留。 */
    mutate: (t) => sub(
      t,
      "from { opacity: 0; left: 3px; }",
      "from { opacity: 0; left: -3px; }",
    ),
  },
  {
    name: "2 注释与实现打架：渲染块注释又说回「由左到右」",
    file: PANEL,
    mutate: (t) => sub(t, "**由右到左** + 由浅到深", "由左到右 + 由浅到深"),
  },
  {
    name: "3 fadeUnitText 退化成恒等函数（控制符号又裸露 `*` `#`）",
    file: FADE,
    mutate: (t) => sub(t, BODY, "  return raw;"),
  },
  {
    name: "4 空白单元也被抹掉（相邻词粘成一段）",
    file: FADE,
    mutate: (t) => sub(t, 'if (/^\\s+$/.test(raw)) { return raw; }', 'if (/^\\s+$/.test(raw)) { return ""; }'),
  },
  {
    name: "5 纯标记单元不再隐藏（`**` `#` `>` 这些零宽标记又渲染出来）",
    file: FADE,
    mutate: (t) => sub(t, 'if (PURE_MARKER.test(raw)) { return ""; }', "if (PURE_MARKER.test(raw)) { return raw; }"),
  },
  {
    name: "6 有序列表标记不再隐藏（`1.` 裸露）",
    file: FADE,
    mutate: (t) => sub(t, 'if (ORDERED_MARKER.test(raw)) { return ""; }', "if (ORDERED_MARKER.test(raw)) { return raw; }"),
  },
  {
    name: "7 接线断裂：渲染原始单元文本，净化函数白写",
    file: PANEL,
    mutate: (t) => sub(t, "const t = fadeUnitText(u.text);", "const t = u.text;"),
  },
  {
    name: "8 净化后为空串仍然挂 span（零宽 span 堆积）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      'return t ? <span key={u.at} className="stream-fade-unit">{t}</span> : null;',
      'return <span key={u.at} className="stream-fade-unit">{t}</span>;',
    ),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
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

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1065")) { process.exit(1); }
console.log("行尾检测器自检 + 锚点自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
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
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
