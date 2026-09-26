#!/usr/bin/env node
/**
 * gui/scripts/mut-a1113.mjs — A-1113（滚动条改为「悬浮细胶囊」，用户点名的需求 #304）的变异验证。
 *
 * ## 修的是
 *
 * 用户原话（本轮 `AskUserQuestion` 答复）：「**按悬浮细胶囊做**」
 *   —— 轨道透明、6px 全圆角天蓝滑块、静止半透明、hover 加深。
 *
 * 过程中量出一个**从未被发现的真缺陷**（不是"顺手重构"）：
 * `.chat-scroll` 曾同时写 `scrollbar-color`（标准属性）与 `::-webkit-scrollbar-thumb`（自定义属性）。
 * Chromium 121+ 起**标准属性优先** ⇒ 该元素的自定义滚动条被**整块忽略**（连全局那条宽度一起）
 * ⇒ 聊天区实际渲染成平台默认样式（Windows ≈15–17px 宽灰条），
 * 而本文件里那两条 webkit 规则是**从未生效的死代码**。
 * ⇒ 修法 = 删掉 `.chat-scroll` 的全部覆盖，并把「不许出现标准滚动条属性」写成守卫（本套 M10/M13）。
 *
 * ## 覆盖的条目（每条都在问：动了哪一条判据会**静默退化**）
 *
 *   1  再插一份全局 `::-webkit-scrollbar` 定义（计数闸门失效 ⇒ 第二产地，几何一改就漂移）
 *   2  全局条改胖到 12px（退回用户抱怨的「胖条」；过 tsc、过构建，只在眼里翻车）
 *   3  纵横不等粗（横条比竖条胖）
 *   4  轨道不再透明（出现可见凹槽 ——「悬浮」没了）
 *   5  滑块圆角降到 2px（胶囊变直角条）
 *   6  静止态改成不透明（不再是「静止半透明」）
 *   7  hover 与静止同色（hover 没有任何反馈 = 用户感知不到可拖动）
 *   8  颜色退回深灰（正是用户原始投诉的「样式不对」）
 *   9  聊天区又自带一份伪元素覆盖（第二产地复发）
 *  10  某个滚动容器又写 `scrollbar-color`（根因回归 ⇒ 自定义滚动条静默整块失效）
 *  11  hover 规则被整条删掉（滑块永远一个色）
 *  12  聊天容器类名掉了（守卫守的是没人用的选择器 = 静默失效）
 *  13  又写 `scrollbar-width: thin`（与 10 同族，另一处根因入口）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 多行锚点一律走 `sub`（行尾无关）。实测：`index.css` / `ChatPanel.tsx` 均为 **LF**，
 *    但本仓行尾是**混的**，锚点仍必须行尾无关（否则换机/换分支即静默失效）。
 * ⚠️ **判据 = exit≠0 且输出里真有 `Tests` 汇总行**（只有 exit≠0 时，
 *    「vitest 启动失败 / 配置加载失败」会被误当成「变异被捕获」—— 本仓 §26 实测踩过）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1113.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1113.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1113.mjs --apply 3   # 只改第 3 条并留着
 *   node gui/scripts/mut-a1113.mjs --restore   # 按 manifest 逐字节还原
 *
 * 本环境禁止 node→node 孙进程（spawnSync 报 EBUSY）⇒ 全量模式跑不了，改用 shell 循环：
 *
 *   for i in $(seq 1 13); do
 *     node gui/scripts/mut-a1113.mjs --apply $i || exit 1
 *     node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
 *       tests/gui/a1113-scrollbar-capsule.spec.ts --reporter=dot > /tmp/m$i.txt 2>&1
 *     echo "M$i exit=$?"; grep -E 'Tests +[0-9]' /tmp/m$i.txt
 *     node gui/scripts/mut-a1113.mjs --restore
 *   done
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/a1113-scrollbar-capsule.spec.ts";

const F_CSS = "gui/src/renderer/index.css";
const F_PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [F_CSS, F_PANEL];

/** 下面这几条锚点在多条变异里复用 —— 抽成常量避免手抄漂移（核验器能解析 `sub(t, CONST, …)`）。 */
const A_HOVER = "::-webkit-scrollbar-thumb:hover { background: rgba(96, 165, 250, 0.85); }";
const A_BAR = "::-webkit-scrollbar { width: 6px; height: 6px; }";
const A_THUMB = "  background: rgba(96, 165, 250, 0.45);\n  border-radius: 999px;";
const A_SCROLLBOX = "  overflow-x: auto;\n  overflow-y: hidden;\n}";

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1113");

