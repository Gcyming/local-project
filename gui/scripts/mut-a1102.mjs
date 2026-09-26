#!/usr/bin/env node
/**
 * gui/scripts/mut-a1102.mjs — A-1102 守卫的变异验证（通知身份注册「一直在失败」）。
 *
 * 用户截图（cmd 窗口）：`[notify] 注册通知应用身份失败（toast 头部会显示成包名
 * com.slime.gui / 无图标）：写注册表失败：Command failed: …reg.exe add … /v DisplayName …
 * /v IconUri …`，下面跟着一坨乱码（reg.exe 的用法帮助）。
 *
 * 根因（真机实测）：**`reg add` 一条命令只接受一组 `/v /t /d`** ——
 *   旧实现把 DisplayName + IconUri 两组塞一条 ⇒ reg.exe exit 1 + 用法帮助
 *   ⇒ 注册自 A-1055 引入 IconUri 起**每次启动都在失败**（toast 头部一直退回 com.slime.gui）。
 *   逐值写入 → exit 0 且 reg query 回读两值俱在（真机在测试键上验证过，测完已删）。
 *
 * ## 覆盖的四条
 *
 *   1  退回「两组 `/v /t /d` 塞一条 reg add」（事故本体 —— 真机实测 exit 1）
 *   2  失败静默吞掉（toast 头部退回包名/无图标而日志无声）
 *   3  失败信息透传原始 message（reg 的 GBK stderr 在 UTF-8 终端必然乱码）
 *   4  回读校验被删（写完不查 = 写没写进去全凭信仰）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 一律走共享模块 `sub()`（行尾无关）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1102.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1102.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1102.mjs --apply 1   # 只改第 1 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1102.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   set -o pipefail                      # ⚠️ 没有它，$? 取到的是 sed 的退出码（恒 0）⇒ 全部误报
 *   for n in $(seq 1 4); do
 *     node gui/scripts/mut-a1102.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     out=$(node node_modules/vitest/vitest.mjs run tests/core-ts/a1102-notify-regadd.spec.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
 *     red=$?
 *     node gui/scripts/mut-a1102.mjs --restore >/dev/null
 *     if [ "$red" = "1" ] && printf '%s' "$out" | grep -q "Tests" && printf '%s' "$out" | grep -q "AssertionError"; then
 *       echo "M$n ✅ 被捕获"; else echo "M$n ❌ 未被捕获"; fi
 *   done
 *   ```
 *   ⚠️ 判捕获必须**同时**确认输出里有 `Tests` 汇总行与 `AssertionError` ——
 *   否则"零测试执行"（收集失败）会被当成捕获。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1102-notify-regadd.spec.ts"];

const F_IDENTITY = "gui/src/main/notifyIdentity.ts";
const TARGETS = [F_IDENTITY];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1102");

/* ── 锚点：一律顶层常量 + 拼接字面量（`check-mut-anchors.mjs` 的 constMap 才能解析） ── */
/** 单值参数数组（修复后的形态；重排实现时这条要跟着迁） */
const SINGLE_VALUE_ARGS =
  "[\"add\", key, \"/f\", \"/v\", v.name, \"/t\", \"REG_SZ\", \"/d\", v.value]";
/** 失败收集那一行（双引号串里写反引号/${ 均为普通字符，constMap 可解析） */
const FAIL_PUSH_LINE =
  "failures.push(`${v.name}（reg add 退出码 ${err.status ?? \"未知\"}）`);";
/** 回读比对那一行 */
const READBACK_LINE = "const bad = values.filter((v) => got[v.name] !== v.value);";

const MUTATIONS = [
  {
    name: "1 【事故本体】退回「两组 /v /t /d 塞一条 reg add」（真机实测 exit 1 —— 注册从未成功过）",
    file: F_IDENTITY,
    mutate: (t) => sub(t, SINGLE_VALUE_ARGS,
      "[\"add\", key, \"/f\", \"/v\", v.name, \"/t\", \"REG_SZ\", \"/d\", v.value"
      + ", \"/v\", \"IconUri\", \"/t\", \"REG_SZ\", \"/d\", \"file:///D:/x.png\"]"),
  },
  {
    name: "2 失败静默吞掉（toast 头部退回包名/无图标而日志无声）",
    file: F_IDENTITY,
    mutate: (t) => sub(t, FAIL_PUSH_LINE, "/* 变异：失败被静默吞掉 */"),
  },
  {
    name: "3 失败信息透传原始 message（reg 的 GBK stderr 在 UTF-8 终端必然乱码 —— 用户截图里那坨天书）",
    file: F_IDENTITY,
    mutate: (t) => sub(t, FAIL_PUSH_LINE, "failures.push(String((e as Error)?.message ?? e));"),
  },
  {
    name: "4 回读校验被删（写完不查 = 写没写进去全凭信仰）",
    file: F_IDENTITY,
    mutate: (t) => sub(t, READBACK_LINE, "const bad: typeof values = []; /* 变异：不回读 */"),
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
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);           // **字节**备份
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异（manifest 不存在）—— 无需操作。"); process.exit(0); }
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

/* ── 全量模式 ─────────────────────────────────────────────────────── */
const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
/* 中断即还原：`finally` 在 Ctrl+C（SIGINT 直接终止、不展开栈）下**不执行** ——
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（本仓实测踩到过）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (!base.ok) {
  console.error(`基线未通过（${base.spec}）—— 先修好测试再跑变异。`);
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1102")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const res = runSpecs();
    writeFileSync(path, src);
    if (res.ok) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
