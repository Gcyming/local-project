#!/usr/bin/env node
/**
 * gui/scripts/mut-a1123.mjs — A-1123（屏幕控制提到「业界优秀」）的变异验证。
 *
 * 每条变异都要证明"守卫真的锁住了那件事"。这里锁的**不是函数返回值**，而是
 * 「用户/模型看到的那句话」和「有没有按下第二次」——两类都是**静默类**缺陷：
 * 不报错、不崩溃，只是让回执与真实后果不一致：
 *
 *   controller.ts（命中校验 / 元素定位 / 目标枚举）
 *     1  未命中不重试（判据本体失效：点空了也不补一次）
 *     2  「没有判据」被标成「未命中」（用户被误导成"点了没生效"）
 *     3  「没有判据」**仍按未命中处理**（把一次成功的点击再点一遍 = 多余的双击）
 *     4  关掉复截时不出声（"没校验"与"校验通过"又同形）
 *     5  mouse_move / wait 也纳入校验（画面本就不该变 ⇒ 造假未命中）
 *     6  阈值降为 0（噪声即命中，校验恒真 = 等于没校验）
 *     7  参考图走 `this.capture`（污染坐标基准 ⇒ 下一次动作整体偏移）
 *     8  参考图不关标注（比较的是"叠了编号框的图"，差异率虚高）
 *     9  去掉「能比较才拍图」的闸门（每次点击白拍一张；并打红既有的"复截恰好一次"判据）
 *    10  整条命中校验不接上（verify 字段永远缺席）
 *    11  校验入口放行 mouse_move / wait（绕过 VERIFY_ACTIONS 白名单）
 *    12  uiDump 抛错吞成成功（导出故障 vs 界面没元素 又同形）
 *    13  后端未注册折成「没有元素」（业务态吃掉故障态）
 *    14  定位失败与导出故障同形（模型去改 selector，而坏的是宿主）
 *    15  定位失败不报「已导出多少元素」（模型无从判断该不该下滑/翻页）
 *    16  listTargetsReport 吞掉失败原因（静默点之二）
 *   optimize.ts（"没有判据"的唯一出口）
 *    17  没有度量时返 0（把"没判据"读成"没变化"）
 *    18  不归一化（NaN 直通 ⇒ 阈值比较恒假）
 *   core-ts/src/tools/builtin.ts（用户/模型真正看到的那一层）
 *    19  回执不插命中校验（detail 与「效果已发生」又同形）
 *    20  「未判定」说成「未命中」
 *    21  未命中不给可操作的下一步（模型只会重复同一坐标）
 *    22  screen_info 不列失败原因
 *    23  screen_info 把「有失败」当成「无可用目标」
 *    24  screen_ui_dump 把导出故障说成业务态（模型去修一个并不存在的问题）
 *   core-ts/src/screen/backends/desktop.ts（窗口级元素源与编号框：两个坐标空间）
 *    25  编号框不减虚拟桌面原点（副屏在左/上时框画到图外）
 *    26  uiDump 给窗口左上角而不是中心（点它 ≠ 把窗口带到前台）
 *   gui/src/main/index.ts（装配层的三态判据）
 *    27  尺寸不一致返 0（把「不可比」读成「没变化」）
 *    28  解码失败返 1（把「不可比」读成「巨大变化」= 恒命中）
 *
 * 用法：--list / --apply N / --restore / --specs N / 全量。
 * 本环境禁止 node→node 孙进程 ⇒ 全量跑不了，用 shell 循环（见 a1115 / a1116 / a1122 同款）：
 *
 *   for i in $(seq 1 28); do
 *     node gui/scripts/mut-a1123.mjs --apply $i || break
 *     npx vitest run --config vitest.config.ts $(node gui/scripts/mut-a1123.mjs --specs $i) --reporter=dot > /tmp/m$i.txt 2>&1
 *     echo "M$i exit=$?"; grep -aE 'Tests +[0-9]' /tmp/m$i.txt
 *     node gui/scripts/mut-a1123.mjs --restore
 *   done
 *
 * ⚠️ `--specs $i` 别省（也别手写 spec 名）：M9 的守卫在**另一个文件**（`screen.spec.ts`），
 *   手写就会漏掉它 ⇒ **假存活**（见 a1115 §3.1 的教训）。spec 清单由变异自己声明。
 * ⚠️ 判据 = `exit≠0` **且**输出里真有 `Tests N` 汇总行（没有汇总行 = 测量工具本身坏了）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** A-1123 的主守卫（命中校验 / 元素定位 / 措辞 / 装配点） */
