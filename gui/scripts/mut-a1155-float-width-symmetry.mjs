#!/usr/bin/env node
/**
 * gui/scripts/mut-a1155-float-width-symmetry.mjs — A-1155 守卫的变异验证。
 *
 * 本轮用**真 App CDP 端到端取证**（`probe-a1155-cdp.mjs`，连真主进程 + 真 IPC + 真会话）
 * 抓到 4 条 A-1152/1153/1154 全都没覆盖的根因 —— 它们**只在"退出浮层 / 窗口变化 /
 * 左栏折叠"这几条非主路径**上出现。每条都要证明「改坏 ⇒ 守卫变红」，否则守卫是假的（铁律 3）。
 *
 * | # | 变异点 | 用户现象 | 真机证据（修复前） |
 * |---|---|---|---|
 * | M1 | `dismissFloat` 起点不摘 `rightMin0` | ① 右栏内容自适应失效 | 全程 `rwAnim=true` |
 * | M2 | `dismissFloat` 起点不摘 `--right-body-pin` | ④ 内容冲出窗口 | `rb.r=1487 > vw=1332` |
 * | M3 | `dismissFloat` 起点不摘 `--right-target-w` | 过渡目标宽残留 | `tgtW=1332px` 挂到稳态 |
 * | M4 | `dismissFloat` 的 done 少一次摘除（只剩起点那次） | 别的路径写回时无人兜 | 时序赌博 |
 * | M5 | `animateRightSidebar` 入口不摘 `rightMin0` / 两个变量 | 上一次 done 被 cancel ⇒ 永久残留 | 切页/连点后仍残留 |
 * | M6 | 浮层稳态宽改回裸 `"100%"` | ④ 右栏右缘越窗 240px | `rw.r=1572 > vw=1332` |
 * | M7 | 非浮层态不回落 `"auto"`（改 undefined） | 普通展开被内联宽污染 | — |
 * | M8 | 唤出路径不传 `isFloat=true` | 浮层被误判成普通展开 | 阈值只剩 26px 余量 |
 * | M9 | `isFloatExpand` 不优先用显式入参（只留阈值） | 同上（左栏一变宽就判假） | — |
 * | M10 | `--left-w` 写点删掉（唤出路径） | 浮层稳态宽算不出来 = 越窗 | 见 M6 |
 * | M11 | `--left-w` 摘点删掉（退浮层） | 脏变量跟到后续布局 | 写/摘不成对 |
 * | M12 | `--left-w` 摘点删掉（普通展开入口） | 同上 | 写/摘不成对 |
 * | M13 | `animateLeftSidebar` 不同步 `--left-w` | 折左栏后右栏不补宽 / 展开后越窗 | 见 M6 |
 * | M14 | `GEOM_SYNC_HARD_LIMIT_FRAMES` 从 done 判据里删掉 | 结构性死锁 ⇒ 类永久残留 | `rs.w=287` ≠ 1332 |
 * | M15 | `frameCount` 不递增（上界成死代码） | 同上 | — |
 * | M16 | `dismissFloat` 不清 `.right-sidebar` 内联宽 | 内联 287px 残留（静默地雷） | `rsInlineW="287px"` |
 *
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256；带 SIGINT 保险（`_mut-eol` 提供）。
 * ⚠️ 锚点用 `sub()`（行尾无关）—— 本仓行尾是混的，裸 `\n` 多行锚点会静默失效。
 * ⚠️ 变异体必须**保持语法合法**（要"停用"某声明就改值/加后缀，别删行）——
 *    否则 batch 会把"编译不过"算成"抓住了"。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1155-float-width-symmetry.mjs --list
 *   node gui/scripts/mut-a1155-float-width-symmetry.mjs --apply 3
 *   node gui/scripts/mut-a1155-float-width-symmetry.mjs --restore
 *   全量（本环境禁 node→node 孙进程）：
 *     bash gui/scripts/_run-mut-batch.sh gui/scripts/mut-a1155-float-width-symmetry.mjs \
 *       tests/core-ts/a1155-float-width-symmetry.spec.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/* ⚠️⚠️ A-1157-R2：守卫清单必须**包含 a1152**。
   退场相关的断言（`right-wrapper-exit` 成对性、"先清残值再挂类"的顺序）落在
   `a1152-float-stability.spec.ts` 里 —— 本脚本原先只跑 a1155 自己那份，
   于是 M18/M19 实测"存活"，而手动把 a1152 一起跑就是红的：
     `--apply 19` + 只跑 a1155 ⇒ 绿；`--apply 19` + 跑 a1152 ⇒ 红 2 条。
   ⇒ 这正是"变异脚本的守卫清单必须与实际断言同源"的一条：清单漏一份，
      变异就"存活"却不报错，比没有守卫更危险（它会让人误以为守住了）。 */
