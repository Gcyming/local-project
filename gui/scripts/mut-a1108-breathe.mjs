#!/usr/bin/env node
/**
 * gui/scripts/mut-a1108-breathe.mjs — A-1108「执行中」呼吸灯守卫的变异验证。
 *
 * 修的是「频闪观感」。用户原话：「执行中做了动画很好，但是是频闪效果看起来怪怪的，用呼吸灯特效吧」。
 *
 * 病根（探针 `gui/scripts/_probe-breathe.cjs` 实测，不是推断）：原关键帧动的是 `background` 简写
 * 展开出来的 10 条 longhand ⇒ **每帧主线程重绘**；流式期间主线程每帧都在解析 markdown + 重渲染
 * ⇒ 重绘帧被不规律推迟 ⇒ 动画走时忽快忽慢（这就是"频闪"）。叠加 1.1s 短周期 + 0.08 浅幅度。
 * 修法 = 光晕搬到 `::before`（**静态**）、关键帧**只动 opacity**（合成器属性）、周期 2.4s。
 * A-1109 再改一次：用户说「为什么这个执行中的文本不闪，只有后面的文本框闪？二者应该绑定、
 * 同步闪动」⇒ 动画**从 `::before` 搬回胶囊自身**（文字与底色同元素 = 天然同频），幅度 0.55→1。
 *
 * ## 覆盖的条目（每条都在问：动了哪一条判据会**静默退化**）
 *
 *   1      拿掉胶囊自身的呼吸动画（只剩底色层动 ⇒ 用户抱怨的「字不闪只有框闪」复发）
 *   2      去掉 `isolation: isolate`（`z-index:-1` 落到按钮背景之下 ⇒ 光晕整个看不见）
 *   3      主规则底色改回不透明（与光晕叠成双份）
 *   4      `::before` 的 `inset: 0` 改成 `-6px`（溢出盒子 ⇒ 被祖先 `overflow:hidden` 裁掉）
 *   5      去掉 `border-radius: inherit`（呼吸时四角露出方角）
 *   6      去掉 `z-index: -1`（光晕盖在文字上，字被糊掉）
 *   7      `::before` 底色改成**全透明**（静态层空转 ⇒ reduced-motion 下胶囊失去底色 = 空白框格）
 *   8      关键帧加回 `background-color`（每帧重绘 ⇒ 频闪真根因回归）
 *   9      周期 2.4s → 0.8s（快而浅 = 抖）
 *  10      峰值 1 → 0.92（幅度不够，看不出在呼吸）
 *  11      reduced-motion 覆盖改回打在 `::before` 上（动画已搬回主规则、覆盖没跟着 ⇒ 无障碍回退静默失效）
 *  12      `::before` 加 `box-shadow` 光晕（画出盒子外 ⇒ 被祖先 `overflow:hidden` 裁掉右半边）
 *  13      主规则文字色改成 `transparent`（A-1094「文字全透明 = 空白框格」重演）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 多行锚点一律走 `sub`（行尾无关）。`index.css` 实测是 **LF**，但换行尾的那天也不该静默失效。
 * ⚠️ **判据 = exit≠0 且输出里真有 `Tests` 汇总行**（否则「配置加载失败」会被误当「变异被捕获」）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1108-breathe.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1108-breathe.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1108-breathe.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1108-breathe.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/gui/a1108-breathe.spec.ts",
];

const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_CSS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1108-breathe");

/* 主规则里 `isolation:` 与 `color:` 相邻两行 —— 实测在 index.css 里**唯一**（`color: var(--accent)`
   单独出现 12 次，所以锚点必须带上 `isolation: isolate;` 这一行才唯一）。 */
const MAIN_HEAD = "  isolation: isolate;\n  color: var(--accent);";
const BEFORE_HEAD = "  position: absolute;\n  inset: 0;\n  z-index: -1;";
/* ⚠️ A-1109：呼吸动画搬回**主规则**后，它成了该规则体的**最后一条声明**（后随 `}`）——
   末尾带 `\n}` 才既能唯一命中、又能整行摘除（拿掉动画 = 用户抱怨的「字不闪」复发）。 */
const MAIN_ANIM_END = "  animation: slime-status-breathe 2.4s ease-in-out infinite;\n}";
/* ⚠️ 谷值随 A-1109 从 0.25 抬到 0.55（文字的**最暗不透明度** = 可读性下界）。 */
const KEYFRAMES = "  0%, 100% { opacity: 0.55; }\n  50% { opacity: 1; }";
/* `::before` 的静态底色 —— 唯一（`--accent) 30%` 只此一处）。 */
const BEFORE_BG = "  background-color: color-mix(in srgb, var(--accent) 30%, transparent);";
/* ⚠️ 主规则里那条「透明底色」：`background-color: transparent;` 在本文件出现 **2 次**
   （`.text-scan-light` 也有一处），故锚点必须带上后面那行 A-1109 块头才唯一
   —— 是**内容锚点**（非装饰性空白），编辑到它时"未命中"报错正是我们要的行为。 */
