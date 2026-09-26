#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095s3.mjs — A-1095 #9（思考历程阶段归组）守卫的变异验证。
 *
 * 用户澄清（关键）：「我说的是**实时显示的调用工具的文本挪位置**，别给我理解成最后调用工具。」
 *   ⇒ 展示归属重构，不是执行时机。实现 = `groupTimeline` 投影。
 *
 * 属于**静默失效**类。变异各锁一个判据：
 *   ① 组边界不再按 think 切（全挤成一组 → 归组形同虚设）；
 *   ② 投影丢节点（切片右界写错 → 有个节点消失）；
 *   ③ `isLast` 不再标记最后一组（活跃组不展开 → 成员实时追加看不见）；
 *   ④ 接线：ThinkingPanel 退回裸 map（归组没接上）；
 *   ⑤ 接线：流式实时区退回裸 map（用户澄清针对的正是这处）；
 *   ⑥ `toolCount` 把所有节点都算进去（N 步虚高）。
 *
 * A-1124 追加三条（用户实测问题 d：「怎么每个阶段做完直接就收起了？……等所有思考历程结束
 * 输出正文时，再直接收起思考历程就行了」）：折叠判据必须从**位置**（`group.isLast`）改成
 * **时间**（`holdOpen = Boolean(liveStream)`）——否则新阶段一出现，上一组立刻折叠成一行。
 * 三条分别掐 `holdOpen` / `effectiveOpen` / `canCollapse` 的那一行。
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
const SPECS = ["tests/gui/a1095-timeline-groups.spec.ts"];

const F_PANORAMA = "gui/src/renderer/pages/todoPanorama.ts";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_PANORAMA, F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095s3");

const MUTATIONS = [
  {
    name: "1 组边界不再按 think 切（全挤成一组 —— 归组形同虚设）",
    file: F_PANORAMA,
    mutate: (t) => sub(
      t,
      "    const boundary = i === steps.length || steps[i].kind === \"think\";",
      "    const boundary = i === steps.length;",
    ),
  },
  {
    name: "2 投影丢节点（切片右界写错 —— 有节点在投影里消失）",
    file: F_PANORAMA,
    mutate: (t) => sub(
      t,
      "    const slice = steps.slice(start, i);",
      "    const slice = steps.slice(start, Math.max(start, i - 1));",
    ),
  },
  {
    name: "3 isLast 不再标记最后一组（活跃组不展开 —— 成员实时追加看不见）",
    file: F_PANORAMA,
    mutate: (t) => sub(
      t,
      "  if (groups.length > 0) { groups[groups.length - 1] = { ...groups[groups.length - 1], isLast: true }; }",
      "",
    ),
  },
  {
    name: "4 toolCount 把非工具节点也算进去（N 步虚高）",
    file: F_PANORAMA,
    mutate: (t) => sub(
      t,
      "      toolCount: slice.filter((s) => s.kind === \"tool\").length,",
      "      toolCount: slice.length,",
    ),
  },
  {
    name: "5 接线：ThinkingPanel 退回裸 map（归组没接上）",
    file: F_PANEL,
    /* A-1124 迁移：该 `groups.map` 现在把 `liveStream` 透传给 `TimelineGroupBlock`。 */
    mutate: (t) => sub(
      t,
      "            {groups.map((g) => (\n              <TimelineGroupBlock key={`g\${g.from}`} group={g} liveStream={liveStream} />\n            ))}",
      "            {timeline.map((step, i) => (\n              <TimelineNode key={`s${i}`} step={step} />\n            ))}",
    ),
  },
  {
    name: "6 接线：流式实时区退回裸 map（用户澄清针对的正是这处）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "                        {groupTimeline(liveTimeline).map((g) => (\n                          <TimelineGroupBlock key={`lg\${g.from}`} group={g} liveStream />\n                        ))}",
      "                        {liveTimeline.map((step, i) => (\n                          <TimelineNode key={`l${i}`} step={step} autoExpand={i === liveTimeline.length - 1} />\n                        ))}",
    ),
  },
  {
    name: "7 折叠判据退回**位置**（holdOpen 失效 —— 新阶段一出现，上一组立刻收起。用户实测问题 d）",
    file: F_PANEL,
    /* A-1124 新增：用户实测问题 d「怎么每个阶段做完直接就收起了？没必要，等所有思考历程结束
       输出正文时，再直接收起思考历程就行了」。结构根因 = 折叠判据是**位置的**（`group.isLast`），
       新阶段一出现，上一组的 `isLast` 当场翻假 ⇒ 立刻折叠成一行（实测 ~18 条「1 步」）。
       变异 = 把**时间的**判据 `holdOpen` 掐死（恒假）⇒ 退回按位置折叠 ⇒ 症状复发。 */
    mutate: (t) => sub(
      t,
      "  const holdOpen = Boolean(liveStream);",
      "  const holdOpen = false;",
    ),
  },
  {
    name: "8 effectiveOpen 不再认 holdOpen（整轮在跑，历史组照样收起）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "  const effectiveOpen = group.isLast || holdOpen ? true : open;",
      "  const effectiveOpen = group.isLast ? true : open;",
    ),
  },
  {
    name: "9 canCollapse 少了 !holdOpen（流式期给出会自己弹回去的折叠按钮）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "  const canCollapse = hasShell && !group.isLast && !holdOpen;",
      "  const canCollapse = hasShell && !group.isLast;",
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095s3")) { process.exit(1); }
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
