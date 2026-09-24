/**
 * gui/scripts/mut-a1087-display.mjs — A-1087 变异测试（上下文 K 的显示/换算口径收口）。
 *
 * ## 本轮修的三件事（各自都有"下一个人顺手写回去、而且全都不报错"的退化形态）
 *
 * 起因（用户实测原话）：「没有 524K 容量的上下文，只有 512K」+「右边的上下文监测也出问题了」。
 * 真根因不是某一个数字写错，而是**"上下文用 K 表示"这件事有三个产地、两套进制**：
 *
 *  | 产地 | 旧行为 | 后果 |
 *  |---|---|---|
 *  | `RightSidebar.fmtK` | `n / 1000` 全局十进制 | `524288` 印成「524K」（厂商写 512K） |
 *  | `ChatPanel` 底部芯片 | `Σ客户端字符 ÷ 4` | CJK 4 倍低估、且统计了没发出去的消息 ⇒ 底部 43K vs 右栏 64K |
 *  | `ProvidersPanel` 的「K」栏 | `Math.round(n/1000)` ↔ `v*1000` | 显示 524；存值 65536 被静默改写成 66000 |
 *
 * 修法：进制**按上限整除性反推**（`pickTokenBase`），格式化与「N K」输入框各只有一个产地。
 *
 * ## 覆盖的十二条
 *
 *   1~3  进制判据本身：恒十进制（旧病）/ 恒二进制（镜像病）/ 平局规则反转
 *   4~5  显示端与写回端各自忽略上限：K 栏显示 524 / 写回 512000（往返不再无损）
 *   6~7  右栏丢掉 liveCap / 明细栏不传 cap —— 同屏两口径
 *   8    底部芯片复活 ÷4 估算（第二个产地 = 用户看到的"两个数"）
 *   9    `useAgentMaxContext` 把字面量 `api` 当供应商 key（provider 规格分支回到死代码）
 *   10~11 供应商编辑器 / 新建会话选模型处退回旧写法
 *   12   表头写回固定 ×1024 的例子（文案与实际换算式脱钩）
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（一律「」）——否则会把整份 spec 打成 0 用例。
 * ⚠️ 快照 / 还原一律走**字节**（Buffer），不做文本往返；还原后比哈希。
 *
 * ## 用法
 *
 *   node gui/scripts/mut-a1087-display.mjs             # 全量（需要能派生子进程）
 *   node gui/scripts/mut-a1087-display.mjs --list      # 列出条目
 *   node gui/scripts/mut-a1087-display.mjs --apply 3   # 只改第 3 条并**留着**（给跑不了子进程的环境）
 *   node gui/scripts/mut-a1087-display.mjs --restore   # 按 manifest 逐字节还原
 *
 * ### 跑不了子进程时怎么证明 RED（本环境实测 `EBUSY`，见下）
 *
 * WorkBuddy 的沙箱禁止 **node→node 孙进程**（`spawnSync(process.execPath, …)` 直接 `EBUSY`，
 * 与 `NODE_OPTIONS` 无关），于是 `runSpecs()` 起不来。此时改用 `--apply` / `--restore`
 * 两半 + **shell 循环**（vitest 由 shell 直接启动，不经过 node 派生）：
 *
 *   ```bash
 *   for n in $(seq 1 12); do
 *     node gui/scripts/mut-a1087-display.mjs --apply "$n"
 *     node node_modules/vitest/vitest.mjs run tests/gui/context-math.spec.ts            >/dev/null 2>&1; a=$?
 *     node node_modules/vitest/vitest.mjs run tests/core-ts/a1054-guards.spec.ts        >/dev/null 2>&1; b=$?
 *     node node_modules/vitest/vitest.mjs run tests/core-ts/model-capabilities.spec.ts  >/dev/null 2>&1; c=$?
 *     node gui/scripts/mut-a1087-display.mjs --restore
 *     if [ "$a$b$c" = "000" ]; then echo "❌ M$n 未被捕获"; else echo "✅ M$n 被捕获"; fi
 *   done
 *   ```
 *
 *   ⚠️ 这三份 spec 必须**分开跑**：本环境实测把多份 spec 传给同一次 vitest 时，
 *   第二份起有概率因沙箱写临时目录 `EPERM` 而**未被收集**（输出里仍显示 1 个文件通过），
 *   于是"全绿"可能只是"只跑了一份"。分开跑并逐个判 exit code 才不会假绿。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector, installRestoreOnSignal } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** @type {string[]} 本轮守卫分散在三份 spec（任一变红即算捕获） */
const SPECS = [
  "tests/gui/context-math.spec.ts",
  "tests/core-ts/a1054-guards.spec.ts",
  "tests/core-ts/model-capabilities.spec.ts",
];
const CM = "gui/src/renderer/pages/contextMath.ts";
const SIDEBAR = "gui/src/renderer/pages/RightSidebar.tsx";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const PROVIDERS = "gui/src/renderer/pages/ProvidersPanel.tsx";
const NEWPROJ = "gui/src/renderer/pages/NewProjectDialog.tsx";
const TARGETS = [CM, SIDEBAR, PANEL, PROVIDERS, NEWPROJ];
/** `--apply` 模式下存放逐字节备份与 manifest 的临时目录（`--restore` 后整目录删除） */
const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1087");

