#!/usr/bin/env node
/**
 * gui/scripts/mut-a1172-leftw-collapse.mjs — A-1172 守卫的变异验证。
 *
 * ## 背景：一个变量、两个互相拉扯的不变量
 * `--left-w` 的唯一消费者是浮层稳态宽 `width: calc(100% - var(--left-w, 0px))`。
 * 它被两条**方向相反**的规则同时约束：
 *   · **A-1166**（`a1166-left-w-feedback.spec.ts`）：**不许**写实测派生值 ——
 *     否则逐帧把动画中间值写回，与 ResizeObserver 构成「观测 → 写回 → 再观测」，
 *     六处方向反转（用户实测的「抽搐」）。
 *   · **A-1172**（`a1172-leftw-collapse.spec.ts`）：**必须**反映折叠 ——
 *     否则折叠左栏后变量停在展开宽，右栏左侧空出 240px（用户报的「折叠/展开异常」）。
 * 唯一同时满足两者的形式 = 「**目标占位宽**」：`sidebarOpenRef.current ? sidebarWidthRef.current : 0`。
 * ⇒ 变异必须**两边都打**：改回裸展开宽（违反 A-1172）、改成实测（违反 A-1166）。
 *
 * | # | 变异 | 应被抓住 |
 * |---|---|---|
 * | M1 | 两处都改成裸展开宽 `sidebarWidthRef.current` | A-1172 ③（反向断言） |
 * | M2 | 两处都改成写本帧实测 `getBoundingClientRect()` | A-1172 ④ + A-1166 ① |
 * | M3 | 只改 RO `sync` 那处 → 裸展开宽 | A-1172 ②（目标占位宽少于 2 处） |
 * | M4 | 只改左栏动画 onFrame 那处 → 裸展开宽 | 同上 |
 * | M5 | 唤出路径不再写 `--left-w`（少一条产地） | A-1172 ①（写点 < 4） |
 * | M6 | 消费端 `calc(100% - var(--left-w, 0px))` 改回裸 `100%` | A-1172 ⑤ |
 *
 * ⚠️ 快照/还原一律走**字节** + manifest（sha256 校验）；
 *    `--restore` **必须无参可用**（`_run-mut-batch.sh` 就是这么调的）。
 * ⚠️ 判据 spec 清单**含 a1166** —— M1/M2 同时违反那条不变量，两份守卫都要能出声。
 *
 * 用法：
 *   node gui/scripts/mut-a1172-leftw-collapse.mjs --list
 *   node gui/scripts/mut-a1172-leftw-collapse.mjs --apply 1
 *   node gui/scripts/mut-a1172-leftw-collapse.mjs --restore
 *   全量：bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1172-leftw-collapse.mjs
 *         （不传 spec 时自动读下面的 `SPECS`）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = [
  "tests/core-ts/a1172-leftw-collapse.spec.ts",
  /* ⚠️ 必须含 a1166：M1/M2 同样违反「不许写实测」那条不变量，
     清单漏一份会让那两条**假存活**（比没有守卫更危险 —— 会让人以为守住了）。 */
  "tests/core-ts/a1166-left-w-feedback.spec.ts",
];
const F_APP = "gui/src/renderer/App.tsx";
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1172");