const MAIN_BG = "  background-color: transparent;\n  /* ══ A-1109：呼吸动画";
/* reduced-motion 覆盖 —— A-1109 起它必须打在主规则上（动画已搬回主规则）。 */
const RM_RULE = '  .think-tool-status[data-running="1"],\n  .think-tool-status[data-settled="1"] { animation: none; }';

const MUTATIONS = [
  {
    name: "1 拿掉胶囊自身的呼吸动画（只剩底色层在动 ⇒ 用户抱怨的「执行中的文本不闪，只有后面的文本框闪」复发）",
    file: F_CSS,
    mutate: (t) => sub(t, MAIN_ANIM_END, "}"),
  },
  {
    name: "2 去掉 `isolation: isolate`（`z-index:-1` 落到按钮背景之下 ⇒ 光晕整个看不见）",
    file: F_CSS,
    mutate: (t) => sub(t, MAIN_HEAD, "  color: var(--accent);"),
  },
  {
    name: "3 主规则底色改回不透明（与光晕叠成双份）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      MAIN_BG,
      "  background-color: color-mix(in srgb, var(--accent) 12%, transparent);\n  /* ══ A-1109：呼吸动画",
    ),
  },
  {
    name: "4 `inset: 0` → `inset: -6px`（溢出盒子 ⇒ 被祖先 overflow:hidden 裁掉）",
    file: F_CSS,
    mutate: (t) => sub(t, BEFORE_HEAD, "  position: absolute;\n  inset: -6px;\n  z-index: -1;"),
  },
  {
    name: "5 去掉 `border-radius: inherit`（呼吸时四角露出方角）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  z-index: -1;\n  border-radius: inherit;",
      "  z-index: -1;\n  border-radius: 0;",
    ),
  },
  {
    name: "6 去掉 `z-index: -1`（光晕盖在文字上，字被糊掉）",
    file: F_CSS,
    mutate: (t) => sub(t, BEFORE_HEAD, "  position: absolute;\n  inset: 0;"),
  },
  {
    name: "7 `::before` 底色改成**全透明**（静态层空转 ⇒ reduced-motion 下胶囊失去底色 = 空白框格）",
    file: F_CSS,
    mutate: (t) => sub(t, BEFORE_BG, "  background-color: transparent;"),
  },
  {
    name: "8 关键帧加回 `background-color`（每帧重绘 ⇒ 频闪真根因回归）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      KEYFRAMES,
      "  0%, 100% { opacity: 0.55; background-color: color-mix(in srgb, var(--accent) 10%, transparent); }\n"
      + "  50% { opacity: 1; background-color: color-mix(in srgb, var(--accent) 28%, transparent); }",
    ),
  },
  {
    name: "9 周期 2.4s → 0.8s（快而浅的脉动 = 抖）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  animation: slime-status-breathe 2.4s ease-in-out infinite;",
      "  animation: slime-status-breathe 0.8s ease-in-out infinite;",
    ),
  },
  {
    name: "10 峰值 1 → 0.92（幅度不够，看不出在呼吸）",
    file: F_CSS,
    mutate: (t) => sub(t, "  50% { opacity: 1; }", "  50% { opacity: 0.92; }"),
  },
  {
    name: "11 reduced-motion 覆盖改回打在 `::before` 上（动画已搬回主规则、覆盖没跟着 ⇒ 无障碍回退静默失效）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      RM_RULE,
      '  .think-tool-status[data-running="1"]::before,\n  .think-tool-status[data-settled="1"] { animation: none; }',
    ),
  },
  {
    name: "12 `::before` 加 `box-shadow` 光晕（画出盒子外 ⇒ 被祖先 overflow:hidden 裁掉右半边）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      BEFORE_BG,
      BEFORE_BG + "\n  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent);",
    ),
  },
  {
    name: "13 主规则文字色改成 `transparent`（A-1094「文字全透明 = 空白框格」重演）",
    file: F_CSS,
    mutate: (t) => sub(t, MAIN_HEAD, "  isolation: isolate;\n  color: transparent;"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * 跑一份 spec，返回 `{ ok }` / `{ measurementFailed, out }` / `{ spawnBlocked }`。
 * ⚠️ 判据不能只看 exit code：vitest 启动失败也返回非 0，那样「变异」会被报成「全被捕获」。
 */
function runSpecs() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
    const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (!/\bTests\s+\d+/.test(out)) {
      return { ok: false, measurementFailed: true, spec, out: out.slice(-1500) };
    }
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
if (base.measurementFailed) {
  console.error(`⚠️ 测量工具本身坏了（${base.spec} 的输出里没有 Tests 汇总行）—— 判据不成立，先修工具。`);
  console.error(base.out);
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1108-breathe")) { process.exit(1); }
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
    if (res.measurementFailed) {
      console.error(`⚠️  测量工具本身坏了（${res.spec} 输出无 Tests 汇总行），本轮判据不成立，中止。`);
      console.error(res.out);
      missed.push(m.name);
      break;
    }
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