const SPEC_VERIFY = "tests/core-ts/a1123-screen-verify.spec.ts";
/** 存量屏幕守卫：M9（去掉闸门会让"动作后复截恰好一次"变成两次）会打红它 —— 跨文件，别漏 */
const SPEC_SCREEN = "tests/core-ts/screen.spec.ts";

const F_CTL = "core-ts/src/screen/controller.ts";
const F_OPT = "core-ts/src/screen/optimize.ts";
const F_DESK = "core-ts/src/screen/backends/desktop.ts";
const F_BUILTIN = "core-ts/src/tools/builtin.ts";
const F_MAIN = "gui/src/main/index.ts";

const TARGETS = [F_CTL, F_OPT, F_DESK, F_BUILTIN, F_MAIN];
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1123");

const MUTATIONS = [
  // ── controller.ts：命中校验（判据本体） ────────────────────────────────
  {
    name: "1 未命中不重试（判据本体失效）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "const attemptsMax: number = VERIFY_MAX_ATTEMPTS;",
      "const attemptsMax: number = 1;"),
  },
  {
    name: "2 「没有判据」被标成「未命中」",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      const v: ActionVerify = { hit: true, ratio: null, attempts: 1, note: why };",
      "      const v: ActionVerify = { hit: false, ratio: null, attempts: 1, note: why };"),
  },
  {
    name: "3 「没有判据」仍按未命中处理（把一次成功的点击再点一遍）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "    if (ratio === null) {", "    if (false) {"),
  },
  {
    name: "4 关掉复截时不出声（「没校验」与「校验通过」同形）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, 'note: "已关闭动作后复截，本次不做命中校验"', 'note: "命中校验通过"'),
  },
  {
    name: "5 mouse_move / wait 也纳入校验（画面本就不该变 ⇒ 造假未命中）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, '  "tap", "key", "type", "scroll", "drag", "swipe",\n]);',
      '  "tap", "key", "type", "scroll", "drag", "swipe",\n  "mouse_move", "wait",\n]);'),
  },
  {
    name: "6 阈值降为 0（噪声即命中，校验恒真）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "const VERIFY_MIN_RATIO = 0.002;", "const VERIFY_MIN_RATIO = 0;"),
  },

  // ── controller.ts：参考图（命中校验的数据源） ───────────────────────────
  {
    name: "7 参考图走 this.capture（污染坐标基准 ⇒ 下一次动作整体偏移）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "const b0 = await backend.capture(target, { marks: false });",
      "const b0 = await this.capture(id, target);"),
  },
  {
    name: "8 参考图不关标注（比较的是叠了编号框的图，差异率虚高）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "const b0 = await backend.capture(target, { marks: false });",
      "const b0 = await backend.capture(target);"),
  },
  {
    name: "9 去掉「能比较才拍图」的闸门（白拍一张 + 打红既有的复截计数判据）",
    file: F_CTL, specs: [SPEC_VERIFY, SPEC_SCREEN],
    mutate: (t) => sub(t, "const wantVerify = kindVerifiable && this.autoCapture && differReady;",
      "const wantVerify = kindVerifiable && this.autoCapture;"),
  },
  {
    name: "10 整条命中校验不接上（verify 字段永远缺席）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      result = await this.verifyFeedback(result, beforePng, injectOnce);",
      "      void beforePng;"),
  },
  {
    name: "11 校验入口放行 mouse_move / wait（绕过 VERIFY_ACTIONS 白名单）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "    if (result.ok && kindVerifiable) {", "    if (result.ok) {"),
  },

  // ── controller.ts：元素定位与目标枚举的静默点 ──────────────────────────
  {
    name: "12 uiDump 抛错吞成成功（导出故障与「界面没元素」同形）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      return { ok: false, elements: [], error: e instanceof Error ? e.message : String(e) };",
      "      return { ok: true, elements: [] };"),
  },
  {
    name: "13 后端未注册折成「没有元素」（故障态被业务态吃掉）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "    if (!b) { return { ok: false, elements: [], error: `图形控制后端 '${id}' 未注册` }; }",
      "    if (!b) { return { ok: true, elements: [] }; }"),
  },
  {
    name: "14 定位失败与导出故障同形（模型去改 selector，而坏的是宿主）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "元素层级导出失败（不是 selector 的问题：后端没能给出元素树）",
      "元素定位失败（已导出元素但没有匹配项）"),
  },
  {
    name: "15 定位失败不报「已导出多少元素」（模型无从判断该不该下滑/翻页）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "——已导出 ${dump.elements.length} 个元素但没有匹配项", "——没有匹配项"),
  },
  {
    name: "16 listTargetsReport 吞掉失败原因（静默点之二）",
    file: F_CTL, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "        failures.push({ backend: bid, error: e instanceof Error ? e.message : String(e) });",
      "        void e;"),
  },

  // ── optimize.ts：差异度量（"没有判据"的唯一出口） ───────────────────────
  {
    name: "17 imageDiffRatio：没有度量时返 0（把「没判据」读成「没变化」）",
    file: F_OPT, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "  const fn = differ;\n  if (!fn) { return null; }", "  const fn = differ;\n  if (!fn) { return 0; }"),
  },
  {
    name: "18 imageDiffRatio：不归一化（NaN 直通 ⇒ 阈值比较恒假）",
    file: F_OPT, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "    if (r === null || r === undefined || !Number.isFinite(r)) { return null; }",
      "    if (r === null || r === undefined) { return null; }"),
  },

  // ── builtin.ts：用户/模型真正看到的那一层 ──────────────────────────────
  {
    name: "19 回执不插命中校验（detail 与「效果已发生」又同形）",
    file: F_BUILTIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      if (r.verify) { parts.push(describeVerify(r.verify)); }", "      void r.verify;"),
  },
  {
    name: "20 describeVerify：「未判定」说成「未命中」",
    file: F_BUILTIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "    return `命中校验：未判定（${v.note}）`;", "    return `命中校验：✗ 未命中（${v.note}）`;"),
  },
  {
    name: "21 未命中不给可操作的下一步（模型只会重复同一坐标）",
    file: F_BUILTIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "请重新 screen_capture 看清当前画面再决定下一步，不要盲目重复同一坐标。",
      "请再试一次同样的坐标。"),
  },
  {
    name: "22 screen_info 不列失败原因",
    file: F_BUILTIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "          lines.push(`- ${f.backend}：枚举失败（${f.error}）——这是后端/宿主的问题，不是「没有目标」`);",
      "          void f;"),
  },
  {
    name: "23 screen_info 把「有失败」当成「无可用目标」",
    file: F_BUILTIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "          if (rep.failures.length === 0) { lines.push(`- ${b}：无可用目标`); }",
      "          lines.push(`- ${b}：无可用目标`);"),
  },
  {
    name: "24 screen_ui_dump 把导出故障说成业务态（模型去修一个并不存在的问题）",
    file: F_BUILTIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t,
      '        return `[错误] 元素层级导出失败（${dump.error ?? "未知原因"}）——这是后端/宿主的故障，不是「界面没有元素」。请检查设备连接/宿主是否存活后重试；其间可用 screen_capture 网格刻度目测定位。`;',
      '        return `[提示] 元素层级已导出成功，但当前界面没有可操作元素（全屏画布/游戏/页面仍在加载都会这样）。`;'),
  },

  // ── desktop.ts：窗口级元素源与编号框（两个坐标空间） ────────────────────
  {
    name: "25 桌面编号框不减虚拟桌面原点（副屏在左/上时框画到图外）",
    file: F_DESK, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "            x1: w.x - originX, y1: w.y - originY,", "            x1: w.x, y1: w.y,"),
  },
  {
    name: "26 桌面 uiDump 给窗口左上角而不是中心（点它 ≠ 把窗口带到前台）",
    file: F_DESK, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      center: { x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height / 2) },",
      "      center: { x: w.x, y: w.y },"),
  },

  // ── gui/src/main/index.ts：装配层的三态判据 ────────────────────────────
  {
    name: "27 装配层尺寸不一致返 0（把「不可比」读成「没变化」）",
    file: F_MAIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      if (sa.width !== sb.width || sa.height !== sb.height) { return 1; }",
      "      if (sa.width !== sb.width || sa.height !== sb.height) { return 0; }"),
  },
  {
    name: "28 装配层解码失败返 1（把「不可比」读成「巨大变化」= 恒命中）",
    file: F_MAIN, specs: [SPEC_VERIFY],
    mutate: (t) => sub(t, "      if (ia.isEmpty() || ib.isEmpty()) { return null; }",
      "      if (ia.isEmpty() || ib.isEmpty()) { return 1; }"),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** 跑一组 spec（`specs` 由变异自己声明 —— **唯一出处**，别在 shell 里手写） */
function runSpecs(specs) {
  const r = spawnSync(process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...specs, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1200) }; }
  return { ok: r.status === 0, spawnBlocked: false };
}

