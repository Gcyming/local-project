#!/usr/bin/env node
/**
 * gui/scripts/mut-a1101.mjs — A-1101 守卫的变异验证（后端控制台「看不懂」三层缺陷）。
 *
 * 用户原话（截图 = cmd 窗口）：「我不是发你了吗？就这个 cmd 窗口，你看看上一轮解决了吗」。
 * 那个窗口「看起来全是报错」= 三层因素叠加（⚠️ 按本机实测分层定责）：
 * ① 编码（python 写侧默认跟解释器/系统走 —— 本机已是 UTF-8，**本条是部署面加固**，非本机乱码根因）
 * ② 流向（INFO/WARNING 走 stderr 被冠成 `:err` —— **本机误读的根因**）
 * ③ 终端（cmd CP936 渲染 UTF-8 字节 —— **本机天书的根因**）。
 *
 * ## 覆盖的九条
 *
 *   1  `PYTHONUTF8: "1"` 被删（写侧退回"跟环境走" ⇒ 未开 UTF-8 模式的机器上管道变 cp936）
 *   2  `PYTHONIOENCODING` 被配成 "gbk"（与解码侧对着干 = 把口径错开钉死）
 *   3  basicConfig 的流指回 `sys.stderr`（INFO 又被冠成 :err）
 *   4  basicConfig 整块被删（root logger 走 lastResort ⇒ stderr）
 *   5  `log_config=None` 被删（uvicorn 自装 stderr handler ⇒ 启动 INFO 又标成错误）
 *   6  `import sys` 被删（stream=sys.stdout 直接 NameError，后端起不来）
 *   7  dev 脚本退回 `electron-vite dev`（终端代码页没人管）
 *   8  `chcp 65001` 被改成 `chcp 936`（切了个寂寞）
 *   9  win32 判断被删（chcp 无条件跑 —— Linux/macOS 上炸掉）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 四个目标文件本轮实测**全是 LF**，仍一律走共享模块 `sub()`（行尾无关，不赌文件将来不变）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1101.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1101.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1101.mjs --apply 3   # 只改第 3 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1101.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   set -o pipefail                      # ⚠️ 没有它，$? 取到的是 sed 的退出码（恒 0）⇒ 全部误报
 *   for n in $(seq 1 9); do
 *     node gui/scripts/mut-a1101.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     out=$(node node_modules/vitest/vitest.mjs run tests/gui/a1101-backend-console.spec.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
 *     red=$?
 *     node gui/scripts/mut-a1101.mjs --restore >/dev/null
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
const SPECS = ["tests/gui/a1101-backend-console.spec.ts"];

const F_MAIN = "gui/src/main/index.ts";
const F_SERVER = "slime_server.py";
const F_PKG = "gui/package.json";
const F_DEV = "gui/scripts/dev-utf8.mjs";
const TARGETS = [F_MAIN, F_SERVER, F_PKG, F_DEV];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1101");

/* ── 锚点：一律顶层常量 + 拼接字面量（`check-mut-anchors.mjs` 的 constMap 才能解析） ── */

/* ── ① 编码配对（main/index.ts，LF） ── */
/** 两个变量各占一行（含前导换行 —— 删除要连行删，不留空行） */
const PYUTF8_LINE = "\n    PYTHONUTF8: \"1\",";
/** 整行（含值）—— 用于把 utf-8 换成 gbk */
const PYIO_LINE = "    PYTHONIOENCODING: \"utf-8\",";

/* ── ② 流向（slime_server.py，LF） ── */
/** basicConfig 的流参数（单行、唯一） */
const STREAM_ARG = "stream=sys.stdout";
/** basicConfig 整块（两行 —— 删掉它 = root logger 回 lastResort/stderr） */
const BASICCONFIG_BLOCK =
  "logging.basicConfig(level=logging.INFO, stream=sys.stdout,\n"
  + "                    format=\"%(levelname)s:%(name)s:%(message)s\")\n";
/** uvicorn 的收尾（log_config=None 在其中；退回旧形态 = INFO 回 stderr） */
const UVICORN_TAIL = ", access_log=False, log_config=None)";
/** import 三连（删 sys ⇒ stream=sys.stdout 变 NameError） */
const IMPORT_SYS =
  "import asyncio\n"
  + "import sys\n"
  + "import logging";

/* ── ③ dev 终端（package.json / dev-utf8.mjs，LF） ── */
/** package.json 的 dev 行（4 空格缩进） */
const DEV_SCRIPT_LINE = "    \"dev\": \"node ./scripts/dev-utf8.mjs\",";
/** chcp 的目标代码页 */
const CHCP_ARG = "spawnSync(\"chcp\", [\"65001\"]";
/** win32 判断（删除 ⇒ 无条件 chcp，Linux/macOS 炸） */
const IS_WIN_LINE = "const isWin = platform() === \"win32\";";

const MUTATIONS = [
  /* ── ① 编码配对 ─────────────────────────────────────────────────── */
  {
    name: "1 `PYTHONUTF8: \"1\"` 被删（写侧退回「跟环境走」—— 未开 UTF-8 模式的机器上管道变 cp936 ⇒ 写解错开）",
    file: F_MAIN,
    mutate: (t) => sub(t, PYUTF8_LINE, ""),
  },
  {
    name: "2 `PYTHONIOENCODING` 被配成 \"gbk\"（与 toString() 的 UTF-8 解码对着干 = 把乱码钉死）",
    file: F_MAIN,
    mutate: (t) => sub(t, PYIO_LINE, "    PYTHONIOENCODING: \"gbk\","),
  },

  /* ── ② 流向：`:err` 只许承载真正的错误 ─────────────────────────── */
  {
    name: "3 basicConfig 的流指回 `sys.stderr`（INFO/WARNING 又被 GUI 冠成 :err）",
    file: F_SERVER,
    mutate: (t) => sub(t, STREAM_ARG, "stream=sys.stderr"),
  },
  {
    name: "4 basicConfig 整块被删（root logger 走 lastResort ⇒ stderr，且 WARNING 级以下直接蒸发）",
    file: F_SERVER,
    mutate: (t) => sub(t, BASICCONFIG_BLOCK, ""),
  },
  {
    name: "5 `log_config=None` 被删（uvicorn 自装 stderr handler ⇒「启动完成」又被标成错误）",
    file: F_SERVER,
    mutate: (t) => sub(t, UVICORN_TAIL, ")"),
  },
  {
    name: "6 `import sys` 被删（stream=sys.stdout 变 NameError ⇒ 后端起不来）",
    file: F_SERVER,
    mutate: (t) => sub(t, IMPORT_SYS, "import asyncio\nimport logging"),
  },

  /* ── ③ dev 终端 ─────────────────────────────────────────────────── */
  {
    name: "7 dev 脚本退回 `electron-vite dev`（终端代码页没人管 ⇒ 主进程中文日志天书）",
    file: F_PKG,
    mutate: (t) => sub(t, DEV_SCRIPT_LINE, "    \"dev\": \"electron-vite dev\","),
  },
  {
    name: "8 `chcp 65001` 被改成 `chcp 936`（切了个寂寞 —— 守卫必须认得出目标代码页）",
    file: F_DEV,
    mutate: (t) => sub(t, CHCP_ARG, "spawnSync(\"chcp\", [\"936\"]"),
  },
  {
    name: "9 win32 判断被删（无条件 chcp ⇒ Linux/macOS 上 dev 直接炸）",
    file: F_DEV,
    mutate: (t) => sub(t, IS_WIN_LINE, "const isWin = true; /* 变异：平台判断被删 */"),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1101")) { process.exit(1); }
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