const SPECS = [
  "tests/core-ts/a1155-float-width-symmetry.spec.ts",
  "tests/core-ts/a1152-float-stability.spec.ts",
];

const F_APP = "gui/src/renderer/App.tsx";
const TARGETS = [F_APP];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1155");

/* ── 供 mutate 复用的锚点片段（**逐字**取自源码，改源码必须同步改这里） ── */

/* dismissFloat 的起点清理块（三条摘除 + setRightMin0）
   ⚠️⚠️ A-1157-R2 同步锚点：退场起点被重排过（"先量/清残值 → 挂 exit 类 → 摘变量"），
     锚点必须跟着改，否则 `sub()` 找不到 ⇒ **变异静默失效**（实测 M1/M2/M4 三条一起
     "锚点未命中"，而脚本只报"存活 3"，很容易被当成"守卫不够严"而去加错的断言）。 */
const D_EXIT_BLOCK = [
  "    const rwExit = rwExitPre;",
  "    if (rwExit) {",
  '      rwExit.style.removeProperty("--right-body-pin");',
  '      rwExit.style.removeProperty("--right-target-w");',
].join("\n");

/* animateRightSidebar 的入口清理块 */
const A_ENTRY_BLOCK = [
  "    setRightMin0(false);",
  "    const rwReset = rightWrapperRef.current;",
  "    if (rwReset) {",
  '      rwReset.style.removeProperty("--right-body-pin");',
  '      rwReset.style.removeProperty("--right-target-w");',
].join("\n");

/* 浮层稳态宽的 JSX 三元 */
const FLOAT_W = 'width: (mainIsFloatLayout && !rightMin0) ? "calc(100% - var(--left-w, 0px))"\n              : (mainIsFloatLayout ? "var(--right-target-w)" : "auto")';

/* 唤出路径的第三参 */
const FLOAT_CALL = "animateRightSidebar(true, floatTargetW, true)";

/* 唤出路径写 --left-w */
const LEFTW_WRITE_FLOAT = 'if (rwFloat) { rwFloat.style.setProperty("--left-w", `${Math.round(leftWNow)}px`); }';

