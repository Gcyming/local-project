#!/usr/bin/env node
/**
 * gui/scripts/mut-a1110.mjs — A-1110（CDP 端口选择与发布）守卫的变异验证。
 *
 * 修的是：`pnpm dev` 的调试面板里那两条英文报错 ——
 *   `ERROR:tcp_socket_win.cc(458)] bind() returned an error: …(0x2740)`
 *   `ERROR:devtools_http_handler.cc(313)] Cannot start http server for devtools.`
 * 根因：端口**硬编码 9222**，而 Chromium 的 devtools http server **不会自己换端口** ⇒
 * 一旦被占就 bind 失败、**整套 CDP 能力静默消失**（verify-packaged / agent-browser 全哑）。
 *
 * ## 覆盖的条目
 *
 *   1      `parseListeningPorts` 去掉监听标记过滤（**对端端口**被当成占用 ⇒ 反向静默失效）
 *   2      端口下界 `>= 1` → `>= 0`（对端列的 `0` 被当成被占用的端口）
 *   3      `preferred === 0` 直通被删（用户显式要「随便给一个」却给了 9223）
 *   4      顺延基数写成默认常量（忽略 env 指定的端口 ⇒ 给了用户没要过的端口）
 *          ⚠️ 本条是**替换**来的：原条目「`i = 1` → `i = 0`」实跑为**等价变异体**（见条目内注释）
 *   5      窗口全占时回落 `preferred`（旧毛病复发：拿着被占的端口去 bind）
 *   6      越界 `break` 被删（候选越过 65535 仍返回 ⇒ 把非法端口交给 Chromium）
 *   7      env 校验放宽（`abc` / `99999` / `1.5` 被当成端口用）
 *   8      `parseDevToolsActivePort` 把 `0` 当有效端口
 *   9      `readDevtoolsPortFile` 把 `0` 当有效端口
 *   10     `writeDevtoolsPortFile` 忽略 `actualPort`（临时端口时落盘记的是请求值 0）
 *   11     index.ts 硬编码 `"9222"` 回归（用户截图里那两条报错的直接产地）
 *   12     `app.isPackaged` 判定被写死 false（**正式包也开放 CDP** ⇒ 安全回归）
 *   13     落盘发布被删（外部工具历史上都写死 9222 ⇒ 被悄悄弄坏）
 *   14     顺延日志被删（端口会变却不出声 ⇒ 默认值不再可信而没人知道）
 *   15     `listeningPortsSync` 变成 async（结论落在 `ready` 之后 ⇒ 本次根本没开 CDP，连报错都没有）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 多行锚点一律走 `sub`（行尾无关），不要自己写裸 `\n` 拼接。
 * ⚠️ 条目号 ≠ 数组下标（`--list` 才是权威）—— 用 `--apply` 前先 `--list` 核对。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1110.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1110.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1110.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1110.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/gui/a1110-devtools-port.spec.ts",
];

const F_PORT = "gui/src/main/devtoolsPort.ts";
const F_MAIN = "gui/src/main/index.ts";
const TARGETS = [F_PORT, F_MAIN];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1110");

const MUTATIONS = [
  {
    name: "1 判定退化成「整份输出里搜 :port」（监听标记过滤被删 ⇒ 对端端口也算占用）",
    file: F_PORT,
    mutate: (t) => sub(t, "    if (!listening.test(line)) { continue; }\n", ""),
  },
  {
    name: "2 端口下界 `>= 1` → `>= 0`（对端列的 0 被当成被占用的端口）",
    file: F_PORT,
    mutate: (t) => sub(t, "if (p >= 1 && p <= 65535) { ports.add(p); }", "if (p >= 0 && p <= 65535) { ports.add(p); }"),
  },
  {
    name: "3 `preferred === 0` 直通被删（用户显式要「随便给一个」却被顺延到 9223）",
    file: F_PORT,
    mutate: (t) => sub(t, "  if (preferred === 0) { return 0; }\n", ""),
  },
  {
    /* ⚠️ 本条**替换**过一个等价变异体（真实教训，留档）：
       原条目是「顺延起点 `i = 1` → `i = 0`」，实跑**没被捕获**（`Tests 23 passed`）。
       原因不是守卫漏了，而是那个变异体**语义等价** —— 代码只在
       `listening.has(preferred) === true` 时才进循环，所以 `i = 0` 那一轮
       （`candidate === preferred`）必然被 `has` 拦下、直接 continue ⇒ 行为逐字相同。
       **等价变异体不许留着冒充守卫**（它恒绿，会把"守卫在守"变成一句空话）。
       换成真正非等价的那条：**顺延基数写成默认常量**（忽略用户显式指定的端口）。 */
    name: "4 顺延从默认 9222 起算（忽略 `SLIME_DEVTOOLS_PORT` 指定的端口 ⇒ 给了用户没要过的端口）",
    file: F_PORT,
    mutate: (t) => sub(t, "    const candidate = preferred + i;", "    const candidate = DEVTOOLS_PORT_DEFAULT + i;"),
  },
  {
    name: "5 窗口全占时回落 `preferred`（旧毛病复发：拿着被占的端口去 bind）",
    file: F_PORT,
    mutate: (t) => sub(
      t,
      "    if (!listening.has(candidate)) { return candidate; }\n  }\n  return 0;",
      "    if (!listening.has(candidate)) { return candidate; }\n  }\n  return preferred;",
    ),
  },
  {
    name: "6 越界 `break` 被删（候选越过 65535 仍返回 ⇒ 把非法端口交给 Chromium）",
    file: F_PORT,
    mutate: (t) => sub(t, "    if (candidate > 65535) { break; }\n", ""),
  },
  {
    name: "7 env 校验放宽（非整数 / 越界值被当成端口用 ⇒ NaN 或 99999 交给 Chromium）",
    file: F_PORT,
    mutate: (t) => sub(
      t,
      "if (Number.isInteger(n) && n >= 0 && n <= 65535) {",
      "if (!Number.isNaN(n)) {",
    ),
  },
  {
    /* ⚠️ 锚点必须带上前两行：`Number.isInteger(n) && n > 0 && …` 这个表达式在模块里**出现两次**
       （`parseDevToolsActivePort` 与 `readDevtoolsPortFile`，只有缩进不同）⇒ 单行锚点会被核验器
       判「不唯一」，而"报警长期红着"等于没报警。带上各自的上一行即可唯一。 */
    name: "8 `parseDevToolsActivePort` 把 0 当有效端口（调用方会以为端口是 0）",
    file: F_PORT,
    mutate: (t) => sub(
      t,
      "  const first = text.split(/\\r?\\n/)[0]?.trim() ?? \"\";\n  const n = Number(first);\n  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;",
      "  const first = text.split(/\\r?\\n/)[0]?.trim() ?? \"\";\n  const n = Number(first);\n  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;",
    ),
  },
  {
    name: "9 `readDevtoolsPortFile` 把 0 当有效端口（读回一个假的 CDP 端口）",
    file: F_PORT,
    mutate: (t) => sub(
      t,
      "    const n = Number(parsed.port);\n    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;",
      "    const n = Number(parsed.port);\n    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;",
    ),
  },
  {
    name: "10 `writeDevtoolsPortFile` 忽略 `actualPort`（临时端口时落盘记的是请求值 0）",
    file: F_PORT,
    mutate: (t) => sub(t, "      port: actualPort ?? decision.port,", "      port: decision.port,"),
  },
  {
    name: "11 index.ts 硬编码 `\"9222\"` 回归（9222 被占必然 bind 失败、整套 CDP 静默消失）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      'app.commandLine.appendSwitch("remote-debugging-port", String(devtoolsDecision.port));',
      'app.commandLine.appendSwitch("remote-debugging-port", "9222");',
    ),
  },
  {
    name: "12 `app.isPackaged` 判定写死 false（**正式包也开放 CDP** ⇒ 本机任意进程可附到渲染层）",
    file: F_MAIN,
    mutate: (t) => sub(t, "  const devtoolsDecision = app.isPackaged\n", "  const devtoolsDecision = false\n"),
  },
  {
    name: "13 落盘发布被删（端口会变却不发布 ⇒ verify-packaged / agent-browser 被悄悄弄坏）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      'const file = writeDevtoolsPortFile(app.getPath("userData"), devtoolsDecision, actual);',
      "const file: string | null = null;",
    ),
  },
  {
    name: "14 顺延日志被删（端口变了却不出声 ⇒ 默认值不再可信而没人知道）",
    file: F_MAIN,
    mutate: (t) => sub(
      t,
      '      console.warn(`[gui:devtools] ${devtoolsDecision.preferred} 已被占用 → CDP 端口顺延为 ${devtoolsDecision.port}`);\n',
      "",
    ),
  },
  {
    name: "15 探针变成 async（结论落在 `ready` 之后 ⇒ 本次根本没开 CDP，连报错都没有）",
    file: F_PORT,
    mutate: (t) => sub(t, "export function listeningPortsSync(", "export async function listeningPortsSync("),
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
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1110")) { process.exit(1); }
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
