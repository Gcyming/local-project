#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095s5.mjs — A-1095 #5（吐字渐入推广到思考）守卫的变异验证。
 *
 * 用户诉求：「顺便推广吐字动画到思考内容」。
 * 属于**静默失效**类。变异各锁一个判据：
 *   ① 思考分支退回普通 Markdown（渐入没接上）；
 *   ② streamingTail 判据漏掉 group.isLast（历史段也在逐字重播）；
 *   ③ streamingTail 判据漏掉 kind==="think"（对工具/计划卡也套渐入）；
 *   ④ 历史区误传 liveStream（打开旧消息整段重新打一遍）；
 *   ⑤ 正文不再走 StreamFadeText（出现第二个产地 —— A-1080 约束迟早失守）。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原走**字节**；还原后比 sha256，带 SIGINT 保险。
 * ⚠️ 本环境禁止 node→node 孙进程（全量模式跑不了）⇒ 用 `--apply N` + shell 循环。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1095-think-fade.spec.ts", "tests/gui/a1061-visual.spec.ts", "tests/gui/a1065-fade-text.spec.ts"];

const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095s5");

/* A-1095 #8′ 迁移：`streamingTail` 判据由**单行**变为**跨行**写法（`Boolean(` / 判据行 / `);`），
   起作用的仍是中间那一行 —— 锚点就打这一行（带缩进 10 空格），#2 / #3 共用一个常量。 */
const TAIL_PRED = "          liveStream && group.isLast && isLastOfGroup && (step.kind === \"think\" || step.kind === \"body\"),";

const MUTATIONS = [
  {
    name: "1 思考分支退回普通 Markdown（渐入没接上）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "{streamingTail ? <StreamFadeText text={cleanThink} /> : <Markdown text={cleanThink} />}",
      "<Markdown text={cleanThink} />",
    ),
  },
  {
    name: "2 streamingTail 判据漏掉 group.isLast（历史段也在逐字重播）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      TAIL_PRED,
      '          liveStream && isLastOfGroup && (step.kind === "think" || step.kind === "body"),',
    ),
  },
  {
    name: "3 streamingTail 判据漏掉 kind 兜底（工具 / 计划卡也被套渐入）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      TAIL_PRED,
      "          liveStream && group.isLast && isLastOfGroup,",
    ),
  },
  {
    name: "4 历史区误传 liveStream（打开旧消息整段重新打一遍）",
    file: F_PANEL,
    /* A-1124 迁移：该 `groups.map` 现在必须把 `liveStream` **透传**给 `TimelineGroupBlock`
       （切会话恢复的占位气泡要它是"活"的，历史消息则靠默认假）。变异 = 把透传换成**硬编码真**。 */
    mutate: (t) => sub(
      t,
      "            {groups.map((g) => (\n              <TimelineGroupBlock key={`g\${g.from}`} group={g} liveStream={liveStream} />\n            ))}",
      "            {groups.map((g) => (\n              <TimelineGroupBlock key={`g${g.from}`} group={g} liveStream />\n            ))}",
    ),
  },
  {
    name: "5 正文不再走 StreamFadeText（出现第二个产地）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "        <StreamFadeText text={shown} />",
      /* ⚠️ A-1124 迁移：该行现位于 `GatedBody` 内的 `<div style={gateOpen …}>` 里，
         缩进由 26 空格变为 8 空格 ⇒ 替换文本整体减 18 个空格。意图（唯一产地）逐字保留：
         正文尾巴改由**手写**的 `visibleTailUnits(fade.units)` 渲染 ⇒
         全文件出现第二个产地 ⇒ think-fade ① 的 `hits).toBe(1)` 与 body-gate ③ 必须变红。 */
      "        {(() => {\n"
      + "          const fade = splitStreamFade(shown);\n"
      + "          return (\n"
      + "            <>\n"
      + "              {fade.settled ? <Markdown text={fade.settled} streaming /> : null}\n"
      + "              {fade.linePrefix}\n"
      + "              {visibleTailUnits(fade.units).map((u) => (\n"
      + "                u.text ? <span key={u.at} className=\"stream-fade-unit\">{u.text}</span> : null\n"
      + "              ))}\n"
      + "            </>\n"
      + "          );\n"
      + "        })()}",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    if (r.status !== 0) { return { ok: false, spawnBlocked: false, spec }; }
  }
  return { ok: true, spawnBlocked: false };
}

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

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
    if (existsSync(manifestPath)) { console.error("上一轮的变异还没还原 —— 先跑 --restore。"); process.exit(1); }
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
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) { console.error(`❌ 还原校验失败：${man.file}`); process.exit(1); }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，全量模式跑不了。"); process.exit(1); }
if (!base.ok) { console.error(`基线未通过（${base.spec}）。`); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败。"); process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095s5")) { process.exit(1); }
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
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
