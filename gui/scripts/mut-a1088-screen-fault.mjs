#!/usr/bin/env node
/**
 * gui/scripts/mut-a1088-screen-fault.mjs — A-1088 续（`screen_focus` 的「空结果 vs 真故障」分态）的变异验证。
 *
 * ## 本轮修的缺陷
 *
 * A-1088 已经把 `screen_windows` 那条链分开（`desktop.ts` 三态 / `controller.listWindows`
 * 不吞异常 / 工具层措辞分开），但**紧挨着的 `screen_focus` 漏了**：
 *
 *   `controller.focusWindow` 旧实现 `catch (e) { return { focused:false, detail: … } }`
 *   把两种完全不同的情形压成**同一个形状**（都只有 `focused:false`，没有可区分的标记）：
 *     · 「未找到标题匹配的窗口」「没抢到前台」—— 后端**正常返回**，业务态，有替代路径；
 *     · 「宿主崩溃 / 启动超时 / 从未启动」—— 后端**抛错**，真故障，怎么绕都不会成功。
 *   工具层只能看 `focused` ⇒ 对**真故障**也回「[未获得前台] …」并附
 *   「可直接 screen_capture 传 window 试试区域截图」⇒ 模型把它当成**焦点限制**去绕，
 *   **永远不会去报告那个已经死掉的宿主**。
 *
 * ## 覆盖的七条（每条都写「下一个人顺手就会写回去、而且全都不报错」的样子）
 *
 *   1  controller.focusWindow 加回 catch（真故障被吞成业务态）        → A1 红
 *   2  删掉「后端不支持」分支（不支持 ⇒ TypeError 抛 ⇒ 业务态变故障）  → A3 红
 *   3  改**过头**：把业务态 `focused:false` 也抛（未找到窗口被说成故障）→ A2 红
 *   4  工具层把 `[错误]` 改写成 `[未获得前台]`（真故障被说成焦点限制）  → B1 红
 *   5  controller.listWindows 加回 `catch { return []; }`（A-1088 正身）→ A4 红
 *   6  screen_windows 空结果改成 `[错误]` 措辞（把"真没窗口"说成故障）  → B3 红
 *   7  desktop.listWindows 三态判据退化（`candidates > 0` → `>= 0`）    → C4 红
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照 / 还原一律走**字节**（Buffer）；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 标的是三个**行尾不同**的文件（controller.ts=Lf / builtin.ts=CRLF / desktop.ts=LF）
 *   ⇒ 一律走共享模块的 `sub()`，绝不手写 `includes/replace`。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1088-screen-fault.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1088-screen-fault.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1088-screen-fault.mjs --apply 3   # 只改第 3 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1088-screen-fault.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 `EBUSY`）
 *
 *   ```bash
 *   SPEC="tests/core-ts/a1088-screen-fault.spec.ts"
 *   for n in $(seq 1 7); do
 *     node gui/scripts/mut-a1088-screen-fault.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     if node node_modules/vitest/vitest.mjs run "$SPEC" >/dev/null 2>&1; then echo "❌ M$n 未被捕获"; else echo "✅ M$n 被捕获"; fi
 *     node gui/scripts/mut-a1088-screen-fault.mjs --restore >/dev/null
 *   done
 *   ```
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 本轮守卫只有一份（三条链路的判据都在这）—— 但**行为级与源码级混在同一文件**，
 *  所以每条变异都能被它捕获（不像 A-1090 那样分散在五份）。 */
const SPECS = ["tests/core-ts/a1088-screen-fault.spec.ts"];

const F_CTL = "core-ts/src/screen/controller.ts";
const F_TOOL = "core-ts/src/tools/builtin.ts";
const F_DESK = "core-ts/src/screen/backends/desktop.ts";
const TARGETS = [F_CTL, F_TOOL, F_DESK];

/** `--apply` 模式下存放逐字节备份与 manifest 的临时目录（`--restore` 后整目录删除） */
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1088-screen");

