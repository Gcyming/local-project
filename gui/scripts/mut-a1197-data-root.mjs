#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-data-root.mjs — A-1197④「数据根可配置 + 运行时状态不写安装目录」的变异验证。
 *
 * ## 这一轮改的是什么（用户原话）
 *   「skill 等一堆数据还是在 C 盘（%APPDATA%\slime-gui），
 *     我在安装时和设置里都定义过了，而 D:\tool\AI\slimecode\config 空无一物」
 *
 * ## 根因（两条叠加）
 *   ① **数据根不可配置**：boot.ts 写死 join(app.getPath("userData"), "slime-data")
 *      ⇒ 用户在任何地方选的路径都不生效，选了也是白选。
 *   ② **运行时状态散落在安装目录**：多处往 `<安装目录>/data`、`<安装目录>/config` 写
 *      ⇒ 用户机器上凭空长出 data\run.lock、config\requests.json；
 *      安装目录常不可写（Program Files），升级时还会被整体替换。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | runtimeStateDir 不 mkdir | 目录不存在时崩溃 / 启动即失败 | 「必须 mkdirSync recursive」 |
 * | 2 | 迁移改成移动（删来源） | 迁移=丢数据，出事无法回滚 | 「只复制绝不删来源」 |
 * | 3 | dataRootSet 跳过 mkdir 校验 | 选了个建不出来的目录却回报成功 | 「set 必须校验入参非空 + mkdir」 |
 * | 4 | index.ts 某个写入点回 INSTALL_ROOT | 老毛病局部复发（schedules/requests 等） | 「不得存在指向安装目录 data/config 的拼接」 |
 * | 5 | 迁移函数被摘掉（不再调用） | 用户老数据永远留在安装目录，本轮白改 | 「迁移必须在启动路径上被调用一次」 |
 * | 6 | preload 漏掉类型 interface 那一处 | 渲染层调用处类型失配 / 后期守卫抓 | 「impl 与 interface 两处都在」 |
 *
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须唯一；变异体保持语法合法。
 * ⚠️ 跑批：`bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-data-root.mjs`
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1197-data-root.spec.ts",
];

const F_DATA_ROOT = "gui/src/main/dataRoot.ts";
const F_INDEX = "gui/src/main/index.ts";
const F_PRELOAD = "gui/src/preload/index.ts";
const TARGETS = [F_DATA_ROOT, F_INDEX, F_PRELOAD];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197");

const MUTATIONS = [
  /* ── ① 运行时目录不自建 ⇒ 目录不存在时崩 ──────────────────────────── */
  {
    name: "1 runtimeStateDir 不 mkdir（目录不存在时崩）",
    file: F_DATA_ROOT,
    mutate: (t) => sub(
      t,
      '    mkdirSync(dir, { recursive: true });',
      '    mkdirSync(dir, { recursive: false });',
    ),
  },
  /* ── ② 迁移变成「移动/删除来源」⇒ 数据丢失 ─────────────────────────── */
  {
    name: "2 迁移改成删来源（迁移=丢数据，出事无法回滚）",
    file: F_INDEX,
    mutate: (t) => sub(
      t,
      "        try {\n          cpSync(from, to, { recursive: true, force: false, errorOnExist: false });\n          copied++;\n        } catch (e) {",
      "        try {\n          cpSync(from, to, { recursive: true, force: true });\n          rmSync(from, { recursive: true, force: true });\n          copied++;\n        } catch (e) {",
    ),
  },
  /* ── ③ set 不做 mkdir/存在性校验 ⇒ 假装成功 ────────────────────────── */
  {
    name: "3 dataRootSet 不 mkdir（建不出来的目录也回报成功）",
    file: F_INDEX,
    mutate: (t) => sub(
      t,
      "      mkdirSync(dir, { recursive: true });\n      if (!dataRootExists(dir)) {",
      "      mkdirSync(dir, { recursive: false });\n      if (!dataRootExists(dir)) {",
    ),
  },
  /* ── ④ 某个 INSTALL_ROOT 写入点被改回去 ────────────────────────────── */
  {
    name: "4 requests.json 写回安装目录（老毛病局部复发）",
    file: F_INDEX,
    mutate: (t) => sub(
      t,
      'const REQUESTS_FILE = join(runtimeStateDir(), "requests.json");',
      'const REQUESTS_FILE = join(INSTALL_ROOT, "config", "requests.json");',
    ),
  },
  /* ── ⑤ 迁移函数不再被调用（用户老数据永远留在安装目录） ────────────── */
  {
    name: "5 启动路径不再调迁移（老数据留在安装目录，本轮白改）",
    file: F_INDEX,
    mutate: (t) => sub(
      t,
      "      migrateLegacyInstallDirData();\n      createWindow();",
      "      createWindow();",
    ),
  },
  /* ── ⑥ preload 漏掉类型 interface 那一处 ──────────────────────────── */
  {
    name: "6 preload 漏了 slimeAPI.system 的类型 interface 声明",
    file: F_PRELOAD,
    mutate: (t) => sub(
      t,
      "      system: {\n        dataRootGet: () => Promise<DataRootInfo>;\n        dataRootPick: () => Promise<{ ok: boolean; canceled?: boolean; dir?: string; error?: string }>;\n        dataRootSet: (p: { dir: string; migrate: boolean }) => Promise<{ ok: boolean; error?: string; migrated?: boolean; root?: string; needRestart?: boolean }>;\n        dataRootReset: () => Promise<{ ok: boolean; error?: string; needRestart?: boolean }>;\n      };",
      "",
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
if (reportEolProblems(eolFound, "mut-a1197")) { process.exit(1); }

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
console.error("  bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1197-data-root.mjs");
console.error(`  （判据 spec 会自动读脚本里的 SPECS：${SPECS.join(" ")}）`);
if (TARGETS.length !== 3) { process.exit(1); }
process.exit(1);