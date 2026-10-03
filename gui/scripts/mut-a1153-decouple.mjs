#!/usr/bin/env node
/**
 * gui/scripts/mut-a1153-decouple.mjs — A-1153 守卫的变异验证。
 *
 * 本轮修的是「浮层铺满 ↔ 右栏宽度状态」的**互相污染**，以及围绕它的三个独立缺陷。
 * 它由**多个独立产地**共同造成，去掉任何一个都不算修好（这正是变异要逐条证明的）：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | ① 污染 | `handleToggleFloat` 又去 `setRightCustom(true)` | 点一次窗口化后右栏永久失去比例自适应 |
 * | ① 污染 | `handleToggleFloat` 又去 `setRightWidth(innerWidth)` | 退出浮层后右栏停在整窗宽 ⇒ 挤压主区 |
 * | ① 污染 | `dismissFloat` 又去"归还"右栏宽度 | 归还依赖异步动画回调 ⇒ 时好时坏 |
 * | ② 形状 | 落 state 前不判 `!isFloatExpand` | 铺满宽度又被写进持久 state |
 * | ② 形状 | 不写 / 漏摘 `--right-target-w` | 过渡没有宽度对象（硬跳）／残值污染下次展开 |
 * | ② 形状 | CSS 给 `var(--right-target-w)` 加 fallback | 普通展开误用兜底值 ⇒ 静默回归 |
 * | ③ 抖动 | `handleToggleFloat` 又调第二次 `animateRightSidebar` | 第二次 cancel 第一次、只停表不复位样式 ⇒ 抽搐 |
 * | ④ 跟手 | 拖动第一帧不挂 `slime-dragging` | 拖动头 140ms 仍走 0.5s 宽度过渡 ⇒ 手在前、面板在后 |
 * | ④ 跟手 | `endChatFreeze` 不摘 `slime-dragging` | 过渡永久为 none ⇒ 之后所有侧栏动画硬跳 |
 * | ④ 跟手 | CSS 规则改掉（不再 `transition: none`） | 同上 |
 * | ⑤ 闪烁 | 删掉 `.chat-scroll` 的**常驻**过渡 | 摘 `slime-fading` 时声明一起消失 ⇒ 0→1 硬跳 |
 * | ⑤ 闪烁 | 兜底定时器改回**递归调自己** | 每 200ms 永久摘类 ⇒ 与淡出互相踩 |
 *
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险（_mut-eol 提供）。
 * ⚠️ 锚点用 `sub()`（行尾无关）—— 本仓行尾是混的，裸 `\n` 多行锚点会静默失效。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1153-decouple.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1153-decouple.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1153-decouple.mjs --restore   # 按 manifest 逐字节还原
 *   全量（本环境禁 node→node 孙进程）：
 *     bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1153-decouple.mjs \
 *       tests/core-ts/a1153-float-sidebar-decouple.spec.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/a1153-float-sidebar-decouple.spec.ts"];

const F_APP = "gui/src/renderer/App.tsx";
const F_CSS = "gui/src/renderer/index.css";
const TARGETS = [F_APP, F_CSS];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1153");

const MUTATIONS = [
  /* ── ① 污染：浮层铺满又去改持久状态 ─────────────────────────────── */
  {
    name: "1 handleToggleFloat 又 setRightCustom(true)（右栏永久失去比例自适应）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    if (!rightOpen) { setRightOpen(true); }",
      "    if (!rightOpen) { setRightOpen(true); }\n    setRightCustom(true);",
    ),
  },
  {
    name: "2 handleToggleFloat 又 setRightWidth(innerWidth)（退出后右栏挤爆主区）",
    file: F_APP,
    /* ⚠️⚠️ A-1155 同步锚点：原锚 `animateRightSidebar(true, Math.max(560, window.innerWidth))`
       已不存在 —— A-1155 把目标宽改成 `floatTargetW`（= innerWidth − 左栏实宽）
       并显式传 `isFloat=true`，那一行的字面形状整个变了。
       ⇒ 按新形状重锚：**在唤出调用之前插入 `setRightWidth(innerWidth)`**
         （这正是本变异要复现的缺陷：浮层铺满污染 `rightWidth` 持久状态）。 */
    mutate: (t) => sub(
      t,
      "    animateRightSidebar(true, floatTargetW, true);",
      "    setRightWidth(window.innerWidth);\n    animateRightSidebar(true, floatTargetW, true);",
    ),
  },
  {
    name: "3 dismissFloat 又去归还右栏宽度（归还依赖异步动画回调 ⇒ 时好时坏）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      const targetRight = rightWidthRef.current;",
      "      setRightWidth(rightWidthRef.current);\n      const targetRight = rightWidthRef.current;",
    ),
  },

  /* ── ② 形状：过渡期目标变量的写/读/摘 ───────────────────────────── */
  {
    name: "4 落 state 前不判 !isFloatExpand（铺满宽度又被写进持久 state）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      if (nextWidth !== undefined && !isFloatExpand) { setRightWidth(nextWidth); }",
      "      if (nextWidth !== undefined) { setRightWidth(nextWidth); }",
    ),
  },
  {
    name: "5 不再写 --right-target-w（过渡期没有宽度对象 ⇒ 硬跳）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '      if (el && isFloatExpand) { el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`); }',
      "      if (el && isFloatExpand) { /* 变异：不写过渡目标宽 */ }",
    ),
  },
  {
    /* ⚠️ 用 `subAll`（整组）而不是 `sub`：清理点有 3 处（展开 done / 收起 done / 取消路径），
       只删一处时计数仍 ≥2、断言照样绿 ⇒ 变异"存活"但其实是**变异点不完整**（铁律 9/30）。
       替换体保持语法合法（改成 `-DISABLED` 后缀而不是删行）——否则文件编译不过，
       batch 会判成"异常"而不是"被抓住"。 */
    name: "6 全部漏摘 --right-target-w（残值污染下一次展开）",
    file: F_APP,
    mutate: (t) => subAll(
      t,
      'removeProperty("--right-target-w")',
      'removeProperty("--right-target-w-DISABLED")',
    ),
  },
  {
    name: "7 CSS 给 var(--right-target-w) 加 fallback（普通展开误用兜底值）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  width: var(--right-target-w);",
      "  width: var(--right-target-w, 100%);",
    ),
  },

  /* ── ③ 抖动：第二次动画 ─────────────────────────────────────────── */
  {
    name: "8 handleToggleFloat 又调第二次 animateRightSidebar（抽搐抖动）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    if (!rightOpen) { setRightOpen(true); }",
      "    if (!rightOpen) { setRightOpen(true); animateRightSidebar(true); }",
    ),
  },

  /* ── ④ 跟手：拖动期禁过渡 ───────────────────────────────────────── */
  {
    name: "9 拖动第一帧不再挂 slime-dragging（拖动头 140ms 不跟手）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    document.body.classList.add("slime-dragging");',
      "    /* 变异：不挂 slime-dragging */",
    ),
  },
  {
    name: "10 endChatFreeze 不摘 slime-dragging（过渡永久 none ⇒ 之后都硬跳）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    document.body.classList.remove("slime-dragging");',
      "    /* 变异：不摘 slime-dragging */",
    ),
  },
  {
    name: "11 CSS 的 slime-dragging 规则不再禁宽度过渡",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "body.slime-dragging .sidebar,\nbody.slime-dragging .right-sidebar {\n  transition: none;\n}",
      "body.slime-dragging .sidebar,\nbody.slime-dragging .right-sidebar {\n  transition: width 0.2s;\n}",
    ),
  },

  /* ── ⑤ 闪烁：常驻过渡 + 兜底定时器不许递归 ─────────────────────── */
  {
    name: "12 删掉 .chat-scroll 的常驻过渡（摘类时 0→1 硬跳 = 闪烁）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      ".chat-scroll {\n  transition: opacity 0.12s linear;\n}\nbody.slime-fading .chat-scroll {",
      ".chat-scroll {\n}\nbody.slime-fading .chat-scroll {",
    ),
  },
  {
    name: "13 兜底定时器改回递归调自己（每 200ms 永久摘类 = 闪烁）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    window.clearTimeout(chatFreezeFallbackRef.current);\n    chatFreezeFallbackRef.current = window.setTimeout(() => {\n      document.body.classList.remove("slime-fading");\n    }, 200);',
      '    window.setTimeout(() => {\n      endChatFreeze();\n    }, 200);',
    ),
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
    let next;
    try { next = m.mutate(text); }
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}
    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1153")) { process.exit(1); }
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
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
