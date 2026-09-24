/**
 * A-1074 变异测试（#230）：输入框上方「悬浮按钮坞」，逐环改坏要求守卫变红。
 *
 * 覆盖 `tests/gui/float-dock.spec.ts`。用户原话：「改成输入框正上方的最右边悬浮按钮，点击后
 * 横向延伸再向上展开，动画与产物卡片同族」「子代理从右侧监测栏移出，做成同款悬浮按钮」
 * 「一个展开时另一个渐出」。
 *
 * A 组：纯判据（互斥 / 渐出 / 只关自己 / 类名唯一产地）
 * B 组：接线与几何（贴最右 / 向上展开 / 定位祖先 / 复用 .collapse / 同族节拍 /
 *       渐出让出点击 / 子代理在坞不在监测栏 / 单值 state / 同款类名）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤）—— 一律「」。
 * ⚠️ 四个目标文件都是 **LF**（同仓行尾是混的，判之前先跑命令）——
 *   一律走共享 `sub`，不要自己写替换。
 * ⚠️ 本组里有几条是**改 CSS**：守卫按文本读 CSS 块，所以"删掉那条声明"必须真的删，
 *   不许改成另一个仍含关键字的写法（例如把 `transition-delay: 80ms` 改成 `0ms` 仍含
 *   `transition-delay` —— 那是**诱饵**，守卫照样绿）。
 *
 * 用法：node gui/scripts/mut-a1074-dock.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, nlOf, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/float-dock.spec.ts";
const MODULE = "gui/src/renderer/pages/floatDock.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const SUB = "gui/src/renderer/pages/SubAgentExpandButton.tsx";
const CSS = "gui/src/renderer/index.css";
const TARGETS = [MODULE, PANEL, SUB, CSS];

/** 把 `[start, end)` 那段搬到 `afterMarker` 之后 —— 只有「搬位置」类变异需要它。
 *  `sub` 只认字面量，几十行 JSX 逐字写进锚点不现实（且一改缩进就失效）。
 *  ⚠️ 锚点必须能唯一命中；命中不了就原样返回（主流程按「未命中」报错）。 */
function moveAfter(text, startMarker, endMarker, afterMarker) {
  const p = text.indexOf(startMarker);
  const e = text.indexOf(endMarker);
  if (p < 0 || e < 0 || p >= e) { return text; }
  const block = text.slice(p, e);
  const rest = text.slice(0, p) + text.slice(e);
  const at = rest.indexOf(afterMarker);
  if (at < 0) { return text; }
  const cut = at + afterMarker.length;
  return rest.slice(0, cut) + nlOf(text) + block + rest.slice(cut);
}

/** 把 `[start, end)`（**含 endMarker 本身**）搬到 `beforeMarker` 之前 —— 「把某块塞到前面/包起来」类变异用它。
 *  ⚠️ 与 `moveAfter` 同规矩：锚点必须唯一，命中不了就原样返回（主流程按「未命中」报错）。 */
function moveBefore(text, startMarker, endMarker, beforeMarker) {
  const p = text.indexOf(startMarker);
  const e = text.indexOf(endMarker);
  if (p < 0 || e < 0 || p >= e) { return text; }
  const cut = e + endMarker.length;
  const block = text.slice(p, cut);
  const rest = text.slice(0, p) + text.slice(cut);
  const at = rest.indexOf(beforeMarker);
  if (at < 0) { return text; }
  return rest.slice(0, at) + block + nlOf(text) + rest.slice(at);
}

