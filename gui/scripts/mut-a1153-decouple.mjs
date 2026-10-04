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
 * | ② 形状 | 过渡期宽度声明去掉 `!important`（A-1157） | 内联 width 吃掉它 ⇒ 过渡方向反了且**静默** |
 * | ② 形状 | 去掉浮层态 `margin-left:auto`（A-1157） | 右栏贴 wrapper 左缘 ⇒ 「向右合」 |
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
    /* ⚠️ A-1179：曾把锚点改成**多行**形态（`if` 块里带注释）。
       ⚠️⚠️ A-1190 重锚回**单行**：live 现在又写回了单行
       （`if (el && isFloatExpand) { el.style.setProperty("--right-target-w", …); }`，
       见 App.tsx `animateRightSidebar`）⇒ 旧的多行锚点（`…);\n      }`）**不再命中**，
       `check-mut-anchors` 与跑批都会报「未命中（源码已漂移，该守卫已失效）」。
       判据不变：把那次写入**停用**（保留语法合法，别删行 —— 否则跑批会把
       "编译不过"误当成"抓住了"）。 */
    mutate: (t) => sub(
      t,
      '      if (el && isFloatExpand) { el.style.setProperty("--right-target-w", `${Math.round(nextWidth!)}px`); }',
      "      if (el && isFloatExpand) { void el; void nextWidth; }",
    ),
  },
  {
    /* ⚠️ 用 `subAll`（整组）而不是 `sub`：清理点有 3 处（展开 done / 收起 done / 取消路径），
       只删一处时计数仍 ≥2、断言照样绿 ⇒ 变异"存活"但其实是**变异点不完整**（铁律 9/30）。
       替换体保持语法合法（改成 `-DISABLED` 后缀而不是删行）——否则文件编译不过，
       batch 会判成"异常"而不是"被抓住"。 */
    name: "6 全部漏摘 --right-target-w（残值污染下一次展开）",
    file: F_APP,
    /* ⚠️ 整组替换（3 处摘除点：展开 done / 收起 done / 取消路径）⇒ 必须声明 `all: true`，
       否则 `check-mut-anchors` 报「不唯一（命中 N 次，无法确定改的是哪一处）」——
       报警没人看就等于没报警。 */
    all: true,
    mutate: (t) => subAll(
      t,
      'removeProperty("--right-target-w")',
      'removeProperty("--right-target-w-DISABLED")',
    ),
  },
  {
    /* ⚠️ A-1157 同步锚点：过渡期那条声明现在带 `!important`（必须带 —— 内联 width 会吃掉它，
       少了它右栏在过渡期纹丝不动、wrapper 却已跳到目标宽 ⇒ 右缘凭空空出一段，
       正是用户本轮报的「右边突然出现空白，然后侧边栏向右合上」）。 */
    name: "7 CSS 给 var(--right-target-w) 加 fallback（普通展开误用兜底值）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  width: var(--right-target-w) !important;",
      "  width: var(--right-target-w, 100%) !important;",
    ),
  },
  {
    /* ⚠️⚠️ A-1157 新增：把过渡期那条声明的 `!important` 去掉 —— 它会静默退回
       "过渡方向反了"（右栏贴 wrapper 左缘、从左往右合、右缘凭空空白），
       而**所有既有断言仍然全绿**（它们只查"有没有这条规则、有没有 !important 之外的形状"）。
       这条就是"为什么这个变异必须存在"的答案。 */
    name: "7b 过渡期宽度声明去掉 !important（内联 width 吃掉它 ⇒ 过渡方向反了且静默）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "  width: var(--right-target-w) !important;",
      "  width: var(--right-target-w);",
    ),
  },
  {
    /* ⚠️ A-1157：浮层态右栏必须贴住 wrapper 右缘（`margin-left: auto`）——
       少了它过渡就从 wrapper 左缘起向右长，稳态量不出差别，只能靠静态断言守。 */
    name: "7c 去掉右栏贴右缘的 margin-left:auto（过渡变成「向右合」而非「向左挤开」）",
    file: F_CSS,
    /* ⚠️ A-1173 重锚：`margin-left: auto` 不再是 `body.float-layout .right-sidebar`
       那条独立规则，而是搬进了 `.right-sidebar` 的**主规则**（无条件生效）——
       因为退浮层那一帧 `float-layout` 已摘、而 wrapper 还没缩到位，右侧会露出 135px 空白。
       ⇒ 锚点改成主规则里那两行（`min-width: 260px;` 紧跟 `margin-left: auto;`）。 */
    mutate: (t) => sub(t, "  min-width: 260px;\n  margin-left: auto;", "  min-width: 260px;"),
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
  {
    /* ⚠️ A-1157：`setFloatState("float")` 必须走 `React.startTransition`。
       这一步让 React **卸载整棵 `<main>`（含 ChatPanel）、再在浮窗里挂载另一棵**
       （换父 ⇒ 整树重建，两棵树都不复用）。同步提交时它会把窗口化过渡的
       第 3 帧冻成 **80~91ms 的一帧**（真 App CDP + LoAF：`start:35ms dur:80ms
       renderStart:77ms scripts:[]`、`longtask=[]`）—— 用户原话「界面会抽搐」。
       并发提交后同一场景降到 **55~59ms**（约 -35%）。
       ⚠️ 注意这条**没**消除停顿，只是把它压小；剩下的部分属架构性代价
       （A-1152 记过：改成「`<main>` 兼作浮窗、单宿主」那条路实测有可见回归）。 */
    name: "8b setFloatState 不走 startTransition（换父重建同步提交 ⇒ 过渡被一帧冻住）",
    file: F_APP,
    mutate: (t) => sub(
      t,
      "    React.startTransition(() => {\n      setFloatState(\"float\");\n    });",
      "    setFloatState(\"float\");",
    ),
  },

  /* ── ④ 跟手：拖动期禁过渡 ───────────────────────────────────────── */
  {
    name: "9 拖动第一帧不再挂 slime-dragging（拖动头 140ms 不跟手）",
    file: F_APP,
    /* ⚠️ 两个 resizer 起点（左栏 / 右栏）**各有一处** `slime-dragging` 的挂载 ——
       本变异要的是"拖动第一帧都不挂"，所以用 `subAll` 整组替换
       （只改一处 = 另一栏仍跟手，那不是本变异想证明的缺陷）。
       命中两处 ⇒ 必须声明 `all: true`（否则核验器报「不唯一」）。 */
    all: true,
    mutate: (t) => subAll(
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
    name: "12 删掉 .chat-scroll 的过渡（摘类时 0→1 硬跳 = 闪烁）",
    file: F_CSS,
    /* ⚠️ A-1170 重锚：`.chat-scroll` 规则**体内多了 A-1161 的注释**
       （`scrollbar-gutter: stable` 那一整段），原来那句
       `}\nbody.slime-fading .chat-scroll {` 已经**不再连续** ⇒ 锚点整体失配。
       ⇒ 只锚「那一行过渡声明」本身，不依赖规则体的形状。
       ⚠️⚠️ A-1190 再重锚：时长改成了读 CSS 变量（与侧边栏同源），
       而且**两条规则（常驻 + `body.slime-fading`）里各有一份同源声明**。
       ⇒ 判据是"两处都没有过渡"，所以必须**两处一起删**：只删一处的话，
         摘类方向仍有一条过渡在跑 —— 那就不是这个变异想证明的东西了。
       ⚠️⚠️⚠️ A-1190② 三度重锚：一个 `--chat-fade-dur` 已**拆成两个**方向变量
       （常驻 = `--chat-fade-in-dur`、`body.slime-fading` = `--chat-fade-out-dur`）⇒
       单条 `subAll` 的锚点不再覆盖两处，改成**嵌套 `sub`** 各删一条。
       ⚠️ 仍声明 `all: true`（核验器认最内层那条锚点，命中 1 次即可 —— 这里是"整组改"的语义）。 */
    all: true,
    mutate: (t) => sub(
      sub(
        t,
        "  transition: opacity var(--chat-fade-in-dur, 500ms) cubic-bezier(0, 0, 0.2, 1);",
        "  /* 变异：过渡被删 */",
      ),
      "  transition: opacity var(--chat-fade-out-dur, 500ms) cubic-bezier(0, 0, 0.2, 1);",
      "  /* 变异：过渡被删 */",
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
