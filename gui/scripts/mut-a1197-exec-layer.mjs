#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-exec-layer.mjs — A-1197「**执行层**认得豁免」的变异验证。
 *
 * ## 这一轮补的是哪个洞
 * mut-a1197-contrib-write.mjs 那一轮把豁免（config/skills、config/plugins）放开了，
 * 但只放开了**预检层**（hard_rules → classifier）。`file_write` / `file_delete`
 * 的执行层还有**自己一份** `isBlockedWritePath`，它当年只查「一级目录 ∈ 受保护清单」，
 * **不认豁免** ⇒ 预检放行、执行时仍返回「敏感文件/目录禁止写入」。
 * 用户侧看到的正是这句 ⇒「审批通过了、Agent 还是报被禁止」＝「总是被拒绝」没修好。
 *
 * ## 为什么这份脚本是独立的（而不是并进 contrib-write）
 * 那一份的 SPECS/变异都指向 classifier / policy / tools-builtin.py，
 * **一条都没碰builtin.ts** ⇒ 改坏执行层时它**全绿**（假绿守卫）。
 * 本脚本 TARGETS 只含 core-ts/src/tools/builtin.ts，
 * 判据 spec 是 tests/core-ts/a1197-contrib-write.spec.ts 的 **D 段**（行为断言，直接调导出的 isBlockedWritePath）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 丢弃 PROJECT_ROOT 路（= 退回老逻辑） | ③ 原样复发：造不了插件/技能，且「总是被拒绝」 | D「新建 plugin.json 放行」等 |
 * | 2 | sameAsProject 短路失效 | ws==slime根 时豁免被第二路重新堵死（**打包形态**）| D「ws 恰好等于 slime 根」|
 * | 3 | ws 路失效（!ws 直接返回 false） | 绑了工作区的会话完全不受源码目录保护 | D「ws 锚在项目根外」 |
 * | 4 | isBlockedWritePath 不再委派 | 豁免与归属判据整体失效，等于删掉整个执行层保护 | D 全部 |
 * | 5 | 后缀集丢掉 .toml | slime.toml 可被改写（工具锚定写入必须拦）| D「.toml 口径不许丢」 |
 * | 6 | ws 路完全不拦 | 用户工作区里的 tools/、config/ 也不再受保护 | D「ws 锚在项目根外」 |
 * | 7 | ws 路基准算错（不剥 base 前缀） | 一级目录取错 ⇒ 该拦的没拦 / 不该拦的全拦 | D「ws 锚在项目根外」 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须**唯一**；
 *   变异体保持语法合法（跑批判据要求「红」且有 Tests 汇总行，编译不过不算抓住）。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-exec-layer.mjs`
 *   （**不传 spec** —— 判据清单会自动读本脚本的 SPECS，传错/漏传会造出「假存活」）。
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-contrib-write.spec.ts",
];

const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const TARGETS = [F_BUILTIN];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-exec");

const MUTATIONS = [
  /* ── ① 执行层退回老逻辑（本轮缺陷的原样复发）────────────────────── */
  {
    name: "1 丢弃 PROJECT_ROOT 路（执行层退回老逻辑，只剩一级目录硬查）",
    file: F_BUILTIN,
    anchor: "  if (isProtectedSourcePath(abs, PROJECT_ROOT)) { return true; }",
    mutate: (t) => sub(
      t,
      "  if (isProtectedSourcePath(abs, PROJECT_ROOT)) { return true; }",
      "  if (false) { return true; }",
    ),
  },
  /* ── ② 打包形态：ws==slime根 时豁免被第二路重新堵死 ────────────────── */
  {
    name: "2 sameAsProject 短路失效（ws 等于 slime 根时豁免被重新拦下）",
    file: F_BUILTIN,
    anchor: "  if (sameAsProject) { return false; }",
    mutate: (t) => sub(
      t,
      "  if (sameAsProject) { return false; }",
      "  if (false) { return false; }",
    ),
  },
  /* ── ③ ws 路整体失效 ────────────────────────────────────────────── */
  {
    name: "3 ws 路失效（ws 非空时也不再按工作区判一级目录）",
    file: F_BUILTIN,
    anchor: "  if (!ws) { return false; }",
    mutate: (t) => sub(
      t,
      "  if (!ws) { return false; }",
      "  if (true) { return false; }",
    ),
  },
  /* ── ④ 执行层保护整体被摘掉 ─────────────────────────────────────── */
  {
    name: "4 isBlockedWritePath 不再委派给目录判定（执行层保护形同虚设）",
    file: F_BUILTIN,
    anchor: "  return isProtectedWriteDir(p, ws);",
    mutate: (t) => sub(
      t,
      "  return isProtectedWriteDir(p, ws);",
      "  return false;",
    ),
  },
  /* ── ⑤ .toml 口径：执行层必须比预检层更严（这是故意的）─────────────── */
  {
    name: "5 后缀集丢掉 .toml（slime.toml 可被工具直接改写）",
    file: F_BUILTIN,
    anchor: "  if (WRITE_BLOCKED_NAMES.has(name) || WRITE_BLOCKED_SUFFIXES.has(ext)) {",
    mutate: (t) => sub(
      t,
      "  if (WRITE_BLOCKED_NAMES.has(name) || WRITE_BLOCKED_SUFFIXES.has(ext)) {",
      '  if (WRITE_BLOCKED_NAMES.has(name) || ext === ".enc") {',
    ),
  },
  /* ── ⑥⑦ ws 路的判据本身被改坏 ──────────────────────────────────── */
  {
    name: "6 ws 路完全不拦（用户工作区里的 tools/、config/ 也不再受保护）",
    file: F_BUILTIN,
    anchor: "  return first !== undefined && WRITE_BLOCKED_DIRS.has(first.toLowerCase());",
    mutate: (t) => sub(
      t,
      "  return first !== undefined && WRITE_BLOCKED_DIRS.has(first.toLowerCase());",
      "  return false;",
    ),
  },
  {
    name: "7 ws 路基准算错（不剥掉 base 前缀，一级目录取错）",
    file: F_BUILTIN,
    anchor: "  const rel = abs.startsWith(base) ? abs.slice(base.length) : abs;",
    mutate: (t) => sub(
      t,
      "  const rel = abs.startsWith(base) ? abs.slice(base.length) : abs;",
      "  const rel = abs;",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

/* ⚠️⚠️ **门禁一律不许在 --restore 之前拦路**（本脚本首轮实测踩到，已修）。
 *   首版把锚点计数闸门放在 mode 解析**之前**、无条件跑。结果：`--apply N` 把源码改成
 *   变异态之后，下一次 `--restore` 启动时被同一道闸门挡住（源码已漂移 ⇒ 命中 0 ⇒ exit 1）
 *   ⇒ **还原逻辑根本没执行，变异体留在源码里**，M2~M7 全部报 `--apply 失败`，
 *   且脚本自己在收尾打印「检测到未还原的变异备份」。
 *   ⇒ 也就是说「防止假绿的门」本身变成了「制造源码停在变异态的事故」。
 *   铁律：**任何 exit 1 都必须发生在「不改文件」或「已还原」之后**；
 *   还原路径（--restore）必须无条件可执行。 */
const gatesOk = () => {
  /* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
  const eolBad = selfTestEolDetector(ROOT);
  if (eolBad.length) {
    console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
    for (const b of eolBad) { console.error(`  - ${b}`); }
    return false;
  }
  const eolFound = eolProblems(MUTATIONS, ROOT);
  if (reportEolProblems(eolFound, "mut-a1197-exec")) { return false; }

  /* ⚠️ **自测计数不是 0**：本项目四次前科（markPluginDisabled 被 unmarkPluginDisabled 假命中…）
   *   根源都是「锚点写错/漂移 ⇒ 命中数 0 ⇒ 断言永远绿，跑批还报「全部存活」」，
   *   而真因是「一个字都没改」。所以开跑之前逐条数命中数：非 1 直接拒绝开跑。
   *   `anchor` 与 `sub()` 的第一个实参是同一份字面量（显式写出来只为能被这里数）——
   *   少写它等于少一道计数闸门，而计数闸门是本项目最容易被静默架空的那类。 */
  for (const [i, m] of MUTATIONS.entries()) {
    const src = readFileSync(abs(m.file), "utf8");
    const n = src.split(m.anchor).length - 1;
    if (n !== 1) {
      console.error(`❌ M${i + 1} 锚点命中 ${n} 次（要求恰好 1）：${m.name}\n    ${m.anchor}\n`
        + "   ⇒ 命中 0 = 源码漂移（这条守卫已失去保护）；命中 >1 = 可能改错对象。");
      return false;
    }
    if (m.mutate(src) === src) {
      console.error(`❌ M${i + 1} 变异体没落地：${m.name}\n   ⇒ 守卫在这个脚本上是假绿，先修锚点。`);
      return false;
    }
  }
  return true;
};

/* --restore 无条件放行（见上方铁律）；--apply 只在自己要落地变异体时才需要门禁干净。 */
if (mode === "restore") { /* 故意不跑门禁 */ }
else if (!gatesOk()) { process.exit(1); }

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
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    /* ⚠️⚠️ **必须先把原文件落盘备份**，否则 `--restore` 读不到它（ENOENT 直接抛，
     *   还原逻辑死在第一行 ⇒ 变异体留在源码里）。
     *   实测踩到：首版抄骨架时漏了这一行，apply 照样报「已变异 M5」、
     *   manifest 也写出来了、唯独 `.orig` 不存在 —— 看起来完全成功，
     *   而 restore 必然失败。**apply 报成功 ⇒ 备份一定在**，这是唯一自洽的不变量。 */
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) { console.error(`锚点未命中：${m.name}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  /* ⚠️ 备份缺失时**必须先说清后果再退出**，不许让 readFileSync 抛栈
   *   （本脚本首版就是这样：apply漏写备份 ⇒ restore 抛 ENOENT 崩掉 ⇒
   *   源码停在变异态，而调用方只看到一串 fs 栈，完全不知道该手工还原哪个文件）。*/
  if (!existsSync(backup)) {
    console.error(`❌ 备份缺失：${backup}\n   ⇒ ${man.file} 可能仍停在变异态（第 ${man.index} 条：${man.name}）。\n`
      + `   请用 git 核对并手工还原：git diff -- ${man.file}`);
    process.exit(1);
  }
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式：提示改用 shell 批次 ── */
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-exec-layer.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 1) { process.exit(1); }
process.exit(1);