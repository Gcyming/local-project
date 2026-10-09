#!/usr/bin/env node
/**
 * gui/scripts/mut-a1132-final-body.mjs — A-1132（收尾正文 = 收尾阶段的正文）的变异验证。
 *
 *   1  `pickFinalBody` 恒返回 allText（= 原 bug：正文变全过程日志，用户报的「非常长」复发）
 *   2  `pickFinalBody` 恒返回 tailText（收尾阶段为空时给**空回复**）
 *   3  非流式 `run()` 收尾退回裸 `raw`（两路径口径又不一致）
 *   4  流式 `runStream()` 收尾退回裸 `allText`（原 bug 原样复发）
 *   5  **中断**路径被顺手改成 pickFinalBody（用户一按停止，已产出正文被截断）
 *   6  **预算**熔断路径被顺手改成 pickFinalBody（同上）
 *   7  跨轮累加被删（收尾阶段为空时没有内容可回退 ⇒ 保底失效）
 *   8  `runStream` 的「以工具调用为界重置收尾阶段」被删（过程叙述又全进正文）
 *   9  `run` 的同一条被删（非流式路径复发）
 *   10 `runStream` 收尾阶段累加改成**覆盖**（多段收尾被吞 —— 存量 `tools.spec.ts` 语义级锁这条）
 *   11 `run` 收尾阶段累加改成覆盖（同宗，非流式路径）
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环：
 *      for i in $(seq 1 11); do node gui/scripts/mut-a1132-final-body.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run tests/core-ts/a1132-final-body.spec.ts \
 *             tests/core-ts/tools.spec.ts --config vitest.config.ts --reporter=dot; \
 *        node gui/scripts/mut-a1132-final-body.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行。
 *   ⚠️ **两个 spec 都要跑**：第 10 条的真守卫在**存量** `tools.spec.ts`（「第一段」/「任务完成了」
 *      不许丢），只跑 `a1132` 会漏掉那条语义级锁（铁律 3：变异必须跑守卫真正所在的 spec）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1132-final-body.spec.ts",
  "tests/core-ts/tools.spec.ts",
];
const F_LOOP = "core-ts/src/tool_loop.ts";
const TARGETS = [F_LOOP];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1132");
const CUT = 'if (nextCalls.length > 0) { tailText = ""; }';
/* ⚠️ `JOIN_*` 必须是**源码当前的形态**（累加），`OVERWRITE_*` 才是变异体。
   首版把 `JOIN_RAW` 写成了覆盖形态 ⇒ `sub(t, X, X)` 恒等、一个字都没改，
   而脚本只报"锚点未命中"之外就没别的错 ⇒ 那条变异**什么也没证明**（等价变异体的近亲）。 */
const JOIN_RAW = 'else if (raw) { tailText = tailText ? `${tailText}\\n\\n${raw}` : raw; }';
const JOIN_RT = 'else if (roundText) { tailText = tailText ? `${tailText}\\n\\n${roundText}` : roundText; }';
const OVERWRITE_RAW = 'else if (raw) { tailText = raw; }';
const OVERWRITE_RT = 'else if (roundText) { tailText = roundText; }';
/** 跨轮累加（`allText`）的锚点：缩进必须与源码逐字一致（`sub` 是**精确**匹配，不做空白归一化）。 */
const ACC_ROUNDTEXT = '      if (roundText) {\n        allText = allText ? `${allText}\\n\\n${roundText}` : roundText;';

