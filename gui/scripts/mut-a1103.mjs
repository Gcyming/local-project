#!/usr/bin/env node
/**
 * gui/scripts/mut-a1103.mjs — A-1103 守卫的变异验证（「我设计的图标在打包版里显示不出来」）。
 *
 * ## 这条守卫锁的是什么
 *
 * 用户报的**不是**「图被换掉了」：`build/icon.ico` 与用户给的兜底素材解出来是**同一只史莱姆**。
 * 病灶是**时机** —— v0.0.7 打包于 9-22 00:48，而 `build/icon.ico` 由 A-1075 在 **9-23** 才引入
 * ⇒ 打包那一刻 `win.icon` 指向的文件**不存在**，electron-builder **不报错**，静默降级成默认图标。
 * ⇒ 守卫必须锁住三件事，缺一件照样翻车：
 *   ① **生成时机**（4 条 dist 链路打包前跑 `preicons`）；
 *   ② **产物断言**（打包后断言 `win-unpacked/build/` 下三项图标资产已落地且与源同源）；
 *   ③ **守门会中止**（断言失败必须 `exit(非 0)` —— 假绿比假红危险）。
 *
 * ## 覆盖的十六条
 *
 *   1  `dist:win` 不再跑 `preicons`（那条链路照样产出默认图标）
 *   2  `preicons` 被挪到打包命令**之后**（顺序反了就等于没生成）
 *   3  `preicons` 只生成不断言（打了包没人验收）
 *   4  `preicons` 里生成器与断言器**顺序颠倒**（先验收、后生成）
 *   5  win 链路打包后**不再断言**（`--postbuild` 那一步被删）
 *   6  win 链路的 `--postbuild` 退回**写死目录**（发布流程用 `SLIME_OUT_DIR` 换目录时查错路径）
 *   7  linux 链路打包后不再断言
 *   8  断言器 `exit` **恒 0**（读不到也当通过 —— 假绿）
 *   9  【事故本体】缺 `build/icon.ico` 时报 **OK**（v0.0.7 的那个缺陷被重新放行）
 *  10  新鲜度判据方向写反（把正常的判成陈货，把陈货判成正常）
 *  11  产物断言**只查存在、不比哈希**（「拷了旧的一份」溜过去）
 *  12  断言器不读 `SLIME_OUT_DIR`（输出目录换名时静默查错路径）
 *  13  `EXPECTED_ICO_SIZES` 与生成器 `ICO_SIZES` **漂移**（生成 7 档只验收 4 档）
 *  14  `win.icon` 退回 1024² PNG（exe / 快捷方式图标又糊）
 *  15  `extraFiles` 漏掉 `build/icon.ico`（随包目录里没有它）
 *  16  通知图体积上限被放宽（超限的后果是**整条通知被丢弃**，不是图标小一点）
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1103.mjs              # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1103.mjs --list       # 列出条目
 *   node gui/scripts/mut-a1103.mjs --apply 9    # 只改第 9 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1103.mjs --restore    # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   set -o pipefail        # ⚠️ 没有它，$? 取到的是 sed 的退出码（恒 0）⇒ 全部误报成 ESCAPED
 *   for n in $(seq 1 16); do
 *     node gui/scripts/mut-a1103.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     out=$(node node_modules/vitest/vitest.mjs run tests/gui/a1103-appicon-packaging.spec.ts 2>&1 | sed -e 's/x1b\[[0-9;]*m//g')
 *     red=$?
 *     node gui/scripts/mut-a1103.mjs --restore >/dev/null
 *     if [ "$red" != "0" ] && printf '%s' "$out" | grep -q "Tests"; then echo "M$n 被捕获"; else echo "M$n 未捕获"; fi
 *   done
 *   ```
 *   ⚠️ 判捕获必须**同时**确认输出里有 `Tests` 汇总行 —— 否则「零测试执行」（收集失败）会被当成捕获。
 *   ⚠️ 这条配方自己踩过一次坑：漏掉 `set -o pipefail` 时 `$?` 是 `sed` 的退出码 ⇒
 *      16 条变异**全被误报成「未捕获」**，而实际上 16/16 都真红（实测复现）。
 *      **判据：变异套件报「全绿/全逃逸」时，先怀疑测量工具，不是先怀疑守卫。**
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec / 脚本打成 0 用例。
 * ⚠️ 目标文件行尾是**混的**（`package.json` = LF；其余待复核）⇒ 一律走共享模块 `sub()`。
 * ⚠️ 每条变异的**首** `sub(t, CONST, …)` 必须锚在一个顶层常量上 ——
 *    `check-mut-anchors.mjs` 才能静态核验「命中且唯一」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1103-appicon-packaging.spec.ts"];

const PKG = "gui/package.json";
const CFG = "gui/electron-builder.json";
const ASSERT = "gui/scripts/assert-appicon.mjs";
const TARGETS = [PKG, CFG, ASSERT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1103");

/* ── 锚点：一律顶层常量（`check-mut-anchors.mjs` 的 constMap 要能解析） ── */

