#!/usr/bin/env node
/**
 * gui/scripts/mut-a1095s2.mjs — A-1095 #8（正文后置闸门）守卫的变异验证。
 *
 * 用户诉求：「修改正文输出逻辑，改在**所有思考结束后**再统一输出。」
 *
 * ⚠️ 上一版判据「首个 chunk = 思考结束」**从根上就是错的**（agentic 轮内正文与工具交错，
 * 首个 chunk 只说明"这一段写完了"）⇒ 闸门第一段正文就永久敞开 ⇒ 用户看到的与改动前无差别。
 * 现判据 = `!loading`（本轮全部工作收尾）—— A-1124 起收进唯一产地 `GatedBody` 的
 * `const gateOpen = !gated;`（`gated` 由调用方按 `loading` 传入）。下面每条变异都锁**当前判据**的一个支柱。
 *
 * 属于**静默失效**类。变异各锁一个判据：
 *   ① 闸门判据反向 → 流式期正文不显示、历史正文消失；
 *   ② 关闸期不再隐藏正文容器 → 正文照旧与思考交错刷出来（**等于没做** —— 用户驳回的正是这个）；
 *   ③ 占位文案不再区分「工具在跑」→ 用户不知道卡在哪一步；
 *   ④ 旧单向闩 `contentPhaseRef` 复活 → 两个判据并存，下一个维护者必然只改一个；
 *   ⑤ chunk 分支把 partialRef 累积删掉 → token 统计/兜底/持久化全部丢数据。
 *   ⑥ A-1124 新增：恢复占位气泡退回裸 `<Markdown>` → 切会话再切回时 `GatedBody` 调用数从 2 掉到 1
 *      （用户实测问题 a 的**唯一**结构根因：那条路径是另一份更旧的实现）。
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
const SPECS = ["tests/gui/a1095-body-gate.spec.ts"];

const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_PANEL];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1095s2");

/* A-1124 迁移：闸门与它的显示层判据搬进唯一产地 `GatedBody`（正文后置闸门 + 渐入 + 占位），
   判据行由内联的 `!loading` 变成 `!gated`（`gated` 由调用方按 `loading` 传入）。
   锚点跟着搬：缩进从 20 空格（IIFE 内）变成 2 空格（函数体顶层）。 */
/** 闸门判据那一行（多条变异共用；写成常量免得三处漂移） */
const GATE_LINE = "  const gateOpen = !gated;";

const MUTATIONS = [
  {
    name: "1 闸门判据反向（!gated → gated）：流式期不显示、历史正文消失",
    file: F_PANEL,
    mutate: (t) => sub(t, GATE_LINE, "  const gateOpen = gated;"),
  },
  {
    name: "2 关闸期不再隐藏正文容器（正文照旧与思考交错刷出来 —— 等于没做）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      <div style={gateOpen && shown ? undefined : { display: \"none\" }}>",
      "      <div style={undefined}>",
    ),
  },
  {
    name: "3 占位文案不再区分「思考 + 工具在跑」（用户不知道卡在哪一步）",
    file: F_PANEL,
    /* A-1106（问题 1）：该占位文案的类名从 `.text-breathe` **恢复成** `.text-scan-light`
       （用户点名要扫光）⇒ 锚点跟随；判据（**必须区分**两种文案）不变。 */
    mutate: (t) => sub(
      t,
      '<span className="text-scan-light">{runningTool ? "思考与工具调用进行中" : "正在思考"}</span>',
      '<span className="text-scan-light">{"正在思考"}</span>',
    ),
  },
  {
    name: "4 旧单向闩 contentPhaseRef 复活（两个判据并存 → 下一个维护者只改一个）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      GATE_LINE,
      '  const gateOpen = !gated || contentPhaseRef.current === "content";',
    ),
  },
  {
    name: "5 chunk 分支不再累积 partialRef（token 统计/兜底/持久化全部丢数据）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '      if (c.type === "chunk") {\n        partialRef.current += c.data?.content ?? "";\n',
      '      if (c.type === "chunk") {\n',
    ),
  },
  {
    name: "6 恢复占位气泡退回裸 Markdown（切会话再切回就被「改动前的老设定」覆盖 —— 用户实测问题 a）",
    file: F_PANEL,
    /* A-1124 新增：这是用户实测问题 a 的**唯一**结构根因 —— 切会话恢复时 `resumeMsgId` 非空，
       流式现场块整块让位，改由 `messages` 里那条占位气泡渲染；那条路此前是裸 `<Markdown>`
       （无闸门、无渐入、不区分占位两态）。变异 = 把它退回裸 Markdown：
       `GatedBody` 调用数从 2 掉到 1 ⇒ body-gate ⑤ 的 `toBe(2)` 必红。 */
    mutate: (t) => sub(
      t,
      "              ? <GatedBody shown={liveText} gated={gated} runningTool={runningTool} />",
      "              ? <Markdown text={liveText} />",
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1095s2")) { process.exit(1); }
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