const specsOf = (m) => (m.specs && m.specs.length ? m.specs : [SPEC_VERIFY]);

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--specs") ? "specs"
    : argv.includes("--restore") ? "restore"
      : argv.includes("--apply") ? "apply" : "full";

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

/** 打印第 i 条变异该跑的守卫文件（shell 循环用） */
if (mode === "specs") {
  const idx = Number(argv[argv.indexOf("--specs") + 1]);
  const m = MUTATIONS[idx - 1];
  if (!m) { console.error(`--specs 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
  console.log(specsOf(m).join(" "));
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮变异还没还原（manifest 还在）—— 先 --restore。"); process.exit(1);
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(abs(man.file), readFileSync(join(SAVE_DIR, `${basename(man.file)}.orig`)));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

const originals = new Map(TARGETS.map((t) => [t, readFileSync(abs(t), "utf8")]));
const hashes = new Map(TARGETS.map((t) => [t, hash(abs(t))]));
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

const base = runSpecs([SPEC_VERIFY, SPEC_SCREEN]);
if (base.spawnBlocked) { console.error("本环境禁止 node→node 孙进程，请用 --apply/--restore + shell 循环。"); process.exit(1); }
if (base.measurementFailed) { console.error("⚠️ 测量工具本身坏了（无 Tests 汇总行）。"); console.error(base.out); process.exit(1); }
if (!base.ok) { console.error("基线未通过。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) { console.error("行尾检测器自检失败："); for (const b of probe) { console.error(`  - ${b}`); } process.exit(1); }
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1123")) { process.exit(1); }
console.log("行尾自检通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = abs(m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) { console.error(`⚠️  ${m.name}\n    锚点未命中`); missed.push(m.name); continue; }
    writeFileSync(path, next);
    const res = runSpecs(specsOf(m));
    writeFileSync(path, src);
    if (res.measurementFailed) { console.error("⚠️ 测量工具本身坏了，中止。"); console.error(res.out); missed.push(m.name); break; }
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restoreAll(); }

const dirty = [...hashes.entries()].filter(([t, h]) => hash(abs(t)) !== h);
if (dirty.length > 0) { console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`); process.exit(1); }
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
const leftovers = existsSync(SAVE_DIR) ? readdirSync(SAVE_DIR) : [];
if (leftovers.length > 0) { console.error(`\n⚠️ 临时目录没清干净：${SAVE_DIR}`); process.exit(1); }
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) { console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`); process.exit(1); }