/* ── ① package.json ── */
/** `dist:win` 里「preicons → retry-build」那一段。
 *  ⚠️ 唯一性靠 `retry-build.mjs &&` 这个尾巴：`dist:win:publish` 在它后面跟的是 `--publish always`。 */
const PKG_WIN_PRE = "&& npm run preicons && node ../scripts/retry-build.mjs &&";
/** `preicons` 那一整行（含键名，故唯一） */
const PKG_PREICONS_LINE = '"preicons": "node ./scripts/make-notify-icon.mjs && node ./scripts/assert-appicon.mjs"';
/** `dist:win` 里「retry-build → 打包后断言」那一段（唯一性同 PKG_WIN_PRE） */
const PKG_WIN_POST = "node ../scripts/retry-build.mjs && node ./scripts/assert-appicon.mjs --postbuild";
/** `dist:linux` 的打包后断言（带 `--publish never` 前缀才唯一） */
const PKG_LINUX_POST = "--publish never -c.directories.output=release-linux && node ./scripts/assert-appicon.mjs --bundle release-linux/linux-unpacked";

/* ── ② electron-builder.json ── */
/** win 段的 `icon`（linux 段是 `build/icon.png`，故这条唯一） */
const CFG_WIN_ICON = '"icon": "build/icon.ico"';
/** `extraFiles` 里 icon.ico 那一项 */
const CFG_EXTRA_ICO = '{ "from": "build/icon.ico", "to": "build/icon.ico" },';

/* ── ③ assert-appicon.mjs ── */
/** 收尾那行 exit（`process.exit(2)` 在别处，故唯一） */
const ASSERT_EXIT = "process.exit(fail === 0 ? 0 : 1);";
/** 缺 icon.ico 时的 MISS（v0.0.7 事故现场的那一条） */
const ASSERT_ICO_MISS =
  '    miss("build/icon.ico 存在", "win.icon 指向它 —— 缺了 electron-builder 会**静默**降级成默认图标");';
/** 新鲜度判据（派生物早于源头才报错） */
const ASSERT_FRESH = "if (dMs < srcMs) {";
/** 产物断言里的哈希比对（连同 else 支一起锚，避免只锚到半句） */
const ASSERT_HASH_CMP =
  '    if (sha256(a) !== sha256(b)) { miss("产物 " + rel + " 与源资产同源", "内容不一致（拷了旧的一份？）"); }\n'
  + '    else { ok("产物 " + rel + " 与源资产同源（" + a.length + " B）"); }';
/** 产物目录推导：读 `SLIME_OUT_DIR` 那两行 */
const ASSERT_OUTDIR =
  '  const overridden = (process.env.SLIME_OUT_DIR || "").trim();\n'
  + "  const base = resolve(GUI_DIR, overridden || output);";
/** 尺寸清单（与生成器 `ICO_SIZES` 是两个产地） */
const ASSERT_SIZES = "const EXPECTED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];";
/** 通知图体积上限 */
const ASSERT_NOTIFY_MAX = "const NOTIFY_MAX_BYTES = 200 * 1024;";

