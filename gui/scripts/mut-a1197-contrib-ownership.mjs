#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-contrib-ownership.mjs — A-1197「贡献资产归属收紧」的变异验证。
 *
 * ## 这一轮改的是什么
 * 上一轮把 config/skills、config/plugins 整目录豁免（修「Agent 造不了插件 / 总是被拒绝」）。
 * 副作用 = 整目录豁免 ⇒ **任何 Agent 都能写这两个目录下的任何一个插件/技能目录**：
 * 改别人的、改内置的、或在 config/plugins 下新建一个与内置插件同名的目录
 * （同名清单重复 ⇒ 装载失败，等于变相把内置能力下线）。
 *
 * ## 判据（单一真相源 shared/security-policy.yaml §⑤；本体在 classifier.ts）
 * 判在**资产目录**层，三条：① 目录不存在 ⇒ 放行；② 已存在但自带 origin=agent ⇒ 放行；
 * ③ 命中内置保留资产目录 ⇒ 拦（与标记无关）。其余 ⇒ 拦。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 归属①失效（既有目录也放行） | 回到整目录豁免：改别人/改内置的写入重新畅通 | 归属② |
 * | 2 | 来源标记一律当成 agent | 任何既有资产（哪怕 origin=market）都能改 | 归属②「不是 agent」 |
 * | 3 | 保留资产目录不再拦 | 冒名顶替内置插件（同名目录 ⇒ 装载失败/能力下线） | 归属②「冒名」 |
 * | 4 | 保留清单改成裸前缀匹配 | config/plugins/subagent-x 被误当内置（过度收紧） | 归属③「带 / 边界」 |
 * | 5 | 判据改成「取最深目录」 | 改别人插件 skills/ 下的技能被误放行 | 归属①「自己插件的 skills/」对偶 |
 * | 6 | TS 侧不吃 §⑤ 常量 | 双端漂移：TS 放宽而 Python 仍拦（或反之） | 归属④「从生成物取」 |
 * | 7 | Python 侧丢掉保留资产目录 | 同上（第二产地漂移，重演过一次） | 归属⑤「Python 同口径」 |
 * | 8 | Python 侧 fail-open（读不到就放行） | 既有目录若无标记 ⇒ 双端判法不一致 | 归属⑤「fail-closed」 |
 * | 9 | 标量键被逐字符迭代 | origin 变成 ["o","r","i",…] ⇒ 静默判错（生成器静默漂移） | 归属④「标量」 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-contrib-ownership.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, subLines, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-contrib-ownership.spec.ts",
];

const F_CLASSIFIER = "core-ts/src/tools/classifier.ts";
const F_PY = "tools/builtin.py";
const F_GEN = "scripts/gen_security_policy.py";
const TARGETS = [F_CLASSIFIER, F_PY, F_GEN];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-own");

