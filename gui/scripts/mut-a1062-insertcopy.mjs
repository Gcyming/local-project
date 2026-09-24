/**
 * A-1062 变异测试：把「中途插入」的**文案与两条路**逐个改坏，要求守卫变红。
 *
 * ⚠️ 中文句子里不许夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 * 用法：node gui/scripts/mut-a1062-insertcopy.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/gui/insert-copy.spec.ts";

const COPY = "gui/src/renderer/pages/insertCopy.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";
const TARGETS = [COPY, PANEL];

const RAW_MUTATIONS = [
  // ── 文案（"说反话"那一类）────────────────────────────────────────────────
  {
    name: "1 placeholder 退回「新消息」口径（流活跃时回车根本不是发新消息）",
    file: COPY,
    from: '  return "输入要补充的话（回车加入待发，本轮结束后发出；要立刻插进正在跑的这轮，点待发卡片上的「现在插入」）";',
    to: '  return "输入消息（Enter 发送，/ 展开指令，Shift+Enter 换行；可粘贴 / 拖拽图片识图）";',
  },
  {
    name: "2 卡片「引导」title 丢掉生效时机（用户又读成「点了没反应」）",
    file: COPY,
    from: "在下一个工具调用之后的轮次边界生效",
    to: "马上生效",
  },
  {
    name: "3 发送按钮 title 声称回车即注入（它并不直接发送）",
    file: COPY,
    from: '  return "加入待发：本条排在本轮之后发出。要立刻插进正在跑的这轮，点待发卡片上的「现在插入」";',
    to: '  return "输入消息，回车即立刻注入当前这一轮";',
  },
  // ── 闸门 ────────────────────────────────────────────────────────────────
  {
    name: "4 纯空格也能提交（往队列塞一张既无文字又无图的幽灵卡片）",
    file: COPY,
    from: "  return text.trim().length > 0;",
    to: "  return true;",
  },
  {
    name: "5 压缩窗口把 done 也算进去（压缩已结束却还在拦，引导永远投不出去）",
    file: COPY,
    /* ⚠️ 锚点必须跟住**当前**实现：A-1082 把 `skip` / `overflow` 也纳入了压缩窗口
       （通知期间投出的引导没人消费），本条锚点当时是 3 个 stage 的旧形态，于是变成
       "未命中"—— 那条守卫从 A-1082 起就**没有任何变异覆盖**了。 */
    from: '  return stage === "prep" || stage === "summarize" || stage === "trunc" || stage === "skip" || stage === "overflow";',
    to: '  return stage === "prep" || stage === "summarize" || stage === "trunc" || stage === "skip" || stage === "overflow" || stage === "done";',
  },
  // ── 两条路各自一个动作 ──────────────────────────────────────────────────
  {
    name: "6 回车（send）顺手投递（「排队」这条语义再无出口）",
    file: PANEL,
    from: "      syncQueue(enqueue(interruptQueueRef.current, {\n        id: nextQueueId(),\n        text: queuedText,",
    to: "      void (window as unknown as { slimeAPI?: any }).slimeAPI?.chat?.steer?.(sessionId, 0, queuedText);\n      syncQueue(enqueue(interruptQueueRef.current, {\n        id: nextQueueId(),\n        text: queuedText,",
  },
  {
    name: "7 doSend 的 deferToSteer 兜底也顺手投递（同一缺陷的第二产地）",
    file: PANEL,
    from: '      const replayText = (text ?? "").trim();',
    to: '      const replayText = (text ?? "").trim();\n      void (window as unknown as { slimeAPI?: any }).slimeAPI?.chat?.steer?.(sendSid, 0, replayText);',
  },
  {
    name: "8 压缩窗口不再拦「现在插入」（投了没人消费 = 空头支票）",
    file: PANEL,
    from: "    if (isCompressWindow(compressUi?.stage)) {",
    to: "    if (false) {",
  },
  {
    name: "9 投递失败不退回 queue（卡片永远停在「已引导」，模型收不到）",
    file: PANEL,
    from: '      syncQueue(setMode(interruptQueueRef.current, id, "queue"));',
    to: '      syncQueue(setMode(interruptQueueRef.current, id, "steer"));',
  },
  // ── A-1062 的方向选择器不许复活 ─────────────────────────────────────────
  {
    name: "10 复活方向状态 steerIntent",
    file: PANEL,
    from: "  const preSteerIdsRef = React.useRef<number[]>([]);",
    to: '  const preSteerIdsRef = React.useRef<number[]>([]);\n  const [steerIntent, setSteerIntent] = React.useState("queue");',
  },
  {
    name: "11 复活方向选项表 STEER_INTENT_OPTIONS（重新 import）",
    file: PANEL,
    from: 'import { canSubmitSteer, insertNowTitle, isCompressWindow, steerPlaceholder, steerSubmitTitle } from "./insertCopy.js";',
    to: 'import { STEER_INTENT_OPTIONS } from "./steerIntent.js";\nimport { canSubmitSteer, insertNowTitle, isCompressWindow, steerPlaceholder, steerSubmitTitle } from "./insertCopy.js";',
  },
  {
    name: "12 复活 ◉引导 / ○排队 方向行",
    file: PANEL,
    from: "                    title={steerSubmitTitle()}",
    to: '                    data-steer-direction={`◉ 引导 / ○ 排队`}\n                    title={steerSubmitTitle()}',
  },
];

const MUTATIONS = RAW_MUTATIONS.map((m) => ({ ...m, mutate: (t) => sub(t, m.from, m.to) }));

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runSpec() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", SPEC, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return r.status === 0;
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1062-insertcopy")) { process.exit(1); }
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