const MUTATIONS = [  // ── A 纯判据（floatDock.ts）────────────────────────────────────────────────
  {
    name: "A1 toggle 只开不关（再点一下收不起来，面板永远挂在那儿）",
    file: MODULE,
    mutate: (t) => sub(t, "  return current === id ? null : id;", "  return id;"),
  },
  {
    name: "A2 坞格判据不再看 id（有任何一个展开 ⇒ 两格都算展开 = 两个面板同时开）",
    file: MODULE,
    mutate: (t) => sub(
      t,
      "  return { open: isDockOpen(current, id), faded: isDockFaded(current, id) };",
      "  return { open: current !== null, faded: isDockFaded(current, id) };",
    ),
  },
  {
    name: "A3 渐出判据说反（该渐出的是自己而不是另一个）",
    file: MODULE,
    mutate: (t) => sub(t, "  return current !== null && current !== id;", "  return current === id;"),
  },
  {
    name: "A4 都收起时也渐出（两个按钮一上来就是隐形的 —— 用户看不到任何入口）",
    file: MODULE,
    mutate: (t) => sub(t, "  return current !== null && current !== id;", "  return current !== id;"),
  },
  {
    name: "A5 closeDock 顺手把另一个也关了（用户正看的子代理面板自己消失）",
    file: MODULE,
    mutate: (t) => sub(t, "  return current === id ? null : current;", "  return null;"),
  },
  {
    name: "A6 类名漏掉 is-faded（渐出没有任何视觉效果 —— 两个按钮同时看着都像「没开」）",
    file: MODULE,
    mutate: (t) => sub(t, '  return `dock-slot${open ? " is-open" : ""}${faded ? " is-faded" : ""}`;', '  return `dock-slot${open ? " is-open" : ""}`;'),
  },

  // ── B 接线 / 几何 ──────────────────────────────────────────────────────────
  {
    name: "B1 胶囊不贴最右（`flex-start` → 悬浮按钮飘在左边，与用户要的「最右边」相反）",
    file: CSS,
    mutate: (t) => sub(t, "  justify-content: flex-end;       /* 「最右边」 */", "  justify-content: flex-start;       /* 「最右边」 */"),
  },
  {
    name: "B2 面板改回文档流（展开时把输入框整个顶下去 —— 看状态不该改变输入框位置）",
    file: CSS,
    mutate: (t) => sub(t, ".dock-panel {\n  position: absolute;", ".dock-panel {\n  position: static;"),
  },
  {
    name: "B3 面板改成向下长（`top:100%` → 展开方向反了，且会盖住/顶走输入框）",
    file: CSS,
    mutate: (t) => sub(t, "  bottom: 100%;", "  top: 100%;"),
  },
  {
    name: "B4 坞不再是定位祖先（absolute 面板的定位基准跑到更外层，位置算歪）",
    file: CSS,
    mutate: (t) => sub(t, "  position: relative;              /* 面板的绝对定位锚点 */", "  position: static;              /* 面板的绝对定位锚点 */"),
  },
  {
    name: "B5 面板不再复用 .collapse（自写一个类 ⇒ 「与产物卡同族」只是说法，节拍会各走各的）",
    file: PANEL,
    mutate: (t) => sub(t, 'className={`collapse${procsOpen ? " is-open" : ""}`}', 'className={`dock-fade${procsOpen ? " is-open" : ""}`}'),
  },
  {
    name: "B6 坞格的过渡写死秒数（不再取共享节拍变量 ⇒ 改全局节拍时坞不动）",
    file: CSS,
    mutate: (t) => sub(t, "  transition: opacity var(--collapse-dur) var(--collapse-ease);", "  transition: opacity 0.3s ease;"),
  },
  {
    name: "B7 渐出不让出点击（一个看不见却挡住点击的空洞：点它没任何反应）",
    file: CSS,
    mutate: (t) => sub(t, ".dock-slot.is-faded { opacity: 0; pointer-events: none; }", ".dock-slot.is-faded { opacity: 0; }"),
  },
  {
    name: "B8 坞里又长出摘要段（A-1079 用户已撤销「横向延伸」—— 胶囊该始终紧凑）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      "                    }}>{agentProcs.count}</span>\n",
      "                    }}>{agentProcs.count}</span>\n                    <span className=\"dock-pill-summary\">多余的摘要</span>\n",
    ),
  },
  {
    name: "B8b 又给胶囊加变宽动画（max-width 过渡 —— 胶囊不该随展开变宽）",
    file: CSS,
    mutate: (t) => sub(t, ".dock-pill {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n", ".dock-pill {\n  max-width: 0;\n  transition: max-width var(--collapse-dur) var(--collapse-ease);\n  display: flex;\n  align-items: center;\n  gap: 6px;\n"),
  },
  {
    name: "B8c 胶囊写回 width:100%（去撑满坞格，而坞格宽度又由胶囊内容决定 —— 循环依赖）",
    file: CSS,
    mutate: (t) => sub(t, ".dock-pill {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n", ".dock-pill {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  width: 100%;\n"),
  },
  {
    name: "B8d 退回 grid-template-columns 轨道方案（列轨在非定宽容器里收不拢 ⇒ 通栏故障复发）",
    file: CSS,
    mutate: (t) => sub(t, "  padding: 5px 11px;\n  border-radius: 999px;", "  padding: 5px 11px;\n  grid-template-columns: 0fr;\n  border-radius: 999px;"),
  },
  {
    name: "B9 面板与横向延伸同时起跑（没有「再」的错开 —— 用户明确要「横向延伸再向上展开」）",
    file: CSS,
    mutate: (t) => sub(t, ".dock-panel > .collapse { transition-delay: 80ms, 80ms; }", ".dock-panel > .collapse { }"),
  },
  {
    name: "B10 子代理被塞回监测栏（用户要求移出 —— 塞回去就是把这条需求撤了）",
    file: PANEL,
    /* A-1077 重锚：坞已移到监测栏**上面**，所以"塞回监测栏"要落在监测栏那一条**内部**
       （原来锚在坞之前，现在那里已不属于监测栏 → 会变成「未命中」）。 */
    mutate: (t) => sub(t, "          {compressUi && (", "          {void SubAgentExpandButton}\n          {compressUi && ("),
  },
  {
    name: "B11 子代理没进坞（移出监测栏又没进坞 = 入口直接消失）",
    file: PANEL,
    mutate: (t) => sub(t, '            <SubAgentExpandButton slot={subsSlot} onToggle={() => toggleDockSlot("subs")} />', "            {/* 入口缺失 */}"),
  },
  {
    name: "B12 子代理自己持有 open（第二个真相源 ⇒ 互斥必然漂移）",
    file: SUB,
    mutate: (t) => sub(t, "  { slot, onToggle }: { slot: { open: boolean; faded: boolean }; onToggle: () => void },", "  { slot, onToggle }: { slot: { open: boolean }; onToggle: () => void },"),
  },
  {
    name: "B13 子代理退回旧的 .pop 浮层（没换成同款坞面板 ⇒ 「同款」不成立）",
    file: SUB,
    mutate: (t) => sub(t, '<div className="dock-panel">', '<div className="pop pop-up">'),
  },
  {
    name: "B14 子代理胶囊不用同款类名（两条路各一套长得像的样式）",
    file: SUB,
    mutate: (t) => sub(t, 'className="dock-pill"', 'className="dock-pill-legacy"'),
  },
  {
    name: "B15 坞的展开态退回两个独立布尔（又变回两个真相源，两个同时展开没人管）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      '  const procsSlot = dockSlotState(dock, "procs");',
      '  const setProcsOpen = (v: boolean): void => { void v; };\n  const procsSlot = dockSlotState(dock, "procs");',
    ),
  },
  {
    name: "B20 坞被排到监测栏**下面**（A-1077 用户更正的位置 —— 排回去就是把更正撤了）",
    file: PANEL,
    /* ⚠️ afterMarker 必须落在**被搬走的那一段之外**：坞现在排在监测栏上面，
       所以 [坞, textarea) 里**包着**监测栏 —— 用监测栏当插入点会被一起搬走（实测 未命中）。
       改锚到输入框**之后**的工具行（落点自然就在监测栏下面）。 */
    mutate: (t) => moveAfter(
      t,
      '<div className="float-dock">',
      "<textarea ref={inputRef}",
      '          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px 10px" }}>',
    ),
  },
  {
    name: "B16 坞格类名不再从派生标志拼（写死 → 展开/渐出两套说法）",
    file: PANEL,
    mutate: (t) => sub(t, "dockSlotClassOf(procsSlot.open, procsSlot.faded)", '"dock-slot"'),
  },
  {
    name: "B21 输入框那个圆角框被挪到坞**之前**（坞被框起来 ⇒ absolute 面板被 overflow:hidden 裁掉，展开什么都看不见）",
    file: PANEL,
    /* 模型化「坞被放进框里」：把 `.glass-input` 的**开标签**搬到坞之前，
       于是那个框从坞的上方就开始（坞落进框内）。判据是两者在源码里的**先后**。 */
    mutate: (t) => moveBefore(
      t,
      '<div className="glass-input" style={{',
      'onDrop={handleDropImages}>',
      '{/* A-1078',
    ),
  },
  {
    name: "B22 胶囊加回边框（用户原话「我要的是悬浮窗，不用框起来」）",
    file: CSS,
    mutate: (t) => sub(
      t,
      "  border: none;\n  /* 实底：胶囊同样浮在正文上，半透明会让背后的字透出来 */\n  background: var(--float-surface);",
      "  border: 1px solid var(--border);\n  /* 实底：胶囊同样浮在正文上，半透明会让背后的字透出来 */\n  background: var(--float-surface);",
    ),
  },
  {
    name: "B23 坞的下边距归零（又跟下面那块碰着 —— 用户要「几个像素的距离」）",
    file: CSS,
    mutate: (t) => sub(t, "  padding: 0 16px 8px;", "  padding: 0 16px 0;"),
  },
  {
    name: "B24 「后台进程」箭头方向退回默认（收起时朝右 —— 看不出是往上展开）",
    file: PANEL,
    mutate: (t) => sub(t, "rotate={procsOpen ? 90 : 270}", "rotate={procsOpen ? 90 : 0}"),
  },
  {
    name: "B25 子代理箭头方向退回默认（收起时朝右）",
    file: SUB,
    mutate: (t) => sub(t, "rotate={open ? 90 : 270}", "rotate={open ? 90 : 0}"),
  },
  {
    name: "B26 浮层改回半透明底（背后的正文又透出来 —— 用户：「展开后界面透明度过高」）",
    file: CSS,
    /* 锚点必须带 `.dock-panel-card` 的上下文：单看 `background: var(--float-surface);`
       在胶囊里也有一处（§8-1 同名多产地）。 */
    mutate: (t) => sub(
      t,
      ".dock-panel-card {\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  background: var(--float-surface);",
      ".dock-panel-card {\n  border: 1px solid var(--border);\n  border-radius: 10px;\n  background: var(--card-surface);",
    ),
  },
  {
    name: "B27 --float-surface 在 beta 主题里写成半透明（浮层透出正文）",
    file: CSS,
    mutate: (t) => sub(t, "  --float-surface: #1a243c;", "  --float-surface: rgba(30, 42, 70, 0.82);"),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

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
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 不给这道保险，变异会留在源码里，
   下一次跑脚本就会把「变异后的源码」当基线 → 整批变异静默假绿（2026-09-23 实测踩到）。 */
const restoreAll = installRestoreOnSignal(TARGETS, ROOT);

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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1074-dock")) { process.exit(1); }

/** 引号自伤自检（A-1056）：**剥注释后**仍出现「CJK + ASCII 双引号 + CJK」才算坏。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of [SPEC, MODULE, "gui/scripts/mut-a1074-dock.mjs"]) {
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
} finally {
  restoreAll();
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