/* 正确形态（两处逐字相同，只在缩进上不同 —— 这正是 M3/M4 区分两处产地的依据）。 */
const SLOT_ARG = '${Math.round(sidebarOpenRef.current ? sidebarWidthRef.current : 0)}px';
/* ⚠️⚠️ 2026-10-08：M2/M3/M4 的三对锚点改成**模块级单个双引号字面量**。
 *
 * ① 为什么原来是「未核验」：`WRITE_SYNC` / `WRITE_FRAME` 原先是
 *    `'…' + SLOT_ARG + '…'` 的**拼接**形态，而 `SLOT_ARG` 本身**含 `${…}` 插值**
 *    ⇒ `check-mut-anchors.mjs` 的 `constMap` 走 `readConcat` 时要求每段都是
 *    **纯字面量**，插值段解析不出来 ⇒ `from` 解析失败 ⇒ 报「未核验」。
 *    按铁律「没人核验 = 没有保护」，M2/M3/M4 三条的保护强度是 0，
 *    且比「未命中」更隐蔽（未命中会响，未核验是静默的）。
 *
 * ② 顺带修掉一个**真缺陷**：`WRITE_SYNC`（6 空格缩进）在 `App.tsx` 里**命中 2 次** ——
 *    另一处是 10 缩进的 `WRITE_FRAME` 那一行，它**包含**前者（子串）。
 *    ⇒ `sub` 只改第一处（恰好是本条目标，方向对），但核验器只能报「不唯一」
 *      ⇒ 又是一条没人核验的守卫。⇒ 现在给两处各带一段**上文/下文**收窄到唯一
 *      （已实测：两个新锚点各命中 1 次）。
 *
 * ③ 变异语义**完全没变**：仍是把两处（或其中一处）改成写本帧实测宽 / 裸展开宽。
 *    ⚠️ 六个常量各自是**单个**字面量、**不许 `+` 拼接**（拼接 ⇒ constMap 解析失败
 *      ⇒ 又变未核验，实测）。它们都逐字节取自当前源码，改源码形状时必须重新抄。
 *    ⚠️ `${…}` 在**双引号**字面量里不是插值（那是模板字面量的语法），
 *      所以这些锚点不需要转义 `$`，也不会被模板规则吃掉。 */
/** RO `sync` 处的写入（**带下文** `const ro = new ResizeObserver(sync);` 收窄到唯一）。 */
const A1172_WRITE_SYNC = "      rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(sidebarOpenRef.current ? sidebarWidthRef.current : 0)}px`);\n    };\n    const ro = new ResizeObserver(sync);";
/** 左栏动画 `onFrame` 处的写入（**带下文** 收尾两行，本就唯一）。 */
const A1172_WRITE_FRAME = "          rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(sidebarOpenRef.current ? sidebarWidthRef.current : 0)}px`);\n        }\n      },";
/* M2 的两个目标：两处都改写**本帧实测宽**（RO 用 `el`、动画 onFrame 用 `node` ——
   两处实测对象不同，所以不能用一个 subAll）。 */
const A1172_SYNC_MEASURED = "      rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(el.getBoundingClientRect().width)}px`);\n    };\n    const ro = new ResizeObserver(sync);";
const A1172_FRAME_MEASURED = "          rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(node.getBoundingClientRect().width)}px`);\n        }\n      },";
/* M3 / M4 的目标：各自那一个产地改回**裸展开宽**。 */
const A1172_SYNC_BARE = "      rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(sidebarWidthRef.current)}px`);\n    };\n    const ro = new ResizeObserver(sync);";
const A1172_FRAME_BARE = "          rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(sidebarWidthRef.current)}px`);\n        }\n      },";
const BARE_ARG = '${Math.round(sidebarWidthRef.current)}px';

