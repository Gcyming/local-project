#!/usr/bin/env node
/**
 * gui/scripts/mut-a1106b.mjs — A-1106b 守卫的变异验证。
 *
 * 修的是**用户点名的调试面板报错**：
 *   `Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Error: ERR_ABORTED (-3) loading 'data:image/png;base64,…'`（反复）
 *
 * 根因：`wv.loadURL()` 返回 Promise，失败/被下一次导航顶掉时它 **reject**；
 * Electron 内部 `navigationListener → rejectAndCleanup` 把它当**未捕获异常**打印。
 * 旧代码 `try { wv.loadURL(u); } catch {}` **接不住**异步 reject（同步 try/catch 只管同步抛）。
 *
 * 修复：新增纯模块 `gui/src/renderer/pages/webviewNav.ts`（`safeLoadURL` = **唯一安全出口**），
 * 三处产地全部改道：`RightSidebar` 的 forceNav / 300ms 安全网、`browserBridge` 的 browser_navigate。
 *
 * ## 覆盖的条目
 *
 *   1~2   安全出口本身退化（不挂 `.catch` / 直接早退成空操作）
 *   3~4   **产地回退成裸 `loadURL`**（两处独立产地各一条 —— 只堵一处会漏）
 *   5     `-3` 判定退化成魔法数字（丢掉与错误页同源的 `isBenignAbort` 口径）
 *   6     去掉同步 try/catch（未 attach 的同步抛会打穿调用方）
 *   7     去掉空值 / 无 `loadURL` 对象的保护
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 同族语句的锚点必须带**上一行上下文**（`safeLoadURL(wv, next)` 在 RightSidebar 出现两次，
 *    裸锚点不唯一 ⇒ 变异会改错产地，测出来的结论是假的）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1106b.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1106b.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1106b.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1106b.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  /* A-1106b 的守卫全部住在这一份 spec 里（行为 + 静态）。
     判据：SPECS 必须覆盖该脚本每一条变异的目标守卫所在的那份 spec，否则"未捕获"其实是"没人测"。 */
  "tests/gui/a1106b-guest-call.spec.ts",
];