const MUTATIONS = [
  /* ── ① 归属判据整体失效（回到整目录豁免）────────────────────────── */
  {
    name: "1 classifier 不做归属判定（改别人/改内置的写入重新畅通）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      "        const assetAbs = resolve(r, assetRel);\n        if (!existsSync(assetAbs)) { return false; }\n        return !assetDeclaresAgentOrigin(assetAbs);",
      "        return false;",
    ),
  },
  /* ── ② 来源标记不再校验取值 ─────────────────────────────────────── */
  {
    name: "2 只认「有标记文件」不校验取值（别人的 market 插件也能改）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      "  return false;\n}\n\n\nexport function isProtectedSourcePath",
      "  return true;\n}\n\n\nexport function isProtectedSourcePath",
    ),
  },
  /* ── ③ 内置保留资产目录不再拦 ───────────────────────────────────── */
  {
    name: "3 保留资产目录不再拦（冒名顶替内置插件 ⇒ 同名重复装载失败）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      "          if (assetRel === rv || assetRel.startsWith(`${rv}/`)) { return true; }",
      "          if (false) { return true; }",
    ),
  },
  {
    name: "4 保留清单改成裸前缀匹配（config/plugins/subagent-x 被误当内置）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      "          if (assetRel === rv || assetRel.startsWith(`${rv}/`)) { return true; }",
      "          if (assetRel.startsWith(rv)) { return true; }",
    ),
  },
  /* ── ④ 资产目录取「最深目录」⇒ 改别人插件里的技能被误放行 ────────── */
  {
    name: "5 资产目录改取最深目录（改别人插件 skills/ 下的技能被误放行）",
    file: F_CLASSIFIER,
    mutate: (t) => sub(
      t,
      "    const seg = relPosix.slice(prefix.length).split(\"/\").filter(Boolean);\n    return seg.length > 0 ? `${ex}/${seg[0]}` : ex;",
      "    const seg = relPosix.slice(prefix.length).split(\"/\").filter(Boolean);\n    return seg.length > 0 ? `${ex}/${seg.join(\"/\")}` : ex;",
    ),
  },
  /* ── ⑤ 双端漂移（第二产地）──────────────────────────────────────── */
  {
    name: "6 TS 侧不吃 §⑤ 生成物（改了 yaml 只同步一端 ⇒ 双端判法不同）",
    file: F_CLASSIFIER,
    mutate: (t) => subAll(
      t,
      "const RESERVED_ASSETS: readonly string[] = CONTRIBUTION_RESERVED_ASSETS.map((p) => p.toLowerCase());",
      "const RESERVED_ASSETS: readonly string[] = [];",
    ),
  },
  {
    name: "7 Python 侧丢掉保留资产目录判定（第二产地漂移，重演过一次）",
    file: F_PY,
    mutate: (t) => subLines(
      t,
      [
        "                for rv in _RESERVED_ASSETS:",
        "                    if asset_rel == rv or asset_rel.startswith(rv + \"/\"):",
        "                        return True",
      ],
      [
        "                for rv in ():",
        "                    if asset_rel == rv or asset_rel.startswith(rv + \"/\"):",
        "                        return True",
      ],
    ),
  },
  {
    name: "8 Python 侧 fail-open（读不到来源标记就当自己建的）",
    file: F_PY,
    mutate: (t) => sub(
      t,
      "                return not _asset_declares_agent_origin(_PROJECT_ROOT / asset_rel)",
      "                return False if not (_PROJECT_ROOT / asset_rel).exists() else not _asset_declares_agent_origin(_PROJECT_ROOT / asset_rel)",
    ),
  },
  /* ── ⑥ 生成器：标量键逐字符迭代的那道墙被拆掉 ─────────────────────── */
  /* ⚠️ 为什么这一条锚在**类型校验**上，而不是锚在「让标量键真的被逐字符迭代」：
   *   后者在当前代码里**已经不可达** —— 类型校验会让生成器直接 exit 1 且**不覆写生成物**，
   *   于是磁盘上的 shared/gen/* 纹丝不动，vitest 读它当然全绿（实测：这么写的一条存活了）。
   *   也就是说：逐字符迭代的**产物**没法由 vitest 抓到，能抓到的是**它面前那道墙**。
   *   ⇒ 变异描述也据实改成「拆墙」，不假装这条能证明产物侧的缺陷。 */
  {
    name: "9 生成器的键类型校验被放宽（标量键写错类型时静默逐字符迭代，不再报错）",
    file: F_GEN,
    mutate: (t) => sub(
      t,
      "        elif not isinstance(value, list):",
      "        elif not isinstance(value, (list, str)):",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
const eolBad = selfTestEolDetector(ROOT);
if (eolBad.length) {
  console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
  for (const b of eolBad) { console.error(`  - ${b}`); }
  process.exit(1);
}
const eolFound = eolProblems(MUTATIONS, ROOT);
if (reportEolProblems(eolFound, "mut-a1197-own")) { process.exit(1); }

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
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-contrib-ownership.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 3) { process.exit(1); }
process.exit(1);
