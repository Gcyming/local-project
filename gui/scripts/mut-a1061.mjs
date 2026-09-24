/**
 * A-1061③ 变异测试：把「工具阶段命名」的每处关键实现逐个改坏，要求守卫变红。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1061.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 两件事同一批次：③ 阶段命名 与 ① 计划接续（中断后不接续的结构性修法） */
const SPECS = [
  "tests/core-ts/a1061-stages.spec.ts",
  "tests/core-ts/a1061-plan.spec.ts",
];

const LIVE = "gui/src/renderer/pages/liveStatus.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TODO = "core-ts/src/services/todoStore.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const TARGETS = [LIVE, PANEL, TODO, ENGINE];

const RAW_MUTATIONS = [
  {
    name: "1 adb_screencap 不再归「操作屏幕」（前缀顺序被压平 → 用户看到「正在执行命令」）",
    file: LIVE,
    from: '  if (n.startsWith("screen_") || n === "adb_screencap" || n === "adb_devices" || n === "adb_connect") { return "screen-control"; }',
    to: '  if (n.startsWith("screen_")) { return "screen-control"; }',
  },
  {
    name: "2 http_create_app 丢掉「生成脚本」阶段（退化成兜底「调用工具」）",
    file: LIVE,
    from: '  if (n === "http_create_app") { return "generate-script"; }\n',
    to: "",
  },
  {
    name: "3 某个阶段的标题被写成空串（状态行只剩「『工具名』」没有动作）",
    file: LIVE,
    from: '  "generate-script": "正在生成脚本",',
    to: '  "generate-script": "",',
  },
  {
    name: "4 两个阶段共用同一句标题（用户分不出在做什么）",
    file: LIVE,
    from: '  "run-command": "正在执行命令",',
    to: '  "run-command": "正在生成脚本",',
  },
  {
    name: "5 状态行不再用阶段标题（退回干巴巴的「正在调用」）",
    file: LIVE,
    from: '    const title = input.lastToolName ? toolStageTitle(input.lastToolName) : "正在调用";',
    to: '    const title = "正在调用";',
  },
  {
    name: "6 组件不再把原始工具名传进来（阶段化永远不生效）",
    file: PANEL,
    from: '    lastToolName: toolEvents.length > 0 ? toolEvents[toolEvents.length - 1]!.name : "",',
    to: '    lastToolName: "",',
  },
  // ── ① 计划接续（中断后不复述 = 不接续）────────────────────────────────────
  {
    name: "7 空表也复述（往上下文里塞一句没有内容的提醒）",
    file: TODO,
    from: "  if (items.length === 0) { return null; }",
    to: "  if (items.length === 0) { return \"\"; }",
  },
  {
    name: "8 全部已完成也复述（与自动清空打架，纯噪声）",
    file: TODO,
    from: "  if (done >= total && total > 0) { return null; }",
    to: "  if (false) { return null; }",
  },
  {
    name: "9 复述里丢掉「不要重做」（模型会重做已完成项）",
    file: TODO,
    from: '    "要求：接着上面未完成的项继续推进；已完成的**不要重做**；" +\n    "如果计划本身需要调整，调用 todo_write 更新它（不要只在正文里口头改）。",',
    to: '    "要求：继续。",',
  },
  {
    name: "10 复述另写一套格式（与右栏面板不同源，两处必然漂移）",
    file: TODO,
    /* 锚点带它所属的那段标题行（"接着未完成" vs 第二处的"计划收尾核对"），
       否则 `renderTodos(items),` 两处同名，`sub` 改哪一处不可知。 */
    from: '    "[当前任务计划 · 请接着未完成的项继续]",\n    renderTodos(items),',
    to: '    "[当前任务计划 · 请接着未完成的项继续]",\n    items.map((i) => i.content).join("\\n"),',
  },
  {
    name: "11 引擎退回 unshift 一条 system（复述沉进中段 + 产生非首位 system）",
    file: ENGINE,
    from: '    if (reminder) { out = foldUserReminder(out, reminder); }',
    to: '    if (reminder) { out.unshift({ role: "system", content: reminder }); }',
  },
  {
    name: "12 引擎不传会话号（读不到待办，复述永远为空）",
    file: ENGINE,
    from: "planReminderText(call.sessionId ? readTodos(call.sessionId) : [])",
    to: "planReminderText([])",
  },
];

const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1061")) { process.exit(1); }
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
