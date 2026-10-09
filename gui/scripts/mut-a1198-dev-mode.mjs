#!/usr/bin/env node
/**
 * mut-a1198-dev-mode.mjs — A-1197 · B6（D1 开发者模式）的变异验证。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | M1 | sandbox 的 D1 闸丢掉（不查开关） | 开关关闭时主干改写照样放行（授权形同虚设） | a1198-dev-mode ② |
 * | M2 | 主干目录检查删除 | 允许在**主工作目录**直接改主干（worktree 强制失效） | a1198-dev-mode ① |
 * | M3 | 分支前缀检查删除 | `main` / `release/*` 的 worktree 也放行（受保护分支被写） | a1198-dev-mode ① |
 * | M4 | HEAD 检查删除（只认 .git 文件） | 任意 worktree 都放行（分支硬约束失效） | a1198-dev-mode ① |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-dev-mode.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/gui/a1198-dev-mode.spec.ts",
];

const F_SANDBOX = "core-ts/src/sandbox.ts";
const F_DEV = "core-ts/src/plugin/dev-mode.ts";
const TARGETS = [F_SANDBOX, F_DEV];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1198-dev");

const MUTATIONS = [
  {
    name: "M1 sandbox 的 D1 闸丢掉（不查开关就放行）",
    file: F_SANDBOX,
    mutate: (t) => sub(
      t,
      "      if (isDevModeEnabled() && devModeWriteAllowed(target, cfg.workspace)) {",
      "      if (devModeWriteAllowed(target, cfg.workspace)) {",
    ),
  },
  {
    name: "M2 主干目录检查删除（允许在主工作目录直接改）",
    file: F_DEV,
    mutate: (t) => sub(
      t,
      "    /* ① 主干目录永远不放行（哪怕 D1 开着）。 */\n    if (abs === root || abs.startsWith(norm)) { return false; }",
      "    /* ① 主干目录检查被删（允许在主工作目录改） */",
    ),
  },
  {
    name: "M3 分支前缀检查删除（main / release 的 worktree 也放行）",
    file: F_DEV,
    mutate: (t) => sub(
      t,
      "        return /^ref:\\s*refs\\/heads\\/slime\\//.test(head);",
      "        return true;",
    ),
  },
  {
    name: "M4 HEAD 检查删除（任意 worktree 都放行，分支硬约束失效）",
    file: F_DEV,
    mutate: (t) => sub(
      t,
      "        const headPath = join(gitdir, \"HEAD\");\n        if (!existsSync(headPath)) { return false; }\n        const head = readFileSync(headPath, \"utf8\").trim();",
      "        const head = \"ref: refs/heads/slime/skip-check\";",
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
if (reportEolProblems(eolFound, "mut-a1198-dev-mode")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1198-dev-mode.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);
