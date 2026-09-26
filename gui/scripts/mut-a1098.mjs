#!/usr/bin/env node
/**
 * gui/scripts/mut-a1098.mjs — A-1098 守卫的变异验证。
 *
 * 本轮修两件事，两件都有"下一个人顺手写回去、而且全都不报错"的退化形态：
 *
 * | 组 | 缺陷 | 用户看到什么 |
 * |---|---|---|
 * | 草稿 | 弹层勾选与 4s 轮询**共用 state** | 「过一会它就自动取消勾选了」（未保存的勾选被服务端快照回滚） |
 * | 实底 | 浮层用 `.card`（beta 主题下是 0.42/0.5 半透明渐变） | 「这个面板的透明度也是太高了…会看不清字」 |
 *
 * ## 覆盖的十七条
 *
 *   1~4   草稿池纯逻辑：新勾项被插到**首位**（顺序＝优先级，兜底档被顶掉）/ 去重失效 / `inherit`
 *         拦截被删（占位项混进档位列表）/ 自愈剔除被删（历史脏值原样搬运）
 *   5     【事故本体】轮询 `refresh` 顺手把草稿池也覆盖掉
 *   6     弹层 checkbox 绑回**已保存池**（改回事故前的写法）
 *   7     保存提交已保存池而非草稿（用户勾了却没保存进去）
 *   8     打开弹层不播种草稿（弹层永远是空的）
 *   9     `inherit` 字面量回流（唯一出处被绕过）
 *   10    beta 主题 `--float-surface` 被改回半透明（浮层又透字）
 *   11    `.modal-card` 的底被换成"抬高面"变量 `--bg-card`（beta 下就是半透明）
 *   12    `.modal-card` 被追加第二条半透明底（第二真相源）
 *   13    某个全屏浮层的面板退回 `className="card"`
 *   14    浮层面板自带 `background`（盖过 `.modal-card` 的实底 —— NewProjectDialog 的原缺陷）
 *   15    `.modal-card` 被写成 `className="card modal-card"`（beta 的 `.card` 特异性反盖回来）
 *   16    被排除的浮层（右栏新建弹窗）实底来源被换成半透明
 *   17    beta 主题 `--bg` 被改半透明（右栏新建弹窗 + 悬浮窗直接拿它当实底）
 *   18    【A-1100】beta 的 `--modal-surface` 被改回 `--float-surface` 的值（#1a243c 蓝灰抬高色
 *         ⇒ 模态窗观感串成 Alpha 主题配色 —— 就是用户实测的那条回归）
 *   19    【A-1100】`.modal-card` 的底被换回 `--float-surface`（两个变量又被合并成一个）
 *   20    【A-1100】beta 的 `--modal-surface` 被改半透明（模态窗透出背后正文）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照/还原一律走**字节**；还原后比 sha256，且带 SIGINT 保险。
 * ⚠️ 目标文件行尾是**混的**（index.css / AgentsPanel / NewProjectDialog / RightSidebar = LF；
 *    ResidentPanel = CRLF；modelPool.ts = LF）⇒ 一律走共享模块 `sub()`（它自己做行尾无关）。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1098.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1098.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1098.mjs --apply 5   # 只改第 5 条并留着（跑不了子进程的环境）
 *   node gui/scripts/mut-a1098.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 node→node 报 EBUSY）
 *
 *   ```bash
 *   for n in $(seq 1 20); do
 *     node gui/scripts/mut-a1098.mjs --apply "$n" >/dev/null || { echo "M$n 锚点未命中"; continue; }
 *     node node_modules/vitest/vitest.mjs run tests/gui/a1098-ui-guards.spec.ts >/dev/null 2>&1
 *     red=$?
 *     node gui/scripts/mut-a1098.mjs --restore >/dev/null
 *     [ "$red" = "1" ] && echo "M$n ✅ 被捕获" || echo "M$n ❌ 未被捕获"
 *   done
 *   ```
 *   ⚠️ 判捕获必须**同时**确认输出里有 `Tests` 汇总行与 `AssertionError` ——
 *   否则"零测试执行"（收集失败）会被当成捕获。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/gui/a1098-ui-guards.spec.ts"];

const F_POOL = "gui/src/renderer/pages/modelPool.ts";
const F_RESIDENT = "gui/src/renderer/pages/ResidentPanel.tsx";
const F_CSS = "gui/src/renderer/index.css";
const F_AGENTS = "gui/src/renderer/pages/AgentsPanel.tsx";
const F_NEWPROJ = "gui/src/renderer/pages/NewProjectDialog.tsx";
const F_RIGHTSIDE = "gui/src/renderer/pages/RightSidebar.tsx";
const TARGETS = [F_POOL, F_RESIDENT, F_CSS, F_AGENTS, F_NEWPROJ, F_RIGHTSIDE];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1098");

/* ── 多行锚点：一律用**拼接字面量**书写（`check-mut-anchors.mjs` 的 constMap 才能解析） ──
   `.modal-card` 那条规则里的 `background: var(--modal-surface);` 在 index.css 里出现**多次**
   （悬浮坞用的是 `var(--float-surface)`，两处都长这样）⇒ 锚点必须带上选择器那一行才唯一。
   ⚠️ A-1100：`.modal-card` 的变量已从 `--float-surface` 换成 `--modal-surface`
   —— 本锚点若不跟着改，就会「未命中 ⇒ 静默失去保护」（`ref-engineering §8.3`）。 */