const MUTATIONS = [
  {
    name: "1 pickFinalBody 恒返回 allText（正文变全过程日志，用户报的「非常长」复发）",
    file: F_LOOP,
    mutate: (t) => sub(
      t,
      '  const r = tailText ?? "";\n  return r ? r : (allText ?? "");',
      '  return allText ?? "";',
    ),
  },
  {
    name: "2 pickFinalBody 恒返回 tailText（收尾阶段为空时给空回复）",
    file: F_LOOP,
    mutate: (t) => sub(
      t,
      '  const r = tailText ?? "";\n  return r ? r : (allText ?? "");',
      '  return tailText ?? "";',
    ),
  },
  /* ⚠️ 下面 3/4 两条：两处收尾 return 的**前 12 行逐字节相同**（连行尾那个空格都一样），
     原锚靠行尾注释 `// A-1132（run）` / `// A-1132（runStream）` 区分；
     2026-10-05 注释剥离后注释变成空行（在 `text:` 的**上方**），两处锚点同时失效。
     ⇒ 改锚**该路径独有的行**：往下走到 `opts.messages.push` 之后，
        run() 是 `content: msg?.content ?? null,`、runStream() 是 `content: null,`。
     ⚠️ 实测深度：到 `role: "assistant",` 为止时 runStream 侧仍命中 2 次（那 12 行两边全同），
        必须**含上 `content:` 那一行**才唯一。
     ⚠️ 往下锚（而不是往上）还有个好处：往上要先跨过 runStream 侧 12 个空行 / run 侧 3 个空行，
        跨空行违反「锚点不跨剥离残留」这一条。往下这几行**全是代码、零空行**。 */
  {
    name: "3 非流式 run() 收尾退回裸 raw（两路径口径又不一致）",
    file: F_LOOP,
    mutate: (t) => sub(t,
      "          text: pickFinalBody(tailText, allText), \n"
      + "          raw: pickFinalBody(tailText, allText),\n"
      + "          rounds: round,\n"
      + "          roundLog: roundLog.map((r) => r.details).flat(),\n"
      + "          reasonings,\n"
      + "          lastUsage,\n"
      + "          usage: usageAcc,\n"
      + "        };\n"
      + "      }\n"
      + "      opts.messages.push({\n"
      + '        role: "assistant",\n'
      + "        content: msg?.content ?? null,",
      "          text: raw, \n"
      + "          raw: pickFinalBody(tailText, allText),\n"
      + "          rounds: round,\n"
      + "          roundLog: roundLog.map((r) => r.details).flat(),\n"
      + "          reasonings,\n"
      + "          lastUsage,\n"
      + "          usage: usageAcc,\n"
      + "        };\n"
      + "      }\n"
      + "      opts.messages.push({\n"
      + '        role: "assistant",\n'
      + "        content: msg?.content ?? null,",
    ),
  },
  {
    name: "4 流式 runStream() 收尾退回裸 allText（原 bug 原样复发）",
    file: F_LOOP,
    /* 分叉行是 `content: null,`（流式路径下一律推 null，正文在别处已 flush 过）。 */
    mutate: (t) => sub(t,
      "          text: pickFinalBody(tailText, allText), \n"
      + "          raw: pickFinalBody(tailText, allText),\n"
      + "          rounds: round,\n"
      + "          roundLog: roundLog.map((r) => r.details).flat(),\n"
      + "          reasonings,\n"
      + "          lastUsage,\n"
      + "          usage: usageAcc,\n"
      + "        };\n"
      + "      }\n"
      + "      opts.messages.push({\n"
      + '        role: "assistant",\n'
      + "        content: null,\n"
      + "        tool_calls: toContract(nextCalls),",
      "          text: allText, \n"
      + "          raw: pickFinalBody(tailText, allText),\n"
      + "          rounds: round,\n"
      + "          roundLog: roundLog.map((r) => r.details).flat(),\n"
      + "          reasonings,\n"
      + "          lastUsage,\n"
      + "          usage: usageAcc,\n"
      + "        };\n"
      + "      }\n"
      + "      opts.messages.push({\n"
      + '        role: "assistant",\n'
      + "        content: null,\n"
      + "        tool_calls: toContract(nextCalls),",
    ),
  },
  {
    name: "5 中断路径被顺手改成 pickFinalBody（按停止后已产出正文被截断）",
    file: F_LOOP,
    /* ⚠️ `all: true` = 显式声明整组替换。**这条闸门本身就是计数闸门**：
       spec 数 `text: allText,` 的出现次数**必须恰好是 2**（run 与 runStream 各一处，
       A-1194 给非流式 run 补了中断返回）。而这条锚点在两处**逐字节相同**
       （实测 2 次命中）—— 那是源码的**真实结构**，不是锚点漂移。
       只改一处会把计数从 2 变成 1，红是红了，却不是「这条变异名字说的那个缺陷」
       （用户按停止后两条路径里仍有一条正常，弱化变异体）。
       ⚠️ 与第 6 条（预算熔断）同宗：那里原本也不唯一，已按同一理由显式声明整组替换。 */
    all: true,
    mutate: (t) => subAll(
      t,
      "          text: allText,\n          raw: allText,\n          rounds: round,\n          roundLog: roundLog.map((r) => r.details).flat(),\n          reasonings,\n          interrupted: true,",
      "          text: pickFinalBody(tailText, allText),\n          raw: pickFinalBody(tailText, allText),\n          rounds: round,\n          roundLog: roundLog.map((r) => r.details).flat(),\n          reasonings,\n          interrupted: true,",
    ),
  },
  {
    name: "6 预算熔断路径被顺手改成 pickFinalBody（同 5）",
    file: F_LOOP,
    /* ⚠️ `all: true` = 显式声明整组替换：run 与 runStream 各有一处预算熔断，
       只改一处的话另一处仍是正确实现 ⇒ 红得**不是**这条缺陷（弱化变异体）。 */
    all: true,
    mutate: (t) => subAll(
      t,
      "          const text = allText ? allText + note : `[预算提示] ${reason}，任务已提前收束。`;",
      "          const text = pickFinalBody(tailText, allText) + note;",
    ),
  },
  {
    name: "7 跨轮累加被删（收尾阶段为空时没有内容可回退 ⇒ 保底失效）",
    file: F_LOOP,
    mutate: (t) => sub(t, ACC_ROUNDTEXT, ACC_ROUNDTEXT.replace("if (roundText) {", "if (false) {")),
  },
  {
    name: "8 runStream 的「以工具调用为界重置收尾阶段」被删（过程叙述又全进正文）",
    file: F_LOOP,
    mutate: (t) => sub(t, CUT + "\n      else if (roundText) {", 'if (false) { tailText = ""; }\n      else if (roundText) {'),
  },
  {
    name: "9 run 的同一条被删（非流式路径复发）",
    file: F_LOOP,
    mutate: (t) => sub(t, CUT + "\n      else if (raw) {", 'if (false) { tailText = ""; }\n      else if (raw) {'),
  },
  {
    name: "10 runStream 收尾阶段累加改成覆盖（多段收尾被吞 —— 存量 tools.spec.ts 语义级锁这条）",
    file: F_LOOP,
    mutate: (t) => sub(t, JOIN_RT, OVERWRITE_RT),
  },
  {
    name: "11 run 收尾阶段累加改成覆盖（同宗，非流式路径）",
    file: F_LOOP,
    mutate: (t) => sub(t, JOIN_RAW, OVERWRITE_RAW),
  },
  {
    name: "12 run 的跨轮累加被删（非流式保底路径同样没内容可退）",
    file: F_LOOP,
    mutate: (t) => sub(
      t,
      '      if (raw) { allText = allText ? `${allText}\\n\\n${raw}` : raw; }',
      '      if (false) { allText = allText ? `${allText}\\n\\n${raw}` : raw; }',
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** ⚠️ 一条变异要跑**全部** SPECS：真守卫可能住在存量 spec 里（第 10 条就在 `tools.spec.ts`）。 */
function runSpec() {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    const next = m.mutate(text);
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpec();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1132")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
