#!/usr/bin/env node
/**
 * gui/scripts/mut-a1128-stream-typing.mjs — A-1128（思考内容逐字渐入）的变异验证。
 *
 *   1  打字机不检查前缀（换轮后拿旧长度去切新文本 ⇒ 显示错位切片）
 *   2  常态不看 28ms 节拍（每帧都推进 ⇒ 一帧吐一串，又变整块蹦）
 *   3  积压过大不追赶（显示位置无限滞后 —— 用户读完结论了屏幕还在吐推理）
 *   4  `tailTypingTarget` 把工具卡也当文本节点（工具卡被逐字"吐"出来）
 *   5  `tailTypingTarget` 的 key 不含位置（同类型的相邻两段被当同一节点 ⇒ 接不上/错位）
 *   6  `trimTailToShown` 丢掉"不是前缀就整段显示"的安全阀（显示一段驴唇不对马嘴的话）
 *   7  `trimTailToShown` 把**所有**节点都截断（前面的历史被吞 = 内容丢失）
 *   8  渲染侧不再按显示缓冲截断（缓冲算得再准也没人用 ⇒ 思考又整块吐）
 *   9  rAF 里思考目标恒为 null（缓冲永远不推进 ⇒ 尾巴被截成空 / 整段不显示）
 *   10 思考缓冲**丢掉自续**（正文追平或关闸 ⇒ rAF 停 ⇒ 尾巴停在一半）
 *   11 把截断结果写回**真源** `timelineStepsRef`（持久化/恢复会丢字；唯一接口变成两处）
 *   12 正文那条自续丢掉「还没吐完」判据（关闸期 60fps 空转 —— 用户点名的老毛病）
 *   13 思考的追赶分母调到 1（追得比正文还猛 ⇒ 又变整块蹦）
 *   14 打字机节拍调成 0（节拍失效 ⇒ 每帧都推进）
 *
 * 用法：--list / --apply N / --restore / 全量。
 * ⚠️ 本环境禁止 node→node 孙进程 ⇒ 全量跑不了；用 shell 循环：
 *      for i in $(seq 1 14); do node gui/scripts/mut-a1128-stream-typing.mjs --apply $i \
 *        && node node_modules/vitest/vitest.mjs run tests/gui/a1128-stream-typing.spec.ts \
 *             --config vitest.config.ts --reporter=dot; node gui/scripts/mut-a1128-stream-typing.mjs --restore; done
 *   ⚠️ 判据 = exit≠0 **且**输出里真有 `Tests` 汇总行（否则是"没跑到"而不是"被抓到"）。
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1128-stream-typing.spec.ts";
const F_MODULE = "gui/src/renderer/pages/streamTyping.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_MODULE, F_PANEL];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1128");

const MUTATIONS = [
  {
    name: "1 打字机不检查前缀（换轮后拿旧长度切新文本 ⇒ 显示错位切片）",
    file: F_MODULE,
    mutate: (t) => sub(t, '  if (!full || !full.startsWith(s)) { s = ""; at = 0; }', '  if (!full) { s = ""; at = 0; }'),
  },
  {
    name: "2 常态不看节拍（每帧都推进 ⇒ 一帧吐一串，又变整块蹦）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  } else if (now - at >= t.stepMs) {", "  } else if (true) {"),
  },
  {
    name: "3 积压过大不追赶（显示位置无限滞后）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  if (backlog > t.catchupChars) {", "  if (false) {"),
  },
  {
    name: "4 tailTypingTarget 把工具卡也当文本节点（工具卡被逐字吐出来）",
    file: F_MODULE,
    mutate: (t) => sub(t, '  if (!last || (last.kind !== "think" && last.kind !== "body")) { return null; }', "  if (!last) { return null; }"),
  },
  {
    name: "5 tailTypingTarget 的 key 不含位置（同类型的相邻两段被当同一节点）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  return { key: `${i}:${last.kind}`, text: last.text ?? \"\" };", "  return { key: last.kind, text: last.text ?? \"\" };"),
  },
  {
    name: "6 trimTailToShown 丢掉安全阀（形态对不上也照切 ⇒ 显示驴唇不对马嘴的一段）",
    file: F_MODULE,
    mutate: (t) => sub(
      t,
      '  if (typeof shown !== "string" || text === shown || !text.startsWith(shown)) { return steps; }',
      '  if (typeof shown !== "string" || text === shown) { return steps; }',
    ),
  },
  {
    name: "7 trimTailToShown 把**所有**节点都截断（前面的历史被吞 = 内容丢失）",
    file: F_MODULE,
    mutate: (t) => sub(t, "  return [...steps.slice(0, i), { ...last, text: shown }];", "  return steps.map((s) => ({ ...s, text: shown }));"),
  },
  {
    name: "8 渲染侧不再按显示缓冲截断（缓冲算得再准也没人用 ⇒ 思考又整块吐）",
    file: F_PANEL,
    mutate: (t) => sub(t, "groupTimeline([...trimTailToShown(liveTimeline, tailShown)])", "groupTimeline([...liveTimeline])"),
  },
  {
    name: "9 rAF 里思考目标恒为 null（缓冲永不推进 ⇒ 尾巴被截成空 = 整段不显示）",
    file: F_PANEL,
    mutate: (t) => sub(t, "        tailTypingTarget(timelineStepsRef.current),", "        null,"),
  },
  {
    name: "10 思考缓冲丢掉自续（正文追平或关闸 ⇒ rAF 停 ⇒ 尾巴停在一半）",
    file: F_PANEL,
    mutate: (t) => sub(t, "      if (tailTypingHasBacklog(tailTypingRef.current, timelineStepsRef.current)) {", "      if (false) {"),
  },
  {
    name: "11 把截断结果写回**真源**（持久化/恢复会丢字；唯一接口变成两处）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      setTailShown(tailTypingRef.current.shown);\n      // A-xxx：交错时间线快照同步（增量 steps 数组——引用不可变，必须快照新数组触发渲染）\n      setLiveTimeline(timelineStepsRef.current);",
      "      setTailShown(tailTypingRef.current.shown);\n      // A-xxx：交错时间线快照同步（增量 steps 数组——引用不可变，必须快照新数组触发渲染）\n      setLiveTimeline(trimTailToShown(timelineStepsRef.current, tailShown));",
    ),
  },
  {
    name: "12 正文那条自续丢掉「还没吐完」判据（关闸期 60fps 空转 —— 用户点名的老毛病）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      if (!gated && displayPartialRef.current.length < partialRef.current.length) {",
      "      if (!gated) {",
    ),
  },
  {
    name: "13 思考的追赶分母调到 1（追得比正文还猛 ⇒ 又变整块蹦）",
    file: F_MODULE,
    mutate: (t) => sub(
      t,
      "export const THINK_TYPING: TypingTuning = { stepMs: TYPING_STEP_MS, catchupChars: 320, divisor: 40 };",
      "export const THINK_TYPING: TypingTuning = { stepMs: TYPING_STEP_MS, catchupChars: 320, divisor: 1 };",
    ),
  },
  {
    name: "14 打字机节拍调成 0（节拍失效 ⇒ 每帧都推进）",
    file: F_MODULE,
    mutate: (t) => sub(t, "export const TYPING_STEP_MS = 28;", "export const TYPING_STEP_MS = 0;"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

function runSpec() {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", SPEC, "--reporter=dot"],
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1128")) { process.exit(1); }
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
