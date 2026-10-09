/**
 * check-mut-syntax.mjs —— gui/scripts/*.mjs 的**语法自检**（与 `node --check` 同源）。
 *
 * ## 为什么需要（2026-10-08 实测：四份脚本同时中招）
 * 本仓的变异工具链有两层「**文本层**」检查：
 *   · `check-mut-anchors.mjs` —— 锚点的文本核验（不加载脚本）；
 *   · `_run-mut-one.mjs`     —— 条目的文本解析（不加载脚本）。
 * 它们都**不编译**目标脚本 ⇒「语法坏」可以一路全绿地藏下去（判据：没人编译 = 没人发现）：
 *   · `mut-a1068` / `probe-a1155-cdp`（历史遗留）：注释里引用了块注释终结符或反引号，
 *     提前终结注释/模板 —— 两份脚本自进仓起就**从未真正可执行**；
 *   · `mut-a1061-reconcile` / `mut-a1100`（2026-10-08 当日引入）：锚点修复时新写的注释
 *     引用了裸的块注释终结符 —— 同一套工具链同样无感。
 * ⇒ 本工具补上这一层：**用与运行时同一套解析器**（`node --check` 子进程）编译每一份。
 *
 * ## 用法
 *   node gui/scripts/check-mut-syntax.mjs              # 扫 gui/scripts 全部 .mjs
 *   node gui/scripts/check-mut-syntax.mjs --self-test  # 反空转自检：必须抓住一个已知坏样本
 *
 * ## 判据
 *   · 全部通过 → exit 0（只打合计行）；有语法错 → 逐份打错误 + exit 1。
 *   · `--self-test`：写一个**已知坏**样本给检测器，抓住才算检测器没空转
 *     （与 `_mut-eol.mjs` 的 `selfTestEolDetector` 同款惯例）。
 *   ⚠️ 修掉语法错后，**务必**重跑 `check-mut-anchors` 与相关 `_run-mut-one --list`
 *     （切分/锚点读数都依赖脚本的**真实**文本结构）。
 */
import { readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = join(ROOT, "gui", "scripts");

/** 用 node --check 检查一份文件；通过返回 null，失败返回错误文本（剥 ANSI，取前 6 行）。 */
function checkOne(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (e) {
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    return text.trim().split("\n").slice(0, 6).join("\n");
  }
}

/* ── --self-test（反空转）：检测器必须能抓住一个**已知坏**样本 ── */
if (process.argv.includes("--self-test")) {
  const probe = join(tmpdir(), `_syntax-selfcheck-${process.pid}.mjs`);
  writeFileSync(probe, "const a = ;\n", "utf8");           // 已知语法错
  const r = checkOne(probe);
  rmSync(probe, { force: true });
  if (r) { console.log("✓ self-test：坏样本被抓住（检测器非空转）"); process.exit(0); }
  console.error("✗ self-test：坏样本**没被抓住** —— 检测器本身坏了（先修本工具）");
  process.exit(1);
}

const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs")).map((f) => join(SCRIPTS, f)).sort();
const bad = [];
for (const f of files) {
  const err = checkOne(f);
  if (err) { bad.push({ f, err }); }
}
console.log(`语法自检（node --check 同源）：${files.length} 份 · 通过 ${files.length - bad.length} · 语法错 ${bad.length}`);
for (const { f, err } of bad) {
  console.log(`\n✗ ${f.replace(ROOT, "").replace(/\\/g, "/")}`);
  console.log(err.split("\n").map((l) => `    ${l}`).join("\n"));
}
if (bad.length > 0) {
  console.error(`\n⚠️ ${bad.length} 份脚本语法坏 —— **它们从未真正可执行**（工具链都是文本层检查，看不出来）。`);
  console.error("   ⇒ 修掉语法后，务必重跑 check-mut-anchors 与相关 _run-mut-one --list。");
  process.exit(1);
}
process.exit(0);