const MUTATIONS = [
  /* ── R1：退浮层的起点清理（三条 + 一个 state） ── */
  {
    name: "M1 dismissFloat 起点不摘 rightMin0（→ 现象① 右栏自适应失效）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    setRightMin0(false);\n    /* ⚠️⚠️ A-1157-R2：退场**保持**",
      "    /* ⚠️⚠️ A-1157-R2：退场**保持**",
    ),
  },
  {
    name: "M2 dismissFloat 起点不摘 --right-body-pin（→ 现象④ 内容冲出窗口）",
    file: F_APP,
    mutate: (t) => sub(t, D_EXIT_BLOCK, D_EXIT_BLOCK.replace('      rwExit.style.removeProperty("--right-body-pin");\n', "")),
  },
  {
    name: "M3 dismissFloat 起点不摘 --right-target-w（过渡目标宽残留）",
    file: F_APP,
    /* ⚠️ 单行锚（不用块替换）：`--right-target-w` 那行后面紧跟 `--left-w` 那行，
       用块替换会因"删最后一行"导致尾随换行归属歧义而静默不命中（实测 M3 曾 APPlY_FAIL）。 */
    mutate: (t) => sub(
      t,
      '    if (rwExit) {\n      rwExit.style.removeProperty("--right-body-pin");\n      rwExit.style.removeProperty("--right-target-w");',
      '    if (rwExit) {\n      rwExit.style.removeProperty("--right-body-pin");',
    ),
  },
  {
    name: "M4 dismissFloat 的 done 少一次摘除（起点 + 收尾双保险破缺）",
    file: F_APP,
    /* ⚠️ A-1157-R2 同步锚点：done 里现在先摘的是 `rightExitAnim`（退场专用标志），
       后面才是三条 removeProperty；锚点跟着新形状改。 */
    mutate: (t) => sub(
      t,
      '      setRightExitAnim(false);\n      /* ⚠️⚠️ A-1158-R：**必须清掉内层包裹层的 opacity 残留**',
      '      /* ⚠️⚠️ A-1158-R：**必须清掉内层包裹层的 opacity 残留**',
    ),
  },

  /* ── R2：过渡起点的补清理 ── */
  {
    name: "M5 animateRightSidebar 入口不摘 rightMin0（上一次 done 被 cancel ⇒ 永久残留）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '    setRightMin0(false);\n    const rwReset = rightWrapperRef.current;',
      '    const rwReset = rightWrapperRef.current;',
    ),
  },
  {
    name: "M6 animateRightSidebar 入口不摘 --right-body-pin",
    file: F_APP,
    mutate: (t) => sub(t, A_ENTRY_BLOCK, A_ENTRY_BLOCK.replace('      rwReset.style.removeProperty("--right-body-pin");\n', "")),
  },
  {
    name: "M7 animateRightSidebar 入口不摘 --right-target-w",
    file: F_APP,
    /* ⚠️ 同 M3：单行锚，避开块尾换行歧义。 */
    mutate: (t) => sub(
      t,
      '    if (rwReset) {\n      rwReset.style.removeProperty("--right-body-pin");\n      rwReset.style.removeProperty("--right-target-w");',
      '    if (rwReset) {\n      rwReset.style.removeProperty("--right-body-pin");',
    ),
  },

  /* ── R7：浮层稳态宽（越窗根因） ── */
  {
    name: "M8 浮层稳态宽改回裸 100%（右栏右缘越窗 240px）",
    file: F_APP,
    mutate: (t) => sub(t, FLOAT_W, 'width: (mainIsFloatLayout && !rightMin0) ? "100%"\n              : (mainIsFloatLayout ? "var(--right-target-w)" : "auto")'),
  },
  {
    name: "M9 非浮层态不回落 auto（普通展开被内联宽污染）",
    file: F_APP,
    mutate: (t) => sub(t, FLOAT_W, 'width: (mainIsFloatLayout && !rightMin0) ? "calc(100% - var(--left-w, 0px))"\n              : (mainIsFloatLayout ? "var(--right-target-w)" : undefined)'),
  },

  /* ── R6：判据与真状态同源 ── */
  {
    name: "M10 唤出路径不传 isFloat=true（浮层被误判成普通展开）",
    file: F_APP,
    mutate: (t) => sub(t, FLOAT_CALL, "animateRightSidebar(true, floatTargetW)"),
  },
  {
    name: "M11 isFloatExpand 不优先用显式入参（只留宽度阈值）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "      const isFloatExpand = isFloat !== undefined\n        ? isFloat\n        : (nextWidth !== undefined && nextWidth > window.innerWidth * 0.8);",
      "      const isFloatExpand = (nextWidth !== undefined && nextWidth > window.innerWidth * 0.8);",
    ),
  },

  /* ── R7 的另一半：--left-w 的写/摘成对 ── */
  {
    name: "M12 唤出路径不写 --left-w（浮层稳态宽算不出来 = 越窗）",
    file: F_APP,
    mutate: (t) => sub(t, LEFTW_WRITE_FLOAT, ""),
  },
  {
    name: "M13 退浮层不摘 --left-w（脏变量跟到后续布局）",
    file: F_APP,
    mutate: (t) => sub(t, '      rwExit.style.removeProperty("--left-w");\n', ""),
  },
  {
    name: "M14 普通展开入口不摘 --left-w（写/摘不成对）",
    file: F_APP,
    mutate: (t) => sub(t, '      if (!isFloat) { rwReset.style.removeProperty("--left-w"); }', ""),
  },
  {
    name: "M15 左栏折叠/展开不同步 --left-w（折左栏后右栏不补宽）",
    file: F_APP,
    /* ⚠️⚠️ 必须**连上下文一起锚**（不能只锚那一行）——两处理由：
       ① 只删行首缩进 ⇒ `setProperty("--left-w"` 仍在 ⇒ **等价变异体**（改字节没改行为，铁律 9），
          "存活"结论无意义（实测：只删 10 个空格时守卫照样绿）；
       ② resize 块（在 `App` 里）与 `animateLeftSidebar` 里这两行的**缩进与文本除取值来源外完全相同**，
          而 `sub()` 只替换**第一处** ⇒ 只锚那一行会命中 resize 那块，`animateLeftSidebar` 毫发无损
          （实测：变异后 `animateLeftSidebar` 的 `fnBody` 长度仍是 896、`hasLeftW` 仍为 true）。
       ⇒ 用**上一行的取值来源**区分两处：目标处是 `const lw = node.getBoundingClientRect().width;`。 */
    mutate: (t) => sub(
      t,
      "\n          const lw = node.getBoundingClientRect().width;\n          rightWrapperRef.current?.style.setProperty(\"--left-w\", `${Math.round(lw)}px`);",
      "\n          const lw = node.getBoundingClientRect().width;",
    ),
  },

  /* ── 死锁兜底 ── */
  {
    name: "M16 GEOM_SYNC_HARD_LIMIT_FRAMES 从 done 判据里删掉（结构性死锁）",
    file: F_APP,
    mutate: (t) => sub(t, "      || frameCount >= GEOM_SYNC_HARD_LIMIT_FRAMES);", ");"),
  },
  {
    name: "M17 frameCount 不递增（上界成死代码）",
    file: F_APP,
    mutate: (t) => sub(t, "    frameCount++;\n", ""),
  },

  /* ── R8：内联宽残留 ── */
  {
    /* ⚠️⚠️ A-1157-R2 同步锚点：原先锚的那三行已被重构（退场要"先清残值、再挂 exit 类"，
       顺序不能换 —— 先清残值时铺满规则仍在生效，所以清除没有视觉变化；
       留到挂类之后才清的话，残值会突然生效，右栏直接跳到 287 而不是从满宽过渡下来）。
       新形状：残值清理提到 `rwExitPre` 之后、挂类之前，兜底那次留在 `rwExit` 块里。
       ⚠️ 这条变异守的仍是同一个缺陷：不清 ⇒ 内联残值留在 DOM 上，
         一旦某条路径摘掉浮层态那条 `width:100% !important`，残值立刻显形（静默地雷）。 */
    name: "M18 dismissFloat 不清 .right-sidebar 内联宽（287px 静默残留）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'if (rsExit instanceof HTMLElement) { rsExit.style.width = ""; }',
      "",
    ),
  },
  {
    /* ⚠️ A-1157-R2：退场专用类 `right-wrapper-exit`。少了它 ⇒ 浮层态那条铺满规则在退场期间
       仍然生效 ⇒ 右栏被钉死在满宽（实测 `1ms 1092@240..1332` → **411ms 完全不动**
       → `431@901..1332` → 右缘向左退到 1240、右边空 92px）。 */
    name: "M19 退场不挂 right-wrapper-exit（铺满规则在退场期仍生效 ⇒ 右栏先冻结再整块跳）",
    file: F_APP,
    mutate: (t) => sub(t, '    setRightExitAnim(true);\n', ""),
  },
  {
    /* ⚠️ A-1158：唯一宿主必须**按模式换类**（浮层态挂 `float-window` 拿 fixed 外框样式）。
       不换 ⇒ 浮层态里它仍是内联盒子（`flex:1`，被 `.main.main-float` 压成 0）
       ⇒ 浮窗根本没有外框。 */
    name: "M20 唯一宿主不按模式换类（浮层态拿不到 fixed 外框 ⇒ 浮窗不可见）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      'className={mainIsFloatLayout ? "float-window" : "inline-chat-host"}',
      'className="inline-chat-host"',
    ),
  },
  {
    /* ⚠️⚠️ A-1158-R：**最关键的一条**。A-1158 把"浮窗外框"和"内联聊天区"合并成同一个宿主，
       `floatInnerRef` 那一层因此**常驻**了；而几何渐隐（退场终点）会把它
       `style.opacity` 写成 ≈0 ⇒ 残留把**普通布局下的聊天区整块变透明**
       （用户实测：恢复窗口化之后中间一片黑）。
       ⚠️ 为什么不能只靠 JSX 的 `opacity: floatMinIcon ? 0 : 1` 兜住：
         React 只在该 prop **变化**时重写 style，inline 态它恒为 1 ⇒ 不重写 ⇒ 命令式的 0 留存。
       ⚠️ 为什么不容易被别的断言发现：退场后几何量（宿主 w/h、bodyCls、overflowRight）
         全都是"正常"的，**只有 opacity 暴露问题**。 */
    name: "M21 退场 done 不清内层 opacity（普通布局聊天区被残留透明化 ⇒ 中间一片黑）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      '      const fiExit = floatInnerRef.current;\n      if (fiExit) { fiExit.style.opacity = ""; }\n',
      "",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

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
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
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
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`⚠️ 还原后 sha256 不一致！期望 ${man.sha256}，实际 ${now} —— 请手工复核 ${man.file}`);
    process.exit(2);
  }
  console.log(`已还原（sha256 一致）：${man.file}`);
  process.exit(0);
}