const MUTATIONS = [
  /* ── ①②③ 进制判据本体 ──────────────────────────────────────────── */
  {
    name: "1 `pickTokenBase` 恒返回十进制（回到旧的全站 ÷1000 ⇒ 524288 重新印成 524K）",
    file: CM,
    mutate: (t) => sub(t, "  return off(1024) < off(1000) ? 1024 : 1000;", "  return 1000;"),
  },
  {
    name: "2 镜像病：`pickTokenBase` 恒返回二进制（gpt-4o 的 128K 被印成 125K）",
    file: CM,
    mutate: (t) => sub(t, "  return off(1024) < off(1000) ? 1024 : 1000;", "  return 1024;"),
  },
  {
    name: "3 平局规则反转（`<` → `<=`）：128000 被二进制吃掉 ⇒ 128K 变 125K",
    file: CM,
    mutate: (t) => sub(t, "  return off(1024) < off(1000) ? 1024 : 1000;", "  return off(1024) <= off(1000) ? 1024 : 1000;"),
  },

  /* ── ④⑤ K 输入框的两端各自忽略进制 ─────────────────────────────── */
  {
    name: "4 显示端忽略上限、恒 ÷1000（供应商编辑器把 524288 显示成 524）",
    file: CM,
    /* ⚠️ 锚点用**双引号**字面量（内层 `""` 写成 `\"\"`）：静态核验器
       `check-mut-anchors.mjs` 只认双引号字面量，写单引号会被报成「未核验」——
       那就等于这条锚点的"命中且唯一"没人查（本仓已吃过"锚点静默未命中"的亏）。 */
    mutate: (t) => sub(
      t,
      "  return n == null ? \"\" : String(Math.round(n / pickTokenBase(n)));",
      "  return n == null ? \"\" : String(Math.round(n / 1000));",
    ),
  },
  {
    name: "5 写回端忽略进制、恒 ×1000（往返不再无损：512Ki 被存成 512000）",
    file: CM,
    mutate: (t) => sub(t, "  return n == null ? undefined : n * base;", "  return n == null ? undefined : n * 1000;"),
  },

  /* ── ⑥⑦⑧ 同屏两口径：三个产地 ─────────────────────────────────── */
  {
    name: "6 RightSidebar 丢掉 liveCap（改用 maxCtx）⇒ 监测上限与流式权威值脱钩",
    file: SIDEBAR,
    mutate: (t) => sub(t, "  const capNow = liveCap > 0 ? liveCap : maxCtx;", "  const capNow = maxCtx;"),
  },
  {
    name: "7 UsageBreakdown 不再传 cap（明细栏自己一个进制 ⇒ 同屏两口径）",
    file: SIDEBAR,
    mutate: (t) => sub(
      t,
      "<UsageBreakdown usage={usage} live={liveTurn} detailOpen={detailOpen} cap={capNow} onToggleDetail=",
      "<UsageBreakdown usage={usage} live={liveTurn} detailOpen={detailOpen} onToggleDetail=",
    ),
  },
  {
    name: "8 ChatPanel 底部芯片复活 ÷4 估算（第二个产地：底部 43K vs 右栏 64K）",
    file: PANEL,
    mutate: (t) => sub(
      t,
      "{fmtTokens(ctxUsed, ctxCap)}",
      "{fmtTokens(Math.round(messagesRef.current.reduce((s, m) => s + (m.content?.length ?? 0), 0) / 4), ctxCap)}",
    ),
  },
  {
    name: "9 useAgentMaxContext 退回把字面量 `api` 当供应商 key（provider 规格分支回到死代码）",
    file: SIDEBAR,
    mutate: (t) => sub(
      t,
      "            const key = isApiForm && parts.length >= 3 ? parts[1] : null;",
      "            const key = parts[0];",
    ),
  },

  /* ── ⑩⑪⑫ 另外两个产地与"文案脱钩" ───────────────────────────────── */
  {
    name: "10 ProvidersPanel 的上下文K 退回 ×1000 手算（显示 524、写回 524000）",
    file: PROVIDERS,
    mutate: (t) => sub(
      t,
      "value={tokensToKInput(m.context_window)}",
      'value={m.context_window ? String(Math.round(m.context_window / 1000)) : ""}',
    ),
  },
  {
    name: "11 NewProjectDialog 退回打印裸 token 数（`524288 ctx` 读起来就是 524K）",
    file: NEWPROJ,
    mutate: (t) => sub(t, "{fmtTokens(m.ctx, m.ctx)} ctx", "{m.ctx} ctx"),
  },
  {
    name: "12 表头写回固定 ×1024 的例子（文案与实际换算式脱钩）",
    file: PROVIDERS,
    mutate: (t) => sub(
      t,
      "title=\"上下文窗口，单位 K token。换算的进制按**该行存量值**自适应（能写成整数 K 的进制优先）—— 见每行输入框的悬停提示。\"",
      "title=\"上下文窗口，单位 K token（输入 1024 = 1048576 token）\"",
    ),
  },
];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const abs = (rel) => join(ROOT, rel);

/** 任一份 spec 变红即算捕获 —— **逐份跑**（同一次跑多份会有"没被收集却仍报绿"的假绿，见文件头）。 */
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
/* 中断即还原：`finally` 在 Ctrl+C 下不展开 —— 没这道保险，变异会留在源码里，
   下一次跑就把「变异后的源码」当基线 ⇒ 整批静默假绿（2026-09-23 实测踩到）。 */
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1087")) { process.exit(1); }

/** 引号自伤自检：剥注释后仍出现「CJK + ASCII 双引号 + CJK」才算坏。 */
function quoteSelfHarm(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return code.split("\n").filter((l) => /[\u4e00-\u9fff]"[\u4e00-\u9fff]/.test(l)).map((l) => l.trim().slice(0, 100));
}
for (const rel of ["gui/scripts/mut-a1087-display.mjs"]) {
  const bad = quoteSelfHarm(readFileSync(abs(rel), "utf8"));
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
