#!/usr/bin/env node
/**
 * gui/scripts/mut-a1107.mjs — A-1107 守卫（滚动跟随手感）的变异验证。
 *
 * 修的是：**「锁定吐字最新」让用户上滚很费劲**。
 * 症状（用户原话）：「有时候用户想往上滚动很费劲，会抖动半天，有种用户想往上，
 * 但是程序不准你往上的感觉……这个功能本身没问题，但是体验有问题。」
 *
 * 病根：贴底时程序每帧写 `scrollTop = scrollHeight`，而解锁判据只有「离底 < 48px」
 * ⇒ 用户上滚的头 48px 被每帧拉回；更麻烦的是**程序拉底让 scrollTop 变大**，
 * 所以「scrollTop 在减小」这个方向信号被抵消 ⇒ 单看 scroll 事件判不出用户意图。
 * 修复：把用户意图的**主信号**换成滚轮方向（`deltaY < 0`，与 scrollTop 无关），
 * 并同步写 `atBottomRef`（贴底循环读的是 ref，晚一轮渲染 = 那一帧仍在拉底）。
 * 判据抽到 `scrollFollow.ts`（唯一出处、可行为单测）。
 *
 * ## 覆盖的条目
 *
 *   1      `onWheel` 没接到滚动容器上（用户上滚根本不会被识别）
 *   2      滚轮判据判反（`>= 0` → `<= 0`：向上不解锁、向下反而解锁）
 *   3      handleWheel 不写 `atBottomRef`（只 setState ⇒ 本帧贴底循环看不到解锁）
 *   4      handleScroll 不写 `atBottomRef`（晚一整轮渲染才生效）
 *   5      jumpToLatest 不写 `atBottomRef`（点准星后要等一帧才开始跟随）
 *   6      `decideFollow` 删掉方向支（上滚被当成「还在底部」⇒ 继续每帧拉底）
 *   7      `decideFollow` 方向判反（`<` → `>`）
 *   8      底部阈值 48 → 200（回底重锁的灵敏度退化）
 *   9      `hasInnerScroller` 丢掉 `overflowY` 检查（`overflow:visible` 的更高元素被误判）
 *   10     内层守卫极性反（`!hasInnerScroller`）
 *   11     `overflowY` 写死 `"auto"`（外层上滚永远解不了锁）
 *   12     判据出现第二产地（ChatPanel 里重新内联方向判据）
 *   14     回底胶囊回到流内（A-1112：`position: absolute` → `relative` ⇒ 「非最新→最新」再抖一次）
 *   15     浮层吃掉指针事件（A-1112：外层 `none` → `auto` ⇒ 消息区下半屏点不动、选不了词）
 *   16     胶囊恒渲染（A-1112：`!atBottom` → 恒真 ⇒ 已经贴底了还挂着「回到最新」）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 多行锚点一律走 `sub`（行尾无关），不要自己写裸 `\n` 拼接。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1107.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1107.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1107.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1107.mjs --restore   # 按 manifest 逐字节还原
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/gui/a1107-scroll-follow.spec.ts",
];

const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const F_FOLLOW = "gui/src/renderer/scrollFollow.ts";
const TARGETS = [F_PANEL, F_FOLLOW];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1107");

const MUTATIONS = [
  {
    name: "1 `onWheel` 没接到滚动容器上（用户上滚根本不会被识别 ⇒ 手感回到「被按住」）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      // ⚠️ A-1115 同步：容器类名变成 `chat-scroll rail-host`（目录卷轴接入）—— 锚点必须跟着走，
      //    否则这条变异**静默未命中**，而"未命中"= 守卫已失去保护（与"存活"同罪）。
      'onScroll={handleScroll} onWheel={handleWheel} className="chat-scroll rail-host"',
      'onScroll={handleScroll} className="chat-scroll"',
    ),
  },
  {
    /* ⚠️ A-1109 迁移：原锚点 `if (e.deltaY >= 0) { return; }` 已随实现撤掉（现在要**分别**
       处理向上/向下）。本条意图「把滚轮方向判反」保留，锚点换成新的方向分支：
       把 `> 0`（向下 ⇒ 重锁）写成不可能命中的大数 ⇒ **重锁分支永远不执行** ⇒
       跟随一旦被解掉、而视口恰在底部（gap≈0，滚轮不产生 scroll 事件）就**再也锁不回来**
       —— 这正是用户报的「不能在滚到最新吐字位置后锁定」。 */
    name: "2 向下滚的重锁分支失效（永久失锁：滚到最新了却锁不回来）",
    file: F_PANEL,
    mutate: (t) => sub(t, "if (e.deltaY > 0) {", "if (e.deltaY > 10000) {"),
  },
  {
    name: "3 handleWheel 不同步写 `atBottomRef`（本帧的贴底循环看不到解锁，照旧拉底）",
    file: F_PANEL,
    mutate: (t) => sub(t, "    atBottomRef.current = false;\n    setAtBottom(false);", "    setAtBottom(false);"),
  },
  {
    name: "4 handleScroll 不同步写 `atBottomRef`（贴底循环要等一整轮渲染才看到）",
    file: F_PANEL,
    mutate: (t) => sub(t, "      atBottomRef.current = next;\n", ""),
  },
  {
    /* ⚠️ A-1109 迁移：`atBottomRef.current = true;` 现在出现**两处**（jumpToLatest 与
       handleWheel 的「向下滚重锁」），单行锚点会「命中 2 次」无法确定改哪一处。
       锚点带上紧跟的 `setAtTop(` 收窄到 jumpToLatest 那一处。 */
    name: "5 jumpToLatest 不同步写 `atBottomRef`（点了准星却要等一帧才开始跟随）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "    atBottomRef.current = true;\n    setAtBottom(true);\n    setAtTop(",
      "    setAtBottom(true);\n    setAtTop(",
    ),
  },
  {
    /* ⚠️ A-1109 迁移：方向支已删除（它就是「重排误判」的根源），因此不再有「删掉方向支」
       这条变异。换成**同族、同意图**的一条：取消**滞回**（不动作区里一律判「不跟随」）。
       后果与「删掉方向支」同类 —— 阈值附近来回切换 ⇒ 反复上下抖动。 */
    name: "6 取消滞回（不动作区一律判不跟随 ⇒ 阈值两侧来回切换 = 反复上下抖动）",
    file: F_FOLLOW,
    mutate: (t) => sub(t, "  return m.following;\n}", "  return false;\n}"),
  },
  {
    /* 同上：方向判反已不存在；迁移为「滞回区**反向**」（不动作区里永远取反）——
       同样让状态在阈值附近来回翻转。 */
    name: "7 滞回区判反（`return m.following` → `!m.following`：中间区永远反着来 ⇒ 抖动）",
    file: F_FOLLOW,
    mutate: (t) => sub(t, "  return m.following;\n}", "  return !m.following;\n}"),
  },
  {
    /* A-1109：`BOTTOM_EPSILON_PX` 已拆成 RELEASE/RESUME 两个常量；本条锚到**解锁**阈值。 */
    name: "8 解锁阈值 48 → 200（用户滚很远了还认为「在底部」⇒ 跟随断不掉）",
    file: F_FOLLOW,
    mutate: (t) => sub(t, "export const FOLLOW_RELEASE_PX = 48;", "export const FOLLOW_RELEASE_PX = 200;"),
  },
  {
    /* A-1109：**滞回必须保持严格不等**。把重锁阈值抬到与解锁阈值同高 ⇒ 不动作区消失
       ⇒ 解锁/重锁在同一个 gap 上反复切换 = 用户看到的「抖动」。 */
    name: "9 重锁阈值抬到与解锁阈值同高 ⇒ 滞回区消失（抖动复发）",
    file: F_FOLLOW,
    mutate: (t) => sub(t, "export const FOLLOW_RESUME_PX = 8;", "export const FOLLOW_RESUME_PX = 48;"),
  },
  {
    name: "10 `hasInnerScroller` 丢掉 overflowY 检查（`overflow:visible` 的更高元素被误判成内层滚动）",
    file: F_FOLLOW,
    mutate: (t) => sub(
      t,
      '(a) => a.scrollHeight > a.clientHeight + 1 && (a.overflowY === "auto" || a.overflowY === "scroll"),',
      "(a) => a.scrollHeight > a.clientHeight + 1,",
    ),
  },
  {
    name: "11 内层守卫极性反（`!hasInnerScroller`：代码块上滚解锁外层、外层上滚反而不解锁）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "if (hasInnerScroller(ancestors)) { return; }",
      "if (!hasInnerScroller(ancestors)) { return; }",
    ),
  },
  {
    name: "12 `overflowY` 写死 `\"auto\"`（任何更高的祖先都被当成内层滚动 ⇒ 外层上滚永远解不了锁）",
    file: F_PANEL,
    mutate: (t) => sub(t, "overflowY: getComputedStyle(n).overflowY,", 'overflowY: "auto",'),
  },
  {
    /* ⚠️ A-1109 迁移：原锚点是「重新内联 `decideFollow({ top, prevTop,`」—— 那个签名已不再
       存在。本条意图「判据出现第二产地」保留，换成**把方向支重新引入**（拿上一帧 scrollTop
       比大小）—— 它正是本轮回归的成因，所以守卫⑦ 专门有一条 `not.toMatch(/prevTop/)`。 */
    name: "13 方向支回归（ChatPanel 里又拿上一帧 scrollTop 判方向 ⇒ 重排会误判成用户上翻）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      "      const top = el.scrollTop;\n",
      "      const prevTop = el.scrollTop;\n      const top = el.scrollTop;\n",
    ),
  },
  {
    /* ── A-1112：回底胶囊必须**脱离文档流** ────────────────────────────────
       用户原话：「每次从非最新滚到最新，中间界面都会抖动一次。」
       真根因：胶囊在**流内** ⇒ `{!atBottom && …}` 的翻转改变消息区高度 ⇒ 滚动容器（flex:1）
       的 `clientHeight` 变 ~+30px ⇒ 浏览器**钳**着改 `scrollTop` ⇒ 可视内容整体位移一次。
       守卫 = 本文件 SPECS 那份 spec 的 A-1112 ①（条件与 `position: absolute` 写进**同一条**
       断言：只锁其中一个都能被绕过）。 */
    name: "14 回底胶囊回到流内（`position: absolute` → `relative` ⇒ 「非最新→最新」再抖一次）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '            position: "absolute", left: 0, right: 0, bottom: 10,\n            display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 6,',
      '            position: "relative", left: 0, right: 0, bottom: 10,\n            display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 6,',
    ),
  },
  {
    name: "15 浮层吃掉指针事件（外层 `none` → `auto` ⇒ 消息区下半屏点不动、选不了词）",
    file: F_PANEL,
    mutate: (t) => sub(
      t,
      '            display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 6,',
      '            display: "flex", justifyContent: "center", pointerEvents: "auto", zIndex: 6,',
    ),
  },
  {
    name: "16 胶囊恒渲染（`!atBottom` → 恒真 ⇒ 已经贴底了还挂着一枚「回到最新」）",
    file: F_PANEL,
    mutate: (t) => sub(t, "{!atBottom && (", "{true && ("),
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1107")) { process.exit(1); }
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
