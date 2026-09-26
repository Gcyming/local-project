/**
 * A-1075 变异测试（Issue 5）：「任务栏/托盘图标」逐环改坏要求守卫变红。
 *
 * 覆盖 `tests/core-ts/a1075-app-icon.spec.ts`。根因（一手证据）：`build/icon.png` 是
 * **1024×1024 / 951.7 KB**，却被喂给托盘（渲染 16 px）、任务栏（24/32/48 px）与 exe 图标
 * ⇒ 让系统把一张 1024² 位图现场缩到十几像素。修法：生成 `build/icon.ico`（逐尺寸预置）+
 * 托盘与窗口走**同一个** `resolveAppIcon()`。
 *
 * A 组：**资产本身**（ICO 头 / 尺寸覆盖 / 16px 那张的大小）——这是**二进制**变异，
 *      按 §19 用 `Buffer` 快照 / 还原 / 独立哈希校验，绝不走文本往返。
 * B 组：生成器（ICO 那一步真的在生成脚本里，且生成后有自验收）
 * C 组：接线（唯一出处 / 平台分支 / 读不出来要回落并出声 / 两处都走它）
 * D 组：打包配置（win 用 ico、linux 仍用 png、ico 随包）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 * ⚠️ 别写「诱饵」变异（保留被锁字串只加条件）—— 守卫按文本读，字串还在就照样绿。
 *
 * 用法：node gui/scripts/mut-a1075-appicon.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1075-app-icon.spec.ts";
const MAIN = "gui/src/main/index.ts";
const CFG = "gui/electron-builder.json";
const MAKER = "gui/scripts/make-notify-icon.mjs";
/* ⚠️ 二进制资产：只能字节级处理，绝不进 `sub` / utf8 往返（§19）。 */
const ICO = "gui/build/icon.ico";
const TARGETS = [MAIN, CFG, MAKER];

const MUTATIONS = [
  // ── B 生成器 ──────────────────────────────────────────────────────────────
  {
    name: "B1 ICO 尺寸清单被删（生成器不再预置多尺寸 ⇒ 资产靠手工塞，换图标就漂移）",
    file: MAKER,
    mutate: (t) => sub(t, "const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];\n", ""),
  },
  {
    name: "B2 ICO 组装函数被删（没有唯一实现）",
    file: MAKER,
    mutate: (t) => sub(t, "function buildIco(entries) {", "function buildIcoRemoved(entries) {"),
  },
  {
    name: "B3 ICO 生成后不再自验收（不合格也当成功 —— 静默产出一张废图标）",
    file: MAKER,
    mutate: (t) => sub(t, "  console.error(`ICO 生成失败：${icoProblems.join(\"；\")}`);", "  console.error(`（自验收已移除）`);"),
  },

  // ── C 接线 ────────────────────────────────────────────────────────────────
  {
    name: "C1 托盘退回直接写 1024² PNG 的路径（两处各写一份 ⇒ 改一处只对一半）",
    file: MAIN,
    mutate: (t) => sub(t, "    const iconPath = resolveAppIcon();", '    const iconPath = join(INSTALL_ROOT, "build", "icon.png");'),
  },
  {
    name: "C2 任务栏（窗口）图标退回写死 PNG（「托盘对了任务栏还是糊的」这类半修）",
    file: MAIN,
    /* 迁移（2026-09-24 复核实测）：窗口图标从 `icon: resolveAppIcon()` 升级成
       `icon: resolveAppIconImage()`（后者内部才去按平台取 ico/png 并解码成 NativeImage，
       见 `ref-ui`「图标尺寸口径」）。原锚点已不存在 ⇒ 守卫静默失效。
       忠实等价变异：让 `resolveAppIconImage` **绕过平台分支、直接读 png**
       （= 任务栏拿到的是小尺寸 png，糊）—— 与"退回写死 PNG"意图一致，且不破坏类型。 */
    mutate: (t) => sub(t, "  const p = resolveAppIcon();", '  const p = join(INSTALL_ROOT, "build", "icon.png");'),
  },
  {
    name: "C3 去掉平台分支（Linux/macOS 也去读 .ico ⇒ 得到空图）",
    file: MAIN,
    mutate: (t) => sub(t, 'process.platform === "win32" ? "icon.ico" : "icon.png"', '"icon.ico"'),
  },
  {
    name: "C4 图标读不出来时不回落（换格式失败 = 托盘图标静默空白）",
    file: MAIN,
    mutate: (t) => sub(t, "    if (!nativeImage.createFromPath(preferred).isEmpty()) { return preferred; }", "    return preferred;"),
  },
  {
    name: "C5 回落时不出声（静默失败：没人知道图标换了地方还没生效）",
    file: MAIN,
    mutate: (t) => sub(t, "  console.warn(`[gui:main] 应用图标 ${preferred} 读不出来，回落 ${fallback}`);", "  void fallback;"),
  },

  // ── D 打包配置 ────────────────────────────────────────────────────────────
  {
    name: "D1 win.icon 退回 1024² PNG（exe / 快捷方式图标又糊）",
    file: CFG,
    mutate: (t) => sub(t, '    "icon": "build/icon.ico"\n  },', '    "icon": "build/icon.png"\n  },'),
  },
  {
    name: "D2 Linux 被一起改成 .ico（那边根本读不了 ⇒ Linux 版图标全没）",
    file: CFG,
    mutate: (t) => sub(t, '    "icon": "build/icon.png",', '    "icon": "build/icon.ico",'),
  },
  {
    name: "D3 extraFiles 漏掉 icon.ico（打包版 INSTALL_ROOT/build 下没有它）",
    file: CFG,
    mutate: (t) => sub(t, '    { "from": "build/icon.ico", "to": "build/icon.ico" },\n', ""),
  },
];

