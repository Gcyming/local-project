/**
 * A-1061⑫ 变异测试：**计划收尾核对**（大任务做完要有人逼模型把清单收尾）。
 *
 * 用户实测原话：「每次一项大任务做完，都有一些任务列表的任务没有划掉，
 * 没有实时监测进度并返回结果」——右侧待办面板是用户盯进度的唯一地方，
 * 模型在长任务末尾常常直接给结论、忘了最后一次 todo_write，清单就停在半途。
 *
 * 修法是**循环层面**的硬核对（不是再喊一遍提示词）：本轮不再要工具、准备收尾时，
 * 若**本次运行自己写过的**计划还有未完成项 → 把本轮正文留成 assistant、注一条核对要求、
 * 续一轮要模型二选一（收尾回写 / 明确交代为何留到下一轮）。一次运行最多核对一次。
 *
 * 守卫住两处：
 *   · tests/core-ts/tools.spec.ts     —— 行为级（假 router 驱动真工具循环 + 真 todoStore 落盘）
 *   · tests/core-ts/todo-store.spec.ts —— 纯判据 + 源码接线
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061-reconcile.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPECS = ["tests/core-ts/tools.spec.ts", "tests/core-ts/todo-store.spec.ts"];

const LOOP = "core-ts/src/tool_loop.ts";
const STORE = "core-ts/src/services/todoStore.ts";
const TARGETS = [LOOP, STORE];

const RAW_MUTATIONS = [
  // ── 循环层：续轮与准入条件 ────────────────────────────────────────────────
  {
    name: "1 收尾核对整块被删（清单可以永远停在半途 = 用户遇到的原形）",
    file: LOOP,
    from: '        /* A-1061⑫：引导之后再做**计划收尾核对**（顺序刻意的 —— 用户刚插进来的请求\n           优先于"清单有没有划掉"；且引导本身可能又添了新待办，核对必须在它之后）。\n           准入条件 = 本轮运行真的碰过计划 且 还没核对过（见 usedTodoWrite 的注释）。 */\n        if (this.reconcilePlan(opts.sessionId, opts.messages, roundText, !reconciled && usedTodoWrite)) {\n          reconciled = true;\n          continue;\n        }\n',
    to: "",
  },
  {
    name: "2 核对面不留本轮正文（模型不知道自己刚宣布过「完成」就被追问）",
    file: LOOP,
    from: '    if (roundText) { messages.push({ role: "assistant", content: roundText }); } // ②',
    to: "    void roundText; // ②",
  },
  {
    name: "3 「只核对一次」失效（模型选择留到下一轮 → 被无限追问到轮次上限）",
    file: LOOP,
    /* ⚠️ 锚点必须带**调用点整句**：`sub` 用的是 `String.replace`，**只替换第一处**。
       裸的 `!reconciled && usedTodoWrite` 在文件里有两处调用点（run / runStream）——
       裸锚只会变异 run()，而行为测试跑的是 runStream → 变异**假绿**（实测踩到）。
       这里明确锚 roundText 那一处（流式路径）。 */
    from: "        if (this.reconcilePlan(opts.sessionId, opts.messages, roundText, !reconciled && usedTodoWrite)) {",
    to: "        if (this.reconcilePlan(opts.sessionId, opts.messages, roundText, usedTodoWrite)) {",
  },
  {
    name: "4 准入条件漏掉 usedTodoWrite（历史遗留计划会让之后每轮简单问答都被追问）",
    file: LOOP,
    from: "        if (this.reconcilePlan(opts.sessionId, opts.messages, roundText, !reconciled && usedTodoWrite)) {\n          reconciled = true;",
    to: "        if (this.reconcilePlan(opts.sessionId, opts.messages, roundText, !reconciled)) {\n          reconciled = true;",
  },
  {
    name: "5 准入条件的置位判据看错工具（碰过计划却不置位 → 核对永不触发）",
    file: LOOP,
    /* ⚠️ 闸门是**计数闸门**（`todo-store.spec` 断言 `pending.some((tc) => tc.name === "todo_write")`
       出现 **2** 次 —— 两条循环各一处）。忠实复现"永远不置位"必须**两处一起**改（只改一处
       的话另一条路径照旧置位，名字说的那个缺陷根本没发生）。⇒ `subAll` + 显式 `all: true`。 */
    all: true,
    from: 'pending.some((tc) => tc.name === "todo_write")',
    to: 'pending.some((tc) => tc.name === "__never__")',
  },
  {
    name: "6 非流式路径的收尾核对被删（run() 与 runStream 语义分叉）",
    file: LOOP,
    from: '        /* A-1061⑫：引导之后再做**计划收尾核对**（顺序刻意的 —— 用户刚插进来的请求\n           优先于"清单有没有划掉"；且引导本身可能又添了新待办，核对必须在它之后）。\n           准入条件 = 本轮运行真的碰过计划 且 还没核对过（见 usedTodoWrite 的注释）。 */\n        if (this.reconcilePlan(opts.sessionId, opts.messages, raw, !reconciled && usedTodoWrite)) {\n          reconciled = true;\n          continue;\n        }\n',
    to: "",
  },

  // ── 纯判据层：planReconcileFromTodos ─────────────────────────────────────
  {
    name: "7 已完成项也被算作未完成（会逼模型去「收尾」一个已经做完的项）",
    file: STORE,
    from: '  const open = items.filter((t) => t.status !== "completed");',
    to: "  const open = items.filter(() => true);",
  },
  {
    name: "8 收尾判据写反（有未完成项时反而返回 null = 静默放行）",
    file: STORE,
    from: "  if (open.length === 0) { return null; }",
    to: "  if (open.length > 0) { return null; }",
  },
  {
    name: "9 核对文案不给「留待下一轮」这条合法出口（模型会被逼着假完成）",
    file: STORE,
    from: '    "· 确实没做完 / 确实不打算做的 → 保持或调整状态，并用一句话说清为什么留到下一轮。",',
    to: '    "· 没做完的也必须标 completed，不许留到下一轮。",',
  },
];