const MUTATIONS = [
  {
    name: "M1 两处都改回裸展开宽（折叠后不归零 ⇒ 左侧留白 240px）",
    file: F_APP,
    /* ⚠️ `all: true` = 显式声明「整组替换」（计数闸门形态）。
       本条的锚点（`SLOT_ARG`）在两处产地各出现一次，`subAll` 会**全改** ——
       这正是它要测的（"两处必须同源"，走神一处就红）。
       `check-mut-anchors.mjs` 见到 `all: true` 才会把"命中多次"当**预期**而不是歧义。 */
    all: true,
    mutate: (t) => subAll(t, SLOT_ARG, BARE_ARG),
  },
  {
    name: "M2 两处都改成写本帧实测宽（逐帧闭环 ⇒ 六处方向反转）",
    file: F_APP,
    /* ⚠️ 2026-10-08：两侧改成字面量常量 + 补显式的 from 字段（见上方常量区注释）。
       两处的实测表达式不同（RO 用 `el`、动画 onFrame 用 `node`）⇒ 仍是两次 sub，不能用 subAll。 */
    from: A1172_WRITE_SYNC,
    to: A1172_SYNC_MEASURED,
    mutate: (t) => {
      let x = sub(t, A1172_WRITE_SYNC, A1172_SYNC_MEASURED);
      x = sub(x, A1172_WRITE_FRAME, A1172_FRAME_MEASURED);
      return x;
    },
  },
  {
    name: "M3 只改 RO `sync` 那处 → 裸展开宽（产地只剩 1 处正确）",
    file: F_APP,
    /* ⚠️ 2026-10-08：同 M2（字面量常量 + 显式的 from 字段）。 */
    from: A1172_WRITE_SYNC,
    to: A1172_SYNC_BARE,
    mutate: (t) => sub(t, A1172_WRITE_SYNC, A1172_SYNC_BARE),
  },
  {
    name: "M4 只改左栏动画 onFrame 那处 → 裸展开宽（产地只剩 1 处正确）",
    file: F_APP,
    /* ⚠️ 2026-10-08：同 M2（字面量常量 + 显式的 from 字段）。 */
    from: A1172_WRITE_FRAME,
    to: A1172_FRAME_BARE,
    mutate: (t) => sub(t, A1172_WRITE_FRAME, A1172_FRAME_BARE),
  },
  {
    name: "M5 唤出路径（`handleToggleFloat`）不再写 `--left-w`（少一条产地）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'if (rwFloat) { rwFloat.style.setProperty("--left-w", `${Math.round(leftWNow)}px`); }',
      "if (rwFloat) { /* 变异：唤出不写 --left-w */ }",
    ),
  },
  {
    name: "M6 消费端 `calc(100% - var(--left-w, 0px))` 改回裸 `100%`（浮层越窗/留白复发）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'width: (mainIsFloatLayout && !rightMin0) ? "calc(100% - var(--left-w, 0px))"',
      'width: (mainIsFloatLayout && !rightMin0) ? "100%"',
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpecs() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  if (r.status !== 0) { return { ok: false, spawnBlocked: false }; }
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
    /* ⚠️ `sub` 抛异常（锚点漂移）时必须清掉备份目录：否则留下一个没有 manifest 的
       `.orig`，下次 `--apply` 不会被拦（它只查 manifest）⇒ 备份被覆盖 ⇒ 原件丢失。 */
    let next;
    try { next = m.mutate(text); }
    catch (e) { console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`); rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1); }
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

/* ── full 模式 ── */
const originals = readFileSync(abs(F_APP));
const originalHash = hash(abs(F_APP));
const restore = () => { writeFileSync(abs(F_APP), originals); };
process.on("SIGINT", () => { restore(); process.exit(1); });
process.on("SIGTERM", () => { restore(); process.exit(1); });

const base = runSpecs();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 请用 --apply/--restore + shell 循环。");
  process.exit(1);
}
if (!base.ok) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

let caught = 0; const missed = [];
try {
  for (const m of MUTATIONS) {
    const src = originals.toString("utf8");
    let next;
    try { next = m.mutate(src); }
    catch (e) { console.error(`⚠️  ${m.name}\n    锚点未命中：${e.message}`); missed.push(m.name); continue; }
    writeFileSync(abs(F_APP), next);
    const res = runSpecs();
    restore();
    if (res.ok) { console.error(`❌ ${m.name}\n    变异后守卫仍绿 —— 这条守卫没锁住它。`); missed.push(m.name); }
    else { console.log(`✅ ${m.name}`); caught += 1; }
  }
} finally { restore(); }

if (hash(abs(F_APP)) !== originalHash) { console.error("\n⚠️ 还原失败（源文件已改动）"); process.exit(1); }
console.log(`\n还原校验通过`);
console.log(`\n捕获 ${caught}/${MUTATIONS.length}`);
for (const n of missed) { console.error(`未捕获：${n}`); }
process.exit(missed.length ? 1 : 0);