const MODAL_CARD_HEAD =
  ".modal-card {\n"
  + "  background: var(--modal-surface);";

/** 草稿池"追加到末尾"那一行（M1/M2 共用锚点、不同变异体） */
const POOL_APPEND = "return cur.includes(value) ? [...cur] : [...cur, value];";

const MUTATIONS = [
  /* ── ① 草稿池纯逻辑 ─────────────────────────────────────────────── */
  {
    name: "1 新勾的档位被插到**首位**（顺序＝优先级 ⇒ 顺手把兜底档换掉了）",
    file: F_POOL,
    mutate: (t) => sub(t, POOL_APPEND, "return cur.includes(value) ? [...cur] : [value, ...cur];"),
  },
  {
    name: "2 去重失效（同一档位被勾两次就进池两次，档位编号错乱）",
    file: F_POOL,
    mutate: (t) => sub(t, POOL_APPEND, "return [...cur, value];"),
  },
  {
    name: "3 `inherit` 拦截被删（「不覆盖」占位被当成一个模型档位写进池）",
    file: F_POOL,
    mutate: (t) => sub(t, '|| value === INHERIT_MODEL) { return [...cur]; }', ") { return [...cur]; }"),
  },
  {
    name: "4 自愈剔除被删（历史脏池里的 `inherit` 被原样搬运，脏值永远清不掉）",
    file: F_POOL,
    mutate: (t) => sub(
      t,
      '    ? pool.filter((v) => typeof v === "string" && v !== "" && v !== INHERIT_MODEL)',
      '    ? pool.filter((v) => typeof v === "string")',
    ),
  },

  /* ── ② 草稿态 / 已保存态分离（接线） ─────────────────────────────── */
  {
    name: "5 【事故本体】4s 轮询顺手把**草稿池**也覆盖掉（用户勾完几秒就被回滚）",
    file: F_RESIDENT,
    mutate: (t) => sub(
      t,
      "      if (Array.isArray(s.defaultModels)) { setDefaultModels(s.defaultModels); }",
      "      if (Array.isArray(s.defaultModels)) { setDefaultModels(s.defaultModels); setDraftModels(s.defaultModels); }",
    ),
  },
  {
    name: "6 弹层 checkbox 绑回**已保存池**（改回事故前的写法）",
    file: F_RESIDENT,
    mutate: (t) => sub(
      t,
      "onChange={(e) => setDraftModels((prev) => toggleModelInPool(prev, o.value, e.target.checked))}",
      "onChange={() => setDefaultModels(checked ? defaultModels.filter((v) => v !== o.value) : [...defaultModels, o.value])}",
    ),
  },
  {
    name: "7 保存提交的是已保存池而非草稿（用户勾了，但点保存后等于没勾）",
    file: F_RESIDENT,
    mutate: (t) => sub(
      t,
      "api.resident?.subagentSetModels?.(draftModels)",
      "api.resident?.subagentSetModels?.(defaultModels)",
    ),
  },
  {
    name: "8 打开弹层不播种草稿（弹层永远是空的，勾了也白勾）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, "setDraftModels(defaultModels); setModelModal(true);", "setModelModal(true);"),
  },
  {
    name: "9 `inherit` 字面量回流（唯一出处被绕过 ⇒ 改常量不再生效）",
    file: F_RESIDENT,
    mutate: (t) => sub(t, "o.value !== INHERIT_MODEL", 'o.value !== "inherit"'),
  },

  /* ── ③ 浮层实底 ─────────────────────────────────────────────────── */
  {
    name: "10 beta 主题 `--float-surface` 被改回半透明（浮层又开始透字）",
    file: F_CSS,
    mutate: (t) => sub(t, "  --float-surface: #1a243c;", "  --float-surface: rgba(30, 42, 70, 0.82);"),
  },
  {
    name: "11 `.modal-card` 的底被换成「抬高面」变量 `--bg-card`（beta 下就是半透明）",
    file: F_CSS,
    mutate: (t) => sub(t, MODAL_CARD_HEAD, ".modal-card {\n  background: var(--bg-card);"),
  },
  {
    name: "12 `.modal-card` 被追加第二条半透明底（第二个真相源 ⇒ 又透字）",
    file: F_CSS,
    mutate: (t) => sub(
      t,
      MODAL_CARD_HEAD,
      MODAL_CARD_HEAD + "\n  background: linear-gradient(180deg, rgba(38, 52, 92, 0.42), rgba(17, 24, 46, 0.5));",
    ),
  },
  {
    name: "13 某个全屏浮层的面板退回 `className=\"card\"`（渲染成半透明）",
    file: F_AGENTS,
    mutate: (t) => sub(
      t,
      '<div className="modal-card" style={{ width: 400, maxWidth: "90vw" }}>',
      '<div className="card" style={{ width: 400, maxWidth: "90vw" }}>',
    ),
  },
  {
    name: "14 浮层面板自带 `background`（盖过 `.modal-card` 的实底 —— NewProjectDialog 的原缺陷形态）",
    file: F_NEWPROJ,
    mutate: (t) => sub(
      t,
      '        animation: "fadeIn 0.18s ease",',
      '        animation: "fadeIn 0.18s ease",\n        background: "var(--bg-card)",',
    ),
  },
  {
    name: "15 `.modal-card` 被写成 `className=\"card modal-card\"`（beta 的 `.card` 特异性反把实底盖回半透明）",
    file: F_RESIDENT,
    mutate: (t) => sub(
      t,
      '<div className="modal-card" onClick={(e) => e.stopPropagation()}',
      '<div className="card modal-card" onClick={(e) => e.stopPropagation()}',
    ),
  },
  {
    name: "16 被排除的浮层（右栏新建弹窗）实底来源被换成半透明变量",
    file: F_RIGHTSIDE,
    mutate: (t) => sub(
      t,
      'background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 20',
      'background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 20',
    ),
  },
  {
    name: "17 beta 主题 `--bg` 被改半透明（右栏新建弹窗 / 悬浮窗直接拿它当实底）",
    file: F_CSS,
    mutate: (t) => sub(t, "  --bg: #05070e;", "  --bg: rgba(5, 7, 14, 0.6);"),
  },

  /* ── ④ A-1100：模态底与悬浮坞实底**分家**（防跨主题串色） ─────────── */
  {
    name: "18 【A-1100】beta 的 `--modal-surface` 被改回抬高面值（#1a243c ⇒ 模态窗观感串成 Alpha 配色）",
    file: F_CSS,
    mutate: (t) => sub(t, "  --modal-surface: #0a1020;", "  --modal-surface: #1a243c;"),
  },
  {
    name: "19 【A-1100】`.modal-card` 的底被换回 `--float-surface`（两个变量又被合并成一个）",
    file: F_CSS,
    mutate: (t) => sub(t, MODAL_CARD_HEAD, ".modal-card {\n  background: var(--float-surface);"),
  },
  {
    name: "20 【A-1100】beta 的 `--modal-surface` 被改半透明（模态窗又透出背后正文）",
    file: F_CSS,
    mutate: (t) => sub(t, "  --modal-surface: #0a1020;", "  --modal-surface: rgba(10, 16, 32, 0.6);"),
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
/* 中断即还原：`finally` 在 Ctrl+C（SIGINT 直接终止、不展开栈）下**不执行** ——
   没这道保险，变异会留在源码里，下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（本仓实测踩到过）。 */
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1098")) { process.exit(1); }
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