const MUTATIONS = [
  /* ── ① controller.focusWindow 的三种退化 ───────────────────────────── */
  {
    name: "1 focusWindow 加回 catch（真故障被吞成业务态 ⇒ 模型把它当焦点限制去绕）",
    file: F_CTL,
    mutate: (t) => sub(
      t,
      "    return await b.focusWindow(title);",
      "    try { return await b.focusWindow(title); } catch (e) { return { focused: false, detail: e instanceof Error ? e.message : String(e) }; }",
    ),
  },
  {
    name: "2 删掉「后端不支持」分支（不支持 ⇒ 调用 undefined ⇒ 业务态被报成故障）",
    file: F_CTL,
    mutate: (t) => sub(
      t,
      "    if (!b?.focusWindow) { return { focused: false, detail: `${id} 后端不支持窗口聚焦` }; }\n",
      "",
    ),
  },
  {
    name: "3 改过头：业务态 focused:false 也抛（「未找到窗口」被说成宿主故障）",
    file: F_CTL,
    mutate: (t) => sub(
      t,
      "    return await b.focusWindow(title);",
      "    const fr = await b.focusWindow(title);\n    if (!fr.focused) { throw new Error(fr.detail); }\n    return fr;",
    ),
  },

  /* ── ② 工具层措辞：真故障不许说成焦点限制 ─────────────────────────── */
  {
    /* ⚠️ 锚点必须带上一行 `[已聚焦]` 的返回 —— 本文件里
       `catch (e) { return \`[错误] ${e instanceof Error ? e.message : String(e)}\`; }`
       这个形状在 screenFocus / screenWindows / adb 截图 等处**出现多次**，
       只取 catch 那两行会命中第一处（不是这里），变异就改错了对象而没人知道（假绿）。 */
    name: "4 工具层把真故障的 [错误] 改写成 [未获得前台]（并附上「试试区域截图」的误导建议）",
    file: F_TOOL,
    mutate: (t) => sub(
      t,
      "      return `[已聚焦] ${r.detail} ${rect}\\n提示：接着 screen_capture 看图（网格刻度）→ screen_action 点击。`;\n    } catch (e) {\n      return `[错误] ${e instanceof Error ? e.message : String(e)}`;",
      "      return `[已聚焦] ${r.detail} ${rect}\\n提示：接着 screen_capture 看图（网格刻度）→ screen_action 点击。`;\n    } catch (e) {\n      return `[未获得前台] ${e instanceof Error ? e.message : String(e)}`;",
    ),
  },

  /* ── ③ A-1088 正身（一并锁住，防回退） ────────────────────────────── */
  {
    name: "5 listWindows 加回 catch（旧实现：异常吞成空数组 ⇒ 故障与真没窗口同态）",
    file: F_CTL,
    mutate: (t) => sub(
      t,
      "    return await b.listWindows();",
      "    try { return await b.listWindows(); } catch { return []; }",
    ),
  },
  {
    name: "6 screen_windows 空结果改成 [错误] 措辞（把「本机真没窗口」说成枚举故障）",
    file: F_TOOL,
    mutate: (t) => sub(
      t,
      '"[提示] 枚举成功：当前**没有**可见的顶层窗口（可能都已最小化或无标题）。这不是故障。"',
      '"[错误] 枚举失败：没有可见的顶层窗口。"',
    ),
  },
  {
    name: "7 desktop 三态判据退化（candidates > 0 → >= 0 ⇒ 空结果的分支永远进不去）",
    file: F_DESK,
    mutate: (t) => sub(t, "      if (candidates > 0) {", "      if (candidates >= 0) {"),
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

/* ── `--apply` / `--restore`：给"禁止 node→node 孙进程"的环境留的两半 ── */
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
    console.log(`  file=${m.file}  备份=${join(SAVE_DIR, `${basename(m.file)}.orig`)}`);
    process.exit(0);
  }
  /* restore */
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
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿。 */
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1088-screen")) { process.exit(1); }
console.log("行尾自检通过（检测器 + 锚点行尾均无问题）\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本 —— 用 gui/scripts/check-mut-anchors.mjs 查）`);
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
