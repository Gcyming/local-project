/**
 * A-1061⑥ 变异测试：「引导」在**本轮没有工具调用**时也要能注入同一轮运行。
 *
 * 用户实测原话：「我点击了但是发不过去，只能等这个的 agent 回复完才能发送啊」
 * —— 引导原本只在「工具执行完 → 下一次模型请求之前」这个边界被消费，
 * 本轮没有工具调用就**没有落点**。修法是在"本轮没要工具"的分支里**续一轮**把它注入。
 *
 * 与 mut-a1060 的分工：那份测的是"引导怎么进去/怎么撤卡片"（源码级 + 纯逻辑），
 * 这份测的是**工具循环的续轮行为**（行为级，跑 tools.spec 的假 router）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061-steerloop.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 行为级验证住在这里（假 router 驱动真工具循环） */
const SPEC = "tests/core-ts/tools.spec.ts";

const LOOP = "core-ts/src/tool_loop.ts";
const TARGETS = [LOOP];

const RAW_MUTATIONS = [
  {
    name: "1 本轮没要工具就直接收尾（引导又只能等整轮结束 = 用户遇到的原形）",
    file: LOOP,
    from: "        pending = [];\n        const steered = this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);\n        if (steered > 0) {\n          if (roundText) { opts.messages.push({ role: \"assistant\", content: roundText }); }\n          continue;\n        }\n",
    to: "",
  },
  {
    name: "2 🐛 续轮前不清 pending（上一批工具会被**再执行一遍**）",
    file: LOOP,
    from: "        pending = [];\n        const steered = this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);",
    to: "        const steered = this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);",
  },
  {
    name: "3 取了引导也不续轮（if 被架空 → 等于没修）",
    file: LOOP,
    from: "        if (steered > 0) {\n          if (roundText) { opts.messages.push({ role: \"assistant\", content: roundText }); }\n          continue;\n        }",
    to: "        if (false) {\n          if (roundText) { opts.messages.push({ role: \"assistant\", content: roundText }); }\n          continue;\n        }",
  },
  {
    name: "4 续轮时不留上一段正文（模型不知道自己刚说了什么就收到新要求）",
    file: LOOP,
    from: "          if (roundText) { opts.messages.push({ role: \"assistant\", content: roundText }); }\n          continue;",
    to: "          continue;",
  },
  {
    name: "5 非流式路径的续轮被删（run() 与 runStream 语义分叉）",
    file: LOOP,
    from: "        pending = [];\n        const steered = this.injectSteers(opts.sessionId, opts.messages);\n        if (steered > 0) {\n          if (raw) { opts.messages.push({ role: \"assistant\", content: raw }); }\n          continue;\n        }\n",
    to: "",
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061-steerloop")) { process.exit(1); }
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
