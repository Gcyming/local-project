/**
 * A-1060 变异测试：把「中途引导」的每一处关键实现逐个改坏，要求守卫变红。
 *
 * 红不出来 = 守卫锁错了对象（本项目前科：A-1019 隐形地板、A-1034 假防线、A-1054 浅锁、
 * A-1059 锚点打偏到注释）。故变异是**验收标准**，不是可选步骤。
 *
 * ⚠️ 本文件里**不许**在中文句子中夹 ASCII 双引号（A-1056 自伤；中文引号一律「」）。
 *
 * 用法：node gui/scripts/mut-a1060.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/* `sub` = 行尾无关的替换（共享模块，不要在本脚本另写一份）—— 见 `_mut-eol.mjs`。 */
import { sub, eolProblems, reportEolProblems, selfTestEolDetector } from "./_mut-eol.mjs";

// ⚠️ 不能用 `new URL(...).pathname`：项目根含空格，pathname 会把空格编码成 %20 → ENOENT。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = "tests/core-ts/a1060-steer.spec.ts";

const BUS = "core-ts/src/services/steerBus.ts";
const LOOP = "core-ts/src/tool_loop.ts";
const ENGINE = "core-ts/src/services/engine.ts";
const MAIN = "gui/src/main/index.ts";
const PRELOAD = "gui/src/preload/index.ts";
const QUEUE = "gui/src/renderer/pages/instructionQueue.ts";
const PANEL = "gui/src/renderer/pages/ChatPanel.tsx";

const TARGETS = [BUS, LOOP, ENGINE, MAIN, PRELOAD, QUEUE, PANEL];