/* `all: true` 的条目走**整组替换**（`subAll`）：计数闸门必须每处都改，见第 5 条的注释。
   其余照旧走行尾无关的 `sub`。 */
const MUTATIONS = RAW_MUTATIONS.map((m) => ({
  ...m,
  mutate: (t) => (m.all ? subAll(t, m.from, m.to) : sub(t, m.from, m.to)),
}));

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  for (const spec of SPECS) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (r.status !== 0) { return false; }
  }
  return true;
}

const originals = new Map();
for (const t of TARGETS) { originals.set(t, readFileSync(join(ROOT, t), "utf8")); }
const hashes = new Map([...originals.keys()].map((t) => [t, hash(join(ROOT, t))]));

if (!runSpec()) { console.error("基线未通过 —— 先修好测试再跑变异。"); process.exit(1); }
console.log("基线绿灯 ✓\n");

const probe = selfTestEolDetector(ROOT);
if (probe.length) {
  console.error("行尾检测器自检失败：");
  for (const b of probe) { console.error(`  - ${b}`); }
  process.exit(1);
}
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061-reconcile")) { process.exit(1); }
console.log("行尾检测器自检 + 锚点自检均通过\n");

let caught = 0;
const missed = [];
try {
  for (const m of MUTATIONS) {
    const path = join(ROOT, m.file);
    const src = originals.get(m.file);
    const next = m.mutate(src);
    if (next === src) {
      console.error(`⚠️  ${m.name}\n    锚点未命中（源码已漂移，需同步变异脚本）: ${m.from.slice(0, 60)}…`);
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
  for (const [t, src] of originals) { writeFileSync(join(ROOT, t), src); }
}

const dirty = [...hashes.entries()].filter(([t, h]) => hash(join(ROOT, t)) !== h);
if (dirty.length > 0) {
  console.error(`\n⚠️ 还原失败：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);
console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