const MUTATIONS = [
  /* ── 全局胶囊几何（唯一产地）── */
  {
    name: "1 再插一份全局 `::-webkit-scrollbar` 定义（第二产地，几何一改就漂移）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_HOVER,
      A_HOVER + "\n::-webkit-scrollbar { width: 4px; height: 4px; }",
    ),
  },
  {
    name: "2 全局条改胖到 12px（退回用户抱怨的那种胖条）",
    file: F_CSS,
    mutate: (t) => sub(t, A_BAR, "::-webkit-scrollbar { width: 12px; height: 12px; }"),
  },
  {
    name: "3 纵横不等粗（横条比竖条胖 —— 同一条需求只做了一半）",
    file: F_CSS,
    mutate: (t) => sub(t, A_BAR, "::-webkit-scrollbar { width: 6px; height: 4px; }"),
  },
  {
    name: "4 轨道不再透明（出现可见凹槽 ——「悬浮」没了）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      "::-webkit-scrollbar-track { background: transparent; }",
      "::-webkit-scrollbar-track { background: rgba(148, 163, 184, 0.18); }",
    ),
  },
  {
    name: "5 滑块圆角降到 2px（胶囊变直角条）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_THUMB,
      "  background: rgba(96, 165, 250, 0.45);\n  border-radius: 2px;",
    ),
  },
  {
    name: "6 静止态改成不透明（不再是「静止半透明」）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_THUMB,
      "  background: rgba(96, 165, 250, 1);\n  border-radius: 999px;",
    ),
  },
  {
    name: "7 hover 与静止同色（hover 没有任何反馈 ⇒ 用户感知不到这条可以拖）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_HOVER,
      "::-webkit-scrollbar-thumb:hover { background: rgba(96, 165, 250, 0.45); }",
    ),
  },
  {
    name: "8 颜色退回深灰（正是用户原始投诉的「样式不对」）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_THUMB,
      "  background: rgba(120, 120, 120, 0.45);\n  border-radius: 999px;",
    ),
  },
  {
    name: "9 聊天区又自带一份伪元素覆盖（第二产地复发）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_HOVER,
      A_HOVER + "\n.chat-scroll::-webkit-scrollbar-thumb { background: rgba(96, 165, 250, 0.55); }",
    ),
  },
  {
    name: "10 某个滚动容器又写 `scrollbar-color`（根因回归 ⇒ 自定义滚动条静默整块失效）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_SCROLLBOX,
      "  overflow-x: auto;\n  overflow-y: hidden;\n  scrollbar-color: rgba(96, 165, 250, 0.45) transparent;\n}",
    ),
  },
  {
    name: "11 hover 规则被整条删掉（滑块永远一个色，没有任何悬停反馈）",
    file: F_CSS,
    /* ⚠️ 锚点必须写成**单个字面量/常量**，不许写成 `"\n" + A_HOVER` 这种拼接：
       `check-mut-anchors` 的 `sub(…)` 分支目前只认「紧跟的第一个字面量」，
       拼接形态会被**读短**成前缀（实测：报「命中 3220 次」= 把 `"\n"` 当成了整条锚点）——
       而同样的读短在别处可能正好让前缀唯一 ⇒ **假绿**。见本轮上报的核对器缺陷。 */
    mutate: (t) => sub(t, A_HOVER, ""),
  },
  {
    name: "12 聊天容器类名掉了（守卫守的是没人用的选择器 = 静默失效）",
    file: F_PANEL,
    /* ⚠️ A-1115：容器现在挂 `chat-scroll rail-host` 两个类 —— 锚点必须跟着改，
       否则这条变异**静默未命中**（守卫从此失去保护），而"未命中"和"存活"一样是失败。 */
    mutate: (t) => sub(t, 'className="chat-scroll rail-host"', 'className="chat-scroll-x rail-host"'),
  },
  {
    name: "13 又写 `scrollbar-width: thin`（与 10 同族，根因的另一个入口）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      A_SCROLLBOX,
      "  overflow-x: auto;\n  overflow-y: hidden;\n  scrollbar-width: thin;\n}",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * 跑守卫 spec，返回 `{ ok }` / `{ measurementFailed, out }` / `{ spawnBlocked }`。
 *
 * ⚠️ **不能只看 exit code**：vitest 启动失败（配置加载不了）也返回非 0，
 * 那样一批「变异」会被报成「全被捕获」，而实际一条测试都没跑 —— 本仓踩过（§26）。
 * ⇒ 判据 = exit≠0 **且** 输出里真有 `Tests <数字>` 汇总行。
 */
function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.error && r.error.code === "EBUSY") { return { ok: false, spawnBlocked: true }; }
  const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!/\bTests\s+\d+/.test(out)) { return { ok: false, measurementFailed: true, out: out.slice(-1500) }; }
  return { ok: r.status === 0, spawnBlocked: false };
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

const base = runSpec();
if (base.spawnBlocked) {
  console.error("本环境禁止 node→node 孙进程（spawnSync 报 EBUSY），全量模式跑不了。");
  console.error("请改用 --apply / --restore + shell 循环（命令见本文件头部注释）。");
  process.exit(1);
}
if (base.measurementFailed) {
  console.error("⚠️ 测量工具本身坏了（spec 的输出里没有 Tests 汇总行）—— 判据不成立，先修工具。");
  console.error(base.out);
  process.exit(1);
}
if (!base.ok) {
  console.error("基线未通过 —— 先修好守卫再跑变异。");
  process.exit(1);
}
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败（检测能力本身坏了）：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1113")) { process.exit(1); }
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
    const res = runSpec();
    writeFileSync(path, src);
    if (res.measurementFailed) {
      console.error(`⚠️  测量工具本身坏了（输出无 Tests 汇总行），本轮判据不成立，中止。`);
      console.error(res.out);
      missed.push(m.name);
      break;
    }
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