const F_NAV = "gui/src/renderer/pages/webviewNav.ts";
const F_RSB = "gui/src/renderer/pages/RightSidebar.tsx";
const F_BRIDGE = "gui/src/renderer/pages/browserBridge.ts";
const TARGETS = [F_NAV, F_RSB, F_BRIDGE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1106b");

/* ── 锚点常量（唯一出处那一行；改动时同步这里） ───────────────────────────── */
/** 挂 `.catch` 的那一整块 —— 变 1/2 共用（内联到每个变异里以免 sub 跨块失配） */
const CATCH_BLOCK = [
  "  if (p && typeof (p as Promise<void>).catch === \"function\") {",
  "    void (p as Promise<void>).catch((e: unknown) => {",
  "      /* -3 = 被下一次导航顶掉，属正常；其余真失败由 did-fail-load 上错误页（唯一可见通道）。 */",
  "      if (isBenignAbort(Number((e as { errno?: number } | null | undefined)?.errno))) { return; }",
  "    });",
  "  }",
].join("\n");

/* ⚠️ RightSidebar 里 `safeLoadURL(wv, next);` 出现**两次** ⇒ 同族锚点必须带上一行上下文。 */
const RSB_SITE_FORCENAV = [
  "      if (cur === next) { return; }",
  "      /* A-1106b：换成唯一安全出口 —— 旧写法 `wv.loadURL(next)` 的异步 reject 接不住，",
  "         Electron 会把它当未捕获异常打印（调试面板反复刷 GUEST_VIEW_MANAGER_CALL / ERR_ABORTED）。 */",
  "      safeLoadURL(wv, next);",
].join("\n");
const RSB_SITE_SAFETYNET = [
  "        if (cur && cur !== \"about:blank\") { return; }",
  "        /* A-1106b：安全网每 300ms 会重发 —— 若不接住 reject，-3 会被漏成「反复刷屏」的主产地 */",
  "        safeLoadURL(wv, next);",
].join("\n");

const MUTATIONS = [
  /* ── ① 安全出口本身 ─────────────────────────────────────────────── */
  {
    name: "1 安全出口不挂 .catch（reject 照旧逃逸 —— 本模块存在的全部意义被拿掉）",
    file: F_NAV,
    mutate: (t) => sub(t, CATCH_BLOCK, "  /* 变异：直接丢弃，不接 reject */\n  void p;"),
  },
  {
    name: "2 安全出口退化成空操作（任何输入都直接 return）",
    file: F_NAV,
    mutate: (t) => sub(
      t,
      "  if (!wv || !url || typeof wv.loadURL !== \"function\") { return; }",
      "  if (!wv || !url || typeof wv.loadURL !== \"function\") { return; }\n  if (url) { return; } // 变异：永远早退",
    ),
  },
  /* ── ② 两个独立产地回退成裸调用（只堵一处会漏） ───────────────────── */
  {
    name: "3 RightSidebar 的 forceNav 回退成裸 loadURL（异步 reject 重新逃逸）",
    file: F_RSB,
    mutate: (t) => sub(t, RSB_SITE_FORCENAV, [
      "      if (cur === next) { return; }",
      "      wv.loadURL(next);",
    ].join("\n")),
  },
  {
    name: "4 RightSidebar 的 300ms 安全网回退成裸 loadURL（「反复刷屏」的主产地）",
    file: F_RSB,
    mutate: (t) => sub(t, RSB_SITE_SAFETYNET, [
      "        if (cur && cur !== \"about:blank\") { return; }",
      "        wv.loadURL(next);",
    ].join("\n")),
  },
  /* ── ③ 口径与健壮性 ─────────────────────────────────────────────── */
  {
    name: "5 -3 判定退化成魔法数字（丢掉与错误页同源的 isBenignAbort 口径）",
    file: F_NAV,
    mutate: (t) => sub(
      t,
      "      if (isBenignAbort(Number((e as { errno?: number } | null | undefined)?.errno))) { return; }",
      "      if (Number((e as { errno?: number } | null | undefined)?.errno) === -3) { return; }",
    ),
  },
  {
    name: "6 去掉同步 try/catch（未 attach 的同步抛会打穿调用方）",
    file: F_NAV,
    mutate: (t) => sub(t, [
      "  let p: unknown;",
      "  try {",
      "    p = wv.loadURL(url);",
      "  } catch {",
      "    return; // 未 attach 的**同步**抛：由 did-attach / 安全网兜底重试",
      "  }",
    ].join("\n"), "  const p: unknown = wv.loadURL(url);"),
  },
  {
    name: "7 去掉空值 / 无 loadURL 对象的保护（null 与 {} 会直接抛）",
    file: F_NAV,
    mutate: (t) => sub(
      t,
      "  if (!wv || !url || typeof wv.loadURL !== \"function\") { return; }",
      "  if (!wv) { return; }",
    ),
  },
];

/* ⚠️ 锚点自检**必须放在模式判定之后**，且只对 apply / full 生效 ——
 * 否则它会挡住 `--restore`（恢复路径！）：源码一旦处于变异态，锚点自然"未命中"，
 * 于是自检 exit 1，**还原永远跑不到**，变异就永久留在源码里（本脚本第一版实测踩到）。
 * 教训同「检测器自己会空转」家族：**恢复路径不许被任何自检阻塞**。 */

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

/* 锚点自检：只对 apply / full 生效（见文件上方说明 —— 绝不能挡 --restore）。
   ⚠️ 必须**先确认没有未还原的变异**，否则会把"变异态"误读成"源码漂移"。 */
if (mode === "apply" || mode === "full") {
  if (mode === "apply" && existsSync(join(SAVE_DIR, "manifest.json"))) {
    console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore，否则会把变异后的源码当基线。");
    process.exit(1);
  }
  for (const m of MUTATIONS) {
    const src = readFileSync(abs(m.file), "utf8");
    if (m.mutate(src) === src) {
      console.error(`❌ 锚点未命中：${m.name}（源码已漂移 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
      process.exit(1);
    }
  }
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1106b")) { process.exit(1); }
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
  console.error(`\n⚠️还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) {
  console.error(`\n⚠️临时目录没清干净：${SAVE_DIR}（${leftovers.join(", ")}）`);
  process.exit(1);
}
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