const RAW_MUTATIONS = [
  // ── steerBus：行为层 ───────────────────────────────────────────────────────
  {
    name: "1 取走不清空 —— 每轮重复注入同一句引导",
    file: BUS,
    from: "  buffers.delete(sid);\n  return list;",
    to: "  return list;",
  },
  {
    name: "2 超限丢最新的（用户刚说的那句被丢掉）",
    file: BUS,
    from: "  while (list.length > STEER_MAX_PENDING) { list.shift(); }",
    to: "  while (list.length > STEER_MAX_PENDING) { list.pop(); }",
  },
  {
    name: "3 空文本也入队（给上下文塞一条没有要求的 user 消息）",
    file: BUS,
    from: "  if (!sid || !text) { return 0; }",
    to: "  if (!sid) { return 0; }",
  },
  {
    name: "4 超长不截断（一句话就能把上下文吃光）",
    file: BUS,
    from: "  list.push({ id: String(item.id ?? \"\"), text: text.slice(0, STEER_TEXT_MAX) });",
    to: "  list.push({ id: String(item.id ?? \"\"), text });",
  },
  {
    name: "5 取走时忽略 sessionId（引导会串到别的会话）",
    file: BUS,
    from: "  const list = buffers.get(sid);\n  if (!list || list.length === 0) { return []; }",
    to: "  const list = [...buffers.values()][0];\n  if (!list || list.length === 0) { return []; }",
  },
  {
    name: "6 投入时反序（用户说的顺序被打乱）",
    file: BUS,
    from: "  list.push({ id: String(item.id ?? \"\"), text: text.slice(0, STEER_TEXT_MAX) });",
    to: "  list.unshift({ id: String(item.id ?? \"\"), text: text.slice(0, STEER_TEXT_MAX) });",
  },

  // ── 工具循环：消费点 ──────────────────────────────────────────────────────
  {
    name: "7 流式路径不再消费引导（引导永远不会生效）",
    file: LOOP,
    from: "      this.injectSteers(opts.sessionId, opts.messages, opts.onEvent);\n",
    to: "",
  },
  {
    name: "8 非流式路径不再消费引导",
    file: LOOP,
    from: "      this.injectSteers(opts.sessionId, opts.messages);\n",
    to: "",
  },
  {
    name: "9 注入成 assistant 消息（模型把用户的引导当成自己说过的话）",
    file: LOOP,
    // A-1061⑩ 迁移：注入的是「编排指令 + 原文」的多行 user 消息，锚点取 role 那一行。
    from: '      messages.push({\n        role: "user",',
    to: '      messages.push({\n        role: "assistant",',
  },

  // ── 引擎：事件映射 ────────────────────────────────────────────────────────
  {
    name: "10 steer 事件不再显式成一支（落进 tool 兜底 = 界面多一张空工具卡）",
    file: ENGINE,
    from: '            } else if (ev.type === "steer") {',
    to: "            } else if (false) {",
  },

  // ── 主进程：白名单 / 清理 / IPC ───────────────────────────────────────────
  {
    name: "11 白名单漏掉 steerId（界面不知道引导已生效 → 会再发一遍）",
    file: MAIN,
    from: '      steerId: typeof d.steerId === "string" ? d.steerId : undefined,\n',
    to: "",
  },
  {
    name: "12 流结束不清缓冲（残留会在下一轮被重复注入）",
    file: MAIN,
    from: "        clearSteers(cancelKey);\n",
    to: "        void 0;\n",
  },
  {
    name: "13 IPC 把会话号传丢（引导永远投不进任何会话）",
    file: MAIN,
    from: 'const pending = pushSteer(sid, { id: String(payload?.id ?? ""), text: String(payload?.text ?? "") });',
    to: 'const pending = pushSteer("", { id: String(payload?.id ?? ""), text: String(payload?.text ?? "") });',
  },
  {
    name: "14 preload 通道名写错（渲染层调用落到空气里）",
    file: PRELOAD,
    from: 'ipcRenderer.invoke("slime:chat:steer", { sessionId, id: String(id), text })',
    to: 'ipcRenderer.invoke("slime:chat:steerX", { sessionId, id: String(id), text })',
  },

  // ── 界面 ─────────────────────────────────────────────────────────────────
  {
    name: "15 「插入」动作退回掐流（用户说的「还是会直接中断」复辟）",
    file: PANEL,
    // A-1062 迁移：投递点从 `.catch(() => undefined)` 改成 try/catch（失败需退回 queue 态）。
    from: "      await api.chat?.steer?.(item.sessionId, item.id, item.text);",
    to: "      await api.chat?.cancel(item.sessionId);",
  },
  {
    name: "16 卡片不标 steer 态（观感上与排队等下一轮分不开）",
    file: PANEL,
    // ⚠️ 锚点要带**邻位上下文**：`setMode(..., "steer")` 现在有**三处**
    //    （send() 的压缩结束补投 / insertQueueItemNow / 卡片对象字面量）。
    //    A-1061⑩ 之后目标那句与 `api.chat?.steer?.(...)` **之间**插进了一段注释
    //    （"用卡片自己的会话号…"），原来的两行相邻锚点已失配 → 改用**紧邻的上一行注释**做邻位。
    from: '    // 标 steer：卡片状态立刻可见（不是 promote —— 它不需要"排到队首"，它进的是当前这轮）\n    syncQueue(setMode(interruptQueueRef.current, id, "steer"));',
    to: '    // 标 steer：卡片状态立刻可见（不是 promote —— 它不需要"排到队首"，它进的是当前这轮）\n    syncQueue(setMode(interruptQueueRef.current, id, "queue"));',
  },
  {
    name: "17 steer 事件到达时不撤卡片（会在 onDone 后再发一遍 = 重复发送）",
    file: PANEL,
    from: "          syncQueue(removeAt(interruptQueueRef.current, steerId));\n",
    to: "          void 0;\n",
  },
  {
    name: "18 引导被折成正文用户气泡（用户明确：引导不该出现在正文记录里）",
    file: PANEL,
    /* A-1064 迁移：锚点从旧的「think + 引导：前缀」改成 **steer 独立节点**。
       这条变异同时弄红两条判据：节点形态丢了 + 折进正文（旧写法会混进正文记录）。 */
    from: "          timelineStepsRef.current = appendTimelineStep(\n            timelineStepsRef.current,\n            { kind: \"steer\", text: steerText },\n          );\n          setLiveTimeline(timelineStepsRef.current);",
    to: "          setMessages((prev) => [...prev, makeMessage(\"user\", steerText)]);",
  },
  {
    name: "18b 引导退回折成 think 节点（会被合并进相邻思考段 → 用户又「看不到引导卡片」）",
    file: PANEL,
    from: "{ kind: \"steer\", text: steerText },",
    to: "{ kind: \"think\", text: steerText },",
  },
  {
    name: "18c 引导卡片上的可见标签丢了（数据还在，用户却看不见「引导」两个字）",
    file: PANEL,
    from: '<span className="steer-card-title">引导</span>',
    to: '<span className="steer-card-title" />',
  },
  {
    name: "19 纯逻辑三态退化成两态",
    file: QUEUE,
    from: 'export type InsertMode = "interrupt" | "queue" | "steer";',
    to: 'export type InsertMode = "interrupt" | "queue";',
  },
  // ── A-1061⑤：同一会话绝不并行开第二条流 ────────────────────────────────────
  {
    name: "20 内部续发也被自己的拦截挡住（done 之后的排队消息发不出去 = 发了没反应）",
    file: QUEUE,
    from: "  if (i.forceNewTurn) { return false; }",
    to: "  if (false) { return false; }",
  },
  {
    name: "21 不管有没有流在跑都让位（用户按回车发不出消息）",
    file: QUEUE,
    from: "  if (!i.streamActive) { return false; }",
    to: "  if (false) { return false; }",
  },
  {
    name: "22 不区分会话（在会话 B 发消息会被会话 A 的流拦住）",
    file: QUEUE,
    from: "  if (!i.streamSession || i.streamSession !== i.targetSession) { return false; }",
    to: "  if (false) { return false; }",
  },
  {
    name: "23 活动窗口变成永远有效（粘性 ref 残留会永久吞掉用户的话）",
    file: QUEUE,
    from: "  return i.now - i.lastActivityAt < STREAM_ALIVE_MS;",
    to: "  return true;",
  },
  {
    name: "24 入口判据改用 loading（loading 被提前收掉时就拦不住 = 本次被打断的原形）",
    file: PANEL,
    /* 锚点带 `const deferToSteer = shouldDeferToSteer({` 头 = **唯一**定位到 send() 入口那处
       （另一处是 5090 的 `const streamAliveHere = …`，变量名不同）。替换位置与原第一处相同。 */
    from: "    const deferToSteer = shouldDeferToSteer({\n      forceNewTurn: opts?.forceNewTurn,\n      streamActive: streamActiveRef.current,",
    to: "    const deferToSteer = shouldDeferToSteer({\n      forceNewTurn: opts?.forceNewTurn,\n      streamActive: loading,",
  },
  {
    name: "25 开流那一刻不再记活动（首包到达前会被判成「流没在动」）",
    file: PANEL,
    from: "    // A-1061⑤：开流即记一次活动 —— 否则\"刚发出、首个 chunk 还没到\"的那段里，\n    // 活动时间戳还是上一次运行的旧值，可能被判成\"流没在动\"而放行第二条流。\n    streamActivityAtRef.current = Date.now();\n",
    to: "",
  },
  {
    name: "26 卡片 id 与投给主进程的 id 不是同一个（撤卡片配不上 → 该条被再发一遍）",
    file: PANEL,
    // A-1062 迁移：卡片 id 一致性现在由「投递点直接用 item.id、不生成新 id」保证 ——
    // 判据搬到了 insertQueueItemNow（见 tests/core-ts/a1060-steer.spec.ts 的迁移注释）。
    from: "      await api.chat?.steer?.(item.sessionId, item.id, item.text);",
    to: "      await api.chat?.steer?.(item.sessionId, nextQueueId(), item.text);",
  },
  {
    name: "27 内部续发不再声明 forceNewTurn（续发会被入口判据拦住）",
    file: PANEL,
    /* 锚点带下一行 `        return;` = **唯一**定位到 3763（A-162/A-1054⑥ 的"插入指令续发"路径，
       其收尾就是 `return`）。另一处 5106 后面跟的是 `      }`，分得开。
       刻意**不**依赖那两行注释（文案会漂移）：用代码行做上下文。 */
    from: "forceNewTurn: true });\n        return;",
    to: "});\n        return;",
  },
  {
    name: "28 「引导」投递退回当前视图会话（跨会话翻卡片时投错运行）",
    file: PANEL,
    from: "      await api.chat?.steer?.(item.sessionId, item.id, item.text);",
    to: "      await api.chat?.steer?.(sessionId, item.id, item.text);",
  },
];

/* `mutate` 由 from/to 机械派生 —— 自检与执行共用同一套行为判据。 */
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
if (reportEolProblems(eolProblems(MUTATIONS, ROOT), "mut-a1060")) { process.exit(1); }
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
  console.error(`\n⚠️ 还原失败，以下文件已改动：${dirty.map(([t]) => t).join(", ")}`);
  process.exit(1);
}
console.log(`\n还原校验通过（${TARGETS.length} 个文件哈希一致）`);

console.log(`\n变异捕获 ${caught}/${MUTATIONS.length}`);
if (missed.length > 0) {
  console.error(`未被捕获：\n  - ${missed.join("\n  - ")}`);
  process.exit(1);
}
