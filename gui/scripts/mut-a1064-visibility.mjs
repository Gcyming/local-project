/**
 * A-1064 变异测试（二）：把「引导在界面上的可见性与完整性」逐个改坏，要求守卫变红。
 *
 * 与 `mut-a1064.mjs` 的分工：
 *   · `mut-a1064.mjs`        —— 改坏**中继兜底**（引擎事件必须穿过 ChatService.stream）；
 *   · 本文件（visibility）    —— 改坏**界面上引导的形态**（一等节点 / 契约类型 / 渲染分支 / 编排指令）。
 * 两者是**不同的产地**：中继修好了而界面仍折成 think，用户照样看不到卡片（且历程完整性照旧坏）。
 *
 * 红不出来 = 守卫锁错了对象。故变异是**验收标准**，不是可选步骤。
 *
 * ⚠️ 本文件里**不许**在中文句子中夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 *
 * 用法：node gui/scripts/mut-a1064-visibility.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, nlOf, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1064-steer-visibility.spec.ts";
const PANORAMA = "gui/src/renderer/pages/todoPanorama.ts";
const CTX_META = "gui/src/renderer/pages/sessionCtxMeta.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const LOOP = "core-ts/src/tool_loop.ts";
const TARGETS = [PANORAMA, CTX_META, PANEL, LOOP];

/** TimelineNode 里 steer 那一支的范围（[起, 止)）。缺任一锚点 → null（脚本按"未命中"报错）。 */
const steerRenderRange = (t) => {
  const start = t.indexOf('if (step.kind === "steer") {');
  if (start < 0) { return null; }
  const end = t.indexOf("// 工具调用：小型行", start);
  if (end < 0) { return null; }
  return { start, end };
};

/** 在该范围内做替换（范围不存在 → 原样返回，由主流程报"未命中"）。 */
const inSteerRender = (fn) => (t) => {
  const r = steerRenderRange(t);
  if (!r) { return t; }
  const blk = fn(t.slice(r.start, r.end));
  if (blk === t.slice(r.start, r.end)) { return t; }
  return t.slice(0, r.start) + blk + t.slice(r.end);
};

/** 引导卡的折叠类名（既有 collapse 机制的唯一判据字串）。 */
const COLLAPSE_CLS = 'className={`collapse${expanded ? " is-open" : ""}`}';

const MUTATIONS = [
  {
    name: "1 引导节点退回折成 think 文本（旧形态：与相邻思考段糊成一坨，卡片彻底消失）",
    file: PANORAMA,
    mutate: (t) => sub(
      t,
      'return [...steps, { kind: "steer", text: ev.text }];',
      'return [...steps, { kind: "think", text: "引导：" + ev.text }];',
    ),
  },
  {
    name: "2 引导分支丢掉空文本守卫（产出零宽度空卡片）",
    file: PANORAMA,
    mutate: (t) => sub(
      t,
      'if (ev.kind === "steer") {\n    if (!ev.text) { return steps; }',
      'if (ev.kind === "steer") {',
    ),
  },
  {
    name: "3 持久化镜像 TimelineStepLite 不认 steer（重启回看时引导节点静默丢失）",
    file: CTX_META,
    mutate: (t) => sub(
      t,
      'kind: "think" | "tool" | "plan" | "todo" | "steer";',
      'kind: "think" | "tool" | "plan" | "todo";',
    ),
  },
  {
    name: "4 onChunk 又把引导折成 think（新写法被回退 → 卡片与历程完整性一起丢）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      '{ kind: "steer", text: steerText },',
      "{ kind: \"think\", text: `引导：${steerText}` },",
    ),
  },
  {
    name: "5 steer 渲染分支被整支删掉（引导掉进工具卡兜底 → 变成长着 undefined 名字的工具）",
    file: PANEL,
    mutate: (t) => {
      const r = steerRenderRange(t);
      if (!r) { return t; }
      return t.slice(0, r.start) + t.slice(r.end);
    },
  },
  {
    name: "6 steer 渲染分支被挪到工具卡兜底**之后**（顺序断言必须独立锁住）",
    file: PANEL,
    mutate: (t) => {
      const r = steerRenderRange(t);
      if (!r) { return t; }
      const blk = t.slice(r.start, r.end);
      const rest = t.slice(0, r.start) + t.slice(r.end);
      const anchor = 'const tool = step as TimelineStep & { kind: "tool" };';
      const at = rest.indexOf(anchor);
      if (at < 0) { return t; }
      const ins = at + anchor.length;
      return rest.slice(0, ins) + nlOf(t) + blk + rest.slice(ins);
    },
  },
  {
    name: "7 引导卡另造第二种展开动画（不复用 collapse → 节拍与思考段/规划卡不一致）",
    file: PANEL,
    mutate: inSteerRender((blk) => blk.replace(COLLAPSE_CLS, 'className={`steer-anim${expanded ? " is-open" : ""}`}')),
  },
  {
    name: "8 编排指令不再钉死 action=add（模型会落到 replace → 用户既有计划被整表抹掉）",
    file: LOOP,
    mutate: (t) => sub(t, '**默认用 action=\\"add\\"**', "**默认按需选择 action**"),
  },
];

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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1064-visibility")) { process.exit(1); }
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
