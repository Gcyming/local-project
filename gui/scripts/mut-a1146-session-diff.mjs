#!/usr/bin/env node
/**
 * mut-a1146-session-diff.mjs — A-1146「右栏会话 diff」的变异验证（2026-10-08 补建）。
 *
 * ## 为什么补建（用户实测复现的原病）
 * 「从思考历程的『修改文件』打开预览，右栏说只能在 git 仓内显示」——根因是
 * `findSessionFileDiff` 只做**字面**（归一后）比较：右栏给的是**绝对路径**
 * （tab.fileAbs），而产物记录的 `rel` 是**工具 detail 原样**（常见为工作区相对）
 * ⇒ 永远匹配不上。修复 = 按 workspace 做「绝对 ↔ 相对」**前缀级**等价匹配
 * （**不做** basename 兜底——同名不同目录会张冠李戴）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | M1 | 删「绝对 → 相对」别名分支 | 右栏又对会话内改过的文件报「未纳入 Git」 | 绝对↔相对用例 |
 * | M2 | 删「相对 → 绝对」别名分支 | 反方向失配（want 相对、产物绝对） | 反方向用例 |
 * | M3 | 匹配放宽到 basename 兜底 | 同名不同目录指向同一份 diff（张冠李戴） | 前缀级负例 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1146-session-diff.mjs
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/gui/a1146-session-diff.spec.ts",
];

const F = "gui/src/renderer/pages/chatProducts.ts";
const TARGETS = [F];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1146");

const MUTATIONS = [
  {
    name: "M1 停用「绝对 → 相对」别名分支（右栏又对会话内改过的文件报未纳入 Git）",
    file: F,
    mutate: (t) => sub(
      t,
      "if (want.startsWith(nws + \"/\")) { wants.add(want.slice(nws.length + 1)); }",
      "if (false) { wants.add(want.slice(nws.length + 1)); }",
    ),
  },
  {
    name: "M2 删「相对 → 绝对」别名分支（反方向失配）",
    file: F,
    mutate: (t) => sub(
      t,
      "else if (!want.startsWith(\"/\") && !/^[a-z]:\\//.test(want)) { wants.add(nws + \"/\" + want); }",
      "/* 相对→绝对 别名被删 */",
    ),
  },
  {
    name: "M3 匹配放宽到 basename 兜底（同名不同目录张冠李戴）",
    file: F,
    mutate: (t) => sub(
      t,
      "if (!wants.has(norm(p.rel)) && !wants.has(norm(p.name))) { continue; }",
      "if (![...wants].some((w) => norm(p.rel) === w || norm(p.name) === w || w.endsWith(\"/\" + norm(p.name)))) { continue; }",
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
if (reportEolProblems(eolFound, "mut-a1146-session-diff")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1146-session-diff.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
process.exit(1);
