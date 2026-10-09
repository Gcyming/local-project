#!/usr/bin/env node
/**
 * mut-a1198-plugin-trust.mjs — A-1197 · B4（T1 脚本信任）的变异验证。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | M1 | registerScripts 不再读 trust | **未信任也装配可执行脚本**（最高危的一档失守） | a1198-plugin-trust ③ |
 * | M2 | 执行超时改 10 分钟 | 「一次性子进程」边界名存实亡 | a1198-plugin-trust ③ |
 * | M3 | cwd 改成 process.cwd() | 脚本在**宿主工作目录**里跑（越界） | a1198-plugin-trust ③ |
 * | M4 | trust.ts 缺文件时默认放行 | fail-closed 反转（最危险的失效形态） | a1198-plugin-trust ① |
 * | M5 | 信任开关写盘后不重装 | 假开关：打开不装配、关闭不撤装 | a1198-plugin-trust ③ |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-trust.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1198-plugin-trust.spec.ts",
];

const F_MAIN = "gui/src/main/index.ts";
const F_TRUST = "core-ts/src/plugin/trust.ts";
const TARGETS = [F_MAIN, F_TRUST];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-trust");

const MUTATIONS = [
  {
    name: "M1 registerScripts 不再读 trust（未信任也装配可执行脚本）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      if (!readPluginTrust(dir)) {\n        return [];\n      }",
      "      /* 不再读信任状态：未信任也装配 */",
    ),
  },
  {
    name: "M2 执行超时改 10 分钟（一次性子进程边界名存实亡）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "const PLUGIN_SCRIPT_TIMEOUT_MS = 30_000;",
      "const PLUGIN_SCRIPT_TIMEOUT_MS = 600_000;",
    ),
  },
  {
    name: "M3 cwd 改成 process.cwd()（脚本在宿主工作目录里跑）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "      child = spawn(process.execPath, [entryAbs], {\n        cwd,",
      "      child = spawn(process.execPath, [entryAbs], {\n        cwd: process.cwd(),",
    ),
  },
  {
    name: "M4 trust.ts 缺文件时默认放行（fail-closed 反转）",
    file: F_TRUST,
    mutate: (t) => sub(
      t,
      "  } catch {\n    return false;\n  }\n}",
      "  } catch {\n    return true;\n  }\n}",
    ),
  },
  {
    name: "M5 信任开关写盘后不重装（假开关：打开不装配、关闭不撤装）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      "    const next = await reloadPlugins();\n    return { ok: true as const, trusted, snapshot: snapshotPlugins(next) };",
      "    const next = state;\n    return { ok: true as const, trusted, snapshot: snapshotPlugins(next) };",
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
if (reportEolProblems(eolFound, "mut-a1198-plugin-trust")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-plugin-trust.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);
