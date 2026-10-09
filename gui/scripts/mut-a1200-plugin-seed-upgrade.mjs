#!/usr/bin/env node
/**
 * mut-a1200-plugin-seed-upgrade.mjs — **A-1200 · B4（随包示例的版本感知升级）**的变异验证。
 *
 * ## 这一层在防什么（用户实测截图发现的真缺陷）
 * 用户打开「设置 → 外观」，看到「扩展皮肤」只有 1 套、「扩展 CSS 外观」显示「无扩展提供」
 * —— A-1200 做出来的新能力**在界面上看不见**。
 * 根因：数据根里的示例还是旧版，而播种实现**从不比对内容**（只看「台账有名字」或
 * 「目录已存在」就跳过）⇒ 随包示例改版后老用户永远停在旧版 = 静默失效。
 *
 * 本批把播种从「只播一次」升级为「版本感知地升级」，三条硬边界：
 *   ① 只升不降（语义化比较）；② 保用户数据（逐文件覆盖）；③ 备份失败就不升级（fail-closed）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 版本比较改回字符串比较 | `1.10.0 > 1.9.0` 判false ⇒ 新版本永远升不上去（静默） | B4① 语义化比较 |
 * | 2 | 只升不降的 `<= 0` 放宽成 `< 0` | 同版本也"升级" ⇒ 每次启动都覆盖一遍用户目录 | B4④ 幂等 |
 * | 3 | 升级不读目标版本（一律当可升） | 降级覆盖（用户手上的新版本被旧模板盖掉） | B4① 只升不降 |
 * | 4 | 覆盖改成「删目录再整份复制」 | **用户数据被抹掉**（settings.json / trust.json） | B4② 保用户数据 |
 * | 5 | 备份失败仍继续升级 | 不可逆覆盖（用户丢了东西还回不去） | B4③ 备份不可写 |
 * | 6 | 备份是空操作（不真拷） | 有"备份"之名无备份之实 ⇒ 出问题回滚不了 | B4③ 备份里是旧版 |
 * | 7 | 无备份根时也升级 | 没有回滚点的覆盖（禁止项） | B4③ 未给备份根 |
 * | 8 | 用户自建目录也认领 | 覆盖用户自己写的东西 | B4④ 自建不认领 |
 * | 9 | 「不复活」台账判据摘掉 | 用户删过的示例每次启动又回来 | B4④ 不复活 |
 * | 10 | 老台账格式读不出（只认对象） | 老用户台账读空 ⇒ 示例被当"用户自建"⇒ 永不升级 | B4④ 向后兼容 |
 * | 11 | 升级后不写台账新版本 | 下次启动又升一遍（且用户数据反复被覆盖） | B4④ 台账记新版本 |
 * | 12 | 启动播种退回旧接口（不带 backupRoot） | 老用户永远升不上去（本批整个失效） | B4⑤ 启动接线 |
 * | 13 | 安装按钮退回「已存在就报错」 | 手动路径也拿不到新版 | B4⑤ 按钮走升级 |
 * | 14 | 安装按钮自己写一份覆盖逻辑 | 两套实现迟早漂移（其中一套忘了保用户数据） | B4⑤ 复用同一实现 |
 * | 15 | 快照不带升级记录 | 升级发生了用户却不知道（静默升级） | B4⑤ 快照带记录 |
 * | 16 | 模板版本号退回 1.0.0 | 对老用户（1.0.0）不构成"更高" ⇒ 本批修复整体失效 | B4⑤ 模板版本更高 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-seed-upgrade.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 * ⚠️ 锚点一律用双引号字面量（check-mut-anchors 的 readConcat 只解析双引号，
 *    用单引号会落进「未命中」的假红 —— B3 实测踩过）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1200-plugin-seed-upgrade.spec.ts",
  "tests/core-ts/a1050-guards.spec.ts",
  "tests/core-ts/runtime-paths.spec.ts",
];

const F_SEED = "gui/src/main/skill_seed.ts";
const F_BOOT = "gui/src/main/boot.ts";
const F_MAIN = "gui/src/main/index.ts";
const F_IPC = "gui/src/shared/ipc.ts";
const F_EXAMPLE = "gui/template/plugins/hello-slime/plugin.json";
const TARGETS = [F_SEED, F_BOOT, F_MAIN, F_IPC, F_EXAMPLE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1200su");

const MUTATIONS = [
  {
    name: "1 版本比较改回字符串比较（1.10.0 > 1.9.0 判false ⇒ 新版本永远升不上去）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "export function comparePluginVersions(a: string, b: string): number {\n  const pa = parseVersion(a);\n  const pb = parseVersion(b);",
      "export function comparePluginVersions(a: string, b: string): number {\n  return String(a) === String(b) ? 0 : String(a) > String(b) ? 1 : -1;\n  const pa = parseVersion(a);\n  const pb = parseVersion(b);",
    ),
  },
  {
    name: "2 只升不降放宽成「不同就升」（同版本也覆盖 ⇒ 每次启动都动用户目录）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      if (comparePluginVersions(to, from) <= 0) { continue; }",
      "      if (comparePluginVersions(to, from) === 0) { continue; }     // mutated: 降级也升",
    ),
  },
  {
    name: "3 升级前不读目标版本（一律当可升 ⇒ 降级覆盖用户手上的新版本）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      const from = readPluginVersion(targetChild);\n      if (to === null || from === null) { continue; }",
      "      const from = readPluginVersion(targetChild) ?? \"0.0.0\";\n      if (to === null) { continue; }",
    ),
  },
  {
    name: "4 覆盖改成「删目录再整份复制」（用户数据被抹掉）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      copyTemplateOver(seedChild, targetChild);\n      known.set(name, { name, version: to });",
      "      rmSync(targetChild, { recursive: true, force: true });\n      cpSync(seedChild, targetChild, { recursive: true });\n      known.set(name, { name, version: to });",
    ),
  },
  {
    name: "5 备份失败仍继续升级（不可逆覆盖）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      const backup = backupDir(targetChild, opts.backupRoot, name, now());\n      if (backup === null) { continue; }        // fail-closed：没有回滚点就不动用户目录",
      "      const backup = backupDir(targetChild, opts.backupRoot, name, now()) ?? \"\";",
    ),
  },
  {
    name: "6 备份是空操作（有备份之名无备份之实 ⇒ 出问题回滚不了）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "    mkdirSync(backupRoot, { recursive: true });\n    cpSync(before, dest, { recursive: true });\n    return dest;",
      "    mkdirSync(dest, { recursive: true });\n    return dest;",
    ),
  },
  {
    name: "7 无备份根时也升级（没有回滚点的覆盖＝禁止项）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      if (!opts.backupRoot) { continue; }",
      "      if (!opts.backupRoot) { opts = { ...opts, backupRoot: opts.backupRoot ?? \".\" }; }",
    ),
  },
  {
    name: "8 用户自建目录也认领（覆盖用户自己写的东西）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      if (!entry || !existsSync(targetChild)) { continue; }",
      "      if (!existsSync(targetChild)) { continue; }",
    ),
  },
  {
    name: "9 「不复活」台账判据摘掉（用户删过的示例每次启动又回来）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      if (!entry && !existsSync(targetChild)) {",
      "      if (!existsSync(targetChild)) {",
    ),
  },
  {
    name: "10 老台账格式读不出（老用户被当「用户自建」⇒ 永不升级）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      if (typeof item === \"string\") {\n        out.push({ name: item, version: null });                    // 老格式：版本未知\n      } else if (item !== null && typeof item === \"object\") {",
      "      if (false) {\n        out.push({ name: String(item), version: null });\n      } else if (item !== null && typeof item === \"object\") {",
    ),
  },
  {
    name: "11 升级后不写台账新版本（下次启动又升一遍）",
    file: F_SEED,
    mutate: (t) => sub(
      t,
      "      copyTemplateOver(seedChild, targetChild);\n      known.set(name, { name, version: to });\n      upgraded.push({ name, from, to, backup });",
      "      copyTemplateOver(seedChild, targetChild);\n      upgraded.push({ name, from, to, backup });",
    ),
  },
  {
    name: "12 启动播种退回旧接口（不带 backupRoot ⇒ 老用户永远升不上去）",
    file: F_BOOT,
    mutate: (t) => sub(
      t,
      "    const res = seedOrUpgradeDirs(seedDir, target, { backupRoot });",
      "    const res = seedOrUpgradeDirs(seedDir, target);",
    ),
  },
  {
    name: "13 安装按钮退回「已存在就报错」（手动路径也拿不到新版）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    let res: { seeded: string[]; upgraded: SeedUpgradeRecord[] };",
      "    if (existsSync(join(PLUGINS_ROOT, EXAMPLE_PLUGIN_NAME))) {\n      return { ok: false, error: \"已存在同名扩展目录，不覆盖\" };\n    }\n    let res: { seeded: string[]; upgraded: SeedUpgradeRecord[] };",
    ),
  },
  {
    name: "14 安装按钮自己写一份覆盖逻辑（两套实现迟早漂移）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      res = seedOrUpgradeDirs(seedDir, PLUGINS_ROOT, {\n        backupRoot: PLUGINS_BACKUP_ROOT,\n        only: [EXAMPLE_PLUGIN_NAME],\n      });",
      "      res = { seeded: [], upgraded: [] };\n      cpSync(src, join(PLUGINS_ROOT, EXAMPLE_PLUGIN_NAME), { recursive: true, force: true });",
    ),
  },
  {
    name: "15 快照不带升级记录（升级发生了用户却不知道＝静默升级）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "  const upgrades = takeSeedUpgrades().map((u) => ({ name: u.name, from: u.from, to: u.to, backup: u.backup }));",
      "  const upgrades: Array<{ name: string; from: string; to: string; backup: string }> = [];",
    ),
  },
  {
    name: "16 模板版本号退回 1.0.0（对老用户不构成「更高」⇒ 本批修复整体失效）",
    file: F_EXAMPLE,
    mutate: (t) => sub(t, "\"version\": \"1.1.0\"", "\"version\": \"1.0.0\""),
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
if (reportEolProblems(eolFound, "mut-a1200-seed-upgrade")) { process.exit(1); }

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

console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
console.error("请改用 shell 批次：");
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1200-plugin-seed-upgrade.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length === 0) { process.exit(1); }
process.exit(1);