const MUTATIONS = [
  /* ── ① 生成时机：打包前必须生成（v0.0.7 的病灶） ─────────────────── */
  {
    name: "1 `dist:win` 不再跑 `preicons`（那条链路照样产出「默认图标」的包）",
    file: PKG,
    mutate: (t) => sub(t, PKG_WIN_PRE, "&& node ../scripts/retry-build.mjs &&"),
  },
  {
    name: "2 `preicons` 被挪到打包命令**之后**（顺序反了就等于没生成）",
    file: PKG,
    mutate: (t) => sub(t, PKG_WIN_PRE, "&& node ../scripts/retry-build.mjs && npm run preicons &&"),
  },
  {
    name: "3 `preicons` 只生成、不断言（打了包没人验收）",
    file: PKG,
    mutate: (t) => sub(t, PKG_PREICONS_LINE, '"preicons": "node ./scripts/make-notify-icon.mjs"'),
  },
  {
    name: "4 `preicons` 里生成器与断言器顺序颠倒（先验收后生成）",
    file: PKG,
    mutate: (t) => sub(t, PKG_PREICONS_LINE, '"preicons": "node ./scripts/assert-appicon.mjs && node ./scripts/make-notify-icon.mjs"'),
  },

  /* ── ② 产物断言：打包后必须验收 ─────────────────────────────────── */
  {
    name: "5 win 链路打包后**不再断言**（`--postbuild` 那一步被删 ⇒ 缺资产也没人知道）",
    file: PKG,
    mutate: (t) => sub(t, PKG_WIN_POST, "node ../scripts/retry-build.mjs"),
  },
  {
    name: "6 win 链路的 `--postbuild` 退回**写死目录**（发布流程用 SLIME_OUT_DIR 换目录时查错路径）",
    file: PKG,
    mutate: (t) => sub(t, PKG_WIN_POST, "node ../scripts/retry-build.mjs && node ./scripts/assert-appicon.mjs --bundle release-final/win-unpacked"),
  },
  {
    name: "7 linux 链路打包后不再断言（同族：4 条链路缺一条 = 那条的包没人验收）",
    file: PKG,
    mutate: (t) => sub(t, PKG_LINUX_POST, "--publish never -c.directories.output=release-linux"),
  },

  /* ── ③ 守门会中止：判据本身不许退化 ─────────────────────────────── */
  {
    name: "8 断言器 `exit` **恒 0**（读不到也当通过 —— 假绿比假红危险）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_EXIT, "process.exit(0);"),
  },
  {
    name: "9 【事故本体】缺 `build/icon.ico` 时报 **OK**（v0.0.7 的缺陷被重新放行）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_ICO_MISS, '    ok("build/icon.ico 存在（内容没查）；")'),
  },
  {
    name: "10 新鲜度判据方向写反（把正常的判成陈货，把陈货判成正常）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_FRESH, "if (dMs > srcMs) {"),
  },
  {
    name: "11 产物断言**只查存在、不比哈希**（「拷了旧的一份」溜过去）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_HASH_CMP, "    /* 变异：产物在就行，内容不管（静默失效形态） */"),
  },
  {
    name: "12 断言器不读 `SLIME_OUT_DIR`（输出目录换名时静默查错路径）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_OUTDIR, "  const base = resolve(GUI_DIR, output);"),
  },

  /* ── ④ 配置与常量：两个产地不许漂移 ─────────────────────────────── */
  {
    name: "13 `EXPECTED_ICO_SIZES` 与生成器 `ICO_SIZES` **漂移**（生成 7 档只验收 4 档）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_SIZES, "const EXPECTED_ICO_SIZES = [16, 24, 32, 48];"),
  },
  {
    name: "14 `win.icon` 退回 1024² PNG（exe / 快捷方式 / 任务栏图标又糊）",
    file: CFG,
    mutate: (t) => sub(t, CFG_WIN_ICON, '"icon": "build/icon.png"'),
  },
  {
    name: "15 `extraFiles` 漏掉 `build/icon.ico`（随包目录里没有它 ⇒ 该 exe 图标必为默认图）",
    file: CFG,
    mutate: (t) => sub(t, CFG_EXTRA_ICO, ""),
  },
  {
    name: "16 通知图体积上限被放宽（超限的后果是**整条通知被丢弃**，不是图标小一点）",
    file: ASSERT,
    mutate: (t) => sub(t, ASSERT_NOTIFY_MAX, "const NOTIFY_MAX_BYTES = 500 * 1024;"),
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
    console.log(`FILE ${m.file}`);
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1103")) { process.exit(1); }
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