/* full：逐条 apply → 跑 spec → restore，任何一条"存活"即整体失败 */
console.log(`变异总数：${MUTATIONS.length}`);
let survived = 0;
for (const [i, m] of MUTATIONS.entries()) {
  console.log(`\n=== M${i + 1}：${m.name} ===`);
  const r = await (async () => {
    const { spawnSync } = await import("node:child_process");
    const apply = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--apply", String(i + 1)], { encoding: "utf8" });
    process.stdout.write(apply.stdout || "");
    if (apply.status !== 0) { process.stderr.write(apply.stderr || ""); return "apply-failed"; }
    const run = spawnSync(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.config.ts", ...SPECS], { cwd: ROOT, encoding: "utf8" });
    const out = (run.stdout || "") + (run.stderr || "");
    const caught = run.status !== 0 && /Tests\s+\d+ failed/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
    const restore = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--restore"], { encoding: "utf8" });
    process.stdout.write(restore.stdout || "");
    if (restore.status !== 0) { process.stderr.write(restore.stderr || ""); return "restore-failed"; }
    return caught ? "caught" : "survived";
  })();
  if (r === "survived") { survived++; console.log(`  ❌ 存活（守卫没抓住）`); }
  else if (r === "caught") { console.log(`  ✅ 被抓住`); }
  else { console.log(`  ⚠️ ${r}`); survived++; }
}
console.log(`\n结果：${MUTATIONS.length - survived}/${MUTATIONS.length} 被抓住，存活 ${survived}`);
if (survived > 0) { process.exit(1); }
