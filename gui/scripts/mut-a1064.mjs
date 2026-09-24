/**
 * A-1064 变异测试：把「引擎事件中继」的兜底透传逐个改坏，要求守卫变红。
 *
 * 红不出来 = 守卫锁错了对象。故变异是**验收标准**，不是可选步骤。
 *
 * ⚠️ 本文件里**不许**在中文句子中夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 *
 * 用法：node gui/scripts/mut-a1064.mjs
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
const SPEC = "tests/core-ts/a1064-stream-relay.spec.ts";
const CHAT_SVC = "core-ts/src/services/chat.ts";
const TARGETS = [CHAT_SVC];

/**
 * 在中继的**兜底透传块**内部做替换。
 *
 * 为什么不能直接用一行 `from`：兜底块里带一大段为什么这么写的注释，把整段注释抄进 `from`
 * 就是"锚点依赖装饰性文字"（本项目已因此静默失效过多次）。
 *
 * ⚠️⚠️ 定位**必须**以 `error` 分支为锚（它是中继 if 链最后一个显式分支，兜底块紧跟其后）。
 *   第一版写的是"全文件第一个 `} else {` 到其后的第一个 `yield emitChunk(chunk);`"——
 *   实测在 `chat.ts` 上命中的是**偏移 22828 处的无关 else 块**（跨了 5.5 万字符，
 *   一路吃进中继里 `tool` 分支的那个 yield）：变异改的是别处，守卫当然不红，
 *   4 条变异集体假绿。这正是 skill《mutation-harness》§"锚点打偏"那一节说的形状 ——
 *   **变异脚本自己会空转，且看起来像"守卫没锁住"**，极易误判成守卫的问题。
 */
function relayElseRange(t) {
  const atErr = t.indexOf('} else if (chunk.type === "error") {');
  if (atErr < 0) { return null; }
  const start = t.indexOf("} else {", atErr);
  if (start < 0) { return null; }
  const atYield = t.indexOf("yield emitChunk(chunk);", start);
  if (atYield < 0) { return null; }
  const end = t.indexOf("}", atYield);
  if (end < 0) { return null; }
  return { start, end: end + 1 };
}

/** 把兜底透传块**整块**交给 fn 处理（fn 收到块文本，返回新文本）。块不存在 → 原样返回。 */
const withRelayElse = (fn) => (t) => {
  const r = relayElseRange(t);
  if (!r) { return t; }
  return t.slice(0, r.start) + fn(t.slice(r.start, r.end)) + t.slice(r.end);
};

/** 兜底块的**存在性**：块文本里必须有 `yield emitChunk(chunk);`（否则改的是别处）。 */
const inRelayElse = (fn) => withRelayElse((blk) => {
  if (!blk.includes("yield emitChunk(chunk);")) { return blk; }
  return fn(blk);
});

const RAW_MUTATIONS = [
  {
    name: "1 兜底透传被删 —— 未列举的事件类型又被静默吞掉（回归旧形态）",
    file: CHAT_SVC,
    mutate: withRelayElse(() => ""),
  },
  {
    name: "2 假修：兜底退化成只补三个名字的 else if（heartbeat / member 仍被吞）",
    file: CHAT_SVC,
    mutate: withRelayElse((blk) => blk.replace(
      "} else {",
      "} else if (chunk.type === \"tool-start\" || chunk.type === \"steer\" || chunk.type === \"notice\") {",
    )),
  },
  {
    name: "3 兜底不原样透传：吞掉 steerId（卡片永远撤不掉 → 本轮结束重发一遍）",
    file: CHAT_SVC,
    mutate: inRelayElse((blk) => blk.replace("yield emitChunk(chunk);", "yield emitChunk({ ...chunk, steerId: undefined });")),
  },
  {
    name: "4 兜底不原样透传：吞掉 content（notice 变成一句没有信息的空状态）",
    file: CHAT_SVC,
    mutate: inRelayElse((blk) => blk.replace("yield emitChunk(chunk);", "yield emitChunk({ ...chunk, content: undefined });")),
  },
  {
    name: "5 兜底不原样透传：吞掉 toolId（实时行与完成卡配不上 → 永远停在执行中）",
    file: CHAT_SVC,
    mutate: inRelayElse((blk) => blk.replace("yield emitChunk(chunk);", "yield emitChunk({ ...chunk, toolId: undefined });")),
  },
  {
    name: "6 已列举的 error 分支不再转发（穷举断言必须覆盖显式分支，不只覆盖兜底）",
    file: CHAT_SVC,
    mutate: (t) => {
      const at = t.indexOf('} else if (chunk.type === "error") {');
      if (at < 0) { return t; }
      const lit = "yield emitChunk(chunk);";
      const end = t.indexOf(lit, at);
      if (end < 0) { return t; }
      return t.slice(0, end) + t.slice(end + lit.length);
    },
  },
  {
    name: "7 兜底变成空块（结构与行为断言必须同时红）",
    file: CHAT_SVC,
    mutate: inRelayElse((blk) => blk.replace("yield emitChunk(chunk);", "")),
  },
];

/* `mutate` 由 from/to 机械派生；显式给了 mutate 的条目不覆写 —— 自检与执行共用同一套判据。 */
const MUTATIONS = RAW_MUTATIONS.map((m) => (m.mutate ? m : { ...m, mutate: (t) => sub(t, m.from, m.to) }));

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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1064")) { process.exit(1); }
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