/** 二进制变异：入参/出参都是 Buffer，只做字节级改写。 */
const BIN_MUTATIONS = [
  {
    name: "A1 ICO 头 type 改成 0（不是图标 ⇒ 系统当无效文件）",
    buf: (b) => { const c = Buffer.from(b); c.writeUInt16LE(0, 2); return c; },
  },
  {
    name: "A2 删掉 16×16 那一条（托盘只能自己缩 256² ⇒ 又回到「糊」）",
    buf: (b) => {
      const c = Buffer.from(b);
      const n = c.readUInt16LE(4);
      c.writeUInt16LE(n - 1, 4);
      /* 目录条目前移一位（各条目自带 imageOffset，故只需挪条目本身） */
      b.copy(c, 6, 6 + 16, 6 + 16 * n);
      return c;
    },
  },
  {
    name: "A3 16×16 那条的字节数被写大（编码参数错了，托盘要读几十 KB）",
    buf: (b) => { const c = Buffer.from(b); c.writeUInt32LE(9000, 6 + 8); return c; },
  },
];

const hashBuf = (buf) => createHash("sha256").update(buf).digest("hex");
const hash = (p) => hashBuf(readFileSync(p));

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(join(ROOT, t))]));
/* 二进制资产：**Buffer** 快照 + 独立哈希基准（§19：文本往返会碾碎二进制，且自比对会假绿）。 */
const icoOriginal = readFileSync(join(ROOT, ICO));
const icoHash = hashBuf(icoOriginal);
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 不给这道保险，变异会留在源码里，
   下一次跑脚本就会把「变异后的源码」当基线 → 整批变异静默假绿（2026-09-23 实测踩到）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);
const restoreIco = () => writeFileSync(join(ROOT, ICO), icoOriginal);
process.on("SIGINT", () => { restoreIco(); process.exit(130); });
process.on("SIGTERM", () => { restoreIco(); process.exit(130); });

if (!runSpec()) {
  console.error("基线未通过 —— 先修好测试再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1075-appicon")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of [SPEC, "gui/scripts/mut-a1075-appicon.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(join(ROOT, rel), "utf8"));
  if (bad.length) {
    console.error(`引号自伤自检失败（${rel}）：`);
    for (const b of bad) { console.error(`  - ${b}`); }
    process.exit(1);
  }
}
console.log("行尾检测器自检 + 引号自伤自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    writeFileSync(path, src);
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
  for (const m of BIN_MUTATIONS) {
    const path = join(ROOT, ICO);
    const next = m.buf(icoOriginal);
    if (next.equals(icoOriginal)) {
      console.error(`⚠️  ${m.name}\n    字节变异未生效（脚本自身写错）`);
      missed.push(m.name);
      continue;
    }
    writeFileSync(path, next);
    const green = runSpec();
    restoreIco();
    if (green) {
      console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`);
      missed.push(m.name);
    } else {
      console.log(`✅ ${m.name}`);
      caught += 1;
    }
  }
} finally {
  restoreAll();
  restoreIco();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
/* 二进制单独复核：**独立基准**是变异前算的那个哈希（不是"再读一次做自比对"）。 */
if (hashBuf(readFileSync(join(ROOT, ICO))) !== icoHash) {
  console.error(`\n⚠️ 还原失败：${ICO} 的字节哈希与变异前不一致`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文本文件 + ${ICO} 字节哈希一致）`);

const total = MUTATIONS.length + BIN_MUTATIONS.length;
console.log(`\n变异捕获 ${caught}/${total}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
