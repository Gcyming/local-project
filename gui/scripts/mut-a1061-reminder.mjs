/**
 * A-1061① 变异测试：把「提醒折进最后一条 user 消息」的实现逐个改坏，要求守卫变红。
 *
 * 盯的核心不变量只有一条：**system 只能出现在第 0 位**
 * （非首位的 system 会让 OpenAI 兼容上游 400、被 Anthropic 静默改写成 assistant）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061-reminder.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/user-reminder.spec.ts";

const MOD = "core-ts/src/llm/userReminder.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const TARGETS = [MOD, ENGINE];

const RAW_MUTATIONS = [
  {
    name: "1 折进**第一条** user（recency 尽失，复述沉进上下文中段）",
    file: MOD,
    from: "  for (let i = out.length - 1; i >= 0; i -= 1) {",
    to: "  for (let i = 0; i < out.length; i += 1) {",
  },
  {
    name: "2 空提醒不再原样返回（往上下文里塞一句空话）",
    file: MOD,
    from: "  if (!text) { return out; }",
    to: "  if (false) { return out; }",
  },
  {
    name: "3 提醒不再 trim（纯空白被当成有效提醒）",
    file: MOD,
    from: '  const text = typeof reminder === "string" ? reminder.trim() : "";',
    to: '  const text = typeof reminder === "string" ? reminder : "";',
  },
  {
    name: "4 直接改入参（不再是纯函数，调用方手里的消息数组被就地污染）",
    file: MOD,
    from: "  const out = messages.slice();",
    to: "  const out = messages as T[];",
  },
  {
    name: "5 没有 user 回合时改成追加一条 **system**（制造非首位 system）",
    file: MOD,
    from: '    out.push({ role: "user", content: text } as T);',
    to: '    out.push({ role: "system", content: text } as T);',
  },
  {
    name: "6 折叠时把原话顶掉（用户这条消息的正文被提醒覆盖）",
    file: MOD,
    from: "    out[idx] = { ...msg, content: cur.trim() ? `${cur}\\n\\n${text}` : text };",
    to: "    out[idx] = { ...msg, content: text };",
  },
  {
    name: "7 有图那条的 content-blocks 被整体替换（图片块被吃掉）",
    file: MOD,
    from: "    out[idx] = { ...msg, content: [...(cur as unknown[]), { type: \"text\", text }] };",
    to: "    out[idx] = { ...msg, content: [{ type: \"text\", text }] };",
  },
  {
    name: "8 不变量判据自己放水（从第 0 位开始扫 = 永远认为只有一个 system）",
    file: MOD,
    from: "  for (let i = 1; i < messages.length; i += 1) {",
    to: "  for (let i = 0; i < messages.length; i += 1) {",
  },
  {
    name: "9 引擎退回 push 一条尾随 system（旧写法复活）",
    file: ENGINE,
    from: "    if (reminder) { out = foldUserReminder(out, reminder); }",
    to: '    if (reminder) { out.push({ role: "system", content: reminder }); }',
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061-reminder")) { process.exit(1); }
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
